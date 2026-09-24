import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";
import { createWebGpuAircraft } from "../../src/render/webgpu/aircraft";
import { synthesizeAircraftSurface, type AircraftPaintRecipe } from "../../src/render/webgpu/aircraft/materialSynthesis";
import { createAirfieldMaterials, synthesizeAirfieldConcrete, synthesizeAirfieldMetal } from "../../src/render/webgpu/airfield/AirfieldMaterials";
import { createRawTextureFromMipChain } from "../../src/render/webgpu/core/MipChainUpload";
import {
  planMippedTextureArray,
  uploadMippedTextureArrayPlan,
  type MippedTextureArrayPlan,
} from "../../src/render/webgpu/core/TextureArrayMips";
import { FOLIAGE_ALPHA_TEST_THRESHOLD, planFoliageAtlas } from "../../src/render/webgpu/detail/FoliageAtlas";
import { planImpostorAtlas } from "../../src/render/webgpu/detail/ImpostorAtlas";
import { planSurfaceMaterialArrays } from "../../src/render/webgpu/terrain/MaterialArrayUpload";

/**
 * FI-5: THE HAND-BUILT MIP CHAINS REACH THE GPU, AND THE SAMPLER READS THEM.
 *
 * Every hand-built chain used to be uploaded with Babylon's own generation ON
 * and levels 1..N-1 written after it, and on WebGPU the blit lands last and
 * replaces them (`src/render/webgpu/core/MipChainUpload.ts` has the
 * mechanism). The audit that measured it (2026-09-22, on 58c1eaa) is this
 * file's first test, now asserting instead of printing:
 *
 *   aircraft paint (albedo, normal, metallic-roughness)   OVERWRITTEN
 *   airfield metal normal and metallic-roughness           OVERWRITTEN
 *   airfield albedo, concrete                              indistinguishable (chains agree within 2)
 *   texture arrays (terrain, foliage, impostor)            layer 0 OVERWRITTEN, layers 1+ intact
 *
 * Surviving is half of it. Built without generation, a texture's sampler
 * reads level 0 only unless told otherwise, so the third test draws a texture
 * whose deep levels are a colour its level 0 does not average to, and asks
 * which one the GPU shows.
 */

let canvas: HTMLCanvasElement;
let engine: WebGPUEngine;
let device: GPUDevice;
const errors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => errors.push(String((event as GPUUncapturedErrorEvent).error.message)));
});

afterAll(() => {
  engine.dispose();
  canvas.remove();
});

/** Render a few canvas frames, so any blit recorded into the upload encoder is submitted, and drain. */
async function settle(scene: Scene): Promise<void> {
  for (let frame = 0; frame < 4; frame += 1) {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await device.queue.onSubmittedWorkDone();
  }
  // As the terrain engineer's probe waits: long enough for a deferred blit to have landed.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function read(texture: BaseTexture, level: number, layer = 0): Promise<Uint8Array> {
  const pixels = await texture.readPixels(layer, level, null, true, true);
  return new Uint8Array(pixels!.buffer, pixels!.byteOffset, pixels!.byteLength);
}

/** Texels (as bytes) more than 2 apart: the audit's measure. */
function differing(a: Uint8Array, b: Uint8Array): number {
  let over = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (Math.abs(a[i]! - b[i]!) > 2) over += 1;
  return over;
}

describe("FI-5: hand-built mip chains", () => {
  it("survive on every shipped 2D upload path and on both layers of a texture array, where Babylon's own chain would not", async () => {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    new FreeCamera("fi5-camera", new Vector3(0, 0, -5), scene);
    // The CONTROL for each row: the same level 0, built the old way, with generation on and
    // nothing else written -- its levels are necessarily Babylon's.
    const control2d = (level0: Uint8Array, edge: number, levels: number, srgb: boolean) =>
      new RawTexture(level0, edge, edge, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, srgb, false, levels);
    const rows: { name: string; built: BaseTexture; control: BaseTexture; cpu: readonly Uint8Array[]; layer: number }[] = [];

    // Aircraft paint, as shipped: the trainer's body.
    const visual = createWebGpuAircraft(scene, "trainer");
    const body = scene.materials.find((material) => material.name === "trainer-body") as PBRMaterial;
    const paintMetadata = body.metadata as { aircraftPaintRecipe: AircraftPaintRecipe; aircraftPaintEdge?: number };
    const paint = synthesizeAircraftSurface(paintMetadata.aircraftPaintRecipe, paintMetadata.aircraftPaintEdge);
    // The CPU side is re-synthesised at the edge the build RECORDED (the trainer
    // paints at 256, not the shared 64); a build that stopped recording it would
    // compare a 64-texel control against 256-texel maps.
    expect(paintMetadata.aircraftPaintEdge, "the trainer body records the edge it was built at").toBe(body.albedoTexture!.getSize().width);
    expect(paint.edge).toBe(paintMetadata.aircraftPaintEdge);
    for (const [slot, mips, srgb] of [
      ["albedoTexture", paint.albedoMips, true], ["bumpTexture", paint.normalMips, false], ["metallicTexture", paint.metallicRoughnessMips, false],
    ] as const) {
      rows.push({ name: `aircraft trainer-body ${slot}`, built: body[slot]!, control: control2d(mips[0]!, paint.edge, mips.length, srgb), cpu: mips, layer: 0 });
    }
    // The airfield, as shipped.
    const seed = 1234;
    const airfield = createAirfieldMaterials(scene, seed);
    for (const [name, material, synthesis] of [
      ["metal", airfield.metal, synthesizeAirfieldMetal(seed)], ["concrete", airfield.concrete, synthesizeAirfieldConcrete(seed ^ 0x59f1_11f1)],
    ] as const) {
      for (const [slot, mips, srgb] of [
        ["albedoTexture", synthesis.albedoMips, true], ["bumpTexture", synthesis.normalMips, false], ["metallicTexture", synthesis.metallicRoughnessMips, false],
      ] as const) {
        rows.push({ name: `airfield ${name} ${slot}`, built: (material as PBRMaterial)[slot]!, control: control2d(mips[0]!, synthesis.edge, mips.length, srgb), cpu: mips, layer: 0 });
      }
    }
    // A texture array through the arrays' own boundary: two layers of normal/roughness data, Toksvig.
    const edge = 64;
    const layers = [0, 1].map((layer) => {
      const data = new Uint8Array(edge * edge * 4);
      for (let i = 0; i < edge * edge; i += 1) {
        const x = i % edge, y = Math.floor(i / edge);
        const a = Math.sin((x * (3 + layer)) / 5) * 0.6, b = Math.cos((y * (2 + layer)) / 4) * 0.6;
        data[i * 4] = Math.round((a * 0.5 + 0.5) * 255);
        data[i * 4 + 1] = Math.round((b * 0.5 + 0.5) * 255);
        data[i * 4 + 2] = Math.round(Math.sqrt(Math.max(0, 1 - a * a - b * b)) * 255);
        data[i * 4 + 3] = 90 + ((x + y + layer * 7) % 40);
      }
      return data;
    });
    const plan = planMippedTextureArray(layers, edge, { kind: "toksvig", roughnessGain: 0.5 });
    const array = uploadMippedTextureArrayPlan(scene, plan, { name: "fi5-array" });
    const arrayControl = new RawTexture2DArray(plan.packedLevels[0]!, edge, edge, plan.layerCount, Constants.TEXTUREFORMAT_RGBA, scene,
      true, false, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, plan.mipLevelCount);
    for (const layer of [0, 1]) rows.push({ name: `array layer ${layer}`, built: array, control: arrayControl, cpu: plan.layerChains[layer]!, layer });

    await settle(scene);
    const table: string[] = [];
    let distinguishable = 0;
    for (const row of rows) {
      for (const level of [1, 2, 3]) {
        const gpu = await read(row.built, level, row.layer);
        const vsCpu = differing(gpu, row.cpu[level]!);
        const vsGenerated = differing(gpu, await read(row.control, level, row.layer));
        table.push(`${row.name.padEnd(36)} L${level}: vs CPU ${String(vsCpu).padStart(6)}  vs Babylon's ${String(vsGenerated).padStart(6)}`);
        expect(vsCpu, `${row.name} L${level}: the GPU does not hold the CPU chain`).toBe(0);
        // Babylon blits face 0 only, so the array control's layer 1 holds no chain of its own to
        // compare against; it is left out of the count.
        if (vsGenerated > 0 && row.name !== "array layer 1") distinguishable += 1;
      }
    }
    console.log(`FI-5 CHAIN SURVIVAL\n${table.join("\n")}`);
    // THE INSTRUMENT CAN SEE THE DEFECT: on the rows where the two chains differ (all but airfield
    // albedo and concrete, which agree within 2 by construction), a GPU holding Babylon's chain
    // would have failed above. 3 aircraft maps + 2 airfield metal maps + array layer 0, 3 levels each.
    expect(distinguishable, "too few rows where the CPU and Babylon chains differ: the gate cannot see an overwrite").toBeGreaterThanOrEqual(18);
    expect(errors).toEqual([]);
    visual.dispose();
    scene.dispose();
  }, 180_000);

  it("survives layer 0 of every PRODUCTION texture array, to level 7 (the terrain engineer's probe, asserting)", async () => {
    // Their measurement on the shipped arrays found layer 0 overwritten -- the pine impostor's alpha
    // coverage 0 % at levels 5-7 against the CPU's 25-27 % -- and layer 1 intact, which stays here
    // as the readback's own control.
    engine.runRenderLoop(() => {});
    const scene = new Scene(engine);
    const seed = "phase1-perf-baseline";
    const terrain = planSurfaceMaterialArrays(seed, 512);
    const foliage = planFoliageAtlas(seed);
    const impostor = planImpostorAtlas(seed, foliage);
    const plans: [string, MippedTextureArrayPlan][] = [
      ["terrain normalMaterial", terrain.normalMaterial], ["terrain albedoHeight", terrain.albedoHeight],
      ["foliage", foliage], ["impostor albedo", impostor.albedo], ["impostor normalDepth", impostor.normalDepth],
    ];
    expect(FOLIAGE_ALPHA_TEST_THRESHOLD).toBeGreaterThan(0);
    try {
      for (const [name, plan] of plans) {
        const texture = uploadMippedTextureArrayPlan(scene, plan, { name });
        await new Promise((resolve) => setTimeout(resolve, 400));
        for (const layer of [0, 1]) {
          for (let level = 1; level < Math.min(plan.mipLevelCount, 8); level += 1) {
            const gpu = await read(texture, level, layer);
            const cpu = plan.layerChains[layer]![level]!;
            expect(differing(gpu.subarray(0, cpu.length), cpu), `${name} layer ${layer} L${level}`).toBe(0);
          }
        }
        texture.dispose();
      }
    } finally {
      engine.stopRenderLoop();
      scene.dispose();
    }
    expect(errors).toEqual([]);
  }, 600_000);

  it("is what the sampler reads: a minified quad shows the chain's colour, and neither control does", async () => {
    // Level 0 a black and white checker (it averages to grey); every level from 1 down solid red.
    // A 256 texture on a quad ~4 px across samples near level 6: red if and only if the GPU holds
    // the hand-built chain AND samples it.
    const size = 256;
    const levels: Uint8Array[] = [];
    for (let level = 0; size >> level >= 1; level += 1) {
      const edge = size >> level;
      const data = new Uint8Array(edge * edge * 4);
      for (let i = 0; i < edge * edge; i += 1) {
        const x = i % edge, y = Math.floor(i / edge);
        const white = ((x >> 2) + (y >> 2)) % 2 === 0;
        const rgb = level === 0 ? (white ? [255, 255, 255] : [0, 0, 0]) : [230, 20, 20];
        data.set([...rgb, 255], i * 4);
      }
      levels.push(data);
    }
    const shown = async (build: (scene: Scene) => BaseTexture): Promise<number[]> => {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0.5, 1);
      const camera = new FreeCamera("fi5-sampler-camera", new Vector3(0, 0, -20), scene);
      camera.setTarget(Vector3.Zero());
      camera.fov = 0.8;
      // A thin box, not CreatePlane: planeBuilder is not in vitest.gpu.config's pre-bundled
      // Babylon, so it loads unbundled with its own VertexBuffer class, one the WebGPU
      // alignment patch never reached ("arrayStride ... undefined" at pipeline creation).
      const quad = CreateBox("fi5-quad", { width: 1, height: 1, depth: 0.01 }, scene);
      // Unlit PBR, the material family this suite already compiles: it shows the albedo sample.
      const material = new PBRMaterial("fi5-unlit", scene);
      material.unlit = true;
      material.albedoColor = Color3.White();
      material.albedoTexture = build(scene);
      material.backFaceCulling = false;
      quad.material = material;
      const target = new RenderTargetTexture("fi5-sampler-view", 64, scene, { generateMipMaps: false, generateDepthBuffer: true });
      target.activeCamera = camera;
      target.renderList = [quad];
      target.clearColor = scene.clearColor;
      let pixel: number[] = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await device.queue.onSubmittedWorkDone();
        target.render();
        const view = (await target.readPixels())!;
        const pixels = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const at = (32 * 64 + 32) * 4;
        pixel = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
        if (!(pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 127) && !(pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 128)) break;
      }
      target.dispose();
      scene.dispose();
      return pixel;
    };
    const red = (rgb: number[]) => rgb[0]! > 150 && rgb[1]! < 80 && rgb[2]! < 80;

    const fixed = await shown((scene) => createRawTextureFromMipChain(scene, levels, size, size, { useSrgbBuffer: false }));
    // CONTROL 1: the same upload, but the sampler left at Babylon's default for a texture built
    // without generation. It must read level 0: grey or black or white, never red.
    const unread = await shown((scene) => {
      const texture = createRawTextureFromMipChain(scene, levels, size, size, { useSrgbBuffer: false });
      texture.getInternalTexture()!.useMipMaps = false;
      return texture;
    });
    // CONTROL 2: the construction every path used before the fix. Babylon's blit lands last and
    // replaces the red chain with the checker's own box-filtered grey.
    const overwritten = await shown((scene) => {
      const texture = new RawTexture(levels[0]!, size, size, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
        Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, false, false, levels.length);
      for (let level = 1; level < levels.length; level += 1) texture.updateMipLevel(levels[level]!, level);
      return texture;
    });
    console.log(`FI-5 SAMPLER: hand-built ${fixed.join(",")} | not sampled ${unread.join(",")} | old construction ${overwritten.join(",")}`);
    expect(red(fixed), `the fixed upload shows ${fixed.join(",")}, not the chain's red`).toBe(true);
    expect(red(unread), "the unsampled control shows red: the test cannot see an unread chain").toBe(false);
    expect(red(overwritten), "the old construction shows red: the test cannot see FI-5").toBe(false);
    expect(errors).toEqual([]);
  }, 180_000);
});
