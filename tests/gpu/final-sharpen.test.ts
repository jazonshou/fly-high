import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FxaaPostProcess } from "@babylonjs/core/PostProcesses/fxaaPostProcess";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { FxaaSharpenPass, SharpenPass } from "../../src/render/webgpu/lighting/SharpenPass";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";

/**
 * The final sharpen on a real adapter, in both forms.
 *
 * The fused pass (`FxaaSharpenPass`) replaced Babylon's FxaaPostProcess plus a
 * separate RCAS pass at the FXAA tiers. Two claims rest on it, and neither is
 * visible to the Node suite, which only reads the WGSL as text:
 *
 *  1. At a zero amount it IS Babylon's FXAA: same pixels, bit for bit. That is
 *     tier 0's whole image, and the proof that the port walks edges as the
 *     stock pass does.
 *  2. At tier 1's amount it sharpens as the two passes did. Not bit for bit:
 *     the fused pass solves RCAS's lobe against the cross BEFORE FXAA (see
 *     `SharpenPass`), so pixels next to an edge FXAA moved differ a little.
 *
 * The input is a synthetic display image drawn by a first post-process, so
 * the test owns every pixel: an aliased hard edge (FXAA's job), low-contrast
 * texture (RCAS's job), one-pixel lines and specks, and pure black and white.
 */

const WIDTH = 160;
const HEIGHT = 120;

const PATTERN_SHADER = "finalSharpenTestPattern";
const PATTERN_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // Integer pixel coordinates, so every adapter draws the same image.
  let size = vec2f(textureDimensions(textureSampler, 0));
  let p = floor(fragmentInputs.vUV * size);
  var colour = vec3f(0.0);
  if (p.x < 54.0) {
    // A hard edge at a shallow angle, unfiltered: stair steps for FXAA.
    let side = step(0.0, (p.y - 60.0) - 0.23 * (p.x - 27.0));
    colour = mix(vec3f(0.12, 0.2, 0.32), vec3f(0.85, 0.8, 0.7), side);
  } else if (p.x < 108.0) {
    // Soft ground-like texture: low contrast, where RCAS's lobe is largest.
    let n = hash(p) * 0.6 + hash(floor(p / 3.0)) * 0.4;
    colour = vec3f(0.34, 0.4, 0.22) + (n - 0.5) * vec3f(0.08, 0.09, 0.06);
  } else {
    // One-pixel lines and specks over black and white halves.
    let base = select(0.0, 1.0, p.y >= 60.0);
    colour = vec3f(base);
    if (p.x % 7.0 == 0.0) { colour = vec3f(0.5); }
    if (hash(p * 1.7) > 0.97) { colour = vec3f(1.0 - base); }
  }
  // Read the input once so the scene target stays bound; it adds nothing.
  colour += 0.0 * textureSampleLevel(textureSampler, textureSamplerSampler, fragmentInputs.vUV, 0.0).rgb;
  fragmentOutputs.color = vec4f(colour, 1.0);
  return fragmentOutputs;
}
`;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  ShaderStore.ShadersStoreWGSL[`${PATTERN_SHADER}FragmentShader`] = PATTERN_WGSL;
  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
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

function readPixels(): Uint8ClampedArray {
  const copy = document.createElement("canvas");
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

/**
 * Draw the pattern through the chain `attach` builds after it, and read the
 * canvas back. Render and copy in ONE synchronous task: the swapchain texture
 * is recycled once the compositor takes the frame (see `night-sky`).
 */
async function renderChain(
  attach: (camera: Camera) => PostProcess[],
): Promise<Uint8ClampedArray> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("final-sharpen-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const pattern = new PostProcess(
    "test-pattern", PATTERN_SHADER, null, null, 1, camera,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE, engine, false, undefined,
    Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, undefined, undefined, undefined,
    ShaderLanguage.WGSL,
  );
  const chain = [pattern, ...attach(camera)];
  try {
    for (let frame = 0; frame < 200 && !chain.every((pass) => pass.isReady()); frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(chain.every((pass) => pass.isReady()), "a pass never compiled").toBe(true);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    return readPixels();
  } finally {
    scene.dispose();
  }
}

const fxaaStock = (camera: Camera): PostProcess[] => [
  new FxaaPostProcess(
    "stock-fxaa", 1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine, false,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  ),
];
const fused = (amount: number) => (camera: Camera): PostProcess[] => [
  new FxaaSharpenPass(camera, engine, amount).postProcess,
];
const twoPass = (amount: number) => (camera: Camera): PostProcess[] => [
  ...fxaaStock(camera),
  new SharpenPass(camera, engine, amount).postProcess,
];

interface Difference {
  /** Mean absolute channel difference, in 1/255 steps. */
  mean: number;
  max: number;
  /** Fraction of pixels with any channel more than 2/255 apart. */
  changed: number;
}

function difference(a: Uint8ClampedArray, b: Uint8ClampedArray, x0 = 0, x1 = WIDTH): Difference {
  let sum = 0;
  let max = 0;
  let changed = 0;
  let count = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * WIDTH + x) * 4;
      let pixelMax = 0;
      for (let c = 0; c < 3; c += 1) {
        const d = Math.abs(a[i + c]! - b[i + c]!);
        sum += d;
        pixelMax = Math.max(pixelMax, d);
      }
      max = Math.max(max, pixelMax);
      if (pixelMax > 2) changed += 1;
      count += 1;
    }
  }
  return { mean: sum / (count * 3), max, changed: changed / count };
}

/** Mean absolute 4-neighbour Laplacian of green: how much fine contrast an image holds. */
function acutance(image: Uint8ClampedArray, x0: number, x1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < HEIGHT - 1; y += 1) {
    for (let x = Math.max(1, x0); x < Math.min(WIDTH - 1, x1); x += 1) {
      const g = (xx: number, yy: number) => image[(yy * WIDTH + xx) * 4 + 1]!;
      sum += Math.abs(4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1));
      count += 1;
    }
  }
  return sum / count;
}

describe("the final sharpen on a real adapter", () => {
  const tier1Amount = resolveWebGpuQualityProfile("medium", "balanced").sharpenAmount;

  it("is Babylon's FXAA, pixel for pixel, at a zero amount", async () => {
    const stock = await renderChain(fxaaStock);
    const port = await renderChain(fused(0));
    const delta = difference(stock, port);
    expect(gpuErrors).toEqual([]);
    expect(delta.max, `the port differs from stock FXAA: ${JSON.stringify(delta)}`).toBe(0);
    // Non-vacuous: FXAA moved the aliased edge, so the chain really ran it.
    const pattern = await renderChain(() => []);
    expect(difference(pattern, stock, 0, 54).changed).toBeGreaterThan(0.01);
  });

  it("sharpens as FXAA then RCAS did, at tier 1's amount", async () => {
    expect(tier1Amount).toBeGreaterThan(0);
    const fxaaOnly = await renderChain(fxaaStock);
    const separate = await renderChain(twoPass(tier1Amount));
    const fusedImage = await renderChain(fused(tier1Amount));
    expect(gpuErrors).toEqual([]);

    const whole = difference(separate, fusedImage);
    const texture = difference(separate, fusedImage, 54, 108);
    console.info(
      `[final-sharpen] fused vs two-pass at ${tier1Amount}: whole ${JSON.stringify(whole)}, `
      + `texture ${JSON.stringify(texture)}; acutance on texture: FXAA ${acutance(fxaaOnly, 54, 108).toFixed(2)}, `
      + `two-pass ${acutance(separate, 54, 108).toFixed(2)}, fused ${acutance(fusedImage, 54, 108).toFixed(2)}`,
    );
    // The soft texture is where the sharpen earns its keep; FXAA leaves most
    // of it alone, so there the two forms solve the same lobe.
    expect(texture.mean).toBeLessThan(0.5);
    expect(whole.mean).toBeLessThan(1);
    // And it still sharpens: the fused image holds the two-pass image's fine
    // contrast, well above FXAA's.
    const fusedAcutance = acutance(fusedImage, 54, 108);
    const separateAcutance = acutance(separate, 54, 108);
    expect(fusedAcutance).toBeGreaterThan(acutance(fxaaOnly, 54, 108) * 1.2);
    expect(Math.abs(fusedAcutance - separateAcutance) / separateAcutance).toBeLessThan(0.1);
  });
});
