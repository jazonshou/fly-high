import { expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { createWebGpuAircraft } from "../../src/render/webgpu/aircraft";
import { synthesizeAircraftSurface, type AircraftPaintRecipe } from "../../src/render/webgpu/aircraft/materialSynthesis";
import { createAirfieldMaterials, synthesizeAirfieldConcrete, synthesizeAirfieldMetal } from "../../src/render/webgpu/airfield/AirfieldMaterials";
import { planMippedTextureArray, uploadMippedTextureArrayPlan } from "../../src/render/webgpu/core/TextureArrayMips";

/**
 * FI-5 AUDIT PROBE (measurement only -- it asserts no device error and PRINTS
 * a verdict per texture and level; it becomes the fix's gate once the upload
 * helpers are repaired, by asserting "CPU chain survives" on every row).
 *
 * Measured 2026-09-22 on 58c1eaa: aircraft paint (albedo, normal,
 * metallic-roughness) and airfield metal normal/MR OVERWRITTEN by Babylon's
 * own mips; airfield albedo and concrete indistinguishable (the chains agree
 * within 2); the texture-array upload (uploadMippedTextureArrayPlan, used by
 * the terrain material arrays, FoliageAtlas and ImpostorAtlas) OVERWRITTEN on
 * LAYER 0 only, layers 1+ keep the CPU chain -- the reverse of the order
 * TextureArrayMips.ts's docblock describes.
 *
 * For each upload path that creates a
 * texture with Babylon's own mip generation ON and then writes levels 1..n by
 * hand: which chain does the GPU hold afterwards -- the hand-built CPU chain,
 * or the GPU's own? Classified against a CONTROL built from level 0 alone with
 * the same flags, whose levels are necessarily the GPU's.
 */
it("audits the hand-built mip chains", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => errors.push(String((event as GPUUncapturedErrorEvent).error.message)));
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  new FreeCamera("audit-camera", new Vector3(0, 0, -5), scene);

  const controls: { name: string; built: BaseTexture; control: RawTexture; cpu: readonly Uint8Array[]; edge: number }[] = [];
  const control2d = (level0: Uint8Array, edge: number, levels: number, srgb: boolean) =>
    new RawTexture(level0, edge, edge, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, srgb, false, levels);

  // 1. AIRCRAFT PAINT, as shipped: the trainer's body.
  const visual = createWebGpuAircraft(scene, "trainer");
  const body = scene.materials.find((material) => material.name === "trainer-body") as PBRMaterial;
  const recipe = (body.metadata as { aircraftPaintRecipe: AircraftPaintRecipe }).aircraftPaintRecipe;
  const paint = synthesizeAircraftSurface(recipe);
  for (const [slot, mips, srgb] of [
    ["albedoTexture", paint.albedoMips, true], ["bumpTexture", paint.normalMips, false], ["metallicTexture", paint.metallicRoughnessMips, false],
  ] as const) {
    controls.push({ name: `aircraft trainer-body ${slot}`, built: body[slot]!, control: control2d(mips[0]!, paint.edge, mips.length, srgb), cpu: mips, edge: paint.edge });
  }
  // 2. AIRFIELD, as shipped.
  const seed = 1234;
  const airfield = createAirfieldMaterials(scene, seed);
  for (const [name, material, synthesis] of [
    ["metal", airfield.metal, synthesizeAirfieldMetal(seed)], ["concrete", airfield.concrete, synthesizeAirfieldConcrete(seed ^ 0x59f1_11f1)],
  ] as const) {
    for (const [slot, mips, srgb] of [
      ["albedoTexture", synthesis.albedoMips, true], ["bumpTexture", synthesis.normalMips, false], ["metallicTexture", synthesis.metallicRoughnessMips, false],
    ] as const) {
      controls.push({ name: `airfield ${name} ${slot}`, built: (material as PBRMaterial)[slot]!, control: control2d(mips[0]!, synthesis.edge, mips.length, srgb), cpu: mips, edge: synthesis.edge });
    }
  }
  // 3. A TEXTURE ARRAY through the terrain's own upload boundary, two layers of
  // normal/roughness-shaped data through the Toksvig kernel.
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
  const array = uploadMippedTextureArrayPlan(scene, plan, { name: "audit-array" });
  const arrayControl = new RawTexture2DArray(plan.packedLevels[0]!, edge, edge, plan.layerCount, Constants.TEXTUREFORMAT_RGBA, scene,
    true, false, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, undefined, plan.mipLevelCount);

  for (let frame = 0; frame < 4; frame += 1) {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await device.queue.onSubmittedWorkDone();
  }
  const read = async (texture: BaseTexture, level: number, layer = 0) => {
    const pixels = await texture.readPixels(layer, level);
    return new Uint8Array(pixels!.buffer, pixels!.byteOffset, pixels!.byteLength);
  };
  const differing = (a: Uint8Array, b: Uint8Array) => {
    let over = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (Math.abs(a[i]! - b[i]!) > 2) over += 1;
    return over;
  };
  const lines: string[] = [];
  const verdict = (vsCpu: number, vsGpu: number) => vsCpu === 0 && vsGpu > 0 ? "CPU chain survives"
    : vsGpu === 0 && vsCpu > 0 ? "OVERWRITTEN by the GPU's chain" : `unclear (cpu ${vsCpu}, gpu ${vsGpu})`;
  for (const { name, built, control, cpu, edge: e } of controls) {
    for (const level of [1, 2, 3]) {
      const gpu = await read(built, level);
      const generated = await read(control, level);
      lines.push(`${name.padEnd(40)} L${level} (${e >> level}): vs CPU ${String(differing(gpu, cpu[level]!)).padStart(6)}  vs GPU-generated ${String(differing(gpu, generated)).padStart(6)}  -> ${verdict(differing(gpu, cpu[level]!), differing(gpu, generated))}`);
    }
  }
  for (const layer of [0, 1]) {
    for (const level of [1, 2, 3]) {
      const gpu = await read(array, level, layer);
      const generated = await read(arrayControl, level, layer);
      const cpu = plan.layerChains[layer]![level]!;
      lines.push(`${`terrain-style array layer ${layer}`.padEnd(40)} L${level} (${edge >> level}): vs CPU ${String(differing(gpu, cpu)).padStart(6)}  vs GPU-generated ${String(differing(gpu, generated)).padStart(6)}  -> ${verdict(differing(gpu, cpu), differing(gpu, generated))}`);
    }
  }
  // Per channel: how far the GPU's chain is from the hand-built one (mean |d|, max |d|, and CPU mean vs GPU mean).
  const channelStats = (gpu: Uint8Array, cpu: Uint8Array) => [0, 1, 2, 3].map((c) => {
    let sum = 0, max = 0, cpuSum = 0, gpuSum = 0, n = 0;
    for (let i = c; i < Math.min(gpu.length, cpu.length); i += 4) { const d = Math.abs(gpu[i]! - cpu[i]!); sum += d; max = Math.max(max, d); cpuSum += cpu[i]!; gpuSum += gpu[i]!; n += 1; }
    return `${"RGBA"[c]} |d| ${(sum / n).toFixed(2)} max ${max} (cpu ${(cpuSum / n).toFixed(1)} gpu ${(gpuSum / n).toFixed(1)})`;
  }).join("  ");
  for (const { name, built, cpu } of controls.filter((c) => !c.name.includes("albedo") && !c.name.includes("concrete"))) {
    for (const level of [1, 3]) lines.push(`  ${name} L${level}: ${channelStats(await read(built, level), cpu[level]!)}`);
  }
  for (const level of [1, 3]) lines.push(`  array layer 0 L${level}: ${channelStats(await read(array, level, 0), plan.layerChains[0]![level]!)}`);
  console.log(`MIP AUDIT\n${lines.join("\n")}\ndevice errors: ${errors.length} ${errors[0] ?? ""}`);
  expect(errors).toEqual([]);
  visual.dispose();
  scene.dispose();
  engine.dispose();
  canvas.remove();
}, 180_000);
