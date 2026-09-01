import { describe, expect, it } from "vitest";

import { pbrBlockReflectance0WGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/pbrBlockReflectance0";
import { pbrClusteredLightingFunctionsWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/pbrClusteredLightingFunctions";

import { TERRAIN_SURFACE_INJECTION_ANCHORS } from "../src/render/webgpu/terrain/TerrainSurfacePlugin";

/**
 * `7-4b`: the reflectance anchor must match ONCE, in `main`, and never inside
 * Babylon's clustered-lighting helper.
 *
 * **The defect this pins was found on a real adapter and cost an hour of wrong
 * mechanisms first.** A `ClusteredLightContainer` makes Babylon include
 * `<pbrBlockReflectance0>` a second time inside `fn computeClusteredLighting2`.
 * That block is where the anchor's text lives, the plugin's replacement is
 * global, so the terrain override landed in the helper too — where
 * `terrainSurfaceF0` is a local of `main` 1,700 lines later, and where
 * `reflectivityOut` is an immutable function parameter. Two independent
 * reasons the injection cannot live there.
 *
 * **Everything here is read from Babylon's SHIPPED shader text**, not from a
 * copy of it, because the whole failure was a mismatch between what the source
 * says and what gets compiled. A Node test is enough: the anchor is a regex
 * over text, and no GPU is needed to know how many times it matches.
 *
 * **What this does NOT cover:** it does not prove the compiled shader is
 * correct, only that the anchor lands where intended. The adapter spike
 * (`tests/gpu/clustered-lighting-adapter-spike.test.ts`) is what proves both
 * permutations compile.
 */

/** Parse an anchor the way `materialPluginManager` does: strip `!`, force "g". */
function anchorRegExp(anchor: string): RegExp {
  expect(anchor.startsWith("!"), "anchors are regex-flavoured and start with !").toBe(true);
  return new RegExp(anchor.slice(1), "gu");
}

/** The helper's text with its one `#include` resolved, as Babylon would emit it. */
function expandedHelper(): string {
  return pbrClusteredLightingFunctionsWGSL.shader.replace(
    /#include<pbrBlockReflectance0>/gu,
    pbrBlockReflectance0WGSL.shader,
  );
}

describe("the terrain reflectance anchor", () => {
  it("is duplicated by Babylon, which is the reason the lookbehind exists", () => {
    // If this ever fails, the helper stopped including the block and the
    // lookbehind became unnecessary — harmless, but the docblock is then wrong.
    expect(
      pbrClusteredLightingFunctionsWGSL.shader,
      "the clustered helper no longer includes pbrBlockReflectance0",
    ).toContain("#include<pbrBlockReflectance0>");
    expect(
      pbrBlockReflectance0WGSL.shader,
      "pbrBlockReflectance0 no longer declares specularEnvironmentR0 — the anchor "
      + "text moved and this anchor may now match nothing at all",
    ).toContain("var specularEnvironmentR0: vec3f=reflectivityOut.colorReflectanceF0;");
  });

  it("pins the exact upstream text the lookbehind discriminates on", () => {
    // THE COUPLING, NAMED. The discriminator is the helper's own preamble. A
    // Babylon reformat that changes this whitespace or spelling would make the
    // lookbehind stop excluding the helper, and the failure would otherwise
    // surface as a shader compile error nobody connects to an upstream bump.
    expect(
      pbrClusteredLightingFunctionsWGSL.shader,
      "the clustered helper's preamble changed upstream. The reflectance anchor's "
      + "negative lookbehind keys on this exact text; update both together.",
    ).toContain(")->lightingInfo {let NdotV=absEps(dot(N,V));");
  });

  it("matches exactly once when both occurrences are present", () => {
    // The behavioural pin. Build a source carrying BOTH sites — the helper's
    // expanded copy and a bare `main`-like copy — and require the anchor to
    // select only the second.
    const helper = expandedHelper();
    const mainLike = `\nvar reflectivityOut: reflectivityOutParams;\n${pbrBlockReflectance0WGSL.shader}\n`;
    const source = `${helper}\n${mainLike}`;

    const matches = [...source.matchAll(anchorRegExp(TERRAIN_SURFACE_INJECTION_ANCHORS.reflectance))];
    expect(
      matches.length,
      `the anchor matched ${matches.length} times; it must match exactly once, in main`,
    ).toBe(1);
    // And the survivor is the one AFTER the helper, not inside it.
    expect(matches[0]!.index).toBeGreaterThan(helper.length);
  });

  it("would match twice without the lookbehind, so the guard is not decorative", () => {
    // Non-vacuity: if the naive anchor also matched once, the lookbehind would
    // be protecting against nothing and this whole file could be deleted.
    const naive = /var specularEnvironmentR0: vec3f=reflectivityOut\.colorReflectanceF0;/gu;
    const source = `${expandedHelper()}\n${pbrBlockReflectance0WGSL.shader}\n`;
    expect([...source.matchAll(naive)].length).toBe(2);
  });

  it("still captures the anchor text for the $1 back-reference", () => {
    // `ReplaceRegExpSubstitutions` supports only numeric back-references, and
    // the injected code re-emits `$1`. Adding a lookbehind must not have
    // shifted the capturing group — if it did, the anchor line would be
    // DELETED from the shader rather than kept, silently.
    const matches = [
      ...pbrBlockReflectance0WGSL.shader.matchAll(
        anchorRegExp(TERRAIN_SURFACE_INJECTION_ANCHORS.reflectance),
      ),
    ];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("var specularEnvironmentR0: vec3f=reflectivityOut.colorReflectanceF0;");
  });
});
