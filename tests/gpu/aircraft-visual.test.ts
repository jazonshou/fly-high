import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";
import { createWebGpuAircraft } from "../../src/render/webgpu/aircraft";

/**
 * Fix-pack A1: the F-22 rebuild renders as actual pixels, not merely a green
 * compile — the standing "GPU tests pass while the screen is black" lesson.
 * Renders the jet from a chase-style angle, asserts the frame carries
 * structure, and writes the PNG to tests/perf/artifacts for human review.
 */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: true,
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

describe("F-22 visual render (fix-pack A1)", () => {
  it("renders the jet with visible structure and writes a review frame", async () => {
    gpuErrors.length = 0;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.45, 0.6, 0.78, 1);
    try {
      const camera = new FreeCamera("f22-visual-camera", new Vector3(-16, 7, -14), scene);
      camera.setTarget(new Vector3(1, 0, 0));
      camera.fov = 0.9;
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "f22-visual-sun",
        new Vector3(-0.45, -0.75, 0.35).normalize(),
        scene,
      );
      sun.intensity = 2.6;
      const fill = new HemisphericLight("f22-visual-fill", Vector3.Up(), scene);
      fill.intensity = 0.85;
      const environmentProbe = new ReflectionProbe("f22-visual-probe", 32, scene, true, true);
      scene.environmentTexture = environmentProbe.cubeTexture;

      const jet = createWebGpuAircraft(scene, "jet");
      jet.update({
        ...INITIAL_VISUAL_STATE,
        engineRpm: 80,
        gear: 0,
        onGround: false,
        simulationTime: 1,
      }, 1 / 60);

      await scene.whenReadyAsync();
      for (let frame = 0; frame < 4; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
      }
      // Snapshot synchronously with the last submit (the 0-8 harness rule).
      engine.beginFrame();
      scene.render();
      const pngBase64 = canvas.toDataURL("image/png").split(",")[1]!;
      engine.endFrame();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);

      // Structure floor: the frame must not be the bare clear colour.
      const probe = document.createElement("canvas");
      probe.width = canvas.width;
      probe.height = canvas.height;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("preview decode failed"));
      });
      image.src = `data:image/png;base64,${pngBase64}`;
      await loaded;
      const context = probe.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
      let mean = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        mean += (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / (3 * 255);
      }
      mean /= pixels.length / 4;
      let variance = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const luminance = (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / (3 * 255);
        variance += (luminance - mean) * (luminance - mean);
      }
      variance /= pixels.length / 4;
      expect(mean).toBeGreaterThan(0.15);
      expect(mean).toBeLessThan(0.95);
      expect(variance).toBeGreaterThan(0.001);

      await commands.writeFile("tests/perf/artifacts/f22-preview.png", pngBase64, "base64");
      jet.dispose();
    } finally {
      scene.dispose();
    }
  }, 120_000);
});
