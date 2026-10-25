/**
 * Flies the autoland test's thirteen flights headless and prints one row each:
 * `npx tsx scripts/autoland-summary.mts [kind]`. Seed 0x51a7e, real terrain
 * and wind, the test's microburst strengths.
 *
 * Columns: approaches flown; seconds from engagement to the touchdown and to
 * the stop; main-gear sink and touchdown distance; hardest wheel contact;
 * stop distance past the threshold and right of the centreline; the largest
 * heading error to the runway below 30 m/s on the rollout, and at the stop.
 */
import {
  aircraftDefinition,
  AIRCRAFT_KINDS,
  Autoland,
  FIXED_TIME_STEP,
  FlightSimulator,
  type AircraftKind,
  type FlightControls,
} from "../src/sim";
import { createWorld, isPointOnRunway, nearestAirport, sampleWind } from "../src/world";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import { createSimulationSpawn } from "../src/game/spawn";

const SEED = 0x51a7e;
const kinds = (process.argv[2] ? [process.argv[2]] : AIRCRAFT_KINDS) as AircraftKind[];
const microbursts: Record<AircraftKind, number> = { trainer: 7, jet: 25, bizjet: 28, airliner: 28 };

function fly(kind: AircraftKind, scenario: "spawn" | "away" | "short-high", microburst = 0) {
  const world = createWorld(SEED);
  const airport = world.airport!;
  const contact = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
  const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
  const spawn = createSimulationSpawn(world, "airborne", 450, kind);
  const dirX = Math.sin(airport.headingRadians);
  const dirZ = Math.cos(airport.headingRadians);
  if (scenario === "short-high") {
    const distance = airport.runwayLength / 2 + 1_500;
    spawn.position = { x: airport.centerX - dirX * distance, y: airport.elevation + 400, z: airport.centerZ - dirZ * distance };
    spawn.heading = airport.headingRadians;
  } else if (scenario === "away") {
    spawn.heading = airport.headingRadians + Math.PI;
  }
  const sim = new FlightSimulator({
    aircraft: aircraftDefinition(kind),
    spawn,
    environment: {
      terrain: (x, z) => sampleGroundContact(world, x, z, contact),
      terrainHeight: (x, z) => sampleGroundHeight(world, x, z),
      seaLevel: world.seaLevel,
      wind,
    },
  });
  const autoland = new Autoland(sim.aircraft);
  const input = {
    state: sim.state,
    telemetry: sim.telemetry(),
    terrainHeight: (x: number, z: number) => sampleGroundHeight(world, x, z),
    seaLevel: world.seaLevel,
    dt: FIXED_TIME_STEP,
  };
  const controls: FlightControls = { ...sim.controls };
  const runway = nearestAirport(world, sim.state.position.x, sim.state.position.z)!.airport;
  autoland.engage(runway, input, controls);
  let burstX = Number.NaN;
  let burstZ = Number.NaN;
  let burstStrength = 0;
  let touchdownTime = Number.NaN;
  let worstSlowHeading = 0;
  for (let step = 0; step < 2_000 / FIXED_TIME_STEP; step += 1) {
    const position = sim.state.position;
    sampleWind(world, position.x, position.y, position.z, sim.state.time, wind);
    input.state = sim.state;
    input.telemetry = sim.telemetry();
    if (microburst > 0) {
      if (Number.isNaN(burstX) && autoland.status.phase === "final") {
        const speed = Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
        burstX = position.x + (sim.state.velocity.x / speed) * 1_200;
        burstZ = position.z + (sim.state.velocity.z / speed) * 1_200;
        burstStrength = microburst;
      }
      if (autoland.status.attempt > 1 || autoland.status.phase === "go-around") burstStrength *= Math.exp(-FIXED_TIME_STEP / 15);
      if (!Number.isNaN(burstX)) {
        wind.y -= burstStrength * Math.exp(-(((position.x - burstX) ** 2 + (position.z - burstZ) ** 2) / 800 ** 2));
      }
    }
    autoland.update(input, controls);
    if (Number.isNaN(touchdownTime) && autoland.status.phase === "rollout") touchdownTime = sim.state.time;
    sim.setControls(controls);
    sim.step(FIXED_TIME_STEP);
    const groundSpeed = Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
    if (autoland.status.phase === "rollout" && groundSpeed < 30 && sim.state.dynamics.contactCount >= sim.aircraft.gear.length) {
      const error = Math.atan2(Math.sin(sim.telemetry().heading - autoland.status.runwayHeading), Math.cos(sim.telemetry().heading - autoland.status.runwayHeading));
      worstSlowHeading = Math.max(worstSlowHeading, Math.abs(error));
    }
    if (sim.state.crashed || autoland.status.phase === "landed" || !autoland.engaged) break;
  }
  const status = autoland.status;
  const end = (autoland as unknown as { end: { thresholdX: number; thresholdZ: number; dirX: number; dirZ: number } }).end;
  const rx = sim.state.position.x - end.thresholdX;
  const rz = sim.state.position.z - end.thresholdZ;
  const stopHeading = Math.atan2(Math.sin(sim.telemetry().heading - status.runwayHeading), Math.cos(sim.telemetry().heading - status.runwayHeading));
  return {
    label: `${kind} ${scenario}${microburst ? ` burst ${microburst}` : ""}`,
    attempts: status.attempt,
    reason: status.goAroundReason ?? "",
    touchdownTime,
    stopTime: sim.state.time,
    sink: status.touchdownSinkRate,
    touchdown: status.touchdownDistance,
    impact: sim.state.peakImpactSpeed,
    stopAlong: rx * end.dirX + rz * end.dirZ,
    stopRight: rx * -end.dirZ + rz * end.dirX,
    slowHeading: (worstSlowHeading * 180) / Math.PI,
    stopHeading: (stopHeading * 180) / Math.PI,
    landed: status.phase === "landed" && !sim.state.crashed && isPointOnRunway(runway, sim.state.position.x, sim.state.position.z),
    peakAoa: (status.peakAngleOfAttack * 180) / Math.PI,
    peakBank: (status.peakBank * 180) / Math.PI,
  };
}

const f = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "-");
console.log("| Flight | Approaches | Touchdown s | Stop s | Sink m/s | Touchdown m | Impact m/s | Stop m (right) | Heading below 30 m/s | Heading at stop | AoA / bank deg | OK |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const kind of kinds) {
  const flights = [fly(kind, "spawn"), fly(kind, "away")];
  if (kind === "trainer") flights.push(fly(kind, "short-high"));
  flights.push(fly(kind, "spawn", microbursts[kind]));
  for (const r of flights) {
    console.log(
      `| ${r.label} | ${r.attempts}${r.reason ? ` (${r.reason})` : ""} | ${f(r.touchdownTime, 0)} | ${f(r.stopTime, 0)} | ${f(r.sink, 2)} | ${f(r.touchdown, 0)}`
        + ` | ${f(r.impact, 2)} | ${f(r.stopAlong, 0)} (${f(r.stopRight, 1)}) | ${f(r.slowHeading, 2)} | ${f(r.stopHeading, 2)} | ${f(r.peakAoa)} / ${f(r.peakBank)} | ${r.landed ? "yes" : "NO"} |`,
    );
  }
}
