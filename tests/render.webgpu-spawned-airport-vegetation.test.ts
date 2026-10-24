import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  airportReachIntersectsBounds,
  airportVegetationReach,
} from "../src/render/webgpu/airfield/AirportFootprint";
import {
  HANGAR_SITING,
  hangarFootprint,
  hangarYawRadians,
} from "../src/render/webgpu/airfield/AirfieldStructures";
import {
  airfieldStructureExclusionSites,
  structureExclusionSiteBounds,
} from "../src/render/webgpu/airfield/StructureExclusion";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  DETAIL_CELL_SAMPLE_MARGIN_METERS,
  generateDetailCell,
} from "../src/render/webgpu/detail/generation";
import type { GeneratedDetailCell } from "../src/render/webgpu/detail/types";
import { WorldDetailRuntime } from "../src/render/webgpu/detail/WorldDetailRuntime";
import type {
  DetailRetainedCellDescriptor,
  DetailWorkerCommand,
  DetailWorkerEvent,
} from "../src/workers/detailProtocol";
import { DetailWorkerRuntime } from "../src/workers/detail.worker";
import {
  TerrainBiome,
  createWorld,
  findSpawnedAirport,
  getAirportInfluence,
  sampleTerrain,
  withAirports,
  worldToRunway,
  type AirportDefinition,
  type WorldDefinition,
} from "../src/world";

/**
 * A runway that spawns mid-flight must not spawn into a forest.
 *
 * Before airports could spawn, the detail worker held a world with exactly one
 * airport and built that airport's structure exclusions once, so a spawned
 * runway's platform read as natural ground (influence 0) and its hangars had no
 * exclusion at all — measured on the `alpha` spawn below, 445 stems stood on the
 * new platform and 24 inside or against its hangars. These pin the two halves of
 * the fix: generation honours EVERY airport's structures in its own frame, and
 * `WorldDetailRuntime.setAirports` regenerates exactly the cells the new airport
 * can reach, through the worker, against the new world.
 */

const CELL = 256;

interface Spawn {
  readonly world: WorldDefinition;
  readonly spawned: Readonly<AirportDefinition>;
  readonly next: WorldDefinition;
}

/** One anchored spawn search run to completion, as the game loop runs it over frames. */
function spawnedWorld(seed = "alpha"): Spawn {
  const world = createWorld(seed);
  const home = world.airport!;
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, home.centerX + 15_000, home.centerZ, Math.PI / 2, attempt);
    if (result === "exhausted") throw new Error(`${seed} found no spawn site`);
    if (result) return { world, spawned: result, next: withAirports(world, [...world.airports, result]) };
  }
}

/** Inside the paved runway rectangle (no margin). */
function onRunway(airport: Readonly<AirportDefinition>, x: number, z: number): boolean {
  const local = worldToRunway(airport, x, z);
  return Math.abs(local.along) <= airport.runwayLength / 2
    && Math.abs(local.across) <= airport.runwayWidth / 2;
}

/**
 * Inside a hangar's own walls, from the footprint and yaw `AirportSystem` builds
 * it with — stated independently of `StructureExclusion`, so the exclusion is
 * checked against the building rather than against itself.
 */
function inHangar(airport: Readonly<AirportDefinition>, seedHash: number, x: number, z: number): boolean {
  const local = worldToRunway(airport, x, z);
  for (let index = 0; index < HANGAR_SITING.count; index += 1) {
    const footprint = hangarFootprint(airport, index);
    const yaw = hangarYawRadians(seedHash, index);
    const dAlong = local.along - footprint.along;
    const dAcross = local.across - footprint.across;
    const along = dAlong * Math.cos(-yaw) - dAcross * Math.sin(-yaw);
    const across = dAlong * Math.sin(-yaw) + dAcross * Math.cos(-yaw);
    if (Math.abs(along) <= footprint.depthMeters / 2 && Math.abs(across) <= footprint.widthMeters / 2) {
      return true;
    }
  }
  return false;
}

type Placed = readonly { readonly x: number; readonly z: number }[];

function woody(cell: GeneratedDetailCell): Placed {
  return [...cell.trees, ...cell.shrubs, ...cell.clutter, ...cell.rocks];
}

function count(placed: Placed, test: (x: number, z: number) => boolean): number {
  return placed.reduce((n, p) => n + (test(p.x, p.z) ? 1 : 0), 0);
}

/** The cells under the spawned runway centre and each of its hangars. */
function airfieldCells(airport: Readonly<AirportDefinition>): readonly (readonly [number, number])[] {
  const keys = new Map<string, readonly [number, number]>();
  const add = (along: number, across: number): void => {
    const x = airport.centerX + along * Math.sin(airport.headingRadians) + across * Math.cos(airport.headingRadians);
    const z = airport.centerZ + along * Math.cos(airport.headingRadians) - across * Math.sin(airport.headingRadians);
    const cell = [Math.floor(x / CELL), Math.floor(z / CELL)] as const;
    keys.set(cell.join(":"), cell);
  };
  for (const along of [-600, -300, 0, 300, 600]) add(along, 0);
  for (let index = 0; index < HANGAR_SITING.count; index += 1) {
    const footprint = hangarFootprint(airport, index);
    add(footprint.along, footprint.across);
  }
  return [...keys.values()];
}

describe("vegetation on a spawned airfield", () => {
  it("keeps the spawned runway and its hangars clear, and the clearing is the spawned site's own", () => {
    const { world, spawned, next } = spawnedWorld();
    // **ARMED BY CONSTRUCTION.** Closed damp forest everywhere, with only the
    // airport influence read from a real world — so the population inside the
    // runway and the hangars is decided by the airport terms alone, and the
    // control below proves there is a population to remove.
    const forest = (source: WorldDefinition) => (x: number, z: number) => ({
      height: 40,
      slope: 0.02,
      moisture: 0.8,
      biome: TerrainBiome.FOREST,
      airportInfluence: sampleTerrain(source, x, z).airportInfluence,
    });
    const generate = (
      cellX: number,
      cellZ: number,
      source: WorldDefinition,
      sites: WorldDefinition,
    ): GeneratedDetailCell => generateDetailCell({
      worldSeed: world.seed,
      cellX,
      cellZ,
      cellSizeMeters: CELL,
      terrainSample: forest(source),
      seaLevelMeters: world.seaLevel,
      structureExclusionSites: airfieldStructureExclusionSites(sites.airports, sites.seedHash),
    });

    let controlRunway = 0;
    let controlHangar = 0;
    let homeSitesHangar = 0;
    let gatedRunway = 0;
    let gatedHangar = 0;
    let gatedTotal = 0;
    for (const [cellX, cellZ] of airfieldCells(spawned)) {
      const runway = (x: number, z: number) => onRunway(spawned, x, z);
      const hangar = (x: number, z: number) => inHangar(spawned, world.seedHash, x, z);
      // Control: the world before the spawn — no influence, no exclusions there.
      const control = woody(generate(cellX, cellZ, world, world));
      controlRunway += count(control, runway);
      controlHangar += count(control, hangar);
      // The new ground, but only the HOME field's structures: the influence thins
      // the hangar apron and cannot empty it, so this must still find stems.
      homeSitesHangar += count(woody(generate(cellX, cellZ, next, world)), hangar);
      const gated = woody(generate(cellX, cellZ, next, next));
      gatedRunway += count(gated, runway);
      gatedHangar += count(gated, hangar);
      gatedTotal += gated.length;
    }
    expect(controlRunway, "the control grew nothing on the runway — the test is not armed").toBeGreaterThan(0);
    expect(controlHangar, "the control grew nothing in the hangars — the test is not armed").toBeGreaterThan(0);
    expect(
      homeSitesHangar,
      "stems in the spawned hangars vanished with only the home field's exclusions — "
      + "the influence alone is clearing them, so the next assertion cannot tell whether "
      + "the spawned site's own boxes are applied",
    ).toBeGreaterThan(0);
    expect(gatedRunway, "vegetation stands on the spawned paved runway").toBe(0);
    expect(gatedHangar, "vegetation stands inside a spawned hangar").toBe(0);
    expect(gatedTotal, "the spawned airfield's cells were emptied outright").toBeGreaterThan(0);
  });

  it("drops a site only where its clearance is exactly 1, so the home field is bit-identical", () => {
    const { world, next } = spawnedWorld();
    const home = world.airport!;
    const sample = (x: number, z: number) => sampleTerrain(world, x, z);
    const homeSites = airfieldStructureExclusionSites(world.airports, world.seedHash);
    const homeBounds = structureExclusionSiteBounds(homeSites[0]!);
    // A cell on the home field's hangars, and one well outside every site.
    const hangar = hangarFootprint(home, 1);
    const hx = home.centerX + hangar.along * Math.sin(home.headingRadians) + hangar.across * Math.cos(home.headingRadians);
    const hz = home.centerZ + hangar.along * Math.cos(home.headingRadians) - hangar.across * Math.sin(home.headingRadians);
    const far = [Math.floor((homeBounds.maxX + 900) / CELL), Math.floor(hz / CELL)] as const;
    for (const [cellX, cellZ] of [[Math.floor(hx / CELL), Math.floor(hz / CELL)] as const, far]) {
      const options = {
        worldSeed: world.seed, cellX, cellZ, cellSizeMeters: CELL, terrainSample: sample,
        seaLevelMeters: world.seaLevel, dayOfYear: 0, latitudeDegrees: world.latitudeDegrees,
      };
      // The legacy single-airport pair, exactly as the worker used to pass it.
      const legacy = generateDetailCell({
        ...options,
        structureExclusions: homeSites[0]!.boxes,
        exclusionAirport: home,
      });
      // The per-airport list with a spawned field kilometres away in it.
      const sites = generateDetailCell({
        ...options,
        structureExclusionSites: airfieldStructureExclusionSites(next.airports, next.seedHash),
      });
      expect(sites).toEqual(legacy);
    }
  });

  it("makes the detail worker generate against the new airport list", () => {
    const { world, spawned, next } = spawnedWorld();
    const events: DetailWorkerEvent[] = [];
    const worker = new DetailWorkerRuntime((event) => events.push(event), () => undefined);
    worker.handleCommand({
      type: "initialize", worldSeed: world.seed, world, cellSizeMeters: CELL, seaLevelMeters: world.seaLevel,
    });
    let requestId = 0;
    const generate = (cellX: number, cellZ: number): GeneratedDetailCell => {
      requestId += 1;
      worker.handleCommand({
        type: "generate", requestId, generation: 0, key: `${cellX}:${cellZ}`,
        cellX, cellZ, densityMultiplier: 1, dayOfYear: 0,
      });
      const event = events.pop();
      if (event?.type !== "cell") throw new Error(`expected a cell, got ${event?.type}`);
      return event.cell;
    };
    const cells = airfieldCells(spawned);
    const before = cells.map(([x, z]) => generate(x, z));
    worker.handleCommand({ type: "airports", airports: next.airports });
    const after = cells.map(([x, z]) => generate(x, z));
    const nextSites = airfieldStructureExclusionSites(next.airports, next.seedHash);

    let platformBefore = 0;
    for (let index = 0; index < cells.length; index += 1) {
      const [cellX, cellZ] = cells[index]!;
      // Parity: exactly what the inline path generates from the new world.
      expect(after[index]).toEqual(generateDetailCell({
        worldSeed: next.seed, cellX, cellZ, cellSizeMeters: CELL, densityMultiplier: 1,
        terrainSample: (x, z) => sampleTerrain(next, x, z), seaLevelMeters: next.seaLevel,
        dayOfYear: 0, latitudeDegrees: next.latitudeDegrees, structureExclusionSites: nextSites,
      }));
      const platform = (x: number, z: number) => getAirportInfluence(spawned, x, z) >= 1;
      platformBefore += count(woody(before[index]!), platform);
      expect(count(woody(after[index]!), (x, z) => onRunway(spawned, x, z))).toBe(0);
      expect(count(woody(after[index]!), (x, z) => inHangar(spawned, next.seedHash, x, z))).toBe(0);
    }
    expect(platformBefore, "the natural ground under the spawned platform carried nothing — "
      + "the worker's world swap is untested").toBeGreaterThan(0);
    // The same list again is a no-op, not a second world.
    worker.handleCommand({ type: "airports", airports: next.airports });
    expect(generate(cells[0]![0], cells[0]![1])).toEqual(after[0]);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration: which cells a spawn invalidates.
// ---------------------------------------------------------------------------

type Listener = EventListenerOrEventListenerObject;

/** Browser-worker transport over the real worker runtime, flushed by the test. */
class WorkerBridge {
  readonly commands: DetailWorkerCommand[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks: Array<() => void> = [];
  private readonly outbound: DetailWorkerEvent[] = [];
  private readonly runtime = new DetailWorkerRuntime(
    (event) => this.outbound.push(event),
    (callback) => this.tasks.push(callback),
  );

  postMessage(command: DetailWorkerCommand): void {
    this.commands.push(command);
    this.runtime.handleCommand(command);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  flush(): void {
    while (this.tasks.length > 0 || this.outbound.length > 0) {
      while (this.tasks.length > 0) this.tasks.shift()!();
      for (const data of this.outbound.splice(0)) {
        const event = { data } as unknown as Event;
        for (const listener of [...(this.listeners.get("message") ?? [])]) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      }
    }
  }
}

interface ResidentView {
  readonly cellX: number;
  readonly cellZ: number;
  readonly revision: number;
  readonly invalidated: boolean;
  readonly descriptor?: DetailRetainedCellDescriptor;
  readonly cell?: GeneratedDetailCell;
}

function residents(runtime: WorldDetailRuntime): Map<string, ResidentView> {
  return (runtime as unknown as { cells: Map<string, ResidentView> }).cells;
}

function quality() {
  return {
    ...resolveWebGpuQualityProfile("medium", "balanced"),
    vegetationDistance: 900,
    vegetationDensity: 0.55,
    grassRadiusMeters: 36,
  };
}

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/** The cells whose sample footprint meets the spawned airport's vegetation reach. */
function reachedCells(keys: Iterable<string>, spawn: Spawn): Set<string> {
  const reach = airportVegetationReach(spawn.spawned, spawn.next.seedHash);
  const margin = DETAIL_CELL_SAMPLE_MARGIN_METERS;
  return new Set([...keys].filter((key) => {
    const [cellX, cellZ] = key.split(":").map(Number) as [number, number];
    return airportReachIntersectsBounds(reach, {
      minX: cellX * CELL - margin,
      minZ: cellZ * CELL - margin,
      maxX: (cellX + 1) * CELL + margin,
      maxZ: (cellZ + 1) * CELL + margin,
    });
  }));
}

describe("WorldDetailRuntime.setAirports", () => {
  it("invalidates exactly the cells a spawned airport reaches, through the worker", () => {
    const spawn = spawnedWorld();
    const { world, spawned, next } = spawn;
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const bridge = new WorkerBridge();
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: world.seed,
      terrainSample: (x, z) => sampleTerrain(world, x, z),
      cellSizeMeters: CELL,
      seaLevelMeters: world.seaLevel,
      latitudeDegrees: world.latitudeDegrees,
      workerWorldSeed: world.seed,
      workerWorld: world,
      detailWorkerFactory: () => bridge as unknown as Worker,
      presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    });
    // Beside the runway, so the resident set straddles the airport's reach.
    const observer = { x: spawned.centerX + 350, y: 400, z: spawned.centerZ };
    const settle = (): void => {
      for (let pass = 0; pass < 200; pass += 1) {
        runtime.update(observer, ORIGIN, quality());
        bridge.flush();
        if (runtime.pendingWorkItems === 0) return;
      }
      throw new Error("detail runtime did not settle");
    };
    try {
      settle();
      const before = new Map(
        [...residents(runtime)].map(([key, resident]) => [key, resident.descriptor!.token]),
      );
      const expected = reachedCells(before.keys(), spawn);
      expect(expected.size, "no resident cell meets the spawned airport").toBeGreaterThan(0);
      expect(expected.size, "every resident meets the airport — exactness is untested")
        .toBeLessThan(before.size);

      const posted = bridge.commands.length;
      expect(runtime.setAirports(next.airports)).toBe(expected.size);
      const sent = bridge.commands.slice(posted);
      // The world swap goes first, then exactly the reached tokens are released.
      expect(sent[0]).toEqual({ type: "airports", airports: next.airports });
      const released = sent.filter((command) => command.type === "releaseCell")
        .map((command) => (command as { token: number }).token);
      expect(new Set(released)).toEqual(new Set([...expected].map((key) => before.get(key))));
      // Invalidated cells keep drawing until replaced: nothing left the map.
      expect(new Set(residents(runtime).keys())).toEqual(new Set(before.keys()));

      settle();
      for (const [key, token] of before) {
        const resident = residents(runtime).get(key)!;
        if (expected.has(key)) expect(resident.descriptor!.token, key).not.toBe(token);
        else expect(resident.descriptor!.token, key).toBe(token);
      }

      // Nothing outside the reach needed regenerating: those cells come out of
      // the new world byte-identical to the old.
      const options = (source: WorldDefinition, cellX: number, cellZ: number) => ({
        worldSeed: source.seed, cellX, cellZ, cellSizeMeters: CELL, densityMultiplier: 0.55,
        terrainSample: (x: number, z: number) => sampleTerrain(source, x, z),
        seaLevelMeters: source.seaLevel, dayOfYear: 0, latitudeDegrees: source.latitudeDegrees,
        structureExclusionSites: airfieldStructureExclusionSites(source.airports, source.seedHash),
      });
      let changedInside = 0;
      for (const key of before.keys()) {
        const [cellX, cellZ] = key.split(":").map(Number) as [number, number];
        const old = generateDetailCell(options(world, cellX, cellZ));
        const fresh = generateDetailCell(options(next, cellX, cellZ));
        if (!expected.has(key)) expect(fresh, `${key} changed outside the reach`).toEqual(old);
        else if (JSON.stringify(fresh) !== JSON.stringify(old)) changedInside += 1;
      }
      expect(changedInside, "no reached cell actually changed").toBeGreaterThan(0);

      // The same list again does nothing at all.
      const quiet = bridge.commands.length;
      expect(runtime.setAirports(next.airports)).toBe(0);
      expect(bridge.commands.length).toBe(quiet);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("regenerates reached inline cells against the live sampler and the new structures", () => {
    const spawn = spawnedWorld();
    const { world, spawned, next } = spawn;
    let live = world;
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: world.seed,
      // The renderer hands detail an airport-aware sampler; this one reads `live`.
      terrainSample: (x, z) => sampleTerrain(live, x, z),
      cellSizeMeters: CELL,
      seaLevelMeters: world.seaLevel,
      latitudeDegrees: world.latitudeDegrees,
      workerWorld: world,
      presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    });
    const hangar = hangarFootprint(spawned, 1);
    const observer = {
      x: spawned.centerX + hangar.along * Math.sin(spawned.headingRadians)
        + hangar.across * Math.cos(spawned.headingRadians),
      y: 300,
      z: spawned.centerZ + hangar.along * Math.cos(spawned.headingRadians)
        - hangar.across * Math.sin(spawned.headingRadians),
    };
    const settle = (): void => {
      for (let pass = 0; pass < 200; pass += 1) {
        runtime.update(observer, ORIGIN, quality());
        if (runtime.pendingWorkItems === 0) return;
      }
      throw new Error("detail runtime did not settle");
    };
    try {
      settle();
      const before = new Map([...residents(runtime)].map(([key, r]) => [key, r.revision]));
      const expected = reachedCells(before.keys(), spawn);
      live = next;
      expect(runtime.setAirports(next.airports)).toBe(expected.size);
      settle();
      let stems = 0;
      for (const [key, resident] of residents(runtime)) {
        if (!expected.has(key)) {
          expect(resident.revision, key).toBe(before.get(key));
          continue;
        }
        expect(resident.revision, key).not.toBe(before.get(key));
        const placed = woody(resident.cell!);
        stems += placed.length;
        expect(count(placed, (x, z) => onRunway(spawned, x, z)), key).toBe(0);
        expect(count(placed, (x, z) => inHangar(spawned, next.seedHash, x, z)), key).toBe(0);
      }
      expect(stems, "the reached cells regenerated empty").toBeGreaterThan(0);
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
