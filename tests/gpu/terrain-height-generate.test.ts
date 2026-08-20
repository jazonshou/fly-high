import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  decodeOrderableFloat,
  encodeOrderableFloat,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import {
  TERRAIN_HEIGHT_PARITY_CRITERIA,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainSupersampleOffsets,
  terrainTexelSizeMeters,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "../../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";
import { sampleNaturalTerrainHeight } from "../../src/world/terrain";

/**
 * `4-3`'s gate (assertions 76 and 80), plus criterion 4 of `4-1`'s parity: the
 * ATLAS's L0 page against the physics kernel, through the whole real chain —
 * host uniform builder, batched dispatch, `textureStore`, and readback.
 */

const SEED_HASH = hashSeed("terrain-generate");

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

describe("terrain page generation (4-3)", () => {
  // Assertion 80 — a Node-visible property, asserted here too because this is
  // the file that would silently lose it.
  it("takes exactly one sample at L0 and four above it", () => {
    expect(terrainSupersampleOffsets(0)).toHaveLength(1);
    expect(terrainSupersampleOffsets(1)).toHaveLength(4);
    expect(terrainSupersampleOffsets(5)).toHaveLength(4);
  });

  it("round-trips the monotonic float encoding the atomics reduce with", () => {
    for (const value of [-180, -0.5, 0, 1e-6, 12.75, 2_200]) {
      expect(decodeOrderableFloat(encodeOrderableFloat(value))).toBeCloseTo(value, 5);
    }
    // Monotonic: that is the whole property atomicMin/atomicMax rely on.
    expect(encodeOrderableFloat(-180)).toBeLessThan(encodeOrderableFloat(0));
    expect(encodeOrderableFloat(0)).toBeLessThan(encodeOrderableFloat(2_200));
  });

  // Assertion 76 (height half) and 4-1 criterion 4.
  it("generates an L0 page that agrees with the physics kernel", async () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const address = createWorldPageAddress(0, 12, -7);
    const result = await withScene(async (engine, scene) => {
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "gpu-test",
      });
      const generator = new TerrainPageGenerator(engine, atlas, SEED_HASH);
      atlas.residency.beginFrame(1);
      const request = atlas.residency.request(invariantSlotKey(address), address)!;
      expect(request.token).not.toBeNull();
      await generator.generate([request.slot]);
      // The page becomes resident only once its bounds readback resolves —
      // the asynchronous half of WorldPageLifecycle, exercised for real.
      expect(request.slot.lifecycle.state).toBe("resident");

      const origin = atlas.slotOrigin(request.slot.slotIndex);
      const texture = atlas.texture()!;
      const pixels = await texture.readPixels(
        0, 0, undefined, true, false,
        origin.u, origin.v, TERRAIN_HEIGHT_SLOT_EDGE, TERRAIN_HEIGHT_SLOT_EDGE,
      );
      const stats = request.slot.stats;
      generator.dispose();
      atlas.dispose();
      return { pixels: pixels as Float32Array, stats };
    });

    const heights = result.pixels;
    expect(heights.length).toBeGreaterThanOrEqual(
      TERRAIN_HEIGHT_SLOT_EDGE * TERRAIN_HEIGHT_SLOT_EDGE,
    );
    const texelSize = terrainTexelSizeMeters(0);
    const originX = address.x * WORLD_PAGE_BASE_EXTENT_METERS;
    const originZ = address.z * WORLD_PAGE_BASE_EXTENT_METERS;

    let worst = 0;
    let minSeen = Number.POSITIVE_INFINITY;
    let maxSeen = Number.NEGATIVE_INFINITY;
    // Every 7th texel: 1,444 comparisons against the f64 oracle is plenty and
    // keeps the headless run inside its timeout.
    for (let row = 0; row < TERRAIN_HEIGHT_SLOT_EDGE; row += 7) {
      for (let column = 0; column < TERRAIN_HEIGHT_SLOT_EDGE; column += 7) {
        const value = heights[row * TERRAIN_HEIGHT_SLOT_EDGE + column]!;
        minSeen = Math.min(minSeen, value);
        maxSeen = Math.max(maxSeen, value);
        const x = originX + (column - WORLD_PAGE_GUTTER) * texelSize;
        const z = originZ + (row - WORLD_PAGE_GUTTER) * texelSize;
        // filterWidth 0 at L0 by construction, so this is the physics kernel.
        worst = Math.max(worst, Math.abs(value - sampleNaturalTerrainHeight(SEED_HASH, x, z, 0)));
      }
    }
    console.log(
      `L0 atlas vs physics kernel: max |Δh| = ${worst.toFixed(5)} m; `
      + `bounds [${result.stats.minHeightMeters.toFixed(2)}, `
      + `${result.stats.maxHeightMeters.toFixed(2)}] m, `
      + `maxDeviationFromParent ${result.stats.maxDeviationFromParent.toFixed(4)} m`,
    );
    expect(worst).toBeLessThan(TERRAIN_HEIGHT_PARITY_CRITERIA.physicsToleranceMeters);

    // The reduced bounds must contain what the page actually holds, and the
    // CDLOD deviation must be a real measurement rather than a level constant.
    expect(result.stats.minHeightMeters).toBeLessThanOrEqual(minSeen + 1e-3);
    expect(result.stats.maxHeightMeters).toBeGreaterThanOrEqual(maxSeen - 1e-3);
    expect(result.stats.maxDeviationFromParent).toBeGreaterThan(0);
    expect(result.stats.maxDeviationFromParent).toBeLessThan(50);
  }, 180_000);

  it("resolves a batch of pages in one dispatch", async () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const addresses = [
      createWorldPageAddress(0, 0, 0),
      createWorldPageAddress(1, 3, 3),
      createWorldPageAddress(4, -2, 5),
    ];
    const stats = await withScene(async (engine, scene) => {
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "gpu-test",
      });
      const generator = new TerrainPageGenerator(engine, atlas, SEED_HASH);
      atlas.residency.beginFrame(1);
      const slots = addresses.map((address) =>
        atlas.residency.request(invariantSlotKey(address), address)!.slot);
      // One dispatch for the whole batch: a writeBuffer between per-page
      // dispatches would land before any of them executed.
      await generator.generate(slots);
      const collected = slots.map((slot) => ({
        state: slot.lifecycle.state,
        ...slot.stats,
      }));
      generator.dispose();
      atlas.dispose();
      return collected;
    });
    expect(stats.map((entry) => entry.state)).toEqual(["resident", "resident", "resident"]);
    for (const entry of stats) {
      expect(entry.maxHeightMeters).toBeGreaterThanOrEqual(entry.minHeightMeters);
      expect(Number.isFinite(entry.maxDeviationFromParent)).toBe(true);
    }
    // Coarser pages carry more deviation from their parent than L0 does: the
    // measurement is a real second difference, not a level heuristic.
    expect(stats[2]!.maxDeviationFromParent).toBeGreaterThan(stats[0]!.maxDeviationFromParent);
  }, 180_000);

  it("keeps the height core inside the page geometry it was derived from", () => {
    expect(TERRAIN_HEIGHT_SLOT_EDGE).toBe(WORLD_PAGE_HEIGHT_CORE + WORLD_PAGE_GUTTER * 2);
    expect(TERRAIN_HEIGHT_SLOT_EDGE % 8).toBe(0);
  });
});
