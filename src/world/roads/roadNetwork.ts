import { infrastructureTerrainKey } from "../infrastructure";
import { ROAD_JOIN_BLEND_METERS, roadCrossOffset } from "../roadEarthworkProfiles";
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
  type RoadSamples,
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
import { airportRoadHead, airportRoadNode, marinaRoadNode, type RoadNode } from "./roadNodes";
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
 * the other is graded to it: pinned to the higher one's surface wherever its
 * centreline is on that formation (and a profile step beyond), its crown
 * eased out and its cross slope turned to the plane of the higher one's
 * formation on that side, so the two meet at one level across both
 * formations. The stage lays the lower one first, so the higher one's
 * cross-section runs through unbroken; the higher one's ditch would cut
 * across the lower one, so the lower one lays its own pieces again from that
 * formation's edge to past the ditch afterwards (`RoadGeometry.patches`,
 * composed at `ROAD_PRIORITY.crossing`).
 *
 * PADS. Where roads meet, the pad is the plane of the node's top road (the
 * one that outranks every other built there): through the node, rising
 * along that road's chord to the pad's edge, so that road runs through it
 * as it was graded; every other road there is pinned to the plane from the
 * node to past the pad's apron, so none meets it at a kerb. A pad's size
 * reads every road's heading there, so it takes the others' from their first
 * routed lines (`firstLine`, which no other road changes) and the top road's
 * own: the same answer whichever road asks first.
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
  /** Cross-fall each side of the crown at each end: the class's, eased to 0 over a crossing. */
  readonly ka: number;
  readonly kb: number;
}

/**
 * A pad where roads meet (or a road ends): a plane through the node's
 * height, level or tilted with the node's top road (`RoadNetwork` PADS).
 */
export interface RoadPad {
  /** The widest class meeting there. */
  readonly classId: RoadClassId;
  readonly nodeId: number;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** The plane's rise per metre along +x and +z. */
  readonly gradientX: number;
  readonly gradientZ: number;
  /** Core radius (the plane's), metres. */
  readonly radius: number;
}

export interface RoadRegion {
  readonly layer: RoadLayer;
  readonly rx: number;
  readonly rz: number;
  /** In composition order: (class priority, edge id, index). */
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
  /** Crossing patches (`RoadGeometry.patches`) whose midpoint lies in the region, in (edge id, index) order. */
  readonly patches: readonly RoadPiece[];
}

/** What a guardrail keeps clear of (`RoadNetwork.railKeepOuts`). */
export interface RoadRailKeepOuts {
  readonly pads: readonly RoadPad[];
  /** Every road's pieces that reach the box asked about, of every class and edge. */
  readonly pieces: readonly RoadPiece[];
  /** The marina's car park anchor, where the gravel road meets the marina's own pad; null outside the box. */
  readonly carPark: { readonly x: number; readonly z: number } | null;
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
  /**
   * Where this road crosses an outranking one with a ditch: this road's own
   * pieces again, each side, from where its formation first meets that
   * road's formation edge to past the ditch, heading away from the crossing
   * (so the soft end, the join band, lies on that road's formation and the
   * round cap away from it). Each is the part of one of this road's pieces
   * it lies on, so the stage, laying them after every road with no ditch of
   * their own, lays this road's surface again over the ditch exactly; a run
   * ends inside a piece with room for its round cap, which then lies on that
   * piece too. Indices are their own (`ROAD_PATCH_STRIDE`).
   */
  readonly patches: readonly RoadPiece[];
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
/** A crossing's grading runs this far past the outranking formation's edge, metres. */
const CROSSING_GRADE_MARGIN = 1;
/** A crossing's matched cross slope eases back to the road's own over this, metres. */
const CROSSING_CROSS_EASE = 15;
/** A patch runs this far past the outranking road's ditch, metres. */
const PATCH_MARGIN = 2;
/** The shortest patch piece, metres. */
const PATCH_MIN_PIECE = 0.5;
/** Patch indices: a crossing's ordinal times this, plus 16 on its second side, plus the piece. */
export const ROAD_PATCH_STRIDE = 32;
/** A pad's apron, metres, and how fast its allowance grows over it, rise per metre (`roadInfrastructure.ts` lays them). */
export const ROAD_PAD_APRON_METERS = 3;
export const ROAD_PAD_APRON_SLOPE = 0.08;
/** An outranking road is searched for the nearest point this far either side of the crossing, metres. */
const CROSSING_SEARCH = 60;

/** One pinned crossing of an outranking road: stations on each, and that road's frame there. */
interface PinnedCrossing {
  readonly s0: number;
  readonly s1: number;
  /** This road's centreline at s0. */
  readonly x: number;
  readonly z: number;
  readonly through: RoadGeometry;
  /** The outranking road's direction and grade at s1. */
  readonly tx: number;
  readonly tz: number;
  readonly grade: number;
  /** |sin| of the angle between the two roads. */
  readonly sine: number;
}

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

/** A crossing's outranking frame: its direction and grade at s1, and the angle's sine. */
function pinnedCrossing(
  x: Float64Array,
  z: Float64Array,
  station: Float64Array,
  through: RoadGeometry,
  crossing: Crossing,
): PinnedCrossing {
  const s1a = crossing.s1 - 2;
  const s1b = crossing.s1 + 2;
  let tx = valueAtStation(through.x, through.station, s1b) - valueAtStation(through.x, through.station, s1a);
  let tz = valueAtStation(through.z, through.station, s1b) - valueAtStation(through.z, through.station, s1a);
  const run = Math.hypot(tx, tz);
  tx = run > 0 ? tx / run : 1;
  tz = run > 0 ? tz / run : 0;
  const grade = run > 0
    ? (valueAtStation(through.height, through.station, s1b) - valueAtStation(through.height, through.station, s1a)) / run
    : 0;
  let ux = valueAtStation(x, station, crossing.s0 + 2) - valueAtStation(x, station, crossing.s0 - 2);
  let uz = valueAtStation(z, station, crossing.s0 + 2) - valueAtStation(z, station, crossing.s0 - 2);
  const own = Math.hypot(ux, uz);
  ux = own > 0 ? ux / own : 1;
  uz = own > 0 ? uz / own : 0;
  return {
    s0: crossing.s0,
    s1: crossing.s1,
    x: valueAtStation(x, station, crossing.s0),
    z: valueAtStation(z, station, crossing.s0),
    through,
    tx,
    tz,
    grade,
    sine: Math.abs(ux * tz - uz * tx),
  };
}

/** A point's place on a road's centreline (`placeOnRoad`). */
interface RoadPlace {
  /** The nearest centreline point's station. */
  along: number;
  /** Signed distance from it, + to the right of the road's direction. */
  across: number;
  /** The road's direction there. */
  tx: number;
  tz: number;
}

/** The nearest point of `road`'s centreline to (px, pz) within `CROSSING_SEARCH` of station `near`, into `out`. */
function placeOnRoad(road: RoadGeometry, near: number, px: number, pz: number, out: RoadPlace): RoadPlace {
  const { x, z, station } = road;
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k + 1 < station.length; k += 1) {
    if (station[k + 1]! < near - CROSSING_SEARCH || station[k]! > near + CROSSING_SEARCH) continue;
    const dx = x[k + 1]! - x[k]!;
    const dz = z[k + 1]! - z[k]!;
    const run = Math.hypot(dx, dz);
    if (!(run > 0)) continue;
    const tx = dx / run;
    const tz = dz / run;
    const along = Math.min(run, Math.max(0, (px - x[k]!) * tx + (pz - z[k]!) * tz));
    const ox = px - (x[k]! + tx * along);
    const oz = pz - (z[k]! + tz * along);
    const distance = ox * ox + oz * oz;
    if (distance >= best) continue;
    best = distance;
    out.along = station[k]! + ((station[k + 1]! - station[k]!) * along) / run;
    out.across = ox * tz - oz * tx;
    out.tx = tx;
    out.tz = tz;
  }
  return out;
}

/** The outranking road's design surface at a place on it: its centreline and its crown or plane. */
function surfaceAtPlace(road: RoadGeometry, place: RoadPlace): number {
  const spec = roadClass(road.edge.classId);
  return valueAtStation(road.height, road.station, place.along)
    + roadCrossOffset(place.across, valueAtStation(road.cross, road.station, place.along), spec.crossfall);
}

/**
 * Over each pinned crossing, lay the road's section in the plane of the
 * outranking road's formation on the side its centreline is on: its
 * cross-fall eased out (a crown cannot lie in a plane) and its cross slope
 * turned to that plane's rise along this road's right (the outranking
 * road's grade, and its cross slope on that side); both eased back to the
 * road's own over `CROSSING_CROSS_EASE`.
 */
function gradeCrossingSections(
  cross: Float64Array,
  crossfall: Float64Array,
  x: Float64Array,
  z: Float64Array,
  station: Float64Array,
  crossings: readonly PinnedCrossing[],
  step: number,
): void {
  const place: RoadPlace = { along: 0, across: 0, tx: 1, tz: 0 };
  for (const crossing of crossings) {
    const through = crossing.through;
    const spec = roadClass(through.edge.classId);
    const half = roadFormationHalfWidth(spec);
    const span = (half + step + CROSSING_GRADE_MARGIN) / Math.max(0.2, crossing.sine);
    for (let k = 0; k < station.length; k += 1) {
      const distance = Math.abs(station[k]! - crossing.s0);
      if (distance > span + CROSSING_CROSS_EASE) continue;
      const previous = Math.max(0, k - 1);
      const next = Math.min(station.length - 1, k + 1);
      const dx = x[next]! - x[previous]!;
      const dz = z[next]! - z[previous]!;
      const run = Math.hypot(dx, dz);
      if (!(run > 0)) continue;
      placeOnRoad(through, crossing.s1, x[k]!, z[k]!, place);
      const c = valueAtStation(through.cross, through.station, place.along);
      // The outranking formation's rise to its right on this side (d/d across of its section).
      const side = place.across >= 0 ? roadCrossOffset(1, c, spec.crossfall) : -roadCrossOffset(-1, c, spec.crossfall);
      const grade = (valueAtStation(through.height, through.station, place.along + 2)
        - valueAtStation(through.height, through.station, place.along - 2)) / 4;
      // This road's right is (dz, -dx) / run; the outranking road's direction (tx, tz), its right (tz, -tx).
      const matched = (grade * (dz * place.tx - dx * place.tz) + side * (dz * place.tz + dx * place.tx)) / run;
      const weight = 1 - Math.min(1, Math.max(0, (distance - span) / CROSSING_CROSS_EASE));
      cross[k] = cross[k]! + (matched - cross[k]!) * weight;
      crossfall[k] = crossfall[k]! * (1 - weight);
    }
  }
}

/**
 * A road's crossing patches (`RoadGeometry.patches`) from its pieces and
 * their bounds (`bounds[i]` to `bounds[i + 1]` the stations piece i spans):
 * at each crossing of an outranking road with a ditch, one run each side,
 * from where this road's formation first meets that road's formation edge
 * to past the ditch's far side and on to where the last patch piece's round
 * cap (the formation's half-width, and the join band) fits inside one piece.
 */
function roadCrossingPatches(
  edge: RoadEdge,
  pieces: readonly RoadPiece[],
  bounds: Float64Array,
  crossings: readonly PinnedCrossing[],
): RoadPiece[] {
  const patches: RoadPiece[] = [];
  if (pieces.length === 0) return patches;
  const length = bounds[pieces.length]!;
  const ownHalf = roadFormationHalfWidth(roadClass(edge.classId));
  const capRoom = ownHalf + ROAD_JOIN_BLEND_METERS;
  crossings.forEach((crossing, ordinal) => {
    const spec = roadClass(crossing.through.edge.classId);
    if (!(spec.ditchDepth > 0 && spec.ditchWidth > 0)) return;
    const half = roadFormationHalfWidth(spec);
    const sine = Math.max(0.2, crossing.sine);
    const cosine = Math.sqrt(Math.max(0, 1 - crossing.sine * crossing.sine));
    // Across the outranking road: where this one's formation first meets its edge, to past its ditch.
    const inner = Math.max(0, half - ownHalf * cosine);
    const outer = half + 2 * spec.ditchWidth + PATCH_MARGIN + ownHalf * cosine;
    ([1, -1] as const).forEach((side, sideIndex) => {
      const from = Math.max(0, Math.min(length, crossing.s0 + (side * inner) / sine));
      const to = Math.max(0, Math.min(length, crossing.s0 + (side * outer) / sine));
      // Where the run ends: at or past `to`, with the cap's room left in that piece.
      let piece = pieceAtStation(bounds, to);
      let end = side > 0 ? length : 0;
      for (; piece >= 0 && piece < pieces.length; piece += side) {
        const candidate = side > 0
          ? Math.max(to, bounds[piece]! + PATCH_MIN_PIECE)
          : Math.min(to, bounds[piece + 1]! - PATCH_MIN_PIECE);
        if (side > 0 ? candidate + capRoom <= bounds[piece + 1]! : candidate - capRoom >= bounds[piece]!) {
          end = candidate;
          break;
        }
      }
      let count = 0;
      for (let k = pieceAtStation(bounds, from); k >= 0 && k < pieces.length && count < 16; k += side) {
        const lo = bounds[k]!;
        const hi = bounds[k + 1]!;
        const sa = side > 0 ? Math.max(from, lo) : Math.min(from, hi);
        const sb = side > 0 ? Math.min(end, hi) : Math.max(end, lo);
        if (side * (sb - sa) > 1e-6) {
          const index = ordinal * ROAD_PATCH_STRIDE + sideIndex * 16 + count;
          patches.push(clippedPiece(pieces[k]!, (sa - lo) / (hi - lo), (sb - lo) / (hi - lo), index));
          count += 1;
        }
        if (side > 0 ? hi >= end : lo <= end) break;
      }
    });
  });
  return patches;
}

/** The piece whose bounds hold station `s` (the first, or last, outside them). */
function pieceAtStation(bounds: Float64Array, s: number): number {
  const pieces = bounds.length - 1;
  let lo = 0;
  let hi = pieces - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The part of `piece` from fraction `t0` to `t1` of it, as a piece of its
 * own heading from t0 to t1 (reversed when t1 < t0: its cross slope, rise to
 * the right, then changes sign).
 */
function clippedPiece(piece: RoadPiece, t0: number, t1: number, index: number): RoadPiece {
  const at = (from: number, to: number, t: number) => from + (to - from) * t;
  const flip = t1 < t0 ? -1 : 1;
  return Object.freeze({
    classId: piece.classId,
    edgeId: piece.edgeId,
    index,
    ax: at(piece.ax, piece.bx, t0),
    az: at(piece.az, piece.bz, t0),
    bx: at(piece.ax, piece.bx, t1),
    bz: at(piece.az, piece.bz, t1),
    ha: at(piece.ha, piece.hb, t0),
    hb: at(piece.ha, piece.hb, t1),
    ca: flip * at(piece.ca, piece.cb, t0),
    cb: flip * at(piece.ca, piece.cb, t1),
    ka: at(piece.ka, piece.kb, t0),
    kb: at(piece.ka, piece.kb, t1),
  });
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

/** One routed, fitted and sampled line for an edge (`RoadNetwork.routeLine`), and the routing's work. */
interface RoadLine {
  readonly alignment: RoadSamples;
  readonly expanded: number;
  readonly samples: number;
}

/** A node's pad as every road there sees it (`RoadNetwork.padShape`). */
interface RoadPadShape {
  readonly classId: RoadClassId;
  readonly radius: number;
  readonly gradientX: number;
  readonly gradientZ: number;
}

/** The heading (atan2(dx, dz)) a sampled line leaves a node by: its first 4 steps from that end. */
function headingFrom(line: { readonly x: ArrayLike<number>; readonly z: ArrayLike<number> }, atStart: boolean): number {
  const n = line.x.length;
  const [i0, i1] = atStart ? [0, Math.min(n - 1, 4)] : [n - 1, Math.max(0, n - 5)];
  return Math.atan2(line.x[i1]! - line.x[i0]!, line.z[i1]! - line.z[i0]!);
}

/** A layer's road that reaches a box: its class, edge and built geometry. */
interface LayerRoad {
  readonly classId: RoadClassId;
  readonly edge: RoadEdge;
  readonly geometry: RoadGeometry;
}

function inRoadBox(box: RoadBox, x: number, z: number): boolean {
  return x >= box.minX && x < box.maxX && z >= box.minZ && z < box.maxZ;
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
  /** The sealed road `airportEdge` is trying, while it builds it (its pads read it as the node's). */
  private airportTrial: RoadEdge | null = null;
  private readonly building = new Set<number>();
  private readonly firstLines = new Map<number, RoadLine | null>();
  private readonly padShapes = new Map<string, RoadPadShape | null>();

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
      this.airportTrial = edge;
      try {
        if (this.geometry(edge)) {
          this.airportEdgeMemo = edge;
          return edge;
        }
      } finally {
        this.airportTrial = null;
      }
    }
    return null;
  }

  /** Every edge of a class whose road can reach the box, in key order. */
  edgesNear(classId: RoadClassId, box: RoadBox, margin = 0): RoadEdge[] {
    if (classId === ROAD_CLASS.airport) {
      const edge = this.airportTrial ?? this.airportEdge();
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

  /**
   * An edge's line: routed (steered off `failed`'s spots, if any), relaxed,
   * fitted with curves and sampled; null where no route reaches.
   */
  private routeLine(edge: RoadEdge, failed?: FailedSpots): RoadLine | null {
    const spec = roadClass(edge.classId);
    const head = edge.classId === ROAD_CLASS.airport ? airportRoadHead(this.world) : null;
    const penalty = failed && failed.size > 0 ? (px: number, pz: number) => failed.penalty(px, pz) : undefined;
    const route = routeRoadEdge({
      world: this.world,
      spec,
      ax: head ? head.exitX : edge.a.x,
      az: head ? head.exitZ : edge.a.z,
      bx: edge.b.x,
      bz: edge.b.z,
      corridor: edge.corridor,
      ...(penalty ? { penalty } : {}),
    });
    if (!route) return null;
    const relaxed = relaxRoadPolyline(route.x, route.z, spec.routingGrid * 0.5, RELAX_ITERATIONS, roadRouteRelaxShift(spec));
    if (head) {
      relaxed.x.unshift(head.startX);
      relaxed.z.unshift(head.startZ);
    }
    const simple = simplifyRoadPolyline(relaxed.x, relaxed.z, spec.routingGrid * 0.25);
    const fit = fitRoadCurves(simple.x, simple.z, spec, head ? ROAD_AIRPORT_LEAD_STRAIGHT : 0, 0);
    return Object.freeze({
      alignment: sampleRoadAlignment(fit, PROFILE_STEP[edge.classId]),
      expanded: route.expanded,
      samples: route.samples,
    });
  }

  /** An edge's first line (`routeLine`, steered off nothing), memoised: what every pad at its nodes reads its heading from. */
  private firstLine(edge: RoadEdge): RoadLine | null {
    let line = this.firstLines.get(edge.id);
    if (line === undefined) this.firstLines.set(edge.id, (line = this.routeLine(edge)));
    return line;
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
      const line = attempt === 0 ? this.firstLine(edge) : this.routeLine(edge, failed);
      if (!line) return this.fail(edge, "route");
      expanded += line.expanded;
      samples += line.samples;
      const alignment = line.alignment;
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
      this.approachPins(edge, alignment.x, alignment.z, alignment.station, pins.pins);
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
      const crossfall = new Float64Array(n).fill(spec.crossfall);
      gradeCrossingSections(
        cross, crossfall, alignment.x, alignment.z, alignment.station, pins.crossings, PROFILE_STEP[edge.classId],
      );
      const pieceSpans = roadPieces(
        alignment.x, alignment.z, alignment.station, profile.height, cross, crossfall,
        PIECE_MAX[edge.classId], PIECE_TOLERANCE[edge.classId],
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
        ka: crossfall[span.first]!,
        kb: crossfall[span.last]!,
      }));
      const bounds = new Float64Array(pieceSpans.length + 1);
      pieceSpans.forEach((span, index) => {
        bounds[index] = alignment.station[span.first]!;
        bounds[index + 1] = alignment.station[span.last]!;
      });
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
        patches: Object.freeze(roadCrossingPatches(edge, pieces, bounds, pins.crossings)),
        stats: Object.freeze({
          expanded,
          samples,
          retries: attempt,
          maxFill: profile.maxFill,
          maxCut: profile.maxCut,
          maxGrade: profile.maxGrade,
          gradeRelaxed: profile.gradeRelaxed,
          crossings: pins.crossings.length,
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

  /**
   * The ends' heights, and every outranking road this one crosses: pinned to
   * its surface at every sample whose point lies on its formation, or within
   * a sample's spacing of it (its section carried on past the edge), so the
   * two meet level across both formations.
   */
  private pinsFor(
    edge: RoadEdge,
    x: Float64Array,
    z: Float64Array,
    station: Float64Array,
  ): { pins: RoadPin[]; crossings: PinnedCrossing[] } {
    const length = station[station.length - 1]!;
    const pins: RoadPin[] = [
      { station: 0, height: edge.a.height },
      { station: length, height: edge.b.height },
    ];
    const box = sampleBox(x, z);
    const crossings: PinnedCrossing[] = [];
    const step = PROFILE_STEP[edge.classId];
    const place: RoadPlace = { along: 0, across: 0, tx: 1, tz: 0 };
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
          const pinned = pinnedCrossing(x, z, station, through, crossing);
          const half = roadFormationHalfWidth(roadClass(through.edge.classId));
          const span = (half + step + CROSSING_GRADE_MARGIN) / Math.max(0.2, pinned.sine);
          for (let k = 0; k < station.length; k += 1) {
            if (Math.abs(station[k]! - crossing.s0) > span) continue;
            if (station[k]! < SHARED_NODE_CLEARANCE * 0.5 || length - station[k]! < SHARED_NODE_CLEARANCE * 0.5) continue;
            placeOnRoad(through, crossing.s1, x[k]!, z[k]!, place);
            if (Math.abs(place.across) > half + step) continue;
            // On the outranking section, carried on past its edge over the ditch the patch lays again.
            pins.push({ station: station[k]!, height: surfaceAtPlace(through, place) });
          }
          crossings.push(pinned);
        }
      }
    }
    return { pins, crossings };
  }

  /**
   * Where this road ends at a pad it does not shape (one that outranks it is
   * built at the node; at the marina's, every road), a pin at every sample
   * from the node to a sample past the pad's apron, on the pad's plane, so
   * the pad lays no kerb across it.
   */
  private approachPins(edge: RoadEdge, x: Float64Array, z: Float64Array, station: Float64Array, pins: RoadPin[]): void {
    const length = station[station.length - 1]!;
    for (const node of [edge.a, edge.b]) {
      const pad = this.padUnder(edge, node);
      if (!pad) continue;
      const atStart = node === edge.a;
      const reach = Math.min(0.5 * length, pad.radius + ROAD_PAD_APRON_METERS + PROFILE_STEP[edge.classId]);
      for (let k = 0; k < station.length; k += 1) {
        if ((atStart ? station[k]! : length - station[k]!) > reach) continue;
        pins.push({ station: station[k]!, height: node.height + pad.gradientX * (x[k]! - node.x) + pad.gradientZ * (z[k]! - node.z) });
      }
    }
  }

  /**
   * The pad an edge's road is graded to at one of its nodes: the marina's
   * (level with the car park's back, whichever road), or the pad of a node
   * where a road outranking this one is built (a track's is the major roads'
   * pad where one is built there, else the tracks'). Null where this road is
   * the node's top road, which grades the pad itself.
   */
  private padUnder(edge: RoadEdge, node: RoadNode): RoadPadShape | null {
    if (node.key === "marina") return this.padShape("major", node);
    const layers: readonly RoadLayer[] = edge.classId === ROAD_CLASS.track ? ROAD_LAYERS : ["major"];
    for (const layer of layers) {
      for (const other of this.nodeEdges(layer, node)) {
        // In rank order: the first built one outranking this road is the top road.
        if (!roadEdgeRanksBelow(edge, other)) break;
        if (this.geometry(other)) return this.padShape(layer, node);
      }
    }
    return null;
  }

  /** A layer's edges at a node, highest-ranked first (class, then id). */
  private nodeEdges(layer: RoadLayer, node: RoadNode): RoadEdge[] {
    const box = { minX: node.x, minZ: node.z, maxX: node.x, maxZ: node.z };
    const edges: RoadEdge[] = [];
    for (const classId of roadLayerClasses(layer)) {
      for (const edge of this.edgesNear(classId, box)) {
        if (edge.a.key === node.key || edge.b.key === node.key) edges.push(edge);
      }
    }
    return edges.sort((left, right) => (roadEdgeRanksBelow(left, right) ? 1 : roadEdgeRanksBelow(right, left) ? -1 : 0));
  }

  /**
   * The pad a layer lays at a node, memoised (null for none). Its class and
   * core radius read every road's heading there from its first line (a major
   * pad's from the tracks' too, as they meet it), so no road's own grading
   * changes it; its plane is the top road's chord from the node to the
   * core's edge, with that road's cross slope there (the marina's is level,
   * with the car park's back edge). A pure function of the node, so every
   * road graded to it and the region laying it agree.
   */
  private padShape(layer: RoadLayer, node: RoadNode): RoadPadShape | null {
    const key = `${layer}:${node.key}`;
    let shape = this.padShapes.get(key);
    if (shape === undefined) this.padShapes.set(key, (shape = this.shapePad(layer, node)));
    return shape;
  }

  private shapePad(layer: RoadLayer, node: RoadNode): RoadPadShape | null {
    const edges = this.nodeEdges(layer, node);
    const meeting = layer === "major" ? [...edges, ...this.nodeEdges("track", node)] : edges;
    const dirs: number[] = [];
    const halves: number[] = [];
    const ditches: number[] = [];
    let classId: RoadClassId | null = null;
    for (const edge of meeting) {
      const line = this.firstLine(edge);
      if (!line) continue;
      const spec = roadClass(edge.classId);
      dirs.push(headingFrom(line.alignment, edge.a.key === node.key));
      halves.push(roadFormationHalfWidth(spec));
      ditches.push(spec.ditchDepth > 0 ? 2 * spec.ditchWidth : 0);
      if (classId === null || edge.classId > classId) classId = edge.classId;
    }
    if (classId === null) return null;
    // The marina's car park is the pad of a road ending there alone.
    if (node.key === "marina" && dirs.length < 2) return null;
    const spec = roadClass(classId);
    const half = roadFormationHalfWidth(spec);
    let radius = half + 2;
    if (node.key === "airport") radius = ROAD_HEAD_PAD_RADIUS;
    else {
      for (let i = 0; i < dirs.length; i += 1) {
        for (let j = i + 1; j < dirs.length; j += 1) {
          let difference = Math.abs(dirs[i]! - dirs[j]!) % (2 * Math.PI);
          if (difference > Math.PI) difference = 2 * Math.PI - difference;
          // Between two ditched roads a car turning wide is in a ditch; onto a track, it backs and fills.
          if (ditches[i]! > 0 && ditches[j]! > 0) radius = Math.max(radius, roadTurnPadRadius(dirs[i]!, dirs[j]!, halves[i]!, halves[j]!));
          // Out to where each one's formation clears the other's ditch (its formation, without one),
          // less what the apron's allowance takes out of a ditch.
          const sine = Math.sin(Math.min(Math.PI / 2, Math.max(0.2, difference)));
          const clear = Math.max(ditches[i]!, ditches[j]!) + halves[i]! + halves[j]!;
          radius = Math.max(radius, Math.min(3 * half + 6, clear / sine - 0.5 * ROAD_PAD_APRON_METERS));
        }
      }
    }
    if (node.key === "marina") return Object.freeze({ classId, radius, gradientX: 0, gradientZ: 0 });
    // The plane: the top road's chord from the node to the core's edge, and its cross slope at the node.
    let top: RoadGeometry | null = null;
    for (const edge of edges) {
      top = this.geometry(edge);
      if (top) break;
    }
    if (!top) return null;
    const atStart = top.edge.a.key === node.key;
    const length = top.station[top.station.length - 1]!;
    const chord = Math.min(radius, 0.5 * length);
    const s = atStart ? chord : length - chord;
    const dx = valueAtStation(top.x, top.station, s) - node.x;
    const dz = valueAtStation(top.z, top.station, s) - node.z;
    const run = Math.hypot(dx, dz);
    if (!(run > 0)) return Object.freeze({ classId, radius, gradientX: 0, gradientZ: 0 });
    const grade = (valueAtStation(top.height, top.station, s) - node.height) / run;
    const ux = dx / run;
    const uz = dz / run;
    // Rise to the right of the way it leaves the node (its cross is to the right of a->b).
    const cross = atStart ? top.cross[0]! : -top.cross[top.cross.length - 1]!;
    return Object.freeze({ classId, radius, gradientX: grade * ux + cross * uz, gradientZ: grade * uz - cross * ux });
  }

  /** One region of one layer: its pieces and pads, in composition order. */
  region(layer: RoadLayer, rx: number, rz: number): RoadRegion {
    const box = roadRegionBox(rx, rz);
    const roads = this.layerRoads(layer, box);
    const pieces: RoadPiece[] = [];
    const patches: RoadPiece[] = [];
    for (const { geometry } of roads) {
      for (const piece of geometry.pieces) {
        if (inRoadBox(box, 0.5 * (piece.ax + piece.bx), 0.5 * (piece.az + piece.bz))) pieces.push(piece);
      }
      for (const patch of geometry.patches) {
        if (inRoadBox(box, 0.5 * (patch.ax + patch.bx), 0.5 * (patch.az + patch.bz))) patches.push(patch);
      }
    }
    pieces.sort(pieceOrder);
    patches.sort(pieceOrder);
    return Object.freeze({
      layer,
      rx,
      rz,
      pieces: Object.freeze(pieces),
      pads: Object.freeze(this.padsOf(layer, box, roads)),
      patches: Object.freeze(patches),
    });
  }

  /**
   * What a guardrail near `box` keeps clear of (`roadRails.ts`): the pads at
   * every node in it, of both layers, as their own regions lay them; the
   * marina's car park, where the road meets it; and every road's pieces that
   * reach the box, whichever region and layer holds them.
   */
  railKeepOuts(box: RoadBox): RoadRailKeepOuts {
    const pads: RoadPad[] = [];
    const pieces: RoadPiece[] = [];
    for (const layer of ROAD_LAYERS) {
      const roads = this.layerRoads(layer, box);
      pads.push(...this.padsOf(layer, box, roads));
      for (const { geometry } of roads) {
        for (const piece of geometry.pieces) {
          if (segmentBoxDistance(piece.ax, piece.az, piece.bx, piece.bz, box) <= 0) pieces.push(piece);
        }
      }
    }
    const marina = marinaRoadNode(this.world);
    const carPark = marina && inRoadBox(box, marina.x, marina.z) ? { x: marina.x, z: marina.z } : null;
    return { pads, pieces, carPark };
  }

  /** A layer's built roads that reach `box`, class by class. */
  private layerRoads(layer: RoadLayer, box: RoadBox): LayerRoad[] {
    const roads: LayerRoad[] = [];
    for (const classId of roadLayerClasses(layer)) {
      for (const edge of this.edgesNear(classId, box)) {
        const geometry = this.geometry(edge);
        if (geometry) roads.push({ classId, edge, geometry });
      }
    }
    return roads;
  }

  /**
   * The pads at a layer's nodes inside `box`, by node id. Every road meeting
   * such a node reaches the box, so a pad is the same whichever box holds its
   * node: a region's, or a smaller one round a guardrail.
   */
  private padsOf(layer: RoadLayer, box: RoadBox, roads: readonly LayerRoad[]): RoadPad[] {
    const nodes = new Map<string, RoadNode>();
    for (const { edge } of roads) {
      for (const node of [edge.a, edge.b]) {
        if (inRoadBox(box, node.x, node.z)) nodes.set(node.key, node);
      }
    }
    const pads: RoadPad[] = [];
    for (const node of nodes.values()) {
      // A gravel node only tracks reach gets its pad from the track layer.
      if (layer === "track" && node.classId !== ROAD_CLASS.track) {
        const major = this.nodeEdges("major", node).some((edge) => this.geometry(edge) !== null);
        if (major) continue;
      }
      // The airport's road head gets a turning pad (`padShape`). The
      // marina's car park is the marina's; the roads meeting at its back
      // still get a pad where they turn onto each other (the car park,
      // composed after it, keeps its own grading wherever the two overlap).
      const shape = this.padShape(layer, node);
      if (!shape) continue;
      pads.push(Object.freeze({
        classId: shape.classId,
        nodeId: node.id,
        x: node.x,
        z: node.z,
        height: node.height,
        gradientX: shape.gradientX,
        gradientZ: shape.gradientZ,
        radius: shape.radius,
      }));
    }
    pads.sort((left, right) => (left.nodeId >>> 0) - (right.nodeId >>> 0));
    return pads;
  }
}

/** The composition priority a pad takes. */
export const ROAD_PAD_PRIORITY = ROAD_PRIORITY.junction;

/**
 * The tightest line a car is held to between two roads at a node, metres:
 * the LandCruiser 76's 12.6 m kerb circle with a metre and a half to spare.
 */
export const ROAD_JUNCTION_TURN_RADIUS = 8;
/** Half a car's width, kept inside a formation or a pad on that line, metres. */
const ROAD_JUNCTION_CAR_HALF_WIDTH = 1;
/** No pad grows past this for a turn: anything sharper is a three-point turn, metres. */
export const ROAD_TURN_PAD_MAX_RADIUS = 24;

/**
 * The level pad a node needs for a car to turn at full lock from one road
 * onto another: the arc of `ROAD_JUNCTION_TURN_RADIUS` tangent to both
 * centrelines on the inside of the turn, wherever it leaves both formations
 * (less half a car), must be on the pad (plus half a car). Headings are
 * atan2(dx, dz) of each road leaving the node; 0 where the arc stays on the
 * roads, and never past `ROAD_TURN_PAD_MAX_RADIUS`.
 */
export function roadTurnPadRadius(headingA: number, headingB: number, halfA: number, halfB: number): number {
  const ax = Math.sin(headingA);
  const az = Math.cos(headingA);
  const bx = Math.sin(headingB);
  const bz = Math.cos(headingB);
  const interior = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
  if (interior < 1e-3 || interior > Math.PI - 1e-3) return 0;
  const turn = ROAD_JUNCTION_TURN_RADIUS;
  const tangent = turn / Math.tan(interior / 2);
  let mx = ax + bx;
  let mz = az + bz;
  const bisector = Math.hypot(mx, mz);
  mx /= bisector;
  mz /= bisector;
  const centre = turn / Math.sin(interior / 2);
  const cx = mx * centre;
  const cz = mz * centre;
  // The arc from the tangent point on A to the one on B, round the centre.
  const startAngle = Math.atan2(ax * tangent - cx, az * tangent - cz);
  let sweep = Math.atan2(bx * tangent - cx, bz * tangent - cz) - startAngle;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const offRoad = (px: number, pz: number, dx: number, dz: number, half: number): boolean => {
    const along = px * dx + pz * dz;
    return along < 0 || Math.abs(px * dz - pz * dx) > half - ROAD_JUNCTION_CAR_HALF_WIDTH;
  };
  let needed = 0;
  const steps = 48;
  for (let k = 0; k <= steps; k += 1) {
    const angle = startAngle + (sweep * k) / steps;
    const px = cx + Math.sin(angle) * turn;
    const pz = cz + Math.cos(angle) * turn;
    if (offRoad(px, pz, ax, az, halfA) && offRoad(px, pz, bx, bz, halfB)) {
      needed = Math.max(needed, Math.hypot(px, pz) + ROAD_JUNCTION_CAR_HALF_WIDTH);
    }
  }
  return Math.min(ROAD_TURN_PAD_MAX_RADIUS, needed);
}

const NETWORKS = new Map<string, RoadNetwork>();
const NETWORK_CACHE_LIMIT = 2;

/**
 * The memoised network for a world's terrain identity (two kept): the
 * stage's key, so a spawned airport's new world shares the network (spawned
 * fields keep clear of roads instead).
 */
export function roadNetworkFor(world: WorldDefinition): RoadNetwork {
  const key = infrastructureTerrainKey(world);
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
