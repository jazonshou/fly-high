import { smoothstep } from "./noise";

/**
 * The tropical coast biome: where a climate province is HOT and NOT DRY.
 *
 * One weight, 0..1, read from the province's raw offsets
 * (`sampleClimateProvince`), and every tropical rule scales with it: the tree
 * species (palms, an evergreen broadleaf forest, no conifers or willow), the
 * wider sand beaches, and the clear water off them. The weight is EXACTLY 0
 * wherever `temperatureOffset <= temperatureStart`, which includes the whole
 * temperate core (offset 0) and the warm plateau (+0.12), so every consumer
 * stays `x + 0 * k` there.
 *
 * The temperature gate spans the warm-to-hot ecotone (the hot plateau is
 * +0.28). The dryness gate keeps ordinary (0) and wet (-0.15) provinces and
 * hands semi-arid (+0.25) and arid (+0.5) ones to the dry biomes: a hot, dry
 * province is a savanna or a desert, not a palm coast.
 *
 * Class K: pure arithmetic over numbers, with a WGSL twin below for the
 * land-cover bake.
 */
export const TROPICAL_COAST = Object.freeze({
  temperatureStart: 0.14,
  temperatureFull: 0.26,
  drynessStart: 0.04,
  drynessEnd: 0.2,
  /**
   * Tree cohorts. Conifers and willow fade out by `broadleafOnlyWeight`, and
   * palms only begin at `palmWeight`, so between the two lies a belt of
   * broadleaf alone. A palm and a pine therefore never stand within a
   * kilometre or so of each other, which is what keeps a presentation chunk's
   * tree families at three (pine, oak, willow in the temperate world; oak and
   * palm in the tropics) instead of four. See `TREE_SPECIES_COHORTS`.
   */
  broadleafOnlyWeight: 0.3,
  palmWeight: 0.7,
  /**
   * Metres the beach band's top edge rises at full weight, 3 m to 8 m: sand
   * dominates to ~3.5 m instead of ~1 m and fades out by ~5 m, a tropical
   * beach ridge, so the palms behind it stand on sand.
   */
  beachExtraMeters: 5,
  /**
   * Share of the catchment's runoff the coastal water does NOT carry at full
   * weight. A reef-and-lagoon coast is fed by short streams and its reef
   * traps what they bring, so the water is clear over a pale carbonate bed:
   * the turquoise this biome is named for. A delta coast is a different
   * biome.
   */
  lagoonRunoffCut: 0.8,
});

/** The tropical weight at a point, from the province's raw offsets. */
export function tropicalCoastWeight(temperatureOffset: number, dryness: number): number {
  if (!(temperatureOffset > TROPICAL_COAST.temperatureStart)) return 0;
  return smoothstep(
    TROPICAL_COAST.temperatureStart,
    TROPICAL_COAST.temperatureFull,
    temperatureOffset,
  ) * (1 - smoothstep(TROPICAL_COAST.drynessStart, TROPICAL_COAST.drynessEnd, dryness));
}

/**
 * The WGSL twin, for the land-cover bake. Needs `kSmoothstep` (the bake's
 * scalar include). Exactly 0.0 at and below `temperatureStart`, because
 * smoothstep's lower tail is 0.0 there.
 */
export const TROPICAL_COAST_WGSL = /* wgsl */ `
fn tropicalCoastWeight(temperatureOffset: f32, dryness: f32) -> f32 {
  return kSmoothstep(${TROPICAL_COAST.temperatureStart.toFixed(2)}, ${TROPICAL_COAST.temperatureFull.toFixed(2)}, temperatureOffset)
    * (1.0 - kSmoothstep(${TROPICAL_COAST.drynessStart.toFixed(2)}, ${TROPICAL_COAST.drynessEnd.toFixed(2)}, dryness));
}
`;
