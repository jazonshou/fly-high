import { FOLIAGE_LAYERS } from "./FoliageAtlas";
import type { TreeSpecies } from "./types";

/**
 * The four silhouettes retained by the 60-fps vegetation path. Species
 * still keep their generated height, crown/trunk radius, tint, lean and wind;
 * this only selects a shared mesh prototype so a presentation chunk submits
 * one batch set per family instead of eight species times several variants.
 * The palm is its own family (nothing else shares a frond crown) and grows
 * only on tropical coasts, where no pine or willow grows (see
 * `TREE_SPECIES_COHORTS`), so it adds draws only where it stands and a chunk
 * still submits at most three families.
 */
const TREE_PROTOTYPE_FAMILY: Readonly<Record<TreeSpecies, TreeSpecies>> = Object.freeze({
  pine: "pine",
  cedar: "pine",
  spruce: "pine",
  oak: "oak",
  maple: "oak",
  birch: "oak",
  willow: "willow",
  palm: "palm",
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
 * The species that can grow side by side. The temperate world grows the
 * first seven; the tropical coast (`src/world/tropicalCoast.ts`) grows the
 * palm with oak, maple and birch, and the belt between the two grows
 * broadleaf alone, so a stand never holds a palm and a conifer or willow at
 * once. A presentation chunk therefore submits the families of ONE cohort,
 * three at most (pine, oak, willow), and the draw model prices the larger
 * cohort rather than every species the renderer knows. Where a band's disk
 * straddles that belt it can still see both cohorts in one chunk; the draw
 * test prices that case and measures how much of the world it covers.
 */
export const TREE_SPECIES_COHORTS: readonly (readonly TreeSpecies[])[] = Object.freeze([
  Object.freeze<TreeSpecies[]>(["pine", "cedar", "spruce", "oak", "maple", "birch", "willow"]),
  Object.freeze<TreeSpecies[]>(["oak", "maple", "birch", "palm"]),
]);

/**
 * Bark is a surface identity, not a mesh identity. Balanced rendering may
 * draw birch with the shared oak trunk geometry, but it must still sample
 * white birch bark. The selector rides the trunk instance tint's alpha lane:
 * opaque bark never consumes seasonal leaf alpha, so all three bark families
 * remain available without another batch or draw call.
 *
 * The palm is the exception that proves the rule: its family is one species,
 * so its trunk geometry names `barkPalm` directly. That layer sits outside
 * the selector span (the decode only remaps 5..7), and its tint alpha is a
 * full leaf fraction so the card path never dissolves it.
 */
const TREE_BARK_LAYER: Readonly<Record<TreeSpecies, number>> = Object.freeze({
  pine: FOLIAGE_LAYERS.barkConifer,
  cedar: FOLIAGE_LAYERS.barkConifer,
  spruce: FOLIAGE_LAYERS.barkConifer,
  oak: FOLIAGE_LAYERS.barkBroadleaf,
  maple: FOLIAGE_LAYERS.barkBroadleaf,
  birch: FOLIAGE_LAYERS.barkBirch,
  willow: FOLIAGE_LAYERS.barkBroadleaf,
  palm: FOLIAGE_LAYERS.barkPalm,
});

export const TREE_BARK_LAYER_MIN = FOLIAGE_LAYERS.barkConifer;
export const TREE_BARK_LAYER_MAX = FOLIAGE_LAYERS.barkBirch;
export const TREE_BARK_LAYER_SPAN = TREE_BARK_LAYER_MAX - TREE_BARK_LAYER_MIN;

export function treeBarkAtlasLayer(species: TreeSpecies): number {
  return TREE_BARK_LAYER[species];
}

/** Whether a species' bark rides the trunk tint's alpha selector. */
export function treeBarkUsesSelector(species: TreeSpecies): boolean {
  const layer = treeBarkAtlasLayer(species);
  return layer >= TREE_BARK_LAYER_MIN && layer <= TREE_BARK_LAYER_MAX;
}

export function treeBarkLayerSelector(species: TreeSpecies): number {
  if (!treeBarkUsesSelector(species)) {
    throw new RangeError(`${species} bark is not in the selector span`);
  }
  return (treeBarkAtlasLayer(species) - TREE_BARK_LAYER_MIN) / TREE_BARK_LAYER_SPAN;
}

/** Neutral RGB leaves the authored bark atlas/material in charge of colour. */
export function treeTrunkTint(
  species: TreeSpecies,
): readonly [number, number, number, number] {
  return [1, 1, 1, treeBarkUsesSelector(species) ? treeBarkLayerSelector(species) : 1];
}
