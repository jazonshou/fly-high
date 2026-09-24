import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { AircraftBuildContext } from "../builders";
import {
  facetMesh,
  framedScreenFacets,
  framedScreenStack,
  glareshieldMaterial,
  roundedDeckSection,
  sculptSolid,
  smoothRoundNormals,
  solidPlate,
  sweptSolid,
  type RoundedDeckSection,
  type SweptSection,
} from "./cockpitPrimitives";
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
  /** The screens' flat material where there is no 2D canvas to draw pages on (every Node test). */
  readonly instrumentFace: PBRMaterial;
  /**
   * The bezel rims' shared material (`bezelRimMaterial`, `BEZEL_RIM`), which the MFDs' rims wear: the visual drives
   * its night glow (`bezelRimEmissive`).
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
 * One board and no dials: the DASH (the F-16 pass, step 3). Its face runs from the cove's foot, its top edge, down to
 * the tub, LEANED BACK `leanDegrees` about that edge, so it faces the pilot: its normal at the board's centre (the
 * MFDs' height, between them) is within 8 degrees of the eye's ray there, as the Global's and the 747's are. Its top
 * runs back from the cove's foot inside the hood (5 mm over the hood's underside at its back), and its plan is the
 * hood's less `sideInset` a side (its sides never coplanar with the hood's walls), narrowing with the hood over its
 * depth. Its face is the panel material the Global's and the 747's boards wear (`jet-panel`), not the tub's blue.
 */
export const JET_PANEL = Object.freeze({
  thickness: 0.1,
  sideInset: 0.005,
  /** The tub's top. */
  bottomY: 0.3,
  /** Back from vertical, about the face's top edge at the cove's foot. */
  leanDegrees: 15,
  /** The board's back top edge, this far over the hood's underside. */
  topInHood: 0.005,
});

/** The panel material the Global's and the 747's boards wear (their interior's): dark blue-grey, matte. */
export const JET_PANEL_MATERIAL = Object.freeze({ albedo: 0x1a2328, roughness: 0.82, metallic: 0.02 });

/** The board's face: its top edge at the cove's foot, up the face, and its outward normal (toward the pilot and up). */
export function jetPanelFace(): { x: number; topY: number; top: { x: number; y: number }; up: { x: number; y: number }; normal: { x: number; y: number } } {
  const foot = jetGlareshieldSection().faceTop;
  const lean = (JET_PANEL.leanDegrees * Math.PI) / 180;
  return {
    x: foot.x,
    topY: foot.y,
    top: { x: foot.x, y: foot.y },
    up: { x: Math.sin(lean), y: Math.cos(lean) },
    normal: { x: -Math.cos(lean), y: Math.sin(lean) },
  };
}

/** The board's side elevation: the face's top, its foot on the tub, the back's foot, and the back's top in the hood. */
export function jetPanelSection(): { x: number; y: number }[] {
  const p = JET_PANEL;
  const face = jetPanelFace();
  const fall = Math.tan((JET_GLARESHIELD.hoodFallDegrees * Math.PI) / 180);
  const backX = face.x + p.thickness;
  return [
    { x: face.x, y: face.topY },
    { x: face.x - (face.topY - p.bottomY) * (face.up.x / face.up.y), y: p.bottomY },
    { x: backX, y: p.bottomY },
    { x: backX, y: face.topY - (backX - face.x) * fall + p.topInHood },
  ];
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
   * The top corners' round (step 5b): the rods' centreline turns from each upright into the bar on a quarter circle of
   * this radius, tangent to both, on the same axes (so the 2D HUD's registration holds). At 0.03 the rods' inner edge
   * stood into the symbology's window at its top corners (open to az 5.76 at +3.55, the window pin's 5.8); at 0.025 it
   * is open to 5.92.
   */
  cornerRadius: 0.025,
  /** Rings along each corner's quarter circle, and round each ring (the rods' cylinders' eight). */
  cornerSegments: 6,
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
 *
 * ON THE GLARESHIELD'S MATTE, the coaming's own instance (step 3c): the type's HUD body is black and continuous with the
 * glareshield. On the bezel rims' material (step 2) it read as a lighter hump by day and, at night, took the rims'
 * glow over its whole face: a white slab, luma 217 against the rail's 14.
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
 * green-gold, at alpha 0.08: by the two-layer rule 1 - 0.92^2 = 15.4% darker through both panes. The glass gives some
 * of it back as its own reflection: at 0.05 the rule said 9.75% and the live frame read 5.5%, the design band's floor,
 * so the band (5 to 15%) is held on the pixel read, in the frames.
 * No depth pre-pass and no depth write, as the canopy's: written, the panes' depth would cut the canopy behind them
 * (sorted after them, its bounding centre being nearer the eye), and the combiner would read brighter than its
 * surround, not tinted. The live frame is the measurement (the glass adds its own reflection).
 *
 * ROUGHNESS 0.35, NOT A MIRROR (step 5d). The panes are flat and upright, and the red anticollision beacon's wash light
 * (`aircraft-beacon-wash`, at (-1.6, 0.92, 0), on the centreline behind the pilot at eye height) mirrors in them at az
 * 0, el -0.21: on the flight-path marker. At 0.05 its highlight was a flashing red bloom about 80 px across there,
 * whenever the beacon was lit at night. The wash is one of the clustered container's lights, and the container packs
 * its lights into one buffer and never reads a light's own excluded meshes, so it cannot be kept off the glass by
 * itself; at 0.35 the highlight's lobe spreads and its peak falls by some three orders.
 */
export const JET_HUD_COMBINER = Object.freeze({
  paneX: [3.045, 3.055] as const,
  albedo: 0x9fb86a,
  alpha: 0.08,
  roughness: 0.35,
  /** The panes' bottom edge, this far under the housing's top at the uprights. */
  intoHousing: 0.005,
});

/**
 * The two panes' outlines, aft then forward, each from bottom-port round: bottom-starboard, up the starboard upright's
 * axis, round the corner's centreline (step 5b), across the bar's axis, round the port corner and down. On the rods'
 * axes, so no glass stands outside the rods at the rounded corners.
 */
export function jetHudCombinerPanes(): readonly (readonly Vector3[])[] {
  const f = JET_HUD_FRAME;
  return JET_HUD_COMBINER.paneX.map((x) => {
    const bottom = jetHudHousingTopY(x, f.z) - JET_HUD_COMBINER.intoHousing;
    const corner = (side: -1 | 1) => jetHudFrameCornerAxis(side).map((p) => new Vector3(x, p.y, p.z));
    return [
      new Vector3(x, bottom, -f.z),
      new Vector3(x, bottom, f.z),
      ...corner(1),
      ...corner(-1).reverse(),
    ];
  });
}

/**
 * A top corner's centreline, from the upright's top (where it leaves the upright's axis) round to the bar's end, on a
 * quarter circle of `cornerRadius` tangent to both: `cornerSegments` + 1 points, in the frame's plane.
 */
export function jetHudFrameCornerAxis(side: -1 | 1): Vector3[] {
  const f = JET_HUD_FRAME;
  const R = f.cornerRadius;
  return Array.from({ length: f.cornerSegments + 1 }, (_, i) => {
    const angle = (Math.PI / 2) * (i / f.cornerSegments);
    return new Vector3(f.x, f.barY - R + R * Math.sin(angle), side * (f.z - R + R * Math.cos(angle)));
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

/**
 * A top corner of the HUD frame (step 5b): a tube of the rods' radius round the corner's centreline
 * (`jetHudFrameCornerAxis`), its rings the rods' eight points (so it meets the upright's top and the bar's end ring to
 * ring), smooth-shaded round the tube as the rods' cylinders are, wound so every face is drawn from outside. Open at
 * both ends: the upright's top cap and the bar's end cap close it, and both face away from the eye.
 */
function hudFrameCorner(build: AircraftBuildContext, name: string, side: -1 | 1, material: PBRMaterial, parent: TransformNode): Mesh {
  const f = JET_HUD_FRAME;
  const around = 8;
  const axis = jetHudFrameCornerAxis(side);
  const positions: number[] = [];
  const normals: number[] = [];
  const ring: Vector3[][] = [];
  for (let i = 0; i < axis.length; i += 1) {
    const angle = (Math.PI / 2) * (i / f.cornerSegments);
    // the ring's plane: the frame's normal (x) and the corner's outward radial in the frame's plane
    const outward = new Vector3(0, Math.sin(angle), side * Math.cos(angle));
    ring.push(Array.from({ length: around }, (_, k) => {
      const phi = (2 * Math.PI * k) / around;
      const n = new Vector3(Math.cos(phi), 0, 0).add(outward.scale(Math.sin(phi)));
      const p = axis[i]!.add(n.scale(f.radius));
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
      return n;
    }));
  }
  const indices: number[] = [];
  const at = (i: number, k: number) => i * around + (k % around);
  const point = (v: number) => new Vector3(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
  for (let i = 0; i + 1 < axis.length; i += 1) {
    for (let k = 0; k < around; k += 1) {
      for (const [a, b, c] of [[at(i, k), at(i, k + 1), at(i + 1, k + 1)], [at(i, k), at(i + 1, k + 1), at(i + 1, k)]] as const) {
        // `solidPlate`'s rule: a drawn face's cross product points INTO the solid, against the outward normal
        const cross = Vector3.Cross(point(b).subtract(point(a)), point(c).subtract(point(a)));
        const out = ring[i]![k]!;
        if (Vector3.Dot(cross, out) > 0) indices.push(a, c, b);
        else indices.push(a, b, c);
      }
    }
  }
  const mesh = solidPlate(build, name, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], 1, material, parent);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = new Array<number>((positions.length / 3) * 2).fill(0);
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
  return mesh;
}

// ---- the MFDs --------------------------------------------------------------------------------

/**
 * Two square MFDs on the leaned dash, the type's 4-inch screens, FRAMED AND RECESSED as the Global's and the 747's are
 * (the shared `framedScreenStack` and `framedScreenFacets`, step 3): a frame 24 mm wide round each screen with a 4 mm
 * chamfer at 45 degrees round its outer edge, a 2 mm gap, the screen 3 mm behind the frame's front, all square to the
 * leaned face. Both frames are one mesh (`jet-mfd-frames`) on their own dark grey, `JET_MFD_FRAME_MATERIAL`, which
 * never glows; both chamfered rims are another (`jet-mfd-rims`) on the bezel rims' shared material, which carries the
 * night glow, so at night the frames are outlined, not lit slabs (step 3b; one opaque draw more than one mesh on the
 * rims' material, whose frames read the board's tone by day and glowed whole at night). (They stood proud as 20 mm
 * slabs, tilted back 15 degrees on the upright board, the screen 1 mm proud.)
 *
 * WHERE: the frame's highest point reads `underFootDegrees` under the cove's foot, so the rail's round and its cove
 * show whole over them; a line along z reads one row, so that holds at every corner.
 *
 * WHAT OF THEM IS SEEN: the 16:9 frame's bottom at their azimuth is about -22.7; the test pins the share of each screen
 * in the frame (98% or more).
 */
export const JET_MFD = Object.freeze({
  /** The screen: square. */
  width: 0.102,
  height: 0.102,
  /** The frame round it: 0.15 square overall. */
  bezel: 0.024,
  bezelThickness: 0.007,
  chamfer: 0.004,
  gap: 0.002,
  recess: 0.003,
  screenThickness: 0.0005,
  /** Each MFD's centre line; the 0.19 between the bezels is the UFC's (not built). */
  z: 0.17,
  /** The frames' highest point under the cove's foot, from the eye. */
  underFootDegrees: 0.3,
});

/**
 * The MFD frames' own material (steps 3b and 3c): a neutral grey with the dash's finish and NO emissive, lighter than
 * the dash (`JET_PANEL_MATERIAL`) by albedo alone. The design's number is the LIVE read, 1.40 to 1.50 times the dash's
 * luma by day. The albedo measure (linear luminance ratio carried back to sRGB) is not that read: the leaned dash and
 * the frames share one normal and one finish, so the sky's specular adds the same to both and compresses the live ratio
 * under the albedo's. At 3b's 0x2c3034 (1.41 by albedo) the frame read 1.24 live; a fit of those two patches (each
 * face's light a gain on its albedo plus a shared constant, the constant the larger) puts a live 1.40 to 1.50 at 1.67
 * to 1.82 by albedo, and this grey, 1.76, at about 1.45. The glow is the rims' alone.
 */
export const JET_MFD_FRAME_MATERIAL = Object.freeze({ albedo: 0x373c41, roughness: 0.82, metallic: 0.02 });

/**
 * Each MFD's screen-plate centre and its face centre (on the board's face, where its frame is laid out from), port then
 * starboard: the build order, and the slot order. How far down the face is solved so the frame's highest vertex reads
 * `underFootDegrees` under the cove's foot.
 */
export function jetMfdPlacements(): readonly { name: "port" | "starboard"; centre: Vector3; faceCentre: Vector3 }[] {
  const m = JET_MFD;
  const e = eye();
  const face = jetPanelFace();
  const stack = framedScreenStack(m);
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  const top = new Vector3(face.top.x, face.top.y, 0);
  const row = (v: Vector3) => (v.y - e.up) / (v.x - e.forward);
  const limit = Math.tan(Math.atan(row(top)) - (m.underFootDegrees * Math.PI) / 180);
  const centreAt = (drop: number) => top.subtract(up.scale(drop + m.height / 2 + m.bezel));
  const highest = (drop: number) => Math.max(...framedScreenFacets(centreAt(drop), face, m).rim.flatMap((q) => q.corners.map(row)));
  // the frame's highest row falls as it goes down the face: bisect for the drop that puts it on the limit
  let lo = 0;
  let hi = 0.2;
  for (let k = 0; k < 60; k += 1) {
    const mid = (lo + hi) / 2;
    if (highest(mid) > limit) lo = mid;
    else hi = mid;
  }
  const faceCentre = centreAt(hi);
  const centre = faceCentre.add(out.scale((stack.screenFront + stack.screenBack) / 2));
  return (["port", "starboard"] as const).map((name) => {
    const z = name === "port" ? -m.z : m.z;
    return { name, centre: new Vector3(centre.x, centre.y, z), faceCentre: new Vector3(faceCentre.x, faceCentre.y, z) };
  });
}

/** What the pages need of this airframe that the flight state does not carry: one engine, 20 degrees of flap (`animation.ts`). */
export const JET_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 1, fullFlapDegrees: 20 });

// ---- the sills ------------------------------------------------------------------------------

/**
 * THE SILLS (the F-16 pass, step 4): a level canopy sill each side, with a console inboard of it. The frame's lower
 * third held no aircraft from az 27.7 to the frame's edge, 252 of 800 columns: the deck is the width of the canopy's
 * nose, and beside it the frame looked straight out through the glass. The sill is what the type has there, level
 * with the glareshield's sides dropping to it.
 *
 * THE RAIL: its top level at `topY` (eye - 0.22), `width` wide, its top edges rounded at `radius`, its outer edge
 * `glassMargin` inside the glass's inner half-width at the top's height, so it curves in with the glass as it runs
 * forward: from `aftX`, behind the eye, to a bend at `bendX` where the canopy's widest run ends, and on BESIDE the dash
 * to the board's back, its inner face on the board's side from the side's bend (x 2.93) on, so nothing of it is in the
 * dash. Ended at the dash's face plane it left a notch: rays over its end dropped under its top and out through the
 * glass, a wedge of world 1.6 by 0.8 degrees. The frame's edge column at 16:9 (az 37.5) meets the rail's outer edge
 * 16 mm under its top; at 21:9 (the hybrid lens, az 45.65) a level top this high reaches az 38.9, and the corners
 * beyond it need up to 0.762.
 *
 * THE CONSOLE: its top at `consoleTopY`, `consoleWidth` inboard of the rail's inner face, from `aftX` to the dash's
 * leaned face, down to the tub. It closes the rail's inner face from below and runs `consoleUnderRail` in under the
 * rail, whose bottom is 1 cm under the console's top, so their seam cannot open. It is under the frame's bottom at
 * 16:9 and at 21:9: nothing stands on it (no more instruments).
 *
 * Both sides' rails and consoles are ONE cockpit-only mesh (`jet-sills`) on the dash's material: one draw.
 */
export const JET_SILL = Object.freeze({
  topY: 0.72,
  width: 0.06,
  radius: 0.01,
  /** The rail's bottom: 1 cm under the console's top. */
  bottomY: 0.59,
  glassMargin: 0.021,
  aftX: 1.9,
  bendX: 2.6,
  /**
   * The glass's inner half-width at `topY`, by crossings on the built canopy: at `aftX`, at `bendX` (the widest, from
   * x 2.3 to 2.6), at the board's side's bend (x 2.93) and at the board's back (x 3.03). The test re-measures the
   * margin at every vertex.
   */
  glassHalfWidth: Object.freeze({ aft: 0.4371, bend: 0.4559, dash: 0.4216, back: 0.4088 }),
  consoleTopY: 0.6,
  consoleWidth: 0.15,
  consoleUnderRail: 0.03,
});

/** The dash's leaned face plane: its x at height y. */
export function jetPanelFaceX(y: number): number {
  const face = jetPanelFace();
  return face.top.x - ((face.top.y - y) * face.up.x) / face.up.y;
}

/** The rail's section in (u, y), u measured inboard from its outer edge: up the outer face, over the rounded top, down the inner face. */
export function jetSillSection(): SweptSection {
  const r = JET_SILL;
  const shoulder = r.topY - r.radius;
  const c = Math.SQRT1_2 * r.radius;
  return {
    points: [
      { u: 0, y: r.bottomY },
      { u: 0, y: shoulder },
      { u: r.radius - c, y: shoulder + c },
      { u: r.radius, y: r.topY },
      { u: r.width - r.radius, y: r.topY },
      { u: r.width - r.radius + c, y: shoulder + c },
      { u: r.width, y: shoulder },
      { u: r.width, y: r.bottomY },
    ],
    rounds: [
      { first: 1, last: 3, centre: { u: r.radius, y: shoulder } },
      { first: 4, last: 6, centre: { u: r.width - r.radius, y: shoulder } },
    ],
  };
}

/**
 * The rail's four stations, aft to forward: x, and its outer and inner edges' half-widths. Aft of the dash it is
 * `width` wide; beside it, its inner edge is the board's side (the hood's plan less the board's inset).
 */
export function jetSillStations(): { x: number; outer: number; inner: number }[] {
  const r = JET_SILL;
  const g = r.glassHalfWidth;
  const dashX = jetPanelFace().x;
  const backX = dashX + JET_PANEL.thickness;
  const side = (x: number) => jetCoamingHalfWidth(x) - JET_PANEL.sideInset;
  return [
    { x: r.aftX, outer: g.aft - r.glassMargin, inner: g.aft - r.glassMargin - r.width },
    { x: r.bendX, outer: g.bend - r.glassMargin, inner: g.bend - r.glassMargin - r.width },
    { x: dashX, outer: g.dash - r.glassMargin, inner: side(dashX) },
    { x: backX, outer: g.back - r.glassMargin, inner: side(backX) },
  ];
}

/** The rail's inner edge's half-width at x (linear between the stations). */
export function jetSillInnerAt(x: number): number {
  const stations = jetSillStations();
  const k = Math.max(0, Math.min(stations.length - 2, stations.findIndex((station) => station.x > x) - 1));
  const [a, b] = [stations[k]!, stations[k + 1]!];
  return a.inner + ((x - a.x) / (b.x - a.x)) * (b.inner - a.inner);
}

// ---- the rail's ends ------------------------------------------------------------------------

/**
 * THE RAIL'S ENDS (the F-16 pass, step 5; Jason: "make the front rim / black rectangle more rounded"). The rail ended
 * square at az +-26.45, a black bar with cut ends over the sills. Each end now sweeps aft and down into its sill: from
 * the rail's silhouette at az 25 (so the deck row stays one row from -25 to +25) the sill rises along x in an S of two
 * arcs of `sRadius`, level at both ends, to the silhouette's height, on the glareshield's matte and merged into the
 * coaming, so the black of the rail runs on down into the sill.
 *
 * WHY ALONG X: the glass is 2 cm outboard of the rail's end. From az 25 to the glass less 2 cm there are 2.8 cm of run
 * across z for a 9 cm drop, so a round across z (or a round in plan of 0.10) does not fit; along the canopy it does,
 * widening with the glass as it falls (2.3 cm wide at the top, the sill's 5.4 at its foot). Its section is the sill's
 * (rounded top edges), its outer edge `glassMargin` inside the glass at its own top's height at every station.
 */
export const JET_RAIL_END = Object.freeze({
  startAzimuthDegrees: 25,
  sRadius: 0.15,
  /** Stations along the S, foot to top: 8 walls. */
  stations: 9,
  /** The glass's inner half-width at each station's top, foot to top, by crossings on the built canopy. */
  glassHalfWidth: Object.freeze([0.4436, 0.4407, 0.4362, 0.427, 0.4143, 0.4016, 0.3924, 0.3857, 0.3813]),
});

/**
 * The rail end's stations, foot to top: x, the S's top there, and the outer and inner edges' half-widths. The foot is
 * the sill's own section; the top is at the rail's silhouette (the round's tangent on the deck line), from az 25 out.
 */
export function jetRailEndStations(): { x: number; top: number; outer: number; inner: number }[] {
  const e = JET_RAIL_END;
  const t = jetGlareshieldSection().tangent;
  const low = JET_SILL.topY;
  const half = (t.y - low) / 2;
  const arc = Math.sqrt(2 * e.sRadius * half - half * half);
  const foot = t.x - 2 * arc;
  const top = (x: number) => (x >= foot + arc ? t.y - (e.sRadius - Math.sqrt(e.sRadius ** 2 - (t.x - x) ** 2)) : low + (e.sRadius - Math.sqrt(e.sRadius ** 2 - (x - foot) ** 2)));
  const startZ = (t.x - eye().forward) * Math.tan((e.startAzimuthDegrees * Math.PI) / 180);
  const footInner = jetSillInnerAt(foot);
  return Array.from({ length: e.stations }, (_, i) => {
    const f = i / (e.stations - 1);
    const x = foot + (t.x - foot) * f;
    // the foot is the sill's own section, so the S leaves it level and flush
    if (i === 0) return { x, top: low, outer: sillOuterAt(foot), inner: footInner };
    return { x, top: i === e.stations - 1 ? t.y : top(x), outer: e.glassHalfWidth[i]! - JET_SILL.glassMargin, inner: footInner + (startZ - footInner) * f };
  });
}

/** The rail end's S: its slope (dy/dx) at x, 0 at its foot and at its top. */
export function jetRailEndSlope(x: number): number {
  const e = JET_RAIL_END;
  const t = jetGlareshieldSection().tangent;
  const half = (t.y - JET_SILL.topY) / 2;
  const arc = Math.sqrt(2 * e.sRadius * half - half * half);
  const foot = t.x - 2 * arc;
  const d = x >= foot + arc ? t.x - x : x - foot;
  return Math.max(0, d) / Math.sqrt(e.sRadius ** 2 - Math.max(0, d) ** 2);
}

/** The sill rail's outer edge's half-width at x (linear between its stations). */
function sillOuterAt(x: number): number {
  const stations = jetSillStations();
  const k = Math.max(0, Math.min(stations.length - 2, stations.findIndex((station) => station.x > x) - 1));
  const [a, b] = [stations[k]!, stations[k + 1]!];
  return a.outer + ((x - a.x) / (b.x - a.x)) * (b.outer - a.outer);
}

// ---- the builder ----------------------------------------------------------------------------

/** What `buildJetCockpit` hands back. */
export interface JetCockpit {
  /** `jet-glare-shield`: the coaming, an ordinary airframe part (visible from outside). */
  readonly coaming: Mesh;
  /** `jet-instrument-panel`: the board, an ordinary airframe part. */
  readonly board: Mesh;
  /**
   * The cockpit-only meshes, unconfigured: the caller marks them (`configureCockpitOnlyParts`). The HUD
   * frame, its housing, its combiner's panes, the MFDs' frames, their rims, the MFD screens and the sills.
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
  const rail = solidPlate(build, "jet-glare-shield-rail", jetGlareshieldSection().outline, g.nearHalfWidth * 2, glare, root);
  sculptSolid(rail, (point) => new Vector3(point.x, point.y, (point.z * jetCoamingHalfWidth(point.x)) / g.nearHalfWidth));
  // the round shades as a curve (step 3): flat, its eight chords read as bands about 20 px tall
  const section = jetGlareshieldSection();
  smoothRoundNormals(rail, section.round, section.centre);
  // THE RAIL'S ENDS (step 5), each sweeping aft and down into its sill, merged with it on the glareshield's matte
  const ends = jetRailEndStations();
  const coamingParts: AbstractMesh[] = [rail];
  for (const side of [-1, 1] as const) {
    const inset = (station: { outer: number; inner: number }, u: number) => (u <= JET_SILL.width / 2 ? u : u - (JET_SILL.width - (station.outer - station.inner)));
    coamingParts.push(sweptSolid(
      build,
      `jet-glare-shield-end-${side < 0 ? "port" : "starboard"}`,
      jetSillSection(),
      ends.length,
      (i, point) => new Vector3(
        ends[i]!.x,
        point.y <= JET_SILL.bottomY ? point.y : point.y + (ends[i]!.top - JET_SILL.topY),
        side * (ends[i]!.outer - inset(ends[i]!, point.u)),
      ),
      (direction) => new Vector3(0, direction.y, -side * direction.u),
      glare,
      root,
      { smoothAlong: true, tangent: (i) => new Vector3(1, jetRailEndSlope(ends[i]!.x), 0) },
    ));
  }
  for (const part of coamingParts) part.metadata = { ...part.metadata, cockpitInterior: true, castsShadow: false };
  const coaming = build.mergeStatic("jet-glare-shield", coamingParts, root);

  // THE BOARD, the leaned dash: a plate of its side elevation at the face's width, narrowed with the hood over its
  // depth, on the panel material the Global's and the 747's boards wear
  const p = JET_PANEL;
  const face = jetPanelFace();
  const faceHalfWidth = g.nearHalfWidth - p.sideInset;
  const pm = JET_PANEL_MATERIAL;
  const panelMaterial = build.material("jet-panel", pm.albedo, { roughness: pm.roughness, metallic: pm.metallic });
  const board = solidPlate(build, "jet-instrument-panel", jetPanelSection(), faceHalfWidth * 2, panelMaterial, root);
  sculptSolid(board, (point) => new Vector3(point.x, point.y, (point.z * (jetCoamingHalfWidth(point.x) - p.sideInset)) / faceHalfWidth));
  board.metadata = { ...board.metadata, cockpitInterior: true };

  const f = JET_HUD_FRAME;
  const footY = jetHudFrameFootY();
  // the uprights and the bar stop where the corners' rounds take over (step 5b)
  const topY = f.barY - f.cornerRadius;
  const barEnd = f.z - f.cornerRadius;
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
  const bar = rod("jet-hud-frame-bar", new Vector3(f.x, f.barY, -barEnd), new Vector3(f.x, f.barY, barEnd));
  const corners = ([-1, 1] as const).map((side) => hudFrameCorner(build, side < 0 ? "jet-hud-frame-corner-port" : "jet-hud-frame-corner-starboard", side, glare, root));
  const frame = build.mergeStatic("jet-hud-frame", [...uprights, bar, ...corners], root);

  // THE HOUSING, on the glareshield's matte (the coaming's instance, as the frame is), its own opaque mesh
  const housing = facetMesh(build, "jet-hud-housing", jetHudHousingFacets(), glare, root);

  // THE COMBINER: both panes one mesh on a new instance of the canopy glass's kind, single-sided toward the eye (the
  // material is two-sided, as every alpha-blended airframe material is; the winding is what the drawn-faces walk reads)
  const c = JET_HUD_COMBINER;
  const combinerGlass = build.material("jet-hud-glass", c.albedo, { roughness: c.roughness, metallic: 0, alpha: c.alpha });
  combinerGlass.needDepthPrePass = false;
  combinerGlass.disableDepthWrite = true;
  const toward = new Vector3(-1, 0, 0);
  // each pane fanned from its middle (its outline is convex): a triangle a facet, the fourth corner repeated
  const combiner = facetMesh(
    build,
    "jet-hud-combiner",
    jetHudCombinerPanes().flatMap((outline) => {
      const middle = outline.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / outline.length);
      return outline.map((p, k) => ({ corners: [middle, p, outline[(k + 1) % outline.length]!, outline[(k + 1) % outline.length]!] as const, normal: toward }));
    }),
    combinerGlass,
    root,
  );

  // THE MFDs, framed and recessed on the leaned dash: each screen a thin plate turned back with the face, its PILOT-FACING
  // face (local normal -X, which the turn does not change in the vertex data) pointed at its own slot of the atlas
  // before the merge bakes the transforms; each frame on the frames' own grey, its chamfered rim on the bezel rims'
  // shared material, both MFDs' frames in one mesh and their rims in another
  const m = JET_MFD;
  const lean = (p.leanDegrees * Math.PI) / 180;
  const fm = JET_MFD_FRAME_MATERIAL;
  const frameMaterial = build.material("jet-mfd-frame", fm.albedo, { roughness: fm.roughness, metallic: fm.metallic });
  const screens: AbstractMesh[] = [];
  const frames: AbstractMesh[] = [];
  const rims: AbstractMesh[] = [];
  const slots = displaySlots(JET_DISPLAYS);
  const atlasWidth = displayAtlasWidth(JET_DISPLAYS);
  const atlasHeight = displayAtlasHeight(JET_DISPLAYS);
  for (const [index, { name, centre, faceCentre }] of jetMfdPlacements().entries()) {
    const facets = framedScreenFacets(faceCentre, face, m);
    frames.push(facetMesh(build, `jet-mfd-frame-${name}`, facets.frame, frameMaterial, root));
    rims.push(facetMesh(build, `jet-mfd-rim-${name}`, facets.rim, materials.rim, root));
    const screen = build.box(`jet-mfd-screen-${name}`, m.screenThickness, m.height, m.width, materials.instrumentFace, root);
    screen.position.copyFrom(centre);
    screen.rotation.z = -lean;
    remapScreenFaceToSlot(screen, slots[index]!, atlasWidth, atlasHeight);
    screens.push(screen);
  }
  const screensMesh = build.mergeStatic(JET_DISPLAYS.screensMesh, screens, root);
  const framesMesh = build.mergeStatic("jet-mfd-frames", frames, root);
  const rimsMesh = build.mergeStatic("jet-mfd-rims", rims, root);

  // THE SILLS, each side a rail swept along the glass and a console inboard of it, all four one mesh on the dash's
  // material
  const sill = JET_SILL;
  const stations = jetSillStations();
  // beside the dash the rail narrows: its inner round and face move out with the inner edge, both rounds kept
  const inset = (station: { outer: number; inner: number }, u: number) => (u <= sill.width / 2 ? u : u - (sill.width - (station.outer - station.inner)));
  const sills: AbstractMesh[] = [];
  for (const side of [-1, 1] as const) {
    const label = side < 0 ? "port" : "starboard";
    sills.push(sweptSolid(
      build,
      `jet-sill-rail-${label}`,
      jetSillSection(),
      stations.length,
      (i, point) => new Vector3(stations[i]!.x, point.y, side * (stations[i]!.outer - inset(stations[i]!, point.u))),
      (direction) => new Vector3(0, direction.y, -side * direction.u),
      panelMaterial,
      root,
    ));
    // the console: its side elevation from behind the eye to the dash's face, down to the tub, then its plan: from
    // `consoleWidth` inboard of the rail's inner face to `consoleUnderRail` under the rail
    const consoleSection = [
      { x: sill.aftX, y: JET_PANEL.bottomY },
      { x: jetPanelFaceX(JET_PANEL.bottomY), y: JET_PANEL.bottomY },
      { x: jetPanelFaceX(sill.consoleTopY), y: sill.consoleTopY },
      { x: sill.aftX, y: sill.consoleTopY },
    ];
    const across = sill.consoleWidth + sill.consoleUnderRail;
    const console = solidPlate(build, `jet-sill-console-${label}`, consoleSection, 1, panelMaterial, root);
    sculptSolid(console, (point) => {
      const inner = jetSillInnerAt(point.x) - sill.consoleWidth;
      // port runs the other way across, so the move is not a reflection
      const fraction = side > 0 ? point.z + 0.5 : 0.5 - point.z;
      return new Vector3(point.x, point.y, side * (inner + fraction * across));
    });
    sills.push(console);
  }
  const sillsMesh = build.mergeStatic("jet-sills", sills, root);

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
    parts: [frame, housing, combiner, framesMesh, rimsMesh, screensMesh, sillsMesh],
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
