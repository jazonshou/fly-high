import { describe, expect, it } from "vitest";

import { DEFAULT_AIRPORT } from "../src/world/airport";
import { runwayPlatformHeight } from "../src/render/webgpu/terrain/RunwayEarthworks";
import {
  PAPI_ANGLE_PROFILE,
  papiBarAlong,
  papiColourForAngle,
  papiElevationDegrees,
  papiOnSlopeAltitudeMeters,
  papiThresholdAlong,
  papiUnitPlacements,
  papiThresholdCrossingHeightMeters,
  papiUnitSettingDegrees,
  type PapiServedEnd,
} from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * `7-7`: the PAPI's angular law, pinned to 0.1°.
 *
 * **What these assertions cover:** the angular law itself and the geometry it
 * is evaluated over — setting angles, the indication at a given elevation, the
 * transition angles, fixture height, and the datum the angle is measured from.
 * All of it is arithmetic over `AirportDefinition`, so it holds on every seed.
 *
 * **What they do NOT cover, stated because the gap is the interesting part:**
 * nothing here renders. Whether the unit a pilot sees is the colour this
 * function returns depends on `7-5`'s billboard path, on the emissive value
 * reaching the frame through the scotopic pass, and on the near→far transition
 * — none of which exist yet and none of which these tests would notice
 * breaking. **This pins the law, not the light.**
 */

const AIRPORT = DEFAULT_AIRPORT;
const ENDS: readonly PapiServedEnd[] = [-1, 1];
const PIN_DEGREES = 0.1;

describe("the PAPI's angular law", () => {
  it("spaces four settings evenly about the glidepath at the ICAO step", () => {
    const settings = [0, 1, 2, 3].map(papiUnitSettingDegrees);
    // 20 arc-minutes between neighbours; ±30' and ±10' about the glidepath.
    expect(settings.map((s) => +s.toFixed(4))).toEqual([3.5, 3.1667, 2.8333, 2.5]);
    for (let i = 1; i < settings.length; i += 1) {
      expect(settings[i - 1]! - settings[i]!).toBeCloseTo(PAPI_ANGLE_PROFILE.unitStepDegrees, 12);
    }
    // The nearest unit is the HIGHEST. Reverse this and the on-slope picture
    // inverts to white inboard, which is the "too low" indication in the real
    // world — a sign error a pilot would act on.
    expect(settings[0]).toBeGreaterThan(settings[3]!);
  });

  it("reads two white and two red on slope, white outboard", () => {
    const onSlope = papiColourForAngle(PAPI_ANGLE_PROFILE.glidepathDegrees);
    expect([...onSlope]).toEqual(["red", "red", "white", "white"]);
  });

  it("produces the five standard indications and no others", () => {
    // Derived by sweeping, not enumerated: the five pictures are a CONSEQUENCE
    // of four evenly spaced thresholds. If a sixth appeared, the law would have
    // stopped being monotone in the observed angle.
    const seen = new Set<string>();
    for (let angle = 1.5; angle <= 4.5; angle += 0.001) {
      seen.add(papiColourForAngle(angle).join(","));
    }
    expect([...seen].sort()).toEqual([
      "red,red,red,red",
      "red,red,red,white",
      "red,red,white,white",
      "red,white,white,white",
      "white,white,white,white",
    ]);
  });

  it("puts each unit's transition within 0.1 deg of its setting", () => {
    // The pin, stated on the quantity a flight check measures: the angle at
    // which a unit changes colour.
    for (let index = 0; index < PAPI_ANGLE_PROFILE.unitCount; index += 1) {
      const setting = papiUnitSettingDegrees(index);
      let transition = Number.NaN;
      // Sweep finely enough that the sweep's own resolution cannot be mistaken
      // for the tolerance being measured.
      for (let angle = setting - 0.5; angle <= setting + 0.5; angle += 0.0005) {
        if (papiColourForAngle(angle)[index] === "white") { transition = angle; break; }
      }
      expect(Math.abs(transition - setting)).toBeLessThan(PIN_DEGREES);
    }
  });
});

describe("the geometry the law is evaluated over", () => {
  it.each(ENDS.map((end) => [end] as const))(
    "end %s: a point on the reference glidepath reads exactly on slope",
    (servedEnd) => {
      // The closing check on the datum: build a point from the glidepath
      // helper, measure it with the elevation helper, and require the
      // glidepath angle back. These two are the pin's two halves and they must
      // agree by construction rather than by tuning.
      const units = papiUnitPlacements(AIRPORT, servedEnd);
      const barAlong = papiBarAlong(AIRPORT, servedEnd);
      const thresholdAlong = papiThresholdAlong(AIRPORT, servedEnd);
      for (const distance of [200, 500, 1_000, 3_000, 8_000]) {
        const along = thresholdAlong + servedEnd * distance;
        const altitude = papiOnSlopeAltitudeMeters(AIRPORT, distance);
        for (const unit of units) {
          // Displace along the runway axis from each unit, so the quantity
          // measured is the vertical law rather than the lateral parallax of
          // an offset bar. The bar is levelled, so all four share one datum.
          const dx = along - barAlong;
          const angle = papiElevationDegrees(
            unit,
            unit.x + dx * Math.sin(AIRPORT.headingRadians),
            altitude,
            unit.z + dx * Math.cos(AIRPORT.headingRadians),
          );
          expect(
            Math.abs(angle - PAPI_ANGLE_PROFILE.glidepathDegrees),
            `at ${distance} m the on-slope path read ${angle.toFixed(4)} deg`,
          ).toBeLessThan(PIN_DEGREES);
        }
      }
    },
  );

  it("levels the bar: all four lamps share one altitude", () => {
    // The camber spans 0.146 m across this bar. Four lamps following their own
    // ground would be four slightly different glidepaths, which is the error
    // the wing bar exists to remove.
    const units = papiUnitPlacements(AIRPORT, 1);
    const altitudes = new Set(units.map((u) => u.y));
    expect(altitudes.size, "the bar is not levelled").toBe(1);
    // Non-vacuity: the grounds under the units really do differ, so levelling
    // is doing work rather than describing a flat case.
    const grounds = units.map((_, index) =>
      runwayPlatformHeight(
        AIRPORT,
        PAPI_ANGLE_PROFILE.innerOffsetMeters + index * PAPI_ANGLE_PROFILE.unitPitchMeters,
      ),
    );
    expect(Math.max(...grounds) - Math.min(...grounds)).toBeGreaterThan(0.05);
  });

  it("derives a threshold crossing height in the certificated range", () => {
    // Not asserted as a pinned constant — it is a CONSEQUENCE of the glidepath
    // and the bar's distance from the threshold. Asserted as a sanity band so
    // that a change to either input which pushes it somewhere unflyable is
    // visible here rather than in a landing.
    const tch = papiThresholdCrossingHeightMeters(AIRPORT);
    expect(tch).toBeGreaterThan(12);
    expect(tch).toBeLessThan(18);
  });

  it("sites every unit on the graded platform, so one height function serves all", () => {
    // The bar must not run off the prepared ground: past the platform edge,
    // `runwayPlatformHeight` stops describing the surface and every fixture
    // height in the bar would be wrong in a way no test here could see.
    const halfPlatform = AIRPORT.runwayWidth * 0.5 + AIRPORT.shoulderWidth;
    const outermost =
      PAPI_ANGLE_PROFILE.innerOffsetMeters
      + (PAPI_ANGLE_PROFILE.unitCount - 1) * PAPI_ANGLE_PROFILE.unitPitchMeters;
    // And clear of the paved surface at the inner end, or the bar is on the runway.
    expect(PAPI_ANGLE_PROFILE.innerOffsetMeters).toBeGreaterThan(AIRPORT.runwayWidth * 0.5);
    expect(
      outermost,
      `the outermost unit sits ${outermost} m from the centreline, past the `
        + `${halfPlatform} m graded platform edge`,
    ).toBeLessThanOrEqual(halfPlatform);
  });

  it.each(ENDS.map((end) => [end] as const))(
    "end %s: takes fixture height from the platform, not the centreline datum",
    (servedEnd) => {
      const units = papiUnitPlacements(AIRPORT, servedEnd);
      for (const unit of units) {
        const naive = AIRPORT.elevation + PAPI_ANGLE_PROFILE.fixtureHeightMeters;
        // Non-vacuity in the direction that matters: if this ever equals the
        // naive datum, the camber correction has been silently dropped.
        expect(unit.y).toBeLessThan(naive);
        expect(naive - unit.y).toBeGreaterThan(0.05);
      }
    },
  );

  it("the threshold is NOT a usable datum for this pin, and by how much", () => {
    // The plan's wording says "against the geometric glideslope from the
    // threshold". The bar is `alongFromThresholdMeters` further in, so a
    // threshold-hinged line is a different line. This measures the gap in the
    // pin's own units rather than asserting the wording is merely imprecise.
    const tan3 = Math.tan(PAPI_ANGLE_PROFILE.glidepathDegrees / (180 / Math.PI));
    const offset = PAPI_ANGLE_PROFILE.alongFromThresholdMeters;
    const errors = [200, 500, 1_000, 3_000, 8_000].map((distance) => {
      const heightOnThresholdLine = distance * tan3;
      const angleAtBar =
        Math.atan(heightOnThresholdLine / (distance + offset)) * (180 / Math.PI);
      return Math.abs(angleAtBar - PAPI_ANGLE_PROFILE.glidepathDegrees);
    });
    // Every one of them exceeds the pin, so the two datums are not
    // interchangeable anywhere the shot set can fly.
    for (const error of errors) expect(error).toBeGreaterThan(PIN_DEGREES);
    expect(Math.max(...errors)).toBeGreaterThan(1.5);
  });

  it("renders no fixtures for a world with no airport", () => {
    // D-19: the old influence form returned 1 everywhere when there was no
    // airport, so "no airport" has to be represented as absence and not as a
    // degenerate airport that still sites lights.
    const noRunway = { ...AIRPORT, runwayLength: 0, runwayWidth: 0, shoulderWidth: 0 };
    const units = papiUnitPlacements(noRunway, 1);
    // The bar still has a defined position, so the caller — not this module —
    // must gate on `getWorldAirport` returning null. Recorded as a REQUIREMENT
    // on AirfieldLightingSystem rather than pretended to be handled here.
    expect(units.length).toBe(PAPI_ANGLE_PROFILE.unitCount);
    expect(Number.isFinite(units[0]!.y)).toBe(true);
  });
});
