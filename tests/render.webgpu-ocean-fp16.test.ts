import { describe, expect, it } from "vitest";
import {
  buildOceanFftDispatches,
  oceanTransformNormalizationScale,
  resolveSpectralOceanConfig,
} from "../src/render/webgpu/nature/OceanConfig";

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

/**
 * Mirrors stockhamInverseFft including the per-axis normalisation schedule.
 *
 * wave R: `normalizationScale` is the factor the shader's last stage of each
 * axis applies. It is `oceanTransformNormalizationScale(patchLength)` in the
 * shipping chain and 1/N in the pre-wave-R one, which the deficit test below
 * still exercises as its negative control.
 */
function runFftChain(
  resolution: number,
  a: Float64Array,
  b: Float64Array,
  normalizationScale: number,
): { stageMaxima: number[]; heights: Float64Array; displacements: Float64Array } {
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
        const normalization = pass.normalize ? normalizationScale : 1;
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
  // wave R: (displacementX, displacementZ) per texel, the pair the derivation
  // shader differences into the horizontal Jacobian that drives foam.
  const displacements = new Float64Array(resolution * resolution * 2);
  for (let index = 0; index < heights.length; index += 1) {
    heights[index] = sourceA[index * 4]!;
    displacements[index * 2] = sourceA[index * 4 + 2]!;
    displacements[index * 2 + 1] = sourceB[index * 4]!;
  }
  return { stageMaxima, heights, displacements };
}

/**
 * wave R: the derivation shader's horizontal Jacobian, texel for texel —
 * central differences over one texel each way, then
 * `(1 + dDx/dx)(1 + dDz/dz) - (dDz/dx)(dDx/dz)`. Foam is
 * `clamp((foamThreshold - jacobian) * foamGain, 0, 1)` on this field, so the
 * fraction of texels below a threshold IS the whitecap coverage.
 */
function jacobianField(
  displacements: Float64Array,
  resolution: number,
  texelLengthMeters: number,
): Float64Array {
  const inverseWidth = 0.5 / Math.max(texelLengthMeters, 1e-5);
  const wrap = (value: number): number => ((value % resolution) + resolution) % resolution;
  const field = new Float64Array(resolution * resolution);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const at = (column: number, row: number): number => (wrap(column) + wrap(row) * resolution) * 2;
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const down = at(x, y - 1);
      const up = at(x, y + 1);
      const dxDx = (displacements[right]! - displacements[left]!) * inverseWidth;
      const dzDx = (displacements[right + 1]! - displacements[left + 1]!) * inverseWidth;
      const dxDz = (displacements[up]! - displacements[down]!) * inverseWidth;
      const dzDz = (displacements[up + 1]! - displacements[down + 1]!) * inverseWidth;
      field[x + y * resolution] = (1 + dxDx) * (1 + dzDz) - dzDx * dxDz;
    }
  }
  return field;
}

function fractionBelow(field: Float64Array, threshold: number): number {
  let below = 0;
  for (const value of field) if (value < threshold) below += 1;
  return below / field.length;
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

  const scaleFor = (cascadeIndex: number): number => oceanTransformNormalizationScale(
    config.cascades[cascadeIndex]!.patchLengthMeters,
  );

  it("normalises the last stage of each axis", () => {
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
    const { stageMaxima, heights } = runFftChain(256, a, b, scaleFor(energeticIndex));
    for (const [stage, maximum] of stageMaxima.entries()) {
      expect(maximum, `stage ${stage} upper bound`).toBeLessThan(60_000);
      expect(maximum, `stage ${stage} lower bound`).toBeGreaterThan(1e-3);
    }
    // wave R widened this from the single most energetic cascade to ALL of
    // them, because it can now: with the cell measure in place the smallest
    // stage magnitude across every cascade rises from 3.6e-5 — under fp16's
    // 6.1e-5 smallest normal, i.e. cascade 0's whole transform was living in
    // subnormals — to 6.8e-2, while the largest is unchanged at 77.2.
    for (let index = 0; index < config.cascades.length; index += 1) {
      const cascade = config.cascades[index]!;
      // The kilometre-patch cascades sit outside the JONSWAP peak at this
      // fetch and legitimately flush to nothing; only bound the ones the
      // spectrum actually fills.
      const evolved = evolve(paramsFor(index), 7.3, config.choppiness);
      const { stageMaxima: maxima } = runFftChain(256, evolved.a, evolved.b, scaleFor(index));
      const smallest = Math.min(...maxima);
      const largest = Math.max(...maxima);
      expect(largest, `cascade ${index} (L=${cascade.patchLengthMeters}) upper bound`)
        .toBeLessThan(60_000);
      if (largest > 1e-3) {
        expect(smallest, `cascade ${index} (L=${cascade.patchLengthMeters}) lower bound`)
          .toBeGreaterThan(6.1e-5);
      }
    }
    // Sanity: the surface came out. wave R restored the spectral cell measure
    // the chain never applied, so these are metres of real sea rather than the
    // centimetre-scale field the 1/N² convention produced.
    let peak = 0;
    for (const height of heights) peak = Math.max(peak, Math.abs(height));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(50);
  });

  it("splits the scale across the axes rather than folding it into the first pass", () => {
    // The trap the plan warns about: normalising up front drags every early
    // stage down by the WHOLE factor instead of half of it. wave R made the
    // factor a per-cascade physical constant rather than 1/N², so the trap is
    // no longer a fixed 1/65,536 — it is stated relatively here, against the
    // shipping split, which is what the schedule actually protects.
    const scale = scaleFor(energeticIndex);
    const split = runFftChain(256, ...(() => {
      const { a, b } = evolve(params, 7.3, config.choppiness);
      return [a, b] as const;
    })(), scale);
    const { a, b } = evolve(params, 7.3, config.choppiness);
    for (let index = 0; index < a.length; index += 1) {
      a[index]! *= scale * scale;
      b[index]! *= scale * scale;
    }
    const early = runFftChain(256, a, b, 1);
    expect(early.stageMaxima[0]!).toBeLessThan(split.stageMaxima[0]! * scale * 1.001);
    // Both orderings land on the same output — it is only the intermediates,
    // and therefore only fp16, that care.
    let difference = 0;
    for (let index = 0; index < early.heights.length; index += 1) {
      difference = Math.max(difference, Math.abs(early.heights[index]! - split.heights[index]!));
    }
    expect(difference).toBeLessThan(1e-9);
  });

  it("would leave cascade 0 in fp16 subnormals under the retired 1/N convention", () => {
    // wave R's measured defect, kept as a negative control. Before the cell
    // measure landed, the per-axis factor was 1/N and the finest cascade's
    // whole transform lived at ~3.6e-5 — under fp16's 6.1e-5 smallest normal,
    // where the format has four or five bits of mantissa left. That is why the
    // near-field sea rendered as a mirror with a normal map painted on it.
    const retired = runFftChain(
      256,
      ...(() => {
        const { a, b } = evolve(paramsFor(0), 7.3, config.choppiness);
        return [a, b] as const;
      })(),
      1 / 256,
    );
    expect(Math.min(...retired.stageMaxima)).toBeLessThan(6.1e-5);
    const restored = runFftChain(
      256,
      ...(() => {
        const { a, b } = evolve(paramsFor(0), 7.3, config.choppiness);
        return [a, b] as const;
      })(),
      scaleFor(0),
    );
    expect(Math.min(...restored.stageMaxima)).toBeGreaterThan(6.1e-5);
    // ...and the sea it produced was centimetres, not metres.
    let retiredPeak = 0;
    let restoredPeak = 0;
    for (let index = 0; index < retired.heights.length; index += 1) {
      retiredPeak = Math.max(retiredPeak, Math.abs(retired.heights[index]!));
      restoredPeak = Math.max(restoredPeak, Math.abs(restored.heights[index]!));
    }
    expect(retiredPeak).toBeLessThan(0.001);
    expect(restoredPeak).toBeGreaterThan(0.05);
  });

  it("carries the spectral cell measure, so the sea is metres and foam is reachable", () => {
    // wave R, the measurement behind both the normalisation change and the
    // foam retune. `h0 = g * sqrt(0.5 * Psi)` stores a spectral DENSITY; the
    // discrete sum needs the per-cell variance `Psi * dk^2`, and the +/-k
    // pairing doubles it, so the transform scale is `dk / sqrt(2)`. The
    // shipped chain used 1/N² — no cell measure at all.
    const windSpeed = 11;
    const windy = resolveSpectralOceanConfig({ resolution: 256, windSpeedMetersPerSecond: windSpeed });
    const windyParams = (cascadeIndex: number): SpectrumParams => ({
      ...paramsFor(cascadeIndex),
      windSpeed,
      spectrumScale: windy.cascades[cascadeIndex]!.spectrumScale,
    });

    let heightVariance = 0;
    const coverage: number[] = [];
    for (let index = 0; index < windy.cascades.length; index += 1) {
      const cascade = windy.cascades[index]!;
      const { a, b } = evolve(windyParams(index), 7.3, windy.choppiness);
      const { heights, displacements } = runFftChain(
        256,
        a,
        b,
        oceanTransformNormalizationScale(cascade.patchLengthMeters),
      );
      let sum = 0;
      for (const height of heights) sum += height * height;
      heightVariance += sum / heights.length;
      const jacobian = jacobianField(displacements, 256, cascade.patchLengthMeters / 256);
      coverage.push(fractionBelow(jacobian, windy.foamThreshold));
      // The pre-wave-R threshold is unreachable at ANY amplitude that renders
      // as a sea: it asks the Jacobian to fall from a mean of 1 to 0.22.
      expect(fractionBelow(jacobian, 0.22)).toBe(0);
    }

    // A real sea at 11 m/s over a 120 km fetch: significant wave height (4
    // sigma) of a couple of metres, against the 0.02 m the shipped chain
    // produced. The band is wide because spectrumScale is art-directed.
    const significantWaveHeight = 4 * Math.sqrt(heightVariance);
    expect(significantWaveHeight).toBeGreaterThan(1);
    expect(significantWaveHeight).toBeLessThan(5);

    // Sparse whitecaps, not a rash and not nothing. Monahan's law puts real
    // whitecap coverage near 1.4% at this wind speed.
    const wettest = Math.max(...coverage);
    expect(wettest).toBeGreaterThan(0.002);
    expect(wettest).toBeLessThan(0.09);

    // And it responds to wind: halve the wind and the coverage collapses.
    const calm = resolveSpectralOceanConfig({ resolution: 256, windSpeedMetersPerSecond: 3.5 });
    const calmCoverage = calm.cascades.map((cascade, index) => {
      const { a, b } = evolve(
        { ...paramsFor(index), windSpeed: 3.5, spectrumScale: cascade.spectrumScale },
        7.3,
        calm.choppiness,
      );
      const { displacements } = runFftChain(
        256,
        a,
        b,
        oceanTransformNormalizationScale(cascade.patchLengthMeters),
      );
      return fractionBelow(
        jacobianField(displacements, 256, cascade.patchLengthMeters / 256),
        calm.foamThreshold,
      );
    });
    expect(Math.max(...calmCoverage)).toBeLessThan(wettest * 0.75);
  });
});
