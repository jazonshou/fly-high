import { describe, expect, it } from "vitest";
import { inspectWebGpuCapabilities } from "../../src/render/webgpu/core/Capabilities";
import { COMPUTE_DISPATCH_SEED_COST_MS } from "../../src/render/webgpu/core/ComputeBudget";
import {
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
} from "../../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
  TERRAIN_EROSION_SEED_BAND_ROWS,
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
} from "../../src/render/webgpu/terrain/TerrainPageErosionGpu";
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
 * documentation. This test keeps their weighted page admission cost honest:
 * one-sided whole-page and grouped alarms over complete physical DAG runs.
 *
 * Its own file because the measurement needs a device created WITH
 * `timestamp-query`, and a browser page that has already built and disposed
 * several WebGPU devices does not reliably get one — see the harness note.
 */

type CostStage = keyof typeof TERRAIN_EROSION_STAGE_SEED_COST_MS;
type StageMeasurements = Readonly<
  Record<CostStage, { readonly milliseconds: number; readonly dispatches: number }>
>;

const COST_STAGES = Object.keys(TERRAIN_EROSION_STAGE_SEED_COST_MS) as CostStage[];

/**
 * The complete production DAG, derived from the same geometry/configuration
 * constants as the producer. This is the timing sample's non-vacuity guard:
 * a cheap result with a missing shader is not a fast page.
 */
const EXPECTED_STAGE_DISPATCHES: Readonly<Record<CostStage, number>> = Object.freeze({
  seed: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS / TERRAIN_EROSION_SEED_BAND_ROWS,
  // Erodibility before breach and repose after stream power.
  geology: (EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
    / TERRAIN_EROSION_GEOLOGY_BAND_ROWS) * 2,
  breach: 2,
  decode: 1,
  streamPower: TERRAIN_EROSION_PRODUCTION_CONFIG.streamPowerIterations,
  // One gather and one apply per iteration.
  talus: TERRAIN_EROSION_PRODUCTION_CONFIG.talusIterations * 2,
  fineBand: EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS
    / TERRAIN_EROSION_GEOLOGY_BAND_ROWS,
});

const TIMED_PAGES = 4;
const REQUIRED_CONCENTRATED_PAGES = TIMED_PAGES - 1;
const TIMING_DRAIN_FRAMES = 12;

const MAJOR_STAGES: readonly CostStage[] = ["seed", "talus"];
const MINOR_STAGES: readonly CostStage[] = COST_STAGES.filter(
  (stage) => !MAJOR_STAGES.includes(stage),
);

function pinnedCost(stages: readonly CostStage[]): number {
  return stages.reduce(
    (total, stage) => total
      + TERRAIN_EROSION_STAGE_SEED_COST_MS[stage] * EXPECTED_STAGE_DISPATCHES[stage],
    0,
  );
}

function measuredCost(sample: StageMeasurements, stages: readonly CostStage[]): number {
  return stages.reduce((total, stage) => total + sample[stage].milliseconds, 0);
}

const PINNED_PAGE_COST_MS = pinnedCost(COST_STAGES);
const PINNED_MAJOR_COST_MS = pinnedCost(MAJOR_STAGES);
const PINNED_MINOR_COST_MS = pinnedCost(MINOR_STAGES);

describe("terrain page erosion GPU dispatch cost (W-1d)", () => {
  it("holds the complete DAG's concentrated cost against its pinned admission price", async (context) => {
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
        const drainTiming = async () => {
          // A stage's last timestamp resolves after the page promise. Drain it
          // before assigning the counters to a page; otherwise the fine-band
          // tail of page N can be mistaken for the first sample of page N+1.
          for (let frame = 0; frame < TIMING_DRAIN_FRAMES; frame += 1) {
            await nextFrame();
            harness.producer.consumeMeasuredDispatchCostMs();
          }
        };

        // One warm page pays pipeline creation. Drain and discard ALL of its
        // counters rather than letting a delayed warm timestamp enter page 1.
        const warm = await runPage(harness, address, 4);
        await drainTiming();
        harness.producer.consumeStageMeasurements();

        const pages: Array<{
          readonly samples: StageMeasurements;
          readonly frames: number;
          readonly wallMilliseconds: number;
          readonly dispatches: number;
        }> = [];
        for (let repeat = 0; repeat < TIMED_PAGES; repeat += 1) {
          const timed = await runPage(harness, address, 4);
          await drainTiming();
          pages.push({
            samples: harness.producer.consumeStageMeasurements(),
            frames: timed.frames,
            wallMilliseconds: harness.producer.lastCompletedPageTiming?.totalMilliseconds ?? 0,
            dispatches: harness.producer.lastCompletedPageTiming?.dispatches ?? 0,
          });
        }
        return { pages, warmFrames: warm.frames };
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

    const expectedTotalDispatches = Object.values(EXPECTED_STAGE_DISPATCHES)
      .reduce((sum, count) => sum + count, 0);
    const pageRows = measured.pages.map((page, pageIndex) => {
      for (const stage of COST_STAGES) {
        const sample = page.samples[stage];
        expect(
          sample.dispatches,
          `timed page ${pageIndex + 1} did not measure every ${stage} dispatch`,
        ).toBe(EXPECTED_STAGE_DISPATCHES[stage]);
        expect(
          sample.milliseconds,
          `timed page ${pageIndex + 1} measured ${stage} dispatches but no GPU time`,
        ).toBeGreaterThan(0);
      }
      expect(page.dispatches, `timed page ${pageIndex + 1} DAG dispatch count`)
        .toBe(expectedTotalDispatches);
      const total = measuredCost(page.samples, COST_STAGES);
      const major = measuredCost(page.samples, MAJOR_STAGES);
      const minor = measuredCost(page.samples, MINOR_STAGES);
      const perDispatch = Object.fromEntries(COST_STAGES.map((stage) => [
        stage,
        page.samples[stage].milliseconds / page.samples[stage].dispatches,
      ]));
      console.log(
        `W-1d timed page ${pageIndex + 1}/${TIMED_PAGES}:`,
        `${total.toFixed(2)} ms GPU (${(total / expectedTotalDispatches).toFixed(4)} ms/dispatch),`,
        `major ${major.toFixed(2)} ms, minor ${minor.toFixed(2)} ms,`,
        `${page.frames} pump frames, ${Math.round(page.wallMilliseconds)} ms wall; stages`,
        JSON.stringify(perDispatch, (_, value) =>
          typeof value === "number" ? Math.round(value * 10_000) / 10_000 : value),
      );
      return { pageIndex, total, major, minor };
    });

    // Timestamp queries this short report queue/driver stalls as dispatch
    // time. One contaminated page is tolerated explicitly; a real shader or
    // workload regression is present in the other three as well. Unlike the
    // old per-stage minima, these are four PHYSICAL page totals — no synthetic
    // page assembled from seven different best-case runs.
    const wholePageLimit = PINNED_PAGE_COST_MS * 2;
    const concentrated = pageRows.filter((page) => page.total < wholePageLimit);
    const noisy = pageRows.filter((page) => page.total >= wholePageLimit);
    const noiseReport = noisy.length === 0
      ? "single noisy-page allowance unused"
      : noisy.length === 1
        ? `tolerated noisy page: ${noisy[0]!.pageIndex + 1}`
        : `excess noisy pages: ${noisy.map((page) => page.pageIndex + 1).join(", ")} `
          + "(only one is tolerated)";
    console.log(
      `W-1d admission check: ${concentrated.length}/${TIMED_PAGES} pages below `
      + `${wholePageLimit.toFixed(2)} ms (2x pinned ${PINNED_PAGE_COST_MS.toFixed(2)} ms); `
      + noiseReport,
    );
    expect(
      concentrated.length,
      `only ${concentrated.length}/${TIMED_PAGES} complete pages were below 2x the `
      + `${PINNED_PAGE_COST_MS.toFixed(2)} ms admission price; one noisy page is `
      + "tolerated, but a cost regression must not concentrate in two or more",
    ).toBeGreaterThanOrEqual(REQUIRED_CONCENTRATED_PAGES);

    // Drop the same single slowest physical page for both groups. Seed+talus
    // carry 92% of the declared page price and have 112 dispatches/page, so a
    // 2x grouped guard is stable and catches the stages that can actually
    // break page admission. The five minor stages are only 8% of the price and
    // include the 1-dispatch decode and 20-us stream-power counters; combining
    // all 51 dispatches/page supports the original one-sided 4x alarm without
    // pretending an individual short counter has that precision.
    const retained = [...pageRows]
      .sort((first, second) => first.total - second.total)
      .slice(0, REQUIRED_CONCENTRATED_PAGES);
    const retainedMajor = retained.reduce((sum, page) => sum + page.major, 0) / retained.length;
    const retainedMinor = retained.reduce((sum, page) => sum + page.minor, 0) / retained.length;
    console.log(
      `W-1d retained-page groups: major ${retainedMajor.toFixed(2)} / `
      + `${PINNED_MAJOR_COST_MS.toFixed(2)} ms pinned, minor ${retainedMinor.toFixed(2)} / `
      + `${PINNED_MINOR_COST_MS.toFixed(2)} ms pinned; retained pages `
      + retained.map((page) => page.pageIndex + 1).join(", "),
    );
    expect(
      retainedMajor,
      "seed+talus exceeded 2x their weighted admission price on the retained pages",
    ).toBeLessThan(PINNED_MAJOR_COST_MS * 2);
    expect(
      retainedMinor,
      "combined minor stages exceeded 4x their weighted admission price on the retained pages",
    ).toBeLessThan(PINNED_MINOR_COST_MS * 4);

    // Keep the published client seed connected to the stage table. A future
    // seed edit cannot make the aggregate gate pass by silently changing only
    // one side of the admission contract. It is intentionally conservative:
    // the stage-weighted 0.229 ms rounds up to 0.24 ms, so compare the policy
    // relationship rather than demanding false decimal equality.
    const weightedDispatchSeed = PINNED_PAGE_COST_MS / expectedTotalDispatches;
    expect(
      Math.abs(weightedDispatchSeed - COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute)
        / COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute,
      "the client seed and weighted stage table drifted more than 10% apart",
    ).toBeLessThan(0.1);
  }, 240_000);
});
