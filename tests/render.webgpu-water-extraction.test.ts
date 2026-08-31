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
    //
    // Re-pinned by 6-4 (bed caustics). The VERTEX text moved only because the
    // shared `waterCapillaryOctave` now also returns its lattice value (the
    // vertex stage composes the noise block but does not call that helper);
    // the FRAGMENT gained the caustic beam and accumulator, the per-cascade
    // Jacobian lanes, the two `causticCurvatureScale` uniforms, and the
    // depth-include-before-capillary ordering the shared caustic block needs.
    // Deliberate, named, reviewed — the flow this assertion exists to force.
    //
    // Re-pinned by 6-2 (shoreline run-up). FRAGMENT ONLY — the vertex hash
    // below is deliberately UNCHANGED, which is itself the claim that 6-2 is a
    // fragment-side delta and moved no displacement, no varying and no mesh
    // Nyquist fade. The fragment gained: the two `cascadeWavelengths` uniforms
    // the dominant-band rule reads, one mean-square-slope lane per cascade
    // (one add each, over moments the shader already samples), the shared
    // `WATER_SHORE_RUNUP_WGSL` / `WATER_SHORE_STREAK_WGSL` blocks, a pixel
    // footprint taken in uniform control flow, and the depth-gated run-up
    // modulation of wave R's shore band. This MOVES PIXELS on `water-3m`,
    // `water-25ft` and `coast-10km-lowsun` by design — the surf now beats with
    // the swell — and those shots rebaseline at the Wave-1 point (§9 R1), not
    // here. Deliberate, named, reviewed: the flow this assertion exists to
    // force.
    //
    // Re-pinned by 6-3 (shallow-water dispersion). FRAGMENT ONLY, and the
    // vertex hash below is byte-for-byte the one 6-2 left — which is the claim
    // that 6-3 is a fragment-side delta too, and a load-bearing one here:
    // shoaling SHORTENS wavelengths, which is exactly the band the mesh-Nyquist
    // fade refuses to carry, so the plan says shade rather than fight it and
    // this unchanged hash is the evidence that nothing tried. The FRAGMENT
    // gained: the shared `WATER_SHOALING_WGSL` block, five per-cascade slope
    // registers (stores of a product the accumulation already forms), the
    // depth < 60 m shelf gate that now wraps 6-2's run-up gate, the shoaled
    // slope delta added to the cascade slope sum, and the depth-limited
    // whitewater folded into `foamAmount`. 6-2's run-up body moved UP with the
    // gate — above the capillary call, so the shoaled slope is the resolved
    // slope the unresolved tail is fitted against and the whitewater reaches
    // `baseRoughness` — and gained the breaking-fraction weight on its bore
    // and streaks. This MOVES PIXELS on `water-3m`, `water-25ft` and
    // `coast-10km-lowsun` by design — the swell now stacks up and breaks where
    // the depth says it must — and those shots rebaseline at the Wave-1 point
    // (§9 R1), not here. Deliberate, named, reviewed.
    expect(sha256(WATER_VERTEX_WGSL)).toBe(
      "79edf5f734fecfa79106907ba59ad20d1d18fbefb5ba5918779ebb330affbfcf",
    );
    expect(sha256(WATER_FRAGMENT_WGSL)).toBe(
      "d38e8078db4263b326c8e0ac0ed2f63b50e1f34abfe7bb3875dfbf1d28e59d21",
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
