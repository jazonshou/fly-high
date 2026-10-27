import { describe, expect, it } from "vitest";
import {
  ROAD_RAIL_SHAPE,
  ROAD_RIBBON_CHUNK_METERS,
  ROAD_RIBBON_FRINGE_METERS,
  ROAD_RIBBON_PAD_KIND,
  ROAD_RIBBON_STATION_FLOATS,
  ROAD_RIBBON_STATION_METERS,
  RoadSurfaceArrayBuilder,
  appendRoadPad,
  appendRoadRail,
  appendRoadRibbonSpan,
  roadRailLength,
  roadRibbonChunkKey,
  roadRibbonChunkOf,
  roadRibbonColumns,
  roadRibbonEdgeKey,
  roadRibbonRuns,
  roadRibbonSpansByChunk,
  roadRibbonStation,
  RoadRibbonCut,
  type RoadRibbonRun,
  type RoadRibbonSpan,
  type RoadRibbonStation,
  type RoadSurfaceArrays,
} from "@/src/render/webgpu/roads/roadSurfaceGeometry";
import { buildTerrainNodeGrid } from "@/src/render/webgpu/terrain/TerrainQuadtree";
import type { InfrastructureRail } from "@/src/world/infrastructure";
import { ROAD_CLASS, roadClass, roadFormationHalfWidth } from "@/src/world/roads/roadClasses";
import { RoadNetwork, roadRegionOf, type RoadPad, type RoadPiece } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { roadRegionRails } from "@/src/world/roads/roadRails";
import { createWorld } from "@/src/world/world";

/**
 * The roads' drawn surfaces as arrays (`roadSurfaceGeometry.ts`), on the
 * real network round the home airport's road head: the ribbons chain each
 * road across regions and keep its width through every joint, their chunks
 * hold every segment once, and every face, ribbon, pad or rail, is wound to
 * look the way its normal does (the terrain grid's own winding is the
 * reference, so a front face is what the renderer keeps).
 */

const world = createWorld();
const network = new RoadNetwork(world);
const head = airportRoadHead(world)!;
const rx0 = roadRegionOf(head.startX);
const rz0 = roadRegionOf(head.startZ);

const pieces: RoadPiece[] = [];
const pads: RoadPad[] = [];
const rails: InfrastructureRail[] = [];
const piecesPerEdgeRegions = new Map<string, Set<string>>();
for (const layer of ["major", "track"] as const) {
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const region = network.region(layer, rx0 + dx, rz0 + dz);
      pieces.push(...region.pieces);
      pads.push(...region.pads);
      for (const piece of region.pieces) {
        const key = roadRibbonEdgeKey(piece);
        const regions = piecesPerEdgeRegions.get(key) ?? new Set<string>();
        regions.add(`${layer}:${dx}:${dz}`);
        piecesPerEdgeRegions.set(key, regions);
      }
      if (layer === "major" && region.pieces.length > 0) rails.push(...roadRegionRails(network, region));
    }
  }
}
const byEdge = new Map<string, RoadPiece[]>();
for (const piece of pieces) {
  const key = roadRibbonEdgeKey(piece);
  const list = byEdge.get(key) ?? [];
  list.push(piece);
  byEdge.set(key, list);
}
const runs: RoadRibbonRun[] = [...byEdge.entries()].flatMap(([key, list]) => roadRibbonRuns(key, list));

function stationsOf(run: RoadRibbonRun): RoadRibbonStation[] {
  return Array.from({ length: run.stationCount }, (_, index) => roadRibbonStation(run, index));
}

/**
 * Front faces as the terrain draws them: its grid's first triangle looks up,
 * and the sign of (b - a) x (c - a) along its normal is the reference.
 */
const FRONT = (() => {
  const grid = buildTerrainNodeGrid();
  const positions = grid.positions!;
  const indices = grid.indices!;
  const at = (index: number) => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!] as const;
  return Math.sign(windingAlong(at(indices[0]!), at(indices[1]!), at(indices[2]!), [0, 1, 0]));
})();

function windingAlong(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  normal: readonly [number, number, number],
): number {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    e1[1]! * e2[2]! - e1[2]! * e2[1]!,
    e1[2]! * e2[0]! - e1[0]! * e2[2]!,
    e1[0]! * e2[1]! - e1[1]! * e2[0]!,
  ];
  return cross[0]! * normal[0] + cross[1]! * normal[1] + cross[2]! * normal[2];
}

/** Faces wound against their own vertices' normals (degenerate ones aside). */
function wrongWay(arrays: RoadSurfaceArrays): number {
  let wrong = 0;
  const p = (index: number) => [arrays.positions[index * 3]!, arrays.positions[index * 3 + 1]!, arrays.positions[index * 3 + 2]!] as const;
  const n = (index: number) => [arrays.normals[index * 3]!, arrays.normals[index * 3 + 1]!, arrays.normals[index * 3 + 2]!] as const;
  for (let index = 0; index < arrays.indices.length; index += 3) {
    const a = arrays.indices[index]!;
    const b = arrays.indices[index + 1]!;
    const c = arrays.indices[index + 2]!;
    const winding = windingAlong(p(a), p(b), p(c), n(a));
    if (Math.abs(winding) < 1e-9) continue;
    if (Math.sign(winding) !== FRONT) wrong += 1;
  }
  return wrong;
}

describe("the roads' ribbon geometry", () => {
  it("has roads of all three classes to sweep, some crossing regions", () => {
    const classes = new Set(runs.map((run) => run.classId));
    expect(classes).toEqual(new Set([ROAD_CLASS.track, ROAD_CLASS.gravel, ROAD_CLASS.airport]));
    expect([...piecesPerEdgeRegions.values()].some((regions) => regions.size >= 2)).toBe(true);
    expect(FRONT).not.toBe(0);
  });

  it("chains each road through its regions: every piece's ends are stations, one run per contiguous stretch", () => {
    for (const [key, list] of byEdge) {
      const edgeRuns = runs.filter((run) => run.edgeKey === key);
      const sorted = [...list].sort((first, second) => first.index - second.index);
      let breaks = 1;
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index]!.index !== sorted[index - 1]!.index + 1) breaks += 1;
      }
      expect(edgeRuns.length).toBe(breaks);
      for (const piece of list) {
        for (const [x, z] of [[piece.ax, piece.az], [piece.bx, piece.bz]] as const) {
          const found = edgeRuns.some((run) => stationsOf(run).some((station) => Math.hypot(station.x - x, station.z - z) < 1e-6));
          expect(found).toBe(true);
        }
      }
    }
  });

  it("keeps stations at most 4 m apart, and the full width through every joint", () => {
    let joints = 0;
    for (const run of runs) {
      const half = roadFormationHalfWidth(roadClass(run.classId)) + ROAD_RIBBON_FRINGE_METERS;
      const stations = stationsOf(run);
      for (let index = 0; index + 1 < stations.length; index += 1) {
        const a = stations[index]!;
        const b = stations[index + 1]!;
        expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(ROAD_RIBBON_STATION_METERS + 1e-6);
        expect(b.along - a.along).toBeCloseTo(Math.hypot(b.x - a.x, b.z - a.z), 6);
        // Each edge of the segment is the segment's own line offset by the half
        // width: the mitre lands the joint's corner on both pieces' edges.
        const dx = (b.x - a.x) / Math.hypot(b.x - a.x, b.z - a.z);
        const dz = (b.z - a.z) / Math.hypot(b.x - a.x, b.z - a.z);
        for (const station of [a, b]) {
          for (const side of [-1, 1]) {
            const ex = station.x + station.rightX * half * side - a.x;
            const ez = station.z + station.rightZ * half * side - a.z;
            const offset = ex * dz - ez * dx;
            expect(offset * side).toBeCloseTo(half, 3);
          }
        }
        if (Math.hypot(a.rightX, a.rightZ) > 1 + 1e-6) joints += 1;
      }
    }
    expect(joints).toBeGreaterThan(10);
  });

  it("puts every segment in exactly one chunk, the one holding its middle", () => {
    const chunks = roadRibbonSpansByChunk(runs);
    let segments = 0;
    for (const [key, spans] of chunks) {
      for (const span of spans) {
        expect(span.last).toBeGreaterThan(span.first);
        for (let index = span.first; index < span.last; index += 1) {
          const a = roadRibbonStation(span.run, index);
          const b = roadRibbonStation(span.run, index + 1);
          const { cx, cz } = roadRibbonChunkOf((a.x + b.x) / 2, (a.z + b.z) / 2);
          expect(roadRibbonChunkKey(cx, cz)).toBe(key);
          segments += 1;
        }
      }
    }
    expect(segments).toBe(runs.reduce((sum, run) => sum + run.stationCount - 1, 0));
    expect(ROAD_RIBBON_CHUNK_METERS).toBe(128);
  });

  it("cuts an edge a few pieces at a time into the same runs and spans as at once", () => {
    const spanOf = (span: RoadRibbonSpan, cutRuns: readonly RoadRibbonRun[]) => `${cutRuns.indexOf(span.run)}:${span.first}-${span.last}`;
    let stepped = 0;
    for (const [key, list] of byEdge) {
      const whole = roadRibbonRuns(key, list);
      const cut = new RoadRibbonCut(key, list);
      let advances = 0;
      while (!cut.done) {
        // Past the deadline already: as few pieces as an advance takes.
        cut.advance(Number.NEGATIVE_INFINITY);
        advances += 1;
      }
      if (advances > 1) stepped += 1;
      expect(cut.runs.map((run) => [run.classId, run.firstIndex, run.stationCount])).toEqual(
        whole.map((run) => [run.classId, run.firstIndex, run.stationCount]),
      );
      cut.runs.forEach((run, k) => {
        const floats = run.stationCount * ROAD_RIBBON_STATION_FLOATS;
        expect(run.stations.subarray(0, floats)).toEqual(whole[k]!.stations.subarray(0, floats));
      });
      const spans = roadRibbonSpansByChunk(whole);
      expect([...cut.spans.keys()]).toEqual([...spans.keys()]);
      for (const [chunk, list] of spans) {
        expect(cut.spans.get(chunk)!.map((span) => spanOf(span, cut.runs))).toEqual(list.map((span) => spanOf(span, whole)));
      }
    }
    expect(stepped).toBeGreaterThan(5);
  });

  it("sweeps a section a metre or less between columns, centreline among them, wound to look up", () => {
    for (const classId of [ROAD_CLASS.track, ROAD_CLASS.gravel, ROAD_CLASS.airport]) {
      const columns = roadRibbonColumns(classId);
      const half = roadFormationHalfWidth(roadClass(classId)) + ROAD_RIBBON_FRINGE_METERS;
      expect(columns[0]).toBeCloseTo(-half, 9);
      expect(columns[columns.length - 1]).toBeCloseTo(half, 9);
      expect(columns).toContain(0);
      for (let index = 1; index < columns.length; index += 1) {
        expect(columns[index]! - columns[index - 1]!).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    const builder = new RoadSurfaceArrayBuilder();
    for (const spans of roadRibbonSpansByChunk(runs).values()) {
      for (const span of spans) appendRoadRibbonSpan(builder, span, head.startX, head.startZ);
    }
    const arrays = builder.build();
    expect(arrays.indices.length).toBeGreaterThan(10_000);
    expect(wrongWay(arrays)).toBe(0);
    // The surface lane: in from the formation's edge, the class as the kind.
    for (let vertex = 0; vertex < arrays.vertexCount; vertex += 1) {
      const kind = arrays.surface[vertex * 4 + 3]!;
      expect(kind).toBeLessThan(ROAD_RIBBON_PAD_KIND);
      const half = roadFormationHalfWidth(roadClass(kind as 0 | 1 | 2));
      expect(arrays.surface[vertex * 4 + 2]).toBeCloseTo(half - Math.abs(arrays.surface[vertex * 4]!), 6);
    }
  });

  it("lays each pad as its plane with its fringe, wound to look up", () => {
    expect(pads.length).toBeGreaterThan(0);
    const builder = new RoadSurfaceArrayBuilder();
    for (const pad of pads) appendRoadPad(builder, pad, head.startX, head.startZ);
    const arrays = builder.build();
    expect(wrongWay(arrays)).toBe(0);
    let reach = 0;
    for (let vertex = 0; vertex < arrays.vertexCount; vertex += 1) {
      expect(arrays.surface[vertex * 4 + 3]).toBeGreaterThanOrEqual(ROAD_RIBBON_PAD_KIND);
      reach = Math.min(reach, arrays.surface[vertex * 4 + 2]!);
    }
    expect(reach).toBeCloseTo(-ROAD_RIBBON_FRINGE_METERS, 9);
  });

  it("stands a rail's posts every 2 m and its beam along it, every face wound to its normal", () => {
    // The network's own where it has any (none stand within a region of the
    // road head today), and three that walk every way a rail can turn: a
    // straight run, a curve to the left and one to the right.
    const arc = (radius: number, turn: number, points: number): InfrastructureRail => {
      const out: number[] = [];
      for (let index = 0; index < points; index += 1) {
        const angle = (turn * index) / (points - 1);
        out.push(head.startX + Math.sin(angle) * radius, head.startZ + radius - Math.cos(angle) * radius);
      }
      return { points: out, heightMeters: 0.75 };
    };
    const synthetic: InfrastructureRail[] = [
      { points: [head.startX, head.startZ, head.startX + 61.7, head.startZ + 4.2], heightMeters: 0.75 },
      arc(60, 0.9, 9),
      arc(-45, -0.7, 6),
    ];
    for (const rail of [...rails.slice(0, 20), ...synthetic]) {
      const builder = new RoadSurfaceArrayBuilder();
      appendRoadRail(builder, rail, head.startX, head.startZ);
      const arrays = builder.build();
      expect(wrongWay(arrays)).toBe(0);
      // 20 vertices a post (four sides and a top); the beam's four strips after.
      let posts = 0;
      for (let vertex = 0; vertex < arrays.vertexCount; vertex += 1) {
        if (arrays.surface[vertex * 4] === Math.fround(-ROAD_RAIL_SHAPE.postBury)) posts += 1;
      }
      posts /= 8;
      expect(posts).toBe(Math.max(1, Math.round(roadRailLength(rail) / ROAD_RAIL_SHAPE.postSpacing)) + 1);
      // The lane is the height above the ground, and the baked y is the same height above 0.
      for (let vertex = 0; vertex < arrays.vertexCount; vertex += 1) {
        expect(arrays.positions[vertex * 3 + 1]).toBe(arrays.surface[vertex * 4]);
        expect(arrays.surface[vertex * 4]!).toBeLessThanOrEqual(rail.heightMeters + 1e-6);
      }
    }
  });
});
