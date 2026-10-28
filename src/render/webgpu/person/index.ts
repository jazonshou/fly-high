import type { Scene } from "@babylonjs/core/scene";
import type { AsyncPipelineCompiles } from "../core/AsyncPipelineCompiles";
import type { WebGpuQualityProfile } from "../core/QualityProfile";
import { createStandInPersonVisual } from "./standInFigure";
import type { PersonVisual } from "./types";

export type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";

/** What the figure is built for: the session's tier, and the renderer's pipeline compiles to warm with. */
export interface PersonVisualOptions {
  readonly profile?: WebGpuQualityProfile;
  readonly pipelineCompiles?: AsyncPipelineCompiles | null;
}

/** The one place the renderer gets the walker's figure from. */
export function createPersonVisual(scene: Scene, options: PersonVisualOptions = {}): PersonVisual {
  // The stand-in looks the same on every tier and compiles nothing late.
  void options;
  return createStandInPersonVisual(scene);
}
