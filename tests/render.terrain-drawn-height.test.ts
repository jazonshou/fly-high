import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_DRAWN_CELL_METERS,
  TerrainDrawnHeight,
  terrainDrawnCellTag,
  terrainDrawnWindowCells,
} from "@/src/render/webgpu/terrain/TerrainDrawnHeight";
import {
  terrainNodeVertexMorphK,
  unpackTerrainCornerMorphs,
} from "@/src/render/webgpu/terrain/TerrainQuadtree";
import { TERRAIN_NODE_GRID_RESOLUTION } from "@/src/render/webgpu/terrain/TerrainSpineContract";
import { TERRAIN_SURFACE_VERTEX_WGSL } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  DRAWN_FRAME_CAMERA as CAMERA,
  buildDrawnFrame,
  drawnFrameEdgeProbes,
  drawnFrameGround as groundHeight,
  drawnFrameRing as ring,
  type DrawnFrame as Frame,
} from "./support/terrainDrawnFrame";

/**
 * `TerrainDrawnHeight`: the ground as the terrain draws it, for the roads'
 * ribbons and rails to lie on.
 *
 * The oracle here is independent of the lookup: it finds the node covering a
 * point by scanning the frame's node list, then the triangle by testing every
 * one of that node's 2,048 morphed triangles, and evaluates the three
 * vertices from the node record the way the terrain's vertex stage reads it.
 * The lookup's CPU twin (`terrainDrawnSurfaceAt`, the WGSL helper line for
 * line) must agree with it within 2 cm near the camera, at a few hundred
 * metres and past a kilometre, over a real selection: a range of levels, a
 * morph band, 2:1 boundaries, and pages missing their fine slot.
 */

const QUADS = TERRAIN_NODE_GRID_RESOLUTION - 1;

function bilinear(frame: Frame, slot: number, texelX: number, texelZ: number): [number, number, number] {
  if (slot < 0) return [0, 0, 0];
  const { atlasEdge, slotEdge, gutter, gridEdge } = frame.atlas.shape;
  const u = (slot % gridEdge) * slotEdge + gutter + Math.floor(texelX);
  const v = Math.floor(slot / gridEdge) * slotEdge + gutter + Math.floor(texelZ);
  const fx = texelX - Math.floor(texelX);
  const fz = texelZ - Math.floor(texelZ);
  const h = (du: number, dv: number) => frame.atlas.heights[(v + dv) * atlasEdge + u + du]!;
  const top = h(0, 0) + (h(1, 0) - h(0, 0)) * fx;
  const bottom = h(0, 1) + (h(1, 1) - h(0, 1)) * fx;
  return [
    top + (bottom - top) * fz,
    (h(1, 0) - h(0, 0)) * (1 - fz) + (h(1, 1) - h(0, 1)) * fz,
    (h(0, 1) - h(0, 0)) * (1 - fx) + (h(1, 1) - h(1, 0)) * fx,
  ];
}

/** The oracle: the drawn surface by brute force over the frame's node list. */
function drawnByScan(frame: Frame, x: number, z: number): { height: number; gradientX: number; gradientZ: number } | null {
  const index = frame.nodes.findIndex((node) => x >= node.originX && x < node.originX + node.spanMeters
    && z >= node.originZ && z < node.originZ + node.spanMeters);
  if (index < 0 || index >= frame.records.count) return null;
  const node = frame.nodes[index]!;
  const lane = index * 4;
  const slot = frame.records.laneA[lane]!;
  const packedSub = frame.records.laneA[lane + 1]!;
  const morphK = frame.records.laneB[lane]!;
  const parentSlot = frame.records.laneB[lane + 1]!;
  const corners = unpackTerrainCornerMorphs(frame.records.laneB[lane + 3]!);
  const parityZ = Math.floor(packedSub / 128);
  const parityX = Math.floor((packedSub % 128) / 64);
  const sub = packedSub % 64;
  const subX = sub % 8;
  const subZ = Math.floor(sub / 8);
  const morphOf = (gx: number, gz: number) => terrainNodeVertexMorphK(morphK, corners, gx, gz, parentSlot >= 0);
  const place = (gx: number, gz: number): [number, number] => {
    const k = morphOf(gx, gz);
    return [
      node.originX + ((gx + (Math.floor(gx / 2) * 2 - gx) * k) / QUADS) * node.spanMeters,
      node.originZ + ((gz + (Math.floor(gz / 2) * 2 - gz) * k) / QUADS) * node.spanMeters,
    ];
  };
  const vertex = (gx: number, gz: number): [number, number, number] => {
    const k = morphOf(gx, gz);
    const mx = (gx + (Math.floor(gx / 2) * 2 - gx) * k) / QUADS;
    const mz = (gz + (Math.floor(gz / 2) * 2 - gz) * k) / QUADS;
    const own = bilinear(frame, slot, (subX + mx) * QUADS, (subZ + mz) * QUADS);
    const parent = k > 0 || slot < 0
      ? bilinear(frame, parentSlot, parityX * 128 + subX * 16 + mx * 16, parityZ * 128 + subZ * 16 + mz * 16)
      : own;
    const fine = slot >= 0 ? own : parent;
    const fineGradient = slot >= 0 ? [own[1] * QUADS, own[2] * QUADS] : [parent[1] * 16, parent[2] * 16];
    return [
      fine[0] + (parent[0] - fine[0]) * k,
      fineGradient[0]! + (parent[1] * 16 - fineGradient[0]!) * k,
      fineGradient[1]! + (parent[2] * 16 - fineGradient[1]!) * k,
    ];
  };
  // Every front face covering the point; the drawn one is the highest (the
  // depth test's pick from above where a morph fold overlaps two).
  let drawn: { height: number; gradientX: number; gradientZ: number } | null = null;
  for (let qz = 0; qz < QUADS; qz += 1) {
    for (let qx = 0; qx < QUADS; qx += 1) {
      const triangles: [number, number][][] = [
        [[qx, qz], [qx + 1, qz], [qx, qz + 1]],
        [[qx + 1, qz], [qx + 1, qz + 1], [qx, qz + 1]],
      ];
      for (const triangle of triangles) {
        const [p0, p1, p2] = triangle.map(([gx, gz]) => place(gx!, gz!)) as [[number, number], [number, number], [number, number]];
        const det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        // A back face (the morph turned it over) is culled: never drawn.
        if (det < 1e-9) continue;
        const w1 = ((x - p0[0]) * (p2[1] - p0[1]) - (z - p0[1]) * (p2[0] - p0[0])) / det;
        const w2 = ((p1[0] - p0[0]) * (z - p0[1]) - (p1[1] - p0[1]) * (x - p0[0])) / det;
        const w0 = 1 - w1 - w2;
        if (Math.min(w0, w1, w2) < -1e-9) continue;
        const weights = [w0, w1, w2];
        let height = 0;
        let gradientX = 0;
        let gradientZ = 0;
        triangle.forEach(([gx, gz], corner) => {
          const v = vertex(gx!, gz!);
          height += v[0] * weights[corner]!;
          gradientX += v[1] * weights[corner]!;
          gradientZ += v[2] * weights[corner]!;
        });
        if (!drawn || height > drawn.height) {
          drawn = { height, gradientX: gradientX / node.spanMeters, gradientZ: gradientZ / node.spanMeters };
        }
      }
    }
  }
  return drawn;
}

describe("the drawn-height lookup", () => {
  const frame = buildDrawnFrame();
  const lookup = new TerrainDrawnHeight(null, 1_400);
  lookup.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);

  it("covers levels, a morph band, 2:1 boundaries and a missing fine page", () => {
    const levels = new Set(frame.nodes.map((node) => node.level));
    expect(levels.size).toBeGreaterThanOrEqual(4);
    expect(frame.nodes.some((node) => node.morphK > 0.05 && node.morphK < 0.95)).toBe(true);
    const slots = Array.from({ length: frame.records.count }, (_, index) => frame.records.laneA[index * 4]!);
    // Two pages withheld: every node they hold draws from its parent.
    expect(slots.filter((slot) => slot < 0).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["near the camera", 20, 90, 1],
    ["a few hundred metres out", 300, 500, 2],
    ["past a kilometre", 1_000, 1_300, 3],
  ])("lies on the drawn triangles %s, within 2 cm, and shades as they do", (_label, inner, outer, seed) => {
    let worstHeight = 0;
    let worstGradient = 0;
    let worstField = 0;
    let probes = 0;
    for (const [x, z] of ring(inner, outer, 160, seed)) {
      const expected = drawnByScan(frame, x, z);
      const actual = lookup.surfaceAt(frame.atlas, x, z);
      expect(actual, `no answer at (${x.toFixed(1)}, ${z.toFixed(1)})`).not.toBeNull();
      expect(expected).not.toBeNull();
      worstHeight = Math.max(worstHeight, Math.abs(actual!.height - expected!.height));
      worstGradient = Math.max(
        worstGradient,
        Math.abs(actual!.gradientX - expected!.gradientX),
        Math.abs(actual!.gradientZ - expected!.gradientZ),
      );
      worstField = Math.max(worstField, Math.abs(groundHeight(x, z) - expected!.height));
      probes += 1;
    }
    expect(probes).toBe(160);
    expect(worstHeight).toBeLessThan(0.02);
    expect(worstGradient).toBeLessThan(1e-3);
    // What a ribbon on the field's own heights would miss the ground by here.
    console.info(`${_label}: drawn vs lookup ${(worstHeight * 1_000).toFixed(4)} mm; field vs drawn up to ${worstField.toFixed(3)} m`);
  });

  it("picks the drawn triangle beside a node's edges, where the synchronised morph bends the grid", () => {
    const probes = drawnFrameEdgeProbes(frame, 1_300, 900);
    expect(probes.length).toBeGreaterThan(500);
    let worst = 0;
    for (const [x, z] of probes) {
      const expected = drawnByScan(frame, x, z)!;
      worst = Math.max(worst, Math.abs(lookup.surfaceAt(frame.atlas, x, z)!.height - expected.height));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it("misses the field by decimetres where the terrain draws coarse, which is why it exists", () => {
    let worst = 0;
    for (const [x, z] of ring(1_000, 1_300, 160, 3)) {
      worst = Math.max(worst, Math.abs(groundHeight(x, z) - lookup.surfaceAt(frame.atlas, x, z)!.height));
    }
    expect(worst).toBeGreaterThan(0.2);
  });

  it("writes only the cells whose record changed, a row at a time", () => {
    const again = new TerrainDrawnHeight(null, 1_400);
    again.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);
    const first = again.statistics.cellsWritten;
    expect(first).toBeGreaterThan(1_000);
    again.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);
    expect(again.statistics.cellsWritten).toBe(0);
    // One cell east: the window keeps every cell it had and gains one column.
    again.refresh(frame.records, CAMERA.x + TERRAIN_DRAWN_CELL_METERS, CAMERA.z, 1_400);
    const reach = Math.ceil(1_400 / TERRAIN_DRAWN_CELL_METERS);
    expect(again.statistics.cellsWritten).toBe(2 * reach + 1);
    expect(again.statistics.rowsUploaded).toBe(0);
  });

  it("does nothing at all on a frame whose camera cell, reach and records are the last one's", () => {
    const settled = new TerrainDrawnHeight(null, 1_400);
    settled.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);
    const texels = settled.texels.slice();
    // The same cell (a few metres on), the same reach and records: nothing read again.
    settled.refresh(frame.records, CAMERA.x + 1, CAMERA.z, 1_400);
    settled.refresh(frame.records, CAMERA.x + 1, CAMERA.z, 1_400);
    expect(settled.statistics).toMatchObject({ refreshes: 3, unchanged: 2, cellsWritten: 0, rowsUploaded: 0 });
    expect(settled.texels).toEqual(texels);
    // A record changed: read and written again, whatever the camera did.
    const laneB = frame.records.laneB.slice();
    for (let lane = 0; lane < laneB.length; lane += 4) laneB[lane + 3] = laneB[lane + 3]! + 1;
    settled.refresh({ ...frame.records, laneB }, CAMERA.x + 1, CAMERA.z, 1_400);
    expect(settled.statistics.unchanged).toBe(2);
    expect(settled.statistics.cellsWritten).toBeGreaterThan(1_000);
    // And back: as the first frame left it.
    settled.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);
    expect(settled.statistics.unchanged).toBe(2);
    expect(settled.texels).toEqual(texels);
    // Another cell, or another reach: read again.
    settled.refresh(frame.records, CAMERA.x + TERRAIN_DRAWN_CELL_METERS, CAMERA.z, 1_400);
    settled.refresh(frame.records, CAMERA.x + TERRAIN_DRAWN_CELL_METERS, CAMERA.z, 1_000);
    expect(settled.statistics.unchanged).toBe(2);
  });

  it("answers missing, never another cell's node, where the window has moved on", () => {
    const moved = new TerrainDrawnHeight(null, 1_400);
    moved.refresh(frame.records, CAMERA.x, CAMERA.z, 1_400);
    const [x, z] = ring(20, 90, 1, 9)[0]!;
    expect(moved.surfaceAt(frame.atlas, x, z)).not.toBeNull();
    // Far enough that the old cell's texel now belongs to a cell of the new window.
    const shift = moved.windowCells * TERRAIN_DRAWN_CELL_METERS * 0.75;
    moved.refresh({ ...frame.records, count: 0 }, CAMERA.x + shift, CAMERA.z, 300);
    expect(moved.surfaceAt(frame.atlas, x, z)).toBeNull();
    // Cells inside the asked radius that no record covers are written missing.
    expect(moved.surfaceAt(frame.atlas, CAMERA.x + shift, CAMERA.z)).toBeNull();
    expect(terrainDrawnCellTag(0, 0)).not.toBe(terrainDrawnCellTag(1_024, 0) + 1);
  });

  it("sizes its window for the reach, with the camera's cell central", () => {
    expect(terrainDrawnWindowCells(1_200) % 2).toBe(0);
    expect((terrainDrawnWindowCells(1_200) / 2 - 1) * TERRAIN_DRAWN_CELL_METERS).toBeGreaterThanOrEqual(1_200 + 192);
    expect(new TerrainDrawnHeight(null, 150).windowCells).toBeLessThan(lookup.windowCells);
  });

  it("follows the terrain's vertex stage: change that, and this file follows it", () => {
    // TerrainDrawnHeight's WGSL and twin restate the displacement in
    // CUSTOM_VERTEX_UPDATE_POSITION and terrainSampleHeightGradient. A change
    // to either fails here until the helper is brought in line and this pin
    // moved with it.
    const definitions = TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_DEFINITIONS;
    const sampler = definitions.slice(
      definitions.indexOf("fn terrainSampleHeightGradient"),
      definitions.indexOf("fn terrainSurfaceCornerMorphs"),
    );
    expect(sampler.length).toBeGreaterThan(200);
    const digest = createHash("sha256")
      .update(sampler)
      .update(TERRAIN_SURFACE_VERTEX_WGSL.CUSTOM_VERTEX_UPDATE_POSITION)
      .digest("hex")
      .slice(0, 16);
    expect(digest).toBe("515509eb6c8fd3da");
  });
});
