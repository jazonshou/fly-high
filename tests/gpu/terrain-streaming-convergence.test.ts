import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { TerrainClipmapSystem } from "../../src/render/webgpu/terrain/TerrainClipmapSystem";
import { createWorld, sampleTerrainHeight } from "../../src/world";

/**
 * `4.5-B` — a cold spawn converges, on a real adapter.
 *
 * The Node suite cannot see this: under NullEngine the atlases hold no
 * textures, so the system never constructs a page generator and every page
 * "arrives" instantly through a fake. What this test drives is the whole real
 * chain — admission through `ComputeBudget`, the compute dispatch, the bounds
 * readback, and the selector's never-split-unmeasured rule feeding back into
 * the next frame's page demand.
 *
 * That feedback loop is the thing that can deadlock: the selector only
 * requests pages for nodes it has SELECTED, and it can only select finer nodes
 * once the pages it already has report a measured deviation. A stall anywhere
 * in the chain shows up here as a converged node count far below the budget —
 * which is exactly the "terrain constantly struggles to load" symptom, and is
 * invisible to a green Node suite.
 */

/** The approach pose assertion 107 pins in Node, flown here on real pages. */
const SPAWN_ALTITUDE_AGL = 152;

async function withScene<T>(run: (engine: WebGPUEngine, scene: Scene) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    return await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

describe("terrain streaming convergence (4.5-B)", () => {
  it("descends from the L9 roots to the tier's finest level from a cold spawn", async () => {
    const trace = await withScene(async (engine, scene) => {
      void engine;
      // This Phase-4 convergence fixture exercises the analytic GPU producer.
      // Phase 5's default eroded producer intentionally admits no page until
      // TerrainEvolutionRuntime supplies its canonical macro authority.
      const world = createWorld("phase1-perf-baseline", {
        worldEvolution: "analytic",
      });
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const system = new TerrainClipmapSystem(scene, world, profile);
      const spawnX = world.airport?.centerX ?? 0;
      const spawnZ = world.airport?.centerZ ?? 0;
      const observer = {
        x: spawnX,
        y: sampleTerrainHeight(world, spawnX, spawnZ) + SPAWN_ALTITUDE_AGL,
        z: spawnZ,
        velocityX: 0,
        velocityZ: 0,
        // The capture's viewport, so the screen-space error the selector sees
        // is the one assertion 107 pins.
        pixelsPerMeterAtUnitDistance: 720 / (2 * Math.tan((60 * Math.PI) / 360)),
      };
      const samples: {
        frame: number;
        nodes: number;
        resident: number;
        generating: number;
        finestLevel: number;
      }[] = [];
      for (let frame = 1; frame <= 900; frame += 1) {
        system.update(observer, frame);
        // Let the dispatch, the readback and the bake promises land: the whole
        // chain is asynchronous and a synchronous loop would measure nothing.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (frame % 100 === 0) {
          const nodes = system.selectedNodes;
          samples.push({
            frame,
            nodes: nodes.length,
            resident: system.atlases.height.residency.residentCount,
            generating: system.atlases.height.residency.generatingCount,
            finestLevel: Math.min(...nodes.map((node) => node.level)),
          });
        }
      }
      const final = system.selectedNodes;
      const result = {
        samples,
        nodes: final.length,
        finestLevel: Math.min(...final.map((node) => node.level)),
        resident: system.atlases.height.residency.residentCount,
        channelResident: system.atlases.channel.residency.residentCount,
        budget: profile.cdlodNodeBudget,
      };
      system.dispose();
      return result;
    });

    console.log("cold-spawn convergence:", JSON.stringify(trace));

    // The selector must actually descend. Before `4.5-A1` it converged with
    // the whole world at L5-L7 whatever the altitude; the failure this guards
    // against now is the opposite one — a streaming chain that stalls, leaving
    // the selector with nothing measured to split.
    expect(trace.finestLevel, "cold spawn never reached a fine level")
      .toBeLessThanOrEqual(2);
    expect(trace.nodes, "cold spawn converged far below the node budget")
      .toBeGreaterThan(trace.budget * 0.6);
    expect(trace.resident, "no height page reported measured bounds")
      .toBeGreaterThan(8);
  }, 300_000);
});
