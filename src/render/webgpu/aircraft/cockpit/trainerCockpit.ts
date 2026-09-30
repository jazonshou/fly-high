import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import { loftSectionPoint, type AircraftBuildContext, type LoftSection } from "../builders";
import { TRAINER_CANOPY_SECTIONS, TRAINER_FUSELAGE_SECTIONS } from "../trainerShell";
import {
  basisQuaternion,
  buildAttitudeBall,
  glareshieldMaterial,
  roundedDeckSection,
  slab,
  strip,
  sweptSolid,
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
 *  - the left windscreen post's axis stands at azimuth -35, hugging the left
 *    edge of the frame (the D3 window is -37 to -31);
 *  - the cowl rises above the glareshield to about -4.7, as a Cessna's does.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at
 * negative Z. Shell numbers were MEASURED off the built meshes by
 * `scripts/cockpit-shell-clearance.mts`, and `tests/render.cockpit-trainer.test.ts`
 * holds every part to them: a loft interpolated between stations is easy to
 * transcribe wrongly.
 */

export interface TrainerCockpitMaterials {
  /** Dark matte interior: the panel board, the door panels and sill caps. (The hood has its own: `glareshieldMaterial`.) */
  readonly interior: PBRMaterial;
  /** The windscreen posts. */
  readonly dark: PBRMaterial;
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
  // own station and height (`trainerCabinHalfWidth`). It was a 0.84 m box, 2.5 cm OUTSIDE the glass at its top.
});

/** Real gauge size. The dials this replaces were 0.17 to 0.20 m across. */
export const TRAINER_DIAL_DIAMETER = 0.08;

/**
 * A gauge face: a disc 8 mm thick whose centre stands 5 mm off the panel's rear
 * face along the dial's normal, so its front is 9 mm off it.
 */
const GAUGE_FACE_OFFSET = 0.005;
const GAUGE_FACE_THICKNESS = 0.008;

/**
 * THE ATTITUDE BALL on the "attitude" dial, which has no needle: the Global's ball
 * (`buildAttitudeBall`) at 0.75 of its size, so 0.036 m on the 0.08 m dial and 4 mm
 * of face left round it. Its sky and ground stand 1.5 mm in front of the face
 * (`proud`); the bar is the Global's 0.07 x 0.003 scaled by the same 0.75, and it
 * slides 0.75 mm a degree (`pitchBarOffsetMetres` takes the radius), so at the 25
 * degree clamp it is still inside the disc.
 */
export const TRAINER_ATTITUDE_BALL = Object.freeze({
  radius: 0.036,
  thickness: 0.002,
  proud: 0.0015,
  barOffset: 0.0015,
  barLength: 0.0525,
  barHeight: 0.00225,
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
  thickness: 0.006,
  hubRadius: 0.006,
  hubThickness: 0.008,
});

/**
 * The airspeed dial's full-scale reading, knots: -150 degrees at 0 to +150 here,
 * clamped. A property of THIS dial (the catalogue has no airspeed maximum for any
 * airframe), so it lives beside the layout it belongs to.
 */
export const TRAINER_AIRSPEED_FULL_SCALE_KNOTS = 160;

/** Where a needle's origin stands along the dial's normal: the gauge face's own centre, 5 mm off the panel. */
const NEEDLE_ORIGIN_OFFSET = 0.005;

/**
 * How far in front of its origin the needle's geometry stands, along the dial's
 * normal: the needle is 9.5 mm off the panel, in front of the face (whose front
 * is at 9 mm). The ORIGIN stays on the dial's axis at the gauge's centre, so the
 * needle turns about the axis; only the geometry stands proud of it.
 */
const NEEDLE_STAND_OFF = 0.0045;

/**
 * The left windscreen post's AXIS lies in the vertical plane through the eye at
 * this azimuth (degrees, negative to port). A vertical plane through the eye
 * projects to a vertical LINE on screen, so the whole post reads at one column.
 * At -35 the post hugs the left edge of the frame (-37.5 at 16:9) and reads as a
 * window frame instead of a bar standing in the view; its own thickness spreads
 * it about 2.7 degrees either side of the axis (0.012 m at 0.276 m), so its outer
 * edge touches the frame edge.
 */
export const TRAINER_LEFT_POST_AZIMUTH_DEGREES = -35;
export const TRAINER_POST_RADIUS = 0.012;
const POST_RADIUS = TRAINER_POST_RADIUS;

/**
 * The cabin's inner half-widths, measured off the built meshes (metres from the
 * centreline): the tube's flat wall, and the greenhouse glass's base at the sill.
 * Piecewise linear in x between the stations measured.
 */
const WALL_HALF_WIDTH: readonly (readonly [number, number])[] = [
  [0.95, 0.5015], [1.62, 0.5005], [1.8, 0.488], [2, 0.4685], [2.05, 0.463],
];
const SILL_HALF_WIDTH: readonly (readonly [number, number])[] = [
  [0.95, 0.437], [1.4, 0.437], [1.62, 0.435], [1.8, 0.424], [2, 0.411], [2.05, 0.395],
];
function interpolate(table: readonly (readonly [number, number])[], x: number): number {
  const first = table[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < table.length; i += 1) {
    const a = table[i - 1]!;
    const b = table[i]!;
    if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return table[table.length - 1]![1];
}

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
 * line, so none of its top is seen from the seat. Across the cabin it runs to 2 cm inside the glass at every point of
 * its section, and each end turns into its wall on a 2 cm round in plan: no square end anywhere.
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
  /** The plan round each end turns into its wall on, and the stations it takes. */
  endRadius: 0.02,
  endStations: 4,
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
 * A section swept ACROSS the cabin, wall to wall, each end FILLETED into its wall: the prism trimmed, at each end, by
 * a vertical round of `endRadius` about the corner where its aft face meets its end. Stations along z: the straight
 * run between the two ends, then `endStations` more at each end, down the fillet's quarter-circle; at each of those
 * every section point aft of the round is carried forward onto it (x at least `aft + r - r cos(theta)`), so the aft
 * face turns into the end on the round and everything forward of the round runs on to the flat end. The section keeps
 * its attitude, so the end caps face outboard (from the left seat the left one is culled) and plain `sweptSolid` builds
 * it, smooth-shaded along the stations so the fillet shades as a curve. `aftU` is a section point's aft face (its
 * station: the board's leans), `half` how far out its end is: each point's own, so an end can follow a wall that is
 * not straight.
 */
function sweptAcross(
  build: AircraftBuildContext,
  name: string,
  section: SweptSection,
  material: PBRMaterial,
  root: TransformNode,
  aftU: (point: { readonly u: number; readonly y: number }) => number,
  half: (point: { readonly u: number; readonly y: number }) => number,
) {
  const g = TRAINER_GLARESHIELD;
  const r = g.endRadius;
  const turns = Array.from({ length: g.endStations + 1 }, (_, k) => (Math.PI / 2) * (k / g.endStations));
  // a station 1 mm inboard of each fillet as well: the straight run between them then averages flat with flat along
  // the stations and shades flat, and the fillet's blend stays within that millimetre
  const stations = [
    ...turns.slice().reverse().map((theta) => ({ side: -1, theta, inset: 0 })),
    { side: -1, theta: 0, inset: FILLET_LEAD_IN },
    { side: 1, theta: 0, inset: FILLET_LEAD_IN },
    ...turns.map((theta) => ({ side: 1, theta, inset: 0 })),
  ];
  return sweptSolid(
    build,
    name,
    section,
    stations.length,
    (i, point) => {
      const { side, theta, inset } = stations[i]!;
      const out = half(point);
      if (!Number.isFinite(out)) throw new RangeError(`${name}: no cabin wall for the point at x ${point.u.toFixed(3)}, y ${point.y.toFixed(3)}`);
      const clip = aftU(point) + r - r * Math.cos(theta);
      return new Vector3(Math.max(point.u, clip), point.y, side * (out - r - inset + r * Math.sin(theta)));
    },
    (direction) => new Vector3(direction.u, direction.y, 0),
    material,
    root,
    { smoothAlong: true },
  );
}

/** The straight run's last millimetre before each fillet (`sweptAcross`). */
const FILLET_LEAD_IN = 0.001;

/** Points down the board's rear face, besides its top and foot, for its ends to follow the wall's curve by. */
const BOARD_FACE_POINTS = 8;

/** Solved in `tests/render.cockpit-trainer.test.ts` ("keeps the sill cap clear of the airspeed dial"). */
const CAP_TO_X = 1.9;

/** The door panels and sill caps: how far in from the wall, and how they run. */
const DOOR = Object.freeze({
  fromX: 0.95,
  toX: 2.05,
  /** The panel's mid-plane sits this far inside the measured wall (the outer face is 5 mm nearer it). */
  inset: 0.015,
  thickness: 0.01,
  bottomY: -0.6,
  /** Where the vertical wall panel ends and the panel begins to lean in toward the sill. */
  kneeY: -0.2,
  /** The sill cap: 0.04 wide, 0.02 thick, its outer edge just inside the glass's base. */
  capWidth: 0.04,
  capThickness: 0.02,
  capInset: 0.005,
  /**
   * Where the sill cap ENDS, short of the door's own fore end. Run to x 2.05 its 4 cm inboard lip stood in front of
   * the airspeed dial's upper-left (1,496 px of it at 1080p, 9.0%); the door's slabs, outboard of the dial's
   * sightline, still run on to the panel, so nothing opens below the sill.
   */
  capToX: CAP_TO_X,
});

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

/**
 * The two ends of a windscreen post, vertical, in the plane through the eye at
 * `TRAINER_LEFT_POST_AZIMUTH_DEGREES`.
 *
 * NOT raked to the roof's outboard corner, which was the first design: that
 * corner is 0.06 m ahead of the eye and 0.05 m to port, so a post ending there
 * swelled toward the top into a dark wedge across 22% of the frame. Standing the
 * post about 0.28 m away instead keeps it a bar of uniform width from bottom to
 * top. It runs from just below the sill to 0.27, which is above the top of the
 * frame at that azimuth (+19.5 degrees is 0.10 m over 0.28), because the roof
 * slab is narrower than the greenhouse (0.31 against 0.44) and there is nothing
 * up there for a post ending at the roof's height to meet: it would stop in
 * mid-air 15 degrees above the horizon.
 */
export function trainerPostEndpoints(side: -1 | 1): { bottom: Vector3; top: Vector3 } {
  const eye = aircraftSpec("trainer").cockpitEye;
  const slope = Math.tan((TRAINER_LEFT_POST_AZIMUTH_DEGREES * Math.PI) / 180); // dz / dx from the eye, port negative
  // Just inside the greenhouse's base: the post's outer surface 5 mm within it.
  const z = -(interpolate(SILL_HALF_WIDTH, 1.62) - POST_RADIUS - 0.005);
  const x = eye.forward + (z - eye.right) / slope;
  const bottom = new Vector3(x, -0.02, z);
  const top = new Vector3(x, 0.27, z);
  if (side < 0) return { bottom, top };
  // The starboard post is the mirror image across the centreline, not a second solve: nothing is asked of it.
  return { bottom: new Vector3(x, bottom.y, -z), top: new Vector3(x, top.y, -z) };
}

/** What `buildTrainerCockpit` hands back: the meshes, and the step that turns the needles and the ball. */
export interface TrainerCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
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
 * Fifteen meshes in five groups: the cowl stand-in (1), the panel and its hood
 * (2), the windscreen posts (2), the door panels with their sill caps (2), and the
 * dials (8: three gauge faces, two needles, and the attitude ball's three pieces).
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

  // THE DECK AND THE BOARD, two meshes, each a section swept across the cabin wall to wall (`sweptAcross`): the deck
  // the rounded glareshield (`trainerDeckSection`) on its own matte near-black, which reflects nothing (on the interior
  // material its top read as the brightest surface in the frame); the board the leaned panel under it, its rear face
  // exactly where the old box's was, from its foot up to the cove's, with extra points down that face so each end can
  // follow the wall's curve at every height. Neither has a square end: each turns into its wall on a 2 cm round.
  const { centre, local } = panelFrame();
  const panel = TRAINER_PANEL;
  const deck = trainerDeckSection();
  // the deck's ends are straight along x, at its narrowest: the glass narrows forward, and an end that followed it
  // would turn toward the pilot
  const deckTop = Math.max(...deck.outline.map((p) => p.y));
  const deckHalf = Math.min(...deck.outline.map((p) => trainerCabinHalfWidth(p.x, deckTop))) - TRAINER_GLARESHIELD.clearance;
  parts.push(sweptAcross(
    build,
    "trainer-glareshield",
    {
      points: deck.outline.map((p) => ({ u: p.x, y: p.y })),
      rounds: [{ first: 3, last: deck.outline.length - 1, centre: { u: deck.centre.x, y: deck.centre.y } }],
    },
    glareshieldMaterial(build, "trainer-glareshield"),
    root,
    () => deck.coveTop.x,
    () => deckHalf,
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
    { points: [rearBottom, frontBottom, frontTop, rearTop, ...downTheFace].map((p) => ({ u: p.x, y: p.y })), rounds: [] },
    materials.interior,
    root,
    (point) => rearFaceXAt(point.y),
    // under the deck the board ends where the deck does, so no step of its top shows beyond the deck's end; below
    // that it flares out to its wall at 45 degrees
    (point) => Math.min(
      // at the point's OWN station: the windscreen narrows over the board's 10 cm depth
      trainerCabinHalfWidth(point.u, point.y) - TRAINER_GLARESHIELD.clearance,
      deckHalf + Math.max(0, deck.faceTop.y - point.y),
    ),
  ));

  // THE DIALS. Real size, in front of the left seat, on the panel's rear face
  // and a millimetre proud of it. The face cylinder's axis is local Y; turning
  // it a quarter turn and then leaning it with the panel points it at the pilot.
  for (const placement of trainerDialPlacements()) {
    const { name, centre: at, normal } = placement;
    const face = build.cylinder(
      `trainer-${name}-gauge`, GAUGE_FACE_THICKNESS, TRAINER_DIAL_DIAMETER, TRAINER_DIAL_DIAMETER, 24, materials.instrumentFace, root,
    );
    face.rotation.z = Math.PI / 2 + TRAINER_PANEL.lean;
    face.position.copyFrom(at.add(normal.scale(GAUGE_FACE_OFFSET)));
    parts.push(face);
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
      frame.position.copyFrom(
        at.add(normal.scale(GAUGE_FACE_OFFSET + GAUGE_FACE_THICKNESS / 2 + ball.proud + ball.thickness / 2)),
      );
      frame.rotationQuaternion = basisQuaternion(away, up, Vector3.Cross(away, up));
      attitudeBall = buildAttitudeBall(build, frame, Vector3.Zero(), { prefix: "trainer-attitude", ...ball });
      parts.push(...attitudeBall.parts);
      continue;
    }
    // THE NEEDLE, one mesh whose ORIGIN is the gauge's centre and whose local X
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

  // THE WINDSCREEN POSTS, sill to roof, each in one vertical plane through the
  // eye so the left one stands at one screen column.
  for (const side of [-1, 1] as const) {
    const { bottom, top } = trainerPostEndpoints(side);
    parts.push(build.strutBetween(
      side < 0 ? "trainer-windscreen-post-port" : "trainer-windscreen-post-starboard",
      bottom, top, POST_RADIUS, materials.dark, root,
    ));
  }

  // THE DOOR PANELS and their SILL CAPS, one mesh a side. Without them the
  // pilot would see the ground through the cabin's side: the tube's wall is
  // culled from inside and, with the tube hidden, there is no wall at all. The
  // lower panel stands just inside where the wall was; the upper one leans in
  // to the glass's base; the cap makes the sill a ledge and not a knife edge.
  for (const side of [-1, 1] as const) {
    const wall = (x: number) => side * (interpolate(WALL_HALF_WIDTH, x) - DOOR.inset);
    const sill = (x: number) => side * (interpolate(SILL_HALF_WIDTH, x) - DOOR.capInset);
    const { fromX: x0, toX: x1 } = DOOR;
    const sideName = side < 0 ? "port" : "starboard";
    const lower = slab(
      build, `trainer-door-${sideName}-lower`, materials.interior, root,
      new Vector3(x0, DOOR.bottomY, wall(x0)), new Vector3(x1, DOOR.bottomY, wall(x1)),
      new Vector3(x0, DOOR.kneeY, wall(x0)), new Vector3(x1, DOOR.kneeY, wall(x1)),
      DOOR.thickness,
    );
    const upper = slab(
      build, `trainer-door-${sideName}-upper`, materials.interior, root,
      new Vector3(x0, DOOR.kneeY, wall(x0)), new Vector3(x1, DOOR.kneeY, wall(x1)),
      new Vector3(x0, 0, sill(x0)), new Vector3(x1, 0, sill(x1)),
      DOOR.thickness,
    );
    const cap = strip(
      build, `trainer-sill-${sideName}`, materials.interior, root,
      new Vector3(x0, 0, sill(x0) - side * (DOOR.capWidth / 2)),
      new Vector3(DOOR.capToX, 0, sill(DOOR.capToX) - side * (DOOR.capWidth / 2)),
      DOOR.capWidth, DOOR.capThickness,
    );
    parts.push(build.mergeStatic(`trainer-door-${sideName}`, [lower, upper, cap], root));
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
