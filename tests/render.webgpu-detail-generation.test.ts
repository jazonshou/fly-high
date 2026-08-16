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

  it("never places terrestrial detail on water or runway biomes", () => {
    for (const biome of [TerrainBiome.WATER, TerrainBiome.RUNWAY] as const) {
      const cell = generateDetailCell({
        worldSeed: "excluded-biome",
        cellX: 0,
        cellZ: 0,
        terrainSample: constantTerrain(biome, 0.7, 0),
      });
      expect(cell.trees).toEqual([]);
      expect(cell.rocks).toEqual([]);
      expect(cell.buildings).toEqual([]);
      expect(cell.village).toBeNull();
    }
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
  });

  it("owns sparse villages at macro-cell scale and lays buildings along a road", () => {
    const terrainSample = constantTerrain(TerrainBiome.GRASSLAND, 0.52, 0.03);
    let settlement = null as ReturnType<typeof generateDetailCell> | null;
    for (let z = -10; z <= 10 && !settlement; z += 1) {
      for (let x = -10; x <= 10; x += 1) {
        const cell = generateDetailCell({
          worldSeed: "settlement-search",
          cellX: x,
          cellZ: z,
          densityMultiplier: 0,
          terrainSample,
        });
        if (cell.village) {
          settlement = cell;
          break;
        }
      }
    }

    expect(settlement).not.toBeNull();
    expect(settlement?.buildings.length).toBeGreaterThanOrEqual(3);
    expect(new Set(settlement?.buildings.map((building) => building.id)).size).toBe(
      settlement?.buildings.length,
    );
    for (const building of settlement?.buildings ?? []) {
      expect(building.x).toBeGreaterThan(settlement?.minX ?? Number.POSITIVE_INFINITY);
      expect(building.x).toBeLessThan(settlement?.maxX ?? Number.NEGATIVE_INFINITY);
      expect(building.z).toBeGreaterThan(settlement?.minZ ?? Number.POSITIVE_INFINITY);
      expect(building.z).toBeLessThan(settlement?.maxZ ?? Number.NEGATIVE_INFINITY);
      expect(building.yawRadians).toBeCloseTo(settlement?.village?.roadHeadingRadians ?? 0, 0);
    }
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
