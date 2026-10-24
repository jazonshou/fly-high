import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateHydrology,
  resolveHydrologyConfig,
  type HydrologyGenerationConfig,
  type HydrologyGenerationResult,
  type HydrologyLake,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";
import { HydrologyGenerationClient } from "../src/render/webgpu/water/HydrologyGenerationClient";
import {
  resolveHydrologyPagingConfig,
  selectHydrologyRegion,
} from "../src/render/webgpu/water/HydrologyPaging";
import {
  VOLCANIC_POROUS_AGE,
  VOLCANIC_POROUS_COVER,
  volcanicGroundIsPorous,
  volcanicHydrologyInputs,
} from "../src/render/webgpu/water/hydrologyVolcanism";
import type { HydrologyWorkerCommand, HydrologyWorkerEvent } from "../src/workers/hydrologyProtocol";
import { createWorld, sampleTerrain, type WorldDefinition } from "../src/world";
import { landformCoreCenter } from "../src/world/landforms";
import {
  VolcanicSiteKind,
  sampleVolcanicGround,
  volcanicSitesInBounds,
  type VolcanicSite,
} from "../src/world/volcanism";

/**
 * Water on volcanic land: crater lakes the world authors, and no streams on
 * fresh cinder or young lava. Driven through the real world, the real
 * sampler (the hydrology worker's own) and, at the end, the real worker.
 *
 * The craters are pinned by site id, found by sweeping every caldera and maar
 * of these worlds: the forced worlds ("start among volcanoes") put them a
 * short flight from the airport, the natural one 143 km out.
 */

const TAU = Math.PI * 2;

const forcedWorlds = new Map<string, WorldDefinition>();
function forcedWorld(seed: string): WorldDefinition {
  let world = forcedWorlds.get(seed);
  if (!world) {
    world = createWorld(seed, { landforms: { volcanic: true } });
    forcedWorlds.set(seed, world);
  }
  return world;
}

/** The hydrology worker's sampler, exactly. */
function workerSampler(world: WorldDefinition): HydrologyTerrainSampler {
  return (x, z) => {
    const sample = sampleTerrain(world, x, z);
    return { height: sample.height, moisture: sample.moisture };
  };
}

function siteById(world: WorldDefinition, id: number): VolcanicSite {
  const center = landformCoreCenter(world);
  const span = 250_000;
  const site = volcanicSitesInBounds(
    world, center.x - span, center.z - span, center.x + span, center.z + span,
  ).find((candidate) => candidate.id === id);
  if (!site) throw new Error(`no volcanic site ${id}`);
  return site;
}

/** One production region, with or without the world's volcanic inputs. */
function region(
  world: WorldDefinition,
  centerX: number,
  centerZ: number,
  volcanic = true,
): HydrologyGenerationResult {
  const options = { centerX, centerZ, seaLevel: world.seaLevel };
  return generateHydrology({
    ...options,
    ...(volcanic ? volcanicHydrologyInputs(world, resolveHydrologyConfig(options)) : {}),
    worldSeed: world.seed,
    terrainSample: workerSampler(world),
  });
}

function craterLake(result: HydrologyGenerationResult, site: VolcanicSite): HydrologyLake | undefined {
  return result.lakes.find((lake) => lake.id.endsWith(`:lake:volcanic:${site.id}`));
}

/** Every number as its exact bits, so "identical" means bit-identical. */
function bits(value: unknown): string {
  const view = new DataView(new ArrayBuffer(8));
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "number") return item;
    view.setFloat64(0, item);
    return `${view.getUint32(0).toString(16)}:${view.getUint32(4).toString(16)}`;
  });
}

/** A crater lake's shape: closed, inside the rim, its shore on dry ground. */
function expectShoredInsideRim(
  lake: HydrologyLake,
  site: VolcanicSite,
  config: HydrologyGenerationConfig,
  sample: HydrologyTerrainSampler,
): void {
  const level = lake.surfaceHeight - config.riverSurfaceOffsetMeters;
  expect(lake.boundary).toHaveLength(config.lakeBoundarySegments);
  // The rim crest stands within 8 % of `radiusMeters` (the outline wobble).
  const rimReach = site.radiusMeters * 1.08;
  for (const [index, point] of lake.boundary.entries()) {
    expect(point.y).toBe(lake.surfaceHeight);
    const radius = Math.hypot(point.x - site.x, point.z - site.z);
    expect(radius).toBeLessThanOrEqual(rimReach * (1 + 1e-12));
    // Each vertex sits on its own ray, in order: a star round the centre, so closed and simple.
    const angle = Math.atan2(point.z - site.z, point.x - site.x);
    expect(Math.cos(angle - index * TAU / lake.boundary.length)).toBeCloseTo(1, 9);
    // The bracketing dry sample just outside the water.
    expect(sample(point.x, point.z).height).toBeGreaterThanOrEqual(level);
  }
  expect(lake.areaSquareMeters).toBeGreaterThan(0);
  expect(lake.radiusMeters).toBeLessThan(rimReach);
}

describe("authored crater lakes", () => {
  it("fill a caldera to its level, shored on the wall inside the rim", () => {
    // Forced "hydrology-parity-hills": a 2.7 km caldera 52 km from the airport,
    // its lake at 10.5 m, with no spill.
    const world = forcedWorld("hydrology-parity-hills");
    const site = siteById(world, 34_360_262_608);
    expect(site.kind).toBe(VolcanicSiteKind.Caldera);
    const result = region(world, site.x, site.z);
    const lake = craterLake(result, site)!;
    expect(lake).toBeDefined();
    expect(lake.surfaceHeight).toBe(site.lakeLevelMeters + result.config.riverSurfaceOffsetMeters);
    expect(lake.centerX).toBe(site.x);
    expect(lake.centerZ).toBe(site.z);
    const floor = site.baseLevelMeters + site.heightMeters - site.craterDepthMeters;
    expect(lake.maximumDepthMeters).toBeCloseTo(site.lakeLevelMeters - floor, 9);
    const sample = workerSampler(world);
    expectShoredInsideRim(lake, site, result.config, sample);
    // The floor is under water; the shore stands on the wall, past the floor.
    expect(sample(site.x, site.z).height).toBeLessThan(site.lakeLevelMeters);
    for (const point of lake.boundary) {
      expect(Math.hypot(point.x - site.x, point.z - site.z))
        .toBeGreaterThan(site.craterRadiusMeters * 0.94);
    }
    // The tracer makes no lake of its own inside the rim.
    for (const other of result.lakes) {
      if (other === lake) continue;
      expect(Math.hypot(other.centerX - site.x, other.centerZ - site.z))
        .toBeGreaterThanOrEqual(site.radiusMeters * 1.06);
    }
  });

  it("fill a maar's bowl to its level", () => {
    // Forced "kilo77": a 660 m maar 12 km from the airport, its lake at 368.5 m.
    const world = forcedWorld("kilo77");
    const site = siteById(world, 34_371_796_961);
    expect(site.kind).toBe(VolcanicSiteKind.Maar);
    const result = region(world, site.x, site.z);
    const lake = craterLake(result, site)!;
    expect(lake).toBeDefined();
    expect(lake.surfaceHeight).toBe(site.lakeLevelMeters + result.config.riverSurfaceOffsetMeters);
    expect(lake.maximumDepthMeters)
      .toBeCloseTo(site.lakeLevelMeters - (site.baseLevelMeters - site.craterDepthMeters), 9);
    expectShoredInsideRim(lake, site, result.config, workerSampler(world));
    for (const other of result.lakes) {
      if (other === lake) continue;
      expect(Math.hypot(other.centerX - site.x, other.centerZ - site.z))
        .toBeGreaterThanOrEqual(site.radiusMeters * 1.08);
    }
  });

  it("are one lake, bit for bit, in each region a crater straddles", () => {
    const world = forcedWorld("hydrology-parity-hills");
    const site = siteById(world, 34_360_262_608);
    const half = resolveHydrologyConfig({}).extentMeters * 0.5;
    // Two side-by-side regions whose shared edge runs 400 m east of the
    // crater's centre, through the lake.
    const west = craterLake(region(world, site.x + 400 - half, site.z), site);
    const east = craterLake(region(world, site.x + 400 + half, site.z), site);
    expect(west).toBeDefined();
    expect(east).toBeDefined();
    expect(bits(east)).toBe(bits(west));
    expect(bits(west)).toBe(bits(craterLake(region(world, site.x, site.z), site)));
  });

  it("stand no higher than the rim lets them, and drain away where it is breached", () => {
    // Small regions with token tracing: the lakes are the point here.
    const sweep = {
      extentMeters: 2_000,
      maximumTraceSteps: 4,
      riverPitEscapeRadiusMeters: 0,
      maximumLakes: 0,
    };
    let kept = 0;
    let lowered = 0;
    let drained = 0;
    for (const seed of ["kilo77", "charlie"]) {
      const world = forcedWorld(seed);
      const center = landformCoreCenter(world);
      const sample = workerSampler(world);
      const craters = volcanicSitesInBounds(
        world, center.x - 80_000, center.z - 80_000, center.x + 80_000, center.z + 80_000,
      ).filter((site) =>
        (site.kind === VolcanicSiteKind.Caldera || site.kind === VolcanicSiteKind.Maar)
        && site.lakeLevelMeters > world.seaLevel + 0.5);
      expect(craters.length).toBeGreaterThan(10);
      for (const site of craters) {
        // A small region round the crater: the lake depends only on the
        // crater, the sampler and the shore settings, which this keeps.
        const options = { ...sweep, centerX: site.x, centerZ: site.z, seaLevel: world.seaLevel };
        const config = resolveHydrologyConfig(options);
        const result = generateHydrology({
          ...options,
          authoredBasins: volcanicHydrologyInputs(world, config).authoredBasins ?? [],
          worldSeed: world.seed,
          terrainSample: sample,
        });
        const lake = craterLake(result, site);
        if (!lake) {
          drained += 1;
          continue;
        }
        const level = lake.surfaceHeight - config.riverSurfaceOffsetMeters;
        expect(level).toBeLessThanOrEqual(site.lakeLevelMeters);
        if (level === site.lakeLevelMeters) kept += 1;
        else lowered += 1;
        expectShoredInsideRim(lake, site, config, sample);
      }
    }
    // Most crater lakes stand at their level; the rest spill over a rim the
    // natural ground has lowered, and some craters are breached to the floor.
    expect(kept).toBeGreaterThan(lowered + drained);
    expect(lowered).toBeGreaterThan(0);
    expect(drained).toBeGreaterThan(0);
    // Forced "charlie": the 2.7 km caldera 47 km out is open to the
    // north-east, where the ground outside falls below its floor.
    const breached = siteById(forcedWorld("charlie"), 34_360_262_624);
    const options = { ...sweep, centerX: breached.x, centerZ: breached.z, seaLevel: 0 };
    expect(craterLake(generateHydrology({
      ...options,
      ...volcanicHydrologyInputs(forcedWorld("charlie"), resolveHydrologyConfig(options)),
      worldSeed: forcedWorld("charlie").seed,
      terrainSample: workerSampler(forcedWorld("charlie")),
    }), breached)).toBeUndefined();
  });
});

describe("porous volcanic ground", () => {
  /** A point on a site's flank that no other site's footprint reaches, or null. */
  function soleFlankPoint(world: WorldDefinition, site: VolcanicSite): { x: number; z: number } | null {
    for (let k = 0; k < 8; k += 1) {
      const angle = k * TAU / 8;
      const x = site.x + Math.cos(angle) * site.radiusMeters * 0.5;
      const z = site.z + Math.sin(angle) * site.radiusMeters * 0.5;
      const touching = volcanicSitesInBounds(world, x - 1, z - 1, x + 1, z + 1);
      if (touching.length === 1 && touching[0]!.id === site.id) return { x, z };
    }
    return null;
  }

  it("is fresh cinder and young lava, never an old flank", () => {
    const world = forcedWorld("kilo77");
    const center = landformCoreCenter(world);
    const sites = volcanicSitesInBounds(
      world, center.x - 60_000, center.z - 60_000, center.x + 60_000, center.z + 60_000,
    );
    let young = 0;
    let old = 0;
    for (const site of sites) {
      if (site.kind !== VolcanicSiteKind.Cinder && site.kind !== VolcanicSiteKind.Shield) continue;
      const point = soleFlankPoint(world, site);
      if (!point) continue;
      const ground = sampleVolcanicGround(world, point.x, point.z, 0);
      // Half way up a cone is all cinder; half way up a shield all lava.
      expect(Math.max(ground.lavaCover, ground.tephraCover)).toBe(1);
      expect(ground.age).toBe(site.age);
      expect(volcanicGroundIsPorous(world, point.x, point.z)).toBe(site.age < VOLCANIC_POROUS_AGE);
      if (site.age < VOLCANIC_POROUS_AGE) young += 1;
      else old += 1;
    }
    expect(young).toBeGreaterThan(5);
    expect(old).toBeGreaterThan(5);
    // And the edge of the cover: 0.5 is not porous.
    expect(VOLCANIC_POROUS_COVER).toBe(0.5);
    // Bare ground outside every footprint never is.
    expect(volcanicGroundIsPorous(world, center.x, center.z)).toBe(false);
  });

  it("raises no source on fresh ground and keeps every source on old ground", () => {
    const world = forcedWorld("kilo77");
    const center = landformCoreCenter(world);
    // The region 20 km south of the airport: its source halo has cells on
    // young cinder and on an old flank.
    const centerX = center.x;
    const centerZ = center.z - 20_000;
    const options = { centerX, centerZ, seaLevel: world.seaLevel };
    const inputs = volcanicHydrologyInputs(world, resolveHydrologyConfig(options));
    expect(inputs.sourceExcluded).toBeDefined();
    let dropped = 0;
    let keptOnOldCover = 0;
    const without = region(world, centerX, centerZ, false);
    const withInputs = generateHydrology({
      ...options,
      ...inputs,
      sourceExcluded: (x, z) => {
        const excluded = inputs.sourceExcluded!(x, z);
        const ground = sampleVolcanicGround(world, x, z, 0);
        const covered = Math.max(ground.lavaCover, ground.tephraCover) > VOLCANIC_POROUS_COVER;
        expect(excluded).toBe(covered && ground.age < VOLCANIC_POROUS_AGE);
        if (excluded) dropped += 1;
        else if (covered) keptOnOldCover += 1;
        return excluded;
      },
      worldSeed: world.seed,
      terrainSample: workerSampler(world),
    });
    expect(dropped).toBeGreaterThan(0);
    expect(keptOnOldCover).toBeGreaterThan(0);
    // Ownership never moves: the same lattice cells, fewer sources on them.
    expect(withInputs.statistics.haloSourceCellCount).toBe(without.statistics.haloSourceCellCount);
    expect(withInputs.statistics.candidateSourceCount)
      .toBeLessThan(without.statistics.candidateSourceCount);
    expect(withInputs.statistics.candidateSourceCount)
      .toBeGreaterThanOrEqual(without.statistics.candidateSourceCount - dropped);
  });
});

describe("containment: no volcanic water in the landform core", () => {
  it("gives the regions round the start airport no volcanic inputs at all", () => {
    for (const seed of ["kilo77", "phase1-perf-baseline", "terra1", "open-skies"]) {
      const world = createWorld(seed);
      const airport = world.airport!;
      const config = resolveHydrologyConfig({ centerX: airport.centerX, centerZ: airport.centerZ });
      const paging = resolveHydrologyPagingConfig(airport.centerX, airport.centerZ, config.extentMeters);
      const step = paging.spacingMeters;
      for (const [dx, dz] of [[0, 0], [step, 0], [-step, 0], [0, step], [0, -step]] as const) {
        const selection = selectHydrologyRegion({
          x: airport.centerX + dx,
          z: airport.centerZ + dz,
          velocityX: 0,
          velocityZ: 0,
        }, paging);
        const inputs = volcanicHydrologyInputs(world, resolveHydrologyConfig({
          centerX: selection.centerX,
          centerZ: selection.centerZ,
        }));
        expect(Object.keys(inputs)).toEqual([]);
      }
    }
  });
});

describe("the hydrology worker", () => {
  type Listener = (event: { data: unknown }) => void;
  const listeners: Listener[] = [];
  const posts: HydrologyWorkerEvent[] = [];

  beforeAll(async () => {
    vi.stubGlobal("self", {
      addEventListener: (type: string, listener: Listener) => {
        if (type === "message") listeners.push(listener);
      },
      // Structured-cloned like a real worker boundary: a function anywhere in
      // the result would throw a DataCloneError here.
      postMessage: (event: unknown, transfer: Transferable[] = []) => {
        posts.push(structuredClone(event, { transfer }) as HydrologyWorkerEvent);
      },
    });
    await import("../src/workers/hydrology.worker");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function workerRegion(seed: string, centerX: number, centerZ: number, seaLevel: number): HydrologyGenerationResult {
    const send = (command: HydrologyWorkerCommand): void => {
      const cloned = structuredClone(command);
      for (const listener of listeners) listener({ data: cloned });
    };
    send({ type: "initialize", worldSeed: seed });
    posts.length = 0;
    send({
      type: "generate",
      requestId: 1,
      generation: 1,
      key: `${centerX}:${centerZ}`,
      options: { centerX, centerZ, seaLevel },
    });
    const event = posts.at(-1);
    if (event?.type !== "region") throw new Error(`worker answered ${JSON.stringify(event)}`);
    return event.hydrology;
  }

  it("authors the crater lakes of its own world, as the direct generator does", () => {
    // Natural "kilo77": a 736 m maar 143 km from the airport, its lake at 95.1 m.
    const world = createWorld("kilo77");
    const site = siteById(world, 34_365_504_705);
    const fromWorker = workerRegion("kilo77", site.x, site.z, world.seaLevel);
    const lake = craterLake(fromWorker, site)!;
    expect(lake).toBeDefined();
    expect(lake.surfaceHeight)
      .toBe(site.lakeLevelMeters + fromWorker.config.riverSurfaceOffsetMeters);
    expect(bits(fromWorker)).toBe(bits(region(world, site.x, site.z)));
  });

  it("is matched by the main-thread fallback, given the same world inputs", () => {
    const world = createWorld("kilo77");
    const site = siteById(world, 34_365_504_705);
    // No worker seed: the client generates on the main thread, at once.
    const client = new HydrologyGenerationClient({
      worldSeed: world.seed,
      terrainSample: workerSampler(world),
      worldInputs: (config) => volcanicHydrologyInputs(world, config),
      fallbackScheduler: (callback) => callback(),
    });
    let fallback: HydrologyGenerationResult | null = null;
    client.request(
      {
        key: "maar",
        generation: 1,
        options: { centerX: site.x, centerZ: site.z, seaLevel: world.seaLevel },
      },
      (result) => {
        expect(result.workerGenerated).toBe(false);
        fallback = result.hydrology;
      },
    );
    client.dispose();
    expect(fallback).not.toBeNull();
    expect(craterLake(fallback!, site)).toBeDefined();
    expect(bits(fallback)).toBe(bits(workerRegion("kilo77", site.x, site.z, world.seaLevel)));
  });

  it("generates the start airport's region exactly as before", () => {
    const world = createWorld("kilo77");
    const airport = world.airport!;
    const fromWorker = workerRegion("kilo77", airport.centerX, airport.centerZ, world.seaLevel);
    expect(bits(fromWorker)).toBe(bits(region(world, airport.centerX, airport.centerZ, false)));
  });
});
