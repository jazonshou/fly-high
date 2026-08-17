import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Side-effect import: tree-shaken Babylon needs the shadow scene component
// registered before shadow maps render.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CloudShadowMaterialPlugin } from "../../src/render/webgpu/clouds/CloudShadowMaterialPlugin";

/**
 * 0-9 — the vertex-plugin + ShadowDepthWrapper premise spike, automated.
 *
 * The premise under test underpins §1.1's "after" column and the refusal to
 * migrate engines: terrain height will be read in the PBR *vertex* shader
 * through a MaterialPluginBase, and shadows must follow, because Babylon's
 * shadow generators build their own depth effects and do not consult material
 * plugins unless a ShadowDepthWrapper re-derives the depth pass from the
 * material's own shader. If the wrapper did not compose with plugin vertex
 * displacement, terrain would become a dedicated ShaderMaterial and Phases 3
 * and 4 would be re-planned.
 *
 * VALIDATED INCANTATION (also recorded in ARCHITECTURE.md's decision log):
 *   1. Attach every vertex-participating plugin to the PBRMaterial.
 *   2. `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene)`
 *      BEFORE the material's first effect compiles. The wrapper learns about
 *      base-material effects only through onEffectCreatedObservable; attached
 *      to an already-rendering material it silently falls back to the
 *      undisplaced default depth pass.
 *   3. No remappedVariables are needed for PBRMaterial-with-plugins in WGSL.
 * Harness note: manual scene.render() calls on WebGPU must be wrapped in
 * engine.beginFrame()/endFrame() or no work is ever submitted.
 */

const WGSL_VERTEX_CODE = Object.freeze({
  CUSTOM_VERTEX_UPDATE_POSITION: `
positionUpdated.x += uniforms.spikeOffsetX;
`,
});

const GLSL_VERTEX_CODE = Object.freeze({
  CUSTOM_VERTEX_UPDATE_POSITION: `
positionUpdated.x += spikeOffsetX;
`,
});

/** Minimal stand-in for the Phase 4 height-displacement plugin. */
class SpikeDisplaceMaterialPlugin extends MaterialPluginBase {
  private offsetX = 0;

  constructor(material: PBRMaterial) {
    super(material, "spike-displace", 100, undefined, true, true);
    this.doNotSerialize = true;
  }

  override getClassName(): string {
    return "SpikeDisplaceMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setOffsetX(value: number): void {
    this.offsetX = value;
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return { ubo: [{ name: "spikeOffsetX", size: 1, type: "float" }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("spikeOffsetX", this.offsetX);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderType !== "vertex") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? WGSL_VERTEX_CODE : GLSL_VERTEX_CODE;
  }
}

const CANVAS_SIZE = 256;
const ORTHO_HALF_EXTENT = 80;
const DISPLACEMENT_METERS = 25;
/** Canvas pixels of shadow travel a 25 m displacement should produce. */
const EXPECTED_TRAVEL_PIXELS =
  (DISPLACEMENT_METERS / (2 * ORTHO_HALF_EXTENT)) * CANVAS_SIZE;

interface SpikeRig {
  scene: Scene;
  plugin: SpikeDisplaceMaterialPlugin;
  dispose(): void;
}

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

function buildRig(configureMaterial: (material: PBRMaterial, scene: Scene) => void): SpikeRig {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);

  const camera = new FreeCamera("spike-camera", new Vector3(0, 90, 0), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -ORTHO_HALF_EXTENT;
  camera.orthoRight = ORTHO_HALF_EXTENT;
  camera.orthoTop = ORTHO_HALF_EXTENT;
  camera.orthoBottom = -ORTHO_HALF_EXTENT;
  camera.setTarget(new Vector3(0, 0, 0.01));
  scene.activeCamera = camera;

  // Angled sun so the box's shadow lands beside its own footprint and stays
  // visible to the top-down camera.
  const light = new DirectionalLight(
    "spike-sun",
    new Vector3(0.45, -1, 0.2).normalize(),
    scene,
  );
  light.position = new Vector3(0, 70, 0);
  light.intensity = 1.4;
  light.autoUpdateExtends = false;
  light.shadowFrustumSize = 200;
  light.shadowMinZ = 1;
  light.shadowMaxZ = 200;

  const ground = CreateGround("spike-ground", { width: 160, height: 160 }, scene);
  const groundMaterial = new StandardMaterial("spike-ground-material", scene);
  groundMaterial.diffuseColor = new Color3(0.75, 0.75, 0.75);
  groundMaterial.specularColor = new Color3(0, 0, 0);
  ground.material = groundMaterial;
  ground.receiveShadows = true;

  const box = CreateBox("spike-box", { size: 10 }, scene);
  box.position.y = 20;
  const material = new PBRMaterial("spike-box-material", scene);
  material.roughness = 1;
  material.metallic = 0;
  material.emissiveColor = new Color3(1, 1, 1);
  box.material = material;
  const plugin = new SpikeDisplaceMaterialPlugin(material);
  configureMaterial(material, scene);

  const generator = new ShadowGenerator(1024, light);
  generator.addShadowCaster(box);

  return { scene, plugin, dispose: () => scene.dispose() };
}

async function renderFrames(rig: SpikeRig, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    engine.beginFrame();
    rig.scene.render();
    engine.endFrame();
    // Yield so GPU work and Babylon's async effect compilation can progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Centroids {
  shadow: { x: number; y: number; count: number };
  box: { x: number; y: number; count: number };
}

/** Centroids of the received-shadow (dark) and box (bright) canvas regions. */
function readCentroids(rig: SpikeRig): Centroids {
  // Render and copy in one synchronous task: the presented WebGPU canvas
  // buffer is cleared once the compositor consumes the frame, so drawImage
  // must happen before this task yields.
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
  // The lit ground dominates the frame, so the median IS the lit level.
  expect(median).toBeGreaterThan(0.2);

  const accumulate = (predicate: (value: number) => boolean) => {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = 0; y < CANVAS_SIZE; y += 1) {
      for (let x = 0; x < CANVAS_SIZE; x += 1) {
        const value = brightness[y * CANVAS_SIZE + x] ?? 0;
        if (predicate(value)) {
          sumX += x;
          sumY += y;
          count += 1;
        }
      }
    }
    return { x: count ? sumX / count : -1, y: count ? sumY / count : -1, count };
  };
  return {
    // The ground exactly fills the ortho frame, so everything clearly darker
    // than the lit ground is received shadow (with no scene ambient, fully
    // shadowed texels read 0).
    shadow: accumulate((value) => value < median * 0.6),
    box: accumulate((value) => value > 0.97),
  };
}

describe("vertex-plugin + ShadowDepthWrapper premise (0-9)", () => {
  it("confirms plugin displacement moves the mesh but not its default shadow", async () => {
    const rig = buildRig(() => {
      // No wrapper: the generator uses its own depth effect.
    });
    try {
      await renderFrames(rig, 20);
      const baseline = readCentroids(rig);
      expect(baseline.shadow.count).toBeGreaterThan(50);
      expect(baseline.box.count).toBeGreaterThan(50);

      rig.plugin.setOffsetX(DISPLACEMENT_METERS);
      await renderFrames(rig, 10);
      const displaced = readCentroids(rig);

      // Spike step 1: the mesh itself moves — the plugin's vertex stage runs.
      const boxTravel = displaced.box.x - baseline.box.x;
      expect(boxTravel).toBeGreaterThan(EXPECTED_TRAVEL_PIXELS * 0.6);

      // Spike step 2: its shadow does not. The generator builds its own depth
      // effect and never consults the material's plugin chain. This is the
      // fatal-if-unaddressed half of the premise.
      const shadowDrift = Math.hypot(
        displaced.shadow.x - baseline.shadow.x,
        displaced.shadow.y - baseline.shadow.y,
      );
      expect(shadowDrift).toBeLessThan(EXPECTED_TRAVEL_PIXELS * 0.15);
    } finally {
      rig.dispose();
    }
  });

  it("makes the shadow follow displacement through ShadowDepthWrapper, composed with the cloud-shadow plugin", async () => {
    const rig = buildRig((material, scene) => {
      // Spike step 4's composition: the same material carries the cloud-shadow
      // receiver plugin (as the terrain material does), so the wrapper must
      // re-derive a depth pass from a shader with BOTH plugins present.
      new CloudShadowMaterialPlugin(material);
      // Spike step 3 — the working incantation: create the wrapper before the
      // material's first effect compiles (see the module doc comment).
      material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene);
    });
    try {
      await renderFrames(rig, 20);
      const baseline = readCentroids(rig);
      expect(baseline.shadow.count).toBeGreaterThan(50);

      rig.plugin.setOffsetX(DISPLACEMENT_METERS);
      await renderFrames(rig, 10);
      const displaced = readCentroids(rig);

      const shadowTravel = displaced.shadow.x - baseline.shadow.x;
      expect(shadowTravel).toBeGreaterThan(EXPECTED_TRAVEL_PIXELS * 0.6);
      expect(shadowTravel).toBeLessThan(EXPECTED_TRAVEL_PIXELS * 1.4);
    } finally {
      rig.dispose();
    }
  });
});
