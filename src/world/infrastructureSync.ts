import {
  changeInfrastructureRegions,
  infrastructureChangeTouches,
  infrastructureRegionsVersion,
  installedInfrastructureRegionKeys,
  installedInfrastructureRegions,
  type InfrastructureChange,
  type InfrastructureRect,
  type InfrastructureRegion,
} from "./infrastructure";
import type { WorldDefinition } from "./types";

/**
 * Keeping the workers' copies of the infrastructure stage in step with the
 * main thread's (roads, `RoadStreamController`).
 *
 * Every JS realm has its own region registry, so the simulation and detail
 * workers each install the same regions the main thread did, in the same
 * order, from `InfrastructureRegionsUpdate`s posted on the port their ground
 * arrives on. Message order is what makes that exact: an update is posted
 * the moment the main thread's stage changes, before any page baked against
 * the new stage can be published, so a worker holding a page when an update
 * lands knows the page predates it (`TerrainAuthority.
 * applyInfrastructureChange` drops the pages it touches), and the main
 * thread holds back a late publication baked before a change that touches
 * it (`InfrastructureChangeLog`): the clipmap rebuilds that page anyway.
 */

/** One change to the streamed regions, as a worker's copy of the stage takes it. */
export interface InfrastructureRegionsUpdate {
  /** The main thread's `infrastructureRegionsVersion` after the change. */
  readonly version: number;
  /** Replace whatever the worker holds with `install` (a worker joining, or catching up). */
  readonly reset: boolean;
  readonly install: readonly InfrastructureRegion[];
  /** Stage keys of the regions removed. */
  readonly remove: readonly string[];
}

/** The whole set the world's terrain holds now, as a reset. */
export function infrastructureRegionsSnapshot(world: WorldDefinition): InfrastructureRegionsUpdate {
  return {
    version: infrastructureRegionsVersion(world),
    reset: true,
    install: installedInfrastructureRegions(world),
    remove: [],
  };
}

/**
 * Apply an update to this realm's copy of the world's terrain, in one change.
 * Returns the change, carrying the main thread's version, or null when it
 * changed nothing here.
 */
export function applyInfrastructureRegionsUpdate(
  world: WorldDefinition,
  update: InfrastructureRegionsUpdate,
): InfrastructureChange | null {
  let remove = update.remove;
  if (update.reset) {
    const keep = new Set(update.install.map((region) => region.key));
    remove = installedInfrastructureRegionKeys(world).filter((key) => !keep.has(key));
  }
  const change = changeInfrastructureRegions(world, update.install, remove);
  return change ? { ...change, version: update.version } : null;
}

/**
 * A main-thread client's record of what its worker holds: each update is
 * forwarded once, in order, and after a gap (an update it never saw) the
 * whole set goes instead, so the worker cannot drift.
 */
export class InfrastructureRegionsForwarder {
  private sent: number;

  constructor(private readonly world: WorldDefinition) {
    this.sent = infrastructureRegionsVersion(world);
  }

  /** The set to start the worker with (its `initialize`), recorded as sent. */
  initial(): InfrastructureRegionsUpdate {
    const snapshot = infrastructureRegionsSnapshot(this.world);
    this.sent = snapshot.version;
    return snapshot;
  }

  /** What to post for `update`: itself, the whole set after a gap, or null when the worker already has it. */
  next(update: InfrastructureRegionsUpdate): InfrastructureRegionsUpdate | null {
    if (update.version <= this.sent) return null;
    const post = update.reset || update.version === this.sent + 1
      ? update
      : infrastructureRegionsSnapshot(this.world);
    this.sent = post.version;
    return post;
  }
}

/**
 * Changes kept by `InfrastructureChangeLog`: a page batch's readback lands a
 * few frames after its dispatch, and the stage changes at most once a frame.
 */
export const INFRASTRUCTURE_CHANGE_LOG_LENGTH = 256;

/**
 * The main thread's recent stage changes, so a product baked against an older
 * stage can be checked before it is handed on: a terrain page published after
 * a change that touches it describes ground that is no longer there.
 */
export class InfrastructureChangeLog {
  private readonly changes: InfrastructureChange[] = [];
  /** The newest version no longer logged: anything baked before it is unknown. */
  private floor = 0;

  record(change: InfrastructureChange): void {
    this.changes.push(change);
    if (this.changes.length > INFRASTRUCTURE_CHANGE_LOG_LENGTH) this.floor = this.changes.shift()!.version;
  }

  /**
   * Whether a change made after `version` touched the rectangle (true when
   * the log no longer reaches back that far).
   */
  touchedSince(version: number, rect: InfrastructureRect): boolean {
    if (version < this.floor) return true;
    for (let i = this.changes.length - 1; i >= 0; i -= 1) {
      const change = this.changes[i]!;
      if (change.version <= version) break;
      if (infrastructureChangeTouches(change, rect)) return true;
    }
    return false;
  }
}
