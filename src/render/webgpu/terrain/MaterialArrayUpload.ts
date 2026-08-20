import type { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import {
  planMippedTextureArray,
  uploadMippedTextureArrayPlan,
  type MippedTextureArrayPlan,
} from "@/src/render/webgpu/core/TextureArrayMips";
import { normalizeSeed } from "@/src/world/seed";
import type { WorldSeed } from "@/src/world/types";
import {
  synthesizeSurfaceMaterialLayers,
  TOKSVIG_ROUGHNESS_GAIN,
  type SurfaceMaterialArrayPlans,
} from "./MaterialArraySynthesis";

/**
 * `3-1`'s GPU boundary, split out at `4.5-C2b`.
 *
 * INVARIANT THIS FILE OWNS: the one place synthesised terrain material layers
 * become GPU textures — the mip plan, the upload and the sampler settings.
 *
 * It exists as its own file because `MaterialArraySynthesis.ts` must have NO
 * Babylon value import: the ten ~110 ms layer syntheses run in a WORKER now
 * (`src/workers/materialSynthesis.worker.ts`), and a worker that transitively
 * loads Babylon's texture stack pays for a module graph it can never use. The
 * split is along the line that module's header already drew.
 */

export interface SurfaceMaterialArrays {
  readonly albedoHeight: RawTexture2DArray;
  readonly normalMaterial: RawTexture2DArray;
  readonly edge: number;
  readonly layerCount: number;
  readonly memoryMiB: number;
}

/**
 * The pure half of `createSurfaceMaterialArrays` (it lives here rather than
 * beside the recipes because `planMippedTextureArray` is a Babylon-importing
 * module). Array A reduces through the
 * plain box kernel (albedo and height are both linear quantities); array B
 * reduces through Toksvig, which is the whole reason `2-11`'s module grew a
 * third kernel.
 */
export function planSurfaceMaterialArrays(
  seed: WorldSeed,
  edge: number,
): SurfaceMaterialArrayPlans {
  const layers = synthesizeSurfaceMaterialLayers(seed, edge);
  // Array A reduces through the plain box kernel, which averages the STORED
  // gamma-2.0 bytes rather than the linear values they encode. That is the
  // same approximation a GPU makes mipping an sRGB texture without an
  // sRGB-aware reducer, and it is worth measuring rather than assuming:
  // across the ten layers the mean LINEAR albedo drifts by at most 3.0% (shrub)
  // from mip 0 to the 1x1 tail, most under 1%. A dedicated linearising kernel
  // would cost a third reduction path in a performance-owned module to remove
  // an error smaller than the seasonal tint.
  const albedoHeight = planMippedTextureArray(layers.albedoHeight, edge, "box");
  const normalMaterial = planMippedTextureArray(layers.normalMaterial, edge, {
    kind: "toksvig",
    roughnessGain: TOKSVIG_ROUGHNESS_GAIN,
  });
  return {
    edge,
    albedoHeight,
    normalMaterial,
    totalBytes: albedoHeight.totalBytes + normalMaterial.totalBytes,
  };
}

/**
 * `3-3`'s sampler requirement: 16x anisotropy. The terrain is seen at grazing
 * angles almost all the time — that is what flying is — and trilinear alone
 * turns the far half of every frame to mush. It is a per-texture setting, so
 * it belongs here rather than on the material (the note `1B-11` left).
 */
export const SURFACE_ARRAY_ANISOTROPY = 16;

/**
 * GPU boundary, second half: mip and upload layers that have already been
 * synthesised.
 *
 * Split out from `createSurfaceMaterialArrays` so a caller can spread the
 * synthesis over several tasks and upload once at the end — which the renderer
 * must do, because a second of unbroken main-thread work during startup is not
 * merely rude, it broke the first frame (see `TerrainClipmapSystem`).
 */
export function uploadSurfaceMaterialArrays(
  scene: Scene,
  layers: { readonly albedoHeight: Uint8Array[]; readonly normalMaterial: Uint8Array[] },
  seed: WorldSeed,
  edge: number,
): SurfaceMaterialArrays {
  const albedoHeightPlan = planMippedTextureArray(layers.albedoHeight, edge, "box");
  const normalMaterialPlan = planMippedTextureArray(layers.normalMaterial, edge, {
    kind: "toksvig",
    roughnessGain: TOKSVIG_ROUGHNESS_GAIN,
  });
  return finishSurfaceMaterialArrays(scene, albedoHeightPlan, normalMaterialPlan, seed, edge);
}

/** GPU boundary: synthesise, mip and upload both arrays in one call. */
export function createSurfaceMaterialArrays(
  scene: Scene,
  seed: WorldSeed,
  edge: number,
): SurfaceMaterialArrays {
  const plans = planSurfaceMaterialArrays(seed, edge);
  return finishSurfaceMaterialArrays(
    scene,
    plans.albedoHeight,
    plans.normalMaterial,
    seed,
    edge,
  );
}

function finishSurfaceMaterialArrays(
  scene: Scene,
  albedoHeightPlan: MippedTextureArrayPlan,
  normalMaterialPlan: MippedTextureArrayPlan,
  seed: WorldSeed,
  edge: number,
): SurfaceMaterialArrays {
  const plans = { albedoHeight: albedoHeightPlan, normalMaterial: normalMaterialPlan };
  const name = normalizeSeed(seed);
  const configure = (texture: RawTexture2DArray): RawTexture2DArray => {
    texture.anisotropicFilteringLevel = SURFACE_ARRAY_ANISOTROPY;
    // The layers tile by construction; anything but WRAP would put a clamped
    // seam every few metres across the world.
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    return texture;
  };
  return {
    albedoHeight: configure(uploadMippedTextureArrayPlan(scene, plans.albedoHeight, {
      name: `surface-albedo-height/${name}`,
    })),
    normalMaterial: configure(uploadMippedTextureArrayPlan(scene, plans.normalMaterial, {
      name: `surface-normal-material/${name}`,
    })),
    edge,
    layerCount: plans.albedoHeight.layerCount,
    memoryMiB: (plans.albedoHeight.totalBytes + plans.normalMaterial.totalBytes) / (1024 * 1024),
  };
}

