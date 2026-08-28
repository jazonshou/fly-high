import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { inspectWebGpuCapabilities } from "../../src/render/webgpu/core/Capabilities";
import { COMPUTE_DISPATCH_SEED_COST_MS } from "../../src/render/webgpu/core/ComputeBudget";
import { resolveWebGpuQualityProfile } from "../../src/render/webgpu/core/QualityProfile";
import { GlobalHeightPyramid } from "../../src/render/webgpu/terrain/GlobalHeightPyramid";
import {
  PageOcclusionBake,
  PageSplatBake,
} from "../../src/render/webgpu/terrain/PageOcclusionBake";
import {
  TERRAIN_CHANNEL_TEXTURE_COUNT,
  TerrainPageAtlas,
  TerrainPageGenerator,
  invariantSlotKey,
  type TerrainAtlasSlot,
} from "../../src/render/webgpu/terrain/TerrainPageAtlas";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";

/**
 * `4.5-B2(a)` — what one terrain compute dispatch actually costs, measured.
 *
 * The meter used to seed every client's PER-DISPATCH estimate at its whole
 * per-frame budget ROW, on the reasoning that the budget table is the best
 * estimate available before a measurement exists. It is not: a row is what a
 * client may spend across a frame and an estimate is what one page costs, and
 * the difference between them was the whole of the admission-starvation
 * defect. `COMPUTE_DISPATCH_SEED_COST_MS` replaces the rows with these
 * numbers, and this test is what stops them becoming folklore — it re-measures
 * on the reference adapter and fails when a pinned seed drifts more than 4x.
 * Four, not the 3x assertion 113 holds the RUNNING estimate to: a running
 * estimate is smoothed over many batches, whereas a single compute pass's
 * timestamp counter is genuinely noisy at these durations.
 *
 * Measured through `timestamp-query`, which is the same counter the live meter
 * consumes — a wall clock cannot be used here: `bake()` awaits
 * `dispatchWhenReady`, which resolves once the dispatch is ENCODED, so the
 * wall clock reads 4 microseconds for a bake that really costs milliseconds.
 * The one dispatch whose wall clock does mean something is page generation,
 * and only because it awaits a readback — which is exactly the serialisation
 * `4.5-B1` measures separately.
 */

const SEED_HASH = hashSeed("terrain-compute-cost");
const SLOTS = 16;
/**
 * Repeats per client. The MEDIAN of these is what is compared, not the mean:
 * a compute pass's timestamp counter is noisy for a short dispatch — the splat
 * bake has been observed between 0.10 and 0.39 ms/page across runs on the same
 * adapter — and one stray low sample would otherwise fail a pinned seed that
 * has not moved.
 */
const REPEATS = 15;
const BATCH = 4;

async function withScene<T>(run: (engine: WebGPUEngine, scene: Scene) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
    deviceDescriptor: { requiredFeatures: ["timestamp-query"] as GPUFeatureName[] },
  });
  let scene: Scene | null = null;
  try {
    await engine.initAsync();
    // Babylon silently DROPS an unsupported entry from
    // `deviceDescriptor.requiredFeatures` rather than letting `requestDevice`
    // reject, so the constructor above is not proof the counter exists. The
    // caller has already refused to run without adapter support; if the device
    // still came up without it, fail loudly instead of measuring zeros.
    if (!engine.enabledExtensions.includes("timestamp-query")) {
      throw new Error(
        "The adapter advertises timestamp-query but the device did not enable it; "
        + "every dispatch timing below would read as an unmeasured zero",
      );
    }
    engine.enableGPUTimingMeasurements = true;
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

describe("terrain compute dispatch cost (4.5-B2a)", () => {
  it("measures each client's per-page cost and holds the pinned seeds", async (context) => {
    // `timestamp-query` is OPTIONAL in WebGPU and a virtualised adapter need
    // not expose it — GitHub's hosted macOS runners are the case that found
    // this. Because Babylon filters the unsupported feature out of the device
    // descriptor instead of failing, the engine comes up without the counter,
    // `enableGPUTimingMeasurements` logs "Could not create a
    // WebGPUDurationMeasure", every sample stays null, and `time()` falls
    // through to its empty-sample 0 — which was then compared against the
    // pinned seeds as though a GPU had produced it.
    //
    // Gate on the ADAPTER's own answer, never on a zero reading. An adapter
    // that CAN time a dispatch and suddenly measures nothing is precisely the
    // regression these assertions exist to catch, and must keep failing here.
    const capability = await inspectWebGpuCapabilities();
    if (!capability.features.has("timestamp-query")) {
      context.skip(
        "this adapter exposes no timestamp-query, so there is no per-dispatch "
        + "counter to read; the pinned seeds stay unverified on this host",
      );
    }
    const measured = await withScene(async (engine, scene) => {
      const base = resolveWebGpuQualityProfile("medium", "balanced");
      const profile = { ...base, heightAtlasSlots: SLOTS, channelAtlasSlots: SLOTS };
      const heightAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "height",
        worldRevision: "compute-cost",
      });
      const channelAtlas = new TerrainPageAtlas(scene, profile, {
        kind: "channel",
        worldRevision: "compute-cost",
        textureCount: TERRAIN_CHANNEL_TEXTURE_COUNT,
      });
      const generator = new TerrainPageGenerator(engine, heightAtlas, SEED_HASH, null);
      const pyramid = new GlobalHeightPyramid(scene, engine, SEED_HASH);
      const occlusion = new PageOcclusionBake(engine, heightAtlas, channelAtlas, pyramid);
      const splat = new PageSplatBake(engine, heightAtlas, channelAtlas, SEED_HASH, 0, 45, null);

      await pyramid.recenter(0, 0);

      const heightSlots: TerrainAtlasSlot[] = [];
      const channelSlots: TerrainAtlasSlot[] = [];
      for (let index = 0; index < BATCH; index += 1) {
        const address = createWorldPageAddress(3, index, 0);
        const key = invariantSlotKey(address);
        heightSlots.push(heightAtlas.residency.request(key, address)!.slot);
        channelSlots.push(channelAtlas.residency.request(key, address)!.slot);
      }

      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));

      const time = async (
        run: () => Promise<unknown>,
        consume: () => number | null,
      ): Promise<number> => {
        // One warm run first: the first dispatch pays synchronous pipeline
        // creation, which `4.5-C2(a)` pre-warms in the renderer and which must
        // not be averaged into a steady-state per-page cost.
        await run();
        await nextFrame();
        consume();
        const samples: number[] = [];
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
          await run();
          // The timestamp resolves asynchronously, a frame or more later.
          for (let wait = 0; wait < 8; wait += 1) {
            await nextFrame();
            const sample = consume();
            if (sample !== null) {
              samples.push(sample);
              break;
            }
          }
        }
        if (samples.length === 0) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      };

      const terrainCompute = await time(
        () => generator.generate(heightSlots),
        () => generator.consumeMeasuredDispatchCostMs());
      const occlusionCompute = await time(
        () => occlusion.bake(channelSlots),
        () => occlusion.consumeMeasuredDispatchCostMs());
      const splatCompute = await time(
        () => splat.bake(channelSlots, 171),
        () => splat.consumeMeasuredDispatchCostMs());

      generator.dispose();
      occlusion.dispose();
      splat.dispose();
      pyramid.dispose();
      heightAtlas.dispose();
      channelAtlas.dispose();
      return { terrainCompute, occlusionCompute, splatCompute };
    });

    console.log(
      "measured per-page dispatch cost (ms):",
      JSON.stringify(measured, (_, value) =>
        typeof value === "number" ? Math.round(value * 1_000) / 1_000 : value),
    );

    for (const client of ["terrainCompute", "occlusionCompute", "splatCompute"] as const) {
      const pinned = COMPUTE_DISPATCH_SEED_COST_MS[client];
      expect(measured[client], `${client} measured`).toBeGreaterThan(0);
      expect(measured[client], `${client} drifted below the pinned seed / 4`)
        .toBeGreaterThan(pinned / 4);
      expect(measured[client], `${client} drifted above the pinned seed x 4`)
        .toBeLessThan(pinned * 4);
    }
  }, 180_000);
});
