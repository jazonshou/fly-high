/**
 * `G0-2` (RESOLUTION_PLAN.md §Gate 0) — pay only for the GPU timings something reads.
 *
 * `enableGPUTimingMeasurements` is all-or-nothing in Babylon: the `ComputeShader`
 * constructor gives EVERY compute shader a `gpuTimeInFrame` counter whenever the
 * flag is on (`Compute/computeShader.pure.js`), and a counter is not a passive
 * observer. In `WebGPUEngine.computeDispatch` both halves are gated on it:
 *
 *     if (gpuPerfCounter) { this._timestampQuery.startPass(descriptor, index); }
 *     ... dispatch ...
 *     if (gpuPerfCounter) { this._timestampQuery.endPass(index, gpuPerfCounter); }
 *
 * `endPass` reaches `WebGPUQuerySet.readTwoValuesAndSubtract`, whose synchronous
 * prefix is `createCommandEncoder` + `resolveQuerySet` + `copyBufferToBuffer` +
 * `device.queue.submit`, followed by an `await buffer.mapAsync`. So each timed
 * dispatch costs an out-of-band queue submit and a GPU->CPU readback, every
 * frame, whether or not anyone ever looks at the number.
 *
 * A calibrated probe on the reference host puts that at ~0.49 ms per timed pass
 * with a near-zero intercept (20 passes -> 9.9 ms, 44 -> 21.1 ms, 88 -> 43.2 ms).
 * At tier 1 the spectral ocean alone averages 44 dispatches per frame — 14 FFT
 * stages plus evolution and derivation, over four cascades on a 1/1/2/4 cadence —
 * and NOTHING reads their counters. That is the single largest line item in the
 * frame, bought for nothing.
 *
 * Exactly three counters are consumed when an explicit timing diagnostic is
 * active:
 *
 * | counter                                   | consumer                              |
 * |-------------------------------------------|---------------------------------------|
 * | `engine.gpuTimeInFrameForMainPass`        | `gpuPassMs.mainPass`                  |
 * | the shadow render target's                | `gpuPassMs.shadows`                   |
 * | `TerrainPageAtlas` + `PageOcclusionBake`  | `ComputeBudget.observeDispatchCostMs` |
 *
 * Shipping leaves the all-or-nothing observer off and the governor uses its
 * tested interval-minus-CPU proxy; compute admission falls back to bounded seed
 * estimates. During an explicit diagnostic, {@link withoutDispatchTiming}
 * still drops counters outside that table so the observer does not multiply
 * into dozens of unused dispatch readbacks.
 *
 * Adding a consumer for a dispatch's cost means removing its
 * `withoutDispatchTiming` call, not adding a new mechanism.
 */

/** The one field of Babylon's `ComputeShader` this policy touches. */
interface DispatchTimingCarrier {
  gpuTimeInFrame?: unknown;
}

export interface GpuTimingStartupInput {
  readonly timestampQuerySupported: boolean;
  readonly captureGpuTiming: boolean | undefined;
  readonly pinnedCapture: boolean;
}

/**
 * Resolves the one safe startup-time telemetry switch.
 *
 * Babylon records timestamp writes into the *next* frame's command encoder,
 * then destroys the shared query set when its runtime flag is turned off.
 * Consequently a late toggle can submit an encoder that references a
 * destroyed query set. Shipping gameplay starts without continuous Babylon
 * timing: a controlled reference capture measured a 4.7 ms p95 / 38%
 * throughput tax for only 49 resolved samples in 240 frames. Pinned
 * diagnostic captures can explicitly opt in before device creation.
 */
export function gpuTimingEnabledAtStartup(input: GpuTimingStartupInput): boolean {
  if (input.captureGpuTiming === false && !input.pinnedCapture) {
    throw new Error("GPU timing can only be disabled on a pinned capture renderer");
  }
  if (input.captureGpuTiming === true && !input.pinnedCapture) {
    throw new Error("Continuous GPU timing can only be enabled on a pinned diagnostic capture");
  }
  return input.timestampQuerySupported && input.captureGpuTiming === true;
}

/**
 * Drop a compute shader's per-dispatch GPU timer.
 *
 * Returns the same instance so it can wrap a construction expression:
 *
 * ```ts
 * this.shader = withoutDispatchTiming(new ComputeShader(...));
 * ```
 *
 * Call only where no consumer reads the counter. A dispatch whose cost feeds
 * `ComputeBudget` must stay timed or the admission meter goes back to reporting
 * its seed estimates forever.
 */
export function withoutDispatchTiming<T>(shader: T): T {
  const carrier = shader as DispatchTimingCarrier;
  if (carrier.gpuTimeInFrame !== undefined) carrier.gpuTimeInFrame = undefined;
  return shader;
}

/**
 * True when this shader still carries a per-dispatch timer.
 *
 * Test-facing: `tests/render.gpu-timing-policy.test.ts` uses it to hold the
 * table above honest in both directions.
 */
export function hasDispatchTiming(shader: unknown): boolean {
  return (shader as DispatchTimingCarrier | null)?.gpuTimeInFrame !== undefined;
}
