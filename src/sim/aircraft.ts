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

export interface AircraftDefinition {
  name: string;
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
}

/** A fictional, deliberately unlicensed four-seat piston trainer. */
export const LIGHT_TRAINER: Readonly<AircraftDefinition> = Object.freeze({
  name: "Aster T-20",
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
});

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
