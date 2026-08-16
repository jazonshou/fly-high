export interface TerrainMorphEdges {
  west: boolean;
  east: boolean;
  north: boolean;
  south: boolean;
}

export interface TerrainMorphResult {
  changed: boolean;
  minHeight: number;
  maxHeight: number;
}

function smoothstep01(value: number): number {
  const amount = Math.min(1, Math.max(0, value));
  return amount * amount * (3 - 2 * amount);
}

/** Number of fine segments represented by one segment of the nested far grid. */
export function terrainMorphCoarseStride(
  nearVertexResolution: number,
  farVertexResolution: number,
  farTileScale = 8,
): number {
  const nearSegments = nearVertexResolution - 1;
  const farSegments = farVertexResolution - 1;
  const numerator = nearSegments * farTileScale;
  if (
    !Number.isInteger(nearVertexResolution) ||
    !Number.isInteger(farVertexResolution) ||
    nearSegments < 1 ||
    farSegments < 1 ||
    numerator % farSegments !== 0
  ) {
    throw new RangeError("Near and far terrain grids must form an integer nested LOD");
  }
  const stride = numerator / farSegments;
  if (stride < 1 || nearSegments % stride !== 0) {
    throw new RangeError("Each near tile edge must contain complete far-grid segments");
  }
  return stride;
}

function edgeLinearHeight(
  sourceHeights: Float32Array,
  resolution: number,
  coarseStride: number,
  along: number,
  edgeVertex: (alongIndex: number) => number,
): number {
  const segments = resolution - 1;
  const start = Math.min(segments, Math.floor(along / coarseStride) * coarseStride);
  const end = Math.min(segments, start + coarseStride);
  if (start === end) return sourceHeights[edgeVertex(start)] ?? 0;
  const amount = (along - start) / (end - start);
  const startHeight = sourceHeights[edgeVertex(start)] ?? 0;
  const endHeight = sourceHeights[edgeVertex(end)] ?? startHeight;
  return startHeight + (endHeight - startHeight) * amount;
}

/**
 * Restores a near chunk from immutable source heights, then morphs only the
 * requested exterior bands to the exact piecewise-linear far-grid boundary.
 * The correction fades to zero over `fadeRows`, preserving full detail across
 * the rest of the near grid without adding geometry or frame-time work.
 */
export function applyTerrainBoundaryMorph(
  positions: Float32Array,
  sourceHeights: Float32Array,
  resolution: number,
  coarseStride: number,
  edges: TerrainMorphEdges,
  fadeRows = 10,
): TerrainMorphResult {
  const vertexCount = resolution * resolution;
  const segments = resolution - 1;
  if (
    positions.length !== vertexCount * 3 ||
    sourceHeights.length !== vertexCount ||
    !Number.isInteger(coarseStride) ||
    coarseStride < 1 ||
    segments % coarseStride !== 0 ||
    !Number.isInteger(fadeRows) ||
    fadeRows < 1
  ) {
    throw new RangeError("Invalid terrain morph buffers or grid configuration");
  }
  const bandRows = Math.min(fadeRows, segments);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  let changed = false;

  for (let row = 0; row < resolution; row += 1) {
    const westEdgeVertex = (along: number) => along * resolution;
    const eastEdgeVertex = (along: number) => along * resolution + segments;
    const westEdgeHeight = sourceHeights[westEdgeVertex(row)] ?? 0;
    const eastEdgeHeight = sourceHeights[eastEdgeVertex(row)] ?? 0;
    const westTarget = edges.west
      ? edgeLinearHeight(sourceHeights, resolution, coarseStride, row, westEdgeVertex)
      : westEdgeHeight;
    const eastTarget = edges.east
      ? edgeLinearHeight(sourceHeights, resolution, coarseStride, row, eastEdgeVertex)
      : eastEdgeHeight;

    for (let column = 0; column < resolution; column += 1) {
      const vertex = row * resolution + column;
      const sourceHeight = sourceHeights[vertex] ?? 0;
      let correction = 0;

      if (edges.west && column <= bandRows) {
        const weight = 1 - smoothstep01(column / bandRows);
        correction += (westTarget - westEdgeHeight) * weight;
      }
      if (edges.east && segments - column <= bandRows) {
        const weight = 1 - smoothstep01((segments - column) / bandRows);
        correction += (eastTarget - eastEdgeHeight) * weight;
      }
      if (edges.north && row <= bandRows) {
        const northEdgeVertex = (along: number) => along;
        const northEdgeHeight = sourceHeights[northEdgeVertex(column)] ?? 0;
        const target = edgeLinearHeight(
          sourceHeights,
          resolution,
          coarseStride,
          column,
          northEdgeVertex,
        );
        const weight = 1 - smoothstep01(row / bandRows);
        correction += (target - northEdgeHeight) * weight;
      }
      if (edges.south && segments - row <= bandRows) {
        const southEdgeVertex = (along: number) => segments * resolution + along;
        const southEdgeHeight = sourceHeights[southEdgeVertex(column)] ?? 0;
        const target = edgeLinearHeight(
          sourceHeights,
          resolution,
          coarseStride,
          column,
          southEdgeVertex,
        );
        const weight = 1 - smoothstep01((segments - row) / bandRows);
        correction += (target - southEdgeHeight) * weight;
      }

      const height = sourceHeight + correction;
      positions[vertex * 3 + 1] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
      if (Math.abs(correction) > 1e-7) changed = true;
    }
  }

  return { changed, minHeight, maxHeight };
}
