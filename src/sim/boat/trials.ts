import type { FlightMode } from "@/src/game/types";
import { NEUTRAL_BOAT_CONTROLS } from "../surface/types";
import { BoatSimulator, createCaptiveLoads, type BoatEnvironment, type BoatTelemetry } from "./boatSimulator";

/**
 * Sea trials of the Runabout 21 in calm, windless deep water, run the way a
 * boat test runs them: the probe script prints them and
 * `tests/sim.boat-performance.test.ts` holds them to the plan's targets.
 *
 * The rpm-speed targets are the plan's two published trials, which bracket
 * the Runabout 21: BoatTEST's 21.5 ft sterndrive at 1,798 kg and Yamaha's
 * F200 bulletin for a 23 ft outboard hull at 1,898 kg (the plan's chart, read
 * in mph and converted). Both drives make about 15% more pitch speed per
 * crank rpm than the Runabout's 19 in propeller on 1.85:1 (BoatTEST makes
 * 39.7 kn at 4,800 rpm, where this drive turns 5,520 rpm for the same slip),
 * so their rpm is multiplied by `TRIAL_RPM_SCALE` and their speed kept. Read
 * off unscaled, "on the plane by 16 kn at 2,500 rpm" asks this propeller for
 * 16 kn at 24% slip, about 1.1 kN of thrust, where Savitsky's equations give
 * the hull 3 kN of drag at the end of the hump.
 *
 * Yamaha's rows above 5,000 rpm scale past this engine's full-throttle rpm;
 * the plan's top-speed target (39-43 kn at 5,600-5,800 rpm) stands for them.
 */
export const TRIAL_RPM_SCALE = 1.15;

export interface BoatTrialRow {
  /** Trial crank rpm, as published. */
  readonly trialRpm: number;
  /** Speed through the water in each trial, knots, where it has the row. */
  readonly boatTest: number | null;
  readonly yamaha: number | null;
}

export const BOAT_TRIAL_TABLE: readonly BoatTrialRow[] = Object.freeze([
  { trialRpm: 600, boatTest: 3.0, yamaha: null },
  { trialRpm: 1_000, boatTest: 4.9, yamaha: 4.3 },
  { trialRpm: 1_500, boatTest: 6.5, yamaha: 6.2 },
  { trialRpm: 2_000, boatTest: 7.8, yamaha: 7.7 },
  { trialRpm: 2_500, boatTest: 16.0, yamaha: 14.5 },
  { trialRpm: 3_000, boatTest: 23.4, yamaha: 21.8 },
  { trialRpm: 3_500, boatTest: 28.4, yamaha: 27.0 },
  { trialRpm: 4_000, boatTest: 33.0, yamaha: 31.9 },
  { trialRpm: 4_500, boatTest: 37.1, yamaha: 36.5 },
  { trialRpm: 4_800, boatTest: 39.7, yamaha: null },
]);

/** A row's speed band: 10% under the slower trial to 10% over the faster. */
export function trialBand(row: BoatTrialRow): { low: number; high: number; mean: number } {
  const speeds = [row.boatTest, row.yamaha].filter((v): v is number => v !== null);
  const low = Math.min(...speeds);
  const high = Math.max(...speeds);
  return { low: 0.9 * low, high: 1.1 * high, mean: speeds.reduce((a, b) => a + b, 0) / speeds.length };
}

export const KNOT = 0.514444;
const STEP = 1 / 120;
const MPH_30 = (30 * 0.44704) / KNOT;

export interface TrialOptions {
  mode?: FlightMode;
  environment?: BoatEnvironment;
  /** Engine trim at the start, degrees; Pilot and Direct then keep it, Scenic's Active Trim moves it. */
  trimDegrees?: number;
}

function trialBoat(options: TrialOptions, speed = 0): BoatSimulator {
  const boat = new BoatSimulator({
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    moored: false,
    speed,
    gear: speed > 0 ? "forward" : "neutral",
    ...(options.trimDegrees === undefined ? {} : { trimDegrees: options.trimDegrees }),
  });
  boat.setEnvironment(options.environment ?? {});
  return boat;
}

export interface SteadyPoint {
  /** Crank rpm held. */
  rpm: number;
  knots: number;
  /** Running trim, degrees, and apparent slip against the propeller's pitch. */
  trimDegrees: number;
  slip: number;
  lever: number;
  dynamicLiftShare: number;
}

/**
 * Steady speed at each crank rpm, holding the rpm with the lever the way a
 * trial driver sets it off the tachometer. One boat runs the rpm list in the
 * order given, settling `settleSeconds` at each and averaging the last
 * `averageSeconds`.
 */
export function steadySpeeds(
  rpms: readonly number[],
  options: TrialOptions & { settleSeconds?: number; averageSeconds?: number } = {},
): SteadyPoint[] {
  const boat = trialBoat(options);
  const definition = boat.definition;
  const pitchSpeedPerRpm = definition.propeller.pitch / (60 * definition.propeller.gearRatio);
  const controls = { assist: options.mode ?? "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 0.2 } };
  const settle = options.settleSeconds ?? 24;
  const average = options.averageSeconds ?? 4;
  const telemetry = boat.telemetry();
  const points: SteadyPoint[] = [];
  for (const rpm of rpms) {
    let knots = 0;
    let trim = 0;
    let lift = 0;
    let rpmSum = 0;
    let samples = 0;
    for (let t = 0; t < settle; t += STEP) {
      boat.telemetry(telemetry);
      // A gentle PI on the lever: the throttle opens past the detent at 0.15.
      const error = (rpm - telemetry.rpm) / 1000;
      controls.boat.lever = Math.min(1, Math.max(0.16, controls.boat.lever + error * 0.25 * STEP));
      boat.setControls(controls);
      boat.step(STEP);
      if (t >= settle - average) {
        boat.telemetry(telemetry);
        knots += telemetry.speedThroughWater / KNOT;
        trim += telemetry.runningTrim;
        lift += telemetry.dynamicLiftShare;
        rpmSum += telemetry.rpm;
        samples += 1;
      }
    }
    const held = rpmSum / samples;
    const speed = knots / samples;
    points.push({
      rpm: held,
      knots: speed,
      trimDegrees: ((trim / samples) * 180) / Math.PI,
      slip: 1 - (speed * KNOT) / (held * pitchSpeedPerRpm),
      lever: controls.boat.lever,
      dynamicLiftShare: lift / samples,
    });
  }
  return points;
}

export interface AccelerationTrial {
  /** From the lever slammed forward at rest: seconds to 16 kn (on the plane, as the plan has it), to half the weight on planing lift, and to 30 mph. */
  toPlane: number;
  toHalfLift: number;
  toThirtyMph: number;
  /** Peak running trim through the hump, degrees. */
  humpTrimDegrees: number;
  /** Settled at full throttle. */
  top: BoatTelemetry;
  topKnots: number;
  topTrimDegrees: number;
}

export function fullThrottleAcceleration(options: TrialOptions & { seconds?: number } = {}): AccelerationTrial {
  const boat = trialBoat(options);
  boat.setControls({ assist: options.mode ?? "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 1 } });
  const telemetry = boat.telemetry();
  let toPlane = NaN;
  let toHalfLift = NaN;
  let toThirty = NaN;
  let humpTrim = 0;
  const seconds = options.seconds ?? 40;
  for (let i = 1; i * STEP <= seconds; i += 1) {
    boat.step(STEP);
    boat.telemetry(telemetry);
    const knots = telemetry.speedThroughWater / KNOT;
    const t = i * STEP;
    if (knots < 20) humpTrim = Math.max(humpTrim, telemetry.runningTrim);
    if (Number.isNaN(toPlane) && knots >= 16) toPlane = t;
    if (Number.isNaN(toHalfLift) && knots > 10 && telemetry.dynamicLiftShare > 0.5) toHalfLift = t;
    if (Number.isNaN(toThirty) && knots >= MPH_30) toThirty = t;
  }
  return {
    toPlane,
    toHalfLift,
    toThirtyMph: toThirty,
    humpTrimDegrees: (humpTrim * 180) / Math.PI,
    top: { ...telemetry },
    topKnots: telemetry.speedThroughWater / KNOT,
    topTrimDegrees: (telemetry.runningTrim * 180) / Math.PI,
  };
}

export interface CoastDownTrial {
  /** Seconds from the throttle chopped at `fromMph` to below `toKnots`. */
  seconds: number;
  /** The speed after 2 s, knots: how hard the bow drops and the boat squats. */
  knotsAfterTwoSeconds: number;
}

/** Running at `fromMph`, the lever pulled back to idle ahead (in gear, as a driver chops it). */
export function throttleChop(options: TrialOptions & { fromMph?: number; toKnots?: number } = {}): CoastDownTrial {
  const fromKnots = ((options.fromMph ?? 40) * 0.44704) / KNOT;
  const toKnots = options.toKnots ?? 7;
  // Hold the speed at the rpm that gives it, then chop.
  const boat = trialBoat(options, fromKnots * KNOT);
  const controls = { assist: options.mode ?? "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: 0.75 } };
  const telemetry = boat.telemetry();
  for (let t = 0; t < 20; t += STEP) {
    boat.telemetry(telemetry);
    const error = (fromKnots - telemetry.speedThroughWater / KNOT) / 10;
    controls.boat.lever = Math.min(1, Math.max(0.16, controls.boat.lever + error * 0.4 * STEP));
    boat.setControls(controls);
    boat.step(STEP);
  }
  controls.boat.lever = 0.1;
  boat.setControls(controls);
  let seconds = NaN;
  let afterTwo = NaN;
  for (let i = 1; i * STEP <= 30; i += 1) {
    boat.step(STEP);
    boat.telemetry(telemetry);
    const knots = telemetry.speedThroughWater / KNOT;
    if (Number.isNaN(afterTwo) && i * STEP >= 2) afterTwo = knots;
    if (Number.isNaN(seconds) && knots < toKnots) seconds = i * STEP;
  }
  return { seconds, knotsAfterTwoSeconds: afterTwo };
}

export interface TowPoint {
  knots: number;
  /** Running trim, degrees, and CG height above the still water, m. */
  trimDegrees: number;
  cgHeight: number;
  /** Horizontal tow force through the CG, N. */
  drag: number;
  dynamicLiftShare: number;
  wettedLength: number;
}

/**
 * The towing tank: the hull held at a speed, free to heave and trim, towed
 * horizontally through its CG (Savitsky's case), with or without the outboard
 * and windage. Bisection, since the strip forces are not smooth.
 */
export function towEquilibrium(knots: number, options: { bareHull?: boolean; boat?: BoatSimulator } = {}): TowPoint {
  const boat = options.boat ?? new BoatSimulator();
  const out = createCaptiveLoads();
  const speed = knots * KNOT;
  const pose = { cgHeight: 0, trim: 0, speed, thrust: false, bareHull: options.bareHull ?? true };
  const vertical = () => out.force.x * Math.sin(pose.trim) + out.force.y * Math.cos(pose.trim);
  const heave = (trim: number) => {
    pose.trim = trim;
    let lo = -0.8;
    let hi = 1.2;
    for (let k = 0; k < 40; k += 1) {
      pose.cgHeight = 0.5 * (lo + hi);
      boat.captiveLoads(pose, out);
      if (vertical() > 0) lo = pose.cgHeight;
      else hi = pose.cgHeight;
    }
    pose.cgHeight = 0.5 * (lo + hi);
    boat.captiveLoads(pose, out);
    return out.moment.z;
  };
  const DEG = Math.PI / 180;
  // Bow-up moment at too little trim, bow-down at too much: the first crossing from the bottom.
  let lo = -2 * DEG;
  let mLo = heave(lo);
  let hi = lo;
  for (let t = -1.5; t <= 16; t += 0.5) {
    hi = t * DEG;
    const m = heave(hi);
    if (mLo > 0 && m <= 0) break;
    lo = hi;
    mLo = m;
  }
  for (let k = 0; k < 30; k += 1) {
    const mid = 0.5 * (lo + hi);
    if (heave(mid) > 0) lo = mid;
    else hi = mid;
  }
  heave(0.5 * (lo + hi));
  const weight = boat.definition.mass * 9.80665;
  return {
    knots,
    trimDegrees: pose.trim / DEG,
    cgHeight: pose.cgHeight,
    drag: -(out.force.x * Math.cos(pose.trim) - out.force.y * Math.sin(pose.trim)),
    dynamicLiftShare: out.dynamicLift / weight,
    wettedLength: out.wettedLength,
  };
}
