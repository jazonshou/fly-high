import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import {
  DETAIL_TREE_BARK_AUTHORED_V_REPEATS,
  DETAIL_TREE_BARK_REPEAT_METERS,
  DetailInstanceMaterialPlugin,
  detailMetricTreeBarkV,
} from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import {
  DETAIL_CULL_FADE_MARGIN_METERS,
  DETAIL_FADE_MARGIN_METERS,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  WorldDetailRuntime,
} from "../src/render/webgpu/detail/WorldDetailRuntime";

/**
 * 2-14 / 2-17-close — the LOD ownership surface. The shader evaluates the
 * stem's true camera range (the baked form forced every chunk to rebuild on
 * an observer quantum, measured as a hitch train). Near and mid share exact
 * opaque crown geometry and hard-switch halfway through their residency
 * overlap. Far hard-switches at the next boundary and dithers only through
 * the outer cull margin.
 */

const LAW = RENDERED_DENSITY_LAWS[2]!;

/** TS mirror of the WGSL `detailBayer8` (reviewed against the shader). */
function bayer8(x: number, y: number): number {
  const px = x % 8;
  const py = y % 8;
  const xor = px ^ py;
  const index = ((py & 1) << 5) | ((xor & 1) << 4)
    | ((py & 2) << 2) | ((xor & 2) << 1)
    | ((py & 4) >> 1) | ((xor & 4) >> 2);
  return (index + 0.5) / 64;
}

/** TS mirror of the WGSL `detailBandWindow` thresholds (margins inline in
 * the shader as literals — pinned below against these constants). */
function bandWindow(
  bandCode: 0 | 1 | 2,
  range: number,
  farSwitchUnit = 0.5,
): [number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const nearSwitch = LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2;
  const farSwitch = LAW.mid.outerRadiusMeters
    - DETAIL_FADE_MARGIN_METERS + farSwitchUnit * DETAIL_FADE_MARGIN_METERS;
  const fCull = clamp01((LAW.far.outerRadiusMeters - range) / DETAIL_CULL_FADE_MARGIN_METERS);
  if (bandCode === 0) return range < nearSwitch ? [0, 1] : [0, 0];
  if (bandCode === 1) return range >= nearSwitch && range < farSwitch ? [0, 1] : [0, 0];
  return range >= farSwitch ? [0, fCull] : [0, 0];
}

describe("band memberships (2-17 close)", () => {
  it("covers every band whose window a stem could enter within the slack", () => {
    const nearEdge = LAW.near.outerRadiusMeters;
    // Pure-near membership holds only where the mid window cannot open
    // within one slack of camera travel: nearEdge − margin − slack.
    const interior = WorldDetailRuntime.fadeBandMemberships(
      LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS - DETAIL_MEMBERSHIP_SLACK_METERS - 5,
      LAW,
    );
    expect(interior.map((entry) => entry.band)).toEqual(["near"]);

    const inMargin = WorldDetailRuntime.fadeBandMemberships(
      nearEdge - DETAIL_FADE_MARGIN_METERS * 0.5,
      LAW,
    );
    expect(inMargin.map((entry) => entry.band)).toEqual(["near", "mid"]);

    // Just outside the near edge the stem still belongs to near (slack):
    // the window computes to zero there, so it draws nothing — but if the
    // camera closes in before the next amortized rebuild, it fades back.
    const justOutside = WorldDetailRuntime.fadeBandMemberships(
      nearEdge + DETAIL_MEMBERSHIP_SLACK_METERS * 0.5,
      LAW,
    );
    expect(justOutside.map((entry) => entry.band)).toContain("near");
    expect(justOutside.map((entry) => entry.band)).toContain("mid");

    const cullEdge = LAW.far.outerRadiusMeters;
    expect(
      WorldDetailRuntime.fadeBandMemberships(cullEdge + DETAIL_MEMBERSHIP_SLACK_METERS + 1, LAW),
    ).toEqual([]);
  });

  it("keeps membership slack above the observer signature quantum", () => {
    // Frontier chunks re-bake on a 64 m observer quantum; memberships must
    // stay valid across a full quantum of travel.
    expect(DETAIL_MEMBERSHIP_SLACK_METERS).toBeGreaterThan(64);
  });

  it("reuses immutable categorical membership sets across rebuilds", () => {
    const distance = LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS * 0.5;
    const first = WorldDetailRuntime.fadeBandMemberships(distance, LAW);
    const second = WorldDetailRuntime.fadeBandMemberships(distance, LAW);
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every((membership) => Object.isFrozen(membership))).toBe(true);

    const outside = LAW.far.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS + 1;
    expect(WorldDetailRuntime.fadeBandMemberships(outside, LAW)).toBe(
      WorldDetailRuntime.fadeBandMemberships(outside, LAW),
    );
  });
});

describe("band-window fades (2-17 close)", () => {
  it("builds a bijective 8×8 Bayer matrix", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        seen.add(Math.round(bayer8(x, y) * 64 - 0.5));
      }
    }
    expect(seen.size).toBe(64);
  });

  it("assigns every pixel to exactly one band before the outer cull fade", () => {
    // At any camera range inside the fully populated field, exactly one LOD
    // owns the entire stem: no overlapping opaque hulls and no coverage gap.
    for (let range = 5; range < LAW.far.outerRadiusMeters - DETAIL_CULL_FADE_MARGIN_METERS;
      range += 7) {
      for (let level = 0; level < 64; level += 1) {
        const threshold = (level + 0.5) / 64;
        let survivors = 0;
        for (const band of [0, 1, 2] as const) {
          const [lo, hi] = bandWindow(band, range);
          if (threshold >= lo && threshold < hi) survivors += 1;
        }
        expect(survivors, `range ${range} level ${level}`).toBe(1);
      }
    }
  });

  it("hard-switches at the centres of both residency overlaps", () => {
    const nearSwitch = LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2;
    const farSwitch = LAW.mid.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2;
    expect(bandWindow(0, nearSwitch - 0.001)).toEqual([0, 1]);
    expect(bandWindow(1, nearSwitch - 0.001)).toEqual([0, 0]);
    expect(bandWindow(0, nearSwitch)).toEqual([0, 0]);
    expect(bandWindow(1, nearSwitch)).toEqual([0, 1]);
    expect(bandWindow(1, farSwitch - 0.001)).toEqual([0, 1]);
    expect(bandWindow(2, farSwitch - 0.001)).toEqual([0, 0]);
    expect(bandWindow(1, farSwitch)).toEqual([0, 0]);
    expect(bandWindow(2, farSwitch)).toEqual([0, 1]);
  });

  it("stagger-switches mid/far stems across the full overlap without gaps", () => {
    const overlapStart = LAW.mid.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS;
    for (const switchUnit of [0, 0.1, 0.33, 0.5, 0.9, 0.999]) {
      const switchRange = overlapStart + switchUnit * DETAIL_FADE_MARGIN_METERS;
      expect(bandWindow(1, switchRange - 0.001, switchUnit)).toEqual([0, 1]);
      expect(bandWindow(2, switchRange - 0.001, switchUnit)).toEqual([0, 0]);
      expect(bandWindow(1, switchRange, switchUnit)).toEqual([0, 0]);
      expect(bandWindow(2, switchRange, switchUnit)).toEqual([0, 1]);
    }
  });

  it("fades the far band to nothing across the cull margin", () => {
    const cullEdge = LAW.far.outerRadiusMeters;
    const [loBefore, hiBefore] = bandWindow(2, cullEdge - DETAIL_CULL_FADE_MARGIN_METERS - 1);
    expect(hiBefore - loBefore).toBeCloseTo(1, 5);
    const [loAt, hiAt] = bandWindow(2, cullEdge - 1);
    expect(hiAt - loAt).toBeLessThan(0.01);
    const [loPast, hiPast] = bandWindow(2, cullEdge + 50);
    expect(hiPast).toBeLessThanOrEqual(loPast);
  });
});

describe("crossfade shader surface (2-17 close)", () => {
  it("keeps live-tree bark at a two-metre vertical repeat", () => {
    expect(DETAIL_TREE_BARK_AUTHORED_V_REPEATS).toBe(3);
    expect(DETAIL_TREE_BARK_REPEAT_METERS).toBe(2);
    for (const height of [2, 8, 24, 40]) {
      const repeats = detailMetricTreeBarkV(
        DETAIL_TREE_BARK_AUTHORED_V_REPEATS,
        height,
      );
      expect(height / repeats).toBeCloseTo(DETAIL_TREE_BARK_REPEAT_METERS, 12);
    }
    expect(() => detailMetricTreeBarkV(1, -1)).toThrow(RangeError);
  });

  it("carries the band-window helper with margins matching the constants", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("crossfade-test", scene);
      const plugin = new DetailInstanceMaterialPlugin(material);
      const fragment = plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      const definitions = fragment["CUSTOM_FRAGMENT_DEFINITIONS"]!;
      expect(definitions).toContain("fn detailBayer8");
      expect(definitions).toContain("fn detailBandWindow");
      // The WGSL inlines the margins as literals — they must mirror the
      // runtime constants or the shader and appender disagree about where
      // memberships are needed.
      expect(definitions).toContain(`/ ${DETAIL_CULL_FADE_MARGIN_METERS.toFixed(1)}`);
      const albedo = fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]!;
      expect(albedo).toContain("detailBandWindow");
      // The single-edge baked path survives for rocks/shrubs/clutter/grass.
      expect(albedo).toContain("detailDitherSurvives");
      expect(albedo).toContain("detailLeafHash");
      expect(albedo).toContain("i32(floor(max(fragmentInputs.detailAtlasData.z, 0.0)))");
      expect(albedo).toContain("let detailOpaqueSurface = (detailAtlasLayer >= 5.0");
      expect(albedo).toContain("detailAtlasLayer >= 16.0 && detailAtlasLayer <= 17.0");
      expect(albedo).toContain("if (!detailOpaqueSurface)");
      expect(definitions).toContain("leafed.rgb * leafed.a");
      expect(definitions).toContain("bare.rgb * bare.a");
      expect(definitions).toContain("uniforms.detailImpostorSeason > seasonSelector");
      expect(albedo).toContain("impostorVariantByteForSeason");
      expect(albedo).not.toContain("dot(\n  fragmentInputs.detailInstanceTint.rgb");
      expect(albedo).toContain("#ifndef DETAIL_OPAQUE_CROWN");
      const vertex = plugin.getCustomCode("vertex", ShaderLanguage.WGSL)!;
      const vertexDefinitions = vertex["CUSTOM_VERTEX_DEFINITIONS"]!;
      expect(vertexDefinitions).toContain(
        `- ${(DETAIL_FADE_MARGIN_METERS / 2).toFixed(1)}`,
      );
      expect(vertexDefinitions).toContain(
        `- ${DETAIL_FADE_MARGIN_METERS.toFixed(1)} + farSwitchHash`,
      );
      expect(vertexDefinitions).toContain("let farSwitchHash = fract(switchSeed)");
      expect(vertexDefinitions).not.toContain("dot(tintRgb");
      const position = vertex["CUSTOM_VERTEX_UPDATE_POSITION"]!;
      expect(position).not.toContain("detailOpaqueBandScale");
      // WGSL swizzles are values, not assignable l-values. A direct
      // `detailLocal.xz = ...` made the opaque-crown vertex module invalid,
      // rejected the frame submit, and left the live game black while its
      // JavaScript FPS counter continued to report 120. Keep the scale as an
      // explicit vector reconstruction so the CPU suite catches that exact
      // whole-frame failure before the real-adapter compile gate runs.
      expect(position).not.toMatch(/detailLocal\.xz\s*=/);
      expect(position).toContain("detailLocal = vec3f(");
      expect(position).toContain("detailLocal.x * detailDenseScale");
      expect(position).toContain("detailLocal.z * detailDenseScale");
      expect(position).toContain("* sqrt(detailDenseScale)");
      // Fix-pack F2 re-pin: flutter now reaches opaque crowns at reduced
      // amplitude instead of being compiled out — a rigid hull in wind read
      // as plastic. The amplitude split is the new pinned surface.
      expect(position).toContain("let detailFlutterAmplitude = 0.0035;");
      expect(position).toContain("let detailFlutterAmplitude = 0.006;");
      expect(position).toContain("let detailBarkSelector = floor(");
      expect(position).toContain("clamp(vertexInputs.instanceTint.a, 0.0, 1.0) * 2.0");
      expect(position).toContain("detailAtlasLayerOut = 5.0 + detailBarkSelector");
      expect(position).toContain("detailAtlasUvOut.y = detailAtlasUvOut.y * detailHeight");
      expect(position).toContain("/ 6.0");
      const normal = vertex["CUSTOM_VERTEX_UPDATE_NORMAL"]!;
      expect(normal).toContain("detailNormalDenseY = sqrt(detailDenseScale)");
      expect(normal).toContain("detailNormalRadial * detailNormalDenseY");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
