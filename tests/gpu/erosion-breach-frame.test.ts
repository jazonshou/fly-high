import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { describe, expect, it } from "vitest";
import { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import { FRAME_BUDGET_MS } from "@/src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { TERRAIN_EROSION_STAGE_SEED_COST_MS } from "@/src/render/webgpu/terrain/TerrainPageErosionGpu";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { admit, buildHarness, gpuTimingAvailable, nextFrame, withScene } from "./terrainPageErosionGpuHarness";

/**
 * The breach-pit pass in the frame that runs it, admitted the way the renderer
 * admits it: the producer's `demand()` submitted to a `ComputeBudget` at the
 * shipping tier, beside a higher-priority client with steady demand, and only
 * what the plan admits pumped. Estimates stay frozen at their seeds, as in
 * shipping, where timing is off and nothing refines them.
 *
 * Per frame it records what the budget BOOKED and what the GPU SPENT, for the
 * erosion client and for the competitor, from every pass's own delivered
 * duration (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md). Two
 * pages: one at the breach prices the table ships, one at the prices measured
 * for the two breach passes in the clean-room slot of 2026-09-22.
 *
 * It RECORDS today's behaviour rather than asserting it, because today's
 * behaviour is the defect (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md):
 * at the shipped 0.067 ms the ~6 ms pit carve is admitted as if free and the
 * frame spends ~9 ms of compute against a 1.73 ms cap; at its measured price
 * it never fits the cap, the floor of one goes to the higher-priority client
 * with demand, and the page stalls. What it asserts is that the measurement is
 * real: the shipped page converges and the pit frame's spend was delivered.
 * Once the pit carve is banded to fit the row, this becomes the standing gate:
 * booked close to spent, and the page converging, at the measured prices.
 */

/** The measured prices of the two breach passes: clean-room slot, 2026-09-22 (median of three runs). */
const MEASURED_BREACH_MS = Object.freeze({ direct: 0.11, pit: 6.0 });
const COMPETITOR_DEMAND = 2;

interface FrameRow {
  readonly frameId: number;
  readonly stage: string;
  readonly breachPass: "direct" | "pit" | null;
  readonly erosionAdmitted: number;
  readonly erosionBookedMs: number;
  readonly competitorAdmitted: number;
  readonly competitorBookedMs: number;
}

describe("breach-pit in its frame, under the live admission meter", () => {
  it("records booked against spent for the pit carve, at the shipped and at the measured prices", async () => {
    const spentBySinkFrame = new Map<unknown, Map<number, number>>();
    const result = await withScene(async (engine, scene) => {
      if (!gpuTimingAvailable(engine)) return null;
      const harness = buildHarness(engine, scene);
      const sink = new StorageBuffer(engine, 4096 * 64 * 4);
      // The competitor: a compute client above erosion in priority, doing real
      // work each admitted dispatch, priced at its own measured cost.
      const competitor = new ComputeShader("breach-frame-competitor", engine, {
        computeSource: `
@group(0) @binding(0) var<storage, read_write> sink: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 0.000001;
  for (var i = 0u; i < 96u; i = i + 1u) { x = fract(x * 1.0001 + 0.37); }
  sink[id.x] = x;
}`,
      }, { bindingsMapping: { sink: { group: 0, binding: 0 } } });
      competitor.setStorageBuffer("sink", sink);
      const competitorSink = (competitor as unknown as { gpuTimeInFrame: unknown }).gpuTimeInFrame;
      const erosionSinks = () => new Set((harness.producer as unknown as {
        costTrackers: ReadonlyArray<{ shader: { gpuTimeInFrame?: unknown } }>;
      }).costTrackers.map((tracker) => tracker.shader.gpuTimeInFrame));
      const spentIn = (sinks: ReadonlySet<unknown>, frameId: number) => {
        let ns = 0;
        for (const s of sinks) ns += spentBySinkFrame.get(s)?.get(frameId) ?? 0;
        return ns / 1e6;
      };
      const estimates = (harness.producer as unknown as { stageEstimatesMs: Record<string, number> }).stageEstimatesMs;
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const address = createWorldPageAddress(3, -3, 5);

      const runPage = async (breach: { direct: number; pit: number } | null, competitorMs: number) => {
        Object.assign(estimates, TERRAIN_EROSION_STAGE_SEED_COST_MS);
        if (breach) {
          estimates.breachDirect = breach.direct;
          estimates.breachPit = breach.pit;
        }
        const budget = new ComputeBudget(profile);
        const slot = admit(harness, address);
        let settled = false;
        let failure: unknown = null;
        void harness.producer.beginPage(slot, slot.token!)
          .then(() => { settled = true; })
          .catch((error: unknown) => { failure = error; });
        const rows: FrameRow[] = [];
        for (let frame = 0; frame < 900 && !settled && failure === null; frame += 1) {
          budget.beginFrame();
          if (competitorMs > 0) budget.submit("occlusionCompute", COMPETITOR_DEMAND, competitorMs);
          const demand = harness.producer.demand(0);
          if (demand.count > 0) budget.submit("erosionCompute", demand.count, demand.costMs);
          const competitorAdmitted = competitorMs > 0 ? budget.admitted("occlusionCompute") : 0;
          for (let pass = 0; pass < competitorAdmitted; pass += 1) competitor.dispatch(4096, 1, 1);
          const stage = String(harness.producer.activeStage);
          const job = (harness.producer as unknown as { job: { breachDirectDone: boolean } | null }).job;
          const breachPass = stage === "breach" ? (job?.breachDirectDone ? "pit" : "direct") : null;
          const erosionAdmitted = budget.admitted("erosionCompute");
          const frameId = engine.frameId;
          if (erosionAdmitted > 0) await harness.producer.pump(erosionAdmitted);
          rows.push({
            frameId,
            stage,
            breachPass: erosionAdmitted > 0 ? breachPass : null,
            erosionAdmitted,
            erosionBookedMs: erosionAdmitted * demand.costMs,
            competitorAdmitted,
            competitorBookedMs: competitorAdmitted * competitorMs,
          });
          await nextFrame();
        }
        for (let frame = 0; frame < 16; frame += 1) await nextFrame();
        if (failure) throw failure;
        if (!settled) harness.producer.cancelActive("breach-frame: stalled under the meter");
        harness.heightAtlas.residency.release(slot.key);
        return { rows, settled };
      };

      try {
        // Warm every pipeline, and price the competitor from its own passes.
        await competitor.dispatchWhenReady(4096, 1, 1);
        if (!(await runPage(null, 0)).settled) throw new Error("the warm page never converged");
        const probeFrames: number[] = [];
        for (let frame = 0; frame < 8; frame += 1) {
          probeFrames.push(engine.frameId);
          competitor.dispatch(4096, 1, 1);
          await nextFrame();
        }
        for (let frame = 0; frame < 12; frame += 1) await nextFrame();
        const competitorSamples = probeFrames
          .map((frameId) => spentIn(new Set([competitorSink]), frameId))
          .filter((ms) => ms > 0)
          .sort((a, b) => a - b);
        const competitorMs = competitorSamples[Math.floor(competitorSamples.length / 2)] ?? 0;
        if (!(competitorMs > 0)) throw new Error("the competitor was never timed");

        const arms = [
          {
            name: "shipped prices",
            breach: {
              direct: TERRAIN_EROSION_STAGE_SEED_COST_MS.breachDirect,
              pit: TERRAIN_EROSION_STAGE_SEED_COST_MS.breachPit,
            },
          },
          { name: "measured prices", breach: MEASURED_BREACH_MS },
        ];
        const out = [];
        for (const arm of arms) {
          const page = await runPage(arm.breach, competitorMs);
          out.push({ name: arm.name, rows: page.rows, settled: page.settled });
        }
        return { competitorMs, arms: out, erosionSinks: erosionSinks(), competitorSink, capMs: new ComputeBudget(profile).capMs };
      } finally {
        sink.dispose();
        harness.dispose();
      }
    }, true, {
      onPassTimed: (sinkKey, frameId, nanoseconds) => {
        let frames = spentBySinkFrame.get(sinkKey);
        if (!frames) {
          frames = new Map();
          spentBySinkFrame.set(sinkKey, frames);
        }
        frames.set(frameId, (frames.get(frameId) ?? 0) + nanoseconds);
      },
    });
    if (!result) throw new Error("no timestamp-query on this device; nothing was measured");

    const row = FRAME_BUDGET_MS[1].erosionCompute;
    const spent = (sinks: ReadonlySet<unknown>, frameId: number) => {
      let ns = 0;
      for (const s of sinks) ns += spentBySinkFrame.get(s)?.get(frameId) ?? 0;
      return ns / 1e6;
    };
    const competitorSinks = new Set([result.competitorSink]);
    console.log(
      `breach frame: tier 1, erosion row ${row} ms, compute cap ${result.capMs.toFixed(2)} ms, `
      + `competitor ${COMPETITOR_DEMAND} x ${result.competitorMs.toFixed(3)} ms at occlusion priority`,
    );
    const summaries = result.arms.map(({ name, rows, settled }) => {
      const stalled = rows.filter((frame) => frame.stage === "breach" && frame.erosionAdmitted === 0).length;
      console.log(`  ${name}: ${settled ? "converged" : "STALLED"} in ${rows.length} frames; `
        + `${stalled} frames in breach with erosion admitted 0; competitor admitted every frame: `
        + `${rows.every((frame) => frame.competitorAdmitted > 0)}`);
      const breachRows = rows.filter((frame) => frame.breachPass !== null);
      for (const frame of breachRows) {
        const erosionSpent = spent(result.erosionSinks, frame.frameId);
        const competitorSpent = spent(competitorSinks, frame.frameId);
        console.log(
          `  ${name}: frame ${frame.frameId} breach ${frame.breachPass} (${frame.erosionAdmitted} admitted): `
          + `erosion booked ${frame.erosionBookedMs.toFixed(3)} spent ${erosionSpent.toFixed(3)} ms; `
          + `competitor ${frame.competitorAdmitted} admitted, booked ${frame.competitorBookedMs.toFixed(3)} `
          + `spent ${competitorSpent.toFixed(3)} ms; frame compute ${(erosionSpent + competitorSpent).toFixed(3)} ms`,
        );
      }
      const pitFrame = breachRows.find((frame) => frame.breachPass === "pit");
      const worst = rows.reduce((max, frame) => Math.max(
        max,
        spent(result.erosionSinks, frame.frameId) + spent(competitorSinks, frame.frameId)
          - frame.erosionBookedMs - frame.competitorBookedMs,
      ), 0);
      console.log(`  ${name}: page in ${rows.length} frames; worst frame spent-minus-booked ${worst.toFixed(3)} ms`);
      return { name, settled, pitFrame, pitSpent: pitFrame ? spent(result.erosionSinks, pitFrame.frameId) : 0 };
    });

    // The measurement is real: the shipped page converges, its pit ran in a
    // frame of its own record, and that frame's spend was delivered.
    const shipped = summaries.find((summary) => summary.name === "shipped prices")!;
    expect(shipped.settled, "the shipped page never converged under the meter").toBe(true);
    expect(shipped.pitFrame, "the pit never ran under the meter").toBeTruthy();
    expect(shipped.pitSpent, "the pit frame's spend was never delivered").toBeGreaterThan(0);
    // The measured-price page is recorded, converged or stalled, not asserted:
    // see the finding. The banding makes both pages converge with booked close to spent.
  }, 300_000);
});
