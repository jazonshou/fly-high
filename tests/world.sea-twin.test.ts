import { describe, expect, it } from "vitest";
import type { QualityLevel, RequestedRenderingMode, WeatherPreset } from "@/src/game/types";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { resolveSeaSpectrumConfig, type SeaWorld } from "@/src/sim/water/seaState";
import { createSeaTwin, OceanPhaseClock, SeaTwin } from "@/src/sim/water/seaTwin";
import { packSeaShelterEllipses, seaShelterFactor, seaShelterField } from "@/src/sim/water/shelter";
import {
  createOceanWave,
  oceanInitialWave,
  oceanSignedFrequencyIndex,
  oceanSpectrumParameters,
  oceanTransformNormalizationScale,
  oceanWavePhaseIndex,
} from "@/src/sim/water/spectrum";
import type { SpectralOceanConfig } from "@/src/sim/water/spectrumConfig";
import {
  createWaterSurfaceSample,
  type SeaShelterEllipse,
  type WaterSurfaceSample,
  type WaveFieldFocus,
} from "@/src/sim/water/types";
import { referenceKernelMilliseconds, referenceSlowdown, warmReferenceKernel } from "./support/referenceKernel";

// The shipping world's sea inputs (the perf baselines' seed and wind).
const SEA_WORLD: SeaWorld & { readonly seaLevel: number } = Object.freeze({
  sourceSeedHash: 0x4f434541,
  prevailingWindRadians: 4.2243797,
  prevailingWindSpeed: 9.62323060631752,
  seaLevel: 0,
});

/** In-place 2D inverse DFT (`e^{+i}`, no scaling) of an `n x n` grid, x fastest. */
function inverseFft2d(re: Float64Array, im: Float64Array, n: number): void {
  const lineRe = new Float64Array(n);
  const lineIm = new Float64Array(n);
  const transform = () => {
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [lineRe[i], lineRe[j]] = [lineRe[j]!, lineRe[i]!];
        [lineIm[i], lineIm[j]] = [lineIm[j]!, lineIm[i]!];
      }
    }
    for (let span = 2; span <= n; span <<= 1) {
      const angle = (2 * Math.PI) / span;
      for (let start = 0; start < n; start += span) {
        for (let k = 0; k < span / 2; k += 1) {
          const c = Math.cos(angle * k);
          const s = Math.sin(angle * k);
          const a = start + k;
          const b = a + span / 2;
          const tRe = lineRe[b]! * c - lineIm[b]! * s;
          const tIm = lineRe[b]! * s + lineIm[b]! * c;
          lineRe[b] = lineRe[a]! - tRe;
          lineIm[b] = lineIm[a]! - tIm;
          lineRe[a] = lineRe[a]! + tRe;
          lineIm[a] = lineIm[a]! + tIm;
        }
      }
    }
  };
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      lineRe[x] = re[x + y * n]!;
      lineIm[x] = im[x + y * n]!;
    }
    transform();
    for (let x = 0; x < n; x += 1) {
      re[x + y * n] = lineRe[x]!;
      im[x + y * n] = lineIm[x]!;
    }
  }
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < n; y += 1) {
      lineRe[y] = re[x + y * n]!;
      lineIm[y] = im[x + y * n]!;
    }
    transform();
    for (let y = 0; y < n; y += 1) {
      re[x + y * n] = lineRe[y]!;
      im[x + y * n] = lineIm[y]!;
    }
  }
}

/**
 * The CPU mirror of one GPU cascade: the initial spectrum on every texel, the
 * evolution shader's `h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}` (w as its f32
 * texel holds it) with `D = -i lambda k^ h`, and the inverse FFT with the
 * per-axis normalisation squared. Returns the real height and displacement on
 * the texel grid, x fastest.
 */
function mirrorCascade(config: SpectralOceanConfig, cascade: number, time: number) {
  const n = config.resolution;
  const params = oceanSpectrumParameters(config, cascade);
  const wave = createOceanWave();
  const h0Re = new Float64Array(n * n);
  const h0Im = new Float64Array(n * n);
  const omega = new Float64Array(n * n);
  const hatX = new Float64Array(n * n);
  const hatZ = new Float64Array(n * n);
  for (let v = 0; v < n; v += 1) {
    for (let u = 0; u < n; u += 1) {
      const index = u + v * n;
      oceanInitialWave(config, params, cascade, oceanSignedFrequencyIndex(u, n), oceanSignedFrequencyIndex(v, n), wave);
      h0Re[index] = wave.h0Re;
      h0Im[index] = wave.h0Im;
      omega[index] = Math.fround(wave.omega);
      const wavenumber = Math.hypot(wave.kx, wave.kz);
      hatX[index] = wavenumber > 1e-6 ? wave.kx / wavenumber : 0;
      hatZ[index] = wavenumber > 1e-6 ? wave.kz / wavenumber : 0;
    }
  }
  const hRe = new Float64Array(n * n);
  const hIm = new Float64Array(n * n);
  const xRe = new Float64Array(n * n);
  const xIm = new Float64Array(n * n);
  const zRe = new Float64Array(n * n);
  const zIm = new Float64Array(n * n);
  for (let v = 0; v < n; v += 1) {
    for (let u = 0; u < n; u += 1) {
      const index = u + v * n;
      const mirrored = ((n - u) % n) + ((n - v) % n) * n;
      const c = Math.cos(omega[index]! * time);
      const s = Math.sin(omega[index]! * time);
      const aRe = h0Re[mirrored]!;
      const aIm = -h0Im[mirrored]!;
      const re = h0Re[index]! * c - h0Im[index]! * s + aRe * c + aIm * s;
      const im = h0Re[index]! * s + h0Im[index]! * c - aRe * s + aIm * c;
      hRe[index] = re;
      hIm[index] = im;
      const lx = hatX[index]! * config.choppiness;
      const lz = hatZ[index]! * config.choppiness;
      xRe[index] = im * lx;
      xIm[index] = -re * lx;
      zRe[index] = im * lz;
      zIm[index] = -re * lz;
    }
  }
  inverseFft2d(hRe, hIm, n);
  inverseFft2d(xRe, xIm, n);
  inverseFft2d(zRe, zIm, n);
  const scale = oceanTransformNormalizationScale(config.cascades[cascade]!.patchLengthMeters) ** 2;
  return {
    texel: config.cascades[cascade]!.patchLengthMeters / n,
    h: hRe.map((value) => value * scale),
    dx: xRe.map((value) => value * scale),
    dz: zRe.map((value) => value * scale),
  };
}

/** A hull point `along` metres ahead and `across` to starboard of the focus. */
function hullPoint(focus: WaveFieldFocus, along: number, across: number): [number, number] {
  const sine = Math.sin(focus.heading);
  const cosine = Math.cos(focus.heading);
  return [focus.x + along * sine + across * cosine, focus.z + along * cosine - across * sine];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function snapshot(sample: WaterSurfaceSample): number[] {
  return [
    sample.height, sample.normal.x, sample.normal.y, sample.normal.z,
    sample.velocity.x, sample.velocity.y, sample.velocity.z, sample.depth,
  ];
}

/** The SeaTwin step budget: 171 hull samples at 120 Hz, on the tuning box. */
const STEP_BUDGET_MILLISECONDS = 0.15;
// On the tuning box one open-water step costs 0.8-0.9 reference kernels
// (tests/support/referenceKernel.ts).

describe("sea twin", () => {
  it("sums the same sea as an FFT of the GPU's spectrum, within 0.1 mm", () => {
    const config = resolveSeaSpectrumConfig(SEA_WORLD, "breezy");
    // Every wave, so the sum and the transform hold the same modes.
    const twin = new SeaTwin(config, { seaLevel: 0, keptVariance: 1, amplitudeFloorMeters: 0 });
    const time = 1234.5678;
    twin.setTime(time);
    const mirrors = [1, 2, 3, 4].map((cascade) => mirrorCascade(config, cascade, time));
    // Points on every cascade's texel lattice (multiples of 64 m), near and far.
    const spacing = mirrors[3]!.texel;
    const random = createRandom(7);
    let worst = 0;
    let largest = 0;
    for (let point = 0; point < 24; point += 1) {
      const i = Math.floor(random() * 4096) - 2048;
      const j = Math.floor(random() * 4096) - 2048;
      const x = i * spacing;
      const z = j * spacing;
      let h = 0;
      let dx = 0;
      let dz = 0;
      for (const mirror of mirrors) {
        const n = config.resolution;
        const u = ((Math.round(x / mirror.texel) % n) + n) % n;
        const v = ((Math.round(z / mirror.texel) % n) + n) % n;
        h += mirror.h[u + v * n]!;
        dx += mirror.dx[u + v * n]!;
        dz += mirror.dz[u + v * n]!;
      }
      const twinFields = twin.exactLabelHeight(x, z);
      worst = Math.max(worst, Math.abs(twinFields.h - h), Math.abs(twinFields.dx - dx), Math.abs(twinFields.dz - dz));
      largest = Math.max(largest, Math.abs(h));
    }
    expect(largest).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(1e-4);
  });

  it("keeps every wave's phase within 1e-6 rad of exact over an hour", () => {
    const random = createRandom(11);
    const count = 200;
    const omega = Float64Array.from({ length: count }, () => 0.1 + 3.9 * random());
    const clock = new OceanPhaseClock(omega, new Float64Array(count).fill(1), new Float64Array(count));
    let time = 0;
    clock.setTime(time);
    let worst = 0;
    let magnitude = 0;
    for (let step = 1; step <= 3600 * 120; step += 1) {
      time += 1 / 120;
      clock.setTime(time);
      if (step % 6000 !== 0 && step !== 3600 * 120 && step > 240) continue;
      for (let index = 0; index < count; index += 1) {
        const c = Math.cos(omega[index]! * time);
        const s = Math.sin(omega[index]! * time);
        const re = clock.re[index]!;
        const im = clock.im[index]!;
        worst = Math.max(worst, Math.abs(Math.atan2(im * c - re * s, re * c + im * s)));
        magnitude = Math.max(magnitude, Math.abs(Math.hypot(re, im) - 1));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(magnitude).toBeLessThan(1e-9);
  });

  it("answers the same at every quality tier's ocean resolution", () => {
    const qualities: QualityLevel[] = ["low", "medium", "high"];
    const modes: RequestedRenderingMode[] = ["performance", "balanced", "ultra"];
    const run = (twin: SeaTwin): number[] => {
      const focus: WaveFieldFocus = { x: 812, z: -390, heading: 2.1, halfLength: 3.4, halfBeam: 1.4 };
      const out = createWaterSurfaceSample();
      const values: number[] = [];
      let time = 431.25;
      for (let step = 0; step < 24; step += 1) {
        time += 1 / 120;
        focus.x += 0.05;
        twin.setTime(time);
        twin.setFocus(focus);
        for (const [along, across] of [[-3, -1], [0, 0], [3.2, 1.3], [1, -1.4], [-2.5, 0.7]] as const) {
          values.push(...snapshot(twin.sample(...hullPoint(focus, along, across), out)));
        }
      }
      values.push(...snapshot(twin.sample(focus.x + 400, focus.z - 90, out)));
      return values;
    };
    const canonical = run(createSeaTwin(SEA_WORLD, "breezy"));
    const resolutions = new Set<number>();
    for (const quality of qualities) {
      for (const mode of modes) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        resolutions.add(profile.oceanResolution);
        const config = resolveSeaSpectrumConfig(SEA_WORLD, "breezy", profile.oceanResolution);
        expect(run(new SeaTwin(config, { seaLevel: 0 }))).toEqual(canonical);
      }
    }
    expect([...resolutions].sort()).toEqual([128, 256]);
  });

  it("floats on tier 1's waves bit for bit, with tier 1's h0 keyed as it always was", () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    expect(profile.oceanResolution).toBe(128);
    const tier = resolveSeaSpectrumConfig(SEA_WORLD, "breezy", profile.oceanResolution);
    const canonical = resolveSeaSpectrumConfig(SEA_WORLD, "breezy");
    const drawn = createOceanWave();
    const floated = createOceanWave();
    let mismatched = 0;
    let nonzero = 0;
    let rekeyed = 0;
    for (let cascade = 1; cascade < profile.oceanCascades; cascade += 1) {
      const tierParams = oceanSpectrumParameters(tier, cascade);
      const canonicalParams = oceanSpectrumParameters(canonical, cascade);
      for (let v = 0; v < 128; v += 1) {
        for (let u = 0; u < 128; u += 1) {
          const fx = oceanSignedFrequencyIndex(u, 128);
          const fy = oceanSignedFrequencyIndex(v, 128);
          // The 128-point FFT always hashed its texel index; it still does.
          if (oceanWavePhaseIndex(fx, fy) !== u + v * 128) rekeyed += 1;
          oceanInitialWave(tier, tierParams, cascade, fx, fy, drawn);
          oceanInitialWave(canonical, canonicalParams, cascade, fx, fy, floated);
          if (drawn.h0Re !== floated.h0Re || drawn.h0Im !== floated.h0Im) mismatched += 1;
          if (drawn.spectrum > 0) nonzero += 1;
        }
      }
    }
    expect({ mismatched, rekeyed }).toEqual({ mismatched: 0, rekeyed: 0 });
    expect(nonzero).toBeGreaterThan(5_000);
  });

  it("matches its exact sum on a hull at rest, cruising and planing, in every weather", () => {
    // Height rms and worst, normal, heave and flow (m, m/s). The second-order
    // expansion of the 32-128 m band and the choppy inversion at steep crests
    // set these; measured worst over 0, 6 and 20 m/s (Clear 2.6/11.6 mm,
    // Breezy 4.5/26 mm, Cloudy 8.7/62 mm, against a Cloudy sea of about 3 m),
    // with headroom. The exact sum itself is within 2.6 mm rms of a fully
    // converged inversion in Cloudy.
    const tolerance: Record<WeatherPreset, readonly [number, number, number, number, number]> = {
      clear: [0.004, 0.016, 0.013, 0.03, 0.06],
      breezy: [0.0065, 0.036, 0.02, 0.085, 0.1],
      cloudy: [0.012, 0.085, 0.04, 0.16, 0.2],
    };
    for (const weather of ["clear", "breezy", "cloudy"] as WeatherPreset[]) {
      for (const speed of [0, 6, 20]) {
        const twin = createSeaTwin(SEA_WORLD, weather);
        const focus: WaveFieldFocus = { x: 1234.5, z: -987.25, heading: 0.7, halfLength: 3.4, halfBeam: 1.4 };
        const fast = createWaterSurfaceSample();
        const exact = createWaterSurfaceSample();
        const random = createRandom(speed + 3);
        let time = 100;
        let worstHeight = 0;
        let sumSquares = 0;
        let count = 0;
        let worstNormal = 0;
        let worstHeave = 0;
        let worstFlow = 0;
        for (let step = 0; step < 240; step += 1) {
          time += 1 / 120;
          focus.x += (speed / 120) * Math.sin(focus.heading);
          focus.z += (speed / 120) * Math.cos(focus.heading);
          focus.heading += 0.15 / 120;
          twin.setTime(time);
          twin.setFocus(focus);
          // Every grid age and expansion age is visited over 240 steps.
          if (step % 3 !== 0) continue;
          for (let point = 0; point < 6; point += 1) {
            const [x, z] = hullPoint(focus, (random() * 2 - 1) * 3.4, (random() * 2 - 1) * 1.4);
            twin.sample(x, z, fast);
            twin.sampleExact(x, z, exact);
            const error = Math.abs(fast.height - exact.height);
            worstHeight = Math.max(worstHeight, error);
            sumSquares += error * error;
            count += 1;
            worstNormal = Math.max(worstNormal, Math.hypot(fast.normal.x - exact.normal.x, fast.normal.z - exact.normal.z));
            worstHeave = Math.max(worstHeave, Math.abs(fast.velocity.y - exact.velocity.y));
            worstFlow = Math.max(worstFlow, Math.hypot(fast.velocity.x - exact.velocity.x, fast.velocity.z - exact.velocity.z));
          }
        }
        const label = `${weather} at ${speed} m/s`;
        const [rms, worst, normal, heave, flow] = tolerance[weather];
        expect(Math.sqrt(sumSquares / count), label).toBeLessThan(rms);
        expect(worstHeight, label).toBeLessThan(worst);
        expect(worstNormal, label).toBeLessThan(normal);
        expect(worstHeave, label).toBeLessThan(heave);
        expect(worstFlow, label).toBeLessThan(flow);
      }
    }
  });

  it("rebuilds its sea at the same sim time when the weather changes", () => {
    const time = 77.125;
    const switched = createSeaTwin(SEA_WORLD, "breezy");
    switched.setTime(time);
    const cloudy = resolveSeaSpectrumConfig(SEA_WORLD, "cloudy");
    switched.setConfig(cloudy);
    const fresh = createSeaTwin(SEA_WORLD, "cloudy");
    fresh.setTime(time);
    const a = createWaterSurfaceSample();
    const b = createWaterSurfaceSample();
    for (const [x, z] of [[0, 0], [130.5, -77.25], [-4000, 2500]] as const) {
      expect(snapshot(switched.sampleExact(x, z, a))).toEqual(snapshot(fresh.sampleExact(x, z, b)));
    }
    expect(switched.spectrumConfig).toBe(cloudy);
  });

  it("reads the bed once per footprint, not once per hull sample", () => {
    let reads = 0;
    // A sloping bed: bilinear interpolation reproduces it exactly.
    const bedHeight = (x: number, z: number) => {
      reads += 1;
      return -6 + 0.02 * x - 0.03 * z;
    };
    const twin = createSeaTwin(SEA_WORLD, "breezy", bedHeight);
    const focus: WaveFieldFocus = { x: 10, z: 20, heading: 0.3, halfLength: 3.4, halfBeam: 1.4 };
    const out = createWaterSurfaceSample();
    let time = 5;
    let worstDepth = 0;
    for (let step = 0; step < 120; step += 1) {
      time += 1 / 120;
      focus.x += 0.001;
      twin.setTime(time);
      twin.setFocus(focus);
      for (let point = 0; point < 171; point += 1) {
        const [x, z] = hullPoint(focus, -3.4 + (6.8 * point) / 170, ((point % 7) - 3) * 0.45);
        twin.sample(x, z, out);
        expect(out.kind).toBe("sea");
        worstDepth = Math.max(worstDepth, Math.abs(out.depth - (6 - 0.02 * x + 0.03 * z)));
      }
    }
    // One 4 x 3 grid for the whole drift of 12 cm.
    expect(reads).toBe(12);
    expect(worstDepth).toBeLessThan(1e-9);
    // Dry ground under the hull is "none", as the calm surface reports it.
    const beached = createSeaTwin(SEA_WORLD, "breezy", () => 1.5);
    beached.setTime(time);
    beached.setFocus(focus);
    beached.sample(focus.x, focus.z, out);
    expect([out.kind, out.depth, out.height]).toEqual(["none", 0, 1.5]);
  });

  it("gives the heave of the cascades a tier does not draw", () => {
    const twin = new SeaTwin(resolveSeaSpectrumConfig(SEA_WORLD, "cloudy"), {
      seaLevel: 0,
      keptVariance: 1,
      amplitudeFloorMeters: 0,
    });
    const config = twin.spectrumConfig;
    const focus: WaveFieldFocus = { x: -321.5, z: 640.25, heading: 1, halfLength: 3.4, halfBeam: 1.4 };
    const time = 52.5;
    twin.setTime(time);
    twin.setFocus(focus);
    const wave = createOceanWave();
    const direct = (cascades: readonly number[]) => {
      let height = 0;
      for (const cascade of cascades) {
        const params = oceanSpectrumParameters(config, cascade);
        const scale = oceanTransformNormalizationScale(config.cascades[cascade]!.patchLengthMeters) ** 2;
        for (let fy = -64; fy <= 64; fy += 1) {
          for (let fx = -64; fx <= 64; fx += 1) {
            oceanInitialWave(config, params, cascade, fx, fy, wave);
            if (wave.spectrum <= 0) continue;
            const phase = wave.kx * focus.x + wave.kz * focus.z + Math.fround(wave.omega) * time;
            height += 2 * scale * (wave.h0Re * Math.cos(phase) - wave.h0Im * Math.sin(phase));
          }
        }
      }
      return height;
    };
    // Tier 0 draws three cascades, tier 1 four, tiers 2 and 3 all five.
    const undrawn = direct([3, 4]);
    expect(Math.abs(undrawn)).toBeGreaterThan(1e-3);
    expect(twin.undrawnHeave(3)).toBeCloseTo(undrawn, 6);
    expect(twin.undrawnHeave(4)).toBeCloseTo(direct([4]), 6);
    expect(twin.undrawnHeave(5)).toBe(0);
  });

  it("runs a 120 Hz hull step of 171 samples in under 0.15 ms", () => {
    warmReferenceKernel();
    const measure = (weather: WeatherPreset, speed: number, shelter: readonly SeaShelterEllipse[]) => {
      const twin = createSeaTwin(SEA_WORLD, weather, (x, z) => -8 + 0.001 * x + 0.001 * z);
      twin.setShelter(shelter);
      const focus: WaveFieldFocus = { x: 40, z: -25, heading: 0.4, halfLength: 3.4, halfBeam: 1.4 };
      const random = createRandom(5);
      const points = Array.from({ length: 171 }, () => [(random() * 2 - 1) * 3.4, (random() * 2 - 1) * 1.4] as const);
      const out = createWaterSurfaceSample();
      let time = 300;
      const step = () => {
        time += 1 / 120;
        focus.x += (speed / 120) * Math.sin(focus.heading);
        focus.z += (speed / 120) * Math.cos(focus.heading);
        focus.heading += 0.1 / 120;
        twin.setTime(time);
        twin.setFocus(focus);
        const sine = Math.sin(focus.heading);
        const cosine = Math.cos(focus.heading);
        for (const [along, across] of points) {
          twin.sample(focus.x + along * sine + across * cosine, focus.z + along * cosine - across * sine, out);
        }
      };
      for (let warm = 0; warm < 480; warm += 1) step();
      // Mean over ten seconds of steps, every rebuild included; best of
      // three runs, so a busy moment does not decide it. The budget scales by
      // how much slower than the tuning box this process runs the reference
      // kernel, timed around every run (the median of the six).
      let best = Number.POSITIVE_INFINITY;
      const kernel: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        kernel.push(referenceKernelMilliseconds());
        const started = performance.now();
        for (let index = 0; index < 1200; index += 1) step();
        best = Math.min(best, (performance.now() - started) / 1200);
        kernel.push(referenceKernelMilliseconds());
      }
      const slowdown = referenceSlowdown(kernel);
      return { step: best, budget: STEP_BUDGET_MILLISECONDS * slowdown, slowdown };
    };
    const report = (name: string, result: { step: number; budget: number; slowdown: number }) =>
      `${name}: ${(result.step * 1000).toFixed(0)} us a step against ${(result.budget * 1000).toFixed(0)} us `
      + `(this machine ran the reference kernel ${result.slowdown.toFixed(2)}x slower than the tuning box)`;
    const marina: SeaShelterEllipse[] = [
      { centerX: 40, centerZ: -25, heading: 0.4, radiusAlong: 60, radiusAcross: 30, floor: 0.15, feather: 40 },
      { centerX: 120, centerZ: 10, heading: 1.2, radiusAlong: 20, radiusAcross: 10, floor: 0.3, feather: 15 },
    ];
    const openWater = measure("cloudy", 6, []);
    const atTheMarina = measure("breezy", 0, marina);
    expect(openWater.step, report("open water, Cloudy, 6 m/s", openWater)).toBeLessThan(openWater.budget);
    expect(atTheMarina.step, report("moored at the marina", atTheMarina)).toBeLessThan(atTheMarina.budget);
  });
});

describe("sea shelter field", () => {
  const ellipses: SeaShelterEllipse[] = [
    { centerX: 100, centerZ: -50, heading: 0.6, radiusAlong: 80, radiusAcross: 35, floor: 0.12, feather: 30 },
    { centerX: 160, centerZ: 10, heading: -1.1, radiusAlong: 25, radiusAcross: 12, floor: 0.4, feather: 12 },
  ];
  const packed = packSeaShelterEllipses(ellipses);

  /** The WGSL `seaShelterFactor`, operation for operation in f32. */
  function shaderShelterFactor(x: number, z: number): number {
    const f = Math.fround;
    let factor = f(1);
    for (let base = 0; base < packed.length; base += 8) {
      const [ax, ay, az, aw, bx, by, bz, bw] = Array.from(packed.subarray(base, base + 8), f) as [
        number, number, number, number, number, number, number, number,
      ];
      const offsetX = f(f(x) - ax);
      const offsetZ = f(f(z) - ay);
      const along = f(f(offsetX * az) + f(offsetZ * aw));
      const across = f(f(offsetX * aw) - f(offsetZ * az));
      const ellipse = f(f(f(f(along * along) * bx) + f(f(across * across) * by)) - 1);
      const u = f(along * bx);
      const v = f(across * by);
      const gradient = f(2 * f(Math.sqrt(f(f(u * u) + f(v * v)))));
      const distance = f(ellipse / Math.max(gradient, f(1e-6)));
      const t = Math.min(1, Math.max(0, f(distance * bw)));
      const s = f(f(t * t) * f(3 - f(2 * t)));
      factor = f(factor * f(1 - f(bz * f(1 - s))));
    }
    return factor;
  }

  it("equals the shader's field at random points, and is exactly 1 on the open sea", () => {
    const random = createRandom(23);
    let worst = 0;
    let inside = 0;
    for (let point = 0; point < 4000; point += 1) {
      const x = -100 + 400 * random();
      const z = -250 + 400 * random();
      const twin = seaShelterFactor(packed, x, z);
      worst = Math.max(worst, Math.abs(twin - shaderShelterFactor(x, z)));
      if (twin < 0.5) inside += 1;
    }
    expect(inside).toBeGreaterThan(100);
    expect(worst).toBeLessThan(1e-5);
    for (const [x, z] of [[1000, 1000], [-400, 300], [100, 200]] as const) {
      expect(seaShelterFactor(packed, x, z)).toBe(1);
      expect(shaderShelterFactor(x, z)).toBe(1);
    }
    expect(seaShelterFactor(packSeaShelterEllipses([]), 100, -50)).toBe(1);
  });

  it("gives the gradient of its own factor", () => {
    const random = createRandom(29);
    const field = new Float64Array(3);
    const step = 1e-4;
    let worst = 0;
    for (let point = 0; point < 2000; point += 1) {
      const x = -50 + 300 * random();
      const z = -200 + 300 * random();
      seaShelterField(packed, x, z, field);
      expect(field[0]).toBe(seaShelterFactor(packed, x, z));
      const gx = (seaShelterFactor(packed, x + step, z) - seaShelterFactor(packed, x - step, z)) / (2 * step);
      const gz = (seaShelterFactor(packed, x, z + step) - seaShelterFactor(packed, x, z - step)) / (2 * step);
      worst = Math.max(worst, Math.abs(field[1]! - gx), Math.abs(field[2]! - gz));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("scales the twin's waves by the field: calm inside the basin, untouched outside", () => {
    const open = createSeaTwin(SEA_WORLD, "cloudy");
    const sheltered = createSeaTwin(SEA_WORLD, "cloudy");
    sheltered.setShelter(ellipses);
    const a = createWaterSurfaceSample();
    const b = createWaterSurfaceSample();
    for (const twin of [open, sheltered]) twin.setTime(61.5);
    // Far outside: bit-identical.
    expect(snapshot(sheltered.sampleExact(900, 900, b))).toEqual(snapshot(open.sampleExact(900, 900, a)));
    // At the basin's centre the sea heaves at the floor's share of the open sea.
    let openSquares = 0;
    let shelteredSquares = 0;
    for (let second = 0; second < 90; second += 1) {
      for (const twin of [open, sheltered]) twin.setTime(61.5 + second);
      openSquares += open.sampleExact(100, -50, a).height ** 2;
      shelteredSquares += sheltered.sampleExact(100, -50, b).height ** 2;
    }
    const ratio = Math.sqrt(shelteredSquares / openSquares);
    expect(ratio).toBeGreaterThan(0.09);
    expect(ratio).toBeLessThan(0.15);
  });

  it("classifies the basins once per step without changing a bit of the field", () => {
    // The twin answers points near the hull from one classification of a disk
    // round the focus; across a run from the open sea through the feather to
    // the basin's middle, every answer must be the field's, bit for bit.
    const twin = createSeaTwin(SEA_WORLD, "breezy");
    twin.setShelter(ellipses);
    const internals = twin as unknown as {
      shelterAt(x: number, z: number): Float64Array;
      shelterFactorAt(x: number, z: number): number;
      shelterConstant: number;
    };
    const field = new Float64Array(3);
    const random = createRandom(43);
    const focus: WaveFieldFocus = { x: 100, z: -50, heading: 0.6, halfLength: 3.4, halfBeam: 1.4 };
    const reach = Math.hypot(3.65, 1.65) + 10;
    const kinds = { open: 0, basin: 0, edge: 0 };
    for (let step = 0; step <= 260; step += 1) {
      // Along the basin's long axis, from 260 m out to its centre.
      focus.x = 100 + (260 - step) * Math.sin(0.6);
      focus.z = -50 + (260 - step) * Math.cos(0.6);
      twin.setTime(10 + step / 120);
      twin.setFocus(focus);
      for (let point = 0; point < 24; point += 1) {
        const angle = 2 * Math.PI * random();
        const distance = reach * Math.sqrt(random());
        const x = focus.x + distance * Math.sin(angle);
        const z = focus.z + distance * Math.cos(angle);
        seaShelterField(packed, x, z, field);
        const answer = internals.shelterAt(x, z);
        expect([answer[0], answer[1], answer[2]], `step ${step}`).toEqual([field[0], field[1], field[2]]);
        expect(internals.shelterFactorAt(x, z)).toBe(field[0]);
      }
      const constant = internals.shelterConstant;
      if (Number.isNaN(constant)) kinds.edge += 1;
      else if (constant === 1) kinds.open += 1;
      else kinds.basin += 1;
    }
    // Not vacuous: the run held the hull in the open, on the edge and inside.
    expect(kinds.open).toBeGreaterThan(20);
    expect(kinds.edge).toBeGreaterThan(20);
    expect(kinds.basin).toBeGreaterThan(20);
  });
});
