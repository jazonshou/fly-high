import type { FlightVisualState } from "@/src/game/types";
import { clamp, rotateVectorInto, wrapAngle } from "../math";
import type { Quaternion, Vec3 } from "../types";
import type { SurfaceVehicleSnapshot } from "./types";

const BODY_FORWARD: Vec3 = { x: 1, y: 0, z: 0 };
const BODY_UP: Vec3 = { x: 0, y: 1, z: 0 };
const BODY_STARBOARD: Vec3 = { x: 0, y: 0, z: 1 };
const forward: Vec3 = { x: 0, y: 0, z: 0 };
const up: Vec3 = { x: 0, y: 0, z: 0 };
const starboard: Vec3 = { x: 0, y: 0, z: 0 };

/** Heading, pitch and bank in radians, with `FlightTelemetry`'s definitions and signs. */
export function flightAnglesOf(orientation: Quaternion): { heading: number; pitch: number; bank: number } {
  rotateVectorInto(forward, orientation, BODY_FORWARD);
  rotateVectorInto(up, orientation, BODY_UP);
  rotateVectorInto(starboard, orientation, BODY_STARBOARD);
  return {
    heading: wrapAngle(Math.atan2(forward.x, forward.z)),
    pitch: Math.asin(clamp(forward.y, -1, 1)),
    bank: Math.atan2(-starboard.y, up.y),
  };
}

const DEGREES = 180 / Math.PI;

/**
 * A surface vehicle's snapshot as the common `FlightVisualState`: the pose,
 * speed and engine in the shared fields, the aircraft-only ones neutral, and
 * the class payload on `vehicle`. `airspeed` carries a boat's speed through
 * the water, a car's road speed and a walker's ground speed, which is what
 * the chase camera's speed ramps want.
 */
export function surfaceVisualState(
  snapshot: SurfaceVehicleSnapshot,
  terrainAuthority: FlightVisualState["terrainAuthority"],
): FlightVisualState {
  const angles = flightAnglesOf(snapshot.orientation);
  const payload = snapshot.payload;
  const speed = payload.kind === "car"
    ? Math.abs(payload.speed)
    : payload.kind === "person"
      ? payload.speed
      : payload.speedThroughWater;
  return {
    position: { ...snapshot.position },
    velocity: { ...snapshot.velocity },
    orientation: { ...snapshot.orientation },
    angularVelocity: { ...snapshot.angularVelocity },
    airspeed: speed,
    altitudeAgl: 0,
    altitude: snapshot.position.y,
    verticalSpeed: snapshot.velocity.y,
    heading: angles.heading * DEGREES,
    pitch: angles.pitch * DEGREES,
    bank: angles.bank * DEGREES,
    angleOfAttack: 0,
    sideslip: 0,
    throttle: clamp(snapshot.throttle, 0, 1),
    engineRpm: snapshot.engineRpm,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    brake: 0,
    groundSpoilers: 0,
    trim: 0,
    flaps: 0,
    gear: 1,
    loadFactor: 1,
    onGround: snapshot.onGround,
    stalled: false,
    crashed: snapshot.crashed,
    touchdown: 0,
    simulationTime: snapshot.time,
    ...(terrainAuthority ? { terrainAuthority } : {}),
    autoland: null,
    vehicle: snapshot.payload,
  };
}
