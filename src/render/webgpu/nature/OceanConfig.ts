import {
  assertAscending,
  assertFiniteNumber,
  assertPositive,
  assertRange,
  isPowerOfTwo,
  normalizeVec2,
  type Vec2,
} from "./validation";

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

export interface OceanFftDispatch {
  readonly axis: "horizontal" | "vertical";
  readonly stage: number;
  readonly dispatch: readonly [number, number, number];
  readonly normalize: boolean;
  readonly sourceSlot: "ping" | "pong";
  readonly destinationSlot: "ping" | "pong";
}

/**
 * wave R: the per-axis scale the inverse transform applies at its last stage.
 *
 * The initial spectrum stores `h0 = g * sqrt(0.5 * Psi(k))`, where `Psi` is a
 * spectral DENSITY in m^4. Turning a density into the per-cell variance the
 * discrete sum needs multiplies it by the cell measure `dk^2 = (2*pi/L)^2`,
 * and Tessendorf's +/-k pairing (`h0(k)` and `conj(h0(-k))` both land in one
 * real field) doubles the variance again — so the physical transform scale is
 * `dk / sqrt(2)`, split evenly across the two axes.
 *
 * The shipped chain used a plain `1/N` per axis instead, i.e. the inverse-DFT
 * convention with no cell measure at all. Measured on the CPU mirror in
 * `tests/render.webgpu-ocean-fp16.test.ts`, that made the whole rendered sea
 * three orders of magnitude too small — peak wave height 1.4e-4 m on cascade
 * 0 and 2.9e-2 m on cascade 2 at 12 m/s of wind, a mirror rather than a sea,
 * with cascade 0's transform output living in fp16 SUBNORMALS. It is also why
 * foam could not be reached at any threshold.
 *
 * This scale is strictly kinder to fp16 than `1/N` was: it never touches the
 * un-normalised stages, where the chain's maximum magnitude actually occurs
 * (77.2 at 12 m/s, unchanged, against fp16's 65,504), and it lifts the
 * smallest stage magnitudes from 3.6e-5 — below fp16's smallest normal — to
 * 7.3e-2.
 */
export function oceanTransformNormalizationScale(patchLengthMeters: number): number {
  assertPositive(patchLengthMeters, "ocean.patchLengthMeters");
  return Math.sqrt((2 * Math.PI) / patchLengthMeters / Math.SQRT2);
}

/** Dispatch sequence for the two-texture, two-complex-fields Stockham kernel. */
export function buildOceanFftDispatches(resolution: number): readonly OceanFftDispatch[] {
  if (!isPowerOfTwo(resolution) || resolution < 2) {
    throw new RangeError("FFT resolution must be a power of two");
  }
  const stages = Math.log2(resolution);
  const passes: OceanFftDispatch[] = [];
  let sourceSlot: "ping" | "pong" = "ping";
  for (const axis of ["horizontal", "vertical"] as const) {
    for (let stage = 0; stage < stages; stage += 1) {
      const destinationSlot: "ping" | "pong" = sourceSlot === "ping" ? "pong" : "ping";
      const dispatch: readonly [number, number, number] = axis === "horizontal"
        ? [Math.ceil((resolution / 2) / 8), Math.ceil(resolution / 8), 1]
        : [Math.ceil(resolution / 8), Math.ceil((resolution / 2) / 8), 1];
      passes.push(Object.freeze({
        axis,
        stage,
        dispatch,
        // 1B-13: fold 1/N into the LAST STAGE OF EACH AXIS. Folding the
        // full 1/N² anywhere earlier drops fp16 intermediates to
        // 1.5e-6…1.5e-4 — straddling the smallest fp16 normal (6.1e-5) —
        // and the small waves silently vanish into banding on cascade 0.
        normalize: stage === stages - 1,
        sourceSlot,
        destinationSlot,
      }));
      sourceSlot = destinationSlot;
    }
  }
  return Object.freeze(passes);
}

/**
 * Deterministic phase for one ocean cascade's fixed update cadence.
 *
 * The first two cascades update every frame. Slower power-of-two cadences are
 * placed into the light half of the faster schedule instead of all landing on
 * frame zero. This preserves each cascade's exact update frequency while
 * preventing the 1/1/2/4 tier-1 schedule from launching all four FFTs in one
 * frame (and likewise prevents the tier-2 /8 cascade joining that burst).
 */
export function oceanCascadeUpdatePhase(updateEveryNFrames: number): number {
  if (!Number.isSafeInteger(updateEveryNFrames) || updateEveryNFrames < 1) {
    throw new RangeError("Ocean update cadence must be a positive integer");
  }
  if (updateEveryNFrames === 1) return 0;
  return Math.max(0, Math.floor(updateEveryNFrames / 2) - 1);
}

/** True when a cascade is due on this absolute ocean frame. */
export function shouldUpdateOceanCascade(
  frameIndex: number,
  updateEveryNFrames: number,
): boolean {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("Ocean frame index must be a non-negative integer");
  }
  return frameIndex % updateEveryNFrames
    === oceanCascadeUpdatePhase(updateEveryNFrames);
}

function uniformBuffer(byteLength: number): { buffer: ArrayBuffer; view: DataView } {
  const buffer = new ArrayBuffer(byteLength);
  return { buffer, view: new DataView(buffer) };
}

/** Binary layout matching `OceanSpectrumInitParams` in OceanShaders.ts. */
export function packOceanInitializationUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const { buffer, view } = uniformBuffer(64);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, config.seed, true);
  view.setUint32(8, cascadeIndex, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, cascade.patchLengthMeters, true);
  view.setFloat32(20, config.gravityMetersPerSecondSquared, true);
  view.setFloat32(24, config.windSpeedMetersPerSecond, true);
  view.setFloat32(28, config.fetchLengthMeters, true);
  view.setFloat32(32, config.windDirection[0], true);
  view.setFloat32(36, config.windDirection[1], true);
  view.setFloat32(40, cascade.spectrumScale, true);
  view.setFloat32(44, config.directionalSpread, true);
  view.setFloat32(48, config.representativeDepthMeters, true);
  view.setFloat32(52, config.surfaceTensionOverDensity, true);
  view.setFloat32(56, cascade.minimumWavelengthMeters, true);
  view.setFloat32(60, cascade.maximumWavelengthMeters, true);
  return buffer;
}

/** Binary layout matching `OceanEvolutionParams` in OceanShaders.ts. */
export function packOceanEvolutionUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
  timeSeconds: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  assertFiniteNumber(timeSeconds, "timeSeconds");
  if (config.cascades[cascadeIndex] === undefined) {
    throw new RangeError("Invalid ocean cascade index");
  }
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, cascadeIndex, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, timeSeconds, true);
  view.setFloat32(20, config.gravityMetersPerSecondSquared, true);
  view.setFloat32(24, config.representativeDepthMeters, true);
  view.setFloat32(28, config.choppiness, true);
  return buffer;
}

/**
 * Binary layout matching `OceanFftParams` in OceanShaders.ts.
 *
 * wave R turned the trailing u32 flag into a f32 scale in its own std140 slot
 * (offset 16): the normalisation is no longer `1/N` but a per-cascade
 * physical constant, so the pass has to carry the number rather than a
 * boolean. Non-normalising passes pass 1.
 */
export function packOceanFftUniforms(
  resolution: number,
  stage: number,
  axis: "horizontal" | "vertical",
  normalizationScale: number,
): ArrayBuffer {
  const stages = Math.log2(resolution);
  if (!isPowerOfTwo(resolution) || !Number.isSafeInteger(stage) || stage < 0 || stage >= stages) {
    throw new RangeError("Invalid FFT resolution or stage");
  }
  assertPositive(normalizationScale, "ocean.fftNormalizationScale");
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, resolution, true);
  view.setUint32(4, stage, true);
  view.setUint32(8, axis === "horizontal" ? 0 : 1, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, normalizationScale, true);
  return buffer;
}

/** Binary layout matching `OceanDeriveParams` in OceanShaders.ts. */
export function packOceanDerivationUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
  deltaSeconds: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  assertRange(deltaSeconds, 0, 1, "deltaSeconds");
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, cascade.patchLengthMeters / config.resolution, true);
  view.setFloat32(20, config.foamThreshold, true);
  view.setFloat32(24, config.foamGain, true);
  view.setFloat32(28, Math.exp(-Math.LN2 * deltaSeconds / config.foamHalfLifeSeconds), true);
  return buffer;
}
