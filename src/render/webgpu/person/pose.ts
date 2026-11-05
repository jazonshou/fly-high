import { BIND_OFFSETS, BIND_POSITIONS, BONE_COUNT, BONE_PARENTS } from "./skeleton";

/**
 * One pose of the skeleton, and the arithmetic to build it, in plain arrays
 * so a frame allocates nothing.
 *
 * LOCAL: each bone's rotation (a unit quaternion x, y, z, w) about its own
 * origin in its parent's axes, its offset from the parent's origin, and a
 * uniform scale (the head shrinks to nothing in first person). GLOBAL: each
 * bone's rotation and origin in the root frame, from `computeGlobals`.
 * Quaternions compose as Hamilton products, `a * b` turning by `b` first.
 */
export class FigurePose {
  readonly rotations = new Float64Array(BONE_COUNT * 4);
  readonly offsets = new Float64Array(BONE_COUNT * 3);
  readonly scales = new Float64Array(BONE_COUNT);
  readonly globalRotations = new Float64Array(BONE_COUNT * 4);
  readonly globalPositions = new Float64Array(BONE_COUNT * 3);
  readonly globalScales = new Float64Array(BONE_COUNT);

  constructor() {
    this.reset();
  }

  /** The bind pose. */
  reset(): void {
    for (let bone = 0; bone < BONE_COUNT; bone += 1) {
      this.rotations[bone * 4] = 0;
      this.rotations[bone * 4 + 1] = 0;
      this.rotations[bone * 4 + 2] = 0;
      this.rotations[bone * 4 + 3] = 1;
      this.offsets[bone * 3] = BIND_OFFSETS[bone * 3]!;
      this.offsets[bone * 3 + 1] = BIND_OFFSETS[bone * 3 + 1]!;
      this.offsets[bone * 3 + 2] = BIND_OFFSETS[bone * 3 + 2]!;
      this.scales[bone] = 1;
    }
  }

  copyFrom(other: FigurePose): void {
    this.rotations.set(other.rotations);
    this.offsets.set(other.offsets);
    this.scales.set(other.scales);
  }

  /** Root-frame rotations and origins, parents first. */
  computeGlobals(): void {
    const r = this.rotations;
    const o = this.offsets;
    const gr = this.globalRotations;
    const gp = this.globalPositions;
    const gs = this.globalScales;
    for (let bone = 0; bone < BONE_COUNT; bone += 1) {
      const parent = BONE_PARENTS[bone]!;
      if (parent < 0) {
        gr.set(r.subarray(bone * 4, bone * 4 + 4), bone * 4);
        gp.set(o.subarray(bone * 3, bone * 3 + 3), bone * 3);
        gs[bone] = this.scales[bone]!;
        continue;
      }
      multiplyQuaternions(gr, parent * 4, r, bone * 4, gr, bone * 4);
      // The offset, scaled and turned by the parent, from the parent's origin.
      rotateVector(gr, parent * 4, o[bone * 3]!, o[bone * 3 + 1]!, o[bone * 3 + 2]!, gp, bone * 3);
      const scale = gs[parent]!;
      gp[bone * 3] = gp[parent * 3]! + gp[bone * 3]! * scale;
      gp[bone * 3 + 1] = gp[parent * 3 + 1]! + gp[bone * 3 + 1]! * scale;
      gp[bone * 3 + 2] = gp[parent * 3 + 2]! + gp[bone * 3 + 2]! * scale;
      gs[bone] = scale * this.scales[bone]!;
    }
  }

  /** Sets a bone's local rotation to `angle` radians about the unit axis (x, y, z). */
  setAxisAngle(bone: number, x: number, y: number, z: number, angle: number): void {
    setAxisAngle(this.rotations, bone * 4, x, y, z, angle);
  }

  /**
   * Sets a bone's local rotation from body-axis angles, applied twist (Y)
   * first, then abduction (X), then flexion (Z): a joint's flexion axis stays
   * the body's lateral axis whatever the abduction.
   */
  setJoint(bone: number, flexion: number, abduction: number, twist: number): void {
    setEuler(this.rotations, bone * 4, flexion, abduction, twist);
  }

  /** Turns a bone further by `angle` about the parent-frame axis (x, y, z): pre-multiplies. */
  turnBy(bone: number, x: number, y: number, z: number, angle: number): void {
    setAxisAngle(SCRATCH, 0, x, y, z, angle);
    multiplyQuaternions(SCRATCH, 0, this.rotations, bone * 4, this.rotations, bone * 4);
  }

  /** A root-frame point carried rigidly by `bone`: its bind-pose position `bindPoint` posed. */
  posedPoint(bone: number, bindX: number, bindY: number, bindZ: number, out: Float64Array, outOffset = 0): Float64Array {
    const scale = this.globalScales[bone]!;
    rotateVector(
      this.globalRotations,
      bone * 4,
      (bindX - BIND_POSITIONS[bone * 3]!) * scale,
      (bindY - BIND_POSITIONS[bone * 3 + 1]!) * scale,
      (bindZ - BIND_POSITIONS[bone * 3 + 2]!) * scale,
      out,
      outOffset,
    );
    out[outOffset] = out[outOffset]! + this.globalPositions[bone * 3]!;
    out[outOffset + 1] = out[outOffset + 1]! + this.globalPositions[bone * 3 + 1]!;
    out[outOffset + 2] = out[outOffset + 2]! + this.globalPositions[bone * 3 + 2]!;
    return out;
  }

  /**
   * Each bone's posed transform in the root frame (column vectors,
   * column-major 4x4, which is also Babylon's row-vector layout): turn and
   * scale about the bone's origin, then move to its posed origin. With the
   * bones' bind transforms at their bind positions, this is what Babylon's
   * skeleton takes as a parentless bone's matrix.
   */
  globalMatrices(out: Float32Array | Float64Array): void {
    for (let bone = 0; bone < BONE_COUNT; bone += 1) {
      writeRotationScale(this.globalRotations, bone * 4, this.globalScales[bone]!, out, bone * 16);
      out[bone * 16 + 12] = this.globalPositions[bone * 3]!;
      out[bone * 16 + 13] = this.globalPositions[bone * 3 + 1]!;
      out[bone * 16 + 14] = this.globalPositions[bone * 3 + 2]!;
    }
  }

  /**
   * Each bone's skinning matrix (bind-to-posed, column vectors, column-major
   * 4x4) into `out`, `BONE_COUNT` x 16: what the GPU's skinning multiplies a
   * bind-pose vertex by.
   */
  skinMatrices(out: Float32Array | Float64Array): void {
    for (let bone = 0; bone < BONE_COUNT; bone += 1) {
      const q = bone * 4;
      const x = this.globalRotations[q]!;
      const y = this.globalRotations[q + 1]!;
      const z = this.globalRotations[q + 2]!;
      const w = this.globalRotations[q + 3]!;
      const s = this.globalScales[bone]!;
      const m = bone * 16;
      const r00 = (1 - 2 * (y * y + z * z)) * s;
      const r01 = 2 * (x * y - z * w) * s;
      const r02 = 2 * (x * z + y * w) * s;
      const r10 = 2 * (x * y + z * w) * s;
      const r11 = (1 - 2 * (x * x + z * z)) * s;
      const r12 = 2 * (y * z - x * w) * s;
      const r20 = 2 * (x * z - y * w) * s;
      const r21 = 2 * (y * z + x * w) * s;
      const r22 = (1 - 2 * (x * x + y * y)) * s;
      const bx = BIND_POSITIONS[bone * 3]!;
      const by = BIND_POSITIONS[bone * 3 + 1]!;
      const bz = BIND_POSITIONS[bone * 3 + 2]!;
      // posed = R s (v - bind) + origin
      out[m] = r00;
      out[m + 1] = r10;
      out[m + 2] = r20;
      out[m + 3] = 0;
      out[m + 4] = r01;
      out[m + 5] = r11;
      out[m + 6] = r21;
      out[m + 7] = 0;
      out[m + 8] = r02;
      out[m + 9] = r12;
      out[m + 10] = r22;
      out[m + 11] = 0;
      out[m + 12] = this.globalPositions[bone * 3]! - (r00 * bx + r01 * by + r02 * bz);
      out[m + 13] = this.globalPositions[bone * 3 + 1]! - (r10 * bx + r11 * by + r12 * bz);
      out[m + 14] = this.globalPositions[bone * 3 + 2]! - (r20 * bx + r21 * by + r22 * bz);
      out[m + 15] = 1;
    }
  }
}

const SCRATCH = new Float64Array(8);

/** A rotation and uniform scale as the upper 3x3 of a column-major 4x4 at `out[m]`; the rest of the row/column zero, w 1. */
function writeRotationScale(q: Float64Array, qo: number, s: number, out: Float32Array | Float64Array, m: number): void {
  const x = q[qo]!;
  const y = q[qo + 1]!;
  const z = q[qo + 2]!;
  const w = q[qo + 3]!;
  out[m] = (1 - 2 * (y * y + z * z)) * s;
  out[m + 1] = 2 * (x * y + z * w) * s;
  out[m + 2] = 2 * (x * z - y * w) * s;
  out[m + 3] = 0;
  out[m + 4] = 2 * (x * y - z * w) * s;
  out[m + 5] = (1 - 2 * (x * x + z * z)) * s;
  out[m + 6] = 2 * (y * z + x * w) * s;
  out[m + 7] = 0;
  out[m + 8] = 2 * (x * z + y * w) * s;
  out[m + 9] = 2 * (y * z - x * w) * s;
  out[m + 10] = (1 - 2 * (x * x + y * y)) * s;
  out[m + 11] = 0;
  out[m + 15] = 1;
}

export function setAxisAngle(out: Float64Array, offset: number, x: number, y: number, z: number, angle: number): void {
  const half = angle * 0.5;
  const s = Math.sin(half);
  out[offset] = x * s;
  out[offset + 1] = y * s;
  out[offset + 2] = z * s;
  out[offset + 3] = Math.cos(half);
}

/** q = Rz(flexion) * Rx(abduction) * Ry(twist). */
export function setEuler(out: Float64Array, offset: number, flexion: number, abduction: number, twist: number): void {
  const cz = Math.cos(flexion * 0.5);
  const sz = Math.sin(flexion * 0.5);
  const cx = Math.cos(abduction * 0.5);
  const sx = Math.sin(abduction * 0.5);
  const cy = Math.cos(twist * 0.5);
  const sy = Math.sin(twist * 0.5);
  // Rz * Rx
  const ax = cz * sx;
  const ay = sz * sx;
  const az = sz * cx;
  const aw = cz * cx;
  // (Rz Rx) * Ry
  out[offset] = ax * cy - az * sy;
  out[offset + 1] = aw * sy + ay * cy;
  out[offset + 2] = az * cy + ax * sy;
  out[offset + 3] = aw * cy - ay * sy;
}

/** out = a * b (Hamilton), `out` may alias either. */
export function multiplyQuaternions(
  a: Float64Array, ao: number,
  b: Float64Array, bo: number,
  out: Float64Array, oo: number,
): void {
  const ax = a[ao]!;
  const ay = a[ao + 1]!;
  const az = a[ao + 2]!;
  const aw = a[ao + 3]!;
  const bx = b[bo]!;
  const by = b[bo + 1]!;
  const bz = b[bo + 2]!;
  const bw = b[bo + 3]!;
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** The vector (x, y, z) turned by the quaternion at `q[qo]`, into `out[oo]`. */
export function rotateVector(q: Float64Array, qo: number, x: number, y: number, z: number, out: Float64Array, oo: number): void {
  const qx = q[qo]!;
  const qy = q[qo + 1]!;
  const qz = q[qo + 2]!;
  const qw = q[qo + 3]!;
  // t = 2 q x v; v' = v + w t + q x t
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[oo] = x + qw * tx + (qy * tz - qz * ty);
  out[oo + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[oo + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** The vector turned by the INVERSE of the quaternion. */
export function rotateVectorInverse(q: Float64Array, qo: number, x: number, y: number, z: number, out: Float64Array, oo: number): void {
  INVERSE[0] = -q[qo]!;
  INVERSE[1] = -q[qo + 1]!;
  INVERSE[2] = -q[qo + 2]!;
  INVERSE[3] = q[qo + 3]!;
  rotateVector(INVERSE, 0, x, y, z, out, oo);
}

const INVERSE = new Float64Array(4);

/** Normalised lerp of two quaternions (shortest way), into `out`. */
export function nlerpQuaternions(
  a: Float64Array, ao: number,
  b: Float64Array, bo: number,
  t: number,
  out: Float64Array, oo: number,
): void {
  const dot = a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
  const sign = dot < 0 ? -1 : 1;
  const u = 1 - t;
  const x = a[ao]! * u + b[bo]! * t * sign;
  const y = a[ao + 1]! * u + b[bo + 1]! * t * sign;
  const z = a[ao + 2]! * u + b[bo + 2]! * t * sign;
  const w = a[ao + 3]! * u + b[bo + 3]! * t * sign;
  const length = Math.hypot(x, y, z, w) || 1;
  out[oo] = x / length;
  out[oo + 1] = y / length;
  out[oo + 2] = z / length;
  out[oo + 3] = w / length;
}

/** Blends pose `b` into `a` by `t` (0 keeps `a`), rotations, offsets and scales. */
export function blendPoses(a: FigurePose, b: FigurePose, t: number, out: FigurePose): void {
  if (t <= 0) {
    if (out !== a) out.copyFrom(a);
    return;
  }
  if (t >= 1) {
    if (out !== b) out.copyFrom(b);
    return;
  }
  for (let bone = 0; bone < BONE_COUNT; bone += 1) {
    nlerpQuaternions(a.rotations, bone * 4, b.rotations, bone * 4, t, out.rotations, bone * 4);
    for (let axis = 0; axis < 3; axis += 1) {
      const i = bone * 3 + axis;
      out.offsets[i] = a.offsets[i]! + (b.offsets[i]! - a.offsets[i]!) * t;
    }
    out.scales[bone] = a.scales[bone]! + (b.scales[bone]! - a.scales[bone]!) * t;
  }
}

/** The shortest rotation taking unit `from` to unit `to`, into `out`. */
export function rotationBetween(
  fx: number, fy: number, fz: number,
  tx: number, ty: number, tz: number,
  out: Float64Array, oo: number,
): void {
  const dot = fx * tx + fy * ty + fz * tz;
  if (dot < -0.999999) {
    // Opposite: half a turn about any axis square to `from`.
    let ax = 0;
    let ay = -fz;
    let az = fy;
    if (Math.hypot(ay, az) < 1e-6) {
      ax = fz;
      ay = 0;
      az = -fx;
    }
    const length = Math.hypot(ax, ay, az);
    setAxisAngle(out, oo, ax / length, ay / length, az / length, Math.PI);
    return;
  }
  const cx = fy * tz - fz * ty;
  const cy = fz * tx - fx * tz;
  const cz = fx * ty - fy * tx;
  const w = 1 + dot;
  const length = Math.hypot(cx, cy, cz, w);
  out[oo] = cx / length;
  out[oo + 1] = cy / length;
  out[oo + 2] = cz / length;
  out[oo + 3] = w / length;
}
