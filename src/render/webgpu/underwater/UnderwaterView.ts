import type { WeatherPreset } from "@/src/game/types";
import type { HydrologyWaterRegion } from "@/src/sim/water";
import type { WorldDefinition } from "@/src/world/types";
import type { HydrologyWaterPublisher } from "../water/HydrologySystem";
import {
  CameraWaterSampler,
  copyHydrologyWaterRegion,
  createCameraWaterSample,
  type CameraWaterSample,
  type CameraWaterTerrainHeight,
} from "./cameraWater";

export interface UnderwaterViewOptions {
  readonly world: WorldDefinition;
  readonly weather: WeatherPreset;
  /** The renderer's own terrain height (the camera clamp's). */
  readonly terrainHeight: CameraWaterTerrainHeight;
  /** `profile.oceanCascades`: the cascades this tier draws. */
  readonly drawnCascades: number;
}

/**
 * The view from under the water (walking plan, "Underwater view"): built in
 * car sessions only, where the walker can dive. Above the water nothing of it
 * runs but the camera's water sample.
 *
 * Each frame `update` samples the water at the render camera; while the
 * camera is submerged the underwater path is switched on.
 */
export class UnderwaterView {
  readonly cameraWater: CameraWaterSampler;
  private readonly cameraSample = createCameraWaterSample();

  constructor(options: UnderwaterViewOptions) {
    this.cameraWater = new CameraWaterSampler(
      options.world,
      options.weather,
      options.terrainHeight,
      options.drawnCascades,
    );
    // At load, behind the load screen: about 0.1 s, never at the first dive.
    this.cameraWater.build();
  }

  /** The render camera's water as of the last `update`. */
  get camera(): Readonly<CameraWaterSample> {
    return this.cameraSample;
  }

  /** Whether the render camera was under the water at the last `update`. */
  get submerged(): boolean {
    return this.cameraSample.submerged;
  }

  /** The render camera's world position this frame, at the simulation time the ocean is drawn at. */
  update(cameraX: number, cameraY: number, cameraZ: number, timeSeconds: number): void {
    this.cameraWater.sample(cameraX, cameraY, cameraZ, timeSeconds, this.cameraSample);
  }

  setWeather(weather: WeatherPreset): void {
    this.cameraWater.setWeather(weather);
  }

  setDrawnCascades(drawnCascades: number): void {
    this.cameraWater.setDrawnCascades(drawnCascades);
  }

  /**
   * The drawn lakes and rivers for the camera's water, and on to `next` (the
   * simulation worker's water, which takes the region's own buffers).
   */
  hydrologyPublisher(next: HydrologyWaterPublisher | null): HydrologyWaterPublisher {
    const cameraWater = this.cameraWater;
    return {
      publishHydrology(key: string, region: HydrologyWaterRegion): void {
        cameraWater.setHydrologyRegion(key, next ? copyHydrologyWaterRegion(region) : region);
        next?.publishHydrology(key, region);
      },
      evictHydrology(key: string): void {
        cameraWater.evictHydrologyRegion(key);
        next?.evictHydrology(key);
      },
    };
  }

  dispose(): void {}
}
