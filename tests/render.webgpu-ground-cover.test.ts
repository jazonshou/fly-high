import { describe, expect, it } from "vitest";
import { TerrainBiome } from "../src/world";
import { generateDetailCell, GROUND_COVER_GRID } from "../src/render/webgpu/detail/generation";
import { buildGrassPatchPrototype } from "../src/render/webgpu/detail/prototypeGeometry";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  GROUND_COVER_CANDIDATE_SPACING_METERS,
  GROUND_COVER_FULL_DENSITY_SHARE,
} from "../src/render/webgpu/detail/WorldDetailRuntime";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 2-16 — grass and habitat ground cover: the ~48-triangle patch price, the
 * ≤ 0.9 M Balanced triangle exit budget as an integral over the 1/d ramp,
 * habitat-driven archetypes (reeds wet+flat, fern shade+shelter, heather
 * exposure, grass elsewhere), and the seasonal straw turn.
 */

function sampler(overrides: Partial<DetailTerrainSample>): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height: 320,
    slope: 0.05,
    moisture: 0.5,
    biome: TerrainBiome.GRASSLAND,
    normal: { x: 0, y: 1, z: 0 },
    ...overrides,
  });
}

function nodesFor(
  terrainSample: (x: number, z: number) => DetailTerrainSample,
  dayOfYear = 171,
) {
  return generateDetailCell({
    worldSeed: "ground-cover",
    cellX: 4,
    cellZ: 9,
    cellSizeMeters: 128,
    densityMultiplier: 1,
    terrainSample,
    seaLevelMeters: 0,
    dayOfYear,
    latitudeDegrees: 45,
  }).groundCover;
}

function dominantArchetype(nodes: ReturnType<typeof nodesFor>): string {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.coverage <= 0) continue;
    counts.set(node.archetype, (counts.get(node.archetype) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
}

describe("ground cover patches (2-16)", () => {
  it("prices every archetype at the plan's ~48 triangles", () => {
    for (const archetype of ["grass", "fern", "heather", "reed"] as const) {
      expect(
        buildGrassPatchPrototype(7, archetype).triangleCount,
        archetype,
      ).toBeLessThanOrEqual(48);
    }
  });

  it("fits the Balanced grass budget under the 1/d ramp integral", () => {
    // Worst case: coverage 1 everywhere. Candidates at 1/spacing² per m²;
    // full density inside 0.2·R, (0.2·R)/d acceptance beyond — the closed
    // form is π·(0.2R)² + 0.2R·2π·(R − 0.2R), per unit candidate density.
    const profile = resolveWebGpuQualityProfile("high", "balanced");
    const radius = profile.grassRadiusMeters;
    const candidateDensity = 1 / GROUND_COVER_CANDIDATE_SPACING_METERS ** 2;
    const fullRadius = radius * GROUND_COVER_FULL_DENSITY_SHARE;
    const patches = candidateDensity * (
      Math.PI * fullRadius ** 2
      + fullRadius * 2 * Math.PI * (radius - fullRadius)
    );
    expect(patches * 48).toBeLessThanOrEqual(900_000);
    // Non-vacuous: the budget is being used, not dodged.
    expect(patches * 48).toBeGreaterThan(400_000);
  });

  it("chooses archetypes from habitat, not a flat roll", () => {
    expect(dominantArchetype(nodesFor(sampler({ moisture: 0.8, slope: 0.02 })))).toBe("reed");
    expect(dominantArchetype(nodesFor(
      sampler({ biome: TerrainBiome.FOREST, moisture: 0.66 }),
    ))).toBe("fern");
    expect(dominantArchetype(nodesFor(
      sampler({ biome: TerrainBiome.HIGHLAND, height: 980, slope: 0.3, moisture: 0.3 }),
    ))).toBe("heather");
    expect(dominantArchetype(nodesFor(sampler({ moisture: 0.45 })))).toBe("grass");
  });

  it("grows nothing on beaches or underwater", () => {
    for (const node of nodesFor(sampler({ biome: TerrainBiome.BEACH }))) {
      expect(node.coverage).toBe(0);
    }
    for (const node of nodesFor(sampler({ height: -4 }))) {
      expect(node.coverage).toBe(0);
    }
  });

  it("turns grass toward straw in winter", () => {
    const summer = nodesFor(sampler({ moisture: 0.45 }));
    const winter = nodesFor(sampler({ moisture: 0.45 }), 16);
    const meanRedShare = (nodes: typeof summer) => {
      const grassNodes = nodes.filter(
        (node) => node.archetype === "grass" && node.coverage > 0,
      );
      return grassNodes.reduce(
        (sum, node) => sum + node.color[0] / Math.max(node.color[1], 1e-6),
        0,
      ) / Math.max(grassNodes.length, 1);
    };
    // Straw shifts red/green ratio up (winter grass at 320 m is also under
    // the deep-winter snowline, which whitens — the ratio still moves).
    expect(meanRedShare(winter)).toBeGreaterThan(meanRedShare(summer) + 0.05);
  });

  it("keeps the grid shape and determinism", () => {
    const a = nodesFor(sampler({}));
    const b = nodesFor(sampler({}));
    expect(a).toHaveLength(GROUND_COVER_GRID * GROUND_COVER_GRID);
    expect(a).toEqual(b);
  });
});
