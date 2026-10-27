import type { WorldDefinition } from "../types";
import {
  ROAD_CLASS,
  ROAD_PRIORITY,
  roadClass,
  roadFormationHalfWidth,
  type RoadClassId,
} from "./roadClasses";
import {
  fitRoadCurves,
  relaxRoadPolyline,
  roadPieces,
  roadSuperelevationAlong,
  roadVerticalProfile,
  sampleRoadAlignment,
  simplifyRoadPolyline,
  type RoadPieceTolerance,
  type RoadPin,
} from "./roadAlignment";
import {
  RoadNodeCache,
  makeRoadEdge,
  pointSegmentDistance,
  roadEdgeReachBound,
  roadEdgesNear,
  segmentBoxDistance,
  type RoadBox,
  type RoadEdge,
} from "./roadGraph";
import { airportRoadHead, airportRoadNode, type RoadNode } from "./roadNodes";
import { roadRouteDeviationLimit, roadRouteRelaxShift, routeRoadEdge } from "./roadRouting";
import { RoadGround, roadGroundAt, roadGroundHeight } from "./roadTerrain";

/**
 * The road network of one world: every edge's road (route, alignment,
 * profile, pieces), memoised, and the network cut into regions for the
 * infrastructure stage.
 *
 * REGIONS. The plane is cut into `ROAD_REGION_METERS` squares, and the
 * network into two layers: "major" (gravel roads and the sealed airport road,
 * generated within 12 km of the observer) and "track" (within 5 km). A
 * region of a layer holds the pieces whose midpoint lies in it and the
 * junction pads at its nodes. It is a pure function of (world, layer,
 * region): every edge's road depends only on the edge, the ground and the
 * roads it crosses that outrank it, never on which region asked first.
 *
 * CROSSINGS. Where two roads cross between nodes, the one that outranks the
 * other (higher class; within a class, higher edge id) keeps its profile and
 * the other is pinned to its height there. The stage lays the lower one
 * first, so the higher one's cross-section runs through unbroken.
 */

export const ROAD_REGION_METERS = 2_048;

export type RoadLayer = "major" | "track";
export const ROAD_LAYERS: readonly RoadLayer[] = Object.freeze(["major", "track"]);

export function roadLayerClasses(layer: RoadLayer): readonly RoadClassId[] {
  return layer === "major" ? [ROAD_CLASS.gravel, ROAD_CLASS.airport] : [ROAD_CLASS.track];
}

/** How far from the observer a layer is generated, metres. */
export function roadLayerWindow(layer: RoadLayer): number {
  return roadClass(layer === "major" ? ROAD_CLASS.gravel : ROAD_CLASS.track).windowMeters;
}

export function roadRegionBox(rx: number, rz: number): RoadBox {
  return {
    minX: rx * ROAD_REGION_METERS,
    minZ: rz * ROAD_REGION_METERS,
    maxX: (rx + 1) * ROAD_REGION_METERS,
    maxZ: (rz + 1) * ROAD_REGION_METERS,
  };
}

export function roadRegionOf(coordinate: number): number {
  return Math.floor(coordinate / ROAD_REGION_METERS);
}

/** One straight piece of a road, in world metres: what becomes one infrastructure segment. */
export interface RoadPiece {
  readonly classId: RoadClassId;
  readonly edgeId: number;
  /** Index along its edge, from the edge's a end. */
  readonly index: number;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  /** Design centreline height at each end, world Y. */
  readonly ha: number;
  readonly hb: number;
  /** Cross slope at each end (superelevation; 0 on a crowned straight), rise per metre to the right of a->b. */
  readonly ca: number;
  readonly cb: number;
}

/** A level pad where roads meet (or a road ends). */
export interface RoadPad {
  /** The widest class meeting there. */
  readonly classId: RoadClassId;
  readonly nodeId: number;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** Level core radius, metres. */
  readonly radius: number;
}

export interface RoadRegion {
  readonly layer: RoadLayer;
  readonly rx: number;
  readonly rz: number;
  /** In composition order: (class priority, edge id, index). */
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
}

export interface RoadGeometryStats {
  readonly expanded: number;
  readonly samples: number;
  readonly retries: number;
  readonly maxFill: number;
  readonly maxCut: number;
  readonly maxGrade: number;
  readonly gradeRelaxed: boolean;
  readonly crossings: number;
}

/**
 * Why an edge has no road: no route in its corridor; every fitted line cut
 * into water or the airport; none had a profile within the earthworks
 * limits; the fitted line strayed past the corridor's bound; or a track
 * would only shadow a gravel or sealed road.
 */
export type RoadEdgeFailure = "route" | "wall" | "earthworks" | "bound" | "shadow";

/** One edge's finished road. */
export interface RoadGeometry {
  readonly edge: RoadEdge;
  /** Dense samples along the centreline. */
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly station: Float64Array;
  /** Signed curvature, 1/m, + turning left. */
  readonly curvature: Float64Array;
  /** Ground before every earthwork, and the design height, world Y. */
  readonly ground: Float64Array;
  readonly height: Float64Array;
  /** Cross slope (superelevation), rise per metre to the right. */
  readonly cross: Float64Array;
  readonly pieces: readonly RoadPiece[];
  readonly stats: RoadGeometryStats;
}

/** Vertical profile sample spacing, metres. */
const PROFILE_STEP: Readonly<Record<RoadClassId, number>> = Object.freeze({
  [ROAD_CLASS.track]: 4,
  [ROAD_CLASS.gravel]: 5,
  [ROAD_CLASS.airport]: 5,
});
/** Longest straight piece, metres. */
const PIECE_MAX: Readonly<Record<RoadClassId, number>> = Object.freeze({
  [ROAD_CLASS.track]: 32,
  [ROAD_CLASS.gravel]: 40,
  [ROAD_CLASS.airport]: 40,
});
/** How far a piece may stray from the samples it replaces: plan, height (metres) and cross slope. */
const PIECE_TOLERANCE: Readonly<Record<RoadClassId, RoadPieceTolerance>> = Object.freeze({
  [ROAD_CLASS.track]: Object.freeze({ horizontal: 0.2, vertical: 0.04, cross: 0.003 }),
  [ROAD_CLASS.gravel]: Object.freeze({ horizontal: 0.12, vertical: 0.025, cross: 0.003 }),
  [ROAD_CLASS.airport]: Object.freeze({ horizontal: 0.1, vertical: 0.02, cross: 0.003 }),
});
/** Within this of a node the grade is held to half the class's, so a pad meets gentle roads. */
const NODE_APPROACH: Readonly<Record<RoadClassId, number>> = Object.freeze({
  [ROAD_CLASS.track]: 20,
  [ROAD_CLASS.gravel]: 35,
  [ROAD_CLASS.airport]: 50,
});
/** Smoothing passes that take the grid's stair-steps out of a route before the curves are fitted. */
const RELAX_ITERATIONS = 30;
/** The airport road's lead-out stays straight this far from the road head, metres. */
export const ROAD_AIRPORT_LEAD_STRAIGHT = 150;
/**
 * Retries a route gets when no profile along it keeps within the class's
 * fill and cut: each steers the next route off every sample that failed.
 */
const EARTHWORK_RETRIES = 3;
const EARTHWORK_PENALTY_RADIUS = 120;
const EARTHWORK_PENALTY = 12;
/** A track within this of a gravel or sealed road for more than `SHADOW_FRACTION` of its length is dropped, metres. */
const SHADOW_DISTANCE = 120;
const SHADOW_FRACTION = 0.3;
const SHADOW_END = 200;
/** Crossings within this of a shared node are the node, not a crossing. */
const SHARED_NODE_CLEARANCE = 40;
/** Two crossings of the same pair closer than this are one. */
const CROSSING_MERGE = 15;
/** The road head's turning pad radius, metres. */
const ROAD_HEAD_PAD_RADIUS = 12;

/** Where earlier attempts failed, bucketed by the penalty radius: the next route's steer. */
class FailedSpots {
  private readonly buckets = new Map<string, number[]>();
  size = 0;

  add(x: number, z: number): void {
    const key = `${Math.floor(x / EARTHWORK_PENALTY_RADIUS)}:${Math.floor(z / EARTHWORK_PENALTY_RADIUS)}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.push(x, z);
    this.size += 1;
  }

  /** `EARTHWORK_PENALTY` within the radius of any spot, else 0. */
  penalty(x: number, z: number): number {
    const i = Math.floor(x / EARTHWORK_PENALTY_RADIUS);
    const j = Math.floor(z / EARTHWORK_PENALTY_RADIUS);
    const radiusSquared = EARTHWORK_PENALTY_RADIUS * EARTHWORK_PENALTY_RADIUS;
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const bucket = this.buckets.get(`${i + di}:${j + dj}`);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 2) {
          const dx = x - bucket[k]!;
          const dz = z - bucket[k + 1]!;
          if (dx * dx + dz * dz < radiusSquared) return EARTHWORK_PENALTY;
        }
      }
    }
    return 0;
  }
}

/** Does edge `left` rank below `right` (lower class, or same class and lower id)? */
export function roadEdgeRanksBelow(left: RoadEdge, right: RoadEdge): boolean {
  return left.classId < right.classId || (left.classId === right.classId && left.id < right.id);
}

interface Crossing {
  /** Station on the first polyline and on the second. */
  readonly s0: number;
  readonly s1: number;
}

/** Where two sampled polylines cross: stations on each. */
function polylineCrossings(
  ax: Float64Array, az: Float64Array, as: Float64Array,
  bx: Float64Array, bz: Float64Array, bs: Float64Array,
): Crossing[] {
  const out: Crossing[] = [];
  const cell = 64;
  const grid = new Map<string, number[]>();
  for (let k = 0; k + 1 < bx.length; k += 1) {
    const i0 = Math.floor(Math.min(bx[k]!, bx[k + 1]!) / cell);
    const i1 = Math.floor(Math.max(bx[k]!, bx[k + 1]!) / cell);
    const j0 = Math.floor(Math.min(bz[k]!, bz[k + 1]!) / cell);
    const j1 = Math.floor(Math.max(bz[k]!, bz[k + 1]!) / cell);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        const key = `${i}:${j}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(k);
      }
    }
  }
  for (let k = 0; k + 1 < ax.length; k += 1) {
    const i0 = Math.floor(Math.min(ax[k]!, ax[k + 1]!) / cell);
    const i1 = Math.floor(Math.max(ax[k]!, ax[k + 1]!) / cell);
    const j0 = Math.floor(Math.min(az[k]!, az[k + 1]!) / cell);
    const j1 = Math.floor(Math.max(az[k]!, az[k + 1]!) / cell);
    const seen = new Set<number>();
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (const m of grid.get(`${i}:${j}`) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          const px = ax[k]!;
          const pz = az[k]!;
          const dx = ax[k + 1]! - px;
          const dz = az[k + 1]! - pz;
          const qx = bx[m]!;
          const qz = bz[m]!;
          const ex = bx[m + 1]! - qx;
          const ez = bz[m + 1]! - qz;
          const denominator = dx * ez - dz * ex;
          if (Math.abs(denominator) < 1e-12) continue;
          const t = ((qx - px) * ez - (qz - pz) * ex) / denominator;
          const u = ((qx - px) * dz - (qz - pz) * dx) / denominator;
          if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
          const s0 = as[k]! + (as[k + 1]! - as[k]!) * t;
          const s1 = bs[m]! + (bs[m + 1]! - bs[m]!) * u;
          if (out.some((crossing) => Math.abs(crossing.s0 - s0) < CROSSING_MERGE)) continue;
          out.push({ s0, s1 });
        }
      }
    }
  }
  out.sort((left, right) => left.s0 - right.s0);
  return out;
}

/** Linear interpolation of `values` at station `s`. */
function valueAtStation(values: Float64Array, station: Float64Array, s: number): number {
  const n = station.length;
  if (s <= station[0]!) return values[0]!;
  if (s >= station[n - 1]!) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (station[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const span = station[hi]! - station[lo]!;
  const t = span > 0 ? (s - station[lo]!) / span : 0;
  return values[lo]! + (values[hi]! - values[lo]!) * t;
}

/** The bounding box of a line's samples. */
function sampleBox(x: Float64Array, z: Float64Array): RoadBox {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < x.length; k += 1) {
    minX = Math.min(minX, x[k]!);
    maxX = Math.max(maxX, x[k]!);
    minZ = Math.min(minZ, z[k]!);
    maxZ = Math.max(maxZ, z[k]!);
  }
  return { minX, minZ, maxX, maxZ };
}

function sharedNode(left: RoadEdge, right: RoadEdge): RoadNode[] {
  const shared: RoadNode[] = [];
  for (const node of [left.a, left.b]) {
    if (node.key === right.a.key || node.key === right.b.key) shared.push(node);
  }
  return shared;
}

function pieceOrder(left: RoadPiece, right: RoadPiece): number {
  return roadClass(left.classId).priority - roadClass(right.classId).priority
    || (left.edgeId >>> 0) - (right.edgeId >>> 0)
    || left.index - right.index;
}

export class RoadNetwork {
  readonly nodes: RoadNodeCache;
  private readonly geometries = new Map<number, RoadGeometry | null>();
  private readonly failures = new Map<number, RoadEdgeFailure>();
  private airportEdgeMemo: RoadEdge | null | undefined;
  private readonly building = new Set<number>();

  constructor(readonly world: WorldDefinition) {
    this.nodes = new RoadNodeCache(world);
  }

  /** The sealed road: from the airport's road head to the nearest gravel node a route reaches. */
  airportEdge(): RoadEdge | null {
    if (this.airportEdgeMemo !== undefined) return this.airportEdgeMemo;
    this.airportEdgeMemo = null;
    const head = airportRoadHead(this.world);
    const start = airportRoadNode(this.world);
    if (!head || !start) return null;
    const reach = 2 * roadClass(ROAD_CLASS.gravel).nodeSpacing;
    const candidates = this.nodes.nodesInBox(ROAD_CLASS.gravel, {
      minX: head.exitX - reach,
      minZ: head.exitZ - reach,
      maxX: head.exitX + reach,
      maxZ: head.exitZ + reach,
    });
    const distance = (node: RoadNode) => Math.hypot(node.x - head.exitX, node.z - head.exitZ);
    candidates.sort((left, right) => distance(left) - distance(right) || (left.key < right.key ? -1 : 1));
    for (const node of candidates.slice(0, 6)) {
      if (distance(node) > roadClass(ROAD_CLASS.airport).maxEdgeLength) break;
      const edge = makeRoadEdge(ROAD_CLASS.airport, start, node);
      if (this.geometry(edge)) {
        this.airportEdgeMemo = edge;
        return edge;
      }
    }
    return null;
  }

  /** Every edge of a class whose road can reach the box, in key order. */
  edgesNear(classId: RoadClassId, box: RoadBox, margin = 0): RoadEdge[] {
    if (classId === ROAD_CLASS.airport) {
      const edge = this.airportEdge();
      if (!edge) return [];
      const head = airportRoadHead(this.world)!;
      const lead = Math.hypot(head.exitX - head.startX, head.exitZ - head.startZ);
      const reach = roadEdgeReachBound(edge) + lead + margin;
      return segmentBoxDistance(edge.a.x, edge.a.z, edge.b.x, edge.b.z, box) <= reach ? [edge] : [];
    }
    return roadEdgesNear(this.world, this.nodes, classId, box, margin);
  }

  /** An edge's road, or null where no route reaches. Memoised per edge. */
  geometry(edge: RoadEdge): RoadGeometry | null {
    const cached = this.geometries.get(edge.id);
    if (cached !== undefined) return cached;
    if (this.building.has(edge.id)) throw new Error(`Road edge ${edge.key} depends on itself`);
    this.building.add(edge.id);
    try {
      const geometry = this.build(edge);
      this.geometries.set(edge.id, geometry);
      return geometry;
    } finally {
      this.building.delete(edge.id);
    }
  }

  /** Why a built edge has no road (undefined for a road, or an edge not yet built). */
  failure(edge: RoadEdge): RoadEdgeFailure | undefined {
    return this.failures.get(edge.id);
  }

  /** How many edges have been built (the probe's and the worker's work count). */
  get builtEdgeCount(): number {
    return this.geometries.size;
  }

  private build(edge: RoadEdge): RoadGeometry | null {
    const world = this.world;
    const spec = roadClass(edge.classId);
    const airport = edge.classId === ROAD_CLASS.airport;
    const head = airport ? airportRoadHead(world) : null;
    const routeStartX = head ? head.exitX : edge.a.x;
    const routeStartZ = head ? head.exitZ : edge.a.z;
    const lead = head ? Math.hypot(head.exitX - head.startX, head.exitZ - head.startZ) : 0;
    const deviation = roadRouteDeviationLimit(spec, Math.hypot(edge.b.x - routeStartX, edge.b.z - routeStartZ), edge.corridor);
    const failed = new FailedSpots();
    let reason: RoadEdgeFailure = "earthworks";
    let expanded = 0;
    let samples = 0;
    for (let attempt = 0; attempt <= EARTHWORK_RETRIES; attempt += 1) {
      const penalty = failed.size === 0 ? undefined : (px: number, pz: number) => failed.penalty(px, pz);
      const route = routeRoadEdge({
        world,
        spec,
        ax: routeStartX,
        az: routeStartZ,
        bx: edge.b.x,
        bz: edge.b.z,
        corridor: edge.corridor,
        ...(penalty ? { penalty } : {}),
      });
      if (!route) return this.fail(edge, "route");
      expanded += route.expanded;
      samples += route.samples;
      const relaxed = relaxRoadPolyline(route.x, route.z, spec.routingGrid * 0.5, RELAX_ITERATIONS, roadRouteRelaxShift(spec));
      if (head) {
        relaxed.x.unshift(head.startX);
        relaxed.z.unshift(head.startZ);
      }
      const simple = simplifyRoadPolyline(relaxed.x, relaxed.z, spec.routingGrid * 0.25);
      const fit = fitRoadCurves(simple.x, simple.z, spec, head ? ROAD_AIRPORT_LEAD_STRAIGHT : 0, 0);
      const alignment = sampleRoadAlignment(fit, PROFILE_STEP[edge.classId]);
      const n = alignment.x.length;
      const ground = new Float64Array(n);
      const walls: number[] = [];
      let stray = false;
      for (let k = 0; k < n; k += 1) {
        const x = alignment.x[k]!;
        const z = alignment.z[k]!;
        const h = roadGroundHeight(world, x, z);
        ground[k] = h;
        // The lead-out crosses the airport's keep-out by design.
        if (alignment.station[k]! < lead) continue;
        const kind = roadGroundAt(world, x, z, h);
        if (kind === RoadGround.water || kind === RoadGround.airport) walls.push(k);
        if (pointSegmentDistance(x, z, routeStartX, routeStartZ, edge.b.x, edge.b.z) > deviation) stray = true;
      }
      samples += n;
      // Curve fitting strayed past the bound every veto relies on (never seen): no road.
      if (stray) return this.fail(edge, "bound");
      if (walls.length > 0) {
        // Curve fitting cut a corner into water or the airport: steer the next route off it.
        for (const k of walls) failed.add(alignment.x[k]!, alignment.z[k]!);
        reason = "wall";
        continue;
      }
      // A track running alongside a road for much of its way adds nothing but a second scar.
      if (edge.classId === ROAD_CLASS.track && this.shadowsMajorRoad(alignment.x, alignment.z, alignment.station)) {
        return this.fail(edge, "shadow");
      }
      const pins = this.pinsFor(edge, alignment.x, alignment.z, alignment.station);
      const grades = new Float64Array(Math.max(0, n - 1));
      const approach = NODE_APPROACH[edge.classId];
      for (let k = 0; k + 1 < n; k += 1) {
        const mid = 0.5 * (alignment.station[k]! + alignment.station[k + 1]!);
        const nearEnd = mid < approach || alignment.length - mid < approach;
        grades[k] = spec.maxGrade * (nearEnd ? 0.5 : 1);
      }
      const profile = roadVerticalProfile({
        ground,
        station: alignment.station,
        pins: pins.pins,
        grades,
        pitchGrade: spec.pitchGrade,
        smoothingMeters: spec.profileSmoothingMeters,
        maxFill: spec.maxFill,
        maxCut: spec.maxCut,
      });
      if (!profile.feasible) {
        // Steer the next route off every sample no profile could fit.
        for (const k of profile.infeasible) failed.add(alignment.x[k]!, alignment.z[k]!);
        reason = "earthworks";
        continue;
      }
      const cross = roadSuperelevationAlong(spec, alignment.curvature, alignment.station, spec.designSpeedKmh * 0.75);
      const pieceSpans = roadPieces(
        alignment.x, alignment.z, alignment.station, profile.height, cross, PIECE_MAX[edge.classId], PIECE_TOLERANCE[edge.classId],
      );
      const pieces: RoadPiece[] = pieceSpans.map((span, index) => Object.freeze({
        classId: edge.classId,
        edgeId: edge.id,
        index,
        ax: alignment.x[span.first]!,
        az: alignment.z[span.first]!,
        bx: alignment.x[span.last]!,
        bz: alignment.z[span.last]!,
        ha: profile.height[span.first]!,
        hb: profile.height[span.last]!,
        ca: cross[span.first]!,
        cb: cross[span.last]!,
      }));
      return Object.freeze({
        edge,
        x: alignment.x,
        z: alignment.z,
        station: alignment.station,
        curvature: alignment.curvature,
        ground,
        height: profile.height,
        cross,
        pieces: Object.freeze(pieces),
        stats: Object.freeze({
          expanded,
          samples,
          retries: attempt,
          maxFill: profile.maxFill,
          maxCut: profile.maxCut,
          maxGrade: profile.maxGrade,
          gradeRelaxed: profile.gradeRelaxed,
          crossings: pins.crossings,
        }),
      });
    }
    // No line in the corridor keeps out of the walls and within the class's earthworks: no road.
    return this.fail(edge, reason);
  }

  private fail(edge: RoadEdge, reason: RoadEdgeFailure): null {
    this.failures.set(edge.id, reason);
    return null;
  }

  /**
   * Does a track's line run within `SHADOW_DISTANCE` of a gravel or sealed
   * road for more than `SHADOW_FRACTION` of its length (its first and last
   * `SHADOW_END` metres aside, where a track leaving a road's node starts)?
   */
  private shadowsMajorRoad(x: Float64Array, z: Float64Array, station: Float64Array): boolean {
    const box = sampleBox(x, z);
    const near = new Map<string, number[]>();
    const cell = SHADOW_DISTANCE;
    for (const classId of roadLayerClasses("major")) {
      for (const other of this.edgesNear(classId, box, SHADOW_DISTANCE - roadClass(classId).reach)) {
        const road = this.geometry(other);
        if (!road) continue;
        for (let k = 0; k < road.x.length; k += 1) {
          const key = `${Math.floor(road.x[k]! / cell)}:${Math.floor(road.z[k]! / cell)}`;
          let bucket = near.get(key);
          if (!bucket) near.set(key, (bucket = []));
          bucket.push(road.x[k]!, road.z[k]!);
        }
      }
    }
    if (near.size === 0) return false;
    const length = station[station.length - 1]!;
    let counted = 0;
    let shadowed = 0;
    for (let k = 0; k < x.length; k += 1) {
      if (station[k]! < SHADOW_END || length - station[k]! < SHADOW_END) continue;
      counted += 1;
      const i = Math.floor(x[k]! / cell);
      const j = Math.floor(z[k]! / cell);
      let hit = false;
      for (let di = -1; di <= 1 && !hit; di += 1) {
        for (let dj = -1; dj <= 1 && !hit; dj += 1) {
          const bucket = near.get(`${i + di}:${j + dj}`);
          if (!bucket) continue;
          for (let m = 0; m < bucket.length; m += 2) {
            if (Math.hypot(x[k]! - bucket[m]!, z[k]! - bucket[m + 1]!) < SHADOW_DISTANCE) {
              hit = true;
              break;
            }
          }
        }
      }
      if (hit) shadowed += 1;
    }
    return counted > 0 && shadowed > SHADOW_FRACTION * counted;
  }

  /** The ends' heights, and the height of every outranking road this one crosses. */
  private pinsFor(
    edge: RoadEdge,
    x: Float64Array,
    z: Float64Array,
    station: Float64Array,
  ): { pins: RoadPin[]; crossings: number } {
    const length = station[station.length - 1]!;
    const pins: RoadPin[] = [
      { station: 0, height: edge.a.height },
      { station: length, height: edge.b.height },
    ];
    const box = sampleBox(x, z);
    let crossings = 0;
    for (let classId = edge.classId; classId <= ROAD_CLASS.airport; classId += 1) {
      for (const other of this.edgesNear(classId as RoadClassId, box, -roadClass(classId as RoadClassId).reach)) {
        if (other.id === edge.id || !roadEdgeRanksBelow(edge, other)) continue;
        const through = this.geometry(other);
        if (!through) continue;
        const shared = sharedNode(edge, other);
        for (const crossing of polylineCrossings(x, z, station, through.x, through.z, through.station)) {
          const px = valueAtStation(x, station, crossing.s0);
          const pz = valueAtStation(z, station, crossing.s0);
          if (shared.some((node) => Math.hypot(px - node.x, pz - node.z) < SHARED_NODE_CLEARANCE)) continue;
          if (crossing.s0 < SHARED_NODE_CLEARANCE || length - crossing.s0 < SHARED_NODE_CLEARANCE) continue;
          pins.push({ station: crossing.s0, height: valueAtStation(through.height, through.station, crossing.s1) });
          crossings += 1;
        }
      }
    }
    return { pins, crossings };
  }

  /** One region of one layer: its pieces and pads, in composition order. */
  region(layer: RoadLayer, rx: number, rz: number): RoadRegion {
    const box = roadRegionBox(rx, rz);
    const inBox = (px: number, pz: number) => px >= box.minX && px < box.maxX && pz >= box.minZ && pz < box.maxZ;
    const pieces: RoadPiece[] = [];
    const incident = new Map<string, { node: RoadNode; classId: RoadClassId; dirs: number[] }>();
    const note = (node: RoadNode, classId: RoadClassId, geometry: RoadGeometry, atStart: boolean) => {
      if (!inBox(node.x, node.z)) return;
      let entry = incident.get(node.key);
      if (!entry) incident.set(node.key, (entry = { node, classId, dirs: [] }));
      entry.classId = Math.max(entry.classId, classId) as RoadClassId;
      const n = geometry.x.length;
      const [i0, i1] = atStart ? [0, Math.min(n - 1, 4)] : [n - 1, Math.max(0, n - 5)];
      entry.dirs.push(Math.atan2(geometry.x[i1]! - geometry.x[i0]!, geometry.z[i1]! - geometry.z[i0]!));
    };
    for (const classId of roadLayerClasses(layer)) {
      for (const edge of this.edgesNear(classId, box)) {
        const geometry = this.geometry(edge);
        if (!geometry) continue;
        for (const piece of geometry.pieces) {
          if (inBox(0.5 * (piece.ax + piece.bx), 0.5 * (piece.az + piece.bz))) pieces.push(piece);
        }
        note(edge.a, classId, geometry, true);
        note(edge.b, classId, geometry, false);
      }
    }
    // A gravel node only tracks reach gets its pad from the track layer.
    if (layer === "track") {
      for (const key of [...incident.keys()]) {
        const node = incident.get(key)!.node;
        if (node.classId === ROAD_CLASS.track) continue;
        const major = this.edgesNear(ROAD_CLASS.gravel, box).some((edge) =>
          (edge.a.key === key || edge.b.key === key) && this.geometry(edge) !== null);
        if (major) incident.delete(key);
      }
    }
    pieces.sort(pieceOrder);
    const pads: RoadPad[] = [];
    for (const { node, classId, dirs } of incident.values()) {
      // Fixed nodes: the marina's car park pad is the marina's; the airport's road head gets a turning pad.
      if (node.key === "marina") continue;
      const spec = roadClass(classId);
      const half = roadFormationHalfWidth(spec);
      let radius = half + 2;
      if (node.key === "airport") radius = ROAD_HEAD_PAD_RADIUS;
      else if (dirs.length > 1) {
        let narrowest = Math.PI;
        for (let i = 0; i < dirs.length; i += 1) {
          for (let j = i + 1; j < dirs.length; j += 1) {
            let difference = Math.abs(dirs[i]! - dirs[j]!) % (2 * Math.PI);
            if (difference > Math.PI) difference = 2 * Math.PI - difference;
            narrowest = Math.min(narrowest, difference);
          }
        }
        radius = Math.min(3 * half + 6, Math.max(half + 2, half / Math.sin(Math.max(0.2, narrowest) / 2)));
      }
      pads.push(Object.freeze({ classId, nodeId: node.id, x: node.x, z: node.z, height: node.height, radius }));
    }
    pads.sort((left, right) => (left.nodeId >>> 0) - (right.nodeId >>> 0));
    return Object.freeze({ layer, rx, rz, pieces: Object.freeze(pieces), pads: Object.freeze(pads) });
  }
}

/** The composition priority a pad takes. */
export const ROAD_PAD_PRIORITY = ROAD_PRIORITY.junction;

/**
 * A world's terrain identity for the roads: what the network depends on.
 * Not the airport list (spawned fields keep clear of roads instead).
 */
export function roadWorldKey(world: WorldDefinition): string {
  const airport = world.airport;
  return [
    world.seedHash,
    world.seaLevel,
    world.worldEvolution,
    JSON.stringify(world.climateProvince ?? null),
    JSON.stringify(world.landforms ?? null),
    airport
      ? [airport.centerX, airport.centerZ, airport.headingRadians, airport.elevation, airport.runwayLength,
        airport.runwayWidth, airport.endSafetyArea, airport.shoulderWidth, airport.terrainBlendDistance].join(",")
      : "none",
  ].join("|");
}

const NETWORKS = new Map<string, RoadNetwork>();
const NETWORK_CACHE_LIMIT = 2;

/** The memoised network for a world's terrain identity (two kept). */
export function roadNetworkFor(world: WorldDefinition): RoadNetwork {
  const key = roadWorldKey(world);
  let network = NETWORKS.get(key);
  if (network) {
    NETWORKS.delete(key);
    NETWORKS.set(key, network);
    return network;
  }
  network = new RoadNetwork(world);
  NETWORKS.set(key, network);
  while (NETWORKS.size > NETWORK_CACHE_LIMIT) NETWORKS.delete(NETWORKS.keys().next().value!);
  return network;
}
