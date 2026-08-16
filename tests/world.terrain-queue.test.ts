import { describe, expect, it } from "vitest";
import { TerrainGenerationClient } from "../src/render/TerrainGenerationClient";
import { isTerrainWorkerEvent } from "../src/workers/terrainProtocol";
import { BoundedTerrainQueue } from "../src/workers/terrainQueue";

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
    const client = new TerrainGenerationClient("stale-quality-result", {
      workerFactory: () => worker as unknown as Worker,
    });
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
});
