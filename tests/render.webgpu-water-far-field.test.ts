import { describe, expect, it } from "vitest";
import {
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  WATER_FAR_FIELD_WGSL,
  WATER_FAR_GUST_COARSE_METERS,
  WATER_FAR_GUST_DRIFT_FRACTION,
  WATER_FAR_GUST_GAIN_MAX,
  WATER_FAR_GUST_GAIN_MIN,
  WATER_FAR_GUST_MID_METERS,
  WATER_FAR_GUST_WGSL,
  WATER_GLINT_FACET_LENGTH_METERS,
  WATER_GLINT_SPARKLE_FOOTPRINT_HIGH,
  WATER_GLINT_SPARKLE_FOOTPRINT_LOW,
  WATER_GLINT_SPARKLE_MAX_EXPONENT,
  WATER_GLINT_TWINKLE_HZ,
  WATER_ROUGH_FRESNEL_TILT,
  WATER_WHITECAP_FOOTPRINT_HIGH,
  WATER_WHITECAP_FOOTPRINT_LOW,
  WATER_WHITECAP_LIFETIME_SECONDS,
  WATER_WHITECAP_PATCH_AREA_M2,
  waterFarHash,
  waterGgxDistribution,
  waterGlintExpectedCount,
  waterRoughFresnelCosine,
  waterSparkleExponent,
  waterSparkleGain,
  waterTwinkleGain,
  waterWhitecapExpectedCount,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * wave S — the far field.
 *
 * The 2026-09-13 capture A/B (coast-10km-lowsun at +2 s of simulation time)
 * measured the shipped sea's two-second luminance change at 3/255 at 5 km,
 * 1/255 at 8 km and 0 past 12 km, on a texture whose own contrast past 4 km
 * was ~1% of full scale: the correctly filtered MEAN of a sea whose variance
 * had been folded into a static roughness. These tests pin the terms that
 * put the variance back — a mean-one glint sparkle, the same twinkle spent
 * as whitecap flecks, the far gust lanes and the rough-interface Fresnel —
 * to the one property that makes them safe to ship: none changes the
 * expected image. They also pin the vertex fix that keys the lattice fade on
 * the ring radius rather than the slant range.
 */

describe("far-field glint sparkle", () => {
  it("keeps the mean of the multiplicative gain at exactly one for every count", () => {
    for (const count of [0.01, 0.1, 0.5, 1, 3, 10, 100, 10_000]) {
      const steps = 200_000;
      let sum = 0;
      for (let step = 0; step < steps; step += 1) {
        sum += waterSparkleGain(count, (step + 0.5) / steps);
      }
      expect(sum / steps, `mean at n=${count}`).toBeCloseTo(1, 2);
    }
  });

  it("gives the gain the count's own relative variance, capped for lone facets", () => {
    for (const count of [0.5, 1, 3, 10, 100]) {
      const steps = 400_000;
      let sumSquares = 0;
      for (let step = 0; step < steps; step += 1) {
        const gain = waterSparkleGain(count, (step + 0.5) / steps);
        sumSquares += gain * gain;
      }
      const variance = sumSquares / steps - 1;
      expect(variance, `variance at n=${count}`).toBeCloseTo(1 / count, 1);
    }
    expect(waterSparkleExponent(1e-6)).toBe(WATER_GLINT_SPARKLE_MAX_EXPONENT);
    expect(waterSparkleExponent(0.01)).toBe(WATER_GLINT_SPARKLE_MAX_EXPONENT);
    expect(waterSparkleExponent(1)).toBeCloseTo(1 + Math.SQRT2, 6);
    expect(waterSparkleExponent(1e6)).toBeLessThan(0.002);
  });

  it("counts facets that aim the sun disc at the eye", () => {
    const alpha = 0.245;
    const steps = 20_000;
    let integral = 0;
    for (let step = 0; step < steps; step += 1) {
      const theta = ((step + 0.5) / steps) * (Math.PI / 2);
      const nDotH = Math.cos(theta);
      integral += waterGgxDistribution(nDotH, alpha) * nDotH * Math.sin(theta) * (Math.PI / 2 / steps);
    }
    expect(integral * 2 * Math.PI).toBeCloseTo(1, 2);

    const sunRadius = 0.004675;
    const footprint = 150;
    const facets = footprint / WATER_GLINT_FACET_LENGTH_METERS ** 2;
    const peak = waterGlintExpectedCount(1, alpha, sunRadius, footprint);
    expect(peak).toBeCloseTo(
      facets * waterGgxDistribution(1, alpha) * Math.PI * (sunRadius / 2) ** 2,
      9,
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(10);
    expect(waterGlintExpectedCount(0, alpha, sunRadius, footprint)).toBe(0);
    expect(waterGlintExpectedCount(0.5, alpha, sunRadius, footprint)).toBeLessThan(peak);
  });

  it("hashes screen cells to decorrelated uniforms in [0, 1)", () => {
    const seen = new Set<number>();
    let sum = 0;
    let count = 0;
    for (let x = 0; x < 64; x += 1) {
      for (let y = 0; y < 64; y += 1) {
        for (const seed of [1, 2, 3, 4]) {
          const value = waterFarHash(x, y, seed);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
          seen.add(value);
          sum += value;
          count += 1;
        }
      }
    }
    expect(seen.size).toBeGreaterThan(64 * 64 * 4 * 0.99);
    expect(sum / count).toBeCloseTo(0.5, 1);
    // Adjacent pixels and adjacent phases are unrelated.
    expect(Math.abs(waterFarHash(10, 10, 4) - waterFarHash(11, 10, 4))).toBeGreaterThan(0.01);
    expect(Math.abs(waterFarHash(10, 10, 4) - waterFarHash(10, 10, 6))).toBeGreaterThan(0.01);
  });

  it("twinkles with an exact mean at every instant and continuity across phases", () => {
    // Mean over many pixels at fixed phase fractions: the cross-fade of two
    // mean-one draws is mean one whatever the blend.
    for (const fraction of [0, 0.25, 0.5, 0.75]) {
      let sum = 0;
      const pixels = 40_000;
      for (let i = 0; i < pixels; i += 1) {
        sum += waterTwinkleGain(2, i % 200, Math.floor(i / 200), 37 + fraction, 1);
      }
      expect(sum / pixels, `mean at fraction ${fraction}`).toBeCloseTo(1, 1);
    }
    // No pop at the phase boundary: the end of phase p is the start of p+1.
    const before = waterTwinkleGain(2, 5, 7, 37.999999, 1);
    const after = waterTwinkleGain(2, 5, 7, 38.000001, 1);
    expect(Math.abs(before - after)).toBeLessThan(1e-3);
    // Different seeds are different clocks.
    expect(waterTwinkleGain(2, 5, 7, 37.3, 1)).not.toBeCloseTo(waterTwinkleGain(2, 5, 7, 37.3, 2), 6);
  });

  it("fades in over a footprint window that starts past the near-field glint jitter", () => {
    expect(WATER_GLINT_SPARKLE_FOOTPRINT_LOW).toBeGreaterThan(0.012);
    expect(WATER_GLINT_SPARKLE_FOOTPRINT_HIGH).toBeGreaterThan(WATER_GLINT_SPARKLE_FOOTPRINT_LOW);
    expect(WATER_FRAGMENT_WGSL).toContain("water += sunGlitter * sparkle;");
    expect(WATER_FRAGMENT_WGSL).toContain(
      `waterTwinkleGain(glintExpectedCount, fragmentInputs.position.xy, uniforms.time * ${WATER_GLINT_TWINKLE_HZ.toFixed(3)}, 1)`,
    );
    expect(WATER_FRAGMENT_WGSL).toContain("max(dot(glintNormal, glintHalfVector), 0.0)");
    expect(WATER_FRAGMENT_WGSL).toContain("roughness * roughness,\n    uniforms.sunAngularRadius,");
    expect(WATER_FRAGMENT_WGSL).toContain("var water = mix(bodyColor, reflected, fresnel);");
  });
});

describe("distant whitecap flecks", () => {
  it("expects caps in proportion to footprint area and coverage", () => {
    expect(waterWhitecapExpectedCount(0.006, 150)).toBeCloseTo((150 * 0.006) / WATER_WHITECAP_PATCH_AREA_M2, 9);
    expect(waterWhitecapExpectedCount(0, 150)).toBe(0);
    expect(waterWhitecapExpectedCount(0.01, 0)).toBe(0);
    // 800 m up, 5 km out: 0.075 caps per pixel — most pixels carry nothing.
    expect(waterWhitecapExpectedCount(0.006, 150)).toBeLessThan(0.1);
  });

  it("is discrete at range and mean-preserving: most pixels carry no cap, a few carry a real one", () => {
    const count = waterWhitecapExpectedCount(0.006, 150);
    const coverage = 0.006;
    let zero = 0;
    let sum = 0;
    let peak = 0;
    const pixels = 60_000;
    for (let i = 0; i < pixels; i += 1) {
      const opacity = coverage * waterTwinkleGain(count, i % 300, Math.floor(i / 300), 11.2, 2);
      if (opacity < coverage * 0.05) zero += 1;
      sum += opacity;
      peak = Math.max(peak, opacity);
    }
    // A single draw at k = 24 leaves ~77% of pixels under 5% of the mean; the
    // cross-fade of two draws lands near 60%.
    expect(zero / pixels).toBeGreaterThan(0.55);
    expect(sum / pixels / coverage).toBeCloseTo(1, 1);
    // A cap on a pixel that carries one is a real patch, not a half-percent haze.
    expect(peak).toBeGreaterThan(0.1);
  });

  it("hands off from the resolved foam texture on the major footprint at the whitecap lifetime", () => {
    expect(WATER_WHITECAP_FOOTPRINT_LOW).toBeGreaterThanOrEqual(4);
    expect(WATER_WHITECAP_FOOTPRINT_HIGH).toBeGreaterThan(WATER_WHITECAP_FOOTPRINT_LOW);
    expect(WATER_WHITECAP_LIFETIME_SECONDS).toBeGreaterThan(1);
    // W-9: the count is taken against the PHYSICAL coverage (Monahan's wind
    // law times the spectrum's own breaking pattern, normalised by that
    // pattern's mip mean), not against the tuned accumulator.
    expect(WATER_FRAGMENT_WGSL).toContain(
      "let whitecapCount = waterWhitecapExpectedCount(whitecapCoverage, glintFootprintArea);",
    );
    expect(WATER_FRAGMENT_WGSL).toContain("waterWhitecapCoverage(length(uniforms.oceanWind))");
    expect(WATER_FRAGMENT_WGSL).toContain(
      `waterTwinkleGain(whitecapCount, fragmentInputs.position.xy, uniforms.time / ${WATER_WHITECAP_LIFETIME_SECONDS.toFixed(2)}, 2)`,
    );
    expect(WATER_FRAGMENT_WGSL).toContain("let foam = clamp(max(windFoam, breakingFoam), 0.0, 1.0)");
    // Roughness keeps reading the mean coverage; only the composite is discrete.
    expect(WATER_FRAGMENT_WGSL).toContain("let baseRoughness = 0.075 + foamAmount * 0.2;");
    // The per-pixel cell search is gone for good: one hash pair per pixel.
    expect(WATER_FAR_FIELD_WGSL).not.toContain("for (var");
    expect(WATER_FRAGMENT_WGSL).not.toContain("waterDistantWhitecaps(");
  });
});

describe("far cat's paws and the rough-interface Fresnel", () => {
  it("raises the grazing Fresnel cosine by a fraction of the RMS slope and nothing at normal incidence", () => {
    expect(waterRoughFresnelCosine(1, 0.3)).toBe(1);
    expect(waterRoughFresnelCosine(0.3, 0)).toBeCloseTo(0.3, 9);
    const cos85 = Math.cos((85 * Math.PI) / 180);
    const rms10 = Math.sqrt(0.003 + 0.00512 * 10);
    const rough = waterRoughFresnelCosine(cos85, rms10);
    const schlick = (c: number) => 0.0204 + (1 - 0.0204) * (1 - c) ** 5;
    expect(schlick(cos85)).toBeGreaterThan(0.6);
    expect(schlick(rough)).toBeGreaterThan(0.28);
    expect(schlick(rough)).toBeLessThan(0.4);
    const ratio = (degrees: number) => {
      const c = Math.cos((degrees * Math.PI) / 180);
      return schlick(waterRoughFresnelCosine(c, rms10)) / schlick(c);
    };
    expect(ratio(60)).toBeCloseTo(1, 6);
    expect(ratio(70)).toBeGreaterThan(0.85);
    expect(ratio(80)).toBeLessThan(0.75);
    expect(ratio(85)).toBeLessThan(ratio(80));
    expect(waterRoughFresnelCosine(0.2, 0.2)).toBeGreaterThan(waterRoughFresnelCosine(0.1, 0.2));
    expect(waterRoughFresnelCosine(0.1, 0.3)).toBeGreaterThan(waterRoughFresnelCosine(0.1, 0.2));
    expect(waterRoughFresnelCosine(0.99, 5)).toBeLessThanOrEqual(1);
    expect(WATER_ROUGH_FRESNEL_TILT).toBeGreaterThan(0);
    expect(WATER_ROUGH_FRESNEL_TILT).toBeLessThan(1);
  });

  it("applies the far gust only to the short-wave variance and feeds the rough Fresnel the total", () => {
    expect(WATER_FRAGMENT_WGSL).toContain(
      "waterFarGustGain(input.farGustCoarse, input.oceanCoordinate, uniforms.oceanWind, uniforms.time, footprintMajor),\n    farGustWeight,",
    );
    expect(WATER_FRAGMENT_WGSL).toContain("let farGust = mix(\n    1.0,");
    const discardAt = WATER_FRAGMENT_WGSL.indexOf("if (depth <= 0.0) { discard; }");
    expect(WATER_FRAGMENT_WGSL.indexOf("let farGust = mix(")).toBeGreaterThan(discardAt);
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(baseSample, baseMoment, input.cascadeFades.x) * farGust;");
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(sample, moment, input.cascadeFades.y) * mix(1.0, farGust, 0.5);");
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(sample, moment, input.cascadeFades.z); cascadeJacobians.z");
    expect(WATER_FRAGMENT_WGSL).toContain("capillary.unresolvedMeanSquareSlope * farGust;");
    expect(WATER_FRAGMENT_WGSL).toContain("let fresnel = waterRoughInterfaceFresnel(\n    normal,\n    view,\n    cameraBelow,");
    expect(WATER_FRAGMENT_WGSL).toContain("sqrt(min(slopeVariance, 0.090))");
    expect(WATER_FRAGMENT_WGSL).not.toContain("let fresnel = waterInterfaceFresnel(");
    expect(WATER_FAR_FIELD_WGSL).toContain("if (cameraBelow) {\n    return waterInterfaceFresnel(normal, view, cameraBelow);");
  });

  it("evaluates the coarse octave per vertex and the warped mid octave per pixel", () => {
    expect(WATER_FAR_GUST_COARSE_METERS).toBeGreaterThan(WATER_FAR_GUST_MID_METERS);
    expect(WATER_FAR_GUST_MID_METERS).toBeGreaterThan(57);
    expect(WATER_FAR_GUST_DRIFT_FRACTION).toBeGreaterThan(0);
    expect(WATER_FAR_GUST_DRIFT_FRACTION).toBeLessThanOrEqual(1);
    // Unwrapped drift: the ripple wrap would pop the lanes by kilometres.
    expect(WATER_FAR_GUST_WGSL).toContain("worldXZ - windVelocity * time * 0.60");
    expect(WATER_FAR_GUST_WGSL).not.toContain("waterRippleDrift(");
    // The vertex carries the 1.5 km octave; the fragment warps the 380 m one by it.
    expect(WATER_VERTEX_WGSL).toContain("vertexOutputs.farGustCoarse = waterFarGustCoarse(worldXZ, uniforms.oceanWind, uniforms.time);");
    expect(WATER_VERTEX_WGSL).toContain("varying farGustCoarse: f32;");
    expect(WATER_FRAGMENT_WGSL).toContain("varying farGustCoarse: f32;");
    expect(WATER_FAR_GUST_WGSL).toContain("let warp = coarse * 0.60 * vec2f(1.0, -1.0);");
    expect(WATER_FAR_GUST_WGSL).toContain("smoothstep(600.0, 2000.0, footprintMajor)");
    expect(WATER_FAR_GUST_WGSL).toContain("smoothstep(150.0, 500.0, footprintMajor)");
    expect(WATER_FAR_GUST_WGSL).toContain("- 0.5;");
    expect(WATER_FAR_GUST_GAIN_MIN).toBeLessThan(1);
    expect(WATER_FAR_GUST_GAIN_MAX).toBeGreaterThan(1);
    // The gust block precedes the capillary block in the fragment and the
    // displacement sampling in the vertex, after the detail noise it needs.
    const noiseAt = WATER_FRAGMENT_WGSL.indexOf("fn waterDetailValue(");
    const gustAt = WATER_FRAGMENT_WGSL.indexOf("fn waterFarGustGain(");
    expect(noiseAt).toBeGreaterThanOrEqual(0);
    expect(gustAt).toBeGreaterThan(noiseAt);
    expect(WATER_VERTEX_WGSL.indexOf("fn waterFarGustCoarse(")).toBeGreaterThan(WATER_VERTEX_WGSL.indexOf("fn waterDetailValue("));
  });
});

describe("far-field block composition", () => {
  it("is composed into the ocean fragment after the shared constants and not into the vertex", () => {
    const constants = WATER_FRAGMENT_WGSL.indexOf("const PI: f32");
    const block = WATER_FRAGMENT_WGSL.indexOf("fn waterFarHash(");
    expect(constants).toBeGreaterThanOrEqual(0);
    expect(block).toBeGreaterThan(constants);
    expect(WATER_VERTEX_WGSL).not.toContain("waterFarHash");
    expect(WATER_FAR_FIELD_WGSL).toContain("fn waterTwinkleGain(");
    expect(WATER_FAR_FIELD_WGSL).toContain("fn waterWhitecapExpectedCount(");
  });

  it("takes no derivatives of its own", () => {
    expect(WATER_FAR_FIELD_WGSL).not.toContain("dpdx(");
    expect(WATER_FAR_FIELD_WGSL).not.toContain("dpdy(");
    expect(WATER_FAR_GUST_WGSL).not.toContain("dpdx(");
  });
});

describe("lattice fade keyed on ring radius", () => {
  it("fades displacement on the ring's horizontal radius and slope on slant range", () => {
    expect(WATER_VERTEX_WGSL).toContain("let meshFades = fades * vec4f(");
    expect(WATER_VERTEX_WGSL).toContain("cascadeFade(vertexRadius, uniforms.cascadeMeshFadeRadii0.z)");
    expect(WATER_VERTEX_WGSL).toContain("let meshFade4 = fade4 * cascadeFade(vertexRadius, uniforms.cascadeMeshFadeRadius4);");
    expect(WATER_VERTEX_WGSL).toContain("cascadeFade(slantRange, uniforms.cascadeFadeRadii0.x)");
    expect(WATER_VERTEX_WGSL).not.toContain("cascadeFade(slantRange, min(");
  });
});
