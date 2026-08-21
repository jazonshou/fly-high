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
 * Exactly three counters are consumed anywhere in this renderer:
 *
 * | counter                                   | consumer                              |
 * |-------------------------------------------|---------------------------------------|
 * | `engine.gpuTimeInFrameForMainPass`        | `gpuPassMs.mainPass`                  |
 * | the shadow render target's                | `gpuPassMs.shadows`                   |
 * | `TerrainPageAtlas` + `PageOcclusionBake`  | `ComputeBudget.observeDispatchCostMs` |
 *
 * {@link withoutDispatchTiming} drops the counter on the dispatches outside that
 * table. Render-target and main-pass timing are untouched, so `gpuFrameMsP95`
 * and the adaptive governor's GPU signal keep working — this is deliberately NOT
 * the "disable the flag" fix that `RenderInvariants` forbids and that would blind
 * Governor A.
 *
 * Adding a consumer for a dispatch's cost means removing its
 * `withoutDispatchTiming` call, not adding a new mechanism.
 */

/** The one field of Babylon's `ComputeShader` this policy touches. */
interface DispatchTimingCarrier {
  gpuTimeInFrame?: unknown;
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
