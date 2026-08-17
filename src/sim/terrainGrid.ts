import {
  sampleTerrainCollision,
  sampleTerrainCollisionHeight,
  type TerrainCollisionSample,
  type WorldDefinition,
} from "@/src/world";

/**
 * The simulation-side terrain authority (0-5).
 *
 * Every physics terrain query — the simulation worker's samplers, spawn
 * placement, and crash recovery — routes through this module and nothing
 * else. That is the §1.3 consistency contract's simulation half: the surface
 * the aircraft touches and the surface on screen are produced by the same
 * authority, and when the authority changes, it changes in exactly one place.
 *
 * Today both functions forward to the analytic kernel, so the contract holds
 * by construction. At 5-2 the bodies become a Catmull-Rom bicubic lookup into
 * eroded height pages published by the renderer's TerrainCollisionMirror,
 * with the analytic kernel serving only as the above-500 m-AGL fallback —
 * and only this file changes.
 */

/** Ground elevation at a world coordinate, from the active terrain authority. */
export function sampleGroundHeight(world: WorldDefinition, x: number, z: number): number {
  return sampleTerrainCollisionHeight(world, x, z);
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
  return sampleTerrainCollision(world, x, z, target);
}
