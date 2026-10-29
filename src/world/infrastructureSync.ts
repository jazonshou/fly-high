import {
  changeInfrastructureRegions,
  INFRASTRUCTURE_MAX_PARAMS,
  infrastructureChangeTouches,
  infrastructureRegionsVersion,
  installedInfrastructureRegionKeys,
  installedInfrastructureRegions,
  type InfrastructureChange,
  type InfrastructureMode,
  type InfrastructureRail,
  type InfrastructureRect,
  type InfrastructureRegion,
  type InfrastructureSegment,
  type InfrastructureSurface,
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
 * An update as it is posted to a worker (`packInfrastructureRegionsUpdate`):
 * each region's segments in one Float64Array, which the structured clone
 * copies as bytes. As objects, a region of 400 segments took 1 to 3 ms of the
 * main thread to clone, once for each worker, in the frame that installed it.
 */
export interface InfrastructureRegionsPost {
  readonly version: number;
  readonly reset: boolean;
  readonly install: readonly InfrastructureRegionPost[];
  readonly remove: readonly string[];
}

export interface InfrastructureRegionPost {
  readonly key: string;
  /** `INFRASTRUCTURE_POST_SEGMENT_FLOATS` a segment (`packSegment`). */
  readonly segments: Float64Array;
  readonly rails?: readonly InfrastructureRail[];
}

const POST_MODES: readonly InfrastructureMode[] = ["set", "cut", "fill"];
const POST_SURFACES: readonly InfrastructureSurface[] = ["concrete", "asphalt", "gravel", "track"];

/**
 * A segment's floats: profile, mode, priority, ax, az, bx, bz, halfWidth,
 * reach, the parameter count and `INFRASTRUCTURE_MAX_PARAMS` parameters,
 * then surface (-1 for none), plant clearance and key (NaN for none).
 */
export const INFRASTRUCTURE_POST_SEGMENT_FLOATS = 13 + INFRASTRUCTURE_MAX_PARAMS;

function postIndex<T>(names: readonly T[], name: T): number {
  const index = names.indexOf(name);
  if (index < 0) throw new RangeError(`Infrastructure segment names an unknown ${String(name)}`);
  return index;
}

/** Each region's post, made once however many workers it goes to. */
const REGION_POSTS = new WeakMap<InfrastructureRegion, InfrastructureRegionPost>();

function packRegion(region: InfrastructureRegion): InfrastructureRegionPost {
  let post = REGION_POSTS.get(region);
  if (post) return post;
  const stride = INFRASTRUCTURE_POST_SEGMENT_FLOATS;
  const floats = new Float64Array(region.segments.length * stride);
  region.segments.forEach((segment, index) => {
    if (segment.params.length > INFRASTRUCTURE_MAX_PARAMS) {
      throw new RangeError(`Infrastructure segment has more than ${INFRASTRUCTURE_MAX_PARAMS} parameters`);
    }
    const at = index * stride;
    floats[at] = segment.profile;
    floats[at + 1] = postIndex(POST_MODES, segment.mode);
    floats[at + 2] = segment.priority;
    floats[at + 3] = segment.ax;
    floats[at + 4] = segment.az;
    floats[at + 5] = segment.bx;
    floats[at + 6] = segment.bz;
    floats[at + 7] = segment.halfWidth;
    floats[at + 8] = segment.reach;
    floats[at + 9] = segment.params.length;
    for (let p = 0; p < segment.params.length; p += 1) floats[at + 10 + p] = segment.params[p]!;
    const tail = at + 10 + INFRASTRUCTURE_MAX_PARAMS;
    floats[tail] = segment.surface === undefined ? -1 : postIndex(POST_SURFACES, segment.surface);
    floats[tail + 1] = segment.plantClearance ?? Number.NaN;
    floats[tail + 2] = segment.key ?? Number.NaN;
  });
  post = { key: region.key, segments: floats, ...(region.rails ? { rails: region.rails } : {}) };
  REGION_POSTS.set(region, post);
  return post;
}

function unpackRegion(post: InfrastructureRegionPost): InfrastructureRegion {
  const stride = INFRASTRUCTURE_POST_SEGMENT_FLOATS;
  const floats = post.segments;
  const segments: InfrastructureSegment[] = [];
  for (let at = 0; at < floats.length; at += stride) {
    const tail = at + 10 + INFRASTRUCTURE_MAX_PARAMS;
    const surface = floats[tail]!;
    const plantClearance = floats[tail + 1]!;
    const key = floats[tail + 2]!;
    segments.push({
      profile: floats[at]!,
      mode: POST_MODES[floats[at + 1]!]!,
      priority: floats[at + 2]!,
      ax: floats[at + 3]!,
      az: floats[at + 4]!,
      bx: floats[at + 5]!,
      bz: floats[at + 6]!,
      halfWidth: floats[at + 7]!,
      reach: floats[at + 8]!,
      params: Array.from(floats.subarray(at + 10, at + 10 + floats[at + 9]!)),
      ...(surface >= 0 ? { surface: POST_SURFACES[surface]! } : {}),
      ...(Number.isNaN(plantClearance) ? {} : { plantClearance }),
      ...(Number.isNaN(key) ? {} : { key }),
    });
  }
  return { key: post.key, segments, ...(post.rails ? { rails: post.rails } : {}) };
}

/** An update as a worker is posted it. */
export function packInfrastructureRegionsUpdate(update: InfrastructureRegionsUpdate): InfrastructureRegionsPost {
  return { version: update.version, reset: update.reset, install: update.install.map(packRegion), remove: update.remove };
}

/** A posted update as the worker applies it: the regions as they were packed. */
export function unpackInfrastructureRegionsPost(post: InfrastructureRegionsPost): InfrastructureRegionsUpdate {
  return { version: post.version, reset: post.reset, install: post.install.map(unpackRegion), remove: post.remove };
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
