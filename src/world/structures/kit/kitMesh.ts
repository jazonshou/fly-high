import type { StructureRecord } from "../structureRecord";
import { type StructurePart, type StructureSurface, structureSurfaceId } from "../structureModel";
import type { StructureIndoorLight } from "./kitIndoorLight";

/**
 * Parts to vertex arrays, Babylon-free: what the renderer uploads as it
 * is. Many buildings append into one builder (one mesh per set), each posed
 * through its record (`structureToWorld`) less a world origin (the floating
 * origin, metres, as doubles; the arrays are floats). Flat shaded: every
 * face has its own vertices.
 *
 * Per vertex: position, normal, uv, the surface's id (`STRUCTURE_SURFACES`
 * order), the colour (linear RGB from the part's sRGB), the indoor factor,
 * and the building's centre (world x and z less the origin), which lets the
 * far set hide its blocks inside the near radius.
 *
 * UV is metres along the face for every tiled surface (u across, v up the
 * face's most vertical axis), so a layer tiles at a fixed texel size;
 * `window` and `doorway` run 0 to 1 across the face instead, since their
 * layer is one whole sash or doorway.
 */

export interface StructureMeshArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly surface: Float32Array;
  readonly colour: Float32Array;
  readonly indoor: Float32Array;
  readonly centre: Float32Array;
  readonly indices: Uint32Array;
  readonly vertices: number;
  readonly triangles: number;
}

/** Surfaces whose UV runs 0 to 1 across each face (one whole picture per face). */
const FITTED: ReadonlySet<StructureSurface> = new Set<StructureSurface>(["window", "doorway"]);

/** Indoor faces larger than this are cut into cells so the light's falloff shows (with a light). */
export const INDOOR_CELL = 1.5;

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A growable float array. */
class Floats {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }
  reserve(n: number): void {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(v: number): void {
    this.data[this.length++] = v;
  }
  finish(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

class Indices {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Uint32Array(capacity);
  }
  reserve(n: number): void {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(v: number): void {
    this.data[this.length++] = v;
  }
  finish(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

interface Pose {
  readonly cos: number;
  readonly sin: number;
  /** The building's origin less the world origin. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
}

/** Building-frame faces into one growing set of arrays. */
export class StructureMeshBuilder {
  private readonly positions: Floats;
  private readonly normals: Floats;
  private readonly uvs: Floats;
  private readonly surface: Floats;
  private readonly colour: Floats;
  private readonly indoor: Floats;
  private readonly centre: Floats;
  private readonly indices: Indices;
  private vertexCount = 0;

  constructor(capacityVertices = 4096) {
    this.positions = new Floats(capacityVertices * 3);
    this.normals = new Floats(capacityVertices * 3);
    this.uvs = new Floats(capacityVertices * 2);
    this.surface = new Floats(capacityVertices);
    this.colour = new Floats(capacityVertices * 3);
    this.indoor = new Floats(capacityVertices);
    this.centre = new Floats(capacityVertices * 2);
    this.indices = new Indices(capacityVertices * 2);
  }

  get vertices(): number {
    return this.vertexCount;
  }

  get triangles(): number {
    return this.indices.length / 3;
  }

  /**
   * Append one building's parts, posed by its record, less `origin` (world
   * metres). `light` (`structureIndoorLight(kit.layout(record))`) gives
   * indoor faces a factor per vertex and cuts large ones into cells; without
   * it every vertex takes its part's own `indoor`.
   */
  append(
    record: Pick<StructureRecord, "x" | "z" | "heading" | "floorY">,
    parts: readonly StructurePart[],
    origin: { readonly x: number; readonly y: number; readonly z: number } = { x: 0, y: 0, z: 0 },
    light?: StructureIndoorLight,
  ): void {
    const pose: Pose = {
      cos: Math.cos(record.heading),
      sin: Math.sin(record.heading),
      ox: record.x - origin.x,
      oy: record.floorY - origin.y,
      oz: record.z - origin.z,
    };
    for (const part of parts) {
      if (part.kind === "box") this.appendBox(part, pose, light);
      else this.appendPolygon(part.points, part.surface, part.colour, part.indoor, pose, light);
    }
  }

  /** Append parts in the building frame as they are (no pose, no origin): tests and the shot harness. */
  appendLocal(parts: readonly StructurePart[], light?: StructureIndoorLight): void {
    this.append({ x: 0, z: 0, heading: 0, floorY: 0 }, parts, { x: 0, y: 0, z: 0 }, light);
  }

  finish(): StructureMeshArrays {
    return {
      positions: this.positions.finish(),
      normals: this.normals.finish(),
      uvs: this.uvs.finish(),
      surface: this.surface.finish(),
      colour: this.colour.finish(),
      indoor: this.indoor.finish(),
      centre: this.centre.finish(),
      indices: this.indices.finish(),
      vertices: this.vertexCount,
      triangles: this.indices.length / 3,
    };
  }

  private appendBox(part: Extract<StructurePart, { kind: "box" }>, pose: Pose, light?: StructureIndoorLight): void {
    const c = [part.cx, part.cy, part.cz];
    const axes = [
      [part.ux, part.uy, part.uz],
      [part.vx, part.vy, part.vz],
      [part.wx, part.wy, part.wz],
    ];
    // A left-handed (u, v, w) mirrors every face's winding: flip it back.
    const [a0, a1, a2] = axes as [number[], number[], number[]];
    const handed = (a0[1]! * a1[2]! - a0[2]! * a1[1]!) * a2[0]! + (a0[2]! * a1[0]! - a0[0]! * a1[2]!) * a2[1]! + (a0[0]! * a1[1]! - a0[1]! * a1[0]!) * a2[2]!;
    for (let axis = 0; axis < 3; axis += 1) {
      for (const sign of [1, -1]) {
        const bit = 1 << (axis * 2 + (sign > 0 ? 0 : 1));
        if (!(part.faces & bit)) continue;
        const n = axes[axis]!;
        const p = axes[(axis + 1) % 3]!;
        const q = axes[(axis + 2) % 3]!;
        // Face centre, and its two in-plane half extents (p, q), wound counter-clockwise seen from outside.
        const fc = [c[0]! + n[0]! * sign, c[1]! + n[1]! * sign, c[2]! + n[2]! * sign];
        const nl = Math.hypot(n[0]!, n[1]!, n[2]!);
        const normal = [(n[0]! * sign) / nl, (n[1]! * sign) / nl, (n[2]! * sign) / nl];
        // (p x q) is along +n for a right-handed (u, v, w); flip the winding for the -n face.
        const corners = sign * (handed < 0 ? -1 : 1) > 0
          ? [[-1, -1], [1, -1], [1, 1], [-1, 1]]
          : [[-1, -1], [-1, 1], [1, 1], [1, -1]];
        const pts = corners.map(([a, b]) => [
          fc[0]! + p[0]! * a! + q[0]! * b!,
          fc[1]! + p[1]! * a! + q[1]! * b!,
          fc[2]! + p[2]! * a! + q[2]! * b!,
        ]);
        this.appendQuad(pts, normal, part.surface, part.colour, part.indoor, pose, light);
      }
    }
  }

  private appendPolygon(points: readonly number[], surface: StructureSurface, colour: number, indoor: number, pose: Pose, light?: StructureIndoorLight): void {
    const count = points.length / 3;
    // Newell normal.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      nx += (points[i * 3 + 1]! - points[j * 3 + 1]!) * (points[i * 3 + 2]! + points[j * 3 + 2]!);
      ny += (points[i * 3 + 2]! - points[j * 3 + 2]!) * (points[i * 3]! + points[j * 3]!);
      nz += (points[i * 3]! - points[j * 3]!) * (points[i * 3 + 1]! + points[j * 3 + 1]!);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / l, ny / l, nz / l];
    const pts: number[][] = [];
    for (let i = 0; i < count; i += 1) pts.push([points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!]);
    if (count === 4 && light && indoor > 0) {
      this.appendQuad(pts, normal, surface, colour, indoor, pose, light);
      return;
    }
    const base = this.vertexCount;
    const frame = uvFrame(normal, surface === "window" || surface === "doorway" ? pts : null);
    for (const pt of pts) this.vertex(pt, normal, frame, surface, colour, indoor, pose, light);
    this.indices.reserve((count - 2) * 3);
    for (let i = 1; i + 1 < count; i += 1) {
      this.indices.push(base);
      this.indices.push(base + i);
      this.indices.push(base + i + 1);
    }
  }

  /** A planar quad (corners counter-clockwise from the normal's side), cut into cells when it is a large lit indoor face. */
  private appendQuad(pts: number[][], normal: number[], surface: StructureSurface, colour: number, indoor: number, pose: Pose, light?: StructureIndoorLight): void {
    const frame = uvFrame(normal, FITTED.has(surface) ? pts : null);
    const e1 = sub(pts[1]!, pts[0]!);
    const e2 = sub(pts[3]!, pts[0]!);
    let nu = 1;
    let nv = 1;
    if (light && indoor > 0) {
      nu = Math.max(1, Math.min(8, Math.ceil(len(e1) / INDOOR_CELL)));
      nv = Math.max(1, Math.min(8, Math.ceil(len(e2) / INDOOR_CELL)));
    }
    const base = this.vertexCount;
    for (let j = 0; j <= nv; j += 1) {
      for (let i = 0; i <= nu; i += 1) {
        const a = i / nu;
        const b = j / nv;
        const p = [pts[0]![0]! + e1[0]! * a + e2[0]! * b, pts[0]![1]! + e1[1]! * a + e2[1]! * b, pts[0]![2]! + e1[2]! * a + e2[2]! * b];
        this.vertex(p, normal, frame, surface, colour, indoor, pose, light);
      }
    }
    this.indices.reserve(nu * nv * 6);
    for (let j = 0; j < nv; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const v00 = base + j * (nu + 1) + i;
        const v10 = v00 + 1;
        const v01 = v00 + nu + 1;
        const v11 = v01 + 1;
        this.indices.push(v00);
        this.indices.push(v10);
        this.indices.push(v11);
        this.indices.push(v00);
        this.indices.push(v11);
        this.indices.push(v01);
      }
    }
  }

  private vertex(p: number[], n: number[], frame: UvFrame, surface: StructureSurface, colour: number, indoor: number, pose: Pose, light?: StructureIndoorLight): void {
    // Building frame to world, less the origin (structureToWorld's rotation).
    const x = pose.ox + p[0]! * pose.cos + p[2]! * pose.sin;
    const y = pose.oy + p[1]!;
    const z = pose.oz - p[0]! * pose.sin + p[2]! * pose.cos;
    const wnx = n[0]! * pose.cos + n[2]! * pose.sin;
    const wnz = -n[0]! * pose.sin + n[2]! * pose.cos;
    this.positions.reserve(3);
    this.positions.push(x);
    this.positions.push(y);
    this.positions.push(z);
    this.normals.reserve(3);
    this.normals.push(wnx);
    this.normals.push(n[1]!);
    this.normals.push(wnz);
    const [u, v] = frame(p);
    this.uvs.reserve(2);
    this.uvs.push(u);
    this.uvs.push(v);
    this.surface.reserve(1);
    this.surface.push(structureSurfaceId(surface));
    this.colour.reserve(3);
    this.colour.push(SRGB_TO_LINEAR[(colour >> 16) & 255]!);
    this.colour.push(SRGB_TO_LINEAR[(colour >> 8) & 255]!);
    this.colour.push(SRGB_TO_LINEAR[colour & 255]!);
    this.indoor.reserve(1);
    this.indoor.push(indoor > 0 && light ? light.at(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!) : indoor);
    this.centre.reserve(2);
    this.centre.push(pose.ox);
    this.centre.push(pose.oz);
    this.vertexCount += 1;
  }
}

type UvFrame = (p: number[]) => [number, number];

/**
 * The face's texture axes: v up its most vertical in-plane direction (world
 * up projected on the face; for a level face, the building's z), u across.
 * Tiled surfaces measure metres from the building's origin, so neighbouring
 * boxes' boards line up; fitted ones run 0 to 1 over the given corners.
 */
function uvFrame(n: number[], fitted: number[][] | null): UvFrame {
  let vx = -n[0]! * n[1]!;
  let vy = 1 - n[1]! * n[1]!;
  let vz = -n[2]! * n[1]!;
  let vl = Math.hypot(vx, vy, vz);
  if (vl < 1e-3) {
    // A level face: v along z, u along x (seen from above; mirrored below).
    vx = 0;
    vy = 0;
    vz = 1;
    vl = 1;
  }
  vx /= vl;
  vy /= vl;
  vz /= vl;
  // u = v x n, so (u, v) reads right-handed seen from the face's front.
  const ux = vy * n[2]! - vz * n[1]!;
  const uy = vz * n[0]! - vx * n[2]!;
  const uz = vx * n[1]! - vy * n[0]!;
  if (!fitted) return (p) => [p[0]! * ux + p[1]! * uy + p[2]! * uz, p[0]! * vx + p[1]! * vy + p[2]! * vz];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of fitted) {
    const u = p[0]! * ux + p[1]! * uy + p[2]! * uz;
    const v = p[0]! * vx + p[1]! * vy + p[2]! * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const du = u1 - u0 || 1;
  const dv = v1 - v0 || 1;
  return (p) => [(p[0]! * ux + p[1]! * uy + p[2]! * uz - u0) / du, (p[0]! * vx + p[1]! * vy + p[2]! * vz - v0) / dv];
}

function sub(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function len(a: number[]): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}

/** Triangles a set of parts makes (without indoor cells). */
export function structurePartTriangles(parts: readonly StructurePart[]): number {
  let n = 0;
  for (const part of parts) {
    if (part.kind === "box") {
      let f = part.faces;
      while (f) {
        n += f & 1 ? 2 : 0;
        f >>= 1;
      }
    } else {
      n += part.points.length / 3 - 2;
    }
  }
  return n;
}
