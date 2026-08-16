import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  oceanPresentationTopology,
  resolveProfileSpectralOceanConfig,
} from "../src/render/webgpu/water/SpectralOceanSystem";

describe("spectral ocean presentation topology", () => {
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
