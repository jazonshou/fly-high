import { INFRASTRUCTURE_PROFILES } from "./infrastructureProfiles";
import { INFRASTRUCTURE_SOURCES } from "./infrastructureSources";
import type { WorldDefinition } from "./types";

/**
 * The infrastructure stage: earthworks that people built, applied to the
 * ground after the landforms and before the airports (natural -> dunes ->
 * volcanic overlay -> INFRASTRUCTURE -> airport earthworks). Slipways, quay
 * aprons, breakwaters, dredged basins, car parks and, later, road cuts and
 * fills.
 *
 * WHY BEFORE THE AIRPORTS. The runway platform is the sim's exact Class-K fast
 * path (`sampleTerrainCollisionHeight`), which assumes the airport shapes the
 * ground last. A source keeps clear of airports instead: the home marina
 * places itself clear of the home field, and a spawned airport is refused near
 * any segment (`infrastructureNear`, asked by `spawnedAirportGroundAllowed`).
 *
 * SOURCES AND SEGMENTS. Each entry of `INFRASTRUCTURE_SOURCES` turns a world
 * into straight segments (and named anchors, such as the marina car park a
 * vehicle spawns at). A segment is a capsule of influence round its centreline:
 * a profile, chosen by id from `INFRASTRUCTURE_PROFILES`, maps a point's
 * position along and across it, and the height so far, to a target height and
 * a weight, and the segment's mode composes the target into the height:
 *
 *   set:  h += (t - h) w           (a pad, a road, a slipway: the target wins)
 *   cut:  h += (min(h, t) - h) w   (a dredged basin only ever lowers the bed)
 *   fill: h += (max(h, t) - h) w   (a breakwater only ever raises it)
 *
 * with w clamped to [0, 1], and w = 1 giving t exactly.
 *
 * Segments compose in `priority` order, lower first, ties in source order and
 * then in the order a source lists them; `h` is the running height, so a later
 * segment builds on an earlier one. A source reads the ground BEFORE the stage
 * (`sampleTerrainHeightBeforeEarthworks`), so a layout never feeds back into
 * where it goes; reading the staged height from a source throws.
 *
 * CONTAINMENT. With no sources, outside every segment's reach, and in eroded
 * worlds (whose GPU path has no landform or infrastructure stage, as
 * `applyTerrainLandforms` notes), the stage returns the height it was given
 * itself, so the aircraft, every airport and every baseline are unchanged.
 *
 * STREAMED REGIONS. A source too large to lay out at once (the roads)
 * installs regions instead: `installInfrastructureRegions` takes squares of
 * segments a worker generated near the observer and drops ones left behind.
 * Regions belong to the world's TERRAIN (`infrastructureTerrainKey`: seed,
 * sea, evolution, province, landforms and the home field), not to the world
 * object, so a spawned airport's new world keeps them. Each streamed segment
 * carries an order `key`, unique across every region its terrain can hold,
 * and the index composes by (priority, static before streamed, source order or
 * key): the same regions give the same index whatever order they arrived in.
 * Installing or removing bumps the terrain's version; the next sample builds
 * the index again (static sources once per world, regions on top), and every
 * consumer that compares index objects (the GPU twin) repacks.
 *
 * Consumers that lay things out on the ground BEFORE the stage never see a
 * region: sources read `sampleTerrainHeightBeforeEarthworks`; a spawned
 * airport's veto (`infrastructureNear`) reads the static sources' index
 * (roads keep spawned airports off their corridors themselves); hydrology
 * samples inside `withStaticInfrastructure`, which pins the index to the
 * static sources' for the call.
 *
 * The index is built lazily, once per world object and region version, on the
 * first sample that needs it, and costs one bin lookup per sample after that.
 * The GPU twin (`TerrainInfrastructureKernel.ts`) packs the same index and
 * runs the same profiles; the two agree within a millimetre.
 */

/** Edge of an index bin, metres. */
export const INFRASTRUCTURE_BIN_METERS = 512;

/** Most parameters one segment carries (two vec4s on the GPU). */
export const INFRASTRUCTURE_MAX_PARAMS = 8;

/** How a segment's target composes into the height. */
export type InfrastructureMode = "set" | "cut" | "fill";

/**
 * The material a segment paints, named here; the renderer maps it to a splat
 * material and the tyres to a surface. A track is two worn ruts in the ground.
 */
export type InfrastructureSurface = "concrete" | "asphalt" | "gravel" | "track";

export interface InfrastructureSegment {
  /** Index into `INFRASTRUCTURE_PROFILES`. */
  readonly profile: number;
  readonly mode: InfrastructureMode;
  /** Composition order: lower first. */
  readonly priority: number;
  /** Centreline ends, world metres. a = b makes a disc. */
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  /** Half width of the built core round the centreline, metres. */
  readonly halfWidth: number;
  /**
   * How far beyond `halfWidth` the profile can move the ground (batters,
   * blends). The stage skips the segment at or past halfWidth + reach, so the
   * profile's weight must be 0 there.
   */
  readonly reach: number;
  /** Profile parameters, at most `INFRASTRUCTURE_MAX_PARAMS`; missing ones read 0. */
  readonly params: readonly number[];
  /** Painted over the core (capsule distance <= halfWidth). */
  readonly surface?: InfrastructureSurface;
  /** No plants within halfWidth + reach + this many metres. Defaults to 0. */
  readonly plantClearance?: number;
  /**
   * A streamed segment's place among the streamed segments of its priority,
   * lower first: an integer unique across every region its terrain can hold
   * (the roads use edge id x 2^20 + piece index). Required in a region; a
   * static source leaves it out, and at equal priority its segments compose
   * before any region's, in source order.
   */
  readonly key?: number;
}

/** A named place a source publishes: a spawn point, a car park. */
export interface InfrastructureAnchor {
  readonly name: string;
  readonly x: number;
  readonly z: number;
  /** Clockwise from world north (+z), radians, as airports use. */
  readonly headingRadians: number;
}

export interface InfrastructureLayout {
  readonly segments: readonly InfrastructureSegment[];
  readonly anchors?: readonly InfrastructureAnchor[];
}

/** One source: a pure function of the world, memoised by its owner if costly. */
export type InfrastructureSource = (world: WorldDefinition) => InfrastructureLayout;

/** A world-space rectangle, metres. */
export interface InfrastructureRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/**
 * One streamed square of a source: its segments, each with an order `key`.
 * A region's content is a pure function of its `key` (for the roads,
 * `roads:<layer>:<rx>:<rz>`), so installing a key already installed changes
 * nothing.
 */
export interface InfrastructureRegion {
  readonly key: string;
  readonly segments: readonly InfrastructureSegment[];
}

/** What a profile writes: an absolute target height and a weight in [0, 1]. */
export interface InfrastructureProfileSample {
  target: number;
  weight: number;
}

export interface InfrastructureProfile {
  /** Its index in `INFRASTRUCTURE_PROFILES`; the GPU dispatches on it. */
  readonly id: number;
  /** WGSL name suffix: the twin is `terrainInfra_<name>`. */
  readonly name: string;
  /**
   * `along` is metres from a towards b, unclamped (negative behind a, past
   * `length` beyond b); `across` is signed metres, positive to the right of
   * a->b seen from above. `ground` is the running height, `seaLevel` the
   * world's. Called only inside the segment's capsule of influence.
   */
  readonly height: (
    along: number,
    across: number,
    length: number,
    segment: InfrastructureSegment,
    ground: number,
    seaLevel: number,
    out: InfrastructureProfileSample,
  ) => void;
  /**
   * The twin, defining `fn terrainInfra_<name>(along: f32, across: f32,
   * seg: TerrainInfrastructureSegment, ground: f32, seaLevel: f32) -> vec2f`
   * returning (target, weight). It may use the terrain kernel's helpers
   * (`kSmoothstep`, `kSaturate`, `kLerp`) and `terrainInfraCapsuleDistance`.
   */
  readonly wgsl: string;
}

/**
 * Distance from a point to a segment's centreline, from its along/across
 * coordinates: the capsule distance every round-ended area uses.
 */
export function infrastructureCapsuleDistance(along: number, across: number, length: number): number {
  if (along < 0) return Math.hypot(along, across);
  if (along > length) return Math.hypot(along - length, across);
  return Math.abs(across);
}

const MODE_SET = 0;
const MODE_CUT = 1;
const MODE_FILL = 2;

/** A segment as the stage evaluates it. */
export interface PackedInfrastructureSegment {
  readonly segment: InfrastructureSegment;
  readonly profile: InfrastructureProfile;
  readonly mode: number;
  readonly ax: number;
  readonly az: number;
  /** Unit direction a->b ((1, 0) for a disc). */
  readonly dirX: number;
  readonly dirZ: number;
  readonly length: number;
  /** halfWidth + reach. */
  readonly radius: number;
}

/** A point's position on a packed segment; `out` is returned. */
export function infrastructureSegmentLocal(
  packed: PackedInfrastructureSegment,
  x: number,
  z: number,
  out: { along: number; across: number },
): { along: number; across: number } {
  const dx = x - packed.ax;
  const dz = z - packed.az;
  out.along = dx * packed.dirX + dz * packed.dirZ;
  // Right of a->b seen from above (+X east, +Z north): (dirZ, -dirX).
  out.across = dx * packed.dirZ - dz * packed.dirX;
  return out;
}

const LOCAL = { along: 0, across: 0 };

export interface InfrastructureIndex {
  /** Every segment, in composition order. */
  readonly segments: readonly PackedInfrastructureSegment[];
  /** Bin key -> indexes into `segments`, ascending (composition order). */
  readonly bins: ReadonlyMap<number, Int32Array>;
  readonly anchors: ReadonlyMap<string, InfrastructureAnchor>;
  /** Integer bin range covered, inclusive; empty (min > max) with no segments. */
  readonly binMinX: number;
  readonly binMinZ: number;
  readonly binMaxX: number;
  readonly binMaxZ: number;
  /** The plant-free capsules segments ask for (`plantClearance`), in composition order. */
  readonly plantExclusions: readonly InfrastructurePlantExclusion[];
  /** Bin key -> indexes into `plantExclusions` whose blend band reaches the bin, ascending. */
  readonly plantBins: ReadonlyMap<number, Int32Array>;
}

/** See `capsuleReachesBin`. */
const BIN_EDGE_MARGIN_METERS = 1;

const BIN_OFFSET = 1 << 20;
const BIN_STRIDE = 1 << 21;

export function infrastructureBinKey(binX: number, binZ: number): number {
  return (binX + BIN_OFFSET) * BIN_STRIDE + (binZ + BIN_OFFSET);
}

export function infrastructureBin(coordinate: number): number {
  return Math.floor(coordinate / INFRASTRUCTURE_BIN_METERS);
}

const EMPTY_INDEX: InfrastructureIndex = Object.freeze({
  segments: Object.freeze([]),
  bins: new Map(),
  anchors: new Map(),
  binMinX: 0,
  binMinZ: 0,
  binMaxX: -1,
  binMaxZ: -1,
  plantExclusions: Object.freeze([]),
  plantBins: new Map(),
});

/**
 * A world's terrain identity: everything an infrastructure source's layout
 * depends on (seed, sea level, evolution, forced province and landforms, the
 * home field), and nothing it does not (the spawned airports). Streamed
 * regions are installed per terrain, so a spawned airport's new world keeps
 * them. Cached per world object.
 */
export function infrastructureTerrainKey(world: WorldDefinition): string {
  let key = terrainKeys.get(world);
  if (key === undefined) {
    const airport = world.airport;
    key = [
      world.seedHash,
      world.seaLevel,
      world.worldEvolution,
      JSON.stringify(world.climateProvince ?? null),
      JSON.stringify(world.landforms ?? null),
      airport
        ? [airport.centerX, airport.centerZ, airport.headingRadians, airport.elevation, airport.runwayLength,
          airport.runwayWidth, airport.endSafetyArea, airport.shoulderWidth, airport.terrainBlendDistance].join(",")
        : "none",
    ].join("|");
    terrainKeys.set(world, key);
  }
  return key;
}

const terrainKeys = new WeakMap<WorldDefinition, string>();

/**
 * A segment prepared for an index, once, when its source is laid out or its
 * region installed: what orders it, its packed form, and the bins it and its
 * plant band are listed in. An index is then a sort and an assembly, so
 * installing a region does not re-bin every segment already there.
 */
interface OrderedSegment {
  readonly segment: InfrastructureSegment;
  /** 0 for a static source's, 1 for a region's. */
  readonly group: number;
  /** Static: position across the sources. Streamed: the segment's key. */
  readonly order: number;
  /** Streamed only, for a key two regions share by mistake: the region's key, then the position in it. */
  readonly region: string;
  readonly position: number;
  readonly packed: PackedInfrastructureSegment;
  /** Keys of the bins its capsule of influence reaches. */
  readonly bins: Float64Array;
  /** The bin range those cover, inclusive. */
  readonly binMinX: number;
  readonly binMinZ: number;
  readonly binMaxX: number;
  readonly binMaxZ: number;
  /** Its plant-free capsule and the bins that capsule's blend band reaches; null without a clearance. */
  readonly exclusion: InfrastructurePlantExclusion | null;
  readonly plantBins: Float64Array | null;
}

function prepareSegment(
  segment: InfrastructureSegment,
  group: number,
  order: number,
  region: string,
  position: number,
): OrderedSegment {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const length = Math.hypot(dx, dz);
  const packed: PackedInfrastructureSegment = Object.freeze({
    segment,
    profile: INFRASTRUCTURE_PROFILES[segment.profile]!,
    mode: segment.mode === "set" ? MODE_SET : segment.mode === "cut" ? MODE_CUT : MODE_FILL,
    ax: segment.ax,
    az: segment.az,
    dirX: length > 0 ? dx / length : 1,
    dirZ: length > 0 ? dz / length : 0,
    length,
    radius: segment.halfWidth + segment.reach,
  });
  const bins: number[] = [];
  let binMinX = Infinity;
  let binMinZ = Infinity;
  let binMaxX = -Infinity;
  let binMaxZ = -Infinity;
  forEachBinReached(packed, packed.radius, (binX, binZ) => {
    bins.push(infrastructureBinKey(binX, binZ));
    binMinX = Math.min(binMinX, binX);
    binMinZ = Math.min(binMinZ, binZ);
    binMaxX = Math.max(binMaxX, binX);
    binMaxZ = Math.max(binMaxZ, binZ);
  });
  let exclusion: InfrastructurePlantExclusion | null = null;
  let plantBins: Float64Array | null = null;
  if (segment.plantClearance !== undefined) {
    exclusion = Object.freeze({
      ax: segment.ax,
      az: segment.az,
      bx: segment.bx,
      bz: segment.bz,
      radius: segment.halfWidth + segment.reach + segment.plantClearance,
    });
    const keys: number[] = [];
    forEachBinReached(packed, exclusion.radius + INFRASTRUCTURE_PLANT_BLEND_METERS, (binX, binZ) => {
      keys.push(infrastructureBinKey(binX, binZ));
    });
    plantBins = Float64Array.from(keys);
  }
  return {
    segment, group, order, region, position, packed,
    bins: Float64Array.from(bins), binMinX, binMinZ, binMaxX, binMaxZ,
    exclusion, plantBins,
  };
}

function compareOrdered(left: OrderedSegment, right: OrderedSegment): number {
  return left.segment.priority - right.segment.priority
    || left.group - right.group
    || left.order - right.order
    || (left.region < right.region ? -1 : left.region > right.region ? 1 : 0)
    || left.position - right.position;
}

/** The static sources' part of a world's index, and what it is built from. */
interface StaticInfrastructure {
  readonly index: InfrastructureIndex;
  readonly ordered: readonly OrderedSegment[];
  readonly anchors: ReadonlyMap<string, InfrastructureAnchor>;
}

const EMPTY_STATIC: StaticInfrastructure = Object.freeze({
  index: EMPTY_INDEX,
  ordered: Object.freeze([]),
  anchors: EMPTY_INDEX.anchors,
});

/** An installed region: its validated segments and the rectangle they can change. */
interface InstalledRegion {
  readonly key: string;
  readonly ordered: readonly OrderedSegment[];
  /** Null for a region with no segments. */
  readonly bounds: InfrastructureRect | null;
}

interface RegionRegistry {
  readonly regions: Map<string, InstalledRegion>;
  version: number;
}

/** Terrain key -> its installed regions. */
const registries = new Map<string, RegionRegistry>();
/** Bumped on every install, removal or clear anywhere: the fast path's check. */
let registryEpoch = 0;

/** The static sources' index per world object. */
const staticIndexes = new WeakMap<WorldDefinition, StaticInfrastructure>();
/** The full index per world object, with the registry version it was built at. */
const composedIndexes = new WeakMap<WorldDefinition, {
  readonly registry: RegionRegistry;
  readonly version: number;
  readonly index: InfrastructureIndex;
}>();
let lastWorld: WorldDefinition | null = null;
let lastEpoch = -1;
let lastIndex: InfrastructureIndex = EMPTY_INDEX;
let building: WorldDefinition | null = null;
/** Above 0 inside `withStaticInfrastructure`. */
let staticScope = 0;

/**
 * The world's infrastructure index: its static sources and every region
 * installed for its terrain, built on first use after any change. Inside
 * `withStaticInfrastructure`, the static sources' alone. Sources that call
 * back into the staged height while it is built throw rather than recurse.
 */
export function infrastructureIndex(
  world: WorldDefinition,
  sources: readonly InfrastructureSource[] = INFRASTRUCTURE_SOURCES,
): InfrastructureIndex {
  if (sources === INFRASTRUCTURE_SOURCES) {
    if (world.worldEvolution === "eroded") return EMPTY_INDEX;
    if (staticScope > 0) return staticInfrastructure(world).index;
    if (world === lastWorld && registryEpoch === lastEpoch) return lastIndex;
    const registry = registries.get(infrastructureTerrainKey(world));
    let index: InfrastructureIndex;
    if (!registry || registry.regions.size === 0) {
      index = staticInfrastructure(world).index;
    } else {
      const cached = composedIndexes.get(world);
      if (cached && cached.registry === registry && cached.version === registry.version) {
        index = cached.index;
      } else {
        index = composeWorldIndex(world, registry);
        composedIndexes.set(world, { registry, version: registry.version, index });
      }
    }
    lastWorld = world;
    lastEpoch = registryEpoch;
    lastIndex = index;
    return index;
  }
  // An explicit source list (tests, tools): built fresh, never cached, no regions.
  if (world.worldEvolution === "eroded") return EMPTY_INDEX;
  return buildIndexGuarded(world, sources);
}

/**
 * The static sources' index alone: what consumers that must never see a
 * streamed region read (a spawned airport's veto, and everything inside
 * `withStaticInfrastructure`).
 */
export function staticInfrastructureIndex(world: WorldDefinition): InfrastructureIndex {
  if (world.worldEvolution === "eroded") return EMPTY_INDEX;
  return staticInfrastructure(world).index;
}

/**
 * Run `sample` with every `infrastructureIndex` of the world's own sources
 * pinned to the static sources' index: the ground as if no region were
 * installed, bit for bit. Hydrology samples this way, so a river or lake laid
 * out on the main thread after roads arrive is the one the worker (which has
 * none) lays out.
 */
export function withStaticInfrastructure<T>(sample: () => T): T {
  staticScope += 1;
  try {
    return sample();
  } finally {
    staticScope -= 1;
  }
}

function staticInfrastructure(world: WorldDefinition): StaticInfrastructure {
  let found = staticIndexes.get(world);
  if (!found) {
    found = INFRASTRUCTURE_SOURCES.length === 0 ? EMPTY_STATIC : buildStaticGuarded(world, INFRASTRUCTURE_SOURCES);
    staticIndexes.set(world, found);
  }
  return found;
}

function composeWorldIndex(world: WorldDefinition, registry: RegionRegistry): InfrastructureIndex {
  const own = staticInfrastructure(world);
  const ordered = own.ordered.slice();
  for (const region of registry.regions.values()) {
    for (const entry of region.ordered) ordered.push(entry);
  }
  return composeIndex(ordered, own.anchors);
}

function buildIndexGuarded(world: WorldDefinition, sources: readonly InfrastructureSource[]): InfrastructureIndex {
  return buildStaticGuarded(world, sources).index;
}

function buildStaticGuarded(world: WorldDefinition, sources: readonly InfrastructureSource[]): StaticInfrastructure {
  if (building !== null) {
    throw new Error(
      "An infrastructure source read the staged terrain height; sources read sampleTerrainHeightBeforeEarthworks",
    );
  }
  building = world;
  try {
    return buildStatic(world, sources);
  } finally {
    building = null;
  }
}

function validateSegment(segment: InfrastructureSegment): void {
  const finite = [segment.ax, segment.az, segment.bx, segment.bz, segment.halfWidth, segment.reach, segment.priority]
    .every(Number.isFinite);
  if (!finite || segment.halfWidth < 0 || segment.reach < 0) {
    throw new RangeError("Infrastructure segment needs finite ends and non-negative halfWidth and reach");
  }
  if (!Number.isInteger(segment.profile) || INFRASTRUCTURE_PROFILES[segment.profile]?.id !== segment.profile) {
    throw new RangeError(`Unknown infrastructure profile ${segment.profile}`);
  }
  if (segment.mode !== "set" && segment.mode !== "cut" && segment.mode !== "fill") {
    throw new RangeError(`Unknown infrastructure mode ${String(segment.mode)}`);
  }
  if (segment.params.length > INFRASTRUCTURE_MAX_PARAMS || !segment.params.every(Number.isFinite)) {
    throw new RangeError(`Infrastructure segment takes at most ${INFRASTRUCTURE_MAX_PARAMS} finite params`);
  }
  if (segment.plantClearance !== undefined && !(segment.plantClearance >= 0)) {
    throw new RangeError("Infrastructure plantClearance must be non-negative");
  }
}

function buildStatic(world: WorldDefinition, sources: readonly InfrastructureSource[]): StaticInfrastructure {
  const ordered: OrderedSegment[] = [];
  const anchors = new Map<string, InfrastructureAnchor>();
  for (const source of sources) {
    const layout = source(world);
    for (const segment of layout.segments) {
      validateSegment(segment);
      ordered.push(prepareSegment(segment, 0, ordered.length, "", 0));
    }
    for (const anchor of layout.anchors ?? []) {
      if (anchors.has(anchor.name)) throw new Error(`Duplicate infrastructure anchor "${anchor.name}"`);
      if (![anchor.x, anchor.z, anchor.headingRadians].every(Number.isFinite)) {
        throw new RangeError(`Infrastructure anchor "${anchor.name}" must be finite`);
      }
      anchors.set(anchor.name, Object.freeze({ ...anchor }));
    }
  }
  // composeIndex sorts `ordered` in place, so the frozen list is in composition order too.
  return Object.freeze({ index: composeIndex(ordered, anchors), ordered: Object.freeze(ordered), anchors });
}

/** Build an index from explicit sources; `infrastructureIndex` caches the world's own. */
export function buildInfrastructureIndex(
  world: WorldDefinition,
  sources: readonly InfrastructureSource[],
): InfrastructureIndex {
  return buildStatic(world, sources).index;
}

function composeIndex(
  ordered: OrderedSegment[],
  anchors: ReadonlyMap<string, InfrastructureAnchor>,
): InfrastructureIndex {
  if (ordered.length === 0) return anchors.size === 0 ? EMPTY_INDEX : { ...EMPTY_INDEX, anchors };
  ordered.sort(compareOrdered);

  const segments: PackedInfrastructureSegment[] = new Array(ordered.length);
  const lists = new Map<number, number[]>();
  const plantExclusions: InfrastructurePlantExclusion[] = [];
  const plantLists = new Map<number, number[]>();
  let binMinX = Infinity;
  let binMinZ = Infinity;
  let binMaxX = -Infinity;
  let binMaxZ = -Infinity;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    segments[index] = entry.packed;
    for (let b = 0; b < entry.bins.length; b += 1) {
      const key = entry.bins[b]!;
      let list = lists.get(key);
      if (!list) {
        list = [];
        lists.set(key, list);
      }
      list.push(index);
    }
    if (entry.bins.length > 0) {
      binMinX = Math.min(binMinX, entry.binMinX);
      binMinZ = Math.min(binMinZ, entry.binMinZ);
      binMaxX = Math.max(binMaxX, entry.binMaxX);
      binMaxZ = Math.max(binMaxZ, entry.binMaxZ);
    }
    if (entry.exclusion && entry.plantBins) {
      const at = plantExclusions.length;
      plantExclusions.push(entry.exclusion);
      for (let b = 0; b < entry.plantBins.length; b += 1) {
        const key = entry.plantBins[b]!;
        let list = plantLists.get(key);
        if (!list) {
          list = [];
          plantLists.set(key, list);
        }
        list.push(at);
      }
    }
  }
  const bins = new Map<number, Int32Array>();
  for (const [key, list] of lists) bins.set(key, Int32Array.from(list));
  const plantBins = new Map<number, Int32Array>();
  for (const [key, list] of plantLists) plantBins.set(key, Int32Array.from(list));
  return Object.freeze({
    segments: Object.freeze(segments),
    bins,
    anchors,
    binMinX,
    binMinZ,
    binMaxX,
    binMaxZ,
    plantExclusions: Object.freeze(plantExclusions),
    plantBins,
  });
}

/** Every bin a capsule of `radius` round the segment's centreline reaches. */
function forEachBinReached(
  packed: PackedInfrastructureSegment,
  radius: number,
  visit: (binX: number, binZ: number) => void,
): void {
  const { segment } = packed;
  const x0 = infrastructureBin(Math.min(segment.ax, segment.bx) - radius);
  const x1 = infrastructureBin(Math.max(segment.ax, segment.bx) + radius);
  const z0 = infrastructureBin(Math.min(segment.az, segment.bz) - radius);
  const z1 = infrastructureBin(Math.max(segment.az, segment.bz) + radius);
  for (let binX = x0; binX <= x1; binX += 1) {
    for (let binZ = z0; binZ <= z1; binZ += 1) {
      // Only bins the capsule actually reaches: a long diagonal road should
      // not list itself in every bin of its bounding box.
      if (capsuleReachesBin(packed, radius, binX, binZ)) visit(binX, binZ);
    }
  }
}

// ---- streamed regions ---------------------------------------------------------------------------------------

/** How far past its centreline a segment can change anything: its reach, or its plants' blend band. */
function segmentOuterRadius(segment: InfrastructureSegment): number {
  const radius = segment.halfWidth + segment.reach;
  return segment.plantClearance === undefined
    ? radius
    : Math.max(radius, radius + segment.plantClearance + INFRASTRUCTURE_PLANT_BLEND_METERS);
}

function installRegion(region: InfrastructureRegion): InstalledRegion {
  const ordered: OrderedSegment[] = [];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  region.segments.forEach((segment, position) => {
    validateSegment(segment);
    if (segment.key === undefined || !Number.isSafeInteger(segment.key)) {
      throw new RangeError(`Streamed infrastructure segment in "${region.key}" needs an integer order key`);
    }
    ordered.push(prepareSegment(segment, 1, segment.key, region.key, position));
    const outer = segmentOuterRadius(segment);
    minX = Math.min(minX, segment.ax - outer, segment.bx - outer);
    minZ = Math.min(minZ, segment.az - outer, segment.bz - outer);
    maxX = Math.max(maxX, segment.ax + outer, segment.bx + outer);
    maxZ = Math.max(maxZ, segment.az + outer, segment.bz + outer);
  });
  return Object.freeze({
    key: region.key,
    ordered: Object.freeze(ordered),
    bounds: ordered.length === 0 ? null : Object.freeze({ minX, minZ, maxX, maxZ }),
  });
}

/**
 * Install streamed regions for the world's terrain and remove others, in one
 * change: the terrain's version bumps once if anything changed, and the next
 * sample of any world on that terrain builds the index again. Installing a key
 * already installed, or removing one that is not, changes nothing.
 *
 * Returns the rectangles whose ground, paint or plants may have changed (each
 * installed and each removed region's), for the consumers that bake the
 * ground to refresh. A malformed segment throws before anything changes.
 */
export function installInfrastructureRegions(
  world: WorldDefinition,
  install: readonly InfrastructureRegion[],
  remove: readonly string[] = [],
): readonly InfrastructureRect[] {
  if (world.worldEvolution === "eroded") return [];
  const terrain = infrastructureTerrainKey(world);
  const registry = registries.get(terrain) ?? { regions: new Map<string, InstalledRegion>(), version: 0 };
  const incoming: InstalledRegion[] = [];
  for (const region of install) {
    if (registry.regions.has(region.key) || incoming.some((other) => other.key === region.key)) continue;
    incoming.push(installRegion(region));
  }
  const changed: InfrastructureRect[] = [];
  let touched = false;
  for (const key of remove) {
    const region = registry.regions.get(key);
    if (!region) continue;
    registry.regions.delete(key);
    touched = true;
    if (region.bounds) changed.push(region.bounds);
  }
  for (const region of incoming) {
    registry.regions.set(region.key, region);
    touched = true;
    if (region.bounds) changed.push(region.bounds);
  }
  if (touched) {
    registries.set(terrain, registry);
    registry.version += 1;
    registryEpoch += 1;
  }
  return changed;
}

/** The keys of every region installed for the world's terrain, in install order. */
export function installedInfrastructureRegionKeys(world: WorldDefinition): readonly string[] {
  return [...(registries.get(infrastructureTerrainKey(world))?.regions.keys() ?? [])];
}

/** Bumped by every change to the world's terrain's regions (0 with none ever installed). */
export function infrastructureRegionsVersion(world: WorldDefinition): number {
  return registries.get(infrastructureTerrainKey(world))?.version ?? 0;
}

/** Drop every region of the world's terrain (a new session), or of every terrain with no world. */
export function clearInfrastructureRegions(world?: WorldDefinition): void {
  if (world) {
    const registry = registries.get(infrastructureTerrainKey(world));
    if (!registry || registry.regions.size === 0) return;
    registry.regions.clear();
    registry.version += 1;
  } else {
    if (registries.size === 0) return;
    for (const registry of registries.values()) {
      registry.regions.clear();
      registry.version += 1;
    }
  }
  registryEpoch += 1;
}

/** Does a capsule of `radius` round the segment's centreline touch a bin's square? */
function capsuleReachesBin(packed: PackedInfrastructureSegment, radius: number, binX: number, binZ: number): boolean {
  const size = INFRASTRUCTURE_BIN_METERS;
  const half = size / 2;
  const centreX = (binX + 0.5) * size;
  const centreZ = (binZ + 0.5) * size;
  // Distance from the bin centre to the centreline, less the square's
  // circumradius, is a conservative test: never misses a bin it touches. The
  // extra metre covers a GPU point that f32 rounding files in the
  // neighbouring bin, a millimetre over its edge.
  const { along, across } = infrastructureSegmentLocal(packed, centreX, centreZ, LOCAL);
  return infrastructureCapsuleDistance(along, across, packed.length)
    <= radius + half * Math.SQRT2 + BIN_EDGE_MARGIN_METERS;
}

const PROFILE_SAMPLE: InfrastructureProfileSample = { target: 0, weight: 0 };

/**
 * The stage: the height after every segment touching (x, z). Returns
 * `height` itself where none does.
 */
export function applyInfrastructure(
  index: InfrastructureIndex,
  seaLevel: number,
  height: number,
  x: number,
  z: number,
): number {
  if (index.segments.length === 0) return height;
  const binX = infrastructureBin(x);
  const binZ = infrastructureBin(z);
  // Off the binned rectangle (nearly every sample in a world): no map lookup.
  if (binX < index.binMinX || binX > index.binMaxX || binZ < index.binMinZ || binZ > index.binMaxZ) return height;
  const list = index.bins.get(infrastructureBinKey(binX, binZ));
  if (!list) return height;
  let h = height;
  for (let i = 0; i < list.length; i += 1) {
    const packed = index.segments[list[i]!]!;
    const { along, across } = infrastructureSegmentLocal(packed, x, z, LOCAL);
    if (infrastructureCapsuleDistance(along, across, packed.length) >= packed.radius) continue;
    packed.profile.height(along, across, packed.length, packed.segment, h, seaLevel, PROFILE_SAMPLE);
    const weight = PROFILE_SAMPLE.weight;
    if (!(weight > 0)) continue;
    const target = PROFILE_SAMPLE.target;
    if (packed.mode === MODE_CUT ? target < h : packed.mode === MODE_FILL ? target > h : true) {
      // Full weight is the target exactly: h + (t - h) need not round to t,
      // and a quay apron or a pad is meant to be its level to the bit.
      h = weight >= 1 ? target : h + (target - h) * weight;
    }
  }
  return h;
}

/** A published anchor (`"marinaCarPark"`), or null when no source placed it. Static sources publish anchors. */
export function infrastructureAnchor(world: WorldDefinition, name: string): InfrastructureAnchor | null {
  return staticInfrastructureIndex(world).anchors.get(name) ?? null;
}

/**
 * Whether any segment's capsule of influence comes within `clearance` metres
 * of (x, z). Spawned airports ask it, so no airport grades over a quay. By
 * default it reads the static sources' index: a spawned airport must not
 * depend on which regions were installed when it was surveyed (the roads keep
 * airports off their corridors themselves).
 *
 * Reads the bins within `clearance` of the point: a capsule that comes that
 * close has a point that close, in a bin it is listed in.
 */
export function infrastructureNear(
  world: WorldDefinition,
  x: number,
  z: number,
  clearance: number,
  index: InfrastructureIndex = staticInfrastructureIndex(world),
): boolean {
  if (index.segments.length === 0) return false;
  const x0 = Math.max(index.binMinX, infrastructureBin(x - clearance));
  const x1 = Math.min(index.binMaxX, infrastructureBin(x + clearance));
  const z0 = Math.max(index.binMinZ, infrastructureBin(z - clearance));
  const z1 = Math.min(index.binMaxZ, infrastructureBin(z + clearance));
  for (let binX = x0; binX <= x1; binX += 1) {
    for (let binZ = z0; binZ <= z1; binZ += 1) {
      const list = index.bins.get(infrastructureBinKey(binX, binZ));
      if (!list) continue;
      for (let i = 0; i < list.length; i += 1) {
        const packed = index.segments[list[i]!]!;
        const { along, across } = infrastructureSegmentLocal(packed, x, z, LOCAL);
        if (infrastructureCapsuleDistance(along, across, packed.length) < packed.radius + clearance) return true;
      }
    }
  }
  return false;
}

/**
 * Metres over which a painted surface fades out across its edge, centred on
 * `halfWidth`. Narrower than an L0 splat texel (4 m), so the splat's own
 * resolution draws the edge; this only keeps the field continuous.
 */
export const INFRASTRUCTURE_SURFACE_FEATHER_METERS = 1;

/** Where a segment paints the ground: which material, and how much of it. */
export interface InfrastructureSurfaceSample {
  surface: InfrastructureSurface | null;
  coverage: number;
}

/**
 * The painted surface at a point: the segment with the most coverage wins
 * (the later one on a tie, as in composition). What a tyre rolls on, and what
 * the splat bake paints (its twin is `terrainInfrastructureSurface`).
 */
export function sampleInfrastructureSurface(
  index: InfrastructureIndex,
  x: number,
  z: number,
  out: InfrastructureSurfaceSample,
): InfrastructureSurfaceSample {
  out.surface = null;
  out.coverage = 0;
  if (index.segments.length === 0) return out;
  const binX = infrastructureBin(x);
  const binZ = infrastructureBin(z);
  if (binX < index.binMinX || binX > index.binMaxX || binZ < index.binMinZ || binZ > index.binMaxZ) return out;
  const list = index.bins.get(infrastructureBinKey(binX, binZ));
  if (!list) return out;
  for (let i = 0; i < list.length; i += 1) {
    const packed = index.segments[list[i]!]!;
    const surface = packed.segment.surface;
    if (surface === undefined) continue;
    const { along, across } = infrastructureSegmentLocal(packed, x, z, LOCAL);
    const distance = infrastructureCapsuleDistance(along, across, packed.length);
    const coverage = Math.min(1, Math.max(0,
      0.5 + (packed.segment.halfWidth - distance) / INFRASTRUCTURE_SURFACE_FEATHER_METERS));
    if (coverage > 0 && coverage >= out.coverage) {
      out.surface = surface;
      out.coverage = coverage;
    }
  }
  return out;
}

/** Metres over which plants return past a segment's plant-free reach. */
export const INFRASTRUCTURE_PLANT_BLEND_METERS = 4;

/**
 * A plant-free capsule: no stem within `radius` of the segment a-b, plants
 * back to full density `INFRASTRUCTURE_PLANT_BLEND_METERS` beyond it.
 */
export interface InfrastructurePlantExclusion {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly radius: number;
}

/**
 * Every plant-free capsule a world's infrastructure asks for: segments that
 * set `plantClearance` keep plants off halfWidth + reach + plantClearance.
 * Plain data, so it crosses to the detail worker as it is.
 */
export function infrastructurePlantExclusions(
  index: InfrastructureIndex,
): readonly InfrastructurePlantExclusion[] {
  return index.plantExclusions;
}

const NO_PLANT_EXCLUSIONS: readonly InfrastructurePlantExclusion[] = Object.freeze([]);

/**
 * The plant exclusions whose blend band can reach a rectangle, in
 * composition order, from the bins it covers rather than every exclusion:
 * what a detail cell or a ground-cover row tests. Dropping the others never
 * changes a factor (past radius + blend it is exactly 1).
 */
export function infrastructurePlantExclusionsIn(
  index: InfrastructureIndex,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): readonly InfrastructurePlantExclusion[] {
  if (index.plantExclusions.length === 0) return NO_PLANT_EXCLUSIONS;
  const x0 = Math.max(index.binMinX, infrastructureBin(minX));
  const x1 = Math.min(index.binMaxX, infrastructureBin(maxX));
  const z0 = Math.max(index.binMinZ, infrastructureBin(minZ));
  const z1 = Math.min(index.binMaxZ, infrastructureBin(maxZ));
  let found: number[] | null = null;
  for (let binX = x0; binX <= x1; binX += 1) {
    for (let binZ = z0; binZ <= z1; binZ += 1) {
      const list = index.plantBins.get(infrastructureBinKey(binX, binZ));
      if (!list) continue;
      for (let i = 0; i < list.length; i += 1) {
        const at = list[i]!;
        const exclusion = index.plantExclusions[at]!;
        const reach = exclusion.radius + INFRASTRUCTURE_PLANT_BLEND_METERS;
        if (
          Math.min(exclusion.ax, exclusion.bx) - reach > maxX
          || Math.max(exclusion.ax, exclusion.bx) + reach < minX
          || Math.min(exclusion.az, exclusion.bz) - reach > maxZ
          || Math.max(exclusion.az, exclusion.bz) + reach < minZ
        ) continue;
        (found ??= []).push(at);
      }
    }
  }
  if (!found) return NO_PLANT_EXCLUSIONS;
  found.sort((left, right) => left - right);
  const out: InfrastructurePlantExclusion[] = [];
  for (let i = 0; i < found.length; i += 1) {
    if (i > 0 && found[i] === found[i - 1]) continue;
    out.push(index.plantExclusions[found[i]!]!);
  }
  return out;
}

/**
 * 1 where a plant may stand, 0 inside any exclusion, smoothly back to 1 over
 * `INFRASTRUCTURE_PLANT_BLEND_METERS`: a hard zero, like the airfield
 * structures' (`StructureExclusion.ts`), not a thinning.
 */
export function infrastructurePlantFactor(
  exclusions: readonly InfrastructurePlantExclusion[],
  x: number,
  z: number,
): number {
  let factor = 1;
  for (const exclusion of exclusions) {
    const dx = exclusion.bx - exclusion.ax;
    const dz = exclusion.bz - exclusion.az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0
      ? Math.min(1, Math.max(0, ((x - exclusion.ax) * dx + (z - exclusion.az) * dz) / lengthSquared))
      : 0;
    const distance = Math.hypot(x - (exclusion.ax + dx * t), z - (exclusion.az + dz * t));
    const beyond = distance - exclusion.radius;
    if (beyond <= 0) return 0;
    if (beyond < INFRASTRUCTURE_PLANT_BLEND_METERS) {
      const u = beyond / INFRASTRUCTURE_PLANT_BLEND_METERS;
      factor *= u * u * (3 - 2 * u);
    }
  }
  return factor;
}
