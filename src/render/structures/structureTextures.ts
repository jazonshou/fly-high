import { planMippedTextureArray, type MippedTextureArrayPlan } from "@/src/render/webgpu/core/TextureArrayMipPlan";
import {
  STRUCTURE_TEXTURE_LAYERS,
  synthesizeStructureTextures,
  type StructureTextureEdge,
} from "@/src/world/structures/kit/kitTextures";

/**
 * The building kit's two material arrays as the renderer uploads them
 * (`kitTextures.ts` synthesises the layers): every layer's whole mip chain,
 * reduced here and packed a level to a buffer, so the GPU side only copies.
 * Babylon-free, so the structures worker makes them (~0.3 s of synthesis at
 * 256, ~0.8 s at 512, and the mip reduction after) and transfers the levels.
 *
 *   detail  "box": RGB detail and the paint mask average down together.
 *   normal  "toksvig": the normal VECTOR averages and the length it loses goes
 *           into roughness, the terrain arrays' reducer and gain, so a wall
 *           at range turns matte rather than taking a false sharp highlight.
 */

/** The Toksvig gain, the terrain's (`TOKSVIG_ROUGHNESS_GAIN` in `MaterialArraySynthesis.ts`; a test pins the two). */
export const STRUCTURE_NORMAL_ROUGHNESS_GAIN = 0.5;

/** One array's upload: the plan without its per-layer chains (the packed levels hold the same bytes). */
export type StructureTextureLevels = Pick<MippedTextureArrayPlan, "edge" | "layerCount" | "mipLevelCount" | "packedLevels" | "totalBytes">;

export interface StructureTexturePlans {
  readonly edge: StructureTextureEdge;
  readonly detail: StructureTextureLevels;
  readonly normal: StructureTextureLevels;
}

function levels(plan: MippedTextureArrayPlan): StructureTextureLevels {
  return {
    edge: plan.edge,
    layerCount: plan.layerCount,
    mipLevelCount: plan.mipLevelCount,
    packedLevels: plan.packedLevels,
    totalBytes: plan.totalBytes,
  };
}

/** Both arrays at `edge`, mipped and packed for upload. */
export function structureTexturePlans(edge: StructureTextureEdge): StructureTexturePlans {
  const set = synthesizeStructureTextures(edge);
  return {
    edge,
    detail: levels(planMippedTextureArray(set.detail, edge, "box")),
    normal: levels(planMippedTextureArray(set.normal, edge, { kind: "toksvig", roughnessGain: STRUCTURE_NORMAL_ROUGHNESS_GAIN })),
  };
}

/** Every level's buffer, for the transfer list. */
export function structureTextureTransfer(plans: StructureTexturePlans, into: Transferable[] = []): Transferable[] {
  for (const level of [...plans.detail.packedLevels, ...plans.normal.packedLevels]) {
    if (!into.includes(level.buffer)) into.push(level.buffer);
  }
  return into;
}

/** How many layers each array has. */
export const STRUCTURE_TEXTURE_LAYER_COUNT = STRUCTURE_TEXTURE_LAYERS.length;

/**
 * The flat texel of each array, a placeholder the textured material samples
 * until the arrays are in: detail mid-grey painted (the part's colour, to
 * 0.4%), normal flat with the material's own roughness and no cavity.
 */
export function structurePlaceholderTexel(array: "detail" | "normal", baseRoughness: number): readonly [number, number, number, number] {
  return array === "detail" ? [128, 128, 128, 255] : [128, 128, Math.round(baseRoughness * 255), 255];
}
