import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditInterStage,
  captureShaderModules,
  CSM_RECEIVE_MARKERS,
  INTER_STAGE_LIMIT,
  type ShaderRecord,
} from "./interStageBudget";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { generateWildlifeCell } from "../../src/render/webgpu/wildlife/generation";
import type { GroundAnimalSpawn } from "../../src/render/webgpu/wildlife/types";
import { WildlifeSystem } from "../../src/render/webgpu/wildlife/WildlifeSystem";
import { TerrainBiome } from "../../src/world";

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];

let shaderModules: ShaderRecord[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
  });
  await engine.initAsync();
  shaderModules = captureShaderModules(engine);
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function wildlifeMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter((mesh) => mesh.metadata?.wildlifePrototype === true) as Mesh[];
}

/** A real frame boundary, so Babylon's asynchronous effect compiles can land between renders. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The frames right after startup: at least `minimumFrames`, and until every
 * wildlife batch with no animals has ended its zero-matrix prime
 * (`WildlifeSystem.advancePrime`) and gone dark. A system built before the
 * prime existed starts dark.
 */
async function renderUntilPrimesEnd(
  scene: Scene,
  frame: () => void,
  minimumFrames = 0,
): Promise<void> {
  for (let frames = 0; frames < 90; frames += 1) {
    if (
      frames >= minimumFrames
      && wildlifeMeshes(scene).every((mesh) => !mesh.isEnabled())
    ) return;
    frame();
    await nextTask();
  }
  throw new Error("the wildlife prime never ended");
}

describe("wildlife material stack compiles on-adapter (Gate A-5)", () => {
  it("renders every shared RH prototype with feather, fur, and keratin PBR variants", async () => {
    gpuErrors.length = 0;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.03, 0.05, 0.08, 1);
    try {
      const camera = new FreeCamera("wildlife-compile-camera", new Vector3(0, 3, -15), scene);
      camera.setTarget(new Vector3(0, 1, 0));
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "wildlife-compile-sun",
        new Vector3(-0.5, -0.8, -0.25).normalize(),
        scene,
      );
      sun.intensity = 2.2;
      const fill = new HemisphericLight("wildlife-compile-fill", Vector3.Up(), scene);
      fill.intensity = 0.65;
      // 7-4b: the SHIPPING path, which this rig previously omitted and so
      // measured a material that does not exist. `WildlifeSystem` sets
      // `mesh.receiveShadows = true` on every batch and `FlightRenderer`
      // registers them through `addShadowCasters`, so the CSM receive path and
      // its EIGHT varyings are part of the shipped permutation. Without these
      // two lines this file reported 3 of 16 and thirteen slots free -- which
      // would have made wildlife look like the safest material in the engine.
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      // And the IBL, because `USESPHERICALINVERTEX` only exists when a cubic
      // reflection texture is bound; production binds the sky probe (1C-6), so
      // a rig without one silently drops `vEnvironmentIrradiance` too.
      const probe = new ReflectionProbe("wildlife-compile-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;

      const system = new WildlifeSystem(scene, {
        worldSeed: "wildlife-adapter-compile",
        terrainSample: () => ({ height: 0, slope: 0, biome: TerrainBiome.FOREST }),
      });
      // D1: every batch starts primed with one zero-matrix instance and goes
      // dark once that has drawn. Let the prime finish first, as the frames
      // after startup do, so it cannot switch this rig's hand-placed instances
      // off between the renders below.
      await scene.whenReadyAsync();
      await renderUntilPrimesEnd(scene, () => scene.render());
      const prototypes = wildlifeMeshes(scene);
      expect(prototypes).toHaveLength(10);
      for (const [index, prototype] of prototypes.entries()) {
        // The count first: `thinInstanceSetMatrixAt` writes nothing at an
        // index at or past it, and an ended prime leaves it at 0.
        prototype.thinInstanceCount = 1;
        prototype.thinInstanceSetMatrixAt(
          0,
          Matrix.Translation((index - 4.5) * 1.2, 0, 0),
          true,
        );
        prototype.setEnabled(true);
      }

      await scene.whenReadyAsync();
      // AFTER the thin instances are set: `WildlifeSystem.addShadowCasters`
      // filters on `thinInstanceCount > 0`, so calling it on empty batches
      // silently registers nothing and the rig quietly loses the shadow path
      // it is here to compile.
      system.addShadowCasters((mesh) => shadows.addShadowCaster(mesh, false));
      for (let frame = 0; frame < 3; frame += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      system.dispose();
    } finally {
      scene.dispose();
    }
    // 7-4b: THE INTER-STAGE AUDIT. A `ClusteredLightContainer` is a SCENE light
    // -- it reaches every material taking Babylon's light loop and adds exactly
    // one `@location` to each. A material already at the device maximum does not
    // DEGRADE when one is attached: pipeline creation fails and the mesh stops
    // drawing entirely.
    //
    // `requiredMarkers` is asserted against the compiled source, not declared.
    // wildlife (feather/fur/keratin)'s meshes set `receiveShadows`, so a run that compiles no
    // `vPositionFromLight` is measuring a permutation eight varyings lighter
    // than the one that ships -- which is exactly how this file once reported
    // 3 of 16 with thirteen slots free.
    const { peak, headroom, absent } = auditInterStage(shaderModules, {
      label: "wildlife (feather/fur/keratin)",
      requiredMarkers: CSM_RECEIVE_MARKERS,
    });
    expect(
      absent,
      "the rig did not compile the shipping shadow path, so the budget below "
      + "describes a material that does not exist",
    ).toEqual([]);
    expect(peak, "no FragmentInputs struct was captured -- the audit is vacuous")
      .toBeGreaterThan(0);
    expect(
      peak,
      `wildlife (feather/fur/keratin) compiles at ${peak} fragment inputs, over the device maximum of `
      + `${INTER_STAGE_LIMIT}. The mesh will not draw at all.`,
    ).toBeLessThanOrEqual(INTER_STAGE_LIMIT);
    // The MARGIN is the deliverable, not the pass: a clean audit that names its
    // headroom is what makes the next attach safe.
    expect(
      headroom,
      `wildlife (feather/fur/keratin) has NO slot for a clustered light container (peak ${peak}/${INTER_STAGE_LIMIT}). `
      + "Attaching one stops this material drawing; free a varying first, as 7-4b did for detail.",
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("the first keratin animal builds no pipeline (D1)", () => {
  it("primes every batch's main and shadow pipelines in the frames after startup", async () => {
    // A device of its own: the test above leaves this file's engine holding a
    // pipeline for every wildlife material, which would pass this vacuously.
    const primeCanvas = document.createElement("canvas");
    primeCanvas.width = 256;
    primeCanvas.height = 256;
    document.body.appendChild(primeCanvas);
    const primeEngine = new WebGPUEngine(primeCanvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    await primeEngine.initAsync();
    const device = (primeEngine as unknown as { _device: GPUDevice })._device;
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => {
      errors.push(String((event as GPUUncapturedErrorEvent).error.message));
    });
    let counting = false;
    const created: string[] = [];
    const count = <T extends (...args: never[]) => unknown>(name: string, create: T): T =>
      ((...args: Parameters<T>) => {
        const descriptor = args[0] as { label?: string } | undefined;
        if (counting) created.push(`${name} ${descriptor?.label ?? ""}`);
        return create(...args);
      }) as T;
    device.createShaderModule = count("shader module", device.createShaderModule.bind(device));
    device.createRenderPipeline = count("render pipeline", device.createRenderPipeline.bind(device));
    device.createRenderPipelineAsync = count(
      "render pipeline (async)",
      device.createRenderPipelineAsync.bind(device),
    );

    const scene = new Scene(primeEngine);
    scene.useRightHandedSystem = true;
    try {
      const camera = new FreeCamera("wildlife-prime-camera", new Vector3(0, 3, -15), scene);
      camera.setTarget(new Vector3(0, 1, 0));
      scene.activeCamera = camera;
      const sun = new DirectionalLight(
        "wildlife-prime-sun",
        new Vector3(-0.5, -0.8, -0.25).normalize(),
        scene,
      );
      new HemisphericLight("wildlife-prime-fill", Vector3.Up(), scene).intensity = 0.65;
      const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
      shadows.numCascades = 4;
      const probe = new ReflectionProbe("wildlife-prime-probe", 16, scene, true, true);
      scene.environmentTexture = probe.cubeTexture;
      // A caster that is always there, as terrain is in flight, so the
      // receive path does not come and go with the wildlife casters.
      const ground = CreateBox("wildlife-prime-ground", { size: 20 }, scene);
      ground.material = new StandardMaterial("wildlife-prime-ground-material", scene);
      shadows.addShadowCaster(ground, false);

      const terrainSample = () => ({ height: 0, slope: 0, biome: TerrainBiome.FOREST });
      const worldSeed = "wildlife-first-keratin";
      const system = new WildlifeSystem(scene, { worldSeed, terrainSample });
      // The nearest ground animal: deer carry antlers, boar tusks, and both
      // are keratin, drawn only for a ground animal within 460 m.
      let spawn: GroundAnimalSpawn | undefined;
      for (let cellZ = -1; cellZ <= 1 && !spawn; cellZ += 1) {
        for (let cellX = -1; cellX <= 1 && !spawn; cellX += 1) {
          spawn = generateWildlifeCell({ worldSeed, cellX, cellZ, terrainSample }).groundSpawns[0];
        }
      }
      expect(spawn, "no ground animal to sight").toBeDefined();
      const keratin = scene.getMeshByName(
        spawn!.species === "deer" ? "wildlife-deer-antler" : "wildlife-boar-tusk",
      ) as Mesh;

      // FlightRenderer's frame: the wildlife update, the dynamic shadow casters
      // re-synced from addShadowCasters (`syncDynamicShadowCasters`), the render.
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      let casters = new Map<number, Mesh>();
      const frame = (observer: { x: number; y: number; z: number }, budget: number) => {
        system.update(observer, { x: 0, y: 0, z: 0 }, { ...profile, activeAnimalBudget: budget }, 1 / 60);
        const active = new Map<number, Mesh>();
        system.addShadowCasters((mesh) => active.set(mesh.uniqueId, mesh));
        for (const [id, mesh] of casters) {
          if (!active.has(id)) shadows.removeShadowCaster(mesh, false);
        }
        for (const [id, mesh] of active) {
          if (!casters.has(id)) shadows.addShadowCaster(mesh, false);
        }
        casters = active;
        scene.render();
      };

      // Startup, then flight with no animal anywhere near until the prime
      // ends: eight frames at least, so everything else in the rig has drawn
      // and built its pipelines before counting starts.
      await scene.whenReadyAsync();
      const empty = { x: 0, y: 3_000, z: 0 };
      await renderUntilPrimesEnd(scene, () => frame(empty, 0), 8);
      expect(keratin.isEnabled()).toBe(false);

      // The first keratin sighting, rendered until the antler or tusk has
      // drawn in the main pass and the shadow map, and two frames more.
      let mainDraws = 0;
      let shadowDraws = 0;
      keratin.onAfterRenderObservable.add(() => { mainDraws += 1; });
      shadows.onAfterShadowMapRenderMeshObservable.add((mesh) => {
        if (mesh === keratin) shadowDraws += 1;
      });
      counting = true;
      const near = { x: spawn!.position.x, y: spawn!.position.y + 60, z: spawn!.position.z };
      let settle = 2;
      for (let frames = 0; frames < 120 && settle > 0; frames += 1) {
        frame(near, 64);
        if (mainDraws > 0 && shadowDraws > 0) settle -= 1;
        await nextTask();
      }
      await device.queue.onSubmittedWorkDone();
      counting = false;
      const createdAtSighting = created.join("\n");
      expect(keratin.thinInstanceCount, "the keratin batch never filled").toBeGreaterThan(0);
      expect(mainDraws, `keratin never drew in the main pass; created:\n${createdAtSighting}`)
        .toBeGreaterThan(0);
      expect(shadowDraws, `keratin never drew in the shadow map; created:\n${createdAtSighting}`)
        .toBeGreaterThan(0);
      expect(created, "the first keratin sighting compiled shaders or built pipelines mid-flight")
        .toEqual([]);
      expect(errors, errors.join("\n\n")).toEqual([]);
      system.dispose();
    } finally {
      scene.dispose();
      primeEngine.dispose();
      primeCanvas.remove();
    }
  }, 60_000);
});
