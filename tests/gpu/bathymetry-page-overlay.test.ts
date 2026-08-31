import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import {
  BathymetryClipmap,
  BATHYMETRY_CLIPMAP_EDGE,
  bathymetryPageHeightAtlasTexel,
  toroidalBathymetryTexel,
  type BathymetryErodedPageOverlaySeam,
  type BathymetryResidentErodedPage,
} from "../../src/render/webgpu/water/BathymetryClipmap";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import { TERRAIN_HEIGHT_SLOT_EDGE } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "../../src/render/webgpu/world/pageGeometry";
import { createWorld } from "../../src/world";

/**
 * W-6 (C-6) end to end on a real adapter: a synthetic RESIDENT eroded L0 page
 * must land its 2 m heights in the bathymetry clipmap inside the page
 * footprint, the 512 m macro must survive outside it, and the border feather
 * must be monotone in between — through the real host path (page-table build,
 * strip dispatch, textureStore, readback), including the per-delta rect
 * invalidation on admission and eviction.
 */

async function withScene<T>(
  run: (engine: WebGPUEngine, scene: Scene) => Promise<T>,
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
      // The R16F bathymetry storage textures need tier1, exactly as the
      // renderer requires (FlightRenderer refuses adapters without it).
      requiredFeatures: ["texture-formats-tier1"] as GPUFeatureName[],
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

function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa !== 0 ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1_024) * 2 ** (exponent - 15);
}

/** Read a whole level and return a sampler addressed by GLOBAL texel. */
async function readBedDeltas(
  texture: RawTexture,
): Promise<(worldTexelX: number, worldTexelZ: number) => number> {
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
  return (worldTexelX, worldTexelZ) => {
    const [u, v] = toroidalBathymetryTexel(worldTexelX, worldTexelZ);
    return values[(v * BATHYMETRY_CLIPMAP_EDGE + u) * stride]!;
  };
}

describe("W-6 eroded bathymetry page overlay (C-6)", () => {
  it("overlays a resident page, feathers its macro border, and reverts on eviction", async () => {
    const world = createWorld("bathymetry-page-overlay", {
      airport: false,
      worldEvolution: "eroded",
    });
    const seaLevel = world.seaLevel;
    const macroDelta = 20;
    const pageDelta = -40;
    const probeDelta = -100;
    // Kilometres out, per the world-scale capture rule.
    const tileX = 40;
    const tileZ = -25;
    const macro: TerrainMacroEvolutionExport = {
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: world.seed, deviceFingerprint: "gpu-fixture" },
      seaLevelMeters: seaLevel,
      heightMeters: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT).fill(seaLevel + macroDelta),
      flowAccumulationAreaM2: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakes: [],
      drainageBaseLevels: [],
      channelSeedTexelIndices: new Uint32Array(0),
    };
    const page: BathymetryResidentErodedPage = { tileX, tileZ, slotU: 0, slotV: 0 };
    const centerX = tileX * WORLD_PAGE_BASE_EXTENT_METERS + 256;
    const centerZ = tileZ * WORLD_PAGE_BASE_EXTENT_METERS + 256;
    // A single distinctive 2 m texel proves the NEAREST fetch addresses the
    // atlas slot through the stored gutter, not merely the right page.
    const heightData = new Float32Array(TERRAIN_HEIGHT_SLOT_EDGE ** 2)
      .fill(seaLevel + pageDelta);
    const [probeU, probeV] = bathymetryPageHeightAtlasTexel(page, centerX, centerZ);
    heightData[probeV * TERRAIN_HEIGHT_SLOT_EDGE + probeU] = seaLevel + probeDelta;

    await withScene(async (_engine, scene) => {
      const heightTexture = RawTexture.CreateRTexture(
        heightData,
        TERRAIN_HEIGHT_SLOT_EDGE,
        TERRAIN_HEIGHT_SLOT_EDGE,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_FLOAT,
      );
      const pages: BathymetryResidentErodedPage[] = [];
      const seam: BathymetryErodedPageOverlaySeam = {
        residentErodedL0Pages: () => pages.slice(),
        heightAtlasTexture: () => heightTexture,
        pageTableCapacity: () => 4,
      };
      const clipmap = new BathymetryClipmap(scene, world, seam);
      try {
        clipmap.setMacroEvolution(macro);
        // Full refresh with NO resident page: pure macro everywhere.
        await clipmap.initialize(centerX, centerZ);
        expect(clipmap.isResident).toBe(true);
        const nearTexture = clipmap.binding.nearTexture!;
        const pageMinTexelX = tileX * (WORLD_PAGE_BASE_EXTENT_METERS / 16);
        const pageMinTexelZ = tileZ * (WORLD_PAGE_BASE_EXTENT_METERS / 16);
        const centerTexelX = pageMinTexelX + 16;
        const centerTexelZ = pageMinTexelZ + 16;
        const beforeAdmission = await readBedDeltas(nearTexture);
        expect(beforeAdmission(centerTexelX, centerTexelZ)).toBeCloseTo(macroDelta, 1);

        // Admission rides the per-delta rect path, not a full refresh.
        pages.push(page);
        expect(await clipmap.recenter(centerX, centerZ)).toBe(true);
        const near = await readBedDeltas(nearTexture);
        // The probe texel: page height fetched at 2 m NEAREST via the gutter.
        expect(near(centerTexelX, centerTexelZ)).toBeCloseTo(probeDelta, 1);
        // One 16 m texel over: the constant page bed.
        expect(near(centerTexelX + 1, centerTexelZ)).toBeCloseTo(pageDelta, 1);
        // Outside the footprint the macro authority survives untouched.
        expect(near(pageMinTexelX - 8, centerTexelZ)).toBeCloseTo(macroDelta, 1);
        expect(near(pageMinTexelX - 3, centerTexelZ)).toBeCloseTo(macroDelta, 1);
        // Crossing the west border: macro on the seam texel, the smoothstep
        // midpoint one texel in, full page authority at the feather's end,
        // monotone the whole way.
        const west = [0, 1, 2, 3, 4].map((step) =>
          near(pageMinTexelX + step, centerTexelZ));
        expect(west[0]).toBeCloseTo(macroDelta, 1);
        expect(west[1]).toBeCloseTo((macroDelta + pageDelta) / 2, 1);
        expect(west[2]).toBeCloseTo(pageDelta, 1);
        expect(west[3]).toBeCloseTo(pageDelta, 1);
        for (let step = 1; step < west.length; step += 1) {
          expect(west[step]!).toBeLessThanOrEqual(west[step - 1]! + 0.05);
        }

        // The far level refreshes the same footprint at its 128 m texels.
        const far = await readBedDeltas(clipmap.binding.farTexture!);
        const farMinTexelX = tileX * (WORLD_PAGE_BASE_EXTENT_METERS / 128);
        const farMinTexelZ = tileZ * (WORLD_PAGE_BASE_EXTENT_METERS / 128);
        expect(far(farMinTexelX + 1, farMinTexelZ + 1)).toBeCloseTo(pageDelta, 1);
        expect(far(farMinTexelX, farMinTexelZ + 1)).toBeCloseTo(macroDelta, 1);
        expect(far(farMinTexelX - 2, farMinTexelZ + 1)).toBeCloseTo(macroDelta, 1);

        // Eviction re-dispatches the footprint: back to the macro floor.
        pages.length = 0;
        expect(await clipmap.recenter(centerX, centerZ)).toBe(true);
        const evicted = await readBedDeltas(nearTexture);
        expect(evicted(centerTexelX, centerTexelZ)).toBeCloseTo(macroDelta, 1);
        expect(evicted(pageMinTexelX + 8, pageMinTexelZ + 8)).toBeCloseTo(macroDelta, 1);
      } finally {
        clipmap.dispose();
        heightTexture.dispose();
      }
    });
  }, 180_000);
});
