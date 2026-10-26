import { describe, expect, it, vi } from "vitest";
import {
  CREATION_EVENT_LIMIT,
  classifyCacheState,
  compileCounts,
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
  scriptSource,
  startRafRecorder,
  watchRenderFailure,
  type EnvironmentHost,
  type FrameClock,
  type PerformanceObserverConstructor,
} from "../src/bench/instruments";
import { summarizeHeap, summarizeLongAnimationFrames, summarizeLongTasks } from "../src/bench/stats";

/**
 * The `?bench=1` browser instruments, driven with fakes: Node has no
 * `GPUDevice`, no long tasks, no `performance.memory` and no rAF, which is
 * also the shape of a browser that lacks them.
 */

class FakeDevice {
  createRenderPipeline(descriptor: unknown) {
    return { pipeline: "render", descriptor, owner: this };
  }
  createRenderPipelineAsync() {
    return Promise.resolve("render-async");
  }
  createComputePipeline() {
    return "compute";
  }
  createComputePipelineAsync() {
    return Promise.resolve("compute-async");
  }
  createShaderModule(descriptor: { code: string }) {
    return { module: descriptor.code.length };
  }
}

function freshDeviceClass(): { prototype: object } {
  return class extends FakeDevice {};
}

describe("the creation counter", () => {
  it("counts render and compute pipelines apart, and shader modules with their WGSL", async () => {
    const Device = freshDeviceClass();
    let clock = 10;
    const counter = installCreationCounter({ device: Device, now: () => clock })!;
    const device = new (Device as unknown as typeof FakeDevice)();

    const result = device.createRenderPipeline({ label: "sky" });
    clock = 20;
    await device.createRenderPipelineAsync();
    device.createComputePipeline();
    device.createComputePipeline();
    await device.createComputePipelineAsync();
    device.createShaderModule({ code: "x".repeat(2_048) });

    expect(result.owner).toBe(device);
    expect(result.descriptor).toEqual({ label: "sky" });
    expect(counter.counts).toEqual({
      renderPipelines: 1,
      renderPipelinesAsync: 1,
      computePipelines: 2,
      computePipelinesAsync: 1,
      shaderModules: 1,
      wgslChars: 2_048,
      total: 6,
    });
    expect(counter.events.map((event) => event.kind)).toEqual([
      "render",
      "render-async",
      "compute",
      "compute",
      "compute-async",
      "shader-module",
    ]);
    expect(counter.events[0]!.t).toBe(10);
    expect(counter.events[1]!.t).toBe(20);
    expect(compileCounts(counter.counts)).toEqual({
      render: 1,
      renderAsync: 1,
      compute: 2,
      computeAsync: 1,
      shaderModules: 1,
      wgslKiB: 2,
    });
    counter.uninstall();
  });

  it("keeps only the first events after a clear, but counts every creation", () => {
    const Device = freshDeviceClass();
    const counter = installCreationCounter({ device: Device, now: () => 0 })!;
    const device = new (Device as unknown as typeof FakeDevice)();
    for (let index = 0; index < CREATION_EVENT_LIMIT + 10; index += 1) device.createComputePipeline();
    expect(counter.events).toHaveLength(CREATION_EVENT_LIMIT);
    counter.clearEvents();
    device.createComputePipeline();
    expect(counter.events).toHaveLength(1);
    expect(counter.counts.computePipelines).toBe(CREATION_EVENT_LIMIT + 11);
    counter.uninstall();
  });

  it("installs once however often it is asked, and uninstalls back to the original", () => {
    const Device = freshDeviceClass();
    const prototype = Device.prototype as Record<string, unknown>;
    const original = prototype.createRenderPipeline;
    const first = installCreationCounter({ device: Device })!;
    const wrapped = prototype.createRenderPipeline;
    const second = installCreationCounter({ device: Device });

    expect(second).toBe(first);
    expect(prototype.createRenderPipeline).toBe(wrapped);
    new (Device as unknown as typeof FakeDevice)().createRenderPipeline({});
    expect(first.counts.renderPipelines).toBe(1);

    first.uninstall();
    first.uninstall();
    expect(prototype.createRenderPipeline).toBe(original);
    expect(Object.hasOwn(prototype, "createRenderPipeline")).toBe(false);

    const again = installCreationCounter({ device: Device })!;
    expect(again).not.toBe(first);
    expect(again.counts.total).toBe(0);
    again.uninstall();
  });

  it("leaves a wrapper installed after its own in place", () => {
    const Device = freshDeviceClass();
    const prototype = Device.prototype as Record<string, unknown>;
    const counter = installCreationCounter({ device: Device })!;
    const later = () => "later";
    prototype.createShaderModule = later;
    counter.uninstall();
    expect(prototype.createShaderModule).toBe(later);
  });

  it("is null without WebGPU", () => {
    expect(installCreationCounter({ device: null })).toBeNull();
    expect(installCreationCounter()).toBeNull();
  });
});

/** A PerformanceObserver whose entries the test delivers. */
function fakeObserver(supported: readonly string[] | undefined) {
  const live: { callback: (list: { getEntries(): readonly unknown[] }) => void; type: string }[] = [];
  const Observer = class {
    static readonly supportedEntryTypes = supported;
    constructor(private readonly callback: (list: { getEntries(): readonly unknown[] }) => void) {}
    observe(options: { type: string }) {
      live.push({ callback: this.callback, type: options.type });
    }
    disconnect() {
      live.length = 0;
    }
  } as unknown as PerformanceObserverConstructor;
  const deliver = (type: string, entries: readonly unknown[]) => {
    for (const observer of live) {
      if (observer.type === type) observer.callback({ getEntries: () => entries });
    }
  };
  return { Observer, deliver, live };
}

describe("the long-task and long-animation-frame observers", () => {
  it("are null where the browser does not list the entry type", () => {
    expect(observeLongTasks(null)).toBeNull();
    expect(observeLongTasks(fakeObserver(undefined).Observer)).toBeNull();
    expect(observeLongTasks(fakeObserver(["paint"]).Observer)).toBeNull();
    expect(observeLongAnimationFrames(fakeObserver(["longtask"]).Observer)).toBeNull();
    // Node has no PerformanceObserver entry types for either.
    expect(observeLongAnimationFrames()).toBeNull();
  });

  it("record long tasks for stats.ts to summarise by window", () => {
    const { Observer, deliver, live } = fakeObserver(["longtask"]);
    const log = observeLongTasks(Observer)!;
    deliver("longtask", [
      { startTime: 50, duration: 80 },
      { startTime: 1_000, duration: 60 },
      { startTime: 1_500, duration: 120 },
      { startTime: 2_000, duration: 70 },
    ]);

    expect(log.entries).toHaveLength(4);
    expect(log.entries[0]).toEqual({ startMs: 50, durationMs: 80 });
    expect(summarizeLongTasks(log.entries, 1_000, 2_000)).toEqual({ supported: true, count: 2, totalMs: 180, maxMs: 120 });
    expect(summarizeLongTasks(log.entries, 3_000, 4_000)).toEqual({ supported: true, count: 0, totalMs: 0, maxMs: 0 });
    log.disconnect();
    expect(live).toHaveLength(0);
  });

  it("keep the four longest scripts of a frame and the five longest frames", () => {
    const { Observer, deliver } = fakeObserver(["long-animation-frame"]);
    const log = observeLongAnimationFrames(Observer)!;
    const frame = (startTime: number, duration: number) => ({
      startTime,
      duration,
      blockingDuration: duration - 50,
      scripts: [10, 40, 20, 30, 5].map((ms) => ({
        sourceURL: `https://jazonshou.github.io/fly-high/assets/chunk-${ms}.js?v=1`,
        invoker: "FrameRequestCallback",
        duration: ms + 0.4,
      })),
    });
    deliver("long-animation-frame", [60, 90, 70, 200, 55, 65, 80].map((ms, index) => frame(index * 100, ms)));

    const first = log.entries[0]!;
    expect(first.scripts.map((script) => script.ms)).toEqual([40, 30, 20, 10]);
    expect(first.scripts[0]).toEqual({
      source: "/fly-high/assets/chunk-40.js",
      invoker: "FrameRequestCallback",
      ms: 40,
    });
    expect(first.blockingMs).toBe(10);
    const summary = summarizeLongAnimationFrames(log.entries, 0, 1_000, 0);
    expect(summary.count).toBe(7);
    expect(summary.maxMs).toBe(200);
    expect(summary.blockingMs).toBe(620 - 7 * 50);
    expect(summary.top.map((entry) => entry.durationMs)).toEqual([200, 90, 80, 70, 65]);
  });

  it("reduce a script URL to its path, and an extension to a word", () => {
    expect(scriptSource("https://example.com/fly-high/assets/index-abc.js?x#y"))
      .toBe("/fly-high/assets/index-abc.js");
    expect(scriptSource("chrome-extension://abcdefghijklmnop/content.js")).toBe("extension");
    expect(scriptSource("DOMWindow.onclick")).toBe("DOMWindow.onclick");
    expect(scriptSource("")).toBe("");
  });
});

describe("the heap sampler", () => {
  it("is null without performance.memory", () => {
    expect(createHeapSampler({ read: null })).toBeNull();
    expect(createHeapSampler()).toBeNull();
  });

  it("reports a value that never changed in the window as stale, with no figures", () => {
    const sampler = createHeapSampler({ read: () => 64 * 1_048_576 })!;
    for (let t = 0; t < 60_000; t += 1_000) sampler.sample(t);
    expect(sampler.samples()).toHaveLength(60);
    expect(summarizeHeap(sampler.samples(), 0, 60_000)).toEqual({
      supported: true,
      precise: false,
      stale: true,
      startMiB: null,
      endMiB: null,
      peakMiB: null,
      slopeMiBPerMin: null,
    });
  });

  it("reports start, end, peak and slope from samples inside the window", () => {
    let bytes = 100 * 1_048_576;
    const sampler = createHeapSampler({ read: () => bytes })!;
    sampler.sample(-1_000);
    for (let t = 0; t <= 60_000; t += 1_000) {
      bytes = (100 + t / 60_000 * 3) * 1_048_576;
      sampler.sample(t);
    }
    expect(sampler.samples()[0]).toEqual({ tMs: -1_000, usedBytes: 100 * 1_048_576 });
    const summary = summarizeHeap(sampler.samples(), 0, 60_001);
    expect(summary.stale).toBe(false);
    expect(summary.startMiB).toBeCloseTo(100, 9);
    expect(summary.endMiB).toBeCloseTo(103, 9);
    expect(summary.peakMiB).toBeCloseTo(103, 9);
    expect(summary.slopeMiBPerMin).toBeCloseTo(3, 9);
  });

  it("reads performance.memory afresh each time, as Chromium hands out a new snapshot per read", () => {
    let bytes = 50 * 1_048_576;
    // Chromium's getter: a new object each read, holding that moment's values.
    Object.defineProperty(performance, "memory", {
      configurable: true,
      get: () => Object.freeze({ usedJSHeapSize: bytes }),
    });
    try {
      const sampler = createHeapSampler()!;
      expect(sampler).not.toBeNull();
      expect(sampler.sample(0)).toBe(50 * 1_048_576);
      bytes = 130 * 1_048_576;
      expect(sampler.sample(1_000)).toBe(130 * 1_048_576);
      const summary = summarizeHeap(sampler.samples(), 0, 1_000);
      expect(summary.stale).toBe(false);
      expect(summary.endMiB).toBeCloseTo(130, 9);
    } finally {
      delete (performance as unknown as { memory?: unknown }).memory;
    }
  });

  it("flags samples beyond its capacity", () => {
    const sampler = createHeapSampler({ read: () => 1, capacity: 2 })!;
    sampler.sample(0);
    sampler.sample(1);
    expect(sampler.overflowed).toBe(false);
    sampler.sample(2);
    expect(sampler.overflowed).toBe(true);
  });
});

/** A frame clock the test advances by hand. */
function fakeFrameClock() {
  let nextHandle = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  const clock: FrameClock = {
    requestAnimationFrame: (callback) => {
      frames.set(nextHandle, callback);
      return nextHandle++;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
    },
    setTimeout: (callback, milliseconds) => {
      timers.set(nextHandle, { at: now + milliseconds, callback });
      return nextHandle++;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const frame = (timestamp: number) => {
    now = timestamp;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(timestamp);
  };
  const advance = (to: number) => {
    now = to;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= to) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  return { clock, frame, advance, pendingFrames: () => frames.size };
}

describe("the rAF instruments", () => {
  it("hand every frame's timestamp to the recorder until it stops", () => {
    const fake = fakeFrameClock();
    const seen: number[] = [];
    const recorder = startRafRecorder((timestamp) => seen.push(timestamp), fake.clock);
    fake.frame(16);
    fake.frame(33);
    recorder.stop();
    fake.frame(50);
    expect(seen).toEqual([16, 33]);
    expect(fake.pendingFrames()).toBe(0);
  });

  it("measure an idle loop for the time asked", async () => {
    const fake = fakeFrameClock();
    const measuring = measureRefresh(1_000, fake.clock);
    for (let index = 0; index <= 130; index += 1) fake.frame(index * (1_000 / 120));
    const estimate = (await measuring)!;
    expect(estimate.rafHz).toBeCloseTo(120, 6);
    expect(estimate.samples).toBe(120);
    expect(fake.pendingFrames()).toBe(0);
  });

  it("resolve at the deadline when frames stop, as in a hidden tab", async () => {
    const fake = fakeFrameClock();
    const measuring = measureRefresh(1_000, fake.clock);
    fake.frame(0);
    fake.frame(16.7);
    fake.advance(2_000);
    // One interval is no estimate.
    expect(await measuring).toBeNull();
  });
});

describe("the timer granularity", () => {
  /** A clock that repeats each reading `holds` times before stepping by `stepMs`. */
  const steppedClock = (stepMs: number, holds: number) => {
    let reads = 0;
    return () => Math.floor(reads++ / holds) * stepMs;
  };

  it("reads a 0.1 ms clock as fine", () => {
    const result = measureTimerGranularity({ now: steppedClock(0.1, 7) });
    expect(result.granularityMs).toBeCloseTo(0.1, 9);
    expect(result.coarse).toBe(false);
    expect(result.steps).toBeGreaterThan(10);
  });

  it("reads a 1 ms clock as coarse", () => {
    const result = measureTimerGranularity({ now: steppedClock(1, 3) });
    expect(result.granularityMs).toBe(1);
    expect(result.coarse).toBe(true);
  });

  it("gives up on a clock that never moves", () => {
    expect(measureTimerGranularity({ now: () => 5 })).toEqual({
      granularityMs: null,
      steps: 0,
      coarse: false,
    });
  });
});

describe("the HTTP cache reading", () => {
  it("tells the cache, a revalidation and the network apart", () => {
    expect(classifyCacheState({ transferSize: 0, encodedBodySize: 50_000, decodedBodySize: 180_000 }))
      .toBe("cache");
    expect(classifyCacheState({ transferSize: 310, encodedBodySize: 50_000, decodedBodySize: 180_000 }))
      .toBe("revalidated");
    expect(classifyCacheState({ transferSize: 50_310, encodedBodySize: 50_000, decodedBodySize: 180_000 }))
      .toBe("network");
    expect(classifyCacheState({ transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 })).toBe("unknown");
    expect(classifyCacheState({})).toBe("unknown");
  });

  it("counts the page's own scripts and its navigation", () => {
    const origin = "https://jazonshou.github.io";
    const entries: Record<string, readonly unknown[]> = {
      navigation: [{ type: "reload", transferSize: 400, encodedBodySize: 1_200, decodedBodySize: 1_200 }],
      resource: [
        { name: `${origin}/fly-high/assets/index-a.js`, transferSize: 0, encodedBodySize: 9, decodedBodySize: 9 },
        { name: `${origin}/fly-high/assets/worker-b.js`, transferSize: 300, encodedBodySize: 9_000, decodedBodySize: 9_000 },
        { name: `${origin}/fly-high/assets/c.mjs`, transferSize: 2_348, encodedBodySize: 2_000, decodedBodySize: 2_000 },
        { name: `${origin}/fly-high/assets/index.css`, transferSize: 9_999, encodedBodySize: 9_000, decodedBodySize: 9_000 },
        { name: "https://fonts.example.com/x.js", transferSize: 9_999, encodedBodySize: 9_000, decodedBodySize: 9_000 },
        { name: "not a url" },
      ],
    };
    const report = readHttpCache({ getEntriesByType: (type) => entries[type] ?? [] }, origin);
    expect(report).toEqual({
      navigationType: "reload",
      httpCache: { scripts: 3, fromCache: 1, revalidated: 1, network: 1, transferKiB: (300 + 2_348) / 1_024 },
    });
  });

  it("knows nothing without resource timing", () => {
    expect(readHttpCache(null, null)).toEqual({ navigationType: "unknown", httpCache: null });
  });
});

/** A window-shaped target that runs capture listeners, then the UI, then bubble listeners. */
class FakeKeyTarget {
  private readonly listeners: { type: string; listener: (event: Event) => void; capture: boolean }[] = [];

  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean) {
    this.listeners.push({ type, listener, capture: capture === true });
  }

  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean) {
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === (capture === true),
    );
    if (index >= 0) this.listeners.splice(index, 1);
  }

  get count() {
    return this.listeners.length;
  }

  /** Who saw the key: "ui" for the bench UI's own handler, "game" for a later window listener. */
  press(key: string, options: { type?: string; insideUi?: boolean; repeat?: boolean } = {}): string[] {
    const seen: string[] = [];
    let stopped = false;
    const event = {
      type: options.type ?? "keydown",
      key,
      repeat: options.repeat === true,
      target: options.insideUi ? "bench-ui" : "canvas",
      stopImmediatePropagation: () => {
        stopped = true;
      },
    } as unknown as Event;
    const run = (capture: boolean) => {
      for (const entry of [...this.listeners]) {
        if (stopped) return;
        if (entry.type === event.type && entry.capture === capture) entry.listener(event);
      }
    };
    run(true);
    if (!stopped && options.insideUi) seen.push("ui");
    // The game's listeners register after the blocker, as FlightGame's do.
    this.addEventListener(event.type, () => seen.push("game"));
    run(false);
    this.listeners.pop();
    return seen;
  }
}

describe("the key blocker", () => {
  const install = (onEscape = vi.fn()) => {
    const target = new FakeKeyTarget();
    const blocker = installKeyBlocker({
      target: target as unknown as EventTarget,
      insideBenchUi: (eventTarget) => eventTarget === ("bench-ui" as unknown as EventTarget),
      onEscape,
    });
    return { target, blocker, onEscape };
  };

  it("swallows every key aimed at the game, and counts presses", () => {
    const { target, blocker } = install();
    for (const key of ["h", "H", "`", "ArrowUp", " ", "Enter", "p"]) {
      expect(target.press(key)).toEqual([]);
      expect(target.press(key, { type: "keyup" })).toEqual([]);
    }
    expect(target.press("w", { repeat: true })).toEqual([]);
    expect(blocker.blockedKeys).toBe(7);
  });

  it("lets the bench UI have Tab, Enter, Space and Escape, and nothing else", () => {
    const { target, blocker, onEscape } = install();
    for (const key of ["Tab", "Enter", " ", "Escape"]) {
      expect(target.press(key, { insideUi: true })).toEqual(["ui"]);
    }
    expect(target.press("h", { insideUi: true })).toEqual([]);
    expect(blocker.blockedKeys).toBe(1);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("turns Escape aimed at the game into the run's Stop", () => {
    const { target, onEscape } = install();
    target.press("Escape");
    target.press("Escape", { repeat: true });
    target.press("Escape", { type: "keyup" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("removes both of its listeners on uninstall", () => {
    const { target, blocker } = install();
    expect(target.count).toBe(4);
    blocker.uninstall();
    expect(target.count).toBe(0);
    expect(target.press("h")).toEqual(["game"]);
  });
});

function fakeEnvironment() {
  const view = Object.assign(new EventTarget(), {
    innerWidth: 1_280,
    innerHeight: 720,
    devicePixelRatio: 1,
    queries: [] as string[],
    query: null as (EventTarget & { matches: boolean }) | null,
    matchMedia(query: string) {
      this.queries.push(query);
      this.query = Object.assign(new EventTarget(), { matches: true });
      return this.query;
    },
  });
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  let now = 0;
  const host: EnvironmentHost = { window: view, document: page, now: () => now };
  return { view, page, host, at: (t: number) => { now = t; } };
}

describe("the environment guards", () => {
  it("hear a resize only when the viewport's size changed", () => {
    const env = fakeEnvironment();
    const onEvent = vi.fn();
    const guards = installEnvironmentGuards(onEvent, env.host);
    env.view.dispatchEvent(new Event("resize"));
    env.view.innerWidth = 1_920;
    env.at(5);
    env.view.dispatchEvent(new Event("resize"));
    expect(onEvent.mock.calls).toEqual([["resize", 5]]);
    expect(guards.read().resizes).toBe(1);
  });

  it("hear the tab hidden and shown", () => {
    const env = fakeEnvironment();
    const onEvent = vi.fn();
    const guards = installEnvironmentGuards(onEvent, env.host);
    env.page.visibilityState = "hidden";
    env.page.dispatchEvent(new Event("visibilitychange"));
    env.page.visibilityState = "visible";
    env.page.dispatchEvent(new Event("visibilitychange"));
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(["hidden", "visible"]);
    expect(guards.read().hiddenEvents).toBe(1);
  });

  it("report a page that loads in a hidden tab as hidden, which no event would", async () => {
    const env = fakeEnvironment();
    env.page.visibilityState = "hidden";
    const onEvent = vi.fn();
    const guards = installEnvironmentGuards(onEvent, env.host);
    expect(guards.read().hiddenEvents).toBe(1);
    await Promise.resolve();
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(["hidden"]);
    env.page.visibilityState = "visible";
    env.page.dispatchEvent(new Event("visibilitychange"));
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(["hidden", "visible"]);
    expect(guards.read().hiddenEvents).toBe(1);

    // Visible again, or uninstalled, before the microtask: nothing to report.
    const back = fakeEnvironment();
    back.page.visibilityState = "hidden";
    const quiet = vi.fn();
    installEnvironmentGuards(quiet, back.host).uninstall();
    await Promise.resolve();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("hear a pixel-ratio change and listen again at the new ratio", () => {
    const env = fakeEnvironment();
    const onEvent = vi.fn();
    const guards = installEnvironmentGuards(onEvent, env.host);
    const first = env.view.query!;
    env.view.devicePixelRatio = 1.5;
    first.dispatchEvent(new Event("change"));
    expect(env.view.queries).toEqual(["(resolution: 1dppx)", "(resolution: 1.5dppx)"]);
    first.dispatchEvent(new Event("change"));
    expect(guards.read().dprChanges).toBe(1);
    expect(onEvent).toHaveBeenCalledWith("dpr", 0);
    guards.uninstall();
    env.view.query!.dispatchEvent(new Event("change"));
    expect(guards.read().dprChanges).toBe(1);
  });

  it("time focus lost only while the page is visible", () => {
    const env = fakeEnvironment();
    const guards = installEnvironmentGuards(() => undefined, env.host);
    env.at(1_000);
    env.view.dispatchEvent(new Event("blur"));
    env.at(1_400);
    env.page.visibilityState = "hidden";
    env.page.dispatchEvent(new Event("visibilitychange"));
    env.at(9_000);
    env.page.visibilityState = "visible";
    env.page.dispatchEvent(new Event("visibilitychange"));
    env.at(9_100);
    expect(guards.read().focusLostMs).toBe(500);
    env.view.dispatchEvent(new Event("focus"));
    env.at(20_000);
    expect(guards.read()).toEqual({
      hiddenEvents: 1,
      resizes: 0,
      dprChanges: 0,
      blurs: 1,
      focusLostMs: 500,
    });
  });

  it("stop listening on uninstall", () => {
    const env = fakeEnvironment();
    const onEvent = vi.fn();
    installEnvironmentGuards(onEvent, env.host).uninstall();
    env.view.innerWidth = 800;
    env.view.dispatchEvent(new Event("resize"));
    env.view.dispatchEvent(new Event("blur"));
    env.page.dispatchEvent(new Event("visibilitychange"));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("the wake lock", () => {
  it("is unsupported without the API and denied when refused", async () => {
    expect((await requestWakeLock(null)).state).toBe("unsupported");
    expect((await requestWakeLock()).state).toBe("unsupported");
    const refused = { request: () => Promise.reject(new Error("NotAllowedError")) };
    expect((await requestWakeLock(refused)).state).toBe("denied");
  });

  it("is lost when the browser lets go, and stays as it was when the bench does", async () => {
    const sentinel = Object.assign(new EventTarget(), { release: vi.fn(() => Promise.resolve()) });
    const handle = await requestWakeLock({ request: () => Promise.resolve(sentinel) });
    expect(handle.state).toBe("held");
    sentinel.dispatchEvent(new Event("release"));
    expect(handle.state).toBe("lost");
    await handle.release();
    expect(sentinel.release).not.toHaveBeenCalled();

    const other = Object.assign(new EventTarget(), { release: vi.fn(() => Promise.resolve()) });
    const mine = await requestWakeLock({ request: () => Promise.resolve(other) });
    await mine.release();
    expect(other.release).toHaveBeenCalledOnce();
    // The bench's own release leaves the state as the step had it.
    other.dispatchEvent(new Event("release"));
    expect(mine.state).toBe("held");
  });
});

describe("the render-failure watch", () => {
  const fakeMutations = () => {
    const observers: { callback: () => void; options: unknown; disconnected: boolean }[] = [];
    const Observer = class {
      private readonly record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { callback, options: null, disconnected: false };
        observers.push(this.record);
      }
      observe(_target: Node, options: unknown) {
        this.record.options = options;
      }
      disconnect() {
        this.record.disconnected = true;
      }
    };
    return { Observer, observers };
  };

  it("reports FlightGame's failure attribute once", () => {
    const { Observer, observers } = fakeMutations();
    const canvas = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const onFailure = vi.fn();
    const watch = watchRenderFailure(canvas, onFailure, Observer)!;
    expect(observers[0]!.options).toEqual({ attributes: true, attributeFilter: ["data-render-failure"] });

    observers[0]!.callback();
    expect(onFailure).not.toHaveBeenCalled();
    canvas.dataset.renderFailure = "The WebGPU device was lost.";
    observers[0]!.callback();
    observers[0]!.callback();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("The WebGPU device was lost.");
    expect(watch.reason).toBe("The WebGPU device was lost.");
    expect(observers[0]!.disconnected).toBe(true);
  });

  it("reports a failure written before the watch began", async () => {
    const { Observer } = fakeMutations();
    const canvas = { dataset: { renderFailure: "frame threw" } } as unknown as HTMLElement;
    const onFailure = vi.fn();
    watchRenderFailure(canvas, onFailure, Observer);
    expect(onFailure).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("frame threw");
  });

  it("is null without MutationObserver", () => {
    const canvas = { dataset: {} } as unknown as HTMLElement;
    expect(watchRenderFailure(canvas, () => undefined, null)).toBeNull();
  });
});
