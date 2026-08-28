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

// The plan is the expensive shared fixture (all layers synthesized, dilated,
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

  it("keeps bark opaque while card layers retain non-trivial cutout coverage", () => {
    for (const layerName of FOLIAGE_LAYER_NAMES) {
      const base = atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]![0]!;
      const coverage = alphaCoverage(base, FOLIAGE_ALPHA_TEST_THRESHOLD);
      if (layerName.startsWith("bark") || layerName.endsWith("Dense")) {
        expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBe(1);
        continue;
      }
      expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBeGreaterThan(0.05);
      expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBeLessThan(0.95);
    }
  });

  it("keeps live-tree bark continuous around each repeated ring at every mip", () => {
    for (const seed of [ATLAS_SEED, "bark-wrap-regression-seed"] as const) {
      for (const layerName of ["barkConifer", "barkBroadleaf", "barkBirch"] as const) {
        // Opaque bark's production coverage kernel reduces identically to a
        // box chain. Reuse the full-plan fixture for its seed and exercise a
        // second seed without rebuilding unrelated card layers.
        const chain = seed === ATLAS_SEED
          ? atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]!
          : buildMipChain(synthesizeFoliageLayer(layerName, seed), FOLIAGE_ATLAS_EDGE, "box");
        for (let level = 0; level < chain.length - 1; level += 1) {
          const rgba = chain[level]!;
          const edge = FOLIAGE_ATLAS_EDGE >> level;
          const edgeDifference = (
            axis: "horizontal" | "vertical",
            firstCoordinate: number,
            secondCoordinate: number,
          ): number => {
            let total = 0;
            for (let across = 0; across < edge; across += 1) {
              const first = axis === "vertical"
                ? (firstCoordinate * edge + across) * 4
                : (across * edge + firstCoordinate) * 4;
              const second = axis === "vertical"
                ? (secondCoordinate * edge + across) * 4
                : (across * edge + secondCoordinate) * 4;
              for (let channel = 0; channel < 3; channel += 1) {
                total += Math.abs(rgba[first + channel]! - rgba[second + channel]!);
              }
            }
            return total / (edge * 3);
          };
          for (const axis of ["horizontal", "vertical"] as const) {
            const internal = Array.from(
              { length: edge - 1 },
              (_, coordinate) => edgeDifference(axis, coordinate, coordinate + 1),
            ).sort((a, b) => a - b);
            const internalP95 = internal[Math.ceil(internal.length * 0.95) - 1]!;
            const wrapDifference = edgeDifference(axis, edge - 1, 0);
            // Mip 0's opposing texels meet exactly. Repeated byte-rounded box
            // reduction can introduce a two-byte drift at the smallest levels,
            // but the wrap must never be materially stronger than ordinary
            // bark variation within that same image.
            if (level === 0) {
              expect(
                wrapDifference,
                `${seed}/${layerName} ${axis} base wrap`,
              ).toBe(0);
            } else {
              expect(
                wrapDifference,
                `${seed}/${layerName} ${axis} mip ${level} wrap ${wrapDifference.toFixed(3)} vs internal p95 ${internalP95.toFixed(3)}`,
              ).toBeLessThanOrEqual(internalP95 + 2);
            }
          }
        }
      }
    }
  });

  it("keeps dense near-crown layers opaque with restrained fine-scale texture", () => {
    const denseLayers = FOLIAGE_LAYER_NAMES.filter((name) => name.endsWith("Dense"));
    expect(denseLayers).toHaveLength(2);
    for (const layerName of denseLayers) {
      const rgba = atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]![0]!;
      let minimum = 255;
      let maximum = 0;
      let alphaMinimum = 255;
      for (let at = 0; at < rgba.length; at += 4) {
        const luminance = rgba[at]! * 0.2126 + rgba[at + 1]! * 0.7152 + rgba[at + 2]! * 0.0722;
        minimum = Math.min(minimum, luminance);
        maximum = Math.max(maximum, luminance);
        alphaMinimum = Math.min(alphaMinimum, rgba[at + 3]!);
      }
      expect(alphaMinimum, `${layerName} alpha`).toBe(255);
      expect(maximum - minimum, `${layerName} tonal texture`).toBeGreaterThan(20);
      // Prevent a future broad high-contrast colour field from recreating
      // the user's near-tree "splotches" under a different implementation.
      expect(maximum - minimum, `${layerName} tonal restraint`).toBeLessThan(90);
    }
  });

  it("gives tree crown card layers card-scale coverage (2-12)", () => {
    // A crown card's texture IS the tree's visual mass: at 10% coverage the
    // 2-12 capture read as bare terrain with speckle while paying full GPU
    // cost (the needle layers were authored as close-up sprigs with no
    // consumer to judge them against). 0.05 "non-trivial" stays right for
    // ground-cover sprigs; the five tree crown layers need card scale.
    // 2-12b: the three shrub layers joined when card shrubs became their
    // first consumer (juniper sprays and sage leaves were re-authored to
    // card density in the same change).
    const crownLayers: readonly (keyof typeof FOLIAGE_LAYERS)[] = [
      "broadleafOak",
      "broadleafMaple",
      "broadleafBirch",
      "needlePine",
      "needleSpruce",
      "hazelLeaf",
      "juniperScale",
      "sageLeaf",
    ];
    for (const layerName of crownLayers) {
      const base = atlasPlan.layerChains[FOLIAGE_LAYERS[layerName]]![0]!;
      const coverage = alphaCoverage(base, FOLIAGE_ALPHA_TEST_THRESHOLD);
      expect(coverage, `${layerName} coverage ${coverage.toFixed(4)}`).toBeGreaterThan(0.3);
    }
  });
});
