import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureShaderModules, type ShaderRecord } from "./interStageBudget";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  LightPointSystem,
  type LightPointFixture,
} from "../../src/render/webgpu/lighting/LightPoints";

/**
 * `7-9`'s pin: **no light-count-dependent shader recompilation during flight.**
 *
 * **WRITTEN INSTRUMENT-FIRST, because the trivial version of this test passes
 * for the wrong reason.** A test that changes a light count and observes no
 * recompilation proves nothing unless it has first shown it can SEE one — and
 * here that risk is not hypothetical: `LightPointSystem` takes its fixtures in
 * the CONSTRUCTOR and exposes no setter, so the count is immutable for the
 * system's lifetime and "the count did not cause a recompile" is true by
 * construction. So the first case below deliberately CAUSES a recompilation and
 * fails if it cannot detect one. Only then do the others assert an absence.
 *
 * **The finding this exists to carry forward.** Light-point count is safe: the
 * lamps are one instanced draw whose shader has no count in it, so a hundred
 * fixtures and four compile the same source. **Babylon's clustered light path
 * is NOT safe in the same way** — it emits `CLUSTLIGHT_SLICES` into the define
 * list, which is part of the effect cache key, so changing the container's
 * configuration recompiles every receiving material. `7-4b` has not attached a
 * container yet (nothing in `src/` constructs one), and when it does, **the
 * slice configuration is the thing that must be fixed at profile-resolution
 * time and never moved in flight.** That is the real content of this pin; the
 * light-point half is the easy half.
 *
 * The clustered half is NOT asserted here. It is measured on-device by
 * `clustered-lighting-adapter-spike`, which reads `CLUSTLIGHT_SLICES` out of
 * the compiled define list as a NUMBER — Babylon emits it as `0` with no
 * container attached, so a test that merely checked the name was present could
 * not tell the two arms apart. Duplicating that here would also mean compiling
 * a second material set in this module, which contaminates both (see the detail
 * spike's own note).
 */

const CANVAS = 256;
let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;
let shaderModules: ShaderRecord[] = [];

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false, enableAllFeatures: false, setMaximumLimits: false,
  });
  await engine.initAsync();
  shaderModules = captureShaderModules(engine, 512);
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

function fixture(index: number): LightPointFixture {
  return {
    position: [index * 3, 2, 0],
    aim: [0, -1, 0],
    intensity: 1_000,
    profileRow: 0,
    radiusMeters: 0.1,
    color: [1, 0.8, 0.5],
  };
}

/** Compiled shader COUNT, which is how a recompilation shows up here. */
const compiled = (): number => shaderModules.length;

describe("7-9: light count does not recompile shaders in flight", () => {
  it("INSTRUMENT — the harness can SEE a recompilation, or nothing below means anything", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("recompile-camera", new Vector3(0, 3, -8), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      new HemisphericLight("recompile-fill", Vector3.Up(), scene);
      const box = CreateBox("recompile-box", { size: 2 }, scene);
      const material = new PBRMaterial("recompile-material", scene);
      box.material = material;
      // `whenReadyAsync` FIRST. Without it Babylon compiles asynchronously,
      // silently skips the not-ready mesh, and NO shader module is created --
      // which is how this very leg first failed, reporting 0 shaders before and
      // after. That failure is the reason this leg exists.
      await scene.whenReadyAsync();
      scene.render();
      const before = compiled();
      expect(before, "no shader compiled at all; the scene never became ready")
        .toBeGreaterThan(0);

      // Adding a LIGHT is define-bearing for a PBR material: Babylon writes
      // POINTLIGHT{N} into the define list, which is part of the effect cache
      // key. This MUST produce new shader modules.
      const extra = new PointLight("recompile-extra", new Vector3(2, 4, 0), scene);
      extra.range = 30;
      await scene.whenReadyAsync();
      scene.render();

      expect(
        compiled(),
        "adding a light produced no new shader module — this harness cannot "
        + "detect a recompilation, so every absence asserted below is vacuous",
      ).toBeGreaterThan(before);
    } finally {
      scene.dispose();
    }
  }, 60_000);

  it("light-point FIXTURE COUNT is not in the shader, so it cannot recompile it", () => {
    // Two systems, two counts, one source. Built in separate scenes so the
    // comparison is of compiled TEXT rather than of cache behaviour.
    const sources: string[] = [];
    for (const count of [4, 128]) {
      const scene = new Scene(engine);
      try {
        const camera = new FreeCamera(`lp-camera-${count}`, new Vector3(0, 5, -20), scene);
        camera.setTarget(Vector3.Zero());
        scene.activeCamera = camera;
        const fixtures = Array.from({ length: count }, (_, i) => fixture(i));
        const system = new LightPointSystem(scene, fixtures, 1);
        system.setOutputSize(CANVAS, CANVAS);
        system.setCameraPosition(camera.position);
        scene.render();
        const lamp = [...shaderModules].reverse()
          .find((r) => r.code.includes("lightOffset"));
        expect(lamp, `no light-point shader compiled at ${count} fixtures`).toBeDefined();
        sources.push(lamp!.code);
        system.dispose();
      } finally {
        scene.dispose();
      }
    }
    // The whole pin, as one comparison: the emitted source is byte-identical
    // across a 32x change in fixture count.
    expect(sources[0]).toBe(sources[1]);
    // Non-vacuity: an empty string would also compare equal.
    expect(sources[0]!.length).toBeGreaterThan(200);
  }, 60_000);

});
