import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Side-effect import: tree-shaken Babylon needs the shadow scene component
// registered before shadow maps render.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import { createGuardedShadowDepthWrapper } from "../../src/render/webgpu/core/guardedShadowDepthWrapper";

/**
 * 4.5-0 — the resetDrawCache / ShadowDepthWrapper orphaned-defines fatal stop,
 * reproduced and pinned (the 77ba8f3 idiom: fails on any uncaptured GPU error
 * or frame-loop throw).
 *
 * The shipped crash: WorldDetailRuntime grows a foliage batch's instance
 * buffer and calls `mesh.resetDrawCache(undefined, true)` on a mesh that has
 * already rendered. The material's ShadowDepthWrapper still holds that
 * submesh's forward-effect registration; on the submesh's FIRST depth render
 * for a generator, `_makeEffect` copies the (destroyed) forward wrapper's
 * `defines` — `undefined` — into its cached depth params. PBR's
 * `bindForSubMesh` silently early-returns on null defines, the depth draw
 * executes against an empty material context, and `device.createBindGroup`
 * throws "Required member is undefined": the "Unable to continue flight"
 * banner.
 *
 * Making the window deterministic needs one more ingredient: a camera-visible
 * mesh whose effect survives in the engine cache heals in the SAME frame —
 * `_evaluateActiveMeshes` recreates the forward wrapper before the shadow RTT
 * renders. In flight the window stays open because the crashing caster is not
 * in the main camera's evaluation that frame (culled, or a terrain caster
 * with layerMask 0, or its recompile is mid-flight). The test holds the
 * window open the same way the terrain casters do: layerMask = 0 while the
 * first depth render happens.
 *
 * Test 1 is the non-vacuity control: the raw wrapper must still die in this
 * sequence. If Babylon fixes the orphaning upstream this control fails, which
 * is the signal to retire the guard.
 * Test 2 is the fix: the guarded wrapper takes its not-ready skip (the seam
 * proves the guard FIRED) with zero uncaptured errors, and once the mesh is
 * camera-visible again the shadow appears — the guard heals rather than
 * silently never casting.
 */

const CANVAS_SIZE = 256;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
let gpuErrors: string[] = [];

/**
 * A FRESH engine and device per test, not a shared one.
 *
 * The non-vacuity case deliberately crashes a frame, and both WebGPU's
 * `uncapturederror` delivery and Babylon's deferred effect disposal
 * (`SetImmediate` → `onEndFrameObservable.addOnce`) land after that test's
 * teardown. On a shared device those arrive inside the next test's frames and
 * fail its zero-errors assertion for reasons unrelated to the guard.
 */
beforeEach(async () => {
  gpuErrors = [];
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

afterEach(() => {
  engine?.dispose();
  canvas?.remove();
});

interface Rig {
  scene: Scene;
  box: Mesh;
  generator: ShadowGenerator;
  dispose(): void;
}

function buildRig(
  makeWrapper: (material: PBRMaterial, scene: Scene) => ShadowDepthWrapper,
): Rig {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);

  const camera = new FreeCamera("reset-camera", new Vector3(0, 90, 0), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -80;
  camera.orthoRight = 80;
  camera.orthoTop = 80;
  camera.orthoBottom = -80;
  camera.setTarget(new Vector3(0, 0, 0.01));
  scene.activeCamera = camera;

  const light = new DirectionalLight(
    "reset-sun",
    new Vector3(0.45, -1, 0.2).normalize(),
    scene,
  );
  light.position = new Vector3(0, 70, 0);
  light.intensity = 1.4;
  light.autoUpdateExtends = false;
  light.shadowFrustumSize = 200;
  light.shadowMinZ = 1;
  light.shadowMaxZ = 200;

  const ground = CreateGround("reset-ground", { width: 160, height: 160 }, scene);
  const groundMaterial = new StandardMaterial("reset-ground-material", scene);
  groundMaterial.diffuseColor = new Color3(0.75, 0.75, 0.75);
  groundMaterial.specularColor = new Color3(0, 0, 0);
  ground.material = groundMaterial;
  ground.receiveShadows = true;

  const box = CreateBox("reset-box", { size: 10 }, scene);
  box.position.y = 20;
  const material = new PBRMaterial("reset-box-material", scene);
  material.roughness = 1;
  material.metallic = 0;
  material.emissiveColor = new Color3(1, 1, 1);
  // The production crash needs a depth pipeline whose bind-group layout has a
  // MATERIAL-context entry (the foliage material's atlas/cloud-shadow/albedo
  // samplers): with the poisoned null defines, bindForSubMesh early-returns,
  // the entry stays unbound, and createBindGroup dies. An emissive-only PBR
  // depth pipeline needs nothing from the material context and renders
  // "fine", so the window would be invisible here without this texture.
  material.albedoTexture = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
  );
  box.material = material;
  // Production foliage shares one material (and thus one cached forward
  // effect) across many batch meshes, so one batch's immediate-dispose reset
  // cannot release the effect's sources — that is what lets the wrapper build
  // its depth effect from a submesh whose own wrapper is destroyed, the crash
  // branch. With a single holder the dispose clears the sources and the
  // wrapper lands in the silent never-casts branch instead. A second mesh on
  // the same material reproduces the shared-effect reality.
  const keeper = CreateBox("reset-box-keeper", { size: 10 }, scene);
  keeper.position.set(-40, 20, -40);
  keeper.material = material;
  // The production incantation: wrapper before the first effect compiles. A
  // nonzero normalBias would need remappedVariables (2-12); the default 0
  // compiles the include away, which is fine — the failure under test is in
  // the wrapper's defines cache, not the injected include.
  material.shadowDepthWrapper = makeWrapper(material, scene);

  // NOT a caster yet: the crash window is [forward effect registered,
  // depth params not built]. The caster is added after the reset.
  const generator = new ShadowGenerator(1024, light);

  return { scene, box, generator, dispose: () => scene.dispose() };
}

/**
 * Render frames, collecting any frame-loop throw instead of failing mid-loop.
 *
 * `endFrame` runs in a `finally`: this test exists to make `scene.render()`
 * throw, and skipping it would leave the frame's command and render-pass
 * encoders unfinished, leaking WebGPU errors into whatever runs next.
 */
async function renderFrames(rig: Rig, count: number): Promise<Error | null> {
  let thrown: Error | null = null;
  for (let frame = 0; frame < count; frame += 1) {
    try {
      engine.beginFrame();
      rig.scene.render();
    } catch (caught) {
      thrown = caught instanceof Error ? caught : new Error(String(caught));
    } finally {
      engine.endFrame();
    }
    if (thrown) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return thrown;
}

/**
 * Render until the box's forward effect is actually ready, then return.
 *
 * A fixed frame count is not enough: `_makeEffect` bails on
 * `!origEffect.isReady()` BEFORE it can cache poisoned defines, so on an
 * adapter that is still compiling when the reset lands, no poisoning happens
 * and the non-vacuity control fails with a message telling the next reader to
 * retire armour that is still load-bearing.
 */
async function renderUntilForwardEffectReady(rig: Rig): Promise<void> {
  const subMesh = rig.box.subMeshes[0]!;
  const material = rig.box.material!;
  for (let frame = 0; frame < 240; frame += 1) {
    const error = await renderFrames(rig, 1);
    expect(error).toBeNull();
    if (material.isReadyForSubMesh(rig.box, subMesh, false)) return;
  }
  expect.fail("the box's forward effect never became ready within 240 frames");
}

/** Count canvas pixels clearly darker than the lit ground (received shadow). */
function countShadowPixels(rig: Rig): number {
  engine.beginFrame();
  rig.scene.render();
  engine.endFrame();
  const copy = document.createElement("canvas");
  copy.width = CANVAS_SIZE;
  copy.height = CANVAS_SIZE;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
  const brightness: number[] = [];
  for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
    brightness.push((image[index * 4] ?? 0) / 255);
  }
  const sorted = [...brightness].sort((first, second) => first - second);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  expect(median).toBeGreaterThan(0.2);
  return brightness.filter((value) => value < median * 0.6).length;
}

const VISIBLE_LAYER_MASK = 0x0fffffff;

async function runResetThenCastSequence(rig: Rig): Promise<Error | null> {
  // 1. Render until the main pass has actually compiled the forward effect
  //    and the wrapper has recorded the submesh registration — observed, not
  //    assumed after N frames.
  await renderUntilForwardEffectReady(rig);
  // 2. The production trigger, verbatim from bindInstanceBuffers: destroy the
  //    submesh's draw wrappers while the wrapper's registration survives —
  //    and hold the heal open the way the terrain casters do (layerMask 0
  //    keeps the mesh out of the main pass; shadow RTTs render it anyway).
  rig.box.layerMask = 0;
  rig.box.resetDrawCache(undefined, true);
  // 3. First depth render of this (subMesh, generator) happens AFTER the
  //    reset, with no main-pass heal available.
  rig.generator.addShadowCaster(rig.box);
  return renderFrames(rig, 30);
}

describe("ShadowDepthWrapper orphaned-defines guard (4.5-0)", () => {
  it("assertion 118a (non-vacuity): the raw wrapper still dies when a registered submesh is reset before its first depth render", async () => {
    const rig = buildRig(
      (material, scene) => new ShadowDepthWrapper(material, scene, {}),
    );
    try {
      let thrown = await runResetThenCastSequence(rig);
      if (thrown === null && gpuErrors.length === 0) {
        // The poisoned depth params persist; give the heal path a chance to
        // trip over them too before declaring the window closed.
        rig.box.layerMask = VISIBLE_LAYER_MASK;
        thrown = await renderFrames(rig, 20);
      }
      const died = thrown !== null || gpuErrors.length > 0;
      // If this starts passing cleanly, Babylon fixed the orphaning upstream:
      // retire the guard rather than keeping dead armour.
      expect(
        died,
        "raw ShadowDepthWrapper survived the reset-then-cast window — "
          + "re-evaluate whether the 4.5-0 guard is still needed",
      ).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it("assertion 118b: guarded wrapper skips the poisoned window, then heals — no errors and the shadow appears", async () => {
    let orphanSkips = 0;
    const rig = buildRig((material, scene) =>
      createGuardedShadowDepthWrapper(material, scene, {
        onOrphanSkip: () => {
          orphanSkips += 1;
        },
      }),
    );
    try {
      const thrown = await runResetThenCastSequence(rig);
      expect(thrown).toBeNull();
      expect(gpuErrors, gpuErrors.join("\n")).toEqual([]);
      // Not vacuously green: the guard must actually have refused to build
      // depth params from the destroyed forward wrapper.
      expect(orphanSkips).toBeGreaterThan(0);
      // The guard must heal, not amputate: once the mesh is camera-visible
      // again the forward wrapper is recreated, the depth params build
      // correctly, and the box casts.
      rig.box.layerMask = VISIBLE_LAYER_MASK;
      const healError = await renderFrames(rig, 20);
      expect(healError).toBeNull();
      const shadowPixels = countShadowPixels(rig);
      expect(shadowPixels).toBeGreaterThan(50);
      expect(gpuErrors, gpuErrors.join("\n")).toEqual([]);
    } finally {
      rig.dispose();
    }
  });
});
