import { describe, expect, it } from "vitest";
import {
  BATHYMETRY_CENTER_SNAP,
  BATHYMETRY_MAX_DEPTH,
  BATHYMETRY_RESOLUTION,
  BATHYMETRY_SPAN,
  BATHYMETRY_STREAM_UPDATE_INTERVAL_MS,
  BathymetryField,
  decodeBathymetryDepth,
  encodeBathymetryDepth,
  snapBathymetryCenter,
} from "../src/render/BathymetryField";

describe("bounded terrain bathymetry", () => {
  it("uses a half-texel-correct lattice and linear sub-metre depth encoding", () => {
    expect(BATHYMETRY_SPAN / BATHYMETRY_RESOLUTION).toBe(64);
    expect(BATHYMETRY_CENTER_SNAP / (BATHYMETRY_SPAN / BATHYMETRY_RESOLUTION)).toBe(8);
    expect(BATHYMETRY_RESOLUTION ** 2).toBe(36_864);
    expect(snapBathymetryCenter(767)).toBe(512);
    expect(snapBathymetryCenter(769)).toBe(1_024);
    expect(Object.is(snapBathymetryCenter(-100), -0)).toBe(false);
    for (const depth of [0, 0.8, 4, 27, 96, BATHYMETRY_MAX_DEPTH]) {
      const decoded = decodeBathymetryDepth(encodeBathymetryDepth(depth));
      expect(Math.abs(decoded - depth)).toBeLessThanOrEqual(
        BATHYMETRY_MAX_DEPTH / 255 + 1e-9,
      );
    }
    expect(encodeBathymetryDepth(-10)).toBe(0);
    expect(encodeBathymetryDepth(BATHYMETRY_MAX_DEPTH * 2)).toBe(255);
  });

  it("updates only on snapped movement or throttled source revisions", () => {
    const field = new BathymetryField(0.14);
    let samples = 0;
    const sampleHeight = (x: number, z: number) => {
      samples += 1;
      return -Math.min(BATHYMETRY_MAX_DEPTH, 4 + Math.hypot(x, z) * 0.01);
    };
    expect(field.update(
      { worldX: 100, worldZ: -100, sourceRevision: 1, nowMs: 0 },
      sampleHeight,
    )).toBe(true);
    expect(samples).toBe(BATHYMETRY_RESOLUTION ** 2);
    expect(field.bounds.toArray()).toEqual([-6_144, -6_144, 6_144, 6_144]);
    expect(field.getDiagnostics()).toMatchObject({
      updates: 1,
      samplesPerUpdate: 36_864,
      textureBytes: 36_864,
      centerX: 0,
      centerZ: 0,
      sourceRevision: 1,
      valid: true,
    });

    expect(field.update(
      { worldX: 100, worldZ: -100, sourceRevision: 1, nowMs: 16 },
      sampleHeight,
    )).toBe(false);
    expect(samples).toBe(36_864);
    expect(field.update(
      { worldX: 100, worldZ: -100, sourceRevision: 2, nowMs: 200 },
      sampleHeight,
    )).toBe(false);
    expect(samples).toBe(36_864);

    // The revision is consumed after the minimum interval, but an identical encoded
    // snapshot does not cause another texture upload/revision.
    expect(field.update(
      {
        worldX: 100,
        worldZ: -100,
        sourceRevision: 2,
        nowMs: BATHYMETRY_STREAM_UPDATE_INTERVAL_MS + 1,
      },
      sampleHeight,
    )).toBe(false);
    expect(samples).toBe(73_728);
    expect(field.getDiagnostics().updates).toBe(1);
    expect(field.getDiagnostics().sourceRevision).toBe(2);

    // Coarse camera movement updates immediately and shifts by exactly eight
    // texels, independent of the streaming throttle.
    expect(field.update(
      { worldX: 600, worldZ: -100, sourceRevision: 2, nowMs: 702 },
      sampleHeight,
    )).toBe(true);
    expect(field.bounds.toArray()).toEqual([-5_632, -6_144, 6_656, 6_144]);
    expect(field.getDiagnostics().centerX).toBe(512);
    expect(field.getRevision()).toBe(2);
    field.dispose();
    expect(field.isValid()).toBe(false);
  });

  it("uses deterministic saturated-deep data for missing streamed coverage", () => {
    const field = new BathymetryField(0.14);
    expect(field.update(
      { worldX: 0, worldZ: 0, sourceRevision: 0, nowMs: 0 },
      () => undefined,
    )).toBe(true);
    const data = field.texture.image.data as Uint8Array;
    expect(data.byteLength).toBe(36_864);
    expect(data.every((value) => value === 255)).toBe(true);
    field.dispose();
  });
});
