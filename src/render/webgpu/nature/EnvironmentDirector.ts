import type { WeatherPreset } from "@/src/game/types";
import { DAYS_PER_YEAR, type EnvironmentClock } from "@/src/world/environmentClock";
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
  return createEnvironmentState({
    sun: {
      direction: [direction[0], direction[1], direction[2]],
    },
    weather: {
      relativeHumidity: weather.relativeHumidity,
      cloudCoverage: weather.cloudCoverage,
      cloudType: weather.cloudType,
      convection: weather.convection,
      precipitation: 0,
      surfaceWetness: 0,
      snowCoverage: 0,
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

function horizontalIlluminanceLux(state: EnvironmentState): number {
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
  // Diffuse skylight proxy with a twilight tail; 1C-10 owns the night floor.
  const sky = 14_000 * smoothstepValue(-0.1, 0.35, sunY) + 40;
  return direct + sky;
}

const REFERENCE_ILLUMINANCE_LUX = ((): number => {
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

export function exposureForState(state: EnvironmentState): number {
  const overcast = 1 - state.weather.cloudCoverage * 0.42;
  const illuminance = Math.max(horizontalIlluminanceLux(state) * overcast, 1);
  const ratio = REFERENCE_ILLUMINANCE_LUX / illuminance;
  return Math.min(2.6, Math.max(0.3, BASE_EXPOSURE * Math.pow(ratio, ADAPTATION_STRENGTH)));
}
