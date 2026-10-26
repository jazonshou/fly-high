/**
 * `?bench=1`: the browser instruments a benchmark page installs, most of them
 * before the renderer exists. Nothing in the game imports this module; the
 * bench session loads it through `import()` only under the flag.
 *
 * Each instrument degrades to null (or "unsupported") where the browser lacks
 * its API. Long tasks, long animation frames, the JS heap and the wake lock
 * are Chromium-only or newer than some Firefox and Safari releases, and a
 * report must never carry a zero that means "not measured".
 *
 * Every browser global is reached through an injectable parameter, so Node
 * tests drive these with fakes. They record raw entries in the report's own
 * shapes (types.ts); stats.ts summarises them.
 */

import { COARSE_TIMER_MS, estimateRefresh, nearestRank } from "./stats";
import type {
  BenchCompileCounts,
  BenchCompileEvent,
  BenchCompileKind,
  BenchFirstLoad,
  BenchHeapSample,
  BenchLongAnimationFrameEntry,
  BenchLongTaskEntry,
  BenchRefresh,
  BenchWakeLock,
} from "./types";

// --- Pipeline and shader creation -----------------------------------------

export interface CreationCounts {
  renderPipelines: number;
  renderPipelinesAsync: number;
  computePipelines: number;
  computePipelinesAsync: number;
  shaderModules: number;
  /** WGSL characters handed to `createShaderModule`; ASCII, so bytes. */
  wgslChars: number;
  /** Every creation above, so a frame's compiles are one subtraction. */
  total: number;
}

export interface CreationCounter {
  /** Live counts, mutated in place by every creation. */
  readonly counts: Readonly<CreationCounts>;
  /** The first `CREATION_EVENT_LIMIT` creations since install or `clearEvents`. */
  readonly events: readonly BenchCompileEvent[];
  clearEvents(): void;
  /** Restores every method this counter wrapped. Safe to call twice. */
  uninstall(): void;
}

export const CREATION_EVENT_LIMIT = 32;

const CREATION_METHODS: readonly (readonly [
  method: string,
  kind: BenchCompileKind,
  field: Exclude<keyof CreationCounts, "wgslChars" | "total">,
])[] = [
  ["createRenderPipeline", "render", "renderPipelines"],
  ["createRenderPipelineAsync", "render-async", "renderPipelinesAsync"],
  ["createComputePipeline", "compute", "computePipelines"],
  ["createComputePipelineAsync", "compute-async", "computePipelinesAsync"],
  ["createShaderModule", "shader-module", "shaderModules"],
];

/** One counter per patched prototype, which is what makes installing idempotent. */
const installedCounters = new WeakMap<object, CreationCounter>();

export interface CreationCounterOptions {
  /** Defaults to the browser's `GPUDevice`; null when there is none. */
  readonly device?: { readonly prototype: object } | null;
  readonly now?: () => number;
}

/**
 * Counts pipeline and shader-module creation by wrapping `GPUDevice.prototype`,
 * as the perf agent does (`tests/perf/ab/agent.ts`), with render and compute
 * pipelines kept apart. It counts calls, not driver cache misses. Installing
 * twice returns the first counter; null without WebGPU.
 */
export function installCreationCounter(
  options: CreationCounterOptions = {},
): CreationCounter | null {
  const device = options.device !== undefined
    ? options.device
    : (globalThis as { GPUDevice?: { prototype: object } }).GPUDevice ?? null;
  if (!device) return null;
  const prototype = device.prototype as Record<string, unknown>;
  const existing = installedCounters.get(prototype);
  if (existing) return existing;

  const now = options.now ?? (() => performance.now());
  const counts: CreationCounts = {
    renderPipelines: 0,
    renderPipelinesAsync: 0,
    computePipelines: 0,
    computePipelinesAsync: 0,
    shaderModules: 0,
    wgslChars: 0,
    total: 0,
  };
  const events: BenchCompileEvent[] = [];
  const restore: (() => void)[] = [];
  for (const [method, kind, field] of CREATION_METHODS) {
    const original = prototype[method];
    if (typeof original !== "function") continue;
    const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, method);
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      counts[field] += 1;
      counts.total += 1;
      if (kind === "shader-module") counts.wgslChars += wgslLength(args[0]);
      if (events.length < CREATION_EVENT_LIMIT) events.push({ t: now(), kind });
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    };
    prototype[method] = wrapped;
    restore.push(() => {
      // Someone who wrapped the method after us keeps their wrapper.
      if (prototype[method] !== wrapped) return;
      if (ownDescriptor) Object.defineProperty(prototype, method, ownDescriptor);
      else delete prototype[method];
    });
  }

  const counter: CreationCounter = {
    counts,
    events,
    clearEvents: () => {
      events.length = 0;
    },
    uninstall: () => {
      if (installedCounters.get(prototype) !== counter) return;
      installedCounters.delete(prototype);
      for (const undo of restore) undo();
    },
  };
  installedCounters.set(prototype, counter);
  return counter;
}

/** The live counts as the report records them: a copy, WGSL in KiB. */
export function compileCounts(counts: Readonly<CreationCounts>): BenchCompileCounts {
  return {
    render: counts.renderPipelines,
    renderAsync: counts.renderPipelinesAsync,
    compute: counts.computePipelines,
    computeAsync: counts.computePipelinesAsync,
    shaderModules: counts.shaderModules,
    wgslKiB: counts.wgslChars / 1_024,
  };
}

function wgslLength(descriptor: unknown): number {
  const code = (descriptor as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code.length : 0;
}

// --- Long tasks and long animation frames ---------------------------------

interface ObservedEntry {
  readonly startTime: number;
  readonly duration: number;
}

interface PerformanceObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}

/** The slice of `PerformanceObserver` these use, so a test can supply its own. */
export interface PerformanceObserverConstructor {
  new (callback: (list: { getEntries(): readonly unknown[] }) => void): PerformanceObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

function browserObserver(): PerformanceObserverConstructor | null {
  return (globalThis as { PerformanceObserver?: PerformanceObserverConstructor })
    .PerformanceObserver ?? null;
}

/**
 * Observes one entry type from now on, or returns null when the browser does
 * not list it. `buffered: false`: a page's window reads only its own entries.
 */
function observeEntries(
  type: string,
  Observer: PerformanceObserverConstructor | null,
  onEntry: (entry: unknown) => void,
): PerformanceObserverLike | null {
  if (!Observer || !Observer.supportedEntryTypes?.includes(type)) return null;
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    });
    observer.observe({ type, buffered: false });
    return observer;
  } catch {
    return null;
  }
}

/** An observer's entries so far, oldest first, at most `OBSERVED_ENTRY_LIMIT`. */
export interface EntryLog<T> {
  readonly entries: readonly T[];
  disconnect(): void;
}

/** Most entries a log keeps; a page that fills it has bigger problems to report. */
export const OBSERVED_ENTRY_LIMIT = 5_000;

/** Main-thread tasks over 50 ms (Chromium); null where unsupported. */
export function observeLongTasks(
  Observer: PerformanceObserverConstructor | null = browserObserver(),
): EntryLog<BenchLongTaskEntry> | null {
  const entries: BenchLongTaskEntry[] = [];
  const observer = observeEntries("longtask", Observer, (raw) => {
    const entry = raw as ObservedEntry;
    if (entries.length < OBSERVED_ENTRY_LIMIT) {
      entries.push({ startMs: entry.startTime, durationMs: entry.duration });
    }
  });
  if (!observer) return null;
  return { entries, disconnect: () => observer.disconnect() };
}

interface RawLongAnimationFrame extends ObservedEntry {
  readonly blockingDuration?: number;
  readonly scripts?: readonly {
    readonly sourceURL?: string;
    readonly invoker?: string;
    readonly duration?: number;
  }[];
}

/**
 * Frames over 50 ms with the scripts that ran in them (Chromium 123+), as
 * `scripts/throttle-probe.mts` collects them; null where unsupported.
 */
export function observeLongAnimationFrames(
  Observer: PerformanceObserverConstructor | null = browserObserver(),
): EntryLog<BenchLongAnimationFrameEntry> | null {
  const entries: BenchLongAnimationFrameEntry[] = [];
  const observer = observeEntries("long-animation-frame", Observer, (raw) => {
    if (entries.length >= OBSERVED_ENTRY_LIMIT) return;
    const entry = raw as RawLongAnimationFrame;
    const scripts = [...(entry.scripts ?? [])]
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 4)
      .map((script) => ({
        source: scriptSource(script.sourceURL ?? ""),
        invoker: scriptSource(script.invoker ?? ""),
        ms: Math.round(script.duration ?? 0),
      }));
    entries.push({
      startMs: entry.startTime,
      durationMs: entry.duration,
      blockingMs: entry.blockingDuration ?? 0,
      scripts,
    });
  });
  if (!observer) return null;
  return { entries, disconnect: () => observer.disconnect() };
}

/**
 * A script URL as a report may carry it: the path without query or hash, and
 * for a browser extension only the word "extension", because its id names
 * what the reader has installed. Anything that is not a URL (an invoker such
 * as "FrameRequestCallback") passes through.
 */
export function scriptSource(raw: string): string {
  if (!raw.includes("://")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "extension";
    return url.pathname;
  } catch {
    return "";
  }
}

// --- JS heap ----------------------------------------------------------------

export interface HeapSampler {
  /** Records the heap at time `t` (ms). Allocation-free; meant for once a second. */
  sample(t: number): void;
  /** Every sample so far, copied out for `summarizeHeap`. */
  samples(): BenchHeapSample[];
  readonly overflowed: boolean;
}

export interface HeapSamplerOptions {
  /** Reads used heap bytes; defaults to `performance.memory.usedJSHeapSize`. */
  readonly read?: (() => number) | null;
  readonly capacity?: number;
}

function browserHeapReader(): (() => number) | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
  return () => memory.usedJSHeapSize ?? Number.NaN;
}

/** `performance.memory` once a second; null where the browser has none. */
export function createHeapSampler(options: HeapSamplerOptions = {}): HeapSampler | null {
  const read = options.read !== undefined ? options.read : browserHeapReader();
  if (!read) return null;
  const capacity = options.capacity ?? 1_024;
  const times = new Float64Array(capacity);
  const bytes = new Float64Array(capacity);
  let count = 0;
  let overflowed = false;
  return {
    sample: (t) => {
      const value = read();
      if (!Number.isFinite(value)) return;
      if (count >= capacity) {
        overflowed = true;
        return;
      }
      times[count] = t;
      bytes[count] = value;
      count += 1;
    },
    samples: () => {
      const out: BenchHeapSample[] = [];
      for (let index = 0; index < count; index += 1) out.push({ tMs: times[index]!, usedBytes: bytes[index]! });
      return out;
    },
    get overflowed() {
      return overflowed;
    },
  };
}

// --- Animation frames and the refresh rate ---------------------------------

/** The timer and frame globals the frame instruments use, injectable for tests. */
export interface FrameClock {
  requestAnimationFrame(callback: (timestamp: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserFrameClock(): FrameClock {
  return {
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export interface RafRecorder {
  stop(): void;
}

/**
 * A rAF loop of its own that hands each frame's timestamp to `onFrame`. Every
 * rAF callback of one frame receives the same timestamp, so these are the
 * game loop's frame times without touching the game loop. Allocation-free.
 */
export function startRafRecorder(
  onFrame: (timestamp: number) => void,
  clock: FrameClock = browserFrameClock(),
): RafRecorder {
  let handle: number | null = null;
  const tick = (timestamp: number): void => {
    handle = clock.requestAnimationFrame(tick);
    onFrame(timestamp);
  };
  handle = clock.requestAnimationFrame(tick);
  return {
    stop: () => {
      if (handle !== null) clock.cancelAnimationFrame(handle);
      handle = null;
    },
  };
}

/**
 * An idle rAF loop for `durationMs`, before the renderer exists or after it
 * is gone. It resolves at the deadline even if frames stop (a hidden tab),
 * with whatever it saw.
 */
export function measureRefresh(
  durationMs: number,
  clock: FrameClock = browserFrameClock(),
): Promise<BenchRefresh | null> {
  return new Promise((resolve) => {
    // 500 Hz is beyond any display; the cap only bounds the buffer.
    const capacity = Math.ceil((durationMs / 1_000) * 500) + 2;
    const intervals = new Float64Array(capacity);
    let count = 0;
    let first: number | null = null;
    let previous: number | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      recorder.stop();
      clock.clearTimeout(deadline);
      resolve(estimateRefresh(intervals, count));
    };
    const recorder = startRafRecorder((timestamp) => {
      if (done) return;
      if (first === null) first = timestamp;
      if (previous !== null && count < capacity) {
        intervals[count] = timestamp - previous;
        count += 1;
      }
      previous = timestamp;
      if (timestamp - first >= durationMs) finish();
    }, clock);
    const deadline = clock.setTimeout(finish, durationMs + 1_000);
  });
}

// --- Timer granularity ------------------------------------------------------

export interface TimerGranularity {
  /** Median step between distinct consecutive `performance.now()` readings. */
  readonly granularityMs: number | null;
  readonly steps: number;
  /** At 0.5 ms or coarser, render-time statistics are only indicative. */
  readonly coarse: boolean;
}

/**
 * How finely this page can time anything. A page without cross-origin
 * isolation, which GitHub Pages cannot grant, gets a coarsened clock; how
 * coarse differs by browser, so each step measures it. Spins for at most
 * `budgetMs` of wall time.
 */
export function measureTimerGranularity(
  options: { readonly now?: () => number; readonly budgetMs?: number } = {},
): TimerGranularity {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.budgetMs ?? 20;
  const steps: number[] = [];
  const start = now();
  let previous = start;
  // The iteration cap ends the spin on a clock that never moves.
  for (let iteration = 0; iteration < 5_000_000 && steps.length < 64; iteration += 1) {
    const current = now();
    if (current === previous) continue;
    steps.push(current - previous);
    previous = current;
    if (current - start >= budgetMs) break;
  }
  if (steps.length === 0) return { granularityMs: null, steps: 0, coarse: false };
  steps.sort((a, b) => a - b);
  const granularityMs = nearestRank(steps, 0.5)!;
  return { granularityMs, steps: steps.length, coarse: granularityMs >= COARSE_TIMER_MS };
}

// --- HTTP cache -------------------------------------------------------------

export type CacheState = "cache" | "revalidated" | "network" | "unknown";

interface ResourceTimingLike {
  readonly name?: string;
  readonly type?: string;
  readonly transferSize?: number;
  readonly encodedBodySize?: number;
  readonly decodedBodySize?: number;
}

/**
 * Where a response came from. Nothing on the wire is the cache; less than the
 * body on the wire is a revalidation (a 304 carries headers only); anything
 * more is the network. Browsers without `transferSize`, and cross-origin
 * responses without Timing-Allow-Origin, are unknown.
 */
export function classifyCacheState(entry: ResourceTimingLike): CacheState {
  const { transferSize, encodedBodySize, decodedBodySize } = entry;
  if (typeof transferSize !== "number") return "unknown";
  if (transferSize === 0) return (decodedBodySize ?? 0) > 0 ? "cache" : "unknown";
  if (typeof encodedBodySize === "number" && transferSize < encodedBodySize) return "revalidated";
  return "network";
}

/**
 * The page's own load: how it was reached ("navigate", "reload",
 * "back_forward", "prerender"; "unknown" without timing) and where its
 * same-origin scripts came from, workers included when the browser lists
 * them. `httpCache` is null without Resource Timing.
 */
export function readHttpCache(
  timing: { getEntriesByType(type: string): readonly unknown[] } | null =
    typeof performance === "undefined" ? null : performance,
  origin: string | null = typeof location === "undefined" ? null : location.origin,
): BenchFirstLoad {
  if (!timing) return { navigationType: "unknown", httpCache: null };
  const navigation = timing.getEntriesByType("navigation")[0] as ResourceTimingLike | undefined;
  const states: Record<CacheState, number> = { cache: 0, revalidated: 0, network: 0, unknown: 0 };
  let scripts = 0;
  let transferBytes = 0;
  for (const raw of timing.getEntriesByType("resource")) {
    const entry = raw as ResourceTimingLike;
    let url: URL;
    try {
      url = new URL(entry.name ?? "");
    } catch {
      continue;
    }
    if (url.origin !== origin || !/\.m?js$/u.test(url.pathname)) continue;
    scripts += 1;
    states[classifyCacheState(entry)] += 1;
    transferBytes += entry.transferSize ?? 0;
  }
  return {
    navigationType: navigation?.type ?? "unknown",
    httpCache: {
      scripts,
      fromCache: states.cache,
      revalidated: states.revalidated,
      network: states.network,
      transferKiB: transferBytes / 1_024,
    },
  };
}

// --- Keys -------------------------------------------------------------------

export interface KeyBlocker {
  /** Key presses swallowed so far: keydowns, not counting auto-repeat. */
  readonly blockedKeys: number;
  uninstall(): void;
}

export interface KeyBlockerOptions {
  /** Whether an event is aimed at the bench's own UI, whose few keys pass. */
  readonly insideBenchUi: (target: EventTarget | null) => boolean;
  /** Escape aimed anywhere else: the run's Stop. */
  readonly onEscape?: () => void;
  /** Defaults to `window`. */
  readonly target?: EventTarget;
}

/** The keys a dialog needs; everything else is the game's. */
const BENCH_UI_KEYS: ReadonlySet<string> = new Set(["Tab", "Enter", " ", "Escape"]);

/**
 * Keeps every key away from the game for the whole step. The game listens on
 * `window` (the input manager, the control pump, the renderer's Backquote
 * debug overlay, and the terrain viewer's handlers), and any of them would
 * change what is measured; H alone would also save settings.
 *
 * A capture-phase listener on `window` runs before every other listener on
 * the page, so `stopImmediatePropagation` there stops a key everywhere. Keys
 * aimed at the bench UI pass only if a dialog needs them, and a bubble-phase
 * listener, installed before the game's, stops those again once the UI has
 * seen them. Defaults are left alone, so reload and close-tab still work.
 */
export function installKeyBlocker(options: KeyBlockerOptions): KeyBlocker {
  const target = options.target ?? window;
  let blockedKeys = 0;
  const capture = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (options.insideBenchUi(event.target) && BENCH_UI_KEYS.has(key)) return;
    event.stopImmediatePropagation();
    if (event.type !== "keydown" || (event as KeyboardEvent).repeat) return;
    blockedKeys += 1;
    if (key === "Escape") options.onEscape?.();
  };
  const bubble = (event: Event): void => {
    event.stopImmediatePropagation();
  };
  for (const type of ["keydown", "keyup"]) {
    target.addEventListener(type, capture, true);
    target.addEventListener(type, bubble, false);
  }
  return {
    get blockedKeys() {
      return blockedKeys;
    },
    uninstall: () => {
      for (const type of ["keydown", "keyup"]) {
        target.removeEventListener(type, capture, true);
        target.removeEventListener(type, bubble, false);
      }
    },
  };
}

// --- Environment ------------------------------------------------------------

export type EnvironmentEvent = "hidden" | "visible" | "resize" | "dpr" | "blur" | "focus";

export interface EnvironmentCounts {
  readonly hiddenEvents: number;
  readonly resizes: number;
  readonly dprChanges: number;
  readonly blurs: number;
  /** Time the window was unfocused while the page was visible. */
  readonly focusLostMs: number;
}

export interface EnvironmentGuards {
  /** Counts so far; `focusLostMs` includes a blur still in progress at `now`. */
  read(now?: number): EnvironmentCounts;
  uninstall(): void;
}

/** The window and document members the guards use, injectable for tests. */
export interface EnvironmentHost {
  readonly window: EventTarget & {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
    matchMedia?(query: string): EventTarget & { readonly matches: boolean };
  };
  readonly document: EventTarget & {
    readonly visibilityState: string;
    hasFocus?(): boolean;
  };
  readonly now: () => number;
}

function browserEnvironmentHost(): EnvironmentHost {
  return { window, document, now: () => performance.now() };
}

/**
 * Watches what voids or qualifies a measured step: the tab hidden, the
 * viewport resized, the device pixel ratio changed (a zoom, or the window
 * moved to another monitor), and focus lost while visible. `onEvent` hears
 * each as it happens; the counts are read at the end.
 */
export function installEnvironmentGuards(
  onEvent: (event: EnvironmentEvent, at: number) => void,
  host: EnvironmentHost = browserEnvironmentHost(),
): EnvironmentGuards {
  const { window: view, document: page, now } = host;
  let hiddenEvents = 0;
  let resizes = 0;
  let dprChanges = 0;
  let blurs = 0;
  let focusLostMs = 0;
  let width = view.innerWidth;
  let height = view.innerHeight;
  let visible = page.visibilityState !== "hidden";
  let focused = page.hasFocus?.() ?? true;
  /** When the current unfocused-and-visible stretch began; null outside one. */
  let focusLostAt: number | null = visible && !focused ? now() : null;

  const updateFocusClock = (at: number): void => {
    if (focusLostAt !== null) focusLostMs += at - focusLostAt;
    focusLostAt = visible && !focused ? at : null;
  };
  const onVisibility = (): void => {
    const at = now();
    visible = page.visibilityState !== "hidden";
    updateFocusClock(at);
    if (!visible) hiddenEvents += 1;
    onEvent(visible ? "visible" : "hidden", at);
  };
  const onResize = (): void => {
    if (view.innerWidth === width && view.innerHeight === height) return;
    width = view.innerWidth;
    height = view.innerHeight;
    resizes += 1;
    onEvent("resize", now());
  };
  const onBlur = (): void => {
    const at = now();
    focused = false;
    blurs += 1;
    updateFocusClock(at);
    onEvent("blur", at);
  };
  const onFocus = (): void => {
    const at = now();
    focused = true;
    updateFocusClock(at);
    onEvent("focus", at);
  };

  // A resolution query matches only the ratio it names, so it is re-armed for
  // the new ratio after every change.
  let dprQuery: (EventTarget & { readonly matches: boolean }) | null = null;
  const onDprChange = (): void => {
    dprChanges += 1;
    armDprQuery();
    onEvent("dpr", now());
  };
  const armDprQuery = (): void => {
    dprQuery?.removeEventListener("change", onDprChange);
    dprQuery = view.matchMedia?.(`(resolution: ${view.devicePixelRatio}dppx)`) ?? null;
    dprQuery?.addEventListener("change", onDprChange);
  };
  armDprQuery();

  page.addEventListener("visibilitychange", onVisibility);
  view.addEventListener("resize", onResize);
  view.addEventListener("blur", onBlur);
  view.addEventListener("focus", onFocus);
  return {
    read: (at = now()) => ({
      hiddenEvents,
      resizes,
      dprChanges,
      blurs,
      focusLostMs: focusLostMs + (focusLostAt !== null ? at - focusLostAt : 0),
    }),
    uninstall: () => {
      page.removeEventListener("visibilitychange", onVisibility);
      view.removeEventListener("resize", onResize);
      view.removeEventListener("blur", onBlur);
      view.removeEventListener("focus", onFocus);
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = null;
    },
  };
}

// --- Wake lock --------------------------------------------------------------

export interface WakeLockHandle {
  /**
   * "lost" once the browser lets go, which it does when the tab is hidden.
   * The bench's own `release` at the end of a step leaves it as it was.
   */
  readonly state: BenchWakeLock;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<EventTarget & { release(): Promise<void> }>;
}

/**
 * Keeps the screen awake through a step, so a display that sleeps cannot
 * stop rAF. Never throws: a refusal (no user gesture, a policy, a low
 * battery) is "denied", and a browser without the API is "unsupported".
 */
export async function requestWakeLock(
  wakeLock: WakeLockLike | null =
    typeof navigator === "undefined" ? null : (navigator as { wakeLock?: WakeLockLike }).wakeLock ?? null,
): Promise<WakeLockHandle> {
  if (!wakeLock) return { state: "unsupported", release: async () => undefined };
  let requested: (EventTarget & { release(): Promise<void> }) | null;
  try {
    requested = await wakeLock.request("screen");
  } catch {
    requested = null;
  }
  if (requested === null) return { state: "denied", release: async () => undefined };
  const sentinel = requested;
  let state: BenchWakeLock = "held";
  let released = false;
  sentinel.addEventListener("release", () => {
    if (!released) state = "lost";
  });
  return {
    get state() {
      return state;
    },
    release: async () => {
      if (released || state !== "held") return;
      released = true;
      try {
        await sentinel.release();
      } catch {
        // Already released by the browser.
      }
    },
  };
}

// --- Render failure ---------------------------------------------------------

export interface RenderFailureWatch {
  /** The first failure seen, or null. */
  readonly reason: string | null;
  disconnect(): void;
}

interface MutationObserverLike {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

/**
 * FlightGame's one stop path (`stopRendererSafely`) writes the failure into
 * the canvas's `data-render-failure` for device loss, an uncaptured WebGPU
 * error and a throwing frame alike. Watching that attribute hears all three
 * without a line in FlightGame. `onFailure` runs once; a failure already
 * written when the watch starts is reported on the next microtask. Null
 * without MutationObserver.
 */
export function watchRenderFailure(
  canvas: HTMLElement,
  onFailure: (reason: string) => void,
  Observer: (new (callback: () => void) => MutationObserverLike) | null =
    typeof MutationObserver === "undefined" ? null : MutationObserver,
): RenderFailureWatch | null {
  if (!Observer) return null;
  let reason: string | null = null;
  const check = (): void => {
    const failure = canvas.dataset.renderFailure;
    if (reason !== null || failure === undefined) return;
    reason = failure;
    observer.disconnect();
    onFailure(failure);
  };
  const observer = new Observer(check);
  observer.observe(canvas, { attributes: true, attributeFilter: ["data-render-failure"] });
  if (canvas.dataset.renderFailure !== undefined) queueMicrotask(check);
  return {
    get reason() {
      return reason;
    },
    disconnect: () => observer.disconnect(),
  };
}
