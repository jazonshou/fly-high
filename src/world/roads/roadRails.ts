import type { InfrastructureRail } from "../infrastructure";
import { MARINA_LAYOUT } from "../marinaLayout";
import { roadCrossOffset } from "../roadEarthworkProfiles";
import type { WorldDefinition } from "../types";
import { roadClass, roadFormationHalfWidth, ROAD_CLASS, type RoadClassId } from "./roadClasses";
import { pointSegmentDistance, type RoadBox } from "./roadGraph";
import type { RoadNetwork, RoadPiece, RoadRailKeepOuts, RoadRegion } from "./roadNetwork";
import { roadGroundHeight } from "./roadTerrain";

/**
 * The guardrails along a region's roads (`InfrastructureRegion.rails`): a
 * run wherever the formation edge stands more than `ROAD_RAIL_DROP_METERS`
 * over the ground at it or just beyond it (a deep fill, or a drop-off the
 * shoulder runs along), carried `ROAD_RAIL_LEAD_METERS` further each way.
 * Gravel and sealed roads only: a track has none.
 *
 * A rail keeps clear of every pad (a junction, a road's end, the airport's
 * road head) and the marina's car park by `ROAD_RAIL_PAD_CLEARANCE_METERS`,
 * and of any other road's formation by `ROAD_RAIL_CROSSING_CLEARANCE_METERS`
 * (a track or road crossing between nodes), whichever region or layer holds
 * them (`RoadNetwork.railKeepOuts`), so no rail stands across a way on.
 *
 * A pure function of the region and the network, as its segments are: the
 * roads worker lays the rails with them, the renderer draws them and the
 * car's colliders are built from them (`guardrailColliders`). The drop is
 * read on the ground before the earthworks (`roadGroundHeight`), the same
 * ground the batters were walked on, so it is how far the fill stands, not
 * what the stage made of it.
 *
 * Each run's points go so that, for consecutive points with direction
 * (dx, dz), the road lies on the side of n = (dz, -dx): a run on the side of
 * (dirZ, -dirX) of its edge's a -> b goes b to a, a run on the other side a
 * to b.
 */

/** A run where the edge stands more than this over the ground, metres. */
export const ROAD_RAIL_DROP_METERS = 3;
/** The beam's top over the ground, metres. */
export const ROAD_RAIL_HEIGHT_METERS = 0.75;
/** The rail's line, this far in from the formation edge, metres. */
export const ROAD_RAIL_SET_BACK_METERS = 0.3;
/** A run carries on this far past the last point that needed it, metres. */
export const ROAD_RAIL_LEAD_METERS = 8;
/** No rail within this of a pad's level core, metres: its 3 m apron and 4 more, room to turn in. */
export const ROAD_RAIL_PAD_CLEARANCE_METERS = 7;
/** No rail within this of another road's formation edge, metres. */
export const ROAD_RAIL_CROSSING_CLEARANCE_METERS = 4;
/** The marina's car park as a keep-out: a disc round its anchor of the car park's half width. */
const CAR_PARK_RADIUS = MARINA_LAYOUT.carParkHalfWidth;
/** Keep-outs are gathered this far round each run: past the widest pad's reach. */
const KEEP_OUT_REACH = 60;
/** Stations along a piece, at least this often, metres. */
const RAIL_STATION_SPACING = 6;
/** Where the drop is read: at the formation edge and this far beyond it, metres. */
const RAIL_PROBES_BEYOND = [0, 1.5, 3, 4.5];

interface Station {
  readonly x: number;
  readonly z: number;
  /** Distance along the edge's pieces from the first, metres. */
  readonly along: number;
  /** Unit direction of travel a -> b there (the mean of two pieces' at a joint). */
  readonly dirX: number;
  readonly dirZ: number;
  readonly centre: number;
  readonly cross: number;
  readonly crossfall: number;
}

export function roadRegionRails(network: RoadNetwork, region: RoadRegion): readonly InfrastructureRail[] {
  const byEdge = new Map<number, RoadPiece[]>();
  for (const piece of region.pieces) {
    if (piece.classId === ROAD_CLASS.track) continue;
    let pieces = byEdge.get(piece.edgeId);
    if (!pieces) byEdge.set(piece.edgeId, (pieces = []));
    pieces.push(piece);
  }
  const runs: RailRun[] = [];
  for (const edgeId of [...byEdge.keys()].sort((a, b) => a - b)) {
    const pieces = byEdge.get(edgeId)!.sort((a, b) => a.index - b.index);
    // A region holds an edge's pieces in runs; a gap (pieces in another region) ends a run.
    let chain: RoadPiece[] = [];
    for (const piece of pieces) {
      const last = chain[chain.length - 1];
      if (last && !(last.index + 1 === piece.index && last.bx === piece.ax && last.bz === piece.az)) {
        runsAlong(network.world, chain, runs);
        chain = [];
      }
      chain.push(piece);
    }
    if (chain.length > 0) runsAlong(network.world, chain, runs);
  }
  if (runs.length === 0) return NO_RAILS;
  const rails: InfrastructureRail[] = [];
  for (const cluster of runClusters(runs)) {
    // Asked round each cluster of runs, not the whole region, so only the roads beside a rail are built.
    const keepOuts = network.railKeepOuts(cluster.box);
    for (const run of cluster.runs) cutRun(run, keepOuts, rails);
  }
  return Object.freeze(rails);
}

/** A run's rails, appended to `out`: its points, broken wherever the keep-outs keep a point out. */
function cutRun(run: RailRun, keepOuts: RoadRailKeepOuts, out: InfrastructureRail[]): void {
  let points: number[] = [];
  const close = (): void => {
    if (points.length >= 4) out.push(railOf(points, run.side));
    points = [];
  };
  for (let i = 0; i < run.points.length; i += 2) {
    const x = run.points[i]!;
    const z = run.points[i + 1]!;
    if (keptOut(x, z, run, keepOuts)) close();
    else points.push(x, z);
  }
  close();
}

const NO_RAILS: readonly InfrastructureRail[] = Object.freeze([]);

/** A stretch of one side of one edge's chain that wants a rail, before the keep-outs cut it. */
interface RailRun {
  readonly classId: RoadClassId;
  readonly edgeId: number;
  /** 1 on (dirZ, -dirX) of the edge's a -> b, -1 on the other side. */
  readonly side: 1 | -1;
  /** The rail's line, x, z pairs from a to b. */
  readonly points: readonly number[];
}

/** The stretches along one unbroken chain of an edge's pieces that want a rail, both sides, appended to `out`. */
function runsAlong(world: WorldDefinition, chain: readonly RoadPiece[], out: RailRun[]): void {
  const { classId, edgeId } = chain[0]!;
  const spec = roadClass(classId);
  const half = roadFormationHalfWidth(spec);
  const stations = chainStations(chain);
  for (const side of [1, -1] as const) {
    const needs = stations.map((station) => {
      // `side` 1 is (dirZ, -dirX) of a -> b, the stage's positive `across`.
      const outX = side * station.dirZ;
      const outZ = -side * station.dirX;
      const edge = station.centre + roadCrossOffset(side * half, station.cross, station.crossfall);
      let lowest = Number.POSITIVE_INFINITY;
      for (const beyond of RAIL_PROBES_BEYOND) {
        lowest = Math.min(lowest, roadGroundHeight(world, station.x + outX * (half + beyond), station.z + outZ * (half + beyond)));
      }
      return edge - lowest > ROAD_RAIL_DROP_METERS;
    });
    // Carried on by the lead both ways.
    const wanted = new Array<boolean>(stations.length).fill(false);
    let last = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < stations.length; k += 1) {
      if (needs[k]) last = stations[k]!.along;
      wanted[k] = stations[k]!.along - last <= ROAD_RAIL_LEAD_METERS;
    }
    let next = Number.POSITIVE_INFINITY;
    for (let k = stations.length - 1; k >= 0; k -= 1) {
      if (needs[k]) next = stations[k]!.along;
      if (next - stations[k]!.along <= ROAD_RAIL_LEAD_METERS) wanted[k] = true;
    }
    const offset = half - ROAD_RAIL_SET_BACK_METERS;
    let points: number[] = [];
    const close = (): void => {
      if (points.length >= 4) out.push({ classId, edgeId, side, points });
      points = [];
    };
    stations.forEach((station, k) => {
      if (!wanted[k]) {
        close();
        return;
      }
      points.push(station.x + side * station.dirZ * offset, station.z - side * station.dirX * offset);
    });
    close();
  }
}

/** Whether a rail point stands too near a pad, the marina's car park or another road. */
function keptOut(x: number, z: number, run: RailRun, keepOuts: RoadRailKeepOuts): boolean {
  for (const pad of keepOuts.pads) {
    const clear = pad.radius + ROAD_RAIL_PAD_CLEARANCE_METERS;
    if ((x - pad.x) ** 2 + (z - pad.z) ** 2 < clear * clear) return true;
  }
  const carPark = keepOuts.carPark;
  if (carPark) {
    const clear = CAR_PARK_RADIUS + ROAD_RAIL_PAD_CLEARANCE_METERS;
    if ((x - carPark.x) ** 2 + (z - carPark.z) ** 2 < clear * clear) return true;
  }
  for (const piece of keepOuts.pieces) {
    if (piece.edgeId === run.edgeId && piece.classId === run.classId) continue;
    const clear = roadFormationHalfWidth(roadClass(piece.classId)) + ROAD_RAIL_CROSSING_CLEARANCE_METERS;
    if (pointSegmentDistance(x, z, piece.ax, piece.az, piece.bx, piece.bz) < clear) return true;
  }
  return false;
}

/** Runs whose boxes (grown by `KEEP_OUT_REACH`) overlap, gathered so each cluster asks for its keep-outs once. */
function runClusters(runs: readonly RailRun[]): { box: RoadBox; runs: RailRun[] }[] {
  const clusters: { box: RoadBox; runs: RailRun[] }[] = [];
  for (const run of runs) {
    let box = runBox(run, KEEP_OUT_REACH);
    let members = [run];
    // Merge every cluster this box overlaps; repeat, as a merged box can reach another.
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = clusters.length - 1; i >= 0; i -= 1) {
        const other = clusters[i]!;
        if (!boxesOverlap(box, other.box)) continue;
        box = {
          minX: Math.min(box.minX, other.box.minX),
          minZ: Math.min(box.minZ, other.box.minZ),
          maxX: Math.max(box.maxX, other.box.maxX),
          maxZ: Math.max(box.maxZ, other.box.maxZ),
        };
        members = [...other.runs, ...members];
        clusters.splice(i, 1);
        merged = true;
      }
    }
    clusters.push({ box, runs: members });
  }
  return clusters;
}

function runBox(run: RailRun, margin: number): RoadBox {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < run.points.length; i += 2) {
    minX = Math.min(minX, run.points[i]!);
    maxX = Math.max(maxX, run.points[i]!);
    minZ = Math.min(minZ, run.points[i + 1]!);
    maxZ = Math.max(maxZ, run.points[i + 1]!);
  }
  return { minX: minX - margin, minZ: minZ - margin, maxX: maxX + margin, maxZ: maxZ + margin };
}

function boxesOverlap(left: RoadBox, right: RoadBox): boolean {
  return left.minX <= right.maxX && right.minX <= left.maxX && left.minZ <= right.maxZ && right.minZ <= left.maxZ;
}

/** A rail from a run's points (a to b), in the order that puts the road on n = (dz, -dx) (see the module comment). */
function railOf(points: readonly number[], side: 1 | -1): InfrastructureRail {
  let ordered = points;
  if (side === 1) {
    const reversed: number[] = [];
    for (let i = points.length - 2; i >= 0; i -= 2) reversed.push(points[i]!, points[i + 1]!);
    ordered = reversed;
  }
  return Object.freeze({ points: Object.freeze(ordered.slice()), heightMeters: ROAD_RAIL_HEIGHT_METERS });
}

/** Stations along a chain of pieces: each piece's ends (shared at a joint) and at least every `RAIL_STATION_SPACING`. */
function chainStations(chain: readonly RoadPiece[]): Station[] {
  const stations: Station[] = [];
  let along = 0;
  chain.forEach((piece, p) => {
    const dx = piece.bx - piece.ax;
    const dz = piece.bz - piece.az;
    const length = Math.hypot(dx, dz);
    const dirX = length > 0 ? dx / length : 1;
    const dirZ = length > 0 ? dz / length : 0;
    const steps = Math.max(1, Math.ceil(length / RAIL_STATION_SPACING));
    for (let k = p === 0 ? 0 : 1; k <= steps; k += 1) {
      const t = k / steps;
      let sx = dirX;
      let sz = dirZ;
      const next = chain[p + 1];
      if (k === steps && next) {
        // At a joint, the bisector of the two pieces' directions.
        const nx = next.bx - next.ax;
        const nz = next.bz - next.az;
        const nl = Math.hypot(nx, nz);
        if (nl > 0) {
          const mx = dirX + nx / nl;
          const mz = dirZ + nz / nl;
          const ml = Math.hypot(mx, mz);
          if (ml > 1e-6) {
            sx = mx / ml;
            sz = mz / ml;
          }
        }
      }
      stations.push({
        x: piece.ax + dx * t,
        z: piece.az + dz * t,
        along: along + length * t,
        dirX: sx,
        dirZ: sz,
        centre: piece.ha + (piece.hb - piece.ha) * t,
        cross: piece.ca + (piece.cb - piece.ca) * t,
        crossfall: piece.ka + (piece.kb - piece.ka) * t,
      });
    }
    along += length;
  });
  return stations;
}
