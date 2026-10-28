import type {
  BoatControlState,
  CarControlState,
  CarSetup,
  FlightMode,
  PersonControlState,
  VehicleVisualPayload,
} from "@/src/game/types";
import type { TerrainCollisionSample, WorldDefinition } from "@/src/world/types";
import type { ColliderWorld } from "../colliders";
import type { Quaternion, Vec3 } from "../types";
import type { VehicleSimulator } from "../vehicle";
import type { HullWaterSampler, WaterSurfaceAuthority } from "../water/types";

/** What the worker hands a surface vehicle before every step. */
export interface SurfaceVehicleEnvironment {
  /**
   * The water authority. A wave twin is a `HullWaterSampler`; the shared
   * base's calm sea is a plain `WaterSurfaceAuthority`.
   */
  water: WaterSurfaceAuthority | HullWaterSampler;
  /** World wind velocity at the vehicle, weather scale applied, m/s. */
  wind: Vec3;
  /** Terrain (sea bed) height authority, the one aircraft collide with. */
  bedHeight: (x: number, z: number) => number;
  /**
   * The full contact sample from the same authority (`sampleGroundContact`):
   * height, normal, runway and friction, into a caller-owned target. The
   * worker always provides it; a boat's tests and probes may leave it out.
   */
  groundContact?: (x: number, z: number, target: TerrainCollisionSample) => TerrainCollisionSample;
  /** The world, for the surface classifier's inputs; null before the worker has one. */
  world?: WorldDefinition | null;
  /** The world's static colliders (buildings, guardrails); null where none are built. */
  colliders?: ColliderWorld | null;
  /**
   * Whether the published L0 terrain pages answer everywhere within `radius`
   * of (x, z) (`TerrainAuthority.covers`). A car waits on it at its start so
   * it never settles on a fallback height; absent (tests, probes), it never
   * waits.
   */
  groundReady?: (x: number, z: number, radius: number) => boolean;
  /**
   * The calendar day the renderer paints the terrain for (its clock's
   * `dayOfYear`), so the car's seasonal snow is where the snow is drawn.
   * Absent, the reference day.
   */
  dayOfYear?: number;
  /** Positive gravitational acceleration, m/s². */
  gravity: number;
}

/**
 * The player's input as the worker received it: the assistance mode the
 * settings select, and the class's own control block (`ControlState.boat`).
 */
export interface SurfaceVehicleControls {
  assist: FlightMode;
  boat: BoatControlState;
  /** The car's block (`ControlState.car`); the worker always sets it, boat probes need not. */
  car?: CarControlState;
  /** The walker's block (`ControlState.person`); the worker sets it in a car session. */
  person?: PersonControlState;
}

/** The common pose and engine fields, plus the class payload the HUD and renderer read. */
export interface SurfaceVehicleSnapshot {
  time: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  angularVelocity: Vec3;
  /** 0..1 engine power, for the common `throttle` field and the engine sound. */
  throttle: number;
  engineRpm: number;
  /** In contact with the ground: aground, beached, or on a slipway. */
  onGround: boolean;
  crashed: boolean;
  payload: VehicleVisualPayload;
}

export type SurfaceVehicleSimulator = VehicleSimulator<
  SurfaceVehicleControls,
  SurfaceVehicleEnvironment,
  SurfaceVehicleSnapshot
>;

/** Where and how a surface vehicle begins. Heading as `FlightTelemetry.heading`. */
export interface SurfaceVehicleSpawn {
  position: Vec3;
  heading: number;
  /** Starts made fast to a berth (the dock start). */
  moored: boolean;
  /** The car's gearbox and clutch choice; absent for a boat. */
  car?: CarSetup;
}

export const NEUTRAL_CAR_CONTROLS: Readonly<CarControlState> = Object.freeze({
  accelerator: 0,
  brake: 0,
  steer: 0,
  handbrake: 0,
  clutch: 0,
  shiftUpPresses: 0,
  shiftDownPresses: 0,
  autoModePresses: 0,
  rangePresses: 0,
  lockPresses: 0,
  downhillAssistPresses: 0,
  headlightPresses: 0,
  tyrePressure: "road",
});

export const DEFAULT_CAR_SETUP: Readonly<CarSetup> = Object.freeze({
  gearbox: "automatic",
  manualClutch: false,
});

export const NEUTRAL_BOAT_CONTROLS: Readonly<BoatControlState> = Object.freeze({
  lever: 0,
  steer: 0,
  trim: 0,
  tabs: 0,
  moorPresses: 0,
});

export const NEUTRAL_PERSON_CONTROLS: Readonly<PersonControlState> = Object.freeze({
  moveX: 0,
  moveZ: 0,
  lookPitch: 0,
  run: false,
  rise: false,
  dive: false,
  jumpPresses: 0,
});
