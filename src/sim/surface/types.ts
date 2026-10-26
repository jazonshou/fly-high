import type {
  BoatControlState,
  FlightMode,
  VehicleVisualPayload,
} from "@/src/game/types";
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
}

export const NEUTRAL_BOAT_CONTROLS: Readonly<BoatControlState> = Object.freeze({
  lever: 0,
  steer: 0,
  trim: 0,
  tabs: 0,
  moorPresses: 0,
});
