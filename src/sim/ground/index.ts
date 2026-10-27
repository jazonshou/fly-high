import type { SurfaceVehicleSimulator, SurfaceVehicleSpawn } from "../surface/types";
import { GroundVehicleSimulator } from "./groundVehicle";

export * from "./groundVehicle";

/** The LandCruiser 76's simulator, from `createSurfaceSimulator`. */
export function createCarSimulator(spawn: SurfaceVehicleSpawn): SurfaceVehicleSimulator {
  return new GroundVehicleSimulator(spawn);
}
