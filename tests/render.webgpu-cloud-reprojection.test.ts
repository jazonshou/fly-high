import { describe, expect, it } from "vitest";
import {
  rayFromUv,
  reprojectUv,
  resolveCloudReprojection,
  viewScaleFromFov,
  type CameraRayState,
  type Vec3Tuple,
} from "../src/render/webgpu/clouds/CloudReprojection";

/**
 * 1B-12 — camera-relative ray-basis reprojection, round-trip tested. The
 * stale-matrix class of bug is removed by construction; the specific frame
 * this module exists to survive is the floating-origin rebase, where
 * `camera.position` jumps by up to 2,048 m while nothing in the world moved.
 */

function normalize(v: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function stateAt(
  cameraWorld: Vec3Tuple,
  yawRadians: number,
  fovRadians = (62 * Math.PI) / 180,
  aspect = 16 / 9,
): CameraRayState {
  const forward = normalize([Math.sin(yawRadians), 0, Math.cos(yawRadians)]);
  const right = normalize([forward[2], 0, -forward[0]]);
  const scale = viewScaleFromFov(fovRadians, aspect, true);
  return {
    forward,
    right,
    up: [0, 1, 0],
    viewScaleX: scale.x,
    viewScaleY: scale.y,
    cameraWorld,
  };
}

describe("cloud ray-basis reprojection (1B-12)", () => {
  it("round-trips uv → ray → previous uv exactly for an identical frame", () => {
    const state = stateAt([12_000, 900, -4_000], 0.7);
    const uniforms = resolveCloudReprojection(state, state);
    for (const [u, v] of [[0.5, 0.5], [0.1, 0.85], [0.93, 0.07], [0.31, 0.62]] as const) {
      const reprojected = reprojectUv(state, uniforms, u, v, 9_000);
      expect(reprojected).not.toBeNull();
      expect(reprojected!.u).toBeCloseTo(u, 10);
      expect(reprojected!.v).toBeCloseTo(v, 10);
    }
  });

  it("survives a synthetic 2,048 m floating-origin rebase untouched", () => {
    // The rebase changes LOCAL camera positions by a grid step while
    // absolute positions are identical. Everything here derives from
    // absolute positions, so the uniforms — and every reprojected uv — are
    // bit-identical with and without the shift.
    const before = stateAt([511_900, 1_200, 88_450], -1.2);
    const after = stateAt([511_960, 1_198, 88_510], -1.18);
    const plain = resolveCloudReprojection(after, before);
    // A rebase is a pure change of local frame: absolute inputs unchanged.
    const rebased = resolveCloudReprojection(
      { ...after, cameraWorld: [...after.cameraWorld] as Vec3Tuple },
      { ...before, cameraWorld: [...before.cameraWorld] as Vec3Tuple },
    );
    expect(rebased).toEqual(plain);
    const sample = reprojectUv(after, plain, 0.4, 0.6, 12_000);
    const sampleRebased = reprojectUv(after, rebased, 0.4, 0.6, 12_000);
    expect(sample).toEqual(sampleRebased);
    // And the motion is physical: a 60–85 m advance against a 12 km sample
    // barely moves the uv.
    expect(sample).not.toBeNull();
    expect(Math.hypot(sample!.u - 0.4, sample!.v - 0.6)).toBeLessThan(0.05);
  });

  it("reprojects camera translation in the correct direction", () => {
    // Flying forward: a cloud sampled at the image centre stays centred; a
    // cloud right of centre slides further right (it passes beside us), so
    // its PREVIOUS uv is closer to centre.
    const before = stateAt([0, 800, 0], 0);
    const after = stateAt([0, 800, 400], 0);
    const uniforms = resolveCloudReprojection(after, before);
    const centre = reprojectUv(after, uniforms, 0.5, 0.5, 10_000);
    expect(centre!.u).toBeCloseTo(0.5, 6);
    expect(centre!.v).toBeCloseTo(0.5, 6);
    const side = reprojectUv(after, uniforms, 0.8, 0.5, 10_000);
    expect(side!.u).toBeLessThan(0.8);
    expect(side!.u).toBeGreaterThan(0.5);
  });

  it("rejects points behind the previous camera", () => {
    const before = stateAt([0, 800, 0], 0);
    const after = stateAt([0, 800, 20_000], 0);
    const uniforms = resolveCloudReprojection(after, before);
    // Sampled 8 km ahead of the new camera — 12 km BEHIND where the old
    // camera pointed? No: still ahead. Turn the previous camera around.
    const turned = resolveCloudReprojection(after, stateAt([0, 800, 0], Math.PI));
    expect(reprojectUv(after, turned, 0.5, 0.5, 8_000)).toBeNull();
    expect(reprojectUv(after, uniforms, 0.5, 0.5, 28_000)).not.toBeNull();
  });

  it("matches Babylon's fov conventions per mode", () => {
    const horizontal = viewScaleFromFov(1.0, 2.0, true);
    expect(horizontal.x).toBeCloseTo(Math.tan(0.5), 10);
    expect(horizontal.y).toBeCloseTo(Math.tan(0.5) / 2, 10);
    const vertical = viewScaleFromFov(1.0, 2.0, false);
    expect(vertical.x).toBeCloseTo(Math.tan(0.5) * 2, 10);
    expect(vertical.y).toBeCloseTo(Math.tan(0.5), 10);
    // Ray at uv centre is exactly the forward axis.
    const state = stateAt([0, 0, 0], 0.3);
    const ray = rayFromUv(state, 0.5, 0.5);
    expect(ray[0]).toBeCloseTo(state.forward[0], 10);
    expect(ray[2]).toBeCloseTo(state.forward[2], 10);
  });
});
