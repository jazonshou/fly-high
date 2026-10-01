/**
 * Inland water geometry as plain arrays: the river ribbons and contained lake
 * surfaces a hydrology region draws, built WITHOUT Babylon.
 *
 * Moved out of HydrologySystem.ts (P2b, 2026-09-29) so the hydrology worker
 * can build a region's vertex arrays beside its generation and transfer them,
 * instead of the main thread clipping every lake against the analytic ground
 * when the region arrives (290 ms per 747 region at Chrome's 4x throttle).
 * The functions are unchanged; HydrologySystem re-exports its old public
 * names from here.
 *
 * Class P: no Babylon, no DOM.
 */

import {
  type HydrologyLake,
  type HydrologyRiver,
} from "./HydrologyGeneration";
import {
  resolveLakeConstituents,
  resolveRiverConstituents,
  type WaterConstituents,
} from "./WaterConstituents";
import {
  distanceToRingMeters,
  earClipRing,
  refineTriangulation,
} from "./lakeShoreline";
import { resampleHydrologyRiverStations } from "./riverResample";
import {
  waterChannelGradePayload,
  waterLakeEffectiveFetchMeters,
  waterLakeFetchPayload,
} from "./waterVertexPayload";

/**
 * The interleaved CPU attribute arrays a water mesh is uploaded from. Exported
 * only so `W-1e`'s committed benchmark and the graph byte pin can build the
 * exact production arrays without a Babylon device; nothing outside those
 * harnesses may construct meshes from it.
 */
/**
 * `W-8` — the climate at an inland water surface, which is what decides its
 * chemistry. Supplied by the renderer (which owns the world definition) so the
 * hydrology system does not have to re-derive a seed hash that the airport
 * catalogue may have replaced.
 *
 * It is a PURE FUNCTION OF WORLD POSITION: two pages that share a river derive
 * the same numbers for the same station, which is what makes the chemistry
 * seam-free without any cross-page state.
 */
export interface HydrologyClimateSample {
  /** Terrain temperature field, 0..1 (one unit is 15.9 K). */
  readonly temperature: number;
  /** Terrain moisture field, 0..1. */
  readonly moisture: number;
}

export type HydrologyClimateSampler = (
  worldX: number,
  worldZ: number,
  elevationMeters: number,
) => HydrologyClimateSample;

/**
 * The neutral climate a system built without a sampler uses: the temperate,
 * moderately wet middle of this world model, which is what every test fixture
 * and every analytic harness sees.
 */
export const HYDROLOGY_NEUTRAL_CLIMATE: HydrologyClimateSample = Object.freeze({
  temperature: 0.6,
  moisture: 0.5,
});

export interface HydrologyMeshArrays {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly indices: number[];
  readonly flowData: number[];
  readonly waterData: number[];
  /** `W-8`: (chlorophyll, cdom440, sediment, mineral) for this vertex. */
  readonly waterChemistry: number[];
}

type MeshArrays = HydrologyMeshArrays;

export function emptyMeshArrays(): MeshArrays {
  return {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    flowData: [],
    waterData: [],
    waterChemistry: [],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedDirection(dx: number, dz: number): readonly [number, number] {
  const length = Math.hypot(dx, dz);
  return length > 1e-6 ? [dx / length, dz / length] : [0, 1];
}

/** Push one station's chemistry once per lane. */
function pushChemistry(arrays: MeshArrays, chemistry: WaterConstituents, lanes: number): void {
  for (let lane = 0; lane < lanes; lane += 1) {
    arrays.waterChemistry.push(
      chemistry.chlorophyll,
      chemistry.cdom440,
      chemistry.sediment,
      chemistry.mineral,
    );
  }
}

/**
 * `W-8`: a river station's chemistry, and the ONE place the mouth taper lives.
 * A reach that reaches the sea hands its load over to the coastal water the
 * ocean shader is already making there, so the waterline is a gradient rather
 * than a step (the ocean's own surf-zone sediment meets it from the other
 * side).
 */
function riverStationChemistry(
  climate: HydrologyClimateSampler,
  seaLevel: number,
  x: number,
  y: number,
  z: number,
  widthMeters: number,
  flowSpeedMetersPerSecond: number,
  grade: number,
): WaterConstituents {
  const elevationAboveSeaMeters = Math.max(y - seaLevel, 0);
  const sample = climate(x, z, y);
  const constituents = resolveRiverConstituents(
    {
      elevationAboveSeaMeters,
      temperature: sample.temperature,
      moisture: sample.moisture,
    },
    widthMeters,
    flowSpeedMetersPerSecond,
    grade,
  );
  // Over the last 12 m of fall the load settles out toward what the sea it is
  // entering carries anyway.
  const mouth = Math.min(Math.max(elevationAboveSeaMeters / 12, 0), 1);
  const taper = mouth * mouth * (3 - 2 * mouth);
  return {
    chlorophyll: constituents.chlorophyll,
    cdom440: constituents.cdom440 * (0.35 + 0.65 * taper),
    sediment: constituents.sediment * (0.3 + 0.7 * taper),
    mineral: constituents.mineral * taper,
  };
}

export function appendRiver(
  arrays: MeshArrays,
  river: HydrologyRiver,
  climate: HydrologyClimateSampler,
  seaLevel: number,
): void {
  if (river.points.length < 2) return;
  const baseVertex = arrays.positions.length / 3;
  let distanceAlong = 0;
  for (let index = 0; index < river.points.length; index += 1) {
    const point = river.points[index];
    const previous = river.points[Math.max(0, index - 1)];
    const next = river.points[Math.min(river.points.length - 1, index + 1)];
    if (!point || !previous || !next) continue;
    if (index > 0) distanceAlong += Math.hypot(point.x - previous.x, point.z - previous.z);
    const flow = normalizedDirection(next.x - previous.x, next.z - previous.z);
    const rightX = flow[1];
    const rightZ = -flow[0];
    const halfWidth = point.widthMeters * 0.5;
    const localDrop = Math.max(previous.y - next.y, 0);
    const localDistance = Math.max(Math.hypot(next.x - previous.x, next.z - previous.z), 1);
    const grade = localDrop / localDistance;
    const whitewater = clamp(
      (point.flowSpeedMetersPerSecond - 1.5) * 0.24 + grade * 14,
      0,
      1,
    );
    // `5-12`: five lanes give the conservative cover enough transverse
    // resolution for bathymetry-driven per-pixel shoreline trim. Hydraulic
    // depth is exported by the graph and sampled from the bed; this mesh no
    // longer invents it from ribbon width.
    for (const lane of [-1, -0.5, 0, 0.5, 1] as const) {
      const shore = Math.abs(lane);
      arrays.positions.push(
        point.x + rightX * halfWidth * lane,
        point.y,
        point.z + rightZ * halfWidth * lane,
      );
      arrays.normals.push(0, 1, 0);
      arrays.uvs.push(distanceAlong / 16, lane * 0.5 + 0.5);
      arrays.flowData.push(flow[0], flow[1], point.flowSpeedMetersPerSecond, whitewater);
      arrays.waterData.push(0, 0, shore, 0);
    }
    pushChemistry(arrays, riverStationChemistry(
      climate,
      seaLevel,
      point.x,
      point.y,
      point.z,
      point.widthMeters,
      point.flowSpeedMetersPerSecond,
      grade,
    ), 5);
  }
  for (let index = 0; index < river.points.length - 1; index += 1) {
    const row = baseVertex + index * 5;
    const nextRow = row + 5;
    for (let lane = 0; lane < 4; lane += 1) {
      const a = row + lane;
      const b = nextRow + lane;
      const c = a + 1;
      const d = b + 1;
      arrays.indices.push(a, b, c, c, b, d);
    }
  }
}

/**
 * The waterline-contained analytic lake plate — the fix for the in-flight
 * "blue blotches over the green terrain… hard geometric shapes that go
 * through the terrain" report (Jason, 2026-09-02), which
 * scripts/hydrology-piercing-probe.mts measured (all five generated lakes
 * pierced by ground, 1.1% of lake area, worst 10.1 m — two instruments
 * converged on (20520, −14630) ±2 m; a coarse first grid read 8.34 m)
 * and the lake-island-piercing capture sited against.
 *
 * The legacy builder was a 32-segment fan from the basin centre at
 * `surfaceHeight`: nothing sampled the interior, so any ground above the
 * surface inside the polygon drew water straight over it — the analytic
 * twin of the recorded W-5 dropped-island residual (lakeShoreline.ts
 * computes island rings and its export contract drops them). Here the
 * plate is the CELL FILL of the submergence field s = surfaceHeight −
 * ground on a per-lake fine grid clipped to the ownership polygon:
 * fully-wet cells emit quads, mixed cells clip at the interpolated zero
 * crossing (saddle cells disambiguate on the centre average,
 * `marchingSquaresIsoRings`' rule), dry cells emit nothing. Islands are
 * holes BY CONSTRUCTION and every mesh edge is a waterline.
 *
 * Attribute semantics reproduce the fan's FIELDS rather than its
 * geometry: uv is the radial map the fan interpolated (0.5 + dir·0.5·r/R),
 * flowData is the legacy constant lane, and waterData carries
 * [max(0.08, s), 1, 1 − clamp(s / maxDepth, 0, 1), 0] — per-vertex REAL
 * depth instead of the centre-only maximum, the same shore gradient the
 * fan produced for a bowl, and the analytic `waterData.w = 0` sentinel
 * unchanged.
 *
 * The grid step scales with radius (≤ ~57×57 nodes, floor 4 m), capping
 * the one-time ground sampling at ~3.3k calls per lake — sub-frame work
 * at region page-in, and no lake generates within ~11 km of any
 * baselined capture vantage.
 */
const LAKE_CONTAINMENT_MAX_NODES_PER_AXIS = 57;
const LAKE_CONTAINMENT_STEP_FLOOR_METERS = 4;
const LAKE_CONTAINMENT_CROSSING_CLAMP = 1e-3;

/**
 * `W-8`: a lake's chemistry, resolved once at its centre. One lake is one
 * water body — a tarn does not change colour across itself — so this is a
 * per-lake constant, which also means a lake split across a page boundary
 * derives the same value on both sides.
 */
function lakeChemistry(
  climate: HydrologyClimateSampler,
  seaLevel: number,
  lake: HydrologyLake,
): WaterConstituents {
  const sample = climate(lake.centerX, lake.centerZ, lake.surfaceHeight);
  return resolveLakeConstituents(
    {
      elevationAboveSeaMeters: Math.max(lake.surfaceHeight - seaLevel, 0),
      temperature: sample.temperature,
      moisture: sample.moisture,
    },
    lake.maximumDepthMeters,
    lake.areaSquareMeters,
  );
}

export function appendContainedLake(
  arrays: MeshArrays,
  lake: HydrologyLake,
  ground: (x: number, z: number) => number,
  climate: HydrologyClimateSampler = () => HYDROLOGY_NEUTRAL_CLIMATE,
  seaLevel = 0,
): void {
  if (lake.boundary.length < 3) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of lake.boundary) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0)) return;
  const step = Math.max(
    LAKE_CONTAINMENT_STEP_FLOOR_METERS,
    span / (LAKE_CONTAINMENT_MAX_NODES_PER_AXIS - 1),
  );
  // One dry padding node on every side so the fill can never reach the
  // grid rim (the same closed-contour guarantee marchingSquaresIsoRings
  // asks of its callers).
  const width = Math.ceil((maxX - minX) / step) + 3;
  const height = Math.ceil((maxZ - minZ) / step) + 3;
  const originX = minX - step;
  const originZ = minZ - step;
  const inside = (px: number, pz: number): boolean => {
    let odd = false;
    const ring = lake.boundary;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if ((a.z > pz) !== (b.z > pz)
        && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) odd = !odd;
    }
    return odd;
  };
  // Submergence at each node; forced dry outside the ownership polygon so
  // this lake cannot flood terrain another basin owns.
  const submergence = new Float32Array(width * height);
  for (let iz = 0; iz < height; iz += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      const x = originX + ix * step;
      const z = originZ + iz * step;
      submergence[iz * width + ix] = (ix === 0 || iz === 0 || ix === width - 1
        || iz === height - 1 || !inside(x, z))
        ? -1
        : lake.surfaceHeight - ground(x, z);
    }
  }
  const chemistry = lakeChemistry(climate, seaLevel, lake);
  const vertexIndex = new Map<number, number>();
  const invRadius = 1 / Math.max(lake.radiusMeters, 1e-6);
  const invMaxDepth = 1 / Math.max(lake.maximumDepthMeters, 1e-6);
  const emitVertex = (key: number, x: number, z: number, depth: number): number => {
    const existing = vertexIndex.get(key);
    if (existing !== undefined) return existing;
    const index = arrays.positions.length / 3;
    const dx = x - lake.centerX;
    const dz = z - lake.centerZ;
    const radial = Math.hypot(dx, dz);
    const scale = radial > 1e-6 ? Math.min(1, radial * invRadius) / radial : 0;
    arrays.positions.push(x, lake.surfaceHeight, z);
    arrays.normals.push(0, 1, 0);
    arrays.uvs.push(0.5 + dx * scale * 0.5, 0.5 + dz * scale * 0.5);
    arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
    arrays.waterData.push(
      Math.max(0.08, depth),
      1,
      1 - clamp(depth * invMaxDepth, 0, 1),
      0,
    );
    pushChemistry(arrays, chemistry, 1);
    vertexIndex.set(key, index);
    return index;
  };
  // Vertex keys are quantized world offsets (1/16 m lattice), so a corner
  // shared between any mix of base cells and subdivided cells — and a
  // crossing reached from either direction — resolves to one vertex.
  // Adjacent cells at different subdivision levels leave T-junctions, but
  // every vertex sits at the one surface height, so the mesh is coplanar
  // and a T-junction cannot open a visible gap.
  const vertexKey = (x: number, z: number): number =>
    Math.round((x - originX) * 16) * 2_097_152 + Math.round((z - originZ) * 16);
  // Cached point sampler for sub-grid corners (base nodes pre-fill it).
  const sampleCache = new Map<number, number>();
  const sampleSubmergence = (x: number, z: number): number => {
    const key = vertexKey(x, z);
    const cached = sampleCache.get(key);
    if (cached !== undefined) return cached;
    const value = inside(x, z) ? lake.surfaceHeight - ground(x, z) : -1;
    sampleCache.set(key, value);
    return value;
  };
  for (let iz = 0; iz < height; iz += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      sampleCache.set(
        vertexKey(originX + ix * step, originZ + iz * step),
        submergence[iz * width + ix]!,
      );
    }
  }
  const cornerVertex = (x: number, z: number, s: number): number =>
    emitVertex(vertexKey(x, z), x, z, s);
  const crossingVertex = (
    xA: number, zA: number, sA: number, xB: number, zB: number, sB: number,
  ): number => {
    // Canonicalize on the lower-keyed endpoint so both walk directions
    // resolve the same edge to one vertex.
    if (vertexKey(xB, zB) < vertexKey(xA, zA)) {
      [xA, xB] = [xB, xA];
      [zA, zB] = [zB, zA];
      [sA, sB] = [sB, sA];
    }
    const denominator = sA - sB;
    const t = clamp(
      Math.abs(denominator) > 1e-9 ? sA / denominator : 0.5,
      LAKE_CONTAINMENT_CROSSING_CLAMP,
      1 - LAKE_CONTAINMENT_CROSSING_CLAMP,
    );
    const x = xA + (xB - xA) * t;
    const z = zA + (zB - zA) * t;
    return emitVertex(vertexKey(x, z), x, z, 0);
  };
  const fanOut = (polygon: readonly number[]): void => {
    for (let i = 1; i + 1 < polygon.length; i += 1) {
      arrays.indices.push(polygon[0]!, polygon[i + 1]!, polygon[i]!);
    }
  };
  // A cell subdivides while it straddles the waterline or spans steep
  // ground, down to ~1 m cells: the leaf size bounds how much sub-cell
  // terrain can stand above drawn water (the legacy fan's unbounded
  // version of that error measured 10.1 m, converged).
  const LEAF_STEP_METERS = 1.25;
  const SUBDIVIDE_SPREAD_METERS = 0.75;
  const processCell = (
    x0: number, z0: number, cellStep: number,
    s00: number, s10: number, s11: number, s01: number,
  ): void => {
    const wet = [s00 >= 0, s10 >= 0, s11 >= 0, s01 >= 0] as const;
    const wetCount = Number(wet[0]) + Number(wet[1]) + Number(wet[2]) + Number(wet[3]);
    const minS = Math.min(s00, s10, s11, s01);
    const maxS = Math.max(s00, s10, s11, s01);
    if (wetCount === 0 && maxS < -SUBDIVIDE_SPREAD_METERS) return;
    // Refine only where the waterline can pass through the cell: corner
    // submergence within one spread band of zero. Deep interior stays at
    // the base step — its residual is zero by definition, water over water.
    if (cellStep > LEAF_STEP_METERS
      && minS < SUBDIVIDE_SPREAD_METERS
      && maxS > -SUBDIVIDE_SPREAD_METERS) {
      const half = cellStep / 2;
      const xm = x0 + half;
      const zm = z0 + half;
      const x1 = x0 + cellStep;
      const z1 = z0 + cellStep;
      const sTop = sampleSubmergence(xm, z0);
      const sLeft = sampleSubmergence(x0, zm);
      const sRight = sampleSubmergence(x1, zm);
      const sBottom = sampleSubmergence(xm, z1);
      const sCentre = sampleSubmergence(xm, zm);
      processCell(x0, z0, half, s00, sTop, sCentre, sLeft);
      processCell(xm, z0, half, sTop, s10, sRight, sCentre);
      processCell(xm, zm, half, sCentre, sRight, s11, sBottom);
      processCell(x0, zm, half, sLeft, sCentre, sBottom, s01);
      return;
    }
    if (wetCount === 0) return;
    const x1 = x0 + cellStep;
    const z1 = z0 + cellStep;
    // Corners in edge-walk order.
    const cx = [x0, x1, x1, x0] as const;
    const cz = [z0, z0, z1, z1] as const;
    const cs = [s00, s10, s11, s01] as const;
    if (wetCount === 4) {
      fanOut([
        cornerVertex(cx[0], cz[0], cs[0]),
        cornerVertex(cx[1], cz[1], cs[1]),
        cornerVertex(cx[2], cz[2], cs[2]),
        cornerVertex(cx[3], cz[3], cs[3]),
      ]);
      return;
    }
    // Saddle with a dry centre splits into two opposite corner triangles;
    // every other mixed cell is one simple polygon walked in edge order.
    const saddle = wetCount === 2 && wet[0] === wet[2] && wet[1] === wet[3];
    if (saddle && (s00 + s10 + s11 + s01) * 0.25 < 0) {
      for (let c = 0; c < 4; c += 1) {
        if (!wet[c]) continue;
        const p = (c + 3) % 4;
        const n = (c + 1) % 4;
        fanOut([
          crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[p]!, cz[p]!, cs[p]!),
          cornerVertex(cx[c]!, cz[c]!, cs[c]!),
          crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[n]!, cz[n]!, cs[n]!),
        ]);
      }
      return;
    }
    const polygon: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      const n = (c + 1) % 4;
      if (wet[c]) polygon.push(cornerVertex(cx[c]!, cz[c]!, cs[c]!));
      if (wet[c] !== wet[n]) {
        polygon.push(crossingVertex(cx[c]!, cz[c]!, cs[c]!, cx[n]!, cz[n]!, cs[n]!));
      }
    }
    if (polygon.length >= 3) fanOut(polygon);
  };
  for (let iz = 0; iz + 1 < height; iz += 1) {
    for (let ix = 0; ix + 1 < width; ix += 1) {
      processCell(
        originX + ix * step,
        originZ + iz * step,
        step,
        submergence[iz * width + ix]!,
        submergence[iz * width + ix + 1]!,
        submergence[(iz + 1) * width + ix + 1]!,
        submergence[(iz + 1) * width + ix]!,
      );
    }
  }
}

/**
 * W-5 (C-5) — graph-mode river lanes on arc-length stations.
 *
 * Replaces the raw 512 m "ribbons": stations subdivide the exported reach
 * at a width-scaled spacing (see riverResample.ts), Frenet tangents come
 * from central differences over the stations, and whitewater grade is
 * recomputed from the stations. Lane layout, uv and flowData/waterData
 * semantics are the 5-12 contract unchanged: five lanes at
 * [-1,-0.5,0,0.5,1] x halfWidth, uv.x = arcLength / 16 (a world-anchored
 * arc-length parameter — 6-1's advection keys phase off it), uv.y the lane
 * coordinate, waterData.z = |lane| shore proximity. Analytic worlds keep
 * `appendRiver` byte-identical (Gate W non-regression).
 */
export function appendGraphRiver(
  arrays: MeshArrays,
  river: HydrologyRiver,
  climate: HydrologyClimateSampler,
  seaLevel: number,
): void {
  const stations = resampleHydrologyRiverStations(river.points);
  if (stations.length < 2) return;
  const baseVertex = arrays.positions.length / 3;
  for (const station of stations) {
    const rightX = station.tangentZ;
    const rightZ = -station.tangentX;
    const halfWidth = station.widthMeters * 0.5;
    // 6-1: the channel sentinel + grade payload. Analytic `appendRiver` keeps
    // pushing a literal 0 here, which is what makes the whole advection term
    // dark in analytic worlds.
    const channelPayload = waterChannelGradePayload(station.grade);
    for (const lane of [-1, -0.5, 0, 0.5, 1] as const) {
      const shore = Math.abs(lane);
      arrays.positions.push(
        station.x + rightX * halfWidth * lane,
        station.y,
        station.z + rightZ * halfWidth * lane,
      );
      arrays.normals.push(0, 1, 0);
      arrays.uvs.push(station.arcLengthMeters / 16, lane * 0.5 + 0.5);
      arrays.flowData.push(
        station.tangentX,
        station.tangentZ,
        station.flowSpeedMetersPerSecond,
        station.whitewater,
      );
      arrays.waterData.push(0, 0, shore, channelPayload);
    }
    pushChemistry(arrays, riverStationChemistry(
      climate,
      seaLevel,
      station.x,
      station.y,
      station.z,
      station.widthMeters,
      station.flowSpeedMetersPerSecond,
      station.grade,
    ), 5);
  }
  for (let index = 0; index < stations.length - 1; index += 1) {
    const row = baseVertex + index * 5;
    const nextRow = row + 5;
    for (let lane = 0; lane < 4; lane += 1) {
      const a = row + lane;
      const b = nextRow + lane;
      const c = a + 1;
      const d = b + 1;
      arrays.indices.push(a, b, c, c, b, d);
    }
  }
}

/** Shore proximity decays to zero this far inside a lake (capped by radius). */
const GRAPH_LAKE_SHORE_BAND_MAXIMUM_METERS = 250;
/**
 * Interior refinement never splits below this edge length. With the 250 m
 * shore band this renders the foam gradient over the last ~24% of a
 * floor-length edge (~120 m) — deliberately of the same order as the ocean's
 * wide shore band; per-pixel shoreline detail is the bathymetry's job
 * (5-12), not this attribute lattice's.
 */
const GRAPH_LAKE_INTERIOR_EDGE_FLOOR_METERS = 512;
/**
 * Interior edges may grow with distance to the shoreline: an edge is split
 * while longer than max(floor, grading x min(endpoint shore distances)) and
 * its triangle is above target area. Shore-adjacent triangles refine to the
 * floor (the waterData gradient resolution); open-water triangles coarsen
 * geometrically, so a lake's triangle count scales with its shoreline
 * length rather than its area. Sizing evidence (seed 333438, ~34,000 km² of
 * retained lakes): a flat 250 m limit produced 8.4M triangles; this graded
 * scheme lands at ~540k for the same worlds.
 */
const GRAPH_LAKE_INTERIOR_EDGE_GRADING = 1;

/**
 * W-5 (C-5) — graph-mode lake interiors.
 *
 * Replaces the centre fan: the marching-squares/Douglas-Peucker shoreline
 * ring is ear-clipped (correct coverage of concave shorelines) and midpoint-
 * refined so interior vertices exist to carry the waterData shore-proximity
 * gradient (boundary z = 1, interior toward 0 over the shore band) that the
 * fan expressed with its single centre vertex. Every vertex sits exactly at
 * `surfaceHeight` — the adapter copies `spillElevationMeters` into it, and
 * the planar-reflection matcher pairs plane heights within 0.05 m, so no
 * averaging is permitted anywhere on this path. Fragment shading still
 * re-derives wave gradients per fragment (fix-pack W3); these vertices are
 * for attribute interpolation and displacement, not normals.
 */
export function appendGraphLake(
  arrays: MeshArrays,
  lake: HydrologyLake,
  climate: HydrologyClimateSampler,
  seaLevel: number,
): void {
  const chemistry = lakeChemistry(climate, seaLevel, lake);
  const ringCount = lake.boundary.length;
  if (ringCount < 3) return;
  const ringXZ = new Array<number>(ringCount * 2);
  for (let index = 0; index < ringCount; index += 1) {
    const point = lake.boundary[index]!;
    ringXZ[index * 2] = point.x;
    ringXZ[index * 2 + 1] = point.z;
  }
  const earTriangles = earClipRing(ringXZ);
  if (earTriangles.length === 0) return;
  const shoreBand = clamp(lake.radiusMeters, 1, GRAPH_LAKE_SHORE_BAND_MAXIMUM_METERS);
  const positionsXZ = [...ringXZ];
  // W-1e: the shore-distance memo is a typed pair rather than a sparse
  // `number[]` whose entries were written out of order past its initial
  // length (which drops a JS array into dictionary mode). Ring vertices keep
  // their pinned 0; interior vertices are still computed exactly once.
  let shoreDistances = new Float64Array(Math.max(ringCount * 2, 16));
  let shoreReady = new Uint8Array(shoreDistances.length);
  shoreReady.fill(1, 0, ringCount);
  const shoreDistanceAt = (index: number): number => {
    if (index >= shoreReady.length) {
      let capacity = shoreReady.length;
      while (capacity <= index) capacity *= 2;
      const grownDistances = new Float64Array(capacity);
      grownDistances.set(shoreDistances);
      shoreDistances = grownDistances;
      const grownReady = new Uint8Array(capacity);
      grownReady.set(shoreReady);
      shoreReady = grownReady;
    }
    if (shoreReady[index] === 1) return shoreDistances[index]!;
    const distance = distanceToRingMeters(
      positionsXZ[index * 2]!,
      positionsXZ[index * 2 + 1]!,
      ringXZ,
    );
    shoreDistances[index] = distance;
    shoreReady[index] = 1;
    return distance;
  };
  const triangles = refineTriangulation(
    positionsXZ,
    earTriangles,
    (a, b) => Math.max(
      GRAPH_LAKE_INTERIOR_EDGE_FLOOR_METERS,
      GRAPH_LAKE_INTERIOR_EDGE_GRADING * Math.min(shoreDistanceAt(a), shoreDistanceAt(b)),
    ),
  );
  const baseVertex = arrays.positions.length / 3;
  const vertexCount = positionsXZ.length / 2;
  const maximumDepth = Math.max(lake.maximumDepthMeters, 0.08);
  // 6-1: the lake's own span is the fetch ceiling. `radiusMeters` is the
  // exported max centre-to-ring distance, so 2x it is the long chord; the
  // per-vertex nearest-shore distance (already memoised for the shore
  // gradient, so this costs no new ring walk) shortens it near a bank.
  const lakeSpanMeters = lake.radiusMeters * 2;
  for (let index = 0; index < vertexCount; index += 1) {
    const x = positionsXZ[index * 2]!;
    const z = positionsXZ[index * 2 + 1]!;
    const shoreDistance = index < ringCount ? 0 : shoreDistanceAt(index);
    const shore = index < ringCount
      ? 1
      : clamp(1 - shoreDistance / shoreBand, 0, 1);
    const channelPayload = waterLakeFetchPayload(
      waterLakeEffectiveFetchMeters(shoreDistance, lakeSpanMeters),
    );
    arrays.positions.push(x, lake.surfaceHeight, z);
    arrays.normals.push(0, 1, 0);
    // W-1e: one radius per vertex feeds both the normalized direction and the
    // radial factor — `normalizedDirection` computed the same `Math.hypot`
    // the radial term computed again, and allocated a tuple to return it.
    const offsetX = x - lake.centerX;
    const offsetZ = z - lake.centerZ;
    const offsetLength = Math.hypot(offsetX, offsetZ);
    const directionX = offsetLength > 1e-6 ? offsetX / offsetLength : 0;
    const directionZ = offsetLength > 1e-6 ? offsetZ / offsetLength : 1;
    const radial = clamp(offsetLength / Math.max(lake.radiusMeters, 1e-6), 0, 1);
    arrays.uvs.push(0.5 + directionX * 0.5 * radial, 0.5 + directionZ * 0.5 * radial);
    arrays.flowData.push(lake.flowDirection[0], lake.flowDirection[1], 0.18, 0);
    arrays.waterData.push(
      0.08 + (maximumDepth - 0.08) * (1 - shore),
      1,
      shore,
      channelPayload,
    );
    pushChemistry(arrays, chemistry, 1);
  }
  // The ring is CCW; emitting (a, c, b) matches the legacy fan's winding.
  for (let index = 0; index < triangles.length; index += 3) {
    arrays.indices.push(
      baseVertex + triangles[index]!,
      baseVertex + triangles[index + 2]!,
      baseVertex + triangles[index + 1]!,
    );
  }
}

/**
 * `W-1e` harness seam: the graph-mode river and lake attribute arrays exactly
 * as `buildRegion` produces them, without a Babylon device. Used by
 * `scripts/channel-extract-benchmark.mts` and by the graph byte pin in
 * `tests/render.webgpu-hydrology.test.ts`; the renderer path is unchanged and
 * still goes through `buildMesh`.
 */
export function buildGraphHydrologyMeshArrays(
  rivers: readonly HydrologyRiver[],
  lakes: readonly HydrologyLake[],
): { readonly rivers: HydrologyMeshArrays; readonly lakes: HydrologyMeshArrays } {
  const riverArrays = emptyMeshArrays();
  for (const river of rivers) {
    appendGraphRiver(riverArrays, river, () => HYDROLOGY_NEUTRAL_CLIMATE, 0);
  }
  const lakeArrays = emptyMeshArrays();
  for (const lake of lakes) {
    appendGraphLake(lakeArrays, lake, () => HYDROLOGY_NEUTRAL_CLIMATE, 0);
  }
  return { rivers: riverArrays, lakes: lakeArrays };
}

/**
 * A region's water geometry as transferable typed arrays (P2b).
 *
 * The hydrology worker builds a region's river and lake arrays beside its
 * generation and TRANSFERS them, so the main thread no longer clips every
 * lake against the analytic ground when the region arrives (measured: 290 ms
 * of a 325 ms frame per 747 region at Chrome's 4x throttle; ~7,500 ground
 * samples and ~9,600 vertices per lake).
 *
 * Packing is exact with respect to what the GPU received before: vertex lanes
 * as Float32Array (Babylon converts number[] to exactly this), and indices as
 * Uint16Array unless an index exceeds 65,535, then Uint32Array, which is the
 * rule Babylon's WebGPU `createIndexBuffer` applies to a number[].
 */
export interface PackedHydrologyMeshArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly flowData: Float32Array;
  readonly waterData: Float32Array;
  readonly waterChemistry: Float32Array;
}

export interface PackedHydrologyRegionGeometry {
  readonly rivers: PackedHydrologyMeshArrays | null;
  readonly lakes: PackedHydrologyMeshArrays | null;
}

/** Null for an empty build, mirroring the renderer's "no mesh" case. */
export function packHydrologyMeshArrays(arrays: HydrologyMeshArrays): PackedHydrologyMeshArrays | null {
  if (arrays.positions.length === 0 || arrays.indices.length === 0) return null;
  let wide = false;
  for (const index of arrays.indices) {
    if (index > 65_535) {
      wide = true;
      break;
    }
  }
  return {
    positions: Float32Array.from(arrays.positions),
    normals: Float32Array.from(arrays.normals),
    uvs: Float32Array.from(arrays.uvs),
    indices: wide ? Uint32Array.from(arrays.indices) : Uint16Array.from(arrays.indices),
    flowData: Float32Array.from(arrays.flowData),
    waterData: Float32Array.from(arrays.waterData),
    waterChemistry: Float32Array.from(arrays.waterChemistry),
  };
}

/**
 * The ANALYTIC region's river and lake arrays, exactly as the renderer builds
 * them: `appendRiver` per river, `appendContainedLake` per lake. Graph
 * (eroded) worlds never page, so they never come through here.
 */
export function buildAnalyticRegionMeshArrays(
  hydrology: { readonly rivers: readonly HydrologyRiver[]; readonly lakes: readonly HydrologyLake[] },
  ground: (x: number, z: number) => number,
  climate: HydrologyClimateSampler,
  seaLevel: number,
): { readonly rivers: HydrologyMeshArrays; readonly lakes: HydrologyMeshArrays } {
  const rivers = emptyMeshArrays();
  for (const river of hydrology.rivers) appendRiver(rivers, river, climate, seaLevel);
  const lakes = emptyMeshArrays();
  for (const lake of hydrology.lakes) appendContainedLake(lakes, lake, ground, climate, seaLevel);
  return { rivers, lakes };
}

/** The buffers to list in `postMessage`'s transfer argument. */
export function packedRegionGeometryTransferables(
  geometry: PackedHydrologyRegionGeometry,
): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const mesh of [geometry.rivers, geometry.lakes]) {
    if (!mesh) continue;
    for (const lane of [
      mesh.positions, mesh.normals, mesh.uvs, mesh.indices,
      mesh.flowData, mesh.waterData, mesh.waterChemistry,
    ]) buffers.push(lane.buffer as ArrayBuffer);
  }
  return buffers;
}

function isPackedMesh(value: unknown): value is PackedHydrologyMeshArrays {
  if (!value || typeof value !== "object") return false;
  const mesh = value as Record<string, unknown>;
  const vertexCount = mesh.positions instanceof Float32Array ? mesh.positions.length / 3 : -1;
  const lane = (name: string, stride: number) =>
    mesh[name] instanceof Float32Array && (mesh[name] as Float32Array).length === vertexCount * stride;
  return Number.isInteger(vertexCount) && vertexCount > 0
    && lane("normals", 3) && lane("uvs", 2)
    && lane("flowData", 4) && lane("waterData", 4) && lane("waterChemistry", 4)
    && (mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array)
    && (mesh.indices as Uint16Array).length % 3 === 0;
}

/** Structural check for geometry received from a worker. */
export function isPackedHydrologyRegionGeometry(value: unknown): value is PackedHydrologyRegionGeometry {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Record<string, unknown>;
  return (geometry.rivers === null || isPackedMesh(geometry.rivers))
    && (geometry.lakes === null || isPackedMesh(geometry.lakes));
}
