import { describe, expect, it } from "vitest";
import { hashSeed, TerrainBiome } from "../src/world";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import { densityField } from "../src/render/webgpu/detail/densityField";
import { normalAlignedQuaternion } from "../src/render/webgpu/detail/instanceFormat";
import {
  buildClutterPrototype,
  buildRockPrototype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 2-15 — rocks and ground clutter: prototype budgets against the plan's
 * per-archetype triangle prices, canopy-closure-driven clutter density,
 * terrain-normal alignment through the record's full orientation, the
 * plan's rock sinking, and the snow slope-shedding rule going LIVE (rocks
 * reach slope 0.9 where trees stopped at 0.2).
 */

function sampler(
  biome: (typeof TerrainBiome)[keyof typeof TerrainBiome],
  moisture: number,
  slope = 0.08,
  height = 320,
): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height,
    slope,
    moisture,
    biome,
    normal: { x: slope * 0.9, y: Math.sqrt(Math.max(0, 1 - slope * slope * 0.81)), z: 0 },
  });
}

function cellAt(
  terrainSample: (x: number, z: number) => DetailTerrainSample,
  dayOfYear = 171,
  cellX = 3,
  cellZ = 5,
) {
  return generateDetailCell({
    worldSeed: "rocks-clutter",
    cellX,
    cellZ,
    cellSizeMeters: 128,
    densityMultiplier: 1,
    terrainSample,
    seaLevelMeters: 0,
    dayOfYear,
    latitudeDegrees: 45,
  });
}

/**
 * Select a contiguous six-cell closed-canopy fixture. Gate B's province gate
 * makes the old cells at world zero valid meadow, so habitat tests must name
 * the habitat they intend to measure rather than inherit it by accident.
 */
function selectClosedForestWindow(): {
  readonly cells: readonly { readonly x: number; readonly z: number }[];
  readonly meanDensity: number;
} {
  const seedHash = hashSeed("rocks-clutter");
  let best = { originX: 0, originZ: 0, meanDensity: Number.NEGATIVE_INFINITY };
  for (let originZ = -64; originZ <= 62; originZ += 2) {
    for (let originX = -64; originX <= 62; originX += 2) {
      let total = 0;
      let probes = 0;
      for (let dz = 0; dz < 2; dz += 1) {
        for (let dx = 0; dx < 3; dx += 1) {
          for (const localZ of [32, 96]) {
            for (const localX of [32, 96]) {
              total += densityField(seedHash, {
            filterWidthMeters: 0,
                x: (originX + dx) * 128 + localX,
                z: (originZ + dz) * 128 + localZ,
                heightMeters: 320,
                seaLevelMeters: 0,
                slope: 0.08,
                moisture: 0.7,
                dayOfYear: 171,
              }).treeStemsPerSquareMeter;
              probes += 1;
            }
          }
        }
      }
      const meanDensity = total / probes;
      if (meanDensity > best.meanDensity) {
        best = { originX, originZ, meanDensity };
      }
    }
  }
  const cells = [];
  for (let dz = 0; dz < 2; dz += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      cells.push({ x: best.originX + dx, z: best.originZ + dz });
    }
  }
  return { cells, meanDensity: best.meanDensity };
}

const CLOSED_FOREST_WINDOW = selectClosedForestWindow();

function rotateByQuaternion(
  v: readonly [number, number, number],
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const cx = qy * z - qz * y + qw * x;
  const cy = qz * x - qx * z + qw * y;
  const cz = qx * y - qy * x + qw * z;
  return [
    x + 2 * (qy * cz - qz * cy),
    y + 2 * (qz * cx - qx * cz),
    z + 2 * (qx * cy - qy * cx),
  ];
}

describe("prototype budgets (2-15)", () => {
  it("keeps every archetype at its planned triangle price", () => {
    expect(buildClutterPrototype("log", 7).triangleCount).toBeLessThanOrEqual(70);
    expect(buildClutterPrototype("stump", 7).triangleCount).toBeLessThanOrEqual(40);
    expect(buildClutterPrototype("branchLitter", 7).triangleCount).toBeLessThanOrEqual(8);
    expect(buildClutterPrototype("mossCushion", 7).triangleCount).toBeLessThanOrEqual(24);
    for (const variant of ["granite", "limestone", "dark"] as const) {
      expect(buildRockPrototype(variant, 7).triangleCount).toBe(320);
    }
  });

  it("differs flat granite from smooth limestone in the normals", () => {
    // Flat shading duplicates vertices per face; smooth shares them — the
    // per-lithology shading-model difference the plan asks for.
    const granite = buildRockPrototype("granite", 7);
    const limestone = buildRockPrototype("limestone", 7);
    expect(granite.positions.length).toBeGreaterThan(limestone.positions.length * 2);
  });
});

describe("clutter density (2-15)", () => {
  it("piles litter under closed canopy, not on open grassland", () => {
    let forest = 0;
    let grass = 0;
    expect(CLOSED_FOREST_WINDOW.meanDensity, "clutter fixture is closed forest").toBeGreaterThan(0.03);
    for (const cell of CLOSED_FOREST_WINDOW.cells) {
      forest += cellAt(sampler(TerrainBiome.FOREST, 0.7), 171, cell.x, cell.z).clutter.length;
      grass += cellAt(sampler(TerrainBiome.GRASSLAND, 0.3), 171, cell.x, cell.z).clutter.length;
    }
    expect(forest).toBeGreaterThan(60);
    expect(grass).toBeLessThan(forest / 2.5);
  });

  it("gates moss cushions on moisture", () => {
    const dry = [];
    for (let cell = 0; cell < 8; cell += 1) {
      dry.push(...cellAt(sampler(TerrainBiome.FOREST, 0.4), 171, cell, 1).clutter);
    }
    expect(dry.length).toBeGreaterThan(20);
    expect(dry.filter((piece) => piece.clutterKind === "mossCushion")).toHaveLength(0);
    const wet = [];
    for (let cell = 0; cell < 8; cell += 1) {
      wet.push(...cellAt(sampler(TerrainBiome.FOREST, 0.75), 171, cell, 1).clutter);
    }
    expect(wet.some((piece) => piece.clutterKind === "mossCushion")).toBe(true);
  });

  it("is deterministic", () => {
    const a = cellAt(sampler(TerrainBiome.FOREST, 0.7));
    const b = cellAt(sampler(TerrainBiome.FOREST, 0.7));
    expect(a.clutter).toEqual(b.clutter);
  });
});

describe("rock placement (2-15)", () => {
  it("sinks rocks into the ground by the plan's fraction", () => {
    const rocks = [];
    for (let cell = 0; cell < 6; cell += 1) {
      rocks.push(...cellAt(sampler(TerrainBiome.HIGHLAND, 0.4, 0.3, 700), 171, cell, 2).rocks);
    }
    expect(rocks.length).toBeGreaterThan(10);
    for (const rock of rocks) {
      const sink = 700 - rock.y;
      const vertical = rock.radiusMeters * rock.flattening;
      expect(sink).toBeGreaterThanOrEqual(vertical * 0.12 - 1e-9);
      expect(sink).toBeLessThanOrEqual(vertical * 0.37 + 1e-9);
    }
  });

  it("aligns ~60% toward the terrain normal through the quaternion", () => {
    // A 30°-tilted normal at blend 0.6 should tilt the object's up axis to
    // ~60% of the way — between pure-up and the full normal.
    const tilt = Math.PI / 6;
    const normal = { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 };
    const q = normalAlignedQuaternion(normal, 1.3, 0.6);
    const up = rotateByQuaternion([0, 1, 0], q);
    const resultTilt = Math.acos(Math.min(1, up[1]));
    expect(resultTilt).toBeGreaterThan(tilt * 0.4);
    expect(resultTilt).toBeLessThan(tilt * 0.8);
    // Blend 0 is a pure yaw: up stays up.
    const yawOnly = rotateByQuaternion([0, 1, 0], normalAlignedQuaternion(normal, 1.3, 0));
    expect(yawOnly[1]).toBeCloseTo(1, 6);
  });

  it("sheds winter snow from steep rock faces — the rule canopy could not test", () => {
    // Deep winter at 45°N puts the snowline at ~84 m ASL. Trees stop
    // growing at slope ~0.2, but rocks reach the 0.55+ shedding domain.
    const meanMin = (slope: number) => {
      const rocks = [];
      for (let cell = 0; cell < 8; cell += 1) {
        rocks.push(
          ...cellAt(sampler(TerrainBiome.HIGHLAND, 0.4, slope, 700), 16, cell, 3).rocks,
        );
      }
      expect(rocks.length).toBeGreaterThan(8);
      return rocks.reduce(
        (sum, rock) => sum + Math.min(rock.color[0], rock.color[1], rock.color[2]),
        0,
      ) / rocks.length;
    };
    const flatWhite = meanMin(0.2);
    const steepWhite = meanMin(0.8);
    // Shedding at slope 0.8 keeps 45% of the cover: measured ≈ 0.97 vs
    // 0.89 mean-min channel.
    expect(flatWhite).toBeGreaterThan(steepWhite + 0.06);
  });
});
