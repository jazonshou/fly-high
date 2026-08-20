import type { CameraMode } from "@/src/game/types";

export interface MutablePresentationVector {
  x: number;
  y: number;
  z: number;
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
  if (cameraCut || cameraMode === "cockpit") return 1;
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
