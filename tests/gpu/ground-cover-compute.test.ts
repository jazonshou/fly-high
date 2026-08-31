import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Scene } from "@babylonjs/core/scene";
import { ComputeBudget, COMPUTE_DISPATCH_SEED_COST_MS } from "../../src/render/webgpu/core/ComputeBudget";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { GroundCoverSystem } from "../../src/render/webgpu/detail/GroundCoverSystem";
import { GROUND_COVER_LAWS } from "../../src/render/webgpu/detail/groundCoverLaw";
import { TerrainBiome } from "../../src/world";
import { hashSeed } from "../../src/world/seed";
import type { TerrainSample } from "../../src/world/types";

/**
 * `6-9` on a real adapter — the composed placement kernel, and the cull.
 *
 * Wave G shipped this system with NO GPU test at all, which was survivable
 * while the kernel was self-contained. It is not any more: `6-9` composes the
 * terrain kernel's scalar helpers and the vegetation archetype law into it,
 * adds a fourth texture binding, a storage counter and workgroup atomics, and
 * every one of those is a thing that validates on paper and fails at pipeline
 * creation. The recorded lesson applies exactly — a green Node suite is not
 * evidence that anything reached the screen.
 *
 * Three properties, in the order they can fail:
 *
 * 1. the composed WGSL COMPILES and dispatches with no uncaptured GPU error;
 * 2. the compaction actually culls — the readback lands, the drawn instance
 *    count falls below the lattice capacity, and it never exceeds it;
 * 3. the per-dispatch cost is in the band `COMPUTE_DISPATCH_SEED_COST_MS`
 *    claims, re-measured rather than asserted, with a 4x drift alarm (the
 *    same alarm and the same reason as `terrain-compute-cost`: a short
 *    dispatch's timestamp counter is genuinely noisy).
 */

const CANVAS_SIZE = 128;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
let timestampsAvailable = false;
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
    // The dispatch cost is measured through the SAME counter the live meter
    // consumes. A wall clock cannot be used: `dispatch` returns once the pass
    // is ENCODED, so it reads microseconds for work that costs milliseconds.
    deviceDescriptor: { requiredFeatures: ["timestamp-query"] as GPUFeatureName[] },
  });
  await engine.initAsync();
  // Babylon silently DROPS an unsupported entry from `requiredFeatures`
  // rather than letting `requestDevice` reject, so the constructor is not
  // proof the counter exists.
  timestampsAvailable = engine.enabledExtensions.includes("timestamp-query");
  if (timestampsAvailable) {
    // G0-2: locked once, before any scene work is encoded.
    engine.enableGPUTimingMeasurements = true;
  }
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/**
 * A meadow with structure: a gentle slope so the normal gate is exercised,
 * moisture that varies across the tile so the archetype mix genuinely picks
 * different lanes, and no runway or water.
 */
function meadowSampler(): (x: number, z: number) => TerrainSample {
  return (x, z) => {
    const height = 40 + Math.sin(x * 0.01) * 1.5 + Math.cos(z * 0.013) * 1.5;
    return {
      height,
      normal: { x: 0.02, y: 0.9994, z: 0.03 },
      slope: 0.036,
      moisture: 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(x * 0.004)),
      temperature: 0.6,
      biome: TerrainBiome.GRASSLAND,
      biomeName: "grassland",
      color: { x: 0.3, y: 0.5, z: 0.2 },
      airportInfluence: 0,
      isRunway: false,
    } as unknown as TerrainSample;
  };
}

describe("6-9 ground-cover placement compute on a real adapter", () => {
  it("compiles the composed kernel, compacts, and reports a culled draw count", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.35, 0.55, 1);
    const camera = new FreeCamera("ground-cover-camera", new Vector3(0, 2, 0), scene);
    camera.setTarget(new Vector3(0, 1.6, 60));
    camera.minZ = 0.1;
    camera.maxZ = 4_000;
    scene.activeCamera = camera;
    new HemisphericLight("ambient", Vector3.Up(), scene);

    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const budget = new ComputeBudget(profile);
    const system = new GroundCoverSystem(scene, {
      terrainSample: meadowSampler(),
      computeBudget: budget,
      seedHash: hashSeed("ground-cover-gpu"),
      seaLevelMeters: 0,
    });
    // The material plugin is the OTHER half `6-9` changed: it decodes the
    // archetype out of the wind-phase byte and shapes the ribbon from an
    // injected table. A compile failure there is silent — Babylon logs and
    // draws nothing — so readiness is asserted rather than assumed.
    let bladeMaterial: PBRMaterial | null = null;
    system.addPbrMaterials((material) => {
      bladeMaterial = material;
    });

    const step = async (): Promise<void> => {
      // The meter is frame-scoped and the field is one of its clients: drive
      // the same beginFrame/submit/read cycle the renderer does, so the test
      // exercises admission rather than bypassing it.
      budget.beginFrame();
      system.update({
        cameraWorldX: 0,
        cameraWorldY: 42,
        cameraWorldZ: 0,
        floatingOriginX: 0,
        floatingOriginZ: 0,
        law: GROUND_COVER_LAWS[profile.tier]!,
        windDirectionX: 1,
        windDirectionZ: 0,
        windStrength01: 0.3,
        windGust01: 0.2,
        simulationTimeSeconds: 4,
        gateScale: 1,
      });
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    try {
      // The domain tile bakes amortised at 1.5 CPU ms per frame over 256
      // rows; drive until it is complete and the pipelines have warmed.
      for (let frame = 0; frame < 600; frame += 1) {
        await step();
        if (gpuErrors.length > 0) break;
        if (system.pendingTileRows === 0 && system.statistics.gateScale > 0.02) {
          if (frame > 8 && system.statistics.culledInstances > 0) break;
        }
      }
      expect(gpuErrors, "the composed placement kernel raised a GPU error").toEqual([]);
      const bladeMesh = scene.meshes.find((mesh) => mesh.name === "ground-cover-ring-0");
      expect(bladeMesh, "the near ring mesh was never created").toBeDefined();
      let materialReady = false;
      for (let frame = 0; frame < 300 && !materialReady; frame += 1) {
        await step();
        const subMesh = bladeMesh!.subMeshes[0];
        materialReady = subMesh !== undefined
          && (bladeMaterial as PBRMaterial | null)!.isReadyForSubMesh(bladeMesh!, subMesh, true);
        if (gpuErrors.length > 0) break;
      }
      expect(materialReady, "the blade material never compiled").toBe(true);
      // Let the meter's exponential smoothing converge on the real cost
      // before it is compared with the pinned seed: one observation is 25% of
      // the way from the seed to the measurement by construction.
      for (let frame = 0; frame < 40; frame += 1) {
        await step();
        if (gpuErrors.length > 0) break;
      }
      expect(gpuErrors, "the composed placement kernel raised a GPU error").toEqual([]);

      const stats = system.statistics;
      console.log(
        `6-9 cull: capacity ${stats.activeBladeCapacity}, drawn ${stats.drawnInstances}, `
        + `culled ${stats.culledInstances} `
        + `(${((stats.culledInstances / stats.activeBladeCapacity) * 100).toFixed(1)}%), `
        + `gate ${stats.gateScale.toFixed(3)}, `
        + `groundCoverCompute estimate ${budget.estimatedCostMs("groundCoverCompute").toFixed(4)} ms`,
      );
      expect(stats.activeBladeCapacity).toBeGreaterThan(0);
      // The cull landed: a readback returned a live count and the draw fell
      // below the lattice. Without the ring this reads the atomic identity
      // (zero) and the field would draw nothing — the failure the ring exists
      // to prevent shows up here as `drawnInstances` collapsing, not as a
      // silent pass.
      expect(stats.drawnInstances, "no readback landed — the count never culled")
        .toBeLessThan(stats.activeBladeCapacity);
      expect(stats.drawnInstances).toBeGreaterThan(0);
      // The default path is the readback, not indirect.
      expect(stats.indirectInstanceCount).toBe(false);

      // The meter saw the client: a real per-dispatch cost replaced the seed.
      const measured = budget.estimatedCostMs("groundCoverCompute");
      expect(measured).toBeGreaterThan(0);
      // Re-measured, with a 4x drift alarm in both directions. This is the
      // number `COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute` claims and
      // the `groundCoverCompute` budget row is sized against; a drift means
      // the row is now fiction.
      const seed = COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute;
      // Without `timestamp-query` the engine never populates the counter and
      // the estimate stays exactly at its seed — report that rather than
      // pretending it was measured.
      expect(
        timestampsAvailable && measured !== seed,
        "the adapter granted timestamp-query but no dispatch cost was observed",
      ).toBe(timestampsAvailable);
      if (measured !== seed) {
        expect(measured, `measured ${measured.toFixed(4)} ms vs seed ${seed} ms`)
          .toBeLessThan(seed * 4);
        expect(measured).toBeGreaterThan(seed / 4);
      }
      // Uncaptured errors arrive asynchronously — drain the queue before the
      // zero-error assertion is allowed to mean anything.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(gpuErrors, "the ground-cover field raised a GPU error").toEqual([]);
    } finally {
      system.dispose();
      scene.dispose();
    }
  }, 120_000);

  /**
   * §7 R4's OPTIMISATION, on the device.
   *
   * The readback path above is what ships. This exercises the opt-in
   * GPU-written indirect count, because the alternative is shipping an
   * adapter over Babylon private state with no evidence it survives contact
   * with a real device: the raw `indirectDrawBuffer` is wrapped as a
   * `WebGPUDataBuffer` and bound as a compute storage target, which is a
   * usage combination (`Indirect | Storage | CopyDst`) that either validates
   * or takes the whole submit down.
   */
  it("drives the opt-in indirect instance count without a validation error", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.35, 0.55, 1);
    const camera = new FreeCamera("indirect-camera", new Vector3(0, 2, 0), scene);
    camera.setTarget(new Vector3(0, 1.6, 60));
    camera.minZ = 0.1;
    camera.maxZ = 4_000;
    scene.activeCamera = camera;
    new HemisphericLight("ambient", Vector3.Up(), scene);

    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const budget = new ComputeBudget(profile);
    const before = gpuErrors.length;
    const system = new GroundCoverSystem(scene, {
      terrainSample: meadowSampler(),
      computeBudget: budget,
      seedHash: hashSeed("ground-cover-indirect"),
      seaLevelMeters: 0,
      indirectInstanceCount: true,
    });
    // The capability assertion passed at construction — on this Babylon the
    // private surface is present, which is the version-bump tripwire's other
    // half (the Node test reads the sources; this one runs against them).
    expect(system.statistics.indirectInstanceCount).toBe(true);

    try {
      for (let frame = 0; frame < 400; frame += 1) {
        budget.beginFrame();
        system.update({
          cameraWorldX: 0,
          cameraWorldY: 42,
          cameraWorldZ: 0,
          floatingOriginX: 0,
          floatingOriginZ: 0,
          law: GROUND_COVER_LAWS[profile.tier]!,
          windDirectionX: 1,
          windDirectionZ: 0,
          windStrength01: 0.3,
          windGust01: 0.2,
          simulationTimeSeconds: 4,
          gateScale: 1,
        });
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (gpuErrors.length > before) break;
        // Babylon creates each mesh's main-pass draw wrapper on its FIRST
        // render, so a ring cannot bind its indirect record until the frame
        // after it starts drawing. Drive until every ring has bound rather
        // than assuming a fixed number of frames.
        if (system.statistics.indirectBoundRings === 3) break;
      }
      expect(
        system.statistics.indirectBoundRings,
        "no ring ever bound a main-pass indirect record",
      ).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        gpuErrors.slice(before),
        "the indirect publish pass raised a GPU error",
      ).toEqual([]);
      // With indirect ON the instance count is PINNED at capacity so
      // Babylon's `setIndirectData` early-return holds and never overwrites
      // the count the publish pass wrote. `drawnInstances` reporting capacity
      // is therefore the CORRECT reading here, not a failed cull.
      expect(system.statistics.drawnInstances)
        .toBe(system.statistics.activeBladeCapacity);
    } finally {
      system.dispose();
      scene.dispose();
    }
  }, 120_000);
});
