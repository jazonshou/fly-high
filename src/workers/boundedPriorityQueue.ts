export interface BoundedQueueEntry<T> {
  readonly id: number;
  readonly priority: number;
  readonly value: T;
}

interface SequencedBoundedQueueEntry<T> extends BoundedQueueEntry<T> {
  readonly sequence: number;
}

export interface BoundedQueueEnqueueResult<T> {
  readonly accepted: boolean;
  /** The least-important entry evicted to preserve the queue bound. */
  readonly dropped: BoundedQueueEntry<T> | null;
}

/**
 * Small bounded priority queue for streamed generation work. Lower priorities
 * are taken first; equal priorities retain FIFO ordering. Its O(n) selection
 * keeps cancellation simple and is faster than a heap at the intended <=64
 * entries.
 *
 * **Renamed from `BoundedTerrainQueue` at `4-4`, and the rename is the point.**
 * `RENDERING_PLAN.md:340` lists `terrainQueue.ts` among the files `4-4`
 * deletes with the CPU terrain worker. It is not a terrain file: it is the
 * VEGETATION worker's queue (`DetailGenerationClient` is its only consumer),
 * and deleting it on the strength of its name would have broken vegetation
 * generation. It now has a name that says what it is, and an owner row under
 * vegetation.
 */
export class BoundedPriorityQueue<T> {
  private readonly entries = new Map<number, SequencedBoundedQueueEntry<T>>();
  private sequence = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Terrain queue capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  enqueue(id: number, priority: number, value: T): BoundedQueueEnqueueResult<T> {
    if (!Number.isInteger(id)) throw new RangeError("Terrain queue ids must be integers");
    if (!Number.isFinite(priority)) throw new RangeError("Terrain queue priority must be finite");
    if (this.entries.has(id)) throw new Error(`Terrain queue already contains id ${id}`);

    const entry: SequencedBoundedQueueEntry<T> = {
      id,
      priority,
      value,
      sequence: this.sequence,
    };
    this.sequence += 1;

    if (this.entries.size < this.capacity) {
      this.entries.set(id, entry);
      return { accepted: true, dropped: null };
    }

    const worst = this.findWorst();
    if (!worst || this.compare(entry, worst) >= 0) {
      return { accepted: false, dropped: entry };
    }
    this.entries.delete(worst.id);
    this.entries.set(id, entry);
    return { accepted: true, dropped: worst };
  }

  take(): BoundedQueueEntry<T> | null {
    let best: SequencedBoundedQueueEntry<T> | null = null;
    for (const entry of this.entries.values()) {
      if (!best || this.compare(entry, best) < 0) best = entry;
    }
    if (!best) return null;
    this.entries.delete(best.id);
    return best;
  }

  remove(id: number): BoundedQueueEntry<T> | null {
    const entry = this.entries.get(id) ?? null;
    if (entry) this.entries.delete(id);
    return entry;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  clear(): BoundedQueueEntry<T>[] {
    const removed = [...this.entries.values()].sort((first, second) =>
      this.compare(first, second),
    );
    this.entries.clear();
    return removed;
  }

  private findWorst(): SequencedBoundedQueueEntry<T> | null {
    let worst: SequencedBoundedQueueEntry<T> | null = null;
    for (const entry of this.entries.values()) {
      if (!worst || this.compare(entry, worst) > 0) worst = entry;
    }
    return worst;
  }

  private compare(
    first: SequencedBoundedQueueEntry<T>,
    second: SequencedBoundedQueueEntry<T>,
  ): number {
    return first.priority - second.priority || first.sequence - second.sequence;
  }
}
