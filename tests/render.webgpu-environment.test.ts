import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveEnvironmentState,
  solarPosition,
  sunDirectionForClock,
} from "../src/render/webgpu/nature/EnvironmentDirector";
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
