import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { airfieldStructureExclusionSites } from "@/src/render/webgpu/airfield/StructureExclusion";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  DETAIL_CELL_SAMPLE_MARGIN_METERS,
  detailCellPlantExclusions,
  generateDetailCell,
  STRUCTURE_SITE_CELL_MARGIN_METERS,
} from "@/src/render/webgpu/detail/generation";
import type { GeneratedDetailCell } from "@/src/render/webgpu/detail/types";
import { WorldDetailRuntime } from "@/src/render/webgpu/detail/WorldDetailRuntime";
import type {
  DetailRetainedCellDescriptor,
  DetailWorkerCommand,
  DetailWorkerEvent,
} from "@/src/workers/detailProtocol";
import type { DetailWorkerRuntime } from "@/src/workers/detail.worker";
import { sampleTerrain } from "@/src/world";
import {
  changeInfrastructureRegions,
  clearInfrastructureRegions,
  INFRASTRUCTURE_BIN_METERS,
  INFRASTRUCTURE_PLANT_BLEND_METERS,
  infrastructureIndex,
  infrastructurePlantExclusions,
  type InfrastructureChange,
  type InfrastructurePlantExclusion,
  type InfrastructureRegion,
} from "@/src/world/infrastructure";
import type { InfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { createWorld } from "@/src/world/world";

/**
 * Streamed roads in the detail scatter. A cell's plant exclusions come from
 * the live index's bins (`detailCellPlantExclusions`) and are exactly what
 * the full list kept, so the marina's cells generate bit for bit as before;
 * the detail worker, in a module graph of its own as a real worker is, takes
 * each change in order with its requests and grows nothing on the road from
 * the next one; and `WorldDetailRuntime.infrastructureChanged` regenerates
 * the cells the change reaches and no others.
 */

const CELL = 256;
const world = createWorld();
const head = airportRoadHead(world)!;
const network = new RoadNetwork(world);
const rx = roadRegionOf(head.startX);
const rz = roadRegionOf(head.startZ);
const regions: readonly InfrastructureRegion[] = (["major", "track"] as const)
  .map((layer) => roadRegionInfrastructure(network, network.region(layer, rx, rz)));
const sites = airfieldStructureExclusionSites(world.airports!, world.seedHash);

afterEach(() => clearInfrastructureRegions());

/** Install the home regions in this (the main thread's) registry: the change and its update. */
function installRoads(): { change: InfrastructureChange; update: InfrastructureRegionsUpdate } {
  const change = changeInfrastructureRegions(world, regions)!;
  return { change, update: { version: change.version, reset: false, install: regions, remove: [] } };
}

function removeRoads(): { change: InfrastructureChange; update: InfrastructureRegionsUpdate } {
  const remove = regions.map((region) => region.key);
  const change = changeInfrastructureRegions(world, [], remove)!;
  return { change, update: { version: change.version, reset: false, install: [], remove } };
}

/** The rule `generateDetailCell` keeps exclusions by, applied to the whole list. */
function keptFromFullList(
  all: readonly InfrastructurePlantExclusion[],
  cellX: number,
  cellZ: number,
): InfrastructurePlantExclusion[] {
  const margin = STRUCTURE_SITE_CELL_MARGIN_METERS;
  const minX = cellX * CELL;
  const minZ = cellZ * CELL;
  return all.filter((exclusion) => {
    const reach = exclusion.radius + INFRASTRUCTURE_PLANT_BLEND_METERS;
    return Math.min(exclusion.ax, exclusion.bx) - reach <= minX + CELL + margin
      && Math.max(exclusion.ax, exclusion.bx) + reach >= minX - margin
      && Math.min(exclusion.az, exclusion.bz) - reach <= minZ + CELL + margin
      && Math.max(exclusion.az, exclusion.bz) + reach >= minZ - margin;
  });
}

function distanceToCapsule(exclusion: InfrastructurePlantExclusion, x: number, z: number): number {
  const dx = exclusion.bx - exclusion.ax;
  const dz = exclusion.bz - exclusion.az;
  const t = Math.min(1, Math.max(0, ((x - exclusion.ax) * dx + (z - exclusion.az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (exclusion.ax + dx * t), z - (exclusion.az + dz * t));
}

/** Stems, rocks and logs on any of the exclusions' cleared ground. */
function onCleared(cell: GeneratedDetailCell, exclusions: readonly InfrastructurePlantExclusion[]): number {
  return [...cell.trees, ...cell.shrubs, ...cell.clutter, ...cell.rocks]
    .filter((p) => exclusions.some((e) => distanceToCapsule(e, p.x, p.z) <= e.radius)).length;
}

/** Generated as the detail worker does, against the stage as it is now. */
function generate(
  cellX: number,
  cellZ: number,
  plantExclusions = detailCellPlantExclusions(infrastructureIndex(world), cellX, cellZ, CELL),
): GeneratedDetailCell {
  return generateDetailCell({
    worldSeed: world.seed, cellX, cellZ, cellSizeMeters: CELL, densityMultiplier: 1,
    terrainSample: (x, z) => sampleTerrain(world, x, z), seaLevelMeters: world.seaLevel,
    dayOfYear: 0, latitudeDegrees: world.latitudeDegrees, structureExclusionSites: sites,
    plantExclusions,
  });
}

/** The marina's (static) exclusions, and a cell under the first. */
const marinaExclusions = infrastructurePlantExclusions(infrastructureIndex(world));
const marinaCell: readonly [number, number] = [
  Math.floor(0.5 * (marinaExclusions[0]!.ax + marinaExclusions[0]!.bx) / CELL),
  Math.floor(0.5 * (marinaExclusions[0]!.az + marinaExclusions[0]!.bz) / CELL),
];

/** The roads' exclusions alone. */
const roadExclusions: readonly InfrastructurePlantExclusion[] = (() => {
  const marina = new Set(marinaExclusions);
  installRoads();
  const all = infrastructurePlantExclusions(infrastructureIndex(world)).filter((e) => !marina.has(e));
  clearInfrastructureRegions();
  return all;
})();

/** The cell under the road exclusion furthest from the airport: wild ground, plenty growing. */
const roadCell: readonly [number, number] = (() => {
  const airport = world.airports![0]!;
  const from = (e: InfrastructurePlantExclusion) =>
    Math.hypot(0.5 * (e.ax + e.bx) - airport.centerX, 0.5 * (e.az + e.bz) - airport.centerZ);
  const far = [...roadExclusions].sort((a, b) => from(b) - from(a))[0]!;
  return [Math.floor(0.5 * (far.ax + far.bx) / CELL), Math.floor(0.5 * (far.az + far.bz) / CELL)];
})();

describe("a detail cell's plant exclusions from the live index", () => {
  it("are what the full list kept, in the same order, for every cell round the roads and the marina", () => {
    const check = (label: string): number => {
      const index = infrastructureIndex(world);
      const all = infrastructurePlantExclusions(index);
      let reached = 0;
      for (const [x0, z0] of [[Math.floor(head.startX / CELL), Math.floor(head.startZ / CELL)], marinaCell] as const) {
        for (let cellX = x0 - 12; cellX <= x0 + 12; cellX += 1) {
          for (let cellZ = z0 - 12; cellZ <= z0 + 12; cellZ += 1) {
            const kept = keptFromFullList(all, cellX, cellZ);
            expect(detailCellPlantExclusions(index, cellX, cellZ, CELL), `${label} ${cellX}:${cellZ}`).toEqual(kept);
            if (kept.length > 0) reached += 1;
          }
        }
      }
      return reached;
    };
    const marina = check("marina alone");
    expect(marina).toBeGreaterThan(0);
    installRoads();
    expect(check("with the roads")).toBeGreaterThan(marina + 20);
  });

  it("generate the marina's cells and the road's bit for bit as the full list did", () => {
    const marinaFull = infrastructurePlantExclusions(infrastructureIndex(world));
    expect(generate(...marinaCell)).toEqual(generate(...marinaCell, marinaFull));
    installRoads();
    const full = infrastructurePlantExclusions(infrastructureIndex(world));
    const built = generate(...roadCell);
    expect(built).toEqual(generate(...roadCell, full));
    expect(onCleared(built, roadExclusions)).toBe(0);
    // The road to the marina's car park reaches its cell too: still the full list's cell.
    expect(generate(...marinaCell)).toEqual(generate(...marinaCell, full));
  });
});

// ---------------------------------------------------------------------------
// The detail worker, in a module graph of its own.
// ---------------------------------------------------------------------------

let WorkerRuntime: typeof DetailWorkerRuntime;

beforeAll(async () => {
  vi.resetModules();
  ({ DetailWorkerRuntime: WorkerRuntime } = await import("@/src/workers/detail.worker"));
});

describe("the detail worker", () => {
  it("takes each change in order with its requests, and grows nothing on the road after it", () => {
    const events: DetailWorkerEvent[] = [];
    const worker = new WorkerRuntime((event) => events.push(event), () => undefined);
    worker.handleCommand({
      type: "initialize", worldSeed: world.seed, world, cellSizeMeters: CELL, seaLevelMeters: world.seaLevel,
      infrastructure: { version: 0, reset: true, install: [], remove: [] },
    });
    let requestId = 0;
    const fromWorker = ([cellX, cellZ]: readonly [number, number]): GeneratedDetailCell => {
      requestId += 1;
      worker.handleCommand({
        type: "generate", requestId, generation: 0, key: `${cellX}:${cellZ}`,
        cellX, cellZ, densityMultiplier: 1, dayOfYear: 0,
      });
      const event = events.pop();
      if (event?.type !== "cell") throw new Error(`expected a cell, got ${event?.type}`);
      return event.cell;
    };

    const bare = generate(...roadCell);
    expect(onCleared(bare, roadExclusions), "nothing grew where the road goes: the test is not armed")
      .toBeGreaterThan(10);
    expect(fromWorker(roadCell)).toEqual(bare);

    const { update } = installRoads();
    worker.handleCommand({ type: "infrastructure", update });
    const built = generate(...roadCell);
    expect(fromWorker(roadCell)).toEqual(built);
    expect(onCleared(built, roadExclusions)).toBe(0);

    worker.handleCommand({ type: "infrastructure", update: removeRoads().update });
    expect(fromWorker(roadCell)).toEqual(bare);
  });

  it("starts from the regions already installed", () => {
    installRoads();
    const events: DetailWorkerEvent[] = [];
    const worker = new WorkerRuntime((event) => events.push(event), () => undefined);
    worker.handleCommand({
      type: "initialize", worldSeed: world.seed, world, cellSizeMeters: CELL, seaLevelMeters: world.seaLevel,
      infrastructure: { version: 1, reset: true, install: regions, remove: [] },
    });
    worker.handleCommand({
      type: "generate", requestId: 1, generation: 0, key: roadCell.join(":"),
      cellX: roadCell[0], cellZ: roadCell[1], densityMultiplier: 1, dayOfYear: 0,
    });
    const event = events.pop();
    if (event?.type !== "cell") throw new Error(`expected a cell, got ${event?.type}`);
    expect(event.cell).toEqual(generate(...roadCell));
  });
});

// ---------------------------------------------------------------------------
// The runtime: which cells a change regenerates.
// ---------------------------------------------------------------------------

type Listener = EventListenerOrEventListenerObject;

/** Browser-worker transport over the separate-graph worker runtime, flushed by the test. */
class WorkerBridge {
  readonly commands: DetailWorkerCommand[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tasks: Array<() => void> = [];
  private readonly outbound: DetailWorkerEvent[] = [];
  private readonly runtime = new WorkerRuntime(
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
  readonly revision: number;
  readonly descriptor?: DetailRetainedCellDescriptor;
  readonly cell?: GeneratedDetailCell;
}

function residents(runtime: WorldDetailRuntime): Map<string, ResidentView> {
  return (runtime as unknown as { cells: Map<string, ResidentView> }).cells;
}

function quality() {
  return {
    ...resolveWebGpuQualityProfile("medium", "balanced"),
    vegetationDistance: 600,
    vegetationDensity: 0.55,
    grassRadiusMeters: 36,
  };
}

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/** Distance from a segment to a rectangle (0 when they meet), sampled finely. */
function segmentRectDistance(
  ax: number, az: number, bx: number, bz: number,
  minX: number, minZ: number, maxX: number, maxZ: number,
): number {
  let best = Infinity;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
  for (let i = 0; i <= steps; i += 1) {
    const x = ax + (bx - ax) * (i / steps);
    const z = az + (bz - az) * (i / steps);
    best = Math.min(best, Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ)));
  }
  return best;
}

/** How near a cell's sampled footprint comes to the roads' ground and plants, less each segment's reach. */
function clearance(key: string): number {
  const [cellX, cellZ] = key.split(":").map(Number) as [number, number];
  const margin = DETAIL_CELL_SAMPLE_MARGIN_METERS;
  let best = Infinity;
  for (const region of regions) {
    for (const s of region.segments) {
      const reach = s.halfWidth + s.reach
        + (s.plantClearance === undefined ? 0 : s.plantClearance + INFRASTRUCTURE_PLANT_BLEND_METERS);
      best = Math.min(best, segmentRectDistance(
        s.ax, s.az, s.bx, s.bz,
        cellX * CELL - margin, cellZ * CELL - margin, (cellX + 1) * CELL + margin, (cellZ + 1) * CELL + margin,
      ) - reach);
    }
  }
  return best;
}

/** A bin's diagonal and its metre of margin: how far past a road's reach a touched bin can lie. */
const SLACK = INFRASTRUCTURE_BIN_METERS * Math.SQRT2 + 1;

function observer() {
  return { x: (roadCell[0] + 0.5) * CELL, y: 300, z: (roadCell[1] + 0.5) * CELL };
}

describe("WorldDetailRuntime.infrastructureChanged", () => {
  it("regenerates inline exactly the cells the roads reach, against them, and no others", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new WorldDetailRuntime(scene, {
      worldSeed: world.seed,
      terrainSample: (x, z) => sampleTerrain(world, x, z),
      cellSizeMeters: CELL,
      seaLevelMeters: world.seaLevel,
      latitudeDegrees: world.latitudeDegrees,
      workerWorld: world,
      presentationRebuildBudget: { maximumWorkUnits: 1_000_000, maximumMilliseconds: 1_000_000 },
    });
    const settle = (): void => {
      for (let pass = 0; pass < 200; pass += 1) {
        runtime.update(observer(), ORIGIN, quality());
        if (runtime.pendingWorkItems === 0) return;
      }
      throw new Error("detail runtime did not settle");
    };
    try {
      settle();
      const before = new Map([...residents(runtime)].map(([key, resident]) => [key, resident.revision]));
      const { change, update } = installRoads();
      const invalidated = runtime.infrastructureChanged(update, change);
      settle();
      const regenerated = new Set([...residents(runtime)]
        .filter(([key, resident]) => resident.revision !== before.get(key))
        .map(([key]) => key));
      expect(new Set(residents(runtime).keys())).toEqual(new Set(before.keys()));
      expect(regenerated.size).toBe(invalidated);
      expect(regenerated.size, "every resident regenerated: exactness is untested").toBeLessThan(before.size);
      let reached = 0;
      for (const key of before.keys()) {
        const reach = clearance(key);
        if (reach <= 0) {
          reached += 1;
          expect(regenerated.has(key), `${key} reached`).toBe(true);
        }
        if (reach > SLACK) expect(regenerated.has(key), `${key} out of reach`).toBe(false);
      }
      expect(reached).toBeGreaterThan(0);
      for (const key of regenerated) {
        expect(onCleared(residents(runtime).get(key)!.cell!, roadExclusions), key).toBe(0);
      }
      // The kept cells nearest the roads are the same cells built on or not.
      const kept = [...before.keys()].filter((key) => !regenerated.has(key))
        .sort((a, b) => clearance(a) - clearance(b)).slice(0, 4);
      for (const key of kept) {
        const [cellX, cellZ] = key.split(":").map(Number) as [number, number];
        const withRoads = generate(cellX, cellZ);
        clearInfrastructureRegions();
        expect(generate(cellX, cellZ), `${key} changed outside the reach`).toEqual(withRoads);
        installRoads();
      }
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("posts the change to its worker before releasing exactly the cells it reaches", () => {
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
    const settle = (): void => {
      for (let pass = 0; pass < 200; pass += 1) {
        runtime.update(observer(), ORIGIN, quality());
        bridge.flush();
        if (runtime.pendingWorkItems === 0) return;
      }
      throw new Error("detail runtime did not settle");
    };
    try {
      settle();
      expect(bridge.commands[0]).toMatchObject({
        type: "initialize",
        infrastructure: { reset: true, install: [], remove: [] },
      });
      const before = new Map([...residents(runtime)].map(([key, resident]) => [key, resident.descriptor!.token]));
      const posted = bridge.commands.length;
      const { change, update } = installRoads();
      const invalidated = runtime.infrastructureChanged(update, change);
      const sent = bridge.commands.slice(posted);
      expect(sent[0]).toEqual({ type: "infrastructure", update });
      const released = sent.filter((command) => command.type === "releaseCell")
        .map((command) => (command as { token: number }).token);
      expect(released).toHaveLength(invalidated);
      expect(invalidated).toBeGreaterThan(0);
      expect(invalidated).toBeLessThan(before.size);

      settle();
      for (const [key, token] of before) {
        const replaced = residents(runtime).get(key)!.descriptor!.token !== token;
        expect(replaced, key).toBe(released.includes(token));
      }
    } finally {
      runtime.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
