import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import { Scene } from "@babylonjs/core/scene";
import { WaterColumnPass, type WaterColumnCausticSource } from "../../src/render/webgpu/underwater/WaterColumnPass";
import type { UnderwaterLight } from "../../src/render/webgpu/underwater/underwaterLight";

/**
 * The sea's caustics in the water-column pass, on a real adapter: a sandy
 * floor 6 m under a noon sun, seen through nearly clear water, with the pass
 * drawn once without caustics and once with them. A folded sea throws a
 * bright-and-dark web on the floor, far stronger than the faint one the
 * capillary tail alone leaves at the calmest wind; past the 24 m caustic gate
 * the floor is exactly as it was.
 */

const WIDTH = 96;
const HEIGHT = 96;
const SHALLOW = { cameraY: -3, floorY: -6 };
const DEEP = { cameraY: -37, floorY: -40 };
const FLOOR_COLOUR = 0.5;
const PATCH_METERS = 8;
const TEXELS = 32;

const SHADER = "underwaterCausticsTestFloor";

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  ShaderStore.ShadersStoreWGSL[`${SHADER}VertexShader`] = `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
  ShaderStore.ShadersStoreWGSL[`${SHADER}FragmentShader`] = `
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4f(vec3f(${FLOOR_COLOUR}), 1.0);
}
`;
  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
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

const LIGHT = {
  attenuation: [0.02, 0.02, 0.02],
  sunDiffuseAttenuation: [0, 0, 0],
  skyDiffuseAttenuation: [0, 0, 0],
  sunUpwelling: [0, 0, 0],
  skyUpwelling: [0, 0, 0],
  directFraction: 1,
  sunElevationSine: 1,
} as unknown as UnderwaterLight;

function toHalf(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((bits & 0x7fffff) >>> 13);
}

/** One cascade whose stored Jacobian folds in a 4 m swell across the patch (or lies flat at 1). */
function causticSource(scene: Scene, fold: number): WaterColumnCausticSource {
  const data = new Uint16Array(TEXELS * TEXELS * 4);
  for (let row = 0; row < TEXELS; row += 1) {
    for (let column = 0; column < TEXELS; column += 1) {
      const phase = (2 * Math.PI * 2 * column) / TEXELS;
      data[(row * TEXELS + column) * 4 + 3] = toHalf(1 + fold * Math.sin(phase));
    }
  }
  const slopes = RawTexture.CreateRGBATexture(
    data, TEXELS, TEXELS, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT,
  );
  slopes.wrapU = RawTexture.WRAP_ADDRESSMODE;
  slopes.wrapV = RawTexture.WRAP_ADDRESSMODE;
  return {
    bindCaustics(target) {
      for (let index = 0; index < 5; index += 1) target.setTexture(`slopeFoam${index}`, slopes);
      target.setVector4("patchLengths0", new Vector4(PATCH_METERS, PATCH_METERS, PATCH_METERS, PATCH_METERS));
      target.setFloat("patchLength4", PATCH_METERS);
      target.setFloat("cascadeCount", 1);
      // A 4 m band: k / choppiness with k = 2 pi / 4.
      target.setVector4("causticCurvatureScales0", new Vector4((2 * Math.PI) / 4, 0, 0, 0));
      target.setFloat("causticCurvatureScale4", 0);
      target.setVector4("cascadeWavelengths0", new Vector4(4, 0, 0, 0));
      target.setFloat("cascadeWavelength4", 0);
      target.setVector2("oceanWind", Vector2.Zero());
    },
  };
}

async function render(
  caustics: boolean,
  fold: number,
  { cameraY, floorY }: { cameraY: number; floorY: number } = SHALLOW,
): Promise<Float32Array> {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("underwater-caustics-camera", new Vector3(0, cameraY, 0), scene);
  const pitch = (35 * Math.PI) / 180;
  camera.setTarget(new Vector3(0, cameraY - Math.sin(pitch) * 10, Math.cos(pitch) * 10));
  camera.fov = 1.0;
  camera.minZ = 0.08;
  camera.maxZ = 30_000;
  scene.activeCamera = camera;
  const floor = CreateBox("floor", { width: 200, height: 0.02, depth: 200 }, scene);
  floor.position.set(0, floorY - 0.01, 0);
  floor.material = new ShaderMaterial("floor", scene, { vertex: SHADER, fragment: SHADER }, {
    attributes: ["position"],
    uniforms: ["worldViewProjection"],
    shaderLanguage: ShaderLanguage.WGSL,
  });
  const pass = new WaterColumnPass(camera, engine, 1, LIGHT, { source: causticSource(scene, fold), enabled: caustics });
  pass.setEnabled(camera, true);
  pass.setCameraDepth(-cameraY, -cameraY);
  pass.setWorld(0, 0, 0);
  const output = new PassPostProcess(
    "underwater-caustics-out", 1, camera, Constants.TEXTURE_NEAREST_SAMPLINGMODE, engine, false,
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
    const copy = document.createElement("canvas");
    copy.width = WIDTH;
    copy.height = HEIGHT;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const floorGreen = new Float32Array(WIDTH * HEIGHT);
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) floorGreen[index] = pixels[index * 4 + 1]! / 255;
    return floorGreen;
  } finally {
    scene.dispose();
  }
}

/** Ratios of the caustic frame to the plain one over the floor's near half (where the web is resolved). */
function ratios(withCaustics: Float32Array, without: Float32Array): number[] {
  const values: number[] = [];
  for (let row = HEIGHT / 2; row < HEIGHT; row += 2) {
    for (let x = 4; x < WIDTH; x += 4) {
      const plain = without[row * WIDTH + x]!;
      if (plain > 0.05) values.push(withCaustics[row * WIDTH + x]! / plain);
    }
  }
  return values;
}

function spread(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

describe("caustics in the water column", () => {
  it("throw a web of light on the floor under a folded sea", async () => {
    const plain = await render(false, 0.4);
    const folded = await render(true, 0.4);
    const calm = await render(true, 0);
    expect(gpuErrors).toEqual([]);
    const web = ratios(folded, plain);
    expect(web.length).toBeGreaterThan(100);
    expect(Math.max(...web)).toBeGreaterThan(1.5);
    expect(Math.min(...web)).toBeLessThan(0.8);
    // The calmest wind's capillary tail leaves a faint web of its own.
    expect(spread(web)).toBeGreaterThan(2 * spread(ratios(calm, plain)));
  });

  it("leave a floor past the caustic gate exactly as it was", async () => {
    const plain = await render(false, 0.4, DEEP);
    const folded = await render(true, 0.4, DEEP);
    expect(gpuErrors).toEqual([]);
    const values = ratios(folded, plain);
    expect(values.length).toBeGreaterThan(100);
    for (const value of values) expect(value).toBeCloseTo(1, 6);
  });
});
