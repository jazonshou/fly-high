import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import { Scene } from "@babylonjs/core/scene";
import { WaterColumnPass } from "../../src/render/webgpu/underwater/WaterColumnPass";
import type { UnderwaterLight } from "../../src/render/webgpu/underwater/underwaterLight";

/**
 * The water-column pass on a real adapter, at both depth bindings the chain
 * head can hand it: the single-sampled depth texture (tiers 0-1) and the
 * multisampled target's resolved r32float copy (tiers 2-3).
 *
 * The scene is a wall 3 m in front of the camera filling the top half of the
 * view, and nothing below the horizon, so a pixel whose fade is read from the
 * wrong row, or a depth read as nothing, is off by most of the range. The
 * light is chosen so every term can be written down: no dimming with depth,
 * c = 0.5 per metre, and the water's light 0.1 straight down.
 */

const WIDTH = 96;
const HEIGHT = 96;
const FOV = 1.0;
const WALL_DISTANCE = 3;
const WALL_COLOUR = 0.8;
const ATTENUATION = 0.5;
const UPWELLING = 0.1;
const CAMERA_Y = -50;

const WALL_SHADER = "underwaterColumnTestWall";
const WALL_VERTEX_WGSL = `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
const WALL_FRAGMENT_WGSL = `
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4f(vec3f(${WALL_COLOUR}), 1.0);
}
`;

const LIGHT = {
  attenuation: [ATTENUATION, ATTENUATION, ATTENUATION],
  sunDiffuseAttenuation: [0, 0, 0],
  skyDiffuseAttenuation: [0, 0, 0],
  sunUpwelling: [0, 0, 0],
  skyUpwelling: [UPWELLING, UPWELLING, UPWELLING],
  directFraction: 0,
} as unknown as UnderwaterLight;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  ShaderStore.ShadersStoreWGSL[`${WALL_SHADER}VertexShader`] = WALL_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${WALL_SHADER}FragmentShader`] = WALL_FRAGMENT_WGSL;
  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  // The renderer's depth convention.
  engine.useReverseDepthBuffer = true;
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function readPixels(): Uint8ClampedArray {
  const copy = document.createElement("canvas");
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

async function render(samples: number, strength: number, adaptation = 1): Promise<Uint8ClampedArray> {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.3, 0.3, 0.3, 1);
  const camera = new FreeCamera("underwater-column-camera", new Vector3(0, CAMERA_Y, 0), scene);
  camera.setTarget(new Vector3(0, CAMERA_Y, 10));
  camera.fov = FOV;
  camera.minZ = 0.08;
  camera.maxZ = 30_000;
  scene.activeCamera = camera;
  const wall = CreateBox("wall", { width: 40, height: 20, depth: 0.02 }, scene);
  wall.position.set(0, CAMERA_Y + 10, WALL_DISTANCE + 0.01);
  wall.material = new ShaderMaterial("wall", scene, { vertex: WALL_SHADER, fragment: WALL_SHADER }, {
    attributes: ["position"],
    uniforms: ["worldViewProjection"],
    shaderLanguage: ShaderLanguage.WGSL,
  });
  wall.material.backFaceCulling = false;
  const pass = new WaterColumnPass(camera, engine, samples, LIGHT);
  pass.setEnabled(camera, true);
  pass.setCameraDepth(-CAMERA_Y, -CAMERA_Y);
  pass.setStrength(strength);
  pass.setAdaptation(adaptation);
  const output = new PassPostProcess(
    "underwater-column-out", 1, camera, Constants.TEXTURE_NEAREST_SAMPLINGMODE, engine, false,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  try {
    const ready = () => pass.postProcess.isReady() && output.isReady() && scene.isReady();
    for (let frame = 0; frame < 200 && !ready(); frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready(), "a pass never compiled").toBe(true);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    return readPixels();
  } finally {
    scene.dispose();
  }
}

/** The pass's own value at a pixel, from the geometry above. */
function expected(x: number, row: number): number {
  const tangentX = (2 * (x + 0.5) / WIDTH - 1) * Math.tan(FOV / 2) * (WIDTH / HEIGHT);
  const tangentY = (1 - (2 * (row + 0.5)) / HEIGHT) * Math.tan(FOV / 2);
  const length = Math.hypot(tangentX, tangentY, 1);
  const mu = tangentY / length;
  const wallHit = tangentY > 0;
  const s = wallHit ? WALL_DISTANCE * length : Infinity;
  const transmitted = Number.isFinite(s) ? Math.exp(-ATTENUATION * s) : 0;
  const water = 3 ** (1 + mu) * UPWELLING * (1 - transmitted);
  return (wallHit ? WALL_COLOUR : 0) * transmitted + water;
}

function green(image: Uint8ClampedArray, x: number, y: number): number {
  return image[(y * WIDTH + x) * 4 + 1]! / 255;
}

describe("underwater water column", () => {
  for (const samples of [1, 4]) {
    it(`fades each pixel by the water to what it hits (${samples} sample${samples > 1 ? "s" : ""})`, async () => {
      const image = await render(samples, 1);
      expect(gpuErrors).toEqual([]);
      const misses: string[] = [];
      for (const row of [4, 16, 30, 40, 44, 52, 56, 70, 90]) {
        for (const x of [10, WIDTH / 2, WIDTH - 10]) {
          const want = expected(x, row);
          const got = green(image, x, row);
          if (Math.abs(got - want) > 3 / 255) misses.push(`row ${row} x ${x}: ${got.toFixed(3)} vs ${want.toFixed(3)}`);
        }
      }
      expect(misses).toEqual([]);
    });
  }

  it("scales all it shows by the eye's adaptation", async () => {
    const adaptation = 1.5;
    const image = await render(1, 1, adaptation);
    expect(gpuErrors).toEqual([]);
    const misses: string[] = [];
    for (const row of [4, 30, 44, 56, 90]) {
      const want = expected(WIDTH / 2, row) * adaptation;
      const got = green(image, WIDTH / 2, row);
      if (Math.abs(got - want) > 3 / 255) misses.push(`row ${row}: ${got.toFixed(3)} vs ${want.toFixed(3)}`);
    }
    expect(misses).toEqual([]);
  });

  it("passes the scene through untouched at strength 0", async () => {
    const image = await render(1, 0);
    expect(gpuErrors).toEqual([]);
    expect(green(image, WIDTH / 2, 20)).toBeCloseTo(WALL_COLOUR, 2);
    expect(green(image, WIDTH / 2, 80)).toBeCloseTo(0.3, 2);
  });
});
