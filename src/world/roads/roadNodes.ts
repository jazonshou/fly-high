import { runwayToWorld } from "../airport";
import { homeMarina } from "../marina";
import { hashCoordinates, hashSeed, mixSeed, unitFloatFromHash } from "../seed";
import type { WorldDefinition } from "../types";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth, type RoadClassId, type RoadClassSpec } from "./roadClasses";
import { RoadGround, roadAirportKeepOut, roadGroundAt, roadGroundHeight } from "./roadTerrain";

/**
 * The network's nodes: one per lattice cell of each class, at the best site
 * in the cell, plus two fixed ones (the home airport's landside road head
 * and the home marina's car park).
 *
 * A lattice node is a pure function of (world, class, cell): a dozen seeded
 * candidates in the cell's inner 80% are scored, and the best survives. That
 * locality is what lets any region of the network be generated on its own
 * with the same answer (the graph is a relative neighbourhood graph, which
 * reads only nearby nodes).
 *
 * The score asks what a builder would: flat (the slope across 2 x `probe`
 * metres against the class's grade), dry, off sand, lava and snow, and well
 * away from the home airport. A track also likes places a driver would want
 * to reach: a coast, a ridge, a pass.
 */

export interface RoadNode {
  /** Stable key: `${class}:${i}:${j}` for a lattice node, "marina" or "airport" for a fixed one. */
  readonly key: string;
  /** 32-bit hash of the key, for ids and ordering. */
  readonly id: number;
  /** The lattice the node belongs to; the fixed nodes join the gravel one. */
  readonly classId: RoadClassId;
  readonly x: number;
  readonly z: number;
  /** Design height at the node, metres (world Y). */
  readonly height: number;
  readonly fixed: boolean;
}

const NODE_CHANNEL = 0x52_4f_41_44; // "ROAD"
const NODE_CANDIDATES = 16;
/** A node keeps this far beyond the home airport's road keep-out. */
const NODE_AIRPORT_CLEARANCE_METERS = 400;
/** No lattice node within this of the marina's car park: the marina is the node there. */
const NODE_MARINA_CLEARANCE_METERS = 600;

export function roadNodeId(key: string): number {
  return hashSeed(key);
}

interface NodeScratch {
  height: number;
  score: number;
}

const SCRATCH: NodeScratch = { height: 0, score: 0 };

/** Slope of the ground across a cross of probes, rise over run. */
function siteSlope(world: WorldDefinition, x: number, z: number, h: number, probe: number): number {
  const east = roadGroundHeight(world, x + probe, z);
  const west = roadGroundHeight(world, x - probe, z);
  const north = roadGroundHeight(world, x, z + probe);
  const south = roadGroundHeight(world, x, z - probe);
  const gx = (east - west) / (2 * probe);
  const gz = (north - south) / (2 * probe);
  // The centre's own departure from the mean flags a knoll or a hollow too.
  const bump = Math.abs(h - (east + west + north + south) * 0.25) / probe;
  return Math.hypot(gx, gz) + bump;
}

/**
 * A track's pull towards places worth driving to, as a score bonus (more
 * negative is better): a coast within 300 m, a ridge or a pass.
 */
function destinationBonus(world: WorldDefinition, x: number, z: number, h: number): number {
  let bonus = 0;
  const sea = world.seaLevel;
  if (h - sea < 40) {
    for (let k = 0; k < 8; k += 1) {
      const angle = (k * Math.PI) / 4;
      if (roadGroundHeight(world, x + Math.sin(angle) * 300, z + Math.cos(angle) * 300) < sea) {
        bonus -= 0.6;
        break;
      }
    }
  }
  let ridgeAxes = 0;
  let valleyAxes = 0;
  const reach = 150;
  for (let axis = 0; axis < 4; axis += 1) {
    const angle = (axis * Math.PI) / 4;
    const dx = Math.sin(angle) * reach;
    const dz = Math.cos(angle) * reach;
    const plus = roadGroundHeight(world, x + dx, z + dz);
    const minus = roadGroundHeight(world, x - dx, z - dz);
    if (h >= Math.max(plus, minus) + 4) ridgeAxes += 1;
    else if (h <= Math.min(plus, minus) - 4) valleyAxes += 1;
  }
  if (ridgeAxes > 0 && valleyAxes > 0) bonus -= 0.8;
  else if (ridgeAxes > 0) bonus -= 0.4;
  return bonus;
}

function scoreSite(
  world: WorldDefinition,
  spec: RoadClassSpec,
  x: number,
  z: number,
  jitter: number,
  avoid: { readonly x: number; readonly z: number } | null,
  out: NodeScratch,
): boolean {
  if (roadAirportKeepOut(world, x, z) < NODE_AIRPORT_CLEARANCE_METERS) return false;
  if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < NODE_MARINA_CLEARANCE_METERS) return false;
  const h = roadGroundHeight(world, x, z);
  if (h < world.seaLevel + 3) return false;
  if (roadGroundAt(world, x, z, h) !== RoadGround.land) return false;
  const probe = spec.routingGrid * 2;
  const slope = siteSlope(world, x, z, h, probe);
  if (slope > spec.maxGrade) return false;
  let score = slope / spec.maxGrade + 0.25 * jitter;
  if (spec.id === ROAD_CLASS.track) score += destinationBonus(world, x, z, h);
  out.height = h;
  out.score = score;
  return true;
}

/** The marina car park, if the world has a home marina. Cached per world. */
const MARINA_NODES = new WeakMap<WorldDefinition, RoadNode | null>();

export function marinaRoadNode(world: WorldDefinition): RoadNode | null {
  if (MARINA_NODES.has(world)) return MARINA_NODES.get(world)!;
  let node: RoadNode | null = null;
  if (world.airport && world.worldEvolution !== "eroded") {
    try {
      // The layout's own anchor, which carries the car park's graded level
      // there: the road arrives at the height the marina's pad leaves it.
      const anchor = homeMarina(world).carParkAnchor;
      node = Object.freeze({
        key: "marina",
        id: roadNodeId("marina"),
        classId: ROAD_CLASS.gravel,
        x: anchor.x,
        z: anchor.z,
        height: anchor.y,
        fixed: true,
      });
    } catch {
      // No coast within the marina search's reach: no marina, no node.
      node = null;
    }
  }
  MARINA_NODES.set(world, node);
  return node;
}

/** One cell's node, or null where the cell has no buildable site. */
export function latticeRoadNode(world: WorldDefinition, classId: RoadClassId, i: number, j: number): RoadNode | null {
  const spec = roadClass(classId);
  const spacing = spec.nodeSpacing;
  if (!(spacing > 0)) return null;
  const marina = classId === ROAD_CLASS.gravel ? marinaRoadNode(world) : null;
  const stream = mixSeed(world.seedHash, NODE_CHANNEL + classId);
  let bestScore = Number.POSITIVE_INFINITY;
  let bestX = 0;
  let bestZ = 0;
  let bestHeight = 0;
  for (let k = 0; k < NODE_CANDIDATES; k += 1) {
    const hash = hashCoordinates(stream, i, j, k + 1);
    const u = unitFloatFromHash(hash);
    const v = unitFloatFromHash(mixSeed(hash, 1));
    const jitter = unitFloatFromHash(mixSeed(hash, 2));
    const x = (i + 0.1 + 0.8 * u) * spacing;
    const z = (j + 0.1 + 0.8 * v) * spacing;
    if (!scoreSite(world, spec, x, z, jitter, marina, SCRATCH)) continue;
    if (SCRATCH.score < bestScore) {
      bestScore = SCRATCH.score;
      bestX = x;
      bestZ = z;
      bestHeight = SCRATCH.height;
    }
  }
  if (!Number.isFinite(bestScore)) return null;
  const key = `${spec.name}:${i}:${j}`;
  return Object.freeze({
    key,
    id: roadNodeId(key),
    classId,
    x: bestX,
    z: bestZ,
    height: bestHeight,
    fixed: false,
  });
}

/** The lattice cell index a coordinate falls in. */
export function roadLatticeCell(coordinate: number, spacing: number): number {
  return Math.floor(coordinate / spacing);
}

/**
 * The home airport's road head: where the sealed access road starts, on the
 * landside between the hangar row's last hangar and the fuel farm (on the
 * hangars' centre line, where the car starts), and the point straight out
 * from it, past the airport's blend and the road keep-out, where the router
 * takes over. Null without a home airport.
 */
export interface AirportRoadHead {
  /** Start of the road: its head, world metres. */
  readonly startX: number;
  readonly startZ: number;
  /** End of the straight lead-out, beyond the keep-out. */
  readonly exitX: number;
  readonly exitZ: number;
  /** Heading along the lead-out, away from the runway, clockwise from +z (radians). */
  readonly headingRadians: number;
}

/**
 * Runway frame of the road head: `alongFraction * runwayLength +
 * alongOffset` along (the gap between the last hangar and the fuel farm), on
 * the hangar row's centre line across.
 */
export const AIRPORT_ROAD_HEAD = Object.freeze({
  alongFraction: -0.12,
  alongOffset: 95,
  /** Beyond the runway edge, metres: the hangar row's centre line (HANGAR_SITING.acrossOffsetMeters + half its depth, 118 + 17). */
  acrossOffset: 135,
  /** The lead-out runs this far past the keep-out before the router takes over. */
  exitMargin: 40,
});

export function airportRoadHead(world: WorldDefinition): AirportRoadHead | null {
  const airport = world.airport;
  if (!airport) return null;
  const along = airport.runwayLength * AIRPORT_ROAD_HEAD.alongFraction + AIRPORT_ROAD_HEAD.alongOffset;
  const across = airport.runwayWidth * 0.5 + AIRPORT_ROAD_HEAD.acrossOffset;
  const start = runwayToWorld(airport, along, across);
  // Out past the platform, its blend, the keep-out and the margin.
  const exitAcross = airport.runwayWidth * 0.5 + airport.shoulderWidth + airport.terrainBlendDistance
    + 120 + AIRPORT_ROAD_HEAD.exitMargin;
  const exit = runwayToWorld(airport, along, exitAcross);
  return Object.freeze({
    startX: start.x,
    startZ: start.z,
    exitX: exit.x,
    exitZ: exit.z,
    headingRadians: Math.atan2(exit.x - start.x, exit.z - start.z),
  });
}

/**
 * Where the access road's lead-out passes through the home field's perimeter
 * fence: straight out from the head, so at the head's `along` (runway-local)
 * on the landside run, and as wide as the sealed formation and 2 m either
 * side. Null where there are no roads (no home field, or an eroded world).
 */
export function airportRoadFenceOpening(
  world: WorldDefinition,
): { readonly along: number; readonly halfWidthMeters: number } | null {
  const airport = world.airport;
  if (!airport || world.worldEvolution === "eroded") return null;
  return Object.freeze({
    along: airport.runwayLength * AIRPORT_ROAD_HEAD.alongFraction + AIRPORT_ROAD_HEAD.alongOffset,
    halfWidthMeters: roadFormationHalfWidth(roadClass(ROAD_CLASS.airport)) + 2,
  });
}

/** The road head as a node of the network (the sealed road's first end). */
export function airportRoadNode(world: WorldDefinition): RoadNode | null {
  const head = airportRoadHead(world);
  if (!head) return null;
  return Object.freeze({
    key: "airport",
    id: roadNodeId("airport"),
    classId: ROAD_CLASS.airport,
    x: head.startX,
    z: head.startZ,
    height: roadGroundHeight(world, head.startX, head.startZ),
    fixed: true,
  });
}
