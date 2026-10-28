import type { WaterKind } from "@/src/sim/water";
import type { WorldDefinition } from "@/src/world/types";
import type { AtmosphereSnapshot } from "../atmosphere/AtmosphereSystem";
import { hydrologyClimateSamplerFor } from "../water/hydrologyClimate";
import type { HydrologyClimateSampler } from "../water/hydrologyMeshArrays";
import {
  oceanConstituents,
  resolveLakeConstituents,
  resolveRiverConstituents,
  WATER_PURE_BACKSCATTER_PER_METER,
  waterOpticsFromConstituents,
  type WaterConstituents,
} from "../water/WaterConstituents";
import {
  createWaterEnvironmentSample,
  type WaterEnvironmentField,
} from "../water/WaterEnvironmentField";
import {
  WATER_CAUSTIC_INVERSE_IOR_SQUARED,
  WATER_DEEP_REFLECTANCE_G0,
  WATER_DEEP_REFLECTANCE_G1,
  WATER_LUMINANCE_WEIGHTS,
  WATER_SKY_IRRADIANCE_FRACTION,
  WATER_SOLAR_PATH_COSINE_FLOOR,
  WATER_SUN_IRRADIANCE_SCALE,
  type WaterOpticalType,
} from "../water/WaterShaders";

/**
 * The light under the water: what the water-column pass fades the view
 * toward, and how fast the light from above dies with depth. One water type
 * for the whole view, the one at the camera, from the same chemistry and the
 * same optics the water shaders colour the surface with (`W-7`, `W-8`).
 *
 * The model, per colour channel:
 *
 *  - Beam attenuation `c = a + b`. The shaders carry absorption `a` and
 *    backscatter `b_b`; the total scattering behind `b_b` is pure water's
 *    (half of it scatters backward) plus the particles' (1.83% backward,
 *    Petzold's average). Clear open sea comes out at c = 0.28 / 0.063 /
 *    0.025 per metre in red, green and blue: 40 m in blue, red gone in a few
 *    metres. A silty coast is a few metres in every channel.
 *  - Diffuse attenuation `K = (a + b_b) / mu`, the light from above dying
 *    with depth (Lee et al. 2005, the shaders' own down path): the sun's
 *    share along its refracted beam, the sky's along the mean cosine of a
 *    uniform sky seen through the surface.
 *  - The water's own light: straight down it is the deep column's upwelling
 *    radiance `r_rs E_d` (what `applyUnderwaterBeerLambert` veils with);
 *    toward the horizon and up toward the surface the radiance distribution
 *    brightens, `3^(1 + mu)` times the upwelling (3x level, 9x straight up,
 *    the shape measured light fields have outside Snell's window).
 */

/**
 * Pure water scatters symmetrically (Rayleigh-like): half its scattering is
 * backward. Particles scatter forward: Petzold's average 1.83% backward.
 */
export const UNDERWATER_WATER_BACKSCATTER_RATIO = 0.5;
export const UNDERWATER_PARTICLE_BACKSCATTER_RATIO = 0.0183;

/**
 * Mean cosine of skylight under a flat surface: a uniform sky refracts into
 * the 48.6-degree cone, and its irradiance-weighted cosine there is
 * (2/3)(1 - c^3)/(1 - c^2) at c = cos 48.6 deg.
 */
export const UNDERWATER_SKYLIGHT_MEAN_COSINE = 0.842;

/** Radiance level / straight down, and straight up / level, outside the window. */
export const UNDERWATER_RADIANCE_STEP = 3;

/**
 * The camera's water is resolved again once it has moved this far in depth,
 * metres, or its place in the environment field by this much: the shelf's
 * colour runs over tens of metres of depth and the field over kilometres.
 */
export const UNDERWATER_OPTICS_DEPTH_STEP_METERS = 0.25;
export const UNDERWATER_OPTICS_FIELD_STEP = 1 / 512;

/**
 * Lakes and rivers: the drawn water resolves its chemistry from the lake's
 * own depth and area and the river's own width and flow; the camera knows
 * neither, so a lake is taken at twice the water under the camera over 50
 * hectares and a river 20 m wide at 0.8 m/s down a 0.2% grade.
 */
export const UNDERWATER_LAKE_DEPTH_FACTOR = 2;
export const UNDERWATER_LAKE_AREA_SQUARE_METERS = 500_000;
export const UNDERWATER_RIVER_WIDTH_METERS = 20;
export const UNDERWATER_RIVER_SPEED_METERS_PER_SECOND = 0.8;
export const UNDERWATER_RIVER_GRADE = 0.002;

type Rgb = [number, number, number];

/** The camera's water as `UnderwaterLight.setWater` takes it. */
export interface UnderwaterWaterInputs {
  readonly kind: WaterKind;
  readonly x: number;
  readonly z: number;
  /** World Y of the still surface. */
  readonly stillHeight: number;
  /** Metres of water from the still surface to the bed at the camera. */
  readonly waterDepth: number;
}

export class UnderwaterLight {
  /** Beam attenuation `c`, per metre. */
  readonly attenuation: Rgb = [0, 0, 0];
  /** Diffuse attenuation of the sun's share and the sky's, per metre. */
  readonly sunDiffuseAttenuation: Rgb = [0, 0, 0];
  readonly skyDiffuseAttenuation: Rgb = [0, 0, 0];
  /** The deep column's upwelling radiance just under the surface, from the sun's share and the sky's. */
  readonly sunUpwelling: Rgb = [0, 0, 0];
  readonly skyUpwelling: Rgb = [0, 0, 0];
  /** The sun's share of the downwelling luminance just under the surface. */
  directFraction = 0;
  /** Absorption and backscatter of the camera's water, per metre. */
  readonly absorption: Rgb = [0, 0, 0];
  readonly backscatter: Rgb = [0, 0, 0];
  /** The sine of the sun's elevation above the water (its beam's angle sets where caustics focus). */
  sunElevationSine = 1;
  /**
   * The sun's and the sky's irradiance on a level surface above the water,
   * over pi (the water shaders' `downwelling.total`): what a white surface
   * lit in air shows, before the water dims it with depth.
   */
  readonly downwelling: Rgb = [0, 0, 0];

  private readonly world: WorldDefinition;
  private readonly field: WaterEnvironmentField | null;
  private readonly climate: HydrologyClimateSampler;
  private readonly environment = createWaterEnvironmentSample();
  private readonly sunIrradiance: Rgb = [0, 0, 0];
  private readonly skyIrradiance: Rgb = [0, 0, 0];
  private waterKind: WaterKind = "none";
  private waterDepth = Number.NaN;
  private productivity = Number.NaN;
  private runoff = Number.NaN;
  private stillHeight = Number.NaN;
  private resolves = 0;

  constructor(world: WorldDefinition, field: WaterEnvironmentField | null) {
    this.world = world;
    this.field = field;
    this.climate = hydrologyClimateSamplerFor(world);
    this.setOptics(waterOpticsFromConstituents(oceanConstituents(40, 0.35, 0.5)));
  }

  /** How many times the camera's water type has been resolved. */
  get waterResolves(): number {
    return this.resolves;
  }

  /** The sun and the sky above the water, as the water materials take them. */
  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sunScale = atmosphere.sunIlluminanceNormalized * WATER_SUN_IRRADIANCE_SCALE;
    this.sunElevationSine = atmosphere.sunDirection.y;
    const elevation = Math.max(this.sunElevationSine, 0);
    this.sunIrradiance[0] = atmosphere.sunColor.r * sunScale * elevation;
    this.sunIrradiance[1] = atmosphere.sunColor.g * sunScale * elevation;
    this.sunIrradiance[2] = atmosphere.sunColor.b * sunScale * elevation;
    const skyScale = 0.5 * WATER_SKY_IRRADIANCE_FRACTION * atmosphere.skylightIlluminanceNormalized;
    this.skyIrradiance[0] = (atmosphere.skyZenith.r + atmosphere.skyHorizon.r) * skyScale;
    this.skyIrradiance[1] = (atmosphere.skyZenith.g + atmosphere.skyHorizon.g) * skyScale;
    this.skyIrradiance[2] = (atmosphere.skyZenith.b + atmosphere.skyHorizon.b) * skyScale;
    for (let channel = 0; channel < 3; channel += 1) {
      this.downwelling[channel] = this.sunIrradiance[channel]! + this.skyIrradiance[channel]!;
    }
    this.derive();
  }

  /**
   * The water around the camera. Its type is resolved again only once the
   * camera has moved far enough for it to change (`UNDERWATER_OPTICS_*`).
   */
  setWater(water: UnderwaterWaterInputs): void {
    if (water.kind === "none") return;
    let productivity = 0;
    let runoff = 0;
    if (water.kind === "sea") {
      if (this.field) {
        this.field.sample(water.x, water.z, this.environment);
        productivity = this.environment.productivity;
        runoff = this.environment.runoff;
      } else {
        productivity = 0.35;
        runoff = 0.5;
      }
    }
    if (
      water.kind === this.waterKind
      && Math.abs(water.waterDepth - this.waterDepth) < UNDERWATER_OPTICS_DEPTH_STEP_METERS
      && Math.abs(productivity - this.productivity) < UNDERWATER_OPTICS_FIELD_STEP
      && Math.abs(runoff - this.runoff) < UNDERWATER_OPTICS_FIELD_STEP
      && (water.kind === "sea" || Math.abs(water.stillHeight - this.stillHeight) < UNDERWATER_OPTICS_DEPTH_STEP_METERS)
    ) return;
    this.waterKind = water.kind;
    this.waterDepth = water.waterDepth;
    this.productivity = productivity;
    this.runoff = runoff;
    this.stillHeight = water.stillHeight;
    this.resolves += 1;
    this.setOptics(waterOpticsFromConstituents(this.constituents(water, productivity, runoff)));
  }

  private constituents(water: UnderwaterWaterInputs, productivity: number, runoff: number): WaterConstituents {
    if (water.kind === "sea") return oceanConstituents(water.waterDepth, productivity, runoff);
    const sample = this.climate(water.x, water.z, water.stillHeight);
    const environment = {
      elevationAboveSeaMeters: Math.max(water.stillHeight - this.world.seaLevel, 0),
      temperature: sample.temperature,
      moisture: sample.moisture,
      ...(sample.temperatureOffset !== undefined ? { temperatureOffset: sample.temperatureOffset } : {}),
      ...(sample.dryness !== undefined ? { dryness: sample.dryness } : {}),
    };
    return water.kind === "lake"
      ? resolveLakeConstituents(
        environment,
        Math.max(water.waterDepth, 1) * UNDERWATER_LAKE_DEPTH_FACTOR,
        UNDERWATER_LAKE_AREA_SQUARE_METERS,
      )
      : resolveRiverConstituents(
        environment,
        UNDERWATER_RIVER_WIDTH_METERS,
        UNDERWATER_RIVER_SPEED_METERS_PER_SECOND,
        UNDERWATER_RIVER_GRADE,
      );
  }

  private setOptics(optics: WaterOpticalType): void {
    for (let channel = 0; channel < 3; channel += 1) {
      this.absorption[channel] = optics.absorptionPerMeter[channel]!;
      this.backscatter[channel] = optics.backscatterPerMeter[channel]!;
    }
    this.derive();
  }

  private derive(): void {
    // Snell: the sun's beam inside the water, as the shaders' down path.
    const incidentSine2 = Math.max(1 - this.sunElevationSine * this.sunElevationSine, 0);
    const solarCosine = Math.sqrt(Math.max(1 - incidentSine2 * WATER_CAUSTIC_INVERSE_IOR_SQUARED, 0));
    const sunPath = 1 / Math.max(solarCosine, WATER_SOLAR_PATH_COSINE_FLOOR);
    const skyPath = 1 / UNDERWATER_SKYLIGHT_MEAN_COSINE;
    let sunLuminance = 0;
    let totalLuminance = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const absorption = this.absorption[channel]!;
      const backscatter = this.backscatter[channel]!;
      const waterBackscatter = WATER_PURE_BACKSCATTER_PER_METER[channel]!;
      const scattering = waterBackscatter / UNDERWATER_WATER_BACKSCATTER_RATIO
        + Math.max(backscatter - waterBackscatter, 0) / UNDERWATER_PARTICLE_BACKSCATTER_RATIO;
      this.attenuation[channel] = absorption + scattering;
      const beam = Math.max(absorption + backscatter, 0.0001);
      this.sunDiffuseAttenuation[channel] = beam * sunPath;
      this.skyDiffuseAttenuation[channel] = beam * skyPath;
      const u = backscatter / beam;
      const deep = (WATER_DEEP_REFLECTANCE_G0 + WATER_DEEP_REFLECTANCE_G1 * u) * u;
      this.sunUpwelling[channel] = Math.PI * deep * this.sunIrradiance[channel]!;
      this.skyUpwelling[channel] = Math.PI * deep * this.skyIrradiance[channel]!;
      const weight = WATER_LUMINANCE_WEIGHTS[channel]!;
      sunLuminance += weight * this.sunIrradiance[channel]!;
      totalLuminance += weight * (this.sunIrradiance[channel]! + this.skyIrradiance[channel]!);
    }
    this.directFraction = sunLuminance / Math.max(totalLuminance, 0.000001);
  }
}
