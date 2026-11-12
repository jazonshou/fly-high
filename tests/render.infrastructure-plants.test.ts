import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { GroundCoverSystem } from "../src/render/webgpu/detail/GroundCoverSystem";
import { GROUND_COVER_GRID, SCATTER_HALO_METERS, generateDetailCell } from "../src/render/webgpu/detail/generation";
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

/**
 * The cell under test. Bushes stand in thickets with clean ground between and
 * this sampler's stands of trees come and go, so the cell is one whose capsule
 * crosses both, with a few rocks elsewhere in it. The assertions that arm the
 * test below fail if a change to the scatter ever leaves the capsule bare.
 */
const CELL_X = 2;
const CELL_Z = 10;

/** A slipway and car park's worth of capsule across the cell. */
const SLIPWAY: InfrastructurePlantExclusion = {
  ax: CELL_X * CELL + 40,
  az: CELL_Z * CELL + 60,
  bx: CELL_X * CELL + 210,
  bz: CELL_Z * CELL + 170,
  radius: 24,
};

function distanceToCapsule(exclusion: InfrastructurePlantExclusion, x: number, z: number): number {
  const dx = exclusion.bx - exclusion.ax;
  const dz = exclusion.bz - exclusion.az;
  const t = Math.min(1, Math.max(0, ((x - exclusion.ax) * dx + (z - exclusion.az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (exclusion.ax + dx * t), z - (exclusion.az + dz * t));
}

describe("plants on built ground", () => {
  it("keeps every stem, rock and log off the capsule and thins them back over the blend", () => {
    const control = generate(CELL_X, CELL_Z);
    const gated = generate(CELL_X, CELL_Z, [SLIPWAY]);
    type Placed = { readonly id: string; readonly x: number; readonly z: number };
    const placed = (cell: GeneratedDetailCell): readonly Placed[] =>
      [...cell.trees, ...cell.shrubs, ...cell.clutter, ...cell.rocks];
    const distance = (p: Placed) => distanceToCapsule(SLIPWAY, p.x, p.z);
    const inside = (cell: GeneratedDetailCell) => placed(cell).filter((p) => distance(p) <= SLIPWAY.radius).length;
    /** Past the blend, and `margin` further still. */
    const beyond = (list: readonly Placed[], margin = 0): readonly Placed[] =>
      list.filter((p) => distance(p) >= SLIPWAY.radius + INFRASTRUCTURE_PLANT_BLEND_METERS + margin);
    expect(inside(control), "the control grew nothing on the slipway: the test is not armed").toBeGreaterThan(20);
    expect(inside(gated)).toBe(0);
    for (const kind of ["trees", "shrubs", "rocks"] as const) {
      expect(beyond(control[kind]).length, `the control has no ${kind} past the blend`).toBeGreaterThan(0);
    }

    // Beyond the blend the factor is exactly 1. Clutter and rocks are placed
    // one at a time, so there they are the same placements, bit for bit.
    // (Rocks draw from one stream for the whole cell and a rock the capsule
    // removes leaves its later rolls undrawn, so this is a claim about a cell
    // whose capsule had no rock on it. This is one.)
    expect(
      control.rocks.filter((p) => distance(p) < SLIPWAY.radius + INFRASTRUCTURE_PLANT_BLEND_METERS),
      "a rock on the capsule moves every later rock in the cell: test another cell",
    ).toHaveLength(0);
    expect(beyond(gated.clutter)).toEqual(beyond(control.clutter));
    expect(beyond(gated.rocks)).toEqual(beyond(control.rocks));

    // A tree or a bush also yields to a stronger neighbour inside its spacing,
    // and the capsule removes neighbours. So past the blend no stem is lost
    // and none changes; one may stand where a cleared neighbour outranked it;
    // and past the thinning's whole reach nothing differs at all.
    for (const kind of ["trees", "shrubs"] as const) {
      const after = new Map(beyond(gated[kind]).map((stem) => [stem.id, stem]));
      for (const stem of beyond(control[kind])) expect(after.get(stem.id)).toEqual(stem);
      expect(beyond(gated[kind], SCATTER_HALO_METERS)).toEqual(beyond(control[kind], SCATTER_HALO_METERS));
    }
    // Shrubs share the trees' layer scatter and its gate; the cell keeps the
    // ones off the capsule.
    expect(gated.shrubs.length).toBeGreaterThan(100);

    // The ground-cover grid: nothing at a node on the capsule, untouched past the blend.
    const spacing = CELL / GROUND_COVER_GRID;
    let nodesInside = 0;
    gated.groundCover.forEach((node, index) => {
      const x = CELL_X * CELL + ((index % GROUND_COVER_GRID) + 0.5) * spacing;
      const z = CELL_Z * CELL + (Math.floor(index / GROUND_COVER_GRID) + 0.5) * spacing;
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
    expect(generate(CELL_X, CELL_Z, [distant])).toEqual(generate(CELL_X, CELL_Z));
    expect(infrastructurePlantFactor([distant], CELL_X * CELL, CELL_Z * CELL)).toBe(1);
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
          ...(plantExclusions ? { plantExclusionsIn: () => plantExclusions } : {}),
        });
        const internals = system as unknown as {
          bakeAttributeColumns(row: number, from: number, to: number): void;
          backAttributes: Uint8Array;
          backDrivers: Uint8Array;
        };
        for (let row = 0; row < GROUND_COVER_ATTRIBUTE_TILE_EDGE; row += 1) {
          internals.bakeAttributeColumns(row, 0, GROUND_COVER_ATTRIBUTE_TILE_EDGE);
        }
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
