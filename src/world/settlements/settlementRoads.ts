import { ROAD_CLASS, ROAD_CLASSES, roadClass, roadFormationHalfWidth, type RoadClassId } from "../roads/roadClasses";
import { expandRoadBox, pointSegmentDistance, type RoadBox, type RoadEdge } from "../roads/roadGraph";
import type { RoadGeometry, RoadNetwork, RoadPiece } from "../roads/roadNetwork";
import { ROAD_PAD_APRON_METERS, ROAD_TURN_PAD_MAX_RADIUS } from "../roads/roadNetwork";
import { roadPieceReach } from "../roads/roadInfrastructure";
import type { RoadNode } from "../roads/roadNodes";

/**
 * The roads round a settlement, as its layout reads them: every built road
 * of every class that can reach a box, the pieces binned for "how far is the
 * nearest formation edge", and each node's junction-pad disc. Built from the
 * network's memoised edges, so it is a pure function of (world, box): the
 * same whichever region asks.
 */

/** A junction pad never reaches past this from its node, metres (the largest turn pad plus its apron). */
export const SETTLEMENT_PAD_DISC_METERS = ROAD_TURN_PAD_MAX_RADIUS + ROAD_PAD_APRON_METERS;

const BIN_METERS = 64;
/** A formation farther than this from a point reads as "far" (the clearance answers clamp to it). */
export const SETTLEMENT_ROAD_FAR_METERS = 60;

export interface SettlementRoadEdge {
  readonly edge: RoadEdge;
  readonly geometry: RoadGeometry;
}

export class SettlementRoads {
  /** Built edges reaching the box, in key order per class (track, gravel, airport). */
  readonly edges: readonly SettlementRoadEdge[];
  /** Lattice nodes (gravel and track) in the box. */
  readonly nodes: readonly RoadNode[];
  private readonly bins = new Map<number, RoadPiece[]>();

  constructor(readonly network: RoadNetwork, readonly box: RoadBox) {
    const edges: SettlementRoadEdge[] = [];
    for (const spec of ROAD_CLASSES) {
      for (const edge of network.edgesNear(spec.id, box)) {
        const geometry = network.geometry(edge);
        if (geometry) edges.push({ edge, geometry });
      }
    }
    this.edges = edges;
    for (const { geometry } of edges) {
      for (const piece of geometry.pieces) this.bin(piece);
    }
    const nodes: RoadNode[] = [];
    for (const classId of [ROAD_CLASS.gravel, ROAD_CLASS.track] as const) {
      nodes.push(...network.nodes.nodesInBox(classId, expandRoadBox(box, SETTLEMENT_PAD_DISC_METERS)));
    }
    this.nodes = nodes;
  }

  /**
   * Metres from (x, z) to the nearest formation edge (negative on a
   * formation), or to the nearest node's pad disc, whichever is nearer;
   * `SETTLEMENT_ROAD_FAR_METERS` when nothing is that close.
   */
  clearance(x: number, z: number): number {
    let best = SETTLEMENT_ROAD_FAR_METERS;
    const list = this.bins.get(binKey(Math.floor(x / BIN_METERS), Math.floor(z / BIN_METERS)));
    if (list) {
      for (const piece of list) {
        const d = pointSegmentDistance(x, z, piece.ax, piece.az, piece.bx, piece.bz)
          - roadFormationHalfWidth(roadClass(piece.classId));
        if (d < best) best = d;
      }
    }
    for (const node of this.nodes) {
      const d = Math.hypot(x - node.x, z - node.z) - SETTLEMENT_PAD_DISC_METERS;
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Metres from (x, z) to the nearest road's earthworks: a formation's
   * batters (its stage segment's reach past the edge) or a node's pad disc
   * and its class's reach; `SETTLEMENT_ROAD_FAR_METERS` less the farthest
   * reach when nothing is that close. Ground beyond it is the ground before
   * earthworks, whatever the roads do.
   */
  earthworksClearance(x: number, z: number): number {
    let best = SETTLEMENT_ROAD_FAR_METERS - ROAD_REACH_MAX;
    const list = this.bins.get(binKey(Math.floor(x / BIN_METERS), Math.floor(z / BIN_METERS)));
    if (list) {
      for (const piece of list) {
        const d = pointSegmentDistance(x, z, piece.ax, piece.az, piece.bx, piece.bz)
          - roadFormationHalfWidth(roadClass(piece.classId)) - this.reach(piece);
        if (d < best) best = d;
      }
    }
    for (const node of this.nodes) {
      const d = Math.hypot(x - node.x, z - node.z) - SETTLEMENT_PAD_DISC_METERS - roadClass(node.classId).reach;
      if (d < best) best = d;
    }
    return best;
  }

  /** The nearest point on any formation's centreline within `limit` metres, or null. */
  nearestCentreline(
    x: number,
    z: number,
    limit: number,
    classes?: readonly RoadClassId[],
  ): { x: number; z: number; distance: number; classId: RoadClassId } | null {
    let best: { x: number; z: number; distance: number; classId: RoadClassId } | null = null;
    for (const { edge, geometry } of this.edges) {
      if (classes && !classes.includes(edge.classId)) continue;
      for (const piece of geometry.pieces) {
        const dx = piece.bx - piece.ax;
        const dz = piece.bz - piece.az;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared > 0
          ? Math.min(1, Math.max(0, ((x - piece.ax) * dx + (z - piece.az) * dz) / lengthSquared))
          : 0;
        const px = piece.ax + dx * t;
        const pz = piece.az + dz * t;
        const distance = Math.hypot(x - px, z - pz);
        if (distance <= limit && (!best || distance < best.distance)) best = { x: px, z: pz, distance, classId: edge.classId };
      }
    }
    return best;
  }

  /** Built edges with an end at the node. */
  edgesAt(node: RoadNode): readonly SettlementRoadEdge[] {
    return this.edges.filter(({ edge }) => edge.a.key === node.key || edge.b.key === node.key);
  }

  private reach(piece: RoadPiece): number {
    let reach = PIECE_REACH.get(piece);
    if (reach === undefined) {
      reach = roadPieceReach(this.network.world, piece);
      PIECE_REACH.set(piece, reach);
    }
    return reach;
  }

  private bin(piece: RoadPiece): void {
    const reach = roadFormationHalfWidth(roadClass(piece.classId)) + SETTLEMENT_ROAD_FAR_METERS;
    const x0 = Math.floor((Math.min(piece.ax, piece.bx) - reach) / BIN_METERS);
    const x1 = Math.floor((Math.max(piece.ax, piece.bx) + reach) / BIN_METERS);
    const z0 = Math.floor((Math.min(piece.az, piece.bz) - reach) / BIN_METERS);
    const z1 = Math.floor((Math.max(piece.az, piece.bz) + reach) / BIN_METERS);
    for (let bx = x0; bx <= x1; bx += 1) {
      for (let bz = z0; bz <= z1; bz += 1) {
        const key = binKey(bx, bz);
        const list = this.bins.get(key);
        if (list) list.push(piece);
        else this.bins.set(key, [piece]);
      }
    }
  }
}

/** The farthest any road's batters reach past its formation, metres. */
const ROAD_REACH_MAX = Math.max(...ROAD_CLASSES.map((spec) => spec.reach));

/** Each piece's batters' reach, as its stage segment has it (a piece belongs to one world). */
const PIECE_REACH = new WeakMap<RoadPiece, number>();

function binKey(bx: number, bz: number): number {
  return (bx + (1 << 20)) * (1 << 21) + (bz + (1 << 20));
}
