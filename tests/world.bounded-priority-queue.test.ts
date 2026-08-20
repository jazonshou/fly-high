import { describe, expect, it } from "vitest";

/**
 * `4-4` deleted the CPU terrain worker (`TerrainGenerationClient`,
 * `terrain.worker.ts`, `terrainProtocol.ts`) and with it this file's
 * worker-protocol and worker-pool suites — audit root cause #10 closed
 * outright rather than mitigated. What survives is the QUEUE, which
 * `RENDERING_PLAN.md:340` also listed for deletion and which is the
 * vegetation worker's, not terrain's.
 */
import { BoundedPriorityQueue } from "../src/workers/boundedPriorityQueue";
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

describe("bounded priority queue (renamed at 4-4)", () => {
  it("takes nearest work first and preserves FIFO ordering for ties", () => {
    const queue = new BoundedPriorityQueue<string>(6);
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
    const queue = new BoundedPriorityQueue<string>(3);
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
    const queue = new BoundedPriorityQueue<string>(4);
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
