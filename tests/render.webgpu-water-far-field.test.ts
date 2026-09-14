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
  WATER_GLINT_FACET_LENGTH_METERS,
  WATER_GLINT_SPARKLE_FOOTPRINT_HIGH,
  WATER_GLINT_SPARKLE_FOOTPRINT_LOW,
  WATER_GLINT_SPARKLE_MAX_EXPONENT,
  WATER_WHITECAP_CELL_METERS,
  WATER_WHITECAP_FOOTPRINT_HIGH,
  WATER_WHITECAP_FOOTPRINT_LOW,
  WATER_WHITECAP_LIFETIME_SECONDS,
  WATER_WHITECAP_MAX_CELLS_PER_AXIS,
  WATER_WHITECAP_PATCH_AREA_M2,
  WATER_ROUGH_FRESNEL_TILT,
  waterDistantWhitecaps,
  waterRoughFresnelCosine,
  waterGgxDistribution,
  waterGlintExpectedCount,
  waterHash3,
  waterSmoothBox,
  waterSparkleExponent,
  waterSparkleGain,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * wave S — the far field.
 *
 * The 2026-09-13 capture A/B (coast-10km-lowsun at +2 s of simulation time)
 * measured the shipped sea's two-second luminance change at 3/255 at 5 km,
 * 1/255 at 8 km and 0 past 12 km, on a texture whose own contrast past 4 km
 * was ~1% of full scale: the correctly filtered MEAN of a sea whose variance
 * had been folded into a static roughness. These tests pin the two terms that
 * put the variance back — a mean-one glint sparkle and discrete whitecap
 * flecks — to the one property that makes them safe to ship: neither changes
 * the expected image. They also pin the vertex fix that keys the lattice fade
 * on the ring radius rather than the slant range.
 */

/** Deterministic LCG so the Monte-Carlo below never touches Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("far-field glint sparkle", () => {
  it("keeps the mean of the multiplicative gain at exactly one for every count", () => {
    // Midpoint rule over u in [0, 1): the mean of (k+1)·u^k is 1 analytically;
    // the numerical residual is the integration error at the spikiest k.
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
    // Below the cap's equivalent count the spikiness stops growing.
    expect(waterSparkleExponent(1e-6)).toBe(WATER_GLINT_SPARKLE_MAX_EXPONENT);
    expect(waterSparkleExponent(0.01)).toBe(WATER_GLINT_SPARKLE_MAX_EXPONENT);
    expect(waterSparkleExponent(1)).toBeCloseTo(1 + Math.SQRT2, 6);
    expect(waterSparkleExponent(1e6)).toBeLessThan(0.002);
  });

  it("counts facets that aim the sun disc at the eye", () => {
    // GGX normalisation: ∫ D(m)(n·m) dm = 1 over the hemisphere, so the count
    // over the whole hemisphere of normals equals the facet count.
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
    const footprint = 150; // m², a pixel at 5 km from 800 m
    const facets = footprint / WATER_GLINT_FACET_LENGTH_METERS ** 2;
    const peak = waterGlintExpectedCount(1, alpha, sunRadius, footprint);
    expect(peak).toBeCloseTo(
      facets * waterGgxDistribution(1, alpha) * Math.PI * (sunRadius / 2) ** 2,
      9,
    );
    // Order of magnitude the design note quotes: a few glints per pixel at
    // the path centre from 800 m, none facing away from the half vector.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(10);
    expect(waterGlintExpectedCount(0, alpha, sunRadius, footprint)).toBe(0);
    expect(waterGlintExpectedCount(0.5, alpha, sunRadius, footprint))
      .toBeLessThan(peak);
  });

  it("fades in over a footprint window that starts past the near-field glint jitter", () => {
    expect(WATER_GLINT_SPARKLE_FOOTPRINT_LOW).toBeGreaterThan(0.012);
    expect(WATER_GLINT_SPARKLE_FOOTPRINT_HIGH).toBeGreaterThan(WATER_GLINT_SPARKLE_FOOTPRINT_LOW);
    expect(WATER_FRAGMENT_WGSL).toContain("water += sunGlitter * sparkle;");
    expect(WATER_FRAGMENT_WGSL).toContain("waterDistantGlintGain(");
    expect(WATER_FRAGMENT_WGSL).toContain("fragmentInputs.position.xy");
    // The sun lobe's own inputs feed the count, so the two cannot disagree.
    expect(WATER_FRAGMENT_WGSL).toContain("max(dot(glintNormal, glintHalfVector), 0.0)");
    expect(WATER_FRAGMENT_WGSL).toContain("roughness * roughness,\n    uniforms.sunAngularRadius,");
    // The reflection and Fresnel never see the sparkle.
    expect(WATER_FRAGMENT_WGSL).toContain("var water = mix(bodyColor, reflected, fresnel);");
  });
});

describe("distant whitecap flecks", () => {
  it("hashes to uniforms in [0, 1) that decorrelate across cells and seeds", () => {
    const seen = new Set<string>();
    let sum = 0;
    let count = 0;
    for (let x = -20; x < 20; x += 1) {
      for (let y = -20; y < 20; y += 1) {
        for (const seed of [1, 2, 7]) {
          const [a, b, c] = waterHash3(x, y, seed);
          for (const value of [a, b, c]) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
            sum += value;
            count += 1;
          }
          seen.add(`${a.toFixed(6)}:${b.toFixed(6)}:${c.toFixed(6)}`);
        }
      }
    }
    expect(seen.size).toBe(40 * 40 * 3);
    expect(sum / count).toBeCloseTo(0.5, 1);
  });

  it("uses an antialiased box whose integral is its width", () => {
    for (const halfWidth of [0.5, 1, 3.7]) {
      let integral = 0;
      const step = 0.001;
      for (let x = -halfWidth - 2; x <= halfWidth + 2; x += step) {
        integral += waterSmoothBox(x, halfWidth) * step;
      }
      expect(integral).toBeCloseTo(2 * halfWidth, 2);
    }
    expect(waterSmoothBox(0, 0.5)).toBe(1);
    expect(waterSmoothBox(2, 0.5)).toBe(0);
  });

  it("represents Monahan's coverage band exactly with one patch per lane per cell", () => {
    // One patch per lane per 32 m cell: the expected count per lane stays
    // under the dense hand-off up to three times the 11 m/s coverage.
    const perLane = (coverage: number) =>
      (WATER_WHITECAP_CELL_METERS ** 2 * coverage) / (2 * WATER_WHITECAP_PATCH_AREA_M2);
    expect(perLane(0.0137)).toBeLessThan(0.8);
    expect(perLane(0.02)).toBeLessThan(1);
    expect(WATER_WHITECAP_MAX_CELLS_PER_AXIS).toBeGreaterThanOrEqual(3);
  });

  it("spends the coverage as patches whose expected opacity is the coverage", () => {
    // Monte-Carlo over pixel positions and times for three footprints: a
    // grazing 800 m / 5 km pixel, a steeper one, and a farther one whose box
    // still fits the bounded search. The expectation must match the coverage
    // the mean field would have painted, and the search must be fully valid.
    const random = lcg(0x5eed);
    const cases: Array<{
      readonly dX: readonly [number, number];
      readonly dY: readonly [number, number];
      readonly coverage: number;
    }> = [
      { dX: [2.4, 0.3], dY: [-0.4, 48], coverage: 0.006 },
      { dX: [1.5, 0], dY: [0, 6], coverage: 0.003 },
      { dX: [4, 0.4], dY: [0.8, 56], coverage: 0.002 },
    ];
    for (const { dX, dY, coverage } of cases) {
      const samples = 60_000;
      let sum = 0;
      let minValidity = 1;
      for (let sample = 0; sample < samples; sample += 1) {
        const worldX = (random() - 0.5) * 20_000;
        const worldZ = (random() - 0.5) * 20_000;
        const time = random() * 400;
        const flecks = waterDistantWhitecaps(coverage, worldX, worldZ, dX, dY, time);
        sum += flecks.opacity;
        minValidity = Math.min(minValidity, flecks.validity);
      }
      const mean = sum / samples;
      expect(minValidity, `validity for dX=${dX} dY=${dY}`).toBe(1);
      expect(mean / coverage, `mean/coverage for dX=${dX} dY=${dY}`).toBeGreaterThan(0.94);
      expect(mean / coverage, `mean/coverage for dX=${dX} dY=${dY}`).toBeLessThan(1.06);
    }
  });

  it("staggers the caps' lifetimes so the sea-wide foam does not pulse in unison", () => {
    // With one global clock per lane the spatial mean at a fixed instant
    // swung between 0.785 and 1.11 of the coverage every 1.6 s (measured on
    // the mirror). With a per-cell phase it stays within a few percent.
    const random = lcg(0x9a5e);
    const dX: readonly [number, number] = [2.4, 0.3];
    const dY: readonly [number, number] = [-0.4, 48];
    const coverage = 0.006;
    for (const fraction of [0, 0.125, 0.25, 0.375, 0.5]) {
      const time = WATER_WHITECAP_LIFETIME_SECONDS * (7 + fraction);
      const samples = 60_000;
      let sum = 0;
      for (let sample = 0; sample < samples; sample += 1) {
        sum += waterDistantWhitecaps(
          coverage,
          (random() - 0.5) * 40_000,
          (random() - 0.5) * 40_000,
          dX,
          dY,
          time,
        ).opacity;
      }
      expect(sum / samples / coverage, `spatial mean at phase ${fraction}`).toBeGreaterThan(0.9);
      expect(sum / samples / coverage, `spatial mean at phase ${fraction}`).toBeLessThan(1.1);
    }
  });

  it("hands a footprint box wider than the bounded search back to the mean field", () => {
    const wide = waterDistantWhitecaps(0.005, 100, 100, [9, 1], [2, 200], 12);
    expect(wide.validity).toBe(0);
    const dense = waterDistantWhitecaps(0.05, 100, 100, [2.4, 0.3], [-0.4, 48], 12);
    expect(dense.validity).toBe(0);
    const calm = waterDistantWhitecaps(0, 100, 100, [2.4, 0.3], [-0.4, 48], 12);
    expect(calm.opacity).toBe(0);
  });

  it("is discrete: most far pixels carry no foam and the ones that do carry a real patch", () => {
    const random = lcg(0xf1ec);
    const dX: readonly [number, number] = [2.4, 0.3];
    const dY: readonly [number, number] = [-0.4, 48];
    const coverage = 0.005;
    let zero = 0;
    let visible = 0;
    let peak = 0;
    const samples = 20_000;
    for (let sample = 0; sample < samples; sample += 1) {
      const { opacity } = waterDistantWhitecaps(
        coverage,
        (random() - 0.5) * 20_000,
        (random() - 0.5) * 20_000,
        dX,
        dY,
        random() * 400,
      );
      if (opacity === 0) zero += 1;
      if (opacity > 0.02) visible += 1;
      peak = Math.max(peak, opacity);
    }
    // The mean field would have painted 0.5% everywhere; the flecks paint
    // nothing on most pixels and a real patch on a few.
    expect(zero / samples).toBeGreaterThan(0.6);
    expect(visible / samples).toBeLessThan(0.15);
    // A 12 m² patch in a ~115 m² footprint (10% of the pixel) spread over the
    // antialiased box (~2.6 px across) peaks near 4-6% at the envelope's top.
    expect(peak).toBeGreaterThan(0.035);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("hands off from the resolved foam texture on the major footprint", () => {
    expect(WATER_WHITECAP_FOOTPRINT_LOW).toBeGreaterThanOrEqual(4);
    expect(WATER_WHITECAP_FOOTPRINT_HIGH).toBeGreaterThan(WATER_WHITECAP_FOOTPRINT_LOW);
    expect(WATER_FRAGMENT_WGSL).toContain("waterDistantWhitecaps(");
    expect(WATER_FRAGMENT_WGSL).toContain("whitecaps = mix(foamAmount, flecks.x, fleckWeight * flecks.y);");
    expect(WATER_FRAGMENT_WGSL).toContain("max(whitecaps * 1.18, shoreFoam)");
    // Roughness keeps reading the mean coverage; only the composite is discrete.
    expect(WATER_FRAGMENT_WGSL).toContain("let baseRoughness = 0.075 + foamAmount * 0.2;");
  });
});

describe("far cat's paws and the rough-interface Fresnel", () => {
  it("raises the grazing Fresnel cosine by a fraction of the RMS slope and nothing at normal incidence", () => {
    expect(waterRoughFresnelCosine(1, 0.3)).toBe(1);
    expect(waterRoughFresnelCosine(0.3, 0)).toBeCloseTo(0.3, 9);
    // Ross, Dion & Potvin (2005): a 10 m/s sea (Cox-Munk mss 0.054, RMS
    // slope 0.23) at 85° reflects ~0.3-0.35 against ~0.65 for flat water.
    const cos85 = Math.cos((85 * Math.PI) / 180);
    const rough = waterRoughFresnelCosine(cos85, Math.sqrt(0.003 + 0.00512 * 10));
    const schlick = (c: number) => 0.0204 + (1 - 0.0204) * (1 - c) ** 5;
    expect(schlick(cos85)).toBeGreaterThan(0.6);
    expect(schlick(rough)).toBeGreaterThan(0.28);
    expect(schlick(rough)).toBeLessThan(0.4);
    // ...and a grazing effect only: at 60° the rough and flat reflectances
    // are equal, at 70° within 15%, at 80° the rough one is clearly lower.
    const rms10 = Math.sqrt(0.003 + 0.00512 * 10);
    const ratio = (degrees: number) => {
      const c = Math.cos((degrees * Math.PI) / 180);
      return schlick(waterRoughFresnelCosine(c, rms10)) / schlick(c);
    };
    expect(ratio(60)).toBeCloseTo(1, 6);
    expect(ratio(70)).toBeGreaterThan(0.85);
    expect(ratio(80)).toBeLessThan(0.75);
    expect(ratio(85)).toBeLessThan(ratio(80));
    // Monotone in both arguments, never above one.
    expect(waterRoughFresnelCosine(0.2, 0.2)).toBeGreaterThan(waterRoughFresnelCosine(0.1, 0.2));
    expect(waterRoughFresnelCosine(0.1, 0.3)).toBeGreaterThan(waterRoughFresnelCosine(0.1, 0.2));
    expect(waterRoughFresnelCosine(0.99, 5)).toBeLessThanOrEqual(1);
    expect(WATER_ROUGH_FRESNEL_TILT).toBeGreaterThan(0);
    expect(WATER_ROUGH_FRESNEL_TILT).toBeLessThan(1);
  });

  it("applies the far gust only to the short-wave variance and feeds the rough Fresnel the total", () => {
    // Faded in on the sparkle's minor-footprint window: the near field's own
    // gust field already modulates its resolved ripples, and a far-only gain
    // there would make a calm lane calm in the base but not in the ripples.
    expect(WATER_FRAGMENT_WGSL).toContain(
      "waterFarGustField(input.oceanCoordinate, uniforms.oceanWind, uniforms.time, footprintMajor),\n    farGustWeight,",
    );
    expect(WATER_FRAGMENT_WGSL).toContain("let farGust = mix(\n    1.0,");
    // Evaluated after the depth discard, not before it.
    const discardAt = WATER_FRAGMENT_WGSL.indexOf("if (depth <= 0.0) { discard; }");
    expect(WATER_FRAGMENT_WGSL.indexOf("let farGust = mix(")).toBeGreaterThan(discardAt);
    // The Fresnel reads the physical mean-square slope, bounded at what any
    // wind produces, not the BRDF's 0.5 look ceiling.
    expect(WATER_FRAGMENT_WGSL).toContain("sqrt(min(slopeVariance, 0.090))");
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(baseSample, baseMoment, input.cascadeFades.x) * farGust;");
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(sample, moment, input.cascadeFades.y) * mix(1.0, farGust, 0.5);");
    // The long swell bands do not respond to a gust.
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeSlopeVariance(sample, moment, input.cascadeFades.z); cascadeJacobians.z");
    expect(WATER_FRAGMENT_WGSL).toContain("capillary.unresolvedMeanSquareSlope * farGust;");
    expect(WATER_FRAGMENT_WGSL).toContain("let fresnel = waterRoughInterfaceFresnel(\n    normal,\n    view,\n    cameraBelow,");
    expect(WATER_FRAGMENT_WGSL).not.toContain("let fresnel = waterInterfaceFresnel(");
    // The underside keeps the exact total-internal-reflection law.
    expect(WATER_FAR_FIELD_WGSL).toContain("if (cameraBelow) {\n    return waterInterfaceFresnel(normal, view, cameraBelow);");
  });

  it("drifts the far gust octaves with the wind and fades them on the major footprint", () => {
    expect(WATER_FAR_GUST_COARSE_METERS).toBeGreaterThan(WATER_FAR_GUST_MID_METERS);
    expect(WATER_FAR_GUST_MID_METERS).toBeGreaterThan(57);
    expect(WATER_FAR_GUST_DRIFT_FRACTION).toBeGreaterThan(0);
    expect(WATER_FAR_GUST_DRIFT_FRACTION).toBeLessThanOrEqual(1);
    // Unwrapped: the ripple drift's 4096 s wrap would pop the lanes by tens
    // of kilometres in one frame.
    expect(WATER_FAR_FIELD_WGSL).toContain("worldXZ - windVelocity * time * 0.60");
    expect(WATER_FAR_FIELD_WGSL).not.toContain("waterRippleDrift(windVelocity, time) * 0.60");
    expect(WATER_FAR_FIELD_WGSL).toContain("smoothstep(600.0, 2000.0, footprintMajor)");
    expect(WATER_FAR_FIELD_WGSL).toContain("smoothstep(150.0, 500.0, footprintMajor)");
    // Mean-one construction: value noise centred on 0.5, gain clamped around 1.
    expect(WATER_FAR_FIELD_WGSL).toContain("- 0.5;");
    expect(WATER_FAR_GUST_GAIN_MIN).toBeLessThan(1);
    expect(WATER_FAR_GUST_GAIN_MAX).toBeGreaterThan(1);
  });
});

describe("far-field block composition", () => {
  it("is composed into the ocean fragment after the shared constants and not into the vertex", () => {
    const constants = WATER_FRAGMENT_WGSL.indexOf("const PI: f32");
    const block = WATER_FRAGMENT_WGSL.indexOf("fn waterPcg3(");
    expect(constants).toBeGreaterThanOrEqual(0);
    expect(block).toBeGreaterThan(constants);
    expect(WATER_VERTEX_WGSL).not.toContain("waterPcg3");
    expect(WATER_FAR_FIELD_WGSL).toContain("fn waterDistantGlintGain(");
    expect(WATER_FAR_FIELD_WGSL).toContain("fn waterDistantWhitecaps(");
  });

  it("takes no derivatives of its own", () => {
    expect(WATER_FAR_FIELD_WGSL).not.toContain("dpdx(");
    expect(WATER_FAR_FIELD_WGSL).not.toContain("dpdy(");
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
