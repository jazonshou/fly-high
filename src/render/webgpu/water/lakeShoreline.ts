import {
  buildTerrainMacroLakeFieldFromGrid,
  sampleTerrainMacroLakeField,
} from "@/src/render/webgpu/terrain/TerrainPageHydrology";

/**
 * W-5 (C-5) — real lake shorelines for graph-mode hydrology.
 *
 * The convex macro-texel cover this replaces was the recorded wave-R "fans
 * and 512 m ribbons" open item: a hull over 512 m texel corners either
 * overfilled concave masks (rejected by the overfill gate, dropping the lake)
 * or rendered lakes as axis-aligned squares. Here the shoreline is the 0.5
 * iso-contour of the canonical macro lake-coverage field — sampled through
 * the owned `TerrainPageHydrology` samplers, never re-derived — marched on a
 * per-lake fine grid, then Douglas-Peucker simplified.
 *
 * Islands: marching squares can emit interior (hole) rings, but
 * `TerrainLakePolygonExport` is deliberately a single ring (no schema
 * change), so only the largest-area ring is exported and hole rings are
 * dropped. Recorded W-5 residual; the ear-clip below accepts holes-free
 * rings only.
 */

/** Structural twin of ChannelNetworkGridLayout (avoids a circular import). */
export interface LakeShorelineGridLayout {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  /** World coordinate of sample (0, 0), not the outer cell edge. */
  readonly originX: number;
  readonly originZ: number;
}

export interface MacroLakeShorelineInput {
  /** 8-connected macro lake component (texel indices into the macro grid). */
  readonly component: readonly number[];
  readonly outletIndex: number;
  readonly spillElevationMeters: number;
  readonly lakeId: number;
  readonly layout: LakeShorelineGridLayout;
}

/**
 * Fine samples per 512 m macro texel: 128 m shoreline resolution at the
 * canonical layout (the 512 m mask coarseness is the recorded C-5 failure;
 * the W-5 recon fixed the target window at ~64-128 m). 8 subdivisions
 * (64 m) doubles ring fidelity but costs ~4x in one-time extraction — the
 * contour of a 13k-lake world already carries ~1.6M raw points at 64 m.
 */
export const LAKE_SHORELINE_FINE_SUBDIVISIONS = 4;
/** Douglas-Peucker tolerance, in fine-grid cells. */
export const LAKE_SHORELINE_SIMPLIFY_TOLERANCE_CELLS = 1;
/** Per-lake fine-node budget; oversized basins coarsen their subdivisions. */
const LAKE_SHORELINE_MAXIMUM_FINE_NODES = 1 << 20;
const CONTOUR_ISO = 0.5;
/**
 * Iso crossings are clamped strictly inside their grid edge so degenerate
 * node-exact crossings (coverage is frequently exactly 0.5 halfway between a
 * wet and a dry texel centre) cannot produce coincident ring vertices. The
 * contour deviates from the exact iso-line by at most 0.1% of a fine cell.
 */
const EDGE_PARAMETER_CLAMP = 1e-3;

function clampEdgeParameter(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1 - EDGE_PARAMETER_CLAMP, Math.max(EDGE_PARAMETER_CLAMP, value));
}

/**
 * Marching squares over a scalar node grid. Returns closed rings in
 * fractional grid coordinates (interleaved x, z). Nodes with `value >= iso`
 * are inside; saddle cells disambiguate on the cell-centre average, which
 * keeps every ring simple and every contour edge shared by exactly two
 * cells. The outermost node ring must be entirely outside for rings to
 * close (callers guarantee a dry margin).
 *
 * `activeCells` optionally names the only cells (index = z * (width - 1)
 * + x) that can carry a crossing; cells outside it are treated as uniform
 * and skipped without reading `values`. The caller guarantees no contour
 * crosses an unlisted cell — the shoreline extractor lists every fine cell
 * of the mixed (part-wet) macro cells, which is exact because coverage is
 * bilinear (uniform macro cells are constant 0/1 throughout).
 *
 * `W-1e`: the segment topology is held in typed arrays rather than the
 * `Map<edge, segment[]>` + `Map<edge, [x, z]>` pair W-5 shipped, and the
 * crossing point is DERIVED from the edge key at ring-emission time instead
 * of being memoized at first touch. Both are bit-preserving:
 *
 *  - Traversal order is unchanged. Segments keep their creation order, and
 *    each edge keeps its endpoint segments in registration order (a 1-based
 *    singly linked list threaded through the segments themselves), so the
 *    ring walk still takes the first unused segment at each edge.
 *  - The crossing point is unchanged. Both cells that share an interior edge
 *    computed it from the same two node values with the same expression
 *    (cell (x,z)'s `top` and cell (x,z-1)'s `bottom` both read
 *    values[z*width+x] and values[z*width+x+1]; `left`/`right` likewise), so
 *    which cell touched the edge first never affected the stored value and
 *    recomputing from the key reproduces it exactly.
 */
export function marchingSquaresIsoRings(
  width: number,
  height: number,
  values: ArrayLike<number>,
  iso: number,
  activeCells?: ArrayLike<number>,
): number[][] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
    throw new RangeError("Marching squares requires at least a 2x2 node grid");
  }
  if (values.length !== width * height) {
    throw new RangeError("Marching squares value count must match the node grid");
  }
  // Edge keys: horizontal edge (x,z)-(x+1,z) and vertical edge (x,z)-(x,z+1)
  // both key off their minimum node; the low bit separates the orientations.
  const edgeSpace = width * height * 2;
  // Head/tail of each edge's segment list, as 1-based segment ids so a fresh
  // zeroed array already means "no segments here".
  const edgeHead = new Int32Array(edgeSpace);
  const edgeTail = new Int32Array(edgeSpace);
  let capacity = 64;
  let segmentEdgeA = new Int32Array(capacity);
  let segmentEdgeB = new Int32Array(capacity);
  // Per endpoint slot, the next segment in that endpoint edge's list.
  let segmentNextA = new Int32Array(capacity);
  let segmentNextB = new Int32Array(capacity);
  let segmentCount = 0;

  const registerEndpoint = (edge: number, segment: number): void => {
    const tail = edgeTail[edge]!;
    if (tail === 0) edgeHead[edge] = segment;
    else if (segmentEdgeA[tail - 1] === edge) segmentNextA[tail - 1] = segment;
    else segmentNextB[tail - 1] = segment;
    edgeTail[edge] = segment;
  };
  const addSegment = (edgeA: number, edgeB: number): void => {
    if (segmentCount === capacity) {
      capacity *= 2;
      const grownEdgeA = new Int32Array(capacity);
      grownEdgeA.set(segmentEdgeA);
      segmentEdgeA = grownEdgeA;
      const grownEdgeB = new Int32Array(capacity);
      grownEdgeB.set(segmentEdgeB);
      segmentEdgeB = grownEdgeB;
      const grownNextA = new Int32Array(capacity);
      grownNextA.set(segmentNextA);
      segmentNextA = grownNextA;
      const grownNextB = new Int32Array(capacity);
      grownNextB.set(segmentNextB);
      segmentNextB = grownNextB;
    }
    segmentEdgeA[segmentCount] = edgeA;
    segmentEdgeB[segmentCount] = edgeB;
    segmentCount += 1;
    registerEndpoint(edgeA, segmentCount);
    registerEndpoint(edgeB, segmentCount);
  };

  const marchCell = (x: number, z: number): void => {
    const node = z * width + x;
    const v00 = values[node]!;
    const v10 = values[node + 1]!;
    const v01 = values[node + width]!;
    const v11 = values[node + width + 1]!;
    const caseIndex = (v00 >= iso ? 1 : 0)
      | (v10 >= iso ? 2 : 0)
      | (v11 >= iso ? 4 : 0)
      | (v01 >= iso ? 8 : 0);
    if (caseIndex === 0 || caseIndex === 15) return;
    const top = node * 2;
    const bottom = (node + width) * 2;
    const left = node * 2 + 1;
    const right = (node + 1) * 2 + 1;
    switch (caseIndex) {
      case 1: case 14: addSegment(top, left); break;
      case 2: case 13: addSegment(top, right); break;
      case 4: case 11: addSegment(right, bottom); break;
      case 8: case 7: addSegment(left, bottom); break;
      case 3: case 12: addSegment(left, right); break;
      case 6: case 9: addSegment(top, bottom); break;
      case 5: {
        // in00/in11 inside. Centre decides whether they connect.
        if ((v00 + v10 + v01 + v11) * 0.25 >= iso) {
          addSegment(top, right);
          addSegment(left, bottom);
        } else {
          addSegment(top, left);
          addSegment(right, bottom);
        }
        break;
      }
      case 10: {
        // in10/in01 inside.
        if ((v00 + v10 + v01 + v11) * 0.25 >= iso) {
          addSegment(top, left);
          addSegment(right, bottom);
        } else {
          addSegment(top, right);
          addSegment(left, bottom);
        }
        break;
      }
      default: break;
    }
  };
  if (activeCells) {
    const cellWidth = width - 1;
    for (let index = 0; index < activeCells.length; index += 1) {
      const cell = activeCells[index]!;
      marchCell(cell % cellWidth, Math.floor(cell / cellWidth));
    }
  } else {
    for (let z = 0; z < height - 1; z += 1) {
      for (let x = 0; x < width - 1; x += 1) marchCell(x, z);
    }
  }

  const used = new Uint8Array(segmentCount);
  const rings: number[][] = [];
  const ringEdges: number[] = [];
  for (let start = 0; start < segmentCount; start += 1) {
    if (used[start] === 1) continue;
    used[start] = 1;
    const startEdge = segmentEdgeA[start]!;
    ringEdges.length = 0;
    ringEdges.push(startEdge);
    let currentEdge = segmentEdgeB[start]!;
    let closed = false;
    while (true) {
      if (currentEdge === startEdge) {
        closed = true;
        break;
      }
      ringEdges.push(currentEdge);
      let nextSegment = 0;
      for (let candidate = edgeHead[currentEdge]!; candidate !== 0;) {
        if (used[candidate - 1] === 0) {
          nextSegment = candidate;
          break;
        }
        candidate = segmentEdgeA[candidate - 1] === currentEdge
          ? segmentNextA[candidate - 1]!
          : segmentNextB[candidate - 1]!;
      }
      if (nextSegment === 0) break;
      used[nextSegment - 1] = 1;
      currentEdge = segmentEdgeA[nextSegment - 1] === currentEdge
        ? segmentEdgeB[nextSegment - 1]!
        : segmentEdgeA[nextSegment - 1]!;
    }
    if (!closed || ringEdges.length < 3) continue;
    const ring: number[] = new Array<number>(ringEdges.length * 2);
    for (let index = 0; index < ringEdges.length; index += 1) {
      const edge = ringEdges[index]!;
      const node = edge >> 1;
      const x = node % width;
      if ((edge & 1) === 0) {
        const a = values[node]!;
        ring[index * 2] = x + clampEdgeParameter((iso - a) / (values[node + 1]! - a));
        ring[index * 2 + 1] = (node - x) / width;
      } else {
        const a = values[node]!;
        ring[index * 2] = x;
        ring[index * 2 + 1] = (node - x) / width
          + clampEdgeParameter((iso - a) / (values[node + width]! - a));
      }
    }
    rings.push(ring);
  }
  return rings;
}

/** Shoelace signed area of an interleaved X/Z ring (positive = CCW in XZ). */
export function ringSignedArea(ring: ArrayLike<number>): number {
  const count = Math.floor(ring.length / 2);
  let twiceArea = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    twiceArea += ring[index * 2]! * ring[next * 2 + 1]! - ring[next * 2]! * ring[index * 2 + 1]!;
  }
  return twiceArea * 0.5;
}

function perpendicularDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0) return Math.hypot(px - ax, pz - az);
  return Math.abs(dx * (pz - az) - dz * (px - ax)) / Math.sqrt(lengthSquared);
}

/**
 * Douglas-Peucker simplification of a CLOSED ring (interleaved X/Z, no
 * duplicated end vertex). The ring is anchored at vertex 0 and the vertex
 * farthest from it, so both anchors always survive and each open half is
 * simplified within `tolerance`.
 */
export function simplifyClosedRing(ring: readonly number[], tolerance: number): number[] {
  const count = Math.floor(ring.length / 2);
  if (count <= 4) return [...ring];
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("Ring simplification tolerance must be finite and non-negative");
  }
  let farthest = 1;
  let farthestDistance = -1;
  for (let index = 1; index < count; index += 1) {
    const dx = ring[index * 2]! - ring[0]!;
    const dz = ring[index * 2 + 1]! - ring[1]!;
    const distance = dx * dx + dz * dz;
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = index;
    }
  }
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[farthest] = 1;
  // W-1e: both open halves are runs of CONSECUTIVE ring indices (0..farthest,
  // then farthest..count-1 closing on 0), so the run is indexed arithmetically
  // instead of materialising an index array per half, and the split stack is a
  // flat Int32Array of (first, last) pairs. Each split pushes two entries and
  // pops one, so `count + 1` pairs bound the stack. Traversal order, the
  // `> tolerance` test and the `keep` set are all unchanged.
  const secondHalfLength = count - farthest + 1;
  const runValue = (half: number, offset: number): number => {
    if (half === 0) return offset;
    return offset === secondHalfLength - 1 ? 0 : farthest + offset;
  };
  const stack = new Int32Array((count + 2) * 2);
  for (let half = 0; half < 2; half += 1) {
    const runLength = half === 0 ? farthest + 1 : secondHalfLength;
    let top = 0;
    stack[top] = 0;
    stack[top + 1] = runLength - 1;
    top += 2;
    while (top > 0) {
      top -= 2;
      const first = stack[top]!;
      const last = stack[top + 1]!;
      if (last - first < 2) continue;
      const a = runValue(half, first);
      const b = runValue(half, last);
      const ax = ring[a * 2]!;
      const az = ring[a * 2 + 1]!;
      const bx = ring[b * 2]!;
      const bz = ring[b * 2 + 1]!;
      let worst = -1;
      let worstDistance = tolerance;
      for (let offset = first + 1; offset < last; offset += 1) {
        const index = runValue(half, offset);
        const distance = perpendicularDistance(
          ring[index * 2]!,
          ring[index * 2 + 1]!,
          ax,
          az,
          bx,
          bz,
        );
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = offset;
        }
      }
      if (worst < 0) continue;
      keep[runValue(half, worst)] = 1;
      stack[top] = first;
      stack[top + 1] = worst;
      stack[top + 2] = worst;
      stack[top + 3] = last;
      top += 4;
    }
  }
  const simplified: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (keep[index] === 1) simplified.push(ring[index * 2]!, ring[index * 2 + 1]!);
  }
  return simplified;
}

/**
 * The marching-squares → Douglas-Peucker shoreline of one macro lake
 * component, as an interleaved world-XZ ring oriented counter-clockwise
 * (positive shoelace). Returns null when the component supports no closed
 * contour. Coverage comes from the owned macro lake-field samplers over a
 * per-lake sub-grid restricted to this component, with a one-texel dry
 * margin so the contour always closes; only fine nodes inside mixed
 * (part-wet) macro cells are sampled — uniform cells are constant 0/1 by
 * bilinearity, which bounds the work by the component's perimeter.
 */
export function extractMacroLakeShoreline(input: MacroLakeShorelineInput): Float32Array | null {
  const { layout, component } = input;
  if (component.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const index of component) {
    const x = index % layout.width;
    const z = Math.floor(index / layout.width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const localMinX = minX - 1;
  const localMinZ = minZ - 1;
  const localWidth = maxX - minX + 3;
  const localHeight = maxZ - minZ + 3;
  const mask = new Uint8Array(localWidth * localHeight);
  for (const index of component) {
    const x = index % layout.width - localMinX;
    const z = Math.floor(index / layout.width) - localMinZ;
    mask[z * localWidth + x] = 1;
  }
  const outletX = input.outletIndex % layout.width - localMinX;
  const outletZ = Math.floor(input.outletIndex / layout.width) - localMinZ;
  const sampleOriginX = layout.originX + localMinX * layout.texelSizeMeters;
  const sampleOriginZ = layout.originZ + localMinZ * layout.texelSizeMeters;
  const field = buildTerrainMacroLakeFieldFromGrid({
    layout: {
      width: localWidth,
      height: localHeight,
      texelSizeMeters: layout.texelSizeMeters,
      sampleOriginX,
      sampleOriginZ,
    },
    lakeMask: mask,
    basins: [{
      basinId: input.lakeId,
      outletIndex: outletZ * localWidth + outletX,
      spillElevationMeters: input.spillElevationMeters,
    }],
  });

  let subdivisions = LAKE_SHORELINE_FINE_SUBDIVISIONS;
  const nodeCountFor = (s: number): number =>
    ((localWidth - 1) * s + 1) * ((localHeight - 1) * s + 1);
  while (subdivisions > 1 && nodeCountFor(subdivisions) > LAKE_SHORELINE_MAXIMUM_FINE_NODES) {
    subdivisions = Math.floor(subdivisions / 2);
  }
  const spacing = layout.texelSizeMeters / subdivisions;
  const fineWidth = (localWidth - 1) * subdivisions + 1;
  const fineHeight = (localHeight - 1) * subdivisions + 1;
  const values = new Float32Array(fineWidth * fineHeight);
  // W-1e: two passes over the local grid. The first counts the mixed (part-
  // wet) macro cells so the fine active-cell list is one exactly-sized
  // Int32Array instead of a push-grown number[]; the second fills the values
  // and the list. Corner coverage is memoized per local texel node, so each
  // node reaches the owned sampler once rather than once per incident mixed
  // cell (up to four times). Both are bit-preserving: the sampler is still
  // the single coverage law and returns the same double for the same node.
  let mixedCellCount = 0;
  for (let cellZ = 0; cellZ < localHeight - 1; cellZ += 1) {
    for (let cellX = 0; cellX < localWidth - 1; cellX += 1) {
      const row = cellZ * localWidth + cellX;
      const m00 = mask[row]!;
      // Uniform macro cells have constant bilinear coverage (0 or 1): no
      // contour touches them, so neither their values nor their fine cells
      // are needed — costs stay bounded by the component's perimeter, not
      // its area (the whole-grid form cost ~6 s of eroded startup on a
      // 13k-lake world).
      if (
        m00 === mask[row + 1]!
        && m00 === mask[row + localWidth]!
        && m00 === mask[row + localWidth + 1]!
      ) continue;
      mixedCellCount += 1;
    }
  }
  const activeCells = new Int32Array(mixedCellCount * subdivisions * subdivisions);
  let activeCellCount = 0;
  const cornerValue = new Float64Array(localWidth * localHeight);
  const cornerReady = new Uint8Array(localWidth * localHeight);
  const fineCellWidth = fineWidth - 1;
  for (let cellZ = 0; cellZ < localHeight - 1; cellZ += 1) {
    for (let cellX = 0; cellX < localWidth - 1; cellX += 1) {
      const row = cellZ * localWidth + cellX;
      const m00 = mask[row]!;
      if (
        m00 === mask[row + 1]!
        && m00 === mask[row + localWidth]!
        && m00 === mask[row + localWidth + 1]!
      ) continue;
      // Mixed cell: the owned sampler's documented contract is bilinear
      // coverage between texel centres, so its value at every interior fine
      // node is exactly the bilinear blend of its own values at the four
      // corner texel centres — reproduced below term-for-term in the
      // sampler's accumulation order. Fetching the corners through the
      // sampler (rather than evaluating it per fine node) keeps one
      // lake-coverage law without a per-node sampler call.
      let c00 = cornerValue[row]!;
      if (cornerReady[row] === 0) {
        c00 = sampleTerrainMacroLakeField(
          field,
          sampleOriginX + cellX * layout.texelSizeMeters,
          sampleOriginZ + cellZ * layout.texelSizeMeters,
        ).coverage;
        cornerValue[row] = c00;
        cornerReady[row] = 1;
      }
      let c10 = cornerValue[row + 1]!;
      if (cornerReady[row + 1] === 0) {
        c10 = sampleTerrainMacroLakeField(
          field,
          sampleOriginX + (cellX + 1) * layout.texelSizeMeters,
          sampleOriginZ + cellZ * layout.texelSizeMeters,
        ).coverage;
        cornerValue[row + 1] = c10;
        cornerReady[row + 1] = 1;
      }
      let c01 = cornerValue[row + localWidth]!;
      if (cornerReady[row + localWidth] === 0) {
        c01 = sampleTerrainMacroLakeField(
          field,
          sampleOriginX + cellX * layout.texelSizeMeters,
          sampleOriginZ + (cellZ + 1) * layout.texelSizeMeters,
        ).coverage;
        cornerValue[row + localWidth] = c01;
        cornerReady[row + localWidth] = 1;
      }
      let c11 = cornerValue[row + localWidth + 1]!;
      if (cornerReady[row + localWidth + 1] === 0) {
        c11 = sampleTerrainMacroLakeField(
          field,
          sampleOriginX + (cellX + 1) * layout.texelSizeMeters,
          sampleOriginZ + (cellZ + 1) * layout.texelSizeMeters,
        ).coverage;
        cornerValue[row + localWidth + 1] = c11;
        cornerReady[row + localWidth + 1] = 1;
      }
      const fineBaseX = cellX * subdivisions;
      const fineBaseZ = cellZ * subdivisions;
      for (let fz = fineBaseZ; fz <= fineBaseZ + subdivisions; fz += 1) {
        const v = (fz - fineBaseZ) / subdivisions;
        const rowBase = fz * fineWidth;
        for (let fx = fineBaseX; fx <= fineBaseX + subdivisions; fx += 1) {
          const u = (fx - fineBaseX) / subdivisions;
          values[rowBase + fx] = c00 * (1 - u) * (1 - v)
            + c10 * u * (1 - v)
            + c01 * (1 - u) * v
            + c11 * u * v;
        }
      }
      for (let fz = fineBaseZ; fz < fineBaseZ + subdivisions; fz += 1) {
        const rowBase = fz * fineCellWidth;
        for (let fx = fineBaseX; fx < fineBaseX + subdivisions; fx += 1) {
          activeCells[activeCellCount] = rowBase + fx;
          activeCellCount += 1;
        }
      }
    }
  }

  const rings = marchingSquaresIsoRings(fineWidth, fineHeight, values, CONTOUR_ISO, activeCells);
  if (rings.length === 0) return null;
  let shoreline = rings[0]!;
  let shorelineArea = Math.abs(ringSignedArea(shoreline));
  for (let index = 1; index < rings.length; index += 1) {
    const area = Math.abs(ringSignedArea(rings[index]!));
    // Interior (hole/island) rings are dropped: the polygon export contract
    // is a single ring. Recorded W-5 residual.
    if (area > shorelineArea) {
      shoreline = rings[index]!;
      shorelineArea = area;
    }
  }
  const world = new Array<number>(shoreline.length);
  for (let index = 0; index < shoreline.length; index += 2) {
    world[index] = sampleOriginX + shoreline[index]! * spacing;
    world[index + 1] = sampleOriginZ + shoreline[index + 1]! * spacing;
  }
  const simplified = simplifyClosedRing(
    world,
    LAKE_SHORELINE_SIMPLIFY_TOLERANCE_CELLS * spacing,
  );
  const ring = simplified.length >= 6 ? simplified : world;
  if (ring.length < 6) return null;
  const output = new Float32Array(ring.length);
  if (ringSignedArea(ring) < 0) {
    let write = 0;
    for (let index = ring.length - 2; index >= 0; index -= 2) {
      output[write] = ring[index]!;
      output[write + 1] = ring[index + 1]!;
      write += 2;
    }
    return output;
  }
  output.set(ring);
  return output;
}

/**
 * Robust ear-clip triangulation of one simple interleaved-XZ ring. Output
 * triangles index the ring and share its winding (a CCW ring yields
 * positive-cross triangles). Collinear vertices are removed without
 * emitting degenerate triangles; a non-simple input degrades to a
 * terminating fan rather than looping.
 */
export function earClipRing(ringXZ: ArrayLike<number>): number[] {
  const count = Math.floor(ringXZ.length / 2);
  if (count < 3) return [];
  let twiceArea = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    twiceArea += ringXZ[index * 2]! * ringXZ[next * 2 + 1]!
      - ringXZ[next * 2]! * ringXZ[index * 2 + 1]!;
  }
  const orientation = twiceArea >= 0 ? 1 : -1;
  const nextIndex = new Int32Array(count);
  const previousIndex = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    nextIndex[index] = (index + 1) % count;
    previousIndex[index] = (index + count - 1) % count;
  }
  const crossAt = (a: number, b: number, c: number): number =>
    (ringXZ[b * 2]! - ringXZ[a * 2]!) * (ringXZ[c * 2 + 1]! - ringXZ[a * 2 + 1]!)
    - (ringXZ[b * 2 + 1]! - ringXZ[a * 2 + 1]!) * (ringXZ[c * 2]! - ringXZ[a * 2]!);
  const epsilonAt = (a: number, b: number, c: number): number => {
    const scale = Math.max(
      1,
      Math.abs(ringXZ[a * 2]!), Math.abs(ringXZ[a * 2 + 1]!),
      Math.abs(ringXZ[b * 2]!), Math.abs(ringXZ[b * 2 + 1]!),
      Math.abs(ringXZ[c * 2]!), Math.abs(ringXZ[c * 2 + 1]!),
    );
    return 1e-9 * scale * scale;
  };
  const triangles: number[] = [];
  let remaining = count;
  let current = 0;
  let scannedWithoutClip = 0;
  while (remaining > 3) {
    const previous = previousIndex[current]!;
    const following = nextIndex[current]!;
    const cross = crossAt(previous, current, following) * orientation;
    const epsilon = epsilonAt(previous, current, following);
    let clipped = false;
    if (cross <= epsilon) {
      if (cross >= -epsilon) {
        // Collinear corner: remove without emitting a degenerate triangle.
        nextIndex[previous] = following;
        previousIndex[following] = previous;
        remaining -= 1;
        clipped = true;
      }
    } else {
      let blocked = false;
      let probe = nextIndex[following]!;
      // W-1e: the corner coordinates and the coincidence test are hoisted out
      // of the probe walk (they were a closure rebuilt on every probe step).
      const previousX = ringXZ[previous * 2]!;
      const previousZ = ringXZ[previous * 2 + 1]!;
      const currentX = ringXZ[current * 2]!;
      const currentZ = ringXZ[current * 2 + 1]!;
      const followingX = ringXZ[following * 2]!;
      const followingZ = ringXZ[following * 2 + 1]!;
      while (probe !== previous) {
        const px = ringXZ[probe * 2]!;
        const pz = ringXZ[probe * 2 + 1]!;
        if (
          !(px === previousX && pz === previousZ)
          && !(px === currentX && pz === currentZ)
          && !(px === followingX && pz === followingZ)
        ) {
          const inside = crossAt(previous, current, probe) * orientation >= -epsilon
            && crossAt(current, following, probe) * orientation >= -epsilon
            && crossAt(following, previous, probe) * orientation >= -epsilon;
          if (inside) {
            blocked = true;
            break;
          }
        }
        probe = nextIndex[probe]!;
      }
      if (!blocked) {
        triangles.push(previous, current, following);
        nextIndex[previous] = following;
        previousIndex[following] = previous;
        remaining -= 1;
        clipped = true;
      }
    }
    if (clipped) {
      current = following;
      scannedWithoutClip = 0;
      continue;
    }
    current = following;
    scannedWithoutClip += 1;
    if (scannedWithoutClip > remaining) {
      // No ear on a full scan: the input is not a simple polygon (e.g. a
      // pathological simplification artefact). Terminate with a fan so the
      // lake still renders; overdraw beats an unbounded loop.
      const fanFrom = current;
      let walker = nextIndex[fanFrom]!;
      while (nextIndex[walker]! !== fanFrom) {
        triangles.push(fanFrom, walker, nextIndex[walker]!);
        walker = nextIndex[walker]!;
      }
      return triangles;
    }
  }
  if (remaining === 3) {
    const second = nextIndex[current]!;
    const third = nextIndex[second]!;
    if (Math.abs(crossAt(current, second, third)) > 0) {
      triangles.push(current, second, third);
    }
  }
  return triangles;
}

/**
 * Midpoint (red/green style) refinement: every edge longer than its limit is
 * split at its midpoint simultaneously in all triangles that share it, so no
 * T-junction can form. The limit is either one number or a per-edge callback
 * of the two endpoint vertex indices — the lake builder grades it by
 * distance to the shoreline, so shore-adjacent triangles refine to the
 * attribute-gradient resolution while open-water triangles stay coarse
 * (triangle count scales with shoreline length, not lake area). Appends the
 * created vertices to `positionsXZ` and returns the refined triangle list
 * with the input winding preserved.
 */
export function refineTriangulation(
  positionsXZ: number[],
  triangles: readonly number[],
  edgeLimitMeters: number | ((aIndex: number, bIndex: number) => number),
  maximumPasses = 48,
): number[] {
  const limitFor = typeof edgeLimitMeters === "number"
    ? () => edgeLimitMeters
    : edgeLimitMeters;
  if (typeof edgeLimitMeters === "number"
    && (!Number.isFinite(edgeLimitMeters) || edgeLimitMeters <= 0)) {
    throw new RangeError("Refinement maximum edge must be finite and positive");
  }
  let current = [...triangles];
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const midpoints = new Map<number, number>();
    const edgeKey = (a: number, b: number): number =>
      a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
    const lengthSquared = (a: number, b: number): number => {
      const dx = positionsXZ[a * 2]! - positionsXZ[b * 2]!;
      const dz = positionsXZ[a * 2 + 1]! - positionsXZ[b * 2 + 1]!;
      return dx * dx + dz * dz;
    };
    for (let index = 0; index < current.length; index += 3) {
      // Longest-edge bisection, area-gated: mark only each triangle's longest
      // over-limit edge, and only while the triangle's area still exceeds the
      // area of a limit-sized triangle. Marking every long edge quadruples
      // skinny ear-clip slivers into 4^passes fragments keyed to the longest
      // edge regardless of area; an area-resolved sliver stops initiating
      // splits (its attributes are already sampled at target density) but
      // still honours midpoints its neighbours place on shared edges, so no
      // T-junction forms.
      const i0 = current[index]!;
      const i1 = current[index + 1]!;
      const i2 = current[index + 2]!;
      let longestA = -1;
      let longestB = -1;
      let longestExcess = 0;
      let longestLimit = 0;
      // W-1e: unrolled. The `for (const [a, b] of [[i0,i1],[i1,i2],[i2,i0]])`
      // form allocated four arrays per triangle, which at ~500k lake triangles
      // per pass dominated the refinement. Same edges, same order, same tests.
      const limit01 = Math.max(limitFor(i0, i1), 1e-6);
      const excess01 = lengthSquared(i0, i1) / (limit01 * limit01);
      if (excess01 > 1 && excess01 > longestExcess) {
        longestExcess = excess01;
        longestA = i0;
        longestB = i1;
        longestLimit = limit01;
      }
      const limit12 = Math.max(limitFor(i1, i2), 1e-6);
      const excess12 = lengthSquared(i1, i2) / (limit12 * limit12);
      if (excess12 > 1 && excess12 > longestExcess) {
        longestExcess = excess12;
        longestA = i1;
        longestB = i2;
        longestLimit = limit12;
      }
      const limit20 = Math.max(limitFor(i2, i0), 1e-6);
      const excess20 = lengthSquared(i2, i0) / (limit20 * limit20);
      if (excess20 > 1 && excess20 > longestExcess) {
        longestExcess = excess20;
        longestA = i2;
        longestB = i0;
        longestLimit = limit20;
      }
      if (longestA < 0) continue;
      const doubleArea = Math.abs(
        (positionsXZ[i1 * 2]! - positionsXZ[i0 * 2]!)
          * (positionsXZ[i2 * 2 + 1]! - positionsXZ[i0 * 2 + 1]!)
        - (positionsXZ[i1 * 2 + 1]! - positionsXZ[i0 * 2 + 1]!)
          * (positionsXZ[i2 * 2]! - positionsXZ[i0 * 2]!),
      );
      // sqrt(3)/4 x limit² x 2 — a limit-edged equilateral triangle's area.
      if (doubleArea <= 0.866 * longestLimit * longestLimit) continue;
      const key = edgeKey(longestA, longestB);
      if (midpoints.has(key)) continue;
      const midpoint = positionsXZ.length / 2;
      positionsXZ.push(
        (positionsXZ[longestA * 2]! + positionsXZ[longestB * 2]!) * 0.5,
        (positionsXZ[longestA * 2 + 1]! + positionsXZ[longestB * 2 + 1]!) * 0.5,
      );
      midpoints.set(key, midpoint);
    }
    if (midpoints.size === 0) break;
    const refined: number[] = [];
    for (let index = 0; index < current.length; index += 3) {
      const a = current[index]!;
      const b = current[index + 1]!;
      const c = current[index + 2]!;
      const ab = midpoints.get(edgeKey(a, b));
      const bc = midpoints.get(edgeKey(b, c));
      const ca = midpoints.get(edgeKey(c, a));
      if (ab !== undefined && bc !== undefined && ca !== undefined) {
        refined.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      } else if (ab !== undefined && bc !== undefined) {
        refined.push(ab, b, bc, a, ab, bc, a, bc, c);
      } else if (ab !== undefined && ca !== undefined) {
        refined.push(a, ab, ca, ab, b, c, ab, c, ca);
      } else if (bc !== undefined && ca !== undefined) {
        refined.push(ca, bc, c, a, b, bc, a, bc, ca);
      } else if (ab !== undefined) {
        refined.push(a, ab, c, ab, b, c);
      } else if (bc !== undefined) {
        refined.push(a, b, bc, a, bc, c);
      } else if (ca !== undefined) {
        refined.push(a, b, ca, ca, b, c);
      } else {
        refined.push(a, b, c);
      }
    }
    current = refined;
  }
  return current;
}

/**
 * How far a segment's squared distance may exceed the running best and still
 * be evaluated with `Math.hypot`. `Math.hypot` and the squared distance both
 * approximate the same true value to within a few ulp (~1e-16 relative), so a
 * segment more than 1e-12 relatively farther in the squared metric cannot hold
 * the minimum in the hypot metric — three orders of magnitude of slack over
 * the worst rounding either can carry. See `distanceToRingMeters`.
 */
const RING_DISTANCE_HYPOT_MARGIN = 1 + 1e-12;

/**
 * Minimum distance from a point to a closed interleaved-XZ ring polyline.
 *
 * `W-1e`: `Math.hypot` is the single most expensive call on the lake mesh
 * path (one per ring segment per interior vertex), so it is evaluated only
 * for segments that can still hold the minimum — everything else is rejected
 * on the squared distance, which needs no square root. The returned value is
 * unchanged: the argmin segment's squared distance is by definition the
 * smallest seen, so it always passes the guard and always reaches
 * `Math.hypot`; the guard's NaN behaviour is deliberately the original's
 * (a NaN distance still propagates through `Math.min`).
 */
export function distanceToRingMeters(x: number, z: number, ringXZ: ArrayLike<number>): number {
  const count = Math.floor(ringXZ.length / 2);
  if (count === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  let bestSquared = Number.POSITIVE_INFINITY;
  let ax = ringXZ[0]!;
  let az = ringXZ[1]!;
  for (let index = 0; index < count; index += 1) {
    const next = index + 1 === count ? 0 : index + 1;
    const bx = ringXZ[next * 2]!;
    const bz = ringXZ[next * 2 + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0
      ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / lengthSquared))
      : 0;
    const ex = x - (ax + dx * t);
    const ez = z - (az + dz * t);
    const squared = ex * ex + ez * ez;
    if (!(squared > bestSquared * RING_DISTANCE_HYPOT_MARGIN)) {
      best = Math.min(best, Math.hypot(ex, ez));
    }
    if (squared < bestSquared) bestSquared = squared;
    ax = bx;
    az = bz;
  }
  return best;
}
