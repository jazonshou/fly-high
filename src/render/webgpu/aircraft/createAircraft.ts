import type { Scene } from "@babylonjs/core/scene";
import type { AircraftKind } from "@/src/sim";
import { assertRightHandedScene } from "./airframeRig";
import { createJet } from "./jetVisual";
import { createTrainer } from "./trainerVisual";
import type { AircraftVisual } from "./types";

/**
 * Creates a procedural aircraft directly in the provided Babylon scene.
 * The scene must already be configured as right-handed.
 *
 * One builder per airframe, in its own module: `trainerVisual`, `jetVisual`.
 * The shared rig, its pose application and the cockpit-layer handling live in
 * `airframeRig`.
 */
const BUILDERS: Readonly<Record<AircraftKind, (scene: Scene) => AircraftVisual>> =
  Object.freeze({
    trainer: createTrainer,
    jet: createJet,
  });

export function createAircraft(
  scene: Scene,
  kind: AircraftKind = "trainer",
): AircraftVisual {
  assertRightHandedScene(scene);
  return (BUILDERS[kind] ?? createTrainer)(scene);
}

/** Explicit WebGPU-era name for call sites migrating alongside the old module. */
export const createWebGpuAircraft = createAircraft;
