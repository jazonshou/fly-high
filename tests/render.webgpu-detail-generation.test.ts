import { describe, expect, it } from "vitest";
import { TerrainBiome, type TerrainBiomeId } from "../src/world";
import {
  detailCellKey,
  generateDetailCell,
} from "../src/render/webgpu/detail/generation";
import type { DetailTerrainSampler } from "../src/render/webgpu/detail/types";

function constantTerrain(
  biome: TerrainBiomeId,
  moisture: number,
  slope = 0.06,
): DetailTerrainSampler {
  return (x, z) => ({
    height: 120 + Math.sin(x * 0.002) * 3 + Math.cos(z * 0.0025) * 2,
    slope,
    moisture,
    biome,
  });
}

describe("WebGPU paged world-detail generation", () => {
  it("recreates exactly from seed and cell while different seeds diverge", () => {
    const terrainSample = constantTerrain(TerrainBiome.FOREST, 0.56);
    const first = generateDetailCell({
      worldSeed: "ecology-seed-a",
      cellX: -3,
      cellZ: 5,
      terrainSample,
    });
    const repeated = generateDetailCell({
      worldSeed: "ecology-seed-a",
      cellX: -3,
      cellZ: 5,
      terrainSample,
    });
    const changedSeed = generateDetailCell({
      worldSeed: "ecology-seed-b",
      cellX: -3,
      cellZ: 5,
      terrainSample,
    });

    expect(repeated).toEqual(first);
    expect(changedSeed.trees).not.toEqual(first.trees);
    expect(first.key).toBe("-3:5");
    expect(detailCellKey(-3, 5)).toBe(first.key);
  });

  it("uses biome, moisture, and slope rather than uniform scattering", () => {
    const shared = { worldSeed: "biome-comparison", cellX: 2, cellZ: -1 } as const;
    const forest = generateDetailCell({
      ...shared,
      terrainSample: constantTerrain(TerrainBiome.FOREST, 0.68, 0.04),
    });
    const grassland = generateDetailCell({
      ...shared,
      terrainSample: constantTerrain(TerrainBiome.GRASSLAND, 0.32, 0.04),
    });
    const steepHighland = generateDetailCell({
      ...shared,
      terrainSample: constantTerrain(TerrainBiome.HIGHLAND, 0.35, 0.7),
    });

    expect(forest.trees.length).toBeGreaterThan(grassland.trees.length * 3);
    expect(steepHighland.rocks.length).toBeGreaterThan(grassland.rocks.length);
    expect(new Set(forest.trees.map((tree) => tree.species)).size).toBeGreaterThanOrEqual(3);
  });

  it("never places terrestrial detail on water or runway ground", () => {
    // The density field is continuous, never a biome switch (1B-7): water is
    // ground at or below sea level, and the runway sits inside the graded
    // apron's full airport influence. Rocks still key off the biome id.
    const water = generateDetailCell({
      worldSeed: "excluded-biome",
      cellX: 0,
      cellZ: 0,
      terrainSample: constantTerrain(TerrainBiome.WATER, 0.7, 0),
      seaLevelMeters: 130,
    });
    expect(water.trees).toEqual([]);
    expect(water.shrubs).toEqual([]);
    expect(water.rocks).toEqual([]);
    const runway = generateDetailCell({
      worldSeed: "excluded-biome",
      cellX: 0,
      cellZ: 0,
      terrainSample: (x, z) => ({
        ...constantTerrain(TerrainBiome.RUNWAY, 0.7, 0)(x, z),
        airportInfluence: 1,
      }),
    });
    expect(runway.trees).toEqual([]);
    expect(runway.shrubs).toEqual([]);
    expect(runway.rocks).toEqual([]);
  });

  it("keeps placements finite, bounded to their owning cell, and wind-ready", () => {
    const cell = generateDetailCell({
      worldSeed: "bounded-cell",
      cellX: -1,
      cellZ: -2,
      cellSizeMeters: 384,
      terrainSample: constantTerrain(TerrainBiome.FOREST, 0.78),
    });
    expect(cell.trees.length).toBeGreaterThan(20);
    expect(cell.shrubs.length).toBeGreaterThan(0);
    for (const tree of cell.trees) {
      expect(tree.x).toBeGreaterThanOrEqual(cell.minX);
      expect(tree.x).toBeLessThan(cell.maxX);
      expect(tree.z).toBeGreaterThanOrEqual(cell.minZ);
      expect(tree.z).toBeLessThan(cell.maxZ);
      expect(tree.heightMeters).toBeGreaterThan(0);
      expect(tree.crownRadiusMeters).toBeGreaterThan(tree.trunkRadiusMeters);
      expect(tree.windPhaseRadians).toBeGreaterThanOrEqual(0);
      expect(tree.windPhaseRadians).toBeLessThan(Math.PI * 2);
      expect(tree.windResponse).toBeGreaterThan(0);
      expect(tree.color.every(Number.isFinite)).toBe(true);
    }
    for (const shrub of cell.shrubs) {
      expect(shrub.x).toBeGreaterThanOrEqual(cell.minX);
      expect(shrub.x).toBeLessThan(cell.maxX);
      expect(shrub.z).toBeGreaterThanOrEqual(cell.minZ);
      expect(shrub.z).toBeLessThan(cell.maxZ);
      expect(shrub.heightMeters).toBeGreaterThan(0);
      expect(shrub.radiusMeters).toBeGreaterThan(0);
    }
  });

  it("forms mixed-age clustered stands with page-edge Poisson separation", () => {
    const terrainSample = constantTerrain(TerrainBiome.FOREST, 0.7, 0.04);
    const left = generateDetailCell({
      worldSeed: "clustered-community",
      cellX: 0,
      cellZ: 0,
      terrainSample,
    });
    const right = generateDetailCell({
      worldSeed: "clustered-community",
      cellX: 1,
      cellZ: 0,
      terrainSample,
    });
    const trees = [...left.trees, ...right.trees];
    const heights = trees.map((tree) => tree.heightMeters);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(14);
    expect(new Set(trees.map((tree) => tree.species)).size).toBeGreaterThanOrEqual(5);
    expect(left.shrubs.length + right.shrubs.length).toBeGreaterThan(8);
    expect(new Set([...left.shrubs, ...right.shrubs].map((shrub) => shrub.species)).size)
      .toBeGreaterThanOrEqual(2);

    const nearBoundary = trees.filter((tree) => Math.abs(tree.x - left.maxX) < 16);
    for (let first = 0; first < nearBoundary.length; first += 1) {
      for (let second = first + 1; second < nearBoundary.length; second += 1) {
        const a = nearBoundary[first]!;
        const b = nearBoundary[second]!;
        // 1B-9's thinning floor is 2 m (half a crown, clamped) — closed
        // canopies overlap; the guarantee is no coincident pairs across the
        // page edge, not park-like spacing.
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(1.99);
      }
    }
  });

  it("keeps a 100 km² scan free of settlement artefacts (1B-5, assertion 26)", () => {
    // Villages and buildings are deleted outright, not flagged off. A wide
    // scan across every cell in a 10.24 × 10.24 km region must produce only
    // natural placements, and the runtime must register no built prototypes.
    const terrainSample = constantTerrain(TerrainBiome.GRASSLAND, 0.52, 0.03);
    for (let z = -10; z < 10; z += 1) {
      for (let x = -10; x < 10; x += 1) {
        const cell = generateDetailCell({
          worldSeed: "settlement-scan",
          cellX: x,
          cellZ: z,
          densityMultiplier: 0.2,
          terrainSample,
        });
        const placements = [...cell.trees, ...cell.shrubs, ...cell.rocks];
        for (const placement of placements) {
          expect(["tree", "shrub", "rock"]).toContain(placement.kind);
        }
        expect(Object.keys(cell).sort()).toEqual([
          "cellSizeMeters", "cellX", "cellZ", "key",
          "maxX", "maxZ", "minX", "minZ",
          "rocks", "shrubs", "trees",
        ]);
      }
    }
    // Exhaustive 400-cell scan: ~14 s on an M-series laptop, over 30 s on
    // shared CI runners — the generous explicit timeout is the same
    // convention world.test.ts uses for its long deterministic audits.
  }, 120_000);

  it("fades woody plants and rocks out multiplicatively over the graded apron (1B-6)", () => {
    const base = constantTerrain(TerrainBiome.GRASSLAND, 0.6, 0.04);
    const withInfluence = (influence: number) => (x: number, z: number) => ({
      ...base(x, z),
      airportInfluence: influence,
    });
    const shared = {
      worldSeed: "airport-exclusion",
      cellX: 2,
      cellZ: -3,
      densityMultiplier: 1,
    } as const;
    const open = generateDetailCell({ ...shared, terrainSample: withInfluence(0) });
    const apron = generateDetailCell({ ...shared, terrainSample: withInfluence(1) });
    const blend = generateDetailCell({ ...shared, terrainSample: withInfluence(0.6) });

    // Zero influence is exactly a no-op against the plain sampler.
    expect(open).toEqual(generateDetailCell({ ...shared, terrainSample: base }));
    // Full influence clears trees, shrubs and rocks entirely.
    expect(apron.trees).toEqual([]);
    expect(apron.shrubs).toEqual([]);
    expect(apron.rocks).toEqual([]);
    // Partial influence thins multiplicatively rather than switching off.
    const openCount = open.trees.length + open.shrubs.length + open.rocks.length;
    const blendCount = blend.trees.length + blend.shrubs.length + blend.rocks.length;
    expect(blendCount).toBeGreaterThan(0);
    expect(blendCount).toBeLessThan(openCount);
  });

  it("validates paging inputs before sampling terrain", () => {
    const terrainSample = constantTerrain(TerrainBiome.FOREST, 0.5);
    expect(() => generateDetailCell({
      worldSeed: "invalid",
      cellX: 0.25,
      cellZ: 0,
      terrainSample,
    })).toThrow(RangeError);
    expect(() => generateDetailCell({
      worldSeed: "invalid",
      cellX: 0,
      cellZ: 0,
      cellSizeMeters: 0,
      terrainSample,
    })).toThrow(RangeError);
  });
});
