/// <reference lib="webworker" />

import { aircraftSpec } from "@/src/aircraft/catalogue";
import {
  applyFlightAssistance,
  aircraftDefinition,
  AttractHold,
  ScenicAltitudeHold,
  attractScanOffset,
  attractScanSamples,
  ATTRACT_SCAN_TRAVEL_METERS,
  ATTRACT_SCAN_TURN_RADIANS,
  attractClimbRateFor,
  attractScanDistance,
  attractTrackVector,
  shouldReseedAttract,
  stallSpeed,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FIXED_TIME_STEP,
  FlightSimulator,
  JetStabilityAugmentation,
  type FlightControls,
  type AircraftKind,
  type SpawnOptions,
} from "@/src/sim";
import {
  sampleWind,
  type TerrainCollisionSample,
  type WindSample,
  type WorldDefinition,
} from "@/src/world";
import {
  airborneAirspeedForAircraft,
  createCrashRecoverySpawn,
  createSimulationSpawn,
} from "@/src/game/spawn";
import {
  sampleGroundContact,
  sampleGroundHeight,
  setGroundHeightMirror,
} from "@/src/sim/terrainGrid";
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
import { TerrainAuthority } from "./terrainAuthority";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const terrainAuthority = new TerrainAuthority();
setGroundHeightMirror(terrainAuthority);

let world: WorldDefinition | null = null;
let simulator: FlightSimulator | null = null;
let aircraftKind: AircraftKind = "trainer";
let mode: FlightMode = "unassisted";
let weather: WeatherPreset = "breezy";
let attractMode = false;
let airborneStartAgl = DEFAULT_AIRBORNE_START_AGL;
let controls: ControlState = { ...DEFAULT_CONTROLS };
/**
 * The attract flight's own pilot inputs. The demo has no pilot, and Scenic's
 * neutral is a commanded 2.5 degrees nose-up, so "no input" means "climb
 * forever" -- see src/sim/attract.ts. These are what the supervisor writes and
 * what `assistedControls` hands to Scenic as `requested` while attractMode is
 * on. Player flight never reads them.
 */
const attractControls: ControlState = { ...DEFAULT_CONTROLS };
/**
 * The PLAYER's controls with Scenic's height hold applied to the pitch axis.
 *
 * Scenic is attitude-command and its neutral was 2.5 degrees nose-up, so a
 * centred stick asked to climb. The hold replaces that one axis with
 * `learnedTrim + stick` -- see src/sim/scenicHold.ts -- and leaves every other
 * axis exactly as the pilot left it. A separate object because `controls` is
 * the raw pilot input and other things read it.
 */
const scenicControls: ControlState = { ...DEFAULT_CONTROLS };
const scenicAltitudeHold = new ScenicAltitudeHold();
const attractOutput = { pitch: 0, roll: 0, throttle: 0 };
let attractHold: AttractHold | null = null;
/** Look-ahead scan, refreshed on travel rather than every step (see below). */
const attractScan = { ahead: 0, left: 0, right: 0, distance: 0 };
let attractScanX = Number.NaN;
let attractScanZ = Number.NaN;
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
const directPitchRetention = new DirectPitchRetention();
const jetStabilityAugmentation = new JetStabilityAugmentation();

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
  return sampleGroundContact(world, x, z, collisionTarget);
}

function terrainHeightSample(x: number, z: number): number {
  return world ? sampleGroundHeight(world, x, z) : 0;
}

function installSimulation(kind: SpawnKind, spawn: SpawnOptions): void {
  const aircraft = aircraftDefinition(aircraftKind);
  groundHeadingTarget = kind === "runway" ? (spawn.heading ?? 0) : null;
  controls = { ...DEFAULT_CONTROLS, ...spawn.controls };
  // A fresh aeroplane must not inherit the last one's trim: the supervisor's
  // integrator has found ONE airframe's level attitude, and the demo may be
  // re-seeding into a different aircraft kind entirely. Seeded from the spawn's
  // own throttle so it starts near-trimmed rather than hunting from zero.
  attractControls.pitch = 0;
  attractControls.roll = 0;
  attractControls.throttle = controls.throttle;
  attractHold = new AttractHold(controls.throttle);
  scenicAltitudeHold.reset();
  attractScanX = Number.NaN;
  attractScanZ = Number.NaN;
  simulator = new FlightSimulator({
    aircraft,
    spawn,
    controls,
    environment: {
      terrain: terrainSample,
      terrainHeight: terrainHeightSample,
      // Telemetry only -- the pilot's AGL reads to the water surface, while
      // the two samplers above keep describing the sea BED for contact,
      // friction and crash. Not hardcoded zero: a world sets its own.
      seaLevel: world?.seaLevel ?? 0,
      wind: { x: 0, y: 0, z: 0 },
    },
  });
  directPitchRetention.reset();
  jetStabilityAugmentation.reset();
  accumulator = 0;
  lastTime = performance.now();
  lastSnapshotTime = 0;
  post({ type: "ready", state: visualState() });
}

function reset(kind: SpawnKind, requestedAirborneStartAgl = airborneStartAgl): void {
  if (!world) return;
  airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  installSimulation(
    kind,
    createSimulationSpawn(world, kind, airborneStartAgl, aircraftKind),
  );
}

/**
 * Crash recovery deliberately snapshots the simulator's absolute world-space
 * position before replacing it. FlightRenderer's 4 km floating origin exists
 * only on the main thread and is therefore neither needed nor accepted here.
 */
function restartAfterCrash(requestedAirborneStartAgl = airborneStartAgl): void {
  if (!world || !simulator || !simulator.state.crashed) return;
  const crashWorldX = simulator.state.position.x;
  const crashWorldZ = simulator.state.position.z;
  const crashHeading = simulator.telemetry().heading;
  airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  installSimulation(
    "airborne",
    createCrashRecoverySpawn(
      world,
      crashWorldX,
      crashWorldZ,
      crashHeading,
      airborneStartAgl,
      aircraftKind,
    ),
  );
}

/**
 * Highest surface along a track, sampled forward from the aircraft.
 *
 * MAX rather than mean: an average lets one peak hide inside a valley, and the
 * peak is the thing being avoided. Each sample is maxed against sea level for
 * the same reason `crashRecoverySurfaceHeight` does it -- the worker's samplers
 * describe the sea BED, so without it the demo would dive at a coastline.
 */
function scanTrack(
  originX: number,
  originZ: number,
  headingX: number,
  headingZ: number,
  distance: number,
  currentAltitude: number,
  groundSpeed: number,
): number {
  const sea = world?.seaLevel ?? 0;
  const samples = attractScanSamples(distance);
  let steepest = -Infinity;
  for (let i = 1; i <= samples; i += 1) {
    const along = attractScanOffset(i, samples, distance);
    const sampled = terrainHeightSample(originX + headingX * along, originZ + headingZ * along);
    const height = Math.max(Number.isFinite(sampled) ? sampled : sea, sea);
    // Reduce by the climb each point DEMANDS, not by how high it is: a ridge
    // 500 m ahead and one 4 km ahead are different problems at the same height.
    steepest = Math.max(
      steepest,
      attractClimbRateFor(height, along, currentAltitude, groundSpeed),
    );
  }
  return steepest;
}

/**
 * Drives the attract flight: refreshes the terrain look-ahead when the aircraft
 * has moved far enough to justify it, then lets the supervisor write the pilot
 * inputs Scenic will fly. Called ONLY from the attract branch of the tick, so
 * player flight cannot reach any of it.
 */
function updateAttractSupervisor(): void {
  const sim = simulator;
  if (!sim) return;
  if (!attractHold) attractHold = new AttractHold(controls.throttle);
  const telemetry = sim.telemetry();
  const position = sim.state.position;

  const travelled = Math.hypot(position.x - attractScanX, position.z - attractScanZ);
  if (!(travelled < ATTRACT_SCAN_TRAVEL_METERS)) {
    attractScanX = position.x;
    attractScanZ = position.z;
    const speed = telemetry.groundSpeed;
    attractScan.distance = attractScanDistance(speed);
    // The ground-projected nose, NORMALISED. The chase camera's own clamp uses
    // the un-normalised forward vector, which shortens its horizon by cos(pitch)
    // exactly when the aeroplane is climbing and needs it most; that is a bug to
    // avoid inheriting, not a precedent to copy.
    // RADIANS. `telemetry.heading` is atan2(forward.x, forward.z) straight out
    // of the simulator; it is `visualState` below that converts it to degrees
    // for the HUD, not the telemetry itself. Multiplying by PI/180 here pointed
    // the whole terrain scan 57 times too close to north: traced, the aeroplane
    // was tracking 45 degrees while the scan looked down 0.9 degrees, so ridges
    // appeared in it only once they were a few hundred metres away and the turn
    // fired far too late to do anything.
    // One authority for "which way is the aeroplane going", and its docblock is
    // where the radians-versus-degrees trap is written down.
    const [hx, hz] = attractTrackVector(telemetry.heading);
    const turn = ATTRACT_SCAN_TURN_RADIANS;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const altitude = position.y;
    const gs = telemetry.groundSpeed;
    const d = attractScan.distance;
    attractScan.ahead = scanTrack(position.x, position.z, hx, hz, d, altitude, gs);
    attractScan.left = scanTrack(
      position.x, position.z, hx * cos + hz * sin, hz * cos - hx * sin, d, altitude, gs,
    );
    attractScan.right = scanTrack(
      position.x, position.z, hx * cos - hz * sin, hz * cos + hx * sin, d, altitude, gs,
    );
  }

  attractHold.update(
    {
      clearance: telemetry.altitudeAgl,
      targetClearance: airborneStartAgl,
      requiredClimbRate: attractScan.ahead,
      requiredClimbRateLeft: attractScan.left,
      requiredClimbRateRight: attractScan.right,
      verticalSpeed: telemetry.verticalSpeed,
      groundSpeed: telemetry.groundSpeed,
      equivalentAirspeed: telemetry.indicatedAirspeed,
      targetAirspeed: airborneAirspeedForAircraft(aircraftKind),
      stallSpeed: stallSpeed(sim.aircraft, sim.state.actuators.flaps),
      dt: FIXED_TIME_STEP,
    },
    attractOutput,
  );
  attractControls.pitch = attractOutput.pitch;
  attractControls.roll = attractOutput.roll;
  attractControls.throttle = attractOutput.throttle;
}

/** Field-for-field copy, so the hold replaces one axis and inherits the rest. */
function copyControlState(out: ControlState, from: ControlState): void {
  out.throttle = from.throttle;
  out.pitch = from.pitch;
  out.roll = from.roll;
  out.yaw = from.yaw;
  out.trim = from.trim;
  out.flaps = from.flaps;
  out.brake = from.brake;
  out.gear = from.gear;
}

function assistedControls(): FlightControls {
  const sim = simulator;
  if (!sim) return controls;
  const telemetry = sim.telemetry();
  const selectedMode = attractMode ? "scenic" : mode;
  // Scenic's centred stick holds height. NOT under attractMode: the menu flight
  // carries its own complete supervisor (src/sim/attract.ts), and layering a
  // second altitude hold beneath it would be two controllers arguing over one
  // elevator. Not in Pilot or Direct either -- those are pass-through laws and
  // Jason asked for this in Scenic.
  let requestedControls = attractMode ? attractControls : controls;
  if (!attractMode && selectedMode === "scenic") {
    copyControlState(scenicControls, controls);
    scenicControls.pitch = scenicAltitudeHold.update({
      pitchStick: controls.pitch,
      onGround: sim.state.onGround,
      clearance: telemetry.altitudeAgl,
      altitude: sim.state.position.y,
      verticalSpeed: telemetry.verticalSpeed,
      equivalentAirspeed: telemetry.indicatedAirspeed,
      stallSpeed: stallSpeed(sim.aircraft, sim.state.actuators.flaps),
      dt: FIXED_TIME_STEP,
    });
    requestedControls = scenicControls;
  } else if (!attractMode) {
    scenicAltitudeHold.reset();
  }
  const selectedControls = applyFlightAssistance(
    assistedTarget,
    selectedMode,
    requestedControls,
    sim.state,
    telemetry,
    groundHeadingTarget ?? undefined,
  );
  if (selectedMode !== "unassisted") return selectedControls;
  const retained = directPitchRetention.apply(
    selectedControls,
    controls,
    sim.state,
    telemetry,
  );
  // The dutch-roll dampers share the Direct-mode doctrine: they run only on
  // pilot-neutral axes, and only on an airframe whose own mode is poorly
  // enough damped to want them — see `dutchRollDamper` in the catalogue, which
  // is decided per aeroplane rather than by whether it burns kerosene.
  return aircraftSpec(aircraftKind).dutchRollDamper
    ? jetStabilityAugmentation.apply(retained, controls, sim.state, telemetry)
    : retained;
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
    gear: snapshot.actuators.gear,
    loadFactor: telemetry.loadFactor,
    onGround: snapshot.onGround,
    stalled: telemetry.isStalled,
    crashed: snapshot.crashed,
    touchdown: simulator.state.peakImpactSpeed,
    simulationTime: snapshot.time,
    terrainAuthority: terrainAuthority.countersSnapshot(),
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
    if (attractMode) updateAttractSupervisor();
    simulator.setControls(assistedControls());
    simulator.setEnvironment({
      terrain: terrainSample,
      terrainHeight: terrainHeightSample,
      seaLevel: world?.seaLevel ?? 0,
      wind,
    });
    simulator.step(FIXED_TIME_STEP);
    if (attractMode) {
      const demoState = simulator.telemetry();
      if (shouldReseedAttract(simulator.state.crashed, demoState.altitudeAgl)) {
        // The attract flight is disposable automation. Re-seed it before it can
        // disappear behind terrain; ordinary pilot flights are never auto-reset.
        // Since the supervisor above holds the set altitude and turns away from
        // ground it cannot out-climb, this is now a last resort rather than the
        // routine outcome it used to be.
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
      // The main thread already resolved and certified the public seed. Reuse
      // that structured-cloneable world so worker startup cannot repeat the
      // synchronous airport search or select a different fallback region.
      terrainAuthority.clear();
      world = command.world;
      aircraftKind = command.aircraft;
      mode = command.mode;
      weather = command.weather;
      attractMode = command.attractMode;
      airborneStartAgl = normalizeAirborneStartAgl(command.airborneStartAgl);
      reset(command.spawn, airborneStartAgl);
      return;
    }
    if (command.type === "terrainPage") {
      terrainAuthority.publish(command.page);
      return;
    }
    if (command.type === "terrainMacro") {
      terrainAuthority.publishMacro(command.macro);
      return;
    }
    if (command.type === "controls") controls = { ...command.controls };
    else if (command.type === "mode") {
      // Applying an unrelated settings change re-sends the selected mode. Keep
      // an armed pilot-selected target unless the assistance mode truly changes.
      if (command.mode !== mode) {
        directPitchRetention.reset();
        jetStabilityAugmentation.reset();
      }
      mode = command.mode;
    }
    else if (command.type === "weather") weather = command.weather;
    else if (command.type === "attract") {
      attractMode = command.enabled;
      directPitchRetention.reset();
      jetStabilityAugmentation.reset();
    }
    else if (command.type === "handoff") {
      // Atomic handoff: no timer tick can observe the selected mode while demo
      // automation is still enabled, and the existing flight state is untouched.
      mode = command.mode;
      attractMode = false;
      // The aeroplane the pilot is handed is already trimmed: the menu flight
      // spent the last minutes learning what attitude holds THIS airframe level
      // at THIS speed and power, and Scenic's hold runs the identical law. Take
      // the answer instead of re-learning it from zero, which would walk the
      // whole trim back into the commanded pitch over the first seconds of the
      // pilot's flight -- a sag, then a recovery, on the one transition they
      // are guaranteed to be watching.
      if (command.mode === "scenic" && attractHold) {
        scenicAltitudeHold.adopt(attractHold.verticalTrim);
      }
      directPitchRetention.reset();
      jetStabilityAugmentation.reset();
    } else if (command.type === "returnToAttract") {
      // End-flight is one state transition: no timer tick can observe a new
      // airborne state without the menu controller that is meant to own it.
      attractMode = true;
      reset("airborne", command.airborneStartAgl);
    } else if (command.type === "pause") {
      paused = command.paused;
      lastTime = performance.now();
      accumulator = 0;
    } else if (command.type === "reset") {
      attractMode = false;
      reset(command.spawn, command.airborneStartAgl);
    } else if (command.type === "restartAfterCrash") {
      attractMode = false;
      restartAfterCrash(command.airborneStartAgl);
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "Simulation error" });
  }
});

setInterval(simulationTick, 4);
