import {
  calculateEngineThrust,
  stallSpeed,
  type AircraftDefinition,
} from "./aircraft";
import {
  sampleDubinsPath,
  shortestDubinsPath,
  wrapAngle,
  type DubinsPath,
  type PathSample,
} from "./dubins";
import { clamp, moveToward, rotateVectorInto } from "./math";
import { SEA_LEVEL_DENSITY } from "./atmosphere";
import { TYRE_CORNERING_STIFFNESS, WHEEL_BRAKE_FRICTION } from "./simulation";
import type { FlightControls, FlightState, FlightTelemetry, Vec3 } from "./types";

/**
 * Autoland: flies the aeroplane from wherever it is to a stop on a runway.
 *
 * **It flies THROUGH the flight model, never around it.** Everything here is a
 * control law that writes the same eight `FlightControls` a pilot writes; the
 * simulator then integrates them exactly as it integrates a pilot's. Nothing
 * moves the aeroplane, rotates it or changes its speed directly, so every
 * physical limit the flight model has -- stall, thrust, drag, inertia,
 * actuator rates, gear and flap travel times, ground friction -- binds the
 * autopilot exactly as it binds a pilot.
 *
 * On top of what the physics forbids, the laws keep inside the aeroplane's
 * published-style envelope: a bank limit (and so a turn radius) the path
 * planner builds every turn from, an angle-of-attack ceiling below the stall,
 * a load-factor limit, a tail-strike pitch limit and a wingtip bank limit near
 * the ground, both measured off the airframe's own contact points, flap and
 * gear extension speeds, and a touchdown sink rate a passenger would call
 * gentle.
 *
 * **Structure.**
 *  1. A PLANNER (`plan`) chooses the landing direction and the length of the
 *     final approach, and joins the aeroplane's current position and track to
 *     the start of that final with the shortest path built from turns of the
 *     aeroplane's own radius (`dubins.ts`). It checks the path against the
 *     energy the aeroplane can lose -- height and speed together -- and
 *     against the terrain under it. A start from which a landing is physically
 *     impossible (too close, too high, too fast, pointing the wrong way) has no
 *     short plan, so the planner picks a longer one: an extended final, a loop,
 *     or orbits to lose height. That is the "loop around and try again".
 *  2. GUIDANCE follows the path: lateral L1 guidance (Park, Deyst & How, 2004)
 *     on the ground track, which handles wind and turns with one law, and a
 *     vertical profile that becomes the 3-degree glideslope on final.
 *  3. INNER LOOPS turn bank, flight-path and speed demands into surfaces and
 *     throttle by inverting the flight model's own moment and force equations
 *     (nonlinear dynamic inversion). One set of laws flies a 726 kg Cessna and
 *     a 250 t 747, because the per-aeroplane numbers come from the aeroplane's
 *     definition rather than from tuning.
 *  4. A STATE MACHINE sequences approach, final, flare, rollout and stop, and
 *     watches stabilised-approach gates. Failing one -- off the glideslope or
 *     centreline, too fast, too slow, sinking too fast, not configured, landing
 *     long, bouncing -- is a GO-AROUND: full power, climb, clean up, and plan a
 *     new approach from wherever the climb ends.
 *
 * **Cost.** `update` allocates nothing: the path is held in preallocated typed
 * arrays and every per-step quantity is a local. Planning (the only work that
 * scales with path length) runs at engagement, after a go-around, and at most
 * once every `REPLAN_INTERVAL_SECONDS` while still joining the final.
 */

const DEG = Math.PI / 180;
const GRAVITY = 9.80665;

/** The 3-degree glideslope every runway here is surveyed for (PAPI, markings). */
export const AUTOLAND_GLIDESLOPE_RADIANS = 3 * DEG;
/**
 * The nominal touchdown aim point, metres beyond the threshold. The runway's
 * aiming point markings and its PAPI both sit 300 m in (`runwayMarkingProfile`),
 * so the trainer's glidepath aims there; heavier aeroplanes aim a little short
 * of it (`AutolandProfile.aimPoint`), and the flare carries every touchdown a
 * little beyond its aim.
 */
export const AUTOLAND_AIM_FROM_THRESHOLD = 300;
/** How often the planner looks for a better join while not yet on final. */
export const REPLAN_INTERVAL_SECONDS = 6;
/**
 * Approaches flown before the autopilot gives up and climbs away to hold. Not
 * a physical limit: a guard against a pathological runway (gusts, terrain)
 * turning into an endless circuit nobody asked for.
 */
export const AUTOLAND_MAX_ATTEMPTS = 6;

const PATH_CAPACITY = 16_384;
const PATH_SPACING = 10;
const TERRAIN_FLOOR_SPACING = 300;
const TERRAIN_FLOOR_CAPACITY = 1_024;
/**
 * Distance from each threshold inside which the approach surface is certified
 * clear (`sampleApproaches` in airportSite.ts, and the spawned-airport limits).
 */
const CERTIFIED_APPROACH_METERS = 4_000;
/** Go-around climb-out leg drawn past the far end of the runway. */
const CLIMB_OUT_METERS = 6_000;
/** Highest en-route speed the autoland flies, indicated: 250 kt. */
const ENROUTE_SPEED_CAP = 128.6;
/** Seconds ahead along the ground track at which the terrain look-ahead samples. */
const LOOKAHEAD_SECONDS = [0, 8, 16, 24, 36, 48, 60] as const;
const LOOKAHEAD_INTERVAL_SECONDS = 0.5;
/** Rollout centreline loop: natural frequency (rad/s) and damping ratio. */
const ROLLOUT_STEER_OMEGA = 0.25;
const ROLLOUT_STEER_DAMPING = 0.85;
/**
 * The most the rollout points the nose off the runway's heading to regain the
 * centreline, and the groundspeeds over which that fades to nothing: below
 * the lower one it only holds the runway heading, so the aeroplane stops
 * parallel to the runway wherever across it that is.
 */
const ROLLOUT_MAX_HEADING_OFFSET = 3 * DEG;
const ROLLOUT_ALIGN_SPEEDS = [8, 18] as const;
/**
 * The autobrake's least deceleration, m/s^2: 0.36 g, an airliner's highest
 * landing setting, and well inside what the tyres give (`brakingDeceleration`,
 * about 0.6 g). And how fast it comes on, in full brake per second.
 */
const AUTOBRAKE_DECELERATION = 3.5;
const AUTOBRAKE_RAMP = 1.5;

export type AutolandPhase =
  | "off"
  | "approach"
  | "final"
  | "flare"
  | "rollout"
  | "landed"
  | "go-around";

export type GoAroundReason =
  | "glideslope"
  | "centreline"
  | "speed-high"
  | "speed-low"
  | "sink-rate"
  | "unconfigured"
  | "bank"
  | "long-landing"
  | "bounce"
  | "terrain";

/**
 * The runway shape autoland needs: an `AirportDefinition` satisfies it, and so
 * does anything else with a centre, an axis and a size.
 */
export interface AutolandRunway {
  readonly centerX: number;
  readonly centerZ: number;
  readonly elevation: number;
  /** Runway axis, clockwise from world north (+z): the simulator's heading. */
  readonly headingRadians: number;
  readonly runwayLength: number;
  readonly runwayWidth: number;
}

export interface AutolandInput {
  readonly state: FlightState;
  readonly telemetry: FlightTelemetry;
  /**
   * Terrain (or sea-bed) height. Autoland maxes it against `seaLevel` itself,
   * as the attract supervisor does, so a coastline does not read as a cliff.
   */
  readonly terrainHeight: (x: number, z: number) => number;
  readonly seaLevel: number;
  readonly dt: number;
}

/** What the HUD and tests read. Plain data, safe to copy into a snapshot. */
export interface AutolandStatus {
  phase: AutolandPhase;
  /** Approach number, from 1. Every go-around starts the next one. */
  attempt: number;
  /** Track distance still to fly to the touchdown aim point, metres. NaN when off. */
  distanceToTouchdown: number;
  /** Landing direction, radians, simulator heading convention. */
  runwayHeading: number;
  /** Airspeed the autothrottle is holding, EAS m/s. */
  targetAirspeed: number;
  /** The approach speed for the landing configuration, EAS m/s. */
  approachSpeed: number;
  /** Why the most recent go-around was flown, or null. */
  goAroundReason: GoAroundReason | null;
  /** Main-gear sink rate at the most recent touchdown, m/s. NaN before one. */
  touchdownSinkRate: number;
  /** Touchdown distance beyond the threshold, metres. NaN before one. */
  touchdownDistance: number;
  /** Highest angle of attack flown while engaged, radians. */
  peakAngleOfAttack: number;
  /** Largest bank flown while engaged, radians. */
  peakBank: number;
}

/**
 * Per-aeroplane limits and schedules, derived once from the definition. Every
 * number here is a consequence of the airframe's own coefficients and
 * geometry, so a new aeroplane gets an autoland without anyone tuning it.
 */
export interface AutolandProfile {
  /** 1 g stall, clean and landing flap, EAS. */
  readonly stallClean: number;
  readonly stallLanding: number;
  /** 1.3 x the landing-flap stall: the reference landing speed. */
  readonly referenceSpeed: number;
  /** Clean manoeuvring speed for the pattern. */
  readonly patternSpeed: number;
  /** Flap extension limits, EAS. */
  readonly halfFlapLimit: number;
  readonly fullFlapLimit: number;
  /** Bank the planner sizes every turn at, and the most the guidance will fly. */
  readonly planBank: number;
  readonly maxBank: number;
  /** Bank limit near the ground: a fraction of the wingtip-strike angle. */
  readonly groundBank: number;
  readonly maxLoadFactor: number;
  /** Angle-of-attack ceiling, a margin below the stall. */
  readonly maxAngleOfAttack: number;
  /** Pitch limit with the main gear on (or near) the ground: tail strike less a margin. */
  readonly maxFlarePitch: number;
  /** Seconds-constant of the exponential flare, and the sink it ends at. */
  readonly flareTau: number;
  readonly touchdownSink: number;
  /** Specific-energy gradient the aeroplane can shed, idle and fully drag-configured. */
  readonly energyGradient: number;
  readonly descentGradient: number;
  readonly climbGradient: number;
  /** Shortest final the approach is planned with, seconds of flight at approach speed. */
  readonly finalSeconds: number;
  /** Seconds the gear takes to lock down. */
  readonly gearSeconds: number;
  /** Highest throttle the autothrottle uses: the dry limit on an afterburning engine. */
  readonly maxThrottle: number;
  /** Inner-loop bandwidth divisor: 1 for the trainer, larger for heavier aeroplanes. */
  readonly gainScale: number;
  /** Lowest gear point below the CG with the gear down, metres (positive). */
  readonly gearDrop: number;
  /**
   * Where the glidepath meets the runway, metres past the threshold. The
   * markings' 300 m for the trainer, shorter for heavier aeroplanes, whose
   * longer flare floats them further and whose brakes stop them slower.
   */
  readonly aimPoint: number;
  /**
   * Deceleration full wheel brakes give on a dry runway: the brakes' friction
   * on the main gear's share of the weight (the nosewheel is unbraked).
   */
  readonly brakingDeceleration: number;
}

function isNoseGear(aircraft: AircraftDefinition, index: number): boolean {
  return aircraft.gear[index]?.maxSteeringAngle !== undefined;
}

export function autolandProfile(aircraft: AircraftDefinition): AutolandProfile {
  const stallClean = stallSpeed(aircraft, 0);
  const stallLanding = stallSpeed(aircraft, 1);
  const referenceSpeed = 1.3 * stallLanding;
  const patternSpeed = Math.max(1.3 * stallClean, referenceSpeed + 8);

  // Main gear: the legs without nosewheel steering. Tail strike is the pitch at
  // which any contact point aft of them reaches the runway with the mains on
  // it; wingtip strike the bank at which a tip reaches it over one main leg.
  let mainX = 0;
  let mainY = 0;
  let mainZ = 0;
  let mains = 0;
  let gearDrop = 0;
  let noseX = 0;
  aircraft.gear.forEach((leg, index) => {
    gearDrop = Math.max(gearDrop, -leg.position.y);
    if (isNoseGear(aircraft, index)) {
      noseX = leg.position.x;
      return;
    }
    mainX += leg.position.x;
    mainY += leg.position.y;
    mainZ = Math.max(mainZ, Math.abs(leg.position.z));
    mains += 1;
  });
  mainX /= Math.max(1, mains);
  mainY /= Math.max(1, mains);
  // The static share of the weight on the main gear, about the CG (x = 0).
  const mainShare = noseX > mainX ? clamp(noseX / (noseX - mainX), 0, 1) : 1;
  let tailStrike = 30 * DEG;
  let tipStrike = 30 * DEG;
  for (const point of aircraft.airframeContactPoints) {
    if (point.x < mainX) {
      tailStrike = Math.min(tailStrike, Math.atan2(point.y - mainY, mainX - point.x));
    }
    if (Math.abs(point.z) > mainZ + 0.5) {
      tipStrike = Math.min(tipStrike, Math.atan2(point.y - mainY, Math.abs(point.z) - mainZ));
    }
  }

  // Idle descent capability at the pattern speed with everything that makes
  // drag deployed: the gradient of specific energy (height + V^2/2g) the
  // aeroplane loses per metre flown is simply D/W.
  const dynamicPressure = 0.5 * SEA_LEVEL_DENSITY * patternSpeed * patternSpeed;
  const weight = aircraft.mass * GRAVITY;
  const speedBrake = aircraft.speedBrakeDrag > 0 ? 1 : 0;
  const lift = weight / (dynamicPressure * aircraft.wingArea * (1 - 0.12 * speedBrake));
  const drag = aircraft.cdZero
    + aircraft.inducedDrag * lift * lift
    + aircraft.speedBrakeDrag * speedBrake;
  const dragOverWeight = (drag * dynamicPressure * aircraft.wingArea) / weight;
  // The trainer is 1; the 747 2.6. Bandwidth falls with size as it does on real
  // aeroplanes, whose control power per unit inertia falls the same way.
  const gainScale = clamp((aircraft.mass / 726) ** (1 / 6), 1, 3);
  const heavy = aircraft.mass > 30_000;

  return {
    stallClean,
    stallLanding,
    referenceSpeed,
    patternSpeed,
    halfFlapLimit: 1.8 * stallClean,
    fullFlapLimit: 1.6 * stallLanding,
    planBank: (heavy ? 25 : 30) * DEG,
    maxBank: (heavy ? 30 : 35) * DEG,
    groundBank: Math.min(5 * DEG, 0.4 * tipStrike),
    maxLoadFactor: heavy ? 1.5 : 2,
    maxAngleOfAttack: aircraft.positiveStallAngle - 3 * DEG,
    maxFlarePitch: tailStrike - 2.5 * DEG,
    flareTau: 1.6 + 0.4 * gainScale,
    // Firmer for the 747: on a runway this short for it, the float a softer
    // touchdown costs is runway it needs for steering on the rollout.
    touchdownSink: aircraft.mass > 100_000 ? 0.9 : heavy ? 0.7 : 0.55,
    energyGradient: 0.6 * dragOverWeight,
    descentGradient: Math.min(Math.tan(4.5 * DEG), 0.6 * dragOverWeight),
    climbGradient: 0.04,
    finalSeconds: heavy ? 75 : 55,
    gearSeconds: aircraft.retractableGear && aircraft.gearCycleRate > 0 ? 1 / aircraft.gearCycleRate : 0,
    maxThrottle: aircraft.afterburner?.engageThrottle ?? 1,
    gainScale,
    gearDrop,
    aimPoint: AUTOLAND_AIM_FROM_THRESHOLD - 55 * (gainScale - 1),
    brakingDeceleration: WHEEL_BRAKE_FRICTION * GRAVITY * mainShare,
  };
}

/** Landing-direction geometry for one end of a runway. */
interface LandingEnd {
  heading: number;
  dirX: number;
  dirZ: number;
  thresholdX: number;
  thresholdZ: number;
  elevation: number;
  length: number;
  width: number;
}

function landingEnd(runway: AutolandRunway, reciprocal: boolean, out: LandingEnd): LandingEnd {
  const heading = wrapAngle(runway.headingRadians + (reciprocal ? Math.PI : 0));
  const dirX = Math.sin(heading);
  const dirZ = Math.cos(heading);
  out.heading = heading;
  out.dirX = dirX;
  out.dirZ = dirZ;
  out.thresholdX = runway.centerX - dirX * runway.runwayLength * 0.5;
  out.thresholdZ = runway.centerZ - dirZ * runway.runwayLength * 0.5;
  out.elevation = runway.elevation;
  out.length = runway.runwayLength;
  out.width = runway.runwayWidth;
  return out;
}

function emptyEnd(): LandingEnd {
  return { heading: 0, dirX: 0, dirZ: 1, thresholdX: 0, thresholdZ: 0, elevation: 0, length: 0, width: 0 };
}

function emptyStatus(): AutolandStatus {
  return {
    phase: "off",
    attempt: 0,
    distanceToTouchdown: Number.NaN,
    runwayHeading: 0,
    targetAirspeed: 0,
    approachSpeed: 0,
    goAroundReason: null,
    touchdownSinkRate: Number.NaN,
    touchdownDistance: Number.NaN,
    peakAngleOfAttack: 0,
    peakBank: 0,
  };
}

interface PlanCandidate {
  reciprocal: boolean;
  finalLength: number;
  path: DubinsPath;
  orbits: number;
  cost: number;
}

export class Autoland {
  readonly aircraft: AircraftDefinition;
  readonly profile: AutolandProfile;
  readonly status: AutolandStatus = emptyStatus();

  private runway: AutolandRunway | null = null;
  private readonly end: LandingEnd = emptyEnd();
  private readonly scratchEnd: LandingEnd = emptyEnd();

  // The planned ground track, flattened.
  private readonly pathX = new Float64Array(PATH_CAPACITY);
  private readonly pathZ = new Float64Array(PATH_CAPACITY);
  private readonly pathS = new Float64Array(PATH_CAPACITY);
  private pathCount = 0;
  private pathIndex = 0;
  /** Arc length at the start of the final approach, and at the aim point. */
  private finalS = 0;
  private aimS = 0;
  private turnRadius = 1;
  // The vertical profile before the final: from the plan's start height to the
  // final's, at a fixed gradient, never below the terrain floor.
  private profileStartHeight = 0;
  private profileFinalHeight = 0;
  private profileGradient = 0;
  private readonly terrainFloor = new Float64Array(TERRAIN_FLOOR_CAPACITY);
  private terrainFloorCount = 0;

  private replanTimer = 0;
  /** 0 en route, 1 pattern, 2 slowing to approach speed, 3 landing configuration. */
  private stage = 0;
  private gateTimer = 0;
  private phaseTime = 0;
  private flightPathIntegral = 0;
  private throttleIntegral = 0;
  private throttleCommand = 0;
  private speedBrakeCommand = 0;
  private flapCommand = 0;
  private gearCommand = 1;
  private trimHold = 0;
  private flareTau = 1;
  private lastGroundSpeed = 0;
  private measuredDeceleration = 0;
  private brakeIntegral = 0;
  private brakeRamp = 0;
  private readonly groundScratch = new Float64Array(TERRAIN_FLOOR_CAPACITY);
  /** Highest ground ahead along the actual track plus clearance, world metres. */
  private lookaheadFloor = -Infinity;
  private lookaheadTimer = Infinity;
  /** Climb rate through the air mass, m/s: the inertial one less the vertical wind. */
  private airVerticalSpeed = 0;
  private finalLength = 0;
  private enrouteSpeed = 0;
  private lastVerticalSpeed = 0;
  private windX = 0;
  private windZ = 0;
  private readonly vector: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(aircraft: AircraftDefinition) {
    this.aircraft = aircraft;
    this.profile = autolandProfile(aircraft);
  }

  get engaged(): boolean {
    return this.status.phase !== "off";
  }

  /**
   * Engages on a runway. Refused (returns false) on the ground: autoland lands
   * an aeroplane that is flying, it does not take one off.
   */
  engage(runway: AutolandRunway, input: AutolandInput, controls: FlightControls): boolean {
    if (input.state.onGround || input.state.crashed) return false;
    this.runway = runway;
    const status = this.status;
    Object.assign(status, emptyStatus());
    status.attempt = 1;
    this.trimHold = controls.trim;
    this.throttleCommand = input.state.actuators.throttle;
    this.throttleIntegral = 0;
    this.flightPathIntegral = 0;
    this.speedBrakeCommand = 0;
    this.flapCommand = input.state.actuators.flaps;
    this.gearCommand = this.aircraft.retractableGear ? controls.gear : 1;
    // Hold the speed it was engaged at, but no faster than 250 kt (or 1.4
    // times the pattern speed, if that is faster): a 400 kt 747 turns on a
    // 9 km radius, and at circuit height that radius is over the hills.
    this.enrouteSpeed = clamp(
      input.telemetry.indicatedAirspeed,
      this.profile.patternSpeed,
      Math.max(this.profile.patternSpeed * 1.4, ENROUTE_SPEED_CAP),
    );
    this.estimateWind(input, 1);
    this.lookaheadFloor = -Infinity;
    this.lookaheadTimer = Infinity;
    this.stage = 0;
    this.setPhase("approach");
    this.plan(input, true);
    return true;
  }

  disengage(): void {
    this.status.phase = "off";
    this.status.distanceToTouchdown = Number.NaN;
    this.runway = null;
    this.pathCount = 0;
  }

  /**
   * A new runway (a nearer airport appeared). Re-planned at once unless the
   * aeroplane is already committed to the one it is on.
   */
  retarget(runway: AutolandRunway, input: AutolandInput): void {
    if (!this.engaged || this.runway === runway) return;
    const phase = this.status.phase;
    if (phase !== "approach" && phase !== "go-around") return;
    this.runway = runway;
    if (phase === "approach") this.plan(input, true);
  }

  get targetRunway(): AutolandRunway | null {
    return this.runway;
  }

  private setPhase(phase: AutolandPhase): void {
    this.status.phase = phase;
    this.phaseTime = 0;
    this.gateTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /** Approach speed for the wind on the chosen end: Vref plus half the headwind, 1.5-5 m/s. */
  private approachSpeedFor(end: LandingEnd): number {
    const headwind = -(this.windX * end.dirX + this.windZ * end.dirZ);
    return this.profile.referenceSpeed + clamp(1.5 + 0.5 * headwind, 1.5, 5);
  }

  private glideslopeHeight(end: LandingEnd, distanceToAim: number): number {
    return end.elevation + distanceToAim * Math.tan(AUTOLAND_GLIDESLOPE_RADIANS);
  }

  /**
   * Chooses a landing direction and final length, and flattens the path to it.
   * `force` accepts the result unconditionally; otherwise it replaces the
   * current plan only if it is meaningfully shorter than what is left of it.
   */
  private plan(input: AutolandInput, force: boolean): void {
    const runway = this.runway;
    if (!runway) return;
    const { state, telemetry } = input;
    const profile = this.profile;
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const track = groundSpeed > 5
      ? Math.atan2(state.velocity.x, state.velocity.z)
      : telemetry.heading;
    const startX = state.position.x;
    const startZ = state.position.z;
    const height = this.gearHeight(state) + runway.elevation;
    const sigma = Math.max(0.05, state.dynamics.airDensity / SEA_LEVEL_DENSITY);
    const windSpeed = Math.hypot(this.windX, this.windZ);
    const planSpeed = Math.max(
      Math.min(state.dynamics.airspeed, this.enrouteSpeed / Math.sqrt(sigma)),
      profile.patternSpeed / Math.sqrt(sigma),
    ) + windSpeed;
    const radius = clamp((planSpeed * planSpeed) / (GRAVITY * Math.tan(profile.planBank)), 80, 6_000);
    const speedEnergy = (state.dynamics.airspeed ** 2) / (2 * GRAVITY);

    let best: PlanCandidate | null = null;
    let fallback: PlanCandidate | null = null;
    let fallbackExcess = Infinity;
    for (const reciprocal of [false, true]) {
      const end = landingEnd(runway, reciprocal, this.scratchEnd);
      const approachSpeed = this.approachSpeedFor(end);
      const approachTas = approachSpeed / Math.sqrt(sigma);
      const tailwind = this.windX * end.dirX + this.windZ * end.dirZ;
      const tailwindPenalty = 1 + 0.15 * Math.max(0, tailwind) + (tailwind > 4 ? 10 : 0);
      const minimumFinal = approachTas * profile.finalSeconds;
      const shortestFinal = approachTas * 30;
      const longestFinal = minimumFinal + 14_000;
      const clearFinal = this.longestClearFinal(end, longestFinal, input);
      for (let finalLength = shortestFinal; finalLength <= longestFinal; finalLength += finalLength < minimumFinal ? 400 : 1_000) {
        const goal = {
          x: end.thresholdX - end.dirX * finalLength,
          z: end.thresholdZ - end.dirZ * finalLength,
          heading: end.heading,
        };
        const path = shortestDubinsPath({ x: startX, z: startZ, heading: track }, goal, radius);
        if (!path) continue;
        const finalHeight = this.glideslopeHeight(end, finalLength + this.profile.aimPoint);
        // A final longer than the certified approach surface must clear the
        // terrain under it on its own.
        if (finalLength > clearFinal) continue;
        const level = Math.min(approachTas * 20, path.length * 0.3);
        const usable = Math.max(0, path.length - level);
        const drop = height - finalHeight;
        const energyExcess = Math.max(0, drop) + Math.max(0, speedEnergy - approachTas ** 2 / (2 * GRAVITY));
        const shortFinal = finalLength < minimumFinal;
        // A final shorter than the stabilised minimum is only for an aeroplane
        // that is already slow and close to the glidepath at that point.
        const slowEnough = !shortFinal || state.dynamics.airspeed < approachTas + 12;
        const feasible = slowEnough
          && energyExcess <= profile.energyGradient * usable + (shortFinal ? 0 : 25)
          && (drop <= 0 || drop <= profile.descentGradient * usable + 25)
          && (drop >= 0 || -drop <= profile.climbGradient * path.length + 25);
        const length = path.length + finalLength;
        const cost = length * tailwindPenalty * (shortFinal ? 1.15 : 1);
        if (feasible) {
          if (!best || cost < best.cost) best = { reciprocal, finalLength, path, orbits: 0, cost };
        } else if (drop > 0 && !shortFinal) {
          // Too high to make it in any reasonable distance: orbit to lose it.
          const excess = (energyExcess - profile.energyGradient * usable) / profile.energyGradient;
          const orbits = Math.ceil(Math.max(0, excess) / (2 * Math.PI * radius));
          const orbitCost = (length + orbits * 2 * Math.PI * radius) * tailwindPenalty;
          if (orbitCost < fallbackExcess) {
            fallbackExcess = orbitCost;
            fallback = { reciprocal, finalLength, path, orbits, cost: orbitCost };
          }
        }
      }
    }
    const chosen = best ?? fallback;
    if (!chosen) return;
    if (!force && this.pathCount > 0) {
      const remaining = this.aimS - this.pathS[this.pathIndex]!;
      // Changing direction is a big decision; keep the current end unless the
      // other is clearly better.
      const switching = landingEnd(runway, chosen.reciprocal, this.scratchEnd).heading !== this.end.heading;
      if (chosen.cost * (switching ? 1.2 : 1) > remaining * 0.97 - 100) return;
    }
    this.installPlan(chosen, radius, height, input);
  }

  /**
   * The longest final, out to `limit`, whose glidepath stays 60 m above the
   * ground beyond the certified approach surface. One walk out from the
   * threshold serves every candidate final on this end.
   */
  private longestClearFinal(end: LandingEnd, limit: number, input: AutolandInput): number {
    for (let along = CERTIFIED_APPROACH_METERS; along <= limit; along += 500) {
      const x = end.thresholdX - end.dirX * along;
      const z = end.thresholdZ - end.dirZ * along;
      const ground = Math.max(input.seaLevel, input.terrainHeight(x, z));
      if (ground + 60 > this.glideslopeHeight(end, along + this.profile.aimPoint)) return along - 1;
    }
    return limit;
  }

  private installPlan(chosen: PlanCandidate, radius: number, height: number, input: AutolandInput): void {
    const runway = this.runway!;
    const end = landingEnd(runway, chosen.reciprocal, this.end);
    this.turnRadius = radius;
    const samples: PathSample[] = [];
    if (chosen.orbits > 0) {
      const turn = chosen.path.kinds[0] === "L" ? "L" : "R";
      sampleDubinsPath({
        word: `${turn}SS`,
        kinds: [turn, "S", "S"],
        lengths: [chosen.orbits * 2 * Math.PI * radius, 0, 0],
        radius,
        length: chosen.orbits * 2 * Math.PI * radius,
        start: chosen.path.start,
      }, PATH_SPACING, samples);
    }
    sampleDubinsPath(chosen.path, PATH_SPACING, samples);
    const finalStart = samples[samples.length - 1]!;
    const finalS = finalStart.s;
    const tail = chosen.finalLength + end.length + CLIMB_OUT_METERS;
    const total = finalS + tail;
    const spacing = Math.max(PATH_SPACING, total / (PATH_CAPACITY - 2));
    // Resample everything into the typed arrays at the final spacing.
    let count = 0;
    let nextS = 0;
    for (const sample of samples) {
      if (sample.s + 1e-6 < nextS && sample !== finalStart) continue;
      this.pathX[count] = sample.x;
      this.pathZ[count] = sample.z;
      this.pathS[count] = sample.s;
      count += 1;
      nextS = sample.s + spacing;
      if (count >= PATH_CAPACITY - 2) break;
    }
    const steps = Math.min(PATH_CAPACITY - count, Math.ceil(tail / spacing));
    for (let i = 1; i <= steps; i += 1) {
      const along = (tail * i) / steps;
      this.pathX[count] = finalStart.x + end.dirX * along;
      this.pathZ[count] = finalStart.z + end.dirZ * along;
      this.pathS[count] = finalS + along;
      count += 1;
    }
    this.pathCount = count;
    this.pathIndex = 0;
    this.finalS = finalS;
    this.aimS = finalS + chosen.finalLength + this.profile.aimPoint;
    this.finalLength = chosen.finalLength;

    // Vertical profile before the final.
    const finalHeight = this.glideslopeHeight(end, chosen.finalLength + this.profile.aimPoint);
    const approachTas = this.approachSpeedFor(end)
      / Math.sqrt(Math.max(0.05, input.state.dynamics.airDensity / SEA_LEVEL_DENSITY));
    const level = Math.min(approachTas * 20, finalS * 0.3);
    const usable = Math.max(1, finalS - level);
    this.profileStartHeight = height;
    this.profileFinalHeight = finalHeight;
    this.profileGradient = height > finalHeight
      ? clamp((height - finalHeight) / usable, 0.01, this.profile.descentGradient * 1.25)
      : clamp((finalHeight - height) / usable, 0.01, this.profile.climbGradient);

    // Terrain floor along the join: the highest ground over the next 2 km of
    // track, plus a clearance that grows with the aeroplane's speed.
    const clearance = 90 + 6 * this.profile.patternSpeed * 0.25;
    const floorCount = Math.min(TERRAIN_FLOOR_CAPACITY, Math.ceil(finalS / TERRAIN_FLOOR_SPACING) + 1);
    const ground = this.groundScratch;
    for (let i = 0; i < floorCount; i += 1) {
      const index = this.indexAtS(i * TERRAIN_FLOOR_SPACING);
      ground[i] = Math.max(input.seaLevel, input.terrainHeight(this.pathX[index]!, this.pathZ[index]!));
    }
    const window = Math.ceil(2_000 / TERRAIN_FLOOR_SPACING);
    for (let i = 0; i < floorCount; i += 1) {
      let highest = -Infinity;
      for (let j = i; j < Math.min(floorCount, i + window); j += 1) highest = Math.max(highest, ground[j]!);
      // Within the certified approach area, the surveyed surface is the floor.
      const distanceToThreshold = this.aimS - this.profile.aimPoint - i * TERRAIN_FLOOR_SPACING;
      this.terrainFloor[i] = distanceToThreshold < CERTIFIED_APPROACH_METERS
        ? -Infinity
        : highest + clearance;
    }
    this.terrainFloorCount = floorCount;

    const status = this.status;
    status.runwayHeading = end.heading;
    status.approachSpeed = this.approachSpeedFor(end);
    this.replanTimer = 0;
  }

  private indexAtS(s: number): number {
    // Binary search; only used while planning.
    let low = 0;
    let high = this.pathCount - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.pathS[middle]! < s) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  // -------------------------------------------------------------------------
  // Sensing
  // -------------------------------------------------------------------------

  /** Height of the lowest extended wheel above the runway datum, metres. */
  /**
   * The highest ground along the aeroplane's actual track over the next
   * minute, plus a clearance, or -Infinity. The path's own terrain floor only
   * guards the path; this guards wherever the aeroplane really is, which a
   * wide turn or a replan can take well off it. The certified approach to
   * either end is left out, since the glidepath there is meant to come down
   * to the runway. Seven terrain samples every half second.
   */
  private terrainAhead(input: AutolandInput, ux: number, uz: number, groundSpeed: number): number {
    const end = this.end;
    const corridorStart = -Math.max(CERTIFIED_APPROACH_METERS, this.finalLength) - 500;
    const corridorEnd = end.length + CERTIFIED_APPROACH_METERS;
    const clearance = 60 + 0.5 * groundSpeed;
    let highest = -Infinity;
    for (const seconds of LOOKAHEAD_SECONDS) {
      const px = input.state.position.x + ux * groundSpeed * seconds;
      const pz = input.state.position.z + uz * groundSpeed * seconds;
      const relX = px - end.thresholdX;
      const relZ = pz - end.thresholdZ;
      const along = relX * end.dirX + relZ * end.dirZ;
      const across = relX * -end.dirZ + relZ * end.dirX;
      // The planned final (its terrain checked when it was chosen), the
      // runway, and the certified climb-out beyond it.
      if (Math.abs(across) < 700 && along > corridorStart && along < corridorEnd) continue;
      highest = Math.max(highest, input.seaLevel, input.terrainHeight(px, pz));
    }
    return highest + clearance;
  }

  private gearHeight(state: FlightState): number {
    const runway = this.runway;
    let lowest = 0;
    for (const leg of this.aircraft.gear) {
      rotateVectorInto(this.vector, state.orientation, leg.position);
      lowest = Math.min(lowest, this.vector.y);
    }
    return state.position.y + lowest - (runway?.elevation ?? 0);
  }

  /**
   * The wind, as a flight management system estimates it: ground velocity
   * minus air velocity, the air velocity rebuilt from airspeed, angle of attack
   * and sideslip. Low-passed over about five seconds.
   */
  private estimateWind(input: AutolandInput, blend: number): void {
    const { state } = input;
    const dynamics = state.dynamics;
    this.airVerticalSpeed = state.velocity.y;
    if (dynamics.airspeed < 15 || state.onGround) return;
    const ta = Math.tan(dynamics.angleOfAttack);
    const tb = Math.tan(dynamics.sideslip);
    const forward = dynamics.airspeed / Math.sqrt(1 + ta * ta + tb * tb);
    this.vector.x = forward;
    this.vector.y = -forward * ta;
    this.vector.z = forward * tb;
    rotateVectorInto(this.vector, state.orientation, this.vector);
    this.airVerticalSpeed = this.vector.y;
    const k = clamp(blend, 0, 1);
    this.windX += (state.velocity.x - this.vector.x - this.windX) * k;
    this.windZ += (state.velocity.z - this.vector.z - this.windZ) * k;
  }

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------

  /**
   * Writes this step's controls into `out` and returns it. Allocation-free.
   * Does nothing (and returns `out` untouched) while disengaged.
   */
  update(input: AutolandInput, out: FlightControls): FlightControls {
    if (!this.engaged || !this.runway) return out;
    const { state, telemetry, dt } = input;
    const status = this.status;
    const profile = this.profile;
    const aircraft = this.aircraft;
    this.phaseTime += dt;
    if (state.crashed) {
      this.disengage();
      return out;
    }
    this.estimateWind(input, dt / 5);
    if (!state.onGround && state.dynamics.airspeed > 15) {
      status.peakAngleOfAttack = Math.max(status.peakAngleOfAttack, state.dynamics.angleOfAttack);
      status.peakBank = Math.max(status.peakBank, Math.abs(telemetry.bank));
    }

    const end = this.end;
    const x = state.position.x;
    const z = state.position.z;
    const vx = state.velocity.x;
    const vz = state.velocity.z;
    const groundSpeed = Math.max(1, Math.hypot(vx, vz));
    // Through the AIR: in a downdraft the aeroplane sinks over the ground
    // without trading any height for speed, and an autothrottle fed the
    // ground-referenced angle pulled the trainer's power to idle in one,
    // at 18 m/s and 16 degrees of incidence.
    const airFlightPath = Math.asin(clamp(this.airVerticalSpeed / Math.max(1, state.dynamics.airspeed), -1, 1));
    const sigma = Math.max(0.05, state.dynamics.airDensity / SEA_LEVEL_DENSITY);
    const height = this.gearHeight(state);
    const agl = telemetry.altitudeAgl;
    // Runway-local position for the landing direction.
    const relX = x - end.thresholdX;
    const relZ = z - end.thresholdZ;
    const pastThreshold = relX * end.dirX + relZ * end.dirZ;
    const rightOfCentre = relX * -end.dirZ + relZ * end.dirX;
    const distanceToAim = this.profile.aimPoint - pastThreshold;

    // Path progress: nearest sample in a short window ahead of the last one.
    let index = this.pathIndex;
    let bestDistance = Infinity;
    const searchEnd = Math.min(this.pathCount - 1, index + 60);
    for (let i = Math.max(0, index - 2); i <= searchEnd; i += 1) {
      const dx = this.pathX[i]! - x;
      const dz = this.pathZ[i]! - z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        index = i;
      }
    }
    this.pathIndex = index;
    const s = this.pathS[index]!;
    const crossTrack = Math.sqrt(bestDistance);
    status.distanceToTouchdown = status.phase === "rollout" || status.phase === "landed"
      ? 0
      : Math.max(0, this.aimS - s);

    const approachSpeed = status.approachSpeed;
    const phase = status.phase;
    this.lookaheadTimer += dt;
    if (this.lookaheadTimer >= LOOKAHEAD_INTERVAL_SECONDS && !state.onGround) {
      this.lookaheadTimer = 0;
      this.lookaheadFloor = this.terrainAhead(input, vx / groundSpeed, vz / groundSpeed, groundSpeed);
    }

    // ---- Phase transitions that do not depend on this step's commands ----
    if (phase === "approach") {
      this.replanTimer += dt;
      const lost = crossTrack > Math.max(600, this.turnRadius * 1.5);
      if (s >= this.finalS - 1 && crossTrack < 250) {
        this.setPhase("final");
      } else if (lost || (this.stage <= 1 && this.replanTimer >= REPLAN_INTERVAL_SECONDS)) {
        this.replanTimer = 0;
        this.plan(input, lost);
      }
    } else if (phase === "final") {
      if (agl <= this.flareHeight(state) && height < 40) {
        const sink = Math.max(0, -state.velocity.y) - profile.touchdownSink;
        this.flareTau = sink > 0.2 ? Math.max(profile.flareTau, agl / sink) : profile.flareTau;
        this.setPhase("flare");
      }
    } else if (phase === "go-around") {
      const climbedOut = height > Math.max(150, this.profileFinalHeight - end.elevation - 50)
        && state.position.y > this.lookaheadFloor
        && telemetry.indicatedAirspeed > approachSpeed
        && this.phaseTime > 8;
      if (climbedOut) {
        if (status.attempt >= AUTOLAND_MAX_ATTEMPTS) {
          // Hold the climb-out heading and height; the pilot has the runway.
          this.disengage();
          return out;
        }
        status.attempt += 1;
        this.setPhase("approach");
        this.plan(input, true);
      }
    }
    if ((status.phase === "flare" || status.phase === "final") && state.onGround) {
      this.touchdown(state, pastThreshold);
    }
    this.lastVerticalSpeed = state.velocity.y;

    // ---- Lateral guidance: L1 on the planned track ----
    let lookahead = clamp(groundSpeed * (status.phase === "approach" ? 9 : 6), 120, 1_500);
    if (status.phase === "flare" || status.phase === "rollout") lookahead = clamp(groundSpeed * 4, 60, 400);
    const along = Math.sqrt(Math.max(0, lookahead * lookahead - bestDistance));
    let refIndex = index;
    const refS = s + Math.max(along, 10);
    while (refIndex < this.pathCount - 1 && this.pathS[refIndex]! < refS) refIndex += 1;
    const toRefX = this.pathX[refIndex]! - x;
    const toRefZ = this.pathZ[refIndex]! - z;
    const ux = vx / groundSpeed;
    const uz = vz / groundSpeed;
    const eta = Math.atan2(toRefX * -uz + toRefZ * ux, toRefX * ux + toRefZ * uz);
    const lateralAcceleration = (2 * groundSpeed * groundSpeed * Math.sin(eta)) / Math.max(lookahead, Math.hypot(toRefX, toRefZ));
    let bankLimit = status.phase === "approach" || status.phase === "go-around"
      ? profile.maxBank
      : 20 * DEG;
    const nearGround = clamp((agl - 3) / 60, 0, 1);
    bankLimit = Math.min(bankLimit, profile.groundBank + (bankLimit - profile.groundBank) * nearGround);
    const bankCommand = clamp(Math.atan(lateralAcceleration / GRAVITY), -bankLimit, bankLimit);

    // ---- Vertical guidance and speed schedule ----
    let targetSpeed = approachSpeed;
    let verticalSpeedCommand = 0;
    let flightPathCommand = 0;
    let useVerticalSpeed = true;
    let flaps = this.flapCommand;
    let gear = this.gearCommand;
    let brake = 0;
    let decrab = false;
    let throttleOverride = Number.NaN;
    let flightPathRateFeedForward = 0;
    const heightGain = 0.22 / Math.sqrt(profile.gainScale);

    if (status.phase === "approach") {
      const toFinal = this.finalS - s;
      const decelDistance = Math.max(0, (profile.patternSpeed ** 2 - approachSpeed ** 2) / sigma) / (2 * 0.45)
        + (approachSpeed / Math.sqrt(sigma)) * 12;
      // The configuration only ever advances on an approach: once the flaps
      // are coming out nothing re-plans them back in.
      if (toFinal <= decelDistance + 15_000) this.stage = Math.max(this.stage, 1);
      if (toFinal <= decelDistance) this.stage = Math.max(this.stage, 2);
      if (toFinal <= Math.min(3_000, decelDistance * 0.5)) this.stage = Math.max(this.stage, 3);
      targetSpeed = this.stage === 0
        ? this.enrouteSpeed
        : this.stage === 1
          ? profile.patternSpeed
          : approachSpeed;
      // Profile height: the plan's gradient from its start, held at the final
      // height, and never under the terrain floor.
      const descending = this.profileStartHeight > this.profileFinalHeight;
      const line = descending
        ? Math.max(this.profileFinalHeight, this.profileStartHeight - this.profileGradient * s)
        : Math.min(this.profileFinalHeight, this.profileStartHeight + this.profileGradient * s);
      const floorIndex = Math.min(this.terrainFloorCount - 1, Math.floor(s / TERRAIN_FLOOR_SPACING));
      const floor = floorIndex >= 0 ? this.terrainFloor[floorIndex]! : -Infinity;
      const reference = Math.max(line, floor, this.lookaheadFloor) - end.elevation;
      const onLine = descending
        ? line > this.profileFinalHeight + 1
        : line < this.profileFinalHeight - 1;
      const feedForward = onLine && line >= floor && line >= this.lookaheadFloor
        ? (descending ? -1 : 1) * this.profileGradient * groundSpeed
        : 0;
      verticalSpeedCommand = feedForward + heightGain * (reference - height);
      if (this.stage >= 2 || toFinal < groundSpeed * (profile.gearSeconds + 10)) gear = 1;
      if (agl < 60 && toFinal > 1_000) {
        // Below the floor somewhere it should not be: climb now.
        this.goAround("terrain");
      }
    } else if (status.phase === "final") {
      const reference = this.glideslopeHeight(end, distanceToAim) - end.elevation;
      verticalSpeedCommand = -groundSpeed * Math.tan(AUTOLAND_GLIDESLOPE_RADIANS)
        + 1.4 * heightGain * (reference - height);
      gear = 1;
      this.checkGates(input, height, distanceToAim, rightOfCentre, dt);
    } else if (status.phase === "flare") {
      verticalSpeedCommand = Math.min(0, -Math.max(0, agl) / this.flareTau - profile.touchdownSink);
      // The law's own rate of change, fed forward: d(hdot)/dt = -hdot / tau.
      flightPathRateFeedForward = clamp(-state.velocity.y / (this.flareTau * Math.max(10, state.dynamics.airspeed)), 0, 0.05);
      throttleOverride = moveToward(this.throttleCommand, 0, dt * (0.35 / profile.gainScale));
      decrab = agl < 8;
      gear = 1;
      // Floating past the touchdown zone: go around rather than run out of runway.
      const longLimit = Math.min(end.length * 0.45, this.profile.aimPoint + 350);
      if (pastThreshold > longLimit) this.goAround("long-landing");
    } else if (status.phase === "go-around") {
      useVerticalSpeed = false;
      // Rising ground ahead of the climb-out: climb at the steepest the
      // speed allows rather than the comfortable go-around gradient.
      const terrainEscape = this.lookaheadFloor > state.position.y - 30;
      const climb = (aircraft.mass > 30_000 ? (terrainEscape ? 9 : 5) : (terrainEscape ? 14 : 7)) * DEG;
      const shortfall = clamp((approachSpeed + 3 - telemetry.indicatedAirspeed) * 0.02, 0, climb + 2 * DEG);
      flightPathCommand = climb - shortfall;
      throttleOverride = profile.maxThrottle;
      targetSpeed = approachSpeed + 8;
      if (state.velocity.y > 1.5 && agl > 15) {
        gear = 0;
        flaps = Math.min(flaps, 0.5);
      }
    }

    // Configuration by speed, everywhere but the ground and the go-around.
    const ias = telemetry.indicatedAirspeed;
    if (status.phase === "final") this.stage = 3;
    if (status.phase === "approach" || status.phase === "final") {
      if (this.stage >= 3 && ias < profile.fullFlapLimit) flaps = 1;
      else if (this.stage >= 2 && ias < profile.halfFlapLimit) flaps = Math.max(flaps, 0.5);
      else if (this.stage <= 1 && ias > 1.3 * profile.stallClean + 3) flaps = 0;
    }
    if (!aircraft.retractableGear) gear = 1;
    this.flapCommand = flaps;
    this.gearCommand = gear;

    status.targetAirspeed = targetSpeed;

    // The phase may have changed above (a go-around, a touchdown).
    if (status.phase === "rollout" || status.phase === "landed") {
      return this.groundRoll(input, out, pastThreshold, rightOfCentre);
    }

    // ---- Speed: autothrottle, then speed brake if idle is not enough ----
    const targetTas = targetSpeed / Math.sqrt(sigma);
    const speedError = targetTas - state.dynamics.airspeed;
    const acceleration = clamp(0.25 * speedError, -1.2, 0.8);
    const thrustRequired = state.dynamics.dragForce
      + aircraft.mass * GRAVITY * Math.sin(airFlightPath)
      + aircraft.mass * acceleration;
    const forward = Math.max(0, state.dynamics.airspeed * Math.cos(state.dynamics.angleOfAttack));
    const perThrottle = calculateEngineThrust(aircraft, profile.maxThrottle, state.dynamics.airDensity, forward)
      / Math.max(1e-6, profile.maxThrottle);
    const feedForwardThrottle = thrustRequired / Math.max(1, perThrottle);
    if (Number.isNaN(throttleOverride)) {
      const unclamped = feedForwardThrottle + this.throttleIntegral;
      if ((unclamped > 0 && unclamped < profile.maxThrottle) || speedError * this.throttleIntegral < 0) {
        this.throttleIntegral = clamp(this.throttleIntegral + 0.02 * speedError * dt, -0.2, 0.2);
      }
      this.throttleCommand = clamp(unclamped, 0, profile.maxThrottle);
    } else {
      this.throttleCommand = throttleOverride;
    }
    const overspeed = ias - targetSpeed;
    if (
      aircraft.speedBrakeDrag > 0
      && feedForwardThrottle < 0.02
      && overspeed > 3
      && (status.phase === "approach" || (status.phase === "final" && height > 150))
    ) {
      this.speedBrakeCommand = moveToward(this.speedBrakeCommand, clamp((overspeed - 3) / 10, 0, 1), dt * 0.5);
    } else {
      this.speedBrakeCommand = moveToward(this.speedBrakeCommand, 0, dt * 0.8);
    }
    brake = this.speedBrakeCommand;

    // Energy priority: with the throttle pinned, trade height for speed rather
    // than let the speed run away -- or, worse, decay.
    const minimumSpeed = 1.2 * stallSpeed(aircraft, state.actuators.flaps);
    // Not in the flare: bleeding the speed toward the stall there is the point,
    // and the angle-of-attack ceiling is what protects it.
    if (useVerticalSpeed && status.phase !== "flare") {
      if (this.throttleCommand >= profile.maxThrottle - 0.01 && ias < targetSpeed - 4) {
        verticalSpeedCommand -= 0.6 * (targetSpeed - 4 - ias);
      }
      if (status.phase === "approach" && this.throttleCommand <= 0.01 && overspeed > 10) {
        verticalSpeedCommand += 0.4 * (overspeed - 10);
      }
      if (ias < minimumSpeed) verticalSpeedCommand -= 1.5 * (minimumSpeed - ias);
      const maxDescent = status.phase === "approach"
        ? clamp(groundSpeed * 0.12, 3, 15)
        : groundSpeed * Math.tan(AUTOLAND_GLIDESLOPE_RADIANS) + 3.5;
      const maxClimb = status.phase === "approach" ? clamp(groundSpeed * 0.1, 2, 12) : 3;
      verticalSpeedCommand = clamp(verticalSpeedCommand, -maxDescent, maxClimb);
    }
    if (useVerticalSpeed) flightPathCommand = Math.atan2(verticalSpeedCommand, groundSpeed);

    out.throttle = this.throttleCommand;
    out.flaps = flaps;
    out.gear = gear;
    out.brake = brake;
    out.trim = this.trimHold;
    this.pitchAxis(input, flightPathCommand, flightPathRateFeedForward, bankCommand, out, status.phase === "flare", dt);
    this.lateralAxes(input, bankCommand, decrab, out);
    return out;
  }

  /**
   * Flare height: the sink this aeroplane has to arrest, times the flare's time
   * constant, plus a little for the heavier aeroplanes' pitch lag.
   */
  private flareHeight(state: FlightState): number {
    const sink = Math.max(0, -state.velocity.y);
    const lag = 0.25 * this.profile.gainScale;
    return (this.profile.flareTau + lag) * Math.max(0, sink - this.profile.touchdownSink) + 0.3;
  }

  private touchdown(state: FlightState, pastThreshold: number): void {
    const status = this.status;
    status.touchdownSinkRate = Math.max(0, -this.lastVerticalSpeed);
    status.touchdownDistance = pastThreshold;
    this.lastGroundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    this.measuredDeceleration = 0;
    this.brakeIntegral = 0;
    this.brakeRamp = 0;
    this.setPhase("rollout");
  }

  private goAround(reason: GoAroundReason): void {
    const status = this.status;
    if (status.phase === "go-around") return;
    status.goAroundReason = reason;
    this.flightPathIntegral = 0;
    this.stage = 1;
    this.setPhase("go-around");
  }

  /**
   * Stabilised-approach gates, applied below the gate height. A criterion has
   * to be broken for a sustained two seconds (configuration and bank at once),
   * so a single gust does not throw away an approach a pilot would continue.
   */
  private checkGates(
    input: AutolandInput,
    height: number,
    distanceToAim: number,
    rightOfCentre: number,
    dt: number,
  ): void {
    const { state, telemetry } = input;
    const profile = this.profile;
    const approachSpeed = this.status.approachSpeed;
    // About 500 ft, the visual stabilised-approach gate, a little higher for
    // the faster aeroplanes: the final is joined above it, so an approach
    // gets the time to settle onto the glidepath before it is judged.
    const gateHeight = clamp(approachSpeed * 2.5, 90, 200);
    if (height > gateHeight) {
      this.gateTimer = 0;
      return;
    }
    const distanceToThreshold = distanceToAim - this.profile.aimPoint;
    const glideslope = this.glideslopeHeight(this.end, distanceToAim) - this.end.elevation;
    const verticalLimit = Math.max(8, Math.max(0, distanceToAim) * Math.tan(0.8 * DEG));
    const lateralLimit = distanceToThreshold > 300
      ? Math.max(this.end.width, distanceToThreshold * Math.tan(1.5 * DEG))
      : this.end.width * 0.4;
    const nominalSink = Math.hypot(state.velocity.x, state.velocity.z) * Math.tan(AUTOLAND_GLIDESLOPE_RADIANS);
    const configured = state.actuators.flaps >= 0.95
      && (!this.aircraft.retractableGear || state.actuators.gear >= 0.98);
    if (!configured) return this.goAround("unconfigured");
    if (Math.abs(telemetry.bank) > (height < 30 ? 10 : 20) * DEG) return this.goAround("bank");
    let failure: GoAroundReason | null = null;
    if (Math.abs(height - glideslope) > verticalLimit) failure = "glideslope";
    else if (Math.abs(rightOfCentre) > lateralLimit) failure = "centreline";
    else if (telemetry.indicatedAirspeed > approachSpeed + 10) failure = "speed-high";
    else if (telemetry.indicatedAirspeed < approachSpeed - 5) failure = "speed-low";
    else if (-state.velocity.y > nominalSink + 3) failure = "sink-rate";
    if (!failure) {
      this.gateTimer = Math.max(0, this.gateTimer - dt);
      return;
    }
    this.gateTimer += dt;
    if (this.gateTimer > 2 || telemetry.indicatedAirspeed < 1.1 * profile.stallLanding) this.goAround(failure);
  }

  // -------------------------------------------------------------------------
  // Inner loops: invert the flight model's own moment equations
  // -------------------------------------------------------------------------

  private pitchAxis(
    input: AutolandInput,
    flightPathCommand: number,
    flightPathRateFeedForward: number,
    bankCommand: number,
    out: FlightControls,
    flaring: boolean,
    dt: number,
  ): void {
    const { state, telemetry } = input;
    const aircraft = this.aircraft;
    const profile = this.profile;
    const dynamics = state.dynamics;
    const speed = Math.max(dynamics.airspeed, 8);
    const dynamicPressure = Math.max(1, 0.5 * dynamics.airDensity * dynamics.airspeed * dynamics.airspeed);
    const groundSpeed = Math.max(1, Math.hypot(state.velocity.x, state.velocity.z));
    const flightPath = Math.atan2(state.velocity.y, groundSpeed);
    const bank = telemetry.bank;
    const scale = profile.gainScale;

    // Flight path -> load factor -> angle of attack.
    const flightPathError = flightPathCommand - flightPath;
    if (!flaring) {
      this.flightPathIntegral = clamp(this.flightPathIntegral + 0.25 * flightPathError * dt, -3 * DEG, 3 * DEG);
    }
    const flightPathRate = clamp((1.5 / scale ** 0.25) * flightPathError + flightPathRateFeedForward, -0.15, 0.15);
    const cosBank = Math.max(0.3, Math.cos(bankCommand));
    const liftDump = aircraft.speedBrakeDrag > 0
      ? (aircraft.groundSpoilers
        ? Math.max(state.actuators.groundSpoilers * 0.62, state.actuators.brake * 0.12)
        : state.actuators.brake * 0.12)
      : 0;
    const liftPerCoefficient = (dynamicPressure * aircraft.wingArea * Math.max(0.2, 1 - liftDump))
      / (aircraft.mass * GRAVITY);
    // The load factor the angle-of-attack ceiling still allows: asking for
    // more only drove the pitch-rate feedforward below past that ceiling
    // (the trainer reached 15 degrees in a downdraft against a 12 degree limit).
    const alphaLimitedLoad = liftPerCoefficient * (
      aircraft.clZero + aircraft.clAlpha * profile.maxAngleOfAttack + aircraft.flapLift * state.actuators.flaps
    );
    const loadFactor = clamp(
      (Math.cos(flightPath) + (speed * flightPathRate) / GRAVITY) / cosBank,
      0.4,
      Math.max(0.4, Math.min(profile.maxLoadFactor, alphaLimitedLoad)),
    );
    const liftRequired = loadFactor / liftPerCoefficient;
    let alphaCommand = (liftRequired - aircraft.clZero - aircraft.flapLift * state.actuators.flaps) / aircraft.clAlpha
      + this.flightPathIntegral;
    alphaCommand = clamp(alphaCommand, -4 * DEG, profile.maxAngleOfAttack);
    const alpha = dynamics.angleOfAttack;
    // The rate the velocity turns at through the AIR, which is what the
    // aerodynamics sees: the ground-referenced angle differs in a vertical gust.
    const airFlightPath = Math.asin(clamp(this.airVerticalSpeed / speed, -1, 1));
    const steadyPitchRate = (GRAVITY / speed) * (loadFactor - Math.cos(airFlightPath) * Math.cos(bank));
    let pitchRateCommand = steadyPitchRate + (3 / scale ** 0.25) * (alphaCommand - alpha);
    // Attitude limits: tail strike in the flare, a sane envelope elsewhere.
    const pitch = telemetry.pitch;
    const maxPitch = flaring || telemetry.altitudeAgl < 15 ? profile.maxFlarePitch : 20 * DEG;
    if (pitch > maxPitch - 1 * DEG) pitchRateCommand = Math.min(pitchRateCommand, 1.5 * (maxPitch - pitch));
    if (pitch < -12 * DEG) pitchRateCommand = Math.max(pitchRateCommand, 1.5 * (-12 * DEG - pitch));
    pitchRateCommand = clamp(pitchRateCommand, -6 * DEG, 6 * DEG);
    const pitchAcceleration = (6 / Math.sqrt(scale)) * (pitchRateCommand - state.angularVelocity.z);
    out.pitch = this.elevatorFor(input, pitchAcceleration, speed, dynamicPressure);
  }

  /** The elevator that gives a body pitch acceleration, from the sim's pitch-moment equation. */
  private elevatorFor(input: AutolandInput, pitchAcceleration: number, speed: number, dynamicPressure: number): number {
    const { state } = input;
    const aircraft = this.aircraft;
    const alpha = state.dynamics.angleOfAttack;
    const required = (aircraft.inertia.z * pitchAcceleration)
      / (dynamicPressure * aircraft.wingArea * aircraft.meanChord);
    const elevator = (
      required
      - aircraft.pitchMomentZero
      - aircraft.pitchMomentAlpha * alpha
      - aircraft.pitchDamping * ((state.angularVelocity.z * aircraft.meanChord) / (2 * speed))
    ) / (aircraft.pitchMomentElevator * this.postStallAuthority(alpha));
    return clamp(elevator - state.actuators.trim * 0.5, -1, 1);
  }

  private postStallAuthority(alpha: number): number {
    const aircraft = this.aircraft;
    const excess = Math.max(0, alpha - aircraft.positiveStallAngle, aircraft.negativeStallAngle - alpha);
    return 1 - 0.58 * clamp(excess / (28 * DEG), 0, 1);
  }

  private lateralAxes(input: AutolandInput, bankCommand: number, decrab: boolean, out: FlightControls): void {
    const { state, telemetry } = input;
    const aircraft = this.aircraft;
    const scale = this.profile.gainScale;
    const dynamics = state.dynamics;
    const speed = Math.max(dynamics.airspeed, 8);
    const dynamicPressure = Math.max(1, 0.5 * dynamics.airDensity * dynamics.airspeed * dynamics.airspeed);
    const authority = this.postStallAuthority(dynamics.angleOfAttack);
    const span = aircraft.wingSpan;
    const reference = dynamicPressure * aircraft.wingArea * span;
    const bank = telemetry.bank;

    // Roll: bank error -> roll rate -> roll acceleration -> aileron.
    const rollRate = state.angularVelocity.x;
    const rollRateCommand = clamp((2.0 / Math.sqrt(scale)) * (bankCommand - bank), -12 * DEG, 12 * DEG);
    const rollAcceleration = (6 / scale) * (rollRateCommand - rollRate);
    const rollRequired = (aircraft.inertia.x * rollAcceleration) / reference;
    out.roll = clamp(
      (rollRequired + aircraft.rollMomentBeta * dynamics.sideslip
        - aircraft.rollDamping * ((rollRate * span) / (2 * speed)))
        / (aircraft.rollMomentAileron * authority),
      -1,
      1,
    );

    // Yaw, in pilot sign (nose right positive = -omega_y): coordinate the turn
    // and null the sideslip; or, in the decrab, point the nose down the runway.
    const yawRate = -state.angularVelocity.y;
    let yawRateCommand: number;
    if (decrab) {
      yawRateCommand = 0.9 * wrapAngle(telemetry.heading - this.end.heading);
    } else {
      const turnRate = (GRAVITY * Math.tan(bank)) / speed;
      yawRateCommand = turnRate * Math.cos(bank) * Math.cos(telemetry.pitch) + 1.5 * dynamics.sideslip;
    }
    yawRateCommand = clamp(yawRateCommand, -10 * DEG, 10 * DEG);
    const yawAcceleration = (3 / scale) * (yawRateCommand - yawRate);
    // Body yaw moment about +y is -I_y * (pilot yaw acceleration).
    const yawRequired = -(aircraft.inertia.y * yawAcceleration) / reference;
    out.yaw = clamp(
      (-yawRequired - aircraft.yawMomentBeta * dynamics.sideslip
        + aircraft.yawDamping * ((state.angularVelocity.y * span) / (2 * speed)))
        / (aircraft.yawMomentRudder * authority),
      -1,
      1,
    );
  }

  /** Rollout and the stop: idle, spoilers, nose down, autobrake, centreline. */
  private groundRoll(
    input: AutolandInput,
    out: FlightControls,
    pastThreshold: number,
    rightOfCentre: number,
  ): FlightControls {
    const { state, telemetry, dt } = input;
    const status = this.status;
    const end = this.end;
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    out.throttle = 0;
    out.flaps = this.flapCommand;
    out.gear = 1;
    out.trim = this.trimHold;
    this.throttleCommand = 0;
    this.throttleIntegral = 0;

    if (status.phase === "rollout" && !state.onGround && telemetry.altitudeAgl > 1.5 && this.phaseTime > 0.3) {
      this.goAround("bounce");
      out.throttle = this.profile.maxThrottle;
      return out;
    }
    if (status.phase === "rollout" && groundSpeed < 0.6) this.setPhase("landed");

    if (status.phase === "landed") {
      out.pitch = 0;
      out.roll = 0;
      out.yaw = 0;
      out.brake = 1;
      return out;
    }

    // Derotate: the nose comes down at up to 3 deg/s, slowing in proportion
    // as it nears the runway so that the nosewheel arrives at a fraction of a
    // degree a second (0.2 m/s at the 747's 26 m wheelbase), then the
    // elevator goes.
    const pitch = telemetry.pitch;
    const dynamics = state.dynamics;
    const speed = Math.max(dynamics.airspeed, 8);
    const dynamicPressure = Math.max(1, 0.5 * dynamics.airDensity * dynamics.airspeed * dynamics.airspeed);
    const allWheels = state.dynamics.contactCount >= this.aircraft.gear.length;
    if (!allWheels && dynamics.airspeed > 15) {
      // The first half-second only stops the flare's pitch-up: the mains'
      // own contact moment already starts the nose down, and a full nose-down
      // elevator on top of it is what slammed the 747's nosewheel.
      const pitchRateCommand = -clamp(pitch, 0.6 * DEG, 3 * DEG) * clamp(this.phaseTime / 0.5, 0, 1);
      const acceleration = (15 / this.profile.gainScale) * (pitchRateCommand - state.angularVelocity.z);
      out.pitch = this.elevatorFor(input, acceleration, speed, dynamicPressure);
    } else {
      out.pitch = moveToward(out.pitch, -state.actuators.trim * 0.5, dt * 1.5);
    }
    // Wings level while the ailerons still have air, until the nosewheel is
    // down: with every wheel on the runway the roll axis steers the nosewheel
    // (`steeringCommand` in simulation.ts), and the gear holds the wings.
    if (dynamics.airspeed > 20 && !allWheels) {
      this.lateralAxes(input, 0, true, out);
      out.roll = clamp(out.roll, -0.3, 0.3);
    } else {
      out.roll = 0;
    }

    // Steering, on the rudder pedals: the rudder while it has air, the
    // nosewheel once it is down. The tyres turn the velocity toward the nose
    // only with a lag, v / (C g) for a cornering stiffness C per radian of
    // slip, so the centreline is held as a second-order loop: a heading
    // offset from the runway against both the distance off the centreline and
    // the track's angle to it, the latter the damping a heading-only law
    // lacks. Heading grows to the LEFT, so right of centre, or tracking right,
    // asks for more of it. The offset is small and fades out as the aeroplane
    // slows, so it stops parallel to the runway.
    const tau = groundSpeed / (TYRE_CORNERING_STIFFNESS * GRAVITY) + 1.5;
    const lateralSpeed = state.velocity.x * -end.dirZ + state.velocity.z * end.dirX;
    const trackRight = groundSpeed > 3 ? lateralSpeed / groundSpeed : 0;
    const steerSpeed = Math.max(groundSpeed, 5);
    const [alignedSpeed, centrelineSpeed] = ROLLOUT_ALIGN_SPEEDS;
    const headingOffset = clamp((groundSpeed - alignedSpeed) / (centrelineSpeed - alignedSpeed), 0, 1) * clamp(
      (ROLLOUT_STEER_OMEGA * ROLLOUT_STEER_OMEGA * tau / steerSpeed) * rightOfCentre
        + Math.max(0, 2 * ROLLOUT_STEER_DAMPING * ROLLOUT_STEER_OMEGA * tau - 1) * trackRight,
      -ROLLOUT_MAX_HEADING_OFFSET,
      ROLLOUT_MAX_HEADING_OFFSET,
    );
    // The heading loop under it, stiffer for the heavier aeroplanes, whose
    // nosewheels steer less (12 degrees on the 747) against more inertia.
    const headingError = wrapAngle(telemetry.heading - end.heading) - headingOffset;
    const yawRate = -state.angularVelocity.y;
    const steerGain = 3 * this.profile.gainScale;
    out.yaw = clamp(steerGain * (headingError - 0.3 * yawRate), -1, 1);

    // Autobrake: hold the deceleration that stops with a margin of runway
    // left, at least `AUTOBRAKE_DECELERATION`. Closed on the MEASURED
    // deceleration, because what a brake command buys depends on how much
    // weight the wheels carry, which changes all through the rollout. It
    // ramps in once the nosewheel is down: braked on the mains alone, the
    // jet's nose fell 13 degrees in a second against full up elevator. The
    // exception is a runway too short to wait on (`spareRunway` below).
    const measured = (this.lastGroundSpeed - groundSpeed) / dt;
    this.lastGroundSpeed = groundSpeed;
    this.measuredDeceleration += (measured - this.measuredDeceleration) * clamp(dt / 0.5, 0, 1);
    const profile = this.profile;
    const remaining = end.length - pastThreshold - 250;
    const needed = remaining > 20 ? (groundSpeed * groundSpeed) / (2 * remaining) : 8;
    const deceleration = Math.max(AUTOBRAKE_DECELERATION, needed * 1.2);
    // Full braking's own stopping distance, with a quarter of the friction
    // kept in hand for the lift still on the wing and a wet runway.
    const brakingStop = (groundSpeed * groundSpeed) / (2 * 0.75 * profile.brakingDeceleration);
    const spareRunway = end.length - pastThreshold - 40 - brakingStop;
    const brakeUrgency = clamp(1 - spareRunway / 150, 0, 1);
    if (allWheels || brakeUrgency > 0 || this.phaseTime > 5) {
      this.brakeRamp = Math.min(1, this.brakeRamp + AUTOBRAKE_RAMP * dt);
    }
    // On the mains alone, only as much as the runway insists on, and half at
    // most: the elevator cannot hold the nose against more.
    const brakeLimit = allWheels ? this.brakeRamp : Math.min(this.brakeRamp, 0.5 * brakeUrgency);
    if (brakeLimit > 0) {
      this.brakeIntegral = clamp(
        this.brakeIntegral + 0.25 * (deceleration - this.measuredDeceleration) * dt,
        -0.5,
        1,
      );
    }
    // The tyres' friction circle (in the simulator) leaves steering grip under
    // any brake, so the brakes no longer give way to the steering. Below
    // walking pace, full brake: friction brakes stop it there in a moment.
    out.brake = groundSpeed < 3
      ? 1
      : Math.min(brakeLimit, clamp(deceleration / profile.brakingDeceleration + this.brakeIntegral, 0.15, 1));
    return out;
  }
}
