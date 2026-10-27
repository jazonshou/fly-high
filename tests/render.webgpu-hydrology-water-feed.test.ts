import { Color3, FreeCamera, NullEngine, Scene, Vector2, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  generateHydrology,
  type HydrologyGenerationResult,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";
import type {
  HydrologyGenerationClientLike,
  HydrologyRegionGenerationRequest,
  HydrologyRegionGenerationResult,
} from "../src/render/webgpu/water/HydrologyGenerationClient";
import { HydrologySystem, type HydrologyWaterPublisher } from "../src/render/webgpu/water/HydrologySystem";
import { HydrologyWaterSource, type HydrologyWaterRegion } from "../src/sim/water/hydrologyWater";
import { createWaterSurfaceSample } from "../src/sim/water/types";

/**
 * The renderer's side of the car's lakes and rivers: `HydrologySystem` hands
 * each resident region to the simulation (`setWaterPublisher`) as it lands,
 * under its paging key, and ends each once its crossfade has disposed it.
 * What it hands over is the water it draws: a river's stations are the
 * surface the sim answers.
 */

const ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  skylightIlluminanceNormalized: 1,
  sunIlluminanceNormalized: 0.92,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
};

/** A ramp the tracer finds rivers on (`render.webgpu-hydrology-paging.test.ts`). */
const TERRAIN: HydrologyTerrainSampler = (x, z) => ({
  height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
  moisture: 0.64,
});

const OPTIONS = {
  atmosphere: ATMOSPHERE,
  worldSeed: "water-feed",
  terrainSample: TERRAIN,
  extentMeters: 1_200,
  sourceCandidateSpacingMeters: 300,
  minimumSourceElevationAboveSeaMeters: 0,
  minimumSourceSeparationMeters: 220,
  traceStepMeters: 55,
  maximumTraceSteps: 36,
  minimumRiverPoints: 4,
  maximumRivers: 12,
  maximumLakes: 1,
  paging: { transitionSeconds: 0.5 },
} as const;

class DeferredClient implements HydrologyGenerationClientLike {
  readonly isUsingFallback = false;
  private nextId = 1;
  readonly pending = new Map<number, { request: HydrologyRegionGenerationRequest; onResult: (result: HydrologyRegionGenerationResult) => void }>();

  get queuedCount(): number {
    return this.pending.size;
  }

  request(request: HydrologyRegionGenerationRequest, onResult: (result: HydrologyRegionGenerationResult) => void): number {
    const id = this.nextId++;
    this.pending.set(id, { request, onResult });
    return id;
  }

  cancel(requestId: number): void {
    this.pending.delete(requestId);
  }

  /** Finish the latest request with the region the worker would have generated. */
  completeLatest(): HydrologyGenerationResult {
    const [id, entry] = [...this.pending.entries()].at(-1)!;
    this.pending.delete(id);
    const hydrology = generateHydrology({ ...entry.request.options, worldSeed: OPTIONS.worldSeed, terrainSample: TERRAIN });
    entry.onResult({ hydrology, elapsedMilliseconds: 1, workerGenerated: true });
    return hydrology;
  }

  dispose(): void {}
}

class RecordingPublisher implements HydrologyWaterPublisher {
  readonly log: string[] = [];
  readonly regions = new Map<string, HydrologyWaterRegion>();

  publishHydrology(key: string, region: HydrologyWaterRegion): void {
    // What the simulation client posts must survive the structured clone.
    this.regions.set(key, structuredClone(region));
    this.log.push(`publish ${key}`);
  }

  evictHydrology(key: string): void {
    this.log.push(`evict ${key}`);
  }
}

describe("the hydrology system's water for the simulation", () => {
  it("posts each resident region as it lands and ends each after its crossfade", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("water-feed-camera", new Vector3(0, 300, -400), scene);
    const client = new DeferredClient();
    const system = new HydrologySystem(scene, camera, { ...OPTIONS, generationClient: client });
    const publisher = new RecordingPublisher();
    system.setWaterPublisher(publisher);
    // The region already resident goes at once.
    expect(publisher.log).toEqual(["publish 0:0"]);
    const first = system.hydrology;
    const rivers = first.rivers.filter((river) => river.points.length >= 2).length;
    expect(rivers).toBeGreaterThan(0);
    expect(publisher.regions.get("0:0")!.riverStarts.length - 1).toBe(rivers);

    // A new region lands: posted, while the old one is still drawn.
    const observer = { x: 380, z: 0, velocityX: 0, velocityZ: 0 };
    system.update(10, camera.position, observer);
    client.completeLatest();
    expect(publisher.log).toEqual(["publish 0:0", "publish 1:0"]);
    // Its crossfade done, the old one goes.
    system.update(10.3, camera.position, observer);
    system.update(10.6, camera.position, observer);
    expect(system.getStatistics().residentRegionCount).toBe(1);
    expect(publisher.log).toEqual(["publish 0:0", "publish 1:0", "evict 0:0"]);

    // Stopped, nothing more goes.
    system.setWaterPublisher(null);
    system.update(11, camera.position, { x: 0, z: 0, velocityX: 0, velocityZ: 0 });
    client.completeLatest();
    expect(publisher.log).toHaveLength(3);
    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("hands over the surface it draws: the sim answers a river's own stations", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("water-feed-camera", new Vector3(0, 300, -400), scene);
    const system = new HydrologySystem(scene, camera, { ...OPTIONS, generationClient: new DeferredClient() });
    const publisher = new RecordingPublisher();
    system.setWaterPublisher(publisher);
    const water = new HydrologyWaterSource((x, z) => TERRAIN(x, z).height);
    water.setRegion("0:0", publisher.regions.get("0:0")!);
    const sample = createWaterSurfaceSample();
    let checked = 0;
    for (const river of system.hydrology.rivers) {
      for (let i = 1; i + 1 < river.points.length; i += 1) {
        const station = river.points[i]!;
        // Under the station's surface there is ground; where it stands over it, it is water at that surface.
        if (!(station.y > TERRAIN(station.x, station.z).height)) continue;
        expect(water.sampleWet(station.x, station.z, sample)).toBe(true);
        expect(sample.kind).toBe("river");
        expect(sample.height).toBeGreaterThanOrEqual(station.y - 1e-9);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
