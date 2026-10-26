import type { Scene } from "@babylonjs/core/scene";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { createWebGpuBoat } from "../boat/createBoat";
import type { VehicleVisual } from "./types";

export type { VehicleVisual } from "./types";

/** The one place the renderer gets a surface vehicle's visual from. */
export function createSurfaceVehicleVisual(scene: Scene, kind: SurfaceVehicleKind): VehicleVisual {
  switch (kind) {
    case "speedboat":
      return createWebGpuBoat(scene, kind);
  }
}
