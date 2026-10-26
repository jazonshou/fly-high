import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  beginRendererStartupTrace,
  endRendererStartupTrace,
  readRendererStartupTrace,
  type FlightRenderer,
} from "@/src/render/FlightRenderer";
import type { FlightRenderingSystem } from "@/src/render/types";
import type { BenchUrlRequest, GameSettings } from "@/src/settings";
import type { WorldDefinition } from "@/src/world";
import "./bench.css";
import { StepController, type StepFinish, type StepInstruments, type StepPhase } from "./controller";
import { collectBattery, collectBuild, collectDevice } from "./device";
import {
  benchFlow,
  deviceOnlyRun,
  failStep,
  isFinalStep,
  nextHref,
  nextStepIndex,
  recordReportExtras,
  recordStepResult,
  retryWithoutGpuTiming,
  startDeviceOnlyRun,
  startPinnedPass,
  startRun,
  stopRun,
  urlOptions,
  voidAttempt,
  type BenchPage,
  type BenchTransition,
  type StartRunInput,
} from "./flow";
import {
  createHeapSampler,
  installCreationCounter,
  installEnvironmentGuards,
  installKeyBlocker,
  measureRefresh,
  measureTimerGranularity,
  observeLongAnimationFrames,
  observeLongTasks,
  readHttpCache,
  requestWakeLock,
  watchRenderFailure,
  type EnvironmentEvent,
  type EnvironmentGuards,
  type KeyBlocker,
  type WakeLockHandle,
} from "./instruments";
import { createBenchPath } from "./path";
import {
  BENCH_SEED,
  benchGameSettings,
  benchRendererOptions,
  benchTimings,
  estimateRemainingSeconds,
  exitUrl,
  ignoredBenchParams,
  introUrl,
  newRunId,
  reportUrl,
  type BenchUrlOptions,
} from "./plan";
import { BenchRendererSlot, type BenchRenderer } from "./recorder";
import { buildReport, reportFileName, reportToJson } from "./report";
import { hashSettingsKey } from "./settingsGuard";
import { timerReport } from "./stats";
import { BENCH_STORE_KEY, benchSessionStorage, clearBenchStore, openBenchStore, writeBenchStore } from "./store";
import type {
  BenchDeviceReport,
  BenchFirstLoad,
  BenchNoticeCode,
  BenchRefresh,
  BenchRendererOptions,
  BenchRunRecord,
  BenchSession,
  BenchStore,
  BenchTimerReport,
  BenchTimings,
} from "./types";
import { BenchApp, isInsideBenchUi, type BenchView } from "./ui/BenchApp";
import type { BenchCardProps } from "./ui/BenchCards";
import type { BenchChipPhase } from "./ui/BenchChip";
import type { BenchIntroChoice } from "./ui/BenchIntro";
import type { BenchCopyState, BenchCopyTarget } from "./ui/BenchReportDialog";

/**
 * `?bench=1`: the one module FlightGame loads, through a dynamic `import()`
 * that a player's page never reaches. It runs the page flow (flow.ts) for
 * this load, installs the instruments, mounts the bench's own React root and
 * hands FlightGame the session it needs: on a step page the settings and
 * seed to boot with, the renderer options, and the decorator to swap in for
 * the renderer. The intro and report pages boot nothing, so FlightGame never
 * creates a renderer there.
 *
 * One page load is one page of a run, and FlightGame's effects may ask more
 * than once (React's StrictMode runs them twice in development), so the
 * session is opened once per load and every caller gets the same one.
 */

/** What a page load reads and does outside the DOM, injectable for tests. */
export interface BenchHost {
  readonly href: string;
  readonly storage: Storage | null;
  /** The navigation entry's type: "navigate", "reload", "back_forward", ... */
  readonly navigationType: string;
  /** This moment as an ISO string. */
  isoNow(): string;
  /** `location.replace`: a run's pages never stack up in the tab's history. */
  go(href: string): void;
}

function browserHost(): BenchHost {
  return {
    href: location.href,
    storage: benchSessionStorage(),
    navigationType: readHttpCache().navigationType,
    isoNow: () => new Date().toISOString(),
    go: (href) => location.replace(href),
  };
}

let opened: Promise<BenchSession> | null = null;

/** This page load's session; the first call starts it and every later one gets the same. */
export function openBenchSession(request: BenchUrlRequest, host?: BenchHost): Promise<BenchSession> {
  opened ??= openPage(request, host ?? browserHost());
  return opened;
}

/** The session of a page that creates no renderer: the intro, the report, a redirect. */
const NO_FLIGHT: BenchSession = Object.freeze({
  boot: null,
  rendererOptions: () => ({}),
  attach: (renderer: FlightRenderer) => renderer,
  reportGameError: () => undefined,
});

async function openPage(request: BenchUrlRequest, host: BenchHost): Promise<BenchSession> {
  const decision = benchFlow({
    request,
    read: openBenchStore(host.storage),
    navigationType: host.navigationType,
    href: host.href,
    now: host.isoNow(),
  });
  const page = decision.page;
  let store: BenchStore | null = decision.save;
  if (decision.save) {
    if (!writeBenchStore(host.storage, decision.save)) {
      // A step that cannot claim itself would run without a record of it.
      if (decision.onSaveFailed) {
        host.go(decision.onSaveFailed);
        return NO_FLIGHT;
      }
      store = null;
    }
  }
  try {
    switch (page.kind) {
      case "redirect":
        host.go(page.href);
        return NO_FLIGHT;
      case "intro":
        new IntroPage(host, request, page).start();
        return NO_FLIGHT;
      case "report":
        new ReportPage(host, page.run, page.earlier, page.notice, store ?? currentStore(host)).start();
        return NO_FLIGHT;
      case "step":
        return await new StepPage(host, page, store ?? currentStore(host)).start();
    }
  } catch (error) {
    showFailure(host, request, error);
    return NO_FLIGHT;
  }
}

/**
 * A page that threw while it set itself up, most likely on a saved run this
 * build cannot read: a panel with a way out instead of a blank page, since
 * bench pages hide the game's error banner. The renderer never starts.
 */
function showFailure(host: BenchHost, request: BenchUrlRequest, error: unknown): void {
  let saved: string | null = null;
  try {
    saved = host.storage?.getItem(BENCH_STORE_KEY) ?? null;
  } catch {
    saved = null;
  }
  const leave = (href: string) => {
    clearBenchStore(host.storage);
    host.go(href);
  };
  const options: BenchUrlOptions = { tiers: request.tiers, mode: request.mode, hud: request.hud, quick: request.quick };
  benchUi("report").show({
    kind: "failed",
    failure: {
      message: error instanceof Error ? error.message : String(error),
      onDownload: saved === null ? null : () => download(saved, "fly-high-bench-saved.json"),
      onStartOver: () => leave(introUrl(host.href, options)),
      onExit: () => leave(exitUrl(host.href)),
    },
  });
}

/** The store as saved, for a page whose decision saved nothing. */
function currentStore(host: BenchHost): BenchStore | null {
  const read = openBenchStore(host.storage);
  return read.kind === "ok" ? read.store : null;
}

let pageUi: BenchUi | null = null;

/** The page load's one bench root: a page that fails shows its panel in the root it made. */
function benchUi(page: "intro" | "step" | "report"): BenchUi {
  if (pageUi === null) {
    pageUi = new BenchUi(page);
  } else {
    pageUi.page = page;
  }
  return pageUi;
}

/** The bench's own React root, beside FlightGame's, and the page's marker for bench.css. */
class BenchUi {
  private readonly root: Root;

  constructor(page: "intro" | "step" | "report") {
    document.documentElement.dataset.benchPage = page;
    const container = document.createElement("div");
    container.className = "bench-root";
    document.body.append(container);
    this.root = createRoot(container);
  }

  set page(page: "intro" | "step" | "report") {
    document.documentElement.dataset.benchPage = page;
  }

  show(view: BenchView): void {
    this.root.render(createElement(BenchApp, { view }));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The report a run ends in, with the GPU named by the renderer when WebGPU did not. */
function withRendererLabel(run: BenchRunRecord): BenchRunRecord {
  const device = run.device;
  if (!device || device.webgpu.rendererLabel) return run;
  const label = run.steps.find((step) => step.result?.end?.adapterLabel)?.result?.end?.adapterLabel;
  if (!label) return run;
  return { ...run, device: { ...device, webgpu: { ...device.webgpu, rendererLabel: label } } };
}

// --- the intro ----------------------------------------------------------------------

class IntroPage {
  private readonly ui = benchUi("intro");
  private readonly options: BenchUrlOptions;
  private device: BenchDeviceReport | null = null;
  private refresh: BenchRefresh | null = null;
  private checking = true;
  private busy = false;
  private storage: "ok" | "unavailable";
  private readonly firstLoad: BenchFirstLoad = readHttpCache();
  private readonly settingsKey = hashSettingsKey();
  private readonly ignoredParams: readonly string[];
  /** A device-only report shown in place, for a tab that cannot save one. */
  private report: ReportPage | null = null;

  constructor(
    private readonly host: BenchHost,
    request: BenchUrlRequest,
    private readonly page: Extract<BenchPage, { kind: "intro" }>,
  ) {
    this.options = { tiers: request.tiers, mode: request.mode, hud: request.hud, quick: request.quick };
    this.storage = page.storage;
    this.ignoredParams = ignoredBenchParams(host.href);
  }

  start(): void {
    this.render();
    const timings = benchTimings(this.options.quick);
    void Promise.all([collectDevice(), measureRefresh(timings.refreshProbePageMs)]).then(([device, refresh]) => {
      this.device = device;
      this.refresh = refresh;
      this.checking = false;
      this.render();
    });
  }

  private input(choice: BenchIntroChoice): StartRunInput {
    return {
      runId: newRunId(),
      options: choice.options,
      device: this.device,
      introRefresh: this.refresh,
      userLabel: choice.userLabel,
      firstLoad: this.firstLoad,
      ignoredParams: this.ignoredParams,
      settingsKey: this.settingsKey,
      now: this.host.isoNow(),
    };
  }

  private go(transition: BenchTransition): void {
    this.busy = true;
    if (writeBenchStore(this.host.storage, transition.store)) {
      this.render();
      this.host.go(transition.href);
      return;
    }
    // The probe passed and the write failed after all: say so, and offer what still works.
    this.busy = false;
    this.storage = "unavailable";
    this.render();
  }

  private render(): void {
    if (this.report) return;
    this.ui.show({
      kind: "intro",
      intro: {
        options: this.options,
        storage: this.storage,
        device: this.device,
        refresh: this.refresh,
        checking: this.checking,
        resumable: this.page.resumable,
        notice: this.page.notice,
        busy: this.busy,
        onStart: (choice) => this.go(startRun(this.input(choice), this.host.href)),
        onResume: () => {
          const resumable = this.page.resumable;
          if (!resumable) return;
          this.busy = true;
          this.render();
          this.host.go(nextHref(resumable, this.host.href));
        },
        onDeviceOnly: (choice) => {
          if (this.storage === "ok") {
            this.go(startDeviceOnlyRun(this.input(choice), this.host.href));
            return;
          }
          // Nothing can be saved for a report page, so the report shows here.
          const run = deviceOnlyRun(this.input(choice), "storage-unavailable");
          this.ui.page = "report";
          this.report = new ReportPage(this.host, run, [], null, null, this.ui);
          this.report.start();
        },
        onExit: () => {
          clearBenchStore(this.host.storage);
          this.host.go(exitUrl(this.host.href));
        },
      },
    });
  }
}

// --- the report ---------------------------------------------------------------------

class ReportPage {
  private readonly ui: BenchUi;
  private copy: BenchCopyState | null = null;
  private busy = true;
  private notice: BenchNoticeCode | null;

  constructor(
    private readonly host: BenchHost,
    private run: BenchRunRecord,
    private readonly earlier: readonly BenchRunRecord[],
    notice: BenchNoticeCode | null,
    /** Null when the tab cannot save: the run is shown, and nothing more is kept. */
    private store: BenchStore | null,
    ui?: BenchUi,
  ) {
    this.ui = ui ?? benchUi("report");
    this.notice = notice;
  }

  start(): void {
    this.render();
    const timings = benchTimings(this.run.plan.quick);
    void measureRefresh(timings.refreshProbePageMs).then((reportRefresh) => {
      const extras = { reportRefresh, settingsKeyAtEnd: hashSettingsKey() };
      if (this.store) {
        this.store = recordReportExtras(this.store, extras);
        if (this.store.current) this.run = this.store.current;
        if (!writeBenchStore(this.host.storage, this.store)) this.notice = "storage-failed";
      } else {
        this.run = {
          ...this.run,
          reportRefresh: this.run.reportRefresh ?? extras.reportRefresh,
          settingsKeyAtEnd: extras.settingsKeyAtEnd,
        };
      }
      this.busy = false;
      this.render();
    });
  }

  private report() {
    return buildReport({
      run: withRendererLabel(this.run),
      earlier: this.earlier.map(withRendererLabel),
      build: collectBuild(),
      createdAt: this.run.finishedAt ?? this.host.isoNow(),
    });
  }

  private go(transition: BenchTransition): void {
    this.busy = true;
    this.render();
    if (writeBenchStore(this.host.storage, transition.store)) {
      this.host.go(transition.href);
      return;
    }
    this.busy = false;
    this.notice = "storage-failed";
    this.render();
  }

  private render(): void {
    const report = this.report();
    const store = this.store;
    this.ui.show({
      kind: "report",
      report: {
        report,
        notice: this.notice,
        copy: this.copy,
        busy: this.busy,
        onDownload: () => download(reportToJson(report, 2), reportFileName(report)),
        onCopy: (target, text) => this.copyText(target, text),
        onPinnedPass: () => {
          if (store) this.go(startPinnedPass(store, newRunId(), hashSettingsKey(), this.host.isoNow(), this.host.href));
        },
        onRunAgain: () => {
          const run = this.run;
          this.go(startRun({
            runId: newRunId(),
            options: urlOptions(run.plan),
            device: run.device,
            introRefresh: run.reportRefresh ?? run.introRefresh,
            userLabel: run.userLabel,
            // Not a first load: the scripts and shaders are cached by now.
            firstLoad: null,
            ignoredParams: run.ignoredParams,
            settingsKey: hashSettingsKey(),
            now: this.host.isoNow(),
          }, this.host.href));
        },
        onExit: () => {
          clearBenchStore(this.host.storage);
          this.host.go(exitUrl(this.host.href));
        },
      },
    });
  }

  /** Started inside the click, never awaited first, so the browser counts it as the person's. */
  private copyText(target: BenchCopyTarget, text: string): void {
    const settle = (status: BenchCopyState["status"]) => {
      this.copy = { target, status, text };
      this.render();
    };
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      settle("failed");
      return;
    }
    clipboard.writeText(text).then(() => settle("copied"), () => settle("failed"));
  }
}

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- a step ---------------------------------------------------------------------------

/** A game error with no frame for this long fails the step (plan 2.5). */
const NO_FRAME_FAILURE_MS = 5_000;
/** FlightGame's own HUD cadence; the chip alone needs once a second. */
const HUD_REFRESH_MS = 75;
const CHIP_REFRESH_MS = 1_000;
/** Part of the renderer's error when pinned mode's per-pass GPU timer cannot be installed. */
const GPU_TIMING_INSTALL_FAILURE = "per-pass timing could not be installed";
/** The game errors a step keeps for its report. */
const GAME_ERRORS_KEPT = 10;

function chipPhaseOf(phase: StepPhase): BenchChipPhase {
  switch (phase) {
    case "waiting":
      return "starting";
    case "settling":
      return "settling";
    case "flying":
      return "flying";
    case "done":
    case "stopped":
    case "detached":
      return "done";
  }
}

function documentLoaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

class StepPage {
  private readonly ui = benchUi("step");
  private readonly run: BenchRunRecord;
  private readonly stepIndex: number;
  private readonly attempt: number;
  private readonly tierIndex: number;
  private readonly timings: BenchTimings;
  private readonly settings: GameSettings;
  private readonly gpuTimingFailed: boolean;
  private readonly pageStartMs = performance.now();
  private readonly slot = new BenchRendererSlot();
  /** Cards from the page before (a retry, a notice), shown until the flight begins. */
  private readonly startCards: BenchCardProps[] = [];
  private cards: BenchCardProps[] = [];
  /** The page's own phase over the controller's: paused, failed, stopping, done. */
  private pagePhase: BenchChipPhase | null = null;
  private stopConfirm = false;
  private chipResult: { readonly outcome: "ok" | "early-stop"; readonly fps: number | null } | null = null;
  private nextTierIndex: number | null = null;
  /** An outcome is saved: nothing else may be. */
  private ended = false;
  private navigating = false;
  private controller: StepController | null = null;
  private decorator: BenchRenderer | null = null;
  private instruments: StepInstruments = { creations: null, longTasks: null, longAnimationFrames: null, heap: null };
  private keys: KeyBlocker | null = null;
  private guards: EnvironmentGuards | null = null;
  private wakeLock: WakeLockHandle | null = null;
  private battery: BenchDeviceReport["battery"] = null;
  private refresh: BenchRefresh | null = null;
  private timer: BenchTimerReport = timerReport(null);
  private load: BenchFirstLoad = { navigationType: "unknown", httpCache: null };
  private readonly gameErrors: string[] = [];
  /** The canvas's size when the renderer was created; null before. */
  private canvas: { readonly cssWidth: number; readonly cssHeight: number; readonly devicePixelRatio: number } | null = null;
  private pinnedRenderScale: number | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** A card's countdown: when the page goes on by itself. */
  private continueAt: number | null = null;
  /** Why this attempt was voided, once it was. */
  private voided: "void-hidden" | "void-resized" | null = null;
  /** Where a voided attempt goes, once the void is saved. */
  private voidedHref: string | null = null;

  constructor(
    private readonly host: BenchHost,
    page: Extract<BenchPage, { kind: "step" }>,
    private store: BenchStore | null,
  ) {
    this.run = page.run;
    this.stepIndex = page.stepIndex;
    this.attempt = page.attempt;
    const step = page.run.steps[page.stepIndex]!;
    this.tierIndex = step.tierIndex;
    this.gpuTimingFailed = step.gpuTimingFailed === true;
    this.timings = benchTimings(page.run.plan.quick);
    this.settings = benchGameSettings(this.tierIndex);
    if (page.notice) this.startCards.push({ kind: "notice", notice: page.notice });
    if (page.previous && page.attempt > 1) {
      this.startCards.push({
        kind: "retry",
        tierIndex: this.tierIndex,
        previous: page.previous,
        attempt: page.attempt,
        maxAttempts: this.timings.maxAttempts,
      });
    }
  }

  async start(): Promise<BenchSession> {
    // Every instrument is in place before the device exists.
    this.instruments = {
      creations: installCreationCounter(),
      longTasks: observeLongTasks(),
      longAnimationFrames: observeLongAnimationFrames(),
      heap: createHeapSampler(),
    };
    this.keys = installKeyBlocker({ insideBenchUi: isInsideBenchUi, onEscape: () => this.askStop() });
    this.guards = installEnvironmentGuards((event) => this.environmentEvent(event));
    void requestWakeLock().then((handle) => {
      this.wakeLock = handle;
    });
    this.ticker = setInterval(() => this.render(), this.run.plan.hud ? HUD_REFRESH_MS : CHIP_REFRESH_MS);
    this.render();

    await documentLoaded();
    this.refresh = await measureRefresh(this.timings.refreshProbeStepMs);
    this.timer = timerReport(measureTimerGranularity().granularityMs);
    this.load = readHttpCache();
    this.battery = await collectBattery();
    if (this.ended) return NO_FLIGHT;

    this.later(() => {
      if (this.controller?.lastFrameAt === undefined || this.controller.lastFrameAt === null) {
        this.fail(`it drew no frame within ${this.timings.startupWatchdogS} s`);
      }
    }, this.timings.startupWatchdogS * 1_000);
    beginRendererStartupTrace();
    return {
      boot: { settings: this.settings, seed: BENCH_SEED },
      rendererOptions: (canvas) => this.rendererOptions(canvas),
      attach: (renderer, world) => this.attach(renderer, world),
      reportGameError: (message) => this.gameError(message),
    };
  }

  private rendererOptions(canvas: HTMLCanvasElement): BenchRendererOptions {
    const size = {
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    const options = benchRendererOptions(
      this.run.plan.mode,
      this.tierIndex,
      size.cssWidth,
      size.cssHeight,
      size.devicePixelRatio,
      !this.gpuTimingFailed,
    );
    if (this.canvas === null) {
      // FlightGame's stopRendererSafely marks the canvas when the renderer stops.
      watchRenderFailure(canvas, (reason) => this.fail(reason));
    }
    this.canvas = size;
    this.pinnedRenderScale = options.pinnedRenderScale ?? null;
    return options;
  }

  private attach(renderer: FlightRenderer, world: WorldDefinition): FlightRenderingSystem {
    const attachedAtMs = performance.now();
    this.decorator = this.slot.attach(renderer, () => {
      const pathStart = performance.now();
      const path = createBenchPath(world, this.timings);
      const pathPrecomputeMs = performance.now() - pathStart;
      const canvas = this.canvas ?? { cssWidth: 0, cssHeight: 0, devicePixelRatio: 1 };
      this.controller = new StepController({
        path,
        renderer,
        instruments: this.instruments,
        setup: {
          tierIndex: this.tierIndex,
          mode: this.run.plan.mode,
          timings: this.timings,
          expectedFingerprint: this.run.plan.pathFingerprint,
          firstRendererInTab: this.stepIndex === 0 && this.attempt === 1 && this.run.firstLoad !== null,
          refresh: this.refresh,
          timer: this.timer,
          load: this.load,
          ...canvas,
          pinnedRenderScale: this.pinnedRenderScale,
          gpuTimingFailed: this.gpuTimingFailed,
          attachedAtMs,
          pathPrecomputeMs,
          startupStages: readRendererStartupTrace,
          environment: () => this.environment(),
        },
        listener: {
          phase: () => this.render(),
          finished: (finish) => this.finished(finish),
          renderThrew: (error) => this.fail(errorText(error)),
        },
      });
      // The attempt ended while the renderer started (a hidden tab, say): it draws nothing.
      if (this.ended) this.controller.stop();
      return this.controller;
    });
    return this.decorator;
  }

  private environment() {
    const counts = this.guards?.read();
    return {
      hiddenEvents: counts?.hiddenEvents ?? 0,
      focusLostMs: counts?.focusLostMs ?? 0,
      resizes: counts?.resizes ?? 0,
      dprChanges: counts?.dprChanges ?? 0,
      wakeLock: this.wakeLock?.state ?? "unsupported",
      keysBlocked: this.keys?.blockedKeys ?? 0,
      ignoredRendererCalls: this.decorator?.ignoredRendererCalls ?? 0,
      gameErrors: [...this.gameErrors],
      battery: this.battery,
    };
  }

  // --- how a step ends ----------------------------------------------------------------

  private finished({ outcome, result }: StepFinish): void {
    if (this.ended || !this.store) return;
    this.ended = true;
    endRendererStartupTrace();
    void this.wakeLock?.release();
    const transition = recordStepResult(this.store, this.stepIndex, outcome, result, hashSettingsKey(), this.host.href);
    const saved = this.save(transition);
    const next = transition.store.current ? nextStepIndex(transition.store.current) : null;
    this.chipResult = { outcome, fps: result.windows.air?.fps ?? result.windows.ground?.fps ?? null };
    this.nextTierIndex = next === null ? null : this.run.steps[next]?.tierIndex ?? null;
    this.pagePhase = "done";
    this.render();
    // A result that could not be saved is lost; the report says what there is.
    this.later(() => this.go(saved ? transition.href : this.reportHref()), this.timings.betweenStepsS * 1_000);
  }

  /** The renderer stopped, threw, or never drew: no retry, on to the next step. */
  private fail(message: string): void {
    if (this.ended || !this.store) return;
    this.ended = true;
    this.controller?.stop();
    const transition = failStep(this.store, this.stepIndex, message, null, this.host.href);
    const saved = this.save(transition);
    this.pagePhase = "failed";
    this.continueAt = performance.now() + this.timings.failurePauseS * 1_000;
    const href = saved ? transition.href : this.reportHref();
    this.cards = [{
      kind: "failed",
      tierIndex: this.tierIndex,
      message,
      onContinue: () => this.go(href),
    }];
    this.render();
    this.later(() => this.go(href), this.timings.failurePauseS * 1_000);
  }

  /**
   * The tab was hidden, or the window changed: this attempt says nothing.
   * A hidden page saves nothing yet. The void is saved, and the countdown
   * starts, once the person is back to see why; and a reload, Back or a
   * closed tab hides the page on its way out too, where the next load must
   * find the step still claimed, to record it as interrupted with its
   * navigation type (flow.ts).
   */
  private voidAttempt(outcome: "void-hidden" | "void-resized"): void {
    if (this.ended || !this.store) return;
    this.ended = true;
    this.voided = outcome;
    this.controller?.stop();
    this.pagePhase = "paused";
    this.cards = [{
      kind: outcome === "void-hidden" ? "hidden" : "resized",
      tierIndex: this.tierIndex,
      attempt: this.attempt,
      maxAttempts: this.timings.maxAttempts,
      // The steps before this one are all over: any other open step is still to fly.
      reportNext: !this.run.steps.some((step) => step.index !== this.stepIndex && !isFinalStep(step.status)),
      onContinue: () => {
        if (this.voidedHref !== null) this.go(this.voidedHref);
      },
    }];
    if (document.visibilityState !== "hidden") this.saveVoid();
    this.render();
  }

  /** Saves the void, once, and counts down to the page it leads to. */
  private saveVoid(): void {
    if (this.voided === null || this.voidedHref !== null || !this.store) return;
    const transition = voidAttempt(this.store, this.stepIndex, this.voided, this.host.isoNow(), this.host.href);
    this.voidedHref = this.save(transition) ? transition.href : this.reportHref();
    this.countDownTo(this.voidedHref);
  }

  private countDownTo(href: string): void {
    if (this.continueAt !== null) return;
    this.continueAt = performance.now() + this.timings.failurePauseS * 1_000;
    this.later(() => this.go(href), this.timings.failurePauseS * 1_000);
  }

  private environmentEvent(event: EnvironmentEvent): void {
    switch (event) {
      case "hidden":
        this.voidAttempt("void-hidden");
        return;
      case "visible":
        if (this.pagePhase === "paused") {
          this.saveVoid();
          this.render();
        }
        return;
      case "resize":
      case "dpr":
        // Before the renderer exists, a new size is simply the size it gets.
        if (this.canvas !== null) this.voidAttempt("void-resized");
        return;
      case "blur":
      case "focus":
        // Recorded by the guards, never a void.
        return;
    }
  }

  private gameError(message: string): void {
    if (this.gameErrors.length < GAME_ERRORS_KEPT) this.gameErrors.push(message);
    if (this.ended || !this.store) return;
    if (this.run.plan.mode === "pinned" && !this.gpuTimingFailed && message.includes(GPU_TIMING_INSTALL_FAILURE)) {
      this.ended = true;
      const transition = retryWithoutGpuTiming(this.store, this.stepIndex, this.host.href);
      this.go(this.save(transition) ? transition.href : this.reportHref());
      return;
    }
    // A game error while frames still come (a worker hiccup the game survives) is recorded only.
    this.later(() => {
      const last = this.controller?.lastFrameAt ?? null;
      if (last === null || performance.now() - last >= NO_FRAME_FAILURE_MS) this.fail(message);
    }, NO_FRAME_FAILURE_MS);
  }

  private askStop(): void {
    if (this.pagePhase === "stopping") return;
    this.stopConfirm = true;
    this.render();
  }

  private stop(): void {
    const store = this.store;
    if (!store || this.navigating) return;
    this.ended = true;
    this.controller?.stop();
    const transition = stopRun(store, this.host.isoNow(), this.host.href);
    this.save(transition);
    this.pagePhase = "stopping";
    this.stopConfirm = false;
    this.render();
    this.go(transition.href);
  }

  private save(transition: BenchTransition): boolean {
    if (!writeBenchStore(this.host.storage, transition.store)) return false;
    this.store = transition.store;
    return true;
  }

  /** Where a step goes when it cannot save: the report shows what the store has. */
  private reportHref(): string {
    return reportUrl(this.host.href, this.run.runId, urlOptions(this.run.plan));
  }

  private later(callback: () => void, milliseconds: number): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      callback();
    }, milliseconds);
    this.timers.add(handle);
  }

  private go(href: string): void {
    if (this.navigating) return;
    this.navigating = true;
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
    if (this.ticker !== null) clearInterval(this.ticker);
    this.host.go(href);
  }

  // --- what the page shows ------------------------------------------------------------

  private render(): void {
    const controller = this.controller;
    const now = performance.now();
    const phase = this.pagePhase ?? chipPhaseOf(controller?.phase ?? "waiting");
    const countdown = this.continueAt === null ? null : Math.max(0, (this.continueAt - now) / 1_000);
    const cards = this.cards.map((card): BenchCardProps =>
      card.kind === "hidden" || card.kind === "resized" || card.kind === "failed"
        ? { ...card, continueInS: countdown }
        : card);
    this.ui.show({
      kind: "step",
      chip: {
        stepIndex: this.stepIndex,
        stepCount: this.run.steps.length,
        tierIndex: this.tierIndex,
        attempt: this.attempt,
        phase,
        flightElapsedS: controller?.flightElapsedS ?? 0,
        flightS: this.timings.flightS,
        remainingS: estimateRemainingSeconds(
          this.timings,
          this.run.steps.length - this.stepIndex - 1,
          (now - this.pageStartMs) / 1_000,
        ),
        result: this.chipResult,
        nextTierIndex: this.nextTierIndex,
        stopConfirm: this.stopConfirm,
        onStop: () => this.askStop(),
        onStopCancel: () => {
          this.stopConfirm = false;
          this.render();
        },
        onStopConfirm: () => this.stop(),
      },
      cards: phase === "starting" || phase === "settling" ? [...this.startCards, ...cards] : cards,
      hud: this.run.plan.hud && controller
        ? {
          state: controller.state,
          settings: this.settings,
          seed: BENCH_SEED,
          container: document.querySelector("main.flight-shell"),
        }
        : null,
    });
  }
}
