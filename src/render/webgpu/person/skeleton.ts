import { PROPORTIONS, UPPER_ARM_LENGTH, FOREARM_LENGTH } from "./figureProportions";

/**
 * The walker's skeleton: 27 bones, parents before children (the order
 * Babylon's skeleton and `poseGlobals` walk them in).
 *
 * BIND POSE. Standing upright, feet under the hips, arms hanging 11 degrees
 * out from the sides (`PROPORTIONS.bindArmAbduction`) with the palms toward
 * the thighs. Every bone's bind ORIENTATION is the root's own axes (+X
 * forward, +Y up, +Z right), so a bone's local rotation is the joint's
 * rotation in plain body axes: flexion of a hip, knee, ankle, shoulder or
 * elbow turns about +Z (the hip and shoulder forward, the knee back, the
 * ankle toes-up, the elbow forward), abduction about +X, and twist about +Y.
 * Only the positions differ from bone to bone.
 */
export const BONE = Object.freeze({
  root: 0,
  pelvis: 1,
  spine1: 2,
  spine2: 3,
  spine3: 4,
  neck: 5,
  head: 6,
  clavicleL: 7,
  upperArmL: 8,
  forearmL: 9,
  handL: 10,
  fingersL: 11,
  thumbL: 12,
  clavicleR: 13,
  upperArmR: 14,
  forearmR: 15,
  handR: 16,
  fingersR: 17,
  thumbR: 18,
  thighL: 19,
  shinL: 20,
  footL: 21,
  toeL: 22,
  thighR: 23,
  shinR: 24,
  footR: 25,
  toeR: 26,
});

export const BONE_COUNT = 27;

export const BONE_NAMES: readonly string[] = Object.freeze(Object.keys(BONE));

/** -1 for the root. */
export const BONE_PARENTS: Int8Array = Int8Array.from([
  -1, 0, 1, 2, 3, 4, 5,
  4, 7, 8, 9, 10, 10,
  4, 13, 14, 15, 16, 16,
  1, 19, 20, 21,
  1, 23, 24, 25,
]);

/** The bones of one side, by limb, for code that runs once per side. */
export interface SideBones {
  readonly clavicle: number;
  readonly upperArm: number;
  readonly forearm: number;
  readonly hand: number;
  readonly fingers: number;
  readonly thumb: number;
  readonly thigh: number;
  readonly shin: number;
  readonly foot: number;
  readonly toe: number;
  /** -1 left, +1 right: the side's sign along +Z. */
  readonly sign: -1 | 1;
}

export const LEFT: SideBones = Object.freeze({
  clavicle: BONE.clavicleL,
  upperArm: BONE.upperArmL,
  forearm: BONE.forearmL,
  hand: BONE.handL,
  fingers: BONE.fingersL,
  thumb: BONE.thumbL,
  thigh: BONE.thighL,
  shin: BONE.shinL,
  foot: BONE.footL,
  toe: BONE.toeL,
  sign: -1,
});

export const RIGHT: SideBones = Object.freeze({
  clavicle: BONE.clavicleR,
  upperArm: BONE.upperArmR,
  forearm: BONE.forearmR,
  hand: BONE.handR,
  fingers: BONE.fingersR,
  thumb: BONE.thumbR,
  thigh: BONE.thighR,
  shin: BONE.shinR,
  foot: BONE.footR,
  toe: BONE.toeR,
  sign: 1,
});

export const SIDES: readonly SideBones[] = Object.freeze([LEFT, RIGHT]);

/** The hand's length from the wrist to the knuckles (the palm), of the 0.108 H hand. */
export const PALM_LENGTH = 0.55 * PROPORTIONS.handLength;

/** Every bone's bind position in the root frame, metres, `BONE_COUNT` x 3. */
export const BIND_POSITIONS: Float64Array = (() => {
  const p = new Float64Array(BONE_COUNT * 3);
  const set = (bone: number, x: number, y: number, z: number): void => {
    p[bone * 3] = x;
    p[bone * 3 + 1] = y;
    p[bone * 3 + 2] = z;
  };
  const H = PROPORTIONS.stature;
  set(BONE.root, 0, 0, 0);
  set(BONE.pelvis, 0, PROPORTIONS.hipHeight, 0);
  set(BONE.spine1, -0.02, 0.58 * H, 0);
  set(BONE.spine2, -0.035, 0.65 * H, 0);
  set(BONE.spine3, -0.04, 0.72 * H, 0);
  set(BONE.neck, -0.035, 0.825 * H, 0);
  set(BONE.head, -0.012, 0.905 * H, 0);
  const abduction = PROPORTIONS.bindArmAbduction;
  // Down the hanging arm, out by the A-pose's angle.
  const down = Math.cos(abduction);
  const out = Math.sin(abduction);
  for (const side of SIDES) {
    const s = side.sign;
    set(side.clavicle, 0.025, 0.81 * H, s * 0.022);
    const shoulderX = -0.035;
    const shoulderY = PROPORTIONS.shoulderHeight;
    const shoulderZ = s * PROPORTIONS.shoulderHalfSpacing;
    set(side.upperArm, shoulderX, shoulderY, shoulderZ);
    const elbowY = shoulderY - UPPER_ARM_LENGTH * down;
    const elbowZ = shoulderZ + s * UPPER_ARM_LENGTH * out;
    set(side.forearm, shoulderX, elbowY, elbowZ);
    const wristY = elbowY - FOREARM_LENGTH * down;
    const wristZ = elbowZ + s * FOREARM_LENGTH * out;
    set(side.hand, shoulderX, wristY, wristZ);
    set(side.fingers, shoulderX, wristY - PALM_LENGTH * down, wristZ + s * PALM_LENGTH * out);
    // The thumb's base, at the palm's front edge a third of the way down.
    set(side.thumb, shoulderX + 0.022, wristY - 0.028 * down, wristZ + s * (0.028 * out - 0.006));
    const hipZ = s * PROPORTIONS.hipHalfSpacing;
    set(side.thigh, 0, PROPORTIONS.hipHeight, hipZ);
    set(side.shin, 0, PROPORTIONS.kneeHeight, hipZ);
    set(side.foot, 0, PROPORTIONS.ankleHeight, hipZ);
    // The ball of the foot, toes a little out.
    set(side.toe, PROPORTIONS.ballForward, 0.022, hipZ + s * 0.008);
  }
  return p;
})();

/** Each bone's bind offset from its parent, in the parent's (bind) axes, `BONE_COUNT` x 3. */
export const BIND_OFFSETS: Float64Array = (() => {
  const offsets = new Float64Array(BONE_COUNT * 3);
  for (let bone = 0; bone < BONE_COUNT; bone += 1) {
    const parent = BONE_PARENTS[bone]!;
    for (let axis = 0; axis < 3; axis += 1) {
      offsets[bone * 3 + axis] = BIND_POSITIONS[bone * 3 + axis]! - (parent >= 0 ? BIND_POSITIONS[parent * 3 + axis]! : 0);
    }
  }
  return offsets;
})();
