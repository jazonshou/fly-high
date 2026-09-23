// Side-effect import: registers the compute pipeline methods.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  type DeferredPassTiming,
  installDeferredPassTiming,
} from "../../src/render/webgpu/core/DeferredPassTiming";
import { gpuTimingAvailable, nextFrame, timestampQueryForcedOff } from "./terrainPageErosionGpuHarness";

/**
 * The rig the per-pass timing tests share (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md).
 * ONE engine per test file: Babylon's compute pass descriptor is a module-level
 * object shared by every engine on a page, and its timestamp writes are
 * rewritten only for timed shaders, so a second engine on the page inherits
 * the first's query set (docs/findings/BREACH_PIT_ADMISSION_2026_09_22.md).
 * Each arm of the readback cost measurement therefore has its own file.
 */

export interface TimedEngine {
  readonly engine: WebGPUEngine;
  readonly timing: DeferredPassTiming | null;
}

export async function withTimedEngine<T>(
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

export const SINK_INVOCATIONS = 4096 * 64;
export function makeShader(engine: WebGPUEngine, sink: StorageBuffer, name: string, iterations: number): ComputeShader {
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

export const counterOf = (shader: ComputeShader) =>
  (shader as unknown as { gpuTimeInFrame: { counter: { count: number; current: number } } }).gpuTimeInFrame.counter;

/** The next reading this shader's counter receives, in milliseconds. */
export async function nextReading(shader: ComputeShader, after: number): Promise<number> {
  const counter = counterOf(shader);
  for (let frame = 0; frame < 60 && counter.count === after; frame += 1) await nextFrame();
  if (counter.count === after) throw new Error(`${shader.name} never received a reading`);
  return counter.current / 1_000_000;
}

/** Timed passes per frame the readback cost is measured at, and frames per row. */
export const READBACK_PASSES = [0, 20, 44, 88] as const;
const FRAMES = 120;

export interface ReadbackCostRow {
  readonly passes: number;
  readonly intervalMs: number;
  readonly perPassReadsPerFrame: number;
  readonly readbacksPerFrame: number;
}

/**
 * One arm of the readback cost: Babylon's own per-pass read (`deferred`
 * false) or the deferred timing's one batched readback per frame (true), with
 * the frame interval and both read counts per row of timed passes.
 */
export const readbackCostRows = (deferred: boolean) => withTimedEngine(deferred, async ({ engine, timing }) => {
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
    const rows: ReadbackCostRow[] = [];
    for (const passes of READBACK_PASSES) {
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

export function logReadbackCost(name: string, rows: readonly ReadbackCostRow[]): void {
  for (const row of rows) {
    console.log(
      `cost ${name}: ${row.passes} timed passes/frame -> ${row.intervalMs.toFixed(2)} ms interval, `
      + `${row.perPassReadsPerFrame.toFixed(2)} per-pass reads/frame, `
      + `${row.readbacksPerFrame.toFixed(2)} batched readbacks/frame`,
    );
  }
}
