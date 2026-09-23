import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "@/src/render/cameraPresentation";
import { PANE_GRID, sightline, type Point3, type SkinCaster } from "../airlinerGlazing";
import {
  GLOBAL_FLIGHT_DECK_OUTLINES,
  GLOBAL_FLIGHT_DECK_REFERENCE,
  anglesTo,
  globalBodyPoint,
  globalSkinSectionAt,
  outlinePoint,
  type BodyPoint,
  type GlobalPaneOutline,
} from "../bizjetGlazing";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, solidPlate } from "./cockpitPrimitives";
import {
  BIZJET_DISPLAYS,
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

/**
 * What a pilot in the Global's LEFT seat sees, built to the glass as it is built.
 *
 * THE GLASS IS CAST, AND SO IS THE FRAME ROUND IT. The flight deck is the type's six panes, a
 * windshield either side of a centre post and a forward and an aft side pane a side, laid out on the
 * body by station and angle round the section (`bizjetGlazing.ts`) and cast onto the fuselage's own
 * triangles from the reference R. The glass and the plane engineer's post are hidden from the
 * cockpit camera, and the shell draws nothing of itself from inside, so everything that frames the
 * view is built here as COCKPIT-ONLY parts (`CommonRig.cockpitOnlyParts`), invisible from any other
 * camera and never a shadow caster. The frame is a LINING cast the same way, from the same R onto
 * the same triangles (the caster the glass was cast with is handed in), one `skinPanel` per strip:
 *
 *  - the MEMBERS between neighbouring panes are the body between their edges, read off the
 *    outlines: the centre post between the two windshields' inboard edges, the pillar between the
 *    windshield and the forward side pane, the mid post between the side panes, and the aft end
 *    behind the aft side pane;
 *  - under every pane and member a SILL, and over every one a CROWN, running straight down (up) in
 *    R's elevation from its edge to `BIZJET_LINING.bottom` (`.top`), as the 747's do.
 *
 * Every strip takes the points of its edges from the same functions the glass is cast through
 * (`outlinePoint`), at the panes' own grid fractions, so a lining edge that meets a pane IS that
 * pane's edge, and two strips that meet share every cast point along the seam: no T-junction and no
 * hairline (the 747's K2 lesson). Nothing is copied from a table: a re-lofted nose, or panes moved
 * on it, move the frame with the glass.
 *
 * THE DECK is the glareshield's lip alone, a line along z at the panel's face, FLUSH with it, standing
 * at the catalogue's deck line (`cockpitDeckLineDegrees`, the one number the 2D HUD keeps above, so the
 * two cannot disagree). The rule it is held to is this type's own: the HIGHEST straight lip that covers
 * no glass the pilot can see (`highestClearLip`). The windshield's bottom edge rises towards the post,
 * so no straight lip can follow it within a degree the way the 747's does; this one meets the glass
 * where the bottom edge is lowest in the frame, and the sill, window frame on the interior material,
 * fills the rest up to the glass. `tests/render.cockpit-bizjet.test.ts` solves the rule against the
 * BUILT sills and holds the catalogue's number to it.
 *
 * THE EYE is the catalogue's. Everything else here is solved from it and from the glass as built, so
 * the pins live in the catalogue and the tests, not here.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at negative Z.
 */

const DEG = Math.PI / 180;

export interface BizjetCockpitMaterials {
  /** Dark matte interior: the panel board and the window frame's lining. (The lip has its own: `glareshieldMaterial`.) */
  readonly interior: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /**
   * Bezels: a dark-grey rim with a faint lit edge by day. It carries the night
   * glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one.
   */
  readonly instrumentMarking: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("bizjet").cockpitEye;
}

/** The lens's half-width, as a slope: the frame's left and right edges at 16:9 and narrower (the lens is horizontal-fixed up to 16:9). */
const FRAME_HALF_WIDTH = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES / 2) * DEG);

// ---- the frame: the lining cast on the skin round the glass ----------------------------------

/**
 * How far below and above the glass the lining runs, in R's elevation; the widest step between a sill's or a
 * crown's rows; how far it stands out of the skin and in from it (the 747's 2 cm, K3: a deeper lining shows its
 * side as a second, lit face down every pillar); and how many metres of station the aft end member takes.
 *
 * The bounds are R's, and the eye is not R: they reach past the 16:9 frame's edges from the eye with room,
 * which `tests/render.cockpit-bizjet.test.ts` holds by casting the whole frame (no hidden skin showing).
 */
export const BIZJET_LINING = Object.freeze({ bottom: -40, top: 60, maxStepDegrees: 5, proud: 0.008, depth: 0.012, aftEnd: 0.1 });

/** A lining strip as R sees it: its grid of STARBOARD (azimuth, elevation) from R, rows bottom to top, columns in azimuth order. */
export interface BizjetLiningStrip {
  readonly name: string;
  /**
   * Built once across the centreline (cast on the port side, so a negative azimuth is the starboard half), or
   * once a side, mirrored.
   */
  readonly centre: boolean;
  readonly angles: readonly (readonly (readonly [number, number])[])[];
  /** The columns whose top row (a sill) or bottom row (a crown) runs along a pane's edge, chord by chord: `[k, k + 1]`. */
  readonly glassChords: readonly number[];
}

type Angles = readonly [number, number];

function pane(name: GlobalPaneOutline["name"]): GlobalPaneOutline {
  const found = GLOBAL_FLIGHT_DECK_OUTLINES.find((outline) => outline.name === name);
  if (!found) throw new Error(`the Global's flight deck has no ${name} pane`);
  return found;
}

/** R's starboard (azimuth, elevation) of a point on the body: the sightline the glass is cast along. */
function seen(point: BodyPoint): Angles {
  return anglesTo(globalBodyPoint(point, 1), GLOBAL_FLIGHT_DECK_REFERENCE);
}

const fractions = (count: number) => Array.from({ length: count }, (_, k) => k / (count - 1));

/** A pane's bottom (row 0) or top (row 1) edge at the pane's own column fractions, inboard to outboard. */
function paneEdge(outline: GlobalPaneOutline, row: 0 | 1): Angles[] {
  return fractions(PANE_GRID).map((column) => seen(outlinePoint(outline, column, row)));
}

/** A pane's inboard (column 0) or outboard (column 1) edge at the pane's own row fractions, bottom to top. */
function paneSide(outline: GlobalPaneOutline, column: 0 | 1): BodyPoint[] {
  return fractions(PANE_GRID).map((row) => outlinePoint(outline, column, row));
}

/**
 * A strip `rows` tall at the azimuths of `edge`, running straight down (a sill) or up (a crown) in R's elevation
 * from the edge to `to`: rows bottom to top, so a sill's top row and a crown's bottom row are the edge itself.
 */
function verticalRun(edge: readonly Angles[], to: number, rows: number, downward: boolean): Angles[][] {
  return fractions(rows).map((f) => edge.map(([azimuth, elevation]) => {
    const [from, until] = downward ? [to, elevation] : [elevation, to];
    return [azimuth, f === 1 ? until : from + (until - from) * f] as const;
  }));
}

/** Rows needed so that no step of any run is wider than `maxStepDegrees`. */
function rowsFor(spans: readonly number[]): number {
  return Math.max(2, Math.ceil(Math.max(...spans) / BIZJET_LINING.maxStepDegrees) + 1);
}

/**
 * Every strip of the lining, READ from the outlines: members, then the sills and crowns that run from their edges.
 *
 * The seams are shared cast points by construction: the post's columns are the windshields' inboard edges (their
 * starboard half the port edge's exact negation), a member's columns are its two panes' edges, and each sill or
 * crown's columns are the pane and member edges it runs from, joined in azimuth order, so neighbouring strips
 * share whole columns and every sill (every crown) has the same rows.
 */
export function bizjetLiningStrips(): readonly BizjetLiningStrip[] {
  const windshield = pane("windshield");
  const forward = pane("forward-side");
  const aft = pane("aft-side");
  const { bottom, top, aftEnd } = BIZJET_LINING;
  const mirror = ([azimuth, elevation]: Angles): Angles => [-azimuth, elevation];

  // THE MEMBERS: two columns each, PANE_GRID rows along the panes' own side edges.
  const post = paneSide(windshield, 0).map((p) => { const a = seen(p); return [mirror(a), a]; });
  const pillar = paneSide(windshield, 1).map((p, row) => [seen(p), seen(paneSide(forward, 0)[row]!)]);
  const midPost = paneSide(forward, 1).map((p, row) => [seen(p), seen(paneSide(aft, 0)[row]!)]);
  const aftEdge = paneSide(aft, 1);
  const aftEndMember = aftEdge.map((p) => [seen(p), seen([p[0] + aftEnd, p[1]])]);

  // THE EDGES THE SILLS HANG FROM and the crowns stand on, in azimuth order, with which chords are glass.
  const windshieldBottom = paneEdge(windshield, 0);
  const windshieldTop = paneEdge(windshield, 1);
  const centreBottom = [...[...windshieldBottom].reverse().map(mirror), ...windshieldBottom];
  const centreTop = [...[...windshieldTop].reverse().map(mirror), ...windshieldTop];
  const centreGlass = [...Array.from({ length: PANE_GRID - 1 }, (_, k) => k), ...Array.from({ length: PANE_GRID - 1 }, (_, k) => PANE_GRID + k)];
  // the forward side: the pillar's foot (from the windshield's outboard corner), then the pane
  const forwardBottom = [windshieldBottom.at(-1)!, ...paneEdge(forward, 0)];
  const forwardTop = [windshieldTop.at(-1)!, ...paneEdge(forward, 1)];
  const forwardGlass = Array.from({ length: PANE_GRID - 1 }, (_, k) => k + 1);
  // the aft side: the mid post's foot, the pane, then the aft end's
  const aftBottom = [paneEdge(forward, 0).at(-1)!, ...paneEdge(aft, 0), aftEndMember[0]![1]!];
  const aftTop = [paneEdge(forward, 1).at(-1)!, ...paneEdge(aft, 1), aftEndMember.at(-1)![1]!];
  const aftGlass = Array.from({ length: PANE_GRID - 1 }, (_, k) => k + 1);

  const bottoms = [centreBottom, forwardBottom, aftBottom];
  const tops = [centreTop, forwardTop, aftTop];
  for (const edge of bottoms) for (const [, elevation] of edge) {
    if (!(elevation > bottom)) throw new RangeError(`the Global's lining: glass at R elevation ${elevation.toFixed(2)} is under the lining's bottom`);
  }
  for (const edge of tops) for (const [, elevation] of edge) {
    if (!(elevation < top)) throw new RangeError(`the Global's lining: glass at R elevation ${elevation.toFixed(2)} is over the lining's top`);
  }
  const sillRows = rowsFor(bottoms.flat().map(([, elevation]) => elevation - bottom));
  const crownRows = rowsFor(tops.flat().map(([, elevation]) => top - elevation));

  return [
    { name: "post", centre: true, angles: post, glassChords: [] },
    { name: "sill-centre", centre: true, angles: verticalRun(centreBottom, bottom, sillRows, true), glassChords: centreGlass },
    { name: "crown-centre", centre: true, angles: verticalRun(centreTop, top, crownRows, false), glassChords: centreGlass },
    { name: "pillar", centre: false, angles: pillar, glassChords: [] },
    { name: "sill-forward-side", centre: false, angles: verticalRun(forwardBottom, bottom, sillRows, true), glassChords: forwardGlass },
    { name: "crown-forward-side", centre: false, angles: verticalRun(forwardTop, top, crownRows, false), glassChords: forwardGlass },
    { name: "mid-post", centre: false, angles: midPost, glassChords: [] },
    { name: "aft-end", centre: false, angles: aftEndMember, glassChords: [] },
    { name: "sill-aft-side", centre: false, angles: verticalRun(aftBottom, bottom, sillRows, true), glassChords: aftGlass },
    { name: "crown-aft-side", centre: false, angles: verticalRun(aftTop, top, crownRows, false), glassChords: aftGlass },
  ];
}

/** A strip's name as built: `port-` / `starboard-` for a side's, none for a centre strip. */
export function bizjetLiningMeshName(strip: BizjetLiningStrip, side: 1 | -1): string {
  return `${strip.centre ? "" : side > 0 ? "starboard-" : "port-"}bizjet-lining-${strip.name}`;
}

/**
 * THE SILL CAP: a ledge along the side panes' bottom edges, so the wall under them reads as structure and not as a
 * void (K2's frames: from the seat about 11 degrees of flat wall runs from the forward side pane's bottom edge to the
 * frame's bottom). It runs the whole top row of the side sills (under the pillar's foot and the mid post too), its top
 * face level with that row on the lining's inner face and `width` inboard of it, horizontally, `thickness` deep.
 */
export const BIZJET_SILL_CAP = Object.freeze({ width: 0.05, thickness: 0.02, sills: ["sill-forward-side", "sill-aft-side"] as const });

/** A cap's mesh name: the side's, after its sill (`port-bizjet-lining-cap-forward-side`). */
export function bizjetSillCapMeshName(sill: (typeof BIZJET_SILL_CAP.sills)[number], side: 1 | -1): string {
  return `${side > 0 ? "starboard-" : "port-"}bizjet-lining-cap-${sill.replace(/^sill-/, "")}`;
}

/**
 * A cap's grid on its sill's top row. Row 0 IS the sill's top row on the lining's inner face, computed the way
 * `skinPanel` offsets it (point + normal x -depth), so the cap and the sill meet at the same points to the last bit
 * (no T-junction); row 1 is `width` inboard of it along the wall's own inward normal laid flat. The normals point DOWN,
 * with the cap's thickness as its proud and nothing as its depth, so the grid is its top face and its inner face.
 */
export function bizjetSillCapGrid(sill: { points: readonly (readonly Point3[])[]; normals: readonly (readonly Point3[])[] }): { points: Point3[][]; normals: Point3[][] } {
  const top = sill.points.length - 1;
  const { depth } = BIZJET_LINING;
  const edge: Point3[] = [];
  const inboard: Point3[] = [];
  for (const [column, p] of sill.points[top]!.entries()) {
    const n = sill.normals[top]![column]!;
    const e = { x: p.x + n.x * -depth, y: p.y + n.y * -depth, z: p.z + n.z * -depth };
    const flat = Math.hypot(n.x, n.z);
    if (!(flat > 0)) throw new RangeError("the Global's sill cap: the wall has no horizontal normal there");
    edge.push(e);
    inboard.push({ x: e.x - (n.x / flat) * BIZJET_SILL_CAP.width, y: e.y, z: e.z - (n.z / flat) * BIZJET_SILL_CAP.width });
  }
  const down = edge.map(() => ({ x: 0, y: -1, z: 0 }));
  return { points: [edge, inboard], normals: [down, down.map((d) => ({ ...d }))] };
}

/** A strip's grid on the skin, cast from R as the panes are: rows bottom to top, columns in azimuth order. */
export function bizjetLiningGrid(skin: SkinCaster, strip: BizjetLiningStrip, side: 1 | -1): { points: Point3[][]; normals: Point3[][] } {
  const points: Point3[][] = [];
  const normals: Point3[][] = [];
  for (const row of strip.angles) {
    const pointRow: Point3[] = [];
    const normalRow: Point3[] = [];
    for (const [azimuth, elevation] of row) {
      const hit = skin.exit(GLOBAL_FLIGHT_DECK_REFERENCE, sightline(azimuth, elevation, side));
      if (!hit) throw new RangeError(`the Global's lining ${strip.name}: no skin at az ${azimuth.toFixed(2)}, el ${elevation.toFixed(2)}`);
      pointRow.push(hit.point);
      normalRow.push(hit.normal);
    }
    points.push(pointRow);
    normals.push(normalRow);
  }
  return { points, normals };
}

// ---- the lip -----------------------------------------------------------------------------------

/**
 * THE LIP RULE for this type: the HIGHEST straight lip that covers no glass.
 *
 * A line along z at `faceX` and height y reads, at an azimuth az from the eye, tan(el) = (y - eye.y) cos(az) /
 * (faceX - eye.x); a point p at that same azimuth reads tan(el) = (p.y - eye.y) cos(az) / (p.x - eye.x). So the
 * lip is under p exactly when (y - eye.y) / (faceX - eye.x) <= (p.y - eye.y) / (p.x - eye.x): p's SLOPE in the
 * vertical plane along x, whatever its azimuth. The highest lip under every point is the least slope, and
 * nothing is solved iteratively.
 *
 * `glass` is the edge the pilot sees the glass begin at (for the kit, the sill's top rim, each point the higher of
 * its outer and inner edge). Only points in the frame (the lens's half-width) and over the lip's own span count:
 * glass the lip does not reach, or the pilot cannot see, does not hold it down.
 *
 * Returns the lip's height and its elevation straight ahead (negative: under the horizon); the deck line is minus
 * that.
 */
export function highestClearLip(
  eyePoint: Point3,
  faceX: number,
  glass: readonly Point3[],
  halfWidth: number,
  frameHalfWidth = FRAME_HALF_WIDTH,
): { y: number; elevationDegrees: number; held: Point3 } {
  const ahead = faceX - eyePoint.x;
  if (!(ahead > 0)) throw new RangeError("the lip must stand ahead of the eye");
  let least = Number.POSITIVE_INFINITY;
  let held: Point3 | null = null;
  for (const p of glass) {
    const forward = p.x - eyePoint.x;
    if (!(forward > 0)) continue;
    const across = (p.z - eyePoint.z) / forward;
    if (Math.abs(across) > frameHalfWidth) continue;
    if (Math.abs(eyePoint.z + ahead * across) > halfWidth) continue;
    const slope = (p.y - eyePoint.y) / forward;
    if (slope < least) {
      least = slope;
      held = p;
    }
  }
  if (held === null) throw new RangeError("no glass in the frame over the lip: the rule has nothing to hold it");
  return { y: eyePoint.y + least * ahead, elevationDegrees: Math.atan(least) / DEG, held };
}

// ---- the panel, its lip and the screens --------------------------------------------------------

export const BIZJET_PANEL = Object.freeze({
  /** The pilot-facing face of the board is this far ahead of the eye (it was at x 12.55 with the eye at 11.90). */
  faceAheadOfEye: 0.65,
  /** The board stands this deep behind its face; the lip's wedge runs the same depth. */
  thickness: 0.08,
  /** The board runs down to this far under the eye: below the frame at any aspect the lens is used at. */
  bottomBelowEye: 0.58,
  /**
   * Kept between the board's and the lip's corners and the shell. The fuselage is a 48-gon inscribed in the
   * ellipse the glazing module reads, so the shell's half-width is taken at cos(pi / 48) of the ellipse's, less this.
   */
  shellMargin: 0.01,
});

/** Segments round the fuselage loft (`bizjetVisual.ts`): its facets are inside the ellipse by up to 1 - cos(pi / n). */
const FUSELAGE_SEGMENTS = 48;

/** The shell's half-width at a station and height, facet-inscribed; NaN where the height is outside the ring. */
function shellHalfWidth(x: number, y: number): number {
  const section = globalSkinSectionAt(x);
  const u = (y - section.yOffset) / section.yRadius;
  return Math.abs(u) > 1 ? Number.NaN : section.zRadius * Math.sqrt(1 - u * u) * Math.cos(Math.PI / FUSELAGE_SEGMENTS);
}

export function bizjetPanelFaceX(): number {
  return eye().forward + BIZJET_PANEL.faceAheadOfEye;
}

/** The lip's height: its edge at the face reads minus the catalogue's deck line straight ahead. */
export function bizjetLipY(): number {
  const e = eye();
  return e.up - Math.tan(aircraftSpec("bizjet").cockpitDeckLineDegrees * DEG) * BIZJET_PANEL.faceAheadOfEye;
}

export const BIZJET_GLARESHIELD = Object.freeze({
  /** The lip's aft face, at least. */
  thickness: 0.02,
  /** Its top falls away forward over the board's depth. */
  depth: BIZJET_PANEL.thickness,
  /** ...at least this much steeper than the sight line over the lip. */
  fallBeyondSightDegrees: 3,
});

/**
 * The lip's aft face, as tall as it must be for the wedge's top to fall away from the eye. The sight line over the lip
 * falls tan(deck line) a metre, and a wedge whose top falls less shows its FORWARD corner over the lip, which then is
 * the edge the pilot reads (the 747's lesson): at the fixed 0.02 m that happened past a 14 degree deck line (a 15
 * degree catalogue read 14.89 on the HUD's instrument). So the face grows with the deck line, from 0.02 m, and the
 * board's top, under it, stays under the same sight line.
 */
export function bizjetLipThickness(deckLine: number = aircraftSpec("bizjet").cockpitDeckLineDegrees): number {
  const g = BIZJET_GLARESHIELD;
  return Math.max(g.thickness, g.depth * Math.tan((deckLine + g.fallBeyondSightDegrees) * DEG));
}

/**
 * How wide the lip and the board are: out to the windshield's pillars, and no further than the shell lets them.
 *
 * A glareshield spans the windshields, post to post; beside the pilot the side windows have sills of their own (the
 * lining's), not the deck. Out to the shell instead, the lip would run under the forward side panes' low inboard
 * corners, and the rule would be held by glass at the frame's edge half a metre away rather than by the windshield
 * straight ahead (K1: 11.49 against 3.96 degrees from c252859's eye). The pillars' feet are read off the outline:
 * the windshield's bottom outboard corner on the body.
 */
export function bizjetPanelHalfWidth(): number {
  const faceX = bizjetPanelFaceX();
  const topY = bizjetLipY();
  const widths = [faceX, faceX + BIZJET_PANEL.thickness].map((x) => shellHalfWidth(x, topY));
  if (widths.some((w) => !Number.isFinite(w))) throw new RangeError(`the Global's panel: the shell has no width at y ${topY.toFixed(3)}`);
  const windshield = pane("windshield");
  const pillarFoot = Math.abs(globalBodyPoint(windshield.bottom[windshield.bottom.length - 1]!, 1).z);
  return Math.min(pillarFoot, ...widths.map((w) => w - BIZJET_PANEL.shellMargin));
}

// ---- the screens -------------------------------------------------------------

export const BIZJET_SCREENS = Object.freeze({
  width: 0.22,
  height: 0.15,
  bezel: 0.01,
  /** Centre to centre inside a pair. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /** The screens' top edge reads this far below the lip's underside at the face. */
  belowLipDegrees: 1.5,
  bezelThickness: 0.007,
  screenThickness: 0.003,
});

/** The plane the screens' front stands in: 1 mm in front of the bezel's front face. */
function screenFrontX(): number {
  return bizjetPanelFaceX() - BIZJET_SCREENS.bezelThickness;
}

/** The four screens under the lip: the pilot's pair on the eye's own z, the other pair mirrored. */
export function bizjetScreenPlacements(): readonly { name: string; centre: Vector3 }[] {
  const s = BIZJET_SCREENS;
  const e = eye();
  const underside = Math.atan2(bizjetLipY() - bizjetLipThickness() - e.up, bizjetPanelFaceX() - e.forward) / DEG;
  const top = e.up + Math.tan((underside - s.belowLipDegrees) * DEG) * (screenFrontX() - e.forward);
  const y = top - s.height / 2;
  const x = screenFrontX() + s.screenThickness / 2;
  const out: { name: string; centre: Vector3 }[] = [];
  for (const [seat, z] of [["port", e.right], ["starboard", -e.right]] as const) {
    // Outboard first: the outer screen is the one nearer the wall.
    const outboard = Math.sign(z);
    out.push({ name: `${seat}-outboard`, centre: new Vector3(x, y, z + outboard * (s.pitch / 2)) });
    out.push({ name: `${seat}-inboard`, centre: new Vector3(x, y, z - outboard * (s.pitch / 2)) });
  }
  return out;
}

// ---- what the pages need of this airframe -------------------------------------

/**
 * The airframe constants the pages cannot read off the flight state, from the model's own tables:
 * two engines, and 30 degrees of trailing-edge-down flap (`SURFACE_TRAVEL.bizjet.flap`, the same as
 * the 747's; the Cessna's is 40).
 */
export const BIZJET_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 2, fullFlapDegrees: 30 });

// ---- the builder ------------------------------------------------------------------------------

/** What `buildBizjetCockpit` hands back: the meshes, and the displays' redraw step and its reset. */
export interface BizjetCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /** True when the screens carry a live atlas: false under `NullEngine`, where there is no canvas. */
  readonly displaysLive: boolean;
  /**
   * The next `update` redraws the displays whatever its delta: the visual calls this on ENTERING
   * cockpit view, so the first frame back is not the picture from when the pilot last left.
   */
  invalidateDisplays(): void;
  /**
   * Redraw the displays at `DISPLAY_UPDATE_HZ`. The visual calls this from its `update` ONLY while
   * cockpit view is on, and passes the frame's delta so the counter is the frame's own clock.
   */
  update(state: FlightVisualState, secondsSinceLastUpdate?: number): void;
}

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks them cockpit-only
 * (`configureCockpitOnlyParts`) and registers them, so the rule is applied in one place. `skin` is the
 * caster the flight-deck glass was cast with.
 *
 * FOUR meshes, all static: the board and the window frame's lining on the interior material; the lip on the
 * glareshield's, alone; the four screens; their four bezels.
 */
export function buildBizjetCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: BizjetCockpitMaterials,
  skin: SkinCaster,
): BizjetCockpit {
  const parts: AbstractMesh[] = [];
  const e = eye();

  // THE LINING: one skin panel per strip (a side, or once across the centreline), 2 cm deep about the skin; then the
  // sill caps on the side sills' top rows.
  const lining: AbstractMesh[] = [];
  const sills = new Map<string, { points: Point3[][]; normals: Point3[][] }>();
  for (const strip of bizjetLiningStrips()) {
    const sides: readonly (1 | -1)[] = strip.centre ? [-1] : [-1, 1];
    for (const side of sides) {
      const grid = bizjetLiningGrid(skin, strip, side);
      const name = bizjetLiningMeshName(strip, side);
      sills.set(name, grid);
      lining.push(build.skinPanel(name, grid.points, grid.normals, BIZJET_LINING.proud, BIZJET_LINING.depth, materials.interior, root));
    }
  }
  for (const side of [-1, 1] as const) {
    for (const sill of BIZJET_SILL_CAP.sills) {
      const grid = sills.get(`${side > 0 ? "starboard-" : "port-"}bizjet-lining-${sill}`);
      if (!grid) throw new Error(`the Global's sill cap: no ${sill} was built`);
      const cap = bizjetSillCapGrid(grid);
      lining.push(build.skinPanel(bizjetSillCapMeshName(sill, side), cap.points, cap.normals, BIZJET_SILL_CAP.thickness, 0, materials.interior, root));
    }
  }

  // THE LIP, at the catalogue's deck line, as wide as the shell lets it be there.
  const faceX = bizjetPanelFaceX();
  const halfWidth = bizjetPanelHalfWidth();
  const lipY = bizjetLipY();
  const g = BIZJET_GLARESHIELD;
  const undersideY = lipY - bizjetLipThickness();
  // A WEDGE, its aft face flush with the board's face and its top falling away forward, so from the eye nothing of
  // the glareshield or the board behind it shows over the lip: the lip is the line the pilot reads.
  parts.push(solidPlate(
    build,
    "bizjet-glareshield",
    [
      { x: faceX, y: lipY },
      { x: faceX, y: undersideY },
      { x: faceX + g.depth, y: undersideY },
    ],
    halfWidth * 2,
    glareshieldMaterial(build, "bizjet-glareshield"),
    root,
  ));

  // THE PANEL BOARD, from under the frame up to the lip's underside, as wide as the lip.
  const p = BIZJET_PANEL;
  const bottomY = e.up - p.bottomBelowEye;
  const board = build.box("bizjet-instrument-panel", p.thickness, undersideY - bottomY, halfWidth * 2, materials.interior, root);
  board.position.set(faceX + p.thickness / 2, (bottomY + undersideY) / 2, 0);

  // THE SCREENS AND THEIR BEZELS: two meshes for eight boxes. A screen is a flat glass display on the
  // instrument-face material; its bezel is the marking material, so the night glow reaches it. The bezel's back
  // stands 1 mm inside the board so nothing is coincident, and the screen stands 1 mm proud of the bezel.
  const s = BIZJET_SCREENS;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  for (const { name, centre } of bizjetScreenPlacements()) {
    const screen = build.box(`bizjet-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root);
    screen.position.copyFrom(centre);
    screens.push(screen);
    const bezel = build.box(
      `bizjet-screen-bezel-${name}`, s.bezelThickness, s.height + s.bezel * 2, s.width + s.bezel * 2,
      materials.instrumentMarking, root,
    );
    bezel.position.set(faceX - s.bezelThickness / 2 + 0.001, centre.y, centre.z);
    bezels.push(bezel);
  }
  // EACH SCREEN'S PILOT-FACING FACE GETS ITS OWN SLOT of the display atlas, before the merge bakes
  // the vertex data. The boxes are built in `bizjetScreenPlacements()` order and the slots are in
  // the same order, so slot i belongs to screen i; `tests/render.cockpit-displays.test.ts` holds
  // that pairing by measuring the merged mesh's UVs against each screen's own z.
  const slots = displaySlots(BIZJET_DISPLAYS);
  const atlasWidth = displayAtlasWidth(BIZJET_DISPLAYS);
  const atlasHeight = displayAtlasHeight(BIZJET_DISPLAYS);
  for (const [index, screen] of screens.entries()) {
    remapScreenFaceToSlot(screen as Mesh, slots[index]!, atlasWidth, atlasHeight);
  }
  const screensMesh = build.mergeStatic("bizjet-screens", screens, root);
  parts.push(screensMesh);
  parts.push(build.mergeStatic("bizjet-screen-bezels", bezels, root));

  // THE DISPLAYS THEMSELVES, if this engine has a 2D canvas. Under NullEngine it does not, and the
  // screens keep the flat instrument-face material they were built with (see `displayAtlas.ts`).
  const atlas = createDisplayAtlas(build, BIZJET_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "bizjet-display", atlas);
  }

  // THE BOARD AND THE WINDOW FRAME, one mesh on the interior material: the sills are frame too, not the deck.
  parts.push(build.mergeStatic("bizjet-cockpit-interior", [board, ...lining], root));

  // THE DISPLAYS ARE REDRAWN ON THE SHARED CLOCK (`displayRedrawClock`), not every frame: `update`
  // is only called while cockpit view is on (the visual gates it), 15 a second is as fast as a
  // display needs to move, and the visual invalidates it on entry so a return to the cockpit never
  // shows a stale picture. One redraw of this 880 x 600 atlas costs 2.4 ms median in the live app
  // (1.6 of it the `getImageData` readback), against 3.15 for the 747's 1320 x 600 timed alongside it.
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
      paintDisplays(atlas, displayStateFromVisual(state, BIZJET_DISPLAY_AIRFRAME));
    },
  };
}
