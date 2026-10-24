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
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import {
  HYDROLOGY_SAND_SEA_ERG_WEIGHT,
  generateHydrology,
  traceDownhillPath,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";

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

describe("sand cover in the vegetation", () => {
  // Dunes forced into a wet province: the climate grows forest on the low
  // ground, so the sand seas have trees to remove (a high desert has none).
  const WET_DUNES = createWorld("dune-lab", { landforms: { dunes: true }, climateProvince: "tropical" });
  const CELL_METERS = 256;
  const live = (world: WorldDefinition) => (x: number, z: number) => sampleTerrain(world, x, z);
  const coverAt = (point: Probe) => sampleLandformCover(WET_DUNES, point.x, point.z, 0).sandCover;

  function cellAt(x: number, z: number, sampler: (x: number, z: number) => TerrainSample) {
    return generateDetailCell({
      worldSeed: WET_DUNES.seed,
      cellX: Math.floor(x / CELL_METERS),
      cellZ: Math.floor(z / CELL_METERS),
      cellSizeMeters: CELL_METERS,
      terrainSample: sampler,
      seaLevelMeters: WET_DUNES.seaLevel,
    });
  }

  it("plants no trees on dune sand, and fewer shrubs, where the climate grows forest", () => {
    // An erg's thin edge: lone dunes on a floor that still grows forest.
    const edges = findProbes(WET_DUNES, 6, (x, z) => {
      const erg = sampleLandformCover(WET_DUNES, x, z, 0).ergWeight;
      return erg > 0.2 && erg < 0.7;
    });
    let compared = 0;
    for (const { x, z } of edges) {
      // The control withholds the cover: what the scatter placed before.
      const control = cellAt(x, z, (px, pz) => ({ ...sampleTerrain(WET_DUNES, px, pz), sandCover: 0 }));
      const controlOnSand = control.trees.filter((tree) => coverAt(tree) > 0.2).length;
      if (controlOnSand < 50) continue;
      const cell = cellAt(x, z, live(WET_DUNES));
      // ~0.2: the gate reads the 16 m grid's corners, so a curved dune edge
      // can let a stem stand a little past the threshold (measured 0.25).
      for (const tree of cell.trees) expect(coverAt(tree)).toBeLessThan(0.3);
      expect(cell.trees.length).toBeLessThan(control.trees.length);
      expect(cell.shrubs.length).toBeLessThan(control.shrubs.length);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("places identical detail with zero sand cover and with none", () => {
    const world = createWorld("phase1-perf-baseline");
    const center = landformCoreCenter(world);
    let stems = 0;
    for (const [dx, dz] of [[1_500, 900], [-4_200, 2_600], [6_000, -7_500], [-9_000, -3_000]] as const) {
      const options = {
        worldSeed: world.seed,
        cellX: Math.floor((center.x + dx) / CELL_METERS),
        cellZ: Math.floor((center.z + dz) / CELL_METERS),
        cellSizeMeters: CELL_METERS,
        seaLevelMeters: world.seaLevel,
      };
      const covered = generateDetailCell({ ...options, terrainSample: live(world) });
      const uncovered = generateDetailCell({
        ...options,
        terrainSample: (x, z) => {
          const sample: Partial<TerrainSample> = { ...sampleTerrain(world, x, z) };
          delete sample.sandCover;
          return sample as TerrainSample;
        },
      });
      expect(covered).toEqual(uncovered);
      stems += covered.trees.length + covered.shrubs.length + covered.clutter.length;
    }
    // Non-vacuity: equal empty cells would prove nothing.
    expect(stems).toBeGreaterThan(100);
  });
});

describe("sand seas in the hydrology", () => {
  // The river tracer's own test plane (520 m falling 7.5% toward +x), with a
  // sand sea over x > 0.
  const smooth = (low: number, high: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  const SANDY_SLOPE: HydrologyTerrainSampler = (x, z) => ({
    height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
    moisture: 0.64,
    ergWeight: smooth(-300, 300, x),
  });

  it("ends a river where it reaches a sand sea", () => {
    const trace = traceDownhillPath({
      worldSeed: "sand-sink",
      terrainSample: SANDY_SLOPE,
      startX: -1_800,
      startZ: 35,
      bounds: { minX: -2_500, maxX: 2_500, minZ: -2_500, maxZ: 2_500 },
      seaLevel: 0,
      stepMeters: 50,
      maximumSteps: 120,
      minimumDropMeters: 0.02,
    });
    expect(trace.termination).toBe("sand");
    const last = trace.points.at(-1)!;
    expect(last.ergWeight).toBeGreaterThan(HYDROLOGY_SAND_SEA_ERG_WEIGHT);
    for (const point of trace.points.slice(0, -1)) {
      expect(point.ergWeight).toBeLessThanOrEqual(HYDROLOGY_SAND_SEA_ERG_WEIGHT);
    }
  });

  it("generates exactly the same water with a zero erg weight and with none", () => {
    const plain: HydrologyTerrainSampler = (x, z) => ({
      height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
      moisture: 0.64,
    });
    const options = {
      worldSeed: "sand-free",
      centerX: 0,
      centerZ: 0,
      extentMeters: 4_000,
      seaLevel: 0,
      sourceCandidateSpacingMeters: 500,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 350,
      traceStepMeters: 70,
      maximumTraceSteps: 80,
      minimumRiverPoints: 6,
      maximumRivers: 5,
      maximumLakes: 2,
    };
    const shipped = generateHydrology({ ...options, terrainSample: plain });
    const zeroed = generateHydrology({
      ...options,
      terrainSample: (x, z) => ({ ...plain(x, z), ergWeight: 0 }),
    });
    expect(shipped.rivers.length).toBeGreaterThan(0);
    expect(zeroed).toEqual(shipped);
    // And on the world's own sampler, around a natural world's airport.
    const world = createWorld("phase1-perf-baseline");
    const airport = world.airport!;
    const live = generateHydrology({
      worldSeed: world.seed,
      seaLevel: world.seaLevel,
      centerX: airport.centerX,
      centerZ: airport.centerZ,
      terrainSample: (x, z) => sampleTerrain(world, x, z),
    });
    const stripped = generateHydrology({
      worldSeed: world.seed,
      seaLevel: world.seaLevel,
      centerX: airport.centerX,
      centerZ: airport.centerZ,
      terrainSample: (x, z) => {
        const sample = sampleTerrain(world, x, z);
        return { height: sample.height, moisture: sample.moisture };
      },
    });
    expect(live).toEqual(stripped);
  });

  it("puts no lake and no river source in a forced world's sand sea", () => {
    // A region east of the forced desert's runway whose sand sea, without the
    // gate, holds a lake in an interdune hollow and a river source (relaxed
    // river thresholds, as the worker parity suite uses, so the tracer runs).
    const airport = DESERT.airport!;
    const options = {
      worldSeed: DESERT.seed,
      seaLevel: DESERT.seaLevel,
      centerX: airport.centerX + 14_400,
      centerZ: airport.centerZ,
      maximumRiverGrade: 0.5,
      minimumSourceElevationAboveSeaMeters: 10,
      minimumRiverPoints: 4,
      minimumDownhillDropMeters: 0.01,
    };
    const erg = (x: number, z: number) => sampleLandformCover(DESERT, x, z, 0).ergWeight;
    const inSand = (x: number, z: number) => erg(x, z) > HYDROLOGY_SAND_SEA_ERG_WEIGHT;
    const control = generateHydrology({
      ...options,
      terrainSample: (x, z) => ({ ...sampleTerrain(DESERT, x, z), ergWeight: 0 }),
    });
    const gated = generateHydrology({ ...options, terrainSample: (x, z) => sampleTerrain(DESERT, x, z) });
    // Non-vacuity: the gate had something to remove.
    expect(control.lakes.some((lake) => inSand(lake.centerX, lake.centerZ))).toBe(true);
    expect(control.rivers.some((river) => inSand(river.points[0]!.x, river.points[0]!.z))).toBe(true);
    for (const lake of gated.lakes) expect(inSand(lake.centerX, lake.centerZ)).toBe(false);
    for (const river of gated.rivers) {
      // The smoothed tail (three points) of a river that sank may sit on sand.
      for (const point of river.points.slice(0, -3)) expect(inSand(point.x, point.z)).toBe(false);
    }
  });
});
