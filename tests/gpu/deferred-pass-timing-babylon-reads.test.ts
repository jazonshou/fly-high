import { describe, expect, it } from "vitest";
import { logReadbackCost, readbackCostRows } from "./deferredPassTimingRig";
import { adapterAdvertisesTimestampQuery, NO_TIMESTAMP_QUERY_REASON } from "./terrainPageErosionGpuHarness";

/**
 * The readback cost's positive control (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md):
 * Babylon's own per-pass timing issues one read per timed pass, so at 88 timed
 * passes a frame it reads 88 times. Its deferred counterpart,
 * deferred-pass-timing-deferred-reads.test.ts, must read once. The first and
 * only engine on its page (deferredPassTimingRig.ts).
 */
describe("Babylon's own per-pass timing on the device", () => {
  it("issues one read per timed pass", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; Babylon's per-pass read count stays unverified on this host`);
    }
    const rows = await readbackCostRows(false);
    if (!rows) throw new Error("the adapter advertises timestamp-query but the device measured nothing");
    logReadbackCost("babylon", rows);
    const busiest = rows[rows.length - 1]!;
    expect(busiest.perPassReadsPerFrame).toBeGreaterThan(busiest.passes * 0.9);
  }, 240_000);
});
