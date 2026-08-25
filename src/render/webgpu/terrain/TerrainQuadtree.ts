import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import {
  TERRAIN_CORNER_MORPH_BITS,
  TERRAIN_CORNER_MORPH_LEVELS,
  TERRAIN_CORNER_MORPH_PACKED_MAX,
  TERRAIN_NODES_PER_SLOT_EDGE,
  TERRAIN_NODE_GRID_RESOLUTION,
  terrainNodeSpanMeters,
} from "./TerrainSpineContract";
import {
  createWorldPageAddress,
  parentWorldPageAddress,
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

/**
 * Optional operation-count instrumentation for the synchronized-boundary
 * pass. Wall-clock microbenchmarks are machine-dependent; these two counters
 * pin the algorithmic bound that keeps the selector safe to run every frame.
 */
export interface TerrainNodeSelectionDiagnostics {
  cornerLeafQueries: number;
  cornerLeafLevelProbes: number;
}

/** Four corners × three other quadrants, plus two probes on each of four sides. */
export const TERRAIN_CORNER_SYNC_MAX_LEAF_QUERIES_PER_NODE = 20;
/** A 2:1 touching-neighbour partition can contain only L-1, L, or L+1 at a point. */
export const TERRAIN_CORNER_SYNC_MAX_LEVEL_PROBES_PER_QUERY = 3;

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
  /**
   * Quantized morph weights at (x0z0, x1z0, x0z1, x1z1).
   *
   * Interior vertices use `morphK`. Boundary vertices interpolate these four
   * locally synchronized values, which is what makes two independently
   * selected thin instances describe one shared edge instead of two nearby
   * curves. A mixed L/L+1 corner is represented as 1 on the fine node and 0
   * on the coarse node: both then sample the exact L+1 surface.
   */
  readonly cornerMorphK: TerrainNodeCornerMorphs;
  readonly maxDeviationMeters: number;
  readonly distanceMeters: number;
}

/** Corner order used by the CPU record and WGSL decoder. */
export type TerrainNodeCornerMorphs = readonly [number, number, number, number];

/** Round once on the CPU so both sides of an edge receive bit-identical K. */
export function quantizeTerrainCornerMorphK(value: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(1, Math.max(0, finite)) * TERRAIN_CORNER_MORPH_LEVELS)
    / TERRAIN_CORNER_MORPH_LEVELS;
}

/** Pack x0z0, x1z0, x0z1, x1z1 into B.w without relying on NaN bit payloads. */
export function packTerrainCornerMorphs(corners: TerrainNodeCornerMorphs): number {
  let packed = 0;
  for (let index = 0; index < 4; index += 1) {
    const quantized = Math.round(
      quantizeTerrainCornerMorphK(corners[index]!) * TERRAIN_CORNER_MORPH_LEVELS,
    );
    packed += quantized * 2 ** (index * TERRAIN_CORNER_MORPH_BITS);
  }
  return packed;
}

/** CPU mirror of the vertex shader's exact integer decoder. */
export function unpackTerrainCornerMorphs(packed: number): TerrainNodeCornerMorphs {
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > TERRAIN_CORNER_MORPH_PACKED_MAX) {
    throw new RangeError("Packed terrain corner morphs must be a 24-bit non-negative integer");
  }
  const values: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) {
    values[index] = Math.floor(packed / 2 ** (index * TERRAIN_CORNER_MORPH_BITS))
      % (TERRAIN_CORNER_MORPH_LEVELS + 1)
      / TERRAIN_CORNER_MORPH_LEVELS;
  }
  return values;
}

/**
 * Effective morph for one grid vertex. Strictly interior vertices retain the
 * unquantized per-node K; only the four shared boundary curves use the packed
 * synchronization contract. A missing parent always wins and returns zero,
 * so an unavailable coarse slot can never pull a boundary down to sea level.
 */
export function terrainNodeVertexMorphK(
  nodeMorphK: number,
  corners: TerrainNodeCornerMorphs,
  gridX: number,
  gridZ: number,
  parentResident = true,
): number {
  if (!parentResident) return 0;
  const quads = TERRAIN_NODE_GRID_RESOLUTION - 1;
  const x = Math.min(quads, Math.max(0, gridX));
  const z = Math.min(quads, Math.max(0, gridZ));
  // Return decoded endpoints verbatim. Computing `a + (b-a)*1` can differ by
  // one ULP from `b`, which would let four incident edges disagree at their
  // supposedly bit-identical corner.
  if (x === 0 && z === 0) return corners[0];
  if (x === quads && z === 0) return corners[1];
  if (x === 0 && z === quads) return corners[2];
  if (x === quads && z === quads) return corners[3];
  if (x === 0) return corners[0] + (corners[2] - corners[0]) * (z / quads);
  if (x === quads) return corners[1] + (corners[3] - corners[1]) * (z / quads);
  if (z === 0) return corners[0] + (corners[1] - corners[0]) * (x / quads);
  if (z === quads) return corners[2] + (corners[3] - corners[2]) * (x / quads);
  return Math.min(1, Math.max(0, nodeMorphK));
}

/**
 * Resolve the one transient the selector cannot see: a selected node whose
 * own fine page is still generating (or was evicted after selection).
 *
 * If one same-level participant at a world corner lacks its fine page, it
 * samples its parent field for every K. Raising every participant at that
 * corner to K=1 makes the resident peers sample that exact same field too.
 * Both endpoints of their shared edge are resolved from the same incident
 * set, so the whole line remains identical. Mixed-level corners already use
 * fine=1/coarse=0 and need no residency amendment.
 *
 * The amendment is applied only when every participant has a resident parent.
 * `TerrainClipmapSystem` guarantees that for selected non-root nodes by
 * selecting children only from a resident candidate, touching all selected
 * parents before any new admission, and writing the records in that frame.
 * Keeping the guard here makes arbitrary unit-test callers memory-safe too.
 */
export function resolveTerrainResidentCornerMorphs(
  nodes: readonly TerrainNode[],
  slotFor: (address: WorldPageAddress) => number,
): readonly TerrainNodeCornerMorphs[] {
  const resolved = nodes.map((node): [number, number, number, number] => [
    node.cornerMorphK[0],
    node.cornerMorphK[1],
    node.cornerMorphK[2],
    node.cornerMorphK[3],
  ]);
  const ownSlots = nodes.map((node) => slotFor(node.address));
  const parentSlots = nodes.map((node) => slotFor(
    parentWorldPageAddress(node.address) ?? node.address,
  ));
  const vertices = new Map<string, Array<{
    readonly nodeIndex: number;
    readonly corner: number;
  }>>();
  const add = (nodeIndex: number, corner: number, x: number, z: number): void => {
    const key = `${x}:${z}`;
    const entries = vertices.get(key) ?? [];
    entries.push({ nodeIndex, corner });
    vertices.set(key, entries);
  };
  nodes.forEach((node, nodeIndex) => {
    const x1 = node.originX + node.spanMeters;
    const z1 = node.originZ + node.spanMeters;
    add(nodeIndex, 0, node.originX, node.originZ);
    add(nodeIndex, 1, x1, node.originZ);
    add(nodeIndex, 2, node.originX, z1);
    add(nodeIndex, 3, x1, z1);
  });

  for (const entries of vertices.values()) {
    const firstLevel = nodes[entries[0]!.nodeIndex]!.level;
    const sameLevel = entries.every(
      (entry) => nodes[entry.nodeIndex]!.level === firstLevel,
    );
    const fineMissing = entries.some((entry) => ownSlots[entry.nodeIndex]! < 0);
    const parentsResident = entries.every((entry) => parentSlots[entry.nodeIndex]! >= 0);
    if (!sameLevel || !fineMissing || !parentsResident) continue;
    for (const entry of entries) resolved[entry.nodeIndex]![entry.corner] = 1;
  }
  return resolved;
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
  /** `level:nodeX:nodeZ` — the quadtree identity, not the page identity. */
  readonly key: string;
  readonly nodeX: number;
  readonly nodeZ: number;
  readonly address: WorldPageAddress;
  readonly subNodeX: number;
  readonly subNodeZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly spanMeters: number;
  readonly level: number;
  readonly distanceMeters: number;
  readonly deviationMeters: number;
  /** False while the page carries no measured deviation — never split. */
  readonly measured: boolean;
  /** Screen-space error in pixels, the priority queue's key. */
  readonly errorPixels: number;
  /** Per-frame transition value, filled after the final leaf set is known. */
  morphK: number;
  /** Index in the nearest-first emitted array, filled with `morphK`. */
  emittedIndex: number;
}

function makeCandidate(
  input: TerrainNodeSelectionInput,
  level: number,
  nodeX: number,
  nodeZ: number,
  key: string,
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
  // A page with no measurement yet is treated as flat, so it is drawn
  // coarse and never split — never skipped.
  const deviationMeters = deviation ?? 0;
  return {
    key,
    nodeX,
    nodeZ,
    address,
    subNodeX: nodeX - pageX * TERRAIN_NODES_PER_SLOT_EDGE,
    subNodeZ: nodeZ - pageZ * TERRAIN_NODES_PER_SLOT_EDGE,
    originX,
    originZ,
    spanMeters: span,
    level,
    distanceMeters,
    deviationMeters,
    measured: deviation !== null,
    errorPixels: terrainScreenSpaceError(
      deviationMeters,
      distanceMeters,
      input.pixelsPerMeterAtUnitDistance,
    ),
    morphK: 0,
    emittedIndex: -1,
  };
}

/**
 * Every cell touching a node, including diagonals.
 *
 * Edge-only 2:1 balancing permits an L node and an L+2 node to meet at one
 * corner through two L+1 edge neighbours. The fine node can sample only its
 * immediate parent, so no two-level corner encoding can make those positions
 * equal. Balancing all eight neighbours keeps every incident corner within
 * one level and makes the four-factor record sufficient by construction.
 */
const TOUCHING_NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([1, 0] as const),
  Object.freeze([-1, 0] as const),
  Object.freeze([0, 1] as const),
  Object.freeze([0, -1] as const),
  Object.freeze([1, 1] as const),
  Object.freeze([1, -1] as const),
  Object.freeze([-1, 1] as const),
  Object.freeze([-1, -1] as const),
]);

/**
 * A max-heap over screen-space error, with lazy deletion.
 *
 * A split removes one leaf and adds four, so the queue is written to as often
 * as it is read; re-sorting an array per split is O(n log n) each time, and
 * this runs every frame against a 240-448 node budget.
 */
function createErrorHeap(): {
  push(candidate: Candidate): void;
  pop(): Candidate | null;
} {
  const items: Candidate[] = [];
  return {
    push(candidate: Candidate): void {
      items.push(candidate);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (items[parent]!.errorPixels >= items[index]!.errorPixels) break;
        [items[parent], items[index]] = [items[index]!, items[parent]!];
        index = parent;
      }
    },
    pop(): Candidate | null {
      const top = items[0];
      if (top === undefined) return null;
      const last = items.pop()!;
      if (items.length > 0) {
        items[0] = last;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let largest = index;
          if (left < items.length && items[left]!.errorPixels > items[largest]!.errorPixels) {
            largest = left;
          }
          if (right < items.length && items[right]!.errorPixels > items[largest]!.errorPixels) {
            largest = right;
          }
          if (largest === index) break;
          [items[largest], items[index]] = [items[index]!, items[largest]!];
          index = largest;
        }
      }
      return top;
    },
  };
}

/**
 * Select the drawn node set: a GLOBAL screen-space-error priority queue under
 * a hard budget, with a 2:1 touching-neighbour clamp (`4.5-A1`).
 *
 * **This amends one bullet of recorded deviation D17** — "selection is
 * breadth-first by level, nearest-first inside a level" — and only that
 * bullet. D17's level-9 roots, its `subIndex` page-parity lane and its
 * budget-remainder counting stand.
 *
 * D17's rationale for breadth-first was real: a depth-first descent spends the
 * whole budget on the first quadrant it enters, so the ground behind the
 * aircraft disappears rather than coarsening. But a per-level split loop
 * *converges*: with a 240-node budget it terminates with the whole world at
 * L5-L7 — kilometre-scale height texels at 150 m AGL, which is what the
 * "splotches of solid colour" defect actually was. The unconstrained criterion
 * wants >= 2,300 nodes, so raising the budget cannot fix it. A global error
 * queue satisfies D17's rationale a different way: the roots are emitted
 * first and are never dropped, so horizon coverage is complete by
 * construction, and the budget is then spent where the MEASURED error is
 * largest rather than spread evenly across a level nobody is looking at.
 *
 * **The neighbour-level clamp is mandatory, not complementary.** The analytic
 * crack closure (`terrainNodeMorphK`, the morph to the parent lattice)
 * guarantees seam identity across ONE level of difference; a pure max-error
 * queue makes >1-level adjacencies common, and with skirts deleted a two-level
 * seam is a hole in the ground. So a node may only be split once every
 * touching same-level neighbour EXISTS in the tree. Including diagonals is
 * load-bearing now that corners carry synchronized morph values: edge-only
 * balance admits a two-level corner, but a node has only its immediate parent
 * page and cannot meet a grandparent surface there. Because a split is only
 * ever applied with its whole forced-split closure, the invariant holds by
 * construction rather than by a repair pass (assertion 108).
 *
 * The two rules the queue inherits unchanged: nothing below
 * `finestResidentLevel` is ever selected, and an UNMEASURED page is never
 * split — including inside a forced closure, where the alternative would be
 * spending the budget on a guess to fix a seam.
 */
export function selectTerrainNodes(
  input: TerrainNodeSelectionInput,
  diagnostics?: TerrainNodeSelectionDiagnostics,
): TerrainNode[] {
  const finest = Math.max(0, input.finestResidentLevel);
  const coarsest = Math.max(finest, input.coarsestLevel);
  const budget = Math.max(1, Math.floor(input.nodeBudget));
  const rootSpan = terrainNodeSpanMeters(coarsest);
  const reach = Math.ceil(input.farPlaneMeters / rootSpan) + 1;
  const rootX = Math.floor(input.cameraX / rootSpan);
  const rootZ = Math.floor(input.cameraZ / rootSpan);

  // One candidate object per quadtree cell, so identity comparisons are valid
  // and `deviationFor` is asked at most once per cell per frame.
  const candidates = new Map<string, Candidate | null>();
  const candidateAt = (level: number, nodeX: number, nodeZ: number): Candidate | null => {
    const key = `${level}:${nodeX}:${nodeZ}`;
    const cached = candidates.get(key);
    if (cached !== undefined) return cached;
    const made = makeCandidate(input, level, nodeX, nodeZ, key);
    candidates.set(key, made);
    return made;
  };

  /** The current leaves — exactly the node set that will be drawn. */
  const leaves = new Map<string, Candidate>();
  /** Nodes that have been replaced by their four children. */
  const split = new Set<string>();
  const heap = createErrorHeap();

  for (let dz = -reach; dz <= reach; dz += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const root = candidateAt(coarsest, rootX + dx, rootZ + dz);
      if (!root) continue;
      leaves.set(root.key, root);
      heap.push(root);
    }
  }

  /**
   * The ancestors that must be split for cell `(level, nodeX, nodeZ)` to exist
   * as a node of the tree, coarsest first. `null` means the cell's ground is
   * not drawn at all (outside the root ring, or beyond the far plane), which
   * is no adjacency and therefore no constraint.
   */
  const chainToExist = (
    level: number,
    nodeX: number,
    nodeZ: number,
    planned: ReadonlySet<string>,
  ): Candidate[] | null => {
    const chain: Candidate[] = [];
    for (let ancestorLevel = coarsest; ancestorLevel > level; ancestorLevel -= 1) {
      const step = 2 ** (ancestorLevel - level);
      const ancestorX = Math.floor(nodeX / step);
      const ancestorZ = Math.floor(nodeZ / step);
      const key = `${ancestorLevel}:${ancestorX}:${ancestorZ}`;
      // Already split (or about to be): its children exist, so descend.
      if (split.has(key) || planned.has(key)) continue;
      // The first ancestor that is not split is the leaf covering this ground.
      // Everything from it down to the target's parent has to be split. If it
      // is not a leaf either, nothing covers the ground here.
      if (chain.length === 0 && !leaves.has(key)) return null;
      const ancestor = candidateAt(ancestorLevel, ancestorX, ancestorZ);
      if (!ancestor) return null;
      chain.push(ancestor);
    }
    return chain;
  };

  /**
   * Every node that must be split for `target` to split legally, or null when
   * the closure is impossible (it reaches `finestResidentLevel`, an unmeasured
   * page, or more splits than `maximumSplits` can pay for).
   */
  const planSplit = (target: Candidate, maximumSplits: number): Candidate[] | null => {
    const planned = new Set<string>();
    const ordered: Candidate[] = [];
    const work: Candidate[] = [target];
    while (work.length > 0) {
      const node = work.pop()!;
      if (split.has(node.key) || planned.has(node.key)) continue;
      if (node.level <= finest) return null;
      if (!node.measured) return null;
      planned.add(node.key);
      ordered.push(node);
      if (ordered.length > maximumSplits) return null;
      for (const [dx, dz] of TOUCHING_NEIGHBOUR_OFFSETS) {
        const chain = chainToExist(node.level, node.nodeX + dx, node.nodeZ + dz, planned);
        if (chain === null) continue;
        for (const ancestor of chain) work.push(ancestor);
      }
    }
    // COARSEST FIRST. Every member of a plan is a current leaf *given* the
    // 2:1 invariant — a forced chain is one node deep, because a neighbour two
    // levels coarser cannot exist while the invariant holds — so today the
    // order does not matter. It is sorted anyway, and `applySplit` refuses to
    // re-leaf an already-split child, because the failure if that argument
    // ever stops holding is a node left in BOTH `split` and `leaves`: drawn on
    // top of its own children, which is z-fighting rather than an exception.
    // The property is pinned by "emits a partition: no selected node contains
    // another".
    ordered.sort((first, second) => second.level - first.level);
    return ordered;
  };

  const applySplit = (node: Candidate): void => {
    leaves.delete(node.key);
    split.add(node.key);
    const childLevel = node.level - 1;
    for (let dz = 0; dz < 2; dz += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const child = candidateAt(childLevel, node.nodeX * 2 + dx, node.nodeZ * 2 + dz);
        // A child that is itself already split is not a leaf; re-adding it
        // would draw it over its own children. Unreachable while a plan's
        // members are all leaves; see planSplit's ordering note.
        if (!child || split.has(child.key)) continue;
        leaves.set(child.key, child);
        heap.push(child);
      }
    }
  };

  for (;;) {
    // A split replaces one node with four, so each one in the closure costs
    // three. The budget is checked against the WHOLE closure, so the clamp can
    // never be half-applied.
    const affordableSplits = Math.floor((budget - leaves.size) / 3);
    if (affordableSplits < 1) break;
    const top = heap.pop();
    if (top === null) break;
    // Lazily deleted: this node was split (or never emitted) since it was
    // pushed.
    if (leaves.get(top.key) !== top) continue;
    // The heap is ordered by error, so once the worst node is legal, every
    // node is.
    if (top.errorPixels <= input.pixelThreshold) break;
    const plan = planSplit(top, affordableSplits);
    if (plan === null) continue;
    for (const node of plan) applySplit(node);
  }

  // Nearest first: `writeTerrainNodeBuffers` truncates at the buffer capacity,
  // and the near field is what a truncation must keep.
  const emitted = [...leaves.values()].sort(
    (first, second) => first.distanceMeters - second.distanceMeters,
  );

  const morphFor = (candidate: Candidate): number => {
    if (candidate.level >= input.coarsestLevel) return 0;
    const splitDistance = candidate.deviationMeters > 0
      ? (candidate.deviationMeters * input.pixelsPerMeterAtUnitDistance) / input.pixelThreshold
      : 0;
    return terrainNodeMorphK(candidate.distanceMeters, splitDistance);
  };
  for (let index = 0; index < emitted.length; index += 1) {
    const candidate = emitted[index]!;
    candidate.morphK = morphFor(candidate);
    candidate.emittedIndex = index;
  }

  /**
   * Numeric leaf lookup for the boundary pass.
   *
   * The previous implementation rebuilt string-keyed vertex/participant maps,
   * allocated arrays through spreads, and searched every LOD level for every
   * corner and half-edge sample. At tier 1 that was ~60,000 string constructions
   * per frame and 2.8 ms in the pure selector alone. The root ring gives every
   * level a small collision-free local integer lattice, and the already-proved
   * 2:1 touching-neighbour invariant bounds a point query to L-1/L/L+1.
   */
  interface NumericLeafLevel {
    readonly minimumX: number;
    readonly minimumZ: number;
    readonly width: number;
    readonly spanMeters: number;
    readonly leaves: Map<number, Candidate>;
  }
  const numericLeaves: Array<NumericLeafLevel | undefined> = new Array(coarsest + 1);
  for (let level = finest; level <= coarsest; level += 1) {
    const factor = 2 ** (coarsest - level);
    numericLeaves[level] = {
      minimumX: (rootX - reach) * factor,
      minimumZ: (rootZ - reach) * factor,
      width: (reach * 2 + 1) * factor,
      spanMeters: terrainNodeSpanMeters(level),
      leaves: new Map<number, Candidate>(),
    };
  }
  for (const candidate of emitted) {
    const level = numericLeaves[candidate.level]!;
    const localX = candidate.nodeX - level.minimumX;
    const localZ = candidate.nodeZ - level.minimumZ;
    level.leaves.set(localZ * level.width + localX, candidate);
  }

  let cornerLeafQueries = 0;
  let cornerLeafLevelProbes = 0;
  const leafAtBalancedWorld = (
    sampleX: number,
    sampleZ: number,
    ownerLevel: number,
  ): Candidate | null => {
    cornerLeafQueries += 1;
    const firstLevel = Math.max(finest, ownerLevel - 1);
    const lastLevel = Math.min(coarsest, ownerLevel + 1);
    for (let levelIndex = firstLevel; levelIndex <= lastLevel; levelIndex += 1) {
      cornerLeafLevelProbes += 1;
      const level = numericLeaves[levelIndex]!;
      const localX = Math.floor(sampleX / level.spanMeters) - level.minimumX;
      const localZ = Math.floor(sampleZ / level.spanMeters) - level.minimumZ;
      if (localX < 0 || localZ < 0 || localX >= level.width || localZ >= level.width) continue;
      const leaf = level.leaves.get(localZ * level.width + localX);
      if (leaf) return leaf;
    }
    return null;
  };

  const cornerMorphs = new Float64Array(emitted.length * 4);
  const forcedCorners = new Int8Array(emitted.length * 4);
  forcedCorners.fill(-1);
  const resolveCorner = (
    candidate: Candidate,
    x: number,
    z: number,
    ownerQuadrant: number,
  ): number => {
    let minimumLevel = candidate.level;
    let maximumLevel = candidate.level;
    let maximumMorph = candidate.morphK;
    // The owner is known and seeded above. Only the other three quadrants need
    // a lookup; a coarse participant returned twice is harmless for min/max.
    for (let quadrant = 0; quadrant < 4; quadrant += 1) {
      if (quadrant === ownerQuadrant) continue;
      const participant = leafAtBalancedWorld(
        x + ((quadrant & 1) === 0 ? -0.25 : 0.25),
        z + ((quadrant & 2) === 0 ? -0.25 : 0.25),
        candidate.level,
      );
      if (!participant || participant === candidate) continue;
      minimumLevel = Math.min(minimumLevel, participant.level);
      maximumLevel = Math.max(maximumLevel, participant.level);
      maximumMorph = Math.max(maximumMorph, participant.morphK);
    }
    if (maximumLevel - minimumLevel > 1) {
      throw new Error(
        `Terrain touching-neighbour balance failed at (${x}, ${z}): `
        + `levels ${minimumLevel}..${maximumLevel}`,
      );
    }
    if (maximumLevel === minimumLevel) return quantizeTerrainCornerMorphK(maximumMorph);
    // Target the exact coarser surface at a mixed corner. The fine node's
    // parent and the coarse node's own fine page are the same level.
    return candidate.level < maximumLevel ? 1 : 0;
  };

  for (const candidate of emitted) {
    const base = candidate.emittedIndex * 4;
    const x0 = candidate.originX;
    const z0 = candidate.originZ;
    const x1 = x0 + candidate.spanMeters;
    const z1 = z0 + candidate.spanMeters;
    // Quadrants are (-x,-z), (+x,-z), (-x,+z), (+x,+z). A node owns the
    // quadrant pointing into its interior at each respective corner.
    cornerMorphs[base] = resolveCorner(candidate, x0, z0, 3);
    cornerMorphs[base + 1] = resolveCorner(candidate, x1, z0, 2);
    cornerMorphs[base + 2] = resolveCorner(candidate, x0, z1, 1);
    cornerMorphs[base + 3] = resolveCorner(candidate, x1, z1, 0);
  }

  /**
   * A far-plane cut may retain only one child along half of a coarse edge.
   * Sample both half interiors and force both coarse endpoints when either is
   * mixed; scalar state preserves the former contradiction checks without a
   * per-side Map/array allocation.
   */
  const forceSide = (
    candidate: Candidate,
    firstCorner: number,
    secondCorner: number,
    firstX: number,
    firstZ: number,
    secondX: number,
    secondZ: number,
  ): void => {
    const first = leafAtBalancedWorld(firstX, firstZ, candidate.level);
    const second = leafAtBalancedWorld(secondX, secondZ, candidate.level);
    let minimumLevel = candidate.level;
    let maximumLevel = candidate.level;
    let hasSameLevel = false;
    let hasMixedLevel = false;
    if (first && first !== candidate) {
      minimumLevel = Math.min(minimumLevel, first.level);
      maximumLevel = Math.max(maximumLevel, first.level);
      if (first.level === candidate.level) hasSameLevel = true;
      else hasMixedLevel = true;
    }
    if (second && second !== candidate && second !== first) {
      minimumLevel = Math.min(minimumLevel, second.level);
      maximumLevel = Math.max(maximumLevel, second.level);
      if (second.level === candidate.level) hasSameLevel = true;
      else hasMixedLevel = true;
    }
    if (!hasMixedLevel) return;
    if (hasSameLevel) {
      throw new Error(`Terrain side mixes same-level and split neighbours for ${candidate.key}`);
    }
    if (maximumLevel - minimumLevel > 1) {
      throw new Error(`Terrain side balance failed for ${candidate.key}`);
    }
    const target = candidate.level === minimumLevel ? 1 : 0;
    const base = candidate.emittedIndex * 4;
    const firstOffset = base + firstCorner;
    const secondOffset = base + secondCorner;
    const previousFirst = forcedCorners[firstOffset]!;
    const previousSecond = forcedCorners[secondOffset]!;
    if ((previousFirst >= 0 && previousFirst !== target)
      || (previousSecond >= 0 && previousSecond !== target)) {
      throw new Error(`Terrain corner has contradictory edge targets for ${candidate.key}`);
    }
    forcedCorners[firstOffset] = target;
    forcedCorners[secondOffset] = target;
    cornerMorphs[firstOffset] = target;
    cornerMorphs[secondOffset] = target;
  };
  for (const candidate of emitted) {
    const x0 = candidate.originX;
    const z0 = candidate.originZ;
    const x1 = x0 + candidate.spanMeters;
    const z1 = z0 + candidate.spanMeters;
    const quarter = candidate.spanMeters * 0.25;
    const threeQuarter = candidate.spanMeters * 0.75;
    forceSide(
      candidate, 0, 2,
      x0 - 0.25, z0 + quarter,
      x0 - 0.25, z0 + threeQuarter,
    );
    forceSide(
      candidate, 1, 3,
      x1 + 0.25, z0 + quarter,
      x1 + 0.25, z0 + threeQuarter,
    );
    forceSide(
      candidate, 0, 1,
      x0 + quarter, z0 - 0.25,
      x0 + threeQuarter, z0 - 0.25,
    );
    forceSide(
      candidate, 2, 3,
      x0 + quarter, z1 + 0.25,
      x0 + threeQuarter, z1 + 0.25,
    );
  }

  if (diagnostics) {
    diagnostics.cornerLeafQueries = cornerLeafQueries;
    diagnostics.cornerLeafLevelProbes = cornerLeafLevelProbes;
  }

  return emitted.map((candidate) => {
    const cornerBase = candidate.emittedIndex * 4;
    return Object.freeze({
      address: candidate.address,
      subNodeX: candidate.subNodeX,
      subNodeZ: candidate.subNodeZ,
      originX: candidate.originX,
      originZ: candidate.originZ,
      spanMeters: candidate.spanMeters,
      level: candidate.level,
      morphK: candidate.morphK,
      cornerMorphK: Object.freeze([
        cornerMorphs[cornerBase]!,
        cornerMorphs[cornerBase + 1]!,
        cornerMorphs[cornerBase + 2]!,
        cornerMorphs[cornerBase + 3]!,
      ]) as TerrainNodeCornerMorphs,
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
 * `terrainNodeA = (slotIndex, subIndex, level, provisionalAxis)`, where `subIndex`
 * is `subNodeX + subNodeZ*8 + parityX*64 + parityZ*128`
 * `terrainNodeB = (morphK, parentSlotIndex, channelLane, packedCornerMorphs)`, where
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
 * `subNodeX` and `subNodeZ` share a lane so the provisional axis can have one.
 * They are
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
 * The provisional-axis lane's "derive it per vertex" sentinel (`4.5-A3`).
 *
 * `4-5` deletes the CPU tile meshes and with them the per-vertex splat lanes
 * that are the only material source wherever a page holds no channel slot.
 * The carry-forward it shipped packed one (primary, secondary, weight) triple
 * per NODE, so the fallback was a single material across the whole node — up
 * to `512·2^L` m of solid colour. `4.5-A3` moves the altitude walk into the
 * vertex shader, where it runs against the height that shader has just
 * displaced to, and this lane carries only the CPU's guard: a non-negative
 * value is an axis the shader must use verbatim (there are no height texels to
 * walk), and this sentinel means "walk it yourself".
 */
export const TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT = -1;

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
  /**
   * Full-selection residency resolution shared by beauty and every shadow
   * subset. Omit only in isolated callers; the writer then resolves its own
   * node list defensively.
   */
  readonly cornerMorphsFor?: (node: TerrainNode) => TerrainNodeCornerMorphs;
  /**
   * `4.5-A3`: an axis the shader must shade with verbatim, or
   * `TERRAIN_PROVISIONAL_AXIS_FROM_HEIGHT` to have it walked per vertex.
   */
  readonly provisionalAxisFor: (node: TerrainNode) => number;
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
  const writtenNodes = input.nodes.slice(0, count);
  const residentCornerMorphs = input.cornerMorphsFor
    ? writtenNodes.map((node) => input.cornerMorphsFor!(node))
    : resolveTerrainResidentCornerMorphs(writtenNodes, input.slotFor);
  writtenNodes.forEach((node, index) => {
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
    const parentAddress = parentWorldPageAddress(node.address) ?? node.address;
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
    laneA[laneBase + 3] = input.provisionalAxisFor(node);
    // A node whose parent is not resident cannot morph into it: the parent's
    // heights are not there to sample, and morphing toward an unwritten slot
    // is a hole in the ground rather than a smooth transition.
    laneB[laneBase] = parentSlot >= 0 ? node.morphK : 0;
    laneB[laneBase + 1] = parentSlot;
    const channelSlot = input.channelSlotFor(node.address);
    // -1 when the page holds no channel slot: the fragment falls back to the
    // provisional per-node splat, which is the co-residency rule `4-2` states.
    laneB[laneBase + 2] = channelSlot >= 0 ? channelSlot * 32 + node.level : -1;
    // Four six-bit corner factors occupy one exact 24-bit integer. Packing as
    // arithmetic f32 (not a NaN bitcast) survives vertex fetch and every
    // adapter's canonicalization rules unchanged.
    laneB[laneBase + 3] = packTerrainCornerMorphs(residentCornerMorphs[index]!);
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
