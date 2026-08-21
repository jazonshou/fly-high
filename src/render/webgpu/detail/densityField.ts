import {
  clamp,
  fbm2D,
  filteredValueNoise2D,
  saturate,
  smoothstep,
} from "@/src/world/noise";
import { mixSeed } from "@/src/world/seed";

/**
 * The vegetation density field (1B-7) — the single owner of where plants
 * grow. One continuous function, never a switch: clumping expressed as a
 * field has no centre and no radius, therefore nothing circular to see.
 * Terrain-material *reads* this in Phase 6; nothing reimplements it
 * (architecture manifest, boundary-tested).
 *
 * Class P and WGSL-portable by the same rules as the terrain kernel: pure
 * arithmetic over world coordinates, the shared noise lattice, and a uint32
 * seed.
 */

export interface VegetationDensityInput {
  readonly x: number;
  readonly z: number;
  readonly heightMeters: number;
  readonly seaLevelMeters: number;
  /** Normalized steepness (1 − normalY): 0 flat, ~0.21 at the 38° angle of repose. */
  readonly slope: number;
  readonly moisture: number;
  /** Horizontal normal components for the aspect term; omitted reads flat. */
  readonly normalX?: number;
  readonly normalZ?: number;
  /** 0 outside the airport blend, 1 on the graded platform (1B-6). */
  readonly airportInfluence?: number;
  /**
   * `5-13`: signed metres to the nearest exported wetted edge. Values <= 0
   * are water; positive values are dry land. Omitted means hydrology has not
   * provisioned this point and is a neutral factor.
   */
  readonly shoreDistanceMeters?: number;
  /**
   * §1.6 threading rule: part of this signature from the moment the field
   * was first written. Canopy stem positions are deliberately
   * season-invariant — trees must not pop with the calendar — so today the
   * clock drives nothing; the seasonal ground-cover density arriving with
   * 2-16/2-18 consumes it here.
   */
  readonly dayOfYear: number;
  /**
   * `4-6b` (D12): the half-width of the sampling footprint, under the `0-4`
   * convention — the same parameter the terrain kernel has carried since
   * Phase 0.
   *
   * **This field exists because point-sampling this field was the same defect
   * `1B-2` fixed for height, one system over.** The glade channel has a 260 m
   * lattice; sampled onto a level-5 page whose texels are 128 m apart it
   * re-rolls an arbitrary phase per level, and the symptom is canopy cover
   * that CHANGES when a page changes LOD. Collision and per-stem placement
   * keep 0 (the full-bandwidth field) forever; only a page bake passes a
   * width.
   */
  readonly filterWidthMeters: number;
}

export interface VegetationDensitySample {
  /** Canopy stems per square metre (0.03–0.08 in closed forest). */
  readonly treeStemsPerSquareMeter: number;
  readonly shrubStemsPerSquareMeter: number;
  /** 1 in closed forest, tapering to krummholz (~0.12) at the treeline. */
  readonly heightFactor: number;
  /** −1 cool north face … +1 warm south face; shifts the conifer share. */
  readonly aspect: number;
  /**
   * 0 in stand interiors, approaching 1 through the forest-edge margin.
   * Generation uses this to make edge stems shorter and bushier without
   * changing the climatic species/stand decision.
   */
  readonly forestEdge: number;
  /**
   * `4-6b`: ground-cover archetype weights — grass / fern / heather / reed /
   * clutter — summing to 1.
   *
   * `2-16` rolled a flat 15% for ground cover, so a wet hollow and a
   * wind-scoured ridge read as the same ground at different densities. These
   * come from terms the field ALREADY carries (moisture, slope, shade,
   * exposure), so it costs no new noise: what was missing was not information
   * but a place to put it.
   */
  readonly groundCover: GroundCoverWeights;
}

/** The five ground-cover archetypes, in the order the weight vector uses. */
export const GROUND_COVER_ARCHETYPES = [
  "grass",
  "fern",
  "heather",
  "reed",
  "clutter",
] as const;

export type GroundCoverArchetype = (typeof GROUND_COVER_ARCHETYPES)[number];

export type GroundCoverWeights = Readonly<Record<GroundCoverArchetype, number>>;

const OPEN_GRASSLAND_COVER: GroundCoverWeights = Object.freeze({
  grass: 1, fern: 0, heather: 0, reed: 0, clutter: 0,
});

/**
 * Archetype mix from the drivers the density field already has.
 *
 * Ferns need shade and moisture, heather takes the dry exposed ridge, reeds
 * want wet flat ground near the water table, and clutter (fallen wood, stones)
 * follows slope and disturbance. Normalised, so it is a mix rather than five
 * independent probabilities.
 */
export function groundCoverWeights(
  moisture: number,
  slope: number,
  canopyShade: number,
  elevationAboveSeaLevel: number,
): GroundCoverWeights {
  const wet = smoothstep(0.42, 0.78, moisture);
  const dry = 1 - smoothstep(0.24, 0.55, moisture);
  const flat = 1 - smoothstep(0.04, 0.18, slope);
  const steep = smoothstep(0.12, 0.42, slope);
  const shade = saturate(canopyShade);
  const lowland = 1 - smoothstep(180, 700, elevationAboveSeaLevel);
  const raw = {
    grass: 0.35 + flat * 0.4 * (1 - shade),
    fern: shade * (0.25 + wet * 0.75),
    heather: dry * (0.2 + steep * 0.5) * (1 - lowland * 0.4),
    reed: wet * flat * lowland * 0.9,
    clutter: steep * 0.35 + shade * 0.2,
  };
  const total = raw.grass + raw.fern + raw.heather + raw.reed + raw.clutter;
  if (!(total > 0)) return OPEN_GRASSLAND_COVER;
  return Object.freeze({
    grass: raw.grass / total,
    fern: raw.fern / total,
    heather: raw.heather / total,
    reed: raw.reed / total,
    clutter: raw.clutter / total,
  });
}

/** Base canopy density: ~800 stems/ha before habitat factors. */
const BASE_TREE_STEMS = 0.08;
const BASE_SHRUB_STEMS = 0.045;
/** Treeline base above sea level; the ragged offsets ride on top. */
const TREELINE_BASE_METERS = 1_350;

const ZERO_DENSITY: VegetationDensitySample = Object.freeze({
  treeStemsPerSquareMeter: 0,
  shrubStemsPerSquareMeter: 0,
  heightFactor: 1,
  aspect: 0,
  forestEdge: 0,
  groundCover: OPEN_GRASSLAND_COVER,
});

interface ForestPatternSample {
  readonly glade: number;
  readonly disturbance: number;
  readonly forestFraction: number;
  readonly forestEdge: number;
}

export interface RiparianVegetationFactors {
  readonly clearance: number;
  readonly treeDensityGain: number;
  readonly shrubDensityGain: number;
}

const NEUTRAL_RIPARIAN_FACTORS: RiparianVegetationFactors = Object.freeze({
  clearance: 1,
  treeDensityGain: 1,
  shrubDensityGain: 1,
});

/**
 * One multiplicative channel exclusion. It adds no placement lattice: the
 * shape comes entirely from the authoritative shore-distance export.
 */
export function riparianVegetationFactors(
  shoreDistanceMeters: number | undefined,
): RiparianVegetationFactors {
  if (shoreDistanceMeters === undefined) return NEUTRAL_RIPARIAN_FACTORS;
  if (!Number.isFinite(shoreDistanceMeters)) {
    throw new RangeError("shore distance must be finite when supplied");
  }
  if (shoreDistanceMeters <= 0) {
    return { clearance: 0, treeDensityGain: 1, shrubDensityGain: 1 };
  }
  const clearance = smoothstep(0, 2, shoreDistanceMeters);
  const bankBand = smoothstep(1.5, 6, shoreDistanceMeters)
    * (1 - smoothstep(28, 50, shoreDistanceMeters));
  return {
    clearance,
    treeDensityGain: 1 + bankBand * 0.2,
    shrubDensityGain: 1 + bankBand * 0.65,
  };
}

/** Multi-kilometre canopy gate: 0 is meadow, 1 is closed-forest province. */
export function forestFraction(
  seedHash: number,
  x: number,
  z: number,
  moisture: number,
  filterWidthMeters = 0,
): number {
  const provinceRaw = fbm2D(
    mixSeed(seedHash, 75),
    (x + z * 0.21) / 7_200,
    (z - x * 0.21) / 5_400,
    3,
    2,
    0.5,
    // The SMALLER period of an anisotropic channel keys its fade, exactly as
    // the terrain kernel's fracture channels do.
    5_400,
    filterWidthMeters,
  );
  return smoothstep(-0.22, 0.2, provinceRaw + (moisture - 0.55) * 0.7);
}

/**
 * Gate B's authored forest pattern. This stays in the density owner so no
 * renderer, material, or future classifier can grow a second answer to
 * "where is forest?".
 *
 * Three scales have deliberately different jobs:
 * - a multi-kilometre province gate makes meadow valleys and unbroken forest;
 * - a sharpened 260 m glade field can fall below the rendered-stem cap;
 * - disturbances include both a soft succession field and a rare hard edge.
 */
function sampleForestPattern(
  seedHash: number,
  x: number,
  z: number,
  moisture: number,
  filterWidthMeters: number,
): ForestPatternSample {
  // Moist climates are more likely to carry forest, but never force every
  // valley closed. The smooth gate is wide enough to form a real ecotone.
  const province = forestFraction(seedHash, x, z, moisture, filterWidthMeters);

  const gladeRaw = fbm2D(mixSeed(seedHash, 73), x / 260, z / 260, 2, 2, 0.5, 260, filterWidthMeters);
  // The previous 0.30 floor authored at least 240 stems/ha in a nominal
  // 800-stem stand, still far above the ~78/ha rendered cap. A 0.02 floor
  // lets a clearing actually expose ground after rendered-share thinning.
  const glade = 0.02 + 0.98 * smoothstep(-0.24, 0.02, gladeRaw);

  const successionRaw = fbm2D(
    mixSeed(seedHash, 74),
    x / 1_400,
    z / 1_400,
    2,
    2,
    0.5,
    1_400,
    filterWidthMeters,
  );
  // Full amplitude: the disturbed end reaches zero rather than retaining a
  // permanent 15% canopy floor.
  const succession = 1 - smoothstep(0.3, 0.48, successionRaw);

  // One genuinely hard-edged class (windthrow): an elongated, low-frequency
  // field is thresholded rather than eased. Real burns/cuts/windthrow do not
  // all dissolve through the same procedural softness.
  const windthrowRaw = filteredValueNoise2D(
    mixSeed(seedHash, 76),
    (x + z * 0.46) / 3_600,
    (z - x * 0.46) / 1_700,
    1_700,
    filterWidthMeters,
  );
  const windthrow = windthrowRaw > 0.61 ? 0 : 1;
  const disturbance = succession * windthrow;

  // Edge margins are keyed to the transition bands themselves, not a second
  // placement noise. The hard-edge term is intentionally narrow.
  const provinceEdge = 1 - smoothstep(0.05, 0.22, Math.abs(province - 0.5));
  const gladeEdge = 1 - smoothstep(0.025, 0.14, Math.abs(gladeRaw + 0.11));
  const windthrowEdge = 1 - smoothstep(0.008, 0.045, Math.abs(windthrowRaw - 0.61));
  const forestEdge = saturate(Math.max(provinceEdge, gladeEdge * 0.7, windthrowEdge));

  return { glade, disturbance, forestFraction: province, forestEdge };
}

export function densityField(
  seedHash: number,
  input: VegetationDensityInput,
): VegetationDensitySample {
  const elevation = input.heightMeters - input.seaLevelMeters;
  // Continuous shoreline: underwater and wave-washed sand carry nothing.
  const shoreline = smoothstep(1.5, 7, elevation);
  if (shoreline <= 0) return ZERO_DENSITY;
  const riparian = riparianVegetationFactors(input.shoreDistanceMeters);
  if (riparian.clearance <= 0) return ZERO_DENSITY;

  // Aspect from the horizontal normal: equator-facing (south, −z at 45°N)
  // slopes are warm. Flat ground has no aspect, faded in with steepness.
  const normalX = input.normalX ?? 0;
  const normalZ = input.normalZ ?? 0;
  const horizontal = Math.hypot(normalX, normalZ);
  const aspectStrength = smoothstep(0.015, 0.07, input.slope);
  const aspect = horizontal > 1e-6 ? (-normalZ / horizontal) * aspectStrength : 0;

  // The ragged treeline: base + aspect + shelter + a 2.4 km wander. Trees do
  // not stop at a contour line; they thin, shrink, and give up unevenly.
  const shelter = filteredValueNoise2D(
    mixSeed(seedHash, 72), input.x / 560, input.z / 560, 560, input.filterWidthMeters,
  );
  const treelineWander = fbm2D(
    mixSeed(seedHash, 71), input.x / 2_400, input.z / 2_400, 2, 2, 0.5,
    2_400, input.filterWidthMeters,
  );
  const treeline = TREELINE_BASE_METERS + aspect * 120 + shelter * 80 + treelineWander * 90;
  const treelineFactor = 1 - smoothstep(treeline - 220, treeline + 40, elevation);
  // Height taper begins below the density taper: trees become 2 m krummholz
  // before they disappear.
  const heightFactor = clamp(
    1 - smoothstep(treeline - 320, treeline - 30, elevation) * 0.88,
    0.12,
    1,
  );

  // Moisture is the closed-forest gate (sharpened so wet forest carries an
  // order of magnitude more stems than dry grassland), slope is a
  // soil-retention proxy falling to zero by ~38°, and the lapse term thins
  // growth with altitude below the treeline.
  const moistureFactor = Math.pow(smoothstep(0.3, 0.62, input.moisture), 1.6);
  const slopeFactor = 1 - smoothstep(0.05, 0.212, input.slope);
  const lapse = 1 - smoothstep(500, Math.max(501, treeline), elevation) * 0.45;
  const aspectFactor = 1 - aspect * 0.25;

  const forest = sampleForestPattern(
    seedHash,
    input.x,
    input.z,
    input.moisture,
    input.filterWidthMeters,
  );
  // Airfields are mown grass (1B-6): woody stems fade multiplicatively.
  const clearance = 1 - clamp(input.airportInfluence ?? 0, 0, 1);

  const habitat =
    shoreline * slopeFactor * lapse * treelineFactor * aspectFactor
    * forest.glade * forest.disturbance * forest.forestFraction * clearance
    * riparian.clearance * riparian.treeDensityGain;
  const treeStems = BASE_TREE_STEMS * moistureFactor * habitat;

  // Shrubs tolerate drier and steeper ground, prefer open glades and edges,
  // and persist a little above the canopy treeline.
  const shrubMoisture = smoothstep(0.2, 0.5, input.moisture);
  const shrubSlope = 1 - smoothstep(0.09, 0.26, input.slope);
  const shrubTreeline = 1 - smoothstep(treeline - 80, treeline + 140, elevation);
  const openness = 0.45 + 0.55 * (1 - forest.glade * 0.7);
  const shrubForestGate = 0.28 + forest.forestFraction * 0.72;
  const edgeShrubGain = 1 + forest.forestEdge * 0.45;
  const shrubStems =
    BASE_SHRUB_STEMS * shrubMoisture * shrubSlope * shrubTreeline * openness * shoreline
    * forest.disturbance * shrubForestGate * edgeShrubGain * clearance
    * riparian.clearance * riparian.shrubDensityGain;

  return {
    treeStemsPerSquareMeter: saturate(treeStems),
    shrubStemsPerSquareMeter: saturate(shrubStems),
    // Edge stems trade height for lateral mass in generation. Keeping the
    // scalar here makes the margin a property of the density authority.
    heightFactor: heightFactor * (1 - forest.forestEdge * 0.34),
    aspect,
    forestEdge: forest.forestEdge,
    groundCover: groundCoverWeights(
      input.moisture,
      input.slope,
      // Canopy closure IS the shade term: the field already knows how much
      // canopy stands here, so shade needs no field of its own.
      saturate(treeStems / BASE_TREE_STEMS),
      elevation,
    ),
  };
}
