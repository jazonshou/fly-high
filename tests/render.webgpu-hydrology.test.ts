import {
  Color3,
  FreeCamera,
  NullEngine,
  Scene,
  TransformNode,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
  HydrologySystem,
} from "../src/render/webgpu/water/HydrologySystem";
import {
  generateHydrology,
  resolveHydrologyConfig,
  traceDownhillPath,
  type HydrologyTerrainSampler,
} from "../src/render/webgpu/water/HydrologyGeneration";

const ATMOSPHERE: AtmosphereSnapshot = {
  sunDirection: new Vector3(-0.36, 0.82, 0.44).normalize(),
  sunColor: new Color3(1, 0.96, 0.88),
  sunIntensity: 4.8,
  skyZenith: new Color3(0.1, 0.36, 0.78),
  skyHorizon: new Color3(0.58, 0.77, 0.96),
  ambientColor: new Color3(0.18, 0.27, 0.42),
  sunIlluminanceNormalized: 0.92,
  sunAngularRadiusRadians: 0.004675,
  cloudCoverage: 0.32,
  humidity: 0.62,
  windSpeed: 9,
  windDirection: new Vector2(0.93, 0.37).normalize(),
};

function slopedTerrain(): HydrologyTerrainSampler {
  return (x, z) => ({
    height: 520 - x * 0.075 + Math.sin(z * 0.004) * 3,
    moisture: 0.64,
  });
}

function bowlTerrain(): HydrologyTerrainSampler {
  return (x, z) => ({
    height: 100 + (x * x + z * z) * 0.002,
    moisture: 0.78,
  });
}

describe("pure deterministic downhill hydrology", () => {
  it("traces strictly downhill to a boundary with a hard sample bound", () => {
    const trace = traceDownhillPath({
      worldSeed: "downhill-plane",
      terrainSample: slopedTerrain(),
      startX: -420,
      startZ: 35,
      bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
      seaLevel: 0,
      stepMeters: 50,
      angularSamples: 16,
      maximumSteps: 30,
      minimumDropMeters: 0.02,
    });
    expect(trace.termination).toBe("boundary");
    expect(trace.points.length).toBeGreaterThan(10);
    expect(trace.points.length).toBeLessThanOrEqual(30);
    expect(trace.terrainSampleCount).toBeLessThanOrEqual(1 + 30 * 16);
    for (let index = 1; index < trace.points.length; index += 1) {
      const previous = trace.points[index - 1];
      const current = trace.points[index];
      expect(current?.terrainHeight).toBeLessThan(previous?.terrainHeight ?? Number.NEGATIVE_INFINITY);
    }
  });

  it("recognizes an enclosed local basin without cycling", () => {
    const trace = traceDownhillPath({
      worldSeed: "bowl-trace",
      terrainSample: bowlTerrain(),
      startX: 360,
      startZ: 40,
      bounds: { minX: -600, maxX: 600, minZ: -600, maxZ: 600 },
      seaLevel: 0,
      stepMeters: 45,
      angularSamples: 24,
      maximumSteps: 30,
      minimumDropMeters: 0.02,
    });
    expect(trace.termination).toBe("basin");
    expect(trace.points.length).toBeGreaterThan(5);
    const basin = trace.points.at(-1);
    expect(Math.hypot(basin?.x ?? 1_000, basin?.z ?? 1_000)).toBeLessThan(50);
    expect(new Set(trace.points.map((point) => `${point.x}:${point.z}`)).size).toBe(
      trace.points.length,
    );
  });

  it("generates seed-stable bounded splines while another seed changes headwaters", () => {
    const options = {
      worldSeed: "regional-hydrology-a",
      terrainSample: slopedTerrain(),
      centerX: 0,
      centerZ: 0,
      extentMeters: 4_000,
      seaLevel: 0,
      sourceCandidateSpacingMeters: 500,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 350,
      traceStepMeters: 70,
      maximumTraceSteps: 80,
      minimumRiverPoints: 6,
      maximumRivers: 5,
      maximumLakes: 2,
    } as const;
    const first = generateHydrology(options);
    const repeated = generateHydrology(options);
    const changed = generateHydrology({ ...options, worldSeed: "regional-hydrology-b" });

    expect(repeated).toEqual(first);
    expect(first.rivers.length).toBeGreaterThan(0);
    expect(first.rivers.length).toBeLessThanOrEqual(
      first.statistics.haloSourceCellCount,
    );
    expect(changed.rivers).not.toEqual(first.rivers);
    expect(first.statistics.terrainSampleCount).toBeLessThan(100_000);
    expect(first.statistics.splinePointCount).toBeGreaterThan(first.statistics.rawRiverPointCount);
    for (const river of first.rivers) {
      expect(river.points.length).toBeGreaterThanOrEqual(options.minimumRiverPoints);
      expect(river.lengthMeters).toBeGreaterThan(0);
      for (let index = 0; index < river.points.length; index += 1) {
        const point = river.points[index];
        // One source-owned neighbor is retained outside each crop edge so the
        // water ribbon actually crosses the region boundary.
        expect(point?.x).toBeGreaterThanOrEqual(first.bounds.minX - options.traceStepMeters);
        expect(point?.x).toBeLessThanOrEqual(first.bounds.maxX + options.traceStepMeters);
        expect(point?.z).toBeGreaterThanOrEqual(first.bounds.minZ - options.traceStepMeters);
        expect(point?.z).toBeLessThanOrEqual(first.bounds.maxZ + options.traceStepMeters);
        expect(point?.widthMeters).toBeGreaterThan(0);
        expect(point?.flowSpeedMetersPerSecond).toBeGreaterThan(0);
        if (index > 0) {
          expect(point?.y).toBeLessThan(river.points[index - 1]?.y ?? Number.NEGATIVE_INFINITY);
        }
      }
    }
  });

  it("emits no ribbon down terrain steeper than the maximum grade (R-24)", () => {
    // 24% grade everywhere — every trace descends it, and every ribbon a
    // pre-R-24 build would emit lies on a slope the maximum grade forbids.
    const steepTerrain: HydrologyTerrainSampler = (x, z) => ({
      height: 900 - x * 0.24 + Math.sin(z * 0.004) * 3,
      moisture: 0.64,
    });
    const options = {
      worldSeed: "r24-grade-cull",
      terrainSample: steepTerrain,
      centerX: 0,
      centerZ: 0,
      extentMeters: 4_000,
      seaLevel: 0,
      sourceCandidateSpacingMeters: 500,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 350,
      traceStepMeters: 70,
      maximumTraceSteps: 80,
      minimumRiverPoints: 6,
      maximumRivers: 5,
      maximumLakes: 2,
    } as const;
    const culled = generateHydrology(options);
    expect(culled.rivers.length).toBe(0);
    // The cull is the grade limit, not the terrain: the same options with the
    // limit lifted emit ribbons again.
    const lifted = generateHydrology({ ...options, maximumRiverGrade: 1 });
    expect(lifted.rivers.length).toBeGreaterThan(0);
  });

  it("emits finite lake polygons only for enclosed bowls", () => {
    const result = generateHydrology({
      worldSeed: "basin-lakes",
      terrainSample: bowlTerrain(),
      centerX: 0,
      centerZ: 0,
      extentMeters: 1_600,
      seaLevel: 0,
      sourceCandidateSpacingMeters: 260,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 250,
      traceStepMeters: 55,
      traceAngularSamples: 24,
      maximumTraceSteps: 48,
      minimumRiverPoints: 5,
      maximumRivers: 4,
      maximumLakes: 3,
      minimumLakeDepthMeters: 1,
      maximumLakeDepthMeters: 12,
      minimumLakeRadiusMeters: 25,
      maximumLakeRadiusMeters: 420,
      lakeBoundarySegments: 24,
    });
    expect(result.lakes.length).toBeGreaterThan(0);
    expect(result.lakes.length).toBeLessThanOrEqual(
      result.statistics.haloSourceCellCount,
    );
    for (const lake of result.lakes) {
      expect(lake.boundary).toHaveLength(24);
      expect(lake.maximumDepthMeters).toBeGreaterThanOrEqual(1);
      expect(lake.maximumDepthMeters).toBeLessThanOrEqual(12);
      expect(lake.radiusMeters).toBeGreaterThanOrEqual(25);
      expect(lake.areaSquareMeters).toBeGreaterThan(0);
      expect(lake.boundary.every((point) => Number.isFinite(point.x + point.y + point.z))).toBe(true);
      expect(new Set(lake.boundary.map((point) => point.y))).toEqual(new Set([lake.surfaceHeight]));
    }
  });

  it("returns no water for flat dry land and rejects unsafe generation bounds", () => {
    const flat = generateHydrology({
      worldSeed: "flat",
      terrainSample: () => ({ height: 200, moisture: 0.1 }),
      extentMeters: 2_000,
      sourceCandidateSpacingMeters: 400,
      maximumTraceSteps: 20,
      maximumRivers: 5,
    });
    expect(flat.rivers).toEqual([]);
    expect(flat.lakes).toEqual([]);
    expect(() => resolveHydrologyConfig({
      extentMeters: 50_000,
      sourceCandidateSpacingMeters: 100,
    })).toThrow(/40 cells/);
    expect(() => generateHydrology({
      worldSeed: "invalid-terrain",
      terrainSample: () => ({ height: Number.NaN }),
    })).toThrow(/invalid height/);
    expect(() => generateHydrology({
      worldSeed: "unsafe-halo-work",
      terrainSample: () => ({ height: 200, moisture: 0.5 }),
      extentMeters: 1_200,
      sourceCandidateSpacingMeters: 300,
      maximumRivers: 10,
    })).toThrow(/bounded generation work budget/);
  });
});

describe("Babylon WebGPU hydrology presentation", () => {
  it("uses flowing physical-water WGSL rather than WebGL shaders", () => {
    expect(HYDROLOGY_WATER_VERTEX_WGSL).toContain("flowDirection");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).toContain("hydrologyWorldOrigin");
    expect(HYDROLOGY_WATER_VERTEX_WGSL).toContain("windPhase");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("fresnelSchlick");
    // 2-9: the shared solid-angle sun lobe replaced the split GGX pair.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("fn sunSpecular");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("shoreFoam");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("uniform regionOpacity");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain(
      "alpha * clamp(uniforms.regionOpacity",
    );
    expect(`${HYDROLOGY_WATER_VERTEX_WGSL}${HYDROLOGY_WATER_FRAGMENT_WGSL}`).not.toMatch(
      /gl_FragColor|#version|THREE\./,
    );
  });

  it("builds bounded combined meshes, rebases, reports statistics, and disposes idempotently", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("hydrology-test-camera", new Vector3(0, 300, -600), scene);
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "hydrology-system",
      terrainSample: slopedTerrain(),
      extentMeters: 2_400,
      sourceCandidateSpacingMeters: 400,
      minimumSourceElevationAboveSeaMeters: 0,
      minimumSourceSeparationMeters: 300,
      traceStepMeters: 60,
      maximumTraceSteps: 60,
      minimumRiverPoints: 5,
      maximumRivers: 4,
      maximumLakes: 1,
    });
    const statistics = system.getStatistics();
    expect(statistics.riverCount).toBeGreaterThan(0);
    expect(statistics.meshCount).toBeGreaterThan(0);
    expect(statistics.meshCount).toBeLessThanOrEqual(2);
    expect(statistics.vertexCount).toBeGreaterThan(0);
    expect(statistics.triangleCount).toBeGreaterThan(0);
    expect(statistics.disposed).toBe(false);

    system.setFloatingOrigin(1_024, -2_048);
    expect((system.riverMesh?.parent as TransformNode | null)?.position.asArray()).toEqual([
      -1_024,
      0,
      2_048,
    ]);
    expect(() => system.update(12.5, new Vector3(10, 20, 30))).not.toThrow();
    expect(() => system.setFloatingOrigin(Number.NaN, 0)).toThrow(/finite/);
    system.setAtmosphere({ ...ATMOSPHERE, windSpeed: 18, cloudCoverage: 0.75 });
    system.dispose();
    system.dispose();
    expect(system.getStatistics().disposed).toBe(true);
    scene.dispose();
    engine.dispose();
  });
});
