import {
  CAR_WHEELS,
  type CarControlState,
  type CarHeadlights,
  type CarSetup,
  type CarTyrePressure,
  type CarVisualState,
} from "@/src/game/types";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { LANDCRUISER_76, type AxleSuspension } from "@/src/vehicles/landcruiser76";
import { createColliderContact, type ColliderAabb } from "../colliders";
import { clamp, inverseRotateVectorInto, quaternionFromFlightAngles, rotateVectorInto, wrapAngle } from "../math";
import { RigidBody } from "../rigidBody";
import {
  DEFAULT_CAR_SETUP,
  NEUTRAL_CAR_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
  type SurfaceVehicleSnapshot,
  type SurfaceVehicleSpawn,
} from "../surface/types";
import type { Quaternion, Vec3 } from "../types";
import type { VehiclePoseState } from "../vehicle";
import { createWaterSurfaceSample } from "../water/types";
import { DrivelineSolver, DRIVELINE_DOF, ENGINE } from "./drivelineSolver";
import { Engine, IDLE_OMEGA, RPM_PER_RAD_S } from "./engine";
import { roughnessProfile, type RoughnessPoint } from "./roughness";
import { createSoilContact, DIG_GAIN, DIG_SLIP, soilCurve, soilPatch } from "./soil";
import { CAR_COLLIDER_MATERIAL } from "./carColliders";
import { Steering } from "./steering";
import { createCarSurface, describeSurface, SurfaceCache, type CarSurface } from "./surface";
import { createGroundPoint, TerrainLatticeCache, type GroundField, type GroundPoint } from "./terrainPatch";
import {
  converterTorques,
  STOPPED_SPEED,
  Transmission,
  type ConverterState,
  type DriverPedals,
  type TransmissionMotion,
} from "./transmission";
import {
  combinedSlip,
  createCombinedSlipResult,
  createResolvedCurve,
  createTyreInput,
  resolveCurve,
  TYRE_V_N,
} from "./tyre";
import { createWheelContact, findWheelContact, groundNormal, type WheelContact } from "./wheelContact";

/**
 * The LandCruiser 76's physics (land plan P1): a small multibody system of
 * about 26 states, stepped at 480 Hz inside the worker's 120 Hz step.
 *
 * - The chassis is the sprung mass as a 6-DOF `RigidBody` (src/sim/rigidBody.ts)
 *   about its own centre of mass. The pose the seam exposes is the car's
 *   body origin, the CG at kerb weight with the axles included.
 * - Each solid axle has heave and roll against the frame. Tyre forces along
 *   the frame's vertical go to the axle; the rest go to the frame, the
 *   longitudinal at the contact patch and the lateral at the roll centre
 *   (Panhard rod front, leaf seats rear), whose moment rolls the axle. The
 *   axles' own inertia and weight in the frame's plane act on the frame at
 *   the axle, and the frame's acceleration acts back on the axles one
 *   substep late (their mass is a tenth of the frame's).
 * - Springs, digressive dampers, anti-roll bars, progressive bump stops and
 *   droop stops act between each axle and the frame; the link geometry's
 *   anti-dive and anti-squat are an internal force pair.
 * - The four wheels' spins and the engine speed are the driveline solver's
 *   (src/sim/ground/drivelineSolver.ts), with one windup state between the
 *   propeller shafts in 4H and 4L; each tyre has TMeasy's two deflection
 *   states (src/sim/ground/tyre.ts).
 * - Contact: each tyre's plane is found once per step from the local ground
 *   patch (src/sim/ground/wheelContact.ts); the hull's probe spheres meet the
 *   ground and the world's colliders.
 *
 * Nothing physical depends on the graphics tier. `step` does not allocate:
 * besides keeping to scratch objects, no number crosses a call in the hot
 * path (the step, substep and per-step sizes, the speed and the slope are
 * fields; the components take their inputs as fields or objects), because
 * V8 boxes a number passed to or returned from a call it does not inline.
 */

const CAR = LANDCRUISER_76;
const SUBSTEPS = 4;
const BODY_FORWARD: Vec3 = Object.freeze({ x: 1, y: 0, z: 0 });
const BODY_UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });
const TAU = Math.PI * 2;
const STANDARD_GRAVITY = 9.80665;
const AIR_DENSITY = 1.225;

const FRONT = CAR.suspension.front;
const REAR = CAR.suspension.rear;
const GEOMETRY = CAR.geometry;
const TYRE = CAR.tyre;
const CG_HEIGHT = CAR.mass.cgHeight;
const UNSPRUNG_MASS = FRONT.unsprungMass + REAR.unsprungMass;
const SPRUNG_MASS = CAR.mass.kerb - UNSPRUNG_MASS;
const WHEEL_CENTRE_Y = GEOMETRY.wheelCentreY;
const FREE_RADIUS = TYRE.freeRadius;
const HALF_TREAD = TYRE.treadWidth / 2;

/** The sprung mass's centre, from the car's body origin (the CG with the axles), body frame. */
export const SPRUNG_CM_OFFSET: Readonly<Vec3> = Object.freeze({
  x: -(FRONT.unsprungMass * GEOMETRY.frontAxleX + REAR.unsprungMass * GEOMETRY.rearAxleX) / SPRUNG_MASS,
  y: -(UNSPRUNG_MASS * WHEEL_CENTRE_Y) / SPRUNG_MASS,
  z: 0,
});

interface AxleSpec {
  readonly suspension: AxleSuspension;
  readonly x: number;
  readonly halfTrack: number;
  readonly halfSpringTrack: number;
  /** Roll centre above the axle centre, metres. */
  readonly pivotAbove: number;
  /** The sprung weight on each of this axle's springs at kerb ride, N. */
  readonly preload: number;
  /** Coils cannot pull; leaves can. */
  readonly coil: boolean;
  /** Anti-dive (front) lifts the frame under braking; anti-squat (rear) under drive. */
  readonly antiPitchSign: number;
  readonly brakeTorque: number;
}

function axleSpecs(): readonly [AxleSpec, AxleSpec] {
  const span = GEOMETRY.frontAxleX - GEOMETRY.rearAxleX;
  const sprungX = SPRUNG_CM_OFFSET.x;
  const sprungWeight = SPRUNG_MASS * STANDARD_GRAVITY;
  const frontShare = (sprungX - GEOMETRY.rearAxleX) / span;
  return [
    {
      suspension: FRONT,
      x: GEOMETRY.frontAxleX,
      halfTrack: GEOMETRY.frontTrack / 2,
      halfSpringTrack: FRONT.springTrack / 2,
      pivotAbove: FRONT.rollCentreHeight - (CG_HEIGHT + WHEEL_CENTRE_Y),
      preload: (sprungWeight * frontShare) / 2,
      coil: true,
      antiPitchSign: -1,
      brakeTorque: CAR.brakes.frontTorque,
    },
    {
      suspension: REAR,
      x: GEOMETRY.rearAxleX,
      halfTrack: GEOMETRY.rearTrack / 2,
      halfSpringTrack: REAR.springTrack / 2,
      pivotAbove: REAR.rollCentreHeight - (CG_HEIGHT + WHEEL_CENTRE_Y),
      preload: (sprungWeight * (1 - frontShare)) / 2,
      coil: false,
      antiPitchSign: 1,
      brakeTorque: CAR.brakes.rearTorque,
    },
  ];
}

const AXLES = axleSpecs();
const WHEEL_AXLE = [0, 0, 1, 1] as const;
const WHEEL_SIDE = [-1, 1, -1, 1] as const;

/** The progressive rubber bump stop: N at the given metres past its free gap, with the hard limit at full bump. */
const BUMP_STOP_LINEAR = 200_000;
const BUMP_STOP_CUBIC = 5.6e8;
const BUMP_STOP_DAMPING = 2_500;
/** The damper's internal rebound stop at full droop. */
const DROOP_STOP_STIFFNESS = 400_000;
const DROOP_STOP_DAMPING = 3_000;
/** A tyre squeezed past this is on its rim: much stiffer. */
const RIM_DEFLECTION = 0.12;
const RIM_STIFFNESS = 2_000_000;

/**
 * The hull's contact law: a damped spring along the normal (N/m, N s/m),
 * sliding friction across it, how far past a probe's radius into a
 * collider the spring keeps building, m, a stop: past `stop` metres in, a
 * second damped spring (`stopStiffness`, `stopDamping`) joins the first,
 * `rebound`, the part of the springs' force left as the probe comes back
 * out (1 elastic; under 1 the contact keeps the rest, as a bent beam does),
 * and `wreckDepth`: the 12 m/s wreck rule judges the closing speed a probe
 * still has as it first passes this far in, m (0: at the first touch).
 */
interface HullContactLaw {
  readonly stiffness: number;
  readonly damping: number;
  readonly friction: number;
  readonly reach: number;
  readonly stop: number;
  readonly stopStiffness: number;
  readonly stopDamping: number;
  readonly rebound: number;
  readonly wreckDepth: number;
}
const HULL_GROUND: HullContactLaw = Object.freeze({
  stiffness: 250_000,
  damping: 6_000,
  friction: 0.55,
  reach: 0.25,
  stop: Infinity,
  stopStiffness: 0,
  stopDamping: 0,
  rebound: 1,
  wreckDepth: 0,
});
/** Walls, buildings, the marina's structures: rigid. */
const HULL_COLLIDER: HullContactLaw = Object.freeze({
  stiffness: 800_000,
  damping: 20_000,
  friction: 0.4,
  reach: 0.25,
  stop: Infinity,
  stopStiffness: 0,
  stopDamping: 0,
  rebound: 1,
  wreckDepth: 0,
});
/**
 * A W-beam guardrail (`CAR_COLLIDER_MATERIAL.guardrail`): it gives, 0.4 m
 * at 80 km/h and 20 degrees and 0.6 m at 100 km/h and 25 degrees, so it is
 * soft and reaches deep, and the beam is smooth along its length. Past
 * 0.6 m the posts and the beam's tension take over, so a car square on at
 * any speed stays on the road side (the collider is `GUARDRAIL_DEPTH` deep).
 * A beam is there to take a shallow hit, so the wreck rule judges what is
 * left of the closing speed when the give reaches that stop.
 */
const HULL_GUARDRAIL: HullContactLaw = Object.freeze({
  stiffness: 25_000,
  damping: 2_000,
  friction: 0.25,
  reach: 0.95,
  stop: 0.6,
  stopStiffness: 800_000,
  stopDamping: 20_000,
  rebound: 0.2,
  wreckDepth: 0.6,
});
/** A probe higher than this above the highest tyre contact is not sampled this step, metres. */
const HULL_SAMPLE_MARGIN = 0.9;
/** Closing speed above which an impact wrecks the car, m/s (the plan's 12 m/s). */
export const CRASH_IMPACT_SPEED = 12;
/** The roof or a side down at more than this speed is a crash, not just rolled, m/s. */
const CRASH_ROLL_SPEED = 10;

/** Soft ground presses in this fast under a new load, s; it only springs back as the tyre rolls onto fresh soil. */
const SINK_SECONDS = 0.05;

/**
 * The start waits at most this long for its terrain pages, s, then settles on
 * whatever answers: a worker no renderer feeds must not strand the car.
 */
export const GROUND_WAIT_SECONDS = 10;
/** Half-side of the square about the car's origin that must be published before it settles, m: the car and a margin. */
const GROUND_READY_RADIUS = 8;

/**
 * Recovery's safe spots (land plan, "Recovery"): the car records where it
 * stands at most once a second, on four wheels, under 25 degrees off level
 * and with no wheel over water, and only once it has moved this far from the
 * last spot, so a parked car keeps its history. The ring keeps this many.
 */
const SAFE_SPOT_SECONDS = 1;
const SAFE_SPOT_SPACING = 3;
const SAFE_SPOT_COUNT = 16;
const SAFE_SPOT_UP = Math.cos((25 * Math.PI) / 180);
/** A tyre carrying more than this is down, N (the kerb weight puts about 5.6 kN on each). */
const WHEEL_DOWN_LOAD = 500;
/**
 * A recovery passes over spots the car is still within this of, m: the spot
 * a second press has already put it on, or the one it is stuck at.
 */
const RECOVER_SKIP = 2;
/** The speed over which the soil's compaction resistance builds from a standstill, m/s: it holds like friction. */
const COMPACTION_SPEED = 0.05;

/** ABS: the braking slip it holds, and how fast it bleeds and restores a wheel's pressure. */
const ABS_SLIP = 0.14;
const ABS_RELEASE_RATE = 30;
const ABS_APPLY_RATE = 8;
const ABS_MIN_SPEED = 1.5;
/** Traction control: the spin across an axle it allows, rad/s, and its brake gain, N m per rad/s. */
const TC_SPIN = 3;
const TC_GAIN = 350;
const TC_MAX_TORQUE = 2_200;
/** Downhill assist's held speed, m/s (about 5 km/h), and its PI gains on the brake pedal. */
const DAC_SPEED = 1.4;
const DAC_GAIN = 0.45;
const DAC_INTEGRAL = 0.8;
/** Hill-start assist holds this long, on a slope steeper than this. */
const HSA_SECONDS = 2;
const HSA_MIN_SLOPE = (3 * Math.PI) / 180;

/**
 * Water (land plan, "Water"): the car displaces its wheels, the frame and
 * running gear below the body, and the body's sealed volume, which floods
 * through the door seals over `floodSeconds`. The body's plan is split into
 * columns, each reading the water at its nearer wheel, so a car half in a
 * river floats at one end.
 */
const WATER = CAR.water;
const BODY = CAR.body;
const FRESH_WATER_DENSITY = 1_000;
const SEA_WATER_DENSITY = 1_025;
/** ESTIMATE: a submerged hard bed keeps this share of its friction (wet, silted). */
const SUBMERGED_FRICTION = 0.8;
/** The cabin drains this much faster than it floods, out of the water. */
const CABIN_DRAIN_RATE = 3;
/** The share of the side and front below the body that is solid (wheels, frame, tank) rather than gap. */
const UNDERBODY_SOLIDITY = 0.85;
/** Heave drag of the body's plan in water. */
const PLAN_DRAG_COEFFICIENT = 1.2;
const COLUMN_ALONG = 4;
const COLUMN_COUNT = COLUMN_ALONG * 2;
const COLUMN_LENGTH = BODY.length / COLUMN_ALONG;
const COLUMN_AREA = COLUMN_LENGTH * (BODY.width / 2);
const FRONT_FACE_X = GEOMETRY.frontAxleX + BODY.frontOverhang;
const MID_AXLE_X = (GEOMETRY.frontAxleX + GEOMETRY.rearAxleX) / 2;
/** Column c: its centre in plan, body frame, and the wheel (same side, nearer axle) whose water it reads. */
const COLUMN_X = Float64Array.from({ length: COLUMN_COUNT }, (_, c) => FRONT_FACE_X - (Math.floor(c / 2) + 0.5) * COLUMN_LENGTH);
const COLUMN_Z = Float64Array.from({ length: COLUMN_COUNT }, (_, c) => (c % 2 === 0 ? -0.25 : 0.25) * BODY.width);
const COLUMN_WHEEL = Int32Array.from({ length: COLUMN_COUNT }, (_, c) => (COLUMN_X[c]! > MID_AXLE_X ? 0 : 2) + (c % 2));
/** The layers, body-frame heights: running gear from the ground clearance to the body's floor, then the body to its roof. */
const CHASSIS_BOTTOM_Y = BODY.groundClearance - CG_HEIGHT;
const CHASSIS_LAYER = WATER.bodyBottomHeight - BODY.groundClearance;
const BODY_LAYER = BODY.height - WATER.bodyBottomHeight;
const CHASSIS_POROSITY = WATER.chassisVolume / (BODY.length * BODY.width * CHASSIS_LAYER);
const BODY_POROSITY = WATER.cabinVolume / (BODY.length * BODY.width * BODY_LAYER);

interface HullProbeRecord {
  part: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** -1 the frame, 0 front axle, 1 rear axle. */
  axle: number;
  upperBody: boolean;
}

const HULL: readonly HullProbeRecord[] = CAR.hull.flatMap((part) =>
  part.probes.map((probe) => ({
    part: part.name,
    x: probe.x,
    y: probe.y,
    z: probe.z,
    radius: probe.radius,
    axle: "axle" in part ? (part.axle === "front" ? 0 : 1) : -1,
    upperBody: part.upperBody,
  })),
);

/** A test's or probe's surface: what lies at the ground point `at` (x, z, height and gradient), into `out`. */
export type CarSurfaceField = (at: Readonly<GroundPoint>, out: CarSurface) => void;

export interface GroundVehicleOptions {
  /**
   * Read the ground from this field rather than the worker's height
   * authority through the 2 m lattice cache: tests and probes with exact
   * shapes (a ramp's sharp toe, a ditch).
   */
  ground?: GroundField;
  /** Read the surface from this rather than the world's classifier (asphalt without a world). */
  surface?: CarSurfaceField;
}

/** Radial stiffness at a pressure, N/m: k grows with p + p0. */
export function tyreRadialStiffness(pressureBar: number): number {
  const offset = TYRE.radialStiffnessPressureOffsetBar;
  return (TYRE.radialStiffness * (pressureBar + offset)) / (TYRE.roadPressureBar + offset);
}

function presetPressure(preset: CarTyrePressure): number {
  return preset === "sand" ? TYRE.sandPressureBar : TYRE.roadPressureBar;
}

export class GroundVehicleSimulator implements SurfaceVehicleSimulator {
  readonly state: VehiclePoseState;
  readonly setup: Readonly<CarSetup>;
  private readonly body: RigidBody;
  private readonly controls: CarControlState = { ...NEUTRAL_CAR_CONTROLS };
  private environment: Readonly<SurfaceVehicleEnvironment> | null = null;
  private readonly lattice = new TerrainLatticeCache(() => 0);
  private readonly fixedGround: GroundField | null;
  private readonly fixedSurface: CarSurfaceField | null;
  private readonly surfaceCache = new SurfaceCache();
  private placed = false;
  /** Waiting at the start for the terrain pages under the car (`groundReady`), and for how long, s. */
  private settling = false;
  private groundWait = 0;
  /** The safe spots, newest at `safeSpotNext - 1`: the body origin's x, y, z and the heading, four to a spot. */
  private readonly safeSpots = new Float64Array(SAFE_SPOT_COUNT * 4);
  private safeSpotCount = 0;
  private safeSpotNext = 0;
  private safeSpotClock = 0;

  readonly engine: Engine;
  readonly transmission: Transmission;
  readonly steering = new Steering();
  readonly driveline = new DrivelineSolver();
  private readonly pedals: DriverPedals = { accelerator: 0, brake: 0 };
  private handbrake = 0;
  private headlights: CarHeadlights = "off";
  private headlightPresses: number | null = null;
  private downhillPresses: number | null = null;
  downhillAssist = false;
  downhillAssistActive = false;
  tractionControlActive = false;
  /** Traction control is on (the car's default; tests turn it off). It stands down while a locker is engaged. */
  tractionControl = true;
  absActive = false;
  private dacIntegral = 0;
  private hillHold = 0;
  private hillHoldBrake = 0;
  private previousBrake = 0;
  tyrePressureBar = TYRE.roadPressureBar;
  /** Driveline windup between the propeller shafts, radians at the shaft. */
  windup = 0;

  // Axles: heave (m, + into bump) and roll (rad, + right end up) against the frame.
  readonly axleHeave = new Float64Array(2);
  readonly axleHeaveRate = new Float64Array(2);
  readonly axleRoll = new Float64Array(2);
  readonly axleRollRate = new Float64Array(2);
  private readonly axleForce = new Float64Array(2);
  private readonly axleMoment = new Float64Array(2);

  // Wheels, in CAR_WHEELS order.
  readonly wheelSpin = new Float64Array(4);
  readonly deflectionX = new Float64Array(4);
  readonly deflectionY = new Float64Array(4);
  readonly wheelLoad = new Float64Array(4);
  readonly wheelSlip = new Float64Array(4);
  readonly wheelSlipRatio = new Float64Array(4);
  readonly wheelForceX = new Float64Array(4);
  readonly wheelForceY = new Float64Array(4);
  /** What each tyre rolls on this step. */
  readonly wheelSurface: readonly CarSurface[] = [createCarSurface(), createCarSurface(), createCarSurface(), createCarSurface()];
  private readonly wheelWet = new Float64Array(4);
  /** Soft ground: each tyre's static sinkage and the rut it has dug by slipping, metres. */
  readonly wheelSinkage = new Float64Array(4);
  readonly wheelRut = new Float64Array(4);
  /** The ISO 8608 profile's height under each tyre this step, metres. */
  private readonly wheelRoughness = new Float64Array(4);
  private readonly roughPoint: RoughnessPoint = { x: 0, z: 0, height: 0 };
  private readonly soilContact = createSoilContact();
  private readonly absFactor = new Float64Array(4).fill(1);
  private readonly tcTorque = new Float64Array(4);
  private readonly contacts: WheelContact[] = [createWheelContact(), createWheelContact(), createWheelContact(), createWheelContact()];
  private readonly torque = new Float64Array(DRIVELINE_DOF);

  // Hull probes: this step's ground plane per probe.
  private readonly probeActive = new Uint8Array(HULL.length);
  private readonly probePlane = new Float64Array(HULL.length * 6);
  private collidersNear = false;
  private readonly colliderCandidates: number[] = [];
  private readonly colliderBox: ColliderAabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private readonly colliderContact = createColliderContact();
  private readonly probeTouching = new Uint8Array(HULL.length);

  rolled = false;
  private wadingDepthValue = 0;
  private readonly waterSample = createWaterSurfaceSample();
  /**
   * The water at each wheel, sampled one wheel a step in turn (`sampleWater`):
   * there at all, sea or fresh, its surface height and its velocity (the current).
   */
  private readonly waterAt = new Uint8Array(4);
  private readonly waterSea = new Uint8Array(4);
  /** The wheel whose water is sampled next; -1 samples all four (a new start). */
  private waterTurn = -1;
  private readonly waterHeight = new Float64Array(4);
  private readonly waterVelocityX = new Float64Array(4);
  private readonly waterVelocityY = new Float64Array(4);
  private readonly waterVelocityZ = new Float64Array(4);
  /** A tyre whose contact is under the water surface: wet, and no material of its own for the effects. */
  readonly wheelSubmerged = new Uint8Array(4);
  private readonly wheelFrictionScale = new Float64Array(4).fill(1);
  private inWater = false;
  private waterDensity = FRESH_WATER_DENSITY;
  /** How far up the body the cabin has flooded, 0 dry .. 1 full. */
  cabinFlood = 0;
  // Peaks since the last snapshot, for sound and effects.
  private bumpStopPeak = 0;
  private scrapePeak = 0;
  private splashPeak = 0;

  // Scratch.
  private readonly v0: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly v1: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly v2: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly v3: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly force: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly point: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly axleDirection: Vec3 = { x: 0, y: 0, z: 1 };
  private readonly wheelForward: Vec3 = { x: 1, y: 0, z: 0 };
  private readonly centreWorld: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly velocityWorld: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly gravityBody: Vec3 = { x: 0, y: -STANDARD_GRAVITY, z: 0 };
  private readonly axleAcceleration: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly curveX = createResolvedCurve();
  private readonly curveY = createResolvedCurve();
  private readonly slip = createCombinedSlipResult();
  private readonly converter: ConverterState = { pumpOmega: 0, turbineOmega: 0, pump: 0, turbine: 0 };
  private readonly motion: TransmissionMotion = { dt: 0, speed: 0, rearPropOmega: 0, engineOmega: 0 };
  private readonly tyreInput = createTyreInput(TYRE.nominalLoad);
  private readonly contactPoint: Vec3 = { x: 0, y: 0, z: 0 };
  // This step's numbers, as fields so that no call passes one.
  private dt = 0;
  private h = 0;
  /** The environment's gravity, a field: a getter's double return would be boxed in the substep. */
  private gravity = STANDARD_GRAVITY;
  private columnY = 0;
  private speed = 0;
  private slope = 0;
  private radialStiffness = tyreRadialStiffness(TYRE.roadPressureBar);
  private hullPenetration = 0;
  private hullResult = 0;
  private readonly groundScratch = createGroundPoint();
  private readonly normalScratch: Vec3 = { x: 0, y: 1, z: 0 };

  constructor(spawn?: SurfaceVehicleSpawn, options: GroundVehicleOptions = {}) {
    this.setup = spawn?.car ?? DEFAULT_CAR_SETUP;
    this.fixedGround = options.ground ?? null;
    this.fixedSurface = options.surface ?? null;
    this.engine = new Engine(this.setup.gearbox === "manual" ? CAR.engine.manualTorque : CAR.engine.automaticTorque);
    this.transmission = new Transmission(this.setup);
    const heading = spawn?.heading ?? 0;
    const position = spawn?.position ?? { x: 0, y: 0, z: 0 };
    const orientation = quaternionFromFlightAngles(heading, 0, 0);
    this.body = new RigidBody({
      mass: SPRUNG_MASS,
      inertia: CAR.mass.sprungInertia,
      orientation,
    });
    this.state = {
      time: 0,
      position: { x: position.x, y: position.y + CG_HEIGHT, z: position.z },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: { ...orientation },
      angularVelocity: { x: 0, y: 0, z: 0 },
      crashed: false,
    };
    this.placeOrigin(this.state.position, orientation);
    this.driveline.omega[ENGINE] = IDLE_OMEGA;
    this.driveline.engineInertia = CAR.engine.inertia;
    this.driveline.wheelInertia = TYRE.spinInertia;
  }

  /** Put the car's body origin at `origin` with this orientation, at rest. */
  private placeOrigin(origin: Readonly<Vec3>, orientation: Readonly<Quaternion>): void {
    const body = this.body;
    body.orientation.x = orientation.x;
    body.orientation.y = orientation.y;
    body.orientation.z = orientation.z;
    body.orientation.w = orientation.w;
    rotateVectorInto(this.v0, body.orientation, SPRUNG_CM_OFFSET);
    body.position.x = origin.x + this.v0.x;
    body.position.y = origin.y + this.v0.y;
    body.position.z = origin.z + this.v0.z;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.angularVelocity.x = 0;
    body.angularVelocity.y = 0;
    body.angularVelocity.z = 0;
    body.linearAcceleration.x = 0;
    body.linearAcceleration.y = 0;
    body.linearAcceleration.z = 0;
    body.angularAcceleration.x = 0;
    body.angularAcceleration.y = 0;
    body.angularAcceleration.z = 0;
    this.syncState();
  }

  setControls(controls: Readonly<SurfaceVehicleControls>): void {
    const car = controls.car ?? NEUTRAL_CAR_CONTROLS;
    const c = this.controls;
    c.accelerator = finite01(car.accelerator);
    c.brake = finite01(car.brake);
    c.steer = Number.isFinite(car.steer) ? clamp(car.steer, -1, 1) : 0;
    c.handbrake = finite01(car.handbrake);
    c.clutch = finite01(car.clutch);
    c.shiftUpPresses = car.shiftUpPresses;
    c.shiftDownPresses = car.shiftDownPresses;
    c.autoModePresses = car.autoModePresses;
    c.rangePresses = car.rangePresses;
    c.lockPresses = car.lockPresses;
    c.downhillAssistPresses = car.downhillAssistPresses;
    c.headlightPresses = car.headlightPresses;
    c.tyrePressure = car.tyrePressure === "sand" ? "sand" : "road";
    if (this.headlightPresses === null) this.headlightPresses = car.headlightPresses;
    else if (car.headlightPresses !== this.headlightPresses && Number.isFinite(car.headlightPresses)) {
      const presses = car.headlightPresses - this.headlightPresses;
      this.headlightPresses = car.headlightPresses;
      for (let i = 0; i < ((presses % 3) + 3) % 3; i += 1) {
        this.headlights = this.headlights === "off" ? "dipped" : this.headlights === "dipped" ? "main" : "off";
      }
    }
    if (this.downhillPresses === null) this.downhillPresses = car.downhillAssistPresses;
    else if (car.downhillAssistPresses !== this.downhillPresses && Number.isFinite(car.downhillAssistPresses)) {
      const presses = car.downhillAssistPresses - this.downhillPresses;
      this.downhillPresses = car.downhillAssistPresses;
      // Downhill assist is the automatic's alone.
      if (presses > 0 && presses % 2 === 1 && this.setup.gearbox === "automatic") this.downhillAssist = !this.downhillAssist;
    }
  }

  setEnvironment(environment: Readonly<SurfaceVehicleEnvironment>): void {
    // A new water authority: ask it about all four wheels at once.
    if (environment.water !== this.environment?.water) this.waterTurn = -1;
    this.environment = environment;
    this.lattice.setSampler(environment.bedHeight);
    this.gravity = environment.gravity > 0 ? environment.gravity : STANDARD_GRAVITY;
  }

  private get ground(): GroundField {
    return this.fixedGround ?? this.lattice;
  }

  step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const env = this.environment;
    if (!env && !this.fixedGround) {
      this.state.time += dt;
      return;
    }
    this.lattice.setTime(this.state.time);
    if (!this.placed) {
      if (this.awaitGround(env, dt)) return;
      this.settleOnGround();
    }

    this.dt = dt;
    this.h = dt / SUBSTEPS;
    this.body.stepSeconds = this.h;
    this.driveline.dt = this.h;
    this.updateSpeed();
    this.updateDriver();
    this.findContacts();
    this.sampleWater();
    this.sampleSurfaces();
    this.prepareHull();

    for (let substep = 0; substep < SUBSTEPS; substep += 1) this.substep();

    this.afterStep();
    this.state.time += dt;
    this.syncState();
    this.recordSafeSpot();
  }

  /** Once a second at most: where the car stands now, if it is a place to recover to. */
  private recordSafeSpot(): void {
    this.safeSpotClock += this.dt;
    if (this.safeSpotClock < SAFE_SPOT_SECONDS) return;
    if (this.state.crashed || this.rolled || this.engine.flooded) return;
    for (let w = 0; w < 4; w += 1) if (!(this.wheelLoad[w]! > WHEEL_DOWN_LOAD) || this.waterAt[w] !== 0) return;
    const q = this.body.orientation;
    if (rotateVectorInto(this.v3, q, BODY_UP).y < SAFE_SPOT_UP) return;
    this.safeSpotClock = 0;
    const at = this.state.position;
    const spots = this.safeSpots;
    if (this.safeSpotCount > 0) {
      const newest = ((this.safeSpotNext + SAFE_SPOT_COUNT - 1) % SAFE_SPOT_COUNT) * 4;
      const dx = at.x - spots[newest]!;
      const dz = at.z - spots[newest + 2]!;
      if (dx * dx + dz * dz < SAFE_SPOT_SPACING * SAFE_SPOT_SPACING) return;
    }
    const f = rotateVectorInto(this.v3, q, BODY_FORWARD);
    const i = this.safeSpotNext * 4;
    spots[i] = at.x;
    spots[i + 1] = at.y;
    spots[i + 2] = at.z;
    spots[i + 3] = Math.atan2(f.x, f.z);
    this.safeSpotNext = (this.safeSpotNext + 1) % SAFE_SPOT_COUNT;
    this.safeSpotCount = Math.min(SAFE_SPOT_COUNT, this.safeSpotCount + 1);
  }

  /**
   * R in a car session (land plan, "Recovery"): the car back on its newest
   * safe spot, upright and stopped, its engine running dry and its box in P
   * (or first with the clutch open), in the same drive: the setup, range,
   * locks, tyre pressures and lights stay as they were. A spot the car is
   * still on is dropped for the one before, so each press steps further
   * back; the oldest is kept. With no spot yet the car comes upright where
   * it lies. It is seated on the ground at its next step, through the spawn
   * gate like a start.
   */
  recover(): void {
    const at = this.state.position;
    const spots = this.safeSpots;
    let spot = -1;
    while (this.safeSpotCount > 0) {
      const newest = (this.safeSpotNext + SAFE_SPOT_COUNT - 1) % SAFE_SPOT_COUNT;
      const dx = at.x - spots[newest * 4]!;
      const dz = at.z - spots[newest * 4 + 2]!;
      if (this.safeSpotCount === 1 || dx * dx + dz * dz >= RECOVER_SKIP * RECOVER_SKIP) {
        spot = newest * 4;
        break;
      }
      this.safeSpotNext = newest;
      this.safeSpotCount -= 1;
    }
    let heading = this.headingOf(this.body.orientation);
    if (spot >= 0) {
      this.v1.x = spots[spot]!;
      this.v1.y = spots[spot + 1]!;
      this.v1.z = spots[spot + 2]!;
      heading = spots[spot + 3]!;
    } else {
      this.v1.x = at.x;
      this.v1.y = at.y;
      this.v1.z = at.z;
    }
    this.placeOrigin(this.v1, quaternionFromFlightAngles(heading, 0, 0));
    this.placed = false;
    this.settling = false;
    this.groundWait = 0;
    this.safeSpotClock = 0;
    this.state.crashed = false;
    this.rolled = false;
    this.cabinFlood = 0;
    this.wadingDepthValue = 0;
    this.inWater = false;
    this.waterTurn = -1;
    this.waterAt.fill(0);
    this.wheelSubmerged.fill(0);
    this.engine.reset();
    this.transmission.reset();
    this.driveline.omega.fill(0);
    this.driveline.omega[ENGINE] = IDLE_OMEGA;
    this.driveline.impulse.fill(0);
    this.windup = 0;
    this.axleHeave.fill(0);
    this.axleHeaveRate.fill(0);
    this.axleRoll.fill(0);
    this.axleRollRate.fill(0);
    this.deflectionX.fill(0);
    this.deflectionY.fill(0);
    this.wheelLoad.fill(0);
    this.wheelSlip.fill(0);
    this.wheelSlipRatio.fill(0);
    this.wheelForceX.fill(0);
    this.wheelForceY.fill(0);
    this.wheelSinkage.fill(0);
    this.wheelRut.fill(0);
    this.absFactor.fill(1);
    this.tcTorque.fill(0);
    this.probeTouching.fill(0);
    this.dacIntegral = 0;
    this.hillHold = 0;
    this.hillHoldBrake = 0;
    this.bumpStopPeak = 0;
    this.scrapePeak = 0;
    this.splashPeak = 0;
  }

  /**
   * The spawn gate: hold the car still and unsimulated at its start until
   * the published terrain pages answer all round it (`groundReady`), so it
   * never settles on the macro grid's or the analytic kernel's height, or
   * for `GROUND_WAIT_SECONDS` at most. True while it waits.
   */
  private awaitGround(env: Readonly<SurfaceVehicleEnvironment> | null, dt: number): boolean {
    const ready = env?.groundReady;
    if (!ready || this.fixedGround || this.groundWait >= GROUND_WAIT_SECONDS) {
      this.settling = false;
      return false;
    }
    const at = this.state.position;
    if (ready(at.x, at.z, GROUND_READY_RADIUS)) {
      this.settling = false;
      // Nothing read before the pages landed may stand.
      this.lattice.clear();
      return false;
    }
    this.settling = true;
    this.groundWait += dt;
    this.state.time += dt;
    return true;
  }

  /** The first step with a ground: seat the car on it at ride height, level with the ground under its wheels. */
  private settleOnGround(): void {
    this.placed = true;
    const origin = this.state.position;
    const heading = wrapAngle(this.headingOf(this.body.orientation));
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // Body +Z, the right side, in plan.
    const rx = -fz;
    const rz = fx;
    const ground = this.ground;
    const heights = [0, 0, 0, 0];
    for (let w = 0; w < 4; w += 1) {
      const axle = AXLES[WHEEL_AXLE[w]!]!;
      const side = WHEEL_SIDE[w]! * axle.halfTrack;
      this.groundScratch.x = origin.x + fx * axle.x + rx * side;
      this.groundScratch.z = origin.z + fz * axle.x + rz * side;
      ground.evaluate(this.groundScratch);
      heights[w] = this.groundScratch.height;
    }
    const front = (heights[0]! + heights[1]!) / 2;
    const rear = (heights[2]! + heights[3]!) / 2;
    const left = (heights[0]! + heights[2]!) / 2;
    const right = (heights[1]! + heights[3]!) / 2;
    const span = GEOMETRY.frontAxleX - GEOMETRY.rearAxleX;
    const pitch = Math.atan2(front - rear, span);
    const bank = Math.atan2(left - right, (GEOMETRY.frontTrack + GEOMETRY.rearTrack) / 2);
    const under = rear + (front - rear) * (-GEOMETRY.rearAxleX / span);
    // The tyres' static squash: the car sits a little under the nominal ride height.
    const squash = (CAR.mass.kerb * STANDARD_GRAVITY) / 4 / tyreRadialStiffness(this.tyrePressureBar)
      - (TYRE.freeRadius - TYRE.loadedRadius);
    const lift = (CG_HEIGHT - squash) / Math.max(0.5, Math.cos(pitch) * Math.cos(bank));
    this.v1.x = origin.x;
    this.v1.y = under + lift;
    this.v1.z = origin.z;
    this.placeOrigin(this.v1, quaternionFromFlightAngles(heading, pitch, bank));
  }

  private headingOf(q: Readonly<Quaternion>): number {
    const f = rotateVectorInto(this.v3, q, BODY_FORWARD);
    return Math.atan2(f.x, f.z);
  }

  /** Signed speed along the body's forward axis at the body origin, m/s. */
  private forwardSpeed(): number {
    const f = rotateVectorInto(this.v3, this.body.orientation, BODY_FORWARD);
    const v = this.body.velocity;
    return v.x * f.x + v.y * f.y + v.z * f.z;
  }

  /** `forwardSpeed` into `speed`, for the step. */
  private updateSpeed(): void {
    const f = rotateVectorInto(this.v3, this.body.orientation, BODY_FORWARD);
    const v = this.body.velocity;
    this.speed = v.x * f.x + v.y * f.y + v.z * f.z;
  }

  // ---------------------------------------------------------------- driver

  private updateDriver(): void {
    const c = this.controls;
    const dt = this.dt;
    const speed = this.speed;
    const stopped = Math.abs(speed) < STOPPED_SPEED;
    const omega = this.driveline.omega;
    const motion = this.motion;
    motion.dt = dt;
    motion.speed = speed;
    motion.rearPropOmega = this.transmission.finalDrive * 0.5 * (omega[3]! + omega[4]!);
    motion.engineOmega = omega[ENGINE]!;
    this.transmission.update(c, motion, this.engine, this.pedals);
    if (this.state.crashed || this.engine.flooded) this.pedals.accelerator = 0;
    this.handbrake = c.handbrake;
    this.steering.input = c.steer;
    this.steering.update(motion);

    // Tyre pressure moves towards the preset only while stopped (the compressor or a deflator).
    const target = presetPressure(c.tyrePressure);
    if (stopped && target !== this.tyrePressureBar) {
      const rate = target > this.tyrePressureBar ? 1 / TYRE.inflateSecondsPerBar : 1 / TYRE.deflateSecondsPerBar;
      const delta = target - this.tyrePressureBar;
      this.tyrePressureBar += Math.max(-rate * dt, Math.min(rate * dt, delta));
    }
    // tyreRadialStiffness, inline.
    const offset = TYRE.radialStiffnessPressureOffsetBar;
    this.radialStiffness = (TYRE.radialStiffness * (this.tyrePressureBar + offset)) / (TYRE.roadPressureBar + offset);

    this.updateAids(stopped);
    const engine = this.engine;
    engine.omega = omega[ENGINE]!;
    engine.pedal = this.pedals.accelerator;
    engine.crank = !this.state.crashed
      && this.transmission.canCrank(c)
      // W, or S where it is the accelerator (reverse), or the clutch pedal down turns the key.
      && (Math.max(c.accelerator, this.pedals.accelerator) > 0.05 || c.clutch > 0.8);
    engine.dt = dt;
    engine.update();
  }

  private updateAids(stopped: boolean): void {
    const dt = this.dt;
    const speed = this.speed;
    const t = this.transmission;
    const omega = this.driveline.omega;
    // ABS: bleed a wheel's pressure while it slips past the peak under braking.
    let abs = false;
    for (let w = 0; w < 4; w += 1) {
      const braking = this.pedals.brake > 0.05 && Math.abs(speed) > ABS_MIN_SPEED;
      const locking = braking && this.wheelSlipRatio[w]! * Math.sign(speed) < -ABS_SLIP && this.wheelLoad[w]! > 200;
      if (locking) this.absFactor[w] = Math.max(0, this.absFactor[w]! - ABS_RELEASE_RATE * dt);
      else this.absFactor[w] = Math.min(1, this.absFactor[w]! + ABS_APPLY_RATE * dt);
      if (braking && this.absFactor[w]! < 0.97) abs = true;
    }
    this.absActive = abs;

    // Traction control: brake a wheel spinning past its axle partner, so an open diff sends torque across.
    let tc = false;
    for (let axle = 0; axle < 2; axle += 1) {
      const left = 2 * axle;
      const right = left + 1;
      this.tcTorque[left] = 0;
      this.tcTorque[right] = 0;
      if (!this.tractionControl || t.locks !== "off" || this.pedals.accelerator < 0.05 || this.engine.flooded) continue;
      if (axle === 0 && !t.fourWheelDrive) continue;
      // Which wheel is the faster one depends on the way the axle turns: reverse counts too.
      const direction = omega[left + 1]! + omega[right + 1]! < 0 ? -1 : 1;
      const difference = (omega[left + 1]! - omega[right + 1]!) * direction;
      const spin = Math.abs(difference) - TC_SPIN;
      if (spin <= 0) continue;
      const fast = difference > 0 ? left : right;
      this.tcTorque[fast] = Math.min(TC_MAX_TORQUE, TC_GAIN * spin);
      tc = true;
    }
    this.tractionControlActive = tc;

    // Downhill assist: in 4L with neither pedal, hold about 5 km/h on the brakes.
    const dacArmed = this.downhillAssist && t.automatic && t.range === "4L" && t.gear !== 0;
    const dacWanted = dacArmed && this.pedals.accelerator < 0.02 && this.pedals.brake < 0.05;
    const excess = Math.abs(speed) - DAC_SPEED;
    if (dacWanted && (excess > 0 || this.dacIntegral > 0)) {
      this.dacIntegral = Math.max(0, Math.min(1, this.dacIntegral + DAC_INTEGRAL * excess * dt));
      const pedal = Math.max(0, Math.min(1, DAC_GAIN * excess + this.dacIntegral));
      this.downhillAssistActive = pedal > 0.01;
      this.pedals.brake = Math.max(this.pedals.brake, pedal);
    } else {
      this.dacIntegral = 0;
      this.downhillAssistActive = false;
    }

    // Hill-start assist: the brakes stay on for two seconds after the pedal comes off on a slope.
    const brakePedal = Math.max(this.pedals.brake, this.controls.handbrake);
    const slope = Math.asin(Math.max(-1, Math.min(1, rotateVectorInto(this.v3, this.body.orientation, BODY_FORWARD).y)));
    this.slope = slope;
    if (stopped && t.gear !== 0 && this.previousBrake > 0.1 && brakePedal < 0.05 && Math.abs(slope) > HSA_MIN_SLOPE) {
      this.hillHold = HSA_SECONDS;
      this.hillHoldBrake = Math.max(0.5, this.previousBrake);
    }
    if (this.hillHold > 0) {
      this.hillHold -= dt;
      // Released once the drive pulls the car the way it is pointed, or the driver brakes again.
      const pulling = this.drivePullsUphill();
      if (pulling || brakePedal > 0.05 || !stopped) this.hillHold = 0;
      else this.pedals.brake = Math.max(this.pedals.brake, this.hillHoldBrake);
    }
    this.previousBrake = brakePedal;
  }

  /** Whether the driveline's torque at the wheels now exceeds what the slope (`slope`, nose up) asks to hold the car. */
  private drivePullsUphill(): boolean {
    const t = this.transmission;
    const slope = this.slope;
    if (this.pedals.accelerator < 0.05) return false;
    // The drive's force along the car (forward positive; reverse's ratio is negative).
    const drive = (this.lastCouplingTorque * t.inputRatio * t.finalDrive) / TYRE.loadedRadius;
    if (drive === 0) return false;
    // What of gravity's pull along the car opposes the drive: none when the drive goes downhill.
    const gravityAlong = -CAR.mass.kerb * this.gravity * Math.sin(slope);
    const opposing = Math.max(0, -gravityAlong * Math.sign(drive));
    return Math.abs(drive) > opposing * 1.05;
  }

  private lastCouplingTorque = 0;

  // ---------------------------------------------------------------- contact

  /** The wheel centre and spin axis of wheel `w`, world frame, into centreWorld / axleDirection / wheelForward. */
  private wheelFrame(w: number): void {
    const axle = AXLES[WHEEL_AXLE[w]!]!;
    const a = WHEEL_AXLE[w]!;
    const side = WHEEL_SIDE[w]!;
    const roll = this.axleRoll[a]!;
    const sin = Math.sin(roll);
    const cos = Math.cos(roll);
    const p = this.point;
    p.x = axle.x - SPRUNG_CM_OFFSET.x;
    p.y = WHEEL_CENTRE_Y + this.axleHeave[a]! + side * axle.halfTrack * sin - SPRUNG_CM_OFFSET.y;
    p.z = side * axle.halfTrack * cos - SPRUNG_CM_OFFSET.z;
    this.body.bodyToWorldPoint(p, this.centreWorld);
    // Steer about the axle's own up, then roll with the axle: right end up is a rotation about -X.
    const steer = w === 0 ? this.steering.left : w === 1 ? this.steering.right : 0;
    const ss = Math.sin(steer);
    const cs = Math.cos(steer);
    // Unrolled: axle (-sin d, 0, cos d), forward (cos d, 0, sin d).
    const d = this.v0;
    d.x = -ss;
    d.y = cos * 0 + sin * cs;
    d.z = cos * cs;
    this.body.bodyToWorldVector(d, this.axleDirection);
    const f = this.v0;
    f.x = cs;
    f.y = sin * ss;
    f.z = cos * ss;
    this.body.bodyToWorldVector(f, this.wheelForward);
  }

  private findContacts(): void {
    const ground = this.ground;
    for (let w = 0; w < 4; w += 1) {
      this.wheelFrame(w);
      findWheelContact(ground, this.centreWorld, this.axleDirection, FREE_RADIUS, HALF_TREAD, this.contacts[w]!);
    }
  }

  /**
   * The surface under each tyre, and the roughness profile's height there.
   * With a world, the painted ground is exact at each tyre and the natural
   * ground comes from the surface cache (`surface.ts`); a change of world or
   * of its streamed infrastructure regions also drops the cached lattice
   * nodes, since a road's fill or cut moves the ground; a new calendar day
   * (the environment's `dayOfYear`) repaints the cells only. The world's lookups
   * pass numbers through calls, so this path allocates a little; the
   * test rig's surfaces do not.
   */
  private sampleSurfaces(): void {
    const world = this.environment?.world;
    if (world && !this.fixedSurface && this.surfaceCache.beginStep(world, this.environment?.dayOfYear)) this.lattice.clear();
    for (let w = 0; w < 4; w += 1) {
      const contact = this.contacts[w]!;
      const surface = this.wheelSurface[w]!;
      if (this.fixedSurface) this.fixedSurface(contact.ground, surface);
      else if (world) this.surfaceCache.lookup(world, this.ground, contact.ground, surface);
      else describeSurface(SurfaceMaterial.Asphalt, 0, surface);
      this.wheelFrictionScale[w] = 1;
      if (this.wheelSubmerged[w] === 1) {
        // A bed under water: loam turns to mud, hard ground loses some grip; snow keeps its depth.
        if (!surface.soft) this.wheelFrictionScale[w] = SUBMERGED_FRICTION;
        else if (surface.material !== SurfaceMaterial.Snow) describeSurface(surface.material, 1, surface);
      }
      this.wheelWet[w] = this.wheelSubmerged[w] === 1 ? 1 : surface.wetness;
      if (!surface.soft) {
        this.wheelSinkage[w] = 0;
        this.wheelRut[w] = 0;
      }
      if (surface.roughness > 0) {
        this.roughPoint.x = contact.point.x;
        this.roughPoint.z = contact.point.z;
        roughnessProfile(this.roughPoint);
        this.wheelRoughness[w] = surface.roughness * this.roughPoint.height;
      } else this.wheelRoughness[w] = 0;
    }
  }

  /** This step's ground plane under each hull probe that could reach the ground, and whether colliders are near. */
  private prepareHull(): void {
    let highest = -Infinity;
    for (let w = 0; w < 4; w += 1) highest = Math.max(highest, this.contacts[w]!.point.y);
    const ground = this.ground;
    const plane = this.probePlane;
    for (let i = 0; i < HULL.length; i += 1) {
      const probe = HULL[i]!;
      this.probeWorld(probe, this.centreWorld);
      const c = this.centreWorld;
      if (c.y - probe.radius > highest + HULL_SAMPLE_MARGIN) {
        this.probeActive[i] = 0;
        continue;
      }
      this.probeActive[i] = 1;
      this.groundScratch.x = c.x;
      this.groundScratch.z = c.z;
      ground.evaluate(this.groundScratch);
      groundNormal(this.groundScratch, this.normalScratch);
      const o = i * 6;
      plane[o] = c.x;
      plane[o + 1] = this.groundScratch.height;
      plane[o + 2] = c.z;
      plane[o + 3] = this.normalScratch.x;
      plane[o + 4] = this.normalScratch.y;
      plane[o + 5] = this.normalScratch.z;
    }
    const colliders = this.environment?.colliders;
    this.collidersNear = false;
    if (colliders) {
      const p = this.state.position;
      const box = this.colliderBox;
      box.minX = p.x - 3.5;
      box.maxX = p.x + 3.5;
      box.minY = p.y - 2.5;
      box.maxY = p.y + 2.5;
      box.minZ = p.z - 3.5;
      box.maxZ = p.z + 3.5;
      this.collidersNear = colliders.query(box, this.colliderCandidates) > 0;
    }
  }

  /** A hull probe's centre in the world, riding its axle if it has one. */
  private probeWorld(probe: HullProbeRecord, out: Vec3): Vec3 {
    const p = this.point;
    if (probe.axle >= 0) {
      const axle = AXLES[probe.axle]!;
      const roll = this.axleRoll[probe.axle]!;
      const sin = Math.sin(roll);
      const cos = Math.cos(roll);
      p.x = axle.x + probe.x - SPRUNG_CM_OFFSET.x;
      p.y = WHEEL_CENTRE_Y + this.axleHeave[probe.axle]! + probe.y * cos + probe.z * sin - SPRUNG_CM_OFFSET.y;
      p.z = -probe.y * sin + probe.z * cos - SPRUNG_CM_OFFSET.z;
    } else {
      p.x = probe.x - SPRUNG_CM_OFFSET.x;
      p.y = probe.y - SPRUNG_CM_OFFSET.y;
      p.z = probe.z - SPRUNG_CM_OFFSET.z;
    }
    return this.body.bodyToWorldPoint(p, out);
  }

  /**
   * The water at each wheel's contact, once a step: the wading depth (the
   * highest surface over the lowest contact), which tyres are under it, the
   * cabin's flooding, and whether the intake has gone under. The authority
   * is asked about one wheel a step, in turn (all four at a start or a
   * recovery): in the worker each answer costs a terrain height sample,
   * about 13 us, and the water a wheel has rolled towards in the 4 steps
   * (33 ms) since it was last asked is near enough. Whether a tyre is under
   * the surface is decided every step, from its contact now.
   */
  private sampleWater(): void {
    const env = this.environment;
    this.wadingDepthValue = 0;
    this.inWater = false;
    let sea = false;
    let surface = -Infinity;
    let lowest = Infinity;
    const turn = this.waterTurn;
    this.waterTurn = (turn + 1) & 3;
    for (let w = 0; w < 4; w += 1) {
      this.wheelSubmerged[w] = 0;
      if (!env) {
        this.waterAt[w] = 0;
        continue;
      }
      const at = this.contacts[w]!.point;
      lowest = Math.min(lowest, at.y);
      if (turn < 0 || w === turn) {
        const sample = env.water.sample(at.x, at.z, this.waterSample);
        const wet = sample.kind !== "none";
        this.waterAt[w] = wet ? 1 : 0;
        this.waterSea[w] = sample.kind === "sea" ? 1 : 0;
        this.waterHeight[w] = sample.height;
        this.waterVelocityX[w] = sample.velocity.x;
        this.waterVelocityY[w] = sample.velocity.y;
        this.waterVelocityZ[w] = sample.velocity.z;
      }
      if (this.waterAt[w] !== 1) continue;
      if (this.waterSea[w] === 1) sea = true;
      this.inWater = true;
      surface = Math.max(surface, this.waterHeight[w]!);
      if (this.waterHeight[w]! > at.y) this.wheelSubmerged[w] = 1;
    }
    this.waterDensity = sea ? SEA_WATER_DENSITY : FRESH_WATER_DENSITY;
    // The cabin floods towards the water's height up the body, and drains faster than it fills.
    let immersed = 0;
    if (this.inWater) {
      this.wadingDepthValue = Math.max(0, surface - lowest);
      for (let c = 0; c < COLUMN_COUNT; c += 1) {
        const w = COLUMN_WHEEL[c]!;
        if (this.waterAt[w] !== 1) continue;
        this.columnY = WATER.bodyBottomHeight - CG_HEIGHT;
        this.columnPoint(c);
        immersed += Math.max(0, Math.min(1, (this.waterHeight[w]! - this.v1.y) / BODY_LAYER));
      }
      immersed /= COLUMN_COUNT;
    }
    const rate = (immersed > this.cabinFlood ? 3 : 3 * CABIN_DRAIN_RATE) / WATER.floodSeconds;
    this.cabinFlood += (immersed - this.cabinFlood) * Math.min(1, rate * this.dt);
    if (!this.inWater) return;
    // The intake, ahead of the cab at the wading height above the front wheels' ground.
    this.point.x = CAR.water.intakeX - SPRUNG_CM_OFFSET.x;
    this.point.y = CAR.water.wadingDepth - CG_HEIGHT - SPRUNG_CM_OFFSET.y;
    this.point.z = -SPRUNG_CM_OFFSET.z;
    this.body.bodyToWorldPoint(this.point, this.v1);
    let front = -Infinity;
    for (let w = 0; w < 2; w += 1) if (this.waterAt[w] === 1) front = Math.max(front, this.waterHeight[w]!);
    if (this.engine.running && this.v1.y < front) this.engine.hydrolock();
  }

  /** Column `c`'s centre at body-frame height `columnY` (from the body origin), in the world, into `v1`. */
  private columnPoint(c: number): void {
    this.point.x = COLUMN_X[c]! - SPRUNG_CM_OFFSET.x;
    this.point.y = this.columnY - SPRUNG_CM_OFFSET.y;
    this.point.z = COLUMN_Z[c]! - SPRUNG_CM_OFFSET.z;
    this.body.bodyToWorldPoint(this.point, this.v1);
  }

  /**
   * Buoyancy and drag in water, each substep. Each column displaces its
   * running gear and the unflooded part of its body below the water at its
   * wheel, lifting at the immersed part's middle; each wheel displaces its
   * submerged segment, on its axle. Drag on the front, side and plan below
   * the surface acts on the velocity through the water, so a river's
   * current pushes the car downstream.
   */
  private waterForces(): void {
    if (!this.inWater) return;
    const body = this.body;
    const rho = this.waterDensity;
    const g = this.gravity;
    const full = CHASSIS_LAYER + BODY_LAYER;
    const inside = this.cabinFlood * BODY_LAYER;
    let wetHeight = 0;
    for (let c = 0; c < COLUMN_COUNT; c += 1) {
      const w = COLUMN_WHEEL[c]!;
      if (this.waterAt[w] !== 1) continue;
      this.columnY = CHASSIS_BOTTOM_Y;
      this.columnPoint(c);
      const depth = this.waterHeight[w]! - this.v1.y;
      // The water from the ground up, for the drag: the column's floor stands the ground clearance above it.
      wetHeight += Math.max(0, Math.min(BODY.height, depth + BODY.groundClearance));
      if (depth <= 0) continue;
      const chassis = Math.min(depth, CHASSIS_LAYER);
      const sealed = Math.max(0, Math.min(depth - CHASSIS_LAYER, BODY_LAYER) - inside);
      const lift = rho * g * COLUMN_AREA * (CHASSIS_POROSITY * chassis + BODY_POROSITY * sealed);
      this.columnY = CHASSIS_BOTTOM_Y + 0.5 * Math.min(depth, full);
      this.columnPoint(c);
      this.force.x = 0;
      this.force.y = lift;
      this.force.z = 0;
      body.addForceAtWorldPoint(this.force, this.v1);
    }
    wetHeight /= COLUMN_COUNT;

    for (let w = 0; w < 4; w += 1) {
      if (this.waterAt[w] !== 1) continue;
      this.wheelFrame(w);
      const c = this.centreWorld;
      const depth = Math.max(0, Math.min(2 * FREE_RADIUS, this.waterHeight[w]! - (c.y - FREE_RADIUS)));
      if (depth <= 0) continue;
      // The submerged share of the wheel's disc: a circular segment.
      const t = (FREE_RADIUS - depth) / FREE_RADIUS;
      const share = (Math.acos(t) - t * Math.sqrt(Math.max(0, 1 - t * t))) / Math.PI;
      this.force.x = 0;
      this.force.y = rho * g * WATER.wheelVolume * share;
      this.force.z = 0;
      this.routeAxleForce(WHEEL_AXLE[w]!, this.force, c, false);
    }

    if (wetHeight <= 0) return;
    // The velocity through the water: the car's less the mean current at its wet wheels.
    let count = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let w = 0; w < 4; w += 1) {
      if (this.waterAt[w] !== 1) continue;
      count += 1;
      cx += this.waterVelocityX[w]!;
      cy += this.waterVelocityY[w]!;
      cz += this.waterVelocityZ[w]!;
    }
    const rel = this.v1;
    rel.x = body.velocity.x - cx / count;
    rel.y = body.velocity.y - cy / count;
    rel.z = body.velocity.z - cz / count;
    const vb = body.worldToBodyVector(rel, this.v2);
    const solid = UNDERBODY_SOLIDITY * wetHeight;
    const frontArea = BODY.width * solid;
    const sideArea = BODY.length * solid;
    const planArea = BODY.length * BODY.width * Math.min(1, wetHeight / 0.3);
    const half = 0.5 * rho;
    this.force.x = -half * WATER.frontDragCoefficient * frontArea * Math.abs(vb.x) * vb.x;
    this.force.y = -half * PLAN_DRAG_COEFFICIENT * planArea * Math.abs(vb.y) * vb.y;
    this.force.z = -half * WATER.sideDragCoefficient * sideArea * Math.abs(vb.z) * vb.z;
    // At the middle of the wetted side, above the ground under the car.
    this.point.x = (FRONT_FACE_X - 0.5 * BODY.length) - SPRUNG_CM_OFFSET.x;
    this.point.y = -CG_HEIGHT + 0.5 * wetHeight - SPRUNG_CM_OFFSET.y;
    this.point.z = -SPRUNG_CM_OFFSET.z;
    body.addForceAtBodyPoint(this.force, this.point);
    const through = Math.sqrt(vb.x * vb.x + vb.z * vb.z);
    this.splashPeak = Math.max(this.splashPeak, Math.min(1, (through / 4) * Math.min(1, wetHeight / 0.5)));
  }

  // ---------------------------------------------------------------- substep

  private substep(): void {
    const body = this.body;
    const g = this.gravity;
    const q = body.orientation;
    this.v0.x = 0;
    this.v0.y = -g;
    this.v0.z = 0;
    inverseRotateVectorInto(this.gravityBody, q, this.v0);
    this.axleForce.fill(0);
    this.axleMoment.fill(0);

    // Gravity on the frame.
    this.force.x = 0;
    this.force.y = -SPRUNG_MASS * g;
    this.force.z = 0;
    body.addForce(this.force);

    this.suspensionForces();
    this.tyreForces();
    this.hullForces();
    this.aeroForces();
    this.waterForces();
    this.drivelineStep();
    this.integrateAxles();
    body.advance();
  }

  private suspensionForces(): void {
    const body = this.body;
    let bumpPeak = 0;
    for (let a = 0; a < 2; a += 1) {
      const spec = AXLES[a]!;
      const s = spec.suspension;
      const heave = this.axleHeave[a]!;
      const heaveRate = this.axleHeaveRate[a]!;
      const roll = this.axleRoll[a]!;
      const rollRate = this.axleRollRate[a]!;
      const sin = Math.sin(roll);
      const cos = Math.cos(roll);
      for (let side = -1; side <= 1; side += 2) {
        const lever = side * spec.halfSpringTrack;
        const travel = heave + lever * sin;
        const rate = heaveRate + lever * cos * rollRate;
        let spring = spec.preload + s.springRate * travel;
        if (spec.coil && spring < 0) spring = 0;
        const damperRate = rate > 0 ? s.bumpDamping : s.reboundDamping;
        const knee = s.damperKneeVelocity;
        const speed = Math.abs(rate);
        const damper = Math.sign(rate) * damperRate * (speed <= knee ? speed : knee + (speed - knee) * s.damperDigressiveShare);
        let stop = 0;
        const intoStop = travel - s.bumpStopGap;
        if (intoStop > 0) {
          stop = BUMP_STOP_LINEAR * intoStop + BUMP_STOP_CUBIC * intoStop * intoStop * intoStop;
          stop += BUMP_STOP_DAMPING * (intoStop / (s.bumpTravel - s.bumpStopGap)) * Math.max(0, rate);
          bumpPeak = Math.max(bumpPeak, stop / (spec.preload * 6));
        }
        const pastDroop = -s.droopTravel - travel;
        if (pastDroop > 0) stop -= DROOP_STOP_STIFFNESS * pastDroop + DROOP_STOP_DAMPING * Math.max(0, -rate);
        // Compressive force between axle and frame: down on the axle, up on the frame.
        const total = spring + damper + stop;
        this.axleForce[a] = this.axleForce[a]! - total;
        this.axleMoment[a] = this.axleMoment[a]! - lever * cos * total;
        this.force.x = 0;
        this.force.y = total;
        this.force.z = 0;
        this.point.x = spec.x - SPRUNG_CM_OFFSET.x;
        this.point.y = WHEEL_CENTRE_Y + heave - SPRUNG_CM_OFFSET.y;
        this.point.z = lever - SPRUNG_CM_OFFSET.z;
        body.addForceAtBodyPoint(this.force, this.point);
      }
      // The anti-roll bar: axle roll against the frame.
      const bar = s.antiRollBar * roll;
      this.axleMoment[a] = this.axleMoment[a]! - bar;
      this.v0.x = -bar;
      this.v0.y = 0;
      this.v0.z = 0;
      body.addTorqueBody(this.v0);
    }
    this.bumpStopPeak = Math.max(this.bumpStopPeak, Math.min(1, bumpPeak));
  }

  private tyreForces(): void {
    const h = this.h;
    const body = this.body;
    const omega = this.driveline.omega;
    const stiffness = this.radialStiffness;
    const input = this.tyreInput;
    for (let w = 0; w < 4; w += 1) {
      const a = WHEEL_AXLE[w]!;
      const spec = AXLES[a]!;
      const contact = this.contacts[w]!;
      this.wheelFrame(w);
      const n = contact.normal;
      const axleDir = this.axleDirection;
      const c = this.centreWorld;
      const axleNormal = axleDir.x * n.x + axleDir.y * n.y + axleDir.z * n.z;
      const reach = Math.sqrt(Math.max(0, 1 - axleNormal * axleNormal));
      const surface = this.wheelSurface[w]!;
      const sunk = surface.soft ? Math.min(surface.maxSinkage, this.wheelSinkage[w]! + this.wheelRut[w]!) : 0;
      // The tyre's own deflection: the disc's reach past the ground plane, raised by the
      // roughness profile and let down into soft ground by the sinkage.
      const penetration = TYRE.freeRadius * reach
        - ((c.x - contact.point.x) * n.x + (c.y - contact.point.y) * n.y + (c.z - contact.point.z) * n.z)
        + this.wheelRoughness[w]! - sunk;
      if (!(penetration > 0)) {
        this.wheelLoad[w] = 0;
        this.wheelForceX[w] = 0;
        this.wheelForceY[w] = 0;
        this.wheelSlip[w] = 0;
        this.wheelSlipRatio[w] = 0;
        // A tyre in the air springs back, and leaves its rut.
        const relax = Math.exp(-h * 60);
        this.deflectionX[w] = this.deflectionX[w]! * relax;
        this.deflectionY[w] = this.deflectionY[w]! * relax;
        this.wheelSinkage[w] = this.wheelSinkage[w]! * relax;
        this.wheelRut[w] = this.wheelRut[w]! * relax;
        this.torque[w + 1] = 0;
        continue;
      }
      // Velocity of the wheel centre: the frame's point velocity plus the axle's own motion.
      body.pointVelocity(c, this.velocityWorld);
      const roll = this.axleRoll[a]!;
      const side = WHEEL_SIDE[w]! * spec.halfTrack;
      this.v0.x = 0;
      this.v0.y = this.axleHeaveRate[a]! + side * Math.cos(roll) * this.axleRollRate[a]!;
      this.v0.z = -side * Math.sin(roll) * this.axleRollRate[a]!;
      body.bodyToWorldVector(this.v0, this.v1);
      const v = this.velocityWorld;
      v.x += this.v1.x;
      v.y += this.v1.y;
      v.z += this.v1.z;

      const closing = -(v.x * n.x + v.y * n.y + v.z * n.z);
      let load = stiffness * penetration + TYRE.radialDamping * closing;
      if (penetration > RIM_DEFLECTION) load += RIM_STIFFNESS * (penetration - RIM_DEFLECTION);
      if (load < 0) load = 0;

      // The contact frame: forward in the ground plane, and across it to the wheel's right.
      const f = this.wheelForward;
      const fn = f.x * n.x + f.y * n.y + f.z * n.z;
      let ex = f.x - fn * n.x;
      let ey = f.y - fn * n.y;
      let ez = f.z - fn * n.z;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      ex /= el;
      ey /= el;
      ez /= el;
      // lateral = forward x normal
      const lx = ey * n.z - ez * n.y;
      const ly = ez * n.x - ex * n.z;
      const lz = ex * n.y - ey * n.x;
      const vx = v.x * ex + v.y * ey + v.z * ez;
      const vy = v.x * lx + v.y * ly + v.z * lz;

      const spin = omega[w + 1]!;
      const rolling = TYRE.freeRadius - Math.min(penetration, RIM_DEFLECTION) / 3;
      const transport = rolling * Math.abs(spin) + TYRE_V_N;
      const slipVelocity = vx - rolling * spin;
      input.load = load;
      input.friction = surface.friction * this.wheelFrictionScale[w]!;
      input.slipX = -slipVelocity / transport;
      input.slipY = -vy / transport;
      let compaction = 0;
      if (surface.soft) {
        // Bekker-Wong (soil.ts): the soil carries the tyre, and its shear is the tyre's curve.
        const soil = this.soilContact;
        soil.load = load;
        soil.deflection = penetration;
        soil.sinkage = this.wheelSinkage[w]!;
        soil.rut = this.wheelRut[w]!;
        soilPatch(surface, soil);
        const patch = Math.max(soil.patchLength, 0.05);
        const fresh = Math.min(1, (Math.abs(vx) * h) / patch);
        // Static sinkage presses in quickly and only lifts as the tyre rolls onto fresh soil.
        let sinkage = this.wheelSinkage[w]!;
        const target = soil.targetSinkage;
        sinkage += (target - sinkage) * (target > sinkage ? Math.min(1, h / SINK_SECONDS) : fresh);
        // Slip sinkage: a tyre slipping past DIG_SLIP digs; fresh soil fills the rut back in.
        const tread = Math.abs(rolling * spin);
        const slipRatio = (rolling * spin - vx) / Math.max(tread, Math.abs(vx), 0.2);
        const excess = Math.abs(slipRatio) - DIG_SLIP;
        let rut = this.wheelRut[w]!;
        if (excess > 0) rut += (h * DIG_GAIN * excess * tread * target) / patch;
        rut -= rut * fresh;
        this.wheelSinkage[w] = sinkage;
        this.wheelRut[w] = Math.max(0, Math.min(rut, surface.maxSinkage - sinkage));
        soilCurve(surface, soil, false, this.curveX);
        soilCurve(surface, soil, true, this.curveY);
        compaction = soil.compaction;
      } else {
        resolveCurve(TYRE.longitudinal, input, this.curveX);
        resolveCurve(TYRE.lateral, input, this.curveY);
      }
      const result = combinedSlip(this.curveX, this.curveY, input, this.slip);
      // The slip lamp: a smooth step from half the peak slip to twice it.
      const lamp = Math.max(0, Math.min(1, (result.slip - 0.5) / 1.5));
      this.wheelSlip[w] = lamp * lamp * (3 - 2 * lamp);
      this.wheelSlipRatio[w] = -slipVelocity / Math.max(Math.abs(vx), 1);

      // Rill's first-order deflection: the patch force tends to the steady force.
      const cx = TYRE.longitudinalStiffness;
      const dx = TYRE.longitudinalDamping;
      const cy = TYRE.lateralStiffness;
      const dy = TYRE.lateralDamping;
      const fx = result.perSlipX;
      const fy = result.perSlipY;
      const xe = this.deflectionX[w]!;
      const ye = this.deflectionY[w]!;
      const xRate = -(transport * cx * xe + fx * slipVelocity) / (transport * dx + fx);
      const yRate = -(transport * cy * ye + fy * vy) / (transport * dy + fy);
      let forceX = cx * xe + dx * xRate;
      let forceY = cy * ye + dy * yRate;
      // The patch cannot hold more than the tyre's sliding grip.
      const limit = Math.max(result.slidingForce, Math.sqrt(result.forceX * result.forceX + result.forceY * result.forceY));
      const total = Math.sqrt(forceX * forceX + forceY * forceY);
      if (total > limit && total > 0) {
        forceX *= limit / total;
        forceY *= limit / total;
      }
      // Integrate the deflection implicitly in itself (stable at any speed).
      this.deflectionX[w] = (xe - (h * fx * slipVelocity) / (transport * dx + fx)) / (1 + (h * transport * cx) / (transport * dx + fx));
      this.deflectionY[w] = (ye - (h * fy * vy) / (transport * dy + fy)) / (1 + (h * transport * cy) / (transport * dy + fy));
      // Re-clamp the stored deflection to the same limit.
      const storedX = cx * this.deflectionX[w]!;
      const storedY = cy * this.deflectionY[w]!;
      const stored = Math.sqrt(storedX * storedX + storedY * storedY);
      if (stored > limit && stored > 0) {
        this.deflectionX[w] = (this.deflectionX[w]! * limit) / stored;
        this.deflectionY[w] = (this.deflectionY[w]! * limit) / stored;
      }
      this.wheelLoad[w] = load;
      this.wheelForceX[w] = forceX;
      this.wheelForceY[w] = forceY;

      // Rolling resistance as a torque on the wheel, smooth through a standstill.
      const resistance = surface.rollingResistance * load * rolling * Math.tanh(spin / 2);
      this.torque[w + 1] = -forceX * rolling - resistance;

      // The force in the world, at the contact point under the disc. Soft ground's compaction
      // resistance holds the car back, not the wheel: the tyre has to climb out of its rut.
      const along = forceX - compaction * Math.tanh(vx / COMPACTION_SPEED);
      const fw = this.force;
      fw.x = load * n.x + along * ex + forceY * lx;
      fw.y = load * n.y + along * ey + forceY * ly;
      fw.z = load * n.z + along * ez + forceY * lz;
      // Contact point: the disc's deepest point, on the ground plane.
      const k = reach > 1e-9 ? FREE_RADIUS / reach : 0;
      const p = this.contactPoint;
      p.x = c.x - k * (n.x - axleNormal * axleDir.x) + penetration * n.x;
      p.y = c.y - k * (n.y - axleNormal * axleDir.y) + penetration * n.y;
      p.z = c.z - k * (n.z - axleNormal * axleDir.z) + penetration * n.z;
      this.routeAxleForce(a, fw, p, true);
    }
  }

  /**
   * Hand a world force at a world point on axle `a` to the axle and the
   * frame: the frame's vertical component to the axle's heave and roll; the
   * longitudinal to the frame at the point; the lateral to the frame at the
   * roll centre, its moment about it rolling the axle. A tyre's longitudinal
   * force also pulls the link geometry's anti-dive or anti-squat.
   */
  private routeAxleForce(a: number, forceWorld: Vec3, pointWorld: Readonly<Vec3>, tyre: boolean): void {
    const body = this.body;
    const spec = AXLES[a]!;
    const fb = body.worldToBodyVector(forceWorld, this.v2);
    this.v3.x = pointWorld.x;
    this.v3.y = pointWorld.y;
    this.v3.z = pointWorld.z;
    const pb = body.worldToBodyPoint(this.v3, this.v3);
    // Body-origin coordinates of the point, relative to the axle centre.
    const heave = this.axleHeave[a]!;
    const relY = pb.y + SPRUNG_CM_OFFSET.y - (WHEEL_CENTRE_Y + heave);
    const relZ = pb.z + SPRUNG_CM_OFFSET.z;
    const pivotY = spec.pivotAbove;
    this.axleForce[a] = this.axleForce[a]! + fb.y;
    this.axleMoment[a] = this.axleMoment[a]! + relZ * fb.y - (relY - pivotY) * fb.z;
    // Longitudinal, at the point.
    this.force.x = fb.x;
    this.force.y = 0;
    this.force.z = 0;
    body.addForceAtBodyPoint(this.force, pb);
    // Lateral, at the roll centre.
    this.force.x = 0;
    this.force.y = 0;
    this.force.z = fb.z;
    this.point.x = spec.x - SPRUNG_CM_OFFSET.x;
    this.point.y = WHEEL_CENTRE_Y + heave + pivotY - SPRUNG_CM_OFFSET.y;
    this.point.z = -SPRUNG_CM_OFFSET.z;
    body.addForceAtBodyPoint(this.force, this.point);
    if (tyre) {
      const lift = spec.antiPitchSign * spec.suspension.antiPitch * fb.x;
      this.axleForce[a] = this.axleForce[a]! - lift;
      this.force.x = 0;
      this.force.y = lift;
      this.force.z = 0;
      this.point.y = WHEEL_CENTRE_Y + heave - SPRUNG_CM_OFFSET.y;
      body.addForceAtBodyPoint(this.force, this.point);
    }
  }

  private hullForces(): void {
    const body = this.body;
    const plane = this.probePlane;
    const colliders = this.environment?.colliders ?? null;
    let scrape = 0;
    let upperTouch = false;
    for (let i = 0; i < HULL.length; i += 1) {
      const probe = HULL[i]!;
      const groundActive = this.probeActive[i] === 1;
      if (!groundActive && !this.collidersNear) {
        this.probeTouching[i] = 0;
        continue;
      }
      const c = this.probeWorld(probe, this.centreWorld);
      let touching = false;
      if (groundActive) {
        const o = i * 6;
        const nx = plane[o + 3]!;
        const ny = plane[o + 4]!;
        const nz = plane[o + 5]!;
        const penetration = probe.radius - ((c.x - plane[o]!) * nx + (c.y - plane[o + 1]!) * ny + (c.z - plane[o + 2]!) * nz);
        if (penetration > 0) {
          touching = true;
          this.normalScratch.x = nx;
          this.normalScratch.y = ny;
          this.normalScratch.z = nz;
          this.hullPenetration = penetration;
          this.applyHullContact(probe, c, this.normalScratch, null, HULL_GROUND, false, false);
          scrape = Math.max(scrape, this.hullResult);
          if (probe.upperBody) upperTouch = true;
        }
      }
      if (this.collidersNear && colliders) {
        const contact = this.colliderContact;
        if (colliders.deepestSphereContact(c, probe.radius, contact) && contact.penetration > 0) {
          // 2 touching a collider, 3 past its law's wreck depth too.
          const was = this.probeTouching[i]!;
          const law = contact.material === CAR_COLLIDER_MATERIAL.guardrail ? HULL_GUARDRAIL : HULL_COLLIDER;
          const penetration = Math.min(contact.penetration, probe.radius + law.reach);
          const deep = penetration > law.wreckDepth;
          this.hullPenetration = penetration;
          this.applyHullContact(probe, c, contact.normal, contact.pointVelocity, law, was < 2, deep && was !== 3);
          scrape = Math.max(scrape, Math.min(1, this.hullResult));
          this.probeTouching[i] = deep ? 3 : 2;
          continue;
        }
      }
      this.probeTouching[i] = touching ? 1 : 0;
    }
    this.scrapePeak = Math.max(this.scrapePeak, scrape);
    if (upperTouch) {
      const v = body.velocity;
      if (!this.rolled && Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) > CRASH_ROLL_SPEED) this.state.crashed = true;
      this.rolled = true;
    }
  }

  /**
   * One probe's contact force at `hullPenetration`: a damped spring along
   * the normal and sliding friction across it, by `law`. Leaves in
   * `hullResult` the scrape (0..1, from the sliding speed), or for a
   * collider's first touch the closing speed over the crash speed. With
   * `wreckCheck` a closing speed over the crash speed wrecks the car.
   */
  private applyHullContact(
    probe: HullProbeRecord,
    centre: Vec3,
    normal: Readonly<Vec3>,
    surfaceVelocity: Readonly<Vec3> | null,
    law: HullContactLaw,
    firstTouch: boolean,
    wreckCheck: boolean,
  ): void {
    const penetration = this.hullPenetration;
    const stiffness = law.stiffness;
    const damping = law.damping;
    const friction = law.friction;
    const body = this.body;
    const v = body.pointVelocity(centre, this.velocityWorld);
    if (probe.axle >= 0) {
      this.v0.x = 0;
      this.v0.y = this.axleHeaveRate[probe.axle]!;
      this.v0.z = 0;
      body.bodyToWorldVector(this.v0, this.v1);
      v.x += this.v1.x;
      v.y += this.v1.y;
      v.z += this.v1.z;
    }
    if (surfaceVelocity) {
      v.x -= surfaceVelocity.x;
      v.y -= surfaceVelocity.y;
      v.z -= surfaceVelocity.z;
    }
    const vn = v.x * normal.x + v.y * normal.y + v.z * normal.z;
    if (wreckCheck && -vn > CRASH_IMPACT_SPEED) this.state.crashed = true;
    let spring = stiffness * penetration;
    let resist = damping;
    if (penetration > law.stop) {
      spring += law.stopStiffness * (penetration - law.stop);
      resist += law.stopDamping;
    }
    // Coming back out, blended in over the first 0.2 m/s so a resting contact does not chatter.
    if (vn > 0 && law.rebound < 1) spring *= 1 - (1 - law.rebound) * Math.min(1, vn / 0.2);
    let push = spring - resist * vn;
    if (push < 0) push = 0;
    const tx = v.x - vn * normal.x;
    const ty = v.y - vn * normal.y;
    const tz = v.z - vn * normal.z;
    const slide = Math.sqrt(tx * tx + ty * ty + tz * tz);
    // Regularised Coulomb: viscous below 0.2 m/s so a resting hull does not chatter.
    const drag = slide > 1e-6 ? (friction * push * Math.min(1, slide / 0.2)) / slide : 0;
    const f = this.force;
    f.x = push * normal.x - drag * tx;
    f.y = push * normal.y - drag * ty;
    f.z = push * normal.z - drag * tz;
    // The contact point on the sphere, towards the surface.
    const p = this.contactPoint;
    p.x = centre.x - probe.radius * normal.x;
    p.y = centre.y - probe.radius * normal.y;
    p.z = centre.z - probe.radius * normal.z;
    if (probe.axle >= 0) this.routeAxleForce(probe.axle, f, p, false);
    else body.addForceAtWorldPoint(f, p);
    this.hullResult = firstTouch ? -vn / CRASH_IMPACT_SPEED : Math.min(1, slide / 3);
  }

  private aeroForces(): void {
    const body = this.body;
    const env = this.environment;
    const wind = env?.wind;
    const rel = this.v1;
    rel.x = body.velocity.x - (wind?.x ?? 0);
    rel.y = body.velocity.y - (wind?.y ?? 0);
    rel.z = body.velocity.z - (wind?.z ?? 0);
    const vb = body.worldToBodyVector(rel, this.v2);
    const speed = Math.sqrt(vb.x * vb.x + vb.y * vb.y + vb.z * vb.z);
    if (speed < 0.5) return;
    const rho = AIR_DENSITY * Math.exp(-Math.max(0, body.position.y) / 8_500);
    const q = 0.5 * rho * speed;
    const aero = CAR.aero;
    this.force.x = -q * aero.dragArea * vb.x;
    this.force.y = 0.5 * rho * aero.liftArea * vb.x * vb.x - q * aero.dragArea * 0.5 * vb.y;
    this.force.z = -q * aero.sideArea * vb.z;
    this.point.x = aero.pressureX - SPRUNG_CM_OFFSET.x;
    this.point.y = aero.pressureY - SPRUNG_CM_OFFSET.y;
    this.point.z = -SPRUNG_CM_OFFSET.z;
    body.addForceAtBodyPoint(this.force, this.point);
  }

  // ---------------------------------------------------------------- driveline

  private drivelineStep(): void {
    const h = this.h;
    const t = this.transmission;
    const solver = this.driveline;
    const omega = solver.omega;
    const torque = this.torque;
    const finalDrive = t.finalDrive;
    const half = finalDrive / 2;
    const gearRatio = t.inputRatio;
    const inputRatio = gearRatio * half;
    const inGear = gearRatio !== 0;
    const lines = CAR.driveline;
    const rearShared = (lines.rearPropInertia + (inGear ? t.inputInertia * gearRatio * gearRatio : 0)) * half * half;
    const frontShared = lines.frontPropInertia * half * half;
    solver.frontShared = frontShared;
    solver.rearShared = rearShared;
    solver.updateInertia();

    const engineOmega = omega[ENGINE]!;
    const rearProp = half * (omega[3]! + omega[4]!);
    const frontProp = half * (omega[1]! + omega[2]!);
    const inputOmega = gearRatio * rearProp;
    const engine = this.engine;
    engine.omega = engineOmega;
    engine.pedal = this.pedals.accelerator;
    engine.evaluate();
    let engineTorque = engine.netTorque;
    if (t.converterEngaged) {
      this.converter.pumpOmega = engineOmega;
      this.converter.turbineOmega = inputOmega;
      converterTorques(this.converter);
      engineTorque -= this.converter.pump;
      const turbine = this.converter.turbine * t.torqueShare;
      torque[3] = torque[3]! + turbine * inputRatio;
      torque[4] = torque[4]! + turbine * inputRatio;
    }
    torque[ENGINE] = engineTorque;
    // Losses at each propeller shaft.
    const rearLoss = lines.propViscousLoss * rearProp + lines.propCoulombLoss * Math.tanh(rearProp / 2);
    torque[3] = torque[3]! - rearLoss * half;
    torque[4] = torque[4]! - rearLoss * half;
    const frontLoss = lines.propViscousLoss * frontProp + lines.propCoulombLoss * Math.tanh(frontProp / 2);
    torque[1] = torque[1]! - frontLoss * half;
    torque[2] = torque[2]! - frontLoss * half;

    // The rows: Jacobian entries at row * DRIVELINE_DOF in DOF order (engine, FL, FR, RL, RR).
    solver.beginRows();
    const j = solver.jacobian;
    let couplingRow = -1;
    const capacity = t.couplingCapacity;
    if (inGear && capacity > 0) {
      // The clutch or lockup: engine against the transmission input.
      couplingRow = solver.openRow();
      const o = couplingRow * DRIVELINE_DOF;
      j[o] = 1;
      j[o + 3] = -inputRatio;
      j[o + 4] = -inputRatio;
      solver.lower[couplingRow] = -capacity * h;
      solver.upper[couplingRow] = capacity * h;
    }
    const hold = (t.parked ? CAR.automatic.parkTorque : 0) + CAR.brakes.handbrakeTorque * this.handbrake;
    if (hold > 0) {
      // The pawl and the transmission drum, on the rear propeller shaft.
      const row = solver.openRow();
      j[row * DRIVELINE_DOF + 3] = half;
      j[row * DRIVELINE_DOF + 4] = half;
      solver.lower[row] = -hold * h;
      solver.upper[row] = hold * h;
    }
    const pedal = this.pedals.brake;
    for (let w = 0; w < 4; w += 1) {
      const spec = AXLES[WHEEL_AXLE[w]!]!;
      const brake = spec.brakeTorque * pedal * this.absFactor[w]! + this.tcTorque[w]!;
      if (brake <= 0) continue;
      const row = solver.openRow();
      j[row * DRIVELINE_DOF + w + 1] = 1;
      solver.lower[row] = -brake * h;
      solver.upper[row] = brake * h;
    }
    if (t.locks !== "off") {
      const row = solver.openRow();
      j[row * DRIVELINE_DOF + 3] = 1;
      j[row * DRIVELINE_DOF + 4] = -1;
      solver.lower[row] = -1e5 * h;
      solver.upper[row] = 1e5 * h;
    }
    if (t.locks === "both") {
      const row = solver.openRow();
      j[row * DRIVELINE_DOF + 1] = 1;
      j[row * DRIVELINE_DOF + 2] = -1;
      solver.lower[row] = -1e5 * h;
      solver.upper[row] = 1e5 * h;
    }
    if (t.fourWheelDrive) {
      // Catto's soft constraint for the windup spring between the shafts.
      const k = lines.windupStiffness;
      const c = lines.windupDamping;
      const row = solver.openRow();
      const o = row * DRIVELINE_DOF;
      j[o + 1] = -half;
      j[o + 2] = -half;
      j[o + 3] = half;
      j[o + 4] = half;
      solver.bias[row] = (-k * this.windup) / (c + h * k);
      solver.softness[row] = 1 / (h * (c + h * k));
    }
    solver.solve(torque);
    // The torque the gearbox input takes from the engine side: the clutch's (its row pushes the
    // engine with the impulse, the input with minus it) and the converter's turbine.
    this.lastCouplingTorque = (couplingRow >= 0 ? -solver.impulse[couplingRow]! / h : 0)
      + (t.converterEngaged ? this.converter.turbine * t.torqueShare : 0);
    // A stalled crank does not turn backwards.
    if (!this.engine.running && omega[ENGINE]! < 0) omega[ENGINE] = 0;
    if (t.fourWheelDrive) {
      this.windup += h * half * (omega[3]! + omega[4]! - omega[1]! - omega[2]!);
    } else {
      this.windup = 0;
    }
    for (let i = 0; i < DRIVELINE_DOF; i += 1) torque[i] = 0;
  }

  private integrateAxles(): void {
    const h = this.h;
    const body = this.body;
    const alpha = body.angularAcceleration;
    const omega = body.angularVelocity;
    // The frame's acceleration in its own frame (one substep late).
    const acceleration = body.worldToBodyVector(body.linearAcceleration, this.v1);
    const g = this.gravityBody;
    for (let a = 0; a < 2; a += 1) {
      const spec = AXLES[a]!;
      const mass = spec.suspension.unsprungMass;
      // Acceleration of the frame point at the axle: a + alpha x r + w x (w x r), r from the sprung CM.
      const rx = spec.x - SPRUNG_CM_OFFSET.x;
      const ry = WHEEL_CENTRE_Y + this.axleHeave[a]! - SPRUNG_CM_OFFSET.y;
      const rz = -SPRUNG_CM_OFFSET.z;
      const wx = omega.y * rz - omega.z * ry;
      const wy = omega.z * rx - omega.x * rz;
      const wz = omega.x * ry - omega.y * rx;
      const p = this.axleAcceleration;
      p.x = acceleration.x + (alpha.y * rz - alpha.z * ry) + (omega.y * wz - omega.z * wy);
      p.y = acceleration.y + (alpha.z * rx - alpha.x * rz) + (omega.z * wx - omega.x * wz);
      p.z = acceleration.z + (alpha.x * ry - alpha.y * rx) + (omega.x * wy - omega.y * wx);
      // Heave and roll against the frame.
      const heaveAcceleration = (this.axleForce[a]! + mass * g.y) / mass - p.y;
      const rollAcceleration = this.axleMoment[a]! / spec.suspension.rollInertia + alpha.x;
      this.axleHeaveRate[a] = this.axleHeaveRate[a]! + h * heaveAcceleration;
      this.axleRollRate[a] = this.axleRollRate[a]! + h * rollAcceleration;
      this.axleHeave[a] = this.axleHeave[a]! + h * this.axleHeaveRate[a]!;
      this.axleRoll[a] = this.axleRoll[a]! + h * this.axleRollRate[a]!;
      // The axle's weight and inertia in the frame's plane act on the frame at the axle.
      this.force.x = mass * (g.x - p.x);
      this.force.y = 0;
      this.force.z = mass * (g.z - p.z);
      this.point.x = rx;
      this.point.y = ry;
      this.point.z = rz;
      body.addForceAtBodyPoint(this.force, this.point);
    }
  }

  // ---------------------------------------------------------------- after the step

  private afterStep(): void {
    const dt = this.dt;
    const omega = this.driveline.omega;
    for (let w = 0; w < 4; w += 1) {
      const angle = this.wheelSpin[w]! + omega[w + 1]! * dt;
      this.wheelSpin[w] = ((angle % TAU) + TAU) % TAU;
    }
    if (this.rolled) {
      // Back on its wheels: all four loaded and the roof up.
      const up = rotateVectorInto(this.v3, this.body.orientation, BODY_UP);
      let loaded = 0;
      for (let w = 0; w < 4; w += 1) if (this.wheelLoad[w]! > WHEEL_DOWN_LOAD) loaded += 1;
      if (up.y > 0.8 && loaded === 4) this.rolled = false;
    }
  }

  private syncState(): void {
    const body = this.body;
    const s = this.state;
    rotateVectorInto(this.v0, body.orientation, SPRUNG_CM_OFFSET);
    s.position.x = body.position.x - this.v0.x;
    s.position.y = body.position.y - this.v0.y;
    s.position.z = body.position.z - this.v0.z;
    // The origin's velocity: v_cm + w x (origin - cm).
    body.angularVelocityWorld(this.v1);
    const rx = -this.v0.x;
    const ry = -this.v0.y;
    const rz = -this.v0.z;
    s.velocity.x = body.velocity.x + (this.v1.y * rz - this.v1.z * ry);
    s.velocity.y = body.velocity.y + (this.v1.z * rx - this.v1.x * rz);
    s.velocity.z = body.velocity.z + (this.v1.x * ry - this.v1.y * rx);
    s.orientation.x = body.orientation.x;
    s.orientation.y = body.orientation.y;
    s.orientation.z = body.orientation.z;
    s.orientation.w = body.orientation.w;
    s.angularVelocity.x = body.angularVelocity.x;
    s.angularVelocity.y = body.angularVelocity.y;
    s.angularVelocity.z = body.angularVelocity.z;
  }

  // ---------------------------------------------------------------- outputs

  /** Whether any probe of the named hull part (`LANDCRUISER_76.hull`) touched something in the last substep. */
  touching(part: string): boolean {
    for (let i = 0; i < HULL.length; i += 1) if (HULL[i]!.part === part && this.probeTouching[i] !== 0) return true;
    return false;
  }

  /** How many safe spots the recovery holds (for tests and probes). */
  get safeSpotsHeld(): number {
    return this.safeSpotCount;
  }

  /** Whether any tyre carries load. */
  get onGround(): boolean {
    for (let w = 0; w < 4; w += 1) if (this.wheelLoad[w]! > 0) return true;
    return false;
  }

  /** Engine speed, rpm. */
  get engineRpm(): number {
    return Math.max(0, this.driveline.omega[ENGINE]! * RPM_PER_RAD_S);
  }

  snapshot(): SurfaceVehicleSnapshot & { payload: CarVisualState } {
    const payload = this.visualState();
    return {
      time: this.state.time,
      position: { ...this.state.position },
      velocity: { ...this.state.velocity },
      orientation: { ...this.state.orientation },
      angularVelocity: { ...this.state.angularVelocity },
      throttle: this.engine.running ? clamp(this.engine.load, 0, 1) : 0,
      engineRpm: this.engineRpm,
      onGround: this.onGround,
      crashed: this.state.crashed,
      payload,
    };
  }

  visualState(): CarVisualState {
    const t = this.transmission;
    const state: CarVisualState = {
      kind: "car",
      speed: this.forwardSpeed(),
      gearbox: t.gearbox,
      selector: null,
      gear: 0,
      range: "2H",
      locks: "off",
      downhillAssist: this.downhillAssist,
      downhillAssistActive: this.downhillAssistActive,
      tractionControlActive: this.tractionControlActive,
      absActive: this.absActive,
      clutch: 0,
      engineRunning: this.engine.running,
      stalled: this.engine.stalled && !this.engine.flooded,
      flooded: this.engine.flooded,
      rolled: this.rolled,
      boost: this.engine.boost,
      headlights: this.headlights,
      brakeLights: this.pedals.brake > 0.02 || this.handbrake > 0.02,
      reversing: t.gear < 0,
      tyrePressure: this.controls.tyrePressure,
      tyrePressureBar: this.tyrePressureBar,
      wadingDepth: this.wadingDepthValue,
      settling: this.settling,
      wheelSteer: [this.steering.left, this.steering.right, 0, 0],
      wheelSpin: Array.from(this.wheelSpin),
      wheelSpinRate: [this.driveline.omega[1]!, this.driveline.omega[2]!, this.driveline.omega[3]!, this.driveline.omega[4]!],
      wheelLoad: Array.from(this.wheelLoad),
      wheelSlip: Array.from(this.wheelSlip),
      wheelSinkage: CAR_WHEELS.map((_, w) =>
        (this.wheelLoad[w]! > 0 && this.wheelSurface[w]!.soft
          ? Math.min(this.wheelSurface[w]!.maxSinkage, this.wheelSinkage[w]! + this.wheelRut[w]!)
          : 0)),
      wheelSurface: CAR_WHEELS.map((_, w) =>
        (this.wheelLoad[w]! > 0 && this.wheelSubmerged[w] !== 1 ? this.wheelSurface[w]!.material : -1)),
      wheelWetness: CAR_WHEELS.map((_, w) =>
        (this.wheelSubmerged[w] === 1 ? 1 : this.wheelLoad[w]! > 0 ? this.wheelWet[w]! : 0)),
      axleHeave: Array.from(this.axleHeave),
      axleRoll: Array.from(this.axleRoll),
      steeringWheel: this.steering.wheelAngle,
      bumpStop: this.bumpStopPeak,
      scrape: this.scrapePeak,
      splash: this.splashPeak,
    };
    t.fill(state);
    this.bumpStopPeak = 0;
    this.scrapePeak = 0;
    this.splashPeak = 0;
    return state;
  }
}

function finite01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}
