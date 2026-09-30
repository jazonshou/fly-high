/**
 * The running game under Chrome's CPU throttle, the way a DevTools user sees it.
 *
 * Exists for one acceptance bar: with DevTools' "4x slowdown" on, the lowest
 * settings (scenery Low + Performance intent = tier 0) must stay playable. The
 * perf-capture harness cannot answer that — it pins the governor, steps
 * simulation time on a fixed schedule and never throttles — so this drives the
 * real front door instead: settings in localStorage, the Start / Runway start
 * buttons, the live render loop, the physics worker, real key events.
 *
 * The throttle is `Emulation.setCPUThrottlingRate`, the call DevTools'
 * Performance panel makes. It suspends the page's MAIN thread. Whether workers
 * are slowed too is a separate switch (WORKERS=1), applied per worker target
 * over a raw browser-level CDP socket, because Playwright's CDP sessions cannot
 * address a dedicated worker. The report records whether each worker target
 * accepted it.
 *
 * Scenarios (SCENARIO=):
 *   cruise    Start = hand-off of the attract flight at airborneStartAgl.
 *             30 s at 1x, then RATE with a settle, then 30 s at RATE.
 *   takeoff   Runway start at RATE: full power, rotate at ROTATE_KT (from the
 *             physics snapshot, not the HUD), then hands off; the window runs
 *             from brake release to 60 s after lift-off.
 *   latency   cruise at RATE, then alternating pitch (S/W) and roll (D/A)
 *             taps; key event timeStamp -> first rendered frame whose
 *             control-surface or attitude digest moves.
 *   coldstart throttled from navigation: navigation -> first WebGPU
 *             getCurrentTexture() (first frame drawn), and -> the start screen.
 *   freeze    the terrain viewer held at POSE with a pinned clock, for a
 *             same-pose before/after frame pair (unthrottled unless RATE set).
 *
 * Attribution (optional, at RATE, separate windows because each perturbs fps):
 *   TRACE_S>0    Chrome trace, all processes -> <label>.trace.json
 *                (summarise with scripts/trace-summary.mts)
 *   PROFILE_S>0  V8 sampling profile of the main thread -> <label>.cpuprofile
 *                (summarise with scripts/cpuprofile-summary.mts)
 *
 * Usage:  tsx scripts/throttle-probe.mts <outDir> <url> [label]
 * Environment: SCENARIO RATE WORKERS QUALITY MODE AIRCRAFT AGL_M WIDTH HEIGHT
 *   SEED DIAGNOSTICS CAMERA SETTLE_S MEASURE_S ROTATE_KT TRIALS
 *   AFTER_LIFTOFF_S TRACE_S PROFILE_S
 *
 * A URL cannot prove which checkout serves it (shared-machine rule): the
 * runner checks the listener's cwd with lsof before calling this.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";
import { indexSourceMap, lookupSource, type SourceMapV3 } from "./sourceMapLookup.mts";

const [outDir, url, labelArg] = process.argv.slice(2);
if (!outDir || !url) throw new Error("usage: <outDir> <url> [label]");
const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const SCENARIO = env("SCENARIO", "cruise") as "cruise" | "takeoff" | "latency" | "coldstart" | "freeze";
if (!["cruise", "takeoff", "latency", "coldstart", "freeze"].includes(SCENARIO)) {
  throw new Error(`unknown SCENARIO ${SCENARIO}`);
}
const RATE = Number(env("RATE", "4"));
const THROTTLE_WORKERS = env("WORKERS", "0") === "1";
const QUALITY = env("QUALITY", "low");
const MODE = env("MODE", "performance");
const AIRCRAFT = env("AIRCRAFT", "trainer");
/** METRES above the terrain datum (protocol.ts). 914 m = 3,000 ft. */
const AGL_M = Number(env("AGL_M", "914"));
const WIDTH = Number(env("WIDTH", "1920"));
const HEIGHT = Number(env("HEIGHT", "1080"));
const SEED = env("SEED", "phase1-perf-baseline");
const DIAGNOSTICS = env("DIAGNOSTICS", "0") === "1";
const CAMERA = env("CAMERA", "chase");
const SETTLE_S = Number(env("SETTLE_S", "10"));
const MEASURE_S = Number(env("MEASURE_S", "30"));
const ROTATE_KT = Number(env("ROTATE_KT", AIRCRAFT === "airliner" ? "160" : "55"));
const TRIALS = Number(env("TRIALS", "10"));
const AFTER_LIFTOFF_S = Number(env("AFTER_LIFTOFF_S", "60"));
/**
 * Key holds for the take-off. The keyboard throttle advances 0.6/s of PUMP
 * time, and the pump is a main-thread setInterval that drops ticks under a
 * throttled main thread, so a 4 s hold is not full power at 4x.
 */
const THROTTLE_HOLD_S = Number(env("THROTTLE_HOLD_S", "10"));
const ROTATE_HOLD_S = Number(env("ROTATE_HOLD_S", "0.8"));
const TRACE_S = Number(env("TRACE_S", "0"));
const PROFILE_S = Number(env("PROFILE_S", "0"));
/**
 * SCENARIO=freeze: the terrain viewer held at one pose, for a before/after
 * frame pair. POSE = "x,y,z,yawDeg,pitchDeg" in WORLD metres (the free-fly
 * convention: yaw 0 looks +x, negative pitch looks down). The clock is pinned
 * to FREEZE_TIME_S in every frame so water, clouds and wind cannot animate
 * between arms; HOLD_S is the settle before the screenshot.
 */
const POSE = env("POSE", "");
const HOLD_S = Number(env("HOLD_S", "20"));
const FREEZE_TIME_S = Number(env("FREEZE_TIME_S", "1000"));
const KNOTS_PER_MPS = 1.943_844_5;
const label = labelArg
  ?? `${SCENARIO}-${AIRCRAFT}-${QUALITY}-${MODE}-x${RATE}${THROTTLE_WORKERS ? "w" : ""}`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  ...chromiumStdioLaunchOptions(),
  channel: "chromium",
  headless: false,
  args: [
    "--disable-crashpad-for-testing", "--disable-crash-reporter",
    "--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU",
    `--window-size=${WIDTH},${HEIGHT + 100}`,
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.addInitScript((opts: {
  quality: string; mode: string; aircraft: string; diagnostics: boolean; agl: number;
}) => {
  const w = globalThis as unknown as Record<string, unknown>;
  w.__name ??= (fn: unknown) => fn;
  try {
    const key = "aerolith.settings.v3";
    const existing = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({
      ...existing,
      quality: opts.quality,
      renderingMode: opts.mode,
      aircraft: opts.aircraft,
      airborneStartAgl: opts.agl,
      flightMode: "unassisted",
      hud: "full",
      weather: "clear",
      timeOfDay: "day",
      dayOfYear: 171,
      solarTimeHours: 12.5,
      showDiagnostics: opts.diagnostics,
    }));
  } catch { /* storage unavailable */ }

  // First frame drawn to the canvas: Babylon asks the WebGPU context for its
  // swap-chain texture once per presented frame.
  try {
    const proto = (globalThis as unknown as { GPUCanvasContext?: { prototype: Record<string, unknown> } })
      .GPUCanvasContext?.prototype;
    const original = proto?.getCurrentTexture as ((...a: unknown[]) => unknown) | undefined;
    if (proto && original) {
      proto.getCurrentTexture = function wrapped(this: unknown, ...args: unknown[]) {
        if (w.__probeFirstFrame === undefined) w.__probeFirstFrame = performance.now();
        return original.apply(this, args);
      };
    }
  } catch { /* no WebGPU */ }
  const startObserver = new MutationObserver(() => {
    if (document.querySelector('[aria-label="fly high start"]')) {
      w.__probeStartScreen = performance.now();
      startObserver.disconnect();
    }
  });
  startObserver.observe(document, { childList: true, subtree: true });

  // Frame collector: one extra rAF callback per frame, timestamps only.
  const frames: number[] = [];
  w.__probeFrames = frames;
  const tick = (now: number) => { frames.push(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  // Main-thread long tasks (> 50 ms).
  const longTasks: { start: number; duration: number }[] = [];
  w.__probeLongTasks = longTasks;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: false });
  } catch { /* unsupported */ }

  // Long animation frames (Chrome 123+): which scripts a >50 ms frame ran,
  // at negligible cost, so every hitch in every window can be attributed.
  interface LoafScript {
    invoker: string; invokerType: string; sourceURL: string; sourceFunctionName: string;
    duration: number; forcedStyleAndLayoutDuration: number;
  }
  const longFrames: {
    start: number; duration: number; blockingDuration: number; scripts: LoafScript[];
  }[] = [];
  w.__probeLongFrames = longFrames;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        startTime: number; duration: number; blockingDuration: number;
        scripts: LoafScript[];
      }[]) {
        if (longFrames.length >= 5_000) break;
        longFrames.push({
          start: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          scripts: [...entry.scripts]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 4)
            .map((x) => ({
              invoker: x.invoker, invokerType: x.invokerType,
              sourceURL: String(x.sourceURL).replace(/\?.*$/, "").replace(/^.*\/(src|node_modules)\//, "$1/"),
              sourceFunctionName: x.sourceFunctionName,
              duration: Math.round(x.duration), forcedStyleAndLayoutDuration: Math.round(x.forcedStyleAndLayoutDuration),
            })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch { /* unsupported */ }

  // Keys as the page received them: timeStamp is when the browser took the
  // input event, so the queueing delay a throttled main thread adds is inside.
  const keys: { code: string; down: boolean; t: number; handled: number }[] = [];
  w.__probeKeys = keys;
  for (const type of ["keydown", "keyup"] as const) {
    window.addEventListener(type, (event) => {
      if (event.repeat) return;
      keys.push({ code: event.code, down: type === "keydown", t: event.timeStamp, handled: performance.now() });
    }, { capture: true });
  }

  // Worker traffic and the physics snapshot stream (what the sim thinks).
  interface Snap { t: number; sim: number; ias: number; agl: number; onGround: boolean; elevator: number; aileron: number; crashed: boolean }
  const workerStats: { messages: number; snapshots: number; log: Snap[]; latest: Snap | null } = {
    messages: 0, snapshots: 0, log: [], latest: null,
  };
  w.__probeWorkers = workerStats;
  const NativeWorker = globalThis.Worker;
  class CountingWorker extends NativeWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);
      this.addEventListener("message", (event: MessageEvent) => {
        workerStats.messages += 1;
        const data = event.data as { type?: string; state?: Record<string, unknown> } | null;
        if (data && data.type === "snapshot" && data.state) {
          const s = data.state;
          const snap: Snap = {
            t: performance.now(),
            sim: Number(s.simulationTime),
            ias: Number(s.airspeed),
            agl: Number(s.altitudeAgl),
            onGround: Boolean(s.onGround),
            elevator: Number(s.elevator),
            aileron: Number(s.aileron),
            crashed: Boolean(s.crashed),
          };
          workerStats.snapshots += 1;
          workerStats.latest = snap;
          if (workerStats.log.length < 20_000) workerStats.log.push(snap);
        }
      });
    }
  }
  globalThis.Worker = CountingWorker as unknown as typeof Worker;
}, { quality: QUALITY, mode: MODE, aircraft: AIRCRAFT, diagnostics: DIAGNOSTICS, agl: AGL_M });

// ---------------------------------------------------------------- helpers

const pageCdp = await page.context().newCDPSession(page);

/**
 * Worker targets, reached over Playwright's own BROWSER-level CDP session.
 * (A second `--remote-debugging-port` hangs this machine's Playwright launch;
 * measured 2026-09-29: 324 ms without it, a 30 s timeout with it.) Playwright
 * cannot open a session on a dedicated worker, so the worker is attached
 * non-flattened and addressed through Target.sendMessageToTarget.
 */
type BrowserSession = Awaited<ReturnType<typeof browser.newBrowserCDPSession>>;
let browserSessionPromise: Promise<BrowserSession> | null = null;
const workerReplies = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextWorkerMessageId = 1;
function browserSession(): Promise<BrowserSession> {
  browserSessionPromise ??= (async () => {
    const session = await browser.newBrowserCDPSession();
    session.on("Target.receivedMessageFromTarget", (event: { message: string }) => {
      const reply = JSON.parse(event.message) as { id?: number; error?: { message: string }; result?: unknown };
      if (reply.id === undefined) return;
      const waiter = workerReplies.get(reply.id);
      if (!waiter) return;
      workerReplies.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error.message));
      else waiter.resolve(reply.result);
    });
    return session;
  })();
  return browserSessionPromise;
}
async function sendToWorker(sessionId: string, method: string, params: object): Promise<unknown> {
  const session = await browserSession();
  const id = nextWorkerMessageId++;
  const reply = new Promise<unknown>((resolve, reject) => {
    workerReplies.set(id, { resolve, reject });
    setTimeout(() => {
      if (workerReplies.delete(id)) reject(new Error(`${method}: no reply from worker in 5 s`));
    }, 5_000);
  });
  await session.send("Target.sendMessageToTarget", {
    sessionId, message: JSON.stringify({ id, method, params }),
  });
  return reply;
}

const workerThrottle: { url: string; rate: number; ok: boolean; error?: string }[] = [];
const workerSessions = new Map<string, string>();
const workerRates = new Map<string, number>();
async function setThrottle(rate: number): Promise<void> {
  await pageCdp.send("Emulation.setCPUThrottlingRate", { rate });
  if (!THROTTLE_WORKERS) return;
  const session = await browserSession();
  const { targetInfos } = await session.send("Target.getTargets") as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  for (const info of targetInfos.filter((t) => t.type === "worker")) {
    if (workerRates.get(info.targetId) === rate) continue;
    workerRates.set(info.targetId, rate);
    try {
      let sessionId = workerSessions.get(info.targetId);
      if (!sessionId) {
        ({ sessionId } = await session.send("Target.attachToTarget", {
          targetId: info.targetId, flatten: false,
        }) as { sessionId: string });
        workerSessions.set(info.targetId, sessionId);
      }
      await sendToWorker(sessionId, "Emulation.setCPUThrottlingRate", { rate });
      workerThrottle.push({ url: info.url.replace(/^.*\//, ""), rate, ok: true });
    } catch (error) {
      workerThrottle.push({ url: info.url.replace(/^.*\//, ""), rate, ok: false, error: (error as Error).message });
    }
  }
}

async function evaluate<T>(fn: () => T): Promise<T> {
  return page.evaluate(fn);
}

async function resetCollectors(): Promise<number> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    (w.__probeFrames as number[]).length = 0;
    (w.__probeLongTasks as unknown[]).length = 0;
    const ws = w.__probeWorkers as { messages: number; snapshots: number; log: unknown[] };
    ws.messages = 0; ws.snapshots = 0; ws.log.length = 0;
    return performance.now();
  });
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}
const round = (v: number) => Math.round(v * 100) / 100;

interface WindowStats {
  longFrames: unknown[];
  seconds: number;
  frames: number;
  fpsMean: number;
  fpsMedian: number;
  intervalMs: { p50: number; p95: number; p99: number; max: number };
  over33: number;
  over50: number;
  over66: number;
  over100: number;
  over250: number;
  over400: number;
  longTasks: { count: number; totalMs: number; maxMs: number };
  worker: { messagesPerS: number; snapshotsPerS: number; simToWallRatio: number | null };
  diagnosticsText: string | null;
}

/** Collect the window that started at the last resetCollectors(). */
async function collect(fromMs: number | null = null): Promise<WindowStats> {
  const raw = await evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    const ws = w.__probeWorkers as { messages: number; snapshots: number; log: { t: number; sim: number }[] };
    const diag = document.querySelector('[aria-label="Performance diagnostics"]') as HTMLElement | null;
    return {
      now: performance.now(),
      frames: (w.__probeFrames as number[]).slice(),
      longTasks: (w.__probeLongTasks as { start: number; duration: number }[]).slice(),
      longFrames: ((w.__probeLongFrames as { start: number; duration: number }[] | undefined) ?? [])
        .filter((f) => f.duration >= 100),
      state: ((w.__probeState as { t: number }[] | undefined) ?? []).slice(),
      messages: ws.messages,
      snapshots: ws.snapshots,
      simTimes: ws.log.map((s) => [s.t, s.sim] as [number, number]),
      diagnosticsText: diag ? diag.innerText.replace(/\s*\n\s*/g, " | ") : null,
    };
  });
  const frames = fromMs === null ? raw.frames : raw.frames.filter((t) => t >= fromMs);
  const intervals: number[] = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i]! - frames[i - 1]!);
  const sorted = intervals.slice().sort((a, b) => a - b);
  const span = frames.length > 1 ? (frames.at(-1)! - frames[0]!) / 1_000 : Number.NaN;
  // Median fps over 1 s buckets: what a pilot reads off a counter.
  const perSecond: number[] = [];
  if (frames.length > 1) {
    const t0 = frames[0]!;
    const buckets = new Map<number, number>();
    for (const t of frames) {
      const b = Math.floor((t - t0) / 1_000);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    const full = Math.floor((frames.at(-1)! - t0) / 1_000);
    for (let b = 0; b < full; b += 1) perSecond.push(buckets.get(b) ?? 0);
  }
  perSecond.sort((a, b) => a - b);
  const sims = fromMs === null ? raw.simTimes : raw.simTimes.filter(([t]) => t >= fromMs);
  let simToWallRatio: number | null = null;
  if (sims.length > 2) {
    const [w0, s0] = sims[0]!;
    const [w1, s1] = sims.at(-1)!;
    simToWallRatio = (s1 - s0) / ((w1 - w0) / 1_000);
  }
  const lt = (fromMs === null ? raw.longTasks : raw.longTasks.filter((t) => t.start >= fromMs))
    .map((t) => t.duration);
  const seconds = Number.isFinite(span) ? span : 1;
  const windowStart = frames[0] ?? 0;
  const windowFrames = (fromMs === null
    ? raw.longFrames.filter((f) => f.start >= windowStart)
    : raw.longFrames.filter((f) => f.start >= fromMs)) as { start: number; duration: number }[];
  const stateNear = (t: number) => {
    let best: { t: number } | null = null;
    for (const sample of raw.state) if (sample.t <= t + 1_000 && (!best || Math.abs(sample.t - t) < Math.abs(best.t - t))) best = sample;
    return best;
  };
  const longFrames = windowFrames
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 12)
    .map((f) => ({ ...f, atS: round((f.start - windowStart) / 1_000), state: stateNear(f.start) }));
  return {
    longFrames,
    seconds: round(seconds),
    frames: frames.length,
    fpsMean: round(intervals.length / seconds),
    fpsMedian: quantile(perSecond, 0.5),
    intervalMs: {
      p50: round(quantile(sorted, 0.5)),
      p95: round(quantile(sorted, 0.95)),
      p99: round(quantile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? Number.NaN),
    },
    over33: intervals.filter((v) => v > 33.4).length,
    over50: intervals.filter((v) => v > 50).length,
    over66: intervals.filter((v) => v > 66.7).length,
    over100: intervals.filter((v) => v > 100).length,
    over250: intervals.filter((v) => v > 250).length,
    over400: intervals.filter((v) => v > 400).length,
    longTasks: {
      count: lt.length,
      totalMs: round(lt.reduce((a, b) => a + b, 0)),
      maxMs: round(Math.max(0, ...lt)),
    },
    worker: {
      messagesPerS: round(raw.messages / seconds),
      snapshotsPerS: round(raw.snapshots / seconds),
      simToWallRatio: simToWallRatio === null ? null : round(simToWallRatio),
    },
    diagnosticsText: raw.diagnosticsText,
  };
}

async function measure(seconds: number): Promise<WindowStats> {
  await resetCollectors();
  await page.waitForTimeout(seconds * 1_000);
  return collect();
}

/**
 * The renderer's own RenderDiagnostics (draw calls, governor, CPU p95, top
 * passes) WITHOUT the overlay, which is a React render every 500 ms. Found by
 * walking React's fiber from the game canvas up to the component holding the
 * renderer ref; read-only, a handful of calls per run.
 */
async function readRendererDiagnostics(): Promise<Record<string, unknown> | null> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    type Hook = { memoizedState?: unknown; next?: Hook | null };
    type Fiber = { memoizedState?: unknown; return?: Fiber | null };
    const canvas = document.querySelector("canvas") as (HTMLCanvasElement & Record<string, unknown>) | null;
    if (!canvas) return null;
    const key = Object.keys(canvas).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? canvas[key] as Fiber | null : null;
    while (fiber) {
      let hook = fiber.memoizedState as Hook | null | undefined;
      for (let guard = 0; hook && typeof hook === "object" && guard < 200; guard += 1) {
        const state = hook.memoizedState as { current?: { getDiagnostics?: () => unknown } } | null;
        if (state && typeof state === "object" && typeof state.current?.getDiagnostics === "function") {
          return JSON.parse(JSON.stringify(state.current.getDiagnostics())) as Record<string, unknown>;
        }
        hook = hook.next;
      }
      fiber = fiber.return ?? null;
    }
    return null;
  });
}

/**
 * A 1 Hz page-side sampler of the state a hitch might line up with: the
 * governor's ladder levels, streaming queues, and the hydrology client's
 * worker/fallback statistics (P2). Reads the renderer through the canvas's
 * React fiber once, then keeps the reference.
 */
async function installStateSampler(): Promise<boolean> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    type Hook = { memoizedState?: unknown; next?: Hook | null };
    type Fiber = { memoizedState?: unknown; return?: Fiber | null };
    type Renderer = {
      getDiagnostics: () => Record<string, unknown>;
      hydrology?: { getStatistics?: () => Record<string, unknown> };
    };
    const canvas = document.querySelector("canvas") as (HTMLCanvasElement & Record<string, unknown>) | null;
    if (!canvas) return false;
    const key = Object.keys(canvas).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? canvas[key] as Fiber | null : null;
    let renderer: Renderer | null = null;
    while (fiber && !renderer) {
      let hook = fiber.memoizedState as Hook | null | undefined;
      for (let guard = 0; hook && typeof hook === "object" && guard < 200; guard += 1) {
        const state = hook.memoizedState as { current?: Renderer } | null;
        if (state && typeof state === "object" && typeof state.current?.getDiagnostics === "function") {
          renderer = state.current;
          break;
        }
        hook = hook.next;
      }
      fiber = fiber.return ?? null;
    }
    if (!renderer) return false;
    const samples: Record<string, unknown>[] = [];
    w.__probeState = samples;
    const found = renderer;
    setInterval(() => {
      if (samples.length >= 2_000) return;
      const d = found.getDiagnostics();
      const h = found.hydrology?.getStatistics?.() ?? null;
      samples.push({
        t: performance.now(),
        cpuL: d.cpuWorkLevel, gpuL: d.gpuWorkLevel, lever: d.cpuWorkLever,
        // The resolution ladder is a governor lever too: an arm that stepped
        // it differs in pixels for a reason that is not the change under test.
        scale: d.renderScale, insensitive: d.resolutionInsensitive, active: d.activeGovernor,
        pendingTerrainPages: d.pendingTerrainPages, pendingDetailWork: d.pendingDetailWork,
        residentTerrainPages: d.residentTerrainPages, drawCalls: d.drawCalls,
        hydrology: h ? {
          fallback: h.usingMainThreadFallback, usedWorker: h.lastGenerationUsedWorker,
          requests: h.pagingRequestCount, swaps: h.regionSwapCount,
          failed: h.failedGenerationCount, lastMs: h.lastGenerationMilliseconds,
          region: h.activeRegionKey,
        } : null,
      });
    }, 1_000);
    return true;
  });
}

/** Five reads a second apart: draw calls vary frame to frame, the governor does not. */
async function sampleDiagnostics(): Promise<{
  drawCalls: number[];
  governor: unknown[];
  last: Record<string, unknown> | null;
}> {
  const drawCalls: number[] = [];
  const governor: unknown[] = [];
  let last: Record<string, unknown> | null = null;
  for (let i = 0; i < 5; i += 1) {
    const d = await readRendererDiagnostics();
    if (d) {
      last = d;
      drawCalls.push(Number(d.drawCalls));
      governor.push({
        active: d.activeGovernor, cpuL: d.cpuWorkLevel, gpuL: d.gpuWorkLevel,
        cpuLever: d.cpuWorkLever, scale: d.renderScale, insensitive: d.resolutionInsensitive,
      });
    }
    await page.waitForTimeout(1_000);
  }
  return { drawCalls, governor, last };
}

async function latestSnapshot(): Promise<{ ias: number; agl: number; onGround: boolean; crashed: boolean } | null> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    return (w.__probeWorkers as { latest: { ias: number; agl: number; onGround: boolean; crashed: boolean } | null }).latest;
  });
}

async function waitForStartScreen(): Promise<void> {
  await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 240_000 });
}

async function blur(): Promise<void> {
  await evaluate(() => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

async function timings(): Promise<{ firstFrameMs: number | null; startScreenMs: number | null }> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    return {
      firstFrameMs: (w.__probeFirstFrame as number | undefined) ?? null,
      startScreenMs: (w.__probeStartScreen as number | undefined) ?? null,
    };
  });
}

async function trace(seconds: number): Promise<string | null> {
  if (seconds <= 0) return null;
  await browser.startTracing(page, {
    categories: [
      "toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline",
      "v8.execute", "blink.user_timing", "gpu",
    ],
  });
  await page.waitForTimeout(seconds * 1_000);
  const buffer = await browser.stopTracing();
  const file = `${outDir}/${label}.trace.json`;
  writeFileSync(file, buffer);
  return file;
}

async function profile(seconds: number): Promise<string | null> {
  if (seconds <= 0) return null;
  await pageCdp.send("Profiler.enable");
  await pageCdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await pageCdp.send("Profiler.start");
  await page.waitForTimeout(seconds * 1_000);
  const { profile: data } = await pageCdp.send("Profiler.stop") as { profile: ProfileData };
  await attachOriginalSources(data);
  const file = `${outDir}/${label}.cpuprofile`;
  writeFileSync(file, JSON.stringify(data));
  return file;
}

interface ProfileData {
  nodes: { callFrame: { url: string; lineNumber: number; columnNumber: number; originalSource?: string } }[];
}

/**
 * Stamp each profile frame with its ORIGINAL source file while the dev server
 * is still up: Vite's dependency bundles are named after one of their
 * modules, so only the source map can say "Babylon" or "React".
 */
async function attachOriginalSources(data: ProfileData): Promise<void> {
  const maps = new Map<string, { map: SourceMapV3; index: ReturnType<typeof indexSourceMap> } | null>();
  for (const node of data.nodes) {
    const frame = node.callFrame;
    if (!frame.url || !/^https?:/.test(frame.url)) continue;
    const path = new URL(frame.url).pathname;
    if (!/node_modules/.test(path)) {
      frame.originalSource = path.replace(/^\//, "");
      continue;
    }
    if (!maps.has(frame.url)) {
      maps.set(frame.url, await fetchSourceMap(frame.url).catch(() => null));
    }
    const entry = maps.get(frame.url);
    if (!entry || frame.lineNumber < 0) continue;
    const source = lookupSource(entry.map, entry.index, frame.lineNumber, Math.max(0, frame.columnNumber));
    if (source) frame.originalSource = source;
  }
}

async function fetchSourceMap(scriptUrl: string) {
  const code = await (await fetch(scriptUrl)).text();
  const match = code.match(/\/\/[#@] sourceMappingURL=(\S+)\s*$/);
  if (!match) return null;
  const ref = match[1]!;
  let json: string;
  if (ref.startsWith("data:")) {
    json = Buffer.from(ref.slice(ref.indexOf(",") + 1), "base64").toString("utf8");
  } else {
    json = await (await fetch(new URL(ref, scriptUrl))).text();
  }
  const map = JSON.parse(json) as SourceMapV3;
  return { map, index: indexSourceMap(map) };
}

/**
 * Per-frame digests read from the live Babylon scene after each render:
 * control-surface pose (every node named like an aileron/elevator) and the
 * aircraft root's absolute orientation. The first frame either leaves its
 * pre-key value is the first frame that could SHOW the input.
 */
async function installSceneSampler(): Promise<{ surfaceNodes: number; ok: boolean }> {
  return evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore[^/]*\.js/.test(n));
    if (!storeUrl) return { surfaceNodes: 0, ok: false };
    type Q = { x: number; y: number; z: number; w: number };
    type Node = {
      name: string;
      metadata?: { aircraftVisual?: boolean } | null;
      rotation?: { x: number; y: number; z: number };
      rotationQuaternion?: Q | null;
      absoluteRotationQuaternion?: Q;
    };
    type SceneLike = {
      transformNodes: Node[];
      meshes: Node[];
      onAfterRenderObservable: { add: (cb: () => void) => unknown };
    };
    return import(/* @vite-ignore */ storeUrl).then((mod: Record<string, unknown>) => {
      const store = Object.values(mod).find(
        (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
      ) as { Instances: { scenes: SceneLike[] }[] } | undefined;
      const scene = store?.Instances[0]?.scenes[0];
      if (!scene) return { surfaceNodes: 0, ok: false };
      const root = scene.transformNodes.find((n) => n.metadata?.aircraftVisual) ?? null;
      const surfaces = [...scene.transformNodes, ...scene.meshes]
        .filter((n) => /aileron|elevator/i.test(n.name));
      const log: [number, number, number][] = [];
      w.__probeSceneLog = log;
      scene.onAfterRenderObservable.add(() => {
        let s = 0;
        for (const n of surfaces) {
          const q = n.rotationQuaternion;
          if (q) s += Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z);
          else if (n.rotation) s += Math.abs(n.rotation.x) + Math.abs(n.rotation.y) + Math.abs(n.rotation.z);
        }
        const a = root?.absoluteRotationQuaternion;
        const att = a ? a.x * 1.3 + a.y * 1.7 + a.z * 2.3 + a.w * 2.9 : 0;
        if (log.length < 50_000) log.push([performance.now(), s, att]);
      });
      return { surfaceNodes: surfaces.length, ok: true };
    });
  });
}

// ---------------------------------------------------------------- scenarios

const report: Record<string, unknown> = {
  label,
  scenario: SCENARIO,
  capturedAtIso: new Date().toISOString(),
  settings: { quality: QUALITY, mode: MODE, aircraft: AIRCRAFT, camera: CAMERA, seed: SEED, aglM: AGL_M, width: WIDTH, height: HEIGHT },
  rate: RATE,
  throttleWorkers: THROTTLE_WORKERS,
};

const target = new URL(url);
target.searchParams.set("seed", SEED);

if (SCENARIO === "coldstart") await setThrottle(RATE);
const navStarted = Date.now();
await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
// Workers spawn during load; a throttled cold start must catch each one.
let loading = SCENARIO === "coldstart" && THROTTLE_WORKERS;
const workerCatcher = (async () => {
  while (loading) {
    await setThrottle(RATE).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();
await waitForStartScreen();
loading = false;
await workerCatcher;
report.startScreenWallMs = Date.now() - navStarted;
report.load = await timings();

if (SCENARIO === "freeze") {
  const pose = POSE.split(",").map(Number);
  if (pose.length !== 5 || pose.some((v) => !Number.isFinite(v))) throw new Error("POSE must be x,y,z,yawDeg,pitchDeg");
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: /^Enter the beta terrain viewer/ }).first().click();
  await blur();
  await page.waitForTimeout(1_000);
  report.freeze = await page.evaluate((args: { pose: number[]; time: number }) => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    type Hook = { memoizedState?: unknown; next?: Hook | null };
    type Fiber = { memoizedState?: unknown; return?: Fiber | null };
    type FreeFly = Record<string, unknown> & { update: (now: number) => { simulationTime: number } };
    const canvas = document.querySelector("canvas") as (HTMLCanvasElement & Record<string, unknown>) | null;
    if (!canvas) return { ok: false, reason: "no canvas" };
    const key = Object.keys(canvas).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? canvas[key] as Fiber | null : null;
    let controller: FreeFly | null = null;
    while (fiber && !controller) {
      let hook = fiber.memoizedState as Hook | null | undefined;
      for (let guard = 0; hook && typeof hook === "object" && guard < 200; guard += 1) {
        const state = hook.memoizedState as { current?: FreeFly } | null;
        // Refs hold anything (the phase ref holds a string): test the type
        // before `in`, which throws on a primitive.
        if (state && typeof state === "object" && state.current && typeof state.current === "object"
          && "yawRadians" in state.current && typeof state.current.update === "function") {
          controller = state.current;
          break;
        }
        hook = hook.next;
      }
      fiber = fiber.return ?? null;
    }
    if (!controller) return { ok: false, reason: "no free-fly controller" };
    const [x, y, z, yawDeg, pitchDeg] = args.pose as [number, number, number, number, number];
    const hold = () => {
      controller!.positionX = x; controller!.positionY = y; controller!.positionZ = z;
      controller!.yawRadians = (yawDeg * Math.PI) / 180;
      controller!.pitchRadians = (pitchDeg * Math.PI) / 180;
      controller!.velocityX = 0; controller!.velocityY = 0; controller!.velocityZ = 0;
      (controller!.pressed as Set<string>).clear();
    };
    hold();
    const update = controller.update.bind(controller);
    controller.update = (now: number) => {
      hold();
      const state = update(now);
      state.simulationTime = args.time;
      return state;
    };
    const style = document.createElement("style");
    style.textContent = ".viewer-hud, .hud, .diagnostics { display: none !important; }";
    document.head.appendChild(style);
    return { ok: true, pose: args.pose, time: args.time };
  }, { pose, time: FREEZE_TIME_S });
  report.stateSampler = await installStateSampler();
  if (RATE !== 1) await setThrottle(RATE);
  await page.waitForTimeout(HOLD_S * 1_000);
  report.freezeWindow = await measure(3);
  report.stateLastAtShot = await evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    return ((w.__probeState as unknown[] | undefined) ?? []).at(-1) ?? null;
  });
  console.log(`[${label}] freeze ${JSON.stringify(report.freeze)} state ${JSON.stringify(report.stateLastAtShot)}`);
} else if (SCENARIO === "coldstart") {
  report.stateSampler = await installStateSampler();
  // The start screen is a live attract flight: how it runs throttled, too.
  report.attractThrottled = await measure(Math.min(MEASURE_S, 15));
  report.diagnosticsThrottled = await sampleDiagnostics();
} else if (SCENARIO === "cruise" || SCENARIO === "latency") {
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: /^Start flying/ }).first().click();
  await blur();
  if (CAMERA === "cockpit") await page.keyboard.press("c");
  report.stateSampler = await installStateSampler();
  await page.waitForTimeout(SETTLE_S * 1_000);
  if (SCENARIO === "cruise") {
    report.unthrottled = await measure(MEASURE_S);
    console.log(`[${label}] x1  ${JSON.stringify(summaryOf(report.unthrottled as WindowStats))}`);
    report.diagnosticsUnthrottled = await sampleDiagnostics();
  }
  await setThrottle(RATE);
  await page.waitForTimeout(SETTLE_S * 1_000);
  if (SCENARIO === "cruise") {
    report.throttled = await measure(MEASURE_S);
    console.log(`[${label}] x${RATE} ${JSON.stringify(summaryOf(report.throttled as WindowStats))}`);
    report.diagnosticsThrottled = await sampleDiagnostics();
    const d = report.diagnosticsThrottled as { drawCalls: number[]; governor: unknown[] };
    console.log(`[${label}] x${RATE} draws ${d.drawCalls.join(",")} governor ${JSON.stringify(d.governor.at(-1))}`);
  } else {
    report.sampler = await installSceneSampler();
    await page.waitForTimeout(1_000);
    const plan = Array.from({ length: TRIALS * 2 }, (_, i) =>
      (["KeyS", "KeyD", "KeyW", "KeyA"] as const)[i % 4]!);
    await resetCollectors();
    for (const code of plan) {
      await page.waitForTimeout(1_500);
      await page.keyboard.down(code);
      await page.waitForTimeout(300);
      await page.keyboard.up(code);
    }
    await page.waitForTimeout(1_500);
    report.latencyWindow = await collect();
    report.latency = await latencyAnalysis();
    console.log(`[${label}] latency ${JSON.stringify((report.latency as { summary: unknown }).summary)}`);
  }
} else if (SCENARIO === "takeoff") {
  await setThrottle(RATE);
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: /^Start on the runway/ }).first().click();
  await blur();
  report.stateSampler = await installStateSampler();
  await page.waitForTimeout(3_000);
  const releasedAt = await resetCollectors();
  const releasedWall = Date.now();
  // Full power: Shift held long enough for the lever to reach its stop.
  await page.keyboard.down("ShiftLeft");
  await page.waitForTimeout(THROTTLE_HOLD_S * 1_000);
  await page.keyboard.up("ShiftLeft");
  const events: { rotate: number | null; liftoff: number | null; timeout: number | null; crashed?: number } = {
    rotate: null, liftoff: null, timeout: null,
  };
  const deadline = Date.now() + 150_000;
  let rotated = false;
  while (Date.now() < deadline) {
    const snap = await latestSnapshot();
    if (snap?.crashed) { events.crashed = Date.now(); break; }
    if (!rotated && snap && snap.ias * KNOTS_PER_MPS >= ROTATE_KT) {
      rotated = true;
      events.rotate = Date.now();
      await page.keyboard.down("KeyS");
      await page.waitForTimeout(ROTATE_HOLD_S * 1_000);
      await page.keyboard.up("KeyS");
    }
    if (rotated && snap && !snap.onGround && snap.agl > 5 && events.liftoff === null) {
      events.liftoff = Date.now();
    }
    const liftoff = events.liftoff;
    if (liftoff !== null && Date.now() - liftoff > AFTER_LIFTOFF_S * 1_000) break;
    await page.waitForTimeout(500);
  }
  if (events.liftoff === null) events.timeout = Date.now();
  report.takeoffEvents = Object.fromEntries(Object.entries(events)
    .map(([k, v]) => [k, v === null ? null : round((v - releasedWall) / 1_000)]));
  report.throttled = await collect(releasedAt);
  report.diagnosticsThrottled = await sampleDiagnostics();
  console.log(`[${label}] takeoff x${RATE} ${JSON.stringify(summaryOf(report.throttled as WindowStats))} events ${JSON.stringify(report.takeoffEvents)}`);
}

// Attribution windows, throttled (the cruise/latency/takeoff session is still at RATE).
report.traceFile = await trace(TRACE_S);
report.profileFile = await profile(PROFILE_S);
report.workerThrottle = workerThrottle;
// Every long frame of the whole session (load included) whose scripts name
// hydrology: a main-thread generateHydrology shows up here wherever it lands.
report.hydrologyLongFrames = await evaluate(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  w.__name ??= (fn: unknown) => fn;
  return ((w.__probeLongFrames as { start: number; duration: number; scripts: { sourceURL: string; sourceFunctionName: string; duration: number }[] }[] | undefined) ?? [])
    // Match the script's FILE name: a worktree or cache path can itself
    // contain "hydrology" (perf-p2-hydrology), which matched every dependency.
    .filter((f) => f.scripts.some((x) => /hydrology/i.test(`${x.sourceURL.split("/").pop() ?? ""} ${x.sourceFunctionName}`)))
    .map((f) => ({ atMs: Math.round(f.start), duration: Math.round(f.duration), scripts: f.scripts }));
});
report.stateLast = await evaluate(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  w.__name ??= (fn: unknown) => fn;
  return ((w.__probeState as unknown[] | undefined) ?? []).at(-1) ?? null;
});
await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
await setThrottle(1).catch(() => undefined);
report.consoleErrors = consoleErrors.slice(0, 30);
writeFileSync(`${outDir}/${label}.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(`wrote ${outDir}/${label}.json`);

function summaryOf(w: WindowStats) {
  const worst = w.longFrames[0] as {
    duration: number; scripts: { sourceFunctionName: string; sourceURL: string; duration: number }[];
  } | undefined;
  return {
    fpsMedian: w.fpsMedian, p95: w.intervalMs.p95, max: w.intervalMs.max,
    over250: w.over250, simToWall: w.worker.simToWallRatio, longTasks: w.longTasks.count,
    worstFrame: worst
      ? `${Math.round(worst.duration)} ms: ${worst.scripts.map((x) => `${x.sourceFunctionName || "?"}@${x.sourceURL.split("/").pop()} ${x.duration}`).join(", ")}`
      : null,
  };
}

/**
 * Key -> first frame that SHOWS the input.
 *
 * Detection reads the control-surface digest only. The first cut also read
 * the aircraft's attitude, which drifts every frame in flight, so every trial
 * "responded" 0-17 ms after the key, before the key handler had even run and
 * 20-80 ms before the physics moved the surface (baseline 2026-09-29). Two
 * guards now: a per-trial noise floor from the 400 ms before the key, and
 * causality: a render change earlier than the physics snapshot's change is
 * rejected, not counted. The raw logs are kept so this can be redone offline.
 */
async function latencyAnalysis() {
  const raw = await evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    w.__name ??= (fn: unknown) => fn;
    return {
      keys: (w.__probeKeys as { code: string; down: boolean; t: number; handled: number }[]).slice(),
      scene: ((w.__probeSceneLog as [number, number, number][] | undefined) ?? []).slice(),
      snaps: (w.__probeWorkers as { log: { t: number; elevator: number; aileron: number }[] }).log
        .map((s) => ({ t: s.t, elevator: s.elevator, aileron: s.aileron })),
      frames: (w.__probeFrames as number[]).slice(),
    };
  });
  report.latencyRaw = raw;
  const EPS = 1e-5;
  const rows: {
    code: string; keyToHandlerMs: number; keyToSnapshotMs: number | null;
    keyToRenderMs: number | null; keyToDisplayMs: number | null; noise: number; causal: boolean;
  }[] = [];
  const downs = raw.keys.filter((k) => k.down && /Key[SWDA]/.test(k.code));
  for (const key of downs) {
    const pre = raw.scene.filter((f) => f[0] > key.t - 400 && f[0] <= key.t);
    let noise = 0;
    for (let i = 1; i < pre.length; i += 1) noise = Math.max(noise, Math.abs(pre[i]![1] - pre[i - 1]![1]));
    const threshold = Math.max(EPS, 3 * noise);
    const before = pre.at(-1);
    const moved = before
      ? raw.scene.find((f) => f[0] > key.t && f[0] < key.t + 1_200 && Math.abs(f[1] - before[1]) > threshold)
      : undefined;
    const field = /Key[SW]/.test(key.code) ? "elevator" : "aileron";
    const snapBefore = raw.snaps.filter((s) => s.t <= key.t).at(-1);
    const snapMoved = snapBefore
      ? raw.snaps.find((s) => s.t > key.t && Math.abs(s[field] - snapBefore[field]) > 1e-4)
      : undefined;
    const causal = moved !== undefined && snapMoved !== undefined && moved[0] >= snapMoved.t;
    // The frame rendered at `moved` reaches the screen at the next rAF boundary.
    const display = causal ? raw.frames.find((t) => t > moved![0]) : undefined;
    rows.push({
      code: key.code,
      keyToHandlerMs: round(key.handled - key.t),
      keyToSnapshotMs: snapMoved ? round(snapMoved.t - key.t) : null,
      keyToRenderMs: causal ? round(moved![0] - key.t) : null,
      keyToDisplayMs: display !== undefined ? round(display - key.t) : null,
      noise,
      causal,
    });
  }
  const shown = rows.map((r) => r.keyToDisplayMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const snapshots = rows.map((r) => r.keyToSnapshotMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  return {
    rows,
    summary: {
      trials: rows.length,
      causal: rows.filter((r) => r.causal).length,
      displayMedianMs: quantile(shown, 0.5),
      displayP90Ms: quantile(shown, 0.9),
      displayMaxMs: shown.at(-1) ?? null,
      snapshotMedianMs: quantile(snapshots, 0.5),
      snapshotMaxMs: snapshots.at(-1) ?? null,
    },
  };
}
