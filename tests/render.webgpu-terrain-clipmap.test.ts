import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { TerrainClipmapSystem } from "../src/render/webgpu/terrain/TerrainClipmapSystem";
import {
  TERRAIN_NODES_PER_SLOT_EDGE,
  TERRAIN_NODE_GRID_RESOLUTION,
  terrainNodeSpanMeters,
  terrainTexelSizeMeters,
} from "../src/render/webgpu/terrain/TerrainSpineContract";
import {
  buildTerrainNodeGrid,
  packTerrainNodeSplat,
  packTerrainNodeSubIndex,
  selectTerrainNodes,
  terrainNodeMorphK,
  terrainScreenSpaceError,
  writeTerrainNodeBuffers,
  type TerrainNode,
  type TerrainNodeSelectionInput,
} from "../src/render/webgpu/terrain/TerrainQuadtree";
import { createWorldPageAddress } from "../src/render/webgpu/world/pageKey";
import { createWorld } from "../src/world";

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
  it("packs sub-index, page parity and the provisional splat exactly", () => {
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
    // Splat: ids under 16, weight quantised to 1/100 — under 1,700 and exact.
    const splat = packTerrainNodeSplat(3, 4, 0.42);
    expect(splat).toBe(3 * 1_600 + 4 * 100 + 42);
    expect(Number.isInteger(splat)).toBe(true);
    expect(splat).toBeLessThan(2 ** 24);
    expect(packTerrainNodeSplat(99, -1, 5)).toBe(15 * 1_600 + 0 + 100);
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
      splatFor: () => packTerrainNodeSplat(2, 3, 0.5),
    });
    expect(buffers.count).toBe(nodes.length);
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
      expect(buffers.laneB[index * 4 + 2]).toBe(terrainTexelSizeMeters(nodes[index]!.level));
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
      splatFor: () => 0,
    });
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

  it("admits the pages its nodes need, and their parents", () => {
    const { engine, scene, system } = createSystem();
    try {
      system.update({ x: 0, y: 200, z: 0, velocityX: 0, velocityZ: 0 }, 1);
      const residency = system.atlases.height.residency;
      expect(residency.entries.length).toBeGreaterThan(0);
      const levels = new Set(residency.entries.map((slot) => slot.address.level));
      // A node's parent page must be resident too: the geomorph samples it.
      expect(levels.size).toBeGreaterThan(1);
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
