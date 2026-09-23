import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, sculptSolid, solidPlate } from "./cockpitPrimitives";
import {
  JET_DISPLAYS,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displayRedrawClock,
  displaySlots,
  paintDisplays,
  remapScreenFaceToSlot,
} from "./displays/displayAtlas";
import { displayStateFromVisual, type DisplayAirframe } from "./displays/displayStateFromVisual";
import type { FlightVisualState } from "@/src/game/types";

/**
 * What the F-16's pilot sees over the coaming, built to angles. PHASE F1: the
 * coaming, the panel board under it and the HUD's combiner frame. PHASE F2: the
 * two MFDs on the coaming's near face, drawing the PFD and the map pages. The
 * UFC between them is not built.
 *
 * WHY THIS EXISTS. The old cockpit was a tilted `jet-glare-shield` box whose
 * top read -11 degrees straight ahead, with the panel board's top standing above
 * it as the silhouette at -9.3 and five round dials on the board that the box
 * hid; the frame read as sky over a dark shelf with nothing of the aeroplane in
 * it above the horizon. On the type the pilot sits high
 * under a bubble, and what frames the forward view is the HUD's combiner
 * standing on the coaming with the symbology in it; the game's own HUD
 * symbology is drawn at the screen's centre, so the frame is built AROUND (0, 0).
 *
 * THE TARGETS, as angles from the eye E = (2.22, 0.94, 0) (`catalogue.cockpitEye`,
 * which this pass does not move) at the 75 degree lens:
 *  - the coaming's far edge is the silhouette straight ahead at -10.2 degrees and
 *    its near edge (the panel face) at -16.0, so its top surface shows as a 5.8
 *    degree band. -10.2 and not lower because the nose must not show: from this eye
 *    the air-data probe's tip reads -10.41 and the radome's crown -11.23 (the radome
 *    is hidden in cockpit view, the probe is not), and an F-16 pilot does not see
 *    the nose. On the type the over-the-nose line is nearer -15, so the eye and the
 *    nose disagree by a few degrees: a nose-loft or eye question for a later pass;
 *  - the HUD frame's uprights stand at az +-6.5 and its top bar reads +4.5, the
 *    box containing (0, 0); the uprights' feet are BURIED in the coaming;
 *  - the panel board runs from the tub's top up under the coaming, and nothing
 *    of it shows above the coaming's near edge.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard; one seat on the centreline.
 * `tests/render.cockpit-jet.test.ts` holds the angles, the extents and the frame's
 * clearance to the BUILT mesh; the other measured records in these comments come
 * from the findings doc's survey (docs/findings/COCKPIT_VIEW_2026_09_20.md).
 */

export interface JetCockpitMaterials {
  /** The dark matte interior: the panel board and the MFD bezels (the tub and the seat are on it too). */
  readonly interior: PBRMaterial;
  /** The screens' flat material where there is no 2D canvas to draw pages on (every Node test). */
  readonly instrumentFace: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("jet").cockpitEye;
}

const DEG = 180 / Math.PI;

// ---- the coaming ---------------------------------------------------------------

/**
 * A WEDGE, not a tilted box: its top surface runs from the panel face down to a far
 * edge, its underside is flat, its sides are vertical, and its plan narrows toward
 * the nose as the canopy does. The far edge is what the pilot sees as the bottom of
 * the world; the top surface shows between it and the near edge.
 */
export const JET_COAMING = Object.freeze({
  /** The panel face: where the top surface starts. */
  nearX: 2.92,
  /** Reads -16.0 degrees straight ahead. */
  nearTopY: 0.739,
  farX: 3.5,
  /**
   * Reads -10.19 degrees straight ahead: the silhouette, over the probe's tip at -10.41 (the old board's
   * top, the silhouette before, read -9.3). The glass is 0.077 above the far corners (3.5, 0.710, +-0.26)
   * and 0.030 from them at its nearest,
   * and nothing of the airframe but the glass is over the coaming (the cockpit-only HUD frame stands on
   * it): it is under the bubble, which runs to x 4.1.
   */
  farTopY: 0.71,
  undersideY: 0.6,
  nearHalfWidth: 0.38,
  farHalfWidth: 0.26,
});

/** Height of the coaming's top surface at a station between its near and far edges. */
export function jetCoamingTopY(x: number): number {
  const c = JET_COAMING;
  return c.nearTopY + ((c.farTopY - c.nearTopY) * (x - c.nearX)) / (c.farX - c.nearX);
}

/** Half-width of the coaming's plan at a station between its near and far edges. */
export function jetCoamingHalfWidth(x: number): number {
  const c = JET_COAMING;
  return c.nearHalfWidth + ((c.farHalfWidth - c.nearHalfWidth) * (x - c.nearX)) / (c.farX - c.nearX);
}

/** What an edge of the coaming's top surface reads straight ahead, from the eye. */
export function jetCoamingEdgeElevationDegrees(edge: "near" | "far"): number {
  const c = JET_COAMING;
  const e = eye();
  const x = edge === "near" ? c.nearX : c.farX;
  const y = edge === "near" ? c.nearTopY : c.farTopY;
  return Math.atan2(y - e.up, x - e.forward) * DEG;
}

// ---- the panel board ---------------------------------------------------------------

/**
 * One board and no dials. It stands on the tub and runs up INTO the coaming, whose
 * near face carries the panel face on up to the -16 degree edge. In a 16:9 window
 * the board is the first surface nowhere: straight ahead it takes over from the
 * coaming's near face at -25.9, below the frame's -23.35. In windows of 1.55:1 or
 * squarer (3:2, 4:3) its face shows under the coaming's near face as a band of the
 * interior's grey, lighter than the near face: the cockpit is composed for 16:10 and
 * wider.
 *
 * WHY IT STOPS INSIDE THE COAMING rather than at the coaming's near top edge. The
 * coaming's top surface slopes DOWN from that edge, so a board of any thickness
 * whose top were at y 0.739 would stand proud of the surface just ahead of the
 * edge (5 mm over its 0.1 m depth) and its top face would show from the
 * seat as a strip above the coaming. Buried 2 cm above the underside, nothing of it
 * can show: the coaming's near face is 1 mm nearer the eye than the board's over the
 * buried strip, so no two faces are coincident.
 */
export const JET_PANEL = Object.freeze({
  /** The panel face, which is the coaming's near face; the board's own face stands `setBack` ahead of it. */
  faceX: 2.92,
  setBack: 0.001,
  thickness: 0.1,
  /**
   * 0.355, not the design's 0.40, and measured: the coaming's plan narrows from 0.380 at the board's face to
   * 0.359 at its back (x 2.921 to 3.021), so a 0.40 board stood out past the coaming's side walls there and
   * two strips of its top, 2 to 4 cm wide, showed from outside above the sill. At 0.355 its top is under
   * the coaming along its whole depth, and no lip of it shows beside the coaming's near face from the
   * seat, in any window shape.
   */
  halfWidth: 0.355,
  /** The tub's top. */
  bottomY: 0.3,
  /** The board's top runs this far up into the coaming, above its underside. */
  buryMetres: 0.02,
});

export function jetPanelTopY(): number {
  return JET_COAMING.undersideY + JET_PANEL.buryMetres;
}

// ---- the HUD combiner frame ---------------------------------------------------------------

/**
 * Two uprights and a top bar, vertical, in one plane, and NO glass plate: the game's
 * HUD symbology is drawn on the screen at its centre, and a plate in front of it would
 * be a second surface for the eye to focus on. The frame is cockpit-only.
 *
 * AT x 3.05, not the design's 3.15: the bubble curves down off the centreline, and at
 * 3.15 the frame (then 12 mm rods) cleared the BUILT glass by only 0.021 (the design
 * assumed a crown of 1.10 there; it is 1.088 on the centreline and 1.05 over the bar's
 * ends). At 3.05, with the same angles, the frame is 0.1 m nearer the eye and smaller,
 * and clears it by 0.074 at its top corners. Both are the distance from each vertex to
 * the nearest glass triangle.
 *
 * 8 mm RODS, not 12: at 12 the uprights were 1.6 degrees wide, about 30 px at 1600, and
 * the frame read as a black doorway round the symbology. At 8 they are 1.1 degrees,
 * about 20 px: thin enough to read as a combiner frame, thick enough to read at all.
 *
 * The game's HUD is 2D and the frame is 3D, so at some window shapes a pitch-ladder
 * line crosses an upright. A real combiner frame does the same; the frame is built
 * to the angles and does not chase window widths.
 */
export const JET_HUD_FRAME = Object.freeze({
  /** The frame's plane. */
  x: 3.05,
  /** The uprights' axes: az +-6.5 from the eye (0.83 tan 6.5). */
  z: 0.0946,
  /** The bar's axis: +4.5 from the eye (0.94 + 0.83 tan 4.5). */
  barY: 1.0053,
  radius: 0.008,
  /**
   * The uprights' feet stand this far BELOW the coaming's top surface at the frame's
   * station: a strut that ended on the surface would show its end disc as a lit
   * octagon (the Cessna's centre frame did, until it was tapered); buried, the cut
   * end is inside the coaming and nothing sees it.
   */
  buryMetres: 0.03,
});

/** Where the uprights' feet are: inside the coaming. */
export function jetHudFrameFootY(): number {
  return jetCoamingTopY(JET_HUD_FRAME.x) - JET_HUD_FRAME.buryMetres;
}

/** What the uprights and the bar read from the eye: the design's az +-6.5 and el +4.5. */
export function jetHudFrameAngles(): { uprightAzimuthDegrees: number; barElevationDegrees: number } {
  const f = JET_HUD_FRAME;
  const e = eye();
  return {
    uprightAzimuthDegrees: Math.atan2(f.z, f.x - e.forward) * DEG,
    barElevationDegrees: Math.atan2(f.barY - e.up, f.x - e.forward) * DEG,
  };
}

// ---- the MFDs --------------------------------------------------------------------------------

/**
 * Two square MFDs on the coaming's near face, the type's: a 6-inch bezel round a 4-inch screen, the
 * bezel band being where the real jet's buttons sit. They stand PROUD of the face on their own bezels,
 * TILTED BACK about the top back edge, which lies 1 mm off the face plane, and the bottom stands out
 * toward the pilot, so the screen faces up at an eye that looks down at it. From the eye to the
 * screen's centre that is 15.2 degrees off the face's normal (cos 0.965), measured in 3D at the
 * MFDs' +-14.4 azimuth; tilting the top toward the pilot instead left it 39.3 off (0.774), upright
 * 25.9 (0.900).
 *
 * THE CEILING. Nothing of them may stand above y 0.735: the coaming's top surface starts at 0.739 at
 * the near edge, and a bezel above it would stand proud of the hood from the seat and from outside.
 * The FRONT top corner is the highest point (the face leans back, so the front is above the back), so
 * the back top edge sits `thickness * sin(tilt)` lower.
 *
 * WHAT OF THEM IS SEEN. The 16:9 frame's bottom at their azimuth (+-14.4) is -22.7, not the -23.35 it
 * is straight ahead (the frame is a rectangle), so the frame shows the top of each page and not the
 * bottom: 63% of the screen, measured on the built mesh by the test. The game has no head movement,
 * so the bottom 37% of each page is never seen: the ND puts its own ship higher on a square page to
 * stay in view (`drawNd`), and the PFD's heading strip, which is lost, repeats the HUD's heading tape.
 */
export const JET_MFD = Object.freeze({
  /** The bezel: square, and its thickness. */
  bezel: 0.15,
  bezelThickness: 0.02,
  /** The screen: square, on the bezel's front face (lifted `screenLift`), standing `screenProud` in front of it. */
  screen: 0.102,
  screenThickness: 0.003,
  screenProud: 0.001,
  /**
   * How far the screen's centre stands ABOVE the bezel's centre, up the face: 6 mm, so the border is 18 mm
   * above the screen and 30 mm below it. That is this game's choice, not the type's (whose bezel carries
   * buttons on all four sides): centred, the frame's bottom at the MFDs' azimuth left 57% of the screen in
   * view; lifted, 63%.
   */
  screenLift: 0.006,
  /** Each MFD's centre line; the 0.19 between the bezels is the UFC's (not built). */
  z: 0.17,
  /** Back from vertical, about the top back edge: the bottom stands out toward the pilot. */
  tiltDegrees: 15,
  /** Nothing of them above this: the coaming's top surface starts at 0.739. */
  ceilingY: 0.735,
  /** The bezels' backs stand this far in front of the face plane, so no two faces are coincident. */
  standOff: 0.001,
});

/** The frame an MFD is built in: its back top edge on the face plane, up the face, and the face's outward normal. */
export function jetMfdFrame(): { backTop: Vector3; up: Vector3; out: Vector3 } {
  const m = JET_MFD;
  const t = (m.tiltDegrees * Math.PI) / 180;
  const up = new Vector3(Math.sin(t), Math.cos(t), 0);
  const out = new Vector3(-Math.cos(t), Math.sin(t), 0);
  // the FRONT top corner is at the ceiling: back top = ceiling - thickness * sin(tilt)
  const backTop = new Vector3(JET_PANEL.faceX - m.standOff, m.ceilingY - m.bezelThickness * Math.sin(t), 0);
  return { backTop, up, out };
}

/** Each MFD's bezel and screen centres, port then starboard: the build order, and the slot order. */
export function jetMfdPlacements(): readonly { name: "port" | "starboard"; bezel: Vector3; centre: Vector3 }[] {
  const m = JET_MFD;
  const { backTop, up, out } = jetMfdFrame();
  const bezelFrontCentre = backTop.subtract(up.scale(m.bezel / 2)).add(out.scale(m.bezelThickness));
  const bezel = bezelFrontCentre.subtract(out.scale(m.bezelThickness / 2));
  const screen = bezelFrontCentre.add(up.scale(m.screenLift)).add(out.scale(m.screenProud - m.screenThickness / 2));
  return (["port", "starboard"] as const).map((name) => {
    const z = name === "port" ? -m.z : m.z;
    return { name, bezel: new Vector3(bezel.x, bezel.y, z), centre: new Vector3(screen.x, screen.y, z) };
  });
}

/** What the pages need of this airframe that the flight state does not carry: one engine, 20 degrees of flap (`animation.ts`). */
export const JET_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 1, fullFlapDegrees: 20 });

// ---- the builder ----------------------------------------------------------------------------

/** What `buildJetCockpit` hands back. */
export interface JetCockpit {
  /** `jet-glare-shield`: the coaming, an ordinary airframe part (visible from outside). */
  readonly coaming: Mesh;
  /** `jet-instrument-panel`: the board, an ordinary airframe part. */
  readonly board: Mesh;
  /**
   * The cockpit-only meshes, unconfigured: the caller marks them (`configureCockpitOnlyParts`). The HUD
   * frame, the MFD bezels and the MFD screens.
   */
  readonly parts: readonly AbstractMesh[];
  /** Whether the MFDs are drawing pages: false wherever there is no 2D canvas (every Node test). */
  readonly displaysLive: boolean;
  /** Call on the way INTO cockpit view: the next update redraws whatever the clock says. */
  invalidateDisplays(): void;
  /** Redraw the pages on the shared 15 Hz clock; the visual calls it only while cockpit view is on. */
  update(state: FlightVisualState, secondsSinceLastUpdate?: number): void;
}

/**
 * Build the coaming, the board and the HUD frame.
 *
 * THE COAMING keeps the exterior job the old box had -- from outside it is the dark
 * hood that hides the panel's top -- so it stays an ordinary part with
 * `cockpitInterior`, NOT cockpit-only. It is on the MATTE glareshield material, the
 * frame's instance, not the airframe's dark: from the seat a near-flat top surface on
 * a material with image-based light caught the sky at grazing angles and read as a
 * pale shelf, which is what a glareshield exists to stop, and the real hood is matte
 * from outside too. Its shape is a `solidPlate`
 * of its side elevation at its full near width, then `sculptSolid` narrows the plan
 * toward the far edge: `verticalProfile` cannot taper, and a tapered box is not a box.
 *
 * THE FRAME is three UNTAPERED rods merged into ONE mesh on the shared matte
 * glareshield material (one instance). Not `strutBetween`: it makes a strut's `from`
 * end 8% fatter, which left the bar lopsided on screen by 1.5 px. The bar runs between
 * the uprights' AXES, so its ends are inside the uprights; running it to their outboard
 * faces left its octagonal ends standing 1.6 px past them. The uprights run up to the
 * bar's top, so the corners close. From the seat every end disc faces away and is
 * culled -- the uprights' tops face up, the bar's ends face outboard -- and the feet
 * are inside the coaming.
 */
export function buildJetCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: JetCockpitMaterials,
): JetCockpit {
  const c = JET_COAMING;
  const glare = glareshieldMaterial(build, "jet-glareshield");
  // The side elevation, extruded across the full near width; then the plan is narrowed
  // toward the far edge. Local space is body space here: the mesh hangs from the root
  // with no transform of its own.
  const coaming = solidPlate(
    build,
    "jet-glare-shield",
    [
      { x: c.nearX, y: c.undersideY },
      { x: c.farX, y: c.undersideY },
      { x: c.farX, y: c.farTopY },
      { x: c.nearX, y: c.nearTopY },
    ],
    c.nearHalfWidth * 2,
    glare,
    root,
  );
  sculptSolid(coaming, (point) => new Vector3(point.x, point.y, (point.z * jetCoamingHalfWidth(point.x)) / c.nearHalfWidth));
  coaming.metadata = { ...coaming.metadata, cockpitInterior: true, castsShadow: false };

  const p = JET_PANEL;
  const boardTop = jetPanelTopY();
  const board = build.box("jet-instrument-panel", p.thickness, boardTop - p.bottomY, p.halfWidth * 2, materials.interior, root);
  board.position.set(p.faceX + p.setBack + p.thickness / 2, (p.bottomY + boardTop) / 2, 0);
  board.metadata = { ...board.metadata, cockpitInterior: true };

  const f = JET_HUD_FRAME;
  const footY = jetHudFrameFootY();
  const topY = f.barY + f.radius;
  // an untapered rod between two points, oriented as `strutBetween` orients its cylinder
  const rod = (name: string, from: Vector3, to: Vector3) => {
    const run = to.subtract(from);
    const piece = build.cylinder(name, run.length(), f.radius * 2, f.radius * 2, 8, glare, root);
    piece.position.copyFrom(from.add(to).scale(0.5));
    piece.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, run.scale(1 / run.length()), new Quaternion());
    return piece;
  };
  const uprights = ([-1, 1] as const).map((side) =>
    rod(
      side < 0 ? "jet-hud-frame-upright-port" : "jet-hud-frame-upright-starboard",
      new Vector3(f.x, footY, side * f.z),
      new Vector3(f.x, topY, side * f.z),
    ));
  const bar = rod("jet-hud-frame-bar", new Vector3(f.x, f.barY, -f.z), new Vector3(f.x, f.barY, f.z));
  const frame = build.mergeStatic("jet-hud-frame", [...uprights, bar], root);

  // THE MFDs: two meshes for four boxes, as the Global's are. Each box is built square and turned back
  // by the tilt about z (its local X is its thickness, pointing away from the pilot; local Y runs up
  // the face), and its PILOT-FACING face -- local normal -X, which the turn does not change in the
  // vertex data -- is pointed at its own slot of the atlas before the merge bakes the transforms.
  const m = JET_MFD;
  const tilt = (m.tiltDegrees * Math.PI) / 180;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  const slots = displaySlots(JET_DISPLAYS);
  const atlasWidth = displayAtlasWidth(JET_DISPLAYS);
  const atlasHeight = displayAtlasHeight(JET_DISPLAYS);
  for (const [index, { name, bezel: bezelCentre, centre }] of jetMfdPlacements().entries()) {
    const bezel = build.box(`jet-mfd-bezel-${name}`, m.bezelThickness, m.bezel, m.bezel, materials.interior, root);
    bezel.position.copyFrom(bezelCentre);
    bezel.rotation.z = -tilt;
    bezels.push(bezel);
    const screen = build.box(`jet-mfd-screen-${name}`, m.screenThickness, m.screen, m.screen, materials.instrumentFace, root);
    screen.position.copyFrom(centre);
    screen.rotation.z = -tilt;
    remapScreenFaceToSlot(screen, slots[index]!, atlasWidth, atlasHeight);
    screens.push(screen);
  }
  const screensMesh = build.mergeStatic(JET_DISPLAYS.screensMesh, screens, root);
  const bezelsMesh = build.mergeStatic("jet-mfd-bezels", bezels, root);

  // THE PAGES, where there is a 2D canvas; under NullEngine the screens keep their flat material.
  const atlas = createDisplayAtlas(build, JET_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "jet-display", atlas);
  }
  // Redrawn on the shared clock, invalidated on the way into cockpit view (`displayRedrawClock`).
  const redraw = displayRedrawClock();
  return {
    coaming,
    board,
    parts: [frame, bezelsMesh, screensMesh],
    displaysLive: atlas !== null,
    invalidateDisplays() {
      redraw.invalidate();
    },
    update(state, secondsSinceLastUpdate = 0) {
      if (atlas === null) return;
      if (!redraw.tick(secondsSinceLastUpdate)) return;
      paintDisplays(atlas, displayStateFromVisual(state, JET_DISPLAY_AIRFRAME));
    },
  };
}
