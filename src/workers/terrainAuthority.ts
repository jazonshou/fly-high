import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_HEIGHT_CORE,
} from "@/src/render/webgpu/world/pageGeometry";
import type {
  TerrainHeightAuthorityCounters,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";

/**
 * Worker-side terrain authority (`5-2`).
 *
 * The renderer publishes final L0 cores and the once-per-world macro grid.
 * Queries take the most precise available answer in a fixed order:
 *
 *   final L0 page ring -> macro grid -> caller-owned analytic fallback
 *
 * The analytic fallback stays in `src/sim/terrainGrid.ts`, the sole module
 * allowed to call the collision kernel. This class returns `null` when both
 * resident authorities miss and exposes `recordAnalyticSample()` for that
 * final step.
 *
 * The hot lookup path allocates nothing. In particular, page addressing uses
 * a small fixed array instead of string map keys, and Catmull-Rom gathers
 * across page boundaries rather than clamping at an edge (which would create
 * a collision-normal kink exactly where two rendered pages meet).
 */

/** A 5x5 working set plus one-page turn/readback margin. */
export const TERRAIN_READBACK_RING_CAPACITY = 36;

/** Protocol-facing compatibility name for the canonical Phase 5 contract. */
export type TerrainAuthorityCounters = TerrainHeightAuthorityCounters;

/**
 * CPU-resident macro fallback transferred once after world evolution.
 * `originX`/`originZ` locate sample (0, 0), not the outer texel edge.
 */
export interface TerrainMacroGrid {
  readonly originX: number;
  readonly originZ: number;
  readonly texelSizeMeters: number;
  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
  /** Canonical smooth rim width; omitted/zero preserves generic test grids. */
  readonly analyticBlendTexels?: number;
}

/** One final core copied from the render atlas for worker publication. */
export interface TerrainPagePublication {
  readonly level: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly heights: Float32Array;
}

interface ReadbackPage {
  tileX: number;
  tileZ: number;
  heights: Float32Array;
  sequence: number;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  amount: number,
): number {
  // Horner form of the uniform Catmull-Rom spline (tension 0.5). Besides
  // doing less work than the expanded polynomial, the fixed arithmetic order
  // keeps repeated worker queries deterministic on one JS engine.
  return p1 + 0.5 * amount * (
    p2 - p0
    + amount * (
      2 * p0 - 5 * p1 + 4 * p2 - p3
      + amount * (3 * (p1 - p2) + p3 - p0)
    )
  );
}

function assertMacroGrid(grid: TerrainMacroGrid): void {
  requireFinite(grid.originX, "Macro originX");
  requireFinite(grid.originZ, "Macro originZ");
  requireFinite(grid.texelSizeMeters, "Macro texel size");
  if (grid.texelSizeMeters <= 0) {
    throw new RangeError("Macro texel size must be greater than zero");
  }
  if (!Number.isSafeInteger(grid.width) || grid.width < 2) {
    throw new RangeError("Macro width must be an integer of at least two texels");
  }
  if (!Number.isSafeInteger(grid.height) || grid.height < 2) {
    throw new RangeError("Macro height must be an integer of at least two texels");
  }
  if (grid.heights.length !== grid.width * grid.height) {
    throw new RangeError(
      `Macro grid requires ${grid.width * grid.height} heights, got ${grid.heights.length}`,
    );
  }
  if (
    grid.analyticBlendTexels !== undefined
    && (!Number.isSafeInteger(grid.analyticBlendTexels)
      || grid.analyticBlendTexels < 0
      || grid.analyticBlendTexels * 2 >= Math.min(grid.width, grid.height))
  ) {
    throw new RangeError("Macro analytic blend width is invalid");
  }
}

/** Pure worker-safe authority. It imports no Babylon or simulation state. */
export class TerrainAuthority {
  private readonly pages: Array<ReadbackPage | null> = Array.from(
    { length: TERRAIN_READBACK_RING_CAPACITY },
    () => null,
  );
  private macro: TerrainMacroGrid | null = null;
  private sequence = 0;
  private pageCount = 0;
  private readbackSamples = 0;
  private macroSamples = 0;
  private analyticSamples = 0;

  get publishedPageCount(): number {
    return this.pageCount;
  }

  get hasMacroGrid(): boolean {
    return this.macro !== null;
  }

  /** Snapshot for structured clone on the Worker's 60 Hz state message. */
  countersSnapshot(): TerrainAuthorityCounters {
    return {
      readbackServed: this.readbackSamples,
      macroServed: this.macroSamples,
      analyticServed: this.analyticSamples,
    };
  }

  /**
   * Takes ownership of a standalone transferred core buffer.
   * Coarser pages are ignored: admitting one would create a second answer to
   * a point already covered by the macro authority.
   */
  publishPage(
    level: number,
    tileX: number,
    tileZ: number,
    heights: Float32Array,
  ): boolean {
    requireSafeInteger(level, "Terrain page level");
    requireSafeInteger(tileX, "Terrain page x");
    requireSafeInteger(tileZ, "Terrain page z");
    if (level !== 0) return false;
    const expected = WORLD_PAGE_HEIGHT_CORE * WORLD_PAGE_HEIGHT_CORE;
    if (heights.length !== expected) {
      throw new RangeError(`L0 collision page requires ${expected} heights, got ${heights.length}`);
    }

    this.sequence += 1;
    let freeIndex = -1;
    let oldestIndex = 0;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.pages.length; index += 1) {
      const page = this.pages[index];
      if (page === null || page === undefined) {
        if (freeIndex < 0) freeIndex = index;
        continue;
      }
      if (page.tileX === tileX && page.tileZ === tileZ) {
        page.heights = heights;
        page.sequence = this.sequence;
        return true;
      }
      if (page.sequence < oldestSequence) {
        oldestSequence = page.sequence;
        oldestIndex = index;
      }
    }

    const index = freeIndex >= 0 ? freeIndex : oldestIndex;
    if (this.pages[index] === null || this.pages[index] === undefined) this.pageCount += 1;
    this.pages[index] = { tileX, tileZ, heights, sequence: this.sequence };
    return true;
  }

  publish(publication: TerrainPagePublication): boolean {
    return this.publishPage(
      publication.level,
      publication.tileX,
      publication.tileZ,
      publication.heights,
    );
  }

  /** Takes ownership of the transferred grid view. */
  publishMacro(grid: TerrainMacroGrid): void {
    assertMacroGrid(grid);
    this.macro = grid;
    // Worker initialization legitimately samples the analytic kernel while
    // building its spawn before the asynchronous macro transfer can arrive.
    // Start the observable authority epoch here so those pre-load samples do
    // not permanently poison assertion 93's below-500 m fallback counter.
    this.resetCounters();
  }

  /** Remove all authority data and counters when a worker is re-initialized. */
  clear(): void {
    for (let index = 0; index < this.pages.length; index += 1) this.pages[index] = null;
    this.macro = null;
    this.sequence = 0;
    this.pageCount = 0;
    this.resetCounters();
  }

  resetCounters(): void {
    this.readbackSamples = 0;
    this.macroSamples = 0;
    this.analyticSamples = 0;
  }

  /** Called exactly once when `terrainGrid.ts` serves the final fallback. */
  recordAnalyticSample(): void {
    this.analyticSamples += 1;
  }

  /** Height from readback or macro, or null for the analytic last resort. */
  sampleHeight(x: number, z: number, analyticHeight?: number): number | null {
    requireFinite(x, "Terrain sample x");
    requireFinite(z, "Terrain sample z");
    const readback = this.sampleReadback(x, z);
    if (readback !== null) {
      this.readbackSamples += 1;
      return readback;
    }
    const macro = this.sampleMacro(x, z, analyticHeight);
    if (macro !== null) {
      this.macroSamples += 1;
      return macro;
    }
    return null;
  }

  private sampleReadback(x: number, z: number): number | null {
    const spacing = WORLD_PAGE_BASE_EXTENT_METERS / WORLD_PAGE_HEIGHT_CORE;
    const latticeX = x / spacing;
    const latticeZ = z / spacing;
    const column1 = Math.floor(latticeX);
    const row1 = Math.floor(latticeZ);
    const tx = latticeX - column1;
    const tz = latticeZ - row1;

    const r0c0 = this.readLattice(column1 - 1, row1 - 1);
    const r0c1 = this.readLattice(column1, row1 - 1);
    const r0c2 = this.readLattice(column1 + 1, row1 - 1);
    const r0c3 = this.readLattice(column1 + 2, row1 - 1);
    if (r0c0 === null || r0c1 === null || r0c2 === null || r0c3 === null) return null;
    const r1c0 = this.readLattice(column1 - 1, row1);
    const r1c1 = this.readLattice(column1, row1);
    const r1c2 = this.readLattice(column1 + 1, row1);
    const r1c3 = this.readLattice(column1 + 2, row1);
    if (r1c0 === null || r1c1 === null || r1c2 === null || r1c3 === null) return null;
    const r2c0 = this.readLattice(column1 - 1, row1 + 1);
    const r2c1 = this.readLattice(column1, row1 + 1);
    const r2c2 = this.readLattice(column1 + 1, row1 + 1);
    const r2c3 = this.readLattice(column1 + 2, row1 + 1);
    if (r2c0 === null || r2c1 === null || r2c2 === null || r2c3 === null) return null;
    const r3c0 = this.readLattice(column1 - 1, row1 + 2);
    const r3c1 = this.readLattice(column1, row1 + 2);
    const r3c2 = this.readLattice(column1 + 1, row1 + 2);
    const r3c3 = this.readLattice(column1 + 2, row1 + 2);
    if (r3c0 === null || r3c1 === null || r3c2 === null || r3c3 === null) return null;

    const row0 = catmullRom(r0c0, r0c1, r0c2, r0c3, tx);
    const row1Value = catmullRom(r1c0, r1c1, r1c2, r1c3, tx);
    const row2 = catmullRom(r2c0, r2c1, r2c2, r2c3, tx);
    const row3 = catmullRom(r3c0, r3c1, r3c2, r3c3, tx);
    return catmullRom(row0, row1Value, row2, row3, tz);
  }

  private readLattice(globalColumn: number, globalRow: number): number | null {
    const tileX = Math.floor(globalColumn / WORLD_PAGE_HEIGHT_CORE);
    const tileZ = Math.floor(globalRow / WORLD_PAGE_HEIGHT_CORE);
    const column = globalColumn - tileX * WORLD_PAGE_HEIGHT_CORE;
    const row = globalRow - tileZ * WORLD_PAGE_HEIGHT_CORE;
    const page = this.findPage(tileX, tileZ);
    return page?.heights[row * WORLD_PAGE_HEIGHT_CORE + column] ?? null;
  }

  private findPage(tileX: number, tileZ: number): ReadbackPage | null {
    for (let index = 0; index < this.pages.length; index += 1) {
      const page = this.pages[index];
      if (page !== null && page !== undefined && page.tileX === tileX && page.tileZ === tileZ) {
        return page;
      }
    }
    return null;
  }

  private sampleMacro(x: number, z: number, analyticHeight?: number): number | null {
    const grid = this.macro;
    if (grid === null) return null;
    const sampleX = (x - grid.originX) / grid.texelSizeMeters;
    const sampleZ = (z - grid.originZ) / grid.texelSizeMeters;
    // The macro samples are cell-centred; its declared world domain reaches
    // half a texel beyond the first and last centres.
    if (
      sampleX < -0.5
      || sampleZ < -0.5
      || sampleX > grid.width - 0.5
      || sampleZ > grid.height - 0.5
    ) {
      return null;
    }
    const clampedX = Math.max(0, Math.min(grid.width - 1, sampleX));
    const clampedZ = Math.max(0, Math.min(grid.height - 1, sampleZ));
    const column = Math.min(grid.width - 2, Math.floor(clampedX));
    const row = Math.min(grid.height - 2, Math.floor(clampedZ));
    const tx = clampedX - column;
    const tz = clampedZ - row;
    const topLeft = grid.heights[row * grid.width + column]!;
    const topRight = grid.heights[row * grid.width + column + 1]!;
    const bottomLeft = grid.heights[(row + 1) * grid.width + column]!;
    const bottomRight = grid.heights[(row + 1) * grid.width + column + 1]!;
    const top = topLeft + (topRight - topLeft) * tx;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * tx;
    const evolvedHeight = top + (bottom - top) * tz;
    const blendTexels = grid.analyticBlendTexels ?? 0;
    if (blendTexels <= 0 || analyticHeight === undefined) return evolvedHeight;
    requireFinite(analyticHeight, "Macro analytic blend height");
    const distanceToRimTexels = Math.min(
      sampleX + 0.5,
      grid.width - 0.5 - sampleX,
      sampleZ + 0.5,
      grid.height - 0.5 - sampleZ,
    );
    const amount = Math.max(0, Math.min(1, distanceToRimTexels / blendTexels));
    const blend = amount * amount * (3 - 2 * amount);
    return analyticHeight + (evolvedHeight - analyticHeight) * blend;
  }
}
