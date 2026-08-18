/**
 * The two adaptive governors (1A-6b), replacing the deleted one-way
 * resolution ratchet (`worstFrameTimingPercentile95` fed every bottleneck —
 * including CPU-bound frames — into a resolution step that could never help,
 * so resolution walked to the floor while the frame rate stayed put).
 *
 * INVARIANT THIS FILE OWNS: resolution moves only for GPU-bound frames, CPU
 * work is shed only for CPU-bound frames, exactly one governor actuates per
 * window, a resolution step that does not buy frame time is undone and
 * latched against instead of repeated, and — R-11 — no work step is ever
 * recovered while the frame is classified GPU-bound.
 *
 * R-11 (PRE_PHASE_4_REALIGNMENT.md §3) split the old single work ladder into
 * CPU-cost and GPU-cost levers. Four of the old rungs (planar-reflection and
 * cloud-shadow cadence, shadow-caster distance, vegetation distance) are GPU
 * costs that the *CPU* governor used to walk — so on a GPU-bound frame with a
 * calm CPU the governor recovered GPU work. Worse, on the reference machine at
 * tier 1 the pixel cap binds, `resolutionInsensitive` latches immediately, and
 * Governor A had no lever at all (R-6). The GPU-cost ladder is that missing
 * actuator: it is shed while GPU-bound-and-latched (or pinned at the scale
 * floor) and recovered only from a calm, non-GPU-bound state.
 *
 * Class P: pure functions over numbers. No Babylon import, Node-testable.
 */

export type GovernorMode =
  | "gpu-resolution"
  | "cpu-work"
  | "gpu-work"
  | "balanced"
  | "holding"
  | "no-gpu-timing";

/** Window-aggregated timing signals; null means the stream was unavailable. */
export interface GovernorSignals {
  readonly gpuP95Ms: number | null;
  readonly cpuP95Ms: number | null;
  readonly intervalP95Ms: number | null;
}

export interface GovernorConfig {
  /** 13.7 ms on the 60 fps tiers, 30 ms on Ultra. */
  readonly gpuTargetMs: number;
  readonly scaleCeiling: number;
  /** Floor raised 0.62 → 0.75: below it the image degrades faster than the frame time improves. */
  readonly scaleFloor: number;
  readonly windowFrames: number;
  readonly downCooldownFrames: number;
  readonly upCooldownFrames: number;
  /** Windows before a resolution-insensitive latch re-arms (~30 s). */
  readonly insensitiveRearmWindows: number;
}

export function governorConfigForProfile(profile: {
  readonly tier: number;
  readonly renderScale: number;
}): GovernorConfig {
  return Object.freeze({
    gpuTargetMs: profile.tier === 3 ? 30 : 13.7,
    scaleCeiling: profile.renderScale,
    scaleFloor: Math.min(0.75, profile.renderScale),
    windowFrames: 120,
    downCooldownFrames: 90,
    upCooldownFrames: 240,
    insensitiveRearmWindows: 15,
  });
}

/**
 * The work levers at their current notches. Values are caps and overrides;
 * the renderer combines them with the profile via min/max so a lever can only
 * reduce work below the profile's own setting. R-11 renamed this from
 * `CpuWorkSettings`: it now aggregates two ladders with disjoint fields.
 */
export interface WorkLeverSettings {
  readonly terrainPageRequestsPerUpdate: number;
  readonly detailCellBudgetMs: number;
  readonly detailCellCap: number;
  /** null = profile default; otherwise a minimum interval in frames. */
  readonly planarReflectionIntervalFrames: number | null;
  readonly cloudShadowIntervalFrames: number | null;
  readonly activeAnimalBudgetCap: number;
  readonly shadowCasterDistanceMeters: number;
  readonly vegetationDistanceScale: number;
}

interface WorkStep {
  readonly lever: string;
  readonly apply: (settings: WorkLeverSettings) => WorkLeverSettings;
}

const FULL_QUALITY_SETTINGS: WorkLeverSettings = Object.freeze({
  // Unbounded at level 0: the streaming pump's own queue bound applies. The
  // lever's notches (8 → 4 → 2 per §5.5) engage only under CPU pressure so a
  // calm renderer keeps its pinned fill-in-one-update streaming behaviour.
  terrainPageRequestsPerUpdate: Number.POSITIVE_INFINITY,
  detailCellBudgetMs: 2,
  detailCellCap: 24,
  planarReflectionIntervalFrames: null,
  cloudShadowIntervalFrames: null,
  activeAnimalBudgetCap: Number.POSITIVE_INFINITY,
  shadowCasterDistanceMeters: Number.POSITIVE_INFINITY,
  vegetationDistanceScale: 1,
});

/**
 * Governor B's ladder — genuinely CPU-side costs only (streaming pump work,
 * worker scheduling, per-instance generation, wildlife simulation). Ordered
 * cheapest-looking damage first; each lever is exhausted before the next.
 */
const CPU_WORK_LADDER: readonly WorkStep[] = Object.freeze([
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 8 }) },
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 4 }) },
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 2 }) },
  { lever: "detail-cell-budget", apply: (s) => ({ ...s, detailCellBudgetMs: 1.25, detailCellCap: 16 }) },
  { lever: "detail-cell-budget", apply: (s) => ({ ...s, detailCellBudgetMs: 0.75, detailCellCap: 8 }) },
  { lever: "animal-budget", apply: (s) => ({ ...s, activeAnimalBudgetCap: 48 }) },
  { lever: "animal-budget", apply: (s) => ({ ...s, activeAnimalBudgetCap: 16 }) },
]);

/**
 * The GPU-cost ladder (R-11): render passes and draw volume. Shed when the
 * frame is GPU-bound and Governor A has no resolution lever left (latched
 * resolution-insensitive, or pinned at the scale floor).
 */
const GPU_WORK_LADDER: readonly WorkStep[] = Object.freeze([
  { lever: "planar-reflection-cadence", apply: (s) => ({ ...s, planarReflectionIntervalFrames: 5 }) },
  { lever: "planar-reflection-cadence", apply: (s) => ({ ...s, planarReflectionIntervalFrames: 8 }) },
  { lever: "cloud-shadow-cadence", apply: (s) => ({ ...s, cloudShadowIntervalFrames: 3 }) },
  { lever: "cloud-shadow-cadence", apply: (s) => ({ ...s, cloudShadowIntervalFrames: 4 }) },
  { lever: "shadow-caster-distance", apply: (s) => ({ ...s, shadowCasterDistanceMeters: 1_800 }) },
  { lever: "shadow-caster-distance", apply: (s) => ({ ...s, shadowCasterDistanceMeters: 1_200 }) },
  { lever: "vegetation-distance", apply: (s) => ({ ...s, vegetationDistanceScale: 0.75 }) },
]);

export const CPU_WORK_MAX_LEVEL = CPU_WORK_LADDER.length;
export const GPU_WORK_MAX_LEVEL = GPU_WORK_LADDER.length;

function settingsForLadder(
  ladder: readonly WorkStep[],
  level: number,
  base: WorkLeverSettings,
  label: string,
): WorkLeverSettings {
  if (!Number.isInteger(level) || level < 0 || level > ladder.length) {
    throw new RangeError(`${label} work level must be an integer in [0, ${ladder.length}]`);
  }
  let settings = base;
  for (let step = 0; step < level; step += 1) {
    settings = ladder[step]!.apply(settings);
  }
  return settings;
}

/** The combined lever settings for the two ladder positions (fields are disjoint). */
export function workLeverSettingsFor(cpuLevel: number, gpuLevel: number): WorkLeverSettings {
  const cpuApplied = settingsForLadder(CPU_WORK_LADDER, cpuLevel, FULL_QUALITY_SETTINGS, "CPU");
  return Object.freeze(settingsForLadder(GPU_WORK_LADDER, gpuLevel, cpuApplied, "GPU"));
}

/** The lever that moved when the CPU ladder reached `level` (null at level 0). */
export function cpuWorkLeverName(level: number): string | null {
  if (level <= 0) return null;
  return CPU_WORK_LADDER[Math.min(level, CPU_WORK_MAX_LEVEL) - 1]?.lever ?? null;
}

/** The lever that moved when the GPU ladder reached `level` (null at level 0). */
export function gpuWorkLeverName(level: number): string | null {
  if (level <= 0) return null;
  return GPU_WORK_LADDER[Math.min(level, GPU_WORK_MAX_LEVEL) - 1]?.lever ?? null;
}

interface PendingScaleProbe {
  readonly preStepGpuP95Ms: number;
  readonly preStepScale: number;
}

export interface GovernorState {
  readonly renderScale: number;
  readonly cpuWorkLevel: number;
  /** R-11: the GPU-cost ladder position. */
  readonly gpuWorkLevel: number;
  readonly mode: GovernorMode;
  readonly resolutionInsensitive: boolean;
  readonly lastLever: string | null;
  /** Frame-denominated cooldown clock, advanced one window at a time. */
  readonly framesSinceScaleChange: number;
  readonly pendingProbe: PendingScaleProbe | null;
  readonly ineffectiveDownSteps: number;
  /** Scale to restore when the latch fires (from before the first ineffective step). */
  readonly restoreScale: number | null;
  readonly insensitiveWindowsRemaining: number;
  readonly cpuHotWindows: number;
  readonly cpuCalmWindows: number;
  readonly gpuHotWindows: number;
  readonly gpuCalmWindows: number;
}

export function createGovernorState(config: GovernorConfig): GovernorState {
  return Object.freeze({
    renderScale: config.scaleCeiling,
    cpuWorkLevel: 0,
    gpuWorkLevel: 0,
    mode: "balanced" as GovernorMode,
    resolutionInsensitive: false,
    lastLever: null,
    // Start past both cooldowns so the first genuinely bound window may act.
    framesSinceScaleChange: Number.MAX_SAFE_INTEGER / 2,
    pendingProbe: null,
    ineffectiveDownSteps: 0,
    restoreScale: null,
    insensitiveWindowsRemaining: 0,
    cpuHotWindows: 0,
    cpuCalmWindows: 0,
    gpuHotWindows: 0,
    gpuCalmWindows: 0,
  });
}

const GPU_BOUND_RATIO = 1.15;
const DOWN_STEP = 0.05;
const UP_STEP = 0.025;
const DOWN_TRIGGER_RATIO = 1.1;
const UP_TRIGGER_RATIO = 0.8;
/** A downward step must buy at least this fraction of GPU time to count. */
const MIN_STEP_IMPROVEMENT = 0.04;
/** Below this synthesised GPU estimate the frame is CPU-bound by definition. */
const MIN_GPU_PROXY_MS = 2;
const CPU_CALM_MS = 6;
const CPU_HOT_WINDOWS_REQUIRED = 2;
const CPU_CALM_WINDOWS_REQUIRED = 4;
const GPU_HOT_WINDOWS_REQUIRED = 2;
const GPU_CALM_WINDOWS_REQUIRED = 4;

type Classification = "gpu-bound" | "cpu-bound" | "balanced" | "unknown";

interface ResolvedSignals {
  readonly gpuMs: number | null;
  readonly synthesised: boolean;
  readonly classification: Classification;
}

function resolveSignals(signals: GovernorSignals): ResolvedSignals {
  const cpu = signals.cpuP95Ms;
  let gpu = signals.gpuP95Ms;
  let synthesised = false;
  if (gpu === null) {
    if (signals.intervalP95Ms === null || cpu === null) {
      return { gpuMs: null, synthesised: false, classification: "unknown" };
    }
    // No timestamp queries: infer the GPU's share from the presentation
    // cadence. A tiny remainder means the CPU is the whole story — the case
    // the deleted ratchet used to answer by lowering resolution.
    const proxy = Math.max(0, signals.intervalP95Ms - cpu);
    if (proxy < MIN_GPU_PROXY_MS) {
      return { gpuMs: null, synthesised: true, classification: "cpu-bound" };
    }
    gpu = proxy;
    synthesised = true;
  }
  if (cpu === null) {
    return { gpuMs: gpu, synthesised, classification: "gpu-bound" };
  }
  if (gpu > cpu * GPU_BOUND_RATIO) return { gpuMs: gpu, synthesised, classification: "gpu-bound" };
  if (cpu > gpu * GPU_BOUND_RATIO) return { gpuMs: gpu, synthesised, classification: "cpu-bound" };
  return { gpuMs: gpu, synthesised, classification: "balanced" };
}

/**
 * One decision per completed sample window. Returns the next state; the
 * caller applies `renderScale`/`cpuWorkLevel`/`gpuWorkLevel` differences to
 * the engine and reports downward-step effectiveness through
 * `observeRenderScaleApplication`.
 */
export function nextGovernorDecision(
  state: GovernorState,
  signals: GovernorSignals,
  config: GovernorConfig,
): GovernorState {
  const resolved = resolveSignals(signals);
  let next: GovernorState = {
    ...state,
    framesSinceScaleChange: state.framesSinceScaleChange + config.windowFrames,
    mode: "holding",
  };

  // Re-arm the resolution-insensitive latch on a window clock.
  if (next.resolutionInsensitive) {
    const remaining = next.insensitiveWindowsRemaining - 1;
    next = remaining <= 0
      ? {
          ...next,
          resolutionInsensitive: false,
          insensitiveWindowsRemaining: 0,
          ineffectiveDownSteps: 0,
          restoreScale: null,
        }
      : { ...next, insensitiveWindowsRemaining: remaining };
  }

  // Evaluate the outstanding anti-ratchet probe before considering another
  // step: did the previous downward step actually buy GPU time?
  if (next.pendingProbe !== null && resolved.gpuMs !== null) {
    const probe = next.pendingProbe;
    const improvement =
      (probe.preStepGpuP95Ms - resolved.gpuMs) / Math.max(probe.preStepGpuP95Ms, 1e-6);
    if (improvement < MIN_STEP_IMPROVEMENT) {
      const ineffective = next.ineffectiveDownSteps + 1;
      const restoreScale = next.restoreScale ?? probe.preStepScale;
      if (ineffective >= 2) {
        // The workload is resolution-insensitive: undo the useless steps,
        // latch, and leave only the work ladders in play until the latch
        // re-arms.
        next = {
          ...next,
          renderScale: restoreScale,
          resolutionInsensitive: true,
          insensitiveWindowsRemaining: config.insensitiveRearmWindows,
          ineffectiveDownSteps: 0,
          restoreScale: null,
          pendingProbe: null,
        };
      } else {
        next = { ...next, ineffectiveDownSteps: ineffective, restoreScale, pendingProbe: null };
      }
    } else {
      next = { ...next, ineffectiveDownSteps: 0, restoreScale: null, pendingProbe: null };
    }
  }

  if (resolved.classification === "unknown") {
    return Object.freeze({ ...next, mode: "no-gpu-timing" });
  }

  if (resolved.classification === "gpu-bound") {
    // R-11 invariant: while GPU-bound, no ladder ever recovers. The only
    // question is which lever, if any, sheds.
    const gpu = resolved.gpuMs!;
    const scaleCanMove =
      !next.resolutionInsensitive && next.renderScale > config.scaleFloor + 1e-6;
    if (scaleCanMove) {
      if (
        gpu > config.gpuTargetMs * DOWN_TRIGGER_RATIO
        && next.framesSinceScaleChange >= config.downCooldownFrames
      ) {
        const lowered = Math.max(config.scaleFloor, next.renderScale - DOWN_STEP);
        return Object.freeze({
          ...next,
          renderScale: lowered,
          framesSinceScaleChange: 0,
          pendingProbe: { preStepGpuP95Ms: gpu, preStepScale: next.renderScale },
          mode: resolved.synthesised ? "no-gpu-timing" : "gpu-resolution",
          cpuHotWindows: 0,
          cpuCalmWindows: 0,
          gpuHotWindows: 0,
          gpuCalmWindows: 0,
        });
      }
    } else if (gpu > config.gpuTargetMs) {
      // Governor A has no lever (latched, or already at the floor): shed a
      // GPU-cost work lever instead — the R-6 missing actuator.
      const hot = next.gpuHotWindows + 1;
      if (hot >= GPU_HOT_WINDOWS_REQUIRED && next.gpuWorkLevel < GPU_WORK_MAX_LEVEL) {
        const level = next.gpuWorkLevel + 1;
        return Object.freeze({
          ...next,
          gpuWorkLevel: level,
          lastLever: gpuWorkLeverName(level),
          gpuHotWindows: 0,
          gpuCalmWindows: 0,
          cpuHotWindows: 0,
          cpuCalmWindows: 0,
          mode: "gpu-work",
        });
      }
      return Object.freeze({
        ...next,
        gpuHotWindows: hot,
        gpuCalmWindows: 0,
        cpuHotWindows: 0,
        mode: "gpu-work",
      });
    }
    if (
      !next.resolutionInsensitive
      && gpu < config.gpuTargetMs * UP_TRIGGER_RATIO
      && next.framesSinceScaleChange >= config.upCooldownFrames
      && next.renderScale < config.scaleCeiling - 1e-6
    ) {
      return Object.freeze({
        ...next,
        renderScale: Math.min(config.scaleCeiling, next.renderScale + UP_STEP),
        framesSinceScaleChange: 0,
        pendingProbe: null,
        mode: resolved.synthesised ? "no-gpu-timing" : "gpu-resolution",
        cpuHotWindows: 0,
        cpuCalmWindows: 0,
        gpuHotWindows: 0,
        gpuCalmWindows: 0,
      });
    }
    return Object.freeze({ ...next, mode: "holding", cpuHotWindows: 0, gpuCalmWindows: 0 });
  }

  if (resolved.classification === "cpu-bound") {
    const cpu = signals.cpuP95Ms;
    if (cpu !== null && cpu > config.gpuTargetMs) {
      const hot = next.cpuHotWindows + 1;
      if (hot >= CPU_HOT_WINDOWS_REQUIRED && next.cpuWorkLevel < CPU_WORK_MAX_LEVEL) {
        const level = next.cpuWorkLevel + 1;
        return Object.freeze({
          ...next,
          cpuWorkLevel: level,
          lastLever: cpuWorkLeverName(level),
          cpuHotWindows: 0,
          cpuCalmWindows: 0,
          mode: "cpu-work",
        });
      }
      return Object.freeze({ ...next, cpuHotWindows: hot, cpuCalmWindows: 0, mode: "cpu-work" });
    }
    if (cpu !== null && cpu < CPU_CALM_MS) {
      const calm = next.cpuCalmWindows + 1;
      if (calm >= CPU_CALM_WINDOWS_REQUIRED && next.cpuWorkLevel > 0) {
        const level = next.cpuWorkLevel - 1;
        return Object.freeze({
          ...next,
          cpuWorkLevel: level,
          lastLever: cpuWorkLeverName(level + 1),
          cpuHotWindows: 0,
          cpuCalmWindows: 0,
          mode: "cpu-work",
        });
      }
      return Object.freeze({ ...next, cpuHotWindows: 0, cpuCalmWindows: calm, mode: "holding" });
    }
    return Object.freeze({ ...next, cpuHotWindows: 0, cpuCalmWindows: 0, mode: "holding" });
  }

  // Balanced — the only state that recovers work, and never while GPU-bound
  // (R-11). GPU-cost levers recover first, and only when the GPU itself is
  // genuinely calm; then the CPU ladder, on the CPU's own calm signal.
  const cpu = signals.cpuP95Ms;
  const gpuCalm =
    resolved.gpuMs !== null && resolved.gpuMs < config.gpuTargetMs * UP_TRIGGER_RATIO;
  if (gpuCalm && next.gpuWorkLevel > 0) {
    const calm = next.gpuCalmWindows + 1;
    if (calm >= GPU_CALM_WINDOWS_REQUIRED) {
      const level = next.gpuWorkLevel - 1;
      return Object.freeze({
        ...next,
        gpuWorkLevel: level,
        lastLever: gpuWorkLeverName(level + 1),
        gpuHotWindows: 0,
        gpuCalmWindows: 0,
        mode: "gpu-work",
      });
    }
    return Object.freeze({ ...next, gpuCalmWindows: calm, gpuHotWindows: 0, mode: "balanced" });
  }
  if (cpu !== null && cpu < CPU_CALM_MS && next.cpuWorkLevel > 0) {
    const calm = next.cpuCalmWindows + 1;
    if (calm >= CPU_CALM_WINDOWS_REQUIRED) {
      const level = next.cpuWorkLevel - 1;
      return Object.freeze({
        ...next,
        cpuWorkLevel: level,
        lastLever: cpuWorkLeverName(level + 1),
        cpuHotWindows: 0,
        cpuCalmWindows: 0,
        mode: "cpu-work",
      });
    }
    return Object.freeze({ ...next, cpuCalmWindows: calm, cpuHotWindows: 0, mode: "balanced" });
  }
  return Object.freeze({ ...next, cpuHotWindows: 0, cpuCalmWindows: 0, mode: "balanced" });
}

/**
 * Feedback from `applyRenderScale` (1A-6a): when the absolute pixel cap is
 * the binding constraint, a downward `renderScale` step is a no-op on the
 * effective hardware scale. That is detectable immediately — latch without
 * waiting for two ineffective-step p95 measurements.
 */
export function observeRenderScaleApplication(
  state: GovernorState,
  changedEffectiveScale: boolean,
  config: GovernorConfig,
): GovernorState {
  if (changedEffectiveScale || state.pendingProbe === null) return state;
  return Object.freeze({
    ...state,
    renderScale: state.restoreScale ?? state.pendingProbe.preStepScale,
    resolutionInsensitive: true,
    insensitiveWindowsRemaining: config.insensitiveRearmWindows,
    ineffectiveDownSteps: 0,
    restoreScale: null,
    pendingProbe: null,
  });
}
