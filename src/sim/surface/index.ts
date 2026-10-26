import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { StandInBoatSimulator } from "./standInBoat";
import type { SurfaceVehicleSimulator, SurfaceVehicleSpawn } from "./types";

export * from "./types";
export { StandInBoatSimulator } from "./standInBoat";
export { flightAnglesOf, surfaceVisualState } from "./visualState";

/**
 * The one place the worker gets a surface vehicle's simulator from. The
 * speedboat physics work swaps the stand-in for `BoatSimulator` here.
 */
export function createSurfaceSimulator(
  kind: SurfaceVehicleKind,
  spawn: SurfaceVehicleSpawn,
): SurfaceVehicleSimulator {
  switch (kind) {
    case "speedboat":
      return new StandInBoatSimulator(spawn);
  }
}
