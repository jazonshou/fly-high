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
import { approachLightExclusionBoxes } from "../lighting/AirfieldLighting";

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
 * The lamp rows join here from `approachLightExclusionBoxes`, derived from
 * `AirfieldLighting`'s own placements rather than from `approachLengthMeters`,
 * so the approach row's exclusion follows the lamps that actually ship. A row
 * is a LINE — `halfAcrossMeters: 0` — which is why this interface carries a
 * half-extent per axis rather than a footprint.
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
  // `7-7b`: the approach lighting system. Appended rather than merged into the
  // loop above because they are a different owner's placements and must stay
  // separately attributable if one of the two exclusions is ever wrong.
  boxes.push(...approachLightExclusionBoxes(airport));
  return boxes;
}

/**
 * One airport's structures, stated in that airport's runway frame.
 *
 * **WHY THE AIRPORT TRAVELS WITH ITS BOXES.** A box is runway-local, so it means
 * nothing without the runway it was measured from. Once airports spawn during a
 * flight there is more than one frame, and a list of boxes paired with "the"
 * airport would put a spawned field's hangars on the home field's runway.
 */
export interface StructureExclusionSite {
  readonly airport: Readonly<AirportDefinition>;
  readonly boxes: readonly StructureExclusionBox[];
}

/** World-space axis-aligned bounds, metres. */
export interface WorldBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/**
 * Every airport's structure exclusions, in `airports` order (home field first).
 *
 * The same `seedHash` for every airport, because it is the hangars' siting
 * seed and `AirportSystem` builds every field's hangars from it.
 */
export function airfieldStructureExclusionSites(
  airports: readonly Readonly<AirportDefinition>[],
  seedHash: number,
): readonly StructureExclusionSite[] {
  return airports.map((airport) => ({
    airport,
    boxes: airfieldStructureExclusions(airport, seedHash),
  }));
}

/**
 * The world rectangle outside which `structureClearanceFactor` is EXACTLY 1 for
 * this site.
 *
 * Each box's runway-local corners (rotated by its own yaw) are taken to world
 * space and the union is grown by the hard clearance plus the blend. A point
 * outside a rectangle grown by `e` on every side is more than `e` from it along
 * at least one axis, so more than `e` from anything inside it — and the factor
 * returns 1 from `STRUCTURE_HARD_CLEARANCE_METERS + STRUCTURE_BLEND_METERS` out.
 * That is what lets a caller skip a site whose bounds miss a cell without
 * changing a single placement inside it.
 */
export function structureExclusionSiteBounds(site: StructureExclusionSite): WorldBounds {
  const { airport } = site;
  const sinHeading = Math.sin(airport.headingRadians);
  const cosHeading = Math.cos(airport.headingRadians);
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const box of site.boxes) {
    const cos = Math.cos(box.yawRadians);
    const sin = Math.sin(box.yawRadians);
    for (const [cornerAlong, cornerAcross] of [
      [box.halfAlongMeters, box.halfAcrossMeters],
      [box.halfAlongMeters, -box.halfAcrossMeters],
      [-box.halfAlongMeters, box.halfAcrossMeters],
      [-box.halfAlongMeters, -box.halfAcrossMeters],
    ] as const) {
      // Box axes into runway axes (the inverse of `structureClearanceFactor`'s
      // rotation), then runway-local into world — `runwayToWorld`'s algebra.
      const along = box.alongMeters + cornerAlong * cos - cornerAcross * sin;
      const across = box.acrossMeters + cornerAlong * sin + cornerAcross * cos;
      const x = airport.centerX + along * sinHeading + across * cosHeading;
      const z = airport.centerZ + along * cosHeading - across * sinHeading;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: airport.centerX, minZ: airport.centerZ, maxX: airport.centerX, maxZ: airport.centerZ };
  }
  // A millimetre over the reach, so float rounding in the corner arithmetic can
  // never make the skip claim false at the very edge.
  const reach = STRUCTURE_HARD_CLEARANCE_METERS + STRUCTURE_BLEND_METERS + 1e-3;
  return { minX: minX - reach, minZ: minZ - reach, maxX: maxX + reach, maxZ: maxZ + reach };
}

/** Whether two closed world rectangles share any point. */
export function worldBoundsOverlap(a: WorldBounds, b: WorldBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * The product of every site's clearance at a world point: 0 inside any
 * structure, 1 clear of all of them.
 *
 * A product rather than a minimum because airports are kept kilometres apart,
 * so at most one factor is ever below 1 and the two agree — and a product of
 * exact 1s is exactly the single-site answer, which is what keeps a world with
 * only its home field bit-identical.
 */
export function structureClearanceFactorForSites(
  sites: readonly StructureExclusionSite[],
  x: number,
  z: number,
): number {
  let factor = 1;
  for (const site of sites) {
    if (site.boxes.length === 0) continue;
    factor *= structureClearanceFactor(site.airport, site.boxes, x, z);
    if (factor <= 0) return 0;
  }
  return factor;
}
