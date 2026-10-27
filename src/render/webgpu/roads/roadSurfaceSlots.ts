import type { RoadSurfaceArrays } from "./roadSurfaceGeometry";

/**
 * One layer's drawn chunks as SLOTS in fixed-capacity arrays, pure so Node
 * asserts it; `RoadSurfaceSystem` uploads what each change wrote and draws
 * the whole as one mesh.
 *
 * A chunk entering reach is written into free ranges of the vertex and index
 * arrays, and a chunk leaving it gives its ranges back with its indices
 * zeroed: a triangle (0, 0, 0) has no area, so whatever is drawn over a
 * freed range draws nothing. Nothing else moves, so a camera crossing a chunk
 * edge writes the row of chunks it brings into reach and nothing more, and
 * the upload is those ranges, not the layer.
 *
 * Positions stay as each chunk built them, relative to its own corner, and
 * every vertex carries its chunk (`chunk`, cx and cz): the vertex stage adds
 * the chunk's offset from the anchor, so moving the anchor is a uniform.
 *
 * Ranges are taken first fit from the free ones (kept sorted and coalesced),
 * else from the end; the end comes back over a freed tail, so the drawn index
 * count is the live chunks' and the holes between them. A layer whose chunks
 * outgrow the arrays doubles them (`grew`: the buffers are made again).
 */

/** Floats per vertex of each array. */
export const ROAD_SURFACE_SLOT_FLOATS = Object.freeze({ position: 3, normal: 3, surface: 4, chunk: 2 });

/** One chunk drawn from a layer's arrays. */
export interface RoadSurfaceSlot {
  readonly key: string;
  /** The index's stamp for the chunk when it was written (`RoadSurfaceIndex.chunkStamp`). */
  readonly stamp: number;
  readonly cx: number;
  readonly cz: number;
  readonly vertexStart: number;
  readonly vertexCount: number;
  readonly indexStart: number;
  readonly indexCount: number;
  /** Bounds of its design positions, relative to its chunk's corner (a rail's y is its height above the ground). */
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export interface RoadSurfaceRange {
  readonly start: number;
  readonly count: number;
}

/** What changed since the last `takeWrites`, in vertices and in indices. */
export interface RoadSurfaceWrites {
  /** The arrays were made larger: upload them whole. */
  readonly grew: boolean;
  readonly vertices: readonly RoadSurfaceRange[];
  readonly indices: readonly RoadSurfaceRange[];
}

/** First fit over free ranges kept sorted by start and coalesced; the end comes back over a freed tail. */
class RangeAllocator {
  end = 0;
  private readonly free: { start: number; count: number }[] = [];

  constructor(public capacity: number) {}

  allocate(count: number): number | null {
    for (let index = 0; index < this.free.length; index += 1) {
      const range = this.free[index]!;
      if (range.count < count) continue;
      const start = range.start;
      range.start += count;
      range.count -= count;
      if (range.count === 0) this.free.splice(index, 1);
      return start;
    }
    if (this.end + count > this.capacity) return null;
    const start = this.end;
    this.end += count;
    return start;
  }

  release(start: number, count: number): void {
    if (count === 0) return;
    let index = 0;
    while (index < this.free.length && this.free[index]!.start < start) index += 1;
    this.free.splice(index, 0, { start, count });
    // Coalesce with the next, then with the previous.
    const next = this.free[index + 1];
    if (next && start + count === next.start) {
      this.free[index]!.count += next.count;
      this.free.splice(index + 1, 1);
    }
    const previous = this.free[index - 1];
    if (previous && previous.start + previous.count === start) {
      previous.count += this.free[index]!.count;
      this.free.splice(index, 1);
    }
    const last = this.free[this.free.length - 1];
    if (last && last.start + last.count === this.end) {
      this.end = last.start;
      this.free.pop();
    }
  }

  /** Free ranges (observation only). */
  get holes(): number {
    return this.free.length;
  }
}

export class RoadSurfaceSlots {
  positions: Float32Array;
  normals: Float32Array;
  surface: Float32Array;
  chunk: Float32Array;
  indices: Uint32Array;
  private readonly vertexRanges: RangeAllocator;
  private readonly indexRanges: RangeAllocator;
  private readonly slots = new Map<string, RoadSurfaceSlot>();
  private grew = false;
  private vertexWrites: RoadSurfaceRange[] = [];
  private indexWrites: RoadSurfaceRange[] = [];
  private liveVertices = 0;
  private liveIndices = 0;

  constructor(vertexCapacity = 4_096, indexCapacity = 3 * vertexCapacity) {
    this.vertexRanges = new RangeAllocator(vertexCapacity);
    this.indexRanges = new RangeAllocator(indexCapacity);
    this.positions = new Float32Array(vertexCapacity * ROAD_SURFACE_SLOT_FLOATS.position);
    this.normals = new Float32Array(vertexCapacity * ROAD_SURFACE_SLOT_FLOATS.normal);
    this.surface = new Float32Array(vertexCapacity * ROAD_SURFACE_SLOT_FLOATS.surface);
    this.chunk = new Float32Array(vertexCapacity * ROAD_SURFACE_SLOT_FLOATS.chunk);
    this.indices = new Uint32Array(indexCapacity);
  }

  get vertexCapacity(): number {
    return this.vertexRanges.capacity;
  }

  get indexCapacity(): number {
    return this.indexRanges.capacity;
  }

  /** Indices to draw: every live slot's, and the zeroed holes between them. */
  get indexEnd(): number {
    return this.indexRanges.end;
  }

  get vertexEnd(): number {
    return this.vertexRanges.end;
  }

  /** Vertices and indices of the live slots. */
  get vertexCount(): number {
    return this.liveVertices;
  }

  get indexCount(): number {
    return this.liveIndices;
  }

  get size(): number {
    return this.slots.size;
  }

  /** Free ranges between the live slots (observation only). */
  get holes(): { readonly vertices: number; readonly indices: number } {
    return { vertices: this.vertexRanges.holes, indices: this.indexRanges.holes };
  }

  slot(key: string): RoadSurfaceSlot | undefined {
    return this.slots.get(key);
  }

  keys(): IterableIterator<string> {
    return this.slots.keys();
  }

  values(): IterableIterator<RoadSurfaceSlot> {
    return this.slots.values();
  }

  /**
   * Write a chunk's arrays into free ranges, in place of its slot if it had
   * one: both writes reach the buffers before the next draw, so the chunk is
   * never missing from it.
   */
  write(key: string, stamp: number, cx: number, cz: number, arrays: RoadSurfaceArrays): RoadSurfaceSlot {
    this.release(key);
    const vertexCount = arrays.vertexCount;
    const indexCount = arrays.indices.length;
    let vertexStart = this.vertexRanges.allocate(vertexCount);
    let indexStart = this.indexRanges.allocate(indexCount);
    if (vertexStart === null || indexStart === null) {
      // Give back what was taken, grow, and take again from the larger arrays.
      if (vertexStart !== null) this.vertexRanges.release(vertexStart, vertexCount);
      if (indexStart !== null) this.indexRanges.release(indexStart, indexCount);
      this.grow(vertexCount, indexCount);
      vertexStart = this.vertexRanges.allocate(vertexCount)!;
      indexStart = this.indexRanges.allocate(indexCount)!;
    }
    const floats = ROAD_SURFACE_SLOT_FLOATS;
    this.positions.set(arrays.positions, vertexStart * floats.position);
    this.normals.set(arrays.normals, vertexStart * floats.normal);
    this.surface.set(arrays.surface, vertexStart * floats.surface);
    const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
    const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const source = arrays.positions;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = source[vertex * 3 + axis]!;
        if (value < minimum[axis]!) minimum[axis] = value;
        if (value > maximum[axis]!) maximum[axis] = value;
      }
      this.chunk[(vertexStart + vertex) * 2] = cx;
      this.chunk[(vertexStart + vertex) * 2 + 1] = cz;
    }
    for (let index = 0; index < indexCount; index += 1) {
      this.indices[indexStart + index] = arrays.indices[index]! + vertexStart;
    }
    const slot: RoadSurfaceSlot = {
      key, stamp, cx, cz, vertexStart, vertexCount, indexStart, indexCount, minimum, maximum,
    };
    this.slots.set(key, slot);
    this.liveVertices += vertexCount;
    this.liveIndices += indexCount;
    this.vertexWrites.push({ start: vertexStart, count: vertexCount });
    this.indexWrites.push({ start: indexStart, count: indexCount });
    return slot;
  }

  /** Give a chunk's ranges back, its indices zeroed; whether it had a slot. */
  release(key: string): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.slots.delete(key);
    this.indices.fill(0, slot.indexStart, slot.indexStart + slot.indexCount);
    this.indexWrites.push({ start: slot.indexStart, count: slot.indexCount });
    this.vertexRanges.release(slot.vertexStart, slot.vertexCount);
    this.indexRanges.release(slot.indexStart, slot.indexCount);
    this.liveVertices -= slot.vertexCount;
    this.liveIndices -= slot.indexCount;
    return true;
  }

  /** The ranges written since the last take, each array's overlapping and touching ones merged. */
  takeWrites(): RoadSurfaceWrites {
    const writes: RoadSurfaceWrites = {
      grew: this.grew,
      vertices: this.grew ? [] : coalesce(this.vertexWrites),
      indices: this.grew ? [] : coalesce(this.indexWrites),
    };
    this.grew = false;
    this.vertexWrites = [];
    this.indexWrites = [];
    return writes;
  }

  private grow(vertexCount: number, indexCount: number): void {
    const vertexCapacity = Math.max(2 * this.vertexRanges.capacity, this.vertexRanges.end + vertexCount);
    const indexCapacity = Math.max(2 * this.indexRanges.capacity, this.indexRanges.end + indexCount);
    const floats = ROAD_SURFACE_SLOT_FLOATS;
    this.positions = grown(this.positions, vertexCapacity * floats.position);
    this.normals = grown(this.normals, vertexCapacity * floats.normal);
    this.surface = grown(this.surface, vertexCapacity * floats.surface);
    this.chunk = grown(this.chunk, vertexCapacity * floats.chunk);
    const indices = new Uint32Array(indexCapacity);
    indices.set(this.indices);
    this.indices = indices;
    this.vertexRanges.capacity = vertexCapacity;
    this.indexRanges.capacity = indexCapacity;
    this.grew = true;
  }
}

function grown(array: Float32Array, length: number): Float32Array {
  const larger = new Float32Array(length);
  larger.set(array);
  return larger;
}

function coalesce(ranges: readonly RoadSurfaceRange[]): RoadSurfaceRange[] {
  const sorted = ranges.filter((range) => range.count > 0).sort((a, b) => a.start - b.start);
  const merged: { start: number; count: number }[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.start + last.count) {
      last.count = Math.max(last.count, range.start + range.count - last.start);
    } else {
      merged.push({ start: range.start, count: range.count });
    }
  }
  return merged;
}
