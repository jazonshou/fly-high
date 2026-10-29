import type { InfrastructureRail } from "@/src/world/infrastructure";
import { roadCrossOffset } from "@/src/world/roadEarthworkProfiles";
import {
  ROAD_CLASS,
  roadClass,
  roadFormationHalfWidth,
  type RoadClassId,
} from "@/src/world/roads/roadClasses";
import type { RoadPad, RoadPiece } from "@/src/world/roads/roadNetwork";

/**
 * The roads' drawn surfaces as plain arrays: ribbons along every road, discs
 * on its pads, and the guardrails' posts and beams. Pure, so Node asserts the
 * shapes; `RoadSurfaceSystem` draws what is within reach, a slot a chunk.
 *
 * WHERE THE HEIGHTS COME FROM. Not from here. Every vertex carries the
 * design height (the formation's crown and cross-fall, the pad's level) only
 * as a fallback; the vertex stage lays it on the ground as the terrain DRAWS
 * it (`TerrainDrawnHeight`), lifted `ROAD_RIBBON_LIFT_METERS` and drawn with
 * a depth bias, so a ribbon follows every facet the terrain's level of detail
 * gives the road and never floats over or sinks under it.
 *
 * RIBBONS. A road's pieces are chained along its edge across regions (a
 * region's pieces end where its neighbour's begin, so a joint is mitred from
 * both pieces whichever region holds them), cut into stations at most
 * `ROAD_RIBBON_STATION_METERS` apart, and swept with a cross-section of
 * columns at most a metre apart from fringe to fringe: the formation (the
 * running surface and its shoulders) and `ROAD_RIBBON_FRINGE_METERS` of worn
 * edge beyond it, where loose stone and the verge give way to each other.
 * Each segment between stations belongs to the `ROAD_RIBBON_CHUNK_METERS`
 * chunk holding its middle.
 *
 * THE SURFACE ATTRIBUTE. One vec4 a vertex: metres across from the
 * centreline (to the right of the road's a->b), metres along it, metres in
 * from the formation's edge (negative in the fringe), and the kind: the class
 * id, plus 4 on a pad.
 */

/** Chunk edge, metres: what reach is decided over, and what a rebuild touches. */
export const ROAD_RIBBON_CHUNK_METERS = 128;
/** The longest a ribbon segment runs between stations, metres. */
export const ROAD_RIBBON_STATION_METERS = 4;
/** The widest a cross-section's columns are apart, metres. */
export const ROAD_RIBBON_COLUMN_METERS = 1;
/** Worn edge beyond the formation, metres. */
export const ROAD_RIBBON_FRINGE_METERS = 0.5;
/** Height above the drawn ground a ribbon lies at, metres (the depth bias does the rest). */
export const ROAD_RIBBON_LIFT_METERS = 0.015;
/** The kind's pad flag. */
export const ROAD_RIBBON_PAD_KIND = 4;

/** Guardrail parts, metres: posts every `postSpacing`, the beam's face 0.31 m deep. */
export const ROAD_RAIL_SHAPE = Object.freeze({
  postSpacing: 2,
  postAlong: 0.1,
  postAcross: 0.15,
  postBury: 0.4,
  postBelowTop: 0.05,
  beamDepth: 0.31,
  beamThickness: 0.06,
  /** The beam's face stands this far out from the posts' centreline, toward the road. */
  beamOffset: 0.14,
  stationMeters: 4,
});

/** One class's merged arrays, positions relative to the caller's anchor. */
export interface RoadSurfaceArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** vec4 per vertex: the surface attribute for ribbons; (height above ground, 0, 0, 0) for rails. */
  readonly surface: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
}

/** A growable builder for one mesh's arrays, typed from the start (a chunk's build is a frame's work). */
export class RoadSurfaceArrayBuilder {
  private positions = new Float32Array(3 * 1_024);
  private normals = new Float32Array(3 * 1_024);
  private surface = new Float32Array(4 * 1_024);
  private indices = new Uint32Array(6 * 1_024);
  private vertices = 0;
  private indexCount = 0;

  get vertexCount(): number {
    return this.vertices;
  }

  /** Empty again, keeping its arrays: one builder serves every chunk, and `build` copies out. */
  reset(): void {
    this.vertices = 0;
    this.indexCount = 0;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, a: number, b: number, c: number, d: number): number {
    const index = this.vertices;
    if (3 * (index + 1) > this.positions.length) {
      this.positions = largerFloats(this.positions);
      this.normals = largerFloats(this.normals);
      this.surface = largerFloats(this.surface);
    }
    const at3 = 3 * index;
    const at4 = 4 * index;
    this.positions[at3] = x;
    this.positions[at3 + 1] = y;
    this.positions[at3 + 2] = z;
    this.normals[at3] = nx;
    this.normals[at3 + 1] = ny;
    this.normals[at3 + 2] = nz;
    this.surface[at4] = a;
    this.surface[at4 + 1] = b;
    this.surface[at4 + 2] = c;
    this.surface[at4 + 3] = d;
    this.vertices = index + 1;
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    const at = this.reserve(3);
    this.indices[at] = a;
    this.indices[at + 1] = b;
    this.indices[at + 2] = c;
  }

  /** A quad (a, b, c, d) in order round its edge, as two triangles. */
  quad(a: number, b: number, c: number, d: number): void {
    const at = this.reserve(6);
    this.indices[at] = a;
    this.indices[at + 1] = b;
    this.indices[at + 2] = c;
    this.indices[at + 3] = a;
    this.indices[at + 4] = c;
    this.indices[at + 5] = d;
  }

  build(): RoadSurfaceArrays {
    return {
      positions: this.positions.slice(0, 3 * this.vertices),
      normals: this.normals.slice(0, 3 * this.vertices),
      surface: this.surface.slice(0, 4 * this.vertices),
      indices: this.indices.slice(0, this.indexCount),
      vertexCount: this.vertices,
    };
  }

  private reserve(count: number): number {
    const at = this.indexCount;
    while (at + count > this.indices.length) {
      const grown = new Uint32Array(2 * this.indices.length);
      grown.set(this.indices);
      this.indices = grown;
    }
    this.indexCount = at + count;
    return at;
  }
}

function largerFloats(array: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(2 * array.length);
  grown.set(array);
  return grown;
}

// ---------------------------------------------------------------------------
// Ribbons
// ---------------------------------------------------------------------------

/** One station of a ribbon run: where the centreline is, how the section lies (`roadRibbonStation`). */
export interface RoadRibbonStation {
  readonly x: number;
  readonly z: number;
  /** Metres along the run from its first station. */
  readonly along: number;
  /** Design centreline height, cross slope and cross-fall (the earthworks' own). */
  readonly centre: number;
  readonly cross: number;
  readonly crossfall: number;
  /** The section's direction (to the right of a->b) scaled by the joint's mitre. */
  readonly rightX: number;
  readonly rightZ: number;
}

/** A station's floats in a run's `stations`, in `RoadRibbonStation`'s order. */
export const ROAD_RIBBON_STATION_FLOATS = 8;

/** A run of contiguous pieces of one road edge, as stations. */
export interface RoadRibbonRun {
  readonly classId: RoadClassId;
  /** `track:<edge>` or `major:<edge>`: edge ids are per layer. */
  readonly edgeKey: string;
  readonly firstIndex: number;
  /** `stationCount` stations of `ROAD_RIBBON_STATION_FLOATS` floats each (the array may run longer). */
  readonly stations: Float64Array;
  readonly stationCount: number;
}

/** A run's station as an object (tests and probes; the sweep reads the floats). */
export function roadRibbonStation(run: RoadRibbonRun, index: number): RoadRibbonStation {
  const at = index * ROAD_RIBBON_STATION_FLOATS;
  const stations = run.stations;
  return {
    x: stations[at]!,
    z: stations[at + 1]!,
    along: stations[at + 2]!,
    centre: stations[at + 3]!,
    cross: stations[at + 4]!,
    crossfall: stations[at + 5]!,
    rightX: stations[at + 6]!,
    rightZ: stations[at + 7]!,
  };
}

export function roadRibbonEdgeKey(piece: Pick<RoadPiece, "classId" | "edgeId">): string {
  return `${piece.classId === ROAD_CLASS.track ? "track" : "major"}:${piece.edgeId}`;
}

/** Pieces join when the second starts within this of where the first ends, metres. */
const JOIN_METERS = 1e-3;
/** A mitre never widens a section more than this, however sharp the joint. */
const MITRE_LIMIT = 1.6;
/** Pieces `RoadRibbonCut.advance` takes between looks at the clock. */
const CUT_PIECES_PER_CHECK = 16;

/**
 * Chain one edge's pieces (any order, any regions) into runs of contiguous
 * pieces, and cut each into stations.
 */
export function roadRibbonRuns(edgeKey: string, pieces: readonly RoadPiece[]): RoadRibbonRun[] {
  const cut = new RoadRibbonCut(edgeKey, pieces);
  cut.advance(Number.POSITIVE_INFINITY);
  return cut.runs;
}

interface OpenRun {
  readonly run: { classId: RoadClassId; edgeKey: string; firstIndex: number; stations: Float64Array; stationCount: number };
  /** The piece taken last, its stations not cut yet: they wait for the next piece's direction (the joint's mitre). */
  piece: RoadPiece;
  dx: number;
  dz: number;
  length: number;
  /** The section at that piece's a end. */
  startX: number;
  startZ: number;
  first: boolean;
  along: number;
  /** The span being gathered: its first station and its chunk. */
  spanStart: number;
  spanCx: number;
  spanCz: number;
  spanKey: string | null;
}

/**
 * One edge cut into runs and their spans by chunk, a few pieces at a time
 * (`advance`), so a long road is cut over as many frames as it takes; the
 * same runs and spans as at once (`roadRibbonRuns`, `roadRibbonSpansByChunk`).
 */
export class RoadRibbonCut {
  readonly runs: RoadRibbonRun[] = [];
  /** Chunk key -> spans, in run and station order, complete once `done`. */
  readonly spans = new Map<string, RoadRibbonSpan[]>();
  private readonly sorted: readonly RoadPiece[];
  private next = 0;
  private open: OpenRun | null = null;

  constructor(readonly edgeKey: string, pieces: readonly RoadPiece[]) {
    this.sorted = [...pieces].sort((first, second) => first.index - second.index);
  }

  get done(): boolean {
    return this.next >= this.sorted.length && this.open === null;
  }

  /**
   * Cut pieces until `deadline` (a `performance.now()` reading), looking at
   * the clock every few pieces (so some are always cut); the last run closes
   * once every piece is in.
   */
  advance(deadline: number): void {
    const sorted = this.sorted;
    while (this.next < sorted.length) {
      const stop = Math.min(sorted.length, this.next + CUT_PIECES_PER_CHECK);
      for (; this.next < stop; this.next += 1) this.take(sorted[this.next]!);
      if (this.next < sorted.length && performance.now() >= deadline) return;
    }
    if (this.open) this.close(this.open);
  }

  private take(piece: RoadPiece): void {
    const dx = piece.bx - piece.ax;
    const dz = piece.bz - piece.az;
    const length = Math.hypot(dx, dz);
    const ux = length > 1e-9 ? dx / length : 1;
    const uz = length > 1e-9 ? dz / length : 0;
    const segment = length > 1e-9 ? length : 0;
    const open = this.open;
    if (open && piece.index === open.piece.index + 1
      && Math.hypot(piece.ax - open.piece.bx, piece.az - open.piece.bz) <= JOIN_METERS) {
      // The joint between the two: mitred along the bisector, so the
      // ribbon's edges are straight lines along every piece.
      let jointX = uz;
      let jointZ = -ux;
      let tx = open.dx + ux;
      let tz = open.dz + uz;
      const bisector = Math.hypot(tx, tz);
      if (bisector >= 1e-6) {
        tx /= bisector;
        tz /= bisector;
        const cosine = Math.max(1 / MITRE_LIMIT, tz * uz + tx * ux);
        jointX = tz / cosine;
        jointZ = -tx / cosine;
      }
      this.cutPiece(open, jointX, jointZ);
      open.piece = piece;
      open.dx = ux;
      open.dz = uz;
      open.length = segment;
      open.startX = jointX;
      open.startZ = jointZ;
      open.first = false;
      return;
    }
    if (open) this.close(open);
    this.open = {
      run: {
        classId: piece.classId,
        edgeKey: this.edgeKey,
        firstIndex: piece.index,
        stations: new Float64Array(ROAD_RIBBON_STATION_FLOATS * 64),
        stationCount: 0,
      },
      piece,
      dx: ux,
      dz: uz,
      length: segment,
      startX: uz,
      startZ: -ux,
      first: true,
      along: 0,
      spanStart: 0,
      spanCx: 0,
      spanCz: 0,
      spanKey: null,
    };
  }

  /** The open run's last piece cut with its own section at its b end, and the run's last span filed. */
  private close(open: OpenRun): void {
    this.cutPiece(open, open.dz, -open.dx);
    const run = open.run;
    if (open.spanKey !== null) {
      fileSpan(this.spans, open.spanKey, { run, first: open.spanStart, last: run.stationCount - 1 });
    }
    this.runs.push(run);
    this.open = null;
  }

  /** The stations of the open run's pending piece, its b end's section given, and the spans they close. */
  private cutPiece(open: OpenRun, endX: number, endZ: number): void {
    const piece = open.piece;
    const run = open.run;
    const steps = Math.max(1, Math.ceil(open.length / ROAD_RIBBON_STATION_METERS));
    const needed = (run.stationCount + steps + 1) * ROAD_RIBBON_STATION_FLOATS;
    if (needed > run.stations.length) {
      const grown = new Float64Array(Math.max(needed, 2 * run.stations.length));
      grown.set(run.stations);
      run.stations = grown;
    }
    const stations = run.stations;
    for (let step = open.first ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      const at = run.stationCount * ROAD_RIBBON_STATION_FLOATS;
      stations[at] = piece.ax + (piece.bx - piece.ax) * t;
      stations[at + 1] = piece.az + (piece.bz - piece.az) * t;
      stations[at + 2] = open.along + open.length * t;
      stations[at + 3] = piece.ha + (piece.hb - piece.ha) * t;
      stations[at + 4] = piece.ca + (piece.cb - piece.ca) * t;
      stations[at + 5] = piece.ka + (piece.kb - piece.ka) * t;
      stations[at + 6] = open.startX + (endX - open.startX) * t;
      stations[at + 7] = open.startZ + (endZ - open.startZ) * t;
      run.stationCount += 1;
      if (run.stationCount >= 2) this.segmentEnded(open);
    }
    open.along += open.length;
  }

  /** The segment ending at the run's newest station: its chunk ends the span gathering, or extends it. */
  private segmentEnded(open: OpenRun): void {
    const run = open.run;
    const stations = run.stations;
    const index = run.stationCount - 2;
    const a = index * ROAD_RIBBON_STATION_FLOATS;
    const b = a + ROAD_RIBBON_STATION_FLOATS;
    const cx = Math.floor((stations[a]! + stations[b]!) / 2 / ROAD_RIBBON_CHUNK_METERS);
    const cz = Math.floor((stations[a + 1]! + stations[b + 1]!) / 2 / ROAD_RIBBON_CHUNK_METERS);
    if (open.spanKey !== null && cx === open.spanCx && cz === open.spanCz) return;
    if (open.spanKey !== null) fileSpan(this.spans, open.spanKey, { run, first: open.spanStart, last: index });
    open.spanKey = roadRibbonChunkKey(cx, cz);
    open.spanCx = cx;
    open.spanCz = cz;
    open.spanStart = index;
  }
}

/** The cross-section's column offsets for a class, metres across, fringe to fringe, 0 among them. */
export function roadRibbonColumns(classId: RoadClassId): readonly number[] {
  const half = roadFormationHalfWidth(roadClass(classId)) + ROAD_RIBBON_FRINGE_METERS;
  const perSide = Math.ceil(half / ROAD_RIBBON_COLUMN_METERS);
  const columns: number[] = [];
  for (let index = -perSide; index <= perSide; index += 1) columns.push((index / perSide) * half);
  return columns;
}

/** The chunk a point lies in. */
export function roadRibbonChunkOf(x: number, z: number): { readonly cx: number; readonly cz: number } {
  return { cx: Math.floor(x / ROAD_RIBBON_CHUNK_METERS), cz: Math.floor(z / ROAD_RIBBON_CHUNK_METERS) };
}

export function roadRibbonChunkKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

/** Each run's segments by the chunk holding their middle: chunk key -> [run, first station] spans. */
export interface RoadRibbonSpan {
  readonly run: RoadRibbonRun;
  /** Stations `first` to `last` inclusive (last > first). */
  readonly first: number;
  readonly last: number;
}

export function roadRibbonSpansByChunk(runs: readonly RoadRibbonRun[]): Map<string, RoadRibbonSpan[]> {
  const chunks = new Map<string, RoadRibbonSpan[]>();
  for (const run of runs) {
    const stations = run.stations;
    let spanStart = 0;
    let spanKey: string | null = null;
    // The chunk compared as numbers, its key made only where a span starts.
    let spanCx = 0;
    let spanCz = 0;
    for (let index = 0; index + 1 < run.stationCount; index += 1) {
      const a = index * ROAD_RIBBON_STATION_FLOATS;
      const b = a + ROAD_RIBBON_STATION_FLOATS;
      const cx = Math.floor((stations[a]! + stations[b]!) / 2 / ROAD_RIBBON_CHUNK_METERS);
      const cz = Math.floor((stations[a + 1]! + stations[b + 1]!) / 2 / ROAD_RIBBON_CHUNK_METERS);
      if (spanKey === null || cx !== spanCx || cz !== spanCz) {
        if (spanKey !== null) fileSpan(chunks, spanKey, { run, first: spanStart, last: index });
        spanKey = roadRibbonChunkKey(cx, cz);
        spanCx = cx;
        spanCz = cz;
        spanStart = index;
      }
    }
    if (spanKey !== null) fileSpan(chunks, spanKey, { run, first: spanStart, last: run.stationCount - 1 });
  }
  return chunks;
}

function fileSpan(map: Map<string, RoadRibbonSpan[]>, key: string, span: RoadRibbonSpan): void {
  const list = map.get(key);
  if (list) list.push(span);
  else map.set(key, [span]);
}

/** Sweep one span of a run into `builder`, positions relative to (anchorX, anchorZ). */
export function appendRoadRibbonSpan(
  builder: RoadSurfaceArrayBuilder,
  span: RoadRibbonSpan,
  anchorX: number,
  anchorZ: number,
): void {
  const spec = roadClass(span.run.classId);
  const formation = roadFormationHalfWidth(spec);
  const columns = roadRibbonColumns(span.run.classId);
  const kind = span.run.classId;
  const stations = span.run.stations;
  let previous = -1;
  for (let index = span.first; index <= span.last; index += 1) {
    const at = index * ROAD_RIBBON_STATION_FLOATS;
    const x = stations[at]!;
    const z = stations[at + 1]!;
    const along = stations[at + 2]!;
    const centre = stations[at + 3]!;
    const cross = stations[at + 4]!;
    const crossfall = stations[at + 5]!;
    const rightX = stations[at + 6]!;
    const rightZ = stations[at + 7]!;
    const first = builder.vertexCount;
    for (const across of columns) {
      const y = centre + roadCrossOffset(across, cross, crossfall) + ROAD_RIBBON_LIFT_METERS;
      builder.vertex(
        x + rightX * across - anchorX,
        y,
        z + rightZ * across - anchorZ,
        0, 1, 0,
        across,
        along,
        formation - Math.abs(across),
        kind,
      );
    }
    if (previous >= 0) {
      // Wound as the terrain's grid is, so a front face looks up.
      for (let column = 0; column + 1 < columns.length; column += 1) {
        builder.quad(previous + column, previous + column + 1, first + column + 1, first + column);
      }
    }
    previous = first;
  }
}

/** Rings a pad's disc is swept in, and the segments round it. */
const PAD_SEGMENTS = 24;
const PAD_RING_METERS = 1.5;

/** A pad's disc (its plane) and its fringe. */
export function appendRoadPad(builder: RoadSurfaceArrayBuilder, pad: RoadPad, anchorX: number, anchorZ: number): void {
  const rings = Math.max(1, Math.ceil(pad.radius / PAD_RING_METERS));
  const radii: number[] = [];
  for (let ring = 1; ring <= rings; ring += 1) radii.push((ring / rings) * pad.radius);
  radii.push(pad.radius + ROAD_RIBBON_FRINGE_METERS);
  const kind = pad.classId + ROAD_RIBBON_PAD_KIND;
  const y = pad.height + ROAD_RIBBON_LIFT_METERS;
  const tilt = Math.hypot(pad.gradientX, 1, pad.gradientZ);
  const nx = -pad.gradientX / tilt;
  const ny = 1 / tilt;
  const nz = -pad.gradientZ / tilt;
  const centre = builder.vertex(pad.x - anchorX, y, pad.z - anchorZ, nx, ny, nz, 0, 0, pad.radius, kind);
  let previousRing = -1;
  for (const radius of radii) {
    const ring = builder.vertexCount;
    for (let segment = 0; segment < PAD_SEGMENTS; segment += 1) {
      const angle = (segment / PAD_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const rise = pad.gradientX * x + pad.gradientZ * z;
      builder.vertex(pad.x + x - anchorX, y + rise, pad.z + z - anchorZ, nx, ny, nz, x, z, pad.radius - radius, kind);
    }
    for (let segment = 0; segment < PAD_SEGMENTS; segment += 1) {
      const next = (segment + 1) % PAD_SEGMENTS;
      if (previousRing < 0) builder.triangle(centre, ring + segment, ring + next);
      else builder.quad(previousRing + segment, ring + segment, ring + next, previousRing + next);
    }
    previousRing = ring;
  }
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/** A rail's total length, metres. */
export function roadRailLength(rail: InfrastructureRail): number {
  let length = 0;
  for (let index = 2; index + 1 < rail.points.length; index += 2) {
    length += Math.hypot(rail.points[index]! - rail.points[index - 2]!, rail.points[index + 1]! - rail.points[index - 1]!);
  }
  return length;
}

interface RailFrame {
  readonly x: number;
  readonly z: number;
  /** Unit toward the road. */
  readonly nx: number;
  readonly nz: number;
  /** Unit along the rail. */
  readonly tx: number;
  readonly tz: number;
}

/** Frames along a rail at its points and at most `spacing` metres apart between them. */
function railFrames(rail: InfrastructureRail, spacing: number): RailFrame[] {
  const points = rail.points;
  const frames: RailFrame[] = [];
  const count = points.length / 2;
  if (count < 2) return frames;
  for (let index = 0; index + 1 < count; index += 1) {
    const ax = points[index * 2]!;
    const az = points[index * 2 + 1]!;
    const bx = points[index * 2 + 2]!;
    const bz = points[index * 2 + 3]!;
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const tx = (bx - ax) / length;
    const tz = (bz - az) / length;
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = frames.length === 0 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      frames.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, nx: tz, nz: -tx, tx, tz });
    }
  }
  return frames;
}

/**
 * Posts every `postSpacing` along the run: each at the first of the run's
 * quarter-metre frames (`railFrames`) that reaches it, walked without making
 * them.
 */
function postFrames(rail: InfrastructureRail): RailFrame[] {
  const points = rail.points;
  const count = points.length / 2;
  const wanted: RailFrame[] = [];
  if (count < 2) return wanted;
  const length = roadRailLength(rail);
  const posts = Math.max(1, Math.round(length / ROAD_RAIL_SHAPE.postSpacing));
  let walked = 0;
  let next = 0;
  let first = true;
  let previousX = 0;
  let previousZ = 0;
  for (let index = 0; index + 1 < count; index += 1) {
    const ax = points[index * 2]!;
    const az = points[index * 2 + 1]!;
    const bx = points[index * 2 + 2]!;
    const bz = points[index * 2 + 3]!;
    const segment = Math.hypot(bx - ax, bz - az);
    if (segment < 1e-6) continue;
    const tx = (bx - ax) / segment;
    const tz = (bz - az) / segment;
    const steps = Math.max(1, Math.ceil(segment / 0.25));
    for (let step = first ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (!first) walked += Math.hypot(x - previousX, z - previousZ);
      first = false;
      previousX = x;
      previousZ = z;
      while (next <= posts && walked + 1e-6 >= (next / posts) * length) {
        wanted.push({ x, z, nx: tz, nz: -tx, tx, tz });
        next += 1;
      }
    }
  }
  return wanted;
}

/**
 * One rail's posts and beam into `builder`. A vertex's surface lane x is its
 * height above the ground under it; its baked y is that same height above 0,
 * which the vertex stage replaces with the drawn ground (a rail with no
 * drawn ground under it is not drawn).
 */
export function appendRoadRail(
  builder: RoadSurfaceArrayBuilder,
  rail: InfrastructureRail,
  anchorX: number,
  anchorZ: number,
): void {
  const shape = ROAD_RAIL_SHAPE;
  const top = rail.heightMeters;
  const postTop = top - shape.postBelowTop;
  const postHalfAcross = shape.postAcross / 2;
  for (const frame of postFrames(rail)) {
    appendRailBox(builder, frame, anchorX, anchorZ, shape.postAlong / 2, postHalfAcross, -postHalfAcross, -shape.postBury, postTop);
  }
  // The beam: a box section swept along the run, its face toward the road.
  const frames = railFrames(rail, shape.stationMeters);
  const near = shape.beamOffset + shape.beamThickness / 2;
  const far = shape.beamOffset - shape.beamThickness / 2;
  const bottom = top - shape.beamDepth;
  const strips: readonly (readonly [number, number, number, number, number])[] = [
    // [across0, height0, across1, height1, normal kind]: 0 toward road, 1 up, 2 away, 3 down.
    [near, bottom, near, top, 0],
    [near, top, far, top, 1],
    [far, top, far, bottom, 2],
    [far, bottom, near, bottom, 3],
  ];
  for (const [across0, height0, across1, height1, normalKind] of strips) {
    let previous = -1;
    for (const frame of frames) {
      const nx = normalKind === 0 ? frame.nx : normalKind === 2 ? -frame.nx : 0;
      const ny = normalKind === 1 ? 1 : normalKind === 3 ? -1 : 0;
      const nz = normalKind === 0 ? frame.nz : normalKind === 2 ? -frame.nz : 0;
      const a = builder.vertex(frame.x + frame.nx * across0 - anchorX, height0, frame.z + frame.nz * across0 - anchorZ, nx, ny, nz, height0, 0, 0, 0);
      const b = builder.vertex(frame.x + frame.nx * across1 - anchorX, height1, frame.z + frame.nz * across1 - anchorZ, nx, ny, nz, height1, 0, 0, 0);
      if (previous >= 0) builder.quad(a, b, previous + 1, previous);
      previous = a;
    }
  }
}

/** A box's corner, `along` the frame and `across` toward the road, relative to the anchor. */
function railCornerX(frame: RailFrame, along: number, across: number, anchorX: number): number {
  return frame.x + frame.tx * along + frame.nx * across - anchorX;
}

function railCornerZ(frame: RailFrame, along: number, across: number, anchorZ: number): number {
  return frame.z + frame.tz * along + frame.nz * across - anchorZ;
}

/** One vertical face of a box, from corner 0 to corner 1, bottom to ceiling. */
function appendRailFace(
  builder: RoadSurfaceArrayBuilder,
  x0: number, z0: number, x1: number, z1: number,
  nx: number, nz: number, bottom: number, ceiling: number,
): void {
  const a = builder.vertex(x0, bottom, z0, nx, 0, nz, bottom, 0, 0, 0);
  const b = builder.vertex(x1, bottom, z1, nx, 0, nz, bottom, 0, 0, 0);
  const c = builder.vertex(x1, ceiling, z1, nx, 0, nz, ceiling, 0, 0, 0);
  const d = builder.vertex(x0, ceiling, z0, nx, 0, nz, ceiling, 0, 0, 0);
  builder.quad(a, b, c, d);
}

/** A post: four faces walked round from (-along, near), then its top; no bottom (it is buried). */
function appendRailBox(
  builder: RoadSurfaceArrayBuilder,
  frame: RailFrame,
  anchorX: number,
  anchorZ: number,
  alongHalf: number,
  acrossNear: number,
  acrossFar: number,
  bottom: number,
  ceiling: number,
): void {
  const x00 = railCornerX(frame, -alongHalf, acrossNear, anchorX);
  const z00 = railCornerZ(frame, -alongHalf, acrossNear, anchorZ);
  const x10 = railCornerX(frame, alongHalf, acrossNear, anchorX);
  const z10 = railCornerZ(frame, alongHalf, acrossNear, anchorZ);
  const x11 = railCornerX(frame, alongHalf, acrossFar, anchorX);
  const z11 = railCornerZ(frame, alongHalf, acrossFar, anchorZ);
  const x01 = railCornerX(frame, -alongHalf, acrossFar, anchorX);
  const z01 = railCornerZ(frame, -alongHalf, acrossFar, anchorZ);
  appendRailFace(builder, x00, z00, x10, z10, frame.nx, frame.nz, bottom, ceiling);
  appendRailFace(builder, x10, z10, x11, z11, frame.tx, frame.tz, bottom, ceiling);
  appendRailFace(builder, x11, z11, x01, z01, -frame.nx, -frame.nz, bottom, ceiling);
  appendRailFace(builder, x01, z01, x00, z00, -frame.tx, -frame.tz, bottom, ceiling);
  const a = builder.vertex(x00, ceiling, z00, 0, 1, 0, ceiling, 0, 0, 0);
  const b = builder.vertex(x10, ceiling, z10, 0, 1, 0, ceiling, 0, 0, 0);
  const c = builder.vertex(x11, ceiling, z11, 0, 1, 0, ceiling, 0, 0, 0);
  const d = builder.vertex(x01, ceiling, z01, 0, 1, 0, ceiling, 0, 0, 0);
  builder.quad(a, b, c, d);
}
