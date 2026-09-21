// `thinInstanceSetBuffer`/`thinInstanceCount` are prototype extensions Babylon
// only installs with this side-effect import, exactly as the Global's cabin
// window line takes it. This airframe needs it three times over: a 747's
// window line is 228 panes, its chevrons are 48 teeth and its flap track
// canoes are ten of one shape. As separate meshes those alone would be 286
// draw calls — three times the whole Global.
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
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
  configureCockpitOnlyParts,
  configureRoot,
  createGlowApplier,
  createLampApplier,
  hingeAlong,
  yawHingeAlong,
  node,
  setCockpitVisibility,
  type CommonRig,
} from "./airframeRig";
import {
  AircraftBuildContext,
  nacaThickness,
  paintVertexBand,
  type LoftSection,
  type SurfacePoint,
} from "./builders";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { AIRLINER_SEAT, airlinerSeatPlacement, buildAirlinerCockpit } from "./cockpit/airlinerCockpit";
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
 * THE SPOILERS, as two chord fractions rather than as a chord in metres.
 *
 * Both edges being fixed FRACTIONS is load-bearing, not tidiness. Within one
 * wing panel the leading edge, the trailing edge and the chord plane are each
 * affine in z, so a fixed-fraction edge is an exactly straight line in space —
 * which is what lets `hingeAlong` turn the panel about its own forward edge
 * without any part of the edge leaving the skin. An edge at a fixed distance
 * in metres from the hinge line is not: it drifts in fraction as the chord
 * tapers, its height stops being affine, and the hinge line acquires a sag.
 *
 * It also sizes the panels the way the aeroplane does. 13% of local chord is
 * 1.66 m at the inboard ground spoilers and 0.79 m at the outermost flight
 * spoiler, which is the taper a 747's spoilers actually have.
 *
 * The aft edge stops 2.5% of chord short of the 70% hinge line so the panel
 * clears the flap's nose AT EVERY STATION. A panel whose aft edge is a fixed
 * distance ahead of the hinge only clears it at the station that distance was
 * measured at, and fouls the flap inboard of it.
 */
const SPOILER_HINGE_FRACTION = 0.545;
const SPOILER_AFT_FRACTION = HINGE_CHORD_FRACTION - 0.025;
/**
 * 12 mm proud of the skin, and 60 mm thick so the rest of the panel is inside
 * the wing. Flush would be correct on the aeroplane and wrong in a depth
 * buffer: two surfaces at the same depth fight, and at chase range the panels
 * would flicker. 12 mm is under a quarter of a pixel at the 65 m orbit — no
 * step the eye can find — and far enough apart in z to settle the fight.
 */
const SPOILER_PROUD = 0.012;
const SPOILER_THICKNESS = 0.06;
/**
 * One span segment would be exact — the skin is ruled in z within a panel —
 * but two lets the normals interpolate across the panel instead of being
 * constant over its whole width. The chord is a curve and needs its four.
 */
const SPOILER_SPAN_SEGMENTS = 2;
const SPOILER_CHORD_SEGMENTS = 4;
/**
 * Two inboard ground spoilers ahead of the inner flap (4.4-11.9) and four
 * outboard flight spoilers ahead of the outer one (16.6-23.1), leaving the
 * inboard aileron's span clear between them.
 *
 * THE GROUPS ARE THE MESHES, and that falls out of the fixed-fraction edge
 * above: every panel in a group sits on the 54.5% chord line of the SAME wing
 * panel, so all of them lie on one straight line in space and all of them turn
 * about it together. One hinge node and one mesh a group is therefore exact,
 * not an approximation — and it is why going from ten panels to the twelve the
 * aeroplane has SAVED six draw calls instead of costing two.
 *
 * The grouping is also what forces each group to stay inside one wing panel:
 * a group straddling the Yehudi break at 12.5 would have a bent hinge line,
 * and `buildSpoilerGroup` throws rather than draw one.
 */
const SPOILER_GROUPS = [
  {
    name: "ground-spoilers",
    panels: [{ rootZ: 5, tipZ: 7.9 }, { rootZ: 8.3, tipZ: 11.2 }],
  },
  {
    name: "flight-spoilers",
    panels: [
      { rootZ: 16.8, tipZ: 18.2 },
      { rootZ: 18.4, tipZ: 19.8 },
      { rootZ: 20, tipZ: 21.4 },
      { rootZ: 21.6, tipZ: 23 },
    ],
  },
] as const;

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
/** Hermite ramp; `edge0 > edge1` simply runs the ramp the other way. */
function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

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

/** The local dihedral angle, from the same two panels the chord plane uses. */
function dihedralAt(z: number): number {
  return insideKink(z)
    ? Math.atan2(WING_KINK_Y - WING_ROOT_Y, WING_KINK_Z - WING_ROOT_Z)
    : Math.atan2(WING_RAKE_Y - WING_KINK_Y, WING_RAKE_Z - WING_KINK_Z);
}

/** Chord-plane height, following the same two panels the dihedral is built in. */
function chordPlaneAt(z: number): number {
  return insideKink(z)
    ? alongPanel(WING_ROOT_Y, WING_KINK_Y, inboardFraction(z))
    : alongPanel(WING_KINK_Y, WING_RAKE_Y, outboardFraction(z));
}

/**
 * THE WING SKIN, anywhere on it. Given a station and a chord fraction it
 * returns the y of the upper or the lower surface, from the SAME two terms
 * `builders.ts` draws the section from — `nacaThickness` for the half-
 * thickness and 4c·t·(1-t) for the camber line — so a part seated with this
 * is seated on the surface the wing actually has.
 *
 * This replaced a pair of helpers that evaluated the section at 60% chord and
 * nowhere else, from a hand-copied 0.3753 (the true value there is 0.3789).
 * One height per part is only ever right at one station: ten spoilers on a
 * swept, tapered, dihedralled wing each need a different answer at each of
 * their own corners, and a single number left them between 44 and 288 mm clear
 * of the skin they are supposed to lie in.
 */
function wingSkinY(z: number, chordFraction: number, upper: boolean): number {
  // THE SECTION IS DRAWN OVER THE WING BOX, NOT OVER THE CHORD. `wingPanels`
  // hands `airfoilWing` a trailing edge at the HINGE LINE, because aft of it
  // the metal is flap. So the fixed wing is a complete aerofoil of 70% of the
  // local chord, and a fraction of the true chord has to be rescaled into that
  // box before the thickness law sees it. Evaluating the law on the full chord
  // instead puts the skin about 3% of chord too high — 540 mm at the inboard
  // spoiler station, which is how the first attempt at this repair managed to
  // seat the panels WORSE than the boxes it replaced.
  const boxChord = leadingAt(z) - hingeAt(z);
  const ratio = insideKink(z) ? WING_INBOARD_THICKNESS : WING_OUTBOARD_THICKNESS;
  const local = Math.min(1, Math.max(0, chordFraction / HINGE_CHORD_FRACTION));
  const camber = 4 * WING_CAMBER * local * (1 - local) * boxChord;
  const halfThickness = nacaThickness(local, ratio) * boxChord;
  // And the section stands off the CHORD PLANE, which is tilted: each panel is
  // built inside a node rolled to the local dihedral, so a half-thickness of h
  // reaches h*cos(dihedral) in body y.
  const offset = camber + (upper ? halfThickness : -halfThickness);
  return chordPlaneAt(z) + offset * Math.cos(dihedralAt(z));
}

/** Where a station's chord fraction lands in body x. */
function chordFractionX(z: number, chordFraction: number): number {
  const leading = leadingAt(z);
  return leading - chordFraction * (leading - trailingAt(z));
}

/** The LOWER surface at 60% chord, which is what a pylon hangs from. */
function lowerSurfaceY(z: number): number {
  return wingSkinY(z, 0.6, false);
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
  // From here forward the section stops being a circle and becomes an EGG:
  // the belly stays pinned at y = -3.25 and the crown climbs, while
  // `crownZRadius` leans the upper flanks in. Every section's yRadius and
  // yOffset below is (crown - belly)/2 and (crown + belly)/2 with the belly
  // held at -3.25, so the tube's underside is one unbroken line and only the
  // top of the aeroplane changes.
  // THE CROWN HAS TO RUN LEVEL over the deck, not merely reach the right
  // height. A first attempt raised it evenly from the wing to the flight deck,
  // and the frames showed the consequence: the crease was gone but so was the
  // hump, because a 747's upper deck is a raised DECK -- the crown climbs
  // behind the wing, runs flat the length of the deck, and fairs down. An even
  // climb is a bulge. These stations give 5 mm/m at the wing, 87 at the steep
  // part, then 17 and 2 over the deck itself, where it is level to the eye.
  { x: 0, yRadius: 3.265, zRadius: 3.25, yOffset: 0.015, crownZRadius: 3.23 },
  { x: 5, yRadius: 3.35, zRadius: 3.25, yOffset: 0.1, crownZRadius: 3.14 },
  { x: 9, yRadius: 3.525, zRadius: 3.25, yOffset: 0.275, crownZRadius: 2.94 },
  { x: 13, yRadius: 3.685, zRadius: 3.25, yOffset: 0.435, crownZRadius: 2.76 },
  { x: 17, yRadius: 3.785, zRadius: 3.25, yOffset: 0.535, crownZRadius: 2.65 },
  { x: 21, yRadius: 3.82, zRadius: 3.25, yOffset: 0.57, crownZRadius: 2.61 },
  // The crown reaches 4.40 here, which is where `sim/aircraft.ts` puts its
  // upper-deck contact point, exactly as the old separate hump loft did.
  { x: 26, yRadius: 3.825, zRadius: 3.25, yOffset: 0.575, crownZRadius: 2.6 },
  // ...and then hands the crown down to the nose loft, narrowing enough by
  // the last section to be swallowed by it rather than capped in the open.
  { x: 28, yRadius: 3.575, zRadius: 3, yOffset: 0.675, crownZRadius: 2.45 },
  { x: 29.6, yRadius: 3.15, zRadius: 2.6, yOffset: 0.65, crownZRadius: 2.2 },
  { x: 30.6, yRadius: 2.55, zRadius: 2.05, yOffset: 0.6, crownZRadius: 1.8 },
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

/*
 * THE HUMP IS THE FUSELAGE NOW, not a second loft riding on it.
 *
 * It used to be a separate closed loft intersecting the tube, on the reasoning
 * that a 747's forward section is a double bubble and one ellipse tall enough
 * to reach the upper-deck crown would also be widest at upper-deck height,
 * which is backwards. That reasoning was right about the shape and wrong about
 * the remedy: two intersecting closed surfaces cannot be tangent-continuous,
 * so the best the arrangement could ever do was choose the angle of its crease.
 * The file's own history records choosing it twice -- 41 degrees, then 31 after
 * the upper lobe was widened.
 *
 * Measured on the built mesh by walking the section and comparing each
 * sample's normal with the next, it was 23.5 degrees at x = 14, 30.1 at x = 22
 * and 38.0 at x = 26 -- worst at the flight deck, which is the part of this
 * aeroplane people look at. That is what Jason meant by the second level
 * looking like a cylinder combined with the rest of the body.
 *
 * `LoftSection.crownZRadius` is the degree of freedom that was missing: it
 * lets ONE section be wide at the main deck and narrower at the crown. So
 * `FUSELAGE_SECTIONS` above carries the hump itself, morphing from a circle
 * aft of the wing to an egg at the flight deck, and there is no second surface
 * to crease against.
 */

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
  const crownZRadius = alongPanel(
    low.crownZRadius ?? low.zRadius,
    high.crownZRadius ?? high.zRadius,
    t,
  );
  const rise = (y - yOffset) / yRadius;
  // The same crown taper the loft builder applies, or every window forward of
  // the wing would be placed against an ellipse the skin no longer is.
  const lift = Math.max(0, rise) ** 2 * (3 - 2 * Math.max(0, rise));
  const halfWidth = zRadius + (crownZRadius - zRadius) * lift;
  const z = halfWidth * Math.sqrt(Math.max(0, 1 - rise * rise));
  // Outward normal at that point, as (dy, dz).
  return { z, tilt: Math.atan2(rise / yRadius, z / (halfWidth * halfWidth)) };
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
/** Linear-space navy, the rudder's own colour: vertex colour multiplies albedo. */
const CHEATLINE_LINEAR: readonly [number, number, number] = [0.011, 0.042, 0.147];
/** Half a metre either side of the window line, so it reads at 112 m. */
const CHEATLINE_HALF_HEIGHT = 0.5;

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

/**
 * Take a part out of the sun shadow map, keeping whatever else it carries.
 *
 * A caster is drawn THREE times a frame — once in the colour pass and once
 * into each of the two shadow cascades — and the 747 measured +0.70 ms of CPU
 * against the Cessna on draw submission alone. So a part earns its two shadow
 * draws only if its shadow can be SEEN, and the parts passed here cannot be:
 * each one's shadow falls inside the shadow of the nacelle, fuselage or tyre
 * it is buried in, or is a few centimetres proud of one. Nothing that draws
 * the aeroplane's outline on the ground comes through here.
 *
 * Spread, never assigned: `finishMesh` and the loft builders have already
 * written metadata the renderer and the tests read.
 */
function withoutShadow<T extends AbstractMesh>(part: T): T {
  part.metadata = {
    ...(part.metadata as Record<string, unknown> | null),
    castsShadow: false,
  };
  return part;
}

export function createAirliner(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("boeing-747-8", scene);
  configureRoot(root, "airliner");

  // Three paint recipes: the shell, the wing, and the accent. This airframe
  // carries four times the Global's painted area and each recipe costs three
  // synthesized 64-pixel textures, so a recipe has to buy something a camera
  // can find — and the wing's does; see `wing` below.
  const bodyRecipe = {
    seed: 0x7478_0001,
    baseColor: 0xf4f5f3,
    roughness: 0.31,
    metallic: 0.14,
    sootStrength: 0.3,
    wearStrength: 0.38,
    // The 64-pixel maps stretch over a 72 m fuselage — twice the Global's
    // reach, so the panel grid has to be weaker again or it reads as quilting.
    panelStrength: 0.34,
    // THE LIVERY COLOUR IS THE BASE COLOUR, which retires the UV decal on the
    // whole airframe rather than only on the wing.
    //
    // The paint synthesis draws its `livery-decal` feature as a diagonal band
    // in UV SPACE -- `fract(u - 0.37v + 0.18)` near 0.5 -- and hands every
    // mesh its own 0..1 tile. That is not a cheatline, it is a slash at
    // whatever angle each mesh's UVs happen to give it, and on an aeroplane
    // made of this many parts the result is a row of disconnected diagonals
    // that never meet: exactly Jason's "the lines on the aircraft seem all
    // disjointed". No choice of UVs fixes it, because the band is defined in
    // a space each mesh owns separately.
    //
    // With the two colours equal, `mix(value, livery, decal)` is the identity
    // and the band is gone. The real livery goes on below as body-space vertex
    // paint, where a boundary is a height and a station and crosses a mesh
    // join without knowing it is there.
    liveryColor: 0xf4f5f3,
  } as const;
  const body = build.paintMaterial("airliner-body", bodyRecipe);
  // THE WING USED TO HAVE ITS OWN MATERIAL, and it no longer needs one.
  //
  // `airliner-wing` was the body recipe with `liveryColor` set equal to
  // `baseColor`, which turns `mix(value, livery, decal)` into the identity and
  // kills the UV-space `livery-decal` band — the row of disconnected blue
  // slashes, one per separately-UV'd part, that was half of Jason's "the lines
  // on the aircraft seem all disjointed".
  //
  // The BODY recipe then had the same treatment applied to it, airframe-wide,
  // when the cheatline moved into body-space vertex paint. From that moment
  // the two recipes were identical in every field, and this one was a second
  // material producing bit-for-bit the same paint: the same seed, so the same
  // panel lines, rivets, seams, filler, soot and leading-edge wear.
  //
  // WHAT IT COST, measured rather than argued: the airframe goes from 17
  // materials to 16 and from 10 textures to 7. `paintMaterial` does not cache
  // by recipe — it synthesises the surface and builds albedo, normal and
  // metallic-roughness maps on every call — so an identical recipe meant a
  // second synthesis and a second set of three maps of the same paint.
  //
  // What it did NOT cost, which is worth recording because it is the first
  // thing one would assume: nothing. Mesh count and predicted draws are
  // unchanged at 91 and 207. `mergeStatic` folds per material, but the wing's
  // fixed panels are folded by their own explicit call and were never going to
  // join anything else. Everything that asked for `wing` now asks for `body`.
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
  // 28 segments, matching the fuselage's, and the cheatline is why. Vertex
  // paint SAMPLES a continuous function at each mesh's own vertices and the
  // renderer interpolates between them, so two lofts with different
  // circumferential spacing rebuild the same edge up to half a spacing apart.
  // On the Global that was a 53 mm step at the tail join until the two counts
  // were matched; here the band would cross the nose join the same way.
  const radome = build.loft("airliner-radome", NOSE_SECTIONS, 28, body, root);

  /*
   * THE CHEATLINE, in BODY COORDINATES.
   *
   * A height and a station range, evaluated at each vertex, so it crosses the
   * fuselage/radome join without knowing the join is there -- which is the
   * whole difference from the UV band it replaces. It is multiplied into the
   * skin as vertex colour rather than laid on as decal geometry, so it cannot
   * z-fight at any range, and the paint's panel lines survive under it.
   *
   * Level with the MAIN DECK window row, and deep enough to read: at the chase
   * camera's 112 m standoff a pixel is about 9 cm, so a band under half a
   * metre would shimmer rather than draw.
   */
  for (const skin of [fuselage, radome]) {
    paintVertexBand(skin, CHEATLINE_LINEAR, (x, y, z) => {
      // Dies out before the tailcone's taper and before the radome's tip,
      // where a level band would ride up over a shape that is no longer a tube.
      const station = smoothStep(-24.5, -22, x) * (1 - smoothStep(30.5, 32.5, x));
      if (station <= 0) return 0;
      // Flanks only: a band defined by height alone wraps under the belly
      // wherever the section is narrower than the cabin's.
      const flank = Math.min(1, Math.abs(z) / 1.6);
      return station * flank
        * (1 - smoothStep(CHEATLINE_HALF_HEIGHT, CHEATLINE_HALF_HEIGHT + 0.22,
          Math.abs(y - MAIN_DECK_WINDOW_Y)));
    });
  }
  // Upswept, ending at (-38, +1.2) where the sim puts its tailcone contact
  // point. The upsweep is what buys a 72 m aeroplane its rotation angle: the
  // mains are at x = -3, so 10.4 degrees of tail-strike margin comes entirely
  // from how fast this cone climbs.
  //
  // `bodyExterior` collects every body-painted part that is bolted rigidly to
  // the root and is NOT cockpit-excluded skin, so the whole list can be folded
  // into one mesh at the end of the build; see FOLDING THE STATIC AIRFRAME.
  const bodyExterior: AbstractMesh[] = [];
  bodyExterior.push(build.loft(
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
  ));
  // The wing-to-body fairing, 9.4 m across at its widest — wider than the
  // fuselage itself, because it houses the centre wing box, the centre tank and
  // the two body gear bays. Its underside holds at -3.60, which is where the
  // sim puts its belly contact point, so a belly landing touches the metal it
  // says it touches. It also has to reach z = 3.25 at the wing's own chord
  // plane along the whole root chord or the root rib stands out in the open.
  bodyExterior.push(build.loft(
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
  ));
  // The beacon blister. `AIRLINER_WASH` puts the lower anticollision light at
  // y = -4.1 and the fairing above bottoms out at -3.60, so without this the
  // lamp floats half a metre clear of the skin — the exact defect the Global's
  // table was corrected for. The real aeroplane carries the beacon in a
  // streamlined housing below the fairing, so the fix is its own part rather
  // than moving the fairing down through the sim's contact point.
  bodyExterior.push(build.loft(
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
  ));

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
          sections: FUSELAGE_SECTIONS,
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
    // Each pane stands 0.05 m proud of a 6.5 m fuselage whose own shadow it
    // falls inside from every sun angle.
    withoutShadow(cabinWindow);
  }

  const wingSurfaces: AbstractMesh[] = [];
  // The fixed structure is NOT pushed to `wingSurfaces` as it is built. It is
  // folded into one mesh a side and one for the tail at the end of the build,
  // and the folded meshes take its place there — `setCockpitVisibility` walks
  // that list, and a disposed panel left in it would be the wing the cockpit
  // camera cannot see.
  const fixedWing: Record<"starboard" | "port", { panels: AbstractMesh[]; anchors: TransformNode[] }> = {
    starboard: { panels: [], anchors: [] },
    port: { panels: [], anchors: [] },
  };
  const fixedTail: AbstractMesh[] = [];
  const flaps: TransformNode[] = [];
  const speedBrakes: TransformNode[] = [];
  /**
   * The same nodes, but knowing which GROUP and which WING each one is.
   *
   * `CommonRig.speedBrakes` is a bare array driven by one angle, which is all
   * three other airframes want. This aeroplane's twelve panels do three jobs:
   * the inboard pair are ground spoilers, the outboard four are flight
   * spoilers that double as the speed brake AND rise differentially with roll.
   * Reading that off the array's ORDER would work today and break the first
   * time someone adds a group or swaps the loop.
   */
  const spoilerGroups: {
    node: TransformNode;
    group: (typeof SPOILER_GROUPS)[number]["name"];
    side: 1 | -1;
  }[] = [];

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
    hinge.rotation.x = -side * dihedralAt(z);
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
      fixedWing[sideName].anchors.push(anchor);
      fixedWing[sideName].panels.push(build.airfoilWing(
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
        // WING paint, not the accent. An airline's wing is one white surface
        // from root to tip: painting eight panels in the livery colour turned
        // the plan view into stripes, and the body recipe's own livery band
        // did the same thing more quietly — a blue dash across every panel,
        // each at its own angle. See the note on `wing`.
        body,
        hinge,
      );
      flaps.push(hinge);
      wingSurfaces.push(surface);
      // The hinge LINE. This is the worst case in the fleet: the inner panel
      // spans 7.5 m on a hinge line swept back with the wing, so its outboard
      // end stands metres aft of the node's own z axis and turning it about
      // that axis would wring the panel out along its span. The direction
      // carries the dihedral through `chordPlaneAt`, which is what lets
      // `hingeAlong` subsume the roll `wingHinge` already applied.
      hingeAlong(hinge, new Vector3(
        hingeAt(flap.tipZ) - hingeX,
        0,
        side * (flap.tipZ - flap.rootZ),
      ), scene);
    }

    /**
     * SPOILERS. Six a side, which is what the aeroplane has: two inboard
     * ground spoilers lying ahead of the inner flap and four outboard flight
     * spoilers ahead of the outer one, with the inboard aileron's span left
     * clear between the two groups.
     *
     * THEY ARE CONFORMED, and that is the repair in this pass. Built as
     * axis-aligned boxes seated at one station's skin height, they measured
     * between 44 mm (panel five) and 288 mm (panel one) clear of the wing at
     * their CLOSEST corner and up to 583 mm proud at their worst — white
     * plates standing off a wing they are supposed to lie in, and the error
     * shrank monotonically outboard because it was the wing's dihedral being
     * read off a single station. A box cannot lie in this surface: over a
     * 2.9 m panel the skin moves by the dihedral, by the taper and by the
     * thickness law, and no single height is right at more than one corner.
     *
     * Each panel is now a grid whose every vertex is placed by `wingSkinY` AT
     * ITS OWN STATION AND CHORD FRACTION, so the dihedral, the taper and the
     * section are absorbed by construction rather than corrected for. Both
     * edges are at fixed CHORD FRACTIONS, which is what makes the hinge line
     * exactly straight: within one wing panel the chord plane and the chord
     * are each affine in z, so a fixed-fraction edge is a straight line in
     * space and `hingeAlong` can turn the panel about it without wringing it.
     * The aft edge stands 2.5% of chord ahead of the 70% hinge line, so it
     * clears the flap's nose at every station instead of only at one.
     */
    for (const group of SPOILER_GROUPS) {
      const rootZ = group.panels[0]!.rootZ;
      const tipZ = group.panels[group.panels.length - 1]!.tipZ;
      if (insideKink(rootZ) !== insideKink(tipZ)) {
        throw new RangeError(`${group.name} straddles the wing kink; its hinge line would bend`);
      }
      const hingeX = chordFractionX(rootZ, SPOILER_HINGE_FRACTION);
      const hingeY = wingSkinY(rootZ, SPOILER_HINGE_FRACTION, true) + SPOILER_PROUD;
      // The node IS the hinge, at the group's inboard end on the hinge line.
      // No dihedral is applied here and none is needed: the direction handed
      // to `hingeAlong` below carries the real line, rise included.
      const brake = node(`${sideName}-airliner-${group.name}`, root, scene);
      brake.position.set(hingeX, hingeY, side * rootZ);
      const patches = group.panels.map((panel) => {
        const patch: SurfacePoint[][] = [];
        for (let span = 0; span <= SPOILER_SPAN_SEGMENTS; span += 1) {
          const z = panel.rootZ
            + (panel.tipZ - panel.rootZ) * (span / SPOILER_SPAN_SEGMENTS);
          const row: SurfacePoint[] = [];
          for (let chord = 0; chord <= SPOILER_CHORD_SEGMENTS; chord += 1) {
            const fraction = SPOILER_HINGE_FRACTION
              + (SPOILER_AFT_FRACTION - SPOILER_HINGE_FRACTION)
                * (chord / SPOILER_CHORD_SEGMENTS);
            row.push({
              x: chordFractionX(z, fraction) - hingeX,
              y: wingSkinY(z, fraction, true) + SPOILER_PROUD - hingeY,
              z: side * (z - rootZ),
            });
          }
          patch.push(row);
        }
        return patch;
      });
      build.conformedPanels(`${brake.name}-surface`, patches, SPOILER_THICKNESS, body, brake);
      // The hinge LINE: the panels' own forward edge, end to end. Sweep from
      // the x term, dihedral and taper from the y term.
      hingeAlong(brake, new Vector3(
        chordFractionX(tipZ, SPOILER_HINGE_FRACTION) - hingeX,
        wingSkinY(tipZ, SPOILER_HINGE_FRACTION, true) + SPOILER_PROUD - hingeY,
        side * (tipZ - rootZ),
      ), scene);
      speedBrakes.push(brake);
      spoilerGroups.push({ node: brake, group: group.name, side });
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
      // Wing paint, for the reason the flaps carry it.
      body,
      hinge,
    ));
    // All four ailerons sit on the same swept hinge line as the flaps, so they
    // take their axis from it the same way. An aileron deflects both ways, so
    // a panel wrung out along its span reads as a twisting wing in every turn
    // rather than only on approach.
    hingeAlong(hinge, new Vector3(
      hingeAt(tipZ) - hingeX,
      0,
      side * (tipZ - rootZ),
    ), scene);
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
    // Wing paint: a canoe is wing structure, and in the body recipe each of
    // the eight wore its own blue dash under an otherwise white wing.
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
  fixedTail.push(fin);
  // The dorsal fillet ahead of the fin root. Its aft-top corner lands ON the
  // fin's leading edge at y = 5.3, so the two meet instead of overlapping into
  // a step, and its aft face is buried inside the fin's own thickness.
  bodyExterior.push(build.verticalProfile(
    "airliner-dorsal-fin",
    [
      { x: -14.5, y: 3.05 },
      { x: -23, y: 3.05 },
      { x: -23, y: 5.3 },
    ],
    0.85,
    body,
    root,
  ));

  /**
   * THE RUDDER, as a sheared panel on the fin's trailing edge.
   *
   * It was a box tilted about its own centre to fake a swept panel against a
   * vertical hinge, and the measurement of what that costs is worth keeping:
   * the panel's LEADING EDGE ended up at x -29.54, which is 1.86 m FORWARD of
   * its own hinge node at -31.40, so the hinge line ran through the panel
   * rather than along its edge. The tilt also rotated the CHORDS — the root
   * chord rose 25.9 degrees from horizontal, which a rudder's never does.
   * Raking the axis of that shape swung its two edges opposite ways and sent
   * the trailing edge to PORT on right rudder, which is why it sat in
   * `DECLARED_UNRAKED` instead of being fixed by an axis change.
   *
   * A panel does not need rotating to sit on a raked line; it needs SHEARING.
   * The leading edge leans with the fin, the chords stay level, and
   * `verticalProfile` draws that as four points. The leading edge IS the hinge
   * line by construction, and `yawHingeAlong` gives the node an axis along it
   * while preserving the authored pose.
   *
   * The fin's own trailing edge is the hinge, so the rudder stands aft of it —
   * 2.2 m at the root, which takes the fin's total root chord from 11.0 m to
   * 13.2 and towards the real aeroplane's 13. The old tilted box added only
   * 0.65 m there, so the tail was short as well as wrong.
   */
  const FIN_ROOT_TRAILING = { x: -31.5, y: 3.1 };
  const FIN_TIP_TRAILING = { x: -36.3, y: 13 };
  const RUDDER_ROOT_CHORD = 2.2;
  const RUDDER_TIP_CHORD = 1;
  const RUDDER_ROOT_FRACTION = 0.03;
  const RUDDER_TIP_FRACTION = 0.97;
  const finTrailingAt = (fraction: number) => ({
    x: FIN_ROOT_TRAILING.x + (FIN_TIP_TRAILING.x - FIN_ROOT_TRAILING.x) * fraction,
    y: FIN_ROOT_TRAILING.y + (FIN_TIP_TRAILING.y - FIN_ROOT_TRAILING.y) * fraction,
  });
  const rudderRoot = finTrailingAt(RUDDER_ROOT_FRACTION);
  const rudderTip = finTrailingAt(RUDDER_TIP_FRACTION);
  const rudder = node("rudder", root, scene);
  rudder.position.set(rudderRoot.x, rudderRoot.y, 0);
  const rudderSpanX = rudderTip.x - rudderRoot.x;
  const rudderSpanY = rudderTip.y - rudderRoot.y;
  // 0.8 m thick against the fin's 1.3: the section tapers aft, and a rudder as
  // thick as its own swing would make "which way did the trailing edge go"
  // ambiguous — the side test reads the aftmost vertex.
  // AN AEROFOIL STOOD ON END, not a slab, and the trailing edge is the reason.
  //
  // A constant-thickness panel ends in a SQUARE edge two vertices wide, and
  // "which way did the trailing edge go" then has two answers: as the panel
  // swings, the far face's corner becomes the aft-most one and the side test
  // reads the deflection BACKWARDS. Measured on the first attempt here — right
  // rudder put the aft-most vertex at z -0.194 where it had been +0.400, on a
  // panel that was in fact swinging correctly to starboard. `airfoilWing`
  // tapers to a sharp trailing edge, so there is one aft-most vertex and only
  // one answer. It is also what the Global's rudder, the one raked rudder in
  // the fleet that already worked, is built from.
  const rudderSurface = build.airfoilWing(
    "rudder-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -RUDDER_ROOT_CHORD,
      tipLeadingX: rudderSpanX,
      tipTrailingX: rudderSpanX - RUDDER_TIP_CHORD,
      rootZ: 0,
      tipZ: rudderSpanY,
      thicknessRatio: 0.16,
      chordSegments: 8,
      spanSegments: 3,
    },
    accent,
    rudder,
  );
  // Stood upright on the CHILD, because the node's own Y rotation is the
  // deflection the pose owns every frame.
  rudderSurface.rotation.x = -Math.PI / 2;
  // The hinge LINE: the panel's own leading edge, root to tip.
  yawHingeAlong(rudder, new Vector3(rudderSpanX, rudderSpanY, 0), scene);

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
    fixedTail.push(tailplane);
  }

  // ONE HINGE NODE PER HALF, because the tailplane is swept 32 degrees and
  // the two halves' hinge lines are mirror images. Shared, the node turned
  // 11.5 degrees off either of them.
  const elevators: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const elevator = node(
      side > 0 ? "starboard-elevator-hinge" : "port-elevator-hinge",
      root,
      scene,
    );
    elevator.position.set(ELEVATOR_HINGE_X, TAILPLANE_Y, 0);
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
    hingeAlong(elevator, new Vector3(
      ELEVATOR_TIP_HINGE_X - ELEVATOR_HINGE_X,
      0,
      side * (TAILPLANE_TIP_Z - TAILPLANE_ROOT_Z),
    ), scene);
    elevators.push(elevator);
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
  const flightDeckGlazing: AbstractMesh[] = [];
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
      flightDeckGlazing.push(glazing);
    }
  }
  // The centre post, laid along the nose's crown line between the two No.1
  // panes. Its endpoints are the crown height at those two stations, so it
  // sits half in the skin instead of floating over it.
  // Half sunk in the crown, so its shadow is the nose's own.
  const windscreenFrame = withoutShadow(build.strutBetween(
    "airliner-windscreen-center-post",
    new Vector3(31.9, 2.73, 0),
    new Vector3(31.2, 3.23, 0),
    0.09,
    dark,
    root,
  ));

  // The seats stand around the pilot's eye (`catalogue.cockpitEye`, forward 29.9):
  // seat centre 0.05 m aft of it, its highest corner 0.15 m below it, the headrest
  // where it always was relative to the seat. They stood at 29.0 with the eye at
  // 28.8, 2 m behind the glass, which is why no eye could see more than +5 / -7.
  const flightDeckFurniture: AbstractMesh[] = [];
  const seating = airlinerSeatPlacement();
  for (const side of [1, -1] as const) {
    const seat = build.box(
      side > 0 ? "airliner-captain-seat" : "airliner-first-officer-seat",
      AIRLINER_SEAT.length,
      AIRLINER_SEAT.height,
      AIRLINER_SEAT.width,
      interior,
      root,
    );
    seat.position.set(seating.seatX, seating.seatY, side * AIRLINER_SEAT.z);
    seat.rotation.z = AIRLINER_SEAT.tilt;
    seat.metadata = { ...seat.metadata, cockpitInterior: true, castsShadow: false };
    const headrest = build.box(
      side > 0 ? "airliner-captain-headrest" : "airliner-first-officer-headrest",
      AIRLINER_SEAT.headrestLength,
      AIRLINER_SEAT.headrestHeight,
      AIRLINER_SEAT.headrestWidth,
      interior,
      root,
    );
    headrest.position.set(seating.headrestX, seating.headrestY, side * AIRLINER_SEAT.z);
    headrest.metadata = { ...headrest.metadata, cockpitInterior: true, castsShadow: false };
    flightDeckFurniture.push(seat, headrest);
  }
  // THE OLD PANEL, ITS FIVE GAUGES AND ITS FIVE NEEDLES ARE GONE. A board laid out
  // about the centreline, 1.15 m in front of a left-seat eye, with dials mostly
  // below the frame, is replaced by the cockpit-only kit in
  // `cockpit/airlinerCockpit.ts`: a panel and hood at -10 degrees, a dash, six
  // screens laid out about the seats with an attitude ball on the pilot's PFD, an
  // overhead, a pillar and a post. `configureCockpitOnlyParts` makes them invisible
  // until cockpit view is entered and never a shadow caster.
  const cockpit = buildAirlinerCockpit(build, root, {
    interior,
    instrumentFace,
    instrumentMarking,
  });
  const cockpitOnlyParts = cockpit.parts;
  configureCockpitOnlyParts(cockpitOnlyParts);
  // The attitude ball turns only while cockpit view is on: outside it every part
  // of it is invisible, and the visual already gets the whole state every frame.
  let cockpitViewOn = false;

  // ------------------------------------------------------------- ENGINES ---
  const fanSpools: TransformNode[] = [];
  const engineCores: AbstractMesh[] = [];
  const engineInlets: AbstractMesh[] = [];
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

      bodyExterior.push(build.loft(
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
      ));
      // The core cowl and exhaust plug, reaching 1.75 m aft of the fan nozzle
      // and covering the nacelle loft's own aft cap on the way through.
      engineCores.push(build.loft(
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
      ));
      // THE INTAKE, and the first version did not have one. `loft` closes its
      // forward section with a flat painted cap, so a nacelle built from a
      // loft alone is a white egg: the head-on frame showed four of them with
      // no hole at all. The fix is a dark duct whose own forward face sits
      // 0.04 m PROUD of that cap and 0.06 m inside the cowl's lip radius, so
      // what the eye gets is a thin bright lip ring around a dark opening.
      // Tapering it inward from 2.76 to 2.40 gives the opening a shaded wall
      // rather than a flat disc.
      // No shadow: the duct is inside the cowl over all but its last 0.04 m.
      const inlet = withoutShadow(
        build.cylinder(`${prefix}-inlet`, 1.3, 2.4, 2.76, 20, dark, root),
      );
      inlet.rotation.z = Math.PI / 2;
      inlet.position.set(inletX - 0.61, centreY, z);
      engineInlets.push(inlet);

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
      bodyExterior.push(pylon);

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
      // Neither casts. A 2.1 m disc and a 0.5 m cone in the mouth of a 3.4 m
      // cowl: the most either can add to the nacelle's shadow is a 0.3 m
      // sliver off its front face, and eight parts were paying sixteen shadow
      // draws a frame for it.
      const fanFace = withoutShadow(
        build.cylinder(`${spool.name}-fan`, 0.1, 2.02, 2.1, 16, hub, spool),
      );
      fanFace.rotation.z = Math.PI / 2;
      const spinner = withoutShadow(
        build.cylinder(`${spool.name}-spinner`, 0.46, 0.02, 0.5, 10, dark, spool),
      );
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
  // Tabs lying in the nozzle's own skin; their shadow is the nacelle's.
  withoutShadow(chevron);

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
        // The shaft is a 0.34 m rod through two 1.24 m tyres and under a
        // bogie beam: what little of its shadow is not theirs is a 0.7 m
        // strip between the pair. The tyres, beam and legs all still cast.
        const shaft = withoutShadow(
          build.cylinder(`${axle.name}-shaft`, 1.5, 0.34, 0.34, 10, hub, axle),
        );
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
  const noseShaft = withoutShadow(
    build.cylinder("airliner-nose-axle", 1.3, 0.3, 0.3, 10, hub, noseWheel),
  );
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

  // ------------------------------------------- FOLDING THE STATIC AIRFRAME --
  //
  // Everything above was built one part to a mesh, because that is how an
  // aeroplane is described. It is not how one should be DRAWN: a mesh is a
  // draw, a shadow caster is three, and this airframe measured +0.70 ms of CPU
  // a frame against the Cessna on submission alone. So every group of parts
  // that shares a material and is bolted rigidly to the root becomes one
  // mesh here. `mergeStatic` refuses anything that hangs from a node not
  // declared static, so no hinge, frame, mount, spool or gear part can be
  // folded in by mistake — and none is offered: every flap, spoiler, aileron,
  // elevator, the rudder, the doors, the fans and the whole undercarriage
  // stay exactly as they were built.
  //
  // Left alone on purpose: the three thin-instanced meshes (a merge drops the
  // instance buffer), the eight lamps (the wash-light test sites each one by
  // name and position) and the centre post, which is the only dark part on
  // the cockpit-excluded layer and so has nothing to merge with.
  //
  // THE COCKPIT SHELL IS ITS OWN GROUP. The three lofts that would block the
  // pilot's view carry `AIRCRAFT_EXTERIOR_LAYER_MASK`, which the cockpit
  // camera clears; the tailcone and fairings behind them do not. One mesh has
  // one layer mask, so they cannot share one. The mask is put on the sources
  /*
   * EVERY part on a paint material carries a colour channel, painted or not.
   *
   * Vertex colour is an optional attribute, so after the cheatline only the
   * fuselage and radome have one. `mergeStatic` refuses inputs whose vertex
   * layouts differ -- correctly, since `MergeMeshes` would otherwise drop the
   * channel from the merged result and quietly repaint the aeroplane white --
   * so without this, adding a stripe to any other part is a build-time error
   * rather than a stripe. White is the identity for a multiply, so this costs
   * four floats a vertex and changes nothing on screen.
   */
  for (const mesh of build.meshes) {
    if (mesh.material !== body) continue;
    if (mesh.getVerticesData(VertexBuffer.ColorKind)) continue;
    const vertices = mesh.getTotalVertices();
    if (vertices === 0) continue;
    mesh.setVerticesData(
      VertexBuffer.ColorKind,
      new Array<number>(vertices * 4).fill(1),
      false,
    );
  }

  // FIRST so that `mergeStatic`'s own check is a real one: offer it the
  // tailcone here and it throws rather than hiding the tail from the pilot.
  configureCockpitLayers([fuselage, radome, windscreenFrame]);
  const fuselageShell = build.mergeStatic(
    "airliner-fuselage-shell", [fuselage, radome], root);
  build.mergeStatic("airliner-body-exterior", bodyExterior, root);
  // The fin and tailplanes are body-painted too, and are kept apart from the
  // group above only because they are `wingSurfaces` and the nacelles are not:
  // that list is forced visible in cockpit view, and a part should not pick up
  // or lose that treatment as a side effect of how it is batched.
  wingSurfaces.push(build.mergeStatic("airliner-fixed-tail", fixedTail, root));
  // ONE MESH A SIDE, and the name ENDS IN `wing` because instruments read it.
  // `scripts/wing-slot-sweep.mts` classifies every ray hit by mesh name —
  // `/wing$/` is fixed structure — and with any other name it would find no
  // fixed wing at all; `scripts/flap-joint-frames.mts` crops each side's
  // joint by the side-prefixed name, which is why the two wings are not one
  // mesh. The four panels a side sit on dihedral anchors that nothing ever
  // moves, so those are declared static and go when the panels do.
  for (const sideName of ["starboard", "port"] as const) {
    wingSurfaces.push(build.mergeStatic(
      `${sideName}-airliner-fixed-wing`,
      fixedWing[sideName].panels,
      root,
      { staticNodes: fixedWing[sideName].anchors },
    ));
  }
  build.mergeStatic("airliner-engine-cores", engineCores, root);
  build.mergeStatic("airliner-engine-inlets", engineInlets, root);
  // The flight deck's furniture, one mesh: the two seats and the two headrests. (The
  // panel, its gauges and its needles are gone: see the cockpit kit above.)
  build.mergeStatic("airliner-flight-deck-interior", flightDeckFurniture, root);
  // The glass keeps its own material, so it keeps the alpha path, the
  // disabled depth pre-pass and the airframe-transparency rendering group
  // that `finishMesh` derives from it. What it gives up is Babylon sorting
  // the six panes back to front against EACH OTHER, which only matters where
  // one pane is seen through another: side on, through the flight deck. They
  // are one glass, blended without a depth write, and two layers of the same
  // tint composite to the same colour in either order — but that is an
  // argument, not a frame, and it is the one thing here a GPU should confirm.
  const flightDeckGlass = build.mergeStatic("airliner-flight-deck-glazing", flightDeckGlazing, root);

  const rig: AirlinerRig = {
    root,
    // The contract carries ONE rotating assembly and a four-engined aeroplane
    // has four. The first spool is the one it names; all four are driven from
    // the same simulation-time phase below, so they cannot be seen out of step.
    propeller: fanSpools[0]!,
    // What the cockpit camera must not draw: the opaque skin that would block the
    // pilot's view (the fuselage and radome shell, and the centre post), and the
    // flight deck GLAZING. The glass is a refractive PBR, and a refractive
    // material draws as an opaque slab from INSIDE: from the pilot's seat it was
    // two dark trapezoids across the windscreen. What frames the view instead is
    // the cockpit-only kit (`cockpit/airlinerCockpit.ts`). No loft end cap faces
    // the pilot (the radome's rear cap, 28 m2, is at x 25.5, 4 m behind the eye,
    // and the fuselage's front cap at x 30.6 is wound outward), which
    // `tests/render.cockpit-airliner.test.ts` holds, so none is listed.
    cockpitParts: [fuselageShell, windscreenFrame, flightDeckGlass],
    cockpitOnlyParts,
    wingSurfaces,
    ailerons: [starboardAileron, portAileron],
    inboardAilerons: [starboardInboardAileron, portInboardAileron],
    /** No flaperons: this airframe's flaps and ailerons are separate surfaces. */
    flaperons: [],
    elevators,
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
    cockpitOnlyParts: rig.cockpitOnlyParts ?? [],
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
      if (cockpitViewOn) cockpit.update(state);
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
      // NEGATED, because `pose.spoilers` states a deployment angle while the
      // hinge wants the sign that lifts a trailing edge — the same sign
      // `pose.speedBrake` already carries for the other three airframes.
      for (const panel of spoilerGroups) {
        const deployed = panel.group === "ground-spoilers"
          ? pose.spoilers.ground
          : (panel.side > 0 ? pose.spoilers.flightStarboard : pose.spoilers.flightPort);
        panel.node.rotation.z = -deployed;
      }
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
      cockpitViewOn = enabled;
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
