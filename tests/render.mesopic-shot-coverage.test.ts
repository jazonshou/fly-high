import { describe, expect, it } from "vitest";
import {
  rodFractionForAdaptedLuminance,
  SCOTOPIC_THRESHOLD_CD_M2,
  PHOTOPIC_THRESHOLD_CD_M2,
} from "../src/render/webgpu/atmosphere/ScotopicVision";
import {
  resolveEnvironmentState,
  adaptedLuminanceCdM2,
} from "../src/render/webgpu/nature/EnvironmentDirector";
import {
  moonState,
  moonIlluminanceLux,
} from "../src/render/webgpu/atmosphere/Ephemeris";
import {
  localSiderealTimeHours,
  equatorialToWorldRows,
  equatorialUnitVector,
  equatorialToWorld,
} from "../src/render/webgpu/atmosphere/StarCatalogue";
import { PERF_CAPTURE_SHOTS, PERF_CAPTURE_DEFAULT_CLOCK } from "../scripts/perf-capture.mts";
import { createWorld } from "../src/world";

/**
 * `7-4a` reaches the frame through `mix(scene, rodImage, rodFraction)`, so the
 * blend is exercised ONLY where `rodFraction` is strictly inside (0, 1).
 *
 * Before `dusk-mesopic` every shipping clock landed at exactly 0.000000 or
 * exactly 1.000000 -- sixteen distinct clocks, no partial weight anywhere. The
 * term was applied at partial weight by no capture in the set, so a regression
 * in the blend could not have been seen.
 *
 * This asserts the COVERAGE rather than the shot: it recomputes rod from the
 * shipping chain for every shot's own clock, so renaming or re-timing
 * `dusk-mesopic` is fine and DELETING the regime is not. It does not read a
 * pinned hour, because a test that pinned 20.45 would pass on a tree where the
 * exposure model had moved that hour out of the band -- the thing most worth
 * catching.
 */

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const LAT = world.latitudeDegrees;

function rodFractionAt(dayOfYear: number, solarTimeHours: number): number {
  const clock = { dayOfYear, solarTimeHours };
  const moon = moonState(clock);
  const rows = equatorialToWorldRows(localSiderealTimeHours(clock), LAT);
  const w = equatorialToWorld(
    equatorialUnitVector(moon.rightAscensionHours, moon.declinationDegrees),
    rows,
  );
  const lux = moonIlluminanceLux(moon, Math.max(w[1]!, 0));
  const state = resolveEnvironmentState({ clock, latitudeDegrees: LAT, weather: "clear" });
  return rodFractionForAdaptedLuminance(adaptedLuminanceCdM2(state, lux));
}

describe("mesopic capture coverage (7-4a)", () => {
  it("has at least one shot whose rodFraction is strictly between 0 and 1", () => {
    const partial = PERF_CAPTURE_SHOTS
      .map((shot) => {
        const c = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
        return { name: shot.name, rod: rodFractionAt(c.dayOfYear, c.solarTimeHours) };
      })
      .filter((s) => s.rod > 1e-4 && s.rod < 1 - 1e-4);

    expect(
      partial.map((s) => `${s.name} rod=${s.rod.toFixed(4)}`),
      "no capture shot exercises the mesopic blend: every clock lands at "
      + "rodFraction 0 or 1, so `mix(scene, rodImage, rodFraction)` is never "
      + "applied at partial weight and a regression in it is invisible",
    ).not.toEqual([]);
  });

  it("keeps that shot off the cliff, where a model shift would swing it", () => {
    // The evening window is asymmetric: a ~7-minute ramp reaching 12 per hour,
    // then a shelf at ~0.22 per hour. A shot on the ramp is deterministic but
    // fragile -- its rod would move far under any change to the exposure or
    // atmosphere model, churning the baseline for a reason unrelated to what
    // the shot tests. Assert the SLOPE, which is the property that matters,
    // rather than the hour, which is merely how it is achieved today.
    const MINUTE = 1 / 60;
    const offCliff = PERF_CAPTURE_SHOTS.filter((shot) => {
      const c = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
      const rod = rodFractionAt(c.dayOfYear, c.solarTimeHours);
      if (!(rod > 1e-4 && rod < 1 - 1e-4)) return false;
      const lo = rodFractionAt(c.dayOfYear, c.solarTimeHours - 3 * MINUTE);
      const hi = rodFractionAt(c.dayOfYear, c.solarTimeHours + 3 * MINUTE);
      return Math.abs(hi - lo) < 0.1;
    });
    expect(
      offCliff.length,
      "every mesopic shot sits where rodFraction swings more than 0.1 across "
      + "+/-3 minutes -- that is the twilight cliff, not the shelf",
    ).toBeGreaterThan(0);
  });

  it("puts that shot's adapted luminance inside the mesopic band", () => {
    // Non-vacuity for the band itself: rod in (0,1) is BY CONSTRUCTION the
    // same statement as adapted in (scotopic, photopic), so asserting both
    // would be circular. What is worth asserting is MARGIN -- that the shot
    // is not perched at either threshold, where the regime is technically
    // entered and physically negligible.
    const shot = PERF_CAPTURE_SHOTS.find((s) => {
      const c = s.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
      const rod = rodFractionAt(c.dayOfYear, c.solarTimeHours);
      return rod > 1e-4 && rod < 1 - 1e-4;
    });
    expect(shot, "no mesopic shot to check").toBeTruthy();
    const c = shot!.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
    const state = resolveEnvironmentState({
      clock: c, latitudeDegrees: LAT, weather: "clear",
    });
    const moon = moonState(c);
    const rows = equatorialToWorldRows(localSiderealTimeHours(c), LAT);
    const w = equatorialToWorld(
      equatorialUnitVector(moon.rightAscensionHours, moon.declinationDegrees), rows);
    const adapted = adaptedLuminanceCdM2(state, moonIlluminanceLux(moon, Math.max(w[1]!, 0)));
    expect(adapted).toBeGreaterThan(SCOTOPIC_THRESHOLD_CD_M2 * 2);
    expect(adapted).toBeLessThan(PHOTOPIC_THRESHOLD_CD_M2 / 2);
  });
});
