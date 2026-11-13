import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ThinWebGPUEngine } from "@babylonjs/core/Engines/thinWebGPUEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { uploadDisplayAtlas, type DisplayAtlas } from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { createRawTextureFromMipChain } from "../src/render/webgpu/core/MipChainUpload";
import { planMippedTextureArray, uploadMippedTextureArrayPlan } from "../src/render/webgpu/core/TextureArrayMips";
import { dropTextureCpuMirror } from "../src/render/webgpu/core/TextureCpuMirror";

/**
 * Babylon keeps a CPU copy of every raw-texture upload for a device-loss
 * restore this game never runs (`TextureCpuMirror.ts`). The upload
 * boundaries drop it once the last level is in, and the GPU still receives
 * exactly the same writes.
 *
 * `NullEngine` neither keeps per-level copies nor writes a GPU, so the harness
 * routes its raw-texture updates through the WebGPU engine's OWN
 * `updateRawTexture` / `updateRawTexture2DArray` (Babylon's code, unchanged),
 * with the texture writer and the mip blit recorded instead of issued.
 */

interface GpuWrite {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** The buffer the write was handed; the bytes are compared through it. */
  readonly source: ArrayBufferLike;
  readonly bytes: Uint8Array;
  /** How many levels Babylon held a CPU copy of when this write was issued. */
  readonly mirroredLevels: number;
}

type WebGpuUpdate = (this: unknown, texture: InternalTexture, data: ArrayBufferView | null, ...rest: unknown[]) => void;
const webGpu = ThinWebGPUEngine.prototype as unknown as {
  updateRawTexture: WebGpuUpdate;
  updateRawTexture2DArray: WebGpuUpdate;
};

const fixtures: { engine: NullEngine; scene: Scene }[] = [];
afterEach(() => {
  for (const { engine, scene } of fixtures.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});

function webGpuMirroringScene(): { scene: Scene; writes: GpuWrite[]; blits: number[] } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  fixtures.push({ engine, scene });
  const writes: GpuWrite[] = [];
  const blits: number[] = [];
  // The parts of the WebGPU engine its raw-texture updates touch: the
  // context-loss flag at its default, the GPU writer and the mip blit.
  const gpu = {
    _doNotHandleContextLost: false,
    _uploadEncoder: null,
    _textureHelper: {
      updateTexture(
        data: Uint8Array, texture: InternalTexture, width: number, height: number, depth: number,
        _format: unknown, _face: number, level: number,
      ): void {
        writes.push({
          level, width, height, depth,
          source: data.buffer,
          bytes: data.slice(),
          mirroredLevels: (texture._bufferViewArray ?? []).filter(Boolean).length,
        });
      },
    },
    _generateMipmaps(texture: InternalTexture): void {
      blits.push(texture.uniqueId);
    },
  };
  const withHardware = (texture: InternalTexture): InternalTexture => {
    (texture as unknown as { _hardwareTexture: unknown })._hardwareTexture ??= { format: "rgba8unorm", release() {} };
    return texture;
  };
  const target = engine as unknown as Record<string, unknown>;
  target.updateRawTexture = (texture: InternalTexture, ...rest: unknown[]) =>
    webGpu.updateRawTexture.call(gpu, withHardware(texture), ...(rest as [ArrayBufferView | null]));
  target.updateRawTexture2DArray = (texture: InternalTexture, ...rest: unknown[]) =>
    webGpu.updateRawTexture2DArray.call(gpu, withHardware(texture), ...(rest as [ArrayBufferView | null]));
  // NullEngine cannot build an array texture; this is the WebGPU engine's
  // `createRawTexture2DArray` minus the GPU allocation.
  target.createRawTexture2DArray = (
    data: ArrayBufferView | null, width: number, height: number, depth: number, format: number,
    generateMipMaps: boolean, invertY: boolean, samplingMode: number, compression: string | null,
    textureType: number, creationFlags: number, mipLevelCount: number,
  ): InternalTexture => {
    const texture = new InternalTexture(engine, InternalTextureSource.Raw2DArray);
    Object.assign(texture, {
      baseWidth: width, baseHeight: height, baseDepth: depth, width, height, depth, format,
      type: textureType, generateMipMaps, samplingMode, is2DArray: true, _creationFlags: creationFlags,
      mipLevelCount,
    });
    texture._bufferView = data;
    webGpu.updateRawTexture2DArray.call(gpu, withHardware(texture), data, format, invertY, compression, textureType);
    return texture;
  };
  return { scene, writes, blits };
}

function mirrorOf(texture: BaseTexture): { bufferView: unknown; bufferViewArray: unknown } {
  const internal = texture.getInternalTexture()!;
  return { bufferView: internal._bufferView, bufferViewArray: internal._bufferViewArray };
}

const chain = (width: number, height: number): Uint8Array[] => {
  const levels: Uint8Array[] = [];
  for (let level = 0; Math.max(width, height) >> level >= 1; level += 1) {
    const bytes = new Uint8Array(Math.max(1, width >> level) * Math.max(1, height >> level) * 4);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + level * 31) & 255;
    levels.push(bytes);
  }
  return levels;
};

describe("Babylon's CPU copy of hand-built mip chains", () => {
  it("is dropped by the 2D boundary after the last level, which every level reached the GPU unchanged before", () => {
    const { scene, writes, blits } = webGpuMirroringScene();
    const levels = chain(16, 4);
    const texture = createRawTextureFromMipChain(scene, levels, 16, 4, { useSrgbBuffer: true });
    expect(writes.map((write) => [write.level, write.width, write.height])).toEqual(
      levels.map((_, level) => [level, Math.max(1, 16 >> level), Math.max(1, 4 >> level)]),
    );
    writes.forEach((write, level) => {
      expect(write.source, `level ${level} was handed the caller's own buffer`).toBe(levels[level]!.buffer);
      expect(write.bytes, `level ${level}`).toEqual(levels[level]);
    });
    expect(blits, "no Babylon blit (FI-5)").toEqual([]);
    // CONTROL: the WebGPU engine really does keep a copy of each level while uploading.
    expect(writes.at(-1)!.mirroredLevels).toBe(levels.length);
    expect(mirrorOf(texture)).toEqual({ bufferView: null, bufferViewArray: null });
  });

  it("is dropped by the array boundary after the last level, with every layer's levels written as before", () => {
    const { scene, writes, blits } = webGpuMirroringScene();
    const layers = [0, 1, 2].map((layer) => new Uint8Array(8 * 8 * 4).map((_, index) => (index * 13 + layer * 57) & 255));
    const plan = planMippedTextureArray(layers, 8, "box");
    const texture = uploadMippedTextureArrayPlan(scene, plan, { name: "mirror-array" });
    // The constructor's no-data write records nothing; then one write per level, every layer in it.
    expect(writes.map((write) => [write.level, write.width, write.depth])).toEqual([[0, 8, 3], [1, 4, 3], [2, 2, 3], [3, 1, 3]]);
    writes.forEach((write, level) => {
      expect(write.source, `level ${level}`).toBe(plan.packedLevels[level]!.buffer);
      expect(write.bytes, `level ${level}`).toEqual(plan.packedLevels[level]);
    });
    expect(blits).toEqual([]);
    expect(writes.at(-1)!.mirroredLevels).toBe(plan.mipLevelCount);
    expect(mirrorOf(texture)).toEqual({ bufferView: null, bufferViewArray: null });
  });

  it("comes back with a later upload, so a texture uploaded again drops it again", () => {
    const { scene } = webGpuMirroringScene();
    const texture = new RawTexture(new Uint8Array(4), 1, 1, 5, scene, false);
    const second = new Uint8Array([1, 2, 3, 4]);
    texture.update(second);
    expect(mirrorOf(texture).bufferView).toBe(second);
    dropTextureCpuMirror(texture);
    expect(mirrorOf(texture)).toEqual({ bufferView: null, bufferViewArray: null });
  });

  it("is not kept for a cockpit display readback", () => {
    const { scene, writes } = webGpuMirroringScene();
    const pixels = new Uint8ClampedArray(4 * 2 * 4).map((_, index) => index);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(pixels.length), 4, 2, scene, false);
    writes.length = 0;
    const atlas = {
      texture,
      width: 4,
      height: 2,
      canvas: { getContext: () => ({ getImageData: () => ({ data: pixels }) }) },
    } as unknown as DisplayAtlas;
    uploadDisplayAtlas(atlas);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.source).toBe(pixels.buffer);
    expect(writes[0]!.bytes).toEqual(new Uint8Array(pixels.buffer));
    expect(mirrorOf(texture)).toEqual({ bufferView: null, bufferViewArray: null });
  });

  it("tolerates a texture with no internal texture", () => {
    expect(() => dropTextureCpuMirror({ getInternalTexture: () => null } as unknown as BaseTexture)).not.toThrow();
  });
});
