import type { WorldPageKey } from "@/src/render/webgpu/world/pageKey";
import type { QuantizedHydrologyPage } from "@/src/render/webgpu/world/payload";

export {
  decodeWorldPageFlowAccum,
  decodeWorldPageLakeDepth,
  decodeWorldPageShoreDistance,
  decodeWorldPageSoilDepth,
  encodeWorldPageFlowAccum,
  encodeWorldPageLakeDepth,
  encodeWorldPageShoreDistance,
  encodeWorldPageSoilDepth,
} from "@/src/render/webgpu/world/payload";
export type { QuantizedHydrologyPage } from "@/src/render/webgpu/world/payload";

/** Schema shared by the macro producer, collision hand-off and channel graph. */
export const TERRAIN_EVOLUTION_CONTRACT_VERSION = 1 as const;

/** D2: one deterministic, world-anchored erosion domain. */
export const EVOLUTION_DOMAIN_TEXELS = 1_024;
export const EVOLUTION_TEXEL_METERS = 512;
export const EVOLUTION_DOMAIN_EXTENT_METERS =
  EVOLUTION_DOMAIN_TEXELS * EVOLUTION_TEXEL_METERS;
export const EVOLUTION_DOMAIN_SAMPLE_COUNT =
  EVOLUTION_DOMAIN_TEXELS * EVOLUTION_DOMAIN_TEXELS;
export const EVOLUTION_DOMAIN_HALF_EXTENT_METERS =
  EVOLUTION_DOMAIN_EXTENT_METERS / 2;
export const EVOLUTION_ANALYTIC_BLEND_TEXELS = 16;
export const EVOLUTION_ANALYTIC_BLEND_METERS =
  EVOLUTION_ANALYTIC_BLEND_TEXELS * EVOLUTION_TEXEL_METERS;

/**
 * Macro texels are cell-centred. The domain edges remain exactly
 * `EVOLUTION_DOMAIN_EXTENT_METERS` apart while adjacent samples remain exactly
 * `EVOLUTION_TEXEL_METERS` apart.
 */
export const TERRAIN_EVOLUTION_MACRO_LAYOUT = Object.freeze({
  texelsPerEdge: EVOLUTION_DOMAIN_TEXELS,
  texelMeters: EVOLUTION_TEXEL_METERS,
  extentMeters: EVOLUTION_DOMAIN_EXTENT_METERS,
  minWorldX: -EVOLUTION_DOMAIN_HALF_EXTENT_METERS,
  maxWorldX: EVOLUTION_DOMAIN_HALF_EXTENT_METERS,
  minWorldZ: -EVOLUTION_DOMAIN_HALF_EXTENT_METERS,
  maxWorldZ: EVOLUTION_DOMAIN_HALF_EXTENT_METERS,
  sampleConvention: "cell-centre" as const,
  boundaryCondition: "open-sea-level" as const,
  analyticBlendTexels: EVOLUTION_ANALYTIC_BLEND_TEXELS,
});

export interface TerrainEvolutionMacroTexel {
  readonly x: number;
  readonly z: number;
}

/** World position at the centre of a macro texel. */
export function terrainEvolutionTexelCenter(
  texel: TerrainEvolutionMacroTexel,
): { readonly worldX: number; readonly worldZ: number } {
  requireMacroTexelCoordinate(texel.x, "x");
  requireMacroTexelCoordinate(texel.z, "z");
  return {
    worldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX
      + (texel.x + 0.5) * EVOLUTION_TEXEL_METERS,
    worldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ
      + (texel.z + 0.5) * EVOLUTION_TEXEL_METERS,
  };
}

/** Row-major macro-grid index. */
export function terrainEvolutionTexelIndex(texel: TerrainEvolutionMacroTexel): number {
  requireMacroTexelCoordinate(texel.x, "x");
  requireMacroTexelCoordinate(texel.z, "z");
  return texel.z * EVOLUTION_DOMAIN_TEXELS + texel.x;
}

/**
 * Eroded-authority weight across D2's 16-texel rim blend. The open rim itself
 * and all points outside it are analytic (0); the interior is eroded (1).
 */
export function terrainEvolutionMacroBlend(worldX: number, worldZ: number): number {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new RangeError("Terrain evolution world coordinates must be finite");
  }
  const distanceToRim = Math.min(
    worldX - TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
    TERRAIN_EVOLUTION_MACRO_LAYOUT.maxWorldX - worldX,
    worldZ - TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
    TERRAIN_EVOLUTION_MACRO_LAYOUT.maxWorldZ - worldZ,
  );
  if (distanceToRim <= 0) return 0;
  const t = Math.min(1, distanceToRim / EVOLUTION_ANALYTIC_BLEND_METERS);
  return t * t * (3 - 2 * t);
}

function requireMacroTexelCoordinate(value: number, axis: "x" | "z"): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= EVOLUTION_DOMAIN_TEXELS) {
    throw new RangeError(
      `Macro texel ${axis} must be an integer in [0, ${EVOLUTION_DOMAIN_TEXELS})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Height authority and determinism
// ---------------------------------------------------------------------------

/** D9: graphics settings never alter this order. */
export const TERRAIN_HEIGHT_AUTHORITY_LADDER = Object.freeze([
  "l0-readback",
  "macro",
  "analytic",
] as const);
export type TerrainHeightAuthority = (typeof TERRAIN_HEIGHT_AUTHORITY_LADDER)[number];

export interface TerrainHeightAuthorityCounters {
  readonly readbackServed: number;
  readonly macroServed: number;
  readonly analyticServed: number;
}

export const TERRAIN_EVOLUTION_DETERMINISM = Object.freeze({
  inputs: Object.freeze(["world-seed", "device"] as const),
  invariantOf: Object.freeze([
    "quality-tier",
    "admission-order",
    "frame-timing",
    "flight-path",
  ] as const),
  guarantee: "same-device-bit-reproducible" as const,
  crossDeviceIdentity: false,
});

export interface TerrainEvolutionProvenance {
  readonly worldSeed: string;
  /** Stable renderer-supplied fingerprint; not a user-facing adapter label. */
  readonly deviceFingerprint: string;
}

// ---------------------------------------------------------------------------
// Macro and per-page exports
// ---------------------------------------------------------------------------

export interface TerrainMacroLakeBasinExport {
  readonly lakeId: number;
  /** Flood output. It is never a renderer or quality-profile tuning value. */
  readonly spillElevationMeters: number;
  readonly outletTexel: TerrainEvolutionMacroTexel;
  readonly maximumDepthMeters: number;
  readonly surfaceAreaM2: number;
}

export type TerrainDrainageTermination = "sea" | "rim" | "lake";

export interface TerrainDrainageBaseLevelExport {
  readonly drainageId: number;
  readonly elevationMeters: number;
  readonly outletTexel: TerrainEvolutionMacroTexel;
  readonly termination: TerrainDrainageTermination;
}

/**
 * CPU-resident output of the eager macro pass. Typed arrays are deliberately
 * directly transferable; consumers retain or copy them according to their
 * lifetime rather than reconstructing the analytic terrain.
 */
export interface TerrainMacroEvolutionExport {
  readonly contractVersion: typeof TERRAIN_EVOLUTION_CONTRACT_VERSION;
  readonly provenance: TerrainEvolutionProvenance;
  readonly seaLevelMeters: number;
  /** Row-major, exactly EVOLUTION_DOMAIN_TEXELS² values. */
  readonly heightMeters: Float32Array;
  /** Upstream contributing area in square metres, not a tier-relative count. */
  readonly flowAccumulationAreaM2: Float32Array;
  /** Zero is dry and one is retained water. */
  readonly lakeMask: Uint8Array;
  readonly lakes: readonly TerrainMacroLakeBasinExport[];
  readonly drainageBaseLevels: readonly TerrainDrainageBaseLevelExport[];
  /** Row-major texel indices whose accumulation crosses the producer threshold. */
  readonly channelSeedTexelIndices: Uint32Array;
}

/** The one legal page-level erosion↔hydrology hand-off. */
export interface TerrainEvolutionPageExport {
  readonly pageKey: WorldPageKey;
  readonly hydrology: QuantizedHydrologyPage;
}

export const TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2 =
  EVOLUTION_DOMAIN_EXTENT_METERS ** 2;

/** Value written to the page atlas's R16F `flowAccum` channel. */
export function encodeTerrainFlowAccumulationLog2(areaM2: number): number {
  if (!Number.isFinite(areaM2) || areaM2 < 0) {
    throw new RangeError("Flow accumulation area must be finite and non-negative");
  }
  if (areaM2 > TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2) {
    throw new RangeError("Flow accumulation area exceeds the evolution domain");
  }
  return Math.log2(areaM2 + 1);
}

/** Area in square metres decoded from the page atlas's logarithmic R16F value. */
export function decodeTerrainFlowAccumulationLog2(log2AreaPlusOne: number): number {
  if (!Number.isFinite(log2AreaPlusOne) || log2AreaPlusOne < 0) {
    throw new RangeError("Encoded flow accumulation must be finite and non-negative");
  }
  return Math.max(0, 2 ** log2AreaPlusOne - 1);
}

/**
 * Canonical quantisation used when a generated page becomes transferable.
 * `flowAccum` spans zero through the complete 524 km domain logarithmically.
 */
export const TERRAIN_PAGE_HYDROLOGY_ENCODING = Object.freeze({
  flowAccumLog2Bias: 0,
  flowAccumLog2PerUnit:
    encodeTerrainFlowAccumulationLog2(TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2) / 65_535,
  lakeDepthMetersPerUnit: 0.01,
  soilDepthMaxMeters: 8,
  shoreDistanceMetersPerUnit: 0.25,
});

// ---------------------------------------------------------------------------
// Exported hydraulic geometry — computed once, consumed everywhere
// ---------------------------------------------------------------------------

export interface TerrainHydraulicGeometryLaw {
  readonly dischargeCoefficient: number;
  readonly dischargeExponent: 0.7;
  readonly widthCoefficient: number;
  readonly widthExponent: 0.5;
  readonly depthCoefficient: number;
  readonly depthExponent: 0.4;
}

/**
 * Provisional Phase-5 calibration, explicit because a renderer-side width
 * heuristic would break carving/mesh agreement. A is upstream area in m².
 */
export const TERRAIN_HYDRAULIC_GEOMETRY_LAW: Readonly<TerrainHydraulicGeometryLaw> =
  Object.freeze({
    dischargeCoefficient: 1e-4,
    dischargeExponent: 0.7,
    widthCoefficient: 2,
    widthExponent: 0.5,
    depthCoefficient: 0.3,
    depthExponent: 0.4,
  });

export interface TerrainHydraulicGeometry {
  readonly dischargeM3PerSecond: number;
  readonly wettedWidthMeters: number;
  readonly bankfullDepthMeters: number;
}

export function terrainHydraulicGeometry(
  flowAccumulationAreaM2: number,
  law: Readonly<TerrainHydraulicGeometryLaw> = TERRAIN_HYDRAULIC_GEOMETRY_LAW,
): TerrainHydraulicGeometry {
  if (!Number.isFinite(flowAccumulationAreaM2) || flowAccumulationAreaM2 < 0) {
    throw new RangeError("Flow accumulation area must be finite and non-negative");
  }
  for (const [name, value] of [
    ["dischargeCoefficient", law.dischargeCoefficient],
    ["widthCoefficient", law.widthCoefficient],
    ["depthCoefficient", law.depthCoefficient],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative`);
    }
  }
  const dischargeM3PerSecond =
    law.dischargeCoefficient * flowAccumulationAreaM2 ** law.dischargeExponent;
  return Object.freeze({
    dischargeM3PerSecond,
    wettedWidthMeters:
      law.widthCoefficient * dischargeM3PerSecond ** law.widthExponent,
    bankfullDepthMeters:
      law.depthCoefficient * dischargeM3PerSecond ** law.depthExponent,
  });
}

// ---------------------------------------------------------------------------
// Channel graph and rendered-lake exports
// ---------------------------------------------------------------------------

export type TerrainChannelNodeKind = "source" | "channel" | "confluence" | "outlet";

export interface TerrainChannelNodeExport {
  readonly nodeId: number;
  readonly kind: TerrainChannelNodeKind;
  readonly worldX: number;
  readonly worldZ: number;
  readonly elevationMeters: number;
  readonly flowAccumulationAreaM2: number;
  /** Present only on a legal terminal node. */
  readonly termination?: TerrainDrainageTermination;
}

export interface TerrainChannelEdgeExport {
  readonly edgeId: number;
  readonly upstreamNodeId: number;
  readonly downstreamNodeId: number;
  readonly flowAccumulationAreaM2: number;
  /** Exported once by ChannelNetwork; render and carving only consume it. */
  readonly hydraulicGeometry: TerrainHydraulicGeometry;
  readonly bankElevationMeters: number;
  readonly thalwegElevationMeters: number;
}

export interface TerrainLakePolygonExport {
  readonly polygonRef: number;
  /** Interleaved world x/z vertices. */
  readonly verticesXZ: Float32Array;
}

export interface TerrainLakeExport {
  readonly lakeId: number;
  readonly polygonRef: number;
  readonly spillElevationMeters: number;
  readonly outletNodeId: number;
  readonly maximumDepthMeters: number;
  readonly surfaceAreaM2: number;
}

export interface TerrainChannelGraphExport {
  readonly contractVersion: typeof TERRAIN_EVOLUTION_CONTRACT_VERSION;
  readonly provenance: TerrainEvolutionProvenance;
  /** Nodes are serialized in downstream topological order. */
  readonly nodes: readonly TerrainChannelNodeExport[];
  readonly edges: readonly TerrainChannelEdgeExport[];
  readonly lakePolygons: readonly TerrainLakePolygonExport[];
  readonly lakes: readonly TerrainLakeExport[];
}

/** D7: small retained basins remain wet terrain instead of water meshes. */
export const MINIMUM_MESHED_LAKE_AREA_M2 = 40_000;

export function shouldMeshTerrainLake(
  lake: Pick<TerrainLakeExport, "surfaceAreaM2">,
): boolean {
  return Number.isFinite(lake.surfaceAreaM2)
    && lake.surfaceAreaM2 >= MINIMUM_MESHED_LAKE_AREA_M2;
}

export interface TerrainChannelGraphValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Pure structural gate used before a graph is transferred to mesh workers. */
export function validateTerrainChannelGraphExport(
  graph: TerrainChannelGraphExport,
): readonly TerrainChannelGraphValidationIssue[] {
  const issues: TerrainChannelGraphValidationIssue[] = [];
  const nodes = new Map<number, TerrainChannelNodeExport>();
  const nodeOrder = new Map<number, number>();
  const outgoing = new Map<number, number>();
  const polygons = new Set<number>();

  if (graph.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    issues.push({ path: "contractVersion", message: "does not match the evolution contract" });
  }
  if (!graph.provenance.worldSeed || !graph.provenance.deviceFingerprint) {
    issues.push({ path: "provenance", message: "requires a world seed and device fingerprint" });
  }

  graph.nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!Number.isSafeInteger(node.nodeId) || node.nodeId < 0 || nodes.has(node.nodeId)) {
      issues.push({ path: `${path}.nodeId`, message: "must be a unique non-negative integer" });
    } else {
      nodes.set(node.nodeId, node);
      nodeOrder.set(node.nodeId, index);
    }
    for (const [field, value] of [
      ["worldX", node.worldX],
      ["worldZ", node.worldZ],
      ["elevationMeters", node.elevationMeters],
      ["flowAccumulationAreaM2", node.flowAccumulationAreaM2],
    ] as const) {
      if (!Number.isFinite(value) || (field === "flowAccumulationAreaM2" && value < 0)) {
        issues.push({ path: `${path}.${field}`, message: "must be finite and non-negative where applicable" });
      }
    }
  });

  const edgeIds = new Set<number>();
  graph.edges.forEach((edge, index) => {
    const path = `edges[${index}]`;
    if (!Number.isSafeInteger(edge.edgeId) || edge.edgeId < 0 || edgeIds.has(edge.edgeId)) {
      issues.push({ path: `${path}.edgeId`, message: "must be a unique non-negative integer" });
    }
    edgeIds.add(edge.edgeId);
    const upstream = nodes.get(edge.upstreamNodeId);
    const downstream = nodes.get(edge.downstreamNodeId);
    if (!upstream) issues.push({ path: `${path}.upstreamNodeId`, message: "does not name a node" });
    if (!downstream) issues.push({ path: `${path}.downstreamNodeId`, message: "does not name a node" });
    if (upstream && downstream) {
      if (downstream.flowAccumulationAreaM2 < upstream.flowAccumulationAreaM2) {
        issues.push({ path, message: "flow accumulation must be monotone downstream" });
      }
      outgoing.set(upstream.nodeId, (outgoing.get(upstream.nodeId) ?? 0) + 1);
      if ((nodeOrder.get(upstream.nodeId) ?? index) >= (nodeOrder.get(downstream.nodeId) ?? -1)) {
        issues.push({ path, message: "nodes must be serialized in downstream order" });
      }
    }
    if (
      !Number.isFinite(edge.bankElevationMeters)
      || !Number.isFinite(edge.thalwegElevationMeters)
    ) {
      issues.push({ path, message: "bank and thalweg elevations must be finite" });
    } else if (edge.bankElevationMeters < edge.thalwegElevationMeters) {
      issues.push({ path, message: "bank elevation must not be below the thalweg" });
    }
    if (!Number.isFinite(edge.flowAccumulationAreaM2) || edge.flowAccumulationAreaM2 < 0) {
      issues.push({
        path: `${path}.flowAccumulationAreaM2`,
        message: "must be finite and non-negative",
      });
    } else {
      const expected = terrainHydraulicGeometry(edge.flowAccumulationAreaM2);
      if (
        edge.hydraulicGeometry.dischargeM3PerSecond !== expected.dischargeM3PerSecond
        || edge.hydraulicGeometry.wettedWidthMeters !== expected.wettedWidthMeters
        || edge.hydraulicGeometry.bankfullDepthMeters !== expected.bankfullDepthMeters
      ) {
        issues.push({
          path: `${path}.hydraulicGeometry`,
          message: "must come from the contract law",
        });
      }
    }
  });

  graph.nodes.forEach((node, index) => {
    const outgoingCount = outgoing.get(node.nodeId) ?? 0;
    if (outgoingCount > 1) {
      issues.push({
        path: `nodes[${index}]`,
        message: "drainage channels may merge but cannot split downstream",
      });
    }
    const terminal = outgoingCount === 0;
    if (terminal !== (node.termination !== undefined)) {
      issues.push({
        path: `nodes[${index}].termination`,
        message: terminal ? "terminal nodes require a legal termination" : "non-terminal nodes cannot terminate",
      });
    }
  });

  graph.lakePolygons.forEach((polygon, index) => {
    if (
      !Number.isSafeInteger(polygon.polygonRef)
      || polygon.polygonRef < 0
      || polygons.has(polygon.polygonRef)
    ) {
      issues.push({
        path: `lakePolygons[${index}].polygonRef`,
        message: "must be a unique non-negative integer",
      });
    }
    polygons.add(polygon.polygonRef);
    if (polygon.verticesXZ.length < 6 || polygon.verticesXZ.length % 2 !== 0) {
      issues.push({
        path: `lakePolygons[${index}].verticesXZ`,
        message: "must contain at least three interleaved x/z vertices",
      });
    }
  });

  const lakeIds = new Set<number>();
  graph.lakes.forEach((lake, index) => {
    const path = `lakes[${index}]`;
    if (!Number.isSafeInteger(lake.lakeId) || lake.lakeId < 0 || lakeIds.has(lake.lakeId)) {
      issues.push({ path: `${path}.lakeId`, message: "must be a unique non-negative integer" });
    }
    lakeIds.add(lake.lakeId);
    if (!polygons.has(lake.polygonRef)) {
      issues.push({ path: `${path}.polygonRef`, message: "does not name an exported polygon" });
    }
    if (!nodes.has(lake.outletNodeId)) {
      issues.push({ path: `${path}.outletNodeId`, message: "does not name a channel node" });
    }
    if (
      !Number.isFinite(lake.spillElevationMeters)
      || !Number.isFinite(lake.maximumDepthMeters)
      || lake.maximumDepthMeters < 0
      || !Number.isFinite(lake.surfaceAreaM2)
      || lake.surfaceAreaM2 < 0
    ) {
      issues.push({ path, message: "lake elevations, depth and area must be finite and non-negative where applicable" });
    }
  });

  return issues;
}
