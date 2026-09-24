import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { describe, expect, it } from "vitest";
import { ComputeBudget } from "@/src/render/webgpu/core/ComputeBudget";
import { FRAME_BUDGET_MS } from "@/src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
  terrainBreachPitChunks,
} from "@/src/render/webgpu/terrain/TerrainPageErosionGpu";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import {
  adapterAdvertisesTimestampQuery,
  admit,
  buildHarness,
  gpuTimingAvailable,
  NO_TIMESTAMP_QUERY_REASON,
  nextFrame,
  withScene,
} from "./terrainPageErosionGpuHarness";

/**
 * The breach stage in the frames that run it, admitted the way the renderer
 * admits it: the producer's `demand()` submitted to a `ComputeBudget` at the
 * shipping tier, beside a higher-priority client with steady demand, and only
 * what the plan admits pumped. Estimates stay frozen at the stage table, as in
 * shipping, where timing is off and nothing refines them.
 *
 * Per frame it records what the budget BOOKED and what the GPU SPENT, for the
 * erosion client and for the competitor, from every pass's own delivered
 * duration (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md).
 *
 * The standing gate for docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md. The
 * defect it records: the pit carve ran as one serial pass of ~6 ms, admitted
 * at 0.067 ms as if free; priced honestly it never fit the cap, the floor of
 * one went to the higher-priority client, and the page stalled. The fix runs
 * the carve a chunk of pits at a time, each chunk an admitted unit priced
 * under the erosion row. So on a sparse page and a dense one, at the table's
 * prices and with the competitor present: the page converges, erosion is
 * never refused while it has demand, and no breach pass spends much more than
 * it was booked at, which is what a hitch is.
 *
 * Over-booking (a pass spending well under its price) is recorded per frame,
 * not asserted: three chunks sharing a frame have read as little as 0.074 ms
 * against 0.63 booked, and whether that is the timestamps of back-to-back
 * passes or a genuinely faster re-run of the page is not yet known. It wastes
 * budget; it cannot hitch.
 */

const COMPETITOR_DEMAND = 2;
/** The sparse page the cost test prices on, and the densest page measured (1070 pits). */
const PAGES = [[3, -3, 5], [5, -1, 1]] as const;
/**
 * The hitch side of booked against spent, per breach frame: spent at most
 * half again what was booked, plus a pass's floor. The floor is what a pass
 * reads beyond its work on this adapter: the one-thread args pass read 0.007
 * to 0.075 ms alone in its frame when the count read flushed mid-frame
 * (2026-09-22/23). With the count read at the frame's end it reads 0.067 to
 * 0.104 there, so it is priced at 0.08 and its bound is 0.2. A frame whose
 * readings are the previous frame's, never rewritten, now reads 0 (the deferred
 * timing's stale guard) and cannot fail this.
 */
const OVERSPEND_RATIO = 1.5;
const PASS_FLOOR_MS = 0.08;

interface FrameRow {
  readonly frameId: number;
  readonly stage: string;
  readonly breachPass: "direct" | "args" | "chunk" | null;
  /** In breach with the chunks unknown: the pit count is being read back. */
  readonly awaitingCount: boolean;
  readonly erosionDemand: number;
  readonly erosionAdmitted: number;
  readonly erosionBookedMs: number;
  readonly competitorAdmitted: number;
  readonly competitorBookedMs: number;
}

describe("the breach stage in its frames, under the live admission meter", () => {
  it("converges, and no breach pass overspends its booking, at the table's prices beside a competitor", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the breach frame's booked-against-spent stays unrecorded on this host`);
    }
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

      const runPage = async (level: number, x: number, z: number, competitorMs: number) => {
        Object.assign(estimates, TERRAIN_EROSION_STAGE_SEED_COST_MS);
        const budget = new ComputeBudget(profile);
        const slot = admit(harness, createWorldPageAddress(level, x, z));
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
          const job = (harness.producer as unknown as {
            job: { breachDirectDone: boolean; breachArgsDone: boolean; asyncInFlight: boolean } | null;
          }).job;
          const breachPass = stage !== "breach" ? null
            : !job?.breachDirectDone ? "direct" : !job.breachArgsDone ? "args" : "chunk";
          const erosionAdmitted = budget.admitted("erosionCompute");
          const frameId = engine.frameId;
          if (erosionAdmitted > 0) await harness.producer.pump(erosionAdmitted);
          rows.push({
            frameId,
            stage,
            breachPass: erosionAdmitted > 0 ? breachPass : null,
            awaitingCount: stage === "breach" && job?.breachArgsDone === true && job.asyncInFlight,
            erosionDemand: demand.count,
            erosionAdmitted,
            erosionBookedMs: erosionAdmitted * demand.costMs,
            competitorAdmitted,
            competitorBookedMs: competitorAdmitted * competitorMs,
          });
          await nextFrame();
        }
        for (let frame = 0; frame < 16; frame += 1) await nextFrame();
        if (failure) throw failure;
        const pits = harness.producer.lastBreachPits ?? 0;
        if (!settled) harness.producer.cancelActive("breach-frame: stalled under the meter");
        harness.heightAtlas.residency.release(slot.key);
        return { rows, settled, pits };
      };

      try {
        // Warm every pipeline on both pages, and price the competitor from its own passes.
        await competitor.dispatchWhenReady(4096, 1, 1);
        for (const [level, x, z] of PAGES) {
          if (!(await runPage(level, x, z, 0)).settled) throw new Error("a warm page never converged");
        }
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

        const pages = [];
        for (const [level, x, z] of PAGES) {
          pages.push({ label: `L${level} ${x},${z}`, ...(await runPage(level, x, z, competitorMs)) });
        }
        return { competitorMs, pages, erosionSinks: erosionSinks(), competitorSink, capMs: new ComputeBudget(profile).capMs };
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
    if (!result) throw new Error("the adapter advertises timestamp-query but the device measured nothing");

    const row = FRAME_BUDGET_MS[1].erosionCompute;
    const spent = (sinks: ReadonlySet<unknown>, frameId: number) => {
      let ns = 0;
      for (const s of sinks) ns += spentBySinkFrame.get(s)?.get(frameId) ?? 0;
      return ns / 1e6;
    };
    const competitorSinks = new Set([result.competitorSink]);
    console.log(
      `breach frame: tier 1, erosion row ${row} ms, compute cap ${result.capMs.toFixed(2)} ms, `
      + `competitor ${COMPETITOR_DEMAND} x ${result.competitorMs.toFixed(3)} ms at occlusion priority; `
      + `breach prices direct ${TERRAIN_EROSION_STAGE_SEED_COST_MS.breachDirect}, `
      + `args ${TERRAIN_EROSION_STAGE_SEED_COST_MS.breachArgs}, chunk ${TERRAIN_EROSION_STAGE_SEED_COST_MS.breachPit} ms`,
    );
    // Every page's record first, then the assertions: a failure on one page
    // must not hide the other's.
    const verdicts = result.pages.map((page) => {
      const refused = page.rows.filter((frame) => frame.erosionDemand > 0 && frame.erosionAdmitted === 0);
      const breachRows = page.rows.filter((frame) => frame.breachPass !== null);
      console.log(`  ${page.label}: ${page.settled ? "converged" : "STALLED"} in ${page.rows.length} frames, `
        + `${page.pits} pits; ${page.rows.filter((frame) => frame.awaitingCount).length} frames awaiting the pit count; `
        + `${refused.length} frames refused erosion with demand; `
        + `competitor admitted every frame: ${page.rows.every((frame) => frame.competitorAdmitted > 0)}`);
      const overspent: string[] = [];
      const overbooked: string[] = [];
      for (const frame of breachRows) {
        const erosionSpent = spent(result.erosionSinks, frame.frameId);
        const competitorSpent = spent(competitorSinks, frame.frameId);
        console.log(
          `  ${page.label}: frame ${frame.frameId} breach ${frame.breachPass} x${frame.erosionAdmitted}: `
          + `erosion booked ${frame.erosionBookedMs.toFixed(3)} spent ${erosionSpent.toFixed(3)} ms; `
          + `competitor ${frame.competitorAdmitted} admitted, booked ${frame.competitorBookedMs.toFixed(3)} `
          + `spent ${competitorSpent.toFixed(3)} ms; frame compute ${(erosionSpent + competitorSpent).toFixed(3)} ms`,
        );
        const record = `frame ${frame.frameId} ${frame.breachPass}: booked ${frame.erosionBookedMs.toFixed(3)}, `
          + `spent ${erosionSpent.toFixed(3)} ms`;
        if (erosionSpent > frame.erosionBookedMs * OVERSPEND_RATIO + PASS_FLOOR_MS) overspent.push(record);
        if (erosionSpent < frame.erosionBookedMs / OVERSPEND_RATIO - PASS_FLOOR_MS) overbooked.push(record);
      }
      const worst = page.rows.reduce((max, frame) => Math.max(
        max,
        spent(result.erosionSinks, frame.frameId) + spent(competitorSinks, frame.frameId)
          - frame.erosionBookedMs - frame.competitorBookedMs,
      ), 0);
      console.log(`  ${page.label}: worst frame spent-minus-booked ${worst.toFixed(3)} ms; `
        + `over-booked breach frames (recorded, not asserted): ${overbooked.length > 0 ? overbooked.join("; ") : "none"}`);
      // Every breach pass that ran under the meter, counted by what it admitted.
      const passes = (pass: FrameRow["breachPass"]) => breachRows
        .filter((frame) => frame.breachPass === pass)
        .reduce((sum, frame) => sum + frame.erosionAdmitted, 0);
      return {
        page,
        refused,
        overspent,
        passes: { direct: passes("direct"), args: passes("args"), chunks: passes("chunk") },
      };
    });

    for (const { page, refused, overspent, passes } of verdicts) {
      expect(page.settled, `${page.label} never converged under the meter`).toBe(true);
      expect(page.rows.every((frame) => frame.competitorAdmitted > 0), `${page.label}: the competitor was refused`)
        .toBe(true);
      expect(refused.map((frame) => `${frame.frameId} ${frame.stage}`), `${page.label}: erosion refused with demand`)
        .toEqual([]);
      // Non-vacuity: every breach pass ran under the meter, a chunk per 128 listed pits.
      expect(passes, page.label).toEqual({ direct: 1, args: 1, chunks: terrainBreachPitChunks(page.pits) });
      expect(page.pits, `${page.label}: no pits, no carve under the meter`).toBeGreaterThan(0);
      expect(overspent, `${page.label}: breach passes spent well past what they were booked at`).toEqual([]);
    }
  }, 300_000);
});
