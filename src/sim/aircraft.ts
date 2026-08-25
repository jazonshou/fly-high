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
 * The F-22 Raptor at combat weight. Geometry, mass properties, and dry thrust
 * are in the real aircraft's class (18.92 m airframe, 13.56 m span, AR 2.36
 * delta, two F119s at military power). Moment coefficients are tuned for a
 * stable but agile sim airframe rather than copied from any flight manual.
 *
 * Lateral-directional derivation (two-DOF dutch-roll approximation,
 * beta_dot = Ybeta'*beta - r; r_dot = Nbeta*beta + Nr'*r, sea level):
 *   Nbeta = qS*b*Cnbeta/Iyy, Nr' = qS*b^2*Cnr/(2*V*Iyy),
 *   Ybeta' = -qS*Cybeta/(m*V)
 * Measured in the full nonlinear model (5-degree beta release, log-decrement
 * fit of the yaw-rate trace at 1,000 m; roll coupling costs ~0.05 of zeta
 * versus the two-DOF sketch):
 *   at 120 m/s: omega_n = 2.16 rad/s, zeta_open = 0.32, zeta_closed = 0.47
 *   at 200 m/s: omega_n = 3.42 rad/s, zeta_open = 0.35, zeta_closed = 0.60
 *   at 250 m/s: omega_n = 4.26 rad/s, zeta_open = 0.36, zeta_closed = 0.67
 *   at 300 m/s: omega_n = 5.10 rad/s, zeta_open = 0.37, zeta_closed = 0.73
 * (open-loop zeta is nearly speed-invariant at fixed density and scales with
 * sqrt(rho) at altitude, which is why the washout yaw damper in
 * stabilityAugmentation.ts exists; closed loop clears the fix-pack's
 * zeta >= 0.45 floor at every checked speed.)
 */
export const FAST_JET: Readonly<AircraftDefinition> = Object.freeze({
  kind: "jet",
  name: "F-22 Raptor",
  propulsion: "jet",
  mass: 24_000,
  wingArea: 78.04,
  wingSpan: 13.56,
  meanChord: 5.76,
  inertia: Object.freeze({ x: 38_000, y: 240_000, z: 205_000 }),
  // Shaft power/efficiency are not used by the jet thrust branch. Keeping the
  // fields explicit avoids optional values in the hot simulation loop.
  maxEnginePower: 0,
  // Two F119 engines at military (dry) power.
  maxStaticThrust: 232_000,
  propellerEfficiency: 0,
  // Jet engine telemetry is percent N2 rather than literal crankshaft RPM.
  idleRpm: 35,
  maxRpm: 100,
  clZero: 0.05,
  // Low-aspect-ratio (AR 2.36) delta: shallow lift slope, late stall.
  clAlpha: 3.8,
  positiveStallAngle: (25 * Math.PI) / 180,
  negativeStallAngle: (-18 * Math.PI) / 180,
  // No conventional flaps on the real aircraft; a small flaperon increment is
  // retained for landing playability.
  flapLift: 0.3,
  cdZero: 0.021,
  // 1/(pi*AR*e) with AR 2.36 and e 0.85 gives 0.159 for the wing alone. The
  // chined body and LEX-like vortex lift carry a meaningful share of lift at
  // low alpha in this single-coefficient model, so the effective installed
  // value is set lower; 0.13 keeps approach drag manageable in playtesting.
  inducedDrag: 0.13,
  stallDrag: 0.65,
  flapDrag: 0.04,
  gearDrag: 0.02,
  speedBrakeDrag: 0.14,
  retractableGear: true,
  gearCycleRate: 0.35,
  // Wave-drag hump begins just below Mach 1; see waveDragCoefficient in
  // simulation.ts for the shared shape (0.17-Mach rise, supersonic decay).
  transonicOnsetMach: 0.95,
  transonicDragRise: 0.02,
  sideForceBeta: 0.9,
  sideForceRudder: 0.12,
  pitchMomentZero: 0.016,
  // Relaxed static stability by fighter standards but firmly sim-stable.
  pitchMomentAlpha: -0.35,
  // Full-span stabilators.
  pitchMomentElevator: 0.65,
  // Re-derived, not copied: the damping term multiplies meanChord/(2V) and
  // meanChord went 2.7 -> 5.76. Normalized pitch damping S*c^2*|Cmq|/Izz is
  // 78.04*33.18*4.5/205000 = 0.057, matching the old jet's 0.060.
  pitchDamping: -4.5,
  rollMomentAileron: 0.12,
  // Positive beta is motion toward the starboard wing. Dihedral effect raises
  // that wing and therefore produces +X torque (a pilot-negative/left bank).
  rollMomentBeta: 0.035,
  rollDamping: -0.42,
  yawMomentRudder: 0.09,
  yawMomentBeta: 0.11,
  // Raised from the plan's -0.55 sketch: the widely-spaced canted fins and
  // aft deck damp yaw strongly, and the measured 120 m/s closed-loop dutch
  // roll cannot reach the mandated zeta 0.45 on damper gain alone (yaw-rate
  // feedback authority scales with dynamic pressure and fades exactly where
  // the mode is worst).
  yawDamping: -0.7,
  // Extended geometry, body frame (+X forward, +Y up, +Z port, CG origin):
  // mains at x -0.85 with a 3.26 m track, nose at x 5.19 (wheelbase 6.04 m).
  // Spring/damper rates carry 24 t at ~0.11 m static main compression.
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -0.85, y: -2.05, z: -1.63 }),
      retractedPosition: Object.freeze({ x: -0.7, y: -0.6, z: -0.7 }),
      springRate: 900_000,
      dampingRate: 95_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.85, y: -2.05, z: 1.63 }),
      retractedPosition: Object.freeze({ x: -0.7, y: -0.6, z: 0.7 }),
      springRate: 900_000,
      dampingRate: 95_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 5.19, y: -2.0, z: 0 }),
      retractedPosition: Object.freeze({ x: 4.7, y: -0.5, z: 0 }),
      springRate: 520_000,
      dampingRate: 55_000,
      maxSteeringAngle: (20 * Math.PI) / 180,
    }),
  ]),
  // Authoritative extremities of the 18.92 m airframe; the visual rebuild
  // conforms to these. Nose tip, canopy bow, belly, wingtips, nozzles, fins.
  airframeContactPoints: Object.freeze([
    Object.freeze({ x: 9.55, y: 0.1, z: 0 }),
    Object.freeze({ x: 9.55, y: -0.35, z: 0 }),
    Object.freeze({ x: 3.4, y: 1.35, z: 0 }),
    Object.freeze({ x: 0, y: -1.0, z: 0 }),
    Object.freeze({ x: -2.2, y: 0, z: 6.78 }),
    Object.freeze({ x: -2.2, y: 0, z: -6.78 }),
    Object.freeze({ x: -9.3, y: 0.15, z: 0 }),
    Object.freeze({ x: -9.3, y: -0.6, z: 0 }),
    Object.freeze({ x: -7.3, y: 2.95, z: 1.35 }),
    Object.freeze({ x: -7.3, y: 2.95, z: -1.35 }),
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
