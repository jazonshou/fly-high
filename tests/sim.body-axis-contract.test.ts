import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  FlightSimulator,
  getFlightTelemetry,
} from "@/src/sim";
import { rotateVectorInto } from "@/src/sim/math";
import type { Vec3 } from "@/src/sim/types";

/**
 * D-6 body-axis contract, pinned in WORLD SPACE.
 *
 * **This file reads no declaration.** Every closed loop that hid the
 * body-axis mirror was a test agreeing with a declaration (`bodyAxes`
 * metadata, the sim docblock, the old A/D "compatibility" test); a
 * world-space behavioural pin cannot close that way. The chain asserted here
 * is: pilot command -> simulator dynamics -> orientation quaternion -> the
 * world-space directions the renderer will display, using two facts measured
 * outside this file and recorded with their instruments:
 *
 *  - `FlightRenderer.updatePresentation` copies `state.orientation` onto the
 *    aircraft root verbatim, so the world image of a body vector here IS the
 *    rendered direction of that part of the mesh.
 *  - The mesh's physical starboard side is body +Z (nav lights, `7cacc44`)
 *    and a Babylon camera looking along fwd with up sees screen-right as
 *    fwd x up (`scripts/bodyaxes-probe.mts`, measured against Babylon's own
 *    camera rather than a hand convention).
 *
 * So: a positive pilot roll must DROP the world image of body +Z, and a
 * positive pilot yaw must swing the nose toward fwd x up. If either
 * assertion fails, the pilot's controls render mirrored no matter what any
 * declaration says.
 */

const BODY_FORWARD: Vec3 = { x: 1, y: 0, z: 0 };
const BODY_UP: Vec3 = { x: 0, y: 1, z: 0 };
const BODY_STARBOARD_MESH_SIDE: Vec3 = { x: 0, y: 0, z: 1 };

function worldImage(sim: FlightSimulator, body: Vec3): Vec3 {
  const out = { x: 0, y: 0, z: 0 };
  rotateVectorInto(out, sim.state.orientation, body);
  return out;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function airborneSim(): FlightSimulator {
  return new FlightSimulator({
    spawn: { position: { x: 0, y: 1200, z: 0 }, airspeed: 65, onGround: false },
    controls: { ...DEFAULT_CONTROLS, throttle: 0.7 },
  });
}

function fly(sim: FlightSimulator, seconds: number, controls: Record<string, number>): void {
  for (let t = 0; t < seconds; t += 1 / 120) sim.step(1 / 120, controls as never);
}

describe("body-axis contract (D-6, world-space)", () => {
  it("positive pilot roll drops the rendered starboard wingtip and reads as a positive bank", () => {
    const sim = airborneSim();
    fly(sim, 0.5, {});
    fly(sim, 1.2, { roll: 1, throttle: 0.7 });

    const starboardTip = worldImage(sim, BODY_STARBOARD_MESH_SIDE);
    const telemetry = getFlightTelemetry(sim.state, sim.environment, sim.aircraft);

    // The mesh side that physically carries the green lamp goes DOWN...
    expect(starboardTip.y).toBeLessThan(-0.2);
    // ...and the instruments agree it is a right bank.
    expect(telemetry.bank).toBeGreaterThan(0.1);
  });

  it("positive pilot yaw swings the nose toward screen-right", () => {
    const sim = airborneSim();
    fly(sim, 0.5, {});
    const forwardBefore = worldImage(sim, BODY_FORWARD);
    const upBefore = worldImage(sim, BODY_UP);
    const screenRight = cross(forwardBefore, upBefore);

    fly(sim, 1.5, { yaw: 1, throttle: 0.7 });
    const forwardAfter = worldImage(sim, BODY_FORWARD);
    const swing = {
      x: forwardAfter.x - forwardBefore.x,
      y: forwardAfter.y - forwardBefore.y,
      z: forwardAfter.z - forwardBefore.z,
    };

    expect(dot(swing, screenRight)).toBeGreaterThan(0.05);
  });

  it("positive pilot pitch raises the nose in both frames (chirality-invariant null)", () => {
    // The control for the instrument itself: pitch is about the wing axis, so
    // it must agree between telemetry and world space under EITHER wing
    // labelling. If this fails, the harness -- not the contract -- is broken.
    const sim = airborneSim();
    fly(sim, 0.5, {});
    fly(sim, 0.7, { pitch: 0.6, throttle: 0.7 });

    const telemetry = getFlightTelemetry(sim.state, sim.environment, sim.aircraft);
    expect(telemetry.pitch).toBeGreaterThan(0.05);
    expect(worldImage(sim, BODY_FORWARD).y).toBeGreaterThan(0.05);
  });

  it("positive sideslip means relative wind from starboard, and the vane agrees with the wind", () => {
    // Blow a crosswind from the flight's starboard side and let the physics
    // (not a formula transplant) produce the sideslip reading: spawn facing
    // north (+Z fwd is heading 0 in the current compass), wind from the
    // starboard side of that pose, expect a positive vane before the
    // weathervane tendency swings the nose.
    const sim = airborneSim();
    fly(sim, 0.3, {});
    const starboardWorld = worldImage(sim, BODY_STARBOARD_MESH_SIDE);
    sim.setEnvironment({
      wind: { x: -starboardWorld.x * 12, y: 0, z: -starboardWorld.z * 12 },
    });
    fly(sim, 0.2, {});

    const telemetry = getFlightTelemetry(sim.state, sim.environment, sim.aircraft);
    expect(telemetry.sideslip).toBeGreaterThan(0.02);
  });
});
