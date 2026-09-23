// Side-effect import: registers the compute pipeline methods.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { describe, expect, it } from "vitest";
import {
  type DeferredPassTiming,
  installDeferredPassTiming,
} from "../../src/render/webgpu/core/DeferredPassTiming";
import {
  adapterAdvertisesTimestampQuery,
  gpuTimingAvailable,
  NO_TIMESTAMP_QUERY_REASON,
  nextFrame,
  timestampQueryForcedOff,
} from "./terrainPageErosionGpuHarness";

/**
 * The per-pass timing instrument itself (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md).
 *
 * Babylon's own read resolves a pass's query slots before the pass runs, so a
 * trivial pass that follows a heavy one in the same slot reads the heavy
 * pass's time. The positive control here is that exact case: if a trivial
 * pass ever reads like a heavy one, the instrument is measuring the slot's
 * previous occupant again.
 *
 * Few devices per file on purpose: a page that has built and disposed several
 * WebGPU devices does not reliably get `timestamp-query` back.
 */

interface TimedEngine {
  readonly engine: WebGPUEngine;
  readonly timing: DeferredPassTiming | null;
}

async function withTimedEngine<T>(
  deferred: boolean,
  run: (timed: TimedEngine) => Promise<T>,
): Promise<T | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    enableAllFeatures: false,
    setMaximumLimits: false,
    ...(timestampQueryForcedOff()
      ? {}
      : { deviceDescriptor: { requiredFeatures: ["timestamp-query"] as GPUFeatureName[] } }),
  });
  try {
    await engine.initAsync();
    if (!gpuTimingAvailable(engine)) return null;
    engine.enableGPUTimingMeasurements = true;
    const timing = deferred ? installDeferredPassTiming(engine) : null;
    if (deferred && !timing) throw new Error("per-pass timing could not be installed");
    return await run({ engine, timing });
  } finally {
    engine.stopRenderLoop();
    engine.dispose();
    canvas.remove();
  }
}

const SINK_INVOCATIONS = 4096 * 64;
function makeShader(engine: WebGPUEngine, sink: StorageBuffer, name: string, iterations: number): ComputeShader {
  const shader = new ComputeShader(name, engine, {
    computeSource: `
@group(0) @binding(0) var<storage, read_write> sink: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 0.000001;
  for (var i = 0u; i < ${iterations}u; i = i + 1u) { x = fract(x * 1.0001 + 0.37); }
  sink[id.x] = x;
}`,
  }, { bindingsMapping: { sink: { group: 0, binding: 0 } } });
  shader.setStorageBuffer("sink", sink);
  return shader;
}

const counterOf = (shader: ComputeShader) =>
  (shader as unknown as { gpuTimeInFrame: { counter: { count: number; current: number } } }).gpuTimeInFrame.counter;

/** The next reading this shader's counter receives, in milliseconds. */
async function nextReading(shader: ComputeShader, after: number): Promise<number> {
  const counter = counterOf(shader);
  for (let frame = 0; frame < 60 && counter.count === after; frame += 1) await nextFrame();
  if (counter.count === after) throw new Error(`${shader.name} never received a reading`);
  return counter.current / 1_000_000;
}

describe("deferred per-pass timing on the device", () => {
  it("gives a heavy and a trivial pass taking turns in slot 0 their own times, in both orders", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the per-pass instrument stays unverified on this host`);
    }
    const readings = await withTimedEngine(true, async ({ engine }) => {
      engine.runRenderLoop(() => {});
      const sink = new StorageBuffer(engine, SINK_INVOCATIONS * 4);
      try {
        const heavy = makeShader(engine, sink, "timing-heavy", 4096);
        const trivial = makeShader(engine, sink, "timing-trivial", 1);
        await heavy.dispatchWhenReady(4096, 1, 1);
        await trivial.dispatchWhenReady(1, 1, 1);
        for (let frame = 0; frame < 12; frame += 1) await nextFrame();
        const out: Array<{ order: string; name: string; ms: number }> = [];
        for (const order of [[heavy, trivial], [trivial, heavy]] as const) {
          for (let round = 0; round < 6; round += 1) {
            for (const shader of order) {
              const before = counterOf(shader).count;
              // One pass per frame, so each lands in slot 0 after the other.
              await new Promise<void>((resolve) => { engine.onEndFrameObservable.addOnce(() => resolve()); });
              shader.dispatch(shader === heavy ? 4096 : 1, 1, 1);
              out.push({
                order: `${order[0].name} first`,
                name: shader.name,
                ms: await nextReading(shader, before),
              });
            }
          }
        }
        return out;
      } finally {
        sink.dispose();
      }
    });
    if (!readings) {
      throw new Error("the adapter advertises timestamp-query but the device measured nothing; the control proves nothing");
    }
    for (const reading of readings) console.log(`control ${reading.order}: ${reading.name} ${reading.ms.toFixed(4)} ms`);
    const heavy = readings.filter((reading) => reading.name === "timing-heavy").map((reading) => reading.ms);
    const trivial = readings.filter((reading) => reading.name === "timing-trivial").map((reading) => reading.ms);
    expect(heavy).toHaveLength(12);
    expect(trivial).toHaveLength(12);
    // Babylon's own read gives the trivial pass the heavy pass's milliseconds
    // and the heavy pass the trivial pass's microseconds, every time.
    expect(Math.min(...heavy), "every heavy pass reads its own milliseconds").toBeGreaterThan(1);
    expect(Math.max(...trivial), "no trivial pass reads a heavy pass's time").toBeLessThan(1);
    expect(Math.min(...heavy)).toBeGreaterThan(10 * Math.max(...trivial));
  }, 120_000);

  it("reads back once per frame however many passes it times; Babylon's read once per pass", async (context) => {
    if (!(await adapterAdvertisesTimestampQuery())) {
      context.skip(`${NO_TIMESTAMP_QUERY_REASON}; the readback count stays unverified on this host`);
    }
    const PASSES = [0, 20, 44, 88];
    const FRAMES = 120;
    const arm = (deferred: boolean) => withTimedEngine(deferred, async ({ engine, timing }) => {
      const sink = new StorageBuffer(engine, SINK_INVOCATIONS * 4);
      const querySet = (engine as unknown as {
        _timestampQuery: { _measureDuration: { _querySet: { readTwoValuesAndSubtract(first: number): unknown } } };
      })._timestampQuery._measureDuration._querySet;
      const babylonRead = querySet.readTwoValuesAndSubtract.bind(querySet);
      let perPassReads = 0;
      querySet.readTwoValuesAndSubtract = (first: number) => {
        if (first >= 2) perPassReads += 1;
        return babylonRead(first);
      };
      try {
        const trivial = makeShader(engine, sink, "timing-row", 1);
        await trivial.dispatchWhenReady(1, 1, 1);
        const rows: Array<{ passes: number; intervalMs: number; perPassReadsPerFrame: number; readbacksPerFrame: number }> = [];
        for (const passes of PASSES) {
          const stamps: number[] = [];
          const readsBefore = perPassReads;
          const readbacksBefore = timing?.readbacks ?? 0;
          engine.stopRenderLoop();
          engine.runRenderLoop(() => {
            for (let pass = 0; pass < passes; pass += 1) trivial.dispatch(1, 1, 1);
          });
          const observer = engine.onEndFrameObservable.add(() => { stamps.push(performance.now()); });
          while (stamps.length < FRAMES) await nextFrame();
          // Both counts are taken when a read is ISSUED, so they close with the frames.
          const reads = perPassReads - readsBefore;
          const readbacks = (timing?.readbacks ?? 0) - readbacksBefore;
          const frames = stamps.length;
          engine.onEndFrameObservable.remove(observer);
          engine.stopRenderLoop();
          engine.runRenderLoop(() => {});
          for (let frame = 0; frame < 6; frame += 1) await nextFrame();
          const measured = stamps.slice(30);
          const intervalMs = (measured[measured.length - 1]! - measured[0]!) / (measured.length - 1);
          rows.push({
            passes,
            intervalMs,
            perPassReadsPerFrame: reads / frames,
            readbacksPerFrame: readbacks / frames,
          });
        }
        return rows;
      } finally {
        sink.dispose();
      }
    });
    const babylon = await arm(false);
    const deferred = await arm(true);
    if (!babylon || !deferred) {
      throw new Error("the adapter advertises timestamp-query but the device measured nothing");
    }
    for (const [name, rows] of [["babylon", babylon], ["deferred", deferred]] as const) {
      for (const row of rows) {
        console.log(
          `cost ${name}: ${row.passes} timed passes/frame -> ${row.intervalMs.toFixed(2)} ms interval, `
          + `${row.perPassReadsPerFrame.toFixed(2)} per-pass reads/frame, `
          + `${row.readbacksPerFrame.toFixed(2)} batched readbacks/frame`,
        );
      }
    }
    for (const row of deferred) {
      // Every frame of these rows timed at least one pass, except the zero row.
      expect(row.perPassReadsPerFrame, `deferred, ${row.passes} passes`).toBe(0);
      if (row.passes > 0) expect(row.readbacksPerFrame, `deferred, ${row.passes} passes`).toBeCloseTo(1, 1);
    }
    // The positive control: Babylon's own read does issue one per pass.
    const busiest = babylon[babylon.length - 1]!;
    expect(busiest.perPassReadsPerFrame).toBeGreaterThan(busiest.passes * 0.9);
  }, 240_000);
});
