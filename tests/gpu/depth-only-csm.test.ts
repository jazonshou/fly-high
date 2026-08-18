import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Side-effect import: tree-shaken Babylon needs the shadow scene component
// registered before shadow maps render.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Scene } from "@babylonjs/core/scene";
import { DepthOnlyCascadedShadowGenerator } from "../../src/render/webgpu/atmosphere/AtmosphereSystem";

/**
 * 1A-5 — the depth-only cascaded shadow map, validated on a real adapter.
 *
 * The override removes the CSM render target's colour attachment entirely
 * (PCF binds only the depth texture and Babylon disables colour writes during
 * the pass). This must not change what lands on screen: the cascades render,
 * PCF samples the depth texture, and a caster still darkens the ground.
 */

const CANVAS_SIZE = 256;

let engine: WebGPUEngine;
let canvas: HTMLCanvasElement;

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
}, 60_000);

afterAll(() => {
  engine?.dispose();
  canvas?.remove();
});

async function renderFrames(scene: Scene, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Fraction of clearly darker-than-median pixels; render+copy stay in one task. */
function shadowedFraction(scene: Scene): number {
  engine.beginFrame();
  scene.render();
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
  let shadowed = 0;
  for (const value of brightness) {
    if (value < median * 0.6) shadowed += 1;
  }
  return shadowed / brightness.length;
}

describe("depth-only cascaded shadow map (1A-5)", () => {
  it("renders received shadows with no colour attachment allocated", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    try {
      const camera = new FreeCamera("csm-camera", new Vector3(0, 60, -60), scene);
      camera.minZ = 1;
      camera.maxZ = 400;
      camera.setTarget(new Vector3(0, 0, 0));
      scene.activeCamera = camera;

      const light = new DirectionalLight(
        "csm-sun",
        new Vector3(0.45, -1, 0.2).normalize(),
        scene,
      );
      light.intensity = 1.4;
      light.autoCalcShadowZBounds = false;

      const ground = CreateGround("csm-ground", { width: 220, height: 220 }, scene);
      const groundMaterial = new StandardMaterial("csm-ground-material", scene);
      groundMaterial.diffuseColor = new Color3(0.75, 0.75, 0.75);
      groundMaterial.specularColor = new Color3(0, 0, 0);
      ground.material = groundMaterial;
      ground.receiveShadows = true;

      const box = CreateBox("csm-box", { size: 14 }, scene);
      box.position.y = 18;
      const boxMaterial = new StandardMaterial("csm-box-material", scene);
      boxMaterial.emissiveColor = new Color3(1, 1, 1);
      box.material = boxMaterial;

      const generator = new DepthOnlyCascadedShadowGenerator(1024, light, false, camera, true);
      generator.numCascades = 2;
      generator.stabilizeCascades = true;
      generator.shadowMaxZ = 300;
      generator.filter = ShadowGenerator.FILTER_PCF;
      generator.addShadowCaster(box);

      // Structural half of the assertion: depth texture present, colour absent.
      const shadowMap = generator.getShadowMap();
      expect(shadowMap).not.toBeNull();
      expect(shadowMap!.depthStencilTexture).not.toBeNull();
      expect(shadowMap!.renderTarget?.texture ?? null).toBeNull();

      // Behavioural half: the ground actually receives a shadow.
      await renderFrames(scene, 20);
      expect(shadowedFraction(scene)).toBeGreaterThan(0.005);
    } finally {
      scene.dispose();
    }
  });
});
