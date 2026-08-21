import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
  oceanPresentationTopology,
  resolveProfileSpectralOceanConfig,
} from "../src/render/webgpu/water/SpectralOceanSystem";

describe("spectral ocean presentation topology", () => {
  it("uses a depth-aware, variance-filtered physical surface without a duplicate cloud field", () => {
    // 2-8: distance filtering is Toksvig — the moment mips' slope variance
    // becomes roughness; the old ad-hoc smoothstep distance term is gone.
    expect(WATER_FRAGMENT_WGSL).toContain("slopeVariance");
    expect(WATER_FRAGMENT_WGSL).not.toContain("distanceRoughness");
    // 5-11: bathymetry drives Beer-Lambert transmission and the soft shore;
    // the former constant additive deep colour and opaque alpha are retired.
    expect(WATER_FRAGMENT_WGSL).toContain("WATER_ABSORPTION_PER_METER");
    expect(WATER_FRAGMENT_WGSL).toContain("waterShorelineAlpha(depth)");
    expect(WATER_FRAGMENT_WGSL).not.toContain("deepAbsorption");
    // Slopes are stored and summed directly (fade-weighted) — the clamped
    // normal-recovery denominator must stay deleted.
    expect(WATER_FRAGMENT_WGSL).toContain("cascadeFades");
    expect(WATER_FRAGMENT_WGSL).not.toContain("max(baseSample.y, 0.08)");
    // Mip selection needs derivatives of the UNWRAPPED coordinate.
    expect(WATER_FRAGMENT_WGSL).toContain("textureSampleGrad");
    expect(WATER_FRAGMENT_WGSL).toContain("dpdx(unwrapped)");
    expect(WATER_FRAGMENT_WGSL).toContain(
      "vec4f(max(water, vec3f(0.0)), shorelineAlpha)",
    );
    expect(WATER_FRAGMENT_WGSL).not.toContain("fn cloudNoise");
  });

  it("drops the surface with the Earth's curvature before the world transform (1C-7)", () => {
    expect(WATER_VERTEX_WGSL).toContain(
      "dot(vertexInputs.position.xz, vertexInputs.position.xz) / (2.0 * 6371000.0)",
    );
    // The drop applies to the displaced position, before the world transform.
    expect(WATER_VERTEX_WGSL.indexOf("6371000.0"))
      .toBeLessThan(WATER_VERTEX_WGSL.indexOf("uniforms.world * displaced"));
  });

  it("follows the resolved WebGPU tier instead of raw scenery quality", () => {
    const lowUltra = resolveWebGpuQualityProfile("low", "ultra");
    const mediumBalanced = resolveWebGpuQualityProfile("medium", "balanced");
    const highPerformance = resolveWebGpuQualityProfile("high", "performance");
    const highUltra = resolveWebGpuQualityProfile("high", "ultra");

    expect(oceanPresentationTopology(lowUltra)).toEqual(
      oceanPresentationTopology(mediumBalanced),
    );
    expect(oceanPresentationTopology(highPerformance)).toEqual(
      oceanPresentationTopology(mediumBalanced),
    );
    expect(oceanPresentationTopology(highUltra)).toMatchObject({
      radialRings: 192,
      angularSegments: 256,
    });
  });

  it("increases radial and angular density monotonically", () => {
    const low = oceanPresentationTopology(
      resolveWebGpuQualityProfile("low", "performance"),
    );
    const medium = oceanPresentationTopology(
      resolveWebGpuQualityProfile("medium", "balanced"),
    );
    const high = oceanPresentationTopology(
      resolveWebGpuQualityProfile("high", "ultra"),
    );

    expect(low.radialRings).toBeLessThan(medium.radialRings);
    expect(medium.radialRings).toBeLessThan(high.radialRings);
    expect(low.angularSegments).toBeLessThan(medium.angularSegments);
    expect(medium.angularSegments).toBeLessThan(high.angularSegments);
  });

  it("keeps every quality profile Nyquist-safe at its selected FFT resolution", () => {
    for (const quality of ["low", "medium", "high"] as const) {
      for (const mode of ["performance", "balanced", "ultra"] as const) {
        const profile = resolveWebGpuQualityProfile(quality, mode);
        const config = resolveProfileSpectralOceanConfig(profile, 0x51a7e);
        expect(config.resolution).toBe(profile.oceanResolution);
        expect(config.cascades).toHaveLength(profile.oceanCascades);
        for (const cascade of config.cascades) {
          expect(cascade.minimumWavelengthMeters).toBeGreaterThanOrEqual(
            2 * cascade.patchLengthMeters / config.resolution,
          );
        }
      }
    }
  });
});
