import { join } from "node:path";
import { WebGPUPerfCounter } from "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter";
import { describe, expect, it } from "vitest";
import { deliverPassDuration, PassCostTape } from "@/src/render/webgpu/core/DeferredPassTiming";
import { PageOcclusionBake, PageSplatBake } from "@/src/render/webgpu/terrain/PageOcclusionBake";
import { consumeGpuDispatchCostMs, TerrainPageGenerator } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { readSource } from "./support/sourceText";

/**
 * The per-page meters of the terrain page generator and the occlusion and
 * splat bakes, priced by each batch's OWN page count.
 *
 * They used to divide the latest delivered frame's time by the batch
 * dispatched LAST (`consumeGpuDispatchCostMs`). The clipmap consumes before it
 * dispatches, so that pairs correctly only while a reading lands within one
 * frame. Two frames late, it divides one batch's time by the next batch's size;
 * two readings landing between reads lose the first. Each case below runs the
 * old path beside the tape on the same deliveries, so the scenario is shown to
 * exercise the defect it guards.
 */

interface Consumer {
  consumeMeasuredDispatchCostMs(): number | null;
}

const CONSUMERS: ReadonlyArray<{ name: string; make: () => Consumer }> = [
  { name: "terrain page generator", make: () => new TerrainPageGenerator({} as never, {} as never, 1) },
  { name: "occlusion bake", make: () => new PageOcclusionBake({} as never, {} as never, {} as never, {} as never) },
  {
    name: "splat bake",
    make: () => new PageSplatBake({} as never, {} as never, {} as never, 1, 1, 0, 45, null),
  },
];

/** A page costs the same in every batch, so a right price is always this. */
const PAGE_NS = 300_000;
const BATCHES = [1, 4, 2, 8, 3, 6, 1, 5] as const;

/**
 * The clipmap's order, frame by frame: read the meter, then dispatch this
 * frame's batch. A batch's timing lands `lag` frames later, before that
 * frame's read.
 */
function runWithLag(consumer: Consumer, lag: number) {
  const engine = { frameId: 0 };
  const counter = new WebGPUPerfCounter();
  (consumer as unknown as { costTape: PassCostTape }).costTape = new PassCostTape(engine, counter);
  const tape = (consumer as unknown as { costTape: PassCostTape }).costTape;
  let lastBatch = 0;
  let lastCount = -1;
  const tapeReadings: number[] = [];
  const oldReadings: number[] = [];
  for (let frame = 0; frame < BATCHES.length + lag + 1; frame += 1) {
    engine.frameId = frame;
    const landing = frame - lag;
    if (landing >= 0 && landing < BATCHES.length) {
      deliverPassDuration(counter, landing, BATCHES[landing]! * PAGE_NS);
    }
    const priced = consumer.consumeMeasuredDispatchCostMs();
    if (priced !== null) tapeReadings.push(priced);
    const old = consumeGpuDispatchCostMs({ gpuTimeInFrame: counter }, lastBatch, lastCount);
    lastCount = old.sampleCount;
    if (old.milliseconds !== null) oldReadings.push(old.milliseconds);
    if (frame < BATCHES.length) {
      lastBatch = BATCHES[frame]!;
      tape.dispatched(BATCHES[frame]!); // what the dispatch site does once the pass exists
    }
  }
  return { tapeReadings, oldReadings };
}

describe("per-page meters priced by each batch's own page count", () => {
  for (const { name, make } of CONSUMERS) {
    it(`${name}: two frames late, every batch at its own price; the old path at the next batch's`, () => {
      const { tapeReadings, oldReadings } = runWithLag(make(), 2);
      expect(tapeReadings).toHaveLength(BATCHES.length);
      for (const reading of tapeReadings) expect(reading).toBeCloseTo(PAGE_NS / 1e6, 12);
      // The positive control: on the same deliveries the old path prices batch
      // F at batch(F) / batch(F+1) x 0.3 ms: 0.075, 0.6, 0.075, 0.8, 0.15,
      // 1.8, 0.06 ms, and 0.3 only for the last batch, which nothing followed.
      const expected = BATCHES.map((batch, frame) => batch * PAGE_NS / 1e6 / (BATCHES[frame + 1] ?? batch));
      expect(oldReadings).toHaveLength(expected.length);
      oldReadings.forEach((ms, index) => expect(ms).toBeCloseTo(expected[index]!, 12));
      expect(oldReadings.filter((ms) => Math.abs(ms - PAGE_NS / 1e6) > 1e-9)).toHaveLength(7);
    });

    it(`${name}: one frame late, both paths agree (the case the old path was right in)`, () => {
      const { tapeReadings, oldReadings } = runWithLag(make(), 1);
      for (const reading of [...tapeReadings, ...oldReadings]) expect(reading).toBeCloseTo(PAGE_NS / 1e6, 12);
    });

    it(`${name}: two batches landing between reads are both priced`, () => {
      const consumer = make();
      const engine = { frameId: 0 };
      const counter = new WebGPUPerfCounter();
      const tape = new PassCostTape(engine, counter);
      (consumer as unknown as { costTape: PassCostTape }).costTape = tape;
      tape.dispatched(2);
      engine.frameId = 1;
      tape.dispatched(6);
      deliverPassDuration(counter, 0, 2 * PAGE_NS);
      deliverPassDuration(counter, 1, 6 * 400_000);
      // (2 x 0.3 + 6 x 0.4) / 8 pages: both batches, each by its own count.
      expect(consumer.consumeMeasuredDispatchCostMs()).toBeCloseTo(3.0 / 8, 12);
      // Babylon's counter alone holds only the later frame.
      expect(counter.counter.current).toBe(6 * 400_000);
    });

    it(`${name}: prices nothing when its shader is untimed or nothing was delivered`, () => {
      const consumer = make();
      expect(consumer.consumeMeasuredDispatchCostMs()).toBeNull();
      const tape = new PassCostTape({ frameId: 0 }, undefined);
      (consumer as unknown as { costTape: PassCostTape }).costTape = tape;
      tape.dispatched(4);
      expect(tape.timed).toBe(false);
      expect(consumer.consumeMeasuredDispatchCostMs()).toBeNull();
    });
  }
});

describe("per-page meters: wired at every dispatch", () => {
  const root = join(import.meta.dirname, "..", "src", "render", "webgpu");
  const atlas = readSource(join(root, "terrain", "TerrainPageAtlas.ts"));
  const bakes = readSource(join(root, "terrain", "PageOcclusionBake.ts"));

  it("records each batch on its tape after the pass exists, by that batch's own page count", () => {
    expect(atlas).toMatch(
      /await shader\.dispatchWhenReady\(\s+TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,\s+TERRAIN_PAGE_WORKGROUPS_PER_SLOT_EDGE,\s+slots\.length,\s+\);\s+this\.costTape\?\.dispatched\(slots\.length\);/u);
    expect([...bakes.matchAll(
      /await shader\.dispatchWhenReady\(groups, groups, bakeable\.length\);\s+this\.costTape\?\.dispatched\(bakeable\.length\);/gu,
    )]).toHaveLength(2);
  });

  it("gives each shader its tape where the shader is made, and releases it on dispose", () => {
    const make = "this.costTape ??= new PassCostTape(this.engine, passTimingSinkOf(this.shader));";
    expect(atlas.split(make)).toHaveLength(2);
    expect(bakes.split(make)).toHaveLength(3);
    expect(atlas.split("this.costTape?.dispose();")).toHaveLength(2);
    expect(bakes.split("this.costTape?.dispose();")).toHaveLength(3);
  });

  it("no longer divides by the batch dispatched last", () => {
    for (const source of [atlas, bakes]) {
      expect(source).not.toContain("lastBatchSize");
      expect(source).not.toMatch(/consumeGpuDispatchCostMs\(\s*this\.shader/u);
    }
  });
});

describe("ground cover keeps the old path, and why that stays right", () => {
  const source = readSource(join(
    import.meta.dirname, "..", "src", "render", "webgpu", "detail", "GroundCoverSystem.ts"));

  it("prices ring 0 as a batch of one", () => {
    expect(source).toMatch(/consumeGpuDispatchCostMs\(\s+first\.compute as never,\s+1,\s+this\.lastDispatchedCostSamples,\s+\);/u);
  });

  it("dispatches each ring at most once a frame, at the ring's fixed lane count", () => {
    const loop = source.indexOf("for (let ringIndex = 0; ringIndex < this.rings.length; ringIndex += 1) {");
    const dispatches = [...source.matchAll(/ring\.compute\.dispatch\(/gu)].map((match) => match.index!);
    expect(loop).toBeGreaterThan(0);
    // One dispatch call, inside the per-ring loop, not inside any inner loop.
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toBeGreaterThan(loop);
    expect(source).toContain("ring.compute.dispatch(Math.ceil(ring.laneCount / 64), 1, 1);");
    const body = source.slice(loop, dispatches[0]);
    expect(body.match(/\bfor \(/gu) ?? []).toHaveLength(2); // the ring loop and the frustum-plane copy
    expect(body).toContain("for (let plane = 0; plane < 6; plane += 1) {");
    // The only other pass is the one-time warm-up, a single lane, before any timing matters.
    expect([...source.matchAll(/ring\.compute\.dispatchWhenReady\(/gu)]).toHaveLength(1);
    expect(source).toMatch(/if \(!this\.warmed\) \{\s+this\.warmed = true;\s+void ring\.compute\.dispatchWhenReady\(1, 1, 1\)/u);
  });
});
