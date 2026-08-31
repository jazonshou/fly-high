import { describe, expect, it } from "vitest";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GLOBAL_HEIGHT_PYRAMID_WGSL } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  PAGE_OCCLUSION_WGSL,
  terrainPageSplatWgsl,
} from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_KERNEL_WGSL,
  terrainKernelPageBindingWgsl,
} from "../../src/render/webgpu/terrain/TerrainKernel";
import { terrainPageGenerationWgsl } from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { RUNWAY_EARTHWORKS_WGSL } from "../../src/render/webgpu/terrain/RunwayEarthworks";
import { RUNWAY_SDF_WGSL } from "../../src/render/webgpu/terrain/RunwaySurface";
import { BATHYMETRY_UPDATE_WGSL } from "../../src/render/webgpu/water/BathymetryClipmap";

/**
 * Every terrain/bathymetry compute module through Phase 5, compiled on a real
 * adapter and REPORTING its error.
 *
 * This file exists because `dispatchWhenReady` polls for roughly thirty
 * seconds, then leaves its resolve-only Promise pending and cannot be
 * cancelled. A WGSL error in any of these turns the test that uses it into an
 * eight-minute timeout with the actual message buried in a browser console
 * line. Running the compiles first, with `onError` captured, turns that into a
 * one-second failure that names the file and the line. (Two reserved-keyword
 * collisions — `target` — were found exactly this way.)
 */
describe("terrain and bathymetry compute modules compile (4-1, 4-3, 4-7, 5-10)", () => {
  it("compiles the terrain generators, channel bakes and bathymetry update", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
      deviceDescriptor: {
        requiredFeatures: ["texture-formats-tier1"] as GPUFeatureName[],
      },
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
        // 6-8: composed by its OWNER, not restated here. The list used to be a
        // second copy, so the item that appended the vegetation density include
        // to the bake compiled in the renderer and failed in the test whose job
        // is to catch compile failures.
        ["page-splat", terrainPageSplatWgsl(), "bakeSplat"],
        ["bathymetry-clipmap-update", BATHYMETRY_UPDATE_WGSL, "updateBathymetry"],
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
