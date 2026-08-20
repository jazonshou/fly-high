import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Logger } from "@babylonjs/core/Misc/logger";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";
import { createWebGpuAircraft } from "../../src/render/webgpu/aircraft";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "../../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { DEFAULT_ENVIRONMENT_STATE } from "../../src/render/webgpu/nature/EnvironmentState";

/** Gate A: production PBR paint mips plus clearcoat/refraction compile on WebGPU. */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

describe("aircraft material stack compiles on-adapter (Gate A)", () => {
  it("renders trainer and jet paint, normal/BRDF mips, clearcoat glass and transmission", async () => {
    gpuErrors.length = 0;
    const loggerErrors: string[] = [];
    const originalLoggerError = Logger.Error;
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      originalLoggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.05, 0.09, 0.13, 1);
    try {
      const camera = new FreeCamera("aircraft-compile-camera", new Vector3(12, 5, -16), scene);
      camera.setTarget(new Vector3(0, 0, 0));
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "aircraft-compile-sun",
        new Vector3(-0.6, -0.8, 0.2).normalize(),
        scene,
      );
      sun.intensity = 2.4;
      const fill = new HemisphericLight("aircraft-compile-fill", Vector3.Up(), scene);
      fill.intensity = 0.7;
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      const probe = new ReflectionProbe("aircraft-compile-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const trainer = createWebGpuAircraft(scene, "trainer");
      trainer.root.position.z = 3.2;
      const jet = createWebGpuAircraft(scene, "jet");
      jet.root.position.z = -3.2;
      for (const mesh of [...trainer.meshes, ...jet.meshes]) {
        if (mesh.metadata?.castsShadow !== false) shadows.addShadowCaster(mesh, false);
      }
      const cloudShadowReceivers = new CloudShadowReceiverRegistry();
      cloudShadowReceivers.registerMeshes(trainer.meshes);
      cloudShadowReceivers.registerMeshes(jet.meshes);
      const aerialReceivers = new AerialPerspectiveRegistry();
      aerialReceivers.registerMeshes(trainer.meshes);
      aerialReceivers.registerMeshes(jet.meshes);
      aerialReceivers.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [1, 0.95, 0.88],
        skyHorizonColor: [0.35, 0.55, 0.72],
        sunIlluminanceNormalized: 1,
      }, 0, 0);
      trainer.update({
        ...INITIAL_VISUAL_STATE,
        engineRpm: 2_250,
        simulationTime: 1,
      }, 1 / 60);

      await scene.whenReadyAsync();
      for (let frame = 0; frame < 4; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      expect(loggerErrors, loggerErrors.join("\n\n")).toEqual([]);
      aerialReceivers.dispose();
      cloudShadowReceivers.dispose();
      trainer.dispose();
      jet.dispose();
      shadows.dispose();
      probe.dispose();
    } finally {
      Logger.Error = originalLoggerError;
      scene.dispose();
    }
  }, 60_000);
});
