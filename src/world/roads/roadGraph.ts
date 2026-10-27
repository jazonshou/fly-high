import { hashSeed } from "../seed";
import type { WorldDefinition } from "../types";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth, type RoadClassId } from "./roadClasses";
import { latticeRoadNode, marinaRoadNode, roadLatticeCell, type RoadNode } from "./roadNodes";
import { roadRouteDeviationLimit } from "./roadRouting";
import { roadGroundHeight } from "./roadTerrain";

/**
 * The network's graph: a relative neighbourhood graph over each class's
 * nodes, with a maximum edge length, pruned of edges too steep for the class
 * or mostly over the sea.
 *
 * An edge p-q of a relative neighbourhood graph exists unless some third node
 * is nearer both p and q than they are to each other; the witness lies within
 * |pq| of both, so whether an edge exists depends on nodes within one edge
 * length of its ends and nothing further. That is what lets a region be
 * generated alone: `roadEdgesNear` gathers nodes far enough round the box
 * and gets exactly the edges the whole plane's graph has there.
 *
 * Gravel roads join gravel nodes (the marina car park among them). Tracks
 * join track nodes and gravel nodes, so every track leads to a gravel road.
 * The sealed airport road is one edge, from the airport's road head to the
 * nearest gravel node a route reaches (`roadNetwork.ts`).
 */

export interface RoadEdge {
  /** `${class}|${a.key}|${b.key}`, with a.key < b.key. */
  readonly key: string;
  /** 32-bit hash of the key: the edge's id in piece order keys. */
  readonly id: number;
  readonly classId: RoadClassId;
  readonly a: RoadNode;
  readonly b: RoadNode;
  /** Straight distance between the nodes, metres. */
  readonly length: number;
  /** Half width of the band round the straight line a route may use, metres. */
  readonly corridor: number;
}

/** Corridor half width: a fifth of the edge, at least four coarse cells, at most the class's cap. */
const CORRIDOR_FRACTION = 0.2;
const CORRIDOR_MAX: Readonly<Record<RoadClassId, number>> = Object.freeze({
  [ROAD_CLASS.track]: 450,
  [ROAD_CLASS.gravel]: 1_200,
  [ROAD_CLASS.airport]: 1_200,
});

/** A straight line more than this share over the sea is no road. */
const MAX_SEA_SHARE = 0.35;
const SEA_PROBE_METERS = 100;

export function roadEdgeCorridor(classId: RoadClassId, length: number): number {
  const spec = roadClass(classId);
  const coarse = spec.routingGrid * spec.coarseFactor;
  return Math.min(CORRIDOR_MAX[classId], Math.max(4 * coarse, CORRIDOR_FRACTION * length));
}

/**
 * How far from its straight segment any part of an edge's road can lie: the
 * route's own bound (`roadRouteDeviationLimit`), then the formation and its
 * batters' reach. Every
 * consumer that must keep clear of a road it has not routed (a spawned
 * airport's veto) uses this bound; tests hold every route inside it.
 */
export function roadEdgeReachBound(edge: RoadEdge): number {
  const spec = roadClass(edge.classId);
  return roadRouteDeviationBound(edge) + roadFormationHalfWidth(spec) + spec.reach;
}

/** How far the centreline of a routed edge can stray from its straight segment, metres. */
export function roadRouteDeviationBound(edge: RoadEdge): number {
  return roadRouteDeviationLimit(roadClass(edge.classId), edge.length, edge.corridor);
}

export function makeRoadEdge(classId: RoadClassId, p: RoadNode, q: RoadNode): RoadEdge {
  const [a, b] = p.key < q.key ? [p, q] : [q, p];
  const key = `${classId}|${a.key}|${b.key}`;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return Object.freeze({
    key,
    id: hashSeed(key),
    classId,
    a,
    b,
    length,
    corridor: roadEdgeCorridor(classId, length),
  });
}

export interface RoadBox {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export function expandRoadBox(box: RoadBox, margin: number): RoadBox {
  return { minX: box.minX - margin, minZ: box.minZ - margin, maxX: box.maxX + margin, maxZ: box.maxZ + margin };
}

/** Distance from a point to the straight segment a-b. */
export function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Distance from a segment to a box (0 if they touch). */
export function segmentBoxDistance(ax: number, az: number, bx: number, bz: number, box: RoadBox): number {
  const inside = (x: number, z: number) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
  if (inside(ax, az) || inside(bx, bz)) return 0;
  // Crossing any box edge?
  const corners: readonly (readonly [number, number])[] = [
    [box.minX, box.minZ], [box.maxX, box.minZ], [box.maxX, box.maxZ], [box.minX, box.maxZ],
  ];
  for (let k = 0; k < 4; k += 1) {
    const [cx, cz] = corners[k]!;
    const [dx, dz] = corners[(k + 1) % 4]!;
    if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const [cx, cz] of corners) best = Math.min(best, pointSegmentDistance(cx, cz, ax, az, bx, bz));
  const clampX = (x: number) => Math.min(box.maxX, Math.max(box.minX, x));
  const clampZ = (z: number) => Math.min(box.maxZ, Math.max(box.minZ, z));
  best = Math.min(best, Math.hypot(ax - clampX(ax), az - clampZ(az)), Math.hypot(bx - clampX(bx), bz - clampZ(bz)));
  return best;
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

export function segmentsIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = orient(cx, cz, dx, dz, ax, az);
  const d2 = orient(cx, cz, dx, dz, bx, bz);
  const d3 = orient(ax, az, bx, bz, cx, cz);
  const d4 = orient(ax, az, bx, bz, dx, dz);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Memoised lattice nodes for one world identity. */
export class RoadNodeCache {
  private readonly cells = new Map<string, RoadNode | null>();

  constructor(private readonly world: WorldDefinition) {}

  latticeNode(classId: RoadClassId, i: number, j: number): RoadNode | null {
    const key = `${classId}:${i}:${j}`;
    if (this.cells.has(key)) return this.cells.get(key)!;
    const node = latticeRoadNode(this.world, classId, i, j);
    this.cells.set(key, node);
    return node;
  }

  /** Every node of a class's lattice in the box, in a fixed (cell) order; gravel adds the marina. */
  nodesInBox(classId: RoadClassId, box: RoadBox): RoadNode[] {
    const spacing = roadClass(classId).nodeSpacing;
    const nodes: RoadNode[] = [];
    if (spacing > 0) {
      const i0 = roadLatticeCell(box.minX, spacing);
      const i1 = roadLatticeCell(box.maxX, spacing);
      const j0 = roadLatticeCell(box.minZ, spacing);
      const j1 = roadLatticeCell(box.maxZ, spacing);
      for (let j = j0; j <= j1; j += 1) {
        for (let i = i0; i <= i1; i += 1) {
          const node = this.latticeNode(classId, i, j);
          if (node && node.x >= box.minX && node.x <= box.maxX && node.z >= box.minZ && node.z <= box.maxZ) {
            nodes.push(node);
          }
        }
      }
    }
    if (classId === ROAD_CLASS.gravel) {
      const marina = marinaRoadNode(this.world);
      if (marina && marina.x >= box.minX && marina.x <= box.maxX && marina.z >= box.minZ && marina.z <= box.maxZ) {
        nodes.push(marina);
      }
    }
    return nodes;
  }

  /** The nodes a class's graph is built over: tracks join gravel nodes too. */
  graphNodesInBox(classId: RoadClassId, box: RoadBox): RoadNode[] {
    const own = this.nodesInBox(classId, box);
    return classId === ROAD_CLASS.track ? own.concat(this.nodesInBox(ROAD_CLASS.gravel, box)) : own;
  }
}

/** Whether a straight edge is buildable at all: not too steep on average, not mostly sea. */
function edgeBuildable(world: WorldDefinition, classId: RoadClassId, p: RoadNode, q: RoadNode, length: number): boolean {
  const spec = roadClass(classId);
  if (Math.abs(q.height - p.height) > spec.maxGrade * length) return false;
  const probes = Math.max(2, Math.ceil(length / SEA_PROBE_METERS));
  let wet = 0;
  for (let k = 1; k < probes; k += 1) {
    const t = k / probes;
    const h = roadGroundHeight(world, p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
    if (h < world.seaLevel + 1) wet += 1;
  }
  return wet <= MAX_SEA_SHARE * (probes - 1);
}

/**
 * Every edge of a class's graph that can reach the box: an edge whose road,
 * anywhere along it, could come within `margin` of the box. In a fixed order
 * (by key), whatever the box.
 */
export function roadEdgesNear(
  world: WorldDefinition,
  cache: RoadNodeCache,
  classId: RoadClassId,
  box: RoadBox,
  margin = 0,
): RoadEdge[] {
  const spec = roadClass(classId);
  const maxEdge = spec.maxEdgeLength;
  // The widest any edge's road reaches from its straight segment.
  const reachBound = roadRouteDeviationLimit(spec, maxEdge, CORRIDOR_MAX[classId])
    + roadFormationHalfWidth(spec) + spec.reach + margin;
  const endpointBox = expandRoadBox(box, maxEdge + reachBound);
  const witnessBox = expandRoadBox(endpointBox, maxEdge);
  const witnesses = cache.graphNodesInBox(classId, witnessBox);
  const endpoints = witnesses.filter((node) =>
    node.x >= endpointBox.minX && node.x <= endpointBox.maxX && node.z >= endpointBox.minZ && node.z <= endpointBox.maxZ);
  const edges: RoadEdge[] = [];
  for (let s = 0; s < endpoints.length; s += 1) {
    const p = endpoints[s]!;
    for (const q of witnesses) {
      if (q === p) continue;
      // Each pair once: from the endpoint with the smaller key, or from the
      // only one of the two inside the endpoint box.
      const qIsEndpoint = q.x >= endpointBox.minX && q.x <= endpointBox.maxX
        && q.z >= endpointBox.minZ && q.z <= endpointBox.maxZ;
      if (qIsEndpoint && q.key < p.key) continue;
      // A gravel-gravel pair is a gravel road, not a track.
      if (classId === ROAD_CLASS.track && p.classId !== ROAD_CLASS.track && q.classId !== ROAD_CLASS.track) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (!(d > 0) || d > maxEdge) continue;
      let witnessed = false;
      for (const r of witnesses) {
        if (r === p || r === q) continue;
        if (Math.hypot(r.x - p.x, r.z - p.z) < d && Math.hypot(r.x - q.x, r.z - q.z) < d) {
          witnessed = true;
          break;
        }
      }
      if (witnessed) continue;
      const edge = makeRoadEdge(classId, p, q);
      const reach = roadEdgeReachBound(edge) + margin;
      if (segmentBoxDistance(p.x, p.z, q.x, q.z, box) > reach) continue;
      if (!edgeBuildable(world, classId, p, q, d)) continue;
      edges.push(edge);
    }
  }
  edges.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return edges;
}
