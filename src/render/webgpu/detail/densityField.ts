import { clamp, fbm2D, saturate, smoothstep, valueNoise2D } from "@/src/world/noise";
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
   * §1.6 threading rule: part of this signature from the moment the field
   * was first written. Canopy stem positions are deliberately
   * season-invariant — trees must not pop with the calendar — so today the
   * clock drives nothing; the seasonal ground-cover density arriving with
   * 2-16/2-18 consumes it here.
   */
  readonly dayOfYear: number;
}

export interface VegetationDensitySample {
  /** Canopy stems per square metre (0.03–0.08 in closed forest). */
  readonly treeStemsPerSquareMeter: number;
  readonly shrubStemsPerSquareMeter: number;
  /** 1 in closed forest, tapering to krummholz (~0.12) at the treeline. */
  readonly heightFactor: number;
  /** −1 cool north face … +1 warm south face; shifts the conifer share. */
  readonly aspect: number;
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
});

export function densityField(
  seedHash: number,
  input: VegetationDensityInput,
): VegetationDensitySample {
  const elevation = input.heightMeters - input.seaLevelMeters;
  // Continuous shoreline: underwater and wave-washed sand carry nothing.
  const shoreline = smoothstep(1.5, 7, elevation);
  if (shoreline <= 0) return ZERO_DENSITY;

  // Aspect from the horizontal normal: equator-facing (south, −z at 45°N)
  // slopes are warm. Flat ground has no aspect, faded in with steepness.
  const normalX = input.normalX ?? 0;
  const normalZ = input.normalZ ?? 0;
  const horizontal = Math.hypot(normalX, normalZ);
  const aspectStrength = smoothstep(0.015, 0.07, input.slope);
  const aspect = horizontal > 1e-6 ? (-normalZ / horizontal) * aspectStrength : 0;

  // The ragged treeline: base + aspect + shelter + a 2.4 km wander. Trees do
  // not stop at a contour line; they thin, shrink, and give up unevenly.
  const shelter = valueNoise2D(mixSeed(seedHash, 72), input.x / 560, input.z / 560);
  const treelineWander = fbm2D(mixSeed(seedHash, 71), input.x / 2_400, input.z / 2_400, 2, 2, 0.5);
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

  // Multiplicative glade and disturbance fields: openings without centres.
  const glade = 0.3 + 0.7 * smoothstep(
    -0.38,
    0.14,
    fbm2D(mixSeed(seedHash, 73), input.x / 260, input.z / 260, 2, 2, 0.5),
  );
  const disturbance = 1 - 0.85 * smoothstep(
    0.34,
    0.5,
    fbm2D(mixSeed(seedHash, 74), input.x / 1_400, input.z / 1_400, 2, 2, 0.5),
  );
  // Airfields are mown grass (1B-6): woody stems fade multiplicatively.
  const clearance = 1 - clamp(input.airportInfluence ?? 0, 0, 1);

  const habitat =
    shoreline * slopeFactor * lapse * treelineFactor * aspectFactor * glade * disturbance
    * clearance;
  const treeStems = BASE_TREE_STEMS * moistureFactor * habitat;

  // Shrubs tolerate drier and steeper ground, prefer open glades and edges,
  // and persist a little above the canopy treeline.
  const shrubMoisture = smoothstep(0.2, 0.5, input.moisture);
  const shrubSlope = 1 - smoothstep(0.09, 0.26, input.slope);
  const shrubTreeline = 1 - smoothstep(treeline - 80, treeline + 140, elevation);
  const openness = 0.45 + 0.55 * (1 - glade * 0.7);
  const shrubStems =
    BASE_SHRUB_STEMS * shrubMoisture * shrubSlope * shrubTreeline * openness * shoreline
    * disturbance * clearance;

  return {
    treeStemsPerSquareMeter: saturate(treeStems),
    shrubStemsPerSquareMeter: saturate(shrubStems),
    heightFactor,
    aspect,
  };
}
