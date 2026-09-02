import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import {
  LightPointSystem,
  packIesProfiles,
  type LightPointFixture,
} from "../../src/render/webgpu/lighting/LightPoints";

/**
 * `7-5` — on-adapter compile test for the light-point billboard.
 *
 * The Node test beside this one proves the shader STRING assembled with the
 * aerial include in it. Only a real adapter proves the string survived
 * compilation: a missing symbol, an over-limit inter-stage count, or a
 * declared-but-unbound sampler are all pipeline-creation failures rather than
 * graceful fallbacks, and none of them is visible to `tsc` or to any Node test.
 *
 * THREE TRAPS THIS TEST IS BUILT NOT TO FALL INTO, each of which has cost
 * someone an hour on this project in the last day:
 *
 *  1. **`isReady()` returns true on a shader with an unresolved symbol.** A
 *     readiness flag is not a compile check, so this asserts on captured
 *     `uncapturederror` events instead.
 *  2. **Reading `subMeshes[0].effect` after driving another pass returns THAT
 *     pass's effect**, carrying none of the beauty permutation's defines — and
 *     reports a clean all-clear on both arms. This never reads through a
 *     submesh; it identifies the beauty module by a symbol only that
 *     permutation carries.
 *  3. **The `createShaderModule` interception can capture NOTHING**, because
 *     Babylon may hold its own device reference. An assertion over an empty
 *     capture set PASSES, which would report the include present when nothing
 *     had been read at all. So the capture is proved non-empty BEFORE anything
 *     is asserted about its content, and an interception that does not work is
 *     recorded as a finding about the harness rather than as a green test.
 */

const CANVAS_SIZE = 64;

interface ShaderRecord {
  label: string;
  code: string;
  /**
   * The module itself, so compilation can be asserted from `getCompilationInfo`
   * rather than from an error channel Babylon may own.
   *
   * FOUND THE HARD WAY: this test first passed 4/4 while the shader failed to
   * compile with `unresolved type 'FragmentOutputs'`. Babylon installs its own
   * uncaptured-error handler and logs the failure itself, so the
   * `uncapturederror` listener never fired and `gpuErrors` stayed empty. And
   * capturing the SOURCE proves only that the string reached the device --
   * `createShaderModule` is still called for a module that is invalid. So both
   * of the original legs were satisfied by a broken shader.
   */
  module: GPUShaderModule;
}

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
const gpuErrors: string[] = [];
const shaderModules: ShaderRecord[] = [];
let interceptionInstalled = false;

/** A minimal IESNA:LM-63 profile — a cosine fan, enough to exercise the parser. */
function syntheticIes(): Uint8Array {
  const angles = Array.from({ length: 19 }, (_, index) => index * 5);
  const candela = angles.map((a) => Math.max(0, Math.cos((a * Math.PI) / 180)) * 1000);
  const text = [
    "IESNA:LM-63-1995",
    "TEST=synthetic",
    "[TESTLAB] none",
    "TILT=NONE",
    `1 1000 1 ${angles.length} 1 1 2 0 0 0`,
    "1 1 0",
    angles.join(" "),
    "0",
    candela.map((c) => c.toFixed(3)).join(" "),
  ].join("\n") + "\n";
  return new TextEncoder().encode(text);
}

const FIXTURES: LightPointFixture[] = [
  { position: [0, 2, 10], aim: [0, 1, 0], intensity: 5, profileRow: 0, radiusMeters: 0.12, color: [1, 1, 0.9] },
  { position: [3, 2, 12], aim: [0, 1, 0], intensity: 5, profileRow: 0, radiusMeters: 0.12, color: [1, 0.3, 0.2] },
  { position: [-3, 2, 14], aim: [0, 0, 1], intensity: 8, profileRow: 0, radiusMeters: 0.08, color: [0.3, 0.6, 1] },
];

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
      if (shaderModules.length > 64) shaderModules.shift();
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

function renderOnce(fixtures: readonly LightPointFixture[]): LightPointSystem {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("camera", new Vector3(0, 2, 0), scene);
  camera.setTarget(new Vector3(0, 2, 20));
  const packed = packIesProfiles(scene, [syntheticIes()]);
  const system = new LightPointSystem(scene, fixtures, packed.rows);
  system.setIesProfiles(packed.texture);
  system.setOutputSize(CANVAS_SIZE, CANVAS_SIZE);
  system.setCameraPosition(camera.position);
  for (let frame = 0; frame < 4; frame += 1) scene.render();
  return system;
}

describe("7-5 light points compile on a real adapter", () => {
  it("installed the shader interception at all", () => {
    // TRAP 3, first: without this, every content assertion below is vacuously
    // true over an empty array. An interception that silently did not install
    // is a finding about the harness, not a passing test.
    expect(interceptionInstalled, "could not reach the GPUDevice to intercept").toBe(true);
  });

  it("compiles the billboard with no GPU errors, and captured real modules", async () => {
    renderOnce(FIXTURES);
    // TRAP 1, corrected: not readiness, and not Babylon's error channel either
    // -- it owns the uncaptured-error handler, so `gpuErrors` can stay empty
    // through a hard compile failure. Ask the module whether it compiled.
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
    // TRAP 3, second leg: the capture must be non-empty AND must contain this
    // material rather than merely some module Babylon compiled for the scene.
    expect(shaderModules.length, "no shader modules were captured at all")
      .toBeGreaterThan(0);
    const beauty = shaderModules.filter((record) => record.code.includes("lightTint"));
    expect(
      beauty.length,
      `captured ${shaderModules.length} modules, none carrying the light-point `
      + `symbol "lightTint" — the interception saw shaders, but not this one`,
    ).toBeGreaterThan(0);
  });

  it("carries the owned aerial include into the COMPILED source", () => {
    // The Node test proves the string assembled. This proves it survived
    // compilation — a missing `${AERIAL_PERSPECTIVE_WGSL}` interpolation would
    // fail here as a symbol error rather than as a missing include.
    const withInclude = shaderModules.filter(
      (record) => record.code.includes("lightTint") && record.code.includes("fn aerialPerspective("),
    );
    expect(
      withInclude.length,
      "no compiled light-point module carries `fn aerialPerspective(`",
    ).toBeGreaterThan(0);
    // And the additive-billboard decision, asserted where it actually ships:
    // in-scatter must not be added, or the path's haze lands once per light.
    for (const record of withInclude) {
      expect(record.code.includes("haze.inScatter"), "in-scatter added to an additive sprite")
        .toBe(false);
    }
  });

  it("renders an empty fixture list without error", () => {
    // The GPU half of the empty-path assertion. `FlightRenderer` constructs
    // this system empty until 7-7 authors the fixtures, so "nothing renders"
    // must be provably distinct from "the system is broken".
    const before = gpuErrors.length;
    expect(() => renderOnce([])).not.toThrow();
    expect(gpuErrors.slice(before), gpuErrors.slice(before).join("\n---\n")).toEqual([]);
  });
});
