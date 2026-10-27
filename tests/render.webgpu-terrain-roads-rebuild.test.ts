import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { terrainPageAirportDomain, type TerrainWorldRect } from "@/src/render/webgpu/terrain/AirportReach";
import {
  TerrainClipmapSystem,
  type TerrainComputeFactory,
} from "@/src/render/webgpu/terrain/TerrainClipmapSystem";
import type { TerrainAtlasSlot } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import {
  changeInfrastructureRegions,
  clearInfrastructureRegions,
  INFRASTRUCTURE_BIN_METERS,
  type InfrastructureRegion,
} from "@/src/world/infrastructure";
import { roadRegionInfrastructure } from "@/src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { createWorld } from "@/src/world/world";

/**
 * `TerrainClipmapSystem.infrastructureChanged`: a streamed road region coming
 * or going rebuilds IN PLACE exactly the resident pages whose sampled ground
 * it can change, through the airport spawn's own scan, pumps and meter, and
 * a capture waiting on `pendingPages` waits for them. End to end on fake
 * producers, against the default world's road out of the home airport.
 */

const world = createWorld();
const head = airportRoadHead(world)!;
const network = new RoadNetwork(world);
const region: InfrastructureRegion = roadRegionInfrastructure(
  network,
  network.region("major", roadRegionOf(head.startX), roadRegionOf(head.startZ)),
);

afterEach(() => clearInfrastructureRegions());

interface Dispatch {
  readonly frame: number;
  readonly key: string;
  readonly inPlace: boolean;
}

const keyOf = (address: WorldPageAddress): string => `${address.level}:${address.x}:${address.z}`;

function recordingFactory(clock: { frame: number }) {
  const heights: Dispatch[] = [];
  const channels: Dispatch[] = [];
  const factory: TerrainComputeFactory = ({ heightAtlas, existingPyramid }) => ({
    pageGenerator: {
      generate: async (slots: readonly TerrainAtlasSlot[]) => {
        for (const slot of slots) {
          heights.push({ frame: clock.frame, key: keyOf(slot.address), inPlace: slot.lifecycle.state === "resident" });
          slot.generationSubmitted = true;
        }
        await Promise.resolve();
        for (const slot of slots) {
          if (!slot.token) continue;
          heightAtlas.residency.complete(slot.key, slot.token, {
            minHeightMeters: 0,
            maxHeightMeters: 100,
            maxDeviationFromParent: 4,
          });
        }
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    occlusionBake: {
      bake: async (slots: readonly TerrainAtlasSlot[]) => {
        for (const slot of slots) channels.push({ frame: clock.frame, key: keyOf(slot.address), inPlace: slot.token === null });
        return slots;
      },
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    splatBake: {
      bake: async (slots: readonly TerrainAtlasSlot[]) => slots,
      consumeMeasuredDispatchCostMs: () => null,
      dispose: () => undefined,
    },
    pyramid: existingPyramid ?? { recenter: async () => undefined, isResident: true, dispose: () => undefined },
  });
  return { factory, heights, channels };
}

async function pump(
  system: TerrainClipmapSystem,
  clock: { frame: number },
  frames: number,
  observer: { x: number; y: number; z: number; velocityX: number; velocityZ: number },
): Promise<void> {
  for (let step = 0; step < frames; step += 1) {
    clock.frame += 1;
    system.update(observer, clock.frame);
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  }
}

/** Distance from a segment to a rectangle (0 when they meet). */
function segmentRectDistance(ax: number, az: number, bx: number, bz: number, rect: TerrainWorldRect): number {
  // The segment against the rectangle, sampled finely: exact enough for a
  // metre-scale oracle, and independent of the bins.
  let best = Infinity;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
  for (let i = 0; i <= steps; i += 1) {
    const x = ax + (bx - ax) * (i / steps);
    const z = az + (bz - az) * (i / steps);
    const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
    const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/** How near a page's sampled domain comes to the region's ground, less each segment's reach. */
function clearance(address: WorldPageAddress): number {
  const domain = terrainPageAirportDomain(address);
  let best = Infinity;
  for (const segment of region.segments) {
    const reach = segment.halfWidth + segment.reach
      + (segment.plantClearance === undefined ? 0 : segment.plantClearance + 4);
    best = Math.min(best, segmentRectDistance(segment.ax, segment.az, segment.bx, segment.bz, domain) - reach);
  }
  return best;
}

describe("TerrainClipmapSystem.infrastructureChanged", () => {
  it("rebuilds in place exactly the pages a road region reaches, counted as pending until done", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const clock = { frame: 0 };
    const recording = recordingFactory(clock);
    const system = new TerrainClipmapSystem(
      scene, world, resolveWebGpuQualityProfile("medium", "balanced"), { computeFactory: recording.factory },
    );
    const observer = { x: head.startX, y: 30, z: head.startZ, velocityX: 0, velocityZ: 0 };
    try {
      await pump(system, clock, 80, observer);
      const settled = system.statistics.pendingPages;
      const resident = system.atlases.height.residency.entries.filter((slot) => slot.lifecycle.state === "resident");
      expect(resident.length).toBeGreaterThan(20);

      // A change touching nothing queues nothing.
      system.infrastructureChanged({ version: 1, rects: [], bins: new Set(), plantBins: new Set() });
      expect(system.statistics.pendingPages).toBe(settled);

      // ---- the road arrives -----------------------------------------------
      const change = changeInfrastructureRegions(world, [region])!;
      const dispatched = recording.heights.length;
      system.infrastructureChanged(change);
      // Queued, not done: nothing scanned or dispatched inside the call, and a capture waits.
      expect(recording.heights.length).toBe(dispatched);
      expect(system.statistics.pendingPages).toBeGreaterThan(settled);
      const changeFrame = clock.frame;
      for (let step = 0; step < 200 && system.statistics.pendingPages > settled; step += 1) {
        await pump(system, clock, 1, observer);
      }
      expect(system.statistics.pendingPages).toBe(settled);

      const rebuilt = new Set(recording.heights
        .filter((dispatch) => dispatch.frame > changeFrame && dispatch.inPlace)
        .map((dispatch) => dispatch.key));
      expect(rebuilt.size).toBeGreaterThan(0);
      // Every resident page the road's ground reaches is rebuilt; none is
      // rebuilt that lies further from it than the bins' slack (a bin's
      // diagonal and its metre of margin).
      const slack = INFRASTRUCTURE_BIN_METERS * Math.SQRT2 + 1;
      for (const slot of resident) {
        const reach = clearance(slot.address);
        const key = keyOf(slot.address);
        if (reach <= 0) expect(rebuilt.has(key), `page ${key} reached`).toBe(true);
        if (reach > slack) expect(rebuilt.has(key), `page ${key} out of reach`).toBe(false);
      }
      // Ground far from the road keeps its pages: the change is local.
      expect(rebuilt.size).toBeLessThan(resident.length);
      // Never evicted.
      const residentAfter = new Set(system.atlases.height.residency.entries
        .filter((slot) => slot.lifecycle.state === "resident")
        .map((slot) => keyOf(slot.address)));
      for (const key of rebuilt) expect(residentAfter.has(key), `height ${key} evicted`).toBe(true);
      // Their channel pages re-bake after them, in place.
      const rebaked = recording.channels.filter((dispatch) => dispatch.frame > changeFrame && dispatch.inPlace);
      expect(rebaked.length).toBeGreaterThan(0);
      for (const dispatch of rebaked) expect(rebuilt.has(dispatch.key), `channel ${dispatch.key}`).toBe(true);

      // ---- and leaves: the same ground again ------------------------------
      const leaveFrame = clock.frame;
      system.infrastructureChanged(changeInfrastructureRegions(world, [], [region.key])!);
      for (let step = 0; step < 200 && system.statistics.pendingPages > settled; step += 1) {
        await pump(system, clock, 1, observer);
      }
      const rebuiltAgain = new Set(recording.heights
        .filter((dispatch) => dispatch.frame > leaveFrame && dispatch.inPlace)
        .map((dispatch) => dispatch.key));
      expect([...rebuiltAgain].sort()).toEqual([...rebuilt].filter((key) => residentAfter.has(key)).sort());
      console.log(
        `road region ${region.key} (${region.segments.length} segments): ${rebuilt.size} of ${resident.length} `
        + `resident height pages rebuilt in place, ${new Set(rebaked.map((dispatch) => dispatch.key)).size} channel pages re-baked`,
      );
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
