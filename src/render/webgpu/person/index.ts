import type { Scene } from "@babylonjs/core/scene";
import type { AsyncPipelineCompiles } from "../core/AsyncPipelineCompiles";
import type { WebGpuQualityProfile } from "../core/QualityProfile";
import { createFigure } from "./createFigure";
import type { PersonVisual } from "./types";
import type { WalkerBodyAsset } from "./walkerBody";

export type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";
export { loadWalkerBody, type WalkerBodyAsset } from "./walkerBody";

/** What the figure is built for: its body (`loadWalkerBody` at the tier's texture size), the session's tier, and the renderer's pipeline compiles to warm with. */
export interface PersonVisualOptions {
  readonly asset: WalkerBodyAsset;
  readonly profile?: WebGpuQualityProfile;
  readonly pipelineCompiles?: AsyncPipelineCompiles | null;
}

/** The one place the renderer gets the walker's figure from. */
export function createPersonVisual(scene: Scene, options: PersonVisualOptions): PersonVisual {
  return createFigure(scene, options);
}
