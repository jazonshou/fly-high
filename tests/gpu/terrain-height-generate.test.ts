import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import {
  TerrainPageAtlas,
  TerrainPageGenerator,
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  decodeOrderableFloat,
  encodeOrderableFloat,
  invariantSlotKey,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import type { TerrainPageErosionExecutor } from "../../src/render/webgpu/terrain/TerrainPageErosionClient";
import type { TerrainErodedPage } from "../../src/render/webgpu/terrain/TerrainPageErosion";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_PAGE_HYDROLOGY_ENCODING,
  type TerrainMacroEvolutionExport,
} from "../../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  TERRAIN_HEIGHT_PARITY_CRITERIA,
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_SLOT_EDGE,
  terrainSupersampleOffsets,
  terrainTexelSizeMeters,
} from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_HEIGHT_CORE,
} from "../../src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  createWorldPageKey,
} from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";
import { sampleNaturalTerrainHeight } from "../../src/world/terrain";
import { createWorld } from "../../src/world";

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
      // Phase 5: dispatch submission is tracked without exposing the slot.
      // Bounds, erosion stages, and collision publication form one atomic DAG.
      expect(request.slot.generationSubmitted).toBe(true);
      expect(atlas.residency.slotIndexOf(request.slot.key)).toBe(-1);
      expect(request.slot.lifecycle.state).toBe("generating");
      // The page becomes fully resident only once that readback resolves —
      // the asynchronous half of WorldPageLifecycle, exercised for real.
      await generator.settle();
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
      // Submitted together, but unavailable until the final DAG publication.
      expect(slots.every((slot) => slot.generationSubmitted)).toBe(true);
      await generator.settle();
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

  it("4.5-B1: overlapping batches each read their OWN bounds", async () => {
    // The bug the bounds-buffer ring exists to stop, and it was SILENT.
    // `generate()` awaits `dispatchWhenReady` before issuing the readback, so
    // the copy that snapshots the bounds is encoded a microtask later — into
    // the NEXT frame's command encoder. With one shared buffer the next
    // batch's `update()` had already re-seeded the atomics, so the copy read
    // the identities back: min `+Infinity`, max `-Infinity`, deviation 0. A
    // page then completed at ZERO deviation, the CDLOD selector saw zero
    // error, and the world converged at the root ring with nothing to split —
    // measured as 27 nodes and 9 pages through the real renderer.
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const stats = await withScene(async (engine, scene) => {
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "gpu-test",
      });
      const generator = new TerrainPageGenerator(engine, atlas, SEED_HASH);
      atlas.residency.beginFrame(1);
      const collected: { min: number; max: number; deviation: number }[] = [];
      const slots = [];
      // Three batches issued back to back WITHOUT awaiting any readback, which
      // is exactly what the pump does now that the gate is gone.
      for (let batch = 0; batch < 3; batch += 1) {
        const address = createWorldPageAddress(4, batch, 7);
        const slot = atlas.residency.request(invariantSlotKey(address), address)!.slot;
        slots.push(slot);
        await generator.generate([slot]);
      }
      await generator.settle();
      for (const slot of slots) {
        collected.push({
          min: slot.stats.minHeightMeters,
          max: slot.stats.maxHeightMeters,
          deviation: slot.stats.maxDeviationFromParent,
        });
      }
      generator.dispose();
      atlas.dispose();
      return collected;
    });
    for (const entry of stats) {
      expect(Number.isFinite(entry.min), `min ${entry.min} is an atomic identity`).toBe(true);
      expect(Number.isFinite(entry.max), `max ${entry.max} is an atomic identity`).toBe(true);
      expect(entry.max).toBeGreaterThan(entry.min);
      expect(entry.deviation, "a page completed at zero deviation").toBeGreaterThan(0);
    }
  }, 180_000);

  it("keeps the height core inside the page geometry it was derived from", () => {
    expect(TERRAIN_HEIGHT_SLOT_EDGE).toBe(WORLD_PAGE_HEIGHT_CORE + WORLD_PAGE_GUTTER * 2);
    expect(TERRAIN_HEIGHT_SLOT_EDGE % 8).toBe(0);
  });

  it("5D uploads worker-eroded bytes and publishes L0 collision before residency", async () => {
    const world = createWorld("eroded-runtime-gpu", {
      airport: false,
      worldEvolution: "eroded",
    });
    const address = createWorldPageAddress(0, 1, -1);
    const macro: TerrainMacroEvolutionExport = {
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: world.seed, deviceFingerprint: "gpu-fixture" },
      seaLevelMeters: world.seaLevel,
      heightMeters: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      flowAccumulationAreaM2: new Float32Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakeMask: new Uint8Array(EVOLUTION_DOMAIN_SAMPLE_COUNT),
      lakes: [],
      drainageBaseLevels: [],
      channelSeedTexelIndices: new Uint32Array(0),
    };
    const storedHeight = new Float32Array(TERRAIN_HEIGHT_SLOT_EDGE ** 2);
    for (let row = 0; row < TERRAIN_HEIGHT_SLOT_EDGE; row += 1) {
      for (let column = 0; column < TERRAIN_HEIGHT_SLOT_EDGE; column += 1) {
        storedHeight[row * TERRAIN_HEIGHT_SLOT_EDGE + column] = 900 + row * 0.5 + column * 0.25;
      }
    }
    const auxCount = TERRAIN_CHANNEL_SLOT_EDGE ** 2;
    const shoreDistance = new Int16Array(auxCount).fill(-4);
    const flowAccum = new Uint16Array(auxCount).fill(1_234);
    const lakeDepth = new Uint16Array(auxCount).fill(250);
    const soilDepth = new Uint8Array(auxCount).fill(180);
    const erodedPage: TerrainErodedPage = {
      address,
      coreSize: WORLD_PAGE_HEIGHT_CORE,
      haloTexels: 64,
      scratchEdge: 384,
      storedEdge: TERRAIN_HEIGHT_SLOT_EDGE,
      storedHeight,
      stats: {
        minHeightMeters: storedHeight[0]!,
        maxHeightMeters: storedHeight.at(-1)!,
        maxDeviationFromParent: 0.125,
      },
      protectedSampleCount: 0,
      hydrology: {
        pageKey: createWorldPageKey(address),
        address,
        coreSize: WORLD_PAGE_CHANNEL_CORE,
        gutter: WORLD_PAGE_GUTTER,
        storedEdge: TERRAIN_CHANNEL_SLOT_EDGE,
        texelSizeMeters: 4,
        hydrology: {
          format: "r16uint-log-flow+r16uint-lake-depth+r8unorm-soil+r16sint-shore-v2",
          flowAccum,
          lakeDepth,
          soilDepth,
          shoreDistance,
          ...TERRAIN_PAGE_HYDROLOGY_ENCODING,
        },
        upload: {
          flowAccumR16Float: new Uint16Array(auxCount).fill(0x3c00),
          lakeDepthR16Float: new Uint16Array(auxCount).fill(0x4100),
          soilDepthR8Unorm: soilDepth,
          shoreDistanceR16Sint: shoreDistance,
        },
      },
    };
    let installedMacro: Readonly<TerrainMacroEvolutionExport> | null = null;
    let disposed = false;
    const executor: TerrainPageErosionExecutor = {
      setMacroEvolution: (value) => { installedMacro = value; },
      generate: async (requested) => {
        expect(installedMacro).toBe(macro);
        expect(requested).toEqual(address);
        return erodedPage;
      },
      dispose: () => { disposed = true; },
    };
    const publication = await withScene(async (engine, scene) => {
      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const atlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "eroded-runtime",
      });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel",
        worldRevision: "eroded-runtime",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
        requiresHydrology: true,
      });
      const generator = new TerrainPageGenerator(
        engine,
        atlas,
        world.seedHash,
        world.airport,
        { world, erosionExecutor: executor, channelAtlas },
      );
      atlas.residency.beginFrame(1);
      channelAtlas.residency.beginFrame(1);
      const slot = atlas.residency.request(invariantSlotKey(address), address)!.slot;
      const channelSlot = channelAtlas.residency.request(
        invariantSlotKey(address),
        address,
      )!.slot;
      let stateAtPublication = "";
      let auxHeightStateAtPublication = "";
      let auxChannelStateAtPublication = "";
      let publishedShore: Int16Array | null = null;
      let collision: Float32Array | null = null;
      generator.setCollisionPagePublisher((page) => {
        stateAtPublication = slot.lifecycle.state;
        collision = page.heights;
      });
      generator.setAuxPagePublisher((page) => {
        auxHeightStateAtPublication = slot.lifecycle.state;
        auxChannelStateAtPublication = channelSlot.lifecycle.state;
        publishedShore = page.shoreDistanceR16Sint;
      });

      expect(channelAtlas.residency.complete(
        channelSlot.key,
        channelSlot.token!,
        channelSlot.stats,
      )).toBe(false);

      // No macro means no worker request and no accidental analytic fallback.
      await generator.generate([slot]);
      expect(slot.generationSubmitted).toBe(false);
      expect(slot.lifecycle.state).toBe("generating");
      generator.setMacroEvolution(macro);
      await generator.generate([slot]);
      expect(slot.generationSubmitted).toBe(true);
      expect(slot.lifecycle.state).toBe("generating");
      await generator.settle();
      expect(channelSlot.hydrologyReady).toBe(true);
      expect(channelAtlas.residency.complete(
        channelSlot.key,
        channelSlot.token!,
        channelSlot.stats,
      )).toBe(true);

      const result: {
        stateAtPublication: string;
        finalState: string;
        collision: Float32Array | null;
        auxHeightStateAtPublication: string;
        auxChannelStateAtPublication: string;
        publishedShore: Int16Array | null;
        channelState: string;
        stats: typeof slot.stats;
      } = {
        stateAtPublication,
        finalState: slot.lifecycle.state,
        collision,
        auxHeightStateAtPublication,
        auxChannelStateAtPublication,
        publishedShore,
        channelState: channelSlot.lifecycle.state,
        stats: slot.stats,
      };
      generator.dispose();
      atlas.dispose();
      channelAtlas.dispose();
      return result;
    });

    expect(publication.stateAtPublication).toBe("generating");
    expect(publication.finalState).toBe("resident");
    expect(publication.auxHeightStateAtPublication).toBe("resident");
    expect(publication.auxChannelStateAtPublication).toBe("generating");
    expect(publication.channelState).toBe("resident");
    expect(publication.publishedShore).toBe(shoreDistance);
    expect(publication.stats).toEqual(erodedPage.stats);
    expect(publication.collision).not.toBeNull();
    expect(publication.collision![0]).toBe(
      storedHeight[WORLD_PAGE_GUTTER * TERRAIN_HEIGHT_SLOT_EDGE + WORLD_PAGE_GUTTER],
    );
    expect(publication.collision!.at(-1)).toBe(
      storedHeight[
        (WORLD_PAGE_GUTTER + WORLD_PAGE_HEIGHT_CORE - 1) * TERRAIN_HEIGHT_SLOT_EDGE
        + WORLD_PAGE_GUTTER + WORLD_PAGE_HEIGHT_CORE - 1
      ],
    );
    expect(disposed).toBe(true);
  }, 180_000);
});
