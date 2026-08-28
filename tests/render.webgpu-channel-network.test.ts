import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  terrainHydraulicGeometry,
  validateTerrainChannelGraphExport,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import {
  ChannelNetwork,
  channelGraphToHydrologyGeometry,
  macroLakeHasRenderableWetSupport,
  type ChannelNetworkGridLayout,
} from "../src/render/webgpu/water/ChannelNetwork";

function at(x: number, z: number, width: number): number {
  return z * width + x;
}

function fixtureMacro(
  layout: ChannelNetworkGridLayout,
  overrides: Partial<TerrainMacroEvolutionExport> = {},
): TerrainMacroEvolutionExport {
  const count = layout.width * layout.height;
  return {
    contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
    provenance: { worldSeed: "channel-fixture", deviceFingerprint: "node" },
    seaLevelMeters: 0,
    heightMeters: new Float32Array(count).fill(200),
    flowAccumulationAreaM2: new Float32Array(count),
    lakeMask: new Uint8Array(count),
    lakes: [],
    drainageBaseLevels: [],
    channelSeedTexelIndices: new Uint32Array(),
    ...overrides,
  };
}

function branchingFixture(): {
  readonly graph: TerrainChannelGraphExport;
  readonly macro: TerrainMacroEvolutionExport;
  readonly layout: ChannelNetworkGridLayout;
  readonly receivers: Int32Array;
} {
  const layout = { width: 7, height: 7, texelSizeMeters: 10, originX: 5, originZ: 5 };
  const count = layout.width * layout.height;
  const heights = new Float32Array(count).fill(200);
  const flow = new Float32Array(count);
  const receivers = new Int32Array(count);
  receivers.fill(-1);
  const cells = [
    { x: 1, z: 1, height: 110, area: 100, nextX: 2, nextZ: 2 },
    { x: 2, z: 2, height: 100, area: 200, nextX: 3, nextZ: 3 },
    { x: 5, z: 1, height: 108, area: 120, nextX: 4, nextZ: 2 },
    { x: 4, z: 2, height: 98, area: 220, nextX: 3, nextZ: 3 },
    { x: 3, z: 3, height: 88, area: 500, nextX: 3, nextZ: 4 },
    { x: 3, z: 4, height: 76, area: 1_000, nextX: 3, nextZ: 5 },
    { x: 3, z: 5, height: 64, area: 1_500, nextX: 3, nextZ: 6 },
    { x: 3, z: 6, height: 52, area: 2_000 },
  ] as const;
  for (const cell of cells) {
    const index = at(cell.x, cell.z, layout.width);
    heights[index] = cell.height;
    flow[index] = cell.area;
    if ("nextX" in cell) receivers[index] = at(cell.nextX, cell.nextZ, layout.width);
  }
  const terminal = at(3, 6, layout.width);
  const macro = fixtureMacro(layout, {
    heightMeters: heights,
    flowAccumulationAreaM2: flow,
    channelSeedTexelIndices: Uint32Array.from(cells.map((cell) => at(
      cell.x,
      cell.z,
      layout.width,
    ))),
    drainageBaseLevels: [{
      drainageId: 1,
      elevationMeters: heights[terminal]!,
      outletTexel: { x: 3, z: 6 },
      termination: "rim",
    }],
  });
  return {
    graph: new ChannelNetwork().extract(macro, { layout, receivers }),
    macro,
    layout,
    receivers,
  };
}

describe("terrain channel network (5-9)", () => {
  it("assertion 102: builds deterministic monotone topology with real confluences", () => {
    const fixture = branchingFixture();
    const repeated = new ChannelNetwork().extract(fixture.macro, {
      layout: fixture.layout,
      receivers: fixture.receivers,
    });

    expect(repeated).toEqual(fixture.graph);
    expect(validateTerrainChannelGraphExport(fixture.graph)).toEqual([]);
    expect(fixture.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);
    expect(fixture.graph.nodes.filter((node) => node.kind === "confluence")).toHaveLength(1);
    expect(fixture.graph.nodes.at(-1)?.termination).toBe("rim");

    for (const edge of fixture.graph.edges) {
      const upstream = fixture.graph.nodes.find((node) => node.nodeId === edge.upstreamNodeId)!;
      const downstream = fixture.graph.nodes.find((node) => node.nodeId === edge.downstreamNodeId)!;
      expect(edge.upstreamNodeId).toBeLessThan(edge.downstreamNodeId);
      expect(downstream.flowAccumulationAreaM2).toBeGreaterThanOrEqual(
        upstream.flowAccumulationAreaM2,
      );
      expect(edge.hydraulicGeometry).toEqual(
        terrainHydraulicGeometry(edge.flowAccumulationAreaM2),
      );
      expect(edge.bankElevationMeters).toBeGreaterThanOrEqual(edge.thalwegElevationMeters);
    }
    for (const node of fixture.graph.nodes.filter((candidate) => candidate.termination)) {
      expect(["sea", "rim", "lake"]).toContain(node.termination);
    }
  });

  it("decomposes the DAG at confluences and consumes exported hydraulics verbatim", () => {
    const { graph } = branchingFixture();
    const firstEdge = graph.edges[0]!;
    const exportedWidth = 77;
    const graphWithDistinctExport: TerrainChannelGraphExport = {
      ...graph,
      edges: graph.edges.map((edge) => edge.edgeId === firstEdge.edgeId
        ? {
            ...edge,
            hydraulicGeometry: { ...edge.hydraulicGeometry, wettedWidthMeters: exportedWidth },
          }
        : edge),
    };
    const geometry = channelGraphToHydrologyGeometry(graphWithDistinctExport);

    expect(geometry.rivers).toHaveLength(3);
    const incoming = geometry.rivers.filter((river) => river.termination === "confluence");
    const trunk = geometry.rivers.find((river) => river.termination === "boundary")!;
    expect(incoming).toHaveLength(2);
    expect(trunk).toBeDefined();
    for (const river of incoming) expect(river.points.at(-1)).toEqual(trunk.points[0]);
    expect(geometry.rivers.some((river) =>
      river.points.some((point) => point.widthMeters === exportedWidth))).toBe(true);

    const source = readFileSync(
      new URL("../src/render/webgpu/water/ChannelNetwork.ts", import.meta.url),
      "utf8",
    );
    const adapter = source.match(
      /export function channelGraphToHydrologyGeometry[\s\S]*$/u,
    )?.[0] ?? "";
    expect(adapter).not.toContain("terrainHydraulicGeometry(");
    expect(adapter).not.toContain("baseRiverWidthMeters");
    expect(adapter).not.toContain("maximumRiverWidthMeters");
  });

  it("exports conservative lake geometry at the exact spill elevation", () => {
    const layout = { width: 5, height: 5, texelSizeMeters: 100, originX: 50, originZ: 50 };
    const count = layout.width * layout.height;
    const heights = new Float32Array(count).fill(150);
    const flow = new Float32Array(count);
    const mask = new Uint8Array(count);
    const receivers = new Int32Array(count);
    receivers.fill(-1);
    const source = at(1, 1, layout.width);
    const outlet = at(2, 2, layout.width);
    heights[source] = 100;
    heights[outlet] = 80;
    flow[source] = 100;
    flow[outlet] = 500;
    receivers[source] = outlet;
    for (const [x, z] of [[2, 2], [3, 2], [2, 3], [3, 3]]) {
      mask[at(x!, z!, layout.width)] = 1;
    }
    const macro = fixtureMacro(layout, {
      heightMeters: heights,
      flowAccumulationAreaM2: flow,
      lakeMask: mask,
      // The producer exports every threshold-crossing texel, including wet
      // cells. Thinning must not turn the other three lake cells into isolated
      // one-node channels.
      channelSeedTexelIndices: Uint32Array.of(
        source,
        at(2, 2, layout.width),
        at(3, 2, layout.width),
        at(2, 3, layout.width),
        at(3, 3, layout.width),
      ),
      lakes: [{
        lakeId: 9,
        spillElevationMeters: 90,
        outletTexel: { x: 2, z: 2 },
        maximumDepthMeters: 10,
        surfaceAreaM2: 40_000,
      }],
    });
    const network = new ChannelNetwork();
    const graph = network.extract(macro, { layout, receivers });
    const outletNode = graph.nodes.find((node) => node.nodeId === graph.lakes[0]!.outletNodeId)!;
    const geometry = channelGraphToHydrologyGeometry(graph);

    expect(outletNode.termination).toBe("lake");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.lakePolygons[0]!.verticesXZ.length).toBeGreaterThanOrEqual(8);
    expect(geometry.lakes[0]!.boundary.every((point) => point.y === 90)).toBe(true);
    expect(geometry.lakes[0]!.areaSquareMeters).toBe(40_000);

    const serialized = network.serializeForWorker(graph);
    expect(serialized.transferables).toHaveLength(1);
    expect(serialized.graph.lakePolygons[0]!.verticesXZ).toEqual(
      graph.lakePolygons[0]!.verticesXZ,
    );
    expect(serialized.graph.lakePolygons[0]!.verticesXZ.buffer).not.toBe(
      graph.lakePolygons[0]!.verticesXZ.buffer,
    );
  });

  it("does not render a one-macro-cell square or a convex cover over a concave mask", () => {
    const layout = { width: 5, height: 5, texelSizeMeters: 100, originX: 50, originZ: 50 };
    const count = layout.width * layout.height;
    const outlet = at(2, 2, layout.width);
    const lakeMask = new Uint8Array(count);
    lakeMask[outlet] = 1;
    const flow = new Float32Array(count);
    flow[outlet] = 500;
    const graph = new ChannelNetwork().extract(fixtureMacro(layout, {
      flowAccumulationAreaM2: flow,
      lakeMask,
      channelSeedTexelIndices: Uint32Array.of(outlet),
      lakes: [{
        lakeId: 3,
        spillElevationMeters: 90,
        outletTexel: { x: 2, z: 2 },
        maximumDepthMeters: 10,
        // Deliberately above the legacy global threshold: the wet support,
        // not metadata alone, must decide whether a polygon is safe.
        surfaceAreaM2: 40_000,
      }],
    }), { layout });
    expect(graph.nodes.some((node) => node.termination === "lake")).toBe(true);
    expect(graph.lakes).toEqual([]);
    expect(graph.lakePolygons).toEqual([]);
    expect(channelGraphToHydrologyGeometry(graph).lakes).toEqual([]);

    const twoByTwoHull = Float32Array.of(0, 0, 200, 0, 200, 200, 0, 200);
    expect(macroLakeHasRenderableWetSupport(4, 100, 40_000, twoByTwoHull)).toBe(true);
    // Three wet cells in an L have 30,000 m² of support, while this convex
    // square covers 40,000 m² and would visibly flood the missing corner.
    expect(macroLakeHasRenderableWetSupport(3, 100, 40_000, twoByTwoHull)).toBe(false);
    expect(macroLakeHasRenderableWetSupport(1, 512, 262_144, Float32Array.of(
      0, 0, 512, 0, 512, 512, 0, 512,
    ))).toBe(false);
  });

  it("derives the same deterministic graph from the canonical export alone", () => {
    const fixture = branchingFixture();
    const derived = new ChannelNetwork().extract(fixture.macro, { layout: fixture.layout });
    expect(derived).toEqual(fixture.graph);
    expect(validateTerrainChannelGraphExport(derived)).toEqual([]);
  });
});
