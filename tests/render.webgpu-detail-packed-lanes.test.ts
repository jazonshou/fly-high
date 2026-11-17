import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import {
  DETAIL_PACKED_FADE_BIAS,
  DETAIL_PACKED_FADE_STEPS,
  DETAIL_PACKED_OCCLUSION_BIAS,
  DetailInstanceMaterialPlugin,
  detailPackAtlasLane,
  detailPackOcclusionLane,
  detailUnpackAtlasLane,
  detailUnpackOcclusionLane,
} from "../src/render/webgpu/detail/DetailInstanceMaterialPlugin";
import { FOLIAGE_LAYERS } from "../src/render/webgpu/detail/FoliageAtlas";

/**
 * The vegetation shader carries two whole numbers in the fractions of one
 * interpolated varying. A rasteriser may hand a fragment a per-triangle
 * constant a few units in the last place off (WebGPU fixes no interpolation
 * precision; SwiftShader does exactly this), so a packed value that sits ON
 * an integer decodes to the wrong layer and the wrong band on a scatter of
 * pixels: holes through a near trunk, specks in a crown. These tests hold the
 * packing clear of every integer it is floored at.
 */

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** The f32 `steps` representable values away from `value` (which is > 0 or < 0). */
function nudge(value: number, steps: number): number {
  F32[0] = value;
  if (F32[0] === 0) throw new RangeError("nudge needs a non-zero value");
  U32[0] = U32[0]! + (F32[0] > 0 ? steps : -steps);
  return F32[0]!;
}

/**
 * How far off a rasteriser may be. Sixty-four units in the last place is
 * dozens of times what a divide-by-interpolated-w produces, and three
 * hundred times less than the margin the packing leaves.
 */
const SLOP_ULPS = 64;
const LAYERS = [-1, ...Object.values(FOLIAGE_LAYERS)];

describe("the vegetation shader's packed lanes", () => {
  it("keeps every layer and fade byte through an inexact interpolation", () => {
    for (const layer of LAYERS) {
      for (let fadeByte = 0; fadeByte <= 255; fadeByte += 1) {
        const packed = detailPackAtlasLane(layer, fadeByte);
        // Exact where it is written: the bias costs no precision.
        expect(Math.fround(packed)).toBe(packed);
        for (const steps of [-SLOP_ULPS, -1, 0, 1, SLOP_ULPS]) {
          const arrived = detailUnpackAtlasLane(nudge(packed, steps));
          expect(arrived.fadeByte).toBe(fadeByte);
          expect(arrived.textured).toBe(layer >= 0);
          expect(arrived.atlasLayer).toBe(Math.max(layer, 0));
        }
      }
    }
  });

  it("keeps every modifier and occlusion through an inexact interpolation", () => {
    for (let modifier = 0; modifier <= 7; modifier += 1) {
      for (let level = 0; level <= 255; level += 1) {
        const occlusion = level / 255;
        const packed = Math.fround(detailPackOcclusionLane(modifier, occlusion));
        for (const steps of [-SLOP_ULPS, -1, 0, 1, SLOP_ULPS]) {
          const arrived = detailUnpackOcclusionLane(nudge(packed, steps));
          expect(arrived.modifier).toBe(modifier);
          expect(arrived.occlusion).toBeGreaterThanOrEqual(0);
          expect(arrived.occlusion).toBeLessThanOrEqual(1);
          expect(Math.abs(arrived.occlusion - occlusion)).toBeLessThan(2e-4);
        }
      }
    }
  });

  it("names the defect: an unbiased lane one unit low reads another layer and band", () => {
    // What shipped before: layer + byte / 512, decoded with floor and fract.
    // A near oak trunk is bark layer 6 with fade byte 0, exactly 6.0.
    const before = FOLIAGE_LAYERS.barkBroadleaf + 0 / 512;
    const low = nudge(before, -1);
    expect(Math.floor(low)).toBe(FOLIAGE_LAYERS.barkConifer);
    const bandCode = Math.floor(((low - Math.floor(low)) * 512) / 2);
    // 255 is no band at all; detailBandWindow reads anything above 3.5 as a
    // mid card shell, which is dithered away inside the near band.
    expect(bandCode).toBe(255);
    // A mid leaf card (code 4, byte 8) one unit low is the near shell's
    // code 3, which is culled past the near edge.
    const card = nudge(FOLIAGE_LAYERS.broadleafOak + 8 / 512, -1);
    expect(Math.floor(((card - Math.floor(card)) * 512) / 2)).toBe(3);
    // And the same values now.
    const now = detailUnpackAtlasLane(nudge(detailPackAtlasLane(FOLIAGE_LAYERS.barkBroadleaf, 0), -1));
    expect(now).toEqual({ atlasLayer: FOLIAGE_LAYERS.barkBroadleaf, textured: true, fadeByte: 0 });
    expect(detailUnpackAtlasLane(nudge(detailPackAtlasLane(FOLIAGE_LAYERS.broadleafOak, 8), -1)).fadeByte)
      .toBe(8);
  });

  it("leaves a margin hundreds of times a rasteriser's error on both sides", () => {
    // Half a fade step either way, in units of the largest packed value's
    // last place (layer 19: 2^-19).
    const largest = Math.max(...LAYERS) + 1;
    const ulp = 2 ** (Math.floor(Math.log2(largest)) - 23);
    const fadeMargin = DETAIL_PACKED_FADE_BIAS / DETAIL_PACKED_FADE_STEPS;
    expect(fadeMargin / ulp).toBeGreaterThan(SLOP_ULPS * 4);
    // The top byte stays below the half that the next layer would start at.
    expect((255 + DETAIL_PACKED_FADE_BIAS) / DETAIL_PACKED_FADE_STEPS).toBeLessThan(0.5);
    expect(DETAIL_PACKED_OCCLUSION_BIAS).toBeGreaterThanOrEqual(0.125);
    expect(DETAIL_PACKED_OCCLUSION_BIAS + 0.5).toBeLessThanOrEqual(0.875);
  });

  it("rejects what the lanes cannot carry", () => {
    expect(() => detailPackAtlasLane(0.5, 0)).toThrow(RangeError);
    expect(() => detailPackAtlasLane(0, 256)).toThrow(RangeError);
    expect(() => detailPackAtlasLane(-2, 0)).toThrow(RangeError);
    expect(() => detailPackOcclusionLane(8, 0)).toThrow(RangeError);
    expect(() => detailPackOcclusionLane(0, 1.5)).toThrow(RangeError);
    expect(() => detailPackOcclusionLane(0, Number.NaN)).toThrow(RangeError);
  });

  it("is what the WGSL writes and reads", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const plugin = new DetailInstanceMaterialPlugin(new PBRMaterial("packed-lanes", scene));
      const vertex = Object.values(plugin.getCustomCode("vertex", ShaderLanguage.WGSL)!).join("\n");
      const fragment = Object.values(plugin.getCustomCode("fragment", ShaderLanguage.WGSL)!).join("\n");
      const squeeze = (source: string): string => source.replace(/\s+/g, " ");
      expect(squeeze(vertex)).toContain(
        "detailAtlasLayerOut + (floor(vertexInputs.instanceState.x * 255.0 + 0.5) + 0.5) / 512.0,",
      );
      expect(squeeze(vertex)).toContain("detailModifierBits + 0.25 + detailOcclusionOut * 0.5,");
      expect(squeeze(fragment)).toContain(
        "let detailFadeByteDecoded = floor( fract(fragmentInputs.detailAtlasData.z) * 512.0);",
      );
      expect(squeeze(fragment)).toContain(
        "let detailFadeByteDecoded = floor(fragmentInputs.detailFadeByte + 0.5);",
      );
      expect(squeeze(fragment)).toContain(
        "(fragmentInputs.detailAtlasData.w - detailModifierDecoded - 0.25) * 2.0, 0.0, 1.0);",
      );
      expect(squeeze(fragment)).toContain("let fadeByte = floor(fadeByteLane + 0.5);");
      // No lane is taken apart from its raw fraction any more: every read of
      // the packed fraction is floored, and every occlusion read removes the
      // bias it was written with.
      expect(squeeze(fragment)).not.toMatch(/fract\(fragmentInputs\.detailAtlasData\.z\) \* 512\.0;/);
      const occlusionReads = squeeze(fragment).match(/detailAtlasData\.w - [^;]*?\* 2\.0/g) ?? [];
      expect(occlusionReads.length).toBe(2);
      for (const read of occlusionReads) expect(read).toContain("- 0.25)");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
