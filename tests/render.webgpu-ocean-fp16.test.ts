import { describe, expect, it } from "vitest";
import { buildOceanFftDispatches, resolveSpectralOceanConfig } from "../src/render/webgpu/nature/OceanConfig";

/**
 * 1B-13, assertion 28 — fp16 FFT intermediate bounds, on a CPU mirror of the
 * exact GPU chain (same hash, same JONSWAP, same Stockham stages, same
 * normalisation schedule). Every intermediate stage's peak magnitude must
 * stay under fp16's maximum (~65 504; bound 60 000 with headroom) and above
 * 1e-3 — folding the full 1/N² anywhere early drops the signal band to
 * 1.5e-6…1.5e-4, straddling the smallest fp16 normal (6.1e-5), and the
 * small waves silently vanish into banding.
 */

const TAU = Math.PI * 2;

function hash32(value: number): number {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  return (state ^ (state >>> 16)) >>> 0;
}

function random01(value: number): number {
  return (hash32(value) & 0x00ffffff) / 16777216;
}

function gaussianComplex(seed: number): [number, number] {
  const u1 = Math.max(random01(seed), 1e-7);
  const u2 = random01((seed ^ 0x9e3779b9) >>> 0);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = TAU * u2;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

interface SpectrumParams {
  readonly seed: number;
  readonly cascadeIndex: number;
  readonly resolution: number;
  readonly patchLengthMeters: number;
  readonly gravity: number;
  readonly windSpeed: number;
  readonly fetchLength: number;
  readonly windDirection: readonly [number, number];
  readonly spectrumScale: number;
  readonly directionalSpread: number;
  readonly waterDepth: number;
  readonly surfaceTensionOverDensity: number;
  readonly minimumWavelength: number;
  readonly maximumWavelength: number;
}

function signedFrequencyIndex(index: number, resolution: number): number {
  return index > resolution / 2 ? index - resolution : index;
}

function smoothstepValue(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

function jonswap(params: SpectrumParams, kx: number, kz: number, kLength: number, omega: number): number {
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
  const tanhDepth = Math.tanh(kLength * params.waterDepth);
  const dispersionDerivative = Math.max(
    (gravity + 3 * capillary * kLength * kLength) * tanhDepth,
    1e-6,
  ) / Math.max(2 * omega, 1e-5);
  const windLength = Math.hypot(params.windDirection[0], params.windDirection[1]) || 1;
  const aligned = (kx / Math.max(kLength, 1e-6)) * (params.windDirection[0] / windLength)
    + (kz / Math.max(kLength, 1e-6)) * (params.windDirection[1] / windLength);
  const forwardLobe = Math.pow(Math.max(aligned, 0), params.directionalSpread);
  const opposingLobe = 0.04 * Math.pow(Math.max(-aligned, 0), params.directionalSpread * 0.5);
  const wavelength = TAU / Math.max(kLength, 1e-6);
  const lowWidth = Math.max(params.minimumWavelength * 0.18, 0.001);
  const highWidth = Math.max(params.maximumWavelength * 0.18, 0.001);
  const band =
    smoothstepValue(params.minimumWavelength - lowWidth, params.minimumWavelength + lowWidth, wavelength)
    * (1 - smoothstepValue(params.maximumWavelength - highWidth, params.maximumWavelength + highWidth, wavelength));
  const radialJacobian = dispersionDerivative / Math.max(kLength, 1e-6);
  return Math.max(
    frequencySpectrum * radialJacobian * (forwardLobe + opposingLobe) * band * params.spectrumScale,
    0,
  );
}

/** transformA = [h.re, h.im, dx.re, dx.im]; transformB = [dz.re, dz.im, 0, 0]. */
function evolve(
  params: SpectrumParams,
  timeSeconds: number,
  choppiness: number,
): { a: Float64Array; b: Float64Array } {
  const n = params.resolution;
  const h0 = new Float64Array(n * n * 2);
  const waveK = new Float64Array(n * n * 3);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const kx = (TAU / params.patchLengthMeters) * signedFrequencyIndex(x, n);
      const kz = (TAU / params.patchLengthMeters) * signedFrequencyIndex(y, n);
      const kLength = Math.hypot(kx, kz);
      const index = x + y * n;
      if (kLength < 1e-6) continue;
      const gravityTerm = params.gravity * kLength;
      const capillaryTerm = params.surfaceTensionOverDensity * kLength ** 3;
      const omega = Math.sqrt(
        Math.max((gravityTerm + capillaryTerm) * Math.tanh(kLength * params.waterDepth), 0),
      );
      const spectrum = jonswap(params, kx, kz, kLength, omega);
      const seed = (params.seed ^ hash32((index + Math.imul(0x9e3779b9, params.cascadeIndex + 1)) >>> 0)) >>> 0;
      const [gr, gi] = gaussianComplex(seed);
      const amplitude = Math.sqrt(0.5 * spectrum);
      h0[index * 2] = gr * amplitude;
      h0[index * 2 + 1] = gi * amplitude;
      waveK[index * 3] = kx;
      waveK[index * 3 + 1] = kz;
      waveK[index * 3 + 2] = kLength;
    }
  }
  const a = new Float64Array(n * n * 4);
  const b = new Float64Array(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const index = x + y * n;
      const mirrored = ((n - x) % n) + ((n - y) % n) * n;
      const kLength = waveK[index * 3 + 2]!;
      if (kLength < 1e-6) continue;
      const gravityTerm = params.gravity * kLength;
      const capillaryTerm = params.surfaceTensionOverDensity * kLength ** 3;
      const omega = Math.sqrt(
        Math.max((gravityTerm + capillaryTerm) * Math.tanh(kLength * params.waterDepth), 0),
      );
      const phase = omega * timeSeconds;
      const cosPhase = Math.cos(phase);
      const sinPhase = Math.sin(phase);
      const hr = h0[index * 2]!;
      const hi = h0[index * 2 + 1]!;
      const mr = h0[mirrored * 2]!;
      const mi = -h0[mirrored * 2 + 1]!;
      const heightRe = hr * cosPhase - hi * sinPhase + (mr * cosPhase + mi * sinPhase);
      const heightIm = hr * sinPhase + hi * cosPhase + (-mr * sinPhase + mi * cosPhase);
      const hx = (waveK[index * 3]! / kLength) * choppiness;
      const hz = (waveK[index * 3 + 1]! / kLength) * choppiness;
      // height × (0, −h): (re, im) × i(−h) = (im·h, −re·h)
      a[index * 4] = heightRe;
      a[index * 4 + 1] = heightIm;
      a[index * 4 + 2] = heightIm * hx;
      a[index * 4 + 3] = -heightRe * hx;
      b[index * 4] = heightIm * hz;
      b[index * 4 + 1] = -heightRe * hz;
    }
  }
  return { a, b };
}

/** Mirrors stockhamInverseFft including the per-axis normalisation schedule. */
function runFftChain(
  resolution: number,
  a: Float64Array,
  b: Float64Array,
): { stageMaxima: number[]; heights: Float64Array } {
  const passes = buildOceanFftDispatches(resolution);
  let sourceA = a.slice();
  let sourceB = b.slice();
  let destinationA = new Float64Array(a.length);
  let destinationB = new Float64Array(b.length);
  const stageMaxima: number[] = [];
  for (const pass of passes) {
    const half = resolution / 2;
    for (let line = 0; line < resolution; line += 1) {
      for (let butterfly = 0; butterfly < half; butterfly += 1) {
        const radixSpan = 1 << pass.stage;
        const localIndex = butterfly & (radixSpan - 1);
        const blockIndex = butterfly >> pass.stage;
        const destination0 = blockIndex * radixSpan * 2 + localIndex;
        const destination1 = destination0 + radixSpan;
        const source0 = butterfly;
        const source1 = butterfly + half;
        const angle = TAU * localIndex / (radixSpan * 2);
        const tw: [number, number] = [Math.cos(angle), Math.sin(angle)];
        const texel = (transformIndex: number) => pass.axis === "horizontal"
          ? transformIndex + line * resolution
          : line + transformIndex * resolution;
        const normalization = pass.normalize ? 1 / resolution : 1;
        for (const [source, destination] of [
          [sourceA, destinationA],
          [sourceB, destinationB],
        ] as const) {
          const i0 = texel(source0) * 4;
          const i1 = texel(source1) * 4;
          // Rotate both complex pairs of the second input by the twiddle.
          const rotate = (re: number, im: number): [number, number] => (
            [re * tw[0] - im * tw[1], re * tw[1] + im * tw[0]]
          );
          const [p0r, p0i] = rotate(source[i1]!, source[i1 + 1]!);
          const [p1r, p1i] = rotate(source[i1 + 2]!, source[i1 + 3]!);
          const d0 = texel(destination0) * 4;
          const d1 = texel(destination1) * 4;
          destination[d0] = (source[i0]! + p0r) * normalization;
          destination[d0 + 1] = (source[i0 + 1]! + p0i) * normalization;
          destination[d0 + 2] = (source[i0 + 2]! + p1r) * normalization;
          destination[d0 + 3] = (source[i0 + 3]! + p1i) * normalization;
          destination[d1] = (source[i0]! - p0r) * normalization;
          destination[d1 + 1] = (source[i0 + 1]! - p0i) * normalization;
          destination[d1 + 2] = (source[i0 + 2]! - p1r) * normalization;
          destination[d1 + 3] = (source[i0 + 3]! - p1i) * normalization;
        }
      }
    }
    [sourceA, destinationA] = [destinationA, sourceA];
    [sourceB, destinationB] = [destinationB, sourceB];
    let maximum = 0;
    for (let index = 0; index < sourceA.length; index += 1) {
      maximum = Math.max(maximum, Math.abs(sourceA[index]!), Math.abs(sourceB[index]!));
    }
    stageMaxima.push(maximum);
  }
  const heights = new Float64Array(resolution * resolution);
  for (let index = 0; index < heights.length; index += 1) {
    heights[index] = sourceA[index * 4]!;
  }
  return { stageMaxima, heights };
}

describe("fp16 ocean FFT (1B-13, assertion 28)", () => {
  const config = resolveSpectralOceanConfig({ resolution: 256 });
  const paramsFor = (cascadeIndex: number): SpectrumParams => {
    const cascade = config.cascades[cascadeIndex]!;
    return {
      seed: 0x5eed0cea,
      cascadeIndex,
      resolution: 256,
      patchLengthMeters: cascade.patchLengthMeters,
      gravity: 9.81,
      windSpeed: config.windSpeedMetersPerSecond,
      fetchLength: config.fetchLengthMeters,
      windDirection: [Math.SQRT1_2, Math.SQRT1_2],
      spectrumScale: cascade.spectrumScale,
      directionalSpread: 6,
      waterDepth: 900,
      surfaceTensionOverDensity: 7.4e-5,
      minimumWavelength: cascade.minimumWavelengthMeters,
      maximumWavelength: cascade.maximumWavelengthMeters,
    };
  };
  // "Largest cascade" = the one carrying the most spectral energy at these
  // wind/fetch settings (the JONSWAP peak sits in the hundreds of metres, so
  // kilometre-patch cascades are near-empty and flush harmlessly). Pick it
  // by measured evolved magnitude rather than assuming.
  const energies = config.cascades.map((_, index) => {
    const { a } = evolve(paramsFor(index), 7.3, config.choppiness);
    let maximum = 0;
    for (let value = 0; value < a.length; value += 1) {
      maximum = Math.max(maximum, Math.abs(a[value]!));
    }
    return maximum;
  });
  const energeticIndex = energies.indexOf(Math.max(...energies));
  const params = paramsFor(energeticIndex);

  it("normalises the last stage of each axis (per-axis 1/N)", () => {
    const passes = buildOceanFftDispatches(256);
    const stages = Math.log2(256);
    expect(passes).toHaveLength(stages * 2);
    for (const [index, pass] of passes.entries()) {
      const isLastOfAxis = (index + 1) % stages === 0;
      expect(pass.normalize, `pass ${index} (${pass.axis} stage ${pass.stage})`).toBe(isLastOfAxis);
    }
  });

  it("keeps every intermediate stage inside fp16's usable range", () => {
    const { a, b } = evolve(params, 7.3, config.choppiness);
    const { stageMaxima, heights } = runFftChain(256, a, b);
    for (const [stage, maximum] of stageMaxima.entries()) {
      expect(maximum, `stage ${stage} upper bound`).toBeLessThan(60_000);
      expect(maximum, `stage ${stage} lower bound`).toBeGreaterThan(1e-3);
    }
    // Sanity: the surface came out — non-degenerate wave heights (the most
    // energetic cascade at these settings is the short-wave one, so peaks
    // are centimetre-scale).
    let peak = 0;
    for (const height of heights) peak = Math.max(peak, Math.abs(height));
    expect(peak).toBeGreaterThan(0.002);
    expect(peak).toBeLessThan(50);
  });

  it("would lose the signal band if 1/N² were folded into the first pass", () => {
    // The trap the plan warns about, demonstrated: early full normalisation
    // pushes intermediates below fp16's smallest normal territory.
    const { a, b } = evolve(params, 7.3, config.choppiness);
    for (let index = 0; index < a.length; index += 1) {
      a[index]! /= 256 * 256;
      b[index]! /= 256 * 256;
    }
    const { stageMaxima } = runFftChain(256, a, b);
    // Undo the double-normalisation the chain itself applies for comparison:
    // the first stages now carry the fully normalised (tiny) magnitudes.
    expect(stageMaxima[0]!).toBeLessThan(1e-3);
  });
});
