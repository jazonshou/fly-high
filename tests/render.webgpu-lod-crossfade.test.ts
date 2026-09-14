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
import {
  RENDERED_DENSITY_LAWS,
  drawnShareAtDistance,
  impostorFillStartMeters,
  renderedShareAtDistance,
} from "../src/render/webgpu/detail/renderedDensity";
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

/**
 * TS mirror of the WGSL `detailBandWindowEmpty` / `detailBandWindow`
 * thresholds (margins inline in the shader as literals — pinned below against
 * these constants).
 *
 * 2026-09-13: the window also takes the stem's LOD KEY (the phase lane) and,
 * for the impostor, whether a geometry record for the stem coexists in the
 * chunk. Geometry owns a stem while its key is within the geometry share at
 * the live range; the impostor owns it while the key is within the DRAWN
 * share but the geometry share has fallen below it (or geometry has switched
 * out at the hashed far switch, or no geometry record exists at all).
 */
function bandWindow(
  bandCode: 0 | 1 | 2,
  range: number,
  farSwitchUnit = 0.5,
  stemKey = 0,
  geometryCoexists = true,
): [number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const nearSwitch = LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2;
  const farSwitch = LAW.mid.outerRadiusMeters
    - DETAIL_FADE_MARGIN_METERS + farSwitchUnit * DETAIL_FADE_MARGIN_METERS;
  const fCull = clamp01((LAW.far.outerRadiusMeters - range) / DETAIL_CULL_FADE_MARGIN_METERS);
  const geometryShare = renderedShareAtDistance(LAW, range);
  const drawnShare = drawnShareAtDistance(LAW, range);
  if (bandCode === 0) return range < nearSwitch ? [0, 1] : [0, 0];
  if (bandCode === 1) {
    return range >= nearSwitch && range < farSwitch && stemKey <= geometryShare
      ? [0, 1]
      : [0, 0];
  }
  if (stemKey > drawnShare) return [0, 0];
  if (geometryCoexists && range < farSwitch && stemKey <= geometryShare) return [0, 0];
  return [0, fCull];
}

describe("band memberships (2-17 close)", () => {
  it("covers every band whose window a stem could enter within the slack", () => {
    const nearEdge = LAW.near.outerRadiusMeters;
    // Wave T shrank the near band below margin + slack (150 m vs 100 + 96 at
    // tier 1), so there is no longer a pure-near interior: every near stem
    // also carries a mid membership whose window the vertex stage keeps
    // closed until the switch. The double-buffered records are a few hundred
    // 32-byte rows; the arbitration is the band window, not the membership.
    // 2026-09-13: the far (impostor) membership begins where mid does, so an
    // impostor can stand in for any stem the geometry share rejects; the
    // builder only EMITS it where geometry does not own the stem across the
    // whole cell, and the window arbitrates the rest.
    const interior = WorldDetailRuntime.fadeBandMemberships(5, LAW);
    expect(interior.map((entry) => entry.band)).toEqual(["near", "mid", "far"]);

    const inMargin = WorldDetailRuntime.fadeBandMemberships(
      nearEdge - DETAIL_FADE_MARGIN_METERS * 0.5,
      LAW,
    );
    expect(inMargin.map((entry) => entry.band)).toEqual(["near", "mid", "far"]);

    // A stem deep inside the near band at a tier whose near radius exceeds
    // margin + slack has no mid or far membership (tier 3: 240 m > 196 m).
    const ultra = RENDERED_DENSITY_LAWS[3]!;
    expect(
      WorldDetailRuntime.fadeBandMemberships(10, ultra).map((entry) => entry.band),
    ).toEqual(["near"]);

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

  it("hands a stem from geometry to its impostor at the stem's OWN range (2026-09-13)", () => {
    // A stem's key is its density-normalised canopy rank. Geometry owns it
    // while the live geometry share still reaches the key; past that range
    // the impostor owns it, up to the drawn share; beyond THAT nothing draws
    // it. Every pixel has exactly one owner wherever the stem is drawn, and
    // the handoff range is the stem's, not its cell's.
    const nearSwitch = LAW.near.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2;
    const cullStart = LAW.far.outerRadiusMeters - DETAIL_CULL_FADE_MARGIN_METERS;
    for (const stemKey of [0.05, 0.12, 0.2, LAW.impostorFloorShare]) {
      const handoff = LAW.near.outerRadiusMeters / Math.sqrt(stemKey);
      expect(handoff).toBeGreaterThan(nearSwitch);
      for (let range = nearSwitch; range < cullStart; range += 3) {
        const owners = ([0, 1, 2] as const).filter((band) => {
          const [lo, hi] = bandWindow(band, range, 0.5, stemKey);
          return hi > lo;
        });
        expect(owners, `key ${stemKey} range ${range}`).toHaveLength(1);
        const expected = range < nearSwitch ? 0
          : range < Math.min(handoff, LAW.mid.outerRadiusMeters - DETAIL_FADE_MARGIN_METERS / 2)
            ? 1
            : 2;
        expect(owners[0], `key ${stemKey} range ${range}`).toBe(expected);
      }
    }
    // Above the impostor floor a stem vanishes at its geometry threshold and
    // no representation follows it — that is the law's count, not a gap.
    const aboveFloor = Math.min(0.9, LAW.impostorFloorShare + 0.2);
    const vanish = LAW.near.outerRadiusMeters / Math.sqrt(aboveFloor);
    expect(bandWindow(1, vanish - 1, 0.5, aboveFloor)).toEqual([0, 1]);
    expect(bandWindow(1, vanish + 1, 0.5, aboveFloor)).toEqual([0, 0]);
    expect(bandWindow(2, vanish + 1, 0.5, aboveFloor)).toEqual([0, 0]);
    // The crossover the law publishes is where the fill begins for the
    // stem whose key sits exactly on the floor.
    expect(impostorFillStartMeters(LAW)).toBeCloseTo(
      LAW.near.outerRadiusMeters / Math.sqrt(LAW.impostorFloorShare), 9);
    // An impostor with NO geometry record resident stands in unconditionally
    // (a CPU/GPU disagreement about a range can never blank a stem).
    expect(bandWindow(2, nearSwitch + 1, 0.5, 0.05, false)).toEqual([0, 1]);
    expect(bandWindow(2, LAW.mid.outerRadiusMeters, 0.5, 0.05, false)).toEqual([0, 1]);
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
      // The season bucket is chosen per stem, then fetched ONCE (2026-09-13:
      // the far band is fragment-bound; sampling both buckets and selecting
      // afterwards doubled its albedo fetches for the same output).
      expect(definitions).toContain("bucket.rgb * bucket.a");
      expect(definitions).not.toContain("let bare = textureSample");
      expect(definitions).toContain(
        "select(layers.x, layers.y, uniforms.detailImpostorSeason > seasonSelector)",
      );
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
      // 2026-09-13: the switch seed is the stem's LOD key, read through the
      // per-stem hash — the drawn population is a key prefix, so the raw lane
      // would collapse the 100 m stagger to a ring.
      expect(vertexDefinitions).toContain("let farSwitchHash = detailStemHash(stemKey)");
      expect(vertexDefinitions).toContain("fn detailStemHash(lane: f32) -> f32");
      expect(vertexDefinitions).toContain("fract(lane * 157.31 + 0.371)");
      expect(vertexDefinitions).toContain("uniforms.detailBandShares.x");
      expect(vertexDefinitions).toContain("uniforms.detailBandShares.y");
      expect(plugin.getUniforms().ubo).toContainEqual({
        name: "detailBandShares",
        size: 4,
        type: "vec4",
      });
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
