import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import {
  CLOUD_COMPOSITE_FRAGMENT_WGSL,
  VolumetricCloudSystem,
} from "../src/render/webgpu/clouds/VolumetricCloudSystem";
import {
  resolveCloudRenderSize,
  resolveCloudShadowSchedule,
  shouldRenderCloudShadow,
} from "../src/render/webgpu/clouds/runtimePolicy";
import {
  CLOUD_RAYMARCH_WGSL,
  CLOUD_SHADOW_WGSL,
  CLOUD_TEMPORAL_RESOLVE_WGSL,
} from "../src/render/webgpu/nature/CloudShaders";
import {
  DEFAULT_VOLUMETRIC_CLOUD_CONFIG,
  packCloudRaymarchUniforms,
  packCloudShadowUniforms,
  packCloudTemporalUniforms,
  type CloudFrameState,
  type CloudShadowFrameState,
  type CloudTemporalFrameState,
  type VolumetricCloudConfig,
} from "../src/render/webgpu/nature/CloudConfig";
import { createEnvironmentState } from "../src/render/webgpu/nature/EnvironmentState";
import { AtmosphereGpuResources } from "../src/render/webgpu/atmosphere/AtmosphereGpuResources";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";

/**
 * 2-0 — the adopted cloud runtime. The live pipeline is the three
 * `nature/CloudShaders.ts` compute modules plus one composite shell; the
 * old inline integration/temporal/shadow fragment shaders are deleted.
 * Assertion 35 lives here: a tier table that lies is worse than none, so
 * every `VolumetricCloudConfig` field must reach a GPU uniform (or be a
 * named consumer of the runtime schedule policy).
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function createHarness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("cloud-test-camera", new Vector3(0, 500, 0), scene);
  scene.activeCamera = camera;
  const profile = resolveWebGpuQualityProfile("medium", "balanced");
  const snapshot: AtmosphereSnapshot = {
    sunDirection: new Vector3(0.3, 0.8, 0.52).normalize(),
    sunColor: new Color3(1, 0.96, 0.9),
    sunIntensity: 4.6,
    skyZenith: new Color3(0.2, 0.45, 0.85),
    skyHorizon: new Color3(0.7, 0.78, 0.88),
    ambientColor: new Color3(0.4, 0.45, 0.55),
    sunIlluminanceNormalized: 0.88,
    cloudCoverage: 0.35,
    humidity: 0.45,
    windSpeed: 8,
    windDirection: new Vector2(0.28, 0.96),
  };
  const resources = new AtmosphereGpuResources(scene, camera, (mesh) =>
    mesh.name === "volumetric-cloud-shell");
  const clouds = new VolumetricCloudSystem(scene, camera, profile, snapshot, resources);
  cleanups.push(() => {
    clouds.dispose();
    resources.dispose();
    scene.dispose();
    engine.dispose();
  });
  return { engine, scene, camera, profile, resources, clouds };
}

describe("cloud runtime policy (1A-6a)", () => {
  it("aligns the low-resolution target to multiples of eight", () => {
    expect(resolveCloudRenderSize(1_920, 1_080, 0.25)).toEqual({
      width: 480, height: 272, scale: 0.25,
    });
    expect(resolveCloudRenderSize(1_920, 1_080, 0.5)).toEqual({
      width: 960, height: 544, scale: 0.5,
    });
    expect(resolveCloudRenderSize(7, 5, 1)).toEqual({ width: 7, height: 5, scale: 1 });
    expect(() => resolveCloudRenderSize(1_920, 1_080, 0)).toThrow(RangeError);
  });

  it("schedules the shadow map by cloud resolution scale", () => {
    expect(resolveCloudShadowSchedule({ cloudResolutionScale: 0.25 })).toMatchObject({
      resolution: 128, steps: 8, updateEveryNFrames: 4,
    });
    expect(resolveCloudShadowSchedule({ cloudResolutionScale: 0.45 })).toMatchObject({
      resolution: 256, steps: 10, updateEveryNFrames: 3,
    });
    expect(resolveCloudShadowSchedule({ cloudResolutionScale: 0.7 })).toMatchObject({
      resolution: 256, steps: 14, updateEveryNFrames: 2,
    });
    expect(shouldRenderCloudShadow(10, -1, 3, false)).toBe(true);
    expect(shouldRenderCloudShadow(10, 9, 3, false)).toBe(false);
    expect(shouldRenderCloudShadow(10, 8, 3, true)).toBe(true);
    expect(shouldRenderCloudShadow(12, 9, 3, false)).toBe(true);
  });
});

describe("adopted cloud shaders (2-0)", () => {
  it("keeps the raymarch on the shipped ray-basis convention, not a matrix", () => {
    // 1A-4/1B-12: no view-projection matrix may exist anywhere in the cloud
    // pipeline — reprojection and rays come from the camera basis + absolute
    // camera delta, which a floating-origin rebase cannot shear.
    for (const shader of [CLOUD_RAYMARCH_WGSL, CLOUD_TEMPORAL_RESOLVE_WGSL, CLOUD_SHADOW_WGSL]) {
      expect(shader).not.toContain("view_projection");
      expect(shader).not.toContain("mat4x4");
    }
    expect(CLOUD_RAYMARCH_WGSL).toContain("params.camera_forward.xyz");
    expect(CLOUD_TEMPORAL_RESOLVE_WGSL).toContain("reprojectPreviousUv");
    expect(CLOUD_TEMPORAL_RESOLVE_WGSL).toContain("camera_delta");
  });

  it("clips the march against camera-space scene depth and writes storage MRT", () => {
    expect(CLOUD_RAYMARCH_WGSL).toContain("texture_storage_2d<rgba16float, write>");
    expect(CLOUD_RAYMARCH_WGSL).toContain("textureStore(raymarch_cloud");
    expect(CLOUD_RAYMARCH_WGSL).toContain("textureStore(raymarch_aux");
    expect(CLOUD_RAYMARCH_WGSL).toContain("scene_depth");
    expect(CLOUD_RAYMARCH_WGSL).toContain("view_z > 0.0");
  });

  it("samples the transmittance LUT with the tested CPU parameterisation", () => {
    // Must stay in lock-step with transmittanceLutUv() in AtmosphereLuts.ts.
    expect(CLOUD_RAYMARCH_WGSL).toContain("(sun_zenith + 0.2) / 1.2");
    expect(CLOUD_RAYMARCH_WGSL).toContain("sqrt(clamp(altitude / CLOUD_ATMOSPHERE_SHELL_HEIGHT");
  });

  it("keeps the composite premultiplied with no fragDepth write", () => {
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).not.toContain("fragmentOutputs.fragDepth");
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).toContain("let opacity = 1.0 - cloud.a;");
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).toContain("aerialPerspective(");
    // R-19/D-7: shadow-through-haze is structural; no strength × transmittance.
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).not.toContain("cloudShadow");
  });
});

describe("cloud config truth (assertion 35)", () => {
  /**
   * Fields consumed by the runtime SCHEDULE rather than a uniform block:
   * renderScale sizes the low-resolution target (resolveCloudRenderSize) and
   * shadowUpdateEveryNFrames drives the shadow cadence policy. Everything
   * else must perturb at least one packed uniform block.
   */
  const SCHEDULE_CONSUMED = new Set(["renderScale", "shadowUpdateEveryNFrames"]);

  function packAll(config: VolumetricCloudConfig): Uint8Array {
    const environment = createEnvironmentState({
      timeSeconds: 12,
      frameDeltaSeconds: 1 / 60,
      floatingOriginMeters: [100, 0, -100],
      weather: { cloudCoverage: 0.4, cloudType: 0.5, precipitation: 0.2 },
    });
    const raymarchFrame: CloudFrameState = {
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
    const temporalFrame: CloudTemporalFrameState = {
      renderSize: [480, 272],
      cameraCut: false,
      currentForward: [0, 0, -1],
      currentRight: [1, 0, 0],
      currentUp: [0, 1, 0],
      currentViewScale: [0.6, 0.35],
      previousForward: [0, 0, -1],
      previousRight: [1, 0, 0],
      previousUp: [0, 1, 0],
      previousViewScale: [0.6, 0.35],
      cameraDeltaMeters: [1, 0, 1],
    };
    const shadowFrame: CloudShadowFrameState = {
      shadowCenterMeters: [0, 0, 0],
      eastAxis: [1, 0, 0],
      northAxis: [0, 0, 1],
      windOffsetMeters: [10, 20],
      weatherMapOriginMeters: [0, 0],
      frameIndex: 3,
    };
    const raymarch = new Uint8Array(
      packCloudRaymarchUniforms(config, environment, raymarchFrame).buffer,
    );
    const temporal = new Uint8Array(packCloudTemporalUniforms(config, temporalFrame));
    const shadow = new Uint8Array(packCloudShadowUniforms(config, environment, shadowFrame));
    const combined = new Uint8Array(raymarch.length + temporal.length + shadow.length);
    combined.set(raymarch, 0);
    combined.set(temporal, raymarch.length);
    combined.set(shadow, raymarch.length + temporal.length);
    return combined;
  }

  it("moves at least one uniform byte for every config field", () => {
    const base = DEFAULT_VOLUMETRIC_CLOUD_CONFIG;
    const baseline = packAll(base);
    const perturbed: Record<string, number> = {
      // Integer fields nudge by whole steps; bounded fields stay in range.
      maximumViewSteps: base.maximumViewSteps + 8,
      lightSteps: base.lightSteps + 1,
      shadowMapResolution: base.shadowMapResolution * 2,
      shadowSteps: base.shadowSteps + 2,
    };
    for (const [key, value] of Object.entries(base)) {
      if (SCHEDULE_CONSUMED.has(key)) continue;
      const nudged = perturbed[key] ?? value * 1.01;
      const config = { ...base, [key]: nudged } as VolumetricCloudConfig;
      const packed = packAll(config);
      let differs = false;
      for (let index = 0; index < packed.length; index += 1) {
        if (packed[index] !== baseline[index]) {
          differs = true;
          break;
        }
      }
      expect(
        differs,
        `VolumetricCloudConfig.${key} does not reach any uniform block — `
        + "the tier table would be lying about it (assertion 35)",
      ).toBe(true);
    }
  });
});

describe("adopted cloud runtime lifecycle (2-0)", () => {
  it("constructs on NullEngine, resolves config from the profile, and reports statistics", () => {
    const { clouds } = createHarness();
    const statistics = clouds.statistics;
    // NullEngine has no compute support; the runtime must degrade to inert
    // dispatch-free updates rather than throwing (that is what lets this
    // lifecycle run in Node).
    expect(statistics.computeSupported).toBe(false);
    expect(statistics.raySteps).toBe(60); // medium/balanced cloudPrimarySteps
    expect(statistics.lightSteps).toBe(6);
    expect(statistics.shadowResolution).toBe(256);
    expect(statistics.shadowWorldSize).toBe(
      DEFAULT_VOLUMETRIC_CLOUD_CONFIG.shadowWorldSizeMeters,
    );
    expect(statistics.historyValid).toBe(false);
  });

  it("updates without dispatching when compute is unsupported", () => {
    const { clouds } = createHarness();
    clouds.update(new Vector3(1_000, 800, -2_000), 1.5);
    clouds.update(new Vector3(1_010, 800, -2_000), 1.6);
    const statistics = clouds.statistics;
    expect(statistics.frameIndex).toBe(2);
    expect(statistics.raymarchDispatchCount).toBe(0);
    expect(statistics.temporalResolveDispatchCount).toBe(0);
    expect(statistics.shadowDispatchCount).toBe(0);
  });

  it("keeps the cloud-shadow projection contract for receivers", () => {
    const { clouds } = createHarness();
    clouds.update(new Vector3(12_000, 900, -8_000), 2);
    const projection = clouds.cloudShadow;
    expect(projection.worldSizeMeters).toBe(
      DEFAULT_VOLUMETRIC_CLOUD_CONFIG.shadowWorldSizeMeters,
    );
    expect(projection.referenceAltitudeMeters).toBe(0);
    // No dispatch has run on NullEngine, so the map must not claim validity.
    expect(projection.valid).toBe(false);
    const texelWorldSize = projection.worldSizeMeters / 256;
    expect(projection.centerX % texelWorldSize).toBe(0);
    expect(projection.centerZ % texelWorldSize).toBe(0);
  });

  it("re-resolves the shadow schedule and render size on profile changes", () => {
    const { clouds } = createHarness();
    clouds.setProfile(resolveWebGpuQualityProfile("high", "ultra"));
    const statistics = clouds.statistics;
    expect(statistics.raySteps).toBe(96);
    expect(statistics.shadowUpdateEveryNFrames).toBe(2);
    expect(statistics.historyValid).toBe(false);
  });

  it("resolves whenReadyAsync on NullEngine and rejects after dispose", async () => {
    const { clouds } = createHarness();
    await expect(clouds.whenReadyAsync(undefined, 5_000)).resolves.toBeUndefined();
    clouds.dispose();
    await expect(clouds.whenReadyAsync(undefined, 200)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
