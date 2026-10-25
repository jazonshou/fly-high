/**
 * Ground handling, measured headless on a flat, dry surface (friction 1) and
 * on the real crowned runway: `npx tsx scripts/ground-handling-probe.mts [kind]`.
 *
 * - brake: full wheel brake from a speed, throttle closed (and left at 5%):
 *   seconds and metres to a stop, and how long the last 2 m/s took.
 * - steer: a held full steering input (rudder pedals, Q/E, or the A/D axis)
 *   from a speed: the turn it produces after two seconds.
 * - brake+steer: braking hard while steering: how far the track turns.
 * - drift: rolling down the real runway with neutral controls.
 */
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  type AircraftKind,
  type FlightControls,
} from "../src/sim";
import { createWorld } from "../src/world";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import { createSimulationSpawn } from "../src/game/spawn";

const kinds = (process.argv[2] ? [process.argv[2]] : AIRCRAFT_KINDS) as AircraftKind[];
const flat = { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1 } as const;

function rollingSim(kind: AircraftKind, speed: number): FlightSimulator {
  const controls = { ...DEFAULT_CONTROLS, throttle: 0 };
  const sim = new FlightSimulator({
    aircraft: aircraftDefinition(kind),
    spawn: { onGround: true, terrainHeight: 0, heading: 0, airspeed: speed, controls },
    controls,
    environment: { terrain: flat, wind: { x: 0, y: 0, z: 0 } },
  });
  // Let the suspension settle at speed without slowing much.
  return sim;
}

function groundSpeed(sim: FlightSimulator): number {
  return Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
}

function brakeStop(kind: AircraftKind, speed: number, throttle: number) {
  const sim = rollingSim(kind, speed);
  const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle, brake: 1 };
  let time = 0;
  let below2 = Number.NaN;
  const start = { ...sim.state.position };
  while (time < 120) {
    sim.step(FIXED_TIME_STEP, controls);
    time += FIXED_TIME_STEP;
    const v = groundSpeed(sim);
    if (Number.isNaN(below2) && v < 2) below2 = time;
    if (v < 0.01) break;
  }
  const distance = Math.hypot(sim.state.position.x - start.x, sim.state.position.z - start.z);
  return {
    seconds: time,
    metres: distance,
    last2: time - below2,
    endSpeed: groundSpeed(sim),
    crashed: sim.state.crashed,
  };
}

function steer(kind: AircraftKind, speed: number, axis: "yaw" | "roll", brake = 0, seconds = 2) {
  const sim = rollingSim(kind, speed);
  // Hold the speed with thrust-free coasting: short window, so it barely slows.
  const controls: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0, brake, [axis]: 1 };
  const startTrack = Math.atan2(sim.state.velocity.x, sim.state.velocity.z);
  const startHeading = 0;
  let maxLateral = 0;
  let time = 0;
  let lastTrack = startTrack;
  let trackRate = 0;
  while (time < seconds) {
    sim.step(FIXED_TIME_STEP, controls);
    time += FIXED_TIME_STEP;
    const v = groundSpeed(sim);
    const track = v > 0.3 ? Math.atan2(sim.state.velocity.x, sim.state.velocity.z) : lastTrack;
    trackRate = (track - lastTrack) / FIXED_TIME_STEP;
    lastTrack = track;
    maxLateral = Math.max(maxLateral, Math.abs(trackRate * v));
    if (sim.state.crashed || v < 0.05) break;
  }
  const t = sim.telemetry();
  const v = groundSpeed(sim);
  return {
    speed: v,
    trackTurned: ((lastTrack - startTrack) * 180) / Math.PI,
    headingTurned: ((t.heading - startHeading) * 180) / Math.PI,
    radius: Math.abs(trackRate) > 1e-4 ? v / Math.abs(trackRate) : Infinity,
    lateralG: maxLateral / 9.80665,
    bank: (t.bank * 180) / Math.PI,
    crashed: sim.state.crashed,
  };
}

function runwayDrift(kind: AircraftKind, speed: number, seconds: number) {
  const world = createWorld(0x51a7e);
  const airport = world.airport!;
  const contact = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
  const spawn = createSimulationSpawn(world, "runway", 450, kind);
  spawn.airspeed = speed;
  const controls = { ...DEFAULT_CONTROLS, throttle: 0, trim: spawn.controls?.trim ?? 0 };
  spawn.controls = controls;
  const sim = new FlightSimulator({
    aircraft: aircraftDefinition(kind),
    spawn,
    controls,
    environment: {
      terrain: (x, z) => sampleGroundContact(world, x, z, contact),
      terrainHeight: (x, z) => sampleGroundHeight(world, x, z),
      seaLevel: world.seaLevel,
      wind: { x: 0, y: 0, z: 0 },
    },
  });
  const dirX = Math.sin(airport.headingRadians);
  const dirZ = Math.cos(airport.headingRadians);
  const across = () => (sim.state.position.x - airport.centerX) * -dirZ + (sim.state.position.z - airport.centerZ) * dirX;
  const start = across();
  let worst = 0;
  for (let time = 0; time < seconds; time += FIXED_TIME_STEP) {
    sim.step(FIXED_TIME_STEP, controls);
    worst = Math.max(worst, Math.abs(across() - start));
    if (groundSpeed(sim) < 0.05) break;
  }
  return { drift: across() - start, worst, endSpeed: groundSpeed(sim) };
}

const f = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : String(value));
for (const kind of kinds) {
  console.log(`\n=== ${kind}`);
  for (const speed of [10, 30, 60]) {
    for (const throttle of [0, 0.05]) {
      const r = brakeStop(kind, speed, throttle);
      console.log(
        `brake from ${speed} m/s, throttle ${throttle}: ${f(r.seconds)} s, ${f(r.metres, 0)} m, last 2 m/s took ${f(r.last2)} s`
          + `${r.endSpeed > 0.01 ? `, still ${f(r.endSpeed, 2)} m/s` : ""}${r.crashed ? " CRASHED" : ""}`,
      );
    }
  }
  for (const speed of [3, 8, 20, 40]) {
    for (const axis of ["yaw", "roll"] as const) {
      const r = steer(kind, speed, axis);
      console.log(
        `steer ${axis} from ${speed} m/s: track ${f(r.trackTurned)} deg, heading ${f(r.headingTurned)} deg in 2 s,`
          + ` radius ${f(r.radius, 0)} m, peak ${f(r.lateralG, 2)} g, bank ${f(r.bank)}${r.crashed ? " CRASHED" : ""}`,
      );
    }
  }
  for (const speed of [15, 30]) {
    const r = steer(kind, speed, "yaw", 1, 4);
    console.log(`brake+steer yaw from ${speed} m/s: track ${f(r.trackTurned)} deg, heading ${f(r.headingTurned)} deg, end ${f(r.speed)} m/s`);
    const q = steer(kind, speed, "roll", 1, 4);
    console.log(`brake+steer roll from ${speed} m/s: track ${f(q.trackTurned)} deg, heading ${f(q.headingTurned)} deg, end ${f(q.speed)} m/s`);
  }
  const d = runwayDrift(kind, 40, 25);
  console.log(`runway roll from 40 m/s, neutral: drift ${f(d.drift, 2)} m (worst ${f(d.worst, 2)}), end ${f(d.endSpeed)} m/s`);
}
