export interface TerrainQueueEntry<T> {
  readonly id: number;
  readonly priority: number;
  readonly value: T;
}

interface SequencedTerrainQueueEntry<T> extends TerrainQueueEntry<T> {
  readonly sequence: number;
}

export interface TerrainQueueEnqueueResult<T> {
  readonly accepted: boolean;
  /** The least-important entry evicted to preserve the queue bound. */
  readonly dropped: TerrainQueueEntry<T> | null;
}

/**
 * Small bounded priority queue for streamed terrain work. Lower priorities are
 * taken first; equal priorities retain FIFO ordering. Its O(n) selection keeps
 * cancellation simple and is faster than a heap at the intended <=64 entries.
 */
export class BoundedTerrainQueue<T> {
  private readonly entries = new Map<number, SequencedTerrainQueueEntry<T>>();
  private sequence = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Terrain queue capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  enqueue(id: number, priority: number, value: T): TerrainQueueEnqueueResult<T> {
    if (!Number.isInteger(id)) throw new RangeError("Terrain queue ids must be integers");
    if (!Number.isFinite(priority)) throw new RangeError("Terrain queue priority must be finite");
    if (this.entries.has(id)) throw new Error(`Terrain queue already contains id ${id}`);

    const entry: SequencedTerrainQueueEntry<T> = {
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

  take(): TerrainQueueEntry<T> | null {
    let best: SequencedTerrainQueueEntry<T> | null = null;
    for (const entry of this.entries.values()) {
      if (!best || this.compare(entry, best) < 0) best = entry;
    }
    if (!best) return null;
    this.entries.delete(best.id);
    return best;
  }

  remove(id: number): TerrainQueueEntry<T> | null {
    const entry = this.entries.get(id) ?? null;
    if (entry) this.entries.delete(id);
    return entry;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  clear(): TerrainQueueEntry<T>[] {
    const removed = [...this.entries.values()].sort((first, second) =>
      this.compare(first, second),
    );
    this.entries.clear();
    return removed;
  }

  private findWorst(): SequencedTerrainQueueEntry<T> | null {
    let worst: SequencedTerrainQueueEntry<T> | null = null;
    for (const entry of this.entries.values()) {
      if (!worst || this.compare(entry, worst) > 0) worst = entry;
    }
    return worst;
  }

  private compare(
    first: SequencedTerrainQueueEntry<T>,
    second: SequencedTerrainQueueEntry<T>,
  ): number {
    return first.priority - second.priority || first.sequence - second.sequence;
  }
}
