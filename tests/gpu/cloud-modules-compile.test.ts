import { describe, expect, it } from "vitest";
// Side-effect imports: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3, Vector2 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VolumetricCloudSystem } from "../../src/render/webgpu/clouds/VolumetricCloudSystem";
import { AtmosphereGpuResources } from "../../src/render/webgpu/atmosphere/AtmosphereGpuResources";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";

/**
 * Assertion 36 (2-0): all three adopted CLOUD_SHADER_MODULES compile and
 * dispatch on a real adapter, through the exact runtime — the
 * VolumetricCloudSystem constructs its compute pipelines from the module
 * metadata, whenReadyAsync barriers on real pipeline creation, and one
 * update() drives raymarch + temporal-resolve dispatches. A Babylon bump
 * that breaks any adopted module fails here, loudly.
 */

describe("adopted cloud modules on a real adapter (assertion 36)", () => {
  it("compiles all three modules and dispatches the pipeline", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new UniversalCamera("cloud-gpu-camera", new Vector3(0, 600, 0), scene);
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
        sunAngularRadiusRadians: 0.004675,
        cloudCoverage: 0.35,
        humidity: 0.45,
        windSpeed: 8,
        windDirection: new Vector2(0.28, 0.96),
      };
      const resources = new AtmosphereGpuResources(scene, camera, (mesh) =>
        mesh.name === "volumetric-cloud-shell");
      const clouds = new VolumetricCloudSystem(scene, camera, profile, snapshot, resources);
      try {
        expect(clouds.statistics.computeSupported).toBe(true);
        await clouds.whenReadyAsync(undefined, 30_000);

        // Drive a few frames so every pass dispatches at least once.
        for (let frame = 0; frame < 4; frame += 1) {
          engine.beginFrame();
          clouds.update(new Vector3(0, 600, 0), frame / 60);
          scene.render(false, false);
          engine.endFrame();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const statistics = clouds.statistics;
        expect(statistics.raymarchDispatchCount).toBeGreaterThan(0);
        expect(statistics.temporalResolveDispatchCount).toBeGreaterThan(0);
        expect(statistics.shadowDispatchCount).toBeGreaterThan(0);
        expect(statistics.historyValid).toBe(true);
        expect(clouds.cloudShadow.valid).toBe(true);
      } finally {
        clouds.dispose();
        resources.dispose();
        scene.dispose();
      }
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
