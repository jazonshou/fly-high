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
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
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
      const prototypes = scene.meshes.filter(
        (mesh) => mesh.metadata?.wildlifePrototype === true,
      ) as Mesh[];
      expect(prototypes).toHaveLength(10);
      for (const [index, prototype] of prototypes.entries()) {
        prototype.thinInstanceSetMatrixAt(
          0,
          Matrix.Translation((index - 4.5) * 1.2, 0, 0),
          true,
        );
        prototype.thinInstanceCount = 1;
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
