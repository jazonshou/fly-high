import { WORLD_PAGE_HEIGHT_CORE } from "@/src/render/webgpu/world/pageGeometry";

/**
 * Render-side half of the §1.3 physics/render consistency contract (0-5),
 * wired for real at `4-2`.
 *
 * When erosion breaks height parity at 5-2, the renderer becomes the height
 * authority and must publish every eroded L0 page's heights back to the
 * simulation worker, where `src/sim/terrainGrid.ts` samples them. This
 * interface is that publication contract.
 *
 * **`4-2` made both halves real, and that is the point of doing it a phase
 * early.** Until this item, `publishPage` had zero call sites and
 * `fallbackSampleCount` was a `readonly 0` — so `ARCHITECTURE.md`'s "must
 * stay 0 below 500 m AGL" was unfalsifiable, and `5-2` would have had to build
 * the plumbing and swap the authority in one commit. Now `5-2` swaps a
 * producer into a ring that already exists, already answers queries, and
 * already counts its own misses (assertion 86).
 *
 * The counter here is the RENDER-SIDE aggregation only. The real counting site
 * is the sim worker — only it knows AGL and which authority served a sample —
 * and `PHASE_5_EXECUTION_PLAN.md` §4 D9 owns the protocol variants, the worker
 * page ring and the counter's plumb-back on the snapshot message.
 */
export interface TerrainCollisionMirror {
  /**
   * Publish one page of authoritative collision heights (core samples only,
   * row-major) for the simulation worker's 5×5 L0 ring.
   */
  publishPage(
    level: number,
    tileX: number,
    tileZ: number,
    heights: Float32Array,
  ): void;

  /**
   * Height at a world coordinate from a published page, or null when no
   * published page covers it. A null is a FALLBACK — the caller serves the
   * sample analytically and this mirror counts it.
   */
  sampleHeight(x: number, z: number): number | null;

  /**
   * Collision samples served by the coarse analytic fallback instead of a
   * published page. Surfaced as RenderDiagnostics.collisionSamplesServedByFallback;
   * §1.3: any non-zero value below 500 m AGL is a bug.
   */
  readonly fallbackSampleCount: number;

  /** Published pages currently resident in the ring. */
  readonly publishedPageCount: number;

  resetCounters(): void;
}

/**
 * Pre-`5-2` implementation: physics samples the analytic kernel directly, so
 * nothing is mirrored and nothing can fall back.
 *
 * Kept as the default the renderer installs, because until erosion exists the
 * analytic kernel IS the authority and a mirror that answered would be a
 * second one.
 */
export class NullTerrainCollisionMirror implements TerrainCollisionMirror {
  readonly fallbackSampleCount = 0;
  readonly publishedPageCount = 0;

  publishPage(): void {
    // Intentionally empty: the analytic kernel is still the sole authority.
  }

  sampleHeight(): number | null {
    return null;
  }

  resetCounters(): void {
    // No counters to reset.
  }
}

/** Level-0 pages held for the simulation's ring. 5×5 plus a margin of one. */
const PUBLISHED_PAGE_CAPACITY = 36;

interface PublishedPage {
  readonly level: number;
  readonly tileX: number;
  readonly tileZ: number;
  readonly heights: Float32Array;
  sequence: number;
}

/**
 * A real page ring with a real miss counter.
 *
 * Bilinear rather than `5-2`'s Catmull-Rom bicubic, deliberately: this class
 * exists so the plumbing and the counter are exercised and asserted a phase
 * early, and the interpolation kernel is the part `5-2` replaces alongside the
 * producer. Publishing a page whose contents came from the analytic kernel
 * therefore reproduces the analytic surface to within the page's own texel
 * spacing, which is what the invariant test checks.
 */
export class PublishingTerrainCollisionMirror implements TerrainCollisionMirror {
  private readonly pages = new Map<string, PublishedPage>();
  private fallbacks = 0;
  private sequence = 0;

  constructor(
    private readonly pageExtentMeters: number,
    private readonly core: number = WORLD_PAGE_HEIGHT_CORE,
  ) {
    if (!Number.isFinite(pageExtentMeters) || pageExtentMeters <= 0) {
      throw new RangeError("Published page extent must be finite and positive");
    }
  }

  get fallbackSampleCount(): number {
    return this.fallbacks;
  }

  get publishedPageCount(): number {
    return this.pages.size;
  }

  publishPage(level: number, tileX: number, tileZ: number, heights: Float32Array): void {
    // The ring is level-0 only: it is what the simulation's 5×5 ring reads,
    // and a coarser page would be a second, lower-authority answer to the
    // same question — the failure §1.3 exists to prevent.
    if (level !== 0) return;
    const expected = this.core * this.core;
    if (heights.length !== expected) {
      throw new RangeError(
        `Published page must carry ${expected} core samples, got ${heights.length}`,
      );
    }
    const key = `${tileX}:${tileZ}`;
    this.sequence += 1;
    const existing = this.pages.get(key);
    if (existing) {
      existing.heights.set(heights);
      existing.sequence = this.sequence;
      return;
    }
    if (this.pages.size >= PUBLISHED_PAGE_CAPACITY) this.evictOldest();
    this.pages.set(key, {
      level,
      tileX,
      tileZ,
      heights: Float32Array.from(heights),
      sequence: this.sequence,
    });
  }

  sampleHeight(x: number, z: number): number | null {
    const tileX = Math.floor(x / this.pageExtentMeters);
    const tileZ = Math.floor(z / this.pageExtentMeters);
    const page = this.pages.get(`${tileX}:${tileZ}`);
    if (!page) {
      this.fallbacks += 1;
      return null;
    }
    const spacing = this.pageExtentMeters / this.core;
    const localX = (x - tileX * this.pageExtentMeters) / spacing;
    const localZ = (z - tileZ * this.pageExtentMeters) / spacing;
    const column = Math.min(this.core - 2, Math.max(0, Math.floor(localX)));
    const row = Math.min(this.core - 2, Math.max(0, Math.floor(localZ)));
    const tx = Math.min(1, Math.max(0, localX - column));
    const tz = Math.min(1, Math.max(0, localZ - row));
    const at = (r: number, c: number): number => page.heights[r * this.core + c] ?? 0;
    const top = at(row, column) + (at(row, column + 1) - at(row, column)) * tx;
    const bottom = at(row + 1, column) + (at(row + 1, column + 1) - at(row + 1, column)) * tx;
    return top + (bottom - top) * tz;
  }

  resetCounters(): void {
    this.fallbacks = 0;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [key, page] of this.pages) {
      if (page.sequence < oldestSequence) {
        oldestSequence = page.sequence;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.pages.delete(oldestKey);
  }
}
