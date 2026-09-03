import { describe, expect, it } from "vitest";
import {
  PERF_CAPTURE_CEILING_PROVENANCE,
  PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB,
  PERF_CAPTURE_SHOTS,
} from "../scripts/perf-capture.mts";

/**
 * `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` is a RATCHET, and a ratchet that
 * cannot fail in either direction is not one.
 *
 * **The history this guards against, stated once:** the ceiling was derived
 * twice from an inventory that over-counted single-channel float textures
 * fourfold (`489.0 + 6.0`, then `492.3 + 2.7`). The fix at `4543b7e` removed
 * ~236 MiB of phantom at tier 1. **Nothing re-derived the ceiling, so the same
 * assertion that once had 0.5% headroom now has 93% and passes silently on
 * every run.** A ceiling with 93% slack is not a ceiling; it is a number that
 * happens to be larger.
 *
 * **WHY THE FAILURE MESSAGE MATTERS MORE THAN THE LOGIC HERE.** When the set
 * grows, two exits cost exactly one line each: declaring the new shot
 * unmeasured, which is TRUE, and raising `shotCount`, which is FALSE — it
 * claims a measurement nobody took. **Equal cost, opposite honesty.**
 *
 * So the message must name the QUESTION, not the number. **When a failure
 * message names a value, the cheapest way out is to change that value; when it
 * names a question, the cheapest way out is to answer it.** Both are one line;
 * the message chooses which one a tired reader takes. A guard that names the
 * number is one people SATISFY instead of ANSWER — and "it is probably a light
 * shot" is precisely the assumption the 495 ceiling was built on.
 *
 * **Why a BAND and not a `>`:** `inventoriedMemoryFailures` compares with a bare
 * `>`, which catches a ceiling about to bind and is structurally blind to one
 * that has gone slack. The defect above is invisible to it *by construction*.
 */
const { measuredMaxMiB, measuredMinMiB, shotCount, tier } = PERF_CAPTURE_CEILING_PROVENANCE;

/**
 * Today's slack, 238.3 MiB over a 256.7 MiB maximum. **Pinned, not endorsed.**
 * Failing in both directions is the point: any movement forces a re-read.
 */
const PINNED_SLACK_RATIO = 0.928;

describe("inventoried-memory ceiling provenance", () => {
  it("records a self-consistent measurement", () => {
    expect(measuredMinMiB).toBeLessThanOrEqual(measuredMaxMiB);
    expect(measuredMaxMiB).toBeGreaterThan(0);
    // A ceiling below its own evidence would mean the recorded run breached it.
    expect(PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB).toBeGreaterThanOrEqual(measuredMaxMiB);
  });

  it("was derived over the SHOT SET the ceiling is applied to", () => {
    // THE POPULATION IS EVERY SHOT, and that is not an oversight.
    // `inventoriedMemoryFailures` is applied by `gateAlways` in an unfiltered
    // loop (`tests/perf/perf-capture.test.ts`), and `shot.ceilings` gates only
    // the draw-call and frame ceilings — NOT this one. So a probe with
    // `ceilings: null` is still measured against 495, and narrowing this count
    // to the gated shots would make the guard walk a collection narrower than
    // the claim it protects.
    const declared = shotCount + PERF_CAPTURE_CEILING_PROVENANCE.unmeasuredShots.length;
    expect(
      PERF_CAPTURE_SHOTS.length,
      `The capture set holds ${PERF_CAPTURE_SHOTS.length} shots; this ceiling's `
      + `provenance accounts for ${declared} (${shotCount} measured`
      + `${PERF_CAPTURE_CEILING_PROVENANCE.unmeasuredShots.length > 0
        ? `, ${PERF_CAPTURE_CEILING_PROVENANCE.unmeasuredShots.length} declared unmeasured`
        : ""}).\n\n`
      + "A shot has been added whose inventoried memory has never been measured, "
      + "so nobody yet knows whether it is the new maximum. THE QUESTION IS NOT "
      + "WHICH NUMBER TO BUMP. There are two honest exits:\n"
      + "  1. Re-measure the maximum across the whole set and update "
      + "PERF_CAPTURE_CEILING_PROVENANCE with the run you used.\n"
      + "  2. Add the shot's name to `unmeasuredShots` with a comment saying why "
      + "it has not been measured.\n\n"
      + "Exit 2 is cheap and TRUE. Raising `shotCount` instead is equally cheap "
      + "and FALSE — it claims a measurement that was never taken, which is how "
      + "495 came to sit 238 MiB above the thing it gates. 'It is probably a "
      + "light shot' is the assumption that whole episode was built on.",
    ).toBe(declared);
    expect(tier).toBe(1);
  });

  it("pins the ceiling's slack until the multiplier upstream of it is settled", () => {
    const slackMiB = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB - measuredMaxMiB;
    const slackRatio = slackMiB / measuredMaxMiB;

    // THE END STATE, written here so it is not lost: this assertion is to be
    // replaced by a BAND —
    //
    //     expect(slackRatio).toBeLessThan(0.25);      // not a gate any more
    //     expect(slackRatio).toBeGreaterThan(0.02);   // fails on ordinary drift
    //
    // — IN THE SAME COMMIT that re-derives the ceiling. Not a follow-up: a
    // pin left standing after its blocker clears is indistinguishable from a
    // pin that was always the answer.
    //
    // WHY A PIN AND NOT THE BAND TODAY. The band is the correct assertion and
    // it FAILS: 92.8% slack. The fix is to re-derive the ceiling, and that is
    // blocked — re-deriving while `ESTIMATE_FUDGE_FACTOR` stands carries a 15%
    // arbitrary component into the new number invisibly. Landing the band red
    // would blind every other session's suite to its own regressions while
    // waiting on one; widening the band to admit 93% would reproduce exactly
    // the defect this guard exists to catch. **A pin is louder than a skip**:
    // it is a ratchet on a known-bad value, with an owner and an expiry, and it
    // fails on ANY movement rather than waiting for a threshold to be crossed.
    expect(
      slackRatio,
      `The ceiling's slack has MOVED from its pinned value of ${PINNED_SLACK_RATIO}. `
      + `It now sits ${slackMiB.toFixed(1)} MiB above a measured maximum of `
      + `${measuredMaxMiB} MiB (${(100 * slackRatio).toFixed(1)}%).\n\n`
      + "If you re-derived the ceiling: good — DELETE this pin and enable the band "
      + "written above it, in this same commit, and update "
      + "PERF_CAPTURE_CEILING_PROVENANCE with the measurement you used.\n\n"
      + "If you did not: something changed the ceiling or the measured maximum "
      + "without re-deriving, which is the failure this guard exists for. The "
      + "ceiling is owned by `flight-simulator-af` and is BLOCKED on settling "
      + "ESTIMATE_FUDGE_FACTOR (PerformanceBudget.ts) — re-deriving before that "
      + "carries a 15% arbitrary component into the new number invisibly.",
    ).toBeCloseTo(PINNED_SLACK_RATIO, 2);
  });
});
