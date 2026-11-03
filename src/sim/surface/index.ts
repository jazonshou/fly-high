import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { BoatSimulator } from "../boat/boatSimulator";
import { createCarSimulator } from "../ground";
import type { SurfaceVehicleSimulator, SurfaceVehicleSpawn } from "./types";

export * from "./types";
export { flightAnglesOf, surfaceVisualState } from "./visualState";

/** The one place the worker gets a surface vehicle's simulator from. */
export function createSurfaceSimulator(
  kind: SurfaceVehicleKind,
  spawn: SurfaceVehicleSpawn,
): SurfaceVehicleSimulator {
  switch (kind) {
    case "speedboat":
      return new BoatSimulator(spawn);
    case "landcruiser":
      return createCarSimulator(spawn);
  }
}
