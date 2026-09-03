import type { Quaternion, Vec3 } from "./types";

export const EPSILON = 1e-8;
export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function sanitizeVec3(value: Partial<Vec3> | undefined, fallback: Vec3): Vec3 {
  return {
    x: finiteOr(value?.x, fallback.x),
    y: finiteOr(value?.y, fallback.y),
    z: finiteOr(value?.z, fallback.z),
  };
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function length3(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function normalizeInto(out: Vec3, value: Vec3, fallback: Vec3): Vec3 {
  const length = length3(value);
  if (!Number.isFinite(length) || length < EPSILON) {
    out.x = fallback.x;
    out.y = fallback.y;
    out.z = fallback.z;
    return out;
  }
  const inverse = 1 / length;
  out.x = value.x * inverse;
  out.y = value.y * inverse;
  out.z = value.z * inverse;
  return out;
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossInto(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function normalizeQuaternionInto(out: Quaternion, value: Quaternion): Quaternion {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length < EPSILON) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  const inverse = 1 / length;
  out.x = value.x * inverse;
  out.y = value.y * inverse;
  out.z = value.z * inverse;
  out.w = value.w * inverse;
  return out;
}

export function multiplyQuaternionInto(
  out: Quaternion,
  a: Quaternion,
  b: Quaternion,
): Quaternion {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function quaternionFromAxisAngle(axis: Vec3, angle: number): Quaternion {
  const half = angle * 0.5;
  const sine = Math.sin(half);
  return { x: axis.x * sine, y: axis.y * sine, z: axis.z * sine, w: Math.cos(half) };
}

/** Creates heading/pitch/bank using the public pilot-friendly angle signs. */
export function quaternionFromFlightAngles(
  heading = 0,
  pitch = 0,
  bank = 0,
): Quaternion {
  // Body +X is forward. Heading zero points it toward world +Z (north).
  const yawQ = quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, heading - Math.PI / 2);
  // Positive rotation about body +Z raises the nose.
  const pitchQ = quaternionFromAxisAngle({ x: 0, y: 0, z: 1 }, pitch);
  // Body +Z points to starboard in the right-handed aircraft frame (D-6). A
  // positive pilot bank (right wing down) rotates up toward +Z, a positive
  // rotation about +X.
  const bankQ = quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, bank);
  const intermediate = { x: 0, y: 0, z: 0, w: 1 };
  const result = { x: 0, y: 0, z: 0, w: 1 };
  multiplyQuaternionInto(intermediate, yawQ, pitchQ);
  multiplyQuaternionInto(result, intermediate, bankQ);
  return normalizeQuaternionInto(result, result);
}

export function rotateVectorInto(out: Vec3, quaternion: Quaternion, value: Vec3): Vec3 {
  // Expanded q * v * conjugate(q), safe when out === value.
  const { x: qx, y: qy, z: qz, w: qw } = quaternion;
  const { x, y, z } = value;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

export function inverseRotateVectorInto(
  out: Vec3,
  quaternion: Quaternion,
  value: Vec3,
): Vec3 {
  // Expanded conjugate(q) * v * q without allocating a temporary quaternion.
  const qx = -quaternion.x;
  const qy = -quaternion.y;
  const qz = -quaternion.z;
  const qw = quaternion.w;
  const { x, y, z } = value;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

export function wrapAngle(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

export function moveToward(current: number, target: number, maximumDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maximumDelta) return target;
  return current + Math.sign(delta) * maximumDelta;
}
