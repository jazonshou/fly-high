import { LANDFORM_CORE } from "./landforms";
import { fbm2D, lerp, octaveBandWeight, saturate, smoothstep, valueNoise2D } from "./noise";
import { hashLatticeCoordinates, mixSeed, unitFloatFromHash } from "./seed";
// A value import of terrain.ts, which imports this module through
// landforms.ts: safe because the kernel is only called inside functions,
// after every module has evaluated.
import { sampleNaturalTerrainHeight } from "./terrain";
import type { WorldDefinition } from "./types";

/**
 * Volcanic land: a geology overlay on the terrain height, the landform stage
 * after the dunes and before the airport earthworks.
 *
 * Volcanism is geology, not climate, so it combines with any climate
 * province: tundra plus volcanic reads as Iceland, tropical as Hawaii, high
 * desert as Craters of the Moon.
 *
 * SITES. Every landform is a SITE with analytic shape parameters, placed from
 * the world seed on two jittered grids under a slow ACTIVITY field (a ~120 km
 * 2-octave lattice row, `VOLCANISM.activity`, tuned so about 10-15 % of the
 * world is volcanic):
 *
 * - 24 km EDIFICE cells hold at most one shield volcano, stratovolcano or
 *   caldera (a caldera can carry a small cone on its floor);
 * - 3 km VENT cells hold at most one cinder cone or maar. Vents in one 24 km
 *   cell favour a shared rift line, so cones line up along fissures.
 *
 * Each cell rolls once against the activity at its jittered centre. A site's
 * type, size, age, breach and lava flows all come from its cell's hash, plus a
 * handful of natural-kernel samples (the ground level at its centre, the
 * downhill direction its flows leave in), so every thread, worker and the GPU
 * index builder derive the same sites with no shared state.
 *
 * WHOLE OR ABSENT. A site exists only if its whole footprint (edifice, tephra
 * apron and flows) lies outside the landform core (`LANDFORM_CORE`, 120 km
 * round the start airport). Nothing is faded by a mask: a faded cone is a cone
 * cut in half. Outside every footprint the overlay returns the height it was
 * given, untouched, so the core stays the shipped arithmetic bit for bit.
 *
 * GUARANTEED FIELD. By chance alone the nearest volcanic land can be 300 km or
 * more from home, so every natural world also gets one field just past the
 * core, `VOLCANISM.guaranteed.distanceMeters` out on a seed-chosen bearing
 * (the landiest of four), with a stratovolcano at its centre.
 *
 * FORCED START. A world created with `landforms: { volcanic: true }` is
 * volcanic everywhere outside a clearance round the home runway and its
 * approaches, with a stratovolcano `VOLCANISM.forced.stratoDistanceMeters`
 * away: the screenshot and "start among volcanoes" world.
 *
 * SHAPES. Each site is a radial profile in its own local frame (avoiding
 * `pow`, whose WGSL precision is only a few ULP), plus site-seeded noise for
 * lumpy outlines and gullies. Calderas and maars SET the ground to a level
 * (flat floors that can hold a lake); cones, shields, stratovolcanoes and lava
 * flows ADD to whatever surface they stand on, so cones on a shield's flank
 * come for free. Level sites apply first, then the additive ones, in a fixed
 * order the GPU index repeats. Small features fade with the page's filter
 * width (rule 1B-2), so a coarse page stays a blurred copy of the fine one.
 *
 * Class K: pure arithmetic over numbers, transliterated to WGSL for the page,
 * pyramid, bathymetry and land-cover bakes, which read a recentred site index
 * built from these records.
 */

/** Site kinds. A frozen record rather than a const enum (`isolatedModules`). */
export const VolcanicSiteKind = Object.freeze({
  Cinder: 0,
  Maar: 1,
  Shield: 2,
  Strato: 3,
  Caldera: 4,
} as const);

export type VolcanicSiteKindId = (typeof VolcanicSiteKind)[keyof typeof VolcanicSiteKind];

/** One lava flow: a tongue that leaves a vent and runs downhill. */
export interface VolcanicFlow {
  /** Where the flow leaves its vent, world metres. */
  readonly startX: number;
  readonly startZ: number;
  /** Unit direction it runs in at the start. */
  readonly directionX: number;
  readonly directionZ: number;
  /** Signed curvature, radians per metre of length (positive turns left, towards +normal). */
  readonly bend: number;
  readonly lengthMeters: number;
  /** Width at the start; the tongue widens downstream. */
  readonly widthMeters: number;
  readonly thicknessMeters: number;
  /** 0 = fresh, 1 = old (weathered, soiled, vegetated). */
  readonly age: number;
  /** Rough clinker (aa) rather than smooth ropy (pahoehoe). */
  readonly aa: boolean;
  /** The flow's own noise seed (u32), for its lobed edges and surface. */
  readonly seed: number;
}

/** One volcanic landform. Every field is fixed by the world seed and position. */
export interface VolcanicSite {
  /** Unique and stable per world; the order level and additive sites apply in. */
  readonly id: number;
  readonly kind: VolcanicSiteKindId;
  /** Centre, world metres (f64 on the CPU; the GPU gets index-relative offsets). */
  readonly x: number;
  readonly z: number;
  /** Base radius of the edifice (cones, shields, stratovolcanoes) or the rim (calderas, maars). */
  readonly radiusMeters: number;
  /**
   * Relief above the surrounding ground at the summit (cones, shields,
   * stratovolcanoes) or the rim (calderas: the rim's rise; maars: the tephra
   * ring's).
   */
  readonly heightMeters: number;
  /** Summit crater or pit radius; a caldera's or maar's floor radius. */
  readonly craterRadiusMeters: number;
  /** Crater depth below the summit; a caldera's floor below its rim; a maar's floor below the ground. */
  readonly craterDepthMeters: number;
  /** 0 = fresh, 1 = old. */
  readonly age: number;
  /** Unit direction of a breached crater wall, or (0, 0) for an intact rim. */
  readonly breachX: number;
  readonly breachZ: number;
  /** Natural ground height at the centre, for floors and lakes set to a level. */
  readonly baseLevelMeters: number;
  /** Everything the site touches (edifice, tephra apron, flows) lies within this. */
  readonly footprintRadiusMeters: number;
  /** The site's own noise seed (u32). */
  readonly seed: number;
  readonly flows: readonly VolcanicFlow[];
  /**
   * The level a crater or caldera lake stands at, world metres, or NaN for
   * none. Hydrology authors these lakes; the river tracer never makes them.
   */
  readonly lakeLevelMeters: number;
}

/** Ground inputs the land-cover classifier reads. All exactly 0 outside every footprint. */
export interface VolcanicGroundSample {
  /** Share of the ground that is lava rock (flows, shield and strato flanks), [0, 1]. */
  lavaCover: number;
  /** Share that is tephra (cinder, scoria, ash, black sand), [0, 1]. */
  tephraCover: number;
  /** Age of the dominant cover: 0 = fresh, 1 = old. */
  age: number;
}

/** A steaming vent for the steam effect. */
export interface VolcanicVent {
  readonly x: number;
  readonly z: number;
  /** Radius over which the steam rises (crater floor, fumarole patch), metres. */
  readonly radiusMeters: number;
  /** 0 (none) to 1 (vigorous). Old sites do not steam. */
  readonly strength: number;
  /** The site's seed, for a stable per-vent look. */
  readonly seed: number;
}

export const VOLCANISM = Object.freeze({
  /**
   * The activity lattice row. Its 85th and 95th percentiles (five seeds,
   * 200k samples) are 0.37 and 0.56, so the smoothstep below is 0 on 85 % of
   * the world and 1 on the top 5 %.
   */
  activity: Object.freeze({
    channel: 240,
    octaves: 2,
    baseWavelengthMeters: 120_000,
    lacunarity: 2,
    persistence: 0.5,
    low: 0.37,
    high: 0.55,
  }),
  /** Rift lines: one per edifice cell, shared by the vents inside it. */
  rift: Object.freeze({ channel: 241, widthMeters: 5_000, floor: 0.3 }),
  edifice: Object.freeze({
    channel: 242,
    cellMeters: 24_000,
    /** Chance at full activity that an edifice cell holds an edifice. */
    probability: 0.45,
    /** No edifice footprint is larger: it bounds every neighbourhood search. */
    maxFootprintMeters: 23_000,
  }),
  vent: Object.freeze({
    channel: 243,
    cellMeters: 3_000,
    /** Chance at full activity, on the rift line, that a vent cell holds a vent. */
    probability: 0.34,
    maxFootprintMeters: 10_000,
  }),
  guaranteed: Object.freeze({
    channel: 244,
    distanceMeters: 152_000,
    distanceSpanMeters: 16_000,
    /** Activity is 1 within the full radius of the field centre, fading to its own by the outer. */
    fullRadiusMeters: 25_000,
    outerRadiusMeters: 40_000,
    /** Edifice cells this close to the field's stratovolcano stay empty. */
    edificeExclusionMeters: 30_000,
  }),
  forced: Object.freeze({
    channel: 245,
    /** The forced stratovolcano's distance from the start airport. */
    stratoDistanceMeters: 30_000,
    /** Activity everywhere in a forced world is at least this. */
    activityFloor: 0.8,
    /** No site footprint comes nearer the runway centre. */
    airportClearanceMeters: 6_000,
    /** Nor nearer than `approachClearanceMeters` to the runway line extended this far each way. */
    approachLengthMeters: 12_000,
    approachClearanceMeters: 2_000,
  }),
  /** The CPU site lookup's bin, metres; the GPU index uses the same. */
  binMeters: 4_000,
});

/** Sites that SET the ground to a level apply before the ones that add to it. */
function isLevelKind(kind: VolcanicSiteKindId): boolean {
  return kind === VolcanicSiteKind.Caldera || kind === VolcanicSiteKind.Maar;
}

interface SiteRecord extends VolcanicSite {
  /** Noise seeds derived from `seed`, so a profile never mixes in its loop. */
  readonly noiseSeedA: number;
  readonly noiseSeedB: number;
  /** Last query stamp that collected this site (dedup across bins, no Set). */
  stamp: number;
}

interface VolcanicState {
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly coreX: number;
  readonly coreZ: number;
  /** Squared radius inside which no site's footprint reaches (natural worlds). */
  readonly coreRadiusSquared: number;
  /** The guaranteed field's centre, NaN for none (forced worlds, no field). */
  readonly fieldX: number;
  readonly fieldZ: number;
  readonly specials: readonly SiteRecord[];
  readonly edificeCells: Map<number, readonly SiteRecord[]>;
  readonly ventCells: Map<number, readonly SiteRecord[]>;
  readonly bins: Map<number, readonly SiteRecord[]>;
  stamp: number;
}

const NO_SITES: readonly SiteRecord[] = Object.freeze([]);
const NO_FLOWS: readonly VolcanicFlow[] = Object.freeze([]);
/** Caches are dropped whole past these sizes; everything regenerates bit-identically. */
const MAX_CACHED_CELLS = 65_536;
const MAX_CACHED_BINS = 16_384;
const KEY_OFFSET = 32_768;
const KEY_SPAN = 65_536;

const STATES = new WeakMap<WorldDefinition, VolcanicState>();

function cellKey(i: number, j: number): number {
  return (i + KEY_OFFSET) * KEY_SPAN + (j + KEY_OFFSET);
}

/** The k-th independent unit float of a cell or site hash. */
function roll(hash: number, k: number): number {
  return unitFloatFromHash(mixSeed(hash, k));
}

function isForced(world: WorldDefinition): boolean {
  return world.landforms?.volcanic === true;
}

function stateFor(world: WorldDefinition): VolcanicState {
  const cached = STATES.get(world);
  if (cached) return cached;
  const forced = isForced(world);
  const coreX = world.airport ? world.airport.centerX : 0;
  const coreZ = world.airport ? world.airport.centerZ : 0;
  const coreRadius = forced ? 0 : LANDFORM_CORE.innerRadiusMeters;
  let fieldX = Number.NaN;
  let fieldZ = Number.NaN;
  if (!forced && world.worldEvolution !== "eroded") {
    const g = VOLCANISM.guaranteed;
    const hash = mixSeed(world.seedHash, g.channel);
    const distance = g.distanceMeters + g.distanceSpanMeters * roll(hash, 0);
    const bearing0 = roll(hash, 1) * Math.PI * 2;
    // The landiest of four bearings, so the field is usually land (an island
    // arc when all four are sea).
    let best = -Infinity;
    for (let k = 0; k < 4; k += 1) {
      const bearing = bearing0 + k * Math.PI * 0.5;
      const x = coreX + Math.sin(bearing) * distance;
      const z = coreZ + Math.cos(bearing) * distance;
      const height = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
      if (height > best) {
        best = height;
        fieldX = x;
        fieldZ = z;
      }
    }
  }
  const state: VolcanicState = {
    enabled: world.worldEvolution !== "eroded",
    forced,
    coreX,
    coreZ,
    coreRadiusSquared: coreRadius * coreRadius,
    fieldX,
    fieldZ,
    specials: NO_SITES,
    edificeCells: new Map(),
    ventCells: new Map(),
    bins: new Map(),
    stamp: 0,
  };
  STATES.set(world, state);
  // The special stratovolcano needs the state (its exclusion tests) to exist.
  (state as { specials: readonly SiteRecord[] }).specials = buildSpecialSites(world, state);
  return state;
}

/** The activity lattice alone, [0, 1], before the core, field and forcing. */
function latticeActivity(seedHash: number, x: number, z: number): number {
  const a = VOLCANISM.activity;
  const field = fbm2D(
    mixSeed(seedHash, a.channel),
    x / a.baseWavelengthMeters,
    z / a.baseWavelengthMeters,
    a.octaves,
    a.lacunarity,
    a.persistence,
  );
  return smoothstep(a.low, a.high, field);
}

function activityAt(world: WorldDefinition, state: VolcanicState, x: number, z: number): number {
  if (!state.enabled) return 0;
  let activity = latticeActivity(world.seedHash, x, z);
  if (state.forced) return Math.max(activity, VOLCANISM.forced.activityFloor);
  if (state.fieldX === state.fieldX) {
    const g = VOLCANISM.guaranteed;
    const field = 1 - smoothstep(
      g.fullRadiusMeters,
      g.outerRadiusMeters,
      Math.hypot(x - state.fieldX, z - state.fieldZ),
    );
    if (field > activity) activity = field;
  }
  const core = smoothstep(
    LANDFORM_CORE.innerRadiusMeters,
    LANDFORM_CORE.innerRadiusMeters + LANDFORM_CORE.rampMeters,
    Math.hypot(x - state.coreX, z - state.coreZ),
  );
  return activity * core;
}

/**
 * Volcanic activity at a point, [0, 1]: how likely a vent or edifice is here.
 * Exactly 0 inside the landform core of a natural world and in eroded worlds.
 * Sand seas are multiplied by `1 - activity`, so the two never stack.
 */
export function volcanicActivity(
  world: WorldDefinition,
  x: number,
  z: number,
): number {
  return activityAt(world, stateFor(world), x, z);
}

/** What the GPU's activity twin needs about a world, beyond its seed. */
export interface VolcanicActivityFrame {
  /** 0: no volcanism (eroded), 1: natural, 2: forced outside the runway clearance. */
  readonly mode: 0 | 1 | 2;
  /** The landform core centre: the start airport, or the origin without one. */
  readonly coreX: number;
  readonly coreZ: number;
  /** The guaranteed field's centre, NaN for none. */
  readonly fieldX: number;
  readonly fieldZ: number;
}

export function volcanicActivityFrame(world: WorldDefinition): VolcanicActivityFrame {
  const state = stateFor(world);
  return {
    mode: !state.enabled ? 0 : state.forced ? 2 : 1,
    coreX: state.coreX,
    coreZ: state.coreZ,
    fieldX: state.fieldX,
    fieldZ: state.fieldZ,
  };
}

/** Does a footprint keep clear of the core (natural) or the runway clearance (forced)? */
function footprintAllowed(
  world: WorldDefinition,
  state: VolcanicState,
  x: number,
  z: number,
  footprint: number,
): boolean {
  const toCore = Math.hypot(x - state.coreX, z - state.coreZ);
  if (!state.forced) return toCore - footprint >= LANDFORM_CORE.innerRadiusMeters;
  const f = VOLCANISM.forced;
  if (toCore - footprint < f.airportClearanceMeters) return false;
  const airport = world.airport;
  if (!airport) return true;
  // Distance from the site centre to the runway line extended both ways.
  const dirX = Math.sin(airport.headingRadians);
  const dirZ = Math.cos(airport.headingRadians);
  const relX = x - airport.centerX;
  const relZ = z - airport.centerZ;
  const halfLength = airport.runwayLength * 0.5 + f.approachLengthMeters;
  const along = Math.max(-halfLength, Math.min(halfLength, relX * dirX + relZ * dirZ));
  const toLine = Math.hypot(relX - along * dirX, relZ - along * dirZ);
  return toLine - footprint >= f.approachClearanceMeters;
}

/** Unit downhill direction of the natural ground, or (0, 0) on the flat. */
function downhill(seedHash: number, x: number, z: number, probe: number, out: Float64Array): void {
  const gx = sampleNaturalTerrainHeight(seedHash, x + probe, z, 0)
    - sampleNaturalTerrainHeight(seedHash, x - probe, z, 0);
  const gz = sampleNaturalTerrainHeight(seedHash, x, z + probe, 0)
    - sampleNaturalTerrainHeight(seedHash, x, z - probe, 0);
  const length = Math.hypot(gx, gz);
  if (length < 1e-6) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  out[0] = -gx / length;
  out[1] = -gz / length;
}

const DIRECTION_SCRATCH = new Float64Array(2);

/**
 * One lava flow from (startX, startZ). It leaves along `preferred` pulled
 * towards the natural ground's downhill by `follow`, and bends towards the
 * downhill direction it finds halfway along. It is shortened, keeping its
 * turn, until it reaches no further than `maxReachMeters` from the site.
 */
function makeFlow(
  world: WorldDefinition,
  hash: number,
  siteX: number,
  siteZ: number,
  maxReachMeters: number,
  startX: number,
  startZ: number,
  preferredX: number,
  preferredZ: number,
  follow: number,
  lengthMeters: number,
  widthMeters: number,
  thicknessMeters: number,
  age: number,
  aa: boolean,
): VolcanicFlow {
  downhill(world.seedHash, startX, startZ, 150, DIRECTION_SCRATCH);
  let dirX = lerp(preferredX, DIRECTION_SCRATCH[0]!, follow);
  let dirZ = lerp(preferredZ, DIRECTION_SCRATCH[1]!, follow);
  let length = Math.hypot(dirX, dirZ);
  if (length < 1e-6) {
    dirX = preferredX;
    dirZ = preferredZ;
    length = Math.hypot(dirX, dirZ);
  }
  dirX /= length;
  dirZ /= length;
  const midX = startX + dirX * lengthMeters * 0.5;
  const midZ = startZ + dirZ * lengthMeters * 0.5;
  downhill(world.seedHash, midX, midZ, 250, DIRECTION_SCRATCH);
  // Signed angle from the start direction to the mid-flow downhill, spread
  // over the flow (half of it reached at the midpoint), plus a seeded wander.
  const cross = dirX * DIRECTION_SCRATCH[1]! - dirZ * DIRECTION_SCRATCH[0]!;
  const dot = dirX * DIRECTION_SCRATCH[0]! + dirZ * DIRECTION_SCRATCH[1]!;
  const turn = DIRECTION_SCRATCH[0] === 0 && DIRECTION_SCRATCH[1] === 0
    ? 0
    : Math.atan2(cross, dot);
  const wander = (roll(hash, 0) - 0.5) * 0.6;
  const totalTurn = Math.max(-1.2, Math.min(1.2, turn * 0.8 + wander));
  const startOffset = Math.hypot(startX - siteX, startZ - siteZ);
  let flowLength = lengthMeters;
  while (startOffset + flowReachFromStart(flowLength, totalTurn, widthMeters) > maxReachMeters
    && flowLength > 200) {
    flowLength *= 0.95;
  }
  return Object.freeze({
    startX,
    startZ,
    directionX: dirX,
    directionZ: dirZ,
    // Curvature is in the frame where +normal is (-dirZ, dirX): the
    // direction a positive `cross` turns towards.
    bend: totalTurn / flowLength,
    lengthMeters: flowLength,
    widthMeters,
    thicknessMeters,
    age,
    aa,
    seed: mixSeed(hash, 7),
  });
}

/**
 * How far a flow's cover can reach from its start. Along: its length plus a
 * width (the cut-off of `flowCover`). Across: the centreline's offset at the
 * end (k L^2 / 2 = turn L / 2) plus the widest half-tongue (1.5 start widths,
 * lobes included) stretched by the frame's 1/sqrt(1 + (k a)^2) (at most
 * 1.56 for a 1.2 radian turn).
 */
function flowReachFromStart(lengthMeters: number, turn: number, widthMeters: number): number {
  return Math.hypot(lengthMeters + widthMeters, Math.abs(turn) * lengthMeters * 0.5 + widthMeters * 2.4);
}

/** How far a flow can reach from a site centre. */
export function volcanicFlowReach(siteX: number, siteZ: number, flow: VolcanicFlow): number {
  return Math.hypot(flow.startX - siteX, flow.startZ - siteZ)
    + flowReachFromStart(flow.lengthMeters, flow.bend * flow.lengthMeters, flow.widthMeters);
}

function flowReach(siteX: number, siteZ: number, flow: VolcanicFlow): number {
  return volcanicFlowReach(siteX, siteZ, flow);
}

interface SiteFields {
  id: number;
  kind: VolcanicSiteKindId;
  x: number;
  z: number;
  radiusMeters: number;
  heightMeters: number;
  craterRadiusMeters: number;
  craterDepthMeters: number;
  age: number;
  breachX: number;
  breachZ: number;
  baseLevelMeters: number;
  footprintRadiusMeters: number;
  seed: number;
  flows: readonly VolcanicFlow[];
  lakeLevelMeters: number;
}

function freezeSite(fields: SiteFields): SiteRecord {
  return Object.seal({
    ...fields,
    flows: fields.flows.length > 0 ? Object.freeze(fields.flows.slice()) : NO_FLOWS,
    noiseSeedA: mixSeed(fields.seed, 1),
    noiseSeedB: mixSeed(fields.seed, 2),
    stamp: 0,
  });
}

/**
 * Footprints in site radii. Each covers the profile's reach at the largest
 * outline (`outline` swings a radius by up to its amplitude): the cinder
 * cone's downwind tephra apron, the maar's ring (1.8 x 1.08), the caldera's
 * outer flank (2.4 x 1.06).
 */
const CINDER_APRON_RADII = 2.6;
const MAAR_RING_RADII = 1.8;
const MAAR_FOOTPRINT_RADII = 1.95;
const CALDERA_FLANK_RADII = 2.4;
const CALDERA_FOOTPRINT_RADII = 2.55;

function cinderCone(
  world: WorldDefinition,
  hash: number,
  id: number,
  x: number,
  z: number,
  activity: number,
  baseLevelOverride: number,
): SiteFields {
  const radius = lerp(200, 800, roll(hash, 10) * roll(hash, 11) * 0.5 + roll(hash, 10) * 0.5);
  const age = roll(hash, 12);
  // Wood (1980): height/base ratio 0.18 young to 0.06 old; crater 0.4 of the base.
  const height = lerp(0.36, 0.12, age) * radius;
  const baseLevel = baseLevelOverride === baseLevelOverride
    ? baseLevelOverride
    : sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
  downhill(world.seedHash, x, z, Math.max(150, radius), DIRECTION_SCRATCH);
  let downX = DIRECTION_SCRATCH[0]!;
  let downZ = DIRECTION_SCRATCH[1]!;
  if (downX === 0 && downZ === 0) {
    const angle = roll(hash, 13) * Math.PI * 2;
    downX = Math.sin(angle);
    downZ = Math.cos(angle);
  }
  let breachX = 0;
  let breachZ = 0;
  const flows: VolcanicFlow[] = [];
  const breached = roll(hash, 14) < 0.55;
  if (breached) {
    const skew = (roll(hash, 15) - 0.5) * 0.8;
    const c = Math.cos(skew);
    const s = Math.sin(skew);
    breachX = downX * c - downZ * s;
    breachZ = downX * s + downZ * c;
  }
  const flowCount = breached
    ? 1 + (roll(hash, 16) < 0.35 + 0.3 * activity ? 1 : 0)
    : roll(hash, 16) < 0.3 ? 1 : 0;
  for (let k = 0; k < flowCount; k += 1) {
    const flowHash = mixSeed(hash, 40 + k);
    let preferredX = breached ? breachX : downX;
    let preferredZ = breached ? breachZ : downZ;
    if (k > 0) {
      const spread = (roll(flowHash, 1) - 0.5) * 1.6;
      const c = Math.cos(spread);
      const s = Math.sin(spread);
      const px = preferredX * c - preferredZ * s;
      preferredZ = preferredX * s + preferredZ * c;
      preferredX = px;
    }
    const startX = x + preferredX * radius * 0.9;
    const startZ = z + preferredZ * radius * 0.9;
    const aa = roll(flowHash, 2) < 0.5;
    flows.push(makeFlow(
      world,
      flowHash,
      x,
      z,
      VOLCANISM.vent.maxFootprintMeters - 50,
      startX,
      startZ,
      preferredX,
      preferredZ,
      0.6,
      lerp(2_000, 7_500, roll(flowHash, 3)),
      lerp(180, 600, roll(flowHash, 4)),
      aa ? lerp(4, 11, roll(flowHash, 5)) : lerp(1, 4, roll(flowHash, 5)),
      Math.min(1, age + roll(flowHash, 6) * 0.1),
      aa,
    ));
  }
  let footprint = radius * CINDER_APRON_RADII;
  for (const flow of flows) footprint = Math.max(footprint, flowReach(x, z, flow));
  return {
    id,
    kind: VolcanicSiteKind.Cinder,
    x,
    z,
    radiusMeters: radius,
    heightMeters: height,
    craterRadiusMeters: radius * 0.4,
    craterDepthMeters: height * lerp(0.45, 0.25, age),
    age,
    breachX,
    breachZ,
    baseLevelMeters: baseLevel,
    footprintRadiusMeters: footprint,
    seed: mixSeed(hash, 3),
    flows,
    lakeLevelMeters: Number.NaN,
  };
}

function maar(world: WorldDefinition, hash: number, id: number, x: number, z: number): SiteFields {
  const radius = lerp(150, 750, roll(hash, 10));
  const depth = lerp(30, 150, roll(hash, 11));
  const baseLevel = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
  const holdsLake = roll(hash, 12) < 0.75;
  return {
    id,
    kind: VolcanicSiteKind.Maar,
    x,
    z,
    radiusMeters: radius,
    heightMeters: lerp(8, 30, roll(hash, 13)),
    craterRadiusMeters: radius,
    craterDepthMeters: depth,
    age: roll(hash, 14),
    breachX: 0,
    breachZ: 0,
    baseLevelMeters: baseLevel,
    footprintRadiusMeters: radius * MAAR_FOOTPRINT_RADII,
    seed: mixSeed(hash, 3),
    flows: NO_FLOWS,
    lakeLevelMeters: holdsLake ? baseLevel - depth * lerp(0.35, 0.6, roll(hash, 15)) : Number.NaN,
  };
}

/** Flank flows of a shield or stratovolcano: radial, starting partway down. */
function flankFlows(
  world: WorldDefinition,
  hash: number,
  x: number,
  z: number,
  radius: number,
  count: number,
  startFraction: number,
  age: number,
  aaShare: number,
  thicknessLow: number,
  thicknessHigh: number,
): VolcanicFlow[] {
  const flows: VolcanicFlow[] = [];
  const angle0 = roll(hash, 30) * Math.PI * 2;
  for (let k = 0; k < count; k += 1) {
    const flowHash = mixSeed(hash, 50 + k);
    const angle = angle0 + (k + roll(flowHash, 1) * 0.6) * (Math.PI * 2 / count);
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    const startRadius = radius * lerp(startFraction, startFraction + 0.2, roll(flowHash, 2));
    const startX = x + dirX * startRadius;
    const startZ = z + dirZ * startRadius;
    const aa = roll(flowHash, 3) < aaShare;
    flows.push(makeFlow(
      world,
      flowHash,
      x,
      z,
      VOLCANISM.edifice.maxFootprintMeters - 50,
      startX,
      startZ,
      dirX,
      dirZ,
      0.25,
      lerp(4_000, 13_000, roll(flowHash, 4)),
      lerp(300, 1_200, roll(flowHash, 5)),
      lerp(thicknessLow, thicknessHigh, roll(flowHash, 6)),
      Math.min(1, age * lerp(0.4, 1, roll(flowHash, 7))),
      aa,
    ));
  }
  return flows;
}

function shield(world: WorldDefinition, hash: number, id: number, x: number, z: number): SiteFields {
  const radius = lerp(5_000, 12_000, roll(hash, 10));
  const height = Math.min(1_000, radius * lerp(0.06, 0.09, roll(hash, 11)));
  const age = lerp(0.1, 0.9, roll(hash, 12));
  const flows = flankFlows(
    world, hash, x, z, radius, 2 + (roll(hash, 13) < 0.5 ? 1 : 0), 0.1, age, 0.3, 1, 5);
  let footprint = radius * 1.12;
  for (const flow of flows) footprint = Math.max(footprint, flowReach(x, z, flow));
  return {
    id,
    kind: VolcanicSiteKind.Shield,
    x,
    z,
    radiusMeters: radius,
    heightMeters: height,
    craterRadiusMeters: radius * 0.035,
    craterDepthMeters: height * 0.08,
    age,
    breachX: 0,
    breachZ: 0,
    baseLevelMeters: sampleNaturalTerrainHeight(world.seedHash, x, z, 0),
    footprintRadiusMeters: Math.min(VOLCANISM.edifice.maxFootprintMeters, footprint),
    seed: mixSeed(hash, 3),
    flows,
    lakeLevelMeters: Number.NaN,
  };
}

function strato(
  world: WorldDefinition,
  hash: number,
  id: number,
  x: number,
  z: number,
  radiusLow: number,
  radiusHigh: number,
): SiteFields {
  const radius = lerp(radiusLow, radiusHigh, roll(hash, 10));
  const height = Math.max(1_400, Math.min(2_500, radius * lerp(0.16, 0.2, roll(hash, 11))));
  const age = lerp(0, 0.6, roll(hash, 12));
  const flows = flankFlows(
    world, hash, x, z, radius, 1 + Math.floor(roll(hash, 13) * 3), 0.15, age, 0.8, 5, 12);
  let footprint = radius * 1.1;
  for (const flow of flows) footprint = Math.max(footprint, flowReach(x, z, flow));
  return {
    id,
    kind: VolcanicSiteKind.Strato,
    x,
    z,
    radiusMeters: radius,
    heightMeters: height,
    craterRadiusMeters: radius * 0.035,
    craterDepthMeters: Math.min(250, height * 0.07),
    age,
    breachX: 0,
    breachZ: 0,
    baseLevelMeters: sampleNaturalTerrainHeight(world.seedHash, x, z, 0),
    footprintRadiusMeters: Math.min(VOLCANISM.edifice.maxFootprintMeters, footprint),
    seed: mixSeed(hash, 3),
    flows,
    lakeLevelMeters: Number.NaN,
  };
}

function caldera(world: WorldDefinition, hash: number, id: number, x: number, z: number): SiteFields {
  const radius = lerp(2_000, 5_000, roll(hash, 10));
  const depth = Math.max(300, Math.min(800, radius * lerp(0.12, 0.18, roll(hash, 11))));
  const rimRise = depth * lerp(0.25, 0.45, roll(hash, 12));
  const baseLevel = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
  const floorLevel = baseLevel + rimRise - depth;
  const holdsLake = roll(hash, 13) < 0.6;
  return {
    id,
    kind: VolcanicSiteKind.Caldera,
    x,
    z,
    radiusMeters: radius,
    heightMeters: rimRise,
    craterRadiusMeters: radius * 0.8,
    craterDepthMeters: depth,
    age: lerp(0.4, 1, roll(hash, 14)),
    breachX: 0,
    breachZ: 0,
    baseLevelMeters: baseLevel,
    footprintRadiusMeters: radius * CALDERA_FOOTPRINT_RADII,
    seed: mixSeed(hash, 3),
    flows: NO_FLOWS,
    // At most 70 % of the way up the wall, so it never spills over a rim
    // the natural ground has lowered.
    lakeLevelMeters: holdsLake ? floorLevel + depth * lerp(0.15, 0.45, roll(hash, 15)) : Number.NaN,
  };
}

/** Grid identities in a site id: which grid and which slot of its cell. */
const GRID_EDIFICE = 0;
const GRID_VENT = 1;
const GRID_SPECIAL = 2;

function siteId(grid: number, key: number, slot: number): number {
  return (key * 4 + slot) * 4 + grid;
}

function edificeSites(world: WorldDefinition, state: VolcanicState, i: number, j: number): readonly SiteRecord[] {
  const key = cellKey(i, j);
  const cached = state.edificeCells.get(key);
  if (cached) return cached;
  if (state.edificeCells.size >= MAX_CACHED_CELLS) state.edificeCells.clear();
  const sites = buildEdificeSites(world, state, i, j, key);
  state.edificeCells.set(key, sites);
  return sites;
}

function buildEdificeSites(
  world: WorldDefinition,
  state: VolcanicState,
  i: number,
  j: number,
  key: number,
): readonly SiteRecord[] {
  const e = VOLCANISM.edifice;
  const hash = hashLatticeCoordinates(mixSeed(world.seedHash, e.channel), i, j);
  const x = (i + 0.1 + 0.8 * roll(hash, 0)) * e.cellMeters;
  const z = (j + 0.1 + 0.8 * roll(hash, 1)) * e.cellMeters;
  const activity = activityAt(world, state, x, z);
  if (activity <= 0 || roll(hash, 2) >= activity * e.probability) return NO_SITES;
  if (state.fieldX === state.fieldX
    && Math.hypot(x - state.fieldX, z - state.fieldZ) < VOLCANISM.guaranteed.edificeExclusionMeters) {
    return NO_SITES;
  }
  if (state.forced && state.specials.length > 0) {
    const special = state.specials[0]!;
    if (Math.hypot(x - special.x, z - special.z) < VOLCANISM.guaranteed.edificeExclusionMeters) {
      return NO_SITES;
    }
  }
  const kindRoll = roll(hash, 3);
  let fields: SiteFields;
  if (activity >= 0.75 && kindRoll < 0.25) {
    fields = strato(world, hash, siteId(GRID_EDIFICE, key, 0), x, z, 7_500, 14_000);
  } else if (kindRoll < 0.45) {
    fields = caldera(world, hash, siteId(GRID_EDIFICE, key, 0), x, z);
  } else {
    fields = shield(world, hash, siteId(GRID_EDIFICE, key, 0), x, z);
  }
  if (!footprintAllowed(world, state, fields.x, fields.z, fields.footprintRadiusMeters)) return NO_SITES;
  const sites = [freezeSite(fields)];
  // A small cone on some caldera floors (Wizard Island).
  if (fields.kind === VolcanicSiteKind.Caldera && roll(hash, 4) < 0.45) {
    const coneHash = mixSeed(hash, 60);
    const angle = roll(coneHash, 0) * Math.PI * 2;
    const offset = fields.craterRadiusMeters * lerp(0.1, 0.5, roll(coneHash, 1));
    const cone = cinderCone(
      world,
      coneHash,
      siteId(GRID_EDIFICE, key, 1),
      x + Math.sin(angle) * offset,
      z + Math.cos(angle) * offset,
      0,
      fields.baseLevelMeters + fields.heightMeters - fields.craterDepthMeters,
    );
    // Its flows would climb the caldera wall; it keeps none.
    cone.flows = NO_FLOWS;
    cone.footprintRadiusMeters = cone.radiusMeters * CINDER_APRON_RADII;
    sites.push(freezeSite(cone));
  }
  return Object.freeze(sites);
}

function ventSites(world: WorldDefinition, state: VolcanicState, i: number, j: number): readonly SiteRecord[] {
  const key = cellKey(i, j);
  const cached = state.ventCells.get(key);
  if (cached) return cached;
  if (state.ventCells.size >= MAX_CACHED_CELLS) state.ventCells.clear();
  const sites = buildVentSites(world, state, i, j, key);
  state.ventCells.set(key, sites);
  return sites;
}

function buildVentSites(
  world: WorldDefinition,
  state: VolcanicState,
  i: number,
  j: number,
  key: number,
): readonly SiteRecord[] {
  const v = VOLCANISM.vent;
  const hash = hashLatticeCoordinates(mixSeed(world.seedHash, v.channel), i, j);
  const x = (i + 0.15 + 0.7 * roll(hash, 0)) * v.cellMeters;
  const z = (j + 0.15 + 0.7 * roll(hash, 1)) * v.cellMeters;
  const activity = activityAt(world, state, x, z);
  if (activity <= 0) return NO_SITES;
  // The rift line of the edifice cell this vent lies in.
  const r = VOLCANISM.rift;
  const ei = Math.floor(x / VOLCANISM.edifice.cellMeters);
  const ej = Math.floor(z / VOLCANISM.edifice.cellMeters);
  const riftHash = hashLatticeCoordinates(mixSeed(world.seedHash, r.channel), ei, ej);
  const riftX = (ei + 0.2 + 0.6 * roll(riftHash, 0)) * VOLCANISM.edifice.cellMeters;
  const riftZ = (ej + 0.2 + 0.6 * roll(riftHash, 1)) * VOLCANISM.edifice.cellMeters;
  const riftAngle = roll(riftHash, 2) * Math.PI;
  const across = Math.abs((x - riftX) * Math.cos(riftAngle) - (z - riftZ) * Math.sin(riftAngle));
  const offLine = across / r.widthMeters;
  const riftWeight = r.floor + (1 - r.floor) * Math.exp(-offLine * offLine);
  if (roll(hash, 2) >= activity * riftWeight * v.probability) return NO_SITES;
  const id = siteId(GRID_VENT, key, 0);
  const fields = roll(hash, 3) < 0.15
    ? maar(world, hash, id, x, z)
    : cinderCone(world, hash, id, x, z, activity, Number.NaN);
  if (!footprintAllowed(world, state, fields.x, fields.z, fields.footprintRadiusMeters)) return NO_SITES;
  return Object.freeze([freezeSite(fields)]);
}

function buildSpecialSites(world: WorldDefinition, state: VolcanicState): readonly SiteRecord[] {
  if (!state.enabled) return NO_SITES;
  if (state.fieldX === state.fieldX) {
    const hash = mixSeed(world.seedHash, VOLCANISM.guaranteed.channel + 1);
    const fields = strato(world, hash, siteId(GRID_SPECIAL, 0, 0), state.fieldX, state.fieldZ, 9_000, 12_000);
    return footprintAllowed(world, state, fields.x, fields.z, fields.footprintRadiusMeters)
      ? Object.freeze([freezeSite(fields)])
      : NO_SITES;
  }
  if (state.forced) {
    const f = VOLCANISM.forced;
    const hash = mixSeed(world.seedHash, f.channel);
    // Off the runway axis by at least 45 degrees, so it never sits under an approach.
    const heading = world.airport ? world.airport.headingRadians : 0;
    const bearing = heading + Math.PI * (0.25 + 0.5 * roll(hash, 0)) + (roll(hash, 1) < 0.5 ? 0 : Math.PI);
    const x = state.coreX + Math.sin(bearing) * f.stratoDistanceMeters;
    const z = state.coreZ + Math.cos(bearing) * f.stratoDistanceMeters;
    const fields = strato(world, hash, siteId(GRID_SPECIAL, 0, 0), x, z, 8_000, 9_500);
    // Its flows can reach towards the airport; trim them to the clearance.
    fields.flows = fields.flows.filter((flow) =>
      footprintAllowed(world, state, x, z, flowReach(x, z, flow)));
    fields.footprintRadiusMeters = fields.radiusMeters * 1.1;
    for (const flow of fields.flows) {
      fields.footprintRadiusMeters = Math.max(fields.footprintRadiusMeters, flowReach(x, z, flow));
    }
    return footprintAllowed(world, state, x, z, fields.footprintRadiusMeters)
      ? Object.freeze([freezeSite(fields)])
      : NO_SITES;
  }
  return NO_SITES;
}

function compareSites(a: SiteRecord, b: SiteRecord): number {
  const levelA = isLevelKind(a.kind) ? 0 : 1;
  const levelB = isLevelKind(b.kind) ? 0 : 1;
  return levelA !== levelB ? levelA - levelB : a.id - b.id;
}

function footprintTouchesBox(
  site: SiteRecord,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  const dx = site.x < minX ? minX - site.x : site.x > maxX ? site.x - maxX : 0;
  const dz = site.z < minZ ? minZ - site.z : site.z > maxZ ? site.z - maxZ : 0;
  return dx * dx + dz * dz < site.footprintRadiusMeters * site.footprintRadiusMeters;
}

const COLLECT_SCRATCH: SiteRecord[] = [];

/** Every site whose footprint touches the box, sorted level-first then by id. */
function collectSites(
  world: WorldDefinition,
  state: VolcanicState,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: SiteRecord[],
): void {
  out.length = 0;
  state.stamp += 1;
  const stamp = state.stamp;
  const push = (sites: readonly SiteRecord[]): void => {
    for (const site of sites) {
      if (site.stamp === stamp) continue;
      if (!footprintTouchesBox(site, minX, minZ, maxX, maxZ)) continue;
      site.stamp = stamp;
      out.push(site);
    }
  };
  push(state.specials);
  const e = VOLCANISM.edifice;
  const ei0 = Math.floor((minX - e.maxFootprintMeters) / e.cellMeters);
  const ei1 = Math.floor((maxX + e.maxFootprintMeters) / e.cellMeters);
  const ej0 = Math.floor((minZ - e.maxFootprintMeters) / e.cellMeters);
  const ej1 = Math.floor((maxZ + e.maxFootprintMeters) / e.cellMeters);
  for (let i = ei0; i <= ei1; i += 1) {
    for (let j = ej0; j <= ej1; j += 1) push(edificeSites(world, state, i, j));
  }
  const v = VOLCANISM.vent;
  const vi0 = Math.floor((minX - v.maxFootprintMeters) / v.cellMeters);
  const vi1 = Math.floor((maxX + v.maxFootprintMeters) / v.cellMeters);
  const vj0 = Math.floor((minZ - v.maxFootprintMeters) / v.cellMeters);
  const vj1 = Math.floor((maxZ + v.maxFootprintMeters) / v.cellMeters);
  for (let i = vi0; i <= vi1; i += 1) {
    for (let j = vj0; j <= vj1; j += 1) push(ventSites(world, state, i, j));
  }
  out.sort(compareSites);
}

/** The sorted sites whose footprints touch one lookup bin (cached). */
function binSites(world: WorldDefinition, state: VolcanicState, x: number, z: number): readonly SiteRecord[] {
  const size = VOLCANISM.binMeters;
  const bi = Math.floor(x / size);
  const bj = Math.floor(z / size);
  const key = cellKey(bi, bj);
  const cached = state.bins.get(key);
  if (cached) return cached;
  if (state.bins.size >= MAX_CACHED_BINS) state.bins.clear();
  const minX = bi * size;
  const minZ = bj * size;
  let sites = NO_SITES;
  // A bin wholly inside a natural world's core holds nothing: skip the cells.
  const farX = Math.max(Math.abs(minX - state.coreX), Math.abs(minX + size - state.coreX));
  const farZ = Math.max(Math.abs(minZ - state.coreZ), Math.abs(minZ + size - state.coreZ));
  if (state.enabled && (state.forced || farX * farX + farZ * farZ >= state.coreRadiusSquared)) {
    collectSites(world, state, minX, minZ, minX + size, minZ + size, COLLECT_SCRATCH);
    if (COLLECT_SCRATCH.length > 0) sites = Object.freeze(COLLECT_SCRATCH.slice());
    COLLECT_SCRATCH.length = 0;
  }
  state.bins.set(key, sites);
  return sites;
}

/**
 * The sorted sites whose footprints touch lookup bin (bi, bj), the bin
 * `[bi, bi + 1) x [bj, bj + 1)` times `VOLCANISM.binMeters`: the list, in the
 * order, the GPU site index repeats so both sides sum in one order. Cached;
 * the first visit of a bin builds it.
 */
export function volcanicBinSites(world: WorldDefinition, bi: number, bj: number): readonly VolcanicSite[] {
  const state = stateFor(world);
  if (!state.enabled) return NO_SITES;
  const size = VOLCANISM.binMeters;
  return binSites(world, state, (bi + 0.5) * size, (bj + 0.5) * size);
}

/** Has bin (bi, bj) been built (cached) for this world? Lets a builder pace itself. */
export function volcanicBinCached(world: WorldDefinition, bi: number, bj: number): boolean {
  return stateFor(world).bins.has(cellKey(bi, bj));
}

/**
 * The sorted sites that can touch a point, or null when none can (the core,
 * eroded worlds, empty bins). Allocates only on a bin's first visit.
 */
function sitesNear(world: WorldDefinition, x: number, z: number): readonly SiteRecord[] | null {
  const state = stateFor(world);
  if (!state.enabled) return null;
  if (!state.forced) {
    const dx = x - state.coreX;
    const dz = z - state.coreZ;
    if (dx * dx + dz * dz < state.coreRadiusSquared) return null;
  }
  const sites = binSites(world, state, x, z);
  return sites.length > 0 ? sites : null;
}

/**
 * Every site whose footprint overlaps the box, sorted level-first then by
 * id. Deterministic and cached per world; the returned array is the
 * caller's `out` (cleared first) when given.
 */
export function volcanicSitesInBounds(
  world: WorldDefinition,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: VolcanicSite[] = [],
): VolcanicSite[] {
  out.length = 0;
  const state = stateFor(world);
  if (!state.enabled) return out;
  collectSites(world, state, minX, minZ, maxX, maxZ, out as SiteRecord[]);
  return out;
}

/** Steaming vents inside the box (centres inside it). */
export function volcanicVentsInBounds(
  world: WorldDefinition,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: VolcanicVent[] = [],
): VolcanicVent[] {
  out.length = 0;
  const state = stateFor(world);
  if (!state.enabled) return out;
  collectSites(world, state, minX, minZ, maxX, maxZ, COLLECT_SCRATCH);
  for (const site of COLLECT_SCRATCH) {
    if (site.x < minX || site.x >= maxX || site.z < minZ || site.z >= maxZ) continue;
    const vent = ventOf(site);
    if (vent) out.push(vent);
  }
  COLLECT_SCRATCH.length = 0;
  return out;
}

const VENTS = new WeakMap<SiteRecord, VolcanicVent | null>();

/** A young site's steam: crater floors, a strato's summit, a caldera's fumaroles. */
function ventOf(site: SiteRecord): VolcanicVent | null {
  const cached = VENTS.get(site);
  if (cached !== undefined) return cached;
  const steams = unitFloatFromHash(mixSeed(site.seed, 20));
  let strength = 0;
  let radius = site.craterRadiusMeters;
  switch (site.kind) {
    case VolcanicSiteKind.Cinder:
      strength = steams < 0.35 ? saturate((0.5 - site.age) * 2) * 0.7 : 0;
      break;
    case VolcanicSiteKind.Strato:
      strength = saturate(1 - site.age * 1.2) * 0.9;
      break;
    case VolcanicSiteKind.Shield:
      strength = steams < 0.5 ? saturate((0.6 - site.age) * 1.7) * 0.5 : 0;
      break;
    case VolcanicSiteKind.Caldera:
      strength = steams < 0.5 && site.age < 0.7 ? 0.45 : 0;
      radius = site.craterRadiusMeters * 0.25;
      break;
    default:
      strength = 0;
  }
  const vent = strength > 0
    ? Object.freeze({ x: site.x, z: site.z, radiusMeters: radius, strength, seed: site.seed })
    : null;
  VENTS.set(site, vent);
  return vent;
}

// ---------------------------------------------------------------------------
// Profiles. Each takes the point relative to the site (dx, dz, f64 on the CPU)
// and the running height, and returns the new running height.

/** C1 ramp 0..1 with a rounded toe over `k`: t^2/2k below k, then linear. */
function toeRamp(t: number, k: number): number {
  const ramp = t < k ? (t * t) / (2 * k) : t - k * 0.5;
  return ramp / (1 - k * 0.5);
}

/** Band weight of a feature `wavelengthMeters` across (rule 1B-2). 1 at width 0. */
function band(wavelengthMeters: number, filterWidthMeters: number): number {
  return filterWidthMeters > 0 ? octaveBandWeight(wavelengthMeters, filterWidthMeters) : 1;
}

/** Outline lumpiness: noise on the unit direction, ~3 lobes round a site. */
function outline(seed: number, ux: number, uz: number): number {
  return valueNoise2D(seed, ux * 1.6 + 7.3, uz * 1.6 - 2.1);
}

function cinderDelta(site: SiteRecord, r: number, ux: number, uz: number): number {
  const radius = site.radiusMeters * (1 + 0.1 * outline(site.noiseSeedA, ux, uz));
  if (r >= radius) return 0;
  const height = site.heightMeters;
  const crater = site.craterRadiusMeters;
  let delta: number;
  if (r < crater) {
    const q = r / crater;
    delta = height - site.craterDepthMeters * (1 - q * q);
  } else {
    delta = height * toeRamp((radius - r) / (radius - crater), 0.18);
  }
  if (site.breachX !== 0 || site.breachZ !== 0) {
    const facing = smoothstep(0.8, 0.95, ux * site.breachX + uz * site.breachZ);
    if (facing > 0) {
      const channel = (height - site.craterDepthMeters) * saturate(1 - r / radius);
      delta = lerp(delta, Math.min(delta, channel), facing);
    }
  }
  return delta;
}

function shieldDelta(
  site: SiteRecord,
  r: number,
  ux: number,
  uz: number,
  filterWidthMeters: number,
): number {
  const radius = site.radiusMeters * (1 + 0.12 * outline(site.noiseSeedA, ux, uz));
  if (r >= radius) return 0;
  const q = toeRamp(1 - r / radius, 0.25);
  let delta = site.heightMeters * q * (2 - q);
  const pit = site.craterRadiusMeters;
  if (r < pit) {
    const p = r / pit;
    delta -= site.craterDepthMeters * (1 - p * p) * band(pit * 2, filterWidthMeters);
  }
  return delta;
}

function stratoDelta(
  site: SiteRecord,
  r: number,
  ux: number,
  uz: number,
  filterWidthMeters: number,
): number {
  const radius = site.radiusMeters * (1 + 0.08 * outline(site.noiseSeedA, ux, uz));
  if (r >= radius) return 0;
  const height = site.heightMeters;
  const crater = site.craterRadiusMeters;
  const shape = (q: number): number => height * q * q * (0.5 + 0.5 * q);
  let delta: number;
  if (r < crater) {
    const p = r / crater;
    delta = shape(1 - crater / radius)
      - site.craterDepthMeters * (1 - p * p) * band(crater * 2, filterWidthMeters);
  } else {
    delta = shape(1 - r / radius);
  }
  // Radial gullies: V-shaped channels where an angular noise crosses zero,
  // deepest mid-flank. Their spacing is about r/6.
  const q = 1 - r / radius;
  const gullyWeight = band(r * 0.33, filterWidthMeters);
  if (gullyWeight > 0 && r > crater) {
    const n = valueNoise2D(site.noiseSeedB, ux * 6 + r * 0.00025, uz * 6);
    const t = 1 - Math.abs(n);
    const t2 = t * t;
    delta -= height * 0.035 * 4 * q * (1 - q) * t2 * t2 * gullyWeight;
  }
  return delta;
}

/** A caldera SETS its floor to a level: lerp(h + rim, floor, floorWeight). */
function calderaHeight(site: SiteRecord, height: number, r: number, ux: number, uz: number): number {
  const radius = site.radiusMeters * (1 + 0.06 * outline(site.noiseSeedA, ux, uz));
  const s = r / radius;
  if (s >= CALDERA_FLANK_RADII) return height;
  const rise = site.heightMeters;
  let rim: number;
  if (s <= 1) {
    rim = rise;
  } else {
    const u = (s - 1) / (CALDERA_FLANK_RADII - 1);
    rim = rise * (1 - u) * (1 - u);
  }
  const floorLevel = site.baseLevelMeters + rise - site.craterDepthMeters;
  const floorWeight = 1 - smoothstep(0.8, 1, s);
  return lerp(height + rim, floorLevel, floorWeight);
}

/** A maar SETS its bowl below the ground and raises a low tephra ring round it. */
function maarHeight(site: SiteRecord, height: number, r: number, ux: number, uz: number): number {
  const radius = site.radiusMeters * (1 + 0.08 * outline(site.noiseSeedA, ux, uz));
  const s = r / radius;
  if (s >= MAAR_RING_RADII) return height;
  const depth = site.craterDepthMeters;
  const ring = site.heightMeters * smoothstep(0.75, 1, s) * (1 - smoothstep(1, MAAR_RING_RADII, s));
  const bowlWeight = 1 - smoothstep(0.7, 1, s);
  if (bowlWeight <= 0) return height + ring;
  const bowl = site.baseLevelMeters - depth + depth * s * s;
  return lerp(height + ring, bowl, bowlWeight);
}

/**
 * A lava flow's local frame at a point: distance along it and signed
 * distance across it. Writes into `out` [along, across].
 *
 * The centreline is the parabola b = k a^2 / 2 in the flow's start frame (a
 * along the start direction, b along its normal (-dirZ, dirX)): the
 * small-turn form of an arc of curvature k, with no inverse trigonometry and
 * no far-away centre of curvature, so the GPU's f32 keeps millimetres of it.
 * `along` is a; `across` is the offset from the centreline divided by the
 * centreline's local stretch, sqrt(1 + (k a)^2), so the tongue keeps its
 * width round the bend.
 */
function flowFrame(flow: VolcanicFlow, x: number, z: number, out: Float64Array): void {
  const px = x - flow.startX;
  const pz = z - flow.startZ;
  const a = px * flow.directionX + pz * flow.directionZ;
  const b = -px * flow.directionZ + pz * flow.directionX;
  const ka = flow.bend * a;
  out[0] = a;
  out[1] = (b - 0.5 * ka * a) / Math.sqrt(1 + ka * ka);
}

const FLOW_FRAME = new Float64Array(2);

/** A flow's cover (0..1) at its local frame; also its edge noise. */
function flowCover(flow: VolcanicFlow, along: number, across: number, filterWidthMeters: number): number {
  if (along < -flow.widthMeters || along > flow.lengthMeters + flow.widthMeters) return 0;
  const t = saturate(along / flow.lengthMeters);
  const width = flow.widthMeters * (1 + 1.2 * t);
  const lobes = valueNoise2D(flow.seed, along / 180, 0.37) * 0.18 * width;
  const half = width * 0.5 + lobes;
  const edge = Math.max(half * 0.12, 25, filterWidthMeters);
  const side = smoothstep(half, half - edge, Math.abs(across));
  if (side <= 0) return 0;
  const frontLength = flow.lengthMeters + valueNoise2D(flow.seed, across / 150, 5.1) * 0.15 * width;
  const front = smoothstep(frontLength, frontLength - edge, along);
  const start = smoothstep(-edge, edge, along);
  return side * front * start;
}

function flowDelta(flow: VolcanicFlow, x: number, z: number, filterWidthMeters: number): number {
  flowFrame(flow, x, z, FLOW_FRAME);
  const along = FLOW_FRAME[0]!;
  const across = FLOW_FRAME[1]!;
  const cover = flowCover(flow, along, across, filterWidthMeters);
  if (cover <= 0) return 0;
  // Pressure ridges / clinker hummocks, a few per cent of the thickness.
  const relief = valueNoise2D(flow.seed, along / 45, across / 45) * 0.12 * band(90, filterWidthMeters);
  return flow.thicknessMeters * cover * (1 + relief) * band(flow.widthMeters, filterWidthMeters);
}

const UNIT_SCRATCH = new Float64Array(3);

/** r and the unit direction from a site to a point (an arbitrary unit at the centre). */
function polar(dx: number, dz: number, out: Float64Array): void {
  const r = Math.hypot(dx, dz);
  out[0] = r;
  out[1] = r > 1e-6 ? dx / r : 1;
  out[2] = r > 1e-6 ? dz / r : 0;
}

function applySite(
  site: SiteRecord,
  x: number,
  z: number,
  height: number,
  filterWidthMeters: number,
): number {
  const dx = x - site.x;
  const dz = z - site.z;
  polar(dx, dz, UNIT_SCRATCH);
  const r = UNIT_SCRATCH[0]!;
  const ux = UNIT_SCRATCH[1]!;
  const uz = UNIT_SCRATCH[2]!;
  let result = height;
  switch (site.kind) {
    case VolcanicSiteKind.Caldera:
      result = lerp(height, calderaHeight(site, height, r, ux, uz), band(site.radiusMeters * 2, filterWidthMeters));
      break;
    case VolcanicSiteKind.Maar:
      result = lerp(height, maarHeight(site, height, r, ux, uz), band(site.radiusMeters * 2, filterWidthMeters));
      break;
    case VolcanicSiteKind.Cinder: {
      const weight = band(site.radiusMeters * 2, filterWidthMeters);
      if (weight > 0 && r < site.radiusMeters * 1.2) {
        result = height + cinderDelta(site, r, ux, uz) * weight;
      }
      break;
    }
    case VolcanicSiteKind.Shield:
      if (r < site.radiusMeters * 1.2) result = height + shieldDelta(site, r, ux, uz, filterWidthMeters);
      break;
    case VolcanicSiteKind.Strato:
      if (r < site.radiusMeters * 1.1) result = height + stratoDelta(site, r, ux, uz, filterWidthMeters);
      break;
    default:
      break;
  }
  for (const flow of site.flows) {
    const delta = flowDelta(flow, x, z, filterWidthMeters);
    if (delta !== 0) result += delta;
  }
  return result;
}

/**
 * The height after the volcanic overlay. Returns `height` itself, untouched,
 * wherever no site's footprint covers the point.
 */
export function applyVolcanicOverlay(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  filterWidthMeters: number,
): number {
  const sites = sitesNear(world, x, z);
  if (sites === null) return height;
  let result = height;
  for (const site of sites) {
    const dx = x - site.x;
    const dz = z - site.z;
    const footprint = site.footprintRadiusMeters;
    if (dx * dx + dz * dz >= footprint * footprint) continue;
    result = applySite(site, x, z, result, filterWidthMeters);
  }
  return result;
}

export function createVolcanicGroundSample(): VolcanicGroundSample {
  return { lavaCover: 0, tephraCover: 0, age: 0 };
}

/** Lava, tephra and age at a point, for the classifier. Zeroes outside footprints. */
export function sampleVolcanicGround(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  target: VolcanicGroundSample = createVolcanicGroundSample(),
): VolcanicGroundSample {
  target.lavaCover = 0;
  target.tephraCover = 0;
  target.age = 0;
  const sites = sitesNear(world, x, z);
  if (sites === null) return target;
  let strongest = 0;
  const windX = Math.sin(world.prevailingWindRadians);
  const windZ = Math.cos(world.prevailingWindRadians);
  for (const site of sites) {
    const dx = x - site.x;
    const dz = z - site.z;
    const footprint = site.footprintRadiusMeters;
    if (dx * dx + dz * dz >= footprint * footprint) continue;
    polar(dx, dz, UNIT_SCRATCH);
    const r = UNIT_SCRATCH[0]!;
    const ux = UNIT_SCRATCH[1]!;
    const uz = UNIT_SCRATCH[2]!;
    const radius = site.radiusMeters;
    let lava = 0;
    let tephra = 0;
    let age = site.age;
    switch (site.kind) {
      case VolcanicSiteKind.Cinder: {
        // The apron stretches downwind: scoria and ash fell with the wind.
        const downwind = Math.max(0, ux * windX + uz * windZ);
        const apron = radius * (1.5 + (CINDER_APRON_RADII - 1.5) * downwind);
        tephra = 1 - smoothstep(radius * 0.9, apron, r);
        break;
      }
      case VolcanicSiteKind.Maar: {
        const s = r / radius;
        tephra = smoothstep(0.6, 0.85, s) * (1 - smoothstep(1.3, MAAR_RING_RADII, s));
        break;
      }
      case VolcanicSiteKind.Shield:
        lava = 1 - smoothstep(0.85, 1.05, r / radius);
        break;
      case VolcanicSiteKind.Strato: {
        const s = r / radius;
        tephra = 1 - smoothstep(0.25, 0.45, s);
        lava = 0.7 * smoothstep(0.2, 0.35, s) * (1 - smoothstep(0.7, 1.05, s));
        // Lower flanks are older: soil, then forest, comes back from the toe up.
        age = Math.min(1, site.age + 0.7 * s);
        break;
      }
      case VolcanicSiteKind.Caldera: {
        const s = r / radius;
        tephra = 0.6 * (1 - smoothstep(0.8, 1, s));
        lava = s > 1 ? 0.4 * (1 - smoothstep(1, CALDERA_FLANK_RADII, s)) : 0;
        break;
      }
      default:
        break;
    }
    let flowAge = age;
    let flowLava = 0;
    for (const flow of site.flows) {
      flowFrame(flow, x, z, FLOW_FRAME);
      const cover = flowCover(flow, FLOW_FRAME[0]!, FLOW_FRAME[1]!, filterWidthMeters);
      if (cover > flowLava) {
        flowLava = cover;
        flowAge = flow.age;
      }
    }
    if (flowLava > lava) {
      lava = flowLava;
      if (flowLava > tephra) age = flowAge;
    }
    if (lava > target.lavaCover) target.lavaCover = lava;
    if (tephra > target.tephraCover) target.tephraCover = tephra;
    const cover = lava > tephra ? lava : tephra;
    if (cover > strongest) {
      strongest = cover;
      target.age = age;
    }
  }
  return target;
}
