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
 * The index is built lazily, once per world object, on the first sample that
 * needs it, and costs one bin lookup per sample after that. The GPU twin
 * (`TerrainInfrastructureKernel.ts`) packs the same index and runs the same
 * profiles; the two agree within a millimetre.
 */

/** Edge of an index bin, metres. */
export const INFRASTRUCTURE_BIN_METERS = 512;

/** Most parameters one segment carries (two vec4s on the GPU). */
export const INFRASTRUCTURE_MAX_PARAMS = 8;

/** How a segment's target composes into the height. */
export type InfrastructureMode = "set" | "cut" | "fill";

/** The splat material a segment paints, named here; the renderer maps it. */
export type InfrastructureSurface = "concrete" | "asphalt" | "gravel";

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
});

const indexes = new WeakMap<WorldDefinition, InfrastructureIndex>();
let lastWorld: WorldDefinition | null = null;
let lastIndex: InfrastructureIndex = EMPTY_INDEX;
let building: WorldDefinition | null = null;

/**
 * The world's infrastructure index, built on first use. Sources that call
 * back into the staged height while it is built throw rather than recurse.
 */
export function infrastructureIndex(
  world: WorldDefinition,
  sources: readonly InfrastructureSource[] = INFRASTRUCTURE_SOURCES,
): InfrastructureIndex {
  if (sources === INFRASTRUCTURE_SOURCES) {
    if (sources.length === 0 || world.worldEvolution === "eroded") return EMPTY_INDEX;
    if (world === lastWorld) return lastIndex;
    let index = indexes.get(world);
    if (!index) {
      index = buildIndexGuarded(world, sources);
      indexes.set(world, index);
    }
    lastWorld = world;
    lastIndex = index;
    return index;
  }
  // An explicit source list (tests, tools): built fresh, never cached.
  if (world.worldEvolution === "eroded") return EMPTY_INDEX;
  return buildIndexGuarded(world, sources);
}

function buildIndexGuarded(world: WorldDefinition, sources: readonly InfrastructureSource[]): InfrastructureIndex {
  if (building !== null) {
    throw new Error(
      "An infrastructure source read the staged terrain height; sources read sampleTerrainHeightBeforeEarthworks",
    );
  }
  building = world;
  try {
    return buildInfrastructureIndex(world, sources);
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

/** Build an index from explicit sources; `infrastructureIndex` caches the world's own. */
export function buildInfrastructureIndex(
  world: WorldDefinition,
  sources: readonly InfrastructureSource[],
): InfrastructureIndex {
  const ordered: { segment: InfrastructureSegment; order: number }[] = [];
  const anchors = new Map<string, InfrastructureAnchor>();
  for (const source of sources) {
    const layout = source(world);
    for (const segment of layout.segments) {
      validateSegment(segment);
      ordered.push({ segment, order: ordered.length });
    }
    for (const anchor of layout.anchors ?? []) {
      if (anchors.has(anchor.name)) throw new Error(`Duplicate infrastructure anchor "${anchor.name}"`);
      if (![anchor.x, anchor.z, anchor.headingRadians].every(Number.isFinite)) {
        throw new RangeError(`Infrastructure anchor "${anchor.name}" must be finite`);
      }
      anchors.set(anchor.name, Object.freeze({ ...anchor }));
    }
  }
  if (ordered.length === 0) return anchors.size === 0 ? EMPTY_INDEX : { ...EMPTY_INDEX, anchors };
  ordered.sort((left, right) => left.segment.priority - right.segment.priority || left.order - right.order);

  const segments = ordered.map(({ segment }): PackedInfrastructureSegment => {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const length = Math.hypot(dx, dz);
    return Object.freeze({
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
  });

  const lists = new Map<number, number[]>();
  let binMinX = Infinity;
  let binMinZ = Infinity;
  let binMaxX = -Infinity;
  let binMaxZ = -Infinity;
  segments.forEach((packed, index) => {
    const { segment, radius } = packed;
    const x0 = infrastructureBin(Math.min(segment.ax, segment.bx) - radius);
    const x1 = infrastructureBin(Math.max(segment.ax, segment.bx) + radius);
    const z0 = infrastructureBin(Math.min(segment.az, segment.bz) - radius);
    const z1 = infrastructureBin(Math.max(segment.az, segment.bz) + radius);
    for (let binX = x0; binX <= x1; binX += 1) {
      for (let binZ = z0; binZ <= z1; binZ += 1) {
        // Only bins the capsule actually reaches: a long diagonal road should
        // not list itself in every bin of its bounding box.
        if (!capsuleReachesBin(packed, binX, binZ)) continue;
        const key = infrastructureBinKey(binX, binZ);
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        list.push(index);
        binMinX = Math.min(binMinX, binX);
        binMinZ = Math.min(binMinZ, binZ);
        binMaxX = Math.max(binMaxX, binX);
        binMaxZ = Math.max(binMaxZ, binZ);
      }
    }
  });
  const bins = new Map<number, Int32Array>();
  for (const [key, list] of lists) bins.set(key, Int32Array.from(list));
  return Object.freeze({ segments: Object.freeze(segments), bins, anchors, binMinX, binMinZ, binMaxX, binMaxZ });
}

/** Does the segment's capsule of influence touch a bin's square? */
function capsuleReachesBin(packed: PackedInfrastructureSegment, binX: number, binZ: number): boolean {
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
    <= packed.radius + half * Math.SQRT2 + BIN_EDGE_MARGIN_METERS;
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
  const list = index.bins.get(infrastructureBinKey(infrastructureBin(x), infrastructureBin(z)));
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

/** A published anchor (`"marinaCarPark"`), or null when no source placed it. */
export function infrastructureAnchor(world: WorldDefinition, name: string): InfrastructureAnchor | null {
  return infrastructureIndex(world).anchors.get(name) ?? null;
}

/**
 * Whether any segment's capsule of influence comes within `clearance` metres
 * of (x, z). Spawned airports ask it, so no airport grades over a quay.
 */
export function infrastructureNear(
  world: WorldDefinition,
  x: number,
  z: number,
  clearance: number,
  index: InfrastructureIndex = infrastructureIndex(world),
): boolean {
  for (const packed of index.segments) {
    const { along, across } = infrastructureSegmentLocal(packed, x, z, LOCAL);
    if (infrastructureCapsuleDistance(along, across, packed.length) < packed.radius + clearance) return true;
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
  const list = index.bins.get(infrastructureBinKey(infrastructureBin(x), infrastructureBin(z)));
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
  const exclusions: InfrastructurePlantExclusion[] = [];
  for (const { segment } of index.segments) {
    if (segment.plantClearance === undefined) continue;
    exclusions.push({
      ax: segment.ax,
      az: segment.az,
      bx: segment.bx,
      bz: segment.bz,
      radius: segment.halfWidth + segment.reach + segment.plantClearance,
    });
  }
  return exclusions;
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
