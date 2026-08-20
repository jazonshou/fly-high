import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import {
  TERRAIN_NODES_PER_SLOT_EDGE,
  TERRAIN_NODE_GRID_RESOLUTION,
  terrainNodeSpanMeters,
} from "./TerrainSpineContract";
import {
  createWorldPageAddress,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";

/**
 * The CDLOD quadtree (`4-5`).
 *
 * INVARIANT THIS FILE OWNS: which pieces of ground are drawn, at what level,
 * and how each one morphs toward its parent. One selection, one morph rule,
 * one node record layout — and all three are pure functions over numbers, so
 * they are asserted in Node rather than inspected on screen.
 *
 * This is what closes audit root cause #7 (no screen-space-error LOD, no
 * geomorphing). A node splits when its MEASURED deviation from its parent
 * subtends more than `cdlodPixelThreshold` pixels — not when it crosses a
 * hand-placed ring — and it morphs into its parent's lattice before it is
 * replaced, so there is nothing to pop.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **`morphK` is computed HERE, on the CPU, against the beauty camera**, and
 *   carried per instance. The same vertex shader runs for the beauty camera,
 *   for each shadow cascade under the `ShadowDepthWrapper`, and for the
 *   planar-reflection camera; an in-shader camera-relative morph makes those
 *   three surfaces disagree about where the ground is, which is a
 *   depth-fighting and shadow-acne bug that looks like everything except its
 *   cause.
 * - **Crack closure is analytic, not tuned.** At `morphK = 1` a fine node's
 *   edge vertices sit exactly on its parent's even-vertex lattice, so the two
 *   edges are the same curve. That is what lets skirts be deleted, which is
 *   what lets `backFaceCulling` be true.
 */

export interface TerrainNodeSelectionInput {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  /**
   * `viewportHeightPixels / (2 * tan(verticalFov / 2))` — metres to pixels at
   * unit distance. One number, so the selector never sees a camera.
   */
  readonly pixelsPerMeterAtUnitDistance: number;
  readonly pixelThreshold: number;
  readonly nodeBudget: number;
  /** The finest level this tier ever streams (`4-0`'s profile field). */
  readonly finestResidentLevel: number;
  /** The coarsest level the tree roots at; its span must cover the far plane. */
  readonly coarsestLevel: number;
  readonly farPlaneMeters: number;
  /**
   * Deviation from parent for a page, in metres, as MEASURED by the generation
   * pass. Returns null when the page is not resident — an unmeasured node is
   * never split, because splitting on a guess is how a budget is blown on
   * ground nobody can see.
   */
  readonly deviationFor: (address: WorldPageAddress) => number | null;
}

export interface TerrainNode {
  readonly address: WorldPageAddress;
  readonly subNodeX: number;
  readonly subNodeZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly spanMeters: number;
  readonly level: number;
  /** 0 = fully at this level, 1 = exactly the parent's lattice. */
  readonly morphK: number;
  readonly maxDeviationMeters: number;
  readonly distanceMeters: number;
}

/** Screen-space error, in pixels, of a deviation at a distance. */
export function terrainScreenSpaceError(
  deviationMeters: number,
  distanceMeters: number,
  pixelsPerMeterAtUnitDistance: number,
): number {
  return (deviationMeters * pixelsPerMeterAtUnitDistance) / Math.max(1, distanceMeters);
}

/**
 * Morph weight for a node at a distance.
 *
 * A node is legal while its own error is under the threshold; it must be gone
 * by the distance at which its PARENT is also legal. A parent's deviation is
 * about twice its child's (one level of detail), so the parent becomes legal
 * at roughly twice the child's split distance — and the morph runs over the
 * last quarter of that interval so the transition is complete before the swap
 * rather than at it.
 */
export function terrainNodeMorphK(distanceMeters: number, splitDistanceMeters: number): number {
  if (!(splitDistanceMeters > 0)) return 0;
  const start = splitDistanceMeters * 1.5;
  const end = splitDistanceMeters * 2;
  if (distanceMeters <= start) return 0;
  if (distanceMeters >= end) return 1;
  return (distanceMeters - start) / (end - start);
}

function distanceToNode(
  input: TerrainNodeSelectionInput,
  originX: number,
  originZ: number,
  span: number,
): number {
  const dx = Math.max(originX - input.cameraX, 0, input.cameraX - (originX + span));
  const dz = Math.max(originZ - input.cameraZ, 0, input.cameraZ - (originZ + span));
  // 3D: an aircraft at 10,000 ft over a node is far from it, and a 2D
  // distance would split the ground directly below to its finest level for
  // the whole cruise.
  return Math.sqrt(dx * dx + dz * dz + input.cameraY * input.cameraY);
}

interface Candidate {
  readonly address: WorldPageAddress;
  readonly subNodeX: number;
  readonly subNodeZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly spanMeters: number;
  readonly level: number;
  readonly distanceMeters: number;
  readonly deviationMeters: number;
}

function makeCandidate(
  input: TerrainNodeSelectionInput,
  level: number,
  nodeX: number,
  nodeZ: number,
): Candidate | null {
  const span = terrainNodeSpanMeters(level);
  const originX = nodeX * span;
  const originZ = nodeZ * span;
  const distanceMeters = distanceToNode(input, originX, originZ, span);
  if (distanceMeters > input.farPlaneMeters) return null;
  const pageX = Math.floor(nodeX / TERRAIN_NODES_PER_SLOT_EDGE);
  const pageZ = Math.floor(nodeZ / TERRAIN_NODES_PER_SLOT_EDGE);
  const address = createWorldPageAddress(level, pageX, pageZ);
  const deviation = input.deviationFor(address);
  return {
    address,
    subNodeX: nodeX - pageX * TERRAIN_NODES_PER_SLOT_EDGE,
    subNodeZ: nodeZ - pageZ * TERRAIN_NODES_PER_SLOT_EDGE,
    originX,
    originZ,
    spanMeters: span,
    level,
    distanceMeters,
    // A page with no measurement yet is treated as flat, so it is drawn
    // coarse and never split — never skipped.
    deviationMeters: deviation ?? 0,
  };
}

/**
 * Select the drawn node set, coarsest-first under a hard budget.
 *
 * Breadth-first by level and NOT depth-first: a depth-first descent spends the
 * whole budget on the first quadrant it enters, so the ground behind the
 * aircraft disappears rather than coarsening. Coarsest-first means the budget
 * runs out as a resolution limit, everywhere at once.
 */
export function selectTerrainNodes(input: TerrainNodeSelectionInput): TerrainNode[] {
  const finest = Math.max(0, input.finestResidentLevel);
  const coarsest = Math.max(finest, input.coarsestLevel);
  const rootSpan = terrainNodeSpanMeters(coarsest);
  const reach = Math.ceil(input.farPlaneMeters / rootSpan) + 1;
  const rootX = Math.floor(input.cameraX / rootSpan);
  const rootZ = Math.floor(input.cameraZ / rootSpan);

  let frontier: Candidate[] = [];
  for (let dz = -reach; dz <= reach; dz += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const candidate = makeCandidate(input, coarsest, rootX + dx, rootZ + dz);
      if (candidate) frontier.push(candidate);
    }
  }

  const emitted: Candidate[] = [];
  while (frontier.length > 0) {
    const next: Candidate[] = [];
    // Nearest first inside a level, so the budget is spent where the error is.
    frontier.sort((first, second) => first.distanceMeters - second.distanceMeters);
    for (let index = 0; index < frontier.length; index += 1) {
      const candidate = frontier[index]!;
      const error = terrainScreenSpaceError(
        candidate.deviationMeters,
        candidate.distanceMeters,
        input.pixelsPerMeterAtUnitDistance,
      );
      // A split replaces one node with four, so it costs three. The live
      // total is everything already emitted, everything queued for the next
      // level, and everything still ahead in this one — counting only the
      // first two lets a level's tail overrun the budget silently.
      const live = emitted.length + next.length + (frontier.length - index);
      const canSplit = candidate.level > finest && live + 3 <= input.nodeBudget;
      if (error > input.pixelThreshold && canSplit) {
        const childLevel = candidate.level - 1;
        const childSpan = terrainNodeSpanMeters(childLevel);
        const baseX = Math.round(candidate.originX / childSpan);
        const baseZ = Math.round(candidate.originZ / childSpan);
        for (let dz = 0; dz < 2; dz += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const child = makeCandidate(input, childLevel, baseX + dx, baseZ + dz);
            if (child) next.push(child);
          }
        }
        continue;
      }
      emitted.push(candidate);
    }
    frontier = next;
  }

  return emitted.map((candidate) => {
    const splitDistance = candidate.deviationMeters > 0
      ? (candidate.deviationMeters * input.pixelsPerMeterAtUnitDistance) / input.pixelThreshold
      : 0;
    return Object.freeze({
      address: candidate.address,
      subNodeX: candidate.subNodeX,
      subNodeZ: candidate.subNodeZ,
      originX: candidate.originX,
      originZ: candidate.originZ,
      spanMeters: candidate.spanMeters,
      level: candidate.level,
      // The coarsest level has no parent to morph into.
      morphK: candidate.level >= input.coarsestLevel
        ? 0
        : terrainNodeMorphK(candidate.distanceMeters, splitDistance),
      maxDeviationMeters: candidate.deviationMeters,
      distanceMeters: candidate.distanceMeters,
    });
  });
}

// ---------------------------------------------------------------------------
// The node record
// ---------------------------------------------------------------------------

/**
 * Lane packing, stated once because the CPU writer and the WGSL reader cannot
 * be held together by anything else.
 *
 * `terrainNodeA = (slotIndex, subIndex, level, splatPacked)`, where `subIndex`
 * is `subNodeX + subNodeZ*8 + parityX*64 + parityZ*128`
 * `terrainNodeB = (morphK, parentSlotIndex, channelLane, maxDeviation)`, where
 * `channelLane` is `channelSlotIndex * 32 + level` — the same packing `3-2`'s
 * `atlasSlot` vertex lane used, because the fragment needs the page EXTENT to
 * normalise its position into channel-atlas UV and a shared material cannot
 * carry a per-mesh uniform. It is the CHANNEL slot, not the height slot: the
 * two atlases have independent slot budgets (100 vs 144 at tier 0) and
 * independent free lists, so they diverge.
 *
 * Two stride-4 attributes, not one stride-8: a custom kind resolves to
 * `_size = 8` inside `VertexBuffer`, and `WebGPUCacheRenderPipeline` falls
 * through its format table and throws `Invalid Format ... size=8` — WebGPU has
 * no vertex format wider than four components.
 *
 * `subNodeX` and `subNodeZ` share a lane so the splat can have one. They are
 * each under 8 by construction (one 264² slot serves an 8×8 block of nodes),
 * so the packed value is under 64 and exact.
 */
export const TERRAIN_NODE_LANE_STRIDE = 4;

export function packTerrainNodeSubIndex(
  subNodeX: number,
  subNodeZ: number,
  pageParityX: number,
  pageParityZ: number,
): number {
  // Page parity rides along because the vertex shader needs to know WHICH
  // quadrant of its parent page a node sits in to address the parent's
  // texels — and the parent's texels are what the geomorph mixes toward.
  return subNodeX
    + subNodeZ * TERRAIN_NODES_PER_SLOT_EDGE
    + pageParityX * 64
    + pageParityZ * 128;
}

/**
 * The provisional two-material blend, packed into one lane.
 *
 * `4-5` deletes the CPU tile meshes and with them the per-vertex splat lanes
 * that are the ONLY material source until `4-6` lands. Without a carry-forward
 * the gate the plan calls its most visible would ship an untextured PBR
 * surface — it would delete the entire Phase 3 deliverable. Ids are under 16
 * and the weight is quantised to 1/100, so the packed value is under 1,700 and
 * exact in f32.
 */
export function packTerrainNodeSplat(
  primaryId: number,
  secondaryId: number,
  secondaryWeight: number,
): number {
  const primary = Math.max(0, Math.min(15, Math.round(primaryId)));
  const secondary = Math.max(0, Math.min(15, Math.round(secondaryId)));
  const weight = Math.max(0, Math.min(100, Math.round(secondaryWeight * 100)));
  return primary * 1_600 + secondary * 100 + weight;
}

/**
 * Reusable instance storage for one mesh, sized to the node budget ONCE.
 *
 * **Not a fresh allocation per frame**, and the reason is a GPU lifetime rather
 * than GC pressure: `thinInstanceSetBuffer` with a new array disposes the
 * previous `Buffer` and creates another, and Babylon records a frame's draws
 * into render bundles that are submitted later — so the buffer a bundle
 * references can be destroyed before the submit reaches it. That surfaces as
 * `used in submit while destroyed`, which invalidates the whole command buffer
 * and drops the frame: **the entire screen goes black, including the sky.**
 * Found by running the app, not by any test.
 */
export interface TerrainNodeBuffers {
  readonly matrices: Float32Array;
  readonly laneA: Float32Array;
  readonly laneB: Float32Array;
  /** Instances written this frame; the arrays stay at their capacity. */
  count: number;
  readonly capacity: number;
}

export function createTerrainNodeBuffers(capacity: number): TerrainNodeBuffers {
  const slots = Math.max(1, Math.floor(capacity));
  return {
    matrices: new Float32Array(slots * 16),
    laneA: new Float32Array(slots * TERRAIN_NODE_LANE_STRIDE),
    laneB: new Float32Array(slots * TERRAIN_NODE_LANE_STRIDE),
    count: 0,
    capacity: slots,
  };
}

export interface TerrainNodeWriteInput {
  readonly nodes: readonly TerrainNode[];
  readonly originX: number;
  readonly originZ: number;
  readonly slotFor: (address: WorldPageAddress) => number;
  /** Channel-atlas slot, or -1 when the page holds no channel slot. */
  readonly channelSlotFor: (address: WorldPageAddress) => number;
  readonly splatFor: (node: TerrainNode) => number;
}

/**
 * Write the instance buffers.
 *
 * The 16-float world matrix is NOT redundant with the two lanes:
 * `thinInstanceSetBuffer` updates `instancesCount` only for kind `"matrix"`
 * and `"splatIndex"` — the generic branch sets no count, and the
 * `thinInstanceCount` setter clamps to `matrixData.length / 16` and silently
 * does nothing without one. It also carries node origin and scale for free.
 */
export function writeTerrainNodeBuffers(
  input: TerrainNodeWriteInput,
  target: TerrainNodeBuffers,
): TerrainNodeBuffers {
  const { matrices, laneA, laneB } = target;
  const count = Math.min(input.nodes.length, target.capacity);
  target.count = count;
  // Only the written prefix is read (`thinInstanceCount` is set to `count`),
  // but a stale matrix left behind a shrinking node set would draw a node that
  // is no longer selected if the count is ever raised without a rewrite.
  matrices.fill(0, count * 16);
  input.nodes.slice(0, count).forEach((node, index) => {
    const scale = node.spanMeters;
    const base = index * 16;
    // Column-major, matching Babylon's Matrix.m layout: scale on the
    // diagonal, camera-relative translation in the last row.
    matrices[base] = scale;
    matrices[base + 5] = 1;
    matrices[base + 10] = scale;
    matrices[base + 12] = node.originX - input.originX;
    matrices[base + 13] = 0;
    matrices[base + 14] = node.originZ - input.originZ;
    matrices[base + 15] = 1;

    const slot = input.slotFor(node.address);
    const parentAddress = node.level < 30
      ? createWorldPageAddress(
        node.level + 1,
        Math.floor(node.address.x / 2),
        Math.floor(node.address.z / 2),
      )
      : node.address;
    const parentSlot = input.slotFor(parentAddress);
    const laneBase = index * TERRAIN_NODE_LANE_STRIDE;
    laneA[laneBase] = slot;
    laneA[laneBase + 1] = packTerrainNodeSubIndex(
      node.subNodeX,
      node.subNodeZ,
      node.address.x - Math.floor(node.address.x / 2) * 2,
      node.address.z - Math.floor(node.address.z / 2) * 2,
    );
    laneA[laneBase + 2] = node.level;
    laneA[laneBase + 3] = input.splatFor(node);
    // A node whose parent is not resident cannot morph into it: the parent's
    // heights are not there to sample, and morphing toward an unwritten slot
    // is a hole in the ground rather than a smooth transition.
    laneB[laneBase] = parentSlot >= 0 ? node.morphK : 0;
    laneB[laneBase + 1] = parentSlot;
    const channelSlot = input.channelSlotFor(node.address);
    // -1 when the page holds no channel slot: the fragment falls back to the
    // provisional per-node splat, which is the co-residency rule `4-2` states.
    laneB[laneBase + 2] = channelSlot >= 0 ? channelSlot * 32 + node.level : -1;
    laneB[laneBase + 3] = node.maxDeviationMeters;
  });
  return target;
}

// ---------------------------------------------------------------------------
// The one grid
// ---------------------------------------------------------------------------

/**
 * The single 33×33 unit grid every node instances (2,048 triangles).
 *
 * Unit-sized: the node's world matrix carries its span, so one geometry serves
 * every level. NO SKIRTS — `TERRAIN_SKIRT_DEPTH_METERS` and
 * `buildTerrainIndicesWithSkirt` are deleted at this item, because the
 * geomorph closes cracks analytically and a skirt is a wall of geometry that
 * shows as a line grid on ridge silhouettes.
 */
export function buildTerrainNodeGrid(): VertexData {
  const edge = TERRAIN_NODE_GRID_RESOLUTION;
  const vertexCount = edge * edge;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const step = 1 / (edge - 1);
  for (let row = 0; row < edge; row += 1) {
    for (let column = 0; column < edge; column += 1) {
      const index = row * edge + column;
      positions[index * 3] = column * step;
      positions[index * 3 + 1] = 0;
      positions[index * 3 + 2] = row * step;
      normals[index * 3 + 1] = 1;
      uvs[index * 2] = column * step;
      uvs[index * 2 + 1] = row * step;
    }
  }
  const indices = new Uint16Array((edge - 1) * (edge - 1) * 6);
  let offset = 0;
  for (let row = 0; row < edge - 1; row += 1) {
    for (let column = 0; column < edge - 1; column += 1) {
      const topLeft = row * edge + column;
      const bottomLeft = topLeft + edge;
      indices[offset++] = topLeft;
      indices[offset++] = topLeft + 1;
      indices[offset++] = bottomLeft;
      indices[offset++] = topLeft + 1;
      indices[offset++] = bottomLeft + 1;
      indices[offset++] = bottomLeft;
    }
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}
