import { describe, expect, it } from "vitest";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { inspectWebGpuCapabilities } from "../../src/render/webgpu/core/Capabilities";
import { COMPUTE_DISPATCH_SEED_COST_MS } from "../../src/render/webgpu/core/ComputeBudget";
import { installDeferredPassTiming } from "../../src/render/webgpu/core/DeferredPassTiming";
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
import { seasonBucketBlend } from "../../src/render/webgpu/terrain/TerrainSpineContract";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import { hashSeed } from "../../src/world/seed";
import { logPricingSample, pricingRun } from "../support/pricingRun";

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
    // Each pass's own time, not the slot's previous occupant (DeferredPassTiming.ts).
    if (!installDeferredPassTiming(engine)) throw new Error("per-pass timing could not be installed");
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

/**
 * An UPPER bound on a dispatch cost is a statement about a quiet, pinned host:
 * a run that shares the GPU can only read high. Keyed on the same variable as
 * cold start's deadline and the perf capture's floors. Unset (the default, and
 * CI's pinned job) it asserts; set, it reports the figure and the bound it
 * would have applied, loudly, and passes. Lower bounds and "was anything
 * measured at all" are not load-sensitive and stay asserted either way.
 */
const ENFORCE_REFERENCE_HOST_COST = import.meta.env.VITE_PERF_UNPINNED_HOST !== "1";

function upperBound(measuredMs: number, boundMs: number, what: string): void {
  if (ENFORCE_REFERENCE_HOST_COST) {
    expect(measuredMs, `${what}: ${measuredMs.toFixed(4)} ms`).toBeLessThan(boundMs);
    return;
  }
  console.warn(
    `COMPUTE COST reported only: VITE_PERF_UNPINNED_HOST=1; ${what}: `
      + `measured ${measuredMs.toFixed(4)} ms, bound ${boundMs.toFixed(4)} ms: `
      + (measuredMs < boundMs ? "within it" : "EXCEEDED, and would FAIL on the reference host"),
  );
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
    // A pricing run refuses to measure without its idle gap (see pricingRun.ts).
    const pricing = pricingRun();
    if (pricing) console.log(`PRICING run: ${pricing.idleGapMs} ms idle before it`);
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
      const splat = new PageSplatBake(
        engine, heightAtlas, channelAtlas, SEED_HASH, SEED_HASH, 0, 45, null);

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

      // Pricing runs log each sample beside the dispatch that produced it, so a
      // bimodal figure can be told apart: different inputs mean the price's
      // unit is wrong, identical inputs mean the modes are external.
      const lastDispatch = new Map<string, readonly number[]>();
      const watch = (name: string, owner: unknown) => {
        const shader = (owner as { shader: { dispatchWhenReady(...args: number[]): Promise<void> } | null }).shader;
        if (!shader) return;
        const dispatch = shader.dispatchWhenReady.bind(shader);
        shader.dispatchWhenReady = (...args: number[]) => {
          lastDispatch.set(name, args);
          return dispatch(...args);
        };
      };
      const time = async (
        run: () => Promise<unknown>,
        consume: () => number | null,
        name = "",
        inputs: () => Readonly<Record<string, unknown>> = () => ({}),
        owner: unknown = null,
      ): Promise<number> => {
        // One warm run first: the first dispatch pays synchronous pipeline
        // creation, which `4.5-C2(a)` pre-warms in the renderer and which must
        // not be averaged into a steady-state per-page cost.
        await run();
        await nextFrame();
        consume();
        // The shader exists from the first dispatch on: watch it from here.
        if (pricing && owner) watch(name, owner);
        const samples: number[] = [];
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
          await run();
          // The timestamp resolves asynchronously, a frame or more later.
          for (let wait = 0; wait < 8; wait += 1) {
            await nextFrame();
            const sample = consume();
            if (sample !== null) {
              if (pricing) {
                logPricingSample(name, samples.length, sample, {
                  dispatch: lastDispatch.get(name) ?? null,
                  ...inputs(),
                });
              }
              samples.push(sample);
              break;
            }
          }
        }
        if (samples.length === 0) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      };

      const levels = (slots: readonly TerrainAtlasSlot[]) => slots.map((slot) => slot.address.level);
      const terrainCompute = await time(
        () => generator.generate(heightSlots),
        () => generator.consumeMeasuredDispatchCostMs(),
        "terrainCompute",
        () => ({ levels: levels(heightSlots) }),
        generator);
      const occlusionCompute = await time(
        () => occlusion.bake(channelSlots),
        () => occlusion.consumeMeasuredDispatchCostMs(),
        "occlusionCompute",
        () => ({ levels: levels(channelSlots) }),
        occlusion);
      const splatCompute = await time(
        () => splat.bake(channelSlots, 171),
        () => splat.consumeMeasuredDispatchCostMs(),
        "splatCompute",
        () => ({ levels: levels(channelSlots), dayOfYear: 171, season: seasonBucketBlend(171) }),
        splat);

      // The splat bake's COARSE path. From a 64 m channel texel up every
      // supersample tap samples its own canopy (the level-3 batch above never
      // takes that branch: 32 m texels). Level 5 is 128 m. Its height pages are
      // generated first, because the bake reads them.
      const coarseHeightSlots: TerrainAtlasSlot[] = [];
      const coarseChannelSlots: TerrainAtlasSlot[] = [];
      for (let index = 0; index < BATCH; index += 1) {
        const address = createWorldPageAddress(5, index, 0);
        const key = invariantSlotKey(address);
        coarseHeightSlots.push(heightAtlas.residency.request(key, address)!.slot);
        coarseChannelSlots.push(channelAtlas.residency.request(key, address)!.slot);
      }
      await generator.generate(coarseHeightSlots);
      await nextFrame();
      generator.consumeMeasuredDispatchCostMs();
      const splatComputeCoarse = await time(
        () => splat.bake(coarseChannelSlots, 171),
        () => splat.consumeMeasuredDispatchCostMs(),
        "splatCompute",
        () => ({ levels: levels(coarseChannelSlots), dayOfYear: 171, season: seasonBucketBlend(171) }),
        splat);

      generator.dispose();
      occlusion.dispose();
      splat.dispose();
      pyramid.dispose();
      heightAtlas.dispose();
      channelAtlas.dispose();
      return { terrainCompute, occlusionCompute, splatCompute, splatComputeCoarse };
    });

    console.log(
      "measured per-page dispatch cost (ms):",
      JSON.stringify(measured, (_, value) =>
        typeof value === "number" ? Math.round(value * 1_000) / 1_000 : value),
    );

    // A coarse page's splat bake, where every tap samples its own canopy. Bound
    // on the ABSOLUTE figure, not on coarse / fine: a short dispatch times
    // noisily and the fine denominator wanders (0.19-0.33 ms across four runs
    // of one tree in a quiet window, 2026-09-20), so a ratio fails on noise.
    // Priced in that window with the taps each recomputing their moisture
    // chain: 0.79-0.96 ms per page against 0.44-0.61 with the taps off. What
    // the bounds guard is the whole-compute cap: a channel slot's two bakes are
    // ONE admission, so coarse splat + occlusion has to stay under it, and a
    // 4x4 tap grid (~6x the fine bake) would not.
    console.log(
      `splat bake, coarse page: ${measured.splatComputeCoarse.toFixed(3)} ms `
      + `(fine ${measured.splatCompute.toFixed(3)} ms); `
      + `channel pair ${(measured.splatComputeCoarse + measured.occlusionCompute).toFixed(3)} ms`);
    expect(measured.splatComputeCoarse, "coarse splat bake measured").toBeGreaterThan(0);
    upperBound(measured.splatComputeCoarse, 1.2, "a coarse page's splat bake");
    upperBound(measured.splatComputeCoarse + measured.occlusionCompute, 1.55,
      "a coarse channel pair against the 1.55 ms whole-compute cap");

    for (const client of ["terrainCompute", "occlusionCompute", "splatCompute"] as const) {
      const pinned = COMPUTE_DISPATCH_SEED_COST_MS[client];
      expect(measured[client], `${client} measured`).toBeGreaterThan(0);
      expect(measured[client], `${client} drifted below the pinned seed / 4`)
        .toBeGreaterThan(pinned / 4);
      upperBound(measured[client], pinned * 4, `${client} against the pinned seed x 4`);
    }
  }, 180_000);
});
