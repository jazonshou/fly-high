import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
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
  solidPlate,
  sweptSolid,
  type FacetQuad,
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
 * the round the board's face (the dash) takes over at the round's aft tangent through a 2 cm cove (`JET_COVE`); forward
 * of it the hood falls away faster than the sight line, so no part of its top is seen from the seat.
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
  /** The aft face, where the round's aft tangent meets the dash's top (the cove): 0.70 ahead of the eye. */
  aftX: 2.92,
  radius: 0.02,
  drop: 0,
  /**
   * No chamfer under the round (Jason's F-16 wave: "walls and bars organic, not choppy"): the dash's top is the round's
   * aft tangent, and the 15 degree inside corner between them is the cove (`JET_COVE`). The 45 degree chamfer this
   * was (1 cm forward and down) faced down and aft and read luma 15 under the rail, a 15 px black band straight
   * across the frame between a 51 degree crease (the round into it) and an 85 degree one (the dash's top edge).
   */
  cove: 0,
  /** Where the plan starts narrowing: the old cove's foot, so the plan (and the rail's ends) are unchanged. */
  narrowFromX: 2.93,
  /** Steeper than the 10.19 degree sight line, so the hood's top never shows over the round. */
  hoodFallDegrees: 13,
  /** To x 3.50, the wedge's far edge: from outside it is still the dark hood over the panel. */
  hoodDepth: 0.58,
  roundSegments: 8,
  /** The plan's half-width: the rail's, to the cove's foot, then narrowing to the hood's forward end. */
  nearHalfWidth: 0.36,
  farHalfWidth: 0.26,
});

/**
 * The rail's section in body x and y: the round on the deck line, down to its aft tangent, then the hood's underside
 * (`roundedDeckSection` with no drop and no chamfer, so its cove's foot IS the round's aft tangent; the shared builder
 * lists that point twice, and the prism takes it once).
 */
export function jetGlareshieldSection(): RoundedDeckSection {
  const section = roundedDeckSection(eye(), JET_GLARESHIELD.aftX, aircraftSpec("jet").cockpitDeckLineDegrees, JET_GLARESHIELD, "the F-16");
  const first = section.outline[0]!;
  const last = section.outline[section.outline.length - 1]!;
  const twice = Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
  return twice ? { ...section, outline: section.outline.slice(0, -1) } : section;
}

/**
 * THE RAIL'S OUTBOARD ENDS ROUNDED (Jason's F-16 wave, S3: the fillet at the rail's join with its ends). The rail was a
 * prism of its section across the cockpit, square at its sides: where each end's S leaves it, the end's top edge is
 * rounded at 1 cm (`JET_SILL.radius`) and the rail's square corner stood over that round, a knob 0.5 by 0.4 degrees
 * at az +-26.5 on the deck row. Now the rail's section runs unchanged to `nearHalfWidth` less that radius and rolls over
 * `endDegrees` of a round of it to the side: at each of `endSegments` stations out, the section inset by the round's
 * fall there, and capped. So the rail's end is the end's own round and lies inside the end where they meet (2.6 mm
 * inboard of it; 7.4 mm down at the cap, the end's round 4.7 there); forward of the S's top it is under the sight line,
 * unseen from the seat, and from outside the hood's corners are round. Not the last 15 degrees: there the walls lie
 * nearly flat to the cap, and where the plan narrows (from x 2.93) the sweep cannot tell their outside (`sweptSolid`
 * sides a wall by its edge in the section, and two of them turned inside out).
 *
 * Each station's z, unscaled (the plan's narrowing scales it after, `jetCoamingHalfWidth` over `nearHalfWidth`), and
 * how far the section is inset there, port end to starboard end.
 */
export const JET_RAIL_SIDES = Object.freeze({ radius: 0.01, endSegments: 5, endDegrees: 75 });

export function jetRailStations(): { z: number; inset: number; angle: number }[] {
  const { radius, endSegments, endDegrees } = JET_RAIL_SIDES;
  const half = JET_GLARESHIELD.nearHalfWidth;
  const side = Array.from({ length: endSegments + 1 }, (_, k) => {
    const angle = (k / endSegments) * ((endDegrees * Math.PI) / 180);
    return { z: half - radius + radius * Math.sin(angle), inset: radius * (1 - Math.cos(angle)), angle };
  });
  return [...side.slice().reverse().map(({ z, inset, angle }) => ({ z: -z, inset, angle })), ...side];
}

/**
 * The rail's outline (`jetGlareshieldSection`) inset by `inset`: the round's points in toward its centre (its radius less
 * the inset, so it stays a round for any inset short of its 2 cm), the hood's two forward corners where their edges'
 * lines, each moved in square to itself, meet. (Every point by its edges' lines turned the round's last chord, 4.5 mm
 * long at the aft corner, inside out past an inset of about 7 mm.)
 */
export function jetRailOutlineInset(inset: number): { x: number; y: number }[] {
  const section = jetGlareshieldSection();
  const outline = section.outline;
  const n = outline.length;
  const onRound = (p: { x: number; y: number }) => section.round.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-12);
  const middle = outline.reduce((sum, p) => ({ x: sum.x + p.x / n, y: sum.y + p.y / n }), { x: 0, y: 0 });
  const inward = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let m = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
    if (m.x * (middle.x - a.x) + m.y * (middle.y - a.y) < 0) m = { x: -m.x, y: -m.y };
    return m;
  };
  return outline.map((p, j) => {
    if (onRound(p)) {
      const [dx, dy] = [p.x - section.centre.x, p.y - section.centre.y];
      const scale = (Math.hypot(dx, dy) - inset) / Math.hypot(dx, dy);
      return { x: section.centre.x + dx * scale, y: section.centre.y + dy * scale };
    }
    const a = inward(outline[(j - 1 + n) % n]!, p);
    const b = inward(p, outline[(j + 1) % n]!);
    const k = inset / (1 + a.x * b.x + a.y * b.y);
    return { x: p.x + (a.x + b.x) * k, y: p.y + (a.y + b.y) * k };
  });
}

/**
 * Shades a rounded end of the rail (built by `buildJetCockpit` over `jetRailStations` from `from`) as its section rolled
 * over the end's round: at each wall vertex, cos(angle) of the section's outward normal there (the round's radial on the
 * round's chords, the edge's own on the hood's flat faces, so the hard corner at the aft tangent stays one) and
 * sin(angle) out to the side. The caps keep their flat normals; nothing moves.
 */
function rollRailSideNormals(mesh: Mesh, from: number, side: -1 | 1): void {
  const section = jetGlareshieldSection();
  const outline = section.outline;
  const n = outline.length;
  const stations = jetRailStations();
  const insets = stations.map(({ inset }) => jetRailOutlineInset(inset));
  const onRound = (j: number) => section.round.some((q) => Math.hypot(q.x - outline[j]!.x, q.y - outline[j]!.y) < 1e-9);
  const middle = outline.reduce((sum, p) => ({ x: sum.x + p.x / n, y: sum.y + p.y / n }), { x: 0, y: 0 });
  // where each (station, point) was placed, as the sweep placed it
  const place = new Map<string, { station: number; point: number }>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = from; i < from + JET_RAIL_SIDES.endSegments + 1; i += 1) {
    outline.forEach((q, j) => {
      const at = insets[i]![j]!;
      const z = (stations[i]!.z * jetCoamingHalfWidth(q.x)) / JET_GLARESHIELD.nearHalfWidth;
      place.set(key(at.x, at.y, z), { station: i, point: j });
    });
  }
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = [...mesh.getVerticesData(VertexBuffer.NormalKind)!];
  const at = (v: number) => place.get(key(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!));
  for (let t = 0; t < positions.length / 3; t += 3) {
    const corners = [at(t), at(t + 1), at(t + 2)];
    if (corners.some((c) => c === undefined) || new Set(corners.map((c) => c!.station)).size < 2) continue; // a cap
    const pts = [...new Set(corners.map((c) => c!.point))];
    if (pts.length !== 2) continue;
    const [a, b] = [outline[pts[0]!]!, outline[pts[1]!]!];
    let edge = { x: -(b.y - a.y), y: b.x - a.x };
    if (edge.x * (middle.x - a.x) + edge.y * (middle.y - a.y) > 0) edge = { x: -edge.x, y: -edge.y };
    const chord = onRound(pts[0]!) && onRound(pts[1]!);
    corners.forEach((c, k) => {
      const p = outline[c!.point]!;
      const m = chord ? new Vector3(p.x - section.centre.x, p.y - section.centre.y, 0).normalize() : new Vector3(edge.x, edge.y, 0).normalize();
      const angle = stations[c!.station]!.angle;
      const rolled = m.scale(Math.cos(angle)).add(new Vector3(0, 0, side * Math.sin(angle))).normalize();
      normals[(t + k) * 3] = rolled.x;
      normals[(t + k) * 3 + 1] = rolled.y;
      normals[(t + k) * 3 + 2] = rolled.z;
    });
  }
  const data = new VertexData();
  data.positions = [...positions];
  data.normals = normals;
  data.uvs = [...mesh.getVerticesData(VertexBuffer.UVKind)!];
  data.indices = [...mesh.getIndices()!];
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
}

/**
 * THE COVE (Jason's F-16 wave): the inside corner where the rail's round, its aft tangent vertical, meets the dash's
 * face, leaned back `JET_PANEL.leanDegrees` from vertical and facing the pilot. It is a concave turn of that lean, drawn
 * on a `radius` (2 cm): 15 degrees of it is 5.2 mm, the top strip of the dash's face, which carries the arc's normals from
 * the round's (aft, level) at its top to the face's at its foot, so the round runs into the dash with one normal at
 * the tangent and no crease in the shading. It is drawn as its chord: a 2 cm arc over 15 degrees stands 0.17 mm off it,
 * and the dash's plate stays convex (`solidPlate` winds convex outlines only). No face in it faces down, so nothing
 * under the rail falls into shadow: the band it replaces read luma 15 by day.
 */
export const JET_COVE = Object.freeze({ radius: 0.02 });

/** The cove's length down the dash's face: its radius times the turn (the dash's lean), 5.2 mm. */
export function jetCoveLength(): number {
  return JET_COVE.radius * ((JET_PANEL.leanDegrees * Math.PI) / 180);
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
  const from = g.narrowFromX;
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
  const coveFoot = jetCoveFoot();
  return [
    { x: face.x, y: face.topY },
    // on the face's plane: the cove's strip above it, the flat face below
    { x: coveFoot.x, y: coveFoot.y },
    { x: face.x - (face.topY - p.bottomY) * (face.up.x / face.up.y), y: p.bottomY },
    { x: backX, y: p.bottomY },
    { x: backX, y: face.topY - (backX - face.x) * fall + p.topInHood },
  ];
}

export function jetPanelTopY(): number {
  return jetPanelFace().topY;
}

/** The cove's foot: `jetCoveLength` down the dash's leaned face from its top (the round's aft tangent). */
export function jetCoveFoot(): { x: number; y: number } {
  const face = jetPanelFace();
  const length = jetCoveLength();
  return { x: face.top.x - length * face.up.x, y: face.top.y - length * face.up.y };
}

/**
 * Shades the cove (`JET_COVE`) on the built board: every triangle of the face's top strip, from the face's top to the
 * cove's foot, takes at each corner the arc's normal there: the round's aft normal (level, aft) at the top, the face's
 * at the foot. Nothing moves. Returns how many triangles it shaded.
 */
export function shadeJetCove(board: Mesh): number {
  const positions = board.getVerticesData(VertexBuffer.PositionKind);
  const normals = board.getVerticesData(VertexBuffer.NormalKind);
  const uvs = board.getVerticesData(VertexBuffer.UVKind);
  const indices = board.getIndices();
  if (!positions || !normals || !uvs || !indices) throw new Error("shadeJetCove: expected positions, normals, uvs and indices");
  const face = jetPanelFace();
  const foot = jetCoveFoot();
  const top = new Vector3(-1, 0, 0);
  const faceNormal = new Vector3(face.normal.x, face.normal.y, 0);
  // on the face's plane, between its top and the cove's foot
  const inStrip = (i: number) => {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const off = (x - face.top.x) * face.normal.x + (y - face.top.y) * face.normal.y;
    return Math.abs(off) < 1e-7 && y >= foot.y - 1e-7 && y <= face.top.y + 1e-7;
  };
  const out = [...normals];
  let shaded = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    if (!corners.every(inStrip)) continue;
    for (const i of corners) {
      const along = (face.top.y - positions[i * 3 + 1]!) / (face.top.y - foot.y);
      const n = Vector3.Lerp(top, faceNormal, Math.max(0, Math.min(1, along))).normalize();
      out[i * 3] = n.x;
      out[i * 3 + 1] = n.y;
      out[i * 3 + 2] = n.z;
    }
    shaded += 1;
  }
  const data = new VertexData();
  data.positions = [...positions];
  data.normals = out;
  data.uvs = [...uvs];
  data.indices = [...indices];
  data.applyToMesh(board, false);
  board.refreshBoundingInfo();
  return shaded;
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
 * WHERE: the frame's highest point reads `underFootDegrees` under the cove's foot (`jetCoveFoot`, the end of the
 * dash's cove strip under the round's aft tangent), so the rail's round and its cove show whole over them; a line
 * along z reads one row, so that holds at every corner.
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
  /** Each MFD's centre line; the 0.19 between the bezels is the ICP's (`JET_ICP`, S1). */
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
  // under the COVE's foot, not the dash's top: the cove's strip (`JET_COVE`) shows whole over the frames
  const coveFoot = jetCoveFoot();
  const top = new Vector3(coveFoot.x, coveFoot.y, 0);
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

// ---- the ICP ---------------------------------------------------------------------------------

/**
 * THE ICP (Jason's F-16 wave, S1: "make sure the details are there"): the integrated control panel between the MFDs,
 * under the HUD, where the frame showed the bare dash (87k px at 1080p, luma 74, std 5.8). A framed recessed panel of
 * the MFDs' own size and top line (the shared `framedScreenFacets`: its frame on the frames' grey, its chamfered rim on
 * the rims' material, merged with theirs), its floor `recess` behind the frame's front, on the dash's own material and
 * merged into the board (the keys stand lighter than it, as the type's do on its dark face; on the frames' grey the
 * recess read only at its edges). On the floor: the DED, a strip on the rims' material (their law: 0.05 by day, their
 * glow at night) in a raised lip; the 3 x 4 key block, each key `proud` of the floor with its top edges rounded at
 * `radius`; and a rocker each side of the block (the DCS and the up/down), each two halves either side of a seam. The
 * frame, the lip, the keys and the rockers are one mesh on the frames' grey (`jet-icp`), the DED another (`jet-icp-ded`):
 * two draws, no new material.
 *
 * Face coordinates: u across the cockpit (starboard +), v up the leaned face, o out of it toward the pilot; the panel's
 * centre on the face at z 0, the MFDs' face centre's height, so its top reads their 0.3 degree under the cove's foot.
 */
export const JET_ICP = Object.freeze({
  /** The floor's opening; with the frame round it, 0.17 by 0.15 overall (the MFDs' 0.15 square), 1 cm clear of theirs. */
  width: 0.13,
  height: 0.11,
  bezel: 0.02,
  bezelThickness: 0.007,
  chamfer: 0.004,
  gap: 0.002,
  recess: 0.003,
  screenThickness: 0.002,
  key: Object.freeze({ width: 0.014, height: 0.012, pitchU: 0.019, pitchV: 0.017, columns: 3, rows: 4, centreV: -0.014, proud: 0.004, radius: 0.001 }),
  /** Each rocker's two halves, either side of a seam, at u +-`u`. */
  rocker: Object.freeze({ width: 0.01, half: 0.0115, seam: 0.002, u: 0.047, centreV: -0.014, proud: 0.005, radius: 0.001 }),
  /** The DED: its strip, and the lip round it. */
  ded: Object.freeze({ width: 0.09, height: 0.02, v: 0.034, proud: 0.001, lip: 0.002, lipProud: 0.002 }),
  /** Rounds in this many chords (the keys', the rockers'). */
  roundSegments: 3,
});

/** The ICP's centre on the dash's face: the MFDs' face centre's height, at z 0. */
export function jetIcpFaceCentre(): Vector3 {
  const port = jetMfdPlacements()[0]!;
  return new Vector3(port.faceCentre.x, port.faceCentre.y, 0);
}

/** The key block's twelve keys' centres on the floor, (u, v), row by row from the top, each row port to starboard. */
export function jetIcpKeyCentres(): { u: number; v: number }[] {
  const k = JET_ICP.key;
  const keys: { u: number; v: number }[] = [];
  for (let row = 0; row < k.rows; row += 1) {
    for (let column = 0; column < k.columns; column += 1) {
      keys.push({ u: (column - (k.columns - 1) / 2) * k.pitchU, v: k.centreV + ((k.rows - 1) / 2 - row) * k.pitchV });
    }
  }
  return keys;
}

/** A quad with a shading normal at each corner (a round's), or one for all four. */
interface ShadedQuad {
  readonly corners: readonly [Vector3, Vector3, Vector3, Vector3];
  /** Out of the solid: the drawn side. */
  readonly normal: Vector3;
  readonly shading?: readonly [Vector3, Vector3, Vector3, Vector3];
}

/**
 * The ICP's parts as quads on the dash's face, the frame's (`framedScreenFacets`) and the rest: `floor` (0.5 mm into the
 * frame's inner walls all round, so no face of it lies on theirs), `body` (the DED's lip, the keys, the rockers: one
 * solid each), `ded` (the strip) and `rim` (the frame's chamfered rim).
 */
export function jetIcpFacets(): { frame: FacetQuad[]; rim: FacetQuad[]; floor: ShadedQuad[]; body: ShadedQuad[]; ded: ShadedQuad[] } {
  const d = JET_ICP;
  const face = jetPanelFace();
  const centre = jetIcpFaceCentre();
  const across = new Vector3(0, 0, 1);
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  const at = (u: number, v: number, o: number) => centre.add(across.scale(u)).add(up.scale(v)).add(out.scale(o));
  const stack = framedScreenStack(d);
  const floorFront = stack.screenFront;
  const sides = [up.scale(-1), across, up, across.scale(-1)];
  /** A box on the face from o0 to o1 over u0..u1, v0..v1: six flat quads. */
  const box = (u0: number, u1: number, v0: number, v1: number, o0: number, o1: number): ShadedQuad[] => {
    const r = (o: number) => [at(u0, v0, o), at(u1, v0, o), at(u1, v1, o), at(u0, v1, o)];
    const [back, front] = [r(o0), r(o1)];
    return [
      { corners: [front[0]!, front[1]!, front[2]!, front[3]!], normal: out },
      { corners: [back[0]!, back[1]!, back[2]!, back[3]!], normal: out.scale(-1) },
      ...[0, 1, 2, 3].map((k) => ({ corners: [back[k]!, back[(k + 1) % 4]!, front[(k + 1) % 4]!, front[k]!] as const, normal: sides[k]! })),
    ];
  };
  /**
   * A key: its outline w x h about (u, v), from 0.5 mm inside the floor to `proud` out of it, its four top edges rounded
   * at `radius` in `roundSegments` chords (the outline inset by the round's fall at each chord's height), shaded as the
   * round: at each corner of a chord, cos of its angle of the side's direction and sin of it out of the face.
   */
  const key = (u: number, v: number, w: number, h: number, proud: number, radius: number): ShadedQuad[] => {
    const layers = [{ o: floorFront - 0.0005, inset: 0, angle: 0 }];
    for (let k = 0; k <= d.roundSegments; k += 1) {
      const angle = (k / d.roundSegments) * (Math.PI / 2);
      layers.push({ o: floorFront + proud - radius + radius * Math.sin(angle), inset: radius * (1 - Math.cos(angle)), angle });
    }
    const ring = (layer: { o: number; inset: number }) => {
      const [a, b] = [w / 2 - layer.inset, h / 2 - layer.inset];
      return [at(u - a, v - b, layer.o), at(u + a, v - b, layer.o), at(u + a, v + b, layer.o), at(u - a, v + b, layer.o)];
    };
    const rings = layers.map(ring);
    const quads: ShadedQuad[] = [];
    for (let i = 0; i + 1 < layers.length; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        const [la, lb] = [layers[i]!, layers[i + 1]!];
        const n = (angle: number) => sides[k]!.scale(Math.cos(angle)).add(out.scale(Math.sin(angle))).normalize();
        const corners = [rings[i]![k]!, rings[i]![(k + 1) % 4]!, rings[i + 1]![(k + 1) % 4]!, rings[i + 1]![k]!] as const;
        const facet = n((la.angle + lb.angle) / 2);
        quads.push(i === 0 ? { corners, normal: sides[k]! } : { corners, normal: facet, shading: [n(la.angle), n(la.angle), n(lb.angle), n(lb.angle)] });
      }
    }
    const top = rings[rings.length - 1]!;
    const bottom = rings[0]!;
    quads.push({ corners: [top[0]!, top[1]!, top[2]!, top[3]!], normal: out });
    quads.push({ corners: [bottom[0]!, bottom[1]!, bottom[2]!, bottom[3]!], normal: out.scale(-1) });
    return quads;
  };
  const k = d.key;
  const r = d.rocker;
  const ded = d.ded;
  const [fu, fv] = [d.width / 2 + d.gap + 0.0005, d.height / 2 + d.gap + 0.0005];
  const floor = box(-fu, fu, -fv, fv, stack.screenBack, floorFront);
  // the DED's lip: a ring round the strip, from inside the floor to `lipProud` out of it
  const [iu, iv, ou, ov] = [ded.width / 2, ded.height / 2, ded.width / 2 + ded.lip, ded.height / 2 + ded.lip];
  const [lo0, lo1] = [floorFront - 0.0005, floorFront + ded.lipProud];
  const rect = (a: number, b: number, o: number) => [at(-a, ded.v - b, o), at(a, ded.v - b, o), at(a, ded.v + b, o), at(-a, ded.v + b, o)];
  const ringQuads = (p: Vector3[], q: Vector3[], normal: (k: number) => Vector3): ShadedQuad[] =>
    [0, 1, 2, 3].map((k) => ({ corners: [p[k]!, p[(k + 1) % 4]!, q[(k + 1) % 4]!, q[k]!] as const, normal: normal(k) }));
  const lip = [
    ...ringQuads(rect(iu, iv, lo1), rect(ou, ov, lo1), () => out),
    ...ringQuads(rect(ou, ov, lo0), rect(ou, ov, lo1), (s) => sides[s]!),
    ...ringQuads(rect(iu, iv, lo0), rect(ou, ov, lo0), () => out.scale(-1)),
    ...ringQuads(rect(iu, iv, lo0), rect(iu, iv, lo1), (s) => sides[s]!.scale(-1)),
  ];
  const keys = jetIcpKeyCentres().flatMap((c) => key(c.u, c.v, k.width, k.height, k.proud, k.radius));
  const halves = (side: -1 | 1) => [1, -1].flatMap((sign) => key(side * r.u, r.centreV + sign * (r.seam / 2 + r.half / 2), r.width, r.half, r.proud, r.radius));
  const framed = framedScreenFacets(centre, face, d);
  return {
    frame: framed.frame,
    rim: framed.rim,
    floor,
    body: [...lip, ...keys, ...halves(-1), ...halves(1)],
    ded: box(-ded.width / 2, ded.width / 2, ded.v - ded.height / 2, ded.v + ded.height / 2, floorFront - 0.0005, floorFront + ded.proud),
  };
}

/** A `facetMesh` of shaded quads: each drawn as `facetMesh` winds it, its corners taking their shading normals. */
function shadedFacetMesh(build: AircraftBuildContext, name: string, quads: readonly ShadedQuad[], material: PBRMaterial, parent: TransformNode): Mesh {
  const mesh = facetMesh(build, name, quads, material, parent);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  if (positions.length !== quads.length * 18) throw new RangeError(`shadedFacetMesh "${name}": a quad with no area`);
  const normals = [...mesh.getVerticesData(VertexBuffer.NormalKind)!];
  for (let v = 0; v < positions.length / 3; v += 1) {
    const quad = quads[Math.floor(v / 6)]!;
    if (!quad.shading) continue;
    const corner = quad.corners.findIndex((c) => c.x === positions[v * 3] && c.y === positions[v * 3 + 1] && c.z === positions[v * 3 + 2]);
    const n = quad.shading[corner]!;
    normals[v * 3] = n.x;
    normals[v * 3 + 1] = n.y;
    normals[v * 3 + 2] = n.z;
  }
  const data = new VertexData();
  data.positions = [...positions];
  data.normals = normals;
  data.uvs = [...mesh.getVerticesData(VertexBuffer.UVKind)!];
  data.indices = [...mesh.getIndices()!];
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
  return mesh;
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
  /**
   * Chords each top edge's round over its 90 degrees (Jason's F-16 wave, S3). At 2, each chord turned 45 degrees and
   * the S read as facets; the ends and the sills they leave share the section, so the sills went to 6 with them.
   */
  roundSegments: 6,
  /** The rail's bottom: 1 cm under the console's top. */
  bottomY: 0.59,
  glassMargin: 0.021,
  aftX: 1.9,
  bendX: 2.6,
  /**
   * The glass's inner half-width at `topY`, by crossings on the built canopy: at `aftX`, at `bendX` (the widest, from
   * x 2.3 to 2.6), at the board's side's bend (x 2.93) and at `backX` (x 3.03). The test re-measures the margin at
   * every vertex.
   */
  glassHalfWidth: Object.freeze({ aft: 0.4371, bend: 0.4559, dash: 0.4216, back: 0.4088 }),
  /**
   * The rail's stations beside the dash: the board's side's bend (the hood's plan starts narrowing, x 2.93) and 1 dm on.
   * They were the board's face and back; the cove raised the face's top to the round's aft tangent, 1 cm aft (x 2.92),
   * and the rails keep their run: the rail ends 1 cm past the board's back, its end cap facing forward, unseen. The
   * consoles' forward ends stay on the face (`jetPanelFaceX`), 12.7 mm aft with it at every height.
   */
  dashX: 2.93,
  backX: 3.03,
  consoleTopY: 0.6,
  consoleWidth: 0.15,
  consoleUnderRail: 0.03,
});

/** The dash's leaned face plane: its x at height y. */
export function jetPanelFaceX(y: number): number {
  const face = jetPanelFace();
  return face.top.x - ((face.top.y - y) * face.up.x) / face.up.y;
}

/**
 * The rail's section in (u, y), u measured inboard from its outer edge: up the outer face, over the rounded top, down the
 * inner face, each top edge rounded in `roundSegments` chords over its 90 degrees. A round's first and last points are
 * its tangents to the faces beside it. The sills and their ends share it, so an end leaves its sill flush.
 */
export function jetSillSection(): SweptSection {
  const r = JET_SILL;
  const segments = r.roundSegments;
  const shoulder = r.topY - r.radius;
  const arc = (centre: number, from: number, to: number) => Array.from({ length: segments + 1 }, (_, k) => {
    const angle = from + ((to - from) * k) / segments;
    return { u: centre + r.radius * Math.cos(angle), y: shoulder + r.radius * Math.sin(angle) };
  });
  // the tangents exact, not by cos and sin: the outer face's top, the flat top's two ends, the inner face's top
  const outer = arc(r.radius, Math.PI, Math.PI / 2);
  const inner = arc(r.width - r.radius, Math.PI / 2, 0);
  outer[0] = { u: 0, y: shoulder };
  outer[segments] = { u: r.radius, y: r.topY };
  inner[0] = { u: r.width - r.radius, y: r.topY };
  inner[segments] = { u: r.width, y: shoulder };
  return {
    points: [{ u: 0, y: r.bottomY }, ...outer, ...inner, { u: r.width, y: r.bottomY }],
    rounds: [
      { first: 1, last: 1 + segments, centre: { u: r.radius, y: shoulder } },
      { first: 2 + segments, last: 2 + 2 * segments, centre: { u: r.width - r.radius, y: shoulder } },
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
  const dashX = r.dashX;
  const backX = r.backX;
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
 * the rail at az 25 (so the deck row stays one row from -25 to +25) the sill rises along x in an S of two arcs of
 * `sRadius`, level at both ends, to the rail round's crown (S3; the silhouette's tangent before), on the glareshield's
 * matte and merged into the coaming, so the black of the rail runs on down into the sill. Its section is the sill's,
 * its top edges rounded in six chords (S3), and a fillet (`JET_RAIL_END_FILLET`) runs its inner side into the round
 * and the dash.
 *
 * WHY ALONG X: the glass is 2 cm outboard of the rail's end. From az 25 to the glass less 2 cm there are 2.8 cm of run
 * across z for a 9 cm drop, so a round across z (or a round in plan of 0.10) does not fit; along the canopy it does,
 * widening with the glass as it falls (2.3 cm wide at the top, the sill's 5.4 at its foot). Its section is the sill's
 * (rounded top edges), its outer edge `glassMargin` inside the glass at its own top's height at every station.
 */
export const JET_RAIL_END = Object.freeze({
  startAzimuthDegrees: 25,
  sRadius: 0.15,
  /**
   * Stations along the S, foot to top: 20 walls, 10 on each arc, spaced by the arc's angle (the S3 amend), so no
   * station turns the S's top more than 4.6 degrees and the sweep reads as one curve. At 9 stations spaced in x a corner
   * turned 12.4; the S turns 91 degrees in all, so 16 stations cannot get under 6.1.
   */
  stations: 21,
  /**
   * The glass's inner half-width at each station's top, foot to top, by crossings on the built canopy (re-measured at
   * the 21 stations of the S3 amend).
   */
  glassHalfWidth: Object.freeze([
    0.4439, 0.4427, 0.4414, 0.44, 0.4385, 0.4353, 0.4318, 0.4279, 0.4238, 0.4193, 0.4147,
    0.4101, 0.4057, 0.4015, 0.3976, 0.3941, 0.3908, 0.388, 0.3854, 0.3833, 0.3816,
  ]),
});

/**
 * The S's spine, foot to top: each station's x and the S's top there, the stations spaced by the angle along each of
 * the S's two arcs (half of them on each, the middle station on the join).
 */
export function jetRailEndSpine(): { x: number; top: number }[] {
  const e = JET_RAIL_END;
  const { foot, arc, t } = railEndS();
  const sweep = Math.asin(arc / e.sRadius);
  const walls = e.stations - 1;
  return Array.from({ length: e.stations }, (_, i) => {
    if (i === 0) return { x: foot, top: JET_SILL.topY };
    if (i === walls) return { x: t.x, top: t.y };
    const s = i / walls;
    const x = s <= 0.5 ? foot + e.sRadius * Math.sin(sweep * 2 * s) : t.x - e.sRadius * Math.sin(sweep * (2 - 2 * s));
    return { x, top: jetRailEndTopAt(x) };
  });
}

/**
 * The rail end's stations, foot to top: x, the S's top there, and the outer and inner edges' half-widths. The foot is
 * the sill's own section; the top is at the rail round's crown, from az 25 out.
 */
export function jetRailEndStations(): { x: number; top: number; outer: number; inner: number }[] {
  const e = JET_RAIL_END;
  return jetRailEndSpine().map(({ x, top }, i) => {
    // the foot is the sill's own section, so the S leaves it level and flush
    if (i === 0) return { x, top, outer: sillOuterAt(x), inner: jetRailEndInnerAt(x) };
    return { x, top, outer: e.glassHalfWidth[i]! - JET_SILL.glassMargin, inner: jetRailEndInnerAt(x) };
  });
}

/**
 * The S's run: its foot on the sill, its top at the rail round's crown, and the length of each arc. The crown, not the
 * sight line's tangent 3.5 mm forward of it (S3): the round stands 0.44 mm over the tangent's height there, and ended at
 * the tangent the S's top let the round's crown through it at the join, patches of the two surfaces. The crown is
 * 0.2 mm under the sight line, so the end never shows over the rail's row, and aft of it the S (R 0.15) stays over the
 * round (R 0.02).
 */
function railEndS(): { foot: number; arc: number; t: { x: number; y: number } } {
  const section = jetGlareshieldSection();
  const t = { x: section.centre.x, y: section.centre.y + JET_GLARESHIELD.radius };
  const half = (t.y - JET_SILL.topY) / 2;
  const arc = Math.sqrt(2 * JET_RAIL_END.sRadius * half - half * half);
  return { foot: t.x - 2 * arc, arc, t };
}

/** The rail end's top at x: the sill's top at its foot, rising in the S of two arcs to the rail's silhouette. */
export function jetRailEndTopAt(x: number): number {
  const e = JET_RAIL_END;
  const { foot, arc, t } = railEndS();
  const low = JET_SILL.topY;
  return x >= foot + arc ? t.y - (e.sRadius - Math.sqrt(e.sRadius ** 2 - (t.x - x) ** 2)) : low + (e.sRadius - Math.sqrt(e.sRadius ** 2 - (x - foot) ** 2));
}

/** The rail end's inner edge's half-width at x: the sill's inner edge at its foot, in straight to az 25 at its top. */
export function jetRailEndInnerAt(x: number): number {
  const { foot, t } = railEndS();
  const startZ = (t.x - eye().forward) * Math.tan((JET_RAIL_END.startAzimuthDegrees * Math.PI) / 180);
  const footInner = jetSillInnerAt(foot);
  return footInner + ((startZ - footInner) * (x - foot)) / (t.x - foot);
}

/** The rail end's S: its slope (dy/dx) at x, 0 at its foot and at its top. */
export function jetRailEndSlope(x: number): number {
  const e = JET_RAIL_END;
  const { foot, arc, t } = railEndS();
  const d = x >= foot + arc ? t.x - x : x - foot;
  return Math.max(0, d) / Math.sqrt(e.sRadius ** 2 - Math.max(0, d) ** 2);
}

// ---- the canopy seal ---------------------------------------------------------------------------

/**
 * THE CANOPY SEAL (Jason's F-16 wave, S4): a dark rounded strip in the glass margin along the outer edge of the rail's
 * ends and the sills, where the deck met the world with no line (the canopy is one bubble, with no frame at its base on
 * the type or here). `width` across, its top edges rounded at `radius`, its top at the deck's own top at every station
 * (so the deck's silhouette keeps its rows and falls monotone as it did), its inner face `into` inside the deck's outer
 * face, down to the rails' bottom. From the S's top at the round's crown (az 25 on the rail's row) along the S and on
 * aft along the sill to `aftX` (az 63), past the 21:9 frame's edge. On the glareshield's matte, merged into the coaming:
 * no draw. Its outer face stands 6 mm or more inside the glass (the PM's exception to the 2 cm for this strip alone, 4 mm
 * the floor): the margin is 21 mm at the deck's top and widens below it.
 */
export const JET_SEAL = Object.freeze({ width: 0.015, radius: 0.007, into: 0.0005, aftX: 2.45 });

/**
 * The seal's section in (u, y), u out from its inner face: up the inner face, over the rounded top, down the outer face,
 * each top edge rounded in `JET_SILL.roundSegments` chords; its top at the sills' top height and its bottom at theirs
 * (the placement lifts the top with the S).
 */
export function jetSealSection(): SweptSection {
  const s = JET_SEAL;
  const r = JET_SILL;
  const segments = r.roundSegments;
  const shoulder = r.topY - s.radius;
  const arc = (centre: number, from: number, to: number) => Array.from({ length: segments + 1 }, (_, k) => {
    const angle = from + ((to - from) * k) / segments;
    return { u: centre + s.radius * Math.cos(angle), y: shoulder + s.radius * Math.sin(angle) };
  });
  const inner = arc(s.radius, Math.PI, Math.PI / 2);
  const outer = arc(s.width - s.radius, Math.PI / 2, 0);
  inner[0] = { u: 0, y: shoulder };
  inner[segments] = { u: s.radius, y: r.topY };
  outer[0] = { u: s.width - s.radius, y: r.topY };
  outer[segments] = { u: s.width, y: shoulder };
  return {
    points: [{ u: 0, y: r.bottomY }, ...inner, ...outer, { u: s.width, y: r.bottomY }],
    rounds: [
      { first: 1, last: 1 + segments, centre: { u: s.radius, y: shoulder } },
      { first: 2 + segments, last: 2 + 2 * segments, centre: { u: s.width - s.radius, y: shoulder } },
    ],
  };
}

/**
 * The seal's stations, aft to forward: along the sill from `aftX` through its bend (x 2.6) to the S's foot, then the S's
 * own stations to its top: x, the deck's top there, and the seal's inner face's half-width (the deck's outer edge, less
 * `into`), and the slope of the deck's top there (the S's; level on the sill).
 */
export function jetSealStations(): { x: number; top: number; inner: number; slope: number }[] {
  const ends = jetRailEndStations();
  const sill = [JET_SEAL.aftX, JET_SILL.bendX].map((x) => ({ x, top: JET_SILL.topY, inner: sillOuterAt(x) - JET_SEAL.into, slope: 0 }));
  return [...sill, ...ends.map((e) => ({ x: e.x, top: e.top, inner: e.outer - JET_SEAL.into, slope: jetRailEndSlope(e.x) }))];
}

/**
 * The groove between the deck's outer round and the seal's inner round, its bottom a cove (a ball of `cove` rolled along
 * it, as `jetRailEndFillet` rolls its own), so the two rounds meet with no crease: the line reads as a channel, 3.5 mm
 * deep, whose walls turn through a round, not as a V (a V is 90 to 130 degrees between two rays). From the S's top the
 * ball starts large (the groove bridged flat, the S's top and the seal's one surface, so the deck's silhouette keeps its
 * row there) and comes down to `cove` over `rampIn` of run. Each station's arc is taken in the station's section plane,
 * where the S and the seal are placed, so the three meet exactly at every station; its two ends start `bury` inside the
 * rounds (whose chords lie up to 0.09 mm inside their circles: from the circles, the cove's closing faces stood out of
 * them as dark slivers), and its normals lean with the S's slope as the S's own do. Starboard; port is its mirror.
 */
export const JET_SEAL_GROOVE = Object.freeze({ cove: 0.003, rampIn: 0.035, arcSegments: 10, bury: 0.0002 });

export function jetSealGroove(): JetFilletStation[] {
  const g = JET_SEAL_GROOVE;
  const rr = JET_SILL.radius;
  const rs = JET_SEAL.radius;
  const crown = jetRailEndStations().at(-1)!.x;
  return jetSealStations().map((station) => {
    const outer = station.inner + JET_SEAL.into;
    // the ball's radius: large at the S's top, down to the cove over the ramp
    const along = Math.min(1, (crown - station.x) / g.rampIn);
    const rc = g.cove + 0.2 * (1 - along) ** 4;
    // in the section plane, (z, y): the deck's outer round and the seal's inner round
    const c1 = { z: outer - rr, y: station.top - rr };
    const c2 = { z: station.inner + rs, y: station.top - rs };
    const [a, b] = [rr + rc, rs + rc];
    const d = Math.hypot(c2.z - c1.z, c2.y - c1.y);
    const ex = { z: (c2.z - c1.z) / d, y: (c2.y - c1.y) / d };
    const along1 = (a * a - b * b + d * d) / (2 * d);
    const up = Math.sqrt(a * a - along1 * along1);
    // the ball's centre above the line between the two rounds' centres (that line runs outboard, so up is its left)
    const normal = { z: -ex.y, y: ex.z };
    const o = { z: c1.z + ex.z * along1 + normal.z * up, y: c1.y + ex.y * along1 + normal.y * up };
    const n1 = new Vector3(0, o.y - c1.y, o.z - c1.z).normalize();
    const n2 = new Vector3(0, o.y - c2.y, o.z - c2.z).normalize();
    const ball = new Vector3(station.x, o.y, o.z);
    const arc: Vector3[] = [];
    const normals: Vector3[] = [];
    for (let k = 0; k <= g.arcSegments; k += 1) {
      const n = slerpUnit(n1, n2, k / g.arcSegments);
      const end = k === 0 || k === g.arcSegments;
      arc.push(ball.subtract(n.scale(rc + (end ? g.bury : 0))));
      // square to the S's run, as its rounds' normals are made
      normals.push(new Vector3(-n.y * station.slope, n.y, n.z).normalize());
    }
    // inside both solids: under the rounds' meeting, between the deck's outer face and the seal's inner face
    const corner = new Vector3(station.x, station.top - 0.009, outer - JET_SEAL.into * 0.7);
    return { arc, normals, corner, onRail: true };
  });
}

/**
 * A round swept along x in its section's plane (the S's rounds, the seal's), at one station: its centre (y, and z out
 * to starboard), its radius, and how its centre moves along x (the S's slope, the edge's run in plan).
 */
interface ShearedRound {
  readonly cy: number;
  readonly cz: number;
  readonly radius: number;
  readonly dcy: number;
  readonly dcz: number;
}

/**
 * The true normals on the rounds of a sweep whose sections stand in the y-z plane while its path climbs (the S): at a
 * round's point, its radial (ny, nz) in the section, the normal is (-(ny dcy + nz dcz), ny, nz). `sweptSolid` makes the
 * radial square to the run instead, which is exact for a tube square to its path and, on the S's 45 degree middle,
 * leans its rounds up to 24 degrees outboard of true (a groove shaded true beside it stood 46 degrees apart in the
 * shading). Only the rounds' vertices move their normals; positions and the flat faces are the sweep's.
 */
function shearRoundNormals(mesh: Mesh, stations: readonly { readonly x: number; readonly rounds: readonly ShearedRound[] }[], side: -1 | 1): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = [...mesh.getVerticesData(VertexBuffer.NormalKind)!];
  for (let v = 0; v < positions.length / 3; v += 1) {
    const [x, y, z] = [positions[v * 3]!, positions[v * 3 + 1]!, side * positions[v * 3 + 2]!];
    const station = stations.find((q) => Math.abs(q.x - x) < 1e-9);
    if (!station) continue;
    for (const round of station.rounds) {
      const [ny, nz] = [(y - round.cy) / round.radius, (z - round.cz) / round.radius];
      if (Math.abs(Math.hypot(ny, nz) - 1) > 1e-6 || ny < -1e-9) continue;
      const n = new Vector3(-(ny * round.dcy + nz * round.dcz), ny, nz).normalize();
      normals[v * 3] = n.x;
      normals[v * 3 + 1] = n.y;
      normals[v * 3 + 2] = side * n.z;
      break;
    }
  }
  const data = new VertexData();
  data.positions = [...positions];
  data.normals = normals;
  data.uvs = [...mesh.getVerticesData(VertexBuffer.UVKind)!];
  data.indices = [...mesh.getIndices()!];
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
}

/** A quantity's rate along x at each of a run of stations: central differences, one-sided at the ends. */
function alongX(stations: readonly { readonly x: number }[], value: (i: number) => number): number[] {
  return stations.map((_, i) => {
    const [a, b] = [Math.max(0, i - 1), Math.min(stations.length - 1, i + 1)];
    return (value(b) - value(a)) / (stations[b]!.x - stations[a]!.x);
  });
}

/** The sill rail's outer edge's half-width at x (linear between its stations). */
function sillOuterAt(x: number): number {
  const stations = jetSillStations();
  const k = Math.max(0, Math.min(stations.length - 2, stations.findIndex((station) => station.x > x) - 1));
  const [a, b] = [stations[k]!, stations[k + 1]!];
  return a.outer + ((x - a.x) / (b.x - a.x)) * (b.outer - a.outer);
}

// ---- the rail end's fillet ------------------------------------------------------------------

/**
 * THE RAIL END'S FILLET (Jason's F-16 wave, S3: "walls and bars organic, not choppy"). Each rail end's inner side is a
 * wall facing inboard, and the rail's aft round and the dash's face, which run across the cockpit, stop against it: from
 * the seat an inside corner of 82 degrees from the deck line down past the frame's bottom (az 25.5 to 27.5), and one of
 * 70 to 83 where the end stands proud of the round. A ray grid finds both; the edge walk cannot, since the solids meet
 * without sharing an edge.
 *
 * A ball of `radius` rolled along the corner: at each station of the rail's profile (the dash's face from under the
 * console's top, the cove, the round up to where the ball no longer reaches the end) its centre stands `radius` off the
 * profile along its shading normal and `radius` off the end's inner side (its wall, or higher up its inner round), and
 * the fillet is the arc between its two contacts in `arcSegments` chords, shaded from the profile's normal to the end's.
 * So it meets both with their own normals. The profile is extruded across the cockpit, so the contact on it is exact;
 * the end's is taken in its section's plane, which puts the arc's far end at most 8 degrees off the wall's tilt in plan,
 * and the shading takes the end's own normal there.
 *
 * Each station's arc closes on a point 3 mm into the corner, so each span between stations is a solid whose faces
 * other than the arc's are inside the dash, the rail or the end. The span on the dash (under the round's aft tangent)
 * is on the dash's material and merged into it, the span on the round on the glareshield's matte and merged into the
 * coaming: the material seam runs on where the rail and the dash already meet. No draw.
 */
export const JET_RAIL_END_FILLET = Object.freeze({
  radius: 0.015,
  arcSegments: 6,
  /** Its foot: 5 mm under the console's top, so its end is inside the console. */
  bottomY: 0.595,
  /** The stations up the rail's round, from its aft tangent, this far apart. */
  roundStepDegrees: 5,
});

/** A fillet station, starboard: its arc from the profile to the end, each point's shading normal, and its buried corner. */
export interface JetFilletStation {
  readonly arc: readonly Vector3[];
  readonly normals: readonly Vector3[];
  readonly corner: Vector3;
  /** On the rail's round (the coaming's), not the dash's face or the cove (the board's). */
  readonly onRail: boolean;
}

/** The starboard fillet's stations, up the corner; port is its mirror in z. */
export function jetRailEndFillet(): JetFilletStation[] {
  const f = JET_RAIL_END_FILLET;
  const r = f.radius;
  const face = jetPanelFace();
  const coveFoot = jetCoveFoot();
  const { foot, t } = railEndS();
  const tilt = (jetRailEndInnerAt(t.x) - jetRailEndInnerAt(foot)) / (t.x - foot);
  const profile: { p: { x: number; y: number }; m: { x: number; y: number }; onRail: boolean }[] = [];
  // the dash's face and the cove: its normal turns from the face's to the round's aft one over the cove (`shadeJetCove`)
  for (const y of [f.bottomY, coveFoot.y, coveFoot.y + (face.top.y - coveFoot.y) / 3, coveFoot.y + (2 * (face.top.y - coveFoot.y)) / 3, face.top.y]) {
    const along = Math.max(0, Math.min(1, (face.top.y - y) / (face.top.y - coveFoot.y)));
    const m = new Vector3(-1 + (face.normal.x + 1) * along, face.normal.y * along, 0).normalize();
    profile.push({ p: { x: y === face.top.y ? face.top.x : jetPanelFaceX(y), y }, m: { x: m.x, y: m.y }, onRail: false });
  }
  // the round, up from its aft tangent (the face's top, the station above)
  const section = jetGlareshieldSection();
  const centre = section.centre;
  const radius = JET_GLARESHIELD.radius;
  for (let degrees = 180 - f.roundStepDegrees; degrees > 90; degrees -= f.roundStepDegrees) {
    const a = (degrees * Math.PI) / 180;
    profile.push({ p: { x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) }, m: { x: Math.cos(a), y: Math.sin(a) }, onRail: true });
  }
  const stations: JetFilletStation[] = [];
  for (const { p, m, onRail } of profile) {
    const o = { x: p.x + r * m.x, y: p.y + r * m.y };
    if (o.x <= foot || o.x >= t.x) break;
    const contact = railEndContact(o, r, tilt);
    if (contact === null) break;
    const { oz, reach } = contact;
    const n1 = new Vector3(m.x, m.y, 0);
    const ball = new Vector3(o.x, o.y, oz);
    const arc: Vector3[] = [];
    const normals: Vector3[] = [];
    for (let k = 0; k <= f.arcSegments; k += 1) {
      arc.push(ball.subtract(slerpUnit(n1, reach, k / f.arcSegments).scale(r)));
      normals.push(slerpUnit(n1, reach, k / f.arcSegments));
    }
    const both = n1.add(reach);
    const corner = ball.subtract(both.scale(r / (1 + Vector3.Dot(n1, reach)))).subtract(both.normalize().scale(0.003));
    stations.push({ arc, normals, corner, onRail });
  }
  return stations;
}

/**
 * Where a ball of radius `r` whose centre is at (o.x, o.y) touches the starboard end's inner side from inboard: the
 * centre's z, and the side's outward normal at the contact. On the true surfaces, so the fillet is tangent to them and
 * the end's chords fall inside it: the wall (a plane, its inner edge straight in plan, `tilt`) in closed form; above
 * the wall's top, the inner round (a circle in the section's plane swept along the S and the edge) by Newton on the
 * contact's place along the end and round the round. Null where the ball does not reach the end (it is over its top).
 */
function railEndContact(o: { x: number; y: number }, r: number, tilt: number): { oz: number; reach: Vector3 } | null {
  const rr = JET_SILL.radius;
  const wall = new Vector3(tilt, 0, -1).normalize();
  const oz = jetRailEndInnerAt(o.x) - r * Math.hypot(1, tilt);
  const onWall = new Vector3(o.x, o.y, oz).subtract(wall.scale(r));
  if (onWall.y <= jetRailEndTopAt(onWall.x) - rr) return { oz, reach: wall };
  // the round: its point at (x, angle) and its normal there; the ball's centre that far out along it
  const surface = (x: number, angle: number) => {
    const [cy, cz] = [Math.cos(angle), Math.sin(angle)];
    const point = new Vector3(x, jetRailEndTopAt(x) - rr + rr * cy, jetRailEndInnerAt(x) + rr + rr * cz);
    const normal = new Vector3(-(tilt * cz + jetRailEndSlope(x) * cy), cy, cz).normalize();
    return { point, normal, centre: point.add(normal.scale(r)) };
  };
  // start in the section's plane at the ball's x
  const dy = o.y - (jetRailEndTopAt(o.x) - rr);
  if (dy >= r + rr) return null;
  let [x, angle] = [o.x, Math.atan2(-Math.sqrt((r + rr) ** 2 - dy * dy), dy)];
  for (let step = 0; step < 20; step += 1) {
    const at = surface(x, angle).centre;
    const [fx, fy] = [at.x - o.x, at.y - o.y];
    if (Math.hypot(fx, fy) < 1e-12) break;
    const h = 1e-7;
    const ax = surface(x + h, angle).centre;
    const aa = surface(x, angle + h).centre;
    const [j11, j12, j21, j22] = [(ax.x - at.x) / h, (aa.x - at.x) / h, (ax.y - at.y) / h, (aa.y - at.y) / h];
    const det = j11 * j22 - j12 * j21;
    x -= (j22 * fx - j12 * fy) / det;
    angle -= (-j21 * fx + j11 * fy) / det;
  }
  const { centre, normal } = surface(x, angle);
  // on the inner round's quarter (inboard and up), and the end there
  if (Math.abs(centre.x - o.x) > 1e-9 || Math.abs(centre.y - o.y) > 1e-9 || normal.y < -1e-9 || normal.z > 1e-9) return null;
  if (x <= railEndS().foot || x >= railEndS().t.x) return null;
  return { oz: centre.z, reach: normal };
}

/** Spherical interpolation between two unit vectors. */
function slerpUnit(a: Vector3, b: Vector3, t: number): Vector3 {
  const angle = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(a, b))));
  if (angle < 1e-6) return a.scale(1 - t).add(b.scale(t)).normalize();
  return a.scale(Math.sin((1 - t) * angle)).add(b.scale(Math.sin(t * angle))).scale(1 / Math.sin(angle)).normalize();
}

/**
 * One side's fillet, the stations `from` to `to` (inclusive) as solids: the arc's chords (shaded by the stations'
 * normals), the two faces closing each span on its buried corner, and a cap at each end, all one mesh.
 */
function filletMesh(
  build: AircraftBuildContext,
  name: string,
  stations: readonly JetFilletStation[],
  side: -1 | 1,
  material: PBRMaterial,
  parent: TransformNode,
): Mesh {
  const mirror = (v: Vector3) => new Vector3(v.x, v.y, side * v.z);
  const quads: FacetQuad[] = [];
  const shading = new Map<string, Vector3>();
  const at = (v: Vector3) => `${v.x},${v.y},${v.z}`;
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const [a, b] = [stations[i]!, stations[i + 1]!];
    const count = a.arc.length;
    for (let k = 0; k + 1 < count; k += 1) {
      const corners = [a.arc[k]!, a.arc[k + 1]!, b.arc[k + 1]!, b.arc[k]!].map(mirror) as [Vector3, Vector3, Vector3, Vector3];
      const normal = mirror(a.normals[k]!.add(a.normals[k + 1]!).add(b.normals[k]!).add(b.normals[k + 1]!).normalize());
      quads.push({ corners, normal });
    }
    // the two closing faces, each facing away from the other contact
    for (const [edge, other] of [[0, count - 1], [count - 1, 0]] as const) {
      const corners = [a.arc[edge]!, a.corner, b.corner, b.arc[edge]!].map(mirror) as [Vector3, Vector3, Vector3, Vector3];
      let normal = Vector3.Cross(corners[1].subtract(corners[0]), corners[3].subtract(corners[0])).normalize();
      if (Vector3.Dot(normal, mirror(a.arc[other]!).subtract(corners[0])) > 0) normal = normal.scale(-1);
      quads.push({ corners, normal });
    }
  }
  for (const [end, towards] of [[0, 1], [stations.length - 1, stations.length - 2]] as const) {
    const station = stations[end]!;
    const outward = mirror(station.corner.subtract(stations[towards]!.corner).normalize());
    for (let k = 0; k + 1 < station.arc.length; k += 1) {
      const corners = [station.corner, station.arc[k]!, station.arc[k + 1]!, station.arc[k + 1]!].map(mirror) as [Vector3, Vector3, Vector3, Vector3];
      quads.push({ corners, normal: outward });
    }
  }
  const mesh = facetMesh(build, name, quads, material, parent);
  // the arc's chords take the arc's normals at their corners; the closing faces and the caps stay flat
  for (const station of stations) station.arc.forEach((point, k) => shading.set(at(mirror(point)), mirror(station.normals[k]!)));
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = [...mesh.getVerticesData(VertexBuffer.NormalKind)!];
  for (let v = 0; v < positions.length / 3; v += 1) {
    const smooth = shading.get(`${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`);
    const flat = new Vector3(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    // only on the arc's own faces: a closing face or a cap shares the arc's end points and keeps its flat normal
    if (smooth && Vector3.Dot(smooth, flat) > 0.5) {
      normals[v * 3] = smooth.x;
      normals[v * 3 + 1] = smooth.y;
      normals[v * 3 + 2] = smooth.z;
    }
  }
  const data = new VertexData();
  data.positions = [...positions];
  data.normals = normals;
  data.uvs = [...mesh.getVerticesData(VertexBuffer.UVKind)!];
  data.indices = [...mesh.getIndices()!];
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
  return mesh;
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
   * frame, its housing, its combiner's panes, the MFDs' frames, their rims (the ICP's with them), the MFD screens, the
   * sills, the ICP and its DED.
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
  // Swept across the cockpit (S3), its outboard ends rolled over a round (`JET_RAIL_SIDES`), the plan narrowed in the
  // placement: the whole section between the rounded ends, the round shading as a curve (step 3: flat, its eight chords
  // read as bands about 20 px tall), its points listed from the hood's tangent round to the aft one, which the outline
  // starts on; each rounded end shaded as the section rolled over its round (`rollRailSideNormals`: the sweep's own rule,
  // the round's radial made square to the run, stops being a normal where the run turns out to the side).
  const section = jetGlareshieldSection();
  const outline = section.outline;
  const onRound = (p: { x: number; y: number }) => section.round.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);
  const start = outline.findIndex((p, j) => onRound(p) && !onRound(outline[(j - 1 + outline.length) % outline.length]!));
  const order = outline.map((_, j) => (start + j) % outline.length);
  const roundCount = order.filter((j) => onRound(outline[j]!)).length;
  const points = order.map((j) => ({ u: outline[j]!.x, y: outline[j]!.y }));
  const railStations = jetRailStations();
  const insets = railStations.map(({ inset }) => jetRailOutlineInset(inset));
  const railPart = (name: string, from: number, to: number, rounds: SweptSection["rounds"]) => sweptSolid(
    build,
    name,
    { points, rounds },
    to - from + 1,
    (i, point) => {
      // an outline point, inset at this station (or the section's middle, which the sweep places to face its caps), its
      // z scaled by the plan at its own x: the same scale at every station, so the rounded end's thin outer spans cannot
      // cross over where the plan starts narrowing (x 2.93, inside the rounded ends)
      const j = outline.findIndex((q) => q.x === point.u && q.y === point.y);
      const at = j < 0 ? { x: point.u, y: point.y } : insets[from + i]![j]!;
      return new Vector3(at.x, at.y, (railStations[from + i]!.z * jetCoamingHalfWidth(point.u)) / g.nearHalfWidth);
    },
    (direction) => new Vector3(direction.u, direction.y, 0),
    glare,
    root,
  );
  const ends = JET_RAIL_SIDES.endSegments;
  const rail = railPart("jet-glare-shield-rail", ends, ends + 1, [{ first: 0, last: roundCount - 1, centre: { u: section.centre.x, y: section.centre.y } }]);
  const railSides = [railPart("jet-glare-shield-side-port", 0, ends, []), railPart("jet-glare-shield-side-starboard", ends + 1, 2 * ends + 1, [])];
  railSides.forEach((part, k) => rollRailSideNormals(part, k === 0 ? 0 : ends + 1, k === 0 ? -1 : 1));
  // THE RAIL'S ENDS (step 5), each sweeping aft and down into its sill, merged with it on the glareshield's matte
  const endStations = jetRailEndStations();
  const coamingParts: AbstractMesh[] = [rail, ...railSides];
  const fillet = jetRailEndFillet();
  const onRail = fillet.findIndex((station) => station.onRail);
  if (onRail < 1) throw new RangeError("the F-16's rail-end fillet reaches neither the dash nor the round");
  for (const side of [-1, 1] as const) {
    const inset = (station: { outer: number; inner: number }, u: number) => (u <= JET_SILL.width / 2 ? u : u - (JET_SILL.width - (station.outer - station.inner)));
    const label = side < 0 ? "port" : "starboard";
    const end = sweptSolid(
      build,
      `jet-glare-shield-end-${label}`,
      jetSillSection(),
      endStations.length,
      (i, point) => new Vector3(
        endStations[i]!.x,
        point.y <= JET_SILL.bottomY ? point.y : point.y + (endStations[i]!.top - JET_SILL.topY),
        side * (endStations[i]!.outer - inset(endStations[i]!, point.u)),
      ),
      (direction) => new Vector3(0, direction.y, -side * direction.u),
      glare,
      root,
      { smoothAlong: true, tangent: (i) => new Vector3(1, jetRailEndSlope(endStations[i]!.x), 0) },
    );
    // its rounds shaded true on the sloping S (S4): the outer round's centre follows the outer edge, the inner's the inner
    const rr = JET_SILL.radius;
    const outerRun = alongX(endStations, (i) => endStations[i]!.outer);
    const innerRun = alongX(endStations, (i) => endStations[i]!.inner);
    shearRoundNormals(end, endStations.map((q, i) => ({
      x: q.x,
      rounds: [
        { cy: q.top - rr, cz: q.outer - rr, radius: rr, dcy: jetRailEndSlope(q.x), dcz: outerRun[i]! },
        { cy: q.top - rr, cz: q.inner + rr, radius: rr, dcy: jetRailEndSlope(q.x), dcz: innerRun[i]! },
      ],
    })), side);
    coamingParts.push(end);
    // the fillet's span up the round, where the end stands against it (S3)
    coamingParts.push(filletMesh(build, `jet-glare-shield-fillet-${label}`, fillet.slice(onRail - 1), side, glare, root));
  }
  // THE CANOPY SEAL (S4), each side along the S and the sill in the glass margin, on the matte with the rest
  const seal = jetSealStations();
  for (const side of [-1, 1] as const) {
    const strip = sweptSolid(
      build,
      `jet-glare-shield-seal-${side < 0 ? "port" : "starboard"}`,
      jetSealSection(),
      seal.length,
      (i, point) => new Vector3(
        seal[i]!.x,
        point.y <= JET_SILL.bottomY ? point.y : point.y + (seal[i]!.top - JET_SILL.topY),
        side * (seal[i]!.inner + point.u),
      ),
      (direction) => new Vector3(0, direction.y, side * direction.u),
      glare,
      root,
      { smoothAlong: true, tangent: (i) => new Vector3(1, seal[i]!.slope, 0) },
    );
    const rs = JET_SEAL.radius;
    const run = alongX(seal, (i) => seal[i]!.inner);
    shearRoundNormals(strip, seal.map((q, i) => ({
      x: q.x,
      rounds: [
        { cy: q.top - rs, cz: q.inner + rs, radius: rs, dcy: q.slope, dcz: run[i]! },
        { cy: q.top - rs, cz: q.inner + JET_SEAL.width - rs, radius: rs, dcy: q.slope, dcz: run[i]! },
      ],
    })), side);
    coamingParts.push(strip);
    coamingParts.push(filletMesh(build, `jet-glare-shield-seal-groove-${side < 0 ? "port" : "starboard"}`, jetSealGroove(), side, glare, root));
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
  const plate = solidPlate(build, "jet-instrument-panel-board", jetPanelSection(), faceHalfWidth * 2, panelMaterial, root);
  sculptSolid(plate, (point) => new Vector3(point.x, point.y, (point.z * (jetCoamingHalfWidth(point.x) - p.sideInset)) / faceHalfWidth));
  // the cove: the face's top strip shaded from the round's aft normal to the face's
  shadeJetCove(plate);
  // the fillet's span on the dash's face and the cove, each side, where the ends stand against it (S3), and the ICP's
  // recessed floor on the dash's material (S1)
  const icp = jetIcpFacets();
  const boardParts: AbstractMesh[] = [
    plate,
    ...([-1, 1] as const).map((side) => filletMesh(build, `jet-instrument-panel-fillet-${side < 0 ? "port" : "starboard"}`, fillet.slice(0, onRail), side, panelMaterial, root)),
    shadedFacetMesh(build, "jet-instrument-panel-icp-floor", icp.floor, panelMaterial, root),
  ];
  for (const part of boardParts) part.metadata = { ...part.metadata, cockpitInterior: true };
  const board = build.mergeStatic("jet-instrument-panel", boardParts, root);

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
  // THE ICP (S1): its framed panel, lip, keys and rockers one mesh on the frames' grey (its floor is the board's), its rim
  // with the MFDs' rims, the DED on the rims' material
  const icpMesh = build.mergeStatic("jet-icp", [facetMesh(build, "jet-icp-frame", icp.frame, frameMaterial, root), shadedFacetMesh(build, "jet-icp-body", icp.body, frameMaterial, root)], root);
  rims.push(facetMesh(build, "jet-icp-rim", icp.rim, materials.rim, root));
  const dedMesh = shadedFacetMesh(build, "jet-icp-ded", icp.ded, materials.rim, root);
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
    parts: [frame, housing, combiner, framesMesh, rimsMesh, screensMesh, sillsMesh, icpMesh, dedMesh],
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
