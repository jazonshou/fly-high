import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { AircraftBuildContext } from "../builders";
import { facetMesh, glareshieldMaterial, roundedDeckSection, sculptSolid, solidPlate, type RoundedDeckSection } from "./cockpitPrimitives";
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
 * two MFDs on the panel's face, drawing the PFD and the map pages. The
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
 *  - the deck line, the silhouette straight ahead, is -10.19 degrees (the catalogue's
 *    `cockpitDeckLineDegrees`): the coaming's rounded rail stands on it (the F-16 pass,
 *    step 1; it was a wedge's far edge, with its flat top showing as a 5.8 degree band
 *    down to a near edge at -16.0). -10.19 and not lower because the nose must not
 *    show: from this eye the air-data probe's tip reads -10.41 and the radome's crown
 *    -11.23 (the radome is hidden in cockpit view, the probe is not), and an F-16 pilot
 *    does not see the nose. On the type the over-the-nose line is nearer -15, so the eye
 *    and the nose disagree by a few degrees: a nose-loft or eye question for a later pass;
 *  - the HUD frame's uprights stand at az +-6.5 and its top bar reads +4.5, the
 *    box containing (0, 0); the uprights' feet are BURIED in the hood, behind the rail;
 *  - the panel board is the dash: from the tub's top up to the cove's foot under the
 *    rail, with the MFDs on its face.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard; one seat on the centreline.
 * `tests/render.cockpit-jet.test.ts` holds the angles, the extents and the frame's
 * clearance to the BUILT mesh; the other measured records in these comments come
 * from the findings doc's survey (docs/findings/COCKPIT_VIEW_2026_09_20.md).
 */

export interface JetCockpitMaterials {
  /** The dark matte interior: the panel board (the tub and the seat are on it too). */
  readonly interior: PBRMaterial;
  /** The screens' flat material where there is no 2D canvas to draw pages on (every Node test). */
  readonly instrumentFace: PBRMaterial;
  /**
   * The bezel rims' shared material (`bezelRimMaterial`, `BEZEL_RIM`), which the HUD's housing wears: the visual
   * drives its night glow (`bezelRimEmissive`).
   */
  readonly rim: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("jet").cockpitEye;
}

const DEG = 180 / Math.PI;

// ---- the coaming ---------------------------------------------------------------

/**
 * A ROUNDED RAIL, not a wedge (the F-16 pass, step 1; the Global's deck, P1a). The deck line is the catalogue's
 * (10.19 degrees under the eye, over the nose probe's tip at -10.41), and it is the rail's ROUND at the aft face that
 * stands on it: the round is tangent to the sight line at a vertex, so the silhouette is one row of the picture. Under
 * the round a 45 degree cove turns in to the board's face (the dash); forward of it the hood falls away faster than the
 * sight line, so no part of its top is seen from the seat.
 *
 * WHY. The wedge's top was a flat, sky-facing plane that the pilot saw as a 5.8 degree band, the brightest thing on
 * the deck (58 luma against the near face's 20, uniform from front to back) with razor edges (57 to 24 in one pixel):
 * a table top. Shading a plane cannot help (a plane of any slope is lit evenly), and tilting it toward the pilot only
 * shows more of it; the rail shows the pilot a thin lit round and a dark cove instead, and the board's top rises to the
 * cove's foot, so the MFDs can stand 3.5 cm higher and their screens come into the frame whole.
 *
 * THE PLAN is the rail's full width at the aft face and narrows forward of the cove's foot to the hood's end, as the
 * canopy does. The width is the canopy's: the rail stands 7 cm higher than the wedge's near edge did, where the bubble
 * is narrower (0.380 to 0.384 inside at its top, x 2.92 to 2.95), and at the wedge's 0.38 it came within 1.1 mm of
 * the glass; at 0.36 it clears it by 2 cm, and the narrowing hood by 3 to 4 cm all the way forward.
 */
export const JET_GLARESHIELD = Object.freeze({
  /** The aft face, where the round turns under into the cove: 0.70 ahead of the eye. */
  aftX: 2.92,
  radius: 0.02,
  drop: 0,
  cove: 0.01,
  /** Steeper than the 10.19 degree sight line, so the hood's top never shows over the round. */
  hoodFallDegrees: 13,
  /** To x 3.50, the wedge's far edge: from outside it is still the dark hood over the panel. */
  hoodDepth: 0.58,
  roundSegments: 8,
  /** The plan's half-width: the rail's, to the cove's foot, then narrowing to the hood's forward end. */
  nearHalfWidth: 0.36,
  farHalfWidth: 0.26,
});

/** The rail's section in body x and y: the round on the deck line, the cove, the hood (`roundedDeckSection`). */
export function jetGlareshieldSection(): RoundedDeckSection {
  return roundedDeckSection(eye(), JET_GLARESHIELD.aftX, aircraftSpec("jet").cockpitDeckLineDegrees, JET_GLARESHIELD, "the F-16");
}

/** Height of the hood's top at a station forward of the round (where the HUD frame stands). */
export function jetCoamingTopY(x: number): number {
  const top = jetGlareshieldSection().round[0]!;
  return top.y - (x - top.x) * Math.tan((JET_GLARESHIELD.hoodFallDegrees * Math.PI) / 180);
}

/**
 * Half-width of the coaming's plan at a station: the rail's back to the cove's foot, then narrowing linearly to the
 * hood's forward end. Every vertex forward of the foot is on the linear part, so a wall's width at any station between
 * its vertices is this function's too.
 */
export function jetCoamingHalfWidth(x: number): number {
  const g = JET_GLARESHIELD;
  const from = g.aftX + g.cove;
  if (x <= from) return g.nearHalfWidth;
  return g.nearHalfWidth + ((g.farHalfWidth - g.nearHalfWidth) * (x - from)) / (g.aftX + g.hoodDepth - from);
}

// ---- the panel board ---------------------------------------------------------------

/**
 * One board and no dials: the DASH, its face at the cove's foot and its top there, from the tub up. Its plan is the
 * hood's less `sideInset` a side (its sides are never coplanar with the hood's walls), narrowing with the hood over its
 * depth, so its top is inside the hood along its whole depth: over the board the hood's underside falls away forward
 * from the cove's foot while the board's top stays at it. Upright in this step; the lean is step 3's.
 */
export const JET_PANEL = Object.freeze({
  thickness: 0.1,
  sideInset: 0.005,
  /** The tub's top. */
  bottomY: 0.3,
});

/** The board's face: at the cove's foot, and its top there. */
export function jetPanelFace(): { x: number; topY: number } {
  const foot = jetGlareshieldSection().faceTop;
  return { x: foot.x, topY: foot.y };
}

export function jetPanelTopY(): number {
  return jetPanelFace().topY;
}

// ---- the HUD combiner frame ---------------------------------------------------------------

/**
 * Two uprights and a top bar, vertical, in one plane, round the COMBINER's two tinted
 * panes (`JET_HUD_COMBINER`, the F-16 pass's step 2: the goalpost alone read as a black
 * doorway, and the glass is what makes it a HUD). The game's HUD symbology is drawn on
 * the screen at its centre, through the glass. The frame is cockpit-only.
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
  radius: 0.005,
  /**
   * The uprights' feet stand this far BELOW the housing's top over their axes (step 2: they
   * are in the housing's mount, not the hood): a strut that ended on a surface would show its
   * end disc as a lit octagon (the Cessna's centre frame did, until it was tapered); buried,
   * the cut end is inside the housing and nothing sees it. 1.5 cm, standing 1 cm clear of the
   * hood under the housing: the housing is 2.6 cm tall there (`JET_HUD_HOUSING`).
   */
  buryMetres: 0.015,
});

/**
 * THE HUD'S HOUSING (the F-16 pass, step 2): the projector's body the combiner stands on, a rounded box on the hood
 * behind the rail, between the uprights, as the type's HUD body sits on its glareshield. From the seat it is a low hump
 * over the rail: highest straight ahead (-8.6), falling gently toward the uprights and then over a round shoulder to
 * the rail's row at its ends, meeting it with no step. It is "structure", not deck: the 2D HUD's deck line (10.19) is
 * the rail's, and the hump stays more than 4 degrees under the symbology's lowest box (-4.3).
 *
 * WHY IT IS A HUMP AND NOT HIDDEN: at the frame's station the rail's sight line is 5 mm over the hood, so a housing
 * under the line is a plinth with no pixels.
 *
 * THE TOP FALLS FORWARD, section by section, just faster than the eye's sight line over its aft edge at that z, so the
 * aft edge is the silhouette everywhere and no top plane shows past it (a level top would show its FORWARD edge: built
 * level, it read -7.55). That caps how tall it can stand where the uprights' feet go in: 2.6 cm over the hood there,
 * so the feet are buried 1.5 cm and stand 1 cm clear of the hood (2 cm deep would lift the hump to -8.3).
 *
 * Built as a loft of rounded side sections across z: each section is the housing's side elevation at one z, its aft
 * and forward faces set in by the plan's rounded corners, its top edges rounded `edgeRadius`, its base buried 1 cm in
 * the hood (falling with it).
 */
export const JET_HUD_HOUSING = Object.freeze({
  halfWidth: 0.11,
  /** 1 cm aft of the uprights' aft surfaces (x 3.05, 5 mm rods). */
  aftX: 3.035,
  foreX: 3.12,
  /** Where the aft edge reads straight ahead. */
  peakDegrees: 8.6,
  /** How much lower the aft edge is where the crown meets the shoulders. */
  crown: 0.001,
  /** The top falls this much faster than the sight line over its aft edge. */
  fallMarginDegrees: 0.3,
  /** The plan's corners, and the side elevation's top edges. */
  planRadius: 0.02,
  edgeRadius: 0.01,
  /** The base, under the hood's top. */
  baseBury: 0.01,
});

/** The rail's row at a station x: the height the eye reads on the deck line there. */
function railRowY(x: number): number {
  const e = eye();
  return e.up - Math.tan((aircraftSpec("jet").cockpitDeckLineDegrees * Math.PI) / 180) * (x - e.forward);
}

/** How far the plan's rounded corners set the aft and forward faces in at a z. */
function jetHudHousingPlanIn(z: number): number {
  const h = JET_HUD_HOUSING;
  const from = h.halfWidth - h.planRadius;
  const a = Math.abs(z);
  if (a <= from) return 0;
  const t = Math.min(1, (a - from) / h.planRadius);
  return h.planRadius * (1 - Math.sqrt(1 - t * t));
}

/** The aft edge's height straight ahead: on the peak's sight line. */
function jetHudHousingPeakY(): number {
  const e = eye();
  const h = JET_HUD_HOUSING;
  return e.up - Math.tan((h.peakDegrees * Math.PI) / 180) * (h.aftX - e.forward);
}

/** The shoulders' radius: from the crown's edge down to the rail's row (half a millimetre over it) at the ends. */
function jetHudHousingShoulder(): number {
  const h = JET_HUD_HOUSING;
  return jetHudHousingPeakY() - h.crown - (railRowY(h.aftX + h.planRadius) + 0.0005);
}

/**
 * The housing's aft top edge (the sharp corner its round is laid in) at a z: the crown, then the round shoulder down
 * to the rail's row at |z| = halfWidth.
 */
export function jetHudHousingAftTopY(z: number): number {
  const h = JET_HUD_HOUSING;
  const rs = jetHudHousingShoulder();
  const zc = h.halfWidth - rs;
  const a = Math.min(Math.abs(z), h.halfWidth);
  const top = jetHudHousingPeakY();
  if (a <= zc) return top - h.crown * (a / zc) ** 2;
  return top - h.crown - rs + Math.sqrt(Math.max(0, rs * rs - (a - zc) ** 2));
}

/** The section at a z: its aft x, the aft top edge's height there, and the top's fall (radians), faster than the sight line. */
function jetHudHousingSectionAt(z: number): { aft: number; fore: number; y: number; fall: number } {
  const e = eye();
  const h = JET_HUD_HOUSING;
  const aft = h.aftX + jetHudHousingPlanIn(z);
  const fore = h.foreX - jetHudHousingPlanIn(z);
  const y = jetHudHousingAftTopY(z);
  const fall = Math.atan2(e.up - y, aft - e.forward) + (h.fallMarginDegrees * Math.PI) / 180;
  return { aft, fore, y, fall };
}

/** The housing's top (the sharp-cornered line its rounds are laid in) at a station x and a z. */
export function jetHudHousingTopY(x: number, z: number): number {
  const s = jetHudHousingSectionAt(z);
  return s.y - (x - s.aft) * Math.tan(s.fall);
}

/** The housing as flat quads, each with its outward normal (`facetMesh`). */
function jetHudHousingFacets(): { corners: [Vector3, Vector3, Vector3, Vector3]; normal: Vector3 }[] {
  const h = JET_HUD_HOUSING;
  const rs = jetHudHousingShoulder();
  const zc = h.halfWidth - rs;
  // stations across z: the crown every third of it, then the shoulder by quarter-circle steps
  const half: number[] = [0, zc / 3, (2 * zc) / 3, zc, ...[22.5, 45, 67.5, 90].map((d) => zc + rs * Math.sin((d * Math.PI) / 180))];
  const zs = [...half.slice(1).map((z) => -z).reverse(), ...half];
  const base = (x: number) => jetCoamingTopY(x) - h.baseBury;
  const section = (z: number): Vector3[] => {
    const { aft, fore, y, fall } = jetHudHousingSectionAt(z);
    const top = (x: number) => y - (x - aft) * Math.tan(fall);
    const r = Math.min(h.edgeRadius, (top(fore) - base(fore)) * 0.45);
    const n = { x: Math.sin(fall), y: Math.cos(fall) };
    // the aft round: tangent to the aft face and the top line; the forward round: to the top line and the fore face
    const aftC = { x: aft + r, y: y - (r * (1 + n.x)) / n.y };
    const foreC = { x: fore - r, y: y - (r + n.x * (fore - r - aft)) / n.y };
    const topAngle = Math.PI / 2 - fall;
    const out: Vector3[] = [new Vector3(aft, base(aft), z)];
    for (let k = 0; k <= 4; k += 1) {
      const t = Math.PI + ((topAngle - Math.PI) * k) / 4;
      out.push(new Vector3(aftC.x + r * Math.cos(t), aftC.y + r * Math.sin(t), z));
    }
    for (let k = 0; k <= 4; k += 1) {
      const t = topAngle - (topAngle * k) / 4;
      out.push(new Vector3(foreC.x + r * Math.cos(t), foreC.y + r * Math.sin(t), z));
    }
    out.push(new Vector3(fore, base(fore), z));
    return out;
  };
  const sections = zs.map(section);
  const all = sections.flat();
  const centroid = all.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / all.length);
  const quads: { corners: [Vector3, Vector3, Vector3, Vector3]; normal: Vector3 }[] = [];
  const outward = (corners: [Vector3, Vector3, Vector3, Vector3], n: Vector3) => {
    const centre = corners.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / 4);
    return Vector3.Dot(n, centre.subtract(centroid)) >= 0 ? n : n.scale(-1);
  };
  for (let k = 0; k + 1 < sections.length; k += 1) {
    const a = sections[k]!;
    const b = sections[k + 1]!;
    for (let i = 0; i < a.length; i += 1) {
      const j = (i + 1) % a.length;
      const corners: [Vector3, Vector3, Vector3, Vector3] = [a[i]!, a[j]!, b[j]!, b[i]!];
      const n = Vector3.Cross(a[j]!.subtract(a[i]!), b[i]!.subtract(a[i]!)).normalize();
      quads.push({ corners, normal: outward(corners, n) });
    }
  }
  // the two end caps, fanned from each end section's centre (a quad with a repeated corner is one triangle)
  for (const end of [sections[0]!, sections[sections.length - 1]!]) {
    const c = end.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / end.length);
    const n = new Vector3(0, 0, Math.sign(end[0]!.z));
    for (let i = 0; i < end.length; i += 1) quads.push({ corners: [c, end[i]!, end[(i + 1) % end.length]!, end[(i + 1) % end.length]!], normal: n });
  }
  return quads;
}

/**
 * THE COMBINER: two tinted panes filling the frame's opening (step 2), 1 cm apart at x 3.045 and 3.055, straddling the
 * frame's plane: from the uprights' and the bar's axes (their edges inside the rods' outline from the seat) down into
 * the housing (their bottom edge under its top, so no gap shows over it). Single-sided toward the eye.
 *
 * THE GLASS: a new instance of the canopy glass's kind (alpha-blended PBR, nothing the canopy's shader does not do),
 * green-gold, at an alpha that darkens the world through both panes by 1 - 0.95^2 = 9.75%, in the design's 5 to 15%.
 * No depth pre-pass and no depth write, as the canopy's: written, the panes' depth would cut the canopy behind them
 * (sorted after them, its bounding centre being nearer the eye), and the combiner would read brighter than its
 * surround, not tinted. The live frame is the measurement (the glass adds its own reflection).
 */
export const JET_HUD_COMBINER = Object.freeze({
  paneX: [3.045, 3.055] as const,
  albedo: 0x9fb86a,
  alpha: 0.05,
  /** The panes' bottom edge, this far under the housing's top at the uprights. */
  intoHousing: 0.005,
});

/** The two panes' corners, aft then forward, each bottom-port, bottom-starboard, top-starboard, top-port. */
export function jetHudCombinerPanes(): readonly (readonly [Vector3, Vector3, Vector3, Vector3])[] {
  const f = JET_HUD_FRAME;
  return JET_HUD_COMBINER.paneX.map((x) => {
    const bottom = jetHudHousingTopY(x, f.z) - JET_HUD_COMBINER.intoHousing;
    return [
    new Vector3(x, bottom, -f.z),
    new Vector3(x, bottom, f.z),
    new Vector3(x, f.barY, f.z),
    new Vector3(x, f.barY, -f.z),
    ] as const;
  });
}

/** Where the uprights' feet are: in the housing, `buryMetres` under its top over their axes. */
export function jetHudFrameFootY(): number {
  return jetHudHousingTopY(JET_HUD_FRAME.x, JET_HUD_FRAME.z) - JET_HUD_FRAME.buryMetres;
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
 * Two square MFDs on the board's face (the dash), the type's: a 6-inch bezel round a 4-inch screen, the
 * bezel band being where the real jet's buttons sit. They stand PROUD of the face on their own bezels,
 * TILTED BACK about the top back edge, which lies 1 mm off the face plane, and the bottom stands out
 * toward the pilot, so the screen faces up at an eye that looks down at it. From the eye to the
 * screen's centre that is 15.2 degrees off the face's normal (cos 0.965), measured in 3D at the
 * MFDs' +-14.4 azimuth; tilting the top toward the pilot instead left it 39.3 off (0.774), upright
 * 25.9 (0.900).
 *
 * THE CEILING (`jetMfdCeilingY`). Nothing of them may stand above 1 cm under the cove's foot, the
 * lowest edge of the deck the pilot sees, so the round and the cove show whole over them. The FRONT top
 * corner is the highest point (the face leans back, so the front is above the back), so the back top edge
 * sits `thickness * sin(tilt)` lower. Under the wedge the ceiling was 0.735, 4 mm under its near edge.
 *
 * WHAT OF THEM IS SEEN. The 16:9 frame's bottom at their azimuth (+-14.4) is -22.7, not the -23.35 it
 * is straight ahead (the frame is a rectangle). Under the wedge's near edge at -16 the frame showed 63%
 * of each screen; under the rail's cove at -12.7 they stand 3.5 cm higher, and the frame shows all of it
 * (measured on the built mesh by the test). The ND still puts its own ship higher on a square page
 * (`drawNd`), and the PFD's heading strip still repeats the HUD's heading tape.
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
  /** How far under the cove's foot nothing of them may stand. */
  underCoveFoot: 0.01,
  /** The bezels' backs stand this far in front of the face plane, so no two faces are coincident. */
  standOff: 0.001,
});

/** The MFDs' ceiling: `underCoveFoot` under the cove's foot. */
export function jetMfdCeilingY(): number {
  return jetPanelFace().topY - JET_MFD.underCoveFoot;
}

/** The frame an MFD is built in: its back top edge on the face plane, up the face, and the face's outward normal. */
export function jetMfdFrame(): { backTop: Vector3; up: Vector3; out: Vector3 } {
  const m = JET_MFD;
  const t = (m.tiltDegrees * Math.PI) / 180;
  const up = new Vector3(Math.sin(t), Math.cos(t), 0);
  const out = new Vector3(-Math.cos(t), Math.sin(t), 0);
  // the FRONT top corner is at the ceiling: back top = ceiling - thickness * sin(tilt)
  const backTop = new Vector3(jetPanelFace().x - m.standOff, jetMfdCeilingY() - m.bezelThickness * Math.sin(t), 0);
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
   * frame, its housing, its combiner's panes, the MFD bezels and the MFD screens.
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
 * from outside too. Its shape is a `solidPlate` of the rail's section
 * (`jetGlareshieldSection`) at its full width, then `sculptSolid` narrows the plan
 * forward of the board's back: `verticalProfile` cannot taper.
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
  const g = JET_GLARESHIELD;
  const glare = glareshieldMaterial(build, "jet-glareshield");
  // The rail's section, extruded across the full width; then the plan is narrowed forward
  // of the board's back. Local space is body space here: the mesh hangs from the root
  // with no transform of its own.
  const coaming = solidPlate(build, "jet-glare-shield", jetGlareshieldSection().outline, g.nearHalfWidth * 2, glare, root);
  sculptSolid(coaming, (point) => new Vector3(point.x, point.y, (point.z * jetCoamingHalfWidth(point.x)) / g.nearHalfWidth));
  coaming.metadata = { ...coaming.metadata, cockpitInterior: true, castsShadow: false };

  // THE BOARD, a plate of its side elevation at the face's width, narrowed with the hood over its depth
  const p = JET_PANEL;
  const face = jetPanelFace();
  const faceHalfWidth = g.nearHalfWidth - p.sideInset;
  const board = solidPlate(
    build,
    "jet-instrument-panel",
    [
      { x: face.x, y: p.bottomY },
      { x: face.x + p.thickness, y: p.bottomY },
      { x: face.x + p.thickness, y: face.topY },
      { x: face.x, y: face.topY },
    ],
    faceHalfWidth * 2,
    materials.interior,
    root,
  );
  sculptSolid(board, (point) => new Vector3(point.x, point.y, (point.z * (jetCoamingHalfWidth(point.x) - p.sideInset)) / faceHalfWidth));
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

  // THE HOUSING, on the bezel rims' material (dark grey, the faint lit edge by day, the panel's night glow), its own
  // opaque mesh: the frame is on the glareshield's matte
  const housing = facetMesh(build, "jet-hud-housing", jetHudHousingFacets(), materials.rim, root);

  // THE COMBINER: both panes one mesh on a new instance of the canopy glass's kind, single-sided toward the eye (the
  // material is two-sided, as every alpha-blended airframe material is; the winding is what the drawn-faces walk reads)
  const c = JET_HUD_COMBINER;
  const combinerGlass = build.material("jet-hud-glass", c.albedo, { roughness: 0.05, metallic: 0, alpha: c.alpha });
  combinerGlass.needDepthPrePass = false;
  combinerGlass.disableDepthWrite = true;
  const toward = new Vector3(-1, 0, 0);
  const combiner = facetMesh(build, "jet-hud-combiner", jetHudCombinerPanes().map((corners) => ({ corners, normal: toward })), combinerGlass, root);

  // THE MFDs: two meshes for four boxes, as the Global's are. Each box is built square and turned back
  // by the tilt about z (its local X is its thickness, pointing away from the pilot; local Y runs up
  // the face), and its PILOT-FACING face -- local normal -X, which the turn does not change in the
  // vertex data -- is pointed at its own slot of the atlas before the merge bakes the transforms.
  const m = JET_MFD;
  const tilt = (m.tiltDegrees * Math.PI) / 180;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  // The bezels' own dark grey, the type's: on the interior grey they read as light slabs against the near-black
  // coaming (79/255 luma against its 20.5, measured live at one frozen pose). At 0x101010, otherwise the interior's
  // roughness and metalness, the lit face reads 41 (the side border 39): twice the coaming's face, far below the
  // screens' text.
  const bezelMaterial = build.material("jet-mfd-bezel", 0x101010, { roughness: 0.8, metallic: 0.02 });
  const slots = displaySlots(JET_DISPLAYS);
  const atlasWidth = displayAtlasWidth(JET_DISPLAYS);
  const atlasHeight = displayAtlasHeight(JET_DISPLAYS);
  for (const [index, { name, bezel: bezelCentre, centre }] of jetMfdPlacements().entries()) {
    const bezel = build.box(`jet-mfd-bezel-${name}`, m.bezelThickness, m.bezel, m.bezel, bezelMaterial, root);
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
    parts: [frame, housing, combiner, bezelsMesh, screensMesh],
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
