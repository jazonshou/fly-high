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
  WATER_FOAM_WGSL,
  WATER_FRESNEL_SCHLICK_WGSL,
  WATER_SUN_SPECULAR_WGSL,
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
  it("pins the composed ocean WGSL (assertion 41)", () => {
    // Re-pinned by 5-11 after the shared bathymetry/Beer-Lambert/underwater
    // include replaced opaque constant-depth ocean colour. This is the
    // deliberate-change flow this gate exists to force. The
    // 2-8a extraction itself was verified against the pre-extraction hashes
    // (479ea4bc… / 02db7641…) before this re-pin.
    expect(sha256(WATER_VERTEX_WGSL)).toBe(
      "b0cad61d28a2368573d70b710e1a63d23334277a0780f81fe83981f1200a9774",
    );
    // Re-pinned for fix-pack W1/W2 (capillary band + sub-grid spectrum tail)
    // — the deliberate-change flow this assertion prescribes.
    expect(sha256(WATER_FRAGMENT_WGSL)).toBe(
      "9dfb9dda1374afb774ce17d4a59f4e5c0c832a039fb191431fcfb80886f026eb",
    );
  });

  it("gives both water surfaces the one shared shading text (2-9)", () => {
    // Exactly one definition each, and it is the shared block verbatim —
    // a second textual copy is the §3.6 drift this file exists to prevent.
    for (const fragment of [WATER_FRAGMENT_WGSL, HYDROLOGY_WATER_FRAGMENT_WGSL]) {
      expect(fragment).toContain(WATER_FRESNEL_SCHLICK_WGSL);
      expect(fragment.split("fn fresnelSchlick").length).toBe(2);
      // 2-9: ONE solid-angle sun lobe everywhere; the pre-2-9 assemblies and
      // their gains are gone.
      expect(fragment).toContain(WATER_SUN_SPECULAR_WGSL);
      expect(fragment.split("fn sunSpecular").length).toBe(2);
      expect(fragment).toContain(WATER_FOAM_WGSL);
      expect(fragment).not.toContain("distributionGgx");
      expect(fragment).not.toContain("ggxSpecular");
      expect(fragment).not.toContain("* 2.6 *");
      expect(fragment).not.toContain("nDotL * 4.0");
      // The fake specular sun discs died with 2-9.
      expect(fragment).not.toContain("3200.0");
      expect(fragment).not.toContain("1800.0");
    }
  });

  it("keeps the divergent reflected-sky constants named and deliberate", () => {
    // The ocean/hydrology difference is a parameter value at the call site,
    // not two literals: both texts come from the same generator.
    expect(WATER_FRAGMENT_WGSL).toContain(
      waterReflectedSkyWgsl({
        horizonFalloffExponent: 2.5,
        overcastZenithColor: [0.34, 0.39, 0.45],
        overcastHorizonColor: [0.58, 0.63, 0.68],
      }),
    );
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(
      waterReflectedSkyWgsl({
        horizonFalloffExponent: 2.3,
        overcastZenithColor: [0.31, 0.36, 0.41],
        overcastHorizonColor: [0.56, 0.61, 0.65],
      }),
    );
  });

  it("formats integer parameters as WGSL float literals", () => {
    const text = waterReflectedSkyWgsl({
      horizonFalloffExponent: 2,
      overcastZenithColor: [0, 0.5, 1],
      overcastHorizonColor: [1, 1, 1],
    });
    expect(text).toContain("2.0);");
    expect(text).toContain("vec3f(0.0, 0.5, 1.0)");
  });
});
