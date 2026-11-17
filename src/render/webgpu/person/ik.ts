import { BONE_PARENTS } from "./skeleton";
import { multiplyQuaternions, rotationBetween, type FigurePose } from "./pose";

/**
 * Two-bone analytic inverse kinematics on a posed skeleton: the leg
 * (thigh, shin, foot) and the arm (upper arm, forearm, hand).
 *
 * The chain keeps the plane its forward-kinematic pose bends in (the pole is
 * where the middle joint already is), so the knee stays over the toes and
 * the elbow where the gait put it; each bone turns by the smallest rotation
 * that takes it from where it was to where it must go. `pose.computeGlobals`
 * must be current on entry; it is current again on return.
 */
const scratch = new Float64Array(16);

/**
 * Moves `end`'s origin (the ankle or wrist) to the root-frame target
 * (tx, ty, tz), or as near as the two bones reach. Returns how far short it
 * stopped, metres (0 when it reached).
 */
export function solveTwoBone(
  pose: FigurePose,
  upper: number,
  lower: number,
  end: number,
  tx: number,
  ty: number,
  tz: number,
): number {
  const gp = pose.globalPositions;
  const hx = gp[upper * 3]!;
  const hy = gp[upper * 3 + 1]!;
  const hz = gp[upper * 3 + 2]!;
  const kx = gp[lower * 3]!;
  const ky = gp[lower * 3 + 1]!;
  const kz = gp[lower * 3 + 2]!;
  const ax = gp[end * 3]!;
  const ay = gp[end * 3 + 1]!;
  const az = gp[end * 3 + 2]!;
  const l1 = Math.hypot(kx - hx, ky - hy, kz - hz);
  const l2 = Math.hypot(ax - kx, ay - ky, az - kz);
  let dx = tx - hx;
  let dy = ty - hy;
  let dz = tz - hz;
  const wanted = Math.hypot(dx, dy, dz);
  if (wanted < 1e-6 || l1 < 1e-6 || l2 < 1e-6) return wanted;
  dx /= wanted;
  dy /= wanted;
  dz /= wanted;
  // Never quite straight: a fully straight knee has no bend plane left.
  const reach = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, wanted));
  const shortfall = Math.max(0, wanted - reach);
  // The bend direction: the current middle joint, square to the hip-target line.
  let px = kx - hx;
  let py = ky - hy;
  let pz = kz - hz;
  const along = px * dx + py * dy + pz * dz;
  px -= along * dx;
  py -= along * dy;
  pz -= along * dz;
  let pole = Math.hypot(px, py, pz);
  if (pole < 1e-6) {
    // Straight already: bend toward the current end's side of the line, or forward.
    px = 1 - dx * dx;
    py = -dx * dy;
    pz = -dx * dz;
    pole = Math.hypot(px, py, pz) || 1;
  }
  px /= pole;
  py /= pole;
  pz /= pole;
  const cosUpper = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach);
  const sinUpper = Math.sqrt(Math.max(0, 1 - cosUpper * cosUpper));
  // The middle joint's new place.
  const nkx = hx + l1 * (cosUpper * dx + sinUpper * px);
  const nky = hy + l1 * (cosUpper * dy + sinUpper * py);
  const nkz = hz + l1 * (cosUpper * dz + sinUpper * pz);
  // Upper bone: the smallest turn from the old middle joint to the new.
  rotationBetween((kx - hx) / l1, (ky - hy) / l1, (kz - hz) / l1, (nkx - hx) / l1, (nky - hy) / l1, (nkz - hz) / l1, scratch, 0);
  const gr = pose.globalRotations;
  // New upper global = turn * old upper global.
  multiplyQuaternions(scratch, 0, gr, upper * 4, scratch, 4);
  // The lower bone's old direction, carried by the upper's turn, then turned onto the target.
  const ex = reach * dx + hx - nkx;
  const ey = reach * dy + hy - nky;
  const ez = reach * dz + hz - nkz;
  const el = Math.hypot(ex, ey, ez) || 1;
  turnVector(scratch, 0, (ax - kx) / l2, (ay - ky) / l2, (az - kz) / l2, scratch, 12);
  rotationBetween(scratch[12]!, scratch[13]!, scratch[14]!, ex / el, ey / el, ez / el, scratch, 8);
  // New lower global = turn2 * turn1 * old lower global.
  multiplyQuaternions(scratch, 0, gr, lower * 4, scratch, 12);
  multiplyQuaternions(scratch, 8, scratch, 12, scratch, 12);
  // Back to locals: upper local = parent^-1 * new upper; lower local = new upper^-1 * new lower.
  setLocalFromGlobal(pose, upper, BONE_PARENTS[upper]!, scratch, 4, gr);
  setLocalFromGlobalRelative(pose, lower, scratch, 4, scratch, 12);
  pose.computeGlobals();
  return shortfall;
}

/**
 * Sets `bone`'s local rotation so its global rotation becomes `global[go]`,
 * given its parent's current global (`pose.globalRotations`).
 */
export function setGlobalRotation(pose: FigurePose, bone: number, global: Float64Array, go: number): void {
  setLocalFromGlobal(pose, bone, BONE_PARENTS[bone]!, global, go, pose.globalRotations);
}

function setLocalFromGlobal(pose: FigurePose, bone: number, parent: number, global: Float64Array, go: number, parentGlobals: Float64Array): void {
  if (parent < 0) {
    pose.rotations.set(global.subarray(go, go + 4), bone * 4);
    return;
  }
  INVERSE[0] = -parentGlobals[parent * 4]!;
  INVERSE[1] = -parentGlobals[parent * 4 + 1]!;
  INVERSE[2] = -parentGlobals[parent * 4 + 2]!;
  INVERSE[3] = parentGlobals[parent * 4 + 3]!;
  multiplyQuaternions(INVERSE, 0, global, go, pose.rotations, bone * 4);
}

function setLocalFromGlobalRelative(pose: FigurePose, bone: number, parentGlobal: Float64Array, po: number, global: Float64Array, go: number): void {
  INVERSE[0] = -parentGlobal[po]!;
  INVERSE[1] = -parentGlobal[po + 1]!;
  INVERSE[2] = -parentGlobal[po + 2]!;
  INVERSE[3] = parentGlobal[po + 3]!;
  multiplyQuaternions(INVERSE, 0, global, go, pose.rotations, bone * 4);
}

const INVERSE = new Float64Array(4);

function turnVector(q: Float64Array, qo: number, x: number, y: number, z: number, out: Float64Array, oo: number): void {
  const qx = q[qo]!;
  const qy = q[qo + 1]!;
  const qz = q[qo + 2]!;
  const qw = q[qo + 3]!;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[oo] = x + qw * tx + (qy * tz - qz * ty);
  out[oo + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[oo + 2] = z + qw * tz + (qx * ty - qy * tx);
}
