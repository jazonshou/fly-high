import { describe, expect, it } from "vitest";
import { CANOPY_CLOSURE_FILTER_WIDTH_METERS } from "@/src/render/webgpu/detail/densityField";
import {
  LAND_COVER_SPLAT_BAKE_WGSL,
  LAND_COVER_SUPERSAMPLE_EDGE,
  LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS,
} from "@/src/render/webgpu/terrain/LandCoverClassifier";
import { terrainChannelTexelSizeMeters } from "@/src/render/webgpu/terrain/TerrainSpineContract";

/**
 * The splat bake's canopy taps.
 *
 * From cruise height every forest-floor region had stair-stepped, axis-aligned
 * sides and single-texel rectangular holes: closure, the one input ForestFloor
 * is gated on, was sampled ONCE per channel texel while the classifier's other
 * inputs were supersampled 2x2. That is sound while the taps are closer
 * together than the closure channel's 60 m band limit, and unsound from a 64 m
 * texel up, where closure is a thresholded 260 / 130 m field sampled near its
 * own Nyquist. What is pinned is where the change may NOT reach: every level
 * the trees are planted from, and the closure lane at every level.
 */
describe("the splat bake gives coarse taps their own canopy", () => {
  it("is tied to the closure channel's band limit, not to a level", () => {
    expect(LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS).toBe(CANOPY_CLOSURE_FILTER_WIDTH_METERS);
    expect(LAND_COVER_SUPERSAMPLE_EDGE).toBe(2);
    // Levels 0-3 (4, 8, 16, 32 m texels): taps at most 16 m apart, inside the
    // band limit, so they keep the centre's canopy and stay bit-identical.
    for (const level of [0, 1, 2, 3]) {
      expect(terrainChannelTexelSizeMeters(level), `level ${level}`)
        .toBeLessThan(LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS);
    }
    // Level 4 up (64 m and coarser): taps 32 m or more apart.
    for (const level of [4, 5, 6]) {
      expect(terrainChannelTexelSizeMeters(level), `level ${level}`)
        .toBeGreaterThanOrEqual(LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS);
    }
  });

  it("hands fine texels the centre's canopy four times, which is what it did before", () => {
    const source = LAND_COVER_SPLAT_BAKE_WGSL;
    // The centre sample is taken first and unconditionally ...
    expect(source).toContain("let canopy = splatCanopy(job, localX, localZ);");
    // ... every tap starts as it, and only a coarse texel overwrites any.
    // (closure, grass, -1, 0): the -1 tells a fine tap to evaluate its own
    // moisture and climate, exactly as it did before.
    expect(source).toContain("let centreTap = vec4f(canopy, -1.0, 0.0);");
    expect(source).toContain(
      "var tapCanopy = array<vec4f, 4>(centreTap, centreTap, centreTap, centreTap);");
    expect(source).toContain(
      `if (job.shape.x >= ${LAND_COVER_TAP_CANOPY_MIN_TEXEL_METERS.toFixed(1)}) {`);
    expect([...source.matchAll(/tapCanopy\[tap\] = vec4f\(\s*splatCanopyAt\(/gu)]).toHaveLength(1);
    // The taps sit exactly where the classifier's own taps sit.
    expect(source).toContain("let step = job.shape.x * 0.25;");
    expect(source).toContain("let tapStep = job.shape.x * 0.25;");
    expect(source).toContain("let tapDx = select(-tapStep, tapStep, (tap & 1u) == 1u);");
    expect(source).toContain("let tapDz = select(-tapStep, tapStep, (tap & 2u) == 2u);");
    expect(source).toContain("let dx = select(-step, step, (sample & 1u) == 1u);");
    expect(source).toContain("let dz = select(-step, step, (sample & 2u) == 2u);");
    // Sampled once and shared by both season buckets.
    expect(source).toContain("splatSupersample(job, localX, localZ, job.placement.z, tapCanopy);");
    expect(source).toContain("splatSupersample(job, localX, localZ, job.placement.w, tapCanopy);");
  });

  it("evaluates a coarse tap's moisture and climate once, and a fine tap's where it always did", () => {
    const source = LAND_COVER_SPLAT_BAKE_WGSL;
    // Coarse: one chain of each per tap, handed to the canopy sample and to
    // both seasonal classifications of that tap.
    expect(source).toContain("let tapMoisture = terrainMoisture(localX + tapDx, localZ + tapDz);");
    expect(source).toContain("splatCanopyAt(job, localX + tapDx, localZ + tapDz, tapMoisture),");
    expect(source).toContain("terrainClimate(localX + tapDx, localZ + tapDz));");
    // Fine: the sentinel routes the tap to the same two calls it made before.
    expect(source).toMatch(
      /if \(tap\.z >= 0\.0\) \{\s*input\.moisture = tap\.z;\s*\} else \{\s*input\.moisture = terrainMoisture\(localX, localZ\);\s*tapClimate = terrainClimate\(localX, localZ\);\s*\}/u);
    // The centre's canopy still evaluates its own moisture: it feeds the lane.
    expect(source).toContain(
      "return splatCanopyAt(job, localX, localZ, terrainMoisture(localX, localZ));");
  });

  it("leaves the closure LANE the centre sample at every level", () => {
    // The far canopy and the hand-off read this lane and must agree with the
    // trees actually planted; only the material weights may become area-true.
    const source = LAND_COVER_SPLAT_BAKE_WGSL;
    expect(source).toContain("textureStore(splatWeightLo, texel, vec4f(aligned.weightsLo.xyz, canopy.x));");
    expect(source).toContain("textureStore(splatWeightHi, texel, vec4f(aligned.weightsHi.xyz, canopy.x));");
    expect(source).not.toMatch(/textureStore\([^;]*tapCanopy/u);
  });
});
