import { describe, expect, it } from "vitest";
import {
  TerrainBiome,
  createWorld,
  generateTerrainGridIndices,
  generateTerrainTile,
  getTerrainTileTransferables,
  terrainTileKey,
  terrainTileVertexCoordinate,
  worldToTerrainTile,
} from "../src/world";

function expectEastWestEdgesToMatch(
  west: ReturnType<typeof generateTerrainTile>,
  east: ReturnType<typeof generateTerrainTile>,
): void {
  const resolution = west.resolution;
  expect(east.resolution).toBe(resolution);
  for (let row = 0; row < resolution; row += 1) {
    const westVertex = row * resolution + resolution - 1;
    const eastVertex = row * resolution;
    expect(west.heights[westVertex]).toBe(east.heights[eastVertex]);
    expect(west.moisture[westVertex]).toBe(east.moisture[eastVertex]);
    expect(west.biomes[westVertex]).toBe(east.biomes[eastVertex]);
    for (let component = 0; component < 3; component += 1) {
      expect(west.normals[westVertex * 3 + component]).toBe(
        east.normals[eastVertex * 3 + component],
      );
      expect(west.colors[westVertex * 3 + component]).toBe(east.colors[eastVertex * 3 + component]);
    }
  }
}

describe("terrain tiles", () => {
  const world = createWorld("tile-edge-tests");

  it("uses typed arrays with bounded values and reusable buffers", () => {
    const resolution = 9;
    const count = resolution * resolution;
    const buffers = {
      heights: new Float32Array(count + 8),
      normals: new Float32Array(count * 3 + 8),
      colors: new Uint8Array(count * 3 + 8),
      moisture: new Uint8Array(count + 8),
      biomes: new Uint8Array(count + 8),
    };
    const tile = generateTerrainTile(
      world,
      { tileX: -1, tileZ: 0, size: 512, resolution },
      buffers,
    );
    expect(tile.heights).toBe(buffers.heights);
    expect(tile.normals).toBe(buffers.normals);
    expect(tile.colors).toBe(buffers.colors);
    expect(tile.moisture).toBe(buffers.moisture);
    expect(tile.biomes).toBe(buffers.biomes);
    expect(tile.originX).toBe(-512);
    expect(tile.originZ).toBe(0);
    expect(tile.spacing).toBe(64);
    expect(tile.minHeight).toBeLessThanOrEqual(tile.maxHeight);
    expect(Array.from(tile.heights.slice(0, count)).every(Number.isFinite)).toBe(true);
    expect(Array.from(tile.normals.slice(0, count * 3)).every(Number.isFinite)).toBe(true);
    expect(Array.from(tile.biomes.slice(0, count)).every((value) => value >= 0 && value <= TerrainBiome.RUNWAY)).toBe(true);
  });

  it("matches every attribute on positive adjacent tile edges", () => {
    const west = generateTerrainTile(world, { tileX: 2, tileZ: -3, size: 777, resolution: 17 });
    const east = generateTerrainTile(world, { tileX: 3, tileZ: -3, size: 777, resolution: 17 });
    expectEastWestEdgesToMatch(west, east);
  });

  it("matches every attribute across the negative/positive origin boundary", () => {
    const west = generateTerrainTile(world, { tileX: -1, tileZ: -1, size: 640, resolution: 13 });
    const east = generateTerrainTile(world, { tileX: 0, tileZ: -1, size: 640, resolution: 13 });
    expectEastWestEdgesToMatch(west, east);
  });

  it("matches north/south tile edges", () => {
    const north = generateTerrainTile(world, { tileX: -2, tileZ: 4, size: 500, resolution: 11 });
    const south = generateTerrainTile(world, { tileX: -2, tileZ: 5, size: 500, resolution: 11 });
    for (let column = 0; column < north.resolution; column += 1) {
      const northVertex = (north.resolution - 1) * north.resolution + column;
      const southVertex = column;
      expect(north.heights[northVertex]).toBe(south.heights[southVertex]);
      expect(north.moisture[northVertex]).toBe(south.moisture[southVertex]);
      expect(north.biomes[northVertex]).toBe(south.biomes[southVertex]);
      for (let component = 0; component < 3; component += 1) {
        expect(north.normals[northVertex * 3 + component]).toBe(
          south.normals[southVertex * 3 + component],
        );
        expect(north.colors[northVertex * 3 + component]).toBe(
          south.colors[southVertex * 3 + component],
        );
      }
    }
  });

  it("can generate the lightweight height-only collision representation", () => {
    const tile = generateTerrainTile(world, {
      tileX: 0,
      tileZ: 0,
      resolution: 5,
      includeNormals: false,
      includeColors: false,
      includeClimate: false,
    });
    expect(tile.heights).toHaveLength(25);
    expect(tile.normals).toHaveLength(0);
    expect(tile.colors).toHaveLength(0);
    expect(tile.moisture).toHaveLength(0);
    expect(tile.biomes).toHaveLength(0);
  });

  it("builds correctly typed triangle indices", () => {
    const small = generateTerrainGridIndices(3);
    expect(small).toBeInstanceOf(Uint16Array);
    expect(Array.from(small)).toEqual([
      0, 3, 1, 1, 3, 4,
      1, 4, 2, 2, 4, 5,
      3, 6, 4, 4, 6, 7,
      4, 7, 5, 5, 7, 8,
    ]);
    expect(generateTerrainGridIndices(513)).toBeInstanceOf(Uint32Array);
  });

  it("provides stable tile-address and transfer helpers", () => {
    expect(terrainTileKey(-4, 7)).toBe("0:-4:7");
    expect(worldToTerrainTile(-0.001, 512)).toBe(-1);
    expect(worldToTerrainTile(0, 512)).toBe(0);
    expect(terrainTileVertexCoordinate(-1, 512, 4, 5)).toBe(0);
    expect(terrainTileVertexCoordinate(0, 512, 0, 5)).toBe(0);

    const tile = generateTerrainTile(world, { tileX: 0, tileZ: 0, resolution: 3 });
    const transferables = getTerrainTileTransferables(tile);
    expect(new Set(transferables).size).toBe(transferables.length);
    expect(transferables).toContain(tile.heights.buffer);
  });

  it("rejects invalid tile dimensions before allocating", () => {
    expect(() => generateTerrainTile(world, { tileX: 0.5, tileZ: 0 })).toThrow(RangeError);
    expect(() => generateTerrainTile(world, { tileX: 0, tileZ: 0, size: 0 })).toThrow(RangeError);
    expect(() => generateTerrainTile(world, { tileX: 0, tileZ: 0, resolution: 1 })).toThrow(RangeError);
  });
});
