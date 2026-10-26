import type { FlightVisualState } from "../../src/game/types";
import type { WorldDefinition } from "../../src/world/types";
import { marinaStartPose } from "../../src/world/marina";
import { BoatSimulator } from "../../src/sim/boat";
import { NEUTRAL_BOAT_CONTROLS, flightAnglesOf, surfaceVisualState } from "../../src/sim/surface";
import type { PerfCaptureBoatRun } from "../../scripts/perf-capture.mts";

/** The boat simulator's step, seconds: the worker's 120 Hz. */
const BOAT_STEP_SECONDS = 1 / 120;

/**
 * A boat shot's state (`PerfCaptureShotDefinition.boat`), shared by both
 * harnesses so they photograph the same boat.
 *
 * A dock start is the session's own: made fast at the marina's start berth,
 * at rest. An open-water run starts from rest on the simulator's still water,
 * holds each leg's helm, and is then set down at `at` with its heading turned
 * to the shot's yaw, so the frame is where the shot was placed whatever the
 * run's own track and drift. Still water is the same everywhere, so moving
 * the result changes nothing it computed; the angular velocity is body-frame
 * and the spray roots body-relative, so neither needs turning.
 */
export function buildBoatShotState(
  world: WorldDefinition,
  run: PerfCaptureBoatRun,
  at: { readonly x: number; readonly z: number; readonly yawDegrees: number },
  simulationTime: number,
): FlightVisualState {
  if (run.start === "dock") {
    if (run.legs.length > 0) throw new Error("perf-capture: a dock start lies moored and runs no legs");
    const berth = marinaStartPose(world);
    const moored = new BoatSimulator({
      position: { x: berth.x, y: berth.stillWaterY, z: berth.z },
      heading: berth.headingRadians,
      moored: true,
    });
    return { ...surfaceVisualState(moored.snapshot(), undefined), simulationTime };
  }
  // The simulator's heading is FlightTelemetry's (forward = (sin h, 0, cos h));
  // the capture's yaw flies +x at 0 and turns toward -z, so h = 90 deg + yaw.
  const heading = Math.PI / 2 + (at.yawDegrees * Math.PI) / 180;
  const sim = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading, moored: false });
  for (const leg of run.legs) {
    sim.setControls({ assist: "scenic", boat: { ...NEUTRAL_BOAT_CONTROLS, lever: leg.lever, steer: leg.steer } });
    const steps = Math.round(leg.seconds / BOAT_STEP_SECONDS);
    for (let step = 0; step < steps; step += 1) sim.step(BOAT_STEP_SECONDS);
  }
  const snapshot = sim.snapshot();
  // Turn about world +Y by `turn`: h' = h + turn, so the bow ends on the shot's heading.
  const turn = heading - flightAnglesOf(snapshot.orientation).heading;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const qy = Math.sin(turn / 2);
  const qw = Math.cos(turn / 2);
  const q = snapshot.orientation;
  snapshot.orientation = {
    x: qw * q.x + qy * q.z,
    y: qw * q.y + qy * q.w,
    z: qw * q.z - qy * q.x,
    w: qw * q.w - qy * q.y,
  };
  const v = snapshot.velocity;
  snapshot.velocity = { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
  snapshot.position = { x: at.x, y: world.seaLevel + snapshot.position.y, z: at.z };
  return { ...surfaceVisualState(snapshot, undefined), simulationTime };
}
