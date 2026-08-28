import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TerrainClipmapSystem,
  terrainFallbackMaterialAxis,
  terrainWorldRevision,
  type TerrainComputeFactory,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import {
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "../src/render/webgpu/terrain/TerrainEvolutionContract";
import { ComputeBudget } from "../src/render/webgpu/core/ComputeBudget";
import {
  TERRAIN_CORNER_MORPH_LEVELS,
  TERRAIN_CORNER_MORPH_PACKED_MAX,
  TERRAIN_NODES_PER_SLOT_EDGE,
  TERRAIN_NODE_GRID_RESOLUTION,
  TERRAIN_PROVISIONAL_AXIS,
  terrainNodeSpanMeters,
  terrainPageFilterWidthMeters,
  terrainTexelSizeMeters,
} from "../src/render/webgpu/terrain/TerrainSpineContract";
import {
  buildTerrainNodeGrid,
  createTerrainNodeBuffers,
  packTerrainCornerMorphs,
  packTerrainNodeSubIndex,
  quantizeTerrainCornerMorphK,
  resolveTerrainResidentCornerMorphs,
  TERRAIN_CORNER_SYNC_MAX_LEAF_QUERIES_PER_NODE,
  TERRAIN_CORNER_SYNC_MAX_LEVEL_PROBES_PER_QUERY,
  TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
  selectTerrainNodes,
  terrainNodeMorphK,
  terrainNodeVertexMorphK,
  terrainScreenSpaceError,
  unpackTerrainCornerMorphs,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeCornerMorphs,
  type TerrainNodeSelectionDiagnostics,
  type TerrainNodeSelectionInput,
} from "../src/render/webgpu/terrain/TerrainQuadtree";
import {
  createWorldPageAddress,
  parentWorldPageAddress,
} from "../src/render/webgpu/world/pageKey";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
  SURFACE_MATERIALS_BY_BIOME,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import { WORLD_PAGE_BASE_EXTENT_METERS } from "../src/render/webgpu/world/pageGeometry";
import { rankWorldPageStreamingCandidates } from "../src/render/webgpu/world/streamingPriority";
import {
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  createWorld,
  sampleFilteredTerrainHeight,
} from "../src/world";

/**
 * `4-5` — the CDLOD quadtree, and the retirement of the CPU tile path.
 *
 * The suite this replaced tested a worker pool, hole-punched index buffers,
 * skirt walls and hand-placed rings, none of which exist after this item. What
 * replaces them is a selection whose properties are arithmetic: split on
 * MEASURED screen-space error, morph into the parent's lattice before the
 * swap, and close cracks analytically rather than by hiding them behind a
 * wall of skirt geometry.
 */

const BASE_SELECTION: TerrainNodeSelectionInput = {
  cameraX: 0,
  cameraY: 100,
  cameraZ: 0,
  // 1080p at a 60-degree vertical field of view.
  pixelsPerMeterAtUnitDistance: 1_080 / (2 * Math.tan((60 * Math.PI) / 360)),
  pixelThreshold: 3,
  nodeBudget: 240,
  finestResidentLevel: 0,
  coarsestLevel: 9,
  farPlaneMeters: 45_000,
  // The measured shape: `terrain-height-generate.test.ts` reports 0.135 m of
  // second difference on an L0 page, and it scales with texel size. A constant
  // deviation (which real pages never produce) would demand splitting
  // everywhere and terminate only on the budget.
  deviationFor: (address) => 0.135 * 2 ** address.level,
};

describe("terrain world revision (5-0/5-A)", () => {
  it("separates activated eroded pages from explicit analytic parity pages", () => {
    const eroded = createWorld("revision-world", {
      airport: false,
      worldEvolution: "eroded",
    });
    const analytic = createWorld("revision-world", {
      airport: false,
      worldEvolution: "analytic",
    });

    expect(terrainWorldRevision(eroded)).not.toBe(terrainWorldRevision(analytic));
    expect(terrainWorldRevision(eroded)).toContain("/eroded/");
    expect(terrainWorldRevision(analytic)).toContain("/analytic/");
  });
});

describe("terrain provisional material fallback", () => {
  it("keeps the retired categorical lane on the macro fallback's Grass base", () => {
    expect(terrainFallbackMaterialAxis()).toBe(TERRAIN_PROVISIONAL_AXIS.fallbackAxis);
    expect(terrainFallbackMaterialAxis()).toBe(SurfaceMaterial.Grass);
  });
});

function select(overrides: Partial<TerrainNodeSelectionInput> = {}): TerrainNode[] {
  return selectTerrainNodes({ ...BASE_SELECTION, ...overrides });
}

interface SharedTerrainEdge {
  readonly first: number;
  readonly second: number;
  /** `x` means x is fixed and z is the edge tangent; vice versa for `z`. */
  readonly fixedAxis: "x" | "z";
  readonly fixed: number;
  readonly tangentStart: number;
  readonly tangentEnd: number;
}

function sharedTerrainEdges(nodes: readonly TerrainNode[]): SharedTerrainEdge[] {
  const edges: SharedTerrainEdge[] = [];
  for (let first = 0; first < nodes.length; first += 1) {
    const a = nodes[first]!;
    const ax1 = a.originX + a.spanMeters;
    const az1 = a.originZ + a.spanMeters;
    for (let second = first + 1; second < nodes.length; second += 1) {
      const b = nodes[second]!;
      const bx1 = b.originX + b.spanMeters;
      const bz1 = b.originZ + b.spanMeters;
      const z0 = Math.max(a.originZ, b.originZ);
      const z1 = Math.min(az1, bz1);
      if ((ax1 === b.originX || bx1 === a.originX) && z1 > z0) {
        edges.push({
          first,
          second,
          fixedAxis: "x",
          fixed: ax1 === b.originX ? ax1 : bx1,
          tangentStart: z0,
          tangentEnd: z1,
        });
      }
      const x0 = Math.max(a.originX, b.originX);
      const x1 = Math.min(ax1, bx1);
      if ((az1 === b.originZ || bz1 === a.originZ) && x1 > x0) {
        edges.push({
          first,
          second,
          fixedAxis: "z",
          fixed: az1 === b.originZ ? az1 : bz1,
          tangentStart: x0,
          tangentEnd: x1,
        });
      }
    }
  }
  return edges;
}

function edgeGridPosition(
  node: TerrainNode,
  edge: SharedTerrainEdge,
  tangent: number,
): readonly [number, number] {
  const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
  const worldX = edge.fixedAxis === "x" ? edge.fixed : tangent;
  const worldZ = edge.fixedAxis === "z" ? edge.fixed : tangent;
  return [
    ((worldX - node.originX) / node.spanMeters) * quads,
    ((worldZ - node.originZ) / node.spanMeters) * quads,
  ];
}

interface TerrainVertexState {
  readonly morphK: number;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly normal: readonly [number, number, number];
}

/** Nested synthetic LOD fields: endpoint equality is independent of terrain content. */
function syntheticTerrainField(
  level: number,
  x: number,
  z: number,
): { readonly height: number; readonly gradientX: number; readonly gradientZ: number } {
  const phaseX = x * 0.00037 + level * 0.41;
  const phaseZ = z * 0.00029 - level * 0.23;
  return {
    height: level * 13 + x * 0.0017 - z * 0.0011
      + Math.sin(phaseX) * 7 + Math.cos(phaseZ) * 5,
    gradientX: 0.0017 + Math.cos(phaseX) * 7 * 0.00037,
    gradientZ: -0.0011 - Math.sin(phaseZ) * 5 * 0.00029,
  };
}

function terrainVertexState(
  node: TerrainNode,
  corners: TerrainNodeCornerMorphs,
  gridX: number,
  gridZ: number,
  fineResident = true,
): TerrainVertexState {
  const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
  const morphK = terrainNodeVertexMorphK(node.morphK, corners, gridX, gridZ, true);
  const evenX = Math.floor(gridX * 0.5) * 2;
  const evenZ = Math.floor(gridZ * 0.5) * 2;
  const morphedX = gridX + (evenX - gridX) * morphK;
  const morphedZ = gridZ + (evenZ - gridZ) * morphK;
  const x = node.originX + (morphedX / quads) * node.spanMeters;
  const z = node.originZ + (morphedZ / quads) * node.spanMeters;
  const parent = syntheticTerrainField(node.level + 1, x, z);
  const sampledFine = syntheticTerrainField(node.level, x, z);
  const fine = fineResident ? sampledFine : parent;
  const height = fine.height + (parent.height - fine.height) * morphK;
  const gradientX = fine.gradientX + (parent.gradientX - fine.gradientX) * morphK;
  const gradientZ = fine.gradientZ + (parent.gradientZ - fine.gradientZ) * morphK;
  const length = Math.hypot(gradientX, 1, gradientZ);
  return {
    morphK,
    x,
    z,
    height,
    normal: [-gradientX / length, 1 / length, -gradientZ / length],
  };
}

interface TerrainContinuityResult {
  readonly edges: number;
  readonly comparisons: number;
  readonly maxMorphError: number;
  readonly maxPositionError: number;
  readonly maxHeightError: number;
  readonly maxNormalError: number;
}

function terrainContinuityResult(
  nodes: readonly TerrainNode[],
  corners: readonly TerrainNodeCornerMorphs[] = nodes.map((node) => node.cornerMorphK),
  fineResident: (node: TerrainNode) => boolean = () => true,
): TerrainContinuityResult {
  let comparisons = 0;
  let maxMorphError = 0;
  let maxPositionError = 0;
  let maxHeightError = 0;
  let maxNormalError = 0;
  const compare = (
    firstIndex: number,
    firstGrid: readonly [number, number],
    secondIndex: number,
    secondGrid: readonly [number, number],
    morphError: number,
  ): void => {
    const firstNode = nodes[firstIndex]!;
    const secondNode = nodes[secondIndex]!;
    const first = terrainVertexState(
      firstNode, corners[firstIndex]!, firstGrid[0], firstGrid[1], fineResident(firstNode),
    );
    const second = terrainVertexState(
      secondNode, corners[secondIndex]!, secondGrid[0], secondGrid[1], fineResident(secondNode),
    );
    comparisons += 1;
    maxMorphError = Math.max(maxMorphError, morphError);
    maxPositionError = Math.max(
      maxPositionError,
      Math.abs(first.x - second.x),
      Math.abs(first.z - second.z),
    );
    maxHeightError = Math.max(maxHeightError, Math.abs(first.height - second.height));
    maxNormalError = Math.max(
      maxNormalError,
      ...first.normal.map((value, index) => Math.abs(value - second.normal[index]!)),
    );
  };

  const edges = sharedTerrainEdges(nodes);
  for (const edge of edges) {
    const firstNode = nodes[edge.first]!;
    const secondNode = nodes[edge.second]!;
    if (firstNode.level === secondNode.level) {
      // All 33 real edge vertices, including odd interiors where the old
      // per-node K produced different XZ and height on the two sides.
      for (let step = 0; step <= 32; step += 1) {
        const tangent = edge.tangentStart
          + ((edge.tangentEnd - edge.tangentStart) * step) / 32;
        const firstGrid = edgeGridPosition(firstNode, edge, tangent);
        const secondGrid = edgeGridPosition(secondNode, edge, tangent);
        const firstK = terrainNodeVertexMorphK(
          firstNode.morphK, corners[edge.first]!, firstGrid[0], firstGrid[1], true,
        );
        const secondK = terrainNodeVertexMorphK(
          secondNode.morphK, corners[edge.second]!, secondGrid[0], secondGrid[1], true,
        );
        compare(edge.first, firstGrid, edge.second, secondGrid, Math.abs(firstK - secondK));
      }
      continue;
    }

    const fineIndex = firstNode.level < secondNode.level ? edge.first : edge.second;
    const coarseIndex = fineIndex === edge.first ? edge.second : edge.first;
    const fineNode = nodes[fineIndex]!;
    const coarseNode = nodes[coarseIndex]!;
    // Fine odd vertices collapse onto their previous even vertex at K=1.
    // Compare the 17 unique positions to the real coarse edge vertices.
    for (let step = 0; step <= 32; step += 2) {
      const tangent = edge.tangentStart
        + ((edge.tangentEnd - edge.tangentStart) * step) / 32;
      const fineGrid = edgeGridPosition(fineNode, edge, tangent);
      const coarseGrid = edgeGridPosition(coarseNode, edge, tangent);
      const fineK = terrainNodeVertexMorphK(
        fineNode.morphK, corners[fineIndex]!, fineGrid[0], fineGrid[1], true,
      );
      const coarseK = terrainNodeVertexMorphK(
        coarseNode.morphK, corners[coarseIndex]!, coarseGrid[0], coarseGrid[1], true,
      );
      if (Math.max(Math.abs(1 - fineK), Math.abs(coarseK)) > 1e-10) {
        throw new Error(JSON.stringify({
          edge,
          fine: { level: fineNode.level, originX: fineNode.originX, originZ: fineNode.originZ,
            corners: corners[fineIndex], grid: fineGrid, k: fineK },
          coarse: { level: coarseNode.level, originX: coarseNode.originX,
            originZ: coarseNode.originZ, corners: corners[coarseIndex], grid: coarseGrid,
            k: coarseK },
        }));
      }
      compare(
        fineIndex,
        fineGrid,
        coarseIndex,
        coarseGrid,
        Math.max(Math.abs(1 - fineK), Math.abs(coarseK)),
      );
    }
  }

  // Edge-only checks miss two leaves that meet diagonally at one point. The
  // selector balances all touching neighbours because a two-level corner
  // would require a grandparent page the fine node does not carry.
  const cornerEntries = new Map<string, Array<{
    readonly nodeIndex: number;
    readonly grid: readonly [number, number];
  }>>();
  nodes.forEach((node, nodeIndex) => {
    const entries = [
      [node.originX, node.originZ, 0, 0],
      [node.originX + node.spanMeters, node.originZ, 32, 0],
      [node.originX, node.originZ + node.spanMeters, 0, 32],
      [node.originX + node.spanMeters, node.originZ + node.spanMeters, 32, 32],
    ] as const;
    for (const [x, z, gridX, gridZ] of entries) {
      const key = `${x}:${z}`;
      const incident = cornerEntries.get(key) ?? [];
      incident.push({ nodeIndex, grid: [gridX, gridZ] });
      cornerEntries.set(key, incident);
    }
  });
  for (const entries of cornerEntries.values()) {
    if (entries.length < 2) continue;
    const levels = entries.map((entry) => nodes[entry.nodeIndex]!.level);
    const minimumLevel = Math.min(...levels);
    const maximumLevel = Math.max(...levels);
    const first = entries[0]!;
    for (let index = 1; index < entries.length; index += 1) {
      const second = entries[index]!;
      const firstNode = nodes[first.nodeIndex]!;
      const secondNode = nodes[second.nodeIndex]!;
      const firstK = terrainNodeVertexMorphK(
        firstNode.morphK,
        corners[first.nodeIndex]!,
        first.grid[0],
        first.grid[1],
        true,
      );
      const secondK = terrainNodeVertexMorphK(
        secondNode.morphK,
        corners[second.nodeIndex]!,
        second.grid[0],
        second.grid[1],
        true,
      );
      const morphError = maximumLevel === minimumLevel
        ? Math.abs(firstK - secondK)
        : Math.max(
            Math.abs(firstK - (firstNode.level === minimumLevel ? 1 : 0)),
            Math.abs(secondK - (secondNode.level === minimumLevel ? 1 : 0)),
          );
      compare(
        first.nodeIndex,
        first.grid,
        second.nodeIndex,
        second.grid,
        morphError,
      );
    }
  }
  return {
    edges: edges.length,
    comparisons,
    maxMorphError,
    maxPositionError,
    maxHeightError,
    maxNormalError,
  };
}

describe("CDLOD node selection (4-5)", () => {
  it("makes a node's quad exactly the page's own texel spacing", () => {
    // 8×8 nodes per slot, 32 quads per node edge: 512·2^L / 8 / 32 = 2·2^L m.
    // Nodes and pages sample the same lattice by construction, which is what
    // lets the vertex shader address the atlas with an integer texel.
    for (let level = 0; level <= 9; level += 1) {
      expect(terrainNodeSpanMeters(level) / (TERRAIN_NODE_GRID_RESOLUTION - 1))
        .toBeCloseTo(terrainTexelSizeMeters(level), 9);
    }
    expect(TERRAIN_NODES_PER_SLOT_EDGE).toBe(8);
  });

  it("splits on measured error, not on a ring", () => {
    const near = terrainScreenSpaceError(12, 500, BASE_SELECTION.pixelsPerMeterAtUnitDistance);
    const far = terrainScreenSpaceError(12, 40_000, BASE_SELECTION.pixelsPerMeterAtUnitDistance);
    expect(near).toBeGreaterThan(far);
    // A page with no measurement is never split: splitting on a guess spends
    // the budget on ground nobody can see.
    const unmeasured = select({ deviationFor: () => null });
    expect(unmeasured.every((node) => node.level === BASE_SELECTION.coarsestLevel)).toBe(true);
    // …and a measured field splits near the camera and stays coarse far away.
    const detailed = select();
    const levels = detailed.map((node) => node.level);
    expect(Math.min(...levels)).toBeLessThan(Math.max(...levels));
    const nearest = detailed.reduce((best, node) =>
      node.distanceMeters < best.distanceMeters ? node : best);
    expect(nearest.level).toBe(Math.min(...levels));
  });

  it("respects the node budget and stays coarse rather than dropping ground", () => {
    for (const nodeBudget of [64, 160, 240, 448]) {
      const nodes = select({ nodeBudget, deviationFor: () => 400 });
      expect(nodes.length, `budget ${nodeBudget}`).toBeLessThanOrEqual(nodeBudget + 3);
      expect(nodes.length, `budget ${nodeBudget}`).toBeGreaterThan(0);
    }
    // Coarsest-first: a small budget must not spend itself on one quadrant and
    // leave the ground behind the aircraft missing.
    const tight = select({ nodeBudget: 64, deviationFor: () => 400 });
    const xs = tight.map((node) => node.originX);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
  });

  it("never selects below the tier's finest resident level", () => {
    const unrestricted = select({ cameraY: 30 });
    expect(Math.min(...unrestricted.map((node) => node.level))).toBe(0);
    const low = select({ cameraY: 30, finestResidentLevel: 1 });
    expect(Math.min(...low.map((node) => node.level))).toBe(1);
  });

  it("covers the ground without overlap at a uniform level", () => {
    const nodes = select({ deviationFor: () => null });
    const seen = new Set<string>();
    for (const node of nodes) {
      const key = `${node.originX}:${node.originZ}`;
      expect(seen.has(key), `duplicate node at ${key}`).toBe(false);
      seen.add(key);
    }
    // Every emitted node is one span apart on the grid its level defines.
    const span = terrainNodeSpanMeters(BASE_SELECTION.coarsestLevel);
    for (const node of nodes) {
      expect(Math.abs(node.originX % span)).toBe(0);
      expect(Math.abs(node.originZ % span)).toBe(0);
    }
  });

  it("morphs to exactly the parent lattice before the swap, and not after", () => {
    // The morph runs over the last quarter of the interval in which the node
    // is legal, so it is COMPLETE by the distance at which the parent takes
    // over — a morph that finishes at the swap is a pop at the swap.
    expect(terrainNodeMorphK(100, 1_000)).toBe(0);
    expect(terrainNodeMorphK(1_500, 1_000)).toBe(0);
    expect(terrainNodeMorphK(1_750, 1_000)).toBeCloseTo(0.5, 6);
    expect(terrainNodeMorphK(2_000, 1_000)).toBe(1);
    expect(terrainNodeMorphK(9_000, 1_000)).toBe(1);
    // A node with no measured deviation has no split distance and no morph.
    expect(terrainNodeMorphK(500, 0)).toBe(0);
    for (const node of select()) {
      expect(node.morphK).toBeGreaterThanOrEqual(0);
      expect(node.morphK).toBeLessThanOrEqual(1);
    }
  });

  it("uses 3D distance, so cruise does not split the ground below to L0", () => {
    const low = select({ cameraY: 50 });
    const cruise = select({ cameraY: 10_000 });
    expect(Math.min(...cruise.map((node) => node.level)))
      .toBeGreaterThan(Math.min(...low.map((node) => node.level)));
  });
});

describe("CDLOD node record (4-5)", () => {
  it("packs sub-index and page parity exactly", () => {
    for (let subZ = 0; subZ < 8; subZ += 1) {
      for (let subX = 0; subX < 8; subX += 1) {
        for (const parityX of [0, 1]) {
          for (const parityZ of [0, 1]) {
            const packed = packTerrainNodeSubIndex(subX, subZ, parityX, parityZ);
            expect(packed).toBe(subX + subZ * 8 + parityX * 64 + parityZ * 128);
            // Unpacked the way the vertex shader does it.
            const gotParityZ = Math.floor(packed / 128);
            const afterZ = packed - gotParityZ * 128;
            const gotParityX = Math.floor(afterZ / 64);
            const subIndex = afterZ - gotParityX * 64;
            expect(gotParityX).toBe(parityX);
            expect(gotParityZ).toBe(parityZ);
            expect(subIndex - Math.floor(subIndex / 8) * 8).toBe(subX);
            expect(Math.floor(subIndex / 8)).toBe(subZ);
          }
        }
      }
    }
    // 4.5-A3: the fourth lane is the provisional-axis override, not a packed
    // triple. Negative means "walk the axis per vertex from the displaced
    // height"; non-negative is an axis the shader must use verbatim, which is
    // the CPU's only remaining say in the fallback.
    expect(TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT).toBeLessThan(0);
    expect(TERRAIN_PROVISIONAL_AXIS.fallbackAxis).toBe(SurfaceMaterial.Grass);
    expect(TERRAIN_PROVISIONAL_AXIS.maxAxis).toBe(SurfaceMaterial.Snow);
    const biomePrimaries = new Set<number>(
      Object.values(SURFACE_MATERIALS_BY_BIOME).map((mix) => mix.primary),
    );
    expect(Math.max(...biomePrimaries)).toBeLessThanOrEqual(
      TERRAIN_PROVISIONAL_AXIS.maxAxis,
    );
    for (
      let materialId = TERRAIN_PROVISIONAL_AXIS.maxAxis + 1;
      materialId < SURFACE_MATERIAL_COUNT;
      materialId += 1
    ) {
      expect(biomePrimaries.has(materialId)).toBe(false);
    }
  });

  it("packs four quantized corner morphs into one exact f32 integer", () => {
    expect(TERRAIN_CORNER_MORPH_PACKED_MAX).toBe(2 ** 24 - 1);
    let random = 0x6d2b79f5;
    const next = (): number => {
      random = Math.imul(random ^ (random >>> 15), 1 | random);
      random ^= random + Math.imul(random ^ (random >>> 7), 61 | random);
      return ((random ^ (random >>> 14)) >>> 0) / 2 ** 32;
    };
    const cases: TerrainNodeCornerMorphs[] = [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 1, 0, 1],
    ];
    for (let index = 0; index < 2_048; index += 1) {
      cases.push([next(), next(), next(), next()]);
    }
    for (const corners of cases) {
      const packed = packTerrainCornerMorphs(corners);
      // Every possible payload is <= 2^24-1, the largest consecutive integer
      // an IEEE-754 f32 and WGSL vertex input can represent exactly.
      expect(packed).toBeGreaterThanOrEqual(0);
      expect(packed).toBeLessThanOrEqual(TERRAIN_CORNER_MORPH_PACKED_MAX);
      expect(Math.fround(packed)).toBe(packed);
      const decoded = unpackTerrainCornerMorphs(Math.fround(packed));
      for (let corner = 0; corner < 4; corner += 1) {
        const quantized = quantizeTerrainCornerMorphK(corners[corner]!);
        expect(decoded[corner]).toBe(quantized);
        expect(Math.abs(decoded[corner]! - corners[corner]!))
          .toBeLessThanOrEqual(0.5 / TERRAIN_CORNER_MORPH_LEVELS + Number.EPSILON);
      }
    }
  });

  it("writes a matrix per node and two stride-4 lanes", () => {
    const nodes = select();
    const slots = new Map<string, number>();
    const buffers = writeTerrainNodeBuffers({
      nodes,
      originX: 1_000,
      originZ: -500,
      slotFor: (address) => {
        const key = `${address.level}:${address.x}:${address.z}`;
        if (!slots.has(key)) slots.set(key, slots.size);
        return slots.get(key)!;
      },
      channelSlotFor: () => 5,
      provisionalAxisFor: () => TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
    }, createTerrainNodeBuffers(nodes.length));
    expect(buffers.count).toBe(nodes.length);
    expect(buffers.capacity).toBe(nodes.length);
    expect(buffers.matrices).toHaveLength(nodes.length * 16);
    expect(buffers.laneA).toHaveLength(nodes.length * 4);
    expect(buffers.laneB).toHaveLength(nodes.length * 4);
    // The matrix carries origin and scale for free, camera-relative like every
    // other world position the shaders see.
    expect(buffers.matrices[0]).toBe(nodes[0]!.spanMeters);
    expect(buffers.matrices[5]).toBe(1);
    expect(buffers.matrices[12]).toBe(nodes[0]!.originX - 1_000);
    expect(buffers.matrices[14]).toBe(nodes[0]!.originZ + 500);
    expect(buffers.matrices[15]).toBe(1);
    // Every lane value is finite and inside its packing range.
    for (let index = 0; index < nodes.length; index += 1) {
      expect(buffers.laneA[index * 4 + 1]).toBeLessThan(256);
      // Lane B's third slot is the CHANNEL lane, packed `slot * 32 + level`.
      expect(buffers.laneB[index * 4 + 2]).toBe(5 * 32 + nodes[index]!.level);
      expect(buffers.laneB[index * 4 + 3])
        .toBe(packTerrainCornerMorphs(nodes[index]!.cornerMorphK));
    }
  });

  it("forces morphK to zero when the parent page is not resident", () => {
    // Morphing toward a slot nothing has written is a hole in the ground.
    const nodes = select().filter((node) => node.morphK > 0);
    expect(nodes.length).toBeGreaterThan(0);
    const buffers = writeTerrainNodeBuffers({
      nodes,
      originX: 0,
      originZ: 0,
      slotFor: () => -1,
      channelSlotFor: () => -1,
      provisionalAxisFor: () => TERRAIN_PROVISIONAL_AXIS.fallbackAxis,
    }, createTerrainNodeBuffers(nodes.length));
    for (let index = 0; index < nodes.length; index += 1) {
      expect(buffers.laneB[index * 4]).toBe(0);
      expect(buffers.laneB[index * 4 + 1]).toBe(-1);
      const corners = unpackTerrainCornerMorphs(buffers.laneB[index * 4 + 3]!);
      // The shader's final guard is memory-safe even for a malformed caller:
      // packed edge K cannot address the unavailable parent slot.
      expect(terrainNodeVertexMorphK(nodes[index]!.morphK, corners, 0, 17, false)).toBe(0);
    }
  });

  it("builds one unit grid with no skirts", () => {
    const grid = buildTerrainNodeGrid();
    const edge = TERRAIN_NODE_GRID_RESOLUTION;
    expect(grid.positions).toHaveLength(edge * edge * 3);
    // 2,048 triangles, and NOT one more: a skirt would add 4 × 32 quads.
    expect(grid.indices).toHaveLength((edge - 1) * (edge - 1) * 6);
    expect((grid.indices!.length / 3)).toBe(2_048);
    // Unit-sized, so one geometry serves every level through the node matrix.
    const xs = Array.from({ length: edge * edge }, (_, index) => grid.positions![index * 3]!);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(1);
    const ys = Array.from({ length: edge * edge }, (_, index) => grid.positions![index * 3 + 1]!);
    expect(Math.max(...ys)).toBe(0);
  });
});

describe("CDLOD synchronized boundary morphs", () => {
  it("keeps the per-frame corner pass O(nodes) with at most three numeric level probes", () => {
    const diagnostics: TerrainNodeSelectionDiagnostics = {
      cornerLeafQueries: 0,
      cornerLeafLevelProbes: 0,
    };
    const nodes = selectTerrainNodes({
      ...BASE_SELECTION,
      nodeBudget: 320,
      // Saturate the tier-1 node budget so this guard covers the shipping
      // worst case rather than a small, easy partition.
      deviationFor: () => 1_000,
    }, diagnostics);

    // A split costs three nodes and its whole 2:1 closure must fit, so the
    // selector can finish a couple of slots below the literal capacity.
    expect(nodes.length).toBeGreaterThanOrEqual(300);
    expect(diagnostics.cornerLeafQueries).toBe(
      nodes.length * TERRAIN_CORNER_SYNC_MAX_LEAF_QUERIES_PER_NODE,
    );
    expect(diagnostics.cornerLeafLevelProbes).toBeLessThanOrEqual(
      diagnostics.cornerLeafQueries * TERRAIN_CORNER_SYNC_MAX_LEVEL_PROBES_PER_QUERY,
    );
    expect(diagnostics.cornerLeafLevelProbes).toBeGreaterThan(
      diagnostics.cornerLeafQueries,
    );
  });

  it("closes the exact adjacent-node counterexample while preserving interior K", () => {
    const nodes = select();
    const byCell = (level: number, x: number, z: number): TerrainNode | undefined =>
      nodes.find((node) => node.level === level
        && node.originX / node.spanMeters === x
        && node.originZ / node.spanMeters === z);
    const first = byCell(8, 0, -2);
    const second = byCell(8, 1, -2);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // This is the release-blocking selector output: the two nodes legitimately
    // retain very different interior transition weights.
    expect(Math.abs(first!.morphK - second!.morphK)).toBeGreaterThan(0.9);
    // Their complete shared edge nevertheless has one bit-identical K.
    for (let gridZ = 0; gridZ <= 32; gridZ += 1) {
      expect(terrainNodeVertexMorphK(first!.morphK, first!.cornerMorphK, 32, gridZ))
        .toBe(terrainNodeVertexMorphK(second!.morphK, second!.cornerMorphK, 0, gridZ));
    }
    const result = terrainContinuityResult(nodes);
    expect(result.edges).toBeGreaterThan(0);
    expect(result.maxMorphError).toBe(0);
    expect(result.maxPositionError).toBeLessThan(1e-9);
    expect(result.maxHeightError).toBeLessThan(1e-9);
    expect(result.maxNormalError).toBeLessThan(1e-12);
  });

  it("keeps XZ, endpoint height, and normals identical over randomized legal partitions", () => {
    let randomState = 0x9e3779b9;
    const random = (): number => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return (randomState >>> 0) / 2 ** 32;
    };
    let edgeCount = 0;
    let comparisonCount = 0;
    let mixedPartitions = 0;
    for (let iteration = 0; iteration < 48; iteration += 1) {
      const salt = Math.floor(random() * 0x7fffffff);
      const residency = new Map<string, number | null>();
      const deviationFor = (address: { level: number; x: number; z: number }): number | null => {
        const key = `${address.level}:${address.x}:${address.z}`;
        const existing = residency.get(key);
        if (existing !== undefined) return existing;
        let hash = salt ^ Math.imul(address.level + 17, 0x45d9f3b);
        hash ^= Math.imul(address.x, 0x27d4eb2d);
        hash ^= Math.imul(address.z, 0x165667b1);
        hash = (hash ^ (hash >>> 16)) >>> 0;
        const measured = hash % 13 !== 0;
        const value = measured
          ? (0.04 + ((hash >>> 8) % 500) / 1_000) * 2 ** address.level
          : null;
        residency.set(key, value);
        return value;
      };
      const coarsestLevel = 8 + Math.floor(random() * 2);
      const nodes = selectTerrainNodes({
        ...BASE_SELECTION,
        cameraX: (random() - 0.5) * 70_000,
        cameraY: 20 + random() * 8_000,
        cameraZ: (random() - 0.5) * 70_000,
        nodeBudget: 96 + Math.floor(random() * 320),
        finestResidentLevel: random() < 0.25 ? 1 : 0,
        coarsestLevel,
        deviationFor,
      });

      // Executable parent-residency proof: every emitted non-root child could
      // only exist after the exact parent page returned measured stats.
      for (const node of nodes) {
        if (node.level >= coarsestLevel) continue;
        const parent = parentWorldPageAddress(node.address)!;
        const parentKey = `${parent.level}:${parent.x}:${parent.z}`;
        expect(residency.get(parentKey), `parent of L${node.level} ${parentKey}`)
          .not.toBeNull();
        expect(residency.has(parentKey)).toBe(true);
      }

      const result = terrainContinuityResult(nodes);
      edgeCount += result.edges;
      comparisonCount += result.comparisons;
      if (new Set(nodes.map((node) => node.level)).size > 1) mixedPartitions += 1;
      expect(result.maxMorphError, `iteration ${iteration}`).toBe(0);
      expect(result.maxPositionError, `iteration ${iteration}`).toBeLessThan(1e-8);
      expect(result.maxHeightError, `iteration ${iteration}`).toBeLessThan(1e-8);
      expect(result.maxNormalError, `iteration ${iteration}`).toBeLessThan(1e-12);
    }
    expect(edgeCount).toBeGreaterThan(1_000);
    expect(comparisonCount).toBeGreaterThan(20_000);
    expect(mixedPartitions).toBeGreaterThan(20);
  }, 120_000);

  it("promotes both edge endpoints under one legal fine-page eviction", () => {
    const nodes = select({ cameraY: 150, nodeBudget: 320 });
    const edges = sharedTerrainEdges(nodes);
    const keyFor = (address: { level: number; x: number; z: number }): string =>
      `${address.level}:${address.x}:${address.z}`;
    const protectedParents = new Set(nodes
      .filter((node) => node.level < BASE_SELECTION.coarsestLevel)
      .map((node) => keyFor(parentWorldPageAddress(node.address)!)));
    const candidates = new Map<string, { same: number; crossFine: number }>();
    for (const edge of edges) {
      const first = nodes[edge.first]!;
      const second = nodes[edge.second]!;
      for (const node of [first, second]) {
        const key = keyFor(node.address);
        if (protectedParents.has(key)) continue;
        const score = candidates.get(key) ?? { same: 0, crossFine: 0 };
        if (first.level === second.level) score.same += 1;
        else if (node.level === Math.min(first.level, second.level)) score.crossFine += 1;
        candidates.set(key, score);
      }
    }
    const missingKey = [...candidates].find(([, score]) => score.same > 0 && score.crossFine > 0)?.[0];
    expect(missingKey, "a legal unprotected fine page touching same- and cross-level edges")
      .toBeDefined();
    const slotFor = (address: { level: number; x: number; z: number }): number =>
      keyFor(address) === missingKey ? -1 : 7;
    const resolved = resolveTerrainResidentCornerMorphs(nodes, slotFor);
    const buffers = writeTerrainNodeBuffers({
      nodes,
      originX: 0,
      originZ: 0,
      slotFor,
      channelSlotFor: () => -1,
      provisionalAxisFor: () => TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
    }, createTerrainNodeBuffers(nodes.length));
    const decoded = nodes.map((_, index) =>
      unpackTerrainCornerMorphs(buffers.laneB[index * 4 + 3]!));
    expect(decoded).toEqual(resolved);

    let affectedSameEdges = 0;
    let affectedCrossEdges = 0;
    for (const edge of edges) {
      const first = nodes[edge.first]!;
      const second = nodes[edge.second]!;
      const firstMissing = keyFor(first.address) === missingKey;
      const secondMissing = keyFor(second.address) === missingKey;
      if (!firstMissing && !secondMissing) continue;
      if (first.level === second.level) {
        affectedSameEdges += 1;
        // Interior samples prove both endpoints were promoted and linear K is
        // one across the complete edge, not merely equal at its corners.
        for (const step of [1, 7, 16, 25, 31]) {
          const tangent = edge.tangentStart
            + ((edge.tangentEnd - edge.tangentStart) * step) / 32;
          const firstGrid = edgeGridPosition(first, edge, tangent);
          const secondGrid = edgeGridPosition(second, edge, tangent);
          expect(terrainNodeVertexMorphK(
            first.morphK, decoded[edge.first]!, firstGrid[0], firstGrid[1], true,
          )).toBe(1);
          expect(terrainNodeVertexMorphK(
            second.morphK, decoded[edge.second]!, secondGrid[0], secondGrid[1], true,
          )).toBe(1);
        }
      } else {
        affectedCrossEdges += 1;
      }
    }
    expect(affectedSameEdges).toBeGreaterThan(0);
    expect(affectedCrossEdges).toBeGreaterThan(0);

    // Shadow cascades draw distance-filtered subsets. They must consume the
    // full beauty partition's residency resolution rather than recomputing a
    // corner after the missing peer has been filtered out.
    const promotedResidentIndex = nodes.findIndex((node, index) =>
      keyFor(node.address) !== missingKey
      && resolved[index]!.some((value, corner) => value !== node.cornerMorphK[corner]));
    expect(promotedResidentIndex).toBeGreaterThanOrEqual(0);
    const promotedNode = nodes[promotedResidentIndex]!;
    const shadowBuffers = writeTerrainNodeBuffers({
      nodes: [promotedNode],
      originX: 0,
      originZ: 0,
      slotFor,
      channelSlotFor: () => -1,
      provisionalAxisFor: () => TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
      cornerMorphsFor: (node) => resolved[nodes.indexOf(node)]!,
    }, createTerrainNodeBuffers(1));
    expect(unpackTerrainCornerMorphs(shadowBuffers.laneB[3]!))
      .toEqual(resolved[promotedResidentIndex]);

    for (let index = 0; index < nodes.length; index += 1) {
      if (decoded[index]!.some((morphK) => morphK > 0)) {
        expect(buffers.laneB[index * 4 + 1], `parent slot for node ${index}`)
          .toBeGreaterThanOrEqual(0);
      }
    }
    const result = terrainContinuityResult(
      nodes,
      decoded,
      (node) => keyFor(node.address) !== missingKey,
    );
    expect(result.maxMorphError).toBe(0);
    expect(result.maxPositionError).toBeLessThan(1e-9);
    expect(result.maxHeightError).toBeLessThan(1e-9);
    expect(result.maxNormalError).toBeLessThan(1e-12);
  });
});

describe("terrain quadtree host (4-5)", () => {
  function createSystem(quality: "low" | "medium" | "high" = "medium") {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("quadtree-host", { worldEvolution: "analytic" });
    const profile = resolveWebGpuQualityProfile(quality, "balanced");
    const system = new TerrainClipmapSystem(scene, world, profile);
    return { engine, scene, system, profile };
  }

  it("draws the ground with one beauty mesh and one caster mesh per cascade", () => {
    const { engine, scene, system, profile } = createSystem();
    try {
      system.update({ x: 0, y: 400, z: 0, velocityX: 60, velocityZ: 0 }, 1);
      const stats = system.statistics;
      expect(stats.nodes).toBeGreaterThan(0);
      expect(stats.nodes).toBeLessThanOrEqual(profile.cdlodNodeBudget + 3);
      // Terrain draw calls ≤ 12 (Gate 4C's exit criterion), and in fact it is
      // one plus the cascade count.
      expect(stats.drawCalls).toBe(1 + profile.shadowCascades);
      expect(stats.drawCalls).toBeLessThanOrEqual(12);

      const casters: Mesh[] = [];
      system.addShadowCasters((mesh) => casters.push(mesh));
      expect(casters).toHaveLength(profile.shadowCascades);
      for (const mesh of casters) {
        // No camera draws them, and the water mirror does not either.
        expect(mesh.layerMask).toBe(0);
        expect(mesh.metadata?.excludePlanarReflection).toBe(true);
        expect(mesh.material).toBe(system.pbrMaterial);
      }
      // The beauty mesh is NOT in the caster list: it would double every
      // terrain shadow draw and defeat the per-cascade split.
      expect(casters.some((mesh) => mesh.name === "terrain-cdlod")).toBe(false);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("admits the pages its nodes need, and their parents", async () => {
    // Driven through the `4.5-B4` compute seam: under NullEngine no page ever
    // completes, so the selector never splits and every node stays at the root
    // level — where there IS no parent to admit (`4.5-B1` stopped streaming
    // the L10 pages an L9 node can never morph into).
    const { engine, scene, system } = createSeamedSystem();
    try {
      await pump(system, 12, { x: 0, y: 200, z: 0, velocityX: 0, velocityZ: 0 });
      const residency = system.atlases.height.residency;
      expect(residency.entries.length).toBeGreaterThan(0);
      const levels = new Set(residency.entries.map((slot) => slot.address.level));
      // A node's parent page must be resident too: the geomorph samples it.
      expect(levels.size).toBeGreaterThan(1);
      const selected = system.selectedNodes;
      expect(Math.max(...selected.map((node) => node.level))).toBe(9);
      const finest = Math.min(...selected.map((node) => node.level));
      expect(finest).toBeLessThan(9);
      expect(levels.has(finest + 1), "a split node's parent page was not admitted").toBe(true);
      // Channel slots track height slots one for one (the co-residency rule).
      expect(system.atlases.channel.residency.entries.length)
        .toBe(residency.entries.length);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("keeps the shadow-caster-distance lever attached to something", () => {
    const { engine, scene, system } = createSystem();
    try {
      system.update({ x: 0, y: 120, z: 0, velocityX: 0, velocityZ: 0 }, 1);
      const wide: Mesh[] = [];
      system.addShadowCasters((mesh) => wide.push(mesh));
      const wideCounts = wide.map((mesh) => mesh.thinInstanceCount);
      // Governor B rung "shadow-caster-distance" survived the 151→1 mesh
      // collapse: shrinking it must actually shrink what casts.
      system.update({ x: 0, y: 120, z: 0, velocityX: 0, velocityZ: 0 }, 2);
      system.addShadowCasters(() => undefined, 200);
      system.update({ x: 0, y: 120, z: 0, velocityX: 0, velocityZ: 0 }, 3);
      const narrow: Mesh[] = [];
      system.addShadowCasters((mesh) => narrow.push(mesh), 200);
      const narrowTotal = narrow.reduce((sum, mesh) => sum + mesh.thinInstanceCount, 0);
      const wideTotal = wideCounts.reduce((sum, count) => sum + count, 0);
      expect(narrowTotal).toBeLessThan(wideTotal);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("rebuilds the atlases and caster meshes when the profile reshapes them", () => {
    const { engine, scene, system } = createSystem("medium");
    try {
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 1);
      const before = system.atlases.height.residency.slotCount;
      const ultra = resolveWebGpuQualityProfile("high", "ultra");
      system.setProfile(ultra);
      expect(system.atlases.height.residency.slotCount).toBe(ultra.heightAtlasSlots);
      expect(system.atlases.height.residency.slotCount).not.toBe(before);
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 2);
      const casters: Mesh[] = [];
      system.addShadowCasters((mesh) => casters.push(mesh));
      expect(casters).toHaveLength(ultra.shadowCascades);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("keeps the streaming pump under Governor B's request budget", () => {
    const { engine, scene, system } = createSystem();
    try {
      system.setRequestBudgetPerUpdate(2);
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 1);
      expect(system.atlases.height.residency.entries.length).toBeLessThanOrEqual(2);
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 2);
      expect(system.atlases.height.residency.entries.length).toBeLessThanOrEqual(4);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("selects a page address whose node block matches the page geometry", () => {
    // The selector derives page addresses from node coordinates; a mismatch
    // would put a node's texels in the wrong slot and be invisible on screen
    // until the ground looked subtly wrong.
    for (const node of select()) {
      const span = terrainNodeSpanMeters(node.level);
      const nodeX = Math.round(node.originX / span);
      const nodeZ = Math.round(node.originZ / span);
      expect(node.address).toEqual(createWorldPageAddress(
        node.level,
        Math.floor(nodeX / 8),
        Math.floor(nodeZ / 8),
      ));
      expect(node.subNodeX).toBe(nodeX - Math.floor(nodeX / 8) * 8);
      expect(node.subNodeZ).toBe(nodeZ - Math.floor(nodeZ / 8) * 8);
    }
  });
});

// ---------------------------------------------------------------------------
// `4.5-A1` — the global error queue and its 2:1 neighbour clamp.
//
// The per-level split loop this replaced CONVERGED: with a 240-node budget it
// terminated with the whole world at L5-L7 at both 150 m and 3,000 m, which is
// kilometre-scale height texels under the aircraft — the "splotches of solid
// colour" the phase exists to fix. The two assertions below are what makes
// that state a test failure rather than a screenshot nobody re-reads.
// ---------------------------------------------------------------------------

/**
 * The deviation the page generator MEASURES, reproduced on the CPU: the
 * largest second difference over the page, at the level's own texel spacing
 * and band-limiting width. Sub-sampled on a 16-texel stride, which can only
 * UNDER-report the maximum — so a selector that reaches L2 against these
 * numbers reaches at least L2 against the real ones.
 */
function realKernelDeviations(seed: string): (address: {
  readonly level: number;
  readonly x: number;
  readonly z: number;
}) => number {
  const world = createWorld(seed, { worldEvolution: "analytic" });
  const cache = new Map<string, number>();
  return (address) => {
    const key = `${address.level}:${address.x}:${address.z}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const texel = terrainTexelSizeMeters(address.level);
    const width = terrainPageFilterWidthMeters(address.level);
    const minX = address.x * WORLD_PAGE_BASE_EXTENT_METERS * 2 ** address.level;
    const minZ = address.z * WORLD_PAGE_BASE_EXTENT_METERS * 2 ** address.level;
    let worst = 0;
    for (let row = 0; row < 256; row += 16) {
      for (let column = 0; column < 256; column += 16) {
        const x = minX + column * texel;
        const z = minZ + row * texel;
        const here = sampleFilteredTerrainHeight(world, x, z, width);
        worst = Math.max(
          worst,
          Math.abs(here - 0.5 * (
            sampleFilteredTerrainHeight(world, x - texel, z, width)
            + sampleFilteredTerrainHeight(world, x + texel, z, width))),
          Math.abs(here - 0.5 * (
            sampleFilteredTerrainHeight(world, x, z - texel, width)
            + sampleFilteredTerrainHeight(world, x, z + texel, width))),
        );
      }
    }
    cache.set(key, worst);
    return worst;
  };
}

/**
 * Largest level difference between edge-adjacent selected nodes.
 *
 * Only the "walk up" direction is checked, and that is sufficient rather than
 * an approximation: for any adjacent pair the COARSER node is an ancestor of
 * the finer one's neighbour cell, so walking up from every node's four
 * neighbour cells visits every adjacent pair exactly once from its fine side.
 */
function worstNeighbourLevelGap(
  nodes: readonly TerrainNode[],
  coarsestLevel: number,
): number {
  const selected = new Set<string>();
  for (const node of nodes) {
    const span = terrainNodeSpanMeters(node.level);
    selected.add(`${node.level}:${Math.round(node.originX / span)}:${Math.round(node.originZ / span)}`);
  }
  let worst = 0;
  for (const node of nodes) {
    const span = terrainNodeSpanMeters(node.level);
    const nodeX = Math.round(node.originX / span);
    const nodeZ = Math.round(node.originZ / span);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let level = node.level; level <= coarsestLevel; level += 1) {
        const step = 2 ** (level - node.level);
        const key = `${level}:${Math.floor((nodeX + dx) / step)}:${Math.floor((nodeZ + dz) / step)}`;
        if (!selected.has(key)) continue;
        worst = Math.max(worst, level - node.level);
        break;
      }
    }
  }
  return worst;
}

describe("CDLOD distance-graded selection (4.5-A1)", () => {
  it("assertion 107: reaches L2 under the camera at 500 ft on real deviations", () => {
    const seed = "phase1-perf-baseline";
    const world = createWorld(seed, { worldEvolution: "analytic" });
    const profile = resolveWebGpuQualityProfile("medium", "balanced");
    const airportX = world.airport?.centerX ?? 0;
    const airportZ = world.airport?.centerZ ?? 0;
    const ground = sampleFilteredTerrainHeight(world, airportX, airportZ, 0);
    const nodes = selectTerrainNodes({
      cameraX: airportX,
      // 500 ft AGL, the approach pose the capture's worst SSIM shots fly.
      cameraY: ground + 152,
      cameraZ: airportZ,
      pixelsPerMeterAtUnitDistance: 720 / (2 * Math.tan((60 * Math.PI) / 360)),
      pixelThreshold: profile.cdlodPixelThreshold,
      nodeBudget: profile.cdlodNodeBudget,
      finestResidentLevel: profile.finestResidentLevel,
      coarsestLevel: 9,
      farPlaneMeters: 45_000,
      deviationFor: realKernelDeviations(seed),
    });
    const underCamera = nodes.reduce(
      (best, node) => (node.distanceMeters < best.distanceMeters ? node : best));
    expect(underCamera.level, "level under the camera at the approach pose")
      .toBeLessThanOrEqual(2);
    // The horizon is still covered: the roots are emitted first and a split
    // only ever subdivides, so coverage cannot be traded for near detail.
    expect(Math.max(...nodes.map((node) => node.level))).toBe(9);
    expect(nodes.length).toBeLessThanOrEqual(profile.cdlodNodeBudget);
    // Page demand stays far inside the atlas — the reason the budget could be
    // raised at all.
    const pages = new Set(nodes.map((node) =>
      `${node.address.level}:${node.address.x}:${node.address.z}`));
    expect(pages.size).toBeLessThan(profile.heightAtlasSlots / 2);
  }, 120_000);

  it("assertion 108: never puts a >1 level step across an edge", () => {
    // The analytic crack closure guarantees seam identity across ONE level of
    // difference. With skirts deleted, a two-level step is a hole in the
    // ground — so the clamp is a property of the selector, swept rather than
    // spot-checked.
    const deviations = realKernelDeviations("phase1-perf-baseline");
    for (const altitude of [2, 150, 900, 3_000, 10_000]) {
      for (const [x, z] of [[0, 0], [4_137, -9_221], [-31_500, 18_400], [512, 512]] as const) {
        for (const [budget, finest] of [[160, 1], [320, 0], [640, 0]] as const) {
          const nodes = selectTerrainNodes({
            ...BASE_SELECTION,
            cameraX: x,
            cameraY: altitude,
            cameraZ: z,
            nodeBudget: budget,
            finestResidentLevel: finest,
            deviationFor: deviations,
          });
          expect(
            worstNeighbourLevelGap(nodes, BASE_SELECTION.coarsestLevel),
            `budget ${budget} at (${x}, ${altitude}, ${z})`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    // Non-vacuous: the same sweep on the synthetic constant-shape deviations
    // has to produce more than one level, or the clamp is trivially satisfied.
    const spread = selectTerrainNodes({ ...BASE_SELECTION, cameraY: 150 });
    expect(new Set(spread.map((node) => node.level)).size).toBeGreaterThan(2);
  }, 300_000);

  it("spends the budget where the error is, not evenly across a level", () => {
    // The defect this replaces: the per-level loop converged with EVERY node
    // at L5-L7 whatever the altitude, because it spent the budget on the
    // horizon before it ever reached the ground under the aircraft.
    const nodes = selectTerrainNodes({ ...BASE_SELECTION, cameraY: 150 });
    const nearest = nodes.reduce(
      (best, node) => (node.distanceMeters < best.distanceMeters ? node : best));
    const farthest = nodes.reduce(
      (best, node) => (node.distanceMeters > best.distanceMeters ? node : best));
    expect(farthest.level - nearest.level).toBeGreaterThanOrEqual(3);
    // Nearest first, so a truncation at the buffer capacity keeps the near
    // field.
    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index]!.distanceMeters).toBeGreaterThanOrEqual(
        nodes[index - 1]!.distanceMeters);
    }
  });

  it("emits a partition: no selected node contains another", () => {
    // The selected set must be a PARTITION of the ground: every point covered
    // once. The forced-split closure is where that could break — it comes off
    // a stack finest-first, and applying a split before its parent's leaves a
    // node in both the split set and the leaf set, drawn on top of its own
    // children. The 2:1 invariant makes that unreachable today (a forced chain
    // is one node deep); this is the assertion that says so, and it is
    // invisible to a level-gap check (which sees a set) and to a node count.
    const deviations = realKernelDeviations("phase1-perf-baseline");
    for (const altitude of [30, 150, 900, 4_000]) {
      for (const [x, z] of [[0, 0], [4_137, -9_221], [512, 512]] as const) {
        const nodes = selectTerrainNodes({
          ...BASE_SELECTION,
          cameraX: x,
          cameraY: altitude,
          cameraZ: z,
          deviationFor: deviations,
        });
        const selected = new Set(nodes.map((node) => {
          const span = terrainNodeSpanMeters(node.level);
          return `${node.level}:${Math.round(node.originX / span)}:${Math.round(node.originZ / span)}`;
        }));
        expect(selected.size, `duplicate node at (${x}, ${altitude}, ${z})`)
          .toBe(nodes.length);
        for (const node of nodes) {
          const span = terrainNodeSpanMeters(node.level);
          let nodeX = Math.round(node.originX / span);
          let nodeZ = Math.round(node.originZ / span);
          for (let level = node.level + 1; level <= BASE_SELECTION.coarsestLevel; level += 1) {
            nodeX = Math.floor(nodeX / 2);
            nodeZ = Math.floor(nodeZ / 2);
            expect(
              selected.has(`${level}:${nodeX}:${nodeZ}`),
              `L${node.level} node is covered by an L${level} node as well`,
            ).toBe(false);
          }
        }
      }
    }
  }, 300_000);

  it("never splits an unmeasured page, even to satisfy the clamp", () => {
    // A forced split inside the 2:1 closure is still a split, and splitting on
    // a guess is what the never-split-unmeasured rule exists to prevent. The
    // clamp gives way instead: the split that would have needed it is refused.
    const measuredLevel = 7;
    const nodes = selectTerrainNodes({
      ...BASE_SELECTION,
      cameraY: 150,
      deviationFor: (address) =>
        (address.level >= measuredLevel ? 0.135 * 2 ** address.level : null),
    });
    expect(Math.min(...nodes.map((node) => node.level))).toBe(measuredLevel - 1);
    expect(worstNeighbourLevelGap(nodes, BASE_SELECTION.coarsestLevel))
      .toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Gate `4.5-B` — the streaming half of "the terrain constantly struggles to
// load". Every defect below is one a green NullEngine suite could not see,
// because under NullEngine the atlases hold no textures and the system never
// constructs a compute producer at all. `computeFactory` is the seam.
// ---------------------------------------------------------------------------

/**
 * A compute factory that completes whatever it is handed, so residency runs
 * end to end in Node. It also records which batches it was given, which is how
 * assertion 115 sees the ORDER pages are admitted in.
 */
function recordingComputeFactory(): {
  readonly factory: TerrainComputeFactory;
  readonly generatedBatches: { readonly x: number; readonly z: number }[][];
  readonly builds: number;
} {
  const generatedBatches: { readonly x: number; readonly z: number }[][] = [];
  const state = { builds: 0 };
  const factory: TerrainComputeFactory = ({ heightAtlas, channelAtlas, existingPyramid }) => {
    state.builds += 1;
    return {
      pageGenerator: {
        generate: async (slots) => {
          generatedBatches.push(slots.map((slot) => {
            const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** slot.address.level;
            return {
              x: (slot.address.x + 0.5) * extent,
              z: (slot.address.z + 0.5) * extent,
            };
          }));
          // Completion lands a microtask later, as the real one does: the
          // dispatch is encoded synchronously and the bounds readback resolves
          // afterwards. Without the boundary a test could never observe the
          // pending set the pump actually ranked.
          await Promise.resolve();
          for (const slot of slots) {
            if (!slot.token) continue;
            heightAtlas.residency.complete(slot.key, slot.token, {
              minHeightMeters: 0,
              maxHeightMeters: 100,
              maxDeviationFromParent: 4,
            });
          }
        },
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      occlusionBake: {
        bake: async (slots) => slots,
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      splatBake: {
        bake: async (slots) => slots.length,
        consumeMeasuredDispatchCostMs: () => null,
        dispose: () => undefined,
      },
      pyramid: existingPyramid ?? {
        recenter: async () => undefined,
        isResident: true,
        dispose: () => undefined,
      },
      // channelAtlas is unused by the fake, but naming it keeps the factory's
      // shape honest against the real one.
      ...(channelAtlas ? {} : {}),
    };
  };
  return { factory, generatedBatches, get builds() { return state.builds; } };
}

function createSeamedSystem(quality: "low" | "medium" | "high" = "medium") {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const world = createWorld("quadtree-streaming", { worldEvolution: "analytic" });
  const profile = resolveWebGpuQualityProfile(quality, "balanced");
  const recording = recordingComputeFactory();
  const system = new TerrainClipmapSystem(scene, world, profile, {
    computeFactory: recording.factory,
  });
  return { engine, scene, system, profile, recording };
}

/** Run `count` update/settle cycles, letting the fake producers' promises land. */
async function pump(
  system: TerrainClipmapSystem,
  count: number,
  observer: { x: number; y: number; z: number; velocityX: number; velocityZ: number },
  startFrame = 1,
): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    system.update(observer, startFrame + frame);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe("terrain streaming lifecycle (4.5-B)", () => {
  it("5D holds eroded admissions until the canonical macro authority arrives", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("eroded-streaming-gate", {
      airport: false,
      worldEvolution: "eroded",
    });
    const recording = recordingComputeFactory();
    const system = new TerrainClipmapSystem(
      scene,
      world,
      resolveWebGpuQualityProfile("medium", "balanced"),
      { computeFactory: recording.factory },
    );
    const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
    try {
      await pump(system, 3, observer);
      expect(recording.generatedBatches).toHaveLength(0);
      const macro: TerrainMacroEvolutionExport = {
        contractVersion: TERRAIN_EVOLUTION_CONTRACT_VERSION,
        provenance: { worldSeed: world.seed, deviceFingerprint: "streaming-fixture" },
        seaLevelMeters: world.seaLevel,
        heightMeters: new Float32Array(0),
        flowAccumulationAreaM2: new Float32Array(0),
        lakeMask: new Uint8Array(0),
        lakes: [],
        drainageBaseLevels: [],
        channelSeedTexelIndices: new Uint32Array(0),
      };
      system.setMacroEvolution(macro);
      await pump(system, 3, observer, 10);
      expect(recording.generatedBatches.length).toBeGreaterThan(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("assertion 116: a reshaping setProfile still brings a page to resident", async () => {
    const { engine, scene, system } = createSeamedSystem("medium");
    try {
      const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
      await pump(system, 6, observer);
      expect(system.atlases.height.residency.residentCount).toBeGreaterThan(0);

      // high+ultra reshapes both atlases (196 -> 256 slots). Before 4.5-B4 the
      // generator kept the DISPOSED atlas, `generate()` early-returned on
      // `!hasTextures` forever, and terrain streaming was silently dead for the
      // rest of the session — with slots piling up un-evictable in
      // `generating`.
      const ultra = resolveWebGpuQualityProfile("high", "ultra");
      system.setProfile(ultra);
      expect(system.atlases.height.residency.residentCount).toBe(0);
      await pump(system, 8, observer, 100);
      expect(
        system.atlases.height.residency.residentCount,
        "no page became resident after a reshaping quality switch",
      ).toBeGreaterThan(0);

      // …and back down again, which is the other direction the exit checklist
      // asks for.
      system.setProfile(resolveWebGpuQualityProfile("medium", "balanced"));
      await pump(system, 8, observer, 200);
      expect(system.atlases.height.residency.residentCount).toBeGreaterThan(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("assertion 111: re-requests a channel slot whose admission failed", async () => {
    const { engine, scene, system } = createSeamedSystem("medium");
    try {
      const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
      await pump(system, 6, observer);
      const channel = system.atlases.channel.residency;
      const height = system.atlases.height.residency;
      const resident = height.entries.find((slot) => slot.lifecycle.state === "resident")!;
      expect(resident).toBeDefined();

      // Fail its channel admission the way a full atlas or a failed bake does.
      const channelSlot = channel.get(resident.key)!;
      if (channelSlot.token) {
        channel.fail(channelSlot.key, channelSlot.token, "simulated admission failure");
      } else {
        channel.release(channelSlot.key);
      }
      expect(channel.get(resident.key)).toBeUndefined();

      // Before 4.5-A3(b) the height-resident branch `continue`d after a
      // `touch()` that no-ops on a missing key, so the page shaded the
      // provisional fallback until the HEIGHT page was evicted — permanently,
      // in practice.
      await pump(system, 4, observer, 100);
      expect(
        channel.get(resident.key),
        "a failed channel admission was never re-requested",
      ).toBeDefined();
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("assertion 115: admits the corridor ahead, not the queue's head", async () => {
    const { engine, scene, system, recording } = createSeamedSystem("medium");
    try {
      // Converge high, where the selector wants few coarse pages.
      await pump(system, 25, { x: 0, y: 6_000, z: 0, velocityX: 80, velocityZ: 0 });

      // Then fly a course change at low level. The backlog is small by
      // construction — page DEMAND cannot run ahead of measurement, because
      // the selector only splits pages whose deviation it already has — so
      // this is not "tens of stale requests"; it is two or three, and which
      // one drains first is still the difference between streaming the ground
      // ahead and streaming the ground behind.
      const headings: readonly (readonly [number, number])[] = [
        [0, 80], [-80, 0], [0, -80], [80, 0],
      ];
      const centre = (slot: { address: { level: number; x: number; z: number } }) => {
        const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** slot.address.level;
        return { x: (slot.address.x + 0.5) * extent, z: (slot.address.z + 0.5) * extent };
      };
      let checked = 0;
      let divergedFromFifo = 0;
      let frame = 500;
      for (const [velocityX, velocityZ] of headings) {
        for (let repeat = 0; repeat < 6; repeat += 1) {
          const observer = { x: 0, y: 250, z: 0, velocityX, velocityZ };
          const boundary = recording.generatedBatches.length;
          system.update(observer, frame);
          frame += 1;
          // Read BEFORE the microtask flush: this is the set the pump ranked,
          // with the page it chose still in it.
          const pending = system.atlases.height.residency.entries.filter(
            (slot) => slot.lifecycle.state === "generating"
              && slot.token !== null
              && !slot.generationSubmitted);
          const admitted = recording.generatedBatches.slice(boundary).flat();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          if (pending.length < 2 || admitted.length === 0) continue;
          // The order the pump used to drain — `residency.entries` is Map
          // insertion order — against the order the SHARED flight-corridor
          // priority (0-3) puts them in. Ranked here from the module the
          // renderer and the detail streamer both use, not from the clipmap's
          // internals.
          const ranked = rankWorldPageStreamingCandidates(
            pending.map((slot) => ({ address: slot.address, slot })),
            {
              positionX: observer.x,
              positionY: observer.y,
              positionZ: observer.z,
              velocityX: observer.velocityX,
              velocityZ: observer.velocityZ,
            },
            { basePageExtentMeters: WORLD_PAGE_BASE_EXTENT_METERS, levelPenaltyMeters: 400 },
          );
          const rankedHead = centre(ranked[0]!.candidate.slot);
          const fifoHead = centre(pending[0]!);
          expect(admitted[admitted.length - 1]!.x).toBeCloseTo(rankedHead.x, 3);
          expect(admitted[admitted.length - 1]!.z).toBeCloseTo(rankedHead.z, 3);
          checked += 1;
          if (fifoHead.x !== rankedHead.x || fifoHead.z !== rankedHead.z) divergedFromFifo += 1;
        }
      }
      expect(checked, "no pump had a backlog to re-rank").toBeGreaterThan(0);
      // Non-vacuous: at least once the corridor's choice must differ from the
      // queue's head, or FIFO would have passed every assertion above.
      expect(divergedFromFifo, "the corridor ranking never differed from FIFO")
        .toBeGreaterThan(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("4.5-A3(c): re-bakes the splat when the season bucket rolls over", async () => {
    const { engine, scene, system } = createSeamedSystem("medium");
    try {
      const observer = { x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 };
      await pump(system, 8, observer);
      const channel = system.atlases.channel.residency;
      const baked = channel.entries.filter((slot) => slot.bakedSeasonDay !== null);
      expect(baked.length).toBeGreaterThan(0);
      const firstDay = baked[0]!.bakedSeasonDay;

      // Half a year later: a different bucket, so every resident slot's splat
      // is stale. Before this the bake keyed on `invariantSlotKey` and ran
      // once, so the snowline froze at whatever day the page streamed in on.
      system.setSeasonalDayOfYear(TERRAIN_REFERENCE_DAY_OF_YEAR + 180);
      await pump(system, 12, observer, 100);
      const rebaked = channel.entries.filter(
        (slot) => slot.bakedSeasonDay !== null && slot.bakedSeasonDay !== firstDay);
      expect(rebaked.length, "no resident slot was re-baked for the new season")
        .toBeGreaterThan(0);
    } finally {
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("assertion 112 in the owner's call sites: one compute frame per update", () => {
    // Both terrain pumps used to call `ComputeBudget.beginFrame()`, so each
    // wiped the other's plan and spent a fresh cap — the 4-0b "one cap"
    // invariant broken in the owner's own code.
    const { engine, scene, system } = createSeamedSystem("medium");
    const beginFrame = ComputeBudget.prototype.beginFrame;
    let calls = 0;
    ComputeBudget.prototype.beginFrame = function counted(this: ComputeBudget) {
      calls += 1;
      beginFrame.call(this);
    };
    try {
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 1);
      expect(calls).toBe(1);
      system.update({ x: 0, y: 300, z: 0, velocityX: 0, velocityZ: 0 }, 2);
      expect(calls).toBe(2);
    } finally {
      ComputeBudget.prototype.beginFrame = beginFrame;
      system.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
