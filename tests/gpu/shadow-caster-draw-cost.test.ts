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
 * `7-9`'s draw-call decomposition produced a constant that two independent
 * features agreed on — hangars and airfield furniture, opposite construction,
 * measured by two people: **a shadow-casting mesh costs 2.00 draws, not 3.**
 * One beauty draw plus **exactly one** shadow cascade, at a tier whose profile
 * declares `shadowCascades: 2`.
 *
 * **That constant contradicts the obvious source reading and is the reason this
 * file exists.** Reading `objectRenderer.js`'s shadow render list shows filters
 * for `isReady`, LOD, `isEnabled`, `isVisible`, sub-meshes and layer mask — and
 * **no per-cascade distance or frustum test** — from which 1 + `shadowCascades`
 * follows. Measurement says otherwise, so something culls casters per cascade
 * that the render-list code does not show. **Until that mechanism is found, the
 * number is empirical, and an empirical number with no home becomes folklore
 * inside a week.**
 *
 * Measured here directly off Babylon's own `_drawCalls` counter — the same
 * counter `FlightRenderer` reports and the capture harness pins — rather than
 * inferred from a capture difference, so it needs no worktree and no host slot.
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

describe("7-9: what a mesh costs, and what a CASTING mesh costs", () => {
  it("MEASURED — a casting mesh costs 2 draws, not 1 + shadowCascades", async () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    // The tier the capture harness runs at, and the one both features measured on.
    expect(profile.tier).toBe(1);
    expect(profile.shadowCascades).toBe(2);

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
      const cascadesTaken = totalPerMesh - beautyPerMesh;

      // eslint-disable-next-line no-console
      console.log(`[mesh-cost] beauty=${beautyPerMesh} cascadesTaken=${cascadesTaken} `
        + `total=${totalPerMesh} (profile declares shadowCascades=${profile.shadowCascades})`);

      // THE PIN. Two capture-side decompositions measured 2.00; this measures the
      // same constant off the counter directly.
      expect(
        totalPerMesh,
        `a casting mesh measured ${totalPerMesh} draws. Both 7-9 decompositions found 2.00 — `
        + "if this has moved, every draw-call raise entry derived from that constant needs re-deriving.",
      ).toBe(2);

      // And state the discrepancy the constant encodes, so it cannot be quietly
      // "corrected" to match the profile by someone reading only the source.
      expect(
        cascadesTaken,
        `casters reached ${cascadesTaken} cascade(s) of the ${profile.shadowCascades} this tier `
        + "declares. If these are now equal, the per-cascade culling that made them differ is gone.",
      ).toBeLessThan(profile.shadowCascades);
    } finally {
      scene.dispose();
    }
  }, 120_000);
});
