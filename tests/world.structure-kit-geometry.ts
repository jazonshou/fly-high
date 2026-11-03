import type { StructureCollider, StructurePart } from "../src/world/structures/structureModel";

/**
 * Geometry for the building kit's tests: corners and bounds of parts and
 * colliders, rays against them, the walking surface under a point and
 * whether a walker's capsule fits. Building frame, metres.
 */

export type V3 = readonly [number, number, number];

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

type Box = { readonly cx: number; readonly cy: number; readonly cz: number; readonly ux: number; readonly uy: number; readonly uz: number; readonly vx: number; readonly vy: number; readonly vz: number; readonly wx: number; readonly wy: number; readonly wz: number };

function boxCorners(p: Box): V3[] {
  const out: V3[] = [];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      for (const sw of [-1, 1]) {
        out.push([
          p.cx + su * p.ux + sv * p.vx + sw * p.wx,
          p.cy + su * p.uy + sv * p.vy + sw * p.wy,
          p.cz + su * p.uz + sv * p.vz + sw * p.wz,
        ]);
      }
    }
  }
  return out;
}

export function partCorners(p: StructurePart): V3[] {
  if (p.kind === "box") return boxCorners(p);
  const out: V3[] = [];
  for (let i = 0; i < p.points.length; i += 3) out.push([p.points[i]!, p.points[i + 1]!, p.points[i + 2]!]);
  return out;
}

export function boundsOf(points: readonly V3[], pad = 0): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, y, z] of points) {
    b.minX = Math.min(b.minX, x - pad);
    b.maxX = Math.max(b.maxX, x + pad);
    b.minY = Math.min(b.minY, y - pad);
    b.maxY = Math.max(b.maxY, y + pad);
    b.minZ = Math.min(b.minZ, z - pad);
    b.maxZ = Math.max(b.maxZ, z + pad);
  }
  return b;
}

export function partBounds(p: StructurePart): Bounds {
  return boundsOf(partCorners(p));
}

export function colliderBounds(c: StructureCollider): Bounds {
  if (c.kind === "box") return boundsOf(boxCorners(c));
  return boundsOf([[c.ax, c.ay, c.az], [c.bx, c.by, c.bz]], c.radius);
}

/** A box's three half axes as unit vectors and lengths. */
function axesOf(p: Box): { dir: V3; half: number }[] {
  return [
    [p.ux, p.uy, p.uz],
    [p.vx, p.vy, p.vz],
    [p.wx, p.wy, p.wz],
  ].map((a) => {
    const half = Math.hypot(a[0]!, a[1]!, a[2]!);
    return { dir: [a[0]! / half, a[1]! / half, a[2]! / half] as V3, half };
  });
}

/** Where a ray (origin, unit direction) first enters an oriented box, or Infinity. */
export function rayBox(o: V3, d: V3, p: Box): number {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const { dir, half } of axesOf(p)) {
    const rel = (o[0] - p.cx) * dir[0] + (o[1] - p.cy) * dir[1] + (o[2] - p.cz) * dir[2];
    const sp = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
    if (Math.abs(sp) < 1e-12) {
      if (Math.abs(rel) > half) return Infinity;
      continue;
    }
    let a = (-half - rel) / sp;
    let b = (half - rel) / sp;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  if (t1 < 0) return Infinity;
  return Math.max(0, t0);
}

/** Where a ray first meets a capsule, or Infinity (sampled finely; good to a centimetre). */
export function rayCapsule(o: V3, d: V3, c: Extract<StructureCollider, { kind: "capsule" }>, maxT: number): number {
  for (let t = 0; t <= maxT; t += 0.01) {
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if (pointSegmentDistance(p, [c.ax, c.ay, c.az], [c.bx, c.by, c.bz]) <= c.radius) return t;
  }
  return Infinity;
}

export function pointSegmentDistance(p: V3, a: V3, b: V3): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  let t = len2 > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}

export function pointBoxDistance(p: V3, box: Box): number {
  let sum = 0;
  for (const { dir, half } of axesOf(box)) {
    const rel = (p[0] - box.cx) * dir[0] + (p[1] - box.cy) * dir[1] + (p[2] - box.cz) * dir[2];
    const out = Math.abs(rel) - half;
    if (out > 0) sum += out * out;
  }
  return Math.sqrt(sum);
}

/** The top of a box over a vertical line (x, z), or -Infinity if the line misses it. */
export function boxTopAt(box: Box, x: number, z: number): number {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const { dir, half } of axesOf(box)) {
    const rel = (x - box.cx) * dir[0] + (0 - box.cy) * dir[1] + (z - box.cz) * dir[2];
    const sp = dir[1];
    if (Math.abs(sp) < 1e-12) {
      if (Math.abs(rel) > half + 1e-9) return -Infinity;
      continue;
    }
    let a = (-half - rel) / sp;
    let b = (half - rel) / sp;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1 + 1e-9) return -Infinity;
  }
  return t1;
}

/** Colliders binned by their x/z bounds in 1 m cells, for the walker's queries. */
export class ColliderGrid {
  private readonly cells = new Map<string, number[]>();
  readonly bounds: Bounds[];

  constructor(readonly colliders: readonly StructureCollider[], private readonly cell = 1) {
    this.bounds = colliders.map(colliderBounds);
    this.bounds.forEach((b, i) => {
      for (let gx = Math.floor(b.minX / cell); gx <= Math.floor(b.maxX / cell); gx += 1) {
        for (let gz = Math.floor(b.minZ / cell); gz <= Math.floor(b.maxZ / cell); gz += 1) {
          const key = `${gx},${gz}`;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(i);
        }
      }
    });
  }

  near(x: number, z: number, reach: number): number[] {
    const out = new Set<number>();
    for (let gx = Math.floor((x - reach) / this.cell); gx <= Math.floor((x + reach) / this.cell); gx += 1) {
      for (let gz = Math.floor((z - reach) / this.cell); gz <= Math.floor((z + reach) / this.cell); gz += 1) {
        for (const i of this.cells.get(`${gx},${gz}`) ?? []) out.add(i);
      }
    }
    return [...out];
  }

  /** The highest walkable top under (x, z) at or below `below` (boxes only). */
  supportAt(x: number, z: number, below: number): number {
    let best = -Infinity;
    for (const i of this.near(x, z, 0)) {
      const c = this.colliders[i]!;
      if (c.kind !== "box") continue;
      const top = boxTopAt(c, x, z);
      if (top <= below + 1e-6 && top > best) best = top;
    }
    return best;
  }

  /** Whether a vertical capsule of `radius` from y0 to y1 at (x, z) touches any collider. */
  blocked(x: number, z: number, y0: number, y1: number, radius: number): boolean {
    for (const i of this.near(x, z, radius)) {
      const b = this.bounds[i]!;
      if (b.maxY < y0 - radius || b.minY > y1 + radius) continue;
      if (b.minX > x + radius || b.maxX < x - radius || b.minZ > z + radius || b.maxZ < z - radius) continue;
      const c = this.colliders[i]!;
      for (let y = y0; y <= y1 + 1e-9; y += 0.1) {
        const p: V3 = [x, y, z];
        const dist = c.kind === "box" ? pointBoxDistance(p, c) : pointSegmentDistance(p, [c.ax, c.ay, c.az], [c.bx, c.by, c.bz]) - c.radius;
        if (dist < radius - 1e-6) return true;
      }
    }
    return false;
  }
}
