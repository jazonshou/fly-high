import type { ColliderShape } from "../colliders";
import type { Quaternion } from "../types";
import type { StructureCollider, StructureColliderMaterial } from "@/src/world/structures/structureModel";
import { structureToWorld, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The generated buildings' colliders (the structures plan's "Colliders for
 * the car and the walker"): every collider a building's kit lays out
 * (`StructureKit.layout(record).colliders`, building frame), posed in the
 * world by its record, so what the renderer draws is what a car or a walker
 * meets. One collider group per streamed region, so a region leaves in one
 * call (`CarColliders.applyRegions`).
 *
 * Until the building kit lands (phase S3), `structureShellColliders` stands
 * in: each building's body as one solid box from its footings to its eaves,
 * which is all a car needs (it never goes in).
 */

/** A building's colliders in its own frame: the kit's layout, or the shell stand-in. */
export type StructureColliderSource = (record: StructureRecord) => readonly StructureCollider[];

/** A collider posed in the world, with the material its contacts report. */
export interface StructureWorldCollider {
  readonly shape: ColliderShape;
  readonly material: StructureColliderMaterial;
}

/** A storey's height, floor to floor, metres: the stand-in's walls (2.4 m ceilings, floor and joists). */
const STOREY_METERS = 2.9;

/**
 * The stand-in: the body (its walls' outside faces) as one box from the
 * footings (`baseY`) to the eave line, stone on a plinth, timber on posts.
 */
export function structureShellColliders(record: StructureRecord): readonly StructureCollider[] {
  const top = record.storeys * STOREY_METERS;
  const bottom = record.baseY - record.floorY;
  const material: StructureColliderMaterial = record.archetype === "tank" || record.archetype === "mast" || record.archetype === "windmill"
    ? "metal"
    : record.foundation === "plinth" ? "stone" : "timber";
  return [{
    kind: "box",
    cx: 0,
    cy: 0.5 * (top + bottom),
    cz: 0,
    ux: 0.5 * record.width,
    uy: 0,
    uz: 0,
    vx: 0,
    vy: 0.5 * (top - bottom),
    vz: 0,
    wx: 0,
    wy: 0,
    wz: 0.5 * record.depth,
    material,
  }];
}

/** Every collider of the buildings, posed in the world, in record order. */
export function buildStructureColliders(
  records: readonly StructureRecord[],
  source: StructureColliderSource = structureShellColliders,
): StructureWorldCollider[] {
  const out: StructureWorldCollider[] = [];
  for (const record of records) {
    for (const collider of source(record)) out.push(poseStructureCollider(record, collider));
  }
  return out;
}

/** One building-frame collider posed in the world. */
export function poseStructureCollider(record: StructureRecord, collider: StructureCollider): StructureWorldCollider {
  if (collider.kind === "capsule") {
    const a = structureToWorld(record, collider.ax, collider.ay, collider.az, { x: 0, y: 0, z: 0 });
    const b = structureToWorld(record, collider.bx, collider.by, collider.bz, { x: 0, y: 0, z: 0 });
    return { shape: { kind: "capsule", a, b, radius: collider.radius }, material: collider.material };
  }
  const center = structureToWorld(record, collider.cx, collider.cy, collider.cz, { x: 0, y: 0, z: 0 });
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  // The box's half-extent vectors in the world (the frame's rotation is about +y).
  const axes = [
    [collider.ux, collider.uy, collider.uz],
    [collider.vx, collider.vy, collider.vz],
    [collider.wx, collider.wy, collider.wz],
  ].map(([x, y, z]) => [x! * c + z! * s, y!, -x! * s + z! * c] as const);
  const lengths = axes.map(([x, y, z]) => Math.hypot(x, y, z));
  const columns = axes.map(([x, y, z], k) => {
    const length = lengths[k]!;
    return length > 0 ? [x / length, y / length, z / length] as const : null;
  });
  return {
    shape: {
      kind: "box",
      center,
      halfExtents: { x: lengths[0]!, y: lengths[1]!, z: lengths[2]! },
      orientation: quaternionFromAxes(columns, c, s),
    },
    material: collider.material,
  };
}

/**
 * The rotation taking the unit axes x, y, z to `columns` (orthonormal); a
 * missing column (a flat box) is completed from the other two, and with
 * fewer the frame's own heading stands.
 */
function quaternionFromAxes(
  columns: readonly (readonly [number, number, number] | null)[],
  c: number,
  s: number,
): Quaternion {
  const known = columns.filter((column) => column !== null).length;
  if (known < 2) {
    // About +y by the heading: x to (c, 0, -s).
    const half = Math.atan2(s, c) * 0.5;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
  }
  const cross = (a: readonly number[], b: readonly number[]) =>
    [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!] as const;
  const [x0, y0, z0] = columns;
  const ex = x0 ?? cross(y0!, z0!);
  const ey = y0 ?? cross(z0!, ex);
  const ez = z0 ?? cross(ex, ey);
  // Rotation matrix with columns ex, ey, ez; Shepperd's method.
  const m00 = ex[0], m10 = ex[1], m20 = ex[2];
  const m01 = ey[0], m11 = ey[1], m21 = ey[2];
  const m02 = ez[0], m12 = ez[1], m22 = ez[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const t = Math.sqrt(trace + 1) * 2;
    return { w: 0.25 * t, x: (m21 - m12) / t, y: (m02 - m20) / t, z: (m10 - m01) / t };
  }
  if (m00 > m11 && m00 > m22) {
    const t = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (m21 - m12) / t, x: 0.25 * t, y: (m01 + m10) / t, z: (m02 + m20) / t };
  }
  if (m11 > m22) {
    const t = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (m02 - m20) / t, x: (m01 + m10) / t, y: 0.25 * t, z: (m12 + m21) / t };
  }
  const t = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (m10 - m01) / t, x: (m02 + m20) / t, y: (m12 + m21) / t, z: 0.25 * t };
}
