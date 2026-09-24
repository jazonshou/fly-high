import { describe, expect, it } from "vitest";
import { RERUN_SEQUENCE, runPages, scene, wrongPages } from "./breachCarveReruns";
import { adapterAdvertisesTimestampQuery, NO_TIMESTAMP_QUERY_REASON } from "./terrainPageErosionGpuHarness";

/**
 * Every page carries its breach carve, run after run
 * (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md). The chunked carve passed
 * the identity gate (one run per page) and the parity tests, and still handed
 * MFD a wrong breached surface on most pages of 65 % of timed runs: the pit
 * count read's mid-frame flush, with the deferred per-pass timing installed,
 * lost whole pages' direct and args passes. No error was raised. Reading the
 * count at the frame's end was 0 of 20 in the same interleaved sample. Runs
 * flip, so one run of this file is not the evidence; the interleaved sample
 * recorded in the finding is. What this file guarantees is that the per-page
 * check would catch such a page on any run where it happens;
 * breach-carve-reruns-control.test.ts shows the check is never vacuous.
 *
 * Per page, through the unmodified DAG pumped four dispatches a frame as the
 * cost test pumps it:
 *  - it converges;
 *  - the claim cursor ends at exactly the listed pit count: this page's args
 *    pass zeroed it, and every listed pit was claimed once;
 *  - the breached surface MFD receives is bit-identical to this address's
 *    first run, and that first run lowered cells (the carve ran).
 */

describe("the breach carve on every re-run of a page", () => {
  it("hands MFD the same carved surface on all thirty pages, every listed pit claimed", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the defect only ever showed with GPU timing on, so this host cannot set its condition`);
    }
    // Timed, as the runs that reproduced the defect were (and first in the file:
    // the first device on a page is the one reliably granted timestamp-query).
    const rows = await scene((harness) => runPages(harness, RERUN_SEQUENCE), true);
    if (!rows) throw new Error("the adapter advertises timestamp-query but this device has none; the reproducing condition could not be set");
    for (const row of rows) {
      console.log(`breach rerun #${row.index} ${row.key}: ${row.lowered} cells lowered, `
        + `${row.differing} differ from the first run, cursor ${row.cursor} of ${row.listed} listed`);
    }
    expect(wrongPages(rows)).toEqual([]);
    expect(rows).toHaveLength(RERUN_SEQUENCE.length);
  }, 600_000);
});
