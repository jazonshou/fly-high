import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { beforeEach, describe, expect, it, vi } from "vitest";

const textureHarness = vi.hoisted(() => ({
  failName: null as string | null,
  instances: [] as Array<{
    disposeCalls: number;
    disposed: boolean;
    name: string;
    updateMipLevel(data: Uint8Array, level: number): void;
  }>,
}));

vi.mock("@babylonjs/core/Materials/Textures/rawTexture2DArray", () => ({
  RawTexture2DArray: class MockRawTexture2DArray {
    disposeCalls = 0;
    disposed = false;
    name = "";

    constructor() {
      textureHarness.instances.push(this);
    }

    updateMipLevel(): void {
      if (this.name === textureHarness.failName) {
        throw new Error(`forced mip upload failure for ${this.name}`);
      }
    }

    dispose(): void {
      this.disposeCalls += 1;
      this.disposed = true;
    }
  },
}));

import {
  planMippedTextureArray,
  uploadMippedTextureArrayPlan,
} from "../src/render/webgpu/core/TextureArrayMips";
import { createDetailAtlases } from "../src/render/webgpu/detail/ImpostorAtlas";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { TerrainBiome } from "../src/world";

const scene = {} as Scene;

beforeEach(() => {
  textureHarness.failName = null;
  textureHarness.instances.length = 0;
});

describe("detail atlas upload ownership", () => {
  it("disposes a texture when a later mip upload fails before ownership returns", () => {
    const level0 = new Uint8Array(4 * 4 * 4).fill(255);
    const plan = planMippedTextureArray([level0], 4, "box");
    textureHarness.failName = "failing-array";

    expect(() => uploadMippedTextureArrayPlan(scene, plan, { name: "failing-array" }))
      .toThrow("forced mip upload failure for failing-array");
    expect(textureHarness.instances).toHaveLength(1);
    expect(textureHarness.instances[0]!.disposed).toBe(true);
  });

  it("releases foliage and both impostor arrays when the second array fails", () => {
    textureHarness.failName = "detail-impostor-normal-depth";

    expect(() => createDetailAtlases(scene, "transactional-detail-atlas"))
      .toThrow("forced mip upload failure for detail-impostor-normal-depth");
    expect(textureHarness.instances.map((texture) => texture.name)).toEqual([
      "foliage-atlas/transactional-detail-atlas",
      "detail-impostor-albedo",
      "detail-impostor-normal-depth",
    ]);
    expect(
      textureHarness.instances.every((texture) => texture.disposed),
      "every allocation made before the failed composite upload must be released",
    ).toBe(true);
  });

  it("releases each successfully-created atlas array exactly once on runtime teardown", () => {
    const atlases = createDetailAtlases(scene, "owned-detail-atlas");
    const engine = new NullEngine();
    const runtimeScene = new Scene(engine);
    const runtime = new WorldDetailRuntime(runtimeScene, {
      worldSeed: "owned-detail-atlas",
      terrainSample: () => ({
        height: 80,
        slope: 0.04,
        moisture: 0.7,
        biome: TerrainBiome.FOREST,
      }),
    });
    const runtimeAtlases = runtime as unknown as {
      foliageAtlas: typeof atlases.foliage | null;
      impostorAtlas: typeof atlases.impostor | null;
    };
    runtimeAtlases.foliageAtlas = atlases.foliage;
    runtimeAtlases.impostorAtlas = atlases.impostor;

    try {
      runtime.dispose();
      runtime.dispose();

      expect(textureHarness.instances.map((texture) => texture.disposeCalls)).toEqual([1, 1, 1]);
      expect(runtimeAtlases.foliageAtlas).toBeNull();
      expect(runtimeAtlases.impostorAtlas).toBeNull();
    } finally {
      runtime.dispose();
      runtimeScene.dispose();
      engine.dispose();
    }
  });
});
