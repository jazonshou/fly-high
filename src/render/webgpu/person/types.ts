import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { PersonVisualState } from "@/src/game/types";

/**
 * What the walker's figure reads each frame, besides the pose the renderer
 * gives its root. The renderer poses `PersonVisual.root` at the feet point
 * (floating origin applied) turned by the sim's yaw, or at the driver's seat
 * while seated; the figure animates everything below it.
 *
 * FRAME. The root's: +X forward (the facing), +Y up, +Z right, origin at the
 * feet point on the ground.
 */
export interface PersonAnimationInput {
  readonly person: PersonVisualState;
  /** World velocity, m/s, and the yaw rate, rad/s (positive turning right). */
  readonly velocityX: number;
  readonly velocityY: number;
  readonly velocityZ: number;
  readonly turnRate: number;
  /**
   * The drawn ground's height at a root-frame horizontal offset, relative to
   * the feet point, metres: for foot placement on slopes and steps. Answers
   * 0 where nothing better is known.
   */
  groundOffset(forward: number, right: number): number;
  /** The car's steering-wheel angle while seated, radians, for the hands. */
  readonly steeringWheel: number;
  /**
   * Where the camera aims relative to the facing, radians (yaw positive to
   * the right, pitch positive up), for the head turn. Absent: straight ahead.
   */
  readonly lookYaw?: number;
  readonly lookPitch?: number;
  /**
   * Getting in: where the walker stood when it began, in the seat frame the
   * root is posed at while boarding (metres along the car's forward, up and
   * right axes from the driver's hip point), and its facing relative to the
   * car's (radians, positive turned right). The figure walks from there to
   * the door over progress 0..0.25. Null otherwise.
   */
  readonly boardingFrom?: { readonly forward: number; readonly up: number; readonly right: number; readonly facing: number } | null;
}

/** What one `update` reports back: foot strikes since the last frame, for footsteps. */
export interface PersonAnimationOutput {
  /** 0, 1 or (rarely) 2 feet that touched down this frame. */
  footStrikes: number;
  /** 0..1, how hard the latest one landed (a walk is about 0.4, a run 0.8, a landing 1). */
  strikeStrength: number;
  /** The latest strike's foot. */
  strikeFoot: "left" | "right";
}

/**
 * The walker, drawn. One figure (D2), built in code and animated from
 * published gait data (D1). The renderer owns its root's pose and visibility
 * per camera; the figure owns its meshes, skeleton and materials.
 */
export interface PersonVisual {
  readonly root: TransformNode;
  /** Everything it owns, for shadow-caster registration. */
  readonly meshes: readonly AbstractMesh[];
  update(input: PersonAnimationInput, deltaSeconds: number): PersonAnimationOutput;
  /** First person: the head is hidden from the eye, the body still drawn looking down. */
  setFirstPersonView(enabled: boolean): void;
  /** 0 solid .. 1 gone, for a camera pushed in closer than `PERSON.camera.fadeDistance`. */
  setFade(amount: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
