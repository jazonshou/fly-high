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
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Logger } from "@babylonjs/core/Misc/logger";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import type { PersonVisualState, QualityLevel } from "../../src/game/types";
import type { RenderingMode } from "../../src/settings";
import { AerialPerspectiveRegistry } from "../../src/render/webgpu/atmosphere/AerialPerspective";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { CloudShadowReceiverRegistry } from "../../src/render/webgpu/clouds/CloudShadowReceiverRegistry";
import { AsyncPipelineCompiles } from "../../src/render/webgpu/core/AsyncPipelineCompiles";
import { resolveWebGpuQualityProfile, type WebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { DEFAULT_ENVIRONMENT_STATE } from "../../src/render/webgpu/nature/EnvironmentState";
import { createPersonVisual, type PersonAnimationInput, type PersonVisual } from "../../src/render/webgpu/person";

/**
 * The walker's figure on a real adapter (W2 brief), as `FlightRenderer` builds
 * it: skinned, casting into the cascaded shadows and receiving them, with the
 * cloud-shadow and aerial-perspective plugins on its materials. It compiles
 * with no device error and a fragment slot left for the clustered light
 * container (the inter-stage audit, `interStageBudget.ts`); it costs the
 * walking plan's draws per tier, one plus the cascades it casts into; the
 * skin follows the bones on the GPU; its pipelines are built off the frame
 * at load (`AsyncPipelineCompiles`), so the first walk, the first fade and
 * every mesh switch compile nothing in their frame; and a walking frame adds
 * no buffer or submit to the frame.
 */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];
let shaderModules: ShaderRecord[] = [];

const WIDTH = 256;
const HEIGHT = 256;

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await engine.initAsync();
  shaderModules = captureShaderModules(engine, 256);
  const device = (engine as unknown as { _device: GPUDevice })._device;
  device.addEventListener("uncapturederror", (event) => {
    gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
  });
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function person(mode: PersonVisualState["mode"], patch: Partial<PersonVisualState> = {}): PersonVisualState {
  return {
    kind: "person",
    mode,
    speed: 0,
    running: false,
    grounded: true,
    slope: 0,
    waterDepth: 0,
    submersion: 0,
    headDepth: -1.6,
    swimPitch: 0,
    landingSpeed: 0,
    landingAge: 10.5,
    surface: 0,
    boarding: null,
    ...patch,
  };
}

function input(state: PersonVisualState, speed = 0): PersonAnimationInput {
  return {
    person: state,
    velocityX: speed,
    velocityY: 0,
    velocityZ: 0,
    turnRate: 0,
    groundOffset: () => 0,
    steeringWheel: 0,
  };
}

/** A lit stage as the renderer's: the sun's cascades at the tier's count, the fill, the sky probe. */
function stage(scene: Scene, profile: WebGpuQualityProfile): { camera: FreeCamera; shadows: DepthOnlyCascadedShadowGenerator } {
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("person-gpu-camera", new Vector3(5, 1.1, 0), scene);
  camera.setTarget(new Vector3(0, 0.95, 0));
  camera.fov = 0.6;
  camera.minZ = 0.05;
  scene.activeCamera = camera;
  const sun = new DirectionalLight("person-gpu-sun", new Vector3(-0.5, -0.75, -0.4).normalize(), scene);
  sun.intensity = 2.6;
  new HemisphericLight("person-gpu-fill", Vector3.Up(), scene).intensity = 0.7;
  const shadows = new DepthOnlyCascadedShadowGenerator(256, sun, false, camera, true);
  shadows.numCascades = profile.shadowCascades;
  const probe = new ReflectionProbe("person-gpu-probe", 16, scene, true, true);
  scene.environmentTexture = probe.cubeTexture;
  return { camera, shadows };
}

/** The renderer's casters: every figure mesh but those marked not to cast (the fade twin and its prime). */
function addCasters(figure: PersonVisual, shadows: DepthOnlyCascadedShadowGenerator): void {
  for (const mesh of figure.meshes) {
    if (mesh.metadata?.castsShadow === false) continue;
    shadows.addShadowCaster(mesh, false);
  }
}

function primes(figure: PersonVisual): readonly Mesh[] {
  return figure.meshes.filter((mesh) => mesh.name.startsWith("person-pipeline-prime")) as Mesh[];
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function frame(scene: Scene): void {
  const own = scene.getEngine();
  own.beginFrame();
  scene.render();
  own.endFrame();
}

/** An engine on a canvas of its own, for a test the others' frames and pipelines would disturb. */
async function ownDevice(): Promise<{ engine: WebGPUEngine; canvas: HTMLCanvasElement; dispose(): void }> {
  const ownCanvas = document.createElement("canvas");
  ownCanvas.width = WIDTH;
  ownCanvas.height = HEIGHT;
  document.body.appendChild(ownCanvas);
  const ownEngine = new WebGPUEngine(ownCanvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
  await ownEngine.initAsync();
  return {
    engine: ownEngine,
    canvas: ownCanvas,
    dispose() {
      ownEngine.dispose();
      ownCanvas.remove();
    },
  };
}

describe("the walker's figure on a real adapter", () => {
  it("compiles skinned, shadowed, cloud-shadowed and hazed, with a slot left for the clustered container", async () => {
    gpuErrors.length = 0;
    shaderModules.length = 0;
    const loggerErrors: string[] = [];
    const loggerError = Logger.Error;
    Logger.Error = ((message: string | unknown[], limit?: number) => {
      loggerErrors.push(Array.isArray(message) ? message.join(" ") : String(message));
      loggerError.call(Logger, message as string, limit);
    }) as typeof Logger.Error;
    const scene = new Scene(engine);
    try {
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const { camera, shadows } = stage(scene, profile);
      const figure = createPersonVisual(scene, { profile });
      addCasters(figure, shadows);
      const clouds = new CloudShadowReceiverRegistry();
      clouds.registerMeshes(figure.meshes);
      const aerial = new AerialPerspectiveRegistry();
      aerial.registerMeshes(figure.meshes);
      aerial.setProjection({
        state: DEFAULT_ENVIRONMENT_STATE,
        cameraAltitudeMeters: camera.position.y,
        sunColor: [1, 0.95, 0.88],
        skyHorizonColor: [0.35, 0.55, 0.72],
        sunIlluminanceNormalized: 1,
        moonDirection: [0, -1, 0],
        moonIlluminanceNormalizedToFull: 0,
      }, 0, 0);
      for (let step = 0; step < 30; step += 1) figure.update(input(person("walk", { speed: 1.4 }), 1.4), 1 / 60);
      await scene.whenReadyAsync();
      for (let step = 0; step < 4; step += 1) scene.render();
      // The fade's blended twin over its depth pre-pass.
      figure.setFade(0.5);
      await scene.whenReadyAsync();
      for (let step = 0; step < 4; step += 1) scene.render();
      const device = (engine as unknown as { _device: GPUDevice })._device;
      await device.queue.onSubmittedWorkDone();
      expect(gpuErrors, gpuErrors.join("\n\n")).toEqual([]);
      expect(loggerErrors, loggerErrors.join("\n\n")).toEqual([]);
      aerial.dispose();
      clouds.dispose();
      figure.dispose();
    } finally {
      Logger.Error = loggerError;
      scene.dispose();
    }
    const { peak, headroom, absent } = auditInterStage(shaderModules, {
      label: "walker figure (skinned PBR)",
      requiredMarkers: [...CSM_RECEIVE_MARKERS, "matricesIndices", "cloudShadowReceiverValid", "aerialSunDirection"],
    });
    expect(absent, "the rig did not compile the shipping path, so the budget below describes a material that does not exist").toEqual([]);
    expect(peak, "no FragmentInputs struct was captured: the audit is vacuous").toBeGreaterThan(0);
    expect(peak, `the figure compiles at ${peak} fragment inputs, over the device's ${INTER_STAGE_LIMIT}`).toBeLessThanOrEqual(INTER_STAGE_LIMIT);
    expect(headroom, `the figure has no slot for a clustered light container (peak ${peak}/${INTER_STAGE_LIMIT})`).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it.each([
    ["low", "balanced", 2],
    ["medium", "balanced", 3],
    ["high", "balanced", 3],
    ["high", "ultra", 3],
  ] as const)("draws %s/%s at the walking plan's %i draws: one plus the cascades it casts into", async (quality, mode, draws) => {
    const profile = resolveWebGpuQualityProfile(quality as QualityLevel, mode as RenderingMode);
    const scene = new Scene(engine);
    const counter = (engine as unknown as { _drawCalls: { fetchNewFrame(): void; current: number } })._drawCalls;
    const drawn = async (): Promise<number> => {
      await scene.whenReadyAsync();
      scene.render();
      counter.fetchNewFrame();
      scene.render();
      return Math.round(counter.current);
    };
    try {
      const { shadows } = stage(scene, profile);
      const empty = await drawn();
      const figure = createPersonVisual(scene, { profile });
      addCasters(figure, shadows);
      // Standing, then rendered until the pipeline primes have drawn and gone dark.
      for (let step = 0; step < 4 && primes(figure).some((mesh) => mesh.isEnabled()); step += 1) {
        figure.update(input(person("stand")), 1 / 60);
        await scene.whenReadyAsync();
        scene.render();
      }
      expect(primes(figure).every((mesh) => !mesh.isEnabled()), "the primes never went dark").toBe(true);
      figure.update(input(person("stand")), 1 / 60);
      const withFigure = await drawn();
      expect(withFigure - empty, `${quality}/${mode} (${profile.shadowCascades} cascades, the figure in ${profile.personShadowCascades})`).toBe(draws);
      expect(1 + Math.min(profile.personShadowCascades, profile.shadowCascades)).toBe(draws);
      figure.dispose();
    } finally {
      scene.dispose();
    }
  }, 120_000);

  it("moves the skin with the bones: a hard landing's crouch lowers the drawn head", async () => {
    // A canvas of its own: read back after the tests above, the shared one comes back black.
    const device = await ownDevice();
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const scene = new Scene(device.engine);
    try {
      stage(scene, profile);
      const figure = createPersonVisual(scene, { profile });
      // The top of the drawn figure, in rows from the canvas's top: rendered and read in one task.
      const top = async (): Promise<number> => {
        await scene.whenReadyAsync();
        frame(scene);
        frame(scene);
        frame(scene);
        const copy = document.createElement("canvas");
        copy.width = WIDTH;
        copy.height = HEIGHT;
        const context = copy.getContext("2d")!;
        context.drawImage(device.canvas, 0, 0);
        const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
        for (let row = 0; row < HEIGHT; row += 1) {
          for (let column = 0; column < WIDTH; column += 1) {
            const at = (row * WIDTH + column) * 4;
            if (pixels[at]! + pixels[at + 1]! + pixels[at + 2]! > 30) return row;
          }
        }
        return HEIGHT;
      };
      for (let step = 0; step < 60; step += 1) figure.update(input(person("stand")), 1 / 60);
      const standing = await top();
      // A 6.5 m/s landing, at the bottom of its crouch.
      for (let step = 0; step <= 10; step += 1) figure.update(input(person("land", { landingSpeed: 6.5, landingAge: step / 60 })), 1 / 60);
      const crouched = await top();
      // 5 m away at a 0.6 rad field of view, a row is about 1.5 cm: the crouch's 20 cm and more is over a dozen.
      expect(standing, "the standing figure is not in the picture").toBeGreaterThan(5);
      expect(standing).toBeLessThan(HEIGHT / 2);
      expect(crouched - standing, `the head stood at row ${standing} and crouched at ${crouched}`).toBeGreaterThan(10);
      figure.dispose();
    } finally {
      scene.dispose();
      device.dispose();
    }
  }, 120_000);

  it("builds its pipelines off the frame at load, so the first walk, fade and mesh switch compile nothing in theirs, and walks with no upload of its own", async () => {
    // A device of its own: the tests above leave this file's engine holding the figure's pipelines.
    const own = await ownDevice();
    const prototype = Mesh.prototype as unknown as Record<string, unknown>;
    let processRendering: ((this: Mesh, ...args: unknown[]) => unknown) | null = null;
    const pipelines: { readonly mesh: string | null; readonly mode: "sync" | "async" }[] = [];
    const errors: string[] = [];
    let drawingMesh: string | null = null;
    try {
      const device = (own.engine as unknown as { _device: GPUDevice })._device;
      device.addEventListener("uncapturederror", (event) => {
        errors.push(String((event as GPUUncapturedErrorEvent).error.message));
      });
      const createRenderPipeline = device.createRenderPipeline.bind(device);
      const createRenderPipelineAsync = device.createRenderPipelineAsync.bind(device);
      device.createRenderPipeline = (descriptor) => {
        pipelines.push({ mesh: drawingMesh, mode: "sync" });
        return createRenderPipeline(descriptor);
      };
      device.createRenderPipelineAsync = (descriptor) => {
        pipelines.push({ mesh: drawingMesh, mode: "async" });
        return createRenderPipelineAsync(descriptor);
      };
      const scene = new Scene(own.engine);
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const { camera, shadows } = stage(scene, profile);
      const compiles = AsyncPipelineCompiles.install(scene)!;
      expect(compiles, "the Babylon surface the off-frame compiles hook is missing").not.toBeNull();
      const hooked = prototype["_processRendering"] as (this: Mesh, ...args: unknown[]) => unknown;
      processRendering = hooked;
      prototype["_processRendering"] = function (this: Mesh, ...args: unknown[]) {
        const outer = drawingMesh;
        drawingMesh = this.name;
        try {
          return hooked.apply(this, args);
        } finally {
          drawingMesh = outer;
        }
      };
      const render = (): void => frame(scene);

      // Load, as the renderer builds it: hidden in a car session until the walker gets out.
      const figure = createPersonVisual(scene, { profile, pipelineCompiles: compiles });
      figure.root.setEnabled(false);
      addCasters(figure, shadows);
      for (let attempt = 0; attempt < 240 && primes(figure).some((mesh) => mesh.isEnabled()); attempt += 1) {
        await compiles.whenIdle();
        await nextTask();
        render();
      }
      expect(primes(figure).every((mesh) => !mesh.isEnabled()), "the primes never went dark").toBe(true);
      expect(compiles.statistics.warmUpsCompleted, "both primes warmed").toBeGreaterThanOrEqual(2);
      const ours = (from: number, mode: "sync" | "async") =>
        pipelines.slice(from).filter((record) => record.mode === mode && /^person-/u.test(record.mesh ?? "")).map((record) => record.mesh);
      expect(ours(0, "sync"), "a figure pipeline compiled in a load frame").toEqual([]);
      expect(ours(0, "async").length, "the primes compiled nothing off the frame").toBeGreaterThan(0);

      // Out of the car: walking in view and in the shadows, then a camera pushed in (the fade),
      // first person, and walking away through both coarser meshes.
      const mark = pipelines.length;
      const deferredBefore = compiles.statistics.deferredDraws;
      figure.root.setEnabled(true);
      const walk = (frames: number): void => {
        for (let step = 0; step < frames; step += 1) {
          figure.update(input(person("walk", { speed: 1.4 }), 1.4), 1 / 60);
          render();
        }
      };
      walk(20);
      // A walking frame uploads its bones in the draws' uniforms: no buffer and
      // no submit of its own (Babylon's bone texture made one of each a frame).
      const work = { buffers: 0, submits: 0 };
      const createBuffer = device.createBuffer.bind(device);
      const submit = device.queue.submit.bind(device.queue);
      device.createBuffer = (descriptor) => {
        work.buffers += 1;
        return createBuffer(descriptor);
      };
      device.queue.submit = (commandBuffers) => {
        work.submits += 1;
        return submit(commandBuffers);
      };
      walk(10);
      const walking = { ...work };
      work.buffers = 0;
      work.submits = 0;
      figure.root.setEnabled(false);
      for (let step = 0; step < 10; step += 1) render();
      figure.root.setEnabled(true);
      device.createBuffer = createBuffer;
      device.queue.submit = submit;
      expect(walking, "ten walking frames against ten with the figure hidden").toEqual(work);
      figure.setFade(0.5);
      walk(10);
      figure.setFade(0);
      figure.setFirstPersonView(true);
      walk(10);
      figure.setFirstPersonView(false);
      const drawnLods = new Set<string>();
      for (const distance of [40, 120]) {
        camera.position.set(distance, 1.6, 0);
        walk(5);
        for (const mesh of figure.meshes) if (mesh.isVisible && /lod/u.test(mesh.name)) drawnLods.add(mesh.name);
      }
      expect(drawnLods, "the walk away never switched mesh").toEqual(new Set(["person-figure-lod1", "person-figure-lod2"]));
      expect(ours(mark, "sync"), "the walk, the fade or a mesh switch compiled in its frame").toEqual([]);
      expect(ours(mark, "async"), "the walk, the fade or a mesh switch waited for a compile").toEqual([]);
      expect(compiles.statistics.deferredDraws).toBe(deferredBefore);
      await device.queue.onSubmittedWorkDone();
      expect(errors, errors.join("\n\n")).toEqual([]);
      figure.dispose();
      compiles.dispose();
      scene.dispose();
    } finally {
      if (processRendering) prototype["_processRendering"] = processRendering;
      own.dispose();
    }
  }, 300_000);
});
