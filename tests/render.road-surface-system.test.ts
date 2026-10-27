import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PipelineWarmUp, PipelineWarmUpStatus } from "@/src/render/webgpu/core/AsyncPipelineCompiles";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { RoadSurfaceIndex, type RoadSurfaceRegion } from "@/src/render/webgpu/roads/RoadSurfaceIndex";
import {
  ROAD_RIBBON_LIFTS,
  ROAD_SURFACE_WGSL,
  roadRibbonLift,
} from "@/src/render/webgpu/roads/RoadSurfaceMaterialPlugin";
import {
  ROAD_SURFACE_REACH_SLACK_METERS,
  RoadSurfaceSystem,
  type RoadSurfaceTerrain,
} from "@/src/render/webgpu/roads/RoadSurfaceSystem";
import {
  ROAD_RIBBON_CHUNK_METERS,
  ROAD_RIBBON_PAD_KIND,
  roadRibbonChunkOf,
  roadRibbonEdgeKey,
} from "@/src/render/webgpu/roads/roadSurfaceGeometry";
import { RoadSurfaceSlots } from "@/src/render/webgpu/roads/roadSurfaceSlots";
import { TerrainDrawnHeight } from "@/src/render/webgpu/terrain/TerrainDrawnHeight";
import { ROAD_CLASS } from "@/src/world/roads/roadClasses";
import { RoadNetwork, ROAD_LAYERS, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { roadRegionRails } from "@/src/world/roads/roadRails";
import { createWorld } from "@/src/world/world";

/**
 * The roads' drawing near the camera: the chunk index (`RoadSurfaceIndex`),
 * the slots its chunks are drawn from (`RoadSurfaceSlots`) and the system
 * that draws them as two meshes (`RoadSurfaceSystem`), on the real network
 * round the home airport's road head.
 *
 * What matters: the arrays do not depend on the order regions arrive in; a
 * chunk is built once and again only when a change reaches it; at most two
 * draws, none and no lookup refresh while nothing is in reach; the set moves
 * only as the camera crosses a chunk edge, and a crossing writes only the
 * chunks it brings into reach; a frame writes its budget's share, nearest
 * first; and the ribbons' lifts keep every road under the pad it meets and
 * every class under the ones above it.
 */

const world = createWorld();
const network = new RoadNetwork(world);
const head = airportRoadHead(world)!;
const rx0 = roadRegionOf(head.startX);
const rz0 = roadRegionOf(head.startZ);

const regions: RoadSurfaceRegion[] = [];
for (const layer of ROAD_LAYERS) {
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const region = network.region(layer, rx0 + dx, rz0 + dz);
      regions.push({
        key: `${layer}:${rx0 + dx}:${rz0 + dz}`,
        pieces: region.pieces,
        pads: region.pads,
        rails: layer === "major" && region.pieces.length > 0 ? roadRegionRails(network, region) : [],
      });
    }
  }
}
/** A rail beside the road head, as a region of its own: none stand this close on the real network. */
const railRegion: RoadSurfaceRegion = {
  key: "test:rail",
  pieces: [],
  pads: [],
  rails: [{ points: [head.startX + 20, head.startZ + 5, head.startX + 80, head.startZ + 9], heightMeters: 0.75 }],
};

function signatureOf(index: RoadSurfaceIndex, keys: readonly string[]): string {
  return keys.map((key) => {
    const arrays = index.chunkArrays(key, "ribbon");
    if (!arrays) return `${key}:-`;
    let sum = 0;
    for (let i = 0; i < arrays.positions.length; i += 7) sum += arrays.positions[i]! * ((i % 13) + 1);
    return `${key}:${arrays.vertexCount}:${arrays.indices.length}:${sum.toFixed(3)}`;
  }).join("|");
}

describe("the roads' chunk index", () => {
  const { cx, cz } = roadRibbonChunkOf(head.startX, head.startZ);

  it("builds the same chunks whichever order the regions arrive in", () => {
    const forward = new RoadSurfaceIndex();
    forward.apply(regions, []);
    const backward = new RoadSurfaceIndex();
    for (const region of [...regions].reverse()) backward.apply([region], []);
    const keys = forward.chunksWithin(cx, cz, 1_200, "ribbon").sort();
    expect(keys.length).toBeGreaterThan(10);
    expect(backward.chunksWithin(cx, cz, 1_200, "ribbon").sort()).toEqual(keys);
    expect(signatureOf(backward, keys)).toBe(signatureOf(forward, keys));
  });

  it("builds a chunk once, and again only when a change reaches it", () => {
    const index = new RoadSurfaceIndex();
    index.apply(regions, []);
    const keys = index.chunksWithin(cx, cz, 500, "ribbon");
    for (const key of keys) index.chunkArrays(key, "ribbon");
    const builds = index.builds;
    for (const key of keys) index.chunkArrays(key, "ribbon");
    expect(index.builds).toBe(builds);
    const before = signatureOf(index, keys);
    // A region far from these chunks leaves them built.
    const far = regions.find((region) => region.key.endsWith(`:${rx0 + 1}:${rz0 + 1}`) && region.pieces.length > 0)!;
    index.apply([], [far.key]);
    index.apply([far], []);
    const rebuilt = index.builds - builds;
    for (const key of keys) index.chunkArrays(key, "ribbon");
    expect(index.builds - builds - rebuilt).toBeLessThanOrEqual(keys.length);
    // Removed and put back: the same arrays.
    expect(signatureOf(index, keys)).toBe(before);
  });

  it("draws a track's ruts but not its pads, and every kind's lane is what the ribbon draws", () => {
    const index = new RoadSurfaceIndex();
    index.apply(regions, []);
    const kinds = new Set<number>();
    for (const key of index.chunksWithin(cx, cz, 1_200, "ribbon")) {
      const arrays = index.chunkArrays(key, "ribbon");
      if (!arrays) continue;
      for (let vertex = 0; vertex < arrays.vertexCount; vertex += 1) kinds.add(arrays.surface[vertex * 4 + 3]!);
    }
    expect(kinds.has(ROAD_CLASS.track)).toBe(true);
    expect(kinds.has(ROAD_CLASS.track + ROAD_RIBBON_PAD_KIND)).toBe(false);
    expect([...kinds].some((kind) => kind >= ROAD_RIBBON_PAD_KIND)).toBe(true);
  });

  it("takes a queued change a step at a time, regions then edges a few pieces a step, to the same chunks as at once", () => {
    const whole = new RoadSurfaceIndex();
    whole.apply(regions, []);
    const keys = whole.chunksWithin(cx, cz, 1_200, "ribbon").sort();
    const stepped = new RoadSurfaceIndex();
    stepped.enqueue(regions, []);
    const edges = new Set(regions.flatMap((region) => region.pieces.map(roadRibbonEdgeKey)));
    expect(stepped.pendingSteps).toBe(regions.length);
    // Past the deadline already: one step a call, as a frame with its budget spent takes.
    let steps = 0;
    let published = 0;
    while (stepped.pendingSteps > 0) {
      const version = stepped.version;
      expect(stepped.settle(Number.NEGATIVE_INFINITY)).toBe(1);
      steps += 1;
      if (steps > regions.length && stepped.version > version) published += 1;
    }
    // An edge's cut takes steps, and its spans are published once, when it is
    // done: until then its chunks are drawn as they were.
    expect(published).toBe(edges.size);
    expect(steps - regions.length).toBeGreaterThan(edges.size);
    // And none at all when it may not take the first past the deadline.
    stepped.enqueue([], [regions[0]!.key]);
    expect(stepped.settle(Number.NEGATIVE_INFINITY, false)).toBe(0);
    expect(stepped.settle(Number.POSITIVE_INFINITY)).toBeGreaterThan(0);
    stepped.enqueue([regions[0]!], []);
    stepped.settle(Number.POSITIVE_INFINITY);
    expect(stepped.chunksWithin(cx, cz, 1_200, "ribbon").sort()).toEqual(keys);
    expect(signatureOf(stepped, keys)).toBe(signatureOf(whole, keys));
  });

  it("lists the chunks in reach nearest first", () => {
    const index = new RoadSurfaceIndex();
    index.apply(regions, []);
    const keys = index.chunksWithin(cx, cz, 1_200, "ribbon");
    expect(keys.length).toBeGreaterThan(10);
    const offsets = keys.map((key) => {
      const [kx, kz] = key.split(":").map(Number) as [number, number];
      return (kx - cx) ** 2 + (kz - cz) ** 2;
    });
    for (let k = 1; k < offsets.length; k += 1) expect(offsets[k]!).toBeGreaterThanOrEqual(offsets[k - 1]!);
  });
});

describe("the roads' slots", () => {
  const { cx, cz } = roadRibbonChunkOf(head.startX, head.startZ);
  const index = new RoadSurfaceIndex();
  index.apply(regions, []);
  const chunks = index.chunksWithin(cx, cz, 600, "ribbon").flatMap((key) => {
    const arrays = index.chunkArrays(key, "ribbon");
    const [kx, kz] = key.split(":").map(Number) as [number, number];
    return arrays ? [{ key, kx, kz, arrays }] : [];
  });

  /** Index-distinct triangles drawn (a freed range is all zeros: none). */
  function liveTriangles(slots: RoadSurfaceSlots): number {
    let triangles = 0;
    for (let k = 0; k < slots.indexEnd; k += 3) {
      const [a, b, c] = [slots.indices[k], slots.indices[k + 1], slots.indices[k + 2]];
      if (!(a === b && b === c)) triangles += 1;
    }
    return triangles;
  }

  it("write each chunk as it was built, with its chunk, its indices into its own vertices", () => {
    // Small, so the slots grow on the way.
    const slots = new RoadSurfaceSlots(256);
    for (const { key, kx, kz, arrays } of chunks) slots.write(key, 1, kx, kz, arrays);
    expect(slots.takeWrites().grew).toBe(true);
    expect(chunks.length).toBeGreaterThan(5);
    let vertices = 0;
    let indices = 0;
    for (const { key, kx, kz, arrays } of chunks) {
      const slot = slots.slot(key)!;
      for (const vertex of [0, arrays.vertexCount - 1]) {
        for (let axis = 0; axis < 3; axis += 1) {
          expect(slots.positions[(slot.vertexStart + vertex) * 3 + axis]).toBe(arrays.positions[vertex * 3 + axis]);
        }
        expect(slots.chunk[(slot.vertexStart + vertex) * 2]).toBe(kx);
        expect(slots.chunk[(slot.vertexStart + vertex) * 2 + 1]).toBe(kz);
        expect(slots.surface[(slot.vertexStart + vertex) * 4 + 3]).toBe(arrays.surface[vertex * 4 + 3]);
      }
      for (let k = 0; k < slot.indexCount; k += 1) {
        const value = slots.indices[slot.indexStart + k]!;
        expect(value).toBe(arrays.indices[k]! + slot.vertexStart);
        expect(value - slot.vertexStart).toBeLessThan(slot.vertexCount);
      }
      vertices += arrays.vertexCount;
      indices += arrays.indices.length;
    }
    expect(slots.vertexCount).toBe(vertices);
    expect(slots.indexCount).toBe(indices);
    expect(slots.indexEnd).toBe(indices);
    expect(liveTriangles(slots)).toBe(indices / 3);
  });

  it("free a chunk's range with zeros, refill holes first fit, and draw no further than the last chunk", () => {
    const slots = new RoadSurfaceSlots(1 << 16);
    for (const { key, kx, kz, arrays } of chunks) slots.write(key, 1, kx, kz, arrays);
    slots.takeWrites();
    const middle = chunks[Math.floor(chunks.length / 2)]!;
    const freed = slots.slot(middle.key)!;
    expect(slots.release(middle.key)).toBe(true);
    for (let k = 0; k < freed.indexCount; k += 1) expect(slots.indices[freed.indexStart + k]).toBe(0);
    const writes = slots.takeWrites();
    expect(writes.grew).toBe(false);
    expect(writes.vertices).toHaveLength(0);
    expect(writes.indices).toEqual([{ start: freed.indexStart, count: freed.indexCount }]);
    // Written again: into the hole it left.
    const again = slots.write(middle.key, 2, middle.kx, middle.kz, middle.arrays);
    expect(again.vertexStart).toBe(freed.vertexStart);
    expect(again.indexStart).toBe(freed.indexStart);
    expect(slots.takeWrites().vertices).toEqual([{ start: freed.vertexStart, count: freed.vertexCount }]);
    // The last chunk freed: the end comes back to the one before it, and the holes go with it.
    const last = chunks[chunks.length - 1]!;
    const end = slots.slot(last.key)!.indexStart;
    slots.release(last.key);
    expect(slots.indexEnd).toBe(end);
    for (const { key } of chunks) slots.release(key);
    expect(slots.indexEnd).toBe(0);
    expect(slots.vertexEnd).toBe(0);
    expect(slots.holes).toEqual({ vertices: 0, indices: 0 });
    expect(slots.vertexCount).toBe(0);
    expect(liveTriangles(slots)).toBe(0);
  });

  it("replace a changed chunk in the same writes as it leaves its old range", () => {
    const slots = new RoadSurfaceSlots(1 << 16);
    const [first, second] = chunks as [typeof chunks[number], typeof chunks[number]];
    slots.write(first.key, 1, first.kx, first.kz, first.arrays);
    slots.write(second.key, 1, second.kx, second.kz, second.arrays);
    slots.takeWrites();
    const before = slots.slot(first.key)!;
    // Its arrays changed (here: the second chunk's, larger or not), stamped anew.
    slots.write(first.key, 2, first.kx, first.kz, second.arrays);
    const after = slots.slot(first.key)!;
    expect(after.stamp).toBe(2);
    expect(slots.size).toBe(2);
    const writes = slots.takeWrites();
    // The old range's zeros and the new range's indices both go up in this upload.
    for (const range of [
      { start: before.indexStart, count: before.indexCount },
      { start: after.indexStart, count: after.indexCount },
    ]) {
      expect(writes.indices.some((write) => write.start <= range.start && range.start + range.count <= write.start + write.count)).toBe(true);
    }
    expect(liveTriangles(slots)).toBe(2 * second.arrays.indices.length / 3);
  });
});

describe("the ribbons' lifts", () => {
  it("keep every road under its pad and each class under the ones above it, all within 2 cm", () => {
    const classes = [ROAD_CLASS.track, ROAD_CLASS.gravel, ROAD_CLASS.airport];
    for (let index = 1; index < classes.length; index += 1) {
      expect(roadRibbonLift(classes[index]!)).toBeGreaterThan(roadRibbonLift(classes[index - 1]!));
    }
    // A pad takes the highest class that meets it, so it lies over every road there.
    for (const pad of classes) {
      for (const road of classes) {
        if (road > pad) continue;
        expect(roadRibbonLift(pad + ROAD_RIBBON_PAD_KIND)).toBeGreaterThan(roadRibbonLift(road));
      }
    }
    for (const lift of [...ROAD_RIBBON_LIFTS.road, ...ROAD_RIBBON_LIFTS.pad]) expect(lift).toBeLessThanOrEqual(0.02);
    // The WGSL table is the TS one, kind for kind.
    const wgsl = new Function("kind", ROAD_SURFACE_WGSL.lift
      .replace(/^fn roadSurfaceLift\(kind: f32\) -> f32 \{/u, "")
      .replace(/\}\s*$/u, "")) as (kind: number) => number;
    for (const kind of [0, 1, 2, 4, 5, 6]) expect(wgsl(kind)).toBe(roadRibbonLift(kind));
    // The vertex stage reads them by kind, and replaces the baked height only from the drawn ground.
    expect(ROAD_SURFACE_WGSL.ribbonVertex).toContain("roadDrawn.height + roadSurfaceLift(vertexInputs.roadSurface.w)");
    expect(ROAD_SURFACE_WGSL.railVertex).toContain("roadDrawn.height + vertexInputs.roadSurface.x");
  });
});

describe("the roads' surface system", () => {
  let engine: NullEngine;
  let scene: Scene;
  const refreshes: { x: number; z: number; radius: number }[] = [];
  let lookup: TerrainDrawnHeight | null = null;
  const terrain: RoadSurfaceTerrain = {
    drawnHeight: (reach) => {
      if (!lookup || lookup.windowCells < new TerrainDrawnHeight(null, reach).windowCells) {
        lookup = new TerrainDrawnHeight(null, reach);
      }
      return lookup;
    },
    refreshDrawnHeight: (x, z, radius) => {
      refreshes.push({ x, z, radius });
    },
    drawnHeightAtlas: {
      texture: {} as BaseTexture,
      shape: { atlasEdge: 1, slotEdge: 1, gutter: 0, gridEdge: 1 },
    },
    surfaceMaterialArrays: { albedoHeight: {} as BaseTexture, normalMaterial: {} as BaseTexture },
  };

  beforeAll(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });

  const low = resolveWebGpuQualityProfile("low", "balanced");
  const ultra = resolveWebGpuQualityProfile("high", "ultra");

  /** Update at (x, z) until every chunk in reach is written; the updates it took. */
  function settle(system: RoadSurfaceSystem, x: number, z: number): number {
    for (let updates = 1; updates <= 1_000; updates += 1) {
      system.update(x, z);
      if (system.pendingWork === 0) return updates;
    }
    throw new Error("the roads in reach never settled");
  }

  it("draws nothing and refreshes no lookup while nothing is in reach", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    refreshes.length = 0;
    system.update(head.startX, head.startZ);
    expect(system.statistics.draws).toBe(0);
    expect(refreshes).toHaveLength(0);
    system.apply(regions, []);
    // Far from every road installed.
    system.update(head.startX + 40_000, head.startZ + 40_000);
    expect(system.statistics.draws).toBe(0);
    expect(refreshes).toHaveLength(0);
    expect(system.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    system.dispose();
  });

  it("draws the ribbons and rails in reach as two meshes, the lookup refreshed round the camera", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    system.apply([...regions, railRegion], []);
    settle(system, head.startX, head.startZ);
    refreshes.length = 0;
    system.update(head.startX, head.startZ);
    expect(system.statistics.draws).toBe(2);
    expect(system.statistics.ribbonVertices).toBeGreaterThan(1_000);
    expect(system.statistics.railVertices).toBeGreaterThan(100);
    expect(refreshes).toEqual([{
      x: head.startX,
      z: head.startZ,
      radius: Math.max(ultra.roadRibbonRangeMeters, ultra.barrierDrawRangeMeters) + ROAD_SURFACE_REACH_SLACK_METERS,
    }]);
    expect(system.meshes.every((mesh) => mesh.isEnabled())).toBe(true);
    system.dispose();
  });

  it("writes again only the chunks a crossing brings into reach, or a change reaches", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    system.apply(regions, []);
    const { cx, cz } = roadRibbonChunkOf(head.startX, head.startZ);
    const x0 = cx * ROAD_RIBBON_CHUNK_METERS + 5;
    const z0 = cz * ROAD_RIBBON_CHUNK_METERS + 5;
    settle(system, x0, z0);
    const { writes, bufferBuilds } = system.statistics;
    expect(writes).toBe(system.statistics.ribbonChunks + system.statistics.railChunks);
    // Within the chunk: nothing written, uploaded or bound again (each drawn layer bound once).
    const { bindings, draws } = system.statistics;
    expect(draws).toBeGreaterThan(0);
    expect(bindings).toBe(draws);
    for (let step = 1; step <= 10; step += 1) system.update(x0 + step * 11, z0 + step * 11);
    expect(system.statistics.writes).toBe(writes);
    expect(system.statistics.uploadRanges).toBe(0);
    expect(system.statistics.bindings).toBe(bindings);
    // One chunk east: at most the column it brings in, against the whole set before.
    settle(system, x0 + ROAD_RIBBON_CHUNK_METERS, z0);
    const column = 2 * Math.ceil(ultra.roadRibbonRangeMeters / ROAD_RIBBON_CHUNK_METERS) + 1;
    const crossed = system.statistics.writes - writes;
    expect(crossed).toBeGreaterThan(0);
    // A column a layer at most.
    expect(crossed).toBeLessThanOrEqual(2 * column);
    expect(crossed).toBeLessThan(writes / 4);
    expect(system.statistics.releases).toBeGreaterThan(0);
    // The buffers made once, each written in place since; each layer bound again to its new anchor.
    expect(system.statistics.bufferBuilds).toBe(bufferBuilds);
    expect(system.statistics.bindings).toBe(bindings + draws);
    // A change in reach: the chunk it touched, nothing else.
    const before = system.statistics.writes;
    system.apply([railRegion], []);
    settle(system, x0 + ROAD_RIBBON_CHUNK_METERS, z0);
    expect(system.statistics.writes - before).toBeGreaterThan(0);
    expect(system.statistics.writes - before).toBeLessThanOrEqual(2);
    system.dispose();
  });

  it("writes nothing again for roads that change out of reach", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    system.apply(regions, []);
    settle(system, head.startX, head.startZ);
    const writes = system.statistics.writes;
    const far: RoadSurfaceRegion = {
      key: "test:far-rail",
      pieces: [],
      pads: [],
      rails: [{ points: [head.startX + 20_000, head.startZ, head.startX + 20_060, head.startZ + 4], heightMeters: 0.75 }],
    };
    system.apply([far], []);
    settle(system, head.startX, head.startZ);
    system.apply([], [far.key]);
    settle(system, head.startX, head.startZ);
    expect(system.statistics.writes).toBe(writes);
    // A change in reach still does.
    system.apply([railRegion], []);
    settle(system, head.startX, head.startZ);
    expect(system.statistics.writes).toBeGreaterThan(writes);
    system.dispose();
  });

  it("writes a frame's budget of chunks, nearest first, so a jump fills in from under the camera", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    system.apply([...regions, railRegion], []);
    // The streamed change taken whole first; its steps have a test of their own.
    system.index.settle(Number.POSITIVE_INFINITY);
    // A clock a millisecond on at every reading: past the budget after the first chunk.
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 1));
    try {
      system.update(head.startX, head.startZ);
      const total = system.statistics.ribbonChunks + system.statistics.railChunks;
      expect(total).toBeGreaterThan(20);
      expect(system.statistics.writes).toBe(1);
      expect(system.pendingWork).toBe(total - 1);
      // The camera's own chunk first, if it has a road; drawn from the first frame.
      expect(system.statistics.ribbonVertices).toBeGreaterThan(0);
      expect(system.statistics.draws).toBe(1);
      let updates = 1;
      while (system.pendingWork > 0) {
        const pending = system.pendingWork;
        system.update(head.startX, head.startZ);
        expect(system.pendingWork).toBe(pending - 1);
        updates += 1;
      }
      expect(updates).toBe(total);
      expect(system.statistics.draws).toBe(2);
    } finally {
      now.mockRestore();
    }
    system.dispose();
  });

  /** A stand-in for `AsyncPipelineCompiles`: answers `status`, and notes each mesh asked for. */
  function fakeWarmUp(): PipelineWarmUp & { asked: Mesh[]; status: PipelineWarmUpStatus } {
    const fake = {
      asked: [] as Mesh[],
      status: "started" as PipelineWarmUpStatus,
      warmUp(mesh: Mesh): PipelineWarmUpStatus {
        fake.asked.push(mesh);
        return fake.status;
      },
    };
    return fake;
  }

  /** The mesh draws the warm-up's triangle and nothing else: three indices, all apart (a freed range's are all zero). */
  function emptyTriangle(mesh: Mesh): boolean {
    const indices = mesh.getIndices();
    const count = mesh.subMeshes?.[0]?.indexCount ?? 0;
    return indices !== null && count === 3 && indices[0] !== indices[1] && indices[1] !== indices[2];
  }

  it("warms both pipelines as the first roads install, before any is in reach: one empty triangle each until warm", () => {
    const warmUp = fakeWarmUp();
    const system = new RoadSurfaceSystem(scene, terrain, ultra, warmUp);
    const far = [head.startX + 40_000, head.startZ + 40_000] as const;
    system.update(...far);
    // No roads, nothing to warm.
    expect(warmUp.asked).toHaveLength(0);
    system.apply([...regions, railRegion], []);
    refreshes.length = 0;
    system.update(...far);
    expect(warmUp.asked).toEqual(system.meshes);
    expect(system.statistics.warmUps).toBe(2);
    expect(system.statistics.draws).toBe(0);
    // The triangle reads nothing that shows: no lookup refresh for it.
    expect(refreshes).toHaveLength(0);
    for (const mesh of system.meshes) {
      expect(mesh.isEnabled()).toBe(true);
      expect(emptyTriangle(mesh)).toBe(true);
    }

    // In reach before the compile is done: the chunks draw (deferred), and warm the same pipelines.
    settle(system, head.startX, head.startZ);
    expect(system.statistics.draws).toBe(2);
    expect(system.statistics.warmUps).toBe(2);
    expect(system.meshes.some(emptyTriangle)).toBe(false);
    // Out of reach again: the triangle again, not the chunks left behind.
    system.update(...far);
    expect(system.meshes.every(emptyTriangle)).toBe(true);

    warmUp.status = "warm";
    system.update(...far);
    expect(system.statistics.warmLayers).toBe(2);
    expect(system.statistics.warmUps).toBe(0);
    expect(system.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    warmUp.asked.length = 0;
    system.update(...far);
    settle(system, head.startX, head.startZ);
    expect(warmUp.asked).toHaveLength(0);
    expect(system.statistics.draws).toBe(2);
    system.dispose();
  });

  it("warms nothing in capture mode (declined) or with its range off", () => {
    const declined = fakeWarmUp();
    declined.status = "declined";
    const capture = new RoadSurfaceSystem(scene, terrain, ultra, declined);
    capture.apply([...regions, railRegion], []);
    capture.update(head.startX + 40_000, head.startZ + 40_000);
    expect(declined.asked).toEqual(capture.meshes);
    expect(capture.statistics.warmLayers).toBe(2);
    expect(capture.statistics.warmUps).toBe(0);
    expect(capture.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    capture.dispose();

    const off = fakeWarmUp();
    let lookups = 0;
    const counted: RoadSurfaceTerrain = {
      ...terrain,
      drawnHeight: (reach) => {
        lookups += 1;
        return terrain.drawnHeight(reach);
      },
    };
    const system = new RoadSurfaceSystem(
      scene, counted, { ...ultra, roadRibbonRangeMeters: 0, barrierDrawRangeMeters: 0 }, off,
    );
    system.apply([...regions, railRegion], []);
    system.update(head.startX, head.startZ);
    system.update(head.startX + 40_000, head.startZ + 40_000);
    expect(off.asked).toHaveLength(0);
    expect(lookups).toBe(0);
    expect(system.statistics.draws).toBe(0);
    expect(system.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    system.dispose();
  });

  it("reaches as far as the tier says: Low draws a fraction of what Ultra does", () => {
    const counts = [low, ultra].map((profile) => {
      const system = new RoadSurfaceSystem(scene, terrain, profile);
      system.apply(regions, []);
      settle(system, head.startX, head.startZ);
      const { ribbonChunks, ribbonVertices } = system.statistics;
      system.dispose();
      return { ribbonChunks, ribbonVertices };
    });
    expect(counts[0]!.ribbonChunks).toBeGreaterThan(0);
    expect(counts[0]!.ribbonChunks).toBeLessThan(counts[1]!.ribbonChunks / 4);
    expect(counts[0]!.ribbonVertices).toBeLessThan(counts[1]!.ribbonVertices / 4);
  });
});
