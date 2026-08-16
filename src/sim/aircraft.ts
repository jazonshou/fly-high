import type { Vec3 } from "./types";
import { clamp } from "./math";

export interface LandingGearDefinition {
  /** Position of the tyre contact point in aircraft body coordinates. */
  position: Vec3;
  springRate: number;
  dampingRate: number;
  /** Maximum nose-wheel steering angle. Omit for a free-rolling wheel. */
  maxSteeringAngle?: number;
}

export type AircraftKind = "trainer" | "jet";
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

/** A fictional, deliberately unlicensed four-seat piston trainer. */
export const LIGHT_TRAINER: Readonly<AircraftDefinition> = Object.freeze({
  kind: "trainer",
  name: "Aster T-20",
  propulsion: "propeller",
  mass: 980,
  wingArea: 16.2,
  wingSpan: 10.8,
  meanChord: 1.5,
  // Principal moments around body roll (+X), yaw (+Y), and pitch (+Z).
  inertia: Object.freeze({ x: 900, y: 1_900, z: 1_350 }),
  maxEnginePower: 132_000,
  maxStaticThrust: 2_650,
  propellerEfficiency: 0.8,
  idleRpm: 750,
  maxRpm: 2_700,
  clZero: 0.29,
  clAlpha: 5.05,
  positiveStallAngle: (15 * Math.PI) / 180,
  negativeStallAngle: (-13 * Math.PI) / 180,
  flapLift: 0.55,
  cdZero: 0.029,
  inducedDrag: 0.047,
  stallDrag: 0.92,
  flapDrag: 0.064,
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
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -0.3, y: -1.34, z: -1.52 }),
      springRate: 65_000,
      dampingRate: 7_800,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.3, y: -1.34, z: 1.52 }),
      springRate: 65_000,
      dampingRate: 7_800,
    }),
    Object.freeze({
      position: Object.freeze({ x: 2.55, y: -1.16, z: 0 }),
      springRate: 50_000,
      dampingRate: 6_000,
      maxSteeringAngle: (22 * Math.PI) / 180,
    }),
  ]),
  airframeContactPoints: Object.freeze([
    Object.freeze({ x: 4.35, y: 0.22, z: 0 }),
    Object.freeze({ x: 4.35, y: -0.22, z: 0 }),
    Object.freeze({ x: 0.58, y: 1.08, z: 0 }),
    Object.freeze({ x: 0.28, y: -0.56, z: 0 }),
    Object.freeze({ x: 0.2, y: 0.2, z: 5.45 }),
    Object.freeze({ x: 0.2, y: 0.2, z: -5.45 }),
    Object.freeze({ x: -3.25, y: 1.78, z: 0 }),
    Object.freeze({ x: -3.48, y: 0.36, z: 0 }),
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
      springRate: 285_000,
      dampingRate: 31_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.72, y: -1.46, z: 1.72 }),
      springRate: 285_000,
      dampingRate: 31_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 3.72, y: -1.32, z: 0 }),
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

export function aircraftDefinition(kind: AircraftKind): Readonly<AircraftDefinition> {
  return kind === "jet" ? FAST_JET : LIGHT_TRAINER;
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
    aircraft.stallDrag * stallProgress * stallProgress
  );
}
