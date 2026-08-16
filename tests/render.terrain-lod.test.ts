import { describe, expect, it } from "vitest";
import {
  applyTerrainBoundaryMorph,
  terrainMorphCoarseStride,
} from "../src/render/TerrainLodMorph";
import { terrainVertexResolution } from "../src/render/TerrainRenderer";

function makeTerrainGrid(resolution: number): {
  positions: Float32Array;
  sourceHeights: Float32Array;
} {
  const positions = new Float32Array(resolution * resolution * 3);
  const sourceHeights = new Float32Array(resolution * resolution);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const vertex = row * resolution + column;
      const height =
        row * 1.7 +
        column * 0.6 +
        Math.sin(row * 1.91) * 32 +
        Math.cos(column * 1.37) * 11;
      sourceHeights[vertex] = height;
      positions[vertex * 3] = column;
      positions[vertex * 3 + 1] = height;
      positions[vertex * 3 + 2] = row;
    }
  }
  return { positions, sourceHeights };
}

function linearEdgeTarget(
  source: Float32Array,
  resolution: number,
  stride: number,
  row: number,
  column: number,
): number {
  const start = Math.floor(row / stride) * stride;
  const end = Math.min(resolution - 1, start + stride);
  const amount = start === end ? 0 : (row - start) / (end - start);
  const startHeight = source[start * resolution + column] ?? 0;
  const endHeight = source[end * resolution + column] ?? startHeight;
  return startHeight + (endHeight - startHeight) * amount;
}

function linearHorizontalEdgeTarget(
  source: Float32Array,
  resolution: number,
  stride: number,
  column: number,
  row: number,
): number {
  const start = Math.floor(column / stride) * stride;
  const end = Math.min(resolution - 1, start + stride);
  const amount = start === end ? 0 : (column - start) / (end - start);
  const startHeight = source[row * resolution + start] ?? 0;
  const endHeight = source[row * resolution + end] ?? startHeight;
  return startHeight + (endHeight - startHeight) * amount;
}

describe("nested terrain LOD boundary morph", () => {
  it("uses integer nested strides at every quality", () => {
    expect(terrainMorphCoarseStride(25, 25)).toBe(8);
    expect(terrainMorphCoarseStride(41, 33)).toBe(10);
    expect(terrainMorphCoarseStride(57, 57)).toBe(8);
    expect(terrainMorphCoarseStride(49, 49)).toBe(8);
    expect(terrainMorphCoarseStride(65, 65)).toBe(8);
    expect(() => terrainMorphCoarseStride(25, 21)).toThrow(RangeError);
    expect(() => terrainMorphCoarseStride(57, 45)).toThrow(RangeError);

    for (const quality of ["low", "medium", "high"] as const) {
      expect(() => terrainMorphCoarseStride(
        terrainVertexResolution(quality, "near"),
        terrainVertexResolution(quality, "far"),
      )).not.toThrow();
    }
  });

  it("matches the exact far-edge reconstruction and preserves the interior", () => {
    const resolution = 41;
    const stride = 10;
    const { positions, sourceHeights } = makeTerrainGrid(resolution);
    const result = applyTerrainBoundaryMorph(
      positions,
      sourceHeights,
      resolution,
      stride,
      { west: true, east: false, north: false, south: false },
      10,
    );

    let maximumBoundaryError = 0;
    for (let row = 0; row < resolution; row += 1) {
      const morphed = positions[(row * resolution) * 3 + 1] ?? 0;
      const target = linearEdgeTarget(sourceHeights, resolution, stride, row, 0);
      maximumBoundaryError = Math.max(maximumBoundaryError, Math.abs(morphed - target));
      const fadeEnd = positions[(row * resolution + 10) * 3 + 1] ?? 0;
      const interior = positions[(row * resolution + 20) * 3 + 1] ?? 0;
      expect(fadeEnd).toBe(sourceHeights[row * resolution + 10]);
      expect(interior).toBe(sourceHeights[row * resolution + 20]);
    }
    expect(maximumBoundaryError).toBeLessThan(1e-4);
    expect(result.changed).toBe(true);
    expect(Number.isFinite(result.minHeight)).toBe(true);
    expect(Number.isFinite(result.maxHeight)).toBe(true);
  });

  it("restores source heights before roles are deterministically reapplied", () => {
    const resolution = 41;
    const { positions, sourceHeights } = makeTerrainGrid(resolution);
    applyTerrainBoundaryMorph(
      positions,
      sourceHeights,
      resolution,
      10,
      { west: true, east: false, north: false, south: false },
    );
    const westMorphed = positions[(7 * resolution) * 3 + 1];
    expect(westMorphed).not.toBe(sourceHeights[7 * resolution]);

    applyTerrainBoundaryMorph(
      positions,
      sourceHeights,
      resolution,
      10,
      { west: false, east: true, north: false, south: false },
    );
    expect(positions[(7 * resolution) * 3 + 1]).toBe(sourceHeights[7 * resolution]);
    const eastVertex = 7 * resolution + resolution - 1;
    expect(positions[eastVertex * 3 + 1]).toBeCloseTo(
      linearEdgeTarget(sourceHeights, resolution, 10, 7, resolution - 1),
      5,
    );

    const firstPass = Array.from(positions);
    applyTerrainBoundaryMorph(
      positions,
      sourceHeights,
      resolution,
      10,
      { west: false, east: true, north: false, south: false },
    );
    expect(Array.from(positions)).toEqual(firstPass);
  });

  it("closes all four exterior edges without a corner discontinuity", () => {
    const resolution = 41;
    const stride = 10;
    const { positions, sourceHeights } = makeTerrainGrid(resolution);
    applyTerrainBoundaryMorph(
      positions,
      sourceHeights,
      resolution,
      stride,
      { west: true, east: true, north: true, south: true },
    );
    let maximumError = 0;
    for (let along = 0; along < resolution; along += 1) {
      const west = positions[(along * resolution) * 3 + 1] ?? 0;
      const eastVertex = along * resolution + resolution - 1;
      const east = positions[eastVertex * 3 + 1] ?? 0;
      const north = positions[along * 3 + 1] ?? 0;
      const southVertex = (resolution - 1) * resolution + along;
      const south = positions[southVertex * 3 + 1] ?? 0;
      maximumError = Math.max(
        maximumError,
        Math.abs(west - linearEdgeTarget(sourceHeights, resolution, stride, along, 0)),
        Math.abs(
          east - linearEdgeTarget(sourceHeights, resolution, stride, along, resolution - 1),
        ),
        Math.abs(
          north - linearHorizontalEdgeTarget(sourceHeights, resolution, stride, along, 0),
        ),
        Math.abs(
          south -
            linearHorizontalEdgeTarget(sourceHeights, resolution, stride, along, resolution - 1),
        ),
      );
    }
    expect(maximumError).toBeLessThan(1e-4);
  });
});
