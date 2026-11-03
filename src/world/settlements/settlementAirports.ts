import { segmentReachesAirportEarthworks } from "../airport";
import type { InfrastructureRegion, InfrastructureSegment } from "../infrastructure";
import { airportEarthworksBox, roadRegionClipKey } from "../roads/roadAirports";
import { pointSegmentDistance, segmentsIntersect } from "../roads/roadGraph";
import { structureEnvelope } from "../structures/structureEnvelope";
import { structureToWorld, type StructureRecord } from "../structures/structureRecord";
import type { AirportDefinition } from "../types";

/**
 * Spawned airports and the settlements: the tracks' split
 * (`roadAirports.ts`) applied to buildings. A settlement never refuses a
 * field. A field a settlement lies under takes the buildings it would
 * grade: each building whose footprint (its envelope: body, eaves, porch
 * and steps) the field's earthworks reach goes, and so does each pad,
 * clearing, yard or driveway that reaches them, with every building
 * standing on one of those. What stays is untouched by the field's
 * earthworks, and so drawn on the ground it was laid out on.
 *
 * "Reach the earthworks" is the roads' test (`segmentReachesAirportEarthworks`,
 * the platform grown by its blend), so a field takes a building exactly
 * where it would take a track beside it. The home field is never asked.
 */

/** A capsule round a building's footprint, world metres: the envelope's long axis, grown by half its short side. */
export interface StructureFootprintCapsule {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly radius: number;
}

export function structureFootprintCapsule(record: StructureRecord): StructureFootprintCapsule {
  const envelope = structureEnvelope(record);
  const alongX = envelope.maxX - envelope.minX >= envelope.maxZ - envelope.minZ;
  const centreX = (envelope.minX + envelope.maxX) * 0.5;
  const centreZ = (envelope.minZ + envelope.maxZ) * 0.5;
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  if (alongX) {
    structureToWorld(record, envelope.minX, 0, centreZ, a);
    structureToWorld(record, envelope.maxX, 0, centreZ, b);
  } else {
    structureToWorld(record, centreX, 0, envelope.minZ, a);
    structureToWorld(record, centreX, 0, envelope.maxZ, b);
  }
  const radius = alongX ? (envelope.maxZ - envelope.minZ) * 0.5 : (envelope.maxX - envelope.minX) * 0.5;
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, radius };
}

/** Whether a field's earthworks reach a building's footprint. */
export function structureReachesAirportEarthworks(airport: Readonly<AirportDefinition>, record: StructureRecord): boolean {
  const capsule = structureFootprintCapsule(record);
  return segmentReachesAirportEarthworks(airport, capsule.ax, capsule.az, capsule.bx, capsule.bz, capsule.radius);
}

function segmentReaches(airport: Readonly<AirportDefinition>, segment: InfrastructureSegment): boolean {
  return segmentReachesAirportEarthworks(
    airport, segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach,
  );
}

/**
 * A streamed settlements region with what spawned airports take out of it
 * (above). Returns the region itself when no airport reaches it, and
 * otherwise a new one keyed by `roadRegionClipKey` with the airports that
 * clipped it, in the order given, as a clipped track region is.
 */
export function clipSettlementRegionForAirports<T extends { readonly infrastructure: InfrastructureRegion }>(
  region: T,
  airports: readonly Readonly<AirportDefinition>[],
): T {
  const source = region.infrastructure;
  const structures = source.structures ?? [];
  const clipping = airports.filter((airport) => {
    if (!regionNear(source, airport)) return false;
    return source.segments.some((segment) => segmentReaches(airport, segment))
      || structures.some((record) => structureReachesAirportEarthworks(airport, record));
  });
  if (clipping.length === 0) return region;
  const keptSegments: InfrastructureSegment[] = [];
  const droppedSegments: InfrastructureSegment[] = [];
  for (const segment of source.segments) {
    (clipping.some((airport) => segmentReaches(airport, segment)) ? droppedSegments : keptSegments).push(segment);
  }
  const keptStructures = structures.filter((record) => {
    if (clipping.some((airport) => structureReachesAirportEarthworks(airport, record))) return false;
    // Not on ground the field took: no dropped pad or clearing under its footprint.
    const capsule = structureFootprintCapsule(record);
    return !droppedSegments.some((segment) => capsulesOverlap(capsule, segment));
  });
  const infrastructure: InfrastructureRegion = Object.freeze({
    ...source,
    key: roadRegionClipKey(source.key, clipping),
    segments: Object.freeze(keptSegments),
    structures: Object.freeze(keptStructures),
  });
  return { ...region, infrastructure };
}

/** Whether the region's segments or buildings come anywhere near the field's earthworks: a box test first. */
function regionNear(region: InfrastructureRegion, airport: Readonly<AirportDefinition>): boolean {
  const box = airportEarthworksBox(airport);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const grow = (ax: number, az: number, bx: number, bz: number, outer: number) => {
    minX = Math.min(minX, ax - outer, bx - outer);
    minZ = Math.min(minZ, az - outer, bz - outer);
    maxX = Math.max(maxX, ax + outer, bx + outer);
    maxZ = Math.max(maxZ, az + outer, bz + outer);
  };
  for (const segment of region.segments) grow(segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth + segment.reach);
  for (const record of region.structures ?? []) {
    const capsule = structureFootprintCapsule(record);
    grow(capsule.ax, capsule.az, capsule.bx, capsule.bz, capsule.radius);
  }
  return minX <= box.maxX && maxX >= box.minX && minZ <= box.maxZ && maxZ >= box.minZ;
}

/** Whether a footprint and a segment's core (its half width, not its batters) overlap. */
function capsulesOverlap(capsule: StructureFootprintCapsule, segment: InfrastructureSegment): boolean {
  return segmentDistance(capsule.ax, capsule.az, capsule.bx, capsule.bz, segment.ax, segment.az, segment.bx, segment.bz)
    < capsule.radius + segment.halfWidth;
}

/** The distance between two segments in the plane (0 where they cross). */
function segmentDistance(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    pointSegmentDistance(ax, az, cx, cz, dx, dz),
    pointSegmentDistance(bx, bz, cx, cz, dx, dz),
    pointSegmentDistance(cx, cz, ax, az, bx, bz),
    pointSegmentDistance(dx, dz, ax, az, bx, bz),
  );
}
