import { describe, expect, it } from "vitest";
import { TERRAIN_LANDFORM_CELL_METERS } from "../src/render/webgpu/terrain/TerrainKernel";
import {
  VOLCANIC_INDEX,
  VolcanicSiteIndexBuilder,
  emptyVolcanicSiteIndex,
  packVolcanicSiteIndex,
  volcanicIndexBinRange,
} from "../src/render/webgpu/terrain/VolcanicOverlayKernel";
import {
  VolcanicSiteIndexStream,
  type VolcanicIndexBuffer,
} from "../src/render/webgpu/terrain/VolcanicSiteIndexStream";
import { volcanicActivityFrame, volcanicBinSites, volcanicSitesInBounds } from "../src/world/volcanism";
import { createWorld } from "../src/world/world";

/**
 * The volcanic site index the GPU overlay reads: packed in slices that keep
 * to a deadline, bit-identical to a one-shot pack, anchored on the core
 * centre so overlapping indexes agree, and listing each bin's sites in the
 * CPU's own order; and the stream that keeps it on the GPU round the observer.
 */

const FORCED = createWorld("kilo77", { landforms: { volcanic: true } });

function u32Of(data: Float32Array): Uint32Array {
  return new Uint32Array(data.buffer, data.byteOffset, data.length);
}

/** One site's packed vec4s, keyed by its centre (stable across indexes). */
function sitesByCentre(data: Float32Array): Map<string, number[]> {
  const u32 = u32Of(data);
  const out = new Map<string, number[]>();
  for (let slot = 0; slot < u32[3]!; slot += 1) {
    const base = (u32[10]! + slot * VOLCANIC_INDEX.siteVec4s) * 4;
    const words = Array.from(u32.subarray(base, base + VOLCANIC_INDEX.siteVec4s * 4));
    // The first-flow slot depends on the index; everything else must not.
    words[14] = 0;
    out.set(`${data[base + 1]},${data[base + 2]},${data[base + 16]},${data[base + 17]}`, words);
  }
  return out;
}

describe("volcanic site index", () => {
  it("packs in slices that keep to the deadline, bit-identical to a one-shot pack", () => {
    const airport = FORCED.airport!;
    const centerX = airport.centerX + 9_000;
    const centerZ = airport.centerZ - 4_000;
    const whole = packVolcanicSiteIndex(FORCED, centerX, centerZ);
    expect(whole.siteCount).toBeGreaterThan(100);

    // A clock that has always just passed the deadline: one unit per call.
    const builder = new VolcanicSiteIndexBuilder(FORCED);
    builder.begin(centerX, centerZ);
    let calls = 0;
    while (!builder.step(0, () => 1)) calls += 1;
    expect(calls).toBeGreaterThan(whole.siteCount);
    const sliced = builder.index!;
    expect(sliced.vec4Count).toBe(whole.vec4Count);
    expect(Array.from(u32Of(sliced.data))).toEqual(Array.from(u32Of(whole.data)));

    // A rebuild reuses the builder's arrays.
    const arrays = sliced.data.buffer;
    builder.begin(centerX + 4_000, centerZ);
    expect(builder.step(Number.POSITIVE_INFINITY)).toBe(true);
    expect(builder.index!.data.buffer).toBe(arrays);
  });

  it("lists each bin's sites exactly as the CPU lookup does, in its order", () => {
    const airport = FORCED.airport!;
    const index = packVolcanicSiteIndex(FORCED, airport.centerX, airport.centerZ);
    const u32 = u32Of(index.data);
    const range = volcanicIndexBinRange(airport.centerX, airport.centerZ);
    expect([u32[0], u32[1]]).toEqual([range.binsX, range.binsZ]);
    const frame = volcanicActivityFrame(FORCED);
    for (let bin = 0; bin < range.binsX * range.binsZ; bin += 7) {
      const bi = range.bi0 + (bin % range.binsX);
      const bj = range.bj0 + Math.floor(bin / range.binsX);
      const first = u32[u32[8]! * 4 + bin * 2]!;
      const count = u32[u32[8]! * 4 + bin * 2 + 1]!;
      const expected = volcanicBinSites(FORCED, bi, bj);
      expect(count).toBe(expected.length);
      expected.forEach((site, k) => {
        const slot = u32[u32[9]! * 4 + first + k]!;
        const base = (u32[10]! + slot * VOLCANIC_INDEX.siteVec4s) * 4;
        // Whole cells and the remainder are the site's offset from the core
        // centre, and the cells are exact integers.
        const cellX = index.data[base + 16]!;
        const cellZ = index.data[base + 17]!;
        expect(Number.isInteger(cellX) && Number.isInteger(cellZ)).toBe(true);
        expect(cellX * TERRAIN_LANDFORM_CELL_METERS + index.data[base + 1]!).toBeCloseTo(site.x - frame.coreX, 4);
        expect(cellZ * TERRAIN_LANDFORM_CELL_METERS + index.data[base + 2]!).toBeCloseTo(site.z - frame.coreZ, 4);
        expect(u32[base + 15]).toBe(site.flows.length);
      });
    }
  });

  it("packs a site into the same bits whatever the index centre (the origin is the core centre)", () => {
    const airport = FORCED.airport!;
    const a = sitesByCentre(packVolcanicSiteIndex(FORCED, airport.centerX, airport.centerZ).data);
    const b = sitesByCentre(packVolcanicSiteIndex(FORCED, airport.centerX + 40_000, airport.centerZ + 24_000).data);
    let shared = 0;
    for (const [key, words] of a) {
      const other = b.get(key);
      if (!other) continue;
      shared += 1;
      expect(other).toEqual(words);
    }
    expect(shared).toBeGreaterThan(50);
  });

  it("carries each world's activity frame, and nothing for eroded worlds", () => {
    const natural = createWorld("ash-lab");
    const header = u32Of(packVolcanicSiteIndex(natural, 0, 0).data);
    expect(header[16]).toBe(1);
    expect(header[17]).toBe(1);
    expect(u32Of(emptyVolcanicSiteIndex(FORCED).data)[16]).toBe(2);
    const eroded = createWorld("ash-lab", { worldEvolution: "eroded" });
    expect(u32Of(emptyVolcanicSiteIndex(eroded).data)[16]).toBe(0);
    expect(volcanicSitesInBounds(eroded, -400_000, -400_000, 400_000, 400_000)).toHaveLength(0);
    // The empty index lists no bins, so every lookup misses.
    const empty = u32Of(emptyVolcanicSiteIndex().data);
    expect([empty[0], empty[1], empty[3]]).toEqual([0, 0, 0]);
  });
});

class FakeBuffer implements VolcanicIndexBuffer {
  readonly bytes: Uint8Array;
  writes = 0;
  disposed = false;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }
  update(data: Float32Array): void {
    expect(data.byteLength).toBeLessThanOrEqual(this.bytes.length);
    this.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.writes += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
  floats(count: number): Float32Array {
    return new Float32Array(this.bytes.buffer, 0, count);
  }
}

function streamFor(world = FORCED, initialCapacityBytes?: number) {
  return new VolcanicSiteIndexStream<FakeBuffer>(null, world, {
    createBuffer: (bytes) => new FakeBuffer(bytes),
    // A clock that has always just passed the deadline: one unit per update.
    now: () => 1,
    budgetMilliseconds: 0,
    ...(initialCapacityBytes === undefined ? {} : { initialCapacityBytes }),
  });
}

describe("volcanic site index stream", () => {
  it("primes the spawn's index whole, and covers the 131 km pyramid round it", () => {
    const airport = FORCED.airport!;
    const stream = streamFor();
    expect(stream.covers(airport.centerX, airport.centerZ, airport.centerX, airport.centerZ)).toBe(false);
    stream.prime(airport.centerX, airport.centerZ);
    const whole = packVolcanicSiteIndex(FORCED, airport.centerX, airport.centerZ);
    expect(Array.from(stream.buffer.floats(whole.data.length))).toEqual(Array.from(whole.data));
    const half = 65_536 + 512;
    expect(stream.covers(airport.centerX - half, airport.centerZ - half, airport.centerX + half, airport.centerZ + half))
      .toBe(true);
    expect(stream.covers(airport.centerX + 80_000, airport.centerZ, airport.centerX + 81_000, airport.centerZ))
      .toBe(false);
    stream.dispose();
    expect(stream.buffer.disposed).toBe(true);
  });

  it("rebuilds in slices once the observer drifts, uploading only a whole index", () => {
    const airport = FORCED.airport!;
    const stream = streamFor();
    stream.prime(airport.centerX, airport.centerZ);
    const uploads = stream.uploadCount;
    // Inside the rebuild distance: nothing to do.
    stream.update(airport.centerX + 3_000, airport.centerZ);
    expect(stream.building).toBe(false);
    expect(stream.uploadCount).toBe(uploads);
    // Past it: one unit a frame until the new index uploads.
    const x = airport.centerX + 9_000;
    const z = airport.centerZ + 2_000;
    let frames = 0;
    while (stream.uploadCount === uploads) {
      stream.update(x, z);
      frames += 1;
      if (stream.uploadCount === uploads) expect(stream.building).toBe(true);
    }
    expect(frames).toBeGreaterThan(10);
    const whole = packVolcanicSiteIndex(FORCED, x, z);
    expect(Array.from(stream.buffer.floats(whole.data.length))).toEqual(Array.from(whole.data));
    expect(stream.bufferVersion).toBe(0);
  });

  it("starts over when the observer leaps mid-build, and grows the buffer when it must", () => {
    const airport = FORCED.airport!;
    const stream = streamFor(FORCED, 1_024);
    stream.prime(airport.centerX, airport.centerZ);
    expect(stream.bufferVersion).toBe(1);
    const uploads = stream.uploadCount;
    stream.update(airport.centerX + 10_000, airport.centerZ);
    expect(stream.building).toBe(true);
    const x = airport.centerX - 200_000;
    const z = airport.centerZ + 50_000;
    while (stream.uploadCount === uploads) stream.update(x, z);
    expect(stream.covers(x - 60_000, z - 60_000, x + 60_000, z + 60_000)).toBe(true);
    const whole = packVolcanicSiteIndex(FORCED, x, z);
    expect(Array.from(stream.buffer.floats(whole.data.length))).toEqual(Array.from(whole.data));
  });

  it("is the empty index, covering everything, in a world without volcanism", () => {
    const eroded = createWorld("ash-lab", { worldEvolution: "eroded" });
    const stream = streamFor(eroded);
    expect(stream.enabled).toBe(false);
    expect(stream.covers(-1e6, -1e6, 1e6, 1e6)).toBe(true);
    stream.update(50_000, 0);
    expect(stream.building).toBe(false);
    expect(stream.buffer.writes).toBe(1);
    expect(new Uint32Array(stream.buffer.bytes.buffer)[16]).toBe(0);
  });
});
