import type { Scene } from "@babylonjs/core/scene";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { createPlaceholderBoat } from "./placeholderBoat";
import type { VehicleVisual } from "./types";

export type { VehicleVisual } from "./types";

/**
 * The one place the renderer gets a surface vehicle's visual from. The
 * boat-presentation work swaps the placeholder for the real model here.
 */
export function createSurfaceVehicleVisual(scene: Scene, kind: SurfaceVehicleKind): VehicleVisual {
  switch (kind) {
    case "speedboat":
      return createPlaceholderBoat(scene, kind);
  }
}
