import {
  getAirportInfluence,
  isPointOnRunway,
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  TERRAIN_NORMAL_SAMPLE_DISTANCE,
  type TerrainCollisionSample,
  type WorldDefinition,
} from "@/src/world";

/** The page/macro authority `5-2` installs. Null keeps the analytic kernel. */
export interface GroundHeightAuthority {
  sampleHeight(x: number, z: number, analyticHeight?: number): number | null;
  /** Count the last-resort answer at the one site that is allowed to serve it. */
  recordAnalyticSample?(): void;
}

/** Compatibility name retained for the render-side Phase 4 contract. */
export type GroundHeightMirror = GroundHeightAuthority;

let publishedAuthority: GroundHeightAuthority | null = null;

/**
 * Install (or clear) the published-height authority.
 *
 * `4-2` added this seam so `5-2` swaps a PRODUCER rather than building
 * plumbing: the ring, the query path and the miss counter already exist and
 * are already asserted. Passing null restores the analytic kernel, which is
 * what ships until erosion breaks parity.
 */
export function setGroundHeightMirror(mirror: GroundHeightMirror | null): void {
  publishedAuthority = mirror;
}

/**
 * The simulation-side terrain authority (0-5).
 *
 * Every physics terrain query — the simulation worker's samplers, spawn
 * placement, and crash recovery — routes through this module and nothing
 * else. That is the §1.3 consistency contract's simulation half: the surface
 * the aircraft touches and the surface on screen are produced by the same
 * authority, and when the authority changes, it changes in exactly one place.
 *
 * Phase `5-2` installs the worker's Catmull-Rom page/macro ladder through the
 * seam above. The analytic kernel remains only the pre-load/out-of-domain
 * last resort; the crowned runway remains the exact Class-K fast path.
 */

/** Ground elevation at a world coordinate, from the active terrain authority. */
export function sampleGroundHeight(world: WorldDefinition, x: number, z: number): number {
  // The crowned airport platform is an analytic Class-K fast path. It bypasses
  // the ladder so the runway profile remains bit-identical and available even
  // before a page or macro transfer arrives.
  if (world.airport && getAirportInfluence(world.airport, x, z) >= 1) {
    return sampleTerrainCollisionHeight(world, x, z);
  }

  // A final L0 page wins, then the macro grid. The installed authority returns
  // null only for the analytic last resort and owns the corresponding counter.
  // The analytic value is also the canonical rim-blend endpoint. Computing it
  // here preserves the sole collision-kernel import site while letting the
  // worker authority blend its macro without owning world-generation state.
  const analytic = sampleTerrainCollisionHeight(world, x, z);
  const published = publishedAuthority?.sampleHeight(x, z, analytic);
  if (published !== null && published !== undefined) return published;
  publishedAuthority?.recordAnalyticSample?.();
  return analytic;
}

/**
 * Full contact sample — elevation, surface normal, runway classification and
 * friction — from the active terrain authority. Supply a reusable target to
 * keep the fixed-step physics loop allocation-free.
 */
export function sampleGroundContact(
  world: WorldDefinition,
  x: number,
  z: number,
  target: TerrainCollisionSample,
): TerrainCollisionSample {
  // Preserve Phase 3's crowned runway height, camber-tilted normal and tyre
  // friction bit-for-bit. Sampling the readback here would quantize the one
  // surface whose exact contact profile is already a hard contract.
  if (world.airport && isPointOnRunway(world.airport, x, z)) {
    return sampleTerrainCollision(world, x, z, target);
  }

  const height = sampleGroundHeight(world, x, z);
  // The same 2 m footprint the analytic collision path has always used, now
  // evaluated against the active ladder. This is allocation-free and keeps
  // contact height and contact normal on one authority.
  const delta = TERRAIN_NORMAL_SAMPLE_DISTANCE;
  const left = sampleGroundHeight(world, x - delta, z);
  const right = sampleGroundHeight(world, x + delta, z);
  const back = sampleGroundHeight(world, x, z - delta);
  const front = sampleGroundHeight(world, x, z + delta);
  const gradientX = (right - left) / (2 * delta);
  const gradientZ = (front - back) / (2 * delta);
  const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
  target.height = height;
  target.normal.x = -gradientX * inverseLength;
  target.normal.y = inverseLength;
  target.normal.z = -gradientZ * inverseLength;
  target.isRunway = false;
  target.friction = height <= world.seaLevel ? 0.05 : 0.86;
  return target;
}
