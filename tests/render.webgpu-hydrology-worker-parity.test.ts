import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Color3, FreeCamera, NullEngine, Scene, Vector2, Vector3 } from "@babylonjs/core";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  hydrologyGenerationConfigData,
  resolveHydrologyConfig,
  type HydrologyGenerationConfig,
  type HydrologyGenerationResult,
} from "../src/render/webgpu/water/HydrologyGeneration";
import { HydrologyGenerationClient } from "../src/render/webgpu/water/HydrologyGenerationClient";
import { hydrologyClimateSamplerFor } from "../src/render/webgpu/water/hydrologyClimate";
import {
  buildAnalyticRegionMeshArrays,
  packHydrologyMeshArrays,
} from "../src/render/webgpu/water/hydrologyMeshArrays";
import {
  resolveHydrologyPagingConfig,
  selectHydrologyRegion,
} from "../src/render/webgpu/water/HydrologyPaging";
import { HydrologySystem } from "../src/render/webgpu/water/HydrologySystem";
import type { ChannelHydrologyGeometry } from "../src/render/webgpu/water/ChannelNetwork";
import type { HydrologyWorkerCommand, HydrologyWorkerEvent } from "../src/workers/hydrologyProtocol";
import { createWorld, sampleTerrain, type WorldDefinition } from "../src/world";

/**
 * Moving generation from the main-thread fallback to the worker must not move
 * a single river or lake.
 *
 * Until 2026-09-29 every analytic-world region was generated on the main
 * thread: the request options carried the system's sampler functions, the
 * worker post threw a DataCloneError, and the client took that for a dead
 * worker. Fixing the post puts the WORKER in charge for the first time since
 * the WebGPU switch, and its sampler is not the renderer's: the worker rebuilds
 * the world from the seed (`createWorld(worldSeed)`) and samples it itself,
 * where the fallback used FlightGame's `(x, z) => sampleTerrain(world, x, z)`.
 * Hydrology that moves is a visible regression, so this is the gate.
 *
 * It drives the REAL worker module (`src/workers/hydrology.worker.ts`) against
 * a stand-in `self` that structured-clones every message both ways, and the
 * REAL client's main-thread path, on the regions a pilot meets first: the one
 * over each spawn airport and its four neighbours. Every world has exactly one
 * airport, so "three spawn airports x two seeds" is six seeds; a seventh is the
 * world the on-device frame pair looks at.
 */

const SEEDS: readonly (string | number)[] = [
  "phase1-perf-baseline",
  "hydrology-parity-north",
  "hydrology-parity-coast",
  "hydrology-parity-hills",
  "aerolith-ridge",
  "seed-0x51a7e",
  // The game's world for `?seed=water9` (the URL seed is read base-36): its
  // lake 3.6 km from the airport is the on-device before/after frame pair's.
  1_953_085_941,
];

type Listener = (event: { data: unknown }) => void;
const workerListeners: Listener[] = [];
const workerPosts: HydrologyWorkerEvent[] = [];

beforeAll(async () => {
  vi.stubGlobal("self", {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") workerListeners.push(listener);
    },
    // Clone WITH the transfer list, as a real worker boundary does: a bad or
    // duplicated transferable throws here exactly as it would in a browser.
    postMessage: (event: unknown, transfer: Transferable[] = []) => {
      workerPosts.push(structuredClone(event, { transfer }) as HydrologyWorkerEvent);
    },
  });
  await import("../src/workers/hydrology.worker");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function sendToWorker(command: HydrologyWorkerCommand): void {
  const cloned = structuredClone(command);
  for (const listener of workerListeners) listener({ data: cloned });
}

type PackedGeometry = {
  rivers: ReturnType<typeof packHydrologyMeshArrays>;
  lakes: ReturnType<typeof packHydrologyMeshArrays>;
};
const LANES = ["positions", "normals", "uvs", "indices", "flowData", "waterData", "waterChemistry"] as const;

/**
 * Byte equality of two packed geometries, lane by lane: same array TYPE (the
 * index width decides the GPU index format), same length, same bytes.
 * `toEqual` over ~10^6 typed-array elements was most of this file's runtime.
 */
function expectSameGeometry(actual: PackedGeometry | undefined, expected: PackedGeometry, label: string): void {
  expect(actual, label).toBeDefined();
  for (const part of ["rivers", "lakes"] as const) {
    const a = actual![part];
    const e = expected[part];
    expect(a === null, `${label} ${part} presence`).toBe(e === null);
    if (!a || !e) continue;
    for (const lane of LANES) {
      const x = a[lane];
      const y = e[lane];
      expect(x.constructor.name, `${label} ${part}.${lane} type`).toBe(y.constructor.name);
      expect(x.length, `${label} ${part}.${lane} length`).toBe(y.length);
      const same = Buffer.from(x.buffer, x.byteOffset, x.byteLength)
        .equals(Buffer.from(y.buffer, y.byteOffset, y.byteLength));
      expect(same, `${label} ${part}.${lane} bytes`).toBe(true);
    }
  }
}

/** What HydrologySystem resolves from FlightRenderer's options (functions included). */
function systemGenerationConfig(world: WorldDefinition): HydrologyGenerationConfig {
  const airport = world.airport!;
  return resolveHydrologyConfig({
    worldSeed: world.seed,
    terrainSample: (x: number, z: number) => sampleTerrain(world, x, z),
    seaLevel: world.seaLevel,
    centerX: airport.centerX,
    centerZ: airport.centerZ,
    climateSample: () => ({ temperature: 0, moisture: 0 }),
  } as Partial<HydrologyGenerationConfig>);
}

function regionsAroundAirport(world: WorldDefinition, config: HydrologyGenerationConfig) {
  const airport = world.airport!;
  const paging = resolveHydrologyPagingConfig(airport.centerX, airport.centerZ, config.extentMeters);
  const step = paging.spacingMeters;
  const observers = [[0, 0], [step, 0], [-step, 0], [0, step], [0, -step]] as const;
  return observers.map(([dx, dz]) => selectHydrologyRegion({
    x: airport.centerX + dx,
    z: airport.centerZ + dz,
    velocityX: 0,
    velocityZ: 0,
  }, paging));
}

describe("hydrology worker parity with the main-thread fallback", () => {
  let featureCount = 0;
  let geometryVertices = 0;

  for (const seed of SEEDS) {
    it(`generates identical water around the spawn airport of "${seed}"`, () => {
      // FlightGame's world and sampler, exactly as the fallback receives them.
      const world = createWorld(seed);
      expect(world.airport, "every analytic world guarantees an airport").not.toBeNull();
      const config = systemGenerationConfig(world);
      const regions = regionsAroundAirport(world, config);
      expect(new Set(regions.map((region) => region.key)).size).toBe(5);

      const fallback = new HydrologyGenerationClient({
        worldSeed: world.seed,
        terrainSample: (x, z) => sampleTerrain(world, x, z),
        fallbackScheduler: (callback) => callback(),
      });
      // The renderer hands the worker `options.world.seed`.
      sendToWorker({ type: "initialize", worldSeed: world.seed });

      regions.forEach((region, index) => {
        // What HydrologySystem.requestRegion now sends: data only.
        const options = {
          ...hydrologyGenerationConfigData(config),
          centerX: region.centerX,
          centerZ: region.centerZ,
        };

        let main: HydrologyGenerationResult | null = null;
        fallback.request(
          { key: region.key, generation: index + 1, options },
          (result) => { main = result.hydrology; },
          (error) => { throw error; },
        );

        workerPosts.length = 0;
        sendToWorker({
          type: "generate", requestId: index + 1, generation: index + 1, key: region.key, options,
          buildGeometry: true,
        });
        const event = workerPosts.at(-1);
        expect(event?.type, `worker failed on region ${region.key}`).toBe("region");
        const region_ = event as Extract<HydrologyWorkerEvent, { type: "region" }>;
        const worker = region_.hydrology;

        expect(main).not.toBeNull();
        expect(worker).toEqual(main);
        featureCount += worker.rivers.length + worker.lakes.length;

        // P2b gate: the worker-built vertex arrays equal the main thread's,
        // built from the same hydrology with the renderer's ground sampler
        // (FlightGame's world) and the shared climate sampler.
        const mainArrays = buildAnalyticRegionMeshArrays(
          main!,
          (x, z) => sampleTerrain(world, x, z).height,
          hydrologyClimateSamplerFor(world),
          config.seaLevel,
        );
        expectSameGeometry(region_.geometry, {
          rivers: packHydrologyMeshArrays(mainArrays.rivers),
          lakes: packHydrologyMeshArrays(mainArrays.lakes),
        }, `${seed} ${region.key}`);
        geometryVertices += (region_.geometry?.lakes?.positions.length ?? 0) / 3
          + (region_.geometry?.rivers?.positions.length ?? 0) / 3;
      });
      fallback.dispose();
    }, 60_000);
  }

  it("compared real water, not empty regions", () => {
    // Non-vacuity: equal empty results would prove nothing about placement.
    // Measured 2026-09-29: 14 lakes over the 30 regions above, and no rivers.
    expect(featureCount).toBeGreaterThan(0);
    // And the geometry comparison met real vertices, not empty meshes.
    expect(geometryVertices).toBeGreaterThan(10_000);
  });

  it("traces identical rivers when the config forces the tracer to run", () => {
    // The production config yields no rivers near these airports (0 of 125
    // regions searched on five seeds; `HydrologyGeneration.ts` records the
    // same over 5,184 km2), so the airport regions above only compare lakes.
    // The tracer is the half most sensitive to the sampler, so relax the
    // river thresholds (the same data reaches both paths) and compare it too.
    const relaxed = {
      maximumRiverGrade: 0.5,
      minimumSourceElevationAboveSeaMeters: 10,
      minimumRiverPoints: 4,
      minimumDownhillDropMeters: 0.01,
    } as const;
    let riverPoints = 0;
    for (const [index, seed] of ["phase1-perf-baseline", "hydrology-parity-north", "seed-0x51a7e"].entries()) {
      const world = createWorld(seed);
      const options = {
        ...hydrologyGenerationConfigData({ ...systemGenerationConfig(world), ...relaxed }),
      };
      let main: HydrologyGenerationResult | null = null;
      const fallback = new HydrologyGenerationClient({
        worldSeed: world.seed,
        terrainSample: (x, z) => sampleTerrain(world, x, z),
        fallbackScheduler: (callback) => callback(),
      });
      fallback.request({ key: "0:0", generation: 1, options }, (result) => { main = result.hydrology; });
      fallback.dispose();
      sendToWorker({ type: "initialize", worldSeed: world.seed });
      workerPosts.length = 0;
      sendToWorker({
        type: "generate", requestId: 100 + index, generation: 1, key: "0:0", options, buildGeometry: true,
      });
      const event = workerPosts.at(-1) as Extract<HydrologyWorkerEvent, { type: "region" }>;
      expect(event?.type).toBe("region");
      expect(event.hydrology).toEqual(main);
      riverPoints += event.hydrology.rivers.reduce((sum, river) => sum + river.points.length, 0);
      const mainArrays = buildAnalyticRegionMeshArrays(
        main!,
        (x, z) => sampleTerrain(world, x, z).height,
        hydrologyClimateSamplerFor(world),
        systemGenerationConfig(world).seaLevel,
      );
      expect(event.geometry?.rivers, `${seed}: river ribbons were built`).not.toBeNull();
      expectSameGeometry(event.geometry, {
        rivers: packHydrologyMeshArrays(mainArrays.rivers),
        lakes: packHydrologyMeshArrays(mainArrays.lakes),
      }, `${seed} rivers`);
    }
    // Measured: 4 rivers, 49 points over the three regions.
    expect(riverPoints).toBeGreaterThan(0);
  }, 60_000);
});

/** A worker stand-in that records (cloned) commands and answers nothing. */
function recordingWorker(commands: HydrologyWorkerCommand[]): Worker {
  return {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    postMessage: (command: HydrologyWorkerCommand) => {
      commands.push(structuredClone(command));
    },
    terminate: () => undefined,
  } as unknown as Worker;
}

describe("a forced world's landforms reach the hydrology worker", () => {
  // Sand seas forced on the low ground (screenshots, a chosen start). The
  // worker rebuilds the world from what `initialize` carries, so without the
  // landforms it would trace water across ground the main thread has made
  // into a sand sea.
  const FORCED = createWorld("dune-lab", { landforms: { dunes: true }, climateProvince: "high-desert" });

  it("posts the landforms with the seed and the province", () => {
    const commands: HydrologyWorkerCommand[] = [];
    const client = new HydrologyGenerationClient({
      worldSeed: FORCED.seed,
      workerWorldSeed: FORCED.seed,
      workerClimateProvince: FORCED.climateProvince ?? null,
      workerLandforms: FORCED.landforms ?? null,
      terrainSample: (x, z) => sampleTerrain(FORCED, x, z),
      workerFactory: () => recordingWorker(commands),
    });
    client.dispose();
    expect(commands[0]).toEqual({
      type: "initialize",
      worldSeed: FORCED.seed,
      climateProvince: { temperatureOffset: 0, dryness: 0.5 },
      landforms: { dunes: true, volcanic: false },
    });
  });

  it("is handed on by HydrologySystem, as FlightRenderer passes it", async () => {
    const commands: HydrologyWorkerCommand[] = [];
    vi.stubGlobal("Worker", class {
      constructor() {
        return recordingWorker(commands);
      }
    });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("forced-hydrology-camera", new Vector3(0, 300, -400), scene);
    const abort = new AbortController();
    try {
      const creating = HydrologySystem.create(scene, camera, {
        atmosphere: ATMOSPHERE,
        worldSeed: FORCED.seed,
        terrainSample: (x, z) => sampleTerrain(FORCED, x, z),
        workerWorldSeed: FORCED.seed,
        workerClimateProvince: FORCED.climateProvince ?? null,
        workerLandforms: FORCED.landforms ?? null,
        seaLevel: FORCED.seaLevel,
        centerX: FORCED.airport!.centerX,
        centerZ: FORCED.airport!.centerZ,
      }, abort.signal);
      // The worker is started, and initialised, in the constructor.
      expect(commands[0]).toMatchObject({
        type: "initialize",
        landforms: { dunes: true, volcanic: false },
      });
      // The option is plumbing, not generation data: it must not ride along.
      expect(commands[1]).toMatchObject({ type: "generate" });
      expect(JSON.stringify(commands[1])).not.toContain("workerLandforms");
      abort.abort();
      await expect(creating).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("self", { addEventListener: () => undefined, postMessage: () => undefined });
      scene.dispose();
      engine.dispose();
    }
  });

  it("generates the main thread's water on the forced world, sand seas included", () => {
    const airport = FORCED.airport!;
    // East of the runway, where the sand sea holds an interdune hollow and a
    // spring that only the sand-sea gate removes; relaxed river thresholds so
    // the tracer runs.
    const options = {
      ...hydrologyGenerationConfigData({
        ...systemGenerationConfig(FORCED),
        maximumRiverGrade: 0.5,
        minimumSourceElevationAboveSeaMeters: 10,
        minimumRiverPoints: 4,
        minimumDownhillDropMeters: 0.01,
      }),
      centerX: airport.centerX + 14_400,
      centerZ: airport.centerZ,
    };
    let main: HydrologyGenerationResult | null = null;
    const fallback = new HydrologyGenerationClient({
      worldSeed: FORCED.seed,
      terrainSample: (x, z) => sampleTerrain(FORCED, x, z),
      fallbackScheduler: (callback) => callback(),
    });
    fallback.request({ key: "1:0", generation: 1, options }, (result) => { main = result.hydrology; });
    fallback.dispose();
    expect(main).not.toBeNull();

    const generate = (requestId: number): HydrologyGenerationResult => {
      workerPosts.length = 0;
      sendToWorker({ type: "generate", requestId, generation: 1, key: "1:0", options });
      const event = workerPosts.at(-1);
      expect(event?.type).toBe("region");
      return (event as Extract<HydrologyWorkerEvent, { type: "region" }>).hydrology;
    };
    sendToWorker({
      type: "initialize",
      worldSeed: FORCED.seed,
      climateProvince: FORCED.climateProvince!,
      landforms: FORCED.landforms!,
    });
    expect(generate(400)).toEqual(main);
    // Without the landforms the worker's world is another world.
    sendToWorker({ type: "initialize", worldSeed: FORCED.seed, climateProvince: FORCED.climateProvince! });
    expect(generate(401)).not.toEqual(main);
  });
});

describe("eroded worlds keep their graph hydrology", () => {
  it("constructs no generation client or worker for an eroded world", async () => {
    const world = createWorld("hydrology-parity-eroded", { worldEvolution: "eroded" });
    expect(world.worldEvolution).toBe("eroded");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("eroded-hydrology-camera", new Vector3(0, 300, -400), scene);
    let workerConstructions = 0;
    vi.stubGlobal("Worker", class {
      constructor() {
        workerConstructions += 1;
        throw new Error("an eroded world must not construct the legacy hydrology worker");
      }
    });
    // FlightRenderer passes `graphHydrology` exactly when the evolution result
    // is eroded; the geometry's content is irrelevant to this assertion.
    const graphHydrology: ChannelHydrologyGeometry = Object.freeze({
      rivers: Object.freeze([]),
      lakes: Object.freeze([]),
    });
    try {
      const system = await HydrologySystem.create(scene, camera, {
        atmosphere: ATMOSPHERE,
        worldSeed: world.seed,
        terrainSample: () => {
          throw new Error("graph hydrology must not trace the analytic terrain");
        },
        workerWorldSeed: world.seed,
        seaLevel: world.seaLevel,
        graphHydrology,
      });
      system.update(10, camera.position, { x: 40_000, z: -30_000, velocityX: 900, velocityZ: 0 });
      expect(workerConstructions).toBe(0);
      expect(system.getStatistics()).toMatchObject({
        pagingRequestCount: 0,
        queuedGenerationCount: 0,
        usingMainThreadFallback: false,
      });
      system.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("self", { addEventListener: () => undefined, postMessage: () => undefined });
      scene.dispose();
      engine.dispose();
    }
  });
});

/** The paging suite's fixture: HydrologySystem reads the sun and sky from it. */
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
