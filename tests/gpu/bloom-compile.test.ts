import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { BloomPass, bloomBlurWeights } from "../../src/render/webgpu/lighting/BloomPass";

/**
 * `7-5` — on-adapter compile test for the three bloom shaders.
 *
 * These three strings have no other compiler. `tsc` sees them as text and the
 * Node tests assert their CONTENT, which is exactly the check that passed while
 * the light-point shader failed to compile with `unresolved type
 * FragmentOutputs`. Three separate WGSL defects have shipped past a green Node
 * suite in this project in one day, so a new shader without an adapter test is
 * a shader nobody has compiled.
 *
 * Structured after `light-points-compile.test.ts`, including its three traps:
 * readiness is not compilation, Babylon owns the uncaptured-error handler, and
 * an assertion over an empty capture set passes vacuously.
 */

const CANVAS_SIZE = 64;

interface ShaderRecord {
  label: string;
  code: string;
  module: GPUShaderModule;
}

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];
const shaderModules: ShaderRecord[] = [];
let interceptionInstalled = false;

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

  const device = (engine as unknown as { _device?: GPUDevice })._device;
  if (device) {
    const originalCreate = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
      const created = originalCreate(descriptor);
      shaderModules.push({
        label: String(descriptor.label ?? ""),
        code: String(descriptor.code),
        module: created,
      });
      return created;
    };
    interceptionInstalled = true;
    device.addEventListener("uncapturederror", (event) => {
      gpuErrors.push(String((event as GPUUncapturedErrorEvent).error.message));
    });
  }
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** True once all three bloom stages have reached the device. */
function capturedAllStages(): boolean {
  const has = (needle: string) => shaderModules.some((r) => r.code.includes(needle));
  return has("BLOOM_PHOTOPIC") && has("bloomBlurDirection") && has("bloomSceneSampler");
}

/**
 * Pump frames until the three modules appear, rather than rendering a fixed
 * four.
 *
 * FOUND THE HARD WAY, and it is a different trap from the three above. Four
 * synchronous `scene.render()` calls captured ZERO modules: a post-process
 * effect compiles ASYNCHRONOUSLY, and until it is ready Babylon skips the pass
 * rather than blocking on it. A mesh-based test gets away with a fixed frame
 * count because the mesh forces a synchronous-enough path; a post-process does
 * not.
 *
 * The failure mode this creates is the dangerous one: with no modules captured,
 * every content assertion over the array passes VACUOUSLY. The
 * generated-weights test did exactly that -- it reported green on a run where
 * nothing had compiled at all. Only the explicit non-empty check failed, which
 * is the entire reason it is written separately.
 */
async function renderUntilCompiled(): Promise<void> {
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 2, 0), scene);
    camera.setTarget(new Vector3(0, 2, 20));
    const bloom = new BloomPass(camera, engine, 1);
    try {
      for (let frame = 0; frame < 240 && !capturedAllStages(); frame += 1) {
        scene.render();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      framesPumped = capturedAllStages();
    } finally {
      bloom.dispose(camera);
    }
  } finally {
    scene.dispose();
  }
}

let framesPumped = false;

describe("7-5 bloom compiles on a real adapter", () => {
  it("installed the shader interception at all", () => {
    expect(interceptionInstalled, "could not reach the GPUDevice to intercept").toBe(true);
  });

  it("compiles all three passes with no diagnostics", async () => {
    await renderUntilCompiled();
    expect(framesPumped, "the three bloom stages never reached the device within "
      + "240 frames -- every content assertion below would be vacuous").toBe(true);
    const diagnostics: string[] = [];
    for (const record of shaderModules) {
      const info = await record.module.getCompilationInfo();
      for (const message of info.messages) {
        if (message.type === "error") {
          diagnostics.push(`${record.label}:${message.lineNum}:${message.linePos} ${message.message}`);
        }
      }
    }
    expect(diagnostics, diagnostics.join("\n")).toEqual([]);
    expect(gpuErrors, gpuErrors.join("\n---\n")).toEqual([]);
    expect(shaderModules.length, "no shader modules were captured at all")
      .toBeGreaterThan(0);
  });

  it("captured each of the three bloom stages, not just some module", async () => {
    // Non-vacuity with teeth: naming the stages individually means a pass that
    // silently failed to build is a failure here rather than a quiet absence.
    const bright = shaderModules.filter((r) => r.code.includes("BLOOM_PHOTOPIC"));
    const blur = shaderModules.filter((r) => r.code.includes("bloomBlurDirection"));
    const composite = shaderModules.filter((r) => r.code.includes("bloomSceneSampler"));
    expect(bright.length, "no compiled module carries the bright pass").toBeGreaterThan(0);
    expect(blur.length, "no compiled module carries the blur").toBeGreaterThan(0);
    expect(composite.length, "no compiled module carries the composite").toBeGreaterThan(0);
  });

  it("compiled the blur with the generated weights, unrolled", () => {
    // The weights reaching the DEVICE are the ones the Node test checked --
    // proving the generation survived shader assembly, not just module load.
    const weights = bloomBlurWeights();
    // Select the module that carries ALL the weights, rather than every module
    // mentioning `bloomBlurDirection`.
    //
    // FOUND THE HARD WAY, and it is trap 2 in a new costume: a post-process is
    // TWO modules, vertex and fragment, and Babylon declares the uniform block
    // in both. Filtering on the uniform name therefore matched the vertex
    // stage, which has no blur body and no weights, and the test failed on a
    // shader that was entirely correct. Identify a stage by something only that
    // stage can contain.
    const blur = shaderModules.filter(
      (r) => weights.every((w) => r.code.includes(w.toFixed(9))),
    );
    expect(
      blur.length,
      "no compiled module carries the full generated weight set",
    ).toBeGreaterThan(0);
    for (const record of blur) {
      // No dynamic index into a const array -- an adapter that rejects it
      // would fail at pipeline creation on someone else's machine.
      expect(record.code.includes("array<"), "blur uses an array, not unrolled taps")
        .toBe(false);
    }
  });
});
