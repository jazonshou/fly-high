import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { afterEach, describe, expect, it } from "vitest";
import {
  INFRASTRUCTURE_HEADER_VEC4S,
  INFRASTRUCTURE_SEGMENT_VEC4S,
  infrastructureGpuBinHash,
  packTerrainInfrastructure,
  packWorldTerrainInfrastructure,
  TerrainInfrastructureData,
  TerrainInfrastructurePack,
} from "@/src/render/webgpu/terrain/TerrainInfrastructureKernel";
import {
  buildInfrastructureIndex,
  clearInfrastructureRegions,
  INFRASTRUCTURE_BIN_METERS,
  infrastructureBin,
  infrastructureBinKey,
  infrastructureBinKeyX,
  infrastructureBinKeyZ,
  infrastructureIndex,
  infrastructureIndexChanges,
  installInfrastructureRegions,
  staticInfrastructureIndex,
  type InfrastructureIndex,
  type InfrastructureRegion,
  type InfrastructureSegment,
} from "@/src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "@/src/world/infrastructureProfiles";
import { landformCoreCenter } from "@/src/world/landforms";
import { createWorld } from "@/src/world/world";

/**
 * The GPU twin's hashed bin table (`packTerrainInfrastructure`), read back
 * on the CPU the way `terrainInfraBin` reads it: every occupied bin is found
 * within the header's longest probe and lists exactly the CPU index's
 * segments, an empty bin finds nothing, and occupied bins may sit as far
 * apart as streamed regions and the home marina can (the dense grid this
 * replaced stopped at 128 x 128 bins, 65 km). And the GPU's own copy, kept
 * in place by ranged writes as regions come and go, reads the same as a
 * fresh pack of the same index.
 */

const world = createWorld("open-skies");
const origin = landformCoreCenter(world);

function road(ax: number, az: number, bx: number, bz: number, key: number): InfrastructureSegment {
  return {
    profile: INFRASTRUCTURE_PROFILE.platform,
    mode: "set",
    priority: 5,
    ax,
    az,
    bx,
    bz,
    halfWidth: 4,
    reach: 20,
    params: [10, 2],
    key,
  };
}

afterEach(() => clearInfrastructureRegions());

/** `terrainInfraBin`, on the packed words: the bin's (first list entry, count). */
function lookup(words: Uint32Array, binX: number, binZ: number): { first: number; count: number } {
  const ints = new Int32Array(words.buffer);
  const mask = words[1]!;
  const tableBase = words[2]!;
  const longest = words[3]!;
  const anchorX = infrastructureBin(origin.x);
  const anchorZ = infrastructureBin(origin.z);
  const keyX = binX - anchorX;
  const keyZ = binZ - anchorZ;
  let slot = infrastructureGpuBinHash(keyX, keyZ) & mask;
  for (let probe = 0; probe < longest; probe += 1) {
    const word = (tableBase + slot) * 4;
    if (words[word + 3] === 0) break;
    if (ints[word] === keyX && ints[word + 1] === keyZ) return { first: words[word + 2]!, count: words[word + 3]! - 1 };
    slot = (slot + 1) & mask;
  }
  return { first: 0, count: 0 };
}

/** The segment slots a bin lists, read back from the packed words. */
function listed(words: Uint32Array, binX: number, binZ: number): number[] {
  const listBase = words[4]!;
  const found = lookup(words, binX, binZ);
  return Array.from(words.subarray(listBase * 4 + found.first, listBase * 4 + found.first + found.count));
}

/** A slot's packed segment words. */
function segmentWords(words: Uint32Array, slot: number): number[] {
  const first = (words[5]! + slot * INFRASTRUCTURE_SEGMENT_VEC4S) * 4;
  return Array.from(words.subarray(first, first + INFRASTRUCTURE_SEGMENT_VEC4S * 4));
}

/**
 * Every occupied bin of the index is found with its list, and its
 * neighbours (occupied or not) read what the index says of them; a dense
 * walk of the bin rectangle would be millions of bins at 64 m.
 */
function expectTableMatches(index: InfrastructureIndex, words: Uint32Array): void {
  const slots = words[1]! + 1;
  expect(slots & (slots - 1)).toBe(0);
  expect(index.bins.size).toBeLessThanOrEqual(slots / 2);
  expect(words[0]).toBe(index.segments.length);
  expect(words[5]).toBe(INFRASTRUCTURE_HEADER_VEC4S);
  for (const key of index.bins.keys()) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const binX = infrastructureBinKeyX(key) + dx;
        const binZ = infrastructureBinKeyZ(key) + dz;
        expect(listed(words, binX, binZ)).toEqual(Array.from(index.bins.get(infrastructureBinKey(binX, binZ)) ?? []));
      }
    }
  }
}

describe("infrastructure GPU bin table", () => {
  it("finds every bin of the home marina's index, and nothing elsewhere", () => {
    const index = infrastructureIndex(world);
    expect(index.segments.length).toBeGreaterThan(0);
    const words = packWorldTerrainInfrastructure(world);
    expectTableMatches(index, words);
    expect(lookup(words, index.binMaxX + 3, index.binMaxZ + 3).count).toBe(0);
  });

  it("holds bins 150 km apart in a table sized by the bins occupied", () => {
    const near = road(origin.x + 100, origin.z + 100, origin.x + 900, origin.z + 300, 1);
    const far = road(origin.x + 150_000, origin.z - 90_000, origin.x + 151_000, origin.z - 89_400, 2);
    const index = buildInfrastructureIndex(world, [() => ({ segments: [near, far] })]);
    expect(index.binMaxX - index.binMinX).toBeGreaterThan(150_000 / INFRASTRUCTURE_BIN_METERS);
    const words = packTerrainInfrastructure(index, world.seaLevel, origin);
    expectTableMatches(index, words);
    // A dense grid over that rectangle would be over three million bins; the table holds the few dozen occupied.
    expect(index.bins.size).toBeLessThan(100);
    expect(words[1]! + 1).toBeLessThanOrEqual(4 * index.bins.size);
  });

  it("packs an empty index as a header that lists nothing", () => {
    const index = buildInfrastructureIndex(world, []);
    const words = packTerrainInfrastructure(index, world.seaLevel, origin);
    expect(words[0]).toBe(0);
    expect(lookup(words, 0, 0).count).toBe(0);
  });

  it("hashes the way WGSL's wrapping u32 arithmetic does", () => {
    // Reference: (u32(x) * 0x9e3779b1 ^ u32(z) * 0x85ebca77) mod 2^32, then h ^ (h >> 15), in BigInt.
    const reference = (x: number, z: number) => {
      const m = 2n ** 32n;
      const ux = (BigInt(x) % m + m) % m;
      const uz = (BigInt(z) % m + m) % m;
      const h = ((ux * 0x9e3779b1n) % m) ^ ((uz * 0x85ebca77n) % m);
      return Number(h ^ (h >> 15n));
    };
    for (const [x, z] of [[0, 0], [1, -1], [-300, 177], [2_000_000, -2_000_000], [-1, -1], [123_456, 7]] as const) {
      expect(infrastructureGpuBinHash(x, z)).toBe(reference(x, z));
    }
  });

  it("keeps the GPU's copy in place as regions come and go, reading as a fresh pack does", () => {
    // Regions of strips along a line east of the core, overlapping their neighbours.
    const regionAt = (k: number, keys: number): InfrastructureRegion => ({
      key: `test:${k}`,
      segments: Array.from({ length: keys }, (_, j) => road(
        origin.x + k * 700 + j * 90,
        origin.z + 300 + (j % 3) * 40,
        origin.x + k * 700 + j * 90 + 160,
        origin.z + 340 + (j % 2) * 50,
        k * 1_000 + j,
      )),
    });
    const all = Array.from({ length: 12 }, (_, k) => regionAt(k, 4 + (k % 5) * 3));
    installInfrastructureRegions(world, all.slice(0, 6));
    let index = infrastructureIndex(world);
    const pack = new TerrainInfrastructurePack(index, world.seaLevel, origin, true);
    const words = pack.words;
    const bytes = words.byteLength;
    // Installs and removals, a few at a time, as the stream gives them, about as many held throughout.
    const steps: [number[], number[]][] = [
      [[6], [0]], [[0], [1]], [[7, 8], [2, 3]], [[1], [6]], [[], [7]], [[2, 3, 7], [8]], [[9], [4]], [[10, 11], [0, 5]],
      [[4], [10]],
    ];
    let written = 0;
    for (const [add, remove] of steps) {
      // A pack without room says so at a change that grows it.
      const tight = new TerrainInfrastructurePack(index, world.seaLevel, origin, false);
      installInfrastructureRegions(world, add.map((k) => all[k]!), remove.map((k) => all[k]!.key));
      const next = infrastructureIndex(world);
      const changes = infrastructureIndexChanges(index, next)!;
      expect(changes).not.toBeNull();
      if (add.length > remove.length) expect(tight.update(next, changes)).toBeNull();
      const ranges = pack.update(next, changes)!;
      expect(ranges).not.toBeNull();
      for (let i = 0; i < ranges.length; i += 2) written += ranges[i + 1]! - ranges[i]!;
      index = next;
      // In place: the same words, every bin and slot as a fresh pack of the index reads.
      expect(pack.words).toBe(words);
      const fresh = packTerrainInfrastructure(index, world.seaLevel, origin);
      expect(words[0]).toBe(fresh[0]);
      expectTableMatches(index, words);
      for (const key of index.bins.keys()) {
        const binX = infrastructureBinKeyX(key);
        const binZ = infrastructureBinKeyZ(key);
        expect(listed(words, binX, binZ)).toEqual(listed(fresh, binX, binZ));
        for (const slot of listed(words, binX, binZ)) expect(segmentWords(words, slot)).toEqual(segmentWords(fresh, slot));
      }
    }
    expect(words.byteLength).toBe(bytes);
    // Far less written than a pack per change.
    expect(written * 16).toBeLessThan(steps.length * bytes / 4);
  });

  it("lays its lists out again and rehashes its table in place as an observer flies on", () => {
    // A window of six regions sliding east, one region a step: new bins all the way.
    const regionAt = (k: number): InfrastructureRegion => ({
      key: `fly:${k}`,
      segments: Array.from({ length: 20 }, (_, j) => road(
        origin.x + k * 600 + (j % 5) * 110,
        origin.z - 500 + Math.floor(j / 5) * 260,
        origin.x + k * 600 + (j % 5) * 110 + 140,
        origin.z - 420 + Math.floor(j / 5) * 260 + (j % 3) * 30,
        k * 100 + j,
      )),
    });
    installInfrastructureRegions(world, Array.from({ length: 6 }, (_, k) => regionAt(k)));
    let index = infrastructureIndex(world);
    // Without the streamed minimum, so a test-sized window runs out of room.
    const pack = new TerrainInfrastructurePack(index, world.seaLevel, origin, true, false);
    for (let k = 6; k < 130; k += 1) {
      installInfrastructureRegions(world, [regionAt(k)], [`fly:${k - 6}`]);
      const next = infrastructureIndex(world);
      expect(pack.update(next, infrastructureIndexChanges(index, next)!)).not.toBeNull();
      index = next;
      if (k % 10 === 0 || k === 129) expectTableMatches(index, pack.words);
    }
    expect(pack.relayouts.lists).toBeGreaterThan(0);
    expect(pack.relayouts.table).toBeGreaterThan(0);
  });
});

/**
 * An engine whose storage buffers are plain bytes: what the GPU's copy holds
 * after every write `TerrainInfrastructureData` makes, read back as words.
 */
function bytesEngine() {
  const buffers: { bytes: Uint8Array }[] = [];
  const engine = {
    _storageBuffers: [] as unknown[],
    createStorageBuffer(size: number) {
      const buffer = { bytes: new Uint8Array(size) };
      buffers.push(buffer);
      return buffer;
    },
    updateStorageBuffer(buffer: { bytes: Uint8Array }, data: ArrayBufferView, byteOffset = 0, byteLength?: number) {
      const source = new Uint8Array(data.buffer, data.byteOffset, byteLength ?? data.byteLength);
      buffer.bytes.set(source, byteOffset);
    },
    _releaseBuffer() {},
  };
  return {
    engine: engine as unknown as WebGPUEngine,
    words: () => new Uint32Array(buffers.at(-1)!.bytes.buffer),
  };
}

describe("the engine's shared copy of the stage", () => {
  const regionAt = (k: number): InfrastructureRegion => ({
    key: `behind:${k}`,
    segments: Array.from({ length: 6 }, (_, j) => road(
      origin.x - 3_000 + k * 400 + j * 70,
      origin.z + 900 + (j % 2) * 60,
      origin.x - 3_000 + k * 400 + j * 70 + 120,
      origin.z + 950,
      k * 100 + j,
    )),
  });

  it("writes nothing, frame after frame, in a session that never installs a region", () => {
    const { engine } = bytesEngine();
    const data = TerrainInfrastructureData.acquire(engine, world);
    try {
      expect(infrastructureIndex(world)).toBe(staticInfrastructureIndex(world));
      const written = { ...data.writes };
      for (let frame = 0; frame < 120; frame += 1) data.setWorld(world);
      expect(data.writes).toEqual(written);
      expect(infrastructureIndex(world)).toBe(staticInfrastructureIndex(world));
    } finally {
      data.release();
    }
  });

  it("catches up in place from as far back as the terrain remembers, and packs afresh from further", () => {
    const { engine, words } = bytesEngine();
    installInfrastructureRegions(world, [regionAt(0), regionAt(1)]);
    const data = TerrainInfrastructureData.acquire(engine, world);
    try {
      // Thirty-two changes behind, one region in and one out each: the history reaches.
      for (let k = 2; k < 34; k += 1) installInfrastructureRegions(world, [regionAt(k)], [`behind:${k - 2}`]);
      data.setWorld(world);
      expect(data.writes).toMatchObject({ packs: 1, updates: 1 });
      expectTableMatches(infrastructureIndex(world), words());
      // Thirty-three: it does not, and the copy is packed again from the index.
      for (let k = 34; k < 67; k += 1) installInfrastructureRegions(world, [regionAt(k)], [`behind:${k - 2}`]);
      const held = infrastructureIndex(world);
      data.setWorld(world);
      expect(data.writes).toMatchObject({ packs: 2, updates: 1 });
      expectTableMatches(held, words());
      // And in place again from there.
      installInfrastructureRegions(world, [regionAt(67)], ["behind:65"]);
      data.setWorld(world);
      expect(data.writes).toMatchObject({ packs: 2, updates: 2 });
      expectTableMatches(infrastructureIndex(world), words());
    } finally {
      data.release();
    }
  });
});
