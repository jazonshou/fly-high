import { describe, expect, it } from "vitest";
import {
  TREE_BARK_LAYER_MIN,
  TREE_BARK_LAYER_SPAN,
  TREE_PROTOTYPE_FAMILY_COUNT,
  treeBarkAtlasLayer,
  treeBarkLayerSelector,
  treeBarkUsesSelector,
  treePrototypeSpecies,
  treeTrunkTint,
} from "../src/render/webgpu/detail/treePrototypeFamily";
import { FOLIAGE_LAYERS } from "../src/render/webgpu/detail/FoliageAtlas";
import type { TreeSpecies } from "../src/render/webgpu/detail/types";

const SPECIES: readonly TreeSpecies[] = [
  "pine", "cedar", "spruce", "oak", "maple", "birch", "willow", "palm",
];

describe("tree prototype families", () => {
  it("collapses tier-1 geometry to four coherent silhouettes", () => {
    expect(new Set(SPECIES.map((species) => treePrototypeSpecies(species, "families"))).size)
      .toBe(TREE_PROTOTYPE_FAMILY_COUNT);
    expect(TREE_PROTOTYPE_FAMILY_COUNT).toBe(4);
    expect(treePrototypeSpecies("cedar", "families")).toBe("pine");
    expect(treePrototypeSpecies("birch", "families")).toBe("oak");
    expect(treePrototypeSpecies("willow", "families")).toBe("willow");
    expect(treePrototypeSpecies("palm", "families")).toBe("palm");
  });

  it("preserves every authored species at high quality", () => {
    for (const species of SPECIES) {
      expect(treePrototypeSpecies(species, "species")).toBe(species);
    }
  });

  it("keeps species bark identity in the trunk alpha selector", () => {
    expect(treeBarkAtlasLayer("pine")).toBe(FOLIAGE_LAYERS.barkConifer);
    expect(treeBarkAtlasLayer("cedar")).toBe(FOLIAGE_LAYERS.barkConifer);
    expect(treeBarkAtlasLayer("oak")).toBe(FOLIAGE_LAYERS.barkBroadleaf);
    expect(treeBarkAtlasLayer("willow")).toBe(FOLIAGE_LAYERS.barkBroadleaf);
    expect(treeBarkAtlasLayer("birch")).toBe(FOLIAGE_LAYERS.barkBirch);
    expect(treeBarkLayerSelector("pine")).toBe(0);
    expect(treeBarkLayerSelector("oak")).toBe(0.5);
    expect(treeBarkLayerSelector("birch")).toBe(1);

    // The palm names its own bark outside the span: the decode leaves it
    // alone, and its alpha is a full leaf fraction the card path never sheds.
    expect(treeBarkAtlasLayer("palm")).toBe(FOLIAGE_LAYERS.barkPalm);
    expect(treeBarkUsesSelector("palm")).toBe(false);
    expect(treeBarkAtlasLayer("palm")).toBeGreaterThan(TREE_BARK_LAYER_MIN + TREE_BARK_LAYER_SPAN);
    expect(treeTrunkTint("palm")).toEqual([1, 1, 1, 1]);
    expect(() => treeBarkLayerSelector("palm")).toThrow(RangeError);

    for (const species of SPECIES.filter(treeBarkUsesSelector)) {
      const tint = treeTrunkTint(species);
      expect(tint.slice(0, 3), species).toEqual([1, 1, 1]);
      // Mirror the unorm8 attribute and WGSL round-to-three-layers decode.
      const quantized = Math.round(tint[3] * 255) / 255;
      const decoded = TREE_BARK_LAYER_MIN
        + Math.floor(quantized * TREE_BARK_LAYER_SPAN + 0.5);
      expect(decoded, species).toBe(treeBarkAtlasLayer(species));
    }
  });
});
