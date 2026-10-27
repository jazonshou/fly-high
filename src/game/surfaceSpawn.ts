import type { AircraftKind } from "@/src/sim";
import type { SurfaceVehicleSpawn } from "@/src/sim/surface/types";
import { sampleGroundHeight } from "@/src/sim/terrainGrid";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { isSurfaceSpawn, type SpawnKind } from "@/src/workers/protocol";
import { runwayToWorld, sampleTerrainHeight, type WorldDefinition } from "@/src/world";
import { marinaStartPose } from "@/src/world/marina";
import { createSimulationSpawn } from "./spawn";

/** Water at least this deep, with `OPEN_WATER_CLEARANCE` of it around, counts as open. */
export const OPEN_WATER_DEPTH = 4;
export const OPEN_WATER_CLEARANCE = 150;
const RING_STEP = 250;
const MAX_SEARCH_RADIUS = 40_000;
const HEADING_DIRECTIONS = 16;
const HEADING_RUN_STEP = 100;
const HEADING_RUN_MAX = 1_500;

export interface OpenWaterPoint {
  x: number;
  z: number;
  /** Still-water depth at the point, metres. */
  depth: number;
}

function depthAt(world: WorldDefinition, x: number, z: number): number {
  return world.seaLevel - sampleTerrainHeight(world, x, z);
}

function isOpenWater(world: WorldDefinition, x: number, z: number): boolean {
  if (depthAt(world, x, z) < OPEN_WATER_DEPTH) return false;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const px = x + Math.cos(angle) * OPEN_WATER_CLEARANCE;
    const pz = z + Math.sin(angle) * OPEN_WATER_CLEARANCE;
    if (depthAt(world, px, pz) < OPEN_WATER_DEPTH * 0.5) return false;
  }
  return true;
}

/**
 * The nearest open water to a point: rings every 250 m outward, finest
 * spacing about 250 m along each ring. Measured from the home airport on 25
 * seeds it lands 0.75-3.75 km out in 69-778 terrain probes. Deterministic,
 * and read from the world's analytic terrain so the main thread and the
 * worker agree before any terrain page has streamed.
 */
export function findOpenWater(
  world: WorldDefinition,
  originX: number,
  originZ: number,
): OpenWaterPoint | null {
  if (isOpenWater(world, originX, originZ)) {
    return { x: originX, z: originZ, depth: depthAt(world, originX, originZ) };
  }
  for (let radius = RING_STEP; radius <= MAX_SEARCH_RADIUS; radius += RING_STEP) {
    const count = Math.max(32, Math.min(720, Math.round((2 * Math.PI * radius) / RING_STEP)));
    for (let k = 0; k < count; k += 1) {
      const angle = (k / count) * Math.PI * 2;
      const x = originX + Math.cos(angle) * radius;
      const z = originZ + Math.sin(angle) * radius;
      if (isOpenWater(world, x, z)) return { x, z, depth: depthAt(world, x, z) };
    }
  }
  return null;
}

/**
 * Of sixteen headings, the one with the longest run of water at least half
 * open-water depth, up to 1.5 km. Heading in radians, `atan2(x, z)`.
 */
export function longestClearHeading(world: WorldDefinition, x: number, z: number): number {
  let bestHeading = 0;
  let bestRun = -1;
  for (let i = 0; i < HEADING_DIRECTIONS; i += 1) {
    const heading = (i / HEADING_DIRECTIONS) * Math.PI * 2;
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    let run = 0;
    for (let d = HEADING_RUN_STEP; d <= HEADING_RUN_MAX; d += HEADING_RUN_STEP) {
      if (depthAt(world, x + dx * d, z + dz * d) < OPEN_WATER_DEPTH * 0.5) break;
      run = d;
    }
    if (run > bestRun) {
      bestRun = run;
      bestHeading = heading;
    }
  }
  return bestHeading;
}

function openWaterSpawn(world: WorldDefinition, originX: number, originZ: number): SurfaceVehicleSpawn {
  const point = findOpenWater(world, originX, originZ);
  if (!point) throw new Error("No open water within 40 km for a boat to start on");
  return {
    position: { x: point.x, y: world.seaLevel, z: point.z },
    heading: longestClearHeading(world, point.x, point.z),
    moored: false,
  };
}

/**
 * The car's start on the home apron, runway frame: in the open ground between
 * the hangar row's last hangar and the fuel farm, on the hangars' centre
 * line, facing the runway. The row centres at `runwayLength * -0.12` and runs
 * 52 m pitch x 3, 34 m deep (`HANGAR_SITING`); `95` clears its last hangar by
 * 26 m and the fuel farm (along -17..17) by 46 m on the default airport. The
 * roads build moves it to the access road's head.
 */
const APRON_CAR_START = Object.freeze({ alongFraction: -0.12, alongOffset: 95, acrossOffset: 118 });

function apronCarSpawn(world: WorldDefinition): SurfaceVehicleSpawn {
  const airport = world.airport;
  // A world without an airport starts the car at the origin, as the marina searches from it.
  if (!airport) return uprightCarSpawn(world, 0, 0);
  const across = airport.runwayWidth * 0.5 + APRON_CAR_START.acrossOffset;
  const along = airport.runwayLength * APRON_CAR_START.alongFraction + APRON_CAR_START.alongOffset;
  const point = runwayToWorld(airport, along, across);
  // Toward the runway is -across: (-cos h, sin h) in plan.
  const heading = Math.atan2(-Math.cos(airport.headingRadians), Math.sin(airport.headingRadians));
  return {
    position: { x: point.x, y: sampleGroundHeight(world, point.x, point.z), z: point.z },
    heading,
    moored: false,
  };
}

/** After a wreck: back on its wheels where it came to rest. */
function uprightCarSpawn(world: WorldDefinition, wreckX: number, wreckZ: number): SurfaceVehicleSpawn {
  return {
    position: { x: wreckX, y: sampleGroundHeight(world, wreckX, wreckZ), z: wreckZ },
    heading: 0,
    moored: false,
  };
}

/**
 * Where a surface vehicle's session begins. A boat starts at the dock
 * (decision D4): moored in the home marina's start berth, bow out, on the
 * still sea there. The simulator settles the hull to its own draft. The car
 * starts on the home apron, on its wheels.
 */
export function createSurfaceSpawn(
  world: WorldDefinition,
  kind: SurfaceVehicleKind,
): SurfaceVehicleSpawn {
  switch (kind) {
    case "speedboat": {
      const pose = marinaStartPose(world);
      return {
        position: { x: pose.x, y: pose.stillWaterY, z: pose.z },
        heading: pose.headingRadians,
        moored: true,
      };
    }
    case "landcruiser":
      return apronCarSpawn(world);
  }
}

/** After a wreck: a boat upright and afloat in the open water nearest it, the car upright where it lies. */
export function createSurfaceRecoverySpawn(
  world: WorldDefinition,
  kind: SurfaceVehicleKind,
  wreckX: number,
  wreckZ: number,
): SurfaceVehicleSpawn {
  switch (kind) {
    case "speedboat":
      return openWaterSpawn(world, wreckX, wreckZ);
    case "landcruiser":
      return uprightCarSpawn(world, wreckX, wreckZ);
  }
}

/**
 * Where in plan a session given this spawn starts, as the simulation worker
 * will place it (`createSurfaceSpawn`, `createSimulationSpawn`): what the
 * renderer primes the streamed roads round (`FlightRendererOptions.startPoint`).
 */
export function sessionStartPoint(
  world: WorldDefinition,
  kind: SpawnKind,
  airborneStartAgl: number,
  aircraft: AircraftKind,
  vehicle: SurfaceVehicleKind | null,
): { x: number; z: number } {
  if (isSurfaceSpawn(kind) && vehicle) {
    const { position } = createSurfaceSpawn(world, vehicle);
    return { x: position.x, z: position.z };
  }
  if (!world.airport && kind === "runway") return { x: 0, z: 0 };
  const { position } = createSimulationSpawn(world, isSurfaceSpawn(kind) ? "airborne" : kind, airborneStartAgl, aircraft);
  return { x: position?.x ?? 0, z: position?.z ?? 0 };
}
