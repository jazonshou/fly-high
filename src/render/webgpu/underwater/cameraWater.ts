import type { WeatherPreset } from "@/src/game/types";
import {
  createSeaSurfacePoint,
  createSeaTwin,
  createWaterSurfaceSample,
  HydrologyWaterSource,
  resolveSeaSpectrumConfig,
  SEA_TWIN_CASCADES,
  WaterSurfaceComposite,
  type HydrologyWaterRegion,
  type SeaTwin,
  type WaterKind,
  type WaterSurfaceAuthority,
  type WaterSurfaceSample,
  type WaveFieldFocus,
} from "@/src/sim/water";
import {
  oceanEffectiveFetchMeters,
  oceanExpectedHeightVariance,
  oceanSeaStateEnergyScale,
} from "@/src/sim/water/spectrum";
import type { SpectralOceanConfig } from "@/src/sim/water/spectrumConfig";
import { homeMarina } from "@/src/world/marina";
import type { WorldDefinition } from "@/src/world/types";

/**
 * The twin is stepped once its time is this far behind the camera's,
 * seconds; between steps a height is carried by the surface's rise rate (the
 * dropped term is about 3 mm at 8 m waves).
 */
export const CAMERA_WATER_TWIN_SECONDS = 0.05;

/**
 * A sample within this distance of the last point the twin evaluated, metres,
 * is carried there along the surface's slope instead (under a millimetre at
 * 8 m waves); a point farther off is evaluated afresh.
 */
export const CAMERA_WATER_CARRY_METERS = 0.25;

/**
 * Past this many standard deviations of the sea's height (plus
 * `CAMERA_WATER_ENVELOPE_MARGIN_METERS`) from the still level, no wave
 * reaches the camera and the twin is not asked: the side is the still
 * level's.
 */
export const CAMERA_WATER_ENVELOPE_SIGMAS = 6;
export const CAMERA_WATER_ENVELOPE_MARGIN_METERS = 0.3;

/**
 * The band either side of the sampled surface a camera keeps clear of for its
 * side to be certain: `BASE + PER_HS * Hs`. The twin leaves out the drawn
 * sea's sub-8 m cascade (sigma 3.5-4.4 cm), 1% of its own variance and the
 * 2.8 cm ripple relief, about 3 sigma of them all at 7% of the significant
 * height; the base holds the near plane's half height (0.08 m near, 62 deg)
 * and a margin.
 */
export const CAMERA_WATER_CLEARANCE_BASE_METERS = 0.15;
export const CAMERA_WATER_CLEARANCE_PER_HS = 0.07;

/** The water at a camera position (`CameraWaterSampler.sample`); callers keep one and reuse it. */
export interface CameraWaterSample {
  /** The water over the camera's ground point; `"none"` on dry ground. */
  kind: WaterKind;
  /**
   * World Y of the drawn surface over the camera: the sea with its waves (the
   * cascades this tier draws), a lake's level, a river's local level. The
   * ground's height where `kind` is `"none"`.
   */
  surfaceHeight: number;
  /** World Y of the still surface; the ground's height where `kind` is `"none"`. */
  stillHeight: number;
  /** Metres from the drawn surface down to the camera: positive under water, negative above it. */
  depth: number;
  /** Metres from the still surface down to the camera: what the light reaching the camera follows. */
  stillDepth: number;
  /** Metres of water from the still surface to the bed; 0 where `kind` is `"none"`. */
  waterDepth: number;
  /** Whether the camera is under the water's surface. */
  submerged: boolean;
  /**
   * The band either side of `surfaceHeight` within which the side is not
   * certain (the sampled sea leaves out the shortest waves), metres; 0 on
   * still water.
   */
  clearance: number;
}

export function createCameraWaterSample(): CameraWaterSample {
  return {
    kind: "none",
    surfaceHeight: 0,
    stillHeight: 0,
    depth: Number.NEGATIVE_INFINITY,
    stillDepth: Number.NEGATIVE_INFINITY,
    waterDepth: 0,
    submerged: false,
    clearance: 0,
  };
}

/** World terrain height at a point (the renderer's own, the camera clamp's). */
export type CameraWaterTerrainHeight = (x: number, z: number) => number;

/** The sea's height spread for a config, metres (the canonical expected sigma, every cascade). */
export function seaHeightSigma(config: SpectralOceanConfig): number {
  return Math.sqrt(oceanExpectedHeightVariance(
    config,
    oceanEffectiveFetchMeters(config),
    oceanSeaStateEnergyScale(config),
  ));
}

/**
 * The sea as the camera sees it: the drawn sea's twin, asked only near its
 * surface, with the cascades a tier does not draw taken off.
 *
 * The drawn ocean exists only over ground below the still level (above it
 * the terrain owns the swash, `SpectralOceanSystem`), so a ground at or above
 * the level is dry. Elsewhere the twin is asked only while the camera is
 * within the waves' envelope of the still level; farther up or down the still
 * level answers, which puts the camera on the same side.
 */
class CameraSeaSurface implements WaterSurfaceAuthority {
  /** World Y of the camera for the next `sample`. */
  cameraY = 0;
  /** How many of the twin's sampled heights this frame took a fresh evaluation (tests). */
  evaluations = 0;
  private time = Number.NaN;
  private twinTime = Number.NaN;
  private twin: SeaTwin | null = null;
  private weather: WeatherPreset;
  private envelope = 0;
  /** The sea's significant height for this weather, metres. */
  significantHeight = 0;
  private readonly point = createSeaSurfacePoint();
  private readonly focus: WaveFieldFocus = { x: 0, z: 0, heading: 0, halfLength: 1, halfBeam: 1 };
  // The last evaluation: where, at what twin time, and the drawn surface there.
  private evaluatedX = Number.NaN;
  private evaluatedZ = Number.NaN;
  private evaluatedTime = Number.NaN;
  private evaluatedHeight = 0;
  private evaluatedSlopeX = 0;
  private evaluatedSlopeZ = 0;
  private evaluatedRate = 0;

  constructor(
    private readonly world: WorldDefinition,
    weather: WeatherPreset,
    private readonly terrainHeight: CameraWaterTerrainHeight,
    private drawnCascades: number,
  ) {
    this.weather = weather;
    this.envelope = this.envelopeFor(resolveSeaSpectrumConfig(world, weather));
  }

  get built(): boolean {
    return this.twin !== null;
  }

  /** Build the twin now (at load: about 0.1 s), not at the first sample near the surface. */
  build(): void {
    if (this.twin) return;
    const twin = createSeaTwin(this.world, this.weather);
    // The marina's basin calms the drawn sea and the worker's twin alike.
    twin.setShelter([homeMarina(this.world).shelter]);
    this.twin = twin;
    this.forget();
  }

  setWeather(weather: WeatherPreset): void {
    if (weather === this.weather) return;
    this.weather = weather;
    const config = resolveSeaSpectrumConfig(this.world, weather);
    this.envelope = this.envelopeFor(config);
    this.twin?.setConfig(config);
    this.forget();
  }

  setDrawnCascades(drawnCascades: number): void {
    if (drawnCascades === this.drawnCascades) return;
    this.drawnCascades = drawnCascades;
    this.forget();
  }

  setTime(time: number): void {
    this.time = time;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const seaLevel = this.world.seaLevel;
    const bed = this.terrainHeight(x, z);
    out.velocity.x = 0;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    if (!(bed < seaLevel)) {
      out.kind = "none";
      out.height = Number.isFinite(bed) ? bed : seaLevel;
      out.stillHeight = out.height;
      out.depth = 0;
      return out;
    }
    out.kind = "sea";
    out.stillHeight = seaLevel;
    out.depth = seaLevel - bed;
    out.height = Math.abs(this.cameraY - seaLevel) > this.envelope ? seaLevel : this.waveHeight(x, z);
    return out;
  }

  private waveHeight(x: number, z: number): number {
    const time = this.time;
    const lag = time - this.evaluatedTime;
    const offsetX = x - this.evaluatedX;
    const offsetZ = z - this.evaluatedZ;
    if (lag >= 0 && lag < CAMERA_WATER_TWIN_SECONDS
      && offsetX * offsetX + offsetZ * offsetZ <= CAMERA_WATER_CARRY_METERS * CAMERA_WATER_CARRY_METERS) {
      return this.evaluatedHeight + this.evaluatedSlopeX * offsetX + this.evaluatedSlopeZ * offsetZ
        + this.evaluatedRate * lag;
    }
    if (!this.twin) this.build();
    const twin = this.twin!;
    const behind = time - this.twinTime;
    if (Number.isFinite(time) && !(behind >= 0 && behind < CAMERA_WATER_TWIN_SECONDS)) {
      twin.setTime(time);
      this.twinTime = time;
    }
    this.focus.x = x;
    this.focus.z = z;
    twin.setFocus(this.focus);
    const point = twin.surfacePointAt(x, z, this.point);
    // The cascades this tier leaves undrawn, at the focus (the camera).
    const undrawn = this.drawnCascades <= SEA_TWIN_CASCADES[SEA_TWIN_CASCADES.length - 1]!
      ? twin.undrawnHeave(this.drawnCascades)
      : 0;
    this.evaluations += 1;
    this.evaluatedX = x;
    this.evaluatedZ = z;
    this.evaluatedTime = this.twinTime;
    this.evaluatedHeight = point.height - undrawn;
    this.evaluatedSlopeX = point.slopeX;
    this.evaluatedSlopeZ = point.slopeZ;
    this.evaluatedRate = point.rate;
    return this.evaluatedHeight + this.evaluatedRate * (time - this.twinTime);
  }

  private envelopeFor(config: SpectralOceanConfig): number {
    const sigma = seaHeightSigma(config);
    this.significantHeight = 4 * sigma;
    return CAMERA_WATER_ENVELOPE_SIGMAS * sigma + CAMERA_WATER_ENVELOPE_MARGIN_METERS;
  }

  /** Drop the carried evaluation (a new sea, a new tier, a new twin). */
  private forget(): void {
    this.evaluatedTime = Number.NaN;
    this.twinTime = Number.NaN;
  }
}

/**
 * The camera's water on the main thread (walking plan, underwater view): the
 * drawn sea at the camera from the CPU sea twin (the same waves, seed,
 * weather and marina shelter as the walker's twin in the simulation worker,
 * at the same simulation time), and the drawn lakes and rivers from their
 * hydrology surface, joined by the estuary rule (`WaterSurfaceComposite`).
 *
 * It answers which side of the drawn surface a camera position is on and how
 * far: the underwater view switches on while the render camera is
 * submerged, and the character camera crosses the surface in one short move
 * and never stops within `clearance` of it.
 *
 * Cost: on dry ground, over a lake or river, and over the sea farther from
 * its still level than the waves reach, one terrain sample and one bin
 * lookup. Near the sea's surface one pass over the twin's 8-32 m band
 * (about 1,200 waves) per fresh point, with the twin's time stepped every
 * `CAMERA_WATER_TWIN_SECONDS`; a point within `CAMERA_WATER_CARRY_METERS` of
 * the last one evaluated, inside that time, is carried along the surface's
 * slope and rise rate for a few multiplies.
 */
export class CameraWaterSampler {
  private readonly sea: CameraSeaSurface;
  private readonly inland: HydrologyWaterSource;
  private readonly water: WaterSurfaceComposite;
  private readonly scratch = createWaterSurfaceSample();

  constructor(
    world: WorldDefinition,
    weather: WeatherPreset,
    terrainHeight: CameraWaterTerrainHeight,
    drawnCascades: number,
  ) {
    this.sea = new CameraSeaSurface(world, weather, terrainHeight, drawnCascades);
    this.inland = new HydrologyWaterSource(terrainHeight);
    this.water = new WaterSurfaceComposite(this.sea, this.inland, world.seaLevel);
  }

  /** Whether the sea twin has been built. */
  get built(): boolean {
    return this.sea.built;
  }

  /** Fresh twin evaluations so far (tests count them). */
  get evaluations(): number {
    return this.sea.evaluations;
  }

  /** How many lake and river regions answer. */
  get inlandRegionCount(): number {
    return this.inland.regionCount;
  }

  /** Build the sea twin now, behind the load screen, rather than at the first dive. */
  build(): void {
    this.sea.build();
  }

  setWeather(weather: WeatherPreset): void {
    this.sea.setWeather(weather);
  }

  /** The cascades this tier draws (`profile.oceanCascades`); the rest are taken off the sampled sea. */
  setDrawnCascades(drawnCascades: number): void {
    this.sea.setDrawnCascades(drawnCascades);
  }

  /**
   * A drawn lake-and-river region, as `HydrologySystem` publishes it. The
   * arrays are kept, so a caller that also transfers them to a worker passes
   * a copy here (`copyHydrologyWaterRegion`).
   */
  setHydrologyRegion(key: string, region: Readonly<HydrologyWaterRegion>): void {
    this.inland.setRegion(key, region);
  }

  evictHydrologyRegion(key: string): void {
    this.inland.evictRegion(key);
  }

  /**
   * The water at a camera position at simulation time `time` (the clock the
   * drawn ocean runs on), written to `out`. Allocates nothing.
   */
  sample(x: number, y: number, z: number, time: number, out: CameraWaterSample): CameraWaterSample {
    this.sea.cameraY = y;
    this.water.setTime(time);
    this.inland.setVehiclePosition(x, z);
    const water = this.water.sample(x, z, this.scratch);
    out.kind = water.kind;
    out.surfaceHeight = water.height;
    out.stillHeight = water.stillHeight;
    out.waterDepth = water.depth;
    if (water.kind === "none") {
      out.depth = Number.NEGATIVE_INFINITY;
      out.stillDepth = Number.NEGATIVE_INFINITY;
      out.submerged = false;
      out.clearance = 0;
      return out;
    }
    out.depth = water.height - y;
    out.stillDepth = water.stillHeight - y;
    out.submerged = out.depth > 0;
    out.clearance = water.kind === "sea"
      ? CAMERA_WATER_CLEARANCE_BASE_METERS + CAMERA_WATER_CLEARANCE_PER_HS * this.sea.significantHeight
      : CAMERA_WATER_CLEARANCE_BASE_METERS;
    return out;
  }
}

/** A copy of a packed region whose own buffers can go to a worker. */
export function copyHydrologyWaterRegion(region: Readonly<HydrologyWaterRegion>): HydrologyWaterRegion {
  return {
    riverPoints: region.riverPoints.slice(),
    riverStarts: region.riverStarts.slice(),
    lakeLevels: region.lakeLevels.slice(),
    lakeBoundary: region.lakeBoundary.slice(),
    lakeStarts: region.lakeStarts.slice(),
  };
}
