import { describe, expect, it } from "vitest";
import {
  cameraPresentationResponse,
  shouldStabilizeCameraHorizon,
  smoothCameraVectorToRef,
} from "../src/render/cameraPresentation";

describe("camera presentation", () => {
  it("stabilizes exterior views while preserving cockpit roll", () => {
    expect(shouldStabilizeCameraHorizon("chase", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cinematic", true)).toBe(true);
    expect(shouldStabilizeCameraHorizon("cockpit", true)).toBe(false);
  });

  it("retains aircraft roll when stabilization is disabled", () => {
    expect(shouldStabilizeCameraHorizon("chase", false)).toBe(false);
    expect(shouldStabilizeCameraHorizon("cinematic", false)).toBe(false);
  });

  it("67b: bounds exterior target and up deltas with one rig response", () => {
    const current = { x: 0, y: 0, z: 0 };
    const desired = { x: 12, y: 3, z: -6 };
    const currentUp = { x: 0, y: 1, z: 0 };
    const desiredUp = { x: 0.5, y: Math.SQRT1_2, z: -0.5 };
    const response = cameraPresentationResponse("chase", false, 1 / 60, false);
    const targetDeltas: number[] = [];
    const upDeltas: number[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const before = { ...current };
      const beforeUp = { ...currentUp };
      smoothCameraVectorToRef(current, desired, response, current);
      smoothCameraVectorToRef(currentUp, desiredUp, response, currentUp);
      targetDeltas.push(Math.hypot(
        current.x - before.x,
        current.y - before.y,
        current.z - before.z,
      ));
      upDeltas.push(Math.hypot(
        currentUp.x - beforeUp.x,
        currentUp.y - beforeUp.y,
        currentUp.z - beforeUp.z,
      ));
    }

    expect(response).toBeGreaterThan(0);
    expect(response).toBeLessThan(1);
    expect(targetDeltas[0]).toBeLessThan(Math.hypot(12, 3, -6));
    expect(upDeltas[0]).toBeLessThan(Math.hypot(0.5, Math.SQRT1_2 - 1, -0.5));
    for (let index = 1; index < targetDeltas.length; index += 1) {
      expect(targetDeltas[index]!).toBeLessThan(targetDeltas[index - 1]!);
      expect(upDeltas[index]!).toBeLessThan(upDeltas[index - 1]!);
    }
  });

  it("67b: keeps cockpit exact and snaps every rig vector on a camera cut", () => {
    expect(cameraPresentationResponse("cockpit", false, 1 / 60, false)).toBe(1);
    expect(cameraPresentationResponse("chase", true, 1 / 60, false)).toBe(1);
    const current = { x: 1, y: 2, z: 3 };
    const desired = { x: -4, y: 5, z: 8 };
    smoothCameraVectorToRef(current, desired, 1, current);
    expect(current).toEqual(desired);
  });
});
