import type { CameraMode } from "@/src/game/types";

/** Cockpit view deliberately preserves aircraft roll; exterior stabilized views do not. */
export function shouldStabilizeCameraHorizon(
  cameraMode: CameraMode,
  stabilizedCamera: boolean,
): boolean {
  return stabilizedCamera && cameraMode !== "cockpit";
}
