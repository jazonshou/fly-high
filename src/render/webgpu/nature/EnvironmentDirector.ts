import type { WeatherPreset } from "@/src/game/types";
import { DAYS_PER_YEAR, type EnvironmentClock } from "@/src/world/environmentClock";
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
