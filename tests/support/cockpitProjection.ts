import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { aircraftSpec } from "../../src/aircraft/catalogue";
import {
  COCKPIT_AIM_DISTANCE_METERS,
  COCKPIT_HORIZONTAL_FOV_DEGREES,
  cockpitRigPositionsToRef,
} from "../../src/render/cameraPresentation";
import type { AircraftKind } from "../../src/sim";

/**
 * Look through the COCKPIT CAMERA the way the renderer does, in a Node test.
 *
 * WHY THIS EXISTS. An instrument's sign is a statement about what the pilot SEES,
 * and a test that measures an angle in some frame of its own can pass while every
 * needle runs backwards: a dial's normal points TOWARD the pilot, so a positive
 * right-handed rotation about it looks ANTI-clockwise to him. These helpers put a
 * point where the flight camera would draw it, so a test can ask which way a
 * needle moved on the screen.
 *
 * It is built from the renderer's own pieces, not a copy of their arithmetic:
 * `cockpitRigPositionsToRef` places the eye and the aim point exactly as
 * `FlightRenderer.updateCamera` does (the eye from the catalogue, in the left seat
 * where there are two, the aim point carrying the same offset), the lens is
 * `COCKPIT_HORIZONTAL_FOV_DEGREES` on a horizontal-fixed camera, and the projection
 * is Babylon's own `Vector3.Project`. The cockpit camera is physically attached to
 * the aircraft (`cameraBankFollow` 1), so its up is the body's up.
 *
 * SCREEN CONVENTION (asserted by `tests/render.cockpit-instruments.test.ts` before
 * anything else relies on it): x grows to the RIGHT, y grows DOWNWARD, as pixels.
 */

export const SCREEN_WIDTH = 1_600;
export const SCREEN_HEIGHT = 900;

export function createCockpitTestEngine(): NullEngine {
  return new NullEngine({
    renderWidth: SCREEN_WIDTH,
    renderHeight: SCREEN_HEIGHT,
    textureSize: 512,
    deterministicLockstep: false,
    lockstepMaxSteps: 1,
  });
}

/** Where the camera looks, for the in-front test `project` needs. */
const forwardOf = new WeakMap<Camera, Vector3>();

/**
 * Put `camera` where the renderer puts the cockpit camera for an aircraft of
 * `kind` at `position` with body orientation `orientation` (body-to-world).
 */
export function pointCockpitCamera(
  camera: UniversalCamera,
  kind: AircraftKind,
  position: Vector3,
  orientation: Quaternion,
): void {
  const body = new Matrix();
  Matrix.FromQuaternionToRef(orientation.clone().normalize(), body);
  // `FlightRenderer.updatePresentation`: body +X (forward) and +Y (up) into the world.
  const forward = Vector3.TransformNormal(Vector3.Right(), body).normalize();
  const up = Vector3.TransformNormal(Vector3.Up(), body).normalize();
  const eye = aircraftSpec(kind).cockpitEye;
  const target = new Vector3();
  cockpitRigPositionsToRef(position, forward, up, eye, eye.right, COCKPIT_AIM_DISTANCE_METERS, camera.position, target);
  camera.upVector.copyFrom(up);
  camera.setTarget(target);
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.fov = (COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 180;
  camera.minZ = 0.08;
  camera.getViewMatrix(true);
  camera.getProjectionMatrix(true);
  forwardOf.set(camera, forward);
}

export interface ScreenPoint {
  /** Pixels from the left. */
  readonly x: number;
  /** Pixels from the TOP: y grows downward. */
  readonly y: number;
  /** Metres in front of the eye along the view direction; negative means behind it. */
  readonly depth: number;
}

/** Where a world point is drawn by the cockpit camera, in pixels of a 1600 x 900 frame. */
export function project(camera: Camera, point: Vector3): ScreenPoint {
  const view = camera.getViewMatrix();
  const projection = camera.getProjectionMatrix();
  const screen = Vector3.Project(
    point,
    Matrix.IdentityReadOnly,
    view.multiply(projection),
    new Viewport(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT),
  );
  const forward = forwardOf.get(camera);
  if (!forward) throw new Error("pointCockpitCamera has not been called for this camera");
  return { x: screen.x, y: screen.y, depth: Vector3.Dot(point.subtract(camera.position), forward) };
}

/**
 * Clockwise as the viewer sees it on a screen whose y grows DOWNWARD: turning from
 * `from` to `to` (2D vectors in pixels) is clockwise when the cross product
 * `from.x * to.y - from.y * to.x` is POSITIVE. Check: 12 o'clock is (0, -1) and
 * 3 o'clock is (1, 0); cross = 0 * 0 - (-1) * 1 = +1, and that is clockwise. With
 * y UP the same turn would be negative. Written here once so no test has to
 * re-derive it.
 */
export function turnedClockwise(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return from.x * to.y - from.y * to.x > 0;
}

/** Clockwise degrees from 12 o'clock of a screen vector (pixels, y down): 0 up, +90 right, 180 down, -90 left. */
export function clockAngleDegrees(vector: { x: number; y: number }): number {
  return (Math.atan2(vector.x, -vector.y) * 180) / Math.PI;
}
