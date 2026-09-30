import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import { loftSectionPoint, type AircraftBuildContext, type LoftSection } from "../builders";
import { TRAINER_CANOPY_SECTIONS, TRAINER_FUSELAGE_SECTIONS } from "../trainerShell";
import { DISPLAY_STATE_LEVEL } from "./displays/displayState";
import { TRAINER_DIAL_FACE_FRACTION, TRAINER_RADIO_WINDOW_ASPECT } from "./displays/displayPages";
import {
  TRAINER_DISPLAYS,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displaySlots,
  paintDisplays,
} from "./displays/displayAtlas";
import {
  basisQuaternion,
  bezelRimMaterial,
  buildAttitudeBall,
  glareshieldMaterial,
  loopSolid,
  roundedDeckSection,
  sweptSolid,
  sweptTube,
  type LoopProfile,
  type PartFrame,
  type PartLoop,
  type AttitudeBall,
  type RoundedDeckSection,
  type SweptSection,
} from "./cockpitPrimitives";
import { airspeedNeedleDegrees, altimeterNeedleDegrees, attitudeHorizonDegrees, pitchBarOffsetMetres } from "./instrumentMappings";

/**
 * What a pilot in a Cessna 150's LEFT seat sees, built to angles.
 *
 * WHY THIS EXISTS. The 150's fuselage is a closed loft whose cabin-section top
 * skin IS the window sill (y about 0, sloping to -0.06 at the cowl), and the
 * pilot's eye is 0.12 m above it, so the pilot looks down onto the OUTSIDE of
 * that skin. The cockpit camera therefore hides the tube, and everything that
 * used to be visible only because it was inside it — the panel, the dials, the
 * cowl — has to be built on this side of it. Every part here is COCKPIT-ONLY
 * (`CommonRig.cockpitOnlyParts`): invisible from any other camera, never a
 * shadow caster, so nothing in a chase or orbit frame can show a floating
 * panel or z-fight a wall it sits just inside of.
 *
 * THE TARGETS, as angles from the eye (`catalogue.cockpitEye`) at the 75
 * degree lens, and what each number below was solved to:
 *  - the glareshield top straight ahead reads -8 to -11 degrees (built at -8.35,
 *    the PM having asked for it 5 mm lower than the first build's -8.0);
 *  - the instrument row is centred -15 degrees, each dial at least 4.5 degrees
 *    across. It is the only row: three dials, as Jason asked (2026-09-23). The
 *    second row, vertical speed and engine at -21, is gone, and the panel was
 *    not re-laid out for it;
 *  - the left A-pillar stands at the frame's left edge, in the vertical plane
 *    through the eye at azimuth -41, a band 56 to 72 px wide at 1080p
 *    (`TRAINER_A_PILLAR`; the old post's axis was at -35, in the D3 window);
 *  - the cowl rises above the glareshield to about -4.7, as a Cessna's does.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at
 * negative Z. Shell numbers were MEASURED off the built meshes by
 * `scripts/cockpit-shell-clearance.mts`, and `tests/render.cockpit-trainer.test.ts`
 * holds every part to them: a loft interpolated between stations is easy to
 * transcribe wrongly.
 */

export interface TrainerCockpitMaterials {
  /** Dark matte interior: the panel board, the door frames and the A-pillars. (The hood has its own: `glareshieldMaterial`.) */
  readonly interior: PBRMaterial;
  /** The panel's fittings: the radios' bodies and knobs, the switches, and the compass. */
  readonly dark: PBRMaterial;
  /** The headliner and the sun visors: the cabin's fabric. */
  readonly headliner: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /** Needles. It carries the night glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one. */
  readonly instrumentMarking: PBRMaterial;
  /** The body paint with NO livery stripe: its livery colour equals its base colour. */
  readonly cowl: PBRMaterial;
}

/** The panel: a slab across the cabin, leaning forward at the top like the one it replaces. */
export const TRAINER_PANEL = Object.freeze({
  /** Slab centre, before the lean; the rear face's top edge is what is pinned. */
  x: 2.1,
  thickness: 0.1,
  height: 0.5,
  /** Rotation about +Z, radians; negative leans the top forward. */
  lean: -0.12,
  /**
   * Height of the panel's rear-top edge: the sill line (0), less the 5 mm the PM
   * asked the glareshield to come down. The dial centres are solved against the
   * panel's rear face, so they follow it and stay at -15 degrees.
   */
  topRearY: -0.005,
  // NO WIDTH: the board runs wall to wall, each point of it `TRAINER_GLARESHIELD.clearance` inside the cabin at its
  // own station and height (`trainerCabinHalfWidth`). It was a 0.84 m box, 2.8 cm OUTSIDE the glass at its top (the
  // cabin's half-width there, x 2.08, is 0.3915).
});

/** Real gauge size. The dials this replaces were 0.17 to 0.20 m across. */
export const TRAINER_DIAL_DIAMETER = 0.08;

/**
 * THE DIALS' BEZELS AND FACES (S2). Each dial is a ring 6 mm wide standing 3 mm proud of the board, its outer edge a
 * 2 mm 45 degree chamfer and its inner edge a 1 mm one, round a face recessed 2 mm behind its front: the face's front
 * is 1 mm proud. A ring with a square inner edge would put back the hard 90 degree rim each flat face disc had.
 *
 * ONE SOLID A RING, on the shared rim (`BEZEL_RIM`, its material and its glow law), not the Global's two (a flat frame
 * and a chamfered rim, each closed on its own): each of those closes itself at the chamfer's shoulder with a face at
 * 135 degrees to its front, and the pilot sees that edge, where one solid has only the chamfer's 45 there.
 *
 * The FACE is a disc `faceRadius / TRAINER_DIAL_FACE_FRACTION` in radius, its edge buried under the ring's inner wall
 * (so its own 90 degree rim is never in the open), and its picture is a page of the display atlas drawn to the face's
 * visible circle (`TRAINER_DIAL_FACE_FRACTION`).
 */
export const TRAINER_BEZEL = Object.freeze({
  faceRadius: 0.034,
  ringWidth: 0.006,
  proud: 0.003,
  chamfer: 0.002,
  innerChamfer: 0.001,
  faceRecess: 0.002,
  /**
   * The ring's and the face's back, 6 mm inside the board: further than an edge-visibility test's depth tolerance
   * (1.5 mm plus 0.4% of the distance, 4.3 mm at the dials), so a buried edge cannot read as one on the surface.
   */
  back: -0.006,
  /** Chords a quarter circle: 48 round. */
  cornerSegments: 12,
});

/** The face's front, out of the board's face along the dial's normal. */
const FACE_FRONT = TRAINER_BEZEL.proud - TRAINER_BEZEL.faceRecess;

/**
 * THE RADIO STACK (S2): two units, 160 x 40 mm, one above the other at the dials' height, right of them at the
 * panel's centre as on a 150. Each is a body with 3 mm rounded edges standing `proud` out of the board, a raised
 * window (its glass) on the left showing a frequency (a page of the display atlas), and two knobs on the right.
 */
export const TRAINER_RADIO = Object.freeze({
  centreZ: 0.03,
  width: 0.16,
  height: 0.04,
  gap: 0.001,
  corner: 0.003,
  proud: 0.006,
  window: Object.freeze({ across: -0.03, width: 0.07, height: 0.016, corner: 0.0015, proud: 0.0005, chamfer: 0.0004 }),
  knobs: Object.freeze([
    Object.freeze({ across: 0.045, radius: 0.0065, height: 0.01 }),
    Object.freeze({ across: 0.066, radius: 0.005, height: 0.008 }),
  ]),
  /** Top to bottom, and the atlas screen each one's window shows. */
  units: Object.freeze(["com", "nav"] as const),
});

/**
 * THE SWITCHES (S2): one row of four rockers under the airspeed dial and the attitude indicator. Each is a base with
 * a chamfered edge and a paddle with a rounded front, tilted one way or the other (on, off).
 */
export const TRAINER_SWITCHES = Object.freeze({
  across: Object.freeze([-0.335, -0.3, -0.265, -0.23]),
  /** Their centres, down the board's face from the dial row's. */
  below: 0.064,
  base: Object.freeze({ halfWidth: 0.005, halfHeight: 0.009, corner: 0.0015, proud: 0.002, chamfer: 0.0008 }),
  paddle: Object.freeze({ halfWidth: 0.0035, halfHeight: 0.0065, corner: 0.001, height: 0.004, round: 0.001, tiltDegrees: 12 }),
  /** Which are on (their paddles' tops rocked in). */
  on: Object.freeze([true, false, true, false]),
});

/**
 * THE OVERHEAD (S4): the headliner, its header, the sun visors and the compass.
 *
 * THE HEADLINER is one smooth solid under the roof slab (`trainer-cabin-roof`, y 0.18 to 0.23) and the glass crown
 * outboard of it: a rounded rectangle in plan, full width (`halfWidth`, 2.5 cm inside the glass at the ceiling's height)
 * from `aftX` to `frontX`, the slab's front edge. Its ceiling hangs `ceilingDrop` under the slab's underside, so it
 * covers the slab from inside. THE HEADER is its rim: a round of `headerRadius` standing `headerDrop` under the ceiling,
 * run into the ceiling by a concave fillet of `filletRadius`, so the ceiling, the fillet and the round meet on one
 * normal each. It is NOT a full bar hung under the edge: this cabin's roof edge is 6 cm over the eye and 24 cm ahead of
 * it, and a 5 cm bar under it brought the windscreen's top down from +14 to about +8 degrees straight ahead; standing
 * 1.2 cm down it is at +13.25 (measured, a ray up from the horizon straight ahead).
 *
 * THE VISORS, two, stowed flat under the ceiling behind the header, their fronts at about +14 degrees straight ahead;
 * each is a plate with a round edge and round corners, its outer end under the headliner's side rim.
 *
 * THE COMPASS hangs on a short stalk under the windscreen centre frame's crown member (`trainerVisual.ts`: from its
 * corner at x 2, y 0.21 aft to x 1.6, y 0.205, radius 0.024), as a 150's does from its windscreen's centre strip: a
 * rounded box with a dark face toward the pilot.
 */
export const TRAINER_OVERHEAD = Object.freeze({
  aftX: 1.2,
  frontX: 1.62,
  halfWidth: 0.305,
  cornerRadius: 0.1,
  /** The slab's underside. */
  roofY: 0.18,
  ceilingDrop: 0.002,
  headerRadius: 0.025,
  headerDrop: 0.012,
  filletRadius: 0.01,
  /**
   * How far up into the slab the headliner's top reaches (buried). Outboard of the slab's chamfered corners it stands
   * under the glass crown instead, and at 2 cm up it came within 13 mm of the built glass there; at 12 it is 4 cm off.
   */
  buried: 0.012,
  /** 300 wide each, a 5 mm gap between: their outer ends reach the headliner's side rim, under which they are buried. */
  visor: Object.freeze({ width: 0.3, depth: 0.12, thickness: 0.008, corner: 0.01, gap: 0.005, frontX: 1.565 }),
  compass: Object.freeze({ x: 1.955, width: 0.06, height: 0.06, depth: 0.07, edge: 0.008, stalkRadius: 0.004, stalk: 0.004 }),
  /** The centre frame's crown member, as `trainerVisual.ts` builds it: its axis's two ends, and its radius. */
  crown: Object.freeze({ fromX: 2, fromY: 0.21, toX: 1.6, toY: 0.205, radius: 0.024 }),
});

/** The headliner's profile, u outward from its outline and a DOWN from the slab's underside: the ceiling, the fillet, the header's round, up into the slab. */
function headlinerProfile(): LoopProfile {
  const o = TRAINER_OVERHEAD;
  const ceiling = o.ceilingDrop;
  const round = { u: -o.headerRadius, a: ceiling + o.headerDrop - o.headerRadius };
  // the fillet: tangent to the ceiling (its centre `filletRadius` under it) and to the round, outside it
  const fa = ceiling + o.filletRadius;
  const fu = round.u - Math.sqrt((o.headerRadius + o.filletRadius) ** 2 - (fa - round.a) ** 2);
  const touch = { u: fu + (o.filletRadius * (round.u - fu)) / (o.headerRadius + o.filletRadius), a: fa + (o.filletRadius * (round.a - fa)) / (o.headerRadius + o.filletRadius) };
  const fillet = [-Math.PI / 2, (-Math.PI / 2 + Math.atan2(touch.a - fa, touch.u - fu)) / 2].map((t) => ({ u: fu + o.filletRadius * Math.cos(t), a: fa + o.filletRadius * Math.sin(t) }));
  const from = Math.atan2(touch.a - round.a, touch.u - round.u);
  const chords = 8;
  const bead = Array.from({ length: chords + 1 }, (_, k) => {
    const t = from * (1 - k / chords);
    return { u: round.u + o.headerRadius * Math.cos(t), a: round.a + o.headerRadius * Math.sin(t) };
  });
  const points = [{ u: -o.cornerRadius, a: ceiling }, ...fillet, ...bead, { u: 0, a: -o.buried }, { u: -o.cornerRadius, a: -o.buried }];
  return {
    points,
    rounds: [
      { first: 1, last: 3, centre: { u: fu, a: fa }, concave: true },
      { first: 3, last: 3 + chords, centre: round },
    ],
  };
}

/** A plate `thickness` thick whose edge is a half round, about a rounded-rectangle loop; caps at its two faces. */
function roundEdgedPlate(thickness: number, corner: number): LoopProfile {
  const r = thickness / 2;
  const chords = 6;
  const edge = Array.from({ length: chords + 1 }, (_, k) => {
    const t = -Math.PI / 2 + (Math.PI * k) / chords;
    return { u: -r + r * Math.cos(t), a: r * Math.sin(t) };
  });
  return {
    points: [{ u: -corner, a: -r }, ...edge, { u: -corner, a: r }],
    rounds: [{ first: 1, last: 1 + chords, centre: { u: -r, a: 0 } }],
  };
}

/** A box about a rounded-rectangle loop, `depth` deep, its front and back edges rounded at `edge`; caps front and back. */
function roundedBoxProfile(depth: number, edge: number): LoopProfile {
  const chords = 4;
  const half = depth / 2;
  const front = Array.from({ length: chords + 1 }, (_, k) => {
    const t = (Math.PI / 2) * (1 - k / chords);
    return { u: -edge + edge * Math.cos(t), a: half - edge + edge * Math.sin(t) };
  });
  const back = Array.from({ length: chords + 1 }, (_, k) => {
    const t = (-Math.PI / 2) * (k / chords);
    return { u: -edge + edge * Math.cos(t), a: -half + edge + edge * Math.sin(t) };
  });
  return {
    points: [...front, ...back],
    rounds: [
      { first: 0, last: chords, centre: { u: -edge, a: half - edge } },
      { first: chords + 1, last: 2 * chords + 1, centre: { u: -edge, a: -half + edge } },
    ],
  };
}

/** The compass's centre: under the crown member at its station, a stalk's length below the member's underside. */
export function trainerCompassCentre(): Vector3 {
  const { compass, crown } = TRAINER_OVERHEAD;
  const axisY = crown.fromY + ((crown.toY - crown.fromY) * (compass.x - crown.fromX)) / (crown.toX - crown.fromX);
  return new Vector3(compass.x, axisY - crown.radius - compass.stalk - compass.height / 2, 0);
}

/**
 * THE ATTITUDE BALL on the "attitude" dial, which has no needle: the Global's ball
 * (`buildAttitudeBall`) at 0.6 of its size since the bezels (S2), 0.029 m inside a
 * 0.034 face, so the face's bank scale shows in the 5 mm ring round it. Its sky and
 * ground stand 0.3 mm in front of the face (`proud`) and are 0.6 mm thick, and the
 * bar 0.2 mm in front of them: all of it inside the bezel's well (its front 3 mm
 * proud, the bar's front 2.7). The bar is the Global's 0.07 x 0.003 at the same 0.6,
 * and it slides with the radius (`pitchBarOffsetMetres`), so at the 25 degree clamp it
 * is still inside the disc.
 */
export const TRAINER_ATTITUDE_BALL = Object.freeze({
  radius: 0.029,
  thickness: 0.0006,
  proud: 0.0003,
  barOffset: 0.0002,
  barLength: 0.042,
  barHeight: 0.0018,
  segments: 24,
  pivotName: "trainer-attitude-pivot",
});

/**
 * The dials, left to right, and the elevation from the eye at which the row is
 * centred. THREE DIALS, one row: Jason asked for three (2026-09-23), and the
 * second row (vertical speed and engine, at -21) went with its needles. Names are
 * the ones the builder has always used; the ORDER is the real one (airspeed left
 * of the attitude indicator, altimeter to its right), where the old layout
 * mirrored it.
 */
export const TRAINER_DIAL_ROW = Object.freeze({
  elevationDegrees: -15,
  // 4 cm INBOARD of the eye's line since the deck went wall to wall (Jason, 2026-09-29): at -0.36 the airspeed dial's
  // outer edge stood 4.3 mm OUTSIDE the cabin at its own height (the tube's shoulder, 0.3957 there), so a board kept
  // 2 cm inside the wall left the dial's rim hanging off the board's end. At -0.32 its bezel's edge lands about 1 cm
  // inside the board at every height; the attitude indicator sits 3.3 degrees right of straight ahead.
  dials: Object.freeze([["airspeed", -0.32], ["attitude", -0.22], ["altimeter", -0.12]] as const),
});

/**
 * A needle: a bar 3 mm across with a POINTER 28 mm long on one side of the dial's
 * centre and a 6 mm tail on the other, and a round hub of 6 mm radius at the
 * centre. The hub is merged into the needle's own mesh so the mesh count does not
 * grow, and it is a little thicker than the bar so it stands proud of it. It is
 * asymmetric because a needle turned through 300 degrees has to say which end is
 * the tip; the bar it replaces was symmetric about the hub.
 */
export const TRAINER_NEEDLE = Object.freeze({
  width: 0.003,
  pointerLength: 0.028,
  tailLength: 0.006,
  /** Along the dial's axis: thin enough to turn inside the bezel's 2 mm well (S2); the hub stands a little prouder. */
  thickness: 0.0012,
  hubRadius: 0.006,
  hubThickness: 0.0016,
});

/**
 * The airspeed dial's full-scale reading, knots: -150 degrees at 0 to +150 here,
 * clamped. A property of THIS dial (the catalogue has no airspeed maximum for any
 * airframe), so it lives beside the layout it belongs to.
 */
export const TRAINER_AIRSPEED_FULL_SCALE_KNOTS = 160;

/** Where a needle's origin stands along the dial's normal: on the face's front, at its centre. */
const NEEDLE_ORIGIN_OFFSET = FACE_FRONT;

/**
 * How far in front of its origin the needle's geometry stands, along the dial's normal: the bar's centre 0.3 mm plus
 * half its thickness in front of the face's front, so the bar is 1.3 to 2.5 mm proud and the hub to 2.7, inside the
 * bezel's front at 3. The ORIGIN stays on the dial's axis at the face's centre, so the needle turns about the axis;
 * only the geometry stands proud of it.
 */
const NEEDLE_STAND_OFF = FACE_FRONT + 0.0003 + TRAINER_NEEDLE.thickness / 2 - NEEDLE_ORIGIN_OFFSET;

/**
 * The half-width at station `x` and height `y` of a loft's RULED SURFACE between its rings, read the way the loft lays
 * it: each ring's point at one phase, straight between the two rings either side of `x`. Rings past either end are
 * held. NaN where `y` is above the crown or below the keel there. The loft's own facets (a ring's points joined by
 * chords) sit up to a few millimetres inside this, which every clearance below leaves room for.
 */
export function loftHalfWidthAt(sections: readonly LoftSection[], x: number, y: number): number {
  let low = sections[0]!;
  let high = low;
  if (x > low.x) {
    high = sections[sections.length - 1]!;
    low = high;
    for (let i = 1; i < sections.length; i += 1) {
      if (x <= sections[i]!.x) {
        low = sections[i - 1]!;
        high = sections[i]!;
        break;
      }
    }
  }
  const t = high.x === low.x ? 0 : (x - low.x) / (high.x - low.x);
  const at = (phase: number) => {
    const a = loftSectionPoint(low, phase);
    const b = loftSectionPoint(high, phase);
    return { y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  if (y > at(0).y || y < at(Math.PI).y) return Number.NaN;
  // down the starboard flank from the crown (phase 0) to the keel (pi), where the height only falls
  let crown = 0;
  let keel = Math.PI;
  for (let step = 0; step < 50; step += 1) {
    const middle = (crown + keel) / 2;
    if (at(middle).y > y) crown = middle;
    else keel = middle;
  }
  return at((crown + keel) / 2).z;
}

/**
 * The cabin's inner half-width at (x, y): the tube's wall where the tube is, the greenhouse's glass where the glass
 * is, the wider where the two closed bodies overlap (the glass's foot is buried in the tube). The cockpit camera hides
 * both (`cockpitParts`), so what bounds a part the pilot sees is this, less a clearance.
 */
export function trainerCabinHalfWidth(x: number, y: number): number {
  const widths = [loftHalfWidthAt(TRAINER_FUSELAGE_SECTIONS, x, y), loftHalfWidthAt(TRAINER_CANOPY_SECTIONS, x, y)].filter(Number.isFinite);
  return widths.length > 0 ? Math.max(...widths) : Number.NaN;
}

/**
 * THE DECK: a rounded glareshield (`roundedDeckSection`, the Global's, the 747's and the F-16's), WALL TO WALL. Its
 * round stands on the deck line's sight line (`deckLineDegrees`): a horizontal line across the cabin projects to one
 * row of the picture at any distance, so the round is the same silhouette the old hood was, and the 2D HUD, laid out
 * on the deck line, does not move. Under the round
 * a 45 degree cove turns in 1 cm to the board's face; forward of it the hood falls 12 degrees, steeper than the sight
 * line, so none of its top is seen from the seat. Across the cabin it runs from one door frame's rail to the other's,
 * each end buried in its rail (`TRAINER_DOOR_FRAME`): no end of it is in the open.
 */
export const TRAINER_GLARESHIELD = Object.freeze({
  /**
   * The catalogue's deck line (`cockpitDeckLineDegrees`, 8.31), which the 2D HUD is laid out above: the OLD hood's
   * silhouette. That hood's top face sloped less than the sight line, so the pilot saw its front edge, 0.04 degrees
   * over its aft edge's 8.35 straight ahead; the round stands on the silhouette, so the HUD does not move.
   */
  deckLineDegrees: aircraftSpec("trainer").cockpitDeckLineDegrees,
  radius: 0.025,
  drop: 0,
  cove: 0.01,
  hoodFallDegrees: 12,
  /**
   * Where the hood stops: just forward of the round. Out of sight behind the round wherever it ends, and a longer hood
   * would have to narrow with the windscreen, which turns the deck's ends toward the pilot.
   */
  hoodEndX: 2.11,
  roundSegments: 6,
  /** How far inside the glass or the wall every point of the deck and the board stands. */
  clearance: 0.02,
});

/** The board's rear (pilot-facing) face as a line in body x and y: its x at height y. */
function rearFaceXAt(y: number): number {
  const { centre, local } = panelFrame();
  const bottom = centre.add(local(-TRAINER_PANEL.thickness / 2, -TRAINER_PANEL.height / 2));
  const top = centre.add(local(-TRAINER_PANEL.thickness / 2, TRAINER_PANEL.height / 2));
  return bottom.x + ((top.x - bottom.x) * (y - bottom.y)) / (top.y - bottom.y);
}

/**
 * The deck's section in body x and y. Its aft face is SOLVED, not chosen: the cove's foot has to land on the board's
 * rear face as it stands, so the board and the dials solved against it (-15 degrees) stay where they are.
 */
export function trainerDeckSection(): RoundedDeckSection {
  const g = TRAINER_GLARESHIELD;
  const eye = aircraftSpec("trainer").cockpitEye;
  const section = (aftX: number) => roundedDeckSection(eye, aftX, g.deckLineDegrees, { ...g, hoodDepth: g.hoodEndX - aftX }, "the Cessna");
  const miss = (aftX: number) => { const foot = section(aftX).faceTop; return foot.x - rearFaceXAt(foot.y); };
  let aft = 1.9;
  let fore = 2.15;
  for (let step = 0; step < 60; step += 1) {
    const middle = (aft + fore) / 2;
    if (miss(middle) < 0) aft = middle;
    else fore = middle;
  }
  return section((aft + fore) / 2);
}

/**
 * A section swept ACROSS the cabin, from one door frame to the other: a station at each end, each section point out to
 * its own `half` there (the rail runs in with the glass as it goes forward, so an end follows it), and one `END_LEAD_IN`
 * inboard of each. The ends are square, flat and BURIED, inside the rail and the face under it (`TRAINER_DOOR_FRAME`).
 * They were filleted into the walls on a 2 cm round (S1), and those rounds still met the door panels along creases the
 * pilot saw.
 *
 * WHY THE LEAD-INS: `sweptSolid` averages a round's end point over the triangles that meet there, and at a sweep's end
 * station its two walls meet it unequally (one triangle of one, two of the other, and the other way about at the far
 * end). With the two end stations alone, the deck's cove line was shaded 15 degrees differently at its two ends. A
 * station one millimetre in from each end is met equally from both sides, so the whole run between them shades alike.
 */
function sweptAcross(
  build: AircraftBuildContext,
  name: string,
  section: SweptSection,
  material: PBRMaterial,
  root: TransformNode,
  half: (point: { readonly u: number; readonly y: number }) => number,
) {
  const stations = [{ side: -1, inset: 0 }, { side: -1, inset: END_LEAD_IN }, { side: 1, inset: END_LEAD_IN }, { side: 1, inset: 0 }];
  return sweptSolid(
    build,
    name,
    section,
    stations.length,
    (i, point) => {
      const out = half(point);
      if (!Number.isFinite(out)) throw new RangeError(`${name}: no cabin wall for the point at x ${point.u.toFixed(3)}, y ${point.y.toFixed(3)}`);
      const { side, inset } = stations[i]!;
      return new Vector3(point.u, point.y, side * (out - inset));
    },
    (direction) => new Vector3(direction.u, direction.y, 0),
    material,
    root,
    // a round's end points take the mean of its last chord and the face it meets, as S1's did: the deck's round meets
    // its cove on one normal, a designed line and not a split one
    { smoothAlong: true },
  );
}

/** The lead-in stations' distance inboard of each end (`sweptAcross`): inside the rail, with the end. */
const END_LEAD_IN = 0.001;

/** Points down the board's rear face, besides its top and foot, for its ends to follow the wall's curve by. */
const BOARD_FACE_POINTS = 8;

/**
 * THE DOOR FRAMES (S3), one a side, in place of three boxes (a panel up to a knee at -0.2, a slab leaning in from there
 * to the sill, and a 40 x 20 mm cap along it) and the seam where the two slabs met. Each is three pieces on the same
 * stations along x, following the cabin line at every one, merged into one mesh:
 *  - THE RAIL, a round of `railRadius` along the sill (`sweptTube`), its top `railOverDeck` over the deck's, and the
 *    glass's clearance (`TRAINER_GLARESHIELD.clearance`) inside it at every point of its round. Forward of the deck's
 *    round it falls under the deck line (`railCentre`), so none of it shows past the deck's end.
 *  - THE FACE under it, a `sweptSolid` tucked up into the rail, down to the NOTCH, where the glass's foot meets the
 *    tube's shoulder (the cabin line turns in there, so no one convex section can run past it).
 *  - THE PANEL, the notch to the floor, `wallClearance` inside the tube's wall; its inner face is the face's run on in
 *    one straight line from the rail's underside to the floor, so neither the notch nor the old knee is a seam.
 * The face leaves the rail at its underside, not its inner side: 1.5 cm further out, which keeps it off the airspeed
 * dial's left edge (a face from the rail's inner side stood 2 to 9 mm into that dial's sight line and hid 3.2% of it).
 * The deck's ends and the board's are buried in the rails and the faces: the deck runs into its door frames as the
 * F-16's rail runs into its sills (Jason, 2026-09-29: "sweep into the door frame"). The pillars stand in the rails
 * (`TRAINER_A_PILLAR`).
 */
export const TRAINER_DOOR_FRAME = Object.freeze({
  fromX: 0.95,
  /** The hood's end: forward of the board's rear face at every height, so both ends are buried to there. */
  toX: 2.11,
  railRadius: 0.015,
  /** The rail's top over the deck's top, so the deck's end is inside the rail. */
  railOverDeck: 0.0005,
  /**
   * How far outboard of the rail's centre line the deck's and the board's ends stand where they are under the rail's
   * centre: inside the face, not at its inner edge. Above it the deck's end is at the rail's crest, under its top.
   */
  endInset: 0.005,
  floorY: -0.6,
  /** Below the sill, where the cabin line is the tube's wall: the old panels' outer face's 1 cm. */
  wallClearance: 0.01,
  /** The panel at the floor. The inner face leans out from the rail's underside to here. */
  floorThickness: 0.02,
  railSegments: 16,
});

/**
 * The door frames' stations along x: 0.25 m apart aft, where the cabin runs straight, 0.04 m forward, where it narrows,
 * and one where the rail's crest stops running level and starts down the deck line's sight plane (`trainerRailCentre`):
 * the crest is straight between stations, and without that one it dipped 0.1 mm under the deck's round, whose end then
 * showed over it.
 */
export function trainerDoorStations(): number[] {
  const f = TRAINER_DOOR_FRAME;
  // the kink: the last x at which the crest is still level (it only falls from there)
  const level = deckTopY() + f.railOverDeck;
  let before: number = f.fromX;
  let after: number = f.toX;
  for (let step = 0; step < 50; step += 1) {
    const middle = (before + after) / 2;
    if (railCrestAt(middle) >= level) before = middle;
    else after = middle;
  }
  const kink = before;
  const stations = [f.fromX, 1.2, 1.4];
  for (let x = 1.5; x < f.toX - 1e-9; x += 0.04) stations.push(x);
  stations.push(f.toX);
  if (kink > f.fromX && kink < f.toX && stations.every((x) => Math.abs(x - kink) > 1e-4)) stations.push(kink);
  return stations.sort((a, b) => a - b);
}

let deckTopMemo: number | null = null;
/** The deck's top: the round's highest point, on the deck line straight ahead. */
function deckTopY(): number {
  deckTopMemo ??= Math.max(...trainerDeckSection().outline.map((p) => p.y));
  return deckTopMemo;
}

/** The clearance a point of a door frame keeps inside the cabin line: the glass's 2 cm at and above the sill, the wall's 1 cm below it. */
function doorClearance(y: number): number {
  return y >= 0 ? TRAINER_GLARESHIELD.clearance : TRAINER_DOOR_FRAME.wallClearance;
}

/** Points round a section's round that `insetOutboard` holds inside the cabin line. */
const ROUND_SAMPLES = 32;

/**
 * The largest outboard distance (|z|) of the centre of a round of radius `r` in the cross-section at (x, y) with every
 * point of the round the clearance (`doorClearance`) inside the cabin line at its own height; 0 where some point of it
 * has no cabin line (above the crown). In closed form: a point's allowance does not depend on the centre's u, so the
 * centre may go out as far as the tightest point allows, and no search is needed.
 */
function insetOutboard(x: number, y: number, r: number): number {
  let out = Number.POSITIVE_INFINITY;
  for (let k = 0; k < ROUND_SAMPLES; k += 1) {
    const a = (k / ROUND_SAMPLES) * 2 * Math.PI;
    const py = y + r * Math.sin(a);
    const half = trainerCabinHalfWidth(x, py);
    if (!Number.isFinite(half)) return 0;
    out = Math.min(out, half - doorClearance(py) - r * Math.cos(a));
  }
  return Math.max(0, out);
}

/**
 * The rail's centre at station x, in (u, y), u outboard. Its height: its crest `railOverDeck` over the deck's top, or on
 * the deck line's sight plane there (0.3 mm over it, a fiftieth of a degree), whichever is lower: a level rail run on
 * past the deck's round rises over the deck line, and the round's top is ON that line where it is tangent to it, so the
 * crest cannot be lower and still cover the deck's end. Its u: as far out as it goes with every point of its round the
 * clearance (`doorClearance`) inside the cabin line at its own height.
 */
/**
 * The rail's crest at station x: `railOverDeck` over the deck's top, level, until it meets the deck line's sight plane
 * (0.3 mm over it, a fiftieth of a degree: the deck's round touches that plane, and the crest has to cover its end);
 * forward of the round's touching point it falls under the plane, halfway to the hood's top, which falls away faster
 * (12 degrees to the plane's 8.31), so the rail's forward end is hidden behind the round and still covers the deck's.
 * The deck line is a ROW of the picture: a point is on it where its height over its depth along the view (x, not the
 * distance) is the deck line's slope, at any azimuth.
 */
function railCrestAt(x: number): number {
  const eye = aircraftSpec("trainer").cockpitEye;
  const slope = Math.tan((TRAINER_GLARESHIELD.deckLineDegrees * Math.PI) / 180);
  const touch = trainerDeckSection().tangent.x;
  const under = (Math.tan((TRAINER_GLARESHIELD.hoodFallDegrees * Math.PI) / 180) - slope) / 2;
  const sight = eye.up - (x - eye.forward) * slope + 0.0003 - under * Math.max(0, x - touch);
  return Math.min(deckTopY() + TRAINER_DOOR_FRAME.railOverDeck, sight);
}

const railCentres = new Map<number, { u: number; y: number }>();
export function trainerRailCentre(x: number): { u: number; y: number } {
  const known = railCentres.get(x);
  if (known) return { ...known };
  const r = TRAINER_DOOR_FRAME.railRadius;
  const y = railCrestAt(x) - r;
  const centre = { u: insetOutboard(x, y, r), y };
  railCentres.set(x, centre);
  return { ...centre };
}

/** Heights the panel's outer face is laid down the tube's wall at, under the notch. */
const PANEL_WALL_HEIGHTS = [-0.1, -0.15, -0.2, -0.3, -0.4, -0.5];

/** The NOTCH's height at station x: under the rail, where the tube's shoulder first stands out past the glass's foot. */
function doorNotchY(x: number): number {
  let y = -0.01;
  for (; y > -0.1; y -= 0.0025) {
    const tube = loftHalfWidthAt(TRAINER_FUSELAGE_SECTIONS, x, y);
    const glass = loftHalfWidthAt(TRAINER_CANOPY_SECTIONS, x, y);
    if (Number.isFinite(tube) && (!Number.isFinite(glass) || tube >= glass)) break;
  }
  return y;
}

/**
 * A door frame at a station, in (u, y) with u outboard: the rail's centre; THE FACE, its notch corners (inner, outer)
 * and its top corners (outer, inner) up inside the rail; and THE PANEL, the floor's corners (inner, outer), up the
 * wall, and the notch's corners (outer, inner). The face's inner edge and the panel's are one straight line, from the
 * rail's lowest point to the floor's inner corner.
 */
export function trainerDoorSections(x: number): { rail: { u: number; y: number }; face: { u: number; y: number }[]; panel: { u: number; y: number }[] } {
  const f = TRAINER_DOOR_FRAME;
  const r = f.railRadius;
  const rail = trainerRailCentre(x);
  const notchY = doorNotchY(x);
  const floorOut = { u: trainerCabinHalfWidth(x, f.floorY) - f.wallClearance, y: f.floorY };
  const floorIn = { u: floorOut.u - f.floorThickness, y: f.floorY };
  const under = { u: rail.u, y: rail.y - r };
  const inner = (y: number) => ({ u: under.u + ((floorIn.u - under.u) * (under.y - y)) / (under.y - floorIn.y), y });
  // the face's outer edge: straight down from inside the rail's round to the notch, the glass's clearance inside it
  const outerU = Math.min(rail.u + 0.7 * r, trainerCabinHalfWidth(x, notchY + 0.0025) - TRAINER_GLARESHIELD.clearance);
  const notchOut = { u: outerU, y: notchY };
  const notchIn = inner(notchY);
  const wall = PANEL_WALL_HEIGHTS.map((y) => ({ u: trainerCabinHalfWidth(x, y) - f.wallClearance, y }));
  return {
    rail,
    face: [notchIn, notchOut, { u: outerU, y: rail.y }, inner(rail.y)],
    panel: [floorIn, floorOut, ...wall.slice().reverse(), notchOut, notchIn],
  };
}

/**
 * THE A-PILLARS (S3), one a side, in place of two 8-sided struts that stood vertical at azimuth -35 and stopped in
 * mid-air above the frame. Each is one `sweptTube`, `footRadius` at its foot in the rail, tapering to `topRadius`
 * where it ends inside the roof slab, and it is the door's frame round the window:
 *  - THE PILLAR rises along the glass, the clearance inside it, from the rail to `glassTopY`, its centreline in the
 *    vertical plane through the eye at `azimuthDegrees`, so from the seat it stands as one column at the frame's edge;
 *  - it then bends aft into THE CANT RAIL, along the crown over the door at `railY`, the clearance inside the glass,
 *    from `railFromX` to `railToX`;
 *  - and turns in and up into the roof slab's side (the slab is y 0.18 to 0.23, its side edge at |z| 0.31) behind
 *    the eye, ending at `end`, at the slab's mid-thickness.
 * Only the pillar is in the frame: the bend and the cant rail are at azimuth -45 to -90, and the lens is
 * horizontal-fixed, so the frame's edge is -37.5 at every aspect.
 *
 * WHY THERE, and not up the windscreen's forward edge from the deck's end: the glass stands only 0.14 m outboard of the
 * eye, and the roof's outboard front corner is 6 cm ahead of it, so a pillar from the deck's end into the roof crosses
 * the view. Measured through the cockpit camera (rasterised, near-plane clipped): feet at x 1.7 to 2.0 cover 110,000 to
 * 295,000 px and cut the windscreen at azimuth -11 to -35. In the plane at -41 the pillar covers 49,192 px, a band 56
 * to 72 px wide up the frame's left edge from its bottom to row 220 of 1080: the window's frame at the edge of the view,
 * as the old post was (172,800 px), at under a third of its area. And WHY THE CANT RAIL: the crown is too low over the pilot to turn into the
 * roof ahead of him (the slab's edge stands only 2.5 cm under the glass), and a pillar that bent into it along its own
 * plane, which runs through the eye, passed 10 cm from the eye: 165,000 px.
 */
export const TRAINER_A_PILLAR = Object.freeze({
  azimuthDegrees: -41,
  footRadius: 0.02,
  topRadius: 0.014,
  /** Its foot's centre, inside the rail. */
  footY: -0.005,
  /** How high the pillar follows the glass in its plane. */
  glassTopY: 0.13,
  glassStations: 14,
  /** The cant rail's height, and where it runs, aft along the crown (x). */
  railY: 0.15,
  railFromX: 1.4,
  railToX: 1.26,
  /** The roof slab's underside (`trainer-cabin-roof`, 0.05 thick at y 0.205): under it the pillar keeps inside the glass. */
  roofUnderY: 0.18,
  /** Its end's centre, inside the roof slab behind the eye: |z| 0.285, its ring 1.1 cm inside the slab's edge. */
  end: Object.freeze({ x: 1.18, y: 0.205, u: 0.285 }),
  bendStations: 10,
  segments: 16,
});

/**
 * The root of an increasing `f` between `lo` and `hi` (f(lo) < 0 < f(hi)), by regula falsi with the Illinois step: a
 * few evaluations where a bisection to the same 0.1 micron takes 30, and each one here samples the cabin line 32 times.
 */
function increasingRoot(f: (x: number) => number, lo: number, hi: number): number {
  let [a, b] = [lo, hi];
  let [fa, fb] = [f(a), f(b)];
  if (!(fa < 0 && fb > 0)) throw new RangeError(`no root between ${lo} and ${hi}`);
  let side = 0;
  for (let step = 0; step < 60 && b - a > 1e-7; step += 1) {
    const c = (a * fb - b * fa) / (fb - fa);
    const fc = f(c);
    // ON the root: stop. A step that lands on it with a rounding-positive value leaves `a` where it was, and the
    // halvings then walk the next steps back into the bracket, to wherever the step count runs out.
    if (Math.abs(fc) < 1e-12) return c;
    if (fc < 0) {
      [a, fa] = [c, fc];
      if (side === -1) fb /= 2;
      side = -1;
    } else {
      [b, fb] = [c, fc];
      if (side === 1) fa /= 2;
      side = 1;
    }
  }
  return a;
}

let pillarMemo: { centres: Vector3[]; radii: number[] } | null = null;
/** A pillar's centreline and its radius at each point, foot to end (port; the starboard one is its mirror). */
export function trainerPillarPath(side: -1 | 1): { centres: Vector3[]; radii: number[] } {
  pillarMemo ??= portPillarPath();
  return {
    centres: pillarMemo.centres.map((c) => new Vector3(c.x, c.y, side < 0 ? c.z : -c.z)),
    radii: pillarMemo.radii.slice(),
  };
}

function portPillarPath(): { centres: Vector3[]; radii: number[] } {
  const p = TRAINER_A_PILLAR;
  const eye = aircraftSpec("trainer").cockpitEye;
  const slope = Math.tan((p.azimuthDegrees * Math.PI) / 180);
  const zAt = (x: number) => eye.right + slope * (x - eye.forward);
  // radii are laid by arc length afterwards; the solve needs one, and the foot's is the largest
  const r = p.footRadius;
  // up the glass, evenly: at each height, the station in the plane where the pillar's round is the clearance inside
  // the glass. (Bunched toward the top, the last two stood 0.7 mm apart where the tube turns into its bend, and the
  // turn tilted one ring 2 mm behind the other: a fold.)
  const glass: Vector3[] = [];
  for (let i = 0; i <= p.glassStations; i += 1) {
    const y = p.footY + ((p.glassTopY - p.footY) * i) / p.glassStations;
    const x = increasingRoot((at) => Math.abs(zAt(at)) - insetOutboard(at, y, r), eye.forward + 0.01, 2.2);
    glass.push(new Vector3(x, y, zAt(x)));
  }
  const cubic = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, count: number) => Array.from({ length: count }, (_, k) => {
    const t = (k + 1) / count;
    const u = 1 - t;
    return a.scale(u ** 3).add(b.scale(3 * u * u * t)).add(c.scale(3 * u * t * t)).add(d.scale(t ** 3));
  });
  const aft = new Vector3(-1, 0, 0);
  // the cant rail's two ends, the clearance inside the glass at its height
  const railAt = (x: number) => new Vector3(x, p.railY, -insetOutboard(x, p.railY, r));
  const [railFrom, railTo] = [railAt(p.railFromX), railAt(p.railToX)];
  const top = glass[glass.length - 1]!;
  const up = top.subtract(glass[glass.length - 2]!).normalize();
  const over = Vector3.Distance(top, railFrom);
  // the glass's crown is convex, so a curve between two points on its inset runs outside it: each station under the
  // roof is held in to the inset at its own height as well (in the roof there is no glass to keep inside of)
  const held = (c: Vector3) => (c.y + r < p.roofUnderY ? new Vector3(c.x, c.y, -Math.min(Math.abs(c.z), insetOutboard(c.x, c.y, r))) : c);
  const bend = cubic(top, top.add(up.scale(0.25 * over)), railFrom.subtract(aft.scale(0.4 * over)), railFrom, p.bendStations).map(held);
  const run = [0.25, 0.5, 0.75, 1].map((t) => Vector3.Lerp(railFrom, railTo, t));
  const end = new Vector3(p.end.x, p.end.y, -p.end.u);
  const into = Vector3.Distance(railTo, end);
  const turn = cubic(railTo, railTo.add(aft.scale(0.4 * into)), end.subtract(new Vector3(0, 0.5 * into, 0)), end, p.bendStations).map(held);
  const centres = [...glass, ...bend, ...run, ...turn];
  // the taper, by arc length: `footRadius` at the foot to `topRadius` at the end
  const along = [0];
  for (let i = 1; i < centres.length; i += 1) along.push(along[i - 1]! + Vector3.Distance(centres[i]!, centres[i - 1]!));
  const length = along[along.length - 1]!;
  return { centres, radii: along.map((s) => p.footRadius + ((p.topRadius - p.footRadius) * s) / length) };
}

/** Rotation about Z of the panel and everything mounted on it. */
function panelFrame() {
  const { x, thickness, height, lean, topRearY } = TRAINER_PANEL;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  // R(lean) applied to a local (lx, ly): (lx cos - ly sin, lx sin + ly cos).
  const local = (lx: number, ly: number) => new Vector3(lx * cos - ly * sin, lx * sin + ly * cos, 0);
  const rearTop = local(-thickness / 2, height / 2);
  const centre = new Vector3(x, topRearY - rearTop.y, 0);
  return {
    centre,
    /** A point on the rear (pilot-facing) face, and that face's normal (toward the pilot). */
    rearFacePoint: centre.add(local(-thickness / 2, 0)),
    rearFaceNormal: new Vector3(-cos, -sin, 0),
    local,
  };
}

/** Intersection of a ray from the eye, at `elevationDegrees` in the eye's own vertical plane, with the panel's rear face. */
function dialCentreOnPanel(elevationDegrees: number): Vector3 {
  const eye = aircraftSpec("trainer").cockpitEye;
  const { rearFacePoint, rearFaceNormal } = panelFrame();
  const el = (elevationDegrees * Math.PI) / 180;
  const direction = new Vector3(Math.cos(el), Math.sin(el), 0);
  const origin = new Vector3(eye.forward, eye.up, 0);
  const t = Vector3.Dot(rearFacePoint.subtract(origin), rearFaceNormal) / Vector3.Dot(direction, rearFaceNormal);
  return origin.add(direction.scale(t));
}

/** Where every dial's centre is, in body coordinates, and the direction its face looks (toward the pilot). */
export function trainerDialPlacements(): readonly { name: string; centre: Vector3; normal: Vector3 }[] {
  const { rearFaceNormal } = panelFrame();
  const onFace = dialCentreOnPanel(TRAINER_DIAL_ROW.elevationDegrees);
  return TRAINER_DIAL_ROW.dials.map(([name, z]) => ({ name, centre: new Vector3(onFace.x, onFace.y, z), normal: rearFaceNormal.clone() }));
}

/** A part's plane on the board's rear face: its centre there, across the cabin (+Z), up the face, and out toward the pilot. */
function faceFrame(origin: Vector3): PartFrame {
  const out = panelFrame().rearFaceNormal;
  const across = new Vector3(0, 0, 1);
  return { origin, across, up: Vector3.Cross(out, across).normalize(), out };
}

/** The dial row's centre on the board's face, at `z`. */
function onDialRow(z: number): Vector3 {
  const at = dialCentreOnPanel(TRAINER_DIAL_ROW.elevationDegrees);
  return new Vector3(at.x, at.y, z);
}

/** Each dial's plane: centred on its placement. */
export function trainerDialFrames(): readonly { name: string; frame: PartFrame }[] {
  return trainerDialPlacements().map(({ name, centre }) => ({ name, frame: faceFrame(centre) }));
}

/** Each radio unit's plane, top to bottom: centred on the unit, at the board's face. */
export function trainerRadioFrames(): readonly { unit: (typeof TRAINER_RADIO.units)[number]; frame: PartFrame }[] {
  const r = TRAINER_RADIO;
  const row = faceFrame(onDialRow(r.centreZ));
  return r.units.map((unit, k) => ({ unit, frame: { ...row, origin: row.origin.add(row.up.scale(((k === 0 ? 1 : -1) * (r.height + r.gap)) / 2)) } }));
}

/** Each switch's plane: centred on its base, at the board's face. */
export function trainerSwitchFrames(): readonly PartFrame[] {
  return TRAINER_SWITCHES.across.map((z) => {
    const row = faceFrame(onDialRow(z));
    return { ...row, origin: row.origin.subtract(row.up.scale(TRAINER_SWITCHES.below)) };
  });
}

/** The same frame moved `across` and `up` in its plane and `out` of it. */
function shifted(frame: PartFrame, across: number, up: number, out = 0): PartFrame {
  return { ...frame, origin: frame.origin.add(frame.across.scale(across)).add(frame.up.scale(up)).add(frame.out.scale(out)) };
}

/** A profile whose front is a flat cap out to `radius` in from the loop, then a quarter round of `radius` down to its side, the side down to `back`. */
function roundedFrontProfile(front: number, radius: number, back: number, chords = 4): LoopProfile {
  const round = Array.from({ length: chords + 1 }, (_, k) => {
    const angle = (Math.PI / 2) * (1 - k / chords);
    return { u: -radius + radius * Math.cos(angle), a: front - radius + radius * Math.sin(angle) };
  });
  return {
    points: [...round, { u: 0, a: back }, { u: -radius, a: back }],
    rounds: [{ first: 0, last: chords, centre: { u: -radius, a: front - radius } }],
  };
}

/**
 * A profile whose front is a flat cap out to `inset` in from the loop, then a 45 degree chamfer of `chamfer` to its side,
 * the side down to `back`. The chamfer is SHADED AS A ROUND (its two ends take the front's and the side's normals), so
 * it reads as an eased edge and meets both on one normal: a flat-shaded 45 degree chamfer is a split edge at exactly
 * the census's threshold.
 */
function chamferedFrontProfile(front: number, inset: number, chamfer: number, back: number): LoopProfile {
  return {
    points: [{ u: -inset, a: front }, { u: -chamfer, a: front }, { u: 0, a: front - chamfer }, { u: 0, a: back }, { u: -inset, a: back }],
    rounds: [{ first: 1, last: 2, centre: { u: -chamfer, a: front - chamfer } }],
  };
}

/**
 * Give the front of a face part (its vertices shaded straight out of `frame`) the UVs of a rectangle of the atlas: the
 * part's `halfWidth` x `halfHeight` about the frame's origin onto `slot`, or onto the band `bandHeight` high across its
 * middle. U runs with the frame's across (+Z, the pilot's right); V runs AGAINST its up, as the screens' do
 * (`remapScreenFaceToSlot`: a texture's v and a canvas's y run opposite ways).
 */
function mapFaceToSlot(
  mesh: Mesh,
  frame: PartFrame,
  halfWidth: number,
  halfHeight: number,
  slot: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  atlas: { readonly width: number; readonly height: number },
  bandHeight = slot.h,
): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
  const top = slot.y + (slot.h - bandHeight) / 2;
  for (let v = 0; v < positions.length / 3; v += 1) {
    const normal = new Vector3(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    if (Vector3.Dot(normal, frame.out) < 0.999) continue;
    const d = new Vector3(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!).subtract(frame.origin);
    const fx = Vector3.Dot(d, frame.across) / (2 * halfWidth) + 0.5;
    const fy = Vector3.Dot(d, frame.up) / (2 * halfHeight) + 0.5;
    uvs[v * 2] = (slot.x + fx * slot.w) / atlas.width;
    uvs[v * 2 + 1] = (top + (1 - fy) * bandHeight) / atlas.height;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
}

/** What `buildTrainerCockpit` hands back: the meshes, and the step that turns the needles and the ball. */
export interface TrainerCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /** The dials' bezels' material (`BEZEL_RIM`): the visual drives its emissive by `bezelRimEmissive`. */
  readonly bezelMaterial: PBRMaterial;
  /** True when the dial faces and the radios' windows carry the live atlas: false under `NullEngine`. */
  readonly displaysLive: boolean;
  /**
   * Turn each driven needle and the attitude ball to what `state` reads. The
   * visual calls this from its `update` ONLY while cockpit view is on: outside it
   * the parts are invisible and the rotations a frame would be spent on nothing.
   */
  update(state: FlightVisualState): void;
}

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks
 * them cockpit-only (`configureCockpitOnlyParts`) and registers them, so the
 * rule is applied in one place.
 *
 * Fifteen meshes in five groups: the cowl stand-in (1), the deck and the board
 * (2), the A-pillars (2), the door frames (2: each its rail, face and panel
 * merged), and the dials (8: three gauge faces, two needles, and the attitude
 * ball's three pieces).
 */
export function buildTrainerCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: TrainerCockpitMaterials,
): TrainerCockpit {
  const parts: AbstractMesh[] = [];
  const needles = new Map<string, { mesh: AbstractMesh; frame: Quaternion }>();
  let attitudeBall: AttitudeBall | null = null;

  // THE COWL STAND-IN. The real cowl is part of the fuselage loft, which the
  // cockpit camera cannot show. This lofts the SAME sections from the one
  // nearest the firewall (x 2.10) forward to the nose, so it lies exactly on the
  // shell it stands in for: the loft has one ring per section and no
  // interpolation, so a loft of the same two rings is the same ruled surface.
  const firewall = TRAINER_FUSELAGE_SECTIONS.reduce(
    (best, section, index) => (Math.abs(section.x - 2.1) < Math.abs(TRAINER_FUSELAGE_SECTIONS[best]!.x - 2.1) ? index : best),
    0,
  );
  parts.push(build.loft(
    "trainer-cowl-standin",
    TRAINER_FUSELAGE_SECTIONS.slice(firewall),
    24,
    materials.cowl,
    root,
  ));

  // THE DECK AND THE BOARD, two meshes, each a section swept across the cabin from one door frame to the other
  // (`sweptAcross`): the deck the rounded glareshield (`trainerDeckSection`) on its own matte near-black, which reflects
  // nothing (on the interior material its top read as the brightest surface in the frame); the board the leaned panel
  // under it, its rear face exactly where the old box's was, from its foot up to the cove's, with extra points down that
  // face so each end can follow the wall's curve at every height. Every end is buried in a door frame.
  const { centre, local } = panelFrame();
  const panel = TRAINER_PANEL;
  const deck = trainerDeckSection();
  parts.push(sweptAcross(
    build,
    "trainer-glareshield",
    {
      points: deck.outline.map((p) => ({ u: p.x, y: p.y })),
      rounds: [{ first: 3, last: deck.outline.length - 1, centre: { u: deck.centre.x, y: deck.centre.y } }],
    },
    glareshieldMaterial(build, "trainer-glareshield"),
    root,
    // at the point's own station: the rail's crest line over its centre (under the rail's top), outboard of it below
    // (inside the face)
    (point) => {
      const rail = trainerRailCentre(point.u);
      return rail.u + (point.y < rail.y ? TRAINER_DOOR_FRAME.endInset : 0);
    },
  ));
  const along = new Vector3(Math.cos(panel.lean), Math.sin(panel.lean), 0);
  const rearBottom = centre.add(local(-panel.thickness / 2, -panel.height / 2));
  const frontBottom = centre.add(local(panel.thickness / 2, -panel.height / 2));
  const rearTop = new Vector3(deck.faceTop.x, deck.faceTop.y, 0);
  const frontTop = rearTop.add(along.scale(panel.thickness));
  const downTheFace = Array.from({ length: BOARD_FACE_POINTS }, (_, k) => Vector3.Lerp(rearTop, rearBottom, (k + 1) / (BOARD_FACE_POINTS + 1)));
  parts.push(sweptAcross(
    build,
    "trainer-instrument-panel",
    // from its front foot round: `sweptSolid` caps an end with a fan from the section's first point, and a fan from a
    // point ON the rear face (whose points all lie on one line, each out to its own end) laid slivers in that face's
    // plane, inboard of its end
    { points: [frontBottom, frontTop, rearTop, ...downTheFace, rearBottom].map((p) => ({ u: p.x, y: p.y })), rounds: [] },
    materials.interior,
    root,
    // under the deck the board ends where the deck does, inside the rail; below that it flares out toward its wall at
    // 45 degrees, into the door frame's face
    (point) => Math.min(
      // at the point's OWN station: the windscreen narrows over the board's 10 cm depth
      trainerCabinHalfWidth(point.u, point.y) - TRAINER_GLARESHIELD.clearance,
      trainerRailCentre(point.u).u + TRAINER_DOOR_FRAME.endInset + Math.max(0, deck.faceTop.y - point.y),
    ),
  ));

  // THE DIALS' FACES, BEZELS AND NEEDLES, THE RADIOS AND THE SWITCHES (S2). Three meshes for all of them bar the
  // needles and the ball, where there were three gauge discs: the faces (the three dial faces and the two radios'
  // windows, which are the display atlas's screens), the bezels (on the shared rim), and the fittings (the radios'
  // bodies and knobs, and the switches). Each part gets its atlas UVs before the merge.
  const atlasSize = { width: displayAtlasWidth(TRAINER_DISPLAYS), height: displayAtlasHeight(TRAINER_DISPLAYS) };
  const slotOf = new Map(displaySlots(TRAINER_DISPLAYS).map((slot) => [slot.screen, slot]));
  const faces: Mesh[] = [];
  const bezels: Mesh[] = [];
  const fittings: Mesh[] = [];
  const bezelMaterial = bezelRimMaterial(build, "trainer-dial-bezel");
  const b = TRAINER_BEZEL;
  const faceMapRadius = b.faceRadius / TRAINER_DIAL_FACE_FRACTION;
  const circle = (radius: number): PartLoop => ({ halfWidth: 0, halfHeight: 0, radius, cornerSegments: b.cornerSegments });
  for (const { name, frame } of trainerDialFrames()) {
    // the face: a disc whose edge is buried under the ring's inner wall, its front the atlas slot's square
    const face = loopSolid(build, `trainer-${name}-face`, frame, circle(faceMapRadius), {
      points: [{ u: -faceMapRadius, a: FACE_FRONT }, { u: 0, a: FACE_FRONT }, { u: 0, a: b.back }, { u: -faceMapRadius, a: b.back }],
      rounds: [],
    }, materials.instrumentFace, root);
    mapFaceToSlot(face, frame, faceMapRadius, faceMapRadius, slotOf.get(name)!, atlasSize);
    faces.push(face);
    // the bezel: one ring, inner chamfer, front, outer chamfer, its back in the board; each chamfer shaded as a round
    // (its ends take the faces' normals either side), so it reads as an eased edge and splits no shading
    bezels.push(loopSolid(build, `trainer-${name}-bezel`, frame, circle(b.faceRadius), {
      points: [
        { u: 0, a: b.back },
        { u: 0, a: b.proud - b.innerChamfer },
        { u: b.innerChamfer, a: b.proud },
        { u: b.ringWidth - b.chamfer, a: b.proud },
        { u: b.ringWidth, a: b.proud - b.chamfer },
        { u: b.ringWidth, a: b.back },
      ],
      rounds: [
        { first: 1, last: 2, centre: { u: b.innerChamfer, a: b.proud - b.innerChamfer } },
        { first: 3, last: 4, centre: { u: b.ringWidth - b.chamfer, a: b.proud - b.chamfer } },
      ],
    }, bezelMaterial, root));
  }
  const radio = TRAINER_RADIO;
  for (const { unit, frame } of trainerRadioFrames()) {
    fittings.push(loopSolid(build, `trainer-${unit}-body`, frame,
      { halfWidth: radio.width / 2 - radio.corner, halfHeight: radio.height / 2 - radio.corner, radius: radio.corner, cornerSegments: 4 },
      roundedFrontProfile(radio.proud, radio.corner, TRAINER_BEZEL.back), materials.dark, root,
      { caps: [{ point: 0, facing: 1 }, { point: 6, facing: -1 }] }));
    // the window: a raised glass with a chamfered edge, its face the atlas slot's band
    const w = radio.window;
    const windowHeight = w.width / TRAINER_RADIO_WINDOW_ASPECT;
    const windowFrame = shifted(frame, w.across, 0);
    const glass = loopSolid(build, `trainer-${unit}-window`, windowFrame,
      { halfWidth: w.width / 2 - w.corner, halfHeight: windowHeight / 2 - w.corner, radius: w.corner, cornerSegments: 3 },
      chamferedFrontProfile(radio.proud + w.proud, w.corner, w.chamfer, radio.proud + TRAINER_BEZEL.back), materials.instrumentFace, root,
      { caps: [{ point: 0, facing: 1 }, { point: 4, facing: -1 }] });
    const slot = slotOf.get(unit)!;
    mapFaceToSlot(glass, windowFrame, w.width / 2, windowHeight / 2, slot, atlasSize, slot.w / TRAINER_RADIO_WINDOW_ASPECT);
    faces.push(glass);
    radio.knobs.forEach((knob, k) => {
      fittings.push(loopSolid(build, `trainer-${unit}-knob-${k}`, shifted(frame, knob.across, 0), circle(knob.radius),
        // a disc: the front from the axis (u = -radius is the centre) out to a 1 mm round, the side, the back to the axis
        {
          points: [
            { u: -knob.radius, a: radio.proud + knob.height },
            ...roundedFrontProfile(radio.proud + knob.height, 0.001, radio.proud + TRAINER_BEZEL.back).points.slice(0, 6),
            { u: -knob.radius, a: radio.proud + TRAINER_BEZEL.back },
          ],
          rounds: [{ first: 1, last: 5, centre: { u: -0.001, a: radio.proud + knob.height - 0.001 } }],
        }, materials.dark, root));
    });
  }
  const sw = TRAINER_SWITCHES;
  trainerSwitchFrames().forEach((frame, k) => {
    fittings.push(loopSolid(build, `trainer-switch-${k}-base`, frame,
      { halfWidth: sw.base.halfWidth - sw.base.corner, halfHeight: sw.base.halfHeight - sw.base.corner, radius: sw.base.corner, cornerSegments: 3 },
      chamferedFrontProfile(sw.base.proud, sw.base.corner, sw.base.chamfer, TRAINER_BEZEL.back), materials.dark, root,
      { caps: [{ point: 0, facing: 1 }, { point: 4, facing: -1 }] }));
    // the paddle, rocked about the across axis: top in when on
    const tilt = ((sw.on[k] ? 1 : -1) * sw.paddle.tiltDegrees * Math.PI) / 180;
    const base = shifted(frame, 0, 0, sw.base.proud);
    const paddleFrame: PartFrame = {
      origin: base.origin,
      across: base.across,
      up: base.up.scale(Math.cos(tilt)).add(base.out.scale(Math.sin(tilt))),
      out: base.out.scale(Math.cos(tilt)).subtract(base.up.scale(Math.sin(tilt))),
    };
    fittings.push(loopSolid(build, `trainer-switch-${k}-paddle`, paddleFrame,
      { halfWidth: sw.paddle.halfWidth - sw.paddle.corner, halfHeight: sw.paddle.halfHeight - sw.paddle.corner, radius: sw.paddle.corner, cornerSegments: 3 },
      // its back twice as deep: rocked 12 degrees, the top of a back 6 mm down stood only 4.5 mm under the base's face
      roundedFrontProfile(sw.paddle.height, sw.paddle.corner, 2 * TRAINER_BEZEL.back), materials.dark, root,
      { caps: [{ point: 0, facing: 1 }, { point: 6, facing: -1 }] }));
  });
  // THE COMPASS (S4), with the fittings: a rounded box under the centre frame's crown, its dark face toward the pilot,
  // on a short stalk up into the crown member
  {
    const c = TRAINER_OVERHEAD.compass;
    const centre = trainerCompassCentre();
    const frame: PartFrame = { origin: centre, across: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), out: new Vector3(-1, 0, 0) };
    fittings.push(loopSolid(build, "trainer-compass", frame,
      { halfWidth: c.width / 2 - c.edge, halfHeight: c.height / 2 - c.edge, radius: c.edge, cornerSegments: 3 },
      roundedBoxProfile(c.depth, c.edge), materials.dark, root,
      { caps: [{ point: 0, facing: 1 }, { point: 9, facing: -1 }] }));
    const crown = TRAINER_OVERHEAD.crown;
    const top = crown.fromY + ((crown.toY - crown.fromY) * (c.x - crown.fromX)) / (crown.toX - crown.fromX);
    fittings.push(sweptTube(build, "trainer-compass-stalk",
      [centre.add(new Vector3(0, c.height / 2 - 0.006, 0)), new Vector3(c.x, top - crown.radius / 2, 0)],
      [c.stalkRadius, c.stalkRadius], 12, materials.dark, root));
  }
  const facesMesh = build.mergeStatic(TRAINER_DISPLAYS.screensMesh, faces, root);
  parts.push(facesMesh);
  parts.push(build.mergeStatic("trainer-dial-bezels", bezels, root));
  parts.push(build.mergeStatic("trainer-panel-fittings", fittings, root));
  // THE HEADLINER AND THE VISORS (S4), one mesh on the cabin's fabric
  {
    const o = TRAINER_OVERHEAD;
    const down = new Vector3(0, -1, 0);
    const plan = (x: number, y: number, z: number): PartFrame => ({ origin: new Vector3(x, y, z), across: new Vector3(0, 0, 1), up: new Vector3(1, 0, 0), out: down });
    const lining = [loopSolid(build, "trainer-headliner-lining", plan((o.aftX + o.frontX) / 2, o.roofY, 0),
      { halfWidth: o.halfWidth - o.cornerRadius, halfHeight: (o.frontX - o.aftX) / 2 - o.cornerRadius, radius: o.cornerRadius, cornerSegments: 6 },
      headlinerProfile(), materials.headliner, root,
      { caps: [{ point: 0, facing: 1 }, { point: headlinerProfile().points.length - 1, facing: -1 }] })];
    const v = o.visor;
    const visorY = o.roofY + o.ceilingDrop + 0.001 + v.thickness / 2;
    for (const side of [-1, 1] as const) {
      lining.push(loopSolid(build, `trainer-visor-${side < 0 ? "port" : "starboard"}`,
        plan(v.frontX - v.depth / 2, o.roofY - (visorY - o.roofY), side * (v.gap / 2 + v.width / 2)),
        { halfWidth: v.width / 2 - v.corner, halfHeight: v.depth / 2 - v.corner, radius: v.corner, cornerSegments: 4 },
        roundEdgedPlate(v.thickness, v.corner), materials.headliner, root,
        { caps: [{ point: 0, facing: -1 }, { point: 8, facing: 1 }] }));
    }
    parts.push(build.mergeStatic("trainer-headliner", lining, root));
  }

  // THE ATLAS: live where there is a 2D canvas, drawn ONCE (nothing on the faces moves); under Node the faces keep the
  // flat instrument-face material they were built with (see `displayAtlas.ts`)
  const atlas = createDisplayAtlas(build, TRAINER_DISPLAYS);
  if (atlas !== null) {
    facesMesh.material = displayMaterial(build, "trainer-display", atlas);
    paintDisplays(atlas, DISPLAY_STATE_LEVEL);
  }

  for (const placement of trainerDialPlacements()) {
    const { name, centre: at, normal } = placement;
    // Up the panel's face, in the vertical plane of the dial's normal.
    const up = Vector3.Cross(normal, new Vector3(0, 0, 1)).normalize();
    if (name === "attitude") {
      // THE BALL, not a needle. Its pivot turns about ITS OWN X, so it hangs from a
      // frame node whose axes are the pivot's (`buildAttitudeBall`): X AWAY from the
      // pilot (the dial's normal reversed), Y up the face, Z = X x Y, the pilot's
      // right. The needles' frames have X TOWARD him instead, which is why their
      // turn is a negative rotation and the ball's is not; the screen-space test in
      // `tests/render.cockpit-instruments.test.ts` decides which sign is right.
      const ball = TRAINER_ATTITUDE_BALL;
      const away = normal.scale(-1);
      const frame = new TransformNode("trainer-attitude-frame", build.scene);
      frame.parent = root;
      frame.position.copyFrom(at.add(normal.scale(FACE_FRONT + ball.proud + ball.thickness / 2)));
      frame.rotationQuaternion = basisQuaternion(away, up, Vector3.Cross(away, up));
      attitudeBall = buildAttitudeBall(build, frame, Vector3.Zero(), { prefix: "trainer-attitude", ...ball });
      parts.push(...attitudeBall.parts);
      continue;
    }
    // THE NEEDLE, one mesh whose ORIGIN is the face's centre and whose local X
    // is the dial's normal, so turning the mesh about its own X turns the needle
    // about the dial's axis. `mergeStatic` bakes the parts' world matrices into
    // vertices in BODY coordinates and leaves the mesh's origin at the aircraft's
    // (measured: position (0, 0, 0), a needle 2 m away from it), so the merged
    // mesh is re-framed: its vertices are carried into the dial's own frame and
    // the mesh is given that frame as its transform. Nothing on screen moves.
    //
    // The frame is right-handed: X = the dial's normal (toward the pilot), Y = up
    // the panel's face, Z = X x Y, which is PORT. The pointer rests along +Y,
    // 12 o'clock. A positive rotation about X, an axis pointing at the pilot, is
    // ANTI-clockwise to him; `turnNeedle` owns that inversion.
    const origin = at.add(normal.scale(NEEDLE_ORIGIN_OFFSET));
    const frameQ = basisQuaternion(normal, up, Vector3.Cross(normal, up));
    const frameNode = new TransformNode(`trainer-${name}-needle-frame`, build.scene);
    frameNode.parent = root;
    frameNode.position.copyFrom(origin);
    frameNode.rotationQuaternion = frameQ.clone();
    frameNode.computeWorldMatrix(true);
    const bar = build.box(
      `trainer-${name}-needle-bar`, TRAINER_NEEDLE.thickness,
      TRAINER_NEEDLE.pointerLength + TRAINER_NEEDLE.tailLength, TRAINER_NEEDLE.width,
      materials.instrumentMarking, frameNode,
    );
    bar.position.set(NEEDLE_STAND_OFF, (TRAINER_NEEDLE.pointerLength - TRAINER_NEEDLE.tailLength) / 2, 0);
    // The hub is a disc about the dial's axis (local X); a cylinder's own axis is Y.
    const hub = build.cylinder(
      `trainer-${name}-needle-hub`, TRAINER_NEEDLE.hubThickness, TRAINER_NEEDLE.hubRadius * 2,
      TRAINER_NEEDLE.hubRadius * 2, 16, materials.instrumentMarking, frameNode,
    );
    hub.rotation.z = Math.PI / 2;
    hub.position.set(NEEDLE_STAND_OFF, 0, 0);
    const needle = build.mergeStatic(`trainer-${name}-needle`, [bar, hub], root, { staticNodes: [frameNode] });
    needle.bakeTransformIntoVertices(Matrix.Compose(Vector3.One(), frameQ, origin).invert());
    needle.position.copyFrom(origin);
    needle.rotationQuaternion = frameQ.clone();
    needle.refreshBoundingInfo();
    parts.push(needle);
    needles.set(name, { mesh: needle, frame: frameQ });
  }

  // THE A-PILLARS, from the rails into the roof slab (`TRAINER_A_PILLAR`), on the door frames' material: the rail and
  // the pillar read as one frame round the side window.
  for (const side of [-1, 1] as const) {
    const { centres, radii } = trainerPillarPath(side);
    parts.push(sweptTube(
      build, side < 0 ? "trainer-a-pillar-port" : "trainer-a-pillar-starboard",
      centres, radii, TRAINER_A_PILLAR.segments, materials.interior, root,
    ));
  }

  // THE DOOR FRAMES (`TRAINER_DOOR_FRAME`), one mesh a side: the rail, the face and the panel. Without them the pilot
  // would see the ground through the cabin's side: the tube's wall is culled from inside and, with the tube hidden,
  // there is no wall at all.
  {
    const stations = trainerDoorStations();
    const sections = stations.map(trainerDoorSections);
    for (const side of [-1, 1] as const) {
      const sideName = side < 0 ? "port" : "starboard";
      const at = (x: number, point: { u: number; y: number }) => new Vector3(x, point.y, side * point.u);
      const sweep = (name: string, which: "face" | "panel") => {
        const canonical = sections[0]![which];
        return sweptSolid(
          build, name, { points: canonical, rounds: [] }, stations.length,
          (i, point) => {
            const own = sections[i]![which];
            const index = canonical.indexOf(point as { u: number; y: number });
            // one of the section's points, or its middle (for its caps)
            if (index >= 0) return at(stations[i]!, own[index]!);
            return at(stations[i]!, { u: own.reduce((sum, p) => sum + p.u, 0) / own.length, y: own.reduce((sum, p) => sum + p.y, 0) / own.length });
          },
          (direction) => new Vector3(0, direction.y, side * direction.u),
          materials.interior, root, { smoothAlong: true },
        );
      };
      const rail = sweptTube(
        build, `trainer-door-${sideName}-rail`,
        stations.map((x, i) => at(x, sections[i]!.rail)),
        stations.map(() => TRAINER_DOOR_FRAME.railRadius),
        TRAINER_DOOR_FRAME.railSegments, materials.interior, root,
      );
      const face = sweep(`trainer-door-${sideName}-face`, "face");
      const doorPanel = sweep(`trainer-door-${sideName}-panel`, "panel");
      parts.push(build.mergeStatic(`trainer-door-${sideName}`, [rail, face, doorPanel], root));
    }
  }

  // THE NEEDLES' STEP. Two dials have a needle; the third, "attitude", has the
  // ball (below). Each needle's transform is its frame with a turn about its own
  // X. `clockwiseDegrees` is the angle as the pilot SEES it (12 o'clock 0, 3
  // o'clock +90); the dial's normal points TOWARD him, so a clockwise turn is a
  // NEGATIVE rotation about it. Held to the screen by
  // `tests/render.cockpit-instruments.test.ts`, which projects the needle through
  // the cockpit camera: a flipped sign here passes every test of the angle alone.
  const spin = new Quaternion();
  const dialAxis = new Vector3(1, 0, 0);
  const turnNeedle = (name: string, clockwiseDegrees: number): void => {
    const needle = needles.get(name);
    if (!needle) return;
    Quaternion.RotationAxisToRef(dialAxis, (-clockwiseDegrees * Math.PI) / 180, spin);
    needle.frame.multiplyToRef(spin, needle.mesh.rotationQuaternion!);
  };
  return {
    parts,
    bezelMaterial,
    displaysLive: atlas !== null,
    update(state) {
      turnNeedle("airspeed", airspeedNeedleDegrees(state.airspeed, TRAINER_AIRSPEED_FULL_SCALE_KNOTS));
      turnNeedle("altimeter", altimeterNeedleDegrees(state.altitude));
      // THE BALL. Its pivot's local X points AWAY from the pilot, so a positive
      // rotation is clockwise to him and the clockwise-as-seen angle (minus the
      // bank) goes in as it is; the bar slides along the pivot's own up.
      if (attitudeBall) {
        attitudeBall.pivot.rotation.x = (attitudeHorizonDegrees(state.bank) * Math.PI) / 180;
        attitudeBall.bar.position.y = pitchBarOffsetMetres(state.pitch, TRAINER_ATTITUDE_BALL.radius);
      }
    },
  };
}
