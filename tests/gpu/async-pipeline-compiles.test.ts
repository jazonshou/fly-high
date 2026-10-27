import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { AsyncPipelineCompiles } from "../../src/render/webgpu/core/AsyncPipelineCompiles";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { GroundCoverSystem } from "../../src/render/webgpu/detail/GroundCoverSystem";
import { GROUND_COVER_LAWS, groundCoverLaneCount } from "../../src/render/webgpu/detail/groundCoverLaw";
import { TerrainBiome } from "../../src/world";
import { hashSeed } from "../../src/world/seed";
import type { TerrainSample } from "../../src/world/types";

/**
 * The pitch-down freeze's fix on a real adapter (`AsyncPipelineCompiles`).
 *
 * The Node test runs the module against stand-ins for Babylon's private draw
 * path; this one runs it inside Babylon's real WebGPU draws, where the risk
 * is different: abandoning a draw at its pipeline lookup must leave the
 * engine's bundle and bind-group state clean (or the next draws raise
 * validation errors), and the pipeline filed from the asynchronous compile
 * must be the one Babylon's next lookup finds (or every frame compiles again).
 *
 * Every render pipeline the device builds is attributed to the mesh being
 * drawn when it was asked for, so "this mesh compiled nothing in a frame" is
 * a measured statement, not a total that other meshes could hide in.
 */

const SIZE = 64;
let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

interface PipelineRecord {
  readonly mesh: string | null;
  readonly mode: "sync" | "async";
  readonly kind: "render" | "compute";
}
const pipelines: PipelineRecord[] = [];
let drawingMesh: string | null = null;

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
  const createRenderPipeline = device.createRenderPipeline.bind(device);
  const createRenderPipelineAsync = device.createRenderPipelineAsync.bind(device);
  const createComputePipeline = device.createComputePipeline.bind(device);
  const createComputePipelineAsync = device.createComputePipelineAsync.bind(device);
  device.createRenderPipeline = (descriptor) => {
    pipelines.push({ mesh: drawingMesh, mode: "sync", kind: "render" });
    return createRenderPipeline(descriptor);
  };
  device.createRenderPipelineAsync = (descriptor) => {
    pipelines.push({ mesh: drawingMesh, mode: "async", kind: "render" });
    return createRenderPipelineAsync(descriptor);
  };
  device.createComputePipeline = (descriptor) => {
    pipelines.push({ mesh: null, mode: "sync", kind: "compute" });
    return createComputePipeline(descriptor);
  };
  device.createComputePipelineAsync = (descriptor) => {
    pipelines.push({ mesh: null, mode: "async", kind: "compute" });
    return createComputePipelineAsync(descriptor);
  };
  // Every pass's mesh draw names its mesh for the records above.
  const prototype = Mesh.prototype as unknown as Record<string, unknown>;
  const processRendering = prototype["_processRendering"] as (this: Mesh, ...args: unknown[]) => unknown;
  prototype["_processRendering"] = function (this: Mesh, ...args: unknown[]) {
    const outer = drawingMesh;
    drawingMesh = this.name;
    try {
      return processRendering.apply(this, args);
    } finally {
      drawingMesh = outer;
    }
  };
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** Pipelines asked for by meshes whose name starts with `prefix`, since `mark`. */
function pipelinesFor(prefix: string, mark: number): { sync: number; async: number } {
  const asked = pipelines.slice(mark).filter((record) => record.kind === "render" && record.mesh?.startsWith(prefix));
  return {
    sync: asked.filter((record) => record.mode === "sync").length,
    async: asked.filter((record) => record.mode === "async").length,
  };
}

/** Renders one frame and reads the canvas's centre in the same task (the swapchain texture is recycled after). */
function frame(scene: Scene): number {
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  const copy = document.createElement("canvas");
  copy.width = SIZE;
  copy.height = SIZE;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(SIZE / 2, SIZE / 2, 1, 1).data[0]!;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function emissive(name: string, scene: Scene): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = new Color3(1, 1, 1);
  return material;
}

function viewScene(): { scene: Scene; camera: FreeCamera } {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("async-pipeline-camera", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  return { scene, camera };
}

describe("off-frame pipeline compiles in Babylon's WebGPU draws", () => {
  it("a deferred material's first sight compiles nothing in the frame, and it draws once the compile lands", async () => {
    const { scene } = viewScene();
    const compiles = AsyncPipelineCompiles.install(scene)!;
    try {
      expect(compiles, "the Babylon surface the module hooks is missing").not.toBeNull();
      frame(scene);
      const stump = emissive("stump", scene);
      compiles.defer(stump);
      const mesh = CreateBox("detail-stump", { size: 2 }, scene);
      mesh.material = stump;
      await scene.whenReadyAsync();

      const mark = pipelines.length;
      expect(frame(scene), "the box drew in the frame its pipeline was asked for").toBe(0);
      expect(pipelinesFor("detail-stump", mark)).toEqual({ sync: 0, async: 1 });
      expect(compiles.statistics.deferredDraws).toBe(1);

      await compiles.whenIdle();
      expect(frame(scene), "the box never drew after its compile landed").toBeGreaterThan(200);
      expect(frame(scene)).toBeGreaterThan(200);
      expect(pipelinesFor("detail-stump", mark)).toEqual({ sync: 0, async: 1 });
      expect(compiles.statistics).toMatchObject({ deferredDraws: 1, compilesFinished: 1, compilesFailed: 0 });
      expect(gpuErrors).toEqual([]);
    } finally {
      compiles?.dispose();
      scene.dispose();
    }
  });

  it("a warm-up compiles a mesh out of view, so its first sight draws in that frame", async () => {
    const { scene } = viewScene();
    const compiles = AsyncPipelineCompiles.install(scene)!;
    try {
      const rock = emissive("rock", scene);
      const moss = emissive("moss", scene);
      // Two materials with the same defines share Babylon's effect, and so
      // the pipeline: the cull mode keeps the instrument's pipeline its own.
      moss.backFaceCulling = false;
      compiles.defer(rock);
      compiles.defer(moss);
      const warmed = CreateBox("detail-rock", { size: 2 }, scene);
      warmed.material = rock;
      // Behind the camera, where the near band's clutter is in level flight.
      warmed.position.set(0, 0, -20);
      const cold = CreateBox("detail-moss", { size: 2 }, scene);
      cold.material = moss;
      cold.position.set(0, 0, -20);
      await scene.whenReadyAsync();

      expect(compiles.warmUp(warmed, false)).toBe("started");
      for (let attempt = 0; attempt < 60 && compiles.warmUp(warmed, false) !== "warm"; attempt += 1) {
        frame(scene);
        await compiles.whenIdle();
        await nextTask();
      }
      expect(compiles.warmUp(warmed, false), "the warm-up never completed").toBe("warm");
      expect(warmed.alwaysSelectAsActiveMesh).toBe(false);

      // Into view: the warmed mesh draws in this very frame, compiling nothing.
      const mark = pipelines.length;
      const deferredBefore = compiles.statistics.deferredDraws;
      warmed.position.set(0, 0, 0);
      expect(frame(scene), "the warmed box did not draw on first sight").toBeGreaterThan(200);
      expect(pipelinesFor("detail-rock", mark)).toEqual({ sync: 0, async: 0 });
      expect(compiles.statistics.deferredDraws).toBe(deferredBefore);

      // The instrument: the unwarmed one, put in the same place, does wait.
      warmed.setEnabled(false);
      cold.position.set(0, 0, 0);
      expect(frame(scene)).toBe(0);
      expect(pipelinesFor("detail-moss", mark)).toEqual({ sync: 0, async: 1 });
      expect(gpuErrors).toEqual([]);
    } finally {
      compiles?.dispose();
      scene.dispose();
    }
  });

  it("a shadow-map draw waits and lands the same way, and an unregistered receiver keeps compiling in the frame", async () => {
    const { scene, camera } = viewScene();
    const compiles = AsyncPipelineCompiles.install(scene)!;
    try {
      camera.position.set(0, 6, -8);
      camera.setTarget(Vector3.Zero());
      new HemisphericLight("async-pipeline-ambient", Vector3.Up(), scene);
      const sun = new DirectionalLight("async-pipeline-sun", new Vector3(-0.3, -1, 0.2).normalize(), scene);
      sun.position = new Vector3(3, 10, -2);
      const shadows = new ShadowGenerator(256, sun);
      const log = new StandardMaterial("log", scene);
      compiles.defer(log);
      const caster = CreateBox("detail-log", { size: 1.5 }, scene);
      caster.material = log;
      caster.position.y = 1;
      shadows.addShadowCaster(caster);
      const ground = CreateGround("terrain-ground", { width: 12, height: 12 }, scene);
      ground.material = new StandardMaterial("terrain", scene);
      ground.receiveShadows = true;
      await scene.whenReadyAsync();

      const mark = pipelines.length;
      frame(scene);
      // Its main draw and its shadow-map draw: two pipelines, neither built
      // in the frame. The ground, not registered, builds its own as before.
      expect(pipelinesFor("detail-log", mark)).toEqual({ sync: 0, async: 2 });
      expect(pipelinesFor("terrain-ground", mark).sync).toBeGreaterThan(0);
      expect(compiles.statistics.deferredDraws).toBe(2);
      for (let attempt = 0; attempt < 10 && compiles.statistics.compilesPending > 0; attempt += 1) {
        await compiles.whenIdle();
        frame(scene);
      }
      const settled = compiles.statistics.deferredDraws;
      const settledMark = pipelines.length;
      frame(scene);
      frame(scene);
      expect(compiles.statistics.deferredDraws).toBe(settled);
      expect(pipelinesFor("detail-log", settledMark)).toEqual({ sync: 0, async: 0 });
      expect(gpuErrors).toEqual([]);
    } finally {
      compiles?.dispose();
      scene.dispose();
    }
  });
});

describe("the blades' pipeline prime", () => {
  it("compiles the blades' pipelines, render and compute, while the aircraft is above the fade, so the first blades compile nothing", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.35, 0.55, 1);
    const camera = new FreeCamera("ground-cover-camera", new Vector3(0, 2, 0), scene);
    camera.setTarget(new Vector3(0, 1.6, 60));
    camera.minZ = 0.1;
    camera.maxZ = 4_000;
    scene.activeCamera = camera;
    new HemisphericLight("ambient", Vector3.Up(), scene);
    const compiles = AsyncPipelineCompiles.install(scene)!;
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const law = GROUND_COVER_LAWS[profile.tier]!;
    const system = new GroundCoverSystem(scene, {
      terrainSample: (x, z) => ({
        height: 40,
        normal: { x: 0, y: 1, z: 0 },
        slope: 0,
        moisture: 0.5 + 0.2 * Math.sin(x * 0.004 + z * 0.003),
        temperature: 0.6,
        biome: TerrainBiome.GRASSLAND,
        biomeName: "grassland",
        color: { x: 0.3, y: 0.5, z: 0.2 },
        airportInfluence: 0,
        isRunway: false,
      }) as unknown as TerrainSample,
      seedHash: hashSeed("ground-cover-prime"),
      seaLevelMeters: 0,
      pipelineWarmUp: compiles,
    });
    system.addPbrMaterials((material) => compiles.defer(material));
    const step = async (cameraWorldY: number): Promise<void> => {
      camera.position.y = cameraWorldY;
      system.update({
        cameraWorldX: 0,
        cameraWorldY,
        cameraWorldZ: 0,
        floatingOriginX: 0,
        floatingOriginZ: 0,
        law,
        windDirectionX: 1,
        windDirectionZ: 0,
        windStrength01: 0.3,
        windGust01: 0.2,
        simulationTimeSeconds: 4,
        gateScale: 1,
      });
      frame(scene);
      await nextTask();
    };
    try {
      // Cruise, far above the fade: no blades, but ring 0 primes.
      for (let attempt = 0; attempt < 300 && compiles.statistics.warmUpsCompleted === 0; attempt += 1) {
        await step(2_000);
        await compiles.whenIdle();
      }
      expect(compiles.statistics.warmUpsCompleted, "the blades never primed").toBe(1);
      await step(2_000);
      const ring = scene.meshes.find((mesh) => mesh.name === "ground-cover-ring-0") as Mesh;
      expect(ring.isEnabled(false), "ring 0 kept drawing after its prime").toBe(false);
      expect(ring.forcedInstanceCount).toBe(groundCoverLaneCount(law.rings[0]!));
      expect(pipelinesFor("ground-cover-ring-", 0).sync).toBe(0);
      // The placement kernel: built off the frame, once, before any dispatch.
      const computeAtCruise = pipelines.filter((record) => record.kind === "compute");
      expect(computeAtCruise.map((record) => record.mode)).toEqual(["async"]);

      // Descend: the blades appear with their pipelines already built.
      const mark = pipelines.length;
      const deferredBefore = compiles.statistics.deferredDraws;
      for (let attempt = 0; attempt < 600 && !scene.meshes.some((mesh) => mesh.name.startsWith("ground-cover-ring-") && mesh.isEnabled(false)); attempt += 1) {
        await step(42);
      }
      for (let extra = 0; extra < 4; extra += 1) await step(42);
      expect(
        scene.meshes.filter((mesh) => mesh.name.startsWith("ground-cover-ring-") && mesh.isEnabled(false)).length,
        "no ring ever drew",
      ).toBeGreaterThan(0);
      expect(pipelinesFor("ground-cover-ring-", mark)).toEqual({ sync: 0, async: 0 });
      expect(pipelines.slice(mark).filter((record) => record.kind === "compute")).toEqual([]);
      expect(compiles.statistics.deferredDraws).toBe(deferredBefore);
      expect(gpuErrors).toEqual([]);
    } finally {
      system.dispose();
      compiles.dispose();
      scene.dispose();
    }
  });
});
