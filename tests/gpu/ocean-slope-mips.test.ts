import { describe, expect, it } from "vitest";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { TextureSampler } from "@babylonjs/core/Materials/Textures/textureSampler";
import { Scene } from "@babylonjs/core/scene";
import { resolveOceanMipGenerator } from "../../src/render/webgpu/water/SpectralOceanSystem";

/**
 * 2-8 GPU gates:
 *
 * 1. The private render-based mip path (`engine._generateMipmaps`) works on
 *    the exact texture shape the ocean uses — rgba16float STORAGE RawTexture
 *    with mip storage — and produces box-filtered levels. `RenderInvariants`
 *    asserts the API's existence at startup; this proves it functions.
 *
 * 2. LOD continuity across the patch wrap seam: `textureSampleGrad` with
 *    derivatives of the UNWRAPPED coordinate selects a continuous mip across
 *    `fract()`'s seam, while naive fract-side derivatives spike to the top
 *    mip there (the negative control that shows the test can detect the
 *    failure 2-8 exists to prevent).
 */

function halfBits(value: number): number {
  if (value === 0) return 0x0000;
  if (value === 0.25) return 0x3400;
  if (value === 0.5) return 0x3800;
  if (value === 1) return 0x3c00;
  throw new RangeError(`halfBits only supports test constants, got ${value}`);
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function toFloats(pixels: ArrayBufferView): number[] {
  if (pixels instanceof Float32Array) return [...pixels];
  if (pixels instanceof Uint16Array) return [...pixels].map(halfToFloat);
  throw new TypeError(`Unexpected readPixels buffer ${pixels.constructor.name}`);
}

/**
 * The runtime's WebGPU `updateRawTexture` accepts a trailing `mipLevel`
 * (engine.rawTexture.pure.js) that the public typings do not declare yet.
 */
interface RawTextureLevelUpdater {
  updateRawTexture(
    texture: unknown,
    data: ArrayBufferView,
    format: number,
    invertY: boolean,
    compression: string | null,
    type: number,
    useSRGBBuffer: boolean,
    mipLevel?: number,
  ): void;
}

function uploadLevel(
  engine: WebGPUEngine,
  texture: RawTexture,
  data: Uint16Array,
  level: number,
): void {
  (engine as unknown as RawTextureLevelUpdater).updateRawTexture(
    texture.getInternalTexture()!,
    data,
    Constants.TEXTUREFORMAT_RGBA,
    false,
    null,
    Constants.TEXTURETYPE_HALF_FLOAT,
    false,
    level,
  );
}

function storageTexture(
  scene: Scene,
  edge: number,
  name: string,
): RawTexture {
  const texture = RawTexture.CreateRGBAStorageTexture(
    null,
    edge,
    edge,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT,
  );
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

const SEAM_SAMPLE_COUNT = 32;

const LOD_PROBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var probe_sampler: sampler;
@group(0) @binding(1) var probe_texture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<vec2<f32>>;

@compute @workgroup_size(32, 1, 1)
fn probeSeamLod(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&results)) {
    return;
  }
  // A span of unwrapped coordinates crossing the wrap seam at 1.0. The
  // footprint (1/16 of the texture per sample) targets mip 2 of a 64-texel
  // texture regardless of position.
  let step = 0.004;
  let unwrapped = vec2<f32>(0.94 + f32(id.x) * step, 0.5);
  let gradient = vec2<f32>(1.0 / 16.0, 0.0);
  let continuous = textureSampleGrad(
    probe_texture, probe_sampler, fract(unwrapped), gradient, vec2<f32>(0.0),
  ).r;
  // The naive failure: derivatives of the WRAPPED coordinate. Away from the
  // seam they equal 'step'; across it fract() jumps by ~-1 and the implied
  // footprint spans the whole texture, spiking the selected LOD.
  let wrapped_here = fract(unwrapped);
  let wrapped_next = fract(unwrapped + vec2<f32>(step, 0.0));
  let naive_gradient = vec2<f32>((wrapped_next.x - wrapped_here.x) / step * (1.0 / 16.0), 0.0);
  let naive = textureSampleGrad(
    probe_texture, probe_sampler, wrapped_here, naive_gradient, vec2<f32>(0.0),
  ).r;
  results[id.x] = vec2<f32>(continuous, naive);
}
`;

describe("ocean slope mips (2-8)", () => {
  it("generates box-filtered mips on the ocean's storage textures and keeps grad LOD continuous", async () => {
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
      const scene = new Scene(engine);
      // Compute submissions and readbacks resolve at frame boundaries — pump
      // an empty loop (no camera; nothing renders).
      engine.runRenderLoop(() => {});

      // The startup capability probe must resolve on a real WebGPU engine.
      const generateMips = resolveOceanMipGenerator(engine);
      expect(generateMips, "engine._generateMipmaps must exist").not.toBeNull();

      // ——— Part 1: box filtering on the ocean's exact texture shape ———
      const checker = storageTexture(scene, 8, "mip-check");
      const mip0 = new Uint16Array(8 * 8 * 4);
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const offset = (y * 8 + x) * 4;
          mip0[offset] = halfBits((x + y) % 2 === 0 ? 1 : 0);
          mip0[offset + 1] = halfBits(0.25);
          mip0[offset + 2] = halfBits(0);
          mip0[offset + 3] = halfBits(1);
        }
      }
      uploadLevel(engine, checker, mip0, 0);
      generateMips!(checker);
      const mip1 = toFloats((await checker.readPixels(0, 1))!);
      expect(mip1.length).toBe(4 * 4 * 4);
      for (let texel = 0; texel < 16; texel += 1) {
        // A 2x2 box of an alternating checker averages to 0.5 exactly.
        expect(mip1[texel * 4]).toBeCloseTo(0.5, 2);
        expect(mip1[texel * 4 + 1]).toBeCloseTo(0.25, 2);
      }

      // ——— Part 2: grad LOD continuity across the wrap seam ———
      const ladder = storageTexture(scene, 64, "lod-ladder");
      const levels = Math.floor(Math.log2(64)) + 1;
      const ladderLevel = (level: number): Uint16Array => {
        const edge = 64 >> level;
        const data = new Uint16Array(edge * edge * 4);
        const value = halfBits(level === 1 ? 1 : level === 2 ? 0.5 : level === 3 ? 0.25 : 0);
        for (let texel = 0; texel < edge * edge; texel += 1) {
          data[texel * 4] = value;
          data[texel * 4 + 3] = halfBits(1);
        }
        return data;
      };
      // A level-0 upload auto-triggers the render-based mip blit on the
      // UPLOAD encoder, which submits at frame end — after any immediate
      // writeTexture upload of the upper levels. Let that blit flush across
      // a frame boundary before hand-writing the ladder's upper levels.
      uploadLevel(engine, ladder, ladderLevel(0), 0);
      await new Promise<void>((resolve) => {
        engine.onEndFrameObservable.addOnce(() => resolve());
      });
      for (let level = 1; level < levels; level += 1) {
        uploadLevel(engine, ladder, ladderLevel(level), level);
      }
      const sampler = new TextureSampler();
      sampler.setParameters(
        Texture.WRAP_ADDRESSMODE,
        Texture.WRAP_ADDRESSMODE,
        Texture.WRAP_ADDRESSMODE,
        1,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      const results = new StorageBuffer(engine, SEAM_SAMPLE_COUNT * 2 * 4);
      const probe = new ComputeShader(
        "ocean-lod-probe",
        engine,
        { computeSource: LOD_PROBE_WGSL },
        {
          entryPoint: "probeSeamLod",
          bindingsMapping: {
            probe_sampler: { group: 0, binding: 0 },
            probe_texture: { group: 0, binding: 1 },
            results: { group: 0, binding: 2 },
          },
        },
      );
      probe.setTextureSampler("probe_sampler", sampler);
      probe.setTexture("probe_texture", ladder, false);
      probe.setStorageBuffer("results", results);
      await probe.dispatchWhenReady(1, 1, 1);
      const bytes = await results.read();
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, SEAM_SAMPLE_COUNT * 2);

      // The 1/16 footprint on mip 2 of the ladder reads ~0.5 — and the
      // unwrapped-gradient path must read the SAME level on both sides of
      // the seam.
      let minContinuous = Infinity;
      let maxContinuous = -Infinity;
      let maxNaive = -Infinity;
      for (let index = 0; index < SEAM_SAMPLE_COUNT; index += 1) {
        const continuous = values[index * 2]!;
        const naive = values[index * 2 + 1]!;
        minContinuous = Math.min(minContinuous, continuous);
        maxContinuous = Math.max(maxContinuous, continuous);
        maxNaive = Math.max(maxNaive, naive);
      }
      expect(maxContinuous - minContinuous, "unwrapped grads keep the LOD continuous").toBeLessThan(0.05);
      expect(maxContinuous).toBeCloseTo(0.5, 1);
      // Negative control: fract-side derivatives spike the LOD at the seam
      // (the ladder's top mips are 0, so the naive path dips toward 0 there).
      expect(maxNaive, "the probe must be able to detect the seam failure").toBeCloseTo(0.5, 1);
      const naiveAtSeam = values
        .filter((_, i) => i % 2 === 1)
        .reduce((min, v) => Math.min(min, v), Infinity);
      expect(naiveAtSeam, "naive grads must break at the seam").toBeLessThan(0.2);

      results.dispose();
      checker.dispose();
      ladder.dispose();
      engine.stopRenderLoop();
      scene.dispose();
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }, 60_000);
});
