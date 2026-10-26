import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { GroundCoverSystem } from "../src/render/webgpu/detail/GroundCoverSystem";
import { GROUND_COVER_GRID, generateDetailCell } from "../src/render/webgpu/detail/generation";
import { GROUND_COVER_ATTRIBUTE_TILE_EDGE, GROUND_COVER_TILE_SPAN_METERS } from "../src/render/webgpu/detail/groundCoverLaw";
import type { GeneratedDetailCell } from "../src/render/webgpu/detail/types";
import {
  INFRASTRUCTURE_PLANT_BLEND_METERS,
  TerrainBiome,
  infrastructurePlantFactor,
  type InfrastructurePlantExclusion,
} from "../src/world";
import type { TerrainSample } from "../src/world/types";

/**
 * Built ground grows nothing: the detail scatter's trees, shrubs, rocks,
 * clutter and ground-cover grid, and the GPU blades' attribute tile, all take
 * `infrastructurePlantFactor`, and an exclusion that cannot reach changes
 * nothing at all.
 */

const CELL = 256;

/** Closed damp forest everywhere, so there is a population to remove. */
const forest = () => ({
  height: 40,
  slope: 0.02,
  moisture: 0.8,
  biome: TerrainBiome.FOREST,
  airportInfluence: 0,
});

function generate(cellX: number, cellZ: number, plantExclusions?: readonly InfrastructurePlantExclusion[]): GeneratedDetailCell {
  return generateDetailCell({
    worldSeed: "infrastructure-plants",
    cellX,
    cellZ,
    cellSizeMeters: CELL,
    terrainSample: forest,
    seaLevelMeters: 0,
    ...(plantExclusions ? { plantExclusions } : {}),
  });
}

/** A slipway and car park's worth of capsule across cell (3, 5). */
const SLIPWAY: InfrastructurePlantExclusion = { ax: 3 * CELL + 40, az: 5 * CELL + 60, bx: 3 * CELL + 210, bz: 5 * CELL + 170, radius: 24 };

function distanceToCapsule(exclusion: InfrastructurePlantExclusion, x: number, z: number): number {
  const dx = exclusion.bx - exclusion.ax;
  const dz = exclusion.bz - exclusion.az;
  const t = Math.min(1, Math.max(0, ((x - exclusion.ax) * dx + (z - exclusion.az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (exclusion.ax + dx * t), z - (exclusion.az + dz * t));
}

describe("plants on built ground", () => {
  it("keeps every stem, rock and log off the capsule and thins them back over the blend", () => {
    const control = generate(3, 5);
    const gated = generate(3, 5, [SLIPWAY]);
    const placed = (cell: GeneratedDetailCell) => [...cell.trees, ...cell.shrubs, ...cell.clutter, ...cell.rocks];
    const inside = (cell: GeneratedDetailCell) =>
      placed(cell).filter((p) => distanceToCapsule(SLIPWAY, p.x, p.z) <= SLIPWAY.radius).length;
    const far = (cell: GeneratedDetailCell) => placed(cell)
      .filter((p) => distanceToCapsule(SLIPWAY, p.x, p.z) >= SLIPWAY.radius + INFRASTRUCTURE_PLANT_BLEND_METERS);
    expect(inside(control), "the control grew nothing on the slipway: the test is not armed").toBeGreaterThan(20);
    expect(inside(gated)).toBe(0);
    // Beyond the blend the factor is exactly 1: the same placements, bit for bit.
    expect(far(gated)).toEqual(far(control));
    // Shrubs share the trees' layer scatter and its gate (this sampler grows
    // understorey only); the cell keeps them off the capsule.
    expect(gated.shrubs.length).toBeGreaterThan(100);

    // The ground-cover grid: nothing at a node on the capsule, untouched past the blend.
    const spacing = CELL / GROUND_COVER_GRID;
    let nodesInside = 0;
    gated.groundCover.forEach((node, index) => {
      const x = 3 * CELL + ((index % GROUND_COVER_GRID) + 0.5) * spacing;
      const z = 5 * CELL + (Math.floor(index / GROUND_COVER_GRID) + 0.5) * spacing;
      const distance = distanceToCapsule(SLIPWAY, x, z);
      if (distance <= SLIPWAY.radius) {
        nodesInside += 1;
        expect(node.coverage).toBe(0);
        expect(control.groundCover[index]!.coverage).toBeGreaterThan(0);
      } else if (distance >= SLIPWAY.radius + INFRASTRUCTURE_PLANT_BLEND_METERS) {
        expect(node).toEqual(control.groundCover[index]);
      }
    });
    expect(nodesInside).toBeGreaterThan(2);
  });

  it("changes nothing in a cell no exclusion reaches", () => {
    const distant: InfrastructurePlantExclusion = { ax: -9_000, az: 4_000, bx: -8_800, bz: 4_100, radius: 30 };
    expect(generate(3, 5, [distant])).toEqual(generate(3, 5));
    expect(infrastructurePlantFactor([distant], 3 * CELL, 5 * CELL)).toBe(1);
  });

  it("empties the ground-cover blades' tile on built ground", () => {
    const sample = () => ({
      height: 12,
      normal: { x: 0, y: 1, z: 0 },
      slope: 0.02,
      moisture: 0.6,
      temperature: 0.6,
      biome: TerrainBiome.GRASSLAND,
      airportInfluence: 0,
      isRunway: false,
      dryness: 0,
      sandCover: 0,
      temperatureOffset: 0,
    }) as unknown as TerrainSample;
    const step = GROUND_COVER_TILE_SPAN_METERS / GROUND_COVER_ATTRIBUTE_TILE_EDGE;
    // A road across the tile's middle rows (the back tile's origin is 0, 0).
    const road: InfrastructurePlantExclusion = { ax: -50, az: 128, bx: 400, bz: 128, radius: 10 };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const bake = (plantExclusions?: readonly InfrastructurePlantExclusion[]) => {
        const system = new GroundCoverSystem(scene, {
          terrainSample: sample,
          seedHash: 1_234,
          ...(plantExclusions ? { plantExclusions } : {}),
        });
        const internals = system as unknown as {
          bakeAttributeRow(row: number): void;
          backAttributes: Uint8Array;
          backDrivers: Uint8Array;
        };
        for (let row = 0; row < GROUND_COVER_ATTRIBUTE_TILE_EDGE; row += 1) internals.bakeAttributeRow(row);
        const result = { attributes: internals.backAttributes.slice(), drivers: internals.backDrivers.slice() };
        system.dispose();
        return result;
      };
      const control = bake();
      const gated = bake([road]);
      let rowsOnRoad = 0;
      for (let row = 0; row < GROUND_COVER_ATTRIBUTE_TILE_EDGE; row += 1) {
        const z = (row + 0.5) * step;
        const distance = Math.abs(z - road.az);
        const at = row * GROUND_COVER_ATTRIBUTE_TILE_EDGE * 4;
        if (distance <= road.radius) {
          rowsOnRoad += 1;
          expect(control.attributes[at + 3]).toBeGreaterThan(0);
          expect(control.drivers[at + 3]).toBeGreaterThan(0);
          expect(gated.attributes[at + 3]).toBe(0);
          expect(gated.drivers[at + 3]).toBe(0);
        } else if (distance >= road.radius + INFRASTRUCTURE_PLANT_BLEND_METERS) {
          const end = at + GROUND_COVER_ATTRIBUTE_TILE_EDGE * 4;
          expect(gated.attributes.slice(at, end)).toEqual(control.attributes.slice(at, end));
          expect(gated.drivers.slice(at, end)).toEqual(control.drivers.slice(at, end));
        }
      }
      expect(rowsOnRoad).toBeGreaterThanOrEqual(4);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
