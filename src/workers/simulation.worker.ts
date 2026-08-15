/// <reference lib="webworker" />

import {
  applyFlightAssistance,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  type FlightControls,
} from "@/src/sim";
import {
  createWorld,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  sampleWind,
  type TerrainCollisionSample,
  type WindSample,
  type WorldDefinition,
} from "@/src/world";
import { createSimulationSpawn } from "@/src/game/spawn";
import type {
  ControlState,
  FlightMode,
  FlightVisualState,
  WeatherPreset,
} from "@/src/game/types";
import {
  DEFAULT_AIRBORNE_START_AGL,
  normalizeAirborneStartAgl,
  type SimulationCommand,
  type SimulationEvent,
  type SpawnKind,
} from "./protocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let world: WorldDefinition | null = null;
let simulator: FlightSimulator | null = null;
let mode: FlightMode = "unassisted";
let weather: WeatherPreset = "breezy";
let attractMode = false;
let airborneStartAgl = DEFAULT_AIRBORNE_START_AGL;
let controls: ControlState = { ...DEFAULT_CONTROLS };
let paused = true;
let lastTime = performance.now();
let lastSnapshotTime = 0;
let accumulator = 0;
let groundHeadingTarget: number | null = null;
const windTarget: WindSample = { x: 0, y: 0, z: 0, speed: 0, gust: 0, turbulence: 0 };
const collisionTarget: TerrainCollisionSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  isRunway: false,
  friction: 0.86,
};
const assistedTarget: FlightControls = { ...DEFAULT_CONTROLS };

function post(event: SimulationEvent): void {
  workerScope.postMessage(event);
}

function terrainSample(x: number, z: number) {
  if (!world) {
    collisionTarget.height = 0;
    collisionTarget.normal.x = 0;
    collisionTarget.normal.y = 1;
    collisionTarget.normal.z = 0;
    collisionTarget.isRunway = false;
    collisionTarget.friction = 1;
    return collisionTarget;
  }
  return sampleTerrainCollision(world, x, z, collisionTarget);
}

function terrainHeightSample(x: number, z: number): number {
  return world ? sampleTerrainCollisionHeight(world, x, z) : 0;
}

function reset(kind: SpawnKind, requestedAirborneStartAgl = airborneStartAgl): void {
  if (!world) return;
  airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  const spawn = createSimulationSpawn(world, kind, airborneStartAgl);
  groundHeadingTarget = kind === "runway" ? (spawn.heading ?? 0) : null;
  controls = { ...DEFAULT_CONTROLS, ...spawn.controls };
  simulator = new FlightSimulator({
    spawn,
    controls,
    environment: {
      terrain: terrainSample,
      terrainHeight: terrainHeightSample,
      wind: { x: 0, y: 0, z: 0 },
    },
  });
  accumulator = 0;
  lastTime = performance.now();
  lastSnapshotTime = 0;
  post({ type: "ready", state: visualState() });
}

function assistedControls(): FlightControls {
  const sim = simulator;
  if (!sim) return controls;
  return applyFlightAssistance(
    assistedTarget,
    attractMode ? "scenic" : mode,
    controls,
    sim.state,
    sim.telemetry(),
    groundHeadingTarget ?? undefined,
  );
}

function visualState(): FlightVisualState {
  if (!simulator) throw new Error("Simulation has not been initialized");
  const snapshot = simulator.snapshot();
  const telemetry = snapshot.telemetry;
  return {
    position: { ...snapshot.position },
    velocity: { ...snapshot.velocity },
    orientation: { ...snapshot.orientation },
    angularVelocity: { ...snapshot.angularVelocity },
    airspeed: telemetry.indicatedAirspeed,
    altitudeAgl: telemetry.altitudeAgl,
    altitude: telemetry.altitude,
    verticalSpeed: telemetry.verticalSpeed,
    heading: (telemetry.heading * 180) / Math.PI,
    pitch: (telemetry.pitch * 180) / Math.PI,
    bank: (telemetry.bank * 180) / Math.PI,
    angleOfAttack: (telemetry.angleOfAttack * 180) / Math.PI,
    sideslip: (telemetry.sideslip * 180) / Math.PI,
    throttle: snapshot.actuators.throttle,
    engineRpm: snapshot.engineRpm,
    elevator: snapshot.actuators.pitch,
    aileron: snapshot.actuators.roll,
    rudder: snapshot.actuators.yaw,
    brake: snapshot.actuators.brake,
    trim: snapshot.actuators.trim,
    flaps: snapshot.actuators.flaps,
    loadFactor: telemetry.loadFactor,
    onGround: snapshot.onGround,
    stalled: telemetry.isStalled,
    crashed: snapshot.crashed,
    touchdown: simulator.state.peakImpactSpeed,
    simulationTime: snapshot.time,
  };
}

function simulationTick(): void {
  const now = performance.now();
  const elapsed = Math.min(0.05, Math.max(0, (now - lastTime) / 1_000));
  lastTime = now;
  if (paused || !simulator || !world) return;
  accumulator += elapsed;
  let steps = 0;
  while (accumulator >= FIXED_TIME_STEP && steps < 6) {
    const position = simulator.state.position;
    const wind = sampleWind(world, position.x, position.y, position.z, simulator.state.time, windTarget);
    const windScale = weather === "clear" ? 0.62 : weather === "cloudy" ? 1.28 : 1;
    wind.x *= windScale;
    wind.y *= windScale;
    wind.z *= windScale;
    wind.speed *= windScale;
    simulator.setControls(assistedControls());
    simulator.setEnvironment({
      terrain: terrainSample,
      terrainHeight: terrainHeightSample,
      wind,
    });
    simulator.step(FIXED_TIME_STEP);
    if (attractMode) {
      const demoState = simulator.telemetry();
      if (simulator.state.crashed || demoState.altitudeAgl < 65) {
        // The attract flight is disposable automation. Re-seed it before it can
        // disappear behind terrain; ordinary pilot flights are never auto-reset.
        reset("airborne", airborneStartAgl);
        return;
      }
    }
    accumulator -= FIXED_TIME_STEP;
    steps += 1;
  }
  if (steps === 6) accumulator = 0;
  if (now - lastSnapshotTime >= 1000 / 60) {
    lastSnapshotTime = now;
    post({ type: "snapshot", state: visualState() });
  }
}

workerScope.addEventListener("message", (event: MessageEvent<SimulationCommand>) => {
  try {
    const command = event.data;
    if (command.type === "initialize") {
      world = createWorld(command.seed);
      mode = command.mode;
      weather = command.weather;
      attractMode = command.attractMode;
      airborneStartAgl = normalizeAirborneStartAgl(command.airborneStartAgl);
      reset(command.spawn, airborneStartAgl);
      return;
    }
    if (command.type === "controls") controls = { ...command.controls };
    else if (command.type === "mode") mode = command.mode;
    else if (command.type === "weather") weather = command.weather;
    else if (command.type === "attract") attractMode = command.enabled;
    else if (command.type === "handoff") {
      // Atomic handoff: no timer tick can observe the selected mode while demo
      // automation is still enabled, and the existing flight state is untouched.
      mode = command.mode;
      attractMode = false;
    } else if (command.type === "pause") {
      paused = command.paused;
      lastTime = performance.now();
      accumulator = 0;
    } else if (command.type === "reset") {
      attractMode = false;
      reset(command.spawn, command.airborneStartAgl);
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "Simulation error" });
  }
});

setInterval(simulationTick, 4);
