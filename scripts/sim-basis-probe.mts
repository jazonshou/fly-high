/**
 * D-6 end-to-end basis probe: for each pilot control, compare
 *   (a) the SIM's claim (telemetry sign / heading delta), with
 *   (b) the VISUAL result on screen, derived from two separately MEASURED
 *       facts:
 *       - the renderer copies `state.orientation` onto the aircraft root
 *         verbatim (`FlightRenderer.updatePresentation`), and
 *       - the mesh's physical starboard side is body +Z and a Babylon camera
 *         looking along fwd with up sees screen-right = fwd x up
 *         (`scripts/bodyaxes-probe.mts`, measured against Babylon's own
 *         camera rather than a hand convention).
 *
 * PITCH is the built-in null: it is chirality-invariant about the wing axis,
 * so sim and visual MUST agree there or this instrument is broken.
 *
 * Ran before the D-6 settlement it showed the mirror (roll +1: telemetry bank
 * +76.7 deg while the starboard wingtip pointed UP, world y +0.972); after it,
 * identical magnitudes with chirality inverted only. The compass note: until
 * the D-6 brief's option (a) is decided, pilot-right turns DECREASE the
 * displayed heading, which this probe prints but does not judge.
 *
 *   npx tsx scripts/sim-basis-probe.mts
 */
import { FlightSimulator, getFlightTelemetry } from "../src/sim";
import { rotateVectorInto } from "../src/sim/math";
import type { Vec3 } from "../src/sim/types";

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

function freshSim(): FlightSimulator {
  return new FlightSimulator({
    spawn: { position: { x: 0, y: 1200, z: 0 }, airspeed: 65, onGround: false },
  });
}

function worldImage(sim: FlightSimulator, body: Vec3): Vec3 {
  const out = { x: 0, y: 0, z: 0 };
  rotateVectorInto(out, sim.state.orientation, body);
  return out;
}

function run(label: string, controls: Record<string, number>, seconds: number): void {
  const sim = freshSim();
  for (let t = 0; t < 0.5; t += 1 / 120) sim.step(1 / 120);
  const before = getFlightTelemetry(sim.state, sim.environment, sim.aircraft);
  const fwd0 = worldImage(sim, { x: 1, y: 0, z: 0 });
  const up0 = worldImage(sim, { x: 0, y: 1, z: 0 });
  for (let t = 0; t < seconds; t += 1 / 120) sim.step(1 / 120, controls as never);
  const after = getFlightTelemetry(sim.state, sim.environment, sim.aircraft);
  const fwd1 = worldImage(sim, { x: 1, y: 0, z: 0 });
  // Mesh starboard side is body +Z (7cacc44): its world image on screen.
  const starboardTip = worldImage(sim, { x: 0, y: 0, z: 1 });
  // Screen-right for a camera tracking the plane: fwd x up (measured fact).
  const screenRight0 = cross(fwd0, up0);
  const swing = { x: fwd1.x - fwd0.x, y: fwd1.y - fwd0.y, z: fwd1.z - fwd0.z };
  const visualTurn = dot(swing, screenRight0);
  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
  console.log(`\n== ${label} for ${seconds}s`);
  console.log(`  telemetry: bank ${deg(after.bank)} deg, `
    + `heading ${deg(before.heading)} -> ${deg(after.heading)} deg, `
    + `pitch ${deg(after.pitch)} deg`);
  console.log(`  world: starboard(+Z) wingtip y = ${starboardTip.y.toFixed(3)} `
    + `(<0 means starboard wing DOWN on screen)`);
  console.log(`  visual nose swing (dFwd . screenRight) = ${visualTurn.toFixed(4)} `
    + `(>0 means nose swings RIGHT on screen)`);
}

run("PITCH null control: pitch=+0.6 (telemetry nose-up AND visual nose-up must agree)", { pitch: 0.6, throttle: 0.7 }, 0.7);
run("ROLL: roll=+1 (pilot RIGHT-wing-down)", { roll: 1, throttle: 0.7 }, 1.2);
run("YAW: yaw=+1 (pilot nose-RIGHT)", { yaw: 1, throttle: 0.7 }, 1.5);
