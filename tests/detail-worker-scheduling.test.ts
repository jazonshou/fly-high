import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { DetailPresentationBuildCatalog } from "../src/render/webgpu/detail/presentationBuild";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import type {
  DetailWorkerCommand,
  DetailWorkerEvent,
  DetailWorkerPresentationBuildInput,
} from "../src/workers/detailProtocol";
import {
  DETAIL_WORKER_HEARTBEAT_MILLISECONDS,
  DetailWorkerRuntime,
} from "../src/workers/detail.worker";
import { createWorld, sampleTerrain } from "../src/world";

/**
 * How the detail worker schedules a presentation build: the heartbeats it
 * posts between slices, and that slicing never changes the packed bytes.
 * Everything runs on a manual macrotask queue and an injected clock, so a
 * "slice" here is exactly what the worker's own clock says it is.
 */

// The game's seed at its home field: dense, mixed forest, so one 2x2 block of
// production cells packs into many slices.
const WORLD = createWorld(0x51a7e);
const CELL_METERS = 512;
const PROFILE = resolveWebGpuQualityProfile("medium", "balanced");
const HOME_CELLS = [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const;

let catalog: DetailPresentationBuildCatalog;
let catalogEngine: NullEngine;
let catalogScene: Scene;
let catalogRuntime: WorldDetailRuntime;

beforeAll(() => {
  catalogEngine = new NullEngine();
  catalogScene = new Scene(catalogEngine);
  catalogRuntime = new WorldDetailRuntime(catalogScene, {
    worldSeed: WORLD.seed,
    terrainSample: (x, z) => sampleTerrain(WORLD, x, z),
  });
  catalog = (catalogRuntime as unknown as {
    readonly presentationBuildCatalog: DetailPresentationBuildCatalog;
  }).presentationBuildCatalog;
});

afterAll(() => {
  catalogRuntime.dispose();
  catalogScene.dispose();
  catalogEngine.dispose();
});

interface Posted {
  readonly event: DetailWorkerEvent;
  /** The worker clock when the event was posted. */
  readonly at: number;
}

/** One worker thread: a FIFO of macrotasks, and a clock every read advances. */
class ManualWorker {
  readonly posted: Posted[] = [];
  readonly runtime: DetailWorkerRuntime;
  clock = 0;
  private readonly tasks: Array<() => void> = [];

  constructor(readonly millisecondsPerClockRead: number) {
    this.runtime = new DetailWorkerRuntime(
      (event) => this.posted.push({ event, at: this.clock }),
      (callback) => this.tasks.push(callback),
      () => (this.clock += this.millisecondsPerClockRead),
    );
  }

  get pendingTasks(): number {
    return this.tasks.length;
  }

  command(command: DetailWorkerCommand): void {
    this.runtime.handleCommand(command);
  }

  runTask(): void {
    const task = this.tasks.shift();
    if (!task) throw new Error("No worker macrotask is queued");
    task();
  }

  runAll(limit = 100_000): void {
    for (let run = 0; this.tasks.length > 0; run += 1) {
      if (run >= limit) throw new Error("Manual worker scheduler did not settle");
      this.runTask();
    }
  }

  eventsFor(buildId: number): Posted[] {
    return this.posted.filter(({ event }) => (
      (event.type === "presentation"
        || event.type === "presentationProgress"
        || event.type === "presentationError")
      && event.buildId === buildId
    ));
  }
}

/** Initializes the worker and retains the home block; returns the build input. */
function initializeHomeBlock(worker: ManualWorker): DetailWorkerPresentationBuildInput {
  worker.command({
    type: "initialize",
    worldSeed: WORLD.seed,
    world: WORLD,
    cellSizeMeters: CELL_METERS,
    seaLevelMeters: WORLD.seaLevel,
    presentationCatalog: catalog,
  });
  const residents = HOME_CELLS.map(([cellX, cellZ], index) => {
    worker.command({
      type: "generate",
      requestId: index + 1,
      generation: 1,
      key: `${cellX}:${cellZ}`,
      cellX,
      cellZ,
      densityMultiplier: PROFILE.vegetationDensity,
      dayOfYear: 171,
      retain: true,
    });
    const answer = worker.posted.at(-1)?.event;
    if (answer?.type !== "retainedCell") throw new Error("Missing retained home cell");
    return { token: answer.cell.token, lod: "near" as const, distance: 0 };
  });
  return {
    residents,
    floatingOrigin: { x: 0, y: 0, z: 0 },
    densityLaw: PROFILE.renderedDensityLaw,
    treeVariantCap: PROFILE.treeVariantCap,
    treePrototypeMode: PROFILE.treePrototypeMode,
    grassRadiusMeters: PROFILE.grassRadiusMeters,
    observerX: 0,
    observerZ: 0,
  };
}

describe("detail worker presentation heartbeats", () => {
  it("heartbeats after the first unfinished slice, then at least every 100 ms of build", () => {
    // Every clock read is a millisecond, so a slice is four reads (256 units).
    const worker = new ManualWorker(1);
    const input = initializeHomeBlock(worker);
    worker.command({ type: "buildPresentation", buildId: 3, input });
    worker.runTask();
    expect(worker.eventsFor(3).map(({ event }) => event)).toEqual([
      { type: "presentationProgress", buildId: 3, slices: 1, units: 256 },
    ]);

    worker.runAll();
    const events = worker.eventsFor(3);
    const progress = events.filter(({ event }) => event.type === "presentationProgress");
    const answerIndex = events.findIndex(({ event }) => event.type === "presentation");
    // The answer is last: nothing for this build follows it.
    expect(answerIndex).toBe(events.length - 1);
    expect(progress.length).toBeGreaterThanOrEqual(4);
    let previous = progress[0]!;
    for (const current of [...progress.slice(1), events[answerIndex]!]) {
      const gap = current.at - previous.at;
      // Throttled to the cadence, and never silent for longer than the
      // cadence plus one slice: its start, four checks and a heartbeat read.
      if (current.event.type === "presentationProgress") {
        expect(gap).toBeGreaterThanOrEqual(DETAIL_WORKER_HEARTBEAT_MILLISECONDS);
        if (previous.event.type !== "presentationProgress") throw new Error("Unordered events");
        expect(current.event.slices).toBeGreaterThan(previous.event.slices);
        expect(current.event.units).toBeGreaterThan(previous.event.units);
      }
      expect(gap).toBeLessThanOrEqual(DETAIL_WORKER_HEARTBEAT_MILLISECONDS + 6);
      previous = current;
    }
    expect(worker.runtime.activePresentationBuildCount).toBe(0);
  });

  it("posts nothing for a build once it is canceled", () => {
    const worker = new ManualWorker(1);
    const input = initializeHomeBlock(worker);
    worker.command({ type: "buildPresentation", buildId: 4, input });
    worker.runTask();
    worker.runTask();
    const before = worker.eventsFor(4).length;
    expect(before).toBe(1);
    worker.command({ type: "cancelPresentation", buildId: 4 });
    worker.runAll();
    expect(worker.eventsFor(4)).toHaveLength(before);
    expect(worker.runtime.activePresentationBuildCount).toBe(0);
  });

  it("packs identical bytes however the clock cuts the build into slices", () => {
    const sliced = new ManualWorker(1);
    const frozen = new ManualWorker(0);
    const slicedInput = initializeHomeBlock(sliced);
    const frozenInput = initializeHomeBlock(frozen);
    expect(slicedInput).toEqual(frozenInput);
    sliced.command({ type: "buildPresentation", buildId: 1, input: slicedInput });
    frozen.command({ type: "buildPresentation", buildId: 1, input: frozenInput });
    sliced.runAll();
    frozen.runAll();

    const answer = (worker: ManualWorker) => {
      const event = worker.eventsFor(1).at(-1)?.event;
      if (event?.type !== "presentation") throw new Error("Missing presentation answer");
      return event;
    };
    const slicedProgress = sliced.eventsFor(1).filter(
      ({ event }) => event.type === "presentationProgress",
    );
    const frozenProgress = frozen.eventsFor(1).filter(
      ({ event }) => event.type === "presentationProgress",
    );
    // A frozen clock ends slices on the 4,096-unit cap only.
    const lastSliced = slicedProgress.at(-1)?.event;
    const lastFrozen = frozenProgress.at(-1)?.event;
    if (lastSliced?.type !== "presentationProgress" || lastFrozen?.type !== "presentationProgress") {
      throw new Error("Both builds should span several slices");
    }
    expect(lastSliced.slices).toBeGreaterThan(4 * lastFrozen.slices);
    expect(answer(sliced)).toEqual(answer(frozen));
  });
});
