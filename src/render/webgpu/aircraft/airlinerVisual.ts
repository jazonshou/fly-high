// `thinInstanceSetBuffer`/`thinInstanceCount` are prototype extensions Babylon
// only installs with this side-effect import, exactly as the Global's cabin
// window line takes it. This airframe needs it three times over: a 747's
// window line is 228 panes, its chevrons are 48 teeth and its flap track
// canoes are ten of one shape. As separate meshes those alone would be 286
// draw calls — three times the whole Global.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
} from "./animation";
import {
  applyCommonPose,
  configureCockpitLayers,
  configureRoot,
  createGlowApplier,
  createLampApplier,
  node,
  setCockpitVisibility,
  addInstrumentPanel,
  type CommonRig,
} from "./airframeRig";
import { AircraftBuildContext, type LoftSection } from "./builders";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AircraftVisual } from "./types";

/**
 * The Boeing 747-8 Intercontinental.
 *
 * The parts this airframe has beyond the common rig. Gear, doors and spoilers
 * follow the Global's contract because "how far is the brake out" and "how far
 * is the gear down" are one number each whatever metal answers them. The two
 * additions are the INBOARD ailerons — a 747 has four, and the common rig's
 * `ailerons` tuple holds two — and the four fan spools, which are driven from
 * one simulation-time phase so they can never be seen out of step.
 */
interface AirlinerRig extends CommonRig {
  readonly landingGear: TransformNode;
  /** Each door with the sign that swings its outboard edge DOWN. */
  readonly gearDoors: readonly { readonly hinge: TransformNode; readonly sign: number }[];
  readonly speedBrakes: readonly TransformNode[];
  /** Starboard first, as `ailerons` is. */
  readonly inboardAilerons: readonly [TransformNode, TransformNode];
}

// ---------------------------------------------------------------------------
// WING PLANFORM
// ---------------------------------------------------------------------------

/**
 * Written once because nine different parts are cut from it: three fixed
 * panels, four flaps, four ailerons, ten spoilers, ten flap track canoes, four
 * engine pylons and both wingtip lamps all read their station off these lines.
 *
 * The real aeroplane: 68.4 m span, 554 m^2, mean chord 9 m, 37.5 degrees of
 * leading-edge sweep — the four figures `sim/aircraft.ts` is written around.
 * The 554 and the 9 are the REFERENCE wing: a transport's area and mean
 * aerodynamic chord are quoted for the trapezoid you get by producing the
 * outboard leading and trailing edges in to the centreline and out to the tip,
 * not for the metal. Solving that trapezoid for 554 m^2 over 68.4 m at MAC
 * 9.00 pins it exactly: root chord 12.777, tip chord 3.421, taper 0.2678, and
 * a trailing edge swept 26.28 degrees. Every trailing-edge number below
 * outboard of the kink sits on that line, so the reference wing this mesh
 * implies IS 554.0 m^2 at MAC 9.00 rather than something near it.
 *
 * The metal is bigger, because a 747 carries the "Yehudi" — an inboard
 * trailing-edge glove that widens the root chord to 16.6 m and sweeps the
 * inboard trailing edge only 10.6 degrees. That is the single most recognisable
 * thing about the planform after the sweep itself, and it takes the gross
 * planform to 596.8 m^2 at a gross MAC of 10.36. Both numbers are real and they
 * describe different wings; the sim's pair describes the reference one.
 *
 * WHERE x = 0 IS. The reference MAC sits at z = 13.81, and 37.5 degrees carries
 * its leading edge 10.593 m aft of the centreline leading edge. Putting the
 * MAC quarter chord on x = 0 — the centre of gravity the whole sim definition
 * is written about — therefore fixes the centreline leading edge at x = 12.84
 * and nothing else. A wing anywhere else would have a 250-tonne aeroplane
 * balancing on a point its own lift does not pass through.
 */
const WING_CENTRELINE_LEADING_X = 12.84;
const WING_LEADING_SWEEP_TAN = Math.tan((37.5 * Math.PI) / 180);
/** Root rib, at the side of the wing-to-body fairing rather than the fuselage. */
const WING_ROOT_Z = 3;
/** The Yehudi break: outboard of here the trailing edge is the reference one. */
const WING_KINK_Z = 12.5;
/**
 * Where the raked tip begins, and where its leading edge breaks a second time.
 *
 * The rake is the outer 5.7 m of each wing — 17% of the semi-span. It is built
 * in TWO panels because a raked tip's leading edge is a curve, not a bevel:
 * 37.5 degrees to here, then 40, then 51.4 over the last 2.4 m. The first
 * version raked it in one straight 47-degree panel over 4.4 m and the plan
 * view read it as a chamfered corner rather than as a raked tip.
 */
const WING_RAKE_Z = 28.5;
const WING_RAKE_OUTER_Z = 31.8;
const WING_TIP_Z = 34.2;

/** Reference-trapezoid root chord and trailing-edge sweep, from the fit above. */
const REFERENCE_ROOT_CHORD = 12.7765;
const REFERENCE_TRAILING_SWEEP_TAN = 0.493783;
/** Centreline chord WITH the Yehudi glove, which the reference wing ignores. */
const WING_CENTRELINE_CHORD = 16.6;
/**
 * 1.90 m, down from the 2.30 the first version carried. A raked tip ENDS in a
 * point; at 2.30 the tip rib was 2.3 m of blunt edge and the plan view showed
 * a squared-off wing. The mid-rake chord of 3.75 keeps the taper progressive
 * so the drop to 1.90 happens over the last 2.4 m, which is what reads as rake.
 */
const WING_TIP_CHORD = 1.9;
const WING_RAKE_OUTER_CHORD = 3.75;

/** Straight at 37.5 degrees from the centreline out to the raked-tip break. */
function leadingEdgeX(z: number): number {
  return WING_CENTRELINE_LEADING_X - z * WING_LEADING_SWEEP_TAN;
}

/** The reference trailing edge, which the metal follows outboard of the kink. */
function referenceTrailingX(z: number): number {
  return WING_CENTRELINE_LEADING_X - REFERENCE_ROOT_CHORD - z * REFERENCE_TRAILING_SWEEP_TAN;
}

/**
 * Leading edge at each of the four defining stations — derived rather than
 * transcribed, so moving the wing fore or aft moves every part cut from it.
 */
const WING_ROOT_LEADING_X = leadingEdgeX(WING_ROOT_Z);
const WING_KINK_LEADING_X = leadingEdgeX(WING_KINK_Z);
const WING_RAKE_LEADING_X = leadingEdgeX(WING_RAKE_Z);
/**
 * THE RAKED TIP, and it is the one thing that separates a -8 from a -400. The
 * -400 carries 1.8 m vertical winglets; the -8 threw them away for 5.7 m of
 * swept-back span. Build a winglet here and the aeroplane is the wrong variant
 * from every angle.
 *
 * -16.50 is not chosen, it is transcribed: `AIRLINER_WASH` in
 * `lighting/AircraftLighting.ts` sites the nav and strobe lamps at
 * (-16.5, 0.5, +/-34.2) and `tests/lighting.aircraft-wash.test.ts` asserts each
 * one sits ON a lamp mesh. 37.5 degrees alone would carry the tip only to
 * -13.40; the rake takes it the last 3.10 m.
 *
 * The leading edge of a raked tip is a CURVE, not a bevel, so it is spent as
 * 45.0 degrees to the mid-rake station and 60.1 across the last 2.4 m rather
 * than as one straight 52. An earlier draft of the table put the tip at -14.8,
 * which left only 1.40 m of extra sweep and capped the panel at an average 45;
 * in plan it read as a chamfered corner. The table was moved to describe the
 * wing rather than constrain it, and 37.5 -> 45.0 -> 60.1 is the -8's own
 * leading edge.
 */
const WING_TIP_LEADING_X = -16.5;
const WING_RAKE_OUTER_LEADING_X = -12.33;

/** True trailing edge — where the flaps and ailerons END. */
const WING_KINK_TRAILING_X = referenceTrailingX(WING_KINK_Z);
const WING_RAKE_TRAILING_X = referenceTrailingX(WING_RAKE_Z);
/**
 * THE YEHUDI. Inboard of the kink the trailing edge leaves the reference line
 * and runs forward to a 16.6 m centreline chord, sweeping only 10.6 degrees.
 * That glove is the second most recognisable thing about a 747's planform and
 * the root rib reads its trailing edge off the line between the two.
 */
const WING_ROOT_TRAILING_X = alongPanel(
  WING_CENTRELINE_LEADING_X - WING_CENTRELINE_CHORD,
  WING_KINK_TRAILING_X,
  WING_ROOT_Z / WING_KINK_Z,
);
const WING_RAKE_OUTER_TRAILING_X = WING_RAKE_OUTER_LEADING_X - WING_RAKE_OUTER_CHORD;
const WING_TIP_TRAILING_X = WING_TIP_LEADING_X - WING_TIP_CHORD;

/**
 * Hinge line, at 70% of local chord. One fraction for the whole span so the
 * four flaps and four ailerons hang on a single unbroken line, which is what
 * lets the fixed wing be three panels a side instead of eleven. At the root
 * that is a 4.46 m flap chord, which is what a triple-slotted Fowler needs.
 */
const HINGE_CHORD_FRACTION = 0.7;
const WING_ROOT_HINGE_X = alongPanel(
  WING_ROOT_LEADING_X, WING_ROOT_TRAILING_X, HINGE_CHORD_FRACTION);
const WING_KINK_HINGE_X = alongPanel(
  WING_KINK_LEADING_X, WING_KINK_TRAILING_X, HINGE_CHORD_FRACTION);
const WING_RAKE_HINGE_X = alongPanel(
  WING_RAKE_LEADING_X, WING_RAKE_TRAILING_X, HINGE_CHORD_FRACTION);

/**
 * Chord-plane height at each station: the DIHEDRAL, and it is not constant.
 *
 * 3.4 degrees from the root to the Yehudi break, 5.6 to the rake break and 8.5
 * across the raked tip. A wing built at one angle reads as a ruler; a 747's
 * reads as a wing carrying 250 tonnes, because the slope grows outboard. The
 * tip lands at y = +0.50 because that is where `AIRLINER_WASH` puts the lamps,
 * and it is also 6.9 m of ground clearance under a wingtip with the wheels on
 * the pavement.
 *
 * The root at -2.42 puts the wing box through the BOTTOM of a fuselage whose
 * centreline is y = 0 and whose skin reaches -3.25. This is a low wing and
 * hanging it any higher is the difference between a 747 and an airlifter.
 */
const WING_ROOT_Y = -2.42;
const WING_KINK_Y = -1.86;
const WING_RAKE_Y = -0.25;
const WING_RAKE_OUTER_Y = 0.16;
const WING_TIP_Y = 0.5;

/** Thickness ratios: a supercritical section, thicker inboard where the fuel is. */
const WING_INBOARD_THICKNESS = 0.115;
const WING_OUTBOARD_THICKNESS = 0.095;
const WING_CAMBER = 0.006;

/** Linear interpolation along one of the three panels. */
function alongPanel(rootValue: number, tipValue: number, fraction: number): number {
  return rootValue + (tipValue - rootValue) * fraction;
}

/** Where a station sits along the inboard panel, 0 at the root rib. */
function inboardFraction(z: number): number {
  return (Math.abs(z) - WING_ROOT_Z) / (WING_KINK_Z - WING_ROOT_Z);
}

/** Where a station sits along the outboard panel, 0 at the Yehudi break. */
function outboardFraction(z: number): number {
  return (Math.abs(z) - WING_KINK_Z) / (WING_RAKE_Z - WING_KINK_Z);
}

/** True inboard of the Yehudi break, which is the only thing that selects a panel. */
function insideKink(z: number): boolean {
  return Math.abs(z) <= WING_KINK_Z;
}

function leadingAt(z: number): number {
  return insideKink(z)
    ? alongPanel(WING_ROOT_LEADING_X, WING_KINK_LEADING_X, inboardFraction(z))
    : alongPanel(WING_KINK_LEADING_X, WING_RAKE_LEADING_X, outboardFraction(z));
}

function trailingAt(z: number): number {
  return insideKink(z)
    ? alongPanel(WING_ROOT_TRAILING_X, WING_KINK_TRAILING_X, inboardFraction(z))
    : alongPanel(WING_KINK_TRAILING_X, WING_RAKE_TRAILING_X, outboardFraction(z));
}

function hingeAt(z: number): number {
  return insideKink(z)
    ? alongPanel(WING_ROOT_HINGE_X, WING_KINK_HINGE_X, inboardFraction(z))
    : alongPanel(WING_KINK_HINGE_X, WING_RAKE_HINGE_X, outboardFraction(z));
}

/** Chord-plane height, following the same two panels the dihedral is built in. */
function chordPlaneAt(z: number): number {
  return insideKink(z)
    ? alongPanel(WING_ROOT_Y, WING_KINK_Y, inboardFraction(z))
    : alongPanel(WING_KINK_Y, WING_RAKE_Y, outboardFraction(z));
}

/**
 * The UPPER surface at 60% chord, which is where the spoilers and the top of a
 * pylon have to sit.
 *
 * Derived rather than eyeballed, because ten spoilers on a swept, tapered,
 * dihedralled wing each need a different answer and a single guessed height
 * would leave half of them floating and half of them sunk. The NACA four-digit
 * half-thickness at 60% chord is 0.3753 of the section's thickness ratio, and
 * the camber line adds 4c(t)(1-t) = 0.96 of the camber ratio at the same
 * station; `builders.ts` builds the section from exactly those two terms.
 */
function upperSurfaceY(z: number): number {
  const ratio = insideKink(z) ? WING_INBOARD_THICKNESS : WING_OUTBOARD_THICKNESS;
  const chord = leadingAt(z) - trailingAt(z);
  return chordPlaneAt(z) + (0.3753 * ratio + 0.96 * WING_CAMBER) * chord;
}

/** The LOWER surface at the same station, which is what a pylon hangs from. */
function lowerSurfaceY(z: number): number {
  const ratio = insideKink(z) ? WING_INBOARD_THICKNESS : WING_OUTBOARD_THICKNESS;
  const chord = leadingAt(z) - trailingAt(z);
  return chordPlaneAt(z) - (0.3753 * ratio - 0.96 * WING_CAMBER) * chord;
}

// ---------------------------------------------------------------------------
// FUSELAGE
// ---------------------------------------------------------------------------

/**
 * The constant-section tube: 6.5 m outside diameter, centreline y = 0, running
 * from the tailcone join to the nose join. Six sections for 53 m of parallel
 * barrel is not miserliness — it IS a cylinder, and sections only buy anything
 * where the radius changes.
 */
const FUSELAGE_SECTIONS: readonly LoftSection[] = [
  { x: -26, yRadius: 3.08, zRadius: 3.08, yOffset: 0.16 },
  { x: -20, yRadius: 3.25, zRadius: 3.25 },
  { x: -6, yRadius: 3.25, zRadius: 3.25 },
  { x: 10, yRadius: 3.25, zRadius: 3.25 },
  { x: 22, yRadius: 3.25, zRadius: 3.25 },
  { x: 27.4, yRadius: 2.96, zRadius: 2.94, yOffset: -0.04 },
];

/**
 * The nose, and on this aeroplane the nose CARRIES THE FLIGHT DECK.
 *
 * The first version left the upper deck riding on top of the nose all the way
 * to the radome, and the rendered close-ups showed the result: a rounded
 * flight-deck capsule sitting in a valley on a second rounded nose, with a
 * dark crease between them. That is not a 747. A 747's forward fuselage is a
 * double bubble only as far forward as the cabin — around x = 29 — and ahead
 * of that the upper deck ENDS and the section becomes one tall tapering oval
 * with the flight deck windows near its top. So these sections grow TALLER
 * (yRadius 3.28, offset +0.42) while narrowing hard in z, the upper deck loft
 * dies inside them by x = 30, and the crown passes from one to the other at
 * about x = 29.5 without a step: 4.40, 4.25, 3.95 on the deck, then 3.70,
 * 3.55, 3.15 on the nose.
 *
 * It ends at x = 34 where the sim puts its two radome contact points. They
 * straddle y = 0.2 and y = -0.4, and the last section spans -0.41 to +0.21,
 * so the collision hull and the metal agree at the one place an aeroplane hits
 * things nose first.
 *
 * The underside SWEEPS UP, from -3.05 at the cabin to -1.45 at the radome.
 * That is the real shape, and with the crown falling at the same time it is
 * most of why a 747 nose reads as a 747 rather than as a cone.
 */
const NOSE_SECTIONS: readonly LoftSection[] = [
  // Starts 1.9 m inside the barrel so its aft cap is buried well clear of the
  // join; at the first draft's x = 27 the two lofts met almost exactly and the
  // seam showed as a ring around the nose in the rendered frames.
  { x: 25.5, yRadius: 3, zRadius: 3, yOffset: -0.02 },
  { x: 28, yRadius: 3.1, zRadius: 2.92, yOffset: 0.05 },
  { x: 29.2, yRadius: 3.28, zRadius: 2.7, yOffset: 0.42 },
  { x: 30.4, yRadius: 3.05, zRadius: 2.28, yOffset: 0.5 },
  { x: 31.4, yRadius: 2.72, zRadius: 1.82, yOffset: 0.43 },
  { x: 32.4, yRadius: 2, zRadius: 1.36, yOffset: 0.3 },
  { x: 33.4, yRadius: 1.2, zRadius: 0.92, yOffset: -0.25 },
  { x: 34, yRadius: 0.31, zRadius: 0.34, yOffset: -0.1 },
];

/**
 * THE HUMP. The raised forward upper deck, and the single most identifying
 * feature on the aeroplane — it has to read from every angle, so it is the
 * fuselage's own second lobe rather than a blister stuck on top.
 *
 * Built as a separate closed loft that INTERSECTS the tube rather than as a
 * bigger ellipse for the whole forward fuselage, because a 747's forward
 * section is a double bubble: a 3.25 m lower circle and a wide upper lobe
 * riding on it. A single ellipse tall enough to reach the upper-deck crown
 * would also be widest at upper-deck height, which is backwards — a 747 is
 * widest at the MAIN deck floor — and the tube's own skin closes the shape
 * everywhere the hump is inside it.
 *
 * THE WIDTH IS THE WHOLE POINT, and the first version had it wrong. At
 * zRadius 2.55 about a centre 2.1 m up, the two lobes crossed at y = 2.0 with
 * 41 degrees between their surfaces: a hard groove high on the flank, and in
 * the rendered frames the deck read as a second fuselage laid on top of the
 * first rather than as a fuselage that swells into a raised deck. Widening it
 * to 2.95 and dropping the centre to 1.65 moves the crossing down to y = 1.39,
 * z = 2.94 and opens the included angle to 31 degrees — the upper lobe now
 * carries the whole upper half of the section and the crease falls where a
 * 747's fairing line actually runs, just above the main deck ceiling. The
 * crown is unchanged; only the shoulders moved.
 *
 * The crown reaches exactly 4.40 at x = 26, which is where `sim/aircraft.ts`
 * puts its upper-deck contact point. The deck runs 20 m of visible length back
 * to x = +13, where the crown drops under the tube's 3.25 and the fairing
 * ends: longer than the 747-400's, which is what the -8 is. The forward end
 * dives into the radome at x = 33 with its cap buried, so there is no flat
 * face at the front of the flight deck roof.
 */
const HUMP_SECTIONS: readonly LoftSection[] = [
  { x: 7, yRadius: 0.85, zRadius: 1.2, yOffset: 1.05 },
  { x: 11, yRadius: 1.7, zRadius: 2.05, yOffset: 1.3 },
  { x: 14, yRadius: 2.25, zRadius: 2.55, yOffset: 1.5 },
  { x: 18, yRadius: 2.6, zRadius: 2.85, yOffset: 1.62 },
  { x: 22, yRadius: 2.73, zRadius: 2.95, yOffset: 1.65 },
  { x: 26, yRadius: 2.75, zRadius: 2.95, yOffset: 1.65 },
  // Forward of the cabin the deck HANDS THE CROWN OVER to the nose loft and
  // dies inside it by x = 30.7. Carrying it further forward is what put a
  // flight-deck capsule in a valley on the nose; see the note on NOSE_SECTIONS.
  // The crown falls 4.25, 3.95 across these stations and the nose picks it up
  // at 3.70, so the top line never steps.
  { x: 28, yRadius: 2.6, zRadius: 2.62, yOffset: 1.65 },
  { x: 29.2, yRadius: 2.25, zRadius: 2.2, yOffset: 1.7 },
  { x: 30.1, yRadius: 1.55, zRadius: 1.6, yOffset: 1.6 },
  { x: 30.7, yRadius: 0.55, zRadius: 0.65, yOffset: 1.15 },
];

/** Upper deck floor, 2.6 m above the main deck's and 2.25 m below the crown. */
const UPPER_DECK_FLOOR_Y = 1.95;

/**
 * Where a cabin window has to sit to be IN the skin, and how far the skin is
 * tilted there.
 *
 * 228 windows over a fuselage that tapers at both ends and a hump whose section
 * changes every metre cannot share one half-width; the forward-most main deck
 * pane is 0.4 m inboard of the mid-cabin one and the upper deck line moves
 * 0.6 m across its own run. Reading the answer off the loft sections costs
 * twelve lines and removes the whole class of "the windows float off the nose"
 * defect. Returns the outboard z of the skin at (x, y) and the angle its
 * outward normal makes with the horizontal, which is what lays each pane flat
 * on a curved flank instead of letting its corners stand proud.
 */
function skinPoint(
  sections: readonly LoftSection[],
  x: number,
  y: number,
): { z: number; tilt: number } {
  let low = sections[0]!;
  let high = sections[sections.length - 1]!;
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index]!.x >= x) {
      low = sections[index - 1]!;
      high = sections[index]!;
      break;
    }
  }
  const span = Math.max(1e-6, high.x - low.x);
  const t = Math.min(1, Math.max(0, (x - low.x) / span));
  const yRadius = alongPanel(low.yRadius, high.yRadius, t);
  const zRadius = alongPanel(low.zRadius, high.zRadius, t);
  const yOffset = alongPanel(low.yOffset ?? 0, high.yOffset ?? 0, t);
  const rise = (y - yOffset) / yRadius;
  const z = zRadius * Math.sqrt(Math.max(0, 1 - rise * rise));
  // Outward normal of an ellipse at that point, as (dy, dz).
  return { z, tilt: Math.atan2(rise / yRadius, z / (zRadius * zRadius)) };
}

/**
 * The cabin window line: 88 panes a side on the main deck and 26 a side on the
 * upper deck, in ONE draw call.
 *
 * TWO DECKS OF WINDOWS FORWARD is a 747 and nothing else has it, so the upper
 * run is not optional decoration. 0.56 m pitch against the real aeroplane's
 * 0.508: close enough that the line reads at its true density and 12% fewer
 * instances than drawing every frame bay.
 *
 * A BOX, not the Global's twelve-sided oval. The Global's windows are 0.58 m
 * tall and the largest in their class, and losing their shape would lose the
 * aeroplane; a 747's are 0.23 x 0.32 m rounded rectangles, and at the chase
 * camera's 112 m standoff their corner radius is a fraction of a pixel. Twelve
 * triangles each rather than forty-eight is 2,736 triangles for the whole line
 * instead of 10,944 — an eighth of this airframe's budget bought back for
 * something no camera in the game can resolve.
 */
const MAIN_DECK_WINDOW_COUNT = 88;
const MAIN_DECK_WINDOW_FORWARD_X = 24.2;
const MAIN_DECK_WINDOW_Y = 0.2;
const UPPER_DECK_WINDOW_COUNT = 26;
const UPPER_DECK_WINDOW_FORWARD_X = 28.6;
/** One metre above the upper deck floor: seated eye height on that deck. */
const UPPER_DECK_WINDOW_Y = UPPER_DECK_FLOOR_Y + 1;
const CABIN_WINDOW_PITCH = 0.56;

// ---------------------------------------------------------------------------
// ENGINES
// ---------------------------------------------------------------------------

/**
 * FOUR GEnx-2B67 on underwing pylons — 1,184 kN between them, which is the
 * `maxStaticThrust` the sim flies on.
 *
 * `spanZ` is the nacelle centreline. 11.7 and 21.8 are 34% and 64% of the
 * semi-span, which is where a 747 hangs them.
 *
 * `leadingGap` is how far the FAN COWL'S TRAILING EDGE sits ahead of the local
 * wing leading edge, and it is the whole reason the outboard pair looks
 * different from the inboard. The inboard cowl ends level with the leading
 * edge and only its core exhaust passes under the wing; the outboard pair sits
 * a further 1.5 m forward. `dropBelowWing` is how far the nacelle centreline
 * hangs under the local chord plane, and the outboard pair hangs a further
 * 0.25 m — so they sit LOWER relative to their own wing while sitting HIGHER
 * above the ground, which is what the dihedral does to them on the real wing.
 *
 * Both drops grew by half a metre when the sim's gear went from -5.2 to -6.4.
 * At the old ride height the inboard nacelle was pinned by the PAVEMENT — 1.24
 * m of drop left 0.35 m of clearance and no more — and it hung visibly closer
 * under the wing than a 747's does. With 1.2 m more leg the binding constraint
 * is the wing again: 1.80 m puts the fan nozzle's crown 0.50 m clear of the
 * chord plane at the leading edge, and still leaves 0.99 m of ground.
 */
const ENGINES = [
  { name: "inboard", spanZ: 11.7, leadingGap: 0, dropBelowWing: 1.8 },
  { name: "outboard", spanZ: 21.8, leadingGap: 1.5, dropBelowWing: 2.05 },
] as const;

/** Fan cowl: 3.4 m at its widest, 5.7 m from the inlet lip to the fan nozzle. */
const NACELLE_COWL_LENGTH = 5.7;
const NACELLE_CHEVRON_COUNT = 12;
/** Radius at the fan nozzle, where the chevrons are cut. */
const NACELLE_NOZZLE_RADIUS = 1.3;

// ---------------------------------------------------------------------------
// GEAR
// ---------------------------------------------------------------------------

/**
 * FIVE LEGS AND EIGHTEEN WHEELS, which is what the aeroplane has and what
 * `gearCycleRate: 0.1` in the sim is an apology for.
 *
 * The flight model carries three legs: two wing gears at (-3, -6.4, +/-6.3)
 * standing in for four bogies, and the nose at (22.6, -6.4, 0). Those three
 * are built at EXACTLY those contact points and are the ones the pose drives.
 * The body pair at x = -6.9, z = +/-1.9 is mesh only — it carries no contact
 * point, retracts with the rest and exists because a 747 with two main bogies
 * is missing the most-photographed thing under it.
 *
 * -6.4, not the -5.2 this file was first built against. At -5.2 the belly
 * fairing stood 1.60 m off the pavement — 2.2% of the aeroplane's length,
 * against 3.6% on the Global and 4.5% on the F-16 — and the rendered
 * gear-down frames showed the result: wheels tucked against the belly with
 * almost no leg, an aeroplane squatting rather than standing. The sim's table
 * now gives 2.80 m and the legs are 2.8 m and 2.6 m of visible strut.
 *
 * Node heights are the contact point RAISED BY THE TYRE'S OUTER RADIUS,
 * because the sim's y is where the rubber meets the pavement and a node is an
 * axle. Babylon's torus outer radius is diameter/2 + thickness/2, so the
 * 1.00/0.24 main tyre gives 0.62 — the radius `animation.ts` rolls the wheels
 * at — and 0.62 - 6.40 = -5.78. Everything else under here is derived from
 * these two constants, so the whole undercarriage followed the table down.
 */
/**
 * A 747 tyre is 49 x 19 inches: 1.24 m across the tread and 0.48 m WIDE, on a
 * 22-inch rim. Babylon's torus is described by the circle its tube sweeps, so
 * the numbers are worked back from the tyre rather than picked — tube
 * thickness is the outer radius minus the rim radius, and the swept diameter
 * is their sum. The first version used a 0.24 m tube, and with the gear
 * finally long enough to see, the ramp-level frames showed four hoops on a
 * stick instead of a bogie.
 */
const MAIN_TYRE_DIAMETER = 0.86;
const MAIN_TYRE_THICKNESS = 0.38;
const MAIN_AXLE_Y = -5.78;
const NOSE_TYRE_DIAMETER = 0.78;
const NOSE_TYRE_THICKNESS = 0.34;
const NOSE_AXLE_Y = -5.84;
/**
 * Half the bogie wheelbase, and half the track across one bogie. 1.10 m
 * between the two tyres on an axle, which with a 0.38 m tread leaves the gap
 * a 747's bogie actually has; at the old 1.32 m the pairs read as separate
 * wheels rather than as one bogie.
 */
const BOGIE_HALF_BASE = 0.8;
const BOGIE_HALF_TRACK = 0.55;

/**
 * `trunnionY` is where the leg leaves the airframe: the wing gear off the
 * wing's own lower surface at its rear spar, the body gear out of the belly
 * fairing. These are airframe stations and did not move when the contact table
 * dropped to -6.4; the legs simply grew by the 1.2 m, to 2.8 m and 1.8 m of
 * visible strut, which is what a leg this size should look like.
 */
const MAIN_BOGIES = [
  { name: "wing", x: -3, z: 6.3, trunnionY: -2.5, doorZ: 4.9, doorWidth: 3.6 },
  { name: "body", x: -6.9, z: 1.9, trunnionY: -3.45, doorZ: 0.9, doorWidth: 3 },
] as const;

export function createAirliner(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("boeing-747-8", scene);
  configureRoot(root, "airliner");

  // Two paint recipes, as the Global has. This airframe carries four times the
  // Global's painted area and each recipe costs three synthesized textures; an
  // airline scheme is a white shell with a coloured fin, engines and control
  // surfaces, so a third recipe would buy a distinction no camera angle in the
  // game can find.
  const body = build.paintMaterial("airliner-body", {
    seed: 0x7478_0001,
    baseColor: 0xf4f5f3,
    liveryColor: 0x1b3a6b,
    roughness: 0.31,
    metallic: 0.14,
    sootStrength: 0.3,
    wearStrength: 0.38,
    // The 64-pixel maps stretch over a 72 m fuselage — twice the Global's
    // reach, so the panel grid has to be weaker again or it reads as quilting.
    panelStrength: 0.34,
  });
  const accent = build.paintMaterial("airliner-accent", {
    seed: 0x7478_0002,
    baseColor: 0x1b3a6b,
    liveryColor: 0xd6462f,
    roughness: 0.34,
    metallic: 0.12,
    sootStrength: 0.44,
    wearStrength: 0.52,
    panelStrength: 0.5,
  });
  const dark = build.material("airliner-dark", 0x0d161c, {
    roughness: 0.28,
    metallic: 0.36,
  });
  const glass = build.material("airliner-glass", 0x14323f, {
    roughness: 0.04,
    metallic: 0,
    alpha: 0.29,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.02, indexOfRefraction: 1.5 },
    transmission: {
      indexOfRefraction: 1.52,
      minimumThickness: 0.005,
      maximumThickness: 0.016,
      tintColor: 0xa9dae6,
      tintColorAtDistance: 3.4,
    },
  });
  /*
   * No depth pre-pass on the glazing. `build.material` turns
   * `needDepthPrePass` on for every alpha-blended airframe material, which is
   * right for the propeller disc it was written for and wrong for glass: at
   * cinematic distance it suppresses the colour pass outright while leaving it
   * intact close up. That is what made the F-16's canopy invisible for four
   * rounds, and the Cessna's 2.94 m cabin glazing was losing its glass the
   * same way — captured before and after, the cabin went from a bare shell
   * with the interior showing through to a properly glazed canopy.
   *
   * This aeroplane's glazing is small enough that the loss is hard to see, so
   * it is fixed on the MECHANISM rather than on a photograph: the suppression
   * is a function of camera distance, not of how big the pane is, and leaving
   * known-broken glass on an airframe because it is inconspicuous is not a
   * reason to leave it. Scoped to this material; `builders.ts` is untouched.
   */
  glass.needDepthPrePass = false;
  const tire = build.material("airliner-tire", 0x06080a, { roughness: 1, metallic: 0 });
  const hub = build.material("airliner-hub", 0x8b9498, { roughness: 0.32, metallic: 0.74 });
  const hotMetal = build.material("airliner-hot-metal", 0x4b5153, {
    roughness: 0.24,
    metallic: 0.9,
    emissive: 0x2c1109,
    emissiveIntensity: 0.4,
  });
  const interior = build.material("airliner-interior", 0x1a2328, {
    roughness: 0.82,
    metallic: 0.02,
  });
  const instrumentFace = build.material("airliner-instrument-face", 0x050a0d, {
    roughness: 0.7,
    metallic: 0.05,
  });
  const instrumentMarking = build.material("airliner-instrument-marking", 0x9fd9e8, {
    roughness: 0.34,
    metallic: 0,
    emissive: 0x4ba8c6,
    emissiveIntensity: 0.7,
  });

  // The same six lamps and the same two appliers as the other three airframes.
  const applyLamp = createLampApplier();
  const applyGlow = createGlowApplier();
  const redLamp = build.material("airliner-port-lamp", 0xff493d, {
    emissive: 0xff2018, emissiveIntensity: 2.4,
  });
  const greenLamp = build.material("airliner-starboard-lamp", 0x5dffab, {
    emissive: 0x24ff83, emissiveIntensity: 2.4,
  });
  const tailLamp = build.material("airliner-tail-lamp", 0xfff6e8, {
    emissive: 0xfff2d8, emissiveIntensity: 2.4,
  });
  const beaconLamp = build.material("airliner-beacon-lamp", 0xff5a4a, {
    emissive: 0xff1c10, emissiveIntensity: 3,
  });
  const strobeLamp = build.material("airliner-strobe-lamp", 0xffffff, {
    emissive: 0xf2f8ff, emissiveIntensity: 3.6,
  });
  const landingLamp = build.material("airliner-landing-lamp", 0xfff1c2, {
    emissive: 0xffe6a8, emissiveIntensity: 2.6,
  });

  // 72 m from radome to tailcone, in four lofts: the parallel barrel, the
  // upswept tailcone, the drooped radome and the upper deck riding on top.
  const fuselage = build.loft("airliner-fuselage", FUSELAGE_SECTIONS, 28, body, root);
  const radome = build.loft("airliner-radome", NOSE_SECTIONS, 24, body, root);
  const upperDeck = build.loft("airliner-upper-deck", HUMP_SECTIONS, 20, body, root);
  // Upswept, ending at (-38, +1.2) where the sim puts its tailcone contact
  // point. The upsweep is what buys a 72 m aeroplane its rotation angle: the
  // mains are at x = -3, so 10.4 degrees of tail-strike margin comes entirely
  // from how fast this cone climbs.
  build.loft(
    "airliner-tailcone",
    [
      { x: -38, yRadius: 0.4, zRadius: 0.34, yOffset: 1.2 },
      { x: -36, yRadius: 0.88, zRadius: 0.78, yOffset: 1.16 },
      { x: -33, yRadius: 1.58, zRadius: 1.48, yOffset: 1.02 },
      { x: -30, yRadius: 2.26, zRadius: 2.18, yOffset: 0.74 },
      { x: -27.5, yRadius: 2.82, zRadius: 2.78, yOffset: 0.38 },
      { x: -25, yRadius: 3.2, zRadius: 3.2, yOffset: 0.08 },
    ],
    22,
    body,
    root,
  );
  // The wing-to-body fairing, 9.4 m across at its widest — wider than the
  // fuselage itself, because it houses the centre wing box, the centre tank and
  // the two body gear bays. Its underside holds at -3.60, which is where the
  // sim puts its belly contact point, so a belly landing touches the metal it
  // says it touches. It also has to reach z = 3.25 at the wing's own chord
  // plane along the whole root chord or the root rib stands out in the open.
  build.loft(
    "airliner-belly-fairing",
    [
      { x: -17.5, yRadius: 0.4, zRadius: 1.4, yOffset: -2.95 },
      { x: -15, yRadius: 0.8, zRadius: 2.6, yOffset: -2.7 },
      { x: -11, yRadius: 1.25, zRadius: 3.9, yOffset: -2.3 },
      { x: -6, yRadius: 1.55, zRadius: 4.7, yOffset: -2.05 },
      { x: 0, yRadius: 1.55, zRadius: 4.7, yOffset: -2.05 },
      { x: 5, yRadius: 1.35, zRadius: 4.4, yOffset: -2.25 },
      { x: 10.5, yRadius: 0.95, zRadius: 3.3, yOffset: -2.62 },
      { x: 14.5, yRadius: 0.55, zRadius: 1.8, yOffset: -3 },
    ],
    20,
    body,
    root,
  );
  // The beacon blister. `AIRLINER_WASH` puts the lower anticollision light at
  // y = -4.1 and the fairing above bottoms out at -3.60, so without this the
  // lamp floats half a metre clear of the skin — the exact defect the Global's
  // table was corrected for. The real aeroplane carries the beacon in a
  // streamlined housing below the fairing, so the fix is its own part rather
  // than moving the fairing down through the sim's contact point.
  build.loft(
    "airliner-beacon-fairing",
    [
      { x: -2.2, yRadius: 0.18, zRadius: 0.3, yOffset: -3.85 },
      { x: -0.9, yRadius: 0.42, zRadius: 0.58, yOffset: -3.83 },
      { x: 0.9, yRadius: 0.45, zRadius: 0.6, yOffset: -3.8 },
      { x: 2.2, yRadius: 0.2, zRadius: 0.32, yOffset: -3.7 },
    ],
    12,
    body,
    root,
  );

  // The window line. One box, thin-instanced 228 times; the instance matrix is
  // the ENTIRE transform and the base mesh keeps an identity one, because thin
  // instance matrices multiply into the mesh's own world matrix and splitting
  // the arrangement across both is how it becomes unreadable.
  const cabinWindow = build.box("airliner-cabin-window-line", 0.25, 0.36, 0.1, dark, root);
  {
    const matrices = new Float32Array((MAIN_DECK_WINDOW_COUNT + UPPER_DECK_WINDOW_COUNT) * 2 * 16);
    const unit = Vector3.One();
    let offset = 0;
    for (const side of [1, -1] as const) {
      for (const deck of [
        {
          sections: FUSELAGE_SECTIONS,
          count: MAIN_DECK_WINDOW_COUNT,
          forwardX: MAIN_DECK_WINDOW_FORWARD_X,
          y: MAIN_DECK_WINDOW_Y,
        },
        {
          sections: HUMP_SECTIONS,
          count: UPPER_DECK_WINDOW_COUNT,
          forwardX: UPPER_DECK_WINDOW_FORWARD_X,
          y: UPPER_DECK_WINDOW_Y,
        },
      ]) {
        for (let index = 0; index < deck.count; index += 1) {
          const x = deck.forwardX - index * CABIN_WINDOW_PITCH;
          const skin = skinPoint(deck.sections, x, deck.y);
          Matrix.Compose(
            unit,
            // The pane's face is its local Z. Turning it by the skin's own
            // tilt lays it along the flank instead of letting the upper
            // corners of an upper-deck window stand off a curving roof. The
            // box is symmetric through z, so the port side takes the mirrored
            // angle rather than a second half-turn.
            Quaternion.RotationYawPitchRoll(0, -side * skin.tilt, 0),
            new Vector3(x, deck.y, side * skin.z),
          ).copyToArray(matrices, offset);
          offset += 16;
        }
      }
    }
    cabinWindow.thinInstanceSetBuffer("matrix", matrices, 16, true);
    cabinWindow.thinInstanceRefreshBoundingInfo(true);
  }

  const wingSurfaces: AbstractMesh[] = [];
  const flaps: TransformNode[] = [];
  const speedBrakes: TransformNode[] = [];

  // STARBOARD IS BODY +Z. Every side loop in this file runs [1, -1] and calls
  // +1 starboard, so the name and the sign cannot drift apart the way they did
  // on the two oldest airframes — where `side < 0 ? "starboard" : "port"` put
  // the starboard wing at -Z and the ailerons answered the wrong command for
  // months. `tests/render.webgpu-control-surface-sides.test.ts` measures this
  // in world space, but the loop should be right without the test.
  //
  // THE DIHEDRAL is why each panel gets a node of its own rather than being
  // positioned directly. `airfoilWing` builds flat — it has no dihedral — so
  // each panel is built in its own root's coordinates and the node is rolled
  // about body X. A positive rotation about +X carries +Z DOWNWARD, so raising
  // both tips is `-side * angle`. The panel is built SPAN-LONG rather than
  // reach-long (hypot of the rise and the reach) and the angle is the atan2 of
  // the same two legs, so the tip lands exactly on its station instead of
  // cos(dihedral) short of it — the discipline the Global's winglet uses.
  const wingPanels = [
    {
      name: "inboard",
      rootZ: WING_ROOT_Z,
      tipZ: WING_KINK_Z,
      rootY: WING_ROOT_Y,
      tipY: WING_KINK_Y,
      rootLeadingX: WING_ROOT_LEADING_X,
      rootTrailingX: WING_ROOT_HINGE_X,
      tipLeadingX: WING_KINK_LEADING_X,
      tipTrailingX: WING_KINK_HINGE_X,
      thickness: WING_INBOARD_THICKNESS,
      spanSegments: 3,
    },
    {
      name: "outboard",
      rootZ: WING_KINK_Z,
      tipZ: WING_RAKE_Z,
      rootY: WING_KINK_Y,
      tipY: WING_RAKE_Y,
      rootLeadingX: WING_KINK_LEADING_X,
      rootTrailingX: WING_KINK_HINGE_X,
      tipLeadingX: WING_RAKE_LEADING_X,
      tipTrailingX: WING_RAKE_HINGE_X,
      thickness: WING_OUTBOARD_THICKNESS,
      spanSegments: 4,
    },
    {
      // The raked tip carries no control surface, so both of its panels run
      // leading edge to TRUE trailing edge rather than stopping at the hinge.
      name: "rake-inner",
      rootZ: WING_RAKE_Z,
      tipZ: WING_RAKE_OUTER_Z,
      rootY: WING_RAKE_Y,
      tipY: WING_RAKE_OUTER_Y,
      rootLeadingX: WING_RAKE_LEADING_X,
      rootTrailingX: WING_RAKE_TRAILING_X,
      tipLeadingX: WING_RAKE_OUTER_LEADING_X,
      tipTrailingX: WING_RAKE_OUTER_TRAILING_X,
      thickness: 0.085,
      spanSegments: 2,
    },
    {
      name: "rake-outer",
      rootZ: WING_RAKE_OUTER_Z,
      tipZ: WING_TIP_Z,
      rootY: WING_RAKE_OUTER_Y,
      tipY: WING_TIP_Y,
      rootLeadingX: WING_RAKE_OUTER_LEADING_X,
      rootTrailingX: WING_RAKE_OUTER_TRAILING_X,
      tipLeadingX: WING_TIP_LEADING_X,
      tipTrailingX: WING_TIP_TRAILING_X,
      thickness: 0.075,
      spanSegments: 2,
    },
  ] as const;

  /** A node on the wing's own surface, rolled to the local dihedral. */
  function wingHinge(
    name: string,
    side: 1 | -1,
    z: number,
    x: number,
    y: number,
  ): TransformNode {
    const hinge = node(name, root, scene);
    hinge.position.set(x, y, side * z);
    hinge.rotation.x = -side * (insideKink(z)
      ? Math.atan2(WING_KINK_Y - WING_ROOT_Y, WING_KINK_Z - WING_ROOT_Z)
      : Math.atan2(WING_RAKE_Y - WING_KINK_Y, WING_RAKE_Z - WING_KINK_Z));
    return hinge;
  }

  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const panel of wingPanels) {
      const reach = panel.tipZ - panel.rootZ;
      const rise = panel.tipY - panel.rootY;
      const anchor = node(`${sideName}-airliner-${panel.name}-wing-root`, root, scene);
      anchor.position.set(0, panel.rootY, side * panel.rootZ);
      anchor.rotation.x = -side * Math.atan2(rise, reach);
      wingSurfaces.push(build.airfoilWing(
        `${sideName}-airliner-${panel.name}-wing`,
        {
          rootLeadingX: panel.rootLeadingX,
          rootTrailingX: panel.rootTrailingX,
          tipLeadingX: panel.tipLeadingX,
          tipTrailingX: panel.tipTrailingX,
          rootZ: 0,
          tipZ: side * Math.hypot(reach, rise),
          thicknessRatio: panel.thickness,
          camberRatio: WING_CAMBER,
          chordSegments: 14,
          spanSegments: panel.spanSegments,
        },
        body,
        anchor,
      ));
    }
  }

  // Triple-slotted Fowler flaps, two panels a side as the aeroplane has them:
  // one inboard of the inboard engine, one between the engines. The sim leans
  // on these harder than on any other airframe's — `flapLift: 1.1` is what
  // brings 250 tonnes inside an 855 m take-off roll — so they are real panels
  // on real hinges.
  //
  // Each hinge node sits ON the hinge line at the panel's inboard end, rolled
  // to the local dihedral, and the panel is parented to it in local
  // coordinates. Babylon composes local rotation as yaw, then pitch, then
  // ROLL INNERMOST, so `applyCommonPose` setting `rotation.z` hinges the panel
  // in the wing's own plane and the dihedral this node already carries
  // survives untouched.
  const flapPanels = [
    // Tip stations sized to leave 0.5 m of fixed trailing edge before the
    // aileron rather than the 1.7 m the first version left, which showed in
    // the plan view as a notch cut out of the wing between the two surfaces.
    { name: "inner", rootZ: 4.4, tipZ: 11.9 },
    { name: "outer", rootZ: 16.6, tipZ: 23.1 },
  ] as const;
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const flap of flapPanels) {
      const hingeX = hingeAt(flap.rootZ);
      const hinge = wingHinge(
        `${sideName}-airliner-${flap.name}-flap`,
        side,
        flap.rootZ,
        hingeX,
        chordPlaneAt(flap.rootZ),
      );
      const surface = build.airfoilWing(
        `${sideName}-airliner-${flap.name}-flap-surface`,
        {
          rootLeadingX: 0,
          rootTrailingX: trailingAt(flap.rootZ) - hingeX,
          tipLeadingX: hingeAt(flap.tipZ) - hingeX,
          tipTrailingX: trailingAt(flap.tipZ) - hingeX,
          rootZ: 0,
          tipZ: side * (flap.tipZ - flap.rootZ),
          thicknessRatio: 0.07,
          camberRatio: 0.014,
          chordSegments: 8,
          spanSegments: 2,
        },
        // BODY paint, not the accent the Global puts on its control surfaces.
        // A corporate scheme colours flaps and ailerons; an airline's wing is
        // one white surface from root to tip, and painting eight panels in the
        // livery colour turned the plan view into stripes.
        body,
        hinge,
      );
      flaps.push(hinge);
      wingSurfaces.push(surface);
    }

    // SPOILERS, on the upper surface just ahead of the hinge line. Five a side
    // — the 747 carries six, and the sixth lives where the inboard aileron is
    // on this model. `speedBrakeDrag: 0.1` is entirely these panels; there is
    // no fuselage airbrake on a transport.
    //
    // Wing-coloured and FLUSH. Standing them proud in the accent paint makes
    // them read as hazard decals stuck on the wing rather than as the wing's
    // own skin, which is the note Jason left on the Global's first version.
    // Each one sits on the SWEPT hinge line and at its own station's upper
    // surface, so its aft edge meets the flap it lives in front of at every
    // station rather than only at one.
    for (const spoiler of [
      { name: "one", z: 6.6, span: 2.3, chord: 1.9 },
      { name: "two", z: 9.3, span: 2.3, chord: 1.7 },
      { name: "three", z: 18.2, span: 2.6, chord: 1.3 },
      { name: "four", z: 21.4, span: 2.6, chord: 1.2 },
      { name: "five", z: 24.6, span: 2.6, chord: 1.1 },
    ]) {
      // The node is the panel's FORWARD edge and its hinge, so it stands one
      // chord ahead of the flap hinge line and the panel reaches back to it.
      const brake = wingHinge(
        `${sideName}-airliner-${spoiler.name}-spoiler`,
        side,
        spoiler.z,
        hingeAt(spoiler.z) + spoiler.chord,
        upperSurfaceY(spoiler.z),
      );
      const panel = build.box(
        `${brake.name}-surface`,
        spoiler.chord,
        // 45 mm: thick enough to catch a highlight along its edge, thin enough
        // to be a panel line rather than a step.
        0.045,
        spoiler.span,
        body,
        brake,
      );
      // Hinged at its forward edge, so the panel lies entirely aft of the node
      // and a negative pose angle lifts its trailing edge into the air.
      panel.position.x = -spoiler.chord * 0.5;
      speedBrakes.push(brake);
    }
  }

  /**
   * An aileron: a hinge node on the wing's surface and one surface behind it.
   * Four of them on this aeroplane, two inboard and two outboard, so the
   * arrangement is written once. STARBOARD IS +Z and the tuples below are
   * starboard-first, because `applyCommonPose` drives `ailerons[0]` with the
   * starboard deflection and nothing downstream checks the name.
   */
  function buildAileron(
    label: string,
    side: 1 | -1,
    rootZ: number,
    tipZ: number,
  ): TransformNode {
    const hingeX = hingeAt(rootZ);
    const hinge = wingHinge(
      side > 0 ? `starboard-${label}` : `port-${label}`,
      side,
      rootZ,
      hingeX,
      chordPlaneAt(rootZ),
    );
    wingSurfaces.push(build.airfoilWing(
      side > 0 ? `starboard-${label}-surface` : `port-${label}-surface`,
      {
        rootLeadingX: 0,
        rootTrailingX: trailingAt(rootZ) - hingeX,
        tipLeadingX: hingeAt(tipZ) - hingeX,
        tipTrailingX: trailingAt(tipZ) - hingeX,
        rootZ: 0,
        tipZ: side * (tipZ - rootZ),
        thicknessRatio: 0.065,
        chordSegments: 8,
        spanSegments: 2,
      },
      // Body paint, for the reason the flaps carry it.
      body,
      hinge,
    ));
    return hinge;
  }

  // The OUTBOARD pair carry the names the world-space side test looks for.
  // They stop at z = 28.2, inboard of the raked tip: a 747 carries no control
  // surface out on the rake and the hinge line is not defined past the break.
  const starboardAileron = buildAileron("aileron", 1, 23.6, 28.2);
  const portAileron = buildAileron("aileron", -1, 23.6, 28.2);
  // The inboard pair are the low-speed ailerons, between the two flap
  // sections. They are not in the common rig's two-element tuple, so `update`
  // drives them from the same pose fields below — a 747 whose inboard
  // ailerons sat still while the outboard ones worked would look broken at
  // exactly the speeds the player flies it at.
  const starboardInboardAileron = buildAileron("inboard-aileron", 1, 12.4, 16.0);
  const portInboardAileron = buildAileron("inboard-aileron", -1, 12.4, 16.0);

  // FLAP TRACK CANOES. Not decoration on this type: Fowler tracks long enough
  // to move a 4.5 m flap aft as well as down will not fit inside an 11%
  // section, so the aeroplane wears them externally and they are the most
  // visible thing under the wing from the chase camera. Ten of one shape, so
  // one tapered fairing thin-instanced ten times — 640 triangles in a single
  // draw call rather than ten of them.
  const flapCanoe = build.loft(
    "airliner-flap-track-canoe",
    [
      { x: -1.8, yRadius: 0.14, zRadius: 0.12 },
      { x: -0.6, yRadius: 0.38, zRadius: 0.32 },
      { x: 0.9, yRadius: 0.3, zRadius: 0.26 },
      { x: 2, yRadius: 0.08, zRadius: 0.08 },
    ],
    8,
    body,
    root,
  );
  {
    const canoeStations = [
      { z: 5.6, scale: 1.25 },
      { z: 9.6, scale: 1.15 },
      { z: 17.8, scale: 1 },
      { z: 22.2, scale: 0.9 },
    ] as const;
    const matrices = new Float32Array(canoeStations.length * 2 * 16);
    let offset = 0;
    for (const side of [1, -1] as const) {
      for (const station of canoeStations) {
        Matrix.Compose(
          new Vector3(station.scale, station.scale, station.scale),
          // Rolled to the local dihedral so the canoe lies along the wing
          // rather than crossing it, exactly as the hinges are.
          Quaternion.RotationYawPitchRoll(0, -side * (insideKink(station.z)
            ? Math.atan2(WING_KINK_Y - WING_ROOT_Y, WING_KINK_Z - WING_ROOT_Z)
            : Math.atan2(WING_RAKE_Y - WING_KINK_Y, WING_RAKE_Z - WING_KINK_Z)), 0),
          new Vector3(
            hingeAt(station.z) + 0.5,
            lowerSurfaceY(station.z) - 0.22 * station.scale,
            side * station.z,
          ),
        ).copyToArray(matrices, offset);
        offset += 16;
      }
    }
    flapCanoe.thinInstanceSetBuffer("matrix", matrices, 16, true);
    flapCanoe.thinInstanceRefreshBoundingInfo(true);
  }

  // ------------------------------------------------------------------ TAIL --
  //
  // A CONVENTIONAL TAIL: one fin, one tailplane, both on the tailcone. The
  // Global's T-tail is the other family entirely, and putting this tailplane
  // on top of the fin would be a different aeroplane.
  //
  // The fin is a four-point trapezoid; the profile builder fans its outline
  // from the first vertex, so the points are ordered leading-base,
  // trailing-base, trailing-tip, leading-tip to stay convex.
  //
  // The tip is at y = 13.0, which with the gear at -6.4 is exactly the type's
  // published 19.40 m of overall height, and it is where `sim/aircraft.ts`
  // puts its fin-tip contact point. It was 14.2 while the wheels were at -5.2;
  // ground-to-fin-tip is wheels-to-CG plus CG-to-fin, so when the gear went
  // down 1.2 m the fin had to come down by exactly the same 1.2 m to keep the
  // aeroplane the height it is.
  //
  // The 1.2 m came out of the HEIGHT, not the planform: the tip chord stays at
  // 4.4 m and the leading edge takes the whole change, going from 47.5 to 49.0
  // degrees. Lowering the tip while holding the old x values would have left a
  // 5.1 m tip chord on a shorter fin, which is a different aeroplane's tail.
  // -31.9 to -36.3 straddles the (-33, 13.0) contact point.
  const fin = build.verticalProfile(
    "airliner-vertical-stabilizer",
    [
      { x: -20.5, y: 3.1 },
      { x: -31.5, y: 3.1 },
      { x: -36.3, y: 13 },
      { x: -31.9, y: 13 },
    ],
    1.3,
    body,
    root,
  );
  wingSurfaces.push(fin);
  // The dorsal fillet ahead of the fin root. Its aft-top corner lands ON the
  // fin's leading edge at y = 5.3, so the two meet instead of overlapping into
  // a step, and its aft face is buried inside the fin's own thickness.
  build.verticalProfile(
    "airliner-dorsal-fin",
    [
      { x: -14.5, y: 3.05 },
      { x: -23, y: 3.05 },
      { x: -23, y: 5.3 },
    ],
    0.85,
    body,
    root,
  );

  const rudder = node("rudder", root, scene);
  rudder.position.set(-31.4, 3.15, 0);
  // 0.8 m thick against the fin's 1.3: the section tapers aft, and a rudder as
  // thick as its own swing would make "which way did the trailing edge go"
  // ambiguous — the side test reads the aftmost vertex, and at 0.22 rad this
  // panel travels 0.64 m.
  // 9.4 m rather than the fin's own 9.9 m of height: the panel is tilted on to
  // the hinge line below, which swings its top corner 0.16 m further up, and a
  // full-height panel would put that corner through the fin tip and make the
  // aeroplane taller than its own fin.
  const rudderSurface = build.box("rudder-surface", 2.9, 9.4, 0.8, accent, rudder);
  rudderSurface.position.set(-1.5, 4.95, 0);
  // The fin's trailing edge leans 4.8 m aft over its 9.9 m of height, which is
  // 4.56 m across the panel's own 9.4 m. A box cannot be swept, so the panel
  // is tilted to sit ON that line instead of crossing it: its aft-top corner
  // lands within 2 cm of the fin's tip trailing edge and its forward edge
  // stays buried inside the fin's 1.3 m thickness. Applied to the CHILD,
  // because the node's own Y rotation is the rudder deflection the pose owns
  // every frame.
  rudderSurface.rotation.z = Math.atan2(4.56, 9.4);

  // Tailplane on the tailcone at y = +1.2, 22.5 m span, 32 degrees of sweep.
  // Its root rib at |z| = 1.8 is inside the tailcone's own 2.0 m half-width at
  // that station, so there is no slot down either side of the fuselage.
  const TAILPLANE_Y = 1.2;
  const TAILPLANE_ROOT_Z = 1.8;
  const TAILPLANE_TIP_Z = 11.25;
  const ELEVATOR_HINGE_X = -32.45;
  const ELEVATOR_TIP_HINGE_X = -34.37;
  for (const side of [1, -1] as const) {
    const tailplane = build.airfoilWing(
      side > 0 ? "starboard-airliner-tailplane" : "port-airliner-tailplane",
      {
        rootLeadingX: -26.5,
        rootTrailingX: ELEVATOR_HINGE_X,
        tipLeadingX: -32.41,
        tipTrailingX: ELEVATOR_TIP_HINGE_X,
        rootZ: side * TAILPLANE_ROOT_Z,
        tipZ: side * TAILPLANE_TIP_Z,
        thicknessRatio: 0.1,
        chordSegments: 10,
        spanSegments: 3,
      },
      body,
      root,
    );
    tailplane.position.y = TAILPLANE_Y;
    wingSurfaces.push(tailplane);
  }

  const elevator = node("elevator", root, scene);
  elevator.position.set(ELEVATOR_HINGE_X, TAILPLANE_Y, 0);
  for (const side of [1, -1] as const) {
    // These two names are what the control-surface side test looks for on
    // every airframe that is not the sport jet or the Global.
    wingSurfaces.push(build.airfoilWing(
      side > 0 ? "starboard-elevator-surface" : "port-elevator-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: -2.55,
        tipLeadingX: ELEVATOR_TIP_HINGE_X - ELEVATOR_HINGE_X,
        tipTrailingX: -35.21 - ELEVATOR_HINGE_X,
        rootZ: side * TAILPLANE_ROOT_Z,
        tipZ: side * TAILPLANE_TIP_Z,
        thicknessRatio: 0.07,
        chordSegments: 8,
        spanSegments: 2,
      },
      accent,
      elevator,
    ));
  }

  // ---------------------------------------------------------- FLIGHT DECK --
  //
  // ON THE UPPER DECK, above and forward: floor at y = +1.95, 2.45 m of
  // headroom under a crown at 4.40, and 7.15 m above the pavement. Everything
  // else about a 747's nose follows from the flight deck being a storey higher
  // than the cabin behind it.
  //
  // The glass goes through `build.material`'s alpha path, which moves these
  // meshes into the airframe-transparency rendering group: drawn before the
  // water, their depth pre-pass cuts a hole in the sea behind them, and that
  // is a defect this renderer has shipped before.
  // THREE PANES A SIDE, wrapped around the nose on the skin itself.
  //
  // The first version put a single flat windscreen box on the centreline at
  // y = 3.0, and it never appeared in a rendered frame: at that station the
  // upper deck's skin is at y = 3.6, so the whole pane was sealed inside the
  // loft. A pane on a rounded nose has to be PLACED ON the surface, not near
  // it, which is what `skinPoint` is for — the same call that puts 228 cabin
  // windows in their skin. Each pane is 0.12 m thick and centred on the
  // surface, so exactly half of it stands proud and the glass reads.
  //
  // Both angles are read off the skin rather than chosen: the pitch lays the
  // pane against the flank's curvature, and the yaw follows the nose's taper,
  // measured across the pane's own length. Without the yaw the forward corner
  // of the No.1 window stands 0.15 m off a flank that is narrowing 0.5 m per
  // metre right there.
  const flightDeckWindows = [
    { name: "one", x: 31.35, y: 2.88, length: 0.95, height: 0.7 },
    { name: "two", x: 30.4, y: 2.95, length: 0.9, height: 0.64 },
    { name: "three", x: 29.5, y: 2.95, length: 0.8, height: 0.58 },
  ] as const;
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const pane of flightDeckWindows) {
      const glazing = build.box(
        `${sideName}-airliner-flight-deck-window-${pane.name}`,
        pane.length,
        pane.height,
        0.12,
        glass,
        root,
      );
      // NOSE_SECTIONS, not the upper deck's: forward of x = 30 the deck has
      // already died inside the nose and the flight deck is the top of the
      // nose's own section. Reading the upper deck's skin here would put the
      // glass back inside the metal, which is the defect this loop exists for.
      const half = pane.length * 0.5;
      const forward = skinPoint(NOSE_SECTIONS, pane.x + half, pane.y);
      const aft = skinPoint(NOSE_SECTIONS, pane.x - half, pane.y);
      const skin = skinPoint(NOSE_SECTIONS, pane.x, pane.y);
      glazing.position.set(pane.x, pane.y, side * skin.z);
      glazing.rotation.y = side * Math.atan2(aft.z - forward.z, pane.length);
      glazing.rotation.x = -side * skin.tilt;
      glazing.metadata = { ...glazing.metadata, castsShadow: false };
    }
  }
  // The centre post, laid along the nose's crown line between the two No.1
  // panes. Its endpoints are the crown height at those two stations, so it
  // sits half in the skin instead of floating over it.
  const windscreenFrame = build.strutBetween(
    "airliner-windscreen-center-post",
    new Vector3(31.9, 2.73, 0),
    new Vector3(31.2, 3.23, 0),
    0.09,
    dark,
    root,
  );

  for (const side of [1, -1] as const) {
    const seat = build.box(
      side > 0 ? "airliner-captain-seat" : "airliner-first-officer-seat",
      0.62,
      0.8,
      0.58,
      interior,
      root,
    );
    seat.position.set(29, 2.38, side * 0.72);
    seat.rotation.z = -0.07;
    seat.metadata = { ...seat.metadata, cockpitInterior: true, castsShadow: false };
    const headrest = build.box(
      side > 0 ? "airliner-captain-headrest" : "airliner-first-officer-headrest",
      0.24,
      0.4,
      0.46,
      interior,
      root,
    );
    headrest.position.set(28.58, 2.86, side * 0.72);
    headrest.metadata = { ...headrest.metadata, cockpitInterior: true, castsShadow: false };
  }
  // Panel centred at y = 2.63 and 0.54 m tall, so its top edge is 2.90 — see
  // the catalogue note on where that puts the eye point.
  addInstrumentPanel(
    build,
    "airliner",
    root,
    29.95,
    2.63,
    2.4,
    interior,
    instrumentFace,
    instrumentMarking,
  );

  // ------------------------------------------------------------- ENGINES ---
  const fanSpools: TransformNode[] = [];
  const chevronMatrices = new Float32Array(ENGINES.length * 2 * NACELLE_CHEVRON_COUNT * 16);
  let chevronOffset = 0;
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const engine of ENGINES) {
      const z = side * engine.spanZ;
      const nozzleX = leadingAt(engine.spanZ) + engine.leadingGap;
      const inletX = nozzleX + NACELLE_COWL_LENGTH;
      const centreY = chordPlaneAt(engine.spanZ) - engine.dropBelowWing;
      const prefix = `${sideName}-airliner-${engine.name}-engine`;

      build.loft(
        `${prefix}-nacelle`,
        [
          { x: nozzleX, yRadius: NACELLE_NOZZLE_RADIUS, zRadius: NACELLE_NOZZLE_RADIUS,
            yOffset: centreY, zOffset: z },
          { x: inletX - 4.3, yRadius: 1.68, zRadius: 1.68, yOffset: centreY, zOffset: z },
          { x: inletX - 2.1, yRadius: 1.7, zRadius: 1.7, yOffset: centreY, zOffset: z },
          { x: inletX - 0.75, yRadius: 1.66, zRadius: 1.66, yOffset: centreY, zOffset: z },
          { x: inletX, yRadius: 1.44, zRadius: 1.44, yOffset: centreY, zOffset: z },
        ],
        20,
        body,
        root,
      );
      // The core cowl and exhaust plug, reaching 1.75 m aft of the fan nozzle
      // and covering the nacelle loft's own aft cap on the way through.
      build.loft(
        `${prefix}-core`,
        [
          { x: nozzleX - 1.75, yRadius: 0.35, zRadius: 0.35, yOffset: centreY, zOffset: z },
          { x: nozzleX - 1.1, yRadius: 0.66, zRadius: 0.66, yOffset: centreY, zOffset: z },
          { x: nozzleX - 0.4, yRadius: 0.95, zRadius: 0.95, yOffset: centreY, zOffset: z },
          { x: nozzleX + 0.3, yRadius: 1.22, zRadius: 1.22, yOffset: centreY, zOffset: z },
        ],
        16,
        hotMetal,
        root,
      );
      // THE INTAKE, and the first version did not have one. `loft` closes its
      // forward section with a flat painted cap, so a nacelle built from a
      // loft alone is a white egg: the head-on frame showed four of them with
      // no hole at all. The fix is a dark duct whose own forward face sits
      // 0.04 m PROUD of that cap and 0.06 m inside the cowl's lip radius, so
      // what the eye gets is a thin bright lip ring around a dark opening.
      // Tapering it inward from 2.76 to 2.40 gives the opening a shaded wall
      // rather than a flat disc.
      const inlet = build.cylinder(`${prefix}-inlet`, 1.3, 2.4, 2.76, 20, dark, root);
      inlet.rotation.z = Math.PI / 2;
      inlet.position.set(inletX - 0.61, centreY, z);

      // THE PYLON, and it has to be visible. The first version topped out at
      // centreline + 1.62 against a nacelle 1.70 in radius, so it was inside
      // the cowl over its whole length and the rendered engines appeared to
      // hang off nothing. It now stands 0.25 m proud of the cowl as a dorsal
      // ridge and, more importantly, reaches 1.6 m AFT of the fan nozzle,
      // where there is no cowl and it shows as the wedge between the engine
      // and the wing. Its top edge runs INTO the wing rather than up to it,
      // which is where a pylon's upper spar actually attaches.
      //
      // Its top edge is read off the WING rather than offset from the nacelle,
      // because the two engines hang at different depths and a fixed offset
      // that buries the inboard pylon 0.6 m into the wing leaves the outboard
      // one 6 mm short of touching it. `lowerSurfaceY + 0.5` penetrates both
      // by the same half metre.
      const pylonTopY = lowerSurfaceY(engine.spanZ) + 0.5;
      const pylon = build.verticalProfile(
        `${prefix}-pylon`,
        [
          { x: inletX - 2, y: pylonTopY },
          { x: nozzleX - 1.6, y: pylonTopY },
          { x: nozzleX - 1, y: centreY + 0.3 },
          { x: inletX - 2.4, y: centreY + 0.3 },
        ],
        1.25,
        body,
        root,
      );
      pylon.position.z = z;

      // The rotating assembly: the fan and the spool behind it. The node spins
      // about body X through its OWN origin, which is why each fan gets a node
      // at its own centreline rather than one node at the aircraft centreline
      // — that one would swing all four fans around the fuselage.
      // 0.03 m ahead of the dark duct's face, so the fan is what shows through
      // the opening with a 0.33 m dark annulus around it — a 2.66 m fan set
      // inside a 3.4 m cowl, which is the GEnx's proportion. Any further back
      // and the duct's own cap hides it; a solid cylinder has no open end.
      const spool = node(`${prefix}-fan-spool`, root, scene);
      spool.position.set(inletX + 0.07, centreY, z);
      const fanFace = build.cylinder(`${spool.name}-fan`, 0.1, 2.02, 2.1, 16, hub, spool);
      fanFace.rotation.z = Math.PI / 2;
      const spinner = build.cylinder(`${spool.name}-spinner`, 0.46, 0.02, 0.5, 10, dark, spool);
      // Points FORWARD: the negative quarter turn puts the cylinder's
      // zero-radius end at +X. Centred on the fan face so the cone stands
      // through it and stops level with the inlet lip rather than out in the
      // airstream.
      spinner.rotation.z = -Math.PI / 2;
      fanSpools.push(spool);

      // CHEVRONS. The serrated fan nozzle is a GEnx signature and the -8 wears
      // it on all four engines; a smooth round nozzle is the older aeroplane.
      // Twelve teeth on every nacelle, all forty-eight in one draw call.
      //
      // The base tooth is a FOUR-sided cone along local +Y with its apex at
      // the top. A quarter turn about Z carries that apex to -X, i.e. aft; the
      // pitch then rolls the tooth around the nozzle, and because pitch is
      // applied OUTSIDE roll the flattened axis stays radial at every clock
      // position. pitch = phase - pi/2 is what makes it so.
      //
      // Four sides rather than three, and the reason is the port wing. The
      // teeth on the two sides are the same shape at mirrored clock positions,
      // and the transform that puts a tooth there also NEGATES its own
      // tangential axis. A three-sided section is not symmetric about that
      // axis, so a triangular tooth comes out rotated 60 degrees on the port
      // nacelles and the airframe stops being a mirror image of itself —
      // `scripts/aircraft-framing-probe.mts` reads exactly that as a defect.
      // A four-sided section is symmetric about both of its own axes, so the
      // mirror closes.
      for (let tooth = 0; tooth < NACELLE_CHEVRON_COUNT; tooth += 1) {
        const phase = (tooth / NACELLE_CHEVRON_COUNT) * Math.PI * 2;
        Matrix.Compose(
          // Flattened through the skin so the tooth is a tab on the nozzle
          // rather than a spike sticking out of it.
          new Vector3(1, 1, 0.35),
          Quaternion.RotationYawPitchRoll(0, phase - Math.PI / 2, Math.PI / 2),
          new Vector3(
            nozzleX - 0.31,
            centreY + NACELLE_NOZZLE_RADIUS * Math.cos(phase),
            z + NACELLE_NOZZLE_RADIUS * Math.sin(phase),
          ),
        ).copyToArray(chevronMatrices, chevronOffset);
        chevronOffset += 16;
      }
    }
  }
  const chevron = build.cylinder("airliner-nacelle-chevron", 0.62, 0, 0.6, 4, dark, root);
  chevron.thinInstanceSetBuffer("matrix", chevronMatrices, 16, true);
  chevron.thinInstanceRefreshBoundingInfo(true);

  // ---------------------------------------------------------------- GEAR ---
  const landingGear = node("airliner-retractable-landing-gear", root, scene);
  const mainWheels: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const bogie of MAIN_BOGIES) {
      const z = side * bogie.z;
      const prefix = `${sideName}-airliner-${bogie.name}-gear`;
      build.strutBetween(
        `${prefix}-strut`,
        new Vector3(bogie.x + 0.25, bogie.trunnionY, z * 0.95),
        new Vector3(bogie.x, MAIN_AXLE_Y + 0.5, z),
        0.26,
        hub,
        landingGear,
      );
      // A side brace on the wing gear only. The body gear retracts forward
      // into the fairing and carries its bracing inside the bay.
      if (bogie.name === "wing") {
        build.strutBetween(
          `${prefix}-side-brace`,
          new Vector3(bogie.x - 0.35, bogie.trunnionY - 0.2, z * 0.72),
          new Vector3(bogie.x - 0.05, MAIN_AXLE_Y + 0.85, z * 0.98),
          0.15,
          hub,
          landingGear,
        );
      }
      const beam = build.box(`${prefix}-bogie-beam`, 2.3, 0.3, 0.34, hub, landingGear);
      beam.position.set(bogie.x, MAIN_AXLE_Y + 0.34, z);
      // FOUR wheels on two axles, and one node PER AXLE rather than per bogie:
      // `applyCommonPose` rolls a wheel node about body Z, and a node at the
      // bogie's centre would carry all four tyres round that centre instead of
      // spinning each pair on its own axle.
      for (const end of [1, -1] as const) {
        const axle = node(
          `${prefix}-${end > 0 ? "forward" : "aft"}-axle`,
          landingGear,
          scene,
        );
        axle.position.set(bogie.x + end * BOGIE_HALF_BASE, MAIN_AXLE_Y, z);
        for (const pair of [1, -1] as const) {
          build.torus(
            `${axle.name}-tire-${pair > 0 ? "outer" : "inner"}`,
            MAIN_TYRE_DIAMETER,
            MAIN_TYRE_THICKNESS,
            12,
            tire,
            axle,
          ).position.z = pair * BOGIE_HALF_TRACK;
        }
        const shaft = build.cylinder(`${axle.name}-shaft`, 1.5, 0.34, 0.34, 10, hub, axle);
        shaft.rotation.x = Math.PI / 2;
        mainWheels.push(axle);
      }
    }
  }

  // The nose leg, and it needs both members. With only the vertical strut the
  // rendered nose gear read as a pair of wheels hanging in open air: the
  // fuselage bottom is at -3.25 and the axle at -5.84, so 2.6 m of leg shows.
  // The drag brace running forward to the bulkhead is what ties the wheels to
  // the aeroplane rather than leaving them hanging in open air, which is how
  // they read before it was added.
  build.strutBetween(
    "airliner-nose-strut",
    new Vector3(22.6, -3, 0),
    new Vector3(22.6, NOSE_AXLE_Y + 0.25, 0),
    0.26,
    hub,
    landingGear,
  );
  build.strutBetween(
    "airliner-nose-drag-brace",
    new Vector3(23.9, -3.05, 0),
    new Vector3(22.6, NOSE_AXLE_Y + 0.55, 0),
    0.14,
    hub,
    landingGear,
  );
  const noseSteer = node("nose-wheel-steering", landingGear, scene);
  noseSteer.position.set(22.6, NOSE_AXLE_Y, 0);
  const noseWheel = node("airliner-nose-wheel", noseSteer, scene);
  // The first tyre carries the bare name the side test steers by; the mate is
  // named for its side so `getMeshByName` cannot pick an arbitrary one of two.
  build.torus(
    "nose-wheel-tire", NOSE_TYRE_DIAMETER, NOSE_TYRE_THICKNESS, 12, tire, noseWheel,
  ).position.z = -0.45;
  build.torus(
    "starboard-nose-wheel-tire", NOSE_TYRE_DIAMETER, NOSE_TYRE_THICKNESS, 12, tire, noseWheel,
  ).position.z = 0.45;
  const noseShaft = build.cylinder("airliner-nose-axle", 1.3, 0.3, 0.3, 10, hub, noseWheel);
  noseShaft.rotation.x = Math.PI / 2;

  // Gear doors, each with the sign that drops its OUTBOARD edge: the door at
  // +Z needs a positive rotation about body X and the one at -Z a negative
  // one. Written per door rather than inferred from an index, which is what
  // the Global does and what made its third door a special case.
  const gearDoorRoot = node("airliner-landing-gear-doors", root, scene);
  const gearDoors: { hinge: TransformNode; sign: number }[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const bogie of MAIN_BOGIES) {
      const hinge = node(`${sideName}-airliner-${bogie.name}-gear-door`, gearDoorRoot, scene);
      hinge.position.set(bogie.x, bogie.trunnionY - 0.05, side * bogie.doorZ);
      const leaf = build.box(`${hinge.name}-leaf`, bogie.doorWidth, 0.09, 1.5, body, hinge);
      // Hinged along its INBOARD edge, so the leaf lies outboard of the node
      // and the side's own sign swings its free edge down and out of the bay.
      leaf.position.z = side * 0.75;
      gearDoors.push({ hinge, sign: side });
    }
  }
  // TWO nose doors, one a side. The Global carries a single leaf and this
  // airframe copied it, which left the only unmirrored geometry on the whole
  // aeroplane — `scripts/aircraft-framing-probe.mts` reads an unmirrored
  // airframe as tilted before any camera exists, and a 747's nose gear doors
  // are a mirrored pair anyway.
  for (const side of [1, -1] as const) {
    const hinge = node(
      side > 0 ? "starboard-airliner-nose-gear-door" : "port-airliner-nose-gear-door",
      gearDoorRoot,
      scene,
    );
    hinge.position.set(22.6, -3.15, side * 0.1);
    const leaf = build.box(`${hinge.name}-leaf`, 3, 0.07, 0.9, body, hinge);
    leaf.position.z = side * 0.45;
    gearDoors.push({ hinge, sign: side });
  }

  // ---------------------------------------------------------------- LAMPS --
  //
  // Every coordinate here is transcribed FROM the committed `AIRLINER_WASH`
  // table in `lighting/AircraftLighting.ts`, which `lighting.aircraft-wash`
  // compares against these meshes' own positions — a lamp half a metre off its
  // wash is a glow with no source.
  //
  // Port (red) at -Z and starboard (green) at +Z, because starboard is +Z.
  // Reversing these is the one lighting error an observer can read directly:
  // it inverts which way the aeroplane appears to be heading.
  const portLight = build.sphere("port-navigation-light", 0.3, 8, redLamp, root);
  portLight.position.set(-16.5, 0.5, -34.2);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.3, 8, greenLamp, root);
  starboardLight.position.set(-16.5, 0.5, 34.2);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  for (const side of [1, -1] as const) {
    // The strobe shares the nav lamp's EXACT coordinate, because the table
    // says so and because a 747's wingtip carries both in one housing. Two
    // concentric spheres would bury one inside the other, so the strobe is the
    // outboard lens DISC: 0.44 m across and 0.10 m thick, its axis turned on
    // to body Z so it faces outboard. The 0.30 m nav sphere stands 0.10 m
    // outboard of it and the disc shows as a white ring around the coloured
    // lens — both visible, and only 0.15 m of lamp outboard of the tip rib.
    const strobe = build.cylinder(
      side > 0 ? "starboard-strobe-light" : "port-strobe-light",
      0.1, 0.44, 0.44, 10, strobeLamp, root,
    );
    strobe.rotation.x = Math.PI / 2;
    strobe.position.set(-16.5, 0.5, side * 34.2);
    strobe.metadata = { ...strobe.metadata, castsShadow: false };
  }
  const beaconLight = build.sphere("anticollision-beacon", 0.34, 8, beaconLamp, root);
  beaconLight.position.set(0, -4.1, 0);
  beaconLight.metadata = { ...beaconLight.metadata, castsShadow: false };
  // On TOP of the tailcone rather than on its axis: the cone is barely 1 m
  // across this far aft, so a lamp on the centreline is buried inside it.
  const tailLight = build.sphere("tail-navigation-light", 0.26, 8, tailLamp, root);
  tailLight.position.set(-37.6, 1.66, 0);
  tailLight.metadata = { ...tailLight.metadata, castsShadow: false };
  // Landing lights in the wing roots, which is where this type carries the
  // pair that matter; the body-gear lights are too small to model.
  for (const side of [1, -1] as const) {
    const lamp = build.cylinder(
      side > 0 ? "starboard-landing-light" : "port-landing-light",
      0.05, 0.6, 0.6, 10, landingLamp, root);
    lamp.rotation.z = Math.PI / 2;
    // Set back 0.30 m from the leading edge, where the section is already
    // 0.69 m thick and a 0.60 m lens sits IN the wing rather than on it.
    lamp.position.set(leadingAt(5.2) - 0.3, chordPlaneAt(5.2) - 0.06, side * 5.2);
    lamp.metadata = { ...lamp.metadata, castsShadow: false };
  }

  const rig: AirlinerRig = {
    root,
    // The contract carries ONE rotating assembly and a four-engined aeroplane
    // has four. The first spool is the one it names; all four are driven from
    // the same simulation-time phase below, so they cannot be seen out of step.
    propeller: fanSpools[0]!,
    // Only opaque skin that would block the pilot's view. The flight deck glass
    // stays on ordinary world layers — a windscreen the pilot cannot see
    // through is worse than no windscreen — and the upper deck is on the list
    // because on THIS aeroplane the flight deck's own roof is part of it.
    cockpitParts: [fuselage, radome, upperDeck, windscreenFrame],
    wingSurfaces,
    ailerons: [starboardAileron, portAileron],
    inboardAilerons: [starboardInboardAileron, portInboardAileron],
    elevator,
    rudder,
    noseSteer,
    flaps,
    mainWheels,
    noseWheel,
    landingGear,
    gearDoors,
    speedBrakes,
  };
  configureCockpitLayers(rig.cockpitParts);
  let disposed = false;
  return {
    kind: "airliner",
    handedness: "right",
    group: root,
    root,
    propeller: rig.propeller,
    cockpitParts: rig.cockpitParts,
    meshes: build.meshes,
    update(state, deltaSeconds) {
      if (disposed) return;
      const delta = safeAircraftAnimationDelta(deltaSeconds);
      const pose = resolveAircraftAnimationPose("airliner", state);
      // Phase-anchored to simulation time rather than accumulated per frame,
      // so an identically-timed frame is identical across capture runs.
      const spin = pose.rotorRadiansPerSecond * state.simulationTime;
      for (const spool of fanSpools) spool.rotation.x = spin;
      applyCommonPose(rig, pose, delta);
      // The inboard ailerons follow the outboard pair exactly. The real
      // aeroplane locks them out above about 200 kt; the sim has no gain
      // schedule to read that from, and an inboard aileron frozen at neutral
      // while its outboard partner works reads as a broken model rather than
      // as a high-speed lockout.
      rig.inboardAilerons[0].rotation.z = pose.starboardAileron;
      rig.inboardAilerons[1].rotation.z = pose.portAileron;
      landingGear.setEnabled(pose.gearVisible);
      landingGear.scaling.set(pose.gearScale.x, pose.gearScale.y, pose.gearScale.z);
      landingGear.position.y = pose.gearOffsetY;
      for (const door of rig.gearDoors) {
        door.hinge.rotation.x = door.sign * pose.gearDoorTravel;
      }
      for (const speedBrake of rig.speedBrakes) speedBrake.rotation.z = pose.speedBrake;
    },
    setLightState(lights) {
      if (disposed) return;
      applyLamp(redLamp, lights.portNav);
      applyLamp(greenLamp, lights.starboardNav);
      applyLamp(tailLamp, lights.tailNav);
      applyLamp(beaconLamp, lights.beacon);
      applyLamp(strobeLamp, lights.strobe);
      applyLamp(landingLamp, lights.landing);
      applyGlow(instrumentMarking, lights.cockpitGlow);
    },
    setCockpitView(enabled) {
      if (disposed) return;
      setCockpitVisibility(rig, scene, enabled);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}
