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
  DETAIL_WORKER_GENERATE_SHARE_MAXIMUM_MILLISECONDS,
  DETAIL_WORKER_GENERATE_SHARE_MINIMUM_MILLISECONDS,
  DETAIL_WORKER_GENERATE_SHARE_OF_LAST_GENERATE,
  DETAIL_WORKER_HEARTBEAT_MILLISECONDS,
  DetailWorkerRuntime,
} from "../src/workers/detail.worker";
import { createWorld, findSpawnedAirport, sampleTerrain, withAirports } from "../src/world";
import { readSource } from "./support/sourceText";

/**
 * How the detail worker schedules a presentation build: the heartbeats it
 * posts between slices, that slicing never changes the packed bytes, and how
 * generates posted during a build share the thread with it. Everything runs
 * on a manual macrotask queue and an injected clock, so a "slice" here is
 * exactly what the worker's own clock says it is.
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

/**
 * One worker thread: a FIFO of macrotasks, and a clock every read advances.
 * A generate also costs `generateMilliseconds`, charged as it answers.
 */
class ManualWorker {
  readonly posted: Posted[] = [];
  readonly runtime: DetailWorkerRuntime;
  clock = 0;
  private readonly tasks: Array<() => void> = [];

  constructor(
    readonly millisecondsPerClockRead: number,
    readonly generateMilliseconds = 0,
  ) {
    this.runtime = new DetailWorkerRuntime(
      (event) => {
        if (event.type === "cell" || event.type === "retainedCell" || event.type === "error") {
          this.clock += this.generateMilliseconds;
        }
        this.posted.push({ event, at: this.clock });
      },
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

  /** Generate answers, in the order they were posted. */
  get answers(): DetailWorkerEvent[] {
    return this.posted
      .map(({ event }) => event)
      .filter((event) => (
        event.type === "cell" || event.type === "retainedCell" || event.type === "error"
      ));
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

/** The generate command the main thread posts for one production cell. */
function generateCommand(
  requestId: number,
  cellX: number,
  cellZ: number,
  retain: boolean,
): Extract<DetailWorkerCommand, { type: "generate" }> {
  return {
    type: "generate",
    requestId,
    generation: 1,
    key: `${cellX}:${cellZ}`,
    cellX,
    cellZ,
    densityMultiplier: PROFILE.vegetationDensity,
    dayOfYear: 171,
    retain,
  };
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
    worker.command(generateCommand(index + 1, cellX, cellZ, true));
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

describe("detail worker build-first scheduling", () => {
  // Cells near home, each its own key; the serial reference generates the
  // same commands with no build running.
  const PUMPED = [[1, 0], [1, -1], [-2, 0]] as const;

  /** The same commands run on a worker with no build: today's order and bytes. */
  function serialReference(commands: readonly DetailWorkerCommand[]): DetailWorkerEvent[] {
    const reference = new ManualWorker(0);
    initializeHomeBlock(reference);
    const homeAnswers = reference.answers.length;
    for (const command of commands) reference.command(command);
    expect(reference.pendingTasks).toBe(0);
    return reference.answers.slice(homeAnswers);
  }

  it("defers generates posted during a build and answers them in order once it publishes", () => {
    // A frozen clock never earns a generate its mid-build turn.
    const worker = new ManualWorker(0);
    const input = initializeHomeBlock(worker);
    const homeAnswers = worker.answers.length;
    worker.command({ type: "buildPresentation", buildId: 5, input });
    worker.runTask();
    const commands = PUMPED.map(([cellX, cellZ], index) => (
      generateCommand(11 + index, cellX, cellZ, index !== 1)
    ));
    for (const command of commands) worker.command(command);
    expect(worker.answers).toHaveLength(homeAnswers);

    worker.runAll();
    const order = worker.posted
      .map(({ event }) => event)
      .filter((event) => event.type === "presentation" || "requestId" in event)
      .slice(homeAnswers)
      .map((event) => ("requestId" in event ? event.requestId : event.type));
    expect(order).toEqual(["presentation", 11, 12, 13]);
    // Same bytes and the same retained tokens as with no build running.
    expect(worker.answers.slice(homeAnswers)).toEqual(serialReference(commands));
  });

  it("answers deferred generates as soon as the build is canceled", () => {
    const worker = new ManualWorker(0);
    const input = initializeHomeBlock(worker);
    const homeAnswers = worker.answers.length;
    worker.command({ type: "buildPresentation", buildId: 6, input });
    worker.runTask();
    const commands = PUMPED.slice(0, 2).map(([cellX, cellZ], index) => (
      generateCommand(21 + index, cellX, cellZ, true)
    ));
    for (const command of commands) worker.command(command);
    expect(worker.answers).toHaveLength(homeAnswers);
    worker.command({ type: "cancelPresentation", buildId: 6 });
    // Within the cancel itself, not on a later task.
    expect(worker.answers.slice(homeAnswers)).toEqual(serialReference(commands));
    worker.runAll();
    expect(worker.eventsFor(6).some(({ event }) => event.type === "presentation")).toBe(false);
    expect(worker.answers).toHaveLength(homeAnswers + commands.length);
  });

  it.each([2, 12, 30, 60])(
    "runs one generate per task, each after the build's turn of slices (%d ms cells)",
    (generateMilliseconds) => {
      // Each clock read is a millisecond: a slice runs 5 of build time, and
      // a generate times itself as its cost plus one read.
      const worker = new ManualWorker(1, generateMilliseconds);
      const input = initializeHomeBlock(worker);
      worker.command({ type: "buildPresentation", buildId: 7, input });
      // The main thread keeps one generate in flight and posts the next as
      // each answers, so a build always has one waiting.
      let requestId = 100;
      const pump = () => {
        const [cellX, cellZ] = PUMPED[requestId % PUMPED.length]!;
        worker.command(generateCommand(requestId, cellX, cellZ, false));
        requestId += 1;
      };
      pump();
      const measuredGenerate = generateMilliseconds + 1;
      const turn = Math.min(
        DETAIL_WORKER_GENERATE_SHARE_MAXIMUM_MILLISECONDS,
        Math.max(
          DETAIL_WORKER_GENERATE_SHARE_MINIMUM_MILLISECONDS,
          DETAIL_WORKER_GENERATE_SHARE_OF_LAST_GENERATE * measuredGenerate,
        ),
      );
      let buildMilliseconds = 0;
      let generates = 0;
      while (generates < 8) {
        expect(worker.runtime.activePresentationBuildCount).toBe(1);
        const answersBefore = worker.answers.length;
        worker.runTask();
        const answered = worker.answers.length - answersBefore;
        expect(answered).toBeLessThanOrEqual(1);
        if (answered === 0) {
          buildMilliseconds += 5;
          continue;
        }
        generates += 1;
        // Never before the build has had its turns; never held past one
        // more turn and a slice (what runs past a turn carries over).
        expect(buildMilliseconds).toBeGreaterThanOrEqual(generates * turn);
        expect(buildMilliseconds).toBeLessThan(generates * turn + turn + 5);
        pump();
      }
      const buildShare = buildMilliseconds / (buildMilliseconds + generates * measuredGenerate);
      expect(buildShare).toBeCloseTo(turn / (turn + measuredGenerate), 1);
      worker.runAll();
      expect(worker.eventsFor(7).at(-1)?.event.type).toBe("presentation");
      // The one still waiting at publish is answered with it.
      expect(worker.answers.at(-1)).toMatchObject({ requestId: requestId - 1 });
    },
  );

  it("runs a deferred generate before an airports change, so it sees the world it was posted against", () => {
    const home = WORLD.airport!;
    let spawned: ReturnType<typeof findSpawnedAirport> = null;
    for (let attempt = 0; !spawned; attempt += 1) {
      spawned = findSpawnedAirport(WORLD, home.centerX + 15_000, home.centerZ, Math.PI / 2, attempt);
      if (spawned === "exhausted") throw new Error("No spawn site for the scheduling world");
    }
    const airports = withAirports(WORLD, [...WORLD.airports, spawned]).airports;
    const cellX = Math.floor(spawned.centerX / CELL_METERS);
    const cellZ = Math.floor(spawned.centerZ / CELL_METERS);
    const before = generateCommand(31, cellX, cellZ, false);
    const after = generateCommand(32, cellX, cellZ, false);
    const commands: DetailWorkerCommand[] = [before, { type: "airports", airports }, after];

    const worker = new ManualWorker(0);
    const input = initializeHomeBlock(worker);
    const homeAnswers = worker.answers.length;
    worker.command({ type: "buildPresentation", buildId: 8, input });
    worker.runTask();
    for (const command of commands) worker.command(command);
    // The airports change ran the first; the second waits for the build.
    expect(worker.answers.slice(homeAnswers).map((event) => "requestId" in event && event.requestId))
      .toEqual([31]);
    worker.runAll();

    const reference = serialReference(commands);
    expect(worker.answers.slice(homeAnswers)).toEqual(reference);
    const [beforeCell, afterCell] = reference;
    if (beforeCell?.type !== "cell" || afterCell?.type !== "cell") throw new Error("Expected two cells");
    // Armed: the spawned runway clears this cell, so order is observable.
    expect(afterCell.cell.trees.length).toBeLessThan(beforeCell.cell.trees.length);
  });

  it("does not run deferred generates on a release, and allocates tokens as before", () => {
    const worker = new ManualWorker(0);
    const input = initializeHomeBlock(worker);
    const homeAnswers = worker.answers.length;
    const released = input.residents[0]!.token;
    const commands: DetailWorkerCommand[] = [
      generateCommand(41, PUMPED[0][0], PUMPED[0][1], true),
      { type: "releaseCell", token: released },
      generateCommand(42, PUMPED[1][0], PUMPED[1][1], true),
    ];
    worker.command({ type: "buildPresentation", buildId: 9, input });
    worker.runTask();
    for (const command of commands) worker.command(command);
    expect(worker.answers).toHaveLength(homeAnswers);
    expect(worker.runtime.retainedCellCount).toBe(HOME_CELLS.length - 1);

    worker.runAll();
    expect(worker.eventsFor(9).at(-1)?.event.type).toBe("presentation");
    expect(worker.answers.slice(homeAnswers)).toEqual(serialReference(commands));
    expect(worker.runtime.retainedCellCount).toBe(HOME_CELLS.length + 1);
  });

  it("keeps setTimeout as the default yield and uses MessageChannel only at the browser entry", () => {
    const source = readSource(new URL("../src/workers/detail.worker.ts", import.meta.url));
    expect(source).toMatch(
      /scheduleMacrotask: ScheduleMacrotask = \(callback\) => \{\s*setTimeout\(callback, 0\);\s*\}/u,
    );
    const scheduler = source.indexOf("function messageChannelScheduler(");
    const entry = source.indexOf("if (typeof WorkerGlobalScope !== \"undefined\"");
    expect(scheduler).toBeGreaterThan(0);
    expect(entry).toBeGreaterThan(scheduler);
    expect(source.slice(0, scheduler)).not.toContain("MessageChannel");
    expect(source.match(/new MessageChannel\(/gu)).toHaveLength(1);
    expect(source.slice(entry)).toContain(
      "typeof MessageChannel === \"function\" ? messageChannelScheduler() : undefined",
    );
  });
});
