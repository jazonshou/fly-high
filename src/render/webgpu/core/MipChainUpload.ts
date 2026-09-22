import { Constants } from "@babylonjs/core/Engines/constants";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * UPLOADING A HAND-BUILT MIP CHAIN, and why Babylon must never record its own.
 *
 * Every hand-built chain in this renderer (the aircraft and airfield paint,
 * the 747 livery, the terrain, foliage and impostor arrays) exists because
 * Babylon's box filter is the wrong downsample for it: normals renormalised,
 * roughness Toksvig-corrected, alpha coverage preserved. They were all
 * uploaded the same way -- construct with `generateMipMaps = true` and an
 * explicit level count, then `updateMipLevel(level)` for levels 1..N-1 --
 * and on WebGPU that ordering LOSES. Constructing uploads level 0 and records
 * Babylon's level-0 mip blit into the frame's upload encoder; the
 * `updateMipLevel` writes go straight to the queue; the encoder is submitted
 * at frame end, so the blit lands LAST and every hand-built level is replaced
 * by Babylon's box-filtered one (FI-5, measured by readback: all aircraft
 * paint maps and the airfield metal's normal and metallic-roughness were
 * overwritten; texture arrays on layer 0 only, the blit's hardcoded face 0).
 *
 * The fix is to never let Babylon record the blit, in an order the WebGPU
 * engine forces. The GPU texture's levels are ALLOCATED only if
 * `generateMipMaps` is true when it is created -- an explicit level count
 * does not allocate them (`createGPUTextureForInternalTexture`; constructing
 * with the flag off and a count of N gave a one-level texture, and the
 * adapter refused `updateMipLevel(1)`). The blit is RECORDED only by an
 * upload of level 0 while the flag is true (`updateRawTexture`:
 * `if (texture.generateMipMaps && !mipLevel)`). So: construct with the flag
 * on and NO data, which allocates the chain and uploads nothing; take the
 * chain over (`takeOverMipChain`: the flag off, the sampler told to read the
 * levels); then upload level 0 and the rest.
 *
 * THE SECOND TRAP is in "told to read the levels": `InternalTexture.useMipMaps`
 * falls back to `generateMipMaps` when it has not been set, and the WebGPU
 * sampler cache builds a sampler with no mip filtering when it is false. With
 * the flag off and `useMipMaps` unset, the chain is intact and never read --
 * every surface would sample level 0 at any distance.
 */

/**
 * Take a freshly allocated, still-empty texture's mip chain away from
 * Babylon: no blit on any later upload, and the sampler reads the levels.
 * Call it after constructing with generation on and no data, before any
 * upload. See the file comment.
 */
export function takeOverMipChain(texture: BaseTexture): void {
  const internal = texture.getInternalTexture();
  if (!internal) throw new Error(`"${texture.name}" has no internal texture to take its mip chain over`);
  internal.generateMipMaps = false;
  internal.useMipMaps = true;
}

export interface MipChainTextureOptions {
  /** Upload into an sRGB buffer: true for albedo, false for data maps. */
  readonly useSrgbBuffer: boolean;
  /** Babylon sampling mode; trilinear by default so the chain is read. */
  readonly samplingMode?: number;
}

/**
 * A 2D RGBA8 `RawTexture` holding exactly `levels`, level 0 first, each half
 * the size of the one before (clamped at 1). The caller names it and sets its
 * wrap and anisotropy; nothing here decides those.
 */
export function createRawTextureFromMipChain(
  scene: Scene,
  levels: readonly ArrayBufferView[],
  width: number,
  height: number,
  options: MipChainTextureOptions,
): RawTexture {
  if (levels.length === 0) throw new RangeError("A mip chain needs at least level 0");
  for (let level = 0; level < levels.length; level += 1) {
    const expected = Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
    if (levels[level]!.byteLength !== expected) {
      throw new RangeError(`mip level ${level} is ${levels[level]!.byteLength} bytes, expected ${expected}`);
    }
  }
  // Generation ON and NO data: the chain is allocated and nothing is uploaded.
  const texture = new RawTexture(
    null,
    width,
    height,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    0,
    options.useSrgbBuffer,
    false,
    levels.length,
  );
  try {
    takeOverMipChain(texture);
    for (let level = 0; level < levels.length; level += 1) {
      texture.updateMipLevel(levels[level]!, level);
    }
    return texture;
  } catch (error) {
    // The texture is allocated; ownership never reaches the caller, so
    // release it here before rethrowing.
    texture.dispose();
    throw error;
  }
}
