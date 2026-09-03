/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { FlightRenderer } from "../../src/render/FlightRenderer";
import { createWorld, sampleTerrain } from "../../src/world";
import { PERF_CAPTURE_SEED } from "../../scripts/perf-capture.mts";
import { INITIAL_VISUAL_STATE } from "../../src/game/types";

/**
 * The impostor band's cascade-shadow receiver must reach the ADAPTER.
 *
 * `DETAIL_SUN_SHADOW` gates the whole far-band sun-shadow receiver
 * (`DetailInstanceMaterialPlugin.ts:618` for the sampler and helpers, `:1064`
 * for the call site). It was written at `:1310` and **never declared in the
 * plugin's constructor define map**, so Babylon — which emits only the declared
 * keys from `MaterialDefines.toString()` — stripped it from every compiled
 * shader. What shipped was the `#else`: `let impostorCascadeShadow = 1.0;`
 * Far vegetation has never received sun shadows while the mesh bands always
 * have, which is a visible tone step at the band handoff.
 *
 * **Nothing at runtime could see this.** The uniforms are declared, the sampler
 * is bound, the shadow map is uploaded every frame; only the shader source
 * differs. Its Node sibling
 * (`tests/render.webgpu-plugin-define-declaration.test.ts`) catches the omission
 * at authoring time across every plugin. This one proves the consequence: that
 * the receiver actually compiles into the effect the device runs.
 *
 * Asserting on `effect.fragmentSourceCode` rather than on `effect.defines` is
 * deliberate — a define can be present in the define string and still fail to
 * reach the source if the `#ifdef` is nested inside a block that itself did not
 * compile, and the source is what the adapter executes.
 */

describe("impostor sun-shadow receiver compiles (P0 seam)", () => {
  it("reaches effect.fragmentSourceCode on a shadowed detail material", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.width = "640px";
    canvas.style.height = "360px";
    document.body.appendChild(canvas);
    let renderer: FlightRenderer | null = null;
    try {
      const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: "analytic" });
      renderer = await FlightRenderer.create({
        canvas,
        aircraft: "trainer",
        terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
        world,
        seed: world.sourceSeedHash,
        quality: "medium",
        renderingMode: "balanced",
        reducedMotion: false,
        ...(world.airport ? { runway: world.airport } : {}),
      });

      // Stream until impostor materials exist and have compiled.
      let simulationTime = 0;
      for (let frame = 0; frame < 900; frame += 1) {
        simulationTime += 1 / 60;
        renderer.render({ ...INITIAL_VISUAL_STATE, simulationTime }, 1 / 60);
        if (frame % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const scene = (renderer as unknown as { scene: {
        readonly meshes: readonly { readonly name: string; readonly subMeshes?: readonly {
          readonly effect?: { readonly fragmentSourceCode: string } | null;
        }[] | null }[];
      } }).scene;

      // Diagnostic: distinguish "define stripped" from "define legitimately
      // false". If the key is absent from effect.defines entirely it was
      // stripped; if present as `#define DETAIL_SUN_SHADOW` it is true; if the
      // scene simply has no shadow map the condition is false and this test is
      // measuring the wrong thing.
      for (const mesh of scene.meshes) {
        if (!mesh.name.startsWith("detail-")) continue;
        for (const sub of mesh.subMeshes ?? []) {
          const d = (sub.effect as unknown as { defines?: string } | null)?.defines;
          if (!d) continue;
          const detailKeys = d.split("\n").filter((l) => l.includes("DETAIL_"));
          console.info(`DIAG ${mesh.name}: ${detailKeys.join(" | ") || "(no DETAIL_ defines)"}`);
          break;
        }
      }

      /**
       * Select by COMPILED DEFINE, not by mesh name.
       *
       * Selecting on `name.startsWith("detail-impostor")` was this test's own
       * first bug: it matched only the prototype template quad `detail-impostor`,
       * which is never drawn and never carries the shadow define, while the
       * meshes the renderer actually submits are `detail-tree-impostor-chunk-*`.
       * The test therefore failed identically before and after the fix and would
       * have reported a working fix as broken. A mesh's NAME is a naming
       * convention; its DEFINES are what compiled.
       */
      const impostorSources: string[] = [];
      for (const mesh of scene.meshes) {
        if (!mesh.name.startsWith("detail-")) continue;
        for (const sub of mesh.subMeshes ?? []) {
          const effect = sub.effect as unknown as
            { readonly defines?: string; readonly fragmentSourceCode?: string } | null;
          if (!effect?.defines?.includes("#define DETAIL_IMPOSTOR")) continue;
          if (effect.fragmentSourceCode) impostorSources.push(effect.fragmentSourceCode);
        }
      }

      // Non-vacuity: with no compiled impostor effect this test proves nothing,
      // and would pass an "absent" assertion trivially.
      expect(
        impostorSources.length,
        "no compiled impostor effect was found — the test is vacuous, not passing",
      ).toBeGreaterThan(0);

      const withReceiver = impostorSources.filter((s) => s.includes("detailSunShadowCascade"));

      expect(
        withReceiver.length,
        `the impostor sun-shadow receiver is ABSENT from all ${impostorSources.length} compiled `
        + "impostor effect(s). `DETAIL_SUN_SHADOW` is not reaching the shader, so the far "
        + "vegetation band renders unshadowed while the mesh bands receive CSM. Check that "
        + "the define is DECLARED in the plugin's constructor define map, not merely assigned "
        + "in prepareDefines — Babylon emits only the declared keys.",
      ).toBeGreaterThan(0);

      /**
       * The real invariant, and the one the bug violated: an effect whose
       * DEFINES carry `DETAIL_SUN_SHADOW` must have the receiver in its SOURCE,
       * and must not have compiled the unshadowed stub.
       *
       * Asserting instead that NO impostor effect contains the stub was too
       * strong and failed on a correct tree: the prototype template quad
       * `detail-impostor` carries `DETAIL_IMPOSTOR` but is never submitted and
       * legitimately has no shadow define, so it compiles the stub forever. The
       * defect was never "a stub exists" — it was "the define says shadowed and
       * the source says otherwise", which is precisely a define/source
       * disagreement and precisely what a stripped define produces.
       */
      let shadowDefined = 0;
      for (const mesh of scene.meshes) {
        if (!mesh.name.startsWith("detail-")) continue;
        for (const sub of mesh.subMeshes ?? []) {
          const effect = sub.effect as unknown as
            { readonly defines?: string; readonly fragmentSourceCode?: string } | null;
          if (!effect?.defines?.includes("#define DETAIL_SUN_SHADOW")) continue;
          shadowDefined += 1;
          const source = effect.fragmentSourceCode ?? "";
          expect(
            source.includes("detailSunShadowCascade"),
            `${mesh.name}: DETAIL_SUN_SHADOW is DEFINED but the receiver is absent from the `
            + "compiled source — a define/source disagreement, the signature of a define that "
            + "Babylon accepted into the string but stripped from the shader.",
          ).toBe(true);
          expect(
            source.includes("let impostorCascadeShadow = 1.0"),
            `${mesh.name}: DETAIL_SUN_SHADOW is defined yet the UNSHADOWED stub compiled`,
          ).toBe(false);
        }
      }
      expect(
        shadowDefined,
        "no detail effect had DETAIL_SUN_SHADOW defined — the far band is unshadowed, or the "
        + "scene never built a shadowed impostor chunk and this assertion is vacuous",
      ).toBeGreaterThan(0);
    } finally {
      renderer?.dispose();
      canvas.remove();
    }
  }, 300_000);
});
