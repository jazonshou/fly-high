/**
 * Coordinate conventions
 * ----------------------
 * World space is a right-handed, Y-up frame:
 *   +X east/right, +Y up, +Z north/forward at heading zero.
 *
 * Aircraft body space is right-handed and matches the renderer's quaternion convention:
 *   +X through the nose, +Y up, +Z starboard (right wing).
 *
 * (fwd, up, starboard) is the right-handed triple: forward x up = starboard.
 * SETTLED 2026-09-01 (D-6): this file previously declared +Z port and claimed
 * the opposite handedness — that claim was arithmetically backwards, and the
 * renderer applies this quaternion to a mesh whose physical starboard is +Z
 * (measured, scripts/bodyaxes-probe.mts; nav lights placed accordingly in
 * 7cacc44). The old declaration made every lateral axis render mirrored:
 * keyboard roll carried a local inversion, rudder was visually reversed, and
 * the HUD bank contradicted the horizon. Pilot-facing signs are unchanged and
 * are the contract: only the internal body-axis component signs moved.
 *
 * `orientation` rotates body-space vectors into world space. Angular velocity is
 * expressed in body space. Public angles and controls use pilot-friendly signs:
 * positive pitch is nose-up, positive roll is right-wing-down, and positive yaw
 * turns the nose right. Distances are metres, speeds metres/second, forces
 * newtons, masses kilograms, angles radians, and time seconds.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface FlightControls {
  /** 0..1 engine power. */
  throttle: number;
  /** -1..1, positive commands nose-up elevator. */
  pitch: number;
  /** -1..1, positive commands a right-wing-down roll. */
  roll: number;
  /** -1..1, positive commands the nose right. */
  yaw: number;
  /** -1..1 elevator trim. */
  trim: number;
  /** 0..1 flap extension. */
  flaps: number;
  /** 0..1 brake command: speed brake in flight, plus wheel brakes on contact. */
  brake: number;
  /** 0..1 landing-gear command. Fixed-gear aircraft force this to 1. */
  gear: number;
}

export interface TerrainSample {
  /** World-space surface height at the requested X/Z position. */
  height: number;
  /** World-space outward normal. Defaults to (0, 1, 0). */
  normal?: Vec3;
  /** Optional dry-surface friction multiplier. Defaults to 1. */
  friction?: number;
}

export type TerrainSampler = (x: number, z: number) => TerrainSample;
export type TerrainHeightSampler = (x: number, z: number) => number;

export interface EnvironmentInput {
  /** World-space wind velocity. */
  wind?: Vec3;
  /** Optional density override in kg/m^3. An ISA-like approximation is used otherwise. */
  airDensity?: number;
  /** Positive gravitational acceleration in m/s^2. Defaults to 9.80665. */
  gravity?: number;
  /**
   * A callback samples each wheel independently. A single sample is interpreted
   * as a local tangent plane centred below the aircraft CG.
   */
  terrain?: TerrainSample | TerrainSampler;
  /**
   * Optional height-only companion to `terrain`. When supplied, the solver
   * uses it to reject airborne contact and compute far-from-ground AGL without
   * requesting normals and friction. It must describe the same surface.
   */
  terrainHeight?: TerrainHeightSampler;
}

export interface SpawnOptions {
  position?: Partial<Vec3>;
  /** Ground-relative velocity. Overrides heading/airspeed when supplied. */
  velocity?: Partial<Vec3>;
  heading?: number;
  pitch?: number;
  bank?: number;
  airspeed?: number;
  angularVelocity?: Partial<Vec3>;
  controls?: Partial<FlightControls>;
  /** Convenience ground spawn. Position Y becomes gear-clearance above terrain height. */
  onGround?: boolean;
  terrainHeight?: number;
}

export type ActuatorState = FlightControls;

export interface DynamicsState {
  angleOfAttack: number;
  sideslip: number;
  airspeed: number;
  airDensity: number;
  liftCoefficient: number;
  dragCoefficient: number;
  liftForce: number;
  dragForce: number;
  thrustForce: number;
  sideForce: number;
  loadFactor: number;
  contactCount: number;
  totalForceWorld: Vec3;
}

export interface FlightState {
  time: number;
  position: Vec3;
  velocity: Vec3;
  /** Body-to-world rotation. */
  orientation: Quaternion;
  /** Body-space angular velocity in rad/s. */
  angularVelocity: Vec3;
  /** Rate-limited physical actuator positions. */
  actuators: ActuatorState;
  engineRpm: number;
  onGround: boolean;
  crashed: boolean;
  /** Largest downward contact speed since reset. */
  peakImpactSpeed: number;
  dynamics: DynamicsState;
}

export interface FlightTelemetry {
  airspeed: number;
  indicatedAirspeed: number;
  groundSpeed: number;
  verticalSpeed: number;
  altitude: number;
  /** Clearance between the lowest landing-gear contact point and terrain. */
  altitudeAgl: number;
  heading: number;
  pitch: number;
  bank: number;
  angleOfAttack: number;
  sideslip: number;
  loadFactor: number;
  stallMargin: number;
  isStalled: boolean;
  onGround: boolean;
  crashed: boolean;
  engineRpm: number;
}

export interface FlightSnapshot {
  time: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  angularVelocity: Vec3;
  actuators: ActuatorState;
  engineRpm: number;
  onGround: boolean;
  crashed: boolean;
  telemetry: FlightTelemetry;
}
