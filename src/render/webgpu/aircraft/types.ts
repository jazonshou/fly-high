import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { FlightVisualState } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";

/**
 * Babylon equivalent of the legacy aircraft presentation contract.
 *
 * The body frame is deliberately renderer-independent and right-handed:
 * +X points through the nose, +Y points up, and +Z points to port/left.
 */
export interface AircraftVisual {
  readonly kind: AircraftKind;
  readonly handedness: "right";
  /** Root used by the flight renderer to apply camera-relative pose. */
  readonly group: TransformNode;
  /** Alias that makes ownership explicit in new WebGPU call sites. */
  readonly root: TransformNode;
  /** Propeller for the trainer and compressor/nozzle assembly for the jet. */
  readonly propeller: TransformNode;
  /** Exterior pieces hidden to prevent cockpit-camera self-occlusion. */
  readonly cockpitParts: readonly AbstractMesh[];
  /** All meshes owned by this visual, useful for shadow-caster registration. */
  readonly meshes: readonly AbstractMesh[];
  update(state: FlightVisualState, deltaSeconds: number): void;
  setCockpitView(enabled: boolean): void;
  dispose(): void;
}

