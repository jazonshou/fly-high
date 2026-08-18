import { coreToStoredIndex, storedEdge } from "@/src/render/webgpu/world/pageGeometry";
import {
  sampleFilteredTerrainHeight,
  sampleTerrainClimate,
  sampleTerrainMoisture,
  sampleTerrainSurface,
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  terrainTemperatureFromClimate,
} from "./terrain";
import { TerrainBiome, type TerrainSample, type TerrainTileBuffers, type TerrainTileData, type TerrainTileOptions, type WorldDefinition } from "./types";

export const DEFAULT_TERRAIN_TILE_SIZE = 1_024;
export const DEFAULT_TERRAIN_TILE_RESOLUTION = 33;
export const MAX_TERRAIN_TILE_RESOLUTION = 513;
export const MAX_TERRAIN_TILE_HALO = 8;

function requireInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new RangeError(`${label} must be an integer`);
  return value;
}

function normalizeOptions(options: TerrainTileOptions): Required<TerrainTileOptions> {
  const tileX = requireInteger(options.tileX, "tileX");
  const tileZ = requireInteger(options.tileZ, "tileZ");
  const size = options.size ?? DEFAULT_TERRAIN_TILE_SIZE;
  const resolution = options.resolution ?? DEFAULT_TERRAIN_TILE_RESOLUTION;
  const halo = options.halo ?? 0;
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError("Terrain tile size must be finite and greater than zero");
  }
  requireInteger(resolution, "resolution");
  if (resolution < 2 || resolution > MAX_TERRAIN_TILE_RESOLUTION) {
    throw new RangeError(`resolution must be between 2 and ${MAX_TERRAIN_TILE_RESOLUTION}`);
  }
  requireInteger(halo, "halo");
  if (halo < 0 || halo > MAX_TERRAIN_TILE_HALO) {
    throw new RangeError(`halo must be between 0 and ${MAX_TERRAIN_TILE_HALO}`);
  }
  return {
    tileX,
    tileZ,
    size,
    resolution,
    includeNormals: options.includeNormals ?? true,
    includeColors: options.includeColors ?? true,
    includeClimate: options.includeClimate ?? true,
    halo,
    dayOfYear: options.dayOfYear ?? TERRAIN_REFERENCE_DAY_OF_YEAR,
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

/**
 * Global grid coordinate for a vertex index that may lie outside [0,
 * resolution) — the halo band. Out-of-range indices map to the neighbouring
 * tile's interior index and reuse terrainTileVertexCoordinate's exact-edge
 * arithmetic, so a halo sample is bit-identical to the height the adjacent
 * tile computes for the same world vertex. That is what makes grid normals
 * agree across tile seams exactly.
 */
function extendedVertexCoordinate(
  tileIndex: number,
  tileSize: number,
  vertexIndex: number,
  resolution: number,
): number {
  if (vertexIndex >= 0 && vertexIndex < resolution) {
    return terrainTileVertexCoordinate(tileIndex, tileSize, vertexIndex, resolution);
  }
  const cells = resolution - 1;
  const tileShift = Math.floor(vertexIndex / cells);
  return terrainTileVertexCoordinate(
    tileIndex + tileShift,
    tileSize,
    vertexIndex - tileShift * cells,
    resolution,
  );
}

/** Reused per-call scratch for the height grid; the worker is single-threaded. */
let heightScratch = new Float32Array(0);

function scratchGrid(edge: number): Float32Array {
  const required = edge * edge;
  if (heightScratch.length < required) heightScratch = new Float32Array(required);
  return heightScratch;
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
 *
 * 1B-1: normals come from central differences of the tile's own height grid
 * at the tile's own spacing — band-limited to the mesh that is actually on
 * screen — and slope for biome/colour classification comes from that same
 * normal. The analytic 2 m kernel normal is collision-only. One internal
 * halo ring supplies edge neighbours; its samples reuse the neighbouring
 * tile's exact vertex arithmetic, so shared-edge normals stay bit-identical
 * across tiles.
 */
export function generateTerrainTile(
  world: WorldDefinition,
  options: TerrainTileOptions,
  buffers: TerrainTileBuffers = { heights: new Float32Array(0) },
): TerrainTileData {
  const normalized = normalizeOptions(options);
  const {
    tileX, tileZ, size, resolution, includeNormals, includeColors, includeClimate, halo, dayOfYear,
  } =
    normalized;
  const vertexCount = resolution * resolution;
  const heightEdge = storedEdge(resolution, halo);
  const heightCount = heightEdge * heightEdge;
  // Central differencing needs one ring beyond every height the output
  // stores, whether that output is core-only or carries its own halo band.
  const scratchHalo = includeNormals ? halo + 1 : halo;
  const scratchEdge = resolution + 2 * scratchHalo;

  const heights =
    buffers.heights.length >= heightCount ? buffers.heights : new Float32Array(heightCount);
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
  requireCapacity(heights, heightCount, "heights");
  if (includeNormals) requireCapacity(normals, vertexCount * 3, "normals");
  if (includeColors) requireCapacity(colors, vertexCount * 3, "colors");
  if (includeClimate) {
    requireCapacity(moisture, vertexCount, "moisture");
    requireCapacity(biomes, vertexCount, "biomes");
  }

  // 1B-2: the tile's grid spacing is the sampling footprint. L0 (8 m) and L1
  // (16 m) are unchanged or nearly so — the finest kernel wavelength is 43 m —
  // and divergence from the physics kernel begins only at coarse render LODs.
  const filterWidthMeters = size / (resolution - 1);
  const scratch = scratchGrid(scratchEdge);
  for (let row = -scratchHalo; row < resolution + scratchHalo; row += 1) {
    const z = extendedVertexCoordinate(tileZ, size, row, resolution);
    const scratchRow = (row + scratchHalo) * scratchEdge + scratchHalo;
    for (let column = -scratchHalo; column < resolution + scratchHalo; column += 1) {
      const x = extendedVertexCoordinate(tileX, size, column, resolution);
      scratch[scratchRow + column] = sampleFilteredTerrainHeight(world, x, z, filterWidthMeters);
    }
  }

  // The stored heights output: the core plus the requested halo band.
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (let row = -halo; row < resolution + halo; row += 1) {
    const scratchRow = (row + scratchHalo) * scratchEdge + scratchHalo;
    for (let column = -halo; column < resolution + halo; column += 1) {
      const height = scratch[scratchRow + column]!;
      heights[coreToStoredIndex(row, column, resolution, halo)] = height;
      // Mesh bounds describe the renderable core, not the halo band.
      if (row >= 0 && row < resolution && column >= 0 && column < resolution) {
        minHeight = Math.min(minHeight, height);
        maxHeight = Math.max(maxHeight, height);
      }
    }
  }

  const spacing = size / (resolution - 1);
  const needsSurface = includeColors || includeClimate;
  const sampleTarget = needsSurface ? makeSampleTarget() : null;

  // Climate fields (finest wavelength 850 m) on a 9×9 subgrid, bilinearly
  // interpolated per vertex — nine noise evaluations per vertex otherwise.
  // Subgrid nodes sit on shared tile-edge vertices, so interpolated edge
  // values stay bit-identical across tiles. Resolutions that do not divide
  // into eight cells fall back to exact per-vertex sampling.
  const climateStep = resolution > 8 && (resolution - 1) % 8 === 0 ? (resolution - 1) / 8 : 0;
  let moistureGrid: Float32Array | null = null;
  let climateGrid: Float32Array | null = null;
  if (needsSurface && climateStep > 0) {
    moistureGrid = new Float32Array(81);
    climateGrid = new Float32Array(81);
    for (let subRow = 0; subRow < 9; subRow += 1) {
      const z = terrainTileVertexCoordinate(tileZ, size, subRow * climateStep, resolution);
      for (let subColumn = 0; subColumn < 9; subColumn += 1) {
        const x = terrainTileVertexCoordinate(tileX, size, subColumn * climateStep, resolution);
        moistureGrid[subRow * 9 + subColumn] = sampleTerrainMoisture(world, x, z, 0);
        climateGrid[subRow * 9 + subColumn] = sampleTerrainClimate(world, x, z);
      }
    }
  }
  const interpolateSubgrid = (grid: Float32Array, row: number, column: number): number => {
    const gridRow = row / climateStep;
    const gridColumn = column / climateStep;
    const row0 = Math.min(7, Math.floor(gridRow));
    const column0 = Math.min(7, Math.floor(gridColumn));
    const fr = gridRow - row0;
    const fc = gridColumn - column0;
    const top = grid[row0 * 9 + column0]! * (1 - fc) + grid[row0 * 9 + column0 + 1]! * fc;
    const bottom =
      grid[(row0 + 1) * 9 + column0]! * (1 - fc) + grid[(row0 + 1) * 9 + column0 + 1]! * fc;
    return top * (1 - fr) + bottom * fr;
  };

  if (includeNormals || needsSurface) {
    const inverseDoubleSpacing = 1 / (2 * spacing);
    for (let row = 0; row < resolution; row += 1) {
      const z = terrainTileVertexCoordinate(tileZ, size, row, resolution);
      const scratchRow = (row + scratchHalo) * scratchEdge + scratchHalo;
      for (let column = 0; column < resolution; column += 1) {
        const vertexIndex = row * resolution + column;
        let normalY = 1;
        if (includeNormals) {
          const left = scratch[scratchRow + column - 1]!;
          const right = scratch[scratchRow + column + 1]!;
          const back = scratch[scratchRow + column - scratchEdge]!;
          const front = scratch[scratchRow + column + scratchEdge]!;
          const gradientX = (right - left) * inverseDoubleSpacing;
          const gradientZ = (front - back) * inverseDoubleSpacing;
          const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
          const normalOffset = vertexIndex * 3;
          normals[normalOffset] = -gradientX * inverseLength;
          normals[normalOffset + 1] = inverseLength;
          normals[normalOffset + 2] = -gradientZ * inverseLength;
          normalY = inverseLength;
        }
        if (needsSurface && sampleTarget) {
          const x = terrainTileVertexCoordinate(tileX, size, column, resolution);
          const height = scratch[scratchRow + column]!;
          const slope = Math.min(1, Math.max(0, 1 - normalY));
          if (moistureGrid && climateGrid) {
            sampleTerrainSurface(
              world,
              x,
              z,
              height,
              slope,
              sampleTarget,
              dayOfYear,
              interpolateSubgrid(moistureGrid, row, column),
              terrainTemperatureFromClimate(
                world,
                interpolateSubgrid(climateGrid, row, column),
                height,
              ),
            );
          } else {
            sampleTerrainSurface(world, x, z, height, slope, sampleTarget, dayOfYear);
          }
          if (includeColors) {
            const colorOffset = vertexIndex * 3;
            colors[colorOffset] = Math.round(sampleTarget.color.r * 255);
            colors[colorOffset + 1] = Math.round(sampleTarget.color.g * 255);
            colors[colorOffset + 2] = Math.round(sampleTarget.color.b * 255);
          }
          if (includeClimate) {
            moisture[vertexIndex] = Math.round(sampleTarget.moisture * 255);
            biomes[vertexIndex] = sampleTarget.biome;
          }
        }
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
    spacing,
    dayOfYear,
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
