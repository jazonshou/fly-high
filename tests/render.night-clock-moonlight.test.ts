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
 * baselined. A moonlit CONTROL is added beside it so `7-9` has something to make
 * its moonlight-shadow trade against — at day 179 rather than the year's
 * brightest day 356, because `dayOfYear` also drives the seasonal chain and the
 * control must differ in moonlight alone. See `MOONLIT_CONTROL` below.
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

/**
 * `7-0-a`'s added CONTROL shot. Eight days from `MOONLESS`, so the seasonal
 * chain is held and the pair differs in moonlight ALONE.
 *
 * **`dayOfYear` is not a moon parameter.** It also drives R-13's seasonal
 * snowline, land-cover classification and ground-cover density. The brightest
 * moon of the year at this solar time is day 356 — and at latitude 45 that is
 * WINTER, so a shot there would differ from `night` in two variables at once
 * and could not isolate the term it exists to isolate. Optimising the measured
 * variable moved an unmeasured one.
 */
const MOONLIT_CONTROL = { dayOfYear: 179, solarTimeHours: 23.75 } as const;

/**
 * `7-0-c`'s flyable preset, and a DEFERRED Phase 7 shot with its own purpose.
 * Day 356 is the year's brightest moon at this hour, on winter ground: a full
 * moon on snow is the hardest case for the scotopic range's TOP end, because
 * high albedo pushes the upper end hardest and nothing else in the set covers
 * it. That makes it a deliberate two-variable shot, which is a feature for a
 * front door and for a stress case, and disqualifying for a control.
 */
const MOONLIT_PRESET = { dayOfYear: 356, solarTimeHours: 23.75 } as const;

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

  it("the added CONTROL shot is genuinely moonlit AND holds the season", () => {
    const m = moonlightAt(MOONLIT_CONTROL.dayOfYear, MOONLIT_CONTROL.solarTimeHours);
    expect(m.illuminatedFraction).toBeGreaterThan(0.99);
    expect(m.altitudeDegrees).toBeGreaterThan(15);
    // Same solar time, so the capture driver's index-pinned temporal phase is
    // untouched; and within a fortnight of the moonless shot, so the seasonal
    // chain (snowline, land cover, ground-cover density) is effectively equal
    // and the pair isolates moonlight.
    expect(MOONLIT_CONTROL.solarTimeHours).toBe(MOONLESS.solarTimeHours);
    expect(Math.abs(MOONLIT_CONTROL.dayOfYear - MOONLESS.dayOfYear)).toBeLessThanOrEqual(14);
  });

  it("ATTRIBUTION — the moonless shot is dark because the moon has SET, not because it is half-lit", () => {
    // Decomposing the shortfall matters: someone repairing this by choosing a
    // fuller phase without checking altitude gains only the smaller factor and
    // still ships an effectively moonless frame.
    const dark = moonlightAt(MOONLESS.dayOfYear, MOONLESS.solarTimeHours);
    const lit = moonlightAt(MOONLIT_CONTROL.dayOfYear, MOONLIT_CONTROL.solarTimeHours);
    const phaseFactor = lit.illuminatedFraction / dark.illuminatedFraction;
    const totalFactor = lit.lux / dark.lux;
    // Phase is worth about 2x here; altitude carries the rest by a wide margin.
    expect(phaseFactor).toBeLessThan(3);
    expect(totalFactor / phaseFactor).toBeGreaterThan(50);
  });

  it("7-0-c: the night PRESET uses the moonlit clock, and the default is unchanged", () => {
    // The flyable preset gets the lit clock; the moonless one stays in the
    // capture set as the adversarial case.
    expect(TIME_OF_DAY_PRESET_CLOCKS.night).toEqual(MOONLIT_PRESET);
    // Same solar hour as every night capture shot, so the preset and the
    // harness describe the same moment of the night rather than two.
    expect(TIME_OF_DAY_PRESET_CLOCKS.night.solarTimeHours).toBe(MOONLESS.solarTimeHours);
    // The plan requires the SHIPPED default to be untouched by adding a preset.
    expect(DEFAULT_SETTINGS.timeOfDay).toBe("day");
    expect(TIME_OF_DAY_PRESET_CLOCKS.day).toEqual({ dayOfYear: 171, solarTimeHours: 12.5 });
  });

  it("both moonlit clocks are orders of magnitude above the moonless one", () => {
    const dark = moonlightAt(MOONLESS.dayOfYear, MOONLESS.solarTimeHours).lux;
    expect(moonlightAt(MOONLIT_CONTROL.dayOfYear, MOONLIT_CONTROL.solarTimeHours).lux / dark)
      .toBeGreaterThan(100);
    expect(moonlightAt(MOONLIT_PRESET.dayOfYear, MOONLIT_PRESET.solarTimeHours).lux / dark)
      .toBeGreaterThan(500);
  });
});
