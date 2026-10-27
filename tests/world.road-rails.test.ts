import { describe, expect, it } from "vitest";
import type { InfrastructureRail } from "@/src/world/infrastructure";
import { MARINA_LAYOUT } from "@/src/world/marinaLayout";
import { roadCrossOffset } from "@/src/world/roadEarthworkProfiles";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import { pointSegmentDistance, type RoadBox } from "@/src/world/roads/roadGraph";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import {
  RoadNetwork,
  roadRegionOf,
  type RoadPad,
  type RoadPiece,
  type RoadRailKeepOuts,
  type RoadRegion,
} from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import {
  ROAD_RAIL_CROSSING_CLEARANCE_METERS,
  ROAD_RAIL_DROP_METERS,
  ROAD_RAIL_HEIGHT_METERS,
  ROAD_RAIL_LEAD_METERS,
  ROAD_RAIL_PAD_CLEARANCE_METERS,
  ROAD_RAIL_SET_BACK_METERS,
  roadRegionRails,
} from "@/src/world/roads/roadRails";
import { roadGroundHeight } from "@/src/world/roads/roadTerrain";
import { createWorld } from "@/src/world/world";

/**
 * The roads' guardrails (`roadRails.ts`): where a region lays them, which
 * way they face, what they keep clear of, and that they are plain data the
 * renderer and the car's colliders read alike. tests/sim.car-colliders runs
 * a car into one of these rails at 80 km/h and 20 degrees.
 */

const world = createWorld();
const network = new RoadNetwork(world);
const head = airportRoadHead(world)!;
const rx0 = roadRegionOf(head.startX);
const rz0 = roadRegionOf(head.startZ);

/** The major regions round the home airport's road head that hold roads, and their rails. */
const regions: { region: RoadRegion; rails: readonly InfrastructureRail[] }[] = [];
for (let dx = -2; dx <= 2; dx += 1) {
  for (let dz = -2; dz <= 2; dz += 1) {
    const region = network.region("major", rx0 + dx, rz0 + dz);
    if (region.pieces.length > 0) regions.push({ region, rails: roadRegionRails(network, region) });
  }
}
const rails = regions.flatMap(({ rails: laid }) => laid);
const pieces = regions.flatMap(({ region }) => region.pieces).filter((piece) => piece.classId !== ROAD_CLASS.track);

/** Where the test reads the drop: at the formation edge and out to 4.5 m beyond it. */
const BEYOND = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];

interface EdgeStation {
  /** The rail's line there. */
  readonly x: number;
  readonly z: number;
  /** The formation edge's design height over the lowest ground just beyond it, metres. */
  readonly drop: number;
}

/** A piece's formation edge every metre on `side` (1 on (dirZ, -dirX) of a -> b). */
function edgeStations(piece: RoadPiece, side: 1 | -1): EdgeStation[] {
  const spec = roadClass(piece.classId);
  const half = roadFormationHalfWidth(spec);
  const length = Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
  const dirX = (piece.bx - piece.ax) / length;
  const dirZ = (piece.bz - piece.az) / length;
  const outX = side * dirZ;
  const outZ = -side * dirX;
  const stations: EdgeStation[] = [];
  const steps = Math.max(1, Math.round(length));
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const cx = piece.ax + (piece.bx - piece.ax) * t;
    const cz = piece.az + (piece.bz - piece.az) * t;
    const edge = piece.ha + (piece.hb - piece.ha) * t
      + roadCrossOffset(side * half, piece.ca + (piece.cb - piece.ca) * t, spec.crossfall);
    let lowest = Number.POSITIVE_INFINITY;
    for (const beyond of BEYOND) {
      lowest = Math.min(lowest, roadGroundHeight(world, cx + outX * (half + beyond), cz + outZ * (half + beyond)));
    }
    const offset = half - ROAD_RAIL_SET_BACK_METERS;
    stations.push({ x: cx + outX * offset, z: cz + outZ * offset, drop: edge - lowest });
  }
  return stations;
}

function railDistance(rail: InfrastructureRail, x: number, z: number): number {
  const p = rail.points;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 3 < p.length; i += 2) best = Math.min(best, pointSegmentDistance(x, z, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!));
  return best;
}

/** The keep-outs round a run of points, from the network: what the rails there must clear. */
function keepOutsRound(points: readonly number[]): RoadRailKeepOuts {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]!);
    maxX = Math.max(maxX, points[i]!);
    minZ = Math.min(minZ, points[i + 1]!);
    maxZ = Math.max(maxZ, points[i + 1]!);
  }
  return network.railKeepOuts({ minX: minX - 60, minZ: minZ - 60, maxX: maxX + 60, maxZ: maxZ + 60 });
}

/** Whether a rail point at (x, z) on `piece`'s road stands within a pad's, the car park's or another road's clearance. */
function keptOut(x: number, z: number, own: RoadPiece, keepOuts: RoadRailKeepOuts): boolean {
  if (keepOuts.pads.some((pad) => Math.hypot(x - pad.x, z - pad.z) < pad.radius + ROAD_RAIL_PAD_CLEARANCE_METERS)) return true;
  const carPark = keepOuts.carPark;
  if (carPark && Math.hypot(x - carPark.x, z - carPark.z) < MARINA_LAYOUT.carParkHalfWidth + ROAD_RAIL_PAD_CLEARANCE_METERS) return true;
  return keepOuts.pieces.some((other) =>
    (other.edgeId !== own.edgeId || other.classId !== own.classId)
    && pointSegmentDistance(x, z, other.ax, other.az, other.bx, other.bz)
      < roadFormationHalfWidth(roadClass(other.classId)) + ROAD_RAIL_CROSSING_CLEARANCE_METERS);
}

/** The road piece nearest a point, of the gravel and sealed roads round the head. */
function nearestPiece(x: number, z: number): { piece: RoadPiece; distance: number } {
  let best = { piece: pieces[0]!, distance: Number.POSITIVE_INFINITY };
  for (const piece of pieces) {
    const distance = pointSegmentDistance(x, z, piece.ax, piece.az, piece.bx, piece.bz);
    if (distance < best.distance) best = { piece, distance };
  }
  return best;
}

describe("the roads' guardrails", () => {
  it("are plain, frozen data: even runs of finite points, at least two, at the beam's height, the same however laid", () => {
    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      expect(rail.points.length % 2).toBe(0);
      expect(rail.points.length).toBeGreaterThanOrEqual(4);
      expect(rail.points.every(Number.isFinite)).toBe(true);
      expect(rail.heightMeters).toBe(ROAD_RAIL_HEIGHT_METERS);
      expect(Object.isFrozen(rail) && Object.isFrozen(rail.points)).toBe(true);
    }
    expect(structuredClone(rails)).toEqual(rails);
    // A fresh network, its regions asked for in the other order: the same rails.
    const fresh = new RoadNetwork(world);
    for (const { region, rails: laid } of [...regions].reverse()) {
      if (laid.length === 0) continue;
      expect(roadRegionRails(fresh, fresh.region("major", region.rx, region.rz))).toEqual(laid);
    }
    // The stage's region carries them; a region with none carries no field.
    for (const { region, rails: laid } of regions) {
      const infrastructure = roadRegionInfrastructure(network, region);
      if (laid.length > 0) expect(infrastructure.rails).toEqual(laid);
      else expect("rails" in infrastructure).toBe(false);
    }
  });

  it("face the road: n = (dz, -dx) points at it, the line just in from the formation edge", () => {
    for (const rail of rails) {
      const p = rail.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2]! - p[i]!;
        const dz = p[i + 3]! - p[i + 1]!;
        const length = Math.hypot(dx, dz);
        const nx = dz / length;
        const nz = -dx / length;
        const mx = 0.5 * (p[i]! + p[i + 2]!);
        const mz = 0.5 * (p[i + 1]! + p[i + 3]!);
        const { piece, distance } = nearestPiece(mx, mz);
        const offset = roadFormationHalfWidth(roadClass(piece.classId)) - ROAD_RAIL_SET_BACK_METERS;
        expect(Math.abs(distance - offset)).toBeLessThan(0.3);
        // A metre along n is a metre nearer the centreline; a metre against it, a metre further.
        const toward = pointSegmentDistance(mx + nx, mz + nz, piece.ax, piece.az, piece.bx, piece.bz);
        const away = pointSegmentDistance(mx - nx, mz - nz, piece.ax, piece.az, piece.bx, piece.bz);
        expect(toward).toBeLessThan(distance - 0.8);
        expect(away).toBeGreaterThan(distance + 0.8);
      }
    }
  });

  it("run along every stretch whose edge drops over 3 m, and only near one, clear of pads and other roads", () => {
    const deep: EdgeStation[] = [];
    const near: EdgeStation[] = [];
    let covered = 0;
    for (const piece of pieces) {
      let keepOuts: RoadRailKeepOuts | undefined;
      for (const side of [1, -1] as const) {
        for (const station of edgeStations(piece, side)) {
          if (station.drop > ROAD_RAIL_DROP_METERS - 0.25) near.push(station);
          // Clear of the threshold, so a 6 m station spacing cannot miss it.
          if (station.drop <= ROAD_RAIL_DROP_METERS + 0.5) continue;
          deep.push(station);
          keepOuts ??= keepOutsRound([piece.ax, piece.az, piece.bx, piece.bz]);
          if (keptOut(station.x, station.z, piece, keepOuts)) continue;
          expect(Math.min(...rails.map((rail) => railDistance(rail, station.x, station.z)))).toBeLessThan(0.6);
          covered += 1;
        }
      }
    }
    expect(deep.length).toBeGreaterThan(0);
    expect(covered).toBeGreaterThan(0);
    for (const rail of rails) {
      const keepOuts = keepOutsRound(rail.points);
      for (let i = 0; i < rail.points.length; i += 2) {
        const x = rail.points[i]!;
        const z = rail.points[i + 1]!;
        // Within the lead and a station's spacing of a drop on this rail's own line.
        const reason = near.some((station) =>
          Math.hypot(station.x - x, station.z - z) < ROAD_RAIL_LEAD_METERS + 6.5 && railDistance(rail, station.x, station.z) < 0.8);
        expect(reason).toBe(true);
        expect(keptOut(x, z, nearestPiece(x, z).piece, keepOuts)).toBe(false);
      }
    }
  });

  it("are never laid along a track", () => {
    const tracks = network.region("track", rx0, rz0);
    expect(tracks.pieces.length).toBeGreaterThan(0);
    expect(roadRegionRails(network, tracks)).toEqual([]);
    expect("rails" in roadRegionInfrastructure(network, tracks)).toBe(false);
  });
});

describe("the guardrails on a deep fill", () => {
  // A straight gravel road along +x, 10 m over the ground, in ten 12 m pieces.
  const x0 = head.startX + 3_000;
  const z0 = head.startZ + 3_000;
  const gravel = roadClass(ROAD_CLASS.gravel);
  const half = roadFormationHalfWidth(gravel);
  const chain: RoadPiece[] = [];
  for (let index = 0; index < 10; index += 1) {
    const ax = x0 + 12 * index;
    const bx = ax + 12;
    chain.push({
      classId: ROAD_CLASS.gravel,
      edgeId: 7,
      index,
      ax,
      az: z0,
      bx,
      bz: z0,
      ha: roadGroundHeight(world, ax, z0) + 10,
      hb: roadGroundHeight(world, bx, z0) + 10,
      ca: 0,
      cb: 0,
    });
  }
  const region: RoadRegion = { layer: "major", rx: roadRegionOf(x0), rz: roadRegionOf(z0), pieces: chain, pads: [] };
  /** A network that answers only for its keep-outs. */
  function stub(keepOuts: RoadRailKeepOuts, boxes: RoadBox[] = []): RoadNetwork {
    return {
      world,
      railKeepOuts: (box: RoadBox) => {
        boxes.push(box);
        return keepOuts;
      },
    } as unknown as RoadNetwork;
  }
  const none: RoadRailKeepOuts = { pads: [], pieces: [], carPark: null };

  it("runs the whole fill on both sides, its points ordered so the road is on n = (dz, -dx)", () => {
    const boxes: RoadBox[] = [];
    const laid = roadRegionRails(stub(none, boxes), region);
    expect(laid.length).toBe(2);
    // One query for the region, round every rail.
    expect(boxes.length).toBe(1);
    for (const rail of laid) {
      const p = rail.points;
      const zs = new Set<number>();
      for (let i = 0; i < p.length; i += 2) {
        expect(p[i]! >= boxes[0]!.minX && p[i]! <= boxes[0]!.maxX && p[i + 1]! >= boxes[0]!.minZ && p[i + 1]! <= boxes[0]!.maxZ).toBe(true);
        zs.add(Math.round(p[i + 1]! * 1e6));
      }
      // Straight, end to end.
      expect(zs.size).toBe(1);
      expect(Math.min(p[0]!, p[p.length - 2]!)).toBeCloseTo(x0, 9);
      expect(Math.max(p[0]!, p[p.length - 2]!)).toBeCloseTo(x0 + 120, 9);
      const z = p[1]!;
      expect(Math.abs(z - z0)).toBeCloseTo(half - ROAD_RAIL_SET_BACK_METERS, 9);
      // n = (dz, -dx) of its first step points from the rail at the centreline.
      const dx = p[2]! - p[0]!;
      const dz = p[3]! - p[1]!;
      const nz = -dx / Math.hypot(dx, dz);
      expect(Math.sign(nz)).toBe(Math.sign(z0 - z));
    }
  });

  it("stops short of a pad and of a road crossing it, and lays nothing where nothing is wanted", () => {
    const pad: RoadPad = { classId: ROAD_CLASS.gravel, nodeId: 1, x: x0 + 30, z: z0, height: 0, radius: 6 };
    // A track crossing at x0 + 90, square to it.
    const crossing: RoadPiece = { ...chain[0]!, classId: ROAD_CLASS.track, edgeId: 9, ax: x0 + 90, az: z0 - 30, bx: x0 + 90, bz: z0 + 30 };
    const laid = roadRegionRails(stub({ pads: [pad], pieces: [...chain, crossing], carPark: null }), region);
    const trackClear = roadFormationHalfWidth(roadClass(ROAD_CLASS.track)) + ROAD_RAIL_CROSSING_CLEARANCE_METERS;
    const padClear = pad.radius + ROAD_RAIL_PAD_CLEARANCE_METERS;
    let points = 0;
    for (const rail of laid) {
      for (let i = 0; i < rail.points.length; i += 2) {
        const x = rail.points[i]!;
        const z = rail.points[i + 1]!;
        expect(Math.hypot(x - pad.x, z - pad.z)).toBeGreaterThanOrEqual(padClear);
        expect(Math.abs(x - crossing.ax)).toBeGreaterThanOrEqual(trackClear);
        points += 1;
      }
    }
    // Each side: before the pad, between it and the crossing, after it.
    expect(laid.length).toBe(6);
    expect(points).toBeGreaterThan(20);
    // The road's own pieces never keep it out.
    expect(roadRegionRails(stub({ pads: [], pieces: chain, carPark: null }), region).length).toBe(2);
    // In a deep cutting: no rail, and no keep-out query.
    const boxes: RoadBox[] = [];
    const cutting: RoadRegion = { ...region, pieces: chain.map((piece) => ({ ...piece, ha: piece.ha - 30, hb: piece.hb - 30 })) };
    expect(roadRegionRails(stub(none, boxes), cutting)).toEqual([]);
    expect(boxes.length).toBe(0);
  });
});
