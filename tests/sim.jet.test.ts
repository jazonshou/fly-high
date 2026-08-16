import { describe, expect, it } from "vitest";
import {
  applyFlightAssistance,
  calculateEngineThrust,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  LIGHT_TRAINER,
  type AircraftDefinition,
  type FlightControls,
  type FlightState,
} from "../src/sim";
import { createSimulationSpawn } from "../src/game/spawn";
import {
  createWorld,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleWind,
} from "../src/world";

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
  for (let index = 0; index < Math.round(seconds / FIXED_TIME_STEP); index += 1) {
    simulator.step(FIXED_TIME_STEP, controls(simulator));
  }
}

function expectFiniteState(state: FlightState): void {
  expect([
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
    state.dynamics.airspeed,
    state.dynamics.loadFactor,
  ].every(Number.isFinite)).toBe(true);
}

function runSustainedFlight(aircraft: AircraftDefinition, airspeed: number): FlightSimulator {
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: 3_000, z: 0 },
      heading: Math.PI / 2,
      pitch: (2.4 * Math.PI) / 180,
      airspeed,
      controls: { ...DEFAULT_CONTROLS, throttle: 0.72 },
    },
    controls: { ...DEFAULT_CONTROLS, throttle: 0.72 },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  advance(simulator, 30, (current) => applyFlightAssistance(
    { ...DEFAULT_CONTROLS },
    "scenic",
    { ...DEFAULT_CONTROLS, throttle: 0.9 },
    current.state,
    current.telemetry(),
  ));
  return simulator;
}

describe("fast jet flight model", () => {
  it("places its airborne spawn at the exact requested wheel AGL", () => {
    const world = createWorld(0x51a7e);
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: createSimulationSpawn(world, "airborne", 975, "jet"),
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
      },
    });

    expect(simulator.telemetry().altitudeAgl).toBeCloseTo(975, 8);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.telemetry().airspeed).toBeCloseTo(155, 8);
    expect(simulator.state.actuators.throttle).toBeCloseTo(0.17, 8);
  });

  it("has linear throttle response, density lapse, and bounded inlet loss", () => {
    const seaLevelStatic = calculateEngineThrust(FAST_JET, 1, 1.225, 0);
    const halfThrottle = calculateEngineThrust(FAST_JET, 0.5, 1.225, 0);
    const halfDensityStatic = calculateEngineThrust(FAST_JET, 1, 1.225 * 0.5, 0);
    const transonicEntry = calculateEngineThrust(FAST_JET, 1, 1.225, 300);
    const highSpeed = calculateEngineThrust(FAST_JET, 1, 1.225, 400);
    const beyondModelEnvelope = calculateEngineThrust(FAST_JET, 1, 1.225, 800);
    const nearVacuum = calculateEngineThrust(FAST_JET, 1, 0.01225, 0);

    expect(seaLevelStatic).toBeCloseTo(42_000, 8);
    expect(halfThrottle).toBeCloseTo(seaLevelStatic * 0.5, 8);
    expect(halfDensityStatic / seaLevelStatic).toBeCloseTo(0.5 ** 0.72, 8);
    expect(transonicEntry / seaLevelStatic).toBeCloseTo(0.9466666667, 8);
    expect(highSpeed / seaLevelStatic).toBeCloseTo(0.88, 8);
    expect(beyondModelEnvelope).toBeCloseTo(highSpeed, 8);
    expect(nearVacuum / seaLevelStatic).toBeCloseTo(0.01 ** 0.72, 8);
    expect(calculateEngineThrust(FAST_JET, 1, 0, 0)).toBe(0);
    expect(calculateEngineThrust(FAST_JET, 0, 1.225, 0)).toBe(0);
  });

  it("sustains materially more speed than the unchanged trainer", () => {
    const trainer = runSustainedFlight(LIGHT_TRAINER, 56);
    const jet = runSustainedFlight(FAST_JET, 155);
    const trainerTelemetry = trainer.telemetry();
    const jetTelemetry = jet.telemetry();

    expectFiniteState(trainer.state);
    expectFiniteState(jet.state);
    expect(trainer.state.crashed).toBe(false);
    expect(jet.state.crashed).toBe(false);
    expect(trainerTelemetry.airspeed).toBeGreaterThan(50);
    expect(trainerTelemetry.airspeed).toBeLessThan(70);
    expect(jetTelemetry.airspeed).toBeGreaterThan(210);
    expect(jetTelemetry.airspeed).toBeLessThan(260);
    expect(jetTelemetry.airspeed).toBeGreaterThan(trainerTelemetry.airspeed * 3.3);
  });

  it("stays controllable across the menu-Scenic to neutral-Direct handoff", () => {
    const world = createWorld(0x51a7e);
    const spawn = createSimulationSpawn(world, "airborne", 975, "jet");
    const wind = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn,
      environment: {
        terrain: (x, z) => sampleTerrainCollision(world, x, z),
        terrainHeight: (x, z) => sampleTerrainCollisionHeight(world, x, z),
        wind,
      },
    });
    const assisted = { ...DEFAULT_CONTROLS };
    const requested = { ...DEFAULT_CONTROLS, ...spawn.controls };

    advance(simulator, 4, (current) => {
      sampleWind(
        world,
        current.state.position.x,
        current.state.position.y,
        current.state.position.z,
        current.state.time,
        wind,
      );
      return applyFlightAssistance(
        assisted,
        "scenic",
        requested,
        current.state,
        current.telemetry(),
      );
    });
    const handoffAltitude = simulator.state.position.y;
    const retention = new DirectPitchRetention();
    let maximumPitch = Math.abs(simulator.telemetry().pitch);
    let maximumClimbRate = Math.max(0, simulator.telemetry().verticalSpeed);

    advance(simulator, 30, (current) => {
      sampleWind(
        world,
        current.state.position.x,
        current.state.position.y,
        current.state.position.z,
        current.state.time,
        wind,
      );
      const telemetry = current.telemetry();
      maximumPitch = Math.max(maximumPitch, Math.abs(telemetry.pitch));
      maximumClimbRate = Math.max(maximumClimbRate, telemetry.verticalSpeed);
      return retention.apply(
        assisted,
        requested,
        current.state,
        telemetry,
      );
    });

    const altitudeGain = simulator.state.position.y - handoffAltitude;
    const finalTelemetry = simulator.telemetry();
    expectFiniteState(simulator.state);
    expect(retention.isArmed).toBe(false);
    expect(simulator.state.crashed).toBe(false);
    expect((maximumPitch * 180) / Math.PI).toBeLessThan(6);
    expect(maximumClimbRate).toBeLessThan(12);
    expect(Math.abs(altitudeGain)).toBeLessThan(180);
    expect(finalTelemetry.airspeed).toBeGreaterThan(140);
    expect(finalTelemetry.airspeed).toBeLessThan(165);
  });

  it("rotates and lifts off gently from a runway", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        onGround: true,
        terrainHeight: 0,
        controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.015 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0, trim: 0.015 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    let liftoffTime: number | null = null;
    let liftoffDistance: number | null = null;
    let liftoffAirspeed: number | null = null;

    for (let index = 0; index < Math.round(30 / FIXED_TIME_STEP); index += 1) {
      const groundSpeed = simulator.telemetry().groundSpeed;
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        trim: 0.015,
        pitch: liftoffTime === null && groundSpeed > 62 ? 0.3 : 0,
      });
      if (
        liftoffTime === null &&
        !simulator.state.onGround &&
        simulator.telemetry().altitudeAgl > 0.5
      ) {
        liftoffTime = simulator.state.time;
        liftoffDistance = Math.hypot(simulator.state.position.x, simulator.state.position.z);
        liftoffAirspeed = simulator.telemetry().airspeed;
      } else if (
        liftoffTime !== null &&
        simulator.state.time - liftoffTime >= 2
      ) {
        break;
      }
      if (simulator.state.crashed) break;
    }

    expect(liftoffTime).not.toBeNull();
    expect(liftoffTime ?? 99).toBeLessThan(15);
    expect(liftoffDistance ?? 9_999).toBeLessThan(650);
    expect(liftoffAirspeed ?? 0).toBeGreaterThan(75);
    expect(liftoffAirspeed ?? 999).toBeLessThan(100);
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.state.peakImpactSpeed).toBeLessThan(1);
    expect(simulator.telemetry().altitudeAgl).toBeGreaterThan(5);
    expect(simulator.telemetry().airspeed).toBeGreaterThan(50);
    expect(Math.abs(simulator.telemetry().pitch)).toBeLessThan((18 * Math.PI) / 180);
  });

  it("detects the jet nose striking before its gear or centre of gravity", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 5.5, z: 0 },
        velocity: { x: 0, y: -20, z: 0 },
        pitch: -Math.PI / 2,
        controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    simulator.step(FIXED_TIME_STEP);

    expect(simulator.state.crashed).toBe(true);
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.telemetry().altitudeAgl).toBe(0);
    expect(simulator.state.peakImpactSpeed).toBeGreaterThan(8.5);
    expect(simulator.state.position.y).toBeCloseTo(5.866, 3);
    expect(simulator.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(simulator.state.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("keeps aggressive high-speed jet dynamics finite and structurally bounded", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 12_000, z: 0 },
        heading: Math.PI / 2,
        pitch: -0.2,
        bank: 0.35,
        airspeed: 180,
        velocity: { x: 340, y: 0, z: 0 },
      },
      environment: {
        airDensity: 0.05,
        gravity: 0,
        wind: { x: 0, y: 0, z: 0 },
      },
    });
    simulator.step(FIXED_TIME_STEP, { ...DEFAULT_CONTROLS, throttle: 1 });
    expect(simulator.telemetry().airspeed).toBeGreaterThan(330);
    let maximumRollRate = 0;
    let maximumYawRate = 0;
    let maximumPitchRate = 0;
    let maximumRateChange = 0;

    for (let index = 0; index < Math.round(8 / FIXED_TIME_STEP); index += 1) {
      const previousRate = { ...simulator.state.angularVelocity };
      const direction = Math.floor(simulator.state.time / 0.9) % 2 === 0 ? 1 : -1;
      simulator.step(FIXED_TIME_STEP, {
        ...DEFAULT_CONTROLS,
        throttle: 1,
        pitch: direction,
        roll: -direction,
        yaw: direction,
      });
      maximumRollRate = Math.max(
        maximumRollRate,
        Math.abs(simulator.state.angularVelocity.x),
      );
      maximumYawRate = Math.max(
        maximumYawRate,
        Math.abs(simulator.state.angularVelocity.y),
      );
      maximumPitchRate = Math.max(
        maximumPitchRate,
        Math.abs(simulator.state.angularVelocity.z),
      );
      maximumRateChange = Math.max(
        maximumRateChange,
        Math.abs(simulator.state.angularVelocity.x - previousRate.x) / FIXED_TIME_STEP,
        Math.abs(simulator.state.angularVelocity.y - previousRate.y) / FIXED_TIME_STEP,
        Math.abs(simulator.state.angularVelocity.z - previousRate.z) / FIXED_TIME_STEP,
      );
    }

    expectFiniteState(simulator.state);
    expect(simulator.state.crashed).toBe(false);
    expect(maximumRollRate).toBeLessThanOrEqual(4.26);
    expect(maximumYawRate).toBeLessThanOrEqual(2.36);
    expect(maximumPitchRate).toBeLessThanOrEqual(3.11);
    expect(maximumRateChange).toBeLessThan(12);
    expect(simulator.state.dynamics.airspeed).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.x)).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.y)).toBeLessThanOrEqual(350);
    expect(Math.abs(simulator.state.velocity.z)).toBeLessThanOrEqual(350);
  });

  it("preserves the trainer propeller-thrust baseline", () => {
    expect(calculateEngineThrust(LIGHT_TRAINER, 1, 1.225, 0)).toBeCloseTo(2_650, 8);
    expect(calculateEngineThrust(LIGHT_TRAINER, 1, 1.225, 50)).toBeCloseTo(2_112, 8);
    expect(calculateEngineThrust(LIGHT_TRAINER, 0.5, 1.225, 50)).toBeCloseTo(1_056, 8);
  });
});
