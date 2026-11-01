import { ENTERABLE_STRUCTURE_ARCHETYPES, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * Which buildings go in which of the structure renderer's meshes (the plan's
 * "Drawing it"), decided on the CPU from the camera and the visible records:
 *
 *   far   every visible building as a block. Rebuilt only when the records
 *         change (a region installs or leaves, a rule hides some): every
 *         2 km or so of travel. Its vertex stage drops the blocks beyond the
 *         far radius and inside the near one.
 *   near  every building within the near radius, plus the handoff band and
 *         the hysteresis, from where the set was last decided, as the kit's
 *         closed shells. Decided again once the camera has moved
 *         `STRUCTURE_NEAR_HYSTERESIS_METERS` from there, and rebuilt only if
 *         that changes who is in it. Its vertex stage drops the buildings
 *         outside the near radius and band, so what is drawn near is a
 *         function of the camera alone, and the far blocks dither out across
 *         the same band as the shells dither in.
 *   open  the few enterable buildings nearest the camera, open (rooms, glass):
 *         built from `STRUCTURE_OPEN_BUILD_METERS`, drawn from
 *         `STRUCTURE_OPEN_DRAW_METERS`, when the near set's shell of the same
 *         building is dropped instead.
 *
 * The handoff and the radii are horizontal distances from the camera to a
 * building's footprint centre: the vertex stage has the centre per vertex
 * (`StructureMeshArrays.centre`), and a building is in one set or the other
 * at every height. The open set's distances are to the building itself, in
 * three dimensions, since a house is opened for a camera beside it, not for
 * an aircraft over it.
 */

/** What the structure renderer takes from the quality profile: data, never a tier branch. */
export interface StructureDrawRanges {
  /** Full-detail shells within this of the camera, metres. */
  readonly structureNearRadiusMeters: number;
  /** Blocks out to this, metres; 0 draws none. */
  readonly structureFarRadiusMeters: number;
  /** How many buildings may be drawn open at once; 0 opens none. */
  readonly structureOpenBuildings: number;
}

/** Both sets dither across this band: the near radius to the radius plus the band, metres. */
export const STRUCTURE_HANDOFF_BAND_METERS = 40;

/** The near set is decided again once the camera is this far from where it last was, metres. */
export const STRUCTURE_NEAR_HYSTERESIS_METERS = 40;

/** A building is drawn open within this of the camera, metres. */
export const STRUCTURE_OPEN_DRAW_METERS = 40;

/** And its open model is asked for from this far, so it is in when the camera reaches the draw distance. */
export const STRUCTURE_OPEN_BUILD_METERS = 60;

/** A storey, floor to floor, metres: how high a building's open-set distance measures it. */
const STOREY_METERS = 2.9;

export interface StructurePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What changed this update: the sets to build afresh, and the open buildings drawn. */
export interface StructureSetChanges {
  /** The far set's records, when they changed. */
  readonly far: readonly StructureRecord[] | null;
  /** The near set's records, when who is in it changed. */
  readonly near: readonly StructureRecord[] | null;
  /** Open models to have, nearest first (a superset of `openDrawn`); null when unchanged. */
  readonly openWanted: readonly StructureRecord[] | null;
}

/** Horizontal distance from (x, z) to a building's footprint centre. */
export function structureCentreDistance(record: StructureRecord, x: number, z: number): number {
  return Math.hypot(record.x - x, record.z - z);
}

/**
 * Distance from a point to a building's body: its footprint rectangle (the
 * building frame's x and z extents), from its footings to its eaves.
 */
export function structureBodyDistance(record: StructureRecord, point: StructurePoint): number {
  const c = Math.cos(record.heading);
  const s = Math.sin(record.heading);
  const dx = point.x - record.x;
  const dz = point.z - record.z;
  // World to the building frame: the inverse of structureToWorld's rotation.
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const ex = Math.max(0, Math.abs(lx) - record.width * 0.5);
  const ez = Math.max(0, Math.abs(lz) - record.depth * 0.5);
  const top = record.floorY + record.storeys * STOREY_METERS;
  const ey = Math.max(0, record.baseY - point.y, point.y - top);
  return Math.hypot(ex, ey, ez);
}

export class StructureSets {
  private ranges: StructureDrawRanges;
  private storeVersion = -1;
  private nearCentreX = Number.NaN;
  private nearCentreZ = Number.NaN;
  private nearIds = "";
  private openIds = "";
  private openRecords: readonly StructureRecord[] = [];
  private openDrawnRecords: readonly StructureRecord[] = [];

  constructor(ranges: StructureDrawRanges) {
    this.ranges = ranges;
  }

  get drawRanges(): StructureDrawRanges {
    return this.ranges;
  }

  /** New radii decide every set again at the next update. */
  setRanges(ranges: StructureDrawRanges): void {
    if (ranges.structureNearRadiusMeters === this.ranges.structureNearRadiusMeters
      && ranges.structureFarRadiusMeters === this.ranges.structureFarRadiusMeters
      && ranges.structureOpenBuildings === this.ranges.structureOpenBuildings) return;
    this.ranges = ranges;
    this.storeVersion = -1;
  }

  /** The open buildings to draw open now: those wanted within `STRUCTURE_OPEN_DRAW_METERS`, nearest first. */
  openDrawn(isBuilt: (record: StructureRecord) => boolean): readonly StructureRecord[] {
    return this.openDrawnRecords.filter(isBuilt);
  }

  /**
   * Once a frame: the camera at absolute (x, y, z) and the visible records
   * (`StructureRecordStore.visible()`, with its version).
   */
  update(camera: StructurePoint, records: readonly StructureRecord[], version: number): StructureSetChanges {
    const recordsChanged = version !== this.storeVersion;
    this.storeVersion = version;
    const far = recordsChanged ? this.farRecords(records) : null;

    let near: readonly StructureRecord[] | null = null;
    const moved = Math.hypot(camera.x - this.nearCentreX, camera.z - this.nearCentreZ);
    if (recordsChanged || !(moved < STRUCTURE_NEAR_HYSTERESIS_METERS)) {
      this.nearCentreX = camera.x;
      this.nearCentreZ = camera.z;
      const candidates = this.nearRecords(records, camera.x, camera.z);
      const ids = candidates.map((record) => record.id).join(",");
      if (ids !== this.nearIds) {
        this.nearIds = ids;
        near = candidates;
      }
    }

    const openWanted = this.openWantedRecords(records, camera, recordsChanged);
    return { far, near, openWanted };
  }

  /** Every building the far set holds: all visible, if blocks are drawn at all. */
  private farRecords(records: readonly StructureRecord[]): readonly StructureRecord[] {
    return this.ranges.structureFarRadiusMeters > 0 ? records : [];
  }

  private nearRecords(records: readonly StructureRecord[], x: number, z: number): StructureRecord[] {
    const radius = this.ranges.structureNearRadiusMeters;
    if (!(radius > 0)) return [];
    const reach = radius + STRUCTURE_HANDOFF_BAND_METERS + STRUCTURE_NEAR_HYSTERESIS_METERS;
    return records.filter((record) => structureCentreDistance(record, x, z) <= reach);
  }

  private openWantedRecords(
    records: readonly StructureRecord[],
    camera: StructurePoint,
    recordsChanged: boolean,
  ): readonly StructureRecord[] | null {
    const limit = Math.max(0, Math.floor(this.ranges.structureOpenBuildings));
    let wanted: { record: StructureRecord; distance: number }[] = [];
    if (limit > 0) {
      for (const record of records) {
        if (!ENTERABLE_STRUCTURE_ARCHETYPES.has(record.archetype)) continue;
        // A cheap reject first: no body is further from its centre than its half diagonal.
        if (structureCentreDistance(record, camera.x, camera.z) - Math.hypot(record.width, record.depth) * 0.5
          > STRUCTURE_OPEN_BUILD_METERS) continue;
        const distance = structureBodyDistance(record, camera);
        if (distance <= STRUCTURE_OPEN_BUILD_METERS) wanted.push({ record, distance });
      }
      wanted.sort((a, b) => a.distance - b.distance || a.record.id - b.record.id);
      wanted = wanted.slice(0, limit);
    }
    this.openDrawnRecords = wanted.filter((entry) => entry.distance <= STRUCTURE_OPEN_DRAW_METERS).map((entry) => entry.record);
    // Who is wanted, not in what order: a camera walking round a house does not rebuild it.
    const ids = wanted.map((entry) => entry.record.id).sort((a, b) => a - b).join(",");
    if (ids === this.openIds && !recordsChanged) return null;
    this.openIds = ids;
    this.openRecords = wanted.map((entry) => entry.record);
    return this.openRecords;
  }
}
