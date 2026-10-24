import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer";
import { Scene } from "@babylonjs/core/scene";
import { resolveAerialPerspectiveBinding } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { resolveEnvironmentState } from "../../src/render/webgpu/nature/EnvironmentDirector";
import { steamWispCount, VolcanicSteamSystem } from "../../src/render/webgpu/volcanic/VolcanicSteamSystem";
import { createWorld } from "../../src/world";
import type { VolcanicVent } from "../../src/world/volcanism";

/**
 * Volcanic phase 5 — the steam sprite on a real adapter.
 *
 * Four things no Node test can see: that the WGSL compiles (with the aerial
 * include and the cloud constants spliced in), that the sampler-less r32float
 * scene depth binds, that the effect is ready inside `scene.whenReadyAsync`
 * like every other startup effect, and that the render PIPELINE exists before
 * the first vent comes into range. The last is the hitch the priming draw
 * exists to prevent: WebGPU builds a pipeline on its first draw, so a pipeline
 * created when the steam first appears is a stall at the moment it appears.
 *
 * Compile errors are read from `getCompilationInfo`, not from an error
 * channel: Babylon owns the uncaptured-error handler (`light-points-compile`
 * records how that once passed a broken shader).
 */

const SIZE = 96;
const GROUND_Y = 300;
const VENT: VolcanicVent = { x: 0, z: 0, radiusMeters: 120, strength: 1, seed: 0x5eed };

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const modules: { code: string; module: GPUShaderModule }[] = [];
const steamPipelines: string[] = [];
let interceptionInstalled = false;

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  engine.useReverseDepthBuffer = true;
  const device = (engine as unknown as { _device?: GPUDevice })._device;
  if (!device) return;
  const createModule = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
    const created = createModule(descriptor);
    modules.push({ code: String(descriptor.code), module: created });
    return created;
  };
  const isSteam = (descriptor: GPURenderPipelineDescriptor): boolean =>
    modules.some((record) => record.module === descriptor.vertex.module
      && record.code.includes("steamWind"));
  const createPipeline = device.createRenderPipeline.bind(device);
  device.createRenderPipeline = (descriptor: GPURenderPipelineDescriptor) => {
    if (isSteam(descriptor)) steamPipelines.push("sync");
    return createPipeline(descriptor);
  };
  const createPipelineAsync = device.createRenderPipelineAsync.bind(device);
  device.createRenderPipelineAsync = (descriptor: GPURenderPipelineDescriptor) => {
    if (isSteam(descriptor)) steamPipelines.push("async");
    return createPipelineAsync(descriptor);
  };
  interceptionInstalled = true;
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** IEEE 754 half -> float, as `light-points-radiometry.test.ts` decodes it. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * Render the depth pass and the probe target directly and return the mean
 * linear RGB. Directly, not through `scene.render()`: a swapchain-coupled
 * frame cannot be read back in the GPU environment (see
 * `light-points-radiometry.test.ts`), and a cleared canvas read back as zero.
 */
async function renderAndRead(
  depthMap: RenderTargetTexture,
  target: RenderTargetTexture,
): Promise<[number, number, number]> {
  depthMap.render();
  target.render();
  const raw = (await target.readPixels())!;
  const pixels = raw instanceof Float32Array
    ? [...raw]
    : [...(raw as Uint16Array)].map(halfToFloat);
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 4) {
    sum[0] += pixels[index]!;
    sum[1] += pixels[index + 1]!;
    sum[2] += pixels[index + 2]!;
  }
  const count = pixels.length / 4;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

describe("volcanic steam on a real adapter", () => {
  it("installed the shader and pipeline interception", () => {
    expect(interceptionInstalled, "could not reach the GPUDevice").toBe(true);
  });

  it("compiles at load, primes its pipeline before any vent, and draws a lit plume", async () => {
    const scene = new Scene(engine);
    let system: VolcanicSteamSystem | null = null;
    let depth: DepthRenderer | null = null;
    let target: RenderTargetTexture | null = null;
    try {
      scene.useRightHandedSystem = true;
      scene.clearColor = new Color4(0, 0, 0, 1);
      const camera = new FreeCamera("camera", new Vector3(0, GROUND_Y + 40, -420), scene);
      camera.setTarget(new Vector3(0, GROUND_Y + 160, 0));
      camera.minZ = 0.5;
      camera.maxZ = 30_000;
      scene.activeCamera = camera;
      const ground = CreateGround("ground", { width: 6_000, height: 6_000 }, scene);
      ground.position.y = GROUND_Y;
      const groundMaterial = new StandardMaterial("ground-material", scene);
      groundMaterial.disableLighting = true;
      groundMaterial.emissiveColor = new Color3(0.02, 0.02, 0.02);
      ground.material = groundMaterial;
      // The atmosphere's scene depth, as AtmosphereGpuResources builds it:
      // float, camera-space Z, terrain only.
      depth = new DepthRenderer(scene, Constants.TEXTURETYPE_FLOAT, camera, false,
        Texture.NEAREST_SAMPLINGMODE, true, "steam-test-depth");
      const depthMap = depth.getDepthMap();
      depthMap.renderList = [ground];
      scene.customRenderTargets.push(depthMap);

      const world = { ...createWorld("gpu-steam", { airport: false }), prevailingWindRadians: Math.PI / 2, prevailingWindSpeed: 5 };
      system = new VolcanicSteamSystem(scene, world, {
        maxWisps: 128,
        groundHeight: () => GROUND_Y,
        queryVents: (_world, minX, minZ, maxX, maxZ, out) => {
          out.length = 0;
          if (VENT.x >= minX && VENT.x <= maxX && VENT.z >= minZ && VENT.z <= maxZ) out.push(VENT);
          return out;
        },
      });
      const state = resolveEnvironmentState({
        clock: { dayOfYear: 171, solarTimeHours: 15 },
        latitudeDegrees: 45,
        weather: "clear",
      });
      target = new RenderTargetTexture("steam-test-target", SIZE, scene, {
        type: Constants.TEXTURETYPE_HALF_FLOAT,
        format: Constants.TEXTUREFORMAT_RGBA,
        generateMipMaps: false,
        generateDepthBuffer: true,
      });
      target.activeCamera = camera;
      target.renderList = [ground, system.mesh!];
      target.clearColor = new Color4(0, 0, 0, 1);
      system.setAerialPerspective(resolveAerialPerspectiveBinding(
        state,
        GROUND_Y + 40,
        [1, 0.9, 0.75],
        [0.55, 0.72, 0.93],
        0.87,
      ));

      // Compile at load: the effect is ready once the scene is.
      await scene.whenReadyAsync();
      expect(system.mesh!.material!.isReady(system.mesh!, true)).toBe(true);
      expect(steamPipelines, "a steam pipeline before any steam frame").toEqual([]);

      // Far from the vent: the priming frame draws one collapsed instance and
      // creates the pipeline; the next frame submits nothing.
      system.update(60_000, 0, 0);
      expect(system.drawing).toBe(true);
      const primed = await renderAndRead(depthMap, target);
      expect(steamPipelines.length, "the priming frame created no steam pipeline").toBeGreaterThan(0);
      const pipelinesAfterPrime = steamPipelines.length;
      system.update(60_000, 0, 1);
      expect(system.drawing).toBe(false);
      const empty = await renderAndRead(depthMap, target);
      // The collapsed instance rasterised nothing.
      expect(primed).toEqual(empty);

      // Bind the real scene depth (r32float, no sampler), then fly to the vent.
      system.setSceneDepth(depthMap);
      for (let frame = 0; frame < 12; frame += 1) system.update(0, -420, 30 + frame / 30);
      expect(system.wispCount).toBe(steamWispCount(VENT));
      expect(system.drawing).toBe(true);
      await renderAndRead(depthMap, target);
      const steaming = await renderAndRead(depthMap, target);
      expect(
        steamPipelines.length,
        "the first frame with steam in view built a pipeline — the hitch priming exists to prevent",
      ).toBe(pipelinesAfterPrime);
      // White steam over a near-black frame: every channel rises, and it is
      // not tinted to one channel.
      for (let channel = 0; channel < 3; channel += 1) {
        expect(steaming[channel]!, `channel ${channel}`).toBeGreaterThan(empty[channel]! + 0.002);
      }
      const brightest = Math.max(...steaming);
      expect(Math.min(...steaming) / brightest).toBeGreaterThan(0.6);

      const diagnostics: string[] = [];
      for (const record of modules) {
        if (!record.code.includes("steamWind") && !record.code.includes("steamSceneDepth")) continue;
        const info = await record.module.getCompilationInfo();
        for (const message of info.messages) {
          if (message.type === "error") diagnostics.push(`${message.lineNum}:${message.linePos} ${message.message}`);
        }
      }
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(modules.some((record) => record.code.includes("fn aerialPerspective(")
        && record.code.includes("steamWind"))).toBe(true);
    } finally {
      target?.dispose();
      system?.dispose();
      depth?.dispose();
      scene.dispose();
    }
  });
});
