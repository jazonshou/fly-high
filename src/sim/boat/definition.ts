import { RUNABOUT_21_OUTBOARD } from "@/src/vehicles/boat/hullLines";
import type { RigidBodyInertia } from "../rigidBody";

/**
 * Everything the boat physics needs that is not the hull's shape (the shape is
 * `src/vehicles/boat/hullLines.ts`): mass, propeller, engine, gearcase, tabs,
 * the gearcase fin and the topsides' windage. One record per boat, so a
 * second boat is data. Every number cites what it was taken from; the ones
 * that are fitted rather than read are in `BOAT_CALIBRATION`, which the tests
 * pin.
 */
export interface BoatDefinition {
  readonly name: string;
  /** As driven: hull, engine, fuel, two people. kg. */
  readonly mass: number;
  /** Body-frame inertia about the CG, kg m^2 (x roll, y yaw, z pitch). */
  readonly inertia: RigidBodyInertia;
  readonly propeller: PropellerDefinition;
  readonly engine: EngineDefinition;
  readonly tabs: TrimTabDefinition;
  readonly gearcase: GearcaseDefinition;
  readonly windage: WindageDefinition;
  /** Hydraulic steering: engine degrees per second at the wheel's fastest, and the lock either way. */
  readonly steerRateDegrees: number;
  readonly steerLockDegrees: number;
  /** Power trim: engine degrees per second, in or out, and its range (in is negative). */
  readonly trimRateDegrees: number;
  readonly trimMinDegrees: number;
  readonly trimMaxDegrees: number;
}

export interface PropellerDefinition {
  /** Diameter and face pitch, metres. 14.5 x 19 in. */
  readonly diameter: number;
  readonly pitch: number;
  readonly blades: number;
  /** Expanded blade area over disc area. */
  readonly expandedAreaRatio: number;
  /** Gearcase reduction, crank to propeller. */
  readonly gearRatio: number;
  /** Mechanical efficiency of the gearcase. */
  readonly gearEfficiency: number;
  /** Rotating inertia at the propeller shaft (blades and hub, entrained water), kg m^2. */
  readonly inertia: number;
}

export interface EngineDefinition {
  readonly idleRpm: number;
  /** Fuel cut. */
  readonly limiterRpm: number;
  /** Full-throttle brake torque, N m, against crank rpm (strictly increasing rpm). */
  readonly fullThrottleTorque: readonly (readonly [rpm: number, torque: number])[];
  /** Crank, flywheel and alternator inertia, kg m^2. */
  readonly crankInertia: number;
  /** Lever travel either side of neutral that only engages the gear (the shift detent). */
  readonly shiftTravel: number;
  /** Gears change only below this crank rpm. */
  readonly shiftMaxRpm: number;
  /** Throttle at the lever's full astern stop: binnacle controls open the throttle less going astern. */
  readonly reverseThrottleMax: number;
}

export interface TrimTabDefinition {
  /** Span and chord of each of the two tabs, metres. 12 x 9 in. */
  readonly span: number;
  readonly chord: number;
  /** Half-breadth of each tab's centre. */
  readonly centreHalfBeam: number;
  readonly maxDegrees: number;
  /** Fraction of full travel per second. */
  readonly rate: number;
}

export interface GearcaseDefinition {
  /** Lateral (projected side) area of the gearcase and skeg below the plate, m^2. */
  readonly finArea: number;
  /** Lift slope of that low-aspect fin, per radian. */
  readonly liftSlope: number;
  /** Drag area (C_D times frontal area) of the immersed leg, m^2. */
  readonly dragArea: number;
}

export interface WindageDefinition {
  /** Drag coefficient times area, m^2, along body x (head-on), y and z (beam-on). */
  readonly dragAreaX: number;
  readonly dragAreaY: number;
  readonly dragAreaZ: number;
  /** Centre of effort, hull frame. */
  readonly centre: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * The Runabout 21 (decision D3): a generic 21 ft deep-V bowrider with one
 * 200 hp V6 four-stroke outboard.
 *
 * - Mass 1,800 kg as driven: the class's 1,450-1,600 kg dry hull and engine
 *   plus fuel and two people (the two published trials ran 1,798 and 1,898 kg).
 * - Inertia from gyradii of 0.37 beam in roll and 0.26 length in pitch and
 *   yaw (Lewandowski, *The Dynamics of Marine Craft*, small-craft values), the
 *   heavy engine on the transom pushing pitch and yaw toward the top of the range.
 * - Propeller: 3-blade stainless 14.5 x 19 in on a 1.85:1 gearcase, the
 *   factory fit for a 200 hp V6 on a 21 ft hull; expanded area ratio 0.6,
 *   the high-speed outboard pattern's.
 * - Engine: a 200 hp V6 four-stroke's published curve, 149 kW at 5,500 rpm,
 *   full-throttle range 5,000-6,000, 700 rpm idle, fuel cut at 6,000.
 * - Tabs: two 12 x 9 in, 0-12 degrees, about 5 s full travel.
 */
export const RUNABOUT_21: BoatDefinition = Object.freeze({
  name: "Runabout 21",
  mass: 1_800,
  inertia: Object.freeze({ xx: 1_650, yy: 5_300, zz: 5_100 }),
  propeller: Object.freeze({
    diameter: 0.368,
    pitch: 0.4826,
    blades: 3,
    expandedAreaRatio: 0.6,
    gearRatio: 1.85,
    gearEfficiency: 0.95,
    inertia: 0.04,
  }),
  engine: Object.freeze({
    idleRpm: 700,
    limiterRpm: 6_000,
    fullThrottleTorque: Object.freeze([
      [500, 120],
      [700, 160],
      [1_500, 215],
      [2_500, 250],
      [3_500, 272],
      [4_500, 280],
      [5_000, 275],
      [5_500, 259],
      [6_000, 230],
      [6_500, 190],
    ] as const),
    crankInertia: 0.14,
    shiftTravel: 0.15,
    shiftMaxRpm: 1_000,
    reverseThrottleMax: 0.5,
  }),
  tabs: Object.freeze({ span: 0.305, chord: 0.229, centreHalfBeam: 0.75, maxDegrees: 12, rate: 0.2 }),
  gearcase: Object.freeze({ finArea: 0.12, liftSlope: 3.6, dragArea: 0.0032 }),
  windage: Object.freeze({
    // Head-on: 2.4 m^2 of bow, screen and people at C_D 0.55. Beam-on: 5.6 m^2
    // of topsides and screen at 0.85. Plan: the deck, for gusts from above.
    dragAreaX: 1.3,
    dragAreaY: 3.5,
    dragAreaZ: 4.8,
    // Forward of the CG and above it: the bowrider's high bow and screen.
    centre: Object.freeze({ x: 2.4, y: 1.05, z: 0 }),
  }),
  steerRateDegrees: 70,
  steerLockDegrees: RUNABOUT_21_OUTBOARD.steerLockDegrees,
  trimRateDegrees: 4.5,
  trimMinDegrees: RUNABOUT_21_OUTBOARD.trimMinDegrees,
  trimMaxDegrees: RUNABOUT_21_OUTBOARD.trimMaxDegrees,
});

/**
 * The fitted constants of the boat model, each with what it stands for and
 * where its form comes from (docs/BOAT_MODEL.md has the derivations).
 * `tests/sim.boat-performance.test.ts` pins this whole record, so a retune
 * is a visible change to the numbers and the tables, never a silent one.
 */
export const BOAT_CALIBRATION = Object.freeze({
  /** Zarnick's 3D correction on the 2D wedge added mass, rho * pi/2 * c^2. */
  addedMassFactor: 1.0,
  /** Zarnick's cross-flow drag coefficient on the wetted beam. */
  crossFlowDrag: 1.0,
  /**
   * Garme's near-transom pressure release: sectional force scaled by
   * tanh(distance forward of the transom / (this * chine beam)) once the
   * transom runs dry. Garme (2005) fits 2.5 x C_V in a tanh; we hold a
   * speed-independent length.
   */
  transomReleaseBeams: 0.65,
  /** Sway added mass of a section, as a share of rho * pi/2 * draft^2 (the mirrored plate). */
  lateralAddedMass: 0.8,
  /** Sway cross-flow drag coefficient on the section's draft. */
  lateralCrossFlowDrag: 1.0,
  /** How much a panel's sideslip adds to its penetration (1 = the panel's geometry). */
  sideslipLift: 1.0,
  /**
   * Pre-planing hump: the wave-making and transom-immersion resistance the
   * strips and the clipped mesh leave out. Peak drag over displacement
   * weight, the length Froude number of the peak, and how sharply it rises
   * and falls about it: shape = exp(s (ln r + 1 - r)), r = Fn / humpFroude.
   */
  humpDrag: 0.09,
  humpFroude: 0.57,
  humpSharpness: 18,
  /** Its bow-up moment over displacement weight times waterline length. */
  humpMoment: 0.012,
  /** Going astern, the drag coefficient of the immersed transom face (Hoerner: 1.17 for a plate square to the flow, less at the surface). */
  transomAsternDrag: 1.0,
  /** ITTC-57 roughness allowance on C_F. */
  roughnessAllowance: 0.0004,
  /** Wake fraction and thrust deduction at the outboard's propeller. */
  wakeFraction: 0.04,
  thrustDeduction: 0.05,
  /**
   * K_T(J) = kt0 + kt1 J + kt2 J^2 and 10 K_Q(J) likewise: a high-pitch
   * 3-blade outboard propeller, peak open-water efficiency 0.69 near J = 0.95,
   * zero thrust at J = 1.28, 15% apparent slip at the 41 kn top speed.
   */
  kt: Object.freeze([0.48, -0.3004, -0.0583] as const),
  kq10: Object.freeze([0.85, -0.5382, -0.0331] as const),
  /** Reverse rotation: share of forward K_T and K_Q, blades running backwards. */
  reverseEfficiency: 0.55,
  /** Propeller disc immersion at which ventilation is complete, and at which it starts. */
  ventilationFull: 0.5,
  ventilationOnset: 0.82,
  /** K_T and K_Q fall to this share once fully ventilated. */
  ventilatedLoad: 0.25,
  /**
   * Blade loading at which back cavitation starts to take thrust: Barnaby's
   * mean thrust per projected blade area, as a share of the static head at
   * the shaft (p_atm + rho g h - p_v). Barnaby's merchant-ship rule is 0.76
   * (11.25 psi at 1 ft of immersion). A cupped high-speed outboard propeller
   * is built to run past it: this one carries its full-speed thrust at 0.9
   * and reaches 1.4 in the hole shot. Fitted to the trials' time to plane and
   * 0-30 mph, with the full-speed point left clear.
   */
  cavitationLoading: 1.0,
  /**
   * Past it, the share of the extra open-water thrust the blades still give,
   * and the share of the thrust's fractional loss that the torque loses too
   * (thrust breaks down before torque, so the engine flares).
   */
  cavitationThrustSlope: 0.4,
  cavitationTorqueShare: 0.5,
  /** Low-speed sideways pull of a right-hand propeller, as a share of thrust. */
  propellerWalk: 0.04,
  /** Linear wave-radiation damping at rest, as a fraction of critical, heave/pitch/roll. */
  radiationDamping: 0.08,
});

export type BoatCalibration = typeof BOAT_CALIBRATION;
