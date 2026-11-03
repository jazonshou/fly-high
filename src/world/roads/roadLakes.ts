import {
  generateHydrologyLakesNear,
  resolveHydrologyConfig,
  type HydrologyBounds,
  type HydrologyLake,
} from "@/src/render/webgpu/water/HydrologyGeneration";
import { volcanicHydrologyInputs } from "@/src/render/webgpu/water/hydrologyVolcanism";
import { withAirports } from "../airportNetwork";
import { withStaticInfrastructure } from "../infrastructure";
import { sampleTerrain } from "../terrain";
import type { TerrainSample, WorldDefinition } from "../types";

/**
 * Lakes as the road generator sees them: walls, each the lake's shore polygon
 * grown by `ROAD_LAKE_SHORE_MARGIN_METERS`.
 *
 * The network is a pure function of the terrain identity, so the lakes it
 * keeps out of must be too, and the lakes the water system draws are not:
 * hydrology generates the regions round where the aircraft has been. Here
 * the lakes come from `generateHydrologyLakesNear`, which asks the ground
 * rather than the paging: every lake ANY hydrology region could keep whose
 * shore reaches a fixed `ROAD_LAKE_TILE_METERS` tile (grown by the margin),
 * built field for field as that region builds it, on the ground hydrology
 * reads (the stage's static sources and the home field only, the uncarved
 * staged surface, as the hydrology worker samples it). A point's wall reads
 * its own tile's lakes, so it is the same whichever road region asks and
 * wherever the player has been (`tests/world.roads-lakes.test.ts`).
 *
 * Eroded worlds have no roads and take their water from the channel graph.
 * Rivers are not walls: the analytic tracer lays none today, and fords over
 * them wait for one.
 */

/** A lake tile's edge, metres: four road regions, so one lake query serves sixteen. */
export const ROAD_LAKE_TILE_METERS = 8_192;

/**
 * How far past a lake's shore polygon the wall stands, metres: a sealed
 * formation's half width (5 m) and its fill batter down towards the water,
 * the routing grid's corner cutting, and the shore's chords between the
 * polygon's 32 vertices.
 */
export const ROAD_LAKE_SHORE_MARGIN_METERS = 30;

interface RoadLakeWall {
  readonly lake: HydrologyLake;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly xs: Float64Array;
  readonly zs: Float64Array;
}

interface RoadLakeTiles {
  readonly tiles: Map<string, readonly RoadLakeWall[]>;
  lastX: number;
  lastZ: number;
  last: readonly RoadLakeWall[] | null;
}

const TILES = new WeakMap<WorldDefinition, RoadLakeTiles>();
const NO_WALLS: readonly RoadLakeWall[] = Object.freeze([]);

function tilesOf(world: WorldDefinition): RoadLakeTiles {
  let tiles = TILES.get(world);
  if (!tiles) {
    tiles = { tiles: new Map(), lastX: Number.NaN, lastZ: Number.NaN, last: null };
    TILES.set(world, tiles);
  }
  return tiles;
}

function wallOf(lake: HydrologyLake): RoadLakeWall {
  const count = lake.boundary.length;
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const point = lake.boundary[index]!;
    xs[index] = point.x;
    zs[index] = point.z;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const margin = ROAD_LAKE_SHORE_MARGIN_METERS;
  return Object.freeze({
    lake,
    minX: minX - margin,
    maxX: maxX + margin,
    minZ: minZ - margin,
    maxZ: maxZ + margin,
    xs,
    zs,
  });
}

function tileBounds(tx: number, tz: number): HydrologyBounds {
  const margin = ROAD_LAKE_SHORE_MARGIN_METERS;
  return {
    minX: tx * ROAD_LAKE_TILE_METERS - margin,
    maxX: (tx + 1) * ROAD_LAKE_TILE_METERS + margin,
    minZ: tz * ROAD_LAKE_TILE_METERS - margin,
    maxZ: (tz + 1) * ROAD_LAKE_TILE_METERS + margin,
  };
}

/**
 * The lakes whose shore, grown by the margin, reaches tile (tx, tz): what
 * hydrology could draw there, read from the ground alone.
 */
export function roadLakesInTile(world: WorldDefinition, tx: number, tz: number): readonly HydrologyLake[] {
  return wallsInTile(world, tx, tz).map((wall) => wall.lake);
}

function wallsInTile(world: WorldDefinition, tx: number, tz: number): readonly RoadLakeWall[] {
  if (world.worldEvolution === "eroded") return NO_WALLS;
  const cache = tilesOf(world);
  const key = `${tx}:${tz}`;
  const known = cache.tiles.get(key);
  if (known) return known;
  const bounds = tileBounds(tx, tz);
  // The regions' config (only the sea level differs from the defaults), so
  // the source lattice is theirs; the window is only where the inputs are read.
  const options = {
    seaLevel: world.seaLevel,
    centerX: (bounds.minX + bounds.maxX) * 0.5,
    centerZ: (bounds.minZ + bounds.maxZ) * 0.5,
  };
  const config = resolveHydrologyConfig(options);
  // The volcanic inputs for the box the lakes are drawn from: the tile grown
  // by a lake radius, and by two trace steps more so the porous test covers
  // every source the query reads.
  const inputsExtent = bounds.maxX - bounds.minX
    + 2 * (config.maximumLakeRadiusMeters + 2 * config.traceStepMeters);
  const home = withAirports(world, world.airport ? [world.airport] : []);
  const sample = terrainSampleTarget();
  const lakes = withStaticInfrastructure(() => generateHydrologyLakesNear({
    ...options,
    ...volcanicHydrologyInputs(home, { ...config, extentMeters: inputsExtent }),
    worldSeed: home.seed,
    terrainSample: (x, z) => {
      const point = sampleTerrain(home, x, z, sample);
      return { height: point.height, moisture: point.moisture, ergWeight: point.ergWeight };
    },
  }, bounds));
  const walls = lakes.length === 0 ? NO_WALLS : Object.freeze(lakes.map(wallOf));
  cache.tiles.set(key, walls);
  return walls;
}

function insideOrNear(wall: RoadLakeWall, x: number, z: number): boolean {
  const { xs, zs } = wall;
  const count = xs.length;
  const margin2 = ROAD_LAKE_SHORE_MARGIN_METERS * ROAD_LAKE_SHORE_MARGIN_METERS;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const ax = xs[i]!;
    const az = zs[i]!;
    const bx = xs[j]!;
    const bz = zs[j]!;
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const ex = x - ax - t * dx;
    const ez = z - az - t * dz;
    if (ex * ex + ez * ez <= margin2) return true;
  }
  return inside;
}

/** Is (x, z) on a lake or within the shore margin of one? Allocates nothing once its tile is known. */
export function roadLakeWallAt(world: WorldDefinition, x: number, z: number): boolean {
  if (world.worldEvolution === "eroded") return false;
  const cache = tilesOf(world);
  const tx = Math.floor(x / ROAD_LAKE_TILE_METERS);
  const tz = Math.floor(z / ROAD_LAKE_TILE_METERS);
  let walls = cache.last;
  if (walls === null || tx !== cache.lastX || tz !== cache.lastZ) {
    walls = wallsInTile(world, tx, tz);
    cache.last = walls;
    cache.lastX = tx;
    cache.lastZ = tz;
  }
  for (const wall of walls) {
    if (x < wall.minX || x > wall.maxX || z < wall.minZ || z > wall.maxZ) continue;
    if (insideOrNear(wall, x, z)) return true;
  }
  return false;
}

function terrainSampleTarget(): TerrainSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0,
    moisture: 0,
    temperature: 0,
    temperatureOffset: 0,
    dryness: 0,
    sandCover: 0,
    ergWeight: 0,
    biome: 0,
    biomeName: "water",
    color: { r: 0, g: 0, b: 0 },
    airportInfluence: 0,
    isRunway: false,
  };
}
