import { createSimulationSpawn } from "@/src/game/spawn";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "@/src/game/types";
import { aircraftDefinition, createFlightState } from "@/src/sim";
import { sampleTerrainHeight, type WorldDefinition } from "@/src/world";
import { Fnv1a } from "./hash";
import { BENCH_PATH_ID } from "./plan";
import type { BenchPathSummary, BenchRouteKind, BenchTimings } from "./types";

/**
 * The bench's route: a player's first minute, flown by script instead of by
 * the simulation, so every device renders the same sequence of poses.
 *
 *  - Settle: stopped on the runway threshold, where the game's own runway
 *    start puts the trainer, creeping at 1 m/s so streaming looks ahead
 *    along the runway (the renderer reads ahead along the velocity).
 *  - Roll, [0, rollEnd): 0 to 60 m/s along the centreline, on the ground.
 *    The low eye is where ground cover costs the most (critique S1).
 *  - Climb-out, [rollEnd, climbEnd): 60 to 120 m/s, climbing at up to
 *    10 m/s toward the cruise height, never below the wheels' height.
 *  - Cruise: 120 m/s, following the terrain at 150 m: climbing at up to
 *    25 m/s, descending at up to 10 m/s, never below 30 m. The perf agent's
 *    rules (tests/perf/ab/agent.ts), with the ground clamped to the sea.
 *
 * Everything is a pure function of the flight time `t`: the altitude profile
 * is integrated once, at 20 Hz, when the path is made, and a frame reads it
 * by interpolation. A slow device samples the route at fewer instants; it
 * never flies a different route. A world without an airport flies the
 * cruise from t = 0 at the airborne spawn instead.
 */

export const BENCH_ROLL_SPEED = 60;
export const BENCH_CRUISE_SPEED = 120;
export const BENCH_CLEARANCE = 150;
/** The settle's creep along the runway, m/s. */
export const BENCH_SETTLE_CREEP = 1;

const CLIMB_OUT_RATE = 10;
const CRUISE_CLIMB_RATE = 25;
const DESCENT_RATE = 10;
const CRUISE_MIN_CLEARANCE = 30;
const LOOK_AHEAD_S = 3;
const PROFILE_HZ = 20;
/** The climb-out's rate limit and pitch ease in over this, and the pitch out before the cruise. */
const ROTATION_S = 3;
const CLIMB_OUT_PITCH = (8 * Math.PI) / 180;
const SETTLE_IDLE_RPM = 900;
const AIRCRAFT = "trainer";

export interface BenchPath {
  readonly route: BenchRouteKind;
  readonly rollEndS: number;
  readonly climbEndS: number;
  readonly flightS: number;
  readonly startX: number;
  readonly startZ: number;
  readonly headingRadians: number;
  readonly directionX: number;
  readonly directionZ: number;
  /** The trainer's centre of gravity above level ground on its wheels. */
  readonly cgHeight: number;
  /** Its centre of gravity on the runway, and its nose-up attitude there. */
  readonly runwayY: number;
  readonly groundPitch: number;
  /** Centre-of-gravity height at `k / PROFILE_HZ` seconds. */
  readonly altitude: Float64Array;
  /** max(terrain, sea level) under it at the same instants. */
  readonly ground: Float64Array;
  readonly fingerprint: string;
  /** Hamilton product of the heading's yaw half, reused for every pitch. */
  readonly yawSin: number;
  readonly yawCos: number;
}

/** The surface the route keeps clear of: terrain, or the sea over it. */
function surfaceHeight(world: WorldDefinition, x: number, z: number): number {
  return Math.max(sampleTerrainHeight(world, x, z), world.seaLevel);
}

/** Distance flown at `t`, metres; speed ramps linearly in each phase. */
function distanceAt(route: BenchRouteKind, rollEndS: number, climbEndS: number, t: number): number {
  if (t <= 0) return 0;
  if (route === "airborne") return BENCH_CRUISE_SPEED * t;
  if (t < rollEndS) return (BENCH_ROLL_SPEED * t * t) / (2 * rollEndS);
  const roll = (BENCH_ROLL_SPEED * rollEndS) / 2;
  const climbS = climbEndS - rollEndS;
  const u = Math.min(t, climbEndS) - rollEndS;
  const climb = BENCH_ROLL_SPEED * u + ((BENCH_CRUISE_SPEED - BENCH_ROLL_SPEED) * u * u) / (2 * climbS);
  return roll + climb + BENCH_CRUISE_SPEED * Math.max(0, t - climbEndS);
}

function speedAtTime(route: BenchRouteKind, rollEndS: number, climbEndS: number, t: number): number {
  if (route === "airborne") return BENCH_CRUISE_SPEED;
  if (t <= 0) return 0;
  if (t < rollEndS) return (BENCH_ROLL_SPEED * t) / rollEndS;
  if (t < climbEndS) {
    return BENCH_ROLL_SPEED
      + ((BENCH_CRUISE_SPEED - BENCH_ROLL_SPEED) * (t - rollEndS)) / (climbEndS - rollEndS);
  }
  return BENCH_CRUISE_SPEED;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

/**
 * Builds the route for `world`. Costs about 3,000 terrain samples for the
 * standard 75 s flight; the recorder times it as `pathPrecomputeMs`.
 */
export function createBenchPath(
  world: WorldDefinition,
  timings: Pick<BenchTimings, "rollEndS" | "climbEndS" | "flightS">,
): BenchPath {
  const aircraft = aircraftDefinition(AIRCRAFT);
  // The game's own runway start: the trainer lined up at the threshold, its
  // gear on the runway. The level-ground rest height and attitude come from
  // the simulation's spawn, so the roll sits where a player's would.
  const level = createFlightState({ onGround: true, terrainHeight: 0 }, aircraft);
  const cgHeight = level.position.y;
  const groundPitch = Math.asin(
    Math.min(1, Math.max(-1, 2 * (level.orientation.x * level.orientation.y + level.orientation.w * level.orientation.z))),
  );
  const route: BenchRouteKind = world.airport ? "runway" : "airborne";
  const spawn = createSimulationSpawn(world, route, 450, AIRCRAFT);
  const startX = spawn.position?.x ?? 0;
  const startZ = spawn.position?.z ?? 0;
  const headingRadians = spawn.heading ?? 0;
  const directionX = Math.sin(headingRadians);
  const directionZ = Math.cos(headingRadians);
  const runwayY = route === "runway" && world.airport
    ? createFlightState(spawn, aircraft).position.y
    : surfaceHeight(world, startX, startZ) + cgHeight;
  const { rollEndS, climbEndS, flightS } = timings;

  // One second past the flight's end, so its last frame still interpolates.
  const samples = Math.ceil((flightS + 1) * PROFILE_HZ) + 1;
  const altitude = new Float64Array(samples);
  const ground = new Float64Array(samples);
  const dt = 1 / PROFILE_HZ;
  for (let k = 0; k < samples; k += 1) {
    const t = k * dt;
    const along = distanceAt(route, rollEndS, climbEndS, t);
    const x = startX + directionX * along;
    const z = startZ + directionZ * along;
    const here = surfaceHeight(world, x, z);
    ground[k] = here;
    if (route === "runway" && t <= rollEndS) {
      altitude[k] = runwayY;
      continue;
    }
    const ahead = along + speedAtTime(route, rollEndS, climbEndS, t) * LOOK_AHEAD_S;
    const target = Math.max(
      here,
      surfaceHeight(world, startX + directionX * ahead, startZ + directionZ * ahead),
    ) + BENCH_CLEARANCE;
    if (k === 0) {
      // Airborne route only: start at the cruise height.
      altitude[k] = Math.max(target, here + CRUISE_MIN_CLEARANCE);
      continue;
    }
    const climbingOut = route === "runway" && t < climbEndS;
    const climbRate = climbingOut
      ? CLIMB_OUT_RATE * Math.min(1, (t - rollEndS) / ROTATION_S)
      : CRUISE_CLIMB_RATE;
    const previous = altitude[k - 1]!;
    const stepped = previous + Math.min(climbRate * dt, Math.max(-DESCENT_RATE * dt, target - previous));
    altitude[k] = Math.max(stepped, here + (climbingOut ? cgHeight : CRUISE_MIN_CLEARANCE));
  }

  const half = (headingRadians - Math.PI / 2) * 0.5;
  const path = {
    route,
    rollEndS,
    climbEndS,
    flightS,
    startX,
    startZ,
    headingRadians,
    directionX,
    directionZ,
    cgHeight,
    runwayY,
    groundPitch,
    altitude,
    ground,
    fingerprint: "",
    yawSin: Math.sin(half),
    yawCos: Math.cos(half),
  };
  return { ...path, fingerprint: pathFingerprint(path, world.seed) };
}

/**
 * FNV-1a over the seed, the route's id and kind, its start and heading, and
 * the altitude profile at 10 cm. Equal on every device that computes the same
 * terrain; a mismatch is reported, not fatal.
 */
export function pathFingerprint(
  path: Pick<BenchPath, "route" | "startX" | "startZ" | "headingRadians" | "altitude">,
  seed: string,
): string {
  const hash = new Fnv1a()
    .text(seed)
    .text(BENCH_PATH_ID)
    .text(path.route)
    .int(Math.round(path.startX * 10))
    .int(Math.round(path.startZ * 10))
    .int(Math.round(path.headingRadians * 1e6));
  for (const height of path.altitude) hash.int(Math.round(height * 10));
  return hash.hex();
}

/** The pitch the route shows at `t`, radians: the runway attitude, a climb-out, then level. */
function pitchAt(path: BenchPath, t: number): number {
  if (path.route === "airborne") return 0;
  if (t < path.rollEndS) return path.groundPitch;
  if (t >= path.climbEndS) return 0;
  const raised = path.groundPitch
    + (CLIMB_OUT_PITCH - path.groundPitch) * smoothstep(path.rollEndS, path.rollEndS + ROTATION_S, t);
  return raised * (1 - smoothstep(path.climbEndS - ROTATION_S, path.climbEndS, t));
}

/** A fresh state with its own nested objects: `INITIAL_VISUAL_STATE` is shared and not frozen (S5). */
export function createBenchVisualState(): FlightVisualState {
  return {
    ...INITIAL_VISUAL_STATE,
    position: { ...INITIAL_VISUAL_STATE.position },
    velocity: { ...INITIAL_VISUAL_STATE.velocity },
    orientation: { ...INITIAL_VISUAL_STATE.orientation },
    angularVelocity: { ...INITIAL_VISUAL_STATE.angularVelocity },
  };
}

/**
 * Writes the route at flight time `t` (seconds, clamped to the profile) into
 * `out`, allocating nothing. `out` should come from `createBenchVisualState`.
 */
export function writeFlightState(path: BenchPath, t: number, out: FlightVisualState): FlightVisualState {
  const last = path.altitude.length - 1;
  const time = Math.min(Math.max(0, t), last / PROFILE_HZ);
  const index = Math.min(last - 1, Math.floor(time * PROFILE_HZ));
  const fraction = time * PROFILE_HZ - index;
  const y0 = path.altitude[index]!;
  const y1 = path.altitude[index + 1]!;
  const g0 = path.ground[index]!;
  const g1 = path.ground[index + 1]!;
  const y = y0 + (y1 - y0) * fraction;
  const verticalSpeed = (y1 - y0) * PROFILE_HZ;
  const speed = speedAtTime(path.route, path.rollEndS, path.climbEndS, time);
  const along = distanceAt(path.route, path.rollEndS, path.climbEndS, time);
  const onGround = path.route === "runway" && time < path.rollEndS;

  out.position.x = path.startX + path.directionX * along;
  out.position.y = y;
  out.position.z = path.startZ + path.directionZ * along;
  out.velocity.x = path.directionX * speed;
  out.velocity.y = verticalSpeed;
  out.velocity.z = path.directionZ * speed;
  writeOrientation(path, pitchAt(path, time), out);
  out.angularVelocity.x = 0;
  out.angularVelocity.y = 0;
  out.angularVelocity.z = 0;
  out.airspeed = speed;
  out.altitude = y;
  out.altitudeAgl = Math.max(0, y - path.cgHeight - (g0 + (g1 - g0) * fraction));
  out.verticalSpeed = verticalSpeed;
  out.heading = ((((path.headingRadians * 180) / Math.PI) % 360) + 360) % 360;
  out.bank = 0;
  out.sideslip = 0;
  out.angleOfAttack = onGround ? 0 : 3;
  out.throttle = time < path.climbEndS ? 1 : 0.68;
  out.engineRpm = time < path.climbEndS ? 2_600 : 2_250;
  out.onGround = onGround;
  out.gear = 1;
  out.flaps = 0;
  out.brake = 0;
  out.stalled = false;
  out.crashed = false;
  out.simulationTime = time;
  return out;
}

/**
 * The settle's held pose: the route's start, stopped on the runway but with
 * its velocity pointing down the runway, so streaming looks ahead along the
 * route (R8). The airborne route holds its first pose at cruise speed.
 */
export function writeSettleState(path: BenchPath, out: FlightVisualState): FlightVisualState {
  writeFlightState(path, 0, out);
  if (path.route === "runway") {
    out.velocity.x = path.directionX * BENCH_SETTLE_CREEP;
    out.velocity.z = path.directionZ * BENCH_SETTLE_CREEP;
    out.airspeed = 0;
    out.throttle = 0;
    out.engineRpm = SETTLE_IDLE_RPM;
  }
  return out;
}

function writeOrientation(path: BenchPath, pitch: number, out: FlightVisualState): void {
  // quaternionFromFlightAngles(heading, pitch, 0) with no bank, expanded so a
  // frame allocates nothing: yaw about +Y by heading - 90 degrees, then pitch
  // about body +Z.
  const pitchSin = Math.sin(pitch * 0.5);
  const pitchCos = Math.cos(pitch * 0.5);
  out.orientation.x = path.yawSin * pitchSin;
  out.orientation.y = path.yawSin * pitchCos;
  out.orientation.z = path.yawCos * pitchSin;
  out.orientation.w = path.yawCos * pitchCos;
  out.pitch = (pitch * 180) / Math.PI;
}

/** The route's speed at flight time `t`, m/s. */
export function benchPathSpeed(path: BenchPath, t: number): number {
  return speedAtTime(path.route, path.rollEndS, path.climbEndS, t);
}

/** Metres flown by flight time `t`. */
export function benchPathDistance(path: BenchPath, t: number): number {
  return distanceAt(path.route, path.rollEndS, path.climbEndS, t);
}

/** For the step result; `expectedFingerprint` is the run plan's `pathFingerprint`. */
export function benchPathSummary(path: BenchPath, expectedFingerprint: string): BenchPathSummary {
  return {
    route: path.route,
    startX: path.startX,
    startZ: path.startZ,
    headingDeg: (path.headingRadians * 180) / Math.PI,
    rollEndS: path.rollEndS,
    climbEndS: path.climbEndS,
    rollSpeed: BENCH_ROLL_SPEED,
    cruiseSpeed: BENCH_CRUISE_SPEED,
    clearance: BENCH_CLEARANCE,
    distanceM: benchPathDistance(path, path.flightS),
    fingerprint: path.fingerprint,
    matchesExpected: path.fingerprint === expectedFingerprint,
  };
}
