import type { QualityLevel, RenderDiagnostics } from "@/src/game/types";
import type { FlightRenderer } from "@/src/render/FlightRenderer";
import type { FlightRenderingSystem } from "@/src/render/types";
import type { DetailWorkerHealth } from "@/src/render/webgpu/detail/WorldDetailRuntime";
import type { Classification, GovernorConfig, GovernorMode } from "@/src/render/webgpu/core/AdaptiveGovernor";
import type { WebGpuLimitShortfall } from "@/src/render/webgpu/core/Capabilities";
import type { FrameRateCap } from "@/src/render/webgpu/core/presentationCadence";
import type { FrameRateSetting, GameSettings, RenderingMode } from "@/src/settings";
import type { WorldDefinition } from "@/src/world";

/**
 * The `?bench=1` benchmark's shared contract: what FlightGame sees of a bench
 * session, what the tab-scoped run store holds between page loads, and the
 * `fly-high.bench/2` report.
 *
 * Types only. FlightGame imports this file with `import type` and nothing
 * else of src/bench statically, so no bench code reaches a player's bundle.
 *
 * The quality tier is always `tierIndex` here, never a field named after the
 * profile's own: tests/architecture.boundaries.test.ts reads that name as a
 * tier branch anywhere outside src/render/webgpu/core, string literals
 * included.
 */

export type BenchMode = "shipped" | "pinned";

// --- what FlightGame sees ----------------------------------------------------

/** The page's game settings and world seed, held in memory only. */
export interface BenchBoot {
  /** `DEFAULT_SETTINGS` plus the step's quality and rendering mode and the run's frame rate; never saved. */
  readonly settings: GameSettings;
  readonly seed: number;
}

/** Spread into `FlightRenderer.create`'s options. Empty in shipped mode. */
export interface BenchRendererOptions {
  pinnedRenderScale?: number;
  captureGpuTiming?: boolean;
}

export interface BenchSession {
  /** Null on the intro and report pages: no renderer, no worker. */
  readonly boot: BenchBoot | null;
  /** Called once the canvas has its CSS size. */
  rendererOptions(canvas: HTMLCanvasElement): BenchRendererOptions;
  /**
   * Wraps the new renderer in the bench's recorder, which replaces the state
   * FlightGame passes to `render()` with the scripted route. Disposes
   * `renderer` itself if it throws, because nothing owns it yet.
   */
  attach(renderer: FlightRenderer, world: WorldDefinition): FlightRenderingSystem;
  /** FlightGame's error banner text, as it is set. */
  reportGameError(message: string): void;
}

// --- tiers, timings and the run plan -------------------------------------------

export type BenchTierIndex = 0 | 1 | 2 | 3;

export interface BenchTier {
  readonly tierIndex: BenchTierIndex;
  readonly quality: QualityLevel;
  readonly renderingMode: RenderingMode;
  /** The settings panel's words for it: "Low", "Medium", "High", "Ultra". */
  readonly name: string;
}

export type BenchWindowName = "ground" | "air";

/** A measured window, in seconds from the first frame of the flight. */
export interface BenchWindowSpec {
  readonly name: BenchWindowName;
  readonly startS: number;
  readonly endS: number;
}

/**
 * Every clock the bench runs to. Seconds unless the name says otherwise.
 * The route's phases are here too, because the windows are cut to them.
 */
export interface BenchTimings {
  readonly quick: boolean;
  /** The runway roll ends and the climb-out begins. */
  readonly rollEndS: number;
  /** The climb-out ends and the cruise begins. */
  readonly climbEndS: number;
  /** The flight ends at this time from its first frame. */
  readonly flightS: number;
  readonly ground: BenchWindowSpec;
  /** The headline window. */
  readonly air: BenchWindowSpec;
  /** Settle: no rest check before this. */
  readonly settleMinS: number;
  /** Settle: give up waiting for rest here; not a failure. */
  readonly settleCapS: number;
  /** Settle: at most one rest check per this many seconds... */
  readonly settleCheckS: number;
  /** ...and per this many frames (critique S7, shipped mode). */
  readonly settleCheckFrames: number;
  /** Consecutive calm checks that make rest. */
  readonly settleStableChecks: number;
  /** `visibleInstances` may move this fraction between calm checks (wildlife). */
  readonly settleInstanceTolerance: number;
  /** The early-stop check runs at this time of flight... */
  readonly earlyStopAtS: number;
  /** ...over frames from this time... */
  readonly earlyStopFromS: number;
  /** ...and stops the step below this frame rate. */
  readonly earlyStopMinFps: number;
  /** No first frame within this is a failed step. */
  readonly startupWatchdogS: number;
  /** A failed step's card shows this long before the next step. */
  readonly failurePauseS: number;
  /** "Medium done" shows this long before the next page. */
  readonly betweenStepsS: number;
  /** The idle refresh probe on a step page, before the renderer exists. */
  readonly refreshProbeStepMs: number;
  /** The idle refresh probe on the intro and report pages. */
  readonly refreshProbePageMs: number;
  /** Attempts per step after a hidden tab, a resize or a lost page load. */
  readonly maxAttempts: number;
}

/** What one run flies, fixed when it starts. */
export interface BenchRunPlan {
  readonly tiers: readonly number[];
  readonly mode: BenchMode;
  readonly hud: boolean;
  readonly quick: boolean;
  /** The frame-rate setting every flight uses (`fps=`). */
  readonly frameRate: FrameRateSetting;
  /** The world seed in the URL's base-36 form. */
  readonly seed: string;
  readonly pathId: string;
  /** The fingerprint this build expects the route to have. */
  readonly pathFingerprint: string;
  readonly flightSeconds: number;
  readonly windows: { readonly ground: BenchWindowSpec; readonly air: BenchWindowSpec };
  readonly settleCapSeconds: number;
}

// --- the run store (the tab's session storage, see store.ts) --------------------

export type BenchStepStatus =
  | "pending"
  | "running"
  | "ok"
  | "early-stop"
  | "void-hidden"
  | "void-resized"
  | "failed"
  | "interrupted"
  | "skipped";

/** Why an attempt ended without a result, one note per attempt. */
export interface BenchAttemptNote {
  readonly attempt: number;
  readonly outcome: "void-hidden" | "void-resized" | "interrupted";
  /** The next load's `navigation.type` for an interrupted attempt. */
  readonly navigationType: string | null;
  readonly at: string;
}

export interface BenchStepRecord {
  readonly index: number;
  readonly tierIndex: number;
  readonly status: BenchStepStatus;
  readonly attempts: number;
  readonly attemptLog: readonly BenchAttemptNote[];
  readonly message: string | null;
  /** Null until the step has measured something; a failed step may still have one. */
  readonly result: BenchStepResult | null;
  /**
   * Pinned mode: the renderer could not install its per-pass GPU timer, so
   * this step loads again, and every later one starts, with GPU timing off.
   * Absent until that happens.
   */
  readonly gpuTimingFailed?: boolean;
}

export type BenchRunStatus = "running" | "finished" | "stopped" | "no-webgpu" | "storage-unavailable";

/**
 * Where a page's same-origin scripts came from (critique S10). A step reads
 * it after its flight, so the renderer's workers and shader chunks count.
 */
export interface BenchHttpCache {
  readonly scripts: number;
  /** Served from the cache: `transferSize` 0. */
  readonly fromCache: number;
  /** A 304: some bytes moved, fewer than the body. */
  readonly revalidated: number;
  readonly network: number;
  readonly transferKiB: number;
}

export interface BenchFirstLoad {
  readonly navigationType: string;
  readonly httpCache: BenchHttpCache | null;
}

export interface BenchRunRecord {
  readonly v: 1;
  readonly runId: string;
  readonly plan: BenchRunPlan;
  readonly status: BenchRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** "Your computer (GPU model if you know it)", at most 80 characters. */
  readonly userLabel: string | null;
  readonly device: BenchDeviceReport | null;
  readonly introRefresh: BenchRefresh | null;
  readonly reportRefresh: BenchRefresh | null;
  readonly firstLoad: BenchFirstLoad | null;
  readonly ignoredParams: readonly string[];
  /** The settings key's hash at the intro and on the report page (settingsGuard.ts). */
  readonly settingsKeyAtStart: string | null;
  readonly settingsKeyAtEnd: string | null;
  readonly steps: readonly BenchStepRecord[];
}

export type BenchNoticeCode =
  | "run-mismatch"
  | "store-corrupt"
  | "step-out-of-order"
  | "crash-skipped"
  | "storage-failed";

/** The whole `flyhigh.bench.v1` value. */
export interface BenchStore {
  readonly v: 1;
  /** The run in progress or last finished; null after Exit or before Start. */
  readonly current: BenchRunRecord | null;
  /** Earlier runs in this tab kept for the report, e.g. the shipped run under a pinned pass (N6). */
  readonly earlier: readonly BenchRunRecord[];
  /** Shown once by the next page that renders, then cleared. */
  readonly notice: BenchNoticeCode | null;
}

// --- the controller's raw records (filled by instruments; summarised by stats.ts) --

/**
 * One entry per `render()` the recorder saw, in fixed typed arrays, so the
 * measured window allocates nothing per frame. Entry `i` is frame `i`.
 */
export interface BenchFrameLog {
  readonly capacity: number;
  length: number;
  /** A frame arrived with the arrays full; it was not recorded. */
  overflowed: boolean;
  /** The rAF timestamp of the frame the render ran in, ms (performance.now clock). */
  readonly frameTimeMs: Float64Array;
  /** performance.now() just before `inner.render()`. */
  readonly renderStartMs: Float64Array;
  /** `inner.render()`'s duration, ms. */
  readonly renderMs: Float64Array;
  /** Pipelines and shader modules created during the frame. */
  readonly compiles: Uint16Array;
  /** 1 where the rendered pixel count differs from the previous frame's. */
  readonly scaleStep: Uint8Array;
  /** A fresh GPU frame time, ms; NaN when the frame had none. */
  readonly gpuMs: Float32Array;
  /** The recorder's own time outside `inner.render()`, ms. */
  readonly overheadMs: Float32Array;
}

export interface BenchLongTaskEntry {
  readonly startMs: number;
  readonly durationMs: number;
}

export interface BenchScriptAttribution {
  readonly source: string;
  readonly invoker: string;
  readonly ms: number;
}

export interface BenchLongAnimationFrameEntry {
  readonly startMs: number;
  readonly durationMs: number;
  readonly blockingMs: number;
  readonly scripts: readonly BenchScriptAttribution[];
}

export interface BenchHeapSample {
  readonly tMs: number;
  readonly usedBytes: number;
}

/** The controller's once-a-second snapshot, merged with the frame log by stats.ts. */
export interface BenchSecondSample {
  readonly appliedScale: number;
  readonly renderPixels: number;
  readonly cpuLevel: number;
  readonly gpuLevel: number;
  readonly heapBytes: number | null;
}

export type BenchCompileKind =
  | "render"
  | "render-async"
  | "compute"
  | "compute-async"
  | "shader-module";

export interface BenchCompileCounts {
  readonly render: number;
  readonly renderAsync: number;
  readonly compute: number;
  readonly computeAsync: number;
  readonly shaderModules: number;
  readonly wgslKiB: number;
}

// --- one step's measurements ---------------------------------------------------

/**
 * A rAF loop's cadence: the rate the browser paces frames at, which the
 * panel's refresh rate only bounds (Energy Saver, Low Power Mode and VRR
 * panels can all hold it lower), hence `rafHz` (critique S8).
 */
export interface BenchRefresh {
  readonly rafHz: number;
  /** The mean of the intervals near the fastest steady cadence; `1000 / rafHz`. */
  readonly periodMs: number;
  /** Over every usable interval, outliers included. */
  readonly medianMs: number;
  readonly p10Ms: number;
  readonly p90Ms: number;
  /** Usable intervals: 1.5 ms to 1 s. */
  readonly samples: number;
  /** Usable intervals away from that cadence, left out of the period (a stall, a skipped frame). */
  readonly outliers: number;
}

/** The fastest common cadence of the flight's own rAF deltas (critique S8). */
export interface BenchFlightCadence {
  readonly hz: number;
  readonly medianMs: number;
  /** Fraction of the window's intervals in that cluster. */
  readonly share: number;
}

export interface BenchRafReport {
  /** The step's idle probe, before the renderer existed; null if it did not run. */
  readonly idleHz: number | null;
  readonly flight: BenchFlightCadence | null;
  /** The flight's cadence is not a whole multiple of the idle one, within 5%. */
  readonly disagrees: boolean;
  /** Below 50 Hz: a browser or display cap, so the step is left out of tier labels (S9). */
  readonly limited: boolean;
}

/** Timer resolution measured on the step (critique S11). */
export interface BenchTimerReport {
  readonly granularityMs: number | null;
  /** 0.5 ms or coarser: render-time statistics are noise at the low end. */
  readonly coarse: boolean;
}

export interface BenchStartupStage {
  readonly label: string;
  readonly kind: "sync" | "async";
  readonly ms: number;
}

export interface BenchStartup {
  readonly navigationType: string;
  readonly httpCache: BenchHttpCache | null;
  /**
   * The renderer's startup trace. The first stage also holds the bench's own
   * boot and React's first commit, because the trace begins before them (N10).
   */
  readonly rendererStages: readonly BenchStartupStage[];
  readonly navToAttachMs: number | null;
  readonly navToFirstFrameMs: number | null;
  readonly navToSettleEndMs: number | null;
  readonly pathPrecomputeMs: number | null;
  /** Pipelines and shader modules created before the first frame's render. */
  readonly compiles: BenchCompileCounts;
}

export interface BenchSettle {
  readonly reachedRest: boolean;
  readonly ms: number;
  readonly frames: number;
  readonly checks: number;
  readonly pendingTerrainPages: number | null;
  readonly pendingDetailWork: number | null;
  readonly visibleInstances: number | null;
  /** From the first frame's render through the settle's last frame. */
  readonly compiles: BenchCompileCounts;
  readonly longTasks: { readonly count: number; readonly totalMs: number } | null;
  readonly governorDecisions: number;
}

export type BenchGpuTiming = "on" | "off" | "unsupported" | "install-failed";

export interface BenchCanvas {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  /** Equal pixel counts at different aspect ratios are not equal GPU work (N5). */
  readonly aspectRatio: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly renderPixels: number;
  /** The tier's pixel cap sets the rendered size (always meant to in pinned mode). */
  readonly pixelCapBinds: boolean;
  readonly pinnedRenderScale: number | null;
  readonly gpuTiming: BenchGpuTiming;
}

export type BenchWakeLock = "held" | "denied" | "unsupported" | "lost";

export interface BenchEnvironment {
  readonly hiddenEvents: number;
  readonly focusLostMs: number;
  readonly resizes: number;
  readonly dprChanges: number;
  readonly wakeLock: BenchWakeLock;
  /** Keys the capture-phase blocker swallowed (critique S6). */
  readonly keysBlocked: number;
  /** Renderer setters dropped after the first frame. */
  readonly ignoredRendererCalls: number;
  readonly gameErrors: readonly string[];
  readonly overflowed: boolean;
  readonly battery: { readonly charging: boolean; readonly level: number } | null;
}

export interface BenchCount {
  readonly count: number;
  readonly per240: number;
  readonly perMinute: number;
}

export interface BenchIntervalSummary {
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly p999: number;
  readonly max: number;
}

export interface BenchRenderSummary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** The timer is 0.5 ms or coarser, so the low percentiles are noise. */
  readonly coarse: boolean;
}

export interface BenchGpuSummary {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * Intervals in paced slots: one slot is `divisor` refresh periods, so a
 * flight paced to every 2nd refresh lands in x1 when it keeps up.
 */
export interface BenchVsyncBuckets {
  /** The pacer's divisor at the flight's first frame; 1 draws every refresh. */
  readonly divisor: number;
  readonly x1: number;
  readonly x2: number;
  readonly x3: number;
  readonly x4plus: number;
  /** A whole number of refreshes between two slots: a frame that missed its slot by a refresh or more. */
  readonly offSlot: number;
  readonly irregular: number;
  /** max(3% of the refresh period, twice the timer granularity). */
  readonly toleranceMs: number;
}

/** Interval statistics on frames that created pipelines against frames that did not (S10). */
export interface BenchCompileSplit {
  readonly withCompiles: { readonly frames: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null };
  readonly withoutCompiles: { readonly frames: number; readonly p50: number | null; readonly p95: number | null; readonly max: number | null };
}

/** One window's frame metrics. The ground and air windows have the same shape. */
export interface BenchWindowMetrics {
  readonly name: BenchWindowName;
  readonly startS: number;
  readonly endS: number;
  readonly frames: number;
  /** Seconds the window's intervals cover. */
  readonly seconds: number;
  /** Fewer than six frames a second. */
  readonly lowSample: boolean;
  /** 1000 / mean interval. */
  readonly fps: number | null;
  /**
   * The median interval sits on the paced slot (the pacer's divisor times
   * the refresh period): the display and the frame-rate setting, not the
   * game, set the pace.
   */
  readonly displayCapped: boolean;
  readonly intervalMs: BenchIntervalSummary | null;
  readonly onePercentLowFps: number | null;
  readonly over: {
    readonly "27.4": BenchCount;
    readonly "50": BenchCount;
    readonly "100": BenchCount;
    /** Against the tier's own hitch threshold: 27.4 ms, or 60 ms on Ultra. */
    readonly hitch: BenchCount & { readonly thresholdMs: number };
  };
  /** Intervals longer than the paced slot plus half a refresh period. */
  readonly missedRefresh: { readonly count: number; readonly per240: number; readonly longestStreak: number } | null;
  readonly vsyncBuckets: BenchVsyncBuckets | null;
  readonly renderMs: BenchRenderSummary | null;
  readonly renderStartIntervalMs: { readonly p95: number; readonly p99: number; readonly max: number } | null;
  readonly gpuMs: BenchGpuSummary | null;
  readonly compileSplit: BenchCompileSplit;
  readonly framesWithCompiles: number;
  readonly scaleStepFrames: number;
}

export interface BenchHistogram {
  readonly binMs: 1;
  /** Bins [0,1) ... [99,100) ms, then everything from 100 ms. */
  readonly counts: readonly number[];
}

export interface BenchSegment {
  readonly startS: number;
  readonly endS: number;
  readonly frames: number;
  readonly fps: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly over27: number;
  readonly compiles: number;
}

export interface BenchWorstFrame {
  readonly t: number;
  readonly intervalMs: number;
  readonly renderMs: number;
  readonly compiles: number;
  readonly scaleStep: boolean;
  /** Long tasks overlapping the interval, ms; null when unsupported. */
  readonly longTaskMs: number | null;
}

export interface BenchPerSecondRow {
  readonly second: number;
  readonly frames: number;
  readonly maxIntervalMs: number | null;
  readonly over27: number;
  readonly renderP95Ms: number | null;
  readonly compiles: number;
  readonly appliedScale: number | null;
  readonly renderPixels: number | null;
  readonly cpuLevel: number | null;
  readonly gpuLevel: number | null;
  readonly heapMiB: number | null;
}

/** The column names of `BenchPerSecondTable`, in order. */
export type BenchPerSecondColumn = keyof BenchPerSecondRow;

/**
 * Per-second rows as columns and number tuples: a 75 s flight's rows as
 * objects are about 13 KB of JSON, as tuples about 3.
 */
export interface BenchPerSecondTable {
  readonly columns: readonly BenchPerSecondColumn[];
  readonly rows: readonly (readonly (number | null)[])[];
}

export interface BenchCompileEvent {
  readonly t: number;
  readonly kind: BenchCompileKind;
}

export interface BenchLongTaskSummary {
  readonly supported: boolean;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface BenchLongAnimationFrameSummary {
  readonly supported: boolean;
  readonly count: number;
  readonly blockingMs: number;
  readonly maxMs: number;
  readonly top: readonly {
    readonly t: number;
    readonly durationMs: number;
    readonly blockingMs: number;
    readonly scripts: readonly BenchScriptAttribution[];
  }[];
}

/**
 * `performance.memory` outside a flagged Chromium is bucketed and refreshed
 * rarely, so a value that never moved says nothing: it is reported as stale
 * with null figures rather than as a flat line (critique S3).
 */
export interface BenchHeapSummary {
  readonly supported: boolean;
  readonly precise: false;
  readonly stale: boolean;
  readonly startMiB: number | null;
  readonly endMiB: number | null;
  readonly peakMiB: number | null;
  readonly slopeMiBPerMin: number | null;
}

/** The governor's own classes, so a change to them reaches the report without touching this file. */
export type BenchSignalClass = Classification;

/** The governor at one instant. Target, applied and rendered are reported apart (S2). */
export interface BenchGovernorSnapshot {
  readonly mode: GovernorMode | "pinned";
  readonly targetScale: number;
  readonly appliedScale: number;
  readonly renderPixels: number;
  readonly cpuLevel: number;
  readonly gpuLevel: number;
  readonly lever: string | null;
  readonly insensitive: boolean;
}

/**
 * One decision: [t s, mode, class, proxy ms, target scale, applied scale,
 * rendered pixels, CPU level, GPU level, lever, insensitive, GPU p95, CPU p95,
 * interval p95, late share]. t counts from the flight's first frame, so the
 * settle's decisions read below zero. A tuple, because a run holds up to 128
 * of them per step.
 */
export type BenchGovernorDecision = readonly [
  t: number,
  mode: string,
  signalClass: BenchSignalClass,
  proxyMs: number | null,
  targetScale: number,
  appliedScale: number,
  renderPixels: number,
  cpuLevel: number,
  gpuLevel: number,
  lever: string | null,
  insensitive: boolean,
  gpuP95: number | null,
  cpuP95: number | null,
  intervalP95: number | null,
  lateFraction: number | null,
];

export interface BenchGovernorEvents {
  readonly scaleDown: number;
  readonly scaleUp: number;
  readonly cpuShed: number;
  readonly cpuRecover: number;
  readonly gpuShed: number;
  readonly gpuRecover: number;
  readonly insensitiveLatched: number;
}

/**
 * Frame-weighted shares of a window, from the pixels actually rendered (S2).
 * All null for a window with no frames, which an early stop's air window is.
 */
export interface BenchGovernorShares {
  /** Null too where the resolution lever cannot change the pixels: tier 0, a binding pixel cap, pinned. */
  readonly atScaleFloor: number | null;
  readonly belowCeiling: number | null;
  readonly cpuShed: number | null;
  readonly gpuShed: number | null;
  readonly cpuAtMax: number | null;
  readonly gpuAtMax: number | null;
}

export interface BenchGovernorWindow {
  readonly frames: number;
  readonly decisions: number;
  readonly events: BenchGovernorEvents;
  readonly share: BenchGovernorShares;
  /** Frame-weighted share of each governor mode. */
  readonly modeShare: Readonly<Record<string, number>>;
  readonly classShare: Readonly<Record<string, number>>;
  readonly scaleStepFrames: number;
}

export interface BenchGovernorSummary {
  readonly pinned: boolean;
  readonly config: GovernorConfig | null;
  /** Some scale between the floor and the ceiling renders fewer pixels than the ceiling. */
  readonly scaleLeverAvailable: boolean;
  readonly floorPixels: number;
  readonly ceilingPixels: number;
  readonly atSettleEnd: BenchGovernorSnapshot | null;
  readonly atFlightStart: BenchGovernorSnapshot | null;
  readonly atEnd: BenchGovernorSnapshot | null;
  readonly decisionsDuringSettle: number;
  readonly decisions: readonly BenchGovernorDecision[];
  /** More decisions happened than `decisions` holds. */
  readonly decisionsTruncated: boolean;
  readonly flight: BenchGovernorWindow;
  readonly windows: { readonly ground: BenchGovernorWindow; readonly air: BenchGovernorWindow };
}

/** What one `getDiagnostics()` after the flight says. */
export interface BenchEndContext {
  readonly adapterLabel: string;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly visibleInstances: number;
  readonly residentTerrainPages: number;
  readonly pendingTerrainPages: number;
  readonly pendingDetailWork: number;
  readonly estimatedGpuMemoryMiB: number;
  readonly inventoriedGpuMemoryMiB: number;
  readonly hitchCount: number;
  readonly p999FrameMs: number | null;
  readonly presentWaitP95Ms: number | null;
  readonly topPassesByCpuMs: RenderDiagnostics["topPassesByCpuMs"];
  readonly gpuPassMs: RenderDiagnostics["gpuPassMs"];
}

/** A JSON value copied out of a renderer snapshot as it was. */
export type BenchJson = null | boolean | number | string | readonly BenchJson[] | { readonly [key: string]: BenchJson };

export interface BenchDetailWorkerReport {
  readonly atSettleEnd: DetailWorkerHealth | null;
  readonly atEnd: DetailWorkerHealth | null;
  readonly presentationAtSettleEnd: BenchJson;
  readonly presentationAtEnd: BenchJson;
}

export type BenchRouteKind = "runway" | "airborne";

export interface BenchPathSummary {
  /** "airborne" only for a world with no airport. */
  readonly route: BenchRouteKind;
  readonly startX: number;
  readonly startZ: number;
  readonly headingDeg: number;
  readonly rollEndS: number;
  readonly climbEndS: number;
  readonly rollSpeed: number;
  readonly cruiseSpeed: number;
  readonly clearance: number;
  readonly distanceM: number;
  readonly fingerprint: string;
  readonly matchesExpected: boolean;
}

export interface BenchFlightSummary {
  /** Seconds flown from the first frame; short of the plan after an early stop. */
  readonly seconds: number;
  /** The early check's fps, for a flight it stopped; null otherwise. */
  readonly earlyStopFps: number | null;
  /**
   * Mean fps from `earlyStopFromS` to `earlyStopAtS`, which every flight that
   * gets that far is checked on; null for one that did not.
   */
  readonly earlyCheckFps: number | null;
}

/** A presentation cadence as the report keeps it: the rate in Hz, not the period. */
export interface BenchCadence {
  readonly frameCapHz: FrameRateCap;
  /** Draws every Nth display refresh. */
  readonly divisor: number;
  /** The nominal display rate the pacer measured; null before it measured one. */
  readonly displayHz: number | null;
  /**
   * Measured on evidence render cost cannot stretch: ticks that drew
   * nothing, or drawn ticks faster than the rate held before.
   */
  readonly confirmed: boolean;
}

/** How the frame pacer ran during one flight. */
export interface BenchPacing {
  /** The frame-rate setting the flight used. */
  readonly setting: FrameRateSetting;
  /** What the pacer does with it on this build: "60" draws every refresh while 60 fps pacing is off. */
  readonly effective: FrameRateSetting;
  /** The cadence the renderer held at the flight's first frame and at its last; null before the pacer measured one. */
  readonly cadenceAtFlightStart: BenchCadence | null;
  readonly cadenceAtEnd: BenchCadence | null;
  /** New cadences the renderer received after the flight's first frame. */
  readonly cadenceChanges: number;
  /**
   * The bench's own rAF ticks and the frames the game rendered, both counted
   * after the flight's first frame through the one that closed it. A flight
   * paced to every 2nd refresh renders about half its ticks.
   */
  readonly rafTicks: number;
  readonly renderedFrames: number;
  /** The rate the cadence at the end paces to: its display rate over its divisor; null without a rate. */
  readonly pacedHz: number | null;
  /**
   * The renderer's governor config at the flight's first frame, which shows
   * the targets the cadence set; null when the flight never began.
   */
  readonly governorConfigAtFlightStart: GovernorConfig | null;
}

export interface BenchStepResult {
  readonly tierIndex: number;
  readonly quality: QualityLevel;
  readonly renderingMode: RenderingMode;
  readonly mode: BenchMode;
  /** Step 0 of a run pays every cold shader and pipeline cache (critique S10). */
  readonly firstRendererInTab: boolean;
  readonly refresh: BenchRefresh | null;
  readonly raf: BenchRafReport;
  readonly pacing: BenchPacing;
  readonly timer: BenchTimerReport;
  readonly startup: BenchStartup;
  readonly settle: BenchSettle;
  readonly canvas: BenchCanvas;
  readonly environment: BenchEnvironment;
  readonly flight: BenchFlightSummary;
  readonly windows: { readonly ground: BenchWindowMetrics | null; readonly air: BenchWindowMetrics | null };
  /** The air window's intervals. */
  readonly histogram: BenchHistogram | null;
  /** 10 s slices of the whole flight. */
  readonly segments: readonly BenchSegment[];
  /** The air window's ten longest intervals. */
  readonly worst: readonly BenchWorstFrame[];
  readonly perSecond: BenchPerSecondTable;
  readonly compiles: {
    /** Flight frames before the air window, the first one included. */
    readonly warmup: BenchCompileCounts;
    /** The air window's frames. The frame that closes the flight is in no window and counts nowhere. */
    readonly window: BenchCompileCounts & { readonly framesWithCompiles: number };
    /** The flight's first creations, t from its first frame. */
    readonly firstEvents: readonly BenchCompileEvent[];
  };
  /**
   * The air window's long tasks, long animation frames and heap; null when
   * the flight never reached the window (an early stop), as `windows.air` is.
   */
  readonly longTasks: BenchLongTaskSummary | null;
  readonly longAnimationFrames: BenchLongAnimationFrameSummary | null;
  readonly heap: BenchHeapSummary | null;
  readonly governor: BenchGovernorSummary;
  readonly detailWorker: BenchDetailWorkerReport;
  readonly end: BenchEndContext | null;
  readonly path: BenchPathSummary;
  readonly benchOverheadMs: { readonly p50: number; readonly p95: number } | null;
}

// --- the device ------------------------------------------------------------------

export type BenchWebGpuStatus = "ok" | "missing" | "no-adapter" | "fallback-only" | "limits-short";

export interface BenchAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
  readonly subgroupMinSize: number | null;
  readonly subgroupMaxSize: number | null;
}

export interface BenchDeviceReport {
  readonly userAgent: string;
  /** Chromium's client hints; null in Firefox and Safari. Brands read "Google Chrome 130". */
  readonly uaData: {
    readonly brands: readonly string[];
    readonly mobile: boolean;
    readonly platform: string;
    readonly platformVersion: string | null;
    readonly architecture: string | null;
    readonly bitness: string | null;
    readonly model: string | null;
    readonly wow64: boolean | null;
    readonly fullVersionList: readonly string[];
  } | null;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGiB: number | null;
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
    readonly devicePixelRatio: number;
  };
  readonly window: { readonly innerWidth: number; readonly innerHeight: number };
  readonly battery: { readonly charging: boolean; readonly level: number } | null;
  readonly webgpu: {
    readonly status: BenchWebGpuStatus;
    readonly reason: string | null;
    readonly adapter: BenchAdapterInfo | null;
    readonly features: readonly string[];
    readonly limits: Readonly<Record<string, number>>;
    readonly limitShortfalls: readonly WebGpuLimitShortfall[];
    readonly preferredCanvasFormat: string | null;
    readonly timestampQuery: boolean;
    /** `getDiagnostics().adapter` from a step, when one ran. */
    readonly rendererLabel: string | null;
  };
}

// --- the report (`fly-high.bench/2`) ----------------------------------------------

export type BenchVerdict = "valid" | "void" | "incomplete" | "unchecked";

/** Plain-language result for a friend reading the table. */
export type BenchSmoothness = "smooth" | "mostly-smooth" | "choppy" | "limited" | "did-not-run";

export type BenchWarningCode =
  | "step-failed"
  | "refresh-changed"
  | "settle-not-at-rest"
  | "low-sample"
  | "path-fingerprint"
  | "settings-key-changed"
  | "wake-lock-denied"
  | "battery-discharging"
  | "ignored-renderer-calls"
  | "raf-disagrees"
  | "raf-limited"
  | "pacer-period-disagrees"
  | "timer-coarse"
  | "frame-log-overflow"
  | "focus-lost";

export interface BenchWarning {
  readonly code: BenchWarningCode;
  readonly stepIndex: number | null;
  readonly message: string;
}

export interface BenchRepeatability {
  readonly metric: "meanFps";
  /**
   * The part of the route both check flights' fps come from: the air window,
   * or the early check's stretch when either flight stopped early.
   */
  readonly window: "air" | "early-check";
  readonly tierIndex: number;
  readonly first: number | null;
  readonly last: number | null;
  readonly spread: number | null;
  readonly threshold: number;
  readonly passed: boolean;
  /** Relative change of the CSS canvas area between the two steps. */
  readonly canvasChange: number | null;
  readonly secondary: {
    readonly renderP50Spread: number | null;
    readonly intervalP95Spread: number | null;
    readonly over27Per240Delta: number | null;
    readonly refreshHzDelta: number | null;
  };
}

export interface BenchWorkload {
  readonly hud: "bench-portal" | "off";
  readonly simWorker: "attract";
  /** No AudioContext exists: the graph is built only on a player's first control. */
  readonly audio: "none";
  readonly spawnedAirports: false;
  readonly pilotInput: false;
  /** The frame-rate setting the run flew. */
  readonly frameCap: FrameRateSetting;
  /** What the pacer did with it on this build. */
  readonly frameCapEffective: FrameRateSetting;
  /** The players' default when the build was made, and what the pacer does with it. */
  readonly shippedFrameRate: FrameRateSetting;
  readonly shippedFrameRateEffective: FrameRateSetting;
}

export interface BenchReportRun {
  readonly id: string;
  readonly plan: BenchRunPlan;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: BenchRunStatus;
  readonly verdict: BenchVerdict;
  readonly voidReasons: readonly string[];
  readonly warnings: readonly BenchWarning[];
  readonly repeatability: BenchRepeatability | null;
  readonly userLabel: string | null;
  readonly ignoredParams: readonly string[];
  readonly workload: BenchWorkload;
  /** Null when either hash is missing. */
  readonly settingsKeyUnchanged: boolean | null;
  /** A quick run, or one whose frame rate behaves unlike its mode's default (`fps=`). */
  readonly nonStandard: boolean;
  readonly firstLoad: BenchFirstLoad | null;
  /** Each tier's label: the worse of its steps that were not browser-limited. */
  readonly tierLabels: readonly { readonly tierIndex: number; readonly label: BenchSmoothness }[];
}

export interface BenchReportStep {
  readonly index: number;
  readonly tierIndex: number;
  readonly quality: QualityLevel;
  readonly renderingMode: RenderingMode;
  readonly mode: BenchMode;
  readonly outcome: BenchStepStatus;
  readonly message: string | null;
  readonly attempts: number;
  readonly attemptLog: readonly BenchAttemptNote[];
  /** The worse of the ground and air windows. */
  readonly label: BenchSmoothness;
  readonly result: BenchStepResult | null;
}

export interface BenchProfileEntry {
  readonly quality: QualityLevel;
  readonly renderingMode: RenderingMode;
  readonly fingerprint: string;
  readonly hitchThresholdMs: number;
  readonly governorConfig: GovernorConfig;
  /** The resolved profile, whole. */
  readonly profile: BenchJson;
}

export interface BenchBuildInfo {
  readonly commit: string | null;
  readonly entryScript: string | null;
  readonly base: string;
  readonly origin: string;
}

/** An earlier run of the same tab, carried in the same report (N6). */
export interface BenchEarlierRun {
  readonly run: BenchReportRun;
  readonly display: { readonly intro: BenchRefresh | null; readonly report: BenchRefresh | null };
  readonly steps: readonly BenchReportStep[];
}

export interface BenchReport {
  readonly schema: "fly-high.bench/2";
  readonly benchVersion: number;
  readonly createdAt: string;
  readonly build: BenchBuildInfo;
  readonly run: BenchReportRun;
  readonly device: BenchDeviceReport | null;
  readonly display: { readonly intro: BenchRefresh | null; readonly report: BenchRefresh | null };
  /** Keyed by tier index. */
  readonly profiles: Readonly<Record<string, BenchProfileEntry>>;
  readonly steps: readonly BenchReportStep[];
  readonly earlierRuns: readonly BenchEarlierRun[];
  readonly definitions: Readonly<Record<string, string>>;
}
