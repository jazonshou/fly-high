import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES,
  DETAIL_WORKER_CONVERGENCE_MILLISECONDS,
  DETAIL_WORKER_RESPAWN_LIMIT,
  WorldDetailRuntime,
  type DetailWorkerHealth,
  type DetailWorkerHealthEvent,
} from "../src/render/webgpu/detail/WorldDetailRuntime";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  admitInlineCellAfterWorkerFailure,
  canGenerateNextDetailCell,
  createInlineCellCredit,
  recordInlineCellAfterWorkerFailure,
  type DetailGenerationBudget,
} from "../src/render/webgpu/detail/generationBudget";
import type { DetailInstanceWriter } from "../src/render/webgpu/detail/instanceFormat";
import type { DetailWorkerCommand, DetailWorkerEvent } from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import {
  createWorld,
  findSpawnedAirport,
  sampleTerrain,
  withAirports,
  type WorldDefinition,
} from "../src/world";

/**
 * A detail worker that fails — reports an error, or goes silent past a
 * watchdog — is replaced by a new one, up to `detailWorkerRespawnLimit`
 * times, before vegetation falls back to the main thread. Until 2026-10-25
 * every failure was that fallback, for the rest of the session, with the
 * first cell of every update admitted whatever it cost.
 */

type Listener = EventListenerOrEventListenerObject;

function invokeListener(listener: Listener, event: Event): void {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

/** A worker transport over the real worker runtime, flushed by the test. */
class RecoveryWorkerBridge {
  readonly commands: DetailWorkerCommand[] = [];
  /** Answers and heartbeats are held together, so a held build is silent. */
  holdPresentations = false;
  holdGeneration = false;
  readonly held: DetailWorkerEvent[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks: Array<() => void> = [];
  private readonly outbound: DetailWorkerEvent[] = [];
  private readonly workerRuntime = new DetailWorkerRuntime(
    (event) => this.outbound.push(event),
    (callback) => this.tasks.push(callback),
  );

  constructor(private readonly throwOnInitialize = false) {}

  postMessage(command: DetailWorkerCommand): void {
    if (this.terminated) throw new Error("Worker bridge is terminated");
    if (this.throwOnInitialize && command.type === "initialize") {
      throw new Error("Worker refused initialize");
    }
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

  terminate(): void {
    this.terminated = true;
  }

  flush(limit = 200_000): void {
    let work = 0;
    while (this.tasks.length > 0 || this.outbound.length > 0) {
      while (this.tasks.length > 0) {
        if (work >= limit) throw new Error("Detail worker bridge did not settle");
        this.tasks.shift()!();
        work += 1;
      }
      for (const event of this.outbound.splice(0)) {
        const presentation = event.type === "presentation" || event.type === "presentationProgress";
        if ((this.holdPresentations && presentation) || (this.holdGeneration && !presentation)) {
          this.held.push(event);
        } else {
          this.emit(event);
        }
      }
    }
  }

  fail(): void {
    const event = { preventDefault: () => undefined } as unknown as Event;
    for (const listener of [...(this.listeners.get("error") ?? [])]) {
      invokeListener(listener, event);
    }
  }

  emit(data: unknown): void {
    const event = { data } as unknown as Event;
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      invokeListener(listener, event);
    }
  }
}

interface ResidentSnapshot {
  readonly source: "inline" | "worker";
  readonly tokenOwned?: boolean;
}

interface RecoveryInternals {
  readonly client: unknown;
  readonly workerRespawnPending: boolean;
  readonly inlineGenerationLimited: boolean;
  readonly cells: Map<string, ResidentSnapshot>;
  readonly pendingPresentationBuild: { readonly source: string; readonly buildId: number } | null;
  readonly batches: Map<string, {
    readonly chunkKey: string;
    readonly prototypeKey: string;
    readonly writer: DetailInstanceWriter;
  }>;
}

function internals(runtime: WorldDetailRuntime): RecoveryInternals {
  return runtime as unknown as RecoveryInternals;
}

/** Every published batch's bytes, by batch key. */
function publishedBytes(runtime: WorldDetailRuntime): Map<string, Uint8Array> {
  return new Map([...internals(runtime).batches].map(([key, batch]) => [
    key,
    Uint8Array.from(batch.writer.finish()),
  ]));
}

const CELL = 128;
const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

function profile() {
  return {
    ...resolveWebGpuQualityProfile("medium", "balanced"),
    vegetationDistance: 170,
    vegetationDensity: 0.55,
    grassRadiusMeters: 36,
  };
}

/** A populated cell near the origin, to stand over. */
function richCell(world: WorldDefinition, densityMultiplier: number) {
  let best = { cellX: 2, cellZ: 2, count: -1 };
  for (let cellZ = -8; cellZ <= 8; cellZ += 1) {
    for (let cellX = -8; cellX <= 8; cellX += 1) {
      const cell = generateDetailCell({
        worldSeed: world.seed,
        cellX,
        cellZ,
        cellSizeMeters: CELL,
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
  readonly world: WorldDefinition;
  readonly observer: { readonly x: number; readonly y: number; readonly z: number };
  readonly quality: ReturnType<typeof profile>;
  readonly runtime: WorldDetailRuntime;
  readonly bridges: RecoveryWorkerBridge[];
  /** How many times the runtime asked for a worker. */
  readonly factoryCalls: () => number;
  readonly latest: () => RecoveryWorkerBridge;
  readonly update: (observer?: Fixture["observer"]) => void;
  readonly settle: (limit?: number) => void;
  readonly dispose: () => void;
}

const fixtureWorlds = new Map<string, { world: WorldDefinition; cellX: number; cellZ: number }>();

function fixture(
  seed: string,
  options: {
    readonly respawnLimit?: number;
    readonly now?: () => number;
    readonly reportWorkerHealth?: (kind: DetailWorkerHealthEvent, health: DetailWorkerHealth) => void;
    /** The worker the runtime gets on its Nth request (1-based), or a throw. */
    readonly worker?: (call: number) => RecoveryWorkerBridge;
  } = {},
): Fixture {
  let cached = fixtureWorlds.get(seed);
  if (!cached) {
    const world = createWorld(seed);
    cached = { world, ...richCell(world, profile().vegetationDensity) };
    fixtureWorlds.set(seed, cached);
  }
  const { world, cellX, cellZ } = cached;
  const observer = { x: (cellX + 0.5) * CELL, y: 140, z: (cellZ + 0.5) * CELL };
  const quality = profile();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const bridges: RecoveryWorkerBridge[] = [];
  let calls = 0;
  const runtime = new WorldDetailRuntime(scene, {
    worldSeed: world.seed,
    terrainSample: (x, z) => sampleTerrain(world, x, z),
    cellSizeMeters: CELL,
    seaLevelMeters: world.seaLevel,
    latitudeDegrees: world.latitudeDegrees,
    workerWorldSeed: world.seed,
    workerWorld: world,
    detailWorkerFactory: () => {
      calls += 1;
      const bridge = options.worker?.(calls) ?? new RecoveryWorkerBridge();
      bridges.push(bridge);
      return bridge as unknown as Worker;
    },
    presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    ...(options.now ? { presentationNowMilliseconds: options.now } : {}),
    ...(options.respawnLimit !== undefined ? { detailWorkerRespawnLimit: options.respawnLimit } : {}),
    ...(options.reportWorkerHealth ? { reportWorkerHealth: options.reportWorkerHealth } : {}),
  });
  const latest = () => bridges.at(-1)!;
  const update = (at = observer) => {
    runtime.update(at, ORIGIN, quality);
    if (internals(runtime).client !== null) latest().flush();
  };
  return {
    world,
    observer,
    quality,
    runtime,
    bridges,
    factoryCalls: () => calls,
    latest,
    update,
    settle: (limit = 256) => {
      for (let pass = 0; pass < limit; pass += 1) {
        update();
        if (runtime.pendingWorkItems === 0) return;
      }
      throw new Error("Detail runtime did not settle");
    },
    dispose: () => {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

/** This runtime's own warnings, whatever else the engine logs. */
function detailWarnings(warn: { readonly mock: { readonly calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter(([message]) => String(message).startsWith("detail worker"));
}

function generateCommands(bridge: RecoveryWorkerBridge) {
  return bridge.commands.filter((command) => command.type === "generate");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detail worker respawn", () => {
  it("replaces a failed worker with one built against the live airport list, bytes unchanged", () => {
    let spawned: ReturnType<typeof findSpawnedAirport> = null;
    const scene = fixture("alpha", { reportWorkerHealth: () => undefined });
    try {
      const home = scene.world.airport!;
      for (let attempt = 0; !spawned; attempt += 1) {
        spawned = findSpawnedAirport(scene.world, home.centerX + 15_000, home.centerZ, Math.PI / 2, attempt);
        if (spawned === "exhausted") throw new Error("alpha found no spawn site");
      }
      const airports = withAirports(scene.world, [...scene.world.airports, spawned]).airports;
      scene.settle();
      // Far from this field: the spawn invalidates nothing in view.
      expect(scene.runtime.setAirports(airports)).toBe(0);
      scene.settle();
      const residents = scene.runtime.statistics.residentCells;
      const before = publishedBytes(scene.runtime);
      expect(before.size).toBeGreaterThan(0);

      scene.latest().fail();
      // Torn down now; replaced at the start of the next update.
      expect(internals(scene.runtime).client).toBeNull();
      expect(internals(scene.runtime).workerRespawnPending).toBe(true);
      expect(scene.runtime.workerHealth).toEqual({
        active: true,
        fallbacks: 0,
        respawns: 0,
        buildTimeouts: 0,
        generationTimeouts: 0,
        convergenceStalls: 0,
      });
      expect(scene.bridges).toHaveLength(1);

      scene.update();
      expect(scene.bridges).toHaveLength(2);
      const replacement = scene.latest();
      expect(replacement.commands[0]).toMatchObject({ type: "initialize", world: { airports } });
      // Every resident is asked for again; no chunk lost or changed a byte.
      expect(new Set(generateCommands(replacement).map((command) => command.key)).size)
        .toBe(residents);
      expect(publishedBytes(scene.runtime)).toEqual(before);
      expect([...internals(scene.runtime).cells.values()].some((resident) => resident.source === "inline"))
        .toBe(false);

      scene.settle();
      expect(publishedBytes(scene.runtime)).toEqual(before);
      expect([...internals(scene.runtime).cells.values()].every((resident) => (
        resident.source === "worker" && resident.tokenOwned
      ))).toBe(true);
      expect(internals(scene.runtime).client).not.toBeNull();
      expect(scene.runtime.workerHealth).toMatchObject({ active: true, respawns: 1, fallbacks: 0 });
      expect(scene.runtime.presentationRebuildDiagnostics).toMatchObject({
        workerActive: true,
        workerRespawns: 1,
        workerFallbacks: 0,
      });
    } finally {
      scene.dispose();
    }
  });

  it("falls back as before once the respawn budget is spent", () => {
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      const before = publishedBytes(scene.runtime);
      for (let respawn = 1; respawn <= DETAIL_WORKER_RESPAWN_LIMIT; respawn += 1) {
        scene.latest().fail();
        scene.update();
        expect(scene.runtime.workerHealth).toMatchObject({ active: true, respawns: respawn, fallbacks: 0 });
      }
      scene.latest().fail();
      expect(internals(scene.runtime).client).toBeNull();
      expect(internals(scene.runtime).workerRespawnPending).toBe(false);
      expect(scene.runtime.workerHealth).toMatchObject({
        active: false,
        respawns: DETAIL_WORKER_RESPAWN_LIMIT,
        fallbacks: 1,
      });
      expect(publishedBytes(scene.runtime)).toEqual(before);

      scene.settle(8_192);
      expect(scene.bridges).toHaveLength(DETAIL_WORKER_RESPAWN_LIMIT + 1);
      expect([...internals(scene.runtime).cells.values()].every((resident) => resident.source === "inline"))
        .toBe(true);
      expect(publishedBytes(scene.runtime)).toEqual(before);
    } finally {
      scene.dispose();
    }
  });

  it("falls back instead once terrain has gone to the worker", () => {
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      scene.runtime.publishTerrainMacro({
        originX: 0,
        originZ: 0,
        texelSizeMeters: 512,
        width: 2,
        height: 2,
        heights: new Float32Array([10, 20, 30, 40]),
      });
      scene.latest().fail();
      expect(internals(scene.runtime).workerRespawnPending).toBe(false);
      expect(scene.runtime.workerHealth).toMatchObject({ active: false, respawns: 0, fallbacks: 1 });
      scene.update();
      expect(scene.bridges).toHaveLength(1);
    } finally {
      scene.dispose();
    }
  });

  it("falls back at the next update when terrain arrives while a respawn is pending", () => {
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      scene.latest().fail();
      expect(internals(scene.runtime).workerRespawnPending).toBe(true);
      scene.runtime.publishTerrainPage({
        level: 0,
        tileX: 0,
        tileZ: 0,
        heights: new Float32Array(256 * 256),
      });
      scene.update();
      expect(scene.bridges).toHaveLength(1);
      expect(scene.runtime.workerHealth).toMatchObject({ active: false, respawns: 0, fallbacks: 1 });
    } finally {
      scene.dispose();
    }
  });

  it("replaces a silent build's worker at the next update, never inside the update that timed it out", () => {
    let now = 0;
    const scene = fixture("detail-runtime-worker-watchdog", {
      now: () => now,
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      const before = publishedBytes(scene.runtime);
      scene.latest().holdPresentations = true;
      const moved = (update: number) => ({ ...scene.observer, x: scene.observer.x + (update % 2 === 0 ? -64 : 64) });
      scene.update(moved(1));
      expect(internals(scene.runtime).pendingPresentationBuild?.source).toBe("worker");

      // Record every build the runtime tries to start, to see the update
      // that times the worker out still holding targets built for it.
      const attempts: Array<{ update: number; source: string; started: boolean }> = [];
      const runtime = scene.runtime as unknown as {
        createPendingPresentationBuild: (target: { buildSource: string }, ...rest: unknown[]) => unknown;
      };
      const create = runtime.createPendingPresentationBuild.bind(scene.runtime);
      let update = 0;
      runtime.createPendingPresentationBuild = (target, ...rest) => {
        const build = create(target, ...rest);
        attempts.push({ update, source: target.buildSource, started: build !== null });
        return build;
      };

      // 100 Hz: the watchdog's update count and its two-second floor together.
      for (update = 1; update <= DETAIL_PRESENTATION_WORKER_MAX_PENDING_UPDATES + 1; update += 1) {
        now += 10;
        scene.update(moved(update));
        if (internals(scene.runtime).client === null) break;
      }
      const expiredAt = update;
      expect(internals(scene.runtime).client).toBeNull();
      expect(internals(scene.runtime).workerRespawnPending).toBe(true);
      expect(scene.bridges).toHaveLength(1);
      expect(scene.runtime.workerHealth).toMatchObject({
        active: true,
        buildTimeouts: 1,
        respawns: 0,
        fallbacks: 0,
      });
      // That update still went on to a worker target, and started nothing.
      expect(attempts.filter((attempt) => attempt.update === expiredAt && attempt.source === "worker"))
        .not.toHaveLength(0);
      expect(attempts.some((attempt) => attempt.update === expiredAt && attempt.started)).toBe(false);
      expect(publishedBytes(scene.runtime)).toEqual(before);

      // The next update builds the replacement before computing a target.
      now += 10;
      update += 1;
      scene.update(moved(update));
      expect(scene.bridges).toHaveLength(2);
      expect(internals(scene.runtime).client).not.toBeNull();
      expect(scene.runtime.workerHealth).toMatchObject({ active: true, respawns: 1, fallbacks: 0 });
      expect(generateCommands(scene.latest()).length).toBeGreaterThan(0);

      for (let pass = 0; pass < 256 && scene.runtime.pendingWorkItems > 0; pass += 1) {
        now += 10;
        scene.update();
      }
      expect(scene.runtime.pendingWorkItems).toBe(0);
      expect(scene.runtime.workerHealth).toMatchObject({ active: true, respawns: 1, fallbacks: 0 });
      expect(publishedBytes(scene.runtime)).toEqual(before);
    } finally {
      scene.dispose();
    }
  });

  it("replaces a worker that stops answering generation, generating nothing inline meanwhile", () => {
    let now = 0;
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      now: () => now,
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      scene.runtime.setGenerationBudgetCap({ maximumCells: 1, maximumMilliseconds: 1_000_000 });
      scene.latest().holdGeneration = true;
      scene.runtime.setDayOfYear(40);
      let updates = 0;
      while (internals(scene.runtime).client !== null && updates < 1_000) {
        now += 10;
        scene.update();
        updates += 1;
      }
      expect(scene.runtime.workerHealth).toMatchObject({
        active: true,
        generationTimeouts: 1,
        respawns: 0,
        fallbacks: 0,
      });
      expect([...internals(scene.runtime).cells.values()].some((resident) => resident.source === "inline"))
        .toBe(false);
      now += 10;
      scene.update();
      expect(scene.bridges).toHaveLength(2);
      scene.settle();
      expect(scene.runtime.workerHealth).toMatchObject({ active: true, respawns: 1, fallbacks: 0 });
      expect([...internals(scene.runtime).cells.values()].every((resident) => (
        resident.source === "worker" && resident.tokenOwned
      ))).toBe(true);
    } finally {
      scene.dispose();
    }
  });
});

describe("detail worker respawn guard", () => {
  it.each([
    ["its factory throws", (): RecoveryWorkerBridge => {
      throw new Error("No second worker");
    }],
    ["its initialize post throws", (): RecoveryWorkerBridge => new RecoveryWorkerBridge(true)],
  ])("falls back for good when the replacement fails while being built (%s)", (_label, second) => {
    const reports: DetailWorkerHealthEvent[] = [];
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      worker: (call) => (call === 1 ? new RecoveryWorkerBridge() : second()),
      reportWorkerHealth: (kind) => reports.push(kind),
    });
    try {
      scene.settle();
      scene.latest().fail();
      expect(() => scene.update()).not.toThrow();
      expect(scene.factoryCalls()).toBe(2);
      expect(internals(scene.runtime).client).toBeNull();
      expect(internals(scene.runtime).workerRespawnPending).toBe(false);
      expect(scene.runtime.workerHealth).toMatchObject({ active: false, respawns: 1, fallbacks: 1 });
      expect(reports).toEqual(["fallback"]);
      for (let pass = 0; pass < 32; pass += 1) scene.update();
      expect(scene.factoryCalls()).toBe(2);
    } finally {
      scene.dispose();
    }
  });

  it("keeps the first worker's construction failure a plain fallback", () => {
    const reports: DetailWorkerHealthEvent[] = [];
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      worker: () => new RecoveryWorkerBridge(true),
      reportWorkerHealth: (kind) => reports.push(kind),
    });
    try {
      expect(internals(scene.runtime).client).toBeNull();
      expect(scene.runtime.workerHealth).toMatchObject({ active: false, respawns: 0, fallbacks: 1 });
      expect(internals(scene.runtime).inlineGenerationLimited).toBe(false);
      scene.update();
      expect(scene.factoryCalls()).toBe(1);
      expect(reports).toEqual([]);
    } finally {
      scene.dispose();
    }
  });
});

describe("detail worker health", () => {
  it("warns once per kind by default, with a message that starts 'detail worker'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const scene = fixture("detail-runtime-worker-respawn-budget");
    try {
      scene.settle();
      for (let respawn = 1; respawn <= DETAIL_WORKER_RESPAWN_LIMIT; respawn += 1) {
        scene.latest().fail();
        scene.update();
      }
      scene.latest().fail();
      const warnings = detailWarnings(warn);
      expect(warnings).toHaveLength(2);
      const [respawn, fallback] = warnings;
      expect(String(respawn?.[0])).toMatch(/^detail worker failed and was replaced/u);
      expect(String(fallback?.[0])).toMatch(/^detail worker failed for good/u);
      expect(respawn?.[1]).toMatchObject({ respawns: 1, fallbacks: 0 });
      expect(fallback?.[1]).toMatchObject({ respawns: DETAIL_WORKER_RESPAWN_LIMIT, fallbacks: 1 });
    } finally {
      scene.dispose();
    }
  });

  it("hands every event to a reporter, and reports a convergence stall without failing over", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reports: Array<[DetailWorkerHealthEvent, DetailWorkerHealth]> = [];
    let now = 0;
    const scene = fixture("detail-runtime-worker-watchdog", {
      now: () => now,
      reportWorkerHealth: (kind, health) => reports.push([kind, health]),
    });
    try {
      scene.settle();
      // A build that heartbeats forever and never answers.
      scene.latest().holdPresentations = true;
      scene.update({ ...scene.observer, x: scene.observer.x + 64 });
      const build = internals(scene.runtime).pendingPresentationBuild;
      if (build?.source !== "worker") throw new Error("Expected a worker build");
      for (let update = 1; now < DETAIL_WORKER_CONVERGENCE_MILLISECONDS + 100; update += 1) {
        now += 10;
        if (update % 50 === 0) {
          scene.latest().emit({ type: "presentationProgress", buildId: build.buildId, slices: update, units: update });
        }
        scene.update({ ...scene.observer, x: scene.observer.x + 64 });
      }
      expect(reports.map(([kind]) => kind)).toEqual(["convergenceStall"]);
      expect(reports[0]![1]).toEqual(scene.runtime.workerHealth);
      expect(scene.runtime.workerHealth).toEqual({
        active: true,
        fallbacks: 0,
        respawns: 0,
        buildTimeouts: 0,
        generationTimeouts: 0,
        convergenceStalls: 1,
      });

      scene.latest().fail();
      scene.update();
      expect(reports.map(([kind]) => kind)).toEqual(["convergenceStall", "respawn"]);
      expect(detailWarnings(warn)).toHaveLength(0);
    } finally {
      scene.dispose();
    }
  });

  it("reads the same counters as the diagnostics, in constant time", () => {
    const scene = fixture("detail-runtime-worker-respawn-budget", {
      reportWorkerHealth: () => undefined,
    });
    try {
      scene.settle();
      scene.latest().fail();
      scene.update();
      const diagnostics = scene.runtime.presentationRebuildDiagnostics;
      expect(scene.runtime.workerHealth).toEqual({
        active: diagnostics.workerActive,
        fallbacks: diagnostics.workerFallbacks,
        respawns: diagnostics.workerRespawns,
        buildTimeouts: diagnostics.workerBuildTimeouts,
        generationTimeouts: diagnostics.workerGenerationTimeouts,
        convergenceStalls: diagnostics.workerConvergenceStalls,
      });
      // No walk: the getter allocates its six fields and nothing else.
      const source = Object.getOwnPropertyDescriptor(WorldDetailRuntime.prototype, "workerHealth")
        ?.get?.toString() ?? "";
      expect(source).not.toMatch(/for\s*\(|\.values\(\)|\.forEach\(|\.reduce\(/u);
    } finally {
      scene.dispose();
    }
  });
});

describe("inline generation after a worker failure", () => {
  /**
   * The runtime's inline loop, reduced to its budget decisions: each update
   * earns credit once, and cells run while `canGenerateNextDetailCell` and
   * the credit allow. Pure, so the clock is the simulation's.
   */
  function simulate(
    cellMilliseconds: number,
    budget: DetailGenerationBudget,
    cellsWanted: number,
    updates: number,
    limited: boolean,
  ) {
    const credit = createInlineCellCredit(budget);
    let generated = 0;
    let spentMilliseconds = 0;
    let lastCellUpdate = -1;
    for (let update = 0; update < updates; update += 1) {
      const admitted = !limited || admitInlineCellAfterWorkerFailure(credit, budget);
      let inUpdate = 0;
      while (admitted && generated < cellsWanted) {
        if (!canGenerateNextDetailCell(inUpdate, inUpdate * cellMilliseconds, budget)) break;
        if (limited) recordInlineCellAfterWorkerFailure(credit, cellMilliseconds);
        inUpdate += 1;
        generated += 1;
        spentMilliseconds += cellMilliseconds;
        lastCellUpdate = update;
      }
    }
    return { generated, averageMilliseconds: spentMilliseconds / updates, lastCellUpdate };
  }

  const BUDGET = { maximumCells: 8, maximumMilliseconds: 0.75 };

  it("bounds the average main-thread time per update, and still converges", () => {
    // Free first cells: a 6 ms cell every update until all 400 are done.
    const unlimited = simulate(6, BUDGET, 400, 600, false);
    expect(unlimited.averageMilliseconds).toBe(4);
    // On credit: one cell in eight updates, 0.75 ms an update on average.
    const limited = simulate(6, BUDGET, 400, 600, true);
    expect(limited.averageMilliseconds).toBeLessThanOrEqual(1);
    expect(limited.generated).toBeGreaterThan(60);
    const converging = simulate(6, BUDGET, 40, 600, true);
    expect(converging.generated).toBe(40);
    expect(converging.lastCellUpdate).toBeLessThan(400);
  });

  it("keeps cheap cells nearly as fast as before", () => {
    // Eight 0.1 ms cells an update spend a little more than the slice, so
    // the credit holds back about one update in sixteen.
    const limited = simulate(0.1, BUDGET, 400, 600, true);
    const unlimited = simulate(0.1, BUDGET, 400, 600, false);
    expect(limited.generated).toBe(400);
    expect(limited.lastCellUpdate).toBeLessThanOrEqual(Math.ceil(unlimited.lastCellUpdate * 1.1));
  });

  it("applies only after a worker failed, not to a runtime that never had one", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("detail-runtime-worker-respawn-budget");
    const inline = new WorldDetailRuntime(scene, {
      worldSeed: world.seed,
      terrainSample: (x, z) => sampleTerrain(world, x, z),
      cellSizeMeters: CELL,
    });
    const failed = fixture("detail-runtime-worker-respawn-budget", {
      respawnLimit: 0,
      reportWorkerHealth: () => undefined,
    });
    try {
      expect(internals(inline).inlineGenerationLimited).toBe(false);
      failed.settle();
      expect(internals(failed.runtime).inlineGenerationLimited).toBe(false);
      failed.latest().fail();
      expect(internals(failed.runtime).inlineGenerationLimited).toBe(true);
      expect(failed.runtime.workerHealth).toMatchObject({ active: false, respawns: 0, fallbacks: 1 });
    } finally {
      inline.dispose();
      failed.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
