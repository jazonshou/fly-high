import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Side-effect import: tree-shaken Babylon needs the shadow scene component
// registered before shadow maps render.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { AerialPerspectiveMaterialPlugin } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { CloudShadowMaterialPlugin } from "../../src/render/webgpu/clouds/CloudShadowMaterialPlugin";
import { TerrainBiome } from "../../src/world";
import { WorldDetailRuntime } from "../../src/render/webgpu/detail/WorldDetailRuntime";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import type { DetailTerrainSample } from "../../src/render/webgpu/detail/types";

/**
 * The vegetation perf-debt pass's capture-class test.
 *
 * The pass replaced the per-rebuild "publish a whole new set of meshes"
 * scheme with batch and instance-buffer REUSE, which turns instance
 * allocations from a leak into a lifetime problem: a GPU buffer released
 * while a submitted command buffer still references it is a validation
 * error, and the symptom on a real device is a black frame — exactly the
 * seven-minute-capture failure class 2-12's compile test exists to move into
 * seconds. So the lifetime is proven the same way: drive the REAL runtime on
 * a real adapter through growth, rebuild and retirement while rendering, and
 * fail on any uncaptured GPU error.
 *
 * The observer path is chosen to exercise all three transitions: a long
 * traverse (chunks enter, fill and leave), a teleport (every chunk retires
 * at once) and a return (batches are recreated behind retired ones).
 */

const CANVAS_SIZE = 128;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function forestSampler(): (x: number, z: number) => DetailTerrainSample {
  return () => ({
    height: 120,
    slope: 0.05,
    moisture: 0.7,
    biome: TerrainBiome.FOREST,
    normal: { x: 0, y: 1, z: 0 },
  });
}

describe("detail instance-buffer lifetime (perf-debt pass)", () => {
  it("survives growth, rebuild and retirement with no GPU validation errors", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.35, 0.55, 1);
    const camera = new FreeCamera("detail-camera", new Vector3(0, 40, -60), scene);
    camera.setTarget(new Vector3(0, 10, 200));
    camera.minZ = 1;
    camera.maxZ = 8_000;
    scene.activeCamera = camera;
    new HemisphericLight("ambient", Vector3.Up(), scene);

    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "detail-buffer-lifetime",
      terrainSample: forestSampler(),
      seaLevelMeters: 0,
    });
    // The PRODUCTION material stack: FlightRenderer registers every detail
    // material as an aerial-perspective and cloud-shadow receiver right
    // after the runtime is built, before anything compiles (the 0-9 rule).
    // Those two plugins add fragment code and uniforms to the same PBR
    // materials this runtime's own plugin injects into, and the combination
    // is what decides whether a pipeline is valid — the detail plugin alone
    // compiled perfectly well while the real renderer drew black.
    runtime.addPbrMaterials((material) => {
      new AerialPerspectiveMaterialPlugin(material);
      new CloudShadowMaterialPlugin(material);
    });

    const step = async (
      x: number,
      z: number,
      predictionX: number,
      predictionZ: number,
      floatingOrigin = { x: 0, y: 0, z: 0 },
    ): Promise<void> => {
      runtime.update(
        { x, y: 60, z, velocityX: predictionX - x, velocityZ: predictionZ - z },
        floatingOrigin,
        profile,
        0,
      );
      // Mid altitude looking along the horizon: the only geometry that puts
      // the FAR band (1.1-3.0 km of billboard impostors) fully in frustum
      // alongside the near band. The capture's black shots were all at this
      // altitude; its ground-level and cruise shots rendered.
      camera.position.set(
        x - floatingOrigin.x,
        150 - floatingOrigin.y,
        z - floatingOrigin.z - 120,
      );
      camera.setTarget(new Vector3(
        x - floatingOrigin.x,
        90 - floatingOrigin.y,
        z - floatingOrigin.z + 3_000,
      ));
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    try {
      // Traverse: chunks stream in and their batches grow as cells arrive.
      for (let index = 0; index < 24; index += 1) {
        await step(index * 90, index * 90, index * 90 + 400, index * 90 + 400);
        if (gpuErrors.length > 0) break;
      }
      // Teleport: every resident chunk retires in one update, and the
      // retired batches' allocations come due four updates later.
      for (let index = 0; index < 12; index += 1) {
        await step(60_000 + index * 40, 60_000, 60_000, 60_000);
        if (gpuErrors.length > 0) break;
      }
      // Return: batches are recreated while the previous ones are still
      // inside their grace window.
      for (let index = 0; index < 12; index += 1) {
        await step(index * 40, index * 40, index * 40, index * 40);
        if (gpuErrors.length > 0) break;
      }

      // 67d on-adapter: keep the observer/view fixed while moving the floating
      // origin. One presentation chunk rebuilds immediately; the remaining
      // live batches keep their old records and use distinct mesh offsets.
      // That deliberately exercises multiple values of the material-shared
      // detailMeshOffset UBO in one real WebGPU frame.
      const rebaseOrigin = { x: 2_048, y: 0, z: -2_048 };
      await step(440, 440, 440, 440, rebaseOrigin);
      const liveBatches = scene.meshes.filter(
        (mesh): mesh is Mesh => mesh instanceof Mesh
          && typeof mesh.metadata?.detailChunk === "string"
          && mesh.isEnabled()
          && mesh.forcedInstanceCount > 0,
      );
      const offsetsByMaterial = new Map<number, Set<string>>();
      for (const mesh of liveBatches) {
        if (!mesh.material) continue;
        const offsets = offsetsByMaterial.get(mesh.material.uniqueId) ?? new Set<string>();
        offsets.add(`${mesh.position.x}:${mesh.position.y}:${mesh.position.z}`);
        offsetsByMaterial.set(mesh.material.uniqueId, offsets);
      }
      expect(liveBatches.filter((mesh) => !mesh.position.equals(Vector3.Zero())).length)
        .toBeGreaterThan(1);
      expect(
        [...offsetsByMaterial.values()].some((offsets) => offsets.size > 1),
        "no shared detail material rendered batches built against two origins",
      ).toBe(true);

      expect(gpuErrors.join("\n")).toBe("");

      // Non-vacuous: the run has to have actually drawn vegetation, or a
      // lifetime test proves nothing. `activeBatches` is the same counter
      // the capture reports as `vegetationBatches`.
      expect(runtime.statistics.renderedThinInstances).toBeGreaterThan(0);
      expect(runtime.statistics.activeBatches).toBeGreaterThan(20);

      // ...and the frame must contain PIXELS. An invalid pipeline anywhere
      // in the vegetation stack makes WebGPU reject the whole submit, and
      // the symptom is a black frame at a suspiciously high frame rate —
      // which is exactly how the perf-debt pass's first capture came back.
      // Render and copy in one synchronous task, before the compositor
      // consumes the frame.
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      const copy = document.createElement("canvas");
      copy.width = CANVAS_SIZE;
      copy.height = CANVAS_SIZE;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      let lit = 0;
      for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
        if ((image[index * 4] ?? 0) + (image[index * 4 + 1] ?? 0) > 12) lit += 1;
      }
      expect(lit, "the frame rasterized nothing").toBeGreaterThan(
        CANVAS_SIZE * CANVAS_SIZE * 0.2,
      );
    } finally {
      runtime.dispose();
      scene.dispose();
    }

    // Disposal is its own lifetime hazard: it releases every live and
    // retired allocation at once, while the last frame may still be in
    // flight.
    for (let index = 0; index < 4; index += 1) {
      engine.beginFrame();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(gpuErrors.join("\n")).toBe("");
  }, 180_000);
});
