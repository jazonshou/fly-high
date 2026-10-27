import { describe, expect, it } from "vitest";
import { createEnvironmentState } from "../src/render/webgpu/nature/EnvironmentState";
import {
  packCloudRaymarchUniforms,
  resolveVolumetricCloudConfig,
  scaleCloudMarch,
  type CloudFrameState,
  type VolumetricCloudConfig,
} from "../src/render/webgpu/nature/CloudConfig";
import type { QualityLevel, RequestedRenderingMode } from "../src/game/types";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * PR B part 2 (G5, R2): the governed cloud view march, `scaleCloudMarch`.
 *
 * The rung cuts the march's steps and stretches both step lengths by the
 * realized ratio, so a ray keeps its reach. The loop caps at the step count
 * and integrates no remainder (`CloudShaders.ts`), so cutting steps alone
 * would end every dense ray short and drop distant and grazing cloud; the
 * instrument shows the reach check sees that. The rung is the same row-12
 * uniform the profile already sets: no shader changes, and at scale 1 the
 * config is the profile's own object, packed byte for byte as before.
 */

/** The view march as the cloud system resolves it from a profile (`VolumetricCloudSystem.resolveConfig`). */
function profileMarch(quality: QualityLevel, mode: RequestedRenderingMode = "balanced"): VolumetricCloudConfig {
  const profile = resolveWebGpuQualityProfile(quality, mode);
  return resolveVolumetricCloudConfig({
    maximumViewSteps: Math.max(8, Math.min(192, profile.cloudPrimarySteps)),
    lightSteps: Math.max(2, Math.min(16, profile.cloudLightSteps)),
  });
}

/** One quality × mode pair per tier, 0-3. */
const TIERS = [["low", "balanced"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"]] as const;

/**
 * How far a ray reaches through dense cloud before its steps run out: the
 * shader's dense step is the minimum step × (1 + d / doubling distance).
 */
function denseReachMeters(config: VolumetricCloudConfig): number {
  let distance = 0;
  for (let step = 0; step < config.maximumViewSteps; step += 1) {
    distance += config.minimumStepMeters * (1 + distance / config.stepDoublingDistanceMeters);
  }
  return distance;
}

const environment = createEnvironmentState({
  timeSeconds: 12,
  frameDeltaSeconds: 1 / 60,
  floatingOriginMeters: [100, 0, -100],
  weather: { cloudCoverage: 0.4, cloudType: 0.5, precipitation: 0.2 },
});
const frame: CloudFrameState = {
  cameraForward: [0, 0, -1],
  cameraRight: [1, 0, 0],
  cameraUp: [0, 1, 0],
  viewScale: [0.6, 0.35],
  cameraPositionMeters: [0, 800, 0],
  renderSize: [480, 272],
  fullResolutionSize: [1_280, 720],
  frameIndex: 3,
  windOffsetMeters: [10, 20],
  weatherMapOriginMeters: [0, 0],
};

/** Row 12 of `CloudRaymarchParams`: min step, max step, view steps, light steps. */
function marchRow(config: VolumetricCloudConfig): number[] {
  return [...packCloudRaymarchUniforms(config, environment, frame).subarray(48, 52)];
}

describe("scaleCloudMarch", () => {
  it("returns the config itself at scale 1 or above", () => {
    const config = profileMarch("medium");
    expect(scaleCloudMarch(config, 1)).toBe(config);
    expect(scaleCloudMarch(config, 1.5)).toBe(config);
    expect(scaleCloudMarch(config, Number.NaN)).toBe(config);
  });

  it.each([
    ["low", 40, 0.75, 30, 4 / 3],
    ["low", 40, 0.6, 24, 5 / 3],
    ["medium", 60, 0.75, 45, 4 / 3],
    ["medium", 60, 0.6, 36, 5 / 3],
    ["high", 96, 0.75, 72, 4 / 3],
    ["high", 96, 0.6, 58, 96 / 58],
  ] as const)("%s: %d steps at ×%f are %d, each %f× longer", (quality, steps, scale, scaledSteps, stretch) => {
    const config = profileMarch(quality);
    expect(config.maximumViewSteps).toBe(steps);
    const scaled = scaleCloudMarch(config, scale);
    expect(scaled.maximumViewSteps).toBe(scaledSteps);
    expect(scaled.minimumStepMeters).toBeCloseTo(config.minimumStepMeters * stretch, 9);
    expect(scaled.maximumStepMeters).toBeCloseTo(config.maximumStepMeters * stretch, 9);
    // Everything else is the profile's march.
    expect({ ...scaled, maximumViewSteps: 0, minimumStepMeters: 0, maximumStepMeters: 0 })
      .toEqual({ ...config, maximumViewSteps: 0, minimumStepMeters: 0, maximumStepMeters: 0 });
  });

  it("never goes below the config's own minimum of 8 steps", () => {
    const config = resolveVolumetricCloudConfig({ maximumViewSteps: 10 });
    expect(scaleCloudMarch(config, 0.6).maximumViewSteps).toBe(8);
    const floor = resolveVolumetricCloudConfig({ maximumViewSteps: 8 });
    expect(scaleCloudMarch(floor, 0.6)).toBe(floor);
  });
});

describe("the governed march keeps its reach", () => {
  it("a dense ray reaches within 2% of the profile's march at every tier and notch", () => {
    for (const [quality, mode] of TIERS) {
      const config = profileMarch(quality, mode);
      const full = denseReachMeters(config);
      for (const scale of [0.75, 0.6]) {
        const reach = denseReachMeters(scaleCloudMarch(config, scale));
        expect(Math.abs(reach / full - 1), `${quality}/${mode} ×${scale}`).toBeLessThan(0.02);
      }
    }
    // At tier 1, 60 steps of 70 m reach about 7.3 km, and so do 45 of 93.3 m.
    expect(denseReachMeters(profileMarch("medium"))).toBeCloseTo(7_330, -2);
    expect(denseReachMeters(scaleCloudMarch(profileMarch("medium"), 0.75))).toBeCloseTo(7_300, -2);
  });

  it("INSTRUMENT: cutting the steps alone loses at least 20% of the reach", () => {
    for (const [quality, mode] of TIERS) {
      const config = profileMarch(quality, mode);
      const full = denseReachMeters(config);
      for (const scale of [0.75, 0.6]) {
        const truncated = resolveVolumetricCloudConfig({
          ...config,
          maximumViewSteps: scaleCloudMarch(config, scale).maximumViewSteps,
        });
        expect(1 - denseReachMeters(truncated) / full, `${quality}/${mode} ×${scale}`).toBeGreaterThanOrEqual(0.2);
      }
    }
  });
});

describe("the governed march reaches the shader through row 12 alone", () => {
  it("packs fewer, longer steps at tier 0 ×0.75", () => {
    const config = profileMarch("low");
    const [minimum, maximum, steps, light] = marchRow(scaleCloudMarch(config, 0.75));
    expect(minimum).toBeCloseTo(280 / 3, 3);
    expect(maximum).toBe(1_200);
    expect(steps).toBe(30);
    expect(light).toBe(config.lightSteps);
  });

  it("packs the profile's own march, byte for byte, at scale 1", () => {
    for (const [quality, mode] of TIERS) {
      const config = profileMarch(quality, mode);
      const today = packCloudRaymarchUniforms(config, environment, frame);
      const governed = packCloudRaymarchUniforms(scaleCloudMarch(config, 1), environment, frame);
      expect(governed.length).toBe(today.length);
      for (let index = 0; index < today.length; index += 1) {
        expect(Object.is(governed[index], today[index]), `${quality}/${mode} lane ${index}`).toBe(true);
      }
    }
  });
});
