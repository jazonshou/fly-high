import { densityField, sandCoverGroundFactor, sandCoverTreeFactor } from "@/src/render/webgpu/detail/densityField";
import { classifyLandCover, dominantLandCover, landCoverWetness, type LandCoverInput } from "@/src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial, type SurfaceMaterialId } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { isPointOnRunway, worldAirportAt } from "@/src/world/airport";
import {
  infrastructureIndex,
  infrastructureRegionsVersion,
  sampleInfrastructureSurface,
  type InfrastructureSurface,
  type InfrastructureSurfaceSample,
} from "@/src/world/infrastructure";
import { sampleTerrainSurface, TERRAIN_REFERENCE_DAY_OF_YEAR } from "@/src/world/terrain";
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
 * parity test bounds the rest. The classifier reads the reference day: the
 * seasonal snow paint the bake adds with the calendar does not reach the
 * worker yet.
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
 * blend of sandy loam towards the clayey soil, as the plan has it.
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

/** The classified material and wetness at one point of the natural ground: the slow part, cached by `SurfaceCache`. */
export interface NaturalSurface {
  material: number;
  wetness: number;
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

/** The classifier's input for a surface sample, at the reference day (as `world/terrain.ts` classifies). */
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
 * known: the world's surface sample, the bake's canopy and sward there, then
 * the classifier's dominant material. About 20 us in Node, and it allocates
 * (the classifier returns its weights), so `SurfaceCache` keeps the answers.
 */
export function classifyNaturalSurface(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  dhdx: number,
  dhdz: number,
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
    canopyClosure: plants.canopyClosure * sandCoverTreeFactor(sandCover),
    grassCover: plants.grassCover * sandCoverGroundFactor(sandCover),
  };
  out.material = dominantLandCover(classifyLandCover(input)) as number;
  out.wetness = landCoverWetness(input);
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
 * the world or its streamed infrastructure regions change.
 */
export class SurfaceCache {
  private readonly tagI = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly tagJ = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly valid = new Uint8Array(CELL_SIDE * CELL_SIDE);
  private readonly material = new Int32Array(CELL_SIDE * CELL_SIDE);
  private readonly wetness = new Float64Array(CELL_SIDE * CELL_SIDE);
  private readonly natural: NaturalSurface = { material: SurfaceMaterial.Grass, wetness: 0 };
  private readonly paint: InfrastructureSurfaceSample = { surface: null, coverage: 0 };
  private readonly centre: GroundPoint = createGroundPoint();
  private world: WorldDefinition | null = null;
  private version = -1;
  private budget = 0;
  /** Classifications so far, for tests and probes. */
  classified = 0;

  static readonly MISSES_PER_STEP = 1;

  /** Start a step: refresh the miss budget, and forget everything if the world or its regions changed. Returns true when it forgot. */
  beginStep(world: WorldDefinition): boolean {
    this.budget = SurfaceCache.MISSES_PER_STEP;
    const version = infrastructureRegionsVersion(world);
    if (world === this.world && version === this.version) return false;
    this.world = world;
    this.version = version;
    this.valid.fill(0);
    return true;
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
      classifyNaturalSurface(world, centre.x, centre.z, centre.height, centre.dhdx, centre.dhdz, this.natural);
      this.valid[slot] = 1;
      this.tagI[slot] = i;
      this.tagJ[slot] = j;
      this.material[slot] = this.natural.material;
      this.wetness[slot] = this.natural.wetness;
    }
    describeSurface(this.material[slot]!, this.wetness[slot]!, out);
    return true;
  }
}

/** The SurfaceMaterial ids, for callers that name them. */
export type { SurfaceMaterialId };
