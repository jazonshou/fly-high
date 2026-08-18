import { describe, expect, it } from "vitest";
import { TerrainGenerationClient } from "../src/render/TerrainGenerationClient";
import { isTerrainWorkerEvent } from "../src/workers/terrainProtocol";
import { BoundedTerrainQueue } from "../src/workers/terrainQueue";
import { createWorld } from "../src/world";

class FakeTerrainWorker {
  readonly posted: unknown[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: unknown): void {
    this.posted.push(message);
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

  emitMessage(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event as unknown as Event);
    }
  }
}

describe("bounded terrain priority queue", () => {
  it("takes nearest work first and preserves FIFO ordering for ties", () => {
    const queue = new BoundedTerrainQueue<string>(6);
    queue.enqueue(1, 9, "far");
    queue.enqueue(2, 1, "near-first");
    queue.enqueue(3, 1, "near-second");
    queue.enqueue(4, 4, "middle");

    expect(queue.take()?.value).toBe("near-first");
    expect(queue.take()?.value).toBe("near-second");
    expect(queue.take()?.value).toBe("middle");
    expect(queue.take()?.value).toBe("far");
    expect(queue.take()).toBeNull();
  });

  it("stays bounded and evicts only less-important queued work", () => {
    const queue = new BoundedTerrainQueue<string>(3);
    queue.enqueue(1, 2, "middle");
    queue.enqueue(2, 8, "far");
    queue.enqueue(3, 1, "near");

    const accepted = queue.enqueue(4, 0, "center");
    expect(accepted.accepted).toBe(true);
    expect(accepted.dropped?.value).toBe("far");
    expect(queue.size).toBe(3);

    const rejected = queue.enqueue(5, 99, "beyond-horizon");
    expect(rejected.accepted).toBe(false);
    expect(rejected.dropped?.value).toBe("beyond-horizon");
    expect(queue.size).toBe(3);
    expect([queue.take()?.value, queue.take()?.value, queue.take()?.value]).toEqual([
      "center",
      "near",
      "middle",
    ]);
  });

  it("cancels by id and clears pending work without duplicates", () => {
    const queue = new BoundedTerrainQueue<string>(4);
    queue.enqueue(10, 0, "a");
    queue.enqueue(11, 1, "b");
    expect(() => queue.enqueue(10, 2, "duplicate")).toThrow(/already contains/);
    expect(queue.remove(10)?.value).toBe("a");
    expect(queue.remove(10)).toBeNull();
    expect(queue.has(11)).toBe(true);
    expect(queue.clear().map((entry) => entry.value)).toEqual(["b"]);
    expect(queue.size).toBe(0);
  });
});

describe("terrain worker protocol guard", () => {
  it("accepts tile/error envelopes and rejects malformed messages", () => {
    expect(
      isTerrainWorkerEvent({
        type: "tile",
        requestId: 7,
        generation: 3,
        key: "0:-1",
        tile: {},
      }),
    ).toBe(true);
    expect(
      isTerrainWorkerEvent({
        type: "error",
        requestId: 7,
        generation: 3,
        key: "0:-1",
        message: "failed",
      }),
    ).toBe(true);
    expect(isTerrainWorkerEvent({ type: "tile", requestId: "7", tile: {} })).toBe(false);
    expect(isTerrainWorkerEvent(null)).toBe(false);
  });

  it("ignores an active result canceled by a quality epoch before starting queued work", () => {
    const worker = new FakeTerrainWorker();
    const world = createWorld("stale-quality-result");
    // workerCount 1: this test pins the stale-epoch protocol on a single
    // slot; the 1B-4 pool has its own test below with distinct workers.
    const client = new TerrainGenerationClient(world, {
      workerFactory: () => worker as unknown as Worker,
      workerCount: 1,
    });
    expect((worker.posted[0] as { world?: unknown }).world).toBe(world);
    expect(worker.posted[0]).toEqual({ type: "initialize", world });
    let staleResults = 0;
    let currentResults = 0;
    const tileOptions = {
      tileX: 0,
      tileZ: 0,
      size: 1_600,
      resolution: 25,
      includeNormals: true,
      includeColors: true,
      includeClimate: false,
    } as const;
    const staleId = client.request(
      { key: "near:0:0", generation: 1, priority: 0, options: tileOptions },
      () => { staleResults += 1; },
    );
    client.cancelAll();
    const currentId = client.request(
      { key: "near:0:0", generation: 2, priority: 0, options: tileOptions },
      () => { currentResults += 1; },
    );
    expect(worker.posted.filter(
      (message) => (message as { type?: string }).type === "generate",
    )).toHaveLength(1);

    worker.emitMessage({
      type: "tile",
      requestId: staleId,
      generation: 1,
      key: "near:0:0",
      tile: {},
    });
    expect(staleResults).toBe(0);
    const generates = worker.posted.filter(
      (message) => (message as { type?: string }).type === "generate",
    ) as Array<{ requestId: number }>;
    expect(generates).toHaveLength(2);
    expect(generates[1]?.requestId).toBe(currentId);

    worker.emitMessage({
      type: "tile",
      requestId: currentId,
      generation: 2,
      key: "near:0:0",
      tile: {},
    });
    expect(currentResults).toBe(1);
    client.dispose();
  });

  it("runs one request per worker slot concurrently (1B-4)", () => {
    const workers: FakeTerrainWorker[] = [];
    const world = createWorld("slot-map-pool");
    const client = new TerrainGenerationClient(world, {
      workerFactory: () => {
        const worker = new FakeTerrainWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      workerCount: 3,
    });
    expect(workers).toHaveLength(3);
    expect(client.workerCount).toBe(3);
    for (const worker of workers) {
      expect(worker.posted[0]).toEqual({ type: "initialize", world });
    }

    const options = { tileX: 0, tileZ: 0, size: 512, resolution: 9 } as const;
    const results: number[] = [];
    const ids = [0, 1, 2, 3].map((index) => client.request(
      { key: `page:${index}`, generation: 1, priority: index, options },
      () => { results.push(index); },
    ));
    // Three slots fill immediately; the fourth request waits in the queue.
    expect(client.busyWorkerCount).toBe(3);
    expect(client.queuedCount).toBe(1);
    const generatesOn = (worker: FakeTerrainWorker) => worker.posted.filter(
      (message) => (message as { type?: string }).type === "generate",
    ) as Array<{ requestId: number; key: string }>;
    expect(generatesOn(workers[0]!)).toHaveLength(1);
    expect(generatesOn(workers[1]!)).toHaveLength(1);
    expect(generatesOn(workers[2]!)).toHaveLength(1);

    // A finishing slot immediately picks up the queued request.
    workers[1]!.emitMessage({
      type: "tile", requestId: ids[1], generation: 1, key: "page:1", tile: {},
    });
    expect(results).toEqual([1]);
    expect(client.busyWorkerCount).toBe(3);
    expect(client.queuedCount).toBe(0);
    expect(generatesOn(workers[1]!)).toHaveLength(2);
    expect(generatesOn(workers[1]!)[1]?.requestId).toBe(ids[3]);
    client.dispose();
  });

  it("clamps the worker pool to hardware concurrency minus four (1B-4)", async () => {
    const { resolveTerrainWorkerCount } = await import("../src/render/TerrainGenerationClient");
    expect(resolveTerrainWorkerCount(10)).toBe(6);
    expect(resolveTerrainWorkerCount(8)).toBe(4);
    expect(resolveTerrainWorkerCount(4)).toBe(2);
    expect(resolveTerrainWorkerCount(2)).toBe(2);
    expect(resolveTerrainWorkerCount(32)).toBe(6);
    expect(resolveTerrainWorkerCount(Number.NaN)).toBe(2);
  });
});
