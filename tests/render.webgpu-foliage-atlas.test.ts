import { describe, expect, it } from "vitest";
import {
  alphaCoverage,
  alphaDilate,
  buildMipChain,
} from "../src/render/webgpu/core/TextureArrayMips";
import {
  FOLIAGE_ALPHA_TEST_THRESHOLD,
  FOLIAGE_ATLAS_EDGE,
  FOLIAGE_LAYER_COUNT,
  FOLIAGE_LAYER_NAMES,
  FOLIAGE_LAYERS,
  planFoliageAtlas,
  synthesizeFoliageLayer,
} from "../src/render/webgpu/detail/FoliageAtlas";

/**
 * 2-11 — foliage atlas + CPU array-mip reduction (assertions 45 and 45b).
 * Everything here runs on the pure half of the pipeline: the synthesized
 * layers and the upload plan `createFoliageAtlas` hands to Babylon, because
 * `RawTexture2DArray` cannot be constructed under NullEngine (its WebGL
 * raw-texture extension dereferences `this._gl`).
 */

const ATLAS_SEED = "foliage-atlas-test-seed";

// The plan is the expensive shared fixture (16 layers synthesized, dilated,
// and reduced through the coverage kernel); build it once for the file.
const atlasPlan = planFoliageAtlas(ATLAS_SEED);

describe("WebGPU foliage atlas and array mips", () => {
  it("assertion 45: every layer holds mip coverage at the alpha-test threshold", () => {
    for (const layerName of FOLIAGE_LAYER_NAMES) {
      const chain = atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]!;
      const baseCoverage = alphaCoverage(chain[0]!, FOLIAGE_ALPHA_TEST_THRESHOLD);
      for (let level = 1; level < chain.length; level += 1) {
        const levelEdge = FOLIAGE_ATLAS_EDGE >> level;
        const texels = levelEdge * levelEdge;
        // Coverage is quantized to multiples of 1/texels, so the 3-point
        // budget is physically unreachable once a level has few texels: a
        // 4×4 level can only express steps of 6.25%, and a 1×1 level only 0%
        // or 100%. Levels of 16×16 (256 texels) and larger must meet the
        // plan's 3-point assertion outright; smaller levels get their
        // quantization added to the budget (two texel quanta: texels sharing
        // a filtered alpha byte flip across the threshold together, so the
        // reachable step nearest the target can straddle it by more than
        // one).
        const tolerance = 0.03 + (texels < 256 ? 2 / texels : 0);
        const coverage = alphaCoverage(chain[level]!, FOLIAGE_ALPHA_TEST_THRESHOLD);
        const error = Math.abs(coverage - baseCoverage);
        expect(
          error,
          `${layerName} level ${level}: coverage ${coverage.toFixed(4)} vs base ${baseCoverage.toFixed(4)}`,
        ).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it("assertion 45b: buildMipChain returns the full chain and the atlas plans one per layer", () => {
    // Synthetic 64² gradient-with-hole image exercises the chain shape.
    const edge = 64;
    const image = new Uint8Array(edge * edge * 4);
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const at = (y * edge + x) * 4;
        image[at] = x * 4;
        image[at + 1] = y * 4;
        image[at + 2] = 128;
        image[at + 3] = (x + y) % 5 === 0 ? 0 : 255;
      }
    }
    const chain = buildMipChain(image, edge, "box");
    expect(chain.length).toBe(Math.log2(edge) + 1);
    for (let level = 0; level < chain.length; level += 1) {
      const levelEdge = edge >> level;
      expect(chain[level]!.length).toBe(levelEdge * levelEdge * 4);
    }
    expect(chain[chain.length - 1]!.length).toBe(4);

    // The foliage plan carries one complete chain for EVERY layer — the
    // exact structure createFoliageAtlas uploads level by level, which is
    // what works around Babylon mipping only layer 0 of an array texture.
    expect(atlasPlan.layerCount).toBe(FOLIAGE_LAYER_COUNT);
    expect(atlasPlan.mipLevelCount).toBe(Math.log2(FOLIAGE_ATLAS_EDGE) + 1);
    expect(atlasPlan.layerChains.length).toBe(FOLIAGE_LAYER_COUNT);
    for (const layerChain of atlasPlan.layerChains) {
      expect(layerChain.length).toBe(atlasPlan.mipLevelCount);
      for (let level = 0; level < layerChain.length; level += 1) {
        const levelEdge = FOLIAGE_ATLAS_EDGE >> level;
        expect(layerChain[level]!.length).toBe(levelEdge * levelEdge * 4);
      }
    }
    // Packed upload buffers are layer-major concatenations of the chains.
    expect(atlasPlan.packedLevels.length).toBe(atlasPlan.mipLevelCount);
    for (let level = 0; level < atlasPlan.mipLevelCount; level += 1) {
      const levelEdge = FOLIAGE_ATLAS_EDGE >> level;
      const bytesPerLayer = levelEdge * levelEdge * 4;
      expect(atlasPlan.packedLevels[level]!.length).toBe(bytesPerLayer * FOLIAGE_LAYER_COUNT);
    }
    const probeLayer = FOLIAGE_LAYERS.needlePine;
    const probeLevel = 3;
    const probeEdge = FOLIAGE_ATLAS_EDGE >> probeLevel;
    const probeBytes = probeEdge * probeEdge * 4;
    expect(
      Array.from(
        atlasPlan.packedLevels[probeLevel]!.subarray(
          probeLayer * probeBytes,
          (probeLayer + 1) * probeBytes,
        ),
      ),
    ).toEqual(Array.from(atlasPlan.layerChains[probeLayer]![probeLevel]!));
  });

  it("dilation pushes colour into transparent texels bordering opaque ones", () => {
    // Synthetic: a red block in a transparent field.
    const edge = 16;
    const image = new Uint8Array(edge * edge * 4);
    for (let y = 6; y <= 9; y += 1) {
      for (let x = 6; x <= 9; x += 1) {
        const at = (y * edge + x) * 4;
        image[at] = 200;
        image[at + 1] = 30;
        image[at + 2] = 40;
        image[at + 3] = 255;
      }
    }
    const dilated = alphaDilate(image, edge, 2);
    // Original untouched; alpha never modified.
    expect(image[(5 * edge + 6) * 4]).toBe(0);
    const ringAt = (5 * edge + 6) * 4;
    expect(dilated[ringAt]).toBeGreaterThan(0);
    expect(dilated[ringAt + 3]).toBe(0);
    // Two passes reach two texels out; the far corner stays black.
    expect(dilated[(4 * edge + 6) * 4]).toBeGreaterThan(0);
    expect(dilated[0]).toBe(0);

    // Real layer: every transparent texel with an opaque 8-neighbour must
    // carry non-black RGB, or box filtering pulls leaf edges toward black.
    const layer = synthesizeFoliageLayer("broadleafOak", ATLAS_SEED);
    const atlasEdge = FOLIAGE_ATLAS_EDGE;
    let checked = 0;
    for (let y = 1; y < atlasEdge - 1; y += 1) {
      for (let x = 1; x < atlasEdge - 1; x += 1) {
        const at = (y * atlasEdge + x) * 4;
        if (layer[at + 3]! >= 40) continue;
        let hasOpaqueNeighbour = false;
        for (let dy = -1; dy <= 1 && !hasOpaqueNeighbour; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (layer[((y + dy) * atlasEdge + x + dx) * 4 + 3]! >= 128) {
              hasOpaqueNeighbour = true;
              break;
            }
          }
        }
        if (!hasOpaqueNeighbour) continue;
        checked += 1;
        expect(
          layer[at]! + layer[at + 1]! + layer[at + 2]!,
          `transparent texel (${x}, ${y}) bordering opaque foliage is black`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("synthesizes deterministically per seed and diverges across seeds", () => {
    const first = synthesizeFoliageLayer("fernFrond", "determinism-seed-a");
    const repeated = synthesizeFoliageLayer("fernFrond", "determinism-seed-a");
    expect(repeated).toEqual(first);

    const otherSeed = synthesizeFoliageLayer("fernFrond", "determinism-seed-b");
    expect(otherSeed).not.toEqual(first);

    const otherLayer = synthesizeFoliageLayer("heather", "determinism-seed-a");
    expect(otherLayer).not.toEqual(first);
  });

  it("gives every layer non-trivial mip-0 coverage", () => {
    for (const layerName of FOLIAGE_LAYER_NAMES) {
      const base = atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]![0]!;
      const coverage = alphaCoverage(base, FOLIAGE_ALPHA_TEST_THRESHOLD);
      expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBeGreaterThan(0.05);
      expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBeLessThan(0.95);
    }
  });
});
