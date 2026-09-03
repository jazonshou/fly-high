import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { createWorld, sampleTerrain, TerrainBiome } from "../src/world";
import { DetailGenerationClient } from "../src/render/webgpu/detail/DetailGenerationClient";
import { detailCellKey, generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  DetailInstanceBounds,
  DetailInstanceWriter,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  buildPresentationChunk,
  detailTreeCanopyRankOrder,
  type DetailPresentationBuildCatalog,
} from "../src/render/webgpu/detail/presentationBuild";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  detailWorkerEventTransferables,
  isDetailWorkerEvent,
  type DetailRetainedCellDescriptor,
  type DetailWorkerCommand,
  type DetailWorkerEvent,
} from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import type { DetailTerrainSample } from "../src/render/webgpu/detail/types";

/**
 * 1B-10 — the detail worker offload. The client mirrors the terrain
 * scheduler's contract (bounded priority queue, -1-alone rejection, stale
 * epoch drop); the fake worker echoes real generateDetailCell output so the
 * async path applies byte-identical cells to the inline path.
 */

class FakeDetailWorker {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly commands: DetailWorkerCommand[] = [];
  readonly transfers: Transferable[][] = [];

  postMessage(message: DetailWorkerCommand, transfer: Transferable[] = []): void {
    this.commands.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  emit(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data } as unknown as Event);
    }
  }
}

class ManualMacrotasks {
  readonly callbacks: Array<() => void> = [];

  readonly schedule = (callback: () => void): void => {
    this.callbacks.push(callback);
  };

  flushAll(limit = 10_000): void {
    let executed = 0;
    while (this.callbacks.length > 0) {
      if (executed >= limit) throw new Error("Manual worker scheduler did not settle");
      this.callbacks.shift()!();
      executed += 1;
    }
  }
}

function retainedDescriptor(token: number, key: string): DetailRetainedCellDescriptor {
  return {
    token,
    key,
    cellX: 0,
    cellZ: 0,
    cellSizeMeters: 128,
    minX: 0,
    minZ: 0,
    maxX: 128,
    maxZ: 128,
    counts: { trees: 0, shrubs: 0, rocks: 0, clutter: 0, groundCover: 0 },
  };
}

const PRESENTATION_INPUT = {
  residents: [{ token: 1, lod: "near" as const, distance: 0 }],
  floatingOrigin: { x: 0, y: 0, z: 0 },
  densityLaw: resolveWebGpuQualityProfile("medium", "balanced").renderedDensityLaw,
  treeVariantCap: 1,
  treePrototypeMode: "families" as const,
  grassRadiusMeters: 1,
  observerX: 64,
  observerZ: 64,
};

const forestSample = (): DetailTerrainSample => ({
  height: 220,
  slope: 0.05,
  moisture: 0.68,
  biome: TerrainBiome.FOREST,
});

describe("detail generation client (1B-10)", () => {
  it("transfers macro and final L0 authority publications to the worker", () => {
    const worker = new FakeDetailWorker();
    const world = createWorld("detail-evolved-authority", {
      airport: false,
      worldEvolution: "eroded",
    });
    const client = new DetailGenerationClient({
      worldSeed: world.seed,
      world,
      cellSizeMeters: 128,
      seaLevelMeters: world.seaLevel,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(worker.commands[0]).toMatchObject({ type: "initialize", world });
    const macroHeights = new Float32Array([10, 20, 30, 40]);
    const pageHeights = new Float32Array(256 * 256).fill(321);
    const shoreDistance = new Int16Array(136 * 136).fill(24);
    const soilDepth = new Uint8Array(136 * 136).fill(96);
    expect(client.publishTerrainMacro({
      originX: 0,
      originZ: 0,
      texelSizeMeters: 512,
      width: 2,
      height: 2,
      heights: macroHeights,
    })).toBe(true);
    expect(client.publishTerrainPage({
      level: 0,
      tileX: 2,
      tileZ: -3,
      heights: pageHeights,
    })).toBe(true);
    expect(client.publishTerrainAuxPage({
      level: 0,
      tileX: 2,
      tileZ: -3,
      coreSize: 128,
      gutter: 4,
      storedEdge: 136,
      texelSizeMeters: 4,
      shoreDistanceMetersPerUnit: 0.25,
      soilDepthMetersPerUnit: 8 / 255,
      shoreDistanceR16Sint: shoreDistance,
      soilDepthR8Unorm: soilDepth,
    })).toBe(true);

    expect(worker.commands.slice(1).map((command) => command.type)).toEqual([
      "terrainMacro",
      "terrainPage",
      "terrainAux",
    ]);
    expect(worker.transfers[1]).toEqual([macroHeights.buffer]);
    expect(worker.transfers[2]).toEqual([pageHeights.buffer]);
    // 6-6: both ecology channels transfer with the aux page, never copy.
    expect(worker.transfers[3]).toEqual([shoreDistance.buffer, soilDepth.buffer]);
    client.dispose();
  });

  it("fails closed when a live generation request returns the wrong identity", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const client = new DetailGenerationClient({
      worldSeed: "detail-client",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    expect(worker.commands[0]).toMatchObject({ type: "initialize", worldSeed: "detail-client" });

    const results: string[] = [];
    const errors: string[] = [];
    const request = (key: string, priority: number, generation = 1) => client.request(
      { key, generation, priority, cellX: 0, cellZ: 0, densityMultiplier: 1, dayOfYear: 0 },
      () => { results.push(key); },
      () => { errors.push(key); },
    );
    const first = request("cell:a", 5);
    const second = request("cell:b", 1);
    expect(client.busy).toBe(true);
    // First request dispatched immediately; the better-priority newcomer waits.
    expect(worker.commands.filter((c) => c.type === "generate")).toHaveLength(1);
    expect(second).toBeGreaterThan(0);

    // This request still exists, so a wrong epoch is authority corruption,
    // not an ordinary canceled/late response.
    worker.emit({ type: "cell", requestId: first, generation: 2, key: "cell:a", cell: {} });
    expect(results).toEqual([]);
    expect(errors.sort()).toEqual(["cell:a", "cell:b"]);
    expect(unavailable).toBe(1);
    expect(client.isAvailable).toBe(false);
    expect(client.busy).toBe(false);
    expect(client.queuedCount).toBe(0);
    // The queued request must not dispatch through a corrupted authority.
    const generates = worker.commands.filter((c) => c.type === "generate");
    expect(generates).toHaveLength(1);
  });

  it("fails closed when the worker answers a queued request that was never dispatched", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const errors: string[] = [];
    const client = new DetailGenerationClient({
      worldSeed: "detail-undispatched-result",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    const request = (key: string, priority: number) => client.requestRetained(
      {
        key,
        generation: 1,
        priority,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
      (error) => errors.push(error.message),
    );
    request("0:0", 5);
    const queued = request("1:0", 1);
    expect(worker.commands.filter((command) => command.type === "generate"))
      .toHaveLength(1);

    worker.emit({
      type: "retainedCell",
      requestId: queued,
      generation: 1,
      key: "1:0",
      cell: retainedDescriptor(91, "1:0"),
    });

    expect(unavailable).toBe(1);
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("became unavailable"))).toBe(true);
    expect(client.isAvailable).toBe(false);
    expect(client.busy).toBe(false);
    expect(client.queuedCount).toBe(0);
    expect(client.retainedCellCount).toBe(0);
    // The queued id was never posted, and terminating the authority prevents
    // it from being dispatched after the spoofed result.
    expect(worker.commands.filter((command) => command.type === "generate"))
      .toHaveLength(1);
  });

  it("retains accepted cells and releases stale, canceled, and explicit ownership", () => {
    const worker = new FakeDetailWorker();
    const presentationCatalog = {} as DetailPresentationBuildCatalog;
    const client = new DetailGenerationClient({
      worldSeed: "detail-retained-client",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      presentationCatalog,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(worker.commands[0]).toMatchObject({
      type: "initialize",
      presentationCatalog,
    });

    const accepted: DetailRetainedCellDescriptor[] = [];
    const first = client.requestRetained(
      {
        key: "0:0",
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      (cell) => accepted.push(cell),
    );
    expect(worker.commands.at(-1)).toMatchObject({
      type: "generate",
      requestId: first,
      retain: true,
    });
    client.cancel(first);
    worker.emit({
      type: "retainedCell",
      requestId: first,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(41, "0:0"),
    });
    expect(accepted).toEqual([]);
    expect(worker.commands.at(-1)).toEqual({ type: "releaseCell", token: 41 });

    const second = client.requestRetained(
      {
        key: "0:0",
        generation: 2,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      (cell) => accepted.push(cell),
    );
    worker.emit({
      type: "retainedCell",
      requestId: second,
      generation: 2,
      key: "0:0",
      cell: retainedDescriptor(42, "0:0"),
    });
    expect(accepted.map((cell) => cell.token)).toEqual([42]);
    expect(client.retainedCellCount).toBe(1);
    expect(client.releaseCell(accepted[0]!)).toBe(true);
    expect(client.releaseCell(accepted[0]!)).toBe(false);
    expect(worker.commands.at(-1)).toEqual({ type: "releaseCell", token: 42 });
    client.dispose();
  });

  it("fails closed when a matching retained result aliases an owned token", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const errors: string[] = [];
    const client = new DetailGenerationClient({
      worldSeed: "detail-duplicate-retained-token",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    const request = (key: string, onError: (error: Error) => void = () => undefined) =>
      client.requestRetained(
        {
          key,
          generation: 1,
          priority: 0,
          cellX: 0,
          cellZ: 0,
          densityMultiplier: 1,
          dayOfYear: 0,
        },
        () => undefined,
        onError,
      );
    const first = request("0:0");
    worker.emit({
      type: "retainedCell",
      requestId: first,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(77, "0:0"),
    });
    expect(client.retainedCellCount).toBe(1);

    const second = request("1:0", (error) => errors.push(error.message));
    worker.emit({
      type: "retainedCell",
      requestId: second,
      generation: 1,
      key: "1:0",
      cell: retainedDescriptor(77, "1:0"),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("became unavailable");
    expect(unavailable).toBe(1);
    expect(client.isAvailable).toBe(false);
    expect(client.retainedCellCount).toBe(0);
    expect(client.busy).toBe(false);
    expect(client.queuedCount).toBe(0);
    // A release command would ambiguously release the first resident's token;
    // worker termination is the atomic cleanup for both aliases.
    expect(worker.commands.filter(
      (command) => command.type === "releaseCell" && command.token === 77,
    )).toHaveLength(0);
  });

  it("fails closed when a matching request returns the wrong ownership mode", () => {
    const worker = new FakeDetailWorker();
    const errors: string[] = [];
    const client = new DetailGenerationClient({
      worldSeed: "detail-result-kind-mismatch",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    });
    const requestId = client.requestRetained(
      {
        key: "0:0",
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
      (error) => errors.push(error.message),
    );
    worker.emit({
      type: "cell",
      requestId,
      generation: 1,
      key: "0:0",
      cell: {},
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("became unavailable");
    expect(client.isAvailable).toBe(false);
    expect(client.busy).toBe(false);
  });

  it("rejects malformed events and exposes exact presentation transfer lists", () => {
    const statistics = {
      nearCells: 1,
      midCells: 0,
      treeInstances: 1,
      shrubInstances: 0,
      rockInstances: 0,
      clutterInstances: 0,
      groundCoverInstances: 0,
    };
    const malformed = {
      type: "presentation",
      buildId: 1,
      batches: [{
        prototypeKey: "tree-oak",
        count: 1,
        bytes: new Uint8Array(31),
        minimum: [0, 0, 0],
        maximum: [1, 1, 1],
      }],
      statistics,
    };
    expect(isDetailWorkerEvent(malformed)).toBe(false);
    expect(isDetailWorkerEvent({
      type: "retainedCell",
      requestId: 1,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(1, "different-key"),
    })).toBe(false);
    expect(isDetailWorkerEvent({
      type: "retainedCell",
      requestId: 1,
      generation: 1,
      key: "0:0",
      cell: { ...retainedDescriptor(1, "0:0"), minX: 129 },
    })).toBe(false);
    expect(isDetailWorkerEvent({
      ...malformed,
      batches: [{ ...malformed.batches[0], prototypeKey: "", bytes: new Uint8Array(32) }],
    })).toBe(false);
    expect(isDetailWorkerEvent({
      ...malformed,
      batches: [{
        ...malformed.batches[0],
        bytes: new Uint8Array(32),
        minimum: [2, 0, 0],
        maximum: [1, 1, 1],
      }],
    })).toBe(false);

    const bytes = new Uint8Array(32);
    const valid: DetailWorkerEvent = {
      type: "presentation",
      buildId: 1,
      batches: [{
        prototypeKey: "tree-oak",
        count: 1,
        bytes,
        minimum: [0, 0, 0],
        maximum: [1, 1, 1],
      }],
      statistics,
    };
    expect(isDetailWorkerEvent(valid)).toBe(true);
    expect(detailWorkerEventTransferables(valid)).toEqual([bytes.buffer]);
  });

  it("fails closed and clears the generation queue on a malformed retained-cell event", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const errors: string[] = [];
    const client = new DetailGenerationClient({
      worldSeed: "detail-malformed-retained",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    const request = (key: string) => client.requestRetained(
      {
        key,
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
      (error) => errors.push(error.message),
    );
    const active = request("0:0");
    request("1:0");
    expect(client.busy).toBe(true);
    expect(client.queuedCount).toBe(1);

    worker.emit({
      type: "retainedCell",
      requestId: active,
      generation: 1,
      key: "0:0",
      // Invalid ordered extent: the dedicated-worker protocol guard rejects it.
      cell: { ...retainedDescriptor(7, "0:0"), minX: 129 },
    });
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("became unavailable"))).toBe(true);
    expect(unavailable).toBe(1);
    expect(client.isAvailable).toBe(false);
    expect(client.busy).toBe(false);
    expect(client.queuedCount).toBe(0);
    expect(client.retainedCellCount).toBe(0);
  });

  it("fails closed and clears ownership on a malformed presentation event", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const errors: string[] = [];
    const client = new DetailGenerationClient({
      worldSeed: "detail-malformed-presentation",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      presentationCatalog: {} as DetailPresentationBuildCatalog,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    const retainedRequest = client.requestRetained(
      {
        key: "0:0",
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
    );
    worker.emit({
      type: "retainedCell",
      requestId: retainedRequest,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(1, "0:0"),
    });
    const buildId = client.requestPresentation(
      PRESENTATION_INPUT,
      () => undefined,
      (error) => errors.push(error.message),
    );
    expect(client.presentationBusy).toBe(true);
    expect(client.retainedCellCount).toBe(1);

    worker.emit({
      type: "presentation",
      buildId,
      batches: [{
        prototypeKey: "tree-oak",
        count: 1,
        bytes: new Uint8Array(31),
        minimum: [0, 0, 0],
        maximum: [1, 1, 1],
      }],
      statistics: {
        nearCells: 1,
        midCells: 0,
        treeInstances: 1,
        shrubInstances: 0,
        rockInstances: 0,
        clutterInstances: 0,
        groundCoverInstances: 0,
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("became unavailable");
    expect(unavailable).toBe(1);
    expect(client.isAvailable).toBe(false);
    expect(client.presentationBusy).toBe(false);
    expect(client.retainedCellCount).toBe(0);
    expect(client.busy).toBe(false);
    expect(client.queuedCount).toBe(0);
  });

  it("cancels presentation builds and drops late transferable results", () => {
    const worker = new FakeDetailWorker();
    const client = new DetailGenerationClient({
      worldSeed: "detail-presentation-cancel",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      presentationCatalog: {} as DetailPresentationBuildCatalog,
      workerFactory: () => worker as unknown as Worker,
    });
    const retainedRequest = client.requestRetained(
      {
        key: "0:0",
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
    );
    worker.emit({
      type: "retainedCell",
      requestId: retainedRequest,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(1, "0:0"),
    });

    const results: number[] = [];
    const buildId = client.requestPresentation(
      PRESENTATION_INPUT,
      (result) => results.push(result.buildId),
    );
    expect(buildId).toBeGreaterThan(0);
    expect(client.presentationBusy).toBe(true);
    client.cancelPresentation(buildId);
    expect(client.presentationBusy).toBe(false);
    expect(worker.commands.at(-1)).toEqual({ type: "cancelPresentation", buildId });
    worker.emit({
      type: "presentation",
      buildId,
      batches: [],
      statistics: {
        nearCells: 0,
        midCells: 0,
        treeInstances: 0,
        shrubInstances: 0,
        rockInstances: 0,
        clutterInstances: 0,
        groundCoverInstances: 0,
      },
    });
    expect(results).toEqual([]);
    client.dispose();
  });

  it("fails both generation and presentation callbacks when the worker dies", () => {
    const worker = new FakeDetailWorker();
    let unavailable = 0;
    const client = new DetailGenerationClient({
      worldSeed: "detail-worker-failure-callbacks",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      presentationCatalog: {} as DetailPresentationBuildCatalog,
      workerFactory: () => worker as unknown as Worker,
    }, () => { unavailable += 1; });
    const first = client.requestRetained(
      {
        key: "0:0",
        generation: 1,
        priority: 0,
        cellX: 0,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
    );
    worker.emit({
      type: "retainedCell",
      requestId: first,
      generation: 1,
      key: "0:0",
      cell: retainedDescriptor(1, "0:0"),
    });
    const errors: string[] = [];
    client.requestRetained(
      {
        key: "1:0",
        generation: 1,
        priority: 0,
        cellX: 1,
        cellZ: 0,
        densityMultiplier: 1,
        dayOfYear: 0,
      },
      () => undefined,
      (error) => errors.push(`generation:${error.message}`),
    );
    client.requestPresentation(
      PRESENTATION_INPUT,
      () => undefined,
      (error) => errors.push(`presentation:${error.message}`),
    );
    for (const listener of worker.listeners.get("error") ?? []) {
      listener({ preventDefault: () => undefined } as unknown as Event);
    }
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("became unavailable"))).toBe(true);
    expect(unavailable).toBe(1);
    expect(client.isAvailable).toBe(false);
    expect(client.retainedCellCount).toBe(0);
  });

  it("keeps unique worker cell tokens and builds exact transferable presentation batches", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const catalogRuntime = new WorldDetailRuntime(scene, {
      worldSeed: "detail-worker-presentation-catalog",
      terrainSample: forestSample,
      cellSizeMeters: 128,
    });
    const catalog = (catalogRuntime as unknown as {
      readonly presentationBuildCatalog: DetailPresentationBuildCatalog;
    }).presentationBuildCatalog;
    const world = createWorld("detail-worker-presentation-exact", { airport: false });
    const macrotasks = new ManualMacrotasks();
    const posted: Array<{ event: DetailWorkerEvent; transfers: Transferable[] }> = [];
    const worker = new DetailWorkerRuntime(
      (event, transfers) => posted.push({ event, transfers }),
      macrotasks.schedule,
    );
    const key = detailCellKey(0, 0);
    const generateRetained = (requestId: number): void => worker.handleCommand({
      type: "generate",
      requestId,
      generation: 1,
      key,
      cellX: 0,
      cellZ: 0,
      densityMultiplier: 0.35,
      dayOfYear: 171,
      retain: true,
    });

    try {
      worker.handleCommand({
        type: "initialize",
        worldSeed: world.seed,
        world,
        cellSizeMeters: 128,
        seaLevelMeters: world.seaLevel,
        presentationCatalog: catalog,
      });
      generateRetained(1);
      const firstEvent = posted.at(-1)?.event;
      if (firstEvent?.type !== "retainedCell") throw new Error("Missing retained cell event");
      const firstToken = firstEvent.cell.token;
      expect(worker.retainedCellCount).toBe(1);
      worker.handleCommand({ type: "releaseCell", token: firstToken });
      expect(worker.retainedCellCount).toBe(0);

      generateRetained(2);
      const secondEvent = posted.at(-1)?.event;
      if (secondEvent?.type !== "retainedCell") throw new Error("Missing second cell event");
      const secondToken = secondEvent.cell.token;
      expect(secondToken).toBeGreaterThan(firstToken);
      expect(secondToken).not.toBe(firstToken);

      const profile = resolveWebGpuQualityProfile("medium", "balanced");
      const input = {
        residents: [{ token: secondToken, lod: "near" as const, distance: 0 }],
        floatingOrigin: { x: 0, y: 0, z: 0 },
        densityLaw: profile.renderedDensityLaw,
        treeVariantCap: profile.treeVariantCap,
        treePrototypeMode: profile.treePrototypeMode,
        grassRadiusMeters: 1,
        observerX: 64,
        observerZ: 64,
      };
      worker.handleCommand({ type: "buildPresentation", buildId: 7, input });
      expect(worker.activePresentationBuildCount).toBe(1);
      expect(posted.some(({ event }) => event.type === "presentation" && event.buildId === 7))
        .toBe(false);
      macrotasks.flushAll();
      expect(worker.activePresentationBuildCount).toBe(0);
      const workerPost = posted.find(
        ({ event }) => event.type === "presentation" && event.buildId === 7,
      );
      if (workerPost?.event.type !== "presentation") {
        throw new Error("Missing presentation result");
      }
      expect(isDetailWorkerEvent(workerPost.event)).toBe(true);
      expect(workerPost.transfers).toEqual(
        workerPost.event.batches.map((batch) => batch.bytes.buffer),
      );
      for (const batch of workerPost.event.batches) {
        expect(batch.bytes.byteLength).toBe(batch.count * 32);
      }

      const cell = generateDetailCell({
        worldSeed: world.seed,
        cellX: 0,
        cellZ: 0,
        cellSizeMeters: 128,
        densityMultiplier: 0.35,
        terrainSample: (x, z) => sampleTerrain(world, x, z),
        seaLevelMeters: world.seaLevel,
        dayOfYear: 171,
        latitudeDegrees: world.latitudeDegrees,
      });
      const inlineBatches = new Map<string, {
        readonly writer: DetailInstanceWriter;
        readonly bounds: DetailInstanceBounds;
      }>();
      const inlineIterator = buildPresentationChunk(
        {
          ...input,
          residents: [{
            cell,
            treeCanopyRank: detailTreeCanopyRankOrder(cell.trees),
            lod: "near",
            distance: 0,
          }],
        },
        catalog,
        {
          appendInstance: (prototypeKey, record, billboardFrame) => {
            let batch = inlineBatches.get(prototypeKey);
            if (!batch) {
              batch = {
                writer: new DetailInstanceWriter(),
                bounds: new DetailInstanceBounds(),
              };
              inlineBatches.set(prototypeKey, batch);
            }
            batch.writer.pushBounded(
              record,
              batch.bounds,
              catalog.prototypes[prototypeKey]!.boundKernel,
              billboardFrame,
            );
          },
        },
      );
      let inlineStatistics;
      while (true) {
        const result = inlineIterator.next();
        if (result.done) {
          inlineStatistics = result.value;
          break;
        }
      }
      expect(workerPost.event.statistics).toEqual(inlineStatistics);
      expect(workerPost.event.batches.map((batch) => batch.prototypeKey))
        .toEqual([...inlineBatches.keys()]);
      for (const workerBatch of workerPost.event.batches) {
        const inline = inlineBatches.get(workerBatch.prototypeKey)!;
        expect(workerBatch.count).toBe(inline.writer.count);
        expect(workerBatch.bytes).toEqual(inline.writer.finish());
        expect(workerBatch.minimum).toEqual(inline.bounds.minimum());
        expect(workerBatch.maximum).toEqual(inline.bounds.maximum());
      }

      worker.handleCommand({ type: "buildPresentation", buildId: 8, input });
      expect(worker.activePresentationBuildCount).toBe(1);
      generateRetained(3);
      expect(posted.at(-1)?.event).toMatchObject({
        type: "retainedCell",
        requestId: 3,
      });
      expect(posted.some(({ event }) => event.type === "presentation" && event.buildId === 8))
        .toBe(false);
      worker.handleCommand({ type: "cancelPresentation", buildId: 8 });
      expect(worker.activePresentationBuildCount).toBe(0);
      macrotasks.flushAll();
      expect(posted.some(({ event }) => event.type === "presentation" && event.buildId === 8))
        .toBe(false);
    } finally {
      catalogRuntime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("falls back to inline generation when the worker dies", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const worker = new FakeDetailWorker();
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: "worker-fallback",
      terrainSample: forestSample,
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerWorldSeed: "worker-fallback",
    });
    (runtime as unknown as { client: DetailGenerationClient | null }).client?.dispose();
    const client = new DetailGenerationClient({
      worldSeed: "worker-fallback",
      cellSizeMeters: 128,
      seaLevelMeters: 0,
      workerFactory: () => worker as unknown as Worker,
    }, () => {
      (runtime as unknown as { client: DetailGenerationClient | null }).client = null;
    });
    (runtime as unknown as { client: DetailGenerationClient }).client = client;

    const profile = {
      ...resolveWebGpuQualityProfile("medium", "balanced"),
      vegetationDistance: 300,
      vegetationDensity: 1,
    };
    runtime.update({ x: 64, y: 100, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
    // The worker dies; the unavailability callback clears the client and the
    // next updates generate inline.
    for (const listener of worker.listeners.get("error") ?? []) {
      listener({ preventDefault: () => undefined } as unknown as Event);
    }
    for (let round = 0; round < 16 && runtime.statistics.residentCells === 0; round += 1) {
      runtime.update({ x: 64, y: 100, z: 64 }, { x: 0, y: 0, z: 0 }, profile);
    }
    expect(runtime.statistics.residentCells).toBeGreaterThan(0);

    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });
});
