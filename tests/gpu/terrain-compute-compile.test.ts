import { describe, expect, it } from "vitest";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GLOBAL_HEIGHT_PYRAMID_WGSL } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import { PAGE_OCCLUSION_WGSL } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_KERNEL_WGSL,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import { terrainPageGenerationWgsl } from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { RUNWAY_EARTHWORKS_WGSL } from "../../src/render/webgpu/terrain/RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "../../src/render/webgpu/terrain/RunwaySurface";

/**
 * Every Phase 4 compute module, compiled on a real adapter and REPORTING its
 * error.
 *
 * This file exists because `dispatchWhenReady` retries forever and cannot be
 * cancelled: a WGSL error in any of these turns the test that uses it into an
 * eight-minute timeout with the actual message buried in a browser console
 * line. Running the compiles first, with `onError` captured, turns that into a
 * one-second failure that names the file and the line. (Two reserved-keyword
 * collisions — `target` — were found exactly this way.)
 */
describe("Phase 4 terrain compute modules compile (4-1, 4-3, 4-7)", () => {
  it("compiles the kernel, the page generator, the pyramid and the occlusion bake", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      const modules = [
        [
          "terrain-page-generate",
          terrainPageGenerationWgsl(
            TERRAIN_KERNEL_WGSL,
            terrainKernelPageBindingWgsl(0, 0),
            `${RUNWAY_SDF_WGSL}\n${RUNWAY_EARTHWORKS_WGSL}`,
          ),
          "generatePage",
        ],
        ["global-height-pyramid", GLOBAL_HEIGHT_PYRAMID_WGSL, "bakePyramid"],
        ["page-occlusion", PAGE_OCCLUSION_WGSL, "bakeOcclusion"],
      ] as const;
      for (const [name, source, entryPoint] of modules) {
        const errors: string[] = [];
        const shader = new ComputeShader(
          name,
          engine,
          { computeSource: source },
          { entryPoint, bindingsMapping: {} },
        );
        shader.onError = (_effect, message) => {
          errors.push(String(message));
        };
        const started = performance.now();
        // Bounded, unlike dispatchWhenReady: a compile failure must fail here.
        while (performance.now() - started < 15_000) {
          if (errors.length > 0) break;
          try {
            if (shader.isReady()) break;
          } catch (error) {
            errors.push(String(error));
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(errors.join(" | "), name).toBe("");
        expect(shader.isReady(), name).toBe(true);
      }
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
