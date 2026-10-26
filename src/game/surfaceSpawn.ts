import type { SurfaceVehicleSpawn } from "@/src/sim/surface/types";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { sampleTerrainHeight, type WorldDefinition } from "@/src/world";
import { marinaStartPose } from "@/src/world/marina";

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
 * Where a surface vehicle's session begins. A boat starts at the dock
 * (decision D4): moored in the home marina's start berth, bow out, on the
 * still sea there. The simulator settles the hull to its own draft.
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
  }
}

/** After a wreck: upright and afloat in the open water nearest it. */
export function createSurfaceRecoverySpawn(
  world: WorldDefinition,
  kind: SurfaceVehicleKind,
  wreckX: number,
  wreckZ: number,
): SurfaceVehicleSpawn {
  switch (kind) {
    case "speedboat":
      return openWaterSpawn(world, wreckX, wreckZ);
  }
}
