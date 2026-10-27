import { densityField, sandCoverGroundFactor, sandCoverTreeFactor } from "@/src/render/webgpu/detail/densityField";
import {
  alignSeasonalLandCoverWeights,
  classifyLandCover,
  landCoverWetness,
  type LandCoverInput,
} from "@/src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial, type SurfaceMaterialId } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { seasonBakeDayOfYear, seasonBucketBlend, seasonBucketCenterDay } from "@/src/render/webgpu/terrain/TerrainSpineContract";
import { isPointOnRunway, worldAirportAt } from "@/src/world/airport";
import {
  infrastructureIndex,
  infrastructureRegionsVersion,
  sampleInfrastructureSurface,
  type InfrastructureSurface,
  type InfrastructureSurfaceSample,
} from "@/src/world/infrastructure";
import { sampleTerrainSurface, seasonalTemperatureShift, TERRAIN_REFERENCE_DAY_OF_YEAR } from "@/src/world/terrain";
import { TerrainBiome, type TerrainSample, type WorldDefinition } from "@/src/world/types";
import { createGroundPoint, type GroundField, type GroundPoint } from "./terrainPatch";

/**
 * What a tyre rolls on (land plan, "Soft soil" and "What the car reads from
 * the world"): the material the ground is painted with, and what that means
 * to a tyre. Hard ground (asphalt, concrete, gravel, rock, lava) scales the
 * tyre's reference curves by a friction and adds rolling resistance and an
 * ISO 8608 roughness. Soft ground (sand, loam, mud, snow, tephra) carries the
 * tyre on a soil: Bekker's pressure-sinkage law and the Janosi-Hanamoto shear
 * law with Wong's parameters (Theory of Ground Vehicles, 4th ed., table 2.3),
 * worked by `soil.ts`.
 *
 * The material is the one the splat bake paints, from the same authorities:
 * the runway rectangle, the infrastructure stage's painted segments (roads,
 * tracks, slipways) and, everywhere else, the land-cover classifier on the
 * world's own surface sample, with the canopy closure and grass cover the
 * bake hands it (`densityField`, thinned on sand as the bake thins it): the
 * sward is what tells a desert's dry grass from its open sand. The bake's
 * erosion flow and soil depth have no CPU twin and its four taps are one
 * point here; the materials that differ by them map to the same soil, and a
 * parity test bounds the rest. The calendar is the renderer's: the bake's
 * two season buckets for the day, cross-faded as the fragment fades them
 * (`paintedSeason`), so winter's snow is under the tyres where it is drawn.
 * Snow is soft where it is deep and packed hard where it is thin
 * (`snowDepthOf`, `describeSnow`).
 */

/** A soil's terramechanics, SI units: Bekker's n, k_c (N/m^(n+1)) and k_phi (N/m^(n+2)), cohesion, friction angle, and Janosi-Hanamoto's shear modulus K. */
export interface Soil {
  readonly n: number;
  readonly kc: number;
  readonly kPhi: number;
  readonly cohesion: number;
  readonly frictionAngle: number;
  readonly shearModulus: number;
  /** The soft layer's depth over firm ground: sinkage stops there, metres. */
  readonly maxSinkage: number;
}

const DEG = Math.PI / 180;

/**
 * Wong's table 2.3 (dry sand, sandy loam, clayey soil, snow), from the plan.
 * K is not in the table: about 1 to 4 cm, from Wong's measured shear curves,
 * and the bogging tests check it. Tephra is a coarse sand: dry sand's
 * pressure-sinkage with a cinder's steeper friction angle and no cohesion.
 * The depths are estimates: a dune's sand is deep, a meadow's loam is not.
 */
export const SOILS = Object.freeze({
  drySand: Object.freeze({ n: 1.1, kc: 990, kPhi: 1_528_430, cohesion: 1_040, frictionAngle: 28 * DEG, shearModulus: 0.025, maxSinkage: 0.35 }),
  sandyLoam: Object.freeze({ n: 0.7, kc: 5_270, kPhi: 1_515_040, cohesion: 1_720, frictionAngle: 29 * DEG, shearModulus: 0.025, maxSinkage: 0.15 }),
  clayeySoil: Object.freeze({ n: 0.5, kc: 13_190, kPhi: 692_150, cohesion: 4_140, frictionAngle: 13 * DEG, shearModulus: 0.03, maxSinkage: 0.3 }),
  snow: Object.freeze({ n: 1.6, kc: 4_370, kPhi: 196_720, cohesion: 1_030, frictionAngle: 19.7 * DEG, shearModulus: 0.04, maxSinkage: 0.2 }),
  tephra: Object.freeze({ n: 1.1, kc: 990, kPhi: 1_528_430, cohesion: 0, frictionAngle: 34 * DEG, shearModulus: 0.03, maxSinkage: 0.3 }),
} satisfies Record<string, Soil>);

/** The soil models a surface can be, for the parity test and the HUD. */
export const SoilModel = Object.freeze({
  Hard: 0,
  DrySand: 1,
  SandyLoam: 2,
  ClayeySoil: 3,
  Snow: 4,
  Tephra: 5,
});
export type SoilModelId = (typeof SoilModel)[keyof typeof SoilModel];

/** The surface under one tyre: what it sounds like, how it grips and rolls, and its soil when it is soft. */
export interface CarSurface {
  /** The `SurfaceMaterial` id: the tyre's voice and dust. */
  material: number;
  soilModel: SoilModelId;
  /** Hard ground: the rubber's friction on the reference (dry asphalt) curves. */
  friction: number;
  /** The tyre's own rolling resistance on this surface, of the load (soft ground adds compaction to it). */
  rollingResistance: number;
  /** RMS of the ISO 8608 profile below the lattice's 2 m, metres. */
  roughness: number;
  /** How muddy the ground is, 0..1 (water over it reads 1): for spray and darker dust. */
  wetness: number;
  /** Soft ground: the soil, blended towards clay by wetness for mud. */
  soft: boolean;
  n: number;
  kc: number;
  kPhi: number;
  cohesion: number;
  tanFriction: number;
  shearModulus: number;
  maxSinkage: number;
}

export function createCarSurface(): CarSurface {
  const surface: CarSurface = {
    material: SurfaceMaterial.Asphalt,
    soilModel: SoilModel.Hard,
    friction: 1,
    rollingResistance: 0.012,
    roughness: 0,
    wetness: 0,
    soft: false,
    n: 1,
    kc: 0,
    kPhi: 0,
    cohesion: 0,
    tanFriction: 0,
    shearModulus: 0.025,
    maxSinkage: 0,
  };
  return surface;
}

export function copyCarSurface(out: CarSurface, from: Readonly<CarSurface>): void {
  out.material = from.material;
  out.soilModel = from.soilModel;
  out.friction = from.friction;
  out.rollingResistance = from.rollingResistance;
  out.roughness = from.roughness;
  out.wetness = from.wetness;
  out.soft = from.soft;
  out.n = from.n;
  out.kc = from.kc;
  out.kPhi = from.kPhi;
  out.cohesion = from.cohesion;
  out.tanFriction = from.tanFriction;
  out.shearModulus = from.shearModulus;
  out.maxSinkage = from.maxSinkage;
}

/** What a hard surface does to a tyre: friction on the reference curves, rolling resistance, ISO 8608 roughness (m RMS). */
const HARD: Readonly<Record<number, readonly [number, number, number]>> = Object.freeze({
  [SurfaceMaterial.Asphalt]: [1, 0.012, 0],
  [SurfaceMaterial.Concrete]: [1, 0.012, 0],
  // Loose gravel: the stones roll under the tread.
  [SurfaceMaterial.Gravel]: [0.65, 0.02, 0.006],
  [SurfaceMaterial.Rock]: [0.75, 0.018, 0.02],
  [SurfaceMaterial.Basalt]: [0.8, 0.02, 0.025],
});

/** A track: two worn ruts in firm ground. */
const TRACK: readonly [number, number, number] = [0.7, 0.025, 0.012];

/**
 * Packed snow: a thin cover the tyres press down onto the ground under it,
 * so a hard surface with snow's grip. Wong's table 1.3 has a peak adhesion
 * of 0.2 on packed snow against 0.8 to 0.9 on dry asphalt: a quarter of the
 * reference curves (ice is half that again).
 */
const PACKED_SNOW: readonly [number, number, number] = [0.25, 0.015, 0.003];
/** Snow thinner than this packs (`PACKED_SNOW`); deeper, it is Wong's snow soil over that depth, metres. */
export const PACKED_SNOW_METERS = 0.05;
/** The snow's share of the drawn mix at the snowfield's edge, where it is no depth, and where it is full depth. */
const SNOW_EDGE_SHARE = 0.4;
const SNOW_FULL_SHARE = 0.9;

/**
 * The snow's depth from its share of the painted mix: nothing at the
 * snowfield's edge, Wong's full soft layer (`SOILS.snow.maxSinkage`) where
 * the cell is all snow. The classifier's snow weight is the height above the
 * seasonal snowline, shed by steep faces, so a cover the season has only
 * just brought down, or one on a steep face, is thin.
 */
export function snowDepthOf(share: number): number {
  const t = Math.min(1, Math.max(0, (share - SNOW_EDGE_SHARE) / (SNOW_FULL_SHARE - SNOW_EDGE_SHARE)));
  return SOILS.snow.maxSinkage * t * t * (3 - 2 * t);
}

/** Roughness of the soft grounds, metres RMS. */
const SOFT_ROUGHNESS: Readonly<Record<number, number>> = Object.freeze({
  [SurfaceMaterial.Sand]: 0.003,
  [SurfaceMaterial.Tephra]: 0.008,
  [SurfaceMaterial.Grass]: 0.008,
  [SurfaceMaterial.DryGrass]: 0.008,
  [SurfaceMaterial.ForestFloor]: 0.012,
  [SurfaceMaterial.Shrub]: 0.012,
  [SurfaceMaterial.Snow]: 0.003,
});

/** Mud: loam blends towards clay between these wetnesses. */
const MUD_WETNESS_LOW = 0.6;
const MUD_WETNESS_HIGH = 0.9;

/** The soil model a material is, whatever its wetness. */
export function soilModelOf(material: number): SoilModelId {
  switch (material) {
    case SurfaceMaterial.Sand:
      return SoilModel.DrySand;
    case SurfaceMaterial.Tephra:
      return SoilModel.Tephra;
    case SurfaceMaterial.Snow:
      return SoilModel.Snow;
    case SurfaceMaterial.Grass:
    case SurfaceMaterial.DryGrass:
    case SurfaceMaterial.ForestFloor:
    case SurfaceMaterial.Shrub:
      return SoilModel.SandyLoam;
    default:
      return SoilModel.Hard;
  }
}

/**
 * Fill `out` for `material`, with `wetness` (0..1) turning loam to mud: a
 * blend of sandy loam towards the clayey soil, as the plan has it. Snow here
 * is deep snow, Wong's full soft layer; `describeSnow` takes its depth.
 */
export function describeSurface(material: number, wetness: number, out: CarSurface): CarSurface {
  out.material = material;
  out.wetness = 0;
  const hard = HARD[material];
  const model = soilModelOf(material);
  out.soilModel = model;
  if (hard || model === SoilModel.Hard) {
    const row = hard ?? HARD[SurfaceMaterial.Rock]!;
    out.soft = false;
    out.friction = row[0];
    out.rollingResistance = row[1];
    out.roughness = row[2];
    out.maxSinkage = 0;
    return out;
  }
  out.soft = true;
  out.friction = 1;
  out.rollingResistance = 0.012;
  out.roughness = SOFT_ROUGHNESS[material] ?? 0.008;
  let soil: Soil = SOILS.sandyLoam;
  if (model === SoilModel.DrySand) soil = SOILS.drySand;
  else if (model === SoilModel.Tephra) soil = SOILS.tephra;
  else if (model === SoilModel.Snow) soil = SOILS.snow;
  let mud = 0;
  if (model === SoilModel.SandyLoam) {
    const t = Math.min(1, Math.max(0, (wetness - MUD_WETNESS_LOW) / (MUD_WETNESS_HIGH - MUD_WETNESS_LOW)));
    mud = t * t * (3 - 2 * t);
    out.wetness = mud;
    if (mud > 0.5) out.soilModel = SoilModel.ClayeySoil;
  }
  const clay = SOILS.clayeySoil;
  const keep = 1 - mud;
  out.n = soil.n * keep + clay.n * mud;
  out.kc = soil.kc * keep + clay.kc * mud;
  out.kPhi = soil.kPhi * keep + clay.kPhi * mud;
  out.cohesion = soil.cohesion * keep + clay.cohesion * mud;
  out.tanFriction = Math.tan(soil.frictionAngle * keep + clay.frictionAngle * mud);
  out.shearModulus = soil.shearModulus * keep + clay.shearModulus * mud;
  out.maxSinkage = soil.maxSinkage * keep + clay.maxSinkage * mud;
  return out;
}

/**
 * Snow `depth` metres deep (`snowDepthOf`): packed onto the ground under it
 * and hard below `PACKED_SNOW_METERS`, Wong's snow soil over that depth
 * above it. Its own call, so the hot `describeSurface` takes no double
 * argument it would have to box.
 */
export function describeSnow(depth: number, out: CarSurface): CarSurface {
  describeSurface(SurfaceMaterial.Snow, 0, out);
  if (depth < PACKED_SNOW_METERS) {
    out.soft = false;
    out.friction = PACKED_SNOW[0];
    out.rollingResistance = PACKED_SNOW[1];
    out.roughness = PACKED_SNOW[2];
    out.maxSinkage = 0;
  } else out.maxSinkage = Math.min(out.maxSinkage, depth);
  return out;
}

/** The painted material of an infrastructure surface. */
function infrastructureMaterial(surface: InfrastructureSurface): number {
  switch (surface) {
    case "concrete":
      return SurfaceMaterial.Concrete;
    case "asphalt":
      return SurfaceMaterial.Asphalt;
    case "gravel":
      return SurfaceMaterial.Gravel;
    case "track":
      return -2;
  }
}

/** A painted segment wins once it covers this much of the point, as the splat's top material would. */
const PAINT_COVERAGE = 0.5;

/** The classified material, wetness and snow depth at one point of the natural ground: the slow part, cached by `SurfaceCache`. */
export interface NaturalSurface {
  material: number;
  wetness: number;
  /** Metres of snow (`snowDepthOf` its share of the mix); 0 where none is drawn. */
  snowDepth: number;
}

/**
 * The season the terrain is painted for. The splat bake is keyed on the
 * clock's bucketed day (`seasonBakeDayOfYear`) and classifies every texel at
 * the seasonal temperature shifts of that day's two resident buckets'
 * centres; the fragment cross-fades the two by the clock day's own blend.
 */
export interface PaintedSeason {
  dayOfYear: number;
  /** The day the bake is keyed on. */
  bakeDayOfYear: number;
  /** The classifier's seasonal temperature shift at the low and high bucket. */
  lowShift: number;
  highShift: number;
  /** The fragment's cross-fade towards the high bucket, 0..1. */
  blend: number;
}

export function createPaintedSeason(): PaintedSeason {
  return { dayOfYear: Number.NaN, bakeDayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR, lowShift: 0, highShift: 0, blend: 0 };
}

/** The season `world` is painted for on `dayOfYear`, as `TerrainClipmapSystem.setSeasonalDayOfYear` and the splat bake work it out. */
export function paintedSeason(world: WorldDefinition, dayOfYear: number, out: PaintedSeason): PaintedSeason {
  const bakeDay = seasonBakeDayOfYear(dayOfYear);
  const buckets = seasonBucketBlend(bakeDay);
  out.dayOfYear = dayOfYear;
  out.bakeDayOfYear = bakeDay;
  out.lowShift = seasonalTemperatureShift(seasonBucketCenterDay(buckets.lo), world.latitudeDegrees);
  out.highShift = seasonalTemperatureShift(seasonBucketCenterDay(buckets.hi), world.latitudeDegrees);
  out.blend = Math.min(1, Math.max(0, seasonBucketBlend(dayOfYear).t));
  return out;
}

const SAMPLE: TerrainSample = {
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  slope: 0,
  moisture: 0,
  temperature: 0,
  temperatureOffset: 0,
  dryness: 0,
  sandCover: 0,
  ergWeight: 0,
  biome: TerrainBiome.GRASSLAND,
  biomeName: "grassland",
  color: { r: 0, g: 0, b: 0 },
  airportInfluence: 0,
  isRunway: false,
  lavaCover: 0,
  tephraCover: 0,
  volcanicAge: 0,
};

/** The classifier's input for a surface sample, at the reference day (as `world/terrain.ts` classifies); the bake sets the day and shift per season bucket. */
export function landCoverInputOf(world: WorldDefinition, sample: Readonly<TerrainSample>): LandCoverInput {
  return {
    elevationMeters: sample.height - world.seaLevel,
    slope: sample.slope,
    moisture: sample.moisture,
    temperature: sample.temperature,
    aspect: 0,
    airportInfluence: sample.airportInfluence,
    dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
    seasonalTemperatureShift: 0,
    temperatureOffset: sample.temperatureOffset,
    dryness: sample.dryness,
    sandCover: sample.sandCover,
    lavaCover: sample.lavaCover ?? 0,
    tephraCover: sample.tephraCover ?? 0,
    volcanicAge: sample.volcanicAge ?? 0,
  };
}

/**
 * The natural ground's material at (x, z), where its height and gradient are
 * known: the world's surface sample, the bake's canopy and sward there, the
 * classifier at both of `season`'s buckets on one material basis
 * (`alignSeasonalLandCoverWeights`, as the bake stores them), then the
 * dominant material of the fragment's cross-fade. About 25 us in Node, and it
 * allocates (the classifier returns its weights), so `SurfaceCache` keeps the
 * answers.
 */
export function classifyNaturalSurface(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  dhdx: number,
  dhdz: number,
  season: Readonly<PaintedSeason>,
  out: NaturalSurface,
): NaturalSurface {
  const ny = 1 / Math.sqrt(1 + dhdx * dhdx + dhdz * dhdz);
  sampleTerrainSurface(world, x, z, height, 1 - ny, SAMPLE);
  const sandCover = SAMPLE.sandCover;
  // The bake's canopy drivers (PageSplatBake's splatCanopyAt): the shore term neutral, the province raw.
  const plants = densityField(world.sourceSeedHash, {
    x,
    z,
    heightMeters: height,
    seaLevelMeters: world.seaLevel,
    slope: SAMPLE.slope,
    moisture: SAMPLE.moisture,
    normalX: -dhdx * ny,
    normalZ: -dhdz * ny,
    airportInfluence: SAMPLE.airportInfluence,
    dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
    filterWidthMeters: 0,
    temperatureOffset: SAMPLE.temperatureOffset,
    dryness: SAMPLE.dryness,
  });
  const input: LandCoverInput = {
    ...landCoverInputOf(world, SAMPLE),
    dayOfYear: season.bakeDayOfYear,
    canopyClosure: plants.canopyClosure * sandCoverTreeFactor(sandCover),
    grassCover: plants.grassCover * sandCoverGroundFactor(sandCover),
  };
  const aligned = alignSeasonalLandCoverWeights(
    classifyLandCover({ ...input, seasonalTemperatureShift: season.lowShift }),
    classifyLandCover({ ...input, seasonalTemperatureShift: season.highShift }),
  );
  const blend = season.blend;
  let material: number = SurfaceMaterial.Grass;
  let best = -1;
  let snow = 0;
  for (let slot = 0; slot < aligned.ids.length; slot += 1) {
    const weight = (aligned.lowWeights[slot] ?? 0) * (1 - blend) + (aligned.highWeights[slot] ?? 0) * blend;
    const id = aligned.ids[slot]!;
    if (weight > best) {
      best = weight;
      material = id;
    }
    if (id === SurfaceMaterial.Snow) snow = weight;
  }
  out.material = material;
  out.wetness = landCoverWetness(input);
  out.snowDepth = material === SurfaceMaterial.Snow ? snowDepthOf(snow) : 0;
  return out;
}

const CELL_METERS = 4;
const CELL_BITS = 4;
const CELL_SIDE = 1 << CELL_BITS;
const CELL_MASK = CELL_SIDE - 1;

/**
 * The car's surfaces: the exact painted ground (runway, roads) at each
 * tyre, and the classified natural ground cached on a 4 m lattice (the L0
 * splat's texel) round the car, direct-mapped over 64 m. A miss is classified
 * at the cell's centre, on the car's own ground there (the bake classifies
 * its texel's centre; slope bands such as scree are sharp enough that the
 * tyre's own point a few metres off would read another material), at most
 * `MISSES_PER_STEP` a step, so the cost stays flat at speed; a tyre whose
 * cell is not ready yet keeps its last surface. Everything is forgotten when
 * the world, its streamed infrastructure regions or the calendar day change.
 */
export class SurfaceCache {
  private readonly tagI = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly tagJ = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly valid = new Uint8Array(CELL_SIDE * CELL_SIDE);
  private readonly material = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly wetness = new Float64Array(CELL_SIDE * CELL_SIDE);
  private readonly snowDepth = new Float64Array(CELL_SIDE * CELL_SIDE);
  private readonly natural: NaturalSurface = { material: SurfaceMaterial.Grass, wetness: 0, snowDepth: 0 };
  private readonly season: PaintedSeason = createPaintedSeason();
  private readonly paint: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
  private readonly centre: GroundPoint = createGroundPoint();
  private world: WorldDefinition | null = null;
  private version = -1;
  private budget = 0;
  /** Classifications so far, for tests and probes. */
  classified = 0;

  static readonly MISSES_PER_STEP = 1;

  /**
   * Start a step on `dayOfYear` (the renderer's clock): refresh the miss
   * budget, and forget every cell if the world, its regions or the day
   * changed. Returns true when the world or its regions changed, so the
   * ground itself may have moved; a new day only repaints it.
   */
  beginStep(world: WorldDefinition, dayOfYear: number = TERRAIN_REFERENCE_DAY_OF_YEAR): boolean {
    this.budget = SurfaceCache.MISSES_PER_STEP;
    const version = infrastructureRegionsVersion(world);
    const moved = world !== this.world || version !== this.version;
    if (!moved && dayOfYear === this.season.dayOfYear) return false;
    if (world !== this.world || dayOfYear !== this.season.dayOfYear) paintedSeason(world, dayOfYear, this.season);
    this.world = world;
    this.version = version;
    this.valid.fill(0);
    return moved;
  }

  /**
   * The surface at a tyre's contact `at` on `ground` into `out`; false (and
   * `out` untouched) when its cell is not classified yet and this step's
   * budget is spent.
   */
  lookup(world: WorldDefinition, ground: GroundField, at: Readonly<GroundPoint>, out: CarSurface): boolean {
    const x = at.x;
    const z = at.z;
    const airport = worldAirportAt(world, x, z);
    if (airport && isPointOnRunway(airport, x, z)) {
      describeSurface(SurfaceMaterial.Asphalt, 0, out);
      return true;
    }
    const paint = sampleInfrastructureSurface(infrastructureIndex(world), x, z, this.paint);
    if (paint.surface !== null && paint.coverage >= PAINT_COVERAGE) {
      const material = infrastructureMaterial(paint.surface);
      if (material === -2) {
        describeSurface(SurfaceMaterial.Gravel, 0, out);
        out.friction = TRACK[0];
        out.rollingResistance = TRACK[1];
        out.roughness = TRACK[2];
      } else describeSurface(material, 0, out);
      return true;
    }
    const i = Math.floor(x / CELL_METERS);
    const j = Math.floor(z / CELL_METERS);
    const slot = ((j & CELL_MASK) << CELL_BITS) | (i & CELL_MASK);
    if (this.valid[slot] !== 1 || this.tagI[slot] !== i || this.tagJ[slot] !== j) {
      if (this.budget <= 0) return false;
      this.budget -= 1;
      this.classified += 1;
      const centre = this.centre;
      centre.x = (i + 0.5) * CELL_METERS;
      centre.z = (j + 0.5) * CELL_METERS;
      ground.evaluate(centre);
      classifyNaturalSurface(world, centre.x, centre.z, centre.height, centre.dhdx, centre.dhdz, this.season, this.natural);
      this.valid[slot] = 1;
      this.tagI[slot] = i;
      this.tagJ[slot] = j;
      this.material[slot] = this.natural.material;
      this.wetness[slot] = this.natural.wetness;
      this.snowDepth[slot] = this.natural.snowDepth;
    }
    const material = this.material[slot]!;
    if (material === SurfaceMaterial.Snow) describeSnow(this.snowDepth[slot]!, out);
    else describeSurface(material, this.wetness[slot]!, out);
    return true;
  }
}

/** The SurfaceMaterial ids, for callers that name them. */
export type { SurfaceMaterialId };
