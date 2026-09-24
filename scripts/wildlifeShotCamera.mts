/**
 * The camera a perf shot is captured through, rebuilt in Node for the wildlife
 * probe (`scripts/wildlife-shot-birds.mts`).
 *
 * It is `FlightRenderer.updateCamera` at rest, composed from the renderer's own
 * pure rig functions and projected through a Babylon `UniversalCamera` set up as
 * the renderer sets up its own (right-handed scene, horizontal-fixed lens, the
 * same near and far planes). At rest is exact for a capture: the harness holds
 * the final pose for 150 settle frames (a static shot) or 600 drain frames (a
 * motion shot) before the one it reads, so every smoothed term has reached its
 * target, and the drain's held pose makes the observed ground speed, and with
 * it the chase trail, exactly 0.
 *
 * WHY NOT A HAND-BUILT CAMERA. The probe had one (eye `distance` behind and
 * `height` above along world up, the frame rolled by hand by `bank x 0.18`). It
 * is exact wings level at zero pitch and wrong everywhere else: it rolled the
 * banked shots the wrong way (+8.0 and +10.7 degrees where the renderer rolls
 * -7.65 and -9.72), kept the full 5.1 m height the renderer drops to 3.40 and
 * 2.55 m in a bank (`CHASE_BANK_HEIGHT_DROP`), and lifted along world up
 * instead of the blended lift, which is also its whole error at pitch. It put
 * points 700 m out 118 px (45 degrees) and 157 px (60) from where the render
 * draws them, 6-8 px at pitch 12-14, and it put `page-thrash-turn`'s three boar
 * 55 px from the change they made in the capture.
 *
 * Built AROUND THE AIRCRAFT. Babylon's matrices are float32, so a camera placed
 * at world coordinates 15 km from the origin loses about a millimetre of
 * translation, which is 0.07 px on an airframe 14 m away. The renderer avoids it
 * with its floating origin; this avoids it by projecting `position - aircraft`.
 */
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "../src/aircraft/catalogue";
import {
  CHASE_AIM_HEIGHT_METERS,
  COCKPIT_AIM_DISTANCE_METERS,
  PERF_COCKPIT_RIG,
  cameraBankFollow,
  cameraRigLiftToRef,
  cameraTrailMeters,
  chaseRigHeightForBank,
  chaseRigOffsetsToRef,
  cockpitEyeForwardUpMetres,
  cockpitEyeRightMeters,
  cockpitFieldOfViewDegrees,
  cockpitRigPositionsToRef,
  orthogonalizeCameraUpToRef,
} from "../src/render/cameraPresentation";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { CAMERA_FAR_PLANE_METERS } from "../src/render/webgpu/core/QualityProfile";
import { orientationFromYawPitchBank } from "./perf-capture.mts";

type V = { readonly x: number; readonly y: number; readonly z: number };

export interface ShotCameraPose {
  readonly cameraMode: "chase" | "cockpit";
  /** The aircraft's world position at capture. */
  readonly aircraft: V;
  readonly yawDegrees: number;
  readonly pitchDownDegrees: number;
  readonly bankDegrees: number;
  readonly airspeedMetersPerSecond: number;
  readonly width: number;
  readonly height: number;
  /** The renderer's camera terrain sample (`sampleTerrain(world, x, z).height`), for the chase ground clamp. */
  readonly terrainHeight: (x: number, z: number) => number;
}

export interface ShotProjection {
  /** Pixel position, unrounded, origin top left. */
  readonly x: number;
  readonly y: number;
  /** |NDC| across and down: in frame when both are at most 1. */
  readonly ax: number;
  readonly ay: number;
  /** Metres along the view axis, and straight-line metres from the eye. */
  readonly depth: number;
  readonly distance: number;
}

export interface ShotCamera {
  /** World position of the eye. */
  readonly eye: V;
  readonly horizontalFovRadians: number;
  readonly pixelsPerRadian: number;
  /** Null for a point less than 1 m in front of the eye. */
  project(position: V): ShotProjection | null;
  dispose(): void;
}

/** The capture camera for a pose: FlightRenderer.updateCamera's chase or cockpit rig, at rest. */
export function wildlifeShotCamera(pose: ShotCameraPose): ShotCamera {
  const { aircraft, width, height } = pose;
  // The body frame exactly as updatePresentation derives it from the state's quaternion.
  const q = orientationFromYawPitchBank(pose.yawDegrees, pose.pitchDownDegrees, pose.bankDegrees);
  const body = new Matrix();
  Matrix.FromQuaternionToRef(new Quaternion(q.x, q.y, q.z, q.w).normalize(), body);
  const forward = Vector3.TransformNormal(Vector3.Right(), body).normalize();
  const up = Vector3.TransformNormal(Vector3.Up(), body).normalize();

  // Offsets from the aircraft, as updateCamera builds them.
  const eye = Vector3.Zero();
  const target = Vector3.Zero();
  let fieldOfViewDegrees: number;
  if (pose.cameraMode === "cockpit") {
    const spec = aircraftSpec("trainer").cockpitEye;
    cockpitRigPositionsToRef(
      Vector3.ZeroReadOnly, forward, up,
      cockpitEyeForwardUpMetres(spec, PERF_COCKPIT_RIG),
      cockpitEyeRightMeters(spec, PERF_COCKPIT_RIG),
      COCKPIT_AIM_DISTANCE_METERS, eye, target,
    );
    fieldOfViewDegrees = cockpitFieldOfViewDegrees(PERF_COCKPIT_RIG);
  } else {
    const profile = chaseCameraProfile("trainer", pose.airspeedMetersPerSecond);
    const lift = Vector3.Zero();
    cameraRigLiftToRef(forward, up, cameraBankFollow("chase", false), lift);
    chaseRigOffsetsToRef(
      forward, lift, profile.distance,
      chaseRigHeightForBank(profile.height, forward, up),
      profile.aimAhead, CHASE_AIM_HEIGHT_METERS,
      cameraTrailMeters("chase", false, 0),
      eye, target,
    );
    // The ground clamp, on the higher of the terrain under the camera and ~0.35 s ahead.
    const worldX = aircraft.x + eye.x;
    const worldZ = aircraft.z + eye.z;
    const ahead = Math.min(120, pose.airspeedMetersPerSecond * 0.35);
    const ground = Math.max(
      pose.terrainHeight(worldX, worldZ),
      pose.terrainHeight(worldX + forward.x * ahead, worldZ + forward.z * ahead),
    );
    if (aircraft.y + eye.y < ground + 2.5) eye.y = ground + 2.5 - aircraft.y;
    fieldOfViewDegrees = profile.fieldOfView;
  }
  // The camera's up: world up blended toward the aircraft's by the bank follow,
  // then made orthogonal to the view (the smoothing's fixed point).
  const view = target.subtract(eye);
  const cameraUp = Vector3.Zero();
  orthogonalizeCameraUpToRef(
    Vector3.Lerp(Vector3.Up(), up, cameraBankFollow(pose.cameraMode, false)).normalize(),
    view, up, cameraUp,
  );

  const engine = new NullEngine({
    renderWidth: width, renderHeight: height, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("wildlife-shot-camera", eye.clone(), scene);
  camera.minZ = 0.08;
  camera.maxZ = CAMERA_FAR_PLANE_METERS;
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.fov = (fieldOfViewDegrees * Math.PI) / 180;
  camera.upVector.copyFrom(cameraUp);
  camera.setTarget(target);
  scene.activeCamera = camera;
  const viewProjection = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
  const viewport = camera.viewport.toGlobal(width, height);
  const viewDirection = view.normalizeToNew();
  const local = new Vector3();
  const projected = new Vector3();

  return {
    eye: { x: aircraft.x + eye.x, y: aircraft.y + eye.y, z: aircraft.z + eye.z },
    horizontalFovRadians: camera.fov,
    pixelsPerRadian: width / (2 * Math.tan(camera.fov / 2)),
    project(position) {
      local.set(position.x - aircraft.x, position.y - aircraft.y, position.z - aircraft.z);
      const depth = Vector3.Dot(local.subtract(eye), viewDirection);
      if (depth <= 1) return null;
      Vector3.ProjectToRef(local, Matrix.IdentityReadOnly, viewProjection, viewport, projected);
      return {
        x: projected.x,
        y: projected.y,
        ax: Math.abs((2 * projected.x) / width - 1),
        ay: Math.abs(1 - (2 * projected.y) / height),
        depth,
        distance: Vector3.Distance(local, eye),
      };
    },
    dispose() {
      scene.dispose();
      engine.dispose();
    },
  };
}
