import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAircraftSurfaceTextures, synthesizeAircraftSurface } from "../src/render/webgpu/aircraft/materialSynthesis";
import { createRawTextureFromMipChain } from "../src/render/webgpu/core/MipChainUpload";

/**
 * FI-5, the headless half: hand-built mip chains are uploaded with Babylon's
 * own generation OFF and the sampler told to read them, through two upload
 * boundaries and nowhere else. Whether the GPU then HOLDS and SAMPLES the
 * chain is `tests/gpu/mip-chain-upload.test.ts`; this pins the flags and the
 * routing, which is what a later edit would break.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixtures: { engine: NullEngine; scene: Scene }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { engine, scene } of fixtures.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});
function scene(): Scene {
  const engine = new NullEngine();
  const created = new Scene(engine);
  fixtures.push({ engine, scene: created });
  return created;
}
const chain = (width: number, height: number): Uint8Array[] => {
  const levels: Uint8Array[] = [];
  for (let level = 0; Math.max(width, height) >> level >= 1; level += 1) {
    levels.push(new Uint8Array(Math.max(1, width >> level) * Math.max(1, height >> level) * 4).fill(level));
  }
  return levels;
};

describe("createRawTextureFromMipChain", () => {
  it("takes the chain over from Babylon before uploading anything, and tells the sampler to read it", () => {
    const levels = chain(16, 4);
    const written: { level: number; bytes: number }[] = [];
    const update = RawTexture.prototype.updateMipLevel;
    vi.spyOn(RawTexture.prototype, "updateMipLevel").mockImplementation(function (this: RawTexture, data: ArrayBufferView, level: number) {
      written.push({ level, bytes: data.byteLength });
      return update.call(this, data, level);
    });
    const texture = createRawTextureFromMipChain(scene(), levels, 16, 4, { useSrgbBuffer: true });
    const internal = texture.getInternalTexture()!;
    expect(internal.generateMipMaps, "an upload of level 0 would record Babylon's blit, which lands last (FI-5)").toBe(false);
    expect(internal.useMipMaps, "without generation, the sampler would read level 0 only").toBe(true);
    // Every level, level 0 included, is uploaded AFTER the takeover: 16 x 4 -> 1 x 1 is five
    // levels, and the non-square tail clamps at one texel.
    expect(written).toEqual([
      { level: 0, bytes: 16 * 4 * 4 }, { level: 1, bytes: 8 * 2 * 4 }, { level: 2, bytes: 4 * 1 * 4 },
      { level: 3, bytes: 2 * 1 * 4 }, { level: 4, bytes: 1 * 1 * 4 },
    ]);
  });

  it("refuses a level of the wrong size before allocating anything", () => {
    const levels = chain(8, 8);
    levels[2] = new Uint8Array(3);
    const target = scene();
    expect(() => createRawTextureFromMipChain(target, levels, 8, 8, { useSrgbBuffer: false })).toThrow(RangeError);
    expect(target.textures).toEqual([]);
  });

  it("is what the shipped aircraft paint goes through: every map built without generation and read through its chain", () => {
    const textures = createAircraftSurfaceTextures(scene(), "fi5-paint", synthesizeAircraftSurface({
      seed: 7, baseColor: 0xffffff, liveryColor: 0xffffff, roughness: 0.4, metallic: 0.1, sootStrength: 0.2, wearStrength: 0.2, panelStrength: 0.3,
    }));
    for (const texture of [textures.albedo, textures.normal, textures.metallicRoughness]) {
      const internal = texture.getInternalTexture()!;
      expect([internal.generateMipMaps, internal.useMipMaps], texture.name).toEqual([false, true]);
    }
  });
});

describe("hand-built mip levels are written in two places only", () => {
  const HELPERS = ["src/render/webgpu/core/MipChainUpload.ts", "src/render/webgpu/core/TextureArrayMips.ts"];
  function sources(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sources(path));
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
    return found;
  }
  /** Call sites of `updateMipLevel(` outside comments. */
  const callers = (text: string): number => text.split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /\.updateMipLevel\(/.test(line)).length;

  it("every updateMipLevel call in src/ is inside the two upload boundaries", () => {
    // CONTROL: the scan sees a call, and does not see one in a comment.
    expect(callers("  texture.updateMipLevel(data, 1);\n")).toBe(1);
    expect(callers("  // texture.updateMipLevel(data, 1);\n   * `texture.updateMipLevel(data, 1)`\n")).toBe(0);
    const offenders = sources(join(ROOT, "src"))
      .map((path) => relative(ROOT, path).split("\\").join("/"))
      .filter((path) => !HELPERS.includes(path) && callers(readFileSync(join(ROOT, path), "utf8")) > 0);
    expect(offenders, "a hand-built chain uploaded around the helpers can reintroduce FI-5").toEqual([]);
    for (const helper of HELPERS) expect(callers(readFileSync(join(ROOT, helper), "utf8")), helper).toBe(1);
  });

  it("the texture-array boundary allocates with no data, and takes the chain over before its first upload", () => {
    // NullEngine cannot build a texture array, so the array boundary is pinned by its source.
    const text = readFileSync(join(ROOT, "src/render/webgpu/core/TextureArrayMips.ts"), "utf8");
    const body = /export function uploadMippedTextureArrayPlan\([\s\S]*?\n\}\n/u.exec(text)?.[0];
    expect(body, "uploadMippedTextureArrayPlan moved").toBeDefined();
    const construction = /new RawTexture2DArray\(([\s\S]*?)\);/u.exec(body!)?.[1]?.split(",").map((argument) => argument.trim());
    // (data, width, height, depth, format, scene, generateMipMaps, ...): generation ON so the GPU
    // allocates every level, and NO data so nothing is uploaded -- and no blit recorded -- yet.
    expect(construction?.[0], "the array uploads level 0 while Babylon still owns its chain").toBe("null");
    expect(construction?.[6], "without generation the GPU allocates one level").toBe("true");
    const takeover = body!.indexOf("takeOverMipChain(texture)");
    expect(takeover, "the array never takes its chain over").toBeGreaterThan(-1);
    expect(takeover, "an upload comes before the takeover").toBeLessThan(body!.indexOf(".updateMipLevel("));
  });

  it("the GPU memory inventory still counts a hand-built chain's levels", () => {
    // It keyed the 4/3 mip factor on `generateMipMaps` alone, and the chains now carry their
    // levels with it off: a third of their bytes would have left a gated number.
    const text = readFileSync(join(ROOT, "src/render/FlightRenderer.ts"), "utf8");
    const factor = /const mipFactor = ([^;]*);/u.exec(text)?.[1];
    expect(factor, "the inventory's mip factor moved").toBeDefined();
    expect(factor).toMatch(/mipLevelCount/u);
  });
});
