import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { aircraftSpec, rampAtSpeed } from "../src/aircraft/catalogue";
import {
  CHASE_AIM_HEIGHT_METERS,
  COCKPIT_AIM_DISTANCE_METERS,
  PERF_COCKPIT_RIG,
  cameraBankFollow,
  cameraPresentationResponse,
  cameraRigLiftToRef,
  cameraTrailMeters,
  chaseRigHeightForBank,
  chaseRigOffsetsToRef,
  cockpitEyeForwardUpMetres,
  cockpitEyeRightMeters,
  cockpitFieldOfViewDegrees,
  cockpitRigPositionsToRef,
  orthogonalizeCameraUpToRef,
  smoothCameraVectorToRef,
} from "../src/render/cameraPresentation";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { CAMERA_FAR_PLANE_METERS } from "../src/render/webgpu/core/QualityProfile";
import {
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
  orientationFromYawPitchBank,
  type PerfCaptureShotDefinition,
} from "../scripts/perf-capture.mts";
import { wildlifeShotCamera } from "../scripts/wildlifeShotCamera.mts";

/**
 * The wildlife probe's camera (`scripts/wildlifeShotCamera.mts`) is the camera
 * the perf harness captures through.
 *
 * The reference below is FlightRenderer.updateCamera run frame by frame, as the
 * harness drives it: the renderer's cold-start camera (built as its constructor
 * builds it), the shot's last moving frames on a motion shot, then the held
 * frames before the capture, with the response smoothing, the observed ground
 * speed and the chase trail it feeds all live. The probe asserts none of that:
 * it builds the rig at rest in one step. Agreement to 0.1 px on the trainer's
 * own vertices, wings level AND in the 45 and 60 degree banks, is what makes
 * its predicted positions worth checking a capture against.
 *
 * The CONTROL is the probe's old hand-built chase camera, kept below verbatim.
 * It is exact wings level at zero pitch -- so the check is not merely loose --
 * and put the banked shots' points 118-157 px from where the render drew them
 * (docs/findings/WILDLIFE_CAPTURE_PIN_2026_09_22.md).
 */

const DEG = Math.PI / 180;
const TOLERANCE_PX = 0.1;
/** Held frames before the capture: a static shot's 150 settle + 4 drain, a motion shot's 600 drain. */
const STATIC_HELD_FRAMES = 154;
const MOTION_MOVING_FRAMES = 60;
const MOTION_HELD_FRAMES = 600;
/** Near the origin, where the renderer's floating origin keeps the camera. */
const AIRCRAFT = { x: 41, y: 152, z: -23 } as const;
const YAW_DEGREES = 37;

type V = { x: number; y: number; z: number };
interface Frame { position: V; orientation: Quaternion; airspeed: number }
interface Case {
  readonly shot: PerfCaptureShotDefinition;
  readonly bankDegrees: number;
  readonly terrainHeight: (x: number, z: number) => number;
}

const shot = (name: string) => {
  const found = PERF_CAPTURE_SHOTS.find((s) => s.name === name);
  if (!found) throw new Error(`no shot ${name}`);
  return found;
};
const flat = () => -1_000;
const risingAhead = (x: number, z: number) => {
  const h = headingVectorFromYaw(YAW_DEGREES);
  return AIRCRAFT.y + 2 + 0.2 * ((x - AIRCRAFT.x) * h.x + (z - AIRCRAFT.z) * h.z);
};
const size = (s: PerfCaptureShotDefinition) => ({
  width: s.viewportWidth ?? PERF_CAPTURE_WIDTH,
  height: s.viewportHeight ?? PERF_CAPTURE_HEIGHT,
});

/** The frames the harness renders up to and including the captured one, for this case. */
function framesFor(c: Case): Frame[] {
  const orientation = (yaw: number) => {
    const q = orientationFromYawPitchBank(yaw, c.shot.pitchDownDegrees, c.bankDegrees);
    return new Quaternion(q.x, q.y, q.z, q.w);
  };
  const speed = c.shot.airspeedMetersPerSecond;
  const held = (): Frame => ({ position: { ...AIRCRAFT }, orientation: orientation(YAW_DEGREES), airspeed: speed });
  if (c.shot.kind !== "motion") return Array.from({ length: STATIC_HELD_FRAMES + 1 }, held);
  // Fly the coordinated turn backwards from the final pose, then forwards into it.
  const turnDegreesPerFrame = ((9.81 * Math.tan(c.bankDegrees * DEG)) / Math.max(20, speed)) / DEG / 60;
  const frames: Frame[] = [];
  let x = AIRCRAFT.x, z = AIRCRAFT.z, yaw = YAW_DEGREES;
  for (let f = 0; f < MOTION_MOVING_FRAMES; f += 1) {
    frames.unshift({ position: { x, y: AIRCRAFT.y, z }, orientation: orientation(yaw), airspeed: speed });
    const h = headingVectorFromYaw(yaw);
    x -= (speed * h.x) / 60;
    z -= (speed * h.z) / 60;
    yaw -= turnDegreesPerFrame;
  }
  for (let f = 0; f < MOTION_HELD_FRAMES + 1; f += 1) frames.push(held());
  return frames;
}

/**
 * FlightRenderer's camera after `frames`: its constructor's camera, then
 * updatePresentation's body frame and updateCamera's chase or cockpit branch,
 * smoothing and all, every frame at 1/60 s.
 */
function rendererCamera(c: Case, scene: Scene): UniversalCamera {
  const mode = c.shot.cameraMode;
  const camera = new UniversalCamera("flight-camera", new Vector3(0, 8, -18), scene);
  camera.minZ = 0.08;
  camera.maxZ = CAMERA_FAR_PLANE_METERS;
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.fov = (62 * Math.PI) / 180;
  camera.inertia = 0;
  camera.inputs.clear();
  scene.activeCamera = camera;
  const bodyMatrix = new Matrix();
  const forward = Vector3.Right(), up = Vector3.Up(), lift = Vector3.Zero();
  const desiredCamera = Vector3.Zero(), desiredTarget = Vector3.Zero();
  const cameraOffset = Vector3.Zero(), cameraTargetOffset = Vector3.Zero(), cameraTarget = Vector3.Zero();
  const desiredUp = Vector3.Up(), viewDirection = Vector3.Right();
  const previous = Vector3.Zero();
  let previousValid = false, observedGroundSpeed = 0, cameraCut = true;
  for (const frame of framesFor(c)) {
    Matrix.FromQuaternionToRef(frame.orientation.clone().normalize(), bodyMatrix);
    Vector3.TransformNormalToRef(Vector3.Right(), bodyMatrix, forward);
    Vector3.TransformNormalToRef(Vector3.Up(), bodyMatrix, up);
    forward.normalize();
    up.normalize();
    const aircraft = new Vector3(frame.position.x, frame.position.y, frame.position.z);
    cameraRigLiftToRef(forward, up, cameraBankFollow(mode, false), lift);
    if (previousValid) observedGroundSpeed = Vector3.Distance(aircraft, previous) / (1 / 60);
    previous.copyFrom(aircraft);
    previousValid = true;
    let fieldOfView: number;
    if (mode === "cockpit") {
      const eye = aircraftSpec("trainer").cockpitEye;
      cockpitRigPositionsToRef(aircraft, forward, up, cockpitEyeForwardUpMetres(eye, PERF_COCKPIT_RIG),
        cockpitEyeRightMeters(eye, PERF_COCKPIT_RIG), COCKPIT_AIM_DISTANCE_METERS, desiredCamera, desiredTarget);
      fieldOfView = cockpitFieldOfViewDegrees(PERF_COCKPIT_RIG);
    } else {
      const profile = chaseCameraProfile("trainer", frame.airspeed);
      chaseRigOffsetsToRef(forward, lift, profile.distance, chaseRigHeightForBank(profile.height, forward, up),
        profile.aimAhead, CHASE_AIM_HEIGHT_METERS, cameraTrailMeters(mode, false, observedGroundSpeed),
        desiredCamera, desiredTarget);
      desiredCamera.addInPlace(aircraft);
      const ahead = Math.min(120, frame.airspeed * 0.35);
      const ground = Math.max(c.terrainHeight(desiredCamera.x, desiredCamera.z),
        c.terrainHeight(desiredCamera.x + forward.x * ahead, desiredCamera.z + forward.z * ahead));
      if (desiredCamera.y < ground + 2.5) desiredCamera.y = ground + 2.5;
      desiredTarget.addInPlace(aircraft);
      fieldOfView = profile.fieldOfView;
    }
    const response = cameraPresentationResponse(mode, cameraCut, 1 / 60, false);
    cameraCut = false;
    desiredCamera.subtractInPlace(aircraft);
    desiredTarget.subtractInPlace(aircraft);
    smoothCameraVectorToRef(cameraOffset, desiredCamera, response, cameraOffset);
    smoothCameraVectorToRef(cameraTargetOffset, desiredTarget, response, cameraTargetOffset);
    camera.position.copyFrom(aircraft).addInPlace(cameraOffset);
    cameraTarget.copyFrom(aircraft).addInPlace(cameraTargetOffset);
    Vector3.LerpToRef(Vector3.UpReadOnly, up, cameraBankFollow(mode, false), desiredUp);
    desiredUp.normalize();
    smoothCameraVectorToRef(camera.upVector, desiredUp, response, camera.upVector);
    cameraTarget.subtractToRef(camera.position, viewDirection);
    orthogonalizeCameraUpToRef(camera.upVector, viewDirection, up, camera.upVector);
    camera.setTarget(cameraTarget);
    camera.fov += ((fieldOfView * Math.PI) / 180 - camera.fov) * response;
  }
  return camera;
}

/** The probe's chase camera before this change, verbatim in effect: the failing control. */
function handBuiltChaseCamera(c: Case) {
  const { width, height } = size(c.shot);
  const chase = aircraftSpec("trainer").chase;
  const speed = c.shot.airspeedMetersPerSecond;
  const distance = rampAtSpeed(chase.distance, speed), aimAhead = rampAtSpeed(chase.aimAhead, speed);
  const hfov = rampAtSpeed(chase.fieldOfView, speed) * DEG, vfov = 2 * Math.atan(Math.tan(hfov / 2) * (height / width));
  const h = headingVectorFromYaw(YAW_DEGREES), pitch = c.shot.pitchDownDegrees * DEG;
  const forward = new Vector3(h.x * Math.cos(pitch), -Math.sin(pitch), h.z * Math.cos(pitch)).normalize();
  const aircraft = new Vector3(AIRCRAFT.x, AIRCRAFT.y, AIRCRAFT.z);
  const eye = aircraft.subtract(forward.scale(distance)).add(new Vector3(0, chase.height, 0));
  const look = aircraft.add(forward.scale(aimAhead)).add(new Vector3(0, CHASE_AIM_HEIGHT_METERS, 0)).subtract(eye).normalize();
  const roll = c.bankDegrees * cameraBankFollow("chase", false) * DEG;
  const level = Vector3.Cross(look, Vector3.Up()).normalize();
  const upLevel = Vector3.Cross(level, look);
  const right = level.scale(Math.cos(roll)).add(upLevel.scale(Math.sin(roll)));
  const camUp = Vector3.Cross(right, look);
  return (p: Vector3) => {
    const d = p.subtract(eye), depth = Vector3.Dot(d, look);
    return {
      x: (width / 2) * (1 + Vector3.Dot(d, right) / depth / Math.tan(hfov / 2)),
      y: (height / 2) * (1 - Vector3.Dot(d, camUp) / depth / Math.tan(vfov / 2)),
    };
  };
}

/** The trainer at the capture pose, as world-space vertices, plus a far grid for the cockpit's forward view. */
function samplePoints(c: Case, scene: Scene, reference: UniversalCamera): Vector3[] {
  const points: Vector3[] = [];
  const aircraft = createWebGpuAircraft(scene, "trainer");
  aircraft.root.position.set(AIRCRAFT.x, AIRCRAFT.y, AIRCRAFT.z);
  const q = orientationFromYawPitchBank(YAW_DEGREES, c.shot.pitchDownDegrees, c.bankDegrees);
  aircraft.root.rotationQuaternion = new Quaternion(q.x, q.y, q.z, q.w).normalize();
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) {
    mesh.computeWorldMatrix(true);
    const local = mesh.isEnabled() && mesh.isVisible ? mesh.getVerticesData(VertexBuffer.PositionKind) : null;
    if (!local) continue;
    const world = mesh.getWorldMatrix();
    for (let i = 0; i + 2 < local.length; i += 3) {
      points.push(Vector3.TransformCoordinates(new Vector3(local[i]!, local[i + 1]!, local[i + 2]!), world));
    }
  }
  // Points 60 m to 2 km out across the reference view, where the birds are.
  const view = reference.getTarget().subtract(reference.position).normalize();
  const right = Vector3.Cross(view, reference.upVector).normalize();
  const upward = Vector3.Cross(right, view);
  for (const range of [60, 400, 2_000]) {
    for (let a = -0.5; a <= 0.5; a += 0.125) {
      for (let b = -0.3; b <= 0.3; b += 0.1) {
        points.push(reference.position.add(view.add(right.scale(a)).add(upward.scale(b)).normalize().scale(range)));
      }
    }
  }
  return points;
}

function measure(c: Case) {
  const { width, height } = size(c.shot);
  const engine = new NullEngine({
    renderWidth: width, renderHeight: height, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const reference = rendererCamera(c, scene);
  const viewProjection = reference.getViewMatrix(true).multiply(reference.getProjectionMatrix(true));
  const viewport = reference.viewport.toGlobal(width, height);
  const probe = wildlifeShotCamera({
    cameraMode: c.shot.cameraMode,
    aircraft: AIRCRAFT,
    yawDegrees: YAW_DEGREES,
    pitchDownDegrees: c.shot.pitchDownDegrees,
    bankDegrees: c.bankDegrees,
    airspeedMetersPerSecond: c.shot.airspeedMetersPerSecond,
    width,
    height,
    terrainHeight: c.terrainHeight,
  });
  const old = handBuiltChaseCamera(c);
  const view = reference.getTarget().subtract(reference.position).normalize();
  let compared = 0, worst = 0, oldSum = 0;
  for (const point of samplePoints(c, scene, reference)) {
    if (Vector3.Dot(point.subtract(reference.position), view) <= 1) continue;
    const expected = Vector3.Project(point, Matrix.Identity(), viewProjection, viewport);
    if (expected.x < 0 || expected.x > width || expected.y < 0 || expected.y > height) continue;
    const got = probe.project(point);
    expect(got, `${c.shot.name}: a point the renderer draws at (${expected.x.toFixed(1)}, ${expected.y.toFixed(1)}) is behind the probe's eye`).not.toBeNull();
    worst = Math.max(worst, Math.hypot(got!.x - expected.x, got!.y - expected.y));
    const was = old(point);
    oldSum += Math.hypot(was.x - expected.x, was.y - expected.y);
    compared += 1;
  }
  probe.dispose();
  scene.dispose();
  engine.dispose();
  return { compared, worst, oldMean: oldSum / Math.max(1, compared) };
}

describe("the wildlife probe's shot camera is the renderer's", () => {
  const cases: (Case & { why: string; oldMissesBy?: number })[] = [
    { shot: shot("approach-500ft"), bankDegrees: 0, terrainHeight: flat, why: "wings level at zero pitch" },
    { shot: shot("motion-banked-turn"), bankDegrees: 45, terrainHeight: flat, why: "in the 45 degree bank", oldMissesBy: 30 },
    { shot: shot("page-thrash-turn"), bankDegrees: 60, terrainHeight: flat, why: "in the 60 degree bank", oldMissesBy: 45 },
    { shot: shot("cdlod-transition"), bankDegrees: 0, terrainHeight: flat, why: "pitched 12 degrees down", oldMissesBy: 10 },
    // The ground clamp, engaged by its LOOK-AHEAD sample alone: ground rising 1 in 5 along the nose sits
    // 0.8 m below the aircraft under the camera, and 3.5 m above it where the camera will be in 0.35 s.
    { shot: shot("approach-500ft"), bankDegrees: 0, terrainHeight: risingAhead, why: "ground-clamped by the look-ahead", oldMissesBy: 20 },
    { shot: shot("high-10000ft-down"), bankDegrees: 0, terrainHeight: flat, why: "in the perf cockpit rig, 45 degrees down" },
  ];
  for (const c of cases) {
    it(`${c.shot.name}: ${c.why}, to ${TOLERANCE_PX} px`, () => {
      expect(c.shot.cameraMode).toBe(c.why.includes("cockpit") ? "cockpit" : "chase");
      if (c.bankDegrees !== 0) expect(c.shot.bankDegrees).toBe(c.bankDegrees);
      const { compared, worst, oldMean } = measure(c);
      expect(compared, `${c.shot.name}: too few points in frame to mean anything`).toBeGreaterThan(40);
      expect(worst, `${c.shot.name}: worst ${worst.toFixed(3)} px over ${compared} points`).toBeLessThanOrEqual(TOLERANCE_PX);
      // CONTROL: the old hand-built camera. Exact where it was exact, and it
      // must miss where it missed, or this comparison could not see the defect.
      if (c.shot.cameraMode === "chase") {
        if (c.oldMissesBy === undefined) expect(oldMean).toBeLessThanOrEqual(TOLERANCE_PX);
        else expect(oldMean, `${c.shot.name}: the old camera's mean miss`).toBeGreaterThan(c.oldMissesBy);
      }
    });
  }

  it("projects the same pixels 15 km from the origin: it works around the aircraft, not in float32 world space", () => {
    const pose = {
      cameraMode: "chase" as const, yawDegrees: YAW_DEGREES, pitchDownDegrees: 0, bankDegrees: 60,
      airspeedMetersPerSecond: 78, width: PERF_CAPTURE_WIDTH, height: PERF_CAPTURE_HEIGHT, terrainHeight: flat,
    };
    const near = wildlifeShotCamera({ ...pose, aircraft: AIRCRAFT });
    const shift = { x: 12_000, y: 0, z: -9_000 };
    const far = wildlifeShotCamera({ ...pose, aircraft: { x: AIRCRAFT.x + shift.x, y: AIRCRAFT.y, z: AIRCRAFT.z + shift.z } });
    let worst = 0;
    for (const offset of [[-3, 0.5, 4], [2, -1, -5], [900, -140, 300], [40, -20, 60]]) {
      const p = { x: AIRCRAFT.x + offset[0]!, y: AIRCRAFT.y + offset[1]!, z: AIRCRAFT.z + offset[2]! };
      const a = near.project(p), b = far.project({ x: p.x + shift.x, y: p.y, z: p.z + shift.z });
      if (!a || !b) continue;
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    near.dispose();
    far.dispose();
    expect(worst).toBeLessThanOrEqual(0.01);
  });
});
