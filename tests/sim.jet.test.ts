import { describe, expect, it } from "vitest";
import {
  applyFlightAssistance,
  calculateDragCoefficient,
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
  const cruiseGear = aircraft.retractableGear ? 0 : 1;
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: 3_000, z: 0 },
      heading: Math.PI / 2,
      pitch: (2.4 * Math.PI) / 180,
      airspeed,
      controls: { ...DEFAULT_CONTROLS, throttle: 0.72, gear: cruiseGear },
    },
    controls: { ...DEFAULT_CONTROLS, throttle: 0.72, gear: cruiseGear },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  advance(simulator, 30, (current) => applyFlightAssistance(
    { ...DEFAULT_CONTROLS },
    "scenic",
    { ...DEFAULT_CONTROLS, throttle: 0.9, gear: cruiseGear },
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
    expect(simulator.state.actuators.gear).toBe(0);
  });

  it("cycles retractable gear through a timed transit and accounts for gear and speed-brake drag", () => {
    const cleanDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 0, 0);
    const gearDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 1, 0);
    const brakeDrag = calculateDragCoefficient(0, FAST_JET.clZero, 0, FAST_JET, 0, 1);
    expect(gearDrag).toBeGreaterThan(cleanDrag + 0.04);
    expect(brakeDrag).toBeGreaterThan(cleanDrag + 0.15);

    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 120,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { gravity: 0, wind: { x: 0, y: 0, z: 0 } },
    });
    advance(simulator, 1, () => ({ ...DEFAULT_CONTROLS, gear: 1, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBeCloseTo(FAST_JET.gearCycleRate, 2);
    advance(simulator, 2, () => ({ ...DEFAULT_CONTROLS, gear: 1, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBe(1);
    advance(simulator, 2.5, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0 }));
    expect(simulator.state.actuators.gear).toBe(0);

    const parked = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: { onGround: true, terrainHeight: 0, controls: { ...DEFAULT_CONTROLS, throttle: 0 } },
      controls: { ...DEFAULT_CONTROLS, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    advance(parked, 3, () => ({ ...DEFAULT_CONTROLS, throttle: 0, brake: 1, gear: 0 }));
    expect(parked.state.actuators.gear).toBe(1);
    expect(parked.state.crashed).toBe(false);
  });

  it("treats a gear-up runway contact as airframe damage", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 0.68, z: 0 },
        velocity: { x: 0, y: -1.2, z: 68 },
        pitch: 0,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });

    advance(simulator, 0.25, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0 }));
    expect(simulator.state.crashed).toBe(true);
    expect(simulator.state.onGround).toBe(true);
    expect(simulator.state.actuators.gear).toBe(0);
  });

  it("uses the brake command as an aerodynamic speed brake away from wheel contact", () => {
    const createCruise = () => new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 145,
        pitch: 0,
        controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, gear: 0, throttle: 0 },
      environment: { gravity: 0, airDensity: 1.225, wind: { x: 0, y: 0, z: 0 } },
    });
    const clean = createCruise();
    const braking = createCruise();
    advance(clean, 2, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0, brake: 0 }));
    advance(braking, 2, () => ({ ...DEFAULT_CONTROLS, gear: 0, throttle: 0, brake: 1 }));

    expect(braking.state.onGround).toBe(false);
    expect(braking.state.actuators.brake).toBe(1);
    expect(braking.telemetry().airspeed).toBeLessThan(clean.telemetry().airspeed - 12);
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

  it("supports a gentle gear-down landing, combined braking, and a second takeoff", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 1.54, z: -30 },
        velocity: { x: 0, y: -1.15, z: 78 },
        pitch: (3 * Math.PI) / 180,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.08, flaps: 1, gear: 1 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.08, flaps: 1, gear: 1 },
      environment: { terrain: FLAT_RUNWAY, wind: { x: 0, y: 0, z: 0 } },
    });
    let touchdownTime: number | null = null;
    let stoppedTime: number | null = null;
    let secondLiftoffTime: number | null = null;

    for (let index = 0; index < Math.round(45 / FIXED_TIME_STEP); index += 1) {
      const telemetry = simulator.telemetry();
      let controls: FlightControls;
      if (touchdownTime === null) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0.06, flaps: 1, gear: 1, pitch: 0.04 };
      } else if (stoppedTime === null) {
        controls = { ...DEFAULT_CONTROLS, throttle: 0, flaps: 1, gear: 1, brake: 1 };
      } else {
        controls = {
          ...DEFAULT_CONTROLS,
          throttle: 1,
          flaps: 0.5,
          gear: 1,
          pitch: telemetry.groundSpeed > 75 ? 0.2 : 0,
        };
      }
      simulator.step(FIXED_TIME_STEP, controls);

      if (touchdownTime === null && simulator.state.onGround) {
        touchdownTime = simulator.state.time;
      }
      if (
        touchdownTime !== null &&
        stoppedTime === null &&
        simulator.state.onGround &&
        simulator.telemetry().groundSpeed < 1
      ) {
        stoppedTime = simulator.state.time;
      }
      if (
        stoppedTime !== null &&
        !simulator.state.onGround &&
        simulator.telemetry().altitudeAgl > 1
      ) {
        secondLiftoffTime = simulator.state.time;
        break;
      }
      if (simulator.state.crashed) break;
    }

    expect(touchdownTime).not.toBeNull();
    expect(stoppedTime).not.toBeNull();
    expect(secondLiftoffTime).not.toBeNull();
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.state.peakImpactSpeed).toBeLessThan(3);
    expect(simulator.state.actuators.gear).toBeGreaterThanOrEqual(0.98);
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
