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
 * Into and out of the car the root changes frames (the feet point and the
 * seat frame) at the same place in the world, the boarding moves starting
 * and ending exactly where the walker stands: the root bone cuts to the new
 * frame's and the body under it fades as between any two families.
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
/** The arm from the shoulder to the wrist, straight. */
const ARM_LENGTH = boneLength(SIDES[0]!.upperArm, SIDES[0]!.forearm) + boneLength(SIDES[0]!.forearm, SIDES[0]!.hand);
/** The share of a limb's length from which it straightens toward a target only asymptotically (`softReach`). */
const SOFT_REACH_FROM = 0.88;
/** Seconds a foot takes off the ground to its place in a getting-in's pose (up to the car's step, after the body off the ground). */
const CAR_PICK_UP_SECONDS = 0.32;
/** Seconds the body takes to fade across the car's frame change, in or out. */
const CAR_FADE = 0.25;
/** Seconds the body takes to come up from behind the root, where a walker's is drawn, as he turns to the car. */
const CAR_CATCH_UP = 0.4;
/**
 * How fast he settles into standing at ease and comes out of it, 1/s: over a third of a second, where the gait
 * takes hold in three frames of a start (and the stand is there at once out of the car or off a landing).
 */
const EASE_RESPONSE = 8;
/** The share of a foot's swing after which the body starts down to its strike. */
const LANDING_FROM = 0.4;
/** A foot that comes down this far behind the other, the way the walker is going, is the stride's back foot (`matchStride`), metres. */
const STRIDE_SWAP_BEHIND = 0.06;
/** Seconds the body takes to fade into the stride's other half then. */
const STRIDE_SWAP_FADE = 0.2;
/** How quickly the drawn body follows the root's turn on foot, rad/s (the spring's natural frequency). */
const TURN_RESPONSE = 20;
/** The most the body leans into a turn, radians. */
const MAX_TURN_LEAN = 0.25;
/**
 * The lean into a turn is the physical one (the body in line with gravity
 * and the turn's pull) up to what a body does at its speed: the sim turns a
 * walker 540 degrees a second, which would lay him over like a motorcycle.
 * Radians at a stand and more per m/s; and how fast the lean follows, 1/s.
 */
const TURN_LEAN_STANDING = 0.03;
const TURN_LEAN_PER_SPEED = 0.045;
const TURN_LEAN_RESPONSE = 12;
/**
 * The stride's phase a walk starts from: the left foot in mid stance under
 * the body, the right lifting to step (or the mirror image, half a stride
 * on), which is how feet stood side by side begin.
 */
const START_PHASE = 0.3;

const GRAVITY = 9.80665;
const DEG = Math.PI / 180;
const H = PROPORTIONS.stature;
/** The eyes, between them, in the bind pose: the swimmer's anchor. */
const EYE_BIND = Object.freeze([0.085, PERSON.eyeHeight, 0]);
/**
 * The surface strokes' body angle, radians head-up from prone (ESTIMATES).
 * The sim floats the eye 5 cm above the water, so both strokes are swum
 * head-up, as a recreational breaststroke and a water-polo crawl are: the
 * trunk inclined and the neck extended put the shoulders just under the
 * surface with the eye out. Flatter, the body would lie on top of the water.
 */
const BREAST_INCLINE = 0.42;
const CRAWL_INCLINE = 0.22;
const VERY_SLOW = WALK_GROUP_SPEED[0]!;
/** Speeds under this stand (both feet planted, stepping only to turn or settle). */
const STAND_SPEED = 0.1;
/**
 * How fast the drawn body follows the root over the ground, 1/s (a
 * critically damped spring; faster in proportion above a walk's speed, so a
 * run trails no further than a walk). The sim starts a walk in under a fifth
 * of a second and stops it in a tenth, within 8 cm; a body does neither: it
 * leans into its first step, and stopping it carries on over its front foot
 * and brings the other up. The body trails a steady walk by 2 v / response,
 * 0.16 m, and comes to rest on the root.
 */
const BODY_RESPONSE = 18;
/** The share of the gait's swing a hard stop cuts off the step it catches him in. */
const BRAKING_SHORTENS = 0.5;
const BRAKING_RESPONSE = 25;
/** How fast the lean into an acceleration follows it, 1/s, twice over. */
const LEAN_RESPONSE = 8;
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
  /** The pose the walker stands at the car's door in, while he walks to it (the gait plays over it). */
  private readonly doorCh = createChannels();
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
  private accelerationFelt = DOUBLE_ZERO;
  /**
   * On foot, the body's place off the root (the root's frame, metres
   * forward and right) and its own velocity over the ground, m/s: it
   * follows the root as a spring does (`BODY_RESPONSE`).
   */
  private lagX = DOUBLE_ZERO;
  private lagZ = DOUBLE_ZERO;
  private lagRateX = DOUBLE_ZERO;
  private lagRateZ = DOUBLE_ZERO;
  private lagFresh = true;
  /** 0..1: how hard he is pulling up (the root slower than the body), eased. */
  private braking = DOUBLE_ZERO;
  /** The speed the gait plays at: the body's own, held up through a reversal (see `groundFamily`). */
  private gaitSpeed = DOUBLE_ZERO;
  /** 0..1: how far he has settled into standing at ease (`ActionChannels.idle`), eased. */
  private atEase = DOUBLE_ZERO;
  /** How far the pelvis stands to the body's right, at ease on that leg, metres. */
  private sway = DOUBLE_ZERO;
  /** Where the body was drawn off the root as he left the ground for the car (its lag, turn and lean): eased out there. */
  private leftLagX = DOUBLE_ZERO;
  private leftLagZ = DOUBLE_ZERO;
  private leftTurn = DOUBLE_ZERO;
  private leftRoll = DOUBLE_ZERO;
  private roll = DOUBLE_ZERO;
  private rollFelt = DOUBLE_ZERO;
  /**
   * On foot the sim turns the walker at a fixed rate from one frame to the
   * next (`PERSON.turnRateWalk`); the drawn body picks a turn up and settles
   * out of it. Its facing to the right of the root's, radians, and its own
   * turn rate, rad/s.
   */
  private turnLag = DOUBLE_ZERO;
  private turnLagRate = DOUBLE_ZERO;
  /** The body's facing in the root's frame last frame (`FootSolveOptions.facing`). */
  private facing = DOUBLE_ZERO;
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
  /** This family began with the root changing frames (into or out of the car). */
  private rootCut = false;
  /** 0..1 through the fade into the stride's other half (`matchStride`), from the channels it changed at. */
  private swapFade = DOUBLE_ZERO;
  private readonly swapCh = new Float64Array(STAND.length);
  private readonly solveOptions: Mutable<FootSolveOptions> = {
    stance: [true, true], standing: true, upright: true, ground: flatGround, deltaSeconds: DOUBLE_ZERO, weight: DOUBLE_ZERO, riseRate: MAX_RISE,
    fallRate: DOUBLE_ZERO, facing: DOUBLE_ZERO, landing: [DOUBLE_ZERO, DOUBLE_ZERO], strikeIn: DOUBLE_ZERO, step: -1,
    stepX: DOUBLE_ZERO, stepZ: DOUBLE_ZERO, pickUpSeconds: DOUBLE_ZERO,
  };
  /** Each foot's share of the way down to the ground (the planter's `landing`), left then right. */
  private readonly landing: [number, number] = [DOUBLE_ZERO, DOUBLE_ZERO];
  /** Seconds until the gait's next foot strike (the planter's `strikeIn`), or 0. */
  private strikeIn = DOUBLE_ZERO;
  /** The ground family's frame: whether it stands, each foot's stance, the strike strength. */
  private readonly groundResult = { standing: false, stanceL: true, stanceR: true, strength: DOUBLE_ZERO };

  constructor() {
    this.fade = 1;
    this.swapFade = 1;
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
    this.landing[0] = 0;
    this.landing[1] = 0;
    this.strikeIn = 0;
    if (family !== "ground") {
      this.turnLag = 0;
      this.turnLagRate = 0;
      this.lagX = 0;
      this.lagZ = 0;
      this.lagFresh = true;
      this.braking = 0;
      this.gaitSpeed = 0;
      this.swapFade = 1;
      this.atEase = 0;
      this.sway = 0;
    }
    switch (family) {
      case "ground": {
        const result = this.groundFamily(input, dt, ch);
        groundWeight = 1;
        standing = result.standing;
        stanceL = result.stanceL;
        stanceR = result.stanceR;
        strikeStrength = result.strength;
        // (The pelvis over the leg he stands on: to his own right, as he faces.)
        this.setRoot(target, this.lagX - Math.sin(this.turnLag) * this.sway, 0, this.lagZ + Math.cos(this.turnLag) * this.sway, this.turnLag, 0, this.roll);
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
          // Walking to the door: the gait at the walk's speed, its phase turning with the distance, over the
          // pose he stands at the door in, which takes over as he arrives.
          const speed = place.walkSpeed;
          this.phase += (speed * dt) / Math.max(0.3, strideLength(speed, false));
          const atDoor = this.doorCh;
          atDoor.set(ch);
          this.gait.write(ch, this.phase, speed, 0, walkAmplitude(speed));
          for (let i = 0; i < ch.length; i += 1) ch[i] = atDoor[i]! + (ch[i]! - atDoor[i]!) * place.gait;
          const footOff = this.gait.footOff(speed, 0);
          stanceL = fraction(this.phase) < footOff;
          stanceR = fraction(this.phase + 0.5) < footOff;
          standing = speed < STAND_SPEED;
          if (!standing) this.land(footOff, Math.max(0.3, strideLength(speed, false)) / speed);
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
        // A walker's body is drawn behind the root (`groundFamily`), and the move starts at the root: it starts
        // from where he was drawn, and that eases out.
        const behind = input.boardingFrom ? 1 - smooth01(Math.min(1, this.familyAge / CAR_CATCH_UP)) : 0;
        const facingC = input.boardingFrom ? Math.cos(input.boardingFrom.facing) : 1;
        const facingS = input.boardingFrom ? Math.sin(input.boardingFrom.facing) : 0;
        this.setRoot(
          target,
          place.x + (this.leftLagX * facingC - this.leftLagZ * facingS) * behind,
          place.y - PROPORTIONS.hipHeight,
          place.z + (this.leftLagX * facingS + this.leftLagZ * facingC) * behind,
          place.yaw + this.leftTurn * behind,
          0,
          this.leftRoll * behind,
        );
        break;
      }
    }
    this.lookWeight += (lookWeight - this.lookWeight) * Math.min(1, dt * 6);
    applyChannels(target, ch);
    if (family === "swim" || family === "dive") this.anchorEye(target);

    // On foot the root faces the way the sim's walker does and the body turns after it; in the seat frame the
    // body turns in it. Feet on the ground stay as they are under either turn.
    const facing = family === "car" ? this.seat.placement.yaw : family === "ground" ? this.turnLag : 0;
    this.feet.turn(facing - this.facing);
    this.facing = facing;

    const pose = this.pose;
    if (this.fade < 1 && this.rootCut) {
      // Across the car's frame change the root bone is the new frame's from the start: only the body under it fades.
      for (let i = 0; i < 4; i += 1) this.from.rotations[i] = target.rotations[i]!;
      for (let i = 0; i < 3; i += 1) this.from.offsets[i] = target.offsets[i]!;
    }
    blendPoses(this.from, target, smooth01(this.fade), pose);
    pose.computeGlobals();

    if (groundWeight > 0) {
      const options = this.solveOptions;
      options.stance = stanceFlags(stanceL, stanceR);
      options.standing = standing;
      options.upright = family === "ground" || family === "car";
      options.ground = ground;
      options.deltaSeconds = dt;
      // Feet still on the ground from the family before (a landing's crouch, a climb) stay there through the fade.
      options.weight = groundWeight * (FADE_INTO[family] > 0 && !this.feetKept ? smooth01(this.fade) : 1);
      // A landing, a climb or a seat stands up off its crouch at its own pace.
      // (The walk to a car's door is a walk.)
      const walking = family === "ground" || (family === "car" && this.seat.placement.walkSpeed > 0);
      options.riseRate = walking ? MAX_RISE : ACTION_RISE;
      options.fallRate = family === "car" ? ACTION_RISE : Number.POSITIVE_INFINITY;
      options.facing = facing;
      options.landing = this.landing;
      options.strikeIn = this.strikeIn;
      options.step = family === "car" ? this.seat.placement.step : -1;
      options.stepX = this.seat.placement.stepX;
      options.stepZ = this.seat.placement.stepZ;
      options.pickUpSeconds = family === "car" && !walking ? CAR_PICK_UP_SECONDS : 0;
      const result = this.feet.solve(pose, options);
      if (result.strikes > 0 && family !== "land") {
        output.footStrikes += result.strikes;
        output.strikeStrength = standing ? 0.15 : strikeStrength;
        output.strikeFoot = result.strikeSide === 0 ? "left" : "right";
      }
      if (family === "ground" && !standing && result.strikes === 1) this.matchStride(result.strikeSide, input);
    } else {
      this.feet.release();
    }
    if (family === "car") this.reachSeatTargets(pose);
    if (family === "mantle" && this.climbing) this.reachLedge(pose, Math.min(1, this.familyAge / PERSON.mantleSeconds));
    this.look(pose, input.lookYaw - (family === "ground" ? this.turnLag : 0), input.lookPitch, this.lookWeight);
    if (this.firstPerson) {
      // The head (and the face) shrink into the neck: the eye sits inside it.
      pose.scales[BONE.head] = 0.001;
    }
    pose.computeGlobals();
  }

  /**
   * A foot has just come down with the other still on the ground. Walking on
   * a line it comes down ahead of the other; turned about over his feet (the
   * sim turns a walker round in a third of a second) it comes down behind it,
   * the way he is now going, and it is the other that is under him. The
   * stride then changes halves: the foot behind is the next to lift, as a
   * man who turns about steps off with the foot he has left behind him.
   */
  private matchStride(struck: 0 | 1, input: MotionInput): void {
    const down = this.feet.feet[struck];
    const other = this.feet.feet[1 - struck]!;
    if (!other.planted) return;
    const rootSpeed = Math.hypot(input.forward, input.right);
    const wayX = rootSpeed > STAND_SPEED ? input.forward / rootSpeed : 1;
    const wayZ = rootSpeed > STAND_SPEED ? input.right / rootSpeed : 0;
    const ahead = (down.ax - other.ax) * wayX + (down.az - other.az) * wayZ;
    if (ahead > -STRIDE_SWAP_BEHIND) return;
    this.phase += 0.5;
    // (The feet are where they are; the rest of him fades into the other half from the angles drawn.)
    this.swapCh.set(this.ch);
    this.swapFade = 0;
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
    const walked = previous === "ground";
    // (Where the body was drawn: behind the root, and over the leg he stood on.)
    this.leftLagX = walked ? this.lagX - Math.sin(this.turnLag) * this.sway : 0;
    this.leftLagZ = walked ? this.lagZ + Math.cos(this.turnLag) * this.sway : 0;
    this.leftTurn = walked ? this.turnLag : 0;
    this.leftRoll = walked ? this.roll : 0;
    this.feetKept = family === "ground" && this.feet.feet[0].planted && this.feet.feet[1].planted;
    // The first frame cuts; everything else fades from the drawn pose. Into and out of the car the root changes
    // frames (the feet point and the seat frame) at the same place in the world: the root bone cuts to the new
    // frame's, the body under it fades, and the feet are planted afresh where they are drawn.
    this.rootCut = previous !== null && (family === "car" || previous === "car");
    if (previous === null) {
      this.fade = 1;
      this.fadeSeconds = 0;
      this.feet.release();
    } else {
      this.from.copyFrom(this.pose);
      this.fade = 0;
      this.fadeSeconds = this.rootCut ? CAR_FADE : FADE_INTO[family];
      if (this.rootCut) this.feet.release();
    }
    if (family === "air") this.airSeconds = 0;
    if (family === "swim" || family === "dive") this.feet.release();
  }

  /**
   * Each foot's `landing` for the planter at the gait's phase: coming down
   * over the end of its swing, down while it takes the weight, and let go of
   * through the rest of its stance (it is the only foot on the ground by then).
   */
  private land(footOff: number, strideSeconds: number): void {
    let next = 1;
    for (let side = 0; side < 2; side += 1) {
      const phase = fraction(this.phase + side * 0.5);
      this.landing[side] =
        phase < footOff ? 1 - smoothstep(0.5 * footOff, 0.8 * footOff, phase) : smoothstep(LANDING_FROM, 1, (phase - footOff) / (1 - footOff));
      next = Math.min(next, 1 - phase);
    }
    this.strikeIn = next * strideSeconds;
  }

  private groundFamily(input: MotionInput, dt: number, ch: Float64Array): { standing: boolean; stanceL: boolean; stanceR: boolean; strength: number } {
    const person = input.person;
    // The body follows the root as a critically damped spring does (`BODY_RESPONSE`), over this frame's steady
    // travel of the root exactly, as the turn below: it trails a steady walk by the lag that holds, picks its
    // speed up and loses it over a step, and comes to rest on the root. The lag and the body's own velocity
    // stay where they are in the world as the root turns.
    const turned = input.turnRate * dt;
    const turnC = Math.cos(turned);
    const turnS = Math.sin(turned);
    const rootSpeed = Math.hypot(input.forward, input.right);
    if (this.lagFresh) {
      this.lagFresh = false;
      this.lagRateX = input.forward;
      this.lagRateZ = input.right;
    }
    const response = BODY_RESPONSE * Math.max(1, rootSpeed / PERSON.walkSpeed);
    const bodyDecay = Math.exp(-response * dt);
    const lagX = this.lagX * turnC + this.lagZ * turnS;
    const lagZ = -this.lagX * turnS + this.lagZ * turnC;
    const rateX = this.lagRateX * turnC + this.lagRateZ * turnS;
    const rateZ = -this.lagRateX * turnS + this.lagRateZ * turnC;
    const heldX = (-2 * input.forward) / response;
    const heldZ = (-2 * input.right) / response;
    const closingX = rateX - input.forward + response * (lagX - heldX);
    const closingZ = rateZ - input.right + response * (lagZ - heldZ);
    this.lagX = heldX + (lagX - heldX + closingX * dt) * bodyDecay;
    this.lagZ = heldZ + (lagZ - heldZ + closingZ * dt) * bodyDecay;
    this.lagRateX = input.forward + (rateX - input.forward - closingX * response * dt) * bodyDecay;
    this.lagRateZ = input.right + (rateZ - input.right - closingZ * response * dt) * bodyDecay;
    if (rootSpeed <= 0 && Math.hypot(this.lagX, this.lagZ) < 1e-4 && Math.hypot(this.lagRateX, this.lagRateZ) < 1e-3) {
      this.lagX = 0;
      this.lagZ = 0;
      this.lagRateX = 0;
      this.lagRateZ = 0;
    }
    // The gait plays at the body's own speed over the ground, not the root's: the sim stops a walk within a
    // tenth of a second, and the legs and arms finish the step they were in as the body comes to rest.
    const moving = Math.hypot(this.lagRateX, this.lagRateZ);
    // (Slowing, only as far as the root has slowed: turning about, the body's speed passes through nothing on
    // its way to the other direction, which is not a stop, and the legs go on stepping through it.)
    this.gaitSpeed = moving >= this.gaitSpeed ? moving : Math.max(moving, Math.min(this.gaitSpeed, rootSpeed));
    const speed = this.gaitSpeed;
    const runTarget = person.mode === "run" ? 1 : 0;
    this.runBlend += (runTarget - this.runBlend) * Math.min(1, dt / 0.3);
    if (Math.abs(this.runBlend - runTarget) < 1e-3) this.runBlend = runTarget;
    const rb = this.runBlend;
    // Pulling up (the root slower than the body still is), the step he is in is cut short: it comes down nearer
    // under him, where he is coming to rest, not a full stride on.
    const braking = Math.min(1, Math.max(0, (moving - rootSpeed) / Math.max(moving, 0.3)));
    this.braking += (braking - this.braking) * (1 - Math.exp(-dt * BRAKING_RESPONSE));
    const amplitude = (walkAmplitude(speed) * (1 - rb) + rb) * (1 - BRAKING_SHORTENS * this.braking);
    const stride = strideLength(speed, false) * (1 - rb) + strideLength(Math.max(speed, PERSON.walkRunSpeed), true) * rb;
    if (amplitude <= 0) {
      // Standing, the stride is nowhere: the next walk starts on the foot the last one stopped nearer to.
      const stopped = fraction(this.phase - START_PHASE + 0.25);
      this.phase = stopped < 0.5 ? START_PHASE : START_PHASE + 0.5;
    } else {
      this.phase += (speed * dt) / Math.max(0.05, stride);
    }
    this.gait.write(ch, this.phase, speed, rb, amplitude);
    const footOff = this.gait.footOff(speed, rb);
    const standing = speed < STAND_SPEED && rb < 0.5;
    const stanceL = fraction(this.phase) < footOff;
    const stanceR = fraction(this.phase + 0.5) < footOff;
    if (!standing) this.land(footOff, Math.max(0.05, stride) / speed);

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
    // (The acceleration through two easings, one after the other: the lean starts and ends without a jerk.)
    const accel = dt > 0 ? (moving - this.lastSpeed) / dt : 0;
    this.lastSpeed = moving;
    const ease = 1 - Math.exp(-dt * LEAN_RESPONSE);
    this.accelerationFelt += (accel - this.accelerationFelt) * ease;
    this.acceleration += (this.accelerationFelt - this.acceleration) * ease;
    const lean = 1.5 + rb * (3 + 1.5 * Math.max(0, speed - PERSON.walkRunSpeed));
    const slopeLean = Math.atan(person.slope) / DEG * (person.slope > 0 ? 0.35 : 0.2);
    const accelLean = Math.min(8, Math.max(-5, this.acceleration * 2.5));
    ch[CH.spineFlex] = ch[CH.spineFlex]! + (lean + slopeLean + accelLean) * Math.min(1, amplitude + 0.3);
    // The turn: the body's facing follows the root's as a critically damped spring does (`TURN_RESPONSE`), over
    // this frame's steady turn of the root exactly (whatever the frame's length): about the lag that turn
    // holds it at, the spring's own motion dies away.
    const held = (-2 * input.turnRate) / TURN_RESPONSE;
    const off = this.turnLag - held;
    const closing = this.turnLagRate - input.turnRate + TURN_RESPONSE * off;
    const decay = Math.exp(-TURN_RESPONSE * dt);
    this.turnLag = held + (off + closing * dt) * decay;
    this.turnLagRate = input.turnRate + (this.turnLagRate - input.turnRate - closing * TURN_RESPONSE * dt) * decay;
    const turnLean = Math.atan((moving * this.turnLagRate) / GRAVITY);
    // (No more than a walker leans turning on the spot, more at a run; eased twice over, as the lean above.)
    const mostLean = Math.min(MAX_TURN_LEAN, TURN_LEAN_STANDING + TURN_LEAN_PER_SPEED * moving);
    const rollTarget = Math.min(mostLean, Math.max(-mostLean, turnLean));
    const rollEase = 1 - Math.exp(-dt * TURN_LEAN_RESPONSE);
    this.rollFelt += (rollTarget - this.rollFelt) * rollEase;
    this.roll += (this.rollFelt - this.roll) * rollEase;
    // Standing still: at ease on one leg, breathing.
    this.atEase += (1 - amplitude - this.atEase) * (1 - Math.exp(-dt * EASE_RESPONSE));
    this.sway = this.actions.idle(this.time, this.atEase, ch);
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
    if (this.swapFade < 1) {
      this.swapFade = Math.min(1, this.swapFade + dt / STRIDE_SWAP_FADE);
      const share = smooth01(this.swapFade);
      for (let i = 0; i < ch.length; i += 1) ch[i] = this.swapCh[i]! + (ch[i]! - this.swapCh[i]!) * share;
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
    const style = diving ? 0 : (BREAST_INCLINE + 0.04 * breath) * (1 - this.crawlBlend) + CRAWL_INCLINE * this.crawlBlend;
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
        // (No further than the arm reaches, straightening toward a grip beyond it without a snap.)
        const out = softReach(d - palm, ARM_LENGTH) / d;
        const wx = sx + (gx - sx) * out;
        const wy = sy + (gy - sy) * out;
        const wz = sz + (gz - sz) * out;
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

function boneLength(a: number, b: number): number {
  return Math.hypot(
    BIND_POSITIONS[a * 3]! - BIND_POSITIONS[b * 3]!,
    BIND_POSITIONS[a * 3 + 1]! - BIND_POSITIONS[b * 3 + 1]!,
    BIND_POSITIONS[a * 3 + 2]! - BIND_POSITIONS[b * 3 + 2]!,
  );
}

/**
 * How far along the way to a target `distance` off a limb of `length`
 * reaches: all the way to one well within it; past `SOFT_REACH_FROM` of its
 * length it straightens only asymptotically, so a target moving out of reach
 * (a door swinging away, a handle not yet come up to) draws the limb out
 * smoothly instead of locking it straight in one frame.
 */
function softReach(distance: number, length: number): number {
  const from = length * SOFT_REACH_FROM;
  if (distance <= from) return distance;
  const room = length * (0.998 - SOFT_REACH_FROM);
  return from + room * (1 - Math.exp(-(distance - from) / room));
}
