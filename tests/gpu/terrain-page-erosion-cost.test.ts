import { describe, expect, it } from "vitest";
import { inspectWebGpuCapabilities } from "../../src/render/webgpu/core/Capabilities";
import { COMPUTE_DISPATCH_SEED_COST_MS } from "../../src/render/webgpu/core/ComputeBudget";
import { TERRAIN_EROSION_STAGE_SEED_COST_MS } from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
import { createWorldPageAddress } from "../../src/render/webgpu/world/pageKey";
import {
  buildHarness,
  gpuTimingAvailable,
  nextFrame,
  runPage,
  withScene,
} from "./terrainPageErosionGpuHarness";

/**
 * `W-1d`: what one dispatch of the multi-frame page-erosion DAG actually
 * costs, measured — the `4.5-B2(a)` doctrine applied per STAGE.
 *
 * Production ships with GPU timing OFF (a diagnostic capture is the only way
 * to turn it on), so these constants ARE the admission prices the meter uses
 * for the whole of a normal session; the running estimate only ever refines
 * them on a capture run. That is what makes them load-bearing rather than
 * documentation, and what this test exists to keep honest at a 4x drift alarm.
 *
 * Its own file because the measurement needs a device created WITH
 * `timestamp-query`, and a browser page that has already built and disposed
 * several WebGPU devices does not reliably get one — see the harness note.
 */

describe("terrain page erosion GPU dispatch cost (W-1d)", () => {
  it("measures each DAG stage's per-dispatch cost and holds the pinned seeds", async (context) => {
    const capability = await inspectWebGpuCapabilities();
    if (!capability.features.has("timestamp-query")) {
      context.skip(
        "this adapter exposes no timestamp-query, so there is no per-dispatch "
        + "counter to read; the pinned stage seeds stay unverified on this host",
      );
    }
    const measured = await withScene(async (engine, scene) => {
      // A page that has already built and disposed a dozen WebGPU devices does
      // not reliably get `timestamp-query` back, and Babylon drops the request
      // silently rather than failing. Report it rather than measuring zeros.
      if (!gpuTimingAvailable(engine)) return null;
      const harness = buildHarness(engine, scene);
      try {
        const address = createWorldPageAddress(3, -3, 5);
        // One warm page pays pipeline creation; the measurement is the second.
        const warm = await runPage(harness, address, 4);
        harness.producer.consumeStageMeasurements();
        // MINIMUM of three timed pages, per stage — not one measurement.
        //
        // Contention can only ever make a dispatch look SLOWER (another
        // process taking the GPU, a thermal step, a browser doing layout), so
        // the minimum is the robust estimator for "what this costs when the
        // machine is not fighting us", and a genuine regression still moves it.
        // A single sample made this alarm fire three times across separate
        // sessions on a busy host — measured 0.993-1.392 ms for `breach` under
        // load against 0.063-0.065 ms quiet, a 20x spread that says nothing
        // about the code. The 4x alarm below stays exactly as tight.
        //
        // The SEED constants are deliberately NOT re-pinned to this minimum.
        // They serve a different purpose: ComputeBudget admits work in a live
        // frame where contention is real, so a seed set to the best case would
        // under-price every dispatch and over-admit. The seed wants a typical
        // cost; the regression alarm wants a stable one. Same number, two jobs,
        // so only the alarm's estimator changed here.
        let timed = await runPage(harness, address, 4);
        const first = harness.producer.consumeStageMeasurements();
        const samples: Record<string, { milliseconds: number; dispatches: number }> = {};
        for (const [stage, sample] of Object.entries(first)) {
          samples[stage] = { milliseconds: sample.milliseconds, dispatches: sample.dispatches };
        }
        for (let repeat = 0; repeat < 2; repeat += 1) {
          timed = await runPage(harness, address, 4);
          for (const [stage, sample] of Object.entries(
            harness.producer.consumeStageMeasurements(),
          )) {
            const best = samples[stage];
            if (best && sample.milliseconds < best.milliseconds) {
              best.milliseconds = sample.milliseconds;
              best.dispatches = sample.dispatches;
            }
          }
        }
        // The last dispatches' counters resolve a frame or more later.
        for (let wait = 0; wait < 12; wait += 1) {
          harness.producer.consumeMeasuredDispatchCostMs();
          await nextFrame();
        }
        return {
          samples: samples as ReturnType<typeof harness.producer.consumeStageMeasurements>,
          warmFrames: warm.frames,
          timedFrames: timed.frames,
          totalMilliseconds: harness.producer.lastCompletedPageTiming?.totalMilliseconds ?? 0,
          dispatches: harness.producer.lastCompletedPageTiming?.dispatches ?? 0,
        };
      } finally {
        harness.dispose();
      }
    }, true);
    if (!measured) {
      context.skip(
        "this device did not grant timestamp-query (it is granted to the first "
        + "few devices a page creates, and this file is far down the suite); run "
        + "`npx vitest run --config vitest.gpu.config.ts "
        + "tests/gpu/terrain-page-erosion-cost.test.ts` to re-measure the seeds",
      );
      return;
    }
    const perDispatch = Object.fromEntries(
      Object.entries(measured.samples).map(([stage, sample]) => [
        stage,
        sample.dispatches > 0 ? sample.milliseconds / sample.dispatches : 0,
      ]),
    ) as Record<keyof typeof TERRAIN_EROSION_STAGE_SEED_COST_MS, number>;
    const stageTotals = Object.fromEntries(
      Object.entries(measured.samples).map(([stage, sample]) => [stage, sample.milliseconds]),
    );
    console.log(
      "W-1d per-dispatch stage cost (ms):",
      JSON.stringify(perDispatch, (_, value) =>
        typeof value === "number" ? Math.round(value * 10_000) / 10_000 : value),
      "| whole-page stage totals (ms):",
      JSON.stringify(stageTotals, (_, value) =>
        typeof value === "number" ? Math.round(value * 100) / 100 : value),
      "| dispatches:",
      measured.dispatches,
      "| frames at 4 dispatches/pump:",
      measured.timedFrames,
      "| wall ms:",
      Math.round(measured.totalMilliseconds),
    );
    // The client-level seed is what the meter starts every session at, before
    // the producer's first per-stage submit: the average dispatch of a whole
    // page's mix.
    const totalMilliseconds = Object.values(measured.samples)
      .reduce((sum, sample) => sum + sample.milliseconds, 0);
    const totalDispatches = Object.values(measured.samples)
      .reduce((sum, sample) => sum + sample.dispatches, 0);
    const averageDispatchMs = totalMilliseconds / totalDispatches;
    console.log(
      "W-1d whole-page GPU cost:",
      Math.round(totalMilliseconds * 100) / 100,
      "ms over",
      totalDispatches,
      "dispatches; average",
      Math.round(averageDispatchMs * 10_000) / 10_000,
      "ms/dispatch vs the pinned",
      COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute,
    );
    expect(averageDispatchMs, "the erosionCompute seed drifted below a quarter")
      .toBeGreaterThan(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute / 4);
    expect(averageDispatchMs, "the erosionCompute seed drifted above 4x")
      .toBeLessThan(COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute * 4);

    for (const [stage, pinned] of Object.entries(TERRAIN_EROSION_STAGE_SEED_COST_MS)) {
      const value = perDispatch[stage as keyof typeof perDispatch];
      expect(measured.samples[stage as keyof typeof measured.samples].dispatches)
        .toBeGreaterThan(0);
      expect(value, `${stage} measured`).toBeGreaterThan(0);
      expect(value, `${stage} drifted below the pinned seed / 4`).toBeGreaterThan(pinned / 4);
      expect(value, `${stage} drifted above the pinned seed x 4`).toBeLessThan(pinned * 4);
    }
  }, 240_000);
});
