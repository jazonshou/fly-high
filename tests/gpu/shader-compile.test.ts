import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
// Side-effect imports: register the compute pipeline methods on WebGPUEngine.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

/**
 * 0-8 exit criterion: `npm run test:gpu` acquires a WebGPU adapter and
 * compiles a WGSL compute shader through Babylon's ComputeShader — the same
 * path every Phase 4 generation/erosion kernel and parity test will use.
 */

const DOUBLER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(16, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&data)) {
    data[id.x] = data[id.x] * 2.0 + 1.0;
  }
}
`;

describe("WebGPU test harness (0-8)", () => {
  it("acquires a real adapter", async () => {
    expect(navigator.gpu).toBeDefined();
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
  });

  it("compiles and dispatches a WGSL compute shader through Babylon", async () => {
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

      const elementCount = 64;
      const input = new Float32Array(elementCount);
      for (let index = 0; index < elementCount; index += 1) input[index] = index;

      const buffer = new StorageBuffer(engine, input.byteLength);
      buffer.update(input);

      const shader = new ComputeShader(
        "gpu-harness-doubler",
        engine,
        { computeSource: DOUBLER_WGSL },
        { bindingsMapping: { data: { group: 0, binding: 0 } } },
      );
      shader.setStorageBuffer("data", buffer);

      // Compute submissions and buffer readbacks resolve at frame boundaries,
      // so drive an empty render loop while awaiting them.
      engine.runRenderLoop(() => {});
      await shader.dispatchWhenReady(elementCount / 16, 1, 1);
      expect(shader.isReady()).toBe(true);

      const view = await buffer.read();
      engine.stopRenderLoop();
      const result = new Float32Array(view.buffer, view.byteOffset, elementCount);
      for (let index = 0; index < elementCount; index += 1) {
        expect(result[index]).toBe(index * 2 + 1);
      }
      buffer.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
});
