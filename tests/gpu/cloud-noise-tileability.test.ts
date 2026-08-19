import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { CLOUD_NOISE_WGSL } from "../../src/render/webgpu/clouds/CloudVolumeBake";

/**
 * Assertion 37 (2-1): the bake's noise primitives are bit-exactly tileable —
 * every value at `u + 1` equals the value at `u`, because every lattice cell
 * index is wrapped modulo the octave frequency before hashing. A volume that
 * does not tile produces a visible seam every repeat of world space.
 */

const SAMPLE_COUNT = 4_096;

const TILE_CHECK_WGSL = /* wgsl */ `
${CLOUD_NOISE_WGSL}

@group(0) @binding(0) var<storage, read_write> results: array<vec2<f32>>;

@compute @workgroup_size(64, 1, 1)
fn checkTiling(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&results)) {
    return;
  }
  let h = cloudBakeHash3(vec3<i32>(i32(id.x), 17, 91), 5u);
  // Quantize to a 1/256 grid so p, p + 1 and every octave product are exact
  // f32 values: the check must exercise the LATTICE WRAP, not accumulate
  // rounding of unrepresentable offsets.
  let p = floor(vec3<f32>(
    cloudBakeUnitFloat(h),
    cloudBakeUnitFloat(h * 1664525u + 1013904223u),
    cloudBakeUnitFloat(h * 22695477u + 1u),
  ) * 256.0) / 256.0;
  let q = p + vec3<f32>(1.0, 1.0, 1.0);
  let a = periodicPerlinFbm(p, 4, 31u)
    + periodicWorley(p * 8.0, 8, 53u)
    + periodicPerlin(p * 16.0, 16, 59u);
  let b = periodicPerlinFbm(q, 4, 31u)
    + periodicWorley(q * 8.0, 8, 53u)
    + periodicPerlin(q * 16.0, 16, 59u);
  results[id.x] = vec2<f32>(a, b);
}
`;

describe("cloud noise tileability (assertion 37)", () => {
  it("samples bit-identically at u and u + 1 for 4,096 coordinates", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    try {
      await engine.initAsync();
      const buffer = new StorageBuffer(engine, SAMPLE_COUNT * 2 * 4);
      const shader = new ComputeShader(
        "cloud-noise-tile-check",
        engine,
        { computeSource: TILE_CHECK_WGSL },
        {
          entryPoint: "checkTiling",
          bindingsMapping: { results: { group: 0, binding: 0 } },
        },
      );
      shader.setStorageBuffer("results", buffer);
      // Compute submissions and buffer readbacks resolve at frame boundaries,
      // so drive an empty render loop while awaiting them.
      engine.runRenderLoop(() => {});
      await shader.dispatchWhenReady(SAMPLE_COUNT / 64, 1, 1);
      const bytes = await buffer.read();
      engine.stopRenderLoop();
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, SAMPLE_COUNT * 2);
      let mismatches = 0;
      let nonTrivial = 0;
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const a = values[index * 2]!;
        const b = values[index * 2 + 1]!;
        if (a !== b) mismatches += 1;
        if (a !== 0) nonTrivial += 1;
      }
      expect(mismatches, "noise must tile bit-exactly at u and u + 1").toBe(0);
      // Guard against a vacuous pass (all zeros = kernel did not run).
      expect(nonTrivial).toBeGreaterThan(SAMPLE_COUNT * 0.9);
      buffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
});
