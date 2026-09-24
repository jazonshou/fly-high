import { describe, expect, it } from "vitest";
import { logReadbackCost, readbackCostRows } from "./deferredPassTimingRig";
import { adapterAdvertisesTimestampQuery, NO_TIMESTAMP_QUERY_REASON } from "./terrainPageErosionGpuHarness";

/**
 * The deferred per-pass timing's readback cost (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md):
 * one batched readback a frame however many passes it times, and no per-pass
 * read at all. deferred-pass-timing-babylon-reads.test.ts is the positive
 * control that the count would see per-pass reads. The first and only engine
 * on its page (deferredPassTimingRig.ts).
 */
describe("deferred per-pass timing's readback on the device", () => {
  it("reads back once per frame however many passes it times", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the readback count stays unverified on this host`);
    }
    const rows = await readbackCostRows(true);
    if (!rows) throw new Error("the adapter advertises timestamp-query but the device measured nothing");
    logReadbackCost("deferred", rows);
    for (const row of rows) {
      // Every frame of these rows timed at least one pass, except the zero row.
      expect(row.perPassReadsPerFrame, `deferred, ${row.passes} passes`).toBe(0);
      if (row.passes > 0) expect(row.readbacksPerFrame, `deferred, ${row.passes} passes`).toBeCloseTo(1, 1);
    }
  }, 240_000);
});
