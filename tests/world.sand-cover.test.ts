import { describe, expect, it } from "vitest";
import { createWorld } from "../src/world/world";
import { landformCoreCenter, sampleLandformCover } from "../src/world/landforms";
import {
  sampleTerrain,
  sampleTerrainHeight,
  sampleTerrainNormal,
  sampleTerrainSurface,
} from "../src/world/terrain";
import { TerrainBiome, type TerrainSample, type WorldDefinition } from "../src/world/types";

/**
 * Sand cover from the sand seas, read by everything that classifies, plants or
 * waters the ground. A forced-erg world (`landforms: { dunes: true }`, high
 * desert) puts sand seas on the low ground everywhere outside the runway
 * clearance; a natural world has none within 120 km of the start, which is
 * what keeps every perf baseline still.
 */

const DESERT = createWorld("dune-lab", {
  landforms: { dunes: true },
  climateProvince: "high-desert",
});

interface Probe {
  readonly x: number;
  readonly z: number;
}

/** Rings round the start, `count` points that pass `accept`. */
function findProbes(
  world: WorldDefinition,
  count: number,
  accept: (x: number, z: number) => boolean,
): Probe[] {
  const center = landformCoreCenter(world);
  const probes: Probe[] = [];
  for (let radius = 9_000; radius < 60_000 && probes.length < count; radius += 1_300) {
    for (let index = 0; index < 32 && probes.length < count; index += 1) {
      const angle = (index / 32) * Math.PI * 2 + radius * 1e-4;
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      if (accept(x, z)) probes.push({ x, z });
    }
  }
  return probes;
}

/** Dune bodies deep in a sand sea: full cover, full erg weight. */
const DUNE_PROBES = findProbes(DESERT, 8, (x, z) => {
  const cover = sampleLandformCover(DESERT, x, z, 0);
  return cover.ergWeight > 0.95 && cover.sandCover >= 1 && cover.duneHeight > 3;
});

/** Ground the sand seas do not reach. */
const BARE_PROBES = findProbes(DESERT, 8, (x, z) => sampleLandformCover(DESERT, x, z, 0).ergWeight === 0);

describe("sand cover on the terrain sample", () => {
  it("finds dune ground and erg-free ground in the forced world", () => {
    expect(DUNE_PROBES).toHaveLength(8);
    expect(BARE_PROBES).toHaveLength(8);
  });

  it("is exactly zero inside the landform core of a natural world", () => {
    for (const seed of ["phase1-perf-baseline", "open-skies", "dune-lab"]) {
      const world = createWorld(seed);
      const center = landformCoreCenter(world);
      for (let index = 0; index < 48; index += 1) {
        const angle = index * 2.399963;
        const radius = 119_000 * Math.sqrt((index + 0.5) / 48);
        const sample = sampleTerrain(world, center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius);
        expect(Object.is(sample.sandCover, 0)).toBe(true);
        expect(Object.is(sample.ergWeight, 0)).toBe(true);
      }
    }
  });

  it("reads the same cover off the height sample as a fresh landform sample", () => {
    for (const { x, z } of [...DUNE_PROBES, ...BARE_PROBES]) {
      const sample = sampleTerrain(DESERT, x, z);
      const cover = sampleLandformCover(DESERT, x, z, 0);
      expect(sample.sandCover).toBe(cover.sandCover);
      expect(sample.ergWeight).toBe(cover.ergWeight);
      // sampleTerrainSurface without a cover samples it itself, to the bit.
      const normal = sampleTerrainNormal(DESERT, x, z);
      const surface = sampleTerrainSurface(
        DESERT, x, z, sampleTerrainHeight(DESERT, x, z), Math.max(0, Math.min(1, 1 - normal.y)),
        { ...sample, normal, color: { r: 0, g: 0, b: 0 } } as TerrainSample,
      );
      expect(surface.sandCover).toBe(sample.sandCover);
      expect(surface.ergWeight).toBe(sample.ergWeight);
      expect(surface.biome).toBe(sample.biome);
      expect(surface.color).toEqual(sample.color);
    }
  });

  it("names a dune sand (BEACH, the bare-sand biome) where the climate grew grass", () => {
    let wasVegetated = 0;
    for (const { x, z } of DUNE_PROBES) {
      const sample = sampleTerrain(DESERT, x, z);
      expect(sample.sandCover).toBe(1);
      expect(sample.biome).toBe(TerrainBiome.BEACH);
      expect(sample.biomeName).toBe("beach");
      // The same point classified with the cover withheld: what it was before.
      const withoutCover = sampleTerrainSurface(
        DESERT, x, z, sample.height, sample.slope,
        { ...sample, color: { r: 0, g: 0, b: 0 } } as TerrainSample,
        undefined, undefined, undefined,
        { ergWeight: 0, duneHeight: 0, sandCover: 0 },
      );
      if (withoutCover.biome !== TerrainBiome.BEACH) wasVegetated += 1;
    }
    expect(wasVegetated).toBe(DUNE_PROBES.length);
  });
});
