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
  it("bounds thin-air control rates without auto-leveling the aircraft", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 18_000, z: 0 },
        heading: Math.PI / 2,
        pitch: (-18 * Math.PI) / 180,
        bank: (32 * Math.PI) / 180,
        airspeed: 340,
      },
      environment: {
        airDensity: 0.05,
        gravity: 0,
        wind: { x: 0, y: 0, z: 0 },
      },
    });
    let maximumRollRate = 0;
    let maximumPitchRate = 0;
    let maximumYawRate = 0;
    let maximumRateChange = 0;
    let previousRate = { ...simulator.state.angularVelocity };

    advance(simulator, 8, (current) => {
      maximumRollRate = Math.max(maximumRollRate, Math.abs(current.state.angularVelocity.x));
      maximumYawRate = Math.max(maximumYawRate, Math.abs(current.state.angularVelocity.y));
      maximumPitchRate = Math.max(maximumPitchRate, Math.abs(current.state.angularVelocity.z));
      maximumRateChange = Math.max(
        maximumRateChange,
        Math.abs(current.state.angularVelocity.x - previousRate.x) / FIXED_TIME_STEP,
        Math.abs(current.state.angularVelocity.y - previousRate.y) / FIXED_TIME_STEP,
        Math.abs(current.state.angularVelocity.z - previousRate.z) / FIXED_TIME_STEP,
      );
      previousRate = { ...current.state.angularVelocity };
      const direction = Math.floor(current.state.time / 0.7) % 2 === 0 ? 1 : -1;
      return {
        ...DEFAULT_CONTROLS,
        throttle: 0,
        pitch: direction,
        roll: -direction,
        yaw: direction,
      };
    });

    expect(simulator.state.crashed).toBe(false);
    expect(maximumYawRate).toBeLessThanOrEqual(2.5);
    expect(maximumPitchRate).toBeLessThanOrEqual(3.25);
    expect(maximumRollRate).toBeLessThanOrEqual(4.5);
    expect(maximumRateChange).toBeLessThan(12);
    // Rate limiting is not an attitude controller: a pilot-selected tilted
    // pose is still free to evolve rather than being pulled back to level.
    expect(Math.abs(simulator.telemetry().bank)).toBeGreaterThan((5 * Math.PI) / 180);
  });

  it("does not level a tilted attitude when no aerodynamic moment exists", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 18_000, z: 0 },
        heading: Math.PI / 2,
        pitch: (-24 * Math.PI) / 180,
        bank: (41 * Math.PI) / 180,
        airspeed: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: {
        airDensity: 0.05,
        gravity: 0,
        wind: { x: 0, y: 0, z: 0 },
      },
    });
    const selected = simulator.telemetry();

    advance(simulator, 5, () => ({ ...DEFAULT_CONTROLS, throttle: 0 }));
    const retained = simulator.telemetry();

    expect(retained.pitch).toBeCloseTo(selected.pitch, 8);
    expect(retained.bank).toBeCloseTo(selected.bank, 8);
    expect(simulator.state.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
  });

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

  it("supports a gentle touchdown, taxi, and second takeoff without terminal damage", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 3.2, z: 0 },
        velocity: { x: 29, y: -1.8, z: 0 },
        heading: Math.PI / 2,
        pitch: (3 * Math.PI) / 180,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.08, trim: 0.04 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.08, trim: 0.04 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    let touchdownTime: number | null = null;
    let takeoffTime: number | null = null;

    for (let index = 0; index < Math.round(45 / FIXED_TIME_STEP); index += 1) {
      const timeSinceTouchdown = touchdownTime === null
        ? 0
        : simulator.state.time - touchdownTime;
      let controls: FlightControls;
      if (touchdownTime === null) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04, pitch: 0.06 };
      } else if (timeSinceTouchdown < 2) {
        controls = {
          ...DEFAULT_CONTROLS,
          throttle: 0.08,
          trim: 0.04,
          brake: 0.35,
        };
      } else if (timeSinceTouchdown < 4) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0.18, trim: 0.04, brake: 0 };
      } else {
        controls = {
          ...DEFAULT_CONTROLS,
          throttle: 1,
          trim: 0.04,
          pitch: simulator.telemetry().groundSpeed > 27 ? 0.38 : 0,
        };
      }
      simulator.step(FIXED_TIME_STEP, controls);
      if (touchdownTime === null && simulator.state.onGround) {
        touchdownTime = simulator.state.time;
      } else if (
        touchdownTime !== null &&
        timeSinceTouchdown > 4 &&
        !simulator.state.onGround
      ) {
        takeoffTime = simulator.state.time;
        break;
      }
      if (simulator.state.crashed) break;
    }

    expect(touchdownTime).not.toBeNull();
    expect(simulator.state.peakImpactSpeed).toBeGreaterThan(1);
    expect(simulator.state.peakImpactSpeed).toBeLessThan(8.5);
    expect(simulator.state.crashed).toBe(false);
    expect(takeoffTime).not.toBeNull();
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.telemetry().airspeed).toBeGreaterThan(25);
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
