/**
 * `W-8` — the sea's ENVIRONMENT FIELD: what the land around a stretch of
 * water is like, sampled where the water can afford to read it.
 *
 * The ocean fragment has no room for another texture — it declares exactly 16
 * sampled textures and 16 samplers, which is the device limit this renderer
 * targets. The ocean VERTEX stage has eleven free slots and the disk's rings
 * are far finer than the fields this carries (the climate lattice is 11 km and
 * the moisture lattice 5.2 km, against a ring spacing that reaches ~1 km only
 * out where a province spans hundreds of pixels), so the field is sampled per
 * vertex and interpolated. That is the same trade wave S made for the 1.5 km
 * gust octave, for the same reason.
 *
 * Two channels, both dimensionless 0..1:
 *
 *   R  productivity — how much life this water carries. Cold, wet coasts are
 *      green; warm dry ones are blue. Built from the terrain's own temperature
 *      and moisture fields, so the sea agrees with the land it touches instead
 *      of being noise that happens to sit next to it.
 *   G  runoff — how much stained fresh water the catchment delivers, from the
 *      same moisture field the forests and the rivers are placed by.
 *
 * It is baked on the CPU because that is where the terrain's climate lives:
 * both fields are `terrain.ts` functions, and transliterating their lattices
 * into the water vertex stage would mean carrying the terrain kernel's whole
 * uniform block into a shader that only needs two smooth numbers.
 */

import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldDefinition } from "@/src/world/types";
import {
  sampleTerrainClimate,
  sampleTerrainMoisture,
  terrainTemperatureFromClimate,
} from "@/src/world/terrain";

/** Texels per axis. 96 over 160 km is 1.67 km/texel — under a third of the
 * moisture lattice's 5.2 km, so nothing the field carries is aliased. */
export const WATER_ENVIRONMENT_FIELD_RESOLUTION = 96;
/** Span of the field, metres. Wider than the ocean disk's 90 km radius view
 * at the horizon so a whole frame is covered by one bake. */
export const WATER_ENVIRONMENT_FIELD_SPAN_METERS = 200_000;
/** Re-bake once the camera has left the middle half of the current window. */
export const WATER_ENVIRONMENT_FIELD_REBAKE_FRACTION = 0.25;

/**
 * Productivity from the terrain's climate: cold water is nutrient-rich and
 * green, warm water is oligotrophic and blue, and a wet catchment feeds both.
 * The temperature reference (0.66) is `terrainTemperatureFromClimate`'s own
 * sea-level mean, so a world whose climate noise runs cold reads as a
 * subpolar green sea and a warm one as a subtropical blue.
 */
export function waterProductivity(temperature: number, moisture: number): number {
  return clamp01(0.5 + (0.66 - temperature) * 1.9 + (moisture - 0.5) * 0.55);
}

/** Runoff is the moisture field itself: what the land is shedding. */
export function waterRunoff(moisture: number): number {
  return clamp01(moisture);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** The placement a water material binds: origin, 1/span, and a validity flag. */
export interface WaterEnvironmentPlacement {
  readonly originX: number;
  readonly originZ: number;
  readonly inverseSpan: number;
}

/**
 * The one-texel stand-in a water material binds from construction: a
 * temperate, moderately wet province, which is what the renderer's default
 * world is. Shared per scene like the other water fallbacks.
 */
const FALLBACK_FIELDS = new WeakMap<Scene, RawTexture>();

export function fallbackWaterEnvironmentField(scene: Scene): RawTexture {
  const existing = FALLBACK_FIELDS.get(scene);
  if (existing) return existing;
  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([Math.round(0.35 * 255), Math.round(0.5 * 255), 0, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.name = "water-environment-fallback";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  FALLBACK_FIELDS.set(scene, texture);
  scene.onDisposeObservable.addOnce(() => {
    FALLBACK_FIELDS.get(scene)?.dispose();
    FALLBACK_FIELDS.delete(scene);
  });
  return texture;
}

export class WaterEnvironmentField {
  private readonly world: WorldDefinition;
  private texture: RawTexture;
  private readonly data: Uint8Array;
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private bakeCount = 0;

  constructor(scene: Scene, world: WorldDefinition) {
    this.world = world;
    const resolution = WATER_ENVIRONMENT_FIELD_RESOLUTION;
    this.data = new Uint8Array(resolution * resolution * 4);
    this.texture = RawTexture.CreateRGBATexture(
      this.data,
      resolution,
      resolution,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    this.texture.name = "water-environment-field";
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  }

  /** How many bakes have run — the perf claim ("rarely") made checkable. */
  get bakes(): number {
    return this.bakeCount;
  }

  get placement(): WaterEnvironmentPlacement {
    if (!Number.isFinite(this.centerX)) {
      return { originX: 0, originZ: 0, inverseSpan: 0 };
    }
    const span = WATER_ENVIRONMENT_FIELD_SPAN_METERS;
    return {
      originX: this.centerX - span * 0.5,
      originZ: this.centerZ - span * 0.5,
      inverseSpan: 1 / span,
    };
  }

  get fieldTexture(): RawTexture {
    return this.texture;
  }

  /**
   * Bake if the camera has left the middle of the current window. Returns true
   * when the texture changed, so the caller can re-bind the placement.
   */
  update(cameraX: number, cameraZ: number): boolean {
    if (!Number.isFinite(cameraX) || !Number.isFinite(cameraZ)) {
      throw new RangeError("Water environment field needs a finite camera position");
    }
    const span = WATER_ENVIRONMENT_FIELD_SPAN_METERS;
    const threshold = span * WATER_ENVIRONMENT_FIELD_REBAKE_FRACTION;
    if (
      Number.isFinite(this.centerX)
      && Math.abs(cameraX - this.centerX) < threshold
      && Math.abs(cameraZ - this.centerZ) < threshold
    ) {
      return false;
    }
    // Snap the window to whole texels so a re-bake cannot shift the field
    // under the surface: the same world position keeps the same value, which
    // is what stops the colour provinces crawling as the aircraft flies.
    const texel = span / WATER_ENVIRONMENT_FIELD_RESOLUTION;
    this.centerX = Math.round(cameraX / texel) * texel;
    this.centerZ = Math.round(cameraZ / texel) * texel;
    this.bake();
    return true;
  }

  private bake(): void {
    const resolution = WATER_ENVIRONMENT_FIELD_RESOLUTION;
    const span = WATER_ENVIRONMENT_FIELD_SPAN_METERS;
    const texel = span / resolution;
    const originX = this.centerX - span * 0.5;
    const originZ = this.centerZ - span * 0.5;
    for (let iz = 0; iz < resolution; iz += 1) {
      const z = originZ + (iz + 0.5) * texel;
      for (let ix = 0; ix < resolution; ix += 1) {
        const x = originX + (ix + 0.5) * texel;
        // Filter width = one texel: the same band limiting the terrain's own
        // consumers use, so the field cannot carry detail it cannot resolve.
        const moisture = sampleTerrainMoisture(this.world, x, z, texel);
        const climate = sampleTerrainClimate(this.world, x, z, texel);
        // Sea-level temperature: the sea IS at sea level, so no lapse term.
        const temperature = terrainTemperatureFromClimate(
          this.world,
          climate,
          this.world.seaLevel,
        );
        const offset = (iz * resolution + ix) * 4;
        this.data[offset] = Math.round(waterProductivity(temperature, moisture) * 255);
        this.data[offset + 1] = Math.round(waterRunoff(moisture) * 255);
        this.data[offset + 2] = 0;
        this.data[offset + 3] = 255;
      }
    }
    this.texture.update(this.data);
    this.bakeCount += 1;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
