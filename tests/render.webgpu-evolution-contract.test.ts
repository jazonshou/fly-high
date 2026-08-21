import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ALLOCATIONS,
  estimateGpuMemoryBreakdown,
} from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  EVOLUTION_ANALYTIC_BLEND_METERS,
  EVOLUTION_ANALYTIC_BLEND_TEXELS,
  EVOLUTION_DOMAIN_EXTENT_METERS,
  EVOLUTION_DOMAIN_HALF_EXTENT_METERS,
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  MINIMUM_MESHED_LAKE_AREA_M2,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_DETERMINISM,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2,
  TERRAIN_HEIGHT_AUTHORITY_LADDER,
  TERRAIN_HYDRAULIC_GEOMETRY_LAW,
  TERRAIN_PAGE_HYDROLOGY_ENCODING,
  decodeWorldPageFlowAccum,
  decodeWorldPageLakeDepth,
  decodeWorldPageShoreDistance,
  decodeWorldPageSoilDepth,
  decodeTerrainFlowAccumulationLog2,
  encodeWorldPageFlowAccum,
  encodeWorldPageLakeDepth,
  encodeWorldPageShoreDistance,
  encodeWorldPageSoilDepth,
  encodeTerrainFlowAccumulationLog2,
  shouldMeshTerrainLake,
  terrainEvolutionMacroBlend,
  terrainEvolutionTexelCenter,
  terrainEvolutionTexelIndex,
  terrainHydraulicGeometry,
  validateTerrainChannelGraphExport,
  type QuantizedHydrologyPage,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  WORLD_PAGE_GPU_CHANNELS,
  WORLD_PAGE_HYDROLOGY_CHANNELS,
  WORLD_PAGE_SCHEMA_VERSION,
} from "../src/render/webgpu/world/payload";

const REFERENCE_VIEWPORT = {
  cssWidth: 1_512,
  cssHeight: 982,
  devicePixelRatio: 2,
} as const;

function hydrologyEncoding(): QuantizedHydrologyPage {
  return {
    format: "r16uint-log-flow+r16uint-lake-depth+r8unorm-soil+r16sint-shore-v2",
    flowAccum: new Uint16Array(0),
    lakeDepth: new Uint16Array(0),
    soilDepth: new Uint8Array(0),
    shoreDistance: new Int16Array(0),
    ...TERRAIN_PAGE_HYDROLOGY_ENCODING,
  };
}

describe("terrain evolution spine contract (5-0)", () => {
  it("freezes one derived, world-origin-anchored macro domain", () => {
    expect(Object.isFrozen(TERRAIN_EVOLUTION_MACRO_LAYOUT)).toBe(true);
    expect(EVOLUTION_DOMAIN_TEXELS).toBe(1_024);
    expect(EVOLUTION_TEXEL_METERS).toBe(512);
    expect(EVOLUTION_DOMAIN_EXTENT_METERS).toBe(524_288);
    expect(EVOLUTION_DOMAIN_SAMPLE_COUNT).toBe(1_048_576);
    expect(EVOLUTION_DOMAIN_HALF_EXTENT_METERS).toBe(262_144);
    expect(EVOLUTION_ANALYTIC_BLEND_TEXELS).toBe(16);
    expect(EVOLUTION_ANALYTIC_BLEND_METERS).toBe(8_192);
    expect(TERRAIN_EVOLUTION_MACRO_LAYOUT).toMatchObject({
      minWorldX: -262_144,
      maxWorldX: 262_144,
      minWorldZ: -262_144,
      maxWorldZ: 262_144,
      sampleConvention: "cell-centre",
      boundaryCondition: "open-sea-level",
    });

    expect(terrainEvolutionTexelCenter({ x: 0, z: 0 })).toEqual({
      worldX: -261_888,
      worldZ: -261_888,
    });
    expect(terrainEvolutionTexelIndex({ x: 17, z: 3 })).toBe(3 * 1_024 + 17);
    expect(() => terrainEvolutionTexelIndex({ x: 1_024, z: 0 })).toThrow(RangeError);

    expect(terrainEvolutionMacroBlend(0, 0)).toBe(1);
    expect(terrainEvolutionMacroBlend(262_144, 0)).toBe(0);
    expect(terrainEvolutionMacroBlend(262_144 - 4_096, 0)).toBeCloseTo(0.5, 12);
    expect(terrainEvolutionMacroBlend(300_000, 0)).toBe(0);
  });

  it("pins the tier-independent height-authority and determinism rules", () => {
    expect(TERRAIN_HEIGHT_AUTHORITY_LADDER).toEqual([
      "l0-readback",
      "macro",
      "analytic",
    ]);
    expect(Object.isFrozen(TERRAIN_HEIGHT_AUTHORITY_LADDER)).toBe(true);
    expect(TERRAIN_EVOLUTION_DETERMINISM).toMatchObject({
      inputs: ["world-seed", "device"],
      invariantOf: ["quality-tier", "admission-order", "frame-timing", "flight-path"],
      guarantee: "same-device-bit-reproducible",
      crossDeviceIdentity: false,
    });
  });

  it("adds movable Phase-5 memory rows with their declared shapes", () => {
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const base = estimateGpuMemoryBreakdown(profile, REFERENCE_VIEWPORT);
    expect(DYNAMIC_ALLOCATIONS.macroEvolutionEdge).toBe(EVOLUTION_DOMAIN_TEXELS);
    expect(base.macroEvolutionMiB).toBe(5);
    expect(base.erosionScratchMiB).toBeCloseTo(3.375, 9);
    expect(base.bathymetryClipmapMiB).toBe(4);
    expect(base.channelGraphMiB).toBe(2);

    const moved = estimateGpuMemoryBreakdown(profile, REFERENCE_VIEWPORT, {
      ...DYNAMIC_ALLOCATIONS,
      macroEvolutionResidentBytesPerTexel: 6,
      erosionScratchFieldCount: 7,
      bathymetryClipmapTextureCount: 3,
      channelGraphBudgetBytes: 3 * 1_048_576,
    });
    expect(moved.macroEvolutionMiB).toBe(6);
    expect(moved.erosionScratchMiB).toBeGreaterThan(base.erosionScratchMiB);
    expect(moved.bathymetryClipmapMiB).toBe(6);
    expect(moved.channelGraphMiB).toBe(3);
    expect(moved.totalMiB).toBeGreaterThan(base.totalMiB);
  });
});

describe("erosion-hydrology exports (5-1)", () => {
  it("reconciles the page schema and every live hydrology GPU channel", () => {
    expect(WORLD_PAGE_SCHEMA_VERSION).toBe(2);
    expect(WORLD_PAGE_HYDROLOGY_CHANNELS).toEqual([
      "flowAccum",
      "lakeDepth",
      "soilDepth",
      "shoreDistance",
    ]);
    const hydrology = WORLD_PAGE_GPU_CHANNELS.filter(
      (channel) => WORLD_PAGE_HYDROLOGY_CHANNELS.includes(
        channel.name as (typeof WORLD_PAGE_HYDROLOGY_CHANNELS)[number],
      ),
    );
    expect(hydrology.map(({ name, gpuFormat, textureCount }) => ({
      name,
      gpuFormat,
      textureCount,
    }))).toEqual([
      { name: "flowAccum", gpuFormat: "r16float", textureCount: 1 },
      { name: "lakeDepth", gpuFormat: "r16float", textureCount: 1 },
      { name: "soilDepth", gpuFormat: "r8unorm", textureCount: 1 },
      { name: "shoreDistance", gpuFormat: "r16sint", textureCount: 1 },
    ]);
    expect(hydrology.every((channel) => channel.plannedBy === undefined)).toBe(true);
    expect(WORLD_PAGE_GPU_CHANNELS.some((channel) => channel.name === "splatIdHi")).toBe(false);
    expect(WORLD_PAGE_GPU_CHANNELS.filter((channel) => channel.seasonKeyed).map((c) => c.name))
      .toEqual(["splatWeight"]);
  });

  it("round-trips every page-channel quantisation at its declared precision", () => {
    const encoding = hydrologyEncoding();
    expect(TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2)
      .toBe(EVOLUTION_DOMAIN_EXTENT_METERS ** 2);
    for (const areaM2 of [0, 4, 262_144, 1_000_000_000, EVOLUTION_DOMAIN_EXTENT_METERS ** 2]) {
      expect(decodeTerrainFlowAccumulationLog2(encodeTerrainFlowAccumulationLog2(areaM2)))
        .toBeCloseTo(areaM2, 3);
      const sample = encodeWorldPageFlowAccum(encoding, areaM2);
      const decoded = decodeWorldPageFlowAccum(encoding, sample);
      if (areaM2 === 0) {
        expect(decoded).toBe(0);
      } else {
        expect(Math.abs(decoded - areaM2) / areaM2).toBeLessThan(0.001);
      }
    }

    const lakeSample = encodeWorldPageLakeDepth(encoding, 37.42);
    expect(decodeWorldPageLakeDepth(encoding, lakeSample)).toBeCloseTo(37.42, 9);
    const soilSample = encodeWorldPageSoilDepth(encoding, 3.25);
    expect(decodeWorldPageSoilDepth(encoding, soilSample)).toBeCloseTo(3.25, 1);
    for (const distance of [-1_234.25, 0, 2_048.75]) {
      const shoreSample = encodeWorldPageShoreDistance(encoding, distance);
      expect(decodeWorldPageShoreDistance(encoding, shoreSample)).toBe(distance);
    }

    expect(() => encodeWorldPageFlowAccum(encoding, Number.NaN)).toThrow(RangeError);
    expect(() => encodeTerrainFlowAccumulationLog2(
      TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2 + 1,
    )).toThrow(RangeError);
    expect(() => encodeWorldPageLakeDepth(encoding, -1)).toThrow(RangeError);
    expect(() => encodeWorldPageSoilDepth(encoding, 9)).toThrow(RangeError);
    expect(() => encodeWorldPageShoreDistance(encoding, 20_000)).toThrow(RangeError);
  });

  it("pins the hydraulic exponents and exports one monotone geometry law", () => {
    expect(TERRAIN_HYDRAULIC_GEOMETRY_LAW).toMatchObject({
      dischargeExponent: 0.7,
      widthExponent: 0.5,
      depthExponent: 0.4,
    });
    const small = terrainHydraulicGeometry(1_000_000);
    const large = terrainHydraulicGeometry(100_000_000);
    expect(small.dischargeM3PerSecond).toBeCloseTo(1.584893192, 8);
    expect(large.dischargeM3PerSecond).toBeCloseTo(39.81071706, 8);
    expect(large.wettedWidthMeters).toBeGreaterThan(small.wettedWidthMeters);
    expect(large.bankfullDepthMeters).toBeGreaterThan(small.bankfullDepthMeters);
    expect(() => terrainHydraulicGeometry(-1)).toThrow(RangeError);
  });

  it("accepts a typed downstream graph and rejects topology or hydraulic drift", () => {
    const graph: TerrainChannelGraphExport = {
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: "two-basin-saddle", deviceFingerprint: "fixture" },
      nodes: [
        {
          nodeId: 0,
          kind: "source",
          worldX: -512,
          worldZ: 0,
          elevationMeters: 120,
          flowAccumulationAreaM2: 1_000_000,
        },
        {
          nodeId: 1,
          kind: "confluence",
          worldX: 0,
          worldZ: 0,
          elevationMeters: 90,
          flowAccumulationAreaM2: 4_000_000,
        },
        {
          nodeId: 2,
          kind: "outlet",
          worldX: 512,
          worldZ: 0,
          elevationMeters: 0,
          flowAccumulationAreaM2: 10_000_000,
          termination: "rim",
        },
      ],
      edges: [
        {
          edgeId: 0,
          upstreamNodeId: 0,
          downstreamNodeId: 1,
          flowAccumulationAreaM2: 4_000_000,
          hydraulicGeometry: terrainHydraulicGeometry(4_000_000),
          bankElevationMeters: 101,
          thalwegElevationMeters: 98,
        },
        {
          edgeId: 1,
          upstreamNodeId: 1,
          downstreamNodeId: 2,
          flowAccumulationAreaM2: 10_000_000,
          hydraulicGeometry: terrainHydraulicGeometry(10_000_000),
          bankElevationMeters: 92,
          thalwegElevationMeters: 87,
        },
      ],
      lakePolygons: [{
        polygonRef: 0,
        verticesXZ: new Float32Array([-100, -100, 100, -100, 100, 100, -100, 100]),
      }],
      lakes: [{
        lakeId: 0,
        polygonRef: 0,
        spillElevationMeters: 90,
        outletNodeId: 1,
        maximumDepthMeters: 8,
        surfaceAreaM2: MINIMUM_MESHED_LAKE_AREA_M2,
      }],
    };
    expect(validateTerrainChannelGraphExport(graph)).toEqual([]);
    expect(shouldMeshTerrainLake(graph.lakes[0]!)).toBe(true);
    expect(shouldMeshTerrainLake({ surfaceAreaM2: MINIMUM_MESHED_LAKE_AREA_M2 - 1 }))
      .toBe(false);

    const bad: TerrainChannelGraphExport = {
      ...graph,
      nodes: graph.nodes.map((node) => node.nodeId === 2
        ? { ...node, flowAccumulationAreaM2: 1 }
        : node),
      edges: graph.edges.map((edge) => edge.edgeId === 1
        ? { ...edge, hydraulicGeometry: terrainHydraulicGeometry(1) }
        : edge),
    };
    expect(validateTerrainChannelGraphExport(bad)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "flow accumulation must be monotone downstream" }),
      expect.objectContaining({ message: "must come from the contract law" }),
    ]));
  });

  it("types the macro authority without lake count or radius caps", () => {
    const macro = {
      contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
      provenance: { worldSeed: "cone", deviceFingerprint: "fixture" },
      seaLevelMeters: 0,
      heightMeters: new Float32Array(0),
      flowAccumulationAreaM2: new Float32Array(0),
      lakeMask: new Uint8Array(0),
      lakes: [{
        lakeId: 0,
        spillElevationMeters: 12,
        outletTexel: { x: 2, z: 3 },
        maximumDepthMeters: 5,
        surfaceAreaM2: 80_000,
      }],
      drainageBaseLevels: [{
        drainageId: 0,
        elevationMeters: 0,
        outletTexel: { x: 1_023, z: 3 },
        termination: "rim",
      }],
      channelSeedTexelIndices: new Uint32Array([2 * EVOLUTION_DOMAIN_TEXELS + 3]),
    } satisfies TerrainMacroEvolutionExport;
    expect(macro.lakes[0]).not.toHaveProperty("radiusMeters");
    expect(macro).not.toHaveProperty("maximumLakes");
  });
});
