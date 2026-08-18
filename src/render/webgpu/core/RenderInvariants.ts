/**
 * Startup render invariants (1A-2, extended by 1C-4).
 *
 * INVARIANT THIS FILE OWNS: configuration states the renderer silently
 * depends on are asserted once at startup instead of being discovered as
 * mysterious behaviour later. Each check is a pure predicate over plain data
 * collected by the renderer; the renderer decides when to collect and assert.
 *
 * Class P: no Babylon import, Node-testable.
 */

export interface StartupInvariantInput {
  /** Whether the adapter advertises `timestamp-query`. */
  readonly timestampQuerySupported: boolean;
  /** The engine's `enableGPUTimingMeasurements` state after startup. */
  readonly gpuTimingEnabled: boolean;
  /** Features the renderer asked the device for. */
  readonly requestedFeatures: readonly string[];
  /** Features the device actually granted. */
  readonly grantedFeatures: readonly string[];
}

/**
 * Returns every violated invariant as a human-readable failure. Empty means
 * the startup state is coherent.
 */
export function collectStartupInvariantFailures(
  input: StartupInvariantInput,
): readonly string[] {
  const failures: string[] = [];

  // The adaptive governor's GPU signal exists exactly when timestamp queries
  // do. Enabled-without-support would silently report garbage; disabled-with-
  // support silently blinds Governor A and every perf capture.
  if (input.gpuTimingEnabled !== input.timestampQuerySupported) {
    failures.push(
      `GPU timing measurements are ${input.gpuTimingEnabled ? "enabled" : "disabled"} but `
      + `timestamp-query is ${input.timestampQuerySupported ? "supported" : "unsupported"}; `
      + "they must agree or the governor's GPU signal is wrong",
    );
  }

  const granted = new Set(input.grantedFeatures);
  for (const feature of input.requestedFeatures) {
    if (!granted.has(feature)) {
      failures.push(
        `Requested device feature "${feature}" was not granted; capability decisions made `
        + "before device creation no longer hold",
      );
    }
  }

  return failures;
}

/** Throws with every violated invariant listed, or returns silently. */
export function assertStartupInvariants(input: StartupInvariantInput): void {
  const failures = collectStartupInvariantFailures(input);
  if (failures.length === 0) return;
  throw new Error(`Render startup invariants violated:\n- ${failures.join("\n- ")}`);
}
