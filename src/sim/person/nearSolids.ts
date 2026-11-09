import { ColliderWorld } from "../colliders";

/**
 * The near solids: the trunks, rocks, logs and stumps the near view draws
 * round the walker, as the detail worker lists them
 * (`src/render/webgpu/detail/nearSolidsSelection.ts`), posted to the
 * simulation worker (the `nearSolids` command, read by the walker through
 * `SurfaceVehicleEnvironment.nearSolids`) and kept on the main thread for the
 * character camera's boom. Grass, shrubs, branch litter and moss stay soft,
 * and only the walker reads the list: the car keeps trees soft.
 *
 * A list covers a disc of `radius` round (`centerX`, `centerZ`), the walker
 * when it was asked for. The renderer asks again every 16 m the walker moves
 * (`NEAR_SOLIDS_REFRESH_METERS`), and whenever a cell under the disc is
 * generated again, so the walker is always at least `radius - 16` m inside
 * the disc of the newest list.
 */

/** Floats per solid in `NearSolidsPost.records`. */
export const NEAR_SOLID_STRIDE = 8;

/** What a solid is: its record's first float. */
export const NEAR_SOLID_KIND = Object.freeze({
  /** A capsule up the drawn trunk, from under the ground to 2.5 m up. */
  trunk: 0,
  /** A sphere whose cap is the drawn rock above the ground. */
  rock: 1,
  /** A capsule along the drawn log. */
  log: 2,
  /** A capsule up the drawn stump. */
  stump: 3,
  /** The trunk on from 2.5 m to the crown (a trunk's material). */
  bole: 4,
});

/** Collider material of each kind in the near-solids world (the parked car is 201). */
export const NEAR_SOLID_MATERIAL = Object.freeze({
  trunk: 301,
  rock: 302,
  log: 303,
  stump: 304,
});

const MATERIAL_BY_KIND = [
  NEAR_SOLID_MATERIAL.trunk,
  NEAR_SOLID_MATERIAL.rock,
  NEAR_SOLID_MATERIAL.log,
  NEAR_SOLID_MATERIAL.stump,
  NEAR_SOLID_MATERIAL.trunk,
] as const;

/** The walker moves this far from a list's centre before the renderer asks for the next. */
export const NEAR_SOLIDS_REFRESH_METERS = 16;

export interface NearSolidsPost {
  /** Rises by one with every list the renderer publishes. */
  readonly version: number;
  /** World metres. */
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  /**
   * `NEAR_SOLID_STRIDE` floats a solid: kind, a.x, a.y, a.z, b.x, b.y, b.z,
   * radius. x and z are metres from the centre, y is world height. A rock is
   * a sphere at a (b repeats it); the rest are capsules from a to b.
   */
  readonly records: Float32Array;
}

/** The solids of `post` as a collider world, in world metres. */
export function nearSolidsColliderWorld(post: NearSolidsPost): ColliderWorld {
  const world = new ColliderWorld();
  const records = post.records;
  for (let offset = 0; offset + NEAR_SOLID_STRIDE <= records.length; offset += NEAR_SOLID_STRIDE) {
    const kind = records[offset]!;
    const material = MATERIAL_BY_KIND[kind];
    const radius = records[offset + 7]!;
    if (material === undefined || !(radius > 0)) continue;
    const a = { x: post.centerX + records[offset + 1]!, y: records[offset + 2]!, z: post.centerZ + records[offset + 3]! };
    if (kind === NEAR_SOLID_KIND.rock) {
      world.addStatic({ kind: "sphere", center: a, radius }, { material });
    } else {
      const b = { x: post.centerX + records[offset + 4]!, y: records[offset + 5]!, z: post.centerZ + records[offset + 6]! };
      world.addStatic({ kind: "capsule", a, b, radius }, { material });
    }
  }
  return world;
}

