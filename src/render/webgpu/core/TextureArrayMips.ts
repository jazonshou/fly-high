import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * 2-11 — CPU array-mip reduction (owner: performance; reused by 3-1's
 * Toksvig terrain-material reducer).
 *
 * INVARIANT THIS FILE OWNS: every layer of every `Texture2DArray` this
 * renderer samples through mips carries a full CPU-computed mip chain.
 * Babylon 9.21.2 mips only layer 0 of an array texture — verified, not
 * suspected: `Engines/WebGPU/webgpuTextureManager.js:716` signs
 * `generateMipmaps(gpuOrHdwTexture, mipLevelCount, faceIndex = 0)` and
 * `Engines/thinWebGPUEngine.js:90/:93` call it with the `0` hardcoded, so
 * layers 1..N-1 of an array texture never receive blitted mips. Array-mip
 * reduction therefore happens here, per layer per level, and is uploaded
 * with `RawTexture2DArray.updateMipLevel(data, level)` — which expects one
 * tightly packed, layer-major buffer covering EVERY layer of that level
 * (`Engines/Extensions/engine.rawTexture.pure.js:296-324`).
 *
 * Class P everywhere except `uploadMippedTextureArrayPlan`, the single GPU
 * boundary: kernels and the upload plan are pure and Node-tested; the
 * Babylon texture construction is isolated because `NullEngine` cannot
 * express a TEXTURE_2D_ARRAY upload (its WebGL raw-texture extension
 * dereferences `this._gl`).
 */

/**
 * Reduction kernel for one mip step.
 *
 * - `"box"` — plain 2×2 average of all four channels.
 * - `coverage` — Castano coverage preservation: box-filter RGB and alpha,
 *   then rescale each level's alpha so the fraction of texels passing
 *   `alphaTestThreshold` (normalized, 0..1; a texel passes when
 *   `alpha / 255 >= threshold`, so 0.5 keeps the byte threshold at 128)
 *   matches mip 0's fraction. Without it alpha-tested foliage evaporates
 *   with distance.
 */
export type MipKernel =
  | "box"
  | { readonly kind: "coverage"; readonly alphaTestThreshold: number };

/** Below this alpha a texel is transparent for dilation purposes. */
const DILATE_TRANSPARENT_BELOW_ALPHA = 40;

/** Default flood passes: covers the transparent spans mipping reads across. */
const DEFAULT_DILATION_PASSES = 8;

const RGBA_CHANNELS = 4;

function requireSquareRgba(rgba: Uint8Array, edge: number, label: string): void {
  if (!Number.isInteger(edge) || edge < 1) {
    throw new RangeError(`${label}: edge must be a positive integer, got ${edge}`);
  }
  const expected = edge * edge * RGBA_CHANNELS;
  if (rgba.length !== expected) {
    throw new RangeError(
      `${label}: expected ${expected} bytes for a ${edge}×${edge} RGBA image, got ${rgba.length}`,
    );
  }
}

function requirePowerOfTwo(edge: number, label: string): void {
  if ((edge & (edge - 1)) !== 0) {
    throw new RangeError(`${label}: edge must be a power of two, got ${edge}`);
  }
}

/** Fraction of texels whose alpha passes the (normalized) alpha test. */
export function alphaCoverage(rgba: Uint8Array, alphaTestThreshold: number): number {
  const thresholdByte = alphaTestThreshold * 255;
  const texels = rgba.length / RGBA_CHANNELS;
  let passing = 0;
  for (let index = 3; index < rgba.length; index += RGBA_CHANNELS) {
    if (rgba[index]! >= thresholdByte) passing += 1;
  }
  return texels > 0 ? passing / texels : 0;
}

/** 2×2 box reduction of one RGBA level; `srcEdge` must be even. */
function boxReduce(src: Uint8Array, srcEdge: number): Uint8Array {
  const dstEdge = srcEdge >> 1;
  const dst = new Uint8Array(dstEdge * dstEdge * RGBA_CHANNELS);
  for (let y = 0; y < dstEdge; y += 1) {
    const rowA = 2 * y * srcEdge;
    const rowB = rowA + srcEdge;
    for (let x = 0; x < dstEdge; x += 1) {
      const a = (rowA + 2 * x) * RGBA_CHANNELS;
      const b = a + RGBA_CHANNELS;
      const c = (rowB + 2 * x) * RGBA_CHANNELS;
      const d = c + RGBA_CHANNELS;
      const out = (y * dstEdge + x) * RGBA_CHANNELS;
      for (let channel = 0; channel < RGBA_CHANNELS; channel += 1) {
        dst[out + channel] = Math.round(
          (src[a + channel]! + src[b + channel]! + src[c + channel]! + src[d + channel]!) / 4,
        );
      }
    }
  }
  return dst;
}

/** Coverage after scaling every alpha byte, using the output quantization. */
function scaledAlphaCoverage(
  rgba: Uint8Array,
  alphaTestThreshold: number,
  scale: number,
): number {
  const thresholdByte = alphaTestThreshold * 255;
  const texels = rgba.length / RGBA_CHANNELS;
  let passing = 0;
  for (let index = 3; index < rgba.length; index += RGBA_CHANNELS) {
    if (Math.min(255, Math.round(rgba[index]! * scale)) >= thresholdByte) passing += 1;
  }
  return texels > 0 ? passing / texels : 0;
}

/**
 * Castano's coverage-preserving alpha scale, found by binary search over
 * [0.5, 4]. Coverage is a monotone non-decreasing STEP function of the
 * scale (each texel flips from fail to pass at exactly one scale value), so
 * bisection cannot equate coverage with the target exactly — it converges
 * onto the step boundary nearest the target instead. Sixteen iterations
 * narrow the bracket to (4 − 0.5) / 2^16 ≈ 5e-5, far below one alpha
 * quantum. Because the final midpoint may land on the worse side of a
 * step, every evaluated candidate (including the identity scale 1) is
 * tracked and the one with the smallest coverage error is returned, so the
 * search never does worse than the best point it actually visited.
 */
function solveCoverageAlphaScale(
  rgba: Uint8Array,
  alphaTestThreshold: number,
  targetCoverage: number,
): number {
  let bestScale = 1;
  let bestError = Math.abs(scaledAlphaCoverage(rgba, alphaTestThreshold, 1) - targetCoverage);
  let low = 0.5;
  let high = 4;
  for (let iteration = 0; iteration < 16 && bestError > 0; iteration += 1) {
    const mid = (low + high) / 2;
    const coverage = scaledAlphaCoverage(rgba, alphaTestThreshold, mid);
    const error = Math.abs(coverage - targetCoverage);
    if (error < bestError) {
      bestError = error;
      bestScale = mid;
    }
    if (coverage < targetCoverage) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return bestScale;
}

/** Copy `level` with every alpha byte scaled and clamped to [0, 255]. */
function withScaledAlpha(level: Uint8Array, scale: number): Uint8Array {
  const out = new Uint8Array(level);
  for (let index = 3; index < out.length; index += RGBA_CHANNELS) {
    out[index] = Math.min(255, Math.round(out[index]! * scale));
  }
  return out;
}

/**
 * Full mip chain for one square RGBA image, level 0 (a copy of the input)
 * down to 1×1 — `log2(edge) + 1` levels.
 *
 * The coverage kernel filters each level from the UNSCALED previous level
 * and rescales only the emitted copy: compounding scales through the
 * reduction would drift coverage across levels, which is the exact failure
 * the kernel exists to prevent.
 */
export function buildMipChain(
  rgba: Uint8Array,
  edge: number,
  kernel: MipKernel,
): Uint8Array[] {
  requireSquareRgba(rgba, edge, "buildMipChain");
  requirePowerOfTwo(edge, "buildMipChain");

  const preserveCoverage = kernel !== "box";
  const threshold = preserveCoverage ? kernel.alphaTestThreshold : 0;
  if (preserveCoverage && (threshold < 0 || threshold > 1)) {
    throw new RangeError(
      `buildMipChain: alphaTestThreshold must be normalized to [0, 1], got ${threshold}`,
    );
  }
  const targetCoverage = preserveCoverage ? alphaCoverage(rgba, threshold) : 0;

  const levels: Uint8Array[] = [new Uint8Array(rgba)];
  let filtered = rgba;
  for (let levelEdge = edge; levelEdge > 1; levelEdge >>= 1) {
    filtered = boxReduce(filtered, levelEdge);
    if (preserveCoverage) {
      const scale = solveCoverageAlphaScale(filtered, threshold, targetCoverage);
      levels.push(withScaledAlpha(filtered, scale));
    } else {
      levels.push(filtered);
    }
  }
  return levels;
}

/**
 * Push RGB colour outward from opaque texels (alpha ≥ 40) into transparent
 * ones so box filtering never blends leaf edges toward the border colour —
 * without this every alpha-tested leaf grows a dark halo at range.
 *
 * Iterative 8-neighbour flood: each pass, every still-uncoloured
 * transparent texel adjacent to at least one coloured texel takes the mean
 * RGB of those neighbours. Colours written during a pass only become
 * sources in the next pass (the source mask is snapshotted), so the result
 * is independent of texel visit order. Alpha is never modified. The default
 * pass count covers the widest transparent span the mip reduction reads
 * across for the atlas layer sizes in use.
 */
export function alphaDilate(
  rgba: Uint8Array,
  edge: number,
  passes: number = DEFAULT_DILATION_PASSES,
): Uint8Array {
  requireSquareRgba(rgba, edge, "alphaDilate");
  if (!Number.isInteger(passes) || passes < 0) {
    throw new RangeError(`alphaDilate: passes must be a non-negative integer, got ${passes}`);
  }

  const out = new Uint8Array(rgba);
  const colored = new Uint8Array(edge * edge);
  for (let texel = 0; texel < colored.length; texel += 1) {
    if (out[texel * RGBA_CHANNELS + 3]! >= DILATE_TRANSPARENT_BELOW_ALPHA) colored[texel] = 1;
  }

  const newlyColored: number[] = [];
  for (let pass = 0; pass < passes; pass += 1) {
    newlyColored.length = 0;
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const texel = y * edge + x;
        if (colored[texel] === 1) continue;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let neighbours = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= edge) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= edge) continue;
            const neighbour = ny * edge + nx;
            if (colored[neighbour] !== 1) continue;
            const at = neighbour * RGBA_CHANNELS;
            sumR += out[at]!;
            sumG += out[at + 1]!;
            sumB += out[at + 2]!;
            neighbours += 1;
          }
        }
        if (neighbours === 0) continue;
        const at = texel * RGBA_CHANNELS;
        out[at] = Math.round(sumR / neighbours);
        out[at + 1] = Math.round(sumG / neighbours);
        out[at + 2] = Math.round(sumB / neighbours);
        newlyColored.push(texel);
      }
    }
    if (newlyColored.length === 0) break;
    for (const texel of newlyColored) colored[texel] = 1;
  }
  return out;
}

/** Pure description of a fully mipped array-texture upload. */
export interface MippedTextureArrayPlan {
  readonly edge: number;
  readonly layerCount: number;
  /** `log2(edge) + 1` — the full chain down to 1×1. */
  readonly mipLevelCount: number;
  /** `layerChains[layer][level]` — one complete chain per layer. */
  readonly layerChains: readonly (readonly Uint8Array[])[];
  /**
   * `packedLevels[level]` — every layer's texels for that level in one
   * tightly packed layer-major buffer, exactly the shape
   * `RawTexture2DArray.updateMipLevel` uploads in a single call.
   */
  readonly packedLevels: readonly Uint8Array[];
  /** Total bytes across every layer of every level. */
  readonly totalBytes: number;
}

/**
 * Reduce every layer through the kernel and pack each level for upload.
 * Pure — this is the half of `createMippedTextureArray` that Node tests
 * exercise without a GPU.
 */
export function planMippedTextureArray(
  layers: readonly Uint8Array[],
  edge: number,
  kernel: MipKernel,
): MippedTextureArrayPlan {
  if (layers.length === 0) {
    throw new RangeError("planMippedTextureArray: at least one layer is required");
  }
  requirePowerOfTwo(edge, "planMippedTextureArray");

  const layerChains = layers.map((layer, index) => {
    requireSquareRgba(layer, edge, `planMippedTextureArray layer ${index}`);
    return buildMipChain(layer, edge, kernel);
  });

  const mipLevelCount = layerChains[0]!.length;
  const packedLevels: Uint8Array[] = [];
  let totalBytes = 0;
  for (let level = 0; level < mipLevelCount; level += 1) {
    const levelEdge = edge >> level;
    const bytesPerLayer = levelEdge * levelEdge * RGBA_CHANNELS;
    const packed = new Uint8Array(bytesPerLayer * layers.length);
    for (let layer = 0; layer < layerChains.length; layer += 1) {
      packed.set(layerChains[layer]![level]!, layer * bytesPerLayer);
    }
    packedLevels.push(packed);
    totalBytes += packed.length;
  }

  return { edge, layerCount: layers.length, mipLevelCount, layerChains, packedLevels, totalBytes };
}

export interface MippedTextureArrayOptions {
  readonly kernel: MipKernel;
  readonly name?: string;
  /** Babylon sampling mode; trilinear by default so the chain is read. */
  readonly samplingMode?: number;
}

/**
 * GPU boundary: construct the `RawTexture2DArray` and upload a plan's
 * levels. Upload order is load-bearing: the constructor uploads level 0,
 * which retriggers Babylon's built-in mip blit for LAYER 0 ONLY (the
 * hardcoded `faceIndex = 0` this file exists to work around); the
 * `updateMipLevel(_, level > 0)` calls that follow skip that retrigger
 * (`engine.rawTexture.pure.js:319-321`) and overwrite every layer of every
 * level — layer 0's blitted mips included — with the CPU chain. Re-running
 * `update()`/`updateMipLevel(_, 0)` later would re-blit layer 0's mips;
 * re-upload levels 1..N-1 afterwards or do not touch level 0.
 */
export function uploadMippedTextureArrayPlan(
  scene: Scene,
  plan: MippedTextureArrayPlan,
  options?: Pick<MippedTextureArrayOptions, "name" | "samplingMode">,
): RawTexture2DArray {
  const texture = new RawTexture2DArray(
    plan.packedLevels[0]!,
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
  if (options?.name !== undefined) texture.name = options.name;
  for (let level = 1; level < plan.mipLevelCount; level += 1) {
    texture.updateMipLevel(plan.packedLevels[level]!, level);
  }
  return texture;
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
