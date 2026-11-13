import { DOUBLE_ZERO } from "@/src/sim/ground/doubleZero";
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
 * THE BODY'S HEIGHT is the gait's own over the foot on the ground, and it
 * must not jump: it comes down to a foot over the end of that foot's swing
 * (`landing`), is carried through a running stride's flight to where the
 * next foot comes down (`strikeIn`), follows a foot it has left behind only
 * gently (`PULL_RATE`, the foot letting go instead), and rises back picking
 * its speed up and losing it again. Followed frame by frame instead, the
 * gait's curves drop the body 4 cm in the one frame of every strike.
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
  /**
   * 1..0 through leaving the ground, to the pose's own path. Lifted in a stride (`pickUp` 0), over
   * `RELEASE_SECONDS`: the ankle's offset from the path as it left (`rel*`) dies away, carried on at the speed
   * the ankle had against the path's (`slip*`). Picked up from standing, over `pickUp` seconds: from rest where
   * it stood (`stepFrom*`).
   */
  release: number;
  relX: number;
  relY: number;
  relZ: number;
  slipX: number;
  slipY: number;
  slipZ: number;
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
  /** `FootSolveOptions.pickUpSeconds` as the foot last left the ground. */
  pickUp: number;
  /** That step comes down at a place the solve asked for (`FootSolveOptions.step`), not under the hip: the ankle's place. */
  aimed: boolean;
  landX: number;
  landZ: number;
  /** The ankle's target last frame and its velocity over the ground then, and the pose's own ankle then (`tracked`: both known). */
  ax: number;
  ay: number;
  az: number;
  vx: number;
  vy: number;
  vz: number;
  fkX: number;
  fkY: number;
  fkZ: number;
  tracked: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** How far this foot, on the ground, held the pelvis down last frame, metres, and whether that was less than its leg needed. */
  pull: number;
  easing: boolean;
}

const RELEASE_SECONDS = 0.14;
/** The most a lifted foot's speed against the gait's path is carried on with, m/s. */
const MAX_SLIP = 4;
/** The most speed a foot's offset from the gait's path is closed at as it lets go, m/s. */
const RELEASE_SPEED = 2.5;
const STEP_SECONDS = 0.32;
const STEP_LIFT = 0.07;
/** A standing foot further than this from under its hip, or turned further than `STEP_YAW`, steps back. */
const STEP_DISTANCE = 0.2;
/** A foot in the air further than this from where it would stand steps there as the walker comes to a stand. */
const SET_DOWN_DISTANCE = 0.04;
const STEP_YAW = 0.6;
/** The most a planted foot stays turned from where the gait points it, radians. */
const MAX_TWIST = 0.8;
/**
 * Standing, the two feet's middle further than this from under the pelvis
 * leaves the body leaning off its feet (both left behind the same way by a
 * move that ended beside them): the further foot steps back under its hip.
 */
const LEAN_DISTANCE = 0.07;
const REACH = THIGH_LENGTH + SHANK_LENGTH - 0.004;
/** The whole leg, which a swinging foot's gait may draw straighter than a planted one's reach. */
const LEG_LENGTH = THIGH_LENGTH + SHANK_LENGTH;
/**
 * The most a foot left behind may pull the pelvis down before it lets go of
 * the ground early. The running curves sweep the foot less far than a
 * stance's travel at speed, so a running stance ends when the leg runs out
 * rather than with a crouch.
 */
const MAX_TRAILING_DROP = 0.05;
/**
 * Walking and running, how fast a foot on the ground may pull the pelvis
 * down, m/s (a trailing leg runs out within a frame or two at a run; a body
 * turning sharply leaves a foot out to its side). Past this the body does not
 * follow: the foot peels off the ground on the straight leg, and lets go once
 * it is `MAX_UNREACHED` short, or would pull the body down `MAX_STRIDE_DROP`.
 */
const PULL_RATE = 0.3;
const MAX_UNREACHED = 0.008;
const MAX_STRIDE_DROP = 0.3;
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
/** How fast the pelvis's rise back picks up and loses its speed: its rate limit (`riseRate`) reached in this many seconds. */
const RISE_PICKUP_SECONDS = 0.075;
/** How fast the body's vertical speed may change through a running stride's flight, m/s2. */
const FLIGHT_ACCELERATION = 30;
/** The share of its vertical speed the body keeps from one frame of a flight to the next when nothing says where it comes down. */
const FLIGHT_COAST = 0.7;
const NORMAL_SPAN = 0.15;
/** The height difference between a swinging foot's heel and ball over which its lowest point passes from one to the other. */
const LANDING_BLEND = 0.012;

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
    ankle: [ankleX, ankleY, ankleZ] as const,
  });
});

export interface FootSolveOptions {
  /** Each foot asked to stand on the ground (the gait's stance), left then right. */
  readonly stance: readonly [boolean, boolean];
  /** Standing still: both feet planted, and a foot left far from under its hip steps back. */
  readonly standing: boolean;
  /**
   * Standing upright over the feet (not crouched over them, a landing or a
   * climb): with both left off to one side of the body by less than a step
   * (`LEAN_DISTANCE`), the further one steps back under its hip.
   */
  readonly upright: boolean;
  readonly ground: GroundOffset;
  readonly deltaSeconds: number;
  /** 0..1: how much of the solve to apply (0 leaves the forward-kinematic legs). */
  readonly weight: number;
  /** How fast the pelvis may rise back after the feet let it down, m/s (`MAX_RISE` walking). */
  readonly riseRate: number;
  /**
   * How fast the body may come down onto a foot that has just come to the
   * ground, m/s: unbounded walking, where the foot is already there; a move
   * that puts a hanging foot down (out of a seat) lowers the body onto it.
   */
  readonly fallRate: number;
  /**
   * The way the body faces, radians to the right of the root's forward: 0 on
   * foot, where the root turns with the walker; the body's own turn in a
   * frame that does not (the car's seat frame, walking to its door). A foot
   * is "behind" along this.
   */
  readonly facing: number;
  /**
   * How far the body has come down to each foot's own level, 0..1, left then
   * right: 0 through a foot's swing, rising to 1 over its end as it comes
   * down to strike, 1 while it takes the weight. The gait's curves draw the
   * body riding high over the trailing foot's toes until the leading foot is
   * on the ground, 4-5 cm under where they drew its heel: followed as they
   * are, the body drops that far in the one frame of the strike. With this
   * it comes down over the end of the swing, the heel reaching the ground as
   * the stance begins.
   */
  readonly landing: readonly [number, number];
  /**
   * Seconds until the gait's next foot strike, or 0 when nothing says: with
   * both feet off the ground (a running stride's flight) the body is carried
   * over to the height the last stride came down at, arriving as that foot
   * does, instead of hanging at the height it left the ground with.
   */
  readonly strikeIn: number;
  /**
   * Standing, a foot to step now (0 left, 1 right), or -1, and where its
   * ankle comes down (the root's frame): a move that is about to carry the
   * body off its feet (in to a car's door) leads with this one to where the
   * body is going, as soon as the other is down.
   */
  readonly step: -1 | 0 | 1;
  readonly stepX: number;
  readonly stepZ: number;
  /**
   * 0 walking and running: a foot leaving the ground swings on in the gait
   * from its toe-off, carrying on as it was moving. Above 0, a foot picked up
   * off the ground to wherever the pose has it (on to a car's step): from
   * rest where it stood to the pose's path in this many seconds.
   */
  readonly pickUpSeconds: number;
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
  // Fractional fields start from a double (src/sim/ground/doubleZero.ts).
  private groundUnder = DOUBLE_ZERO;
  private groundUnderInitialised = false;
  private lastLift = DOUBLE_ZERO;
  /** The lift the feet asked for last frame, before the rise's easing, and the speed it rose at, m/s. */
  private lastWanted = DOUBLE_ZERO;
  private liftSpeed = DOUBLE_ZERO;
  /** The lift's own rate last frame, m/s (either way), which a flight carries on from. */
  private liftRate = DOUBLE_ZERO;
  /** Both feet were off the ground last frame, and the lift the last flight came down to. */
  private wasFlight = false;
  private strikeLift = DOUBLE_ZERO;
  private strikeKnown = false;
  private lastWeight = DOUBLE_ZERO;
  private readonly result: FootSolveResult = { strikes: 0, strikeSide: 0, pelvisDrop: DOUBLE_ZERO };

  constructor() {
    this.lastWeight = 1;
  }

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
      // Not `-=` on `.yaw` and `.ay`: the WGSL lint (render.webgpu-nature, 51b) reads them as swizzles.
      foot.yaw = foot.yaw - turnRight;
      const ax = foot.ax - dx;
      const az = foot.az - dz;
      foot.ax = ax * c + az * s;
      foot.az = -ax * s + az * c;
      foot.ay = foot.ay - dy;
      const sx = foot.stepFromX - dx;
      const sz = foot.stepFromZ - dz;
      foot.stepFromX = sx * c + sz * s;
      foot.stepFromZ = -sx * s + sz * c;
      foot.stepFromY -= dy;
      foot.stepFromYaw -= turnRight;
      const lx = foot.landX - dx;
      const lz = foot.landZ - dz;
      foot.landX = lx * c + lz * s;
      foot.landZ = -lx * s + lz * c;
      const kx = foot.fkX - dx;
      const kz = foot.fkZ - dz;
      foot.fkX = kx * c + kz * s;
      foot.fkZ = -kx * s + kz * c;
      foot.fkY -= dy;
      // (Directions turn with the root and do not move with it.)
      const vx = foot.vx;
      foot.vx = vx * c + foot.vz * s;
      foot.vz = -vx * s + foot.vz * c;
      const ox = foot.relX;
      foot.relX = ox * c + foot.relZ * s;
      foot.relZ = -ox * s + foot.relZ * c;
      const ux = foot.slipX;
      foot.slipX = ux * c + foot.slipZ * s;
      foot.slipZ = -ux * s + foot.slipZ * c;
    }
  }

  /**
   * The body turned right by `right` radians over feet that stay where they
   * are (its own turn under the root: a turn eased behind the root's, the
   * body turning in the car's seat frame). `carry` does the same for the
   * root's own turn.
   */
  turn(right: number): void {
    for (const foot of this.feet) {
      foot.yaw = foot.yaw - right;
      foot.stepFromYaw -= right;
    }
  }

  /** Both feet off the ground (in the air, in deep water, seated). */
  release(): void {
    for (const foot of this.feet) {
      foot.planted = false;
      foot.step = -1;
      foot.aimed = false;
      foot.release = 0;
      foot.pull = 0;
      foot.easing = false;
      foot.tracked = false;
    }
    this.groundUnderInitialised = false;
    this.lastLift = 0;
    this.liftRate = 0;
    this.wasFlight = false;
    this.strikeKnown = false;
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
    let lowLeft = 0;
    let lowRight = 0;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const sole = SOLE[side]!;
      pose.posedPoint(bones.foot, sole.heel[0], sole.heel[1], sole.heel[2], sc, 0);
      pose.posedPoint(bones.toe, sole.ball[0], sole.ball[1], sole.ball[2], sc, 3);
      // The heel or the ball, not the toes' tips: a foot up on its ball has its toes flat on the ground (below),
      // and a body set on their tips rides 4 cm too high through the end of every stance.
      const wanted = options.stance[side]! || options.standing;
      const low = Math.min(sc[1]!, sc[4]!);
      const foot = this.feet[side]!;
      foot.lastX = foot.ax;
      foot.lastY = foot.ay;
      foot.lastZ = foot.az;
      if (wanted) lowest = Math.min(lowest, low);
      // A foot still in the air comes down on whichever it is, eased from one to the other (`LANDING_BLEND`).
      const level = wanted ? low : softMin(sc[1]!, sc[4]!);
      if (side === 0) lowLeft = level;
      else lowRight = level;
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
    const dt = options.deltaSeconds;
    // Both feet off the ground (a running stride's flight): the pelvis carries on from its last height, its
    // rate dying away, and is let go of as the solve's weight falls (getting into a seat).
    let lift = flight ? (this.lastLift + this.liftRate * FLIGHT_COAST * dt) * Math.min(1, w / this.lastWeight) : (this.groundUnder - lowest) * w;
    this.lastWeight = w;
    // A flight that knows where it comes down glides there from the lift and its rate now, slowing as it arrives
    // (twice the mean speed left, falling to nothing at the strike), its rate changing no faster than `FLIGHT_ACCELERATION`.
    const carried = flight && this.strikeKnown && options.strikeIn > 0 && w >= 1 && dt > 0;
    if (carried) {
      const wantedRate = (2 * (this.strikeLift - this.lastLift)) / Math.max(options.strikeIn, 2 * dt);
      const change = Math.min(FLIGHT_ACCELERATION * dt, Math.max(-FLIGHT_ACCELERATION * dt, wantedRate - this.liftRate));
      lift = this.lastLift + (this.liftRate + change) * dt;
    }
    else if (flight && w >= 1) {
      // A flight that does not know where it comes down (the first of a run) goes no lower than puts its lower
      // foot on the ground: it does not sink a foot into it and jump back out as it strikes. (The feet are put
      // there at once; the body's rise to it is eased below.)
      lift = Math.max(lift, this.groundUnder - Math.min(lowLeft, lowRight));
    }
    if (!flight) {
      // Down to the level of a foot coming to the ground, or one that has just taken the weight (`landing`).
      const settle = Math.max(
        options.landing[0] * (lift - (this.groundUnder - lowLeft) * w),
        options.landing[1] * (lift - (this.groundUnder - lowRight) * w),
      );
      if (settle > 0) lift -= settle;
    }
    shiftBody(pose, lift);

    // Standing on both feet with the body off their middle: the foot further that way steps under.
    let leaning = -1;
    const leftFoot = this.feet[0];
    const rightFoot = this.feet[1];
    if (options.standing && options.upright && leftFoot.planted && rightFoot.planted && leftFoot.step < 0 && rightFoot.step < 0) {
      const lx = leftFoot.ax - gp[SIDES[0]!.foot * 3]!;
      const lz = leftFoot.az - gp[SIDES[0]!.foot * 3 + 2]!;
      const rx = rightFoot.ax - gp[SIDES[1]!.foot * 3]!;
      const rz = rightFoot.az - gp[SIDES[1]!.foot * 3 + 2]!;
      const mx = (lx + rx) / 2;
      const mz = (lz + rz) / 2;
      if (Math.hypot(mx, mz) > LEAN_DISTANCE) leaning = lx * mx + lz * mz > rx * mx + rz * mz ? 0 : 1;
    }

    // Targets.
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const sole = SOLE[side]!;
      const foot = this.feet[side]!;
      const other = this.feet[1 - side]!;
      const wanted = options.stance[side]! || options.standing;
      const fx = gp[bones.foot * 3]!;
      const fy = gp[bones.foot * 3 + 1]!;
      const fz = gp[bones.foot * 3 + 2]!;
      if (options.standing && foot.planted && foot.step < 0 && other.planted) {
        // Too far from under the hip, or twisted: step back (with the other foot on the ground). The ankle against the stance's own, so a foot
        // left on its ball (a climb's last step) is measured as one on its heel.
        const offHip = Math.hypot(foot.ax - fx, foot.az - fz);
        const asked = options.step === side;
        if (asked || offHip > STEP_DISTANCE || Math.abs(foot.yaw) > STEP_YAW || leaning === side) {
          foot.planted = false;
          foot.step = 0;
          foot.stepFromX = foot.ax;
          foot.stepFromY = foot.ay;
          foot.stepFromZ = foot.az;
          foot.stepFromYaw = foot.yaw;
          foot.aimed = asked;
          foot.landX = options.stepX;
          foot.landZ = options.stepZ;
        }
      }
      let comingDown = false;
      if (options.standing && !foot.planted && foot.step < 0 && foot.tracked && !firstFrame) {
        // Standing now with this foot in the air and not where it would stand (the walk stopped mid-swing, a
        // foot let go of behind him): it is not put there at once. One still letting go comes on to there as it
        // was; one in the gait's swing steps there from where it is.
        const off = Math.hypot(foot.ax - fx, foot.ay - (fy + ground(fx, fz) - this.groundUnder), foot.az - fz);
        if (off > SET_DOWN_DISTANCE) {
          if (foot.release > 0) comingDown = true;
          else {
            foot.step = 0;
            foot.stepFromX = foot.ax;
            foot.stepFromY = foot.ay;
            foot.stepFromZ = foot.az;
            foot.stepFromYaw = 0;
            foot.aimed = false;
            foot.released = false;
          }
        }
      }
      if (foot.step >= 0) {
        foot.step = Math.min(1, foot.step + options.deltaSeconds / STEP_SECONDS);
      }
      const stepping = foot.step >= 0 && foot.step < 1;
      if (!options.stance[side]!) foot.released = false;
      // Let go of early in its stance (the body turned over it), it comes down again where the gait now puts it.
      else if (foot.released && foot.release <= 0 && options.landing[side]! >= 1) foot.released = false;
      if (wanted && !foot.planted && !stepping && !foot.released && !comingDown) {
        // Heel strike (or the end of a standing step): lock the heel where it is, on the ground; a
        // forefoot strike (the ball lower than the heel, running) locks the ball's joint instead.
        pose.posedPoint(bones.foot, sole.heel[0], sole.heel[1], sole.heel[2], sc, 0);
        pose.posedPoint(bones.toe, sole.ball[0], sole.ball[1], sole.ball[2], sc, 3);
        foot.planted = true;
        foot.onBall = sc[4]! < sc[1]! - 0.005;
        // (Where it is drawn: a step to a place asked for comes down there, not under the hip, and a foot
        // still easing out of where it left the ground comes down as far along as it has come.)
        let offX = 0;
        let offZ = 0;
        if (foot.aimed) {
          offX = foot.landX - fx;
          offZ = foot.landZ - fz;
        } else if (foot.release > 0 && foot.release < 1) {
          const r = smooth(foot.release);
          offX = (foot.pickUp > 0 ? foot.stepFromX - fx : foot.relX) * r;
          offZ = (foot.pickUp > 0 ? foot.stepFromZ - fz : foot.relZ) * r;
        }
        foot.px = (foot.onBall ? gp[bones.toe * 3]! : sc[0]!) + offX;
        foot.pz = (foot.onBall ? gp[bones.toe * 3 + 2]! : sc[2]!) + offZ;
        foot.aimed = false;
        foot.py = ground(foot.px, foot.pz) + (foot.onBall ? MTP_HEIGHT : 0);
        foot.yaw = 0;
        foot.step = -1;
        foot.release = 0;
        foot.raised = false;
        // The body comes down to a foot at once as it strikes (it has come most of the way: `landing`).
        foot.pull = Number.POSITIVE_INFINITY;
        result.strikes += 1;
        result.strikeSide = side as 0 | 1;
      } else if (!wanted && foot.planted && !(other.step >= 0 && other.step < 1)) {
        // (Not while the other foot is in the air on a standing step: this one holds the ground until it is down.)
        foot.planted = false;
        foot.release = 1;
        // (The ankle is where the solve's weight left it between the pose's and the ground's: the whole offset.)
        foot.stepFromX = fx + (foot.ax - fx) / w;
        foot.stepFromY = fy + (foot.ay - fy) / w;
        foot.stepFromZ = fz + (foot.az - fz) / w;
        foot.pickUp = options.pickUpSeconds;
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
      // A foot on the ground turns no further from the leg over it than an ankle does: past that it pivots where it stands.
      if (foot.planted) foot.yaw = Math.min(MAX_TWIST, Math.max(-MAX_TWIST, foot.yaw));
      // (A foot off the ground turns from how it stood to the way the gait points it: through its step, or as it lets go.)
      const yaw = foot.planted ? foot.yaw : stepping ? foot.stepFromYaw * (1 - smooth(foot.step)) : foot.release > 0 ? foot.yaw * smooth(foot.release) : 0;
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
        // A standing step: from where the foot was to under the hip (or the place asked for), lifted on an arc.
        const s = smooth(foot.step);
        const toX = foot.aimed ? foot.landX : fx;
        const toZ = foot.aimed ? foot.landZ : fz;
        const restY = fy + ground(toX, toZ) - this.groundUnder;
        tx = foot.stepFromX + (toX - foot.stepFromX) * s;
        // (The arc leaves the ground and comes back to it level, not at a slant: the foot is set down.)
        ty = foot.stepFromY + (restY - foot.stepFromY) * s + STEP_LIFT * 4 * s * (1 - s);
        tz = foot.stepFromZ + (toZ - foot.stepFromZ) * s;
      } else {
        // Swing: the gait's path, over the ground under it.
        const rise = g0 - this.groundUnder;
        tx = fx;
        ty = fy + rise;
        tz = fz;
        if (foot.release > 0) {
          const fromRest = foot.pickUp > 0;
          if (foot.release >= 1 && !fromRest) {
            // Lifted in a stride: where the ankle was against the path, and how it was moving against it (a heel
            // coming up, a foot turning on its ball under a turning body). Neither its place nor its speed jumps.
            const known = foot.tracked && dt > 0;
            foot.relX = foot.stepFromX - (known ? foot.fkX : fx);
            foot.relY = foot.stepFromY - (known ? foot.fkY : fy) - rise;
            foot.relZ = foot.stepFromZ - (known ? foot.fkZ : fz);
            foot.slipX = known ? foot.vx - (fx - foot.fkX) / dt : 0;
            foot.slipY = known ? foot.vy - (fy - foot.fkY) / dt : 0;
            foot.slipZ = known ? foot.vz - (fz - foot.fkZ) / dt : 0;
            const slip = Math.hypot(foot.slipX, foot.slipY, foot.slipZ);
            if (slip > MAX_SLIP) {
              foot.slipX *= MAX_SLIP / slip;
              foot.slipY *= MAX_SLIP / slip;
              foot.slipZ *= MAX_SLIP / slip;
            }
          }
          // (A foot let go of far from the gait's path takes longer to come on to it: no faster than `RELEASE_SPEED`.)
          const seconds = fromRest ? foot.pickUp : Math.max(RELEASE_SECONDS, (1.5 * Math.hypot(foot.relX, foot.relY, foot.relZ)) / RELEASE_SPEED);
          foot.release = Math.max(0, foot.release - dt / seconds);
          const r = smooth(foot.release);
          if (fromRest) {
            // Picked up from where it stood: from rest there to the pose's own path.
            tx += (foot.stepFromX - tx) * r;
            ty += (foot.stepFromY - ty) * r;
            tz += (foot.stepFromZ - tz) * r;
          } else {
            foot.relX += foot.slipX * dt;
            foot.relY += foot.slipY * dt;
            foot.relZ += foot.slipZ * dt;
            tx += foot.relX * r;
            ty += foot.relY * r;
            tz += foot.relZ * r;
          }
        }
      }
      foot.fkX = fx;
      foot.fkY = fy;
      foot.fkZ = fz;
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
    const facingX = Math.cos(options.facing);
    const facingZ = Math.sin(options.facing);
    // The gait is walking or running the feet (it says when the next one strikes).
    const striding = options.strikeIn > 0 && !options.standing;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const foot = this.feet[side]!;
      const hx = gp[bones.thigh * 3]!;
      const hy = gp[bones.thigh * 3 + 1]!;
      const hz = gp[bones.thigh * 3 + 2]!;
      if (!foot.planted && foot.step < 0) {
        // A swing foot follows the gait, which the leg reaches, over the ground under it: coming down to ground
        // lower than the body's (a step down a slope), the body comes down with it as its strike nears.
        foot.pull = 0;
        if (flight || options.stance[side]! || options.landing[side]! <= 0) continue;
        foot.pull = Math.max(0, reachDrop(hx, hy, hz, foot.ax, foot.ay, foot.az, LEG_LENGTH) * options.landing[side]!);
        drop = Math.max(drop, foot.pull);
        continue;
      }
      let needed = reachDrop(hx, hy, hz, foot.ax, foot.ay, foot.az);
      // How far the foot is ahead of its hip the way the body faces (negative behind).
      const ahead = (foot.ax - hx) * facingX + (foot.az - hz) * facingZ;
      // A foot left behind comes up onto its ball before it pulls the body down: walking, and standing upright
      // as the body moves off over it (not in a crouch, whose feet stay flat).
      if (needed > 0 && foot.planted && (!options.standing || options.upright) && ahead < 0 && w >= 1) {
        needed = this.raiseHeel(side, ground, hx, hy, hz);
      }
      // Striding, a foot on the ground pulls the body down no faster than `PULL_RATE`, and one the body has
      // not yet come down to goes on at that rate when the walk stops over it.
      const eased = foot.planted && (striding || foot.easing) && needed > foot.pull + PULL_RATE * dt;
      foot.easing = eased;
      const pull = eased ? foot.pull + PULL_RATE * dt : needed;
      if (
        foot.planted &&
        !options.standing &&
        ((needed > MAX_TRAILING_DROP && ahead < -0.1) || needed - pull > MAX_UNREACHED || (striding && needed > MAX_STRIDE_DROP))
      ) {
        // Left behind, or the body turned or dropped away from it faster than it follows: let go now and swing on from here.
        foot.planted = false;
        foot.released = true;
        foot.release = 1;
        // (From where it was drawn, moving as it was: not from the most its heel would have had to come up.)
        if (foot.tracked) {
          foot.ax = foot.lastX + foot.vx * dt;
          foot.ay = foot.lastY + foot.vy * dt;
          foot.az = foot.lastZ + foot.vz * dt;
        }
        foot.stepFromX = gp[bones.foot * 3]! + (foot.ax - gp[bones.foot * 3]!) / w;
        foot.stepFromY = gp[bones.foot * 3 + 1]! + (foot.ay - gp[bones.foot * 3 + 1]!) / w;
        foot.stepFromZ = gp[bones.foot * 3 + 2]! + (foot.az - gp[bones.foot * 3 + 2]!) / w;
        foot.pickUp = options.pickUpSeconds;
        foot.pull = 0;
        continue;
      }
      foot.pull = Math.max(0, pull);
      drop = Math.max(drop, pull);
    }
    drop = Math.min(0.6, drop);
    if (drop > 0) shiftBody(pose, -drop);
    lift -= drop;
    // Coming down onto a foot just put to the ground is eased where the move asks for it.
    const fall = this.lastLift - options.fallRate * options.deltaSeconds - lift;
    if (fall > 0) {
      shiftBody(pose, fall);
      lift += fall;
    }
    // Rising back is eased; going down is not (the legs must reach). The rise picks its speed up and loses it
    // again over `RISE_PICKUP_SECONDS`, so the body neither starts up nor arrives with a jolt.
    const riseAcceleration = options.riseRate / RISE_PICKUP_SECONDS;
    if (firstFrame || dt <= 0) {
      this.liftSpeed = 0;
      this.liftRate = 0;
    } else {
      const wanted = lift;
      const rise = (lift - this.lastLift) / dt;
      // Coming down out of a flight: the height it came down to, for the next one.
      if (this.wasFlight && !flight) {
        this.strikeLift = wanted;
        this.strikeKnown = true;
      }
      if (carried) {
        this.liftSpeed = Math.max(0, rise);
      } else if (rise > 0) {
        const following = Math.max(0, (wanted - this.lastWanted) / dt);
        const speed = Math.min(
          rise,
          options.riseRate,
          Math.max(0, this.liftSpeed) + riseAcceleration * dt,
          following + Math.sqrt(2 * riseAcceleration * (lift - this.lastLift)),
        );
        if (speed < rise) {
          lift = this.lastLift + speed * dt;
          shiftBody(pose, lift - wanted);
        }
        this.liftSpeed = speed;
      } else {
        this.liftSpeed = 0;
      }
      this.lastWanted = wanted;
      this.liftRate = Math.min(1.5, Math.max(-1.5, (lift - this.lastLift) / dt));
    }
    if (firstFrame) this.lastWanted = lift;
    this.wasFlight = flight;
    this.lastLift = lift;
    result.pelvisDrop = -lift;

    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const foot = this.feet[side]!;
      solveTwoBone(pose, bones.thigh, bones.shin, bones.foot, foot.ax, foot.ay, foot.az);
      setGlobalRotation(pose, bones.foot, sc, 36 + side * 4);
      if (foot.tracked && dt > 0) {
        foot.vx = (foot.ax - foot.lastX) / dt;
        foot.vy = (foot.ay - foot.lastY) / dt;
        foot.vz = (foot.az - foot.lastZ) / dt;
      } else if (!foot.tracked) {
        foot.vx = 0;
        foot.vy = 0;
        foot.vz = 0;
        foot.tracked = true;
      }
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
function reachDrop(hx: number, hy: number, hz: number, ax: number, ay: number, az: number, reach = REACH): number {
  const horizontal = Math.hypot(ax - hx, az - hz);
  const vertical = hy - ay;
  return horizontal >= reach ? vertical : vertical - Math.sqrt(reach * reach - horizontal * horizontal);
}

/** The lower of two heights, rounded where they cross so it has no corner there; the lower itself once they are well apart. */
function softMin(a: number, b: number): number {
  const apart = ((a - b) * (a - b)) / (LANDING_BLEND * LANDING_BLEND);
  return 0.5 * (a + b - LANDING_BLEND * (Math.sqrt(apart + 1) - Math.exp(-apart)));
}

function createLock(): FootLock {
  // Every number a fraction from the start (src/sim/ground/doubleZero.ts); `step` is then set to "not stepping".
  const lock: FootLock = {
    planted: false,
    onBall: false,
    px: DOUBLE_ZERO,
    py: DOUBLE_ZERO,
    pz: DOUBLE_ZERO,
    yaw: DOUBLE_ZERO,
    release: DOUBLE_ZERO,
    released: false,
    raised: false,
    step: DOUBLE_ZERO,
    stepFromX: DOUBLE_ZERO,
    stepFromY: DOUBLE_ZERO,
    stepFromZ: DOUBLE_ZERO,
    stepFromYaw: DOUBLE_ZERO,
    landX: DOUBLE_ZERO,
    landZ: DOUBLE_ZERO,
    aimed: false,
    pickUp: DOUBLE_ZERO,
    relX: DOUBLE_ZERO,
    relY: DOUBLE_ZERO,
    relZ: DOUBLE_ZERO,
    slipX: DOUBLE_ZERO,
    slipY: DOUBLE_ZERO,
    slipZ: DOUBLE_ZERO,
    fkX: DOUBLE_ZERO,
    fkY: DOUBLE_ZERO,
    fkZ: DOUBLE_ZERO,
    ax: DOUBLE_ZERO,
    ay: DOUBLE_ZERO,
    az: DOUBLE_ZERO,
    vx: DOUBLE_ZERO,
    vy: DOUBLE_ZERO,
    vz: DOUBLE_ZERO,
    tracked: false,
    lastX: DOUBLE_ZERO,
    lastY: DOUBLE_ZERO,
    lastZ: DOUBLE_ZERO,
    pull: DOUBLE_ZERO,
    easing: false,
  };
  lock.step = -1;
  return lock;
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
