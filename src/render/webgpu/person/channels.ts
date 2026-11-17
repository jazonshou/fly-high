import { BONE, LEFT, RIGHT, type SideBones } from "./skeleton";
import type { FigurePose } from "./pose";

/**
 * The figure's joints as ANATOMICAL angles in degrees, one flat array a frame
 * of motion is built in: the gait, the strokes and the key poses all write
 * channels, blend them as plain numbers, and `applyChannels` turns them into
 * the skeleton's local rotations once.
 *
 * SIGNS, as a clinician reads them, the same on both sides:
 *  - trunk-like joints (pelvis, spine, neck, head): flexion forward (the top
 *    toward +X), bend to the right (the top toward +Z), turn to the right
 *    (the front toward +Z). The pelvis's flexion is its anterior tilt.
 *  - hip and shoulder: flexion forward, abduction away from the midline,
 *    rotation internal. The shoulder's angles are from the bind pose, whose
 *    arm hangs 11 degrees out.
 *  - knee: flexion (the shin back) and the shank's internal rotation;
 *    elbow: flexion (the forearm forward).
 *  - ankle: dorsiflexion (toes up) and inversion (the sole toward the
 *    midline); toe: extension (toes up at the ball).
 *  - wrist: flexion toward the palm, which faces the thigh in the bind pose;
 *    fingers and thumb: curl.
 *  - clavicle: elevation (a shrug) and protraction (the shoulder forward).
 */
const TRUNK = ["pelvisTilt", "pelvisBend", "pelvisTurn", "spineFlex", "spineBend", "spineTurn", "neckFlex", "neckBend", "neckTurn", "headFlex", "headBend", "headTurn"] as const;
const LIMB = [
  "hipFlex", "hipAbd", "hipRot", "knee", "kneeRot", "ankle", "ankleInv", "toe",
  "clavElev", "clavProt", "shFlex", "shAbd", "shRot", "elbow", "foreTwist", "wristFlex", "wristDev", "fingers", "thumb",
] as const;

export type TrunkChannel = (typeof TRUNK)[number];
export type LimbChannel = (typeof LIMB)[number];
export type ChannelName = TrunkChannel | `${LimbChannel}L` | `${LimbChannel}R`;

const NAMES: readonly ChannelName[] = Object.freeze([
  ...TRUNK,
  ...LIMB.map((name) => `${name}L` as ChannelName),
  ...LIMB.map((name) => `${name}R` as ChannelName),
]);

export const CHANNEL_COUNT = NAMES.length;

/** Index of each channel in a channel array. */
export const CH: Readonly<Record<ChannelName, number>> = Object.freeze(
  Object.fromEntries(NAMES.map((name, index) => [name, index])) as Record<ChannelName, number>,
);

/** First channel of each side's limb block: `CH.hipFlexL` and `CH.hipFlexR`; add a `LIMB_OFFSET` entry. */
export const SIDE_BASE: readonly [number, number] = Object.freeze([CH.hipFlexL, CH.hipFlexR]) as unknown as readonly [number, number];
export const LIMB_OFFSET: Readonly<Record<LimbChannel, number>> = Object.freeze(
  Object.fromEntries(LIMB.map((name, index) => [name, index])) as Record<LimbChannel, number>,
);

/** The side index (0 left, 1 right) of a side's bones. */
export function sideIndex(side: SideBones): 0 | 1 {
  return side.sign < 0 ? 0 : 1;
}

export function createChannels(): Float64Array {
  return new Float64Array(CHANNEL_COUNT);
}

/** A key pose from the channels it names (the rest 0, neutral), for tables of keys. */
export function channels(values: Partial<Record<ChannelName, number>>): Float64Array {
  const out = createChannels();
  for (const name of Object.keys(values) as ChannelName[]) out[CH[name]] = values[name]!;
  return out;
}

/** The same pose on both sides: `{ hipFlex: 20 }` sets `hipFlexL` and `hipFlexR`. */
export function both(values: Partial<Record<LimbChannel, number>>): Partial<Record<ChannelName, number>> {
  const out: Partial<Record<ChannelName, number>> = {};
  for (const name of Object.keys(values) as LimbChannel[]) {
    out[`${name}L`] = values[name]!;
    out[`${name}R`] = values[name]!;
  }
  return out;
}

/** The pose's mirror image: left and right swapped, bends and turns reversed. */
export function mirrorChannels(source: Float64Array, out: Float64Array): Float64Array {
  for (const name of TRUNK) {
    const value = source[CH[name]]!;
    out[CH[name]] = name.endsWith("Bend") || name.endsWith("Turn") ? -value : value;
  }
  const left = SIDE_BASE[0];
  const right = SIDE_BASE[1];
  for (let i = 0; i < LIMB.length; i += 1) {
    const l = source[left + i]!;
    out[left + i] = source[right + i]!;
    out[right + i] = l;
  }
  return out;
}

/** out = a + (b - a) t. `out` may alias either. */
export function mixChannels(a: Float64Array, b: Float64Array, t: number, out: Float64Array): Float64Array {
  for (let i = 0; i < CHANNEL_COUNT; i += 1) out[i] = a[i]! + (b[i]! - a[i]!) * t;
  return out;
}

/** out += source * weight. */
export function addChannels(out: Float64Array, source: Float64Array, weight = 1): Float64Array {
  for (let i = 0; i < CHANNEL_COUNT; i += 1) out[i] = out[i]! + source[i]! * weight;
  return out;
}

export type ChannelKeys = readonly (readonly [number, Float64Array])[];

/**
 * A key track at time `t`: keys `[time, pose]` in rising time, each span eased
 * (smoothstep), held before the first and after the last.
 */
export function sampleChannelKeys(keys: ChannelKeys, t: number, out: Float64Array): Float64Array {
  const first = keys[0]!;
  if (t <= first[0]) {
    out.set(first[1]);
    return out;
  }
  for (let i = 0; i + 1 < keys.length; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return mixChannels(a[1], b[1], u * u * (3 - 2 * u), out);
    }
  }
  out.set(keys[keys.length - 1]![1]);
  return out;
}

const DEG = Math.PI / 180;

/**
 * Sets every bone's local rotation below the root from the channels. The
 * root's and the pelvis's placement (`offsets`) are left as they are.
 */
export function applyChannels(pose: FigurePose, ch: Float64Array): void {
  trunkJoint(pose, BONE.pelvis, ch[CH.pelvisTilt]!, ch[CH.pelvisBend]!, ch[CH.pelvisTurn]!);
  // The spine's bend spread over its three bones, most in the lumbar and lower thorax.
  const flex = ch[CH.spineFlex]!;
  const bend = ch[CH.spineBend]!;
  const turn = ch[CH.spineTurn]!;
  trunkJoint(pose, BONE.spine1, flex * 0.4, bend * 0.35, turn * 0.25);
  trunkJoint(pose, BONE.spine2, flex * 0.35, bend * 0.35, turn * 0.35);
  trunkJoint(pose, BONE.spine3, flex * 0.25, bend * 0.3, turn * 0.4);
  trunkJoint(pose, BONE.neck, ch[CH.neckFlex]!, ch[CH.neckBend]!, ch[CH.neckTurn]!);
  trunkJoint(pose, BONE.head, ch[CH.headFlex]!, ch[CH.headBend]!, ch[CH.headTurn]!);
  limb(pose, LEFT, ch, SIDE_BASE[0]);
  limb(pose, RIGHT, ch, SIDE_BASE[1]);
}

function trunkJoint(pose: FigurePose, bone: number, flexion: number, bendRight: number, turnRight: number): void {
  pose.setJoint(bone, -flexion * DEG, bendRight * DEG, -turnRight * DEG);
}

function limb(pose: FigurePose, side: SideBones, ch: Float64Array, base: number): void {
  const s = side.sign;
  const o = LIMB_OFFSET;
  pose.setJoint(side.thigh, ch[base + o.hipFlex]! * DEG, -s * ch[base + o.hipAbd]! * DEG, s * ch[base + o.hipRot]! * DEG);
  pose.setJoint(side.shin, -ch[base + o.knee]! * DEG, 0, s * ch[base + o.kneeRot]! * DEG);
  pose.setJoint(side.foot, ch[base + o.ankle]! * DEG, s * ch[base + o.ankleInv]! * DEG, 0);
  pose.setJoint(side.toe, ch[base + o.toe]! * DEG, 0, 0);
  // The clavicle swings the shoulder up (about the body's +X, by side) and forward (about Y).
  pose.setJoint(side.clavicle, 0, -s * ch[base + o.clavElev]! * DEG, s * ch[base + o.clavProt]! * DEG);
  pose.setJoint(side.upperArm, ch[base + o.shFlex]! * DEG, -s * ch[base + o.shAbd]! * DEG, s * ch[base + o.shRot]! * DEG);
  // The forearm's twist about its own long axis: pronation turns the palm back.
  pose.setJoint(side.forearm, ch[base + o.elbow]! * DEG, 0, s * ch[base + o.foreTwist]! * DEG);
  pose.setJoint(side.hand, ch[base + o.wristDev]! * DEG, s * ch[base + o.wristFlex]! * DEG, 0);
  pose.setJoint(side.fingers, 0, s * ch[base + o.fingers]! * DEG, 0);
  pose.setJoint(side.thumb, ch[base + o.thumb]! * DEG * 0.5, s * ch[base + o.thumb]! * DEG * 0.6, 0);
}
