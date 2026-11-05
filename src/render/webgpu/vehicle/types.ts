import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { FlightVisualState } from "@/src/game/types";
import type { VehicleKind } from "@/src/vehicles/kinds";
import type { AircraftLightState } from "../lighting/AircraftLighting";

/**
 * What the renderer needs of whatever it is following: the shape
 * `AircraftVisual` already has, so every aircraft visual is one unchanged.
 * Body frame as the aircraft's: +X forward, +Y up, +Z starboard, origin at the
 * centre of gravity the sim reports.
 *
 * A boat's lamps go through the same law: port and starboard sidelights on
 * `portNav`/`starboardNav`, the all-round white stern light on `tailNav`;
 * it has no beacon, strobe or landing light and ignores them.
 */
export interface VehicleVisual {
  readonly kind: VehicleKind;
  readonly root: TransformNode;
  /** Exterior pieces hidden from the cockpit (helm) camera. */
  readonly cockpitParts: readonly AbstractMesh[];
  /** Everything it owns, for shadow-caster registration. */
  readonly meshes: readonly AbstractMesh[];
  update(state: FlightVisualState, deltaSeconds: number): void;
  setLightState(state: AircraftLightState): void;
  setCockpitView(enabled: boolean): void;
  /** How far the car's front doors stand open, 0 shut .. 1; the vehicles without doors leave it out. */
  setDoors?(right: number, left: number): void;
  dispose(): void;
}
