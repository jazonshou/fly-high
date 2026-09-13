import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import {
  BATHYMETRY_CLIPMAP_EDGE,
  BATHYMETRY_R16F_STORAGE_FEATURE,
  toroidalBathymetryTexel,
} from "../../src/render/webgpu/water/BathymetryClipmap";

/**
 * Shared by the bathymetry GPU tests: one engine per test, created with an
 * EXPLICIT feature list. The default is the designed path — tier1 for the
 * r16float storage target, as FlightRenderer requests it on the reference
 * adapter. `[]` is the Firefox shape: a device with no optional feature at
 * all, which Dawn validates against exactly as a core-only implementation
 * would, so the fallback can be proven on the reference adapter.
 */
export async function withBathymetryScene<T>(
  run: (engine: WebGPUEngine, scene: Scene) => Promise<T>,
  requiredFeatures: readonly string[] = [BATHYMETRY_R16F_STORAGE_FEATURE],
): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
    deviceDescriptor: {
      requiredFeatures: [...requiredFeatures] as GPUFeatureName[],
    },
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    engine.runRenderLoop(() => {});
    scene = new Scene(engine);
    return await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

export function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa !== 0 ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1_024) * 2 ** (exponent - 15);
}

export interface BathymetryLevelReadback {
  /** Bed delta at a GLOBAL texel, through the toroidal mapping. */
  readonly read: (worldTexelX: number, worldTexelZ: number) => number;
  /** Channels per texel the readback carried: 1 for r16float, 4 for rgba16float. */
  readonly channelStride: number;
}

/** Read a whole level and return a sampler addressed by GLOBAL texel. */
export async function readBathymetryLevel(
  texture: RawTexture,
): Promise<BathymetryLevelReadback> {
  const pixels = await texture.readPixels(
    0,
    0,
    undefined,
    true,
    false,
    0,
    0,
    BATHYMETRY_CLIPMAP_EDGE,
    BATHYMETRY_CLIPMAP_EDGE,
  );
  if (!pixels) throw new Error("Bathymetry readback returned no data");
  const values = pixels instanceof Float32Array
    ? pixels
    : Float32Array.from(
      new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2),
      decodeHalf,
    );
  const texelCount = BATHYMETRY_CLIPMAP_EDGE * BATHYMETRY_CLIPMAP_EDGE;
  const stride = values.length / texelCount;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`Unexpected bathymetry readback length ${values.length}`);
  }
  return {
    channelStride: stride,
    read: (worldTexelX, worldTexelZ) => {
      const [u, v] = toroidalBathymetryTexel(worldTexelX, worldTexelZ);
      return values[(v * BATHYMETRY_CLIPMAP_EDGE + u) * stride]!;
    },
  };
}

/** The `read` half alone, for tests that only address texels. */
export async function readBedDeltas(
  texture: RawTexture,
): Promise<(worldTexelX: number, worldTexelZ: number) => number> {
  return (await readBathymetryLevel(texture)).read;
}
