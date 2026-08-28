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
