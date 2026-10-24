import { CLIMATE_PROVINCE, climateProvinceStaircase } from "./climateProvince";
import { FRACTURE_EXPOSURE_MEAN, FRACTURE_RAVINE_MEAN } from "./geology";
import { fbm2D, filteredValueNoise2D, octaveBandWeight, smoothstep } from "./noise";
import { mixSeed } from "./seed";
// A value import of terrain.ts, which imports this module through
// landforms.ts: safe because the constant is only read inside functions,
// after both modules have evaluated.
import {
  LOCAL_RIDGES_KNOLL_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_POW_212_MEAN,
  type NaturalTerrainIntermediates,
} from "./terrain";
import type { WorldDefinition } from "./types";

/**
 * Sand seas (ergs): the first landform stage after the natural kernel.
 *
 * WHERE. A sand sea needs four things at once, and the ERG WEIGHT is their
 * product, so it is exactly 0 wherever any one is missing:
 *
 * - an arid province (the natural province dryness, before the 70 km climate
 *   core, ramping over `aridDryness`; semi-arid ground gets dry biomes but no
 *   dunes),
 * - an erg patch (`ergPatch`, a ~36 km field: an arid province holds a few sand
 *   seas with rocky desert and gravel plains between them),
 * - low ground (sand collects in basins, and the low edge keeps it off
 *   beaches), read off the height WITHOUT its relief so the weight is smooth,
 * - no hills (`foothillRegion`, read off the natural kernel),
 *
 * times `1 - volcanicActivity` and the landform core. A world that forces dunes
 * drops the province and patch factors (low ground and no hills still apply).
 *
 * WHAT. Inside the weight the stage (1) flattens the floor, damping the
 * kernel's short relief toward its expectation, because real sand seas sit on
 * flat basins, and (2) adds a dune field that is positive with a known mean.
 * The field is crescentic/transverse dunes lined up across the world's
 * prevailing wind, slipfaces facing downwind:
 *
 * - The PHASE runs downwind: the kernel's warped coordinate projected on the
 *   wind, over `spacingMeters`. The 18 km warp swings the crest bearing by
 *   about +-10 degrees over tens of kilometres; `meander` adds crest sinuosity.
 * - Each period is an asymmetric profile: a flat interdune, a convex windward
 *   (stoss) slope at `stossDegrees` on average, a rounded brink and a
 *   `slipDegrees` slipface ending exactly at the period boundary, so the
 *   profile is continuous whatever the crest height does.
 * - The CREST factor (`crest`, a ~700 m field against a threshold that rises
 *   as sand supply falls) breaks the crests into segments where sand runs
 *   short; the low ends are pushed downwind by up to `hornShift` periods,
 *   which bends each segment into a crescent with downwind horns. Plenty of
 *   sand gives continuous wavy ridges, the thin sand at an erg's edge gives
 *   lone barchans on a gravel floor.
 *
 * LEVEL OF DETAIL. The spacing is fixed, so the profile's band weight is a
 * per-page constant (rule 4 of TerrainKernel.ts) and the faded profile blends
 * toward its analytic mean (`duneProfileMeanMeters`): coarse pages, the height
 * pyramid and the horizon keep the same mean ground as fine ones.
 *
 * Class K: pure arithmetic over numbers, transliterated to WGSL in
 * `TerrainLandformKernel.ts` (`terrainDuneStage`).
 */
export const DUNES = Object.freeze({
  /** Natural province dryness over which sand seas fade in (arid plateau = 0.5). */
  aridDrynessLow: 0.3,
  aridDrynessHigh: 0.45,
  /** The erg-patch field: where in an arid province the sand seas lie. */
  ergPatch: Object.freeze({
    channel: 220,
    octaves: 2,
    baseWavelengthMeters: 36_000,
    lacunarity: 2,
    persistence: 0.5,
    low: -0.08,
    high: 0.12,
  }),
  /** Shipped height (m) over which sand fades in off the coast, and out uphill. */
  lowGroundRiseLowMeters: 15,
  lowGroundRiseHighMeters: 40,
  lowGroundFallLowMeters: 350,
  lowGroundFallHighMeters: 700,
  /** `foothillRegion` band over which hilly ground loses its sand. */
  hillLow: 0.2,
  hillHigh: 0.55,
  /** Share of the kernel's short relief (310 m, knolls, geology) removed under a full erg. */
  reliefDamping: 0.95,
  /** Share of the 1.65 km rolling hills and the 2.55 km foothill relief removed under a full erg. */
  rollingDamping: 0.85,
  /** Crest-to-crest spacing of the transverse dunes, metres. */
  spacingMeters: 260,
  /** Crest height at full supply and at the thinnest sand, metres. */
  crestHeightMaxMeters: 22,
  crestHeightMinMeters: 7,
  /** Mean windward slope; the convex profile peaks at 4/3 of it. */
  stossDegrees: 8,
  /** The slipface: sand's angle of repose. */
  slipDegrees: 29,
  /** Polynomial smooth-min height band that rounds the brink (about 4 m wide). */
  brinkRoundingMeters: 3,
  /** Crest sinuosity: a ~1.5 km field and a ~450 m one, amplitudes in periods. */
  meander: Object.freeze({ channel: 221, wavelengthMeters: 1_500, amplitudePeriods: 0.3 }),
  meanderFine: Object.freeze({ channel: 223, wavelengthMeters: 450, amplitudePeriods: 0.1 }),
  /**
   * Linked crescents: each ridge is a chain of crescents `scallopWidthMeters`
   * wide whose middles sit upwind and whose joints (the horns) reach
   * `scallopAmplitudePeriods` downwind. Successive ridges are staggered by
   * `scallopStagger` of a crescent so the joints do not line up downwind.
   */
  scallopWidthMeters: 520,
  scallopAmplitudePeriods: 0.22,
  scallopStagger: 0.12,
  /** How far the two meander fields push the crescent joints sideways, crescents. */
  scallopJitter: 0.45,
  /** Crest continuity: a ~700 m field. */
  crest: Object.freeze({ channel: 222, wavelengthMeters: 700 }),
  /** Crest threshold at full supply and at the thinnest sand, on the [0, 1] crest field. */
  crestThresholdFull: 0.18,
  crestThresholdThin: 0.82,
  crestHalfWidth: 0.3,
  /** How far a fading crest's ends are pushed downwind, periods. */
  hornShift: 0.32,
  /** Sand cover: dune height (m) over which a dune body reads as sand. */
  sandCoverLowMeters: 0.4,
  sandCoverHighMeters: 2.5,
  /** Erg weight above which the interdune floor is a sand sheet too. */
  sandSheetLow: 0.55,
  sandSheetHigh: 0.9,
});

const DEG = Math.PI / 180;
const STOSS_TAN = Math.tan(DUNES.stossDegrees * DEG);
const SLIP_TAN = Math.tan(DUNES.slipDegrees * DEG);
/** The tallest crest that still leaves the stoss and slip inside one period. */
const CREST_HEIGHT_LIMIT_METERS = 0.92 * DUNES.spacingMeters / (1 / STOSS_TAN + 1 / SLIP_TAN);

/** Is a world's weight forced (dunes everywhere on low ground) rather than grown? */
function dunesForced(world: Pick<WorldDefinition, "landforms">): boolean {
  return world.landforms?.dunes === true;
}

/**
 * The stoss shape g(u) = u^2 (2 - u) on [0, 1]: zero slope at the toe, slope 1
 * (the mean slope) at the brink, peaking at 4/3 two-thirds of the way up. Its
 * integral over [0, 1] is 5/12.
 */
function stossShape(u: number): number {
  return u * u * (2 - u);
}
const STOSS_SHAPE_INTEGRAL = 5 / 12;

/** Polynomial smooth minimum (C1); lowers the meeting point by k / 4. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * One period of the dune profile at `metersIntoPeriod` (0 = the toe of the
 * previous slipface), for a crest `crestHeight` metres high. Exactly 0 on the
 * interdune floor and at both period ends.
 */
export function duneProfileMeters(metersIntoPeriod: number, crestHeight: number): number {
  if (crestHeight <= 0) return 0;
  const slipLength = crestHeight / SLIP_TAN;
  const stossLength = crestHeight / STOSS_TAN;
  const crestAt = DUNES.spacingMeters - slipLength;
  const toeAt = crestAt - stossLength;
  if (metersIntoPeriod <= toeAt) return 0;
  // The stoss continues past the brink at its brink slope (the mean slope);
  // the slipface line continues back up past it. Their smooth minimum is the
  // profile, rounded over a few metres at the brink.
  const stoss = metersIntoPeriod <= crestAt
    ? crestHeight * stossShape((metersIntoPeriod - toeAt) / stossLength)
    : crestHeight + (metersIntoPeriod - crestAt) * STOSS_TAN;
  const slip = crestHeight - (metersIntoPeriod - crestAt) * SLIP_TAN;
  return Math.max(0, smoothMin(stoss, slip, DUNES.brinkRoundingMeters));
}

/**
 * The profile's mean over one period for a crest `crestHeight` high: the stoss
 * and slip areas less the brink rounding (k^2 / 6r for a polynomial smooth
 * minimum whose two lines part at r = tan(stoss) + tan(slip)).
 */
export function duneProfileMeanMeters(crestHeight: number): number {
  if (crestHeight <= 0) return 0;
  const k = DUNES.brinkRoundingMeters;
  const area = crestHeight * (crestHeight / STOSS_TAN) * STOSS_SHAPE_INTEGRAL
    + crestHeight * (crestHeight / SLIP_TAN) * 0.5
    - (k * k) / (6 * (STOSS_TAN + SLIP_TAN));
  return Math.max(0, area) / DUNES.spacingMeters;
}

/** The phase of a point along the wind, before meander and horns, periods. */
export function duneWindPhase(windRadians: number, warpedX: number, warpedZ: number): number {
  // wind.ts: the wind blows TOWARD (sin, cos) in (x, z), so the phase grows downwind.
  return (warpedX * Math.sin(windRadians) + warpedZ * Math.cos(windRadians)) / DUNES.spacingMeters;
}

/** The across-wind coordinate in crescents (positive to the wind's right). */
export function duneAcrossPhase(windRadians: number, warpedX: number, warpedZ: number): number {
  return (warpedX * Math.cos(windRadians) - warpedZ * Math.sin(windRadians)) / DUNES.scallopWidthMeters;
}

/**
 * The linked-crescent shape: 0 at a crescent's middle, 1 at its joints, a
 * parabola in between, so the joint is a downwind-pointing cusp.
 */
export function duneScallop(across: number): number {
  const offset = 2 * (across - Math.floor(across)) - 1;
  return offset * offset;
}

/** Scratch the stage hands the sand-cover reader; one per module, no allocation. */
export interface DuneSample {
  /** The erg weight at the point, [0, 1]. */
  ergWeight: number;
  /** The dune field's own height above the flattened floor, metres. */
  duneHeight: number;
  /** How much of the ground is sand: dune bodies, and the floor under a full erg. */
  sandCover: number;
}

const DUNE_SCRATCH: DuneSample = { ergWeight: 0, duneHeight: 0, sandCover: 0 };

/**
 * The natural province's dryness before the climate core: the dryness half of
 * `sampleClimateProvinceUnmasked`, the same arithmetic, without evaluating the
 * temperature field or allocating (this runs on physics' height samples).
 * WGSL twin: `kProvinceDrynessStaircase` over the `provinceDryness` lattices.
 */
export function unmaskedProvinceDryness(seedHash: number, x: number, z: number): number {
  const field = CLIMATE_PROVINCE.dryness;
  return climateProvinceStaircase(
    fbm2D(
      mixSeed(seedHash, field.channel),
      x / field.baseWavelengthMeters,
      z / field.baseWavelengthMeters,
      field.octaves,
      field.lacunarity,
      field.persistence,
    ),
    field.levels,
    field.thresholds,
  );
}

/**
 * The erg weight from the factors the kernel already computed (`coreMask`,
 * low ground, no hills), then the province and the erg patch. Returns 0
 * before reading a lattice wherever a cheap factor is already 0.
 */
export function duneErgWeight(
  world: WorldDefinition,
  x: number,
  z: number,
  coreMask: number,
  natural: Readonly<NaturalTerrainIntermediates>,
  relief: Readonly<DuneRelief>,
  volcanicActivity: (world: WorldDefinition, x: number, z: number) => number,
): number {
  // Low ground is read off the BASE height, the shipped height without its
  // relief: a gate on the shipped height itself follows every knoll, and a
  // weight that steps over 20 m multiplies a 20 m dune into a cliff.
  const base = natural.shippedHeight - relief.short - relief.broad;
  const lowGround = smoothstep(DUNES.lowGroundRiseLowMeters, DUNES.lowGroundRiseHighMeters, base)
    * (1 - smoothstep(DUNES.lowGroundFallLowMeters, DUNES.lowGroundFallHighMeters, base));
  const flat = 1 - smoothstep(DUNES.hillLow, DUNES.hillHigh, natural.foothillRegion);
  let weight = coreMask * lowGround * flat;
  if (weight <= 0) return 0;
  if (!dunesForced(world)) {
    weight *= smoothstep(DUNES.aridDrynessLow, DUNES.aridDrynessHigh, unmaskedProvinceDryness(world.seedHash, x, z));
    if (weight <= 0) return 0;
    const patch = DUNES.ergPatch;
    weight *= smoothstep(
      patch.low,
      patch.high,
      fbm2D(
        mixSeed(world.seedHash, patch.channel),
        x / patch.baseWavelengthMeters,
        z / patch.baseWavelengthMeters,
        patch.octaves,
        patch.lacunarity,
        patch.persistence,
      ),
    );
    if (weight <= 0) return 0;
  }
  return weight * (1 - volcanicActivity(world, x, z));
}

/**
 * The dune field at a point with erg weight `erg`: writes the sample and
 * returns the dune height. `filterWidthMeters` fades the profile toward its
 * mean exactly as the page's band weight does on the GPU.
 */
export function sampleDuneField(
  world: WorldDefinition,
  x: number,
  z: number,
  erg: number,
  filterWidthMeters: number,
  natural: Readonly<NaturalTerrainIntermediates>,
  target: DuneSample = DUNE_SCRATCH,
): DuneSample {
  const supply = erg;
  const meander = DUNES.meander;
  const crestField = DUNES.crest;
  const crestNoise = filteredValueNoise2D(
    mixSeed(world.seedHash, crestField.channel),
    x / crestField.wavelengthMeters,
    z / crestField.wavelengthMeters,
    crestField.wavelengthMeters,
    filterWidthMeters,
  );
  const threshold = DUNES.crestThresholdThin
    + (DUNES.crestThresholdFull - DUNES.crestThresholdThin) * supply;
  const crest = smoothstep(
    threshold - DUNES.crestHalfWidth,
    threshold + DUNES.crestHalfWidth,
    crestNoise * 0.5 + 0.5,
  );
  const crestHeight = Math.min(
    CREST_HEIGHT_LIMIT_METERS,
    crest * (DUNES.crestHeightMinMeters
      + (DUNES.crestHeightMaxMeters - DUNES.crestHeightMinMeters) * supply)
      * (0.8 + 0.2 * crestNoise),
  );
  const meanderFine = DUNES.meanderFine;
  const meanderNoise = filteredValueNoise2D(
    mixSeed(world.seedHash, meander.channel),
    x / meander.wavelengthMeters,
    z / meander.wavelengthMeters,
    meander.wavelengthMeters,
    filterWidthMeters,
  );
  const meanderFineNoise = filteredValueNoise2D(
    mixSeed(world.seedHash, meanderFine.channel),
    x / meanderFine.wavelengthMeters,
    z / meanderFine.wavelengthMeters,
    meanderFine.wavelengthMeters,
    filterWidthMeters,
  );
  const windPhase = duneWindPhase(world.prevailingWindRadians, natural.warpedX, natural.warpedZ);
  const across = duneAcrossPhase(world.prevailingWindRadians, natural.warpedX, natural.warpedZ)
    + windPhase * DUNES.scallopStagger
    + meanderNoise * DUNES.scallopJitter;
  const phase = windPhase
    + meanderNoise * meander.amplitudePeriods
    + meanderFineNoise * meanderFine.amplitudePeriods
    - DUNES.scallopAmplitudePeriods * (0.65 + 0.35 * crestNoise) * duneScallop(across)
    - DUNES.hornShift * (1 - crest);
  const metersIntoPeriod = (phase - Math.floor(phase)) * DUNES.spacingMeters;
  const mean = duneProfileMeanMeters(crestHeight);
  const kept = octaveBandWeight(DUNES.spacingMeters, filterWidthMeters);
  const profile = kept >= 1
    ? duneProfileMeters(metersIntoPeriod, crestHeight)
    : mean + (duneProfileMeters(metersIntoPeriod, crestHeight) - mean) * kept;
  const duneHeight = erg * profile;
  target.ergWeight = erg;
  target.duneHeight = duneHeight;
  target.sandCover = Math.max(
    smoothstep(DUNES.sandCoverLowMeters, DUNES.sandCoverHighMeters, duneHeight),
    smoothstep(DUNES.sandSheetLow, DUNES.sandSheetHigh, erg),
  );
  return target;
}

/** The natural kernel's relief, measured from its own expectations. */
export interface DuneRelief {
  /** 310 m fbm, rocky knolls, geological relief: damped by `reliefDamping`. */
  short: number;
  /** 1.65 km rolling hills, foothill ridges and valleys: damped by `rollingDamping`. */
  broad: number;
}

/**
 * The kernel's relief at a point, each term measured from the kernel's own
 * expectation (terrain.ts, geology.ts), so a band-limited page, whose terms
 * already sit on them, has none.
 */
export function duneRelief(
  natural: Readonly<NaturalTerrainIntermediates>,
  target: DuneRelief = RELIEF_SCRATCH,
): DuneRelief {
  const land = natural.land;
  const foothill = natural.foothillRegion;
  const mountain = natural.mountainRegion;
  const knollMean = land * (0.34 + foothill * 0.66) * LOCAL_RIDGES_KNOLL_MEAN
    * (72 + foothill * 115);
  const geologyMean = land <= 0.0001
    ? 0
    : land * (foothill * 0.52 + mountain * 0.78) * FRACTURE_EXPOSURE_MEAN * (17 + mountain * 66)
      - land * (foothill * 0.32 + mountain * 0.7) * FRACTURE_RAVINE_MEAN * (9 + mountain * 48);
  const foothillMean = land * foothill * RIDGES_POW_212_MEAN * 285;
  const valleyMean = land * foothill * RIDGES_INVERSE_POW_31_MEAN * (55 + mountain * 105);
  target.short = natural.fine * (5 + land * 12)
    + (natural.rockyKnolls - knollMean)
    + (natural.geologicalRelief - geologyMean);
  target.broad = natural.rolling * natural.hillStrength
    + (natural.foothillHeight - foothillMean)
    - (natural.valleyCarve - valleyMean);
  return target;
}

/**
 * The floor flattening under an erg weight `erg`: the short relief taken
 * toward its expectation by `reliefDamping`, the broad relief by
 * `rollingDamping`. Mean-free, because the relief is.
 */
export function duneFloorFlattening(erg: number, relief: Readonly<DuneRelief>): number {
  return -erg * (DUNES.reliefDamping * relief.short + DUNES.rollingDamping * relief.broad);
}

const RELIEF_SCRATCH: DuneRelief = { short: 0, broad: 0 };

/**
 * The dune stage: `height` untouched (the same number, not `+ 0`) wherever the
 * erg weight is 0; inside a sand sea the flattened floor plus the dune field.
 */
export function applyDuneStage(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  filterWidthMeters: number,
  coreMask: number,
  natural: Readonly<NaturalTerrainIntermediates>,
  volcanicActivity: (world: WorldDefinition, x: number, z: number) => number,
): number {
  const relief = duneRelief(natural);
  const erg = duneErgWeight(world, x, z, coreMask, natural, relief, volcanicActivity);
  if (erg <= 0) return height;
  const dunes = sampleDuneField(world, x, z, erg, filterWidthMeters, natural);
  return height + duneFloorFlattening(erg, relief) + dunes.duneHeight;
}

/**
 * The profile's derived constants, for the WGSL twin (`TerrainLandformKernel.ts`)
 * to inject rather than re-derive: a retyped tangent is a slipface that
 * disagrees with collision.
 */
export const DUNE_PROFILE_CONSTANTS = Object.freeze({
  stossTan: STOSS_TAN,
  slipTan: SLIP_TAN,
  crestHeightLimitMeters: CREST_HEIGHT_LIMIT_METERS,
  stossShapeIntegral: STOSS_SHAPE_INTEGRAL,
});
