import { describe, expect, it } from "vitest";
import { HYDROLOGY_WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/HydrologySystem";
import { WATER_FRAGMENT_WGSL } from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  resolveSunShadowCascadeLayout,
  SUN_SHADOW_FRAGMENT_WGSL,
} from "../src/render/webgpu/water/SunShadowReceiver";

describe("shared water sun-shadow receiver", () => {
  it("reproduces bounded CSM splits and blend intervals from public parameters", () => {
    const layout = resolveSunShadowCascadeLayout({
      cameraMinZ: 0.08,
      cameraMaxZ: 120_000,
      cascadeCount: 4,
      lambda: 0.78,
      minDistance: 0,
      maxDistance: 1,
      shadowMaxZ: 16_000,
      cascadeBlendPercentage: 0.12,
    });

    expect(layout.cascadeCount).toBe(4);
    expect(layout.splits[3]).toBeCloseTo(16_000, 5);
    for (let index = 0; index < layout.cascadeCount; index += 1) {
      const previous = index === 0 ? 0.08 : layout.splits[index - 1] ?? 0;
      expect(layout.splits[index]).toBeGreaterThan(previous);
      expect(layout.blendStarts[index]).toBeGreaterThan(previous);
      expect(layout.blendStarts[index]).toBeLessThan(layout.splits[index] ?? 0);
    }
  });

  it("clamps unsupported counts while leaving inactive lanes safely out of range", () => {
    const layout = resolveSunShadowCascadeLayout({
      cameraMinZ: 0.1,
      cameraMaxZ: 10_000,
      cascadeCount: 12,
      lambda: 0.5,
      minDistance: 0,
      maxDistance: 1,
      shadowMaxZ: 4_000,
      cascadeBlendPercentage: 0,
    });
    expect(layout.cascadeCount).toBe(4);
    expect(layout.blendStarts).toEqual(layout.splits);
  });

  it("samples the existing reversed-Z depth array and shadows only direct water light", () => {
    expect(SUN_SHADOW_FRAGMENT_WGSL).toContain("texture_depth_2d_array");
    expect(SUN_SHADOW_FRAGMENT_WGSL).toContain("sampler_comparison");
    expect(SUN_SHADOW_FRAGMENT_WGSL).toContain("textureSampleCompareLevel");
    expect(SUN_SHADOW_FRAGMENT_WGSL).toContain("sunShadowBlendStarts");
    expect(WATER_FRAGMENT_WGSL).toContain("directSunVisibility = cloudShadow * sunShadow");
    expect(WATER_FRAGMENT_WGSL).not.toContain("atmosphereReflection * sunShadow");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(
      "nDotL * 4.0 * directSunVisibility",
    );
  });
});
