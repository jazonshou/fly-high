/**
 * The car's local copy of the ground: the physics terrain authority's 2 m
 * lattice nodes around the car, cached, and the same uniform Catmull-Rom
 * the authority evaluates over them (src/workers/terrainAuthority.ts).
 *
 * The authority's L0 pages are 256 heights over 512 m, so their nodes sit
 * at integer multiples of 2 m and a page height is the bicubic Catmull-Rom
 * through the 4 x 4 nodes around the point. Reading the authority AT a node
 * returns the node itself (the spline interpolates), so a cache of node
 * heights reproduces the drawn ground exactly wherever a page is resident:
 * the car rolls on the terrain the player sees. Where only the macro grid or
 * the analytic kernel answers, the same spline through their node values is
 * within millimetres of them.
 *
 * Why a cache: one authority height costs about 13 us in Node (it evaluates
 * the analytic kernel on every call), and the car's tyres and hull ask for
 * about seventy heights with gradients every 120 Hz step. Nodes are fetched
 * once, as the car reaches them, and kept until their slot is reused or they
 * are older than `NODE_LIFETIME_SECONDS`, so a page that lands under a node
 * read from the macro grid replaces it within a second.
 *
 * Direct-mapped: node (i, j) lives in slot (i mod 32, j mod 32), so the
 * cache covers a 64 m square around the car with no allocation and no
 * search. Deterministic: the same nodes are read in the same order for the
 * same drive.
 *
 * Within a step each cell's 4 x 4 patch is kept for the next lookup in that
 * cell, sixteen cells direct-mapped by (i mod 4, j mod 4), an 8 m square
 * the car's tyres and hull fall inside: a tyre's eight samples share one or
 * two cells, and the step's clock does not move between lookups, so a patch
 * read again would be the same 16 heights. A new step (`setTime`), `clear`
 * or a new sampler drops them all.
 *
 * The query point travels in the `GroundPoint` it is answered in, and the
 * spline runs over a typed-array patch, so a lookup passes no number
 * through a call: V8 boxes a double argument or return value of a call it
 * does not inline, which would be garbage on every lookup.
 */

/** The authority's lattice spacing (`WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE`). */
export const TERRAIN_LATTICE_METERS = 2;

const SLOT_BITS = 5;
const SLOT_SIDE = 1 << SLOT_BITS;
const SLOT_MASK = SLOT_SIDE - 1;
const SLOT_COUNT = SLOT_SIDE * SLOT_SIDE;
/** The step's kept patches: cell (i, j) in entry (i mod 4, j mod 4). */
const PATCH_MASK = 3;
const PATCH_ENTRIES = 16;

/** Seconds a cached node is trusted before it is read again. */
export const NODE_LIFETIME_SECONDS = 1;

/** A ground query: the point (x, z) asked about, and its height with the gradient d height / dx and d height / dz. */
export interface GroundPoint {
  x: number;
  z: number;
  height: number;
  dhdx: number;
  dhdz: number;
}

export function createGroundPoint(): GroundPoint {
  return { x: 0, z: 0, height: 0, dhdx: 0, dhdz: 0 };
}

/** Anything the car can read the ground from: the lattice cache, or a test's exact function. */
export interface GroundField {
  /** Write the height and gradient at (`at.x`, `at.z`) into `at`. */
  evaluate(at: GroundPoint): void;
}

export class TerrainLatticeCache implements GroundField {
  private readonly tagI = new Int32Array(SLOT_COUNT);
  private readonly tagJ = new Int32Array(SLOT_COUNT);
  private readonly valid = new Uint8Array(SLOT_COUNT);
  private readonly heights = new Float64Array(SLOT_COUNT);
  private readonly stamps = new Float64Array(SLOT_COUNT);
  private sampler: (x: number, z: number) => number;
  private time = 0;
  /** Each kept cell's 4 x 4 nodes, rows along x, its cell, and the step generation it was read in. */
  private readonly patches = new Float64Array(PATCH_ENTRIES * 16);
  private readonly patchI = new Int32Array(PATCH_ENTRIES);
  private readonly patchJ = new Int32Array(PATCH_ENTRIES);
  private readonly patchGeneration = new Int32Array(PATCH_ENTRIES).fill(-1);
  private generation = 0;
  /** Authority reads so far, for budget tests and probes. */
  reads = 0;

  constructor(sampler: (x: number, z: number) => number) {
    this.sampler = sampler;
  }

  /** A new authority (a new world, or the worker's first environment): forget every node. */
  setSampler(sampler: (x: number, z: number) => number): void {
    if (sampler === this.sampler) return;
    this.sampler = sampler;
    this.clear();
  }

  clear(): void {
    this.valid.fill(0);
    this.dropPatches();
  }

  /** The simulation clock, for the nodes' lifetime. */
  setTime(time: number): void {
    this.time = time;
    this.dropPatches();
  }

  private dropPatches(): void {
    this.generation = (this.generation + 1) & 0x3fffffff;
  }

  /** The authority's height at lattice node (i, j), into the patches at `index`. */
  private loadNode(i: number, j: number, index: number): void {
    const slot = ((j & SLOT_MASK) << SLOT_BITS) | (i & SLOT_MASK);
    if (
      this.valid[slot] !== 1
      || this.tagI[slot] !== i
      || this.tagJ[slot] !== j
      || this.time - this.stamps[slot]! >= NODE_LIFETIME_SECONDS
    ) {
      const height = this.sampler(i * TERRAIN_LATTICE_METERS, j * TERRAIN_LATTICE_METERS);
      this.reads += 1;
      this.valid[slot] = 1;
      this.tagI[slot] = i;
      this.tagJ[slot] = j;
      this.heights[slot] = Number.isFinite(height) ? height : 0;
      this.stamps[slot] = this.time;
    }
    this.patches[index] = this.heights[slot]!;
  }

  /**
   * Height and gradient at (`at.x`, `at.z`): the authority's bicubic
   * Catmull-Rom through the 4 x 4 nodes around the point, in the
   * authority's own order (rows along x, then the column of rows along z)
   * and its Horner form term for term (`catmullRom` below).
   */
  evaluate(at: GroundPoint): void {
    const lx = at.x / TERRAIN_LATTICE_METERS;
    const lz = at.z / TERRAIN_LATTICE_METERS;
    const i1 = Math.floor(lx);
    const j1 = Math.floor(lz);
    const t = lx - i1;
    const u = lz - j1;
    const patch = this.patches;
    const entry = ((j1 & PATCH_MASK) << 2) | (i1 & PATCH_MASK);
    const o = entry * 16;
    if (this.patchGeneration[entry] !== this.generation || this.patchI[entry] !== i1 || this.patchJ[entry] !== j1) {
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) this.loadNode(i1 - 1 + column, j1 - 1 + row, o + row * 4 + column);
      }
      this.patchI[entry] = i1;
      this.patchJ[entry] = j1;
      this.patchGeneration[entry] = this.generation;
    }
    // Each row's value and x slope at t, then the column of rows at u.
    let a0 = patch[o]!;
    let a1 = patch[o + 1]!;
    let a2 = patch[o + 2]!;
    let a3 = patch[o + 3]!;
    const r0 = a1 + 0.5 * t * (a2 - a0 + t * (2 * a0 - 5 * a1 + 4 * a2 - a3 + t * (3 * (a1 - a2) + a3 - a0)));
    const d0 = 0.5 * (a2 - a0 + t * (2 * (2 * a0 - 5 * a1 + 4 * a2 - a3) + t * 3 * (3 * (a1 - a2) + a3 - a0)));
    a0 = patch[o + 4]!;
    a1 = patch[o + 5]!;
    a2 = patch[o + 6]!;
    a3 = patch[o + 7]!;
    const r1 = a1 + 0.5 * t * (a2 - a0 + t * (2 * a0 - 5 * a1 + 4 * a2 - a3 + t * (3 * (a1 - a2) + a3 - a0)));
    const d1 = 0.5 * (a2 - a0 + t * (2 * (2 * a0 - 5 * a1 + 4 * a2 - a3) + t * 3 * (3 * (a1 - a2) + a3 - a0)));
    a0 = patch[o + 8]!;
    a1 = patch[o + 9]!;
    a2 = patch[o + 10]!;
    a3 = patch[o + 11]!;
    const r2 = a1 + 0.5 * t * (a2 - a0 + t * (2 * a0 - 5 * a1 + 4 * a2 - a3 + t * (3 * (a1 - a2) + a3 - a0)));
    const d2 = 0.5 * (a2 - a0 + t * (2 * (2 * a0 - 5 * a1 + 4 * a2 - a3) + t * 3 * (3 * (a1 - a2) + a3 - a0)));
    a0 = patch[o + 12]!;
    a1 = patch[o + 13]!;
    a2 = patch[o + 14]!;
    a3 = patch[o + 15]!;
    const r3 = a1 + 0.5 * t * (a2 - a0 + t * (2 * a0 - 5 * a1 + 4 * a2 - a3 + t * (3 * (a1 - a2) + a3 - a0)));
    const d3 = 0.5 * (a2 - a0 + t * (2 * (2 * a0 - 5 * a1 + 4 * a2 - a3) + t * 3 * (3 * (a1 - a2) + a3 - a0)));
    at.height = r1 + 0.5 * u * (r2 - r0 + u * (2 * r0 - 5 * r1 + 4 * r2 - r3 + u * (3 * (r1 - r2) + r3 - r0)));
    at.dhdx = (d1 + 0.5 * u * (d2 - d0 + u * (2 * d0 - 5 * d1 + 4 * d2 - d3 + u * (3 * (d1 - d2) + d3 - d0))))
      / TERRAIN_LATTICE_METERS;
    at.dhdz = 0.5 * (r2 - r0 + u * (2 * (2 * r0 - 5 * r1 + 4 * r2 - r3) + u * 3 * (3 * (r1 - r2) + r3 - r0)))
      / TERRAIN_LATTICE_METERS;
  }
}

/** The authority's Horner form of the uniform Catmull-Rom spline, term for term. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, amount: number): number {
  return p1 + 0.5 * amount * (
    p2 - p0
    + amount * (
      2 * p0 - 5 * p1 + 4 * p2 - p3
      + amount * (3 * (p1 - p2) + p3 - p0)
    )
  );
}

/** d/d(amount) of `catmullRom`. */
export function catmullRomSlope(p0: number, p1: number, p2: number, p3: number, amount: number): number {
  return 0.5 * (
    p2 - p0
    + amount * (
      2 * (2 * p0 - 5 * p1 + 4 * p2 - p3)
      + amount * 3 * (3 * (p1 - p2) + p3 - p0)
    )
  );
}
