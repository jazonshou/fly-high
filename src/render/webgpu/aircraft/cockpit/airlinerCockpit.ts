import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, orient, solidPlate } from "./cockpitPrimitives";
import {
  AIRLINER_DISPLAYS,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displayRedrawClock,
  displaySlots,
  paintDisplays,
  remapScreenFaceToSlot,
  type DisplayAtlas,
} from "./displays/displayAtlas";
import { displayStateFromVisual, type DisplayAirframe } from "./displays/displayStateFromVisual";

/**
 * What a pilot in the 747-8's LEFT seat sees, built to angles.
 *
 * WHY THIS EXISTS. The flight deck was a centred instrument board with five
 * dials on it, two seats 2 m behind the glass, and six glazing boxes the cockpit
 * camera drew as opaque slabs: from the catalogue's centreline eye the picture
 * was two huge dark trapezoids and a wall of panel with the dials mostly below
 * the frame. The glazing is `airliner-glass`, a PBR with refraction on, and a
 * refractive material draws as an opaque slab from inside, so the glazing is now
 * excluded from the cockpit camera (`cockpitParts`), as the Global's windscreen
 * is, and what frames the view is built here as COCKPIT-ONLY parts
 * (`CommonRig.cockpitOnlyParts`): invisible from any other camera and never a
 * shadow caster.
 *
 * THE EYE, (29.90, 2.93, -0.72), was SOLVED against the built glazing
 * (`scripts/airliner-eye-solve.mts`) with the old panel and seats treated as
 * movable: eye y inside the glass's span, at least 0.55 m from the glass and
 * 0.15 m under the skin, and the port No.1 pane, the only glass straight ahead of
 * a pilot at z -0.72, read as far above AND below the horizon as it can. That is
 * T = 9.39 (top +9.64, bottom -9.39) with 0.558 m to the glass and 0.474 m of
 * skin; the best point is T 9.53 at (29.915, 2.935), where the glass distance is
 * exactly 0.55. The seats used to stand 2 m behind the glass, which is why the
 * old eye could read no more than +5 / -7: the pilots now sit where a 747's do,
 * and the deck is built around them.
 *
 * WHAT CANNOT BE FIXED HERE. The opening is about 19 degrees tall where the
 * type's is nearer 35, because the model's panes lie 45 to 53 degrees UP on the
 * nose crown and sit far forward, and the crown itself (3.10 m at x 31.0, z -0.72)
 * is the ceiling of every one of them. Taller is a nose re-loft, not cockpit
 * work (docs/findings/COCKPIT_VIEW_2026_09_20.md, the plane engineer's register).
 *
 * THE TARGETS, as angles from the eye at the 75 degree lens:
 *  - the hood's top edge straight ahead reads -10 degrees (+-1); a dash slab
 *    carries it on, sloping down to the glass's lowest bottom edge, because the
 *    glass's bottom edge straight ahead reads -9.4 and the hood's far edge would
 *    otherwise leave a band of the hidden nose between them;
 *  - the pilot's own PFD is straight ahead: six screens across, laid out about
 *    the SEATS (PFD, ND, EICAS a side), the pilot's PFD on the eye's z;
 *  - the PFD's upper two-thirds is an attitude ball, the same builder and the same
 *    mapping as the Global's and the Cessna's;
 *  - the port No.1 pane's top edge and the overhead's underside meet at the
 *    lowest pane top (y 3.137); a trapezoid PILLAR fills the V-shaped gap of crown
 *    between the two No.1 panes, and a post stands in the seam between No.1 and No.2.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at
 * negative Z. Every number that comes from the built glazing is a copy, held to
 * the built mesh by `tests/render.cockpit-airliner.test.ts`, so a re-loft of the
 * nose fails there instead of leaving a stale table.
 */

const DEG = Math.PI / 180;

export interface AirlinerCockpitMaterials {
  /**
   * Dark matte interior: the panel board, the overhead, the pillar and the post, which are one structure and one
   * draw state. (The hood and the dash have the hood's own: `glareshieldMaterial`.) The pillar and the post were
   * on the glareshield's, and a material with no ambient light reads (0, 0, 0) on any face the sun misses: a hole
   * in the picture beside a blue-grey ceiling. On this one the pillar reads the ceiling's own colour.
   */
  readonly interior: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /** Bezels. It carries the night glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one. */
  readonly instrumentMarking: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("airliner").cockpitEye;
}

const point = (xyz: readonly [number, number, number]): Vector3 => new Vector3(xyz[0], xyz[1], xyz[2]);

// ---- the glass ---------------------------------------------------------------

/**
 * Corners of the built glazing that the kit is placed against, in body metres.
 * `airliner-flight-deck-glazing` is one merged mesh of six thick boxes; each pane
 * is a 0.12 m slab laid on the nose crown, so its INNER face (toward the pilot)
 * is 0.06 m inside the skin and its OUTER face's top edge is the highest thing
 * of the pane.
 */
export const AIRLINER_GLAZING = Object.freeze({
  /** The port No.1 pane's inner face, the pane straight ahead of the left seat. */
  portOneInner: Object.freeze({
    bottomInboard: [31.843, 2.623, -0.618] as const,
    bottomOutboard: [31.233, 2.623, -1.347] as const,
    topOutboard: [30.802, 3.041, -0.987] as const,
    topInboard: [31.412, 3.041, -0.258] as const,
  }),
  /** The port No.1 pane's OUTER face's top edge: what the pilot's sightline has to clear. */
  portOneOuterTop: Object.freeze({
    outboard: [30.857, 3.137, -1.033] as const,
    inboard: [31.467, 3.137, -0.304] as const,
  }),
  /** The port No.2 pane's forward edge on its inner face, across the seam from No.1. */
  portTwoForwardInner: Object.freeze({
    bottom: [30.886, 2.682, -1.336] as const,
    top: [30.695, 3.133, -0.924] as const,
  }),
  /** The LOWEST top edge of any pane (No.1's outer edge); No.2's is 3.218 and No.3's 3.197. */
  lowestTopY: 3.137,
  /** The lowest bottom edge of any pane (No.1's inner edge). */
  lowestBottomY: 2.623,
});

// ---- the seats -----------------------------------------------------------------

/**
 * The seats stand 0.05 m aft of the pilot's eye in x (seat centre `forward - 0.05`)
 * and their highest corner 0.15 m below it, as the Global's do, and the headrests
 * keep their old place relative to the seat. Both pairs are symmetric about the
 * centreline; the pilot's is the PORT one, which is the mesh NAMED first-officer.
 * The old deck had them at 29.0 with the eye at 28.8.
 */
export const AIRLINER_SEAT = Object.freeze({
  behindEye: 0.05,
  topBelowEye: 0.15,
  length: 0.62,
  height: 0.8,
  width: 0.58,
  /** Rotation about Z, radians; the seat leans back, its rear-top corner the highest. */
  tilt: -0.07,
  /** Centre to centre of each seat from the centreline. */
  z: 0.72,
  headrestBehindSeat: 0.42,
  headrestAboveSeat: 0.48,
  headrestLength: 0.24,
  headrestHeight: 0.4,
  headrestWidth: 0.46,
});

/** Where the seat and its headrest go, in body x and y. */
export function airlinerSeatPlacement(): { seatX: number; seatY: number; headrestX: number; headrestY: number } {
  const e = eye();
  const s = AIRLINER_SEAT;
  // the highest corner of a box tilted about Z is its rear-top one
  const rise = (s.height / 2) * Math.cos(s.tilt) + (s.length / 2) * Math.sin(-s.tilt);
  const seatX = e.forward - s.behindEye;
  const seatY = e.up - s.topBelowEye - rise;
  return { seatX, seatY, headrestX: seatX - s.headrestBehindSeat, headrestY: seatY + s.headrestAboveSeat };
}

// ---- the panel and its hood -------------------------------------------------------

export const AIRLINER_PANEL = Object.freeze({
  /** The pilot-facing face of the board is this far ahead of the eye. */
  faceAheadOfEye: 0.75,
  thickness: 0.08,
  /**
   * Half its width: the shell's OUTER half-width at the hood's far top edge (x 30.73,
   * y 2.78) is 1.323 m, measured as the last crossing of a ray from the centreline
   * (the nose loft alone there: the fuselage loft ends at x 30.6), less 2 cm. The nose
   * narrows fast here: 1.42 at the hood's aft edge, 1.18 at y 2.9.
   */
  halfWidth: 1.3,
  /** Below the frame at every azimuth (44 degrees under the eye at the face). */
  bottomY: 2.2,
  hoodThickness: 0.02,
  /** The hood stands this far aft of the face. */
  hoodOverhang: 0.1,
  /** The hood's top edge as the pilot sees it straight ahead. */
  hoodTopElevationDegrees: -10,
});

export function airlinerPanelFaceX(): number {
  return eye().forward + AIRLINER_PANEL.faceAheadOfEye;
}

/** The height of the hood's top surface: solved so its far edge reads `hoodTopElevationDegrees` from the eye. */
export function airlinerHoodTopY(): number {
  const p = AIRLINER_PANEL;
  const e = eye();
  return e.up + Math.tan(p.hoodTopElevationDegrees * DEG) * (airlinerPanelFaceX() + p.thickness - e.forward);
}

/** Elevation, from the eye, of the hood's aft edge underside: the line below which the panel face is visible. */
export function airlinerHoodUndersideElevationDegrees(): number {
  const p = AIRLINER_PANEL;
  const e = eye();
  return Math.atan2(airlinerHoodTopY() - p.hoodThickness - e.up, airlinerPanelFaceX() - p.hoodOverhang - e.forward) / DEG;
}

/**
 * The DASH: the hood's top surface runs on, sloping down, from its far top edge to
 * the glass's lowest bottom edge. Without it the hood's far edge (-10 straight
 * ahead) sits below the glass's bottom edge (-9.4), and the band between them
 * shows the hidden nose. Its plan is the shell's outer half-width less 2 cm at
 * each end (1.30 at the hood, 0.50 where the nose narrows to 0.54 at the glass),
 * joined by a straight line that stays inside it (measured in the test).
 */
export const AIRLINER_DASH = Object.freeze({
  thickness: 0.02,
  /** Half-width where it leaves the hood, and at its far end. */
  nearHalfWidth: 1.3,
  farHalfWidth: 0.5,
  /** Its far top edge stands on the glass's lowest bottom edge, here in x. */
  farX: 31.843,
});

// ---- the screens -------------------------------------------------------------------

/** What the displays need that the flight state does not carry: four engines, 30 degrees of flap (`animation.ts`'s own table). */
export const AIRLINER_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 4, fullFlapDegrees: 30 });

export const AIRLINER_SCREENS = Object.freeze({
  width: 0.22,
  height: 0.15,
  bezel: 0.01,
  /** Centre to centre of neighbours. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /** The screens' top edge reads this far below the hood's underside. */
  belowHoodDegrees: 1.5,
  bezelThickness: 0.007,
  screenThickness: 0.003,
});

/**
 * Six screens laid out about the SEATS, not the aeroplane: each pilot's PFD on
 * the line of his own eye (z -0.72 and +0.72), the NDs at 0.245 inboard of them and
 * the two EICAS at 0.245 inboard again, so the pair in the middle stands 0.46 apart.
 * From the left seat the PFD is straight ahead; a row symmetric about z 0 at one
 * pitch would put it 8 degrees off his line and most of the row out of the frame.
 */
const SCREEN_Z: readonly (readonly [string, number])[] = [
  ["port-pfd", -0.72],
  ["port-nd", -0.475],
  ["port-eicas", -0.23],
  ["starboard-eicas", 0.23],
  ["starboard-nd", 0.475],
  ["starboard-pfd", 0.72],
];

/** The plane the screens' front stands in: 1 mm in front of the bezel's front face. */
function screenFrontX(): number {
  return airlinerPanelFaceX() - AIRLINER_SCREENS.bezelThickness;
}

/** Height of the screens' top edge, solved from the hood's underside line. */
export function airlinerScreenTopY(): number {
  const e = eye();
  const elevation = (airlinerHoodUndersideElevationDegrees() - AIRLINER_SCREENS.belowHoodDegrees) * DEG;
  return e.up + Math.tan(elevation) * (screenFrontX() - e.forward);
}

export function airlinerScreenPlacements(): readonly { name: string; centre: Vector3 }[] {
  const s = AIRLINER_SCREENS;
  const y = airlinerScreenTopY() - s.height / 2;
  const x = screenFrontX() + s.screenThickness / 2;
  return SCREEN_Z.map(([name, z]) => ({ name, centre: new Vector3(x, y, z) }));
}

// ---- the overhead, the pillar and the post ------------------------------------------------

export const AIRLINER_OVERHEAD = Object.freeze({
  thickness: 0.03,
  /** Out past the wall at this height: the slab pokes through the skin, and nothing can see that. */
  halfWidth: 1.4,
  /** The slab's aft end, behind the eye. */
  behindEye: 0.3,
});

export function airlinerOverheadUndersideY(): number {
  return AIRLINER_GLAZING.lowestTopY;
}

/**
 * The overhead's plan, counter-clockwise (x forward, z to starboard). Its raked
 * front edge runs from the wall to the port No.1 pane's inboard top corner and
 * straight across the crown gap to the mirror image, so the opening's top edge
 * follows the glass's and no band of hidden crown shows above it. Convex, which is
 * all `verticalProfile` can extrude.
 */
export function airlinerOverheadPlan(): { x: number; z: number }[] {
  const e = eye();
  const o = AIRLINER_OVERHEAD;
  const back = e.forward - o.behindEye;
  const wallFront = AIRLINER_GLAZING.portOneOuterTop.outboard[0];
  const cornerX = AIRLINER_GLAZING.portOneOuterTop.inboard[0];
  const cornerZ = AIRLINER_GLAZING.portOneOuterTop.inboard[2];
  return [
    { x: back, z: -o.halfWidth },
    { x: wallFront, z: -o.halfWidth },
    { x: cornerX, z: cornerZ },
    { x: cornerX, z: -cornerZ },
    { x: wallFront, z: o.halfWidth },
    { x: back, z: o.halfWidth },
  ];
}

/**
 * The PILLAR: a trapezoid plate in the plane of the crown between the two No.1
 * panes, whose inboard edges run from z +-0.618 at the bottom (y 2.623) to +-0.258
 * at the top (y 3.041), a V of hidden crown that would otherwise show as sky. It
 * is carried up the same lines to the overhead's underside.
 */
export function airlinerPillarOutline(): { bottom: Vector3; up: Vector3; length: number; bottomHalf: number; topHalf: number } {
  const inner = AIRLINER_GLAZING.portOneInner;
  const bottom = point(inner.bottomInboard);
  const top = point(inner.topInboard);
  // the plane's up-slope direction in x and y (both edges are parallel to z)
  const slope = new Vector3(top.x - bottom.x, top.y - bottom.y, 0);
  const slopeLength = slope.length();
  const up = slope.scale(1 / slopeLength);
  const bottomHalf = Math.abs(bottom.z);
  const topHalfAtGlass = Math.abs(top.z);
  // extend along the slope until the top edge stands at the overhead's underside
  const toOverhead = (airlinerOverheadUndersideY() - bottom.y) / up.y;
  const halfPerLength = (bottomHalf - topHalfAtGlass) / slopeLength;
  return {
    bottom: new Vector3(bottom.x, bottom.y, 0),
    up,
    length: toOverhead,
    bottomHalf,
    topHalf: bottomHalf - halfPerLength * toOverhead,
  };
}

/** The post in the seam between the port No.1 and No.2 panes: the wedge's midline, carried up to the overhead. */
export function airlinerSeamPostEndpoints(): { bottom: Vector3; top: Vector3 } {
  const g = AIRLINER_GLAZING;
  const one = { bottom: point(g.portOneInner.bottomOutboard), top: point(g.portOneInner.topOutboard) };
  const two = { bottom: point(g.portTwoForwardInner.bottom), top: point(g.portTwoForwardInner.top) };
  const bottom = one.bottom.add(two.bottom).scale(0.5);
  const midTop = one.top.add(two.top).scale(0.5);
  const direction = midTop.subtract(bottom);
  const toOverhead = (airlinerOverheadUndersideY() - bottom.y) / direction.y;
  return { bottom, top: bottom.add(direction.scale(toOverhead)) };
}

/**
 * The seam post's radius, and how far its MESH runs past the design top.
 *
 * The radius was 0.03, which read about 4.3 degrees wide in the first live frame and chunky against
 * a window; 0.025 reads 3.6.
 *
 * `airlinerSeamPostEndpoints().top` is where the post MEETS the overhead's underside, and it is the
 * point every angle test reads. A rod that ends exactly on the ceiling's underside shows its end cap
 * to the pilot, a small lit wedge against the ceiling (it read at about (555, 190) in the first live
 * frame). So the mesh runs on `buryMetres` past that point along its own axis and the cut end lies
 * above the plate: poking through the top of a cockpit-only plate is invisible from everywhere, as the
 * overhead's poking through the crown is.
 */
export const AIRLINER_POST = Object.freeze({ radius: 0.025, buryMetres: 0.08 });

// ---- the builder ------------------------------------------------------------------------------

/** What `buildAirlinerCockpit` hands back: the meshes, and the step that redraws the displays. */
export interface AirlinerCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /**
   * Whether the six screens are drawing. False wherever there is no 2D canvas -- every Node test
   * under `NullEngine` -- where they keep their flat material instead. Exposed so a test asserts the
   * headless path deliberately rather than passing because nothing was drawn.
   */
  readonly displaysLive: boolean;
  /**
   * The next `update` redraws the displays whatever its delta: the visual calls this on ENTERING
   * cockpit view, so the first frame back is not the picture from when the pilot last left.
   */
  invalidateDisplays(): void;
  /**
   * Redraw the displays at `DISPLAY_UPDATE_HZ` from what `state` reads.
   * The visual calls this from its `update` ONLY while cockpit view is on, and passes the frame's
   * own delta so the redraw rate is wall-clock rather than frame-rate.
   */
  update(state: FlightVisualState, secondsSinceLastUpdate?: number): void;
}

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks
 * them cockpit-only (`configureCockpitOnlyParts`) and registers them, so the rule
 * is applied in one place.
 *
 * FOUR meshes, all static: the board, the overhead, the pillar and the post on the
 * interior material; the hood and the dash on the glareshield's; the six screens;
 * their six bezels. It was seven until the 3D attitude ball came out -- its three
 * pieces hung from a pivot, so they could not be merged -- and the PFD page draws
 * attitude on the screen itself now. There are no side walls and no pedestal:
 * nothing in the frame needs them (`docs/findings`, MAP B).
 */
export function buildAirlinerCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: AirlinerCockpitMaterials,
): AirlinerCockpit {
  const parts: AbstractMesh[] = [];
  const p = AIRLINER_PANEL;
  const faceX = airlinerPanelFaceX();

  // THE PANEL BOARD, THE OVERHEAD, THE PILLAR AND THE SEAM POST, one mesh on the interior
  // material (merged below, once the pillar and the post exist). The board runs from below
  // the frame up to the hood's underside.
  const hoodTop = airlinerHoodTopY();
  const undersideY = hoodTop - p.hoodThickness;
  const board = build.box(
    "airliner-instrument-panel", p.thickness, undersideY - p.bottomY, p.halfWidth * 2, materials.interior, root,
  );
  board.position.set(faceX + p.thickness / 2, (p.bottomY + undersideY) / 2, 0);

  // The overhead is a plan-form, so it is an outline extruded along Z and turned
  // a quarter about X: the outline's y becomes body z, its thickness runs up.
  // (The three plates, this and the dash and the pillar, are `solidPlate`s: `verticalProfile` builds a
  // counter-clockwise outline inside out and winds its thin edge walls against its caps.)
  const overhead = solidPlate(
    build,
    "airliner-overhead",
    airlinerOverheadPlan().map(({ x, z }) => ({ x, y: z })),
    AIRLINER_OVERHEAD.thickness,
    materials.interior,
    root,
  );
  overhead.rotation.x = Math.PI / 2;
  overhead.position.y = airlinerOverheadUndersideY() + AIRLINER_OVERHEAD.thickness / 2;

  // THE HOOD AND THE DASH, one mesh on a material of its own (matte near-black, no
  // reflection): a glareshield must not reflect in the windscreen.
  const glare = glareshieldMaterial(build, "airliner-glareshield");
  const hoodLength = p.thickness + p.hoodOverhang;
  const hood = build.box("airliner-hood", hoodLength, p.hoodThickness, p.halfWidth * 2, glare, root);
  hood.position.set(faceX - p.hoodOverhang + hoodLength / 2, hoodTop - p.hoodThickness / 2, 0);
  // The dash runs from the hood's far top edge to the glass's lowest bottom edge: a
  // trapezoid in the plane whose local X is body z, local Y is down the slope and local
  // Z is the normal that faces up. Its top surface passes through both edges.
  const d = AIRLINER_DASH;
  const dashFrom = new Vector3(faceX + p.thickness, hoodTop, 0);
  const dashTo = new Vector3(d.farX, AIRLINER_GLAZING.lowestBottomY, 0);
  const along = dashTo.subtract(dashFrom);
  const dashLength = along.length();
  const alongUnit = along.scale(1 / dashLength);
  const across = new Vector3(0, 0, 1);
  const normal = Vector3.Cross(across, alongUnit).normalize();
  const dash = solidPlate(
    build,
    "airliner-dash",
    [
      { x: -d.nearHalfWidth, y: 0 },
      { x: d.nearHalfWidth, y: 0 },
      { x: d.farHalfWidth, y: dashLength },
      { x: -d.farHalfWidth, y: dashLength },
    ],
    d.thickness,
    glare,
    root,
  );
  orient(dash, across, alongUnit, normal);
  // the outline's origin is the near edge's midpoint, and the slab's mid-plane passes through it, so the top surface is 1 cm high
  dash.position.copyFrom(dashFrom.subtract(normal.scale(d.thickness / 2)));
  parts.push(build.mergeStatic("airliner-glareshield", [hood, dash], root));

  // THE SCREENS AND THEIR BEZELS: two meshes for twelve boxes. The bezel's back
  // stands 1 mm inside the board so nothing is coincident.
  const s = AIRLINER_SCREENS;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  for (const { name, centre } of airlinerScreenPlacements()) {
    const screen = build.box(
      `airliner-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root,
    );
    screen.position.copyFrom(centre);
    screens.push(screen);
    const bezel = build.box(
      `airliner-screen-bezel-${name}`, s.bezelThickness, s.height + s.bezel * 2, s.width + s.bezel * 2,
      materials.instrumentMarking, root,
    );
    bezel.position.set(faceX - s.bezelThickness / 2 + 0.001, centre.y, centre.z);
    bezels.push(bezel);
  }
  // EACH SCREEN'S PILOT-FACING FACE GETS ITS OWN SLOT of the display atlas, before the merge bakes
  // the vertex data. The boxes are built in `SCREEN_Z` order and the slots are in the same order, so
  // slot i belongs to screen i; `tests/render.cockpit-displays.test.ts` holds that pairing by
  // measuring the merged mesh's UVs against each screen's own z.
  const slots = displaySlots(AIRLINER_DISPLAYS);
  const atlasWidth = displayAtlasWidth(AIRLINER_DISPLAYS);
  const atlasHeight = displayAtlasHeight(AIRLINER_DISPLAYS);
  for (const [index, screen] of screens.entries()) {
    remapScreenFaceToSlot(screen as Mesh, slots[index]!, atlasWidth, atlasHeight);
  }
  const screensMesh = build.mergeStatic("airliner-screens", screens, root);
  parts.push(screensMesh);
  parts.push(build.mergeStatic("airliner-screen-bezels", bezels, root));

  // THE DISPLAYS THEMSELVES, if this engine has a 2D canvas. Under NullEngine it does not, and the
  // screens keep the flat instrument-face material they were built with (see `displayAtlas.ts`).
  const atlas = createDisplayAtlas(build.scene, AIRLINER_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "airliner-display", atlas);
  }

  // NO 3D ATTITUDE BALL. There was one here -- three meshes and a pivot standing a millimetre in
  // front of the pilot's PFD -- from before the screens could draw anything. The PFD page draws its
  // own attitude now and agrees with the HUD to a tenth of a degree, so the ball was a second
  // attitude indicator sitting ON TOP of the first and hiding most of it (the frames in the findings
  // doc show it). The trainer keeps its MECHANICAL ball, which is what that aeroplane has, and the
  // Global keeps its until its own screens draw pages.

  // THE PILLAR AND THE SEAM POST, on the interior material with the board and the overhead they
  // hang from. Not the hood's matte one: that has no ambient light, so a face the sun misses reads
  // (0, 0, 0) and the pillar showed as a black hole beside a blue-grey ceiling. Not the airframe's
  // glossy dark one either: the pillar's big face showed a sheen of the sky across it.
  const pillarGeometry = airlinerPillarOutline();
  const pillar = solidPlate(
    build,
    "airliner-windscreen-pillar",
    [
      { x: -pillarGeometry.bottomHalf, y: 0 },
      { x: pillarGeometry.bottomHalf, y: 0 },
      { x: pillarGeometry.topHalf, y: pillarGeometry.length },
      { x: -pillarGeometry.topHalf, y: pillarGeometry.length },
    ],
    0.04,
    materials.interior,
    root,
  );
  const pillarUp = pillarGeometry.up;
  const pillarNormal = Vector3.Cross(across, pillarUp).normalize();
  orient(pillar, across, pillarUp, pillarNormal);
  pillar.position.copyFrom(pillarGeometry.bottom);
  // the design top is where the post meets the overhead; the MESH runs on past it (see AIRLINER_POST.buryMetres)
  const seam = airlinerSeamPostEndpoints();
  const postAxis = seam.top.subtract(seam.bottom).normalize();
  const buriedTop = seam.top.add(postAxis.scale(AIRLINER_POST.buryMetres));
  const post = build.strutBetween("airliner-windscreen-post-port", seam.bottom, buriedTop, AIRLINER_POST.radius, materials.interior, root);
  parts.push(build.mergeStatic("airliner-cockpit-interior", [board, overhead, pillar, post], root));

  // THE DISPLAYS ARE REDRAWN ON THE SHARED CLOCK (`displayRedrawClock`), not every frame: `update`
  // is only called while cockpit view is on (the visual gates it), 15 a second is as fast as a
  // display needs to move, and the visual invalidates it on entry. Before that invalidate existed,
  // every return to the cockpit after the first showed the pages from when the pilot last left for
  // up to three frames behind an instant camera cut: the counter stopped where it was on the way out.
  //
  // WHAT ONE REDRAW COSTS, measured in the live app on this machine (M2 Pro, WebGPU, 60 samples,
  // one update per animation frame, the texture proven live and bound each time): 0.3 ms to draw
  // the six pages, 2.0 ms for `getImageData`, 1.0 ms for `RawTexture.update`; 3.3 ms median, 3.5 ms
  // at p90, so about 50 ms a second at 15 Hz. The readback is the biggest part and exists only
  // because the bytes have to reach the GPU through a `RawTexture`: this engine build has neither
  // `createDynamicTexture` nor `updateDynamicTexture` (both measured undefined), so the canvas
  // cannot be handed to the texture directly. Both are on the register.
  const redraw = displayRedrawClock();
  return {
    parts,
    displaysLive: atlas !== null,
    invalidateDisplays() {
      redraw.invalidate();
    },
    update(state, secondsSinceLastUpdate = 0) {
      if (atlas === null) return;
      if (!redraw.tick(secondsSinceLastUpdate)) return;
      drawDisplays(atlas, displayStateFromVisual(state, AIRLINER_DISPLAY_AIRFRAME));
    },
  };
}

/** The painter: the four page kinds across the six slots, then the upload. */
function drawDisplays(atlas: DisplayAtlas, state: ReturnType<typeof displayStateFromVisual>): void {
  paintDisplays(atlas, state);
}
