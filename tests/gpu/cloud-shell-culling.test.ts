import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import { Scene } from "@babylonjs/core/scene";

/**
 * 1A-4 step 3 (fix-double-blend), measured instead of assumed.
 *
 * The cloud composite is a camera-centered BACKSIDE sphere with premultiplied
 * blending and no back-face culling, drawn into an offscreen target (the
 * post-process chain forces one, and WebGPU render targets invert frontFace).
 * Two questions decide the production change:
 *
 *  1. Does the uncculled shell actually blend twice per pixel? A premultiplied
 *     (0.5, 0, 0, 0.5) shell reads as 0.5-red if it rasterises once and
 *     0.75-red if twice. The alpha-1 control shell measures the encoding of
 *     0.5 without blend sensitivity, so the comparison is gamma-proof.
 *  2. Which culling configuration keeps the shell visible in the offscreen
 *     pass? Babylon's yFactor geometry flip reverses winding in render
 *     targets and its frontFace inversion compensates, so BACKSIDE +
 *     backFaceCulling=true should stay visible — this test pins that.
 */

const SHELL_SHADER_NAME = "cloudShellCullSpike";

ShaderStore.ShadersStoreWGSL[`${SHELL_SHADER_NAME}VertexShader`] = /* wgsl */ `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;

ShaderStore.ShadersStoreWGSL[`${SHELL_SHADER_NAME}PixelShader`] = /* wgsl */ `
uniform shellColor: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = uniforms.shellColor;
}
`;

const CANVAS_SIZE = 128;

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

interface ShellCase {
  readonly sideOrientation: number;
  readonly backFaceCulling: boolean;
  readonly shellColor: readonly [number, number, number, number];
}

/** Renders one shell configuration and returns the mean canvas red in [0, 1]. */
async function measureShell(config: ShellCase): Promise<number> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("shell-camera", new Vector3(0, 0, 0), scene);
  camera.minZ = 0.1;
  camera.maxZ = 1_000;
  camera.setTarget(new Vector3(0, 0, 1));
  scene.activeCamera = camera;

  // Mirror the production composite's environment: a post-process forces the
  // beauty pass into an offscreen target, which is where WebGPU's frontFace
  // inversion applies.
  const pass = new PassPostProcess("shell-pass", 1, camera);

  const shell = CreateSphere("shell", {
    diameter: 100,
    segments: 24,
    sideOrientation: config.sideOrientation,
  }, scene);
  shell.position.copyFrom(camera.position);

  const material = new ShaderMaterial("shell-material", scene, SHELL_SHADER_NAME, {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "shellColor"],
    needAlphaBlending: true,
    shaderLanguage: ShaderLanguage.WGSL,
  });
  // The composite's exact blend state (configurePremultipliedMaterial), with
  // the culling mode under test.
  material.backFaceCulling = config.backFaceCulling;
  material.disableDepthWrite = true;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
  material.setVector4(
    "shellColor",
    {
      x: config.shellColor[0],
      y: config.shellColor[1],
      z: config.shellColor[2],
      w: config.shellColor[3],
      // ShaderMaterial.setVector4 only reads x/y/z/w.
    } as never,
  );
  shell.material = material;

  for (let frame = 0; frame < 15; frame += 1) {
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Snapshot synchronously with the last submit; the presented buffer clears
  // once the compositor consumes it.
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  const copy = document.createElement("canvas");
  copy.width = CANVAS_SIZE;
  copy.height = CANVAS_SIZE;
  const context = copy.getContext("2d")!;
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
  let sum = 0;
  for (let index = 0; index < CANVAS_SIZE * CANVAS_SIZE; index += 1) {
    sum += (image[index * 4] ?? 0) / 255;
  }

  pass.dispose(camera);
  scene.dispose();
  return sum / (CANVAS_SIZE * CANVAS_SIZE);
}

describe("cloud composite shell culling (1A-4 step 3)", () => {
  it("rasterises the camera-centered shell exactly once per pixel, cull on or off", async () => {
    // Alpha-1 control: premultiplied blending with alpha 1 is idempotent, so
    // this measures the display encoding of 0.5-red independent of blend
    // multiplicity.
    const control = await measureShell({
      sideOrientation: Mesh.BACKSIDE,
      backFaceCulling: false,
      shellColor: [0.5, 0, 0, 1],
    });
    expect(control).toBeGreaterThan(0.3);

    // The composite's actual state: alpha 0.5, no culling. Equal to the
    // control means one blend per pixel; ~1.5× the control would mean the
    // double blend the plan hypothesised.
    const unculled = await measureShell({
      sideOrientation: Mesh.BACKSIDE,
      backFaceCulling: false,
      shellColor: [0.5, 0, 0, 0.5],
    });
    expect(Math.abs(unculled - control)).toBeLessThan(0.03);

    // With culling enabled the picture must not change.
    const culled = await measureShell({
      sideOrientation: Mesh.BACKSIDE,
      backFaceCulling: true,
      shellColor: [0.5, 0, 0, 0.5],
    });
    expect(Math.abs(culled - control)).toBeLessThan(0.03);
  });

  it("keeps a culled BACKSIDE shell visible in the offscreen pass, and can detect culling", async () => {
    // The production configuration under 1A-4: BACKSIDE + culling on stays
    // fully visible (yFactor's winding flip and the frontFace inversion
    // cancel).
    const visible = await measureShell({
      sideOrientation: Mesh.BACKSIDE,
      backFaceCulling: true,
      shellColor: [1, 0, 0, 1],
    });
    expect(visible).toBeGreaterThan(0.6);

    // Control that the probe can see culling at all: FRONTSIDE + culling on
    // shows the shell's back faces from inside, which are culled away.
    const culledAway = await measureShell({
      sideOrientation: Mesh.FRONTSIDE,
      backFaceCulling: true,
      shellColor: [1, 0, 0, 1],
    });
    expect(culledAway).toBeLessThan(0.05);
  });
});
