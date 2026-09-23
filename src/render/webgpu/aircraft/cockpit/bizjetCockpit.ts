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
  outlinePoint,
  type BodyPoint,
  type GlobalPaneOutline,
} from "../bizjetGlazing";
import type { AircraftBuildContext } from "../builders";
import { facetMesh, glareshieldMaterial, sculptSolid, solidPlate, type FacetQuad } from "./cockpitPrimitives";
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
 * two cannot disagree). Through part 5's nose it was held to the HIGHEST straight lip that covers no
 * glass the pilot can see (`highestClearLip`), and it stood where the windshield's bottom edge is lowest
 * in the frame, with the sill, window frame on the interior material, filling the rest up to the glass.
 * Part 6's V drops that edge outboard (to -14.8 at az -12, where the rule put the deck line at 15.085
 * and would have cost the pilot's screens half their height; 6b's fillet raised it to -11.9 and the
 * rule to 12.184). So the deck line stays at 10.88 and the glareshield HIDES the V's low outboard
 * corner, as a real glareshield hides a windshield's lower corners, by at most a PINNED PROFILE: 0.3
 * degree straight ahead, 1.6 anywhere (`tests/render.cockpit-bizjet.test.ts`, against the BUILT sills).
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
 * starboard half the port edge's exact negation) and, between them, the centreline at each edge point's station, a
 * member's columns are its two panes' edges, and each sill or crown's columns are the pane and member edges it runs
 * from, joined in azimuth order, so neighbouring strips share whole columns and every sill (every crown) has the same
 * rows.
 *
 * THE POST'S MIDDLE COLUMN is the nose's ridge. Over the windshield the section is a V (phase 3c, part 6), and a chord
 * from one windshield's inboard edge to the other's runs under the ridge (the plane engineer's glass post, on two
 * columns, stood 7.8 mm inside the skin there): the post, and the centre sill's and crown's rows at its foot and head,
 * take the ridge as a column of their own, as the glass post does.
 */
export function bizjetLiningStrips(): readonly BizjetLiningStrip[] {
  const windshield = pane("windshield");
  const forward = pane("forward-side");
  const aft = pane("aft-side");
  const { bottom, top, aftEnd } = BIZJET_LINING;
  const mirror = ([azimuth, elevation]: Angles): Angles => [-azimuth, elevation];

  // THE MEMBERS: PANE_GRID rows along the panes' own side edges; two columns each, and the post a third on the ridge.
  const ridge = (p: BodyPoint): Angles => seen([p[0], 0]);
  const post = paneSide(windshield, 0).map((p) => { const a = seen(p); return [mirror(a), ridge(p), a]; });
  const pillar = paneSide(windshield, 1).map((p, row) => [seen(p), seen(paneSide(forward, 0)[row]!)]);
  const midPost = paneSide(forward, 1).map((p, row) => [seen(p), seen(paneSide(aft, 0)[row]!)]);
  const aftEdge = paneSide(aft, 1);
  const aftEndMember = aftEdge.map((p) => [seen(p), seen([p[0] + aftEnd, p[1]])]);

  // THE EDGES THE SILLS HANG FROM and the crowns stand on, in azimuth order, with which chords are glass.
  const windshieldBottom = paneEdge(windshield, 0);
  const windshieldTop = paneEdge(windshield, 1);
  const postFoot = ridge(outlinePoint(windshield, 0, 0));
  const postHead = ridge(outlinePoint(windshield, 0, 1));
  const centreBottom = [...[...windshieldBottom].reverse().map(mirror), postFoot, ...windshieldBottom];
  const centreTop = [...[...windshieldTop].reverse().map(mirror), postHead, ...windshieldTop];
  // the port windshield's chords, then (past the post's two) the starboard's
  const centreGlass = [...Array.from({ length: PANE_GRID - 1 }, (_, k) => k), ...Array.from({ length: PANE_GRID - 1 }, (_, k) => PANE_GRID + 1 + k)];
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

// ---- the panel, its glareshield and the screens -------------------------------------------------

/**
 * THE DECK AS THE PILOT READS IT, top to bottom (P1a): the glareshield's ROUNDED aft edge, whose silhouette is the deck
 * line; its aft face, a short drop under the round; a COVE turning under it at 45 degrees, facing down and aft, to the
 * panel's face; and the panel's face, LEANED BACK toward the seat. Before it the board was a vertical slab with a flat 1.7
 * degree band flush on top: a box pasted under the glass (P0).
 */
export const BIZJET_PANEL = Object.freeze({
  /**
   * The glareshield's aft face is this far ahead of the eye (it was the board's face, at x 12.55 with the eye at 11.90).
   * It is the deck's nearest plane to the pilot, and the lip rule's `faceX`.
   */
  faceAheadOfEye: 0.65,
  /** The board stands this deep behind its face, measured square to it. */
  thickness: 0.08,
  /** The board runs down to this far under the eye: below the frame at any aspect the lens is used at. */
  bottomBelowEye: 0.58,
  /**
   * Back from vertical, top AWAY from the pilot, about the face's top edge under the cove. The type's panel is fairly
   * upright: at 15 degrees the face's normal is 5.4 degrees off the eye from the centre of the pilot's pair of screens
   * (`tests/render.cockpit-bizjet.test.ts` holds it to 8). Aimed exactly, the face would lean 20.5 degrees, and a face
   * leaned that far reads as a laptop's; that is the one constant to change for it. A screen off the eye's own z reads
   * about 10 degrees further off, in azimuth, whatever the lean.
   */
  leanDegrees: 15,
  /**
   * Kept between the board's and the glareshield's ends and the shell as built, everywhere along the glareshield. On part
   * 6's V the shell narrows fast forward of the face, and this, not the pillars, ends the deck: inboard of the pillars'
   * feet, where the pillar's lining covers the rest.
   */
  shellMargin: 0.05,
});

/**
 * The shell's half-width at a station and height AS BUILT: where a ray from the centreline leaves the fuselage's own
 * triangles, by the caster the glass and the lining were cast with (the narrower side, though the body is symmetric);
 * NaN where it finds none. The section functions (`globalSectionHalfWidth`) describe the loft's rings; between rings,
 * and across a ring's chords, the facets stand inside them, by up to 4 mm where part 6b fillets the V, which is more
 * than a margin can be trusted to within.
 */
function shellHalfWidth(skin: SkinCaster, x: number, y: number): number {
  const sides = ([-1, 1] as const).map((side) => skin.exit({ x, y, z: 0 }, { x: 0, y: 0, z: side })?.distance ?? Number.NaN);
  return Math.min(...sides);
}

/** The glareshield's aft face: the deck's nearest plane to the pilot, and where the lip rule reads the lip. */
export function bizjetPanelFaceX(): number {
  return eye().forward + BIZJET_PANEL.faceAheadOfEye;
}

/**
 * The deck line's height at the aft face: the catalogue's deck line straight ahead. The round's silhouette lies on this
 * same sight line (`bizjetGlareshieldSection`), and a line along z reads one row of the picture wherever along the
 * sight line it stands, so this is the lip as the pilot reads it, though no edge of the solid is here.
 */
export function bizjetLipY(): number {
  const e = eye();
  return e.up - Math.tan(aircraftSpec("bizjet").cockpitDeckLineDegrees * DEG) * BIZJET_PANEL.faceAheadOfEye;
}

/**
 * THE GLARESHIELD, one convex solid along z: a ROUNDED aft edge, a short aft face under it, a COVE turning under at 45
 * degrees to the panel's face, and the hood over the board, falling forward.
 *
 *  - THE ROUND is tangent to the aft face and to the hood's top, and the catalogue's sight line over the deck
 *    (`cockpitDeckLineDegrees` under the eye) is tangent to it: that tangent is a vertex, so the silhouette the pilot
 *    reads is the deck line exactly, one row of the picture across the frame, and the lip rule is unchanged. Its upper
 *    side faces the sky, so the deck's edge reads as a lit rim.
 *  - THE COVE faces down and aft at 45 degrees, `cove` forward and `cove` down, from the aft face's foot to the panel's
 *    face. A flat underside there was 0.16 m under the eye and never seen; the cove is seen, and it faces the image
 *    light's lower half, so it reads darker than the panel under it by its normal alone: the shade under a glareshield,
 *    from geometry. The panel's face begins at its foot, which is the lowest edge of the deck the pilot reads.
 *  - THE DECK'S EDGE, from the tangent to the cove's foot, reads 2.34 degrees straight ahead (the design's ceiling is
 *    2.5): the radius, the drop and the cove are what it is made of.
 *  - THE HOOD's top falls forward at `hoodFallDegrees`, steeper than the sight line over the round, so nothing of it
 *    shows past the round and it covers no glass. Its underside falls with it from the cove's foot, a plate of one
 *    thickness, so the solid stays convex (the prism `solidPlate` fans needs it) at any depth.
 */
export const BIZJET_GLARESHIELD = Object.freeze({
  radius: 0.0125,
  drop: 0.005,
  /** The cove's run forward, and its fall: 45 degrees. */
  cove: 0.01,
  hoodFallDegrees: 12,
  hoodDepth: 0.18,
  /** Chords round the aft edge, besides the one vertex put on the deck line's tangent. */
  roundSegments: 8,
});

/** The glareshield's section in body x and y, and the points the rest of the deck is placed from. */
export interface BizjetGlareshieldSection {
  /** The prism's outline, convex, in order round it (`solidPlate` winds it). */
  readonly outline: readonly { readonly x: number; readonly y: number }[];
  /** The round's vertices, from the hood's tangent round to the aft face's, the deck line's tangent among them. */
  readonly round: readonly { readonly x: number; readonly y: number }[];
  /** The round's centre. */
  readonly centre: { readonly x: number; readonly y: number };
  /** Where the deck line's sight line touches the round: the silhouette. */
  readonly tangent: { readonly x: number; readonly y: number };
  /** The aft face's foot, where the cove turns under. */
  readonly coveTop: { readonly x: number; readonly y: number };
  /** The cove's foot: the panel's face's top edge, and the lowest edge of the deck the pilot sees. */
  readonly faceTop: { readonly x: number; readonly y: number };
}

export function bizjetGlareshieldSection(deckLine: number = aircraftSpec("bizjet").cockpitDeckLineDegrees): BizjetGlareshieldSection {
  const g = BIZJET_GLARESHIELD;
  const e = eye();
  const aftX = bizjetPanelFaceX();
  const fall = g.hoodFallDegrees * DEG;
  const sight = deckLine * DEG;
  if (!(deckLine < g.hoodFallDegrees)) {
    throw new RangeError(`the Global's hood falls ${g.hoodFallDegrees} degrees, no steeper than the ${deckLine} degree sight line over the deck: its top would show over the round`);
  }
  // THE ROUND: its centre `radius` forward of the aft face and `radius` under the sight line (the line through the eye
  // falling at the deck line, whose upward normal is (sin, cos) of it).
  const cx = aftX + g.radius;
  const cy = e.up - (g.radius + Math.sin(sight) * (cx - e.forward)) / Math.cos(sight);
  const at = (angle: number) => ({ x: cx + g.radius * Math.sin(angle), y: cy + g.radius * Math.cos(angle) });
  // angles from straight up, forward positive: -90 is the aft face's tangent, +fall the hood's
  const angles = Array.from({ length: g.roundSegments + 1 }, (_, k) => fall - ((fall + Math.PI / 2) * k) / g.roundSegments);
  if (sight > -Math.PI / 2 && sight < fall) angles.push(sight);
  angles.sort((a, b) => b - a);
  const round = angles.map(at);
  const coveTop = { x: aftX, y: cy - g.drop };
  const faceTop = { x: aftX + g.cove, y: coveTop.y - g.cove };
  // the hood: its top from the round's forward tangent, its underside from the cove's foot, both falling at `fall`
  const endX = aftX + g.hoodDepth;
  const hoodTop = round[0]!;
  const endTop = { x: endX, y: hoodTop.y - (endX - hoodTop.x) * Math.tan(fall) };
  const endFoot = { x: endX, y: faceTop.y - (endX - faceTop.x) * Math.tan(fall) };
  if (!(endTop.y - endFoot.y >= 0.001)) {
    throw new RangeError(`the Global's hood is ${((endTop.y - endFoot.y) * 1000).toFixed(2)} mm thick: its top meets its underside`);
  }
  return {
    outline: [...(g.drop > 0 ? [coveTop] : []), faceTop, endFoot, endTop, ...round],
    round,
    centre: { x: cx, y: cy },
    tangent: at(sight),
    coveTop,
    faceTop,
  };
}

/**
 * How wide the glareshield's aft part (its round, aft face and cove) and the board are: out to the windshield's pillars,
 * and no nearer the shell as built than `shellMargin` where they stand, at the round's top, the cove's foot and the
 * board's top back corner. The hood forward of them is TAPERED in plan to the shell (`bizjetHoodTaper`): on part 6's V
 * the shell at the hood's forward end is narrower than the deck, and the hood cannot be seen from the seat.
 *
 * A glareshield spans the windshields, post to post; beside the pilot the side windows have sills of their own (the
 * lining's), not the deck. Out to the shell instead, the lip would run under the forward side panes' low inboard
 * corners, and the rule would be held by glass at the frame's edge half a metre away rather than by the windshield
 * straight ahead (K1: 11.49 against 3.96 degrees from c252859's eye). The pillars' feet are read off the outline:
 * the windshield's bottom outboard corner on the body.
 */
export function bizjetPanelHalfWidth(skin: SkinCaster): number {
  const faceX = bizjetPanelFaceX();
  const section = bizjetGlareshieldSection();
  const topY = section.tangent.y;
  const lean = BIZJET_PANEL.leanDegrees * DEG;
  const boardBack = { x: section.faceTop.x + BIZJET_PANEL.thickness * Math.cos(lean), y: section.faceTop.y - BIZJET_PANEL.thickness * Math.sin(lean) };
  const aftEnd = Math.max(section.faceTop.x, section.round[0]!.x);
  const stations: [number, number][] = [[faceX, topY], [aftEnd, topY], [faceX, section.faceTop.y], [boardBack.x, section.faceTop.y], [boardBack.x, boardBack.y]];
  const widths = stations.map(([x, y]) => shellHalfWidth(skin, x, y));
  if (widths.some((w) => !Number.isFinite(w))) throw new RangeError(`the Global's panel: the shell has no width at y ${topY.toFixed(3)}`);
  // the windshield's bottom outboard corner as the glass is built: CAST from R onto the skin, as the pane and the pillar's
  // lining are (on 6b's V the outline's own point stands 4.5 mm outboard of the facets it is cast onto)
  const windshield = pane("windshield");
  const [cornerAzimuth, cornerElevation] = seen(windshield.bottom[windshield.bottom.length - 1]!);
  const corner = skin.exit(GLOBAL_FLIGHT_DECK_REFERENCE, sightline(cornerAzimuth, cornerElevation, 1));
  if (!corner) throw new RangeError("the Global's panel: the windshield's bottom outboard corner casts onto no skin");
  const pillarFoot = Math.abs(corner.point.z);
  return Math.min(pillarFoot, ...widths.map((w) => w - BIZJET_PANEL.shellMargin));
}

/**
 * THE HOOD'S TAPER IN PLAN. Forward of the round and the cove the glareshield is the hood, and its forward end draws in
 * from the deck's half-width to stay `shellMargin` inside the shell as built, straight in plan from where the hood
 * starts (`from`) to its end (`to`): a plane cut, so the solid stays convex (`sculptSolid` needs it). The end's
 * half-width is the widest that keeps the whole straight edge inside the margin at every station along it, at the hood's
 * top (the V narrows upward) and its underside.
 */
export function bizjetHoodTaper(skin: SkinCaster, halfWidth: number): { from: number; to: number; endHalfWidth: number } {
  const section = bizjetGlareshieldSection();
  const g = BIZJET_GLARESHIELD;
  const from = Math.max(section.faceTop.x, section.round[0]!.x);
  const to = bizjetPanelFaceX() + g.hoodDepth;
  const fall = Math.tan(g.hoodFallDegrees * DEG);
  const topAt = (x: number) => section.round[0]!.y - (x - section.round[0]!.x) * fall;
  const footAt = (x: number) => section.faceTop.y - (x - section.faceTop.x) * fall;
  let end = halfWidth;
  for (let k = 1; k <= 24; k += 1) {
    const x = from + ((to - from) * k) / 24;
    const t = (x - from) / (to - from);
    const allowed = Math.min(shellHalfWidth(skin, x, topAt(x)), shellHalfWidth(skin, x, footAt(x))) - BIZJET_PANEL.shellMargin;
    if (!Number.isFinite(allowed)) throw new RangeError(`the Global's hood: no shell at x ${x.toFixed(3)}`);
    end = Math.min(end, halfWidth + (allowed - halfWidth) / t);
  }
  if (!(end > 0.1)) throw new RangeError(`the Global's hood: the shell leaves its forward end ${end.toFixed(3)} m wide`);
  return { from, to, endHalfWidth: end };
}

/**
 * The panel's face, leaned back by `leanDegrees` about its top edge at the cove's foot: that edge, the unit vector UP the
 * face, and the face's unit normal toward the pilot (aft and up), all in body x and y.
 */
export function bizjetPanelFace(): { top: { x: number; y: number }; up: { x: number; y: number }; normal: { x: number; y: number }; bottomY: number } {
  const lean = BIZJET_PANEL.leanDegrees * DEG;
  return {
    top: bizjetGlareshieldSection().faceTop,
    up: { x: Math.sin(lean), y: Math.cos(lean) },
    normal: { x: -Math.cos(lean), y: Math.sin(lean) },
    bottomY: eye().up - BIZJET_PANEL.bottomBelowEye,
  };
}

// ---- the screens -------------------------------------------------------------

export const BIZJET_SCREENS = Object.freeze({
  width: 0.22,
  height: 0.15,
  /** The bezel's rim beyond the screen: the dark gap, then the bezel's flat face, then its chamfer. */
  bezel: 0.01,
  /** Centre to centre inside a pair. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /** The screens' top edge reads this far below the cove's foot (the lowest edge of the deck the pilot sees). */
  belowDeckEdgeDegrees: 0.8,
  /** The bezel's front stands this far out of the board's face; its back is 1 mm inside it, so nothing is coincident. */
  bezelThickness: 0.007,
  /** The chamfer round the bezel's outer edge: this wide across the face and this deep, at 45 degrees. */
  chamfer: 0.004,
  /** Between the bezel's inner edge and the screen: a dark well, the screen's surround. */
  gap: 0.002,
  /** The screen's face stands this far BEHIND the bezel's front: the bezel is a frame round it, not a plate under it. */
  recess: 0.003,
  /** The screen is a thin plate: its sides stand in the well and show nothing. */
  screenThickness: 0.0005,
  /** The well's floor behind the gap, straddling the board's face. */
  wellThickness: 0.001,
});

/** How far out of the board's face each plane of a screen's stack stands, square to the face (the board's face is 0). */
export function bizjetScreenStack(): { bezelBack: number; bezelFront: number; chamferFoot: number; screenFront: number; screenBack: number } {
  const s = BIZJET_SCREENS;
  const bezelBack = -0.001;
  const bezelFront = bezelBack + s.bezelThickness;
  const screenFront = bezelFront - s.recess;
  return { bezelBack, bezelFront, chamferFoot: bezelFront - s.chamfer, screenFront, screenBack: screenFront - s.screenThickness };
}

/**
 * The four screens on the leaned face: the pilot's pair on the eye's own z, the other pair mirrored. `centre` is the
 * screen plate's; `faceCentre` is the same point on the board's face, where the bezel and the well are laid out from.
 * The screen plate is turned back by the lean about z.
 */
export function bizjetScreenPlacements(): readonly { name: string; centre: Vector3; faceCentre: Vector3 }[] {
  const s = BIZJET_SCREENS;
  const stack = bizjetScreenStack();
  const e = eye();
  const face = bizjetPanelFace();
  const along = (h: number, out: number) => ({ x: face.top.x + h * face.up.x + out * face.normal.x, y: face.top.y + h * face.up.y + out * face.normal.y });
  // the screen's front top edge, as far up the face (h) as puts it `belowDeckEdgeDegrees` under the deck's edge: a line
  // along z reads one row wherever it is, so the row is the slope (y - eye.y) / (x - eye.x)
  const slope = Math.tan(Math.atan2(face.top.y - e.up, face.top.x - e.forward) - s.belowDeckEdgeDegrees * DEG);
  const front = along(0, stack.screenFront);
  const h = (slope * (front.x - e.forward) - (front.y - e.up)) / (face.up.y - slope * face.up.x);
  const screen = along(h - s.height / 2, (stack.screenFront + stack.screenBack) / 2);
  const onFace = along(h - s.height / 2, 0);
  const out: { name: string; centre: Vector3; faceCentre: Vector3 }[] = [];
  for (const [seat, z] of [["port", e.right], ["starboard", -e.right]] as const) {
    // Outboard first: the outer screen is the one nearer the wall.
    const outboard = Math.sign(z);
    for (const [which, offset] of [["outboard", outboard], ["inboard", -outboard]] as const) {
      const at = z + offset * (s.pitch / 2);
      out.push({ name: `${seat}-${which}`, centre: new Vector3(screen.x, screen.y, at), faceCentre: new Vector3(onFace.x, onFace.y, at) });
    }
  }
  return out;
}

/**
 * A screen's bezel as flat quads about `faceCentre` on the leaned face, in two CLOSED solids that meet along the chamfer's
 * shoulder: `frame`, a ring from the opening (the screen and its gap) out to the shoulder, its flat front toward the
 * pilot; and `rim`, the band from the shoulder out to the bezel's edge, whose front is the 45 degree chamfer. Each is
 * closed on its own, so wherever a ray meets either first it meets a face the GPU draws (the faces where they meet
 * face each other inside the bezel and are never seen); the rim is apart so the night glow can be on it alone.
 */
export function bizjetBezelFacets(faceCentre: Vector3): { frame: FacetQuad[]; rim: FacetQuad[] } {
  const s = BIZJET_SCREENS;
  const stack = bizjetScreenStack();
  const face = bizjetPanelFace();
  const across = new Vector3(0, 0, 1);
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  const at = (u: number, v: number, o: number) => faceCentre.add(across.scale(u)).add(up.scale(v)).add(out.scale(o));
  // a rectangle's corners, bottom-left round to top-left, and each side's outward direction in the face
  const rect = (x: number, y: number, o: number) => [at(-x, -y, o), at(x, -y, o), at(x, y, o), at(-x, y, o)];
  const sides = [up.scale(-1), across, up, across.scale(-1)];
  const ring = (a: Vector3[], b: Vector3[], normal: (k: number) => Vector3): FacetQuad[] =>
    [0, 1, 2, 3].map((k) => ({ corners: [a[k]!, a[(k + 1) % 4]!, b[(k + 1) % 4]!, b[k]!] as const, normal: normal(k) }));
  const opening = (o: number) => rect(s.width / 2 + s.gap, s.height / 2 + s.gap, o);
  const shoulder = (o: number) => rect(s.width / 2 + s.bezel - s.chamfer, s.height / 2 + s.bezel - s.chamfer, o);
  const edge = (o: number) => rect(s.width / 2 + s.bezel, s.height / 2 + s.bezel, o);
  const { bezelFront: front, bezelBack: back, chamferFoot: foot } = stack;
  return {
    frame: [
      ...ring(opening(front), shoulder(front), () => out),
      ...ring(shoulder(front), shoulder(back), (k) => sides[k]!),
      ...ring(opening(back), shoulder(back), () => out.scale(-1)),
      ...ring(opening(back), opening(front), (k) => sides[k]!.scale(-1)),
    ],
    rim: [
      // the chamfer runs as far across the face as it falls toward it: its normal is halfway between the side's and the face's
      ...ring(shoulder(front), edge(foot), (k) => sides[k]!.add(out).normalize()),
      ...ring(edge(foot), edge(back), (k) => sides[k]!),
      ...ring(shoulder(back), edge(back), () => out.scale(-1)),
      ...ring(shoulder(back), shoulder(front), (k) => sides[k]!.scale(-1)),
    ],
  };
}

/**
 * The Global's bezels' own material: a dark neutral grey, the board's roughness and metalness, NOT emissive, lighter
 * than the board by albedo alone (1.3 to 1.6 times its luma in the level frame, the design's range). On the marking
 * material, which carries the night glow, the bezels read 81 against the board's 28 by day (P0). The glow stays on the
 * chamfer, which is on the marking material still.
 */
export const BIZJET_BEZEL_ALBEDO = 0x2c3034;
export function bizjetBezelMaterial(build: AircraftBuildContext): PBRMaterial {
  return build.material("bizjet-bezel", BIZJET_BEZEL_ALBEDO, { roughness: 0.82, metallic: 0.02 });
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
 * SIX meshes, all static: the board and the window frame's lining on the interior material; the glareshield on its
 * own, alone; the four screens; their four bezels' frames; the frames' chamfered rims; the wells behind the screens.
 */
export function buildBizjetCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: BizjetCockpitMaterials,
  skin: SkinCaster,
): BizjetCockpit {
  const parts: AbstractMesh[] = [];

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

  // THE GLARESHIELD, its round's silhouette on the catalogue's deck line, as wide as the pillars and the shell let it be;
  // the hood forward of the round and the cove tapered in plan to the shell (`bizjetHoodTaper`).
  const halfWidth = bizjetPanelHalfWidth(skin);
  const glareshield = solidPlate(build, "bizjet-glareshield", bizjetGlareshieldSection().outline, halfWidth * 2, glareshieldMaterial(build, "bizjet-glareshield"), root);
  const taper = bizjetHoodTaper(skin, halfWidth);
  sculptSolid(glareshield, (point) => {
    const t = Math.min(1, Math.max(0, (point.x - taper.from) / (taper.to - taper.from)));
    return new Vector3(point.x, point.y, point.z * (1 + (taper.endHalfWidth / halfWidth - 1) * t));
  });
  parts.push(glareshield);

  // THE PANEL BOARD, its face leaned back from its top edge at the cove's foot down past the frame's bottom, as wide as the
  // glareshield. A box turned back about z (its local X is its thickness, away from the pilot; its local Y runs up the face).
  const p = BIZJET_PANEL;
  const face = bizjetPanelFace();
  const lean = p.leanDegrees * DEG;
  const faceLength = (face.top.y - face.bottomY) / Math.cos(lean);
  const board = build.box("bizjet-instrument-panel", p.thickness, faceLength, halfWidth * 2, materials.interior, root);
  board.position.set(
    face.top.x - (faceLength / 2) * face.up.x - (p.thickness / 2) * face.normal.x,
    face.top.y - (faceLength / 2) * face.up.y - (p.thickness / 2) * face.normal.y,
    0,
  );
  board.rotation.z = -lean;

  // THE SCREENS, THEIR BEZELS AND THEIR WELLS: four meshes, turned back with the face. A screen is a thin glass plate on
  // the instrument-face material (the display's, where there is a canvas), RECESSED behind its bezel's front; the bezel
  // is a frame round it on the bezels' own material, its chamfered rim on the marking material, so the night glow is the
  // rim's; behind the gap between them, a well on the instrument-face material, dark.
  const s = BIZJET_SCREENS;
  const screens: AbstractMesh[] = [];
  const frames: AbstractMesh[] = [];
  const rims: AbstractMesh[] = [];
  const wells: AbstractMesh[] = [];
  const bezelMaterial = bizjetBezelMaterial(build);
  for (const { name, centre, faceCentre } of bizjetScreenPlacements()) {
    const screen = build.box(`bizjet-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root);
    screen.position.copyFrom(centre);
    screen.rotation.z = -lean;
    screens.push(screen);
    const facets = bizjetBezelFacets(faceCentre);
    frames.push(facetMesh(build, `bizjet-screen-bezel-${name}`, facets.frame, bezelMaterial, root));
    rims.push(facetMesh(build, `bizjet-screen-bezel-rim-${name}`, facets.rim, materials.instrumentMarking, root));
    const well = build.box(`bizjet-screen-well-${name}`, s.wellThickness, s.height + s.gap * 2, s.width + s.gap * 2, materials.instrumentFace, root);
    well.position.copyFrom(faceCentre);
    well.rotation.z = -lean;
    wells.push(well);
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
  parts.push(build.mergeStatic("bizjet-screen-bezels", frames, root));
  parts.push(build.mergeStatic("bizjet-screen-bezel-rims", rims, root));
  parts.push(build.mergeStatic("bizjet-screen-wells", wells, root));

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
