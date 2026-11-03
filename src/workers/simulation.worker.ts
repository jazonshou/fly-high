/// <reference lib="webworker" />

import { aircraftSpec } from "@/src/aircraft/catalogue";
import {
  applyFlightAssistance,
  aircraftDefinition,
  isGroundSteering,
  AttractHold,
  Autoland,
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
  heldElevator,
  JetStabilityAugmentation,
  pitchGearingFactor,
  TRIM_ELEVATOR_AUTHORITY,
  type FlightControls,
  type AircraftKind,
  type FlightState,
  type FlightTelemetry,
  type SpawnOptions,
} from "@/src/sim";
import {
  nearestAirport,
  sampleWind,
  withAirports,
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
import {
  createSurfaceSimulator,
  DEFAULT_CAR_SETUP,
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_CAR_CONTROLS,
  surfaceVisualState,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
  type SurfaceVehicleSpawn,
} from "@/src/sim/surface";
import {
  CalmWaterSurface,
  createSeaTwin,
  HydrologyWaterSource,
  resolveSeaSpectrumConfig,
  SeaTwin,
  WaterSurfaceComposite,
} from "@/src/sim/water";
import { homeMarina } from "@/src/world/marina";
import {
  applyInfrastructureRegionsUpdate,
  unpackInfrastructureRegionsPost,
  type InfrastructureRegionsPost,
} from "@/src/world/infrastructureSync";
import { BoatSimulator } from "@/src/sim/boat/boatSimulator";
import { CarColliders } from "@/src/sim/ground/carColliders";
import { type CarSea, createCarSea } from "@/src/sim/ground/carSea";
import { GroundVehicleSimulator } from "@/src/sim/ground/groundVehicle";
import { MarinaHarbour } from "@/src/sim/marina/harbour";
import { createSurfaceRecoverySpawn, createSurfaceSpawn } from "@/src/game/surfaceSpawn";
import { vehicleClass, type SurfaceVehicleKind } from "@/src/vehicles/kinds";
import type {
  AutolandVisualState,
  CarSetup,
  ControlState,
  FlightMode,
  FlightVisualState,
  WeatherPreset,
} from "@/src/game/types";
import {
  DEFAULT_AIRBORNE_START_AGL,
  isSurfaceSpawn,
  normalizeAirborneStartAgl,
  type AircraftSpawnKind,
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
/**
 * The PLAYER's controls with the pitch axis geared down for speed, for Direct
 * and Pilot -- see `pitchGearing` in the catalogue. Separate for the same
 * reason as `scenicControls`: pitch retention and the dampers must still read
 * the pilot's own hand, which is `controls`.
 */
const gearedControls: ControlState = { ...DEFAULT_CONTROLS };
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
/**
 * The autoland for the current aeroplane, rebuilt with it. While engaged it
 * flies in place of the pilot's controls and every assistance law; it reads
 * the pilot's stick only to notice a firm input and hand back.
 */
let autoland: Autoland | null = null;
const autolandControls: FlightControls = { ...DEFAULT_CONTROLS };
const autolandInput: {
  state: FlightState;
  telemetry: FlightTelemetry;
  terrainHeight: (x: number, z: number) => number;
  seaLevel: number;
  dt: number;
} = {
  state: null as unknown as FlightState,
  telemetry: null as unknown as FlightTelemetry,
  terrainHeight: terrainHeightSample,
  seaLevel: 0,
  dt: FIXED_TIME_STEP,
};
/** A stick deflection past this, on pitch or roll, takes the aeroplane back. */
const AUTOLAND_OVERRIDE_STICK = 0.5;

/**
 * The session's surface vehicle, if it has one, and its simulator while it is
 * the thing being driven: a `"dock"` or `"airfield"` spawn installs it, any
 * aircraft spawn or the menu's attract flight drops it. While it runs, the aeroplane path below
 * is not stepped at all, so aircraft sessions are untouched by any of it.
 */
let surfaceVehicle: SurfaceVehicleKind | null = null;
let surface: SurfaceVehicleSimulator | null = null;
/** The home marina's structures, lines and contact, for a boat that has them. */
let harbour: MarinaHarbour | null = null;
/** The buildings, the marina and the guardrails a car meets, for a car session. */
let carColliders: CarColliders | null = null;
/**
 * The lakes and rivers the renderer has posted (`hydrology` commands), kept
 * for the whole session: the car's water is the sea and these together. The
 * boat takes the same composite later (boats W3).
 */
const hydrologyWater = new HydrologyWaterSource(terrainHeightSample);
/** The sea a car session wades: the boat's sea twin, asked only where the car is in it. */
let carSea: CarSea | null = null;
/** The car's gearbox and clutch, from the session's settings. */
let carSetup: CarSetup = DEFAULT_CAR_SETUP;
const surfaceControls: SurfaceVehicleControls = {
  assist: "scenic",
  boat: { ...NEUTRAL_BOAT_CONTROLS },
  car: { ...NEUTRAL_CAR_CONTROLS },
};
const surfaceWind = { x: 0, y: 0, z: 0 };
const surfaceEnvironment: SurfaceVehicleEnvironment = {
  water: new CalmWaterSurface(0, terrainHeightSample),
  wind: surfaceWind,
  bedHeight: terrainHeightSample,
  groundContact: surfaceGroundContact,
  groundReady: (x, z, radius) => terrainAuthority.covers(x, z, radius),
  world: null,
  colliders: null,
  gravity: 9.80665,
};

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

/** `terrainSample` into the caller's own target, for a surface vehicle's several contacts. */
function surfaceGroundContact(x: number, z: number, target: TerrainCollisionSample): TerrainCollisionSample {
  if (world) return sampleGroundContact(world, x, z, target);
  target.height = 0;
  target.normal.x = 0;
  target.normal.y = 1;
  target.normal.z = 0;
  target.isRunway = false;
  target.friction = 1;
  return target;
}

function installSimulation(kind: AircraftSpawnKind, spawn: SpawnOptions): void {
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
  autoland = new Autoland(aircraft);
  accumulator = 0;
  lastTime = performance.now();
  lastSnapshotTime = 0;
  post({ type: "ready", state: visualState() });
}

function installSurface(kind: SurfaceVehicleKind, spawn: SurfaceVehicleSpawn): void {
  disengageAutoland();
  controls = { ...DEFAULT_CONTROLS };
  surfaceControls.boat = { ...NEUTRAL_BOAT_CONTROLS };
  surfaceControls.car = { ...NEUTRAL_CAR_CONTROLS };
  surfaceEnvironment.world = world;
  const boat = vehicleClass(kind) === "boat";
  // The sea the renderer draws, from the same spectrum, seed and weather,
  // calmed inside the home marina's basin, over the worker's own bed. The
  // car wades the same sea (built here, inside its wait for the terrain:
  // about 0.2 s) and the posted lakes and rivers.
  const seaLevel = world?.seaLevel ?? 0;
  carSea = null;
  if (world && boat) {
    const sea = createSeaTwin(world, weather, terrainHeightSample);
    sea.setShelter([homeMarina(world).shelter]);
    surfaceEnvironment.water = sea;
  } else if (boat) {
    surfaceEnvironment.water = new CalmWaterSurface(seaLevel, terrainHeightSample);
  } else {
    carSea = world ? createCarSea(world, weather) : null;
    const sea = carSea ?? new CalmWaterSurface(seaLevel, terrainHeightSample);
    surfaceEnvironment.water = new WaterSurfaceComposite(sea, hydrologyWater, seaLevel);
  }
  // The boat meets the marina through its harbour; the car meets every
  // airport's buildings, the marina and the roads' guardrails.
  carColliders = !boat && world ? new CarColliders(world, terrainHeightSample) : null;
  surfaceEnvironment.colliders = carColliders?.colliders ?? null;
  surface = createSurfaceSimulator(kind, boat ? spawn : { ...spawn, car: carSetup });
  harbour = surface instanceof BoatSimulator && world ? new MarinaHarbour(world, surface) : null;
  if (harbour && spawn.moored && world) harbour.makeFastAtStart(world);
  accumulator = 0;
  lastTime = performance.now();
  lastSnapshotTime = 0;
  post({ type: "ready", state: visualState() });
}

function surfaceVehicleOrThrow(): SurfaceVehicleKind {
  if (!surfaceVehicle) throw new Error("A surface start needs a surface vehicle: this session has none");
  return surfaceVehicle;
}

function stepSurface(active: SurfaceVehicleSimulator): void {
  if (!world) return;
  const position = active.state.position;
  const wind = sampleWind(world, position.x, position.y, position.z, active.state.time, windTarget);
  const windScale = weather === "clear" ? 0.62 : weather === "cloudy" ? 1.28 : 1;
  surfaceWind.x = wind.x * windScale;
  surfaceWind.y = wind.y * windScale;
  surfaceWind.z = wind.z * windScale;
  surfaceEnvironment.water.setTime(active.state.time);
  hydrologyWater.setVehiclePosition(position.x, position.z);
  surfaceControls.assist = mode;
  surfaceControls.boat = controls.boat ?? NEUTRAL_BOAT_CONTROLS;
  surfaceControls.car = controls.car ?? NEUTRAL_CAR_CONTROLS;
  active.setControls(surfaceControls);
  active.setEnvironment(surfaceEnvironment);
  harbour?.beforeStep(surfaceControls.boat, mode === "scenic", surfaceEnvironment);
  active.step(FIXED_TIME_STEP);
  harbour?.afterStep();
}

function prepareAutolandInput(sim: FlightSimulator): typeof autolandInput {
  autolandInput.state = sim.state;
  autolandInput.telemetry = sim.telemetry();
  autolandInput.seaLevel = world?.seaLevel ?? 0;
  return autolandInput;
}

function setAutoland(enabled: boolean): void {
  if (!enabled) {
    disengageAutoland();
    return;
  }
  const sim = simulator;
  if (!sim || !world || !autoland || attractMode || autoland.engaged || surface) return;
  const target = nearestAirport(world, sim.state.position.x, sim.state.position.z);
  if (!target) return;
  autoland.engage(target.airport, prepareAutolandInput(sim), controls);
}

/**
 * Hands the aeroplane back to the pilot's controls. The assistance laws hold
 * targets learned before the autoland flew, so they start again from here.
 */
function disengageAutoland(): void {
  if (!autoland?.engaged) return;
  autoland.disengage();
  handBackFromAutoland();
}

function handBackFromAutoland(): void {
  scenicAltitudeHold.reset();
  directPitchRetention.reset();
  jetStabilityAugmentation.reset();
}

/** One step of the autoland, or the pilot's controls if it has just dropped out. */
function autolandStep(sim: FlightSimulator): FlightControls {
  const active = autoland!;
  active.update(prepareAutolandInput(sim), autolandControls);
  if (active.engaged) return autolandControls;
  handBackFromAutoland();
  return assistedControls();
}

/** A spawned airport can be nearer than the one the approach was planned to. */
function retargetAutoland(): void {
  const sim = simulator;
  if (!sim || !world || !autoland?.engaged) return;
  const target = nearestAirport(world, sim.state.position.x, sim.state.position.z);
  const current = autoland.targetRunway;
  if (!target || !current) return;
  if (target.airport.centerX === current.centerX && target.airport.centerZ === current.centerZ) return;
  autoland.retarget(target.airport, prepareAutolandInput(sim));
}

function autolandVisualState(): AutolandVisualState | null {
  const active = autoland;
  const runway = active?.targetRunway;
  if (!active?.engaged || !runway) return null;
  const status = active.status;
  if (status.phase === "off") return null;
  const heading = (status.runwayHeading * 180) / Math.PI;
  return {
    phase: status.phase,
    attempt: status.attempt,
    distanceToTouchdown: status.distanceToTouchdown,
    runwayHeading: ((heading % 360) + 360) % 360,
    targetAirspeed: status.targetAirspeed,
    goAroundReason: status.goAroundReason,
    runwayX: runway.centerX,
    runwayZ: runway.centerZ,
    throttle: autolandControls.throttle,
    flaps: autolandControls.flaps,
    gear: autolandControls.gear,
  };
}

function reset(kind: SpawnKind, requestedAirborneStartAgl = airborneStartAgl): void {
  if (!world) return;
  airborneStartAgl = normalizeAirborneStartAgl(requestedAirborneStartAgl);
  if (isSurfaceSpawn(kind)) {
    const vehicle = surfaceVehicleOrThrow();
    installSurface(vehicle, createSurfaceSpawn(world, vehicle));
    return;
  }
  surface = null;
  harbour = null;
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
  if (surface) {
    // A wrecked boat comes back upright and afloat in the open water nearest
    // the wreck, not at the dock forty minutes' run away; a rolled car comes
    // back on its wheels where it lies.
    if (!world || !surface.state.crashed) return;
    const vehicle = surfaceVehicleOrThrow();
    const wreck = surface.state.position;
    installSurface(vehicle, createSurfaceRecoverySpawn(world, vehicle, wreck.x, wreck.z));
    return;
  }
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
 * R in a car session: the car back on its newest safe spot, upright and
 * stopped, in place (`GroundVehicleSimulator.recover`): the same simulator,
 * so the drive's setup and the input's press counts carry on. The aircraft
 * and the boats never take it. Posted as a fresh start, so the renderer
 * cuts to the new pose rather than sliding to it.
 */
function recoverCar(): void {
  if (!(surface instanceof GroundVehicleSimulator)) return;
  surface.recover();
  accumulator = 0;
  lastTime = performance.now();
  lastSnapshotTime = 0;
  post({ type: "ready", state: visualState() });
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
  // Scenic's ground heading hold keeps the runway heading of a runway start
  // through the take-off roll. Steering (rudder, or A/D's tiller) moves the
  // heading it holds to wherever the pilot lets go, and it ends once the
  // aeroplane is flying: it is not the heading of whatever runway it lands on.
  if (groundHeadingTarget !== null) {
    if (telemetry.altitudeAgl > 5) groundHeadingTarget = null;
    else if (sim.state.onGround && isGroundSteering(controls)) groundHeadingTarget = telemetry.heading;
  }
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
    // Direct and Pilot hand the stick to the elevator, whose bite grows with
    // dynamic pressure; Scenic commands an attitude and needs no gearing.
    copyControlState(gearedControls, controls);
    gearedControls.pitch = controls.pitch * pitchGearingFactor(
      aircraftSpec(aircraftKind).pitchGearing,
      telemetry.indicatedAirspeed,
    );
    requestedControls = gearedControls;
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
  if (surface) return surfaceVisualState(surface.snapshot(), terrainAuthority.countersSnapshot());
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
    groundSpoilers: snapshot.actuators.groundSpoilers,
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
    autoland: autolandVisualState(),
  };
}

function simulationTick(): void {
  const now = performance.now();
  const elapsed = Math.min(0.05, Math.max(0, (now - lastTime) / 1_000));
  lastTime = now;
  if (paused || !world || (!simulator && !surface)) return;
  accumulator += elapsed;
  let steps = 0;
  while (accumulator >= FIXED_TIME_STEP && steps < 6) {
    if (surface) {
      stepSurface(surface);
      accumulator -= FIXED_TIME_STEP;
      steps += 1;
      continue;
    }
    if (!simulator) break;
    const position = simulator.state.position;
    const wind = sampleWind(world, position.x, position.y, position.z, simulator.state.time, windTarget);
    const windScale = weather === "clear" ? 0.62 : weather === "cloudy" ? 1.28 : 1;
    wind.x *= windScale;
    wind.y *= windScale;
    wind.z *= windScale;
    wind.speed *= windScale;
    if (attractMode) updateAttractSupervisor();
    simulator.setControls(autoland?.engaged ? autolandStep(simulator) : assistedControls());
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

/**
 * The main thread's streamed regions, into this worker's copy of the stage:
 * collision's analytic fallback reads them, and the L0 pages they change are
 * dropped until their rebuilds arrive.
 */
function applyInfrastructure(post: InfrastructureRegionsPost): void {
  if (!world) return;
  const update = unpackInfrastructureRegionsPost(post);
  const change = applyInfrastructureRegionsUpdate(world, update);
  if (update.reset) terrainAuthority.applyInfrastructureReset();
  else if (change) terrainAuthority.applyInfrastructureChange(change);
  carColliders?.applyRegions(update);
}

workerScope.addEventListener("message", (event: MessageEvent<SimulationCommand>) => {
  try {
    const command = event.data;
    if (command.type === "initialize") {
      // The main thread already resolved and certified the public seed. Reuse
      // that structured-cloneable world so worker startup cannot repeat the
      // synchronous airport search or select a different fallback region.
      terrainAuthority.clear();
      hydrologyWater.clear();
      carColliders = null;
      world = command.world;
      applyInfrastructure(command.infrastructure);
      aircraftKind = command.aircraft;
      mode = command.mode;
      weather = command.weather;
      attractMode = command.attractMode;
      surfaceVehicle = command.surfaceVehicle;
      carSetup = command.carSetup;
      surfaceEnvironment.dayOfYear = command.dayOfYear;
      surface = null;
      harbour = null;
      airborneStartAgl = normalizeAirborneStartAgl(command.airborneStartAgl);
      reset(attractMode ? "airborne" : command.spawn, airborneStartAgl);
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
    if (command.type === "infrastructure") {
      applyInfrastructure(command.update);
      return;
    }
    if (command.type === "hydrology") {
      hydrologyWater.setRegion(command.key, command.region);
      return;
    }
    if (command.type === "hydrologyEvict") {
      hydrologyWater.evictRegion(command.key);
      return;
    }
    if (command.type === "airports") {
      if (world) world = withAirports(world, command.airports);
      if (surfaceEnvironment.world) surfaceEnvironment.world = world;
      if (world) carColliders?.setAirports(world);
      retargetAutoland();
      return;
    }
    if (command.type === "autoland") {
      setAutoland(command.enabled);
      return;
    }
    if (command.type === "controls") {
      controls = { ...command.controls };
      if (
        autoland?.engaged
        && Math.max(Math.abs(controls.pitch), Math.abs(controls.roll)) > AUTOLAND_OVERRIDE_STICK
      ) disengageAutoland();
    }
    else if (command.type === "mode") {
      // Applying an unrelated settings change re-sends the selected mode. Keep
      // an armed pilot-selected target unless the assistance mode truly changes.
      if (command.mode !== mode) {
        directPitchRetention.reset();
        jetStabilityAugmentation.reset();
      }
      mode = command.mode;
    }
    else if (command.type === "weather") {
      weather = command.weather;
      // The sea state follows the weather (D2): the twin rebuilds its spectrum.
      if (world && surfaceEnvironment.water instanceof SeaTwin) {
        surfaceEnvironment.water.setConfig(resolveSeaSpectrumConfig(world, weather));
      }
      if (world && carSea) carSea.setConfig(resolveSeaSpectrumConfig(world, weather));
    }
    else if (command.type === "carSetup") {
      carSetup = command.carSetup;
    }
    else if (command.type === "dayOfYear") {
      surfaceEnvironment.dayOfYear = command.dayOfYear;
    }
    else if (command.type === "attract") {
      attractMode = command.enabled;
      if (attractMode) disengageAutoland();
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
      } else if (command.mode !== "scenic" && simulator) {
        // Pilot and Direct have no hold to carry the trim, so it goes onto the
        // player's TRIM, which is the surface a real pilot would have used.
        //
        // The transfer is done on the actuators in one step because the two
        // slew at wildly different rates -- the pitch actuator at 7 per second,
        // the trim actuator at 0.45 -- so seeding only the control would let
        // the elevator collapse and refill over a tenth of a second. Moving
        // both at once keeps the elevator itself unchanged: what leaves the
        // pitch actuator arrives on the trim actuator in the same frame.
        //
        // The remainder is computed from the elevator the simulation has RIGHT
        // NOW rather than from the seed, so the elevator is continuous even if
        // the main thread's snapshot was a frame stale; a slightly stale seed
        // just leaves a little more in the pitch actuator.
        const actuators = simulator.state.actuators;
        const held = heldElevator(actuators.pitch, actuators.trim);
        // The MAIN THREAD's value is authoritative, because the input
        // controller owns trim and will re-send exactly this on its next
        // message; deriving our own here would only make the trim actuator
        // slew from ours to theirs. Bounded defensively as a protocol value.
        const seeded = Math.min(1, Math.max(-1, command.trimSeed));
        actuators.trim = seeded;
        actuators.pitch = held - seeded * TRIM_ELEVATOR_AUTHORITY;
        // Hold the same target locally until the input controller's next
        // message arrives carrying it, so the trim actuator does not spend a
        // frame slewing back toward a stale zero.
        controls.trim = seeded;
      }
      directPitchRetention.reset();
      jetStabilityAugmentation.reset();
    } else if (command.type === "returnToAttract") {
      // End-flight is one state transition: no timer tick can observe a new
      // airborne state without the menu controller that is meant to own it.
      attractMode = true;
      surface = null;
      harbour = null;
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
    } else if (command.type === "recover") {
      recoverCar();
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "Simulation error" });
  }
});

setInterval(simulationTick, 4);
