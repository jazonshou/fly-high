import { describe, expect, it } from "vitest";
import {
  calculateLiftCoefficient,
  createFlightState,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  getFlightTelemetry,
  LIGHT_TRAINER,
  stepFlight,
  type FlightState,
} from "../src/sim";
import { createWorld, runwayToWorld, sampleTerrain, sampleWind } from "../src/world";
import { keyboardRollDirection } from "../src/input";

const SAFE_RUNWAY_FIXTURE_SEED = "airport-safety-1-535203442";
const SAFE_RUNWAY_FIXTURE = Object.freeze({
  centerX: -3_109.8434911464765,
  centerZ: -7_702.165069913508,
  elevation: 35.25,
  headingRadians: 0.6698306877107214,
});

function flyFor(simulator: FlightSimulator, seconds: number): void {
  const count = Math.round(seconds / FIXED_TIME_STEP);
  for (let index = 0; index < count; index += 1) simulator.step();
}

function expectFiniteState(state: FlightState): void {
  const values = [
    state.time,
    state.position.x,
    state.position.y,
    state.position.z,
    state.velocity.x,
    state.velocity.y,
    state.velocity.z,
    state.orientation.x,
    state.orientation.y,
    state.orientation.z,
    state.orientation.w,
    state.angularVelocity.x,
    state.angularVelocity.y,
    state.angularVelocity.z,
    state.engineRpm,
    state.dynamics.airspeed,
    state.dynamics.liftCoefficient,
    state.dynamics.dragCoefficient,
  ];
  expect(values.every(Number.isFinite)).toBe(true);
}

describe("flight simulation", () => {
  it("maps north/east headings into the renderer-aligned body frame", () => {
    const eastbound = createFlightState({ heading: Math.PI / 2, pitch: 0, airspeed: 50 });
    const telemetry = getFlightTelemetry(eastbound);

    expect(eastbound.orientation.x).toBeCloseTo(0, 10);
    expect(eastbound.orientation.y).toBeCloseTo(0, 10);
    expect(eastbound.orientation.z).toBeCloseTo(0, 10);
    expect(eastbound.orientation.w).toBeCloseTo(1, 10);
    // A trimmed spawn carries a small positive angle of attack, so its flight
    // path is just below the nose while total speed remains exactly requested.
    expect(Math.hypot(
      eastbound.velocity.x,
      eastbound.velocity.y,
      eastbound.velocity.z,
    )).toBeCloseTo(50, 10);
    expect(eastbound.velocity.x).toBeGreaterThan(49.9);
    expect(eastbound.velocity.z).toBeCloseTo(0, 10);
    expect(telemetry.heading).toBeCloseTo(Math.PI / 2, 10);
  });

  it("uses pilot-friendly positive pitch and roll control signs", () => {
    const pitchSimulator = new FlightSimulator({
      spawn: { heading: Math.PI / 2, pitch: 0, airspeed: 52 },
      controls: { ...DEFAULT_CONTROLS, pitch: 0.35 },
    });
    const rollSimulator = new FlightSimulator({
      spawn: { heading: Math.PI / 2, pitch: 0, airspeed: 52 },
      controls: { ...DEFAULT_CONTROLS, roll: 0.35 },
    });
    flyFor(pitchSimulator, 0.75);
    flyFor(rollSimulator, 0.75);

    expect(pitchSimulator.telemetry().pitch).toBeGreaterThan(0.02);
    expect(rollSimulator.telemetry().bank).toBeGreaterThan(0.02);
  });

  it("carries the rendered A/D compatibility signs through the simulator", () => {
    const left = new FlightSimulator({
      spawn: { heading: Math.PI / 2, pitch: 0, airspeed: 52 },
      controls: { ...DEFAULT_CONTROLS, roll: keyboardRollDirection("KeyA") },
    });
    const right = new FlightSimulator({
      spawn: { heading: Math.PI / 2, pitch: 0, airspeed: 52 },
      controls: { ...DEFAULT_CONTROLS, roll: keyboardRollDirection("KeyD") },
    });
    flyFor(left, 0.75);
    flyFor(right, 0.75);

    // Telemetry follows the simulator's documented sign; the renderer's
    // current lateral basis displays these as left for A and right for D.
    expect(left.telemetry().bank).toBeGreaterThan(0.02);
    expect(right.telemetry().bank).toBeLessThan(-0.02);
  });

  it("holds a bounded, trim-like cruise without divergent rotation", () => {
    const simulator = new FlightSimulator({
      spawn: { airspeed: 49, pitch: (2 * Math.PI) / 180, controls: DEFAULT_CONTROLS },
      controls: DEFAULT_CONTROLS,
    });
    const startAltitude = simulator.state.position.y;

    flyFor(simulator, 25);
    const telemetry = simulator.telemetry();

    expectFiniteState(simulator.state);
    expect(telemetry.airspeed).toBeGreaterThan(32);
    expect(telemetry.airspeed).toBeLessThan(75);
    expect(Math.abs(simulator.state.position.y - startAltitude)).toBeLessThan(400);
    expect(Math.abs(telemetry.bank)).toBeLessThan(0.08);
    expect(Math.hypot(
      simulator.state.angularVelocity.x,
      simulator.state.angularVelocity.y,
      simulator.state.angularVelocity.z,
    )).toBeLessThan(0.4);
  });

  it("is consistent across 60 Hz and 120 Hz caller frame steps", () => {
    const sixty = createFlightState({ airspeed: 52 });
    const oneTwenty = createFlightState({ airspeed: 52 });
    const controls = { ...DEFAULT_CONTROLS, roll: 0.12, pitch: 0.04 };

    for (let frame = 0; frame < 300; frame += 1) {
      stepFlight(sixty, 1 / 60, controls);
    }
    for (let frame = 0; frame < 600; frame += 1) {
      stepFlight(oneTwenty, 1 / 120, controls);
    }

    expect(sixty.position.x).toBeCloseTo(oneTwenty.position.x, 7);
    expect(sixty.position.y).toBeCloseTo(oneTwenty.position.y, 7);
    expect(sixty.position.z).toBeCloseTo(oneTwenty.position.z, 7);
    expect(sixty.velocity.x).toBeCloseTo(oneTwenty.velocity.x, 7);
    expect(sixty.orientation.w).toBeCloseTo(oneTwenty.orientation.w, 7);
  });

  it("replays a recorded control stream deterministically", () => {
    const first = new FlightSimulator({ spawn: { airspeed: 52, pitch: 0.03 } });
    const second = new FlightSimulator({ spawn: { airspeed: 52, pitch: 0.03 } });

    for (let index = 0; index < 3_600; index += 1) {
      const controls = {
        ...DEFAULT_CONTROLS,
        throttle: 0.58 + Math.sin(index * 0.002) * 0.12,
        pitch: Math.sin(index * 0.011) * 0.09,
        roll: Math.sin(index * 0.007) * 0.14,
        yaw: Math.sin(index * 0.005) * 0.04,
      };
      first.step(FIXED_TIME_STEP, controls);
      second.step(FIXED_TIME_STEP, controls);
    }

    expect(first.state.position.x).toBeCloseTo(second.state.position.x, 12);
    expect(first.state.position.y).toBeCloseTo(second.state.position.y, 12);
    expect(first.state.position.z).toBeCloseTo(second.state.position.z, 12);
    expect(first.state.orientation.x).toBeCloseTo(second.state.orientation.x, 12);
    expect(first.state.orientation.w).toBeCloseTo(second.state.orientation.w, 12);
  });

  it("derives aerodynamic speed from velocity relative to the wind", () => {
    const state = createFlightState({
      pitch: 0,
      airspeed: 50,
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
    });

    const expectedRelativeSpeed = Math.hypot(
      state.velocity.x,
      state.velocity.y,
      state.velocity.z - 20,
    );
    stepFlight(
      state,
      FIXED_TIME_STEP,
      { ...DEFAULT_CONTROLS, throttle: 0 },
      { wind: { x: 0, y: 0, z: 20 } },
    );

    expect(state.dynamics.airspeed).toBeCloseTo(expectedRelativeSpeed, 6);
    expect(state.dynamics.liftForce).toBeGreaterThan(0);
  });

  it("uses mean-sea-level altitude for atmospheric density", () => {
    const overOcean = createFlightState({ position: { x: 0, y: 3_000, z: 0 }, airspeed: 50 });
    const overMountain = createFlightState({ position: { x: 0, y: 3_000, z: 0 }, airspeed: 50 });

    stepFlight(overOcean, FIXED_TIME_STEP, DEFAULT_CONTROLS, { terrain: { height: 0 } });
    stepFlight(overMountain, FIXED_TIME_STEP, DEFAULT_CONTROLS, { terrain: { height: 2_500 } });

    expect(overOcean.dynamics.airDensity).toBeCloseTo(overMountain.dynamics.airDensity, 10);
    expect(overOcean.dynamics.liftForce).toBeCloseTo(overMountain.dynamics.liftForce, 7);
  });

  it("uses height-only terrain rejection while safely airborne", () => {
    let collisionSamples = 0;
    let heightSamples = 0;
    const simulator = new FlightSimulator({
      spawn: { position: { x: 0, y: 1_000, z: 0 }, airspeed: 50 },
      environment: {
        terrain: () => {
          collisionSamples += 1;
          return { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1 };
        },
        terrainHeight: () => {
          heightSamples += 1;
          return 0;
        },
      },
    });

    simulator.step();
    expect(collisionSamples).toBe(0);
    expect(heightSamples).toBe(1);

    const telemetry = simulator.telemetry();
    expect(telemetry.altitudeAgl).toBeGreaterThan(990);
    expect(collisionSamples).toBe(0);
    // Far-from-ground AGL reuses the centre height for all three wheels.
    expect(heightSamples).toBe(2);
  });

  it("loses lift and gains drag beyond the positive stall", () => {
    const beforeStall = calculateLiftCoefficient((14 * Math.PI) / 180);
    const deepStall = calculateLiftCoefficient((40 * Math.PI) / 180);
    expect(beforeStall).toBeGreaterThan(deepStall);

    const simulator = new FlightSimulator({
      spawn: { airspeed: 34, pitch: (20 * Math.PI) / 180 },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.15, pitch: 1 },
    });
    flyFor(simulator, 2.5);
    expectFiniteState(simulator.state);
    expect(
      simulator.telemetry().isStalled ||
        simulator.state.dynamics.dragCoefficient > LIGHT_TRAINER.cdZero * 2,
    ).toBe(true);
  });

  it("supports stable landing-gear contact against supplied terrain", () => {
    const simulator = new FlightSimulator({
      spawn: { onGround: true, terrainHeight: 12 },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
      environment: {
        wind: { x: 0, y: 0, z: 0 },
        terrain: { height: 12, normal: { x: 0, y: 1, z: 0 } },
      },
    });

    flyFor(simulator, 4);
    expectFiniteState(simulator.state);
    expect(simulator.state.position.y).toBeGreaterThan(13.15);
    expect(simulator.state.position.y).toBeLessThan(13.65);
    expect(Math.abs(simulator.state.velocity.y)).toBeLessThan(1);
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.state.crashed).toBe(false);
    expect(getFlightTelemetry(simulator.state, simulator.environment).altitudeAgl).toBe(0);
  });

  it("turns a high-energy ground strike into a terminal terrain-resting wreck", () => {
    const flatTerrain = {
      height: 0,
      normal: { x: 0, y: 1, z: 0 },
      friction: 1.15,
    } as const;
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 48, z: 0 },
        pitch: (-49 * Math.PI) / 180,
        airspeed: 70,
        controls: { ...DEFAULT_CONTROLS, throttle: 1, pitch: -0.8 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 1, pitch: -0.8 },
      environment: { terrain: flatTerrain, wind: { x: 0, y: 0, z: 0 } },
    });

    for (let index = 0; index < Math.round(3 / FIXED_TIME_STEP); index += 1) {
      simulator.step(FIXED_TIME_STEP);
      if (simulator.state.crashed) break;
    }
    expect(simulator.state.crashed).toBe(true);
    expect(simulator.state.peakImpactSpeed).toBeGreaterThan(8.5);
    const restPosition = { ...simulator.state.position };
    const restOrientation = { ...simulator.state.orientation };

    // Full controls after impact must not re-launch or rotate the wreck.
    for (let index = 0; index < Math.round(5 / FIXED_TIME_STEP); index += 1) {
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        pitch: 1,
        roll: 1,
        yaw: 1,
      });
    }
    const telemetry = simulator.telemetry();
    expectFiniteState(simulator.state);
    expect(simulator.state.onGround).toBe(true);
    expect(telemetry.crashed).toBe(true);
    expect(telemetry.altitudeAgl).toBe(0);
    expect(telemetry.airspeed).toBe(0);
    expect(telemetry.groundSpeed).toBe(0);
    expect(telemetry.verticalSpeed).toBe(0);
    expect(telemetry.isStalled).toBe(false);
    expect(simulator.state.position).toEqual(restPosition);
    expect(simulator.state.orientation).toEqual(restOrientation);
    expect(simulator.state.position.y).toBeGreaterThan(0);
    expect(simulator.state.position.y).toBeLessThan(10);
    expect(simulator.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(simulator.state.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(simulator.state.actuators.throttle).toBe(0);
    expect(simulator.state.engineRpm).toBe(0);

    simulator.reset({
      position: { x: 0, y: 900, z: 0 },
      pitch: 0,
      airspeed: 50,
      controls: { ...DEFAULT_CONTROLS, throttle: 0.5 },
    });
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.telemetry().airspeed).toBeGreaterThan(40);
  });

  it("keeps a gentle touchdown on the ordinary suspension path", () => {
    const simulator = new FlightSimulator({
      spawn: {
        position: { x: 0, y: 1.55, z: 0 },
        velocity: { x: 0, y: -0.8, z: 4 },
        heading: 0,
        pitch: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, brake: 1 },
      environment: {
        terrain: { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1.15 },
        wind: { x: 0, y: 0, z: 0 },
      },
    });

    flyFor(simulator, 5);
    const telemetry = simulator.telemetry();
    expectFiniteState(simulator.state);
    expect(simulator.state.peakImpactSpeed).toBeGreaterThan(0.5);
    expect(simulator.state.peakImpactSpeed).toBeLessThanOrEqual(8.5);
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(true);
    expect(telemetry.altitudeAgl).toBe(0);
    expect(Math.abs(telemetry.verticalSpeed)).toBeLessThan(1);
  });

  it("keeps a parked aircraft directionally stable in a crosswind", () => {
    const initialHeading = Math.PI * 0.14;
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: 24,
        heading: initialHeading,
        controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: {
        wind: { x: 10, y: 0, z: -3 },
        terrain: { height: 24, normal: { x: 0, y: 1, z: 0 }, friction: 1.18 },
      },
    });

    flyFor(simulator, 8);
    const telemetry = simulator.telemetry();

    expectFiniteState(simulator.state);
    expect(Math.abs(telemetry.heading - initialHeading)).toBeLessThan((2 * Math.PI) / 180);
    expect(telemetry.groundSpeed).toBeLessThan(0.5);
    expect(simulator.state.onGround).toBe(true);
  });

  it("suppresses undefined airflow angles at taxi speed", () => {
    const simulator = new FlightSimulator({
      spawn: { onGround: true, terrainHeight: 0 },
      environment: {
        wind: { x: 0, y: 3.5, z: 0 },
        terrain: { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1.18 },
      },
    });
    simulator.step(FIXED_TIME_STEP);
    const telemetry = simulator.telemetry();
    expect(telemetry.airspeed).toBeLessThan(8);
    expect(telemetry.angleOfAttack).toBe(0);
    expect(telemetry.sideslip).toBe(0);
    expect(telemetry.isStalled).toBe(false);
  });

  it("stays parked with the procedural runway and gust field", () => {
    const world = createWorld(SAFE_RUNWAY_FIXTURE_SEED, {
      airport: SAFE_RUNWAY_FIXTURE,
    });
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;
    const point = runwayToWorld(airport, -airport.runwayLength * 0.36, 0);
    const controls = { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.04 };
    const simulator = new FlightSimulator({
      spawn: {
        onGround: true,
        terrainHeight: airport.elevation,
        position: { x: point.x, y: airport.elevation + 0.94, z: point.z },
        heading: airport.headingRadians,
        controls,
      },
      controls,
      environment: {
        terrain: (x, z) => {
          const terrain = sampleTerrain(world, x, z);
          return { height: terrain.height, normal: terrain.normal, friction: 1.18 };
        },
      },
    });
    const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };

    for (let index = 0; index < 1_200; index += 1) {
      sampleWind(
        world,
        simulator.state.position.x,
        simulator.state.position.y,
        simulator.state.position.z,
        simulator.state.time,
        wind,
      );
      simulator.setEnvironment({ ...simulator.environment, wind });
      const current = simulator.telemetry();
      const state = simulator.state;
      simulator.step(
        FIXED_TIME_STEP,
        state.onGround
          ? controls
          : {
              ...controls,
              pitch: -state.angularVelocity.z * 0.3 + (current.isStalled ? -0.36 : 0),
              roll: -state.angularVelocity.x * 0.34 - current.bank * 0.16,
              trim: 0.065,
            },
      );
    }

    const telemetry = simulator.telemetry();
    expect(Math.abs(telemetry.heading - airport.headingRadians)).toBeLessThan((2 * Math.PI) / 180);
    expect(telemetry.groundSpeed).toBeLessThan(0.5);
    expect(simulator.state.onGround).toBe(true);
  });

  it("guards against invalid inputs and remains finite during a long stress run", () => {
    const simulator = new FlightSimulator({
      spawn: {
        velocity: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 50 },
      },
    });

    for (let index = 0; index < 12_000; index += 1) {
      simulator.step(FIXED_TIME_STEP, {
        throttle: index % 200 < 100 ? 1 : 0,
        pitch: Math.sin(index * 0.013),
        roll: Math.sin(index * 0.021),
        yaw: Math.cos(index * 0.017),
        trim: index === 50 ? Number.NaN : 0,
      });
    }

    simulator.step(Number.NaN, { throttle: Number.NaN });
    expectFiniteState(simulator.state);
    expect(Math.hypot(
      simulator.state.orientation.x,
      simulator.state.orientation.y,
      simulator.state.orientation.z,
      simulator.state.orientation.w,
    )).toBeCloseTo(1, 8);
  });
});
