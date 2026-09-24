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
 * Babylon's own `endPass` reaches `WebGPUQuerySet.readTwoValuesAndSubtract`,
 * whose synchronous prefix is `createCommandEncoder` + `resolveQuerySet` +
 * `copyBufferToBuffer` + `device.queue.submit`, followed by an `await
 * buffer.mapAsync`: an out-of-band submit and a GPU->CPU readback per timed
 * dispatch, every frame. Worse, that resolve runs before the pass it reads, so
 * the number is the slot's PREVIOUS occupant
 * (docs/findings/BABYLON_PASS_TIMESTAMP_ORDER_2026_09_22.md). Wherever timing
 * is on, `DeferredPassTiming` now replaces that read with one resolve and one
 * readback per frame, after the frame is submitted.
 *
 * What the per-pass read costs, re-measured 2026-09-23 on the reference host
 * (M2 Pro, headless Chromium, 8.33 ms base interval; each arm the first WebGPU
 * engine on its own page, tests/gpu/deferred-pass-timing-babylon-reads.test.ts
 * and tests/gpu/deferred-pass-timing-deferred-reads.test.ts): Babylon's read at
 * 20 / 44 / 88 timed passes per frame gave 8.33 / 8.33 / 13.1 ms; the deferred
 * read gave 8.33-8.34 ms at every count, with exactly one readback per frame.
 * That run was UNDER LOAD (Firefox's GPU helper at 48-50% of a core, the GPU
 * 20-36% busy), so re-take the 88-pass figure on a quiet host before quoting
 * its digits; the claim is the shape, flat for the deferred read and a climb
 * at 88 for Babylon's. (The 2026-09-22 figures, 8.33 / 8.34 / 12.37, came from
 * the second and third engines on one page, which inherit the first's
 * timestamp state.) The earlier synthetic law of ~0.49 ms per timed pass
 * (20 -> 9.9 ms, 44 -> 21.1, 88 -> 43.2; RESOLUTION_PLAN.md section 3.2) did
 * not reproduce: here the per-pass reads were free up to 44 and cost ~5 ms at
 * 88. At tier 1 the spectral ocean alone
 * averages 44 dispatches per frame — 14 FFT stages plus evolution and
 * derivation, over four cascades on a 1/1/2/4 cadence — and NOTHING reads
 * their counters, so they are still dropped: a counter nobody reads costs
 * query slots and deliveries for nothing.
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
