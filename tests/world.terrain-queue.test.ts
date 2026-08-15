import { describe, expect, it } from "vitest";
import { isTerrainWorkerEvent } from "../src/workers/terrainProtocol";
import { BoundedTerrainQueue } from "../src/workers/terrainQueue";

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
});
