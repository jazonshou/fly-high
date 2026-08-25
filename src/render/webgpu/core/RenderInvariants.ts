import { findWebGpuLimitShortfalls } from "./Capabilities";

/**
 * Startup render invariants (1A-2, extended by 1C-4 and 4-0).
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
  /**
   * Whether support must imply continuous timing. Defaults to true; the only
   * false caller is a pinned observer-cost capture that labels the opt-out.
   */
  readonly gpuTimingRequired?: boolean;
  /** Features the renderer asked the device for. */
  readonly requestedFeatures: readonly string[];
  /** Features the device actually granted. */
  readonly grantedFeatures: readonly string[];
  /**
   * 1C-4: `imageProcessingConfiguration.applyByPostProcess` once the tone-map
   * post-process exists. The aerial-perspective hook fires after
   * pbrBlockImageProcessing, which must be a clamp-only pass — haze composed
   * onto tone-mapped colour is wrong everywhere at once. Omit before the
   * post-process chain exists.
   */
  readonly imageProcessingAppliedByPostProcess?: boolean;
  /**
   * 1C-4: `scene.fogMode`, which must be FOGMODE_NONE (0). `fogFragment`
   * runs immediately before the aerial hook; any other mode double-fogs
   * every PBR fragment. Omit before the scene exists.
   */
  readonly sceneFogMode?: number;
  /**
   * 2-8: whether `engine._generateMipmaps` exists (Babylon private API). The
   * ocean's slope/moment cascades are storage textures, which can only be
   * written at mip 0 — the render-based generator is the only mip path, and
   * losing it in a Babylon bump would silently un-filter distant water.
   * Omit on engines that never run the ocean compute (NullEngine tests).
   */
  readonly oceanMipGenerationAvailable?: boolean;
  /**
   * `4-0`: the limits the ADAPTER reported, checked against
   * `REQUIRED_WEBGPU_LIMITS`. The device runs at spec defaults (the renderer
   * passes `setMaximumLimits: false`), so an adapter that cannot meet the
   * declared floors means Phase 4's atlases cannot be allocated — and without
   * this check, that is discovered as a texture-creation failure on a user's
   * machine rather than as a named refusal at startup. Omit where no probe
   * ran.
   */
  readonly reportedLimits?: Readonly<Record<string, number>>;
}

/** Babylon's Scene.FOGMODE_NONE, restated as data so this file stays Class P. */
export const FOG_MODE_NONE = 0;

/**
 * Returns every violated invariant as a human-readable failure. Empty means
 * the startup state is coherent.
 */
export function collectStartupInvariantFailures(
  input: StartupInvariantInput,
): readonly string[] {
  const failures: string[] = [];

  // Enabled-without-support always reports garbage. Disabled-with-support is
  // normally forbidden because it blinds Governor A and perf capture; a
  // pinned, explicitly labelled observer-cost A/B may waive only that half.
  const gpuTimingMismatch = input.gpuTimingEnabled
    ? !input.timestampQuerySupported
    : input.timestampQuerySupported && (input.gpuTimingRequired ?? true);
  if (gpuTimingMismatch) {
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

  if (
    input.imageProcessingAppliedByPostProcess !== undefined
    && !input.imageProcessingAppliedByPostProcess
  ) {
    failures.push(
      "Image processing is not applied by post-process; the aerial-perspective hook "
      + "would compose haze onto tone-mapped colour instead of linear HDR",
    );
  }

  if (input.sceneFogMode !== undefined && input.sceneFogMode !== FOG_MODE_NONE) {
    failures.push(
      `scene.fogMode is ${input.sceneFogMode} but must be FOGMODE_NONE (${FOG_MODE_NONE}); `
      + "Babylon fog and the aerial-perspective include would both apply",
    );
  }

  if (
    input.oceanMipGenerationAvailable !== undefined
    && !input.oceanMipGenerationAvailable
  ) {
    failures.push(
      "engine._generateMipmaps is missing (Babylon private API changed); the ocean's "
      + "slope cascades cannot be mipped and distant water would silently un-filter — "
      + "re-verify the 2-8 mip path against the new Babylon version",
    );
  }

  for (const shortfall of findWebGpuLimitShortfalls(input.reportedLimits ?? {})) {
    failures.push(
      `WebGPU limit ${shortfall.limit} is ${shortfall.reported}, below the `
      + `${shortfall.required} the renderer declares; Phase 4's page atlases do not fit`,
    );
  }

  return failures;
}

/** Throws with every violated invariant listed, or returns silently. */
export function assertStartupInvariants(input: StartupInvariantInput): void {
  const failures = collectStartupInvariantFailures(input);
  if (failures.length === 0) return;
  throw new Error(`Render startup invariants violated:\n- ${failures.join("\n- ")}`);
}
