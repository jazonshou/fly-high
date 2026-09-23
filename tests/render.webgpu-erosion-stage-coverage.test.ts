import { join } from "node:path";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
  TerrainPageErosionGpu,
  type TerrainPageErosionGpuOptions,
} from "@/src/render/webgpu/terrain/TerrainPageErosionGpu";
import {
  type ErosionCostStage,
  EXPECTED_STAGE_DISPATCHES,
  erosionStageCoverageFaults,
  UNUSABLE_READINGS_PER_PAGE_CAP,
} from "./support/erosionStageCoverage";
import { readSource } from "./support/sourceText";

/**
 * `W-1d`'s timing sample, off the GPU. What the GPU cost test cannot show on
 * a host whose readings are all good: a pass that reads no positive duration
 * must be counted as present and priced at nothing, not dropped, so that it is
 * told apart from a shader that never dispatched; and the allowance for such
 * readings must stay too small to hide a cost regression.
 *
 * The producer's trackers are replaced with fakes carrying Babylon's counter
 * shape (`gpuTimeInFrame.counter`: `count` advances once per frame that
 * resolved a reading, `current` is that frame's nanoseconds).
 */

interface FakeTracker {
  shader: { gpuTimeInFrame: { counter: { count: number; current: number } } };
  stage: ErosionCostStage;
  dispatchesSinceConsume: number;
  lastSampleCount: number;
}

/** Shaders per stage, as the producer's `costTrackers` list them. */
const SHADERS_PER_STAGE: Readonly<Record<ErosionCostStage, number>> = {
  seed: 1,
  geology: 2,
  breach: 2,
  decode: 1,
  streamPower: 2,
  talus: 4,
  fineBand: 2,
};

const PINNED_NANOSECONDS = (stage: ErosionCostStage): number =>
  TERRAIN_EROSION_STAGE_SEED_COST_MS[stage] * 1_000_000;

function producerWithFakeTrackers(): {
  producer: TerrainPageErosionGpu;
  trackers: Record<ErosionCostStage, FakeTracker[]>;
} {
  // The constructor only stores its options; nothing here touches the GPU.
  const producer = new TerrainPageErosionGpu(
    {} as AbstractEngine,
    {} as TerrainPageErosionGpuOptions,
  );
  const trackers = Object.fromEntries(
    (Object.keys(SHADERS_PER_STAGE) as ErosionCostStage[]).map((stage) => [
      stage,
      Array.from({ length: SHADERS_PER_STAGE[stage] }, () => ({
        shader: { gpuTimeInFrame: { counter: { count: 0, current: 0 } } },
        stage,
        dispatchesSinceConsume: 0,
        // As the producer seeds them: the fresh counter's own count.
        lastSampleCount: 0,
      })),
    ]),
  ) as Record<ErosionCostStage, FakeTracker[]>;
  (producer as unknown as { costTrackers: FakeTracker[] }).costTrackers =
    Object.values(trackers).flat();
  return { producer, trackers };
}

/** A reading in nanoseconds, or "none" for one that never resolves. */
type Reading = number | "none";

/**
 * One page, one dispatch per frame, consumed every frame as the harness does.
 * `readingFor` overrides the pinned reading of a stage's n-th dispatch.
 */
function runFakePage(
  producer: TerrainPageErosionGpu,
  trackers: Record<ErosionCostStage, FakeTracker[]>,
  readingFor: (stage: ErosionCostStage, index: number) => Reading | undefined = () => undefined,
  dispatchesFor: (stage: ErosionCostStage) => number = (stage) => EXPECTED_STAGE_DISPATCHES[stage],
) {
  for (const stage of Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[]) {
    const shaders = trackers[stage];
    for (let index = 0; index < dispatchesFor(stage); index += 1) {
      const tracker = shaders[index % shaders.length]!;
      // What the producer's private `dispatch` does to the tracker.
      tracker.dispatchesSinceConsume += 1;
      const reading = readingFor(stage, index) ?? PINNED_NANOSECONDS(stage);
      if (reading !== "none") {
        const counter = tracker.shader.gpuTimeInFrame.counter;
        counter.count += 1;
        counter.current = reading;
      }
      producer.consumeMeasuredDispatchCostMs();
    }
  }
  return producer.consumeStageMeasurements();
}

describe("W-1d stage coverage: a reading of nothing is not a missing dispatch", () => {
  it("prices every dispatch of a page whose readings are all good", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers);
    for (const stage of Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[]) {
      expect(samples[stage].dispatches, stage).toBe(EXPECTED_STAGE_DISPATCHES[stage]);
      expect(samples[stage].unusable, stage).toBe(0);
    }
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
  });

  it("counts a pass that read zero as unusable, prices it at nothing, and the page passes", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers, (stage, index) =>
      stage === "breach" && index === 0 ? 0 : undefined);
    // The failure this guards: breach read "1 of 2" because the zero was dropped.
    expect(samples.breach).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.breach,
      dispatches: 1,
      unusable: 1,
    });
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
    // Nothing was priced from it: the running estimate did not move toward zero.
    expect(producer.stageEstimates().breach).toBeCloseTo(TERRAIN_EROSION_STAGE_SEED_COST_MS.breach, 12);
  });

  it("starts each page's unusable count afresh, so a warm page's cannot enter page 1", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    runFakePage(producer, trackers, (stage, index) =>
      stage === "breach" && index === 0 ? 0 : undefined);
    const next = runFakePage(producer, trackers);
    expect(next.breach).toEqual({
      milliseconds: 2 * TERRAIN_EROSION_STAGE_SEED_COST_MS.breach,
      dispatches: 2,
      unusable: 0,
    });
  });

  it("treats a non-finite reading the same way", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers, (stage, index) =>
      stage === "decode" && index === 0 ? Number.NaN : undefined);
    expect(samples.decode).toEqual({ milliseconds: 0, dispatches: 0, unusable: 1 });
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
  });

  it("returns no per-dispatch price for a frame whose only reading was unusable", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const tracker = trackers.decode[0]!;
    tracker.dispatchesSinceConsume = 1;
    tracker.shader.gpuTimeInFrame.counter.count = 1;
    tracker.shader.gpuTimeInFrame.counter.current = 0;
    expect(producer.consumeMeasuredDispatchCostMs()).toBeNull();
  });

  it("still fails a page with a shader that never dispatched", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers, undefined, (stage) =>
      stage === "breach" ? 1 : EXPECTED_STAGE_DISPATCHES[stage]);
    expect(samples.breach).toMatchObject({ dispatches: 1, unusable: 0 });
    expect(erosionStageCoverageFaults(samples)).toEqual([
      "did not measure every breach dispatch: 1 priced + 0 unusable, expected 2",
    ]);
  });

  it("still fails a page with a reading that never arrived", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers, (stage, index) =>
      stage === "breach" && index === 0 ? "none" : undefined);
    expect(samples.breach).toMatchObject({ dispatches: 1, unusable: 0 });
    expect(erosionStageCoverageFaults(samples)).toEqual([
      "did not measure every breach dispatch: 1 priced + 0 unusable, expected 2",
    ]);
  });

  it("does not mistake a shader's first reading, not yet arrived, for a reading of zero", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const tracker = trackers.seed[0]!;
    tracker.dispatchesSinceConsume = 1;
    producer.consumeMeasuredDispatchCostMs();
    expect(tracker.dispatchesSinceConsume).toBe(1);
    tracker.shader.gpuTimeInFrame.counter.count = 1;
    tracker.shader.gpuTimeInFrame.counter.current = PINNED_NANOSECONDS("seed");
    producer.consumeMeasuredDispatchCostMs();
    expect(producer.consumeStageMeasurements().seed).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.seed,
      dispatches: 1,
      unusable: 0,
    });
  });

  it("seeds every producer tracker at the fresh counter's count", () => {
    const source = readSource(join(
      import.meta.dirname, "..", "src", "render", "webgpu", "terrain", "TerrainPageErosionGpu.ts"));
    const seeded = [...source.matchAll(/lastSampleCount: (-?\d+)/gu)].map((match) => match[1]);
    expect(seeded.length).toBeGreaterThan(0);
    expect(new Set(seeded)).toEqual(new Set(["0"]));
    expect(seeded).toHaveLength(Object.values(SHADERS_PER_STAGE).reduce((sum, count) => sum + count, 0));
  });

  it("fails a page with more unusable readings than the cap", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const over = UNUSABLE_READINGS_PER_PAGE_CAP + 1;
    const samples = runFakePage(producer, trackers, (stage, index) =>
      stage === "streamPower" && index < over ? 0 : undefined);
    expect(samples.streamPower.unusable).toBe(over);
    expect(erosionStageCoverageFaults(samples)).toEqual([
      `${over} dispatches read no positive duration; at most `
      + `${UNUSABLE_READINGS_PER_PAGE_CAP} per page are tolerated`,
    ]);
  });

  it("fails priced dispatches that carry no time", () => {
    const { producer, trackers } = producerWithFakeTrackers();
    const samples = runFakePage(producer, trackers);
    const broken = { ...samples, fineBand: { ...samples.fineBand, milliseconds: 0 } };
    expect(erosionStageCoverageFaults(broken)).toEqual([
      "measured fineBand dispatches but no GPU time",
    ]);
  });
});

describe("W-1d stage coverage: the unusable allowance cannot hide a regression", () => {
  const stages = Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[];
  const pinned = (subset: readonly ErosionCostStage[]) => subset.reduce(
    (total, stage) => total + TERRAIN_EROSION_STAGE_SEED_COST_MS[stage] * EXPECTED_STAGE_DISPATCHES[stage],
    0,
  );
  const dearest = (subset: readonly ErosionCostStage[]) =>
    Math.max(...subset.map((stage) => TERRAIN_EROSION_STAGE_SEED_COST_MS[stage]));

  it("hides under 2 % of the pinned page, against a whole-page alarm at twice its price", () => {
    expect(UNUSABLE_READINGS_PER_PAGE_CAP * dearest(stages) / pinned(stages)).toBeLessThan(0.02);
  });

  it("hides under 10 % of the pinned minor stages, against their alarm at four times", () => {
    const minor = stages.filter((stage) => stage !== "seed" && stage !== "talus");
    expect(UNUSABLE_READINGS_PER_PAGE_CAP * dearest(minor) / pinned(minor)).toBeLessThan(0.1);
  });

  it("is what the GPU cost test applies, next to the issued-dispatch count", () => {
    const source = readSource(join(import.meta.dirname, "gpu", "terrain-page-erosion-cost.test.ts"));
    expect(source).toContain("erosionStageCoverageFaults(page.samples)");
    expect(source).toContain("dispatches: harness.producer.lastCompletedPageTiming?.dispatches ?? 0");
    expect(source).toMatch(
      /expect\(page\.dispatches, `timed page \$\{pageIndex \+ 1\} DAG dispatch count`\)\s+\.toBe\(expectedTotalDispatches\);/u,
    );
  });
});
