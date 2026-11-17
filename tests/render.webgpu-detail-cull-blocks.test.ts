import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { describe, expect, it } from "vitest";
import {
  DETAIL_NO_CULL_BLOCKS,
  installDetailBlockFrustumTest,
} from "../src/render/webgpu/detail/blockFrustumTest";
import {
  DETAIL_CULL_BLOCK_METERS,
  DETAIL_CULL_BLOCK_SLOTS,
  DETAIL_CULL_BLOCK_STRIDE,
  DetailInstanceBounds,
  DetailInstanceWriter,
  detailCullBlocksIntersectFrustum,
  detailPrototypeBoundKernel,
  isDetailCullBlockList,
  type DetailInstanceRecord,
} from "../src/render/webgpu/detail/instanceFormat";
import {
  DETAIL_PRESENTATION_CHUNK_CELL_SPAN,
} from "../src/render/webgpu/detail/spatialChunks";
import { DEFAULT_DETAIL_CELL_SIZE_METERS } from "../src/render/webgpu/detail/types";

/**
 * A batch's frustum test by culling blocks. Three properties carry it:
 *
 *  1. every instance's own bound lies inside the block its position falls in
 *     (so a batch the block test rejects had nothing to rasterise),
 *  2. the test never rejects a batch any of whose instances touches the
 *     frustum (checked against an exact per-instance test over random views),
 *  3. it does reject the batch the whole box cannot: the camera inside the
 *     box, looking away from every instance.
 */

const CHUNK_METERS = DETAIL_PRESENTATION_CHUNK_CELL_SPAN * DEFAULT_DETAIL_CELL_SIZE_METERS;

const KERNEL = detailPrototypeBoundKernel({
  minimum: [-0.5, 0, -0.5],
  maximum: [0.5, 1, 0.5],
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function record(x: number, y: number, z: number, heightMeters: number, random: () => number): DetailInstanceRecord {
  return {
    x,
    y,
    z,
    quaternion: [0, 0, 0, 1],
    heightScaleMeters: heightMeters,
    radialScale: 0.4 + random() * 0.8,
    tint: [1, 1, 1, 1],
    fade: 1,
    fadeIncoming: false,
    variant: Math.floor(random() * 256),
    windPhase: random(),
    windResponse: random(),
  };
}

interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** One record's own bound, from the accumulator itself. */
function ownBox(entry: DetailInstanceRecord): Box {
  const bounds = new DetailInstanceBounds();
  new DetailInstanceWriter(1).pushBounded(entry, bounds, KERNEL);
  return { min: bounds.minimum(), max: bounds.maximum() };
}

function blockRows(blocks: Float64Array): Box[] {
  const rows: Box[] = [];
  for (let base = 0; base < blocks.length; base += DETAIL_CULL_BLOCK_STRIDE) {
    rows.push({
      min: [blocks[base]!, blocks[base + 1]!, blocks[base + 2]!],
      max: [blocks[base + 3]!, blocks[base + 4]!, blocks[base + 5]!],
    });
  }
  return rows;
}

function contains(outer: Box, inner: Box): boolean {
  return [0, 1, 2].every((axis) =>
    inner.min[axis]! >= outer.min[axis]! && inner.max[axis]! <= outer.max[axis]!);
}

/** `count` records scattered over a square of `spanMeters` whose corner is `(originX, originZ)`. */
function scatter(
  seed: number,
  count: number,
  originX: number,
  originZ: number,
  spanMeters: number,
): DetailInstanceRecord[] {
  const random = mulberry32(seed);
  const records: DetailInstanceRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    records.push(record(
      originX + random() * spanMeters,
      200 + random() * 900,
      originZ + random() * spanMeters,
      3 + random() * 30,
      random,
    ));
  }
  return records;
}

function accumulate(records: readonly DetailInstanceRecord[], bounds = new DetailInstanceBounds()): DetailInstanceBounds {
  const writer = new DetailInstanceWriter(Math.max(1, records.length));
  for (const entry of records) writer.pushBounded(entry, bounds, KERNEL);
  return bounds;
}

function frustumPlanes(eye: Vector3, target: Vector3): Plane[] {
  const view = Matrix.LookAtLH(eye, target, Vector3.Up());
  const projection = Matrix.PerspectiveFovLH(0.9, 16 / 9, 0.5, 45_000);
  return Frustum.GetPlanes(view.multiply(projection));
}

function boxTouchesFrustum(box: Box, planes: readonly Plane[]): boolean {
  return detailCullBlocksIntersectFrustum(
    new Float64Array([...box.min, ...box.max]),
    planes,
    0,
    0,
    0,
  );
}

describe("detail culling blocks", () => {
  it("sizes the lattice for a presentation chunk that is not aligned to it", () => {
    // Sixteen blocks span the chunk; an unaligned chunk touches one more.
    expect(CHUNK_METERS / DETAIL_CULL_BLOCK_METERS).toBe(16);
    expect(DETAIL_CULL_BLOCK_SLOTS).toBe(CHUNK_METERS / DETAIL_CULL_BLOCK_METERS + 1);
  });

  it("puts every instance's own bound inside the block its position falls in", () => {
    // The record origin is the floating origin, anywhere in the world and
    // either side of zero: the chunk's corner is not on the lattice.
    for (const [seed, originX, originZ] of [
      [1, 0, 0],
      [2, -1_733.5, 9_120.25],
      [3, 80_001.75, -64_333],
      [4, -4_096, -4_096],
    ] as const) {
      const records = scatter(seed, 4_000, originX, originZ, CHUNK_METERS);
      const bounds = accumulate(records);
      const blocks = bounds.blockExtents();
      const rows = blockRows(blocks);
      expect(rows.length).toBeGreaterThan(200);
      expect(rows.length).toBeLessThanOrEqual(DETAIL_CULL_BLOCK_SLOTS * DETAIL_CULL_BLOCK_SLOTS);
      expect(isDetailCullBlockList(blocks, bounds.minimum(), bounds.maximum())).toBe(true);

      // The blocks' union is the whole box, exactly.
      const whole = { min: bounds.minimum(), max: bounds.maximum() };
      for (let axis = 0; axis < 3; axis += 1) {
        expect(Math.min(...rows.map((row) => row.min[axis]!))).toBe(whole.min[axis]);
        expect(Math.max(...rows.map((row) => row.max[axis]!))).toBe(whole.max[axis]);
      }

      // No two lattice blocks shared a slot: a block is one lattice square
      // wide plus its instances' reach (48 m trees, radial scale under 1.2).
      for (const row of rows) {
        expect(row.max[0]! - row.min[0]!).toBeLessThan(DETAIL_CULL_BLOCK_METERS + 2 * 80);
        expect(row.max[2]! - row.min[2]!).toBeLessThan(DETAIL_CULL_BLOCK_METERS + 2 * 80);
      }

      for (const entry of records) {
        const own = ownBox(entry);
        const holders = rows.filter((row) => contains(row, own));
        expect(holders.length).toBeGreaterThanOrEqual(1);
        // And the holder is the block under the instance, not a far one.
        const x = Math.fround(entry.x);
        const z = Math.fround(entry.z);
        expect(holders.some((row) =>
          Math.floor(x / DETAIL_CULL_BLOCK_METERS) === Math.floor(
            (row.min[0]! + row.max[0]!) / 2 / DETAIL_CULL_BLOCK_METERS,
          )
          || (x >= row.min[0]! && x <= row.max[0]! && z >= row.min[2]! && z <= row.max[2]!))).toBe(true);
      }
    }
  });

  it("stays conservative when a batch is wider than the lattice and blocks share a slot", () => {
    const records = scatter(11, 3_000, -6_000.5, 2_500.25, CHUNK_METERS * 3);
    const bounds = accumulate(records);
    const rows = blockRows(bounds.blockExtents());
    expect(rows.length).toBeLessThanOrEqual(DETAIL_CULL_BLOCK_SLOTS * DETAIL_CULL_BLOCK_SLOTS);
    // Shared slots: some block is far wider than one lattice square...
    expect(rows.some((row) => row.max[0]! - row.min[0]! > CHUNK_METERS)).toBe(true);
    // ...and every instance is still inside one.
    for (const entry of records) {
      const own = ownBox(entry);
      expect(rows.some((row) => contains(row, own))).toBe(true);
    }
  });

  it("keeps the taken list until reset, and keeps its blocks when more instances arrive", () => {
    const first = scatter(21, 300, 100, 100, 600);
    const second = scatter(22, 300, 2_000, 2_000, 600);
    const bounds = accumulate(first);
    const taken = bounds.blockExtents();
    expect(bounds.blockExtents()).toBe(taken);
    const takenCopy = Float64Array.from(taken);

    accumulate(second, bounds);
    const both = bounds.blockExtents();
    expect(both).not.toBe(taken);
    // The earlier list is a published batch's: it is never written again.
    expect(taken).toEqual(takenCopy);
    const rows = blockRows(both);
    for (const entry of [...first, ...second]) {
      const own = ownBox(entry);
      expect(rows.some((row) => contains(row, own))).toBe(true);
    }
    expect(isDetailCullBlockList(both, bounds.minimum(), bounds.maximum())).toBe(true);

    bounds.reset();
    expect(bounds.isEmpty).toBe(true);
    expect(bounds.blockExtents().length).toBe(0);
    expect(taken).toEqual(takenCopy);
  });

  it("hands a recycled grid back clean", () => {
    // The grid is pooled across bounds objects: nothing of one batch may
    // widen the next one's blocks.
    const far = accumulate(scatter(31, 2_000, 50_000, 50_000, CHUNK_METERS));
    far.blockExtents();
    const abandoned = accumulate(scatter(32, 2_000, -90_000, 10_000, CHUNK_METERS));
    abandoned.reset();

    const records = scatter(33, 50, 300, 300, 200);
    const bounds = accumulate(records);
    const blocks = bounds.blockExtents();
    expect(isDetailCullBlockList(blocks, bounds.minimum(), bounds.maximum())).toBe(true);
    expect(blocks.length / DETAIL_CULL_BLOCK_STRIDE).toBeLessThanOrEqual(4);
  });

  it("has no blocks for extents that arrived without them, and adopts the ones that did", () => {
    const bare = DetailInstanceBounds.fromExtents([0, 0, 0], [10, 10, 10]);
    expect(bare.blockExtents().length).toBe(0);
    // Blocks begun now could not cover what the extents already stand for.
    new DetailInstanceWriter(1).pushBounded(record(5, 5, 5, 4, mulberry32(1)), bare, KERNEL);
    expect(bare.blockExtents().length).toBe(0);
    bare.reset();
    new DetailInstanceWriter(1).pushBounded(record(5, 5, 5, 4, mulberry32(1)), bare, KERNEL);
    expect(bare.blockExtents().length).toBe(DETAIL_CULL_BLOCK_STRIDE);

    const blocks = new Float64Array([0, 0, 0, 4, 10, 10, 6, 0, 0, 10, 10, 10]);
    const adopted = DetailInstanceBounds.fromExtents([0, 0, 0], [10, 10, 10], blocks);
    expect(adopted.blockExtents()).toBe(blocks);

    expect(() => DetailInstanceBounds.fromExtents([0, 0, 0], [10, 10, 10], new Float64Array(0)))
      .toThrow(/culling blocks/);
    expect(() => DetailInstanceBounds.fromExtents([0, 0, 0], [10, 10, 10], new Float64Array(7)))
      .toThrow(/culling blocks/);
    expect(() => DetailInstanceBounds.fromExtents(
      [0, 0, 0],
      [10, 10, 10],
      new Float64Array([0, 0, 0, 11, 10, 10]),
    )).toThrow(/culling blocks/);
    expect(() => DetailInstanceBounds.fromExtents(
      [0, 0, 0],
      [10, 10, 10],
      new Float64Array([0, 0, Number.NaN, 10, 10, 10]),
    )).toThrow(/culling blocks/);
  });
});

describe("detail block frustum test", () => {
  it("never rejects a batch with an instance in view, over random views", () => {
    const random = mulberry32(77);
    let rejected = 0;
    let nothingInView = 0;
    let wholeBoxPassed = 0;
    for (let batchIndex = 0; batchIndex < 12; batchIndex += 1) {
      // Thin stands and dense ones, in a strip, a corner or all over.
      const count = [3, 12, 60, 400][batchIndex % 4]!;
      const span = [300, 900, 2_400, CHUNK_METERS][Math.floor(batchIndex / 4) % 4]!;
      const originX = -2_000 + random() * 1_000;
      const originZ = 7_000 + random() * 1_000;
      const records = scatter(
        100 + batchIndex,
        count,
        originX + random() * (CHUNK_METERS - span),
        originZ + random() * (CHUNK_METERS - span),
        span,
      );
      const bounds = accumulate(records);
      const blocks = bounds.blockExtents();
      const whole = { min: bounds.minimum(), max: bounds.maximum() };
      const boxes = records.map(ownBox);
      const offset: [number, number, number] = [
        Math.fround(random() * 2_000 - 1_000),
        Math.fround(random() * 40 - 20),
        Math.fround(random() * 2_000 - 1_000),
      ];
      const moved = (box: Box): Box => ({
        min: [box.min[0]! + offset[0], box.min[1]! + offset[1], box.min[2]! + offset[2]],
        max: [box.max[0]! + offset[0], box.max[1]! + offset[1], box.max[2]! + offset[2]],
      });

      for (let view = 0; view < 160; view += 1) {
        // Eyes inside the chunk (the case the whole box always passes),
        // above it, and outside it; looking anywhere.
        const eye = new Vector3(
          originX + offset[0] + (random() * 1.6 - 0.3) * CHUNK_METERS,
          offset[1] + 150 + random() * 1_400,
          originZ + offset[2] + (random() * 1.6 - 0.3) * CHUNK_METERS,
        );
        const yaw = random() * Math.PI * 2;
        const pitch = (random() - 0.6) * 1.4;
        const target = eye.add(new Vector3(
          Math.cos(pitch) * Math.sin(yaw),
          Math.sin(pitch),
          Math.cos(pitch) * Math.cos(yaw),
        ));
        const planes = frustumPlanes(eye, target);
        const byBlocks = detailCullBlocksIntersectFrustum(blocks, planes, offset[0], offset[1], offset[2]);
        const anyInstance = boxes.some((box) => boxTouchesFrustum(moved(box), planes));
        if (anyInstance) expect(byBlocks).toBe(true);
        if (boxTouchesFrustum(moved(whole), planes)) {
          wholeBoxPassed += 1;
          if (!anyInstance) nothingInView += 1;
          if (!byBlocks) rejected += 1;
        } else {
          // The blocks lie inside the whole box: what misses it misses them.
          expect(byBlocks).toBe(false);
        }
      }
    }
    // The point of the blocks: of the views the whole box lets through with
    // nothing of the batch in them, they catch most of what a test of every
    // instance would.
    expect(wholeBoxPassed).toBeGreaterThan(400);
    expect(nothingInView).toBeGreaterThan(50);
    expect(rejected).toBeLessThanOrEqual(nothingInView);
    expect(rejected / nothingInView).toBeGreaterThan(0.6);
  });

  it("rejects the batch behind a camera that stands inside its box", () => {
    // Trees along the west and east edges of a chunk; the eye in the middle
    // looking north sees neither, and the one box over both contains the eye.
    const west = scatter(41, 40, 0, 0, 200).map((entry) => ({ ...entry, z: entry.z * 20 }));
    const east = scatter(42, 40, 3_800, 0, 200).map((entry) => ({ ...entry, z: entry.z * 20 }));
    const bounds = accumulate([...west, ...east]);
    const whole = { min: bounds.minimum(), max: bounds.maximum() };
    const eye = new Vector3(2_000, 600, 2_000);
    const north = frustumPlanes(eye, eye.add(new Vector3(0, -0.1, 1)));
    const westward = frustumPlanes(eye, eye.add(new Vector3(-1, -0.1, 0)));
    expect(boxTouchesFrustum(whole, north)).toBe(true);
    expect(detailCullBlocksIntersectFrustum(bounds.blockExtents(), north, 0, 0, 0)).toBe(false);
    expect(detailCullBlocksIntersectFrustum(bounds.blockExtents(), westward, 0, 0, 0)).toBe(true);
  });

  it("agrees with Babylon's box test on a single box", () => {
    const random = mulberry32(5);
    for (let index = 0; index < 400; index += 1) {
      const min = new Vector3(random() * 400 - 200, random() * 100, random() * 400 - 200);
      const max = min.add(new Vector3(1 + random() * 300, 1 + random() * 80, 1 + random() * 300));
      const eye = new Vector3(random() * 800 - 400, random() * 300, random() * 800 - 400);
      const planes = frustumPlanes(eye, eye.add(new Vector3(random() - 0.5, random() - 0.6, random() - 0.5)));
      const babylon = new BoundingInfo(min, max).boundingBox.isInFrustum(planes);
      expect(detailCullBlocksIntersectFrustum(
        new Float64Array([min.x, min.y, min.z, max.x, max.y, max.z]),
        planes,
        0,
        0,
        0,
      )).toBe(babylon);
    }
  });

  it("answers after the whole box, moved by the mesh's translation", () => {
    const records = scatter(51, 30, 0, 0, 200);
    const bounds = accumulate(records);
    const source = { cullBlocks: bounds.blockExtents() };
    const world = Matrix.Translation(5_000, 0, 0);
    let wholeBox = true;
    let wholeBoxCalls = 0;
    const mesh = {
      isInFrustum(planes: Plane[]): boolean {
        wholeBoxCalls += planes.length > 0 ? 1 : 0;
        return wholeBox;
      },
      getWorldMatrix: () => world,
    };
    installDetailBlockFrustumTest(mesh, source);

    // The instances are at x 5,000 to 5,200 once moved.
    const atOrigin = new Vector3(100, 600, 100);
    const atInstances = new Vector3(5_100, 600, 100);
    const down = new Vector3(0.01, -1, 0.01);
    const lookingAtNothing = frustumPlanes(atOrigin, atOrigin.add(down));
    const lookingAtThem = frustumPlanes(atInstances, atInstances.add(down));
    expect(mesh.isInFrustum(lookingAtThem)).toBe(true);
    expect(mesh.isInFrustum(lookingAtNothing)).toBe(false);
    expect(wholeBoxCalls).toBe(2);

    // The whole box's no is final.
    wholeBox = false;
    expect(mesh.isInFrustum(lookingAtThem)).toBe(false);
    wholeBox = true;

    // No blocks: the whole box decides alone.
    source.cullBlocks = DETAIL_NO_CULL_BLOCKS;
    expect(mesh.isInFrustum(lookingAtNothing)).toBe(true);
    source.cullBlocks = bounds.blockExtents();
    expect(mesh.isInFrustum(lookingAtNothing)).toBe(false);

    // Anything but a translation and the blocks are not where the instances
    // are: the test stands aside.
    Matrix.Scaling(2, 1, 1).multiplyToRef(Matrix.Translation(5_000, 0, 0), world);
    expect(mesh.isInFrustum(lookingAtNothing)).toBe(true);
    Matrix.RotationY(0.3).multiplyToRef(Matrix.Translation(5_000, 0, 0), world);
    expect(mesh.isInFrustum(lookingAtNothing)).toBe(true);
  });
});
