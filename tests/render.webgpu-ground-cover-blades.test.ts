import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { DYNAMIC_ALLOCATIONS } from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  GroundCoverSystem,
  estimateGroundCoverTriangles,
  estimateGroundCoverVertices,
} from "../src/render/webgpu/detail/GroundCoverSystem";
import {
  GROUND_COVER_ATTRIBUTE_TILE_EDGE,
  GROUND_COVER_BLADE_STRIDE_BYTES,
  GROUND_COVER_HEIGHT_TILE_EDGE,
  GROUND_COVER_LAWS,
  groundCoverBladeTriangles,
  groundCoverBladeVertices,
  groundCoverBufferBytes,
  groundCoverCounterBytes,
  groundCoverLaneCount,
} from "../src/render/webgpu/detail/groundCoverLaw";
import { GROUND_COVER_COMPUTE_WGSL } from "../src/render/webgpu/detail/groundCoverWgsl";
import type { TerrainSample } from "../src/world/types";

const MIB = 1_048_576;

function flatSample(): TerrainSample {
  return {
    height: 12,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0.02,
    moisture: 0.6,
    temperature: 0.6,
    biome: 2,
    biomeName: "grassland",
    color: { x: 0.3, y: 0.5, z: 0.2 },
    airportInfluence: 0,
    isRunway: false,
  } as unknown as TerrainSample;
}

describe("ground-cover blade law (wave G)", () => {
  it("keeps rings ordered and the gate band sane at every tier", () => {
    for (const law of GROUND_COVER_LAWS) {
      expect(law.rings).toHaveLength(3);
      let previousOuter = 0;
      let previousSpacing = 0;
      for (const ring of law.rings) {
        expect(ring.outerRadiusMeters).toBeGreaterThan(previousOuter);
        expect(ring.spacingMeters).toBeGreaterThan(previousSpacing);
        expect(ring.segments).toBeGreaterThanOrEqual(2);
        expect(groundCoverLaneCount(ring)).toBeLessThan(150_000);
        previousOuter = ring.outerRadiusMeters;
        previousSpacing = ring.spacingMeters;
      }
      expect(law.altitudeFadeHighMeters).toBeGreaterThan(law.altitudeFadeLowMeters);
    }
  });

  it("pins the blade vertex/triangle formulas", () => {
    const ring = GROUND_COVER_LAWS[1]!.rings[0]!;
    expect(groundCoverBladeVertices(ring)).toBe(2 * ring.segments + 1);
    expect(groundCoverBladeTriangles(ring)).toBe(2 * ring.segments - 1);
  });

  it("keeps every tier's worst-case vertex load inside the v1 ceiling", () => {
    // The v1 no-compaction rung pays vertex invocations for every lattice
    // lane. This ceiling is the honest cost model the wave-G research sized
    // against the M1 parameter-buffer budget (~2 M comfortable).
    const vertexCeilings = [400_000, 1_000_000, 1_700_000, 2_600_000];
    const triangleCeilings = [300_000, 700_000, 1_100_000, 1_700_000];
    GROUND_COVER_LAWS.forEach((law, tier) => {
      expect(estimateGroundCoverVertices(law), `tier ${tier} vertices`)
        .toBeLessThanOrEqual(vertexCeilings[tier]!);
      expect(estimateGroundCoverTriangles(law), `tier ${tier} triangles`)
        .toBeLessThanOrEqual(triangleCeilings[tier]!);
    });
  });

  it("keeps the budget row covering the buffers plus the domain tile", () => {
    // 6-9: TWO 64² attribute tiles now — the wave-G albedo/grass-weight tile
    // and the archetype driver tile — plus the compaction counter ring.
    const tileBytes = GROUND_COVER_HEIGHT_TILE_EDGE ** 2 * 4
      + 2 * GROUND_COVER_ATTRIBUTE_TILE_EDGE ** 2 * 4
      + groundCoverCounterBytes();
    GROUND_COVER_LAWS.forEach((law, tier) => {
      const actualMiB = (groundCoverBufferBytes(law) + tileBytes) / MIB;
      const row = DYNAMIC_ALLOCATIONS.groundCoverMiB[tier as 0 | 1 | 2 | 3];
      expect(row, `tier ${tier} row covers actual`).toBeGreaterThanOrEqual(actualMiB);
      // Non-vacuous: the row tracks the law rather than padding far above it.
      expect(row, `tier ${tier} row stays honest`).toBeLessThan(actualMiB * 1.35 + 0.5);
    });
  });

  it("exposes the tier law through the quality profile (the tier rule)", () => {
    expect(resolveWebGpuQualityProfile("medium", "balanced").groundCoverLaw)
      .toBe(GROUND_COVER_LAWS[1]);
    expect(resolveWebGpuQualityProfile("low", "performance").groundCoverLaw)
      .toBe(GROUND_COVER_LAWS[0]);
  });

  it("keeps the compute WGSL free of reserved identifiers and stride drift", () => {
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("fn placeGroundCover");
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("array<GroundBlade>");
    // `attribute`/`target` style reserved words have shipped hangs before
    // (5-10); pin the two identifiers this shader deliberately renamed.
    expect(GROUND_COVER_COMPUTE_WGSL).not.toMatch(/\blet attribute\b/);
    expect(GROUND_COVER_COMPUTE_WGSL).not.toMatch(/\blet target\b/);
    expect(GROUND_COVER_BLADE_STRIDE_BYTES).toBe(32);
  });
});

describe("ground-cover system under NullEngine", () => {
  it("constructs inert without compute support and updates without throwing", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const system = new GroundCoverSystem(scene, { terrainSample: () => flatSample() });
      expect(system.pendingTileRows).toBe(0);
      system.update({
        cameraWorldX: 100,
        cameraWorldY: 14,
        cameraWorldZ: 100,
        floatingOriginX: 0,
        floatingOriginZ: 0,
        law: GROUND_COVER_LAWS[1]!,
        windDirectionX: 1,
        windDirectionZ: 0,
        windStrength01: 0.4,
        windGust01: 0.2,
        simulationTimeSeconds: 12,
      });
      expect(system.statistics.activeBladeCapacity).toBe(0);
      system.dispose();
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
