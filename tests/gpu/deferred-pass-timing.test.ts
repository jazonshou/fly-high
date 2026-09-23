import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { describe, expect, it } from "vitest";
import { counterOf, makeShader, nextReading, SINK_INVOCATIONS, withTimedEngine } from "./deferredPassTimingRig";
import { hostLoad } from "./hostLoad";
import { adapterAdvertisesTimestampQuery, NO_TIMESTAMP_QUERY_REASON, nextFrame } from "./terrainPageErosionGpuHarness";

/**
 * The per-pass timing instrument itself (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md).
 *
 * Babylon's own read resolves a pass's query slots before the pass runs, so a
 * trivial pass that follows a heavy one in the same slot reads the heavy
 * pass's time. The positive control here is that exact case: if a trivial
 * pass ever reads like a heavy one, the instrument is measuring the slot's
 * previous occupant again.
 *
 * That swap is asserted whatever the host is doing: the medians invert and
 * the heavy pass reads microseconds. The absolute bounds on the WORST reading
 * (every trivial pass under 1 ms, every heavy one ten times the slowest
 * trivial) are timing bounds, not correctness bounds: another context the GPU
 * time-slices in lands inside a one-invocation pass (the 2026-09-23 gate read
 * one at 1.52 ms with the host busy). They skip, naming the load, when the
 * host was busy before or after the readings, and fail on a quiet host.
 *
 * One engine in this file: the readback cost's two arms are
 * deferred-pass-timing-babylon-reads.test.ts and
 * deferred-pass-timing-deferred-reads.test.ts, each the first engine on its
 * own page (deferredPassTimingRig.ts says why).
 */

describe("deferred per-pass timing on the device", () => {
  it("gives a heavy and a trivial pass taking turns in slot 0 their own times, in both orders", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the per-pass instrument stays unverified on this host`);
    }
    const loadBefore = await hostLoad("before the readings");
    const readings = await withTimedEngine(true, async ({ engine }) => {
      engine.runRenderLoop(() => {});
      const sink = new StorageBuffer(engine, SINK_INVOCATIONS * 4);
      try {
        const heavy = makeShader(engine, sink, "timing-heavy", 4096);
        const trivial = makeShader(engine, sink, "timing-trivial", 1);
        await heavy.dispatchWhenReady(4096, 1, 1);
        await trivial.dispatchWhenReady(1, 1, 1);
        for (let frame = 0; frame < 12; frame += 1) await nextFrame();
        const out: Array<{ order: string; name: string; ms: number }> = [];
        for (const order of [[heavy, trivial], [trivial, heavy]] as const) {
          for (let round = 0; round < 6; round += 1) {
            for (const shader of order) {
              const before = counterOf(shader).count;
              // One pass per frame, so each lands in slot 0 after the other.
              await new Promise<void>((resolve) => { engine.onEndFrameObservable.addOnce(() => resolve()); });
              shader.dispatch(shader === heavy ? 4096 : 1, 1, 1);
              out.push({
                order: `${order[0].name} first`,
                name: shader.name,
                ms: await nextReading(shader, before),
              });
            }
          }
        }
        return out;
      } finally {
        sink.dispose();
      }
    });
    const loadAfter = await hostLoad("after the readings");
    if (!readings) {
      throw new Error("the adapter advertises timestamp-query but the device measured nothing; the control proves nothing");
    }
    for (const reading of readings) console.log(`control ${reading.order}: ${reading.name} ${reading.ms.toFixed(4)} ms`);
    const heavy = readings.filter((reading) => reading.name === "timing-heavy").map((reading) => reading.ms);
    const trivial = readings.filter((reading) => reading.name === "timing-trivial").map((reading) => reading.ms);
    expect(heavy).toHaveLength(12);
    expect(trivial).toHaveLength(12);
    // Babylon's own read gives the trivial pass the heavy pass's milliseconds
    // and the heavy pass the trivial pass's microseconds, every time. Load
    // only lengthens a reading, so neither of these can fail from it.
    expect(Math.min(...heavy), "every heavy pass reads its own milliseconds").toBeGreaterThan(1);
    expect(median(heavy), "the typical heavy pass reads far above the typical trivial one").toBeGreaterThan(10 * median(trivial));
    // The timing bounds on the worst reading.
    const worstTrivial = Math.max(...trivial);
    const busy = [...loadBefore.busy, ...loadAfter.busy];
    if ((worstTrivial >= 1 || Math.min(...heavy) <= 10 * worstTrivial) && busy.length > 0) {
      context.skip(`the swap is absent, but a trivial pass read ${worstTrivial.toFixed(3)} ms on a busy host (${busy.join("; ")}); a timing bound, not a correctness bound`);
    }
    expect(worstTrivial, "no trivial pass reads a heavy pass's time").toBeLessThan(1);
    expect(Math.min(...heavy)).toBeGreaterThan(10 * worstTrivial);
  }, 120_000);
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
