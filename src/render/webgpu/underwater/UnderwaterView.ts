import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { WeatherPreset } from "@/src/game/types";
import type { HydrologyWaterRegion, WaterKind } from "@/src/sim/water";
import { PERSON } from "@/src/vehicles/person";
import type { WorldDefinition } from "@/src/world/types";
import type { AtmosphereSnapshot } from "../atmosphere/AtmosphereSystem";
import type { WebGpuQualityProfile } from "../core/QualityProfile";
import type { HydrologyWaterPublisher } from "../water/HydrologySystem";
import type { WaterEnvironmentField } from "../water/WaterEnvironmentField";
import {
  CameraWaterSampler,
  copyHydrologyWaterRegion,
  createCameraWaterSample,
  type CameraWaterSample,
  type CameraWaterTerrainHeight,
} from "./cameraWater";
import { OceanUnderside, type OceanUndersideOptions } from "./OceanUnderside";
import { UnderwaterBubbles } from "./UnderwaterBubbles";
import { UnderwaterAdaptation, underwaterAdaptationTarget, UnderwaterLight } from "./underwaterLight";
import { WaterColumnPass, type WaterColumnCaustics } from "./WaterColumnPass";

export interface UnderwaterViewOptions {
  readonly world: WorldDefinition;
  readonly weather: WeatherPreset;
  /** The renderer's own terrain height (the camera clamp's). */
  readonly terrainHeight: CameraWaterTerrainHeight;
  /** `profile.oceanCascades`: the cascades this tier draws. */
  readonly drawnCascades: number;
  /** The sea's environment field: the province its chemistry follows. */
  readonly waterEnvironment: WaterEnvironmentField | null;
  /** The sea's underside, drawn in the sea's place while the camera is under it (null: none). */
  readonly underside: Omit<OceanUndersideOptions, "scene" | "light"> | null;
}

/**
 * The view from under the water (walking plan, "Underwater view"): built in
 * car sessions only, where the walker can dive. Above the water nothing of it
 * runs but the camera's water sample.
 *
 * Each frame `update` samples the water at the render camera; while the
 * camera is submerged the underwater path is switched on: the water column
 * (`WaterColumnPass`) at the head of the post chain, lit by the camera's own
 * water (`UnderwaterLight`), and under the sea its underside drawn in the
 * sea's place (`OceanUnderside`), and seen by an eye that adapts to the
 * light left at its depth (`UnderwaterAdaptation`). The walker's breath rises in bubbles
 * (`UnderwaterBubbles`) whenever its head is under, whichever side the camera
 * is on.
 */
export class UnderwaterView {
  readonly cameraWater: CameraWaterSampler;
  readonly light: UnderwaterLight;
  readonly underside: OceanUnderside | null;
  readonly bubbles: UnderwaterBubbles | null;
  readonly adaptation = new UnderwaterAdaptation();
  private readonly cameraSample = createCameraWaterSample();
  private readonly water = { kind: "none" as WaterKind, x: 0, z: 0, stillHeight: 0, waterDepth: 0 };
  private columnPass: WaterColumnPass | null = null;
  private columnCamera: Camera | null = null;
  private readonly renderCamera: Camera | null;
  private readonly breather = { x: 0, y: 0, z: 0, under: false, surfaceHeight: 0 };
  private breathing = false;

  constructor(options: UnderwaterViewOptions) {
    this.cameraWater = new CameraWaterSampler(
      options.world,
      options.weather,
      options.terrainHeight,
      options.drawnCascades,
    );
    // At load, behind the load screen: about 0.1 s, never at the first dive.
    this.cameraWater.build();
    this.light = new UnderwaterLight(options.world, options.waterEnvironment);
    const underside = options.underside;
    this.renderCamera = underside?.camera ?? null;
    this.underside = underside
      ? new OceanUnderside({ ...underside, scene: underside.camera.getScene(), light: this.light })
      : null;
    this.bubbles = underside
      ? new UnderwaterBubbles({
        scene: underside.camera.getScene(),
        camera: underside.camera,
        light: this.light,
        pipelineCompiles: underside.pipelineCompiles,
      })
      : null;
  }

  /** The render camera's water as of the last `update`. */
  get camera(): Readonly<CameraWaterSample> {
    return this.cameraSample;
  }

  /** Whether the render camera was under the water at the last `update`. */
  get submerged(): boolean {
    return this.cameraSample.submerged;
  }

  /** The water-column pass, once `buildColumn` has run. */
  get column(): WaterColumnPass | null {
    return this.columnPass;
  }

  /**
   * Builds the water-column pass on the camera's post chain, held out of it
   * (the renderer puts it at the head while the camera is under the water).
   * `samples` is the profile's MSAA, the scene target's while the pass heads
   * the chain; `caustics` the sea's caustic sources and whether the tier lays
   * them.
   */
  buildColumn(
    camera: Camera,
    engine: AbstractEngine,
    samples: number,
    caustics: WaterColumnCaustics | null = null,
  ): WaterColumnPass {
    if (!this.columnPass) {
      this.columnPass = new WaterColumnPass(camera, engine, samples, this.light, caustics);
      this.columnCamera = camera;
    }
    return this.columnPass;
  }

  /**
   * The walker this frame: its feet (world metres) and its head's depth below
   * the local surface (`PersonVisualState.headDepth`), or null with no one on
   * foot. Its breath rises from the head while the head is under.
   */
  setBreather(feet: { readonly x: number; readonly y: number; readonly z: number } | null, headDepth: number): void {
    this.breathing = feet !== null;
    if (!feet) return;
    const breather = this.breather;
    breather.x = feet.x;
    breather.y = feet.y + PERSON.eyeHeight;
    breather.z = feet.z;
    breather.under = headDepth > 0.05;
    breather.surfaceHeight = breather.y + headDepth;
  }

  /**
   * The render camera's world position this frame, at the simulation time the
   * ocean is drawn at; `deltaSeconds` is the frame's, which the eye adapts over.
   */
  update(cameraX: number, cameraY: number, cameraZ: number, timeSeconds: number, deltaSeconds: number): void {
    const sample = this.cameraWater.sample(cameraX, cameraY, cameraZ, timeSeconds, this.cameraSample);
    this.underside?.update(sample.submerged && sample.kind === "sea", timeSeconds);
    const camera = this.renderCamera;
    if (this.bubbles && camera) {
      this.bubbles.update(
        timeSeconds,
        this.breathing ? this.breather : null,
        cameraX - camera.position.x,
        cameraZ - camera.position.z,
      );
    }
    if (!sample.submerged) {
      this.adaptation.reset();
      return;
    }
    const water = this.water;
    water.kind = sample.kind;
    water.x = cameraX;
    water.z = cameraZ;
    water.stillHeight = sample.stillHeight;
    water.waterDepth = sample.waterDepth;
    this.light.setWater(water);
    this.adaptation.update(underwaterAdaptationTarget(this.light.lightRemaining(sample.stillDepth)), deltaSeconds);
    const column = this.columnPass;
    if (column && this.columnCamera) {
      column.setCameraDepth(sample.stillDepth, sample.depth);
      column.setAdaptation(this.adaptation.gain);
      const position = this.columnCamera.position;
      column.setWorld(timeSeconds, cameraX - position.x, cameraZ - position.z, sample.kind === "sea");
    }
  }

  setWeather(weather: WeatherPreset): void {
    this.cameraWater.setWeather(weather);
  }

  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    this.light.setAtmosphere(atmosphere);
    this.underside?.setAtmosphere(atmosphere);
  }

  /** The tier's underwater fields. */
  setProfile(profile: Pick<WebGpuQualityProfile, "underwaterSnellWindow" | "underwaterCaustics">): void {
    this.underside?.setSnellWindow(profile.underwaterSnellWindow);
    this.columnPass?.setCaustics(profile.underwaterCaustics);
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

  dispose(): void {
    this.underside?.dispose();
    this.bubbles?.dispose();
    if (this.columnPass && this.columnCamera) this.columnPass.dispose(this.columnCamera);
    this.columnPass = null;
    this.columnCamera = null;
  }
}
