import { DOUBLE_ZERO } from "@/src/sim/ground/doubleZero";
import type { PersonMode, PersonVisualState } from "@/src/game/types";
import { PERSON } from "@/src/vehicles/person";
import { ActionChannels, rollKeyedSeconds, STAND, smoothstep } from "./actions";
import { CarSeatMotion, SEAT, type BoardingFrom } from "./carSeat";
import { applyChannels, CH, createChannels, LIMB_OFFSET, mixChannels, SIDE_BASE } from "./channels";
import { PROPORTIONS } from "./figureProportions";
import { FootPlanter, MAX_RISE, type FootSolveOptions, type GroundOffset } from "./footPlant";
import { dimensionlessSpeed, strideLength } from "./gait";
import { WALK_GROUP_SPEED } from "./gaitData";
import { setGlobalRotation, solveTwoBone } from "./ik";
import { GaitChannels } from "./locomotion";
import { blendPoses, FigurePose, multiplyQuaternions, rotateVector, rotationBetween, setAxisAngle, setEuler } from "./pose";
import { BIND_POSITIONS, BONE, SIDES } from "./skeleton";

/**
 * The walker's motion: from the sim's `PersonVisualState` and the root's own
 * movement to the skeleton's pose, every frame, with no per-frame object,
 * array or closure (V8 still boxes some doubles at the helpers it does not
 * inline: about 190 B a frame, measured over tests/support/personMotionCourse.ts).
 *
 * FAMILIES. The sim's modes fall into families that share a body: on the
 * ground (stand, walk, run, wade: one gait whose speed, run share and depth
 * vary continuously), the air, a hard landing, the surface stroke, the dive,
 * the mantle, and the car (boarding and seated). Moving between families
 * cross-fades from the pose the figure was last drawn in; within the ground
 * family nothing is faded, the gait's phase and the planted feet carry on.
 * Into and out of the car there is no fade either: the root changes frames
 * (the feet point and the seat frame), and the boarding moves start and end
 * exactly where the walker stands.
 *
 * WHAT IS PUBLISHED and what is not: the walking and running joint curves,
 * cadence and stride (`gaitData.ts`, `gait.ts`); the swimming, landing,
 * climbing, boarding and seated poses are ESTIMATES (`actions.ts`,
 * `carSeat.ts`, the climb's pelvis curves here).
 */
export interface MotionInput {
  readonly person: PersonVisualState;
  /** The root's velocity in its own frame, m/s: forward, up, right. */
  readonly forward: number;
  readonly up: number;
  readonly right: number;
  /** The root's yaw rate, rad/s, positive turning right. */
  readonly turnRate: number;
  /** The drawn ground's height at a root-frame offset, relative to the root. */
  readonly ground: GroundOffset;
  readonly steeringWheel: number;
  /** Where the camera aims relative to the facing, radians (yaw right, pitch up). */
  readonly lookYaw: number;
  readonly lookPitch: number;
  readonly boardingFrom: BoardingFrom | null;
  /** The boarding door's opening as drawn, 0..1, or null to time it from the progress. */
  readonly boardingDoor: number | null;
}

export interface MotionOutput {
  footStrikes: number;
  strikeStrength: number;
  strikeFoot: "left" | "right";
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type Family = "ground" | "air" | "land" | "swim" | "dive" | "mantle" | "car";

const FAMILY: Readonly<Record<PersonMode, Family>> = Object.freeze({
  stand: "ground",
  walk: "ground",
  run: "ground",
  wade: "ground",
  air: "air",
  land: "land",
  swim: "swim",
  dive: "dive",
  mantle: "mantle",
  board: "car",
  seated: "car",
});

/** Seconds to cross-fade into a family from another. */
const FADE_INTO: Readonly<Record<Family, number>> = Object.freeze({
  ground: 0.22,
  air: 0.16,
  land: 0.08,
  swim: 0.45,
  dive: 0.45,
  mantle: 0.25,
  car: 0,
});

const GRAVITY = 9.80665;
const DEG = Math.PI / 180;
const H = PROPORTIONS.stature;
/** The eyes, between them, in the bind pose: the swimmer's anchor. */
const EYE_BIND = Object.freeze([0.085, PERSON.eyeHeight, 0]);
const VERY_SLOW = WALK_GROUP_SPEED[0]!;
/** Speeds under this stand (both feet planted, stepping only to turn or settle). */
const STAND_SPEED = 0.1;
/**
 * How fast the pelvis may rise off the feet out of a landing's crouch, a
 * climb or a seat, m/s: the move's own rising, not a foot letting the
 * pelvis down mid-stride (`MAX_RISE`).
 */
const ACTION_RISE = 3;
/** The sim's feet further than this from the drawn terrain stand on something it does not draw, m. */
const OFF_TERRAIN = 0.12;
/** The climb's hands: how far ahead of where it began they go on the top, and how far apart. */
const CLIMB_HAND_REACH = 0.36;
const CLIMB_HAND_SPREAD = 0.2;
/** Under this top the climber bends over further for it, up to `CLIMB_LOW_LEAN` degrees half a metre lower. */
const CLIMB_LEAN_HEIGHT = 1.0;
const CLIMB_LOW_LEAN = 55;
/**
 * The climb's pelvis over its key times: its height over where the climb
 * began, as a constant plus a share of the ledge's height, and how far
 * ahead of the climb's start. ESTIMATES: standing, crouched to jump, the
 * hands on the top, pressed up on straight arms 0.15 m over it, the left
 * knee over it, its foot on it, standing on it.
 */
const CLIMB_PELVIS_TIMES = Object.freeze([0, 0.12, 0.3, 0.48, 0.56, 0.66, 1]);
const CLIMB_PELVIS_HEIGHT = Object.freeze([0.93, 0.78, 0.6, 0.15, 0.22, 0.47, 0.93]);
const CLIMB_PELVIS_LEDGE = Object.freeze([0, 0, 0.5, 1, 1, 1, 1]);
const CLIMB_PELVIS_AHEAD = Object.freeze([0, 0.02, 0.08, 0.18, 0.24, 0.32, 0.32]);

export class PersonMotion {
  /** The drawn pose: locals and globals current after `update`. */
  readonly pose = new FigurePose();
  private readonly target = new FigurePose();
  private readonly from = new FigurePose();
  private readonly ch = createChannels();
  private readonly extra = createChannels();
  private readonly gait = new GaitChannels();
  private readonly actions = new ActionChannels();
  private readonly seat = new CarSeatMotion();
  readonly feet = new FootPlanter();
  private readonly q = new Float64Array(16);
  private readonly v = new Float64Array(6);

  private family: Family | null = null;
  // Fractional fields start from a double (src/sim/ground/doubleZero.ts); those that start at 1 are set so
  // in the constructor.
  private fade = DOUBLE_ZERO;
  private fadeSeconds = DOUBLE_ZERO;
  private familyAge = DOUBLE_ZERO;
  private time = DOUBLE_ZERO;
  /** The left leg's gait phase, strides. */
  phase = DOUBLE_ZERO;
  private runBlend = DOUBLE_ZERO;
  private lastSpeed = DOUBLE_ZERO;
  private acceleration = DOUBLE_ZERO;
  private roll = DOUBLE_ZERO;
  private strokeCycle = DOUBLE_ZERO;
  private crawlBlend = DOUBLE_ZERO;
  private airSeconds = DOUBLE_ZERO;
  private lastLandingAge = Number.POSITIVE_INFINITY;
  private firstPerson = false;
  private lookWeight = DOUBLE_ZERO;
  /** The mantle is a climb from the feet (upright from its start), not out of the water. */
  private climbing = false;
  /** The root's rise and travel since the mantle began, and the ledge's height over where it began, m. */
  private climbUp = DOUBLE_ZERO;
  private climbForward = DOUBLE_ZERO;
  private climbHeight = 0.8;
  /** The drawn ground under the feet, relative to the root, or flat when they stand on something else. */
  private groundSource: GroundOffset = flatGround;
  private groundOnTerrain = true;
  /** Both feet were on the ground as this family began, and the planter keeps them there. */
  private feetKept = false;
  private readonly solveOptions: Mutable<FootSolveOptions> = {
    stance: [true, true], standing: true, ground: flatGround, deltaSeconds: DOUBLE_ZERO, weight: DOUBLE_ZERO, riseRate: MAX_RISE,
    fallRate: DOUBLE_ZERO,
  };
  /** The ground family's frame: whether it stands, each foot's stance, the strike strength. */
  private readonly groundResult = { standing: false, stanceL: true, stanceR: true, strength: DOUBLE_ZERO };

  constructor() {
    this.fade = 1;
    this.lookWeight = 1;
  }

  setFirstPersonView(enabled: boolean): void {
    this.firstPerson = enabled;
  }

  update(input: MotionInput, deltaSeconds: number, output: MotionOutput): void {
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    const person = input.person;
    output.footStrikes = 0;
    this.time += dt;
    const family = FAMILY[person.mode];
    if (family !== this.family) this.enter(family);
    if (family === "mantle" && this.familyAge === 0) {
      // From the feet the sim holds the body upright from the start; out of the water it pitches up.
      this.climbing = person.swimPitch > Math.PI / 2 - 0.05;
      this.climbUp = 0;
      this.climbForward = 0;
      this.climbHeight = 0.8;
    }
    this.familyAge += dt;
    if (this.fade < 1) this.fade = this.fadeSeconds > 0 ? Math.min(1, this.fade + dt / this.fadeSeconds) : 1;
    if (family !== "car") this.feet.carry(input.forward * dt, input.up * dt, input.right * dt, input.turnRate * dt);

    // A landing on the ground (not a plunge into water): the sim's clock since the last one went back.
    if (person.landingAge < this.lastLandingAge - 1e-3 && person.landingSpeed > 0.5 && person.grounded) {
      output.footStrikes += 1;
      output.strikeStrength = Math.min(1, 0.3 + person.landingSpeed / 8);
      output.strikeFoot = "left";
    }
    this.lastLandingAge = person.landingAge;

    const target = this.target;
    target.reset();
    const ch = this.ch;
    ch.set(STAND);
    let groundWeight = 0;
    let standing = false;
    let stanceL = true;
    let stanceR = true;
    let strikeStrength = 0;
    // The sim's feet stand on the drawn terrain (it is under the root), or on a deck, a rail's top or a
    // ledge the terrain does not draw: then the ground is flat at the root.
    this.groundSource = input.ground;
    this.groundOnTerrain = Math.abs(input.ground(0, 0)) < OFF_TERRAIN;
    let ground: GroundOffset = this.stoodOn;
    let lookWeight = 1;
    switch (family) {
      case "ground": {
        const result = this.groundFamily(input, dt, ch);
        groundWeight = 1;
        standing = result.standing;
        stanceL = result.stanceL;
        stanceR = result.stanceR;
        strikeStrength = result.strength;
        this.setRoot(target, 0, 0, 0, 0, 0, this.roll);
        break;
      }
      case "air": {
        this.airSeconds += dt;
        this.actions.air(input.up, this.airSeconds, ch);
        // A running leap keeps its stride's shape.
        const leap = smoothstep(2, 4, person.speed);
        if (leap > 0) {
          this.extra.set(STAND);
          this.gait.write(this.extra, this.phase, Math.max(person.speed, 2), 1, 1);
          mixChannels(ch, this.extra, 0.6 * leap, ch);
        }
        lookWeight = 0.5;
        this.setRoot(target, 0, 0, 0, 0, 0, 0);
        break;
      }
      case "land": {
        const t = person.landingAge;
        if (person.landingSpeed >= PERSON.landingRollSpeed) {
          const angle = this.actions.roll(t, ch);
          const rolling = angle > 0 && angle < 2 * Math.PI ? 1 : 0;
          const keyed = rollKeyedSeconds(t);
          groundWeight = 1 - smoothstep(0.08, 0.14, keyed) * (1 - smoothstep(0.7, 0.8, keyed));
          standing = true;
          this.placeRoll(target, angle, rolling);
        } else {
          const hard = (person.landingSpeed - PERSON.landingHardSpeed) / (PERSON.landingRollSpeed - PERSON.landingHardSpeed);
          this.actions.crouch(t, 0.45 + 0.55 * Math.min(1, Math.max(0, hard)), ch);
          groundWeight = 1;
          standing = true;
          this.setRoot(target, 0, 0, 0, 0, 0, 0);
        }
        lookWeight = 0;
        break;
      }
      case "swim":
      case "dive": {
        lookWeight = 0;
        this.swimFamily(input, dt, ch, family === "dive");
        break;
      }
      case "mantle": {
        const t = Math.min(1, this.familyAge / PERSON.mantleSeconds);
        lookWeight = 0;
        if (this.climbing) {
          this.climbFrame(input, t, dt, ch, target);
          // The left foot up onto the top, then the right: the planter holds them there as the body comes over.
          groundWeight = smoothstep(0.6, 0.68, t);
          stanceL = t > 0.62;
          stanceR = t > 0.88;
          standing = t > 0.88;
        } else {
          this.actions.mantle(t, ch);
          groundWeight = smoothstep(0.78, 1, t);
          standing = true;
          this.setRoot(target, 0, 0, 0, 0, 0, 0);
        }
        break;
      }
      case "car": {
        const place = this.seat.update(person.boarding, input.steeringWheel, input.boardingFrom, input.boardingDoor, dt, ch);
        if (place.walkSpeed > 0) {
          // Walking to the door: the gait at the walk's speed, its phase turning with the distance.
          const speed = place.walkSpeed;
          this.phase += (speed * dt) / Math.max(0.3, strideLength(speed, false));
          this.gait.write(ch, this.phase, speed, 0, walkAmplitude(speed));
          const footOff = this.gait.footOff(speed, 0);
          stanceL = fraction(this.phase) < footOff;
          stanceR = fraction(this.phase + 0.5) < footOff;
          standing = speed < STAND_SPEED;
          strikeStrength = 0.35;
        } else {
          standing = true;
          stanceL = place.stance[0];
          stanceR = place.stance[1];
          if (!stanceL || !stanceR) standing = false;
        }
        groundWeight = place.ground;
        ground = this.seatGround;
        lookWeight = person.boarding ? 0.3 : 1;
        this.setRoot(target, place.x, place.y - PROPORTIONS.hipHeight, place.z, place.yaw, 0, 0);
        break;
      }
    }
    this.lookWeight += (lookWeight - this.lookWeight) * Math.min(1, dt * 6);
    applyChannels(target, ch);
    if (family === "swim" || family === "dive") this.anchorEye(target);

    const pose = this.pose;
    blendPoses(this.from, target, smooth01(this.fade), pose);
    pose.computeGlobals();

    if (groundWeight > 0) {
      const options = this.solveOptions;
      options.stance = stanceFlags(stanceL, stanceR);
      options.standing = standing;
      options.ground = ground;
      options.deltaSeconds = dt;
      // Feet still on the ground from the family before (a landing's crouch, a climb) stay there through the fade.
      options.weight = groundWeight * (FADE_INTO[family] > 0 && !this.feetKept ? smooth01(this.fade) : 1);
      // A landing, a climb or a seat stands up off its crouch at its own pace.
      options.riseRate = family === "ground" ? MAX_RISE : ACTION_RISE;
      options.fallRate = family === "car" ? ACTION_RISE : Number.POSITIVE_INFINITY;
      const result = this.feet.solve(pose, options);
      if (result.strikes > 0 && family !== "land") {
        output.footStrikes += result.strikes;
        output.strikeStrength = standing ? 0.15 : strikeStrength;
        output.strikeFoot = result.strikeSide === 0 ? "left" : "right";
      }
    } else {
      this.feet.release();
    }
    if (family === "car") this.reachSeatTargets(pose);
    if (family === "mantle" && this.climbing) this.reachLedge(pose, Math.min(1, this.familyAge / PERSON.mantleSeconds));
    this.look(pose, input.lookYaw, input.lookPitch, this.lookWeight);
    if (this.firstPerson) {
      // The head (and the face) shrink into the neck: the eye sits inside it.
      pose.scales[BONE.head] = 0.001;
    }
    pose.computeGlobals();
  }

  private readonly seatGround: GroundOffset = () => SEAT.ground;
  private readonly stoodOn: GroundOffset = (forward, right) => (this.groundOnTerrain ? this.groundSource(forward, right) : 0);

  /**
   * One frame of the climb from the feet: its key poses, and the body drawn
   * under the root as it rises. The sim lifts the feet point onto the ledge
   * over the first 60% of the mantle (a smoothstep) and carries it over the
   * last 70%; the body is lower than that (crouched, then pressed up on its
   * arms with the pelvis just over the top) until the left foot is on the
   * top, where the feet's planter takes over. The ledge's height comes from
   * the rise so far, as the sim's smoothstep makes it.
   */
  private climbFrame(input: MotionInput, t: number, dt: number, ch: Float64Array, target: FigurePose): void {
    this.climbUp += input.up * dt;
    this.climbForward += input.forward * dt;
    const rise = smoothstep(0, 0.6, t);
    if (rise > 0.05) this.climbHeight = this.climbUp / rise;
    this.actions.climb(t, ch);
    const h = this.climbHeight;
    // A low top is further below the shoulders: the body bends over further to put its hands on it.
    const low = Math.min(1, Math.max(0, (CLIMB_LEAN_HEIGHT - h) / 0.5));
    ch[CH.spineFlex] = ch[CH.spineFlex]! + CLIMB_LOW_LEAN * low * smoothstep(0.04, 0.14, t) * (1 - smoothstep(0.5, 0.64, t));
    // The pelvis's height over where the climb began, and its travel toward the ledge.
    const pelvis = sampleCurve(CLIMB_PELVIS_TIMES, CLIMB_PELVIS_HEIGHT, t) + h * sampleCurve(CLIMB_PELVIS_TIMES, CLIMB_PELVIS_LEDGE, t);
    const ahead = sampleCurve(CLIMB_PELVIS_TIMES, CLIMB_PELVIS_AHEAD, t);
    const fromRoot = 1 - smoothstep(0.66, 0.88, t);
    this.setRoot(
      target,
      Math.max(0, ahead - this.climbForward) * fromRoot,
      Math.min(0, pelvis - PROPORTIONS.hipHeight - this.climbUp) * fromRoot,
      0,
      0,
      0,
      0,
    );
  }

  /** The climb's hands on the top: the wrists just over it, fixed there in the world while they bear the body. */
  private reachLedge(pose: FigurePose, t: number): void {
    const weight = smoothstep(0.08, 0.18, t) * (1 - smoothstep(0.6, 0.72, t));
    if (weight <= 0) return;
    const gp = pose.globalPositions;
    const x = CLIMB_HAND_REACH - 0.06 - this.climbForward;
    const y = this.climbHeight + 0.04 - this.climbUp;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const z = bones.sign * CLIMB_HAND_SPREAD;
      const ex = gp[bones.hand * 3]!;
      const ey = gp[bones.hand * 3 + 1]!;
      const ez = gp[bones.hand * 3 + 2]!;
      solveTwoBone(pose, bones.upperArm, bones.forearm, bones.hand, ex + (x - ex) * weight, ey + (y - ey) * weight, ez + (z - ez) * weight);
    }
    pose.computeGlobals();
  }

  private enter(family: Family): void {
    const previous = this.family;
    this.family = family;
    this.familyAge = 0;
    this.feetKept = family === "ground" && this.feet.feet[0].planted && this.feet.feet[1].planted;
    // The first frame, and the car's frame change, cut; everything else fades from the drawn pose.
    if (previous === null || family === "car" || previous === "car") {
      this.fade = 1;
      this.fadeSeconds = 0;
      this.feet.release();
    } else {
      this.from.copyFrom(this.pose);
      this.fade = 0;
      this.fadeSeconds = FADE_INTO[family];
    }
    if (family === "air") this.airSeconds = 0;
    if (family === "swim" || family === "dive") this.feet.release();
  }

  private groundFamily(input: MotionInput, dt: number, ch: Float64Array): { standing: boolean; stanceL: boolean; stanceR: boolean; strength: number } {
    const person = input.person;
    const speed = Math.max(0, person.speed);
    const runTarget = person.mode === "run" ? 1 : 0;
    this.runBlend += (runTarget - this.runBlend) * Math.min(1, dt / 0.3);
    if (Math.abs(this.runBlend - runTarget) < 1e-3) this.runBlend = runTarget;
    const rb = this.runBlend;
    const amplitude = walkAmplitude(speed) * (1 - rb) + rb;
    const stride = strideLength(speed, false) * (1 - rb) + strideLength(Math.max(speed, PERSON.walkRunSpeed), true) * rb;
    if (speed > 1e-3) this.phase += (speed * dt) / Math.max(0.05, stride);
    this.gait.write(ch, this.phase, speed, rb, amplitude);
    const footOff = this.gait.footOff(speed, rb);
    const standing = speed < STAND_SPEED && rb < 0.5;
    const stanceL = fraction(this.phase) < footOff;
    const stanceR = fraction(this.phase + 0.5) < footOff;

    // Wading: knees lifted higher through the swing, arms out for balance, leaning into the water.
    const depth = Math.min(1, Math.max(0, person.waterDepth / H - PERSON.wadeDepthFraction * 0.5) / (PERSON.swimDepthFraction - 0.5 * PERSON.wadeDepthFraction));
    if (depth > 0) {
      for (let side = 0; side < 2; side += 1) {
        const base = SIDE_BASE[side as 0 | 1];
        const phase = fraction(this.phase + side * 0.5);
        const swing = phase > footOff ? Math.sin((Math.PI * (phase - footOff)) / (1 - footOff)) : 0;
        ch[base + LIMB_OFFSET.hipFlex] = ch[base + LIMB_OFFSET.hipFlex]! + 22 * depth * swing * amplitude;
        ch[base + LIMB_OFFSET.knee] = ch[base + LIMB_OFFSET.knee]! + 40 * depth * swing * amplitude;
        ch[base + LIMB_OFFSET.shAbd] = ch[base + LIMB_OFFSET.shAbd]! + 45 * depth;
        ch[base + LIMB_OFFSET.shFlex] = ch[base + LIMB_OFFSET.shFlex]! * (1 - 0.6 * depth) + 12 * depth;
        ch[base + LIMB_OFFSET.elbow] = ch[base + LIMB_OFFSET.elbow]! + 30 * depth;
        ch[base + LIMB_OFFSET.foreTwist] = ch[base + LIMB_OFFSET.foreTwist]! + 50 * depth;
      }
      ch[CH.spineFlex] = ch[CH.spineFlex]! + 7 * depth;
    }

    // Leaning: forward with speed and acceleration, into a slope, into a turn.
    const accel = dt > 0 ? (speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = speed;
    this.acceleration += (accel - this.acceleration) * Math.min(1, dt * 4);
    const lean = 1.5 + rb * (3 + 1.5 * Math.max(0, speed - PERSON.walkRunSpeed));
    const slopeLean = Math.atan(person.slope) / DEG * (person.slope > 0 ? 0.35 : 0.2);
    const accelLean = Math.min(8, Math.max(-5, this.acceleration * 2.5));
    ch[CH.spineFlex] = ch[CH.spineFlex]! + (lean + slopeLean + accelLean) * Math.min(1, amplitude + 0.3);
    const turnLean = Math.atan((speed * input.turnRate) / GRAVITY);
    const rollTarget = Math.min(0.35, Math.max(-0.35, turnLean));
    this.roll += (rollTarget - this.roll) * Math.min(1, dt * 8);
    // Standing still: breathing and a slow weight shift.
    this.actions.idle(this.time, 1 - amplitude, ch);
    // A soft landing still bends the knees a moment.
    const age = person.landingAge;
    if (age < 0.35 && person.landingSpeed > 1.5) {
      const dip = Math.min(1, (person.landingSpeed - 1.5) / 3.5) * Math.sin((Math.PI * age) / 0.35);
      for (const base of SIDE_BASE) {
        ch[base + LIMB_OFFSET.hipFlex] = ch[base + LIMB_OFFSET.hipFlex]! + 25 * dip;
        ch[base + LIMB_OFFSET.knee] = ch[base + LIMB_OFFSET.knee]! + 45 * dip;
        ch[base + LIMB_OFFSET.ankle] = ch[base + LIMB_OFFSET.ankle]! + 18 * dip;
      }
      ch[CH.spineFlex] = ch[CH.spineFlex]! + 10 * dip;
    }
    const result = this.groundResult;
    result.standing = standing;
    result.stanceL = stanceL;
    result.stanceR = stanceR;
    result.strength = Math.min(1, 0.25 + 0.12 * speed);
    return result;
  }

  private swimFamily(input: MotionInput, dt: number, ch: Float64Array, diving: boolean): void {
    const person = input.person;
    const speed = Math.max(0, person.speed);
    const crawl = !diving && person.running ? 1 : 0;
    this.crawlBlend += (crawl - this.crawlBlend) * Math.min(1, dt / 0.4);
    const tread = 1 - smoothstep(0.12, 0.4, speed);
    // Stroke rate from the speed and a stroke's length (ESTIMATES): breaststroke about 1.15 m a stroke, crawl 1.7 m a cycle, the dive stroke 1.6 m.
    const breastRate = Math.min(1, Math.max(0.4, speed / 1.15));
    const crawlRate = Math.min(0.9, Math.max(0.45, speed / 1.7));
    const rate = diving ? Math.min(0.8, Math.max(0.3, speed / 1.6)) : breastRate + (crawlRate - breastRate) * this.crawlBlend;
    this.strokeCycle += rate * dt * (1 - 0.6 * tread);
    let roll = 0;
    if (diving) {
      this.actions.diveStroke(this.strokeCycle, ch);
    } else {
      this.actions.breaststroke(this.strokeCycle, ch);
      if (this.crawlBlend > 0) {
        roll = this.actions.crawl(this.strokeCycle, this.extra) * this.crawlBlend;
        mixChannels(ch, this.extra, this.crawlBlend, ch);
      }
    }
    if (tread > 0) {
      this.actions.tread(this.time, this.extra);
      if (diving) {
        // Hovering under water: the sculling hands, a slow kick, the body as the sim pitches it.
        for (let i = 0; i < this.extra.length; i += 1) this.extra[i] = this.extra[i]! * 0.6;
      }
      mixChannels(ch, this.extra, tread, ch);
    }
    // Body pitch: prone at the surface (the breaststroke's head up a little, more as it breathes), upright treading.
    const breath = diving ? 0 : (1 - this.crawlBlend) * Math.max(0, Math.sin(2 * Math.PI * (fraction(this.strokeCycle) - 0.1)));
    const style = diving ? 0 : (0.16 + 0.12 * breath) * (1 - this.crawlBlend) + 0.04 * this.crawlBlend;
    const swimPitch = -Math.PI / 2 + person.swimPitch + style;
    const treadPitch = diving ? swimPitch : -0.32;
    const pitch = swimPitch + (treadPitch - swimPitch) * tread;
    this.setRoot(this.target, 0, 0, 0, 0, pitch, 0, roll * DEG * (1 - tread));
  }

  /**
   * Sets the root bone: placed at (x, y, z), turned right by `yaw`, pitched
   * by `pitch` (about +Z: -pi/2 lies the body prone, head forward), leaning
   * right by `lean` (about its forward axis) and rolled right-side-down by
   * `roll` about its own long axis, those two applied first.
   */
  private setRoot(target: FigurePose, x: number, y: number, z: number, yaw: number, pitch: number, lean: number, roll = 0): void {
    target.offsets[0] = x;
    target.offsets[1] = y;
    target.offsets[2] = z;
    const q = this.q;
    setAxisAngle(q, 0, 0, -1, 0, yaw);
    setAxisAngle(q, 4, 0, 0, 1, pitch);
    multiplyQuaternions(q, 0, q, 4, q, 8);
    setAxisAngle(q, 4, 1, 0, 0, lean);
    multiplyQuaternions(q, 8, q, 4, q, 12);
    setAxisAngle(q, 4, 0, 1, 0, roll);
    multiplyQuaternions(q, 12, q, 4, target.rotations, 0);
  }

  /** The swimmer's eye on the anchor the sim floats: the root's (0, eye height, 0). */
  private anchorEye(target: FigurePose): void {
    target.computeGlobals();
    const v = this.v;
    target.posedPoint(BONE.head, EYE_BIND[0]!, EYE_BIND[1]!, EYE_BIND[2]!, v, 0);
    target.offsets[0] = target.offsets[0]! - v[0]!;
    target.offsets[1] = target.offsets[1]! + PERSON.eyeHeight - v[1]!;
    target.offsets[2] = target.offsets[2]! - v[2]!;
  }

  /** The roll: the tucked body turned forward by `angle` about its own centre, held over the feet point. */
  private placeRoll(target: FigurePose, angle: number, rolling: number): void {
    // The tuck's centre in the figure's own frame (the pelvis drawn up into a ball) and where it rolls.
    const kx = 0.12;
    const ky = PROPORTIONS.hipHeight + 0.05;
    const centreHeight = 0.42;
    const q = this.q;
    setAxisAngle(q, 0, 0, 0, 1, -angle);
    target.rotations.set(q.subarray(0, 4), 0);
    rotateVector(q, 0, kx, ky, 0, this.v, 0);
    target.offsets[0] = (0 - this.v[0]!) * rolling;
    target.offsets[1] = (centreHeight - this.v[1]!) * rolling;
    target.offsets[2] = 0;
    if (!rolling) setEuler(target.rotations, 0, 0, 0, 0);
  }

  /** Hands to the wheel or the car's handles, feet to the step or the pedals. */
  private reachSeatTargets(pose: FigurePose): void {
    const place = this.seat.placement;
    const t = place.targets;
    const w = place.weights;
    const gp = pose.globalPositions;
    const q = this.q;
    for (let side = 0; side < 2; side += 1) {
      const bones = SIDES[side]!;
      const hand = w[side]!;
      if (hand > 0) {
        // The wrist a palm's length short of the grip, toward the shoulder.
        const sx = gp[bones.upperArm * 3]!;
        const sy = gp[bones.upperArm * 3 + 1]!;
        const sz = gp[bones.upperArm * 3 + 2]!;
        const gx = t[side * 3]!;
        const gy = t[side * 3 + 1]!;
        const gz = t[side * 3 + 2]!;
        const d = Math.hypot(gx - sx, gy - sy, gz - sz) || 1;
        const palm = 0.075;
        const wx = gx - ((gx - sx) / d) * palm;
        const wy = gy - ((gy - sy) / d) * palm;
        const wz = gz - ((gz - sz) / d) * palm;
        const ex = gp[bones.hand * 3]!;
        const ey = gp[bones.hand * 3 + 1]!;
        const ez = gp[bones.hand * 3 + 2]!;
        solveTwoBone(pose, bones.upperArm, bones.forearm, bones.hand, ex + (wx - ex) * hand, ey + (wy - ey) * hand, ez + (wz - ez) * hand);
        // The hand points at the grip.
        const hx = BIND_POSITIONS[bones.fingers * 3]! - BIND_POSITIONS[bones.hand * 3]!;
        const hy = BIND_POSITIONS[bones.fingers * 3 + 1]! - BIND_POSITIONS[bones.hand * 3 + 1]!;
        const hz = BIND_POSITIONS[bones.fingers * 3 + 2]! - BIND_POSITIONS[bones.hand * 3 + 2]!;
        const hl = Math.hypot(hx, hy, hz);
        const px = gx - gp[bones.hand * 3]!;
        const py = gy - gp[bones.hand * 3 + 1]!;
        const pz = gz - gp[bones.hand * 3 + 2]!;
        const pl = Math.hypot(px, py, pz) || 1;
        rotationBetween(hx / hl, hy / hl, hz / hl, px / pl, py / pl, pz / pl, q, 0);
        const current = pose.globalRotations;
        const o = bones.hand * 4;
        // nlerp(current, aim, hand) into q[4..7]
        const dot = current[o]! * q[0]! + current[o + 1]! * q[1]! + current[o + 2]! * q[2]! + current[o + 3]! * q[3]!;
        const sign = dot < 0 ? -1 : 1;
        let length = 0;
        for (let i = 0; i < 4; i += 1) {
          q[4 + i] = current[o + i]! * (1 - hand) + q[i]! * hand * sign;
          length += q[4 + i]! * q[4 + i]!;
        }
        length = Math.sqrt(length) || 1;
        for (let i = 0; i < 4; i += 1) q[4 + i] = q[4 + i]! / length;
        setGlobalRotation(pose, bones.hand, q, 4);
        pose.computeGlobals();
      }
      const foot = w[2 + side]!;
      if (foot > 0) {
        const ex = gp[bones.foot * 3]!;
        const ey = gp[bones.foot * 3 + 1]!;
        const ez = gp[bones.foot * 3 + 2]!;
        const tx = t[6 + side * 3]!;
        const ty = t[6 + side * 3 + 1]!;
        const tz = t[6 + side * 3 + 2]!;
        solveTwoBone(pose, bones.thigh, bones.shin, bones.foot, ex + (tx - ex) * foot, ey + (ty - ey) * foot, ez + (tz - ez) * foot);
      }
    }
  }

  /**
   * The head turned toward where the camera aims (up to 70 degrees either way,
   * 40 up and 45 down), the neck taking 40% of it; looking back past 100
   * degrees eases the head back to the front.
   */
  private look(pose: FigurePose, yaw: number, pitch: number, lookWeight: number): void {
    const away = 1 - smoothstep(100 * DEG, 150 * DEG, Math.abs(yaw));
    const weight = lookWeight * away;
    if (weight <= 0.001) return;
    const turn = Math.min(70 * DEG, Math.max(-70 * DEG, yaw));
    const nod = Math.min(40 * DEG, Math.max(-45 * DEG, pitch));
    const q = this.q;
    const gr = pose.globalRotations;
    const head = BONE.head * 4;
    // The head's wanted orientation in the root's frame: the root bone's, turned and nodded.
    setAxisAngle(q, 0, 0, -1, 0, turn);
    setAxisAngle(q, 4, 0, 0, 1, nod);
    multiplyQuaternions(q, 0, q, 4, q, 8);
    multiplyQuaternions(gr, 0, q, 8, q, 12);
    // delta = wanted * head^-1 (root frame), taken by `weight`: the neck turns 40% of it, the head the rest.
    q[0] = -gr[head]!;
    q[1] = -gr[head + 1]!;
    q[2] = -gr[head + 2]!;
    q[3] = gr[head + 3]!;
    multiplyQuaternions(q, 12, q, 0, q, 4);
    partialRotation(q, 4, weight, q, 8);
    // The head's target: the weighted delta on the head as drawn now (q[12..15]).
    multiplyQuaternions(q, 8, gr, head, q, 12);
    partialRotation(q, 8, 0.4, q, 0);
    multiplyQuaternions(q, 0, gr, BONE.neck * 4, q, 4);
    setGlobalRotation(pose, BONE.neck, q, 4);
    pose.computeGlobals();
    setGlobalRotation(pose, BONE.head, q, 12);
  }
}

/** `share` of the rotation at `q[qo]` (the same axis, that share of its angle), into `out[oo]`. */
function partialRotation(q: Float64Array, qo: number, share: number, out: Float64Array, oo: number): void {
  const w = q[qo + 3]!;
  const sign = w < 0 ? -1 : 1;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-9) {
    setAxisAngle(out, oo, 0, 1, 0, 0);
    return;
  }
  const angle = 2 * Math.acos(Math.min(1, Math.abs(w)));
  setAxisAngle(out, oo, (q[qo]! * sign) / s, (q[qo + 1]! * sign) / s, (q[qo + 2]! * sign) / s, angle * share);
}

function stanceFlags(left: boolean, right: boolean): readonly [boolean, boolean] {
  return left ? (right ? BOTH : LEFT_ONLY) : right ? RIGHT_ONLY : NEITHER;
}

const BOTH = Object.freeze([true, true] as const);
const LEFT_ONLY = Object.freeze([true, false] as const);
const RIGHT_ONLY = Object.freeze([false, true] as const);
const NEITHER = Object.freeze([false, false] as const);

/**
 * How much of the published stride the gait plays at a walking speed: the
 * whole of it from the slowest group's speed up; below it the step shortens
 * with the square root of the speed (`walkCadence`'s rule), and under the
 * standing speed it fades out.
 */
export function walkAmplitude(speed: number): number {
  const vHat = dimensionlessSpeed(Math.max(0, speed));
  return Math.min(1, Math.sqrt(vHat / VERY_SLOW)) * smoothstep(STAND_SPEED * 0.5, STAND_SPEED * 2.5, speed);
}

/** The value at `t` of a curve through (times, values), smoothstepped between its keys. */
function sampleCurve(times: readonly number[], values: readonly number[], t: number): number {
  if (t <= times[0]!) return values[0]!;
  for (let i = 0; i + 1 < times.length; i += 1) {
    if (t <= times[i + 1]!) return values[i]! + (values[i + 1]! - values[i]!) * smooth01((t - times[i]!) / (times[i + 1]! - times[i]!));
  }
  return values[values.length - 1]!;
}

function flatGround(): number {
  return 0;
}

function fraction(value: number): number {
  return value - Math.floor(value);
}

function smooth01(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

