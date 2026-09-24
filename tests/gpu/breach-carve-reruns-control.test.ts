import { describe, expect, it } from "vitest";
import { runPages, scene, wrongPages } from "./breachCarveReruns";

/**
 * The re-run gate's positive control (breach-carve-reruns.test.ts): its
 * per-page check must catch a page whose carve skipped a chunk, so the gate
 * can never pass vacuously on a machine where the fault it guards never shows.
 * Page 1's second chunk is never recorded though the producer is told it was:
 * a carve that did not do its work, the defect's shape, made on purpose.
 *
 * Its own file, so its device is the first on its page. Babylon's compute pass
 * descriptor is one object shared by every engine on a page, and a device made
 * after a timed one inherits that engine's timestamp writes: its passes are
 * invalid and every read comes back as zeros (the finding).
 */
describe("the breach re-run gate's positive control", () => {
  it("flags the page whose carve skipped one chunk", async () => {
    const rows = await scene((harness) => runPages(harness, [[3, -3, 5], [3, -3, 5], [3, -3, 5]], (index, internals) => {
      if (index !== 1 || !internals.shaders) return;
      const carve = internals.shaders.breachPit;
      const dispatch = carve.dispatch.bind(carve);
      let calls = 0;
      carve.dispatch = (x, y, z) => {
        calls += 1;
        if (calls === 2) return true;
        return dispatch(x, y, z);
      };
    }), false);
    const wrong = wrongPages(rows!);
    console.log(`breach rerun control: ${wrong.length > 0 ? wrong.join("; ") : "NOTHING caught"}`);
    expect(wrong.some((line) => line.startsWith("#1 L3 -3,5: "))).toBe(true);
    // The first run is the reference, so it must itself be clean or the control proves nothing.
    expect(wrong.some((line) => line.startsWith("#0 "))).toBe(false);
  }, 300_000);
});
