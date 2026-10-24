import { climateProvinceCoreCenter } from "./climateProvince";
import {
  applyDuneStage,
  duneClimateFactors,
  duneErgWeight,
  duneRelief,
  sampleDuneField,
  type DuneClimateFactors,
  type DuneSample,
} from "./dunes";
import { smoothstep } from "./noise";
import { sampleNaturalTerrainIntermediates, type NaturalTerrainIntermediates } from "./terrain";
import type { WorldDefinition } from "./types";

/**
 * Landforms: the height stages that run AFTER the natural kernel.
 *
 * The natural kernel (`sampleNaturalTerrainHeight`, WGSL `terrainNaturalHeight`)
 * stays exactly what it is: the start-airport search reads it, so nothing here
 * can move where the airport goes. Landforms that only exist in some places —
 * sand seas, volcanic fields — are stages applied to its result, in a fixed
 * order, before the airport earthworks:
 *
 *   natural -> dunes -> volcanic overlay -> earthworks
 *
 * CONTAINMENT. Each stage computes its own weight and returns the height it
 * was given, untouched, wherever that weight is zero (the M-1 pattern: never
 * `height + 0 * k`, which is not bit-identical for -0 and is one more thing to
 * reason about). The whole stage returns before any stage runs inside the
 * landform core, so everything there is the shipped arithmetic bit for bit.
 *
 * THE LANDFORM CORE IS WIDER THAN THE CLIMATE CORE. Colour only reaches as far
 * as the camera sees (every perf baseline sits within ~25 km of the airport and
 * the far plane is 45 km, so the 70 km climate core keeps them all), but height
 * reaches further: the occlusion bake marches 45 km past every visible texel
 * through the 131 km height pyramid, so a height change within ~115-120 km of
 * the airport can move a baked horizon bit. Landforms therefore start at
 * 120 km and reach full strength by 150 km. A world that FORCES landforms
 * (screenshots, a chosen start) keeps only a small clearance round the runway.
 *
 * Class K: pure arithmetic over numbers, transliterated to WGSL in
 * `TerrainLandformKernel.ts` (`terrainLandforms`).
 */

/**
 * Landforms a world can force everywhere outside the runway clearance
 * (screenshots, a chosen start). Both may be on: a volcanic desert.
 */
export interface LandformsOption {
  /** Sand seas on all low, unforested-relief ground. */
  dunes?: boolean;
  /** Volcanic fields (owned by `volcanism.ts`). */
  volcanic?: boolean;
}

export type ForcedLandforms = Readonly<Required<LandformsOption>>;

export const LANDFORM_CORE = Object.freeze({
  /** No landform moves any height within this distance of the start airport. */
  innerRadiusMeters: 120_000,
  /** Distance past the inner radius over which faded landforms reach full strength. */
  rampMeters: 30_000,
  /** A forced world's clearance round the start airport. */
  forcedClearanceMeters: 5_000,
  forcedClearanceRampMeters: 3_000,
});

/** Validate a world's forced landforms. Null (nothing forced) keeps the natural ones. */
export function resolveLandformsOption(option: LandformsOption | undefined): ForcedLandforms | null {
  if (option === undefined) return null;
  for (const [key, value] of Object.entries(option)) {
    if (key !== "dunes" && key !== "volcanic") {
      throw new RangeError(`landforms has no landform named ${key}`);
    }
    if (value !== undefined && typeof value !== "boolean") {
      throw new RangeError(`landforms.${key} must be a boolean`);
    }
  }
  const dunes = option.dunes === true;
  const volcanic = option.volcanic === true;
  if (!dunes && !volcanic) return null;
  return Object.freeze({ dunes, volcanic });
}

/** The centre of the landform core: the start airport, or the origin without one. */
export function landformCoreCenter(
  world: Pick<WorldDefinition, "airport">,
): { readonly x: number; readonly z: number } {
  return climateProvinceCoreCenter(world);
}

/** The inner and outer radius of a world's core: natural, or a forced world's clearance. */
export function landformCoreRadii(
  world: Pick<WorldDefinition, "landforms">,
): { readonly inner: number; readonly outer: number } {
  if (world.landforms) {
    return {
      inner: LANDFORM_CORE.forcedClearanceMeters,
      outer: LANDFORM_CORE.forcedClearanceMeters + LANDFORM_CORE.forcedClearanceRampMeters,
    };
  }
  return {
    inner: LANDFORM_CORE.innerRadiusMeters,
    outer: LANDFORM_CORE.innerRadiusMeters + LANDFORM_CORE.rampMeters,
  };
}

/**
 * 0 inside the landform core, exactly; 1 from the outer radius out. Runs on
 * every CPU height sample (physics included), so it allocates nothing.
 */
export function landformCoreMask(
  world: Pick<WorldDefinition, "airport" | "landforms">,
  x: number,
  z: number,
): number {
  const airport = world.airport;
  const dx = airport ? x - airport.centerX : x;
  const dz = airport ? z - airport.centerZ : z;
  const inner = world.landforms ? LANDFORM_CORE.forcedClearanceMeters : LANDFORM_CORE.innerRadiusMeters;
  const ramp = world.landforms ? LANDFORM_CORE.forcedClearanceRampMeters : LANDFORM_CORE.rampMeters;
  return smoothstep(inner, inner + ramp, Math.hypot(dx, dz));
}

/**
 * The volcanic field's activity at a point, in [0, 1]. A stub until the
 * volcanic overlay lands (it owns this function and its WGSL twin,
 * `terrainVolcanicActivity`): sand seas are multiplied by `1 - activity`, so
 * the two landforms never stack.
 */
export function volcanicActivity(world: WorldDefinition, x: number, z: number): number {
  void world;
  void x;
  void z;
  return 0;
}

/**
 * Every landform stage, applied to a natural height. `natural` carries the
 * natural kernel's intermediates for THIS point (the kernel fills them on the
 * call that produced `naturalHeight`), so no stage evaluates the kernel twice.
 */
export function applyTerrainLandforms(
  world: WorldDefinition,
  x: number,
  z: number,
  naturalHeight: number,
  filterWidthMeters: number,
  natural: Readonly<NaturalTerrainIntermediates>,
): number {
  // The eroded world's GPU path has no landform stage (it is shelved); keep
  // its collision on the same surface.
  if (world.worldEvolution === "eroded") return naturalHeight;
  const coreMask = landformCoreMask(world, x, z);
  if (coreMask <= 0) return naturalHeight;
  return applyDuneStage(
    world, x, z, naturalHeight, filterWidthMeters, coreMask, natural, volcanicActivity);
}

/**
 * The ground cover the landforms leave at a point, for readers that classify
 * or plant the ground rather than draw it: sand cover and the erg weight. All
 * zero inside the landform core (and in eroded worlds). Evaluates the natural
 * kernel once, outside the core only.
 */
export function sampleLandformCover(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  target: DuneSample = { ergWeight: 0, duneHeight: 0, sandCover: 0 },
): DuneSample {
  return landformCover(world, x, z, filterWidthMeters, null, target);
}

/**
 * The same cover for a caller that has just sampled the world height at THIS
 * point with this filter width, and so holds the natural kernel's
 * intermediates for it (`sampleTerrain` does): the same answer, without
 * evaluating the kernel a second time.
 */
export function sampleLandformCoverFromNatural(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  natural: Readonly<NaturalTerrainIntermediates>,
  target: DuneSample,
): DuneSample {
  return landformCover(world, x, z, filterWidthMeters, natural, target);
}

function landformCover(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  natural: Readonly<NaturalTerrainIntermediates> | null,
  target: DuneSample,
): DuneSample {
  target.ergWeight = 0;
  target.duneHeight = 0;
  target.sandCover = 0;
  if (world.worldEvolution === "eroded") return target;
  const coreMask = landformCoreMask(world, x, z);
  if (coreMask <= 0) return target;
  const at = natural ?? sampleNaturalTerrainIntermediates(world.seedHash, x, z, filterWidthMeters);
  const erg = duneErgWeight(world, x, z, coreMask, at, duneRelief(at), volcanicActivity);
  if (erg <= 0) return target;
  return sampleDuneField(world, x, z, erg, filterWidthMeters, at, target);
}

/** The far field's texel: its erg weight is band-limited at this half-width. */
const ERG_FAR_FILTER_WIDTH_METERS = 1_250;

/**
 * `sampleErgFarWeight`'s "no erg, and the kernel was never evaluated": the far
 * province field's lane contract, where a negative value is a cheap early out
 * that costs its frame budget nothing.
 */
export const ERG_FAR_WEIGHT_SKIPPED = -1;

const FAR_CLIMATE_SCRATCH: DuneClimateFactors = { arid: 0, patch: 0 };

/**
 * The erg weight as the far ground sees it: the same factors as the dune
 * stage, with the natural kernel band-limited at the far field's 1.25 km
 * texel (which also skips every octave shorter than ~2.5 km, so it is cheap).
 * For the CPU-baked far province field (ClimateProvinceField.ts), which turns
 * it into a sand tone past the fine channel pages; allocates nothing.
 *
 * Returns `ERG_FAR_WEIGHT_SKIPPED` (-1, read as a weight of 0) wherever the
 * erg is ruled out BEFORE the natural kernel: eroded worlds, the landform
 * core, and ground whose province is not arid or lies outside every erg
 * patch. Otherwise the weight in [0, 1].
 */
export function sampleErgFarWeight(world: WorldDefinition, x: number, z: number): number {
  if (world.worldEvolution === "eroded") return ERG_FAR_WEIGHT_SKIPPED;
  const coreMask = landformCoreMask(world, x, z);
  if (coreMask <= 0) return ERG_FAR_WEIGHT_SKIPPED;
  const climate = duneClimateFactors(world, x, z, FAR_CLIMATE_SCRATCH);
  if (climate.arid <= 0 || climate.patch <= 0) return ERG_FAR_WEIGHT_SKIPPED;
  const natural = sampleNaturalTerrainIntermediates(world.seedHash, x, z, ERG_FAR_FILTER_WIDTH_METERS);
  return duneErgWeight(world, x, z, coreMask, natural, duneRelief(natural), volcanicActivity, climate);
}
