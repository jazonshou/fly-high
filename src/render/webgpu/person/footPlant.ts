import { PROPORTIONS, SHANK_LENGTH, THIGH_LENGTH } from "./figureProportions";
import { BIND_POSITIONS, BONE, SIDES } from "./skeleton";
import { multiplyQuaternions, rotateVector, rotationBetween, setAxisAngle, type FigurePose } from "./pose";
import { setGlobalRotation, solveTwoBone } from "./ik";

/**
 * Feet on the ground: the stance foot pinned in the world from heel strike to
 * foot off, rolling from its heel onto its ball, set on the drawn ground's
 * slope; the pelvis lowered until both legs reach; the swing foot carried
 * clear of the ground under it.
 *
 * WORLD LOCK. The root moves under a planted foot; `carry` moves each lock by
 * the opposite of the root's own motion that frame, so a planted foot stays
 * where it struck whatever the gait's curves say, and a foot cannot slide.
 * The lock is a POINT of the sole (the heel, then the ball once the heel
 * rises above it), so the foot rolls about it as a real one does.
 *
 * Frame: the root's (+X forward, +Y up, +Z right), metres.
 */
export type GroundOffset = (forward: number, right: number) => number;

interface FootLock {
  planted: boolean;
  /** The locked sole point is the ball (true) or the heel. */
  onBall: boolean;
  px: number;
  py: number;
  pz: number;
  /** The planted foot's turn to the right of where the gait points it, radians (the body turned over it). */
  yaw: number;
  /** The ankle's offset from the gait's swing path at foot off, eased out over `RELEASE_SECONDS`. */
  releaseX: number;
  releaseY: number;
  releaseZ: number;
  release: number;
  /** Let go before the gait's foot off (it could no longer reach): no new strike until the gait lifts it. */
  released: boolean;
  /** Rolled heel-up past the gait's foot so its leg reaches (`raiseHeel`): on its ball until it lifts. */
  raised: boolean;
  /** A step back under the body while standing: 0..1 through it, or -1. */
  step: number;
  stepFromX: number;
  stepFromY: number;
  stepFromZ: number;
  stepFromYaw: number;
  /** The ankle's target last frame. */
  ax: number;
  ay: number;
  az: number;
}

const RELEASE_SECONDS = 0.14;
const STEP_SECONDS = 0.32;
const STEP_LIFT = 0.07;
/** A standing foot further than this from under its hip, or turned further than `STEP_YAW`, steps back. */
const STEP_DISTANCE = 0.2;
const STEP_YAW = 0.6;
const REACH = THIGH_LENGTH + SHANK_LENGTH - 0.004;
/**
 * The most a foot left behind may pull the pelvis down before it lets go of
 * the ground early. The running curves sweep the foot less far than a
 * stance's travel at speed, so a running stance ends when the leg runs out
 * rather than with a crouch.
 */
const MAX_TRAILING_DROP = 0.05;
/**
 * How far a foot left behind rolls up onto its ball, beyond the gait's own
 * push-off, so its leg still reaches before it must let go, radians: walking
 * uphill the heel comes up early and the stance runs to the gait's foot off.
 */
const MAX_HEEL_RAISE = 0.6;
/** The ball's joint above the sole with the toes flat. */
const MTP_HEIGHT = 0.022;
/** How fast the pelvis may rise back after a foot lets it down walking, m/s. */
export const MAX_RISE = 0.6;
const NORMAL_SPAN = 0.15;

/** The heel's and the ball's sole points in the bind pose, per side, and the ankle. */
const SOLE = SIDES.map((side) => {
  const ankleX = BIND_POSITIONS[side.foot * 3]!;
  const ankleY = BIND_POSITIONS[side.foot * 3 + 1]!;
  const ankleZ = BIND_POSITIONS[side.foot * 3 + 2]!;
  const toeZ = BIND_POSITIONS[side.toe * 3 + 2]!;
  return Object.freeze({
    heel: [ankleX - PROPORTIONS.heelBack, 0, ankleZ] as const,
    ball: [PROPORTIONS.ballForward, 0, toeZ] as const,
    /** The ball's joint (the toe bone's origin), which the foot rolls about once its heel is up. */
    mtp: [BIND_POSITIONS[side.toe * 3]!, BIND_POSITIONS[side.toe * 3 + 1]!, toeZ] as const,
    tip: [PROPORTIONS.toeForward, 0, toeZ] as const,
    ankle: [ankleX, ankleY, ankleZ] as const,
  });
});

export interface FootSolveOptions {
  /** Each foot asked to stand on the ground (the gait's stance), left then right. */
  readonly stance: readonly [boolean, boolean];
  /** Standing still: both feet planted, and a foot left far from under its hip steps back. */
  readonly standing: boolean;
  readonly ground: GroundOffset;
  readonly deltaSeconds: number;
  /** 0..1: how much of the solve to apply (0 leaves the forward-kinematic legs). */
  readonly weight: number;
  /** How fast the pelvis may rise back after the feet let it down, m/s (`MAX_RISE` walking). */
  readonly riseRate: number;
}

export interface FootSolveResult {
  /** Feet that struck the ground this frame, and the latest one. */
  strikes: number;
  strikeSide: 0 | 1;
  /** The pelvis's drop this frame below the gait's height, metres (for tests). */
  pelvisDrop: number;
}

export class FootPlanter {
  readonly feet: [FootLock, FootLock] = [createLock(), createLock()];
  private readonly scratch = new Float64Array(48);
  private groundUnder = 0;
  private groundUnderInitialised = false;
  private lastLift = 0;
  private readonly result: FootSolveResult = { strikes: 0, strikeSide: 0, pelvisDrop: 0 };

  /**
   * The root moved by (dx, dy, dz) in its own frame of the last frame and
   * turned right by `turnRight` radians: the locks stay where they are in the
   * world, so they move the other way in the root's frame.
   */
  carry(dx: number, dy: number, dz: number, turnRight: number): void {
    const c = Math.cos(turnRight);
    const s = Math.sin(turnRight);
    for (const foot of this.feet) {
      const x = foot.px - dx;
      const z = foot.pz - dz;
      foot.px = x * c + z * s;
      foot.pz = -x * s + z * c;
      foot.py -= dy;
      foot.yaw -= turnRight;
      const ax = foot.ax - dx;
      const az = foot.az - dz;
      foot.ax = ax * c + az * s;
      foot.az = -ax * s + az * c;
      foot.ay -= dy;
      const sx = foot.stepFromX - dx;
      const sz = foot.stepFromZ - dz;
      foot.stepFromX = sx * c + sz * s;
      foot.stepFromZ = -sx * s + sz * c;
      foot.stepFromY -= dy;
      foot.stepFromYaw -= turnRight;
    }
  }

  /** Both feet off the ground (in the air, in deep water, seated). */
  release(): void {
    for (const foot of this.feet) {
      foot.planted = false;
      foot.step = -1;
      foot.release = 0;
    }
    this.groundUnderInitialised = false;
  }

  get anyPlanted(): boolean {
    return this.feet[0].planted || this.feet[1].planted;
  }

  /**
   * Places the legs of `pose` (forward kinematics current) on the ground:
   * raises or lowers the pelvis, then solves each leg. Leaves the pose's
   * globals current.
   */
  solve(pose: FigurePose, options: FootSolveOptions): FootSolveResult {
    const result = this.result;
    result.strikes = 0;
    result.pelvisDrop = 0;
    const w = Math.min(1, Math.max(0, options.weight));
    if (w <= 0) {
      this.release();
      return result;
    }
    const ground = options.ground;
    const gp = pose.globalPositions;
    const sc = this.scratch;
    // The gait's own lowest sole point of the feet on the ground, which goes on the ground under the pelvis.
    let lowest = Number.POSITIVE_INFINITY;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const sole = SOLE[side]!;
      pose.posedPoint(bones.foot, sole.heel[0], sole.heel[1], sole.heel[2], sc, 0);
      pose.posedPoint(bones.toe, sole.ball[0], sole.ball[1], sole.ball[2], sc, 3);
      pose.posedPoint(bones.toe, sole.tip[0], sole.tip[1], sole.tip[2], sc, 6);
      const low = Math.min(sc[1]!, sc[4]!, sc[7]!);
      if (options.stance[side]! || options.standing) lowest = Math.min(lowest, low);
    }
    const flight = !Number.isFinite(lowest);
    const firstFrame = !this.groundUnderInitialised;
    // The ground under the pelvis, not under the stance foot: on a slope the stance foot's ground runs from
    // above the body to below it through each step, and the body does not ride it up and down.
    const under = ground(gp[BONE.pelvis * 3]!, gp[BONE.pelvis * 3 + 2]!);
    if (!this.groundUnderInitialised) {
      this.groundUnder = under;
      this.groundUnderInitialised = true;
    } else {
      // Eased, so the pelvis does not jump as the weight passes from foot to foot on a slope.
      this.groundUnder += (under - this.groundUnder) * Math.min(1, options.deltaSeconds * 12);
    }
    // Both feet off the ground (a running stride's flight): the pelvis carries on at its last height.
    let lift = flight ? this.lastLift : (this.groundUnder - lowest) * w;
    shiftBody(pose, lift);

    // Targets.
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const sole = SOLE[side]!;
      const foot = this.feet[side]!;
      const wanted = options.stance[side]! || options.standing;
      const fx = gp[bones.foot * 3]!;
      const fy = gp[bones.foot * 3 + 1]!;
      const fz = gp[bones.foot * 3 + 2]!;
      if (options.standing && foot.planted && foot.step < 0 && this.feet[1 - side]!.step < 0) {
        // Too far from under the hip, or twisted: step back.
        pose.posedPoint(bones.foot, sole.heel[0], sole.heel[1], sole.heel[2], sc, 0);
        const offHip = foot.onBall ? STEP_DISTANCE : Math.hypot(foot.px - sc[0]!, foot.pz - sc[2]!);
        if (offHip > STEP_DISTANCE || Math.abs(foot.yaw) > STEP_YAW) {
          foot.planted = false;
          foot.step = 0;
          foot.stepFromX = foot.ax;
          foot.stepFromY = foot.ay;
          foot.stepFromZ = foot.az;
          foot.stepFromYaw = foot.yaw;
        }
      }
      if (foot.step >= 0) {
        foot.step = Math.min(1, foot.step + options.deltaSeconds / STEP_SECONDS);
      }
      const stepping = foot.step >= 0 && foot.step < 1;
      if (!options.stance[side]!) foot.released = false;
      if (wanted && !foot.planted && !stepping && !foot.released) {
        // Heel strike (or the end of a standing step): lock the heel where it is, on the ground; a
        // forefoot strike (the ball lower than the heel, running) locks the ball's joint instead.
        pose.posedPoint(bones.foot, sole.heel[0], sole.heel[1], sole.heel[2], sc, 0);
        pose.posedPoint(bones.toe, sole.ball[0], sole.ball[1], sole.ball[2], sc, 3);
        foot.planted = true;
        foot.onBall = sc[4]! < sc[1]! - 0.005;
        foot.px = foot.onBall ? gp[bones.toe * 3]! : sc[0]!;
        foot.pz = foot.onBall ? gp[bones.toe * 3 + 2]! : sc[2]!;
        foot.py = ground(foot.px, foot.pz) + (foot.onBall ? MTP_HEIGHT : 0);
        foot.yaw = 0;
        foot.step = -1;
        foot.release = 0;
        foot.raised = false;
        result.strikes += 1;
        result.strikeSide = side as 0 | 1;
      } else if (!wanted && foot.planted) {
        foot.planted = false;
        foot.release = 1;
        foot.releaseX = foot.ax - fx;
        foot.releaseY = foot.ay - fy;
        foot.releaseZ = foot.az - fz;
      }
      // The ground's normal under the foot, and the foot's orientation on it.
      const gx = foot.planted ? foot.px : fx;
      const gz = foot.planted ? foot.pz : fz;
      const g0 = ground(gx, gz);
      const nx = -(ground(gx + NORMAL_SPAN, gz) - g0) / NORMAL_SPAN;
      const nz = -(ground(gx, gz + NORMAL_SPAN) - g0) / NORMAL_SPAN;
      const nl = Math.hypot(nx, 1, nz);
      // q = yaw * align * gait (at sc[12..15]).
      rotationBetween(0, 1, 0, nx / nl, 1 / nl, nz / nl, sc, 16);
      const yaw = foot.planted ? foot.yaw : stepping ? foot.stepFromYaw * (1 - smooth(foot.step)) : 0;
      setAxisAngle(sc, 20, 0, -1, 0, yaw);
      multiplyQuaternions(sc, 20, sc, 16, sc, 24);
      multiplyQuaternions(sc, 24, pose.globalRotations, bones.foot * 4, sc, 12);
      let tx: number;
      let ty: number;
      let tz: number;
      if (foot.planted) {
        // The heel's and ball's offsets from the ankle with the foot so oriented.
        rotateVector(sc, 12, sole.heel[0] - sole.ankle[0], sole.heel[1] - sole.ankle[1], sole.heel[2] - sole.ankle[2], sc, 28);
        rotateVector(sc, 12, sole.ball[0] - sole.ankle[0], sole.ball[1] - sole.ankle[1], sole.ball[2] - sole.ankle[2], sc, 31);
        rotateVector(sc, 12, sole.mtp[0] - sole.ankle[0], sole.mtp[1] - sole.ankle[1], sole.mtp[2] - sole.ankle[2], sc, 44);
        const heelUp = (sc[28]! * nx + sc[29]! + sc[30]! * nz) / nl;
        const ballUp = (sc[31]! * nx + sc[32]! + sc[33]! * nz) / nl;
        if (!foot.onBall && ballUp < heelUp - 1e-4) {
          // The heel rises: the foot now rolls about the ball's joint, wherever the heel-locked foot puts it.
          foot.onBall = true;
          foot.px += sc[44]! - sc[28]!;
          foot.pz += sc[46]! - sc[30]!;
          foot.py = ground(foot.px, foot.pz) + MTP_HEIGHT;
        } else if (foot.onBall && !foot.raised && heelUp < ballUp - 0.01) {
          foot.onBall = false;
          foot.px += sc[28]! - sc[44]!;
          foot.pz += sc[30]! - sc[46]!;
          foot.py = ground(foot.px, foot.pz);
        }
        const o = foot.onBall ? 44 : 28;
        tx = foot.px - sc[o]!;
        ty = foot.py - sc[o + 1]!;
        tz = foot.pz - sc[o + 2]!;
      } else if (stepping) {
        // A standing step: from where the foot was to under the hip, lifted on an arc.
        const s = smooth(foot.step);
        const restY = fy + ground(fx, fz) - this.groundUnder;
        tx = foot.stepFromX + (fx - foot.stepFromX) * s;
        ty = foot.stepFromY + (restY - foot.stepFromY) * s + STEP_LIFT * Math.sin(Math.PI * foot.step);
        tz = foot.stepFromZ + (fz - foot.stepFromZ) * s;
      } else {
        // Swing: the gait's path, over the ground under it, easing out of where the foot left the ground.
        if (foot.release > 0) foot.release = Math.max(0, foot.release - options.deltaSeconds / RELEASE_SECONDS);
        const r = smooth(foot.release);
        tx = fx + foot.releaseX * r;
        ty = fy + (g0 - this.groundUnder) + foot.releaseY * r;
        tz = fz + foot.releaseZ * r;
      }
      // Blend with the forward-kinematic ankle by the solve's weight.
      foot.ax = fx + (tx - fx) * w;
      foot.ay = fy + (ty - fy) * w;
      foot.az = fz + (tz - fz) * w;
      // Keep the foot's target orientation for after the leg's solve.
      sc[36 + side * 4] = sc[12]!;
      sc[37 + side * 4] = sc[13]!;
      sc[38 + side * 4] = sc[14]!;
      sc[39 + side * 4] = sc[15]!;
      if (w < 1) nlerpInto(pose.globalRotations, bones.foot * 4, sc, 36 + side * 4, w);
    }

    // Lower the pelvis until both legs reach their ankles.
    let drop = 0;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const foot = this.feet[side]!;
      // A swing foot follows the gait, which the leg reaches; only a foot on the ground pulls the pelvis down.
      if (!foot.planted && foot.step < 0) continue;
      const hx = gp[bones.thigh * 3]!;
      const hy = gp[bones.thigh * 3 + 1]!;
      const hz = gp[bones.thigh * 3 + 2]!;
      let needed = reachDrop(hx, hy, hz, foot.ax, foot.ay, foot.az);
      if (needed > 0 && foot.planted && !options.standing && foot.ax < hx && w >= 1) {
        needed = this.raiseHeel(side, ground, hx, hy, hz);
      }
      if (needed > MAX_TRAILING_DROP && !options.standing && foot.planted && foot.ax < hx - 0.1) {
        // Left behind: let go now and swing on from here.
        foot.planted = false;
        foot.released = true;
        foot.release = 1;
        foot.releaseX = foot.ax - gp[bones.foot * 3]!;
        foot.releaseY = foot.ay - gp[bones.foot * 3 + 1]!;
        foot.releaseZ = foot.az - gp[bones.foot * 3 + 2]!;
        continue;
      }
      drop = Math.max(drop, needed);
    }
    drop = Math.min(0.6, drop);
    if (drop > 0) shiftBody(pose, -drop);
    lift -= drop;
    // Rising back is eased; going down is not (the legs must reach).
    const rise = lift - this.lastLift;
    const allowed = options.riseRate * options.deltaSeconds;
    if (rise > allowed && !firstFrame) {
      shiftBody(pose, allowed - rise);
      lift = this.lastLift + allowed;
    }
    this.lastLift = lift;
    result.pelvisDrop = -lift;

    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const foot = this.feet[side]!;
      solveTwoBone(pose, bones.thigh, bones.shin, bones.foot, foot.ax, foot.ay, foot.az);
      setGlobalRotation(pose, bones.foot, sc, 36 + side * 4);
    }
    pose.computeGlobals();
    // Toes flat on the ground while the foot stands on its ball.
    let toes = false;
    for (let side = 0; side < 2; side += 1) {
      const foot = this.feet[side]!;
      if (!foot.planted || !foot.onBall) continue;
      const g0 = ground(foot.px, foot.pz);
      const nx = -(ground(foot.px + NORMAL_SPAN, foot.pz) - g0) / NORMAL_SPAN;
      const nz = -(ground(foot.px, foot.pz + NORMAL_SPAN) - g0) / NORMAL_SPAN;
      const nl = Math.hypot(nx, 1, nz);
      rotationBetween(0, 1, 0, nx / nl, 1 / nl, nz / nl, sc, 16);
      setAxisAngle(sc, 20, 0, -1, 0, foot.yaw);
      multiplyQuaternions(sc, 20, sc, 16, sc, 24);
      if (w < 1) nlerpInto(pose.globalRotations, SIDES[side]!.toe * 4, sc, 24, w);
      setGlobalRotation(pose, SIDES[side]!.toe, sc, 24);
      toes = true;
    }
    if (toes) pose.computeGlobals();
    return result;
  }

  /**
   * A planted foot behind its hip that the leg no longer reaches: onto its
   * ball, if it was on its heel, then turned about the ball's joint (the
   * heel up) by the least angle up to `MAX_HEEL_RAISE` that brings its ankle
   * within reach, or by all of it. Updates the foot's lock, ankle target
   * and orientation (`scratch[36 + side * 4]`); returns the pelvis drop
   * still needed.
   */
  private raiseHeel(side: number, ground: GroundOffset, hx: number, hy: number, hz: number): number {
    const sc = this.scratch;
    const foot = this.feet[side]!;
    const sole = SOLE[side]!;
    const q = 36 + side * 4;
    const mx = sole.mtp[0] - sole.ankle[0];
    const my = sole.mtp[1] - sole.ankle[1];
    const mz = sole.mtp[2] - sole.ankle[2];
    if (!foot.onBall) {
      rotateVector(sc, q, sole.heel[0] - sole.ankle[0], sole.heel[1] - sole.ankle[1], sole.heel[2] - sole.ankle[2], sc, 28);
      rotateVector(sc, q, mx, my, mz, sc, 44);
      foot.onBall = true;
      foot.px += sc[44]! - sc[28]!;
      foot.pz += sc[46]! - sc[30]!;
      foot.py = ground(foot.px, foot.pz) + MTP_HEIGHT;
    }
    // The foot's own lateral axis (+Z), about which the heel comes up.
    rotateVector(sc, q, 0, 0, 1, sc, 28);
    let low = 0;
    let high = MAX_HEEL_RAISE;
    // Bisection, when the most raise reaches: the drop needed falls as the heel comes up.
    if (this.ankleAfterRaise(side, high, hx, hy, hz) <= 0) {
      for (let i = 0; i < 8; i += 1) {
        const mid = (low + high) / 2;
        if (this.ankleAfterRaise(side, mid, hx, hy, hz) > 0) low = mid;
        else high = mid;
      }
    }
    // The least raise that reaches, or the most there is and the drop it still needs.
    const needed = this.ankleAfterRaise(side, high, hx, hy, hz);
    foot.raised = true;
    foot.ax = sc[0]!;
    foot.ay = sc[1]!;
    foot.az = sc[2]!;
    sc[q] = sc[4]!;
    sc[q + 1] = sc[5]!;
    sc[q + 2] = sc[6]!;
    sc[q + 3] = sc[7]!;
    return needed;
  }

  /**
   * The ankle (into `scratch[0..2]`) and orientation (`scratch[4..7]`) of
   * foot `side` turned heel-up by `angle` about its ball's joint, and the
   * pelvis drop its leg then needs. Reads the lateral axis at `scratch[28]`.
   */
  private ankleAfterRaise(side: number, angle: number, hx: number, hy: number, hz: number): number {
    const sc = this.scratch;
    const foot = this.feet[side]!;
    const sole = SOLE[side]!;
    setAxisAngle(sc, 8, sc[28]!, sc[29]!, sc[30]!, -angle);
    multiplyQuaternions(sc, 8, sc, 36 + side * 4, sc, 4);
    rotateVector(sc, 4, sole.mtp[0] - sole.ankle[0], sole.mtp[1] - sole.ankle[1], sole.mtp[2] - sole.ankle[2], sc, 12);
    sc[0] = foot.px - sc[12]!;
    sc[1] = foot.py - sc[13]!;
    sc[2] = foot.pz - sc[14]!;
    return reachDrop(hx, hy, hz, sc[0]!, sc[1]!, sc[2]!);
  }
}

/** How far the hip at (hx, hy, hz) must come down for the leg to reach the ankle at (ax, ay, az). */
function reachDrop(hx: number, hy: number, hz: number, ax: number, ay: number, az: number): number {
  const horizontal = Math.hypot(ax - hx, az - hz);
  const vertical = hy - ay;
  return horizontal >= REACH ? vertical : vertical - Math.sqrt(REACH * REACH - horizontal * horizontal);
}

function createLock(): FootLock {
  return {
    planted: false,
    onBall: false,
    px: 0,
    py: 0,
    pz: 0,
    yaw: 0,
    releaseX: 0,
    releaseY: 0,
    releaseZ: 0,
    release: 0,
    released: false,
    raised: false,
    step: -1,
    stepFromX: 0,
    stepFromY: 0,
    stepFromZ: 0,
    stepFromYaw: 0,
    ax: 0,
    ay: 0,
    az: 0,
  };
}

/** Moves every bone under the root up by `dy` (the pelvis and all it carries), globals included. */
function shiftBody(pose: FigurePose, dy: number): void {
  if (dy === 0) return;
  pose.offsets[BONE.pelvis * 3 + 1] = pose.offsets[BONE.pelvis * 3 + 1]! + dy;
  for (let bone = BONE.pelvis; bone < pose.globalScales.length; bone += 1) {
    pose.globalPositions[bone * 3 + 1] = pose.globalPositions[bone * 3 + 1]! + dy;
  }
}

/** q(target) = nlerp(current, target, w), written back into the target slot. */
function nlerpInto(current: Float64Array, co: number, target: Float64Array, to: number, w: number): void {
  const dot = current[co]! * target[to]! + current[co + 1]! * target[to + 1]! + current[co + 2]! * target[to + 2]! + current[co + 3]! * target[to + 3]!;
  const sign = dot < 0 ? -1 : 1;
  let length = 0;
  for (let i = 0; i < 4; i += 1) {
    const value = current[co + i]! * (1 - w) + target[to + i]! * w * sign;
    target[to + i] = value;
    length += value * value;
  }
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < 4; i += 1) target[to + i] = target[to + i]! / length;
}

function smooth(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}
