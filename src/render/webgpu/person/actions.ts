import { PERSON } from "@/src/vehicles/person";
import { both, channels, CH, createChannels, LIMB_OFFSET, SIDE_BASE, mixChannels, sampleChannelKeys, type ChannelKeys } from "./channels";

/**
 * Everything the walker does besides walking and running, as key poses in
 * the figure's anatomical channels (`channels.ts`), sampled through a cycle
 * or a timeline. ALL of these are ESTIMATES drawn to the technique the
 * sources describe, not measured curves:
 *  - swimming: the breaststroke's and crawl's phases as Maglischo, "Swimming
 *    Fastest" (2003), and the FINA technique notes describe them (the
 *    breaststroke's pull, breath, recovery, kick and glide; the crawl's
 *    entry, catch, pull, push and high-elbow recovery over a six-beat
 *    flutter kick, the body rolling about 35 degrees each way);
 *  - treading water: the eggbeater kick under sculling hands;
 *  - the hard landing's crouch and the parachute-style roll (a forward roll
 *    over the tucked body), and the jump's take-off and air;
 *  - the mantle out of the water onto a ledge, and the climb over a rail or
 *    a low wall from the feet (hands on the top, a knee up onto it).
 *
 * Shoulder flexion of 180 is the arm along the body past the head (overhead
 * standing, ahead of a prone swimmer).
 */

const breaststroke: ChannelKeys = [
  [0, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, wristFlex: 0, fingers: 6, hipFlex: 0, knee: 6, ankle: -45 }), neckFlex: 5 })],
  [0.14, channels({ ...both({ shFlex: 162, shAbd: 42, elbow: 18, foreTwist: 55, fingers: 8, hipFlex: 0, knee: 8, ankle: -45 }), neckFlex: -12 })],
  [0.3, channels({ ...both({ shFlex: 112, shAbd: 38, shRot: 35, elbow: 105, foreTwist: 30, wristFlex: 15, fingers: 10, hipFlex: 8, knee: 25, ankle: -35 }), neckFlex: -35, spineFlex: -8 })],
  [0.42, channels({ ...both({ shFlex: 128, shAbd: 12, shRot: 20, elbow: 125, foreTwist: 10, fingers: 10, hipFlex: 32, hipAbd: 12, hipRot: -20, knee: 85, ankle: 5 }), neckFlex: -30, spineFlex: -6 })],
  [0.52, channels({ ...both({ shFlex: 152, shAbd: 6, elbow: 60, fingers: 8, hipFlex: 48, hipAbd: 22, hipRot: -32, knee: 118, ankle: 22 }), neckFlex: -10 })],
  [0.64, channels({ ...both({ shFlex: 170, shAbd: 5, elbow: 10, fingers: 6, hipFlex: 28, hipAbd: 30, hipRot: -25, knee: 70, ankle: 18 }), neckFlex: 5 })],
  [0.78, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, fingers: 6, hipFlex: 2, hipAbd: 4, knee: 6, ankle: -45 }), neckFlex: 6 })],
  [1, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, wristFlex: 0, fingers: 6, hipFlex: 0, knee: 6, ankle: -45 }), neckFlex: 5 })],
];

/** The dive stroke: the breaststroke's long under-water pull, the hands swept back to the thighs, then a long glide. */
const diveStroke: ChannelKeys = [
  [0, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, fingers: 6, knee: 6, ankle: -45 }), neckFlex: 10 })],
  [0.16, channels({ ...both({ shFlex: 150, shAbd: 45, elbow: 30, foreTwist: 55, fingers: 8, knee: 8, ankle: -45 }), neckFlex: 5 })],
  [0.3, channels({ ...both({ shFlex: 70, shAbd: 40, shRot: 30, elbow: 95, foreTwist: 30, fingers: 10, knee: 10, ankle: -45 }), neckFlex: 5 })],
  [0.4, channels({ ...both({ shFlex: -5, shAbd: 12, elbow: 10, foreTwist: 70, fingers: 8, knee: 10, ankle: -45 }), neckFlex: 8 })],
  [0.55, channels({ ...both({ shFlex: -5, shAbd: 10, elbow: 8, foreTwist: 70, fingers: 8, knee: 8, ankle: -45 }), neckFlex: 8 })],
  [0.68, channels({ ...both({ shFlex: 60, shAbd: 4, shRot: 40, elbow: 140, fingers: 10, hipFlex: 45, hipAbd: 20, hipRot: -30, knee: 115, ankle: 20 }), neckFlex: 6 })],
  [0.8, channels({ ...both({ shFlex: 165, shAbd: 5, elbow: 10, fingers: 6, hipFlex: 25, hipAbd: 28, hipRot: -25, knee: 60, ankle: 15 }), neckFlex: 8 })],
  [0.9, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, fingers: 6, hipFlex: 0, knee: 6, ankle: -45 }), neckFlex: 10 })],
  [1, channels({ ...both({ shFlex: 172, shAbd: 6, elbow: 4, fingers: 6, knee: 6, ankle: -45 }), neckFlex: 10 })],
];

/** One arm's crawl through its own cycle (the other half a cycle behind). */
const crawlArm: readonly (readonly [number, readonly [number, number, number, number, number]])[] = [
  // [u, [shFlex, shAbd, shRot, elbow, foreTwist]]
  [0, [172, 4, 0, 8, 10]],
  [0.12, [155, 8, 25, 35, 20]],
  [0.3, [95, 6, 35, 95, 20]],
  [0.45, [25, 8, 15, 40, 10]],
  [0.52, [-8, 14, 0, 25, 0]],
  [0.62, [10, 62, -25, 95, -20]],
  [0.78, [95, 55, -15, 100, -10]],
  [0.92, [160, 18, -5, 40, 0]],
  [1, [172, 4, 0, 8, 10]],
];

export class ActionChannels {
  private readonly scratch = createChannels();

  /** Surface breaststroke at its cycle position `u`, into `out` (all channels). */
  breaststroke(u: number, out: Float64Array): void {
    sampleChannelKeys(breaststroke, fraction(u), out);
  }

  diveStroke(u: number, out: Float64Array): void {
    sampleChannelKeys(diveStroke, fraction(u), out);
  }

  /**
   * Front crawl at its cycle position `u` (the left arm's entry at 0), into
   * `out`; returns the body's roll about its long axis, degrees to the right.
   */
  crawl(u: number, out: Float64Array): number {
    out.fill(0);
    for (let side = 0; side < 2; side += 1) {
      const base = SIDE_BASE[side as 0 | 1];
      const arm = crawlArmAt(fraction(u + side * 0.5));
      const o = LIMB_OFFSET;
      out[base + o.shFlex] = arm[0];
      out[base + o.shAbd] = arm[1];
      out[base + o.shRot] = arm[2];
      out[base + o.elbow] = arm[3];
      out[base + o.foreTwist] = arm[4];
      out[base + o.fingers] = 8;
      out[base + o.wristFlex] = 10;
      // Six beats a cycle, the legs opposed, kicking from the hip with a little knee.
      const beat = Math.sin(2 * Math.PI * (3 * u + side * 0.5));
      out[base + o.hipFlex] = 2 + 14 * beat;
      out[base + o.knee] = 12 + 14 * Math.max(0, beat);
      out[base + o.ankle] = -48;
      out[base + o.hipRot] = 8;
    }
    // Breathing to the right as the right arm recovers.
    const breath = Math.max(0, Math.sin(2 * Math.PI * (u - 0.05)));
    out[CH.neckTurn] = 45 * breath * breath;
    out[CH.headTurn] = 25 * breath * breath;
    out[CH.neckFlex] = -8;
    // Roll toward the pulling arm: right side down while the left arm recovers.
    return 35 * Math.sin(2 * Math.PI * (u - 0.25));
  }

  /** Treading water upright: sculling hands, an eggbeater kick. `t` seconds. */
  tread(t: number, out: Float64Array): void {
    out.fill(0);
    const scull = Math.sin(2 * Math.PI * 0.9 * t);
    for (let side = 0; side < 2; side += 1) {
      const base = SIDE_BASE[side as 0 | 1];
      const o = LIMB_OFFSET;
      const s = side === 0 ? 1 : -1;
      out[base + o.shFlex] = 25;
      out[base + o.shAbd] = 48 + 10 * scull;
      out[base + o.shRot] = 25;
      out[base + o.elbow] = 65;
      out[base + o.foreTwist] = 35 * scull;
      out[base + o.fingers] = 10;
      // Eggbeater: the legs circling out of phase, knees wide.
      const circle = 2 * Math.PI * 0.75 * t + side * Math.PI;
      out[base + o.hipFlex] = 62 + 8 * Math.sin(circle);
      out[base + o.hipAbd] = 32;
      out[base + o.hipRot] = -15 + 18 * Math.cos(circle) * s * s;
      out[base + o.knee] = 85 + 25 * Math.sin(circle + 1.2);
      out[base + o.ankle] = 10;
    }
    out[CH.spineFlex] = 6;
    out[CH.neckFlex] = -12;
  }

  /**
   * The air, from the vertical speed (m/s, positive up) and the horizontal
   * speed: legs pushed straight and arms thrown up leaving the ground,
   * gathered at the top, reaching down and out for the ground in a long fall.
   */
  air(verticalSpeed: number, airSeconds: number, out: Float64Array): void {
    const rising = smoothstep(0.5, 2.5, verticalSpeed);
    const falling = smoothstep(-1.5, -7, verticalSpeed);
    mixChannels(AIR_TOP, AIR_TAKE_OFF, rising, out);
    if (falling > 0) {
      mixChannels(out, AIR_FALL, falling, out);
      // A long fall: the arms working for balance.
      const flail = falling * Math.sin(2 * Math.PI * 1.6 * airSeconds);
      out[CH.shAbdL] = out[CH.shAbdL]! + 12 * flail;
      out[CH.shAbdR] = out[CH.shAbdR]! - 12 * flail;
    }
  }

  /**
   * The hard landing's crouch, `t` seconds after touch-down, `depth` 0..1
   * (how hard: a shallow one at `PERSON.landingHardSpeed`, a full squat at
   * the roll's speed), over `PERSON.landingHardSeconds`: down fast, a hold,
   * up again.
   */
  crouch(t: number, depth: number, out: Float64Array): void {
    // The timeline is the full squat; a lighter landing squats less.
    const keyed = (t * CROUCH_KEYED_SECONDS) / PERSON.landingHardSeconds;
    mixChannels(STAND, sampleChannelKeys(CROUCH_TIMELINE, keyed, this.scratch), depth, out);
  }

  /**
   * The roll after a fall of `PERSON.landingRollSpeed` or more, `t` seconds
   * after touch-down, over `PERSON.landingRollSeconds`: crouch and reach, a
   * tucked forward roll over the shoulders, up through the crouch. Returns
   * the roll's angle, radians forward (0 .. 2 pi), for the root to turn
   * about the tucked body's centre.
   */
  roll(t: number, out: Float64Array): number {
    const keyed = rollKeyedSeconds(t);
    sampleChannelKeys(ROLL_TIMELINE, keyed, out);
    const u = smoothstep(ROLL_START, ROLL_END, keyed);
    return 2 * Math.PI * u;
  }

  /** Climbing out of the water onto a ledge, `t` 0..1 through it. */
  mantle(t: number, out: Float64Array): void {
    sampleChannelKeys(MANTLE_TIMELINE, t, out);
  }

  /**
   * Climbing a rail or a low wall from the feet, `t` 0..1 through it: a
   * crouch reaching for the top, the jump with the hands on it, pressed up
   * on straight arms, the left knee and foot up onto it, the right leg
   * over, standing.
   */
  climb(t: number, out: Float64Array): void {
    sampleChannelKeys(CLIMB_TIMELINE, t, out);
  }

  /** Breathing and a slow weight shift standing, added to `out` scaled by `amount`. */
  idle(t: number, amount: number, out: Float64Array): void {
    if (amount <= 0) return;
    const breath = Math.sin(2 * Math.PI * 0.23 * t);
    const shift = Math.sin((2 * Math.PI * t) / 7.3);
    out[CH.spineFlex] = out[CH.spineFlex]! - 0.8 * breath * amount;
    out[CH.clavElevL] = out[CH.clavElevL]! + 1.2 * breath * amount;
    out[CH.clavElevR] = out[CH.clavElevR]! + 1.2 * breath * amount;
    out[CH.pelvisBend] = out[CH.pelvisBend]! + 1.8 * shift * amount;
    out[CH.spineBend] = out[CH.spineBend]! - 1.4 * shift * amount;
    out[CH.neckTurn] = out[CH.neckTurn]! + 3 * Math.sin((2 * Math.PI * t) / 11) * amount;
  }
}

/** The relaxed standing pose's arms and hands (the legs straight under the hips). */
export const STAND = channels({ ...both({ shAbd: -4, elbow: 12, fingers: 25, thumb: 15, wristFlex: 5, knee: 2, kneeRot: -6 }) });

const AIR_TAKE_OFF = channels({ ...both({ hipFlex: 6, knee: 6, ankle: -32, shFlex: 70, shAbd: 10, elbow: 30, fingers: 15 }), spineFlex: -4, neckFlex: -5 });
const AIR_TOP = channels({ ...both({ hipFlex: 32, knee: 52, ankle: -10, shFlex: 35, shAbd: 25, elbow: 35, fingers: 20 }), spineFlex: 6 });
const AIR_FALL = channels({ ...both({ hipFlex: 18, knee: 28, ankle: -5, shFlex: 25, shAbd: 75, elbow: 25, fingers: 15 }), spineFlex: 10, neckFlex: 10 });

const SQUAT = channels({ ...both({ hipFlex: 100, hipAbd: 8, knee: 118, ankle: 32, shFlex: 45, shAbd: 10, elbow: 35, fingers: 30 }), spineFlex: 38, neckFlex: -25 });
const CROUCH_TIMELINE: ChannelKeys = [
  [0, STAND],
  [0.1, SQUAT],
  [0.2, SQUAT],
  [0.4, STAND],
];
/** The crouch's timeline is keyed over this span; it plays over `PERSON.landingHardSeconds`. */
const CROUCH_KEYED_SECONDS = 0.4;

const TUCK = channels({ ...both({ hipFlex: 125, hipAbd: 10, knee: 135, ankle: 10, shFlex: 70, shAbd: 25, shRot: 40, elbow: 100, fingers: 40 }), spineFlex: 55, neckFlex: 45 });
const REACH = channels({ ...both({ hipFlex: 95, hipAbd: 10, knee: 105, ankle: 30, shFlex: 95, shAbd: 15, elbow: 25, fingers: 15 }), spineFlex: 50, neckFlex: 30 });
const ROLL_START = 0.14;
const ROLL_END = 0.74;
const ROLL_TIMELINE: ChannelKeys = [
  [0, STAND],
  [0.08, SQUAT],
  [ROLL_START, REACH],
  [0.24, TUCK],
  [0.66, TUCK],
  [0.8, SQUAT],
  [1.1, STAND],
];
/** The roll's timeline is keyed over this span; it plays over `PERSON.landingRollSeconds`. */
const ROLL_KEYED_SECONDS = 1.1;

/** `t` seconds into the roll as its timeline's keyed seconds (the roll keyed over 1.1 s). */
export function rollKeyedSeconds(t: number): number {
  return (t * ROLL_KEYED_SECONDS) / PERSON.landingRollSeconds;
}

const MANTLE_TIMELINE: ChannelKeys = [
  [0, channels({ ...both({ shFlex: 25, shAbd: 48, elbow: 65, hipFlex: 60, hipAbd: 30, knee: 90 }), spineFlex: 6 })],
  [0.22, channels({ ...both({ shFlex: 140, shAbd: 25, elbow: 25, wristFlex: -35, fingers: 20, hipFlex: 20, knee: 35, ankle: -20 }), spineFlex: 5, neckFlex: -10 })],
  [0.5, channels({ ...both({ shFlex: -10, shAbd: 25, elbow: 15, wristFlex: -70, fingers: 10, hipFlex: 10, knee: 20, ankle: -25 }), spineFlex: 25, neckFlex: -20 })],
  [0.72, channels({ shFlexL: 20, shFlexR: 20, shAbdL: 15, shAbdR: 15, elbowL: 30, elbowR: 30, wristFlexL: -60, wristFlexR: -60, hipFlexL: 110, kneeL: 125, ankleL: 15, hipFlexR: 70, kneeR: 90, ankleR: -10, spineFlex: 45, neckFlex: -25 })],
  [1, STAND],
];

const CLIMB_PRESS_ARMS = { shFlex: -5, shAbd: 20, elbow: 15, wristFlex: -75, fingers: 10 } as const;
const CLIMB_TIMELINE: ChannelKeys = [
  [0, STAND],
  [0.12, channels({ ...both({ shFlex: 105, shAbd: 15, elbow: 35, wristFlex: -40, fingers: 20, hipFlex: 35, knee: 60, ankle: 20 }), spineFlex: 22, neckFlex: -15 })],
  [0.3, channels({ ...both({ shFlex: 45, shAbd: 20, elbow: 70, wristFlex: -60, fingers: 15, hipFlex: 60, knee: 95, ankle: -10 }), spineFlex: 28, neckFlex: -15 })],
  // Pressed up on straight arms, the legs hanging against the wall.
  [0.48, channels({ ...both({ ...CLIMB_PRESS_ARMS, hipFlex: 15, knee: 35, ankle: -25 }), spineFlex: 30, neckFlex: -20 })],
  // The left knee up over the top, its foot tucked behind it, then the foot on the top.
  [0.56, channels({ ...both(CLIMB_PRESS_ARMS), hipFlexL: 90, kneeL: 140, ankleL: 20, hipFlexR: 20, kneeR: 45, ankleR: -20, spineFlex: 55, neckFlex: -25 })],
  [0.66, channels({ ...both({ shFlex: 5, shAbd: 15, elbow: 20, wristFlex: -60, fingers: 10 }), hipFlexL: 105, kneeL: 115, ankleL: 20, hipFlexR: 70, kneeR: 135, ankleR: 0, spineFlex: 50, neckFlex: -20 })],
  // The right leg over, rising.
  [0.8, channels({ ...both({ shFlex: 20, shAbd: 12, elbow: 30, wristFlex: -20, fingers: 20 }), hipFlexL: 80, kneeL: 95, ankleL: 15, hipFlexR: 85, kneeR: 110, ankleR: 5, spineFlex: 30, neckFlex: -10 })],
  [0.9, channels({ ...both({ shFlex: 15, shAbd: 6, elbow: 25, fingers: 25, hipFlex: 40, knee: 55, ankle: 12 }), spineFlex: 15 })],
  [1, STAND],
];

function crawlArmAt(u: number): readonly [number, number, number, number, number] {
  for (let i = 0; i + 1 < crawlArm.length; i += 1) {
    const [ta, a] = crawlArm[i]!;
    const [tb, b] = crawlArm[i + 1]!;
    if (u <= tb) {
      const t = (u - ta) / (tb - ta);
      const s = t * t * (3 - 2 * t);
      CRAWL_SCRATCH[0] = a[0] + (b[0] - a[0]) * s;
      CRAWL_SCRATCH[1] = a[1] + (b[1] - a[1]) * s;
      CRAWL_SCRATCH[2] = a[2] + (b[2] - a[2]) * s;
      CRAWL_SCRATCH[3] = a[3] + (b[3] - a[3]) * s;
      CRAWL_SCRATCH[4] = a[4] + (b[4] - a[4]) * s;
      return CRAWL_SCRATCH as unknown as readonly [number, number, number, number, number];
    }
  }
  return crawlArm[0]![1];
}

const CRAWL_SCRATCH = new Float64Array(5);

function fraction(value: number): number {
  return value - Math.floor(value);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
