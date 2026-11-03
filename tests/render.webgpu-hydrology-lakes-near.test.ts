import { describe, expect, it } from "vitest";
import {
  generateHydrology,
  generateHydrologyLakesNear,
  type HydrologyAuthoredBasin,
  type HydrologyBounds,
  type HydrologyLake,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";

/**
 * `generateHydrologyLakesNear` asks the ground which lakes reach a box, not
 * the paging: over a terrain of closed hollows, every lake any region keeps
 * there is one it returns, field for field, and every lake it returns whose
 * mean radius meets a region is one that region keeps. Two regions that
 * share a lake share it bit for bit, so its answer is the same from any
 * anchor.
 */

const SEED = "lakes-near";
// Hollows a few hundred metres across on a gentle tilt: plenty of basins.
const terrain: HydrologyTerrainSampler = (x, z) => ({
  height: 260 + 34 * Math.sin(x / 610) * Math.sin(z / 570) + 0.004 * x + 9 * Math.sin((x + z) / 230),
  moisture: 0.6,
});
const crater: HydrologyAuthoredBasin = {
  id: "crater",
  centerX: 2_600,
  centerZ: -1_900,
  levelMeters: 255,
  floorMeters: 230,
  rimRadiusMeters: 700,
};

function region(centerX: number, centerZ: number): readonly HydrologyLake[] {
  return generateHydrology({ worldSeed: SEED, terrainSample: terrain, authoredBasins: [crater], centerX, centerZ }).lakes;
}

function regionBounds(centerX: number, centerZ: number): HydrologyBounds {
  const half = 14_400 / 2;
  return { minX: centerX - half, maxX: centerX + half, minZ: centerZ - half, maxZ: centerZ + half };
}

function meanRadiusMeets(lake: HydrologyLake, bounds: HydrologyBounds): boolean {
  return lake.centerX + lake.radiusMeters >= bounds.minX && lake.centerX - lake.radiusMeters <= bounds.maxX
    && lake.centerZ + lake.radiusMeters >= bounds.minZ && lake.centerZ - lake.radiusMeters <= bounds.maxZ;
}

describe("hydrology lakes near a box", () => {
  it("are the lakes every region keeps there, from any anchor", () => {
    const box: HydrologyBounds = { minX: -9_000, maxX: 11_000, minZ: -10_000, maxZ: 10_000 };
    const near = generateHydrologyLakesNear({ worldSeed: SEED, terrainSample: terrain, authoredBasins: [crater] }, box);
    expect(near.length).toBeGreaterThan(5);
    expect(near.some((lake) => lake.id.endsWith(":lake:crater"))).toBe(true);
    const byId = new Map(near.map((lake) => [lake.id, lake]));
    let matched = 0;
    let missed = 0;
    // Regions of three pagings, each over part of the box.
    for (const [centerX, centerZ] of [[1_000, 0], [3_900, -2_300], [-1_700, 2_800]] as const) {
      const bounds = regionBounds(centerX, centerZ);
      const kept = region(centerX, centerZ);
      for (const lake of kept) {
        const xs = lake.boundary.map((point) => point.x);
        const zs = lake.boundary.map((point) => point.z);
        const reaches = Math.max(...xs) >= box.minX && Math.min(...xs) <= box.maxX
          && Math.max(...zs) >= box.minZ && Math.min(...zs) <= box.maxZ;
        if (!reaches) continue;
        expect(byId.get(lake.id)).toEqual(lake);
        matched += 1;
      }
      const keptIds = new Set(kept.map((lake) => lake.id));
      for (const lake of near) {
        if (meanRadiusMeets(lake, bounds)) expect(keptIds.has(lake.id)).toBe(true);
        else missed += 1;
      }
    }
    // Lakes shared between regions, and lakes out of some region's reach.
    expect(matched).toBeGreaterThan(near.length);
    expect(missed).toBeGreaterThan(0);
  });
});
