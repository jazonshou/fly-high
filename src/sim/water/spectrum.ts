/**
 * The ocean spectrum: one TypeScript source of truth for the renderer's GPU
 * initialisation shader and the simulation's sea twin.
 *
 * Every function here has a WGSL transliteration in `spectrumWgsl.ts`, line
 * for line, the way `src/world/terrain.ts` and the terrain kernel pair up. The
 * GPU evaluates it in f32 and stores the result; the twin evaluates it in f64
 * (`tests/world.sea-twin.test.ts` holds the two together, and
 * `tests/gpu/ocean-twin-parity.test.ts` holds the GPU's own output to it).
 *
 * Conventions, all inherited from the shipped GPU chain:
 * - A wave is a grid frequency `(fx, fy)` of one cascade's periodic patch of
 *   side `L`: world wavevector `k = (2 pi / L) (fx, fy)`, x along world X and
 *   y along world Z.
 * - `h0` is a complex Gaussian times `sqrt(0.5 * Psi(k))`, `Psi` a spectral
 *   density in m^4 (see `oceanTransformNormalizationScale`).
 * - The inverse transform is `sum h(k, t) exp(+i k.x)` with
 *   `h(k, t) = h0(k) exp(-i w t) + conj(h0(-k)) exp(+i w t)`, so the real height
 *   field is `2 s^2 sum_k Re(h0(k) exp(i (k.x - w t)))` over every grid
 *   frequency, `s` the per-axis normalisation: each wave travels along its own
 *   `k`, and the spectrum puts the waves' `k` downwind.
 * - The horizontal displacement is `sum i lambda k^ h(k, t) exp(+i k.x)`, which
 *   moves the surface toward each crest (`OCEAN_CHOP_SIGN`).
 */

import type { SpectralOceanConfig } from "./spectrumConfig";
import { assertPositive, resolveSpectralOceanConfig } from "./spectrumConfig";

const TAU = Math.PI * 2;

/** The 32-bit integer hash the GPU's phase draw uses (`hash32` in WGSL). */
export function oceanHash32(value: number): number {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  return (state ^ (state >>> 16)) >>> 0;
}

/** 24 bits of the hash as a float in [0, 1), exact in f32. */
export function oceanRandom01(value: number): number {
  return (oceanHash32(value) & 0x00ffffff) / 16777216;
}

/** Box-Muller pair from one seed; writes `[re, im]` into `out`. */
export function oceanGaussianComplex(seed: number, out: [number, number]): [number, number] {
  const u1 = Math.max(oceanRandom01(seed), 1e-7);
  const u2 = oceanRandom01((seed ^ 0x9e3779b9) >>> 0);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = TAU * u2;
  out[0] = radius * Math.cos(angle);
  out[1] = radius * Math.sin(angle);
  return out;
}

/** Texel index to signed grid frequency, as the FFT stores it. */
export function oceanSignedFrequencyIndex(index: number, resolution: number): number {
  return index > resolution / 2 ? index - resolution : index;
}

/**
 * The integer a wave's random phase is hashed from.
 *
 * It depends on the wave alone, never on the FFT resolution, so every quality
 * tier draws the same wave with the same phase. A wave inside the 128-point
 * grid (signed frequencies -63..64 on both axes) keeps the index the 128-point
 * FFT has always given it, `x + 128 y` of its texel, so tiers 0 and 1, where
 * every perf baseline lives, are bit-identical. A wave outside it takes the
 * texel index of the smallest grid that holds it, offset past every smaller
 * grid so no two waves share an index.
 *
 * Before this, the index was the texel index at the FFT's own resolution, so
 * the 128-point tiers and the 256-point tiers drew different seas from one
 * seed (measured 2026-10-26 by the boats plan), and no single physics sea
 * could match both.
 */
export function oceanWavePhaseIndex(frequencyX: number, frequencyY: number): number {
  const reach = Math.max(frequencyX, 1 - frequencyX, frequencyY, 1 - frequencyY);
  let size = OCEAN_PHASE_BASE_GRID;
  let base = 0;
  for (let level = 0; level < 3 && reach > size / 2; level += 1) {
    base += size * size;
    size *= 2;
  }
  const wrappedX = (frequencyX + size) % size;
  const wrappedY = (frequencyY + size) % size;
  return base + wrappedX + wrappedY * size;
}

/**
 * The sign of time in a wave's phase, `k.x + s w t`, as the GPU's evolution
 * shader applies it (`h0 e^{-i w t}` against an inverse transform in
 * `e^{+i k.x}`). The sea twin reads it here so the two cannot disagree.
 *
 * -1 sends a wave along `+k`, where `oceanDirectionalSpectrum`'s forward lobe
 * puts it: downwind. Until 2026-10-27 the shader turned `h0` by `e^{+i w t}`,
 * and every wave of the sea travelled upwind.
 */
export const OCEAN_TIME_SIGN = -1;

/**
 * The sign of the horizontal displacement, `D = Re(s i lambda k^ h)` per wave,
 * as the evolution shader applies it. For a wave `h = A cos(psi)` that is
 * `D = -s lambda A k^ sin(psi)`; +1 is the Gerstner wave, whose surface
 * gathers toward each crest: the crests come up peaked, the troughs broad,
 * and the Jacobian's folds, where the foam is, sit on the crests. Until
 * 2026-10-27 the shader applied -1, which peaked the troughs instead.
 */
export const OCEAN_CHOP_SIGN = 1;

/** The grid whose texel index is the phase index of every wave it holds. */
export const OCEAN_PHASE_BASE_GRID = 128;

/** The seed of one wave's complex Gaussian. */
export function oceanWaveSeed(
  seed: number,
  cascadeIndex: number,
  frequencyX: number,
  frequencyY: number,
): number {
  const index = oceanWavePhaseIndex(frequencyX, frequencyY);
  return (seed ^ oceanHash32((index + Math.imul(0x9e3779b9, cascadeIndex + 1)) >>> 0)) >>> 0;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A cascade's band-pass window over wavelength, 18% feathers each side. */
export function oceanBandWindow(
  wavelength: number,
  minimumWavelength: number,
  maximumWavelength: number,
): number {
  const lowWidth = Math.max(minimumWavelength * 0.18, 0.001);
  const highWidth = Math.max(maximumWavelength * 0.18, 0.001);
  const low = smoothstep(minimumWavelength - lowWidth, minimumWavelength + lowWidth, wavelength);
  const high = 1 - smoothstep(maximumWavelength - highWidth, maximumWavelength + highWidth, wavelength);
  return low * high;
}

/** `tanh(k d)`, saturated at `k d = 10` exactly as the shader saturates it. */
export function oceanFiniteDepthFactor(wavenumber: number, depthMeters: number): number {
  return Math.tanh(Math.min(wavenumber * depthMeters, 10));
}

/** Gravity-capillary dispersion at finite depth: `w^2 = (g k + sigma k^3) tanh(k d)`. */
export function oceanAngularFrequency(
  wavenumber: number,
  gravity: number,
  surfaceTensionOverDensity: number,
  depthMeters: number,
): number {
  const gravityTerm = gravity * wavenumber;
  const capillaryTerm = surfaceTensionOverDensity * wavenumber * wavenumber * wavenumber;
  return Math.sqrt(
    Math.max((gravityTerm + capillaryTerm) * oceanFiniteDepthFactor(wavenumber, depthMeters), 0),
  );
}

/** One cascade's spectrum inputs, the fields `OceanSpectrumInitParams` carries. */
export interface OceanSpectrumParameters {
  readonly gravity: number;
  readonly windSpeed: number;
  readonly fetchLength: number;
  readonly windDirectionX: number;
  readonly windDirectionZ: number;
  readonly directionalSpread: number;
  readonly waterDepth: number;
  readonly surfaceTensionOverDensity: number;
  readonly spectrumScale: number;
  readonly minimumWavelength: number;
  readonly maximumWavelength: number;
}

/**
 * The dimensionless fetch `g F / U^2` at which JONSWAP's peak frequency,
 * `22 (g^2 / (U F))^(1/3)`, reaches the Pierson-Moskowitz fully developed peak
 * `0.855 g / U`. A longer fetch grows no bigger sea: the wind has nothing left
 * to give it.
 */
export const OCEAN_FULLY_DEVELOPED_FETCH = (22 / 0.855) ** 3;

/** Pierson-Moskowitz fully developed significant wave height, `Hs = 0.22 U^2 / g`. */
export const OCEAN_FULLY_DEVELOPED_WAVE_HEIGHT = 0.22;

/**
 * D1 (boats plan, approved 2026-10-26), part one: the fetch the spectrum
 * grows over, capped at full development. Below about 8 m/s of wind the
 * world's 120 km fetch is longer than the sea can use, and the uncapped
 * JONSWAP kept lengthening the peak past the Pierson-Moskowitz limit.
 */
export function oceanEffectiveFetchMeters(config: SpectralOceanConfig): number {
  const wind = Math.max(config.windSpeedMetersPerSecond, 0.05);
  return Math.min(
    config.fetchLengthMeters,
    (OCEAN_FULLY_DEVELOPED_FETCH * wind * wind) / config.gravityMetersPerSecondSquared,
  );
}

function rawSpectrumParameters(
  config: SpectralOceanConfig,
  cascadeIndex: number,
  fetchLength: number,
  energyScale: number,
): OceanSpectrumParameters {
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  return {
    gravity: config.gravityMetersPerSecondSquared,
    windSpeed: config.windSpeedMetersPerSecond,
    fetchLength,
    windDirectionX: config.windDirection[0],
    windDirectionZ: config.windDirection[1],
    directionalSpread: config.directionalSpread,
    waterDepth: config.representativeDepthMeters,
    surfaceTensionOverDensity: config.surfaceTensionOverDensity,
    spectrumScale: cascade.spectrumScale * energyScale,
    minimumWavelength: cascade.minimumWavelengthMeters,
    maximumWavelength: cascade.maximumWavelengthMeters,
  };
}

/**
 * The height variance, m^2, a config's grid of waves carries on average:
 * `sum Psi(k) dk^2` over every cascade's grid (see
 * `oceanTransformNormalizationScale` for why that is the variance).
 */
export function oceanExpectedHeightVariance(
  config: SpectralOceanConfig,
  fetchLength = config.fetchLengthMeters,
  energyScale = 1,
): number {
  let variance = 0;
  for (let cascadeIndex = 0; cascadeIndex < config.cascades.length; cascadeIndex += 1) {
    const cascade = config.cascades[cascadeIndex]!;
    const params = rawSpectrumParameters(config, cascadeIndex, fetchLength, energyScale);
    const reach = oceanCascadeFrequencyReach(config, cascadeIndex);
    const low = reach >= config.resolution / 2 ? 1 - config.resolution / 2 : -reach;
    const cell = (TAU / cascade.patchLengthMeters) ** 2;
    let sum = 0;
    for (let fy = low; fy <= reach; fy += 1) {
      for (let fx = low; fx <= reach; fx += 1) {
        sum += oceanWaveDensity(params, cascade.patchLengthMeters, fx, fy);
      }
    }
    variance += sum * cell;
  }
  return variance;
}

const energyScaleCache = new Map<string, number>();
const ENERGY_SCALE_CACHE_SIZE = 16;

/**
 * D1 (boats plan, approved 2026-10-26), part two: the factor that holds the
 * drawn sea at or under the Pierson-Moskowitz height, `0.22 U^2 / g`.
 *
 * Capping the fetch fixes the peak but not the level: the spectrum's art
 * scales and its band windows still drew 0.92 m against 0.80 m at 6 m/s.
 * This measures the expected height of the CANONICAL sea (256 points, all
 * five shipped cascades, so the factor does not depend on quality tier) and
 * scales every cascade's energy by `min(1, (Hs_PM / Hs)^2)`. In a stronger
 * wind the fetch limits the sea first and the factor is exactly 1, so
 * nothing above about 10 m/s moves.
 */
export function oceanSeaStateEnergyScale(config: SpectralOceanConfig): number {
  const key = [
    config.windSpeedMetersPerSecond,
    config.fetchLengthMeters,
    config.gravityMetersPerSecondSquared,
    config.representativeDepthMeters,
    config.directionalSpread,
    config.surfaceTensionOverDensity,
    config.windDirection[0],
    config.windDirection[1],
  ].join("|");
  const cached = energyScaleCache.get(key);
  if (cached !== undefined) return cached;
  const canonical = resolveSpectralOceanConfig({
    resolution: 256,
    gravityMetersPerSecondSquared: config.gravityMetersPerSecondSquared,
    representativeDepthMeters: config.representativeDepthMeters,
    windSpeedMetersPerSecond: config.windSpeedMetersPerSecond,
    windDirection: config.windDirection,
    fetchLengthMeters: config.fetchLengthMeters,
    directionalSpread: config.directionalSpread,
    surfaceTensionOverDensity: config.surfaceTensionOverDensity,
  });
  const variance = oceanExpectedHeightVariance(canonical, oceanEffectiveFetchMeters(canonical));
  const wind = Math.max(config.windSpeedMetersPerSecond, 0.05);
  const limit = (OCEAN_FULLY_DEVELOPED_WAVE_HEIGHT * wind * wind)
    / config.gravityMetersPerSecondSquared;
  const height = 4 * Math.sqrt(variance);
  const scale = height > limit ? (limit / height) ** 2 : 1;
  if (energyScaleCache.size >= ENERGY_SCALE_CACHE_SIZE) {
    energyScaleCache.delete(energyScaleCache.keys().next().value!);
  }
  energyScaleCache.set(key, scale);
  return scale;
}

/**
 * One cascade's spectrum inputs, as the GPU's initialisation uniform carries
 * them: the config's own values with D1's fetch and energy caps applied.
 */
export function oceanSpectrumParameters(
  config: SpectralOceanConfig,
  cascadeIndex: number,
): OceanSpectrumParameters {
  return rawSpectrumParameters(
    config,
    cascadeIndex,
    oceanEffectiveFetchMeters(config),
    oceanSeaStateEnergyScale(config),
  );
}

/**
 * Directional JONSWAP over the wavevector, band-windowed and art-scaled: the
 * density `Psi(k)` in m^4 (`directionalJonswapSpectrum` in WGSL).
 */
export function oceanDirectionalSpectrum(
  params: OceanSpectrumParameters,
  kx: number,
  kz: number,
  wavenumber: number,
  omega: number,
): number {
  const gravity = params.gravity;
  const wind = Math.max(params.windSpeed, 0.05);
  const fetch = Math.max(params.fetchLength, 1);
  const omegaPeak = 22 * Math.pow((gravity * gravity) / (wind * fetch), 1 / 3);
  const alpha = 0.076 * Math.pow((wind * wind) / (fetch * gravity), 0.22);
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const peakDistance = (omega - omegaPeak) / Math.max(sigma * omegaPeak, 1e-5);
  const peakShape = Math.exp(-0.5 * peakDistance * peakDistance);
  const peakEnhancement = Math.pow(3.3, peakShape);
  const frequencySpectrum = alpha * gravity * gravity
    * Math.exp(-1.25 * Math.pow(omegaPeak / Math.max(omega, 1e-4), 4))
    * peakEnhancement / Math.max(Math.pow(omega, 5), 1e-8);

  const capillary = params.surfaceTensionOverDensity;
  const tanhDepth = oceanFiniteDepthFactor(wavenumber, params.waterDepth);
  const dispersionDerivative = Math.max(
    (gravity + 3 * capillary * wavenumber * wavenumber) * tanhDepth,
    1e-6,
  ) / Math.max(2 * omega, 1e-5);
  const windLength = Math.hypot(params.windDirectionX, params.windDirectionZ);
  const inverseK = 1 / Math.max(wavenumber, 1e-6);
  const aligned = (kx * inverseK) * (params.windDirectionX / windLength)
    + (kz * inverseK) * (params.windDirectionZ / windLength);
  const forwardLobe = Math.pow(Math.max(aligned, 0), params.directionalSpread);
  const opposingLobe = 0.04 * Math.pow(Math.max(-aligned, 0), params.directionalSpread * 0.5);
  const wavelength = TAU * inverseK;
  const radialJacobian = dispersionDerivative * inverseK;
  return Math.max(
    frequencySpectrum * radialJacobian * (forwardLobe + opposingLobe)
      * oceanBandWindow(wavelength, params.minimumWavelength, params.maximumWavelength)
      * params.spectrumScale,
    0,
  );
}

/** `Psi(k)` of one grid frequency, zero where the GPU's finite guard zeroes it. */
function oceanWaveDensity(
  params: OceanSpectrumParameters,
  patchLength: number,
  frequencyX: number,
  frequencyY: number,
): number {
  const scale = TAU / patchLength;
  const kx = scale * frequencyX;
  const kz = scale * frequencyY;
  const wavenumber = Math.hypot(kx, kz);
  if (wavenumber < 1e-6) return 0;
  const omega = oceanAngularFrequency(
    wavenumber,
    params.gravity,
    params.surfaceTensionOverDensity,
    params.waterDepth,
  );
  const density = oceanDirectionalSpectrum(params, kx, kz, wavenumber, omega);
  return Number.isFinite(density) ? density : 0;
}

/** One wave of one cascade, as the GPU's initial-spectrum texel holds it. */
export interface OceanWave {
  kx: number;
  kz: number;
  wavenumber: number;
  omega: number;
  /** `Psi(k)`, m^4. */
  spectrum: number;
  h0Re: number;
  h0Im: number;
}

export function createOceanWave(): OceanWave {
  return { kx: 0, kz: 0, wavenumber: 0, omega: 0, spectrum: 0, h0Re: 0, h0Im: 0 };
}

const gaussianScratch: [number, number] = [0, 0];

/**
 * The initial amplitude of grid frequency `(fx, fy)` of one cascade
 * (`initializeOceanSpectrum` in WGSL). Writes `out` and returns it; a zero
 * wavevector or a zero density leaves `h0 = 0`.
 */
export function oceanInitialWave(
  config: SpectralOceanConfig,
  params: OceanSpectrumParameters,
  cascadeIndex: number,
  frequencyX: number,
  frequencyY: number,
  out: OceanWave,
): OceanWave {
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const scale = TAU / cascade.patchLengthMeters;
  const kx = scale * frequencyX;
  const kz = scale * frequencyY;
  const wavenumber = Math.hypot(kx, kz);
  out.kx = kx;
  out.kz = kz;
  out.wavenumber = wavenumber;
  if (wavenumber < 1e-6) {
    out.omega = 0;
    out.spectrum = 0;
    out.h0Re = 0;
    out.h0Im = 0;
    return out;
  }
  const omega = oceanAngularFrequency(
    wavenumber,
    params.gravity,
    params.surfaceTensionOverDensity,
    params.waterDepth,
  );
  const density = oceanDirectionalSpectrum(params, kx, kz, wavenumber, omega);
  const spectrum = Number.isFinite(density) ? density : 0;
  const [re, im] = oceanGaussianComplex(
    oceanWaveSeed(config.seed, cascadeIndex, frequencyX, frequencyY),
    gaussianScratch,
  );
  const amplitude = Math.sqrt(0.5 * spectrum);
  out.omega = omega;
  out.spectrum = spectrum;
  out.h0Re = re * amplitude;
  out.h0Im = im * amplitude;
  return out;
}

/**
 * The grid frequencies a cascade's band window can make nonzero, as the largest
 * `|f|` on either axis. Every wave outside it has zero amplitude, so a CPU
 * consumer iterates `-reach..reach` instead of the whole grid.
 */
export function oceanCascadeFrequencyReach(config: SpectralOceanConfig, cascadeIndex: number): number {
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const lowWidth = Math.max(cascade.minimumWavelengthMeters * 0.18, 0.001);
  const shortest = Math.max(cascade.minimumWavelengthMeters - lowWidth, 1e-6);
  return Math.min(
    Math.ceil(cascade.patchLengthMeters / shortest),
    config.resolution / 2,
  );
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
