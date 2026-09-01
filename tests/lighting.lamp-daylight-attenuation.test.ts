import { describe, expect, it } from "vitest";
import {
  airfieldLampDaylightAttenuation,
  AIRFIELD_LAMP_FULL_EFFECT_LUX,
} from "../src/render/webgpu/lighting/AirfieldLighting";
import {
  resolveEnvironmentState,
  horizontalIlluminanceLux,
} from "../src/render/webgpu/nature/EnvironmentDirector";
import { createWorld } from "../src/world";

/**
 * The airfield lamps burn at full night calibration at solar noon.
 *
 * `AIRFIELD_LAMP_SCENE_SCALE` is applied unconditionally and there is no sun,
 * elevation or time-of-day term anywhere in `AirfieldLighting.ts`. Measured on
 * `runway-on-approach` (a DAYLIGHT shot): **10,019 pixels at luminance > 245
 * against 56 in the committed baseline — 179x, 1.09% of the frame clipped.**
 *
 * **This test is written before the fix and it is the fix's constraint.** The
 * scale constant must NOT move: it carries a delicate history — three wrong
 * values — and, more to the point, the night frame it produces has Jason's
 * personal approval. So the requirement is an attenuation term that is
 * **exactly 1.0 whenever the sun is at or below the horizon**, which makes
 * every night shot untouched *by construction* rather than by measurement.
 *
 * Exactness matters and "close to 1" would not do: `night-moonlit` must come
 * back PIXEL-IDENTICAL, and identity is only guaranteed if the multiplier is
 * the literal 1.
 */

const world = createWorld("phase1-perf-baseline", { worldEvolution: "analytic" });
const LAT = world.latitudeDegrees;

function conditionsAt(dayOfYear: number, solarTimeHours: number) {
  const state = resolveEnvironmentState({
    clock: { dayOfYear, solarTimeHours }, latitudeDegrees: LAT, weather: "clear",
  });
  return { sunY: state.sun.direction[1], lux: horizontalIlluminanceLux(state) };
}

/** Every shot in the set whose clock puts the sun at or below the horizon. */
const NIGHT_SHOTS = [
  { name: "night", day: 171, hour: 23.75 },
  { name: "night-moonlit", day: 179, hour: 23.75 },
  { name: "dusk-mesopic", day: 171, hour: 20.45 },
] as const;

const DAY_SHOTS = [
  { name: "solar noon (9 shots)", day: 171, hour: 12.5 },
  { name: "runway-on-approach", day: 171, hour: 14 },
] as const;

describe("airfield lamp daylight attenuation", () => {
  it("is EXACTLY 1 for every night shot — the night calibration is untouched", () => {
    for (const shot of NIGHT_SHOTS) {
      const { sunY, lux } = conditionsAt(shot.day, shot.hour);
      expect(sunY, `${shot.name}: expected the sun below the horizon`).toBeLessThanOrEqual(0);
      const a = airfieldLampDaylightAttenuation(sunY, lux);
      // `toBe(1)`, not `toBeCloseTo` — 0.9999 would make `night-moonlit` move,
      // and that frame carries an approved `terrainBandMedianLuma` of 0.1259.
      expect(a, `${shot.name}: attenuation must be the literal 1`).toBe(1);
    }
  });

  it("is exactly 1 below the horizon for any illuminance at all", () => {
    // The night guarantee must not depend on the lux argument being small: a
    // moon, an aurora or a future sky model could raise it. The horizon gate is
    // syntactic, so nothing above it can reach through.
    for (const lux of [0, 1e-9, 2.672, 3.4, 1e3, 1e6]) {
      expect(airfieldLampDaylightAttenuation(-0.001, lux)).toBe(1);
      expect(airfieldLampDaylightAttenuation(-0.5, lux)).toBe(1);
      expect(airfieldLampDaylightAttenuation(0, lux)).toBe(1);
    }
  });

  it("can only reduce — never amplifies a lamp", () => {
    // The predicted SIGN, asserted rather than assumed: attenuation in [0, 1]
    // means every day shot's clipped-pixel count must FALL and no shot can
    // gain lamp signal. A term that could exceed 1 would make a day shot
    // brighter, which is the one outcome that would mean the fix is wrong.
    for (let sunY = -1; sunY <= 1; sunY += 0.01) {
      for (const lux of [0, 1, 3.4, 1e3, 1.11e5]) {
        const a = airfieldLampDaylightAttenuation(sunY, lux);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it("suppresses the lamps by ~4-5 orders of magnitude in full daylight", () => {
    for (const shot of DAY_SHOTS) {
      const { sunY, lux } = conditionsAt(shot.day, shot.hour);
      expect(sunY, `${shot.name}: expected the sun above the horizon`).toBeGreaterThan(0);
      const a = airfieldLampDaylightAttenuation(sunY, lux);
      // Physically anchored, not tuned to the symptom: the measured horizontal
      // illuminance at solar noon is 1.11e5 lux against 1.5e-3 at night, and a
      // lamp of fixed intensity contributes in that proportion.
      expect(a, `${shot.name}: lamps should be all but invisible`).toBeLessThan(1e-4);
      expect(a).toBeGreaterThan(0);
    }
  });

  it("is continuous across the horizon — no cliff at sunrise", () => {
    // A step at sunY = 0 would pop the whole airfield on in one frame during a
    // dawn scrub. Just above the horizon the illuminance is still below the
    // full-effect reference, so the ramp starts at 1 and falls smoothly.
    const justAbove = airfieldLampDaylightAttenuation(1e-6, AIRFIELD_LAMP_FULL_EFFECT_LUX * 0.5);
    expect(justAbove).toBe(1);
    const later = airfieldLampDaylightAttenuation(0.1, AIRFIELD_LAMP_FULL_EFFECT_LUX * 4);
    expect(later).toBeLessThan(1);
    expect(later).toBeGreaterThan(0);
  });
});
