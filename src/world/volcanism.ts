import type { WorldDefinition } from "./types";

/**
 * Volcanic land: a geology overlay on the terrain height, applied after the
 * natural kernel and before the airport earthworks.
 *
 * INTERFACE STUB. The types and signatures below are the contract the
 * materials, steam and hydrology work build against; the implementation lands
 * in the same file. Until then every query answers "no volcano here", which is
 * also exactly what it answers everywhere inside the landform core.
 *
 * Volcanism is geology, not climate, so it combines with any climate
 * province: tundra plus volcanic reads as Iceland, tropical as Hawaii, high
 * desert as Craters of the Moon.
 *
 * Class K: pure arithmetic over numbers, transliterated to WGSL for the page,
 * pyramid, bathymetry and land-cover bakes.
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
  /** Signed curvature, radians per metre of length. */
  readonly bend: number;
  readonly lengthMeters: number;
  /** Width at the start; the tongue widens downstream. */
  readonly widthMeters: number;
  readonly thicknessMeters: number;
  /** 0 = fresh, 1 = old (weathered, soiled, vegetated). */
  readonly age: number;
  /** Rough clinker (aa) rather than smooth ropy (pahoehoe). */
  readonly aa: boolean;
}

/** One volcanic landform. Every field is fixed by the world seed and position. */
export interface VolcanicSite {
  readonly kind: VolcanicSiteKindId;
  /** Centre, world metres (f64 on the CPU; the GPU gets index-relative offsets). */
  readonly x: number;
  readonly z: number;
  /** Base radius of the edifice (cones, shields, stratovolcanoes) or the rim (calderas, maars). */
  readonly radiusMeters: number;
  /** Relief above the surrounding ground at the summit or rim. */
  readonly heightMeters: number;
  readonly craterRadiusMeters: number;
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

export function createVolcanicGroundSample(): VolcanicGroundSample {
  return { lavaCover: 0, tephraCover: 0, age: 0 };
}

/**
 * Volcanic activity at a point, [0, 1]: how likely a vent or edifice is here.
 * Exactly 0 inside the landform core of a natural world.
 */
export function volcanicActivity(
  _world: Pick<WorldDefinition, "seedHash" | "airport">,
  _x: number,
  _z: number,
): number {
  return 0;
}

/**
 * Every site whose footprint overlaps the box. Deterministic and cached per
 * world; the returned array is the caller's `out` (cleared first) when given.
 */
export function volcanicSitesInBounds(
  _world: WorldDefinition,
  _minX: number,
  _minZ: number,
  _maxX: number,
  _maxZ: number,
  out: VolcanicSite[] = [],
): VolcanicSite[] {
  out.length = 0;
  return out;
}

/** Steaming vents inside the box (centres inside it). */
export function volcanicVentsInBounds(
  _world: WorldDefinition,
  _minX: number,
  _minZ: number,
  _maxX: number,
  _maxZ: number,
  out: VolcanicVent[] = [],
): VolcanicVent[] {
  out.length = 0;
  return out;
}

/**
 * The height after the volcanic overlay. Returns `height` itself, untouched,
 * wherever no site's footprint covers the point.
 */
export function applyVolcanicOverlay(
  _world: WorldDefinition,
  _x: number,
  _z: number,
  height: number,
  _filterWidthMeters: number,
): number {
  return height;
}

/** Lava, tephra and age at a point, for the classifier. Zeroes outside footprints. */
export function sampleVolcanicGround(
  _world: WorldDefinition,
  _x: number,
  _z: number,
  _filterWidthMeters: number,
  target: VolcanicGroundSample = createVolcanicGroundSample(),
): VolcanicGroundSample {
  target.lavaCover = 0;
  target.tephraCover = 0;
  target.age = 0;
  return target;
}
