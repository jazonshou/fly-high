import type { QualityLevel } from "@/src/game/types";
import { resolveHardwareScalingLevel } from "@/src/render/renderScaleLevel";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "@/src/render/webgpu/core/QualityProfile";
import {
  DEFAULT_SETTINGS,
  seedToString,
  type BenchUrlRequest,
  type GameSettings,
  type RenderingMode,
} from "@/src/settings";
import type {
  BenchMode,
  BenchRendererOptions,
  BenchRunPlan,
  BenchTier,
  BenchTierIndex,
  BenchTimings,
} from "./types";

/**
 * What a `?bench=1` run flies and how its pages link: the tier table, the
 * in-memory settings for a step, every timing, the URLs, and the pinned
 * render scale. Pure; the session reads the clock and the location.
 */

export const BENCH_SCHEMA = "fly-high.bench/1";
/** Bump when what a step measures, or how, changes. */
export const BENCH_VERSION = 1;
/** FlightGame's placeholder seed (`00762m`), which has a home airport to roll from. */
export const BENCH_SEED = 0x51a7e;
/** Bump with any change to the route in path.ts, and pin the new fingerprint below. */
export const BENCH_PATH_ID = "runway-roll-climb-cruise/60-120mps/150m/v1";
/**
 * The route's fingerprint for `BENCH_SEED` on this build, standard and quick
 * (the quick route's phases are shorter, so its profile differs). A different
 * value on a player's machine is a warning, not a failure: two JS engines may
 * round the terrain's last bit differently.
 */
export const BENCH_EXPECTED_PATH_FINGERPRINTS = Object.freeze({
  standard: "bc3b4c08",
  quick: "f6c2b746",
});

export function expectedPathFingerprint(quick: boolean): string {
  return quick ? BENCH_EXPECTED_PATH_FINGERPRINTS.quick : BENCH_EXPECTED_PATH_FINGERPRINTS.standard;
}

/**
 * The four quality tiers as the settings panel reaches them. The renderer
 * resolves the tier from quality and mode; tier 3 exists only as high/ultra.
 */
export const TIER_TABLE: readonly BenchTier[] = Object.freeze([
  benchTierRow(0, "low", "balanced", "Low"),
  benchTierRow(1, "medium", "balanced", "Medium"),
  benchTierRow(2, "high", "balanced", "High"),
  benchTierRow(3, "high", "ultra", "Ultra"),
]);

function benchTierRow(
  tierIndex: BenchTierIndex,
  quality: QualityLevel,
  renderingMode: RenderingMode,
  name: string,
): BenchTier {
  return Object.freeze({ tierIndex, quality, renderingMode, name });
}

export function benchTier(tierIndex: number): BenchTier {
  const tier = TIER_TABLE[tierIndex];
  if (!Number.isInteger(tierIndex) || !tier) throw new RangeError(`No bench tier ${tierIndex}`);
  return tier;
}

export function isBenchTierIndex(value: number): value is BenchTierIndex {
  return Number.isInteger(value) && value >= 0 && value < TIER_TABLE.length;
}

/** "Medium"; "Tier 7" for a number the tier table does not have. */
export function benchTierName(tierIndex: number): string {
  return isBenchTierIndex(tierIndex) ? benchTier(tierIndex).name : `Tier ${tierIndex}`;
}

/**
 * A step's game settings: the defaults with only the tier's quality and
 * mode changed. Held in memory for the page load; never saved, so a player's
 * own settings never reach the measurement and the bench never reaches them.
 */
export function benchGameSettings(tierIndex: number): GameSettings {
  const tier = benchTier(tierIndex);
  return { ...DEFAULT_SETTINGS, quality: tier.quality, renderingMode: tier.renderingMode };
}

export function benchProfile(tierIndex: number): WebGpuQualityProfile {
  const tier = benchTier(tierIndex);
  return resolveWebGpuQualityProfile(tier.quality, tier.renderingMode);
}

const STANDARD_TIMINGS: BenchTimings = Object.freeze({
  quick: false,
  rollEndS: 15,
  climbEndS: 30,
  flightS: 75,
  ground: Object.freeze({ name: "ground", startS: 3, endS: 15 }),
  air: Object.freeze({ name: "air", startS: 30, endS: 75 }),
  settleMinS: 4,
  settleCapS: 20,
  settleCheckS: 1,
  settleCheckFrames: 120,
  settleStableChecks: 3,
  settleInstanceTolerance: 0.01,
  earlyStopAtS: 20,
  earlyStopFromS: 3,
  earlyStopMinFps: 5,
  startupWatchdogS: 120,
  failurePauseS: 5,
  betweenStepsS: 1.5,
  refreshProbeStepMs: 1_000,
  refreshProbePageMs: 2_000,
  maxAttempts: 2,
} satisfies BenchTimings);

/**
 * `quick=1`, for development: the same shape, compressed. Its reports say
 * non-standard. Its rest checks are 30 frames apart, not 120: four checks
 * 120 frames apart from 2 s need a steady 60 fps to fit under the 8 s cap,
 * and one dropped frame put the last past it.
 */
const QUICK_TIMINGS: BenchTimings = Object.freeze({
  ...STANDARD_TIMINGS,
  quick: true,
  rollEndS: 5,
  climbEndS: 10,
  flightS: 20,
  ground: Object.freeze({ name: "ground", startS: 1, endS: 5 }),
  air: Object.freeze({ name: "air", startS: 10, endS: 20 }),
  settleMinS: 2,
  settleCapS: 8,
  settleCheckFrames: 30,
  earlyStopAtS: 8,
  earlyStopFromS: 1,
} satisfies BenchTimings);

export function benchTimings(quick: boolean): BenchTimings {
  return quick ? QUICK_TIMINGS : STANDARD_TIMINGS;
}

/** The parts of a request or plan the URLs carry. */
export type BenchUrlOptions = Pick<BenchUrlRequest, "tiers" | "mode" | "hud" | "quick">;

export function benchRunPlan(options: BenchUrlOptions): BenchRunPlan {
  const timings = benchTimings(options.quick);
  return {
    tiers: [...options.tiers],
    mode: options.mode,
    hud: options.hud,
    quick: options.quick,
    seed: seedToString(BENCH_SEED).toLowerCase(),
    pathId: BENCH_PATH_ID,
    pathFingerprint: expectedPathFingerprint(options.quick),
    flightSeconds: timings.flightS,
    windows: { ground: timings.ground, air: timings.air },
    settleCapSeconds: timings.settleCapS,
  };
}

// --- URLs --------------------------------------------------------------------

const BENCH_PARAMS = new Set(["bench", "run", "step", "seed", "tiers", "mode", "hud", "quick"]);

function benchQuery(options: BenchUrlOptions, head: string): string {
  // Built by hand rather than through URLSearchParams so the tier list keeps
  // its commas: the URL is something a person reads and edits.
  return `?bench=1${head}&tiers=${options.tiers.join(",")}&mode=${options.mode}`
    + `${options.hud ? "" : "&hud=0"}${options.quick ? "&quick=1" : ""}`;
}

function pagePath(href: string): string {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`;
}

export function introUrl(href: string, options: BenchUrlOptions): string {
  return pagePath(href) + benchQuery(options, "");
}

/** A step page carries the bench seed too, so the address shows the world it flies. */
export function stepUrl(href: string, runId: string, stepIndex: number, options: BenchUrlOptions): string {
  const seed = seedToString(BENCH_SEED).toLowerCase();
  return pagePath(href) + benchQuery(options, `&run=${runId}&step=${stepIndex}&seed=${seed}`);
}

export function reportUrl(href: string, runId: string, options: BenchUrlOptions): string {
  return pagePath(href) + benchQuery(options, `&run=${runId}&step=report`);
}

/** Exit: the bare page, the normal game. */
export function exitUrl(href: string): string {
  return pagePath(href);
}

/**
 * Parameters on a bench URL that the bench does not honour (`world`,
 * `landforms`, `farSward`, another `seed`, anything else), as `name=value`
 * for the report. The step URLs leave them out, so the renderer never sees
 * them either.
 */
export function ignoredBenchParams(href: string): string[] {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    return [];
  }
  const benchSeed = seedToString(BENCH_SEED).toLowerCase();
  const ignored = new Set<string>();
  for (const [name, value] of params) {
    if (name === "seed" ? value.toLowerCase() === benchSeed : BENCH_PARAMS.has(name)) continue;
    ignored.add(`${name.slice(0, 32)}=${value.slice(0, 32)}`);
  }
  return [...ignored].sort();
}

/** Ten base-36 characters; `random` is injectable for tests. */
export function newRunId(random: () => number = defaultRandom): string {
  let id = "";
  for (let index = 0; index < 10; index += 1) {
    id += Math.min(35, Math.floor(random() * 36)).toString(36);
  }
  return id;
}

function defaultRandom(): number {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 0x1_0000_0000;
  }
  return Math.random();
}

// --- pinned mode -------------------------------------------------------------

export interface PinnedScale {
  /** The `pinnedRenderScale` to create the renderer with, within [0.1, 2]. */
  readonly scale: number;
  /** The tier's pixel cap sets the rendered size: true except on small canvases. */
  readonly pixelCapBinds: boolean;
  /** Pixels the renderer will rasterise at that scale. */
  readonly renderPixels: number;
  readonly aspectRatio: number;
}

/** The range `setPinnedRenderScaleForCapture` validates; creation checks nothing (N5). */
const PINNED_SCALE_MIN = 0.1;
const PINNED_SCALE_MAX = 2;

/**
 * Pinned mode renders the tier's whole pixel budget (1.0 / 1.5 / 2.4 / 4.0
 * Mpx) on every device, whatever its window: a scale 1% past the one at
 * which the pixel cap binds, so the cap, not the scale, sets the size
 * (`resolveHardwareScalingLevel`). The canvas keeps its own size and aspect.
 */
export function pinnedRenderScaleFor(
  profile: Pick<WebGpuQualityProfile, "maxRenderPixels" | "maxDevicePixelRatio">,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): PinnedScale {
  const pixelRatio = Math.min(profile.maxDevicePixelRatio, devicePixelRatio || 1);
  const cssPixels = Math.max(1, cssWidth * cssHeight);
  const capScale = Math.sqrt(profile.maxRenderPixels / cssPixels);
  const scale = Math.min(PINNED_SCALE_MAX, Math.max(PINNED_SCALE_MIN, (1.01 * capScale) / pixelRatio));
  const level = resolveHardwareScalingLevel({
    maxDevicePixelRatio: profile.maxDevicePixelRatio,
    devicePixelRatio,
    renderScale: scale,
    cssWidth,
    cssHeight,
    maxRenderPixels: profile.maxRenderPixels,
  });
  return {
    scale,
    pixelCapBinds: Math.max(0.1, pixelRatio * scale) >= capScale,
    renderPixels: cssPixels / (level * level),
    aspectRatio: cssHeight > 0 ? cssWidth / cssHeight : 0,
  };
}

/**
 * The options a step spreads into `FlightRenderer.create`. Shipped mode adds
 * nothing (passing `captureGpuTiming` to an unpinned renderer throws). Pinned
 * mode pins the scale and asks for GPU timing; `gpuTiming: false` is the
 * retry after the per-pass timer failed to install, legal on a pinned renderer.
 */
export function benchRendererOptions(
  mode: BenchMode,
  tierIndex: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  gpuTiming = true,
): BenchRendererOptions {
  if (mode === "shipped") return {};
  const pinned = pinnedRenderScaleFor(benchProfile(tierIndex), cssWidth, cssHeight, devicePixelRatio);
  return { pinnedRenderScale: pinned.scale, captureGpuTiming: gpuTiming };
}

// --- settle ------------------------------------------------------------------

/** What one rest check reads: `getDiagnostics()`, or the probe if it carries these. */
export interface SettleSample {
  readonly pendingTerrainPages: number;
  readonly pendingDetailWork: number;
  readonly visibleInstances: number;
}

export interface SettleProgress {
  readonly checks: number;
  /** Consecutive calm checks. */
  readonly calm: number;
  readonly lastVisibleInstances: number | null;
  readonly lastCheckMs: number | null;
  readonly lastCheckFrame: number | null;
  readonly last: SettleSample | null;
}

export const SETTLE_START: SettleProgress = Object.freeze({
  checks: 0,
  calm: 0,
  lastVisibleInstances: null,
  lastCheckMs: null,
  lastCheckFrame: null,
  last: null,
});

/**
 * Whether a rest check is due, `elapsedMs` and `frames` counted from the
 * settle's start. Checks are at least a second apart, and in addition at
 * least `settleCheckFrames` apart unless the counters are cheap to read: a
 * `getDiagnostics()` walks the GPU memory inventory and the detail cells, and
 * on a slow machine a once-a-second spike lands in every governor window
 * (critique S7).
 */
export function settleCheckDue(
  timings: BenchTimings,
  progress: SettleProgress,
  elapsedMs: number,
  frames: number,
  cheapCounters: boolean,
): boolean {
  if (elapsedMs < timings.settleMinS * 1_000) return false;
  if (progress.lastCheckMs !== null && elapsedMs - progress.lastCheckMs < timings.settleCheckS * 1_000) {
    return false;
  }
  return cheapCounters
    || progress.lastCheckFrame === null
    || frames - progress.lastCheckFrame >= timings.settleCheckFrames;
}

/**
 * The perf agent's rest rule in wall time: nothing pending and the visible
 * instance count unchanged since the last check. The count may move by
 * `settleInstanceTolerance`, because wildlife moves while the aircraft holds
 * still (N8). The first check is never calm: it has nothing to compare with.
 */
export function recordSettleCheck(
  timings: BenchTimings,
  progress: SettleProgress,
  elapsedMs: number,
  frames: number,
  sample: SettleSample,
): SettleProgress {
  const previous = progress.lastVisibleInstances;
  const steady = previous !== null
    && Math.abs(sample.visibleInstances - previous)
      <= Math.max(0, previous) * timings.settleInstanceTolerance;
  const calm = sample.pendingTerrainPages === 0 && sample.pendingDetailWork === 0 && steady;
  return {
    checks: progress.checks + 1,
    calm: calm ? progress.calm + 1 : 0,
    lastVisibleInstances: sample.visibleInstances,
    lastCheckMs: elapsedMs,
    lastCheckFrame: frames,
    last: sample,
  };
}

/** "rest" after enough calm checks; "cap" at the time limit, which is not a failure. */
export function settleOutcome(
  timings: BenchTimings,
  progress: SettleProgress,
  elapsedMs: number,
): "rest" | "cap" | null {
  if (progress.calm >= timings.settleStableChecks) return "rest";
  if (elapsedMs >= timings.settleCapS * 1_000) return "cap";
  return null;
}

// --- how long it takes -------------------------------------------------------

/** Per-step phases outside the flight, in seconds: typical and slow machines. */
const STEP_OVERHEAD = Object.freeze({
  pageLoad: 1.5,
  saving: 2,
  bootTypical: 8,
  bootWorst: 30,
  // A first check at 4 s, then three calm ones 120 frames apart: at 60 Hz no settle ends before 10 s.
  settleTypical: 10,
});
/** The report page's own refresh probe and render. */
const REPORT_PAGE_S = 3;

function stepSeconds(timings: BenchTimings, worst: boolean): number {
  return STEP_OVERHEAD.pageLoad
    + timings.refreshProbeStepMs / 1_000
    + (worst ? STEP_OVERHEAD.bootWorst : STEP_OVERHEAD.bootTypical)
    + (worst ? timings.settleCapS : STEP_OVERHEAD.settleTypical)
    + timings.flightS
    + STEP_OVERHEAD.saving
    + timings.betweenStepsS;
}

/** What the intro promises: a typical machine, and one that is slow to start and to settle. */
export function estimateBenchDuration(
  stepCount: number,
  timings: BenchTimings,
): { readonly typicalS: number; readonly worstS: number } {
  const steps = Math.max(0, stepCount);
  return {
    typicalS: steps * stepSeconds(timings, false) + REPORT_PAGE_S,
    worstS: steps * stepSeconds(timings, true) + REPORT_PAGE_S,
  };
}

/**
 * The run chip's "about 4 min left": what this step still has, then typical
 * steps and the report. Before its flight a step has used `thisStepElapsedS`
 * of a typical step, but its whole flight is still ahead; from the flight's
 * first frame the flight clock says what is left (`flightElapsedS`, the
 * flight's length once it is over).
 */
export function estimateRemainingSeconds(
  timings: BenchTimings,
  stepsAfterThis: number,
  thisStepElapsedS: number,
  flightElapsedS: number | null = null,
): number {
  const afterFlight = STEP_OVERHEAD.saving + timings.betweenStepsS;
  const thisStep = flightElapsedS === null
    ? Math.max(timings.flightS + afterFlight, stepSeconds(timings, false) - Math.max(0, thisStepElapsedS))
    : Math.max(0, timings.flightS - flightElapsedS) + afterFlight;
  return thisStep + Math.max(0, stepsAfterThis) * stepSeconds(timings, false) + REPORT_PAGE_S;
}

/** "about 7 minutes", "about a minute", "under a minute". */
export function describeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 45) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
}
