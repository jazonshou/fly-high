import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import { PageSplatBake } from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { TERRAIN_CHANNEL_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { SURFACE_MATERIAL_COUNT } from "../../src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { createWorld } from "../../src/world";

/**
 * `4-6`'s bake, read back.
 *
 * An UNBAKED page reads as all zeros, which decodes to material id 0 at weight
 * 0 — and material 0 is sand. That is a failure mode which renders perfectly
 * and looks like a desert, so the only way to catch it is to read the texels.
 */
describe("land-cover splat bake (4-6)", () => {
  it("writes plausible material ids and normalised weights", async () => {
    const world = createWorld("splat-bake");
    // A level-4 page with real relief: `terrain-occlusion-bake.test.ts` measures
// 270 m across this one, so it spans several land-cover bands. A flat L0 page
// classifies to ONE material, correctly, and would make this test vacuous.
const address = createWorldPageAddress(4, 3, -2);
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
      const base = resolveWebGpuQualityProfile("medium", "balanced");
      const profile = { ...base, heightAtlasSlots: 4, channelAtlasSlots: 4 };
      const heightAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "height", worldRevision: "splat-bake",
      });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel", worldRevision: "splat-bake",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const generator = new TerrainPageGenerator(
        engine, heightAtlas, world.seedHash, world.airport ?? null,
      );
      const pyramid = new GlobalHeightPyramid(scene, engine, world.seedHash);
      const splat = new PageSplatBake(
        engine, heightAtlas, channelAtlas, world.seedHash,
        world.seaLevel, world.latitudeDegrees, world.airport ?? null,
      );
      heightAtlas.residency.beginFrame(1);
      channelAtlas.residency.beginFrame(1);
      const heightSlot = heightAtlas.residency.request(invariantSlotKey(address), address)!.slot;
      const channelSlot = channelAtlas.residency.request(invariantSlotKey(address), address)!.slot;
      await generator.generate([heightSlot]);
      await pyramid.recenter(address.x * 512, address.z * 512);
      const baked = await splat.bake([channelSlot], 171);
      expect(baked).toBe(1);

      const origin = channelAtlas.slotOrigin(channelSlot.slotIndex);
      const read = async (index: number): Promise<Uint8Array> =>
        await channelAtlas.texture(index)!.readPixels(
          0, 0, undefined, true, false,
          origin.u, origin.v, TERRAIN_CHANNEL_SLOT_EDGE, TERRAIN_CHANNEL_SLOT_EDGE,
        ) as Uint8Array;
      const ids = await read(TERRAIN_CHANNEL_TEXTURES.splatIdLo);
      const weights = await read(TERRAIN_CHANNEL_TEXTURES.splatWeightLo);

      const edge = TERRAIN_CHANNEL_SLOT_EDGE;
      const seen = new Set<number>();
      let weightSumMin = 2;
      let checked = 0;
      for (let row = WORLD_PAGE_GUTTER; row < edge - WORLD_PAGE_GUTTER; row += 5) {
        for (let column = WORLD_PAGE_GUTTER; column < edge - WORLD_PAGE_GUTTER; column += 5) {
          const offset = (row * edge + column) * 4;
          // Ids are stored as unorm over the ten-material axis.
          const primary = Math.round(((ids[offset]! / 255) * (SURFACE_MATERIAL_COUNT - 1)));
          seen.add(primary);
          const total = (weights[offset]! + weights[offset + 1]!
            + weights[offset + 2]! + weights[offset + 3]!) / 255;
          weightSumMin = Math.min(weightSumMin, total);
          checked += 1;
        }
      }
      console.log(
        `splat page: ${checked} texels, materials ${[...seen].sort((a, b) => a - b).join(",")}, `
        + `min weight sum ${weightSumMin.toFixed(3)}`,
      );
      expect(checked).toBeGreaterThan(500);
      // An unbaked page is all zeros: every id 0 (sand) at weight 0. Both
      // halves of that must be impossible.
      expect(weightSumMin).toBeGreaterThan(0.9);
      // A page spanning 270 m of relief must carry more than one material, or
      // the classifier has collapsed to a constant — which renders perfectly
      // and looks like a desert.
      expect(seen.size).toBeGreaterThan(1);

      splat.dispose();
      pyramid.dispose();
      generator.dispose();
      channelAtlas.dispose();
      heightAtlas.dispose();
    } finally {
      scene?.dispose();
      engine.stopRenderLoop();
      engine.dispose();
      canvas.remove();
    }
  }, 240_000);
});
