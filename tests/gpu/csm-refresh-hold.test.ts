/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { FlightRenderer } from "../../src/render/FlightRenderer";
import type { WebGpuFrameGraph } from "../../src/render/webgpu/core/FrameGraph";
import {
  __setProfileOverrideForCaptureExperimentsOnly,
  resolveWebGpuQualityProfile,
} from "../../src/render/webgpu/core/QualityProfile";
import { createWorld, sampleTerrain } from "../../src/world";
import { PERF_CAPTURE_SEED } from "../../scripts/perf-capture.mts";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../../src/game/types";

/**
 * PR B part 2 (G5, R1): the sun-shadow map held on a real adapter.
 *
 * Medium/balanced with `shadowRefreshFrames` 2 (the override the positive
 * control PC1 also uses). The Node test proves the interval reaches the
 * target and Babylon's counter honours it; this one proves what the renderer
 * does with it, through the whole frame:
 *
 *  - the CSM renders on every other frame while the aircraft flies on, so
 *    nothing else (a direct render, a per-frame interval write) defeats it;
 *  - a held frame keeps the cascade matrices the map was drawn with, though
 *    the camera has moved: Babylon computes them only inside a render, so
 *    every receiver samples the map with the matrices that drew it;
 *  - a history invalidation (here the floating-origin rebase's) draws the
 *    next frame fresh.
 *
 * A mesh that is not ready resets Babylon's counter (design §19 #3), so the
 * flight streams first and is measured once the world has settled.
 */

const WARM_UP_FRAMES = 900;

interface RendererInternals {
  readonly atmosphere: { readonly shadows: CascadedShadowGenerator };
  readonly graph: WebGpuFrameGraph;
}

describe("the CSM refresh hold (G5)", () => {
  it("renders every other frame, holds its matrices with the map, and redraws after an invalidation", async () => {
    const canvas = document.createElement("canvas");
    canvas.style.width = "640px";
    canvas.style.height = "360px";
    document.body.appendChild(canvas);
    let renderer: FlightRenderer | null = null;
    __setProfileOverrideForCaptureExperimentsOnly({ shadowRefreshFrames: 2 });
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
        // Pinned, as the captures are: both governors stay at (0, 0), so no
        // rung adds a frame and no resolution step forces a refresh while the
        // hold is measured, however slow the adapter.
        pinnedRenderScale: resolveWebGpuQualityProfile("medium", "balanced").renderScale,
        ...(world.airport ? { runway: world.airport } : {}),
      });
      const internals = renderer as unknown as RendererInternals;

      let frame = 0;
      const step = (): void => {
        frame += 1;
        const simulationTime = frame / 60;
        // The aircraft flies on at its airspeed, so the camera moves every frame.
        const state: FlightVisualState = {
          ...INITIAL_VISUAL_STATE,
          position: { ...INITIAL_VISUAL_STATE.position, x: INITIAL_VISUAL_STATE.position.x + 58 * simulationTime },
          simulationTime,
        };
        renderer!.render(state, 1 / 60);
      };
      for (let warm = 0; warm < WARM_UP_FRAMES; warm += 1) {
        step();
        if (warm % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const shadows = internals.atmosphere.shadows;
      const shadowMap = shadows.getShadowMap();
      expect(shadowMap, "medium/balanced has a sun-shadow map").not.toBeNull();
      expect(shadowMap!.refreshRate).toBe(2);
      // One notification per cascade layer; a frame counts once.
      const renderedFrames = new Set<number>();
      shadowMap!.onBeforeRenderObservable.add(() => { renderedFrames.add(frame); });

      const rendered: boolean[] = [];
      const matrices: Matrix[] = [];
      for (let measured = 0; measured < 6; measured += 1) {
        step();
        rendered.push(renderedFrames.has(frame));
        matrices.push(shadows.getCascadeTransformMatrix(0)!.clone());
      }
      expect(rendered.filter(Boolean)).toHaveLength(3);
      for (let index = 1; index < rendered.length; index += 1) {
        expect(rendered[index], `frame ${index} of 6 alternates`).toBe(!rendered[index - 1]);
        // A held frame keeps the matrices its map was drawn with.
        if (!rendered[index]) expect(matrices[index]!.equals(matrices[index - 1]!)).toBe(true);
      }
      // Non-vacuity: the camera moved, so a rendered frame drew new matrices.
      expect(matrices.some((matrix, index) => index > 0 && !matrix.equals(matrices[index - 1]!))).toBe(true);

      // Invalidate on a frame after a render, so the next would be held.
      if (!rendered[rendered.length - 1]) step();
      internals.graph.invalidateHistory("floating origin shifted");
      step();
      expect(renderedFrames.has(frame), "the frame after an invalidation renders").toBe(true);
    } finally {
      __setProfileOverrideForCaptureExperimentsOnly(null);
      renderer?.dispose();
      canvas.remove();
    }
  }, 300_000);
});
