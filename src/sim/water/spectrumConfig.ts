/**
 * The spectral ocean's configuration: one definition for the renderer's GPU
 * cascades and the simulation's sea twin.
 *
 * Moved here from `src/render/webgpu/nature/OceanConfig.ts` (which re-exports
 * it unchanged) so the sim worker can resolve the same config the renderer
 * draws without importing render code. `spectrum.ts` holds the math that turns
 * this config into waves.
 */

type Vec2 = readonly [number, number];

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function assertFiniteNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${path} must be finite`);
  }
}

function assertRange(value: number, minimum: number, maximum: number, path: string): void {
  assertFiniteNumber(value, path);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${path} must be in [${minimum}, ${maximum}], received ${value}`);
  }
}

export function assertPositive(value: number, path: string): void {
  assertFiniteNumber(value, path);
  if (value <= 0) {
    throw new RangeError(`${path} must be greater than zero, received ${value}`);
  }
}

function normalizeVec2(value: Vec2, fallback: Vec2 = [1, 0]): Vec2 {
  assertFiniteNumber(value[0], "vector[0]");
  assertFiniteNumber(value[1], "vector[1]");
  const length = Math.hypot(value[0], value[1]);
  if (length <= 1e-8) return fallback;
  return [value[0] / length, value[1] / length];
}

function assertAscending(values: readonly number[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || current <= previous) {
      throw new RangeError(`${path} must be strictly ascending`);
    }
  }
}

export interface OceanCascadeConfig {
  /** Periodic spatial domain represented by this cascade. */
  readonly patchLengthMeters: number;
  /** Band-pass limits prevent energy from being counted in adjacent cascades. */
  readonly minimumWavelengthMeters: number;
  readonly maximumWavelengthMeters: number;
  readonly spectrumScale: number;
  /** Far cascades may update less frequently while retaining phase-correct motion. */
  readonly updateEveryNFrames: number;
}

export interface SpectralOceanConfig {
  readonly resolution: number;
  readonly seed: number;
  readonly gravityMetersPerSecondSquared: number;
  readonly representativeDepthMeters: number;
  readonly windSpeedMetersPerSecond: number;
  /** Unit x/z direction toward which waves travel. */
  readonly windDirection: Vec2;
  readonly fetchLengthMeters: number;
  readonly directionalSpread: number;
  /** Surface tension divided by water density, in m^3/s^2. */
  readonly surfaceTensionOverDensity: number;
  readonly choppiness: number;
  /** Compression threshold on the horizontal displacement Jacobian. */
  readonly foamThreshold: number;
  readonly foamGain: number;
  readonly foamHalfLifeSeconds: number;
  readonly cascades: readonly OceanCascadeConfig[];
}

export type SpectralOceanConfigInput = Partial<Omit<SpectralOceanConfig, "cascades">> & {
  readonly cascades?: readonly OceanCascadeConfig[];
};

const DEFAULT_CASCADES: readonly OceanCascadeConfig[] = Object.freeze([
  Object.freeze({
    patchLengthMeters: 64,
    minimumWavelengthMeters: 0.5,
    maximumWavelengthMeters: 8,
    spectrumScale: 0.46,
    updateEveryNFrames: 1,
  }),
  Object.freeze({
    patchLengthMeters: 256,
    minimumWavelengthMeters: 8,
    maximumWavelengthMeters: 32,
    spectrumScale: 0.72,
    updateEveryNFrames: 1,
  }),
  Object.freeze({
    patchLengthMeters: 1_024,
    minimumWavelengthMeters: 32,
    maximumWavelengthMeters: 128,
    spectrumScale: 0.9,
    updateEveryNFrames: 2,
  }),
  Object.freeze({
    patchLengthMeters: 4_096,
    minimumWavelengthMeters: 128,
    maximumWavelengthMeters: 512,
    spectrumScale: 1,
    updateEveryNFrames: 4,
  }),
  Object.freeze({
    patchLengthMeters: 16_384,
    minimumWavelengthMeters: 512,
    maximumWavelengthMeters: 2_048,
    spectrumScale: 0.86,
    updateEveryNFrames: 8,
  }),
]);

export const DEFAULT_SPECTRAL_OCEAN_CONFIG: SpectralOceanConfig = Object.freeze({
  resolution: 256,
  seed: 0x4f434541,
  gravityMetersPerSecondSquared: 9.80665,
  representativeDepthMeters: 2_000,
  windSpeedMetersPerSecond: 12,
  windDirection: Object.freeze(normalizeVec2([0.93, 0.37])),
  fetchLengthMeters: 120_000,
  directionalSpread: 6,
  surfaceTensionOverDensity: 7.4e-5,
  choppiness: 1.15,
  // wave R: 0.22 -> 0.88, measured. The breaking test is
  // `clamp((foamThreshold - jacobian) * foamGain, 0, 1)` on a horizontal
  // Jacobian whose mean is 1. A CPU harness that reproduces the whole GPU
  // chain (hash, JONSWAP, evolution, inverse transform, central differences)
  // puts that Jacobian's standard deviation at 0.048-0.075 per cascade once
  // the spectrum carries its cell measure, so 0.22 asked for a -12 to -16
  // sigma excursion: foam was unreachable dead code at every wind speed.
  // At 0.88 the harness measures instantaneous coverage above 0.2 opacity of
  // 0.02% at 3.5 m/s, 0.22% at 7 m/s and 0.68% at 11 m/s — sparse, and rising
  // steeply with wind, which is what Monahan's law asks for (0.29% and 1.37%
  // at the latter two). The 2.8 s foam memory below multiplies those, so the
  // rendered coverage lands in the Monahan band rather than under it.
  foamThreshold: 0.88,
  // Deliberately UNCHANGED by wave R. The gain is the ramp, not the trigger:
  // at 2.4 a whitecap reaches ~0.42 opacity at the steepest Jacobian the
  // spectrum produces (min 0.73 at 11 m/s), so caps are pale rather than
  // blazing. Raising it whitens the caps AND multiplies the covered area,
  // which the memory term already multiplies once; it is the knob to reach for
  // if a capture shows the caps too grey, and it should be measured, not
  // guessed (harness: gain 5.5 takes 11 m/s coverage 0.68% -> 3.34%).
  foamGain: 2.4,
  foamHalfLifeSeconds: 2.8,
  cascades: DEFAULT_CASCADES,
});

function copyCascade(cascade: OceanCascadeConfig): OceanCascadeConfig {
  return Object.freeze({ ...cascade });
}

export function resolveSpectralOceanConfig(
  input: SpectralOceanConfigInput = {},
): SpectralOceanConfig {
  const defaults = DEFAULT_SPECTRAL_OCEAN_CONFIG;
  const resolution = input.resolution ?? defaults.resolution;
  const cascades = input.cascades ?? defaults.cascades.map((cascade) => ({
    ...cascade,
    minimumWavelengthMeters: Math.max(
      cascade.minimumWavelengthMeters,
      (2 * cascade.patchLengthMeters) / resolution,
    ),
  }));
  const config: SpectralOceanConfig = {
    resolution,
    seed: input.seed ?? defaults.seed,
    gravityMetersPerSecondSquared:
      input.gravityMetersPerSecondSquared ?? defaults.gravityMetersPerSecondSquared,
    representativeDepthMeters:
      input.representativeDepthMeters ?? defaults.representativeDepthMeters,
    windSpeedMetersPerSecond:
      input.windSpeedMetersPerSecond ?? defaults.windSpeedMetersPerSecond,
    windDirection: Object.freeze(normalizeVec2(input.windDirection ?? defaults.windDirection)),
    fetchLengthMeters: input.fetchLengthMeters ?? defaults.fetchLengthMeters,
    directionalSpread: input.directionalSpread ?? defaults.directionalSpread,
    surfaceTensionOverDensity:
      input.surfaceTensionOverDensity ?? defaults.surfaceTensionOverDensity,
    choppiness: input.choppiness ?? defaults.choppiness,
    foamThreshold: input.foamThreshold ?? defaults.foamThreshold,
    foamGain: input.foamGain ?? defaults.foamGain,
    foamHalfLifeSeconds: input.foamHalfLifeSeconds ?? defaults.foamHalfLifeSeconds,
    cascades: Object.freeze(cascades.map(copyCascade)),
  };
  assertSpectralOceanConfig(config);
  return Object.freeze(config);
}

export function assertSpectralOceanConfig(config: SpectralOceanConfig): void {
  if (!isPowerOfTwo(config.resolution) || config.resolution < 64 || config.resolution > 1_024) {
    throw new RangeError("ocean.resolution must be a power of two in [64, 1024]");
  }
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) {
    throw new RangeError("ocean.seed must be an unsigned 32-bit integer");
  }
  assertPositive(config.gravityMetersPerSecondSquared, "ocean.gravityMetersPerSecondSquared");
  assertPositive(config.representativeDepthMeters, "ocean.representativeDepthMeters");
  assertRange(config.windSpeedMetersPerSecond, 0.05, 100, "ocean.windSpeedMetersPerSecond");
  const windLength = Math.hypot(config.windDirection[0], config.windDirection[1]);
  if (!Number.isFinite(windLength) || Math.abs(windLength - 1) > 1e-4) {
    throw new RangeError("ocean.windDirection must be normalized");
  }
  assertPositive(config.fetchLengthMeters, "ocean.fetchLengthMeters");
  assertRange(config.directionalSpread, 0.25, 64, "ocean.directionalSpread");
  assertRange(config.surfaceTensionOverDensity, 0, 1e-2, "ocean.surfaceTensionOverDensity");
  assertRange(config.choppiness, 0, 4, "ocean.choppiness");
  assertRange(config.foamThreshold, 0, 1, "ocean.foamThreshold");
  assertRange(config.foamGain, 0, 32, "ocean.foamGain");
  assertPositive(config.foamHalfLifeSeconds, "ocean.foamHalfLifeSeconds");

  if (config.cascades.length === 0 || config.cascades.length > 5) {
    throw new RangeError("ocean.cascades must contain between one and five cascades");
  }
  assertAscending(
    config.cascades.map((cascade) => cascade.patchLengthMeters),
    "ocean.cascades patch lengths",
  );
  config.cascades.forEach((cascade, index) => {
    const path = `ocean.cascades[${index}]`;
    assertPositive(cascade.patchLengthMeters, `${path}.patchLengthMeters`);
    assertPositive(cascade.minimumWavelengthMeters, `${path}.minimumWavelengthMeters`);
    assertPositive(cascade.maximumWavelengthMeters, `${path}.maximumWavelengthMeters`);
    if (cascade.minimumWavelengthMeters >= cascade.maximumWavelengthMeters) {
      throw new RangeError(`${path} wavelength band must have positive width`);
    }
    const nyquistWavelength = (2 * cascade.patchLengthMeters) / config.resolution;
    if (cascade.minimumWavelengthMeters + 1e-8 < nyquistWavelength) {
      throw new RangeError(
        `${path}.minimumWavelengthMeters is below the ${nyquistWavelength} m Nyquist limit`,
      );
    }
    if (cascade.maximumWavelengthMeters > cascade.patchLengthMeters) {
      throw new RangeError(`${path}.maximumWavelengthMeters cannot exceed its patch length`);
    }
    assertRange(cascade.spectrumScale, 0, 16, `${path}.spectrumScale`);
    if (!Number.isSafeInteger(cascade.updateEveryNFrames)
      || cascade.updateEveryNFrames < 1
      || cascade.updateEveryNFrames > 16) {
      throw new RangeError(`${path}.updateEveryNFrames must be an integer in [1, 16]`);
    }
  });
}
