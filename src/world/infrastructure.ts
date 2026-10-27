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
 * key): the same regions give the same heights whatever order they arrived
 * in. Installing or removing bumps the terrain's version and composes the
 * index in place: each segment keeps a slot while installed, only the bins
 * the changed regions reach are re-merged, and the next sample sees a new
 * index object. Consumers that compare index objects (the GPU twin) rewrite
 * only the slots that changed (`infrastructureSlotsChanged`).
 *
 * Consumers that lay things out on the ground BEFORE the stage never see a
 * region: sources read `sampleTerrainHeightBeforeEarthworks`; a spawned
 * airport's veto (`infrastructureNear`) reads the static sources' index
 * (roads keep spawned airports off their corridors themselves); hydrology
 * samples inside `withStaticInfrastructure`, which pins the index to the
 * static sources' for the call.
 *
 * The static sources' index is built lazily, once per terrain, on the first
 * sample that needs it; a sample costs one bin lookup after that.
 * The GPU twin (`TerrainInfrastructureKernel.ts`) packs the same index and
 * runs the same profiles; the two agree within a millimetre.
 */

/** Edge of an index bin, metres. */
export const INFRASTRUCTURE_BIN_METERS = 64;

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
  /**
   * Every segment by slot. The static sources' index holds them in
   * composition order; one with regions installed keeps each segment in a
   * stable slot while it is installed, and a free slot holds a segment that
   * reaches nothing.
   */
  readonly segments: readonly PackedInfrastructureSegment[];
  /** Bin key -> slots in `segments` that reach the bin, in composition order. */
  readonly bins: ReadonlyMap<number, ArrayLike<number>>;
  readonly anchors: ReadonlyMap<string, InfrastructureAnchor>;
  /** Integer bin range covered, inclusive; empty (min > max) with no segments. */
  readonly binMinX: number;
  readonly binMinZ: number;
  readonly binMaxX: number;
  readonly binMaxZ: number;
  /**
   * The plant-free capsules segments ask for (`plantClearance`): in
   * composition order in the static sources' index; by slot, with one that
   * excludes nothing in the other slots, once regions are installed. Read
   * them through `infrastructurePlantExclusions` or `...In`.
   */
  readonly plantExclusions: readonly InfrastructurePlantExclusion[];
  /** Bin key -> indexes into `plantExclusions` whose blend band reaches the bin, in composition order. */
  readonly plantBins: ReadonlyMap<number, ArrayLike<number>>;
}

/** See `capsuleReachesBin`. */
const BIN_EDGE_MARGIN_METERS = 1;

const BIN_OFFSET = 1 << 20;
const BIN_STRIDE = 1 << 21;

export function infrastructureBinKey(binX: number, binZ: number): number {
  return (binX + BIN_OFFSET) * BIN_STRIDE + (binZ + BIN_OFFSET);
}

/** The bin x of an `infrastructureBinKey`. */
export function infrastructureBinKeyX(key: number): number {
  return Math.floor(key / BIN_STRIDE) - BIN_OFFSET;
}

/** The bin z of an `infrastructureBinKey`. */
export function infrastructureBinKeyZ(key: number): number {
  return (key % BIN_STRIDE) - BIN_OFFSET;
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
  readonly bins: readonly number[];
  /** The bin range those cover, inclusive. */
  readonly binMinX: number;
  readonly binMinZ: number;
  readonly binMaxX: number;
  readonly binMaxZ: number;
  /** Its plant-free capsule and the bins that capsule's blend band reaches; null without a clearance. */
  readonly exclusion: InfrastructurePlantExclusion | null;
  readonly plantBins: readonly number[] | null;
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
  const bins = binsReached(packed, packed.radius);
  let binMinX = Infinity;
  let binMinZ = Infinity;
  let binMaxX = -Infinity;
  let binMaxZ = -Infinity;
  for (let b = 0; b < bins.length; b += 1) {
    const binX = infrastructureBinKeyX(bins[b]!);
    const binZ = infrastructureBinKeyZ(bins[b]!);
    binMinX = Math.min(binMinX, binX);
    binMinZ = Math.min(binMinZ, binZ);
    binMaxX = Math.max(binMaxX, binX);
    binMaxZ = Math.max(binMaxZ, binZ);
  }
  let exclusion: InfrastructurePlantExclusion | null = null;
  let plantBins: number[] | null = null;
  if (segment.plantClearance !== undefined) {
    exclusion = Object.freeze({
      ax: segment.ax,
      az: segment.az,
      bx: segment.bx,
      bz: segment.bz,
      radius: segment.halfWidth + segment.reach + segment.plantClearance,
    });
    plantBins = binsReached(packed, exclusion.radius + INFRASTRUCTURE_PLANT_BLEND_METERS);
  }
  return {
    segment, group, order, region, position, packed,
    bins, binMinX, binMinZ, binMaxX, binMaxZ,
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

/** The static sources' part of a terrain's index, and what it is built from. */
interface StaticInfrastructure {
  readonly index: InfrastructureIndex;
  /** In composition order: the composed index's slots 0, 1, ... */
  readonly ordered: readonly OrderedSegment[];
  readonly anchors: ReadonlyMap<string, InfrastructureAnchor>;
}

const EMPTY_STATIC: StaticInfrastructure = Object.freeze({
  index: EMPTY_INDEX,
  ordered: Object.freeze([]),
  anchors: EMPTY_INDEX.anchors,
});

/** An installed region: its validated segments, in composition order, and the rectangle they can change. */
interface InstalledRegion {
  readonly key: string;
  /** What was installed, for a worker joining late (`installedInfrastructureRegions`). */
  readonly source: InfrastructureRegion;
  readonly ordered: readonly OrderedSegment[];
  /** Null for a region with no segments. */
  readonly bounds: InfrastructureRect | null;
}

/**
 * A terrain's index with regions installed, kept in place as they come and
 * go (`updateComposed`): every segment has a SLOT, stable while it is
 * installed. The static sources' take slots 0, 1, ... in composition order;
 * a region's take free slots, given back when it is removed. A bin lists the
 * slots that reach it in composition order, so a change re-merges only the
 * bins its regions reach, and the GPU twin rewrites only the slots it wrote.
 */
interface ComposedIndex {
  readonly base: StaticInfrastructure;
  /** By slot; null where free. */
  readonly entries: (OrderedSegment | null)[];
  /** By slot; `INERT_SEGMENT` where free. */
  readonly segments: PackedInfrastructureSegment[];
  /** By slot; `NO_PLANT_EXCLUSION` where free or without a clearance. */
  readonly exclusions: InfrastructurePlantExclusion[];
  readonly free: number[];
  /** Edited in place as regions come and go (a list is never shared with the static index). */
  readonly bins: Map<number, number[]>;
  readonly plantBins: Map<number, number[]>;
  /** Region key -> the slots its segments hold, in its composition order. */
  readonly slotsOf: Map<string, Int32Array>;
  /** The last `COMPOSED_HISTORY` changes, oldest first: the version each made, the slots it wrote and the bins it re-merged. */
  readonly history: InfrastructureIndexChange[];
  /** The index object `infrastructureIndex` returns now. */
  index: InfrastructureIndex;
}

/** One change to a composed index: what a consumer holding a copy rewrites. */
interface InfrastructureIndexChange {
  readonly version: number;
  readonly slots: Int32Array;
  /** Keys of the bins whose segment lists changed (`infrastructureBinKey`). */
  readonly bins: Float64Array;
}

/** How many changes a composed index remembers for consumers catching up (`infrastructureIndexChanges`). */
const COMPOSED_HISTORY = 32;

interface RegionRegistry {
  readonly regions: Map<string, InstalledRegion>;
  version: number;
  /** Null while no region is installed: the index is the static one. */
  composed: ComposedIndex | null;
}

/** Terrain key -> its installed regions. */
const registries = new Map<string, RegionRegistry>();
/** Bumped on every install, removal or clear anywhere: the fast path's check. */
let registryEpoch = 0;

/** A composed index object's origin: its composed index, and the version it was made at. */
const snapshotOrigins = new WeakMap<InfrastructureIndex, {
  readonly composed: ComposedIndex;
  readonly version: number;
}>();

/**
 * The static sources' index per terrain (they are a function of the terrain:
 * `infrastructureTerrainKey`), so every world on a terrain, a spawned
 * airport's included, shares one index object; and per world object, the
 * fast path to it.
 */
const staticByTerrain = new Map<string, StaticInfrastructure>();
const staticByWorld = new WeakMap<WorldDefinition, StaticInfrastructure>();
/** Terrains whose static index is kept (a session has one; tests walk a few). */
const STATIC_TERRAINS_KEPT = 4;
let lastWorld: WorldDefinition | null = null;
let lastEpoch = -1;
let lastIndex: InfrastructureIndex = EMPTY_INDEX;
let building: WorldDefinition | null = null;
/** Above 0 inside `withStaticInfrastructure`. */
let staticScope = 0;

/**
 * The world's infrastructure index: its terrain's static sources and every
 * region installed for that terrain. With no region installed, the static
 * sources' index object itself. Inside `withStaticInfrastructure`, the static
 * sources' alone. Sources that call back into the staged height while it is
 * built throw rather than recurse.
 */
export function infrastructureIndex(
  world: WorldDefinition,
  sources: readonly InfrastructureSource[] = INFRASTRUCTURE_SOURCES,
): InfrastructureIndex {
  if (sources === INFRASTRUCTURE_SOURCES) {
    if (world.worldEvolution === "eroded") return EMPTY_INDEX;
    if (staticScope > 0) return staticInfrastructure(world).index;
    if (world === lastWorld && registryEpoch === lastEpoch) return lastIndex;
    const composed = registries.get(infrastructureTerrainKey(world))?.composed;
    const index = composed ? composed.index : staticInfrastructure(world).index;
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
  const known = staticByWorld.get(world);
  if (known) return known;
  const terrain = infrastructureTerrainKey(world);
  let found = staticByTerrain.get(terrain);
  if (found) {
    staticByTerrain.delete(terrain);
  } else {
    found = INFRASTRUCTURE_SOURCES.length === 0 ? EMPTY_STATIC : buildStaticGuarded(world, INFRASTRUCTURE_SOURCES);
  }
  staticByTerrain.set(terrain, found);
  if (staticByTerrain.size > STATIC_TERRAINS_KEPT) staticByTerrain.delete(staticByTerrain.keys().next().value!);
  staticByWorld.set(world, found);
  return found;
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
  const finite = Number.isFinite(segment.ax) && Number.isFinite(segment.az)
    && Number.isFinite(segment.bx) && Number.isFinite(segment.bz)
    && Number.isFinite(segment.halfWidth) && Number.isFinite(segment.reach) && Number.isFinite(segment.priority);
  if (!finite || segment.halfWidth < 0 || segment.reach < 0) {
    throw new RangeError("Infrastructure segment needs finite ends and non-negative halfWidth and reach");
  }
  if (!Number.isInteger(segment.profile) || INFRASTRUCTURE_PROFILES[segment.profile]?.id !== segment.profile) {
    throw new RangeError(`Unknown infrastructure profile ${segment.profile}`);
  }
  if (segment.mode !== "set" && segment.mode !== "cut" && segment.mode !== "fill") {
    throw new RangeError(`Unknown infrastructure mode ${String(segment.mode)}`);
  }
  const params = segment.params;
  let paramsFinite = params.length <= INFRASTRUCTURE_MAX_PARAMS;
  for (let p = 0; paramsFinite && p < params.length; p += 1) paramsFinite = Number.isFinite(params[p]);
  if (!paramsFinite) {
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

/** The keys of every bin a capsule of `radius` round the segment's centreline reaches. */
function binsReached(packed: PackedInfrastructureSegment, radius: number): number[] {
  const { segment } = packed;
  const x0 = infrastructureBin(Math.min(segment.ax, segment.bx) - radius);
  const x1 = infrastructureBin(Math.max(segment.ax, segment.bx) + radius);
  const z0 = infrastructureBin(Math.min(segment.az, segment.bz) - radius);
  const z1 = infrastructureBin(Math.max(segment.az, segment.bz) + radius);
  const keys: number[] = [];
  for (let binX = x0; binX <= x1; binX += 1) {
    for (let binZ = z0; binZ <= z1; binZ += 1) {
      // Only bins the capsule actually reaches: a long diagonal road should
      // not list itself in every bin of its bounding box.
      if (capsuleReachesBin(packed, radius, binX, binZ)) keys.push(infrastructureBinKey(binX, binZ));
    }
  }
  return keys;
}

// ---- streamed regions ---------------------------------------------------------------------------------------

/** How far past its centreline a segment can change anything: its reach, or its plants' blend band. */
function segmentOuterRadius(segment: InfrastructureSegment): number {
  const radius = segment.halfWidth + segment.reach;
  return segment.plantClearance === undefined
    ? radius
    : Math.max(radius, radius + segment.plantClearance + INFRASTRUCTURE_PLANT_BLEND_METERS);
}

/**
 * Prepared regions by region object: a region dropped and installed again
 * (the observer turned back, and the roads controller kept it) is not
 * validated and binned twice. Its content is a function of its key, so the
 * object is as good as the key.
 */
const preparedRegions = new WeakMap<InfrastructureRegion, InstalledRegion>();

function installRegion(region: InfrastructureRegion): InstalledRegion {
  const known = preparedRegions.get(region);
  if (known) return known;
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
  ordered.sort(compareOrdered);
  const installed: InstalledRegion = Object.freeze({
    key: region.key,
    source: region,
    ordered: Object.freeze(ordered),
    bounds: ordered.length === 0 ? null : Object.freeze({ minX, minZ, maxX, maxZ }),
  });
  preparedRegions.set(region, installed);
  return installed;
}

/** A free slot's segment: it reaches nothing, and no bin lists it. */
const INERT_SEGMENT: PackedInfrastructureSegment = Object.freeze({
  segment: Object.freeze({
    profile: 0,
    mode: "set",
    priority: 0,
    ax: 0,
    az: 0,
    bx: 0,
    bz: 0,
    halfWidth: 0,
    reach: 0,
    params: Object.freeze([]),
  } satisfies InfrastructureSegment),
  profile: INFRASTRUCTURE_PROFILES[0]!,
  mode: MODE_SET,
  ax: 0,
  az: 0,
  dirX: 1,
  dirZ: 0,
  length: 0,
  radius: -1,
});

/** A slot's exclusion where there is none: its factor is 1 everywhere. */
const NO_PLANT_EXCLUSION: InfrastructurePlantExclusion = Object.freeze({
  ax: 0,
  az: 0,
  bx: 0,
  bz: 0,
  radius: Number.NEGATIVE_INFINITY,
});

/** The composed index of a terrain's first region, from its static sources' slots. */
function startComposed(base: StaticInfrastructure): ComposedIndex {
  const entries: (OrderedSegment | null)[] = base.ordered.slice();
  const exclusions = base.ordered.map((entry) => entry.exclusion ?? NO_PLANT_EXCLUSION);
  // The static index's plant lists name compacted exclusions; the composed one's name slots.
  const plantBins = new Map<number, number[]>();
  base.ordered.forEach((entry, slot) => {
    if (!entry.plantBins) return;
    for (let b = 0; b < entry.plantBins.length; b += 1) {
      const key = entry.plantBins[b]!;
      let list = plantBins.get(key);
      if (!list) plantBins.set(key, (list = []));
      list.push(slot);
    }
  });
  return {
    base,
    entries,
    segments: base.index.segments.slice(),
    exclusions,
    free: [],
    bins: new Map([...base.index.bins].map(([key, list]) => [key, Array.from(list)])),
    plantBins,
    slotsOf: new Map(),
    history: [],
    index: base.index,
  };
}

/**
 * Remove regions from a composed index and add others, in place, and make
 * its next index object. Only the bins the regions reach are re-merged.
 */
function updateComposed(
  composed: ComposedIndex,
  removed: readonly InstalledRegion[],
  added: readonly InstalledRegion[],
  version: number,
): void {
  const { entries, segments, exclusions, free, bins, plantBins } = composed;
  const written: number[] = [];
  const touched = new Set<number>();
  if (removed.length > 0) {
    const dropping = new Set<number>();
    const touchedPlants = new Set<number>();
    for (const region of removed) {
      const slots = composed.slotsOf.get(region.key);
      if (!slots) continue;
      composed.slotsOf.delete(region.key);
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i]!;
        const entry = entries[slot]!;
        for (let b = 0; b < entry.bins.length; b += 1) touched.add(entry.bins[b]!);
        if (entry.plantBins) for (let b = 0; b < entry.plantBins.length; b += 1) touchedPlants.add(entry.plantBins[b]!);
        dropping.add(slot);
        entries[slot] = null;
        segments[slot] = INERT_SEGMENT;
        exclusions[slot] = NO_PLANT_EXCLUSION;
        free.push(slot);
        written.push(slot);
      }
    }
    const keep = (slot: number) => !dropping.has(slot);
    for (const key of touched) dropFromList(bins, key, keep);
    for (const key of touchedPlants) dropFromList(plantBins, key, keep);
  }
  if (added.length > 0) {
    // Every added entry, in composition order, so each bin's incoming run is sorted.
    const incoming: { entry: OrderedSegment; slot: number }[] = [];
    // Lowest free slots first, so a steady stream of installs and removals stays packed low.
    free.sort((left, right) => right - left);
    for (const region of added) {
      const slots = new Int32Array(region.ordered.length);
      region.ordered.forEach((entry, i) => {
        const slot = free.length > 0 ? free.pop()! : entries.length;
        entries[slot] = entry;
        segments[slot] = entry.packed;
        exclusions[slot] = entry.exclusion ?? NO_PLANT_EXCLUSION;
        slots[i] = slot;
        written.push(slot);
        incoming.push({ entry, slot });
      });
      composed.slotsOf.set(region.key, slots);
    }
    // One region's are in its composition order already.
    if (added.length > 1) incoming.sort((left, right) => compareOrdered(left.entry, right.entry));
    const runs = new Map<number, number[]>();
    const plantRuns = new Map<number, number[]>();
    for (const { entry, slot } of incoming) {
      for (let b = 0; b < entry.bins.length; b += 1) pushRun(runs, entry.bins[b]!, slot);
      if (entry.plantBins) for (let b = 0; b < entry.plantBins.length; b += 1) pushRun(plantRuns, entry.plantBins[b]!, slot);
    }
    const order = (left: number, right: number) => compareOrdered(entries[left]!, entries[right]!);
    for (const [key, run] of runs) {
      mergeIntoList(bins, key, run, order);
      touched.add(key);
    }
    for (const [key, run] of plantRuns) mergeIntoList(plantBins, key, run, order);
  }
  composed.history.push({ version, slots: Int32Array.from(written), bins: Float64Array.from(touched) });
  if (composed.history.length > COMPOSED_HISTORY) composed.history.shift();
  composed.index = composedIndexObject(composed, version);
}

function pushRun(runs: Map<number, number[]>, key: number, slot: number): void {
  let run = runs.get(key);
  if (!run) runs.set(key, (run = []));
  run.push(slot);
}

/** Drop slots from a bin's list, in place. */
function dropFromList(lists: Map<number, number[]>, key: number, keep: (slot: number) => boolean): void {
  const list = lists.get(key);
  if (!list) return;
  let kept = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (keep(list[i]!)) list[kept++] = list[i]!;
  }
  if (kept === 0) lists.delete(key);
  else list.length = kept;
}

/** Merge a sorted run of slots (the list takes it over) into a bin's sorted list, in place. */
function mergeIntoList(
  lists: Map<number, number[]>,
  key: number,
  run: number[],
  order: (left: number, right: number) => number,
): void {
  const list = lists.get(key);
  if (!list) {
    lists.set(key, run);
    return;
  }
  // From the back, into room pushed on the end (pushing keeps the array packed).
  let i = list.length - 1;
  let j = run.length - 1;
  for (let n = 0; n < run.length; n += 1) list.push(0);
  let k = list.length - 1;
  while (j >= 0) list[k--] = i >= 0 && order(list[i]!, run[j]!) > 0 ? list[i--]! : run[j--]!;
}

/**
 * The index object for a composed index's latest version. It reads the
 * composed index's live slots and bins rather than copies (copying them was
 * most of a change's cost), so it is current only until the next change:
 * consumers take the world's index again (`infrastructureIndex`), and one
 * holding an older object reads the newer slots through it.
 */
function composedIndexObject(composed: ComposedIndex, version: number): InfrastructureIndex {
  let binMinX = Infinity;
  let binMinZ = Infinity;
  let binMaxX = -Infinity;
  let binMaxZ = -Infinity;
  for (const key of composed.bins.keys()) {
    const binX = infrastructureBinKeyX(key);
    const binZ = infrastructureBinKeyZ(key);
    binMinX = Math.min(binMinX, binX);
    binMinZ = Math.min(binMinZ, binZ);
    binMaxX = Math.max(binMaxX, binX);
    binMaxZ = Math.max(binMaxZ, binZ);
  }
  if (composed.bins.size === 0) {
    binMinX = 0;
    binMinZ = 0;
    binMaxX = -1;
    binMaxZ = -1;
  }
  const index: InfrastructureIndex = Object.freeze({
    segments: composed.segments,
    bins: composed.bins,
    anchors: composed.base.anchors,
    binMinX,
    binMinZ,
    binMaxX,
    binMaxZ,
    plantExclusions: composed.exclusions,
    plantBins: composed.plantBins,
  });
  snapshotOrigins.set(index, { composed, version });
  return index;
}

/** Whether an index holds streamed regions (and so changes in place: `infrastructureIndexChanges`). */
export function infrastructureIndexStreamed(index: InfrastructureIndex): boolean {
  return snapshotOrigins.has(index);
}

const NO_CHANGES: { readonly slots: Int32Array; readonly bins: Float64Array } = Object.freeze({
  slots: new Int32Array(0),
  bins: new Float64Array(0),
});

/**
 * What a consumer holding a copy of `previous` rewrites to hold `next`, two
 * index objects of one terrain made since its first region was installed:
 * the slots whose segment may differ and the keys of the bins whose lists
 * may differ, each once, in no particular order. Null when they are not such
 * a pair, or `next` is more changes on than the terrain remembers: the
 * consumer copies everything.
 */
export function infrastructureIndexChanges(
  previous: InfrastructureIndex,
  next: InfrastructureIndex,
): { readonly slots: Int32Array; readonly bins: Float64Array } | null {
  if (previous === next) return NO_CHANGES;
  const from = snapshotOrigins.get(previous);
  const to = snapshotOrigins.get(next);
  if (!from || !to || from.composed !== to.composed || from.version > to.version) return null;
  // The latest object only: an older one reads the newer slots (`composedIndexObject`).
  if (to.composed.index !== next) return null;
  const steps = to.composed.history.filter((change) => change.version > from.version);
  // Every version between, or the history has moved past `previous`.
  if (steps.length === 0 || steps[0]!.version !== from.version + 1 || steps.length !== to.version - from.version) {
    return null;
  }
  const slots = new Set<number>();
  const bins = new Set<number>();
  for (const step of steps) {
    for (let i = 0; i < step.slots.length; i += 1) slots.add(step.slots[i]!);
    for (let i = 0; i < step.bins.length; i += 1) bins.add(step.bins[i]!);
  }
  return { slots: Int32Array.from(slots), bins: Float64Array.from(bins) };
}

/**
 * Validate and bin a region's segments ahead of its install, so the install
 * (once a frame, `installInfrastructureRegions`) only merges: the roads
 * controller prepares each region as it arrives from the worker. Throws on a
 * malformed segment, as the install would; preparing twice is free.
 */
export function prepareInfrastructureRegion(region: InfrastructureRegion): void {
  installRegion(region);
}

/**
 * One change to a terrain's streamed regions, as `changeInfrastructureRegions`
 * made it: what the consumers that bake or copy the ground refresh.
 */
export interface InfrastructureChange {
  /** The terrain's version after it (`infrastructureRegionsVersion`). */
  readonly version: number;
  /** Each installed and each removed region's rectangle: everything the change can touch lies inside one. */
  readonly rects: readonly InfrastructureRect[];
  /** Keys of the bins whose ground or paint may differ (`infrastructureBinKey`). */
  readonly bins: ReadonlySet<number>;
  /** Keys of the bins whose plants may differ (a segment's plant band reaches them). */
  readonly plantBins: ReadonlySet<number>;
}

/**
 * Install streamed regions for the world's terrain and remove others, in one
 * change: the terrain's version bumps once if anything changed, and the index
 * every world on that terrain returns is the next one, composed in place
 * (only the bins the regions reach are re-merged). Installing a key already
 * installed, or removing one that is not, changes nothing.
 *
 * Returns the change (null when nothing changed): where the ground, paint or
 * plants may differ, for the consumers that bake the ground to refresh. A
 * malformed segment throws before anything changes.
 */
export function changeInfrastructureRegions(
  world: WorldDefinition,
  install: readonly InfrastructureRegion[],
  remove: readonly string[] = [],
): InfrastructureChange | null {
  if (world.worldEvolution === "eroded") return null;
  const terrain = infrastructureTerrainKey(world);
  const registry = registries.get(terrain) ?? { regions: new Map<string, InstalledRegion>(), version: 0, composed: null };
  const incoming: InstalledRegion[] = [];
  for (const region of install) {
    if (registry.regions.has(region.key) || incoming.some((other) => other.key === region.key)) continue;
    incoming.push(installRegion(region));
  }
  const outgoing: InstalledRegion[] = [];
  for (const key of new Set(remove)) {
    const region = registry.regions.get(key);
    if (region) outgoing.push(region);
  }
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const rects: InfrastructureRect[] = [];
  const bins = new Set<number>();
  const plantBins = new Set<number>();
  const footprint = (region: InstalledRegion) => {
    if (region.bounds) rects.push(region.bounds);
    for (const entry of region.ordered) {
      for (let b = 0; b < entry.bins.length; b += 1) bins.add(entry.bins[b]!);
      if (entry.plantBins) for (let b = 0; b < entry.plantBins.length; b += 1) plantBins.add(entry.plantBins[b]!);
    }
  };
  for (const region of outgoing) {
    registry.regions.delete(region.key);
    footprint(region);
  }
  for (const region of incoming) {
    registry.regions.set(region.key, region);
    footprint(region);
  }
  registries.set(terrain, registry);
  registry.version += 1;
  registryEpoch += 1;
  if (registry.regions.size === 0) {
    registry.composed = null;
  } else if (registry.composed) {
    updateComposed(registry.composed, outgoing, incoming, registry.version);
  } else {
    registry.composed = startComposed(staticInfrastructure(world));
    updateComposed(registry.composed, [], [...registry.regions.values()], registry.version);
  }
  return { version: registry.version, rects, bins, plantBins };
}

/**
 * `changeInfrastructureRegions`, returning only the rectangles that may have
 * changed (none when nothing did).
 */
export function installInfrastructureRegions(
  world: WorldDefinition,
  install: readonly InfrastructureRegion[],
  remove: readonly string[] = [],
): readonly InfrastructureRect[] {
  return changeInfrastructureRegions(world, install, remove)?.rects ?? [];
}

/**
 * Whether a change can have touched the world rectangle: one of its bins (or,
 * with `plants`, its plant bins) meets it. Walks whichever is fewer, the
 * rectangle's bins or the change's.
 */
export function infrastructureChangeTouches(
  change: InfrastructureChange,
  rect: InfrastructureRect,
  plants = false,
): boolean {
  const keys = plants ? change.plantBins : change.bins;
  if (keys.size === 0) return false;
  const x0 = infrastructureBin(rect.minX);
  const x1 = infrastructureBin(rect.maxX);
  const z0 = infrastructureBin(rect.minZ);
  const z1 = infrastructureBin(rect.maxZ);
  if ((x1 - x0 + 1) * (z1 - z0 + 1) <= keys.size) {
    for (let binX = x0; binX <= x1; binX += 1) {
      for (let binZ = z0; binZ <= z1; binZ += 1) if (keys.has(infrastructureBinKey(binX, binZ))) return true;
    }
    return false;
  }
  for (const key of keys) {
    const binX = infrastructureBinKeyX(key);
    const binZ = infrastructureBinKeyZ(key);
    if (binX >= x0 && binX <= x1 && binZ >= z0 && binZ <= z1) return true;
  }
  return false;
}

/** The keys of every region installed for the world's terrain, in install order. */
export function installedInfrastructureRegionKeys(world: WorldDefinition): readonly string[] {
  return [...(registries.get(infrastructureTerrainKey(world))?.regions.keys() ?? [])];
}

/** Every region installed for the world's terrain, as installed, in install order. */
export function installedInfrastructureRegions(world: WorldDefinition): readonly InfrastructureRegion[] {
  return [...(registries.get(infrastructureTerrainKey(world))?.regions.values() ?? [])].map((region) => region.source);
}

/** Bumped by every change to the world's terrain's regions (0 with none ever installed). */
export function infrastructureRegionsVersion(world: WorldDefinition): number {
  return registries.get(infrastructureTerrainKey(world))?.version ?? 0;
}

/** Drop every region of the world's terrain (a new session), or of every terrain with no world. */
export function clearInfrastructureRegions(world?: WorldDefinition): void {
  const cleared = world ? [registries.get(infrastructureTerrainKey(world))] : [...registries.values()];
  let changed = false;
  for (const registry of cleared) {
    if (!registry || registry.regions.size === 0) continue;
    registry.regions.clear();
    registry.composed = null;
    registry.version += 1;
    changed = true;
  }
  if (changed) registryEpoch += 1;
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
 * Every plant-free capsule a world's infrastructure asks for, in composition
 * order: segments that set `plantClearance` keep plants off halfWidth + reach
 * + plantClearance. Plain data, so it crosses to the detail worker as it is.
 */
export function infrastructurePlantExclusions(
  index: InfrastructureIndex,
): readonly InfrastructurePlantExclusion[] {
  const origin = snapshotOrigins.get(index);
  if (!origin) return index.plantExclusions;
  let compact = compactExclusions.get(index);
  if (!compact) {
    const slots: number[] = [];
    origin.composed.entries.forEach((entry, slot) => {
      if (entry?.exclusion) slots.push(slot);
    });
    sortSlots(slots, origin.composed.entries);
    compact = Object.freeze(slots.map((slot) => index.plantExclusions[slot]!));
    compactExclusions.set(index, compact);
  }
  return compact;
}

const compactExclusions = new WeakMap<InfrastructureIndex, readonly InfrastructurePlantExclusion[]>();

/** Slots into composition order, by the entries they hold. */
function sortSlots(slots: number[], entries: readonly (OrderedSegment | null)[]): void {
  slots.sort((left, right) => compareOrdered(entries[left]!, entries[right]!));
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
  const origin = snapshotOrigins.get(index);
  if (origin) sortSlots(found, origin.composed.entries);
  else found.sort((left, right) => left - right);
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
