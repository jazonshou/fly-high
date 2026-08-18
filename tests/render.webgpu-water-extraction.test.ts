import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
} from "../src/render/webgpu/water/HydrologySystem";
import {
  WATER_FRAGMENT_WGSL,
  WATER_VERTEX_WGSL,
} from "../src/render/webgpu/water/SpectralOceanSystem";
import {
  WATER_FRESNEL_SCHLICK_WGSL,
  WATER_GGX_COMBINED_SPECULAR_WGSL,
  WATER_GGX_SPLIT_WGSL,
  waterReflectedSkyWgsl,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * 2-8a — the water shader extraction gate (assertion 41).
 *
 * The pinned hashes are the ocean's WGSL as it stood BEFORE the extraction:
 * the shared blocks in WaterShaders.ts must recompose it character for
 * character, which makes the rendered output identical by construction —
 * strictly stronger than the plan's capture-diff (two captures of a
 * temporally-jittered volumetric sky are never byte-equal, a text-identical
 * shader is).
 *
 * If this test fails on a shading change you made ON PURPOSE (2-8, 2-9),
 * re-pin the hash in the same commit. That is the point: every change to
 * water shading is explicit, named and reviewed — never drift.
 */

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("water shader extraction (2-8a)", () => {
  it("recomposes the ocean WGSL byte-identically (assertion 41)", () => {
    expect(sha256(WATER_VERTEX_WGSL)).toBe(
      "479ea4bc83061cab3fc71a82542f2ebe7deedb5276558855e59f3bd35b9c5468",
    );
    expect(sha256(WATER_FRAGMENT_WGSL)).toBe(
      "02db76418cdf44c7b844e131630106019f553967e1d05220d15e0a69c60ff69e",
    );
  });

  it("gives both water surfaces the one shared fresnel text", () => {
    // Exactly one definition each, and it is the shared block verbatim —
    // a second textual copy is the §3.6 drift this file exists to prevent.
    for (const fragment of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(fragment).toContain(WATER_FRESNEL_SCHLICK_WGSL);
      expect(fragment.split("fn fresnelSchlick").length).toBe(2);
    }
    expect(WATER_FRAGMENT_WGSL).toContain(WATER_GGX_COMBINED_SPECULAR_WGSL);
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(WATER_GGX_SPLIT_WGSL);
  });

  it("keeps the divergent reflected-sky constants named and deliberate", () => {
    // The ocean/hydrology difference is a parameter value at the call site,
    // not two literals: both texts come from the same generator.
    expect(WATER_FRAGMENT_WGSL).toContain(
      waterReflectedSkyWgsl({
        horizonFalloffExponent: 2.5,
        overcastZenithColor: [0.34, 0.39, 0.45],
        overcastHorizonColor: [0.58, 0.63, 0.68],
        sunDiscExponent: 3_200,
        sunDiscGain: 16,
      }),
    );
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(
      waterReflectedSkyWgsl({
        horizonFalloffExponent: 2.3,
        overcastZenithColor: [0.31, 0.36, 0.41],
        overcastHorizonColor: [0.56, 0.61, 0.65],
        sunDiscExponent: 1_800,
        sunDiscGain: 11,
      }),
    );
  });

  it("formats integer parameters as WGSL float literals", () => {
    const text = waterReflectedSkyWgsl({
      horizonFalloffExponent: 2,
      overcastZenithColor: [0, 0.5, 1],
      overcastHorizonColor: [1, 1, 1],
      sunDiscExponent: 3_200,
      sunDiscGain: 16,
    });
    expect(text).toContain("2.0);");
    expect(text).toContain("vec3f(0.0, 0.5, 1.0)");
    expect(text).toContain("3200.0");
    expect(text).toContain("* 16.0 *");
    expect(text).not.toMatch(/[^0-9.]3200[^.]/u);
  });
});
