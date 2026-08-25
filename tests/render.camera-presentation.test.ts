import { describe, expect, it } from "vitest";
import {
  cameraBankFollow,
  cameraPresentationResponse,
  orthogonalizeCameraUpToRef,
  shouldStabilizeCameraHorizon,
  smoothCameraVectorToRef,
} from "../src/render/cameraPresentation";

describe("camera presentation", () => {
  it("restores restrained exterior bank while keeping cockpit physical", () => {
    expect(cameraBankFollow("chase", false)).toBe(0.18);
    expect(cameraBankFollow("cinematic", false)).toBe(0.3);
    expect(cameraBankFollow("chase", true)).toBe(0);
    expect(cameraBankFollow("cinematic", true)).toBe(0);
    expect(cameraBankFollow("cockpit", false)).toBe(1);
    expect(cameraBankFollow("cockpit", true)).toBe(1);
  });

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

  it("keeps camera up normalized and orthogonal to a changing view", () => {
    const up = { x: 0.2, y: 0.95, z: 0.4 };
    const view = { x: 4, y: 1, z: -7 };
    orthogonalizeCameraUpToRef(up, view, { x: 1, y: 0, z: 0 }, up);

    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
    expect(up.x * view.x + up.y * view.y + up.z * view.z).toBeCloseTo(0, 12);

    // Both preferred vectors may be parallel to the view during a degenerate
    // cut. The helper still chooses a deterministic perpendicular basis.
    const degenerate = { x: 0, y: 0, z: 3 };
    orthogonalizeCameraUpToRef(
      degenerate,
      { x: 0, y: 0, z: -5 },
      { x: 0, y: 0, z: 1 },
      degenerate,
    );
    expect(Math.hypot(degenerate.x, degenerate.y, degenerate.z)).toBeCloseTo(1, 12);
    expect(degenerate.z).toBeCloseTo(0, 12);
  });

  it("attenuates variable-delta aircraft-up noise in chase presentation", () => {
    const simulate = (bankFollow: number): number[] => {
      const current = { x: 0, y: 1, z: 0 };
      const view = { x: 0, y: 0, z: -1 };
      const rolls: number[] = [];
      let elapsed = 0;
      const deltas = [1 / 30, 1 / 120, 1 / 60, 1 / 90, 1 / 45, 1 / 120];
      for (let frame = 0; frame < 90; frame += 1) {
        const delta = deltas[frame % deltas.length]!;
        elapsed += delta;
        const physicalRoll = 0.38 * Math.sin(elapsed * 1.2) + (frame % 2 === 0 ? 0.018 : -0.018);
        const physicalUp = { x: Math.sin(physicalRoll), y: Math.cos(physicalRoll), z: 0 };
        const desired = {
          x: physicalUp.x * bankFollow,
          y: 1 + (physicalUp.y - 1) * bankFollow,
          z: 0,
        };
        const desiredLength = Math.hypot(desired.x, desired.y, desired.z);
        desired.x /= desiredLength;
        desired.y /= desiredLength;
        const response = cameraPresentationResponse("chase", false, delta, false);
        smoothCameraVectorToRef(current, desired, response, current);
        orthogonalizeCameraUpToRef(current, view, physicalUp, current);
        rolls.push(Math.atan2(current.x, current.y));
      }
      return rolls;
    };

    const chase = simulate(cameraBankFollow("chase", false));
    const fullPhysical = simulate(1);
    const highFrequencyEnergy = (values: number[]): number => {
      let energy = 0;
      for (let index = 2; index < values.length; index += 1) {
        energy += Math.abs(values[index]! - 2 * values[index - 1]! + values[index - 2]!);
      }
      return energy;
    };

    expect(Math.max(...chase.map(Math.abs))).toBeLessThan(0.08);
    expect(highFrequencyEnergy(chase)).toBeLessThan(highFrequencyEnergy(fullPhysical) * 0.25);
  });
});
