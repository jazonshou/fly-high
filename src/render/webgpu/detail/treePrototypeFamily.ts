import { FOLIAGE_LAYERS } from "./FoliageAtlas";
import type { TreeSpecies } from "./types";

/**
 * The three silhouettes retained by the 60-fps vegetation path. Species
 * still keep their generated height, crown/trunk radius, tint, lean and wind;
 * this only selects a shared mesh prototype so a presentation chunk submits
 * three tree families instead of seven species times several variants.
 */
const TREE_PROTOTYPE_FAMILY: Readonly<Record<TreeSpecies, TreeSpecies>> = Object.freeze({
  pine: "pine",
  cedar: "pine",
  spruce: "pine",
  oak: "oak",
  maple: "oak",
  birch: "oak",
  willow: "willow",
});

export function treePrototypeSpecies(
  species: TreeSpecies,
  mode: "families" | "species",
): TreeSpecies {
  return mode === "families" ? TREE_PROTOTYPE_FAMILY[species] : species;
}

export const TREE_PROTOTYPE_FAMILY_COUNT = new Set(
  Object.values(TREE_PROTOTYPE_FAMILY),
).size;

/**
 * Bark is a surface identity, not a mesh identity. Balanced rendering may
 * draw birch with the shared oak trunk geometry, but it must still sample
 * white birch bark. The selector rides the trunk instance tint's alpha lane:
 * opaque bark never consumes seasonal leaf alpha, so all three bark families
 * remain available without another batch or draw call.
 */
const TREE_BARK_LAYER: Readonly<Record<TreeSpecies, number>> = Object.freeze({
  pine: FOLIAGE_LAYERS.barkConifer,
  cedar: FOLIAGE_LAYERS.barkConifer,
  spruce: FOLIAGE_LAYERS.barkConifer,
  oak: FOLIAGE_LAYERS.barkBroadleaf,
  maple: FOLIAGE_LAYERS.barkBroadleaf,
  birch: FOLIAGE_LAYERS.barkBirch,
  willow: FOLIAGE_LAYERS.barkBroadleaf,
});

export const TREE_BARK_LAYER_MIN = FOLIAGE_LAYERS.barkConifer;
export const TREE_BARK_LAYER_MAX = FOLIAGE_LAYERS.barkBirch;
export const TREE_BARK_LAYER_SPAN = TREE_BARK_LAYER_MAX - TREE_BARK_LAYER_MIN;

export function treeBarkAtlasLayer(species: TreeSpecies): number {
  return TREE_BARK_LAYER[species];
}

export function treeBarkLayerSelector(species: TreeSpecies): number {
  return (treeBarkAtlasLayer(species) - TREE_BARK_LAYER_MIN) / TREE_BARK_LAYER_SPAN;
}

/** Neutral RGB leaves the authored bark atlas/material in charge of colour. */
export function treeTrunkTint(
  species: TreeSpecies,
): readonly [number, number, number, number] {
  return [1, 1, 1, treeBarkLayerSelector(species)];
}
