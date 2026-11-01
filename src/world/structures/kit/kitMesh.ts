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

/** Surfaces whose UV runs 0 to 1 across each face (one whole picture per face), by id. */
const FITTED_IDS: ReadonlySet<number> = new Set<number>([structureSurfaceId("window"), structureSurfaceId("doorway")]);

/** Indoor faces larger than this are cut into cells so the light's falloff shows (with a light). */
export const INDOOR_CELL = 2.0;

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Growable typed arrays written through cursors (no per-value calls on the hot path). */
class Grow {
  f32: Float32Array;
  constructor(capacity: number) {
    this.f32 = new Float32Array(capacity);
  }
  ensure(used: number, extra: number): Float32Array {
    if (used + extra > this.f32.length) {
      let cap = this.f32.length * 2;
      while (cap < used + extra) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.f32.subarray(0, used));
      this.f32 = next;
    }
    return this.f32;
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

/** Per-face scratch: the face's corners (4 x 3), normal and UV axes, reused by every face. */
const CORNERS = new Float64Array(12);

/** Building-frame faces into one growing set of arrays. */
export class StructureMeshBuilder {
  private readonly positions: Grow;
  private readonly normals: Grow;
  private readonly uvs: Grow;
  private readonly surface: Grow;
  private readonly colour: Grow;
  private readonly indoor: Grow;
  private readonly centre: Grow;
  private indices: Uint32Array;
  private indexCount = 0;
  private vertexCount = 0;
  // The current face: normal, UV axes and offsets (fitted faces), colour, surface id, indoor.
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private ux = 0;
  private uy = 0;
  private uz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private u0 = 0;
  private v0 = 0;
  private du = 1;
  private dv = 1;
  private r = 0;
  private g = 0;
  private b = 0;
  private surfaceId = 0;
  private partIndoor = 0;
  /** A face's own indoor factor, when it is lit once at its centre (small faces); -1 when lit per vertex. */
  private faceIndoor = -1;
  private pose: Pose = { cos: 1, sin: 0, ox: 0, oy: 0, oz: 0 };
  private light: StructureIndoorLight | undefined;

  constructor(capacityVertices = 4096) {
    this.positions = new Grow(capacityVertices * 3);
    this.normals = new Grow(capacityVertices * 3);
    this.uvs = new Grow(capacityVertices * 2);
    this.surface = new Grow(capacityVertices);
    this.colour = new Grow(capacityVertices * 3);
    this.indoor = new Grow(capacityVertices);
    this.centre = new Grow(capacityVertices * 2);
    this.indices = new Uint32Array(capacityVertices * 2);
  }

  get vertices(): number {
    return this.vertexCount;
  }

  get triangles(): number {
    return this.indexCount / 3;
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
    this.pose = {
      cos: Math.cos(record.heading),
      sin: Math.sin(record.heading),
      ox: record.x - origin.x,
      oy: record.floorY - origin.y,
      oz: record.z - origin.z,
    };
    this.light = light;
    for (const part of parts) {
      this.setMaterial(part.surface, part.colour, part.indoor);
      if (part.kind === "box") this.appendBox(part);
      else this.appendPolygon(part.points);
    }
  }

  /** Append parts in the building frame as they are (no pose, no origin): tests and the shot harness. */
  appendLocal(parts: readonly StructurePart[], light?: StructureIndoorLight): void {
    this.append({ x: 0, z: 0, heading: 0, floorY: 0 }, parts, { x: 0, y: 0, z: 0 }, light);
  }

  finish(): StructureMeshArrays {
    const v = this.vertexCount;
    return {
      positions: this.positions.f32.slice(0, v * 3),
      normals: this.normals.f32.slice(0, v * 3),
      uvs: this.uvs.f32.slice(0, v * 2),
      surface: this.surface.f32.slice(0, v),
      colour: this.colour.f32.slice(0, v * 3),
      indoor: this.indoor.f32.slice(0, v),
      centre: this.centre.f32.slice(0, v * 2),
      indices: this.indices.slice(0, this.indexCount),
      vertices: v,
      triangles: this.indexCount / 3,
    };
  }

  private setMaterial(surface: StructureSurface, colour: number, indoor: number): void {
    this.surfaceId = structureSurfaceId(surface);
    this.r = SRGB_TO_LINEAR[(colour >> 16) & 255]!;
    this.g = SRGB_TO_LINEAR[(colour >> 8) & 255]!;
    this.b = SRGB_TO_LINEAR[colour & 255]!;
    this.partIndoor = indoor;
  }

  private reserve(vertices: number, indices: number): void {
    const v = this.vertexCount;
    this.positions.ensure(v * 3, vertices * 3);
    this.normals.ensure(v * 3, vertices * 3);
    this.uvs.ensure(v * 2, vertices * 2);
    this.surface.ensure(v, vertices);
    this.colour.ensure(v * 3, vertices * 3);
    this.indoor.ensure(v, vertices);
    this.centre.ensure(v * 2, vertices * 2);
    if (this.indexCount + indices > this.indices.length) {
      let cap = this.indices.length * 2;
      while (cap < this.indexCount + indices) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.indices.subarray(0, this.indexCount));
      this.indices = next;
    }
  }

  private appendBox(part: Extract<StructurePart, { kind: "box" }>): void {
    const { cx, cy, cz, ux, uy, uz, vx, vy, vz, wx, wy, wz } = part;
    // A left-handed (u, v, w) mirrors every face's winding: flip it back.
    const handed = (uy * vz - uz * vy) * wx + (uz * vx - ux * vz) * wy + (ux * vy - uy * vx) * wz;
    const fitted = FITTED_IDS.has(this.surfaceId);
    // Small lit boxes (furniture, trims) take the light once per face, at its centre.
    const small = this.light !== undefined && this.partIndoor > 0
      && ux * ux + uy * uy + uz * uz < 0.16 && vx * vx + vy * vy + vz * vz < 0.16 && wx * wx + wy * wy + wz * wz < 0.16;
    for (let axis = 0; axis < 3; axis += 1) {
      // The face's normal axis n and its in-plane half extents p, q (p x q along +n when right-handed).
      const nX = axis === 0 ? ux : axis === 1 ? vx : wx;
      const nY = axis === 0 ? uy : axis === 1 ? vy : wy;
      const nZ = axis === 0 ? uz : axis === 1 ? vz : wz;
      const pX = axis === 0 ? vx : axis === 1 ? wx : ux;
      const pY = axis === 0 ? vy : axis === 1 ? wy : uy;
      const pZ = axis === 0 ? vz : axis === 1 ? wz : uz;
      const qX = axis === 0 ? wx : axis === 1 ? ux : vx;
      const qY = axis === 0 ? wy : axis === 1 ? uy : vy;
      const qZ = axis === 0 ? wz : axis === 1 ? uz : vz;
      const nl = Math.sqrt(nX * nX + nY * nY + nZ * nZ);
      for (let k = 0; k < 2; k += 1) {
        const sign = k === 0 ? 1 : -1;
        const bit = 1 << (axis * 2 + k);
        if (!(part.faces & bit)) continue;
        const fx = cx + nX * sign;
        const fy = cy + nY * sign;
        const fz = cz + nZ * sign;
        // Counter-clockwise seen from outside: (-p-q, +p-q, +p+q, -p+q), or its mirror (-p-q, -p+q, +p+q, +p-q).
        const ccw = sign * (handed < 0 ? -1 : 1) > 0;
        const ap = ccw ? 1 : -1;
        setCorner(0, fx - pX - qX, fy - pY - qY, fz - pZ - qZ);
        setCorner(1, fx + ap * pX - ap * qX, fy + ap * pY - ap * qY, fz + ap * pZ - ap * qZ);
        setCorner(2, fx + pX + qX, fy + pY + qY, fz + pZ + qZ);
        setCorner(3, fx - ap * pX + ap * qX, fy - ap * pY + ap * qY, fz - ap * pZ + ap * qZ);
        this.setNormal((nX * sign) / nl, (nY * sign) / nl, (nZ * sign) / nl);
        this.setUvAxes(fitted ? 4 : 0);
        this.faceIndoor = small ? this.light!.at(fx, fy, fz, this.nx, this.ny, this.nz) : -1;
        this.appendQuad();
        this.faceIndoor = -1;
      }
    }
  }

  private appendPolygon(points: readonly number[]): void {
    const count = points.length / 3;
    // Newell normal.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < count; i += 1) {
      const j = i + 1 === count ? 0 : i + 1;
      nx += (points[i * 3 + 1]! - points[j * 3 + 1]!) * (points[i * 3 + 2]! + points[j * 3 + 2]!);
      ny += (points[i * 3 + 2]! - points[j * 3 + 2]!) * (points[i * 3]! + points[j * 3]!);
      nz += (points[i * 3]! - points[j * 3]!) * (points[i * 3 + 1]! + points[j * 3 + 1]!);
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this.setNormal(nx / l, ny / l, nz / l);
    if (count === 4 && this.light && this.partIndoor > 0) {
      for (let i = 0; i < 4; i += 1) setCorner(i, points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
      this.setUvAxes(FITTED_IDS.has(this.surfaceId) ? 4 : 0);
      this.appendQuad();
      return;
    }
    if (FITTED_IDS.has(this.surfaceId)) {
      for (let i = 0; i < Math.min(4, count); i += 1) setCorner(i, points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
      this.setUvAxes(Math.min(4, count));
    } else {
      this.setUvAxes(0);
    }
    this.reserve(count, (count - 2) * 3);
    const base = this.vertexCount;
    for (let i = 0; i < count; i += 1) this.vertex(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
    const idx = this.indices;
    let n = this.indexCount;
    for (let i = 1; i + 1 < count; i += 1) {
      idx[n++] = base;
      idx[n++] = base + i;
      idx[n++] = base + i + 1;
    }
    this.indexCount = n;
  }

  private setNormal(x: number, y: number, z: number): void {
    this.nx = x;
    this.ny = y;
    this.nz = z;
  }

  /**
   * The face's texture axes: v up its most vertical in-plane direction
   * (world up projected on the face; for a level face, the building's z), u
   * across. Tiled surfaces measure metres from the building's origin, so
   * neighbouring boxes' boards line up; fitted ones (`fittedCorners` > 0)
   * run 0 to 1 over the corners in the scratch.
   */
  private setUvAxes(fittedCorners: number): void {
    const n0 = this.nx;
    const n1 = this.ny;
    const n2 = this.nz;
    let vx = -n0 * n1;
    let vy = 1 - n1 * n1;
    let vz = -n2 * n1;
    let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
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
    this.ux = vy * n2 - vz * n1;
    this.uy = vz * n0 - vx * n2;
    this.uz = vx * n1 - vy * n0;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.u0 = 0;
    this.v0 = 0;
    this.du = 1;
    this.dv = 1;
    if (fittedCorners === 0) return;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < fittedCorners; i += 1) {
      const px = CORNERS[i * 3]!;
      const py = CORNERS[i * 3 + 1]!;
      const pz = CORNERS[i * 3 + 2]!;
      const u = px * this.ux + py * this.uy + pz * this.uz;
      const v = px * vx + py * vy + pz * vz;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    this.u0 = u0;
    this.v0 = v0;
    this.du = u1 - u0 || 1;
    this.dv = v1 - v0 || 1;
  }

  /** The planar quad in the corner scratch (counter-clockwise from the normal's side), cut into cells when it is a large lit indoor face. */
  private appendQuad(): void {
    const ax = CORNERS[0]!;
    const ay = CORNERS[1]!;
    const az = CORNERS[2]!;
    const e1x = CORNERS[3]! - ax;
    const e1y = CORNERS[4]! - ay;
    const e1z = CORNERS[5]! - az;
    const e2x = CORNERS[9]! - ax;
    const e2y = CORNERS[10]! - ay;
    const e2z = CORNERS[11]! - az;
    let nu = 1;
    let nv = 1;
    if (this.light && this.partIndoor > 0 && this.faceIndoor < 0) {
      nu = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z) / INDOOR_CELL)));
      nv = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z) / INDOOR_CELL)));
    }
    this.reserve((nu + 1) * (nv + 1), nu * nv * 6);
    const base = this.vertexCount;
    for (let j = 0; j <= nv; j += 1) {
      const b = j / nv;
      for (let i = 0; i <= nu; i += 1) {
        const a = i / nu;
        this.vertex(ax + e1x * a + e2x * b, ay + e1y * a + e2y * b, az + e1z * a + e2z * b);
      }
    }
    const idx = this.indices;
    let n = this.indexCount;
    for (let j = 0; j < nv; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const v00 = base + j * (nu + 1) + i;
        const v10 = v00 + 1;
        const v01 = v00 + nu + 1;
        const v11 = v01 + 1;
        idx[n++] = v00;
        idx[n++] = v10;
        idx[n++] = v11;
        idx[n++] = v00;
        idx[n++] = v11;
        idx[n++] = v01;
      }
    }
    this.indexCount = n;
  }

  /** One vertex of the current face (room for it reserved). */
  private vertex(px: number, py: number, pz: number): void {
    const pose = this.pose;
    const v = this.vertexCount;
    // Building frame to world, less the origin (structureToWorld's rotation).
    const pos = this.positions.f32;
    pos[v * 3] = pose.ox + px * pose.cos + pz * pose.sin;
    pos[v * 3 + 1] = pose.oy + py;
    pos[v * 3 + 2] = pose.oz - px * pose.sin + pz * pose.cos;
    const nrm = this.normals.f32;
    nrm[v * 3] = this.nx * pose.cos + this.nz * pose.sin;
    nrm[v * 3 + 1] = this.ny;
    nrm[v * 3 + 2] = -this.nx * pose.sin + this.nz * pose.cos;
    const uv = this.uvs.f32;
    uv[v * 2] = (px * this.ux + py * this.uy + pz * this.uz - this.u0) / this.du;
    uv[v * 2 + 1] = (px * this.vx + py * this.vy + pz * this.vz - this.v0) / this.dv;
    this.surface.f32[v] = this.surfaceId;
    const col = this.colour.f32;
    col[v * 3] = this.r;
    col[v * 3 + 1] = this.g;
    col[v * 3 + 2] = this.b;
    this.indoor.f32[v] = this.faceIndoor >= 0 ? this.faceIndoor
      : this.partIndoor > 0 && this.light ? this.light.at(px, py, pz, this.nx, this.ny, this.nz)
        : this.partIndoor;
    const centre = this.centre.f32;
    centre[v * 2] = pose.ox;
    centre[v * 2 + 1] = pose.oz;
    this.vertexCount = v + 1;
  }
}

function setCorner(i: number, x: number, y: number, z: number): void {
  CORNERS[i * 3] = x;
  CORNERS[i * 3 + 1] = y;
  CORNERS[i * 3 + 2] = z;
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
