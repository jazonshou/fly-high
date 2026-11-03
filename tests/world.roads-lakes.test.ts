import { describe, expect, it } from "vitest";
import {
  generateHydrology,
  resolveHydrologyConfig,
  type HydrologyLake,
} from "../src/render/webgpu/water/HydrologyGeneration";
import { resolveHydrologyPagingConfig } from "../src/render/webgpu/water/HydrologyPaging";
import { volcanicHydrologyInputs } from "../src/render/webgpu/water/hydrologyVolcanism";
import { createWorld, sampleTerrain, type WorldDefinition } from "../src/world";
import { withStaticInfrastructure } from "../src/world/infrastructure";
import {
  ROAD_LAKE_SHORE_MARGIN_METERS,
  ROAD_LAKE_TILE_METERS,
  roadLakeWallAt,
  roadLakesInTile,
} from "../src/world/roads/roadLakes";
import { ROAD_LAYERS, RoadNetwork, roadRegionOf } from "../src/world/roads/roadNetwork";
import { RoadGround, roadGroundAt, roadGroundHeight } from "../src/world/roads/roadTerrain";

/**
 * Lakes are walls to the road generator, and the walls are a function of the
 * ground alone: the lakes hydrology draws depend on which of its regions are
 * paged in, round where the aircraft has been, and the network must not.
 *
 * Seed 2 has a basin lake 4 km from the home field; the forced volcanic world
 * "kilo77" has crater lakes (authored basins) 9-12 km out. On the six climate
 * provinces' default seeds no drawn lake lies within 14 km of the airport
 * (measured 2026-10-27), so no road there passes under one either way.
 */

const worlds = new Map<string, WorldDefinition>();
function world(seed: number | string, volcanic = false): WorldDefinition {
  const key = `${String(seed)}:${volcanic}`;
  let found = worlds.get(key);
  if (!found) {
    found = createWorld(seed, volcanic ? { landforms: { volcanic: true } } : {});
    worlds.set(key, found);
  }
  return found;
}

/** A hydrology region exactly as the worker generates it: its world's own inputs, the staged ground. */
function hydrologyRegion(source: WorldDefinition, centerX: number, centerZ: number): readonly HydrologyLake[] {
  const options = { seaLevel: source.seaLevel, centerX, centerZ };
  return withStaticInfrastructure(() => generateHydrology({
    ...options,
    ...volcanicHydrologyInputs(source, resolveHydrologyConfig(options)),
    worldSeed: source.seed,
    terrainSample: (x, z) => {
      const sample = sampleTerrain(source, x, z);
      return { height: sample.height, moisture: sample.moisture, ergWeight: sample.ergWeight };
    },
  }).lakes);
}

/** The region of a paging anchored at (anchorX, anchorZ) whose centre is nearest (x, z). */
function regionCenterNear(anchorX: number, anchorZ: number, x: number, z: number): [number, number] {
  const config = resolveHydrologyConfig({});
  const paging = resolveHydrologyPagingConfig(anchorX, anchorZ, config.extentMeters);
  const spacing = paging.spacingMeters;
  return [
    anchorX + Math.round((x - anchorX) / spacing) * spacing,
    anchorZ + Math.round((z - anchorZ) / spacing) * spacing,
  ];
}

function tileOf(x: number, z: number): [number, number] {
  return [Math.floor(x / ROAD_LAKE_TILE_METERS), Math.floor(z / ROAD_LAKE_TILE_METERS)];
}

/** Every tile the lake's shore, grown by the margin, reaches. */
function wallTiles(lake: HydrologyLake): Array<[number, number]> {
  const margin = ROAD_LAKE_SHORE_MARGIN_METERS;
  const xs = lake.boundary.map((point) => point.x);
  const zs = lake.boundary.map((point) => point.z);
  const [tx0, tz0] = tileOf(Math.min(...xs) - margin, Math.min(...zs) - margin);
  const [tx1, tz1] = tileOf(Math.max(...xs) + margin, Math.max(...zs) + margin);
  const tiles: Array<[number, number]> = [];
  for (let tx = tx0; tx <= tx1; tx += 1) for (let tz = tz0; tz <= tz1; tz += 1) tiles.push([tx, tz]);
  return tiles;
}

/** A shore vertex pushed `meters` out from the lake's centre. */
function pastShore(lake: HydrologyLake, index: number, meters: number): [number, number] {
  const point = lake.boundary[index]!;
  const dx = point.x - lake.centerX;
  const dz = point.z - lake.centerZ;
  const length = Math.hypot(dx, dz);
  return [point.x + (dx / length) * meters, point.z + (dz / length) * meters];
}

describe("lakes as road walls", () => {
  it("are the lakes hydrology draws, field for field, from two different paging anchors", () => {
    const source = world(2);
    const airport = source.airport!;
    const id = "5958bc19:lake:18:-15";
    // Production anchors the paging on the home field; a session that starts
    // elsewhere (or a teleport) anchors it 2.9 km east and 3.1 km south.
    const anchors: Array<[number, number]> = [
      [airport.centerX, airport.centerZ],
      [airport.centerX + 2_900, airport.centerZ - 3_100],
    ];
    const drawn = anchors.map(([anchorX, anchorZ]) => {
      const [centerX, centerZ] = regionCenterNear(anchorX, anchorZ, airport.centerX + 3_481, airport.centerZ + 2_065);
      return hydrologyRegion(source, centerX, centerZ).find((lake) => lake.id === id);
    });
    expect(drawn[0]).toBeDefined();
    expect(drawn[1]).toEqual(drawn[0]);
    const lake = drawn[0]!;
    for (const [tx, tz] of wallTiles(lake)) {
      expect(roadLakesInTile(source, tx, tz).find((wall) => wall.id === id)).toEqual(lake);
    }
    // The wall: the water, and the shore margin round it, and no further.
    expect(roadLakeWallAt(source, lake.centerX, lake.centerZ)).toBe(true);
    for (let index = 0; index < lake.boundary.length; index += 4) {
      expect(roadLakeWallAt(source, ...pastShore(lake, index, ROAD_LAKE_SHORE_MARGIN_METERS - 5))).toBe(true);
      expect(roadLakeWallAt(source, ...pastShore(lake, index, ROAD_LAKE_SHORE_MARGIN_METERS * 2))).toBe(false);
    }
    const [x, z] = pastShore(lake, 0, ROAD_LAKE_SHORE_MARGIN_METERS - 5);
    expect(roadGroundAt(source, x, z, roadGroundHeight(source, x, z))).toBe(RoadGround.water);
  }, 120_000);

  it("include every lake a region keeps, authored crater lakes too", () => {
    const source = world("kilo77", true);
    const airport = source.airport!;
    const [centerX, centerZ] = regionCenterNear(airport.centerX, airport.centerZ, airport.centerX + 7_200, airport.centerZ);
    const drawn = hydrologyRegion(source, centerX, centerZ);
    expect(drawn.some((lake) => lake.id.includes(":lake:volcanic:"))).toBe(true);
    for (const lake of drawn) {
      for (const [tx, tz] of wallTiles(lake)) {
        expect(roadLakesInTile(source, tx, tz).find((wall) => wall.id === lake.id)).toEqual(lake);
      }
    }
  }, 120_000);

  it("keep the roads near seed 2's lake off it and its shore", () => {
    const source = world(2);
    const airport = source.airport!;
    const network = new RoadNetwork(source);
    const lake = roadLakesInTile(source, ...tileOf(airport.centerX + 3_481, airport.centerZ + 2_065))
      .find((wall) => wall.id === "5958bc19:lake:18:-15")!;
    const rx = roadRegionOf(lake.centerX);
    const rz = roadRegionOf(lake.centerZ);
    let samples = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (const layer of ROAD_LAYERS) {
      for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
        for (const piece of network.region(layer, rx + dx, rz + dz).pieces) {
          const steps = Math.max(1, Math.ceil(Math.hypot(piece.bx - piece.ax, piece.bz - piece.az) / 4));
          for (let step = 0; step <= steps; step += 1) {
            const x = piece.ax + ((piece.bx - piece.ax) * step) / steps;
            const z = piece.az + ((piece.bz - piece.az) * step) / steps;
            samples += 1;
            expect(roadLakeWallAt(source, x, z)).toBe(false);
            nearest = Math.min(nearest, Math.hypot(x - lake.centerX, z - lake.centerZ));
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(100);
    // Roads do come near it: the wall is what they keep out of.
    expect(nearest).toBeLessThan(lake.radiusMeters + 1_000);
  }, 300_000);
});
