import type { WeatherPreset } from "@/src/game/types";
import { DAYS_PER_YEAR, type EnvironmentClock } from "@/src/world/environmentClock";
import {
  seasonalHumidityMultiplier,
  seasonalWinterFraction,
} from "@/src/world/terrain";
import { evaluateTransmittance } from "@/src/render/webgpu/atmosphere/AtmosphereLuts";
import { createEnvironmentState, type EnvironmentState } from "./EnvironmentState";

/**
 * The environment director (1C-1) — the single source of lighting truth.
 *
 * INVARIANT THIS FILE OWNS: every rendering input describing the sky, sun and
 * weather derives from exactly two continuous scalars (the environment clock)
 * plus the world latitude and a weather preset, through the NOAA solar
 * position formula. Nothing under src/render branches on a time-of-day label;
 * seasonal sun paths fall out of the formula's own signature (declination
 * swings ±23.44°, changing maximum elevation, day length, sunrise/sunset
 * azimuth, and the length and direction of every shadow).
 *
 * Class P: pure functions over numbers. No Babylon import; Node-tested.
 */

export interface SolarPosition {
  /** Radians above the horizon; negative below. */
  readonly elevationRadians: number;
  /** Radians clockwise from north (+z), so east is π/2. */
  readonly azimuthRadians: number;
  readonly declinationRadians: number;
  readonly hourAngleRadians: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * NOAA's declination series over the fractional year. The clock carries
 * SOLAR time, so the equation of time is already absorbed by definition and
 * the hour angle is exactly 15°/hour from solar noon.
 */
export function solarPosition(
  clock: EnvironmentClock,
  latitudeDegrees: number,
): SolarPosition {
  if (
    !Number.isFinite(latitudeDegrees)
    || latitudeDegrees < -90
    || latitudeDegrees > 90
  ) {
    throw new RangeError("latitudeDegrees must be in [-90, 90]");
  }
  const fractionalYear =
    ((2 * Math.PI) / DAYS_PER_YEAR)
    * (clock.dayOfYear + (clock.solarTimeHours - 12) / 24);
  const declination =
    0.006918
    - 0.399912 * Math.cos(fractionalYear)
    + 0.070257 * Math.sin(fractionalYear)
    - 0.006758 * Math.cos(2 * fractionalYear)
    + 0.000907 * Math.sin(2 * fractionalYear)
    - 0.002697 * Math.cos(3 * fractionalYear)
    + 0.00148 * Math.sin(3 * fractionalYear);
  const hourAngle = (clock.solarTimeHours - 12) * 15 * DEGREES_TO_RADIANS;
  const latitude = latitudeDegrees * DEGREES_TO_RADIANS;

  const sinElevation =
    Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  // Unit sun vector in east/up/north; azimuth clockwise from north.
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north =
    Math.cos(latitude) * Math.sin(declination)
    - Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  return {
    elevationRadians: Math.asin(Math.min(1, Math.max(-1, sinElevation))),
    azimuthRadians: Math.atan2(east, north) < 0
      ? Math.atan2(east, north) + 2 * Math.PI
      : Math.atan2(east, north),
    declinationRadians: declination,
    hourAngleRadians: hourAngle,
  };
}

/** Unit vector toward the sun in world axes (+x east, +y up, +z north). */
export function sunDirectionForClock(
  clock: EnvironmentClock,
  latitudeDegrees: number,
): readonly [number, number, number] {
  const position = solarPosition(clock, latitudeDegrees);
  const cosElevation = Math.cos(position.elevationRadians);
  return [
    Math.sin(position.azimuthRadians) * cosElevation,
    Math.sin(position.elevationRadians),
    Math.cos(position.azimuthRadians) * cosElevation,
  ];
}

export interface WeatherProfile {
  readonly cloudCoverage: number;
  readonly relativeHumidity: number;
  readonly windSpeedMetersPerSecond: number;
  readonly cloudType: number;
  readonly convection: number;
}

/** The three weather presets as continuous state values (labels stop here). */
export const WEATHER_PROFILES: Readonly<Record<WeatherPreset, WeatherProfile>> = Object.freeze({
  clear: Object.freeze({
    cloudCoverage: 0.16,
    relativeHumidity: 0.45,
    windSpeedMetersPerSecond: 6,
    cloudType: 0.45,
    convection: 0.22,
  }),
  breezy: Object.freeze({
    cloudCoverage: 0.38,
    relativeHumidity: 0.62,
    windSpeedMetersPerSecond: 17,
    cloudType: 0.52,
    convection: 0.3,
  }),
  cloudy: Object.freeze({
    cloudCoverage: 0.74,
    relativeHumidity: 0.86,
    windSpeedMetersPerSecond: 10,
    cloudType: 0.58,
    convection: 0.34,
  }),
});

export interface EnvironmentDirectorInput {
  readonly clock: EnvironmentClock;
  readonly latitudeDegrees: number;
  readonly weather: WeatherPreset;
}

/**
 * Makes the previously dead EnvironmentState live: the validated, frozen
 * snapshot every natural render system reads. Physical constants (Rayleigh/
 * Mie/ozone coefficients, 120,000 lux, the 0.004675 rad solar radius) come
 * from the state's own defaults; this resolves the direction, weather and
 * wind for one clock instant.
 */
export function resolveEnvironmentState(input: EnvironmentDirectorInput): EnvironmentState {
  const direction = sunDirectionForClock(input.clock, input.latitudeDegrees);
  const weather = WEATHER_PROFILES[input.weather];
  const windBase = weather.windSpeedMetersPerSecond;
  // R-13: winter air is clearer. Deviation D-5 expressed turbidity once as
  // `1 + humidity·26`, so scaling humidity seasonally moves the haze with no
  // new plumbing — an exact no-op at the reference midsummer clock.
  const humidity = weather.relativeHumidity
    * seasonalHumidityMultiplier(input.clock.dayOfYear, input.latitudeDegrees);
  // R-13: snowCoverage was declared, GPU-packed and hardcoded to 0 with no
  // owner. It now follows the same seasonal kernel the terrain snow blanket
  // uses; surfaceWetness stays 0 until a precipitation model owns it
  // (recorded decision — nothing renders precipitation in Phases 2–5).
  const winter = seasonalWinterFraction(input.clock.dayOfYear, input.latitudeDegrees);
  const snowCoverage = Math.min(1, Math.max(0, (winter - 0.5) * 2.2));
  return createEnvironmentState({
    sun: {
      direction: [direction[0], direction[1], direction[2]],
    },
    weather: {
      relativeHumidity: humidity,
      cloudCoverage: weather.cloudCoverage,
      cloudType: weather.cloudType,
      convection: weather.convection,
      precipitation: 0,
      surfaceWetness: 0,
      snowCoverage,
    },
    windLayers: [
      {
        altitudeMeters: 0,
        velocityMetersPerSecond: [windBase * 0.55, windBase * 0.12],
        turbulence: 0.18,
      },
      {
        altitudeMeters: 2_000,
        velocityMetersPerSecond: [windBase * 0.85, windBase * 0.25],
        turbulence: 0.32,
      },
      {
        altitudeMeters: 8_000,
        velocityMetersPerSecond: [windBase * 1.9, windBase * 0.6],
        turbulence: 0.2,
      },
    ],
  });
}

/**
 * The single exposure curve (1C-2). One relative EV100 replaces the three-
 * or-four independent curves the audit found (sky exposure uniform, the
 * 1.08 image-processing constant, water's per-shader scales, the clouds'
 * /5.2): `exposure = 1.08 × (E_ref / E)^k` with E the physical horizontal
 * illuminance from the shared transmittance model. At the day+clear
 * reference the ratio is exactly 1, so today's look is preserved EXACTLY —
 * any change this refactor causes is a detected bug. Adaptation is
 * deliberately weak (k = 0.12): dawn should still look dim; the scene's
 * own light does the storytelling, the camera only takes the edge off.
 */
export const BASE_EXPOSURE = 1.08;
const ADAPTATION_STRENGTH = 0.12;
/** The old "day" preset's sun elevation (sin 0.82) anchors the reference. */
const REFERENCE_SUN_Y = 0.82;

function smoothstepValue(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * `7-1`/`7-2`: airglow plus integrated starlight on a moonless, clear night.
 * The accepted value for the darkest natural sky is ~0.0015 lux; `1C-10`
 * floored the same term at 40 lux, which is a well-lit car park and is why
 * "at 22:00 the ground is black" was the ONLY thing wrong with night that
 * the realignment could see — the floor was so high that no moon could ever
 * show above it.
 */
export const MOONLESS_NIGHT_ILLUMINANCE_LUX = 0.0015;

/**
 * Horizontal illuminance in lux — the PHYSICAL quantity everything about
 * the look derives from: the exposure curve, `7-2`'s adapted luminance, and
 * the star field's twilight suppression.
 *
 * `moonIlluminanceLux` is the moon's own contribution, supplied by the
 * caller because the moon's position is `Ephemeris`'s to know and this
 * module must not grow a second ephemeris.
 */
export function horizontalIlluminanceLux(
  state: EnvironmentState,
  moonIlluminanceLux = 0,
): number {
  const sunY = state.sun.direction[1];
  const transmittance = evaluateTransmittance(
    state.atmosphere,
    0,
    Math.max(sunY, -0.2),
    12,
  );
  const luminous =
    0.2126 * transmittance[0] + 0.7152 * transmittance[1] + 0.0722 * transmittance[2];
  const direct = state.sun.illuminanceLux * Math.max(sunY, 0) * luminous;
  // Diffuse skylight proxy with a twilight tail. The tail runs to the real
  // night floor now rather than stopping at a placeholder 40 lux.
  const sky = 14_000 * smoothstepValue(-0.1, 0.35, sunY)
    + 3.4 * smoothstepValue(-0.31, -0.02, sunY);
  return direct + sky + moonIlluminanceLux + MOONLESS_NIGHT_ILLUMINANCE_LUX;
}

export const REFERENCE_ILLUMINANCE_LUX = ((): number => {
  const reference = createEnvironmentState({
    sun: {
      direction: [
        Math.sqrt(Math.max(0, 1 - REFERENCE_SUN_Y * REFERENCE_SUN_Y)),
        REFERENCE_SUN_Y,
        0,
      ],
    },
  });
  return horizontalIlluminanceLux(reference);
})();

/** EV100 of the reference key, recorded for the decision log. */
export const REFERENCE_EV100 = Math.log2(REFERENCE_ILLUMINANCE_LUX / 2.5);

/**
 * Illuminance at which vision becomes rod-only: `7-2`'s 0.03 cd/m² scotopic
 * threshold, converted through a Lambertian 0.2-albedo ground
 * (`E = L·π/ρ`). Below it the rod pathway carries the image and the display
 * exposure has nothing left to do, which is what makes this the natural
 * ceiling for the curve.
 */
export const SCOTOPIC_FLOOR_ILLUMINANCE_LUX = (0.03 * Math.PI) / 0.2;

/**
 * The exposure ceiling — DERIVED, not a magic number.
 *
 * `PRE_PHASE_4_REALIGNMENT.md` §5 names the old hard clamp of 2.6 as one of
 * the two constants `7-2` must reopen, on the grounds that "its ceiling is
 * currently a magic number with no stated night rationale". This is the
 * stated rationale: the curve keeps opening down to the illuminance at
 * which human vision hands over to the rods, and stops there, because past
 * that point brightening the cone image is not what a person's night vision
 * does — `ScotopicVision`'s Naka–Rushton response is. It evaluates to ~4.66
 * at the shipped constants; the number moves only if the curve or the
 * scotopic threshold moves, which is the point.
 */
export const MAX_EXPOSURE = BASE_EXPOSURE
  * Math.pow(REFERENCE_ILLUMINANCE_LUX / SCOTOPIC_FLOOR_ILLUMINANCE_LUX, ADAPTATION_STRENGTH);

export function exposureForState(state: EnvironmentState, moonIlluminanceLux = 0): number {
  const overcast = 1 - state.weather.cloudCoverage * 0.42;
  const illuminance = Math.max(
    horizontalIlluminanceLux(state, moonIlluminanceLux) * overcast,
    SCOTOPIC_FLOOR_ILLUMINANCE_LUX * 0.05,
  );
  const ratio = REFERENCE_ILLUMINANCE_LUX / illuminance;
  return Math.min(
    MAX_EXPOSURE,
    Math.max(0.3, BASE_EXPOSURE * Math.pow(ratio, ADAPTATION_STRENGTH)),
  );
}

// ---------------------------------------------------------------------------
// 7-2 — adaptation.
// ---------------------------------------------------------------------------

/**
 * Scene-linear → cd/m². The renderer's linear unit is calibrated by the sun:
 * `PEAK_SUN_INTENSITY` (5.2) is 120,000 lux of direct normal illuminance, so
 * one scene unit is `120000 / (5.2·π)` cd/m² off a white Lambertian surface.
 * `7-2` needs this to evaluate its rod response in real units.
 */
export const SCENE_UNIT_TO_NITS = 120_000 / (5.2 * Math.PI);

/**
 * Mean scene luminance a viewer is adapted to, cd/m². Lambertian ground at
 * the world's mean albedo under the current illuminance — the standard
 * approximation, and it needs no framebuffer readback, so the capture stays
 * a function of pinned inputs (the `1A-4` stale-state rule).
 */
export function adaptedLuminanceCdM2(
  state: EnvironmentState,
  moonIlluminanceLux = 0,
): number {
  const albedo = state.atmosphere.groundAlbedo[1];
  const overcast = 1 - state.weather.cloudCoverage * 0.42;
  return (horizontalIlluminanceLux(state, moonIlluminanceLux) * overcast * albedo) / Math.PI;
}

/**
 * Bounded adaptation. Light→dark takes minutes (rhodopsin has to
 * regenerate); dark→light takes seconds. The plan requires the rate to be
 * bounded or "flying past a floodlight strobes the whole image" — there are
 * no floodlights until `7-5`, but the clock scrubs, and an unbounded step
 * would flash the whole frame on every scrub.
 *
 * Pure, so it is Node-testable and deterministic: the caller supplies the
 * previous state and the elapsed simulation seconds.
 */
export const DARK_ADAPTATION_HALF_LIFE_SECONDS = 45;
export const LIGHT_ADAPTATION_HALF_LIFE_SECONDS = 2.5;

export function adaptLuminance(
  previousCdM2: number,
  targetCdM2: number,
  deltaSeconds: number,
): number {
  if (!(previousCdM2 > 0) || !Number.isFinite(previousCdM2)) return targetCdM2;
  if (!(deltaSeconds > 0)) return previousCdM2;
  const halfLife = targetCdM2 < previousCdM2
    ? DARK_ADAPTATION_HALF_LIFE_SECONDS
    : LIGHT_ADAPTATION_HALF_LIFE_SECONDS;
  const blend = 1 - Math.pow(0.5, deltaSeconds / halfLife);
  // Interpolate in log space: adaptation is a multiplicative process, and a
  // linear lerp from 10,000 to 0.01 spends its whole time above 1.
  const logged = Math.log(previousCdM2)
    + (Math.log(Math.max(targetCdM2, 1e-6)) - Math.log(previousCdM2)) * blend;
  return Math.exp(logged);
}
