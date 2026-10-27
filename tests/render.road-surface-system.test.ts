import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  RoadSurfaceIndex,
  mergeRoadSurfaceChunks,
  type RoadSurfaceRegion,
} from "@/src/render/webgpu/roads/RoadSurfaceIndex";
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
import { ROAD_RIBBON_CHUNK_METERS, ROAD_RIBBON_PAD_KIND, roadRibbonChunkOf } from "@/src/render/webgpu/roads/roadSurfaceGeometry";
import { TerrainDrawnHeight } from "@/src/render/webgpu/terrain/TerrainDrawnHeight";
import { ROAD_CLASS } from "@/src/world/roads/roadClasses";
import { RoadNetwork, ROAD_LAYERS, roadRegionOf } from "@/src/world/roads/roadNetwork";
import { airportRoadHead } from "@/src/world/roads/roadNodes";
import { roadRegionRails } from "@/src/world/roads/roadRails";
import { createWorld } from "@/src/world/world";

/**
 * The roads' drawing near the camera: the chunk index (`RoadSurfaceIndex`)
 * and the system that merges it into two meshes (`RoadSurfaceSystem`), on
 * the real network round the home airport's road head.
 *
 * What matters: the arrays do not depend on the order regions arrive in; a
 * chunk is built once and again only when a change reaches it; at most two
 * draws, none and no lookup refresh while nothing is in reach; the set moves
 * only as the camera crosses a chunk edge; and the ribbons' lifts keep every
 * road under the pad it meets and every class under the ones above it.
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

  it("merges chunks round an anchor without moving a vertex", () => {
    const index = new RoadSurfaceIndex();
    index.apply(regions, []);
    const keys = index.chunksWithin(cx, cz, 300, "ribbon").sort();
    const chunks = keys.flatMap((key) => {
      const arrays = index.chunkArrays(key, "ribbon");
      return arrays ? [{ key, arrays }] : [];
    });
    const anchorX = cx * ROAD_RIBBON_CHUNK_METERS;
    const anchorZ = cz * ROAD_RIBBON_CHUNK_METERS;
    const merged = mergeRoadSurfaceChunks(chunks, anchorX, anchorZ)!;
    let base = 0;
    for (const { key, arrays } of chunks) {
      const [kx, kz] = key.split(":").map(Number) as [number, number];
      for (const vertex of [0, arrays.vertexCount - 1]) {
        const x = arrays.positions[vertex * 3]! + kx * ROAD_RIBBON_CHUNK_METERS;
        const z = arrays.positions[vertex * 3 + 2]! + kz * ROAD_RIBBON_CHUNK_METERS;
        expect(merged.positions[(base + vertex) * 3]! + anchorX).toBeCloseTo(x, 2);
        expect(merged.positions[(base + vertex) * 3 + 2]! + anchorZ).toBeCloseTo(z, 2);
      }
      base += arrays.vertexCount;
    }
    expect(merged.vertexCount).toBe(base);
    expect(Math.max(...merged.indices)).toBe(base - 1);
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

  it("merges again only as the camera crosses a chunk edge or the roads change", () => {
    const system = new RoadSurfaceSystem(scene, terrain, ultra);
    system.apply(regions, []);
    const { cx, cz } = roadRibbonChunkOf(head.startX, head.startZ);
    const x0 = cx * ROAD_RIBBON_CHUNK_METERS + 5;
    const z0 = cz * ROAD_RIBBON_CHUNK_METERS + 5;
    system.update(x0, z0);
    const merges = system.statistics.merges;
    for (let step = 1; step <= 10; step += 1) system.update(x0 + step * 11, z0 + step * 11);
    expect(system.statistics.merges).toBe(merges);
    system.update(x0 + ROAD_RIBBON_CHUNK_METERS, z0);
    expect(system.statistics.merges).toBeGreaterThan(merges);
    const crossed = system.statistics.merges;
    system.apply([railRegion], []);
    system.update(x0 + ROAD_RIBBON_CHUNK_METERS, z0);
    expect(system.statistics.merges).toBeGreaterThan(crossed);
    system.dispose();
  });

  it("reaches as far as the tier says: Low draws a fraction of what Ultra does", () => {
    const counts = [low, ultra].map((profile) => {
      const system = new RoadSurfaceSystem(scene, terrain, profile);
      system.apply(regions, []);
      system.update(head.startX, head.startZ);
      const { ribbonChunks, ribbonVertices } = system.statistics;
      system.dispose();
      return { ribbonChunks, ribbonVertices };
    });
    expect(counts[0]!.ribbonChunks).toBeGreaterThan(0);
    expect(counts[0]!.ribbonChunks).toBeLessThan(counts[1]!.ribbonChunks / 4);
    expect(counts[0]!.ribbonVertices).toBeLessThan(counts[1]!.ribbonVertices / 4);
  });
});
