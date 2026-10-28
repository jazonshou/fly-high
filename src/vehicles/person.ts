import type { CinematicOrbitSpec, TopFrontViewSpec } from "@/src/aircraft/catalogue";
import type { ColliderBox } from "@/src/sim/colliders";

/**
 * The walker (the walking plan, 2026-10-27, and Jason's answers D1-D6): one
 * adult figure, 1.76 m tall, who lives in a car session and gets in and out
 * of the LandCruiser. It is not a `VehicleKind`: the picker never lists it,
 * and every seam that branches on a vehicle's class reads the person from
 * `FlightVisualState.walking` and the `"person"` payload instead.
 *
 * Numbers marked PUBLISHED rest on measurements; ESTIMATE ones are starting
 * values for the build to fit and check (the plan's speed chart).
 */
export interface PersonSpec {
  /** Standing height H, metres. */
  readonly stature: number;
  /** The collision capsule: radius, and its height from the feet (the stature). */
  readonly capsuleRadius: number;
  /** Eye above the feet, metres (0.936 H, the first-person view). */
  readonly eyeHeight: number;
  /** Ledges the feet step up without a jump, and drops they follow down while walking, metres. */
  readonly stepUp: number;
  readonly snapDown: number;
  /** Speeds on flat ground, m/s. */
  readonly walkSpeed: number;
  /** Where the gait changes from walking to running, m/s. */
  readonly walkRunSpeed: number;
  readonly runSpeed: number;
  /** The standing jump: the centre of mass rises this far, metres. */
  readonly jumpHeight: number;
  /** Share of full ground control kept in the air. */
  readonly airControl: number;
  /** Turn rate toward the move direction, rad/s, walking and running. */
  readonly turnRateWalk: number;
  readonly turnRateRun: number;
  /** Water depth as a share of the stature where wading and swimming begin. */
  readonly wadeDepthFraction: number;
  readonly swimDepthFraction: number;
  /** Surface swimming, breaststroke and crawl, m/s. */
  readonly swimSpeed: number;
  readonly swimFastSpeed: number;
  /** Under water, m/s. */
  readonly diveSpeed: number;
  readonly diveFastSpeed: number;
  /** With no input under water the body drifts up at this rate, m/s. */
  readonly buoyantRise: number;
  /** Ledges a swimmer can mantle onto: height above the water and reach, metres. */
  readonly mantleHeight: number;
  readonly mantleReach: number;
  /** Seconds a mantle takes, from the water to standing on the ledge. */
  readonly mantleSeconds: number;
  /**
   * Landings (never damage: D5): from `landingHardSpeed` m/s a hard landing,
   * a crouch of `landingHardSeconds`; from `landingRollSpeed` a roll of
   * `landingRollSeconds`. Neither can move until it is over.
   */
  readonly landingHardSpeed: number;
  readonly landingRollSpeed: number;
  readonly landingHardSeconds: number;
  readonly landingRollSeconds: number;
  /** Turn rate toward the stroke direction swimming and diving, rad/s. */
  readonly turnRateSwim: number;
  /** Getting in: within this distance of the door, with the car slower than `boardingCarSpeed`. */
  readonly doorReach: number;
  readonly boardingCarSpeed: number;
  /** Seconds to get in and to get out, and how long X is held to get out. */
  readonly getInSeconds: number;
  readonly getOutSeconds: number;
  readonly getOutHoldSeconds: number;
  /** Water deeper than this at a door blocks getting out on that side, metres. */
  readonly doorBlockedWaterDepth: number;
  /** The "character" follow law: orbit about a pivot at the neck. */
  readonly camera: PersonCameraSpec;
  readonly cinematic: CinematicOrbitSpec;
  readonly topFront: TopFrontViewSpec;
}

export interface PersonCameraSpec {
  /** Pivot above the feet, metres, and its offset to the right shoulder. */
  readonly pivotHeight: number;
  readonly shoulderOffset: number;
  /** Boom length, metres: the default, the wheel's range, and the cap indoors. */
  readonly distance: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly indoorMaxDistance: number;
  /** Look pitch limits, radians, positive up. */
  readonly minPitch: number;
  readonly maxPitch: number;
  /** The probe sphere cast from the pivot, and how long the boom takes to ease back out, seconds. */
  readonly probeRadius: number;
  readonly easeOutSeconds: number;
  /** The figure fades when the camera is closer than this, metres. */
  readonly fadeDistance: number;
  readonly fieldOfView: number;
}

const DEGREES = Math.PI / 180;
const STATURE = 1.76;

/**
 * Walk 1.4 m/s is the preferred adult walking speed (PUBLISHED: Bohannon &
 * Andrews 2011, 1.3-1.4 m/s), which is also Tobler's flat 5.04 km/h. The
 * walk-run switch at 2.0 m/s is the measured preferred transition speed
 * (PUBLISHED: Thorstensson & Roberthson 1987, Hreljac 1993), a Froude number
 * v^2 / (g L) of 0.44 with leg length L = 0.53 H, under the 0.5 where
 * walking stops being mechanically possible (Alexander 1989). Run, swimming,
 * diving and wading speeds are ESTIMATES. The landing speeds are the plan's
 * equal drops v^2 / 2g: under 1.3 m normal, to 3.3 m a crouch, past it a
 * roll; the mantle's and the landings' durations and the swimming turn rate
 * are ESTIMATES for the figure's motions to fit. The camera numbers are
 * starting values for the framing test on the built figure.
 */
export const PERSON: PersonSpec = Object.freeze({
  stature: STATURE,
  capsuleRadius: 0.3,
  eyeHeight: 0.936 * STATURE,
  stepUp: 0.4,
  snapDown: 0.45,
  walkSpeed: 1.4,
  walkRunSpeed: 2.0,
  runSpeed: 4.5,
  jumpHeight: 0.45,
  airControl: 0.2,
  turnRateWalk: 540 * DEGREES,
  turnRateRun: 270 * DEGREES,
  wadeDepthFraction: 0.15,
  swimDepthFraction: 0.75,
  swimSpeed: 0.8,
  swimFastSpeed: 1.3,
  diveSpeed: 0.9,
  diveFastSpeed: 1.4,
  buoyantRise: 0.1,
  mantleHeight: 0.6,
  mantleReach: 0.7,
  mantleSeconds: 1.0,
  landingHardSpeed: 5,
  landingRollSpeed: 8,
  landingHardSeconds: 0.4,
  landingRollSeconds: 1.1,
  turnRateSwim: 180 * DEGREES,
  doorReach: 1.2,
  boardingCarSpeed: 0.5,
  getInSeconds: 2.0,
  getOutSeconds: 1.6,
  getOutHoldSeconds: 0.4,
  doorBlockedWaterDepth: 1.0,
  camera: Object.freeze({
    pivotHeight: 1.55,
    shoulderOffset: 0.35,
    distance: 3.2,
    minDistance: 1.6,
    maxDistance: 6,
    indoorMaxDistance: 2,
    minPitch: -60 * DEGREES,
    maxPitch: 70 * DEGREES,
    probeRadius: 0.2,
    easeOutSeconds: 0.3,
    fadeDistance: 0.5,
    fieldOfView: 60,
  }),
  // Body box: feet at 0, head at 1.76 m, about 0.5 m deep. Aim at mid-height
  // and fill about 60% of the frame, as the vehicles do; measured again on
  // the built figure in render.top-front-views.
  cinematic: Object.freeze({ radiusMeters: 4.5, heightMeters: 1.4, heightDriftMeters: 0.4 }),
  topFront: Object.freeze({ centreForward: 0, centreUp: 0.88, topDistanceMeters: 4.2, frontDistanceMeters: 4.6 }),
});

/** Jump take-off speed for `PERSON.jumpHeight`, m/s (2.97 m/s at 0.45 m). */
export function personJumpSpeed(gravity = 9.80665, spec: PersonSpec = PERSON): number {
  return Math.sqrt(2 * gravity * spec.jumpHeight);
}

/**
 * Tobler's hiking function as a factor on the flat speed (1 on flat ground):
 * v = 6 exp(-3.5 |tan(theta) + 0.05|) km/h, divided by its flat value. A
 * gentle descent (5%) is fastest, about 1.19; `slope` is rise over run along
 * the direction of travel, positive uphill.
 */
export function toblerFactor(slope: number): number {
  return Math.exp(-3.5 * (Math.abs(slope + 0.05) - 0.05));
}

/** A point in a vehicle's body frame, metres from its centre of gravity: +X forward, +Y up, +Z right. */
export interface BodyPoint {
  readonly forward: number;
  readonly up: number;
  readonly right: number;
}

/**
 * Where the walker meets the LandCruiser 76 (right-hand drive): the driver's
 * hip point, the standing spot outside each front door (mirrored in `right`
 * for the left door), and the body as one box the walker walks round while
 * the car is parked. Body frame from the car's centre of gravity, which
 * stands 0.80 m above flat ground at kerb ride. The box runs from the tow
 * hitch (2.72 m aft) to the front bumper (2.19 m ahead), 1.87 m wide, from
 * 0.30 m above the ground to the roof at 1.94 m (the published body).
 * The hip point is ESTIMATED from the drawn cockpit eye; the figure build
 * measures it on the drawn seat. The door stand's `up` is not read: the
 * walker stands on the ground at its `forward` and `right`.
 */
export const CAR_SEATING = Object.freeze({
  cgAboveGround: 0.8,
  driverHip: Object.freeze({ forward: -0.5, up: 0.15, right: 0.4 }) as BodyPoint,
  doorStand: Object.freeze({ forward: -0.25, up: 0, right: 1.4 }) as BodyPoint,
  bodyBox: Object.freeze({
    kind: "box",
    center: Object.freeze({ x: -0.265, y: 0.32, z: 0 }),
    halfExtents: Object.freeze({ x: 2.455, y: 0.82, z: 0.935 }),
  }) as ColliderBox,
});
