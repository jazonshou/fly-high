import type { PersonVisualState } from "../src/game/types";
import { PROPORTIONS } from "../src/render/webgpu/person/figureProportions";
import { PersonMotion, type MotionInput, type MotionOutput } from "../src/render/webgpu/person/motion";
import { BONE, SIDES } from "../src/render/webgpu/person/skeleton";

/**
 * The walker's motion driven as the renderer drives it, for the person-*
 * tests: the sim's state each frame, the root moving at the speed over a
 * ground plane of a given slope, and what the drawn feet and bones did.
 */

export type Mode = PersonVisualState["mode"];

export function personState(mode: Mode, patch: Partial<PersonVisualState> = {}): PersonVisualState {
  return {
    kind: "person", mode, speed: 0, running: mode === "run", grounded: true, slope: 0, waterDepth: 0, submersion: 0,
    headDepth: -1, swimPitch: 0, landingSpeed: 0, landingAge: 10, surface: 0, boarding: null, ...patch,
  };
}

export function motionInput(person: PersonVisualState, patch: Partial<MotionInput> = {}): MotionInput {
  return {
    person, forward: 0, up: 0, right: 0, turnRate: 0, ground: () => 0, steeringWheel: 0, lookYaw: 0, lookPitch: 0,
    boardingFrom: null, boardingDoor: null, ...patch,
  };
}

export function motionOutput(): MotionOutput {
  return { footStrikes: 0, strikeStrength: 0, strikeFoot: "left" };
}

export interface WalkRecord {
  /** Foot strikes reported over the measured span. */
  readonly strikes: number;
  readonly seconds: number;
  /** The worst drift of a planted foot's lock point over the ground, horizontal and vertical, metres. */
  readonly slip: number;
  readonly slipUp: number;
  /** The pelvis's lowest and highest over the ground under it, metres. */
  readonly pelvisLow: number;
  readonly pelvisHigh: number;
  /** The knee's flexion, degrees, least and most over the span (left leg). */
  readonly kneeLeast: number;
  readonly kneeMost: number;
  /** The thigh's angle forward of vertical, degrees, least and most (left leg). */
  readonly thighLeast: number;
  readonly thighMost: number;
  /** Frames both feet were off the ground, and frames both were planted. */
  readonly flightFrames: number;
  readonly doubleSupportFrames: number;
  readonly frames: number;
  readonly strengths: readonly number[];
}

/**
 * `seconds` of `mode` at `speed` up a slope of `slopeDegrees` along the
 * facing (negative down), the first `settle` seconds unmeasured.
 */
export function walk(mode: Mode, speed: number, slopeDegrees = 0, seconds = 10, settle = 2): WalkRecord {
  const motion = new PersonMotion();
  const k = Math.tan((slopeDegrees * Math.PI) / 180);
  const out = motionOutput();
  const dt = 1 / 60;
  // The sim's speed is horizontal; the root climbs the slope with it.
  const person = personState(mode, { speed, slope: k });
  const input = motionInput(person, { forward: speed, up: speed * k, ground: (forward) => k * forward });
  const point = new Float64Array(3);
  const lock: (number[] | null)[] = [null, null];
  const lockBall = [false, false];
  let rootX = 0;
  let strikes = 0;
  let slip = 0;
  let slipUp = 0;
  let pelvisLow = Infinity;
  let pelvisHigh = -Infinity;
  let kneeLeast = Infinity;
  let kneeMost = -Infinity;
  let thighLeast = Infinity;
  let thighMost = -Infinity;
  let flightFrames = 0;
  let doubleSupportFrames = 0;
  let frames = 0;
  const strengths: number[] = [];
  const total = Math.round(seconds / dt);
  const skip = Math.round(settle / dt);
  for (let frame = 0; frame < total; frame += 1) {
    rootX += speed * dt;
    motion.update(input, dt, out);
    if (frame < skip) continue;
    frames += 1;
    strikes += out.footStrikes;
    if (out.footStrikes > 0) strengths.push(out.strikeStrength);
    const pose = motion.pose;
    const g = pose.globalPositions;
    // Over the ground under the pelvis (the slope rises along +X).
    const pelvisOverGround = g[BONE.pelvis * 3 + 1]! - k * g[BONE.pelvis * 3]!;
    pelvisLow = Math.min(pelvisLow, pelvisOverGround);
    pelvisHigh = Math.max(pelvisHigh, pelvisOverGround);
    const left = SIDES[0]!;
    const hip = [g[left.thigh * 3]!, g[left.thigh * 3 + 1]!, g[left.thigh * 3 + 2]!];
    const knee = [g[left.shin * 3]!, g[left.shin * 3 + 1]!, g[left.shin * 3 + 2]!];
    const ankle = [g[left.foot * 3]!, g[left.foot * 3 + 1]!, g[left.foot * 3 + 2]!];
    const thigh = [knee[0]! - hip[0]!, knee[1]! - hip[1]!, knee[2]! - hip[2]!];
    const shank = [ankle[0]! - knee[0]!, ankle[1]! - knee[1]!, ankle[2]! - knee[2]!];
    const cos = (thigh[0]! * shank[0]! + thigh[1]! * shank[1]! + thigh[2]! * shank[2]!)
      / (Math.hypot(thigh[0]!, thigh[1]!, thigh[2]!) * Math.hypot(shank[0]!, shank[1]!, shank[2]!));
    const kneeFlexion = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
    kneeLeast = Math.min(kneeLeast, kneeFlexion);
    kneeMost = Math.max(kneeMost, kneeFlexion);
    const thighAngle = (Math.atan2(thigh[0]!, -thigh[1]!) * 180) / Math.PI;
    thighLeast = Math.min(thighLeast, thighAngle);
    thighMost = Math.max(thighMost, thighAngle);
    const planted = motion.feet.feet.map((foot) => foot.planted);
    if (!planted[0] && !planted[1]) flightFrames += 1;
    if (planted[0] && planted[1]) doubleSupportFrames += 1;
    for (let side = 0; side < 2; side += 1) {
      const foot = motion.feet.feet[side]!;
      const bones = SIDES[side]!;
      if (!foot.planted) {
        lock[side] = null;
        continue;
      }
      // The point the planter locks: the heel on the ground, or the ball joint once the heel is up.
      if (foot.onBall) {
        point[0] = g[bones.toe * 3]!;
        point[1] = g[bones.toe * 3 + 1]! - 0.022;
        point[2] = g[bones.toe * 3 + 2]!;
      } else {
        pose.posedPoint(bones.foot, -PROPORTIONS.heelBack, 0, bones.sign * PROPORTIONS.hipHalfSpacing, point, 0);
      }
      const worldX = rootX + point[0]!;
      const worldY = k * rootX + point[1]!;
      if (lock[side] === null || lockBall[side] !== foot.onBall) {
        lock[side] = [worldX, worldY, point[2]!];
        lockBall[side] = foot.onBall;
        continue;
      }
      const start = lock[side]!;
      slip = Math.max(slip, Math.hypot(worldX - start[0]!, point[2]! - start[2]!));
      slipUp = Math.max(slipUp, Math.abs(worldY - start[1]!), Math.abs(worldY - k * worldX));
    }
  }
  return {
    strikes, seconds: frames * dt, slip, slipUp, pelvisLow, pelvisHigh, kneeLeast, kneeMost, thighLeast, thighMost,
    flightFrames, doubleSupportFrames, frames, strengths,
  };
}
