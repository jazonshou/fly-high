import { flattenHeightForAirport, getAirportInfluence, isPointOnRunway } from "./airport";
import { sampleGeologicalRelief } from "./geology";
import {
  blendTowardExpectation,
  clamp,
  fbm2D,
  filteredValueNoise2D,
  lerp,
  ridgedChannelVarianceKept,
  ridgedFbm2D,
  saturate,
  smoothstep,
  valueNoise2D,
} from "./noise";
import { mixSeed } from "./seed";
import {
  TERRAIN_BIOME_NAMES,
  TerrainBiome,
  type TerrainCollisionSample,
  type TerrainBiomeId,
  type TerrainColor,
  type TerrainSample,
  type WorldDefinition,
  type WorldVector3,
} from "./types";

export const MIN_TERRAIN_HEIGHT = -180;
export const MAX_TERRAIN_HEIGHT = 2_200;
export const TERRAIN_NORMAL_SAMPLE_DISTANCE = 2;

/**
 * Full-bandwidth expectations of the kernel's nonlinear ridge composites,
 * measured numerically over 250k samples spanning ~2000 lattice cells (2026-08-17). As a
 * channel's texture fades under band-limiting, each composite blends toward
 * its expectation (see blendTowardExpectation) so coarse pages keep the same
 * mean height as fine ones — pow() and threshold smoothsteps otherwise lose
 * several metres of mean uplift per LOD (the amplitudeSum trap's quieter
 * sibling).
 */
const RIDGES_POW_212_MEAN = 0.2125;
const RIDGES_POW_158_MEAN = 0.299;
const RIDGES_INVERSE_POW_31_MEAN = 0.2072;
const RIDGES_SMOOTH_42_82_MEAN = 0.1965;
const LOCAL_RIDGES_KNOLL_MEAN = 0.1534;

function assertFiniteCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

function assertFilterWidth(filterWidthMeters: number): void {
  if (!Number.isFinite(filterWidthMeters) || filterWidthMeters < 0) {
    throw new RangeError("filterWidthMeters must be finite and non-negative");
  }
}

/**
 * The natural (pre-airport) terrain kernel. It deliberately operates only on
 * global coordinates and a uint32 seed, so workers and collision code can share
 * it without any renderer state.
 *
 * SOLE HEIGHT AUTHORITY (§1.3). Until 5-2, this function is the one producer
 * of terrain shape for both physics (through src/sim/terrainGrid.ts) and
 * rendering (through tile generation), so the surfaces agree by construction.
 * At 5-2 the eroded GPU grid becomes the authority and this kernel survives
 * only as (a) the tectonic uplift input to erosion and (b) the above-500 m-AGL
 * collision fallback. Do not add other height producers.
 *
 * `filterWidthMeters` is the half-width of the sampling footprint. Phase 0
 * threads it as a required positional parameter and ignores it — a behavioural
 * no-op — so that 1B-2's band-limiting is a diff inside two functions instead
 * of a simultaneous signature-and-behaviour change across every call site.
 * Positional and required on purpose: this kernel runs ~181 times per vertex,
 * so an options object would allocate in the hottest loop in the codebase, and
 * a defaulted parameter would let a call site silently reintroduce the horizon
 * crawl. Collision keeps 0 (the full-bandwidth kernel) forever.
 */
export function sampleNaturalTerrainHeight(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(z, "z");
  assertFilterWidth(filterWidthMeters);

  const warpScale = 1 / 18_000;
  const warpX =
    filteredValueNoise2D(mixSeed(seedHash, 101), x * warpScale, z * warpScale, 18_000, filterWidthMeters) * 2_400;
  const warpZ =
    filteredValueNoise2D(mixSeed(seedHash, 102), x * warpScale + 19.4, z * warpScale - 7.7, 18_000, filterWidthMeters) * 2_400;
  const warpedX = x + warpX;
  const warpedZ = z + warpZ;

  const continental =
    fbm2D(mixSeed(seedHash, 110), warpedX / 8_600, warpedZ / 8_600, 4, 2.01, 0.52, 8_600, filterWidthMeters) * 0.5 +
    0.5;
  const land = smoothstep(0.38, 0.57, continental);
  const continentalShelf = lerp(-105, 135, smoothstep(0.2, 0.8, continental));

  const rolling =
    fbm2D(mixSeed(seedHash, 120), warpedX / 1_650, warpedZ / 1_650, 5, 2, 0.48, 1_650, filterWidthMeters);
  const fine = fbm2D(mixSeed(seedHash, 121), x / 310, z / 310, 3, 2.04, 0.46, 310, filterWidthMeters);

  const mountainField =
    fbm2D(mixSeed(seedHash, 130), warpedX / 13_500, warpedZ / 13_500, 3, 2, 0.55, 13_500, filterWidthMeters) * 0.5 +
    0.5;
  // A broad foothill mask precedes the rarer high-alpine mask. The old kernel
  // only emitted meaningful relief when the latter happened to cross a high
  // threshold, which left otherwise valid seeds visually indistinguishable
  // from a flat plane for tens of kilometres around the starter airport.
  const foothillRegion = smoothstep(0.34, 0.7, mountainField);
  const mountainRegion = smoothstep(0.47, 0.76, mountainField);
  const ridges =
    ridgedFbm2D(mixSeed(seedHash, 131), warpedX / 2_550, warpedZ / 2_550, 5, 2_550, filterWidthMeters);
  const localRidges =
    ridgedFbm2D(mixSeed(seedHash, 132), warpedX / 1_050, warpedZ / 1_050, 4, 1_050, filterWidthMeters);
  const ridgesKept = ridgedChannelVarianceKept(5, 2_550, filterWidthMeters);
  const localRidgesKept = ridgedChannelVarianceKept(4, 1_050, filterWidthMeters);
  const foothillHeight = land * foothillRegion
    * blendTowardExpectation(Math.pow(Math.max(0, ridges), 2.12), RIDGES_POW_212_MEAN, ridgesKept)
    * 285;
  const mountainHeight = land * mountainRegion
    * blendTowardExpectation(Math.pow(Math.max(0, ridges), 1.58), RIDGES_POW_158_MEAN, ridgesKept)
    * 1_390;

  // Mid-scale relief stops broad mountain masks from becoming smooth domes.
  // It is strongest around existing uplift, preserving recognizable plains
  // and coastlines while carving shoulders, gullies, and secondary summits.
  const rockyKnolls =
    land *
    (0.34 + foothillRegion * 0.66) *
    blendTowardExpectation(
      Math.pow(Math.max(0, smoothstep(0.3, 0.86, localRidges)), 2.25),
      LOCAL_RIDGES_KNOLL_MEAN,
      localRidgesKept,
    ) *
    (72 + foothillRegion * 115);
  // (localRidges - 0.48) is linear in the channel, hence already unbiased.
  const cragDetail =
    land *
    mountainRegion *
    blendTowardExpectation(smoothstep(0.42, 0.82, ridges), RIDGES_SMOOTH_42_82_MEAN, ridgesKept) *
    (localRidges - 0.48) *
    360;
  const valleyCarve =
    land * foothillRegion
    * blendTowardExpectation(
      Math.pow(Math.max(0, 1 - ridges), 3.1),
      RIDGES_INVERSE_POW_31_MEAN,
      ridgesKept,
    )
    * (55 + mountainRegion * 105);
  const geologicalRelief = sampleGeologicalRelief(
    seedHash,
    warpedX,
    warpedZ,
    filterWidthMeters,
    land,
    foothillRegion,
    mountainRegion,
  );

  // Plains occur naturally where mountainRegion is low; hills become stronger
  // inland while coastlines retain gentler slopes.
  const hillStrength = land * (34 + 96 * (1 - mountainRegion * 0.55));
  const height =
    continentalShelf +
    rolling * hillStrength +
    fine * (5 + land * 12) +
    rockyKnolls +
    foothillHeight +
    mountainHeight +
    cragDetail -
    valleyCarve +
    geologicalRelief;
  return clamp(height, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
}

/** Fast collision-query path: only computes terrain elevation. */
export function sampleTerrainHeight(world: WorldDefinition, x: number, z: number): number {
  // Physics and collision always sample the full-bandwidth kernel (width 0).
  const naturalHeight = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
  return flattenHeightForAirport(naturalHeight, world.airport, x, z);
}

/**
 * Render-path height with band-limiting (1B-2): the tile generator passes
 * its grid spacing so a coarse mesh is a blurred version of the fine one,
 * not a re-rolled point-sampling of sub-Nyquist octaves. Physics and
 * collision never call this — they keep the width-0 kernel forever.
 */
export function sampleFilteredTerrainHeight(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  const naturalHeight = sampleNaturalTerrainHeight(world.seedHash, x, z, filterWidthMeters);
  return flattenHeightForAirport(naturalHeight, world.airport, x, z);
}

/** Height-only physics path with a zero-noise fast path on the flat airport platform. */
export function sampleTerrainCollisionHeight(
  world: WorldDefinition,
  x: number,
  z: number,
): number {
  if (
    world.airport &&
    getAirportInfluence(world.airport, x, z) >= 1
  ) {
    return world.airport.elevation;
  }
  return sampleTerrainHeight(world, x, z);
}

/**
 * COLLISION ONLY (1B-1). The 2 m central difference is the right footprint
 * for wheels and the crash solver, and the wrong one for every render LOD:
 * uploaded at 128 m spacing it produced 24–35° mean shading error with 3.4%
 * of normals pointing into the surface. Render normals come from the tile's
 * own grid in src/world/tile.ts — do not reintroduce this into any render
 * path. It reaches physics through src/sim/terrainGrid.ts.
 */
export function sampleTerrainNormal(
  world: WorldDefinition,
  x: number,
  z: number,
  target: WorldVector3 = { x: 0, y: 1, z: 0 },
): WorldVector3 {
  const delta = TERRAIN_NORMAL_SAMPLE_DISTANCE;
  const left = sampleTerrainHeight(world, x - delta, z);
  const right = sampleTerrainHeight(world, x + delta, z);
  const back = sampleTerrainHeight(world, x, z - delta);
  const front = sampleTerrainHeight(world, x, z + delta);
  const gradientX = (right - left) / (2 * delta);
  const gradientZ = (front - back) / (2 * delta);
  const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
  target.x = -gradientX * inverseLength;
  target.y = inverseLength;
  target.z = -gradientZ * inverseLength;
  return target;
}

function createTerrainCollisionTarget(): TerrainCollisionSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    isRunway: false,
    friction: 0.86,
  };
}

/**
 * Collision-only terrain sample. It preserves the full sampler's elevation,
 * normal, runway classification, and physics friction semantics without
 * evaluating moisture, temperature, biome noise, airport tint, or color.
 */
export function sampleTerrainCollision(
  world: WorldDefinition,
  x: number,
  z: number,
  target: TerrainCollisionSample = createTerrainCollisionTarget(),
): TerrainCollisionSample {
  const runway = world.airport ? isPointOnRunway(world.airport, x, z) : false;
  if (runway && world.airport) {
    target.height = world.airport.elevation;
    target.normal.x = 0;
    target.normal.y = 1;
    target.normal.z = 0;
    target.isRunway = true;
    target.friction = 1.18;
    return target;
  }
  const height = sampleTerrainHeight(world, x, z);
  sampleTerrainNormal(world, x, z, target.normal);
  target.height = height;
  target.isRunway = runway;
  target.friction = runway ? 1.18 : height <= world.seaLevel ? 0.05 : 0.86;
  return target;
}

export function sampleTerrainMoisture(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFilterWidth(filterWidthMeters);
  const broad = fbm2D(mixSeed(world.seedHash, 201), x / 5_200, z / 5_200, 4, 2, 0.52);
  const local = valueNoise2D(mixSeed(world.seedHash, 202), x / 850, z / 850);
  // Elongated rain-shadow provinces break the old near-uniform moisture field
  // into wet watersheds, dry uplands, and transitional ecological corridors.
  const rainShadow = valueNoise2D(
    mixSeed(world.seedHash, 203),
    (x + z * 0.42) / 18_000,
    (z - x * 0.42) / 9_500,
  );
  return saturate(0.5 + broad * 0.37 + local * 0.13 + rainShadow * 0.17);
}

export function sampleTerrainTemperature(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  height = sampleTerrainHeight(world, x, z),
): number {
  assertFilterWidth(filterWidthMeters);
  const climate = fbm2D(mixSeed(world.seedHash, 211), x / 11_000, z / 11_000, 3, 2, 0.5);
  const elevationCooling = Math.max(0, height - world.seaLevel) / 2_450;
  return saturate(0.66 + climate * 0.2 - elevationCooling);
}

function classifyBiome(
  world: WorldDefinition,
  height: number,
  slope: number,
  moisture: number,
  temperature: number,
  runway: boolean,
): TerrainBiomeId {
  if (runway) return TerrainBiome.RUNWAY;
  if (height <= world.seaLevel) return TerrainBiome.WATER;
  if (height <= world.seaLevel + 8 && slope < 0.32) return TerrainBiome.BEACH;
  if (temperature < 0.2 || height > world.seaLevel + 1_520) return TerrainBiome.SNOW;
  if (height > world.seaLevel + 920 || (slope > 0.48 && height > world.seaLevel + 460)) {
    return TerrainBiome.ALPINE;
  }
  if (height > world.seaLevel + 390 || slope > 0.28) return TerrainBiome.HIGHLAND;
  if (moisture > 0.55 && temperature > 0.24) return TerrainBiome.FOREST;
  return TerrainBiome.GRASSLAND;
}

const PALETTES: Readonly<Record<TerrainBiomeId, readonly [number, number, number]>> = {
  [TerrainBiome.WATER]: [0.08, 0.19, 0.25],
  [TerrainBiome.BEACH]: [0.68, 0.605, 0.425],
  [TerrainBiome.GRASSLAND]: [0.29, 0.445, 0.215],
  [TerrainBiome.FOREST]: [0.115, 0.275, 0.15],
  [TerrainBiome.HIGHLAND]: [0.335, 0.345, 0.255],
  [TerrainBiome.ALPINE]: [0.405, 0.405, 0.385],
  [TerrainBiome.SNOW]: [0.825, 0.855, 0.865],
  [TerrainBiome.RUNWAY]: [0.16, 0.18, 0.19],
};

function writeTerrainColor(
  world: WorldDefinition,
  x: number,
  z: number,
  biome: TerrainBiomeId,
  moisture: number,
  slope: number,
  target: TerrainColor,
): TerrainColor {
  const palette = PALETTES[biome];
  const fineVariation = valueNoise2D(mixSeed(world.seedHash, 230), x / 76, z / 76);
  const broadVariation = valueNoise2D(mixSeed(world.seedHash, 231), x / 680, z / 680);
  const variation =
    fineVariation * 0.035 +
    broadVariation * 0.035 +
    (moisture - 0.5) * (biome === TerrainBiome.GRASSLAND ? -0.06 : -0.025) -
    slope * 0.06;
  const rockBiome = biome === TerrainBiome.HIGHLAND || biome === TerrainBiome.ALPINE;
  // Mineral variation is world-horizontal noise rather than a function of
  // elevation.  Equal-height sine strata produced visible contour/scan lines
  // over medium-distance hills.
  const rockMottle = rockBiome
    ? valueNoise2D(
      mixSeed(world.seedHash, 232),
      x / 118 + broadVariation * 1.7,
      z / 154 - broadVariation * 1.3,
    ) * slope * 0.05
    : 0;
  const warmVariation = broadVariation * (rockBiome ? 0.026 : 0.012);
  target.r = saturate(palette[0] + variation + rockMottle + warmVariation);
  target.g = saturate(palette[1] + variation + rockMottle * 0.64);
  target.b = saturate(palette[2] + variation - rockMottle * 0.18 - warmVariation);
  return target;
}

function createTerrainSampleTarget(): TerrainSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0,
    moisture: 0,
    temperature: 0,
    biome: TerrainBiome.GRASSLAND,
    biomeName: "grassland",
    color: { r: 0, g: 0, b: 0 },
    airportInfluence: 0,
    isRunway: false,
  };
}

/**
 * Classification and appearance for a point whose height and slope are
 * already known (1B-1). The tile path computes slope from its own grid
 * normal — at the tile's spacing — and must classify from that same slope,
 * or rock and scree colour at 40 km is assigned by 4 m microslope. Fills
 * everything on the target except `normal`.
 */
export function sampleTerrainSurface(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  slope: number,
  target: TerrainSample,
): TerrainSample {
  const moisture = sampleTerrainMoisture(world, x, z, 0);
  const temperature = sampleTerrainTemperature(world, x, z, 0, height);
  const runway = world.airport ? isPointOnRunway(world.airport, x, z) : false;
  const biome = classifyBiome(world, height, slope, moisture, temperature, runway);

  target.height = height;
  target.slope = slope;
  target.moisture = moisture;
  target.temperature = temperature;
  target.biome = biome;
  target.biomeName = TERRAIN_BIOME_NAMES[biome];
  target.airportInfluence = world.airport ? getAirportInfluence(world.airport, x, z) : 0;
  target.isRunway = runway;
  writeTerrainColor(world, x, z, biome, moisture, slope, target.color);
  return target;
}

/** Full visual/climate sample. Supply a reusable target to avoid allocations. */
export function sampleTerrain(
  world: WorldDefinition,
  x: number,
  z: number,
  target: TerrainSample = createTerrainSampleTarget(),
): TerrainSample {
  const height = sampleTerrainHeight(world, x, z);
  sampleTerrainNormal(world, x, z, target.normal);
  const slope = saturate(1 - target.normal.y);
  return sampleTerrainSurface(world, x, z, height, slope, target);
}
