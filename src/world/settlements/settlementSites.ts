import { infrastructureNear } from "../infrastructure";
import { ROAD_CLASS } from "../roads/roadClasses";
import type { RoadBox, RoadEdge } from "../roads/roadGraph";
import type { RoadGeometry } from "../roads/roadNetwork";
import type { RoadNode } from "../roads/roadNodes";
import { RoadGround, roadAirportKeepOut, roadGroundAt, roadGroundHeight } from "../roads/roadTerrain";
import { hashCoordinates, hashSeed, mixSeed, unitFloatFromHash } from "../seed";
import type { SettlementKind, StructureStyle } from "../structures/structureRecord";
import type { WorldDefinition } from "../types";
import type { SettlementRoads } from "./settlementRoads";
import { settlementBasaltAt, settlementStyleAt, settlementStyleRule } from "./settlementStyles";

/**
 * Where settlements grow (the plan's "Where structures go"): every site is a
 * pure function of the world and the road network, found from the box it
 * lies in, so any region can find its own and its neighbours' alike.
 *
 *   hamlet      a gravel-road node with at least one built road
 *   farmstead   a track node with built roads (a ranch in the dry provinces)
 *   outpost     a track's dead end (a node with one road), in place of a farm
 *   roadside    a farm along a gravel road or track, every so often
 *   cabin       off-road, on a 1.5 km lattice, 350 m or more from any road
 *   lookout     a summit on a 4 km lattice, 50 m above a 500 m ring
 *   lighthouse  a headland on a 5 km lattice, sea on five of eight sides
 *
 * NEIGHBOURS. Two sites whose `radius`es overlap would lay buildings over
 * each other, so the one of lower `rank` (then lower key) keeps its place and
 * the other is dropped. The test reads only the sites' anchors, never their
 * layouts, so it is the same from either side of a region edge.
 */

export interface SettlementSite {
  readonly kind: SettlementKind;
  /** Unique across the world: `hamlet:<node>`, `roadside:<edge>:<n>`, `cabin:<i>:<j>`, ... */
  readonly key: string;
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly style: StructureStyle;
  readonly basalt: boolean;
  /** Who keeps its place when two sites overlap: lower first. */
  readonly rank: number;
  /** Every building and pad of the site lies within this of the anchor, metres. */
  readonly radius: number;
  /** A node site's node. */
  readonly node?: RoadNode;
  /** A roadside site's road: the spot's tangent (unit) and which side the yard lies on. */
  readonly road?: { readonly tangentX: number; readonly tangentZ: number; readonly side: 1 | -1 };
  /** A lattice site's cell. */
  readonly cell?: { readonly i: number; readonly j: number };
}

const SITE_RANK: Readonly<Record<SettlementKind, number>> = Object.freeze({
  lighthouse: 0,
  lookout: 1,
  hamlet: 2,
  outpost: 3,
  farmstead: 4,
  roadside: 5,
  cabin: 6,
});

/** How far each kind's buildings reach from its anchor, metres (the layouts keep inside it). */
export const SETTLEMENT_SITE_RADIUS: Readonly<Record<SettlementKind, number>> = Object.freeze({
  lighthouse: 70,
  lookout: 40,
  hamlet: 345,
  outpost: 125,
  farmstead: 125,
  roadside: 125,
  cabin: 35,
});

/** The largest of `SETTLEMENT_SITE_RADIUS`: how far past a box its neighbours' anchors are looked for. */
export const SETTLEMENT_SITE_RADIUS_MAX = Math.max(...Object.values(SETTLEMENT_SITE_RADIUS));

/** No settlement anchor this close to the home airport's road keep-out, metres. */
export const SETTLEMENT_AIRPORT_CLEARANCE = 600;
/** A lighthouse keeps this far beyond it: no beacon at the end of the runway. */
const LIGHTHOUSE_AIRPORT_CLEARANCE = 1_500;
/** No site comes within this of the static infrastructure (the home marina's earthworks), metres. */
const STATIC_INFRASTRUCTURE_CLEARANCE = 100;

/** Roadside farms keep this far along the road from either end node, metres (the nodes have their own). */
const ROADSIDE_END_CLEARANCE = 300;
/** No roadside spot nearer the road's start than this, metres. */
const ROADSIDE_FIRST_MIN = 350;
/** Share of roadside spots that get a farm. */
const ROADSIDE_OCCUPANCY = 0.45;

/** Lattices of the off-road sites, metres. */
export const SETTLEMENT_CABIN_SPACING = 1_500;
export const SETTLEMENT_LOOKOUT_SPACING = 4_000;
export const SETTLEMENT_LIGHTHOUSE_SPACING = 5_000;
/** A cabin keeps this far from every road's centreline, metres. */
export const SETTLEMENT_CABIN_ROAD_CLEARANCE = 350;
/** A summit stands this far above the mean of its 500 m ring, metres. */
const LOOKOUT_PROMINENCE = 50;

const CHANNEL = 0x53_54_52_00; // "STR\0"

/** A seeded value in [0, 1): one channel, three integer coordinates. */
export function settlementRandom(world: WorldDefinition, channel: number, a: number, b: number, c = 0): number {
  return unitFloatFromHash(hashCoordinates(mixSeed(world.seedHash, CHANNEL + channel), a | 0, b | 0, c | 0));
}

function site(
  world: WorldDefinition,
  kind: SettlementKind,
  key: string,
  x: number,
  z: number,
  height: number,
  extra: Partial<Pick<SettlementSite, "node" | "road" | "cell">> = {},
): SettlementSite {
  return Object.freeze({
    kind,
    key,
    id: hashSeed(key),
    x,
    z,
    style: settlementStyleAt(world, x, z, height),
    basalt: settlementBasaltAt(world, x, z),
    rank: SITE_RANK[kind],
    radius: SETTLEMENT_SITE_RADIUS[kind],
    ...extra,
  });
}

function inBox(box: RoadBox, x: number, z: number): boolean {
  return x >= box.minX && x < box.maxX && z >= box.minZ && z < box.maxZ;
}

/**
 * Whether an anchor keeps clear of the home airport, and the whole site
 * (its `radius`) of the static earthworks by `STATIC_INFRASTRUCTURE_CLEARANCE`.
 */
function anchorClear(world: WorldDefinition, kind: SettlementKind, x: number, z: number): boolean {
  const airport = kind === "lighthouse" ? LIGHTHOUSE_AIRPORT_CLEARANCE : SETTLEMENT_AIRPORT_CLEARANCE;
  return roadAirportKeepOut(world, x, z) >= airport
    && !infrastructureNear(world, x, z, SETTLEMENT_SITE_RADIUS[kind] + STATIC_INFRASTRUCTURE_CLEARANCE);
}

/**
 * Every candidate site whose anchor lies in `box` (half-open), before the
 * neighbour test, in key order. `roads` must cover the box plus the
 * cabins' road clearance.
 */
export function settlementCandidates(world: WorldDefinition, roads: SettlementRoads, box: RoadBox): SettlementSite[] {
  const found: SettlementSite[] = [];
  nodeSites(world, roads, box, found);
  roadsideSites(world, roads, box, found);
  cabinSites(world, roads, box, found);
  lookoutSites(world, box, found);
  lighthouseSites(world, box, found);
  found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return found;
}

/**
 * The sites that keep their place among `candidates` (which must hold every
 * candidate within `SETTLEMENT_SITE_RADIUS_MAX` x 2 of each one asked about):
 * of each overlapping pair, the lower rank, then the lower key.
 */
export function settlementSitesKept(
  asked: readonly SettlementSite[],
  candidates: readonly SettlementSite[],
): SettlementSite[] {
  return asked.filter((site) => !candidates.some((other) => other !== site
    && other.key !== site.key
    && (other.rank < site.rank || (other.rank === site.rank && other.key < site.key))
    && Math.hypot(other.x - site.x, other.z - site.z) < other.radius + site.radius));
}

function nodeSites(world: WorldDefinition, roads: SettlementRoads, box: RoadBox, found: SettlementSite[]): void {
  for (const node of roads.nodes) {
    if (node.fixed || !inBox(box, node.x, node.z)) continue;
    const degree = roads.edgesAt(node).filter(({ edge }) => edge.classId !== ROAD_CLASS.airport).length;
    if (degree === 0) continue;
    const style = settlementStyleAt(world, node.x, node.z, node.height);
    const rule = settlementStyleRule(style);
    const roll = settlementRandom(world, 0, node.id, 0);
    const kind: SettlementKind | null = node.classId === ROAD_CLASS.gravel
      ? (roll < rule.hamlet ? "hamlet" : null)
      : degree === 1 && roll < rule.outpost ? "outpost" : roll < rule.farmstead ? "farmstead" : null;
    if (!kind || !anchorClear(world, kind, node.x, node.z)) continue;
    found.push(site(world, kind, `${kind}:${node.key}`, node.x, node.z, node.height, { node }));
  }
}

/** One edge's roadside spots, wherever they lie: a pure function of the edge's road. */
interface RoadsideSpot {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly tangentX: number;
  readonly tangentZ: number;
  readonly side: 1 | -1;
}

const ROADSIDE_SPOTS = new WeakMap<RoadGeometry, readonly RoadsideSpot[]>();

function roadsideSpots(world: WorldDefinition, edge: RoadEdge, geometry: RoadGeometry): readonly RoadsideSpot[] {
  const memo = ROADSIDE_SPOTS.get(geometry);
  if (memo) return memo;
  const spots: RoadsideSpot[] = [];
  const total = geometry.station[geometry.station.length - 1] ?? 0;
  const first = settlementStyleRule(settlementStyleAt(world, edge.a.x, edge.a.z, edge.a.height));
  let next = Math.max(ROADSIDE_FIRST_MIN, first.roadsideSpacing * (0.3 + 0.6 * settlementRandom(world, 40, edge.id, 0)));
  let run = 0;
  let index = 0;
  for (const piece of geometry.pieces) {
    const length = Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
    run += length;
    if (run < next) continue;
    if (run > total - ROADSIDE_END_CLEARANCE) break;
    index += 1;
    const x = 0.5 * (piece.ax + piece.bx);
    const z = 0.5 * (piece.az + piece.bz);
    const rule = settlementStyleRule(settlementStyleAt(world, x, z, roadGroundHeight(world, x, z)));
    next = run + rule.roadsideSpacing * (0.6 + 0.8 * settlementRandom(world, 41, edge.id, index));
    if (settlementRandom(world, 42, edge.id, index) >= ROADSIDE_OCCUPANCY) continue;
    if (!(length > 0)) continue;
    spots.push({
      index,
      x,
      z,
      tangentX: (piece.bx - piece.ax) / length,
      tangentZ: (piece.bz - piece.az) / length,
      side: settlementRandom(world, 43, edge.id, index) < 0.5 ? 1 : -1,
    });
  }
  const frozen = Object.freeze(spots);
  ROADSIDE_SPOTS.set(geometry, frozen);
  return frozen;
}

function roadsideSites(world: WorldDefinition, roads: SettlementRoads, box: RoadBox, found: SettlementSite[]): void {
  for (const { edge, geometry } of roads.edges) {
    if (edge.classId === ROAD_CLASS.airport) continue;
    for (const spot of roadsideSpots(world, edge, geometry)) {
      if (!inBox(box, spot.x, spot.z) || !anchorClear(world, "roadside", spot.x, spot.z)) continue;
      found.push(site(world, "roadside", `roadside:${edge.key}:${spot.index}`, spot.x, spot.z, roadGroundHeight(world, spot.x, spot.z), {
        road: { tangentX: spot.tangentX, tangentZ: spot.tangentZ, side: spot.side },
      }));
    }
  }
}

function cells(box: RoadBox, spacing: number, visit: (i: number, j: number) => void): void {
  for (let j = Math.floor(box.minZ / spacing); j <= Math.floor(box.maxZ / spacing); j += 1) {
    for (let i = Math.floor(box.minX / spacing); i <= Math.floor(box.maxX / spacing); i += 1) visit(i, j);
  }
}

function cabinSites(world: WorldDefinition, roads: SettlementRoads, box: RoadBox, found: SettlementSite[]): void {
  const spacing = SETTLEMENT_CABIN_SPACING;
  cells(box, spacing, (i, j) => {
    const x = (i + 0.15 + 0.7 * settlementRandom(world, 10, i, j)) * spacing;
    const z = (j + 0.15 + 0.7 * settlementRandom(world, 11, i, j)) * spacing;
    if (!inBox(box, x, z)) return;
    const h = roadGroundHeight(world, x, z);
    if (h < world.seaLevel + 3) return;
    const style = settlementStyleAt(world, x, z, h);
    if (settlementRandom(world, 12, i, j) >= settlementStyleRule(style).cabin) return;
    if (!anchorClear(world, "cabin", x, z) || roadGroundAt(world, x, z, h) !== RoadGround.land) return;
    if (roads.nearestCentreline(x, z, SETTLEMENT_CABIN_ROAD_CLEARANCE) !== null) return;
    found.push(site(world, "cabin", `cabin:${i}:${j}`, x, z, h, { cell: { i, j } }));
  });
}

function lookoutSites(world: WorldDefinition, box: RoadBox, found: SettlementSite[]): void {
  const spacing = SETTLEMENT_LOOKOUT_SPACING;
  cells(box, spacing, (i, j) => {
    let best = -Infinity;
    let bx = 0;
    let bz = 0;
    for (let k = 0; k < 24; k += 1) {
      const x = (i + 0.1 + 0.8 * settlementRandom(world, 20, i, j, k)) * spacing;
      const z = (j + 0.1 + 0.8 * settlementRandom(world, 21, i, j, k)) * spacing;
      const h = roadGroundHeight(world, x, z);
      if (h > best) [best, bx, bz] = [h, x, z];
    }
    if (!inBox(box, bx, bz) || best < world.seaLevel + 30) return;
    let ring = 0;
    for (let a = 0; a < 8; a += 1) {
      ring += roadGroundHeight(world, bx + Math.sin((a * Math.PI) / 4) * 500, bz + Math.cos((a * Math.PI) / 4) * 500);
    }
    if (best - ring / 8 < LOOKOUT_PROMINENCE) return;
    const style = settlementStyleAt(world, bx, bz, best);
    if (settlementRandom(world, 22, i, j) >= settlementStyleRule(style).lookout) return;
    if (!anchorClear(world, "lookout", bx, bz) || roadGroundAt(world, bx, bz, best) !== RoadGround.land) return;
    found.push(site(world, "lookout", `lookout:${i}:${j}`, bx, bz, best, { cell: { i, j } }));
  });
}

function lighthouseSites(world: WorldDefinition, box: RoadBox, found: SettlementSite[]): void {
  const spacing = SETTLEMENT_LIGHTHOUSE_SPACING;
  cells(box, spacing, (i, j) => {
    let bestWet = 0;
    let bx = 0;
    let bz = 0;
    for (let k = 0; k < 32; k += 1) {
      const x = (i + settlementRandom(world, 30, i, j, k)) * spacing;
      const z = (j + settlementRandom(world, 31, i, j, k)) * spacing;
      const h = roadGroundHeight(world, x, z);
      if (h < world.seaLevel + 4) continue;
      let wet = 0;
      for (let a = 0; a < 8; a += 1) {
        const ax = x + Math.sin((a * Math.PI) / 4) * 300;
        const az = z + Math.cos((a * Math.PI) / 4) * 300;
        if (roadGroundHeight(world, ax, az) < world.seaLevel) wet += 1;
      }
      if (wet > bestWet) [bestWet, bx, bz] = [wet, x, z];
    }
    if (bestWet < 5 || !inBox(box, bx, bz)) return;
    const h = roadGroundHeight(world, bx, bz);
    const style = settlementStyleAt(world, bx, bz, h);
    if (settlementRandom(world, 32, i, j) >= settlementStyleRule(style).lighthouse) return;
    if (!anchorClear(world, "lighthouse", bx, bz) || roadGroundAt(world, bx, bz, h) !== RoadGround.land) return;
    found.push(site(world, "lighthouse", `lighthouse:${i}:${j}`, bx, bz, h, { cell: { i, j } }));
  });
}
