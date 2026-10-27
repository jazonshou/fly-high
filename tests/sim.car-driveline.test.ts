import { describe, expect, it } from "vitest";
import type { GroundVehicleSimulator } from "../src/sim/ground";
import { ENGINE } from "../src/sim/ground/drivelineSolver";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { car, drive, headingOf, slopeAhead, speedOf, STEP } from "./support/carRig";

/**
 * The LandCruiser 76's driveline against its published numbers (land plan,
 * "Physics tests"): the crawl ratios, holding on a 20 degree slope, the
 * manual's launches and stall, braking from 100 km/h, and windup in 4H.
 */

const CAR = LANDCRUISER_76;
const KMH = 1 / 3.6;

/** How far the car has moved along its forward axis since `from`, metres. */
function along(sim: GroundVehicleSimulator, from: { x: number; y: number; z: number }): number {
  const q = sim.state.orientation;
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fy = 2 * (q.x * q.y + q.w * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const p = sim.state.position;
  return (p.x - from.x) * fx + (p.y - from.y) * fy + (p.z - from.z) * fz;
}

function meanWheelOmega(sim: GroundVehicleSimulator, wheels: readonly number[]): number {
  return wheels.reduce((sum, w) => sum + sim.driveline.omega[w + 1]!, 0) / wheels.length;
}

describe("LandCruiser driveline", () => {
  it("has the published 38.51 and 48.69 crawl ratios in first, 4L", () => {
    // Press counts start from the first one the car sees.
    const automatic = car();
    drive(automatic, 0.1, { handbrake: 1 });
    drive(automatic, 0.5, { handbrake: 1, rangePresses: 2 });
    expect(automatic.transmission.range).toBe("4L");
    drive(automatic, 0.1, { accelerator: 0.2, rangePresses: 2 });
    drive(automatic, 4, { rangePresses: 2 });
    expect(automatic.transmission.gear).toBe(1);
    const atRatio = automatic.transmission.inputOmega / meanWheelOmega(automatic, [2, 3]);
    expect(atRatio).toBeCloseTo(38.51, 1);

    const manual = car({ gearbox: "manual" });
    drive(manual, 0.1, { handbrake: 1 });
    drive(manual, 0.5, { handbrake: 1, rangePresses: 2 });
    drive(manual, 6, { accelerator: 0.2, rangePresses: 2 });
    expect(manual.transmission.gear).toBe(1);
    expect(manual.transmission.clutch).toBe(1);
    const mtRatio = manual.driveline.omega[ENGINE]! / meanWheelOmega(manual, [0, 1, 2, 3]);
    expect(Math.abs(mtRatio / 48.69 - 1)).toBeLessThan(0.005);
  });

  it("holds on a 20 degree slope with the brake held through the stop, and on the handbrake alone in 4H", () => {
    // Up the slope in D, then the brake held through the stop and on for a minute.
    const braked = car({}, slopeAhead(20));
    drive(braked, 1, { handbrake: 1 });
    drive(braked, 3, { accelerator: 0.6 });
    expect(speedOf(braked)).toBeGreaterThan(1);
    drive(braked, 3, { brake: 1 });
    expect(braked.transmission.gear).toBe(1);
    const stopped = { ...braked.state.position };
    drive(braked, 60, { brake: 1 });
    const brakedCreep = Math.hypot(
      braked.state.position.x - stopped.x,
      braked.state.position.y - stopped.y,
      braked.state.position.z - stopped.z,
    );
    expect(braked.transmission.gear).toBe(1);

    // The manual in neutral (the player's clutch), 4H, held by the transmission drum alone.
    const parked = car({ gearbox: "manual", manualClutch: true }, slopeAhead(20));
    drive(parked, 0.1, { handbrake: 1 });
    drive(parked, 3, { handbrake: 1, rangePresses: 1 });
    expect(parked.transmission.range).toBe("4H");
    expect(parked.transmission.gear).toBe(0);
    const start = { ...parked.state.position };
    drive(parked, 60, { handbrake: 1, rangePresses: 1 });
    const parkedCreep = Math.hypot(
      parked.state.position.x - start.x,
      parked.state.position.y - start.y,
      parked.state.position.z - start.z,
    );
    expect(brakedCreep).toBeLessThan(0.01);
    expect(parkedCreep).toBeLessThan(0.01);
  });

  it("launches up a 20 degree slope on the auto-clutch without stalling or rolling back", () => {
    const sim = car({ gearbox: "manual" }, slopeAhead(20));
    drive(sim, 2, { handbrake: 1 });
    const start = { ...sim.state.position };
    let rollback = 0;
    let stalled = false;
    drive(sim, 6, { accelerator: 0.7 }, (s) => {
      rollback = Math.min(rollback, along(s, start));
      stalled ||= !s.engine.running;
    });
    expect(stalled).toBe(false);
    expect(rollback).toBeGreaterThan(-0.02);
    expect(along(sim, start)).toBeGreaterThan(5);
  });

  it("stalls when the player's clutch is let out in gear at idle, and restarts with the pedal down", () => {
    const sim = car({ gearbox: "manual", manualClutch: true });
    drive(sim, 1, { handbrake: 1, clutch: 1 });
    drive(sim, 0.2, { handbrake: 1, clutch: 1, shiftUpPresses: 1 });
    expect(sim.transmission.gear).toBe(1);
    drive(sim, 2, { handbrake: 1, clutch: 0, shiftUpPresses: 1 });
    expect(sim.engine.running).toBe(false);
    expect(sim.visualState().stalled).toBe(true);
    drive(sim, 2.5, { handbrake: 1, clutch: 1, shiftUpPresses: 1 });
    expect(sim.engine.running).toBe(true);
    expect(sim.engineRpm).toBeGreaterThan(CAR.engine.idleRpm * 0.9);
  });

  it("stops from 100 km/h on dry asphalt in a published-like distance, and steers under ABS", () => {
    const stop = (steer: number) => {
      const sim = car();
      drive(sim, 0.5, { handbrake: 1 });
      controlsUntil(sim, { accelerator: 1 }, (s) => speedOf(s) >= 100 * KMH, 30);
      const start = { ...sim.state.position };
      const heading = headingOf(sim);
      let abs = false;
      drive(sim, 1.5, { brake: 1, steer }, (s) => {
        abs ||= s.absActive;
      });
      const turned = Math.abs(((headingOf(sim) - heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      controlsUntil(sim, { brake: 1, steer }, (s) => speedOf(s) < 0.1, 10);
      const distance = Math.hypot(sim.state.position.x - start.x, sim.state.position.z - start.z);
      return { distance, abs, turned };
    };
    const straight = stop(0);
    const steering = stop(0.5);
    expect(straight.abs).toBe(true);
    expect(straight.distance).toBeGreaterThan(38);
    expect(straight.distance).toBeLessThan(50);
    expect(straight.turned).toBeLessThan(0.02);
    // Under ABS the front tyres keep rolling, so the car turns while it stops.
    expect(steering.abs).toBe(true);
    expect(steering.turned).toBeGreaterThan(0.05);
  });

  it("winds up the driveline and scrubs its tyres in a tight 4H turn on asphalt; 2H does not", () => {
    const turn = (presses: number) => {
      const sim = car();
      drive(sim, 0.1, { handbrake: 1 });
      drive(sim, 0.5, { handbrake: 1, rangePresses: presses });
      drive(sim, 0.1, { accelerator: 0.2, rangePresses: presses });
      let windup = 0;
      let scrub = 0;
      drive(sim, 6, { steer: 1, rangePresses: presses }, (s) => {
        windup = Math.max(windup, Math.abs(s.windup));
        scrub += (Math.abs(s.wheelForceX[0]!) + Math.abs(s.wheelForceX[1]!)) * STEP;
      });
      return { windup, scrub, range: sim.transmission.range };
    };
    const twoHigh = turn(0);
    const fourHigh = turn(1);
    expect(twoHigh.range).toBe("2H");
    expect(fourHigh.range).toBe("4H");
    expect(twoHigh.windup).toBe(0);
    expect(fourHigh.windup).toBeGreaterThan(0.03);
    expect(fourHigh.scrub).toBeGreaterThan(3 * twoHigh.scrub);
  });
});

function controlsUntil(
  sim: GroundVehicleSimulator,
  input: Parameters<typeof drive>[2],
  done: (sim: GroundVehicleSimulator) => boolean,
  limit: number,
): void {
  let time = 0;
  while (!done(sim) && time < limit) {
    drive(sim, STEP, input);
    time += STEP;
  }
  if (!done(sim)) throw new Error(`not reached in ${limit} s`);
}
