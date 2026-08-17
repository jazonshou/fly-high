import { describe, expect, it } from "vitest";
import {
  createEnvironmentClock,
  createWorld,
  DAYS_PER_YEAR,
  dayLengthHours,
  DEFAULT_WORLD_LATITUDE_DEGREES,
  HOURS_PER_DAY,
  isEnvironmentClock,
  solarDeclinationRadians,
  wrapEnvironmentClock,
} from "../src/world";

const DEGREES = Math.PI / 180;

describe("environment clock (0-6)", () => {
  it("validates and freezes the two clock scalars", () => {
    const clock = createEnvironmentClock(171, 12.5);
    expect(clock).toEqual({ dayOfYear: 171, solarTimeHours: 12.5 });
    expect(Object.isFrozen(clock)).toBe(true);
    expect(isEnvironmentClock(clock)).toBe(true);

    expect(() => createEnvironmentClock(-0.5, 12)).toThrow(RangeError);
    expect(() => createEnvironmentClock(DAYS_PER_YEAR, 12)).toThrow(RangeError);
    expect(() => createEnvironmentClock(10, HOURS_PER_DAY)).toThrow(RangeError);
    expect(() => createEnvironmentClock(10, Number.NaN)).toThrow(RangeError);
    expect(isEnvironmentClock({ dayOfYear: 365, solarTimeHours: 0 })).toBe(false);
    expect(isEnvironmentClock({ dayOfYear: 0 })).toBe(false);
    expect(isEnvironmentClock(null)).toBe(false);
  });

  it("wraps cyclic inputs onto the canonical ranges", () => {
    expect(wrapEnvironmentClock(365.25, 24.5)).toEqual({
      dayOfYear: 0.25,
      solarTimeHours: 0.5,
    });
    expect(wrapEnvironmentClock(-1, -0.5)).toEqual({
      dayOfYear: 364,
      solarTimeHours: 23.5,
    });
    expect(() => wrapEnvironmentClock(Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
  });

  it("produces a physically sensible declination curve", () => {
    // Equinoxes near zero, solstices near ±23.44°.
    expect(Math.abs(solarDeclinationRadians(80))).toBeLessThan(1 * DEGREES);
    expect(solarDeclinationRadians(171)).toBeGreaterThan(23 * DEGREES);
    expect(solarDeclinationRadians(355)).toBeLessThan(-23 * DEGREES);
    // Southern-summer symmetry.
    expect(solarDeclinationRadians(171) + solarDeclinationRadians(355)).toBeCloseTo(0, 2);
  });

  it("derives day length with polar clamping", () => {
    // The equator sits near 12 h all year.
    expect(dayLengthHours(171, 0)).toBeCloseTo(12, 5);
    expect(dayLengthHours(355, 0)).toBeCloseTo(12, 5);
    // 45°N midsummer runs long, midwinter short, and they mirror each other.
    const midsummer = dayLengthHours(171, DEFAULT_WORLD_LATITUDE_DEGREES);
    const midwinter = dayLengthHours(355, DEFAULT_WORLD_LATITUDE_DEGREES);
    expect(midsummer).toBeGreaterThan(15);
    expect(midsummer).toBeLessThan(16.5);
    expect(midsummer + midwinter).toBeCloseTo(24, 0);
    // Poles clamp to polar day and polar night.
    expect(dayLengthHours(171, 89)).toBe(24);
    expect(dayLengthHours(355, 89)).toBe(0);
    expect(() => dayLengthHours(0, 91)).toThrow(RangeError);
  });

  it("stamps every world with a latitude", () => {
    expect(createWorld("clock-latitude-default").latitudeDegrees).toBe(
      DEFAULT_WORLD_LATITUDE_DEGREES,
    );
    expect(
      createWorld("clock-latitude-custom", { latitudeDegrees: -33.5 }).latitudeDegrees,
    ).toBe(-33.5);
    expect(() => createWorld("clock-latitude-invalid", { latitudeDegrees: 120 })).toThrow(
      RangeError,
    );
  });
});
