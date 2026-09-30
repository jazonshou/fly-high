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
import {
  facetMesh,
  framedScreenStack,
  glareshieldMaterial,
  roundedDeckSection,
  roundedBox,
  roundedCylinder,
  sculptSolid,
  smoothRoundNormals,
  smoothSheet,
  solidPlate,
  sweptSolid,
  type FacetQuad,
  type SweptSection,
  type RoundedDeckSection,
} from "./cockpitPrimitives";
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
 * crown's rows; how far it stands out of the skin and in from it; and how many metres of station the aft end member
 * takes.
 *
 * It stands IN from the skin only (S3): 12 mm, and nothing proud. It stood 8 mm proud as well, the 747's 2 cm in all
 * (K3: a deeper lining shows its side as a second, lit face down every pillar), but the glass is hidden from the
 * cockpit, so a strip's outside is never seen, and the part of its rim outside the skin was what a grazing sightline
 * met past the window trim's seal (`BIZJET_WINDOW_TRIM`), which rolls the inner face down to the skin and no further.
 *
 * The bounds are R's, and the eye is not R: they reach past the 16:9 frame's edges from the eye with room,
 * which `tests/render.cockpit-bizjet.test.ts` holds by casting the whole frame (no hidden skin showing).
 */
export const BIZJET_LINING = Object.freeze({ bottom: -40, top: 60, maxStepDegrees: 5, proud: 0, depth: 0.012, aftEnd: 0.1 });

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

// ---- the window trim ---------------------------------------------------------------------------

/**
 * THE WINDOW TRIM (S3): where the lining meets the glass, its inner face ROLLS into the glass on a round and a seal
 * instead of stopping square. Through S4 every strip ended at a pane's edge in its rim, a face square to the inner face
 * (P0: 1,823 px of 90-degree creases at 1600 x 900), and that rim was what the eye saw against the glass (4,890 px).
 *
 * THE SECTION, across a pane's edge: `a` into the pane along the skin, `h` in from the skin along its normal, the
 * strip's inner face at h = `BIZJET_LINING.depth`. From the inner face the trim turns on the `round` (the members'
 * rounded section, the lining's material) through `roundDegrees`, and then on the `bead` (the SEAL, the glareshield's
 * matte) on down to the skin, where the glass is: tangent all the way, so from the inner face to the glass the eye
 * meets no crease. The round hands over at 35 degrees because the seal must be the last thing the eye sees before
 * the glass on EVERY edge, and a sightline grazes the section where its normal is square to it: from the seat that is
 * at 40 degrees at the least (the starboard windshield's inboard edge, which rolls away from the eye) and 166 at the
 * most (the port windshield's bottom, which faces it). The trim stands on the pane's side of its edge, over the
 * strip's rim, which it hides, and reaches `a` = 11.2 mm into the pane at the most.
 *
 * CORNERS are rounded on `corner` (in the skin at the corner) and the trim swept round the arc; the pocket between the
 * arc and the pane's own corner is filled flush with the inner face. The side panes' bottom edges are the exception:
 * the sill cap makes a LEDGE there, level with the edge (the rim of the sill under it is the ledge's outer strip), so
 * the glass meets it in an inside corner and the seal is a concave `cove`, from the ledge up to the glass. The members'
 * trim runs down to those corners and stops there, capped, as does the cove: from the seat the ledge and the cove hide
 * both ends (carrying the runs on into the sill changed none of 90,601 rays over the pillar's foot).
 *
 * THE SEAL IS A CLOSED TUBE (`bizjetSealSections`): the bead's arc and a flat back under the round, the cove's arc and its
 * two legs on the ledge and the glass, capped where a run ends. An open sheet would show its inside to a ray that
 * reaches it through the lining, which no pixel sees but `tests/render.cockpit-drawn-faces.test.ts` does, rightly: a
 * part's nearest face must be one the GPU draws. The round needs no back: the lining's slab is in front of its inside.
 */
export const BIZJET_WINDOW_TRIM = Object.freeze({
  round: 0.015,
  roundDegrees: 35,
  bead: 0.006,
  cove: 0.006,
  corner: 0.025,
  stepDegrees: 10,
  cornerStepDegrees: 15,
});

/** A point of the trim's section: `a` into the pane, `h` in from the skin, and its normal's turn from the inner face's. */
export interface BizjetTrimPoint {
  readonly a: number;
  readonly h: number;
  readonly degrees: number;
}

function trimArc(centre: { a: number; h: number }, radius: number, from: number, to: number): BizjetTrimPoint[] {
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) / DEG / BIZJET_WINDOW_TRIM.stepDegrees));
  return Array.from({ length: steps + 1 }, (_, k) => {
    const phi = from + ((to - from) * k) / steps;
    return { a: centre.a + radius * Math.sin(phi), h: centre.h + radius * Math.cos(phi), degrees: phi / DEG };
  });
}

/**
 * The trim's section: the ROUND from the inner face's edge (its first point exactly that edge), and the BEAD from the
 * round's last point (exactly it) down to the skin, where its normal has turned `degrees` from the inner face's. A
 * point's normal is `into` x sin + (-skin normal) x cos of its turn.
 */
export function bizjetTrimSection(): { round: BizjetTrimPoint[]; bead: BizjetTrimPoint[]; centres: { round: { a: number; h: number }; bead: { a: number; h: number } } } {
  const { round, roundDegrees, bead } = BIZJET_WINDOW_TRIM;
  const depth = BIZJET_LINING.depth;
  const turn = roundDegrees * DEG;
  const roundCentre = { a: 0, h: depth - round };
  const beadCentre = { a: (round - bead) * Math.sin(turn), h: roundCentre.h + (round - bead) * Math.cos(turn) };
  // the bead meets the skin where its height has run down to nothing
  const endCos = -beadCentre.h / bead;
  if (!(endCos > -1 && endCos < Math.cos(turn))) throw new RangeError("the Global's window trim: the bead does not reach the skin past the round");
  const roundPoints = trimArc(roundCentre, round, 0, turn);
  roundPoints[0] = { a: 0, h: depth, degrees: 0 };
  const beadPoints = trimArc(beadCentre, bead, turn, Math.acos(endCos));
  beadPoints[0] = roundPoints.at(-1)!;
  beadPoints[beadPoints.length - 1] = { ...beadPoints.at(-1)!, h: 0 };
  return { round: roundPoints, bead: beadPoints, centres: { round: roundCentre, bead: beadCentre } };
}

/**
 * The COVE seal's section on a ledge: tangent to the ledge (a = 0, its normal `into` the pane: a turn of 90 degrees)
 * `cove` in from the skin, round to tangent to the glass (h = 0, its normal into the cabin: a turn of 0) `cove` into
 * the pane. Concave: its centre is in the open corner, at (cove, cove).
 */
export function bizjetCoveSection(): BizjetTrimPoint[] {
  const c = BIZJET_WINDOW_TRIM.cove;
  return trimArc({ a: c, h: c }, -c, Math.PI / 2, 0).map((p, k, all) => (k === 0 ? { ...p, a: 0 } : k === all.length - 1 ? { ...p, h: 0 } : p));
}

/** A closed section for a seal's sweep: its LOOP (the arc shaded as it turns, then its back's corners, each with its own face's normal), and the fan that caps it. */
export interface BizjetSealSection {
  readonly loop: readonly BizjetTrimPoint[];
  readonly cap: { readonly pivot: { readonly a: number; readonly h: number }; readonly rim: readonly BizjetTrimPoint[] };
}

/** The turn of a flat face's normal from `from` to `to` in the section, pointed away from `away`. */
function faceTurn(from: { a: number; h: number }, to: { a: number; h: number }, away: { a: number; h: number }): number {
  let na = to.h - from.h;
  let nh = -(to.a - from.a);
  if (na * (away.a - (from.a + to.a) / 2) + nh * (away.h - (from.h + to.h) / 2) > 0) {
    na = -na;
    nh = -nh;
  }
  return Math.atan2(na, nh) / DEG;
}

/**
 * The seals' closed sections. The BEAD: its arc, then a flat back from the arc's end on the skin up to its start at the
 * round, under the round (a D, capped by a fan from the back's middle). The COVE: its arc from the ledge to the glass,
 * then its legs along the glass and up the ledge to the corner between them (capped by a fan from that corner).
 */
export function bizjetSealSections(): { bead: BizjetSealSection; cove: BizjetSealSection } {
  const arc = bizjetTrimSection().bead;
  const start = arc[0]!;
  const end = arc.at(-1)!;
  const back = faceTurn(end, start, arc[Math.floor(arc.length / 2)]!);
  const coveArc = bizjetCoveSection();
  const top = coveArc[0]!;
  const foot = coveArc.at(-1)!;
  const corner = { a: 0, h: 0 };
  const glassLeg = faceTurn(foot, corner, top);
  const ledgeLeg = faceTurn(corner, top, foot);
  return {
    bead: {
      loop: [...arc, { a: end.a, h: end.h, degrees: back }, { a: start.a, h: start.h, degrees: back }],
      cap: { pivot: { a: (start.a + end.a) / 2, h: (start.h + end.h) / 2 }, rim: arc },
    },
    cove: {
      loop: [...coveArc, { a: foot.a, h: foot.h, degrees: glassLeg }, { ...corner, degrees: glassLeg }, { ...corner, degrees: ledgeLeg }, { a: top.a, h: top.h, degrees: ledgeLeg }],
      cap: { pivot: corner, rim: coveArc },
    },
  };
}

/** A pane's edge as the lining casts it, corner to corner: the strip's own grid points on the skin and their normals. */
export interface BizjetPaneEdge {
  readonly points: readonly Point3[];
  readonly normals: readonly Point3[];
  /** The edge runs along a sill cap (a side pane's bottom): its seal is the cove. */
  readonly ledge: boolean;
}

/**
 * Every pane's four edges, in loop order: the bottom inboard to outboard, the outboard side up, the top back inboard,
 * the inboard side down. Each is READ from the strips' grids as built (`grids`, by mesh name), so the trim starts
 * exactly on each strip's inner-face edge; neighbouring edges share their corner to the last bit (checked).
 */
export function bizjetPaneEdges(
  grids: ReadonlyMap<string, { readonly points: readonly (readonly Point3[])[]; readonly normals: readonly (readonly Point3[])[] }>,
): { name: string; side: 1 | -1; edges: BizjetPaneEdge[] }[] {
  type Run = { points: Point3[]; normals: Point3[] };
  const strips = bizjetLiningStrips();
  const grid = (name: string, side: 1 | -1) => {
    const found = grids.get(bizjetLiningMeshName(strips.find((s) => s.name === name)!, side));
    if (!found) throw new Error(`the Global's window trim: no ${name} was built`);
    return found;
  };
  const column = (g: ReturnType<typeof grid>, k: number): Run => ({ points: g.points.map((r) => r[k]!), normals: g.normals.map((r) => r[k]!) });
  const row = (g: ReturnType<typeof grid>, r: number, from: number, to?: number): Run => ({
    points: g.points.at(r)!.slice(from, to),
    normals: g.normals.at(r)!.slice(from, to),
  });
  const reversed = (run: Run): Run => ({ points: [...run.points].reverse(), normals: [...run.normals].reverse() });
  const slice = (run: Run, from: number, to?: number): Run => ({ points: run.points.slice(from, to), normals: run.normals.slice(from, to) });
  const edge = (run: Run, ledge = false): BizjetPaneEdge => ({ ...run, ledge });
  const g = PANE_GRID;
  const panes: { name: string; side: 1 | -1; edges: BizjetPaneEdge[] }[] = [];
  for (const side of [-1, 1] as const) {
    // the centre strips are cast on the port side: the port windshield is their columns past the post's middle, the
    // starboard one (mirrored) the columns before it, which run outboard to inboard
    const half = (run: Run): Run => (side < 0 ? slice(run, g + 1) : reversed(slice(run, 0, g)));
    panes.push({ name: "windshield", side, edges: [
      edge(half(row(grid("sill-centre", -1), -1, 0))),
      edge(column(grid("pillar", side), 0)),
      edge(reversed(half(row(grid("crown-centre", -1), 0, 0)))),
      edge(reversed(column(grid("post", -1), side < 0 ? 2 : 0))),
    ] });
    panes.push({ name: "forward-side", side, edges: [
      edge(row(grid("sill-forward-side", side), -1, 1), true),
      edge(column(grid("mid-post", side), 0)),
      edge(reversed(row(grid("crown-forward-side", side), 0, 1))),
      edge(reversed(column(grid("pillar", side), 1))),
    ] });
    panes.push({ name: "aft-side", side, edges: [
      edge(row(grid("sill-aft-side", side), -1, 1, g + 1), true),
      edge(column(grid("aft-end", side), 0)),
      edge(reversed(row(grid("crown-aft-side", side), 0, 1, g + 1))),
      edge(reversed(column(grid("mid-post", side), 1))),
    ] });
  }
  for (const pane of panes) {
    pane.edges.forEach((e, k) => {
      const end = e.points.at(-1)!;
      const start = pane.edges[(k + 1) % pane.edges.length]!.points[0]!;
      if (end.x !== start.x || end.y !== start.y || end.z !== start.z) {
        throw new Error(`the Global's window trim: the ${pane.name} pane's edges ${k} and ${(k + 1) % 4} do not share their corner`);
      }
    });
  }
  return panes;
}

/** A place along the trim: a point on the skin, the skin's outward normal there, and the trim's direction of run. */
interface TrimStation {
  readonly at: Vector3;
  readonly normal: Vector3;
  readonly along: Vector3;
}

const v3 = (p: Point3) => new Vector3(p.x, p.y, p.z);

/**
 * The stations along a run of a pane's edges, rounded on `corner` at every join between two of them: at the strips'
 * own grid points between the corners, and round each corner's arc (from its tangent point on the chord into the
 * corner, in the plane of the two chords there, to its tangent point on the chord out). Closed: the run is the whole
 * loop, and its first station is repeated at its end. Open: it runs from its first point to its last.
 *
 * Returns the stations, and each corner's POCKET: its apex (the pane's own corner) and the arc's stations, whose fan
 * fills the inner face over the corner of the glass the arc cuts off.
 */
function trimStations(edges: readonly BizjetPaneEdge[], closed: boolean): { stations: TrimStation[]; pockets: { apex: TrimStation; arc: TrimStation[] }[] } {
  const { corner: radius, cornerStepDegrees } = BIZJET_WINDOW_TRIM;
  const points: Vector3[] = [];
  const normals: Vector3[] = [];
  const corners: number[] = [];
  edges.forEach((e, k) => {
    if (k > 0) corners.push(points.length - 1);
    e.points.forEach((p, j) => {
      if (k > 0 && j === 0) return;
      points.push(v3(p));
      normals.push(v3(e.normals[j]!).normalize());
    });
  });
  if (closed) {
    points.pop();
    normals.pop();
    corners.unshift(0);
  }
  const n = points.length;
  const at = (i: number) => points[((i % n) + n) % n]!;
  const normalAt = (i: number) => normals[((i % n) + n) % n]!;
  const vertex = (i: number): TrimStation => {
    const before = closed || i > 0 ? at(i - 1) : at(i);
    const after = closed || i < n - 1 ? at(i + 1) : at(i);
    return { at: at(i), normal: normalAt(i), along: after.subtract(before).normalize() };
  };
  const arcs = new Map<number, TrimStation[]>();
  const pockets: { apex: TrimStation; arc: TrimStation[] }[] = [];
  for (const m of corners) {
    const k = at(m);
    const toPrevious = at(m - 1).subtract(k);
    const toNext = at(m + 1).subtract(k);
    const u1 = toPrevious.normalizeToNew();
    const u2 = toNext.normalizeToNew();
    const half = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(u1, u2)))) / 2;
    const reach = radius / Math.tan(half);
    if (!(reach <= 0.8 * Math.min(toPrevious.length(), toNext.length()))) {
      throw new RangeError(`the Global's window trim: a ${(half * 2) / DEG} degree corner cannot take a ${radius} m round on its chords`);
    }
    const s1 = reach / toPrevious.length();
    const s2 = reach / toNext.length();
    const n1 = Vector3.Lerp(normalAt(m), normalAt(m - 1), s1).normalize();
    const n2 = Vector3.Lerp(normalAt(m), normalAt(m + 1), s2).normalize();
    const centre = k.add(u1.add(u2).normalize().scale(radius / Math.sin(half)));
    const w1 = k.add(u1.scale(reach)).subtract(centre).scale(1 / radius);
    const w2 = k.add(u2.scale(reach)).subtract(centre).scale(1 / radius);
    const turn = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(w1, w2))));
    const steps = Math.max(2, Math.ceil(turn / DEG / cornerStepDegrees));
    const arc: TrimStation[] = [];
    for (let j = 0; j <= steps; j += 1) {
      const f = j / steps;
      const w = w1.scale(Math.sin((1 - f) * turn)).add(w2.scale(Math.sin(f * turn))).scale(1 / Math.sin(turn));
      const along = w1.scale(-Math.cos((1 - f) * turn)).add(w2.scale(Math.cos(f * turn))).normalize();
      arc.push({ at: centre.add(w.scale(radius)), normal: Vector3.Lerp(n1, n2, f).normalize(), along });
    }
    arcs.set(m, arc);
    pockets.push({ apex: vertex(m), arc });
  }
  const stations: TrimStation[] = [];
  if (closed) {
    for (let c = 0; c < corners.length; c += 1) {
      stations.push(...arcs.get(corners[c]!)!);
      const next = c + 1 < corners.length ? corners[c + 1]! : n;
      for (let i = corners[c]! + 1; i < next; i += 1) stations.push(vertex(i));
    }
    stations.push(stations[0]!);
  } else {
    for (let i = 0; i < n; i += 1) {
      if (arcs.has(i)) stations.push(...arcs.get(i)!);
      else stations.push(vertex(i));
    }
  }
  return { stations, pockets };
}

/**
 * A section swept through stations as a smooth sheet's grid: each point `a` along the station's INTO (square to the
 * skin normal and the run, turned toward the pane's middle, `inside`) and `h` in from the skin, shaded with the
 * section's normal there.
 */
function trimGrid(stations: readonly TrimStation[], section: readonly BizjetTrimPoint[], inside: Vector3): { points: Vector3[][]; normals: Vector3[][]; into: Vector3[] } {
  const points: Vector3[][] = [];
  const normals: Vector3[][] = [];
  const intos: Vector3[] = [];
  let sign = 0;
  for (const s of stations) {
    let into = Vector3.Cross(s.normal, s.along).normalize();
    const facing = Math.sign(Vector3.Dot(into, inside.subtract(s.at)));
    if (sign === 0) sign = facing;
    if (facing !== sign) throw new Error("the Global's window trim: a station's inward side flips along its run");
    into = into.scale(sign);
    intos.push(into);
    points.push(section.map((p) => s.at.add(into.scale(p.a)).subtract(s.normal.scale(p.h))));
    normals.push(section.map((p) => into.scale(Math.sin(p.degrees * DEG)).subtract(s.normal.scale(Math.cos(p.degrees * DEG)))));
  }
  return { points, normals, into: intos };
}

/** A fan closing a seal's run at a station, flat, facing `outward` along the run. */
function trimCap(station: TrimStation, into: Vector3, cap: BizjetSealSection["cap"], outward: Vector3): { points: Vector3[][]; normals: Vector3[][] } {
  const place = (p: { a: number; h: number }) => station.at.add(into.scale(p.a)).subtract(station.normal.scale(p.h));
  const pivot = place(cap.pivot);
  return { points: [cap.rim.map(() => pivot), cap.rim.map(place)], normals: [cap.rim.map(() => outward), cap.rim.map(() => outward)] };
}

/**
 * THE WINDOW TRIM's meshes for every pane: the rounds and the pockets' fills (the lining's material) and the seals (the
 * glareshield's), by name `<side>-bizjet-trim-<pane>` (`-pocket-<k>`) and `<side>-bizjet-seal-<pane>` (`-cove`).
 */
export function buildBizjetWindowTrim(
  build: AircraftBuildContext,
  root: TransformNode,
  grids: ReadonlyMap<string, { readonly points: readonly (readonly Point3[])[]; readonly normals: readonly (readonly Point3[])[] }>,
  trimMaterial: PBRMaterial,
  sealMaterial: PBRMaterial,
): { trim: Mesh[]; seals: Mesh[] } {
  const section = bizjetTrimSection();
  const sealSections = bizjetSealSections();
  const depth = BIZJET_LINING.depth;
  const trim: Mesh[] = [];
  const seals: Mesh[] = [];
  // a seal's run as a closed tube, and on an open run a cap at each end
  const seal = (name: string, stations: readonly TrimStation[], closed: BizjetSealSection, inside: Vector3, open: boolean) => {
    const tube = trimGrid(stations, closed.loop, inside);
    const parts = [smoothSheet(build, name, tube.points, tube.normals, sealMaterial, root)];
    if (open) {
      for (const [k, name2, outward] of [[0, `${name}-start`, -1], [stations.length - 1, `${name}-end`, 1]] as const) {
        const cap = trimCap(stations[k]!, tube.into[k]!, closed.cap, stations[k]!.along.scale(outward));
        parts.push(smoothSheet(build, name2, cap.points, cap.normals, sealMaterial, root));
      }
    }
    return parts;
  };
  for (const pane of bizjetPaneEdges(grids)) {
    const prefix = `${pane.side > 0 ? "starboard" : "port"}-bizjet`;
    const all = pane.edges.flatMap((e) => e.points.map(v3));
    const inside = all.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / all.length);
    const ledge = pane.edges.findIndex((e) => e.ledge);
    // the trim's run: the whole loop, or from the ledge's outboard corner round to its inboard one
    const run = ledge < 0 ? pane.edges : [...pane.edges.slice(ledge + 1), ...pane.edges.slice(0, ledge)];
    const { stations, pockets } = trimStations(run, ledge < 0);
    const round = trimGrid(stations, section.round, inside);
    trim.push(smoothSheet(build, `${prefix}-trim-${pane.name}`, round.points, round.normals, trimMaterial, root));
    pockets.forEach((pocket, k) => {
      const apex = pocket.apex.at.subtract(pocket.apex.normal.scale(depth));
      trim.push(smoothSheet(
        build,
        `${prefix}-trim-${pane.name}-pocket-${k}`,
        [pocket.arc.map(() => apex), pocket.arc.map((s) => s.at.subtract(s.normal.scale(depth)))],
        [pocket.arc.map(() => pocket.apex.normal.negate()), pocket.arc.map((s) => s.normal.negate())],
        trimMaterial,
        root,
      ));
    });
    seals.push(...seal(`${prefix}-seal-${pane.name}`, stations, sealSections.bead, inside, ledge >= 0));
    if (ledge >= 0) {
      seals.push(...seal(`${prefix}-seal-${pane.name}-cove`, trimStations([pane.edges[ledge]!], false).stations, sealSections.cove, inside, true));
    }
  }
  return { trim, seals };
}

/**
 * THE PILLAR'S FOOT (S3, C): where the windshield/side pillar comes down onto the forward side sill's cap, a concave
 * `radius` fillet along its foot, so the pillar flares onto the ledge instead of standing on it. The pillar's inner face
 * leans back over the cap, and the two meet at 49 degrees along the foot's chord (the windshield's outboard bottom
 * corner to the forward side pane's inboard one, 122 mm): through S4 a crease of 131.7 degrees. The fillet touches
 * each 43.6 mm from the corner (the cap is 50 mm wide, the pillar's lowest band 72 mm tall) and is shaded as its circle.
 * It TAPERS to nothing over `taper` at each end, where the pillar's own trims start, so it closes on the corner there
 * instead of ending in a face.
 */
export const BIZJET_PILLAR_FOOT = Object.freeze({ radius: 0.02, taper: 0.03, stations: 17, arcSteps: 8 });

/**
 * The foot's grid from the pillar's strip (on the skin, rows up the pillar, column 0 the windshield's edge) and its
 * sill's cap (`bizjetSillCapGrid`: row 0 the sill's top row on the lining's inner face, which is the pillar's foot, row
 * 1 inboard): rows along the foot from the windshield's corner to the side pane's, columns round the fillet from the cap
 * to the pillar's face, each point shaded toward the fillet's centre.
 */
export function bizjetPillarFoot(
  pillar: { readonly points: readonly (readonly Point3[])[]; readonly normals: readonly (readonly Point3[])[] },
  cap: { readonly points: readonly (readonly Point3[])[] },
): { points: Vector3[][]; normals: Vector3[][] } {
  const { radius, taper, stations, arcSteps } = BIZJET_PILLAR_FOOT;
  const depth = BIZJET_LINING.depth;
  const inner = (row: number, column: number) => v3(pillar.points[row]![column]!).subtract(v3(pillar.normals[row]![column]!).scale(depth));
  const foot = [v3(cap.points[0]![0]!), v3(cap.points[0]![1]!)];
  for (const k of [0, 1]) {
    if (Vector3.Distance(foot[k]!, inner(0, k)) > 1e-9) throw new Error("the Global's pillar foot: the cap does not start on the pillar's foot");
  }
  const up = [inner(1, 0).subtract(foot[0]!), inner(1, 1).subtract(foot[1]!)];
  const onCap = [v3(cap.points[1]![0]!).subtract(foot[0]!), v3(cap.points[1]![1]!).subtract(foot[1]!)];
  const length = Vector3.Distance(foot[0]!, foot[1]!);
  const chord = foot[1]!.subtract(foot[0]!).normalize();
  const square = (v: Vector3) => v.subtract(chord.scale(Vector3.Dot(v, chord))).normalize();
  const points: Vector3[][] = [];
  const normals: Vector3[][] = [];
  for (let j = 0; j < stations; j += 1) {
    const s = j / (stations - 1);
    const q = Vector3.Lerp(foot[0]!, foot[1]!, s);
    const u1 = square(Vector3.Lerp(up[0]!, up[1]!, s));
    const u2 = square(Vector3.Lerp(onCap[0]!, onCap[1]!, s));
    const opening = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(u1, u2))));
    // each face's normal toward the open side: square to the chord and the face, toward the other face
    let capNormal = Vector3.Cross(chord, u2).normalize();
    if (Vector3.Dot(capNormal, u1) < 0) capNormal = capNormal.negate();
    let faceNormal = Vector3.Cross(chord, u1).normalize();
    if (Vector3.Dot(faceNormal, u2) < 0) faceNormal = faceNormal.negate();
    const end = Math.min(s, 1 - s) * length;
    const x = Math.min(1, end / taper);
    const r = radius * x * x * (3 - 2 * x);
    const centre = q.add(u1.add(u2).normalize().scale(r / Math.sin(opening / 2)));
    const turn = Math.PI - opening;
    const row: Vector3[] = [];
    const shade: Vector3[] = [];
    for (let k = 0; k <= arcSteps; k += 1) {
      const f = k / arcSteps;
      const n = capNormal.scale(Math.sin((1 - f) * turn)).add(faceNormal.scale(Math.sin(f * turn))).scale(1 / Math.sin(turn));
      row.push(centre.subtract(n.scale(r)));
      shade.push(n);
    }
    points.push(row);
    normals.push(shade);
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
 * THE GLARESHIELD, one convex solid along z: a ROUNDED aft edge, a COVE turning under it at 45 degrees to the panel's
 * face, and the hood over the board, falling forward.
 *
 *  - THE ROUND is tangent to the aft face's plane and to the hood's top, and the catalogue's sight line over the deck
 *    (`cockpitDeckLineDegrees` under the eye) is tangent to it: that tangent is a vertex, so the silhouette the pilot
 *    reads is the deck line exactly, one row of the picture across the frame, and the lip rule is unchanged. Its upper
 *    side faces the sky, so the deck's edge reads as a lit rim. It is SMOOTH-SHADED (`smoothRoundNormals`, as the F-16's
 *    rail): at 12.5 mm on flat chords it read as seven bands, 1.6 to 10.7 of luma apart, a pipe of flat strips (P0 of
 *    the "feel real" wave); at 20 mm, shaded as the circle, it reads as one gradient.
 *  - NO AFT FACE UNDER IT (`drop` 0), and a 5 mm cove. The bigger round sits 9.1 mm lower under the same tangent, and
 *    with the old 5 mm drop and 10 mm cove the deck's edge read 3.09 degrees and took the panel's face, and the screens
 *    placed from it, down 9.1 mm; without the drop and with half the cove it reads 2.36 and the face's top is 0.9 mm
 *    HIGHER than it was. The round's aft tangent runs straight into the cove: a 45 degree turn, as the aft face's was.
 *  - THE COVE faces down and aft at 45 degrees, `cove` forward and `cove` down, from the round's aft tangent to the
 *    panel's face. A flat underside there was 0.16 m under the eye and never seen; the cove is seen, and it faces the image
 *    light's lower half, so it reads darker than the panel under it by its normal alone: the shade under a glareshield,
 *    from geometry. The panel's face begins at its foot, which is the lowest edge of the deck the pilot reads.
 *  - THE DECK'S EDGE, from the tangent to the cove's foot, reads 2.36 degrees straight ahead (the design's ceiling is
 *    2.5): the radius, the drop and the cove are what it is made of.
 *  - THE COVE'S FOOT is FILLETED into the panel's face (`BIZJET_COVE_FILLET`): the two met there at 60 degrees, a line
 *    across the whole deck 21 to 26 of luma deep.
 *  - THE HOOD's top falls forward at `hoodFallDegrees`, steeper than the sight line over the round, so nothing of it
 *    shows past the round and it covers no glass. Its underside falls with it from the cove's foot, a plate of one
 *    thickness, so the solid stays convex (the prism `solidPlate` fans needs it) at any depth.
 */
export const BIZJET_GLARESHIELD = Object.freeze({
  radius: 0.02,
  drop: 0,
  /** The cove's run forward, and its fall: 45 degrees. */
  cove: 0.005,
  hoodFallDegrees: 12,
  hoodDepth: 0.18,
  /** Chords round the aft edge, besides the one vertex put on the deck line's tangent. */
  roundSegments: 8,
  /**
   * The CONVEX round where the round's aft tangent turns into the cove (45 degrees), and its chords. With no drop the
   * round ran straight into the cove there, a 45 degree corner the crease survey read as 45.9 along the whole deck;
   * rounded, the corner moves no edge the pilot reads (the deck line is the round's own tangent above it, and the cove
   * still ends at the face's top), and it is shaded as its own circle.
   */
  jointRadius: 0.004,
  jointSegments: 4,
  /**
   * THE END ROUNDS (S4). The deck ended square at its ends, a cut through its section 54 rows tall from the seat.
   * Outboard of each end, the section now closes over `endRound` in a quarter-round of `endStations` steps, scaled down
   * about the cove's foot. That corner's lines are its own under the scaling, so the cove stays on its line and the
   * board's top stays covered to the end. The lit round falls in a curve to the corner, and no end faces the pilot.
   *
   * It is OUTBOARD of the deck's width: a round inside it would bare the board's top face, which the glareshield's
   * underside covers. It stands in front of the pillar's band, 3 cm inside the shell where the deck keeps 5.
   */
  endRound: 0.02,
  endStations: 6,
});

/**
 * The glareshield's section in body x and y, and the points the rest of the deck is placed from (`roundedDeckSection`):
 * the round (its last vertex now where the joint's round leaves it) and the JOINT, the small convex round from the
 * round into the cove. `coveTop` stays the corner the two met at, on the cove's line; the flat cove begins at the
 * joint's last point.
 */
export type BizjetGlareshieldSection = RoundedDeckSection & {
  readonly joint: { readonly points: readonly { x: number; y: number }[]; readonly centre: { x: number; y: number }; readonly radius: number };
};

export function bizjetGlareshieldSection(deckLine: number = aircraftSpec("bizjet").cockpitDeckLineDegrees): BizjetGlareshieldSection {
  const g = BIZJET_GLARESHIELD;
  const base = roundedDeckSection(eye(), bizjetPanelFaceX(), deckLine, g, "the Global");
  if (g.drop !== 0) throw new RangeError("the Global's joint round is between the round and the cove: it needs no drop");
  // The small circle inside the corner, `rho` from the cove's line and `R - rho` from the round's centre (tangent to both).
  // With the corner P (the round's aft tangent, on the cove's line) and the cove running down it along d, into the solid
  // along m: the centre is P + t d + rho m, and |centre - C|^2 = (R - rho)^2 is a quadratic in t.
  const R = g.radius;
  const rho = g.jointRadius;
  const P = base.round.at(-1)!;
  const C = base.centre;
  const d = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  const m = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const ox = P.x - C.x + rho * m.x;
  const oy = P.y - C.y + rho * m.y;
  const b = 2 * (ox * d.x + oy * d.y);
  const c = ox * ox + oy * oy - (R - rho) ** 2;
  // the nearer root: the circle in the corner (the farther one touches the round again 26 mm down the cove's line)
  const t = (-b - Math.sqrt(b * b - 4 * c)) / 2;
  const S = { x: P.x + t * d.x + rho * m.x, y: P.y + t * d.y + rho * m.y };
  const onCircle = { x: C.x + ((S.x - C.x) * R) / (R - rho), y: C.y + ((S.y - C.y) * R) / (R - rho) };
  const onCove = { x: P.x + t * d.x, y: P.y + t * d.y };
  const from = Math.atan2(onCircle.y - S.y, onCircle.x - S.x);
  const to = Math.atan2(onCove.y - S.y, onCove.x - S.x);
  const sweep = ((to - from + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const joint = Array.from({ length: g.jointSegments + 1 }, (_, k) => {
    const angle = from + (sweep * k) / g.jointSegments;
    return { x: S.x + rho * Math.cos(angle), y: S.y + rho * Math.sin(angle) };
  });
  joint[0] = onCircle;
  joint[g.jointSegments] = onCove;
  const round = [...base.round.slice(0, -1), onCircle];
  const outline = [...base.outline.slice(0, base.outline.length - base.round.length), ...round, ...joint.slice(1)];
  return { ...base, round, outline, joint: { points: joint, centre: S, radius: rho } };
}

/**
 * THE COVE'S FILLET: a concave round in the corner where the cove (facing down and aft at 45 degrees) meets the panel's
 * face (leaned back 15), tangent to both, `radius` of it about a centre on the pilot's side of the corner. It is its own
 * mesh, not part of the glareshield, whose convex prism cannot hold a concave face.
 *
 * It is an open sheet (`smoothSheet`) with its back in the corner, never seen. A closed thin slab (`skinPanel`) was
 * tried first, and its rim's top edge lay ON the cove along the tangent line and traded pixels with it (a 90 degree
 * normal along a 15 px line, by the crease survey). SMOOTH-SHADED with the circle's own normal at every row, so the
 * first row's is exactly the cove's and the last's the face's: the cove shades into the face with no line between them.
 */
/**
 * 7.5 mm: the smallest round that turns under 8 degrees a 1080p pixel from the seat (measured over the bare board: 5 mm
 * read 11.9, 6.2 read 9.8, 7 read 8.1, 7.5 reads 7.4; its cove end is seen obliquely, so the arc crowds there).
 */
export const BIZJET_COVE_FILLET = Object.freeze({ radius: 0.0075, rows: 13 });

/**
 * The fillet's section in body x and y: its rows from the cove's tangent round to the face's, each with its outward
 * (toward the pilot) normal, and the centre. The corner turns by the angle between the cove's and the face's normals,
 * and each tangent stands `radius * tan(half that)` from the corner along its own line.
 */
export function bizjetCoveFillet(): { points: { x: number; y: number }[]; normals: { x: number; y: number }[]; centre: { x: number; y: number } } {
  const f = BIZJET_COVE_FILLET;
  const section = bizjetGlareshieldSection();
  const face = bizjetPanelFace();
  const corner = section.faceTop;
  const coveNormal = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
  const turn = Math.acos(coveNormal.x * face.normal.x + coveNormal.y * face.normal.y);
  const along = f.radius * Math.tan(turn / 2);
  // up the cove from its foot (toward its top: back and up), and down the face from its top
  const onCove = { x: corner.x - along * Math.SQRT1_2, y: corner.y + along * Math.SQRT1_2 };
  const centre = { x: onCove.x + f.radius * coveNormal.x, y: onCove.y + f.radius * coveNormal.y };
  const from = Math.atan2(-coveNormal.y, -coveNormal.x);
  const to = Math.atan2(-face.normal.y, -face.normal.x);
  const points: { x: number; y: number }[] = [];
  const normals: { x: number; y: number }[] = [];
  for (let k = 0; k < f.rows; k += 1) {
    const angle = from + ((to - from) * k) / (f.rows - 1);
    points.push({ x: centre.x + f.radius * Math.cos(angle), y: centre.y + f.radius * Math.sin(angle) });
    normals.push({ x: -Math.cos(angle), y: -Math.sin(angle) });
  }
  return { points, normals, centre };
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
  /** The bezel's rim beyond the screen at its sides and foot: the dark gap, then the bezel's flat face, then its chamfer. */
  bezel: 0.01,
  /**
   * ITS TOP: the gap and the chamfer only, no flat band (S2). The frames' tops were a millimetre into the cove, a 105
   * degree crease along both pairs; standing them clear of the cove's fillet took the headroom from here, not from the
   * screens.
   */
  topBorder: 0.006,
  /** Centre to centre inside a pair. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /**
   * THE FRAMES' TOP stands this much board under the cove's fillet's foot (`BIZJET_COVE_FILLET`), along the face: the
   * rule is on the frame's top, where it was on the screen's (0.8 degrees under the cove's foot, which put the frames'
   * tops 0.5 mm INTO the cove). 1.2 mm is 2.2 pixels of a 1080p frame from the seat.
   */
  boardUnderFillet: 0.0012,
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
  return framedScreenStack(BIZJET_SCREENS);
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
  // the frames' top edge (h, up the face from its top): `boardUnderFillet` under the fillet's foot; the screen's top edge
  // the frame's top border under that
  const filletFoot = bizjetCoveFillet().points.at(-1)!;
  const frameTop = (filletFoot.x - face.top.x) * face.up.x + (filletFoot.y - face.top.y) * face.up.y - s.boardUnderFillet;
  const h = frameTop - s.topBorder;
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
 * THE STANDBY DISPLAY (S5): the type's standby cluster on the bare centre board, ONE framed screen of the pair's family
 * (the same bezel, well and recess) at `scale` of a pair screen's size, its frame's top on the pair's line under the cove,
 * showing attitude and tapes. Its z is where the pilot sees it: the board's centreline reads 38.7 degrees from the seat,
 * past the frame's edge, so the standby stands `centreZ` in from it, toward the captain.
 */
export const BIZJET_STANDBY = Object.freeze({ scale: 2 / 3, centreZ: -0.15 });

/** The standby's screen size, and its screen plate's centre and face centre as `bizjetScreenPlacements` gives a pair's. */
export function bizjetStandbyPlacement(): { width: number; height: number; centre: Vector3; faceCentre: Vector3 } {
  const s = BIZJET_SCREENS;
  const { scale, centreZ } = BIZJET_STANDBY;
  const width = s.width * scale;
  const height = s.height * scale;
  const stack = bizjetScreenStack();
  const face = bizjetPanelFace();
  const along = (h: number, out: number) => ({ x: face.top.x + h * face.up.x + out * face.normal.x, y: face.top.y + h * face.up.y + out * face.normal.y });
  const filletFoot = bizjetCoveFillet().points.at(-1)!;
  const frameTop = (filletFoot.x - face.top.x) * face.up.x + (filletFoot.y - face.top.y) * face.up.y - s.boardUnderFillet;
  const h = frameTop - s.topBorder - height / 2;
  const screen = along(h, (stack.screenFront + stack.screenBack) / 2);
  const onFace = along(h, 0);
  return { width, height, centre: new Vector3(screen.x, screen.y, centreZ), faceCentre: new Vector3(onFace.x, onFace.y, centreZ) };
}

/**
 * A screen's bezel as flat quads about `faceCentre` on the leaned face, in two CLOSED solids that meet along the chamfer's
 * shoulder: `frame`, a ring from the opening (the screen and its gap) out to the shoulder, its flat front toward the
 * pilot; and `rim`, the band from the shoulder out to the bezel's edge, whose front is the 45 degree chamfer. Each is
 * closed on its own, so wherever a ray meets either first it meets a face the GPU draws (the faces where they meet
 * face each other inside the bezel and are never seen); the rim is apart so the night glow can be on it alone.
 */
export function bizjetBezelFacets(
  faceCentre: Vector3,
  size: { readonly width: number; readonly height: number } = BIZJET_SCREENS,
): { frame: FacetQuad[]; rim: FacetQuad[] } {
  // `framedScreenFacets`' bezel (the 747's too), with its own top border: where the top has no flat band the frame is a
  // U round the sides and foot, and the rim's own inner wall closes the recess's top (the frame's top segment would
  // have no front and its two walls would lie on the rim's).
  const s = BIZJET_SCREENS;
  const stack = bizjetScreenStack();
  const face = bizjetPanelFace();
  const across = new Vector3(0, 0, 1);
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  const at = (u: number, v: number, o: number) => faceCentre.add(across.scale(u)).add(up.scale(v)).add(out.scale(o));
  // a rectangle's corners, bottom-left round to top-left, its half-width, its foot and its top; each side's outward direction
  const rect = (x: number, foot: number, top: number, o: number) => [at(-x, -foot, o), at(x, -foot, o), at(x, top, o), at(-x, top, o)];
  const sides = [up.scale(-1), across, up, across.scale(-1)];
  const ring = (a: Vector3[], b: Vector3[], normal: (k: number) => Vector3, which: readonly number[]): FacetQuad[] =>
    which.map((k) => ({ corners: [a[k]!, a[(k + 1) % 4]!, b[(k + 1) % 4]!, b[k]!] as const, normal: normal(k) }));
  const w = size.width / 2;
  const h = size.height / 2;
  const opening = (o: number) => rect(w + s.gap, h + s.gap, h + s.gap, o);
  const shoulder = (o: number) => rect(w + s.bezel - s.chamfer, h + s.bezel - s.chamfer, h + s.topBorder - s.chamfer, o);
  const edge = (o: number) => rect(w + s.bezel, h + s.bezel, h + s.topBorder, o);
  const topBand = s.topBorder - s.chamfer - s.gap;
  const frameSides = topBand > 1e-9 ? [0, 1, 2, 3] : [0, 1, 3];
  const all = [0, 1, 2, 3];
  const { bezelFront: front, bezelBack: back, chamferFoot: foot } = stack;
  return {
    frame: [
      ...ring(opening(front), shoulder(front), () => out, frameSides),
      ...ring(shoulder(front), shoulder(back), (k) => sides[k]!, frameSides),
      ...ring(opening(back), shoulder(back), () => out.scale(-1), frameSides),
      ...ring(opening(back), opening(front), (k) => sides[k]!.scale(-1), frameSides),
    ],
    rim: [
      // the chamfer runs as far across the face as it falls toward it: its normal is halfway between the side's and the face's
      ...ring(shoulder(front), edge(foot), (k) => sides[k]!.add(out).normalize(), all),
      ...ring(edge(foot), edge(back), (k) => sides[k]!, all),
      ...ring(shoulder(back), edge(back), () => out.scale(-1), all),
      ...ring(shoulder(back), shoulder(front), (k) => sides[k]!.scale(-1), all),
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

// ---- the side consoles ---------------------------------------------------------------------------

/**
 * THE SIDE CONSOLES (P1c): the sill cap widened into a console's top, one each side, from the board's end aft to the seat.
 *
 * From the seat the wall under the forward side pane filled the frame's lower left, about 21 degrees of one flat tone from
 * the pane's bottom edge to the frame's bottom, on part 5's nose (P0 and P1c's rays). Part 6b's side pane reaches lower:
 * the glass now comes down to -16 to -18 degrees there, and under the pane's sill and its cap about 1 to 2.6 degrees of
 * wall is left. A console at armrest height would stand wholly under the frame: the wall is 0.5 to 0.7 m ahead, where
 * the frame's bottom is 0.28 m under the eye. So the console's TOP is the sill cap's, level with the pane's bottom edge
 * (it covers no glass, by the cap's own rule), running inboard from the cap's inboard edge toward the board's end.
 *
 *  - Its outboard top edge IS the cap's inboard edge, vertex for vertex (no T-junction), at the cap's own columns: from
 *    the first that leaves room inboard of the board's end aft to the last forward of `aftX`.
 *  - Its inboard top edge rolls over on `round` into the inboard face (S5: through S4 a 20 mm lip stood over a 45 degree
 *    cove, 90 and 46 degree creases along the console's length, 469 px), smooth-shaded as it turns.
 *  - The inboard face stands `gap` outboard of the board's end and runs straight down past the frame's bottom, so the
 *    board's edge stands in front of it with a step, not against it in a corner (S4: the board's face met the lip at 90).
 *  - The outboard side follows the shell down from the cap, `shellMargin` inside it.
 *
 * The console and the caps are on a second instance of the interior material, `tone` of its albedo: the tops face the sky
 * and read 84 to 99 against the board's 48 in the level frame (P0), and the design wants them within 1.3 times the board.
 */
export const BIZJET_SIDE_CONSOLE = Object.freeze({
  round: 0.01,
  gap: 0.005,
  /** The console's aft end: the seat's centre, as the design has it (the seat's base stands inboard of the console's face). */
  aftX: 11.85,
  tone: 0.5,
});

/** The console's material: the interior's own parameters at `tone` of its albedo (no third material). */
export function bizjetConsoleMaterial(build: AircraftBuildContext, interior: PBRMaterial): PBRMaterial {
  const c = interior.albedoColor.scale(BIZJET_SIDE_CONSOLE.tone);
  const hex = (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
  return build.material("bizjet-interior-console", hex, { roughness: interior.roughness ?? 0.82, metallic: interior.metallic ?? 0.02 });
}

/**
 * A side console from the cap's inboard edge (`capInboard`, the cap's row 1 in order along the sill, forward side then aft
 * side, shared corners once) toward the board's end at `deckHalfWidth`; `side` -1 port, +1 starboard; `shell` the shell's
 * half-width as built at a station and height. Returns its TOP AND INBOARD SIDE as a smooth sheet's grid (rows the
 * columns, forward to aft; points across from the cap's edge over the round and down the face), its hidden floor, outboard
 * side and ends as flat facets, and the columns it stood on (for the seam's pin and the things on its top).
 */
export function bizjetSideConsole(
  capInboard: readonly Point3[],
  deckHalfWidth: number,
  side: 1 | -1,
  shell: (x: number, y: number) => number,
): { surface: { points: Vector3[][]; normals: Vector3[][] }; facets: FacetQuad[]; columns: Point3[]; top: (x: number) => { at: (across: number) => Vector3; normal: Vector3; along: Vector3; from: number; to: number } } {
  const c = BIZJET_SIDE_CONSOLE;
  const floorY = eye().up - BIZJET_PANEL.bottomBelowEye;
  const inward = -side;
  const faceZ = side * (deckHalfWidth + c.gap);
  const roundZ = side * (deckHalfWidth + c.gap + c.round);
  const room = (p: Point3) => Math.abs(p.z) > deckHalfWidth + c.gap + c.round + 0.001;
  const columns = capInboard.filter((p) => p.x >= c.aftX && room(p));
  // one run of columns, forward to aft, with nothing skipped between
  const first = capInboard.indexOf(columns[0]!);
  if (columns.length < 2 || columns.some((p, k) => capInboard[first + k] !== p)) {
    throw new RangeError("the Global's side console: the cap leaves no single run of room inboard of it");
  }
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const steps = 6;
  // the visible profile at a column, with its normal in the section's plane: the top, the round, the face
  const profile = (p: Point3) => {
    const out: { at: Vector3; normal: Vector3 }[] = [{ at: V(p.x, p.y, p.z), normal: V(0, 1, 0) }];
    for (let k = 0; k <= steps; k += 1) {
      const a = (k / steps) * (Math.PI / 2);
      out.push({ at: V(p.x, p.y - c.round + c.round * Math.cos(a), roundZ + inward * c.round * Math.sin(a)), normal: V(0, Math.cos(a), inward * Math.sin(a)) });
    }
    out.push({ at: V(p.x, floorY, faceZ), normal: V(0, 0, inward) });
    return out;
  };
  const profiles = columns.map(profile);
  // shaded as the surface turns along the columns too: each normal made square to the run from column to column
  const points = profiles.map((row) => row.map((q) => q.at));
  const normals = profiles.map((row, i) => row.map((q, j) => {
    const run = points[Math.min(i + 1, points.length - 1)]![j]!.subtract(points[Math.max(i - 1, 0)]![j]!).normalize();
    return q.normal.subtract(run.scale(Vector3.Dot(q.normal, run))).normalize();
  }));
  // the hidden rest: the floor and the outboard side, column to column, and the two ends over the whole section
  const outboardFoot = (p: Point3) => V(p.x, floorY, side * Math.min(Math.abs(p.z), shell(p.x, floorY) - BIZJET_PANEL.shellMargin));
  const facets: FacetQuad[] = [];
  const quad = (a: Vector3, b: Vector3, cc: Vector3, d: Vector3, away: Vector3) => {
    let n = Vector3.Cross(b.subtract(a), d.subtract(a)).normalize();
    if (Vector3.Dot(n, away) < 0) n = n.scale(-1);
    facets.push({ corners: [a, b, cc, d], normal: n });
  };
  for (let k = 0; k + 1 < columns.length; k += 1) {
    const [p, q] = [columns[k]!, columns[k + 1]!];
    const [fp, fq] = [points[k]!.at(-1)!, points[k + 1]!.at(-1)!];
    quad(fp, fq, outboardFoot(q), outboardFoot(p), V(0, -1, 0));
    quad(outboardFoot(p), outboardFoot(q), V(q.x, q.y, q.z), V(p.x, p.y, p.z), V(0, 0, side));
  }
  for (const [k, towards] of [[0, 1], [columns.length - 1, columns.length - 2]] as const) {
    const outline = [...points[k]!, outboardFoot(columns[k]!)];
    const away = V(columns[k]!.x - columns[towards]!.x, 0, 0);
    for (let e = 1; e + 1 < outline.length; e += 1) quad(outline[0]!, outline[e]!, outline[e + 1]!, outline[e + 1]!, away);
  }
  // THE TOP where something stands on it: at a station between two columns, its height, the across line from the cap's
  // edge (0) to the round's start (1), and its normal (the top is level across, sloping along the run with the cap)
  const top = (x: number) => {
    const k = Math.max(0, Math.min(columns.length - 2, columns.findIndex((p, i) => i + 1 < columns.length && columns[i + 1]!.x <= x)));
    const [p, q] = [columns[k]!, columns[k + 1]!];
    const f = (x - p.x) / (q.x - p.x);
    const y = p.y + (q.y - p.y) * f;
    const edgeZ = p.z + (q.z - p.z) * f;
    const along = V(q.x - p.x, q.y - p.y, 0).normalize();
    const normal = Vector3.Cross(along, V(0, 0, 1)).normalize();
    return { at: (across: number) => V(x, y, edgeZ + (roundZ - edgeZ) * across), normal: normal.y < 0 ? normal.scale(-1) : normal, along, from: edgeZ, to: roundZ };
  };
  return { surface: { points, normals }, facets, columns, top };
}

/**
 * ON THE PORT CONSOLE'S TOP (S5), two things and no more: a small PANEL BLOCK with two rocker switches, and the nose
 * wheel's TILLER knob, every edge rounded at least `edge` (3 mm). The block is the bezels' dark grey, its rockers the
 * marking material (lit at night with the rims), the knob the glareshield's matte; each goes into the mesh of its
 * material, so they add no draw. Stations along the console, from the seat's side of the board: the block `blockX`, the
 * knob `knobX`, both in the frame's lower left.
 */
export const BIZJET_CONSOLE_ITEMS = Object.freeze({
  edge: 0.003,
  blockX: 12.46,
  block: { along: 0.07, across: 0.08, height: 0.016 },
  rocker: { along: 0.016, across: 0.012, height: 0.008, spacing: 0.022, tiltDegrees: 8 },
  knobX: 12.57,
  knob: { radius: 0.02, height: 0.022, edge: 0.004 },
});

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
 * NINE meshes, all static: the board and the window frame's lining with its trim on the interior material; the
 * glareshield on its own, and the cove's fillet and the window seals on the glareshield's material; the four screens;
 * their four bezels' frames; the frames' chamfered rims; the wells behind the screens; the two side consoles, on the
 * interior material.
 */
export function buildBizjetCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: BizjetCockpitMaterials,
  skin: SkinCaster,
): BizjetCockpit {
  const parts: AbstractMesh[] = [];

  // THE LINING: one skin panel per strip (a side, or once across the centreline), 12 mm in from the skin; then the
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
  // the caps are the consoles' tops' outboard strips: on the consoles' instance, merged with them (S5)
  const consoleMaterial = bizjetConsoleMaterial(build, materials.interior);
  const caps: AbstractMesh[] = [];
  for (const side of [-1, 1] as const) {
    for (const sill of BIZJET_SILL_CAP.sills) {
      const grid = sills.get(`${side > 0 ? "starboard-" : "port-"}bizjet-lining-${sill}`);
      if (!grid) throw new Error(`the Global's sill cap: no ${sill} was built`);
      const cap = bizjetSillCapGrid(grid);
      caps.push(build.skinPanel(bizjetSillCapMeshName(sill, side), cap.points, cap.normals, BIZJET_SILL_CAP.thickness, 0, consoleMaterial, root));
    }
  }

  // THE GLARESHIELD, its round's silhouette on the catalogue's deck line, as wide as the pillars and the shell let it be;
  // the hood forward of the round and the cove tapered in plan to the shell (`bizjetHoodTaper`).
  const halfWidth = bizjetPanelHalfWidth(skin);
  const lipMaterial = glareshieldMaterial(build, "bizjet-glareshield");
  const straight = solidPlate(build, "bizjet-glareshield-straight", bizjetGlareshieldSection().outline, halfWidth * 2, lipMaterial, root);
  const taper = bizjetHoodTaper(skin, halfWidth);
  const tapered = (x: number, z: number) => z * (1 + (taper.endHalfWidth / halfWidth - 1) * Math.min(1, Math.max(0, (x - taper.from) / (taper.to - taper.from))));
  sculptSolid(straight, (point) => new Vector3(point.x, point.y, tapered(point.x, point.z)));
  // The round shades as the circle (the taper starts forward of it, so its corners are still on the round in x and y).
  const lipSection = bizjetGlareshieldSection();
  smoothRoundNormals(straight, lipSection.round, lipSection.centre);
  smoothRoundNormals(straight, lipSection.joint.points, lipSection.joint.centre);
  // THE END ROUNDS, a quarter-round outboard of each end: the section scaled about the cove's foot by sin(phi) as it
  // steps out cos(phi) of `endRound`, from the tip (phi 0, the section a point) to the deck's end (phi 90, full).
  const g = BIZJET_GLARESHIELD;
  const outline = lipSection.outline;
  const roundFirst = outline.indexOf(lipSection.round[0]!);
  const roundLast = roundFirst + lipSection.round.length - 1;
  const jointLast = roundLast + lipSection.joint.points.length - 1;
  const corner = lipSection.faceTop;
  const section: SweptSection = {
    points: outline.map((p) => ({ u: p.x, y: p.y })),
    rounds: [
      { first: roundFirst, last: roundLast, centre: { u: lipSection.centre.x, y: lipSection.centre.y } },
      { first: roundLast, last: jointLast, centre: { u: lipSection.joint.centre.x, y: lipSection.joint.centre.y } },
    ],
  };
  const ends = ([-1, 1] as const).map((side) => {
    const phi = (i: number) => (Math.PI / 2) * (i / g.endStations);
    return sweptSolid(
      build,
      `bizjet-glareshield-end-${side < 0 ? "port" : "starboard"}`,
      section,
      g.endStations + 1,
      (i, point) => {
        const scale = Math.sin(phi(i));
        const x = corner.x + (point.u - corner.x) * scale;
        return new Vector3(x, corner.y + (point.y - corner.y) * scale, tapered(x, side * (halfWidth + g.endRound * Math.cos(phi(i)))));
      },
      (direction) => new Vector3(direction.u, direction.y, 0),
      lipMaterial,
      root,
      {
        smoothAlong: true,
        // the round's own run: in from the tip, then straight along the deck at its end, where the straight part's
        // round is shaded as the circle square to z
        tangent: (i) => new Vector3(
          (lipSection.centre.x - corner.x) * Math.cos(phi(i)),
          (lipSection.centre.y - corner.y) * Math.cos(phi(i)),
          -side * g.endRound * Math.sin(phi(i)),
        ).normalize(),
      },
    );
  });
  const glareshield = build.mergeStatic("bizjet-glareshield", [straight, ...ends], root);
  parts.push(glareshield);

  // THE COVE'S FILLET, on the glareshield's own material, across the deck's width.
  const fillet = bizjetCoveFillet();
  const across = [-halfWidth, halfWidth];
  parts.push(smoothSheet(
    build,
    "bizjet-cove-fillet",
    fillet.points.map((p) => across.map((z) => new Vector3(p.x, p.y, z))),
    fillet.normals.map((n) => across.map(() => new Vector3(n.x, n.y, 0))),
    glareshield.material as PBRMaterial,
    root,
  ));

  // THE WINDOW TRIM round every pane: its rounds and pockets are frame, merged with the lining below; its seals are one
  // mesh on the glareshield's material.
  const windowTrim = buildBizjetWindowTrim(build, root, sills, materials.interior, lipMaterial);
  lining.push(...windowTrim.trim);
  // THE SIDE CONSOLES, on the sill caps' inboard edges, a step outboard of the board's ends, on their own instance with
  // the caps; and on the port console's top the panel block and the tiller, each into the mesh of its material (S5)
  const bezelMaterial = bizjetBezelMaterial(build);
  const consoleParts: AbstractMesh[] = [];
  const onConsole = { bezel: [] as AbstractMesh[], marking: [] as AbstractMesh[], matte: [] as AbstractMesh[] };
  for (const side of [-1, 1] as const) {
    const prefix = side > 0 ? "starboard" : "port";
    const capRow = (sill: string) => bizjetSillCapGrid(sills.get(`${prefix}-bizjet-lining-${sill}`)!).points[1]!;
    const built = bizjetSideConsole([...capRow("sill-forward-side"), ...capRow("sill-aft-side").slice(1)], halfWidth, side, (x, y) => shellHalfWidth(skin, x, y));
    consoleParts.push(smoothSheet(build, `bizjet-side-console-${prefix}`, built.surface.points, built.surface.normals, consoleMaterial, root));
    consoleParts.push(facetMesh(build, `bizjet-side-console-${prefix}-under`, built.facets, consoleMaterial, root));
    const items = BIZJET_CONSOLE_ITEMS;
    const blockTop = built.top(items.blockX);
    const across = Vector3.Cross(blockTop.normal, blockTop.along).normalize();
    const blockBase = blockTop.at(0.5);
    const b = items.block;
    onConsole.bezel.push(roundedBox(build, `bizjet-console-block-${prefix}`, blockBase.add(blockTop.normal.scale(b.height / 2)), [blockTop.along, blockTop.normal, across], [b.along / 2, b.height / 2, b.across / 2], items.edge, bezelMaterial, root));
    const r = items.rocker;
    for (const [k, offset] of [[0, -1], [1, 1]] as const) {
      const tilt = (offset * r.tiltDegrees * Math.PI) / 180;
      const along = blockTop.along.scale(Math.cos(tilt)).add(blockTop.normal.scale(Math.sin(tilt)));
      const up = blockTop.normal.scale(Math.cos(tilt)).subtract(blockTop.along.scale(Math.sin(tilt)));
      const at = blockBase.add(blockTop.normal.scale(b.height + r.height / 2 - 0.001)).add(across.scale((offset * r.spacing) / 2));
      onConsole.marking.push(roundedBox(build, `bizjet-console-rocker-${prefix}-${k}`, at, [along, up, across], [r.along / 2, r.height / 2, r.across / 2], items.edge, materials.instrumentMarking, root));
    }
    const knobTop = built.top(items.knobX);
    const n = items.knob;
    onConsole.matte.push(roundedCylinder(build, `bizjet-console-tiller-${prefix}`, knobTop.at(0.5).subtract(knobTop.normal.scale(0.001)), knobTop.normal, n.radius, n.height, n.edge, lipMaterial, root));
  }
  parts.push(build.mergeStatic("bizjet-window-seals", [...windowTrim.seals, ...onConsole.matte], root));
  // THE PILLARS' FEET, filleted onto the forward side sills' caps: frame too, merged with the lining below.
  for (const side of [-1, 1] as const) {
    const prefix = side > 0 ? "starboard-" : "port-";
    const pillar = sills.get(`${prefix}bizjet-lining-pillar`);
    const sill = sills.get(`${prefix}bizjet-lining-sill-forward-side`);
    if (!pillar || !sill) throw new Error("the Global's pillar foot: no pillar or forward side sill was built");
    const foot = bizjetPillarFoot(pillar, bizjetSillCapGrid(sill));
    lining.push(smoothSheet(build, `${prefix}bizjet-pillar-foot`, foot.points, foot.normals, materials.interior, root));
  }

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
  // THE STANDBY, last: the atlas's fifth slot is its (`BIZJET_DISPLAYS`), and its parts go into the four's meshes
  {
    const standby = bizjetStandbyPlacement();
    const screen = build.box("bizjet-screen-standby", s.screenThickness, standby.height, standby.width, materials.instrumentFace, root);
    screen.position.copyFrom(standby.centre);
    screen.rotation.z = -lean;
    screens.push(screen);
    const facets = bizjetBezelFacets(standby.faceCentre, standby);
    frames.push(facetMesh(build, "bizjet-screen-bezel-standby", facets.frame, bezelMaterial, root));
    rims.push(facetMesh(build, "bizjet-screen-bezel-rim-standby", facets.rim, materials.instrumentMarking, root));
    const well = build.box("bizjet-screen-well-standby", s.wellThickness, standby.height + s.gap * 2, standby.width + s.gap * 2, materials.instrumentFace, root);
    well.position.copyFrom(standby.faceCentre);
    well.rotation.z = -lean;
    wells.push(well);
  }
  // the consoles' panel blocks and rockers, on the bezels' and the rims' materials
  frames.push(...onConsole.bezel);
  rims.push(...onConsole.marking);
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

  // THE SIDE CONSOLES and the caps, one mesh on their own instance.
  parts.push(build.mergeStatic("bizjet-side-consoles", [...consoleParts, ...caps], root));

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
