import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FlightVisualState } from "@/src/game/types";
import { WORLD_PAGE_BASE_EXTENT_METERS, WORLD_PAGE_HEIGHT_CORE } from "@/src/render/webgpu/world/pageGeometry";
import { HYDROLOGY_EVICTION_KEEP_METERS, packHydrologyWater, type HydrologyWaterLake } from "@/src/sim/water/hydrologyWater";
import { clearInfrastructureRegions } from "@/src/world/infrastructure";
import { InfrastructureRegionsForwarder } from "@/src/world/infrastructureSync";
import { createWorld } from "@/src/world/world";
import type { SimulationCommand, SimulationEvent } from "@/src/workers/protocol";

/**
 * The car in the simulation worker itself, wading a lake the renderer
 * posted (`hydrology`): the worker module loaded into a module graph of its
 * own as a real worker has, its tick run on fake timers, its snapshots read
 * back. The lake comes and goes by the posts alone: replaced under its key,
 * and kept on an eviction while the car is near it.
 */

const world = createWorld();

interface WorkerRealm {
  send(command: SimulationCommand): void;
  groundHeight(x: number, z: number): number;
  latest(): FlightVisualState;
}

let realm: WorkerRealm;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  let listener: ((event: { data: SimulationCommand }) => void) | null = null;
  let latest: FlightVisualState | null = null;
  vi.stubGlobal("self", {
    addEventListener: (type: string, handler: typeof listener) => {
      if (type === "message") listener = handler;
    },
    postMessage: (event: SimulationEvent) => {
      if (event.type === "error") throw new Error(event.message);
      latest = event.state;
    },
  });
  await import("@/src/workers/simulation.worker");
  const grid = await import("@/src/sim/terrainGrid");
  let workerWorld = world;
  realm = {
    send: (command) => {
      const cloned = structuredClone(command);
      if (cloned.type === "initialize") workerWorld = cloned.world;
      listener!({ data: cloned });
    },
    groundHeight: (x, z) => grid.sampleGroundHeight(workerWorld, x, z),
    latest: () => latest!,
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  clearInfrastructureRegions();
});

function wading(): number {
  const vehicle = realm.latest().vehicle;
  if (vehicle?.kind !== "car") throw new Error("expected a car session");
  return vehicle.wadingDepth;
}

/** A round lake of radius 60 m about (x, z) at `level`. */
function lake(x: number, z: number, level: number): HydrologyWaterLake {
  const boundary = [];
  for (let i = 0; i < 32; i += 1) {
    const angle = (i / 32) * 2 * Math.PI;
    boundary.push({ x: x + 60 * Math.cos(angle), z: z + 60 * Math.sin(angle) });
  }
  return { surfaceHeight: level, boundary };
}

describe("the simulation worker's lakes and rivers, for the car", () => {
  it("wades a posted lake, keeps it on an eviction while near, and dries when it is replaced", () => {
    const infrastructure = new InfrastructureRegionsForwarder(world).initial();
    realm.send({
      type: "initialize",
      world,
      aircraft: "trainer",
      surfaceVehicle: "landcruiser",
      carSetup: { gearbox: "automatic", manualClutch: false },
      mode: "scenic",
      spawn: "airfield",
      airborneStartAgl: 450,
      attractMode: false,
      weather: "breezy",
      infrastructure,
      dayOfYear: 171,
    });
    const start = realm.latest().position;
    // The L0 pages round the start, so the car's spawn gate opens; the
    // apron's own earthworks answer there whatever the pages hold.
    const tileX = Math.floor(start.x / WORLD_PAGE_BASE_EXTENT_METERS);
    const tileZ = Math.floor(start.z / WORLD_PAGE_BASE_EXTENT_METERS);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const heights = new Float32Array(WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE)
          .fill(realm.groundHeight(start.x, start.z));
        realm.send({
          type: "terrainPage",
          page: { level: 0, tileX: tileX + dx, tileZ: tileZ + dz, heights, infrastructureVersion: infrastructure.version },
        });
      }
    }
    // The worker starts paused, as the game leaves it until the drive begins.
    realm.send({ type: "pause", paused: false });
    vi.advanceTimersByTime(3_000);
    expect(realm.latest().simulationTime).toBeGreaterThan(2);
    expect(wading()).toBe(0);
    const at = realm.latest().position;
    const ground = realm.groundHeight(at.x, at.z);

    // 0.5 m of lake round the car.
    realm.send({ type: "hydrology", key: "0:0", region: packHydrologyWater([], [lake(at.x, at.z, ground + 0.5)]) });
    vi.advanceTimersByTime(1_000);
    expect(wading()).toBeGreaterThan(0.4);
    expect(wading()).toBeLessThan(0.6);

    // The renderer is done with it, but the car is in it: it stays.
    expect(HYDROLOGY_EVICTION_KEEP_METERS).toBeGreaterThan(60);
    realm.send({ type: "hydrologyEvict", key: "0:0" });
    vi.advanceTimersByTime(500);
    expect(wading()).toBeGreaterThan(0.4);

    // Posted again under its key, lower than the ground: it replaces the old, and the car is dry.
    realm.send({ type: "hydrology", key: "0:0", region: packHydrologyWater([], [lake(at.x, at.z, ground - 1)]) });
    vi.advanceTimersByTime(500);
    expect(wading()).toBe(0);
  });
});
