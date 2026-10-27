/**
 * The two adaptive governors (1A-6b), replacing the deleted one-way
 * resolution ratchet (`worstFrameTimingPercentile95` fed every bottleneck —
 * including CPU-bound frames — into a resolution step that could never help,
 * so resolution walked to the floor while the frame rate stayed put).
 *
 * INVARIANT THIS FILE OWNS: resolution moves only for GPU-bound frames, CPU
 * work is shed only for CPU-bound frames, exactly one governor actuates per
 * window, a resolution step that does not buy frame time is undone and
 * latched against instead of repeated, and — R-11, then PR B — no work step
 * is ever recovered except on cadence, one rung at a time and on trial.
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
 * PR B (G1, plan §4.2) judges every window against the presentation cadence
 * first. A window with at most 5% of its frames late is ON CADENCE: nothing
 * is shed, and after four calm windows one shed rung comes back on trial,
 * kept only while the windows after it stay on cadence. Before, work came
 * back only in a "balanced" class that a vsync-locked 60 Hz frame almost
 * never reaches (R5 §2.7: the CPU ladder never, the GPU ladder only with a
 * render() p95 of 7.75-8.92 ms), so a machine that met 60 fps kept every
 * rung it had ever shed. Off cadence the window is classified as before,
 * except that the interval-minus-CPU proxy and the raw pacing interval no
 * longer share a label (P9), and a render() p95 over the GPU target sheds
 * the CPU ladder first: vsync puts the presented p95 on a whole refresh, so
 * the proxy alone read CPU-bound 60 Hz hosts as GPU-bound.
 *
 * Class P: pure functions over numbers. No Babylon import, Node-testable.
 */

import {
  PRESENTATION_HEADROOM_MS,
  SLOWEST_TRUSTED_DISPLAY_PERIOD_MS,
  cadenceFloorMs,
  type PresentationCadence,
} from "./presentationCadence";
// Type-only: QualityProfile.ts imports presentationCadence, never this file.
import type { WebGpuQualityProfile } from "./QualityProfile";

export type GovernorMode =
  | "gpu-resolution"
  | "cpu-work"
  | "gpu-work"
  | "frame-pacing"
  // Only the initial mode since PR B: the on-cadence class replaced the
  // balanced one. Kept so the bench's mode tables still read it.
  | "balanced"
  | "on-cadence"
  | "holding"
  | "no-gpu-timing";

/** Window-aggregated timing signals; null means the stream was unavailable. */
export interface GovernorSignals {
  readonly gpuP95Ms: number | null;
  readonly cpuP95Ms: number | null;
  readonly intervalP95Ms: number | null;
  /** PR B: the window's mean presented interval. Absent in callers that predate it. */
  readonly intervalMeanMs?: number | null;
  /** PR B: the share of the window's presented intervals over `lateIntervalMs`. */
  readonly lateFraction?: number | null;
  /**
   * PR B: detail cells, ground-cover rows and terrain pages still waiting
   * when the window closed. A streaming rung's trial waits for it to settle,
   * because that rung's cost arrives with the streaming.
   */
  readonly streamingBacklog?: number | null;
}

export interface GovernorConfig {
  /**
   * 13.7 ms on the 60 fps tiers, 30 ms on Ultra; at the 30 fps setting the
   * paced interval less 3.33 ms (30 ms where 30 divides the refresh rate).
   */
  readonly gpuTargetMs: number;
  /**
   * Pilot-visible cadence: 60 Hz on tiers 0-2, 30 Hz on Ultra; at the 30 fps
   * setting the paced interval (33.3 ms where 30 divides the refresh rate,
   * 40 ms at 75 Hz).
   */
  readonly presentationTargetMs: number;
  /**
   * PR B part 2: the tier's own presentation target, before any cadence
   * moves it: 16.67 ms, 33.3 ms on Ultra. A profile refresh interval counts
   * frames at this target.
   */
  readonly tierPresentationTargetMs: number;
  /** PR B: a presented interval longer than this is late (`lateIntervalFor`). */
  readonly lateIntervalMs: number;
  readonly scaleCeiling: number;
  /** Floor raised 0.62 → 0.75: below it the image degrades faster than the frame time improves. */
  readonly scaleFloor: number;
  /**
   * PR B part 2 (G4): the profile's governor pixel floor ratio. Informational
   * for now: `scaleFloor` does not derive from it yet.
   */
  readonly pixelFloorRatio: number;
  readonly windowFrames: number;
  readonly downCooldownFrames: number;
  readonly upCooldownFrames: number;
  /** Windows before a resolution-insensitive latch re-arms (~30 s). */
  readonly insensitiveRearmWindows: number;
  /**
   * PR B: a ladder's backoff after its first, second, and third or later
   * failed trial; how long a strike lasts; and how soon after a passed trial
   * a re-shed fails it. Set in seconds and counted in windows of frames at
   * the paced interval, so a fast panel does not retry a failing rung more
   * often: 15/30/60, 60 and 15 windows at 60 fps, 18/36/72, 72 and 18 at 72.
   */
  readonly recoveryBackoffWindows: readonly number[];
  readonly strikeForgivenAfterWindows: number;
  readonly lateFailureWindows: number;
  /**
   * PR B: CPU recovery needs render() p95 at or under this: 0.9 of the
   * target (15 ms at 60 Hz), or of the longest interval still on time
   * where that is shorter (12.5 ms at 144 Hz, where a frame either makes
   * two refreshes or is late).
   */
  readonly cpuRecoveryCeilingMs: number;
  /**
   * Wave R: a pinned capture freezes the WHOLE governor, not just the render
   * scale. Z-1's rule is "deterministic shipping pixels — no governor may
   * rewrite the target", but only the scale was ever pinned: on a slow
   * capture host (the CI runner's ~28 ms frames) the work ladders still
   * walked — compute budget, cloud-shadow cadence, shadow caster distance,
   * vegetation distance — and the CI render diverged from the committed
   * baseline (ground-2m-lowsun SSIM 0.93, dusk shadows + pulled-in tree
   * line). Frozen, the governor measures but never steps.
   */
  readonly frozen?: boolean;
}

/**
 * The tier's targets, moved only by a cadence slower than them: the 30 fps
 * setting, which raises Medium's 16.67 ms to 33.3 ms. A null cadence, which
 * captures, perf:ab and perf:flight always have, gives exactly the tier's
 * own numbers. The GPU target keeps Ultra's present/compositor headroom and
 * is rounded to whole microseconds so Ultra's stays exactly 30. The
 * recovery spans follow the paced interval, which a cadence moves either
 * way (72 fps at 144 Hz, 30 at the 30 fps setting).
 */
export function governorConfigForProfile(
  profile: Pick<WebGpuQualityProfile, "tier" | "renderScale" | "governorPixelFloorRatio">,
  cadence: PresentationCadence | null = null,
): GovernorConfig {
  const tierPresentationMs = profile.tier === 3 ? 1_000 / 30 : 1_000 / 60;
  const tierGpuMs = profile.tier === 3 ? 30 : 13.7;
  const floorMs = cadenceFloorMs(cadence);
  const slower = floorMs > tierPresentationMs + 1e-9;
  const presentationTargetMs = slower ? floorMs : tierPresentationMs;
  const lateIntervalMs = lateIntervalFor(presentationTargetMs, cadence);
  const windowFrames = 120;
  // A window's length when its frames come at the paced interval.
  const period = cadence?.displayPeriodMs ?? null;
  const pacedMs = period === null ? presentationTargetMs : Math.min(presentationTargetMs, cadence!.divisor * period);
  const windowMs = windowFrames * pacedMs;
  const windowsFor = (seconds: number): number => Math.max(1, Math.round((seconds * 1_000) / windowMs + 1e-9));
  return Object.freeze({
    gpuTargetMs: slower
      ? Math.max(tierGpuMs, Math.round((floorMs - PRESENTATION_HEADROOM_MS) * 1_000) / 1_000)
      : tierGpuMs,
    presentationTargetMs,
    tierPresentationTargetMs: tierPresentationMs,
    lateIntervalMs,
    scaleCeiling: profile.renderScale,
    scaleFloor: Math.min(0.75, profile.renderScale),
    pixelFloorRatio: profile.governorPixelFloorRatio,
    windowFrames,
    downCooldownFrames: 90,
    upCooldownFrames: 240,
    insensitiveRearmWindows: 15,
    recoveryBackoffWindows: Object.freeze(RECOVERY_BACKOFF_SECONDS.map(windowsFor)),
    strikeForgivenAfterWindows: windowsFor(STRIKE_FORGIVEN_AFTER_SECONDS),
    lateFailureWindows: windowsFor(LATE_FAILURE_SECONDS),
    cpuRecoveryCeilingMs: CPU_RECOVERY_RATIO
      * Math.min(presentationTargetMs, onTimeIntervalFor(presentationTargetMs, lateIntervalMs, cadence)),
  });
}

/** The backoff after a ladder's first, second, and third or later unforgiven failed trial. */
const RECOVERY_BACKOFF_SECONDS: readonly number[] = Object.freeze([30, 60, 120]);
/** One strike is forgiven after this long without a failure on the ladder. */
const STRIKE_FORGIVEN_AFTER_SECONDS = 120;
/** A ladder shed again this soon after passing a trial failed it, just late. */
const LATE_FAILURE_SECONDS = 30;
/**
 * CPU recovery needs render() p95 within this share of the presentation
 * target: 15 ms at 60 Hz. The red team's dead band was the old gate of 0.8 x
 * 13.7 = 10.96 ms, which kept every CPU rung shed on machines between 11 and
 * 16.7 ms that met 60 fps; the trial guards the rest.
 */
const CPU_RECOVERY_RATIO = 0.9;

/** Without a trusted display period, late means 15% over the target: 19.17 ms, or 38.3 ms on Ultra. */
const UNTRUSTED_LATE_RATIO = 1.15;

/**
 * An observed period under this (128 Hz) cannot be two refreshes of a panel
 * up to 240 Hz. Half a refresh past a doubled period is a whole refresh of
 * the real one: 144 Hz observed as 72 put Ultra's threshold on 34.72 ms,
 * exactly five refreshes.
 */
const SINGLE_REFRESH_OBSERVED_MS = 2_000 / 240 - 0.5;

/**
 * When a presented interval counts as late (PR B; red team finding 1).
 *
 * With a trusted display period P, half a refresh past the slowest whole
 * multiple of P the target allows: 25 ms at 60 Hz, 20.8 ms at 120 Hz paced
 * to 60, 17.4 ms at 144 Hz paced to 72. Vsync puts every interval on a
 * multiple of P, so the threshold sits half a refresh from all of them and
 * timestamp jitter cannot decide a frame. Without one, 15% over the target,
 * lowered by the same rule only for a period observed faster than 128 Hz:
 * intervals cannot beat the display, but what a slow machine observes on a
 * fast panel is a multiple of its period, not the period, and trusting it
 * would read 48 fps on a 144 Hz panel as on time.
 */
function lateIntervalFor(targetMs: number, cadence: PresentationCadence | null): number {
  const period = latePeriodMs(cadence);
  if (period === null) return UNTRUSTED_LATE_RATIO * targetMs;
  const placed = halfRefreshPast(targetMs, period);
  return trustedDisplayPeriodMs(cadence) !== null ? placed : Math.min(UNTRUSTED_LATE_RATIO * targetMs, placed);
}

/** The period the late threshold is placed between the multiples of: trusted, or observed faster than 128 Hz. */
function latePeriodMs(cadence: PresentationCadence | null): number | null {
  const trusted = trustedDisplayPeriodMs(cadence);
  if (trusted !== null) return trusted;
  const observed = cadence?.displayPeriodMs ?? null;
  return observed !== null && observed < SINGLE_REFRESH_OBSERVED_MS ? observed : null;
}

/**
 * The longest presented interval that is still on time: the last whole
 * refresh under the late threshold, or the target without a period to
 * count refreshes of. 16.67 ms at 60 and 120 Hz, 13.89 ms at 144 Hz.
 */
function onTimeIntervalFor(targetMs: number, lateMs: number, cadence: PresentationCadence | null): number {
  const period = latePeriodMs(cadence);
  return period === null ? targetMs : Math.floor(lateMs / period + 1e-9) * period;
}

function halfRefreshPast(targetMs: number, periodMs: number): number {
  const allowedMs = targetMs + 0.5 * Math.min(targetMs, periodMs);
  return (Math.floor(allowedMs / periodMs + 1e-9) + 0.5) * periodMs;
}

/** The period `cadenceFloorMs` trusts too: confirmed, and no slower than 57 Hz unless the cap is 30. */
function trustedDisplayPeriodMs(cadence: PresentationCadence | null): number | null {
  const period = cadence?.periodConfirmed ? cadence.displayPeriodMs : null;
  if (period === null || period === undefined) return null;
  return period <= SLOWEST_TRUSTED_DISPLAY_PERIOD_MS || cadence!.frameCapHz === 30 ? period : null;
}

/**
 * Whether two configs judge a window against the same targets, to 1%. The
 * late threshold alone moving (the 60 fps setting on a 120 Hz panel) keeps
 * the window in flight, whose intervals are on time against either.
 */
export function sameGovernorTargets(a: GovernorConfig, b: GovernorConfig): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 0.01 * Math.max(x, y);
  return close(a.presentationTargetMs, b.presentationTargetMs) && close(a.gpuTargetMs, b.gpuTargetMs);
}

/**
 * The work levers at their current notches. R-11 renamed this from
 * `CpuWorkSettings`: it now aggregates two ladders with disjoint fields.
 *
 * PR B (G3): every lever but the page-request budget is RELATIVE to the
 * profile, a factor or an added interval that `resolveGovernedWork`
 * (src/render/governedWork.ts) turns into the subsystem's value. The old
 * absolute caps were no-ops wherever the tier's own value was already at or
 * below them: with worker detail generation, six of tier 0's sixteen rungs
 * shed nothing (an animal cap of 48 against a budget of 16, a caster cap of
 * 1,800 m against 900 m of shadow), and each cost the governor two windows.
 * At level 0 every field is its identity, so the subsystems see the profile.
 */
export interface WorkLeverSettings {
  /** An absolute cap on page requests per update; the pump's own queue bound applies at ∞. */
  readonly terrainPageRequestsPerUpdate: number;
  /** A factor on the profile's detail-generation slice, cells and milliseconds alike. */
  readonly detailBudgetScale: number;
  /** Frames added to the tier's cloud-shadow update interval. */
  readonly cloudShadowExtraFrames: number;
  /** A factor on the profile's active-animal budget. */
  readonly animalBudgetScale: number;
  /** A factor on the profile's terrain shadow distance, for which casters are kept. */
  readonly shadowCasterDistanceScale: number;
  readonly vegetationDistanceScale: number;
  /**
   * `6-9` (wave-P `P-5`, unimplemented until now): a multiplier on the
   * ground-cover altitude gate — the last rung on the GPU ladder, after
   * `vegetationDistanceScale`, exactly where the wave-P plan put it.
   *
   * **This was wave G's second recorded debt.** The blade field is the
   * renderer's only per-frame compute client and its cost is quadratic in the
   * gate (the gate scales ring radii AND per-lane survival), so it is the
   * single most responsive GPU lever in the renderer — and the governor had
   * no way to touch it. The scale multiplies the altitude gate rather than
   * replacing the tier's law, which is what keeps lattice sizes, buffer
   * capacities and the compute dispatch count fixed while the lever moves:
   * a lever that reallocated GPU buffers on a governor step would spend more
   * than it saved.
   *
   * Last on the ladder because it is the most visible of the GPU costs at the
   * pose that matters — the 2 m eye — and because the compute rung above it
   * (rung 0) already defers the same client's dispatches. This rung is what
   * remains when deferring is not enough.
   */
  readonly groundCoverGateScale: number;
  /**
   * `4-0b`, GPU ladder rung 0: a multiplier on the SHARED amortised-compute
   * cap (`ComputeBudget`). 1 is the published `FRAME_BUDGET_MS` compute rows.
   *
   * This is deliberately the first thing the GPU ladder touches. Deferring a
   * page bake by a frame is invisible; every other rung on this ladder is
   * something the pilot can see — cloud shadows updating more slowly, near
   * objects dropping out of the shadow map, the treeline retreating. Before
   * this rung existed the governor's first response to a compute spike was to
   * cut one of those.
   */
  readonly computeBudgetScale: number;
  /**
   * PR B part 2 (G5, GPU): a factor on the cloud view march's step count; the
   * step lengths grow by the inverse, so rays keep their reach.
   */
  readonly cloudMarchScale: number;
  /**
   * PR B part 2 (G5, CPU): presented frames added to the sun-shadow (CSM)
   * refresh interval, after the profile's is converted to the cadence.
   */
  readonly shadowRefreshExtraFrames: number;
  /** PR B part 2 (G5, CPU): presented frames added to the cloud-scene-depth refresh interval, likewise. */
  readonly cloudDepthRefreshExtraFrames: number;
  /** PR B part 2 (G5, CPU): a factor on the profile's CDLOD node budget. */
  readonly cdlodNodeBudgetScale: number;
  /** PR B part 2 (G5, CPU): a factor on the profile's CDLOD split threshold in pixels; above 1 is coarser. */
  readonly cdlodPixelThresholdScale: number;
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
  detailBudgetScale: 1,
  cloudShadowExtraFrames: 0,
  animalBudgetScale: 1,
  shadowCasterDistanceScale: 1,
  vegetationDistanceScale: 1,
  groundCoverGateScale: 1,
  computeBudgetScale: 1,
  cloudMarchScale: 1,
  shadowRefreshExtraFrames: 0,
  cloudDepthRefreshExtraFrames: 0,
  cdlodNodeBudgetScale: 1,
  cdlodPixelThresholdScale: 1,
});

/**
 * Governor B's ladder — genuinely CPU-side costs only (streaming pump work,
 * worker scheduling, per-instance generation, wildlife simulation, and since
 * PR B part 2 (G5) CDLOD selection and the CSM and cloud-depth submissions,
 * which the old ladder could not reach). Ordered cheapest-looking damage
 * first (plan §4.2): every lever's first notch comes before any lever's
 * second, so a host that needs only a little back loses only the least
 * visible cut of each.
 */
const CPU_WORK_LADDER: readonly WorkStep[] = Object.freeze([
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 8 }) },
  { lever: "cloud-depth-refresh", apply: (s) => ({ ...s, cloudDepthRefreshExtraFrames: 1 }) },
  // A held CSM lags the aircraft's own shadow by a frame, at every tier that
  // reaches this rung. Its place follows Jason's verdict on that lag (PR B
  // part 2, the CSM clip): accepted, here; rejected, this line moves to the
  // end, after page requests 2, so every tier sheds it last.
  { lever: "shadow-refresh", apply: (s) => ({ ...s, shadowRefreshExtraFrames: 1 }) },
  { lever: "detail-cell-budget", apply: (s) => ({ ...s, detailBudgetScale: 0.66 }) },
  { lever: "cdlod-node-budget", apply: (s) => ({ ...s, cdlodNodeBudgetScale: 0.85 }) },
  { lever: "animal-budget", apply: (s) => ({ ...s, animalBudgetScale: 0.5 }) },
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 4 }) },
  // The second notch also coarsens the split threshold ×4/3 (+1 px at tier
  // 1), which the terrain eases in over about 20 selections.
  { lever: "cdlod-node-budget", apply: (s) => ({ ...s, cdlodNodeBudgetScale: 0.7, cdlodPixelThresholdScale: 4 / 3 }) },
  { lever: "detail-and-animal-budget", apply: (s) => ({ ...s, detailBudgetScale: 0.33, animalBudgetScale: 0.25 }) },
  { lever: "terrain-page-requests", apply: (s) => ({ ...s, terrainPageRequestsPerUpdate: 2 }) },
]);

/**
 * The GPU-cost ladder (R-11): render passes and draw volume. Shed when the
 * frame is GPU-bound and Governor A has no resolution lever left (latched
 * resolution-insensitive, or pinned at the scale floor). PR B part 2 (G5,
 * plan §4.2) adds the cloud view march and orders the visible levers as the
 * CPU ladder is: each one's first notch before any second.
 */
const GPU_WORK_LADDER: readonly WorkStep[] = Object.freeze([
  // 4-0b rung 0: shrink the shared compute cap BEFORE any visible lever
  // moves. Two notches rather than the plan's single rung — the ladder sheds
  // one step per 120-frame window, and one notch gives the meter no room to
  // resolve a spike before the next step cuts something visible. Recorded as
  // a deviation in PHASE_4_EXECUTION_PLAN.md §4 **D15** (this comment said
  // D14 until `4.5-D`'s stale-comment sweep; the plan document's numbering is
  // authoritative and D14 is tier 0's channelAtlasSlots cut, one row over).
  { lever: "compute-budget", apply: (s) => ({ ...s, computeBudgetScale: 0.6 }) },
  { lever: "compute-budget", apply: (s) => ({ ...s, computeBudgetScale: 0.35 }) },
  // 2-10 retired the planar-reflection-cadence rungs with their system — a
  // governor lever must never be attached to nothing.
  { lever: "cloud-shadow-cadence", apply: (s) => ({ ...s, cloudShadowExtraFrames: 1 }) },
  { lever: "cloud-march", apply: (s) => ({ ...s, cloudMarchScale: 0.75 }) },
  { lever: "shadow-caster-distance", apply: (s) => ({ ...s, shadowCasterDistanceScale: 0.7 }) },
  { lever: "vegetation-distance", apply: (s) => ({ ...s, vegetationDistanceScale: 0.75 }) },
  { lever: "cloud-shadow-cadence", apply: (s) => ({ ...s, cloudShadowExtraFrames: 2 }) },
  { lever: "cloud-march", apply: (s) => ({ ...s, cloudMarchScale: 0.6 }) },
  { lever: "shadow-caster-distance", apply: (s) => ({ ...s, shadowCasterDistanceScale: 0.5 }) },
  // `6-9`/`P-5`: the ground-cover gate, last. Two notches for the same reason
  // rung 0 has two — one step per 120-frame window, and a single notch from
  // full to nothing would be a visible cliff at the one pose the whole system
  // exists for.
  { lever: "ground-cover-gate", apply: (s) => ({ ...s, groundCoverGateScale: 0.6 }) },
  { lever: "ground-cover-gate", apply: (s) => ({ ...s, groundCoverGateScale: 0.3 }) },
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

/** A downward scale step awaiting its verdict from the next window. */
export interface PendingScaleProbe {
  /** The GPU p95 in the gpu domain; the presented interval p95 in the interval domain. */
  readonly preStepGpuP95Ms: number;
  readonly preStepScale: number;
  /** Effectiveness samples must stay in one timing domain. */
  readonly metric: "gpu" | "interval";
  /** PR B (G2): the step window's mean presented interval and late share, when it had them. */
  readonly preIntervalMeanMs: number | null;
  readonly preLateFraction: number | null;
}

/** PR B: what can recover a step, one at a time: either work ladder, or the render scale. */
export type RecoveryLadder = "gpu" | "cpu" | "scale";

/** PR B (G1): a recovered step, kept only while the windows after it stay on cadence. */
export interface RecoveryTrial {
  readonly ladder: RecoveryLadder;
  /** The work level a failed trial restores (0 for the scale ladder). */
  readonly restoreLevel: number;
  /** The render scale a failed scale trial restores. */
  readonly restoreScale: number;
  readonly windowsPassed: number;
  /**
   * The rung's cost arrives with streaming (terrain pages, detail cells,
   * animals, vegetation reach), later than two windows: the trial lasts four
   * and ends once the streaming backlog has settled (red team finding 3).
   */
  readonly streaming: boolean;
  /** The streaming backlog in the window the step came back, and in the trial's latest window. */
  readonly openBacklog: number | null;
  readonly lastBacklog: number | null;
}

/** PR B (G1): one ladder's recovery record, so a rung that keeps failing waits longer each time. */
export interface LadderRecovery {
  /** Windows left before the ladder may recover again. */
  readonly backoffWindows: number;
  /** Failed trials not yet forgiven; each one picks the next, longer backoff. */
  readonly strikes: number;
  /** Windows since the last strike or the last one forgiven. */
  readonly windowsSinceStrike: number;
  /** Windows since the ladder passed a trial, while a re-shed would still fail it; else null. */
  readonly windowsSincePass: number | null;
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
  readonly gpuHotWindows: number;
  /** PR B: consecutive off-cadence windows. A scale step on presented intervals needs two. */
  readonly offCadenceWindows: number;
  /**
   * PR B: the late shares of the on-cadence windows since the last shed,
   * recovery or off-cadence window, newest last, at most four of them. One
   * window's late count is noise (binomial: 7 late frames can read as 5),
   * so recovery reads the four pooled (red team finding 6).
   */
  readonly calmStreak: readonly number[];
  readonly trial: RecoveryTrial | null;
  readonly recovery: Readonly<Record<RecoveryLadder, LadderRecovery>>;
  /**
   * PR B part 2 (G6): the last judged window was urgent, its mean presented
   * interval over 1.5× the target (or the display's own interval).
   */
  readonly urgent: boolean;
  /**
   * PR B part 2 (G6): the GPU level when the resolution-insensitive latch was
   * last set; null while it is not. A latch set before the GPU ladder reached
   * its top is stale evidence once it has.
   */
  readonly latchedAtGpuLevel: number | null;
  /**
   * PR B part 2 (G6): judged windows in a row that were off cadence with
   * nothing left to shed for the side that bound them, each with a mean
   * interval over 1.2× that reference. `EXHAUSTED_AFTER_WINDOWS` of them is
   * exhausted (`governorExhausted`).
   */
  readonly spentWindows: number;
}

const FRESH_LADDER: LadderRecovery = Object.freeze({
  backoffWindows: 0,
  strikes: 0,
  windowsSinceStrike: 0,
  windowsSincePass: null,
});

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
    gpuHotWindows: 0,
    offCadenceWindows: 0,
    calmStreak: Object.freeze([]),
    trial: null,
    recovery: Object.freeze({ gpu: FRESH_LADDER, cpu: FRESH_LADDER, scale: FRESH_LADDER }),
    urgent: false,
    latchedAtGpuLevel: null,
    spentWindows: 0,
  });
}

/** PR B part 2 (G6): spent windows in a row that make the governor exhausted. */
export const EXHAUSTED_AFTER_WINDOWS = 4;

/**
 * PR B part 2 (G6): the governor has had nothing left to shed for four
 * judged windows in a row, each well over its reference interval. What Auto
 * will read to move a machine down a tier.
 */
export function governorExhausted(state: GovernorState): boolean {
  return state.spentWindows >= EXHAUSTED_AFTER_WINDOWS;
}

const GPU_BOUND_RATIO = 1.15;
const DOWN_STEP = 0.05;
const UP_STEP = 0.025;
const DOWN_TRIGGER_RATIO = 1.1;
/** With GPU timestamps, a GPU rung or a scale step recovers only under this share of the GPU target. */
const UP_TRIGGER_RATIO = 0.8;
/** A downward step must buy at least this fraction of GPU time to count. */
const MIN_STEP_IMPROVEMENT = 0.04;
/**
 * G2: on presented intervals a step also counts when it cuts the late share
 * by a quarter, from more than 2% of frames late, and by at least 3 frames.
 * One window's late count is noise (binomial: 7 late frames can read as 5),
 * so a smaller drop is not evidence (red team finding 6).
 */
const MIN_LATE_DROP = 0.25;
const MIN_LATE_BEFORE_STEP = 0.02;
const MIN_LATE_FRAMES_DROPPED = 3;
/** `cpuShedNearGpuTarget`: render() p95 within this share of the GPU target, 12.3 ms on the 60 fps tiers. */
const CPU_SHED_NEAR_GPU_TARGET_RATIO = 0.9;
/** Below this synthesised GPU estimate the frame is CPU-bound by definition. */
const MIN_GPU_PROXY_MS = 2;
const HOT_WINDOWS_REQUIRED = 2;
/**
 * PR B: at or under this share of late frames (6 of 120) a window is on
 * cadence and nothing is shed. Under vsync it is the plan's "interval p95
 * within 2% of the target", read without the p95's two-valued jump.
 */
const ON_CADENCE_LATE_FRACTION = 0.05;
/** The same rule for signals that carry no late share. */
const ON_CADENCE_P95_RATIO = 1.02;
/** Calm windows before one step recovers, and the most their pooled late share may be. */
const RECOVER_AFTER_CALM_WINDOWS = 4;
const CALM_LATE_FRACTION = 0.025;
/** On-cadence windows that keep a recovered step; a streaming rung's trial takes longer. */
const TRIAL_WINDOWS = 2;
const STREAMING_TRIAL_WINDOWS = 4;
/**
 * The most windows a streaming trial waits past its four for the backlog
 * to settle. In flight the detail backlog rarely reads 0 (new cells keep
 * coming into reach), and an open trial holds every other recovery.
 */
const STREAMING_SETTLE_WINDOWS = 2;
const STREAMING_LEVERS: ReadonlySet<string> = new Set([
  "terrain-page-requests",
  "detail-cell-budget",
  "animal-budget",
  "vegetation-distance",
  // PR B part 2 (G5): a restored CDLOD budget raises page demand late, since
  // the selection drives which pages stay resident.
  "cdlod-node-budget",
  "detail-and-animal-budget",
]);

/**
 * How a window reads (PR B adds "on-cadence", which replaced "balanced"). The
 * bench's report labels each decision with it.
 */
export type Classification = "on-cadence" | "gpu-bound" | "cpu-bound" | "pacing-bound" | "unknown";

/**
 * Which clock a window's figure came from (P9). The interval-minus-CPU proxy
 * and the raw pacing interval are different signals; under one "interval"
 * label a CPU-bound host's pacing window could be compared with a proxy
 * window and read a 70% improvement that never happened (R5 trace2).
 */
export type GovernorMetric = "gpu" | "interval-proxy" | "interval-pacing";

export interface ResolvedSignals {
  readonly gpuMs: number | null;
  readonly synthesised: boolean;
  readonly classification: Classification;
  readonly metric: GovernorMetric | null;
}

/** PR B: at most 5% of the window's frames late, or, without a late share, a p95 within 2% of the target. */
function onCadence(signals: GovernorSignals, presentationTargetMs: number): boolean {
  const late = signals.lateFraction;
  if (late !== undefined && late !== null) return late <= ON_CADENCE_LATE_FRACTION;
  return signals.intervalP95Ms !== null
    && signals.intervalP95Ms <= presentationTargetMs * ON_CADENCE_P95_RATIO;
}

/**
 * How a window's signals read: on cadence, or which side bounds the frame,
 * and the GPU estimate the decision uses. Exported for the `?bench=1`
 * report, which labels each recorded decision with it; the governor is its
 * only caller in the game.
 */
export function resolveSignals(
  signals: GovernorSignals,
  gpuTargetMs: number,
  presentationTargetMs: number,
): ResolvedSignals {
  const cpu = signals.cpuP95Ms;
  const measured = signals.gpuP95Ms;
  const interval = signals.intervalP95Ms;
  if (measured === null && (interval === null || cpu === null)) {
    return { gpuMs: null, synthesised: false, classification: "unknown", metric: null };
  }
  const proxy = interval !== null && cpu !== null ? Math.max(0, interval - cpu) : null;
  // PR B (G1): the cadence is the outcome the governor exists to protect, so
  // it is read first. A frame that meets it is not bound by anything, however
  // the vsync wait splits between the proxy and the CPU.
  if (onCadence(signals, presentationTargetMs)) {
    return {
      gpuMs: measured ?? proxy,
      synthesised: measured === null,
      classification: "on-cadence",
      metric: null,
    };
  }
  if (measured === null) {
    // No timestamp queries, which is all of shipping gameplay: infer the
    // GPU's share from the presentation cadence. A tiny remainder means the
    // CPU is the whole story — the case the deleted ratchet used to answer by
    // lowering resolution.
    if (proxy! < MIN_GPU_PROXY_MS) {
      return { gpuMs: null, synthesised: true, classification: "cpu-bound", metric: null };
    }
    // Vsync puts the p95 on a whole refresh, 33.3 ms at 60 Hz once more than
    // 5% of frames are late, so the proxy is mostly the wait for the next
    // refresh. Split on it alone, a render() p95 of 14-17.8 ms read as
    // GPU-bound or pacing-bound and shed resolution and every GPU rung while
    // the CPU ladder never moved. A render() p95 over the GPU target is a CPU
    // cost the frame cannot hide, so the CPU ladder goes first.
    if (cpu! > gpuTargetMs) {
      return { gpuMs: proxy, synthesised: true, classification: "cpu-bound", metric: "interval-proxy" };
    }
    return splitOnProxy(cpu!, proxy!, interval!);
  }
  // Timestamp queries measure submitted GPU work, not the pilot-visible time
  // between presented frames. Browser scheduling, queue back-pressure, and
  // uninstrumented work can therefore leave both component counters looking
  // calm while presentation misses several refreshes. The interval is the
  // outcome the governor exists to protect: when it is hot and neither
  // measured component explains it, use it as a conservative presentation
  // proxy. Resolution effectiveness feedback will quickly undo/latch a step
  // that cannot improve cadence, after which the GPU-work ladder takes over.
  const componentCeiling = Math.max(cpu ?? 0, measured);
  if (
    interval !== null
    && interval > presentationTargetMs * ON_CADENCE_P95_RATIO
    && componentCeiling <= gpuTargetMs * DOWN_TRIGGER_RATIO
  ) {
    return { gpuMs: interval, synthesised: true, classification: "pacing-bound", metric: "interval-pacing" };
  }
  if (cpu === null || measured > cpu * GPU_BOUND_RATIO) {
    return { gpuMs: measured, synthesised: false, classification: "gpu-bound", metric: "gpu" };
  }
  if (cpu > measured * GPU_BOUND_RATIO) {
    return { gpuMs: measured, synthesised: false, classification: "cpu-bound", metric: "gpu" };
  }
  // Neither component explains a missed cadence: the presentation itself is the bound.
  return interval === null
    ? { gpuMs: measured, synthesised: false, classification: "gpu-bound", metric: "gpu" }
    : { gpuMs: interval, synthesised: true, classification: "pacing-bound", metric: "interval-pacing" };
}

/**
 * The split on the interval-minus-CPU proxy alone. P9: only a split that
 * neither side explains is pacing-bound; pacing no longer pre-empts a
 * CPU-dominated window.
 */
function splitOnProxy(cpu: number, proxy: number, interval: number): ResolvedSignals {
  if (proxy > cpu * GPU_BOUND_RATIO) {
    return { gpuMs: proxy, synthesised: true, classification: "gpu-bound", metric: "interval-proxy" };
  }
  if (cpu > proxy * GPU_BOUND_RATIO) {
    return { gpuMs: proxy, synthesised: true, classification: "cpu-bound", metric: "interval-proxy" };
  }
  return { gpuMs: interval, synthesised: true, classification: "pacing-bound", metric: "interval-pacing" };
}

/**
 * A CPU-bound window once the CPU ladder is spent, without timestamps.
 * While render() alone explains the miss (a p95 the CPU ladder would not
 * recover at), nothing on the GPU side can help: null, and the governor
 * holds. Under that, the proxy decides as before the CPU went first, except
 * that only a resolution step, whose effect is checked, may follow: GPU
 * rungs are not, unless steps that worked took the scale to its floor.
 */
function gpuSideOfSpentCpuWindow(signals: GovernorSignals, config: GovernorConfig): ResolvedSignals | null {
  const cpu = signals.cpuP95Ms;
  const interval = signals.intervalP95Ms;
  if (signals.gpuP95Ms !== null || cpu === null || interval === null) return null;
  if (cpu >= config.cpuRecoveryCeilingMs) return null;
  const proxy = Math.max(0, interval - cpu);
  if (proxy < MIN_GPU_PROXY_MS) return null;
  const split = splitOnProxy(cpu, proxy, interval);
  return split.classification === "cpu-bound" ? null : split;
}

/**
 * PR B part 2 (K1): a host whose CPU ladder is already shedding, with
 * render() p95 at or over 0.9 of the GPU target. Each CPU rung takes a
 * little off render(); with other main-thread work (S7b's 3 ms) the frame
 * stays a refresh late once render() has crossed under the GPU target, and
 * the interval-minus-CPU proxy, under vsync mostly the wait for the next
 * refresh, then reads it as GPU-bound. Once resolution has been shown not
 * to help, such a window keeps to the CPU ladder instead of shedding every
 * GPU rung one CPU rung short of the fix. The ten-rung ladder takes
 * render() further than the seven-rung one did, so more hosts cross that
 * line before their last rung (S7b's 18 ms host stopped at rung 9 of 10).
 */
function cpuShedNearGpuTarget(state: GovernorState, signals: GovernorSignals, config: GovernorConfig): boolean {
  const cpu = signals.cpuP95Ms;
  return state.cpuWorkLevel > 0 && cpu !== null && cpu >= CPU_SHED_NEAR_GPU_TARGET_RATIO * config.gpuTargetMs;
}

/** The timing domain a probe's two windows must share: GPU timestamps, or presented intervals. */
function probeDomain(metric: GovernorMetric | null): "gpu" | "interval" {
  return metric === "gpu" ? "gpu" : "interval";
}

/**
 * G2: did a downward step buy frame time, judged on the window after it?
 * The caller has already ruled out an on-cadence window (effective) and a
 * window from the other domain (undone). With timestamps, the GPU p95 must
 * fall 4%. On presented intervals vsync pins the p95 to a whole refresh
 * (33.3 ms at 60 Hz) however much a step helps, so the late share and the
 * mean are read as well: any one of the three falling counts.
 */
export function stepWasEffective(
  probe: PendingScaleProbe,
  signals: GovernorSignals,
  resolved: ResolvedSignals,
  windowFrames: number,
): boolean {
  if (probe.metric === "gpu") return fellBy(probe.preStepGpuP95Ms, resolved.gpuMs, MIN_STEP_IMPROVEMENT);
  const preLate = probe.preLateFraction;
  const late = signals.lateFraction ?? null;
  const lateDropped = preLate !== null
    && late !== null
    && preLate > MIN_LATE_BEFORE_STEP
    && fellBy(preLate, late, MIN_LATE_DROP)
    && (preLate - late) * windowFrames >= MIN_LATE_FRAMES_DROPPED - 1e-9;
  return lateDropped
    || fellBy(probe.preIntervalMeanMs, signals.intervalMeanMs ?? null, MIN_STEP_IMPROVEMENT)
    || fellBy(probe.preStepGpuP95Ms, signals.intervalP95Ms, MIN_STEP_IMPROVEMENT);
}

/** Whether `after` is at least `share` below `before`; false when either is missing. */
function fellBy(before: number | null, after: number | null, share: number): boolean {
  if (before === null || after === null) return false;
  return (before - after) / Math.max(before, 1e-6) >= share;
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
  // A frozen (pinned-capture) governor holds its initial state forever —
  // every lever and the scale stay at the profile's shipping values.
  if (config.frozen) return state;
  const resolved = resolveSignals(
    signals,
    config.gpuTargetMs,
    config.presentationTargetMs,
  );
  let next: GovernorState = {
    ...state,
    framesSinceScaleChange: state.framesSinceScaleChange + config.windowFrames,
    mode: "holding",
    recovery: tickRecovery(state.recovery, config),
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
  if (next.pendingProbe !== null) {
    const probe = next.pendingProbe;
    const domain = probeDomain(resolved.metric);
    const post = domain === "gpu" ? resolved.gpuMs : signals.intervalP95Ms;
    if (resolved.classification === "on-cadence") {
      // The step bought the cadence back: it was effective.
      next = { ...next, ineffectiveDownSteps: 0, restoreScale: null, pendingProbe: null };
    } else if (resolved.classification === "unknown" || domain !== probe.metric || post === null) {
      // The pre/post windows came from unrelated clocks (for example an
      // interval pacing proxy followed by a timestamp-query sample). Undo the
      // experimental scale change; accepting that comparison can manufacture
      // a fake improvement and leave image quality reduced indefinitely.
      return Object.freeze({
        ...next,
        renderScale: probe.preStepScale,
        framesSinceScaleChange: 0,
        pendingProbe: null,
        ineffectiveDownSteps: 0,
        restoreScale: null,
        mode: "holding",
      });
    } else {
      if (!stepWasEffective(probe, signals, resolved, config.windowFrames)) {
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
  }

  if (resolved.classification === "unknown") {
    return Object.freeze({ ...next, mode: "no-gpu-timing" });
  }

  const cadenceMet = resolved.classification === "on-cadence";
  if (next.trial !== null) {
    if (!cadenceMet) return failTrial(next, next.trial, config);
    next = advanceTrial(next, next.trial, signals);
  }
  return cadenceMet
    ? onCadenceDecision(next, signals, config)
    : offCadenceDecision(next, signals, resolved, config);
}

/**
 * On cadence: never shed. After four on-cadence windows whose pooled late
 * share is calm, recover one step, GPU work first, then CPU work, then
 * resolution, each on trial and each only once its ladder's backoff is over.
 */
function onCadenceDecision(
  state: GovernorState,
  signals: GovernorSignals,
  config: GovernorConfig,
): GovernorState {
  // Without a late share the window met the p95 rule, which counts as calm.
  const calmStreak = Object.freeze(
    [...state.calmStreak, signals.lateFraction ?? 0].slice(-RECOVER_AFTER_CALM_WINDOWS),
  );
  const held: GovernorState = {
    ...state,
    calmStreak,
    offCadenceWindows: 0,
    cpuHotWindows: 0,
    gpuHotWindows: 0,
    mode: "on-cadence",
  };
  if (
    state.trial !== null
    || calmStreak.length < RECOVER_AFTER_CALM_WINDOWS
    || calmStreak.reduce((sum, late) => sum + late, 0) / calmStreak.length > CALM_LATE_FRACTION
  ) {
    return Object.freeze(held);
  }
  // Without timestamps the GPU side has no gate of its own: the trial is the guard.
  const gpu = signals.gpuP95Ms;
  const gpuHeadroom = gpu === null || gpu <= config.gpuTargetMs * UP_TRIGGER_RATIO;
  const cpu = signals.cpuP95Ms;
  const recovered = { ...held, calmStreak: Object.freeze([]) };
  if (state.gpuWorkLevel > 0 && state.recovery.gpu.backoffWindows === 0 && gpuHeadroom) {
    const lever = gpuWorkLeverName(state.gpuWorkLevel);
    return Object.freeze({
      ...recovered,
      gpuWorkLevel: state.gpuWorkLevel - 1,
      lastLever: lever,
      mode: "gpu-work",
      trial: openTrial("gpu", state, lever, signals),
    });
  }
  if (
    state.cpuWorkLevel > 0
    && state.recovery.cpu.backoffWindows === 0
    && cpu !== null
    && cpu <= config.cpuRecoveryCeilingMs
  ) {
    const lever = cpuWorkLeverName(state.cpuWorkLevel);
    return Object.freeze({
      ...recovered,
      cpuWorkLevel: state.cpuWorkLevel - 1,
      lastLever: lever,
      mode: "cpu-work",
      trial: openTrial("cpu", state, lever, signals),
    });
  }
  if (
    state.renderScale < config.scaleCeiling - 1e-6
    && state.recovery.scale.backoffWindows === 0
    && state.framesSinceScaleChange >= config.upCooldownFrames
    && gpuHeadroom
  ) {
    return Object.freeze({
      ...recovered,
      renderScale: Math.min(config.scaleCeiling, state.renderScale + UP_STEP),
      framesSinceScaleChange: 0,
      pendingProbe: null,
      mode: "gpu-resolution",
      trial: openTrial("scale", state, null, signals),
    });
  }
  return Object.freeze(held);
}

/**
 * Off cadence: shed only, never recover. On presented intervals, which is
 * every shipping window, being off cadence is the trigger itself; with GPU
 * timestamps the old millisecond thresholds still apply.
 */
function offCadenceDecision(
  state: GovernorState,
  signals: GovernorSignals,
  judged: ResolvedSignals,
  config: GovernorConfig,
): GovernorState {
  const next: GovernorState = {
    ...state,
    calmStreak: Object.freeze([]),
    offCadenceWindows: state.offCadenceWindows + 1,
  };
  const spentCpuWindow = judged.classification === "cpu-bound" && next.cpuWorkLevel >= CPU_WORK_MAX_LEVEL
    ? gpuSideOfSpentCpuWindow(signals, config)
    : null;
  const resolved = spentCpuWindow ?? judged;
  const domain = probeDomain(resolved.metric);
  const intervalDomain = domain === "interval";
  if (
    resolved.classification === "gpu-bound"
    || resolved.classification === "pacing-bound"
  ) {
    const gpu = resolved.gpuMs!;
    const pacing = resolved.classification === "pacing-bound";
    const scaleCanMove =
      !next.resolutionInsensitive && next.renderScale > config.scaleFloor + 1e-6;
    if (scaleCanMove) {
      // Two windows in a row on intervals: one window's late count is noise.
      const hot = intervalDomain
        ? next.offCadenceWindows >= HOT_WINDOWS_REQUIRED
        : gpu > config.gpuTargetMs * DOWN_TRIGGER_RATIO;
      if (hot && next.framesSinceScaleChange >= config.downCooldownFrames) {
        return Object.freeze({
          ...next,
          renderScale: Math.max(config.scaleFloor, next.renderScale - DOWN_STEP),
          framesSinceScaleChange: 0,
          pendingProbe: {
            preStepGpuP95Ms: intervalDomain ? signals.intervalP95Ms ?? gpu : gpu,
            preStepScale: next.renderScale,
            metric: domain,
            preIntervalMeanMs: intervalDomain ? signals.intervalMeanMs ?? null : null,
            preLateFraction: intervalDomain ? signals.lateFraction ?? null : null,
          },
          mode: pacing
            ? "frame-pacing"
            : resolved.synthesised ? "no-gpu-timing" : "gpu-resolution",
          cpuHotWindows: 0,
          gpuHotWindows: 0,
          recovery: noteShed(next.recovery, "scale", config),
        });
      }
      return Object.freeze({ ...next, mode: "holding", cpuHotWindows: 0 });
    }
    if (spentCpuWindow !== null && next.resolutionInsensitive) {
      // render() p95 is over the GPU target and resolution did not help: a
      // GPU rung would cut what the pilot sees for a cost the main thread
      // carries. The latch holds while this lasts, so the scale is not
      // probed again every time it re-arms.
      return Object.freeze({
        ...next,
        insensitiveWindowsRemaining: config.insensitiveRearmWindows,
        mode: "cpu-work",
        cpuHotWindows: 0,
        gpuHotWindows: 0,
      });
    }
    if (
      (pacing || cpuShedNearGpuTarget(next, signals, config))
      && next.resolutionInsensitive
      && signals.gpuP95Ms === null
      && next.cpuWorkLevel < CPU_WORK_MAX_LEVEL
    ) {
      // A miss neither side explains, which resolution was shown not to fix,
      // more likely sits on the main thread: the CPU ladder goes before the
      // GPU one. So does a GPU-bound reading that only render() crossing
      // under the GPU target produced (`cpuShedNearGpuTarget`).
      return shedCpuWork(next, pacing ? "frame-pacing" : "cpu-work", config);
    }
    if (intervalDomain || gpu > config.gpuTargetMs) {
      // Governor A has no lever (latched, or already at the floor): shed a
      // GPU-cost work lever instead — the R-6 missing actuator.
      const hot = next.gpuHotWindows + 1;
      const mode: GovernorMode = pacing ? "frame-pacing" : "gpu-work";
      if (hot >= HOT_WINDOWS_REQUIRED && next.gpuWorkLevel < GPU_WORK_MAX_LEVEL) {
        const level = next.gpuWorkLevel + 1;
        return Object.freeze({
          ...next,
          gpuWorkLevel: level,
          lastLever: gpuWorkLeverName(level),
          gpuHotWindows: 0,
          cpuHotWindows: 0,
          mode,
          recovery: noteShed(next.recovery, "gpu", config),
        });
      }
      return Object.freeze({ ...next, gpuHotWindows: hot, cpuHotWindows: 0, mode });
    }
    return Object.freeze({ ...next, mode: "holding", cpuHotWindows: 0 });
  }

  // CPU-bound. Once the ladder is spent, a render() p95 that alone explains
  // the miss holds here: the GPU side cannot help.
  const cpu = signals.cpuP95Ms;
  if (intervalDomain || (cpu !== null && cpu > config.gpuTargetMs)) {
    return shedCpuWork(next, "cpu-work", config);
  }
  return Object.freeze({ ...next, mode: "holding", cpuHotWindows: 0, gpuHotWindows: 0 });
}

/** One CPU rung per two hot windows, while the ladder has one left. */
function shedCpuWork(state: GovernorState, mode: GovernorMode, config: GovernorConfig): GovernorState {
  const hot = state.cpuHotWindows + 1;
  if (hot >= HOT_WINDOWS_REQUIRED && state.cpuWorkLevel < CPU_WORK_MAX_LEVEL) {
    const level = state.cpuWorkLevel + 1;
    return Object.freeze({
      ...state,
      cpuWorkLevel: level,
      lastLever: cpuWorkLeverName(level),
      cpuHotWindows: 0,
      gpuHotWindows: 0,
      mode,
      recovery: noteShed(state.recovery, "cpu", config),
    });
  }
  return Object.freeze({ ...state, cpuHotWindows: hot, gpuHotWindows: 0, mode });
}

function openTrial(
  ladder: RecoveryLadder,
  state: GovernorState,
  lever: string | null,
  signals: GovernorSignals,
): RecoveryTrial {
  const backlog = signals.streamingBacklog ?? null;
  return Object.freeze({
    ladder,
    restoreLevel: ladder === "gpu" ? state.gpuWorkLevel : ladder === "cpu" ? state.cpuWorkLevel : 0,
    restoreScale: state.renderScale,
    windowsPassed: 0,
    streaming: lever !== null && STREAMING_LEVERS.has(lever),
    openBacklog: backlog,
    lastBacklog: backlog,
  });
}

/**
 * Whether a streaming rung's cost has arrived: the backlog is no higher
 * than when the step came back, and not growing. It need not reach 0,
 * which in flight it rarely does; and after `STREAMING_SETTLE_WINDOWS`
 * more windows the trial ends on the cadence alone.
 */
function streamingSettled(trial: RecoveryTrial, backlog: number | null, windowsPassed: number): boolean {
  if (backlog === null || windowsPassed >= STREAMING_TRIAL_WINDOWS + STREAMING_SETTLE_WINDOWS) return true;
  return backlog <= (trial.openBacklog ?? 0) && backlog <= (trial.lastBacklog ?? backlog);
}

/** An on-cadence window during a trial: it counts, and enough of them keep the step. */
function advanceTrial(state: GovernorState, trial: RecoveryTrial, signals: GovernorSignals): GovernorState {
  const windowsPassed = trial.windowsPassed + 1;
  const required = trial.streaming ? STREAMING_TRIAL_WINDOWS : TRIAL_WINDOWS;
  const backlog = signals.streamingBacklog ?? null;
  const settled = !trial.streaming || streamingSettled(trial, backlog, windowsPassed);
  if (windowsPassed < required || !settled) {
    return { ...state, trial: Object.freeze({ ...trial, windowsPassed, lastBacklog: backlog }) };
  }
  return {
    ...state,
    trial: null,
    recovery: withLadder(state.recovery, trial.ladder, {
      ...state.recovery[trial.ladder],
      windowsSincePass: 0,
    }),
  };
}

/** An off-cadence window during a trial: restore the step, strike the ladder, shed nothing else. */
function failTrial(state: GovernorState, trial: RecoveryTrial, config: GovernorConfig): GovernorState {
  const failed: GovernorState = {
    ...state,
    trial: null,
    calmStreak: Object.freeze([]),
    offCadenceWindows: state.offCadenceWindows + 1,
    cpuHotWindows: 0,
    gpuHotWindows: 0,
    recovery: strike(state.recovery, trial.ladder, config),
  };
  if (trial.ladder === "gpu") {
    return Object.freeze({
      ...failed,
      gpuWorkLevel: trial.restoreLevel,
      lastLever: gpuWorkLeverName(trial.restoreLevel),
      mode: "gpu-work",
    });
  }
  if (trial.ladder === "cpu") {
    return Object.freeze({
      ...failed,
      cpuWorkLevel: trial.restoreLevel,
      lastLever: cpuWorkLeverName(trial.restoreLevel),
      mode: "cpu-work",
    });
  }
  return Object.freeze({
    ...failed,
    renderScale: trial.restoreScale,
    framesSinceScaleChange: 0,
    mode: "gpu-resolution",
  });
}

function withLadder(
  recovery: GovernorState["recovery"],
  ladder: RecoveryLadder,
  record: LadderRecovery,
): GovernorState["recovery"] {
  return Object.freeze({ ...recovery, [ladder]: Object.freeze(record) });
}

function strike(
  recovery: GovernorState["recovery"],
  ladder: RecoveryLadder,
  config: GovernorConfig,
): GovernorState["recovery"] {
  const strikes = recovery[ladder].strikes + 1;
  const backoffs = config.recoveryBackoffWindows;
  return withLadder(recovery, ladder, {
    backoffWindows: backoffs[Math.min(strikes, backoffs.length) - 1]!,
    strikes,
    windowsSinceStrike: 0,
    windowsSincePass: null,
  });
}

/** A shed soon after the ladder passed a trial means the trial missed a cost that came late. */
function noteShed(
  recovery: GovernorState["recovery"],
  ladder: RecoveryLadder,
  config: GovernorConfig,
): GovernorState["recovery"] {
  return recovery[ladder].windowsSincePass === null ? recovery : strike(recovery, ladder, config);
}

/** One window passes for every ladder's backoff, strike and late-failure clocks. */
function tickRecovery(recovery: GovernorState["recovery"], config: GovernorConfig): GovernorState["recovery"] {
  const gpu = tickLadder(recovery.gpu, config);
  const cpu = tickLadder(recovery.cpu, config);
  const scale = tickLadder(recovery.scale, config);
  if (gpu === recovery.gpu && cpu === recovery.cpu && scale === recovery.scale) return recovery;
  return Object.freeze({ gpu, cpu, scale });
}

function tickLadder(record: LadderRecovery, config: GovernorConfig): LadderRecovery {
  if (record.backoffWindows === 0 && record.strikes === 0 && record.windowsSincePass === null) {
    return record;
  }
  const forgiven = record.strikes > 0
    && record.windowsSinceStrike + 1 >= config.strikeForgivenAfterWindows;
  const sincePass = record.windowsSincePass === null ? null : record.windowsSincePass + 1;
  return Object.freeze({
    backoffWindows: Math.max(0, record.backoffWindows - 1),
    strikes: forgiven ? record.strikes - 1 : record.strikes,
    windowsSinceStrike: forgiven || record.strikes === 0 ? 0 : record.windowsSinceStrike + 1,
    windowsSincePass: sincePass !== null && sincePass > config.lateFailureWindows ? null : sincePass,
  });
}

/**
 * Feedback from `applyRenderScale` (1A-6a): when the 0.4 Mpx minimum (G4;
 * the absolute pixel cap before it) absorbs a downward `renderScale` step,
 * the step is a no-op on the effective hardware scale. That is detectable
 * immediately — latch without waiting for two ineffective-step p95
 * measurements.
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

/**
 * PR B: a window's mean presented interval and its share of late ones,
 * from the same samples its p95 comes from. Null for an empty window.
 */
export function summariseIntervals(
  intervals: readonly number[],
  lateIntervalMs: number,
): { readonly mean: number | null; readonly late: number | null } {
  if (intervals.length === 0) return { mean: null, late: null };
  let sum = 0;
  let late = 0;
  for (const interval of intervals) {
    sum += interval;
    if (interval > lateIntervalMs) late += 1;
  }
  return { mean: sum / intervals.length, late: late / intervals.length };
}

/**
 * PR B: the presentation cadence moved the targets, so the window in flight
 * was judged against the old ones. Drop what that judgement fed: the
 * pending probe, the calm streak, the hot counts, urgency and the spent
 * count. Levels, scale, latch and recovery records stay, and an open trial
 * restarts its count rather than escaping its verdict (red team finding 11).
 */
export function rebaseGovernorState(state: GovernorState): GovernorState {
  return Object.freeze({
    ...state,
    pendingProbe: null,
    ineffectiveDownSteps: 0,
    restoreScale: null,
    cpuHotWindows: 0,
    gpuHotWindows: 0,
    offCadenceWindows: 0,
    calmStreak: Object.freeze([]),
    trial: state.trial === null ? null : Object.freeze({ ...state.trial, windowsPassed: 0 }),
    spentWindows: 0,
    urgent: false,
  });
}
