import {
  TerrainBiome,
  TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS,
  sampleTerrainEvolutionGeology,
  seasonalSnowlineDescentMeters,
  seasonalWinterFraction,
  type TerrainEvolutionGeologySample,
} from "@/src/world";
import { clamp as kernelClamp } from "@/src/world/noise";
import {
  classifyLandCover,
  landCoverHabitat,
} from "@/src/render/webgpu/terrain/LandCoverClassifier";
import {
  terrainSlopeAngleFromNormalizedSteepness,
  terrainSoilDepthMeters,
  terrainTopographicWetnessIndex,
} from "@/src/render/webgpu/terrain/TerrainPageHydrology";
import { hashSeed } from "@/src/world/seed";
import type { AirportDefinition } from "@/src/world/types";
import {
  structureClearanceFactor,
  type StructureExclusionBox,
} from "../airfield/StructureExclusion";
import { TERRAIN_REFERENCE_DAY_OF_YEAR } from "@/src/world";
import {
  densityField,
  riparianVegetationFactors,
  soilLitterFactor,
  type VegetationDensitySample,
} from "./densityField";
import { sampleStandField, type StandSample } from "./standField";
import {
  TALUS_FACE_SHED_MAX,
  TALUS_NO_PLACEMENT,
  TALUS_NO_SUPPLY,
  talusFailureFraction,
  talusPlacement,
  talusRestWeight,
  type TalusPlacementSample,
  type TalusSupplyProbe,
} from "./talusField";
import {
  DEFAULT_DETAIL_CELL_SIZE_METERS,
  type ClutterKind,
  type DetailCellGenerationOptions,
  type DetailClutterPlacement,
  type DetailRockPlacement,
  type DetailShrubPlacement,
  type DetailTerrainSample,
  type DetailTreePlacement,
  type GeneratedDetailCell,
  type RockVariant,
  type ShrubSpecies,
  type TreeSpecies,
} from "./types";

const TAU = Math.PI * 2;

type RandomSource = () => number;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function createRandom(seed: string): RandomSource {
  let state = hashText(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function validSample(sample: DetailTerrainSample): boolean {
  return (
    Number.isFinite(sample.height) &&
    Number.isFinite(sample.slope) &&
    Number.isFinite(sample.moisture) &&
    sample.slope >= 0 &&
    sample.slope <= 1 &&
    sample.moisture >= 0 &&
    sample.moisture <= 1
  );
}

/**
 * Multiplicative suppression over the graded airport surrounds (1B-6).
 * Airfields are mown grass: woody plants and rocks fade out with influence
 * (never a boolean cutoff), while ground cover — when 2-16 adds it — keeps
 * growing with its height capped at ~0.15 m. Zero influence is a no-op.
 */
function airportClearance(sample: DetailTerrainSample): number {
  return 1 - clamp(sample.airportInfluence ?? 0, 0, 1);
}

/**
 * `6-7`: the acceptance probability the apron may add on top of the
 * outcrop/lag population. The clamp at 0.75 is unchanged, so the *structural*
 * per-cell ceiling (the fixed candidate count) is untouched — a talus apron
 * spends more of a cell's existing candidates, it does not create candidates.
 */
const TALUS_ROCK_DENSITY_GAIN = 0.42;

/** `terrainSlopeAngleFromNormalizedSteepness` is undefined at vertical. */
const MAX_SLOPE_FOR_ANGLE = 0.98;

/**
 * `6-7` — the biome lag/outcrop population and the talus apron, kept as two
 * NAMED terms because they are two different rocks.
 *
 * The lag term is `2-15`'s: field stones, glacial erratics, in-situ outcrop
 * knobs. It is a property of the biome and of exposure, and it survives
 * unchanged wherever the surface can hold it.
 *
 * What `6-7` adds to it is conservation. `2-15`'s `slope · 0.35` grew without
 * limit toward vertical, so the steeper a face got the MORE loose blocks it
 * carried — exactly backwards. A face above the local angle of repose is a
 * failure face; it sheds. {@link TALUS_FACE_SHED_MAX} of the lag population
 * therefore leaves over-repose ground, and the apron term puts it back below,
 * where {@link talusPlacement} says it comes to rest. That is why this item
 * is a REDISTRIBUTION and not a density increase.
 */
function rockLagProbability(
  sample: DetailTerrainSample,
  reposeDegrees: number,
): number {
  let biomeLag: number;
  switch (sample.biome) {
    case TerrainBiome.BEACH:
      biomeLag = 0.09;
      break;
    case TerrainBiome.GRASSLAND:
      biomeLag = 0.025;
      break;
    case TerrainBiome.FOREST:
      biomeLag = 0.04;
      break;
    case TerrainBiome.HIGHLAND:
      biomeLag = 0.18;
      break;
    case TerrainBiome.ALPINE:
      biomeLag = 0.28;
      break;
    case TerrainBiome.SNOW:
      biomeLag = 0.14;
      break;
    default:
      // Water and paved ground carry no rock population at all. Returning
      // zero here is what keeps the apron term off them too: every talus
      // contribution is added INSIDE this guard, downstream of it.
      return 0;
  }
  const swept = 1 - TALUS_FACE_SHED_MAX * talusFailureFraction(sample.slope, reposeDegrees);
  return biomeLag + sample.slope * 0.35 * swept;
}

function rockProbability(
  sample: DetailTerrainSample,
  reposeDegrees: number,
  talusDensity: number,
): number {
  const lag = rockLagProbability(sample, reposeDegrees);
  if (lag <= 0) return 0;
  return clamp(lag + TALUS_ROCK_DENSITY_GAIN * talusDensity, 0, 0.75)
    * airportClearance(sample);
}

/**
 * How much of an accepted rock's presence the apron paid for, in [0, 1]. Zero
 * is a pure `2-15` lag block; one is pure scree. Used only to blend the size
 * law, so a boulder field grades into the surrounding lag instead of ending
 * at a contour.
 */
function talusApronShare(
  sample: DetailTerrainSample,
  reposeDegrees: number,
  talusDensity: number,
): number {
  const apron = TALUS_ROCK_DENSITY_GAIN * talusDensity;
  if (apron <= 0) return 0;
  const lag = rockLagProbability(sample, reposeDegrees);
  return apron / (lag + apron);
}

/**
 * `6-7` — the soil-depth input to the scree law, and its analytic fallback.
 *
 * Eroded worlds publish `5-5`'s channel and it is read verbatim. Analytic
 * worlds publish nothing, and the fallback is deliberately NOT a second soil
 * model: it is `terrainSoilDepthMeters`, the OWNED law, evaluated with the
 * information an analytic world actually has. Slope it has. Convergence
 * curvature and contributing area it does not — an analytic world has no flow
 * field at all — so curvature is planar and the wetness term is the owned TWI
 * at zero contributing area, which is what "no drainage" means arithmetically
 * rather than a conceded constant.
 *
 * The consequence, stated so it is not mistaken for a bug: analytically the
 * soil term is nearly saturated on any slope steep enough to hold an apron,
 * so it gates almost nothing there and the repose/supply terms carry the law
 * alone. Where a hydrology page exists, curvature and wetness re-enter and
 * convergent, wet, low-gradient ground stops growing scree. That difference
 * IS the channel being live.
 */
function screeSoilDepthMeters(sample: DetailTerrainSample): number {
  if (sample.soilDepthMeters !== undefined) return sample.soilDepthMeters;
  const slopeRadians = terrainSlopeAngleFromNormalizedSteepness(
    Math.min(sample.slope, MAX_SLOPE_FOR_ANGLE),
  );
  return terrainSoilDepthMeters(
    slopeRadians,
    0,
    terrainTopographicWetnessIndex(0, slopeRadians),
  );
}

/** 4-6b: the density authority's own empty answer, not a local literal. */
const ZERO_VEGETATION_DENSITY: VegetationDensitySample = Object.freeze({
  treeStemsPerSquareMeter: 0,
  shrubStemsPerSquareMeter: 0,
  heightFactor: 1,
  aspect: 0,
  forestEdge: 0,
  groundCover: Object.freeze({ grass: 1, fern: 0, heather: 0, reed: 0, clutter: 0 }),
  riparianBand: 0,
  canopyClosure: 0,
  grassCover: 1,
});

/**
 * `R-27`: species read the CLASSIFIER's weight vector, not their own rules.
 *
 * The old form branched on `sample.biome` and raw moisture thresholds — a
 * third independent answer to "what grows here", alongside `classifyBiome`'s
 * cascade and the wildlife habitat table. A treeline could end where the rock
 * started or 80 m above it, and only a screenshot would say which. The habitat
 * shares below come from `landCoverHabitat`, so the ground, the trees on it
 * and the animals in them are classified once.
 *
 * The mix is still a random DRAW, not a lookup: a stand is a mixture, and
 * picking the argmax species would make every forest a monoculture.
 */
function chooseTreeSpecies(sample: DetailTerrainSample, choice: number): TreeSpecies {
  const habitat = landCoverHabitat(classifyDetailSample(sample));
  // Upland: conifer-dominated, and the classifier's scrub/barren shares are
  // what "upland" MEANS here rather than a height threshold.
  const upland = habitat.scrub + habitat.barren;
  if (upland > habitat.canopy + habitat.open) {
    if (choice < 0.44) return "spruce";
    if (choice < 0.79) return "pine";
    return "cedar";
  }
  if (sample.moisture > 0.78) {
    if (choice < 0.25) return "willow";
    if (choice < 0.49) return "birch";
    if (choice < 0.68) return "cedar";
    if (choice < 0.84) return "maple";
    return "oak";
  }
  if (sample.moisture < 0.35) {
    if (choice < 0.58) return "pine";
    if (choice < 0.78) return "spruce";
    return "oak";
  }
  if (choice < 0.24) return "oak";
  if (choice < 0.43) return "maple";
  if (choice < 0.59) return "birch";
  if (choice < 0.76) return "pine";
  if (choice < 0.9) return "spruce";
  return "cedar";
}

/**
 * Classify a detail sample through the one authority.
 *
 * Read at the REFERENCE day deliberately: species mix stays climatic (`2-18`),
 * and only the paint migrates with the calendar.
 */
function classifyDetailSample(sample: DetailTerrainSample) {
  const normalY = sample.normal?.y ?? 1;
  const horizontal = Math.hypot(sample.normal?.x ?? 0, sample.normal?.z ?? 0);
  return classifyLandCover({
    elevationMeters: sample.height,
    slope: sample.slope,
    moisture: sample.moisture,
    // The detail sampler carries no temperature; the classifier's warmth term
    // is a lowland/upland gate here, which slope and elevation already supply.
    temperature: 0.66 - Math.max(0, sample.height) / 2_450,
    aspect: horizontal > 1e-6 ? (-(sample.normal?.z ?? 0) / horizontal) * (1 - normalY) : 0,
    airportInfluence: sample.airportInfluence ?? 0,
    dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
    seasonalTemperatureShift: 0,
  });
}

function treeDimensions(
  species: TreeSpecies,
  random: RandomSource,
  standAge: number,
): { height: number; crown: number; trunk: number; wind: number; individualAge: number } {
  // A stand has an age signature, but individual trees still follow a
  // strongly skewed distribution.  This creates saplings, mature canopy, and
  // occasional emergent trees instead of uniformly scaled copies.
  const individualAge = random() > 0.955
    ? 1
    : clamp(0.04 + standAge * 0.4 + Math.pow(random(), 2.15) * 0.68, 0.04, 1);
  const dimensions = (
    minimumHeight: number,
    maximumHeight: number,
    crownRatio: number,
    trunkRatio: number,
    wind: number,
  ) => {
    const height = minimumHeight + (maximumHeight - minimumHeight) * individualAge;
    return {
      height,
      crown: height * crownRatio * (0.88 + random() * 0.24),
      trunk: Math.max(0.055, height * trunkRatio * (0.86 + random() * 0.24)),
      wind: wind * (1.12 - individualAge * 0.22),
      individualAge,
    };
  };
  switch (species) {
    case "pine": return dimensions(4.5, 31, 0.18, 0.018, 0.62);
    case "cedar": return dimensions(5.5, 35, 0.21, 0.02, 0.52);
    case "spruce": return dimensions(4, 33, 0.16, 0.019, 0.58);
    case "oak": return dimensions(3.5, 25, 0.32, 0.026, 0.82);
    case "maple": return dimensions(3.2, 26, 0.3, 0.023, 0.88);
    case "birch": return dimensions(3.4, 24, 0.22, 0.014, 0.9);
    case "willow": return dimensions(2.8, 21, 0.37, 0.023, 0.94);
  }
}

const TREE_TINT_BASE: Readonly<Record<TreeSpecies, readonly [number, number, number]>> = {
  pine: [0.72, 0.91, 0.74],
  cedar: [0.78, 0.86, 0.67],
  spruce: [0.67, 0.84, 0.78],
  oak: [0.94, 0.9, 0.68],
  maple: [0.98, 0.94, 0.63],
  birch: [0.88, 1.02, 0.75],
  willow: [0.88, 0.98, 0.7],
};

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = ((hue / 6) + 1) % 1;
  }
  return [hue, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  const sector = hue * 6;
  const c = v * s;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  const [r, g, b] = sector < 1 ? [c, x, 0]
    : sector < 2 ? [x, c, 0]
    : sector < 3 ? [0, c, x]
    : sector < 4 ? [0, x, c]
    : sector < 5 ? [x, 0, c]
    : [c, 0, x];
  return [r + m, g + m, b + m];
}

const CONIFER_SPECIES: ReadonlySet<TreeSpecies> = new Set(["pine", "cedar", "spruce"]);

/**
 * 2-13a — autumn hue target (turns) and blend strength per DECIDUOUS
 * species; evergreens are absent. Maple turns red-orange, birch clear
 * yellow, oak russet, willow/hazel yellow-olive.
 */
const AUTUMN_HUE: Readonly<Partial<Record<TreeSpecies | ShrubSpecies, readonly [number, number]>>> = {
  oak: [0.075, 0.75],
  maple: [0.02, 0.85],
  birch: [0.115, 0.9],
  willow: [0.1, 0.7],
  hazel: [0.09, 0.8],
};

function smootherStep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 2-13a — the seasonal crown, R-13's kernel made visible. Deciduous species
 * turn through their autumn hue (winterFraction 0.12-0.42), then shed: the
 * tint's ALPHA lane carries the leaf fraction (1 = full crown) and the
 * fragment stage lifts the alpha test as it falls, so the canopy loses
 * texels progressively toward bare speckle. Conifers hold, dimming ~7% at
 * the depth of winter. Above the descending snowline the crown whitens
 * toward the unorm8 tint ceiling (slope-shedding weighted, matching
 * seasonalSnowCover's ground rule) — full snow-white needs an albedo term
 * beyond the tint lane, deferred to 2-17a with the impostor season buckets.
 * Per-stem phenology jitter (±0.06 winterFraction) makes stands turn
 * tree-by-tree rather than by calendar row.
 */
function applyFoliageSeason(
  color: readonly [number, number, number, number],
  species: TreeSpecies | ShrubSpecies,
  season: FoliageSeason,
  phenologyJitter: number,
  terrainHeightMeters: number,
  terrainSlope: number,
): readonly [number, number, number, number] {
  const winter = clamp(season.winterFraction + (phenologyJitter - 0.5) * 0.12, 0, 1);
  let [r, g, b] = color;
  let alpha = color[3];
  const autumn = AUTUMN_HUE[species];
  if (autumn) {
    const [targetHue, strength] = autumn;
    const autumnBlend = smootherStep(0.12, 0.42, winter) * strength;
    if (autumnBlend > 0) {
      const [hue, saturation, value] = rgbToHsv(r, g, b);
      let hueDelta = targetHue - hue;
      hueDelta -= Math.round(hueDelta);
      const [ar, ag, ab] = hsvToRgb(
        hue + hueDelta * autumnBlend,
        clamp(saturation * (1 + 0.25 * autumnBlend), 0, 1),
        clamp(value * (1 + 0.16 * autumnBlend), 0, 1),
      );
      r = ar; g = ag; b = ab;
    }
    alpha = alpha * (1 - smootherStep(0.34, 0.7, winter));
  } else {
    const winterDim = 1 - 0.07 * winter;
    r *= winterDim; g *= winterDim; b *= winterDim;
  }
  const snowed = applySnowCover([r, g, b], season, winter, terrainHeightMeters, terrainSlope);
  return [snowed[0], snowed[1], snowed[2], clamp(alpha, 0, 1)];
}

/**
 * 2-13a/2-15 — the shared snow whitening, `seasonalSnowCover`'s ground rule
 * applied to surface objects: band above the descending snowline, season
 * gate, and slope shedding. The shedding term is vacuous for canopy (trees
 * stop growing at slope ~0.2) and LIVE for rocks, which reach 0.9.
 */
function applySnowCover(
  rgb: readonly [number, number, number],
  season: FoliageSeason,
  winterFraction: number,
  terrainHeightMeters: number,
  terrainSlope: number,
): [number, number, number] {
  const snowBand = smootherStep(
    season.snowlineMeters - 140,
    season.snowlineMeters + 40,
    terrainHeightMeters,
  );
  const slopeShedding = 1 - clamp((terrainSlope - 0.55) * 2.2, 0, 1);
  const seasonGate = smootherStep(0.15, 0.35, winterFraction);
  const snowCover = snowBand * slopeShedding * seasonGate * 0.85;
  let [r, g, b] = rgb;
  if (snowCover > 0) {
    r += (1 - r) * snowCover;
    g += (1 - g) * snowCover;
    b += (1 - b) * snowCover;
  }
  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}

/**
 * 2-12: tint DISTRIBUTION, not tint storage. Sampled in HSV: within a
 * species, hue σ ≈ 6–9° (broadleaf wider than conifer), saturation σ ≈ 0.10
 * relative, value σ ≈ 0.12. The mean is STAND-correlated — drawn from the
 * 2-11b field — with an individual residual on top, so neighbouring stands
 * differ as well as neighbouring trees and the result is not confetti.
 * Value correlates weakly (negatively) with the individual's age so young
 * stems read lighter. The old single-scalar multiply was pure brightness
 * jitter with zero hue variance — a forest of one green at different
 * exposures, the flight-test complaint verbatim.
 */
function treeColor(
  species: TreeSpecies,
  random: RandomSource,
  tintCentre: number,
  individualAge: number,
): readonly [number, number, number, number] {
  const base = TREE_TINT_BASE[species];
  const [baseHue, baseSat, baseVal] = rgbToHsv(base[0], base[1], base[2]);
  const triangular = (): number => random() + random() - 1;
  const hueSigmaTurns = (CONIFER_SPECIES.has(species) ? 6.5 : 8.5) / 360;
  const standHueShift = (tintCentre - 0.5) * (14 / 360);
  const hue = baseHue + standHueShift + triangular() * hueSigmaTurns * Math.sqrt(6) * 0.5;
  const saturation = clamp(baseSat * (1 + triangular() * 0.10 * Math.sqrt(6) * 0.5), 0.05, 1);
  const ageDarkening = (individualAge - 0.5) * 0.14;
  const value = clamp(
    baseVal * (1 + triangular() * 0.12 * Math.sqrt(6) * 0.5 - ageDarkening),
    0.2,
    1.1,
  );
  const [r, g, b] = hsvToRgb(hue, saturation, Math.min(value, 1));
  const gain = value > 1 ? value : 1;
  return [r * gain, g * gain, b * gain, 1];
}

/**
 * The blue-noise scatter (1B-9), replacing the 176 m cluster lattice the
 * audit could see from altitude. Candidates live on a stratified jitter grid
 * whose subcell size is a continuous function of the local density —
 * clamp(sqrt(1/density), 3, 90) m — plus a world-continuous domain warp of
 * 0.6·cell, so no constant period exists anywhere in the image (4 m in
 * closed forest is under one crown diameter). Placement is a pure function
 * of world position: blocks sit on a global 32 m lattice with per-block and
 * per-subcell seed streams, so neighbouring detail pages derive identical
 * stems and the floating-origin rebase can never make anything slide.
 */
const SCATTER_BLOCK_METERS = 32;
/** Covers the widest thinning radius so page-edge decisions agree. */
const SCATTER_HALO_METERS = 8;
/** Terrain sampled on a global 16 m grid; candidates interpolate heights. */
const SCATTER_TERRAIN_GRID_METERS = 16;
const MAX_SUBCELLS_PER_BLOCK_AXIS = 8;

interface ScatterTerrainGrid {
  readonly minNodeX: number;
  readonly minNodeZ: number;
  readonly nodesX: number;
  readonly nodesZ: number;
  readonly samples: DetailTerrainSample[];
}

function buildScatterTerrainGrid(
  minX: number,
  minZ: number,
  cellSize: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
): ScatterTerrainGrid {
  const pitch = SCATTER_TERRAIN_GRID_METERS;
  const minNodeX = Math.floor((minX - SCATTER_HALO_METERS - SCATTER_BLOCK_METERS) / pitch);
  const minNodeZ = Math.floor((minZ - SCATTER_HALO_METERS - SCATTER_BLOCK_METERS) / pitch);
  const maxNodeX = Math.ceil((minX + cellSize + SCATTER_HALO_METERS + SCATTER_BLOCK_METERS) / pitch);
  const maxNodeZ = Math.ceil((minZ + cellSize + SCATTER_HALO_METERS + SCATTER_BLOCK_METERS) / pitch);
  const nodesX = maxNodeX - minNodeX + 1;
  const nodesZ = maxNodeZ - minNodeZ + 1;
  const samples: DetailTerrainSample[] = new Array(nodesX * nodesZ);
  for (let nodeZ = 0; nodeZ < nodesZ; nodeZ += 1) {
    for (let nodeX = 0; nodeX < nodesX; nodeX += 1) {
      samples[nodeZ * nodesX + nodeX] = sampleTerrain(
        (minNodeX + nodeX) * pitch,
        (minNodeZ + nodeZ) * pitch,
      );
    }
  }
  return { minNodeX, minNodeZ, nodesX, nodesZ, samples };
}

function gridNearest(grid: ScatterTerrainGrid, x: number, z: number): DetailTerrainSample {
  const pitch = SCATTER_TERRAIN_GRID_METERS;
  const nodeX = clamp(Math.round(x / pitch) - grid.minNodeX, 0, grid.nodesX - 1);
  const nodeZ = clamp(Math.round(z / pitch) - grid.minNodeZ, 0, grid.nodesZ - 1);
  return grid.samples[nodeZ * grid.nodesX + nodeX]!;
}

function gridHeight(grid: ScatterTerrainGrid, x: number, z: number): number {
  const pitch = SCATTER_TERRAIN_GRID_METERS;
  const gx = x / pitch - grid.minNodeX;
  const gz = z / pitch - grid.minNodeZ;
  const x0 = clamp(Math.floor(gx), 0, grid.nodesX - 2);
  const z0 = clamp(Math.floor(gz), 0, grid.nodesZ - 2);
  const fx = clamp(gx - x0, 0, 1);
  const fz = clamp(gz - z0, 0, 1);
  const row0 = z0 * grid.nodesX + x0;
  const row1 = row0 + grid.nodesX;
  const top = grid.samples[row0]!.height * (1 - fx) + grid.samples[row0 + 1]!.height * fx;
  const bottom = grid.samples[row1]!.height * (1 - fx) + grid.samples[row1 + 1]!.height * fx;
  return top * (1 - fz) + bottom * fz;
}

interface ScatterContext {
  readonly seed: string;
  readonly seedHash: number;
  /** Airfield structures vegetation must not grow through; empty off-airfield. */
  readonly structureExclusions: readonly StructureExclusionBox[];
  /** The frame those boxes are stated in; absent when there are none. */
  readonly exclusionAirport: Readonly<AirportDefinition> | undefined;
  readonly minX: number;
  readonly minZ: number;
  readonly cellSize: number;
  readonly density: number;
  readonly seaLevelMeters: number;
  readonly dayOfYear: number;
  readonly season: FoliageSeason;
  readonly grid: ScatterTerrainGrid;
}

/**
 * 2-13a — the cell's seasonal state, computed once from R-13's anchored
 * kernel. `winterFraction` is 0 at the reference midsummer day (the tuned
 * world is untouched) and approaches 1 at the depth of winter;
 * `snowlineMeters` is the canopy-snow altitude, descending with the season.
 */
export interface FoliageSeason {
  readonly winterFraction: number;
  readonly snowlineMeters: number;
}

function fieldAt(
  context: ScatterContext,
  sample: DetailTerrainSample,
  x: number,
  z: number,
): VegetationDensitySample {
  const field = densityField(context.seedHash, {
    // Per-stem placement is the full-bandwidth field, forever: filtering here
    // would move individual trees, not smooth a page.
    filterWidthMeters: 0,
    x,
    z,
    heightMeters: sample.height,
    seaLevelMeters: context.seaLevelMeters,
    slope: sample.slope,
    moisture: sample.moisture,
    ...(sample.normal ? { normalX: sample.normal.x, normalZ: sample.normal.z } : {}),
    ...(sample.airportInfluence !== undefined
      ? { airportInfluence: sample.airportInfluence }
      : {}),
    ...(sample.shoreDistanceMeters !== undefined
      ? { shoreDistanceMeters: sample.shoreDistanceMeters }
      : {}),
    dayOfYear: context.dayOfYear,
  });
  return field;
}

/**
 * 1 where vegetation may stand, 0 where a structure does.
 *
 * **EVALUATED AT THE STEM, NOT AT A BLOCK CENTRE, and that distinction is the
 * whole fix.** Density is sampled on a 32 m block lattice and BILINEARLY
 * INTERPOLATED to each stem, so applying the exclusion to the block sample
 * lets a neighbouring centre up to 32 m away — outside the structure, at full
 * density — leak its value back into the footprint. Measured: applying it at
 * the block sample took stems inside the hangars from 73 to 3. **Three is not
 * a smaller version of the bug; it is the bug.**
 *
 * Applied ONCE, here, for that reason: doing both would double-thin the blend
 * band and strip the surround Jason has separately asked to keep.
 */
function structureFactorAt(context: ScatterContext, x: number, z: number): number {
  if (context.exclusionAirport === undefined || context.structureExclusions.length === 0) {
    return 1;
  }
  return structureClearanceFactor(
    context.exclusionAirport,
    context.structureExclusions,
    x,
    z,
  );
}

interface ScatterCandidate {
  readonly x: number;
  readonly z: number;
  readonly priority: number;
  readonly spacing: number;
  readonly build: () => DetailTreePlacement | DetailShrubPlacement;
}

/**
 * O(n) rank-order thinning over an 8 m spatial hash: each candidate checks
 * only its neighbouring buckets and yields to any strictly higher-priority
 * candidate inside the pair's required spacing. The halo band lets
 * candidates just across a page edge participate, so both pages reach the
 * same verdicts.
 */
function thinCandidates(candidates: readonly ScatterCandidate[]): readonly ScatterCandidate[] {
  const bucketSize = SCATTER_HALO_METERS;
  const buckets = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const key = `${Math.floor(candidate.x / bucketSize)}:${Math.floor(candidate.z / bucketSize)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });
  return candidates.filter((candidate, index) => {
    const bucketX = Math.floor(candidate.x / bucketSize);
    const bucketZ = Math.floor(candidate.z / bucketSize);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = buckets.get(`${bucketX + dx}:${bucketZ + dz}`);
        if (!bucket) continue;
        for (const otherIndex of bucket) {
          if (otherIndex === index) continue;
          const other = candidates[otherIndex]!;
          if (
            other.priority < candidate.priority
            || (other.priority === candidate.priority && otherIndex > index)
          ) continue;
          const spacing = Math.max(candidate.spacing, other.spacing);
          if (
            Math.abs(other.x - candidate.x) < spacing
            && Math.abs(other.z - candidate.z) < spacing
            && Math.hypot(other.x - candidate.x, other.z - candidate.z) < spacing
          ) return false;
        }
      }
    }
    return true;
  });
}

function scatterLayer(
  context: ScatterContext,
  layer: "canopy" | "understory",
  emit: (
    x: number,
    z: number,
    y: number,
    blockSample: DetailTerrainSample,
    field: VegetationDensitySample,
    random: RandomSource,
    stand: StandSample,
    push: (spacing: number, priority: number, build: () => DetailTreePlacement | DetailShrubPlacement) => void,
  ) => void,
): readonly (DetailTreePlacement | DetailShrubPlacement)[] {
  const { minX, minZ, cellSize } = context;
  const loX = minX - SCATTER_HALO_METERS;
  const hiX = minX + cellSize + SCATTER_HALO_METERS;
  const loZ = minZ - SCATTER_HALO_METERS;
  const hiZ = minZ + cellSize + SCATTER_HALO_METERS;
  const minBlockX = Math.floor(loX / SCATTER_BLOCK_METERS);
  const maxBlockX = Math.floor((hiX - 1e-9) / SCATTER_BLOCK_METERS);
  const minBlockZ = Math.floor(loZ / SCATTER_BLOCK_METERS);
  const maxBlockZ = Math.floor((hiZ - 1e-9) / SCATTER_BLOCK_METERS);

  // Per-block density lattice, one ring wider than the block sweep so every
  // candidate can interpolate stems between the four surrounding block
  // centres. Interpolated acceptance removes block-level density steps —
  // the job a domain warp would otherwise do, without printing the warp
  // noise's own wavelength into the stem spectrum.
  const stemsAt = new Map<string, { stems: number; field: VegetationDensitySample; sample: DetailTerrainSample }>();
  const blockInfo = (blockX: number, blockZ: number) => {
    const key = `${blockX}:${blockZ}`;
    const cached = stemsAt.get(key);
    if (cached) return cached;
    const centerX = blockX * SCATTER_BLOCK_METERS + SCATTER_BLOCK_METERS / 2;
    const centerZ = blockZ * SCATTER_BLOCK_METERS + SCATTER_BLOCK_METERS / 2;
    const sample = gridNearest(context.grid, centerX, centerZ);
    const field = validSample(sample)
      ? fieldAt(context, sample, centerX, centerZ)
      : null;
    const info = {
      sample,
      field: field ?? ZERO_VEGETATION_DENSITY,
      stems: field === null ? 0 : (layer === "canopy"
        ? field.treeStemsPerSquareMeter
        : field.shrubStemsPerSquareMeter) * context.density,
    };
    stemsAt.set(key, info);
    return info;
  };
  const stemsInterpolated = (x: number, z: number): number => {
    const gx = (x - SCATTER_BLOCK_METERS / 2) / SCATTER_BLOCK_METERS;
    const gz = (z - SCATTER_BLOCK_METERS / 2) / SCATTER_BLOCK_METERS;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const top = blockInfo(x0, z0).stems * (1 - fx) + blockInfo(x0 + 1, z0).stems * fx;
    const bottom = blockInfo(x0, z0 + 1).stems * (1 - fx) + blockInfo(x0 + 1, z0 + 1).stems * fx;
    return top * (1 - fz) + bottom * fz;
  };

  const candidates: ScatterCandidate[] = [];
  for (let blockZ = minBlockZ; blockZ <= maxBlockZ; blockZ += 1) {
    for (let blockX = minBlockX; blockX <= maxBlockX; blockX += 1) {
      const info = blockInfo(blockX, blockZ);
      if (!validSample(info.sample)) continue;
      const stems = info.stems;
      if (stems <= 1e-7) continue;
      const jitterCell = kernelClamp(Math.sqrt(1 / stems), 3, 90);
      // Ceil + acceptance keeps the expected count exactly stems·area: the
      // subcell grid over-provisions and the acceptance roll trims it back.
      const sub = Math.max(
        1,
        Math.min(MAX_SUBCELLS_PER_BLOCK_AXIS, Math.ceil(SCATTER_BLOCK_METERS / jitterCell)),
      );
      const subSize = SCATTER_BLOCK_METERS / sub;

      for (let subZ = 0; subZ < sub; subZ += 1) {
        for (let subX = 0; subX < sub; subX += 1) {
          // Every subcell owns an independent stream, so page-local culls
          // cannot shift a neighbouring page's draws. Full-cell uniform
          // jitter zeroes every stratification line exactly (the jitter
          // pdf's transform has nulls at all grid harmonics).
          const random = createRandom(
            `${context.seed}/${layer}/${blockX}/${blockZ}/${subX}:${subZ}`,
          );
          const jitterX = random();
          const jitterZ = random();
          const acceptRoll = random();
          const x = blockX * SCATTER_BLOCK_METERS + (subX + jitterX) * subSize;
          const z = blockZ * SCATTER_BLOCK_METERS + (subZ + jitterZ) * subSize;
          // A HARD gate at the stem's own position — see `structureFactorAt`.
          // Zero here means no roll can place this stem, which is what an
          // exclusion has to mean: a probabilistic reduction is not a fix for
          // a building with a tree in it.
          const structure = structureFactorAt(context, x, z);
          if (structure <= 0) continue;
          const acceptance = kernelClamp(
            stemsInterpolated(x, z) * subSize * subSize * structure,
            0,
            1,
          );
          if (acceptRoll >= acceptance) continue;
          if (x < loX || x >= hiX || z < loZ || z >= hiZ) continue;
          const y = gridHeight(context.grid, x, z);
          // 2-11b: stand identity from the continuous field at the stem's
          // own position — no 32 m appearance lattice.
          const stand = sampleStandField(context.seedHash, x, z);
          emit(x, z, y, info.sample, info.field, random, stand, (spacing, priority, build) => {
            candidates.push({ x, z, priority, spacing, build });
          });
        }
      }
    }
  }

  return thinCandidates(candidates)
    .filter((candidate) => (
      candidate.x >= minX
      && candidate.x < minX + cellSize
      && candidate.z >= minZ
      && candidate.z < minZ + cellSize
    ))
    .map((candidate) => candidate.build());
}

function scatterTrees(context: ScatterContext): readonly DetailTreePlacement[] {
  return scatterLayer(context, "canopy", (x, z, y, blockSample, field, random, stand, push) => {
    const priority = random();
    const speciesRoll = random();
    const dominantRoll = random();
    const coniferRoll = random();
    let species = chooseTreeSpecies(
      blockSample,
      dominantRoll < 0.62 ? stand.dominantChoice : speciesRoll,
    );
    // Cool north faces carry a larger conifer share (the aspect species shift).
    if (field.aspect < 0 && coniferRoll < -field.aspect * 0.3) {
      species = coniferRoll < -field.aspect * 0.15 ? "spruce" : "pine";
    }
    const dimensions = treeDimensions(species, random, stand.standAge);
    // Krummholz: near the treeline trees shrink before they disappear.
    const height = dimensions.height * field.heightFactor;
    // Gate B forest-edge margin: the density authority shortens edge stems
    // through heightFactor and publishes the same margin for crown form.
    // Species and stand selection remain untouched; only silhouette changes.
    const crown = dimensions.crown
      * (0.55 + 0.45 * field.heightFactor)
      * (1 + field.forestEdge * 0.48);
    // Half a crown: real closed-canopy forests overlap crowns; a full-crown
    // exclusion zone thins the stand far below its ecological density.
    push(kernelClamp(crown * 0.5, 2, 6.5), priority, () => ({
      kind: "tree",
      id: `canopy:${x.toFixed(2)}:${z.toFixed(2)}`,
      species,
      x,
      y,
      z,
      yawRadians: random() * TAU,
      heightMeters: height,
      crownRadiusMeters: crown,
      trunkRadiusMeters: dimensions.trunk * (0.7 + 0.3 * field.heightFactor),
      windPhaseRadians: random() * TAU,
      windResponse: dimensions.wind * (0.82 + random() * 0.28),
      color: applyFoliageSeason(
        treeColor(species, random, stand.tintCentre, dimensions.individualAge),
        species,
        context.season,
        random(),
        y,
        blockSample.slope,
      ),
      standAge: stand.standAge,
      selection: random(),
    }));
  }) as readonly DetailTreePlacement[];
}

function scatterShrubs(context: ScatterContext): readonly DetailShrubPlacement[] {
  return scatterLayer(context, "understory", (x, z, y, blockSample, field, random, stand, push) => {
    const priority = random();
    const speciesRoll = random();
    const species = chooseShrubSpecies(
      blockSample,
      speciesRoll < 0.7 ? stand.dominantChoice : random(),
    );
    const maturity = 0.2 + Math.pow(random(), 1.45) * 0.8;
    const height = (species === "sage"
      ? 0.35 + maturity * 1.05
      : 0.55 + maturity * (species === "hazel" ? 2.8 : 2.1)) * field.heightFactor;
    const radius = height * (species === "hazel" ? 0.72 : 0.62) * (0.82 + random() * 0.3);
    push(kernelClamp(radius * 1.3, 1, 5), priority, () => ({
      kind: "shrub",
      id: `understory:${x.toFixed(2)}:${z.toFixed(2)}`,
      species,
      x,
      y,
      z,
      yawRadians: random() * TAU,
      heightMeters: height,
      radiusMeters: radius,
      windPhaseRadians: random() * TAU,
      windResponse: 0.78 + random() * 0.38,
      color: applyFoliageSeason(
        shrubColor(species, random, stand.tintCentre, maturity),
        species,
        context.season,
        random(),
        y,
        blockSample.slope,
      ),
      selection: random(),
    }));
  }) as readonly DetailShrubPlacement[];
}

/** `R-27`: the understory reads the same weight vector the canopy does. */
function chooseShrubSpecies(sample: DetailTerrainSample, choice: number): ShrubSpecies {
  if (sample.moisture > 0.64) return choice < 0.68 ? "hazel" : "juniper";
  const habitat = landCoverHabitat(classifyDetailSample(sample));
  if (habitat.scrub + habitat.barren > habitat.canopy + habitat.open) {
    return choice < 0.72 ? "juniper" : "sage";
  }
  if (choice < 0.34) return "hazel";
  if (choice < 0.66) return "juniper";
  return "sage";
}

const SHRUB_TINT_BASE: Readonly<Record<ShrubSpecies, readonly [number, number, number]>> = {
  juniper: [0.67, 0.84, 0.7],
  hazel: [0.88, 0.96, 0.62],
  sage: [0.78, 0.84, 0.74],
};

/**
 * 2-12b — the 2-12 tint treatment applied to the understory: the old single
 * scalar was brightness jitter with zero hue variance (the exact flight-test
 * complaint the tree distribution fixed). Real hue variance per species,
 * stand-correlated means through the same tint centre, and young shrubs
 * lighter through maturity. Understory hue spreads wider than canopy
 * (σ 9.5° — mixed-age scrub is less uniform than a closed stand's crowns);
 * juniper/sage keep muted saturation through their base colours.
 */
function shrubColor(
  species: ShrubSpecies,
  random: RandomSource,
  tintCentre: number,
  maturity: number,
): readonly [number, number, number, number] {
  const base = SHRUB_TINT_BASE[species];
  const [baseHue, baseSat, baseVal] = rgbToHsv(base[0], base[1], base[2]);
  const triangular = (): number => random() + random() - 1;
  const hueSigmaTurns = 9.5 / 360;
  const standHueShift = (tintCentre - 0.5) * (14 / 360);
  const hue = baseHue + standHueShift + triangular() * hueSigmaTurns * Math.sqrt(6) * 0.5;
  const saturation = clamp(baseSat * (1 + triangular() * 0.11 * Math.sqrt(6) * 0.5), 0.05, 1);
  const maturityDarkening = (maturity - 0.5) * 0.16;
  const value = clamp(
    baseVal * (1 + triangular() * 0.12 * Math.sqrt(6) * 0.5 - maturityDarkening),
    0.2,
    1.1,
  );
  const [r, g, b] = hsvToRgb(hue, saturation, Math.min(value, 1));
  const gain = value > 1 ? value : 1;
  return [r * gain, g * gain, b * gain, 1];
}

function chooseRockVariant(sample: DetailTerrainSample, random: RandomSource): RockVariant {
  if (sample.biome === TerrainBiome.ALPINE || sample.biome === TerrainBiome.SNOW) {
    return random() < 0.72 ? "granite" : "dark";
  }
  return random() < 0.55 ? "limestone" : random() < 0.82 ? "granite" : "dark";
}

/**
 * `6-7` — the upslope supply probe: how much failure face stands above this
 * point, and how far below it this point is.
 *
 * It walks the FALL LINE, re-reading the surface normal at every step so the
 * path follows the hill rather than a straight bearing taken at the foot. The
 * uphill direction is `(−normal.x, −normal.z)` normalised, because the height
 * field's normal is `(−∂h/∂x, 1, −∂h/∂z)` scaled.
 *
 * It samples `sampleTerrain` DIRECTLY rather than the cell's 16 m scatter
 * grid, deliberately. The grid clamps outside the cell's 40 m halo, so a
 * probe reading it would return a different answer for the same world point
 * depending on which cell was being generated — a seam in the scree, and a
 * placement that changes when a page changes owner. The sampler is a pure
 * function of world position, so this is seamless by construction and is what
 * the km-out determinism test measures.
 *
 * Cost is paid only where scree is possible: `generateRocks` early-outs
 * before calling this whenever the resting band is empty (flat ground, or a
 * face already past repose) or when the candidate's acceptance roll cannot be
 * met even by a saturated apron. A forest or grassland cell therefore probes
 * nothing at all.
 */
const TALUS_PROBE_STEP_METERS = 32;
const TALUS_PROBE_STEPS = 3;

function probeTalusSupply(
  x: number,
  z: number,
  sample: DetailTerrainSample,
  reposeDegrees: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
): TalusSupplyProbe {
  let normalX = sample.normal?.x ?? 0;
  let normalZ = sample.normal?.z ?? 0;
  let probeX = x;
  let probeZ = z;
  let previousHeight = sample.height;
  let travelled = 0;
  let failureReliefMeters = 0;
  let weightedTravel = 0;
  for (let step = 0; step < TALUS_PROBE_STEPS; step += 1) {
    const horizontal = Math.hypot(normalX, normalZ);
    // Flat ground has no fall line: there is nothing above to supply an apron.
    if (!(horizontal > 1e-6)) break;
    probeX -= (normalX / horizontal) * TALUS_PROBE_STEP_METERS;
    probeZ -= (normalZ / horizontal) * TALUS_PROBE_STEP_METERS;
    travelled += TALUS_PROBE_STEP_METERS;
    const upslope = sampleTerrain(probeX, probeZ);
    if (!validSample(upslope)) break;
    const rise = upslope.height - previousHeight;
    previousHeight = upslope.height;
    normalX = upslope.normal?.x ?? 0;
    normalZ = upslope.normal?.z ?? 0;
    // A bench or a col contributes no supply but does not end the walk: the
    // wall above a shoulder still feeds the apron below it.
    if (rise <= 0) continue;
    const contribution = rise * talusFailureFraction(upslope.slope, reposeDegrees);
    if (contribution <= 0) continue;
    failureReliefMeters += contribution;
    weightedTravel += contribution * travelled;
  }
  if (failureReliefMeters <= 0) return TALUS_NO_SUPPLY;
  return {
    failureReliefMeters,
    travelMeters: weightedTravel / failureReliefMeters,
  };
}

function generateRocks(
  seed: string,
  seedHash: number,
  key: string,
  minX: number,
  minZ: number,
  cellSize: number,
  density: number,
  seaLevelMeters: number,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
  season: FoliageSeason,
): readonly DetailRockPlacement[] {
  if (density <= 0) return [];
  const random = createRandom(`${seed}/rocks/${key}`);
  const candidates = Math.min(96, Math.max(12, Math.round((cellSize * cellSize / 2_800) * density)));
  const rocks: DetailRockPlacement[] = [];
  // `sampleTerrainEvolutionGeology` takes a caller-owned target; one scratch
  // record per cell keeps the per-candidate lithology read allocation-free.
  const geology: TerrainEvolutionGeologySample = {
    fabricCos2: 1, fabricSin2: 0, erodibility: 1, reposeDegrees: 34,
  };
  // Season-invariant: the REFERENCE snowline, never the descending seasonal
  // one. A rock that appeared in October would be the calendar popping stems.
  const permanentSnowlineMeters = seaLevelMeters + TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS;
  for (let index = 0; index < candidates; index += 1) {
    const x = minX + random() * cellSize;
    const z = minZ + random() * cellSize;
    const acceptance = random();
    const sample = sampleTerrain(x, z);
    if (!validSample(sample)) continue;
    // Lithology, from the one owned geology sampler. Filter width 0: this is
    // a per-placement read, the full-bandwidth field, exactly as every other
    // per-stem field in this file is read.
    sampleTerrainEvolutionGeology(seedHash, x, z, 0, geology);
    const reposeDegrees = geology.reposeDegrees;
    // Two tests that change COST and never the result. An empty resting band
    // admits no apron at all — `talusPlacement` would return zero density and
    // zero density blends no grain — and a candidate whose roll a SATURATED
    // apron could not clear is already decided. Between them, a forest or
    // grassland cell walks no fall line and reads no soil at all.
    const talus: TalusPlacementSample =
      talusRestWeight(sample.slope, reposeDegrees) > 0
        && acceptance < rockProbability(sample, reposeDegrees, 1)
        ? talusPlacement({
          slope: sample.slope,
          reposeDegrees,
          soilDepthMeters: screeSoilDepthMeters(sample),
          probe: probeTalusSupply(x, z, sample, reposeDegrees, sampleTerrain),
          metersAbovePermanentSnowline: sample.height - permanentSnowlineMeters,
        })
        : TALUS_NO_PLACEMENT;
    if (acceptance >= rockProbability(sample, reposeDegrees, talus.density)) continue;
    const variant = chooseRockVariant(sample, random);
    const radiusRoll = random();
    // Fall sorting, applied in proportion to how much of THIS acceptance the
    // apron paid for. A lag block on the same slope keeps `2-15`'s size law;
    // a block the apron placed takes the apron's grain, which coarsens with
    // travel from the face above. Both read the same roll, so the RNG stream
    // is untouched and a cell with no apron is byte-identical to `2-15`.
    const lagRadius = 0.5 + (0.25 + sample.slope * 0.75) * radiusRoll * 4.2;
    const screeRadius = talus.grainRadiusMeters * (0.55 + radiusRoll * 0.9);
    const apronShare = talusApronShare(sample, reposeDegrees, talus.density);
    const radius = lagRadius + (screeRadius - lagRadius) * apronShare;
    const tint = 0.78 + random() * 0.3;
    const flattening = 0.45 + random() * 0.45;
    const winter = clamp(season.winterFraction + (random() - 0.5) * 0.04, 0, 1);
    const snowed = applySnowCover(
      [tint, tint * (variant === "limestone" ? 1.03 : 0.92), tint * 0.86],
      season,
      winter,
      sample.height,
      sample.slope,
    );
    rocks.push({
      kind: "rock",
      id: `${key}/rock/${index}`,
      variant,
      x,
      // 2-15: sunk by radius·(0.12 + 0.25·hash) so rocks sit IN the ground.
      y: sample.height - radius * flattening * (0.12 + 0.25 * random()),
      z,
      yawRadians: random() * TAU,
      radiusMeters: radius,
      flattening,
      color: [snowed[0], snowed[1], snowed[2], 1],
      selection: random(),
      normal: sample.normal ?? { x: 0, y: 1, z: 0 },
    });
  }
  return rocks;
}

const CLUTTER_KINDS: readonly ClutterKind[] = ["log", "stump", "branchLitter", "mossCushion"];

/**
 * `6-6`: the litter driver, and the one place the soil-depth channel replaces
 * its stand-in.
 *
 * `2-15` shipped `moisture` here with an ARCHITECTURE row calling it "a
 * soil-depth stand-in until 6-6". This returns the real thing when the page
 * channel has provisioned this point and the stand-in when it has not, which
 * is the same optional-input-plus-sentinel shape the splat classifier's
 * `flowAccumulationValid` uses: an analytic world has no soil channel, the
 * sample carries no `soilDepthMeters`, and every downstream number is
 * bit-identical to what it was.
 *
 * The real driver is deliberately WEAKER than the stand-in over the measured
 * soil distribution (crests and rock faces fall to zero litter where the
 * moisture proxy still granted a bonus), which is how the §5.3 "net stem count
 * falls" rule is satisfied: the count of placed clutter goes down, the fidelity
 * of each placement is untouched.
 */
function litterDriver(sample: DetailTerrainSample): number {
  return sample.soilDepthMeters === undefined
    ? sample.moisture
    : soilLitterFactor(sample.soilDepthMeters);
}

export const GROUND_COVER_GRID = 8;

/**
 * 2-16 — the ground-cover habitat grid: WHAT grows at each 16 m node, so
 * the ground layer has variable CHARACTER, not just variable amount. The
 * archetype comes from the terms the field already carries: reeds gated on
 * high moisture and near-zero slope, heather on low fertility and exposure
 * (thin canopy + steep or high ground), fern on shade and shelter (closed
 * canopy + moisture), grass elsewhere. Coverage rides the shoreline and
 * airport clearances (mown grass keeps growing, woody cover does not —
 * ground cover is only SUPPRESSED toward the graded platform, never cut).
 * Season: grass yellows toward straw as winterFraction rises, everything
 * whitens under the snowline through the shared applySnowCover.
 */
function buildGroundCoverGrid(
  context: ScatterContext,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
): readonly import("./types").DetailGroundCoverNode[] {
  const random = createRandom(`${context.seed}/ground-cover/${context.minX}/${context.minZ}`);
  const spacing = context.cellSize / GROUND_COVER_GRID;
  const nodes: import("./types").DetailGroundCoverNode[] = [];
  for (let row = 0; row < GROUND_COVER_GRID; row += 1) {
    for (let column = 0; column < GROUND_COVER_GRID; column += 1) {
      const x = context.minX + (column + 0.5) * spacing;
      const z = context.minZ + (row + 0.5) * spacing;
      const jitter = random();
      const sample = sampleTerrain(x, z);
      if (!validSample(sample) || sample.height <= context.seaLevelMeters + 1) {
        nodes.push({
          coverage: 0,
          archetype: "grass",
          color: [0, 0, 0],
          heightMeters: Number.isFinite(sample.height) ? sample.height : 0,
        });
        continue;
      }
      const field = densityField(context.seedHash, {
        filterWidthMeters: 0,
        x,
        z,
        heightMeters: sample.height,
        seaLevelMeters: context.seaLevelMeters,
        slope: sample.slope,
        moisture: sample.moisture,
        dayOfYear: context.dayOfYear,
        ...(sample.normal ? { normalX: sample.normal.x, normalZ: sample.normal.z } : {}),
        ...(sample.airportInfluence !== undefined
          ? { airportInfluence: sample.airportInfluence }
          : {}),
        ...(sample.shoreDistanceMeters !== undefined
          ? { shoreDistanceMeters: sample.shoreDistanceMeters }
          : {}),
      });
      const closure = clamp(field.treeStemsPerSquareMeter / 0.05, 0, 1);
      const rocky = sample.biome === TerrainBiome.ALPINE || sample.biome === TerrainBiome.SNOW;
      const beach = sample.biome === TerrainBiome.BEACH;
      const coverage = rocky || beach
        ? 0
        : clamp(0.35 + sample.moisture * 0.5 + closure * 0.15, 0, 1)
          // Mown, not bare: the apron keeps ~40% of its cover (1B-6).
          * (1 - 0.6 * clamp(sample.airportInfluence ?? 0, 0, 1))
          * riparianVegetationFactors(sample.shoreDistanceMeters).clearance;
      const exposure = clamp(
        (sample.height - context.seaLevelMeters) / 900 + sample.slope * 1.6,
        0,
        1,
      );
      // 6-6, the species half of the shore-distance channel: reeds are a
      // water-EDGE species and streamside ferns do not need a closed canopy.
      // Until now both keyed on the climatic moisture proxy alone, so a reed
      // bed grew on any wet flat ground and never along a river. The band is
      // the density field's own corridor shape (`riparianBand`), so placement
      // and appearance cannot disagree about where the bank is; it is exactly
      // 0 wherever hydrology has not provisioned the point, which leaves
      // analytic worlds bit-identical.
      const bank = field.riparianBand;
      const archetype: import("./types").GroundCoverArchetype =
        (sample.moisture > 0.72 || bank > 0.35) && sample.slope < 0.06 ? "reed"
        : (closure > 0.45 && sample.moisture > 0.5) || (bank > 0.2 && closure > 0.18)
          ? "fern"
        : closure < 0.2 && exposure > 0.55 ? "heather"
        : "grass";
      // Habitat tint: wet ground deepens green, dry ground bleaches; grass
      // yellows toward straw with the season; snow whitens everything.
      const straw = archetype === "grass" || archetype === "reed"
        ? smootherStep(0.25, 0.7, context.season.winterFraction)
        : smootherStep(0.45, 0.85, context.season.winterFraction) * 0.5;
      const wet = clamp(sample.moisture, 0, 1);
      const baseColor: [number, number, number] = archetype === "fern"
        ? [0.34, 0.5, 0.3]
        : archetype === "heather"
          ? [0.5, 0.44, 0.5]
          : archetype === "reed"
            ? [0.55, 0.58, 0.38]
            : [0.42 + (1 - wet) * 0.18, 0.56 + wet * 0.1, 0.3];
      const jittered: [number, number, number] = [
        clamp(baseColor[0] * (0.9 + jitter * 0.2), 0, 1),
        clamp(baseColor[1] * (0.9 + jitter * 0.2), 0, 1),
        clamp(baseColor[2] * (0.9 + jitter * 0.2), 0, 1),
      ];
      const strawed: [number, number, number] = [
        jittered[0] + (0.72 - jittered[0]) * straw,
        jittered[1] + (0.62 - jittered[1]) * straw,
        jittered[2] + (0.34 - jittered[2]) * straw,
      ];
      const snowed = applySnowCover(
        strawed,
        context.season,
        context.season.winterFraction,
        sample.height,
        sample.slope,
      );
      nodes.push({
        coverage,
        archetype,
        color: [snowed[0], snowed[1], snowed[2]],
        heightMeters: sample.height,
      });
    }
  }
  return nodes;
}

/**
 * 2-15 — ground clutter: the debris layer no plan document placed anywhere
 * ("twigs, mess"). Density rides CANOPY CLOSURE through the density field
 * (clutter belongs under trees) with a moisture bonus standing in for soil
 * depth until 6-6's ecology channels exist — a wet hollow under closed
 * canopy carries ~6× the litter of open grassland. Moss cushions require
 * moisture; their share redistributes to branch litter on dry ground.
 * Budget: ~30 accepted per closed-forest 128 m cell ≈ the plan's ~2,000
 * instances over a Balanced near field, ~80 k triangles.
 */
function scatterClutter(
  context: ScatterContext,
  sampleTerrain: DetailCellGenerationOptions["terrainSample"],
): readonly DetailClutterPlacement[] {
  const random = createRandom(`${context.seed}/clutter/${detailCellKey(
    Math.round(context.minX / context.cellSize),
    Math.round(context.minZ / context.cellSize),
  )}`);
  const candidates = Math.min(
    72,
    Math.max(8, Math.round((context.cellSize * context.cellSize / 380) * context.density)),
  );
  const placements: DetailClutterPlacement[] = [];
  for (let index = 0; index < candidates; index += 1) {
    const x = context.minX + random() * context.cellSize;
    const z = context.minZ + random() * context.cellSize;
    const acceptance = random();
    const kindRoll = random();
    const sizeRoll = random();
    const yaw = random() * TAU;
    const selection = random();
    const valueJitter = 0.82 + random() * 0.3;
    const sample = sampleTerrain(x, z);
    if (!validSample(sample)) continue;
    const field = densityField(context.seedHash, {
      filterWidthMeters: 0,
      x,
      z,
      heightMeters: sample.height,
      seaLevelMeters: context.seaLevelMeters,
      slope: sample.slope,
      moisture: sample.moisture,
      dayOfYear: context.dayOfYear,
      ...(sample.normal ? { normalX: sample.normal.x, normalZ: sample.normal.z } : {}),
      ...(sample.airportInfluence !== undefined
        ? { airportInfluence: sample.airportInfluence }
        : {}),
      ...(sample.shoreDistanceMeters !== undefined
        ? { shoreDistanceMeters: sample.shoreDistanceMeters }
        : {}),
    });
    // Canopy closure proxy: closed forest carries ~0.05 stems/m².
    const closure = clamp(field.treeStemsPerSquareMeter / 0.05, 0, 1);
    // 6-6: `litterDriver` is the soil-depth channel where it exists and the
    // 2-15 moisture stand-in where it does not.
    const litter = litterDriver(sample);
    const probability = airportClearance(sample)
      * riparianVegetationFactors(sample.shoreDistanceMeters).clearance
      * (0.06 + closure * 0.5 + litter * 0.12);
    if (acceptance >= probability) continue;
    // Moss cushions need a substrate to sit on, not just humid air: real soil
    // depth replaces the moisture gate wherever the channel supplies it.
    const wetEnough = sample.soilDepthMeters === undefined
      ? sample.moisture >= 0.55
      : litter >= 0.55;
    const kind: ClutterKind = kindRoll < 0.2 ? "log"
      : kindRoll < 0.35 ? "stump"
      : kindRoll < 0.8 || !wetEnough ? "branchLitter"
      : "mossCushion";
    const size = kind === "log" ? 2.4 + sizeRoll * 2.2
      : kind === "stump" ? 0.8 + sizeRoll * 0.8
      : kind === "branchLitter" ? 1.2 + sizeRoll * 1.4
      : 0.8 + sizeRoll * 1.4;
    const base: readonly [number, number, number] = kind === "mossCushion"
      ? [0.5 * valueJitter, 0.72 * valueJitter, 0.42 * valueJitter]
      : [0.72 * valueJitter, 0.66 * valueJitter, 0.56 * valueJitter];
    const snowed = applySnowCover(base, context.season, context.season.winterFraction, sample.height, sample.slope);
    placements.push({
      kind: "clutter",
      id: `${context.seed}/clutter/${index}/${x.toFixed(1)}/${z.toFixed(1)}`,
      clutterKind: kind,
      x,
      y: sample.height,
      z,
      yawRadians: yaw,
      sizeMeters: size,
      color: [snowed[0], snowed[1], snowed[2], 1],
      selection,
      normal: sample.normal ?? { x: 0, y: 1, z: 0 },
    });
  }
  return placements;
}

/** Deterministically regenerate one cell without reading or mutating global state. */
export function generateDetailCell(options: DetailCellGenerationOptions): GeneratedDetailCell {
  const cellX = requireSafeInteger(options.cellX, "Detail cell x");
  const cellZ = requireSafeInteger(options.cellZ, "Detail cell z");
  const cellSizeMeters = options.cellSizeMeters ?? DEFAULT_DETAIL_CELL_SIZE_METERS;
  const densityMultiplier = options.densityMultiplier ?? 1;
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters < 64 || cellSizeMeters > 4_096) {
    throw new RangeError("Detail cell size must be between 64 and 4096 metres");
  }
  if (!Number.isFinite(densityMultiplier) || densityMultiplier < 0 || densityMultiplier > 2) {
    throw new RangeError("Detail density multiplier must be between 0 and 2");
  }

  const seed = String(options.worldSeed);
  const seedHash = hashSeed(seed);
  const key = detailCellKey(cellX, cellZ);
  const minX = cellX * cellSizeMeters;
  const minZ = cellZ * cellSizeMeters;
  const seaLevelMeters = options.seaLevelMeters ?? 0;
  if (!Number.isFinite(seaLevelMeters)) {
    throw new RangeError("Detail sea level must be finite");
  }
  const dayOfYear = options.dayOfYear ?? 0;
  const latitudeDegrees = options.latitudeDegrees ?? 45;
  if (!Number.isFinite(latitudeDegrees) || Math.abs(latitudeDegrees) > 90) {
    throw new RangeError("Detail latitude must be within [-90, 90] degrees");
  }
  const grid = buildScatterTerrainGrid(minX, minZ, cellSizeMeters, options.terrainSample);
  const context: ScatterContext = {
    seed,
    seedHash,
    structureExclusions: options.structureExclusions ?? [],
    exclusionAirport: options.exclusionAirport,
    minX,
    minZ,
    cellSize: cellSizeMeters,
    density: densityMultiplier,
    seaLevelMeters,
    dayOfYear,
    season: {
      winterFraction: seasonalWinterFraction(dayOfYear, latitudeDegrees),
      snowlineMeters: seaLevelMeters + TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS
        - seasonalSnowlineDescentMeters(dayOfYear, latitudeDegrees),
    },
    grid,
  };
  return {
    key,
    cellX,
    cellZ,
    cellSizeMeters,
    minX,
    minZ,
    maxX: minX + cellSizeMeters,
    maxZ: minZ + cellSizeMeters,
    trees: densityMultiplier > 0 ? scatterTrees(context) : [],
    shrubs: densityMultiplier > 0 ? scatterShrubs(context) : [],
    clutter: densityMultiplier > 0 ? scatterClutter(context, options.terrainSample) : [],
    groundCover: densityMultiplier > 0
      ? buildGroundCoverGrid(context, options.terrainSample)
      : [],
    rocks: generateRocks(
      seed,
      seedHash,
      key,
      minX,
      minZ,
      cellSizeMeters,
      densityMultiplier,
      seaLevelMeters,
      options.terrainSample,
      context.season,
    ),
  };
}

export function detailCellKey(cellX: number, cellZ: number): string {
  requireSafeInteger(cellX, "Detail cell x");
  requireSafeInteger(cellZ, "Detail cell z");
  return `${cellX}:${cellZ}`;
}
