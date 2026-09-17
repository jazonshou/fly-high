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
    //
    // Re-pinned by NIGHT_LOOK §2.6 (twilight arch). FRAGMENT ONLY, and the
    // delta is exactly ONE line of the shared aerial include: the
    // `aerialTwilightArch` uniform DECLARATION (plus the arch term inside
    // `skyRadiance`, which the water fragment composes but never calls).
    // The ocean's own shading text did not move — no lighting, no foam, no
    // spectrum change — and the unchanged vertex hash is the claim that the
    // include's growth is declaration-side only where the vertex is
    // concerned. Water pixels cannot move: the uniform is zero-filled
    // outside the twilight window and the fragment never evaluates the sky
    // function that consumes it. Deliberate, named, reviewed — the flow
    // this assertion exists to force.
    //
    // Re-pinned by NIGHT_LOOK §2.6 round G (night zenith fade). FRAGMENT
    // ONLY, declaration-side again: the `aerialNightZenithFade` uniform
    // declaration plus the fade line inside `skyRadiance`, which the water
    // fragment composes but never calls. The vertex hash is byte-for-byte
    // unchanged for the third consecutive include growth, and water pixels
    // cannot move for the same reason as the arch's re-pin: the uniform is
    // zero-filled by day and the fragment never evaluates the sky function
    // that consumes it. Deliberate, named, reviewed.
    //
    // Re-pinned by NIGHT_LOOK §2.6 round W (sunset lobe + Belt of Venus).
    // FRAGMENT ONLY, declaration-side for the fourth time: three uniform
    // declarations (warm, belt, sunset direction) plus the lobe lines
    // inside `skyRadiance`, which the water fragment composes but never
    // calls. The vertex hash is byte-for-byte unchanged for the fourth
    // consecutive include growth; water pixels cannot move — the uniforms
    // are zero-filled outside the twilight window and the fragment never
    // evaluates the sky function that consumes them. Deliberate, named,
    // reviewed.
    //
    // Re-pinned by NIGHT_LOOK §2.6 round O(b) (the Belt's own tighter
    // fold). FRAGMENT ONLY, fifth consecutive include growth with the
    // vertex byte-identical: two lines inside `skyRadiance` (the beltHug
    // term and the split sunset composition), which the water fragment
    // composes but never calls. Same reasoning as every prior re-pin:
    // water pixels cannot move. Deliberate, named, reviewed.
    //
    // Re-pinned by the Phase-6 ocean closeout. Unlike the declaration-only
    // night-sky include changes above, this is deliberate water output churn:
    // coverage now uses still-water bathymetry and discards dry fragments,
    // foam cannot reopen dry alpha, the near/far bathymetry handoff blends,
    // and shader-owned diffuse radiance follows the atmosphere's raw
    // skylight/direct-sun illuminance. The focused real-adapter capture is the review
    // artifact for that coupled coverage/radiometry correction.
    // Re-pinned once more by the final audit: the ocean's local wave-face
    // subsurface term now consumes the already illuminance-premultiplied sun
    // colour, closing the last shader-owned green emission path at night.
    //
    // Re-pinned 2026-09-03: VERTEX ONLY. The 1C-7 Earth-curvature drop
    // (`displaced.y -= r^2 / 2R`) is withdrawn from the vertex stage — the
    // terrain and the depth buffer the sea is tested against are flat, and the
    // drop pushed every shelf bed shallower than it up through the surface at
    // distance (a dark seabed band along each far coast in cruise-horizon).
    // The fragment hash below is byte-for-byte unchanged, which is the claim
    // that this moved geometry only. Deliberate, named, reviewed — the flow
    // this assertion exists to force; the decision is in ARCHITECTURE.md.
    //
    // Re-pinned 2026-09-14 by wave S (the far field), BOTH stages. Vertex:
    // the lattice-Nyquist displacement fade keys on the ring's horizontal
    // radius and the pixel fade on slant range, instead of one min() on slant
    // range that deleted the swell geometry from 545 m of altitude up.
    // Fragment: a mean-one sun-glint sparkle on the Karis lobe, distant
    // whitecap flecks spent from the foam mip mean, a drifting far gust field
    // on the short-wave slope variance, and the rough-interface Fresnel.
    // Each is pinned by name in tests/render.webgpu-water-far-field.test.ts;
    // the decision is in ARCHITECTURE.md.
    //
    // Re-pinned 2026-09-14 (wave S, second pass), BOTH stages: the whitecap
    // flecks became the same screen-hashed mean-one twinkle the glints use
    // (the per-pixel cell search cost 15 ms a frame with the sea in the lower
    // half of the frame), the far gust's 1.5 km octave moved to a vertex
    // varying with a warped 380 m octave per pixel (the unwarped lattice read
    // as rows of drifting blobs in the glitter path), and the sparkle hash is
    // a one-lane integer hash.
    // Re-pinned by W-8c: the province index passes through a contrast curve
    // (smoothstep 0.18..0.82, the identity at mid-province) before it reaches
    // the concentrations, and the resuspended sediment load follows the
    // province's runoff instead of being the same ~7.7 g/m^3 on every coast in
    // the world — which is why no sea bed used to read through anywhere.
    // Deliberate, named, reviewed.
    //
    // Re-pinned by W-8b (the province's widened authority): the chlorophyll and
    // CDOM responses are steeper, the analytic bed takes the province's runoff
    // so a dry coast's sand is pale and a wet one's silt is dark, and the
    // whitecap pattern is bounded at eight times its own mean. Deliberate,
    // named, reviewed.
    //
    // Re-pinned by W-10's occlusion correction: the horizon test is softened by
    // the reflection LOBE's own width and takes no jitter (the shared operator
    // applies jitter as a fraction of the band, so a wide band turned it into
    // per-pixel salt), and the occluded hillside is hazed by the shared aerial
    // operator at the fragment's own range. Deliberate, named, reviewed.
    //
    // Re-pinned by W-10 (the far field's variation). BOTH hashes move again.
    // The VERTEX gained the extracted bathymetry lookup and the four-tap
    // upwind march that measures wind shelter, plus the two horizon-field
    // samples it hands the fragment (the fragment has no sampler free, so the
    // packed values ride two varyings and the fragment evaluates the SHARED
    // horizon operator against its own per-pixel reflection direction). The
    // FRAGMENT gained that occlusion of the reflected sky, the sheltered wind
    // driving both the Cox-Munk anchor and Monahan's coverage, and the
    // Langmuir windrow comb. Deliberate, named, reviewed.
    //
    // Re-pinned by W-8 (the water-type field). BOTH hashes move, and the
    // VERTEX one for the first time since wave S: the ocean vertex now samples
    // the baked environment field (productivity, runoff) and carries it to the
    // fragment as a varying, because the fragment stage has no free sampler —
    // it declares exactly the 16 sampled textures the device limit allows.
    // The fragment gained the shared constituent model and the sea's own
    // chemistry law (open-ocean chlorophyll to coastal green by depth, the
    // land's runoff from the field, and surf-zone resuspension), which
    // replaces the single bound optical type. Deliberate, named, reviewed.
    //
    // Re-pinned by W-9 (the far field's own statistics). FRAGMENT ONLY again,
    // and the vertex hash below has still not moved since wave S. The fragment
    // gained the Cox-Munk anchor for sub-pixel slope variance (one identity
    // replacing a sum of independent estimates, applied only outside the
    // near-field window, so the near field is bit-identical), a roughness
    // ceiling at 0.6 instead of 0.5 (0.5 IS Cox-Munk at 9.7 m/s, so the
    // shipped world sat on the clamp), Monahan's whitecap coverage with the
    // spectrum's breaking field normalised by its own coarsest mip, and the
    // split of foam into wind whitecaps at Koepke's effective 0.22 and surf at
    // fresh-foam 0.5, both lit by the shared downwelling irradiance. Deliberate,
    // named, reviewed.
    //
    // Re-pinned by W-7 (the optical water type and the physical body model).
    // FRAGMENT ONLY — the vertex hash below is byte-for-byte the one wave S
    // left, which is the claim that W-7 moved no displacement, no varying and
    // no spectrum: it is a shading change and nothing else. The fragment
    // gained the `waterAbsorption`/`waterBackscatter` uniforms and the shared
    // depth include's new body model (Lee et al.'s two-term shallow-water
    // reflectance, the refracted solar and upwelling path lengths, and the
    // coloured downwelling irradiance split into its collimated and diffuse
    // shares), and LOST three fixed-teal terms and the grey illuminance
    // scalar: the turbidity in-scatter, `subsurfaceScatter` and
    // `horizonScatter`. It also lost the now-unused `sunIlluminanceNormalized`
    // uniform, and its crest-SSS call gained the water type's own transmission
    // tint. This MOVES PIXELS on every shot with water in it, by design — deep
    // water is now two orders of magnitude darker in green, and every water
    // body takes its colour from the scene's own light. Those shots rebaseline
    // once the whole W-7/W-8 wave has landed, not here. Deliberate, named,
    // reviewed — the flow this assertion exists to force.
    expect(sha256(WATER_VERTEX_WGSL)).toBe(
      "39bd19b4fb34b8697aaf57c1fc83d98620fbc22bf8537a9c93372ea611a058e9",
    );
    expect(sha256(WATER_FRAGMENT_WGSL)).toBe(
      "dbaf539b86cf7e8d8e41a6e24513d279fae3bea54f7e3adb0e971a2c269ac6fb",
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
