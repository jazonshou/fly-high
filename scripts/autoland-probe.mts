/**
 * Flies the autoland headless, against the real world terrain and wind, and
 * prints a trace: `npx tsx scripts/autoland-probe.mts [kind] [scenario] [seed]`.
 */
import { aircraftDefinition, Autoland, FlightSimulator, FIXED_TIME_STEP, type AircraftKind } from "../src/sim";
import { createWorld, nearestAirport, sampleWind, isPointOnRunway } from "../src/world";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import { createSimulationSpawn } from "../src/game/spawn";

const kind = (process.argv[2] ?? "trainer") as AircraftKind;
const scenario = process.argv[3] ?? "spawn";
const seed = process.argv[4] ? Number(process.argv[4]) : 0x51a7e;
const world = createWorld(seed);
const airport = world.airport!;
const contact = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 0.86 };
const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
const spawn = createSimulationSpawn(world, "airborne", 450, kind);
const dir = { x: Math.sin(airport.headingRadians), z: Math.cos(airport.headingRadians) };
if (scenario === "short-high") {
  // 1.5 km short of the threshold, lined up, far too high.
  const d = airport.runwayLength / 2 + 1500;
  spawn.position = { x: airport.centerX - dir.x * d, y: airport.elevation + 400, z: airport.centerZ - dir.z * d };
  spawn.heading = airport.headingRadians;
} else if (scenario === "away") {
  spawn.heading = airport.headingRadians + Math.PI;
} else if (scenario === "far") {
  spawn.position = { x: airport.centerX + 12000, y: airport.elevation + 2500, z: airport.centerZ - 9000 };
  spawn.heading = 1.2;
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
const controls = { ...sim.controls };
const target = nearestAirport(world, sim.state.position.x, sim.state.position.z)!.airport;
console.log("engage", autoland.engage(target, input, controls), autoland.status, autoland.profile);
let lastPhase = "";
let lastImpact = 0;
const burst = { x: Number.NaN, z: Number.NaN, strength: 0 };
let lastPrint = -10;
const limit = Number(process.env.SECONDS ?? 900);
for (let step = 0; step < limit / FIXED_TIME_STEP; step += 1) {
  const p = sim.state.position;
  sampleWind(world, p.x, p.y, p.z, sim.state.time, wind);
  // BURST=strength: the test's smooth microburst on the first final.
  if (process.env.BURST) {
    if (Number.isNaN(burst.x) && autoland.status.phase === "final") {
      const speed = Math.hypot(sim.state.velocity.x, sim.state.velocity.z);
      burst.x = p.x + (sim.state.velocity.x / speed) * 1_200;
      burst.z = p.z + (sim.state.velocity.z / speed) * 1_200;
      burst.strength = Number(process.env.BURST);
    }
    if (autoland.status.attempt > 1 || autoland.status.phase === "go-around") burst.strength *= Math.exp(-FIXED_TIME_STEP / 15);
    if (!Number.isNaN(burst.x)) wind.y -= burst.strength * Math.exp(-(((p.x - burst.x) ** 2 + (p.z - burst.z) ** 2) / 800 ** 2));
  }
  (input as { telemetry: unknown }).telemetry = sim.telemetry();
  (input as { state: unknown }).state = sim.state;
  autoland.update(input, controls);
  sim.setControls(controls);
  sim.step(FIXED_TIME_STEP);
  const t = sim.telemetry();
  const st = autoland.status;
  if (sim.state.peakImpactSpeed > lastImpact + 0.05) { lastImpact = sim.state.peakImpactSpeed; if (process.env.IMPACT) console.log(`impact ${lastImpact.toFixed(2)} at t=${sim.state.time.toFixed(2)} phase=${st.phase} cc=${sim.state.dynamics.contactCount} pitch=${(sim.telemetry().pitch*57.3).toFixed(2)} q=${(sim.state.angularVelocity.z*57.3).toFixed(2)}`); }
  if (st.phase !== lastPhase || sim.state.time - lastPrint > Number(process.env.EVERY ?? 10)) {
    lastPrint = sim.state.time;
    if (st.phase !== lastPhase) console.log(`--- ${st.phase} (attempt ${st.attempt}${st.goAroundReason ? `, last GA ${st.goAroundReason}` : ""})`);
    lastPhase = st.phase;
    console.log(
      `t=${sim.state.time.toFixed(1)} dist=${st.distanceToTouchdown.toFixed(0)} h=${(p.y - airport.elevation).toFixed(1)} agl=${t.altitudeAgl.toFixed(1)}`
      + ` ias=${t.indicatedAirspeed.toFixed(1)}/${st.targetAirspeed.toFixed(1)} vs=${t.verticalSpeed.toFixed(2)} pitch=${(t.pitch * 57.3).toFixed(1)}`
      + ` bank=${(t.bank * 57.3).toFixed(1)} aoa=${(t.angleOfAttack * 57.3).toFixed(1)} hdg=${(t.heading * 57.3).toFixed(0)}`
      + ` thr=${sim.state.actuators.throttle.toFixed(2)} flap=${sim.state.actuators.flaps.toFixed(2)} gear=${sim.state.actuators.gear.toFixed(2)} brk=${sim.state.actuators.brake.toFixed(2)}`
      + ` x=${(() => { const e = (autoland as unknown as { end: { thresholdX: number; thresholdZ: number; dirX: number; dirZ: number; heading: number } }).end; const rx = p.x - e.thresholdX, rz = p.z - e.thresholdZ; return `${(rx * e.dirX + rz * e.dirZ).toFixed(0)}/${(rx * -e.dirZ + rz * e.dirX).toFixed(1)} trk=${(Math.atan2(sim.state.velocity.x, sim.state.velocity.z) * 57.3).toFixed(1)} rwy=${(e.heading * 57.3).toFixed(1)}`; })()}`
      + ` gs=${Math.hypot(sim.state.velocity.x, sim.state.velocity.z).toFixed(1)} cc=${sim.state.dynamics.contactCount} el=${sim.state.actuators.pitch.toFixed(2)} ail=${sim.state.actuators.roll.toFixed(2)} rud=${sim.state.actuators.yaw.toFixed(2)}`,
    );
  }
  if (sim.state.crashed) { console.log("CRASHED", t, sim.state.peakImpactSpeed); break; }
  if (st.phase === "landed" || st.phase === "off") break;
}
const p = sim.state.position;
console.log("final", autoland.status, "onRunway", isPointOnRunway(target, p.x, p.z), "peakImpact", sim.state.peakImpactSpeed, "time", sim.state.time.toFixed(0));
{
  const e = autoland as unknown as { end: { thresholdX: number; thresholdZ: number; dirX: number; dirZ: number } };
  const rx = p.x - e.end.thresholdX, rz = p.z - e.end.thresholdZ;
  console.log("stop: past threshold", (rx * e.end.dirX + rz * e.end.dirZ).toFixed(1), "right of centre", (rx * -e.end.dirZ + rz * e.end.dirX).toFixed(2));
}
