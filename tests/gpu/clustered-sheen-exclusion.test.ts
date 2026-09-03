import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { ClusteredLightingSystem, type ClusteredLightDefinition }
  from "../../src/render/webgpu/lighting/ClusteredLighting";
import { WildlifeSystem } from "../../src/render/webgpu/wildlife/WildlifeSystem";
import { TerrainBiome } from "../../src/world";

/**
 * **Does a `ClusteredLightContainer`'s CHILD COUNT break Babylon's sheen
 * codegen?** `7037eb0` took the container from 4 children to 10 and produced 20
 * `unresolved value 'normalW'` errors with no frames written; the same tree at
 * 4 children captured clean. The failing sheen branch is **not in any project
 * WGSL** — it is Babylon 9.21.2's own per-light emission — and **wildlife is
 * the only material in the tree that enables sheen**
 * (`WildlifeSystem`; the two other matches for the word are prose).
 *
 * **THIS IS A COMPILATION QUESTION, SO IT DOES NOT NEED A CAPTURE.** The
 * proposed confirmation was three full captures binary-searching the count. A
 * shader that fails to compile fails in a GPU test in seconds, so the whole
 * range is swept here instead of three points guessed at — and a threshold is
 * exactly the thing a three-point search can straddle without seeing.
 *
 * The sweep is the finding either way: a clean run across the range refutes
 * count-dependence and sends the diagnosis elsewhere, which is worth as much as
 * a hit.
 */

const CANVAS = 256;
let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
let gpuErrors: string[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false, enableAllFeatures: false, setMaximumLimits: false,
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

function clusteredDefinitions(count: number): ClusteredLightDefinition[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `sheen-probe-lamp-${i}`,
    position: [(i - count / 2) * 6, 4, 0] as const,
    color: [1, 0.8, 0.6] as const,
    intensity: 60,
    rangeMeters: 80,
  }));
}

/**
 * Compile the wildlife sheen materials against a container of `count` children,
 * optionally applying the exclusion, and count `normalW` parse errors.
 */
async function normalWErrorsAt(count: number, exclude: boolean): Promise<number> {
  gpuErrors = [];
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.03, 0.05, 0.08, 1);
  let system: WildlifeSystem | undefined;
  let clustered: ClusteredLightingSystem | undefined;
  try {
    const camera = new FreeCamera(`sheen-cam-${count}`, new Vector3(0, 3, -15), scene);
    camera.setTarget(new Vector3(0, 1, 0));
    scene.activeCamera = camera;
    const sun = new DirectionalLight(
      `sheen-sun-${count}`, new Vector3(-0.5, -0.8, -0.25).normalize(), scene);
    sun.intensity = 2.2;
    const fill = new HemisphericLight(`sheen-fill-${count}`, Vector3.Up(), scene);
    fill.intensity = 0.65;
    const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
    shadows.numCascades = 4;
    const probe = new ReflectionProbe(`sheen-probe-${count}`, 16, scene, true, true);
    scene.environmentTexture = probe.cubeTexture;

    system = new WildlifeSystem(scene, {
      worldSeed: `sheen-child-count-${count}`,
      terrainSample: () => ({ height: 0, slope: 0, biome: TerrainBiome.FOREST }),
    });
    const prototypes = scene.meshes.filter(
      (mesh) => mesh.metadata?.wildlifePrototype === true) as Mesh[];
    for (const [index, prototype] of prototypes.entries()) {
      prototype.thinInstanceSetMatrixAt(0, Matrix.Translation((index - 4.5) * 1.2, 0, 0), true);
    }
    system.addShadowCasters((mesh) => shadows.addShadowCaster(mesh, false));

    if (count > 0) {
      clustered = new ClusteredLightingSystem(scene, clusteredDefinitions(count));
      // AFTER the wildlife materials exist, which is the whole constraint: a
      // mesh takes its material after construction, so an earlier sweep sees
      // no sheen at all.
      if (exclude) clustered.excludeSheenReceivers(scene);
    }

    await scene.whenReadyAsync();
    for (let frame = 0; frame < 3; frame += 1) scene.render();
    const device = (engine as unknown as { _device: GPUDevice })._device;
    await device.queue.onSubmittedWorkDone();
  } finally {
    clustered?.dispose();
    system?.dispose();
    scene.dispose();
  }
  return gpuErrors.filter((message) => message.includes("normalW")).length;
}

describe("7-4b: clustered lighting must not reach a sheen material", () => {
  // ORDER MATTERS AND IS DELIBERATE: the EXCLUDED case runs first. Babylon
  // caches compiled effects by define set, and the count sweep this file
  // originally ran was confounded by exactly that -- whichever child count
  // compiled FIRST reported 2 errors and every later one reported 0, forward
  // AND reversed. Excluding the meshes changes the material's light set and
  // therefore its define key, so the second case genuinely recompiles: if the
  // broken case still errors after the clean case passed, neither reading is
  // a cache artifact. That is the control, built into the ordering.

  it("EXCLUDED — a container plus sheen materials compiles clean", async () => {
    const errors = await normalWErrorsAt(4, true);
    expect(
      errors,
      "excluding sheen-enabled meshes did not prevent the clustered sheen break",
    ).toBe(0);
  }, 120_000);

  it("INSTRUMENT — WITHOUT the exclusion the break reproduces, so the pass above means something", async () => {
    // Babylon 9.21.2 emits `computeSheenLighting(preInfo, normalW, ...,
    // light.vLightDiffuse.rgb)` inside `computeClusteredLighting{X}`, which is
    // a separate WGSL function, while `normalW` is local to `main`.
    //
    // ONE clustered light is enough -- measured across a 0..12 sweep, this is
    // NOT a count threshold. Do not re-run that sweep: the effect cache makes
    // every count after the first read as clean, in either direction.
    const errors = await normalWErrorsAt(1, false);
    expect(
      errors,
      "the clustered sheen break did NOT reproduce, so the excluded case above "
      + "proves nothing -- re-derive before trusting either",
    ).toBeGreaterThan(0);
  }, 120_000);

  it("NO CONTAINER — sheen materials compile clean on their own", async () => {
    // The other half of the pairing: sheen alone is fine. The defect needs both.
    expect(await normalWErrorsAt(0, false)).toBe(0);
  }, 120_000);
});
