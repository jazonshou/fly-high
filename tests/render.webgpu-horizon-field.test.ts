import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HORIZON_FIELD_AZIMUTHS_MARCHED,
  HORIZON_FIELD_AZIMUTHS_STORED,
  HORIZON_FIELD_LOOKUP_WGSL,
  HORIZON_FIELD_MARCH_STEPS,
  HORIZON_FIELD_MARCH_WGSL,
} from "../src/render/webgpu/terrain/HorizonField";
import { GLOBAL_HORIZON_PYRAMID_WGSL } from "../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  PAGE_HORIZON_AZIMUTHS,
  PAGE_OCCLUSION_AZIMUTHS,
  PAGE_OCCLUSION_STEPS,
  PAGE_OCCLUSION_WGSL,
} from "../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_SPAN_METERS,
  TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS,
  TERRAIN_HORIZON_PYRAMID_EDGE,
  TERRAIN_HORIZON_PYRAMID_SPAN_METERS,
  TERRAIN_HORIZON_PYRAMID_TEXEL_METERS,
} from "../src/render/webgpu/terrain/TerrainSpineContract";

/**
 * `6-11`: the horizon operator has ONE owner, and both sides compose it.
 *
 * This is the architectural half of the item, and it is the half a GPU test
 * cannot see: two shaders that each compute a correct horizon from their own
 * copy of the arithmetic would pass every numeric check in
 * `tests/gpu/terrain-horizon-pyramid.test.ts` and still be exactly the defect
 * `6-8` refused to introduce — a second answer to "is this point in terrain
 * shadow", free to drift on the next edit to either copy.
 *
 * So these assertions are about COMPOSITION, not about values.
 */

const REPO = join(__dirname, "..");

function source(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

/** WGSL with comments removed, so a scan cannot be fooled by prose. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const PRODUCERS: ReadonlyArray<readonly [string, string]> = [
  ["page occlusion bake", PAGE_OCCLUSION_WGSL],
  ["global horizon pyramid", GLOBAL_HORIZON_PYRAMID_WGSL],
];

const CONSUMER_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["terrain surface", "src/render/webgpu/terrain/TerrainSurfacePlugin.ts"],
  ["detail impostors", "src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts"],
];

describe("horizon field operator (6-11)", () => {
  it("is composed by BOTH producers, and restated by neither", () => {
    for (const [name, wgsl] of PRODUCERS) {
      const code = stripComments(wgsl);
      expect(code, `${name} does not compose the shared march`)
        .toContain("fn horizonFieldMarch(");
      expect(code, `${name} does not compose the shared packing`)
        .toContain("fn horizonFieldPack(");
      // Composed exactly once: a double include is a redefinition error on
      // the adapter, and the string test is what catches it before the bake.
      expect(
        code.match(/fn horizonFieldMarch\(/g)?.length ?? 0,
        `${name} composes the march more than once`,
      ).toBe(1);
      // The composition hole, defined by the producer and not by the operator.
      expect(
        code.match(/fn horizonFieldHeightAt\(/g)?.length ?? 0,
        `${name} must define the height hole exactly once`,
      ).toBe(1);
      // The march's own body must appear ONLY inside the shared text. If a
      // producer grows its own copy of the accumulation, this catches it.
      const marchBody = "maxSlope = max(maxSlope,";
      expect(
        code.split(marchBody).length - 1,
        `${name} restates the march accumulation instead of composing it`,
      ).toBe(1);
    }
  });

  it("is composed by BOTH consumers, and restated by neither", () => {
    for (const [name, path] of CONSUMER_SOURCES) {
      const code = source(path);
      expect(code, `${name} does not import the shared lookup`)
        .toContain("HORIZON_FIELD_LOOKUP_WGSL");
      expect(code, `${name} does not call the shared lookup`)
        .toContain("horizonFieldShadow(");
      // The lookup's distinctive arithmetic — the azimuth index's half-step
      // correction — must live in ONE place. A consumer that restates it is
      // free to drift by half a bin, which is precisely the disagreement
      // between representations this item exists to remove.
      expect(
        stripComments(code),
        `${name} restates the azimuth index arithmetic`,
      ).not.toContain("- 0.5;\n  let wrapped");
    }
  });

  it("keeps the house traps out of the shared operator", () => {
    for (const [name, wgsl] of [
      ["march", HORIZON_FIELD_MARCH_WGSL],
      ["lookup", HORIZON_FIELD_LOOKUP_WGSL],
    ] as const) {
      const code = stripComments(wgsl);
      // A reversed `smoothstep(high, low, x)` turns the soft terminator into a
      // hard step — the recorded degeneracy that shipped ten broken masks.
      const reversed: string[] = [];
      for (const match of code.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/g)) {
        if (Number(match[2]!) <= Number(match[1]!)) reversed.push(match[0]);
      }
      expect(reversed, `${name}: reversed smoothstep at ${reversed.join(", ")}`).toEqual([]);
      // A sin/fract hash collapses into rows at world-anchored ids.
      expect(code, `${name} uses a sin-fract hash`).not.toMatch(/fract\s*\(\s*sin\s*\(/);
      // No literal backticks: the WGSL is emitted from a template literal and
      // one stray backtick truncates the shader (the terrain-wetness trap).
      expect(code, `${name} emits a literal backtick into WGSL`).not.toContain("`");
    }
    // The one smoothstep in the operator is `horizonSin - band` against
    // `horizonSin + band`, which the literal scan above cannot see. It is
    // reversed only if `band` is negative, and every caller floors it
    // positive — the terrain at max(grid.w, 0.03), the detail path at the
    // named DETAIL_HORIZON_SOFT_BAND constant.
    expect(stripComments(HORIZON_FIELD_LOOKUP_WGSL))
      .toContain("smoothstep(horizonSin - band, horizonSin + band, jitteredSun)");
  });

  it("keeps the page bake's published vocabulary and its baked bits", () => {
    // The extraction may not move a single baked bit: these constants were
    // load-bearing for every page already on disk.
    expect(PAGE_OCCLUSION_AZIMUTHS).toBe(16);
    expect(PAGE_HORIZON_AZIMUTHS).toBe(8);
    expect(PAGE_OCCLUSION_STEPS).toBe(24);
    expect(HORIZON_FIELD_AZIMUTHS_MARCHED).toBe(PAGE_OCCLUSION_AZIMUTHS);
    expect(HORIZON_FIELD_AZIMUTHS_STORED).toBe(PAGE_HORIZON_AZIMUTHS);
    expect(HORIZON_FIELD_MARCH_STEPS).toBe(PAGE_OCCLUSION_STEPS);
    // Eight stored azimuths is exactly two rgba8 texels. A change to either
    // number without the other silently drops or invents a lane.
    expect(HORIZON_FIELD_AZIMUTHS_STORED).toBe(8);
    expect(HORIZON_FIELD_AZIMUTHS_MARCHED).toBe(HORIZON_FIELD_AZIMUTHS_STORED * 2);
  });

  it("pins the global field to the height pyramid's span", () => {
    // The consumer maps world -> uv with ONE subtract and ONE multiply against
    // a published origin. If the spans diverge, that mapping shears against
    // the height field the bake marched, and the error is a smooth wrong
    // answer rather than a crash.
    expect(TERRAIN_HORIZON_PYRAMID_SPAN_METERS).toBe(TERRAIN_HEIGHT_PYRAMID_SPAN_METERS);
    expect(TERRAIN_HORIZON_PYRAMID_EDGE * TERRAIN_HORIZON_PYRAMID_TEXEL_METERS)
      .toBe(TERRAIN_HEIGHT_PYRAMID_EDGE * TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS);
    // Coarser than the field it marches, and by a whole factor — a fractional
    // ratio would put horizon texel centres at irrational offsets from height
    // texel centres for no benefit.
    expect(TERRAIN_HORIZON_PYRAMID_TEXEL_METERS % TERRAIN_HEIGHT_PYRAMID_TEXEL_METERS).toBe(0);
    expect(TERRAIN_HORIZON_PYRAMID_EDGE).toBeLessThan(TERRAIN_HEIGHT_PYRAMID_EDGE);
  });

  it("reaches the shared detail material without a per-chunk lane", () => {
    // THE constraint that killed 6-8's routes. Detail materials are shared
    // across every presentation chunk — that sharing IS the draw-call
    // architecture RENDERING_PLAN.md:837's ratchet protects — so anything the
    // impostor path reads must be either per-instance or frame-global. A page
    // uniform here would silently split one material into many.
    const code = stripComments(source(
      "src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts"));
    expect(code).toContain("uniforms.detailHorizonField");
    // No CDLOD slot lane, no page-atlas addressing, no per-chunk uniform.
    for (const forbidden of ["terrainNodeB", "terrainSurfacePageUv", "channelSlot"]) {
      expect(code, `the impostor horizon path reads ${forbidden}, a per-chunk lane`)
        .not.toContain(forbidden);
    }
    // Exactly one vec4 of new uniform, and two samplers — the whole cost of
    // the lane-free route, recorded so a later edit cannot quietly grow it.
    expect(code.match(/name: "detailHorizonField"/g)?.length ?? 0).toBe(1);
    expect(code).toContain('samplers.push("detailHorizonAtlasA")');
    expect(code).toContain('samplers.push("detailHorizonAtlasB")');
  });

  it("multiplies the term into DIRECT light, and only direct light", () => {
    // The last link in the behaviour chain. `horizon-shadow-operator.test.ts`
    // proves the operator returns a darkening scalar on a real adapter; this
    // proves the impostor fragment actually applies it, and applies it where
    // a sun occluder belongs. A term computed and dropped would pass every
    // other test in this file and every GPU test in the item.
    const code = stripComments(source(
      "src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts"));
    // The cascade term and the horizon term compose into ONE scalar...
    expect(code).toMatch(
      /impostorSunShadow = impostorCascadeShadow \* detailHorizonShadow\(/u);
    // ...which multiplies diffuse and specular — but PER DIRECTIONAL LIGHT,
    // not over the accumulator.
    //
    // 7-4b MOVED THIS APPLICATION SITE, and the move STRENGTHENS what this
    // test is named for. The old form was `finalDiffuse *= impostorSunShadow`
    // over the whole light sum. That was "direct light, and only direct light"
    // only for as long as the sum contained nothing but the sun — and a
    // `ClusteredLightContainer` puts clustered lamps into exactly that
    // accumulator, so a runway or landing light would have been dimmed by SUN
    // occlusion. The title was becoming false; under the per-light form it is
    // true again.
    //
    // Attenuating `diffuse{X}.rgb` still covers diffuse AND specular, because
    // `computeDiffuseLighting` and `computeSpecularLighting` both take it —
    // so this asserts the same behaviour the two removed lines did, at a site
    // that cannot reach a clustered light.
    expect(code).toContain("diffuse$2 = vec4f(diffuse$2.rgb * impostorSunShadow, diffuse$2.a);");
    // Guarded on DIRLIGHT, which is what makes it sun/moon-only rather than
    // every light. A hard-coded light index would break the moment anyone
    // reorders the sun/ambient/moon construction.
    expect(code).toContain("#ifdef DIRLIGHT$2");
    // The anchor itself, with the alternation the terrain mirror also needs:
    // at runtime the marker reads CUSTOM_LIGHT0_COLOR so `\d+` matches, but the
    // shipped Babylon file still says `{X}`, and a digits-only anchor matches
    // nothing there.
    expect(code).toContain(String.raw`!(#define CUSTOM_LIGHT(\{X\}|\d+)_COLOR)`);
    // And the OLD form must not come back: it is the failure this item's
    // successor had to undo.
    expect(code, "the whole-accumulator multiply is back; it dims clustered lights by sun occlusion")
      .not.toContain("finalDiffuse *= impostorSunShadow");
    // ...and NOTHING else. Ambient/irradiance must not carry it: a horizon
    // occludes the SUN, and multiplying it into ambient too would darken the
    // same stand twice for one occluder — the reason 6-8 put the canopy term
    // at this same hook rather than into ambient.
    for (const forbidden of [
      "finalIrradiance *= impostorSunShadow",
      "finalAmbient *= impostorSunShadow",
      "surfaceAlbedo *= impostorSunShadow",
    ]) {
      expect(code, `the horizon term reaches ${forbidden} — ambient is not the sun`)
        .not.toContain(forbidden);
    }
  });

  it("declares its define, rather than relying on rebuild() to find it", () => {
    // A plugin define missing from the constructor map survives only because
    // `MaterialDefines.rebuild()` re-derives its key list from Object.keys.
    // That is a Babylon implementation detail; the recorded incident
    // (DETAIL_BAND_FADES) is what a stripped define costs — an invisible
    // forest of 1%-dither speckle, with every binding still correct.
    const code = source("src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts");
    const constructorMap = /_enable|DETAIL_HORIZON_SHADOW: false/.exec(code);
    expect(constructorMap, "DETAIL_HORIZON_SHADOW is not declared").not.toBeNull();
    expect(code).toContain("DETAIL_HORIZON_SHADOW: false");
    expect(code).toContain('defines["DETAIL_HORIZON_SHADOW"]');
  });
});
