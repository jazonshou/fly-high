import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { takeOverMipChain } from "./MipChainUpload";
import type { MipKernel, MippedTextureArrayPlan } from "./TextureArrayMipPlan";
import { planMippedTextureArray } from "./TextureArrayMipPlan";

export {
  alphaCoverage,
  alphaDilate,
  buildMipChain,
  planMippedTextureArray,
  toksvigReduce,
  type MipKernel,
  type MippedTextureArrayPlan,
} from "./TextureArrayMipPlan";

/**
 * 2-11's GPU boundary for CPU-mipped array textures; the reduction itself
 * (kernels, chains, the packed plan) is in `TextureArrayMipPlan.ts`.
 */

export interface MippedTextureArrayOptions {
  readonly kernel: MipKernel;
  readonly name?: string;
  /** Babylon sampling mode; trilinear by default so the chain is read. */
  readonly samplingMode?: number;
}

/**
 * GPU boundary: construct the `RawTexture2DArray` and upload a plan's
 * levels, without Babylon's own mip generation.
 *
 * This used to construct with generation ON and rely on the order of the
 * calls: the constructor's level-0 upload triggers Babylon's blit for LAYER 0
 * ONLY (the hardcoded `faceIndex = 0` above), and the `updateMipLevel` calls
 * after it were meant to overwrite that layer's blitted levels with the CPU
 * chain. The order is the other way round on WebGPU. The blit is recorded
 * into the frame's upload encoder and submitted at frame end, AFTER the
 * `updateMipLevel` writes, so layer 0 kept Babylon's box-filtered levels:
 * the Toksvig roughness lost on terrain layer 0, and the pine impostor's
 * alpha coverage gone by level 5 (FI-5, measured by readback on the
 * production arrays; layers 1+ were always right). `MipChainUpload.ts` has
 * the mechanism, the order the engine forces (allocate with generation on
 * and no data, then take the chain over), and the second trap -- a texture
 * without generation must still be told to SAMPLE its levels.
 */
export function uploadMippedTextureArrayPlan(
  scene: Scene,
  plan: Pick<MippedTextureArrayPlan, "edge" | "layerCount" | "mipLevelCount" | "packedLevels">,
  options?: Pick<MippedTextureArrayOptions, "name" | "samplingMode">,
): RawTexture2DArray {
  // Generation ON and NO data: every layer's chain is allocated and nothing
  // is uploaded, so no blit is recorded (see `MipChainUpload.ts`).
  const texture = new RawTexture2DArray(
    null,
    plan.edge,
    plan.edge,
    plan.layerCount,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    options?.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    undefined,
    plan.mipLevelCount,
  );
  try {
    takeOverMipChain(texture);
    if (options?.name !== undefined) texture.name = options.name;
    for (let level = 0; level < plan.mipLevelCount; level += 1) {
      texture.updateMipLevel(plan.packedLevels[level]!, level);
    }
    return texture;
  } catch (error) {
    // The constructor has already allocated and uploaded mip 0. If a later
    // level fails, ownership never reaches the caller, so this boundary must
    // release the partial texture before preserving the upload failure.
    texture.dispose();
    throw error;
  }
}

/**
 * Convenience path: reduce `layers` through the kernel and upload the
 * result so EVERY layer carries the full mip chain.
 */
export function createMippedTextureArray(
  scene: Scene,
  layers: readonly Uint8Array[],
  edge: number,
  options: MippedTextureArrayOptions,
): RawTexture2DArray {
  const plan = planMippedTextureArray(layers, edge, options.kernel);
  return uploadMippedTextureArrayPlan(scene, plan, options);
}
