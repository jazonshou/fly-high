import {
  PERSON_SURFACE_COLLIDER_BASE,
  PERSON_SURFACE_WATER,
  type PersonControlState,
  type PersonMode,
  type PersonVisualState,
} from "@/src/game/types";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { PERSON } from "@/src/vehicles/person";
import { createColliderSweepHit, type ColliderSweepHit } from "../colliders";
import { DeckGround } from "../ground/deckGround";
import { createCarSurface, SurfaceCache } from "../ground/surface";
import { createGroundPoint, TerrainLatticeCache, type GroundField, type GroundPoint } from "../ground/terrainPatch";
import { TAU } from "../math";
import {
  NEUTRAL_PERSON_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSnapshot,
} from "../surface/types";
import type { Vec3 } from "../types";
import type { VehiclePoseState } from "../vehicle";
import {
  createWaterSurfaceSample,
  type HullWaterSampler,
  type WaterBedPoint,
  type WaveFieldFocus,
} from "../water/types";
import type { PersonSimulator, PersonSpawn } from "./types";
import {
  COLLIDER_SLOPE_LIMIT_DEGREES,
  LandingKind,
  RUN_SLOPE_SOFTENING,
  WADE_DEPTHS,
  WADE_RUN_FACTOR,
  WADE_SPEEDS,
  WALK_SLOPE_LIMIT_TAN,
} from "./walkerLaws";

const H = PERSON.stature;
const R = PERSON.capsuleRadius;
const EYE = PERSON.eyeHeight;
const STEP_UP = PERSON.stepUp;
const SNAP_DOWN = PERSON.snapDown;

/**
 * The capsule as four spheres of its radius, centres above the feet: the
 * foot (its bottom at the feet), the step sphere (its bottom at the step
 * height, so a lower ledge passes under it and is stepped onto), the waist
 * and the head (its top at the stature). Neighbours are 0.38 m apart, so the
 * union is never thinner than 0.23 m of the 0.3 m radius.
 */
const BODY = Float64Array.of(R, STEP_UP + R, (STEP_UP + H) / 2, H - R);
const FOOT_SPHERE = 0;
const STEP_SPHERE = 1;
/** A swimmer's spheres: one at the eye, one at the chest this far back along the body. */
const CHEST_BACK = 0.5;

/** Moves stop this far short of a collider, so the next sweep starts clear of it, m. */
const SKIN = 0.01;
/** Collide-and-slide passes per move. */
const PASSES = 4;
/**
 * A collider touch steeper than 45 degrees (normal y) is no floor. Edges
 * count, as steps: walking off one, the foot sphere rolls round it until
 * then, 0.09 m down.
 */
const FLOOR_MIN_NORMAL_Y = Math.SQRT1_2;
const COLLIDER_LIMIT_TAN = Math.tan((COLLIDER_SLOPE_LIMIT_DEGREES * Math.PI) / 180);
const GRASS_LIMIT_TAN = WALK_SLOPE_LIMIT_TAN[SurfaceMaterial.Grass]!;
/** A contact this close under the probe's centre is on a face (its slope counts), not an edge, m^2. */
const FACE_OFFSET_SQUARED = 0.02 * 0.02;

/** Toward a faster target and toward a slower one, m/s^2: about one stride to walking speed. */
const GROUND_ACCELERATION = 8;
const GROUND_DECELERATION = 12;
const AIR_ACCELERATION = PERSON.airControl * GROUND_ACCELERATION;
/** Stick deflection under this is no input; any input asks at least `MIN_SPEED`. */
const STICK_DEADZONE = 0.05;
const MIN_SPEED = 0.3;
/** Waders are carried by this share of the current at chest depth, less shallower (ESTIMATE). */
const WADE_DRIFT = 0.3;
/** No jumping out of water deeper than this share of the stature. */
const WADE_JUMP_LIMIT = 0.5;

const SWIM_ACCELERATION = 2;
const SWIM_DECELERATION = 1.5;
/** Water's quadratic drag on a fast plunge, per metre: a 1 m drop stops about 1.5 m down. */
const PLUNGE_DRAG = 1.5;
/** A surface swimmer's eye rides this far above the local wave height (`headDepth` -0.05). */
const SURFACE_EYE_ABOVE = 0.05;
/** How stiffly the float follows the waves, 1/s, and its fastest correction, m/s. */
const FLOAT_RATE = 4;
const FLOAT_MAX_SPEED = 2;
/** Swimming starts deeper than the plan's 0.75 H and stops shallower than this, so waves cannot flicker it. */
const SWIM_LEAVE = 0.7;
/** The eye this deep is under water (diving); rising above `SURFACE_HEAD_DEPTH` it is back at the surface. */
const UNDER_HEAD_DEPTH = 0.3;
const SURFACE_HEAD_DEPTH = 0.1;
/** Body pitch: treading water, swimming at the surface, crawling; how fast it changes, rad/s. */
const TREAD_PITCH = 1.25;
const STROKE_PITCH = 0.2;
const CRAWL_PITCH = 0.05;
const IDLE_UNDER_PITCH = 0.6;
const PITCH_RATE = 2.5;

/** A mantle looks for a ledge at these distances ahead of the head, m. */
const MANTLE_PROBES = Float64Array.of(0.35, PERSON.mantleReach);
/** A ledge just awash (the slipway's edge) counts this far under the surface, m. */
const MANTLE_AWASH = 0.3;
/** Waders mantle from this deep (share of the stature); shallower they step. */
const MANTLE_WADE_DEPTH = 0.4;

/** The terrain round a placed walker must answer this far out before it stands, m. */
const GROUND_READY_RADIUS = 4;
/** The safe spot moves on after this far of safe standing, m. */
const SAFE_SPACING = 0.5;
/** On a deck this far above the water, it is asked one step in `HIGH_WATER_STEPS`. */
const HIGH_ABOVE_WATER = 1;
const HIGH_WATER_STEPS = 16;
/** Water shallower than this over the feet is dry for footsteps, m. */
const WET_FEET = 0.02;

// What moves the walker this step.
const Regime = Object.freeze({ ground: 0, air: 1, swim: 2, dive: 3, mantle: 4 });

export interface WalkerOptions {
  /** Read the ground from this field rather than the worker's terrain through the lattice cache (tests, probes). */
  ground?: GroundField;
  /** The `SurfaceMaterial` under a terrain point, rather than the world's classifier (tests, probes). */
  surface?: (at: Readonly<GroundPoint>) => number;
}

/**
 * The walker's physics (the walking plan, "Controller and physics"): a
 * kinematic capsule, 0.3 m radius and 1.76 m tall, moved by collide-and-slide
 * against the world's colliders and the near solids, on the terrain the
 * clipmap draws, and in the water the boat and the car float and wade in.
 *
 * GROUND. The terrain is the car's: the authority's 2 m lattice through the
 * same Catmull-Rom (`TerrainLatticeCache`), with the marina apron's front
 * held level (`DeckGround.hullGround`). Collider tops are ground too (decks,
 * pontoons, floors, stairs, the parked car's roof): a sphere of the
 * capsule's radius swept down under the feet finds them, so a stair's nose
 * rounds the step. Moving horizontally the capsule is the three spheres from
 * the step sphere up, so a ledge up to `stepUp` passes under it and is then
 * stood on; walking, the feet follow drops up to `snapDown`, airborne they
 * do not. A moving collider under the feet (a pontoon on the sea twin)
 * carries the walker at its surface velocity.
 *
 * SPEED. Walk 1.4 m/s, run 4.5, a stick anything between (never under 0.3),
 * times Tobler's slope factor (running's softened, `walkerLaws.ts`), capped
 * in water by the wading curve. The facing turns toward the move at 540
 * deg/s walking and 270 running. Ground steeper than its material's limit
 * cannot be climbed and slides down.
 *
 * JUMPS AND LANDINGS. A press on the ground takes off at 2.97 m/s (0.45 m),
 * with a fifth of the ground's control in the air and no second jump.
 * Landings never hurt (D5): from 5 m/s a 0.4 s crouch, from 8 m/s a 1.1 s
 * roll, neither of which can move. The newest spot stood on safely, dry and
 * on level enough ground, is where `recover` returns.
 *
 * WATER. Deeper than 0.15 H the walker wades, slower the deeper; deeper than
 * 0.75 H it swims, the eye just above the local wave height, carried by the
 * current, 0.8 m/s or 1.3 crawling. A ledge no higher than 0.6 m over the
 * water within 0.7 m ahead (a pontoon's edge, a step of the shore) is climbed
 * by a mantle. Dive (held) takes it under, where it swims where the camera
 * points (the move's forward part pitched by `lookPitch`), 0.9 or 1.4 m/s,
 * rises with Rise, and with no input drifts up at 0.1 m/s; it meets the bed
 * and every collider on the way. While swimming the feet point is the eye
 * less the eye height (the figure lays the body back from the eye by
 * `swimPitch`).
 *
 * `step` allocates nothing (the water authority's `sample` and the lattice's
 * node reads take numbers, which V8 boxes where it does not inline them) and
 * reads the colliders through `sweepSphere` and `raycast` alone. To keep it
 * so whatever V8 inlines, its helpers take and return no fractional numbers
 * (they pass them in fields), the laws it shares with walkerLaws.ts are
 * evaluated in place (the tests hold the two together), and the rare turns
 * (a jump, a landing, a plunge, a mantle) are written into the bodies of the
 * hot functions, so they are optimised with them.
 */
export class Walker implements PersonSimulator {
  readonly state: VehiclePoseState;
  private controls: PersonControlState = NEUTRAL_PERSON_CONTROLS;
  private environment: SurfaceVehicleEnvironment | null = null;
  private focusable: HullWaterSampler | null = null;
  private readonly lattice = new TerrainLatticeCache(() => 0);
  private readonly decks: DeckGround;
  private readonly fixedGround: GroundField | null;
  private readonly fixedSurface: ((at: Readonly<GroundPoint>) => number) | null;
  private readonly surfaceCache = new SurfaceCache();
  private readonly carSurface = createCarSurface();
  private material: number = SurfaceMaterial.Grass;

  private regime: number = Regime.ground;
  private modeValue: PersonMode = "stand";
  private heading = -0;
  /** Gravity from the environment, m/s^2. */
  private g = 9.80665;
  /** Velocity over what carries the walker: the floor on the ground, the water swimming, the world in the air. */
  private readonly own: Vec3 = { x: -0, y: -0, z: -0 };
  /** The floor's surface velocity (a moving pontoon), or the water's current while swimming. */
  private readonly carry: Vec3 = { x: -0, y: -0, z: -0 };
  private placePending = true;

  // This step's input.
  private inputX = -0;
  private inputZ = -0;
  /** Stick or keys, 0 (none) .. 1. */
  private input = -0;
  private running = false;
  private jumpPressed = false;
  private jumpKnown = false;
  private lastJumpPresses = 0;

  // The floor the last probe found.
  private floorHeight = -0;
  private floorDhdx = -0;
  private floorDhdz = -0;
  private floorLimitTan = GRASS_LIMIT_TAN;
  private floorOnCollider = false;
  /** Something under the probe stands higher than its top: a rise past the step. */
  private floorTooHigh = false;
  private floorSurface: number = SurfaceMaterial.Grass;
  private readonly floorVelocity: Vec3 = { x: -0, y: -0, z: -0 };
  private sliding = false;
  // The probe's column and range.
  private probeX = -0;
  private probeZ = -0;
  private probeTop = -0;
  private probeBottom = -0;

  // Where this step's move started; the turn asked for (`turnTo`); the wader's speed cap (`wadingCap`).
  private startX = -0;
  private startZ = -0;
  private wantedHeading = -0;
  private turnRate = -0;
  private speedCap = -0;

  // A move in progress (`slide`): what is left of it, the body's spheres, and what it hit.
  private moveX = -0;
  private moveY = -0;
  private moveZ = -0;
  private readonly offsets = new Float64Array(12);
  private sphereFirst = 0;
  private sphereCount = 0;
  private horizontalSlide = true;
  private clipTarget: Vec3;
  private blocked = false;
  private ceiling = false;
  private readonly wall: Vec3 = { x: -0, y: -0, z: -0 };

  // Landing.
  private impactY = -0;
  private landingSpeed = -0;
  private landingAge = Infinity;
  private lockTime = -0;
  private lockKind: number = LandingKind.normal;

  // Water.
  private readonly water = createWaterSurfaceSample();
  private waterDepth = -0;
  private headDepth = -H;
  private submersion = -0;
  private swimPitch = -0;
  private surfacing = false;
  private lastWaterHeight = -Infinity;
  private waterSkip = 0;

  // Mantle.
  private readonly mantleFrom: Vec3 = { x: -0, y: -0, z: -0 };
  private readonly mantleTo: Vec3 = { x: -0, y: -0, z: -0 };
  private mantleTime = -0;
  private mantlePitch = -0;

  // Safe spot.
  private readonly safe: Vec3;
  private safeHeading = -0;

  private slope = -0;
  private surface: number = SurfaceMaterial.Grass;

  // Scratch.
  private readonly point: GroundPoint = createGroundPoint();
  private readonly bed: WaterBedPoint = { x: -0, z: -0, height: -0 };
  private readonly focus: WaveFieldFocus = { x: -0, z: -0, heading: -0, halfLength: 0.9, halfBeam: 0.3 };
  private readonly from: Vec3 = { x: -0, y: -0, z: -0 };
  private readonly to: Vec3 = { x: -0, y: -0, z: -0 };
  private readonly hit: ColliderSweepHit = createColliderSweepHit();
  private readonly nearHit: ColliderSweepHit = createColliderSweepHit();

  constructor(spawn: PersonSpawn, options: WalkerOptions = {}) {
    this.fixedGround = options.ground ?? null;
    this.fixedSurface = options.surface ?? null;
    this.decks = new DeckGround(this.lattice);
    this.safe = { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z };
    this.state = {
      time: 0,
      position: { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      crashed: false,
    };
    this.clipTarget = this.own;
    this.heading = spawn.heading;
    this.applyHeading();
    this.safeHeading = this.heading;
  }

  private get ground(): GroundField {
    return this.fixedGround ?? this.decks.hullGround;
  }

  /** What the walker is doing (the payload's `mode`), for tests and the session. */
  get mode(): PersonMode {
    return this.modeValue;
  }

  /** Standing on something (the payload's `grounded`), for the session's boarding check. */
  get grounded(): boolean {
    return this.regime === Regime.ground;
  }

  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    this.controls = controls.person ?? NEUTRAL_PERSON_CONTROLS;
  }

  setEnvironment(environment: Readonly<SurfaceVehicleEnvironment>): void {
    this.environment = environment;
    this.g = environment.gravity > 0 ? environment.gravity : 9.80665;
    this.lattice.setSampler(environment.bedHeight);
    this.decks.setWorld(environment.world ?? null);
    const water = environment.water as Partial<HullWaterSampler>;
    this.focusable = typeof water.setFocus === "function" ? (environment.water as HullWaterSampler) : null;
  }

  placeAt(position: Readonly<Vec3>, heading: number): void {
    const state = this.state;
    state.position.x = position.x;
    state.position.y = position.y;
    state.position.z = position.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.angularVelocity.y = 0;
    this.own.x = 0;
    this.own.y = 0;
    this.own.z = 0;
    this.carry.x = 0;
    this.carry.y = 0;
    this.carry.z = 0;
    this.heading = heading;
    this.applyHeading();
    this.regime = Regime.ground;
    this.modeValue = "stand";
    this.placePending = true;
    this.lockTime = 0;
    this.landingAge = Infinity;
    this.swimPitch = 0;
    this.surfacing = false;
    this.sliding = false;
    this.safe.x = position.x;
    this.safe.y = position.y;
    this.safe.z = position.z;
    this.safeHeading = this.heading;
  }

  recover(): void {
    this.placeAt(this.safe, this.safeHeading);
  }

  step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const state = this.state;
    state.time += dt;
    const environment = this.environment;
    if (!environment) return;
    this.landingAge += dt;
    this.lattice.setTime(state.time);
    if (environment.world && !this.fixedSurface) this.surfaceCache.beginStep(environment.world, environment.dayOfYear);
    const position = state.position;
    if (this.placePending) {
      if (environment.groundReady && !environment.groundReady(position.x, position.z, GROUND_READY_RADIUS)) {
        state.velocity.x = 0;
        state.velocity.y = 0;
        state.velocity.z = 0;
        return;
      }
      this.settle();
    }
    this.readControls();
    if (this.regime === Regime.mantle) {
      // Climbing out: up first, then over, the height eased in over the first
      // 60% of the mantle and the reach over the last 70%.
      this.mantleTime += dt;
      const t = Math.min(1, this.mantleTime / PERSON.mantleSeconds);
      const up = Math.min(1, t / 0.6);
      const over = Math.max(0, (t - 0.3) / 0.7);
      const rise = up * up * (3 - 2 * up);
      const reach = over * over * (3 - 2 * over);
      const from = this.mantleFrom;
      const to = this.mantleTo;
      const x = from.x + (to.x - from.x) * reach;
      const y = from.y + (to.y - from.y) * rise;
      const z = from.z + (to.z - from.z) * reach;
      state.velocity.x = (x - position.x) / dt;
      state.velocity.y = (y - position.y) / dt;
      state.velocity.z = (z - position.z) / dt;
      position.x = x;
      position.y = y;
      position.z = z;
      state.angularVelocity.y = 0;
      this.swimPitch = this.mantlePitch + (Math.PI / 2 - this.mantlePitch) * rise;
      if (t >= 1) {
        // On the ledge: standing.
        this.probeX = x;
        this.probeZ = z;
        this.probeTop = y + STEP_UP;
        this.probeBottom = y - SNAP_DOWN;
        this.findFloor();
        position.y = this.floorHeight;
        state.velocity.x = 0;
        state.velocity.y = 0;
        state.velocity.z = 0;
        this.swimPitch = 0;
        this.carry.x = this.floorVelocity.x;
        this.carry.y = this.floorVelocity.y;
        this.carry.z = this.floorVelocity.z;
        this.regime = Regime.ground;
        this.sampleWater();
      }
    } else {
      this.sampleWater();
      if (this.regime === Regime.ground) this.stepGround(dt);
      else if (this.regime === Regime.air) this.stepAir(dt);
      else this.stepSwim(dt);
    }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      this.recover();
      return;
    }
    this.finishStep();
  }

  snapshot(): SurfaceVehicleSnapshot {
    const state = this.state;
    const own = this.own;
    const speed = this.regime === Regime.air
      ? Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z)
      : Math.sqrt(own.x * own.x + own.z * own.z);
    const payload: PersonVisualState = {
      kind: "person",
      mode: this.modeValue,
      speed,
      running: this.running,
      grounded: this.regime === Regime.ground,
      slope: this.regime === Regime.ground ? this.slope : 0,
      waterDepth: this.waterDepth,
      submersion: this.submersion,
      headDepth: this.headDepth,
      swimPitch: this.swimPitch,
      landingSpeed: this.landingSpeed,
      landingAge: Math.min(this.landingAge, 60),
      surface: this.surface,
      boarding: null,
    };
    return {
      time: state.time,
      position: { ...state.position },
      velocity: { ...state.velocity },
      orientation: { ...state.orientation },
      angularVelocity: { ...state.angularVelocity },
      throttle: 0,
      engineRpm: 0,
      onGround: this.regime === Regime.ground,
      crashed: false,
      payload,
    };
  }

  /** After `placeAt`: stand on the floor under the point, or swim if it is in deep water. */
  private settle(): void {
    const position = this.state.position;
    this.probeX = position.x;
    this.probeZ = position.z;
    this.probeTop = position.y + 1;
    this.probeBottom = position.y - 50;
    this.findFloor();
    position.y = this.floorHeight;
    this.carry.x = 0;
    this.carry.y = 0;
    this.carry.z = 0;
    this.placePending = false;
  }

  private readControls(): void {
    const controls = this.controls;
    let x = Number.isFinite(controls.moveX) ? controls.moveX : 0;
    let z = Number.isFinite(controls.moveZ) ? controls.moveZ : 0;
    let magnitude = Math.sqrt(x * x + z * z);
    if (magnitude > 1) {
      x /= magnitude;
      z /= magnitude;
      magnitude = 1;
    }
    if (magnitude < STICK_DEADZONE) {
      this.input = 0;
      this.inputX = 0;
      this.inputZ = 0;
    } else {
      this.input = magnitude;
      this.inputX = x / magnitude;
      this.inputZ = z / magnitude;
    }
    this.running = controls.run && this.input > 0;
    const presses = controls.jumpPresses;
    this.jumpPressed = this.jumpKnown && presses !== this.lastJumpPresses;
    this.jumpKnown = true;
    this.lastJumpPresses = presses;
  }

  // GROUND -------------------------------------------------------------------

  private stepGround(dt: number): void {
    const state = this.state;
    const position = state.position;
    const own = this.own;
    const carry = this.carry;
    const locked = this.lockTime > 0;
    if (locked) this.lockTime -= dt;
    const depthFraction = this.waterDepth / H;

    if (this.jumpPressed && !locked && !this.sliding && depthFraction < WADE_JUMP_LIMIT) {
      // Up at `personJumpSpeed`, with the floor's velocity.
      const velocity = state.velocity;
      velocity.x = own.x + carry.x;
      velocity.y = carry.y + Math.sqrt(2 * this.g * PERSON.jumpHeight);
      velocity.z = own.z + carry.z;
      carry.x = 0;
      carry.y = 0;
      carry.z = 0;
      this.regime = Regime.air;
      this.stepAir(dt);
      return;
    }

    // The target velocity over the floor: `slopeSpeedFactor` on the move's
    // slope, no faster than `wadingSpeedCap`.
    let speed = 0;
    if (!locked && this.input > 0) {
      const running = this.running;
      const slope = this.floorDhdx * this.inputX + this.floorDhdz * this.inputZ;
      speed = Math.max(MIN_SPEED, this.input * (running ? PERSON.runSpeed : PERSON.walkSpeed));
      speed *= Math.exp(-3.5 * (running ? RUN_SLOPE_SOFTENING : 1) * (Math.abs(slope + 0.05) - 0.05));
      this.wadingCap();
      if (speed > this.speedCap) speed = this.speedCap;
    }
    let targetX = this.inputX * speed;
    let targetZ = this.inputZ * speed;
    if (depthFraction > PERSON.wadeDepthFraction) {
      // The current carries a wader a little, more the deeper.
      const share = WADE_DRIFT * Math.min(1, (depthFraction - PERSON.wadeDepthFraction) / (0.72 - PERSON.wadeDepthFraction));
      targetX += this.water.velocity.x * share;
      targetZ += this.water.velocity.z * share;
    }
    const grade = Math.sqrt(this.floorDhdx * this.floorDhdx + this.floorDhdz * this.floorDhdz);
    this.sliding = grade > this.floorLimitTan;
    if (this.sliding) {
      // Too steep: down the fall line it slides, the limit its friction
      // angle, and nothing the walker does there climbs or brakes; across
      // it, a fifth of the ground's control steers.
      const uphillX = this.floorDhdx / grade;
      const uphillZ = this.floorDhdz / grade;
      const slide = (this.g * (grade - this.floorLimitTan)) / Math.sqrt(1 + grade * grade);
      let along = own.x * uphillX + own.z * uphillZ - slide * dt;
      const targetAlong = targetX * uphillX + targetZ * uphillZ;
      const rate = PERSON.airControl * GROUND_ACCELERATION * dt;
      if (targetAlong < along) along = Math.max(targetAlong, along - rate);
      const across = own.x * uphillZ - own.z * uphillX;
      const targetAcross = targetX * uphillZ - targetZ * uphillX;
      const next = across + Math.max(-rate, Math.min(rate, targetAcross - across));
      own.x = along * uphillX + next * uphillZ;
      own.z = along * uphillZ - next * uphillX;
    } else {
      const target = Math.sqrt(targetX * targetX + targetZ * targetZ);
      const current = Math.sqrt(own.x * own.x + own.z * own.z);
      const rate = (target >= current ? GROUND_ACCELERATION : GROUND_DECELERATION) * dt;
      const dx = targetX - own.x;
      const dz = targetZ - own.z;
      const gap = Math.sqrt(dx * dx + dz * dz);
      if (gap <= rate) {
        own.x = targetX;
        own.z = targetZ;
      } else {
        own.x += (dx / gap) * rate;
        own.z += (dz / gap) * rate;
      }
    }
    own.y = 0;
    if (!locked && this.input > 0) {
      this.turnRate = this.running ? PERSON.turnRateRun : PERSON.turnRateWalk;
      this.wantedHeading = Math.atan2(this.inputX, this.inputZ);
      this.turnTo(dt);
    } else {
      state.angularVelocity.y = 0;
    }

    // Across, with the floor's own motion, then down onto the floor.
    const startY = position.y;
    this.startX = position.x;
    this.startZ = position.z;
    this.moveX = (own.x + carry.x) * dt;
    this.moveY = 0;
    this.moveZ = (own.z + carry.z) * dt;
    this.bodySpheres(STEP_SPHERE);
    this.horizontalSlide = true;
    this.clipTarget = own;
    this.slide();
    const lift = carry.y * dt;
    this.probeX = position.x;
    this.probeZ = position.z;
    this.probeTop = startY + lift + STEP_UP;
    this.probeBottom = startY + lift - SNAP_DOWN;
    let standing = this.findFloor();
    // A rise past the step (the shore's cut, a wall's foot) stops the walker, as does one the head would hit.
    let blocked = !standing && this.floorTooHigh;
    if (standing && this.floorHeight > startY + 0.01) {
      const top = BODY[BODY.length - 1]!;
      this.from.x = position.x;
      this.from.y = startY + top;
      this.from.z = position.z;
      this.to.x = position.x;
      this.to.y = this.floorHeight + top;
      this.to.z = position.z;
      blocked = this.sweepWorlds();
    }
    if (blocked) {
      // Back to where the move started, the velocity's push along the move gone.
      const dx = position.x - this.startX;
      const dz = position.z - this.startZ;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length > 1e-9) {
        const into = (own.x * dx + own.z * dz) / length;
        if (into > 0) {
          own.x -= (into * dx) / length;
          own.z -= (into * dz) / length;
        }
      }
      position.x = this.startX;
      position.z = this.startZ;
      this.probeX = position.x;
      this.probeZ = position.z;
      standing = this.findFloor();
    }
    if (!standing) {
      // Off a ledge: falling, with the floor's velocity.
      own.x += carry.x;
      own.y = carry.y;
      own.z += carry.z;
      state.velocity.x = own.x;
      state.velocity.y = own.y;
      state.velocity.z = own.z;
      carry.x = 0;
      carry.y = 0;
      carry.z = 0;
      this.regime = Regime.air;
      return;
    }
    position.y = this.floorHeight;
    carry.x = this.floorVelocity.x;
    carry.y = this.floorVelocity.y;
    carry.z = this.floorVelocity.z;
    state.velocity.x = own.x + carry.x;
    state.velocity.y = (position.y - startY) / dt;
    state.velocity.z = own.z + carry.z;

    // Deeper water: wade into a swim, or mantle onto a ledge in reach.
    this.waterAt();
    if (this.water.kind !== "none" && this.waterDepth > PERSON.swimDepthFraction * H) {
      own.y = 0;
      carry.x = 0;
      carry.y = 0;
      carry.z = 0;
      this.surfacing = false;
      this.regime = Regime.swim;
    } else if (this.waterDepth > MANTLE_WADE_DEPTH * H && this.input > 0.3) {
      this.tryMantle();
    }
  }

  /** `wadingSpeedCap` at this step's depth and gait, into `speedCap`. */
  private wadingCap(): void {
    const depthFraction = this.waterDepth / H;
    if (!(depthFraction >= WADE_DEPTHS[0]!)) {
      this.speedCap = Infinity;
      return;
    }
    const last = WADE_DEPTHS.length - 1;
    let speed = WADE_SPEEDS[last]!;
    for (let i = 0; i < last; i += 1) {
      const d1 = WADE_DEPTHS[i + 1]!;
      if (depthFraction <= d1) {
        const d0 = WADE_DEPTHS[i]!;
        speed = WADE_SPEEDS[i]! + (WADE_SPEEDS[i + 1]! - WADE_SPEEDS[i]!) * ((depthFraction - d0) / (d1 - d0));
        break;
      }
    }
    this.speedCap = this.running ? Math.min(PERSON.runSpeed, speed * WADE_RUN_FACTOR) : speed;
  }

  // AIR ----------------------------------------------------------------------

  private stepAir(dt: number): void {
    const state = this.state;
    const position = state.position;
    const velocity = state.velocity;
    velocity.y -= this.g * dt;
    if (this.input > 0) {
      // A fifth of the ground's pull toward the asked velocity; none without input.
      const speed = this.input * (this.running ? PERSON.runSpeed : PERSON.walkSpeed);
      const dx = this.inputX * speed - velocity.x;
      const dz = this.inputZ * speed - velocity.z;
      const gap = Math.sqrt(dx * dx + dz * dz);
      const rate = AIR_ACCELERATION * dt;
      if (gap <= rate) {
        velocity.x += dx;
        velocity.z += dz;
      } else {
        velocity.x += (dx / gap) * rate;
        velocity.z += (dz / gap) * rate;
      }
      this.turnRate = PERSON.turnRateWalk;
      this.wantedHeading = Math.atan2(this.inputX, this.inputZ);
      this.turnTo(dt);
    } else {
      state.angularVelocity.y = 0;
    }
    this.moveX = velocity.x * dt;
    this.moveY = velocity.y * dt;
    this.moveZ = velocity.z * dt;
    // The fall's speed before a deck it meets takes it away: the landing's.
    this.impactY = velocity.y;
    this.bodySpheres(FOOT_SPHERE);
    this.horizontalSlide = false;
    this.clipTarget = velocity;
    this.slide();
    if (this.ceiling && velocity.y > 0) velocity.y = 0;

    // The terrain, then a collider top under the feet.
    this.probeX = position.x;
    this.probeZ = position.z;
    this.probeTop = position.y + 0.03;
    this.probeBottom = position.y - 0.03;
    const onFloor = this.findFloor();
    this.waterAt();
    const own = this.own;
    const carry = this.carry;
    if (this.water.kind !== "none" && position.y < this.water.height
      && this.water.height - this.floorHeight > PERSON.swimDepthFraction * H) {
      // Into deep water: the plunge carries on under and the swimmer comes back up.
      own.x = velocity.x;
      own.y = velocity.y;
      own.z = velocity.z;
      carry.x = 0;
      carry.y = 0;
      carry.z = 0;
      this.landingSpeed = Math.max(0, -velocity.y);
      this.landingAge = 0;
      this.surfacing = true;
      this.regime = this.water.height - (position.y + EYE) > UNDER_HEAD_DEPTH ? Regime.dive : Regime.swim;
      return;
    }
    if (position.y > this.floorHeight && !(onFloor && velocity.y <= this.floorVelocity.y)) return;
    // Landed: at the speed it met the floor (`landingKind`), locked for a hard landing's crouch or a roll.
    const floor = this.floorVelocity;
    const speed = Math.max(0, floor.y - Math.min(velocity.y, this.impactY));
    this.landingSpeed = speed;
    this.landingAge = 0;
    if (speed >= PERSON.landingRollSpeed) {
      this.lockKind = LandingKind.roll;
      this.lockTime = PERSON.landingRollSeconds;
    } else if (speed >= PERSON.landingHardSpeed) {
      this.lockKind = LandingKind.hard;
      this.lockTime = PERSON.landingHardSeconds;
    } else {
      this.lockKind = LandingKind.normal;
      this.lockTime = 0;
    }
    position.y = this.floorHeight;
    own.x = velocity.x - floor.x;
    own.y = 0;
    own.z = velocity.z - floor.z;
    carry.x = floor.x;
    carry.y = floor.y;
    carry.z = floor.z;
    velocity.y = floor.y;
    this.regime = Regime.ground;
  }

  // WATER --------------------------------------------------------------------

  private stepSwim(dt: number): void {
    const state = this.state;
    const position = state.position;
    const own = this.own;
    const water = this.water;
    const controls = this.controls;
    if (water.kind === "none") {
      // The water went (a lake's region unloaded): fall onto whatever is under.
      state.velocity.x = own.x;
      state.velocity.y = own.y;
      state.velocity.z = own.z;
      this.regime = Regime.air;
      this.stepAir(dt);
      return;
    }
    const eyeY = position.y + EYE;
    const headDepth = water.height - eyeY;
    if (this.regime === Regime.swim && controls.dive) {
      this.regime = Regime.dive;
      this.surfacing = false;
    }
    const under = this.regime === Regime.dive;
    const fast = this.running;
    const speed = under
      ? (fast ? PERSON.diveFastSpeed : PERSON.diveSpeed)
      : (fast ? PERSON.swimFastSpeed : PERSON.swimSpeed);

    // The target velocity through the water.
    let targetX = -0;
    let targetY = -0;
    let targetZ = -0;
    let pitchTarget = -0;
    if (!under) {
      targetX = this.inputX * this.input * speed;
      targetZ = this.inputZ * this.input * speed;
      pitchTarget = this.input > 0 ? (fast ? CRAWL_PITCH : STROKE_PITCH) : TREAD_PITCH;
    } else {
      // Where the camera points: the move's forward part pitched by the look.
      const forwardX = Math.sin(controls.lookHeading);
      const forwardZ = Math.cos(controls.lookHeading);
      const moveX = this.inputX * this.input;
      const moveZ = this.inputZ * this.input;
      const ahead = moveX * forwardX + moveZ * forwardZ;
      const pitch = Number.isFinite(controls.lookPitch) ? controls.lookPitch : 0;
      const level = Math.cos(pitch);
      let dirX = moveX - ahead * forwardX + ahead * forwardX * level;
      let dirY = ahead * Math.sin(pitch);
      let dirZ = moveZ - ahead * forwardZ + ahead * forwardZ * level;
      if (controls.rise) dirY += 1;
      if (controls.dive) dirY -= 1;
      const length = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      if (length > 1) {
        dirX /= length;
        dirY /= length;
        dirZ /= length;
      }
      if (length > 1e-3) {
        targetX = dirX * speed;
        targetY = dirY * speed;
        targetZ = dirZ * speed;
        pitchTarget = Math.atan2(dirY, Math.sqrt(dirX * dirX + dirZ * dirZ));
        this.surfacing = false;
      } else {
        targetY = this.surfacing ? PERSON.diveSpeed : PERSON.buoyantRise;
        pitchTarget = IDLE_UNDER_PITCH;
      }
    }
    // Toward it, with the water's quadratic drag on a fast plunge.
    const dx = targetX - own.x;
    const dz = targetZ - own.z;
    const gap = Math.sqrt(dx * dx + dz * dz);
    const horizontalTarget = Math.sqrt(targetX * targetX + targetZ * targetZ);
    const horizontalNow = Math.sqrt(own.x * own.x + own.z * own.z);
    const rate = (horizontalTarget >= horizontalNow ? SWIM_ACCELERATION : SWIM_DECELERATION) * dt;
    if (gap <= rate) {
      own.x = targetX;
      own.z = targetZ;
    } else {
      own.x += (dx / gap) * rate;
      own.z += (dz / gap) * rate;
    }
    if (under || this.surfacing) {
      const dy = targetY - own.y;
      const pull = (SWIM_ACCELERATION + PLUNGE_DRAG * own.y * own.y) * dt;
      own.y += dy > pull ? pull : dy < -pull ? -pull : dy;
    } else {
      // Floating: the eye rides just over the wave, following its rise and fall.
      const correction = (water.height + SURFACE_EYE_ABOVE - eyeY) * FLOAT_RATE;
      own.y = water.velocity.y + Math.max(-FLOAT_MAX_SPEED, Math.min(FLOAT_MAX_SPEED, correction));
    }
    if ((this.input > 0 || under) && targetX * targetX + targetZ * targetZ >= 1e-6) {
      this.turnRate = PERSON.turnRateSwim;
      this.wantedHeading = Math.atan2(targetX, targetZ);
      this.turnTo(dt);
    } else {
      // No input, or straight up or down: no turn.
      state.angularVelocity.y = 0;
    }
    const most = PITCH_RATE * dt;
    const pitchChange = pitchTarget - this.swimPitch;
    this.swimPitch += pitchChange > most ? most : pitchChange < -most ? -most : pitchChange;

    // The current carries it (weaker deep down, where the waves' orbits fade).
    const carry = this.carry;
    const share = under ? Math.exp(-Math.max(0, headDepth) / 3) : 1;
    carry.x = water.velocity.x * share;
    carry.y = 0;
    carry.z = water.velocity.z * share;
    const startY = position.y;
    this.moveX = (own.x + carry.x) * dt;
    this.moveY = own.y * dt;
    this.moveZ = (own.z + carry.z) * dt;
    this.swimSpheres();
    this.horizontalSlide = false;
    this.clipTarget = own;
    this.slide();
    this.keepAboveBed();
    state.velocity.x = own.x + carry.x;
    state.velocity.y = (position.y - startY) / dt;
    state.velocity.z = own.z + carry.z;

    // Back to the surface, onto the bottom, or out onto a ledge.
    this.waterAt();
    const nowHead = water.height - (position.y + EYE);
    if (this.regime === Regime.dive && nowHead < SURFACE_HEAD_DEPTH && !controls.dive && own.y >= 0) {
      this.regime = Regime.swim;
      this.surfacing = false;
    } else if (this.regime === Regime.swim && this.surfacing && nowHead < SURFACE_HEAD_DEPTH) {
      this.surfacing = false;
    }
    this.probeX = position.x;
    this.probeZ = position.z;
    this.probeTop = position.y + EYE - 0.1;
    this.probeBottom = water.height - SWIM_LEAVE * H;
    if (nowHead < UNDER_HEAD_DEPTH * 2 && own.y <= 0.05 && this.findFloor()) {
      // The bottom is in reach: stand on it and wade.
      position.y = this.floorHeight;
      this.carry.x = this.floorVelocity.x;
      this.carry.y = this.floorVelocity.y;
      this.carry.z = this.floorVelocity.z;
      own.y = 0;
      this.swimPitch = 0;
      this.surfacing = false;
      this.regime = Regime.ground;
      this.waterAt();
      return;
    }
    if (this.regime === Regime.swim && this.input > 0.3 && nowHead < UNDER_HEAD_DEPTH) this.tryMantle();
  }

  /** The sea bed under the eye and the chest stays clear of the swimmer's spheres. */
  private keepAboveBed(): void {
    const position = this.state.position;
    const point = this.point;
    point.x = position.x;
    point.z = position.z;
    this.ground.evaluate(point);
    let raise = point.height + R - (position.y + EYE);
    const offsets = this.offsets;
    point.x = position.x + offsets[3]!;
    point.z = position.z + offsets[5]!;
    this.ground.evaluate(point);
    const chest = point.height + R - (position.y + offsets[4]!);
    if (chest > raise) raise = chest;
    if (raise > 0) {
      position.y += raise;
      if (this.own.y < 0) this.own.y = 0;
    }
  }

  /**
   * A ledge to climb out onto: within reach ahead, its top no higher than
   * `mantleHeight` over the water and no deeper than awash, level enough,
   * with nothing in the way and room to stand.
   */
  private tryMantle(): boolean {
    const position = this.state.position;
    const water = this.water;
    const forwardX = Math.sin(this.heading);
    const forwardZ = Math.cos(this.heading);
    if (this.inputX * forwardX + this.inputZ * forwardZ < 0.7) return false;
    const top = water.height + PERSON.mantleHeight;
    for (let i = 0; i < MANTLE_PROBES.length; i += 1) {
      const reach = MANTLE_PROBES[i]!;
      this.probeX = position.x + forwardX * reach;
      this.probeZ = position.z + forwardZ * reach;
      this.probeTop = top;
      this.probeBottom = water.height - MANTLE_AWASH;
      if (!this.findFloor()) continue;
      if (this.floorDhdx * this.floorDhdx + this.floorDhdz * this.floorDhdz > this.floorLimitTan * this.floorLimitTan) continue;
      if (water.height - this.floorHeight > PERSON.wadeDepthFraction * H) continue;
      if (this.floorHeight - position.y <= STEP_UP) continue;
      let ledge = this.floorHeight;
      let ledgeX = this.probeX;
      let ledgeZ = this.probeZ;
      // On an edge the foot sphere rounds it: a radius further in, the top itself.
      this.probeX = ledgeX + forwardX * R;
      this.probeZ = ledgeZ + forwardZ * R;
      this.probeTop = ledge + STEP_UP;
      this.probeBottom = ledge;
      if (this.findFloor()) {
        ledge = this.floorHeight;
        ledgeX = this.probeX;
        ledgeZ = this.probeZ;
      }
      // Nothing between the head and the ledge, at the height the body crosses it.
      this.from.x = position.x;
      this.from.y = Math.max(position.y + EYE, ledge + R + SKIN);
      this.from.z = position.z;
      this.to.x = ledgeX;
      this.to.y = this.from.y;
      this.to.z = ledgeZ;
      if (this.sweepWorlds()) continue;
      // Room to stand.
      this.from.x = ledgeX;
      this.from.y = ledge + R + SKIN;
      this.from.z = ledgeZ;
      this.to.x = ledgeX;
      this.to.y = ledge + H - R;
      this.to.z = ledgeZ;
      if (this.sweepWorlds()) continue;
      this.mantleFrom.x = position.x;
      this.mantleFrom.y = position.y;
      this.mantleFrom.z = position.z;
      this.mantleTo.x = ledgeX;
      this.mantleTo.y = ledge;
      this.mantleTo.z = ledgeZ;
      this.mantleTime = 0;
      this.mantlePitch = this.swimPitch;
      this.own.x = 0;
      this.own.y = 0;
      this.own.z = 0;
      this.carry.x = 0;
      this.carry.y = 0;
      this.carry.z = 0;
      this.surfacing = false;
      this.regime = Regime.mantle;
      return true;
    }
    if (this.regime === Regime.ground) {
      // The probes ahead wrote the floor fields: the floor under the feet again.
      this.probeX = position.x;
      this.probeZ = position.z;
      this.probeTop = position.y + STEP_UP;
      this.probeBottom = position.y - SNAP_DOWN;
      this.findFloor();
    }
    return false;
  }

  /**
   * The water at the feet: asked where it can be wet, and on a deck well
   * above it only one step in `HIGH_WATER_STEPS`. The focus goes to the sea
   * twin first, so its local expansion is round the walker.
   */
  private sampleWater(): void {
    const environment = this.environment!;
    const position = this.state.position;
    const water = this.water;
    const authority = environment.water;
    const bed = this.bed;
    if (authority.isDry) {
      const point = this.point;
      point.x = position.x;
      point.z = position.z;
      this.ground.evaluate(point);
      bed.x = position.x;
      bed.z = position.z;
      bed.height = point.height;
      if (authority.isDry(bed)) {
        water.kind = "none";
        this.waterSkip = 0;
        this.waterAt();
        return;
      }
    }
    if (this.regime === Regime.ground && position.y > this.lastWaterHeight + HIGH_ABOVE_WATER && this.waterSkip > 0) {
      this.waterSkip -= 1;
      this.waterAt();
      return;
    }
    const focusable = this.focusable;
    if (focusable) {
      const focus = this.focus;
      focus.x = position.x;
      focus.z = position.z;
      focus.heading = this.heading;
      focusable.setFocus(focus);
    }
    authority.sample(position.x, position.z, water);
    this.lastWaterHeight = water.kind === "none" ? -Infinity : water.height;
    this.waterSkip = HIGH_WATER_STEPS - 1;
    this.waterAt();
  }

  /** Depth over the feet, the head's depth and how much of the body is under, from this step's sample. */
  private waterAt(): void {
    const water = this.water;
    const feetY = this.state.position.y;
    if (water.kind === "none") {
      this.waterDepth = 0;
      this.headDepth = -H;
      this.submersion = 0;
      return;
    }
    this.waterDepth = Math.max(0, water.height - feetY);
    const eyeY = feetY + EYE;
    this.headDepth = water.height - eyeY;
    // The body from the eye back along the swim pitch (upright on foot), a
    // quarter metre thick: the share of it under the surface.
    const sine = this.regime === Regime.swim || this.regime === Regime.dive ? Math.sin(this.swimPitch) : 1;
    const footY = eyeY - EYE * sine;
    const crownY = eyeY + (H - EYE) * sine;
    const low = Math.min(footY, crownY) - 0.125;
    const high = Math.max(footY, crownY) + 0.125;
    this.submersion = Math.max(0, Math.min(1, (water.height - low) / (high - low)));
  }

  // MOVES --------------------------------------------------------------------

  /** The capsule's spheres from `first` up, centred over the feet. */
  private bodySpheres(first: number): void {
    const offsets = this.offsets;
    for (let i = 0; i < BODY.length; i += 1) {
      offsets[i * 3] = 0;
      offsets[i * 3 + 1] = BODY[i]!;
      offsets[i * 3 + 2] = 0;
    }
    this.sphereFirst = first;
    this.sphereCount = BODY.length;
  }

  /** A swimmer's spheres: at the eye, and at the chest back along the body's pitch. */
  private swimSpheres(): void {
    const offsets = this.offsets;
    const level = Math.cos(this.swimPitch);
    offsets[0] = 0;
    offsets[1] = EYE;
    offsets[2] = 0;
    offsets[3] = -Math.sin(this.heading) * level * CHEST_BACK;
    offsets[4] = EYE - Math.sin(this.swimPitch) * CHEST_BACK;
    offsets[5] = -Math.cos(this.heading) * level * CHEST_BACK;
    this.sphereFirst = 0;
    this.sphereCount = 2;
  }

  /**
   * Collide and slide: the move in `moveX/Y/Z` with the spheres in
   * `offsets`, up to `PASSES` times, each to the first touch less `SKIN`,
   * the rest slid along the surface touched (along walls only, upright, on
   * the ground). `clipTarget` loses its push into each surface.
   */
  private slide(): void {
    const position = this.state.position;
    const offsets = this.offsets;
    const clip = this.clipTarget;
    let dx = this.moveX;
    let dy = this.moveY;
    let dz = this.moveZ;
    this.blocked = false;
    this.ceiling = false;
    for (let pass = 0; pass < PASSES; pass += 1) {
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 1e-7) break;
      let best = 1;
      let found = false;
      for (let i = this.sphereFirst; i < this.sphereCount; i += 1) {
        this.from.x = position.x + offsets[i * 3]!;
        this.from.y = position.y + offsets[i * 3 + 1]!;
        this.from.z = position.z + offsets[i * 3 + 2]!;
        this.to.x = this.from.x + dx;
        this.to.y = this.from.y + dy;
        this.to.z = this.from.z + dz;
        if (this.sweepWorlds() && this.hit.fraction < best) {
          best = this.hit.fraction;
          this.wall.x = this.hit.normal.x;
          this.wall.y = this.hit.normal.y;
          this.wall.z = this.hit.normal.z;
          found = true;
        }
      }
      const advance = found ? Math.max(0, best - SKIN / length) : 1;
      position.x += dx * advance;
      position.y += dy * advance;
      position.z += dz * advance;
      if (!found) break;
      this.blocked = true;
      let nx = this.wall.x;
      let ny = this.wall.y;
      let nz = this.wall.z;
      if (ny < -0.5) this.ceiling = true;
      if (this.horizontalSlide) {
        const across = Math.sqrt(nx * nx + nz * nz);
        if (across < 1e-6) break;
        nx /= across;
        ny = 0;
        nz /= across;
      }
      const rest = 1 - advance;
      dx *= rest;
      dy *= rest;
      dz *= rest;
      const into = dx * nx + dy * ny + dz * nz;
      if (into < 0) {
        dx -= into * nx;
        dy -= into * ny;
        dz -= into * nz;
      }
      const push = clip.x * nx + clip.y * ny + clip.z * nz;
      if (push < 0) {
        clip.x -= push * nx;
        clip.y -= push * ny;
        clip.z -= push * nz;
      }
    }
  }

  /** The nearer first touch of a sphere of the capsule's radius from `from` to `to`, in the colliders and the near solids, into `hit`. */
  private sweepWorlds(): boolean {
    const environment = this.environment!;
    let found = false;
    const colliders = environment.colliders;
    if (colliders && colliders.sweepSphere(this.from, this.to, R, this.hit)) found = true;
    const near = environment.nearSolids;
    if (near && near.sweepSphere(this.from, this.to, R, this.nearHit)) {
      if (!found || this.nearHit.fraction < this.hit.fraction) copyHit(this.hit, this.nearHit);
      found = true;
    }
    return found;
  }

  /** The nearer first touch of the segment from `from` to `to` in the colliders and the near solids, into `hit`. */
  private raycastWorlds(): boolean {
    const environment = this.environment!;
    let found = false;
    const colliders = environment.colliders;
    if (colliders && colliders.raycast(this.from, this.to, this.hit)) found = true;
    const near = environment.nearSolids;
    if (near && near.raycast(this.from, this.to, this.nearHit)) {
      if (!found || this.nearHit.fraction < this.hit.fraction) copyHit(this.hit, this.nearHit);
      found = true;
    }
    return found;
  }

  /**
   * The floor in the column at (`probeX`, `probeZ`): the terrain, or a
   * collider top over it that a sphere of the capsule's radius swept down
   * from `probeTop` meets. Its height, slope, limit, surface and velocity go
   * into the floor fields; true when it lies between `probeBottom` and
   * `probeTop`.
   */
  private findFloor(): boolean {
    const point = this.point;
    point.x = this.probeX;
    point.z = this.probeZ;
    this.ground.evaluate(point);
    let height = point.height;
    let dhdx = point.dhdx;
    let dhdz = point.dhdz;
    let onCollider = false;
    let tooHigh = false;
    let material = 0;
    const floorVelocity = this.floorVelocity;
    floorVelocity.x = 0;
    floorVelocity.y = 0;
    floorVelocity.z = 0;
    const environment = this.environment!;
    const bottom = Math.max(this.probeBottom, height);
    if ((environment.colliders || environment.nearSolids) && this.probeTop > bottom) {
      this.from.x = this.probeX;
      this.from.y = this.probeTop + R;
      this.from.z = this.probeZ;
      this.to.x = this.probeX;
      this.to.y = bottom + R;
      this.to.z = this.probeZ;
      let accepted = false;
      if (this.sweepWorlds()) {
        const hit = this.hit;
        const normal = hit.normal;
        const feet = this.from.y + (this.to.y - this.from.y) * hit.fraction - R;
        const offsetX = hit.point.x - this.probeX;
        const offsetZ = hit.point.z - this.probeZ;
        const face = offsetX * offsetX + offsetZ * offsetZ < FACE_OFFSET_SQUARED;
        if (hit.point.y > this.probeTop + 1e-6) {
          // An edge above the step under the rim of the foot sphere: a wall to climb, not a floor.
          tooHigh = true;
        } else if (normal.y > FLOOR_MIN_NORMAL_Y && (!face || normal.y * COLLIDER_LIMIT_TAN >= Math.sqrt(1 - normal.y * normal.y))) {
          accepted = true;
          if (feet > height) {
            height = feet;
            onCollider = true;
            material = hit.material;
            // A face's own slope; an edge is a step, level under the foot.
            dhdx = face ? -normal.x / normal.y : 0;
            dhdz = face ? -normal.z / normal.y : 0;
            floorVelocity.x = hit.pointVelocity.x;
            floorVelocity.y = hit.pointVelocity.y;
            floorVelocity.z = hit.pointVelocity.z;
          }
        }
      }
      if (!accepted && !tooHigh) {
        // The foot sphere met a steep edge first (the next riser of a stair):
        // the face straight under the centre is the floor.
        this.from.y = this.probeTop;
        this.to.y = bottom;
        if (this.raycastWorlds()) {
          const hit = this.hit;
          const normal = hit.normal;
          if (normal.y > FLOOR_MIN_NORMAL_Y && normal.y * COLLIDER_LIMIT_TAN >= Math.sqrt(1 - normal.y * normal.y)
            && hit.point.y > height) {
            height = hit.point.y;
            onCollider = true;
            material = hit.material;
            dhdx = -normal.x / normal.y;
            dhdz = -normal.z / normal.y;
            floorVelocity.x = hit.pointVelocity.x;
            floorVelocity.y = hit.pointVelocity.y;
            floorVelocity.z = hit.pointVelocity.z;
          }
        }
      }
    }
    this.floorHeight = height;
    this.floorDhdx = dhdx;
    this.floorDhdz = dhdz;
    this.floorOnCollider = onCollider;
    this.floorTooHigh = tooHigh || height > this.probeTop;
    const inRange = !tooHigh && height >= this.probeBottom && height <= this.probeTop;
    if (onCollider) {
      this.floorLimitTan = COLLIDER_LIMIT_TAN;
      this.floorSurface = PERSON_SURFACE_COLLIDER_BASE + material;
    } else {
      if (inRange) this.lookUpMaterial();
      // `walkSlopeLimitTan`.
      const limit = WALK_SLOPE_LIMIT_TAN[this.material];
      this.floorLimitTan = limit === undefined ? GRASS_LIMIT_TAN : limit;
      this.floorSurface = this.material;
    }
    return inRange;
  }

  /** The terrain's material at the floor point (still in `point`), kept when this step's classifier budget is spent. */
  private lookUpMaterial(): void {
    const fixed = this.fixedSurface;
    if (fixed) {
      this.material = fixed(this.point);
      return;
    }
    const world = this.environment!.world;
    if (!world) {
      this.material = SurfaceMaterial.Grass;
      return;
    }
    if (this.surfaceCache.lookup(world, this.ground, this.point, this.carSurface)) this.material = this.carSurface.material;
  }

  // FACING -------------------------------------------------------------------

  /** Toward `wantedHeading` at `turnRate`. */
  private turnTo(dt: number): void {
    let delta = this.wantedHeading - this.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const most = this.turnRate * dt;
    const applied = delta > most ? most : delta < -most ? -most : delta;
    this.heading += applied;
    this.applyHeading();
    this.state.angularVelocity.y = applied / dt;
  }

  /** `heading` wrapped into [0, 2 pi), and the body turned to it (+X along it). */
  private applyHeading(): void {
    let heading = this.heading % TAU;
    if (heading < 0) heading += TAU;
    this.heading = heading;
    const half = (heading - Math.PI / 2) * 0.5;
    const orientation = this.state.orientation;
    orientation.x = 0;
    orientation.y = Math.sin(half);
    orientation.z = 0;
    orientation.w = Math.cos(half);
  }

  // PAYLOAD ------------------------------------------------------------------

  private finishStep(): void {
    const own = this.own;
    const regime = this.regime;
    const forwardX = Math.sin(this.heading);
    const forwardZ = Math.cos(this.heading);
    this.slope = regime === Regime.ground ? this.floorDhdx * forwardX + this.floorDhdz * forwardZ : 0;
    if (regime === Regime.ground) {
      this.surface = this.waterDepth > WET_FEET ? PERSON_SURFACE_WATER : this.floorSurface;
      const speed = Math.sqrt(own.x * own.x + own.z * own.z);
      if (this.lockTime > 0 && this.lockKind !== LandingKind.normal) this.modeValue = "land";
      else if (this.waterDepth > PERSON.wadeDepthFraction * H) this.modeValue = "wade";
      else if (speed > PERSON.walkRunSpeed) this.modeValue = "run";
      else if (speed > 0.1) this.modeValue = "walk";
      else this.modeValue = "stand";
      this.keepSafeSpot();
    } else if (regime === Regime.air) {
      this.surface = -1;
      this.modeValue = "air";
    } else {
      this.surface = PERSON_SURFACE_WATER;
      this.modeValue = regime === Regime.swim ? "swim" : regime === Regime.dive ? "dive" : "mantle";
    }
  }

  /** Dry, level enough, still and steady underfoot: the spot `recover` returns to. */
  private keepSafeSpot(): void {
    if (this.sliding || this.lockTime > 0 || this.waterDepth > WET_FEET) return;
    const carry = this.carry;
    if (carry.x * carry.x + carry.y * carry.y + carry.z * carry.z > 1e-6) return;
    const position = this.state.position;
    const dx = position.x - this.safe.x;
    const dy = position.y - this.safe.y;
    const dz = position.z - this.safe.z;
    if (dx * dx + dy * dy + dz * dz < SAFE_SPACING * SAFE_SPACING) return;
    this.safe.x = position.x;
    this.safe.y = position.y;
    this.safe.z = position.z;
    this.safeHeading = this.heading;
  }
}

function copyHit(out: ColliderSweepHit, from: Readonly<ColliderSweepHit>): void {
  out.handle = from.handle;
  out.fraction = from.fraction;
  out.normal.x = from.normal.x;
  out.normal.y = from.normal.y;
  out.normal.z = from.normal.z;
  out.point.x = from.point.x;
  out.point.y = from.point.y;
  out.point.z = from.point.z;
  out.pointVelocity.x = from.pointVelocity.x;
  out.pointVelocity.y = from.pointVelocity.y;
  out.pointVelocity.z = from.pointVelocity.z;
  out.material = from.material;
}
