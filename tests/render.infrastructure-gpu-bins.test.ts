import { describe, expect, it } from "vitest";
import {
  INFRASTRUCTURE_HEADER_VEC4S,
  infrastructureGpuBinHash,
  packTerrainInfrastructure,
  packWorldTerrainInfrastructure,
} from "@/src/render/webgpu/terrain/TerrainInfrastructureKernel";
import {
  buildInfrastructureIndex,
  INFRASTRUCTURE_BIN_METERS,
  infrastructureBin,
  infrastructureBinKey,
  infrastructureIndex,
  type InfrastructureIndex,
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
 * replaced stopped at 128 x 128 bins, 65 km).
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
    if (ints[word] === keyX && ints[word + 1] === keyZ) return { first: words[word + 2]!, count: words[word + 3]! };
    slot = (slot + 1) & mask;
  }
  return { first: 0, count: 0 };
}

function expectTableMatches(index: InfrastructureIndex, words: Uint32Array): void {
  const listBase = words[4]!;
  const slots = words[1]! + 1;
  expect(slots & (slots - 1)).toBe(0);
  expect(index.bins.size).toBeLessThanOrEqual(slots / 2);
  expect(words[0]).toBe(index.segments.length);
  expect(words[2]).toBe(INFRASTRUCTURE_HEADER_VEC4S);
  for (let binZ = index.binMinZ; binZ <= index.binMaxZ; binZ += 1) {
    for (let binX = index.binMinX; binX <= index.binMaxX; binX += 1) {
      const list = index.bins.get(infrastructureBinKey(binX, binZ));
      const found = lookup(words, binX, binZ);
      if (!list) {
        expect(found.count).toBe(0);
        continue;
      }
      expect(found.count).toBe(list.length);
      const listed = Array.from(words.subarray(listBase * 4 + found.first, listBase * 4 + found.first + found.count));
      expect(listed).toEqual(Array.from(list));
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
    // A dense grid over that rectangle would be ~51,000 bins; the table holds the dozen occupied.
    expect(words[1]! + 1).toBeLessThanOrEqual(64);
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
});
