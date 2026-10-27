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
 * shapes; `RoadSurfaceSystem` merges what is within reach into meshes.
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

/** A growable builder for one mesh's arrays. */
export class RoadSurfaceArrayBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private surface: number[] = [];
  private indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, a: number, b: number, c: number, d: number): number {
    const index = this.vertexCount;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.surface.push(a, b, c, d);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A quad (a, b, c, d) in order round its edge, as two triangles. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): RoadSurfaceArrays {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      surface: Float32Array.from(this.surface),
      indices: Uint32Array.from(this.indices),
      vertexCount: this.vertexCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Ribbons
// ---------------------------------------------------------------------------

/** One station of a ribbon run: where the centreline is, how the section lies. */
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

/** A run of contiguous pieces of one road edge, as stations. */
export interface RoadRibbonRun {
  readonly classId: RoadClassId;
  /** `track:<edge>` or `major:<edge>`: edge ids are per layer. */
  readonly edgeKey: string;
  readonly firstIndex: number;
  readonly stations: readonly RoadRibbonStation[];
}

export function roadRibbonEdgeKey(piece: Pick<RoadPiece, "classId" | "edgeId">): string {
  return `${piece.classId === ROAD_CLASS.track ? "track" : "major"}:${piece.edgeId}`;
}

/** Pieces join when the second starts within this of where the first ends, metres. */
const JOIN_METERS = 1e-3;
/** A mitre never widens a section more than this, however sharp the joint. */
const MITRE_LIMIT = 1.6;

/**
 * Chain one edge's pieces (any order, any regions) into runs of contiguous
 * pieces, and cut each into stations.
 */
export function roadRibbonRuns(edgeKey: string, pieces: readonly RoadPiece[]): RoadRibbonRun[] {
  const sorted = [...pieces].sort((first, second) => first.index - second.index);
  const runs: RoadRibbonRun[] = [];
  let chain: RoadPiece[] = [];
  const flush = () => {
    if (chain.length > 0) runs.push(runOf(edgeKey, chain));
    chain = [];
  };
  for (const piece of sorted) {
    const last = chain[chain.length - 1];
    if (last && (piece.index !== last.index + 1
      || Math.hypot(piece.ax - last.bx, piece.az - last.bz) > JOIN_METERS)) flush();
    chain.push(piece);
  }
  flush();
  return runs;
}

function runOf(edgeKey: string, chain: readonly RoadPiece[]): RoadRibbonRun {
  const directions = chain.map((piece) => {
    const dx = piece.bx - piece.ax;
    const dz = piece.bz - piece.az;
    const length = Math.hypot(dx, dz);
    return length > 1e-9 ? { x: dx / length, z: dz / length, length } : { x: 1, z: 0, length: 0 };
  });
  /** The section at joint k (0: the first piece's a end; k: piece k-1's b end). */
  const jointRight = (k: number): { x: number; z: number } => {
    const before = directions[k - 1];
    const after = directions[k];
    const own = after ?? before!;
    if (!before || !after) return { x: own.z, z: -own.x };
    let tx = before.x + after.x;
    let tz = before.z + after.z;
    const length = Math.hypot(tx, tz);
    if (length < 1e-6) return { x: own.z, z: -own.x };
    tx /= length;
    tz /= length;
    // Mitred: the section's offset along the bisector keeps each piece's own
    // width, so the ribbon's edges are straight lines along every piece.
    const cosine = Math.max(1 / MITRE_LIMIT, tz * after.z + tx * after.x);
    return { x: tz / cosine, z: -tx / cosine };
  };
  const stations: RoadRibbonStation[] = [];
  let along = 0;
  chain.forEach((piece, k) => {
    const start = jointRight(k);
    const end = jointRight(k + 1);
    const direction = directions[k]!;
    const steps = Math.max(1, Math.ceil(direction.length / ROAD_RIBBON_STATION_METERS));
    for (let step = k === 0 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      stations.push({
        x: piece.ax + (piece.bx - piece.ax) * t,
        z: piece.az + (piece.bz - piece.az) * t,
        along: along + direction.length * t,
        centre: piece.ha + (piece.hb - piece.ha) * t,
        cross: piece.ca + (piece.cb - piece.ca) * t,
        crossfall: piece.ka + (piece.kb - piece.ka) * t,
        rightX: start.x + (end.x - start.x) * t,
        rightZ: start.z + (end.z - start.z) * t,
      });
    }
    along += direction.length;
  });
  return { classId: chain[0]!.classId, edgeKey, firstIndex: chain[0]!.index, stations };
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
    for (let index = 0; index + 1 < stations.length; index += 1) {
      const a = stations[index]!;
      const b = stations[index + 1]!;
      const { cx, cz } = roadRibbonChunkOf((a.x + b.x) / 2, (a.z + b.z) / 2);
      const key = roadRibbonChunkKey(cx, cz);
      if (key !== spanKey) {
        if (spanKey !== null) push(chunks, spanKey, { run, first: spanStart, last: index });
        spanKey = key;
        spanStart = index;
      }
    }
    if (spanKey !== null) push(chunks, spanKey, { run, first: spanStart, last: stations.length - 1 });
  }
  return chunks;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
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
  let previous = -1;
  for (let index = span.first; index <= span.last; index += 1) {
    const station = span.run.stations[index]!;
    const first = builder.vertexCount;
    for (const across of columns) {
      const y = station.centre + roadCrossOffset(across, station.cross, station.crossfall) + ROAD_RIBBON_LIFT_METERS;
      builder.vertex(
        station.x + station.rightX * across - anchorX,
        y,
        station.z + station.rightZ * across - anchorZ,
        0, 1, 0,
        across,
        station.along,
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

/** Posts every `postSpacing` along the run, set at its points. */
function postFrames(rail: InfrastructureRail): RailFrame[] {
  const all = railFrames(rail, 0.25);
  if (all.length === 0) return all;
  const length = roadRailLength(rail);
  const posts = Math.max(1, Math.round(length / ROAD_RAIL_SHAPE.postSpacing));
  const wanted: RailFrame[] = [];
  let walked = 0;
  let next = 0;
  for (let index = 0; index < all.length; index += 1) {
    if (index > 0) walked += Math.hypot(all[index]!.x - all[index - 1]!.x, all[index]!.z - all[index - 1]!.z);
    while (next <= posts && walked + 1e-6 >= (next / posts) * length) {
      wanted.push(all[index]!);
      next += 1;
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
  const box = (
    frame: RailFrame,
    alongHalf: number,
    acrossNear: number,
    acrossFar: number,
    bottom: number,
    ceiling: number,
  ) => {
    // Corners: along -/+, across near (toward the road) / far.
    const corner = (along: number, across: number) => [
      frame.x + frame.tx * along + frame.nx * across - anchorX,
      frame.z + frame.tz * along + frame.nz * across - anchorZ,
    ] as const;
    const faces: readonly (readonly [number, number, number, number, number, number])[] = [
      // [along0, across0, along1, across1, normal x, normal z] for each vertical face, walked round.
      [-alongHalf, acrossNear, alongHalf, acrossNear, frame.nx, frame.nz],
      [alongHalf, acrossNear, alongHalf, acrossFar, frame.tx, frame.tz],
      [alongHalf, acrossFar, -alongHalf, acrossFar, -frame.nx, -frame.nz],
      [-alongHalf, acrossFar, -alongHalf, acrossNear, -frame.tx, -frame.tz],
    ];
    for (const [along0, across0, along1, across1, nx, nz] of faces) {
      const [x0, z0] = corner(along0, across0);
      const [x1, z1] = corner(along1, across1);
      const a = builder.vertex(x0, bottom, z0, nx, 0, nz, bottom, 0, 0, 0);
      const b = builder.vertex(x1, bottom, z1, nx, 0, nz, bottom, 0, 0, 0);
      const c = builder.vertex(x1, ceiling, z1, nx, 0, nz, ceiling, 0, 0, 0);
      const d = builder.vertex(x0, ceiling, z0, nx, 0, nz, ceiling, 0, 0, 0);
      builder.quad(a, b, c, d);
    }
    const [x00, z00] = corner(-alongHalf, acrossNear);
    const [x10, z10] = corner(alongHalf, acrossNear);
    const [x11, z11] = corner(alongHalf, acrossFar);
    const [x01, z01] = corner(-alongHalf, acrossFar);
    const a = builder.vertex(x00, ceiling, z00, 0, 1, 0, ceiling, 0, 0, 0);
    const b = builder.vertex(x10, ceiling, z10, 0, 1, 0, ceiling, 0, 0, 0);
    const c = builder.vertex(x11, ceiling, z11, 0, 1, 0, ceiling, 0, 0, 0);
    const d = builder.vertex(x01, ceiling, z01, 0, 1, 0, ceiling, 0, 0, 0);
    builder.quad(a, b, c, d);
  };
  const postHalfAcross = shape.postAcross / 2;
  for (const frame of postFrames(rail)) {
    box(frame, shape.postAlong / 2, postHalfAcross, -postHalfAcross, -shape.postBury, postTop);
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
