import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import {
  REQUIRED_WEBGPU_LIMITS,
  findWebGpuLimitShortfalls,
  inspectWebGpuCapabilities,
} from "../../src/render/webgpu/core/Capabilities";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";

/**
 * Precondition P2, landed as a committed test rather than trusted from a
 * throwaway probe: the reference machine's ADAPTER is generous
 * (`maxTextureDimension2D` 16384, `float32-filterable` present) and the DEVICE
 * is not — `setMaximumLimits: false` means it runs at WebGPU spec defaults. So
 * every machine re-checks the limits Phase 4's atlases actually need, and the
 * one Babylon-level behaviour `R-4B` flags is verified here rather than
 * assumed: an r32float texture that is written by compute and read back in the
 * same frame.
 */
describe("WebGPU limits and r32float storage round-trip (P2)", () => {
  it("meets every limit the renderer declares, and reports what the adapter offers", async () => {
    const report = await inspectWebGpuCapabilities();
    expect(report.supported, report.reason ?? "").toBe(true);
    // The check must not be able to pass vacuously: an empty limit map means
    // nothing was compared. `GPUSupportedLimits` keeps its limits on the
    // prototype, so `Object.entries` on it returns nothing — which is exactly
    // how this went unnoticed until the probe printed `undefined` for all ten.
    for (const limit of Object.keys(REQUIRED_WEBGPU_LIMITS)) {
      expect(typeof report.limits[limit], limit).toBe("number");
    }
    expect(findWebGpuLimitShortfalls(report.limits)).toEqual([]);
    console.log(
      "adapter limits: "
      + Object.keys(REQUIRED_WEBGPU_LIMITS)
        .map((limit) => `${limit}=${report.limits[limit]}`)
        .join(", ")
      + `; float32-filterable=${report.features.has("float32-filterable")}`,
    );
    // The Ultra height atlas is 4224²; the DEVICE's default is 8192.
    expect(16 * TERRAIN_HEIGHT_SLOT_EDGE).toBeLessThanOrEqual(8_192);
  }, 60_000);

  it("writes an r32float storage texture by compute and reads it back exactly", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const engine = new WebGPUEngine(canvas, {
      antialias: false,
      enableAllFeatures: false,
      setMaximumLimits: false,
    });
    let scene: Scene | null = null;
    try {
      await engine.initAsync();
      engine.runRenderLoop(() => {});
      scene = new Scene(engine);
      const edge = 32;
      const texture = RawTexture.CreateRStorageTexture(
        null, edge, edge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      // A separate, pre-filled r32float texture for the sampled-binding half:
      // reading the texture a dispatch is also writing would be a data race,
      // and this probe is about the BINDING, not about ordering.
      const seeded = new Float32Array(edge * edge);
      for (let index = 0; index < seeded.length; index += 1) seeded[index] = index * 0.5 - 7;
      const source = RawTexture.CreateRTexture(
        seeded, edge, edge, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
      );
      const results = new StorageBuffer(engine, edge * edge * 4);
      const shader = new ComputeShader(
        "r32float-probe",
        engine,
        {
          computeSource: /* wgsl */ `
@group(0) @binding(0) var heightTarget: texture_storage_2d<r32float, write>;
@group(0) @binding(1) var heightSource: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let value = f32(id.x) * 1000.0 + f32(id.y) * 0.25;
  textureStore(heightTarget, vec2i(i32(id.x), i32(id.y)), vec4f(value, 0.0, 0.0, 0.0));
  // The question R-4B asks, answered on the adapter: may the SAME r32float
  // texture also be bound as a sampled texture and read with textureLoad? If
  // this pipeline creates, the occlusion bake can read the height atlas
  // directly instead of routing pages through a storage buffer.
  results[id.y * ${edge}u + id.x] = textureLoad(heightSource, vec2i(i32(id.x), i32(id.y)), 0).r;
}
`,
        },
        {
          bindingsMapping: {
            heightTarget: { group: 0, binding: 0 },
            heightSource: { group: 0, binding: 1 },
            results: { group: 0, binding: 2 },
          },
        },
      );
      shader.setStorageTexture("heightTarget", texture);
      shader.setTexture("heightSource", source, false);
      shader.setStorageBuffer("results", results);
      await shader.dispatchWhenReady(edge / 8, edge / 8, 1);

      // Reading the storage buffer first both proves the textureLoad path and
      // forces the submitted work to complete before the texture readback.
      const view = await results.read();
      const loaded = new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + edge * edge * 4),
      );
      for (const [x, y] of [[0, 0], [3, 7], [31, 31]] as const) {
        expect(loaded[y * edge + x], `textureLoad ${x},${y}`)
          .toBe(seeded[y * edge + x]);
      }

      const pixels = await texture.readPixels() as Float32Array;
      expect(pixels.length).toBeGreaterThanOrEqual(edge * edge);
      for (const [x, y] of [[0, 0], [3, 7], [31, 31]] as const) {
        // Exact, not close: r32float carries the value, and any conversion in
        // the write or the readback would show here.
        expect(pixels[y * edge + x], `${x},${y}`).toBe(x * 1000 + y * 0.25);
      }
      results.dispose();
      source.dispose();
      texture.dispose();
    } finally {
      scene?.dispose();
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 120_000);
});
