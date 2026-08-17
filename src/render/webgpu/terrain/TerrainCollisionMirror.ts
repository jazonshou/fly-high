/**
 * Render-side half of the §1.3 physics/render consistency contract (0-5).
 *
 * When erosion breaks height parity at 5-2, the renderer becomes the height
 * authority and must publish every eroded L0 page's heights back to the
 * simulation worker, where `src/sim/terrainGrid.ts` samples them bicubically.
 * This interface is that publication contract, declared now so the plumbing
 * has one owner from the start; the null implementation is what ships until
 * 5-2 implements the readback.
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
   * Collision samples served by the coarse analytic fallback instead of a
   * published page. Surfaced as RenderDiagnostics.collisionSamplesServedByFallback;
   * §1.3: any non-zero value below 500 m AGL is a bug.
   */
  readonly fallbackSampleCount: number;
}

/**
 * Pre-5-2 implementation: physics samples the analytic kernel directly, so
 * nothing is mirrored and nothing can fall back.
 */
export class NullTerrainCollisionMirror implements TerrainCollisionMirror {
  readonly fallbackSampleCount = 0;

  publishPage(): void {
    // Intentionally empty: the analytic kernel is still the sole authority.
  }
}
