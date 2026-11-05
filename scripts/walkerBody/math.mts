/** Small 3-vector and 3x3 helpers for the walker body bake (column vectors, row-major 3x3 as 9 numbers). */
export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMV(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function mulMM(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
}

export function transpose(m: M3): M3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** The rotation about unit `axis` by `angle` (Rodrigues). */
export function axisAngle(axis: V3, angle: number): M3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/** The smallest rotation taking unit `from` to unit `to`. */
export function rotationBetween(from: V3, to: V3): M3 {
  const a = normalize(from);
  const b = normalize(to);
  const axis = cross(a, b);
  const s = length(axis);
  const c = dot(a, b);
  if (s < 1e-9) {
    if (c > 0) return [...IDENTITY];
    const other: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return axisAngle(cross(a, other), Math.PI);
  }
  return axisAngle(axis, Math.atan2(s, c));
}

/** A frame (columns primary, secondary, tertiary) from a primary axis and a reference made square to it. */
export function frame(primary: V3, reference: V3): M3 {
  const p = normalize(primary);
  const s = normalize(sub(reference, scale(p, dot(reference, p))));
  const t = cross(p, s);
  return [p[0], s[0], t[0], p[1], s[1], t[1], p[2], s[2], t[2]];
}
