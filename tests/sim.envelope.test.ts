import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  type FlightControls,
} from "../src/sim";

const FLAT_RUNWAY = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  friction: 1.15,
} as const;

function advance(
  simulator: FlightSimulator,
  seconds: number,
  controls: (simulator: FlightSimulator) => FlightControls,
): void {
  const steps = Math.round(seconds / FIXED_TIME_STEP);
  for (let index = 0; index < steps; index += 1) {
    simulator.step(FIXED_TIME_STEP, controls(simulator));
  }
}

describe("light trainer envelope", () => {
  it("accelerates, rotates, and lifts off from a level runway", () => {
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04, flaps: 0.5 },
      },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    advance(simulator, 22, (current) => ({
      ...DEFAULT_CONTROLS,
      throttle: 1,
      trim: 0.04,
      flaps: 0.5,
      pitch: current.telemetry().groundSpeed > 27 ? 0.36 : 0,
    }));

    const telemetry = simulator.telemetry();
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(telemetry.altitudeAgl).toBeGreaterThan(8);
    expect(telemetry.airspeed).toBeGreaterThan(24);
    expect(telemetry.airspeed).toBeLessThan(45);
  });

  it("brakes to taxi speed without losing directional stability", () => {
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 0,
        airspeed: 24,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    advance(simulator, 8, () => ({ ...DEFAULT_CONTROLS, throttle: 0, brake: 1 }));

    const telemetry = simulator.telemetry();
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(true);
    expect(telemetry.groundSpeed).toBeLessThan(2);
    expect(Math.abs(telemetry.bank)).toBeLessThan((4 * Math.PI) / 180);
  });

  it("produces a controllable power-off glide", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 1_200, z: 0 },
        airspeed: 50,
        pitch: (2 * Math.PI) / 180,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.08 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.08 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    const startAltitude = simulator.state.position.y;

    advance(simulator, 20, () => ({ ...DEFAULT_CONTROLS, throttle: 0, trim: 0.08 }));

    const telemetry = simulator.telemetry();
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.position.y).toBeLessThan(startAltitude);
    expect(simulator.state.position.y).toBeGreaterThan(startAltitude - 650);
    expect(telemetry.airspeed).toBeGreaterThan(28);
    expect(telemetry.airspeed).toBeLessThan(75);
  });
});
