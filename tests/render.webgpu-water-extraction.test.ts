import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
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
    // Re-pinned by wave R. The vertex stage gained the shared ripple lattices
    // (fix 3's detail displacement) and the mesh-Nyquist displacement fade
    // (fix 4); the fragment gained the anisotropy-limited footprint (fix 1),
    // the roughness field (fix 2), two anisotropic capillary octaves and the
    // glint jitter (fixes 3 and 7), the shore foam band (fix 6) and the single
    // wind owner (fix 8). Deliberate, named, reviewed — which is the flow this
    // assertion exists to force.
    expect(sha256(WATER_VERTEX_WGSL)).toBe(
      "26e9899e6aeb107c84a642dd8b315b54e8253e058e010b7d1ffd0c934e94ff9d",
    );
    expect(sha256(WATER_FRAGMENT_WGSL)).toBe(
      "57bca0f3614fff9153d7ce6ebfd0b12e35111aee21dce5c723243c9d8abe7e7f",
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

  it("includes the definition of every shared helper each module calls", () => {
    // wave R added this. Splitting the capillary block into a derivative-free
    // noise half (so the ocean VERTEX stage can share it) made it possible to
    // compose a module that calls `waterRippleGradA` without including the
    // block that defines it — which is not a test failure, it is a shader that
    // never compiles and a renderer stuck on "PREPARING AIRSPACE". It happened
    // once while wave R was being written. Every composed water module is
    // checked here instead.
    const shared = readFileSync(
      join(__dirname, "..", "src", "render", "webgpu", "water", "WaterShaders.ts"),
      "utf8",
    );
    const helpers = [...shared.matchAll(/^fn ([A-Za-z0-9_]+)\(/gmu)].map((match) => match[1]!);
    expect(helpers.length).toBeGreaterThan(8);
    const modules: ReadonlyArray<readonly [string, string]> = [
      ["ocean vertex", WATER_VERTEX_WGSL],
      ["ocean fragment", WATER_FRAGMENT_WGSL],
      ["hydrology vertex", HYDROLOGY_WATER_VERTEX_WGSL],
      ["hydrology fragment", HYDROLOGY_WATER_FRAGMENT_WGSL],
    ];
    for (const [label, source] of modules) {
      const definitions = new Set(
        [...source.matchAll(/^fn ([A-Za-z0-9_]+)\(/gmu)].map((match) => match[1]!),
      );
      for (const helper of helpers) {
        // A definition line is also a "call" by this crude test; count only
        // uses that are not the definition itself.
        const uses = source.split(`${helper}(`).length - 1;
        const defined = definitions.has(helper);
        if (uses > (defined ? 1 : 0)) {
          expect(defined, `${label} calls ${helper} without including its definition`).toBe(true);
        }
        // And never twice — a second textual copy is the §3.6 drift the
        // extraction gate exists to prevent.
        expect(
          [...source.matchAll(new RegExp(`^fn ${helper}\\(`, "gmu"))].length,
          `${label} defines ${helper} more than once`,
        ).toBeLessThan(2);
      }
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
