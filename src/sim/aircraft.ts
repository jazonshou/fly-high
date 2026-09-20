import type { Vec3 } from "./types";
import { clamp } from "./math";

export interface LandingGearDefinition {
  /** Position of the tyre contact point in aircraft body coordinates. */
  position: Vec3;
  /** Stowed wheel position for retractable gear. Omitted for fixed gear. */
  retractedPosition?: Vec3;
  springRate: number;
  dampingRate: number;
  /** Maximum nose-wheel steering angle. Omit for a free-rolling wheel. */
  maxSteeringAngle?: number;
}

/**
 * Every airframe the game ships, and the source of truth for the union.
 *
 * Declared as a value first so the list and the type cannot drift: settings
 * validation, the aircraft picker and `AIRCRAFT_SPECS` all read this array, and
 * a `Record<AircraftKind, ...>` will not compile until a new entry is answered
 * everywhere it matters.
 */
export const AIRCRAFT_KINDS = ["trainer", "jet"] as const;
export type AircraftKind = (typeof AIRCRAFT_KINDS)[number];
export type PropulsionKind = "propeller" | "jet";

export interface AircraftDefinition {
  kind: AircraftKind;
  name: string;
  propulsion: PropulsionKind;
  mass: number;
  wingArea: number;
  wingSpan: number;
  meanChord: number;
  inertia: Vec3;
  maxEnginePower: number;
  maxStaticThrust: number;
  propellerEfficiency: number;
  idleRpm: number;
  maxRpm: number;
  clZero: number;
  clAlpha: number;
  positiveStallAngle: number;
  negativeStallAngle: number;
  flapLift: number;
  cdZero: number;
  inducedDrag: number;
  stallDrag: number;
  flapDrag: number;
  /** Additional parasite-drag coefficient at full gear extension. */
  gearDrag: number;
  /** Additional drag coefficient at full speed-brake deployment. */
  speedBrakeDrag: number;
  /** Whether the undercarriage can be retracted by the pilot. */
  retractableGear: boolean;
  /** Full normalized gear travel per second. */
  gearCycleRate: number;
  /**
   * Mach number where transonic wave drag begins. `Infinity` disables the
   * term entirely (the trainer), keeping that aircraft's drag bit-identical.
   */
  transonicOnsetMach: number;
  /**
   * Peak incremental wave-drag coefficient at the transonic hump. Zero
   * disables the term.
   */
  transonicDragRise: number;
  sideForceBeta: number;
  sideForceRudder: number;
  pitchMomentZero: number;
  pitchMomentAlpha: number;
  pitchMomentElevator: number;
  pitchDamping: number;
  rollMomentAileron: number;
  rollMomentBeta: number;
  rollDamping: number;
  yawMomentRudder: number;
  yawMomentBeta: number;
  yawDamping: number;
  gear: readonly LandingGearDefinition[];
  /** Visible airframe extremities used for terrain strikes and wreck clearance. */
  airframeContactPoints: readonly Readonly<Vec3>[];
}

/**
 * The Cessna 150: a two-seat, high-wing, strut-braced piston trainer with
 * fixed tricycle gear and a 100 hp Continental O-200.
 *
 * Dimensions and weights are the real aeroplane's. Where this simulator's
 * parameter set cannot express a real quantity the number is chosen to land
 * the OBSERVABLE performance — stall, cruise, climb, ceiling — on the type's
 * figures, which is the thing a pilot can check out of the window; the
 * derivations are on each field.
 *
 * Deliberate deviation, one: the real main-wheel track is 1.63 m. That is
 * narrow enough to make this simulator's ground model twitchy in a crosswind
 * landing, so the mains sit at +/-1.2 m (2.4 m track). Everything else that
 * touches the ground is to scale.
 */
export const LIGHT_TRAINER: Readonly<AircraftDefinition> = Object.freeze({
  kind: "trainer",
  name: "Cessna 150",
  propulsion: "propeller",
  // Maximum take-off weight, 1,600 lb.
  mass: 726,
  // 157 sq ft.
  wingArea: 14.6,
  // 33 ft 4 in.
  wingSpan: 10.17,
  // wingArea / wingSpan for the 150's nearly rectangular planform.
  meanChord: 1.44,
  // Principal moments around body roll (+X), yaw (+Y), and pitch (+Z), scaled
  // off the previous airframe by mass and by span or length squared.
  inertia: Object.freeze({ x: 620, y: 1_250, z: 900 }),
  // Continental O-200-A: 100 hp at 2,750 rpm.
  maxEnginePower: 74_600,
  /**
   * Static thrust of the fixed-pitch propeller, and a DELIBERATE DEVIATION
   * from the real aeroplane, chosen by Jason.
   *
   * This one number sets the climb and nothing else a pilot judges the type
   * by. Measured across the whole sweep, stall (24.1 m/s clean, 20.7 flapped)
   * and maximum level speed (58.7 m/s) are IDENTICAL at every value, because
   * the stall is flown at idle and at maximum speed the propeller is
   * power-limited (74,600 W x 0.8 / 58.7 = 1,017 N) well below any cap here.
   * So the trade is climb against nothing.
   *
   *   1,200 N  book-faithful:  3.40 m/s / 669 ft/min, 324 m take-off roll,
   *                            8.6 minutes and 22.2 km to reach 1,600 m
   *   1,650 N  shipped:        5.34 m/s / 1,051 ft/min, 235 m roll,
   *                            5.3 minutes and 11.3 km to 1,600 m
   *
   * The type's book rate of climb is 670 ft/min, which 1,200 N reproduces
   * almost exactly. It was rejected: against this world's 1,750-1,900 m
   * mountains a book-faithful 150 makes crossing a range a chore, and the
   * aeroplane reads as getting worse rather than the terrain getting better.
   * The faithful value is one edit away and `tests/sim.trainer-performance`
   * pins both the shipped climb and the invariance that makes the trade safe.
   */
  maxStaticThrust: 1_650,
  propellerEfficiency: 0.8,
  idleRpm: 700,
  maxRpm: 2_750,
  clZero: 0.29,
  clAlpha: 5.05,
  positiveStallAngle: (15 * Math.PI) / 180,
  negativeStallAngle: (-13 * Math.PI) / 180,
  flapLift: 0.55,
  cdZero: 0.029,
  inducedDrag: 0.047,
  stallDrag: 0.92,
  flapDrag: 0.064,
  gearDrag: 0,
  speedBrakeDrag: 0,
  retractableGear: false,
  gearCycleRate: 0,
  // The trainer never approaches its critical Mach number; Infinity/0 keeps
  // its aerodynamic model bit-identical to the pre-wave-drag build.
  transonicOnsetMach: Number.POSITIVE_INFINITY,
  transonicDragRise: 0,
  sideForceBeta: 0.68,
  sideForceRudder: 0.12,
  pitchMomentZero: 0.009,
  pitchMomentAlpha: -0.72,
  pitchMomentElevator: 0.34,
  pitchDamping: -12.5,
  rollMomentAileron: 0.072,
  // Positive beta is motion toward the starboard wing. Dihedral raises that
  // wing and therefore produces +X torque (a pilot-negative/left bank).
  rollMomentBeta: 0.06,
  rollDamping: -0.66,
  yawMomentRudder: 0.072,
  yawMomentBeta: 0.115,
  yawDamping: -0.3,
  // Sprung-steel main legs and an oleo nosewheel. Softer than the previous
  // airframe's in proportion to a quarter less aeroplane sitting on them.
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -0.26, y: -1.22, z: -1.2 }),
      springRate: 48_000,
      dampingRate: 5_800,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.26, y: -1.22, z: 1.2 }),
      springRate: 48_000,
      dampingRate: 5_800,
    }),
    Object.freeze({
      position: Object.freeze({ x: 2.36, y: -1.06, z: 0 }),
      springRate: 37_000,
      dampingRate: 4_500,
      maxSteeringAngle: (22 * Math.PI) / 180,
    }),
  ]),
  // Spinner, windscreen and cabin roof, belly, both wingtips, fin tip and
  // tailcone, on a 7.34 m fuselage with the datum at the centre of gravity.
  // Every one of these is ON the built skin, measured against the mesh rather
  // than sketched: three of them used to float between 0.2 m and 0.8 m clear
  // of it, and the fin tip's fired LATE, which is the dangerous direction.
  // The wingtips sit at the wing's own chord plane, y = 0.28, which is where
  // `trainerVisual` builds it — physics and mesh have to agree or a wingtip
  // strike fires at the wrong height.
  airframeContactPoints: Object.freeze([
    Object.freeze({ x: 4.02, y: 0.2, z: 0 }),
    Object.freeze({ x: 4.02, y: -0.2, z: 0 }),
    Object.freeze({ x: 0.52, y: 0.23, z: 0 }),
    Object.freeze({ x: 0.26, y: -0.72, z: 0 }),
    Object.freeze({ x: 0.18, y: 0.28, z: 5.13 }),
    Object.freeze({ x: 0.18, y: 0.28, z: -5.13 }),
    Object.freeze({ x: -2.86, y: 1.36, z: 0 }),
    Object.freeze({ x: -3.32, y: 0.34, z: 0 }),
  ]),
});

/**
 * A fictional single-engine sport jet. Its dimensions and wing loading are in
 * the class of a compact advanced trainer, while the intentionally generous
 * dry thrust makes the speed difference immediately legible in a browser game.
 */
export const FAST_JET: Readonly<AircraftDefinition> = Object.freeze({
  kind: "jet",
  name: "Vesper J-45",
  propulsion: "jet",
  mass: 5_850,
  wingArea: 25.8,
  wingSpan: 9.6,
  meanChord: 2.7,
  inertia: Object.freeze({ x: 11_900, y: 54_000, z: 47_500 }),
  // Shaft power/efficiency are not used by the jet thrust branch. Keeping the
  // fields explicit avoids optional values in the hot simulation loop.
  maxEnginePower: 0,
  maxStaticThrust: 42_000,
  propellerEfficiency: 0,
  // Jet engine telemetry is percent N2 rather than literal crankshaft RPM.
  idleRpm: 35,
  maxRpm: 100,
  clZero: 0.2,
  clAlpha: 4.55,
  positiveStallAngle: (17 * Math.PI) / 180,
  negativeStallAngle: (-15 * Math.PI) / 180,
  flapLift: 0.72,
  cdZero: 0.0185,
  inducedDrag: 0.041,
  stallDrag: 0.74,
  flapDrag: 0.085,
  gearDrag: 0.042,
  speedBrakeDrag: 0.16,
  retractableGear: true,
  gearCycleRate: 0.42,
  // The J-45 tops out near 260 m/s (M 0.76 at sea level) and never reaches a
  // critical Mach number; Infinity/0 leaves the wave-drag term inert, keeping
  // this airframe's drag identical to the pre-wave-drag build.
  transonicOnsetMach: Number.POSITIVE_INFINITY,
  transonicDragRise: 0,
  sideForceBeta: 0.78,
  sideForceRudder: 0.14,
  pitchMomentZero: 0.004,
  pitchMomentAlpha: -0.61,
  pitchMomentElevator: 0.46,
  pitchDamping: -15.2,
  rollMomentAileron: 0.088,
  rollMomentBeta: 0.052,
  rollDamping: -0.74,
  yawMomentRudder: 0.082,
  yawMomentBeta: 0.13,
  yawDamping: -0.38,
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -0.72, y: -1.46, z: -1.72 }),
      retractedPosition: Object.freeze({ x: -0.58, y: -0.38, z: -0.62 }),
      springRate: 285_000,
      dampingRate: 31_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.72, y: -1.46, z: 1.72 }),
      retractedPosition: Object.freeze({ x: -0.58, y: -0.38, z: 0.62 }),
      springRate: 285_000,
      dampingRate: 31_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 3.72, y: -1.32, z: 0 }),
      retractedPosition: Object.freeze({ x: 3.35, y: -0.42, z: 0 }),
      springRate: 190_000,
      dampingRate: 23_000,
      maxSteeringAngle: (18 * Math.PI) / 180,
    }),
  ]),
  airframeContactPoints: Object.freeze([
    Object.freeze({ x: 5.86, y: 0.25, z: 0 }),
    Object.freeze({ x: 5.86, y: -0.25, z: 0 }),
    Object.freeze({ x: 1.15, y: 1.2, z: 0 }),
    Object.freeze({ x: 0, y: -0.64, z: 0 }),
    Object.freeze({ x: -0.3, y: 0.05, z: 4.83 }),
    Object.freeze({ x: -0.3, y: 0.05, z: -4.83 }),
    Object.freeze({ x: -4.74, y: 2.21, z: 0 }),
    Object.freeze({ x: -5.33, y: 0, z: 0 }),
  ]),
});

const AIRCRAFT_DEFINITIONS: Readonly<Record<AircraftKind, Readonly<AircraftDefinition>>> =
  Object.freeze({
    trainer: LIGHT_TRAINER,
    jet: FAST_JET,
  });

export function aircraftDefinition(kind: AircraftKind): Readonly<AircraftDefinition> {
  return AIRCRAFT_DEFINITIONS[kind] ?? LIGHT_TRAINER;
}

/**
 * Returns installed thrust without conflating propeller shaft power and jet
 * thrust. Propeller output remains power-limited at speed; a jet instead uses
 * a smooth density lapse and mild inlet recovery loss at very high speed.
 */
export function calculateEngineThrust(
  aircraft: AircraftDefinition,
  throttle: number,
  airDensity: number,
  forwardAirspeed: number,
): number {
  const commandedThrottle = clamp(throttle, 0, 1);
  if (aircraft.propulsion === "jet") {
    // A turbine cannot produce thrust without mass flow. Unlike the legacy
    // propeller branch, do not retain the low-density numerical floor as the
    // atmosphere approaches vacuum.
    const densityRatio = clamp(airDensity / 1.225, 0, 1.2);
    const densityLapse = densityRatio ** 0.72;
    const inletRecovery = 1 - 0.12 * clamp((forwardAirspeed - 220) / 180, 0, 1);
    return commandedThrottle * aircraft.maxStaticThrust * densityLapse * inletRecovery;
  }

  const densityRatio = clamp(airDensity / 1.225, 0.1, 1.2);
  const availablePower = aircraft.maxEnginePower * densityRatio ** 0.85;
  const powerLimitedThrust =
    (availablePower * aircraft.propellerEfficiency) / Math.max(forwardAirspeed, 30);
  return (
    commandedThrottle *
    Math.min(aircraft.maxStaticThrust * densityRatio, powerLimitedThrust)
  );
}

/**
 * Smoothly loses lift beyond the critical angle rather than hard-clamping it.
 * This gives a progressive break and leaves some post-stall control authority.
 */
export function calculateLiftCoefficient(
  angleOfAttack: number,
  flaps = 0,
  aircraft: AircraftDefinition = LIGHT_TRAINER,
): number {
  const alpha = clamp(angleOfAttack, -Math.PI / 2, Math.PI / 2);
  const flap = clamp(flaps, 0, 1);
  const linear = aircraft.clZero + aircraft.clAlpha * alpha + aircraft.flapLift * flap;

  if (alpha > aircraft.positiveStallAngle) {
    const atStall =
      aircraft.clZero +
      aircraft.clAlpha * aircraft.positiveStallAngle +
      aircraft.flapLift * flap;
    const progress = clamp(
      (alpha - aircraft.positiveStallAngle) / ((38 * Math.PI) / 180),
      0,
      1,
    );
    const decay = 1 - 0.72 * (progress * progress * (3 - 2 * progress));
    return atStall * decay;
  }

  if (alpha < aircraft.negativeStallAngle) {
    const atStall =
      aircraft.clZero +
      aircraft.clAlpha * aircraft.negativeStallAngle +
      aircraft.flapLift * flap;
    const progress = clamp(
      (aircraft.negativeStallAngle - alpha) / ((38 * Math.PI) / 180),
      0,
      1,
    );
    const decay = 1 - 0.72 * (progress * progress * (3 - 2 * progress));
    return atStall * decay;
  }

  return linear;
}

export function calculateDragCoefficient(
  angleOfAttack: number,
  liftCoefficient: number,
  flaps = 0,
  aircraft: AircraftDefinition = LIGHT_TRAINER,
  gear = aircraft.retractableGear ? 0 : 1,
  speedBrake = 0,
): number {
  const positiveExcess = Math.max(0, angleOfAttack - aircraft.positiveStallAngle);
  const negativeExcess = Math.max(0, aircraft.negativeStallAngle - angleOfAttack);
  const stallProgress = clamp(
    (positiveExcess + negativeExcess) / ((25 * Math.PI) / 180),
    0,
    1,
  );
  return (
    aircraft.cdZero +
    aircraft.inducedDrag * liftCoefficient * liftCoefficient +
    aircraft.flapDrag * clamp(flaps, 0, 1) ** 2 +
    aircraft.gearDrag * clamp(gear, 0, 1) ** 1.35 +
    aircraft.speedBrakeDrag * clamp(speedBrake, 0, 1) ** 1.2 +
    aircraft.stallDrag * stallProgress * stallProgress
  );
}
