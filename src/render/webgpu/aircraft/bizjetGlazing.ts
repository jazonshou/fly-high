/**
 * THE GLOBAL'S FLIGHT-DECK GLAZING: the type's six panes, laid out on the body
 * and cast onto the built skin.
 *
 * The flight deck was one raked box across the nose and a slab each side,
 * whose visible outlines were wherever they happened to cut the skin. The type
 * has six panes in one band: a two-piece windshield either side of a centre
 * post, and two side panes a side behind a swept pillar, with a mid post
 * between them. The band's top edge is one smooth line from the crown at the
 * post back and down to the aft edge.
 *
 * WHERE THE OUTLINE COMES FROM. Bombardier's 2018 brochure, top view (p. 31,
 * 65.14 px/m from the span, nose tip on row 101), read row by row: at each
 * station, where the glass starts and stops across the section and where the
 * silhouette is. Each edge is kept as (metres aft of the nose tip, degrees
 * round the section from the crown), the angle being asin(z / half-width) at
 * that station. docs/findings/GLOBAL_LIVERY.md, "Phase 3b", has the table.
 *
 * WHY STATION AND ANGLE, not heights. The model's nose was not the type's:
 * 0.12-0.23 m narrower from 1.3 to 3.5 m aft of the tip (phase 3c widened it
 * to the top view's), and taller where the windshield sits. Heights copied
 * from the type would float off or sink into a nose that is not the type's.
 * The same station and the same angle round the section put each corner in
 * the same place ON the nose, whatever the nose is, so a re-lofted nose
 * re-casts the glass without a new table (as phase 3c's did).
 *
 * HOW IT IS BUILT. As the 747's (`airlinerGlazing.ts`): every grid point is a
 * sightline from a reference on the centreline, cast onto the skin's own
 * triangles, so the glass follows the facets the skin is drawn with. Here the
 * sightline is the one through the outline's point on the loft's section. The
 * reference is the Global's R, pinned here rather than read from
 * `catalogue.cockpitEye`, so re-solving the eye does not move the glass.
 *
 * Pure geometry: no Babylon. `bizjetVisual.ts` hands in the skin's triangles
 * and builds the meshes; the tests read the same functions.
 */

import type { GlazingPane, Point3 } from "./airlinerGlazing";
import type { LoftSection } from "./builders";
import { GLOBAL_FUSELAGE_SECTIONS } from "./bizjetLivery";

/** The azimuth reference: on the centreline at the pilots' station and eye height (`cockpitEye` 11.90 / 0.78). */
export const GLOBAL_FLIGHT_DECK_REFERENCE: Point3 = Object.freeze({ x: 11.9, y: 0.78, z: 0 });

/** The nose tip, which "aft of the nose tip" is measured from: the fuselage loft's last ring. */
export const GLOBAL_NOSE_TIP_X = GLOBAL_FUSELAGE_SECTIONS[GLOBAL_FUSELAGE_SECTIONS.length - 1]!.x;

/** A point of the outline: metres aft of the nose tip, degrees round the section from the crown. */
export type BodyPoint = readonly [aft: number, angle: number];

export interface GlobalPaneOutline {
  readonly name: "windshield" | "forward-side" | "aft-side";
  /**
   * The bottom and top edges, each from the pane's inboard end to its
   * outboard one: out from the post for the windshield, forward to aft for
   * the side panes. The pane's two other edges are the straight lines (in
   * station and angle) joining their ends.
   */
  readonly bottom: readonly BodyPoint[];
  readonly top: readonly BodyPoint[];
}

/**
 * The type's six panes, starboard; port is the mirror. Read off the top view
 * at 0.05 m stations and rounded to the half degree.
 *
 * - The WINDSHIELD's bottom edge runs from 1.69 m aft beside the post, round
 *   and back to 2.21 m aft at 44 degrees; its top edge from 2.22 m aft beside
 *   the post to 2.57 m aft at 31. The pillar behind it is ~0.1 m wide.
 * - The FORWARD SIDE pane starts at the pillar, 2.28 m aft at the bottom and
 *   2.62 at the top; the swept pillar is why the pane is a trapezoid.
 * - The MID POST is not resolved in the top view. The starboard renders put it
 *   half way along the side glazing, leaning aft at the top: 2.85-2.91 m aft at
 *   the bottom, 2.93-2.99 at the top.
 * - The AFT SIDE pane ends square at 3.40 m aft (3.42 starboard, 3.37 port).
 *
 * The bottom of the side glazing is the mean of the two sides: the starboard
 * reads a few degrees lower round the section, where the render's shading
 * darkens the skin beside the glass.
 */
export const GLOBAL_FLIGHT_DECK_OUTLINES: readonly GlobalPaneOutline[] = Object.freeze([
  {
    name: "windshield",
    bottom: [[1.69, 4], [1.75, 16], [1.85, 26], [1.95, 33], [2.05, 39], [2.15, 43], [2.21, 44]],
    top: [[2.22, 4], [2.3, 11], [2.4, 18], [2.5, 25], [2.57, 31]],
  },
  {
    name: "forward-side",
    bottom: [[2.28, 50], [2.4, 54], [2.5, 57], [2.62, 59.5], [2.75, 62], [2.85, 63.5]],
    top: [[2.62, 35], [2.72, 36], [2.82, 38.5], [2.93, 42]],
  },
  {
    name: "aft-side",
    bottom: [[2.91, 64.5], [3.0, 65], [3.2, 67], [3.4, 68]],
    top: [[2.99, 44], [3.1, 46.5], [3.25, 49], [3.4, 51]],
  },
] satisfies GlobalPaneOutline[]);

/**
 * The centre post: the strip between the two windshields, +-4 degrees round
 * the section (0.13 m across on the type, whose post measures 0.13), from the
 * windshields' bottom station to their top.
 */
export const GLOBAL_CENTRE_POST = Object.freeze({ halfAngle: 4, aft: [1.69, 2.22] as const });

/** Glass outside the skin, along the skin's normal. */
export const GLOBAL_PANE_PROUD = 0.012;
/** Glass inside the skin: the inner face the cockpit looks through. */
export const GLOBAL_PANE_DEPTH = 0.03;

interface Ellipse {
  readonly yRadius: number;
  readonly zRadius: number;
  readonly yOffset: number;
}

function interpolate(sections: readonly LoftSection[], x: number): Ellipse {
  let low = sections[0]!;
  let high = sections[sections.length - 1]!;
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index]!.x >= x) {
      low = sections[index - 1]!;
      high = sections[index]!;
      break;
    }
  }
  const t = Math.min(1, Math.max(0, (x - low.x) / (high.x - low.x)));
  return {
    yRadius: low.yRadius + (high.yRadius - low.yRadius) * t,
    zRadius: low.zRadius + (high.zRadius - low.zRadius) * t,
    yOffset: (low.yOffset ?? 0) + ((high.yOffset ?? 0) - (low.yOffset ?? 0)) * t,
  };
}

/**
 * The skin's section at a station: the fuselage loft's, which runs to the
 * nose tip. Linear between rings, as the loft's facets are. Every Global ring
 * is a plain ellipse; a squared or crown-tapered ring would need the loft's
 * full formula, so one fails here rather than casting to the wrong place.
 */
export function globalSkinSectionAt(x: number): Ellipse {
  for (const section of GLOBAL_FUSELAGE_SECTIONS) {
    if ((section.squareness ?? 2) !== 2 || section.crownZRadius !== undefined || section.zOffset !== undefined) {
      throw new RangeError(`the Global's glazing assumes elliptical rings; the ring at x ${section.x} is not one`);
    }
  }
  return interpolate(GLOBAL_FUSELAGE_SECTIONS, x);
}

/** The loft's point at a station and an angle round the section; `side` +1 starboard (+z). */
export function globalBodyPoint([aft, angle]: BodyPoint, side: 1 | -1): Point3 {
  const x = GLOBAL_NOSE_TIP_X - aft;
  const section = globalSkinSectionAt(x);
  const radians = (angle * Math.PI) / 180;
  return {
    x,
    y: section.yOffset + section.yRadius * Math.cos(radians),
    z: side * section.zRadius * Math.sin(radians),
  };
}

/** The (azimuth, elevation) in degrees, outboard positive, of the sightline from `reference` through a starboard point. */
export function anglesTo(point: Point3, reference: Point3 = GLOBAL_FLIGHT_DECK_REFERENCE): readonly [number, number] {
  const dx = point.x - reference.x;
  const dy = point.y - reference.y;
  const dz = point.z - reference.z;
  return [(Math.atan2(dz, dx) * 180) / Math.PI, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI];
}

/**
 * The point `fraction` of the way along a polyline, by length on the body:
 * station in metres and angle as metres at a 1 m radius. Both edges of a pane
 * are walked at the same fraction, so a grid column is a line across the pane
 * and the columns spread evenly along it.
 */
export function alongOutline(edge: readonly BodyPoint[], fraction: number): BodyPoint {
  if (edge.length < 2) throw new RangeError("A pane edge needs at least two points");
  const lengths = [0];
  for (let index = 1; index < edge.length; index += 1) {
    const [a0, t0] = edge[index - 1]!;
    const [a1, t1] = edge[index]!;
    lengths.push(lengths[index - 1]! + Math.hypot(a1 - a0, ((t1 - t0) * Math.PI) / 180));
  }
  const target = Math.min(1, Math.max(0, fraction)) * lengths[lengths.length - 1]!;
  for (let index = 1; index < edge.length; index += 1) {
    if (target <= lengths[index]! || index === edge.length - 1) {
      const span = lengths[index]! - lengths[index - 1]!;
      const t = span > 0 ? (target - lengths[index - 1]!) / span : 0;
      const [a0, t0] = edge[index - 1]!;
      const [a1, t1] = edge[index]!;
      return [a0 + (a1 - a0) * t, t0 + (t1 - t0) * t];
    }
  }
  return edge[edge.length - 1]!;
}

/** The outline's point at a grid position: columns inboard to outboard, rows bottom to top. */
export function outlinePoint(outline: GlobalPaneOutline, columnFraction: number, rowFraction: number): BodyPoint {
  const [bottomAft, bottomAngle] = alongOutline(outline.bottom, columnFraction);
  const [topAft, topAngle] = alongOutline(outline.top, columnFraction);
  return [bottomAft + (topAft - bottomAft) * rowFraction, bottomAngle + (topAngle - bottomAngle) * rowFraction];
}

/** The azimuth and elevation ranges a pane's mapping covers, sampled on a 17 x 17 grid: its edges curve in angle. */
function boundingRanges(at: (columnFraction: number, rowFraction: number) => readonly [number, number]) {
  const samples: (readonly [number, number])[] = [];
  for (let i = 0; i <= 16; i += 1) for (let j = 0; j <= 16; j += 1) samples.push(at(i / 16, j / 16));
  const range = (k: 0 | 1) => [Math.min(...samples.map((c) => c[k])), Math.max(...samples.map((c) => c[k]))] as const;
  return { azimuth: range(0), elevation: range(1) };
}

/** A pane for `paneGrid`: its (azimuth, elevation) at every grid point is the sightline from R through the outline. */
export function globalGlazingPane(outline: GlobalPaneOutline, reference: Point3 = GLOBAL_FLIGHT_DECK_REFERENCE): GlazingPane {
  const at = (columnFraction: number, rowFraction: number) =>
    anglesTo(globalBodyPoint(outlinePoint(outline, columnFraction, rowFraction), 1), reference);
  return { name: outline.name, ...boundingRanges(at), at };
}

/** The centre post as a `paneGrid` pane: two columns, port edge to starboard edge, over the windshield's stations. */
export function globalCentrePostPane(reference: Point3 = GLOBAL_FLIGHT_DECK_REFERENCE): GlazingPane {
  const { halfAngle, aft } = GLOBAL_CENTRE_POST;
  const at = (columnFraction: number, rowFraction: number) =>
    anglesTo(
      globalBodyPoint([aft[0] + (aft[1] - aft[0]) * rowFraction, -halfAngle + 2 * halfAngle * columnFraction], 1),
      reference,
    );
  return { name: "centre-post", ...boundingRanges(at), at };
}
