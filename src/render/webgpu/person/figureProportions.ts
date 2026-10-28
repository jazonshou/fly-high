import { PERSON } from "@/src/vehicles/person";

/**
 * The walker's body, measured: where its joints stand and how thick each part
 * is, for an adult man of stature H = `PERSON.stature` (1.76 m).
 *
 * FRAME. The figure's root: +X forward, +Y up, +Z right, origin at the feet
 * point on the ground between the heels.
 *
 * SOURCES.
 *  - Heights and segment lengths: Drillis & Contini (1966) as ratios of the
 *    stature (Winter, "Biomechanics and Motor Control of Human Movement", 4th
 *    ed. 2009, fig. 4.1): eye 0.936 H, chin 0.870, acromion 0.818, elbow
 *    0.630, wrist 0.485, fingertip 0.377, hip 0.530, knee 0.285, ankle 0.039;
 *    foot length 0.152 H, foot breadth 0.055 H. PUBLISHED.
 *  - Girths, breadths and depths: ANSUR II (Gordon et al. 2014) male medians,
 *    rounded to 5 mm and scaled to H: chest 1030 mm round, waist 900, buttock
 *    1020, thigh 620, knee 390, calf 390, ankle 225, biceps 330, forearm 290,
 *    wrist 175, neck 400; head 155 mm broad and 200 long; biacromial 400.
 *    PUBLISHED summary values, remembered, not re-read from the public CSV in
 *    this build (the container has no route to it).
 *  - Joint centres inside those landmarks (the hip joint 9 cm either side of
 *    the midline, the shoulder joint 4 cm under the acromion, the head's pivot
 *    over the atlas), the clothes' ease and the boot are ESTIMATES.
 */
export const STATURE = PERSON.stature;
const H = STATURE;

export const PROPORTIONS = Object.freeze({
  stature: H,
  eyeHeight: 0.936 * H,
  chinHeight: 0.87 * H,
  acromionHeight: 0.818 * H,
  /** The hip joint centres: at the trochanter's height, 9 cm off the midline. */
  hipHeight: 0.53 * H,
  hipHalfSpacing: 0.051 * H,
  kneeHeight: 0.285 * H,
  ankleHeight: 0.039 * H,
  /** The shoulder (glenohumeral) joint: 0.028 H under the acromion, 0.105 H off the midline. */
  shoulderHeight: 0.79 * H,
  shoulderHalfSpacing: 0.105 * H,
  elbowDrop: 0.16 * H,
  forearmLength: 0.146 * H,
  handLength: 0.108 * H,
  /** Foot: the heel 0.03 H behind the ankle, the ball 0.078 H ahead of it, the toe tip 0.122 H. */
  heelBack: 0.03 * H,
  ballForward: 0.078 * H,
  toeForward: 0.122 * H,
  footHalfBreadth: 0.0275 * H,
  /** The arms hang this far out from straight down in the bind pose, radians (an A-pose). */
  bindArmAbduction: (11 * Math.PI) / 180,
});

/** Thigh and shank lengths: 0.245 H and 0.246 H, hip to knee to ankle. */
export const THIGH_LENGTH = PROPORTIONS.hipHeight - PROPORTIONS.kneeHeight;
export const SHANK_LENGTH = PROPORTIONS.kneeHeight - PROPORTIONS.ankleHeight;
/** Upper arm, shoulder joint to elbow. */
export const UPPER_ARM_LENGTH = PROPORTIONS.elbowDrop;
export const FOREARM_LENGTH = PROPORTIONS.forearmLength;
/**
 * Leg length for the dimensionless gait scaling (Hof 1996: speed over
 * sqrt(g L), step length over L): the hip joint's height, 0.53 H, which is
 * the `PERSON` spec's L as well.
 */
export const LEG_LENGTH = PROPORTIONS.hipHeight;
