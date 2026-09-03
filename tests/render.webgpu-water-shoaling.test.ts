import { describe, expect, it } from "vitest";
import { HYDROLOGY_WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/HydrologySystem";
import {
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  WATER_FLOW_GRAVITY,
  WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  WATER_RUNUP_BEACH_SLOPE_MINIMUM,
  WATER_RUNUP_GRADIENT_STEP_METERS,
  WATER_SHOAL_BREAKER_INDEX_EXPONENT,
  WATER_SHOAL_BREAKER_INDEX_MAXIMUM,
  WATER_SHOAL_BREAKER_INDEX_MINIMUM,
  WATER_SHOAL_BREAKER_INDEX_REFERENCE,
  WATER_SHOAL_DEPTH_FADE_START_METERS,
  WATER_SHOAL_DEPTH_GATE_METERS,
  WATER_SHOAL_MAXIMUM_SLOPE_GAIN,
  WATER_SHOAL_MAXIMUM_TANH_ARGUMENT,
  WATER_SHOAL_WHITEWATER_COVERAGE,
  WATER_SHOALING_WGSL,
  WATER_SHORE_RUNUP_WGSL,
  waterBreakerIndex,
  waterDepthLimitedBreaking,
  waterLinearDispersion,
  waterShelfShoaling,
  waterShoalDepthGate,
  waterShoalingBand,
  waterShoalingCoefficient,
  waterShoreBandSwell,
  waterShoreRunupPhase,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * 6-3 — shelf shoaling and depth-limited breaking.
 *
 * `tests/gpu/water-shelf-shoaling.test.ts` pins the exported oracle used below
 * against the shipped WGSL on a real adapter. This file owns the physics
 * sweeps a GPU test would be too heavy to carry, the composition rules, the
 * agreement with what 6-2 draws about the same wave, and the 16 m
 * bathymetry-texel measurement with its failing control.
 */

/** The shipped cascade set's representative wavelengths, sqrt(min*max). */
const SHIPPED_WAVELENGTHS = [2, 16, 64, 256, 1024] as const;
/**
 * A 12 m/s wind sea, band by band — the same numbers 6-2's suites use, so the
 * two items are measured against ONE sea state. Per-band heights are 0.16,
 * 0.88, 1.82, 1.63 and 0.21 m.
 */
const WIND_SEA_MSS = [0.03, 0.015, 0.004, 0.0002, 0.0000002] as const;
const ALL_VISIBLE = [1, 1, 1, 1, 1] as const;
/** A representative fragment's per-cascade fade-weighted slope samples. */
const CASCADE_SLOPES = [
  [0.12, -0.05],
  [0.09, 0.04],
  [0.05, -0.02],
  [0.01, 0.005],
  [0.001, 0],
] as const;
/** A 1:17 sand beach — the slope 6-2's own Hunt worked example uses. */
const SAND_BEACH_SLOPE = 0.06;

/** The exact root of `y tanh(y) = x`, by bisection. The oracle's oracle. */
function bisectRelativeDepth(relativeDeepDepth: number): number {
  let low = 0;
  let high = Math.max(relativeDeepDepth + 1, 2);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = 0.5 * (low + high);
    if (mid * Math.tanh(mid) < relativeDeepDepth) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

describe("6-3 composition", () => {
  it("is one definition, ocean-only, and touches no vertex stage", () => {
    // The §3.6 rule. One textual copy, in the ocean fragment only: an inland
    // lake or river has no continental shelf to shoal across, exactly the
    // reason WATER_SHORE_STREAK_WGSL is ocean-only too.
    expect(WATER_FRAGMENT_WGSL).toContain(WATER_SHOALING_WGSL);
    for (const helper of [
      "fn waterShoalDepthGate(",
      "fn waterLinearDispersion(",
      "fn waterShoalingCoefficient(",
      "fn waterBreakerIndex(",
      "fn waterDepthLimitedBreaking(",
      "fn waterShoalingBand(",
      "fn waterShoalingAccumulate(",
      "fn waterShelfShoaling(",
    ]) {
      expect(WATER_FRAGMENT_WGSL.split(helper), `ocean ${helper}`).toHaveLength(2);
      expect(HYDROLOGY_WATER_FRAGMENT_WGSL, `inland ${helper}`).not.toContain(helper);
    }
    // THE FRAGMENT-VS-VERTEX CLAIM, as a source fact. Shoaling shortens
    // wavelengths, which is the band the mesh-Nyquist displacement fade
    // correctly refuses to carry; the plan says shade rather than fight it,
    // so nothing here reaches the vertex stage.
    expect(WATER_VERTEX_WGSL).not.toContain("waterShoal");
    expect(WATER_VERTEX_WGSL).not.toContain("waterShelf");
    expect(WATER_VERTEX_WGSL).not.toContain("waterLinearDispersion");
    expect(WATER_VERTEX_WGSL).not.toContain("waterBreakerIndex");
  });

  it("reuses 6-2's swell, beach-slope range and constants instead of copying them", () => {
    const code = WATER_SHOALING_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    // The band height is 6-2's law, CALLED — the one external name the block
    // uses. If 6-3 ever grew its own height law the two items would disagree
    // about how tall the wave arriving here is, which is the whole failure
    // mode this item has to avoid.
    expect(code).toContain("waterShoreBandSwell(wavelengthMeters, meanSquareSlope)");
    expect(code).not.toContain("fn waterShoreBandSwell(");
    // And the beach slope is clamped to 6-2's Hunt range, from 6-2's constants
    // — one beach-slope range for the run-up and the breaker index alike.
    expect(code).toContain(
      "clamp(beachSlope, WATER_RUNUP_BEACH_SLOPE_MINIMUM, WATER_RUNUP_BEACH_SLOPE_MAXIMUM)",
    );
    expect(code).toContain("WATER_RUNUP_TWO_PI");
    expect(code).toContain("WATER_RUNUP_MINIMUM_WAVELENGTH");
    // Neither is redeclared here — they come from the run-up block, which is
    // composed first (a WGSL duplicate would not even compile, but a renamed
    // second copy would, and that is the drift being prevented).
    expect(code).not.toContain("const WATER_RUNUP_");
    // The aggregation weight is 6-2's visible-amplitude-squared, character for
    // character the expression its argmax uses.
    expect(code).toContain("let visible = wavelengthMeters * fade;");
    expect(code).toContain("let weight = meanSquareSlope * visible * visible;");
    expect(WATER_SHORE_RUNUP_WGSL).toContain("let visible0 = wavelengths0 * fades0;");
    expect(WATER_SHORE_RUNUP_WGSL)
      .toContain("let weights0 = meanSquareSlopes0 * visible0 * visible0;");
  });

  it("declares no uniform, texture or derivative", () => {
    const code = WATER_SHOALING_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    for (const forbidden of [
      "uniforms.", "texture", "sampler", "@group", "var<", "dpdx", "dpdy", "fwidth",
    ]) {
      expect(code, `shoaling block must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // No sin-fract hash: the block is fed absolute depths and wavelengths, and
    // the recorded hash failure only appears at world scale.
    expect(code).not.toContain("fract(sin(");
    expect(code).not.toContain("fract(43758");
    // There is no lattice here at all — 6-3 introduces NO new spatial
    // frequency. Everything it varies over is a function of the bilinear
    // bathymetry sample the fragment already took, which is why the grazing
    // angle measurement below is about the bathymetry and nothing else.
    expect(code).not.toContain("floor(");
    expect(code).not.toContain("hash");
  });

  it("keeps every smoothstep window ascending", () => {
    // The reversed-smoothstep incident: the clamped helper turns a reversed
    // pair into a hard step, and ten masks shipped that way.
    expect(WATER_SHOAL_DEPTH_FADE_START_METERS).toBeLessThan(WATER_SHOAL_DEPTH_GATE_METERS);
    expect(WATER_SHOAL_BREAKER_INDEX_MINIMUM).toBeLessThan(WATER_SHOAL_BREAKER_INDEX_MAXIMUM);
    expect(WATER_SHOAL_BREAKER_INDEX_MINIMUM)
      .toBeLessThan(WATER_SHOAL_BREAKER_INDEX_REFERENCE);
    expect(WATER_SHOAL_BREAKER_INDEX_REFERENCE)
      .toBeLessThan(WATER_SHOAL_BREAKER_INDEX_MAXIMUM);
    const code = WATER_SHOALING_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    const reversed: string[] = [];
    for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/gu)) {
      if (Number(match[2]) <= Number(match[1])) reversed.push(match[0]);
    }
    expect(reversed, "shoaling reversed smoothstep").toEqual([]);
  });

  it("generates its WGSL constants from the TypeScript the oracle uses", () => {
    expect(WATER_SHOALING_WGSL).toContain(
      `const WATER_SHOAL_DEPTH_GATE_METERS: f32 = ${WATER_SHOAL_DEPTH_GATE_METERS}.0;`,
    );
    expect(WATER_SHOALING_WGSL).toContain(
      `const WATER_SHOAL_BREAKER_INDEX_REFERENCE: f32 = ${WATER_SHOAL_BREAKER_INDEX_REFERENCE};`,
    );
    expect(WATER_SHOALING_WGSL).toContain(
      `const WATER_SHOAL_BREAKER_INDEX_EXPONENT: f32 = ${WATER_SHOAL_BREAKER_INDEX_EXPONENT};`,
    );
    expect(WATER_SHOALING_WGSL).toContain(
      `const WATER_SHOAL_WHITEWATER_COVERAGE: f32 = ${WATER_SHOAL_WHITEWATER_COVERAGE};`,
    );
  });
});

describe("6-3 the linear dispersion relation", () => {
  it("solves tanh(k h) to better than 1e-3 across the whole transitional band", () => {
    // The plan's pin, made literal: every solved kh must satisfy the relation
    // it was solved from, `kh tanh(kh) = omega^2 h/g = k0 h`. Eckart's seed
    // alone is 5% off here; the Newton step is what makes this pass, and the
    // sweep spans six decades of relative depth so it covers the finest
    // cascade at the 60 m gate (kh ~ 1500) and the longest swell at the
    // waterline alike.
    let worstResidual = 0;
    let worstRoot = 0;
    for (let index = 0; index <= 240; index += 1) {
      const relativeDeepDepth = 1e-3 * Math.exp((index / 240) * Math.log(2000 / 1e-3));
      const dispersion = waterLinearDispersion(relativeDeepDepth);
      const residual = Math.abs(
        dispersion.relativeDepth * Math.tanh(dispersion.relativeDepth) - relativeDeepDepth,
      ) / relativeDeepDepth;
      const exact = bisectRelativeDepth(relativeDeepDepth);
      worstResidual = Math.max(worstResidual, residual);
      worstRoot = Math.max(worstRoot, Math.abs(dispersion.relativeDepth - exact) / exact);
    }
    expect(worstResidual, `worst dispersion residual ${worstResidual}`).toBeLessThan(1e-3);
    expect(worstRoot, `worst root error ${worstRoot}`).toBeLessThan(1e-3);
  });

  it("has the right limits and never overflows", () => {
    // Shallow: kh -> sqrt(k0 h), n -> 1 (non-dispersive, group speed = phase
    // speed). Deep: kh -> k0 h, n -> 1/2.
    const shallow = waterLinearDispersion(1e-4);
    expect(shallow.relativeDepth).toBeCloseTo(Math.sqrt(1e-4), 6);
    expect(shallow.groupSpeedRatio).toBeCloseTo(1, 4);
    // kh ~ 1500 is what the 0.25 m minimum wavelength reaches at the 60 m
    // gate. A literal `2 kh / sinh(2 kh)` is inf/inf there; the tanh rewrite
    // returns the exact deep-water limit instead.
    for (const relativeDeepDepth of [30, 100, 1500, 1e5]) {
      const deep = waterLinearDispersion(relativeDeepDepth);
      expect(Number.isFinite(deep.relativeDepth)).toBe(true);
      expect(deep.relativeDepth).toBeCloseTo(relativeDeepDepth, 3);
      // EXACTLY 0.5, in f64 as well as f32 — which is what the 20 cap buys:
      // `tanh(20)` rounds to 1 in both precisions, so the oracle and the
      // shader are bit-identical in the deep-water limit.
      expect(deep.groupSpeedRatio).toBe(0.5);
      expect(waterShoalingCoefficient(deep, relativeDeepDepth)).toBeCloseTo(1, 5);
    }
    // Monotone in both, everywhere.
    let previousRoot = 0;
    let previousRatio = 1.01;
    for (let index = 0; index <= 300; index += 1) {
      const relativeDeepDepth = 1e-3 * Math.exp((index / 300) * Math.log(1000 / 1e-3));
      const dispersion = waterLinearDispersion(relativeDeepDepth);
      expect(dispersion.relativeDepth).toBeGreaterThan(previousRoot);
      expect(dispersion.groupSpeedRatio).toBeLessThanOrEqual(previousRatio + 1e-9);
      expect(dispersion.groupSpeedRatio).toBeGreaterThanOrEqual(0.5);
      expect(dispersion.groupSpeedRatio).toBeLessThanOrEqual(1);
      previousRoot = dispersion.relativeDepth;
      previousRatio = dispersion.groupSpeedRatio;
    }
  });

  it("caps every tanh argument — the hardware defect the GPU test caught", () => {
    // WGSL's `tanh` is commonly lowered to `(e^(2x) - 1)/(e^(2x) + 1)`, which
    // overflows f32 above x = 44 and returns NaN. The finest cascade's
    // relative depth passes 44 at 14 m of depth, INSIDE the 60 m gate, and
    // `min(NaN, WATER_SHOAL_MAXIMUM_SLOPE_GAIN)` silently returned the guard —
    // so before the cap the shipped shader gave every short band a 6x slope
    // gain over most of the shelf. The f64 oracle could never have shown it;
    // `tests/gpu/water-shelf-shoaling.test.ts` did, on the first run.
    //
    // Both call sites, as a source fact, because the failure mode is silent.
    const code = WATER_SHOALING_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");
    const tanhCalls = [...code.matchAll(/tanh\(([^)]*)\)/gu)].map((match) => match[1]!);
    expect(tanhCalls.length, "tanh call sites in the shoaling block").toBe(2);
    for (const argument of tanhCalls) {
      expect(argument, `uncapped tanh argument: ${argument}`)
        .toContain("WATER_SHOAL_MAXIMUM_TANH_ARGUMENT");
    }
    // And the cap is EXACT where it binds, in BOTH precisions: tanh(20)
    // rounds to 1.0 in f64 as well as f32, so the oracle and the shader agree
    // bit-for-bit in the deep-water limit rather than approximately. (At 10 it
    // would round to 1 only in f32, and the f64 oracle would carry a residue
    // that grows with relative depth.)
    expect(Math.tanh(WATER_SHOAL_MAXIMUM_TANH_ARGUMENT)).toBe(1);
    expect(Math.fround(Math.tanh(WATER_SHOAL_MAXIMUM_TANH_ARGUMENT))).toBe(1);
    expect(Math.tanh(10)).toBeLessThan(1);
    // Well below both known lowerings' overflow points.
    expect(WATER_SHOAL_MAXIMUM_TANH_ARGUMENT).toBeLessThan(44);
    // The relative depth that used to produce the NaN, and the depth at which
    // the shipped cascade set reaches it: the 2 m band at 15 m of water, which
    // is a quarter of the way into the gate.
    expect((2 * Math.PI * 15) / 2).toBeGreaterThan(44);
    expect(15).toBeLessThan(WATER_SHOAL_DEPTH_GATE_METERS);
    // The capped solve is still correct there — deep water, exactly.
    const capped = waterLinearDispersion(56.5);
    expect(capped.groupSpeedRatio).toBe(0.5);
    expect(capped.relativeDepth).toBeCloseTo(56.5, 5);
    expect(waterShoalingCoefficient(capped, 56.5)).toBeCloseTo(1, 6);
  });

  it("agrees with 6-2's eikonal wavenumber in the shallow limit", () => {
    // THE CONSISTENCY THAT MATTERS MOST, because it is the one place the two
    // items describe the same geometry with different algebra. 6-2's run-up
    // phase is `omega (t + 2 sqrt(h)/(tan(beta) sqrt(g)))`, whose SPATIAL
    // gradient is `omega/sqrt(g h)` — the shallow-water wavenumber. 6-3 gets
    // its wavenumber by solving the full dispersion relation. In the shallow
    // limit the two must be the same number, or 6-2's foam bands would be
    // spaced by a different wave than the one 6-3 is shoaling and breaking.
    const swell = waterShoreBandSwell(64, 0.004);
    for (const depthMeters of [0.2, 0.5, 1, 2]) {
      const band = waterShoalingBand(swell, depthMeters, SAND_BEACH_SLOPE);
      const shoaledWavenumber = (band.wavenumberGain * 2 * Math.PI) / 64;
      const eikonal = swell.radianFrequency / Math.sqrt(WATER_FLOW_GRAVITY * depthMeters);
      // Measured, not asserted: the gradient of the shipped phase itself.
      const gradient = (waterShoreRunupPhase(
        depthMeters + 1e-4,
        SAND_BEACH_SLOPE,
        swell.radianFrequency,
        0,
      ) - waterShoreRunupPhase(depthMeters, SAND_BEACH_SLOPE, swell.radianFrequency, 0))
        / (1e-4 / SAND_BEACH_SLOPE);
      expect(gradient / eikonal, `depth ${depthMeters} eikonal gradient`).toBeCloseTo(1, 3);
      // The exact wavenumber is always at or ABOVE the shallow-water one, and
      // provably so: `tanh(y) <= y` makes `omega^2 = g k tanh(kh) <= g k^2 h`,
      // hence `k >= omega/sqrt(g h)`. So the disagreement has a sign, it is
      // one-sided, and it closes shoreward — 8% at 2 m, 0.3% at 0.2 m.
      expect(
        shoaledWavenumber / eikonal,
        `depth ${depthMeters} shoaled vs eikonal wavenumber`,
      ).toBeGreaterThanOrEqual(0.999);
      expect(shoaledWavenumber / eikonal).toBeLessThan(1.1);
    }
    // ...and it converges: the disagreement shrinks monotonically shoreward.
    const ratio = (depthMeters: number): number =>
      (waterShoalingBand(swell, depthMeters, SAND_BEACH_SLOPE).wavenumberGain * 2 * Math.PI) / 64
      / (swell.radianFrequency / Math.sqrt(WATER_FLOW_GRAVITY * depthMeters));
    expect(ratio(0.2)).toBeLessThan(ratio(1));
    expect(ratio(1)).toBeLessThan(ratio(4));
    expect(ratio(0.2)).toBeCloseTo(1, 2);
  });
});

describe("6-3 shoaling", () => {
  it("is Green's law in the shallow limit and unity in the deep", () => {
    // H ~ h^(-1/4): a sixteenfold reduction in depth must double the height,
    // measured through the shipped coefficient rather than assumed from it.
    const deepEnough = 2e-3;
    const shallow = waterShoalingCoefficient(waterLinearDispersion(deepEnough), deepEnough);
    const shallower = waterShoalingCoefficient(
      waterLinearDispersion(deepEnough / 16),
      deepEnough / 16,
    );
    expect(shallower / shallow).toBeCloseTo(16 ** 0.25, 2);
    // And the exponent itself, over a decade: log-log slope of -1/4.
    const low = 1e-3;
    const high = 1e-2;
    const exponent = Math.log(
      waterShoalingCoefficient(waterLinearDispersion(high), high)
      / waterShoalingCoefficient(waterLinearDispersion(low), low),
    ) / Math.log(high / low);
    expect(exponent).toBeCloseTo(-0.25, 2);
    // Deep water is exactly 1 — no shoaling offshore, by construction rather
    // than by a fade.
    expect(waterShoalingCoefficient(waterLinearDispersion(20), 20)).toBeCloseTo(1, 5);
  });

  it("dips below 1 before it rises, where the textbook says it does", () => {
    // The full coefficient is NOT monotone: a swell crossing onto the shelf
    // first flattens slightly (the group speed has not yet caught the phase
    // speed) and only then stacks up. The minimum is 0.913 at h/L0 = 0.157,
    // i.e. k0 h = 0.986 — a closed-form landmark Green's law alone cannot
    // produce, which is the reason the full coefficient is carried at all.
    let minimum = Number.POSITIVE_INFINITY;
    let minimumAt = 0;
    for (let index = 0; index <= 4000; index += 1) {
      const relativeDeepDepth = 0.02 * Math.exp((index / 4000) * Math.log(300 / 0.02));
      const value = waterShoalingCoefficient(
        waterLinearDispersion(relativeDeepDepth),
        relativeDeepDepth,
      );
      if (value < minimum) {
        minimum = value;
        minimumAt = relativeDeepDepth;
      }
    }
    expect(minimum).toBeCloseTo(0.9129, 2);
    expect(minimumAt).toBeCloseTo(0.986, 1);
    expect(minimumAt / (2 * Math.PI), "h/L0 at the shoaling minimum").toBeCloseTo(0.157, 2);
  });

  it("steepens the swell approaching shore, then flattens it as it breaks", () => {
    // The whole visible arc of the item, in one sweep, for the shipped 64 m
    // swell on a 1:17 beach. Slope is amplitude times wavenumber, so the
    // shortening dominates: the sea is 1.6x steeper at 3 m of depth than
    // offshore, and then the depth limit takes it apart.
    const swell = waterShoreBandSwell(64, 0.004);
    const gain = (depthMeters: number): number =>
      waterShoalingBand(swell, depthMeters, SAND_BEACH_SLOPE).slopeGain;
    expect(gain(50)).toBeCloseTo(1, 2);
    expect(gain(20)).toBeLessThan(1);
    expect(gain(8)).toBeGreaterThan(1.15);
    expect(gain(3)).toBeGreaterThan(1.6);
    expect(gain(3)).toBeLessThan(1.7);
    expect(gain(1)).toBeLessThan(gain(3));
    expect(gain(0.25)).toBeLessThan(0.7);
    // The peak is inside the surf zone and it is a real interior maximum, not
    // an endpoint.
    let peak = 0;
    let peakDepth = 0;
    for (let depthMeters = 0.05; depthMeters < 60; depthMeters += 0.05) {
      const value = gain(depthMeters);
      if (value > peak) {
        peak = value;
        peakDepth = depthMeters;
      }
    }
    expect(peak).toBeLessThan(WATER_SHOAL_MAXIMUM_SLOPE_GAIN);
    expect(peakDepth).toBeGreaterThan(1.5);
    expect(peakDepth).toBeLessThan(6);
  });
});

describe("6-3 depth-limited breaking", () => {
  it("caps the height at gamma h identically, and approaches it from below", () => {
    // `H sqrt(1 - exp(-R^2)) <= H R = gamma h` for every R, because
    // `1 - e^(-x) <= x`. This is the depth limit ENFORCED, not approximated —
    // and it is the property that lets the cap be smooth without ever being
    // exceeded. Swept over four decades of height against four of depth.
    for (const shoaledHeight of [0.01, 0.1, 0.5, 2, 8, 30]) {
      for (const depthMeters of [0.01, 0.1, 0.5, 2, 8, 40, 200]) {
        for (const breakerIndex of [0.6, 0.78, 0.9]) {
          const breaking = waterDepthLimitedBreaking(shoaledHeight, depthMeters, breakerIndex);
          const survivingHeight = shoaledHeight * breaking.heightGain;
          expect(
            survivingHeight,
            `H ${shoaledHeight} h ${depthMeters} gamma ${breakerIndex}`,
          ).toBeLessThanOrEqual(breakerIndex * depthMeters + 1e-12);
          expect(breaking.whitewater).toBeGreaterThanOrEqual(0);
          expect(breaking.whitewater).toBeLessThanOrEqual(1);
        }
      }
    }
    // In the shallow limit the cap is TIGHT — the surviving height IS gamma h,
    // not something under it, so the model really is depth-limited rather than
    // merely bounded.
    const shallow = waterDepthLimitedBreaking(4, 0.05, 0.78);
    expect((4 * shallow.heightGain) / (0.78 * 0.05)).toBeCloseTo(1, 3);
    expect(shallow.whitewater).toBeGreaterThan(0.999);
    // Offshore nothing breaks and the height is untouched.
    const offshore = waterDepthLimitedBreaking(2, 60, 0.78);
    expect(offshore.whitewater).toBeLessThan(1e-6);
    expect(offshore.heightGain).toBeCloseTo(1, 6);
    // A band with no height keeps all of its zero height rather than being
    // silently erased — this is what makes an unrun cascade the identity.
    expect(waterDepthLimitedBreaking(0, 3, 0.78)).toEqual({ whitewater: 0, heightGain: 1 });
  });

  it("puts the breaker index in the 0.6-0.9 envelope and raises it with slope", () => {
    const steepness = waterShoreBandSwell(64, 0.004).waveHeightMeters / 64;
    // McCowan's anchor: an Iribarren number of 1 is exactly 0.78, whatever
    // combination of slope and steepness produces it.
    const anchorSlope = Math.sqrt(steepness);
    expect(waterBreakerIndex(anchorSlope, steepness))
      .toBeCloseTo(WATER_SHOAL_BREAKER_INDEX_REFERENCE, 6);
    // Monotone non-decreasing in slope over the whole clamp range, and never
    // outside the envelope.
    let previous = 0;
    for (let slope = 0.001; slope <= 0.6; slope += 0.001) {
      const index = waterBreakerIndex(slope, steepness);
      expect(index).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(index).toBeGreaterThanOrEqual(WATER_SHOAL_BREAKER_INDEX_MINIMUM);
      expect(index).toBeLessThanOrEqual(WATER_SHOAL_BREAKER_INDEX_MAXIMUM);
      previous = index;
    }
    // The named working points, so a retune has to move a number here too.
    expect(waterBreakerIndex(0.06, steepness)).toBeCloseTo(0.654, 3);
    expect(waterBreakerIndex(0.1, steepness)).toBeCloseTo(0.714, 3);
    expect(waterBreakerIndex(0.2, steepness)).toBeCloseTo(0.803, 3);
    // The slope dependence is REAL and not a rounding: the reflective end
    // carries a 23% higher index than the dissipative end.
    expect(waterBreakerIndex(0.2, steepness) / waterBreakerIndex(0.02, steepness))
      .toBeGreaterThan(1.2);
    // It is Iribarren, so it responds to steepness too, in the right
    // direction: a steeper sea on the same beach breaks at a LOWER index.
    expect(waterBreakerIndex(0.1, steepness * 4)).toBeLessThan(waterBreakerIndex(0.1, steepness));
    // The slope clamps are 6-2's, so a cliff and a mudflat both saturate.
    expect(waterBreakerIndex(4, steepness))
      .toBe(waterBreakerIndex(WATER_RUNUP_BEACH_SLOPE_MAXIMUM, steepness));
    expect(waterBreakerIndex(0, steepness))
      .toBe(waterBreakerIndex(WATER_RUNUP_BEACH_SLOPE_MINIMUM, steepness));
  });

  it("moves the surf line offshore when the sea gets bigger — the recognisable behaviour", () => {
    // The one thing everyone knows about surf: a big swell breaks further out.
    // Measured as the depth at which half the visible energy is breaking,
    // through the shipped aggregate.
    const halfBreakingDepth = (scale: number): number => {
      const meanSquareSlopes = WIND_SEA_MSS.map((value) => value * scale * scale) as unknown as
        readonly [number, number, number, number, number];
      for (let depthMeters = 40; depthMeters > 0.05; depthMeters -= 0.01) {
        const shelf = waterShelfShoaling(
          SHIPPED_WAVELENGTHS,
          meanSquareSlopes,
          ALL_VISIBLE,
          CASCADE_SLOPES,
          depthMeters,
          SAND_BEACH_SLOPE,
        );
        if (shelf.whitewater >= 0.5) return depthMeters;
      }
      return 0;
    };
    const calm = halfBreakingDepth(0.25);
    const shipped = halfBreakingDepth(1);
    const storm = halfBreakingDepth(4);
    expect(calm).toBeLessThan(shipped);
    expect(shipped).toBeLessThan(storm);
    // And the scaling is roughly linear in height, as `gamma h = H` demands.
    expect(shipped / calm).toBeGreaterThan(2.5);
    expect(storm / shipped).toBeGreaterThan(2.5);
    // A steeper beach breaks the same sea nearer in, because gamma is higher.
    const onSlope = (beachSlope: number): number => {
      for (let depthMeters = 40; depthMeters > 0.05; depthMeters -= 0.01) {
        const shelf = waterShelfShoaling(
          SHIPPED_WAVELENGTHS,
          WIND_SEA_MSS,
          ALL_VISIBLE,
          CASCADE_SLOPES,
          depthMeters,
          beachSlope,
        );
        if (shelf.whitewater >= 0.5) return depthMeters;
      }
      return 0;
    };
    expect(onSlope(0.2)).toBeLessThan(onSlope(0.02));
  });
});

describe("6-3 the depth gate", () => {
  it("is exactly the plan's 60 m, faded, and exactly off beyond it", () => {
    expect(WATER_SHOAL_DEPTH_GATE_METERS).toBe(60);
    expect(waterShoalDepthGate(0)).toBe(1);
    expect(waterShoalDepthGate(WATER_SHOAL_DEPTH_FADE_START_METERS)).toBe(1);
    expect(waterShoalDepthGate(WATER_SHOAL_DEPTH_GATE_METERS)).toBe(0);
    expect(waterShoalDepthGate(120)).toBe(0);
    // The whole aggregate, not just the gate: past 60 m the shelf term is a
    // pair of exact zeros, so open water is untouched by construction rather
    // than by a small number.
    for (const depthMeters of [60, 61, 80, 200, 4000]) {
      const shelf = waterShelfShoaling(
        SHIPPED_WAVELENGTHS,
        WIND_SEA_MSS,
        ALL_VISIBLE,
        CASCADE_SLOPES,
        depthMeters,
        SAND_BEACH_SLOPE,
      );
      expect(Math.abs(shelf.slopeDelta[0]), `depth ${depthMeters}`).toBe(0);
      expect(Math.abs(shelf.slopeDelta[1]), `depth ${depthMeters}`).toBe(0);
      expect(shelf.whitewater, `depth ${depthMeters}`).toBe(0);
    }
    // The fade is genuinely needed rather than belt-and-braces: at the gate
    // the LONGEST band's coefficient is still 7% away from 1, so a hard edge
    // would step. 12 m of depth is hundreds of metres of a real shelf.
    const longSwell = waterShoreBandSwell(256, 0.0002);
    expect(waterShoalingBand(longSwell, 60, SAND_BEACH_SLOPE).shoalingCoefficient)
      .toBeLessThan(0.94);
    expect(waterShoalingBand(longSwell, 60, SAND_BEACH_SLOPE).shoalingCoefficient)
      .toBeGreaterThan(0.9);
  });

  it("gates the ocean fragment on it, and pays one compare in open water", () => {
    const code = WATER_FRAGMENT_WGSL.replace(/\/\/.*$/gmu, "");
    expect(code).toContain("if (depth < WATER_SHOAL_DEPTH_GATE_METERS) {");
    // 6-2's own gate is now NESTED inside it, so there is exactly one
    // bathymetry-slope probe and one dominant-band selection for both items.
    expect(code.indexOf("if (depth < WATER_SHOAL_DEPTH_GATE_METERS) {"))
      .toBeLessThan(code.indexOf("if (runupGate > 0.001) {"));
    // One definition plus exactly ONE call site each: three fragments from a
    // split on two occurrences. Two call sites would mean the shelf and the
    // run-up had each grown their own bed probe or their own swell.
    expect(code.split("waterBathymetryBedSlope(")).toHaveLength(3);
    expect(code.split("waterDominantShoreSwell(")).toHaveLength(3);
    expect(code.split("waterShelfShoaling(")).toHaveLength(3);
    // The shore block sits ABOVE the capillary call: the shoaled slope has to
    // be the resolved slope the unresolved tail is fitted against, and the
    // whitewater has to reach foamAmount before baseRoughness reads it.
    expect(code.indexOf("if (depth < WATER_SHOAL_DEPTH_GATE_METERS) {"))
      .toBeLessThan(code.indexOf("let capillary = waterCapillaryDetail("));
    expect(code.indexOf("foamAmount = max(\n    foamAmount,\n    shelfWhitewater"))
      .toBeLessThan(code.indexOf("let baseRoughness = 0.075 + foamAmount * 0.2;"));
    // The derivatives the fades need are still taken in uniform control flow.
    expect(code.indexOf("let runupDerivativeX = dpdx("))
      .toBeLessThan(code.indexOf("if (depth < WATER_SHOAL_DEPTH_GATE_METERS) {"));
  });
});

describe("6-3 and 6-2 draw the same wave", () => {
  it("gates 6-2's bore and streaks by 6-3's breaking fraction", () => {
    const code = WATER_FRAGMENT_WGSL.replace(/\/\/.*$/gmu, "");
    // Swash is what a wave does AFTER it breaks. Both of 6-2's modulations are
    // weighted by the breaking fraction, so a wave 6-3 says is unbroken at 3 m
    // of depth cannot be drawn as a bore there.
    expect(code).toContain(
      "let bore = mix(1.0, waterShoreBore(runupPhase), runupGate * resolvedRunup * shelfWhitewater);",
    );
    expect(code).toContain("let streakWeight = streakFade * shelfWhitewater * (1.0 - smoothstep(");
    // Wave R's guarantee survives verbatim: the band still rises from ZERO at
    // the waterline, so a modulated band is still exactly zero on dry land.
    expect(code).toContain("smoothstep(0.0, 1.1, depth) * (1.0 - smoothstep(1.2, 7.5, depth))");
    // ...and 6-3's whitewater is masked by the SAME ramp for the same reason.
    expect(code).toContain(
      "shelfWhitewater * WATER_SHOAL_WHITEWATER_COVERAGE * smoothstep(0.0, 1.1, depth)",
    );
    // It joins the foam accumulator the spectrum's own whitecaps use rather
    // than a parallel foam system, so it inherits the advected Worley
    // break-up and raises roughness as well as brightness.
    expect(code).toContain("foamAmount = max(");
    expect(code).toContain("let foam = clamp(max(foamAmount * 1.18, shoreFoam), 0.0, 1.0)");
  });

  it("keeps the gating mean-preserving, so 6-2's pinned coverage does not move", () => {
    // `mix(1, bore, w)` has cycle mean 1 for EVERY weight, because `bore` has
    // cycle mean 1 — so weighting 6-2's bore by the breaking fraction changes
    // when and where the surf beats without touching its time-averaged
    // coverage. Measured over a full beat at four breaking fractions.
    const swell = waterShoreBandSwell(64, 0.004);
    const period = (2 * Math.PI) / swell.radianFrequency;
    for (const weight of [0, 0.17, 0.63, 1]) {
      let sum = 0;
      const samples = 4096;
      for (let index = 0; index < samples; index += 1) {
        const phase = waterShoreRunupPhase(
          1.2,
          SAND_BEACH_SLOPE,
          swell.radianFrequency,
          (index / samples) * period,
        );
        // The shipped composition: mix(1, bore, gate * resolved * whitewater).
        sum += 1 + weight * (
          (1 + 1.6 * (Math.max(Math.sin(phase), 0) ** 3 - 2 / (3 * Math.PI))) - 1
        );
      }
      expect(sum / samples, `bore mean at weight ${weight}`).toBeCloseTo(1, 3);
    }
  });

  it("agrees with 6-2 about which band is arriving, because it is the same weight", () => {
    // 6-2 takes the argmax of `mss (lambda fade)^2`; 6-3 takes the weighted
    // mean over the same numbers. So the band that sets the run-up's beat is
    // the band that dominates the breaking fraction — asserted by measuring
    // both from the same inputs rather than by reading the source.
    const laneWeights = SHIPPED_WAVELENGTHS.map(
      (wavelength, lane) => WIND_SEA_MSS[lane]! * wavelength * wavelength,
    );
    const dominantLane = laneWeights.indexOf(Math.max(...laneWeights));
    expect(SHIPPED_WAVELENGTHS[dominantLane]).toBe(64);
    // Remove every band but the dominant one and the aggregate barely moves —
    // it is that band's own breaking fraction, to within the long swell's
    // contribution.
    const all = waterShelfShoaling(
      SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES, 2, SAND_BEACH_SLOPE,
    );
    const dominantOnly = waterShoalingBand(
      waterShoreBandSwell(64, 0.004), 2, SAND_BEACH_SLOPE,
    );
    expect(all.whitewater / dominantOnly.whitewater).toBeGreaterThan(0.8);
    expect(all.whitewater / dominantOnly.whitewater).toBeLessThan(1.2);
    // Fading the dominant band out moves BOTH: the surf re-beats on the next
    // band (6-2's own pinned behaviour) and the breaking fraction follows it
    // to that band's own, later, break depth.
    const faded = waterShelfShoaling(
      SHIPPED_WAVELENGTHS,
      WIND_SEA_MSS,
      [1, 1, 0, 1, 1],
      CASCADE_SLOPES,
      2,
      SAND_BEACH_SLOPE,
    );
    expect(faded.whitewater).not.toBeCloseTo(all.whitewater, 3);
    expect(faded.weight).toBeLessThan(all.weight);
  });

  it("has the surf zone the shipped sea actually implies", () => {
    // Numbers, so a retune has to move one here. The shipped 12 m/s sea on a
    // 1:17 beach: nothing breaking at 8 m, scattered crests at 4 m, half the
    // energy at 2.4 m, and a continuous whitewater sheet inside 1 m — which is
    // the same 0.4-8 m band wave R's shore foam already occupies, now with a
    // physical profile inside it instead of a hand-drawn window.
    const whitewaterAt = (depthMeters: number): number => waterShelfShoaling(
      SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES, depthMeters, SAND_BEACH_SLOPE,
    ).whitewater;
    expect(whitewaterAt(12)).toBeLessThan(0.001);
    expect(whitewaterAt(8)).toBeLessThan(0.01);
    expect(whitewaterAt(4)).toBeGreaterThan(0.05);
    expect(whitewaterAt(4)).toBeLessThan(0.25);
    expect(whitewaterAt(2)).toBeGreaterThan(0.5);
    expect(whitewaterAt(1)).toBeGreaterThan(0.85);
    expect(whitewaterAt(0.3)).toBeGreaterThan(0.98);
    // Monotone shoreward: the surf zone is a band, never a ring.
    let previous = -1;
    for (let depthMeters = 20; depthMeters > 0.05; depthMeters -= 0.05) {
      const value = whitewaterAt(depthMeters);
      expect(value, `whitewater at ${depthMeters}`).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
    // And the foam it produces is bright but not paint.
    expect(WATER_SHOAL_WHITEWATER_COVERAGE * 1.18).toBeGreaterThan(0.7);
    expect(WATER_SHOAL_WHITEWATER_COVERAGE * 1.18).toBeLessThan(1);
  });
});

/**
 * The 16 m bathymetry texel — the resolution floor, measured the way 6-2
 * measured it, on 6-3's own outputs.
 *
 * The chain reproduced below is the shipped one: a bilinear bed on a 16 m
 * lattice, the 3-tap forward difference `waterBathymetryBedSlope` takes, and
 * the shoaling/breaking terms built from the resulting depth and slope. The
 * claim is that both outputs are C0 across texel boundaries — no STEP — which
 * is what "does not reveal the grid" means for a term whose curvature is
 * allowed to crease.
 *
 * A control runs the same chain against a POINT-SAMPLED bed, and the test
 * REQUIRES the control to fail the same bound. Without that the measurement
 * would pass on any smooth function and prove nothing.
 */
const TEXEL_METERS = 16;

function bedHash(cellX: number, cellZ: number): number {
  let h = (Math.imul(cellX | 0, 0x27d4eb2d) ^ Math.imul(cellZ | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h / 0xffffffff;
}

/** A 1:60 beach with texel-scale relief, bilinear between 16 m lattice points. */
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

interface Transect {
  readonly xs: number[];
  readonly slopeGains: number[];
  readonly whitewaters: number[];
}

function shelfAlongTransect(bed: (x: number, z: number) => number): Transect {
  const xs: number[] = [];
  const slopeGains: number[] = [];
  const whitewaters: number[] = [];
  const z = 733.5;
  // The band the shelf term is visible in (0.4 m to 8 m of depth) spans ~450 m
  // on a 1:60 beach, i.e. 28 texel boundaries.
  for (let x = -520; x <= -10; x += 0.25) {
    const here = bed(x, z);
    const depthMeters = Math.max(-here, 0);
    if (depthMeters < 0.4 || depthMeters > 8) continue;
    const beachSlope = Math.hypot(
      (bed(x + WATER_RUNUP_GRADIENT_STEP_METERS, z) - here) / WATER_RUNUP_GRADIENT_STEP_METERS,
      (bed(x, z + WATER_RUNUP_GRADIENT_STEP_METERS) - here) / WATER_RUNUP_GRADIENT_STEP_METERS,
    );
    const shelf = waterShelfShoaling(
      SHIPPED_WAVELENGTHS,
      WIND_SEA_MSS,
      ALL_VISIBLE,
      CASCADE_SLOPES,
      depthMeters,
      beachSlope,
    );
    xs.push(x);
    // The slope delta's magnitude relative to the base slope sum is what the
    // normal actually sees.
    slopeGains.push(Math.hypot(shelf.slopeDelta[0], shelf.slopeDelta[1]));
    whitewaters.push(shelf.whitewater);
  }
  return { xs, slopeGains, whitewaters };
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

describe("6-3 the 16 m bathymetry texel", () => {
  it("does not step at texel boundaries", () => {
    const transect = shelfAlongTransect(bilinearBed);
    for (const [label, values] of [
      ["slope delta", transect.slopeGains],
      ["whitewater", transect.whitewaters],
    ] as const) {
      const split = boundarySplit(transect.xs, values);
      // Every input is a bilinear sample or a difference of two, and the whole
      // shelf term is smooth arithmetic on them, so it is C0 in world
      // position: a step across a boundary is no larger than a step inside a
      // texel. 1.6x is 6-2's own honest bound — the field's curvature differs
      // either side of a crease, so the ratio is not exactly 1.
      expect(split.atBoundary / split.elsewhere, `${label} boundary ratio`).toBeLessThan(1.6);
      // And the term is genuinely varying, so the ratio is not a division of
      // two zeros.
      expect(split.elsewhere, `${label} interior variation`).toBeGreaterThan(1e-6);
    }
    // Both outputs sweep a real range across the surf zone — the measurement
    // is on a signal, not on a constant.
    expect(Math.max(...transect.whitewaters) - Math.min(...transect.whitewaters))
      .toBeGreaterThan(0.5);
    expect(Math.max(...transect.slopeGains)).toBeGreaterThan(0.02);
  });

  it("would step if the bathymetry were not filtered (the control)", () => {
    // The measurement above is only worth having if it can fail. Point-sample
    // the same bed and the boundary steps become the whole signal.
    const transect = shelfAlongTransect(pointSampledBed);
    for (const [label, values] of [
      ["slope delta", transect.slopeGains],
      ["whitewater", transect.whitewaters],
    ] as const) {
      const split = boundarySplit(transect.xs, values);
      expect(split.atBoundary / split.elsewhere, `${label} control ratio`).toBeGreaterThan(3);
    }
  });

  it("adds no spatial frequency of its own, so grazing angles have nothing to alias", () => {
    // The other way a term prints a grid is by aliasing a lattice. 6-3 has no
    // lattice: every output is a smooth function of ONE scalar the fragment
    // already sampled bilinearly (depth) and one difference of two more
    // (beach slope). The property that makes that safe is Lipschitz
    // continuity in depth — measured here as a bounded derivative over the
    // whole gated range, so no footprint can straddle a jump.
    let worst = 0;
    let worstDepth = 0;
    const step = 1e-3;
    for (let depthMeters = step; depthMeters < WATER_SHOAL_DEPTH_GATE_METERS; depthMeters += 0.01) {
      const low = waterShelfShoaling(
        SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES,
        depthMeters, SAND_BEACH_SLOPE,
      );
      const high = waterShelfShoaling(
        SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES,
        depthMeters + step, SAND_BEACH_SLOPE,
      );
      const derivative = Math.abs(high.whitewater - low.whitewater) / step;
      if (derivative > worst) {
        worst = derivative;
        worstDepth = depthMeters;
      }
    }
    // Under 1 per metre of depth: on the 1:60 beach above that is under
    // 0.017 per metre of ground, so the whitewater edge is tens of metres
    // wide however grazing the view gets.
    expect(worst, `worst d(whitewater)/d(depth) ${worst} at ${worstDepth} m`).toBeLessThan(1);
    expect(worst).toBeGreaterThan(0.05);
    // The same for the beach-slope argument, which is the one input that
    // creases at a texel edge: bounded response means a crease stays a crease
    // rather than becoming an edge.
    let slopeWorst = 0;
    for (let beachSlope = 0.002; beachSlope < 0.5; beachSlope += 0.001) {
      const low = waterShelfShoaling(
        SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES, 2, beachSlope,
      );
      const high = waterShelfShoaling(
        SHIPPED_WAVELENGTHS, WIND_SEA_MSS, ALL_VISIBLE, CASCADE_SLOPES, 2, beachSlope + 1e-4,
      );
      slopeWorst = Math.max(slopeWorst, Math.abs(high.whitewater - low.whitewater) / 1e-4);
    }
    expect(slopeWorst, `worst d(whitewater)/d(slope) ${slopeWorst}`).toBeLessThan(3);
  });
});
