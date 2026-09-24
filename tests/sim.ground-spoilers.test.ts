import { describe, expect, it } from "vitest";
import {
  aircraftDefinition,
  DEFAULT_CONTROLS,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  GROUND_SPOILER_ARMED_SPEED,
  GROUND_SPOILER_RATE,
  LIGHT_TRAINER,
  speedBrakeLiftDump,
  type AircraftDefinition,
  type FlightControls,
} from "../src/sim";

/**
 * GROUND SPOILERS, decided by the sim and flown by it (Jason, 2026-09-23: "the
 * spoilers don't activate when the brake is applied for the 747").
 *
 * The type's rule with the speedbrake always armed: on the ground the panels
 * deploy fully once the throttle is back at idle above 15 m/s -- a touchdown,
 * or a rejected take-off -- and with the wheel brake held at any speed; in the
 * air they stow and the brake is the flight speed brake only. The sim owns the
 * deployment (`actuators.groundSpoilers`) and the lift dump reads it, so the
 * aeroplane dumps lift exactly when the drawn panels stand up.
 *
 * What this pins, beyond "the number goes to 1":
 *  - a real TOUCHDOWN at idle deploys them with no brake at all, and not
 *    before the wheels are down;
 *  - the three things that must NOT deploy them: an idle taxi below the armed
 *    speed, a take-off roll under power, and the brake in the air;
 *  - the LIFT the sim flies by follows the panels (the lift coefficient falls
 *    by the dump), against a roll at the same speed with the lever a hair
 *    above idle as the control;
 *  - the jet and the trainer, which have no ground spoilers, keep the
 *    brake-driven lift dump they always had.
 */

const FLAT_RUNWAY = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  friction: 1.15,
} as const;
const STILL = { x: 0, y: 0, z: 0 } as const;

const controls = (overrides: Partial<FlightControls>): FlightControls => ({
  ...DEFAULT_CONTROLS, flaps: 1, gear: 1, ...overrides,
});

function rolling(aircraft: AircraftDefinition, speed: number, overrides: Partial<FlightControls>) {
  return new FlightSimulator({
    aircraft,
    spawn: { onGround: true, terrainHeight: 0, velocity: { x: 0, y: 0, z: speed }, controls: controls(overrides) },
    controls: controls(overrides),
    environment: { terrain: FLAT_RUNWAY, wind: STILL },
  });
}

function advance(simulator: FlightSimulator, seconds: number, overrides: Partial<FlightControls>): void {
  for (let step = 0; step < Math.round(seconds / FIXED_TIME_STEP); step += 1) {
    simulator.step(FIXED_TIME_STEP, controls(overrides));
  }
}

/** The time for the panels to travel all the way, plus a step of slack. */
const FULL_TRAVEL_SECONDS = 1 / GROUND_SPOILER_RATE + 2 * FIXED_TIME_STEP;

describe.each([
  ["the 747", aircraftDefinition("airliner")],
  ["the Global", aircraftDefinition("bizjet")],
])("%s's ground spoilers", (_, aircraft) => {
  it("are the airframe's", () => {
    expect(aircraft.groundSpoilers).toBe(true);
  });

  it("deploy at a TOUCHDOWN with the throttle at idle, no brake, and not before the wheels are down", () => {
    // The on-gear CG height, read from the sim's own ground spawn, so the arrival is a metre above it.
    const gearHeight = rolling(aircraft, 0, {}).state.position.y;
    const simulator = new FlightSimulator({
      aircraft,
      spawn: {
        position: { x: 0, y: gearHeight + 1, z: 0 },
        velocity: { x: 0, y: -1.2, z: 70 },
        pitch: (3 * Math.PI) / 180,
        controls: controls({ throttle: 0 }),
      },
      controls: controls({ throttle: 0 }),
      environment: { terrain: FLAT_RUNWAY, wind: STILL },
    });
    let touchdown: number | null = null;
    let deployedAt: number | null = null;
    for (let step = 0; step < Math.round(6 / FIXED_TIME_STEP); step += 1) {
      simulator.step(FIXED_TIME_STEP, controls({ throttle: 0 }));
      const { onGround, actuators, time } = simulator.state;
      if (touchdown === null) {
        if (onGround) touchdown = time;
        // Airborne on approach at idle: stowed, however idle the lever.
        else expect(actuators.groundSpoilers).toBe(0);
      }
      if (deployedAt === null && actuators.groundSpoilers >= 1) deployedAt = time;
    }
    expect(simulator.state.crashed).toBe(false);
    expect(touchdown, "the arrival never touched down").not.toBeNull();
    expect(deployedAt, "the panels never reached full").not.toBeNull();
    expect(deployedAt! - touchdown!).toBeLessThanOrEqual(FULL_TRAVEL_SECONDS);
    expect(simulator.state.actuators.brake).toBe(0);
  });

  it("deploy with the brake on the ground at taxi speed, which idle alone does not", () => {
    const taxi = GROUND_SPOILER_ARMED_SPEED * 0.5;
    const simulator = rolling(aircraft, taxi, { throttle: 0 });
    advance(simulator, 2, { throttle: 0 });
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.state.actuators.groundSpoilers, "idle below the armed speed").toBe(0);
    advance(simulator, FULL_TRAVEL_SECONDS + 0.2, { throttle: 0, brake: 1 });
    expect(simulator.state.actuators.groundSpoilers, "the brake on the wheels").toBe(1);
  });

  it("stay stowed on a take-off roll under power", () => {
    const simulator = rolling(aircraft, 30, { throttle: 1, flaps: 0.3 });
    for (let step = 0; step < Math.round(3 / FIXED_TIME_STEP); step += 1) {
      simulator.step(FIXED_TIME_STEP, controls({ throttle: 1, flaps: 0.3 }));
      expect(simulator.state.actuators.groundSpoilers).toBe(0);
    }
    expect(simulator.state.onGround).toBe(true);
  });

  it("stow in the air, where the brake is the flight speed brake only", () => {
    const simulator = new FlightSimulator({
      aircraft,
      spawn: { position: { x: 0, y: 1_200, z: 0 }, airspeed: 120, controls: controls({ throttle: 0.6, flaps: 0, gear: 0 }) },
      controls: controls({ throttle: 0.6, flaps: 0, gear: 0 }),
      environment: { terrain: FLAT_RUNWAY, wind: STILL },
    });
    for (let step = 0; step < Math.round(2 / FIXED_TIME_STEP); step += 1) {
      simulator.step(FIXED_TIME_STEP, controls({ throttle: 0.6, flaps: 0, gear: 0, brake: 1 }));
      expect(simulator.state.actuators.groundSpoilers).toBe(0);
    }
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.state.actuators.brake).toBe(1);
    expect(speedBrakeLiftDump(aircraft, simulator.state.actuators, false)).toBeCloseTo(0.12, 12);
  });

  it("dump the LIFT the sim flies by, not just a number: the lift coefficient falls by the dump", () => {
    // Same speed, same runway attitude; the control's lever is a hair above idle, so nothing deploys.
    const idle = rolling(aircraft, 60, { throttle: 0 });
    const control = rolling(aircraft, 60, { throttle: 0.06 });
    advance(idle, FULL_TRAVEL_SECONDS + 0.2, { throttle: 0 });
    advance(control, FULL_TRAVEL_SECONDS + 0.2, { throttle: 0.06 });
    expect(idle.state.actuators.groundSpoilers).toBe(1);
    expect(control.state.actuators.groundSpoilers).toBe(0);
    expect(speedBrakeLiftDump(aircraft, idle.state.actuators, true)).toBeCloseTo(0.62, 12);
    expect(speedBrakeLiftDump(aircraft, control.state.actuators, true)).toBe(0);
    const ratio = idle.state.dynamics.liftCoefficient / control.state.dynamics.liftCoefficient;
    expect(Math.abs(ratio - (1 - 0.62))).toBeLessThan(0.02);
  });
});

describe("airframes without ground spoilers", () => {
  it.each([
    ["the F-16", FAST_JET],
    ["the trainer", LIGHT_TRAINER],
  ])("%s never deploys any, and keeps its brake-driven lift dump", (_, aircraft) => {
    expect(aircraft.groundSpoilers).toBe(false);
    const simulator = rolling(aircraft, 40, { throttle: 0 });
    for (let step = 0; step < Math.round(2 / FIXED_TIME_STEP); step += 1) {
      simulator.step(FIXED_TIME_STEP, controls({ throttle: 0, brake: 1 }));
      expect(simulator.state.actuators.groundSpoilers).toBe(0);
    }
    const braked = { ...simulator.state.actuators, brake: 1 };
    const expected = aircraft.speedBrakeDrag > 0 ? [0.62, 0.12] : [0, 0];
    expect(speedBrakeLiftDump(aircraft, braked, true)).toBeCloseTo(expected[0]!, 12);
    expect(speedBrakeLiftDump(aircraft, braked, false)).toBeCloseTo(expected[1]!, 12);
  });
});
