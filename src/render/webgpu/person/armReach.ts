import { multiplyQuaternions, nlerpQuaternions, rotateVector, rotationBetween, setAxisAngle, type FigurePose } from "./pose";
import { BIND_POSITIONS, BONE, BONE_PARENTS, SIDES } from "./skeleton";

/**
 * An arm reaching for a hold, as an arm does it.
 *
 * `solveTwoBone` puts a wrist on a point and leaves the rest to chance: the
 * elbow where the pose before had it, the hand pointed at the hold whichever
 * way up, the arm drawn out dead straight to a hold at its length's end. An
 * arm reaching a door's handle that way is a rod with a hand on the end of
 * it. This solves the whole arm from what an arm is:
 *
 *  - THE ELBOW IS A HINGE. Its axis is square to the plane the arm bends in,
 *    so the upper arm's roll follows from where the elbow goes (the humerus
 *    turns in the shoulder as the elbow swings), and the elbow goes down, out
 *    and a little back of the line from the shoulder to the wrist, as a
 *    relaxed arm's does.
 *  - AN ARM IS NOT USED STRAIGHT. Past `REACH_EASY` of its length it draws
 *    out only asymptotically to `REACH_MOST` (the elbow still 35 degrees
 *    bent), and the trunk and the shoulder girdle go after a hold beyond
 *    that: the chest turns and leans toward it and the clavicle carries the
 *    shoulder a few centimetres (`reachFor`).
 *  - THE HAND HOLDS WHAT IT IS ON. A hold is either IN LINE (a bar or a rim
 *    taken end on: the hand carries on from the forearm, thumb side up, the
 *    wrist a palm short of it) or A PALM'S (a ledge, an armrest, a handle
 *    taken from over it: the palm faces the way it is told and the fingers
 *    lie the way they are told, the wrist behind the hold along them).
 *  - THE FOREARM TURNS, NOT THE WRIST. Most of the hand's roll about the
 *    forearm's long axis is pronation: the forearm carries it, and the wrist
 *    only bends.
 *
 * A hold's weight blends the solved arm with the arm the pose had, bone by
 * bone, so a hand goes to a hold and leaves it on an arc about the shoulder
 * and the elbow, not along a ruler.
 *
 * ESTIMATES: the reach's shares, the elbow's place, the trunk's and the
 * girdle's shares of a long reach.
 */

/** The share of the arm's length a hold is reached at with no strain. */
const REACH_EASY = 0.86;
/** The most of its length the arm is ever drawn out to. */
const REACH_MOST = 0.955;
/** The wrist to the middle of the palm, metres. */
export const PALM_REACH = 0.075;
/** The palm's middle stands this far off what the palm lies on. */
const PALM_THICKNESS = 0.02;
/** The most the chest turns after a far hold, radians, and the most the clavicle does. */
const CHEST_MOST = 0.2;
const CLAVICLE_MOST = 0.3;
/** How much of the hand's roll about the forearm the forearm takes, and the most it takes, radians. */
const PRONATION_SHARE = 0.85;
const PRONATION_MOST = 1.7;
/** Where the elbow goes off the line from the shoulder to the wrist, in the chest's axes: back, down and out. */
const ELBOW_BACK = -0.3;
const ELBOW_DOWN = -0.85;
const ELBOW_OUT = 0.5;

/** One hand's hold, as the motion that owns it writes it each frame. */
export interface Hold {
  /** The point held, root frame. */
  x: number;
  y: number;
  z: number;
  /** 0 (the arm as posed) .. 1 (on the hold). */
  weight: number;
  /** 0 in line .. 1 a palm's hold, with the way the palm faces (a unit vector, root frame). */
  palm: number;
  /**
   * A palm's hold: 0 the fingers lie the way the forearm comes to it (a hand
   * laid on a ledge) .. 1 the way they are told (a unit vector, root frame).
   */
  told: number;
  fingersX: number;
  fingersY: number;
  fingersZ: number;
  palmX: number;
  palmY: number;
  palmZ: number;
}

export function createHold(): Hold {
  return { x: 0, y: 0, z: 0, weight: 0, palm: 0, told: 0, fingersX: 1, fingersY: 0, fingersZ: 0, palmX: 0, palmY: -1, palmZ: 0 };
}

/**
 * Holds `a` and `b` together into `out`, each by its weight: a hand going
 * from one to the other passes between them, and its weight (their sum, no
 * more than 1) dips on the way if theirs do, so it leaves the one and comes
 * to the other on the arm's own arc.
 */
export function mixHolds(a: Hold, b: Hold, out: Hold): void {
  const total = a.weight + b.weight;
  out.weight = Math.min(1, total);
  if (total <= 0) return;
  const s = b.weight / total;
  out.x = a.x + (b.x - a.x) * s;
  out.y = a.y + (b.y - a.y) * s;
  out.z = a.z + (b.z - a.z) * s;
  out.palm = a.palm + (b.palm - a.palm) * s;
  out.told = a.told + (b.told - a.told) * s;
  out.fingersX = a.fingersX + (b.fingersX - a.fingersX) * s;
  out.fingersY = a.fingersY + (b.fingersY - a.fingersY) * s;
  out.fingersZ = a.fingersZ + (b.fingersZ - a.fingersZ) * s;
  out.palmX = a.palmX + (b.palmX - a.palmX) * s;
  out.palmY = a.palmY + (b.palmY - a.palmY) * s;
  out.palmZ = a.palmZ + (b.palmZ - a.palmZ) * s;
}

interface ArmBind {
  readonly upper: number;
  readonly lower: number;
  /** The upper arm's and the forearm's directions, the elbow's hinge square to each, the fingers' and the palm's. */
  readonly upperDir: readonly number[];
  readonly upperHinge: readonly number[];
  readonly lowerDir: readonly number[];
  readonly lowerHinge: readonly number[];
  readonly fingers: readonly number[];
  readonly palm: readonly number[];
}

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** `v` made square to unit `axis`, unit length. */
function squareTo(v: readonly number[], axis: readonly number[]): [number, number, number] {
  const d = v[0]! * axis[0]! + v[1]! * axis[1]! + v[2]! * axis[2]!;
  return unit(v[0]! - d * axis[0]!, v[1]! - d * axis[1]!, v[2]! - d * axis[2]!);
}

const ARMS: readonly ArmBind[] = SIDES.map((side) => {
  const at = (bone: number, k: number): number => BIND_POSITIONS[bone * 3 + k]!;
  const between = (a: number, b: number): [number, number, number] => unit(at(b, 0) - at(a, 0), at(b, 1) - at(a, 1), at(b, 2) - at(a, 2));
  const length = (a: number, b: number): number => Math.hypot(at(b, 0) - at(a, 0), at(b, 1) - at(a, 1), at(b, 2) - at(a, 2));
  const upperDir = between(side.upperArm, side.forearm);
  const lowerDir = between(side.forearm, side.hand);
  const fingers = between(side.hand, side.fingers);
  // The elbow bends about the body's +Z in the bind pose, and the palm faces the thigh.
  return {
    upper: length(side.upperArm, side.forearm),
    lower: length(side.forearm, side.hand),
    upperDir,
    upperHinge: squareTo([0, 0, 1], upperDir),
    lowerDir,
    lowerHinge: squareTo([0, 0, 1], lowerDir),
    fingers,
    palm: squareTo([0, 0, -side.sign], fingers),
  };
});

/** The arm's length from the shoulder to the wrist. */
export const ARM_REACH = ARMS[0]!.upper + ARMS[0]!.lower;

/** How far a wrist goes toward a point `distance` from its shoulder. */
export function easyReach(distance: number): number {
  const from = ARM_REACH * REACH_EASY;
  if (distance <= from) return distance;
  const room = ARM_REACH * (REACH_MOST - REACH_EASY);
  return from + room * (1 - Math.exp(-(distance - from) / room));
}

const q = new Float64Array(40);
const v = new Float64Array(24);
/** The wrists' places wanted, per hand. */
const wrist = new Float64Array(6);
/** A palm's hold's ways: the fingers', then the palm's, square to each other. */
const ways = new Float64Array(6);
/** The arm as bent to the wrist's place: the upper arm's way, the forearm's, the elbow's hinge. */
const bent = new Float64Array(9);

/**
 * The rotation taking the unit pair (a1, b1), square to each other, onto the
 * pair (a2, b2), into `out[oo]`.
 */
function frameQuaternion(a1: readonly number[], b1: readonly number[], a2x: number, a2y: number, a2z: number, b2x: number, b2y: number, b2z: number, out: Float64Array, oo: number): void {
  const c1x = a1[1]! * b1[2]! - a1[2]! * b1[1]!;
  const c1y = a1[2]! * b1[0]! - a1[0]! * b1[2]!;
  const c1z = a1[0]! * b1[1]! - a1[1]! * b1[0]!;
  const c2x = a2y * b2z - a2z * b2y;
  const c2y = a2z * b2x - a2x * b2z;
  const c2z = a2x * b2y - a2y * b2x;
  // R = [a2 b2 c2] [a1 b1 c1]^T
  const m00 = a2x * a1[0]! + b2x * b1[0]! + c2x * c1x;
  const m01 = a2x * a1[1]! + b2x * b1[1]! + c2x * c1y;
  const m02 = a2x * a1[2]! + b2x * b1[2]! + c2x * c1z;
  const m10 = a2y * a1[0]! + b2y * b1[0]! + c2y * c1x;
  const m11 = a2y * a1[1]! + b2y * b1[1]! + c2y * c1y;
  const m12 = a2y * a1[2]! + b2y * b1[2]! + c2y * c1z;
  const m20 = a2z * a1[0]! + b2z * b1[0]! + c2z * c1x;
  const m21 = a2z * a1[1]! + b2z * b1[1]! + c2z * c1y;
  const m22 = a2z * a1[2]! + b2z * b1[2]! + c2z * c1z;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  out[oo] = x / l;
  out[oo + 1] = y / l;
  out[oo + 2] = z / l;
  out[oo + 3] = w / l;
}

/** Sets `bone`'s local rotation so its global one is `global[go]` under the parent's global `parent[po]`. */
function setLocal(pose: FigurePose, bone: number, parent: Float64Array, po: number, global: Float64Array, go: number): void {
  q[36] = -parent[po]!;
  q[37] = -parent[po + 1]!;
  q[38] = -parent[po + 2]!;
  q[39] = parent[po + 3]!;
  multiplyQuaternions(q, 36, global, go, pose.rotations, bone * 4);
}

/**
 * A palm's hold's ways into `ways`: the palm's as told, and the fingers'
 * square to it, as told or along (ax, ay, az) by the hold's `told`.
 */
function handWays(hold: Hold, ax: number, ay: number, az: number): void {
  const nl = Math.hypot(hold.palmX, hold.palmY, hold.palmZ) || 1;
  const nx = hold.palmX / nl;
  const ny = hold.palmY / nl;
  const nz = hold.palmZ / nl;
  let fx = hold.fingersX * hold.told + ax * (1 - hold.told);
  let fy = hold.fingersY * hold.told + ay * (1 - hold.told);
  let fz = hold.fingersZ * hold.told + az * (1 - hold.told);
  let dot = fx * nx + fy * ny + fz * nz;
  fx -= dot * nx;
  fy -= dot * ny;
  fz -= dot * nz;
  let fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-4) {
    // Straight at the palm: the fingers as told, or any way square to it.
    fx = hold.fingersX;
    fy = hold.fingersY;
    fz = hold.fingersZ;
    dot = fx * nx + fy * ny + fz * nz;
    fx -= dot * nx;
    fy -= dot * ny;
    fz -= dot * nz;
    fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-4) {
      fx = ny;
      fy = -nx;
      fz = 0;
      fl = Math.hypot(fx, fy) || 1;
    }
  }
  ways[0] = fx / fl;
  ways[1] = fy / fl;
  ways[2] = fz / fl;
  ways[3] = nx;
  ways[4] = ny;
  ways[5] = nz;
}

/**
 * Where hand `side`'s wrist goes for its hold, into `wrist`. In line: a palm
 * short of the hold, toward the shoulder. A palm's: behind the hold along
 * the fingers and off it by the palm's thickness, the fingers lying along
 * the forearm as `bent` has it (`follow`) or, before the arm is bent, along
 * the line from the shoulder.
 */
function wristFor(pose: FigurePose, side: number, hold: Hold, follow: boolean): void {
  const gp = pose.globalPositions;
  const shoulder = SIDES[side]!.upperArm * 3;
  const sx = gp[shoulder]!;
  const sy = gp[shoulder + 1]!;
  const sz = gp[shoulder + 2]!;
  const dx = hold.x - sx;
  const dy = hold.y - sy;
  const dz = hold.z - sz;
  const d = Math.hypot(dx, dy, dz) || 1;
  const short = Math.max(0, d - PALM_REACH) / d;
  const p = hold.palm;
  let px = 0;
  let py = 0;
  let pz = 0;
  if (p > 0) {
    if (follow) handWays(hold, bent[3]!, bent[4]!, bent[5]!);
    else handWays(hold, dx / d, dy / d, dz / d);
    px = hold.x - ways[0]! * PALM_REACH - ways[3]! * PALM_THICKNESS;
    py = hold.y - ways[1]! * PALM_REACH - ways[4]! * PALM_THICKNESS;
    pz = hold.z - ways[2]! * PALM_REACH - ways[5]! * PALM_THICKNESS;
  }
  wrist[side * 3] = (sx + dx * short) * (1 - p) + px * p;
  wrist[side * 3 + 1] = (sy + dy * short) * (1 - p) + py * p;
  wrist[side * 3 + 2] = (sz + dz * short) * (1 - p) + pz * p;
}

/**
 * Both hands to their holds (`left`, `right`), on the pose as posed and with
 * its globals current; they are current again on return.
 */
export function reachFor(pose: FigurePose, left: Hold, right: Hold): void {
  if (left.weight <= 0 && right.weight <= 0) return;
  const gp = pose.globalPositions;
  const gr = pose.globalRotations;

  // The trunk goes after a hold the arm would have to straighten for: the chest turns about its own root.
  let rx = 0;
  let ry = 0;
  let rz = 0;
  const chest = BONE.spine3;
  for (let side = 0; side < 2; side += 1) {
    const hold = side === 0 ? left : right;
    if (hold.weight <= 0) continue;
    wristFor(pose, side, hold, false);
    const shoulder = SIDES[side]!.upperArm * 3;
    const dx = wrist[side * 3]! - gp[shoulder]!;
    const dy = wrist[side * 3 + 1]! - gp[shoulder + 1]!;
    const dz = wrist[side * 3 + 2]! - gp[shoulder + 2]!;
    const d = Math.hypot(dx, dy, dz) || 1;
    const over = Math.min(0.14, Math.max(0, d - ARM_REACH * REACH_EASY)) * hold.weight;
    if (over <= 0) continue;
    // The shoulder's arm about the chest's root, and the small turn that carries it `over` toward the hold.
    const ax = gp[shoulder]! - gp[chest * 3]!;
    const ay = gp[shoulder + 1]! - gp[chest * 3 + 1]!;
    const az = gp[shoulder + 2]! - gp[chest * 3 + 2]!;
    const k = (0.7 * over) / (d * (ax * ax + ay * ay + az * az));
    rx += (ay * dz - az * dy) * k;
    ry += (az * dx - ax * dz) * k;
    rz += (ax * dy - ay * dx) * k;
  }
  const turn = Math.hypot(rx, ry, rz);
  if (turn > 1e-5) {
    const angle = Math.min(CHEST_MOST, turn);
    setAxisAngle(q, 0, rx / turn, ry / turn, rz / turn, angle);
    multiplyQuaternions(q, 0, gr, chest * 4, q, 4);
    setLocal(pose, chest, gr, BONE_PARENTS[chest]! * 4, q, 4);
    // The head stays more level than the chest: the neck gives half of it back.
    setAxisAngle(q, 0, rx / turn, ry / turn, rz / turn, -0.5 * angle);
    multiplyQuaternions(q, 0, q, 4, q, 8);
    multiplyQuaternions(q, 8, pose.rotations, BONE.neck * 4, q, 12);
    setLocal(pose, BONE.neck, q, 4, q, 12);
    pose.computeGlobals();
  }

  // The shoulder girdle after it: each clavicle swings its shoulder toward a hold still beyond the easy reach.
  let girdle = false;
  for (let side = 0; side < 2; side += 1) {
    const hold = side === 0 ? left : right;
    if (hold.weight <= 0) continue;
    const bones = SIDES[side]!;
    wristFor(pose, side, hold, false);
    const shoulder = bones.upperArm * 3;
    const dx = wrist[side * 3]! - gp[shoulder]!;
    const dy = wrist[side * 3 + 1]! - gp[shoulder + 1]!;
    const dz = wrist[side * 3 + 2]! - gp[shoulder + 2]!;
    const d = Math.hypot(dx, dy, dz) || 1;
    const over = Math.min(0.06, Math.max(0, d - ARM_REACH * REACH_EASY)) * hold.weight;
    if (over <= 0) continue;
    const c = bones.clavicle;
    const ax = gp[shoulder]! - gp[c * 3]!;
    const ay = gp[shoulder + 1]! - gp[c * 3 + 1]!;
    const az = gp[shoulder + 2]! - gp[c * 3 + 2]!;
    const k = over / (d * (ax * ax + ay * ay + az * az));
    const cx = (ay * dz - az * dy) * k;
    const cy = (az * dx - ax * dz) * k;
    const cz = (ax * dy - ay * dx) * k;
    const swing = Math.hypot(cx, cy, cz);
    if (swing < 1e-5) continue;
    setAxisAngle(q, 0, cx / swing, cy / swing, cz / swing, Math.min(CLAVICLE_MOST, swing));
    multiplyQuaternions(q, 0, gr, c * 4, q, 4);
    setLocal(pose, c, gr, BONE_PARENTS[c]! * 4, q, 4);
    girdle = true;
  }
  if (girdle) pose.computeGlobals();

  for (let side = 0; side < 2; side += 1) {
    const hold = side === 0 ? left : right;
    if (hold.weight <= 0) continue;
    solveArm(pose, side, hold);
  }
  pose.computeGlobals();
}

/**
 * Arm `side` bent to the wrist's place in `wrist`, into `bent`: the upper
 * arm's way, the forearm's and the elbow's hinge; returns nothing, moves
 * nothing.
 */
function bendArm(pose: FigurePose, side: number): void {
  const bones = SIDES[side]!;
  const arm = ARMS[side]!;
  const gp = pose.globalPositions;
  const gr = pose.globalRotations;
  let dx = wrist[side * 3]! - gp[bones.upperArm * 3]!;
  let dy = wrist[side * 3 + 1]! - gp[bones.upperArm * 3 + 1]!;
  let dz = wrist[side * 3 + 2]! - gp[bones.upperArm * 3 + 2]!;
  const wanted = Math.hypot(dx, dy, dz) || 1e-6;
  dx /= wanted;
  dy /= wanted;
  dz /= wanted;
  const reach = Math.max(Math.abs(arm.upper - arm.lower) + 0.02, easyReach(wanted));

  // The elbow: down, out and a little back of the shoulder-to-wrist line, in the chest's own axes.
  rotateVector(gr, BONE.spine3 * 4, ELBOW_BACK, ELBOW_DOWN, bones.sign * ELBOW_OUT, v, 0);
  let px = v[0]!;
  let py = v[1]!;
  let pz = v[2]!;
  const along = px * dx + py * dy + pz * dz;
  px -= along * dx;
  py -= along * dy;
  pz -= along * dz;
  let pole = Math.hypot(px, py, pz);
  if (pole < 1e-4) {
    // The wrist straight along it: out to the side instead.
    rotateVector(gr, BONE.spine3 * 4, 0, 0, bones.sign, v, 0);
    const a = v[0]! * dx + v[1]! * dy + v[2]! * dz;
    px = v[0]! - a * dx;
    py = v[1]! - a * dy;
    pz = v[2]! - a * dz;
    pole = Math.hypot(px, py, pz) || 1;
  }
  px /= pole;
  py /= pole;
  pz /= pole;
  const cosUpper = Math.min(1, Math.max(-1, (arm.upper * arm.upper + reach * reach - arm.lower * arm.lower) / (2 * arm.upper * reach)));
  const sinUpper = Math.sqrt(1 - cosUpper * cosUpper);
  const ux = cosUpper * dx + sinUpper * px;
  const uy = cosUpper * dy + sinUpper * py;
  const uz = cosUpper * dz + sinUpper * pz;
  let wx = (reach * dx - arm.upper * ux) / arm.lower;
  let wy = (reach * dy - arm.upper * uy) / arm.lower;
  let wz = (reach * dz - arm.upper * uz) / arm.lower;
  const wl = Math.hypot(wx, wy, wz) || 1;
  wx /= wl;
  wy /= wl;
  wz /= wl;
  // The hinge: the forearm turns about it from the upper arm's line the way an elbow bends.
  let hx = uy * wz - uz * wy;
  let hy = uz * wx - ux * wz;
  let hz = ux * wy - uy * wx;
  if (Math.hypot(hx, hy, hz) < 1e-5) {
    hx = uy * pz - uz * py;
    hy = uz * px - ux * pz;
    hz = ux * py - uy * px;
  }
  const hn = Math.hypot(hx, hy, hz) || 1;
  bent[0] = ux;
  bent[1] = uy;
  bent[2] = uz;
  bent[3] = wx;
  bent[4] = wy;
  bent[5] = wz;
  bent[6] = hx / hn;
  bent[7] = hy / hn;
  bent[8] = hz / hn;
}

/** Arm `side` to its hold. Leaves the globals stale. */
function solveArm(pose: FigurePose, side: number, hold: Hold): void {
  const bones = SIDES[side]!;
  const arm = ARMS[side]!;
  const gp = pose.globalPositions;
  const gr = pose.globalRotations;
  wristFor(pose, side, hold, false);
  bendArm(pose, side);
  if (hold.palm > 0 && hold.told < 1) {
    // The fingers lie the way the forearm comes: the wrist's place follows from it, and the arm from that.
    wristFor(pose, side, hold, true);
    bendArm(pose, side);
  }
  const ux = bent[0]!;
  const uy = bent[1]!;
  const uz = bent[2]!;
  const wx = bent[3]!;
  const wy = bent[4]!;
  const wz = bent[5]!;
  const hx = bent[6]!;
  const hy = bent[7]!;
  const hz = bent[8]!;
  // q[0]: the upper arm, q[4]: the forearm, both in the root frame.
  frameQuaternion(arm.upperDir, arm.upperHinge, ux, uy, uz, hx, hy, hz, q, 0);
  frameQuaternion(arm.lowerDir, arm.lowerHinge, wx, wy, wz, hx, hy, hz, q, 4);

  // The hand. In line: it carries on from the forearm, turned the least that points it at the hold.
  const ex = gp[bones.upperArm * 3]! + arm.upper * ux + arm.lower * wx;
  const ey = gp[bones.upperArm * 3 + 1]! + arm.upper * uy + arm.lower * wy;
  const ez = gp[bones.upperArm * 3 + 2]! + arm.upper * uz + arm.lower * wz;
  rotateVector(q, 4, arm.fingers[0]!, arm.fingers[1]!, arm.fingers[2]!, v, 0);
  let ax = hold.x - ex;
  let ay = hold.y - ey;
  let az = hold.z - ez;
  const al = Math.hypot(ax, ay, az);
  if (al > 1e-4 && hold.palm < 1) {
    ax /= al;
    ay /= al;
    az /= al;
    rotationBetween(v[0]!, v[1]!, v[2]!, ax, ay, az, q, 12);
    multiplyQuaternions(q, 12, q, 4, q, 8);
  } else {
    q[8] = q[4]!;
    q[9] = q[5]!;
    q[10] = q[6]!;
    q[11] = q[7]!;
  }
  if (hold.palm > 0) {
    // A palm's: the fingers and the palm the way the hold has them.
    handWays(hold, wx, wy, wz);
    frameQuaternion(arm.fingers, arm.palm, ways[0]!, ways[1]!, ways[2]!, ways[3]!, ways[4]!, ways[5]!, q, 12);
    nlerpQuaternions(q, 8, q, 12, hold.palm, q, 8);
  }
  // The forearm takes the hand's roll about its own long axis: relative = forearm^-1 * hand.
  q[16] = -q[4]!;
  q[17] = -q[5]!;
  q[18] = -q[6]!;
  q[19] = q[7]!;
  multiplyQuaternions(q, 16, q, 8, q, 20);
  const sign = q[23]! < 0 ? -1 : 1;
  const twist = 2 * Math.atan2(sign * (q[20]! * arm.lowerDir[0]! + q[21]! * arm.lowerDir[1]! + q[22]! * arm.lowerDir[2]!), sign * q[23]!);
  const pronation = Math.min(PRONATION_MOST, Math.max(-PRONATION_MOST, twist)) * PRONATION_SHARE;
  setAxisAngle(q, 16, arm.lowerDir[0]!, arm.lowerDir[1]!, arm.lowerDir[2]!, pronation);
  multiplyQuaternions(q, 4, q, 16, q, 4);

  // The arm as posed, blended to the arm solved by the hold's weight, a bone at a time.
  const weight = hold.weight;
  if (weight < 1) {
    nlerpQuaternions(gr, bones.upperArm * 4, q, 0, weight, q, 0);
    nlerpQuaternions(gr, bones.forearm * 4, q, 4, weight, q, 4);
    nlerpQuaternions(gr, bones.hand * 4, q, 8, weight, q, 8);
  }
  setLocal(pose, bones.upperArm, gr, BONE_PARENTS[bones.upperArm]! * 4, q, 0);
  setLocal(pose, bones.forearm, q, 0, q, 4);
  setLocal(pose, bones.hand, q, 4, q, 8);
}
