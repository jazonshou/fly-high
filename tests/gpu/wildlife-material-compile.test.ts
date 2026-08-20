import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { WildlifeSystem } from "../../src/render/webgpu/wildlife/WildlifeSystem";
import { TerrainBiome } from "../../src/world";

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

describe("wildlife material stack compiles on-adapter (Gate A-5)", () => {
  it("renders every shared RH prototype with feather, fur, and keratin PBR variants", async () => {
    gpuErrors.length = 0;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.03, 0.05, 0.08, 1);
    try {
      const camera = new FreeCamera("wildlife-compile-camera", new Vector3(0, 3, -15), scene);
      camera.setTarget(new Vector3(0, 1, 0));
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "wildlife-compile-sun",
        new Vector3(-0.5, -0.8, -0.25).normalize(),
        scene,
      );
      sun.intensity = 2.2;
      const fill = new HemisphericLight("wildlife-compile-fill", Vector3.Up(), scene);
      fill.intensity = 0.65;

      const system = new WildlifeSystem(scene, {
        worldSeed: "wildlife-adapter-compile",
        terrainSample: () => ({ height: 0, slope: 0, biome: TerrainBiome.FOREST }),
      });
      const prototypes = scene.meshes.filter(
        (mesh) => mesh.metadata?.wildlifePrototype === true,
      ) as Mesh[];
      expect(prototypes).toHaveLength(10);
      for (const [index, prototype] of prototypes.entries()) {
        prototype.thinInstanceSetMatrixAt(
          0,
          Matrix.Translation((index - 4.5) * 1.2, 0, 0),
          true,
        );
        prototype.thinInstanceCount = 1;
        prototype.setEnabled(true);
      }

      await scene.whenReadyAsync();
      for (let frame = 0; frame < 3; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      system.dispose();
    } finally {
      scene.dispose();
    }
  }, 60_000);
});
