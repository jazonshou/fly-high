import { join } from "node:path";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import { describe, expect, it } from "vitest";
import { deliverPassDuration, PassCostTape } from "@/src/render/webgpu/core/DeferredPassTiming";
import {
  TERRAIN_EROSION_STAGE_SEED_COST_MS,
  TerrainPageErosionGpu,
  type TerrainPageErosionGpuOptions,
} from "@/src/render/webgpu/terrain/TerrainPageErosionGpu";
import {
  chargedStageMs,
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
 * The producer's trackers are replaced with fakes built the producer's way:
 * a real Babylon counter per shader and a `PassCostTape` on it. A pass is
 * recorded as the producer's `dispatch` records it, and its reading arrives
 * through `deliverPassDuration`, the deferred timing's one delivery path.
 */

interface FakeTracker {
  shader: { gpuTimeInFrame: WebGPUPerfCounter };
  stage: ErosionCostStage;
  tape: PassCostTape;
}

/** Shaders per stage, as the producer's `costTrackers` list them. */
const SHADERS_PER_STAGE: Readonly<Record<ErosionCostStage, number>> = {
  seed: 1,
  geology: 2,
  breachDirect: 1,
  breachPit: 1,
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
  engine: { frameId: number };
} {
  // The constructor only stores its options; nothing here touches the GPU.
  const producer = new TerrainPageErosionGpu(
    {} as AbstractEngine,
    {} as TerrainPageErosionGpuOptions,
  );
  const engine = { frameId: 1 };
  const trackers = Object.fromEntries(
    (Object.keys(SHADERS_PER_STAGE) as ErosionCostStage[]).map((stage) => [
      stage,
      Array.from({ length: SHADERS_PER_STAGE[stage] }, () => {
        const counter = new WebGPUPerfCounter();
        return { shader: { gpuTimeInFrame: counter }, stage, tape: new PassCostTape(engine, counter) };
      }),
    ]),
  ) as Record<ErosionCostStage, FakeTracker[]>;
  (producer as unknown as { costTrackers: FakeTracker[] }).costTrackers =
    Object.values(trackers).flat();
  return { producer, trackers, engine };
}

/** The deferred timing delivering one pass's reading, keyed by the frame it was recorded in. */
function deliver(tracker: FakeTracker, frameId: number, nanoseconds: number): void {
  deliverPassDuration(tracker.shader.gpuTimeInFrame, frameId, nanoseconds);
}

/** A reading in nanoseconds, or "none" for one that never resolves. */
type Reading = number | "none";

/**
 * One page, one dispatch per frame, consumed every frame as the harness does.
 * `readingFor` overrides the pinned reading of a stage's n-th dispatch.
 */
function runFakePage(
  { producer, trackers, engine }: ReturnType<typeof producerWithFakeTrackers>,
  readingFor: (stage: ErosionCostStage, index: number) => Reading | undefined = () => undefined,
  dispatchesFor: (stage: ErosionCostStage) => number = (stage) => EXPECTED_STAGE_DISPATCHES[stage],
) {
  for (const stage of Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[]) {
    const shaders = trackers[stage];
    for (let index = 0; index < dispatchesFor(stage); index += 1) {
      const tracker = shaders[index % shaders.length]!;
      // What the producer's private `dispatch` does once the pass exists.
      tracker.tape.dispatched(1);
      const reading = readingFor(stage, index) ?? PINNED_NANOSECONDS(stage);
      if (reading !== "none") deliver(tracker, engine.frameId, reading);
      engine.frameId += 1;
      producer.consumeMeasuredDispatchCostMs();
    }
  }
  return producer.consumeStageMeasurements();
}

describe("W-1d stage coverage: a reading of nothing is not a missing dispatch", () => {
  it("prices every dispatch of a page whose readings are all good", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake);
    for (const stage of Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[]) {
      expect(samples[stage].dispatches, stage).toBe(EXPECTED_STAGE_DISPATCHES[stage]);
      expect(samples[stage].unusable, stage).toBe(0);
    }
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
  });

  it("counts a pass that read zero as unusable, prices it at nothing, and the page passes", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake, (stage, index) =>
      stage === "breachDirect" && index === 0 ? 0 : undefined);
    // The failure this guards: breach read "1 of 2" because the zero was dropped.
    expect(samples.breachDirect).toEqual({ milliseconds: 0, dispatches: 0, unusable: 1 });
    expect(samples.breachPit).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.breachPit,
      dispatches: 1,
      unusable: 0,
    });
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
    // Nothing was priced from it: the running estimate did not move toward zero.
    expect(fake.producer.stageEstimates().breachDirect)
      .toBeCloseTo(TERRAIN_EROSION_STAGE_SEED_COST_MS.breachDirect, 12);
  });

  it("starts each page's unusable count afresh, so a warm page's cannot enter page 1", () => {
    const fake = producerWithFakeTrackers();
    runFakePage(fake, (stage, index) =>
      stage === "breachDirect" && index === 0 ? 0 : undefined);
    const next = runFakePage(fake);
    expect(next.breachDirect).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.breachDirect,
      dispatches: 1,
      unusable: 0,
    });
  });

  it("treats a non-finite reading the same way", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake, (stage, index) =>
      stage === "decode" && index === 0 ? Number.NaN : undefined);
    expect(samples.decode).toEqual({ milliseconds: 0, dispatches: 0, unusable: 1 });
    expect(erosionStageCoverageFaults(samples)).toEqual([]);
  });

  it("returns no per-dispatch price for a frame whose only reading was unusable", () => {
    const { producer, trackers, engine } = producerWithFakeTrackers();
    const tracker = trackers.decode[0]!;
    tracker.tape.dispatched(1);
    deliver(tracker, engine.frameId, 0);
    expect(producer.consumeMeasuredDispatchCostMs()).toBeNull();
  });

  it("still fails a page with a shader that never dispatched", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake, undefined, (stage) =>
      stage === "breachPit" ? 0 : EXPECTED_STAGE_DISPATCHES[stage]);
    expect(samples.breachPit).toMatchObject({ dispatches: 0, unusable: 0 });
    expect(erosionStageCoverageFaults(samples)).toEqual([
      "did not measure every breachPit dispatch: 0 priced + 0 unusable, expected 1",
    ]);
  });

  it("still fails a page with a reading that never arrived", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake, (stage, index) =>
      stage === "breachPit" && index === 0 ? "none" : undefined);
    expect(samples.breachPit).toMatchObject({ dispatches: 0, unusable: 0 });
    expect(erosionStageCoverageFaults(samples)).toEqual([
      "did not measure every breachPit dispatch: 0 priced + 0 unusable, expected 1",
    ]);
  });

  it("offers breach one pass at a time, each at its own price", () => {
    const producer = new TerrainPageErosionGpu({} as AbstractEngine, {} as TerrainPageErosionGpuOptions);
    const internals = producer as unknown as {
      job: { stage: string; breachDirectDone: boolean; asyncInFlight: boolean; cancelled: boolean } | null;
      stageEstimatesMs: Record<ErosionCostStage, number>;
      pruneStale(): void;
    };
    internals.pruneStale = () => {};
    internals.stageEstimatesMs.breachDirect = 0.04;
    internals.stageEstimatesMs.breachPit = 2.5;
    internals.job = { stage: "breach", breachDirectDone: false, asyncInFlight: false, cancelled: false };
    expect(producer.demand(0)).toEqual({ count: 1, costMs: 0.04 });
    internals.job.breachDirectDone = true;
    expect(producer.demand(0)).toEqual({ count: 1, costMs: 2.5 });
  });

  it("does not let a reading that never arrives hold up the passes after it", () => {
    const fake = producerWithFakeTrackers();
    runFakePage(fake, (stage, index) => stage === "breachPit" && index === 0 ? "none" : undefined);
    expect(runFakePage(fake).breachPit).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.breachPit,
      dispatches: 1,
      unusable: 0,
    });
  });

  it("does not mistake a reading not yet arrived for a reading of zero, and prices it when it lands", () => {
    const { producer, trackers, engine } = producerWithFakeTrackers();
    const tracker = trackers.seed[0]!;
    tracker.tape.dispatched(1);
    const frame = engine.frameId;
    engine.frameId += 3;
    producer.consumeMeasuredDispatchCostMs();
    expect(producer.consumeStageMeasurements().seed).toEqual({ milliseconds: 0, dispatches: 0, unusable: 0 });
    deliver(tracker, frame, PINNED_NANOSECONDS("seed"));
    producer.consumeMeasuredDispatchCostMs();
    expect(producer.consumeStageMeasurements().seed).toEqual({
      milliseconds: TERRAIN_EROSION_STAGE_SEED_COST_MS.seed,
      dispatches: 1,
      unusable: 0,
    });
  });

  it("prices every frame when two land between reads, each at its own time", () => {
    // Polling Babylon's counter kept only the later frame's sum here.
    const { producer, trackers, engine } = producerWithFakeTrackers();
    const tracker = trackers.seed[0]!;
    const frames = [engine.frameId, engine.frameId + 1];
    tracker.tape.dispatched(4);
    engine.frameId += 1;
    tracker.tape.dispatched(4);
    deliver(tracker, frames[0]!, 1_200_000);
    deliver(tracker, frames[1]!, 900_000);
    producer.consumeMeasuredDispatchCostMs();
    const seed = producer.consumeStageMeasurements().seed;
    expect(seed.milliseconds).toBeCloseTo(2.1, 12);
    expect(seed).toMatchObject({ dispatches: 8, unusable: 0 });
  });

  it("never credits a late reading to a later dispatch", () => {
    // Polling credited a reading that landed with nothing pending to the next
    // page's first dispatch.
    const { producer, trackers, engine } = producerWithFakeTrackers();
    const tracker = trackers.seed[0]!;
    tracker.tape.dispatched(1);
    const early = engine.frameId;
    deliver(tracker, early, 700_000);
    producer.consumeMeasuredDispatchCostMs();
    producer.consumeStageMeasurements();
    deliver(tracker, early, 700_000); // a stray repeat for a pass already priced
    engine.frameId += 1;
    tracker.tape.dispatched(1);
    producer.consumeMeasuredDispatchCostMs();
    expect(producer.consumeStageMeasurements().seed).toEqual({ milliseconds: 0, dispatches: 0, unusable: 0 });
    deliver(tracker, engine.frameId, 300_000);
    producer.consumeMeasuredDispatchCostMs();
    expect(producer.consumeStageMeasurements().seed).toEqual({ milliseconds: 0.3, dispatches: 1, unusable: 0 });
  });

  it("gives every producer tracker a tape on its own shader's counter, recorded after the pass exists", () => {
    const source = readSource(join(
      import.meta.dirname, "..", "src", "render", "webgpu", "terrain", "TerrainPageErosionGpu.ts"));
    const tracked = [...source.matchAll(/tracked\((\w+), "(\w+)"\),/gu)];
    expect(tracked).toHaveLength(Object.values(SHADERS_PER_STAGE).reduce((sum, count) => sum + count, 0));
    for (const stage of Object.keys(SHADERS_PER_STAGE) as ErosionCostStage[]) {
      expect(tracked.filter((match) => match[2] === stage), stage).toHaveLength(SHADERS_PER_STAGE[stage]);
    }
    expect(source).toMatch(
      /tape: new PassCostTape\(\s+this\.engine,\s+\(shader as unknown as \{ gpuTimeInFrame\?: PassDurationSink \}\)\.gpuTimeInFrame,/u);
    const dispatchWhenReady = source.indexOf("await shader.dispatchWhenReady(groupsX, groupsY, groupsZ);");
    const recorded = source.indexOf("?.tape.dispatched(costUnits);");
    expect(dispatchWhenReady).toBeGreaterThan(0);
    expect(recorded).toBeGreaterThan(dispatchWhenReady);
  });

  it("fails a page with more unusable readings than the cap", () => {
    const fake = producerWithFakeTrackers();
    const over = UNUSABLE_READINGS_PER_PAGE_CAP + 1;
    const samples = runFakePage(fake, (stage, index) =>
      stage === "streamPower" && index < over ? 0 : undefined);
    expect(samples.streamPower.unusable).toBe(over);
    expect(erosionStageCoverageFaults(samples)).toEqual([
      `${over} dispatches read no positive duration; at most `
      + `${UNUSABLE_READINGS_PER_PAGE_CAP} per page are tolerated`,
    ]);
  });

  it("fails priced dispatches that carry no time", () => {
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake);
    const broken = { ...samples, fineBand: { ...samples.fineBand, milliseconds: 0 } };
    expect(erosionStageCoverageFaults(broken)).toEqual([
      "measured fineBand dispatches but no GPU time",
    ]);
  });
});

describe("W-1d stage coverage: an unusable reading cannot hide a cost", () => {
  const stages = Object.keys(EXPECTED_STAGE_DISPATCHES) as ErosionCostStage[];
  const pinnedPage = stages.reduce(
    (total, stage) => total + TERRAIN_EROSION_STAGE_SEED_COST_MS[stage] * EXPECTED_STAGE_DISPATCHES[stage],
    0,
  );
  const chargedPage = (samples: ReturnType<typeof runFakePage>) =>
    stages.reduce((total, stage) => total + chargedStageMs(samples[stage], stage), 0);

  it("charges each unusable dispatch at its stage's pinned price, whichever stage it is", () => {
    for (const stage of stages) {
      const fake = producerWithFakeTrackers();
      const samples = runFakePage(fake, (at, index) => at === stage && index === 0 ? 0 : undefined);
      expect(samples[stage].unusable, stage).toBe(1);
      // Every reading here is its pinned price, so a page that lost one reads
      // exactly as dear as a page that lost none.
      expect(chargedPage(samples), stage).toBeCloseTo(pinnedPage, 9);
    }
  });

  it("charges the dearest dispatch in full: losing its reading does not cheapen the page", () => {
    const dearest = stages.reduce((max, stage) =>
      TERRAIN_EROSION_STAGE_SEED_COST_MS[stage] > TERRAIN_EROSION_STAGE_SEED_COST_MS[max] ? stage : max);
    const fake = producerWithFakeTrackers();
    const samples = runFakePage(fake, (at, index) => at === dearest && index === 0 ? Number.NaN : undefined);
    const measuredOnly = stages.reduce((total, stage) => total + samples[stage].milliseconds, 0);
    expect(pinnedPage - measuredOnly).toBeCloseTo(TERRAIN_EROSION_STAGE_SEED_COST_MS[dearest], 9);
    expect(chargedPage(samples)).toBeCloseTo(pinnedPage, 9);
  });

  it("is what the GPU cost test applies, next to the issued-dispatch count", () => {
    const source = readSource(join(import.meta.dirname, "gpu", "terrain-page-erosion-cost.test.ts"));
    expect(source).toContain("erosionStageCoverageFaults(page.samples)");
    expect(source).toContain("total + chargedStageMs(sample[stage], stage)");
    expect(source).toContain("dispatches: harness.producer.lastCompletedPageTiming?.dispatches ?? 0");
    expect(source).toMatch(
      /expect\(page\.dispatches, `timed page \$\{pageIndex \+ 1\} DAG dispatch count`\)\s+\.toBe\(expectedTotalDispatches\);/u,
    );
  });
});
