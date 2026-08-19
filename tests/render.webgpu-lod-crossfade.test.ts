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
  WorldDetailRuntime,
} from "../src/render/webgpu/detail/WorldDetailRuntime";

/**
 * 2-14 — the LOD crossfade's pure surfaces: band memberships with EXACT
 * complementary fades inside the margins, the Bayer-8 construction, and the
 * end-to-end guarantee that a crossfading stem covers every dither level
 * exactly once (the reason the fade byte carries a direction bit — a
 * statistical complement double-draws the whole canopy at fade 0.5).
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

/** TS mirror of the writer's fade-byte encoding. */
function fadeByte(fade: number, incoming: boolean): number {
  return Math.min(127, Math.round(Math.min(1, Math.max(0, fade)) * 127)) * 2
    + (incoming ? 1 : 0);
}

/** TS mirror of the WGSL `detailDitherSurvives` (same hash elided — both
 * sides of a crossfade share it, so it cancels in complementarity). */
function ditherSurvives(byte: number, threshold: number): boolean {
  if (byte >= 254) return true;
  if (byte <= 1) return false;
  const incoming = byte % 2 === 1;
  const fade = Math.floor(byte / 2) / 127;
  if (incoming) return threshold >= 1 - fade;
  return threshold < fade;
}

describe("fade band memberships (2-14)", () => {
  it("gives interior stems one full band and boundary stems two complements", () => {
    const nearEdge = LAW.near.outerRadiusMeters;
    const interior = WorldDetailRuntime.fadeBandMemberships(nearEdge * 0.5, LAW);
    expect(interior).toEqual([{ band: "near", fade: 1, incoming: false }]);

    const inMargin = WorldDetailRuntime.fadeBandMemberships(
      nearEdge - DETAIL_FADE_MARGIN_METERS * 0.25,
      LAW,
    );
    expect(inMargin).toHaveLength(2);
    expect(inMargin[0]!.band).toBe("near");
    expect(inMargin[0]!.incoming).toBe(false);
    expect(inMargin[1]!.band).toBe("mid");
    expect(inMargin[1]!.incoming).toBe(true);
    expect(inMargin[0]!.fade + inMargin[1]!.fade).toBeCloseTo(1, 9);

    const midInterior = WorldDetailRuntime.fadeBandMemberships(
      (nearEdge + LAW.mid.outerRadiusMeters) / 2,
      LAW,
    );
    expect(midInterior).toEqual([{ band: "mid", fade: 1, incoming: false }]);

    const midMargin = WorldDetailRuntime.fadeBandMemberships(
      LAW.mid.outerRadiusMeters - 1,
      LAW,
    );
    expect(midMargin.map((entry) => entry.band)).toEqual(["mid", "far"]);
  });

  it("fades the far band to nothing at the cull radius", () => {
    const cullEdge = LAW.far.outerRadiusMeters;
    const nearlyGone = WorldDetailRuntime.fadeBandMemberships(cullEdge - 1, LAW);
    expect(nearlyGone).toHaveLength(1);
    expect(nearlyGone[0]!.band).toBe("far");
    expect(nearlyGone[0]!.fade).toBeLessThan(0.01);
    expect(WorldDetailRuntime.fadeBandMemberships(cullEdge, LAW)).toEqual([]);
    expect(WorldDetailRuntime.fadeBandMemberships(cullEdge + 500, LAW)).toEqual([]);
  });

  it("keeps both margins wider than the generation cell", () => {
    expect(DETAIL_FADE_MARGIN_METERS).toBeGreaterThan(128);
    expect(DETAIL_CULL_FADE_MARGIN_METERS).toBeGreaterThan(128);
  });
});

describe("dither crossfade math (2-14)", () => {
  it("builds a bijective 8×8 Bayer matrix", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        seen.add(Math.round(bayer8(x, y) * 64 - 0.5));
      }
    }
    expect(seen.size).toBe(64);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(63);
  });

  it("covers every dither level exactly once across a crossfade", () => {
    // For every fade position, each of the 64 Bayer levels must light the
    // outgoing OR the incoming side — never both, never neither. Fade-byte
    // quantisation (127 levels vs 64 thresholds) is allowed at most one
    // level of slack at exact coincidences.
    for (let step = 1; step < 32; step += 1) {
      const fade = step / 32;
      const outgoing = fadeByte(fade, false);
      const incoming = fadeByte(1 - fade, true);
      let mismatches = 0;
      for (let level = 0; level < 64; level += 1) {
        const threshold = (level + 0.5) / 64;
        const survivors = Number(ditherSurvives(outgoing, threshold))
          + Number(ditherSurvives(incoming, threshold));
        if (survivors !== 1) mismatches += 1;
      }
      expect(mismatches, `fade ${fade}`).toBeLessThanOrEqual(1);
    }
  });

  it("takes the fast paths at the extremes", () => {
    expect(ditherSurvives(fadeByte(1, false), 0.999)).toBe(true);
    expect(ditherSurvives(fadeByte(0, false), 0.001)).toBe(false);
  });
});

describe("crossfade shader surface (2-14)", () => {
  it("carries the dither helpers and both fade decode paths", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("crossfade-test", scene);
      const plugin = new DetailInstanceMaterialPlugin(material);
      const fragment = plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      const definitions = fragment["CUSTOM_FRAGMENT_DEFINITIONS"]!;
      expect(definitions).toContain("fn detailBayer8");
      expect(definitions).toContain("fn detailDitherSurvives");
      const albedo = fragment["CUSTOM_FRAGMENT_UPDATE_ALBEDO"]!;
      // Atlas path: fade byte hides in the atlas layer's fraction; bark
      // path: its own varying. Both discard through the shared helper.
      expect(albedo).toContain("fract(fragmentInputs.detailAtlasData.z) * 512.0");
      expect(albedo).toContain("fragmentInputs.detailFadeByte");
      expect(albedo).toContain("detailDitherSurvives");
      // The layer decode strips the fade fraction (floor, not round).
      expect(albedo).toContain("i32(floor(max(fragmentInputs.detailAtlasData.z, 0.0)))");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
