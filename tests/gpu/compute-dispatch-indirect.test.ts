// Side-effect import: registers the compute pipeline methods.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { describe, expect, it } from "vitest";
import { nextFrame } from "./terrainPageErosionGpuHarness";

/**
 * Babylon's indirect compute dispatch, proven on the device before the breach
 * carve relies on it (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md). This
 * Babylon build has hidden traps of this shape before (a DynamicTexture that
 * could not work here, a recorded mip blit overwriting uploaded mips), so the
 * path is shown end to end: a compute pass writes the size into a buffer
 * created READWRITE | INDIRECT, the same way the breach args pass does, and a
 * counting shader dispatched from that buffer runs exactly that many
 * workgroups. The control: a different written size runs a different number,
 * so the dispatch reads the buffer rather than a fixed size.
 */

const ARGS_FLAGS = 3 | 64; // BUFFER_CREATIONFLAG_READWRITE | BUFFER_CREATIONFLAG_INDIRECT

async function workgroupsRun(engine: WebGPUEngine, size: number): Promise<number> {
  const args = new StorageBuffer(engine, 16, ARGS_FLAGS, "indirectSmokeArgs");
  const counter = new StorageBuffer(engine, 4, undefined, "indirectSmokeCounter");
  const request = new StorageBuffer(engine, 4, undefined, "indirectSmokeRequest");
  try {
    request.update(new Uint32Array([size]));
    counter.update(new Uint32Array([0]));
    const writer = new ComputeShader("indirect-smoke-writer", engine, {
      computeSource: `
@group(0) @binding(0) var<storage, read> request: array<u32, 1>;
@group(0) @binding(1) var<storage, read_write> args: array<u32, 4>;
@compute @workgroup_size(1, 1, 1)
fn main() {
  args[0] = request[0];
  args[1] = 1u;
  args[2] = 1u;
}`,
    }, { bindingsMapping: { request: { group: 0, binding: 0 }, args: { group: 0, binding: 1 } } });
    writer.setStorageBuffer("request", request);
    writer.setStorageBuffer("args", args);
    const counting = new ComputeShader("indirect-smoke-counter", engine, {
      computeSource: `
@group(0) @binding(0) var<storage, read_write> counter: array<atomic<u32>, 1>;
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(local_invocation_index) lane: u32) {
  if (lane == 0u) { atomicAdd(&counter[0], 1u); }
}`,
    }, { bindingsMapping: { counter: { group: 0, binding: 0 } } });
    counting.setStorageBuffer("counter", counter);
    await writer.dispatchWhenReady(1, 1, 1);
    for (let attempt = 0; attempt < 200 && !counting.dispatchIndirect(args); attempt += 1) await nextFrame();
    for (let frame = 0; frame < 4; frame += 1) await nextFrame();
    const view = await counter.read(0, 4, undefined, true);
    return new Uint32Array(view.buffer.slice(view.byteOffset, view.byteOffset + 4))[0]!;
  } finally {
    args.dispose();
    counter.dispose();
    request.dispose();
  }
}

describe("indirect compute dispatch on the device", () => {
  it("runs exactly the workgroups a compute pass wrote, and a different size runs a different number", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: false, setMaximumLimits: false });
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      const sizes = [37, 40, 0, 712];
      const ran: number[] = [];
      for (const size of sizes) ran.push(await workgroupsRun(engine, size));
      console.log(`indirect dispatch: wrote ${sizes.join(", ")} -> ran ${ran.join(", ")}`);
      expect(ran).toEqual(sizes);
    } finally {
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
