import type { WeatherPreset } from "@/src/game/types";
import type { WorldDefinition } from "@/src/world/types";
import { resolveSpectralOceanConfig, type SpectralOceanConfig } from "./spectrumConfig";

/**
 * How much of the world's prevailing wind each weather preset blows. The sim
 * scales the wind it flies through by it, and (decision D2, approved
 * 2026-10-26) the sea's spectrum wind is scaled by the same number, so Clear
 * draws a calmer sea and Cloudy a rougher one. Breezy, the game's default, is
 * exactly 1: its sea is the sea the world always had.
 */
export const WEATHER_WIND_SCALE: Readonly<Record<WeatherPreset, number>> = Object.freeze({
  clear: 0.62,
  breezy: 1,
  cloudy: 1.28,
});

export function weatherWindScale(weather: WeatherPreset): number {
  return WEATHER_WIND_SCALE[weather];
}

/**
 * The ocean spectrum's seed for a world: its source-seed hash, the number the
 * perf harness has always passed. The renderer and the sea twin both read it
 * here, so no session can draw one sea and float on another.
 */
export function oceanSpectrumSeed(world: Pick<WorldDefinition, "sourceSeedHash">): number {
  return world.sourceSeedHash >>> 0;
}

/** The ocean spectrum's wind speed, m/s: the world's prevailing wind as the weather blows it. */
export function seaSpectrumWindSpeed(
  world: Pick<WorldDefinition, "prevailingWindSpeed">,
  weather: WeatherPreset,
): number {
  return world.prevailingWindSpeed * weatherWindScale(weather);
}

/** The sea-state inputs a world carries. */
export type SeaWorld = Pick<
  WorldDefinition,
  "sourceSeedHash" | "prevailingWindRadians" | "prevailingWindSpeed"
>;

/**
 * The one spectral-ocean config a session's sea is drawn and floated on, at
 * the given FFT resolution, before a quality tier takes its prefix of the
 * cascades. The sea twin uses the full canonical config (256 points, every
 * cascade); the renderer resolves the same call at its tier's resolution, and
 * after the phase hash keys on the wave rather than the texel, the cascades
 * the two share hold the same waves.
 */
export function resolveSeaSpectrumConfig(
  world: SeaWorld,
  weather: WeatherPreset,
  resolution = 256,
): SpectralOceanConfig {
  return resolveSpectralOceanConfig({
    resolution,
    seed: oceanSpectrumSeed(world),
    windDirection: [Math.sin(world.prevailingWindRadians), Math.cos(world.prevailingWindRadians)],
    windSpeedMetersPerSecond: seaSpectrumWindSpeed(world, weather),
  });
}
