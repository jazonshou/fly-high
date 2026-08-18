import { describe, expect, it } from "vitest";
import { coreToStoredIndex, storedEdge } from "../src/render/webgpu/world/pageGeometry";
import { createWorld, generateTerrainTile } from "../src/world";

/**
 * 1B-1, assertion 22 — the audit's normal measurement as a permanent guard.
 *
 * The old path uploaded a 2 m analytic central difference at every LOD:
 * 24–35° mean error at 128 m spacing, with normals pointing into the surface.
 * Grid normals must agree with the triangles actually on screen at every
 * spacing, so the angle between a vertex normal and its adjacent triangles'
 * geometric normals stays small — and roughly spacing-independent.
 */

const WORLD = createWorld("tile-normal-audit");

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const length = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / length, y: ny / length, z: nz / length };
}

function angleDegrees(a: Vec3, b: Vec3): number {
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Mean/max angle between vertex normals and adjacent triangle normals. */
function normalAgreement(size: number, resolution: number) {
  const tile = generateTerrainTile(WORLD, { tileX: 2, tileZ: -3, size, resolution });
  const spacing = tile.spacing;
  const vertex = (row: number, column: number): Vec3 => ({
    x: column * spacing,
    y: tile.heights[row * resolution + column]!,
    z: row * spacing,
  });
  const normalAt = (row: number, column: number): Vec3 => {
    const offset = (row * resolution + column) * 3;
    return {
      x: tile.normals[offset]!,
      y: tile.normals[offset + 1]!,
      z: tile.normals[offset + 2]!,
    };
  };
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let row = 1; row < resolution - 1; row += 2) {
    for (let column = 1; column < resolution - 1; column += 2) {
      const center = vertex(row, column);
      const normal = normalAt(row, column);
      // The four axis-adjacent triangles around the vertex.
      const triangles: [Vec3, Vec3, Vec3][] = [
        [center, vertex(row, column + 1), vertex(row + 1, column)],
        [center, vertex(row + 1, column), vertex(row, column - 1)],
        [center, vertex(row, column - 1), vertex(row - 1, column)],
        [center, vertex(row - 1, column), vertex(row, column + 1)],
      ];
      for (const [a, b, c] of triangles) {
        const angle = angleDegrees(normal, triangleNormal(a, b, c));
        sum += angle;
        max = Math.max(max, angle);
        count += 1;
      }
    }
  }
  return { mean: sum / count, max };
}

describe("tile grid normals (1B-1)", () => {
  it("agrees with the rendered triangles at every LOD spacing", () => {
    // Spacings 8 → 512 m at resolution 33; the audit measured the old path at
    // 24–35° MEAN error by 128 m. A vertex normal is the average of the
    // triangles around it, so a bound well below the audit's floor holds at
    // every spacing without hiding a regression.
    for (const size of [256, 1_024, 4_096, 16_384]) {
      const { mean, max } = normalAgreement(size, 33);
      const spacing = size / 32;
      expect(mean, `mean angle at ${spacing} m spacing`).toBeLessThan(12);
      expect(max, `max angle at ${spacing} m spacing`).toBeLessThan(60);
    }
  });

  it("keeps shared-edge normals bit-identical between adjacent tiles", () => {
    const resolution = 17;
    const size = 777;
    const west = generateTerrainTile(WORLD, { tileX: 4, tileZ: 1, size, resolution });
    const east = generateTerrainTile(WORLD, { tileX: 5, tileZ: 1, size, resolution });
    for (let row = 0; row < resolution; row += 1) {
      const westOffset = (row * resolution + resolution - 1) * 3;
      const eastOffset = (row * resolution + 0) * 3;
      for (let component = 0; component < 3; component += 1) {
        expect(west.normals[westOffset + component]).toBe(east.normals[eastOffset + component]);
      }
    }
  });

  it("stores a halo band addressed by coreToStoredIndex", () => {
    const resolution = 9;
    const size = 512;
    const halo = 1;
    const plain = generateTerrainTile(WORLD, { tileX: -2, tileZ: 3, size, resolution });
    const withHalo = generateTerrainTile(WORLD, { tileX: -2, tileZ: 3, size, resolution, halo });
    const edge = storedEdge(resolution, halo);
    expect(withHalo.heights.length).toBe(edge * edge);
    // Core samples agree bit-exactly with the halo-free tile.
    for (let row = 0; row < resolution; row += 1) {
      for (let column = 0; column < resolution; column += 1) {
        expect(withHalo.heights[coreToStoredIndex(row, column, resolution, halo)]).toBe(
          plain.heights[row * resolution + column],
        );
      }
    }
    // Halo samples agree bit-exactly with the neighbouring tile's interior.
    const eastNeighbour = generateTerrainTile(WORLD, { tileX: -1, tileZ: 3, size, resolution });
    for (let row = 0; row < resolution; row += 1) {
      expect(withHalo.heights[coreToStoredIndex(row, resolution, resolution, halo)]).toBe(
        eastNeighbour.heights[row * resolution + 1],
      );
    }
    // Bounds still describe the core, not the halo band.
    expect(withHalo.minHeight).toBe(plain.minHeight);
    expect(withHalo.maxHeight).toBe(plain.maxHeight);
    expect(() =>
      generateTerrainTile(WORLD, { tileX: 0, tileZ: 0, size, resolution, halo: 9 }),
    ).toThrow(RangeError);
  });
});
