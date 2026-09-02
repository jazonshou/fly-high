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
    // The frame check. A ceiling measured over 36 shots at tier 1 says nothing
    // about a 40-shot set or a tier-2 run, and the two are indistinguishable
    // once the number is separated from its provenance — which is exactly the
    // error that produced "163 MiB of slack" where the answer was 238.
    expect(
      PERF_CAPTURE_SHOTS.length,
      `The ceiling's provenance records ${shotCount} shots but the set now holds `
      + `${PERF_CAPTURE_SHOTS.length}. Re-measure and update `
      + "PERF_CAPTURE_CEILING_PROVENANCE in the same commit that changes the set — "
      + "a ceiling derived over a different population is not evidence about this one.",
    ).toBe(shotCount);
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
