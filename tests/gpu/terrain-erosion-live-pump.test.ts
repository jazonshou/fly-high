import { describe, expect, it } from "vitest";
import { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { admit, buildHarness, nextFrame, withScene } from "./terrainPageErosionGpuHarness";

/**
 * Gate F's regression: the erosion DAG driven through the ADMISSION METER, the
 * way the renderer drives it.
 *
 * Every other GPU test in this suite pumps the producer unconditionally, once
 * per frame, for as many frames as it takes. **The renderer does not.** It asks
 * `demand()` what the current stage wants, submits that to the `ComputeBudget`,
 * reads back an admitted count, and pumps only that — returning early when the
 * admission is zero. `demand()` is therefore invisible to every other test in
 * the project, and it is where Gate F's defect lived.
 *
 * W-4 added a `fine-band` stage to the DAG and wired it into the stage union,
 * `advance`, the shaders, the measured cost table and the cost trackers — but
 * not into `demand`'s switch, whose `default` answered ZERO. The DAG advanced
 * into `fine-band` and stopped asking for work; the clipmap submitted nothing;
 * `admitted` returned zero for a client that never submitted; the page was
 * never pumped again. No eroded page ever became resident, the whole world
 * rendered flat, and nothing threw, warned or logged. Byte-determinism, seam
 * audits, CPU-oracle parity, statistics and timing were all green throughout,
 * because all of them drive a pump loop the application never uses.
 *
 * The lesson this file encodes: **a test that drives a subsystem differently
 * from production is not testing production.** The harness's unconditional
 * pump is convenient and correct for asserting erosion MATHS; it cannot see a
 * scheduling contract. This test exists to hold that contract.
 */
describe("erosion DAG under the live admission meter (Gate F)", () => {
  it("converges a page when pumped only by what the ComputeBudget admits", async () => {
    await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const address = createWorldPageAddress(3, -3, 5);
        const slot = admit(harness, address);
        const token = slot.token;
        expect(token, "the fixture atlas refused a token").toBeTruthy();

        const profile = resolveWebGpuQualityProfile("medium", "balanced");
        const budget = new ComputeBudget(profile);

        let settled = false;
        let failure: unknown = null;
        void harness.producer.beginPage(slot, token!)
          .then(() => { settled = true; })
          .catch((error: unknown) => { failure = error; });

        // Generous, but far below the 2,000 frames the broken build burned
        // without converging. A page settles in ~31 frames when the meter is
        // answered honestly at every stage.
        const frameLimit = 600;
        let frames = 0;
        let framesPumped = 0;
        const stageFrames = new Map<string, number>();
        while (!settled && failure === null && frames < frameLimit) {
          frames += 1;
          budget.beginFrame();
          // The renderer's exact shape. `pendingPageCount` is zero because the
          // only page has already been taken — which is precisely the state
          // the broken build could not escape: with nothing pending, the DAG's
          // own demand is the ONLY thing that can keep it alive.
          const demand = harness.producer.demand(0);
          if (demand.count > 0) {
            budget.submit("erosionCompute", demand.count, demand.costMs);
          }
          const admitted = budget.admitted("erosionCompute");
          const stage = String(harness.producer.activeStage);
          stageFrames.set(stage, (stageFrames.get(stage) ?? 0) + 1);
          if (admitted > 0) {
            framesPumped += 1;
            await harness.producer.pump(admitted);
            harness.producer.consumeMeasuredDispatchCostMs();
          }
          await nextFrame();
        }

        const spent = [...stageFrames.entries()]
          .map(([stage, count]) => `${stage}=${count}`)
          .join(" ");
        expect(failure, `the DAG failed under the admission meter: ${String(failure)}`)
          .toBeNull();
        expect(
          settled,
          `the page never converged in ${frames} frames under the live admission `
          + `meter (pumped on ${framesPumped} of them). Frames per stage: ${spent}. `
          + "A stage that reports zero demand is never admitted and never pumped, "
          + "so the DAG stops there forever — check demand()'s switch covers "
          + "every stage advance() can reach.",
        ).toBe(true);

        // Non-vacuity: the assertion above must not be able to pass because the
        // page finished without ever consulting the meter.
        expect(framesPumped).toBeGreaterThan(0);
        expect(frames).toBeGreaterThan(1);
      } finally {
        harness.dispose();
      }
    });
  }, 300_000);

  /**
   * The class fix, asserted structurally: which stages are capable of answering
   * the meter with zero work?
   *
   * This drives the DAG to completion with a FORCED pump so it always makes
   * progress, and records every stage that reported zero demand along the way.
   * Only the asynchronous and terminal stages may appear — a *dispatch* stage
   * that asks for nothing is the Gate F deadlock, because the renderer would
   * never have pumped it at all.
   *
   * The observed set is compared against the permitted one rather than walked
   * from a hand-written list of stage names, so a stage added to the DAG cannot
   * quietly escape the check the way `fine-band` escaped `demand`'s switch.
   */
  it("lets only async and terminal stages report zero demand", async () => {
    await withScene(async (engine, scene) => {
      const harness = buildHarness(engine, scene);
      try {
        const address = createWorldPageAddress(3, -3, 5);
        const slot = admit(harness, address);
        const token = slot.token;
        expect(token).toBeTruthy();

        let settled = false;
        let failure: unknown = null;
        void harness.producer.beginPage(slot, token!)
          .then(() => { settled = true; })
          .catch((error: unknown) => { failure = error; });

        const zeroDemandStages = new Set<string>();
        const seenStages = new Set<string>();
        let frames = 0;
        while (!settled && failure === null && frames < 600) {
          frames += 1;
          if (harness.producer.hasActiveJob) {
            const stage = String(harness.producer.activeStage);
            seenStages.add(stage);
            if (harness.producer.demand(0).count === 0) zeroDemandStages.add(stage);
          }
          // Forced, so the DAG always advances and this test measures the
          // SHAPE of demand rather than re-testing convergence.
          await harness.producer.pump(1);
          harness.producer.consumeMeasuredDispatchCostMs();
          await nextFrame();
        }
        expect(failure).toBeNull();
        expect(settled).toBe(true);

        // The stages that may legitimately want nothing: a CPU/worker step or
        // a readback is in flight, or the page is done.
        const permitted = new Set([
          "idle", "seed-inputs", "readback", "mfd", "evolved-readback", "finish",
        ]);
        const offenders = [...zeroDemandStages].filter((stage) => !permitted.has(stage));
        expect(
          offenders,
          `these DISPATCH stages reported zero demand: ${offenders.join(", ")}. `
          + "The renderer pumps only what the ComputeBudget admits and the budget "
          + "admits only what was submitted, so a dispatch stage that asks for "
          + "nothing is never pumped and the page never converges — the Gate F "
          + "deadlock. Give the stage a case in demand().",
        ).toEqual([]);

        // Non-vacuity: the walk has to have actually visited the dispatch
        // stages, or an empty offender list means nothing.
        expect(seenStages.has("fine-band"), "the walk never reached fine-band").toBe(true);
        expect(seenStages.size).toBeGreaterThan(4);
      } finally {
        harness.dispose();
      }
    });
  }, 300_000);
});
