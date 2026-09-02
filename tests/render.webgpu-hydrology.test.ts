import { createHash } from "node:crypto";
import {
  Color3,
  FreeCamera,
  Mesh,
  NullEngine,
  Scene,
  TransformNode,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { AtmosphereSnapshot } from "../src/render/webgpu/atmosphere/AtmosphereSystem";
import {
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  validateTerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  ChannelNetwork,
  channelGraphToHydrologyGeometry,
} from "../src/render/webgpu/water/ChannelNetwork";
import {
  HYDROLOGY_WATER_FRAGMENT_WGSL,
  HYDROLOGY_WATER_VERTEX_WGSL,
  HydrologySystem,
  buildGraphHydrologyMeshArrays,
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
  moonDirection: new Vector3(0, -1, 0),
  moonIlluminanceLux: 0,
  moonIlluminatedFraction: 0,
  adaptedLuminanceCdM2: 6_000,
  sceneKeyLuminanceCdM2: 1_000,
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

  it("lets inland roughness vary instead of sitting on its cap (wave R fix 2)", () => {
    // Rivers and lakes arrived at EXACTLY 0.28 on every pixel: the capillary
    // tail alone exceeded the cap, so the variance the Toksvig fold exists to
    // express had nowhere to go and every surface rendered with one micro-facet
    // distribution. The cap moves to 0.45 (still glossier than the open sea's
    // 0.5) and the tail becomes a field driven by the resolved wave slope.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).not.toContain("0.28,");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("0.45,");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("length(fragmentGradient),");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("capillary.unresolvedMeanSquareSlope");
    // wave R fix 7: the glint jitter reaches the sun lobe only.
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("sunSpecular(glintNormal");
    expect(HYDROLOGY_WATER_FRAGMENT_WGSL).toContain("reflect(-view, normal)");
  });

  it("takes its wind speed from the world, not the cloud layer (wave R fix 8)", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("hydrology-wind-camera", new Vector3(0, 300, -600), scene);
    const speeds: number[] = [];
    const capture = (system: HydrologySystem) => {
      const material = (system as unknown as {
        material: { setFloat(name: string, value: number): void };
      }).material;
      const original = material.setFloat.bind(material);
      material.setFloat = (name: string, value: number) => {
        if (name === "windSpeed") speeds.push(value);
        original(name, value);
      };
    };
    // The atmosphere snapshot's windSpeed is a cloud-layer number and can
    // disagree with the world's prevailing wind by 3x; the world wins.
    const worldWind = ATMOSPHERE.windSpeed * 3 + 1;
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: 4_242,
      terrainSample: slopedTerrain(),
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
      windDirectionRadians: 0.6,
      windSpeedMetersPerSecond: worldWind,
    });
    capture(system);
    system.setAtmosphere(ATMOSPHERE);
    expect(speeds.at(-1)).toBe(worldWind);

    // Absent the option (every pre-wave-R caller and test) the atmosphere is
    // still the fallback, so nothing that did not opt in changes behaviour.
    const fallback = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: 4_242,
      terrainSample: slopedTerrain(),
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
    });
    capture(fallback);
    fallback.setAtmosphere(ATMOSPHERE);
    expect(speeds.at(-1)).toBe(ATMOSPHERE.windSpeed);

    system.dispose();
    fallback.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("W-5 graph mode: arc-length lanes and ear-clipped lake interiors with the 5-12 attribute semantics", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("graph-mesh-camera", new Vector3(0, 300, -600), scene);
    const spill = 91.5;
    // Concave staircase-L shoreline, counter-clockwise, all at the spill.
    const ringXZ = [
      [0, 0], [1_200, 0], [1_200, 450], [450, 450], [450, 1_200], [0, 1_200],
    ] as const;
    const lakeArea = 877_500; // shoelace of the L above
    const river = {
      id: "channel:0",
      termination: "confluence" as const,
      lengthMeters: 240,
      maximumWidthMeters: 9,
      points: [
        {
          x: -3_120, y: 18, z: -2_000,
          widthMeters: 5,
          flowSpeedMetersPerSecond: 1.2,
          estimatedDischargeCubicMetersPerSecond: 8,
        },
        {
          x: -3_000, y: 14, z: -2_000,
          widthMeters: 7,
          flowSpeedMetersPerSecond: 1.5,
          estimatedDischargeCubicMetersPerSecond: 16,
        },
        {
          x: -2_880, y: 10, z: -2_000,
          widthMeters: 9,
          flowSpeedMetersPerSecond: 1.8,
          estimatedDischargeCubicMetersPerSecond: 28,
        },
      ],
    };
    const lake = {
      id: "lake:4",
      centerX: 550,
      centerZ: 550,
      surfaceHeight: spill,
      maximumDepthMeters: 6,
      radiusMeters: 851,
      areaSquareMeters: lakeArea,
      flowDirection: [1, 0] as const,
      boundary: ringXZ.map(([x, z]) => ({ x, y: spill, z })),
    };
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "graph-mesh-semantics",
      terrainSample: () => {
        throw new Error("graph mode must not sample analytic terrain");
      },
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
      graphHydrology: { rivers: [river], lakes: [lake] },
    });

    // --- river lanes ---
    const riverMesh = system.riverMesh!;
    expect(riverMesh).not.toBeNull();
    const riverPositions = Array.from(riverMesh.getVerticesData("position")!);
    const riverUvs = Array.from(riverMesh.getVerticesData("uv")!);
    const riverFlow = Array.from(riverMesh.getVerticesData("flowData")!);
    const riverWater = Array.from(riverMesh.getVerticesData("waterData")!);
    const riverVertexCount = riverPositions.length / 3;
    expect(riverVertexCount % 5).toBe(0);
    const stationCount = riverVertexCount / 5;
    // Resampled: widths 5-9 m clamp station spacing to 32 m, so each 120 m
    // segment carries 4 sub-segments -> 9 stations, not the 3 source nodes.
    expect(stationCount).toBe(9);
    for (let station = 0; station < stationCount; station += 1) {
      // waterData.z is the |lane| shore coordinate: [1, 0.5, 0, 0.5, 1].
      const shore = [0, 1, 2, 3, 4].map((lane) => riverWater[(station * 5 + lane) * 4 + 2]);
      expect(shore).toEqual([1, 0.5, 0, 0.5, 1]);
      // uv.y is the lane coordinate; uv.x the world-anchored arc parameter.
      const laneV = [0, 1, 2, 3, 4].map((lane) => riverUvs[(station * 5 + lane) * 2 + 1]);
      expect(laneV).toEqual([0, 0.25, 0.5, 0.75, 1]);
      // Whitewater stays clamped and the flow tangent is unit length.
      const whitewater = riverFlow[station * 5 * 4 + 3]!;
      expect(whitewater).toBeGreaterThanOrEqual(0);
      expect(whitewater).toBeLessThanOrEqual(1);
      expect(Math.hypot(riverFlow[station * 5 * 4]!, riverFlow[station * 5 * 4 + 1]!))
        .toBeCloseTo(1, 5);
    }
    // uv.x = accumulated true arc length / 16, monotone from head to mouth.
    const centerLaneU = Array.from(
      { length: stationCount },
      (_, station) => riverUvs[(station * 5 + 2) * 2]!,
    );
    expect(centerLaneU[0]).toBe(0);
    expect(centerLaneU.at(-1)).toBeCloseTo(240 / 16, 5);
    for (let index = 1; index < centerLaneU.length; index += 1) {
      expect(centerLaneU[index]!).toBeGreaterThan(centerLaneU[index - 1]!);
    }
    // Stations interpolate the exported hydraulics: the head and mouth carry
    // the node speeds verbatim, interior stations stay inside the range.
    expect(riverFlow[2 * 4 + 2]).toBeCloseTo(1.2, 6);
    expect(riverFlow[((stationCount - 1) * 5 + 2) * 4 + 2]).toBeCloseTo(1.8, 6);

    // --- lake interior ---
    const lakeMesh = system.lakeMesh!;
    expect(lakeMesh).not.toBeNull();
    const lakePositions = Array.from(lakeMesh.getVerticesData("position")!);
    const lakeWater = Array.from(lakeMesh.getVerticesData("waterData")!);
    const lakeIndices = Array.from(lakeMesh.getIndices()!);
    const lakeVertexCount = lakePositions.length / 3;
    expect(lakeVertexCount).toBeGreaterThan(ringXZ.length);
    // Every vertex sits EXACTLY at the spill elevation (the 0.05 m planar
    // reflection matcher breaks on any averaging).
    for (let index = 0; index < lakeVertexCount; index += 1) {
      expect(lakePositions[index * 3 + 1]).toBe(spill);
    }
    // Boundary vertices carry shore proximity 1, the interior decays toward
    // 0, and lakeFactor (waterData.y) is 1 everywhere.
    for (let index = 0; index < ringXZ.length; index += 1) {
      expect(lakeWater[index * 4 + 2]).toBe(1);
    }
    const interiorShore = Array.from(
      { length: lakeVertexCount - ringXZ.length },
      (_, offset) => lakeWater[(ringXZ.length + offset) * 4 + 2]!,
    );
    expect(interiorShore.length).toBeGreaterThan(0);
    // The L's arms are 450 m wide, so the deepest interior vertex sits
    // ~225 m from shore: shore = 1 - 225 / 250 = 0.1. The fan's degenerate
    // constant field is gone; a real gradient reaches (near) zero.
    expect(Math.min(...interiorShore)).toBeLessThanOrEqual(0.11);
    for (let index = 0; index < lakeVertexCount; index += 1) {
      expect(lakeWater[index * 4 + 1]).toBe(1);
      expect(lakeWater[index * 4 + 2]).toBeGreaterThanOrEqual(0);
      expect(lakeWater[index * 4 + 2]).toBeLessThanOrEqual(1);
    }
    // The ear-clipped, refined triangulation covers the concave polygon
    // exactly: triangle areas sum to the shoelace area, with uniform winding
    // (matching the legacy fan's orientation for a CCW ring).
    let coveredArea = 0;
    for (let index = 0; index < lakeIndices.length; index += 3) {
      const [a, b, c] = [lakeIndices[index]!, lakeIndices[index + 1]!, lakeIndices[index + 2]!];
      const cross = (lakePositions[b * 3]! - lakePositions[a * 3]!)
          * (lakePositions[c * 3 + 2]! - lakePositions[a * 3 + 2]!)
        - (lakePositions[b * 3 + 2]! - lakePositions[a * 3 + 2]!)
          * (lakePositions[c * 3]! - lakePositions[a * 3]!);
      expect(cross).toBeLessThanOrEqual(0);
      coveredArea += Math.abs(cross) * 0.5;
    }
    expect(coveredArea).toBeCloseTo(lakeArea, 6);

    system.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("W-5 analytic non-regression: the legacy mesh builders are byte-identical", () => {
    // Gate W rule 1/2 (PHASE_6_EXECUTION_PLAN §1): the analytic legacy paging
    // path must produce byte-identical meshes while the graph-mode builders
    // are replaced. These hashes were pinned from the pre-W-5 tree; if this
    // fails, the analytic appendRiver/appendContainedLake path changed. Do
    // not re-pin without a sanctioned analytic rebaseline.
    //
    // AMENDMENT (2026-09-02, PM-sanctioned rebaseline; LAKE hash only): the
    // analytic lake builder was replaced by `appendContainedLake` after the
    // legacy fan was measured drawing water over ground — every generated
    // lake pierced (1.1% of lake area, worst 8.34 m of terrain above the
    // plate; scripts/hydrology-piercing-probe.mts), photographed in-world as
    // Jason's "blue slash through the terrain". The sanction's basis: Gate
    // W's unchanged-SSIM close proof is GIVEN (PHASE_6_OUTCOME.md, 24/24
    // green analytic shots) and the eroded path is shelved, so the frozen
    // input the old hash protected no longer guards a pending proof. The
    // RIVER hash is deliberately untouched — appendRiver remains
    // byte-identical, and this test still fails on any drift in it.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("legacy-pin-camera", new Vector3(0, 300, -600), scene);
    const hashMesh = (mesh: Mesh | null): string => {
      if (!mesh) return "null";
      const hash = createHash("sha256");
      for (const kind of ["position", "normal", "uv", "flowData", "waterData"]) {
        hash.update(JSON.stringify(Array.from(mesh.getVerticesData(kind) ?? [])));
      }
      hash.update(JSON.stringify(Array.from(mesh.getIndices() ?? [])));
      return hash.digest("hex");
    };
    const riverSystem = new HydrologySystem(scene, camera, {
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
    const lakeSystem = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "basin-lakes",
      terrainSample: bowlTerrain(),
      extentMeters: 1_600,
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
    expect(lakeSystem.lakeMesh, "the lake fixture must exercise appendLake").not.toBeNull();
    expect(riverSystem.riverMesh, "the river fixture must exercise appendRiver").not.toBeNull();
    expect({
      river: hashMesh(riverSystem.riverMesh),
      riverLake: hashMesh(riverSystem.lakeMesh),
      lake: hashMesh(lakeSystem.lakeMesh),
      lakeRiver: hashMesh(lakeSystem.riverMesh),
    }).toEqual({
      river: "f7e407f55a911841736e63f5a74da5830853808c0e54586aa8eadfe632dc9103",
      riverLake: "null",
      lake: "0109459be386cc32b447905142356eff782f4aa48fbc78a004182f877539f124",
      lakeRiver: "null",
    });
    riverSystem.dispose();
    lakeSystem.dispose();
    scene.dispose();
    engine.dispose();
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

/**
 * W-1e byte pin for the GRAPH path.
 *
 * W-1e cuts the eroded startup cost of `ChannelNetwork.extract` and the
 * graph-mode hydrology mesh build. Its contract is that the extracted graph
 * and the built mesh arrays stay byte-identical while they get faster — the
 * same class of pin the W-5 analytic non-regression above carries, but for
 * the path W-5 actually rewrote (and therefore the path a Gate W optimizer
 * could silently change).
 *
 * The fixture is a self-contained synthetic macro export: a hashed value-noise
 * surface with a radial fall to the rim, its own D8 accumulation, and blobby
 * multi-texel lake components. It deliberately does NOT run the production
 * uplift sampler or the macro erosion operators — a pin that did would break
 * whenever the terrain producers legitimately change, which would read as a
 * geometry regression here rather than as the rebaseline it is. What this pin
 * owns is the extraction/meshing arithmetic, and the fixture exercises all of
 * it: concave 8-connected lake components, marching-squares rings with saddle
 * cells, Douglas-Peucker, ear clipping with graded refinement, multi-node
 * river reaches and confluences.
 *
 * `scripts/channel-extract-benchmark.mts` prints the same class of fingerprint
 * over the real 1024² world, which is how a change is checked at production
 * scale; this is the committed CI guard.
 *
 * Do not re-pin these hashes to make a change pass. Extraction and meshing may
 * only get faster, never different.
 */
describe("W-1e graph-path byte pin", () => {
  const FIXTURE_TEXELS = 128;
  const FIXTURE_SEA_LEVEL = 0;

  /** Deterministic integer hash in [0, 1); no Math.random, no world seed. */
  function hash01(x: number, z: number, salt: number): number {
    let h = Math.imul(x | 0, 0x27d4_eb2d) ^ Math.imul(z | 0, 0x1656_67b1)
      ^ Math.imul(salt | 0, 0x85eb_ca6b);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b_3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a_2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4_294_967_296;
  }

  function valueNoise(x: number, z: number, period: number, salt: number): number {
    const gx = Math.floor(x / period);
    const gz = Math.floor(z / period);
    const fx = x / period - gx;
    const fz = z / period - gz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const c00 = hash01(gx, gz, salt);
    const c10 = hash01(gx + 1, gz, salt);
    const c01 = hash01(gx, gz + 1, salt);
    const c11 = hash01(gx + 1, gz + 1, salt);
    return (c00 * (1 - sx) + c10 * sx) * (1 - sz) + (c01 * (1 - sx) + c11 * sx) * sz;
  }

  function fractalNoise(x: number, z: number, salt: number): number {
    return valueNoise(x, z, 24, salt)
      + valueNoise(x, z, 11, salt + 1) * 0.5
      + valueNoise(x, z, 5, salt + 2) * 0.25;
  }

  function buildFixtureMacroExport(): TerrainMacroEvolutionExport {
    const width = FIXTURE_TEXELS;
    const height = FIXTURE_TEXELS;
    const count = width * height;
    const texel = EVOLUTION_TEXEL_METERS;
    const texelAreaM2 = texel * texel;
    const heightMeters = new Float32Array(count);
    for (let z = 0; z < height; z += 1) {
      for (let x = 0; x < width; x += 1) {
        // A dome that falls to the open rim, so every traced path terminates,
        // plus enough relief to carve real valleys between the ridges.
        const radial = Math.max(Math.abs(x - (width - 1) / 2), Math.abs(z - (height - 1) / 2));
        heightMeters[z * width + x] = Math.fround(
          980 - radial * 4.5 + fractalNoise(x, z, 0x51ed) * 150,
        );
      }
    }
    // D8 accumulation over the sampled surface: settle high to low and push
    // each cell's area into its lowest neighbour, which is exactly the
    // monotonicity the extractor's downstream test assumes.
    const order = new Int32Array(count);
    for (let index = 0; index < count; index += 1) order[index] = index;
    const sorted = Array.from(order).sort((first, second) => {
      const difference = heightMeters[second]! - heightMeters[first]!;
      return difference !== 0 ? difference : first - second;
    });
    const areaTexels = new Float64Array(count).fill(1);
    for (const index of sorted) {
      const x = index % width;
      const z = Math.floor(index / width);
      let lowest = -1;
      let lowestHeight = heightMeters[index]!;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
          const neighbour = nz * width + nx;
          const candidate = heightMeters[neighbour]!;
          if (candidate < lowestHeight) {
            lowestHeight = candidate;
            lowest = neighbour;
          }
        }
      }
      if (lowest >= 0) areaTexels[lowest] = areaTexels[lowest]! + areaTexels[index]!;
    }
    const flowAccumulationAreaM2 = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      flowAccumulationAreaM2[index] = Math.fround(areaTexels[index]! * texelAreaM2);
    }
    // Blobby lake components from an independent noise field, kept off the rim
    // so every ring closes inside the grid.
    const lakeMask = new Uint8Array(count);
    for (let z = 2; z < height - 2; z += 1) {
      for (let x = 2; x < width - 2; x += 1) {
        if (fractalNoise(x * 2.5, z * 2.5, 0x2f19) > 1.1) lakeMask[z * width + x] = 1;
      }
    }
    // One export lake per 8-connected component (the extractor floods the
    // component itself and skips a second entry that lands in a claimed one).
    const claimed = new Uint8Array(count);
    const lakes: Array<{
      readonly lakeId: number;
      readonly spillElevationMeters: number;
      readonly outletTexel: { readonly x: number; readonly z: number };
      readonly maximumDepthMeters: number;
      readonly surfaceAreaM2: number;
    }> = [];
    for (let seed = 0; seed < count; seed += 1) {
      if (lakeMask[seed] !== 1 || claimed[seed] === 1) continue;
      const queue = [seed];
      claimed[seed] = 1;
      let maximumHeight = Number.NEGATIVE_INFINITY;
      for (let head = 0; head < queue.length; head += 1) {
        const index = queue[head]!;
        maximumHeight = Math.max(maximumHeight, heightMeters[index]!);
        const x = index % width;
        const z = Math.floor(index / width);
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
            const neighbour = nz * width + nx;
            if (lakeMask[neighbour] !== 1 || claimed[neighbour] === 1) continue;
            claimed[neighbour] = 1;
            queue.push(neighbour);
          }
        }
      }
      if (queue.length < 2) continue;
      lakes.push(Object.freeze({
        lakeId: lakes.length,
        spillElevationMeters: Math.fround(maximumHeight),
        outletTexel: Object.freeze({ x: seed % width, z: Math.floor(seed / width) }),
        maximumDepthMeters: 2 + (lakes.length % 9),
        surfaceAreaM2: queue.length * texelAreaM2,
      }));
    }
    // Channel seeds: the thresholded accumulation field, exactly the shape the
    // production export ships (a field, not a headwater list).
    const seeds: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (areaTexels[index]! >= 48) seeds.push(index);
    }
    return Object.freeze({
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: "w1e-graph-pin", deviceFingerprint: "synthetic" },
      seaLevelMeters: FIXTURE_SEA_LEVEL,
      heightMeters,
      flowAccumulationAreaM2,
      lakeMask,
      lakes: Object.freeze(lakes),
      drainageBaseLevels: Object.freeze(lakes.map((lake, index) => Object.freeze({
        drainageId: index + 1,
        elevationMeters: lake.spillElevationMeters,
        outletTexel: lake.outletTexel,
        termination: "lake" as const,
      }))),
      channelSeedTexelIndices: Uint32Array.from(seeds),
    });
  }

  const fixtureLayout = {
    width: FIXTURE_TEXELS,
    height: FIXTURE_TEXELS,
    texelSizeMeters: EVOLUTION_TEXEL_METERS,
    originX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + EVOLUTION_TEXEL_METERS * 0.5,
    originZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + EVOLUTION_TEXEL_METERS * 0.5,
  } as const;

  // Both pins read the same fixture.
  let cachedMacro: TerrainMacroEvolutionExport | null = null;
  function fixtureMacroExport(): TerrainMacroEvolutionExport {
    cachedMacro ??= buildFixtureMacroExport();
    return cachedMacro;
  }

  /**
   * Pinned hashes. `RIVER_ARRAYS`/`LAKE_ARRAYS` are shared by both pins: the
   * second one proves the `buildGraphHydrologyMeshArrays` harness seam is the
   * same arithmetic the renderer uploads through `buildRegion`, so a drift
   * between harness and renderer fails rather than hiding.
   *
   * Re-pinned once, by `6-1`. The docblock above forbids re-pinning to make an
   * OPTIMIZATION pass; this is not one. 6-1 writes a new datum into the
   * previously-constant `waterData.w` lane of the GRAPH builders — the channel
   * sentinel plus its payload (grade for river stations, sqrt-encoded
   * effective fetch for lake vertices) — which is a deliberate, named change
   * to what the graph mesh carries, exactly the flow the sibling extraction
   * gate documents. Two properties make it safe to re-pin here: the ANALYTIC
   * builders are untouched and their own non-regression pin above is unchanged
   * and still green, and no eroded baseline has been promoted yet (D-1 holds
   * W-7's promotion), so these bytes gate nothing captured. `graph`/`labels`
   * are unchanged, which is the evidence that extraction itself did not move.
   */
  const PINS = {
    graph: "2f3c0daf13f754f2cb1c779ed52b0ec777e039ef3e74bda58dbcdefc995ce831",
    labels: "1aaf17657a0c186ddaf46c4bcae7a477bae6e0d70f11d3dd0eca517a4c8b9bb1",
    riverArrays: "7ab9d5740686071622e070f7a24583475b71c56109922cbb080daba9742a9a58",
    lakeArrays: "9ef8a890d9a825f41c19bec1f98589a5c6ece7448826ad854be00feaf17100be",
  } as const;

  function hashNumbers(...groups: ReadonlyArray<ArrayLike<number> | null>): string {
    const hash = createHash("sha256");
    for (const group of groups) {
      hash.update(JSON.stringify(group === null ? null : Array.from(group)));
    }
    return hash.digest("hex");
  }

  it("pins the extracted graph and the graph-mode mesh arrays", () => {
    const macro = fixtureMacroExport();
    const graph = new ChannelNetwork().extract(macro, { layout: fixtureLayout });
    // A pin over a degenerate fixture proves nothing: the window must carry a
    // real network and real multi-texel lakes.
    expect(graph.nodes.length).toBeGreaterThan(200);
    expect(graph.edges.length).toBeGreaterThan(20);
    expect(graph.lakes.length).toBeGreaterThan(20);
    expect(validateTerrainChannelGraphExport(graph)).toEqual([]);
    expect(
      Math.max(...graph.lakePolygons.map((polygon) => polygon.verticesXZ.length)),
      "the fixture must contain a lake whose shoreline has real detail",
    ).toBeGreaterThan(16);

    const graphHash = hashNumbers(
      graph.nodes.map((node) => node.nodeId),
      graph.nodes.map((node) => node.worldX),
      graph.nodes.map((node) => node.worldZ),
      graph.nodes.map((node) => node.elevationMeters),
      graph.nodes.map((node) => node.flowAccumulationAreaM2),
      graph.edges.map((edge) => edge.edgeId),
      graph.edges.map((edge) => edge.upstreamNodeId),
      graph.edges.map((edge) => edge.downstreamNodeId),
      graph.edges.map((edge) => edge.flowAccumulationAreaM2),
      graph.edges.map((edge) => edge.hydraulicGeometry.wettedWidthMeters),
      graph.edges.map((edge) => edge.hydraulicGeometry.bankfullDepthMeters),
      graph.edges.map((edge) => edge.hydraulicGeometry.dischargeM3PerSecond),
      graph.edges.map((edge) => edge.bankElevationMeters),
      graph.edges.map((edge) => edge.thalwegElevationMeters),
      graph.lakePolygons.flatMap((polygon) => [
        polygon.polygonRef,
        ...Array.from(polygon.verticesXZ),
      ]),
      graph.lakes.map((lake) => lake.lakeId),
      graph.lakes.map((lake) => lake.polygonRef),
      graph.lakes.map((lake) => lake.spillElevationMeters),
      graph.lakes.map((lake) => lake.outletNodeId),
      graph.lakes.map((lake) => lake.maximumDepthMeters),
      graph.lakes.map((lake) => lake.surfaceAreaM2),
    );
    // The kind/termination string fields are pinned separately: they are the
    // graph's topology labels and a hash over numbers alone would miss them.
    const graphLabels = createHash("sha256")
      .update(JSON.stringify([
        graph.nodes.map((node) => node.kind),
        graph.nodes.map((node) => node.termination ?? null),
      ]))
      .digest("hex");

    const geometry = channelGraphToHydrologyGeometry(graph);
    expect(geometry.rivers.length).toBeGreaterThan(5);
    expect(geometry.lakes.length).toBe(graph.lakes.length);
    const built = buildGraphHydrologyMeshArrays(geometry.rivers, geometry.lakes);
    expect(built.rivers.positions.length).toBeGreaterThan(3_000);
    expect(built.lakes.positions.length).toBeGreaterThan(3_000);
    const meshHash = (arrays: {
      readonly positions: readonly number[];
      readonly normals: readonly number[];
      readonly uvs: readonly number[];
      readonly indices: readonly number[];
      readonly flowData: readonly number[];
      readonly waterData: readonly number[];
    }): string => hashNumbers(
      arrays.positions,
      arrays.normals,
      arrays.uvs,
      arrays.flowData,
      arrays.waterData,
      arrays.indices,
    );

    expect({
      graph: graphHash,
      labels: graphLabels,
      riverArrays: meshHash(built.rivers),
      lakeArrays: meshHash(built.lakes),
    }).toEqual(PINS);
  });

  it("pins the Babylon graph-mode meshes the renderer actually uploads", () => {
    const macro = fixtureMacroExport();
    const graph = new ChannelNetwork().extract(macro, { layout: fixtureLayout });
    const geometry = channelGraphToHydrologyGeometry(graph);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("w1e-graph-pin-camera", new Vector3(0, 300, -600), scene);
    const system = new HydrologySystem(scene, camera, {
      atmosphere: ATMOSPHERE,
      worldSeed: "w1e-graph-pin",
      terrainSample: () => {
        throw new Error("graph mode must not sample analytic terrain");
      },
      seaLevel: 0,
      centerX: 0,
      centerZ: 0,
      graphHydrology: { rivers: geometry.rivers, lakes: geometry.lakes },
    });
    const hashMesh = (mesh: Mesh | null): string => {
      if (!mesh) return "null";
      const hash = createHash("sha256");
      for (const kind of ["position", "normal", "uv", "flowData", "waterData"]) {
        hash.update(JSON.stringify(Array.from(mesh.getVerticesData(kind) ?? [])));
      }
      hash.update(JSON.stringify(Array.from(mesh.getIndices() ?? [])));
      return hash.digest("hex");
    };
    expect({
      river: hashMesh(system.riverMesh),
      lake: hashMesh(system.lakeMesh),
    }).toEqual({
      river: PINS.riverArrays,
      lake: PINS.lakeArrays,
    });
    system.dispose();
    scene.dispose();
    engine.dispose();
  });
});
