import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES,
  WorldDetailRuntime,
  type DetailPresentationRebuildDiagnostics,
} from "../src/render/webgpu/detail/WorldDetailRuntime";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { DetailWorkerCommand, DetailWorkerEvent } from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import { createWorld, sampleTerrain, type WorldDefinition } from "../src/world";

/**
 * The detail worker's watchdog must time SILENCE, not slowness: a worker that
 * is still packing the build it was given, at any frame rate, keeps its
 * authority; one that stops answering still loses it.
 *
 * Until 2026-10-25 the presentation deadline was 240 updates from the first
 * update with any worker demand (two seconds at 120 Hz), and expiry handed
 * vegetation to the main thread for the rest of the session. The scenario
 * below models one worker thread in virtual time so the bug is reproducible
 * in Node, where every real worker task runs synchronously inside the
 * bridge.
 */

type Listener = EventListenerOrEventListenerObject;

function invokeListener(listener: Listener, event: Event): void {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

// ---------------------------------------------------------------------------
// Virtual time: one main thread at 120 Hz and one worker thread.
// ---------------------------------------------------------------------------

/**
 * The worker's costs, measured on the cloud host (Node 22, 2026-10-25) and
 * divided by one factor for a Mac. `generateDetailCell` at the medium
 * profile's density took 110-320 ms per 512 m cell round the home field and
 * 125-220 ms for populated cells 20 km east (165 ms is typical); presentation
 * packing ran 924 work units per 4 ms slice, 4.33 us a unit. The perf
 * investigators measured Node at about 2.8x slower than the Chrome bundle,
 * and an Apple P-core is faster again than this host: dividing by 5.5 puts a
 * cell at 30 ms, the low end of the 25-45 ms that implies. It is not tuned to
 * make the old watchdog trip. `DETAIL_LIVENESS_HOST_SCALE` overrides the
 * factor for the recorded runs (it is 5.5 for the assertions).
 */
const HOST_SCALE = Number(process.env.DETAIL_LIVENESS_HOST_SCALE ?? 5.5);
const GENERATE_MILLISECONDS = 165 / HOST_SCALE;
const WORK_UNIT_MILLISECONDS = 0.004_33 / HOST_SCALE;
/** The worker reads its slice clock once per 64 work units. */
const SLICE_CLOCK_READ_MILLISECONDS = 64 * WORK_UNIT_MILLISECONDS;
/**
 * A nested `setTimeout(0)` is clamped to 4 ms. `DETAIL_LIVENESS_TIMER_CLAMP`
 * overrides it for the recorded runs (0 models the browser entry's
 * MessageChannel yield).
 */
const TIMER_CLAMP_MILLISECONDS = Number(process.env.DETAIL_LIVENESS_TIMER_CLAMP ?? 4);
const UPDATE_MILLISECONDS = 1_000 / 120;

interface WorkerTask {
  readonly ready: number;
  readonly sequence: number;
  readonly run: () => void;
}

interface Delivery {
  readonly at: number;
  readonly sequence: number;
  readonly thread: VirtualWorkerThread;
  readonly event: DetailWorkerEvent;
}

/**
 * A discrete-event model of the main thread and the worker threads it
 * spawns. A worker runs its FIFO of tasks (messages and timers, in the order
 * they became ready) one at a time; its clock advances only by the modelled
 * costs. The main thread updates every 1/120 s and handles each worker event
 * the instant it is posted, as an idle main thread does. `performance.now` is
 * stubbed to `readClock`, so the worker's own slice clock is virtual too —
 * whatever version of the worker is under test.
 */
class VirtualSimulation {
  now = 0;
  readonly threads: VirtualWorkerThread[] = [];
  private sequence = 0;
  private running: VirtualWorkerThread | null = null;
  private workerClock = 0;
  private readonly deliveries: Delivery[] = [];
  private nextUpdateAt = 0;

  constructor(
    private readonly generateMilliseconds: number,
    private readonly timerClampMilliseconds: number,
  ) {}

  readonly readClock = (): number => {
    if (!this.running) return this.now;
    this.workerClock += SLICE_CLOCK_READ_MILLISECONDS;
    return this.workerClock;
  };

  spawnThread(): VirtualWorkerThread {
    const thread = new VirtualWorkerThread(this);
    this.threads.push(thread);
    return thread;
  }

  enqueueMessage(thread: VirtualWorkerThread, run: () => void): void {
    thread.tasks.push({
      ready: this.running ? this.workerClock : this.now,
      sequence: (this.sequence += 1),
      run,
    });
  }

  enqueueTimer(thread: VirtualWorkerThread, run: () => void): void {
    thread.tasks.push({
      ready: this.workerClock + this.timerClampMilliseconds,
      sequence: (this.sequence += 1),
      run,
    });
  }

  post(thread: VirtualWorkerThread, event: DetailWorkerEvent): void {
    if (event.type === "retainedCell" || event.type === "cell" || event.type === "error") {
      this.workerClock += this.generateMilliseconds;
    }
    this.deliveries.push({
      at: this.workerClock,
      sequence: (this.sequence += 1),
      thread,
      event,
    });
  }

  /** Runs updates every 1/120 s until `stop` says so or `endAt` passes. */
  run(endAt: number, update: () => void, stop: () => boolean = () => false): void {
    while (true) {
      let delivery: Delivery | null = null;
      for (const candidate of this.deliveries) {
        if (
          !delivery
          || candidate.at < delivery.at
          || (candidate.at === delivery.at && candidate.sequence < delivery.sequence)
        ) delivery = candidate;
      }
      let workerThread: VirtualWorkerThread | null = null;
      let workerTask: WorkerTask | null = null;
      let workerStart = Number.POSITIVE_INFINITY;
      for (const thread of this.threads) {
        if (thread.terminated) continue;
        for (const task of thread.tasks) {
          const start = Math.max(thread.freeAt, task.ready);
          if (
            start < workerStart
            || (start === workerStart && workerTask !== null && task.sequence < workerTask.sequence)
          ) {
            workerStart = start;
            workerTask = task;
            workerThread = thread;
          }
        }
      }
      const deliveryAt = delivery?.at ?? Number.POSITIVE_INFINITY;
      const next = Math.min(deliveryAt, workerStart, this.nextUpdateAt);
      if (next > endAt) return;
      if (delivery && deliveryAt === next) {
        this.deliveries.splice(this.deliveries.indexOf(delivery), 1);
        this.now = delivery.at;
        if (!delivery.thread.terminated) delivery.thread.emit(delivery.event);
      } else if (workerTask && workerThread && workerStart === next) {
        workerThread.tasks.splice(workerThread.tasks.indexOf(workerTask), 1);
        this.now = workerStart;
        this.running = workerThread;
        this.workerClock = workerStart;
        try {
          workerTask.run();
        } finally {
          this.running = null;
        }
        workerThread.freeAt = this.workerClock;
      } else {
        this.now = this.nextUpdateAt;
        this.nextUpdateAt += UPDATE_MILLISECONDS;
        update();
        if (stop()) return;
      }
    }
  }
}

/** The `Worker` surface `DetailGenerationClient` uses, on a virtual thread. */
class VirtualWorkerThread {
  readonly tasks: WorkerTask[] = [];
  freeAt = 0;
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly runtime: DetailWorkerRuntime;

  constructor(private readonly simulation: VirtualSimulation) {
    this.runtime = new DetailWorkerRuntime(
      (event) => simulation.post(this, event),
      (callback) => simulation.enqueueTimer(this, callback),
    );
  }

  postMessage(command: DetailWorkerCommand): void {
    if (this.terminated) throw new Error("Virtual worker is terminated");
    this.simulation.enqueueMessage(this, () => this.runtime.handleCommand(command));
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.tasks.length = 0;
  }

  emit(data: unknown): void {
    const event = { data } as unknown as Event;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      invokeListener(listener, event);
    }
  }
}

interface ScenarioResult {
  readonly homeFillMilliseconds: number | null;
  readonly freshFillMilliseconds: number | null;
  readonly endedEarlyByFallback: boolean;
  readonly diagnostics: DetailPresentationRebuildDiagnostics;
  readonly workerThreads: number;
  /**
   * The longest the presentation watchdog's clock ran while a worker build
   * was in flight, read after every update from its two epochs (fields
   * 19543c0 already had): updates, and milliseconds net of gaps. 240
   * updates is an expiry at any update rate on 19543c0. Outside a build in
   * flight 19543c0 can leave a stale epoch it never checks, so those
   * updates are not sampled.
   */
  readonly maximumClockUpdates: number;
  readonly maximumClockMilliseconds: number;
  /**
   * The longest a worker build stayed in flight, posted to answered, to the
   * update: the same measure on 19543c0 and after it.
   */
  readonly maximumWorkerBuildMilliseconds: number;
}

/** Private state 19543c0 already had, read by name. */
interface WatchdogEpochs {
  readonly updateSequence: number;
  readonly workerPresentationProgressUpdate: number | null;
  readonly workerPresentationProgressMilliseconds: number | null;
  readonly pendingPresentationBuild: {
    readonly source: string;
    readonly queuedResult: unknown;
    readonly queuedError: unknown;
  } | null;
}

/**
 * The game's world at medium/balanced: settle at the home field, then jump
 * 20 km east into a region no cell has been generated for, and fly nothing
 * for 30 s while it fills. East is the densest of the eight compass points
 * 20 km out (4,122 trees in nine sampled cells; four of the others are sea).
 */
function runFreshRegionScenario(
  generateMilliseconds: number,
  timerClampMilliseconds: number,
): ScenarioResult {
  const world: WorldDefinition = createWorld(0x51a7e);
  const quality = resolveWebGpuQualityProfile("medium", "balanced");
  const simulation = new VirtualSimulation(generateMilliseconds, timerClampMilliseconds);
  const clock = vi.spyOn(performance, "now").mockImplementation(simulation.readClock);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new WorldDetailRuntime(scene, {
    worldSeed: world.seed,
    terrainSample: (x, z) => sampleTerrain(world, x, z),
    seaLevelMeters: world.seaLevel,
    latitudeDegrees: world.latitudeDegrees,
    workerWorldSeed: world.seed,
    workerWorld: world,
    detailWorkerFactory: () => simulation.spawnThread() as unknown as Worker,
    presentationNowMilliseconds: () => simulation.now,
  });
  try {
    const home = world.airport!;
    let observer = { x: home.centerX, y: 150, z: home.centerZ };
    let origin = { x: 0, y: 0, z: 0 };
    let maximumClockUpdates = 0;
    let maximumClockMilliseconds = 0;
    let maximumWorkerBuildMilliseconds = 0;
    let buildInFlight: WatchdogEpochs["pendingPresentationBuild"] = null;
    let buildPostedAt = 0;
    const update = () => {
      runtime.update(observer, origin, quality, simulation.now / 1_000);
      const epochs = runtime as unknown as WatchdogEpochs;
      const build = epochs.pendingPresentationBuild;
      if (
        build === null
        || build.source !== "worker"
        || build.queuedResult !== null
        || build.queuedError !== null
      ) return;
      if (build !== buildInFlight) {
        buildInFlight = build;
        buildPostedAt = simulation.now;
      }
      maximumWorkerBuildMilliseconds = Math.max(
        maximumWorkerBuildMilliseconds,
        simulation.now - buildPostedAt,
      );
      if (epochs.workerPresentationProgressUpdate !== null) {
        maximumClockUpdates = Math.max(
          maximumClockUpdates,
          epochs.updateSequence - epochs.workerPresentationProgressUpdate,
        );
      }
      if (epochs.workerPresentationProgressMilliseconds !== null) {
        maximumClockMilliseconds = Math.max(
          maximumClockMilliseconds,
          simulation.now - epochs.workerPresentationProgressMilliseconds,
        );
      }
    };
    const fellBack = () => runtime.presentationRebuildDiagnostics.workerFallbacks > 0;

    let homeFillMilliseconds: number | null = null;
    simulation.run(60_000, update, () => {
      if (fellBack()) return true;
      if (runtime.pendingWorkItems > 0) return false;
      homeFillMilliseconds = simulation.now;
      return true;
    });

    let freshFillMilliseconds: number | null = null;
    if (!fellBack()) {
      const jumpedAt = simulation.now;
      observer = { x: home.centerX + 20_000, y: 150, z: home.centerZ };
      origin = {
        x: Math.round(observer.x / 2_048) * 2_048,
        y: 0,
        z: Math.round(observer.z / 2_048) * 2_048,
      };
      simulation.run(jumpedAt + 30_000, update, () => {
        if (fellBack()) return true;
        if (freshFillMilliseconds === null && runtime.pendingWorkItems === 0) {
          freshFillMilliseconds = simulation.now - jumpedAt;
        }
        return false;
      });
    }
    return {
      homeFillMilliseconds,
      freshFillMilliseconds,
      endedEarlyByFallback: fellBack(),
      diagnostics: runtime.presentationRebuildDiagnostics,
      workerThreads: simulation.threads.length,
      maximumClockUpdates,
      maximumClockMilliseconds,
      maximumWorkerBuildMilliseconds,
    };
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    clock.mockRestore();
  }
}

function reportScenario(label: string, result: ScenarioResult): void {
  // Opt-in, so the suite stays quiet: the PR records these numbers.
  if (!process.env.DETAIL_LIVENESS_REPORT) return;
  const diagnostics = result.diagnostics;
  console.log(`${label} ${JSON.stringify({
    hostScale: HOST_SCALE,
    generateMilliseconds: GENERATE_MILLISECONDS,
    timerClampMilliseconds: TIMER_CLAMP_MILLISECONDS,
    maximumClockUpdates: result.maximumClockUpdates,
    maximumClockMilliseconds: result.maximumClockMilliseconds,
    maximumWorkerBuildMilliseconds: result.maximumWorkerBuildMilliseconds,
    homeFillMilliseconds: result.homeFillMilliseconds,
    freshFillMilliseconds: result.freshFillMilliseconds,
    endedEarlyByFallback: result.endedEarlyByFallback,
    workerThreads: result.workerThreads,
    workerBuildStarts: diagnostics.workerBuildStarts,
    workerBuildPublications: diagnostics.workerBuildPublications,
    workerBuildTimeouts: diagnostics.workerBuildTimeouts,
    workerGenerationTimeouts: diagnostics.workerGenerationTimeouts,
    workerFallbacks: diagnostics.workerFallbacks,
    cancellations: diagnostics.cancellations,
    workerActive: diagnostics.workerActive,
    workerRespawns: diagnostics.workerRespawns,
    workerPresentationHeartbeats: diagnostics.workerPresentationHeartbeats,
    workerMaxSilenceMilliseconds: diagnostics.workerMaxSilenceMilliseconds,
    workerMaxSilenceUpdates: diagnostics.workerMaxSilenceUpdates,
    workerBuildMaxLatencyMilliseconds: diagnostics.workerBuildMaxLatencyMilliseconds,
    workerConvergenceStalls: diagnostics.workerConvergenceStalls,
  })}`);
}

describe("detail worker liveness in virtual time", () => {
  it("keeps the worker through a home settle and a fresh-region fill at 120 Hz", () => {
    const result = runFreshRegionScenario(GENERATE_MILLISECONDS, TIMER_CLAMP_MILLISECONDS);
    reportScenario("liveness", result);
    // The fields 19543c0 already had first, so a run against it fails on
    // the trip itself rather than on a field it never reported.
    expect(result.diagnostics.workerBuildTimeouts).toBe(0);
    expect(result.diagnostics.workerGenerationTimeouts).toBe(0);
    expect(result.diagnostics.workerFallbacks).toBe(0);
    expect(result.maximumClockUpdates).toBeLessThan(DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES);
    expect(result.homeFillMilliseconds).not.toBeNull();
    expect(result.freshFillMilliseconds).not.toBeNull();
    expect(result.diagnostics.workerActive).toBe(true);
    expect(result.workerThreads).toBe(1);
    expect(result.diagnostics.workerPresentationHeartbeats).toBeGreaterThan(0);
    expect(result.diagnostics.workerMaxSilenceMilliseconds).toBeLessThanOrEqual(200);
    expect(result.diagnostics.workerConvergenceStalls).toBe(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Unit cases on a synchronous bridge and a hand-driven clock.
// ---------------------------------------------------------------------------

/** Runs the real worker inside `postMessage`; slices and deliveries on `flush`. */
class SynchronousWorkerBridge {
  readonly commands: DetailWorkerCommand[] = [];
  holdPresentations = false;
  readonly held: DetailWorkerEvent[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks: Array<() => void> = [];
  private readonly outbound: DetailWorkerEvent[] = [];
  private readonly workerRuntime = new DetailWorkerRuntime(
    (event) => this.outbound.push(event),
    (callback) => this.tasks.push(callback),
  );

  postMessage(command: DetailWorkerCommand): void {
    this.commands.push(command);
    this.workerRuntime.handleCommand(command);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  flush(): void {
    while (this.tasks.length > 0 || this.outbound.length > 0) {
      while (this.tasks.length > 0) this.tasks.shift()!();
      for (const event of this.outbound.splice(0)) {
        if (
          this.holdPresentations
          && (event.type === "presentation" || event.type === "presentationProgress")
        ) {
          this.held.push(event);
        } else {
          this.emit(event);
        }
      }
    }
  }

  emit(data: unknown): void {
    const event = { data } as unknown as Event;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      invokeListener(listener, event);
    }
  }

  buildIds(): number[] {
    return this.commands.flatMap((command) => (
      command.type === "buildPresentation" ? [command.buildId] : []
    ));
  }

  cancels(): number {
    return this.commands.filter((command) => command.type === "cancelPresentation").length;
  }
}

interface ClockInternals {
  readonly workerPresentationProgressUpdate: number | null;
  readonly workerPresentationProgressMilliseconds: number | null;
  readonly updateSequence: number;
  readonly client: unknown;
  readonly pendingPresentationBuild: { readonly source: string } | null;
  readonly pendingPublication: unknown;
}

function clockOf(runtime: WorldDetailRuntime): ClockInternals {
  return runtime as unknown as ClockInternals;
}

const CELL_METERS = 128;

function smallProfile() {
  return {
    ...resolveWebGpuQualityProfile("medium", "balanced"),
    vegetationDistance: 170,
    vegetationDensity: 0.55,
    grassRadiusMeters: 36,
  };
}

function richCell(world: WorldDefinition, densityMultiplier: number) {
  let best = { cellX: 2, cellZ: 2, count: -1 };
  for (let cellZ = -8; cellZ <= 8; cellZ += 1) {
    for (let cellX = -8; cellX <= 8; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: world.seed,
        cellX,
        cellZ,
        cellSizeMeters: CELL_METERS,
        densityMultiplier,
        terrainSample: (x, z) => sampleTerrain(world, x, z),
        seaLevelMeters: world.seaLevel,
        dayOfYear: 0,
        latitudeDegrees: world.latitudeDegrees,
      });
      const count = cell.trees.length + cell.shrubs.length + cell.rocks.length
        + cell.clutter.length + cell.groundCover.length;
      if (count > best.count) best = { cellX, cellZ, count };
      if (cell.trees.length >= 8 && count >= 24) return { cellX, cellZ };
    }
  }
  if (best.count <= 0) throw new Error("Unable to select a populated detail cell");
  return best;
}

interface Fixture {
  readonly runtime: WorldDetailRuntime;
  readonly bridge: SynchronousWorkerBridge;
  readonly observer: { readonly x: number; readonly y: number; readonly z: number };
  readonly quality: ReturnType<typeof smallProfile>;
  readonly clock: { now: number };
  readonly dispose: () => void;
}

/** A worker runtime settled round one populated cell, on a hand-driven clock. */
function settledFixture(seed: string): Fixture {
  const world = createWorld(seed, { airport: false });
  const quality = smallProfile();
  const selected = richCell(world, quality.vegetationDensity);
  const observer = {
    x: (selected.cellX + 0.5) * CELL_METERS,
    y: 140,
    z: (selected.cellZ + 0.5) * CELL_METERS,
  };
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const bridge = new SynchronousWorkerBridge();
  const clock = { now: 0 };
  const runtime = new WorldDetailRuntime(scene, {
    worldSeed: world.seed,
    terrainSample: (x, z) => sampleTerrain(world, x, z),
    cellSizeMeters: CELL_METERS,
    seaLevelMeters: world.seaLevel,
    latitudeDegrees: world.latitudeDegrees,
    workerWorldSeed: world.seed,
    workerWorld: world,
    detailWorkerFactory: () => bridge as unknown as Worker,
    presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    presentationNowMilliseconds: () => clock.now,
  });
  for (let pass = 0; pass < 128 && (pass === 0 || runtime.pendingWorkItems > 0); pass += 1) {
    clock.now += 10;
    runtime.update(observer, ORIGIN, quality);
    bridge.flush();
  }
  if (runtime.pendingWorkItems !== 0) throw new Error("Worker detail runtime did not settle");
  return {
    runtime,
    bridge,
    observer,
    quality,
    clock,
    dispose: () => {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/** Posts a held frontier build: one 64 m step dirties the observer's chunk. */
function postHeldBuild(fixture: Fixture): number {
  fixture.bridge.holdPresentations = true;
  fixture.clock.now += 10;
  fixture.runtime.update(
    { ...fixture.observer, x: fixture.observer.x + 64 },
    ORIGIN,
    fixture.quality,
  );
  fixture.bridge.flush();
  const buildId = fixture.bridge.buildIds().at(-1);
  if (buildId === undefined) throw new Error("No worker build was posted");
  expect(clockOf(fixture.runtime).pendingPresentationBuild?.source).toBe("worker");
  return buildId;
}

function heartbeat(fixture: Fixture, buildId: number): void {
  fixture.bridge.emit({ type: "presentationProgress", buildId, slices: 1, units: 64 });
}

/** Updates at a fixed period while the held build stays unanswered; returns the update count. */
function updateHeld(fixture: Fixture, periodMilliseconds: number, updates: number): number {
  const observer = { ...fixture.observer, x: fixture.observer.x + 64 };
  for (let update = 1; update <= updates; update += 1) {
    fixture.clock.now += periodMilliseconds;
    fixture.runtime.update(observer, ORIGIN, fixture.quality);
    fixture.bridge.flush();
    if (clockOf(fixture.runtime).client === null) return update;
  }
  return updates;
}

describe("detail worker presentation watchdog", () => {
  it("does not expire on 240 updates that span less than two seconds", () => {
    const fixture = settledFixture("detail-liveness-fast-updates");
    try {
      postHeldBuild(fixture);
      // 240 Hz: 470 updates are 1.96 s of charged silence.
      expect(updateHeld(fixture, 1_000 / 240, 470)).toBe(470);
      expect(clockOf(fixture.runtime).client).not.toBeNull();
      expect(fixture.runtime.presentationRebuildDiagnostics.workerBuildTimeouts).toBe(0);
      // Two seconds of silence is what the update count needs to expire.
      expect(updateHeld(fixture, 1_000 / 240, 16)).toBeLessThanOrEqual(16);
      expect(clockOf(fixture.runtime).client).toBeNull();
      expect(fixture.runtime.presentationRebuildDiagnostics.workerBuildTimeouts).toBe(1);
      expect(fixture.bridge.cancels()).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("expires 240 silent updates that span two seconds, with one cancel", () => {
    const fixture = settledFixture("detail-liveness-silent");
    try {
      postHeldBuild(fixture);
      // 120 Hz: the update count and two seconds arrive together.
      const updates = updateHeld(fixture, 1_000 / 120 + 1e-9, 400);
      expect(updates).toBe(DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES);
      expect(clockOf(fixture.runtime).client).toBeNull();
      const diagnostics = fixture.runtime.presentationRebuildDiagnostics;
      expect(diagnostics.workerBuildTimeouts).toBe(1);
      // A replacement worker is built at the next update, not a fallback.
      expect(diagnostics.workerFallbacks).toBe(0);
      expect(diagnostics.workerActive).toBe(true);
      expect(diagnostics.workerMaxSilenceUpdates).toBe(240);
      expect(diagnostics.workerMaxSilenceMilliseconds).toBeGreaterThanOrEqual(2_000);
      expect(fixture.bridge.cancels()).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps a heartbeating build alive, then catches it when the heartbeats stop", () => {
    const fixture = settledFixture("detail-liveness-heartbeat");
    try {
      const buildId = postHeldBuild(fixture);
      const settledHeartbeats = fixture.runtime.presentationRebuildDiagnostics
        .workerPresentationHeartbeats;
      // Ten seconds at 120 Hz, a heartbeat every 100 ms.
      for (let second = 0; second < 10; second += 1) {
        for (let beat = 0; beat < 10; beat += 1) {
          expect(updateHeld(fixture, 1_000 / 120, 12)).toBe(12);
          heartbeat(fixture, buildId);
        }
      }
      expect(clockOf(fixture.runtime).client).not.toBeNull();
      const alive = fixture.runtime.presentationRebuildDiagnostics;
      expect(alive.workerPresentationHeartbeats - settledHeartbeats).toBe(100);
      expect(alive.workerMaxSilenceUpdates).toBe(12);
      expect(alive.workerBuildTimeouts).toBe(0);
      expect(fixture.bridge.cancels()).toBe(0);

      const silentUpdates = updateHeld(fixture, 1_000 / 120, 600);
      expect(silentUpdates).toBeGreaterThanOrEqual(DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES);
      expect(silentUpdates).toBeLessThanOrEqual(DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES + 1);
      expect(clockOf(fixture.runtime).client).toBeNull();
      expect(fixture.runtime.presentationRebuildDiagnostics.workerBuildTimeouts).toBe(1);
      expect(fixture.bridge.cancels()).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("does not reset on cancel and reissue, or on a canceled or unknown build's heartbeat", () => {
    const fixture = settledFixture("detail-liveness-cancel");
    try {
      const firstBuild = postHeldBuild(fixture);
      updateHeld(fixture, 10, 50);
      const before = clockOf(fixture.runtime).workerPresentationProgressUpdate;
      expect(before).not.toBeNull();

      // A floating-origin rebase cancels the held build and reissues it.
      const rebased = { x: 512, y: 0, z: -256 };
      fixture.clock.now += 10;
      fixture.runtime.update(
        { ...fixture.observer, x: fixture.observer.x + 64 },
        rebased,
        fixture.quality,
      );
      fixture.bridge.flush();
      expect(fixture.bridge.cancels()).toBe(1);
      const reissued = fixture.bridge.buildIds().at(-1)!;
      expect(reissued).toBeGreaterThan(firstBuild);
      expect(clockOf(fixture.runtime).workerPresentationProgressUpdate).toBe(before);

      // The canceled build's late heartbeat, and one for a build that never
      // existed, reach nothing.
      const heartbeats = () => fixture.runtime.presentationRebuildDiagnostics
        .workerPresentationHeartbeats;
      const settledHeartbeats = heartbeats();
      heartbeat(fixture, firstBuild);
      heartbeat(fixture, reissued + 7);
      expect(clockOf(fixture.runtime).workerPresentationProgressUpdate).toBe(before);
      expect(heartbeats()).toBe(settledHeartbeats);

      // The current build's heartbeat does.
      heartbeat(fixture, reissued);
      expect(clockOf(fixture.runtime).workerPresentationProgressUpdate)
        .toBe(clockOf(fixture.runtime).updateSequence);
      expect(heartbeats()).toBe(settledHeartbeats + 1);
    } finally {
      fixture.dispose();
    }
  });

  it("does not charge main-thread publication streaming to the worker", () => {
    const world = createWorld("detail-liveness-publication", { airport: false });
    const quality = { ...smallProfile(), vegetationDistance: 900 };
    const selected = richCell(world, quality.vegetationDensity);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new SynchronousWorkerBridge();
    let now = 0;
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: world.seed,
      terrainSample: (x, z) => sampleTerrain(world, x, z),
      cellSizeMeters: CELL_METERS,
      seaLevelMeters: world.seaLevel,
      latitudeDegrees: world.latitudeDegrees,
      workerWorldSeed: world.seed,
      workerWorld: world,
      detailWorkerFactory: () => bridge as unknown as Worker,
      presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
      presentationNowMilliseconds: () => now,
    });
    const observer = {
      x: (selected.cellX + 0.5) * CELL_METERS,
      y: 140,
      z: (selected.cellZ + 0.5) * CELL_METERS,
    };
    try {
      let streamingUpdates = 0;
      for (let pass = 0; pass < 2_000 && (pass === 0 || runtime.pendingWorkItems > 0); pass += 1) {
        // 90 ms frames: inside the gap allowance, so only the pause can keep
        // the streaming off the clock.
        now += 90;
        runtime.update(observer, ORIGIN, quality);
        const state = clockOf(runtime);
        if (state.pendingPublication !== null && state.pendingPresentationBuild === null) {
          streamingUpdates += 1;
          // Nothing the worker holds: the silence clock is stopped, however
          // many 90 ms updates the publication takes.
          expect(state.workerPresentationProgressUpdate).toBeNull();
        }
        bridge.flush();
      }
      expect(runtime.pendingWorkItems).toBe(0);
      // Fresh chunks create their batches one structural step per update.
      expect(streamingUpdates).toBeGreaterThanOrEqual(10);
      const diagnostics = runtime.presentationRebuildDiagnostics;
      expect(diagnostics.workerBuildTimeouts).toBe(0);
      expect(diagnostics.workerBuildPublications).toBeGreaterThan(1);
      // Each silence is one build's wait: the bridge answers within an update.
      expect(diagnostics.workerMaxSilenceUpdates).toBeLessThanOrEqual(2);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
