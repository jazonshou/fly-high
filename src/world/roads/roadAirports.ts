import { airportPlatformDistanceToSegment, segmentReachesAirportEarthworks } from "../airport";
import type { InfrastructureRail, InfrastructureRegion, InfrastructureSegment } from "../infrastructure";
import { hashSeed } from "../seed";
import type { AirportDefinition, WorldDefinition } from "../types";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth, type RoadClassId } from "./roadClasses";
import { roadEdgeReachBound, type RoadBox, type RoadEdge } from "./roadGraph";
import { roadPieceKey } from "./roadInfrastructure";
import { airportRoadHead } from "./roadNodes";
import {
  roadNetworkFor,
  ROAD_PAD_APRON_METERS,
  ROAD_TURN_PAD_MAX_RADIUS,
  type RoadPad,
  type RoadPiece,
} from "./roadNetwork";

/**
 * Spawned airports and the roads. The network is laid out round the home
 * field alone (`roadTerrain.ts`): a spawned field depends on where the
 * aircraft flew, and the network must not. So the two keep apart from the
 * airport's side:
 *
 *  - A gravel or sealed road refuses a spawned field whose earthworks it
 *    would reach (`roadsVetoAirport`, asked of every site the spawn search
 *    passes), so a spawned runway is never graded through one.
 *  - Tracks are too dense to refuse (a 1,750 m lattice: most fields would
 *    meet one), so a track a spawned field overruns stops where it would
 *    reach the earthworks (`clipRoadRegionForAirports`): its ribbon, paint,
 *    formation, pads and tyre surface all go, inside the field and its blend.
 *
 * "Reach the earthworks" is one test throughout: a capsule (a segment grown
 * by the road's half width and batters) coming within the platform's blend
 * (`segmentReachesAirportEarthworks`). The home field is never asked: its
 * own road head is laid out by hand inside its blend.
 */

/** The road classes that refuse a spawned field rather than being clipped by it. */
export const ROAD_CLASSES_REFUSING_AIRPORTS: readonly RoadClassId[] = Object.freeze([
  ROAD_CLASS.gravel,
  ROAD_CLASS.airport,
]);

/** The world-axis box round an airport's earthworks (the platform grown by its blend). */
export function airportEarthworksBox(airport: Readonly<AirportDefinition>): RoadBox {
  const blend = Math.max(0, airport.terrainBlendDistance);
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea + blend;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth + blend;
  const sine = Math.abs(Math.sin(airport.headingRadians));
  const cosine = Math.abs(Math.cos(airport.headingRadians));
  // Along the runway is (sin, cos) in world x, z; across is (cos, -sin).
  const extentX = halfLength * sine + halfWidth * cosine;
  const extentZ = halfLength * cosine + halfWidth * sine;
  return {
    minX: airport.centerX - extentX,
    minZ: airport.centerZ - extentZ,
    maxX: airport.centerX + extentX,
    maxZ: airport.centerZ + extentZ,
  };
}

/**
 * Whether a gravel or sealed road (`ROAD_CLASSES_REFUSING_AIRPORTS`) would
 * reach a spawned airport's earthworks: its formation and batters, or a
 * junction pad at one of its nodes. A pure function of the world's terrain
 * and the airport, whatever regions are installed (it asks the network, not
 * the stage). An eroded world has no roads, and refuses nothing.
 *
 * Each edge that could reach the field is first held to its bound
 * (`roadEdgeReachBound`), and only one within it is routed, so most fields
 * cost a few lattice nodes; one beside a road routes that road once
 * (memoised with the network). The sealed road is held to the bounds of all
 * its candidates (`airportEdgeCandidates`) before it is routed: it takes
 * seconds, and few fields come near it.
 */
export function roadsVetoAirport(world: WorldDefinition, airport: Readonly<AirportDefinition>): boolean {
  if (world.worldEvolution === "eroded") return false;
  const network = roadNetworkFor(world);
  const box = airportEarthworksBox(airport);
  const blend = Math.max(0, airport.terrainBlendDistance);
  const withinBound = (edge: RoadEdge, extra = 0) =>
    airportPlatformDistanceToSegment(airport, edge.a.x, edge.a.z, edge.b.x, edge.b.z)
      < blend + roadEdgeReachBound(edge) + extra;
  for (const classId of ROAD_CLASSES_REFUSING_AIRPORTS) {
    const spec = roadClass(classId);
    const formation = roadFormationHalfWidth(spec) + spec.reach;
    const pad = ROAD_TURN_PAD_MAX_RADIUS + ROAD_PAD_APRON_METERS + spec.reach;
    if (classId === ROAD_CLASS.airport) {
      // Its hand-laid lead, from inside the home field's blend to the router's start, as `edgesNear` adds it.
      const head = airportRoadHead(network.world);
      const lead = head ? Math.hypot(head.exitX - head.startX, head.exitZ - head.startZ) : 0;
      if (!network.airportEdgeCandidates().some((edge) => withinBound(edge, lead))) continue;
    }
    for (const edge of network.edgesNear(classId, box)) {
      if (classId !== ROAD_CLASS.airport && !withinBound(edge)) continue;
      const geometry = network.geometry(edge);
      if (!geometry) continue;
      for (const piece of geometry.pieces) {
        if (segmentReachesAirportEarthworks(airport, piece.ax, piece.az, piece.bx, piece.bz, formation)) return true;
      }
      for (const node of [edge.a, edge.b]) {
        if (segmentReachesAirportEarthworks(airport, node.x, node.z, node.x, node.z, pad)) return true;
      }
    }
  }
  return false;
}

/** What a streamed road region brings: the stage's region, and the pieces and pads it was laid out from. */
export interface RoadRegionContent {
  readonly infrastructure: InfrastructureRegion;
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
}

/**
 * The region's key with the airports that clipped it: a clipped region is
 * different content, so it takes a different key (the stage's contract: a
 * key is its content), and is installed in place of the whole one.
 */
export function roadRegionClipKey(key: string, airports: readonly Readonly<AirportDefinition>[]): string {
  if (airports.length === 0) return key;
  const signature = airports.map((airport) => [
    airport.centerX, airport.centerZ, airport.headingRadians, airport.runwayLength, airport.runwayWidth,
    airport.endSafetyArea, airport.shoulderWidth, airport.terrainBlendDistance,
  ].join(",")).join(";");
  return `${key}~${(hashSeed(signature) >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * A streamed road region with everything that reaches a spawned airport's
 * earthworks taken out: each segment whose capsule (halfWidth + reach) comes
 * within an airport's platform blend, with the piece or pad it was laid out
 * from, and each guardrail cut where it would cross. Returns the region
 * itself when no airport reaches it, and otherwise a new one keyed by
 * `roadRegionClipKey` with the airports that clipped it, in the order given.
 *
 * Relies on `roadRegionInfrastructure`'s layout: a segment per piece, in the
 * pieces' order, then the patches', then a segment per pad, in the pads'
 * order, keyed by `roadPieceKey` and the pad's node id. A region laid out
 * otherwise throws.
 */
export function clipRoadRegionForAirports<T extends RoadRegionContent>(
  region: T,
  airports: readonly Readonly<AirportDefinition>[],
): T {
  const segments = region.infrastructure.segments;
  const reaches = (airport: Readonly<AirportDefinition>, segment: InfrastructureSegment) =>
    segmentReachesAirportEarthworks(
      airport, segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach,
    );
  const clipping = airports.filter((airport) => {
    if (!regionNear(region.infrastructure, airport)) return false;
    return segments.some((segment) => reaches(airport, segment))
      || (region.infrastructure.rails ?? []).some((rail) => railReaches(rail, airport));
  });
  if (clipping.length === 0) return region;
  const { pieces, pads } = region;
  const padStart = segments.length - pads.length;
  if (padStart < pieces.length) throw new Error(`Road region ${region.infrastructure.key} has fewer segments than pieces and pads`);
  const keptSegments: InfrastructureSegment[] = [];
  const keptPieces: RoadPiece[] = [];
  const keptPads: RoadPad[] = [];
  segments.forEach((segment, index) => {
    const piece = index < pieces.length ? pieces[index]! : null;
    const pad = index >= padStart ? pads[index - padStart]! : null;
    if (piece && segment.key !== roadPieceKey(piece)) {
      throw new Error(`Road region ${region.infrastructure.key}: segment ${index} is not its piece's`);
    }
    if (pad && segment.key !== pad.nodeId >>> 0) {
      throw new Error(`Road region ${region.infrastructure.key}: segment ${index} is not its pad's`);
    }
    if (clipping.some((airport) => reaches(airport, segment))) return;
    keptSegments.push(segment);
    if (piece) keptPieces.push(piece);
    if (pad) keptPads.push(pad);
  });
  const rails = (region.infrastructure.rails ?? []).flatMap((rail) => clipRail(rail, clipping));
  const infrastructure: InfrastructureRegion = Object.freeze({
    key: roadRegionClipKey(region.infrastructure.key, clipping),
    segments: Object.freeze(keptSegments),
    ...(rails.length > 0 ? { rails: Object.freeze(rails) } : {}),
  });
  return { ...region, infrastructure, pieces: Object.freeze(keptPieces), pads: Object.freeze(keptPads) };
}

/** A guardrail's beam and posts stand within this of its line, metres (generous: the beam is ~0.5 m deep). */
const RAIL_HALF_WIDTH_METERS = 1;

/** Whether any of a region's segments, or its rails, could come near the airport: a box test first. */
function regionNear(region: InfrastructureRegion, airport: Readonly<AirportDefinition>): boolean {
  const box = airportEarthworksBox(airport);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const segment of region.segments) {
    const outer = segment.halfWidth + segment.reach;
    minX = Math.min(minX, segment.ax - outer, segment.bx - outer);
    minZ = Math.min(minZ, segment.az - outer, segment.bz - outer);
    maxX = Math.max(maxX, segment.ax + outer, segment.bx + outer);
    maxZ = Math.max(maxZ, segment.az + outer, segment.bz + outer);
  }
  for (const rail of region.rails ?? []) {
    for (let k = 0; k + 1 < rail.points.length; k += 2) {
      minX = Math.min(minX, rail.points[k]! - RAIL_HALF_WIDTH_METERS);
      maxX = Math.max(maxX, rail.points[k]! + RAIL_HALF_WIDTH_METERS);
      minZ = Math.min(minZ, rail.points[k + 1]! - RAIL_HALF_WIDTH_METERS);
      maxZ = Math.max(maxZ, rail.points[k + 1]! + RAIL_HALF_WIDTH_METERS);
    }
  }
  return minX <= box.maxX && maxX >= box.minX && minZ <= box.maxZ && maxZ >= box.minZ;
}

function railStepReaches(rail: InfrastructureRail, k: number, airport: Readonly<AirportDefinition>): boolean {
  const p = rail.points;
  return segmentReachesAirportEarthworks(airport, p[k]!, p[k + 1]!, p[k + 2]!, p[k + 3]!, RAIL_HALF_WIDTH_METERS);
}

function railReaches(rail: InfrastructureRail, airport: Readonly<AirportDefinition>): boolean {
  for (let k = 0; k + 3 < rail.points.length; k += 2) {
    if (railStepReaches(rail, k, airport)) return true;
  }
  return false;
}

/** A guardrail with every step that reaches an airport's earthworks taken out: the runs either side, each of two points or more. */
function clipRail(rail: InfrastructureRail, airports: readonly Readonly<AirportDefinition>[]): InfrastructureRail[] {
  if (!airports.some((airport) => railReaches(rail, airport))) return [rail];
  const runs: InfrastructureRail[] = [];
  let run: number[] = [];
  const close = () => {
    if (run.length >= 4) runs.push(Object.freeze({ ...rail, points: Object.freeze(run) }));
    run = [];
  };
  for (let k = 0; k + 3 < rail.points.length; k += 2) {
    if (airports.some((airport) => railStepReaches(rail, k, airport))) {
      close();
      continue;
    }
    if (run.length === 0) run.push(rail.points[k]!, rail.points[k + 1]!);
    run.push(rail.points[k + 2]!, rail.points[k + 3]!);
  }
  close();
  return runs;
}
