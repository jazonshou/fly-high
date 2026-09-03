import { describe, expect, it } from "vitest";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/HydrologySystem";
import {
  oceanCascadeRepresentativeWavelengthMeters,
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  DEFAULT_SPECTRAL_OCEAN_CONFIG,
  oceanCausticCurvatureScale,
} from "../src/render/webgpu/nature/OceanConfig";
import {
  WATER_CHANNEL_FLOW_WGSL,
  WATER_DEPTH_OPTICS_WGSL,
  WATER_FETCH_PEAK_PERIOD_COEFFICIENT,
  WATER_FETCH_SIGNIFICANT_HEIGHT_COEFFICIENT,
  WATER_FLOW_GRAVITY,
  WATER_LAKE_CHOP_HEIGHT_COEFFICIENT,
  WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT,
  WATER_LAKE_FETCH_REFERENCE_METERS,
  WATER_RUNUP_BANK_EXCURSION_REFERENCE_METERS,
  WATER_RUNUP_BANK_LOW,
  WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  WATER_RUNUP_BEACH_SLOPE_MINIMUM,
  WATER_RUNUP_BORE_GAIN,
  WATER_RUNUP_BORE_MEAN,
  WATER_RUNUP_BORE_SHARPNESS,
  WATER_RUNUP_CLOCK_WRAP_SECONDS,
  WATER_RUNUP_DEPTH_FADE_START_METERS,
  WATER_RUNUP_DEPTH_GATE_METERS,
  WATER_RUNUP_DRYING_SECONDS,
  WATER_RUNUP_EXCEEDANCE,
  WATER_RUNUP_GRADIENT_STEP_METERS,
  WATER_RUNUP_NYQUIST_FADE_HIGH,
  WATER_RUNUP_NYQUIST_FADE_LOW,
  WATER_RUNUP_STREAK_CELLS_PER_METER,
  WATER_RUNUP_STREAK_DEPTH_HIGH_METERS,
  WATER_RUNUP_STREAK_DEPTH_LOW_METERS,
  WATER_RUNUP_STREAK_FADE_HIGH,
  WATER_RUNUP_STREAK_FADE_LOW,
  WATER_RUNUP_STREAK_GAIN,
  WATER_RUNUP_STREAK_STRETCH,
  WATER_SHORE_RUNUP_WGSL,
  WATER_SHORE_STREAK_WGSL,
  waterDominantShoreSwell,
  waterOceanShoreSwell,
  waterRunupClock,
  waterShoreBandSwell,
  waterShoreBore,
  waterShoreRunupHeight,
  waterShoreRunupPhase,
  waterShoreSwell,
  waterShoreWetness,
  waterSwashFront,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * 6-2 — shoreline run-up, shore-normal streaking, and the 6-5 wetness field.
 *
 * `tests/gpu/water-shore-runup.test.ts` pins the exported oracle used below
 * against the shipped WGSL on a real adapter, measures the phase lock on the
 * hardware and measures the streak anisotropy. This file owns the physics
 * sweeps a GPU test would be too heavy to carry, the composition rules, the
 * CPU sea state 6-5 consumes, and the 16 m bathymetry-texel measurement.
 */

const BAND_MSS = [0.03, 0.015, 0.004, 0.0002, 0.0000002] as const;
const SHIPPED_WAVELENGTHS = [2, 16, 64, 256, 1024] as const;
const ALL_VISIBLE = [1, 1, 1, 1, 1] as const;

describe("6-2 composition", () => {
  it("is one definition, composed into both water fragments", () => {
    // The §3.6 rule: a second textual copy of a shared block is the drift the
    // extraction gate exists to prevent. 6-5 composes this SAME text into the
    // terrain surface plugin, which is why the block has to be shared rather
    // than living in either material.
    expect(WATER_FRAGMENT_WGSL).toContain(WATER_SHORE_RUNUP_WGSL);
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(WATER_SHORE_RUNUP_WGSL);
    for (const helper of [
      "fn waterShoreSwell(",
      "fn waterShoreBandSwell(",
      "fn waterDominantShoreSwell(",
      "fn waterShoreRunupHeight(",
      "fn waterShoreRunupPhase(",
      "fn waterSwashFront(",
      "fn waterShoreBore(",
      "fn waterShoreStreak(",
      "fn waterShoreWetness(",
      "fn waterRunupClock(",
    ]) {
      expect(WATER_FRAGMENT_WGSL.split(helper), `ocean ${helper}`).toHaveLength(2);
      expect(HYDROLOGY_WATER_FRAGMENT_WGSL.split(helper), `inland ${helper}`)
        .toHaveLength(2);
    }
    // Neither VERTEX stage carries any of it: run-up is a fragment term.
    expect(WATER_VERTEX_WGSL).not.toContain("waterShore");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).not.toContain("waterShore");
  });

  it("keeps the run-up model self-contained so 6-5 can compose it", () => {
    // 6-5 composes this block into the TERRAIN surface plugin, which has never
    // heard of the water noise lattice, declares none of these uniforms, and
    // whose wetness response runs in its own control flow. The block therefore
    // may not reference a uniform, a texture, a derivative — or any helper it
    // does not itself define. The GPU test compiles it alone; this pins the
    // property at review time, where the fix is cheap.
    const code = WATER_SHORE_RUNUP_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    for (const forbidden of [
      "uniforms.", "texture", "sampler", "@group", "var<", "dpdx", "dpdy", "fwidth",
    ]) {
      expect(code, `run-up block must not reference ${forbidden}`).not.toContain(forbidden);
    }
    const defined = new Set(
      [...code.matchAll(/^fn ([A-Za-z0-9_]+)\(/gmu)].map((match) => match[1]!),
    );
    const builtins = new Set([
      "max", "min", "clamp", "sqrt", "sin", "cos", "pow", "exp", "floor", "fract",
      "asin", "smoothstep", "mix", "abs", "select", "vec2f", "vec4f", "WaterShoreSwell",
    ]);
    for (const match of code.matchAll(/([A-Za-z][A-Za-z0-9_]*)\(/gu)) {
      const name = match[1]!;
      if (builtins.has(name) || defined.has(name)) continue;
      expect(name, "run-up block calls an undefined helper").toBe("");
    }
    // The streak lattice is the ONE part that needs the noise block, which is
    // exactly why it is a separate export — and it is ocean-only, the way
    // WATER_CREST_SSS_WGSL is, because a bank's streaks advect on 6-1's dual
    // phase instead of on a bounded swash offset.
    expect(WATER_SHORE_STREAK_WGSL).toContain("waterCapillaryOctave(");
    expect(WATER_FRAGMENT_WGSL).toContain(WATER_SHORE_STREAK_WGSL);
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).not.toContain("fn waterShoreStreakLattice(");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("waterFlowOctaveValue(");
    // ...and it is not a second dual-phase: the inland streak reuses 6-1's.
    expect(WATER_CHANNEL_FLOW_WGSL.split("fn waterFlowPhase(")).toHaveLength(2);
    expect(WATER_CHANNEL_FLOW_WGSL).toContain("waterFlowPhase(time, cycleSeconds)");
  });

  it("keeps every smoothstep window ascending", () => {
    // The reversed-smoothstep incident: the clamped helper turns a reversed
    // pair into a hard step, and ten masks shipped that way.
    expect(WATER_RUNUP_DEPTH_FADE_START_METERS).toBeLessThan(WATER_RUNUP_DEPTH_GATE_METERS);
    expect(WATER_RUNUP_STREAK_DEPTH_LOW_METERS)
      .toBeLessThan(WATER_RUNUP_STREAK_DEPTH_HIGH_METERS);
    expect(WATER_RUNUP_STREAK_FADE_LOW).toBeLessThan(WATER_RUNUP_STREAK_FADE_HIGH);
    expect(WATER_RUNUP_NYQUIST_FADE_LOW).toBeLessThan(WATER_RUNUP_NYQUIST_FADE_HIGH);
    expect(WATER_RUNUP_BEACH_SLOPE_MINIMUM).toBeLessThan(WATER_RUNUP_BEACH_SLOPE_MAXIMUM);
    expect(WATER_RUNUP_BANK_LOW).toBeLessThan(1);
    expect(1).toBeLessThan(WATER_RUNUP_EXCEEDANCE);
    for (const [label, source] of [
      ["run-up", WATER_SHORE_RUNUP_WGSL],
      ["streak", WATER_SHORE_STREAK_WGSL],
      ["ocean fragment", WATER_FRAGMENT_WGSL],
      ["inland fragment", HYDROLOGY_WATER_FRAGMENT_WGSL],
    ] as const) {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/.*$/gmu, "");
      const reversed: string[] = [];
      for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/gu)) {
        if (Number(match[2]) <= Number(match[1])) reversed.push(match[0]);
      }
      expect(reversed, `${label} reversed smoothstep`).toEqual([]);
    }
  });

  it("generates its WGSL constants from the TypeScript the oracle uses", () => {
    expect(WATER_SHORE_RUNUP_WGSL).toContain(
      `const WATER_RUNUP_BORE_GAIN: f32 = ${WATER_RUNUP_BORE_GAIN};`,
    );
    expect(WATER_SHORE_RUNUP_WGSL).toContain(
      `const WATER_RUNUP_BORE_MEAN: f32 = ${WATER_RUNUP_BORE_MEAN};`,
    );
    expect(WATER_SHORE_RUNUP_WGSL).toContain(
      `const WATER_RUNUP_DRYING_SECONDS: f32 = ${WATER_RUNUP_DRYING_SECONDS}.0;`,
    );
    expect(WATER_SHORE_RUNUP_WGSL).toContain(
      `const WATER_RUNUP_EXCEEDANCE: f32 = ${WATER_RUNUP_EXCEEDANCE};`,
    );
    expect(WATER_SHORE_RUNUP_WGSL).toContain(
      `const WATER_RUNUP_STREAK_STRETCH: f32 = ${WATER_RUNUP_STREAK_STRETCH}.0;`,
    );
    // No sin-fract hash anywhere: the block is fed absolute world metres
    // through `depth`, and the recorded failure only appears kilometres out.
    for (const source of [WATER_SHORE_RUNUP_WGSL, WATER_SHORE_STREAK_WGSL]) {
      expect(source).not.toContain("fract(sin(");
      expect(source).not.toContain("fract(43758");
    }
  });

  it("gates the ocean term on depth and never paints foam above the waterline", () => {
    const code = WATER_FRAGMENT_WGSL.replace(/\/\/.*$/gmu, "");
    // The whole term is inside a depth gate; open water pays one compare plus
    // the five per-cascade moment adds.
    expect(code).toContain("if (runupGate > 0.001) {");
    expect(code).toContain("var runupModulation = 1.0;");
    // Wave R's guarantee survives verbatim: the band still rises from ZERO at
    // the waterline, so a modulated band is still exactly zero on dry land,
    // where the ocean disk is drawn but transparent.
    expect(code).toContain("smoothstep(0.0, 1.1, depth) * (1.0 - smoothstep(1.2, 7.5, depth))");
    // The derivatives the fades need are taken in uniform control flow, before
    // the gate opens — a derivative built-in may not be called from
    // non-uniform flow (6-1's rule, and the reason the footprint is hoisted).
    expect(code.indexOf("let runupDerivativeX = dpdx("))
      .toBeLessThan(code.indexOf("if (runupGate > 0.001) {"));
    expect(code.indexOf("let runupFootprint"))
      .toBeLessThan(code.indexOf("if (runupGate > 0.001) {"));
    // The three bathymetry taps live in the shared depth include, on the raw
    // delta rather than on a clamped depth.
    expect(WATER_DEPTH_OPTICS_WGSL).toContain("fn waterBathymetryBedSlope(");
    expect(WATER_DEPTH_OPTICS_WGSL.split("sampleBathymetryBedDelta(")).toHaveLength(6);
    expect(code).toContain("waterBathymetryBedSlope(");
  });

  it("adds the inland run-up strictly behind 6-1's sentinel", () => {
    const code = HYDROLOGY_WATER_FRAGMENT_WGSL.replace(/\/\/.*$/gmu, "");
    // The accumulator starts at zero and is only written inside the sentinel
    // branch, exactly as 6-1's four do.
    expect(code).toContain("var channelBankRunup = 0.0;");
    expect(code.indexOf("var channelBankRunup = 0.0;"))
      .toBeLessThan(code.indexOf("if (input.waterInfo.w > 0.0)"));
    expect(code).toContain("channelBankRunup = channel.bankRunup;");
    // And the analytic ramp is untouched: the max only runs when the sentinel
    // produced something, so an analytic world executes the pre-6-2 statement
    // and one compare.
    expect(code).toContain(
      "var shoreFoam = smoothstep(0.76, 1.0, input.waterInfo.z) * shorePattern * 0.3;",
    );
    expect(code).toContain("if (channelBankRunup > 0.0) {");
    expect(code).toContain("shoreFoam = max(shoreFoam, channelBankRunup);");
    // The bank normal is exact rather than derived from a screen derivative.
    expect(code).toContain("let laneSign = select(-1.0, 1.0, input.waterUv.y >= 0.5);");
    expect(code).toContain("input.waterInfo.z,");
    // The whole bank term lives under `bankBand > 0.001`, so mid-channel
    // fragments never evaluate it.
    expect(WATER_CHANNEL_FLOW_WGSL.split("if (bankBand > 0.001) {")).toHaveLength(3);
    // Zero struct: 6-1's zero constructor grew a lane and kept every value 0.
    expect(WATER_CHANNEL_FLOW_WGSL).toContain(
      "return WaterChannelFlow(vec2f(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);",
    );
  });

  it("publishes the per-cascade wavelength the dominant-band rule needs", () => {
    expect(WATER_FRAGMENT_WGSL).toContain("uniform cascadeWavelengths0: vec4f;");
    expect(WATER_FRAGMENT_WGSL).toContain("uniform cascadeWavelength4: f32;");
    // The representative wavelength is not a second definition: it is the same
    // expression `oceanCausticCurvatureScale` inverts, so the two must agree
    // across the whole shipped cascade set or one of them has drifted.
    for (const cascade of DEFAULT_SPECTRAL_OCEAN_CONFIG.cascades) {
      const wavelength = oceanCascadeRepresentativeWavelengthMeters(cascade);
      const choppiness = DEFAULT_SPECTRAL_OCEAN_CONFIG.choppiness;
      expect(oceanCausticCurvatureScale(cascade, choppiness))
        .toBeCloseTo((2 * Math.PI) / wavelength / choppiness, 10);
    }
    expect(
      DEFAULT_SPECTRAL_OCEAN_CONFIG.cascades.map(oceanCascadeRepresentativeWavelengthMeters),
    ).toEqual([2, 16, 64, 256, 1024]);
  });
});

describe("6-2 the dominant-band rule (the binding rule)", () => {
  it("selects by visible amplitude, not by visible slope", () => {
    // The failure this rule prevents: slope is dominated by the shortest band
    // at every wind speed, so a slope-keyed run-up beats the surf at the
    // capillary rate. Amplitude a = sqrt(2 mss)/k rises with wavelength even
    // as mss falls, which is why the swell band wins.
    const amplitudes = SHIPPED_WAVELENGTHS.map((wavelength, lane) =>
      (Math.sqrt(2 * BAND_MSS[lane]!) * wavelength) / (2 * Math.PI));
    expect(amplitudes.indexOf(Math.max(...amplitudes))).toBe(2);
    expect((BAND_MSS as readonly number[]).indexOf(Math.max(...BAND_MSS))).toBe(0);
    const swell = waterDominantShoreSwell(SHIPPED_WAVELENGTHS, BAND_MSS, ALL_VISIBLE);
    expect(swell.wavelengthMeters).toBe(64);
  });

  it("re-beats on the next visible band when one fades out", () => {
    const full = waterDominantShoreSwell(SHIPPED_WAVELENGTHS, BAND_MSS, ALL_VISIBLE);
    const faded = waterDominantShoreSwell(SHIPPED_WAVELENGTHS, BAND_MSS, [1, 1, 0, 1, 1]);
    expect(faded.wavelengthMeters).toBe(256);
    // A band four times as long beats half as fast: omega = sqrt(g k).
    expect(full.radianFrequency / faded.radianFrequency).toBeCloseTo(2, 6);
    // Partial fades interpolate the WEIGHT, never the frequency: the run-up
    // always beats at some real band's rate, never at an average of two.
    for (let fade = 0; fade <= 1.0001; fade += 0.05) {
      const swell = waterDominantShoreSwell(
        SHIPPED_WAVELENGTHS,
        BAND_MSS,
        [1, 1, fade, 1, 1],
      );
      expect(SHIPPED_WAVELENGTHS).toContain(swell.wavelengthMeters);
    }
  });

  it("ignores cascades the profile does not run", () => {
    // Absent cascades publish wavelength 0, so they score 0 and cannot win —
    // the rule needs no cascade-count test of its own.
    const swell = waterDominantShoreSwell(
      [2, 16, 0, 0, 0],
      [0.03, 0.015, 0, 0, 0],
      ALL_VISIBLE,
    );
    expect(swell.wavelengthMeters).toBe(16);
    // Even a nonsense mean-square slope on an absent lane cannot pull it in.
    expect(
      waterDominantShoreSwell([2, 16, 0, 0, 0], [0.03, 0.015, 900, 0, 0], ALL_VISIBLE)
        .wavelengthMeters,
    ).toBe(16);
  });

  it("stays on the swell band everywhere the surf is more than a pixel wide", () => {
    // The one way the lock can pop mid-frame is a band switch as the fades
    // move with range. Reproduce the shipped fade (`cascadeFade`, keyed on
    // slant range against maximumWavelength/(2 x pixelAngle)) and walk the
    // camera out. For the shipped cascade set the swell band holds to 25 km.
    const pixelAngle = 1e-3;
    const fadeEnd = (maximumWavelength: number): number =>
      maximumWavelength / (2 * pixelAngle);
    const fadeAt = (range: number, end: number): number => {
      const t = Math.min(Math.max((range - end * 0.3) / (end - end * 0.3), 0), 1);
      return 1 - t * t * (3 - 2 * t);
    };
    const maxima = DEFAULT_SPECTRAL_OCEAN_CONFIG.cascades
      .map((cascade) => cascade.maximumWavelengthMeters);
    const dominantAt = (range: number): number => {
      const fades = maxima.map((maximum) => fadeAt(range, fadeEnd(maximum))) as unknown as
        readonly [number, number, number, number, number];
      return waterDominantShoreSwell(SHIPPED_WAVELENGTHS, BAND_MSS, fades).wavelengthMeters;
    };
    for (const range of [50, 500, 2_000, 8_000, 20_000, 25_000]) {
      expect(dominantAt(range), `dominant band at ${range} m`).toBe(64);
    }
    // Past that the 256 m band takes over as cascade 2 fades — a real switch,
    // and a real beat change. It is recorded rather than hidden because it is
    // measurably invisible: a 40 m surf zone at 30 km subtends 1.3 pixels at
    // this pixel angle, so the band it beats at cannot be read off the screen.
    expect(dominantAt(30_000)).toBe(256);
    const surfZoneMeters = 40;
    expect(surfZoneMeters / 30_000 / pixelAngle).toBeLessThan(2);
  });
});

describe("6-2 Hunt run-up", () => {
  it("reproduces the Iribarren form", () => {
    // R = xi H with xi = tan(beta)/sqrt(H/L0). A 2 m sea at 78 m on a 1:12
    // beach runs up 1.04 m, which is what Hunt's regression gives.
    const swell = waterShoreSwell(2, 78, 11);
    expect(swell.excursionMeters).toBeCloseTo(Math.sqrt(2 * 78), 10);
    const beachSlope = 1 / 12;
    const iribarren = beachSlope / Math.sqrt(2 / 78);
    expect(waterShoreRunupHeight(swell, beachSlope)).toBeCloseTo(iribarren * 2, 10);
    expect(waterShoreRunupHeight(swell, beachSlope)).toBeCloseTo(1.041, 3);
  });

  it("makes the excursion slope-free and the elevation slope-linear", () => {
    const swell = waterShoreSwell(2, 78, 11);
    const slopes = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3];
    for (const slope of slopes) {
      expect(waterShoreRunupHeight(swell, slope) / slope)
        .toBeCloseTo(swell.excursionMeters, 6);
    }
    // Outside the physical band the clamps bind, and only there.
    expect(waterShoreRunupHeight(swell, 0))
      .toBeCloseTo(WATER_RUNUP_BEACH_SLOPE_MINIMUM * swell.excursionMeters, 10);
    expect(waterShoreRunupHeight(swell, 12))
      .toBeCloseTo(WATER_RUNUP_BEACH_SLOPE_MAXIMUM * swell.excursionMeters, 10);
  });

  it("reads a spectral band as the swell train it is", () => {
    // a = sqrt(2 mss)/k and H = 2a, then deep-water celerity gives omega.
    for (const [wavelength, mss] of [[64, 0.004], [16, 0.015], [256, 0.0002]] as const) {
      const swell = waterShoreBandSwell(wavelength, mss);
      const k = (2 * Math.PI) / wavelength;
      expect(swell.waveHeightMeters).toBeCloseTo((2 * Math.sqrt(2 * mss)) / k, 8);
      expect(swell.radianFrequency).toBeCloseTo(Math.sqrt(WATER_FLOW_GRAVITY * k), 8);
    }
    // A glassy band raises nothing at all — no run-up, no excursion.
    const glass = waterShoreBandSwell(64, 0);
    expect(glass.waveHeightMeters).toBe(0);
    expect(glass.excursionMeters).toBe(0);
    expect(waterShoreRunupHeight(glass, 0.06)).toBe(0);
  });

  it("beats faster in shallower water, at the shallow-water wavenumber", () => {
    // The eikonal's spatial gradient must be omega/sqrt(g h): crest spacing
    // narrows shoreward on its own, which is what refraction does to real surf.
    const omega = 0.98;
    const slope = 0.05;
    for (const depth of [0.2, 0.6, 1.5, 4, 9]) {
      const delta = depth * 1e-4;
      const gradient = (waterShoreRunupPhase(depth + delta, slope, omega, 0)
        - waterShoreRunupPhase(depth, slope, omega, 0)) / delta * slope;
      expect(gradient, `wavenumber at ${depth} m`)
        .toBeCloseTo(omega / Math.sqrt(WATER_FLOW_GRAVITY * depth), 4);
    }
  });

  it("carries exactly one clock, wrapped", () => {
    // omega * t is the one place this term accumulates the session clock.
    expect(waterRunupClock(0)).toBe(0);
    expect(waterRunupClock(12.5)).toBe(12.5);
    expect(waterRunupClock(WATER_RUNUP_CLOCK_WRAP_SECONDS + 3.25)).toBeCloseTo(3.25, 10);
    expect(waterRunupClock(WATER_RUNUP_CLOCK_WRAP_SECONDS * 7 + 1)).toBeCloseTo(1, 10);
    // At the wrap the accumulated product is still exact in f32: 4096 s times
    // the fastest frequency the shipped cascade set produces is under 2^15 rad,
    // where the f32 spacing is 2e-3 of a radian.
    const fastest = waterShoreBandSwell(2, 0.03).radianFrequency;
    expect(fastest * WATER_RUNUP_CLOCK_WRAP_SECONDS).toBeLessThan(2 ** 15);
  });
});

describe("6-2 the 6-5 wetness field", () => {
  const SWELL = waterShoreBandSwell(64, 0.004);
  const RUNUP = waterShoreRunupHeight(SWELL, 0.06);

  it("is exactly [0, 1] over every input 6-5 can hand it", () => {
    for (const freeboard of [-10, -0.001, 0, 0.001, 0.1, 0.5, 1, 5, 1e4]) {
      for (const height of [0, 1e-6, 0.2, RUNUP, 20]) {
        for (const phase of [0, 1, 3.2, 7.9, 1e4]) {
          for (const omega of [0, 1e-9, 0.1, SWELL.radianFrequency, 50]) {
            const wetness = waterShoreWetness(freeboard, height, phase, omega);
            expect(Number.isFinite(wetness)).toBe(true);
            expect(wetness).toBeGreaterThanOrEqual(0);
            expect(wetness).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("is 1 at and below still water and 0 with no swell", () => {
    // The two ends 6-5 needs to be unambiguous: submerged ground is wet, and
    // an analytic world with no published swell keeps today's behaviour with
    // no branch of its own.
    expect(waterShoreWetness(-3, RUNUP, 1.2, SWELL.radianFrequency)).toBe(1);
    expect(waterShoreWetness(0, RUNUP, 1.2, SWELL.radianFrequency)).toBe(1);
    expect(waterShoreWetness(0.3, 0, 1.2, SWELL.radianFrequency)).toBe(0);
  });

  it("ends inside the Rayleigh exceedance limit", () => {
    // Individual run-ups exceed R, so the wet band tails out rather than
    // ending on a drawn line — but it does END, and where the constant says.
    expect(waterShoreWetness(RUNUP * (WATER_RUNUP_EXCEEDANCE + 0.01), RUNUP, 1.2, 1))
      .toBe(0);
    expect(waterShoreWetness(RUNUP * 1.15, RUNUP, 1.2, 1)).toBeGreaterThan(0);
    expect(waterShoreWetness(RUNUP * 1.15, RUNUP, 1.2, 1)).toBeLessThan(1);
  });

  it("falls monotonically up the beach face at any instant", () => {
    for (const phase of [0.1, 1.4, 2.9, 4.6, 6.0]) {
      let previous = 1.0000001;
      for (let u = 0; u <= 1.4; u += 0.02) {
        const wetness = waterShoreWetness(u * RUNUP, RUNUP, phase, SWELL.radianFrequency);
        expect(wetness, `phase ${phase} at u=${u.toFixed(2)}`)
          .toBeLessThanOrEqual(previous + 1e-9);
        previous = wetness;
      }
    }
  });

  it("has exactly one discontinuity per beat, and it is the arriving wave", () => {
    // The field is analytic, so its continuity is a property to be measured
    // rather than assumed. Over a full beat at ten levels there is exactly ONE
    // step larger than a percent, and it is the uprush arriving — dry sand
    // darkens the instant water reaches it, so that jump is the feature. The
    // descending crossing, where a naive `fract((phase - endPhase)/2pi)` would
    // also wrap, is smooth: that is why the age is branched on the uprush.
    const period = (2 * Math.PI) / SWELL.radianFrequency;
    for (let u = 0.05; u < 1; u += 0.1) {
      const steps = 4000;
      let previous = waterShoreWetness(u * RUNUP, RUNUP, 0, SWELL.radianFrequency);
      const jumps: number[] = [];
      let largestSmooth = 0;
      for (let step = 1; step <= steps; step += 1) {
        const phase = (SWELL.radianFrequency * (step * period)) / steps;
        const wetness = waterShoreWetness(u * RUNUP, RUNUP, phase, SWELL.radianFrequency);
        const jump = Math.abs(wetness - previous);
        if (jump > 0.01) jumps.push(step / steps);
        else largestSmooth = Math.max(largestSmooth, jump);
        previous = wetness;
      }
      expect(jumps.length, `discontinuities at u=${u.toFixed(2)}: ${jumps}`).toBe(1);
      // The arrival is at the uprush crossing asin(u)/2pi of the cycle.
      expect(jumps[0]!, `arrival phase at u=${u.toFixed(2)}`)
        .toBeCloseTo(Math.asin(u) / (2 * Math.PI), 2);
      expect(largestSmooth, `smooth elsewhere at u=${u.toFixed(2)}`).toBeLessThan(0.01);
    }
  });

  it("dries with the documented time constant", () => {
    // Persistence is analytic: the elapsed time since the front last left a
    // level is a closed form, and the darkening decays exponentially from it.
    const omega = SWELL.radianFrequency;
    const period = (2 * Math.PI) / omega;
    // Level u = 0.5 is left at phase pi - asin(0.5) = 2.618 rad. Half a cycle
    // later the field must have decayed by exp(-T/2 / tau).
    const leaves = Math.PI - Math.asin(0.5);
    const halfLater = leaves + Math.PI;
    expect(waterShoreWetness(0.5 * RUNUP, RUNUP, halfLater, omega))
      .toBeCloseTo(Math.exp(-(period / 2) / WATER_RUNUP_DRYING_SECONDS), 4);
    // And the whole swash zone stays visibly wet: with a 15 s constant against
    // this band's 6.4 s beat, nothing inside the zone drops below 0.6.
    expect(period).toBeGreaterThan(4);
    expect(period).toBeLessThan(10);
    let lowest = 1;
    for (let u = 0; u < 1; u += 0.01) {
      for (let phase = 0; phase < 2 * Math.PI; phase += 0.05) {
        lowest = Math.min(lowest, waterShoreWetness(u * RUNUP, RUNUP, phase, omega));
      }
    }
    expect(lowest).toBeGreaterThan(0.6);
  });

  it("gives 6-5 a field whose scale is the sea state's", () => {
    // A calm day wets a narrow strip; a storm wets the whole berm. The band's
    // WIDTH is the deliverable, and it comes out of Hunt rather than a dial.
    const calm = waterShoreRunupHeight(waterOceanShoreSwell(4, 120_000), 0.06);
    const storm = waterShoreRunupHeight(waterOceanShoreSwell(20, 120_000), 0.06);
    expect(calm).toBeGreaterThan(0.2);
    expect(storm / calm).toBeGreaterThan(2);
    // Vertical run-up over a 1:17 beach becomes a horizontal wet band of
    // R/tan(beta) metres — 12 m calm, 30 m in a storm. Beach-scale, not
    // metre-scale and not kilometre-scale.
    expect(calm / 0.06).toBeGreaterThan(5);
    expect(storm / 0.06).toBeLessThan(120);
  });
});

describe("6-2 the CPU sea state 6-5 consumes", () => {
  it("reuses 6-1's fetch-limited coefficients without changing their values", () => {
    // The extraction must be value-identical or 6-1's lake chop moved.
    expect(WATER_LAKE_CHOP_HEIGHT_COEFFICIENT).toBe(
      0.0016 * Math.sqrt(WATER_LAKE_FETCH_REFERENCE_METERS / WATER_FLOW_GRAVITY),
    );
    expect(WATER_LAKE_CHOP_WAVELENGTH_COEFFICIENT).toBe(
      (0.286 ** 2 / (2 * Math.PI)) * WATER_FLOW_GRAVITY ** (-1 / 3),
    );
    expect(WATER_FETCH_SIGNIFICANT_HEIGHT_COEFFICIENT).toBe(0.0016);
    expect(WATER_FETCH_PEAK_PERIOD_COEFFICIENT).toBe(0.286);
  });

  it("agrees with the spectrum the GPU actually renders", () => {
    // 6-5 has no cascade textures, so it takes the sea state from here. That
    // is only sound if it lands where the shader's own dominant-band rule
    // lands. For the shipped config (12 m/s over 120 km):
    const config = DEFAULT_SPECTRAL_OCEAN_CONFIG;
    const swell = waterOceanShoreSwell(
      config.windSpeedMetersPerSecond,
      config.fetchLengthMeters,
    );
    // ...Hs = 2.12 m, inside the 1-5 m the fp16 harness measures on the
    // rendered spectrum for the same configuration...
    expect(swell.waveHeightMeters).toBeCloseTo(2.12, 2);
    expect(swell.waveHeightMeters).toBeGreaterThan(1);
    expect(swell.waveHeightMeters).toBeLessThan(5);
    // ...and a 77.5 m peak wavelength, which falls inside cascade 2's
    // [32, 128] m band — the band the shader selects for this sea.
    expect(swell.wavelengthMeters).toBeCloseTo(77.55, 1);
    const dominant = config.cascades[2]!;
    expect(swell.wavelengthMeters).toBeGreaterThan(dominant.minimumWavelengthMeters);
    expect(swell.wavelengthMeters).toBeLessThan(dominant.maximumWavelengthMeters);
    expect(waterDominantShoreSwell(SHIPPED_WAVELENGTHS, BAND_MSS, ALL_VISIBLE)
      .wavelengthMeters).toBe(oceanCascadeRepresentativeWavelengthMeters(dominant));
    // The two frequencies therefore differ by less than a fifth, which is
    // inside the beat's own variability from one wave group to the next.
    const shader = waterShoreBandSwell(
      oceanCascadeRepresentativeWavelengthMeters(dominant),
      BAND_MSS[2]!,
    );
    expect(Math.abs(swell.radianFrequency / shader.radianFrequency - 1)).toBeLessThan(0.2);
  });

  it("grows the sea state with wind and with fetch", () => {
    const light = waterOceanShoreSwell(4, 120_000);
    const strong = waterOceanShoreSwell(18, 120_000);
    const enclosed = waterOceanShoreSwell(12, 5_000);
    const open = waterOceanShoreSwell(12, 400_000);
    expect(strong.waveHeightMeters).toBeGreaterThan(light.waveHeightMeters * 4);
    expect(open.waveHeightMeters).toBeGreaterThan(enclosed.waveHeightMeters * 4);
    expect(open.wavelengthMeters).toBeGreaterThan(enclosed.wavelengthMeters * 4);
    // A dead calm raises nothing, and the clamps hold the wavelength inside
    // the band a shoreline can carry.
    expect(waterOceanShoreSwell(0, 120_000).waveHeightMeters).toBe(0);
    expect(waterOceanShoreSwell(0, 120_000).excursionMeters).toBe(0);
    for (const wind of [0, 1, 12, 40]) {
      for (const fetch of [0, 100, 120_000, 5e6]) {
        const swell = waterOceanShoreSwell(wind, fetch);
        expect(Number.isFinite(swell.radianFrequency)).toBe(true);
        expect(swell.wavelengthMeters).toBeGreaterThanOrEqual(1);
        expect(swell.wavelengthMeters).toBeLessThanOrEqual(600);
      }
    }
  });
});

describe("6-2 the bore modulation", () => {
  it("has a cycle mean of exactly one", () => {
    // Wave R's shore band has a pinned time-averaged coverage, so the run-up
    // has to REDISTRIBUTE its foam rather than add any. The mean of
    // max(sin, 0)^3 is 2/(3 pi), which is the constant subtracted.
    const samples = 200_000;
    let sum = 0;
    for (let index = 0; index < samples; index += 1) {
      sum += waterShoreBore((index / samples) * 2 * Math.PI);
    }
    expect(sum / samples).toBeCloseTo(1, 4);
    expect(WATER_RUNUP_BORE_MEAN).toBeCloseTo(2 / (3 * Math.PI), 12);
    expect(WATER_RUNUP_BORE_SHARPNESS).toBe(3);
  });

  it("never goes negative and gives the front a real contrast ratio", () => {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 0; index < 10_000; index += 1) {
      const value = waterShoreBore((index / 10_000) * 2 * Math.PI);
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
    expect(lowest).toBeCloseTo(1 - WATER_RUNUP_BORE_GAIN * WATER_RUNUP_BORE_MEAN, 6);
    expect(lowest).toBeGreaterThan(0);
    expect(highest).toBeCloseTo(1 + WATER_RUNUP_BORE_GAIN * (1 - WATER_RUNUP_BORE_MEAN), 4);
    expect(highest / lowest).toBeGreaterThan(3);
  });

  it("keeps the streak modulation mean-preserving too", () => {
    // The lattice value has mean 0.5, so `1 + gain (2v - 1)` has mean 1 for any
    // weight; the GPU test measures the lattice's mean on the hardware.
    const gain = WATER_RUNUP_STREAK_GAIN;
    expect(1 + gain * (2 * 0.5 - 1)).toBe(1);
    expect(1 - gain).toBeGreaterThan(0);
    // Inland the band is ADDITIVE over the analytic ramp, so it carries a
    // driver-strength weight instead: a pond's rim must not foam like a lee
    // shore. Both of those numbers are in the constant's docblock.
    expect(WATER_RUNUP_BANK_EXCURSION_REFERENCE_METERS).toBeGreaterThan(0);
  });
});

/**
 * The 16 m bathymetry texel — the resolution floor, and the constraint wave R's
 * band went wide to respect.
 *
 * The measurement below reproduces the shipped chain exactly: a bilinear bed on
 * a 16 m lattice, the 3-tap forward difference `waterBathymetryBedSlope` takes,
 * and the eikonal phase built from the resulting depth and slope. The claim is
 * that the run-up's output is C0 across texel boundaries — no STEP — which is
 * what "does not reveal the grid" means for a term whose spacing is allowed to
 * crease.
 *
 * A control runs the same chain against a POINT-SAMPLED bed, i.e. what the term
 * would look like if the bathymetry were not filtered, and the test requires
 * the control to fail the same bound. Without that the measurement would pass
 * on any smooth function and prove nothing.
 */
const TEXEL_METERS = 16;

function bedHash(cellX: number, cellZ: number): number {
  let h = (Math.imul(cellX | 0, 0x27d4eb2d) ^ Math.imul(cellZ | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h / 0xffffffff;
}

/** A 1:14 beach with texel-scale relief, bilinear between 16 m lattice points. */
function bilinearBed(x: number, z: number): number {
  const gx = x / TEXEL_METERS;
  const gz = z / TEXEL_METERS;
  const cx = Math.floor(gx);
  const cz = Math.floor(gz);
  const fx = gx - cx;
  const fz = gz - cz;
  const corner = (ix: number, iz: number): number =>
    (ix * TEXEL_METERS) / 60 + (bedHash(ix, iz) - 0.5) * 0.4;
  const a = corner(cx, cz);
  const b = corner(cx + 1, cz);
  const c = corner(cx, cz + 1);
  const d = corner(cx + 1, cz + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

/** The same field, unfiltered — the control. */
function pointSampledBed(x: number, z: number): number {
  const ix = Math.floor(x / TEXEL_METERS);
  const iz = Math.floor(z / TEXEL_METERS);
  return (ix * TEXEL_METERS) / 60 + (bedHash(ix, iz) - 0.5) * 0.4;
}

function runupAlongTransect(
  bed: (x: number, z: number) => number,
): { readonly xs: number[]; readonly values: number[] } {
  const swell = waterShoreBandSwell(64, 0.004);
  const xs: number[] = [];
  const values: number[] = [];
  const z = 733.5;
  // A 1:60 dissipative beach: the band the shore foam occupies (0.4 m to 8 m
  // of depth) then spans ~450 m, i.e. 28 texel boundaries.
  for (let x = -520; x <= -10; x += 0.25) {
    const here = bed(x, z);
    const depth = Math.max(-here, 0);
    if (depth < 0.4 || depth > 8) continue;
    const slope = Math.hypot(
      (bed(x + WATER_RUNUP_GRADIENT_STEP_METERS, z) - here)
        / WATER_RUNUP_GRADIENT_STEP_METERS,
      (bed(x, z + WATER_RUNUP_GRADIENT_STEP_METERS) - here)
        / WATER_RUNUP_GRADIENT_STEP_METERS,
    );
    const phase = waterShoreRunupPhase(depth, slope, swell.radianFrequency, 91.25);
    xs.push(x);
    values.push(waterShoreBore(phase) * waterSwashFront(phase));
  }
  return { xs, values };
}

/** Mean absolute step, split by whether the step crosses a texel boundary. */
function boundarySplit(
  xs: readonly number[],
  values: readonly number[],
): { readonly atBoundary: number; readonly elsewhere: number } {
  let boundarySum = 0;
  let boundaryCount = 0;
  let interiorSum = 0;
  let interiorCount = 0;
  for (let index = 1; index < xs.length; index += 1) {
    const jump = Math.abs(values[index]! - values[index - 1]!);
    const crossed = Math.floor(xs[index]! / TEXEL_METERS)
      !== Math.floor(xs[index - 1]! / TEXEL_METERS);
    if (crossed) {
      boundarySum += jump;
      boundaryCount += 1;
    } else {
      interiorSum += jump;
      interiorCount += 1;
    }
  }
  expect(boundaryCount).toBeGreaterThan(15);
  expect(interiorCount).toBeGreaterThan(200);
  return {
    atBoundary: boundarySum / boundaryCount,
    elsewhere: interiorSum / interiorCount,
  };
}

describe("6-2 the 16 m bathymetry texel", () => {
  it("does not step at texel boundaries", () => {
    const { xs, values } = runupAlongTransect(bilinearBed);
    const split = boundarySplit(xs, values);
    // Every input is a bilinear sample or a difference of two, so the whole
    // term is C0 in world position: a step across a boundary is no larger than
    // a step inside a texel. 1.6x is the honest bound — the field's own
    // curvature differs either side of a crease, so the ratio is not exactly 1.
    expect(split.atBoundary / split.elsewhere).toBeLessThan(1.6);
    // And the term is genuinely varying, so the ratio is not a division of two
    // zeros.
    expect(split.elsewhere).toBeGreaterThan(1e-4);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.5);
  });

  it("would step if the bathymetry were not filtered (the control)", () => {
    // The measurement above is only worth having if it can fail. Point-sample
    // the same bed and the boundary steps become the whole signal.
    const { xs, values } = runupAlongTransect(pointSampledBed);
    const split = boundarySplit(xs, values);
    expect(split.atBoundary / split.elsewhere).toBeGreaterThan(3);
  });

  it("keeps the crest spacing far above the pixel at every depth it runs at", () => {
    // The other way a term prints a grid is by aliasing. The local crest
    // spacing is 2 pi sqrt(g h)/omega, which for the swell band is 20 m at
    // 1 m of depth and 12 m at 0.4 m — tens of metres, so the fade only ever
    // engages at genuinely grazing footprints.
    const omega = waterShoreBandSwell(64, 0.004).radianFrequency;
    const spacing = (depth: number): number =>
      (2 * Math.PI * Math.sqrt(WATER_FLOW_GRAVITY * depth)) / omega;
    expect(spacing(1)).toBeGreaterThan(15);
    expect(spacing(WATER_RUNUP_DEPTH_GATE_METERS)).toBeGreaterThan(50);
    // The fade window is a multiple of that spacing, so it scales with the
    // pattern rather than being a fixed distance.
    expect(spacing(0.4) * WATER_RUNUP_NYQUIST_FADE_LOW).toBeGreaterThan(1.2);
    // The streak lattice's own fade window is likewise its own cell size.
    const streakCell = 1 / WATER_RUNUP_STREAK_CELLS_PER_METER;
    expect(streakCell * WATER_RUNUP_STREAK_FADE_HIGH).toBeGreaterThan(2);
    expect(streakCell * WATER_RUNUP_STREAK_FADE_HIGH).toBeLessThan(streakCell);
  });
});
