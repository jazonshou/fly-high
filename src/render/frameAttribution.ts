export interface PresentFrameAttribution {
  /** Present-to-present wall-clock interval. */
  readonly intervalMs: number | null;
  /** CPU update/submission time, clipped to the interval for attribution. */
  readonly cpuBusyMs: number | null;
  /** GPU timestamp duration, clipped to the interval when available. */
  readonly gpuBusyMs: number | null;
  /**
   * Residual after the slower of the overlapping CPU/GPU streams. This is
   * compositor/present pacing plus any work neither counter observes; it is
   * intentionally null when a GPU timestamp is unavailable or cannot be
   * correlated with this exact present interval.
   */
  readonly presentWaitMs: number | null;
}

function nonNegativeFinite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reconciles an interval without pretending overlapping CPU and GPU work add. */
export function attributePresentFrame(
  intervalMilliseconds: number | null,
  cpuMilliseconds: number | null,
  gpuMilliseconds: number | null,
): PresentFrameAttribution {
  const interval = nonNegativeFinite(intervalMilliseconds);
  const cpu = nonNegativeFinite(cpuMilliseconds);
  const gpu = nonNegativeFinite(gpuMilliseconds);
  if (interval === null || interval === 0) {
    return { intervalMs: null, cpuBusyMs: cpu, gpuBusyMs: gpu, presentWaitMs: null };
  }
  const cpuBusy = cpu === null ? null : Math.min(interval, cpu);
  const gpuBusy = gpu === null ? null : Math.min(interval, gpu);
  return {
    intervalMs: interval,
    cpuBusyMs: cpuBusy,
    gpuBusyMs: gpuBusy,
    presentWaitMs: cpuBusy === null || gpuBusy === null
      ? null
      : Math.max(0, interval - Math.max(cpuBusy, gpuBusy)),
  };
}
