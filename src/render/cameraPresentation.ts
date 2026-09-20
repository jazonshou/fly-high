import type { CameraMode } from "@/src/game/types";

export interface MutablePresentationVector {
  x: number;
  y: number;
  z: number;
}

/**
 * Exterior cameras follow only enough bank to communicate the turn. Cockpit
 * view remains physically attached to the aircraft; reduced motion keeps an
 * exterior horizon level.
 */
export function cameraBankFollow(cameraMode: CameraMode, reducedMotion: boolean): number {
  if (cameraMode === "cockpit") return 1;
  if (cameraMode === "freefly") return 0;
  if (reducedMotion) return 0;
  return cameraMode === "cinematic" ? 0.3 : 0.18;
}

/** Cockpit view deliberately preserves aircraft roll; exterior stabilized views do not. */
export function shouldStabilizeCameraHorizon(
  cameraMode: CameraMode,
  stabilizedCamera: boolean,
): boolean {
  return stabilizedCamera && cameraMode !== "cockpit";
}

/** One response governs exterior position, aim, up and FOV as a single camera rig. */
export function cameraPresentationResponse(
  cameraMode: CameraMode,
  cameraCut: boolean,
  deltaSeconds: number,
  reducedMotion: boolean,
): number {
  // Free-fly is a direct rig like cockpit: mouse-look must not lag.
  if (cameraCut || cameraMode === "cockpit" || cameraMode === "freefly") return 1;
  const delta = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
  return 1 - Math.exp(-delta * (reducedMotion ? 12 : 7));
}

/** Allocation-free vector smoothing, kept pure enough for the 67b jitter guard. */
export function smoothCameraVectorToRef(
  current: Readonly<MutablePresentationVector>,
  desired: Readonly<MutablePresentationVector>,
  response: number,
  result: MutablePresentationVector,
): void {
  const amount = Math.min(1, Math.max(0, Number.isFinite(response) ? response : 0));
  result.x = current.x + (desired.x - current.x) * amount;
  result.y = current.y + (desired.y - current.y) * amount;
  result.z = current.z + (desired.z - current.z) * amount;
}

/**
 * Project an up candidate onto the camera plane and normalize it in place.
 * Keeping up orthogonal to view prevents a changing look target from turning
 * a harmless bank response into camera roll/shear. Inputs may alias `result`.
 */
export function orthogonalizeCameraUpToRef(
  candidate: Readonly<MutablePresentationVector>,
  viewDirection: Readonly<MutablePresentationVector>,
  fallback: Readonly<MutablePresentationVector>,
  result: MutablePresentationVector,
): void {
  const vx = Number.isFinite(viewDirection.x) ? viewDirection.x : 0;
  const vy = Number.isFinite(viewDirection.y) ? viewDirection.y : 0;
  const vz = Number.isFinite(viewDirection.z) ? viewDirection.z : 0;
  const viewLengthSquared = vx * vx + vy * vy + vz * vz;
  let upX = Number.isFinite(candidate.x) ? candidate.x : 0;
  let upY = Number.isFinite(candidate.y) ? candidate.y : 0;
  let upZ = Number.isFinite(candidate.z) ? candidate.z : 0;

  if (viewLengthSquared > 1e-12) {
    let projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
    upX -= vx * projection;
    upY -= vy * projection;
    upZ -= vz * projection;
    if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
      upX = Number.isFinite(fallback.x) ? fallback.x : 0;
      upY = Number.isFinite(fallback.y) ? fallback.y : 0;
      upZ = Number.isFinite(fallback.z) ? fallback.z : 0;
      projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
      upX -= vx * projection;
      upY -= vy * projection;
      upZ -= vz * projection;
    }
    if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
      // Select the world axis least parallel to the view, then project it.
      const absX = Math.abs(vx);
      const absY = Math.abs(vy);
      const absZ = Math.abs(vz);
      upX = absX <= absY && absX <= absZ ? 1 : 0;
      upY = absY < absX && absY <= absZ ? 1 : 0;
      upZ = upX === 0 && upY === 0 ? 1 : 0;
      projection = (upX * vx + upY * vy + upZ * vz) / viewLengthSquared;
      upX -= vx * projection;
      upY -= vy * projection;
      upZ -= vz * projection;
    }
  } else if (upX * upX + upY * upY + upZ * upZ <= 1e-12) {
    upX = Number.isFinite(fallback.x) ? fallback.x : 0;
    upY = Number.isFinite(fallback.y) ? fallback.y : 1;
    upZ = Number.isFinite(fallback.z) ? fallback.z : 0;
  }

  let length = Math.hypot(upX, upY, upZ);
  if (!Number.isFinite(length) || length <= 1e-12) {
    upX = 0;
    upY = 1;
    upZ = 0;
    length = 1;
  }
  result.x = upX / length;
  result.y = upY / length;
  result.z = upZ / length;
}

/**
 * Time constant of the exterior position response, in seconds.
 *
 * `cameraPresentationResponse` is `1 - exp(-dt/tau)`; these are the taus it
 * uses. Exposed because the chase rig has to reason about the response's
 * steady-state error explicitly — see `cameraTrailMeters`.
 */
export const CAMERA_RESPONSE_SECONDS = 1 / 7;
export const CAMERA_RESPONSE_SECONDS_REDUCED_MOTION = 1 / 12;

/**
 * How far behind the aircraft the chase camera USED to settle, over and above
 * the distance its profile asks for.
 *
 * A first-order lag chasing a target that translates at constant speed does
 * not converge: it settles a fixed `speed * tau` behind it. The chase rig
 * smoothed an ABSOLUTE world position, so that error was real and large —
 * measured in-game at 20.6 m against a 13.5 m profile for the trainer (7.1 m
 * of it lag, predicted 52 * 1/7 = 7.4) and 30.3 m against 14.3 m for the jet
 * (16 m of lag, predicted 140 * 1/7 = 20).
 *
 * The rig now smooths the offset FROM the aircraft, which has no such error,
 * so this term is added back deliberately along the body axis to leave the
 * settled framing exactly where players already know it. Two things make the
 * deliberate version better than the accident it replaces:
 *
 *  - it lies along the aircraft's nose, not along its ground track, so a
 *    crosswind no longer pushes the airframe sideways out of frame; and
 *  - it is a distance, not a lag, so it no longer leaves a lateral residue
 *    for seconds after every turn.
 *
 * Reduced motion uses the faster response and therefore a shorter trail, as
 * it did before.
 */
export function cameraTrailMeters(
  cameraMode: CameraMode,
  reducedMotion: boolean,
  airspeed: number,
): number {
  if (cameraMode !== "chase" && cameraMode !== "cinematic") return 0;
  const speed = Number.isFinite(airspeed) ? Math.max(0, airspeed) : 0;
  return speed * (reducedMotion
    ? CAMERA_RESPONSE_SECONDS_REDUCED_MOTION
    : CAMERA_RESPONSE_SECONDS);
}

/**
 * The vertical reference an exterior rig should build its offsets on.
 *
 * `cameraBankFollow` says how much of the aircraft's BANK the view adopts, and
 * the camera's own up vector honours it. The rig's position and aim point did
 * not: they were raised along the aircraft's up at full strength while the
 * view rolled only 18% of the way there, so the two disagreed by 82% of the
 * bank. Because the aim point sits 1.25 m up the body axis and the camera
 * 5.1 m up it, the airframe hangs about 3.3 m below the view axis — and
 * rolling the frame under an off-axis object slides it sideways. Measured on
 * the shipped rig: 0.155% of frame width per degree of bank, leftward in a
 * right bank, on both airframes.
 *
 * Blending from `up0` — the up this aircraft would have at the same heading
 * and pitch with its wings level — rather than from world up keeps PITCH
 * following at full strength, so a wings-level frame is unchanged at any
 * pitch attitude and only the roll component is attenuated.
 */
export function cameraRigLiftToRef(
  forward: Readonly<MutablePresentationVector>,
  up: Readonly<MutablePresentationVector>,
  bankFollow: number,
  result: MutablePresentationVector,
): void {
  const follow = Math.min(1, Math.max(0, Number.isFinite(bankFollow) ? bankFollow : 1));
  // Horizontal starboard, h = forward x worldUp = (-fz, 0, fx). Degenerate
  // only when the nose points straight up or down, where "wings level" has no
  // meaning and the aircraft's own up is the best reference available.
  const horizontal = Math.hypot(forward.x, forward.z);
  if (!(horizontal > 1e-6)) {
    result.x = up.x;
    result.y = up.y;
    result.z = up.z;
    return;
  }
  const hx = -forward.z / horizontal;
  const hz = forward.x / horizontal;
  // up0 = h x forward. h has no y component, so this reduces to:
  let ux = -hz * forward.y;
  let uy = hz * forward.x - hx * forward.z;
  let uz = hx * forward.y;
  const length0 = Math.hypot(ux, uy, uz);
  if (!(length0 > 1e-12)) {
    result.x = up.x;
    result.y = up.y;
    result.z = up.z;
    return;
  }
  ux /= length0;
  uy /= length0;
  uz /= length0;
  let x = ux + (up.x - ux) * follow;
  let y = uy + (up.y - uy) * follow;
  let z = uz + (up.z - uz) * follow;
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-12)) {
    x = up.x;
    y = up.y;
    z = up.z;
  } else {
    x /= length;
    y /= length;
    z /= length;
  }
  result.x = x;
  result.y = y;
  result.z = z;
}
