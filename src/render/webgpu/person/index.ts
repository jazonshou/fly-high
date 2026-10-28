import type { Scene } from "@babylonjs/core/scene";
import { createStandInPersonVisual } from "./standInFigure";
import type { PersonVisual } from "./types";

export type { PersonAnimationInput, PersonAnimationOutput, PersonVisual } from "./types";

/** The one place the renderer gets the walker's figure from. */
export function createPersonVisual(scene: Scene): PersonVisual {
  return createStandInPersonVisual(scene);
}
