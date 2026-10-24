import { saturate, smoothstep } from "@/src/world/noise";
import { COLD_BIOME_WGSL, tundraShare } from "@/src/world/coldBiomes";
import {
  applyClimateProvinceDryness,
  CLIMATE_PROVINCE_METERS_PER_TEMPERATURE,
  CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE,
  terrainSnowlineThermalHeight,
  terrainThermalHeight,
} from "@/src/world/climateProvince";
import {
  CANOPY_CLOSURE_FILTER_WIDTH_METERS,
  DRY_PROVINCE_DESERT_FULL,
  DRY_PROVINCE_DESERT_ONSET,
  DRY_PROVINCE_PARKLAND_FULL,
  DRY_PROVINCE_PARKLAND_ONSET,
  dryProvinceAridShare,
  dryProvinceParklandShare,
  SAND_COVER_TREE_HIGH,
  SAND_COVER_TREE_LOW,
  SOIL_LITTER_DEEP_METERS,
  SOIL_LITTER_THIN_METERS,
  soilLitterFactor,
} from "../detail/densityField";
import {
  SURFACE_MATERIAL_BASE_COUNT,
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
  type SurfaceMaterialId,
  volcanicFallbackMaterial,
} from "./surfaceMaterials";
import {
  TROPICAL_COAST,
  TROPICAL_COAST_WGSL,
  tropicalCoastWeight,
} from "@/src/world/tropicalCoast";
import { FAR_SWARD_BAKE_GATE_WGSL } from "./FarSwardGate";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from "./TerrainEvolutionContract";
import {
  TERRAIN_TWI_DRY,
  TERRAIN_TWI_SLOPE_EPSILON,
  TERRAIN_TWI_WET,
  terrainSlopeAngleFromNormalizedSteepness,
  terrainTopographicWetnessIndex,
  terrainTopographicWetnessToUnit,
} from "./TerrainPageHydrology";

/**
 * The land-cover classifier (`4-6`, `4-6b`, `R-27`).
 *
 * INVARIANT THIS FILE OWNS: **one authority classifies the ground, the trees
 * standing on it and the animals living in them.** Before this item there were
 * three independent answers to one question — `classifyBiome`'s threshold
 * cascade, `chooseTreeSpecies`' own rules, and the wildlife habitat table —
 * and nothing made them agree. A treeline could end where the rock started, or
 * 80 m above it, and only a screenshot would say which.
 *
 * **Ten smooth suitability functions, softmaxed and top-4 renormalised**,
 * replacing a cascade of `if (height > x) return BIOME`. The difference is not
 * stylistic: a threshold cascade produces a hard edge at every boundary and a
 * SINGLE answer per point, so a boundary can only ever be a coin flip between
 * two materials — which is exactly what the audit found and what
 * `RENDERING_PLAN.md` calls "material identity is a coin flip between distant
 * vertices". A weight vector has no boundary at all; it has an ecotone.
 *
 * `dayOfYear` is in the signature from the first line, not as a retrofit
 * (§1.6, and the seasonal-family boundary test fails the build otherwise).
 * What it drives is the SNOW weight and nothing else: species mix stays
 * climatic, which `PHASE_2_EXECUTION_PLAN.md` `2-18` requires — flipping
 * forest to grassland with the calendar would delete forests every winter.
 *
 * Class P: pure arithmetic over numbers, WGSL-portable under the `0-4` rules,
 * and emitted as a shared include so the classifier the CPU runs and the one
 * the GPU bakes are the same ten functions.
 */

/** Weights the classifier may assign. Four survive renormalisation. */
export const LAND_COVER_TOP_MATERIALS = 4;

export interface LandCoverInput {
  /** Metres above sea level. */
  readonly elevationMeters: number;
  /** Normalised steepness (1 − normalY): 0 flat, ~0.21 at the angle of repose. */
  readonly slope: number;
  /**
   * Real upstream area from the erosion page. When present it supersedes the
   * pre-erosion moisture proxy for wetness; omission preserves analytic parity.
   */
  readonly flowAccumulationAreaM2?: number;
  /**
   * `6-6`: metres of soil from the page's soil-depth channel. Deep soil is
   * deep litter, and litter is what makes a forest floor read as forest floor
   * rather than as bare ground under trees. Omission preserves analytic parity
   * exactly as `flowAccumulationAreaM2`'s does.
   */
  readonly soilDepthMeters?: number;
  /**
   * `6-8`: true crown cover of the canopy standing on this texel, from
   * `densityField`'s `canopyClosure` — the ONE closure, read through the one
   * sanctioned entry point. Omission reads 0, which leaves every suitability
   * at its pre-6-8 value; the CPU ecology callers do not supply it, so the
   * classification the species and wildlife rules read is unmoved and only the
   * page splat bake (which does supply it) changes.
   */
  readonly canopyClosure?: number;
  /** `6-8`: absolute grass-sward cover, canopy-suppressed. Omission reads 0. */
  readonly grassCover?: number;
  readonly moisture: number;
  /** Normalised temperature from the climate chain, before the seasonal shift. */
  readonly temperature: number;
  /** −1 cool pole-facing … +1 warm equator-facing. */
  readonly aspect: number;
  /** 0 outside the airport blend, 1 on the graded platform. */
  readonly airportInfluence: number;
  /** §1.6: part of this signature from the first line. */
  readonly dayOfYear: number;
  /** Seasonal temperature offset in normalised units; 0 at the reference day. */
  readonly seasonalTemperatureShift: number;
  /**
   * The climate province's temperature offset (`sampleClimateProvince`),
   * normalised units, negative colder. `temperature` already includes it; this
   * raw copy drives THERMAL HEIGHT, the altitude bands' input. Exactly 0 in the
   * temperate core, and omission reads 0, so every band is bit-identical there.
   */
  readonly temperatureOffset?: number;
  /**
   * The climate province's dryness offset, moisture units, positive drier.
   * `moisture` already includes it; this raw copy reaches the real-drainage
   * wetness (which ignores climatic moisture) and is there for arid terms.
   * Exactly 0 in the temperate core; omission reads 0.
   */
  readonly dryness?: number;
  /**
   * Sand seas: how much of the ground the dunes leave as sand
   * (`sampleLandformCover`), 1 on dune bodies and on a full erg's floor.
   * Exactly 0 inside the landform core and outside sand seas; omission reads
   * 0 and leaves every suitability bit-identical (see
   * `landCoverSandCoverTerms`). The splat bake does not supply it yet: its
   * zero-initialised input reads 0 until the bake samples the landform cover.
   */
  readonly sandCover?: number;
  /**
   * Volcanic land (`sampleVolcanicGround`): the share of the ground that is
   * lava rock, [0, 1]. Exactly 0 outside every volcanic footprint, and with
   * `tephraCover` also 0 (or omitted) the two volcanic suitabilities are left
   * out of the softmax ENTIRELY, so the classification is bit-identical to
   * what shipped before volcanic land existed. See `landCoverIsVolcanic`.
   */
  readonly lavaCover?: number;
  /** Share of the ground that is tephra: cinder, scoria, ash, black sand. */
  readonly tephraCover?: number;
  /** Age of the dominant volcanic cover: 0 fresh, 1 old. Omission reads 0. */
  readonly volcanicAge?: number;
}

export interface LandCoverWeights {
  /** Material ids, most significant first. */
  readonly ids: readonly SurfaceMaterialId[];
  /** Weights summing to 1, aligned with `ids`. */
  readonly weights: readonly number[];
}

/**
 * Softmax temperature. Lower is sharper.
 *
 * **Jittered per point by the drivers themselves** (see
 * `landCoverSoftmaxTemperature`): uniform ecotone sharpness is as much a tell
 * as a straight boundary. Real transitions are abrupt where a soil or drainage
 * break drives them and diffuse where a climate gradient does.
 */
export const LAND_COVER_SOFTMAX_BASE_TEMPERATURE = 0.22;

/** The snowline's reference altitude; the seasonal shift moves it down. */
const SNOWLINE_REFERENCE_METERS = 1_520;
const METERS_PER_NORMALIZED_TEMPERATURE = 2_450;

/**
 * `6-6`'s litter seam: how much duff the soil column under this texel carries.
 *
 * The mapping is `densityField`'s — imported, not restated, because litter is
 * a vegetation product and terrain reaches vegetation through exactly one
 * entry point (the boundary test enforces it). Absent soil depth returns the
 * neutral 0, which leaves every suitability at its pre-6-6 value.
 */
export const LAND_COVER_FOREST_FLOOR_LITTER_GAIN = 0.35;

export function landCoverLitter(input: LandCoverInput): number {
  if (input.soilDepthMeters === undefined) return 0;
  return soilLitterFactor(input.soilDepthMeters);
}

/**
 * `6-8`'s two canopy seams.
 *
 * Forest floor was previously inferred from CLIMATE — wet, warm, below the
 * treeline — which is the recipe for where forest *could* grow, not for where
 * it stands. The density field already answers the second question, and its
 * answer includes the glade, windthrow and succession structure that climate
 * alone cannot express, so a clearing inside a wet warm province classified as
 * closed forest floor and now classifies as what it is. The grass seam is the
 * complement: a sward is ground the canopy left open, and `GroundCoverSystem`
 * stops placing blades at 80 m, so past that the terrain material is the only
 * thing that can say a meadow is a meadow.
 */
export const LAND_COVER_CANOPY_CLOSURE_GAIN = 0.55;
export const LAND_COVER_GRASS_COVER_GAIN = 0.45;

/**
 * THE TUNDRA PARTITION — what open ground is made of once a province is too
 * cold for trees (`tundraShare`, `src/world/coldBiomes.ts`).
 *
 * Thermal height already puts a tundra province's lowland in the alpine band,
 * so its ground starts from the alpine law item C tuned for mountain tops:
 * turf on the gentle ground, rock on the steep, scree between. Three things
 * about that law are true of a mountain and false of the Arctic, and each is
 * a gated product here:
 *
 * 1. TURF IS COLD-HARDY. Item C's `cool` gate (temperature 0.00-0.12) hands
 *    turf to bare ground at the very top of a temperate mountain, because
 *    there it is the last vegetation below the summit. Arctic sedge, moss and
 *    dwarf herbs cover ground colder than that for thousands of kilometres,
 *    so the tundra share lifts the gate toward 1.
 * 2. FLAT GROUND IS NOT BEDROCK. Rock's flat `alpine * 0.25` claim stands for
 *    a summit's wind-scoured pavement; the low-arctic plain is vegetated
 *    tundra over permafrost, with frost-sorted gravel where it is bare. The
 *    flat claim loses `TUNDRA_FLAT_ROCK_LOSS` of itself. The slope share is
 *    untouched: an arctic cliff is still rock.
 * 3. HEATH DOES NOT STOP AT 1,650 m. Shrub's upper altitude cut is a mountain
 *    fact (the heath band gives out under the summit). Dwarf-shrub heath —
 *    crowberry, bilberry, dwarf birch, Labrador tea — is the commonest cover
 *    of the low Arctic, so the tundra share restores the cut toward
 *    `TUNDRA_HEATH_CUT_FLOOR`.
 *
 * Measured in the tundra preset (-0.65) on flat open ground 20 m above the
 * sea, the top four come out turf 0.56, heath 0.24, dry grass 0.11, gravel
 * 0.09 at moisture 0.5; at 0.25 dry grass 0.59 and heath 0.33 lead, and at
 * 0.8 turf takes 0.79. Repose-angle ground is scree (gravel 0.56-0.63) and
 * snow claims the hills from ~800 m. Every term is `x + 0` or `x * 1` at
 * share 0, so the temperate core is bit-identical — the frozen law of
 * `render.webgpu-land-cover-alpine-partition` holds it, and
 * `render.webgpu-cold-biomes` checks offset 0 against omission.
 */
export const TUNDRA_FLAT_ROCK_LOSS = 0.6;
export const TUNDRA_HEATH_CUT_FLOOR = 0.85;

/**
 * VOLCANIC LAND (phase 2): the rules, as data.
 *
 * Volcanism is geology, not climate, so its inputs arrive beside the climate
 * rather than through it: lava cover, tephra cover and the age of whichever
 * dominates, all exactly 0 outside a footprint. The age decides how much of
 * the climate's own cover has come back:
 *
 * - FRESH (age under ~0.3): bare Basalt or Tephra. Loose scoria stands at its
 *   angle of repose, ~34 degrees, so on a cone Tephra holds the ground up to
 *   it and Rock takes over above it (crater walls).
 * - MIDDLE (~0.3 to ~0.7): pioneers. Where the ground is moist Grass and Shrub
 *   creep in (a cold wet province reads as Iceland's moss heath); where it is
 *   dry it stays bare (Craters of the Moon).
 * - OLD (over ~0.7): the climate's normal cover is back, and fertile — a warm
 *   wet province grows dense forest on it — with Rock left on the flow fronts.
 *
 * Snow is the existing snowline's, untouched. And the shoreline's Sand hands
 * over to Tephra inside volcanic ground, whatever its age: black sand.
 *
 * Every age window is a smoothstep, like every other driver here: the ages
 * are ecotones, not thresholds.
 */
export const LAND_COVER_VOLCANIC_FRESH_AGE: readonly [number, number] = Object.freeze([0.2, 0.4]);
export const LAND_COVER_VOLCANIC_OLD_AGE: readonly [number, number] = Object.freeze([0.6, 0.8]);
/** How much of the climate's cover a moist middle-aged surface has back. */
export const LAND_COVER_VOLCANIC_MOIST_COLONISATION = 0.75;
/**
 * Bare lava's claim: above every cover the volcanic ground does not take
 * (gentle Rock, the shore's bands), so fresh flows are Basalt — and under
 * Snow's 1.5, so a volcano's snow cap is the existing snowline's, no new code.
 */
export const LAND_COVER_BASALT_GAIN = 1.4;
/** Bare tephra's claim below its angle of repose; under Snow's too. */
export const LAND_COVER_TEPHRA_GAIN = 1.35;
/**
 * The angle of repose of loose scoria, 34 degrees, as normalised steepness
 * (`1 - cos`), and the half-width of the hand-over to Rock around it.
 */
export const LAND_COVER_TEPHRA_REPOSE_SLOPE = 1 - Math.cos((34 * Math.PI) / 180);
export const LAND_COVER_TEPHRA_REPOSE_HALF_WIDTH = 0.017;
/** The pioneers' claims on moist middle-aged ground. */
export const LAND_COVER_VOLCANIC_PIONEER_GRASS = 0.9;
export const LAND_COVER_VOLCANIC_PIONEER_SHRUB = 0.6;
/** Old volcanic soil (andosol) is fertile: forest floor's gain on it. */
export const LAND_COVER_VOLCANIC_FERTILITY_GAIN = 0.3;
/** Rock on the steep fronts of an old flow. */
export const LAND_COVER_VOLCANIC_FRONT_SLOPE: readonly [number, number] = Object.freeze([0.12, 0.3]);
export const LAND_COVER_VOLCANIC_FRONT_GAIN = 1.4;

/**
 * Whether a point is volcanic ground at all: the one predicate both the
 * suitabilities and the softmax read. False wherever both covers are 0 or
 * omitted, which is every point of a world before volcanic land existed.
 */
export function landCoverIsVolcanic(input: LandCoverInput): boolean {
  return (input.lavaCover ?? 0) > 0 || (input.tephraCover ?? 0) > 0;
}

/**
 * How much of the climate's own cover has come back to volcanic ground of
 * this age, [0, 1]. `wet` is the classifier's `smoothstep(0.3, 0.64, wetness)`.
 */
export function landCoverVolcanicColonisation(age: number, wet: number): number {
  const fresh = 1 - smoothstep(LAND_COVER_VOLCANIC_FRESH_AGE[0], LAND_COVER_VOLCANIC_FRESH_AGE[1], age);
  const old = smoothstep(LAND_COVER_VOLCANIC_OLD_AGE[0], LAND_COVER_VOLCANIC_OLD_AGE[1], age);
  const middle = saturate(1 - fresh - old);
  return saturate(middle * wet * LAND_COVER_VOLCANIC_MOIST_COLONISATION + old);
}

/**
 * The share of the ground that is BARE volcanic rock or tephra, [0, 1]: the
 * volcanic cover times what colonisation has not reclaimed. Exactly 0 off
 * volcanic ground.
 *
 * This is what vegetation follows. Trees and shrubs are thinned by it
 * (`detail/generation.ts`), the bake's canopy lane is cut by it so the far
 * canopy agrees with the trees actually planted, and the grass blades follow
 * the classifier's own Grass weight, which this same share suppresses.
 */
export function landCoverVolcanicBareShare(input: LandCoverInput): number {
  if (!landCoverIsVolcanic(input)) return 0;
  const share = saturate(saturate(input.lavaCover ?? 0) + saturate(input.tephraCover ?? 0));
  const wet = smoothstep(0.3, 0.64, landCoverWetness(input));
  return share * (1 - landCoverVolcanicColonisation(saturate(input.volcanicAge ?? 0), wet));
}

/**
 * One classifier seam: real drainage when available, climatic proxy otherwise.
 *
 * Climatic moisture already carries the province's dryness. Real drainage does
 * not read climate at all, so a dry province would never reach eroded ground;
 * it is applied there instead, the same way (`applyClimateProvinceDryness`).
 * A zero dryness returns the shipped value bit for bit.
 */
export function landCoverWetness(input: LandCoverInput): number {
  if (input.flowAccumulationAreaM2 === undefined) return saturate(input.moisture);
  return applyClimateProvinceDryness(
    terrainTopographicWetnessToUnit(terrainTopographicWetnessIndex(
      input.flowAccumulationAreaM2,
      terrainSlopeAngleFromNormalizedSteepness(input.slope),
    )),
    input.dryness ?? 0,
  );
}

/** Sand seas: what full sand cover adds to Sand (see `landCoverSandCoverTerms`). */
export const LAND_COVER_SAND_COVER_GAIN = 1.5;
/** Normalised steepness of 35 and 42 degrees: dune slipfaces sit below the band. */
export const LAND_COVER_SAND_SLOPE_LOW = 0.18;
export const LAND_COVER_SAND_SLOPE_HIGH = 0.26;

export interface LandCoverSandCoverTerms {
  /** Added to Sand. */
  sand: number;
  /** Multiplies every vegetated material. */
  vegetation: number;
  /** Multiplies the stony materials, Rock and Gravel. */
  stone: number;
}

const SAND_COVER_TERMS: LandCoverSandCoverTerms = { sand: 0, vegetation: 1, stone: 1 };

/**
 * Sand seas. A dune is sand whatever the climate says, so sand cover is not
 * one more climatic factor but an override of three claims:
 *
 * - Sand gains `LAND_COVER_SAND_COVER_GAIN` times the cover, so a dune field
 *   reads as sand whatever the province would grow there;
 * - every vegetated material (Grass, DryGrass, Shrub, ForestFloor) is
 *   multiplied by `1 - cover`: nothing roots in moving sand;
 * - Rock and Gravel are multiplied by `1 - cover` on dune-angle ground: the
 *   sand buries the pavement. Slipfaces stand at 29-34 degrees, sand's angle
 *   of repose, inside the bands where Rock's altitude share reads slope as
 *   rock face (a cold desert's thermal height is alpine), the alpine scree
 *   band claims Gravel, and the high desert's fan band claims it again. The
 *   burial fades out over 35-42 degrees (`LAND_COVER_SAND_SLOPE_*`), where
 *   `steep` begins, so a genuine outcrop in an erg keeps its Rock and scree,
 *   and the Sand gain fades with it.
 *
 * Applied after every climate term, the dry and cold provinces' claims
 * included, which is what lets the cover override them. The suitabilities
 * apply these only where the cover is positive (a branch, the M-1 pattern),
 * so ground off the sand seas is the shipped law by construction. Returns
 * module scratch; read it before the next call.
 */
export function landCoverSandCoverTerms(
  sandCover: number,
  slope: number,
  target: LandCoverSandCoverTerms = SAND_COVER_TERMS,
): LandCoverSandCoverTerms {
  const cover = saturate(sandCover);
  const dune = cover * (1 - smoothstep(LAND_COVER_SAND_SLOPE_LOW, LAND_COVER_SAND_SLOPE_HIGH, slope));
  target.sand = dune * LAND_COVER_SAND_COVER_GAIN;
  target.vegetation = 1 - cover;
  target.stone = 1 - dune;
  return target;
}

/**
 * The dry provinces' claims (`dryProvinceShares`), each already scaled by its
 * share.
 *
 * A HIGH DESERT (sagebrush steppe) is not one colour: grey-olive sage on the
 * gentle ground that holds a little water, tan bunchgrass between, pale bare
 * soil on the driest basin floors, gravel pavement on the fans, and rock on any
 * slope whose soil the wind has taken. So its claims key on the same two
 * drivers the temperate law reads, slope and wetness, and differ only in what
 * they hand each band to. The province SCALES moisture rather than clamping
 * it, so the dried field still carries its 850 m / 5.2 km structure and
 * "driest" is a mosaic, not a disc:
 *
 *  - SAND takes the flattest, driest ground: basin floors and playas.
 *  - SHRUB (sage) takes the gentle ground that is a little less dry.
 *  - DRYGRASS keeps the middle, damped a little: bunchgrass.
 *  - GRAVEL takes the fan band, about 10-30 degrees.
 *  - ROCK starts on gentler slopes than the temperate `steep` window, because
 *    desert hills carry almost no soil.
 *  - Grass is damped hard, not removed: the odd green seep stays.
 *
 * An OAK SAVANNA needs no claim of its own: the dried moisture already hands
 * the open ground to DryGrass. It only damps Grass, so the green is left to
 * the wettest hollows and the golden sward carries the rest.
 *
 * Every claim is a product with a share; at zero dryness they are all exactly
 * 0 and both keep factors exactly 1.
 */
export const LAND_COVER_DRY_PROVINCE = Object.freeze({
  /** Basin-floor flatness, slope window (about 5 to 14 degrees). */
  flatLow: 0.004,
  flatHigh: 0.03,
  /** Bare ground: the driest wetness in a desert's dried range. */
  bareLow: 0.18,
  bareHigh: 0.28,
  /** Sage: the less dry end of the same range. */
  sageLow: 0.19,
  sageHigh: 0.31,
  /** Sage holds ground to about 25 degrees and is gone by 40. */
  shrubSlopeLow: 0.1,
  shrubSlopeHigh: 0.24,
  /** The fan band: rising 11-21 degrees, falling 33-46. */
  fanLow: 0.02,
  fanHigh: 0.07,
  fanFadeLow: 0.16,
  fanFadeHigh: 0.3,
  /** Bare rock from about 35 degrees, full by 53. */
  rockLow: 0.18,
  rockHigh: 0.4,
  sandGain: 1.15,
  shrubBase: 0.1,
  shrubWetGain: 0.5,
  gravelGain: 0.3,
  rockGain: 0.4,
  desertGrassCut: 0.9,
  desertDryGrassCut: 0.15,
  parklandGrassCut: 0.6,
});

export interface LandCoverDryProvinceTerms {
  readonly sand: number;
  readonly shrub: number;
  readonly gravel: number;
  readonly rock: number;
  readonly grassKeep: number;
  readonly dryGrassKeep: number;
}

type MutableDryProvinceTerms = { -readonly [K in keyof LandCoverDryProvinceTerms]: number };

/**
 * `target` lets the per-sample classifier reuse one record: the blade-driver
 * bake classifies on the main thread, where nothing may allocate per sample.
 * Callers that keep the result omit it and get their own.
 */
export function landCoverDryProvinceTerms(
  dryness: number,
  slope: number,
  wetness: number,
  target: MutableDryProvinceTerms = {
    sand: 0, shrub: 0, gravel: 0, rock: 0, grassKeep: 1, dryGrassKeep: 1,
  },
): LandCoverDryProvinceTerms {
  const k = LAND_COVER_DRY_PROVINCE;
  const arid = dryProvinceAridShare(dryness);
  const parkland = dryProvinceParklandShare(dryness, arid);
  const flat = 1 - smoothstep(k.flatLow, k.flatHigh, slope);
  const bare = 1 - smoothstep(k.bareLow, k.bareHigh, wetness);
  const sageWet = smoothstep(k.sageLow, k.sageHigh, wetness);
  const holdsShrub = 1 - smoothstep(k.shrubSlopeLow, k.shrubSlopeHigh, slope);
  const fan = smoothstep(k.fanLow, k.fanHigh, slope)
    * (1 - smoothstep(k.fanFadeLow, k.fanFadeHigh, slope));
  target.sand = arid * flat * bare * k.sandGain;
  target.shrub = arid * holdsShrub * (k.shrubBase + sageWet * k.shrubWetGain);
  target.gravel = arid * fan * k.gravelGain;
  target.rock = arid * smoothstep(k.rockLow, k.rockHigh, slope) * k.rockGain;
  target.grassKeep = 1 - arid * k.desertGrassCut - parkland * k.parklandGrassCut;
  target.dryGrassKeep = 1 - arid * k.desertDryGrassCut;
  return target;
}

/** The classifier's own record (see `landCoverDryProvinceTerms`); read at once, never kept. */
const DRY_TERMS_SCRATCH: MutableDryProvinceTerms = {
  sand: 0, shrub: 0, gravel: 0, rock: 0, grassKeep: 1, dryGrassKeep: 1,
};

/**
 * The ten suitabilities, in `SurfaceMaterial` order.
 *
 * Each is a product of smooth factors in [0, 1]. Nothing thresholds; every
 * term is a `smoothstep` whose band is wide enough to be an ecotone rather
 * than an edge, and the WGSL emitter below transliterates these expressions
 * one for one.
 */
export function landCoverSuitabilities(input: LandCoverInput): number[] {
  const {
    elevationMeters: elevation,
    slope,
    temperature,
    aspect,
    airportInfluence,
  } = input;
  const wetness = landCoverWetness(input);
  // CLIMATE PROVINCES: the altitude bands read THERMAL height, the altitude
  // whose climate this point has, so a cold province at sea level behaves like
  // today's ground that much higher up. The shore band, Sand and the wave-washed
  // Gravel band stay on real elevation: the sea does not move with the climate.
  // The snowline follows only part of the shift (see
  // CLIMATE_PROVINCE_SNOWLINE_RESPONSE). The offset is exactly 0 in the
  // temperate core and both heights are then `elevation - 0`, bit for bit.
  const temperatureOffset = input.temperatureOffset ?? 0;
  const thermal = terrainThermalHeight(elevation, temperatureOffset);
  const snowHeight = terrainSnowlineThermalHeight(elevation, temperatureOffset);

  // The snowline descends with the season; the reference day leaves it exactly
  // where Phase 3 tuned it.
  const snowline = SNOWLINE_REFERENCE_METERS
    + input.seasonalTemperatureShift * METERS_PER_NORMALIZED_TEMPERATURE
    // Equator-facing slopes hold less snow, pole-facing more: ±90 m, the same
    // aspect strength the treeline uses.
    + aspect * 90;

  // The beach band is METRES of elevation, not tens of them. At
  // `smoothstep(-1, 9, ...)` every coastal plain up to ~9 m classified as
  // sand — measured against a real seed, a forested plain came out a desert.
  // 3 m matches the density field's own shoreline gate
  // (`smoothstep(1.5, 7, elevation)`), so the ground and the plants agree
  // about where the beach ends.
  //
  // Tropical coast: a wider beach, up to a ~6 m ridge, where the province is
  // hot and wet (`tropicalCoastWeight`). Exactly `3 + 0` outside the tropics.
  const tropical = tropicalCoastWeight(temperatureOffset, input.dryness ?? 0);
  const shore = smoothstep(-1, 3 + TROPICAL_COAST.beachExtraMeters * tropical, elevation);
  const dry = 1 - smoothstep(0.28, 0.62, wetness);
  const wet = smoothstep(0.3, 0.64, wetness);
  const warm = smoothstep(0.16, 0.34, temperature);
  // `6-13`: ONE partition of the slope axis, hinged on the angle of repose.
  //
  // These two terms describe the SAME physical transition — ground that holds
  // soil versus ground that sheds it — so they must be complementary. They
  // were not: `gentle` reached its half-value at slope 0.16 and `steep` at
  // 0.41, a quarter of the axis apart, and BOTH sat in their flat tails across
  // 0.24-0.26. Measured there: gentle 0.0086, steep 0.0016. Every climatic
  // material collapsed to ~0 in that band and `Sand`'s constant `+0.02` floor
  // won by default — 270 of 13,685 land probes, at exactly 0.02, every one in
  // slope 0.24-0.27.
  //
  // That hole was invisible only because `ForestFloor` was ungated on canopy
  // (see below) and its `1.1 * wet` filled it everywhere, at the cost of
  // painting forest litter across treeless lowland. The two defects are one:
  // fixing either alone trades brown camo for inland sand.
  //
  // The partition is anchored on `steep`, and which term anchors it is the
  // whole decision. Hinging both on the documented angle of repose (~0.21,
  // this file's own `slope` docblock) is tidier in isolation and was tried
  // first — but `Rock` is `steep * 1.25`, a coefficient calibrated against
  // steep's EXISTING window, so recentring that window silently re-tunes Rock.
  // Measured over 13,685 land probes: the repose hinge closed the hole and
  // took Rock from 18.77% to 35.40% of land, trading a camo defect for a grey
  // world. Anchoring on `steep` instead closes the hole just as well
  // (worst-case suitability 0.5217 vs 0.5316) and leaves Rock at 18.93% —
  // a 0.16 pp move.
  //
  // So: `steep` keeps the window its calibrated consumer was tuned against,
  // and `gentle` — which never meant anything but "not steep" — becomes its
  // exact complement instead of a second window free to drift away from it.
  // `gentle + steep === 1` at every slope, so the gap cannot reopen.
  const steep = smoothstep(0.24, 0.58, slope);
  const gentle = 1 - steep;
  const alpine = smoothstep(420, 980, thermal);
  const lowland = 1 - smoothstep(320, 900, thermal);
  const airfield = saturate(airportInfluence);

  // THE ALPINE COVER PARTITION ("item C").
  //
  // **The defect: above ~900 m no vegetated material had any suitability on
  // gentle ground, so tall mountains rendered grey from base to summit.**
  // `Grass` and `DryGrass` carry `lowland` (dead by 900 m) and `warm`; `Shrub`
  // dies over 1,150-1,650 m; and `Rock` was `steep * 1.25 + alpine * 0.55` —
  // 0.55 on perfectly FLAT alpine ground, an altitude-only claim that needs no
  // slope at all. The owner's reference photograph shows the opposite law:
  // light fractured rock ONLY on steep faces, sward on every gentler slope
  // right up to the rock, and scree aprons below the faces.
  //
  // Three terms repair it, and **every one of them is multiplied by `alpine`**.
  // That is the invariant this block owns, and
  // `tests/render.webgpu-land-cover-alpine-partition.test.ts` proves it
  // against a frozen copy of the shipped arithmetic: `alpine` is EXACTLY 0 at
  // and below 420 m, each new term is then `x + 0`, and IEEE `x + 0 === x`, so
  // every suitability at or below 420 m is BIT-IDENTICAL to the shipped law.
  // Nothing here can move a lowland pixel, the airfield, the shore band or the
  // unclaimed-ground regime (which is cold + gentle + LOW by definition).
  //
  // None of the three is an additive constant. This file has been burned
  // twice by a constant acting as a universal gain (`Sand + 0.02`, then
  // `Grass + 0.02`); these are gated products like every other claim, and
  // they are zero wherever their gates are.
  //
  // 1. ALPINE TURF: the sward's claim on gentle high ground that is below the
  //    seasonal snow band and not too cold. `cool` is deliberately a LOWER
  //    window than `warm` (0.00-0.12 against 0.16-0.34): alpine turf tolerates
  //    cold that lowland sward does not. `snowBand` hands the ground to Snow
  //    below the snowline rather than at it, and rides the SAME seasonal and
  //    aspect-shifted `snowline` the Snow term reads, so winter lowers both
  //    together. Falling edges are `1 - smoothstep(lo, hi, x)`, never a
  //    reversed-argument smoothstep.
  // 2. ROCK NEEDS SLOPE AT ALTITUDE: see the Rock term.
  // 3. SCREE APRONS: see the Gravel term.
  // The tundra partition's turf gate (1): `cool + 0` in the temperate core.
  const tundra = tundraShare(temperatureOffset);
  const coolTemperate = smoothstep(0, 0.12, temperature);
  const cool = coolTemperate + (1 - coolTemperate) * tundra;
  const snowBand = smoothstep(snowline - 260, snowline - 40, snowHeight);
  // Turf has its OWN slope window, not `gentle`: `gentle` is still 0.5 at 54
  // degrees (steep's calibrated window), and measured with it turf reached
  // 45-50 degree ground. A sward holds to about 35 degrees and is gone by 47.
  const turfSlope = 1 - smoothstep(0.16, 0.32, slope);
  const alpineTurf = shore * alpine * turfSlope * cool * (1 - snowBand);
  // A smooth bump over slope centred on the angle of repose (the first cut's
  // 0.11-0.17 / 0.24-0.32 window measured its peak in the 35-45 degree band, too
  // steep for loose debris, so it moved down): 0.13 is ~30 deg,
  // 0.21 is ~38 deg. Loose debris rests here; gentler ground holds soil and
  // steeper ground sheds the debris onto this band.
  const screeBand = smoothstep(0.085, 0.145, slope) * (1 - smoothstep(0.2, 0.27, slope));

  // THE HIGH DESERT (sagebrush steppe). Every term below is multiplied by
  // `arid`, which is exactly 0 outside a dry province, so the temperate law is
  // bit-identical there: additive claims are `x + 0` and the two damping
  // factors are `x * 1`. See `landCoverDryProvinceTerms` for the shapes.
  const desert = landCoverDryProvinceTerms(input.dryness ?? 0, slope, wetness, DRY_TERMS_SCRATCH);

  const closure = saturate(input.canopyClosure ?? 0);
  /**
   * `6-13`: OMISSION IS NOT ZERO CLOSURE, and the gate below is the first term
   * for which the difference matters.
   *
   * `?? 0` makes "this ground has no canopy" and "nobody told me about canopy"
   * arrive as the same value. That was harmless while closure was a GAIN —
   * `(1 + 0 * GAIN)` is 1.0, which is exactly what preserves the `6-8`
   * invariant this file's own docblock promises: an omitting caller keeps its
   * pre-6-8 classification. As a GATE the two cases diverge completely, and
   * all three CPU callers omit the field — `GroundCoverSystem`,
   * `detail/generation` and `world/terrain`, the last of which feeds
   * `BIOME_FOR_DOMINANT_MATERIAL`. Gating on the merged value would have made
   * the FOREST biome unreachable on the CPU path: a world-classification
   * regression, not a rendering one, and silent.
   *
   * So the gate applies only where closure was actually supplied. The GPU
   * splat bake always supplies it (`input.canopyClosure = canopy.x`), and it
   * is the only consumer that knows where canopy stands, so it is the only
   * one that gets gated.
   */
  const closureGate = input.canopyClosure === undefined
    ? 1
    : closure * (1 + LAND_COVER_CANOPY_CLOSURE_GAIN);
  const sward = saturate(input.grassCover ?? 0);

  const suitability = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  // Sand: the shore band, and only where it is not steep.
  //
  // **~~THE FLOOR MOVED TO GRASS, and that is the whole of Jason's "brown/grey
  // strips" report.~~ STRUCK 2026-09-02 — FALSE OF THE PRODUCT, on two counts,
  // and the second was only found by testing it.**
  //
  // **Count one: it shipped into one of two classifiers.** This file carries a
  // TypeScript law and a WGSL twin, and `0608fed` moved the floor on the CPU
  // side alone; the twin kept `Sand = (1 - shore) * gentle * 1.35 + 0.02` with
  // no floor on Grass. The twin is what paints the ground the player sees, so
  // for that whole period the fix was not in the shipped product at all.
  //
  // **Count two: mirroring the fix into the twin does not move the bake.**
  // Measured, rather than reasoned about:
  //
  // ```
  //   before   bake Sand 1.8%   cpu-vs-bake disagreement 1.26%
  //   after    bake Sand 1.8%   cpu-vs-bake disagreement 1.23%
  // ```
  //
  // With a positive control proving the edit reaches the compiled shader:
  // forcing the Sand term to `0.0` made Sand vanish entirely and took Grass to
  // 53.9%. **So the floor is not what paints the Sand, in either
  // implementation, and this block does not explain the strips.** The cause is
  // open. Do not let this docblock end anyone's search.
  //
  // **THREE SWEEPS AGREED WITH THIS SENTENCE BEFORE ANYONE TESTED IT.** The
  // original validation ran 26,460 synthetic classifier conditions — the INPUT
  // SPACE, not the world. A later sweep took 5 seeds and 173,393 real land
  // probes with a positive control and found zero ground where the floor
  // decides. Both were sound instruments pointed at the CPU law, which was
  // already fixed; neither asked which of the two classifiers it was sampling
  // or which one paints. And a CPU-side sweep cannot reach this regime even in
  // principle: it needs `ForestFloor` out of the way, `ForestFloor` is gated on
  // `canopyClosure`, and **only the bake supplies closure** (see the
  // `closureGate` note below — the CPU ecology callers omit it, the gate reads
  // 1, and ForestFloor claims the ground Sand would otherwise take).
  // Reproducing the twin's additive `+ 0.02` on CPU inputs moves 0.01% of land.
  //
  // The unclaimed-ground regime is separately guarded, **on the CPU law only**,
  // by `tests/render.webgpu-land-cover-unclaimed-ground.test.ts`: cold ground
  // exists (minimum normalised temperature 0.000 in four of five seeds) but
  // never co-occurs with gentle and low. That contingency is real and worth
  // holding. **It is not a guard on the twin, and a guard on one of two
  // implementations is worth exactly the implementation it reads.**
  //
  // The mechanism below stands as a description of the CLASSIFIER, and is why
  // the floor had to move regardless. This term carried a constant `+ 0.02`
  // while every other
  // class is a pure product, so wherever the others all evaluated below 0.02
  // Sand won — **not because the ground is sandy, but because nothing else
  // claimed it.** An unclaimed-ground default has to be the most ordinary
  // cover, and beach is the least ordinary thing on a temperate lowland.
  //
  // `6-13` already fixed one instance of this in the SLOPE axis, by making
  // `gentle + steep === 1` so the two tails cannot both be flat. The hole
  // stayed open in TEMPERATURE: `warm` gates Grass, ForestFloor and DryGrass;
  // `alpine` gates Shrub and most of Rock; `steep` gates the rest. Below the
  // warm threshold, below the alpine onset, on gentle ground, **all three
  // gates shut at once**. Measured at 200 m on gentle ground: temperature
  // <= 0.16 gave Sand at 0.020, temperature >= 0.18 gave Grass at 0.800 — a
  // 0.02-wide step flipping the entire surface.
  //
  // **~~That is why the artifact is a STRIP rather than a patch.~~ STRUCK — this
  // explains why the classifier WOULD band if it ever entered the regime. It is
  // not evidence that it did, and the world sweep above says it does not.**
  // Terrain
  // temperature varies smoothly, so the threshold traces a contour line across
  // the landscape. A defect that produces bands needs a mechanism that
  // produces contours, and a gate crossing does exactly that.
  //
  // Moving the floor rather than widening a gate is the smaller change: it
  // cannot touch the shore band, which is doing real work at the waterline,
  // and it changes only ground that had no claimant at all.
  suitability[SurfaceMaterial.Sand] = (1 - shore) * gentle * 1.35
    // The desert floor, inland. Off the alpine band, which keeps its own
    // partition (turf, scree, rock) in a dry province too.
    + shore * (1 - alpine) * desert.sand;
  // Grass: the default lowland cover, and what an airfield is mown to. The
  // sward gain rides the CLIMATIC term only — an airfield is mown grass by
  // decree and must not be scaled by whether the wild sward would grow there.
  //
  // Item C adds the alpine-turf share as its OWN summand, outside the sward
  // gain, so the lowland term is left exactly as it shipped. The two windows
  // overlap across 420-900 m and their envelopes SUM there: measured,
  // `lowland + 0.9 * alpine` never exceeds lowland Grass's own 1.0 ceiling and
  // dips to 0.724 at 687 m, so the hand-over is a shallow saddle rather than a
  // second peak. (Before item C that same envelope fell to 0 by 900 m.)
  suitability[SurfaceMaterial.Grass] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65)
      * (1 + sward * LAND_COVER_GRASS_COVER_GAIN) * desert.grassKeep
    + alpineTurf * (0.35 + wet * 0.65) * 0.9
    + airfield * 2.4;
  // The unclaimed-ground floor, moved here from Sand. Grass is what a temperate
  // lowland looks like when no stronger signal applies; beach is not.
  //
  // **A FLOOR, NOT A BONUS — and the difference is measurable.** Written as
  // `+ 0.02` it is a universal gain: Grass beats every rival it was within
  // 0.02 of, anywhere, including ground those rivals legitimately claimed.
  // Measured across 26,460 terrain conditions, the additive form moved
  // DryGrass 6.4% -> 5.4% and Rock 61.7% -> 61.4% on top of the Sand
  // correction it was written for. `Math.max` raises only ground that scored
  // below the floor, which is the ground that had no claimant — the case this
  // exists to serve.
  suitability[SurfaceMaterial.Grass] = Math.max(suitability[SurfaceMaterial.Grass]!, 0.02);
  // Forest floor: wet, warm, below the treeline, off the steepest ground —
  // and, since 6-6, carrying the litter its soil column can actually support.
  // A thin-soiled crest under the same climate is duff-free ground and now
  // classifies that way instead of reading as closed forest floor.
  // `6-13`: closure is a GATE, not a gain.
  //
  // It was `(1 + closure * GAIN)`, which is 1.0 at closure 0 — so ForestFloor
  // kept its full `1.1` base on ground with no canopy at all and beat Grass's
  // ceiling of 1.0 by a permanent 0.100 on every wet lowland. Forest litter
  // was painted where there is no forest: measured 57.7% of land dominant,
  // against Grass's 13.3%, in a frame with 0.171% tree pixels.
  //
  // Litter exists BECAUSE a canopy drops it, so the term belongs to closure
  // rather than merely benefiting from it. `(1 + GAIN)` preserves the value a
  // CLOSED canopy sees today, so the `1.1` base and the gain constant carry
  // their existing meaning unchanged — only open ground moves.
  suitability[SurfaceMaterial.ForestFloor] =
    shore * wet * warm * (1 - smoothstep(900, 1_350, thermal)) * (1 - steep * 0.8) * 1.1
    * (1 + landCoverLitter(input) * LAND_COVER_FOREST_FLOOR_LITTER_GAIN)
    * closureGate;
  // Shrub: the highland band — drier, cooler, tolerant of slope. The tundra
  // partition (3) lifts its altitude cut toward the heath floor.
  const heathCut = 1 - smoothstep(1_150, 1_650, thermal);
  suitability[SurfaceMaterial.Shrub] =
    shore * alpine * (heathCut + Math.max(0, TUNDRA_HEATH_CUT_FLOOR - heathCut) * tundra)
      * (0.4 + dry * 0.6) * 0.95
    // Sagebrush: the desert's shrub band reaches down to the basin floors.
    + shore * heathCut * desert.shrub;
  // Rock: slope first, altitude second. A cliff is rock at any height.
  //
  // Item C: ROCK NEEDS SLOPE AT ALTITUDE. The altitude share was a flat
  // `alpine * 0.55`, which claimed perfectly level alpine ground at 0.55 and
  // is most of why a mountain read grey on its meadows. It is now
  // `alpine * (0.25 + 0.30 * smoothstep(0.10, 0.30, slope))`: the same 0.55 by
  // slope 0.30, but only 0.25 on the flat. `steep * 1.25` and steep's
  // `smoothstep(0.24, 0.58, slope)` window are NOT touched — the coefficient
  // is calibrated against that exact window (see the `6-13` note above: moving
  // the window took Rock from 18.77% to 35.40% of land).
  //
  // The tundra partition (2): the FLAT claim gives up `TUNDRA_FLAT_ROCK_LOSS`
  // of its 0.25, and the slope share stays. Written as a subtraction so item
  // C's own product stays as calibrated: `- 0` in the temperate core.
  suitability[SurfaceMaterial.Rock] =
    shore * (
      steep * 1.25 + alpine * (0.25 + 0.30 * smoothstep(0.10, 0.30, slope))
        - alpine * 0.25 * tundra * TUNDRA_FLAT_ROCK_LOSS
    )
    + shore * desert.rock;
  // Snow: above the seasonal snowline, and shed by steep faces. M-3: shed over
  // 39-55 degrees, where it was 60-72. Dry snow avalanches off anything much
  // past 40, and at the old threshold a snowfield on the reshaped massifs showed
  // no rock at all. This is the ONE M-3 term that acts at every altitude.
  suitability[SurfaceMaterial.Snow] =
    smoothstep(snowline - 90, snowline + 130, snowHeight)
    * (1 - smoothstep(0.22, 0.42, slope))
    * 1.5;
  // Dry grass: the rain-shadow companion to grass, off the ecotone chain.
  // Item C: the dry half of the alpine turf, as its own summand for the same
  // reason Grass's is.
  suitability[SurfaceMaterial.DryGrass] =
    shore * lowland * gentle * dry * warm * 0.8 * (1 + sward * LAND_COVER_GRASS_COVER_GAIN)
      * desert.dryGrassKeep
    + alpineTurf * dry * 0.95;
  // Gravel: scree below cliffs and the wave-washed band above sand.
  //
  // Item C: SCREE APRONS. Gravel's altitude share was `alpine * 0.2`, which
  // never won anything — scree did not exist as a dominant cover. It gains
  // `alpine * screeBand * (0.5 + dry * 0.5) * 0.85`: a claim confined to the
  // repose-angle band, stronger where the ground is dry (wet repose-angle
  // ground holds turf instead, which is the mosaic the reference shows).
  // A tropical beach is sand to the waterline: its wave-washed band fades
  // with the tropical weight (`* 1` elsewhere).
  suitability[SurfaceMaterial.Gravel] =
    shore * (
      steep * 0.35 + (1 - shore) * 0.4 * (1 - tropical) + alpine * 0.2
      + alpine * screeBand * (0.5 + dry * 0.5) * 0.85
    )
    + shore * desert.gravel;
  // The paved materials are never climatic: `3-9`'s airport SDF paints them.
  suitability[SurfaceMaterial.Asphalt] = 0;
  suitability[SurfaceMaterial.Concrete] = 0;
  // Sand seas override the climate: see `landCoverSandCoverTerms`.
  const sandCover = input.sandCover ?? 0;
  if (sandCover > 0) {
    const sand = landCoverSandCoverTerms(sandCover, slope);
    suitability[SurfaceMaterial.Sand] = suitability[SurfaceMaterial.Sand]! + sand.sand;
    suitability[SurfaceMaterial.Grass] = suitability[SurfaceMaterial.Grass]! * sand.vegetation;
    suitability[SurfaceMaterial.ForestFloor] =
      suitability[SurfaceMaterial.ForestFloor]! * sand.vegetation;
    suitability[SurfaceMaterial.Shrub] = suitability[SurfaceMaterial.Shrub]! * sand.vegetation;
    suitability[SurfaceMaterial.DryGrass] =
      suitability[SurfaceMaterial.DryGrass]! * sand.vegetation;
    suitability[SurfaceMaterial.Rock] = suitability[SurfaceMaterial.Rock]! * sand.stone;
    suitability[SurfaceMaterial.Gravel] = suitability[SurfaceMaterial.Gravel]! * sand.stone;
  }
  // Nor is volcanic ground: only the volcanic inputs claim it.
  suitability[SurfaceMaterial.Basalt] = 0;
  suitability[SurfaceMaterial.Tephra] = 0;
  // VOLCANIC LAND: every term below is inside this branch, so ground with no
  // volcanic cover runs exactly the arithmetic it ran before (and the softmax
  // leaves Basalt and Tephra out; see classifyLandCover).
  if (landCoverIsVolcanic(input)) {
    applyVolcanicGround(input, suitability, slope, wet, shore);
  }
  return suitability;
}

/**
 * The volcanic rules (see `LAND_COVER_VOLCANIC_FRESH_AGE` for the law in
 * words), applied over the climatic suitabilities in place.
 *
 * Everything is a product with the volcanic share, so as the cover falls to 0
 * every suitability returns continuously to its climatic value and the two
 * volcanic claims to 0: a footprint's edge is an ecotone like any other.
 */
function applyVolcanicGround(
  input: LandCoverInput,
  suitability: number[],
  slope: number,
  wet: number,
  shore: number,
): void {
  const lava = saturate(input.lavaCover ?? 0);
  const tephra = saturate(input.tephraCover ?? 0);
  const age = saturate(input.volcanicAge ?? 0);
  const share = saturate(lava + tephra);
  const fresh = 1 - smoothstep(LAND_COVER_VOLCANIC_FRESH_AGE[0], LAND_COVER_VOLCANIC_FRESH_AGE[1], age);
  const old = smoothstep(LAND_COVER_VOLCANIC_OLD_AGE[0], LAND_COVER_VOLCANIC_OLD_AGE[1], age);
  const middle = saturate(1 - fresh - old);
  const bare = 1 - landCoverVolcanicColonisation(age, wet);
  // The climate's cover keeps what the bare rock does not take.
  const keep = 1 - share * bare;
  // Black sand: the shoreline's Sand score hands over to Tephra.
  const shoreSand = suitability[SurfaceMaterial.Sand]!;
  suitability[SurfaceMaterial.Sand] = shoreSand * (1 - share);
  // Pioneers on moist middle-aged ground; none on dry, none on fresh.
  const pioneer = share * middle * wet * shore;
  suitability[SurfaceMaterial.Grass] = suitability[SurfaceMaterial.Grass]! * keep
    + pioneer * LAND_COVER_VOLCANIC_PIONEER_GRASS;
  suitability[SurfaceMaterial.Shrub] = suitability[SurfaceMaterial.Shrub]! * keep
    + pioneer * LAND_COVER_VOLCANIC_PIONEER_SHRUB;
  // Old ground is fertile: forest where the climate grows forest.
  suitability[SurfaceMaterial.ForestFloor] = suitability[SurfaceMaterial.ForestFloor]! * keep
    * (1 + share * old * LAND_COVER_VOLCANIC_FERTILITY_GAIN);
  suitability[SurfaceMaterial.DryGrass] = suitability[SurfaceMaterial.DryGrass]! * keep;
  suitability[SurfaceMaterial.Gravel] = suitability[SurfaceMaterial.Gravel]! * keep;
  // Tephra holds its angle of repose; above it the cone is Rock.
  const repose = 1 - smoothstep(
    LAND_COVER_TEPHRA_REPOSE_SLOPE - LAND_COVER_TEPHRA_REPOSE_HALF_WIDTH,
    LAND_COVER_TEPHRA_REPOSE_SLOPE + LAND_COVER_TEPHRA_REPOSE_HALF_WIDTH,
    slope,
  );
  const tephraClaim = tephra * bare * LAND_COVER_TEPHRA_GAIN;
  suitability[SurfaceMaterial.Basalt] = lava * bare * LAND_COVER_BASALT_GAIN;
  suitability[SurfaceMaterial.Tephra] = tephraClaim * repose + shoreSand * share;
  suitability[SurfaceMaterial.Rock] = suitability[SurfaceMaterial.Rock]!
    + tephraClaim * (1 - repose)
    + lava * old * smoothstep(LAND_COVER_VOLCANIC_FRONT_SLOPE[0], LAND_COVER_VOLCANIC_FRONT_SLOPE[1], slope)
      * LAND_COVER_VOLCANIC_FRONT_GAIN;
}

/**
 * Per-point softmax temperature.
 *
 * Perturbing the TEMPERATURE rather than the outputs is what makes ecotone
 * SHARPNESS vary: a wet, flat boundary blends over a hundred metres and a
 * steep dry one changes in ten. Perturbing the weights afterwards would only
 * add noise to a boundary whose shape was already uniform.
 */
export function landCoverSoftmaxTemperature(input: LandCoverInput): number {
  const sharpening = saturate(input.slope * 2.4) * 0.6
    + (1 - landCoverWetness(input)) * 0.25;
  return LAND_COVER_SOFTMAX_BASE_TEMPERATURE * (1.35 - sharpening);
}

/**
 * Classify a point: softmax the suitabilities, keep the top four, renormalise.
 *
 * Top-4 rather than all ten because that is what the atlas stores and what
 * `heightBlendMaxMaterials` caps the shader at; keeping a tail of 1e-3 weights
 * would cost samples for cover nobody can see.
 */
export function classifyLandCover(input: LandCoverInput): LandCoverWeights {
  const suitability = landCoverSuitabilities(input);
  // Volcanic land: off volcanic ground the two volcanic suitabilities are not
  // in the softmax at all — not as zeros, absent — so every weight is the one
  // the ten-material classifier produced, bit for bit.
  if (!landCoverIsVolcanic(input)) suitability.length = SURFACE_MATERIAL_BASE_COUNT;
  const temperature = Math.max(0.02, landCoverSoftmaxTemperature(input));
  let peak = -Infinity;
  for (const value of suitability) peak = Math.max(peak, value);
  const exponentials = suitability.map((value) => Math.exp((value - peak) / temperature));

  const order = exponentials
    .map((value, id) => ({ id: id as SurfaceMaterialId, value }))
    .sort((first, second) => second.value - first.value)
    .slice(0, LAND_COVER_TOP_MATERIALS);
  const total = order.reduce((sum, entry) => sum + entry.value, 0);
  return {
    ids: order.map((entry) => entry.id),
    weights: order.map((entry) => (total > 0 ? entry.value / total : 0)),
  };
}

/** The dominant material — the nearest thing this file has to the old biome id. */
export function dominantLandCover(weights: LandCoverWeights): SurfaceMaterialId {
  return weights.ids[0] ?? SurfaceMaterial.Grass;
}

/** Weight of one material in a classification, or 0 if it did not survive. */
export function landCoverWeightOf(
  weights: LandCoverWeights,
  material: SurfaceMaterialId,
): number {
  const index = weights.ids.indexOf(material);
  return index >= 0 ? (weights.weights[index] ?? 0) : 0;
}

/**
 * One categorical material basis shared by the two resident season buckets.
 *
 * The atlas has one id texture and two weight textures. Storing the low
 * season's ids beside the high season's independently ordered weights assigns
 * those weights to the wrong materials as soon as (for example) snow enters
 * winter's top four. Select a joint basis by each material's strongest share
 * in either bucket, then project and renormalise both buckets onto it. The GPU
 * bake below mirrors this function exactly.
 */
export interface SeasonalLandCoverWeights {
  readonly ids: readonly SurfaceMaterialId[];
  readonly lowWeights: readonly number[];
  readonly highWeights: readonly number[];
}

export function alignSeasonalLandCoverWeights(
  low: LandCoverWeights,
  high: LandCoverWeights,
): SeasonalLandCoverWeights {
  const lowByMaterial = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  const highByMaterial = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  for (let slot = 0; slot < LAND_COVER_TOP_MATERIALS; slot += 1) {
    const lowId = low.ids[slot];
    const highId = high.ids[slot];
    if (lowId !== undefined) {
      lowByMaterial[lowId] = lowByMaterial[lowId]! + (low.weights[slot] ?? 0);
    }
    if (highId !== undefined) {
      highByMaterial[highId] = highByMaterial[highId]! + (high.weights[slot] ?? 0);
    }
  }

  const scores = lowByMaterial.map((weight, id) => Math.max(weight, highByMaterial[id]!));
  const ids: SurfaceMaterialId[] = [];
  for (let slot = 0; slot < LAND_COVER_TOP_MATERIALS; slot += 1) {
    let bestIndex = 0;
    let bestValue = -1;
    for (let id = 0; id < SURFACE_MATERIAL_COUNT; id += 1) {
      if (scores[id]! > bestValue) {
        bestIndex = id;
        bestValue = scores[id]!;
      }
    }
    scores[bestIndex] = -1;
    ids.push(bestIndex as SurfaceMaterialId);
  }

  const project = (source: readonly number[]): number[] => {
    const projected = ids.map((id) => source[id] ?? 0);
    const total = projected.reduce((sum, weight) => sum + weight, 0);
    return total > 0 ? projected.map((weight) => weight / total) : projected;
  };
  return {
    ids,
    lowWeights: project(lowByMaterial),
    highWeights: project(highByMaterial),
  };
}

/**
 * `R-27`'s consumers contract, as data.
 *
 * `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat rules all
 * read THIS — the classifier's weight vector — rather than each deciding for
 * itself what "forest" means. The canopy share is the forest-floor weight; the
 * open share is grass plus dry grass; the barren share is rock plus gravel
 * plus snow plus bare volcanic ground. One number each, and they sum with the
 * shrub weight to 1.
 */
export interface LandCoverHabitat {
  readonly canopy: number;
  readonly open: number;
  readonly scrub: number;
  readonly barren: number;
  readonly shore: number;
}

export function landCoverHabitat(weights: LandCoverWeights): LandCoverHabitat {
  return {
    canopy: landCoverWeightOf(weights, SurfaceMaterial.ForestFloor),
    open: landCoverWeightOf(weights, SurfaceMaterial.Grass)
      + landCoverWeightOf(weights, SurfaceMaterial.DryGrass),
    scrub: landCoverWeightOf(weights, SurfaceMaterial.Shrub),
    barren: landCoverWeightOf(weights, SurfaceMaterial.Rock)
      + landCoverWeightOf(weights, SurfaceMaterial.Gravel)
      + landCoverWeightOf(weights, SurfaceMaterial.Snow)
      + landCoverWeightOf(weights, SurfaceMaterial.Basalt)
      + landCoverWeightOf(weights, SurfaceMaterial.Tephra),
    shore: landCoverWeightOf(weights, SurfaceMaterial.Sand),
  };
}

// ---------------------------------------------------------------------------
// The WGSL half
// ---------------------------------------------------------------------------

/**
 * An injected constant that is a valid WGSL float literal for every value.
 *
 * `${8}.0` is fine and `${8.5}.0` is `8.5.0`, which is a compile error found
 * only on a real adapter. Every constant this include injects goes through
 * here so a future retune of one of them cannot break the shader silently.
 */
function wgslConstant(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** One `LAND_COVER_DRY_PROVINCE` constant as a WGSL literal: one table, both twins. */
function dry(name: keyof typeof LAND_COVER_DRY_PROVINCE): string {
  return wgslConstant(LAND_COVER_DRY_PROVINCE[name]);
}

/**
 * The same ten functions, transliterated.
 *
 * Emitted from this file so a change to a suitability moves both halves at
 * once. The parity test compares them point for point on a real adapter, which
 * is the only thing that makes "one authority" true rather than aspirational.
 *
 * Requires `kSaturate` and `kSmoothstep` from the terrain kernel include.
 */
export const LAND_COVER_CLASSIFIER_WGSL = /* wgsl */ `
struct LandCoverInput {
  elevationMeters: f32,
  slope: f32,
  flowAccumulationAreaM2: f32,
  flowAccumulationValid: f32,
  // 6-6: metres of soil, plus its own zero-sentinel companion. Soil depth is
  // strictly positive wherever hydrology ran but quantises to 0 on the very
  // steepest faces, so the value alone cannot carry validity — the flag does.
  soilDepthMeters: f32,
  soilDepthValid: f32,
  // 6-8: the canopy seams. Both exist in ANALYTIC worlds too — a canopy is a
  // vegetation property, not an erosion product — so neither carries a
  // zero-sentinel companion. Zero is a real answer here (open ground), and the
  // bake always supplies a real value.
  canopyClosure: f32,
  grassCover: f32,
  moisture: f32,
  temperature: f32,
  aspect: f32,
  airportInfluence: f32,
  dayOfYear: f32,
  seasonalTemperatureShift: f32,
  // Climate provinces: the raw offsets, exactly 0 in the temperate core. The
  // temperature and moisture above already include them; these drive thermal
  // height and the real-drainage wetness. See the TS twin.
  temperatureOffset: f32,
  dryness: f32,
  // Sand seas: the landform sand cover, 0 off the sand seas. See the TS twin.
  sandCover: f32,
  // Volcanic land: lava and tephra cover and the age, all exactly 0 outside a
  // footprint. With both covers 0 the two volcanic suitabilities stay out of
  // the softmax, as in the TS twin.
  lavaCover: f32,
  tephraCover: f32,
  volcanicAge: f32,
};
${COLD_BIOME_WGSL}
const LAND_COVER_COUNT: u32 = ${SURFACE_MATERIAL_COUNT}u;
const LAND_COVER_BASE_COUNT: u32 = ${SURFACE_MATERIAL_BASE_COUNT}u;
const LAND_COVER_TOP: u32 = ${LAND_COVER_TOP_MATERIALS}u;
const LAND_COVER_SOFTMAX_BASE: f32 = ${LAND_COVER_SOFTMAX_BASE_TEMPERATURE};
const LAND_COVER_SNOWLINE_REFERENCE: f32 = ${SNOWLINE_REFERENCE_METERS}.0;
const LAND_COVER_METERS_PER_TEMPERATURE: f32 = ${METERS_PER_NORMALIZED_TEMPERATURE}.0;
const LAND_COVER_SOIL_LITTER_THIN: f32 = ${wgslConstant(SOIL_LITTER_THIN_METERS)};
const LAND_COVER_SOIL_LITTER_DEEP: f32 = ${wgslConstant(SOIL_LITTER_DEEP_METERS)};
const LAND_COVER_FLOOR_LITTER_GAIN: f32 = ${
  wgslConstant(LAND_COVER_FOREST_FLOOR_LITTER_GAIN)
};
const LAND_COVER_CLOSURE_GAIN: f32 = ${wgslConstant(LAND_COVER_CANOPY_CLOSURE_GAIN)};
const LAND_COVER_SWARD_GAIN: f32 = ${wgslConstant(LAND_COVER_GRASS_COVER_GAIN)};
const LAND_COVER_DESERT_ONSET: f32 = ${wgslConstant(DRY_PROVINCE_DESERT_ONSET)};
const LAND_COVER_DESERT_FULL: f32 = ${wgslConstant(DRY_PROVINCE_DESERT_FULL)};
const LAND_COVER_PARKLAND_ONSET: f32 = ${wgslConstant(DRY_PROVINCE_PARKLAND_ONSET)};
const LAND_COVER_PARKLAND_FULL: f32 = ${wgslConstant(DRY_PROVINCE_PARKLAND_FULL)};
const LAND_COVER_THERMAL_METERS: f32 = ${wgslConstant(CLIMATE_PROVINCE_METERS_PER_TEMPERATURE)};
const LAND_COVER_SNOWLINE_THERMAL_METERS: f32 = ${
  wgslConstant(CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE)
};
const LAND_COVER_TUNDRA_FLAT_ROCK_LOSS: f32 = ${wgslConstant(TUNDRA_FLAT_ROCK_LOSS)};
const LAND_COVER_TUNDRA_HEATH_CUT_FLOOR: f32 = ${wgslConstant(TUNDRA_HEATH_CUT_FLOOR)};
const LAND_COVER_SAND_COVER_GAIN: f32 = ${wgslConstant(LAND_COVER_SAND_COVER_GAIN)};
const LAND_COVER_SAND_SLOPE_LOW: f32 = ${wgslConstant(LAND_COVER_SAND_SLOPE_LOW)};
const LAND_COVER_SAND_SLOPE_HIGH: f32 = ${wgslConstant(LAND_COVER_SAND_SLOPE_HIGH)};

/** Transliteration of densityField.ts's soilLitterFactor, injected constants. */
fn landCoverLitter(input: LandCoverInput) -> f32 {
  if (input.soilDepthValid < 0.5) { return 0.0; }
  return kSmoothstep(
    LAND_COVER_SOIL_LITTER_THIN,
    LAND_COVER_SOIL_LITTER_DEEP,
    input.soilDepthMeters,
  );
}

fn landCoverWetness(input: LandCoverInput) -> f32 {
  if (input.flowAccumulationValid < 0.5) { return kSaturate(input.moisture); }
  let normalY = max(0.000001, 1.0 - input.slope);
  let tanSlope = sqrt(max(0.0, 1.0 / (normalY * normalY) - 1.0));
  let twi = log(
    (1.0 + max(0.0, input.flowAccumulationAreaM2))
      / (tanSlope + ${TERRAIN_TWI_SLOPE_EPSILON}),
  );
  let mapped = kSaturate((twi - ${TERRAIN_TWI_DRY}.0) / ${TERRAIN_TWI_WET - TERRAIN_TWI_DRY}.0);
  // Climate provinces: real drainage ignores climatic moisture, so the
  // province's dryness is applied here. A zero dryness is m - 0 * k == m.
  return kProvinceDryness(mapped * mapped * (3.0 - 2.0 * mapped), input.dryness);
}

/** Sand seas: (added to Sand, vegetation factor, Rock and Gravel factor). See the TS twin. */
fn landCoverSandCoverTerms(sandCover: f32, slope: f32) -> vec3f {
  let cover = kSaturate(sandCover);
  let dune = cover
    * (1.0 - kSmoothstep(LAND_COVER_SAND_SLOPE_LOW, LAND_COVER_SAND_SLOPE_HIGH, slope));
  return vec3f(dune * LAND_COVER_SAND_COVER_GAIN, 1.0 - cover, 1.0 - dune);
}

struct LandCoverDryProvinceTerms {
  sand: f32,
  shrub: f32,
  gravel: f32,
  rock: f32,
  grassKeep: f32,
  dryGrassKeep: f32,
};

/** The dry provinces' claims, scaled by their shares — see the TS twin. */
fn landCoverDryProvinceTerms(dryness: f32, slope: f32, wetness: f32) -> LandCoverDryProvinceTerms {
  // densityField.ts's dryProvinceShares, injected: the ground and the plants
  // read one pair of shares.
  let arid = kSmoothstep(LAND_COVER_DESERT_ONSET, LAND_COVER_DESERT_FULL, dryness);
  let parkland = kSmoothstep(LAND_COVER_PARKLAND_ONSET, LAND_COVER_PARKLAND_FULL, dryness)
    * (1.0 - arid);
  let flat = 1.0 - kSmoothstep(${dry("flatLow")}, ${dry("flatHigh")}, slope);
  let bare = 1.0 - kSmoothstep(${dry("bareLow")}, ${dry("bareHigh")}, wetness);
  let sageWet = kSmoothstep(${dry("sageLow")}, ${dry("sageHigh")}, wetness);
  let holdsShrub = 1.0 - kSmoothstep(${dry("shrubSlopeLow")}, ${dry("shrubSlopeHigh")}, slope);
  let fan = kSmoothstep(${dry("fanLow")}, ${dry("fanHigh")}, slope)
    * (1.0 - kSmoothstep(${dry("fanFadeLow")}, ${dry("fanFadeHigh")}, slope));
  var terms: LandCoverDryProvinceTerms;
  terms.sand = arid * flat * bare * ${dry("sandGain")};
  terms.shrub = arid * holdsShrub * (${dry("shrubBase")} + sageWet * ${dry("shrubWetGain")});
  terms.gravel = arid * fan * ${dry("gravelGain")};
  terms.rock = arid * kSmoothstep(${dry("rockLow")}, ${dry("rockHigh")}, slope) * ${dry("rockGain")};
  terms.grassKeep = 1.0 - arid * ${dry("desertGrassCut")} - parkland * ${dry("parklandGrassCut")};
  terms.dryGrassKeep = 1.0 - arid * ${dry("desertDryGrassCut")};
  return terms;
}

${TROPICAL_COAST_WGSL}

fn landCoverIsVolcanic(input: LandCoverInput) -> bool {
  return input.lavaCover > 0.0 || input.tephraCover > 0.0;
}

/** Transliteration of landCoverVolcanicColonisation. */
fn landCoverVolcanicColonisation(age: f32, wet: f32) -> f32 {
  let fresh = 1.0 - kSmoothstep(
    ${wgslConstant(LAND_COVER_VOLCANIC_FRESH_AGE[0])}, ${wgslConstant(LAND_COVER_VOLCANIC_FRESH_AGE[1])}, age);
  let old = kSmoothstep(
    ${wgslConstant(LAND_COVER_VOLCANIC_OLD_AGE[0])}, ${wgslConstant(LAND_COVER_VOLCANIC_OLD_AGE[1])}, age);
  let middle = kSaturate(1.0 - fresh - old);
  return kSaturate(middle * wet * ${wgslConstant(LAND_COVER_VOLCANIC_MOIST_COLONISATION)} + old);
}

/** Transliteration of landCoverVolcanicBareShare. */
fn landCoverVolcanicBareShare(input: LandCoverInput) -> f32 {
  if (!landCoverIsVolcanic(input)) { return 0.0; }
  let share = kSaturate(kSaturate(input.lavaCover) + kSaturate(input.tephraCover));
  let wet = kSmoothstep(0.3, 0.64, landCoverWetness(input));
  return share * (1.0 - landCoverVolcanicColonisation(kSaturate(input.volcanicAge), wet));
}

/** Transliteration of applyVolcanicGround, returning the rewritten scores. */
fn landCoverVolcanicGround(
  input: LandCoverInput,
  climatic: array<f32, ${SURFACE_MATERIAL_COUNT}>,
  slope: f32,
  wet: f32,
  shore: f32,
) -> array<f32, ${SURFACE_MATERIAL_COUNT}> {
  var suitability = climatic;
  let lava = kSaturate(input.lavaCover);
  let tephra = kSaturate(input.tephraCover);
  let age = kSaturate(input.volcanicAge);
  let share = kSaturate(lava + tephra);
  let fresh = 1.0 - kSmoothstep(
    ${wgslConstant(LAND_COVER_VOLCANIC_FRESH_AGE[0])}, ${wgslConstant(LAND_COVER_VOLCANIC_FRESH_AGE[1])}, age);
  let old = kSmoothstep(
    ${wgslConstant(LAND_COVER_VOLCANIC_OLD_AGE[0])}, ${wgslConstant(LAND_COVER_VOLCANIC_OLD_AGE[1])}, age);
  let middle = kSaturate(1.0 - fresh - old);
  let bare = 1.0 - landCoverVolcanicColonisation(age, wet);
  let keep = 1.0 - share * bare;
  let shoreSand = suitability[${SurfaceMaterial.Sand}];
  suitability[${SurfaceMaterial.Sand}] = shoreSand * (1.0 - share);
  let pioneer = share * middle * wet * shore;
  suitability[${SurfaceMaterial.Grass}] = suitability[${SurfaceMaterial.Grass}] * keep
    + pioneer * ${wgslConstant(LAND_COVER_VOLCANIC_PIONEER_GRASS)};
  suitability[${SurfaceMaterial.Shrub}] = suitability[${SurfaceMaterial.Shrub}] * keep
    + pioneer * ${wgslConstant(LAND_COVER_VOLCANIC_PIONEER_SHRUB)};
  suitability[${SurfaceMaterial.ForestFloor}] = suitability[${SurfaceMaterial.ForestFloor}] * keep
    * (1.0 + share * old * ${wgslConstant(LAND_COVER_VOLCANIC_FERTILITY_GAIN)});
  suitability[${SurfaceMaterial.DryGrass}] = suitability[${SurfaceMaterial.DryGrass}] * keep;
  suitability[${SurfaceMaterial.Gravel}] = suitability[${SurfaceMaterial.Gravel}] * keep;
  let repose = 1.0 - kSmoothstep(
    ${wgslConstant(LAND_COVER_TEPHRA_REPOSE_SLOPE - LAND_COVER_TEPHRA_REPOSE_HALF_WIDTH)},
    ${wgslConstant(LAND_COVER_TEPHRA_REPOSE_SLOPE + LAND_COVER_TEPHRA_REPOSE_HALF_WIDTH)},
    slope);
  let tephraClaim = tephra * bare * ${wgslConstant(LAND_COVER_TEPHRA_GAIN)};
  suitability[${SurfaceMaterial.Basalt}] = lava * bare * ${wgslConstant(LAND_COVER_BASALT_GAIN)};
  suitability[${SurfaceMaterial.Tephra}] = tephraClaim * repose + shoreSand * share;
  suitability[${SurfaceMaterial.Rock}] = suitability[${SurfaceMaterial.Rock}]
    + tephraClaim * (1.0 - repose)
    + lava * old * kSmoothstep(
      ${wgslConstant(LAND_COVER_VOLCANIC_FRONT_SLOPE[0])}, ${wgslConstant(LAND_COVER_VOLCANIC_FRONT_SLOPE[1])}, slope)
      * ${wgslConstant(LAND_COVER_VOLCANIC_FRONT_GAIN)};
  return suitability;
}

fn landCoverSuitabilities(input: LandCoverInput) -> array<f32, ${SURFACE_MATERIAL_COUNT}> {
  let elevation = input.elevationMeters;
  let slope = input.slope;
  let wetness = landCoverWetness(input);
  // Climate provinces: the altitude bands read thermal height; shore, Sand
  // and the wave-washed band stay on real elevation. See the TS twin.
  let thermal = elevation - input.temperatureOffset * LAND_COVER_THERMAL_METERS;
  let snowHeight = elevation - input.temperatureOffset * LAND_COVER_SNOWLINE_THERMAL_METERS;
  let snowline = LAND_COVER_SNOWLINE_REFERENCE
    + input.seasonalTemperatureShift * LAND_COVER_METERS_PER_TEMPERATURE
    + input.aspect * 90.0;
  // Tropical coast: the wider beach — see the TS twin.
  let tropical = tropicalCoastWeight(input.temperatureOffset, input.dryness);
  let shore = kSmoothstep(-1.0, 3.0 + ${wgslConstant(TROPICAL_COAST.beachExtraMeters)} * tropical, elevation);
  let dry = 1.0 - kSmoothstep(0.28, 0.62, wetness);
  let wet = kSmoothstep(0.3, 0.64, wetness);
  let warm = kSmoothstep(0.16, 0.34, input.temperature);
  // 6-13: one partition, anchored on steep's calibrated window — see TS twin.
  let steep = kSmoothstep(0.24, 0.58, slope);
  let gentle = 1.0 - steep;
  let alpine = kSmoothstep(420.0, 980.0, thermal);
  let lowland = 1.0 - kSmoothstep(320.0, 900.0, thermal);
  let airfield = kSaturate(input.airportInfluence);
  // Item C, the alpine cover partition — see the TS twin. Every new term is
  // multiplied by alpine, which is exactly 0.0 at and below 420 m, so the
  // lowland law is bit-identical to what shipped.
  // The tundra partition — see the TS twin. Exactly x + 0 / x * 1 at share 0.
  let tundra = coldTundraShare(input.temperatureOffset);
  let coolTemperate = kSmoothstep(0.0, 0.12, input.temperature);
  let cool = coolTemperate + (1.0 - coolTemperate) * tundra;
  let snowBand = kSmoothstep(snowline - 260.0, snowline - 40.0, snowHeight);
  let turfSlope = 1.0 - kSmoothstep(0.16, 0.32, slope);
  let alpineTurf = shore * alpine * turfSlope * cool * (1.0 - snowBand);
  let screeBand = kSmoothstep(0.085, 0.145, slope) * (1.0 - kSmoothstep(0.2, 0.27, slope));
  let closure = kSaturate(input.canopyClosure);
  let sward = kSaturate(input.grassCover);
  // The high desert: every term multiplied by arid, exactly 0 outside a dry
  // province, so the temperate law is bit-identical there — see the TS twin.
  let desert = landCoverDryProvinceTerms(input.dryness, slope, wetness);

  var suitability: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  // \`0608fed\` moved the unclaimed-ground floor off Sand and onto Grass in the
  // CPU law above and **was not mirrored here**, leaving the two laws skewed.
  // This repairs that. The CPU side is the reference implementation.
  //
  // **HYGIENE, NOT A CURE — and the distinction is measured.** This changes no
  // pixel today: the bake paints Sand on 1.8% of texels before and after, and
  // the parity disagreement moves 1.26% -> 1.23%. A positive control confirms
  // the edit does reach the compiled shader — forcing this term to 0.0 makes
  // Sand vanish and Grass rise to 53.9% — so the floor genuinely is not what
  // paints it. The floor is inert on real terrain besides: the regime it
  // repairs, every material scoring under 0.02, occurs on 0 of 50,971 land
  // probes across two shipping seeds.
  //
  // It is repaired anyway because the next edit to this region would inherit
  // the skew, and because two laws that are meant to be identical were not.
  // **Do not read this as the fix for the grey-tan strips.** That report is
  // still open, and \`3e4bf32\` strikes the sentence in \`0608fed\` that claimed
  // otherwise.
  suitability[${SurfaceMaterial.Sand}] = (1.0 - shore) * gentle * 1.35
    + shore * (1.0 - alpine) * desert.sand;
  suitability[${SurfaceMaterial.Grass}] =
    shore * lowland * gentle * warm * (0.35 + wet * 0.65)
      * (1.0 + sward * LAND_COVER_SWARD_GAIN) * desert.grassKeep
    + alpineTurf * (0.35 + wet * 0.65) * 0.9
    + airfield * 2.4;
  // A FLOOR, not a bonus: \`max\`, not \`+\`, so it raises only ground that had no
  // claimant instead of giving Grass a universal gain over its rivals.
  suitability[${SurfaceMaterial.Grass}] = max(suitability[${SurfaceMaterial.Grass}], 0.02);
  suitability[${SurfaceMaterial.ForestFloor}] =
    shore * wet * warm * (1.0 - kSmoothstep(900.0, 1350.0, thermal))
      * (1.0 - steep * 0.8) * 1.1
      * (1.0 + landCoverLitter(input) * LAND_COVER_FLOOR_LITTER_GAIN)
      // 6-13: closure GATES the litter rather than gaining it — see TS twin.
      * (closure * (1.0 + LAND_COVER_CLOSURE_GAIN));
  let heathCut = 1.0 - kSmoothstep(1150.0, 1650.0, thermal);
  suitability[${SurfaceMaterial.Shrub}] =
    shore * alpine * (heathCut + max(0.0, LAND_COVER_TUNDRA_HEATH_CUT_FLOOR - heathCut) * tundra)
      * (0.4 + dry * 0.6) * 0.95
    + shore * heathCut * desert.shrub;
  suitability[${SurfaceMaterial.Rock}] =
    shore * (
      steep * 1.25 + alpine * (0.25 + 0.30 * kSmoothstep(0.10, 0.30, slope))
        - alpine * 0.25 * tundra * LAND_COVER_TUNDRA_FLAT_ROCK_LOSS
    )
    + shore * desert.rock;
  suitability[${SurfaceMaterial.Snow}] =
    kSmoothstep(snowline - 90.0, snowline + 130.0, snowHeight)
      * (1.0 - kSmoothstep(0.22, 0.42, slope)) * 1.5;
  suitability[${SurfaceMaterial.DryGrass}] =
    shore * lowland * gentle * dry * warm * 0.8 * (1.0 + sward * LAND_COVER_SWARD_GAIN)
      * desert.dryGrassKeep
    + alpineTurf * dry * 0.95;
  suitability[${SurfaceMaterial.Gravel}] =
    shore * (
      steep * 0.35 + (1.0 - shore) * 0.4 * (1.0 - tropical) + alpine * 0.2
      + alpine * screeBand * (0.5 + dry * 0.5) * 0.85
    )
    + shore * desert.gravel;
  suitability[${SurfaceMaterial.Asphalt}] = 0.0;
  suitability[${SurfaceMaterial.Concrete}] = 0.0;
  // Sand seas: a branch, so every texel off them is the shipped law.
  if (input.sandCover > 0.0) {
    let sand = landCoverSandCoverTerms(input.sandCover, slope);
    suitability[${SurfaceMaterial.Sand}] = suitability[${SurfaceMaterial.Sand}] + sand.x;
    suitability[${SurfaceMaterial.Grass}] = suitability[${SurfaceMaterial.Grass}] * sand.y;
    suitability[${SurfaceMaterial.ForestFloor}] = suitability[${SurfaceMaterial.ForestFloor}] * sand.y;
    suitability[${SurfaceMaterial.Shrub}] = suitability[${SurfaceMaterial.Shrub}] * sand.y;
    suitability[${SurfaceMaterial.DryGrass}] = suitability[${SurfaceMaterial.DryGrass}] * sand.y;
    suitability[${SurfaceMaterial.Rock}] = suitability[${SurfaceMaterial.Rock}] * sand.z;
    suitability[${SurfaceMaterial.Gravel}] = suitability[${SurfaceMaterial.Gravel}] * sand.z;
  }
  suitability[${SurfaceMaterial.Basalt}] = 0.0;
  suitability[${SurfaceMaterial.Tephra}] = 0.0;
  if (landCoverIsVolcanic(input)) {
    return landCoverVolcanicGround(input, suitability, slope, wet, shore);
  }
  return suitability;
}

fn landCoverSoftmaxTemperature(input: LandCoverInput) -> f32 {
  let sharpening = kSaturate(input.slope * 2.4) * 0.6
    + (1.0 - landCoverWetness(input)) * 0.25;
  return LAND_COVER_SOFTMAX_BASE * (1.35 - sharpening);
}

struct LandCoverWeights {
  ids: vec4f,
  weights: vec4f,
};

/** Softmax, top-4 by selection sort, renormalised. */
fn classifyLandCover(input: LandCoverInput) -> LandCoverWeights {
  var suitability = landCoverSuitabilities(input);
  let temperature = max(0.02, landCoverSoftmaxTemperature(input));
  // Volcanic land: off volcanic ground the two volcanic scores stay out of
  // the softmax entirely, as in the TS twin.
  let count = select(LAND_COVER_BASE_COUNT, LAND_COVER_COUNT, landCoverIsVolcanic(input));
  var peak = -1e30;
  for (var index = 0u; index < count; index = index + 1u) {
    peak = max(peak, suitability[index]);
  }
  var exponentials: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < count; index = index + 1u) {
    exponentials[index] = exp((suitability[index] - peak) / temperature);
  }
  var ids = vec4f(0.0);
  var weights = vec4f(0.0);
  var total = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < count; index = index + 1u) {
      if (exponentials[index] > bestValue) {
        bestValue = exponentials[index];
        bestIndex = index;
      }
    }
    exponentials[bestIndex] = -1.0;
    ids[slot] = f32(bestIndex);
    weights[slot] = max(0.0, bestValue);
    total = total + max(0.0, bestValue);
  }
  if (total > 0.0) { weights = weights / total; }
  var result: LandCoverWeights;
  result.ids = ids;
  result.weights = weights;
  return result;
}
`;

// ---------------------------------------------------------------------------
// The page splat bake
// ---------------------------------------------------------------------------

/** Texels a splat bake supersamples per channel texel, per axis. */
export const LAND_COVER_SUPERSAMPLE_EDGE = 2;

/**
 * Channel texel size from which each supersample tap reads its OWN canopy.
 *
 * Closure is band-limited at a fixed 60 m whatever the page level, so inside a
 * texel up to 32 m the four taps (at most 16 m apart) really would read four
 * copies of one number, and the bake samples it once, at the centre. From a
 * 64 m texel up the taps sit 32-128 m apart and that stops being true: closure
 * is a THRESHOLDED function of the 260 m and 130 m glade octaves, so one
 * centre sample per 128 m texel is a binary field sampled near its own
 * Nyquist. Forest floor is gated on it, and from cruise height every forest-
 * floor region had stair-stepped, axis-aligned sides and single-texel
 * rectangular holes (world 1GVEIKQ, 2026-09-20). With a canopy per tap a coarse
 * texel holds the stand's COVERAGE in five steps and bilinear filtering does
 * the rest. Tied to the closure channel's own band limit, not to a level.
 *
 * A coarse tap's moisture and climate are evaluated once and shared by its
 * canopy sample and both of its seasonal classifications, which would
 * otherwise each recompute the same chain at the same point: 5 moisture
 * chains per coarse texel where there would be 13, and 4 climate chains where
 * there would be 8, for the same answer.
 */
export const LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS = CANOPY_CLOSURE_FILTER_WIDTH_METERS;

/**
 * The far desert: what a zero-trust page may say about a dry province.
 *
 * From level 5 (128 m texels) a page is too coarse to trust, and the fragment
 * draws its pair only when both are SWARDS (`FarSwardGate.ts`); any other pair
 * falls back to the continuous Grass base. That is the right rule for a
 * temperate world, where the refused pairs are coasts, cliffs and forest
 * floors under impostor canopy. In a desert it is not: sand, gravel pavement
 * and bare hills are most of the ground, and every one of them is refused, so
 * from a few kilometres out the desert would turn green.
 *
 * So the bake hands a dry province's sand, gravel and rock weight to DryGrass,
 * the nearest sward in colour (tan). The pair the fragment then sees at zero
 * trust is sage and straw, which passes the gate, and the fragment's own slope
 * rock still greys the real faces.
 *
 * **It RAMPS with texel size, linear in level, from none at 16 m texels (L2)
 * to all of it at 128 m (L5).** A switch at L5 alone drew a ring: the
 * partly-trusted levels fade a non-sward pair toward its primary, so a
 * Sand-primary texel stayed pure sand (about 1.8x straw's albedo) through L4
 * and turned straw at L5, a bright edge that followed the aircraft wherever
 * sand was primary. Ramped, each texel's primary flips at its own level (L3
 * moves a third of the weight, L4 two thirds), and the edge breaks into the
 * patches every other level border is. L0-L2, the near pages, keep the
 * desert's real materials. At zero dryness the share is 0 and the bake does
 * not enter the branch, so the temperate bake is untouched.
 */
export const LAND_COVER_FAR_DESERT_START_TEXEL_METERS = 16;
export const LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS = 128;

/** The ramp: 0 at and below 16 m texels, 1 at and above 128 m, linear in level. */
export function landCoverFarDesertRamp(channelTexelMeters: number): number {
  return saturate(
    Math.log2(channelTexelMeters / LAND_COVER_FAR_DESERT_START_TEXEL_METERS)
      / Math.log2(LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS / LAND_COVER_FAR_DESERT_START_TEXEL_METERS),
  );
}

export function landCoverFarDesertWeights(
  weightsByMaterial: readonly number[],
  dryness: number,
  channelTexelMeters: number,
  /**
   * The landform sand cover at the texel. A sand sea is sand at any range, so
   * the share the far desert moves to straw shrinks with it; 0 (no erg, and
   * every texel inside the landform core) leaves the share exactly as it was.
   */
  sandCover = 0,
): number[] {
  const out = [...weightsByMaterial];
  let arid = smoothstep(DRY_PROVINCE_DESERT_ONSET, DRY_PROVINCE_DESERT_FULL, dryness)
    * landCoverFarDesertRamp(channelTexelMeters);
  if (sandCover > 0) arid *= 1 - sandCover;
  if (!(arid > 0)) return out;
  const moved = (out[SurfaceMaterial.Sand]! + out[SurfaceMaterial.Gravel]!
    + out[SurfaceMaterial.Rock]!) * arid;
  out[SurfaceMaterial.Sand] = out[SurfaceMaterial.Sand]! * (1 - arid);
  out[SurfaceMaterial.Gravel] = out[SurfaceMaterial.Gravel]! * (1 - arid);
  out[SurfaceMaterial.Rock] = out[SurfaceMaterial.Rock]! * (1 - arid);
  out[SurfaceMaterial.DryGrass] = out[SurfaceMaterial.DryGrass]! + moved;
  return out;
}

/**
 * The splat bake (`4-6`).
 *
 * **Supersample 2x2 and average the WEIGHT VECTORS, not the argmax.** (What
 * varies across the four taps: position, so slope, moisture and climate, at
 * every level; and the canopy from `LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS` up.
 * Below that the taps share the texel centre's canopy, exactly.) This is
 * the prefiltering that per-vertex point classification structurally cannot
 * do, and it is the albedo analogue of band-limiting: averaging four ids and
 * rounding gives you the id nearest their mean, which at a three-way junction
 * is a material none of the four samples chose. Averaging the vectors gives a
 * mixture, which is what a 2 m texel over a 1 m ecotone actually contains.
 *
 * The season enters HERE and nowhere else: two buckets are baked into the two
 * resident splat slot pairs and cross-faded by `seasonBucketBlend().t`. The
 * classification the ecology reads stays at the reference day.
 *
 * Requires the terrain kernel include (for the moisture and climate chains and
 * `kSmoothstep`/`kSaturate`) and `LAND_COVER_CLASSIFIER_WGSL`.
 */
export const LAND_COVER_SPLAT_BAKE_WGSL = /* wgsl */ `
struct SplatJob {
  // (channel slot texel u, channel slot texel v, height slot texel u,
  //  height slot texel v)
  slots: vec4f,
  // (channel texel size, height texel size, kernel page index, sea level)
  shape: vec4f,
  // (world offset of stored channel texel 0 from the kernel page origin, same
  //  for z, seasonal shift of the LOW bucket, of the HIGH bucket)
  placement: vec4f,
  // (airport influence centre x, centre z, inverse blend radius, day of year)
  airport: vec4f,
  // (sin heading, cos heading, half length + end safety area,
  //  half width + shoulder) — the runway frame and the graded platform's own
  //  half-extents, so the bake can evaluate the SAME rounded-rectangle field
  //  getAirportInfluence does instead of a circle about the centre.
  runway: vec4f,
  // Volcanic land: (1 where the profile carries Basalt and Tephra, 0 where the
  //  bake remaps them — WebGpuQualityProfile.volcanicMaterials — then three
  //  reserved lanes).
  volcanic: vec4f,
};

@group(0) @binding(1) var<storage, read> splatJobs: array<SplatJob>;
@group(0) @binding(2) var splatHeightAtlas: texture_2d<f32>;
@group(0) @binding(3) var splatId: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var splatWeightLo: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var splatWeightHi: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var splatFlowAccumAtlas: texture_2d<f32>;
// 6-6: the soil-depth channel, r8unorm over [0, SOIL_MAX]. Bound in the BAKE,
// not in the surface fragment: litter is a per-page property of the ground, so
// it belongs where the splat is decided rather than costing every fragment a
// sampler slot the 16-per-stage budget has to find.
@group(0) @binding(7) var splatSoilDepthAtlas: texture_2d<f32>;
const SPLAT_SOIL_MAX_METERS: f32 = ${
  wgslConstant(TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters)
};
// 6-8: SPLAT_VEGETATION_LATTICE_BASE is supplied by the COMPOSER, exactly as
// kSaturate and kSmoothstep are. It cannot be injected from here: this file is
// reached from src/world/terrain.ts, so importing the kernel's lattice count
// would close a module cycle (world/terrain -> classifier -> kernel ->
// world/terrain) and every kernel constant would read undefined at load.
//
// Volcanic land: terrainVolcanicGround is supplied by the composer for the
// same reason (the landform include, VolcanicOverlayKernel.ts, over the bound
// site index). bakeSplat samples it ONCE per texel, like
// the climate province, and every tap of both seasons reads that sample. It
// travels in a private var, as the occlusion bake's job index does, so no
// signature between bakeSplat and splatLandCoverInput changes for it.
var<private> splatVolcanicGround: vec3f;

// The landform base terrainVolcanicGround measures from: the selected page's
// origin minus the landform core centre, split hi/lo (xy hi, zw lo), the page
// uniform's landformBase row. All zero in a world without landforms, where the
// placeholder index lists no site and the ground is exactly 0.
fn splatVolcanicBase() -> vec4f {
  return terrainKernelPages[kPageIndex].landformBase;
}

/**
 * Volcanic land on a profile whose arrays carry neither volcanic layer
 * (\`WebGpuQualityProfile.volcanicMaterials\` false): Basalt bakes as Rock and
 * Tephra as Gravel (\`volcanicFallbackMaterial\`), so that tier's ten-layer
 * arrays and ten-case gather never meet an id they lack. Data, not a define:
 * the job lane says which. Every other id passes through, so a profile with
 * the layers, and all ground without volcanic cover, bakes what it baked.
 */
fn splatVolcanicMaterial(job: SplatJob, id: u32) -> u32 {
  if (job.volcanic.x > 0.5) { return id; }
  if (id == ${SurfaceMaterial.Basalt}u) { return ${volcanicFallbackMaterial(SurfaceMaterial.Basalt)}u; }
  if (id == ${SurfaceMaterial.Tephra}u) { return ${volcanicFallbackMaterial(SurfaceMaterial.Tephra)}u; }
  return id;
}

/**
 * Slope and ASPECT from the page's own texel grid — never a fixed 2 m
 * difference. Lane x is normalised steepness, lane y is the density field's
 * aspect term (-1 pole-facing ... +1 equator-facing, faded in with slope).
 *
 * 6-8 needs the aspect lane because the treeline wanders ±120 m with it, and a
 * canopy closure that ignored aspect would put forest on the ground the
 * vegetation path leaves bare. The classifier's own aspect input is
 * deliberately left at 0 - moving it is a separate change with its own pixels.
 */
fn splatSlopeAspect(job: SplatJob, heightTexel: vec2f) -> vec2f {
  // **CENTRAL difference. The forward one it replaces was wrong twice over.**
  //
  // It read \`here\`, \`east\`, \`south\` and divided by one texel: an O(h)
  // estimator where a central difference is O(h^2), with \`h\` the page's own
  // texel — 2 m at L0 but **512 m at L8** — so its error grew with every level.
  // Measured over identical points, the fraction of land it reported at slope
  // >= 0.40 was 1.00x a central difference at 2 m, 1.06x at 8 m, 1.25x at 32 m
  // and **1.95x at 128 m.** At coarse levels it invented nearly twice the steep
  // ground, and steep ground is Rock.
  //
  // **And it was asymmetric.** A forward difference estimates the gradient at
  // \`here + (0.5, 0.5)\` texels, so slope was assigned half a texel toward
  // +x/+z from the texel it painted — **256 m at L8**. That is the same family
  // as the gutter defect fixed below, and this was the second consumer of the
  // convention. Central differencing is centred on the texel by construction.
  //
  // \`WORLD_PAGE_GUTTER\` is 4 texels on every side of a slot, so the -1 reads
  // this adds stay inside stored data for every core texel. One extra tap per
  // axis.
  let base = vec2i(job.slots.zw) + vec2i(heightTexel);
  let west = textureLoad(splatHeightAtlas, base + vec2i(-1, 0), 0).r;
  let east = textureLoad(splatHeightAtlas, base + vec2i(1, 0), 0).r;
  let north = textureLoad(splatHeightAtlas, base + vec2i(0, -1), 0).r;
  let south = textureLoad(splatHeightAtlas, base + vec2i(0, 1), 0).r;
  let gradient = vec2f(east - west, south - north) / (2.0 * job.shape.y);
  let normalY = 1.0 / sqrt(1.0 + dot(gradient, gradient));
  let slope = 1.0 - normalY;
  let horizontal = length(gradient);
  var aspect = 0.0;
  if (horizontal > 1e-6) {
    aspect = (gradient.y / horizontal) * kSmoothstep(0.015, 0.07, slope);
  }
  return vec2f(slope, aspect);
}

fn splatSlopeAt(job: SplatJob, heightTexel: vec2f) -> f32 {
  return splatSlopeAspect(job, heightTexel).x;
}

/**
 * The airport's graded platform, as the ROUNDED RECTANGLE every other consumer
 * keys on: airport.ts's worldToRunway + roundedRectangleSignedDistance +
 * getAirportInfluence, transliterated.
 *
 * It used to be "1 - length(p - centre) / blend": a 240 m DISC about the
 * runway centre, under a comment that already claimed the rounded rectangle.
 * A 1,320 m runway is five times longer than that disc, so the bake read
 * influence 0 over most of its own airfield - measured 0.000 against a true
 * 0.807 at the ground-2m-lowsun camera. That cost the classifier its
 * "airfield * 2.4" mown-grass decree AND left splatCanopy's clearance at 1,
 * so the ground believed a closed stand (0.81 closure, ~590 stems/ha) grew on
 * an apron where the renderer plants ~90/ha. The ground material and the
 * ground SHAPE now read one field.
 *
 * smoothstep(0, blend, d) is exactly smoothstep(0, 1, d/blend), so the job's
 * inverse blend radius carries the whole band and no second constant is
 * needed. With no airport the host writes a centre 1e9 away and a 1 m blend,
 * so the smoothstep saturates and this returns 0. The previous form returned
 * 1 for that case - the whole world as mown airfield - because its inverse
 * blend radius was 0 and the radial term vanished with it.
 */
fn splatAirportInfluence(job: SplatJob, localX: f32, localZ: f32) -> f32 {
  let delta = vec2f(localX, localZ) - job.airport.xy;
  let along = delta.x * job.runway.x + delta.y * job.runway.y;
  let across = delta.x * job.runway.y - delta.y * job.runway.x;
  let q = vec2f(abs(along) - job.runway.z, abs(across) - job.runway.w);
  let platformDistance = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
  return 1.0 - kSmoothstep(0.0, 1.0, platformDistance * job.airport.z);
}

/** The classifier's input at one tap, which splatClassify classifies. */
fn splatLandCoverInput(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  shift: f32,
  // (canopy closure, grass cover, this point's moisture or -1, its climate).
  // A coarse tap arrives with the moisture and climate its canopy sample and
  // its other season already paid for, at this exact point: the same function
  // of the same inputs, so handing them over changes no bit of the answer and
  // saves 8 of a coarse texel's 13 moisture chains and 4 of its 8 climate
  // ones. A fine tap arrives with -1 and evaluates both here, as it always has
  // (moisture is saturated to [0, 1], so -1 cannot be a value).
  tap: vec4f,
  // Climate provinces: (temperature offset, dryness) at the texel centre. The
  // province moves over 60 km and more, so one sample per texel is the field at
  // every tap to within ~1e-3 at the coarsest level, and it is (0, 0) exactly
  // in the temperate core whatever the tap.
  province: vec2f,
  // Landforms: the sand the dunes lay down, at the texel centre (bakeSplat).
  // 0 off every sand sea and inside the landform core.
  sandCover: f32,
) -> LandCoverInput {
  // **The gutter offset is packed in CHANNEL texels and this reads HEIGHT
  // texels.** \`job.placement.xy\` is \`-GUTTER * channelTexel\`, so dividing it by
  // \`shape.y\` over-shifts by \`GUTTER * (channelTexel / heightTexel - 1)\`. The
  // channel texel is twice the height texel, so the read landed a full GUTTER
  // of height texels past the texel being painted: 8 m at L0, **128 m per axis
  // at L4**. Height AND slope both come from this index, so the classification
  // was sampled off the ground it paints, further the coarser the page.
  //
  // Recovering the gutter in texels from the job keeps this correct if the
  // channel/height ratio ever changes: \`GUTTER = -placement.x / channelTexel\`.
  let gutterTexels = -job.placement.x / job.shape.x;
  let heightTexel = vec2f(
    localX / job.shape.y + gutterTexels,
    localZ / job.shape.y + gutterTexels,
  );
  let elevation = textureLoad(
    splatHeightAtlas,
    vec2i(job.slots.zw) + vec2i(heightTexel),
    0,
  ).r - job.shape.w;
  var input: LandCoverInput;
  input.elevationMeters = elevation;
  input.slope = splatSlopeAt(job, heightTexel);
  let channelTexel = vec2i(job.slots.xy) + vec2i(vec2f(
    (localX - job.placement.x) / job.shape.x,
    (localZ - job.placement.y) / job.shape.x,
  ));
  let flowLog2 = max(0.0, textureLoad(splatFlowAccumAtlas, channelTexel, 0).r);
  input.flowAccumulationAreaM2 = max(0.0, exp2(flowLog2) - 1.0);
  // A null-created analytic atlas is zero-initialised. Erosion flow starts at
  // one contributing source cell, so zero is an unambiguous parity sentinel.
  input.flowAccumulationValid = select(0.0, 1.0, flowLog2 > 0.0);
  // 6-6: soil rides the SAME sentinel, and that is a fact about the producer,
  // not a convenience — uploadHydrology writes all four aux resources before
  // it marks the slot ready, so a page with flow has soil and a page without
  // flow has neither. Soil's own value cannot carry validity: it quantises to
  // 0 on near-vertical faces, where 0 is a real answer.
  input.soilDepthMeters =
    textureLoad(splatSoilDepthAtlas, channelTexel, 0).r * SPLAT_SOIL_MAX_METERS;
  input.soilDepthValid = input.flowAccumulationValid;
  input.canopyClosure = tap.x;
  input.grassCover = tap.y;
  var tapClimate = tap.w;
  if (tap.z >= 0.0) {
    input.moisture = tap.z;
  } else {
    input.moisture = terrainMoisture(localX, localZ, province.y);
    tapClimate = terrainClimate(localX, localZ);
  }
  input.temperature = terrainTemperatureFromClimate(tapClimate, elevation, province.x);
  input.temperatureOffset = province.x;
  input.dryness = province.y;
  input.sandCover = sandCover;
  input.aspect = 0.0;
  // The airport's graded platform is mown grass (1B-6), and its influence is
  // the same rounded-rectangle field the earthworks key on.
  input.airportInfluence = kSaturate(splatAirportInfluence(job, localX, localZ));
  input.dayOfYear = job.airport.w;
  input.seasonalTemperatureShift = shift;
  // Volcanic land: the texel's one sample (see splatVolcanicGround). All
  // three are exactly 0 off volcanic ground — what the zero-initialised
  // input held before they existed.
  input.lavaCover = splatVolcanicGround.x;
  input.tephraCover = splatVolcanicGround.y;
  input.volcanicAge = splatVolcanicGround.z;
  return input;
}

/** Classify one tap; the arguments are splatLandCoverInput's. */
fn splatClassify(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  shift: f32,
  tap: vec4f,
  province: vec2f,
  sandCover: f32,
) -> LandCoverWeights {
  return classifyLandCover(splatLandCoverInput(job, localX, localZ, shift, tap, province, sandCover));
}

/**
 * 6-8: the canopy the ground carries here - (true closure, grass cover).
 *
 * Evaluated ONCE per channel texel rather than per supersample wherever the
 * texel is finer than the closure channel's band limit, and that is a property
 * of the channel rather than a saving: the vegetation lattices are band-limited
 * at a FIXED 60 m (CANOPY_CLOSURE_FILTER_WIDTH_METERS), so four samples up to
 * 16 m apart inside one texel would return four copies of the same number.
 * From a 64 m texel up that argument fails and each tap samples its own
 * (LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS); the closure LANE stored beside the
 * weights stays the centre sample at every level, because the far canopy and
 * the hand-off read it and must agree with the trees actually planted. The shore-distance driver is left at its neutral out-of-domain value
 * because the riparian corridor is 6-50 m wide - an order of magnitude below
 * this channel's own band limit, so it could not survive into it anyway.
 */
fn splatCanopyAt(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  moisture: f32,
  temperatureOffset: f32,
  dryness: f32,
) -> vec2f {
  // **The gutter offset is packed in CHANNEL texels and this reads HEIGHT
  // texels.** \`job.placement.xy\` is \`-GUTTER * channelTexel\`, so dividing it by
  // \`shape.y\` over-shifts by \`GUTTER * (channelTexel / heightTexel - 1)\`. The
  // channel texel is twice the height texel, so the read landed a full GUTTER
  // of height texels past the texel being painted: 8 m at L0, **128 m per axis
  // at L4**. Height AND slope both come from this index, so the classification
  // was sampled off the ground it paints, further the coarser the page.
  //
  // Recovering the gutter in texels from the job keeps this correct if the
  // channel/height ratio ever changes: \`GUTTER = -placement.x / channelTexel\`.
  let gutterTexels = -job.placement.x / job.shape.x;
  let heightTexel = vec2f(
    localX / job.shape.y + gutterTexels,
    localZ / job.shape.y + gutterTexels,
  );
  let elevation = textureLoad(
    splatHeightAtlas,
    vec2i(job.slots.zw) + vec2i(heightTexel),
    0,
  ).r - job.shape.w;
  let slopeAspect = splatSlopeAspect(job, heightTexel);
  var drivers: VegetationDensityDrivers;
  drivers.elevationAboveSeaLevel = elevation;
  drivers.slope = slopeAspect.x;
  drivers.moisture = moisture;
  drivers.aspect = slopeAspect.y;
  // The SAME field the classifier reads, and the same one generation.ts feeds
  // the density field: the airfield's woody-stem clearance is what keeps the
  // baked closure equal to the canopy actually planted on the apron.
  drivers.airportInfluence = kSaturate(splatAirportInfluence(job, localX, localZ));
  drivers.shoreDistanceMeters = 1e9;
  // Climate provinces: the treeline reads thermal height.
  drivers.temperatureOffset = temperatureOffset;
  // ... and the dry provinces' lone trees and pinyon read the raw dryness, so
  // the baked closure is the canopy generation.ts actually plants there.
  drivers.dryness = dryness;
  // The band limit is hoisted into the appended lattice table's own weights,
  // so this driver is inert here — the include never reads it.
  drivers.filterWidthMeters = 0.0;
  let sample = vegetationDensity(SPLAT_VEGETATION_LATTICE_BASE, localX, localZ, drivers);
  return vec2f(sample.canopyClosure, sample.grassCover);
}

/**
 * (canopy, grass) factors for the sand cover: densityField.ts'
 * sandCoverTreeFactor and sandCoverGroundFactor, exactly (1, 1) at no cover.
 */
fn splatSandPlantFactors(sandCover: f32) -> vec2f {
  if (sandCover <= 0.0) { return vec2f(1.0); }
  return vec2f(
    1.0 - kSmoothstep(${wgslConstant(SAND_COVER_TREE_LOW)}, ${wgslConstant(SAND_COVER_TREE_HIGH)}, sandCover),
    1.0 - kSaturate(sandCover),
  );
}

/** The canopy at a point whose moisture nobody has evaluated yet. */
fn splatCanopy(job: SplatJob, localX: f32, localZ: f32, province: vec2f) -> vec2f {
  return splatCanopyAt(
    job, localX, localZ, terrainMoisture(localX, localZ, province.y), province.x, province.y);
}

/** Average the WEIGHT VECTORS of a 2x2 supersample, not their argmax. */
fn splatSupersample(
  job: SplatJob,
  localX: f32,
  localZ: f32,
  shift: f32,
  tapCanopy: array<vec4f, 4>,
  province: vec2f,
  sandCover: f32,
) -> LandCoverWeights {
  var accumulated: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    accumulated[index] = 0.0;
  }
  let step = job.shape.x * 0.25;
  // A value array is indexed dynamically through a var on every toolchain.
  var taps = tapCanopy;
  for (var sample = 0u; sample < 4u; sample = sample + 1u) {
    let dx = select(-step, step, (sample & 1u) == 1u);
    let dz = select(-step, step, (sample & 2u) == 2u);
    let weights = splatClassify(job, localX + dx, localZ + dz, shift, taps[sample], province, sandCover);
    for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
      // Volcanic land: remapped here, before anything selects, so a remapped
      // Basalt and a real Rock in one texel are one material's weight.
      let id = splatVolcanicMaterial(job, u32(weights.ids[slot]));
      accumulated[id] = accumulated[id] + weights.weights[slot] * 0.25;
    }
  }
  // The far desert: see landCoverFarDesertWeights (the TS twin). Bake-time
  // only, and only where a dry province makes the share non-zero.
  if (job.shape.x > ${LAND_COVER_FAR_DESERT_START_TEXEL_METERS.toFixed(1)}) {
    let farRamp = kSaturate(log2(job.shape.x / ${LAND_COVER_FAR_DESERT_START_TEXEL_METERS.toFixed(1)})
      / ${Math.log2(LAND_COVER_FAR_DESERT_FULL_TEXEL_METERS / LAND_COVER_FAR_DESERT_START_TEXEL_METERS).toFixed(1)});
    var farArid = kSmoothstep(LAND_COVER_DESERT_ONSET, LAND_COVER_DESERT_FULL, province.y) * farRamp;
    // A sand sea stays sand at range (the TS twin's sandCover argument).
    if (sandCover > 0.0) { farArid = farArid * (1.0 - sandCover); }
    if (farArid > 0.0) {
      let moved = (accumulated[${SurfaceMaterial.Sand}] + accumulated[${SurfaceMaterial.Gravel}]
        + accumulated[${SurfaceMaterial.Rock}]) * farArid;
      accumulated[${SurfaceMaterial.Sand}] = accumulated[${SurfaceMaterial.Sand}] * (1.0 - farArid);
      accumulated[${SurfaceMaterial.Gravel}] =
        accumulated[${SurfaceMaterial.Gravel}] * (1.0 - farArid);
      accumulated[${SurfaceMaterial.Rock}] = accumulated[${SurfaceMaterial.Rock}] * (1.0 - farArid);
      accumulated[${SurfaceMaterial.DryGrass}] = accumulated[${SurfaceMaterial.DryGrass}] + moved;
    }
  }
  // Re-select the top four from the AVERAGED vector.
  var result: LandCoverWeights;
  var total = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
      if (accumulated[index] > bestValue) {
        bestValue = accumulated[index];
        bestIndex = index;
      }
    }
    accumulated[bestIndex] = -1.0;
    result.ids[slot] = f32(bestIndex);
    result.weights[slot] = max(0.0, bestValue);
    total = total + max(0.0, bestValue);
  }
  if (total > 0.0) { result.weights = result.weights / total; }
  return result;
}

struct SeasonalLandCoverWeights {
  ids: vec4f,
  weightsLo: vec4f,
  weightsHi: vec4f,
};

/** Give both season buckets one categorical id basis before storing them. */
fn splatAlignSeasonalWeights(
  lo: LandCoverWeights,
  hi: LandCoverWeights,
) -> SeasonalLandCoverWeights {
  var loByMaterial: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  var hiByMaterial: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  var scores: array<f32, ${SURFACE_MATERIAL_COUNT}>;
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    loByMaterial[index] = 0.0;
    hiByMaterial[index] = 0.0;
  }
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    let loId = u32(lo.ids[slot]);
    let hiId = u32(hi.ids[slot]);
    loByMaterial[loId] = loByMaterial[loId] + lo.weights[slot];
    hiByMaterial[hiId] = hiByMaterial[hiId] + hi.weights[slot];
  }
  for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
    scores[index] = max(loByMaterial[index], hiByMaterial[index]);
  }

  var result: SeasonalLandCoverWeights;
  var totalLo = 0.0;
  var totalHi = 0.0;
  for (var slot = 0u; slot < LAND_COVER_TOP; slot = slot + 1u) {
    var bestIndex = 0u;
    var bestValue = -1.0;
    for (var index = 0u; index < LAND_COVER_COUNT; index = index + 1u) {
      if (scores[index] > bestValue) {
        bestIndex = index;
        bestValue = scores[index];
      }
    }
    scores[bestIndex] = -1.0;
    result.ids[slot] = f32(bestIndex);
    result.weightsLo[slot] = loByMaterial[bestIndex];
    result.weightsHi[slot] = hiByMaterial[bestIndex];
    totalLo = totalLo + result.weightsLo[slot];
    totalHi = totalHi + result.weightsHi[slot];
  }
  if (totalLo > 0.0) { result.weightsLo = result.weightsLo / totalLo; }
  if (totalHi > 0.0) { result.weightsHi = result.weightsHi / totalHi; }
  return result;
}
${FAR_SWARD_BAKE_GATE_WGSL}
@compute @workgroup_size(8, 8, 1)
fn bakeSplat(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let job = splatJobs[group.z];
  let edge = ${136}u;
  if (id.x >= edge || id.y >= edge) { return; }
  kSelectPage(u32(job.shape.z));

  let localX = job.placement.x + (f32(id.x) + 0.5) * job.shape.x;
  let localZ = job.placement.y + (f32(id.y) + 0.5) * job.shape.x;
  let texel = vec2i(job.slots.xy) + vec2i(i32(id.x), i32(id.y));

  // Ids are categorical values encoded as unorm over the whole material axis.
  // The surface shader loads them exactly; it never filters between ids.
  // Both seasonal weight textures must share this same per-texel basis.
  let scale = 1.0 / f32(LAND_COVER_COUNT - 1u);
  // Climate provinces: once per texel (see splatClassify), shared by the
  // canopy, every tap and both seasons.
  let province = terrainClimateProvince(localX, localZ);
  // Landforms: the sand the dunes lay down, also once per texel. The landform
  // functions are supplied by the COMPOSER with the landform include
  // (terrainPageSplatWgsl), like SPLAT_VEGETATION_LATTICE_BASE. The gate reads
  // no kernel and is shut inside the landform core and off every erg, so only
  // a texel that can be sand pays for the natural kernel here. A dune's
  // slipface is ~20 m across, wider than a 4 m L0 texel, and from 128 m texels
  // up the dune field is its mean, so the taps share the centre's cover.
  var sandCover = 0.0;
  if (terrainLandformClimateGate(localX, localZ)) {
    sandCover = terrainLandformSandCover(localX, localZ, terrainNaturalHeight(localX, localZ)).y;
  }
  // The baked canopy is the canopy the CPU plants: no trees on the sand
  // (sandCoverTreeFactor) and grass thinned with it (sandCoverGroundFactor).
  let sandPlants = splatSandPlantFactors(sandCover);
  // Volcanic land: once per texel too, at the same page-local point, over the
  // channel texel's footprint.
  splatVolcanicGround = terrainVolcanicGround(
    splatVolcanicBase(), vec2f(localX, localZ), job.shape.x);
  let canopy = splatCanopy(job, localX, localZ, province) * sandPlants;
  // Coarse texels give each tap its own canopy (see
  // LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS); finer ones hand all four the
  // centre's, which is bit-for-bit what this bake did before. Same tap order
  // and offsets as splatSupersample. Sampled once, used by both seasons.
  let centreTap = vec4f(canopy, -1.0, 0.0);
  var tapCanopy = array<vec4f, 4>(centreTap, centreTap, centreTap, centreTap);
  if (job.shape.x >= ${LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS.toFixed(1)}) {
    let tapStep = job.shape.x * 0.25;
    for (var tap = 0u; tap < 4u; tap = tap + 1u) {
      let tapDx = select(-tapStep, tapStep, (tap & 1u) == 1u);
      let tapDz = select(-tapStep, tapStep, (tap & 2u) == 2u);
      // One moisture chain and one climate chain per tap, shared by its canopy
      // sample and by both of its seasonal classifications.
      let tapMoisture = terrainMoisture(localX + tapDx, localZ + tapDz, province.y);
      tapCanopy[tap] = vec4f(
        splatCanopyAt(job, localX + tapDx, localZ + tapDz, tapMoisture, province.x, province.y)
          * sandPlants,
        tapMoisture,
        terrainClimate(localX + tapDx, localZ + tapDz));
    }
  }
  let lo = splatSupersample(job, localX, localZ, job.placement.z, tapCanopy, province, sandCover);
  let hi = splatSupersample(job, localX, localZ, job.placement.w, tapCanopy, province, sandCover);
  let aligned = splatAlignSeasonalWeights(lo, hi);
  textureStore(splatId, texel, aligned.ids * scale);
  // 6-8: the canopy-closure channel rides the weight textures' ALPHA lane, in
  // BOTH season buckets, and costs nothing.
  //
  // The fourth material weight is REDUNDANT: splatAlignSeasonalWeights
  // normalises each bucket, so w3 == 1 − w0 − w1 − w2 exactly and the fragment
  // reconstructs it (terrainSurfaceSparseSplat). That buys a full 8-bit
  // continuous channel for zero bytes of atlas — which matters, because the
  // channel atlas is 107 MiB at tier 1 and the inventoried memory wall is
  // already breached — and zero new fragment samplers against the
  // 16-per-stage limit section 1.2 reserves for this item. Closure is
  // season-INVARIANT, so writing the same value into both buckets survives the
  // fragment's seasonal mix() unchanged.
  //
  // Reconstruction is not lossier than storing w3 was: w0..w2 quantise to
  // 1/255 each, so the reconstructed w3 carries at most 3 half-ULPs of error
  // against the stored value's 1, and the reconstructed vector now sums to
  // exactly 1 where the stored one only did up to quantisation.
  //
  // V-4: closure is read from the LOW bucket's alpha only (the vertex stage's
  // corner taps and terrainSurfaceCanopyClosure); nothing mixes the alpha
  // lanes. So the HIGH bucket's alpha carries the texel's far-sward gate for
  // both buckets instead (FarSwardGate.ts), for the soft read's neighbours.
  //
  // Volcanic land: the lane carries the trees bare lava and tephra leave
  // standing — generation.ts plants exactly that share of the stems
  // (detailVolcanicStemShare) — so the far canopy and the hand-off still
  // agree with the trees actually planted. Off volcanic ground nothing is
  // evaluated and the lane is the centre sample, bit for bit.
  var closure = canopy.x;
  if (splatVolcanicGround.x > 0.0 || splatVolcanicGround.y > 0.0) {
    closure = closure * (1.0 - landCoverVolcanicBareShare(
      splatLandCoverInput(job, localX, localZ, job.placement.z, centreTap, province, sandCover)));
  }
  textureStore(splatWeightLo, texel, vec4f(aligned.weightsLo.xyz, closure));
  textureStore(splatWeightHi, texel, vec4f(aligned.weightsHi.xyz, splatFarSwardGateStored(aligned)));
}
`;
