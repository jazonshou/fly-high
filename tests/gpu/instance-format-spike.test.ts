import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";

/**
 * R-20 — the 2-11a instancing premise, proven on-adapter BEFORE the format
 * lands: `forcedInstanceCount` + manually created instanced `VertexBuffer`s
 * (no `thinInstance`, no per-instance matrices) drive one draw of N
 * instances, with quantised attribute formats decoding in the vertex stage:
 *
 *  - snorm16x4 (VertexBuffer.SHORT + normalized) — 2-11a's orientation
 *    quaternion lane. The rotated control instance proves the decode
 *    functionally: a corner-anchored quad flips to the opposite corner of
 *    its quadrant only if the quaternion decodes correctly.
 *  - unorm8x4 (VertexBuffer.UNSIGNED_BYTE + normalized) — the tint lane.
 *    Each instance's readback colour must match its byte tint.
 *
 * THE NAMED FALLBACK (R-20): if this spike ever fails on a supported
 * adapter, `2-11a` ships the 64-byte float32 layout (float3 offset +
 * float4 quaternion + float4 tint + wind lanes) instead of the 32-byte
 * quantised one — the mechanism (forcedInstanceCount + manual buffers)
 * stays, only the formats widen.
 */

const SPIKE_SHADER_NAME = "instanceFormatSpike";

ShaderStore.ShadersStoreWGSL[`${SPIKE_SHADER_NAME}VertexShader`] = /* wgsl */ `
attribute position: vec3f;
attribute instanceOffset: vec3f;
attribute instanceOrientation: vec4f;
attribute instanceTint: vec4f;
varying tint: vec4f;

fn rotateByQuaternion(v: vec3f, q: vec4f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // Direct NDC placement: the spike proves buffer decode + instancing, so
  // no camera matrix stands between the data and the probe arithmetic.
  let local = rotateByQuaternion(vertexInputs.position * 0.9, normalize(vertexInputs.instanceOrientation));
  let world = local.xy + vertexInputs.instanceOffset.xy;
  vertexOutputs.position = vec4f(world * 0.8, 0.5, 1.0);
  vertexOutputs.tint = vertexInputs.instanceTint;
}
`;

ShaderStore.ShadersStoreWGSL[`${SPIKE_SHADER_NAME}PixelShader`] = /* wgsl */ `
varying tint: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4f(input.tint.rgb, 1.0);
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

function snorm16(values: readonly number[]): Int16Array {
  return new Int16Array(values.map((value) => Math.round(value * 32_767)));
}

describe("instance format spike (R-20)", () => {
  it("draws forcedInstanceCount instances from manual snorm16/unorm8 buffers", async () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("spike-camera", new Vector3(0, 0, -3), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;

    // A corner-anchored quad: local [0.05, 0.75]² so a 180° z-rotation moves
    // it to the OPPOSITE corner of its quadrant — the snorm16 decode is
    // observable as geometry, not just colour.
    const quad = new Mesh("spike-quad", scene);
    const vertexData = new VertexData();
    vertexData.positions = new Float32Array([
      0.05, 0.05, 0,
      0.75, 0.05, 0,
      0.75, 0.75, 0,
      0.05, 0.75, 0,
    ]);
    vertexData.indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    vertexData.applyToMesh(quad, false);

    // Four instances. Instance 3 carries the 180° z-rotation quaternion
    // (0, 0, 1, 0): its corner-anchored quad flips through its offset to the
    // mirrored region — decoded geometry, not just colour.
    const offsets = new Float32Array([
      -1.0, -1.0, 0,
      0.25, -1.0, 0,
      0.25, 0.25, 0,
      -0.25, 0.25, 0,
    ]);
    const orientations = snorm16([
      0, 0, 0, 1,
      0, 0, 0, 1,
      0, 0, 0, 1,
      0, 0, 1, 0,
    ]);
    const tints = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255,
    ]);
    quad.setVerticesBuffer(new VertexBuffer(engine, offsets, "instanceOffset", {
      updatable: false,
      instanced: true,
      size: 3,
    }));
    quad.setVerticesBuffer(new VertexBuffer(engine, orientations, "instanceOrientation", {
      updatable: false,
      instanced: true,
      size: 4,
      type: VertexBuffer.SHORT,
      normalized: true,
    }));
    quad.setVerticesBuffer(new VertexBuffer(engine, tints, "instanceTint", {
      updatable: false,
      instanced: true,
      size: 4,
      type: VertexBuffer.UNSIGNED_BYTE,
      normalized: true,
    }));
    quad.forcedInstanceCount = 4;

    const material = new ShaderMaterial("spike-material", scene, SPIKE_SHADER_NAME, {
      attributes: ["position", "instanceOffset", "instanceOrientation", "instanceTint"],
      uniforms: [],
      needAlphaBlending: false,
      shaderLanguage: ShaderLanguage.WGSL,
    });
    material.backFaceCulling = false;
    quad.material = material;

    for (let frame = 0; frame < 12; frame += 1) {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Snapshot synchronously with the last submit; the presented buffer
    // clears once the compositor consumes it (the shell-culling harness's
    // proven readback path).
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    const copy = document.createElement("canvas");
    copy.width = CANVAS_SIZE;
    copy.height = CANVAS_SIZE;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;

    const sample = (xFraction: number, yFraction: number): [number, number, number] => {
      const x = Math.round(xFraction * (CANVAS_SIZE - 1));
      const y = Math.round(yFraction * (CANVAS_SIZE - 1));
      const offset = (y * CANVAS_SIZE + x) * 4;
      return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    };
    const near = (actual: readonly number[], expected: readonly number[]): boolean =>
      actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 8);

    // Identity instances (NDC ×0.8; screen y = (1 − ndc.y)/2): A spans
    // screen x [0.118, 0.37] × y [0.63, 0.882]; B and C mirror it.
    expect(near(sample(0.25, 0.75), [255, 0, 0]), "red instance").toBe(true);
    expect(near(sample(0.75, 0.75), [0, 255, 0]), "green instance").toBe(true);
    expect(near(sample(0.75, 0.25), [0, 0, 255]), "blue instance").toBe(true);
    // The rotated instance lands at screen x [0.13, 0.382] × y [0.418, 0.67];
    // where its identity placement would have been (x [0.418, 0.67] ×
    // y [0.11, 0.362]) stays background.
    expect(near(sample(0.25, 0.55), [255, 255, 0]), "rotated quad landed mirrored").toBe(true);
    expect(near(sample(0.5, 0.25), [0, 0, 0]), "identity position vacated").toBe(true);

    scene.dispose();
  }, 60_000);
});
