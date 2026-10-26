import { describe, expect, it, vi } from "vitest";
import {
  StepController,
  type BenchRendererPort,
  type StepInstruments,
  type StepPhase,
  type StepSetup,
} from "../src/bench/controller";
import { createHeapSampler, type CreationCounts, type FrameClock } from "../src/bench/instruments";
import { createBenchPath, createBenchVisualState, writeSettleState } from "../src/bench/path";
import { BENCH_SEED, benchProfile, benchTimings, expectedPathFingerprint } from "../src/bench/plan";
import { BenchRenderer, type BenchProbedRenderer } from "../src/bench/recorder";
import { timerReport } from "../src/bench/stats";
import type { BenchStepResult, BenchTimings } from "../src/bench/types";
import { INITIAL_VISUAL_STATE, type FlightVisualState, type RenderDiagnostics } from "../src/game/types";
import type { RendererBenchProbe } from "../src/render/FlightRenderer";
import {
  createGovernorState,
  governorConfigForProfile,
  workLeverSettingsFor,
} from "../src/render/webgpu/core/AdaptiveGovernor";
import { createWorld } from "../src/world";

/**
 * The step controller behind the renderer decorator, on a hand-driven clock:
 * every frame runs the controller's own rAF callback, then the decorator's
 * `render()`, as a browser frame does.
 */

const world = createWorld(BENCH_SEED);
const quick = benchTimings(true);
const quickPath = createBenchPath(world, quick);

/** A frame clock the test advances by hand. */
function fakeFrameClock() {
  let nextHandle = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const clock: FrameClock = {
    requestAnimationFrame: (callback) => {
      frames.set(nextHandle, callback);
      return nextHandle++;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  const frame = (timestamp: number) => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(timestamp);
  };
  return { clock, frame, pendingFrames: () => frames.size };
}

interface Streaming {
  /** Pending terrain pages at `elapsedMs` of the settle. */
  pendingPages(elapsedMs: number): number;
  visibleInstances(elapsedMs: number): number;
}

const RESTS_AFTER_3S: Streaming = {
  pendingPages: (elapsedMs) => (elapsedMs < 3_000 ? 4 : 0),
  visibleInstances: () => 10_000,
};

function diagnostics(pendingTerrainPages: number, visibleInstances: number): RenderDiagnostics {
  return {
    adapter: "Fake GPU",
    drawCalls: 900,
    triangles: 2_000_000,
    visibleInstances,
    residentTerrainPages: 120,
    pendingTerrainPages,
    pendingDetailWork: 0,
    estimatedGpuMemoryMiB: 700,
    inventoriedGpuMemoryMiB: 650,
    hitchCount: 0,
    p999FrameMs: 20,
    presentWaitP95Ms: null,
    topPassesByCpuMs: [],
    gpuPassMs: {},
  } as unknown as RenderDiagnostics;
}

interface HarnessOptions {
  readonly timings?: BenchTimings;
  readonly tierIndex?: number;
  readonly streaming?: Streaming;
  readonly capacity?: number;
  /** Milliseconds each `render()` takes on the fake clock. */
  readonly renderMs?: number;
  readonly renderThrew?: (error: unknown) => void;
  /** Runs inside each `render()`, as the renderer's own work does; `timestamp` is the frame's. */
  readonly duringRender?: (phase: StepPhase, timestamp: number) => void;
}

function harness(options: HarnessOptions = {}) {
  const timings = options.timings ?? quick;
  const path = timings === quick ? quickPath : createBenchPath(world, timings);
  const tierIndex = options.tierIndex ?? 1;
  const streaming = options.streaming ?? RESTS_AFTER_3S;
  const renderMs = options.renderMs ?? 4;
  const frames = fakeFrameClock();
  let nowMs = 0;
  let frameTimestamp = 0;
  let settleStartMs: number | null = null;
  const diagnosticsReads: { atMs: number; frame: number; phase: StepPhase }[] = [];
  let framesRendered = 0;

  const config = governorConfigForProfile(benchProfile(tierIndex));
  const probe: RendererBenchProbe = {
    frameIndex: 0,
    governorState: createGovernorState(config),
    governorSignals: { gpuP95Ms: null, cpuP95Ms: null, intervalP95Ms: null },
    governorConfig: config,
    workLevers: workLeverSettingsFor(0, 0),
    appliedRenderScale: 0.86,
    renderWidth: 1_101,
    renderHeight: 619,
    pinned: false,
    gpuFrameMs: null,
  };
  const drawn: FlightVisualState[] = [];
  const counts: CreationCounts = {
    renderPipelines: 0,
    renderPipelinesAsync: 0,
    computePipelines: 0,
    computePipelinesAsync: 0,
    shaderModules: 0,
    wgslChars: 0,
    total: 0,
  };
  const events: { t: number; kind: "render" }[] = [];
  const compile = () => {
    counts.renderPipelines += 1;
    counts.total += 1;
    events.push({ t: nowMs, kind: "render" });
  };

  const inner = {
    domElement: {} as HTMLCanvasElement,
    render: vi.fn((state: FlightVisualState) => {
      drawn.push({ ...state, position: { ...state.position } });
      framesRendered += 1;
      options.duringRender?.(controller.phase, frameTimestamp);
      nowMs += renderMs;
    }),
    readBenchProbe: (into: RendererBenchProbe) => {
      Object.assign(into, probe);
      into.frameIndex = framesRendered;
    },
    dispose: vi.fn(),
  } as unknown as BenchProbedRenderer;

  const port: BenchRendererPort = {
    getDiagnostics: () => {
      const elapsed = settleStartMs === null ? 0 : nowMs - settleStartMs;
      diagnosticsReads.push({ atMs: nowMs, frame: framesRendered, phase: controller.phase });
      return diagnostics(streaming.pendingPages(elapsed), streaming.visibleInstances(elapsed));
    },
    getCaptureRenderSize: () => ({ width: probe.renderWidth, height: probe.renderHeight }),
    getGpuTimingStatusForCapture: () => ({ enabled: false }),
    getDetailPresentationDiagnosticsForCapture: () => ({ cells: 3 }),
  };
  const heap = createHeapSampler({ read: () => 64 * 1_048_576 + nowMs });
  const instruments: StepInstruments = {
    creations: { counts, events, clearEvents: () => events.splice(0), uninstall: () => undefined },
    longTasks: null,
    longAnimationFrames: null,
    heap,
  };
  const setup: StepSetup = {
    tierIndex,
    mode: "shipped",
    timings,
    expectedFingerprint: expectedPathFingerprint(timings.quick),
    firstRendererInTab: true,
    refresh: { rafHz: 60, periodMs: 1_000 / 60, medianMs: 1_000 / 60, p10Ms: 16.5, p90Ms: 16.9, samples: 59, outliers: 0 },
    timer: timerReport(0.1),
    load: { navigationType: "navigate", httpCache: null },
    cssWidth: 1_280,
    cssHeight: 720,
    devicePixelRatio: 1,
    pinnedRenderScale: null,
    gpuTimingFailed: false,
    attachedAtMs: 1_500,
    pathPrecomputeMs: 3,
    startupStages: () => [{ label: "device", kind: "async", milliseconds: 40 }],
    environment: () => ({
      hiddenEvents: 0,
      focusLostMs: 0,
      resizes: 0,
      dprChanges: 0,
      wakeLock: "held",
      keysBlocked: 0,
      ignoredRendererCalls: 0,
      gameErrors: [],
      battery: null,
    }),
  };
  const phases: StepPhase[] = [];
  const finished: { outcome: "ok" | "early-stop"; result: BenchStepResult }[] = [];
  const controller = new StepController({
    path,
    setup,
    renderer: port,
    instruments,
    listener: {
      phase: (phase) => {
        phases.push(phase);
        if (phase === "settling") settleStartMs = nowMs;
      },
      finished: (finish) => finished.push(finish),
      ...(options.renderThrew ? { renderThrew: options.renderThrew } : {}),
    },
    now: () => nowMs,
    frameClock: frames.clock,
    ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
  });
  const bench = new BenchRenderer(inner, controller, () => nowMs);

  /** One browser frame at `timestamp`: rAF callbacks first, then the game loop's render. */
  const frame = (timestamp: number, ownLoopRuns = true) => {
    frameTimestamp = timestamp;
    nowMs = timestamp;
    if (ownLoopRuns) frames.frame(timestamp);
    nowMs = timestamp + 0.5;
    bench.render(INITIAL_VISUAL_STATE, 1 / 60);
  };
  /** Frames every `intervalMs` from `fromMs` until `until` says stop or `maxMs` passes. */
  const run = (fromMs: number, intervalMs: number, until: () => boolean, maxMs = 200_000): number => {
    let at = fromMs;
    while (!until() && at - fromMs < maxMs) {
      frame(at);
      at += intervalMs;
    }
    return at;
  };
  return {
    controller, bench, frames, probe, drawn, diagnosticsReads, phases, finished, path, timings, compile,
    frame, run,
    now: () => nowMs,
    settleStartMs: () => settleStartMs,
  };
}

describe("the step controller's settle", () => {
  it("holds the runway pose and rests after three calm checks a second and 120 frames apart", () => {
    const h = harness();
    // 240 Hz: 120 frames is half a second, so the one-second spacing binds.
    h.run(1_000, 1_000 / 240, () => h.controller.phase !== "settling" && h.controller.phase !== "waiting");
    const settle = h.diagnosticsReads.filter((read) => read.phase === "settling");
    // Checks from settleMinS on, at least a second and 120 frames apart.
    expect(settle[0]!.atMs - h.settleStartMs()!).toBeGreaterThanOrEqual(quick.settleMinS * 1_000);
    for (let index = 1; index < settle.length; index += 1) {
      expect(settle[index]!.atMs - settle[index - 1]!.atMs).toBeGreaterThanOrEqual(quick.settleCheckS * 1_000 - 5);
      expect(settle[index]!.frame - settle[index - 1]!.frame).toBeGreaterThanOrEqual(quick.settleCheckFrames);
    }
    // Pending pages at 2 s; calm at 3, 4 and 5 s.
    expect(settle).toHaveLength(4);
    expect(h.phases).toEqual(["settling", "flying"]);
    const expectedPose = writeSettleState(h.path, createBenchVisualState());
    for (const state of h.drawn) expect(state.position).toEqual(expectedPose.position);
  });

  it("spaces checks 120 frames apart when frames come slower than 120 a second (S7)", () => {
    const standard = benchTimings(false);
    const h = harness({ timings: standard });
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    const settle = h.diagnosticsReads.filter((read) => read.phase === "settling");
    // 60 Hz: checks two seconds apart, at 4, 6, 8 and 10 s; the fourth is the third calm one.
    expect(settle).toHaveLength(4);
    for (let index = 1; index < settle.length; index += 1) {
      expect(settle[index]!.frame - settle[index - 1]!.frame).toBe(standard.settleCheckFrames);
      expect(settle[index]!.atMs - settle[index - 1]!.atMs).toBeCloseTo(2_000, 6);
    }
  });

  it("ends at the cap when streaming never rests, which is not a failure", () => {
    const h = harness({ streaming: { pendingPages: () => 2, visibleInstances: () => 10_000 } });
    h.run(1_000, 1_000 / 240, () => h.controller.phase === "flying");
    h.run(h.now() + 1, 1_000 / 240, () => h.finished.length > 0);
    const result = h.finished[0]!.result;
    expect(result.settle.reachedRest).toBe(false);
    expect(result.settle.ms).toBeGreaterThanOrEqual(quick.settleCapS * 1_000);
    expect(result.settle.ms).toBeLessThan(quick.settleCapS * 1_000 + 10);
    expect(result.settle.pendingTerrainPages).toBe(2);
    expect(h.finished[0]!.outcome).toBe("ok");
  });
});

describe("the step controller's flight", () => {
  it("flies the route from the frame after the settle and finishes once, at the flight's end", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    const settleDrawn = h.drawn.length;
    const flightStart = h.now();
    h.run(flightStart + 10, 1_000 / 60, () => h.finished.length > 0);
    expect(h.phases).toEqual(["settling", "flying", "done"]);
    expect(h.finished).toHaveLength(1);

    // The flight moves down the runway and climbs; the settle pose does not.
    const flown = h.drawn.slice(settleDrawn);
    const first = flown[0]!;
    const last = flown[flown.length - 1]!;
    expect(Math.hypot(last.position.x - first.position.x, last.position.z - first.position.z))
      .toBeGreaterThan(1_000);
    expect(last.position.y).toBeGreaterThan(first.position.y + 100);

    // No diagnostics walk inside the flight: one when the settle ended, one to collect.
    expect(h.diagnosticsReads.filter((read) => read.phase === "flying")).toHaveLength(0);
    expect(h.diagnosticsReads.filter((read) => read.phase === "done")).toHaveLength(1);

    const { outcome, result } = h.finished[0]!;
    expect(outcome).toBe("ok");
    expect(result.flight.seconds).toBeGreaterThanOrEqual(quick.flightS);
    expect(result.flight.seconds).toBeLessThan(quick.flightS + 0.05);
    expect(result.flight.earlyStopFps).toBeNull();
    // A flight that flew on still has the early check's fps, to set against one that stopped.
    expect(result.flight.earlyCheckFps).toBeCloseTo(60, 0);
    // 60 Hz: four seconds of ground, ten of air.
    expect(result.windows.ground!.frames).toBeGreaterThanOrEqual(239);
    expect(result.windows.ground!.frames).toBeLessThanOrEqual(241);
    expect(result.windows.air!.frames).toBeGreaterThanOrEqual(599);
    expect(result.windows.air!.frames).toBeLessThanOrEqual(601);
    expect(result.histogram).not.toBeNull();
    expect(result.worst.length).toBeGreaterThan(0);
    expect(result.segments.map((segment) => [segment.startS, segment.endS])).toEqual([[0, 10], [10, 20]]);
    expect(result.perSecond.rows).toHaveLength(quick.flightS);
    // At 60 Hz, quick mode's checks are two seconds apart and the cap comes first.
    expect(result.settle.checks).toBe(3);
    expect(result.startup.navToAttachMs).toBe(1_500);
    // The first render began half a millisecond into the first frame.
    expect(result.startup.navToFirstFrameMs).toBe(1_000.5);
    expect(result.startup.rendererStages).toEqual([{ label: "device", kind: "async", ms: 40 }]);
    expect(result.canvas.renderPixels).toBe(1_101 * 619);
    expect(result.canvas.gpuTiming).toBe("off");
    expect(result.detailWorker.presentationAtSettleEnd).toEqual({ cells: 3 });
    expect(result.end?.adapterLabel).toBe("Fake GPU");
    expect(result.path.matchesExpected).toBe(true);
    expect(result.environment.overflowed).toBe(false);
    expect(result.benchOverheadMs).not.toBeNull();
    // The heap is read once a second of flight.
    const heapColumn = result.perSecond.columns.indexOf("heapMiB");
    expect(result.perSecond.rows.every((row) => typeof row[heapColumn] === "number")).toBe(true);

    // After the end nothing is drawn or recorded: the page is about to leave.
    const length = h.controller.log.length;
    const drawn = h.drawn.length;
    h.frame(h.now() + 16);
    expect(h.controller.log.length).toBe(length);
    expect(h.drawn.length).toBe(drawn);
    expect(h.finished).toHaveLength(1);
    expect(h.frames.pendingFrames()).toBe(0);
  });

  it("times frames by the rAF timestamp, and by the render's start when its own loop missed the frame", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    const at = h.now() + 20;
    h.frame(at);
    h.frame(at + 16, false);
    expect(h.controller.log.frameTimeMs[0]).toBe(at);
    expect(h.controller.log.frameTimeMs[1]).toBe(at + 16.5);
  });

  it("splits compiles into the warm-up and the air window", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    const flightStart = h.now() + 10;
    let compiledAtTwo = false;
    let compiledAtTwelve = false;
    h.run(flightStart, 1_000 / 60, () => {
      const t = h.controller.flightElapsedS;
      if (!compiledAtTwo && t >= 2) {
        h.compile();
        compiledAtTwo = true;
      }
      if (!compiledAtTwelve && t >= 12) {
        h.compile();
        h.compile();
        compiledAtTwelve = true;
      }
      return h.finished.length > 0;
    });
    const result = h.finished[0]!.result;
    expect(result.compiles.warmup.render).toBe(1);
    expect(result.compiles.window.render).toBe(2);
    expect(result.compiles.window.framesWithCompiles).toBe(1);
    expect(result.compiles.firstEvents).toHaveLength(3);
    expect(result.compiles.firstEvents[0]!.t).toBeGreaterThan(1.9);
  });

  it("counts a frame's compiles where the frame log counts the frame", () => {
    /** One compile in the first frame `pick` chooses: its phase and its flight time (null before the flight). */
    const oneCompile = (pick: (phase: StepPhase, t: number | null) => boolean) => {
      let flightStart: number | null = null;
      let done = false;
      const h = harness({
        duringRender: (phase, timestamp) => {
          if (phase === "flying" && flightStart === null) flightStart = timestamp;
          const t = flightStart === null ? null : (timestamp - flightStart) / 1_000;
          if (!done && pick(phase, t)) {
            done = true;
            h.compile();
          }
        },
      });
      h.run(1_000, 1_000 / 60, () => h.finished.length > 0);
      const { startup, settle, compiles, segments } = h.finished[0]!.result;
      return {
        startup: startup.compiles.render,
        settle: settle.compiles.render,
        warmup: compiles.warmup.render,
        window: compiles.window.render,
        framesWithCompiles: compiles.window.framesWithCompiles,
        events: compiles.firstEvents.length,
        firstSegment: segments[0]!.compiles,
      };
    };

    // The first frame (drawn while the controller still waits for it) is the settle's first.
    expect(oneCompile((phase) => phase === "waiting")).toMatchObject({ startup: 0, settle: 1, warmup: 0, events: 0 });
    // The first flight frame is the warm-up's, events and all.
    expect(oneCompile((_, t) => t === 0)).toEqual({
      startup: 0, settle: 0, warmup: 1, window: 0, framesWithCompiles: 0, events: 1, firstSegment: 1,
    });
    // The first air frame is the window's.
    expect(oneCompile((_, t) => t !== null && t >= quick.air.startS)).toMatchObject({
      warmup: 0, window: 1, framesWithCompiles: 1,
    });
    // The frame that closes the flight is in no window.
    expect(oneCompile((_, t) => t !== null && t >= quick.flightS)).toMatchObject({
      settle: 0, warmup: 0, window: 0, framesWithCompiles: 0,
    });
  });

  it("times the settle's governor decisions back from the flight's first frame", () => {
    let flightStart: number | null = null;
    let settleFrames = 0;
    const decidedAt: number[] = [];
    // The standard settle rests at about 10 s, well short of its 20 s cap.
    const standard = benchTimings(false);
    const h = harness({
      timings: standard,
      duringRender: (phase, timestamp) => {
        if (phase === "flying" && flightStart === null) flightStart = timestamp;
        if (phase !== "settling" || ++settleFrames % 10 !== 0) return;
        // A new signals object is a new decision, made in this frame.
        h.probe.governorSignals = { ...h.probe.governorSignals };
        decidedAt.push(timestamp);
      },
    });
    h.run(1_000, 1_000 / 60, () => h.finished.length > 0);
    const { governor, settle } = h.finished[0]!.result;
    // The old clock counted back from the cap, which the settle never reached.
    expect(settle.reachedRest).toBe(true);
    expect(settle.ms).toBeLessThan(standard.settleCapS * 1_000 - 5_000);
    expect(governor.decisionsDuringSettle).toBe(decidedAt.length);
    expect(decidedAt.length).toBeGreaterThan(10);
    const settleDecisions = governor.decisions.filter((decision) => decision[0] < 0);
    expect(settleDecisions.map((decision) => decision[0]))
      .toEqual(decidedAt.map((timestamp) => expect.closeTo((timestamp - flightStart!) / 1_000, 6)));
  });

  it("stops early when the flight runs under five frames a second", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    h.run(h.now() + 10, 250, () => h.finished.length > 0);
    const { outcome, result } = h.finished[0]!;
    expect(outcome).toBe("early-stop");
    expect(result.flight.seconds).toBeGreaterThanOrEqual(quick.earlyStopAtS);
    expect(result.flight.seconds).toBeLessThan(quick.earlyStopAtS + 0.3);
    expect(result.flight.earlyStopFps).toBeCloseTo(4, 6);
    expect(result.flight.earlyCheckFps).toBe(result.flight.earlyStopFps);
    // The air window never began.
    expect(result.windows.air).toBeNull();
    expect(result.histogram).toBeNull();
    expect(result.worst).toEqual([]);
    expect(result.windows.ground).not.toBeNull();
    // Nor did anything measured over it: no zeros and no "stale" heap for a window not flown.
    expect(result.longTasks).toBeNull();
    expect(result.longAnimationFrames).toBeNull();
    expect(result.heap).toBeNull();
    expect(result.governor.windows.air.frames).toBe(0);
    expect(result.governor.windows.air.share.atScaleFloor).toBeNull();
    expect(result.governor.windows.air.share.cpuShed).toBeNull();
    // The heap was read through the flight all the same.
    const heapColumn = result.perSecond.columns.indexOf("heapMiB");
    expect(result.perSecond.rows.every((row) => typeof row[heapColumn] === "number")).toBe(true);
  });

  it("counts the frame that ends an early stop in no governor window, as the frame log does", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    const flightStart = h.now() + 10;
    h.run(flightStart, 250, () => h.controller.flightElapsedS >= 7.5);
    // One frame spans the early check (8 s) and the air window's start (10 s).
    h.frame(flightStart + 10_500);
    const { outcome, result } = h.finished[0]!;
    expect(outcome).toBe("early-stop");
    expect(result.flight.seconds).toBeCloseTo(10.5, 6);
    expect(result.windows.air).toBeNull();
    expect(result.governor.windows.air.frames).toBe(0);
    expect(result.governor.windows.air.modeShare).toEqual({});
    expect(result.governor.windows.air.classShare).toEqual({});
    // The log's last frame closes the last interval and opens none.
    expect(result.governor.flight.frames).toBe(h.controller.log.length - 1);
    expect(result.governor.atEnd).not.toBeNull();
  });

  it("flags a frame log that filled up, and keeps flying", () => {
    const h = harness({ capacity: 100 });
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    h.run(h.now() + 10, 1_000 / 60, () => h.finished.length > 0);
    const result = h.finished[0]!.result;
    expect(h.controller.log.length).toBe(100);
    expect(result.environment.overflowed).toBe(true);
    expect(result.flight.seconds).toBeGreaterThanOrEqual(quick.flightS);
  });
});

describe("the step controller's controls", () => {
  it("stop ends the measuring and the drawing", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    h.run(h.now() + 10, 1_000 / 60, () => h.controller.flightElapsedS >= 3);
    h.controller.stop();
    const length = h.controller.log.length;
    const drawn = h.drawn.length;
    h.frame(h.now() + 16);
    expect(h.controller.phase).toBe("stopped");
    expect(h.controller.log.length).toBe(length);
    expect(h.drawn.length).toBe(drawn);
    expect(h.finished).toHaveLength(0);
    expect(h.frames.pendingFrames()).toBe(0);
  });

  it("lets the game's own state through once the decorator lets go", () => {
    const h = harness();
    h.run(1_000, 1_000 / 60, () => h.controller.phase === "flying");
    h.bench.detach();
    expect(h.controller.phase).toBe("detached");
    expect(h.controller.stateFor(0)).toBeNull();
    h.frame(h.now() + 16);
    expect(h.drawn[h.drawn.length - 1]!.position).toEqual(INITIAL_VISUAL_STATE.position);
    expect(h.frames.pendingFrames()).toBe(0);
  });

  it("passes a render error on to the page until it is disposed", () => {
    const renderThrew = vi.fn();
    const h = harness({ renderThrew });
    h.controller.renderThrew(new Error("device lost"));
    expect(renderThrew).toHaveBeenCalledWith(new Error("device lost"));
    h.controller.dispose();
    h.controller.renderThrew(new Error("again"));
    expect(renderThrew).toHaveBeenCalledTimes(1);
  });
});
