/**
 * What can each aeroplane actually do, measured by flying it?
 *
 * Every figure here comes out of the SHIPPED simulator at the shipped fixed
 * step, not out of a lift equation. That matters for two decisions on the
 * table: whether a book-faithful Cessna 150 can cross this world's mountains
 * without it being a chore, and whether a Global 8000 can get off a 1,320 m
 * runway at all. Both are questions about the integrated aeroplane — thrust
 * lapse, drag rise, ground friction, rotation — that a closed-form estimate
 * answers only approximately and, in the Global's case, optimistically.
 *
 * The aeroplane is flown by a simple airspeed-hold: pitch is driven to a
 * target indicated airspeed through a proportional-derivative loop on the
 * speed error, which is what a pilot does and what makes a climb figure mean
 * "best rate held steady" rather than "whatever it did".
 *
 *   npx tsx scripts/aircraft-performance.mts [kind ...]
 */
import {
  aircraftDefinition,
  FlightSimulator,
  type AircraftDefinition,
  type AircraftKind,
  type FlightControls,
} from "../src/sim";
import { DEFAULT_AIRPORT } from "../src/world/airport";

const STEP = 1 / 120;
/**
 * Ground at y = 0, not at the airport's 24 m.
 *
 * `createFlightState` solves a ground spawn's height without consulting the
 * environment, so it places the wheels on y = 0 whatever the terrain sampler
 * says. Putting the surface anywhere else buries the aeroplane 24 m down and
 * the terrain response fires it out at 61 m/s, which reads as a 0 m take-off
 * roll. The 24 m of density difference is worth about 0.2% of thrust.
 */
const FIELD_ELEVATION = 0;
/**
 * Where the "sea level" climb is flown. Not 0: the ground is at 0, and an
 * aeroplane spawned on it does not climb, it crashes — which reported as "no
 * arm settled" rather than as an error.
 */
const LOW_LEVEL = 500;
const RUNWAY_LENGTH = DEFAULT_AIRPORT.runwayLength;

const flatGround = { height: FIELD_ELEVATION, normal: { x: 0, y: 1, z: 0 } };
const environment = {
  terrain: flatGround,
  terrainHeight: () => FIELD_ELEVATION,
  wind: { x: 0, y: 0, z: 0 },
};

/**
 * Ground distance covered. Heading 0 flies along +Z in this world, not +X, so
 * measuring one axis reports zero for every straight-ahead run.
 */
function groundDistance(
  from: { x: number; z: number },
  to: { x: number; z: number },
): number {
  return Math.hypot(to.x - from.x, to.z - from.z);
}

function controls(overrides: Partial<FlightControls> = {}): FlightControls {
  return {
    throttle: 1,
    pitch: 0,
    roll: 0,
    yaw: 0,
    trim: 0,
    flaps: 0,
    brake: 0,
    gear: 1,
    ...overrides,
  };
}

function airborne(
  aircraft: AircraftDefinition,
  altitudeMsl: number,
  airspeed: number,
  extra: Partial<FlightControls> = {},
): FlightSimulator {
  return new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: altitudeMsl, z: 0 },
      heading: 0,
      pitch: 0,
      airspeed,
      controls: controls({ gear: aircraft.retractableGear ? 0 : 1, ...extra }),
    },
    environment,
  });
}

/**
 * Hold a pitch ATTITUDE, not an airspeed.
 *
 * An airspeed hold has to be tuned per aeroplane — the gains that settle a
 * 726 kg trainer oscillate a 40,000 kg jet with a third of its weight in
 * thrust, and a loop that never settles reports a climb rate of zero. Holding
 * attitude is unconditionally stable across both, and it is what a pilot flies
 * in the climb anyway; the airspeed that results is an output, reported with
 * the climb rate it produced.
 */
function holdAttitude(simulator: FlightSimulator, targetRadians: number): number {
  const telemetry = simulator.telemetry();
  const error = targetRadians - telemetry.pitch;
  const rate = simulator.state.angularVelocity.z;
  return Math.max(-1, Math.min(1, error * 3.2 - rate * 0.9));
}

/**
 * Steady climb at full power holding a pitch attitude, after the transient has
 * died. Returns the rate and the speed it settled at.
 */
function climbAtAttitude(
  aircraft: AircraftDefinition,
  altitudeMsl: number,
  pitchDegrees: number,
): { verticalSpeed: number; airspeed: number } {
  const entry = analyticStallSpeed(aircraft, 0, altitudeMsl) * 1.4;
  const simulator = airborne(aircraft, altitudeMsl, entry);
  const target = (pitchDegrees * Math.PI) / 180;
  let vertical = 0;
  let speed = 0;
  const total = Math.round(90 / STEP);
  const settle = Math.round(60 / STEP);
  for (let step = 0; step < total; step += 1) {
    simulator.setControls({ throttle: 1, pitch: holdAttitude(simulator, target) });
    simulator.step(STEP);
    if (step >= settle) {
      vertical += simulator.telemetry().verticalSpeed;
      speed += simulator.telemetry().airspeed;
    }
  }
  const samples = total - settle;
  return { verticalSpeed: vertical / samples, airspeed: speed / samples };
}

/**
 * Best rate of climb, found by sweeping the attitude flown. A stalled or
 * decelerating arm is rejected rather than allowed to win with a transient.
 */
function climbRate(
  aircraft: AircraftDefinition,
  altitudeMsl: number,
  targetAirspeed: number,
): { verticalSpeed: number; airspeed: number } {
  // Kept for the callers that want a climb at a nominated speed: find the
  // attitude whose settled speed is closest to the one asked for.
  let closest = { verticalSpeed: 0, airspeed: 0 };
  let bestGap = Infinity;
  for (let degrees = 0; degrees <= 30; degrees += 2.5) {
    const result = climbAtAttitude(aircraft, altitudeMsl, degrees);
    if (!Number.isFinite(result.airspeed)) continue;
    const gap = Math.abs(result.airspeed - targetAirspeed);
    if (gap < bestGap) {
      bestGap = gap;
      closest = result;
    }
  }
  return closest;
}

/** Best rate of climb over every attitude the aeroplane will hold. */
function bestClimb(
  aircraft: AircraftDefinition,
  altitudeMsl: number,
): { verticalSpeed: number; airspeed: number } {
  let best = { verticalSpeed: -Infinity, airspeed: 0 };
  const stall = analyticStallSpeed(aircraft, 0, altitudeMsl);
  for (let degrees = 0; degrees <= 30; degrees += 2.5) {
    const result = climbAtAttitude(aircraft, altitudeMsl, degrees);
    // An arm that settled below the stall speed did not settle; it mushed.
    if (!(result.airspeed > stall * 1.05)) continue;
    if (result.verticalSpeed > best.verticalSpeed) best = result;
  }
  return best;
}

/** ISA density, which is what the simulator uses when nothing overrides it. */
function densityAt(altitudeMetres: number): number {
  return 1.225 * (1 - 2.2557e-5 * altitudeMetres) ** 4.2559;
}

/**
 * Where the stall OUGHT to be, from the definition's own lift curve. Used to
 * start the flown measurement near the answer rather than 90 m/s above it: a
 * heavy aeroplane entered at cruise speed and asked to hold altitude pulls
 * hard enough during the entry transient to trip the stall flag at 300 kt,
 * which is how this instrument first reported a Global 8000 stalling at 160
 * m/s.
 */
function analyticStallSpeed(
  aircraft: AircraftDefinition,
  flaps: number,
  altitudeMetres: number,
): number {
  const maximumLift =
    aircraft.clZero + aircraft.clAlpha * aircraft.positiveStallAngle + aircraft.flapLift * flaps;
  const weight = aircraft.mass * 9.80665;
  return Math.sqrt((2 * weight) / (densityAt(altitudeMetres) * aircraft.wingArea * maximumLift));
}

/**
 * Stall speed: settle in level flight, close the throttle, and hold the flight
 * path level until the wing lets go.
 *
 * The settling period is not decoration. Stall detection is armed only after
 * it, so the entry transient cannot be mistaken for the stall.
 */
function stallSpeed(aircraft: AircraftDefinition, flaps: number): number {
  const altitude = 1_500;
  // Entered just above the stall, at idle throughout. Entering fast and
  // decelerating under power was worse in both directions: a powerful
  // aeroplane accelerated during the settle and tripped the flag on the
  // throttle-closure transient, and a light one never reached the stall
  // inside the run.
  const entry = analyticStallSpeed(aircraft, flaps, altitude) * 1.25;
  const simulator = airborne(aircraft, altitude, entry, { flaps });
  let last = simulator.telemetry().airspeed;
  const settle = Math.round(4 / STEP);
  for (let step = 0; step < Math.round(240 / STEP); step += 1) {
    const telemetry = simulator.telemetry();
    // Gentle, and rate-limited by the small gain: a hard pull reaches the
    // critical angle before the aeroplane has slowed to its stall speed, which
    // measures the elevator rather than the wing.
    const pitch = Math.max(-0.6, Math.min(0.6, -telemetry.verticalSpeed * 0.08));
    // Hold height at entry speed first, then close the throttle.
    simulator.setControls({ throttle: 0, flaps, pitch });
    simulator.step(STEP);
    // Armed only once the aeroplane has actually slowed BELOW its entry
    // speed. The settling phase can leave a powerful aeroplane faster than it
    // started, and the pitch transient when the throttle closes then trips the
    // flag well above the stall — which is how a Global 8000 first measured a
    // clean stall of 254 kt.
    const current = simulator.telemetry();
    if (step > settle && current.isStalled) return last;
    last = simulator.telemetry().airspeed;
  }
  return Number.NaN;
}

/**
 * Fastest the aeroplane will go in level flight at full power.
 *
 * Held on ALTITUDE, not on vertical speed. A vertical-speed hold has no
 * memory of where it started, so an aeroplane with a lot of excess thrust
 * trades the altitude away in a shallow climb the loop never notices and the
 * "level" speed comes out low.
 */
function maximumLevelSpeed(aircraft: AircraftDefinition, altitudeMsl: number): number {
  const simulator = airborne(aircraft, altitudeMsl, aircraft.propulsion === "jet" ? 200 : 50);
  for (let step = 0; step < Math.round(600 / STEP); step += 1) {
    const telemetry = simulator.telemetry();
    const altitudeError = simulator.state.position.y - altitudeMsl;
    const pitch = Math.max(
      -0.8,
      Math.min(0.8, -altitudeError * 0.004 - telemetry.verticalSpeed * 0.08),
    );
    simulator.setControls({ throttle: 1, pitch });
    simulator.step(STEP);
  }
  return simulator.telemetry().airspeed;
}

/**
 * Ground roll to lift-off from a standing start, and whether it fits.
 *
 * Rotation speed is taken as 1.15x the flapped stall, the usual margin, and
 * the measurement ends the moment the wheels stop carrying the aeroplane.
 */
function takeoffRoll(
  aircraft: AircraftDefinition,
  flaps: number,
  rotateSpeed: number,
): { roll: number; liftOffSpeed: number } {
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: FIELD_ELEVATION, z: 0 },
      heading: 0,
      pitch: 0,
      airspeed: 0,
      onGround: true,
      controls: controls({ throttle: 1, flaps, gear: 1 }),
    },
    environment,
  });
  const start = { x: simulator.state.position.x, z: simulator.state.position.z };
  for (let step = 0; step < Math.round(120 / STEP); step += 1) {
    const telemetry = simulator.telemetry();
    const pitch = telemetry.airspeed >= rotateSpeed ? 0.55 : 0;
    simulator.setControls({ throttle: 1, flaps, pitch, gear: 1 });
    simulator.step(STEP);
    if (!simulator.state.onGround && simulator.telemetry().altitudeAgl > 0.5) {
      return {
        roll: groundDistance(start, simulator.state.position),
        liftOffSpeed: simulator.telemetry().airspeed,
      };
    }
  }
  return { roll: Number.NaN, liftOffSpeed: Number.NaN };
}

/** Ground roll from touchdown to a stop, with full wheel braking. */
function landingRoll(aircraft: AircraftDefinition, flaps: number, approach: number): number {
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: FIELD_ELEVATION, z: 0 },
      heading: 0,
      pitch: 0,
      airspeed: approach,
      onGround: true,
      controls: controls({ throttle: 0, flaps, brake: 1, gear: 1 }),
    },
    environment,
  });
  const start = { x: simulator.state.position.x, z: simulator.state.position.z };
  for (let step = 0; step < Math.round(180 / STEP); step += 1) {
    simulator.setControls({ throttle: 0, flaps, brake: 1, gear: 1, pitch: 0 });
    simulator.step(STEP);
    if (simulator.telemetry().groundSpeed < 1) break;
  }
  return groundDistance(start, simulator.state.position);
}

/** Time and horizontal distance to climb from the airfield to a given height. */
function climbToAltitude(
  aircraft: AircraftDefinition,
  targetMsl: number,
  pitchDegrees: number,
): { seconds: number; kilometres: number; reached: boolean } {
  const entry = analyticStallSpeed(aircraft, 0, FIELD_ELEVATION) * 1.4;
  const simulator = airborne(aircraft, FIELD_ELEVATION + 60, entry);
  const target = (pitchDegrees * Math.PI) / 180;
  const start = { x: simulator.state.position.x, z: simulator.state.position.z };
  const limit = Math.round(3_600 / STEP);
  for (let step = 0; step < limit; step += 1) {
    simulator.setControls({ throttle: 1, pitch: holdAttitude(simulator, target) });
    simulator.step(STEP);
    if (simulator.state.position.y >= targetMsl) {
      return {
        seconds: step * STEP,
        kilometres: groundDistance(start, simulator.state.position) / 1_000,
        reached: true,
      };
    }
  }
  return { seconds: 3_600, kilometres: Number.NaN, reached: false };
}

/** Highest altitude at which the aeroplane can still manage 0.5 m/s of climb. */
function serviceCeiling(aircraft: AircraftDefinition): number {
  let low = FIELD_ELEVATION;
  let high = 20_000;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const middle = (low + high) / 2;
    if (bestClimb(aircraft, middle).verticalSpeed > 0.5) low = middle;
    else high = middle;
  }
  return low;
}

const MS_TO_KT = 1.94384;
const MS_TO_FPM = 196.85;
const f = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "  --");

function report(kind: AircraftKind, aircraft: AircraftDefinition): void {
  const jet = aircraft.propulsion === "jet";
  const cleanStall = stallSpeed(aircraft, 0);
  const flappedStall = stallSpeed(aircraft, 1);
  const best = bestClimb(aircraft, LOW_LEVEL);
  const at1500 = bestClimb(aircraft, 1_500);
  const maximum = maximumLevelSpeed(aircraft, jet ? 3_000 : 1_000);
  // Rotate at the usual 1.15x the flapped stall. If the flown stall did not
  // resolve, fall back to the lift curve's own figure rather than to nothing.
  const rotateReference = Number.isFinite(flappedStall)
    ? flappedStall
    : analyticStallSpeed(aircraft, 1, FIELD_ELEVATION);
  const rotate = rotateReference * 1.15;
  const takeoff = takeoffRoll(aircraft, jet ? 0.6 : 0.3, rotate);
  const approach = rotateReference * 1.3;
  const landing = landingRoll(aircraft, 1, approach);
  // Climb to the ridge at the attitude that gave the best rate.
  let bestAttitude = 0;
  let bestRate = -Infinity;
  for (let degrees = 0; degrees <= 30; degrees += 2.5) {
    const trial = climbAtAttitude(aircraft, LOW_LEVEL, degrees);
    if (trial.airspeed > analyticStallSpeed(aircraft, 0, LOW_LEVEL) * 1.05
      && trial.verticalSpeed > bestRate) {
      bestRate = trial.verticalSpeed;
      bestAttitude = degrees;
    }
  }
  const toRidge = climbToAltitude(aircraft, 1_600, bestAttitude);
  const ceiling = serviceCeiling(aircraft);

  console.log(`\n${"=".repeat(74)}\n${aircraft.name}  (kind "${kind}", ${aircraft.mass} kg)\n${"=".repeat(74)}`);
  const analyticClean = analyticStallSpeed(aircraft, 0, 1_500);
  const analyticFlapped = analyticStallSpeed(aircraft, 1, 1_500);
  console.log(`  stall, clean        ${f(cleanStall)} m/s  (${f(cleanStall * MS_TO_KT, 0)} kt)`
    + `   [lift curve says ${f(analyticClean)} m/s]`);
  console.log(`  stall, full flap    ${f(flappedStall)} m/s  (${f(flappedStall * MS_TO_KT, 0)} kt)`
    + `   [lift curve says ${f(analyticFlapped)} m/s]`);
  console.log(`  best climb (${LOW_LEVEL} m)  ${f(best.verticalSpeed, 2)} m/s  (${f(best.verticalSpeed * MS_TO_FPM, 0)} ft/min) at ${f(best.airspeed, 0)} m/s`);
  console.log(`  climb at 1,500 m    ${f(at1500.verticalSpeed, 2)} m/s  (${f(at1500.verticalSpeed * MS_TO_FPM, 0)} ft/min) at ${f(at1500.airspeed, 0)} m/s`);
  console.log(`  maximum level       ${f(maximum)} m/s  (${f(maximum * MS_TO_KT, 0)} kt)`);
  console.log(`  service ceiling     ${f(ceiling, 0)} m  (${f(ceiling * 3.28084, 0)} ft)`);
  console.log(`  take-off roll       ${f(takeoff.roll, 0)} m, lifting off at ${f(takeoff.liftOffSpeed, 0)} m/s`
    + `   [runway ${RUNWAY_LENGTH} m, margin ${f(RUNWAY_LENGTH - takeoff.roll, 0)} m]`);
  console.log(`  landing roll        ${f(landing, 0)} m from ${f(approach, 0)} m/s`
    + `   [margin ${f(RUNWAY_LENGTH - landing, 0)} m]`);
  console.log(`  to 1,600 m          ${toRidge.reached ? `${f(toRidge.seconds, 0)} s over ${f(toRidge.kilometres)} km` : "NEVER REACHES IT"}`);
}

const requested = process.argv.slice(2) as AircraftKind[];
const kinds: AircraftKind[] = requested.length > 0
  ? requested
  : ["trainer", "jet"];
for (const kind of kinds) report(kind, aircraftDefinition(kind));
console.log("");
