import type {
  StructureBoxPart,
  StructureChimney,
  StructureCollider,
  StructureColliderMaterial,
  StructureDrawnLevel,
  StructureInteriorVolume,
  StructurePart,
  StructurePolygonPart,
  StructurePortal,
  StructureSurface,
  StructureWindowLight,
} from "../structureModel";

/** Face bits of a box part: +u, -u, +v, -v, +w, -w (an axis-aligned box: +x, -x, +y, -y, +z, -z). */
export const FACE = Object.freeze({
  px: 1,
  nx: 2,
  py: 4,
  ny: 8,
  pz: 16,
  nz: 32,
  all: 63,
  /** Every face but the bottom: a part standing on something. */
  standing: 63 & ~8,
  /** The four sides: a wall or a post with its ends hidden. */
  sides: 1 | 2 | 16 | 32,
  /** A beam's four long faces (`beam` runs along w): its end caps hidden. */
  long: 1 | 2 | 4 | 8,
});

/** Parts thinner than this get no collider, except glass (the walking contract). */
export const COLLIDER_MIN_THICKNESS = 0.1;

export type Vec3 = readonly [number, number, number];

/**
 * Collects one drawn level of a building and, for the open level, what is
 * not drawn: colliders, rooms, doors and lit windows. Callers emit through
 * it in building-frame metres (`structureRecord.ts`); what a level leaves
 * out is the caller's choice, so the closed and open shells can share their
 * outside by calling the same code.
 */
export class KitBuilder {
  readonly parts: StructurePart[] = [];
  readonly glass: StructurePart[] = [];
  readonly colliders: StructureCollider[] = [];
  readonly volumes: StructureInteriorVolume[] = [];
  readonly portals: StructurePortal[] = [];
  readonly windows: StructureWindowLight[] = [];
  readonly chimneys: StructureChimney[] = [];

  constructor(readonly level: StructureDrawnLevel) {}

  get open(): boolean {
    return this.level === "open";
  }

  get closed(): boolean {
    return this.level === "closed";
  }

  get block(): boolean {
    return this.level === "block";
  }

  /** An axis-aligned box from its bounds. Empty boxes and empty face masks are dropped. */
  box(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
    surface: StructureSurface, colour: number, faces: number = FACE.all, indoor = 0,
  ): void {
    if (faces === 0 || x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return;
    const part: StructureBoxPart = {
      kind: "box",
      cx: (x0 + x1) * 0.5,
      cy: (y0 + y1) * 0.5,
      cz: (z0 + z1) * 0.5,
      ux: (x1 - x0) * 0.5, uy: 0, uz: 0,
      vx: 0, vy: (y1 - y0) * 0.5, vz: 0,
      wx: 0, wy: 0, wz: (z1 - z0) * 0.5,
      surface,
      colour,
      faces,
      indoor,
    };
    (surface === "glass" ? this.glass : this.parts).push(part);
  }

  /** A box from its centre and three orthogonal half-extent vectors. */
  obox(c: Vec3, u: Vec3, v: Vec3, w: Vec3, surface: StructureSurface, colour: number, faces: number = FACE.all, indoor = 0): void {
    if (faces === 0) return;
    if (length(u) < 5e-5 || length(v) < 5e-5 || length(w) < 5e-5) return;
    const part: StructureBoxPart = {
      kind: "box",
      cx: c[0], cy: c[1], cz: c[2],
      ux: u[0], uy: u[1], uz: u[2],
      vx: v[0], vy: v[1], vz: v[2],
      wx: w[0], wy: w[1], wz: w[2],
      surface,
      colour,
      faces,
      indoor,
    };
    (surface === "glass" ? this.glass : this.parts).push(part);
  }

  /** A convex polygon, corners counter-clockwise seen from the drawn side. */
  polygon(points: readonly number[], surface: StructureSurface, colour: number, indoor = 0): void {
    if (points.length < 9) return;
    const part: StructurePolygonPart = { kind: "polygon", points: points.slice(), surface, colour, indoor };
    (surface === "glass" ? this.glass : this.parts).push(part);
  }

  /** An axis-aligned solid, if the level collects colliders and the box is thick enough (glass always). */
  solid(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: StructureColliderMaterial): void {
    if (!this.open) return;
    const thinnest = Math.min(x1 - x0, y1 - y0, z1 - z0);
    if (thinnest <= 0) return;
    if (material !== "glass" && thinnest < COLLIDER_MIN_THICKNESS - 1e-9) return;
    this.colliders.push({
      kind: "box",
      cx: (x0 + x1) * 0.5,
      cy: (y0 + y1) * 0.5,
      cz: (z0 + z1) * 0.5,
      ux: (x1 - x0) * 0.5, uy: 0, uz: 0,
      vx: 0, vy: (y1 - y0) * 0.5, vz: 0,
      wx: 0, wy: 0, wz: (z1 - z0) * 0.5,
      material,
    });
  }

  /** An oriented solid box (half-extent vectors as in `obox`). */
  solidOriented(c: Vec3, u: Vec3, v: Vec3, w: Vec3, material: StructureColliderMaterial): void {
    if (!this.open) return;
    const thinnest = 2 * Math.min(length(u), length(v), length(w));
    if (material !== "glass" && thinnest < COLLIDER_MIN_THICKNESS - 1e-9) return;
    this.colliders.push({
      kind: "box",
      cx: c[0], cy: c[1], cz: c[2],
      ux: u[0], uy: u[1], uz: u[2],
      vx: v[0], vy: v[1], vz: v[2],
      wx: w[0], wy: w[1], wz: w[2],
      material,
    });
  }

  /** A post, rail or rung: a segment swept by `radius` (none when thinner than the collider floor). */
  capsule(a: Vec3, b: Vec3, radius: number, material: StructureColliderMaterial): void {
    if (!this.open) return;
    if (2 * radius < COLLIDER_MIN_THICKNESS - 1e-9) return;
    this.colliders.push({ kind: "capsule", ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], radius, material });
  }

  volume(room: string, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): void {
    if (!this.open) return;
    this.volumes.push({ room, minX, maxX, minY, maxY, minZ, maxZ });
  }

  portal(portal: StructurePortal): void {
    if (!this.open) return;
    this.portals.push(portal);
  }

  windowLight(light: StructureWindowLight): void {
    if (!this.open) return;
    this.windows.push(light);
  }

  /** A chimney's flue (every level: the smoke rises from the blocks too). */
  chimney(flue: StructureChimney): void {
    this.chimneys.push(flue);
  }
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(v: Vec3): Vec3 {
  const l = length(v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/**
 * A box between two points: a beam, brace, rail or post of square section
 * `size` (and `depth` across, default the same), its `up` side towards `up`.
 */
export function beam(
  b: KitBuilder, a: Vec3, c: Vec3, size: number, surface: StructureSurface, colour: number,
  faces: number = FACE.all, indoor = 0, depth = size, up: Vec3 = [0, 1, 0],
): void {
  const axis = sub(c, a);
  const len = length(axis);
  if (len < 1e-4) return;
  const w = scale(axis, 0.5);
  const dir = scale(axis, 1 / len);
  let side = cross(up, dir);
  if (length(side) < 1e-4) side = cross([1, 0, 0], dir);
  side = normalize(side);
  const top = normalize(cross(dir, side));
  b.obox(scale(add(a, c), 0.5), scale(side, depth * 0.5), scale(top, size * 0.5), w, surface, colour, faces, indoor);
}

/** sRGB 0xRRGGBB scaled towards black (`k` < 1) or white (`k` > 1 lerps to white by k - 1). */
export function shade(colour: number, k: number): number {
  const r = (colour >> 16) & 255;
  const g = (colour >> 8) & 255;
  const bl = colour & 255;
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1))));
  return (f(r) << 16) | (f(g) << 8) | f(bl);
}

/** Linear mix of two sRGB colours (in sRGB, which is what a palette pick wants). */
export function mixColour(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
