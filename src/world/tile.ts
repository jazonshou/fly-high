import { sampleTerrain, sampleTerrainHeight } from "./terrain";
import { TerrainBiome, type TerrainSample, type TerrainTileBuffers, type TerrainTileData, type TerrainTileOptions, type WorldDefinition } from "./types";

export const DEFAULT_TERRAIN_TILE_SIZE = 1_024;
export const DEFAULT_TERRAIN_TILE_RESOLUTION = 33;
export const MAX_TERRAIN_TILE_RESOLUTION = 513;

function requireInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new RangeError(`${label} must be an integer`);
  return value;
}

function normalizeOptions(options: TerrainTileOptions): Required<TerrainTileOptions> {
  const tileX = requireInteger(options.tileX, "tileX");
  const tileZ = requireInteger(options.tileZ, "tileZ");
  const size = options.size ?? DEFAULT_TERRAIN_TILE_SIZE;
  const resolution = options.resolution ?? DEFAULT_TERRAIN_TILE_RESOLUTION;
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError("Terrain tile size must be finite and greater than zero");
  }
  requireInteger(resolution, "resolution");
  if (resolution < 2 || resolution > MAX_TERRAIN_TILE_RESOLUTION) {
    throw new RangeError(`resolution must be between 2 and ${MAX_TERRAIN_TILE_RESOLUTION}`);
  }
  return {
    tileX,
    tileZ,
    size,
    resolution,
    includeNormals: options.includeNormals ?? true,
    includeColors: options.includeColors ?? true,
    includeClimate: options.includeClimate ?? true,
  };
}

/** A stable string key suitable for maps, caches, and worker cancellation. */
export function terrainTileKey(tileX: number, tileZ: number, level = 0): string {
  requireInteger(tileX, "tileX");
  requireInteger(tileZ, "tileZ");
  requireInteger(level, "level");
  return `${level}:${tileX}:${tileZ}`;
}

export function worldToTerrainTile(value: number, tileSize = DEFAULT_TERRAIN_TILE_SIZE): number {
  if (!Number.isFinite(value) || !Number.isFinite(tileSize) || tileSize <= 0) {
    throw new RangeError("World coordinate and tile size must be finite; tile size must be positive");
  }
  return Math.floor(value / tileSize);
}

/**
 * Returns an exact global coordinate for a tile-grid vertex. Explicit edge
 * handling makes the shared edge bit-identical even for negative tile indices.
 */
export function terrainTileVertexCoordinate(
  tileIndex: number,
  tileSize: number,
  vertexIndex: number,
  resolution: number,
): number {
  requireInteger(tileIndex, "tileIndex");
  requireInteger(vertexIndex, "vertexIndex");
  requireInteger(resolution, "resolution");
  if (!Number.isFinite(tileSize) || tileSize <= 0 || resolution < 2) {
    throw new RangeError("Invalid tile size or resolution");
  }
  if (vertexIndex < 0 || vertexIndex >= resolution) {
    throw new RangeError("vertexIndex lies outside the tile grid");
  }
  if (vertexIndex === 0) return tileIndex * tileSize;
  if (vertexIndex === resolution - 1) return (tileIndex + 1) * tileSize;
  return tileIndex * tileSize + (vertexIndex * tileSize) / (resolution - 1);
}

function requireCapacity(array: ArrayLike<number>, length: number, label: string): void {
  if (array.length < length) throw new RangeError(`${label} needs at least ${length} entries`);
}

function makeSampleTarget(): TerrainSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0,
    moisture: 0,
    temperature: 0,
    biome: TerrainBiome.GRASSLAND,
    biomeName: "grassland",
    color: { r: 0, g: 0, b: 0 },
    airportInfluence: 0,
    isRunway: false,
  };
}

/**
 * Generate a render-ready tile. Optional caller-owned buffers let a terrain
 * worker recycle memory rather than allocate for every streamed tile.
 */
export function generateTerrainTile(
  world: WorldDefinition,
  options: TerrainTileOptions,
  buffers: TerrainTileBuffers = { heights: new Float32Array(0) },
): TerrainTileData {
  const normalized = normalizeOptions(options);
  const { tileX, tileZ, size, resolution, includeNormals, includeColors, includeClimate } =
    normalized;
  const vertexCount = resolution * resolution;

  const heights =
    buffers.heights.length >= vertexCount ? buffers.heights : new Float32Array(vertexCount);
  const normals = includeNormals
    ? (buffers.normals?.length ?? 0) >= vertexCount * 3
      ? buffers.normals!
      : new Float32Array(vertexCount * 3)
    : new Float32Array(0);
  const colors = includeColors
    ? (buffers.colors?.length ?? 0) >= vertexCount * 3
      ? buffers.colors!
      : new Uint8Array(vertexCount * 3)
    : new Uint8Array(0);
  const moisture = includeClimate
    ? (buffers.moisture?.length ?? 0) >= vertexCount
      ? buffers.moisture!
      : new Uint8Array(vertexCount)
    : new Uint8Array(0);
  const biomes = includeClimate
    ? (buffers.biomes?.length ?? 0) >= vertexCount
      ? buffers.biomes!
      : new Uint8Array(vertexCount)
    : new Uint8Array(0);

  // Defensive checks also make mistakes clear if this function is later changed
  // to accept fixed-capacity transferable views.
  requireCapacity(heights, vertexCount, "heights");
  if (includeNormals) requireCapacity(normals, vertexCount * 3, "normals");
  if (includeColors) requireCapacity(colors, vertexCount * 3, "colors");
  if (includeClimate) {
    requireCapacity(moisture, vertexCount, "moisture");
    requireCapacity(biomes, vertexCount, "biomes");
  }

  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  const needsFullSample = includeNormals || includeColors || includeClimate;
  const sampleTarget = makeSampleTarget();

  for (let row = 0; row < resolution; row += 1) {
    const z = terrainTileVertexCoordinate(tileZ, size, row, resolution);
    for (let column = 0; column < resolution; column += 1) {
      const x = terrainTileVertexCoordinate(tileX, size, column, resolution);
      const vertexIndex = row * resolution + column;
      const sample = needsFullSample ? sampleTerrain(world, x, z, sampleTarget) : null;
      const height = sample?.height ?? sampleTerrainHeight(world, x, z);
      heights[vertexIndex] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);

      if (includeNormals && sample) {
        const normalOffset = vertexIndex * 3;
        normals[normalOffset] = sample.normal.x;
        normals[normalOffset + 1] = sample.normal.y;
        normals[normalOffset + 2] = sample.normal.z;
      }
      if (includeColors && sample) {
        const colorOffset = vertexIndex * 3;
        colors[colorOffset] = Math.round(sample.color.r * 255);
        colors[colorOffset + 1] = Math.round(sample.color.g * 255);
        colors[colorOffset + 2] = Math.round(sample.color.b * 255);
      }
      if (includeClimate && sample) {
        moisture[vertexIndex] = Math.round(sample.moisture * 255);
        biomes[vertexIndex] = sample.biome;
      }
    }
  }

  return {
    tileX,
    tileZ,
    originX: tileX * size,
    originZ: tileZ * size,
    size,
    resolution,
    spacing: size / (resolution - 1),
    heights,
    normals,
    colors,
    moisture,
    biomes,
    minHeight,
    maxHeight,
  };
}

/** Triangle-list indices for a regular square tile grid. */
export function generateTerrainGridIndices(resolution: number): Uint16Array | Uint32Array {
  requireInteger(resolution, "resolution");
  if (resolution < 2 || resolution > MAX_TERRAIN_TILE_RESOLUTION) {
    throw new RangeError(`resolution must be between 2 and ${MAX_TERRAIN_TILE_RESOLUTION}`);
  }
  const vertexCount = resolution * resolution;
  const IndexArray = vertexCount <= 65_535 ? Uint16Array : Uint32Array;
  const indices = new IndexArray((resolution - 1) * (resolution - 1) * 6);
  let cursor = 0;
  for (let row = 0; row < resolution - 1; row += 1) {
    for (let column = 0; column < resolution - 1; column += 1) {
      const topLeft = row * resolution + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + resolution;
      const bottomRight = bottomLeft + 1;
      indices[cursor] = topLeft;
      indices[cursor + 1] = bottomLeft;
      indices[cursor + 2] = topRight;
      indices[cursor + 3] = topRight;
      indices[cursor + 4] = bottomLeft;
      indices[cursor + 5] = bottomRight;
      cursor += 6;
    }
  }
  return indices;
}

/** Unique ArrayBuffers that can be transferred from a generation worker. */
export function getTerrainTileTransferables(tile: TerrainTileData): ArrayBuffer[] {
  const buffers = [
    tile.heights.buffer,
    tile.normals.buffer,
    tile.colors.buffer,
    tile.moisture.buffer,
    tile.biomes.buffer,
  ];
  const transferable = new Set<ArrayBuffer>();
  for (const buffer of buffers) {
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) transferable.add(buffer);
  }
  return [...transferable];
}
