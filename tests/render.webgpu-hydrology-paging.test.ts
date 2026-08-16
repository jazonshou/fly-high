import {
  Color3,
  FreeCamera,
  NullEngine,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  generateHydrology,
  MAX_HYDROLOGY_DIRECTIONAL_TRACE_SAMPLES,
  MAX_HYDROLOGY_HALO_SOURCE_CELLS,
  type HydrologyGenerationResult,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";
import {
  HydrologyGenerationClient,
  type HydrologyGenerationClientLike,
  type HydrologyRegionGenerationRequest,
  type HydrologyRegionGenerationResult,
} from "../src/render/webgpu/water/HydrologyGenerationClient";
import {
  resolveHydrologyPagingConfig,
  selectHydrologyRegion,
} from "../src/render/webgpu/water/HydrologyPaging";
import { HydrologySystem } from "../src/render/webgpu/water/HydrologySystem";
import { isHydrologyWorkerEvent } from "../src/workers/hydrologyProtocol";

const ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  exposure: 1,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
};

const TERRAIN: HydrologyTerrainSampler = (x, z) => ({
  height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
  moisture: 0.64,
});

function abortError(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

class DeferredGenerationClient implements HydrologyGenerationClientLike {
  readonly isUsingFallback = false;
  private nextId = 1;
  private readonly pending = new Map<number, {
    request: HydrologyRegionGenerationRequest;
    onResult: (result: HydrologyRegionGenerationResult) => void;
    onError: (error: Error) => void;
  }>();
  disposed = false;

  get queuedCount(): number {
    return this.pending.size;
  }

  get latest(): { id: number; request: HydrologyRegionGenerationRequest } | null {
    const entry = [...this.pending.entries()].at(-1);
    return entry ? { id: entry[0], request: entry[1].request } : null;
  }

  request(
    request: HydrologyRegionGenerationRequest,
    onResult: (result: HydrologyRegionGenerationResult) => void,
    onError: (error: Error) => void = () => undefined,
  ): number {
    const id = this.nextId++;
    this.pending.set(id, { request, onResult, onError });
    return id;
  }

  cancel(requestId: number): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.onError(abortError());
  }

  complete(requestId: number, hydrology: HydrologyGenerationResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Unknown deferred request ${requestId}`);
    this.pending.delete(requestId);
    pending.onResult({ hydrology, elapsedMilliseconds: 12.5, workerGenerated: true });
  }

  dispose(): void {
    this.disposed = true;
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId);
  }
}

class FakeWorker {
  readonly commands: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  terminated = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function"
      ? listener
      : (event: Event) => listener.handleEvent(event);
    const set = this.listeners.get(type) ?? new Set<(event: never) => void>();
    set.add(callback as (event: never) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }

  postMessage(command: unknown): void {
    this.commands.push(command);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("endless hydrology paging policy", () => {
  it("selects deterministic overlapping regions with bounded velocity look-ahead", () => {
    const config = resolveHydrologyPagingConfig(125, -75, 14_400);
    expect(selectHydrologyRegion({
      x: 125,
      z: -75,
      velocityX: 0,
      velocityZ: 0,
    }, config).key).toBe("0:0");

    const withoutVelocity = selectHydrologyRegion({
      x: 2_000,
      z: -75,
      velocityX: 0,
      velocityZ: 0,
    }, config);
    const ahead = selectHydrologyRegion({
      x: 2_000,
      z: -75,
      velocityX: 200,
      velocityZ: 0,
    }, config);
    expect(withoutVelocity.key).toBe("0:0");
    expect(ahead.key).toBe("1:0");
    expect(ahead.lookAheadX).toBe(config.maximumLookAheadMeters);

    for (let index = -20; index <= 20; index += 1) {
      const observer = {
        x: index * 1_731,
        z: index * -983,
        velocityX: index % 2 === 0 ? 260 : -190,
        velocityZ: 80,
      };
      const selected = selectHydrologyRegion(observer, config);
      expect(Math.abs(observer.x - selected.centerX)).toBeLessThan(config.extentMeters * 0.5);
      expect(Math.abs(observer.z - selected.centerZ)).toBeLessThan(config.extentMeters * 0.5);
      expect(selectHydrologyRegion(observer, config)).toEqual(selected);
    }
  });

  it("rejects paging parameters that could expose a gap", () => {
    expect(() => resolveHydrologyPagingConfig(0, 0, 1_000, {
      spacingMeters: 900,
      maximumLookAheadMeters: 100,
    })).toThrow(/keep the observer inside/);
    expect(() => resolveHydrologyPagingConfig(0, 0, 1_000, {
      spacingMeters: 1_001,
    })).toThrow(/cannot exceed/);
  });

  it("keeps globally anchored rivers identical inside overlapping region interiors", () => {
    const common = {
      worldSeed: "overlap-stability",
      terrainSample: TERRAIN,
      extentMeters: 4_000,
      sourceCandidateSpacingMeters: 500,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 350,
      traceStepMeters: 70,
      maximumTraceSteps: 60,
      minimumRiverPoints: 5,
      maximumRivers: 12,
      maximumLakes: 2,
    } as const;
    const first = generateHydrology({ ...common, centerX: 0, centerZ: 0 });
    const shifted = generateHydrology({ ...common, centerX: 1_000, centerZ: 0 });
    const firstById = new Map(first.rivers.map((river) => [river.id, river]));
    const sharedInterior = shifted.rivers.filter((river) => {
      const source = river.points[0];
      return source
        && source.x > -500
        && source.x < 1_200
        && source.z > -1_400
        && source.z < 1_400;
    });
    expect(sharedInterior.length).toBeGreaterThan(0);
    for (const shiftedRiver of sharedInterior) {
      const firstRiver = firstById.get(shiftedRiver.id);
      expect(firstRiver, `missing stable river ${shiftedRiver.id}`).toBeDefined();
      const stableFirstPoints = firstRiver?.points.filter(
        (point) => point.x > -700 && point.x < 1_350 && Math.abs(point.z) < 1_500,
      );
      const stableShiftedPoints = shiftedRiver.points.filter(
        (point) => point.x > -700 && point.x < 1_350 && Math.abs(point.z) < 1_500,
      );
      expect(stableShiftedPoints).toEqual(stableFirstPoints);
    }
  });

  it("keeps converging rivers and basin ownership stable across overlapping pages", () => {
    const terrainSample: HydrologyTerrainSampler = (x, z) => ({
      height: 100
        + Math.hypot(x, z) * 0.08
        + Math.sin(x * 0.0013) * 4
        + Math.sin(z * 0.0017) * 3,
      moisture: 0.8,
    });
    const common = {
      worldSeed: "claim-counterexample",
      terrainSample,
      extentMeters: 14_400,
      seaLevel: 0,
      sourceCandidateSpacingMeters: 900,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 720,
      traceStepMeters: 90,
      maximumTraceSteps: 180,
      minimumRiverPoints: 5,
      maximumRivers: 10,
      maximumLakes: 5,
      minimumLakeDepthMeters: 0.1,
      minimumLakeRadiusMeters: 20,
    } as const;
    const first = generateHydrology({ ...common, centerX: 0, centerZ: 0 });
    const shifted = generateHydrology({ ...common, centerX: 3_000, centerZ: 0 });
    const inSharedInterior = (x: number, z: number): boolean => (
      x > -3_700 && x < 6_700 && z > -6_000 && z < 6_000
    );
    const sharedRivers = (hydrology: HydrologyGenerationResult) => new Map(
      hydrology.rivers
        .filter((river) => {
          const source = river.points[0];
          return source ? inSharedInterior(source.x, source.z) : false;
        })
        .map((river) => [
          river.id,
          river.points.filter((point) => inSharedInterior(point.x, point.z)),
        ]),
    );
    const firstRivers = sharedRivers(first);
    const shiftedRivers = sharedRivers(shifted);
    expect([...shiftedRivers.keys()].sort()).toEqual([...firstRivers.keys()].sort());
    expect(firstRivers.size).toBeGreaterThan(1);
    for (const [id, points] of firstRivers) expect(shiftedRivers.get(id)).toEqual(points);

    const sharedLakes = (hydrology: HydrologyGenerationResult) => hydrology.lakes
      .filter((lake) => inSharedInterior(lake.centerX, lake.centerZ))
      .sort((a, b) => a.id.localeCompare(b.id));
    const firstLakes = sharedLakes(first);
    expect(firstLakes.length).toBeGreaterThan(0);
    expect(sharedLakes(shifted)).toEqual(firstLakes);
  });

  it("retains a downstream river whose globally owned source is outside the next page", () => {
    const terrainSample: HydrologyTerrainSampler = (x, z) => ({
      height: 1_800 - x * 0.075 + Math.sin(z * 0.002) * 2,
      moisture: 0.7,
    });
    const common = {
      worldSeed: "downstream-source-gap",
      terrainSample,
      extentMeters: 14_400,
      sourceCandidateSpacingMeters: 900,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 720,
      traceStepMeters: 90,
      maximumTraceSteps: 180,
      minimumRiverPoints: 10,
      maximumRivers: 10,
      maximumLakes: 5,
    } as const;
    const oldPage = generateHydrology({ ...common, centerX: 0, centerZ: 0 });
    const nextPage = generateHydrology({ ...common, centerX: 7_200, centerZ: 0 });
    const id = "2370174d:river:-1:0";
    const oldRiver = oldPage.rivers.find((river) => river.id === id);
    const nextRiver = nextPage.rivers.find((river) => river.id === id);
    expect(oldRiver).toBeDefined();
    expect(nextRiver).toBeDefined();
    const inOverlap = (point: { x: number; z: number }): boolean => (
      point.x >= 0 && point.x <= 7_200 && point.z >= -7_200 && point.z <= 7_200
    );
    const oldOverlap = oldRiver?.points.filter(inOverlap);
    const nextOverlap = nextRiver?.points.filter(inOverlap);
    expect(oldOverlap?.length).toBeGreaterThan(100);
    expect(nextOverlap).toEqual(oldOverlap);
    expect(oldOverlap?.some((point) => Math.hypot(point.x - 3_600, point.z) < 300)).toBe(true);
    for (const hydrology of [oldPage, nextPage]) {
      expect(hydrology.statistics.haloSourceCellCount).toBeLessThanOrEqual(
        MAX_HYDROLOGY_HALO_SOURCE_CELLS,
      );
      expect(hydrology.statistics.maximumDirectionalTraceSamples).toBeLessThanOrEqual(
        MAX_HYDROLOGY_DIRECTIONAL_TRACE_SAMPLES,
      );
    }
  });
});

describe("hydrology generation scheduling", () => {
  it("terminates and recreates a worker when active generation is cancelled", () => {
    const workers: FakeWorker[] = [];
    const errors: Error[] = [];
    const client = new HydrologyGenerationClient({
      worldSeed: "worker-cancel",
      workerWorldSeed: "worker-cancel",
      terrainSample: TERRAIN,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.commands[0]).toEqual({
      type: "initialize",
      worldSeed: "worker-cancel",
    });
    const requestId = client.request({
      key: "1:0",
      generation: 1,
      options: { centerX: 600, centerZ: 0, extentMeters: 1_200 },
    }, () => undefined, (error) => errors.push(error));
    expect(workers[0]?.commands[1]).toMatchObject({ type: "generate", requestId, key: "1:0" });

    client.cancel(requestId);
    expect(errors.map((error) => error.name)).toEqual(["AbortError"]);
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.commands[0]).toMatchObject({ type: "initialize" });
    client.dispose();
    expect(workers[1]?.terminated).toBe(true);
  });

  it("keeps custom terrain samplers on a cancellable scheduled fallback", () => {
    const scheduled: Array<() => void> = [];
    const results: HydrologyRegionGenerationResult[] = [];
    const client = new HydrologyGenerationClient({
      worldSeed: "fallback-world",
      terrainSample: TERRAIN,
      fallbackScheduler: (callback) => scheduled.push(callback),
    });
    const requestId = client.request({
      key: "0:0",
      generation: 1,
      options: {
        centerX: 0,
        centerZ: 0,
        extentMeters: 1_200,
        sourceCandidateSpacingMeters: 300,
        maximumTraceSteps: 20,
        minimumSourceElevationAboveSeaMeters: 0,
        minimumRiverPoints: 4,
      },
    }, (result) => results.push(result));
    expect(client.isUsingFallback).toBe(true);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(results).toHaveLength(1);
    expect(results[0]?.workerGenerated).toBe(false);
    expect(results[0]?.hydrology.config.centerX).toBe(0);
    expect(requestId).toBeGreaterThan(0);
    client.dispose();
  });

  it("runs a replacement after cancelling an already scheduled fallback", () => {
    const scheduled: Array<() => void> = [];
    const completedKeys: string[] = [];
    const cancelled: Error[] = [];
    const client = new HydrologyGenerationClient({
      worldSeed: "fallback-requeue",
      terrainSample: TERRAIN,
      fallbackScheduler: (callback) => scheduled.push(callback),
    });
    const firstId = client.request({
      key: "0:0",
      generation: 1,
      options: {
        extentMeters: 1_200,
        sourceCandidateSpacingMeters: 300,
        maximumTraceSteps: 20,
      },
    }, () => completedKeys.push("0:0"), (error) => cancelled.push(error));
    client.cancel(firstId);
    client.request({
      key: "1:0",
      generation: 2,
      options: {
        centerX: 600,
        extentMeters: 1_200,
        sourceCandidateSpacingMeters: 300,
        maximumTraceSteps: 20,
      },
    }, () => completedKeys.push("1:0"));

    expect(scheduled).toHaveLength(1);
    expect(client.queuedCount).toBe(1);
    scheduled[0]?.();
    expect(scheduled).toHaveLength(2);
    scheduled[1]?.();
    expect(cancelled.map((error) => error.name)).toEqual(["AbortError"]);
    expect(completedKeys).toEqual(["1:0"]);
    expect(client.queuedCount).toBe(0);
    client.dispose();
  });

  it("validates structured worker results before accepting them", () => {
    expect(isHydrologyWorkerEvent({
      type: "error",
      requestId: 1,
      generation: 2,
      key: "0:0",
      message: "failed",
    })).toBe(true);
    expect(isHydrologyWorkerEvent({
      type: "region",
      requestId: 1,
      generation: 2,
      key: "0:0",
      elapsedMilliseconds: Number.NaN,
      hydrology: {},
    })).toBe(false);
  });
});

describe("paged Babylon hydrology residency", () => {
  it("retains old water until a region is complete, then crossfades within a two-region bound", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("paged-hydrology-camera", new Vector3(0, 300, -400), scene);
    const client = new DeferredGenerationClient();
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "paged-hydrology",
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
      generationClient: client,
    });
    const initialMesh = system.riverMesh;
    const initialRoot = initialMesh?.parent as TransformNode | null;
    expect(initialRoot).not.toBeNull();
    expect(system.getStatistics()).toMatchObject({
      activeRegionKey: "0:0",
      residentRegionCount: 1,
      generationPending: false,
    });

    const observer = { x: 380, z: 0, velocityX: 0, velocityZ: 0 };
    system.update(10, camera.position, observer);
    const deferred = client.latest;
    expect(deferred?.request.key).toBe("1:0");
    expect(system.riverMesh).toBe(initialMesh);
    expect(system.getStatistics()).toMatchObject({
      activeRegionKey: "0:0",
      residentRegionCount: 1,
      generationPending: true,
    });

    system.setFloatingOrigin(2_048, -4_096);
    expect(initialRoot?.position.asArray()).toEqual([-2_048, 0, 4_096]);
    const hydrology = generateHydrology({
      ...deferred?.request.options,
      worldSeed: "paged-hydrology",
      terrainSample: TERRAIN,
    });
    if (!deferred) throw new Error("Expected a deferred hydrology request");
    client.complete(deferred.id, hydrology);

    const swapped = system.getStatistics();
    expect(swapped).toMatchObject({
      activeRegionKey: "1:0",
      activeRegionCenterX: 600,
      activeRegionCenterZ: 0,
      residentRegionCount: 2,
      generationPending: false,
      pagingRequestCount: 1,
      regionSwapCount: 1,
      lastGenerationUsedWorker: true,
      currentRegionOpacity: 0,
      previousRegionOpacity: 1,
    });
    expect((system.riverMesh?.parent as TransformNode | null)?.position.asArray()).toEqual([
      -2_048,
      0,
      4_096,
    ]);
    expect(initialRoot?.isDisposed()).toBe(false);

    system.update(10.125, camera.position, observer);
    expect(system.getStatistics()).toMatchObject({
      residentRegionCount: 2,
      currentRegionOpacity: 0.5,
      previousRegionOpacity: 1,
    });
    expect(system.riverMesh?.onBeforeBindObservable.hasObservers()).toBe(true);
    const activeMesh = system.riverMesh;
    if (!activeMesh) throw new Error("Expected an active river mesh");
    const material = activeMesh.material as ShaderMaterial;
    const setFloat = vi.spyOn(material, "setFloat");
    activeMesh.onBeforeBindObservable.notifyObservers(activeMesh);
    expect(setFloat).toHaveBeenCalledWith("regionOpacity", 0.5);
    setFloat.mockRestore();

    system.update(10.25, camera.position, observer);
    expect(system.getStatistics()).toMatchObject({
      residentRegionCount: 2,
      currentRegionOpacity: 1,
      previousRegionOpacity: 1,
    });

    system.update(10.375, camera.position, observer);
    expect(system.getStatistics()).toMatchObject({
      residentRegionCount: 2,
      currentRegionOpacity: 1,
      previousRegionOpacity: 0.5,
    });

    system.update(10.6, camera.position, observer);
    expect(system.getStatistics().residentRegionCount).toBe(1);
    expect(initialRoot?.isDisposed()).toBe(true);
    system.dispose();
    system.dispose();
    expect(client.disposed).toBe(true);
    expect(system.getStatistics().disposed).toBe(true);
    scene.dispose();
    engine.dispose();
  });
});
