import type { SurfaceVehicleSimulator, SurfaceVehicleSpawn } from "../surface/types";
import { StandInCarSimulator } from "./standInCar";

export * from "./standInCar";

/** The LandCruiser 76's simulator, from `createSurfaceSimulator`. */
export function createCarSimulator(spawn: SurfaceVehicleSpawn): SurfaceVehicleSimulator {
  return new StandInCarSimulator(spawn);
}
