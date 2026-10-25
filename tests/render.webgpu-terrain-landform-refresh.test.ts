import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TERRAIN_LANDFORM_REFRESH,
  TerrainClipmapSystem,
  terrainLandformRefreshDue,
  type TerrainComputeFactory,
  type TerrainLandformIndex,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import {
  terrainPageLandformMargin,
  type TerrainAtlasSlot,
} from "../src/render/webgpu/terrain/TerrainPageAtlas";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "../src/render/webgpu/world/pageGeometry";
import { createWorldPageAddress } from "../src/render/webgpu/world/pageKey";
import { createWorld } from "../src/world";

/**
 * Coarse terrain pages are wider than the volcanic site index (144 km against
 * a 262 km root), so they are baked with part of it and refreshed in place as
 * the observer moves (`TERRAIN_LANDFORM_REFRESH`). The real producers need
 * WebGPU; these fakes record the same coverage the generator does.
 */

const HALF = 72_000;

class FakeIndex implements TerrainLandformIndex {
  readonly buffer = {} as StorageBuffer;
  readonly bufferVersion = 0;
  readonly enabled = true;
  building = false;
  uploadCount = 0;
  readonly coverage = new Float64Array(4);
  primed: [number, number][] = [];

  constructor(x: number, z: number) {
    this.centre(x, z);
  }

  centre(x: number, z: number): void {
    this.coverage.set([x - HALF, z - HALF, x + HALF, z + HALF]);
    this.uploadCount += 1;
  }

  covers(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    const c = this.coverage;
    return minX >= c[0]! && minZ >= c[1]! && maxX <= c[2]! && maxZ <= c[3]!;
  }

  prime(x: number, z: number): void {
    this.primed.push([x, z]);
  }

  update(): void {}
  dispose(): void {}
}

function pageCovered(index: FakeIndex, slot: TerrainAtlasSlot): boolean {
  const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** slot.address.level;
  const margin = terrainPageLandformMargin(slot.address.level);
  return index.covers(
    slot.address.x * extent - margin,
    slot.address.z * extent - margin,
    (slot.address.x + 1) * extent + margin,
    (slot.address.z + 1) * extent + margin,
  );
}

interface Recording {
  readonly factory: TerrainComputeFactory;
  readonly refreshBatches: TerrainAtlasSlot[][];
  /** Channel bakes handed a slot that was already resident: the in-place re-bakes. */
  readonly residentChannelBakes: TerrainAtlasSlot[];
}

function recordingFactory(index: FakeIndex): Recording {
  const refreshBatches: TerrainAtlasSlot[][] = [];
  const residentChannelBakes: TerrainAtlasSlot[] = [];
  const factory: TerrainComputeFactory = ({ heightAtlas, existingPyramid }) => ({
    pageGenerator: {
      generate: async (slots) => {
        // What TerrainPageGenerator records at dispatch.
        for (const slot of slots) {
          slot.landformCoverage = pageCovered(index, slot) ? null : Float64Array.from(index.coverage);
        }
        await Promise.resolve();
        for (const slot of slots) {
          if (!slot.token) continue;
          heightAtlas.residency.complete(slot.key, slot.token, {
            minHeightMeters: 0,
            maxHeightMeters: 100,
            maxDeviationFromParent: 4,
          });
        }
      },
      refresh: async (slots) => {
        const resident = slots.filter((slot) =>
          slot.lifecycle.state === "resident" && slot.address.level > 0 && !slot.generationSubmitted);
        refreshBatches.push([...resident]);
        for (const slot of resident) {
          slot.generationSubmitted = true;
          slot.landformCoverage = pageCovered(index, slot) ? null : Float64Array.from(index.coverage);
        }
        await Promise.resolve();
        for (const slot of resident) slot.generationSubmitted = false;
        return resident;
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    occlusionBake: {
      bake: async (slots) => {
        for (const slot of slots) {
          if (slot.lifecycle.state === "resident") residentChannelBakes.push(slot);
        }
        return slots;
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    splatBake: {
      bake: async (slots) => slots,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    pyramid: existingPyramid ?? {
      recenter: async () => undefined,
      isResident: true,
      dispose: () => undefined,
    },
  });
  return { factory, refreshBatches, residentChannelBakes };
}

async function pump(
  system: TerrainClipmapSystem,
  frames: number,
  observer: { x: number; y: number; z: number; velocityX: number; velocityZ: number },
  startFrame: number,
): Promise<number> {
  for (let frame = 0; frame < frames; frame += 1) {
    system.update(observer, startFrame + frame);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  }
  return startFrame + frames;
}

describe("landform refresh of partly covered terrain pages", () => {
  it("is due only when the page's part near the observer leaves the coverage it was baked with", () => {
    const root = createWorldPageAddress(9, 0, 0); // 0..262 km
    const baked = Float64Array.of(-72_000, -72_000, 72_000, 72_000);
    const moved = Float64Array.of(-32_000, -72_000, 112_000, 72_000);
    // At the bake position the page's near part (within 50 km) is inside.
    expect(terrainLandformRefreshDue(root, baked, baked, 0, 0)).toBe(false);
    // 40 km on, the near part reaches 90 km: outside the old coverage, inside the new.
    expect(terrainLandformRefreshDue(root, baked, moved, 40_000, 0)).toBe(true);
    // But not when the current index cannot do better either.
    expect(terrainLandformRefreshDue(root, baked, baked, 40_000, 0)).toBe(false);
    // A page wholly beyond reach needs nothing.
    const far = createWorldPageAddress(6, 4, 0); // 131-164 km
    expect(terrainLandformRefreshDue(far, baked, moved, 40_000, 0)).toBe(false);
    // The margin the bake samples counts: a page whose edge sits on the coverage edge is due.
    const edge = createWorldPageAddress(6, 2, 0); // 65.5-98.3 km
    const reaching = Float64Array.of(-200_000, -200_000, 98_304, 200_000);
    expect(terrainLandformRefreshDue(edge, reaching, Float64Array.of(-1e6, -1e6, 1e6, 1e6), 60_000, 0))
      .toBe(true);
  });

  it("refreshes coarse pages in place as the observer flies, then their channel pages, and settles", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("landform-refresh", { worldEvolution: "analytic" });
    const index = new FakeIndex(0, 0);
    const recording = recordingFactory(index);
    const system = new TerrainClipmapSystem(scene, world, resolveWebGpuQualityProfile("medium", "balanced"), {
      computeFactory: recording.factory,
      landformIndex: index,
    });
    try {
      expect(system.landformData).toBe(index);
      const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
      let frame = await pump(system, 40, observer, 1);
      const resident = () => system.atlases.height.residency.entries
        .filter((slot) => slot.lifecycle.state === "resident");
      const partial = resident().filter((slot) => slot.landformCoverage !== null);
      expect(partial.length, "coarse pages baked with part of the index").toBeGreaterThan(0);
      expect(partial.every((slot) => slot.address.level >= 5)).toBe(true);
      // Nothing is stale where the pages were baked.
      expect(recording.refreshBatches).toEqual([]);

      // Fly 40 km east; the index follows.
      observer.x = 40_000;
      index.centre(40_000, 0);
      frame = await pump(system, 60, observer, frame);
      const refreshed = recording.refreshBatches.flat();
      expect(refreshed.length).toBeGreaterThan(0);
      for (const batch of recording.refreshBatches) {
        expect(batch.length).toBeLessThanOrEqual(TERRAIN_LANDFORM_REFRESH.maxPagesPerFrame);
      }
      for (const slot of refreshed) {
        expect(slot.address.level).toBeGreaterThan(0);
        expect(slot.lifecycle.state, "refreshed in place").toBe("resident");
      }
      // Nothing near the observer is left stale.
      for (const slot of resident()) {
        if (!slot.landformCoverage) continue;
        expect(terrainLandformRefreshDue(slot.address, slot.landformCoverage, index.coverage, 40_000, 0))
          .toBe(false);
      }
      // Each refreshed page's channel page was re-baked in place.
      const rebaked = new Set(recording.residentChannelBakes.map((slot) => slot.keyString));
      const owed = refreshed
        .filter((slot) => system.atlases.channel.residency.get(slot.key)?.lifecycle.state === "resident")
        .map((slot) => slot.keyString);
      expect(owed.length).toBeGreaterThan(0);
      for (const key of owed) expect(rebaked.has(key), key).toBe(true);

      // Settled: holding still refreshes nothing more.
      const batches = recording.refreshBatches.length;
      const channelBakes = recording.residentChannelBakes.length;
      await pump(system, 30, observer, frame);
      expect(recording.refreshBatches.length).toBe(batches);
      expect(recording.residentChannelBakes.length).toBe(channelBakes);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("refreshes nothing while the index is building", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("landform-refresh", { worldEvolution: "analytic" });
    const index = new FakeIndex(0, 0);
    const recording = recordingFactory(index);
    const system = new TerrainClipmapSystem(scene, world, resolveWebGpuQualityProfile("medium", "balanced"), {
      computeFactory: recording.factory,
      landformIndex: index,
    });
    try {
      const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
      let frame = await pump(system, 40, observer, 1);
      observer.x = 40_000;
      index.centre(40_000, 0);
      index.building = true;
      frame = await pump(system, 30, observer, frame);
      expect(recording.refreshBatches).toEqual([]);
      index.building = false;
      await pump(system, 30, observer, frame);
      expect(recording.refreshBatches.length).toBeGreaterThan(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
