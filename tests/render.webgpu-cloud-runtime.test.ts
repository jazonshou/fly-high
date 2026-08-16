import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_COMPOSITE_FRAGMENT_WGSL,
  CLOUD_INTEGRATION_FRAGMENT_WGSL,
  CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL,
  CLOUD_TEMPORAL_FRAGMENT_WGSL,
  VolumetricCloudSystem,
} from "../src/render/webgpu/clouds/VolumetricCloudSystem";
import {
  resolveCloudRenderSize,
  resolveCloudShadowSchedule,
  shouldRenderCloudShadow,
} from "../src/render/webgpu/clouds/runtimePolicy";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

interface CloudReadinessEffectHarness {
  getCompilationError(): string;
}

interface CloudReadinessTextureHarness {
  isReady(): boolean;
  getEffect(): CloudReadinessEffectHarness | undefined;
  render(): void;
}

interface CloudReadinessMaterialHarness {
  isReady(...arguments_: readonly unknown[]): boolean;
  getEffect(): CloudReadinessEffectHarness | undefined;
}

interface CloudReadinessHarness {
  readonly integrationTexture: CloudReadinessTextureHarness;
  readonly historyTextures: readonly [
    CloudReadinessTextureHarness,
    CloudReadinessTextureHarness,
  ];
  readonly shadowTextureValue: CloudReadinessTextureHarness;
  readonly material: CloudReadinessMaterialHarness;
}

function createCloudFixture(): {
  readonly engine: NullEngine;
  readonly scene: Scene;
  readonly clouds: VolumetricCloudSystem;
} {
  const engine = new NullEngine({
    renderWidth: 800,
    renderHeight: 600,
    textureSize: 512,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  const camera = new UniversalCamera("cloud-readiness-camera", new Vector3(0, 800, -20), scene);
  scene.activeCamera = camera;
  const clouds = new VolumetricCloudSystem(
    scene,
    camera,
    resolveWebGpuQualityProfile("low", "performance"),
    {
      sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
      sunColor: new Color3(1, 0.96, 0.88),
      sunIntensity: 4.8,
      skyZenith: new Color3(0.1, 0.36, 0.78),
      skyHorizon: new Color3(0.58, 0.77, 0.96),
      ambientColor: new Color3(0.18, 0.27, 0.42),
      exposure: 1,
      cloudCoverage: 0.2,
      humidity: 0.5,
      windSpeed: 8,
      windDirection: new Vector2(0.8, 0.6),
    },
  );
  return { engine, scene, clouds };
}

function readinessHarness(clouds: VolumetricCloudSystem): CloudReadinessHarness {
  return clouds as unknown as CloudReadinessHarness;
}

function stubCloudReadiness(
  clouds: VolumetricCloudSystem,
  ready: boolean,
): readonly CloudReadinessTextureHarness[] {
  const harness = readinessHarness(clouds);
  const textures = [
    harness.integrationTexture,
    harness.historyTextures[0],
    harness.historyTextures[1],
    harness.shadowTextureValue,
  ] as const;
  for (const texture of textures) {
    vi.spyOn(texture, "isReady").mockReturnValue(ready);
    vi.spyOn(texture, "getEffect").mockReturnValue(undefined);
  }
  vi.spyOn(harness.material, "isReady").mockReturnValue(ready);
  vi.spyOn(harness.material, "getEffect").mockReturnValue(undefined);
  return textures;
}

describe("volumetric cloud runtime policy", () => {
  it("turns the live profile scale into aligned low-resolution targets", () => {
    expect(resolveCloudRenderSize(1_920, 1_080, 0.25)).toEqual({
      width: 480,
      height: 272,
      scale: 0.25,
    });
    expect(resolveCloudRenderSize(1_920, 1_080, 0.5)).toEqual({
      width: 960,
      height: 544,
      scale: 0.5,
    });
    expect(resolveCloudRenderSize(7, 5, 1)).toEqual({ width: 7, height: 5, scale: 1 });
    expect(() => resolveCloudRenderSize(1_920, 1_080, 0)).toThrow(/cloudResolutionScale/);
  });

  it("bounds shadow work and honors dirty/cadenced updates", () => {
    const low = resolveCloudShadowSchedule(resolveWebGpuQualityProfile("low", "performance"));
    const medium = resolveCloudShadowSchedule(resolveWebGpuQualityProfile("medium", "balanced"));
    const high = resolveCloudShadowSchedule(resolveWebGpuQualityProfile("high", "ultra"));
    expect(low).toMatchObject({ resolution: 128, steps: 8, updateEveryNFrames: 4 });
    expect(medium).toMatchObject({ resolution: 256, steps: 10, updateEveryNFrames: 3 });
    expect(high).toMatchObject({ resolution: 256, steps: 14, updateEveryNFrames: 2 });
    expect(shouldRenderCloudShadow(1, -1, 4, false)).toBe(true);
    expect(shouldRenderCloudShadow(2, 1, 4, false)).toBe(false);
    expect(shouldRenderCloudShadow(2, 1, 4, true)).toBe(true);
    expect(shouldRenderCloudShadow(5, 1, 4, false)).toBe(true);
  });
});

describe("volumetric cloud runtime shaders", () => {
  it("keeps reversed-Z depth, temporal rejection, and shadow optical depth explicit", () => {
    for (const shader of [
      CLOUD_INTEGRATION_FRAGMENT_WGSL,
      CLOUD_TEMPORAL_FRAGMENT_WGSL,
      CLOUD_COMPOSITE_FRAGMENT_WGSL,
      CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL,
    ]) {
      let braceDepth = 0;
      for (const character of shader) {
        if (character === "{") braceDepth += 1;
        if (character === "}") braceDepth -= 1;
        expect(braceDepth).toBeGreaterThanOrEqual(0);
      }
      expect(braceDepth).toBe(0);
      expect(shader).not.toContain("TODO");
    }
    expect(CLOUD_INTEGRATION_FRAGMENT_WGSL).toContain("vec4f(uv * 2.0 - 1.0, 0.0, 1.0)");
    expect(CLOUD_INTEGRATION_FRAGMENT_WGSL).toContain("representativeDistance");
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).toContain("fragmentOutputs.fragDepth");
    expect(CLOUD_COMPOSITE_FRAGMENT_WGSL).toContain("projectedCloudPoint.z");
    expect(CLOUD_TEMPORAL_FRAGMENT_WGSL).toContain("previousViewProjection");
    expect(CLOUD_TEMPORAL_FRAGMENT_WGSL).toContain("depthConfidence");
    expect(CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL).toContain("opticalDepth");
    expect(CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL).toContain("shadowSteps");
  });

  it("applies a changed profile to live render and shadow resources", () => {
    const engine = new NullEngine({
      renderWidth: 800,
      renderHeight: 600,
      textureSize: 512,
      deterministicLockstep: false,
      lockstepMaxSteps: 4,
    });
    const scene = new Scene(engine);
    const camera = new UniversalCamera("camera", new Vector3(0, 800, -20), scene);
    scene.activeCamera = camera;
    const low = resolveWebGpuQualityProfile("low", "performance");
    const clouds = new VolumetricCloudSystem(scene, camera, low, {
      sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
      sunColor: new Color3(1, 0.96, 0.88),
      sunIntensity: 4.8,
      skyZenith: new Color3(0.1, 0.36, 0.78),
      skyHorizon: new Color3(0.58, 0.77, 0.96),
      ambientColor: new Color3(0.18, 0.27, 0.42),
      exposure: 1,
      cloudCoverage: 0.2,
      humidity: 0.5,
      windSpeed: 8,
      windDirection: new Vector2(0.8, 0.6),
    });
    expect(clouds.statistics).toMatchObject({
      renderWidth: 200,
      renderHeight: 152,
      resolutionScale: 0.25,
      shadowResolution: 128,
      historyValid: false,
    });
    clouds.update(new Vector3(1_234, 800, -4_321), 1);
    expect(clouds.statistics.frameIndex).toBe(1);
    const generation = clouds.statistics.historyGeneration;
    clouds.setProfile(resolveWebGpuQualityProfile("high", "ultra"));
    expect(clouds.statistics).toMatchObject({
      renderWidth: 480,
      renderHeight: 360,
      resolutionScale: 0.6,
      shadowResolution: 256,
      shadowUpdateEveryNFrames: 2,
    });
    expect(clouds.statistics.historyGeneration).toBeGreaterThan(generation);
    expect(clouds.cloudShadow.valid).toBe(false);
    expect(clouds.cloudShadow).toMatchObject({
      referenceAltitudeMeters: 0,
      worldSizeMeters: 90_000,
    });
    expect(scene.getMeshByName("volumetric-cloud-ground-shadow-shell")).toBeNull();
    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });
});

describe("volumetric cloud startup readiness", () => {
  it("completes the real Babylon readiness lifecycle on the NullEngine", async () => {
    const { engine, scene, clouds } = createCloudFixture();

    await clouds.whenReadyAsync(undefined, 1_000);

    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("warms integration, both temporal targets, shadow, and composite readiness", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    const textures = stubCloudReadiness(clouds, true);
    const renderSpies = textures.map((texture) => (
      vi.spyOn(texture, "render").mockImplementation(() => undefined)
    ));
    const material = readinessHarness(clouds).material;

    await clouds.whenReadyAsync(undefined, 100);

    for (const renderSpy of renderSpies) expect(renderSpy).toHaveBeenCalledOnce();
    expect(material.isReady).toHaveBeenCalled();
    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("awaits native composite render-pipeline validation when the engine exposes it", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    const textures = stubCloudReadiness(clouds, true);
    for (const texture of textures) {
      vi.spyOn(texture, "render").mockImplementation(() => undefined);
    }
    const material = readinessHarness(clouds).material;
    const effect = { getCompilationError: () => "" };
    vi.mocked(material.getEffect).mockReturnValue(effect);
    let resolvePipeline!: (pipeline: GPURenderPipeline) => void;
    const pipeline = new Promise<GPURenderPipeline>((resolve) => {
      resolvePipeline = resolve;
    });
    const createRenderPipelineAsync = vi.fn().mockReturnValue([pipeline]);
    Object.assign(engine, { createRenderPipelineAsync });

    let completed = false;
    const readiness = clouds.whenReadyAsync(undefined, 1_000).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(createRenderPipelineAsync).toHaveBeenCalledWith(expect.objectContaining({
      colorFormat: "rgba16float",
      sampleCount: 1,
      depthWrite: false,
      depthTest: true,
      cullEnabled: false,
    }));
    expect(completed).toBe(false);
    resolvePipeline({} as GPURenderPipeline);
    await readiness;
    expect(completed).toBe(true);

    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("rejects a shader compilation error instead of polling forever", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    stubCloudReadiness(clouds, false);
    const integration = readinessHarness(clouds).integrationTexture;
    vi.mocked(integration.getEffect).mockReturnValue({
      getCompilationError: () => "WGSL validation failed",
    });

    await expect(clouds.whenReadyAsync(undefined, 100)).rejects.toThrow(
      /integration shader failed to compile: WGSL validation failed/,
    );
    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("rejects on its finite timeout", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    stubCloudReadiness(clouds, false);

    await expect(clouds.whenReadyAsync(undefined, 12)).rejects.toThrow(
      /timed out after 12 ms/,
    );
    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("rejects promptly when the caller aborts startup", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    stubCloudReadiness(clouds, false);
    const controller = new AbortController();
    const readiness = clouds.whenReadyAsync(controller.signal, 1_000);

    controller.abort();

    await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
    clouds.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("rejects an in-flight readiness wait when disposed", async () => {
    const { engine, scene, clouds } = createCloudFixture();
    stubCloudReadiness(clouds, false);
    const readiness = clouds.whenReadyAsync(undefined, 1_000);

    clouds.dispose();

    await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
    scene.dispose();
    engine.dispose();
  });
});
