import { roundedRectangleSignedDistance, worldToRunway } from "../../../world/airport";
import type { AirportDefinition } from "../../../world/types";
import {
  CANOPY_DOMINANT_CROWN_RADIUS_METERS,
} from "../detail/densityField";
import {
  HANGAR_SITING,
  hangarFootprint,
  hangarYawRadians,
} from "./AirfieldStructures";

/**
 * Where vegetation must not grow, because a structure is standing there.
 *
 * **THE DEFECT THIS EXISTS FOR, measured rather than described.** Jason, playing
 * the game: *"Some trees are growing into the hangers."* A second session found
 * the same thing in the approach lights.
 *
 * **The cause is NOT a missing exclusion and NOT an exclusion that misses.**
 * Both were predicted and both are wrong. `getAirportInfluence` blends over 240 m
 * past the graded platform and reads **0.60-0.74 at the hangar footprints** —
 * they sit well inside it. But it is applied as `clearance = 1 - influence`,
 * **multiplicatively**, so it THINS rather than excludes:
 *
 *     sample point                across   trees/ha   shrubs/ha
 *     runway centreline                0        0.0        0.0
 *     hangar centre                  135        3.4      142.6
 *     hangar outboard corner         158       24.8      210.1
 *     open ground                    300      322.3      272.9
 *
 * **Forty percent of a forest still puts a tree through a wall.** Over a
 * 0.156 ha hangar footprint that is roughly 0.5-4 trees and 22-33 shrubs, per
 * building. The approach row is worse: its crossbar sits at clearance **0.98**
 * — 74.7 trees/ha — and the last four lamps run past 980 m where the airport
 * field is exactly **0.000**, a genuine gap rather than a weak term.
 *
 * **SO THE EXCLUSION IS HARD, NOT SOFT.** A multiplicative term has no value at
 * which it guarantees zero; it only makes a tree through a wall less likely.
 * This returns exactly 0 inside the structure plus its clearance margin, and
 * blends back to 1 over a short band outside it.
 *
 * **ONE PRIMITIVE FOR BOTH SHAPES.** A hangar is a 46 x 34 m oriented box; an
 * approach row is a 420 m LINE, which is the same box with `halfAcrossMeters`
 * of zero. Building a footprint-only mechanism would have forced a second one
 * beside it for the lights, and two exclusions drift apart — the failure this
 * project has already paid for in a lateral band whose fuel farm sat 184.8 m
 * from the tanks.
 *
 * **AND THE GEOMETRY IS READ FROM THE SHIPPING POSITIONS.** `airfieldStructureExclusions`
 * derives every box from `hangarFootprint` and `hangarYawRadians` — the same
 * functions `AirportSystem` builds the meshes from — so a siting change moves
 * the exclusion with it and no second copy can go stale.
 */
export interface StructureExclusionBox {
  /** For diagnostics and guard messages; never keyed on. */
  readonly name: string;
  /**
   * Centre in RUNWAY-LOCAL metres, the frame every airfield placement already
   * speaks. **The first version of this carried world coordinates and a world
   * heading, and it missed two of every four hangar corners** — a rotation sign
   * error, which is the entire class of bug this frame choice deletes. A
   * footprint is axis-aligned in runway-local space; converting the QUERY point
   * once is cheaper and cannot be got backwards.
   */
  readonly alongMeters: number;
  readonly acrossMeters: number;
  /** Half-extent on the runway's ALONG axis. */
  readonly halfAlongMeters: number;
  /** Half-extent ACROSS it. **ZERO for a line**, which is the lamp-row case. */
  readonly halfAcrossMeters: number;
  /**
   * Rotation of the box within runway-local space. Zero for anything aligned
   * to the runway, which is most of an airfield; the hangars carry the small
   * seeded yaw that stops three buildings sitting on exactly parallel axes.
   */
  readonly yawRadians: number;
}

/**
 * Hard clearance beyond a structure's own extent, in metres.
 *
 * **Derived, not chosen: it is `CANOPY_DOMINANT_CROWN_RADIUS_METERS`.** A tree
 * whose TRUNK clears the wall but whose CROWN does not is still growing into
 * the building — the complaint is about what is visible, not about where the
 * stem is. A dominant crown reaches 5.8 m, so a trunk must clear the footprint
 * by at least that for the canopy to clear it too.
 */
export const STRUCTURE_HARD_CLEARANCE_METERS = CANOPY_DOMINANT_CROWN_RADIUS_METERS;

/**
 * How far the exclusion blends from 0 back to full density.
 *
 * One dominant crown DIAMETER, so the edge of the clearing is about one tree
 * wide. **Deliberately short.** Jason has separately said trees pop in too
 * late, so anything that thins vegetation beyond the immediate surround makes
 * a different complaint worse; this must not become a second global thinning.
 */
export const STRUCTURE_BLEND_METERS = 2 * CANOPY_DOMINANT_CROWN_RADIUS_METERS;

/**
 * 0 where a structure stands (plus its clearance), 1 where vegetation is free.
 *
 * Multiplied into stem density beside the existing airport clearance. The two
 * are separate terms ON PURPOSE: `airportInfluence` also drives terrain HEIGHT
 * through the earthworks platform, and collision short-circuits through the
 * same profile with the two pinned under 1 mm. **Folding a vegetation
 * exclusion into it would move the ground**, which is a Class K change; this
 * touches density only.
 */
export function structureClearanceFactor(
  airport: Readonly<AirportDefinition>,
  boxes: readonly StructureExclusionBox[],
  x: number,
  z: number,
): number {
  const local = worldToRunway(airport, x, z);
  let nearest = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    const dAlong = local.along - box.alongMeters;
    const dAcross = local.across - box.acrossMeters;
    const cos = Math.cos(-box.yawRadians);
    const sin = Math.sin(-box.yawRadians);
    // Into the box's own axes, then the same rounded-box distance the airport
    // platform uses — one SDF, so a line and a rectangle cannot disagree about
    // what "distance to the structure" means.
    const along = dAlong * cos - dAcross * sin;
    const across = dAlong * sin + dAcross * cos;
    const distance = roundedRectangleSignedDistance(
      along,
      across,
      box.halfAlongMeters,
      box.halfAcrossMeters,
    );
    if (distance < nearest) nearest = distance;
    if (nearest <= STRUCTURE_HARD_CLEARANCE_METERS) return 0;
  }
  if (!Number.isFinite(nearest)) return 1;
  const beyond = nearest - STRUCTURE_HARD_CLEARANCE_METERS;
  if (beyond <= 0) return 0;
  if (beyond >= STRUCTURE_BLEND_METERS) return 1;
  const t = beyond / STRUCTURE_BLEND_METERS;
  return t * t * (3 - 2 * t);
}

/**
 * Every airfield structure's exclusion box, in world space.
 *
 * **Derived from the builders, never restated.** The hangars come from
 * `hangarFootprint` and carry `hangarYawRadians` — the seeded yaw that stops
 * three buildings sitting on exactly parallel axes — so a hangar that moves or
 * turns takes its exclusion with it.
 *
 * The lamp rows are NOT here yet: they belong to `7-7`'s owner, who is feeding
 * them in from `AirfieldLighting`'s own placements for the same reason. The
 * box list is the seam between us.
 */
export function airfieldStructureExclusions(
  airport: Readonly<AirportDefinition>,
  seedHash: number,
): readonly StructureExclusionBox[] {
  const boxes: StructureExclusionBox[] = [];
  for (let index = 0; index < HANGAR_SITING.count; index += 1) {
    const footprint = hangarFootprint(airport, index);
    boxes.push({
      name: `hangar-${index}`,
      alongMeters: footprint.along,
      acrossMeters: footprint.across,
      // `widthMeters` spans ACROSS the runway and `depthMeters` ALONG it —
      // the footprint's own convention, not swapped to suit this box.
      halfAlongMeters: footprint.depthMeters / 2,
      halfAcrossMeters: footprint.widthMeters / 2,
      yawRadians: hangarYawRadians(seedHash, index),
    });
  }
  return boxes;
}
