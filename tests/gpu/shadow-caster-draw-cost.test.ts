import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";

/**
 * **What one mesh costs in draw calls, measured rather than derived.**
 *
 * **This file used to pin 2.00 and it was pinning a defect.** `7-9`'s
 * decomposition found that a shadow-casting mesh cost 2.00 draws at a tier
 * declaring two cascades, two features agreed on it, and the number went into
 * four draw-call raise entries. The docblock recorded honestly that the source
 * reads `1 + shadowCascades` and said the constant was empirical "until that
 * mechanism is found".
 *
 * **The mechanism was found on 2026-09-01 and it was our own code.**
 * `DepthOnlyCascadedShadowGenerator` drops the shadow map's colour attachment
 * to reclaim memory. `RenderTargetTexture.render` loops one render per cascade
 * only when `is2DArray` is true, and `is2DArray` reads the **colour** texture —
 * while cascade depth lives in the **depth** texture. The gate asked about the
 * wrong texture, so the generator rendered cascade 0 and nothing else:
 * `cascadesRendered` measured **1 at every `numCascades` from 1 to 4**, leaving
 * 88-94% of each tier's shadow range served by array layers no pass ever wrote.
 * **The "missing per-cascade culling" this file hypothesised did not exist.**
 *
 * **So the pin is inverted.** It now asserts `1 + numCascades`, which is what
 * the source always said, and the assertion messages point at the gate rather
 * than at a culling mechanism nobody could find. **A test that pins an
 * unexplained constant will hold a defect in place**, which is exactly what
 * this one did for as long as it existed.
 *
 * Measured off Babylon's own `_drawCalls` counter — the same counter
 * `FlightRenderer` reports and the capture harness pins.
 */

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;

beforeAll(async () => {
  canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  document.body.appendChild(canvas);
  engine = new WebGPUEngine(canvas, {
    antialias: false, enableAllFeatures: false, setMaximumLimits: false,
  });
  await engine.initAsync();
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

/** One settled frame's draw count, read from the counter production reports. */
async function drawCallsAfterRender(scene: Scene): Promise<number> {
  const counter = (engine as unknown as { _drawCalls: { fetchNewFrame(): void; current: number } })
    ._drawCalls;
  await scene.whenReadyAsync();
  // Two frames: the first can carry compilation-driven submissions.
  scene.render();
  counter.fetchNewFrame();
  scene.render();
  return Math.round(counter.current);
}

describe("7-CSM: what a mesh costs, and what a CASTING mesh costs", () => {
  it("MEASURED — a casting mesh costs 1 + numCascades, one render per cascade", async () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    // The tier the capture harness runs at, and the one both features measured on.
    expect(profile.tier).toBe(1);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("cost-camera", new Vector3(0, 12, -40), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      const sun = new DirectionalLight("cost-sun", new Vector3(-0.4, -0.8, 0.3).normalize(), scene);
      sun.intensity = 2;
      new HemisphericLight("cost-fill", Vector3.Up(), scene);
      const shadows = new DepthOnlyCascadedShadowGenerator(512, sun, false, camera, true);
      shadows.numCascades = profile.shadowCascades;

      // Babylon clamps `numCascades` to MIN_CASCADES_COUNT = 2 SILENTLY, so read
      // the effective value off the generator rather than trusting the profile.
      const cascades = shadows.numCascades;
      expect(cascades, "the profile's cascade count was clamped by the setter").toBe(
        profile.shadowCascades,
      );

      const empty = await drawCallsAfterRender(scene);

      const COUNT = 4;
      const plain: Mesh[] = [];
      for (let i = 0; i < COUNT; i += 1) {
        const box = CreateBox(`cost-plain-${i}`, { size: 3 }, scene);
        box.position.set((i - COUNT / 2) * 6, 1.5, 0);
        box.material = new PBRMaterial(`cost-plain-mat-${i}`, scene);
        plain.push(box);
      }
      const withMeshes = await drawCallsAfterRender(scene);
      const beautyPerMesh = (withMeshes - empty) / COUNT;

      // NON-VACUITY: the counter must see plain meshes at all. If this is 0 the
      // measurement below is meaningless and would read as "casting is free".
      expect(beautyPerMesh, "the draw counter did not register plain meshes").toBe(1);

      for (const box of plain) shadows.addShadowCaster(box, false);
      const withCasters = await drawCallsAfterRender(scene);
      const totalPerMesh = (withCasters - empty) / COUNT;
      const cascadesRendered = totalPerMesh - beautyPerMesh;

      console.log(`[mesh-cost] beauty=${beautyPerMesh} cascadesRendered=${cascadesRendered} `
        + `total=${totalPerMesh} (generator numCascades=${cascades})`);

      // THE PIN, AND THE REGRESSION GUARD. If this drops back to 1, the
      // per-layer loop has been re-gated on the colour attachment — see
      // `DepthOnlyCascadedShadowGenerator`. Shadows beyond cascade 0's split
      // would silently vanish, which is invisible to every other test we have.
      expect(
        cascadesRendered,
        `${cascadesRendered} of ${cascades} cascades rendered. At 1, the shadow map's `
        + "per-layer loop is gated on `is2DArray`, which reads the COLOUR texture this "
        + "generator deliberately does not allocate — the 2026-09-01 defect.",
      ).toBe(cascades);

      expect(
        totalPerMesh,
        `a casting mesh measured ${totalPerMesh} draws, expected ${1 + cascades}. `
        + "Every draw-call raise entry is derived from this constant.",
      ).toBe(1 + cascades);
    } finally {
      scene.dispose();
    }
  }, 120_000);
});
