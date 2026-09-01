import { describe, expect, it } from "vitest";
import {
  FULL_MOON_ILLUMINANCE_LUX,
  moonIlluminanceLux,
  moonState,
} from "../src/render/webgpu/atmosphere/Ephemeris";
import {
  equatorialToWorld,
  equatorialToWorldRows,
  localSiderealTimeHours,
} from "../src/render/webgpu/atmosphere/StarCatalogue";
import { DEFAULT_WORLD_LATITUDE_DEGREES } from "../src/world/world";
import { DEFAULT_SETTINGS, TIME_OF_DAY_PRESET_CLOCKS } from "../src/settings";

/**
 * How much moonlight a night clock actually delivers — and the reference
 * implementation for asking.
 *
 * **Why this is a test rather than a note.** `moonState` returns an EQUATORIAL
 * position and nothing else; the altitude above the horizon that decides whether
 * the moon lights anything comes from composing it with the observer's local
 * sidereal time and latitude. The renderer does that inside a private method on
 * `AtmosphereSystem`, so it is not reachable from a script — and a standalone
 * probe written against `moonState` alone returns zero altitude for **every day
 * of the year**, which reads as "the moon is never up" rather than as a broken
 * probe. That happened, so the composition lives here where it can be copied.
 *
 * The three steps, in order, are the whole trick:
 *   1. right ascension (HOURS) and declination (DEGREES) to a unit vector —
 *      `[cos(dec)cos(ra), cos(dec)sin(ra), sin(dec)]`, with RA converted at
 *      15°/hour, not treated as degrees;
 *   2. `equatorialToWorldRows(localSiderealTimeHours(clock), latitude)`;
 *   3. `equatorialToWorld(v, rows)[1]` — index 1 is UP. Index 0 is east and 2
 *      is north, and taking the wrong one is the other way to get a plausible
 *      number that means nothing.
 *
 * **The finding this pins.** The shipped `night` capture shot runs at
 * `{ dayOfYear: 171, solarTimeHours: 23.75 }` (`scripts/perf-capture.mts`). At
 * that clock the moon sits ON THE HORIZON and delivers about a thousandth of
 * full-moon illuminance, so a phase about night lighting was measuring a scene
 * with effectively no moonlight in it. That is also why `perf-capture.mts`
 * records `night` as the noisiest shot in the set — the rod response applies a
 * large gain to a very dark image — an explanation that stops one question short
 * of asking why the image is so dark.
 *
 * The moonless shot is KEPT: it is a good adversarial case and it is already
 * baselined. A moonlit shot is added beside it so `7-9` has something to make
 * its moonlight-shadow trade against.
 */

const LAT = DEFAULT_WORLD_LATITUDE_DEGREES;
const DEGREES_PER_HOUR = 15;
const D2R = Math.PI / 180;

/** Moon altitude above the horizon, degrees, and its illuminance in lux. */
function moonlightAt(dayOfYear: number, solarTimeHours: number): {
  altitudeDegrees: number;
  lux: number;
  illuminatedFraction: number;
} {
  const clock = { dayOfYear, solarTimeHours };
  const moon = moonState(clock);
  const ra = moon.rightAscensionHours * DEGREES_PER_HOUR * D2R;
  const dec = moon.declinationDegrees * D2R;
  const equatorial: [number, number, number] = [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
  const rows = equatorialToWorldRows(localSiderealTimeHours(clock), LAT);
  const altitudeSine = equatorialToWorld(equatorial, rows)[1];
  return {
    altitudeDegrees: Math.asin(Math.max(-1, Math.min(1, altitudeSine))) / D2R,
    lux: moonIlluminanceLux(moon, altitudeSine),
    illuminatedFraction: moon.illuminatedFraction,
  };
}

/** The clock every existing night capture shot runs at. */
const MOONLESS = { dayOfYear: 171, solarTimeHours: 23.75 } as const;
/** `7-0-a`'s added shot and `7-0-c`'s flyable preset: the moon actually up. */
const MOONLIT = { dayOfYear: 356, solarTimeHours: 23.75 } as const;

describe("night clock moonlight", () => {
  it("the probe is not vacuous: the moon is up on some days and down on others", () => {
    // The failure this guards against is a probe that returns the same answer
    // everywhere. Sampled across the year at the night solar time, altitude must
    // take both signs and vary by tens of degrees — otherwise the composition
    // above is wrong and every number below is meaningless.
    const altitudes: number[] = [];
    for (let day = 1; day <= 365; day += 7) {
      altitudes.push(moonlightAt(day, MOONLESS.solarTimeHours).altitudeDegrees);
    }
    expect(Math.max(...altitudes), "the moon is never above the horizon").toBeGreaterThan(60);
    expect(Math.min(...altitudes), "the moon is never below the horizon").toBeLessThan(-60);
  });

  it("the SHIPPED night shot has effectively no moonlight", () => {
    const m = moonlightAt(MOONLESS.dayOfYear, MOONLESS.solarTimeHours);
    // On the horizon: the disc renders, and lights nothing.
    expect(m.altitudeDegrees).toBeGreaterThan(0);
    expect(m.altitudeDegrees).toBeLessThan(2);
    // Half-lit, and then extinction at grazing altitude takes the rest.
    expect(m.illuminatedFraction).toBeCloseTo(0.4985, 3);
    expect(m.lux).toBeLessThan(FULL_MOON_ILLUMINANCE_LUX / 500);
  });

  it("the ADDED night shot is genuinely moonlit, at the same solar time", () => {
    const m = moonlightAt(MOONLIT.dayOfYear, MOONLIT.solarTimeHours);
    expect(m.altitudeDegrees).toBeGreaterThan(70);
    expect(m.illuminatedFraction).toBeGreaterThan(0.99);
    // At the full moon's own illuminance, within the distance term's swing.
    expect(m.lux).toBeGreaterThan(FULL_MOON_ILLUMINANCE_LUX * 0.9);
    // Same solar time as every other night shot, so the capture driver's
    // index-pinned temporal phase is untouched.
    expect(MOONLIT.solarTimeHours).toBe(MOONLESS.solarTimeHours);
  });

  it("7-0-c: the night PRESET uses the moonlit clock, and the default is unchanged", () => {
    // The flyable preset gets the lit clock; the moonless one stays in the
    // capture set as the adversarial case.
    expect(TIME_OF_DAY_PRESET_CLOCKS.night).toEqual(MOONLIT);
    // Same solar hour as every night capture shot, so the preset and the
    // harness describe the same moment of the night rather than two.
    expect(TIME_OF_DAY_PRESET_CLOCKS.night.solarTimeHours).toBe(MOONLESS.solarTimeHours);
    // The plan requires the SHIPPED default to be untouched by adding a preset.
    expect(DEFAULT_SETTINGS.timeOfDay).toBe("day");
    expect(TIME_OF_DAY_PRESET_CLOCKS.day).toEqual({ dayOfYear: 171, solarTimeHours: 12.5 });
  });

  it("the two clocks differ by about three orders of magnitude in moonlight", () => {
    const dark = moonlightAt(MOONLESS.dayOfYear, MOONLESS.solarTimeHours).lux;
    const lit = moonlightAt(MOONLIT.dayOfYear, MOONLIT.solarTimeHours).lux;
    expect(lit / dark).toBeGreaterThan(500);
  });
});
