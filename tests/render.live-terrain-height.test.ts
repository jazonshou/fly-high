import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  airportReachWorldBounds,
  airportTerrainReach,
} from "../src/render/webgpu/airfield/AirportFootprint";
import {
  analyticTerrainHeightOf,
  analyticTerrainOf,
  LiveAirportGround,
  spawnedAirportsOf,
  withSpawnedAirportGround,
} from "../src/render/webgpu/airfield/SpawnedAirportGround";
import { airfieldStructureExclusionSites } from "../src/render/webgpu/airfield/StructureExclusion";
import { generateDetailCell } from "../src/render/webgpu/detail/generation";
import type { GeneratedDetailCell } from "../src/render/webgpu/detail/types";
import {
  TerrainConsumerAuthority,
  terrainConsumerHeightFromAuthority,
  terrainConsumerSampleFromAuthority,
  type TerrainConsumerHeightAuthority,
  type TerrainConsumerSample,
  type TerrainConsumerTerrainSample,
} from "../src/render/webgpu/terrain/TerrainConsumerAuthority";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "../src/render/webgpu/world/pageGeometry";
import type { DetailWorkerEvent } from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import type { TerrainMacroGrid, TerrainPagePublication } from "../src/workers/terrainAuthority";
import {
  createWorld,
  findSpawnedAirport,
  getAirportInfluence,
  sampleTerrain,
  sampleTerrainHeight,
  TERRAIN_NORMAL_SAMPLE_DISTANCE,
  withAirports,
  type AirportDefinition,
  type TerrainSample,
  type WorldDefinition,
} from "../src/world";

/**
 * The renderer's height-only terrain sampler (`liveTerrainHeight` in
 * `FlightRenderer.create`) feeds the camera clamp, the spawned airfields, the
 * ground-cover tile and the birds in place of `liveTerrainSample(x, z).height`.
 * That swap changes no pixel and no placement only if the two agree bit for
 * bit everywhere: on the consumer authority's L0 pages and macro grid (its
 * analytic rim included), inside the home field's influence, inside a spawned
 * airport's, and past the macro grid. These compose the two samplers exactly
 * as `FlightRenderer.create` does, from FlightGame's analytic pair, and hold
 * them to `Object.is` at 10,000 points, aprons and runway ends among them.
 *
 * The detail worker imports the consumer sampler for generation, and the
 * height's ladder was extracted from it, so its cells are held to what the
 * sampler of 19543c0 generates, byte for byte.
 */

/** A spawn search run to completion from `from`, heading east. */
function spawnFrom(world: WorldDefinition, x: number, z: number): Readonly<AirportDefinition> {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, Math.PI / 2, attempt);
    if (result === "exhausted") throw new Error("no spawn site");
    if (result) return result;
  }
}

/** Deterministic points: mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The synthetic erosion the pages and the macro grid carry: never zero, so they differ from the kernel. */
function eroded(world: WorldDefinition, x: number, z: number): number {
  return sampleTerrainHeight(world, x, z) - 3 - 2 * Math.sin(x * 0.0123) * Math.cos(z * 0.0171);
}

const PAGE_SPACING = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
const MACRO_TEXEL = 512;
const MACRO_EDGE = 72;

function macroGrid(world: WorldDefinition): TerrainMacroGrid {
  const home = world.airport!;
  const originX = home.centerX - (MACRO_EDGE / 2) * MACRO_TEXEL;
  const originZ = home.centerZ - (MACRO_EDGE / 2) * MACRO_TEXEL;
  const heights = new Float32Array(MACRO_EDGE * MACRO_EDGE);
  for (let row = 0; row < MACRO_EDGE; row += 1) {
    for (let column = 0; column < MACRO_EDGE; column += 1) {
      heights[row * MACRO_EDGE + column] = eroded(
        world,
        originX + column * MACRO_TEXEL,
        originZ + row * MACRO_TEXEL,
      ) - 4;
    }
  }
  // The rim blends toward the analytic height the caller passes, which is
  // what makes the analytic height an input of the authority's answer.
  return {
    originX, originZ, texelSizeMeters: MACRO_TEXEL, width: MACRO_EDGE, height: MACRO_EDGE, heights,
    analyticBlendTexels: 3,
  };
}

function heightPage(world: WorldDefinition, tileX: number, tileZ: number): TerrainPagePublication {
  const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE);
  for (let row = 0; row < WORLD_PAGE_HEIGHT_CORE; row += 1) {
    for (let column = 0; column < WORLD_PAGE_HEIGHT_CORE; column += 1) {
      heights[row * WORLD_PAGE_HEIGHT_CORE + column] = eroded(
        world,
        (tileX * WORLD_PAGE_HEIGHT_CORE + column) * PAGE_SPACING,
        (tileZ * WORLD_PAGE_HEIGHT_CORE + row) * PAGE_SPACING,
      );
    }
  }
  return { level: 0, tileX, tileZ, heights };
}

function auxPage(tileX: number, tileZ: number) {
  const edge = 136;
  const shoreDistanceR16Sint = new Int16Array(edge * edge);
  const soilDepthR8Unorm = new Uint8Array(edge * edge);
  for (let index = 0; index < edge * edge; index += 1) {
    shoreDistanceR16Sint[index] = (index % 97) - 40;
    soilDepthR8Unorm[index] = index % 251;
  }
  return {
    level: 0, tileX, tileZ, coreSize: 128, gutter: 4, storedEdge: edge, texelSizeMeters: 4,
    shoreDistanceMetersPerUnit: 0.25, soilDepthMetersPerUnit: 8 / 255,
    shoreDistanceR16Sint, soilDepthR8Unorm,
  } as const;
}

const tileOf = (meters: number): number => Math.floor(meters / WORLD_PAGE_BASE_EXTENT_METERS);

function runwayEnds(airport: Readonly<AirportDefinition>): readonly (readonly [number, number])[] {
  const half = airport.runwayLength / 2;
  const alongX = Math.sin(airport.headingRadians);
  const alongZ = Math.cos(airport.headingRadians);
  return [
    [airport.centerX + alongX * half, airport.centerZ + alongZ * half],
    [airport.centerX - alongX * half, airport.centerZ - alongZ * half],
  ];
}

interface ErodedSetup {
  readonly world: WorldDefinition;
  readonly next: WorldDefinition;
  readonly spawned: Readonly<AirportDefinition>;
  readonly macro: TerrainMacroGrid;
  readonly pages: readonly TerrainPagePublication[];
  readonly aux: ReturnType<typeof auxPage>;
}

/**
 * An eroded world with a spawned airport, and the consumer pages a flight
 * would have published: L0 pages under both fields' runway ends and over open
 * ground, an aux page, and a macro grid round the home field.
 */
function erodedSetup(): ErodedSetup {
  const world = createWorld("alpha", { worldEvolution: "eroded" });
  const home = world.airport!;
  const spawned = spawnFrom(world, home.centerX + 15_000, home.centerZ);
  const next = withAirports(world, [...world.airports, spawned]);
  const [homeEnd] = runwayEnds(home);
  const [spawnedEnd, spawnedOtherEnd] = runwayEnds(spawned);
  const tiles = new Map<string, readonly [number, number]>();
  for (const [x, z] of [
    homeEnd!,
    spawnedEnd!,
    spawnedOtherEnd!,
    [home.centerX + 4_000, home.centerZ - 3_000],
    [home.centerX - 6_000, home.centerZ + 5_000],
  ] as const) {
    tiles.set(`${tileOf(x)},${tileOf(z)}`, [tileOf(x), tileOf(z)]);
  }
  const pages = [...tiles.values()].map(([tileX, tileZ]) => heightPage(world, tileX, tileZ));
  const openPage = pages[pages.length - 1]!;
  return {
    world, next, spawned, macro: macroGrid(world), pages, aux: auxPage(openPage.tileX, openPage.tileZ),
  };
}

function publishedAuthority(setup: ErodedSetup): TerrainConsumerAuthority {
  const authority = new TerrainConsumerAuthority();
  authority.publishMacro(setup.macro);
  for (const page of setup.pages) authority.publish(page);
  authority.publishAuxPage(setup.aux);
  return authority;
}

/** `FlightRenderer.create`'s two live samplers, from FlightGame's analytic pair over the live world. */
function liveSamplers(world: WorldDefinition, authority: TerrainConsumerAuthority | null) {
  let live = world;
  const terrainSample = (x: number, z: number): TerrainSample => sampleTerrain(live, x, z);
  const terrainHeight = (x: number, z: number): number => sampleTerrainHeight(live, x, z);
  const consumerSample = authority
    ? terrainConsumerSampleFromAuthority(world, terrainSample, authority)
    : terrainSample;
  const consumerHeight = authority
    ? terrainConsumerHeightFromAuthority(world, terrainHeight, authority)
    : terrainHeight;
  const airportGround = new LiveAirportGround<TerrainSample>(consumerSample, analyticTerrainOf);
  const airportHeight = new LiveAirportGround<number>(consumerHeight, analyticTerrainHeightOf);
  const setWorld = (next: WorldDefinition): void => {
    live = next;
    airportGround.setWorld(next);
    airportHeight.setWorld(next);
  };
  setWorld(world);
  return { sample: airportGround.sample, height: airportHeight.sample, setWorld };
}

/** 10,000 points: aprons, runway ends, the published pages, and open ground in and past the macro grid. */
function probePoints(
  airports: readonly Readonly<AirportDefinition>[],
  pages: readonly TerrainPagePublication[],
  centre: Readonly<AirportDefinition>,
): readonly (readonly [number, number])[] {
  const next = random(0x5eed);
  const points: (readonly [number, number])[] = [];
  for (const airport of airports) {
    const bounds = airportReachWorldBounds(airportTerrainReach(airport, 200));
    for (let index = 0; index < 1_500; index += 1) {
      points.push([
        bounds.minX + next() * (bounds.maxX - bounds.minX),
        bounds.minZ + next() * (bounds.maxZ - bounds.minZ),
      ]);
    }
    const alongX = Math.sin(airport.headingRadians);
    const alongZ = Math.cos(airport.headingRadians);
    const alongReach = airport.endSafetyArea + 150;
    const acrossReach = airport.runwayWidth / 2 + airport.shoulderWidth + 60;
    for (const [endX, endZ] of runwayEnds(airport)) {
      for (let index = 0; index < 250; index += 1) {
        const along = (next() * 2 - 1) * alongReach;
        const across = (next() * 2 - 1) * acrossReach;
        points.push([endX + alongX * along + alongZ * across, endZ + alongZ * along - alongX * across]);
      }
    }
  }
  const perPage = Math.floor(3_000 / pages.length);
  for (const page of pages) {
    for (let index = 0; index < perPage; index += 1) {
      points.push([
        (page.tileX + next()) * WORLD_PAGE_BASE_EXTENT_METERS,
        (page.tileZ + next()) * WORLD_PAGE_BASE_EXTENT_METERS,
      ]);
    }
  }
  while (points.length < 10_000) {
    points.push([
      centre.centerX + (next() * 2 - 1) * 24_000,
      centre.centerZ + (next() * 2 - 1) * 24_000,
    ]);
  }
  return points;
}

/** Points where the height sampler disagrees with the full sample's height, bit for bit. */
function disagreements(
  points: readonly (readonly [number, number])[],
  samplers: { readonly sample: (x: number, z: number) => TerrainSample; readonly height: (x: number, z: number) => number },
): string[] {
  const failures: string[] = [];
  for (const [x, z] of points) {
    const height = samplers.height(x, z);
    const full = samplers.sample(x, z).height;
    if (!Object.is(height, full)) failures.push(`(${x}, ${z}): ${height} vs ${full}`);
  }
  return failures;
}

describe("the renderer's height-only terrain sampler", () => {
  it("is the full sample's height, bit for bit, in an eroded world with pages published and an airport spawned", () => {
    const setup = erodedSetup();
    const { world, next, spawned } = setup;
    const home = world.airport!;
    const authority = publishedAuthority(setup);
    const samplers = liveSamplers(world, authority);
    const points = probePoints([home, spawned], setup.pages, home);
    expect(points).toHaveLength(10_000);

    expect(disagreements(points, samplers)).toEqual([]);
    samplers.setWorld(next);
    expect(disagreements(points, samplers)).toEqual([]);

    // Every rung of the ladder answered somewhere: the pages, the macro grid,
    // the analytic kernel past it, and both airports' authored ground.
    const counters = authority.countersSnapshot();
    expect(counters.readbackServed).toBeGreaterThan(1_000);
    expect(counters.macroServed).toBeGreaterThan(1_000);
    let onHome = 0;
    let onSpawned = 0;
    let erodedPoints = 0;
    let pastMacro = 0;
    const macroHalfMeters = (MACRO_EDGE / 2) * MACRO_TEXEL;
    for (const [x, z] of points) {
      if (getAirportInfluence(home, x, z) > 0) onHome += 1;
      else if (getAirportInfluence(spawned, x, z) > 0) onSpawned += 1;
      else if (samplers.height(x, z) !== sampleTerrainHeight(next, x, z)) erodedPoints += 1;
      if (Math.max(Math.abs(x - home.centerX), Math.abs(z - home.centerZ)) > macroHalfMeters) pastMacro += 1;
    }
    expect(onHome).toBeGreaterThan(1_000);
    expect(onSpawned).toBeGreaterThan(1_000);
    expect(erodedPoints).toBeGreaterThan(3_000);
    expect(pastMacro).toBeGreaterThan(100);
  });

  it("is the full sample's height, bit for bit, in an analytic world before and after an airport spawns", () => {
    const world = createWorld("alpha", { worldEvolution: "analytic" });
    const home = world.airport!;
    const spawned = spawnFrom(world, home.centerX + 15_000, home.centerZ);
    const next = withAirports(world, [...world.airports, spawned]);
    // Analytic worlds keep the supplied height function itself, as the full
    // sampler keeps the supplied sampler.
    const height = (x: number, z: number) => sampleTerrainHeight(world, x, z);
    const neverAsked: TerrainConsumerHeightAuthority = {
      sampleHeight: () => {
        throw new Error("an analytic world asked the authority");
      },
    };
    expect(terrainConsumerHeightFromAuthority(world, height, neverAsked)).toBe(height);

    const samplers = liveSamplers(world, null);
    const points = probePoints([home, spawned], [], home);
    expect(disagreements(points, samplers)).toEqual([]);
    samplers.setWorld(next);
    expect(disagreements(points, samplers)).toEqual([]);
    // The spawned field's earthworks answer inside its influence.
    expect(samplers.height(spawned.centerX, spawned.centerZ))
      .toBe(sampleTerrainHeight(next, spawned.centerX, spawned.centerZ));
  });
});

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * `terrainConsumerSampleFromAuthority` as 19543c0 shipped it, verbatim but
 * for its name, before its height ladder was extracted into
 * `terrainConsumerHeightFromAuthority`.
 */
function terrainConsumerSampleAt19543c0(
  world: Readonly<WorldDefinition>,
  analyticSample: TerrainConsumerSample,
  authority: TerrainConsumerHeightAuthority,
): TerrainConsumerSample {
  if (world.worldEvolution === "analytic") return analyticSample;

  // 6-6: the ecology channels ride the same publication and the same
  // provisioned-or-not sentinel. A channel that has no page here is simply
  // absent from the sample, which is what every consumer branches on.
  const withEcologyChannels = (
    sample: TerrainConsumerTerrainSample,
    x: number,
    z: number,
  ): TerrainConsumerTerrainSample => {
    const shoreDistanceMeters = authority.sampleShoreDistance?.(x, z);
    const soilDepthMeters = authority.sampleSoilDepth?.(x, z);
    const hasShore = shoreDistanceMeters !== null && shoreDistanceMeters !== undefined;
    const hasSoil = soilDepthMeters !== null && soilDepthMeters !== undefined;
    if (!hasShore && !hasSoil) return sample;
    return {
      ...sample,
      ...(hasShore ? { shoreDistanceMeters } : {}),
      ...(hasSoil ? { soilDepthMeters } : {}),
    };
  };

  const heightAt = (x: number, z: number): number => {
    const analytic = analyticSample(x, z);
    if (world.airport && getAirportInfluence(world.airport, x, z) > 0) {
      return analytic.height;
    }
    return authority.sampleHeight(x, z, analytic.height) ?? analytic.height;
  };

  return (worldX, worldZ) => {
    const analytic = analyticSample(worldX, worldZ);
    if (world.airport && getAirportInfluence(world.airport, worldX, worldZ) > 0) {
      return analytic;
    }
    const height = authority.sampleHeight(worldX, worldZ, analytic.height);
    if (height === null) return withEcologyChannels(analytic, worldX, worldZ);

    const delta = TERRAIN_NORMAL_SAMPLE_DISTANCE;
    const gradientX = (
      heightAt(worldX + delta, worldZ) - heightAt(worldX - delta, worldZ)
    ) / (2 * delta);
    const gradientZ = (
      heightAt(worldX, worldZ + delta) - heightAt(worldX, worldZ - delta)
    ) / (2 * delta);
    const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
    return withEcologyChannels({
      ...analytic,
      height,
      normal: {
        x: -gradientX * inverseLength,
        y: inverseLength,
        z: -gradientZ * inverseLength,
      },
      slope: clamp01(1 - inverseLength),
    }, worldX, worldZ);
  };
}

describe("the detail worker's eroded-world generation", () => {
  it("is byte for byte what 19543c0's consumer sampler generates, airports and pages included", () => {
    const setup = erodedSetup();
    const { world, next, spawned } = setup;
    const home = world.airport!;
    const cellSize = 256;
    const events: DetailWorkerEvent[] = [];
    const worker = new DetailWorkerRuntime((event) => events.push(event), () => undefined);
    worker.handleCommand({
      type: "initialize", worldSeed: world.seed, world, cellSizeMeters: cellSize, seaLevelMeters: world.seaLevel,
    });
    worker.handleCommand({ type: "terrainMacro", macro: setup.macro });
    for (const page of setup.pages) worker.handleCommand({ type: "terrainPage", page });
    worker.handleCommand({ type: "terrainAux", page: setup.aux });
    worker.handleCommand({ type: "airports", airports: next.airports });

    // The worker's own composition (`adoptWorld`), over 19543c0's sampler and
    // an authority holding the same publications.
    const reference = publishedAuthority(setup);
    const analytic = (x: number, z: number) => sampleTerrain(next, x, z);
    const referenceSample = withSpawnedAirportGround(
      spawnedAirportsOf(next),
      terrainConsumerSampleAt19543c0(next, analytic, reference),
      analytic,
    );
    const sites = airfieldStructureExclusionSites(next.airports, next.seedHash);

    const [homeEnd] = runwayEnds(home);
    const [spawnedEnd] = runwayEnds(spawned);
    const cellOf = (meters: number) => Math.floor(meters / cellSize);
    const cells = new Map<string, readonly [number, number]>();
    for (const page of setup.pages) {
      const x = (page.tileX + 0.5) * WORLD_PAGE_BASE_EXTENT_METERS;
      const z = (page.tileZ + 0.5) * WORLD_PAGE_BASE_EXTENT_METERS;
      cells.set(`${cellOf(x)}:${cellOf(z)}`, [cellOf(x), cellOf(z)]);
    }
    for (const [x, z] of [homeEnd!, spawnedEnd!, [home.centerX + 9_000, home.centerZ + 7_000]] as const) {
      cells.set(`${cellOf(x)}:${cellOf(z)}`, [cellOf(x), cellOf(z)]);
    }

    let requestId = 0;
    let differsFromKernel = 0;
    for (const [key, [cellX, cellZ]] of cells) {
      requestId += 1;
      worker.handleCommand({
        type: "generate", requestId, generation: 0, key, cellX, cellZ, densityMultiplier: 1, dayOfYear: 172,
      });
      const event = events.pop();
      if (event?.type !== "cell") throw new Error(`expected a cell, got ${event?.type}`);
      const options = {
        worldSeed: next.seed, cellX, cellZ, cellSizeMeters: cellSize, densityMultiplier: 1,
        seaLevelMeters: world.seaLevel, dayOfYear: 172, latitudeDegrees: next.latitudeDegrees,
        structureExclusionSites: sites,
      };
      const expected: GeneratedDetailCell = generateDetailCell({ ...options, terrainSample: referenceSample });
      expect(event.cell, key).toStrictEqual(expected);
      const kernel = generateDetailCell({ ...options, terrainSample: analytic });
      if (!isDeepStrictEqual(event.cell, kernel)) differsFromKernel += 1;
    }
    // The pages and the macro grid reached the cells off the airfields: those
    // differ from the kernel's.
    expect(differsFromKernel).toBeGreaterThanOrEqual(4);
  });
});
