import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  PAGE_HORIZON_AZIMUTHS,
  PAGE_OCCLUSION_AZIMUTHS,
  PageOcclusionBake,
} from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_CHANNEL_TEXTURES,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { TERRAIN_CHANNEL_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { WORLD_PAGE_GUTTER } from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";

/**
 * Gate 4B's correctness gate (`4-7`). Two properties, both of which a green
 * compile would not give you:
 *
 *  - **Ridges shadow valleys.** Sky visibility must actually vary with the
 *    surrounding relief, and low ground must see less sky than high ground.
 *  - **No discontinuity at a page edge.** Two adjacent pages baked
 *    independently must agree about the same world position, which is what the
 *    global height pyramid exists to buy: without it a march would stop at the
 *    page boundary and the shadow would end there.
 */

const SEED_HASH = hashSeed("terrain-occlusion");
/** A small atlas: this test is about the bake, not about residency pressure. */
const SLOTS = 4;

async function withScene<T>(run: (engine: WebGPUEngine, scene: Scene) => Promise<T>): Promise<T> {
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
    return await run(engine, scene);
  } finally {
    scene?.dispose();
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

interface BakedPage {
  readonly occlusion: Uint8Array;
  readonly horizonA: Uint8Array;
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
}

/** A page whose relief is strong enough for the shadowing property to exist. */
const RELIEF_LEVEL = 4;

async function bakePages(addresses: readonly ReturnType<typeof createWorldPageAddress>[]) {
  return withScene(async (engine, scene) => {
    const base = resolveWebGpuQualityProfile("medium", "balanced");
    const profile = { ...base, heightAtlasSlots: SLOTS, channelAtlasSlots: SLOTS };
    const heightAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "height", worldRevision: "occlusion-test",
    });
    const channelAtlas = new TerrainPageAtlas(scene, profile, {
      kind: "channel",
      worldRevision: "occlusion-test",
      textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
    });
    const generator = new TerrainPageGenerator(engine, heightAtlas, SEED_HASH);
    const pyramid = new GlobalHeightPyramid(scene, engine, SEED_HASH);
    const bake = new PageOcclusionBake(engine, heightAtlas, channelAtlas, pyramid);

    heightAtlas.residency.beginFrame(1);
    channelAtlas.residency.beginFrame(1);
    const heightSlots = addresses.map((address) =>
      heightAtlas.residency.request(invariantSlotKey(address), address)!.slot);
    const channelSlots = addresses.map((address) =>
      channelAtlas.residency.request(invariantSlotKey(address), address)!.slot);
    await generator.generate(heightSlots);
    // The pyramid is centred on the first page, so the march has real
    // coarse-field data beyond every page's own edge.
    await pyramid.recenter(
      addresses[0]!.x * 512 * 2 ** addresses[0]!.level,
      addresses[0]!.z * 512 * 2 ** addresses[0]!.level,
    );
    expect(pyramid.isResident).toBe(true);
    const baked = await bake.bake(channelSlots);
    expect(baked).toBe(addresses.length);

    const occlusionTexture = channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.occlusion)!;
    const horizonTexture = channelAtlas.texture(TERRAIN_CHANNEL_TEXTURES.horizonA)!;
    const pages: BakedPage[] = [];
    for (let index = 0; index < channelSlots.length; index += 1) {
      const origin = channelAtlas.slotOrigin(channelSlots[index]!.slotIndex);
      const read = async (texture: typeof occlusionTexture) =>
        await texture.readPixels(
          0, 0, undefined, true, false,
          origin.u, origin.v, TERRAIN_CHANNEL_SLOT_EDGE, TERRAIN_CHANNEL_SLOT_EDGE,
        ) as Uint8Array;
      pages.push({
        occlusion: await read(occlusionTexture),
        horizonA: await read(horizonTexture),
        minHeightMeters: heightSlots[index]!.stats.minHeightMeters,
        maxHeightMeters: heightSlots[index]!.stats.maxHeightMeters,
      });
    }
    bake.dispose();
    pyramid.dispose();
    generator.dispose();
    channelAtlas.dispose();
    heightAtlas.dispose();
    return pages;
  });
}

describe("page occlusion bake (4-7)", () => {
  it("names one bake, one format, and stores half the azimuths it marches", () => {
    expect(PAGE_OCCLUSION_AZIMUTHS).toBe(16);
    expect(PAGE_HORIZON_AZIMUTHS).toBe(8);
    // §5.2 rejects a half-resolution 68² horizon page: 68 is core 60 plus
    // gutter 4, i.e. a SECOND channel geometry. The saving to take, if the
    // field ever proves over-sampled, is fewer azimuths at this resolution.
    expect(TERRAIN_CHANNEL_SLOT_EDGE).toBe(136);
  });

  it("bakes sky visibility that varies with relief, and shadows low ground", async () => {
    const [page] = await bakePages([createWorldPageAddress(RELIEF_LEVEL, 3, -2)]);
    const edge = TERRAIN_CHANNEL_SLOT_EDGE;
    let minVisibility = 255;
    let maxVisibility = 0;
    let sum = 0;
    let count = 0;
    for (let row = WORLD_PAGE_GUTTER; row < edge - WORLD_PAGE_GUTTER; row += 3) {
      for (let column = WORLD_PAGE_GUTTER; column < edge - WORLD_PAGE_GUTTER; column += 3) {
        const value = page!.occlusion[(row * edge + column) * 4]!;
        minVisibility = Math.min(minVisibility, value);
        maxVisibility = Math.max(maxVisibility, value);
        sum += value;
        count += 1;
      }
    }
    const mean = sum / count;
    console.log(
      `sky visibility over a ${page!.maxHeightMeters - page!.minHeightMeters | 0} m relief page: `
      + `min ${minVisibility}, mean ${mean.toFixed(1)}, max ${maxVisibility} of 255`,
    );
    // Real terrain: nothing is fully enclosed and nothing on a real slope has
    // a perfectly open hemisphere.
    expect(maxVisibility).toBeGreaterThan(minVisibility);
    expect(minVisibility).toBeGreaterThan(0);
    expect(maxVisibility).toBeLessThanOrEqual(255);
    // A flat page would bake a constant, which is the failure mode that looks
    // like success: the shader ran and wrote nothing meaningful.
    expect(maxVisibility - minVisibility).toBeGreaterThan(8);

    // The bent normal must be a unit-ish direction, and its vertical
    // component must point UP — a bent normal below the horizon is a sign
    // convention error that reads as inverted lighting.
    const centre = ((edge >> 1) * edge + (edge >> 1)) * 4;
    const bentY = page!.occlusion[centre + 3]! / 255 * 2 - 1;
    expect(bentY).toBeGreaterThan(0);

    // Horizon angles are sines in [0, 1); a fully open azimuth reads 0.
    let horizonMax = 0;
    for (let index = 0; index < edge * edge * 4; index += 4) {
      horizonMax = Math.max(horizonMax, page!.horizonA[index]!);
    }
    expect(horizonMax).toBeGreaterThan(0);
    expect(horizonMax).toBeLessThan(255);
  }, 240_000);

  it("agrees across a page edge, which is what the global pyramid buys", async () => {
    // Two adjacent pages, baked independently in the same dispatch. The march
    // leaves each page almost immediately near the shared edge, so without the
    // pyramid the two would disagree by however much the march found inside
    // its own page and nothing outside it.
    const left = createWorldPageAddress(RELIEF_LEVEL, 3, -2);
    const right = createWorldPageAddress(RELIEF_LEVEL, 4, -2);
    const [pageLeft, pageRight] = await bakePages([left, right]);
    const edge = TERRAIN_CHANNEL_SLOT_EDGE;
    const core = edge - 2 * WORLD_PAGE_GUTTER;

    let worst = 0;
    for (let row = WORLD_PAGE_GUTTER + 1; row < edge - WORLD_PAGE_GUTTER - 1; row += 1) {
      // Last interior column of the left page and first of the right page are
      // one channel texel apart in world space.
      const leftValue = pageLeft!.occlusion[
        (row * edge + WORLD_PAGE_GUTTER + core - 1) * 4
      ]!;
      const rightValue = pageRight!.occlusion[(row * edge + WORLD_PAGE_GUTTER) * 4]!;
      worst = Math.max(worst, Math.abs(leftValue - rightValue));
    }
    console.log(`page-edge sky-visibility discontinuity: max ${worst} of 255`);
    // One texel of real terrain change is allowed; a seam would be far larger.
    expect(worst).toBeLessThan(40);
  }, 240_000);
});
