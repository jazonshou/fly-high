import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { describe, expect, it } from "vitest";
import { counterOf, makeShader, nextReading, SINK_INVOCATIONS, withTimedEngine } from "./deferredPassTimingRig";
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
    if (!readings) {
      throw new Error("the adapter advertises timestamp-query but the device measured nothing; the control proves nothing");
    }
    for (const reading of readings) console.log(`control ${reading.order}: ${reading.name} ${reading.ms.toFixed(4)} ms`);
    const heavy = readings.filter((reading) => reading.name === "timing-heavy").map((reading) => reading.ms);
    const trivial = readings.filter((reading) => reading.name === "timing-trivial").map((reading) => reading.ms);
    expect(heavy).toHaveLength(12);
    expect(trivial).toHaveLength(12);
    // Babylon's own read gives the trivial pass the heavy pass's milliseconds
    // and the heavy pass the trivial pass's microseconds, every time.
    expect(Math.min(...heavy), "every heavy pass reads its own milliseconds").toBeGreaterThan(1);
    expect(Math.max(...trivial), "no trivial pass reads a heavy pass's time").toBeLessThan(1);
    expect(Math.min(...heavy)).toBeGreaterThan(10 * Math.max(...trivial));
  }, 120_000);
});
