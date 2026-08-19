import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { DetailInstanceMaterialPlugin } from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { RENDERED_DENSITY_LAWS } from "../src/render/webgpu/detail/renderedDensity";
import {
  DETAIL_CULL_FADE_MARGIN_METERS,
  DETAIL_FADE_MARGIN_METERS,
  DETAIL_MEMBERSHIP_SLACK_METERS,
  WorldDetailRuntime,
} from "../src/render/webgpu/detail/WorldDetailRuntime";

/**
 * 2-14 / 2-17-close — the LOD crossfade's pure surfaces. Fades are
 * FRAGMENT-computed from the stem's true camera range (the baked form
 * forced every chunk to rebuild on an observer quantum, measured as a
 * hitch train at approach speeds): the three thresholds partition the
 * dither square exactly — near owns [0, fNear), mid [fNear, fMid), far
 * [fMid, fCull) — so complementarity is STRUCTURAL: no range, no dither
 * level, can light two bands or none inside the vegetated field.
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
function bandWindow(bandCode: 0 | 1 | 2, range: number): [number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const fNear = clamp01((LAW.near.outerRadiusMeters - range) / DETAIL_FADE_MARGIN_METERS);
  const fMid = clamp01((LAW.mid.outerRadiusMeters - range) / DETAIL_FADE_MARGIN_METERS);
  const fCull = clamp01((LAW.far.outerRadiusMeters - range) / DETAIL_CULL_FADE_MARGIN_METERS);
  if (bandCode === 0) return [0, fNear];
  if (bandCode === 1) return [fNear, fMid];
  return [fMid, fCull];
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

  it("partitions every dither level to exactly one band at every range", () => {
    // The structural guarantee the baked complement approximated: at any
    // camera range inside the vegetated field, the three band windows tile
    // [0, 1) with no overlap and no gap — every pixel shows exactly one
    // LOD, continuously, with no quantization slack at all.
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
      expect(definitions).toContain(`/ ${DETAIL_FADE_MARGIN_METERS.toFixed(1)}`);
      expect(definitions).toContain(`/ ${DETAIL_CULL_FADE_MARGIN_METERS.toFixed(1)}`);
      const albedo = fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]!;
      expect(albedo).toContain("detailBandWindow");
      // The single-edge baked path survives for rocks/shrubs/clutter/grass.
      expect(albedo).toContain("detailDitherSurvives");
      expect(albedo).toContain("detailLeafHash");
      expect(albedo).toContain("i32(floor(max(fragmentInputs.detailAtlasData.z, 0.0)))");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
