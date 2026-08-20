import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  TerrainClipmapSystem,
  type TerrainComputeFactory,
} from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import { ComputeBudget } from "../src/render/webgpu/core/ComputeBudget";
import {
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
  packTerrainNodeSubIndex,
  TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT,
  selectTerrainNodes,
  terrainNodeMorphK,
  terrainScreenSpaceError,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeSelectionInput,
} from "../src/render/webgpu/terrain/TerrainQuadtree";
import { createWorldPageAddress } from "../src/render/webgpu/world/pageKey";
import {
  SURFACE_MATERIAL_COUNT,
  SurfaceMaterial,
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

function select(overrides: Partial<TerrainNodeSelectionInput> = {}): TerrainNode[] {
  return selectTerrainNodes({ ...BASE_SELECTION, ...overrides });
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
    expect(TERRAIN_PROVISIONAL_AXIS.maxAxis).toBe(SURFACE_MATERIAL_COUNT - 1);
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

describe("terrain quadtree host (4-5)", () => {
  function createSystem(quality: "low" | "medium" | "high" = "medium") {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const world = createWorld("quadtree-host");
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
  const world = createWorld(seed);
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
    const world = createWorld(seed);
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
  const world = createWorld("quadtree-streaming");
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
              && !slot.texelsResident);
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
