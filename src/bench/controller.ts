import type { FlightVisualState, RenderDiagnostics } from "@/src/game/types";
import type { RendererBenchProbe } from "@/src/render/FlightRenderer";
import { hitchThresholdMilliseconds } from "@/src/render/webgpu/core/QualityProfile";
import { GovernorTrace, type ScaleContext } from "./governorTrace";
import {
  compileCounts,
  startRafRecorder,
  type CreationCounter,
  type EntryLog,
  type FrameClock,
  type HeapSampler,
  type RafRecorder,
} from "./instruments";
import {
  benchPathSummary,
  createBenchVisualState,
  writeFlightState,
  writeSettleState,
  type BenchPath,
} from "./path";
import { benchProfile, benchTier, recordSettleCheck, SETTLE_START, settleCheckDue, settleOutcome, type SettleProgress } from "./plan";
import type { BenchFramePort } from "./recorder";
import { endContextFromDiagnostics, toBenchJson } from "./report";
import {
  compileDelta,
  createFrameLog,
  earlyStopCheck,
  flightCadence,
  flightSegments,
  overheadSummary,
  perSecondRows,
  perSecondTable,
  rafReport,
  recordFrame,
  recordOverhead,
  summarizeHeap,
  summarizeLongAnimationFrames,
  summarizeLongTasks,
  summarizeWindow,
  windowFrames,
  windowHistogram,
  worstFrames,
  ZERO_COMPILES,
  type FrameWindowContext,
} from "./stats";
import type {
  BenchCompileCounts,
  BenchEnvironment,
  BenchFirstLoad,
  BenchFrameLog,
  BenchGpuTiming,
  BenchLongAnimationFrameEntry,
  BenchLongTaskEntry,
  BenchMode,
  BenchRefresh,
  BenchSecondSample,
  BenchSettle,
  BenchStartupStage,
  BenchStepResult,
  BenchTimerReport,
  BenchTimings,
  BenchWindowSpec,
} from "./types";

/**
 * One step's flight, frame by frame: hold the runway pose until streaming
 * rests, fly the scripted route, and collect the step's result. The renderer
 * decorator (recorder.ts) calls it as its port; the session (session.ts)
 * gives it the clock, the instruments and what it measured before the
 * renderer existed, and hears when the flight ends.
 *
 * A frame belongs to the flight by its rAF timestamp, which every rAF
 * callback of a frame shares. The controller runs its own rAF loop for that,
 * started when the decorator is attached, which is before FlightGame asks
 * for its first frame, so the loop's callback runs first in every frame and
 * the render sees its own frame's timestamp.
 *
 * Per frame it writes fixed typed arrays (stats.ts's frame log) and reads the
 * renderer's probe; it allocates only once a second (a per-second sample) and
 * on a governor decision. `getDiagnostics()` walks the GPU memory inventory
 * and the detail cells, so it runs only during the settle, spaced at least
 * 120 frames and a second apart (critique S7), once when the settle ends and
 * once after the flight: never inside a measured window.
 */

/** What the controller reads from the renderer outside the measured windows. `FlightRenderer` has it all. */
export interface BenchRendererPort {
  getDiagnostics(): RenderDiagnostics;
  getCaptureRenderSize(): { readonly width: number; readonly height: number };
  getGpuTimingStatusForCapture(): { readonly enabled: boolean };
  getDetailPresentationDiagnosticsForCapture(): unknown;
}

/** The page's instruments, installed before the renderer existed; null where the browser lacks one. */
export interface StepInstruments {
  readonly creations: CreationCounter | null;
  readonly longTasks: EntryLog<BenchLongTaskEntry> | null;
  readonly longAnimationFrames: EntryLog<BenchLongAnimationFrameEntry> | null;
  readonly heap: HeapSampler | null;
}

/** What the step's page knew before the renderer existed, and what it watches beside the frames. */
export interface StepSetup {
  readonly tierIndex: number;
  readonly mode: BenchMode;
  readonly timings: BenchTimings;
  /** The run plan's `pathFingerprint`. */
  readonly expectedFingerprint: string;
  /** Step 0 of a tab's first run pays every cold shader and pipeline cache (critique S10). */
  readonly firstRendererInTab: boolean;
  /** The step's idle refresh probe, before the renderer existed. */
  readonly refresh: BenchRefresh | null;
  readonly timer: BenchTimerReport;
  /**
   * How the page was reached and where its same-origin scripts came from,
   * read when the flight's result is collected: by then the renderer has
   * loaded its workers and shader chunks, most of a cold step's download,
   * none of which exists before the renderer does (critique S10).
   */
  readonly load: () => BenchFirstLoad;
  /** The canvas's CSS size and the device pixel ratio when the renderer was created. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  /** Pinned mode's scale, or null in shipped mode. */
  readonly pinnedRenderScale: number | null;
  /** Pinned mode's retry after the per-pass GPU timer failed to install: timing off. */
  readonly gpuTimingFailed: boolean;
  /** `performance.now()` when FlightGame handed the renderer over: navigation to attach. */
  readonly attachedAtMs: number;
  readonly pathPrecomputeMs: number;
  /** The renderer's startup trace, read when the settle ends. */
  readonly startupStages: () => readonly { readonly label: string; readonly kind: "sync" | "async"; readonly milliseconds: number }[];
  /** The page's watchers at the end of the flight: keys, focus, wake lock, game errors. */
  readonly environment: () => Omit<BenchEnvironment, "overflowed">;
}

export type StepPhase = "waiting" | "settling" | "flying" | "done" | "stopped" | "detached";

/** How a flight ended, and what it measured. */
export interface StepFinish {
  readonly outcome: "ok" | "early-stop";
  readonly result: BenchStepResult;
}

export interface StepListener {
  /** The phase changed: the run chip's words. */
  phase?(phase: StepPhase): void;
  /** The flight ended and its result is collected. */
  finished(finish: StepFinish): void;
  /** The renderer's `render()` threw; FlightGame stops the renderer next. */
  renderThrew?(error: unknown): void;
}

export interface StepControllerOptions {
  readonly path: BenchPath;
  readonly setup: StepSetup;
  readonly renderer: BenchRendererPort;
  readonly instruments: StepInstruments;
  readonly listener: StepListener;
  /** `performance.now()`. */
  readonly now?: () => number;
  /** For the controller's own rAF loop. */
  readonly frameClock?: FrameClock;
  /** Frame log capacity; stats.ts's default holds the standard flight at 360 Hz. */
  readonly capacity?: number;
}

/** A settle-time diagnostics read: what rest is judged on, and what the report keeps of it. */
interface SettleReading {
  readonly diagnostics: RenderDiagnostics;
  readonly presentation: unknown;
}

/** The settle's results, frozen when it ends. */
interface SettleRecord {
  readonly settle: BenchSettle;
  readonly navToSettleEndMs: number;
  readonly reading: SettleReading;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly appliedScale: number;
  readonly stages: readonly BenchStartupStage[];
}

function noCompiles(): BenchCompileCounts {
  return ZERO_COMPILES;
}

export class StepController implements BenchFramePort {
  /** The pose every frame draws; changed in place, never replaced (the HUD reads it too). */
  readonly state: FlightVisualState = createBenchVisualState();
  readonly log: BenchFrameLog;
  private readonly trace: GovernorTrace;
  private readonly now: () => number;
  private readonly raf: RafRecorder;
  private readonly timings: BenchTimings;
  private readonly tierThresholdMs: number;
  private readonly scale: ScaleContext;
  private currentPhase: StepPhase = "waiting";
  /** The latest rAF timestamp of the controller's own loop. */
  private rafMs: number | null = null;
  private lastFrameMs: number | null = null;
  private firstFrameMs: number | null = null;
  /**
   * When the first `render()` began. A rAF timestamp is the frame's begin
   * time, which for a frame already under way when FlightGame asked for its
   * first one can precede the attach; startup is timed by this instead.
   */
  private firstRenderStartMs: number | null = null;
  private settleFrames = 0;
  private settleProgress: SettleProgress = SETTLE_START;
  private settleRecord: SettleRecord | null = null;
  private flightStartMs: number | null = null;
  private flightSeconds = 0;
  private lastPixels: number | null = null;
  private lastCompileTotal = 0;
  private earlyStopChecked = false;
  private earlyCheckFps: number | null = null;
  private readonly secondSamples: (BenchSecondSample | null)[];
  /**
   * Compile counts at each boundary, taken BEFORE the render of the frame that
   * opens what follows. A frame's compiles then count where the frame log
   * puts the frame: the first frame in the settle, the first flight frame in
   * the warm-up, the first air frame in the window, and the frame that closes
   * the flight (past every window) in none.
   */
  private compilesAtFirstFrame: BenchCompileCounts = ZERO_COMPILES;
  private compilesAtFlightStart: BenchCompileCounts = ZERO_COMPILES;
  private compilesAtAirStart: BenchCompileCounts | null = null;
  private compilesAtAirEnd: BenchCompileCounts | null = null;
  private compilesAtFlightEnd: BenchCompileCounts | null = null;
  /** The counts as the last frame ended, which are the next frame's "before". */
  private compilesSeen: BenchCompileCounts = ZERO_COMPILES;

  constructor(private readonly options: StepControllerOptions) {
    const { setup, path } = options;
    this.timings = setup.timings;
    this.now = options.now ?? (() => performance.now());
    this.log = createFrameLog(options.capacity);
    const profile = benchProfile(setup.tierIndex);
    this.tierThresholdMs = hitchThresholdMilliseconds(profile);
    this.scale = {
      cssWidth: setup.cssWidth,
      cssHeight: setup.cssHeight,
      devicePixelRatio: setup.devicePixelRatio,
      maxDevicePixelRatio: profile.maxDevicePixelRatio,
      maxRenderPixels: profile.maxRenderPixels,
    };
    this.trace = new GovernorTrace({
      windows: { ground: this.timings.ground, air: this.timings.air },
      flightS: this.timings.flightS,
      scale: this.scale,
    });
    this.secondSamples = new Array<BenchSecondSample | null>(Math.ceil(this.timings.flightS) + 1).fill(null);
    writeSettleState(path, this.state);
    this.raf = startRafRecorder((timestamp) => {
      this.rafMs = timestamp;
    }, options.frameClock);
  }

  get phase(): StepPhase {
    return this.currentPhase;
  }

  /** Seconds since the flight's first frame; 0 before it. */
  get flightElapsedS(): number {
    return this.flightSeconds;
  }

  /** Seconds since the first frame, the settle included; 0 before it. */
  get elapsedS(): number {
    return this.firstFrameMs === null || this.lastFrameMs === null ? 0 : (this.lastFrameMs - this.firstFrameMs) / 1_000;
  }

  /** `performance.now()` of the last frame the renderer finished, or null before the first. */
  get lastFrameAt(): number | null {
    return this.lastFrameMs;
  }

  // --- the recorder's port ---------------------------------------------------------

  stateFor(now: number): FlightVisualState | null {
    // Startup's compiles stop where the first frame's render begins.
    if (this.currentPhase === "waiting") this.compilesAtFirstFrame = this.compiles();
    if (this.currentPhase === "flying") {
      const frameMs = this.frameTime(now);
      const t = this.flightStartMs === null ? 0 : (frameMs - this.flightStartMs) / 1_000;
      writeFlightState(this.options.path, Math.min(t, this.timings.flightS), this.state);
    }
    // The settle holds its pose; after the flight, its last pose holds.
    return this.currentPhase === "detached" ? null : this.state;
  }

  afterFrame(renderStart: number, renderEnd: number, probe: Readonly<RendererBenchProbe>): void {
    const phase = this.currentPhase;
    if (phase === "detached") return;
    const frameMs = this.frameTime(renderStart);
    this.lastFrameMs = frameMs;
    const counts = this.options.instruments.creations?.counts ?? null;
    const compileTotal = counts?.total ?? 0;
    const compiles = compileTotal - this.lastCompileTotal;
    this.lastCompileTotal = compileTotal;
    const compilesBefore = this.compilesSeen;
    if (compiles !== 0) this.compilesSeen = this.compiles();
    const pixels = probe.renderWidth * probe.renderHeight;
    const scaleStep = this.lastPixels !== null && pixels !== this.lastPixels;
    this.lastPixels = pixels;

    if (phase === "waiting") {
      this.firstFrameMs = frameMs;
      this.firstRenderStartMs = renderStart;
      this.setPhase("settling");
    }
    if (this.currentPhase === "settling") {
      this.settleFrame(frameMs, probe);
      return;
    }
    if (this.currentPhase !== "flying") return;

    if (this.flightStartMs === null) {
      this.flightStartMs = frameMs;
      this.compilesAtFlightStart = compilesBefore;
      // The settle's clock read `settleCapS` short of its elapsed time; now the flight's start is known.
      this.trace.rebaseSettle(this.timings.settleCapS - (frameMs - this.firstFrameMs!) / 1_000);
    }
    const t = (frameMs - this.flightStartMs) / 1_000;
    this.flightSeconds = t;
    recordFrame(this.log, frameMs, renderStart, renderEnd - renderStart, compiles, scaleStep, probe.gpuFrameMs);
    // The early check reads the log, this frame included.
    let stopEarly = false;
    if (!this.earlyStopChecked && t >= this.timings.earlyStopAtS) {
      this.earlyStopChecked = true;
      const check = earlyStopCheck(this.log, { flightStartMs: this.flightStartMs }, this.timings);
      this.earlyCheckFps = check.fps;
      stopEarly = check.stop;
    }
    // The first frame at or past the end, or the early check's, closes the
    // last interval, then the flight ends: no window counts it.
    const closing = stopEarly || t >= this.timings.flightS;
    this.trace.observe(t, probe, closing);
    if (this.compilesAtAirStart === null && t >= this.timings.air.startS) this.compilesAtAirStart = compilesBefore;
    if (this.compilesAtAirEnd === null && t >= this.timings.air.endS) this.compilesAtAirEnd = compilesBefore;
    this.secondSample(t, frameMs, probe);
    if (closing) this.finish(stopEarly ? "early-stop" : "ok", compilesBefore);
  }

  renderThrew(error: unknown): void {
    if (this.currentPhase === "detached") return;
    this.options.listener.renderThrew?.(error);
  }

  overhead(milliseconds: number): void {
    if (this.currentPhase === "flying") recordOverhead(this.log, milliseconds);
  }

  detached(): void {
    this.dispose();
  }

  /** After the flight, a stop, a void or a failure the page leaves next; the canvas keeps its last frame. */
  holdFrames(): boolean {
    return this.currentPhase === "done" || this.currentPhase === "stopped";
  }

  // --- the page's controls ---------------------------------------------------------

  /** Stop, a void or a failure: nothing more is measured or drawn. */
  stop(): void {
    if (this.currentPhase === "detached" || this.currentPhase === "done") return;
    this.raf.stop();
    this.setPhase("stopped");
  }

  dispose(): void {
    if (this.currentPhase === "detached") return;
    this.raf.stop();
    this.setPhase("detached");
  }

  // --- inside a frame --------------------------------------------------------------

  /** The frame's rAF timestamp; the render's own start if the loop has not seen this frame. */
  private frameTime(renderStart: number): number {
    const raf = this.rafMs;
    return raf === null || raf === this.lastFrameMs ? renderStart : raf;
  }

  private compiles(): BenchCompileCounts {
    const counter = this.options.instruments.creations;
    return counter ? compileCounts(counter.counts) : noCompiles();
  }

  private setPhase(phase: StepPhase): void {
    if (phase === this.currentPhase) return;
    this.currentPhase = phase;
    this.options.listener.phase?.(phase);
  }

  private settleFrame(frameMs: number, probe: Readonly<RendererBenchProbe>): void {
    const elapsedMs = frameMs - this.firstFrameMs!;
    this.settleFrames += 1;
    // During the settle the trace's clock reads below zero, rising to the
    // settle cap: decisions there count as the settle's. The flight's first
    // frame rebases them to count back from it.
    this.trace.observe(Math.min(-1e-3, elapsedMs / 1_000 - this.timings.settleCapS), probe);
    let reading: SettleReading | null = null;
    if (settleCheckDue(this.timings, this.settleProgress, elapsedMs, this.settleFrames, false)) {
      const diagnostics = this.options.renderer.getDiagnostics();
      reading = { diagnostics, presentation: null };
      this.settleProgress = recordSettleCheck(this.timings, this.settleProgress, elapsedMs, this.settleFrames, {
        pendingTerrainPages: diagnostics.pendingTerrainPages,
        pendingDetailWork: diagnostics.pendingDetailWork,
        visibleInstances: diagnostics.visibleInstances,
      });
    }
    const outcome = settleOutcome(this.timings, this.settleProgress, elapsedMs);
    if (outcome === null) return;
    this.endSettle(outcome === "rest", elapsedMs, probe, reading);
  }

  private endSettle(
    reachedRest: boolean,
    elapsedMs: number,
    probe: Readonly<RendererBenchProbe>,
    lastReading: SettleReading | null,
  ): void {
    const { renderer, instruments, setup } = this.options;
    const diagnostics = lastReading?.diagnostics ?? renderer.getDiagnostics();
    const reading: SettleReading = {
      diagnostics,
      presentation: toBenchJson(renderer.getDetailPresentationDiagnosticsForCapture()),
    };
    const size = renderer.getCaptureRenderSize();
    const longTasks = instruments.longTasks
      ? summarizeLongTasks(instruments.longTasks.entries, this.firstFrameMs!, this.firstFrameMs! + elapsedMs)
      : null;
    this.settleRecord = {
      settle: {
        reachedRest,
        ms: elapsedMs,
        frames: this.settleFrames,
        checks: this.settleProgress.checks,
        pendingTerrainPages: diagnostics.pendingTerrainPages,
        pendingDetailWork: diagnostics.pendingDetailWork,
        visibleInstances: diagnostics.visibleInstances,
        compiles: compileDelta(this.compiles(), this.compilesAtFirstFrame),
        longTasks: longTasks ? { count: longTasks.count, totalMs: longTasks.totalMs } : null,
        governorDecisions: 0,
      },
      navToSettleEndMs: this.now(),
      reading,
      renderWidth: size.width,
      renderHeight: size.height,
      appliedScale: probe.appliedRenderScale,
      stages: setup.startupStages().map((stage) => ({ label: stage.label, kind: stage.kind, ms: stage.milliseconds })),
    };
    // The flight begins with the next frame, and so do its compile events.
    instruments.creations?.clearEvents();
    this.setPhase("flying");
  }

  private secondSample(t: number, frameMs: number, probe: Readonly<RendererBenchProbe>): void {
    const second = Math.floor(t);
    if (second < 0 || second >= this.secondSamples.length || this.secondSamples[second] !== null) return;
    const heapBytes = this.options.instruments.heap?.sample(frameMs) ?? null;
    const state = probe.governorState;
    this.secondSamples[second] = {
      appliedScale: probe.appliedRenderScale,
      renderPixels: probe.renderWidth * probe.renderHeight,
      cpuLevel: state.cpuWorkLevel,
      gpuLevel: state.gpuWorkLevel,
      heapBytes,
    };
  }

  // --- the end of the flight ---------------------------------------------------------

  private finish(outcome: "ok" | "early-stop", compilesBeforeLastFrame: BenchCompileCounts): void {
    this.compilesAtFlightEnd = compilesBeforeLastFrame;
    this.raf.stop();
    this.setPhase("done");
    const result = this.collect(outcome);
    this.options.listener.finished({ outcome, result });
  }

  /** The step's result, from the frame log and one last read of the renderer. */
  collect(outcome: "ok" | "early-stop"): BenchStepResult {
    const { setup, renderer, instruments, path } = this.options;
    const settled = this.settleRecord;
    const flightStartMs = this.flightStartMs ?? 0;
    const flown = Math.min(this.flightSeconds, this.timings.flightS);
    const context: FrameWindowContext = {
      flightStartMs,
      refreshMs: setup.refresh?.periodMs ?? null,
      granularityMs: setup.timer.granularityMs,
      tierThresholdMs: this.tierThresholdMs,
    };
    const windowOf = (spec: BenchWindowSpec) => {
      const metrics = summarizeWindow(this.log, spec, context);
      return metrics.frames > 0 ? metrics : null;
    };
    const ground = windowOf(this.timings.ground);
    const air = windowOf(this.timings.air);
    const air0 = flightStartMs + this.timings.air.startS * 1_000;
    const air1 = flightStartMs + this.timings.air.endS * 1_000;
    const flightFrames = windowFrames(this.log, context, 0, this.timings.flightS);
    const intervals = flightFrames.map((index) => this.log.frameTimeMs[index + 1]! - this.log.frameTimeMs[index]!);

    const diagnostics = renderer.getDiagnostics();
    // An early stop ends before the air window opens: its flight is all warm-up.
    const atEnd = this.compilesAtFlightEnd ?? this.compiles();
    const airStart = this.compilesAtAirStart ?? atEnd;
    const airEnd = this.compilesAtAirEnd ?? atEnd;
    const tier = benchTier(setup.tierIndex);
    const governor = this.trace.summary();
    const appliedScale = settled?.appliedScale ?? 1;
    const renderWidth = settled?.renderWidth ?? renderer.getCaptureRenderSize().width;
    const renderHeight = settled?.renderHeight ?? renderer.getCaptureRenderSize().height;
    const cssPixels = Math.max(1, setup.cssWidth * setup.cssHeight);
    const pixelRatio = Math.min(this.scale.maxDevicePixelRatio, setup.devicePixelRatio || 1);
    const environment = setup.environment();
    const load = setup.load();
    const events = instruments.creations?.events ?? [];

    return {
      tierIndex: setup.tierIndex,
      quality: tier.quality,
      renderingMode: tier.renderingMode,
      mode: setup.mode,
      firstRendererInTab: setup.firstRendererInTab,
      refresh: setup.refresh,
      raf: rafReport(setup.refresh, flightCadence(intervals)),
      timer: setup.timer,
      startup: {
        navigationType: load.navigationType,
        httpCache: load.httpCache,
        rendererStages: settled?.stages ?? [],
        navToAttachMs: setup.attachedAtMs,
        navToFirstFrameMs: this.firstRenderStartMs,
        navToSettleEndMs: settled?.navToSettleEndMs ?? null,
        pathPrecomputeMs: setup.pathPrecomputeMs,
        compiles: this.compilesAtFirstFrame,
      },
      settle: settled
        ? { ...settled.settle, governorDecisions: governor.decisionsDuringSettle }
        : {
          reachedRest: false, ms: 0, frames: 0, checks: 0, pendingTerrainPages: null, pendingDetailWork: null,
          visibleInstances: null, compiles: ZERO_COMPILES, longTasks: null, governorDecisions: 0,
        },
      canvas: {
        cssWidth: setup.cssWidth,
        cssHeight: setup.cssHeight,
        devicePixelRatio: setup.devicePixelRatio,
        aspectRatio: setup.cssHeight > 0 ? setup.cssWidth / setup.cssHeight : 0,
        renderWidth,
        renderHeight,
        renderPixels: renderWidth * renderHeight,
        pixelCapBinds: Math.max(0.1, pixelRatio * appliedScale) >= Math.sqrt(this.scale.maxRenderPixels / cssPixels),
        pinnedRenderScale: setup.pinnedRenderScale,
        gpuTiming: this.gpuTiming(),
      },
      environment: { ...environment, overflowed: this.log.overflowed },
      flight: {
        seconds: flown,
        earlyStopFps: outcome === "early-stop" ? this.earlyCheckFps : null,
        earlyCheckFps: this.earlyCheckFps,
      },
      windows: { ground, air },
      histogram: air ? windowHistogram(this.log, this.timings.air, context) : null,
      segments: flightSegments(this.log, context, outcome === "early-stop" ? Math.ceil(flown) : this.timings.flightS),
      worst: air ? worstFrames(this.log, this.timings.air, context, instruments.longTasks?.entries ?? null) : [],
      perSecond: perSecondTable(perSecondRows(this.log, context, Math.ceil(flown), this.secondSamples)),
      compiles: {
        warmup: compileDelta(airStart, this.compilesAtFlightStart),
        window: { ...compileDelta(airEnd, airStart), framesWithCompiles: air?.framesWithCompiles ?? 0 },
        firstEvents: events.slice(0, 20).map((event) => ({ t: (event.t - flightStartMs) / 1_000, kind: event.kind })),
      },
      // A window the flight never reached measured nothing: null, as `windows.air` is, not zeros.
      longTasks: air ? summarizeLongTasks(instruments.longTasks?.entries ?? null, air0, air1) : null,
      longAnimationFrames: air
        ? summarizeLongAnimationFrames(instruments.longAnimationFrames?.entries ?? null, air0, air1, flightStartMs)
        : null,
      heap: air ? summarizeHeap(instruments.heap?.samples() ?? null, air0, air1) : null,
      governor,
      detailWorker: {
        atSettleEnd: settled?.reading.diagnostics.detailWorker ?? null,
        atEnd: diagnostics.detailWorker ?? null,
        presentationAtSettleEnd: (settled?.reading.presentation ?? null) as BenchStepResult["detailWorker"]["presentationAtSettleEnd"],
        presentationAtEnd: toBenchJson(renderer.getDetailPresentationDiagnosticsForCapture()),
      },
      end: endContextFromDiagnostics(diagnostics),
      path: benchPathSummary(path, setup.expectedFingerprint),
      benchOverheadMs: overheadSummary(this.log, context, 0, this.timings.flightS),
    };
  }

  private gpuTiming(): BenchGpuTiming {
    const { setup, renderer } = this.options;
    if (setup.mode === "shipped") return "off";
    if (setup.gpuTimingFailed) return "install-failed";
    return renderer.getGpuTimingStatusForCapture().enabled ? "on" : "unsupported";
  }
}
