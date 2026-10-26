import type { SeaShelterEllipse } from "./types";

/**
 * The calm-basin field: how much of the open sea's wave displacement reaches a
 * point, 1 on the open sea and `floor` inside a sheltered basin.
 *
 * The drawn sea has no local fetch, so without this the open-sea swell would
 * run straight into the marina's berths. Each ellipse is analytic (no texture)
 * and the GPU ocean's vertex shader evaluates the WGSL below on every ocean
 * vertex, so the twin and the screen scale the same displacement at the same
 * point. Several ellipses multiply.
 *
 * Per ellipse, with `u` and `v` the offsets along and across its long axis and
 * `f = (u/a)^2 + (v/b)^2 - 1`, the distance outside it is taken to first order
 * as `f / |grad f|` (exact on the boundary, smooth everywhere), and the factor
 * rises from `floor` at the boundary to 1 at `feather` metres out through a
 * smoothstep. It is written `1 - (1 - floor)(1 - s)` so that past the feather
 * (`s` clamps to exactly 1) it is EXACTLY 1 in f32 as well as f64, and an
 * unused slot (`floor` 1) is exactly 1 everywhere: the open sea's pixels do not
 * move by a bit.
 */

/** The most ellipses one session applies; the GPU has this many uniform slots. */
export const SEA_SHELTER_MAX_ELLIPSES = 4;

export function assertSeaShelterEllipses(ellipses: readonly SeaShelterEllipse[]): void {
  if (ellipses.length > SEA_SHELTER_MAX_ELLIPSES) {
    throw new RangeError(`At most ${SEA_SHELTER_MAX_ELLIPSES} shelter ellipses, got ${ellipses.length}`);
  }
  for (const ellipse of ellipses) {
    const values = [
      ellipse.centerX, ellipse.centerZ, ellipse.heading, ellipse.radiusAlong,
      ellipse.radiusAcross, ellipse.floor, ellipse.feather,
    ];
    if (!values.every(Number.isFinite)) throw new RangeError("Shelter ellipse values must be finite");
    if (ellipse.radiusAlong <= 0 || ellipse.radiusAcross <= 0) {
      throw new RangeError("Shelter ellipse radii must be positive");
    }
    if (ellipse.feather <= 0) throw new RangeError("Shelter ellipse feather must be positive");
    if (ellipse.floor < 0 || ellipse.floor > 1) throw new RangeError("Shelter ellipse floor must be in [0, 1]");
  }
}

/**
 * The packed form both sides evaluate: per slot `(centerX, centerZ, sin, cos)`
 * of the long axis, then `(1/a^2, 1/b^2, 1 - floor, 1/feather)`. Unused slots
 * are neutral. The twin evaluates these same numbers, so it reads exactly what
 * the shader is handed.
 */
export function packSeaShelterEllipses(ellipses: readonly SeaShelterEllipse[]): Float64Array {
  assertSeaShelterEllipses(ellipses);
  const packed = new Float64Array(SEA_SHELTER_MAX_ELLIPSES * 8);
  for (let slot = 0; slot < SEA_SHELTER_MAX_ELLIPSES; slot += 1) {
    const ellipse = ellipses[slot];
    const base = slot * 8;
    if (!ellipse) {
      packed[base + 3] = 1;
      packed[base + 4] = 1;
      packed[base + 5] = 1;
      packed[base + 7] = 1;
      continue;
    }
    packed[base] = ellipse.centerX;
    packed[base + 1] = ellipse.centerZ;
    packed[base + 2] = Math.sin(ellipse.heading);
    packed[base + 3] = Math.cos(ellipse.heading);
    packed[base + 4] = 1 / (ellipse.radiusAlong * ellipse.radiusAlong);
    packed[base + 5] = 1 / (ellipse.radiusAcross * ellipse.radiusAcross);
    packed[base + 6] = 1 - ellipse.floor;
    packed[base + 7] = 1 / ellipse.feather;
  }
  return packed;
}

/** The field at a world point, from `packSeaShelterEllipses` output. */
export function seaShelterFactor(packed: Float64Array, x: number, z: number): number {
  let factor = 1;
  for (let base = 0; base < packed.length; base += 8) {
    const depth = packed[base + 6]!;
    if (depth === 0) continue;
    const dx = x - packed[base]!;
    const dz = z - packed[base + 1]!;
    const along = dx * packed[base + 2]! + dz * packed[base + 3]!;
    const across = dx * packed[base + 3]! - dz * packed[base + 2]!;
    const inverseA2 = packed[base + 4]!;
    const inverseB2 = packed[base + 5]!;
    const f = along * along * inverseA2 + across * across * inverseB2 - 1;
    const gradientU = along * inverseA2;
    const gradientV = across * inverseB2;
    const gradient = 2 * Math.sqrt(gradientU * gradientU + gradientV * gradientV);
    const distance = f / Math.max(gradient, 1e-6);
    const t = Math.min(1, Math.max(0, distance * packed[base + 7]!));
    const s = t * t * (3 - 2 * t);
    factor *= 1 - depth * (1 - s);
  }
  return factor;
}

/**
 * The field and its gradient at a world point: writes `[factor, d/dx, d/dz]`
 * into `out`. The twin needs the gradient for the normal of a sheltered
 * surface, whose height is `factor * h` and whose displacement is
 * `factor * D`; inside a basin and on the open sea it is exactly 0.
 */
export function seaShelterField(
  packed: Float64Array,
  x: number,
  z: number,
  out: Float64Array,
): Float64Array {
  let factor = 1;
  let gradientX = 0;
  let gradientZ = 0;
  for (let base = 0; base < packed.length; base += 8) {
    const depth = packed[base + 6]!;
    if (depth === 0) continue;
    const sine = packed[base + 2]!;
    const cosine = packed[base + 3]!;
    const dx = x - packed[base]!;
    const dz = z - packed[base + 1]!;
    const along = dx * sine + dz * cosine;
    const across = dx * cosine - dz * sine;
    const inverseA2 = packed[base + 4]!;
    const inverseB2 = packed[base + 5]!;
    const inverseFeather = packed[base + 7]!;
    const f = along * along * inverseA2 + across * across * inverseB2 - 1;
    const gradientU = along * inverseA2;
    const gradientV = across * inverseB2;
    const length = Math.sqrt(gradientU * gradientU + gradientV * gradientV);
    const gradient = 2 * length;
    const clamped = gradient < 1e-6;
    const denominator = clamped ? 1e-6 : gradient;
    const raw = (f / denominator) * inverseFeather;
    const t = Math.min(1, Math.max(0, raw));
    const s = t * t * (3 - 2 * t);
    const slot = 1 - depth * (1 - s);
    let slotX = 0;
    let slotZ = 0;
    if (raw > 0 && raw < 1) {
      // d(slot) = depth * s'(t) * d(distance) / feather, with
      // distance = f / g: d(distance) = (df g - f dg) / g^2.
      const fu = 2 * gradientU;
      const fv = 2 * gradientV;
      const fx = fu * sine + fv * cosine;
      const fz = fu * cosine - fv * sine;
      let distanceX = fx / denominator;
      let distanceZ = fz / denominator;
      if (!clamped) {
        // g = 2 |(u / a^2, v / b^2)|: dg/du = 4 (u / a^4) / g, likewise v.
        const gu = (4 * gradientU * inverseA2) / gradient;
        const gv = (4 * gradientV * inverseB2) / gradient;
        const gx = gu * sine + gv * cosine;
        const gz = gu * cosine - gv * sine;
        distanceX -= (f * gx) / (gradient * gradient);
        distanceZ -= (f * gz) / (gradient * gradient);
      }
      const slope = depth * 6 * t * (1 - t) * inverseFeather;
      slotX = slope * distanceX;
      slotZ = slope * distanceZ;
    }
    gradientX = gradientX * slot + factor * slotX;
    gradientZ = gradientZ * slot + factor * slotZ;
    factor *= slot;
  }
  out[0] = factor;
  out[1] = gradientX;
  out[2] = gradientZ;
  return out;
}

/**
 * The same field in WGSL, for the ocean's vertex stage. Requires the uniforms
 * `seaShelterA0..3` and `seaShelterB0..3` (`SEA_SHELTER_UNIFORMS`), bound from
 * `packSeaShelterEllipses`. No branch on unused slots: their `1 - floor` is 0,
 * which makes the slot's factor exactly 1.
 */
export const SEA_SHELTER_UNIFORMS: readonly string[] = Object.freeze(
  Array.from({ length: SEA_SHELTER_MAX_ELLIPSES }, (_, slot) => [`seaShelterA${slot}`, `seaShelterB${slot}`]).flat(),
);

export const SEA_SHELTER_DECLARATIONS_WGSL = Array.from(
  { length: SEA_SHELTER_MAX_ELLIPSES },
  (_, slot) => `uniform seaShelterA${slot}: vec4f;\nuniform seaShelterB${slot}: vec4f;`,
).join("\n");

export const SEA_SHELTER_WGSL = /* wgsl */ `
fn seaShelterSlot(worldXZ: vec2f, a: vec4f, b: vec4f) -> f32 {
  let offset = worldXZ - a.xy;
  let along = dot(offset, a.zw);
  let across = offset.x * a.w - offset.y * a.z;
  let f = along * along * b.x + across * across * b.y - 1.0;
  let gradient = 2.0 * length(vec2f(along * b.x, across * b.y));
  let distance = f / max(gradient, 1e-6);
  let t = clamp(distance * b.w, 0.0, 1.0);
  let s = t * t * (3.0 - 2.0 * t);
  return 1.0 - b.z * (1.0 - s);
}

fn seaShelterFactor(worldXZ: vec2f) -> f32 {
  return ${Array.from({ length: SEA_SHELTER_MAX_ELLIPSES }, (_, slot) =>
    `seaShelterSlot(worldXZ, uniforms.seaShelterA${slot}, uniforms.seaShelterB${slot})`).join("\n    * ")};
}
`;
