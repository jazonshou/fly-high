import type { Quaternion, Vec3 } from "./types";

/**
 * The rigid-body pose every simulator exposes, in the conventions of
 * `src/sim/types.ts`: world Y-up, body +X forward, +Y up, +Z starboard;
 * `orientation` rotates body vectors into world; angular velocity is in body
 * space.
 */
export interface VehiclePoseState {
  time: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  angularVelocity: Vec3;
  crashed: boolean;
}

/**
 * The seam between the sim worker and a surface vehicle's physics.
 *
 * The worker owns the clock: it calls `setControls` and `setEnvironment`
 * before every fixed 120 Hz `step` (`FIXED_TIME_STEP`), and reads `snapshot`
 * at the 60 Hz presentation rate. A simulator substeps internally if its
 * stiff terms need it. `step` must not allocate.
 *
 * `FlightSimulator` keeps its own richer interface and its own worker path
 * unchanged; this seam exists so a boat (and later a car) plugs in beside it
 * rather than through it.
 */
export interface VehicleSimulator<Controls, Environment, Snapshot> {
  readonly state: VehiclePoseState;
  setControls(controls: Readonly<Controls>): void;
  setEnvironment(environment: Readonly<Environment>): void;
  step(dt: number): void;
  snapshot(): Snapshot;
}
