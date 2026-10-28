import type { Vec3 } from "../types";
import type { SurfaceVehicleSimulator } from "../surface/types";

/** Where the walker starts: the feet point, and the heading it faces (`FlightTelemetry.heading`). */
export interface PersonSpawn {
  position: Vec3;
  heading: number;
}

/**
 * The walker's physics, through the same seam as a boat or the car
 * (`VehicleSimulator`): the worker sets `controls.person` and the surface
 * environment before every fixed 120 Hz step and reads the `"person"`
 * payload at 60 Hz. Pose as `PersonVisualState` describes: `position` is the
 * feet point, `orientation` turns about world Y only.
 *
 * The walking session (`src/sim/person/walkingSession.ts`) owns the person
 * and the car together and steps the person only while it is on foot; while
 * it is aboard, or getting in or out, the person is not stepped.
 *
 * `step` must not allocate, and stays under 20 us (the plan's budget,
 * asserted as a ratio to an in-process reference kernel).
 */
export interface PersonSimulator extends SurfaceVehicleSimulator {
  /**
   * Stands the walker at a feet point facing `heading`, at rest, and makes it
   * the newest safe spot: getting out of the car, a restart. A grounded walker
   * snaps to the ground or deck under that point at its next step.
   */
  placeAt(position: Readonly<Vec3>, heading: number): void;
  /** R on foot: back on the newest safe standing spot, at rest. */
  recover(): void;
}
