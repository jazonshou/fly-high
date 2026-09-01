import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MOON_PEAK_LIGHT_INTENSITY,
  NIGHT_AMBIENT_FLOOR_SCALE,
} from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  rodFractionForAdaptedLuminance,
  SCOTOPIC_HIGHLIGHT_GAIN,
  SCOTOPIC_HIGHLIGHT_KNEE,
} from "../src/render/webgpu/atmosphere/ScotopicVision";
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
import { TIME_OF_DAY_PRESET_CLOCKS } from "../src/settings";

/**
 * **Raising `MOON_PEAK_LIGHT_INTENSITY` cannot make moonlit ground brighter.**
 * It is the obvious lever for "a stronger lighting effect from the moon" and it
 * does not move the thing it looks like it moves — so this pins WHY, and names
 * the lever that does.
 *
 * The chain is three facts that are individually documented and were never
 * composed:
 *
 *   1. `AtmosphereSystem` builds `sceneKeyLuminance` as Lambertian ground under
 *      the frame's actual lights, and the moon term is IN it —
 *      `moonIntensity * max(moonDirection.y, 0)`.
 *   2. `FlightRenderer.applyScotopicState` feeds that key to the rod response's
 *      sigma (`adaptedLuminanceCdM2: snapshot.sceneKeyLuminanceCdM2`),
 *      deliberately, and `render.scotopic-dynamic-range.test.ts` pins the
 *      consequence as an INVARIANT: the ground half-saturates at every clock.
 *   3. So moonlit ground and sigma are THE SAME QUANTITY. Scaling the moon
 *      scales both, and `nits / (nits + sigma)` is 0.5 either way.
 *
 * **The auto-centring is a feature, and this is its cost.** It is what makes
 * moonlit ground land at the same output at every phase and altitude; it is
 * also what makes a moon-intensity raise a no-op on that ground. Both follow
 * from one line and neither is a defect.
 *
 * **What the raise DOES do is the part that matters, and it goes the wrong
 * way for a "make it lighter" request.** Ambient does not scale with the moon
 * (`ambientIntensity` floors at `NIGHT_AMBIENT_FLOOR_SCALE` and follows the
 * SKY), so raising the moon raises sigma while leaving moon-shadowed ground
 * where it was: shadows get DARKER. And a lamp is a fixed absolute source, so
 * a larger sigma shrinks its `highlightExcess` and lamps get DIMMER. The net
 * of a raise is a darker, contrastier frame — "stronger moon" in the shading
 * sense, and the opposite of "much lighter" in the exposure sense.
 *
 * **The lever for lightness is `SCOTOPIC_MID_GREY_TARGET`** (`FlightRenderer`),
 * which sets where the auto-centred ground LANDS after the exposure curve —
 * the only term in the chain that moves lit ground at all.
 *
 * **Naming it is not a proposal to raise it.** Jason's approved night frame
 * measures darker than the range that was provisionally proposed, so the
 * lightness request is ALREADY SATISFIED at the shipped value and the lift
 * that was planned against it is cancelled. This file records which lever
 * would move lightness if it were ever wanted again, and — the part that is
 * load-bearing — records that the moon constant would not.
 */

const LAT = DEFAULT_WORLD_LATITUDE_DEGREES;
const D2R = Math.PI / 180;

/** Moon altitude sine and illuminance at a clock — the composition `moonState` alone cannot do. */
function moonAt(clock: { dayOfYear: number; solarTimeHours: number }): { y: number; luxFraction: number } {
  const moon = moonState(clock);
  const ra = moon.rightAscensionHours * 15 * D2R;
  const dec = moon.declinationDegrees * D2R;
  const equatorial: [number, number, number] = [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
  const rows = equatorialToWorldRows(localSiderealTimeHours(clock), LAT);
  const y = equatorialToWorld(equatorial, rows)[1]!;
  return { y, luxFraction: moonIlluminanceLux(moon, y) / FULL_MOON_ILLUMINANCE_LUX };
}

/** `ambientIntensity` at night: `0.05 * max(skylightScale, NIGHT_AMBIENT_FLOOR_SCALE)`, floored. */
const NIGHT_AMBIENT = 0.05 * NIGHT_AMBIENT_FLOOR_SCALE;

const NIGHT = TIME_OF_DAY_PRESET_CLOCKS.night;
const { y: MOON_Y, luxFraction: MOON_LUX_FRACTION } = moonAt(NIGHT);

/**
 * The scene key at a given peak moon intensity, in scene units. The common
 * `groundAlbedo / PI` factor is dropped: it multiplies BOTH sides of every
 * ratio below and cancels, and carrying it would imply this test knows the
 * albedo when it only needs the shape.
 */
function sceneKey(peakMoonIntensity: number): number {
  return MOON_LUX_FRACTION * peakMoonIntensity * Math.max(MOON_Y, 0) + NIGHT_AMBIENT;
}

/** Naka-Rushton, with sigma fed the key. */
const response = (sceneValue: number, key: number): number => sceneValue / (sceneValue + key);

/** 7-4a's highlight term for a source at a FIXED absolute scene value. */
function highlight(sceneValue: number, key: number): number {
  const excess = Math.max(sceneValue / key - 1, 0);
  const t = Math.min(1, Math.max(0, excess / SCOTOPIC_HIGHLIGHT_KNEE));
  return SCOTOPIC_HIGHLIGHT_GAIN * (t * t * (3 - 2 * t)) * Math.log2(1 + excess);
}

const SHIPPED = MOON_PEAK_LIGHT_INTENSITY;
const PREVIOUS = 0.055;

describe("does a moon-intensity raise reach the night image?", () => {
  it("ANCHOR — the three lines this file reasons over are still the shipping ones", () => {
    // Every assertion below is arithmetic over a restatement. If any of these
    // three moves, the restatement is stale and the conclusions must be
    // re-derived before they are trusted.
    const atmosphere = readFileSync("src/render/webgpu/atmosphere/AtmosphereSystem.ts", "utf8");
    expect(
      atmosphere.includes("+ moonIntensity * Math.max(moonDirection.y, 0)"),
      "the scene key no longer contains the moon term — the coupling this file describes is gone",
    ).toBe(true);
    expect(
      atmosphere.includes("0.05 * Math.max(this.skylightScale(state, moonLux), NIGHT_AMBIENT_FLOOR_SCALE)"),
      "night ambient is no longer floored independently of the moon — shadows may now scale with it",
    ).toBe(true);
    const renderer = readFileSync("src/render/FlightRenderer.ts", "utf8");
    expect(
      renderer.includes("adaptedLuminanceCdM2: snapshot.sceneKeyLuminanceCdM2,"),
      "sigma is no longer fed the scene key — the auto-centring this file depends on is gone",
    ).toBe(true);
    // And the lever this file names has to exist to be named.
    expect(
      renderer.includes("SCOTOPIC_MID_GREY_TARGET"),
      "the lever named as the one that DOES move lit ground no longer exists",
    ).toBe(true);
  });

  it("NON-VACUITY — the moon genuinely dominates the key at the night preset", () => {
    // If ambient dominated, lit ground would barely scale with the moon and
    // the invariance below would be true for an uninteresting reason. It does
    // not: the preset is a near-full moon high in the sky.
    expect(MOON_Y).toBeGreaterThan(0.5);
    expect(MOON_LUX_FRACTION).toBeGreaterThan(0.9);
    const moonShare = (sceneKey(SHIPPED) - NIGHT_AMBIENT) / sceneKey(SHIPPED);
    expect(moonShare, "the moon is not the dominant term in the key").toBeGreaterThan(0.9);
  });

  it("PRECONDITION — at this clock the rod blend is FULLY rod, so no raw scene leaks past it", () => {
    // The invariance below is a property of `rodImage`. The pass ships
    // `mix(scene, rodImage, rod)`, so at `rod < 1` some RAW scene survives —
    // and raw scene DOES scale with the moon. The claim therefore holds only
    // where rod saturates, which is the whole night band and not dusk.
    //
    // `adaptedLuminanceCdM2` is `illuminance * overcast * albedo / PI`. A full
    // moon is 0.267 lux, so even at the top of any plausible ground albedo the
    // adapted level lands far below the scotopic threshold.
    const adaptedAtFullMoon = (albedo: number) => (FULL_MOON_ILLUMINANCE_LUX * albedo) / Math.PI;
    for (const albedo of [0.08, 0.12, 0.2, 0.35]) {
      expect(
        rodFractionForAdaptedLuminance(adaptedAtFullMoon(albedo)),
        `rod is no longer saturated at full moon on albedo ${albedo}`,
      ).toBe(1);
    }
    // Non-vacuity: the ladder is not stuck at 1 everywhere. Dusk is the rung
    // where scene DOES leak, which is why this file scopes itself to night.
    expect(rodFractionForAdaptedLuminance(0.3)).toBeLessThan(0.6);
    expect(rodFractionForAdaptedLuminance(3.0)).toBe(0);
  });

  it("THE FINDING — moonlit ground is EXACTLY invariant to the peak moon intensity", () => {
    // Not approximately. The lit ground IS the scene key, and sigma IS the
    // scene key, so the ratio is 1:1 at every intensity.
    for (const peak of [0.01, PREVIOUS, 0.1, SHIPPED, 1.0, 10.0]) {
      const key = sceneKey(peak);
      expect(response(key, key), `lit ground moved at peak ${peak}`).toBeCloseTo(0.5, 12);
    }
    // Stated as the before/after of the change that actually shipped.
    expect(response(sceneKey(PREVIOUS), sceneKey(PREVIOUS))).toBeCloseTo(0.5, 12);
    expect(response(sceneKey(SHIPPED), sceneKey(SHIPPED))).toBeCloseTo(0.5, 12);
  });

  it("THE COST — the raise darkens moon-shadowed ground and dims lamps", () => {
    // Ambient does not scale with the moon, so shadowed ground stays put in
    // absolute terms while sigma grows underneath it.
    const shadowBefore = response(NIGHT_AMBIENT, sceneKey(PREVIOUS));
    const shadowAfter = response(NIGHT_AMBIENT, sceneKey(SHIPPED));
    expect(shadowAfter, "shadows did not darken — the ambient coupling changed").toBeLessThan(shadowBefore);
    expect(shadowBefore / shadowAfter).toBeGreaterThan(2);

    // A lamp is a fixed absolute source. Price the SAME lamp against both keys.
    const lamp = sceneKey(PREVIOUS) * 1000;
    const lampBefore = highlight(lamp, sceneKey(PREVIOUS));
    const lampAfter = highlight(lamp, sceneKey(SHIPPED));
    expect(lampAfter, "lamps did not dim — the highlight term no longer measures against sigma")
      .toBeLessThan(lampBefore);
    expect(lampAfter / lampBefore).toBeGreaterThan(0.7);

    // So the direction of the whole change is DARKER, which is what makes this
    // worth a test: the constant was raised to make the night lighter.
    expect(shadowAfter).toBeLessThan(shadowBefore);
  });

  it("THE LEVER — only the display gain moves lit ground, and it moves it proportionally", () => {
    // `displayGain = SCOTOPIC_MID_GREY_TARGET / exposure`, and lit ground
    // renders at `0.5 * displayGain`. Unlike the moon constant, this is a
    // direct multiplier on the exact quantity the request is about. The two
    // values below are an EXAMPLE of the proportionality, not a target — see
    // the note above on why no lift is planned.
    const litGroundOutput = (midGreyTarget: number, exposure: number): number =>
      0.5 * (midGreyTarget / exposure);
    const exposure = 4.698026433055187;
    const shipped = litGroundOutput(0.16, exposure);
    const roundTwo = litGroundOutput(0.30, exposure);
    expect(roundTwo / shipped, "the display gain is no longer a proportional lever").toBeCloseTo(0.30 / 0.16, 12);
    expect(roundTwo).toBeGreaterThan(shipped);
  });
});
