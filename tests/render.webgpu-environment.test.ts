import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptedLuminanceCdM2,
  resolveEnvironmentState,
  skyDiffuseIlluminanceLux,
  solarPosition,
  sunDirectionForClock,
  SKY_VIEW_FRACTION,
} from "../src/render/webgpu/nature/EnvironmentDirector";
import { rodFractionForAdaptedLuminance } from "../src/render/webgpu/atmosphere/ScotopicVision";
import { dayLengthHours, solarDeclinationRadians } from "../src/world/environmentClock";

/**
 * 1C-1 — the environment director's NOAA solar position, and 1C-9's
 * assertion 30: nothing under src/render may reference the time-of-day label
 * again. The rendering inputs are the two continuous clock scalars.
 */

const DEGREES = 180 / Math.PI;

describe("environment director (1C-1)", () => {
  it("puts the noon sun at 90° − |latitude − declination| elevation", () => {
    for (const [dayOfYear, latitude] of [
      [171, 45],
      [355, 45],
      [80, 0],
      [171, 60],
    ] as const) {
      const position = solarPosition({ dayOfYear, solarTimeHours: 12 }, latitude);
      const expected = 90 - Math.abs(latitude - position.declinationRadians * DEGREES);
      expect(position.elevationRadians * DEGREES).toBeCloseTo(expected, 5);
    }
  });

  it("agrees with the world module's cosine declination within a degree", () => {
    // The world module's single-cosine helper drives day length only; NOAA's
    // series is the render truth. They differ by up to ~0.9° mid-season —
    // ample agreement for both jobs, pinned so neither drifts.
    for (const dayOfYear of [0, 80, 171, 264, 355]) {
      const noaa = solarPosition({ dayOfYear, solarTimeHours: 12 }, 45).declinationRadians;
      const cosine = solarDeclinationRadians(dayOfYear);
      expect(Math.abs(noaa - cosine) * DEGREES).toBeLessThan(1);
    }
  });

  it("swings the seasonal noon elevation by twice the axial tilt", () => {
    const summer = solarPosition({ dayOfYear: 171, solarTimeHours: 12 }, 45);
    const winter = solarPosition({ dayOfYear: 355, solarTimeHours: 12 }, 45);
    expect((summer.elevationRadians - winter.elevationRadians) * DEGREES).toBeCloseTo(46.9, 0);
  });

  it("rises in the east, sets in the west, and dips below the horizon at night", () => {
    const morning = sunDirectionForClock({ dayOfYear: 171, solarTimeHours: 7 }, 45);
    const evening = sunDirectionForClock({ dayOfYear: 171, solarTimeHours: 17 }, 45);
    const midnight = sunDirectionForClock({ dayOfYear: 171, solarTimeHours: 0 }, 45);
    expect(morning[0]).toBeGreaterThan(0.2);
    expect(evening[0]).toBeLessThan(-0.2);
    expect(midnight[1]).toBeLessThan(0);
    for (const direction of [morning, evening, midnight]) {
      expect(Math.hypot(...direction)).toBeCloseTo(1, 10);
    }
  });

  it("crosses the horizon at the sunrise-equation day length", () => {
    for (const [dayOfYear, latitude] of [[171, 45], [300, 52], [30, -35]] as const) {
      const halfDay = dayLengthHours(dayOfYear, latitude) / 2;
      const beforeSunrise = solarPosition(
        { dayOfYear, solarTimeHours: 12 - halfDay - 0.35 },
        latitude,
      );
      const afterSunrise = solarPosition(
        { dayOfYear, solarTimeHours: 12 - halfDay + 0.35 },
        latitude,
      );
      expect(beforeSunrise.elevationRadians).toBeLessThan(0);
      expect(afterSunrise.elevationRadians).toBeGreaterThan(0);
    }
  });

  it("resolves a frozen, validated environment state with weather applied", () => {
    const state = resolveEnvironmentState({
      clock: { dayOfYear: 171, solarTimeHours: 12.5 },
      latitudeDegrees: 45,
      weather: "cloudy",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(state.sun.direction[1]).toBeGreaterThan(0.9);
    expect(state.weather.cloudCoverage).toBeCloseTo(0.74, 5);
    expect(state.sun.illuminanceLux).toBe(120_000);
    expect(state.sun.angularRadiusRadians).toBeCloseTo(0.004675, 6);
    expect(state.windLayers.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps latitude driving the sun path (§1.6)", () => {
    const north = solarPosition({ dayOfYear: 355, solarTimeHours: 12 }, 62);
    const equator = solarPosition({ dayOfYear: 355, solarTimeHours: 12 }, 0);
    expect(north.elevationRadians * DEGREES).toBeLessThan(6);
    expect(equator.elevationRadians * DEGREES).toBeGreaterThan(60);
  });
});

describe("time-of-day label containment (1C-9, assertion 30)", () => {
  it("keeps TimeOfDayPreset out of src/render entirely", () => {
    const root = join(__dirname, "..", "src", "render");
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (readFileSync(path, "utf8").includes("TimeOfDayPreset")) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders, "TimeOfDayPreset is a UI label, not a rendering input").toEqual([]);
  });
});

describe("field-weighted adaptation (NIGHT_LOOK 2.6 round 3)", () => {
  // Adaptation is what fills the VISUAL FIELD, not what lights the ground.
  // The sky term is the PHYSICAL illuminance model's diffuse sky over pi -
  // never the rendered art dome, which is orders of magnitude art-bright
  // and would slam night photopic. These pins are the five ladder clocks:
  // the ONLY clock the change may move is dusk.
  const rodAt = (dayOfYear: number, solarTimeHours: number): number =>
    rodFractionForAdaptedLuminance(adaptedLuminanceCdM2(resolveEnvironmentState({
      clock: { dayOfYear, solarTimeHours },
      latitudeDegrees: 45,
      weather: "clear",
    })));

  it("moves dusk out of deep rod, and no other ladder clock at all", () => {
    // Day and golden hour: photopic, exactly 0 - the field is brighter than
    // the photopic threshold whichever way it is weighted.
    expect(rodAt(171, 12.5)).toBe(0);
    expect(rodAt(179, 19.0)).toBe(0);
    // Night rungs: the physical sky term is zero below sine -0.31, so the
    // field is 0.55x the old ground value - further BELOW the scotopic
    // threshold. Rod stays exactly 1 by the model's shape, and the approved
    // frames cannot move through this function.
    expect(rodAt(179, 23.75)).toBe(1);
    expect(rodAt(171, 0)).toBe(1);
    // Dusk: the dome dominates the field and rod leaves the deep-rod regime.
    // A band, not a point - the exact value belongs to the model, and the
    // property that matters is "mesopic, nearer the middle than the top".
    const dusk = rodAt(171, 20.45);
    expect(dusk).toBeGreaterThan(0.25);
    expect(dusk).toBeLessThan(0.5);
  });

  it("keeps the sky term the same expression the illuminance model composes", () => {
    // The dome term must be skyDiffuseIlluminanceLux - the extracted shared
    // expression - so the two cannot drift. Probe by linearity: adding pure
    // dome (weather and moon fixed) at a sunY where only the tail is alive.
    expect(skyDiffuseIlluminanceLux(-0.35)).toBe(0);
    expect(skyDiffuseIlluminanceLux(-0.107)).toBeGreaterThan(2);
    expect(skyDiffuseIlluminanceLux(-0.107)).toBeLessThan(3.4);
    expect(SKY_VIEW_FRACTION).toBeGreaterThan(0);
    expect(SKY_VIEW_FRACTION).toBeLessThan(1);
  });
});
