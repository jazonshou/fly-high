import type { Vec3 } from "./types";
import { clamp } from "./math";
import {
  SEA_LEVEL_DENSITY,
  SEA_LEVEL_TEMPERATURE,
  speedOfSoundForDensity,
  standardTemperatureForDensity,
} from "./atmosphere";

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
/**
 * Level-flight stall speed in m/s at sea level, for the given flap setting.
 *
 * Exists because there is no `stallSpeed` FIELD and there must never appear to
 * be one. Reading `aircraft.stallSpeed` returns undefined, every comparison
 * against it is quietly false, and code that meant to rotate at Vr simply never
 * rotates — which does not look like a typo, it looks like the aeroplane cannot
 * climb. A take-off test written that way reported that a Cessna 150 needs
 * 1,438 m of runway. Compute it here, once, where the coefficients live.
 */
export function stallSpeed(aircraft: AircraftDefinition, flaps = 0): number {
  const clMax = aircraft.clZero
    + aircraft.clAlpha * aircraft.positiveStallAngle
    + aircraft.flapLift * clamp(flaps, 0, 1);
  return Math.sqrt(
    (2 * aircraft.mass * 9.80665) / (SEA_LEVEL_DENSITY * aircraft.wingArea * clMax),
  );
}

/**
 * How far the airframe reaches behind the CG, in metres, taken from the
 * contact points and wheels rather than from a written-down length: those are
 * already the tailcone, fin tip and main gear, so this cannot drift away from
 * the shape the aeroplane actually has. It measures 7.34 m nose-to-tail on the
 * Cessna 150 and 33.5 m on the Global 8000, against real figures of 7.34 m and
 * 33.88 m.
 *
 * Used to line an aeroplane up on the threshold. A single constant would be a
 * constant measured against one aeroplane: enough room behind a 7 m trainer
 * hangs a 76 m airliner's tail over the grass.
 */
export function aftExtent(aircraft: AircraftDefinition): number {
  let aft = 0;
  for (const point of aircraft.airframeContactPoints) aft = Math.min(aft, point.x);
  for (const leg of aircraft.gear) aft = Math.min(aft, leg.position.x);
  return -aft;
}

export const AIRCRAFT_KINDS = ["trainer", "jet", "bizjet", "airliner"] as const;
export type AircraftKind = (typeof AIRCRAFT_KINDS)[number];
export type PropulsionKind = "propeller" | "jet";

/**
 * Reheat: raw fuel burned in the jet pipe for thrust the core cannot make.
 *
 * Additive rather than a bigger `maxStaticThrust`, because that is what it
 * physically is — the dry engine keeps running and the nozzle adds to it — and
 * because the pilot needs to feel a distinct gate rather than a throttle that
 * is quietly twice as strong everywhere. Below `engageThrottle` the aeroplane
 * flies on dry thrust alone and nothing here applies.
 */
export interface AfterburnerDefinition {
  /** Newtons added at full throttle, on top of dry `maxStaticThrust`. */
  readonly thrustBoost: number;
  /** Throttle fraction at which the nozzle lights. */
  readonly engageThrottle: number;
}

/**
 * How a turbofan's thrust falls away with altitude and rises or falls with
 * flight Mach: Mattingly's installed-thrust lapse correlations (Mattingly,
 * Heiser & Pratt, *Aircraft Engine Design*, 2nd ed., section 2.3.2), which are
 * fitted to real engines of each cycle and are the standard first-order model
 * in conceptual design.
 *
 * Both read the flight condition through the TOTAL (stagnation) temperature
 * and pressure ratios the engine face actually sees,
 *
 *   theta0 = (T / T_SL) * (1 + 0.2 M^2)      delta0 = (p / p_SL) * (1 + 0.2 M^2)^3.5
 *
 * so ram compression is in the model, not just density:
 *
 * - `"high-bypass"` (the Passport, the GEnx): a big fan's thrust falls steeply
 *   with speed, `delta0 * (1 - 0.49 sqrt(M))`, less a temperature-limit term
 *   once theta0 passes the throttle ratio. Full power at 35,000 ft and M 0.85 is
 *   about a fifth of the sea-level static figure, which is the real engines'
 *   maximum-climb rating; and an airliner has lost about a fifth of its thrust
 *   by rotation.
 * - `"low-bypass-mixed"` (the F110): ram recovery holds thrust up with Mach until
 *   the turbine-inlet limit at theta0 = throttle ratio, then it falls. Dry and
 *   reheat lapse differently (3.8 and 3.5 per unit of theta0 over the ratio).
 *
 * Replaces `rho^0.72` times an ad hoc inlet loss, which gave every jet 40% of its
 * static thrust at airliner cruise (twice the real figure: the 747 cruised past
 * Mach 0.96) and gave the F-16 no ram recovery at all.
 */
export interface JetLapseDefinition {
  readonly cycle: "high-bypass" | "low-bypass-mixed";
  /**
   * The engine's throttle ratio: the theta0 at which the turbine-inlet
   * temperature limit starts to bind, so above it thrust falls with theta0.
   * About 1.0 for a civil turbofan, and somewhat above it for a fighter engine
   * whose design point is supersonic.
   */
  readonly throttleRatio: number;
}

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
  /**
   * Whether the aeroplane has GROUND SPOILERS: lift dumpers that deploy on
   * their own at touchdown (the type's speedbrake armed, always here, since
   * nothing in the cockpit disarms it) and with the wheel brake on the
   * ground. The sim owns their deployment (`ActuatorState.groundSpoilers`);
   * the lift dump and the drawn panels both read it. `false` keeps an
   * airframe's brake-only lift dump exactly as it was.
   */
  groundSpoilers: boolean;
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
  /**
   * Reheat, or `null` for the aeroplanes that have none.
   *
   * Nullable and REQUIRED rather than optional: an optional field lets a new
   * airframe be added without anyone deciding whether it has an afterburner,
   * and silently not having one is exactly the sort of omission that reads as
   * a physics bug later.
   */
  afterburner: AfterburnerDefinition | null;
  /**
   * The jet's thrust lapse with altitude and Mach, or `null` on a propeller.
   * Nullable and required for the same reason as `afterburner`.
   */
  jetLapse: JetLapseDefinition | null;
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
  groundSpoilers: false,
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
  // A Continental O-200 has no jet pipe to burn fuel in.
  afterburner: null,
  jetLapse: null,
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
 * The General Dynamics F-16C Fighting Falcon, Block 50: a single-engine
 * multirole fighter with a blended cropped-delta wing, a single fin, and one
 * F110-GE-129 turbofan with reheat.
 *
 * Flown at 11,000 kg, a clean combat weight with about half fuel, rather than
 * the 19,200 kg maximum. The same reasoning as the Global and the 747 — an
 * aeroplane at its maximum is not the aeroplane anyone wants to fly — and at
 * this weight it is the thrust-to-weight of roughly 1.2 in reheat that the
 * F-16 is famous for.
 */
export const FAST_JET: Readonly<AircraftDefinition> = Object.freeze({
  kind: "jet",
  name: "F-16C Fighting Falcon",
  propulsion: "jet",
  mass: 11_000,
  wingArea: 27.87,
  wingSpan: 9.96,
  meanChord: 3.45,
  // Roll, yaw, pitch about the CG. A fighter's roll inertia is tiny against
  // its pitch and yaw, which is most of why it rolls the way it does.
  inertia: Object.freeze({ x: 12_900, y: 85_600, z: 75_700 }),
  // Shaft power/efficiency are not used by the jet thrust branch. Keeping the
  // fields explicit avoids optional values in the hot simulation loop.
  maxEnginePower: 0,
  // F110-GE-129: 76.3 kN dry, 131 kN in full reheat, at sea level standing
  // still. The boost below is the difference, so full throttle gives the
  // published installed figure there; everywhere else `jetLapse` decides.
  maxStaticThrust: 76_300,
  propellerEfficiency: 0,
  // Jet engine telemetry is percent N2 rather than literal crankshaft RPM.
  idleRpm: 35,
  maxRpm: 100,
  clZero: 0.12,
  clAlpha: 4.3,
  // The real aeroplane will fly past 25 degrees; its flight control system
  // will not let it. 22 is the usable limit rather than the aerodynamic one.
  positiveStallAngle: (22 * Math.PI) / 180,
  negativeStallAngle: (-16 * Math.PI) / 180,
  flapLift: 0.62,
  cdZero: 0.0172,
  inducedDrag: 0.052,
  stallDrag: 0.78,
  flapDrag: 0.075,
  gearDrag: 0.045,
  speedBrakeDrag: 0.19,
  groundSpoilers: false,
  retractableGear: true,
  gearCycleRate: 0.42,
  // The F-16 genuinely goes supersonic, so the wave-drag term is live, and the
  // drag hump and the engine's throttle ratio (`jetLapse`) were fitted
  // TOGETHER to the type's four signature speeds, flown as steady level flight
  // against the shared ISA: full reheat M 1.19 at sea level (the type: about
  // 1.2) and M 1.97 at 11 km (about 2.0); dry, M 1.01 at sea level and M 1.05
  // at 11 km, because an F-16 cannot supercruise. A shallower hump lets the dry
  // engine punch through it and cruise at M 1.5; a lower throttle ratio cannot
  // reach Mach 2. The peak zero-lift drag (0.057 at M 1.07) is an effective
  // figure for an aeroplane carrying its wingtip rails.
  //
  // The 0.012 rise this replaces was fitted against a thrust model with no ram
  // recovery, using an altitude hold that had not settled: flown properly, that
  // F-16 reached M 1.71 at sea level and M 2.47 at 11 km, and the "M 1.21 on
  // the deck, M 1.17 up high" written here was a measurement artefact.
  transonicOnsetMach: 0.9,
  transonicDragRise: 0.04,
  sideForceBeta: 0.78,
  sideForceRudder: 0.14,
  pitchMomentZero: 0.004,
  pitchMomentAlpha: -0.61,
  pitchMomentElevator: 0.52,
  pitchDamping: -16.5,
  // A famously fast roll rate: around 320 degrees per second.
  rollMomentAileron: 0.125,
  rollMomentBeta: 0.058,
  rollDamping: -0.82,
  yawMomentRudder: 0.079,
  yawMomentBeta: 0.128,
  yawDamping: -0.36,
  afterburner: Object.freeze({ thrustBoost: 54_700, engageThrottle: 0.85 }),
  // The F110 is a low-bypass (0.76) mixed-flow turbofan. Its throttle ratio is
  // that of an engine designed to make its best thrust supersonic: ram recovery
  // keeps adding thrust until theta0 reaches 1.10, which is Mach 0.71 at sea
  // level and Mach 1.33 above the tropopause. At 1.10 full reheat at sea level
  // and Mach 0.9 is 1.37 times the static figure, which is what the F-16's own
  // published engine tables give (Stevens & Lewis, from NASA TP-1538).
  jetLapse: Object.freeze({ cycle: "low-bypass-mixed", throttleRatio: 1.1 }),
  // A 2.36 m main-gear track under a 9.96 m span: narrow, which is why the
  // real aeroplane is a handful in a crosswind and why the mains sit close in.
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -0.62, y: -1.92, z: -1.18 }),
      retractedPosition: Object.freeze({ x: -0.5, y: -0.52, z: -0.5 }),
      springRate: 430_000,
      dampingRate: 47_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -0.62, y: -1.92, z: 1.18 }),
      retractedPosition: Object.freeze({ x: -0.5, y: -0.52, z: 0.5 }),
      springRate: 430_000,
      dampingRate: 47_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 3.18, y: -1.86, z: 0 }),
      retractedPosition: Object.freeze({ x: 2.9, y: -0.55, z: 0 }),
      springRate: 285_000,
      dampingRate: 33_000,
      maxSteeringAngle: (20 * Math.PI) / 180,
    }),
  ]),
  // Radome, canopy, belly, both wingtips, fin tip and the nozzle, on a 15.06 m
  // fuselage. The tailcone at -7.5 against mains at -0.62 gives a tail-strike
  // limit near 15 degrees, comfortably above the 22-degree alpha limit the
  // wing will reach in the air but not on the runway.
  airframeContactPoints: Object.freeze([
    Object.freeze({ x: 7.5, y: 0.2, z: 0 }),
    Object.freeze({ x: 7.5, y: -0.3, z: 0 }),
    Object.freeze({ x: 2.4, y: 1.24, z: 0 }),
    Object.freeze({ x: 0, y: -0.92, z: 0 }),
    // The ventral inlet lip, which is the lowest structure forward of the
    // gear — 0.32 m below the belly point above it, and only 0.68 m off the
    // ground with the gear down. That famously low intake is a real feature of
    // the aeroplane and it should be what touches first in a nose-low arrival;
    // this table was one point short until the built mesh was measured.
    Object.freeze({ x: 2.6, y: -1.24, z: 0 }),
    Object.freeze({ x: -0.4, y: -0.1, z: 4.98 }),
    Object.freeze({ x: -0.4, y: -0.1, z: -4.98 }),
    Object.freeze({ x: -4.6, y: 3.02, z: 0 }),
    Object.freeze({ x: -7.5, y: 0.02, z: 0 }),
  ]),
});

/**
 * The Bombardier Global 8000: an ultra-long-range business jet. Low swept wing
 * with winglets, T-tail, two GE Passport turbofans on the rear fuselage,
 * retractable tricycle gear.
 *
 * Dimensions, wing, thrust and Mach limits are the real aeroplane's. The MASS
 * is not its maximum: the type's MTOW is 52,163 kg and at that weight it needs
 * about 1,890 m of runway, while this world's only field is 1,320 m of pavement
 * (`src/world/airport.ts`). Flying it at a light ramp weight — part fuel, a few
 * passengers — is both a real configuration and the one that lets a pilot take
 * off, fly and land here, so that is what this definition carries. The MTOW is
 * recorded here rather than dropped, because the next person to touch these
 * numbers needs to know the gap is deliberate.
 */
export const MAXIMUM_TAKEOFF_MASS_GLOBAL_8000 = 52_163;

export const GLOBAL_8000: Readonly<AircraftDefinition> = Object.freeze({
  kind: "bizjet",
  name: "Bombardier Global 8000",
  propulsion: "jet",
  // A light ramp weight, not MTOW. See the note above.
  mass: 40_000,
  wingArea: 94,
  // 104 ft.
  wingSpan: 31.7,
  // Mean aerodynamic chord of the swept, tapered planform — larger than
  // area/span, which would describe a rectangular wing.
  meanChord: 3.4,
  // Principal moments around body roll (+X), yaw (+Y), and pitch (+Z), from
  // the nondimensional radii of gyration of a jet with its engines on the rear
  // fuselage: 0.25 of the semi-span in roll, 0.35 of the half-length in pitch
  // and 0.44 of the mean half-dimension in yaw (I = m (R b/2)^2, the Roskam
  // form). No wing engines keeps the roll figure low; two engines 15 m aft of
  // the CG make pitch and yaw large. The previous 820,000 and 1,100,000 were
  // radii of 0.27 and 0.32, under every published value for a jet transport,
  // which made the aeroplane pitch and yaw like one half its size.
  inertia: Object.freeze({ x: 630_000, y: 2_080_000, z: 1_400_000 }),
  maxEnginePower: 0,
  // Two GE Passport 20-19BB1A at 18,920 lbf.
  maxStaticThrust: 168_000,
  propellerEfficiency: 0,
  // Percent N2. A large turbofan idles lower than a small one.
  idleRpm: 22,
  maxRpm: 100,
  // Aspect ratio 10.7 — high, as a long-range aeroplane's must be. The
  // lift-curve slope follows from it (2*pi / (1 + 2/AR)); the zero-alpha term
  // is small because the section is a supercritical one, cambered for cruise
  // rather than for lift at low speed.
  clZero: 0.14,
  clAlpha: 5.2,
  // Sweep costs stall angle.
  positiveStallAngle: (14 * Math.PI) / 180,
  negativeStallAngle: (-11 * Math.PI) / 180,
  // Large Fowler flaps, which is how an aeroplane this heavy reaches an
  // approach speed a 1,320 m runway can absorb.
  flapLift: 0.95,
  cdZero: 0.016,
  // 1 / (pi * AR * e) at e = 0.8.
  inducedDrag: 0.037,
  stallDrag: 0.85,
  flapDrag: 0.11,
  gearDrag: 0.022,
  // Spoilers rather than a fuselage airbrake, so less than the sport jet's.
  speedBrakeDrag: 0.09,
  groundSpoilers: true,
  retractableGear: true,
  // Roughly eight seconds from locked down to locked up, which is what a leg
  // this size takes.
  gearCycleRate: 0.12,
  // The first airframe in the game that actually reaches its critical Mach
  // number: Mmo is 0.94 and maximum cruise is M 0.925, so the wave-drag term
  // is live and is what stops the aeroplane short of the speed of sound.
  transonicOnsetMach: 0.86,
  transonicDragRise: 0.045,
  sideForceBeta: 0.9,
  sideForceRudder: 0.13,
  pitchMomentZero: 0.006,
  // Strongly stable in pitch, as a transport is.
  pitchMomentAlpha: -0.9,
  pitchMomentElevator: 0.5,
  pitchDamping: -26,
  // Big aeroplanes roll slowly and have a strong dihedral effect from sweep.
  rollMomentAileron: 0.05,
  rollMomentBeta: 0.07,
  rollDamping: -0.9,
  yawMomentRudder: 0.085,
  yawMomentBeta: 0.16,
  yawDamping: -0.5,
  // Wheelbase 13.9 m, track 4.28 m, with the datum at the centre of gravity.
  // Business jets do not carry reheat; range is the whole point of them.
  afterburner: null,
  // The Passport is a 5.6:1 bypass turbofan.
  jetLapse: Object.freeze({ cycle: "high-bypass", throttleRatio: 1 }),
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -1.9, y: -2.7, z: -2.14 }),
      retractedPosition: Object.freeze({ x: -1.7, y: -1.05, z: -1.6 }),
      springRate: 1_950_000,
      dampingRate: 210_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -1.9, y: -2.7, z: 2.14 }),
      retractedPosition: Object.freeze({ x: -1.7, y: -1.05, z: 1.6 }),
      springRate: 1_950_000,
      dampingRate: 210_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 12, y: -2.7, z: 0 }),
      retractedPosition: Object.freeze({ x: 11.4, y: -1.2, z: 0 }),
      springRate: 1_300_000,
      dampingRate: 155_000,
      maxSteeringAngle: (15 * Math.PI) / 180,
    }),
  ]),
  // Radome, cockpit roof, belly, both winglet tips, fin tip and tailcone, on a
  // 33.88 m fuselage. The winglets are the outermost thing on this aeroplane
  // and the first to touch in a wing-low landing, which is why they and not
  // the wing chord plane are the contact points.
  airframeContactPoints: Object.freeze([
    // The radome: 0.15 m above and below the drooped tip, whose ring the
    // renderer draws at y -0.55 +- 0.1 (`GLOBAL_FUSELAGE_SECTIONS`; held there
    // by render.bizjet-nose against the built mesh). They were 0.1 and -0.4
    // round a tip at -0.15: a nose-down touch now registers 0.4 m lower.
    Object.freeze({ x: 15, y: -0.3, z: 0 }),
    Object.freeze({ x: 15, y: -0.8, z: 0 }),
    Object.freeze({ x: 11.5, y: 1.6, z: 0 }),
    Object.freeze({ x: 0, y: -1.5, z: 0 }),
    // x -6.44, not -1. Measured at the true tip station on the rebuilt wing:
    // at |z| 15.88 the chord runs x -6.98 to -5.90 at y 0.25 to 0.82, so the
    // old point sat 5.4 m FORWARD of any metal. It was wrong before the wing
    // was rebuilt too — 35 degrees of sweep on a 15.9 m half-span carries the
    // tip a long way aft, the same trap the 747's tip points fell into twice.
    Object.freeze({ x: -6.44, y: 0.3, z: 15.85 }),
    Object.freeze({ x: -6.44, y: 0.3, z: -15.85 }),
    // y 5.5: the tailplane bullet's top on a T-tail, after the fin came down
    // 1.04 m to put the aeroplane on its published 8.2 m height. This point
    // and `FIN_TIP_Y` in bizjetVisual move together.
    Object.freeze({ x: -16, y: 5.5, z: 0 }),
    Object.freeze({ x: -18.5, y: 0.6, z: 0 }),
  ]),
});


/**
 * The Boeing 747-8 Intercontinental: four GEnx-2B67 turbofans under a swept
 * low wing, with the raised forward deck that makes the shape unmistakable.
 *
 * Flown at 250 tonnes rather than its 447,700 kg maximum take-off mass, for
 * the same reason the Global is flown light: the airfield in this game has a
 * 1,320 m runway, and at MTOW this aeroplane needs 2,383 m to reach 5 m AGL —
 * it simply does not fit. At 250 t `scripts/aircraft-performance.mts` lifts it
 * off in 955 m and stops it in 747 m, which is MORE margin than the Global
 * 8000 has (1,185 m and 465 m). The heaviest aeroplane in the game being the
 * one with the most comfortable field performance is counter-intuitive, and it
 * is what four 296 kN engines on 554 m^2 of wing produce.
 *
 * Every figure here was flown through the same harness as the other three
 * before the aeroplane had any geometry, precisely so the question "does it
 * fit" was settled before anyone modelled a fuselage.
 */
export const BOEING_747_8: Readonly<AircraftDefinition> = Object.freeze({
  kind: "airliner",
  name: "Boeing 747-8",
  propulsion: "jet",
  mass: 250_000,
  wingArea: 554,
  wingSpan: 68.4,
  meanChord: 9,
  // Roll (+X), yaw (+Y) and pitch (+Z), from the 747's published inertias
  // (NASA CR-2144, Heffley & Jewell, quoted in Nelson's appendix B: 18.2, 33.1
  // and 49.7 million slug ft^2 about roll, pitch and yaw at 636,600 lb, a
  // 747-100). Kept as the radii of gyration those imply (0.311 of the
  // semi-span, 0.353 of the half-length, 0.469 of the mean half-dimension) and
  // applied to this aeroplane's mass, span and length. The figures this
  // replaces were 62%, 56% and 46% of that, so the aeroplane rotated in pitch
  // and yaw about a third faster than a 747 can, and its dutch roll had the
  // period of a business jet's.
  inertia: Object.freeze({ x: 28_100_000, y: 71_900_000, z: 45_300_000 }),
  maxEnginePower: 0,
  // 4 x GEnx-2B67 at 296 kN.
  maxStaticThrust: 1_184_000,
  propellerEfficiency: 0,
  idleRpm: 22,
  maxRpm: 100,
  clZero: 0.14,
  clAlpha: 5.08,
  positiveStallAngle: (14 * Math.PI) / 180,
  negativeStallAngle: (-11 * Math.PI) / 180,
  flapLift: 1.1,
  cdZero: 0.018,
  inducedDrag: 0.047,
  stallDrag: 0.85,
  flapDrag: 0.13,
  gearDrag: 0.025,
  speedBrakeDrag: 0.1,
  groundSpoilers: true,
  retractableGear: true,
  // Eighteen wheels on five legs take their time.
  gearCycleRate: 0.1,
  transonicOnsetMach: 0.84,
  transonicDragRise: 0.05,
  sideForceBeta: 0.95,
  sideForceRudder: 0.12,
  pitchMomentZero: 0.006,
  pitchMomentAlpha: -0.95,
  pitchMomentElevator: 0.5,
  pitchDamping: -30,
  rollMomentAileron: 0.04,
  rollMomentBeta: 0.06,
  rollDamping: -0.95,
  yawMomentRudder: 0.08,
  yawMomentBeta: 0.15,
  yawDamping: -0.55,
  afterburner: null,
  // The GEnx-2B is a 7.4:1 bypass turbofan.
  jetLapse: Object.freeze({ cycle: "high-bypass", throttleRatio: 1 }),
  // The real aeroplane has four main bogies; two wing-root legs stand in for
  // them, at the track the outer pair actually sits at.
  //
  // Wheels at y -6.4, not -5.2. Measured across the fleet, clearance between
  // the lowest structure and the wheels runs 0.50 m on the 150 (6.8% of its
  // length), 0.68 m on the F-16 (4.5%) and 1.20 m on the Global (3.6%). At
  // -5.2 this aeroplane had 1.60 m, which is 2.2% — a clear outlier below the
  // trend, and it showed: with the gear down the 747 had almost no visible
  // undercarriage and read as squatting on its belly. -6.4 gives 2.80 m, or
  // 3.9%, which sits between the Global and the F-16 and is about right for a
  // type whose main-deck sill is nearly 5 m off the ground. It also opens the
  // tail-strike limit from 10.4 to 12.2 degrees, which is margin in the right
  // direction.
  gear: Object.freeze([
    Object.freeze({
      position: Object.freeze({ x: -3, y: -6.4, z: -6.3 }),
      retractedPosition: Object.freeze({ x: -2.8, y: -3.2, z: -4 }),
      springRate: 9_000_000,
      dampingRate: 900_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: -3, y: -6.4, z: 6.3 }),
      retractedPosition: Object.freeze({ x: -2.8, y: -3.2, z: 4 }),
      springRate: 9_000_000,
      dampingRate: 900_000,
    }),
    Object.freeze({
      position: Object.freeze({ x: 22.6, y: -6.4, z: 0 }),
      retractedPosition: Object.freeze({ x: 21.8, y: -3.4, z: 0 }),
      springRate: 5_000_000,
      dampingRate: 520_000,
      maxSteeringAngle: (12 * Math.PI) / 180,
    }),
  ]),
  // Radome, upper deck, belly, both wingtips, fin tip and tailcone, on a
  // 76.3 m fuselage. The tailcone at -38 against mains at -3 gives a
  // tail-strike limit of 10.4 degrees; a full-power rotation at 250 t reaches
  // 7.4, and it is 9.0 even at MTOW, so the margin narrows with weight but
  // never closes.
  airframeContactPoints: Object.freeze([
    // The radome's crown and keel at x 33.9, 4-5 mm inside the metal: the nose
    // closes on a rounded tip at x 34, y -0.25 (`NOSE_SECTIONS`), where it used
    // to end on a flat disc spanning -0.41 to +0.21 at x 34.
    Object.freeze({ x: 33.9, y: 0.16, z: 0 }),
    Object.freeze({ x: 33.9, y: -0.62, z: 0 }),
    Object.freeze({ x: 26, y: 4.4, z: 0 }),
    Object.freeze({ x: 0, y: -3.6, z: 0 }),
    // x -17.4, and this point has now been measured against the built wing
    // twice. It began at -6, which sat 9.25 m from the tip's own mid-chord and
    // 1.7 m below it — a wingtip strike detected against a phantom nine metres
    // ahead of the wing. Corrected to -15.1, and then the raked tip was
    // rebuilt to a true 60-degree outer panel, which carried the tip 2.2 m
    // further aft again. Measured at the |z| > 34 station the chord now runs
    // x -18.40 to -16.28 at y 0.29 to 0.71, so mid-chord is (-17.34, 0.50).
    //
    // The lesson, twice over: 37.5 degrees of sweep on a 34 m half-span puts
    // the tip a very long way behind the root, and any tip coordinate written
    // down before the wing exists will be wrong. Same trap as the Global's
    // lamp table.
    Object.freeze({ x: -17.4, y: 0.35, z: 34.2 }),
    Object.freeze({ x: -17.4, y: 0.35, z: -34.2 }),
    // y 13.0, not 14.2. The fin was built to 14.2 when the wheels sat at
    // y -5.2; lengthening the gear to -6.4 to get the undercarriage out from
    // under the belly raised the whole aeroplane and left it 20.60 m tall
    // against a published 19.40. Ground-to-fin-tip is wheels-to-CG plus
    // CG-to-fin, so the fin comes down by exactly what the gear went down.
    Object.freeze({ x: -33, y: 13.0, z: 0 }),
    Object.freeze({ x: -38, y: 1.2, z: 0 }),
  ]),
});

const AIRCRAFT_DEFINITIONS: Readonly<Record<AircraftKind, Readonly<AircraftDefinition>>> =
  Object.freeze({
    trainer: LIGHT_TRAINER,
    jet: FAST_JET,
    bizjet: GLOBAL_8000,
    airliner: BOEING_747_8,
  });

export function aircraftDefinition(kind: AircraftKind): Readonly<AircraftDefinition> {
  return AIRCRAFT_DEFINITIONS[kind] ?? LIGHT_TRAINER;
}

/**
 * Mattingly's installed-thrust lapse: thrust available at this flight
 * condition as a fraction of the sea-level static figure. See
 * `JetLapseDefinition` for the model and its source.
 *
 * `reheat` selects the low-bypass engine's maximum (afterburning) rating
 * rather than its military (dry) one; each is a fraction of ITS OWN sea-level
 * static thrust, so both read exactly 1 standing still at sea level.
 */
export function jetThrustLapse(
  lapse: JetLapseDefinition,
  airDensity: number,
  forwardAirspeed: number,
  reheat = false,
): number {
  if (!(airDensity > 0)) return 0;
  const mach = Math.max(0, forwardAirspeed) / speedOfSoundForDensity(airDensity);
  const ram = 1 + 0.2 * mach * mach;
  const theta0 = (standardTemperatureForDensity(airDensity) / SEA_LEVEL_TEMPERATURE) * ram;
  // p / p_SL = (rho / rho_SL) * (T / T_SL), which is exactly 1 at sea level.
  const delta0 = (airDensity / SEA_LEVEL_DENSITY) * (theta0 / ram) * ram ** 3.5;
  const overLimit = Math.max(0, theta0 - lapse.throttleRatio);
  const lapseFraction = lapse.cycle === "high-bypass"
    ? 1 - 0.49 * Math.sqrt(mach) - (3 * overLimit) / (1.5 + mach)
    : 1 - ((reheat ? 3.5 : 3.8) * overLimit) / theta0;
  return Math.max(0, delta0 * lapseFraction);
}

/**
 * Returns installed thrust without conflating propeller shaft power and jet
 * thrust. Propeller output remains power-limited at speed; a jet follows its
 * engine cycle's lapse with altitude and Mach (`jetThrustLapse`).
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
    const lapse = aircraft.jetLapse;
    if (!lapse) return 0;
    const dryLapse = jetThrustLapse(lapse, airDensity, forwardAirspeed);
    const dry = commandedThrottle * aircraft.maxStaticThrust * dryLapse;
    if (!aircraft.afterburner) return dry;
    // Reheat ramps across the throttle remaining above the gate, so the last
    // fraction of travel is where the aeroplane transforms. What it adds is the
    // gap between the engine's wet and dry ratings at THIS flight condition,
    // which lapse differently: the nozzle's share grows with ram. Never
    // negative, because lighting the burner does not take thrust away.
    const reheatFraction = clamp(
      (commandedThrottle - aircraft.afterburner.engageThrottle)
        / Math.max(1e-6, 1 - aircraft.afterburner.engageThrottle),
      0,
      1,
    );
    if (!(reheatFraction > 0)) return dry;
    const wetRated = (aircraft.maxStaticThrust + aircraft.afterburner.thrustBoost)
      * jetThrustLapse(lapse, airDensity, forwardAirspeed, true);
    const dryRated = aircraft.maxStaticThrust * dryLapse;
    return dry + reheatFraction * Math.max(0, wetRated - dryRated);
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
