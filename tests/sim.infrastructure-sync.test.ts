import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { terrainPageAirportDomain } from "@/src/render/webgpu/terrain/AirportReach";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "@/src/render/webgpu/world/pageGeometry";
import type { TerrainCollisionSample } from "@/src/world";
import {
  changeInfrastructureRegions,
  clearInfrastructureRegions,
  INFRASTRUCTURE_MAX_PARAMS,
  infrastructureRegionsVersion,
  withStaticInfrastructure,
  type InfrastructureChange,
  type InfrastructureRegion,
} from "@/src/world/infrastructure";
import {
  INFRASTRUCTURE_CHANGE_LOG_LENGTH,
  INFRASTRUCTURE_POST_SEGMENT_FLOATS,
  InfrastructureChangeLog,
  InfrastructureRegionsForwarder,
  packInfrastructureRegionsUpdate,
  unpackInfrastructureRegionsPost,
  type InfrastructureRegionsUpdate,
} from "@/src/world/infrastructureSync";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { sampleTerrainCollisionHeight } from "@/src/world/terrain";
import { createWorld } from "@/src/world/world";
import type { SimulationCommand } from "@/src/workers/protocol";

/**
 * The simulation worker's copy of the streamed infrastructure stage (roads):
 * the worker module itself, loaded into a module graph of its own as a real
 * worker has, so its region registry is its own and only the posted updates
 * fill it. A car standing on a road fill must stand on the fill, whichever
 * of the worker's answers serves it: its L0 pages, or its analytic fallback
 * once a change has dropped the pages it touched.
 */

const world = createWorld();
const head = airportRoadHead(world)!;
const network = new RoadNetwork(world);
const majorRegion = roadRegionInfrastructure(network, network.region("major", roadRegionOf(head.startX), roadRegionOf(head.startZ)));

/** The point of the region's pieces where its earthworks raise the ground most. */
function highestFill(region: InfrastructureRegion): { x: number; z: number; lift: number } {
  changeInfrastructureRegions(world, [region]);
  let best = { x: 0, z: 0, lift: -Infinity };
  for (const segment of region.segments) {
    for (const t of [0.25, 0.5, 0.75]) {
      const x = segment.ax + (segment.bx - segment.ax) * t;
      const z = segment.az + (segment.bz - segment.az) * t;
      const lift = sampleTerrainCollisionHeight(world, x, z)
        - withStaticInfrastructure(() => sampleTerrainCollisionHeight(world, x, z));
      if (lift > best.lift) best = { x, z, lift };
    }
  }
  clearInfrastructureRegions();
  return best;
}

const fill = highestFill(majorRegion);
const spacing = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
const fillTile = { x: Math.floor(fill.x / WORLD_PAGE_BASE_EXTENT_METERS), z: Math.floor(fill.z / WORLD_PAGE_BASE_EXTENT_METERS) };

interface WorkerRealm {
  send(command: SimulationCommand): void;
  groundHeight(x: number, z: number): number;
  contactHeight(x: number, z: number): number;
}

let realm: WorkerRealm;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  let listener: ((event: { data: SimulationCommand }) => void) | null = null;
  vi.stubGlobal("self", {
    addEventListener: (type: string, handler: typeof listener) => {
      if (type === "message") listener = handler;
    },
    postMessage: () => undefined,
  });
  await import("@/src/workers/simulation.worker");
  const grid = await import("@/src/sim/terrainGrid");
  const contact: TerrainCollisionSample = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 1 };
  // The worker's own world: what `initialize` cloned across, airports and all.
  let workerWorld = world;
  realm = {
    send: (command) => {
      const cloned = structuredClone(command);
      if (cloned.type === "initialize") workerWorld = cloned.world;
      listener!({ data: cloned });
    },
    groundHeight: (x, z) => grid.sampleGroundHeight(workerWorld, x, z),
    contactHeight: (x, z) => grid.sampleGroundContact(workerWorld, x, z, contact).height,
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  clearInfrastructureRegions();
});

function initialize(infrastructure: InfrastructureRegionsUpdate): void {
  realm.send({
    type: "initialize",
    world,
    aircraft: "trainer",
    surfaceVehicle: null,
    carSetup: { gearbox: "automatic", manualClutch: false },
    mode: "unassisted",
    spawn: "airborne",
    airborneStartAgl: 450,
    attractMode: false,
    weather: "breezy",
    infrastructure: packInfrastructureRegionsUpdate(infrastructure),
    dayOfYear: 171,
  });
}

/** A 3 x 3 block of L0 pages round a tile, every height `value`: whoever answers inside it is plain. */
function publishBlock(tileX: number, tileZ: number, value: number, infrastructureVersion: number): void {
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      realm.send({
        type: "terrainPage",
        page: {
          level: 0,
          tileX: tileX + dx,
          tileZ: tileZ + dz,
          heights: new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE).fill(value),
          infrastructureVersion,
        },
      });
    }
  }
}

/** A point inside a tile, on its lattice, away from every edge. */
function insideTile(tileX: number, tileZ: number): { x: number; z: number } {
  return {
    x: (tileX * WORLD_PAGE_HEIGHT_CORE + 100) * spacing,
    z: (tileZ * WORLD_PAGE_HEIGHT_CORE + 100) * spacing,
  };
}

describe("the simulation worker's copy of the roads", () => {
  it("has a real fill to stand on", () => {
    // 2026-10-27: 1.44 m, 1.2 km down the road from the home airport.
    expect(fill.lift).toBeGreaterThan(1);
  });

  it("puts a car on a road fill at the fill's height from its first step, with no page yet", () => {
    changeInfrastructureRegions(world, [majorRegion]);
    const bare = withStaticInfrastructure(() => sampleTerrainCollisionHeight(world, fill.x, fill.z));
    // Its registry is its own: a worker told of no region stands on bare ground.
    initialize({ version: 0, reset: true, install: [], remove: [] });
    expect(realm.groundHeight(fill.x, fill.z)).toBe(bare);
    const forwarder = new InfrastructureRegionsForwarder(world);
    initialize(forwarder.initial());
    // The worker's analytic answer, from its own copy of the regions: the main thread's, exactly.
    const onFill = sampleTerrainCollisionHeight(world, fill.x, fill.z);
    expect(realm.groundHeight(fill.x, fill.z)).toBe(onFill);
    expect(realm.contactHeight(fill.x, fill.z)).toBe(onFill);
    expect(onFill - bare).toBe(fill.lift);
    clearInfrastructureRegions();
  });

  it("drops the pages a change touches, and answers from the new regions until their rebuilds arrive", () => {
    const forwarder = new InfrastructureRegionsForwarder(world);
    initialize(forwarder.initial());
    // Pages baked before the road came; one block far from it.
    const far = { x: fillTile.x + 40, z: fillTile.z - 40 };
    publishBlock(fillTile.x, fillTile.z, 1_234.5, infrastructureRegionsVersion(world));
    publishBlock(far.x, far.z, 987.25, infrastructureRegionsVersion(world));
    expect(realm.groundHeight(fill.x, fill.z)).toBeCloseTo(1_234.5, 3);
    const farPoint = insideTile(far.x, far.z);
    expect(realm.groundHeight(farPoint.x, farPoint.z)).toBeCloseTo(987.25, 3);

    // The road arrives on the main thread and the worker is told at once.
    const install = changeInfrastructureRegions(world, [majorRegion])!;
    const forwarded = forwarder.next({ version: install.version, reset: false, install: [majorRegion], remove: [] })!;
    realm.send({ type: "infrastructure", update: packInfrastructureRegionsUpdate(forwarded) });
    // The page under the fill predates the road: dropped, so the car stands on the fill.
    expect(realm.groundHeight(fill.x, fill.z)).toBe(sampleTerrainCollisionHeight(world, fill.x, fill.z));
    // Ground the road does not reach keeps its page.
    expect(realm.groundHeight(farPoint.x, farPoint.z)).toBeCloseTo(987.25, 3);

    // The rebuilt page arrives and serves.
    publishBlock(fillTile.x, fillTile.z, 1_111.5, install.version);
    expect(realm.groundHeight(fill.x, fill.z)).toBeCloseTo(1_111.5, 3);

    // The road leaves: that page goes too, and the bare ground answers.
    const remove = changeInfrastructureRegions(world, [], [majorRegion.key])!;
    realm.send({
      type: "infrastructure",
      update: packInfrastructureRegionsUpdate(forwarder.next({ version: remove.version, reset: false, install: [], remove: [majorRegion.key] })!),
    });
    expect(realm.groundHeight(fill.x, fill.z)).toBe(sampleTerrainCollisionHeight(world, fill.x, fill.z));
    expect(realm.groundHeight(fill.x, fill.z)).toBe(withStaticInfrastructure(() => sampleTerrainCollisionHeight(world, fill.x, fill.z)));
    expect(realm.groundHeight(farPoint.x, farPoint.z)).toBeCloseTo(987.25, 3);
    clearInfrastructureRegions();
  });

  it("is sent each change once, and the whole set after one it never saw", () => {
    const forwarder = new InfrastructureRegionsForwarder(world);
    initialize(forwarder.initial());
    const far = { x: fillTile.x - 30, z: fillTile.z + 30 };
    publishBlock(far.x, far.z, 555.5, infrastructureRegionsVersion(world));
    const install = changeInfrastructureRegions(world, [majorRegion])!;
    const update: InfrastructureRegionsUpdate = { version: install.version, reset: false, install: [majorRegion], remove: [] };
    expect(forwarder.next(update)).toBe(update);
    expect(forwarder.next(update)).toBeNull();
    // A change the forwarder missed: the next one goes as the whole set.
    const other: InfrastructureRegion = { key: "test:other", segments: [] };
    changeInfrastructureRegions(world, [other]);
    const remove = changeInfrastructureRegions(world, [], [other.key])!;
    const caughtUp = forwarder.next({ version: remove.version, reset: false, install: [], remove: [other.key] })!;
    expect(caughtUp.reset).toBe(true);
    expect(caughtUp.version).toBe(remove.version);
    expect(caughtUp.install.map((region) => region.key)).toEqual([majorRegion.key]);
    realm.send({ type: "infrastructure", update: packInfrastructureRegionsUpdate(caughtUp) });
    // A reset trusts no page it held; the regions are the main thread's.
    const farPoint = insideTile(far.x, far.z);
    expect(realm.groundHeight(farPoint.x, farPoint.z)).toBe(sampleTerrainCollisionHeight(world, farPoint.x, farPoint.z));
    expect(realm.groundHeight(fill.x, fill.z)).toBe(sampleTerrainCollisionHeight(world, fill.x, fill.z));
    clearInfrastructureRegions();
  });
});

describe("a late page publication", () => {
  it("is held back when a change after its bake touched it, and only then", () => {
    const log = new InfrastructureChangeLog();
    const before = infrastructureRegionsVersion(world);
    const change = changeInfrastructureRegions(world, [majorRegion])!;
    log.record(change);
    const under = terrainPageAirportDomain({ level: 0, x: fillTile.x, z: fillTile.z });
    const away = terrainPageAirportDomain({ level: 0, x: fillTile.x + 40, z: fillTile.z - 40 });
    expect(log.touchedSince(before, under)).toBe(true);
    expect(log.touchedSince(change.version, under)).toBe(false);
    expect(log.touchedSince(before, away)).toBe(false);
    clearInfrastructureRegions();
  });

  it("is held back when the log no longer reaches back to its bake", () => {
    const log = new InfrastructureChangeLog();
    const nowhere: InfrastructureChange = { version: 0, rects: [], bins: new Set(), plantBins: new Set() };
    for (let version = 1; version <= INFRASTRUCTURE_CHANGE_LOG_LENGTH + 1; version += 1) log.record({ ...nowhere, version });
    const away = terrainPageAirportDomain({ level: 0, x: 900, z: 900 });
    expect(log.touchedSince(1, away)).toBe(false);
    expect(log.touchedSince(0, away)).toBe(true);
  });
});

describe("an update as posted to a worker", () => {
  const bare: InfrastructureRegion = {
    key: "test:bare",
    segments: [
      // Every optional field left out, and a full set of parameters.
      { profile: 1, mode: "fill", priority: 3, ax: -1.5, az: 2.25, bx: 7, bz: -0.125, halfWidth: 4, reach: 9.5, params: [1, -2, 3.5, 0, 1e-9, -0, 7, 8] },
      { profile: 0, mode: "set", priority: 10, ax: 5, az: 5, bx: 5, bz: 5, halfWidth: 12, reach: 0, params: [], surface: "concrete", plantClearance: 0, key: 0 },
    ],
    rails: [{ points: [0, 0, 10, 0.5], heightMeters: 0.75 }],
  };

  it("unpacks to the regions it was made from, fields left out and all", () => {
    const update: InfrastructureRegionsUpdate = { version: 7, reset: true, install: [majorRegion, bare], remove: ["test:gone"] };
    const unpacked = unpackInfrastructureRegionsPost(structuredClone(packInfrastructureRegionsUpdate(update)));
    expect(unpacked).toStrictEqual(update);
    expect(Object.is(unpacked.install[1]!.segments[0]!.params[5], -0)).toBe(true);
    expect(majorRegion.segments.length).toBeGreaterThan(10);
  });

  it("packs a region once, however many workers it goes to", () => {
    const update: InfrastructureRegionsUpdate = { version: 1, reset: false, install: [bare], remove: [] };
    const first = packInfrastructureRegionsUpdate(update);
    expect(packInfrastructureRegionsUpdate(update).install[0]).toBe(first.install[0]);
    expect(first.install[0]!.segments).toBeInstanceOf(Float64Array);
    expect(first.install[0]!.segments.length).toBe(2 * INFRASTRUCTURE_POST_SEGMENT_FLOATS);
  });

  it("refuses a segment with more parameters than the stage reads", () => {
    const segment = { ...bare.segments[0]!, params: Array.from({ length: INFRASTRUCTURE_MAX_PARAMS + 1 }, () => 1) };
    const update: InfrastructureRegionsUpdate = { version: 1, reset: false, install: [{ key: "test:long", segments: [segment] }], remove: [] };
    expect(() => packInfrastructureRegionsUpdate(update)).toThrow(RangeError);
  });
});
