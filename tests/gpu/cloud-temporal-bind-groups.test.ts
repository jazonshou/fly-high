import { describe, expect, it } from "vitest";
// Side-effect import: registers the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { AtmosphereGpuResources } from "../../src/render/webgpu/atmosphere/AtmosphereGpuResources";
import type { AtmosphereSnapshot } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { VolumetricCloudSystem } from "../../src/render/webgpu/clouds/VolumetricCloudSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  beginGpuWorkWindow,
  endGpuWorkWindow,
  installGpuWorkCounters,
  uninstallGpuWorkCounters,
} from "../perf/gpuWorkCounters";

/**
 * The clouds' steady frames create no GPU bind groups.
 *
 * The temporal resolve ping-pongs between two history textures. Rebinding one
 * compute shader to the other half every frame made Babylon build a new bind
 * group every frame, on every tier (a GPU object only a major GC frees). One
 * shader per parity keeps both (`temporalCompute` in VolumetricCloudSystem).
 * Counted the perf capture's way (`tests/perf/gpuWorkCounters.ts`).
 */

const SNAPSHOT: AtmosphereSnapshot = {
  sunDirection: new Vector3(0.3, 0.8, 0.52).normalize(),
  sunColor: new Color3(1, 0.96, 0.9),
  sunIntensity: 4.6,
  skyZenith: new Color3(0.2, 0.45, 0.85),
  skyHorizon: new Color3(0.7, 0.78, 0.88),
  ambientColor: new Color3(0.4, 0.45, 0.55),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.88,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.35,
  humidity: 0.45,
  windSpeed: 8,
  windDirection: new Vector2(0.28, 0.96),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

describe("cloud temporal resolve bind groups", () => {
  it("creates none once both parities have run, and new ones only when the targets are rebuilt", async () => {
    installGpuWorkCounters();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    try {
      await engine.initAsync();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new UniversalCamera("cloud-bind-group-camera", new Vector3(0, 600, 0), scene);
      scene.activeCamera = camera;
      const resources = new AtmosphereGpuResources(scene, camera);
      const clouds = new VolumetricCloudSystem(
        scene, camera, resolveWebGpuQualityProfile("low", "balanced"), SNAPSHOT, resources,
      );
      try {
        await clouds.whenReadyAsync(undefined, 30_000);
        let frameIndex = 0;
        const frames = async (count: number): Promise<void> => {
          for (let frame = 0; frame < count; frame += 1, frameIndex += 1) {
            camera.position.set(frameIndex * 3, 600, -frameIndex * 2);
            engine.beginFrame();
            clouds.update(camera.position, frameIndex / 60);
            scene.render(false, false);
            engine.endFrame();
            await device.queue.onSubmittedWorkDone();
          }
        };
        // Both parities dispatch once and build their bind groups.
        await frames(2);
        const before = clouds.statistics.temporalResolveDispatchCount;
        beginGpuWorkWindow();
        await frames(8);
        const steady = endGpuWorkWindow(8);
        expect(clouds.statistics.temporalResolveDispatchCount - before, "every frame resolved").toBe(8);
        expect(steady.bindGroupsCreated, "bind groups created over 8 steady frames").toBe(0);

        // CONTROL: the counter sees the bind groups a resize must build (new cloud targets).
        beginGpuWorkWindow();
        engine.setSize(400, 224);
        await frames(2);
        expect(endGpuWorkWindow(2).bindGroupsCreated).toBeGreaterThan(0);
      } finally {
        clouds.dispose();
        resources.dispose();
        scene.dispose();
      }
    } finally {
      uninstallGpuWorkCounters();
      engine.dispose();
      canvas.remove();
    }
  });
});
