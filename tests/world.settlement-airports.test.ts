import { describe, expect, it } from "vitest";
import { getAirportInfluence, segmentReachesAirportEarthworks } from "@/src/world/airport";
import { roadRegionClipKey } from "@/src/world/roads/roadAirports";
import { RoadNetwork, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import {
  clipSettlementRegionForAirports,
  structureFootprintCapsule,
  structureReachesAirportEarthworks,
} from "@/src/world/settlements/settlementAirports";
import { settlementRegion } from "@/src/world/settlements/settlementRegion";
import { structureEnvelope } from "@/src/world/structures/structureEnvelope";
import { structureToWorld, type StructureRecord } from "@/src/world/structures/structureRecord";
import type { AirportDefinition } from "@/src/world/types";
import { createWorld } from "@/src/world/world";

/**
 * A spawned airport over real settlements: the buildings whose footprint
 * its earthworks reach go, with every pad, clearing, yard or driveway that
 * reaches them and every building standing on one; nothing that stays is
 * touched by the earthworks (`getAirportInfluence` is 0 all over it), so a
 * building the field keeps is on the ground it was laid out on.
 */

const world = createWorld();
const network = new RoadNetwork(world);
const head = airportRoadHead(world)!;
const cx = roadRegionOf(head.startX) - 1;
const cz = roadRegionOf(head.startZ) - 1;
const regions = [-1, 0, 1].flatMap((dz) => [-1, 0, 1].map((dx) => settlementRegion(network, cx + dx, cz + dz)));
const buildings = regions.flatMap((region) => region.infrastructure.structures ?? []);

/** A field with the home footprint, centred on a building (as the land lead's tests move the home field). */
function fieldOn(record: StructureRecord): Readonly<AirportDefinition> {
  return Object.freeze({ ...world.airport!, centerX: record.x + 40, centerZ: record.z - 25 });
}

/** The building's envelope, corners and edges every metre, in the world. */
function envelopePoints(record: StructureRecord): { x: number; z: number }[] {
  const envelope = structureEnvelope(record);
  const points: { x: number; z: number }[] = [];
  const at = { x: 0, y: 0, z: 0 };
  for (let lx = envelope.minX; lx <= envelope.maxX + 1e-9; lx += Math.max(1e-3, (envelope.maxX - envelope.minX) / Math.ceil(envelope.maxX - envelope.minX))) {
    for (const lz of [envelope.minZ, envelope.maxZ]) points.push({ ...structureToWorld(record, lx, 0, lz, at) });
  }
  for (let lz = envelope.minZ; lz <= envelope.maxZ + 1e-9; lz += Math.max(1e-3, (envelope.maxZ - envelope.minZ) / Math.ceil(envelope.maxZ - envelope.minZ))) {
    for (const lx of [envelope.minX, envelope.maxX]) points.push({ ...structureToWorld(record, lx, 0, lz, at) });
  }
  return points;
}

describe("the settlements under a spawned airport", () => {
  it("has buildings to clip", () => {
    expect(buildings.length).toBeGreaterThan(20);
  });

  it("holds each building's whole envelope in its footprint capsule", () => {
    for (const record of buildings.slice(0, 40)) {
      const capsule = structureFootprintCapsule(record);
      for (const point of envelopePoints(record)) {
        const ux = capsule.bx - capsule.ax;
        const uz = capsule.bz - capsule.az;
        const t = Math.min(1, Math.max(0, ((point.x - capsule.ax) * ux + (point.z - capsule.az) * uz) / (ux * ux + uz * uz)));
        expect(Math.hypot(point.x - (capsule.ax + ux * t), point.z - (capsule.az + uz * t))).toBeLessThanOrEqual(capsule.radius + 1e-6);
      }
    }
  });

  it("takes the buildings and ground the field's earthworks reach, and leaves the rest untouched by them", () => {
    // A field over the edge of a settlement: slid off a building until the
    // settlement is split, some of its buildings taken and some left.
    const target = buildings[Math.floor(buildings.length / 2)]!;
    let field = fieldOn(target);
    for (let slide = 0; slide <= 2_000; slide += 25) {
      const candidate = Object.freeze({ ...field, centerX: target.x + 40 + slide });
      const split = regions.some((region) => {
        const kept = clipSettlementRegionForAirports(region, [candidate]).infrastructure.structures?.length ?? 0;
        return kept > 0 && kept < (region.infrastructure.structures?.length ?? 0);
      });
      if (split) {
        field = candidate;
        break;
      }
    }
    let dropped = 0;
    let kept = 0;
    let unclipped = 0;
    for (const region of regions) {
      const source = region.infrastructure;
      const clipped = clipSettlementRegionForAirports(region, [field]);
      if (clipped === region) {
        unclipped += 1;
        for (const record of source.structures ?? []) expect(structureReachesAirportEarthworks(field, record)).toBe(false);
        continue;
      }
      const result = clipped.infrastructure;
      expect(result.key).toBe(roadRegionClipKey(source.key, [field]));
      expect(Object.isFrozen(result.structures)).toBe(true);
      // Segments: exactly those that reach go.
      const keptSegments = new Set(result.segments);
      for (const segment of source.segments) {
        const reaches = segmentReachesAirportEarthworks(field, segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach);
        expect(keptSegments.has(segment)).toBe(!reaches);
      }
      // Buildings: none kept is touched by the earthworks anywhere on its envelope.
      const keptIds = new Set((result.structures ?? []).map((record) => record.id));
      for (const record of source.structures ?? []) {
        if (!keptIds.has(record.id)) {
          dropped += 1;
          continue;
        }
        kept += 1;
        expect(structureReachesAirportEarthworks(field, record)).toBe(false);
        for (const point of envelopePoints(record)) expect(getAirportInfluence(field, point.x, point.z)).toBe(0);
      }
      // Clipped again from the same source: the same region.
      expect(JSON.stringify(clipSettlementRegionForAirports(region, [field]).infrastructure)).toBe(JSON.stringify(result));
    }
    expect(dropped).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
    expect(unclipped).toBeGreaterThan(0);
  });

  it("leaves every region alone with no spawned field, or a field far off", () => {
    const far = Object.freeze({ ...world.airport!, centerX: head.startX + 40_000, centerZ: head.startZ });
    for (const region of regions) {
      expect(clipSettlementRegionForAirports(region, [])).toBe(region);
      expect(clipSettlementRegionForAirports(region, [far])).toBe(region);
    }
  });
});
