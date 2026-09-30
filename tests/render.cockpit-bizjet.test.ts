import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crossings, distanceToTriangles, worldTriangles, type Triangle } from "../scripts/rayCrossings.mts";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { PANE_GRID } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { GLOBAL_CENTRE_POST, GLOBAL_FLIGHT_DECK_OUTLINES, GLOBAL_PANE_DEPTH, GLOBAL_PANE_PROUD } from "../src/render/webgpu/aircraft/bizjetGlazing";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import { globalSeatPlacement } from "../src/render/webgpu/aircraft/bizjetSeats";
import {
  BIZJET_COVE_FILLET,
  BIZJET_GLARESHIELD,
  BIZJET_LINING,
  BIZJET_PANEL,
  BIZJET_SCREENS,
  BIZJET_SIDE_CONSOLE,
  BIZJET_SILL_CAP,
  BIZJET_WINDOW_TRIM,
  bizjetCoveFillet,
  bizjetCoveSection,
  bizjetGlareshieldSection,
  bizjetLipY,
  bizjetLiningMeshName,
  bizjetLiningStrips,
  bizjetPanelFace,
  bizjetPanelFaceX,
  bizjetScreenPlacements,
  bizjetSideConsole,
  BIZJET_CONSOLE_ITEMS,
  bizjetSillCapMeshName,
  bizjetTrimSection,
  highestClearLip,
} from "../src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import { BEZEL_RIM, GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { cockpitView, measureDeckLineDegrees } from "./support/cockpitFootprints";

/**
 * The Global's cockpit, held to the glass it looks through and to the shell it stands in.
 *
 * THE GLASS is the type's six panes (`bizjetGlazing.ts`), laid out on the body and cast from R onto the
 * fuselage's own triangles, and the plane engineer's centre post cast the same way. Every pane number here is
 * read off the BUILT panes, captured as `skinPanel` returns them: the corner table
 * (`scripts/airliner-glazing-table.mts --airframe bizjet`) is computed from them at test time, so nothing here is a
 * copy of a table that a re-lofted nose could leave stale.
 *
 * THE TARGETS are one block (`TARGETS`, below): what the pilot must see through the windshield straight ahead,
 * the post in the frame, the lip rule, the screens in the frame. The eye and the deck line are the catalogue's.
 * Re-pinning for a new nose is the catalogue's eye and deck line and nothing in this file but that block.
 *
 * Every measurement is a ray or a vertex of the BUILT meshes. The fuselage is DRAWN from inside and culled, and
 * Babylon's picking ignores culling, so what the cockpit camera draws first is picked with a winding predicate
 * calibrated on a closed solid before any ray is believed.
 */

const DEG = 180 / Math.PI;
const EYE = aircraftSpec("bizjet").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);
/** The 16:9 frame at the 75 degree horizontal lens, as tangents in the image plane. */
const FRAME_U = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES / 2) / DEG);
const FRAME_V = FRAME_U / (16 / 9);

/**
 * THE TARGETS, the PM's for this type (K0), in one place. Degrees from the eye at the 75 degree, 16:9 lens.
 *  - `opening`: the port windshield's run of elevation straight ahead, and straight ahead is inside it;
 *  - `topEdge`: the glass's top edge straight ahead is at least this high, so the roof line is in the frame;
 *  - `topCorners`: both of the port windshield's top corners (on the skin) are at least this high, and
 *    `starboardTopAtPost`: the starboard windshield's top edge at the post is at least this high, so the right-hand
 *    pane shows above the horizon (no crown can make the port pane's top level: its outboard corner is 0.54 m away,
 *    31 degrees round the section, and the spread stays about 10 degrees);
 *  - `postHead`: the centre post's head reads at least this high from the eye (`postHeadGoal` is the aim, reported;
 *    the nose's crown may stand at most 0.10 m over the type's silhouette, and that bounds how high the head can go);
 *  - the whole centre post is in the frame from the seat (its azimuth is wherever the glass puts it);
 *  - `hiddenAhead`, `hiddenAnywhere`: how much glass the lip may hide under its row, in degrees of the picture's
 *    rows (elevation straight ahead): straight ahead, and anywhere in the frame along the lip. Part 6's V drops the
 *    windshield's bottom edge outboard, and a straight lip at the deck line hides that low corner, as a real
 *    glareshield does (the highest lip that hides NONE, `highestClearLip`, read 15.085 on part 6 and 12.184 on 6b's
 *    filleted V, where the lip hides 0.00 straight ahead and 1.30 at most; part 6 was pinned at 0.6 and 4.3);
 *  - `downVision`: the lowest the pilot sees through the glass straight ahead, at most this;
 *  - `displays`: at least this share of each of the pilot's two screens is in the frame (65% since P1a; the rule's
 *    15.085 deck line on part 6 would leave 38%);
 *  - `aim`: the panel's face normal points at the eye from the centre of the pilot's pair of screens, to this;
 *  - `deckEdge`: the deck's edge, from the deck line down to the cove's foot, is at most this tall straight ahead;
 *  - `bareWall`: at most this much of the wall's own lining shows in any column of the frame's lower left (P1c; it was
 *    about 21 degrees on part 5's nose, and 6b's lower side pane left 2.5 to 3.8 before the consoles).
 */
const TARGETS = {
  opening: 24,
  topEdge: 10,
  topCorners: 6,
  starboardTopAtPost: 5,
  postHead: 6,
  postHeadGoal: 10,
  hiddenAhead: 0.3,
  hiddenAnywhere: 1.6,
  downVision: -10,
  displays: 0.65,
  aim: 8,
  deckEdge: 2.5,
  bareWall: 5,
} as const;

/**
 * The windshield/side pillar's side faces from the seat, at most: the 2 cm frame's read 0.33 to 0.49 degrees across it on
 * 8d5deeb's nose and 0.70 to 1.09 on 3da1899's, whose steeper, lower nose shows more of the frame's depth; the glass's own
 * 0.10 m slab would read five times that.
 */
const PILLAR_SIDE_DEGREES = 1.5;

interface Panel { name: string; rows: number; columns: number; positions: number[]; triangles: number }

let engine: NullEngine;
let scene: Scene;
let camera: UniversalCamera;
let aircraft: AircraftVisual;
let cockpitOnly: readonly AbstractMesh[];
let fuselage: AbstractMesh;
let shell: Triangle[];
const panels: Panel[] = [];
/** Every merged mesh's sources in merge order, with each one's triangle count: `partOf` names a face by them. */
const merges = new Map<string, { name: string; triangles: number; vertices: number }[]>();

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`missing mesh ${name}`);
  return found;
}
/** The window frame's strips as built, in build order: the lining (a side each, or once across the centreline), then the sill caps. */
function frameStripNames(): string[] {
  const lining = bizjetLiningStrips().flatMap((strip) => (strip.centre ? [bizjetLiningMeshName(strip, -1)] : [bizjetLiningMeshName(strip, -1), bizjetLiningMeshName(strip, 1)]));
  const caps = ([-1, 1] as const).flatMap((side) => BIZJET_SILL_CAP.sills.map((sill) => bizjetSillCapMeshName(sill, side)));
  return [...lining, ...caps];
}
function panel(name: string): Panel {
  const found = panels.find((p) => p.name === name);
  if (!found) throw new Error(`no skin panel ${name} was built`);
  return found;
}
/** A captured skin panel's grid vertex: face 0 is the outer face, 1 the inner (`skinPanel` writes them in that order). */
function gridVertex(p: Panel, face: 0 | 1, row: number, column: number): Vector3 {
  const i = (face * p.rows * p.columns + row * p.columns + column) * 3;
  return new Vector3(p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!);
}
/** A pane's (or the post's) grid point ON THE SKIN: the hole the pane makes in it, which the lining frames. */
function skinVertex(p: Panel, row: number, column: number): Vector3 {
  return Vector3.Lerp(gridVertex(p, 0, row, column), gridVertex(p, 1, row, column), GLOBAL_PANE_PROUD / (GLOBAL_PANE_PROUD + GLOBAL_PANE_DEPTH));
}
/** A lining strip's grid point ON THE SKIN: its slab stands BIZJET_LINING.proud out and .depth in. */
function liningSkinVertex(p: Panel, row: number, column: number): Vector3 {
  return Vector3.Lerp(gridVertex(p, 0, row, column), gridVertex(p, 1, row, column), BIZJET_LINING.proud / (BIZJET_LINING.proud + BIZJET_LINING.depth));
}
/** One face of a captured skin panel as triangles, rims left out; "skin" is the grid on the skin (the pane's or the lining's). */
function faceTriangles(p: Panel, face: 0 | 1 | "skin"): Triangle[] {
  const onSkin = /bizjet-lining-/.test(p.name) ? liningSkinVertex : skinVertex;
  const v = (r: number, c: number) => (face === "skin" ? onSkin(p, r, c) : gridVertex(p, face, r, c));
  const out: Triangle[] = [];
  for (let row = 0; row < p.rows - 1; row += 1) {
    for (let column = 0; column < p.columns - 1; column += 1) {
      out.push({ a: v(row, column), b: v(row, column + 1), c: v(row + 1, column) });
      out.push({ a: v(row, column + 1), b: v(row + 1, column + 1), c: v(row + 1, column) });
    }
  }
  return out;
}
/** Points along one edge of a captured panel's face, the chords between grid points sampled `per` times. */
function edgePoints(p: Panel, face: 0 | 1 | "skin", edge: "bottom" | "top" | "inboard" | "outboard", per = 8): Vector3[] {
  const at = (row: number, column: number) => (face === "skin" ? skinVertex(p, row, column) : gridVertex(p, face, row, column));
  const grid: Vector3[] = [];
  if (edge === "bottom" || edge === "top") {
    const row = edge === "bottom" ? 0 : p.rows - 1;
    for (let column = 0; column < p.columns; column += 1) grid.push(at(row, column));
  } else {
    const column = edge === "inboard" ? 0 : p.columns - 1;
    for (let row = 0; row < p.rows; row += 1) grid.push(at(row, column));
  }
  const out: Vector3[] = [];
  for (let k = 0; k + 1 < grid.length; k += 1) {
    for (let s = 0; s < per; s += 1) out.push(Vector3.Lerp(grid[k]!, grid[k + 1]!, s / per));
  }
  out.push(grid.at(-1)!);
  return out;
}
let paneEdgeSamples: Vector3[] | null = null;
/** How far a point is from the nearest edge of any pane's hole in the skin (the panes' own grids, sampled every 5 mm or so). */
function distanceToPaneEdge(point: Vector3): number {
  paneEdgeSamples ??= (["port", "starboard"] as const).flatMap((side) => GLOBAL_FLIGHT_DECK_OUTLINES.flatMap((outline) =>
    (["bottom", "top", "inboard", "outboard"] as const).flatMap((edge) => edgePoints(panel(`${side}-bizjet-flight-deck-window-${outline.name}`), "skin", edge, 24))));
  let best = Number.POSITIVE_INFINITY;
  for (const q of paneEdgeSamples) best = Math.min(best, Vector3.Distance(point, q));
  return best;
}
function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!data) return [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}
function azel(point: Vector3, from: Vector3 = EYE_POINT): { az: number; el: number } {
  const d = point.subtract(from);
  return { az: Math.atan2(d.z, d.x) * DEG, el: Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEG };
}
function direction(azimuth: number, elevation: number): Vector3 {
  const a = azimuth / DEG;
  const e = elevation / DEG;
  return new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
}
/** Inside the 16:9 frame: the image plane's own rectangle, not a box of angles. */
function inFrame(azimuth: number, elevation: number): boolean {
  if (Math.abs(azimuth) >= 89) return false;
  const u = Math.tan(azimuth / DEG);
  const v = Math.tan(elevation / DEG) / Math.cos(azimuth / DEG);
  return Math.abs(u) <= FRAME_U && Math.abs(v) <= FRAME_V;
}
/** What the cockpit camera would draw: enabled, visible, on a layer it renders, opaque. */
function drawnByCockpitCamera(mesh: AbstractMesh): boolean {
  const material = mesh.material as PBRMaterial | null;
  return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
    && !(material?.needAlphaBlendingForMesh(mesh) ?? false) && mesh.getTotalVertices() > 0;
}
/**
 * Babylon's picking ignores back-face culling, and the Global's fuselage is DRAWN in cockpit view with the eye inside
 * it, so a ray that ignored culling would meet the inside of the skin everywhere and never see the sky. The winding
 * sign is calibrated on a closed convex solid (the lip's wedge): the sign that meets it from outside and misses it from
 * inside is the one for which "front-facing" means what the renderer means.
 */
let cullSign = 0;
function frontFacing(sign: number) {
  return (p0: Vector3, p1: Vector3, p2: Vector3, ray: Ray): boolean =>
    sign * Vector3.Dot(Vector3.Cross(p1.subtract(p0), p2.subtract(p0)), ray.direction) < 0;
}
function calibrateCulling(): number {
  const control = named("bizjet-glareshield");
  const centre = worldVertices(control).reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / control.getTotalVertices());
  const hits = (origin: Vector3, sign: number) =>
    (scene.multiPickWithRay(new Ray(origin, new Vector3(1, 0, 0), 50), (m) => m === control, frontFacing(sign))?.length ?? 0) > 0;
  let found = 0;
  for (const sign of [1, -1]) if (hits(centre.add(new Vector3(-2, 0, 0)), sign) && !hits(centre, sign)) found = sign;
  return found;
}
interface Hit { mesh: AbstractMesh; faceId: number; distance: number }
/** The first surface the cockpit camera draws along a ray from `from`, honouring each material's culling. */
function firstHitAlong(d: Vector3, from: Vector3 = EYE_POINT): Hit | null {
  const ray = new Ray(from, d.normalizeToNew(), 60);
  const culls = (mesh: AbstractMesh) => (mesh.material as PBRMaterial | null)?.backFaceCulling ?? false;
  // Two passes, because the triangle predicate is per pick and only some meshes cull.
  const culled = scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && culls(m), frontFacing(cullSign)) ?? [];
  const open = scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && !culls(m)) ?? [];
  let best: Hit | null = null;
  for (const hit of [...culled, ...open]) {
    if (hit.hit && hit.pickedMesh && (best === null || hit.distance < best.distance)) best = { mesh: hit.pickedMesh, faceId: hit.faceId, distance: hit.distance };
  }
  return best;
}
/**
 * The first drawn surface along a sightline and its SHADING normal there: the hit triangle's vertex normals interpolated
 * at the hit (outward), which is what the surface is shaded with. A flat-shaded face's is its own; a smoothed round's
 * turns across each chord.
 */
function shadedAt(azimuth: number, elevation: number): { mesh: string; point: Vector3; normal: Vector3 } | null {
  const ray = new Ray(EYE_POINT, direction(azimuth, elevation), 60);
  const culls = (mesh: AbstractMesh) => (mesh.material as PBRMaterial | null)?.backFaceCulling ?? false;
  const hits = [
    ...(scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && culls(m), frontFacing(cullSign)) ?? []),
    ...(scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && !culls(m)) ?? []),
  ].filter((h) => h.hit && h.pickedMesh).sort((a, b) => a.distance - b.distance);
  const hit = hits[0];
  if (!hit) return null;
  const mesh = hit.pickedMesh!;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const indices = mesh.getIndices()!;
  // Babylon's own weights (`PickingInfo.getNormal`): bu on the first corner, bv on the second, the rest on the third
  const weights = [hit.bu, hit.bv, 1 - hit.bu - hit.bv];
  let normal = Vector3.Zero();
  for (let k = 0; k < 3; k += 1) {
    const i = indices[hit.faceId * 3 + k]! * 3;
    normal = normal.add(new Vector3(normals[i]!, normals[i + 1]!, normals[i + 2]!).scale(weights[k]!));
  }
  return { mesh: mesh.name, point: EYE_POINT.add(ray.direction.scale(hit.distance)), normal: Vector3.TransformNormal(normal, mesh.getWorldMatrix()).normalize() };
}
/** The elevation at which a line along z through body (x, y) crosses azimuth `az` from the eye (a level line reads flatter off-centre). */
function lineElevation(v: { x: number; y: number }, az: number): number {
  return Math.atan2((v.y - EYE.up) * Math.cos(az / DEG), v.x - EYE.forward) * DEG;
}
/** One pixel of a 1920 x 1080 frame at the 75 degree lens, at the frame's centre, in degrees. */
const PIXEL_1080P = Math.atan(1 / (960 / Math.tan(37.5 / DEG))) * DEG;
/** Where a ray from the eye leaves the body: its last crossing of the fuselage (the body is star-shaped from the seat). */
function skinExit(d: Vector3): number {
  return crossings(EYE_POINT, d.normalizeToNew(), shell).at(-1) ?? Number.NaN;
}
/** The first drawn surface INSIDE the skin: the kit or nothing (what shows through culled skin is the world outside). */
/**
 * The first drawn surface INSIDE the skin: the kit or nothing (what shows through culled skin is the world outside). The
 * lining lies ON the skin, its slab straddling it, and where the skin is concave (part 4's nose runs straight from the
 * post's foot, a crease under the windshield) a chord of it stands a millimetre or two OUTSIDE: the skin is culled
 * from inside, so it still covers the view. A lining hit counts, then, wherever it lies within the lining's own proud
 * of the skin, measured normal to it, whichever side.
 */
function kitHit(azimuth: number, elevation: number): Hit | null {
  const d = direction(azimuth, elevation);
  const hit = firstHitAlong(d);
  if (!hit) return null;
  if (hit.distance < skinExit(d) - 1e-4) return hit;
  const onSkin = hit.mesh.name === "bizjet-cockpit-interior" && /bizjet-lining-/.test(partOf(hit.mesh, hit.faceId))
    && distanceToTriangles(EYE_POINT.add(d.scale(hit.distance)), shell) <= BIZJET_LINING.proud + 1e-4;
  return onSkin ? hit : null;
}
/** How far inside the skin a point along a ray from the eye is, normal to the skin: negative outside it. */
function insideSkin(d: Vector3, distance: number): number {
  const off = distanceToTriangles(EYE_POINT.add(d.scale(distance)), shell);
  return distance < skinExit(d) ? off : -off;
}
/**
 * The deck's straight half-width: the board's, which the glareshield's straight part shares. Its END ROUNDS (S4) stand
 * `endRound` outboard of it, so the glareshield's own widest vertex is not the deck's width.
 */
function deckHalfWidth(): number {
  return Math.max(...worldVertices(named("bizjet-cockpit-interior")).slice(0, 24).map((v) => Math.abs(v.z)));
}
/** Which authored part of a merged mesh a picked triangle belongs to (an unmerged mesh is its own part). */
function partOf(mesh: AbstractMesh, faceId: number): string {
  const sources = merges.get(mesh.name);
  // the glareshield's straight part and its end rounds are one lip
  if (!sources || mesh.name === "bizjet-glareshield") return mesh.name;
  let start = 0;
  for (const source of sources) {
    if (faceId < start + source.triangles) return source.name;
    start += source.triangles;
  }
  throw new Error(`face ${faceId} is beyond ${mesh.name}`);
}
/** The vertex indices of the sources of a merged mesh whose names match `which`, in the merge's own order. */
function sourceIndices(meshName: string, which: RegExp): number[] {
  const out: number[] = [];
  let start = 0;
  for (const source of merges.get(meshName)!) {
    if (which.test(source.name)) for (let k = 0; k < source.vertices; k += 1) out.push(start + k);
    start += source.vertices;
  }
  return out;
}
/** The world vertices of the sources of a merged mesh whose names match `which`, by the merge's own vertex order. */
function sourceVertices(meshName: string, which: RegExp): Vector3[] {
  const all = worldVertices(named(meshName));
  const out: Vector3[] = [];
  let start = 0;
  for (const source of merges.get(meshName)!) {
    if (which.test(source.name)) out.push(...all.slice(start, start + source.vertices));
    start += source.vertices;
  }
  return out;
}
function firstPart(azimuth: number, elevation: number): string | null {
  const hit = kitHit(azimuth, elevation);
  return hit ? partOf(hit.mesh, hit.faceId) : null;
}
/** What a sightline from the eye leaves the body through: a pane's hole in the skin, the post's, or skin. */
let holes: { name: string; what: "glass" | "post"; skin: Triangle[] }[] = [];
function exitsThrough(azimuth: number, elevation: number, from: Vector3 = EYE_POINT): { what: "glass" | "post" | "skin"; pane: string | null } {
  if (holes.length === 0) {
    holes = panels
      .filter((p) => /flight-deck-window|windscreen-center-post/.test(p.name))
      .map((p) => ({ name: p.name, what: /post/.test(p.name) ? "post" as const : "glass" as const, skin: faceTriangles(p, "skin") }));
    expect(holes, "six panes and the post").toHaveLength(7);
  }
  const d = direction(azimuth, elevation);
  for (const hole of holes) if (crossings(from, d, hole.skin).length > 0) return { what: hole.what, pane: hole.name };
  return { what: "skin", pane: null };
}
/** The lip's top edge as the pilot reads it along an azimuth: a line along z at the face, so its elevation is exact. */
function lipElevation(azimuth: number): number {
  return Math.atan2((bizjetLipY() - EYE.up) * Math.cos(azimuth / DEG), bizjetPanelFaceX() - EYE.forward) * DEG;
}
/** The port windshield's run of elevation along an azimuth from `from`, through its skin hole, in 0.05 degree steps. */
function windshieldRun(azimuth: number, from: Vector3 = EYE_POINT): { from: number; to: number } | null {
  const hole = faceTriangles(panel("port-bizjet-flight-deck-window-windshield"), "skin");
  let run: { from: number; to: number } | null = null;
  let best: { from: number; to: number } | null = null;
  for (let el = -45; el <= 45 + 1e-9; el += 0.05) {
    const inside = crossings(from, direction(azimuth, el), hole).length > 0;
    if (inside) run = run ? { from: run.from, to: el } : { from: el, to: el };
    if ((!inside || el > 45 - 0.05) && run) {
      if (!best || run.to - run.from > best.to - best.from) best = run;
      run = null;
    }
  }
  return best;
}
/**
 * WHERE THE PILOT SEES THE GLASS BEGIN over the sills: along the chords the strip table marks as glass, on every sill
 * built, the steepest-up point from the eye of the WINDOW TRIM's section there (S3). Through S4 it was the sill's rim,
 * the higher of its inner and outer edge; the trim now rolls the sill's inner face into the glass (`bizjetTrimSection`),
 * or on a capped side sill its cove seal climbs the glass (`bizjetCoveSection`), laid out as the kit lays it: `into`
 * square to the skin normal and the edge, away from the sill, the normal from the strip's own faces (the outer on the
 * skin, the inner BIZJET_LINING.depth in). A corner's arc only raises the trim further, so this is the lower bound.
 */
function sillRims(per = 20): Vector3[] {
  const out: Vector3[] = [];
  const slope = (p: Vector3) => (p.y - EYE.up) / (p.x - EYE.forward);
  const trim = bizjetTrimSection();
  const rolled = [...trim.round, ...trim.bead];
  const cove = bizjetCoveSection();
  for (const strip of bizjetLiningStrips().filter((s) => s.name.startsWith("sill-"))) {
    const section = (BIZJET_SILL_CAP.sills as readonly string[]).includes(strip.name) ? cove : rolled;
    for (const side of strip.centre ? [-1 as const] : [-1 as const, 1 as const]) {
      const p = panel(bizjetLiningMeshName(strip, side));
      const top = p.rows - 1;
      const lerp = (face: 0 | 1, row: number, k: number, f: number) => Vector3.Lerp(gridVertex(p, face, row, k), gridVertex(p, face, row, k + 1), f);
      for (const k of strip.glassChords) {
        const along = gridVertex(p, 0, top, k + 1).subtract(gridVertex(p, 0, top, k)).normalize();
        for (let s = 0; s <= per; s += 1) {
          const onSkin = lerp(0, top, k, s / per);
          const normal = onSkin.subtract(lerp(1, top, k, s / per)).normalize();
          let into = Vector3.Cross(normal, along).normalize();
          if (Vector3.Dot(into, onSkin.subtract(lerp(0, top - 1, k, s / per))) < 0) into = into.negate();
          const candidates = section.map((q) => onSkin.add(into.scale(q.a)).subtract(normal.scale(q.h)));
          out.push(candidates.reduce((best, c) => (slope(c) > slope(best) ? c : best)));
        }
      }
    }
  }
  return out;
}
/**
 * Cells of a 60 x 34 grid over the 16:9 frame whose first drawn surface is `name`; with `insideOnly`, only where that
 * surface is met before the ray has left the body (its first crossing of the shell): a face of the shell drawn toward
 * the pilot from INSIDE, not the nose's outside seen through the glass, which an eye high enough over it can see.
 */
function frameCells(name: string, insideOnly = false): { hits: number; total: number } {
  let hits = 0;
  let total = 0;
  for (let j = 0; j < 34; j += 1) {
    const v = (1 - ((j + 0.5) / 34) * 2) * FRAME_V;
    for (let i = 0; i < 60; i += 1) {
      const u = (((i + 0.5) / 60) * 2 - 1) * FRAME_U;
      total += 1;
      const d = new Vector3(1, v, u);
      const hit = firstHitAlong(d);
      if (hit?.mesh.name !== name) continue;
      if (insideOnly && hit.distance > (crossings(EYE_POINT, d.normalizeToNew(), shell)[0] ?? Number.POSITIVE_INFINITY) + 1e-4) continue;
      hits += 1;
    }
  }
  return { hits, total };
}

beforeAll(() => {
  const original = AircraftBuildContext.prototype.skinPanel;
  const spy = vi.spyOn(AircraftBuildContext.prototype, "skinPanel").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof original>) {
      const mesh = original.apply(this, args);
      panels.push({
        name: args[0],
        rows: args[1].length,
        columns: args[1][0]!.length,
        positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!),
        triangles: mesh.getTotalIndices() / 3,
      });
      return mesh;
    },
  );
  const originalMerge = AircraftBuildContext.prototype.mergeStatic;
  const mergeSpy = vi.spyOn(AircraftBuildContext.prototype, "mergeStatic").mockImplementation(
    function (this: AircraftBuildContext, ...args: Parameters<typeof originalMerge>) {
      merges.set(args[0], args[1].map((source) => ({ name: source.name, triangles: source.getTotalIndices() / 3, vertices: source.getTotalVertices() })));
      return originalMerge.apply(this, args);
    },
  );
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "bizjet");
  spy.mockRestore();
  mergeSpy.mockRestore();
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
  fuselage = named("bizjet-fuselage");
  expect(fuselage.getWorldMatrix().isIdentity(), "the fuselage's vertices are body metres").toBe(true);
  shell = worldTriangles(fuselage);
  cullSign = calibrateCulling();
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the rays this file believes", () => {
  it("calibrate back-face culling on a closed solid, and see the fuselage drawn and culled from inside", () => {
    // If neither winding sign meets the lip's wedge from outside and misses it from inside, every reading below is void.
    expect([1, -1]).toContain(cullSign);
    expect(drawnByCockpitCamera(fuselage)).toBe(true);
    expect((fuselage.material as PBRMaterial).backFaceCulling).toBe(true);
    const up = scene.pickWithRay(new Ray(EYE_POINT, new Vector3(0, 1, 0), 5), (m) => m === fuselage);
    expect(up?.hit, "picking, which ignores culling, does see the skin").toBe(true);
    expect(firstHitAlong(new Vector3(0, 1, 0))?.mesh.name).not.toBe("bizjet-fuselage");
    // and from OUTSIDE, looking down on the roof, the same predicate finds its face
    const outside = scene.multiPickWithRay(new Ray(new Vector3(EYE.forward, 5, EYE.right), new Vector3(0, -1, 0), 10), (m) => m === fuselage, frontFacing(cullSign));
    expect(outside?.length, "the roof seen from above").toBe(1);
  });
});

describe("the glass the kit is built against", () => {
  it("is the corner table's, read off the built panes: six panes and the post, mirror images, the post filling the windshields' gap", () => {
    // THE CORNER TABLE, as `scripts/airliner-glazing-table.mts --airframe bizjet` prints it: each pane's grid corners on
    // its outer and inner faces. Computed here from the panes as built, so it is the table of whatever nose this is.
    const corners = (p: Panel, face: 0 | 1) => [gridVertex(p, face, 0, 0), gridVertex(p, face, 0, p.columns - 1), gridVertex(p, face, p.rows - 1, p.columns - 1), gridVertex(p, face, p.rows - 1, 0)];
    const table: string[] = [];
    for (const outline of GLOBAL_FLIGHT_DECK_OUTLINES) {
      const port = panel(`port-bizjet-flight-deck-window-${outline.name}`);
      const starboard = panel(`starboard-bizjet-flight-deck-window-${outline.name}`);
      expect([port.rows, port.columns], `${outline.name}: the panes' own grid`).toEqual([PANE_GRID, PANE_GRID]);
      for (const face of [0, 1] as const) {
        const [a, b] = [corners(port, face), corners(starboard, face)];
        for (let k = 0; k < 4; k += 1) {
          // mirror images across the centreline, to the facets' asymmetry: a quad's diagonal does not mirror, and the
          // steeper the nose the more its quads bend about it (a corner reads 2 mm on c252859's nose, 9.3 on 8d5deeb's)
          expect(Vector3.Distance(a[k]!, new Vector3(b[k]!.x, b[k]!.y, -b[k]!.z)), `${outline.name} corner ${k} mirrored`).toBeLessThan(0.015);
          expect(a[k]!.z, "port is negative z").toBeLessThan(0);
        }
      }
      table.push(`${outline.name}: ${corners(port, 0).map((v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`).join(" ")}`);
    }
    console.info(`the Global's corner table, port outer faces (bottom-inboard, bottom-outboard, top-outboard, top-inboard):\n  ${table.join("\n  ")}`);
    // THE POST fills the gap between the windshields: its outer columns are the windshields' inboard edges on the skin,
    // and a third runs up the V's ridge between them (phase 3c, part 6: on two, a chord under the ridge put it inside)
    const post = panel("bizjet-windscreen-center-post");
    expect(post.columns).toBe(3);
    for (let row = 0; row < post.rows; row += 1) expect(Math.abs(skinVertex(post, row, 1).z), "the post's middle column on the centreline").toBeLessThan(1e-6);
    expect(GLOBAL_CENTRE_POST.halfAngle).toBe(GLOBAL_FLIGHT_DECK_OUTLINES[0]!.bottom[0]![1]);
    expect(GLOBAL_CENTRE_POST.aft).toEqual([GLOBAL_FLIGHT_DECK_OUTLINES[0]!.bottom[0]![0], GLOBAL_FLIGHT_DECK_OUTLINES[0]!.top[0]![0]]);
    const port = panel("port-bizjet-flight-deck-window-windshield");
    for (const row of [0, post.rows - 1]) {
      const edgeRow = row === 0 ? 0 : port.rows - 1;
      expect(Vector3.Distance(skinVertex(post, row, 0), skinVertex(port, edgeRow, 0)), "the post's port edge is the windshield's inboard edge").toBeLessThan(0.002);
    }
  });
});

describe("the Global's eye", () => {
  it("reads the BUILT glass as the targets ask: straight ahead inside the port windshield, the opening and the top edge", () => {
    const run = windshieldRun(0);
    expect(run, "the port windshield straight ahead").not.toBeNull();
    console.info(`the Global from (${EYE.forward}, ${EYE.up}, ${EYE.right}): the windshield straight ahead ${run!.from.toFixed(2)}..${run!.to.toFixed(2)} (${(run!.to - run!.from).toFixed(2)} deg)`);
    expect(run!.from, "straight ahead is inside the glass: its bottom is under the horizon").toBeLessThan(0);
    expect(run!.to, "the top edge straight ahead").toBeGreaterThanOrEqual(TARGETS.topEdge);
    expect(run!.to - run!.from, "the opening straight ahead").toBeGreaterThanOrEqual(TARGETS.opening);
  });

  it("has both windshields' tops above the horizon: the port pane's two top corners, and the starboard pane's at the post", () => {
    // Part 3's windshield fell from +14 at its outboard top to +1.3 at the post, so the right-hand windshield sat below
    // the horizon and the right-centre of the frame above it was roof (K2). The corners on the skin, from the eye; column 0
    // of either pane is its inboard edge, at the post.
    const top = (name: string, column: "inboard" | "outboard") => {
      const pane = panel(name);
      return azel(skinVertex(pane, pane.rows - 1, column === "inboard" ? 0 : pane.columns - 1)).el;
    };
    const inboard = top("port-bizjet-flight-deck-window-windshield", "inboard");
    const outboard = top("port-bizjet-flight-deck-window-windshield", "outboard");
    const starboard = top("starboard-bizjet-flight-deck-window-windshield", "inboard");
    console.info(`the Global's windshield tops from the eye: port inboard (at the post) ${inboard.toFixed(2)}, port outboard ${outboard.toFixed(2)}, starboard at the post ${starboard.toFixed(2)}`);
    expect(inboard, "the port pane's top corner at the post").toBeGreaterThanOrEqual(TARGETS.topCorners);
    expect(outboard, "the port pane's top corner outboard").toBeGreaterThanOrEqual(TARGETS.topCorners);
    expect(starboard, "the starboard pane's top at the post").toBeGreaterThanOrEqual(TARGETS.starboardTopAtPost);
  });

  it("stands the centre post's head above the horizon from the seat: at least the target, reported against the goal", () => {
    // The head is the middle of the post's grid at its top row, on the skin; the rise (head y less foot y) is reported.
    const post = panel("bizjet-windscreen-center-post");
    const centre = (row: number) => Vector3.Lerp(skinVertex(post, row, 0), skinVertex(post, row, post.columns - 1), 0.5);
    const [foot, head] = [centre(0), centre(post.rows - 1)];
    const el = azel(head).el;
    console.info(`the Global's centre post on the skin: foot y ${foot.y.toFixed(3)}, head y ${head.y.toFixed(3)} (rises ${(head.y - foot.y).toFixed(3)} m, ${Vector3.Distance(foot, head).toFixed(3)} along it); head from the eye ${el.toFixed(2)} (goal ${TARGETS.postHeadGoal})`);
    expect(el, "the post's head from the eye").toBeGreaterThanOrEqual(TARGETS.postHead);
  });

  it("reads the glass by the same instrument that a second one agrees with, from two eyes (the control)", () => {
    // The windshield's top straight ahead two ways: the run of rays through its hole, and the top edge's own chord where
    // it crosses the vertical plane through the eye at azimuth 0. They must agree whatever the eye.
    const port = panel("port-bizjet-flight-deck-window-windshield");
    const top = edgePoints(port, "skin", "top", 40);
    for (const from of [EYE_POINT, new Vector3(EYE.forward, EYE.up + 0.06, EYE.right)]) {
      const crossing = top.findIndex((p, k) => k > 0 && Math.sign(p.z - from.z) !== Math.sign(top[k - 1]!.z - from.z));
      expect(crossing, "the top edge crosses straight ahead").toBeGreaterThan(0);
      const [a, b] = [top[crossing - 1]!, top[crossing]!];
      const t = (from.z - a.z) / (b.z - a.z);
      const edge = azel(Vector3.Lerp(a, b, t), from).el;
      expect(Math.abs(windshieldRun(0, from)!.to - edge), `two instruments from y ${from.y.toFixed(2)}`).toBeLessThan(0.1);
    }
  });

  it("sees the whole centre post in the frame from the seat", () => {
    const post = panel("bizjet-windscreen-center-post");
    const out: string[] = [];
    for (let row = 0; row < post.rows; row += 1) {
      for (let column = 0; column < post.columns; column += 1) {
        const { az, el } = azel(skinVertex(post, row, column));
        if (!inFrame(az, el)) out.push(`(${az.toFixed(1)}, ${el.toFixed(1)})`);
      }
    }
    const reading = [0, post.rows - 1].map((row) => azel(Vector3.Lerp(skinVertex(post, row, 0), skinVertex(post, row, 1), 0.5)));
    console.info(`the Global's centre post from the eye: foot az ${reading[0]!.az.toFixed(1)} el ${reading[0]!.el.toFixed(1)}, head az ${reading[1]!.az.toFixed(1)} el ${reading[1]!.el.toFixed(1)}`);
    expect(out, "post corners outside the 16:9 frame").toEqual([]);
  });

  it("has the seats around it: both pairs 0.05 m aft of the eye, the pilot's on the eye's z, headrests behind, symmetric", () => {
    const at = (name: string) => named(name).getBoundingInfo().boundingBox.centerWorld;
    const port = at("bizjet-first-officer-seat");
    const starboard = at("bizjet-captain-seat");
    expect(port.z).toBeCloseTo(EYE.right, 6);
    expect(EYE.forward - port.x).toBeGreaterThan(0.04);
    expect(EYE.forward - port.x).toBeLessThan(0.06);
    expect(starboard.x).toBeCloseTo(port.x, 6);
    expect(starboard.z).toBeCloseTo(-port.z, 6);
    const portHeadrest = at("bizjet-first-officer-headrest");
    expect(at("bizjet-captain-headrest").x).toBeCloseTo(portHeadrest.x, 6);
    expect(portHeadrest.x).toBeCloseTo(port.x - 0.28, 2);
  });
});

describe("the Global's cockpit parts", () => {
  it("are nine static meshes: the glareshield and its cove's fillet, the board and the window frame as one, the screens, their frames, rims and wells, the side consoles, the window seals", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual(["bizjet-cockpit-interior", "bizjet-cove-fillet", "bizjet-glareshield", "bizjet-screen-bezel-rims", "bizjet-screen-bezels", "bizjet-screen-wells", "bizjet-screens", "bizjet-side-consoles", "bizjet-window-seals"]);
    // the interior is the board, every lining strip the strip table names (a side each or once across the centreline),
    // the two side sills' caps a side, and the window trim (S3): a pane's round, then its corners' pockets, four round a
    // windshield and two round a side pane (its bottom corners are the ledge's)
    const panes = ["windshield", "forward-side", "aft-side"] as const;
    const pockets = { "windshield": 4, "forward-side": 2, "aft-side": 2 } as const;
    const trim = (["port", "starboard"] as const).flatMap((side) => panes.flatMap((pane) => [`${side}-bizjet-trim-${pane}`, ...Array.from({ length: pockets[pane] }, (_, k) => `${side}-bizjet-trim-${pane}-pocket-${k}`)]));
    // and the pillars' feet (C), filleted onto the forward side sills' caps
    const caps = frameStripNames().filter((name) => /-cap-/.test(name));
    const strips = frameStripNames().filter((name) => !/-cap-/.test(name));
    expect((named("bizjet-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom).toEqual(["bizjet-instrument-panel", ...strips, ...trim, "port-bizjet-pillar-foot", "starboard-bizjet-pillar-foot"]);
    // the consoles (S5): each side's top and inboard face (a smooth sheet) and what is under them, then the caps, on
    // their own instance of the interior material
    expect((named("bizjet-side-consoles").metadata as { mergedFrom: string[] }).mergedFrom).toEqual([
      "bizjet-side-console-port", "bizjet-side-console-port-under", "bizjet-side-console-starboard", "bizjet-side-console-starboard-under", ...caps,
    ]);
    // the seals: a pane's bead, closed round a windshield; round a side pane an open run capped at each end, and the
    // cove along its ledge, capped too
    const capped = (name: string) => [name, `${name}-start`, `${name}-end`];
    const seals = (["port", "starboard"] as const).flatMap((side) => panes.flatMap((pane) => (pane === "windshield"
      ? [`${side}-bizjet-seal-${pane}`]
      : [...capped(`${side}-bizjet-seal-${pane}`), ...capped(`${side}-bizjet-seal-${pane}-cove`)])));
    // and the tillers on the consoles' tops (S5), on the seals' matte
    expect((named("bizjet-window-seals").metadata as { mergedFrom: string[] }).mergedFrom).toEqual([...seals, "bizjet-console-tiller-port", "bizjet-console-tiller-starboard"]);
    // the glareshield alone on its mesh, one solidPlate: the aft face's foot (none with no drop: the round runs into the
    // cove), the cove's, the hood's forward end (two corners), and the round's chords with a vertex on the deck line's
    // tangent (two fanned caps, and each side of the outline a wall of two)
    // (S4: the straight part and its two end rounds, merged, one draw)
    expect((named("bizjet-glareshield").metadata as { mergedFrom?: string[] } | null)?.mergedFrom).toEqual(["bizjet-glareshield-straight", "bizjet-glareshield-end-port", "bizjet-glareshield-end-starboard"]);
    const sides = bizjetGlareshieldSection().outline.length;
    expect(sides).toBe((BIZJET_GLARESHIELD.drop > 0 ? 4 : 3) + BIZJET_GLARESHIELD.roundSegments + 2 + BIZJET_GLARESHIELD.jointSegments);
    // the straight part's prism, then each end round: its walls a band of quads between stations (the tip's band a fan,
    // its first triangles degenerate) and the deck-end cap; the tip cap is a point
    const n = sides;
    const N = BIZJET_GLARESHIELD.endStations;
    expect(named("bizjet-glareshield").getTotalIndices() / 3).toBe(2 * (sides - 2) + 2 * sides + 2 * (2 * n * N - n + (n - 2)));
    // five screens (the pairs and the standby, S5) and their wells; their frames and the consoles' panel blocks; their rims
    // and the blocks' rockers
    const screens = ["port-outboard", "port-inboard", "starboard-outboard", "starboard-inboard", "standby"];
    expect(named("bizjet-screens").metadata?.mergedFrom).toEqual(screens.map((n) => `bizjet-screen-${n}`));
    expect(named("bizjet-screen-wells").metadata?.mergedFrom).toEqual(screens.map((n) => `bizjet-screen-well-${n}`));
    expect(named("bizjet-screen-bezels").metadata?.mergedFrom).toEqual([...screens.map((n) => `bizjet-screen-bezel-${n}`), "bizjet-console-block-port", "bizjet-console-block-starboard"]);
    expect(named("bizjet-screen-bezel-rims").metadata?.mergedFrom).toEqual([
      ...screens.map((n) => `bizjet-screen-bezel-rim-${n}`),
      "bizjet-console-rocker-port-0", "bizjet-console-rocker-port-1", "bizjet-console-rocker-starboard-0", "bizjet-console-rocker-starboard-1",
    ]);
    // a bezel's rim is a closed solid of 16 quads (a front, an outer wall, a back and an inner wall a side); its frame is a U
    // of 12, round the sides and the foot: its top has no flat band (S2), and the rim's own inner wall closes the recess there
    for (const n of screens) {
      expect(merges.get("bizjet-screen-bezels")!.find((m) => m.name === `bizjet-screen-bezel-${n}`)!.triangles, n).toBe(12 * 2);
      expect(merges.get("bizjet-screen-bezel-rims")!.find((m) => m.name === `bizjet-screen-bezel-rim-${n}`)!.triangles, n).toBe(16 * 2);
    }
    // a merged mesh's triangles are its sources', in order, so `partOf` can name any of them
    for (const name of ["bizjet-cockpit-interior", "bizjet-window-seals", "bizjet-side-consoles", "bizjet-screen-bezels", "bizjet-screen-bezel-rims"]) {
      expect(merges.get(name)!.reduce((sum, source) => sum + source.triangles, 0), name).toBe(named(name).getTotalIndices() / 3);
    }
    expect(merges.get("bizjet-cockpit-interior")!.map((source) => source.name)).toEqual((named("bizjet-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom);
  });

  it("put the lip on the glareshield's own matte near-black, the frame on the interior, the bezels on their own, the rims on the glowing marking", () => {
    const lip = named("bizjet-glareshield").material as PBRMaterial;
    const interior = named("bizjet-cockpit-interior").material as PBRMaterial;
    expect(lip).not.toBe(interior);
    // the consoles and the caps (S5): a second instance of the interior, its parameters at `tone` of its albedo, so their
    // sky-lit tops read near the board (P0: 84 to 99 against 48, the design's bound 1.3 times); no third material
    const consoles = named("bizjet-side-consoles").material as PBRMaterial;
    expect(consoles).not.toBe(interior);
    expect(BIZJET_SIDE_CONSOLE.tone).toBeLessThan(1);
    for (const channel of ["r", "g", "b"] as const) {
      expect(consoles.albedoColor[channel]).toBeCloseTo(interior.albedoColor[channel] * BIZJET_SIDE_CONSOLE.tone, 2);
    }
    expect([consoles.roughness, consoles.metallic]).toEqual([interior.roughness, interior.metallic]);
    for (const channel of [lip.albedoColor.r, lip.albedoColor.g, lip.albedoColor.b]) {
      expect(channel).toBeGreaterThan(0.03);
      expect(channel).toBeLessThan(0.08);
    }
    expect(lip.roughness).toBeGreaterThanOrEqual(0.99);
    expect(lip.clearCoat.isEnabled).toBe(false);
    expect(lip.environmentIntensity, "lit by the sky's image light; F0 zero keeps it from reflecting the sky").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect(lip.metallicF0Factor).toBe(0);
    const luma = (m: PBRMaterial) => m.albedoColor.r + m.albedoColor.g + m.albedoColor.b;
    expect(luma(lip)).toBeLessThan(luma(interior));
    expect(interior).toBe(scene.getMaterialByName("bizjet-interior"));
    // THE RIMS carry the night glow: the shared rim (`BEZEL_RIM`, the 747's too), its day emissive faint and its
    // albedo dark (tests/render.cockpit-bezel-rim.test.ts holds the material, its glow law and its day read)
    const rim = named("bizjet-screen-bezel-rims").material as PBRMaterial;
    expect(rim).toBe(scene.getMaterialByName("bizjet-instrument-marking"));
    expect(rim.emissiveIntensity).toBe(BEZEL_RIM.dayEmissiveIntensity);
    expect(rim.emissiveIntensity).toBeLessThan(0.1);
    for (const channel of [rim.albedoColor.r, rim.albedoColor.g, rim.albedoColor.b]) expect(channel).toBeLessThan(0.15);
    // THE FRAMES are on the bezels' own material, dark neutral grey, and emit NOTHING: the glow is the rim's alone
    const bezel = named("bizjet-screen-bezels").material as PBRMaterial;
    expect(bezel).toBe(scene.getMaterialByName("bizjet-bezel"));
    expect(bezel).not.toBe(rim);
    expect([bezel.emissiveColor.r, bezel.emissiveColor.g, bezel.emissiveColor.b], "the frame emits nothing").toEqual([0, 0, 0]);
    expect([bezel.roughness, bezel.metallic], "the board's finish").toEqual([interior.roughness, interior.metallic]);
    // LIGHTER THAN THE BOARD BY ALBEDO ALONE, in the design's range: with the board's finish and the board's normal, a face
    // takes the board's light, so its luma against the board's is its albedo's luminance against the board's, in linear
    // light, carried back to the frame's sRGB (the live frame is the measurement; this holds the material to the aim)
    const linear = (m: PBRMaterial) => 0.2126 * m.albedoColor.r ** 2.2 + 0.7152 * m.albedoColor.g ** 2.2 + 0.0722 * m.albedoColor.b ** 2.2;
    const ratio = (linear(bezel) / linear(interior)) ** (1 / 2.2);
    console.info(`the Global's bezels against the board, by albedo: ${ratio.toFixed(3)} in luma`);
    expect(ratio).toBeGreaterThanOrEqual(1.3);
    expect(ratio).toBeLessThanOrEqual(1.6);
    // the screens and the wells behind them: the instrument face, dark (the screens take the display where there is a canvas)
    expect(named("bizjet-screens").material).toBe(scene.getMaterialByName("bizjet-instrument-face"));
    expect(named("bizjet-screen-wells").material).toBe(scene.getMaterialByName("bizjet-instrument-face"));
  });
});

describe("the Global's cockpit camera", () => {
  it("hides the glazing and the plane engineer's post, and draws the fuselage (culled from inside) and the kit", () => {
    const hidden = [named("bizjet-flight-deck-glazing"), named("bizjet-windscreen-center-post")];
    expect(new Set(aircraft.cockpitParts)).toEqual(new Set(hidden));
    for (const part of aircraft.cockpitParts) expect(part.layerMask & camera.layerMask, part.name).toBe(0);
    expect(fuselage.isVisible).toBe(true);
    expect(fuselage.layerMask & camera.layerMask).not.toBe(0);
    // no radome: the nose is one loft with the fuselage
    expect(scene.meshes.filter((m) => /radome/.test(m.name)).map((m) => m.name)).toEqual([]);
    for (const part of cockpitOnly) {
      expect(part.isVisible, part.name).toBe(true);
      expect(part.layerMask & camera.layerMask, part.name).not.toBe(0);
      expect(part.metadata?.castsShadow, part.name).toBe(false);
      expect(part.metadata?.cockpitOnly, part.name).toBe(true);
    }
  });

  it("draws no face of the shell toward the pilot: no loft end cap, no inward face, anywhere in the frame", () => {
    // The radome's rear cap once faced the pilot, a black wall across the windscreen. The nose is one loft now, but the
    // instrument is kept: every cell of the frame whose first drawn surface is the shell would be one.
    expect(frameCells("bizjet-fuselage", true).hits).toBe(0);
    // AND THE SHELL'S CAPS by their own geometry: its x-facing planar faces, none wound toward the eye
    const caps = shell.filter((t) => {
      const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
      return n.length() > 1e-9 && Math.abs(n.x) / n.length() > 0.999;
    });
    const facing = caps.filter((t) => cullSign * Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), t.a.add(t.b).add(t.c).scale(1 / 3).subtract(EYE_POINT)) < 0);
    expect(caps.length, "the loft's end caps are there to be judged").toBeGreaterThan(0);
    expect(facing.length, "cap triangles wound toward the pilot").toBe(0);
    // POSITIVE CONTROL: the same shell wound the other way round is a face toward the pilot everywhere, and the frame
    // instrument sees it; restored, it sees none
    const mesh = fuselage as Mesh;
    const indices = [...mesh.getIndices()!];
    const reversed = [...indices];
    for (let t = 0; t < reversed.length; t += 3) [reversed[t + 1], reversed[t + 2]] = [reversed[t + 2]!, reversed[t + 1]!];
    mesh.setIndices(reversed);
    try {
      // wherever the kit does not stand in front of it, which is through every pane (the skin runs on behind the glass);
      // how many cells that is depends on the eye, so the floor is only non-vacuity
      expect(frameCells("bizjet-fuselage", true).hits, "a shell wound toward the pilot is seen").toBeGreaterThan(50);
    } finally {
      mesh.setIndices(indices);
    }
    expect(frameCells("bizjet-fuselage", true).hits).toBe(0);
  });
});

describe("the frame: the lining round the glass", () => {
  it("is watertight: wherever two strips meet, they meet at the same points (no T-junction)", () => {
    // Two strips that meet on the curved skin at DIFFERENT points each span the seam with their own chords, which part
    // by a fraction of a millimetre, and the hidden sky shows through as a bright hairline (the 747's K2). So along every
    // seam each inner-face boundary vertex of one strip within a centimetre of another's boundary is one of that
    // strip's boundary vertices, to the last bit.
    const frame = panels.filter((p) => /bizjet-lining-/.test(p.name));
    expect(frame.map((p) => p.name).sort()).toEqual(frameStripNames().sort());
    // A strip's boundary as the chords that can be a SEAM: every edge but the lining's own outer bound, a sill's bottom
    // row (R's elevation BIZJET_LINING.bottom) and a crown's top row (.top), which meet nothing. Those free edges run far
    // outside the frame, and near R's zenith the crowns' top rows all converge on a few centimetres of roof, where one
    // strip's free edge passes within a centimetre of its neighbour's without the two meeting.
    const seams = (p: Panel) => {
      const free = /-sill-/.test(p.name) ? 0 : /-crown-/.test(p.name) ? p.rows - 1 : -1;
      const chords: [Vector3, Vector3][] = [];
      const add = (r0: number, c0: number, r1: number, c1: number) => {
        if (r0 === free && r1 === free) return;
        chords.push([gridVertex(p, 1, r0, c0), gridVertex(p, 1, r1, c1)]);
      };
      for (let c = 0; c + 1 < p.columns; c += 1) { add(0, c, 0, c + 1); add(p.rows - 1, c, p.rows - 1, c + 1); }
      for (let r = 0; r + 1 < p.rows; r += 1) { add(r, 0, r + 1, 0); add(r, p.columns - 1, r + 1, p.columns - 1); }
      return chords;
    };
    const loops = frame.map((p) => {
      const chords = seams(p);
      const vertices = [...new Map(chords.flat().map((v) => [`${v.x},${v.y},${v.z}`, v])).values()];
      return { name: p.name, chords, vertices };
    });
    const toSegment = (v: Vector3, a: Vector3, b: Vector3) => {
      const ab = b.subtract(a);
      const t = Math.max(0, Math.min(1, Vector3.Dot(v.subtract(a), ab) / ab.lengthSquared()));
      return Vector3.Distance(v, a.add(ab.scale(t)));
    };
    let seamVertices = 0;
    const junctions: string[] = [];
    for (const one of loops) {
      for (const other of loops) {
        if (one === other) continue;
        for (const v of one.vertices) {
          let near = Number.POSITIVE_INFINITY;
          for (const [a, b] of other.chords) near = Math.min(near, toSegment(v, a, b));
          if (near > 0.01) continue;
          seamVertices += 1;
          if (!other.vertices.some((w) => Vector3.Distance(v, w) < 1e-9)) {
            junctions.push(`${one.name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) on ${other.name}'s edge, ${(near * 1000).toFixed(2)} mm off it`);
          }
        }
      }
    }
    expect(junctions.slice(0, 8), `${junctions.length} T-junctions`).toEqual([]);
    // NON-VACUITY: the seams were found
    expect(seamVertices).toBeGreaterThan(150);
  });

  it("runs the post's lining up the V's ridge, and shares its foot and head with the centre sill and crown, bit for bit", () => {
    // Over the windshield the section is a V (phase 3c, part 6), and a chord from one windshield's inboard edge to the
    // other's runs up to 2.4 cm under the ridge: more than the seam test's centimetre, so a strip that left the ridge out
    // would part from its neighbour with no vertex near enough to be judged. So the ridge is pinned directly.
    const post = panel("bizjet-lining-post");
    const sill = panel("bizjet-lining-sill-centre");
    const crown = panel("bizjet-lining-crown-centre");
    expect(post.columns, "the post's lining: two edges and the ridge").toBe(3);
    for (let row = 0; row < post.rows; row += 1) {
      const ridge = liningSkinVertex(post, row, 1);
      expect(Math.abs(ridge.z), `row ${row}: on the centreline`).toBeLessThan(1e-9);
      expect(distanceToTriangles(ridge, shell), `row ${row}: on the skin's ridge`).toBeLessThan(0.002);
    }
    // the post's foot IS three points of the centre sill's top row, and its head three of the centre crown's bottom row
    const rowOf = (p: Panel, row: number) => Array.from({ length: p.columns }, (_, c) => gridVertex(p, 1, row, c));
    for (const [label, end, edge] of [["foot", rowOf(post, 0), rowOf(sill, sill.rows - 1)], ["head", rowOf(post, post.rows - 1), rowOf(crown, 0)]] as const) {
      for (const v of end) expect(edge.some((w) => w.equals(v)), `the post's ${label} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) on its neighbour's row`).toBe(true);
    }
  });

  it("lines every member from the seat: a ray at the post's, the pillar's and the mid post's middle meets its own strip, drawn", () => {
    const interior = named("bizjet-cockpit-interior");
    const middleOf = (strip: string) => {
      const p = panel(strip);
      const row = Math.floor(p.rows / 2);
      return Vector3.Lerp(gridVertex(p, 1, row, 0), gridVertex(p, 1, row, p.columns - 1), 0.5);
    };
    const seen: string[] = [];
    for (const strip of ["bizjet-lining-post", "port-bizjet-lining-pillar", "port-bizjet-lining-mid-post"]) {
      const target = middleOf(strip);
      const { az, el } = azel(target);
      const d = target.subtract(EYE_POINT).normalize();
      const hit = firstHitAlong(d);
      expect(hit?.mesh, `${strip} at (${az.toFixed(1)}, ${el.toFixed(1)})`).toBe(interior);
      expect(partOf(hit!.mesh, hit!.faceId)).toBe(strip);
      // the GPU's rule: a drawn face's cross product, by the calibrated sign, faces along the ray
      const positions = interior.getVerticesData(VertexBuffer.PositionKind)!;
      const normals = interior.getVerticesData(VertexBuffer.NormalKind)!;
      const indices = interior.getIndices()!;
      const corner = (k: number) => Vector3.FromArray(positions, indices[hit!.faceId * 3 + k]! * 3);
      expect(cullSign * Vector3.Dot(Vector3.Cross(corner(1).subtract(corner(0)), corner(2).subtract(corner(0))), d), `${strip}: the nearest face is drawn`).toBeLessThan(0);
      for (let k = 0; k < 3; k += 1) expect(Vector3.Dot(Vector3.FromArray(normals, indices[hit!.faceId * 3 + k]! * 3), d), `${strip}: shaded toward the eye`).toBeLessThan(0);
      seen.push(`${strip} at (${az.toFixed(1)}, ${el.toFixed(1)}), ${hit!.distance.toFixed(2)} m`);
    }
    console.info(`the Global's members from the eye: ${seen.join("; ")}`);
    // CONTROL: with the kit's interior hidden, the post's ray meets nothing the cockpit camera draws inside the skin
    interior.isVisible = false;
    try {
      const target = middleOf("bizjet-lining-post");
      const { az, el } = azel(target);
      expect(kitHit(az, el)).toBeNull();
    } finally {
      interior.isVisible = true;
    }
  });

  it("frames every edge of the glass in the frame: just outside each pane's hole the kit is drawn, the strip the edge meets", () => {
    const cases: { pane: string; edge: "bottom" | "top" | "inboard" | "outboard"; out: [number, number]; frame: RegExp }[] = [];
    for (const side of ["port", "starboard"] as const) {
      // port panes lie at negative azimuth: outboard is further negative there
      const outboard = side === "port" ? -1 : 1;
      const pane = (name: string) => `${side}-bizjet-flight-deck-window-${name}`;
      cases.push({ pane: pane("windshield"), edge: "bottom", out: [0, -1], frame: /sill-centre/ });
      cases.push({ pane: pane("windshield"), edge: "top", out: [0, 1], frame: /crown-centre/ });
      cases.push({ pane: pane("windshield"), edge: "inboard", out: [-outboard, 0], frame: /lining-post/ });
      cases.push({ pane: pane("windshield"), edge: "outboard", out: [outboard, 0], frame: /lining-pillar/ });
      cases.push({ pane: pane("forward-side"), edge: "bottom", out: [0, -1], frame: /sill-forward-side|cap-forward-side/ });
      cases.push({ pane: pane("forward-side"), edge: "top", out: [0, 1], frame: /crown-forward-side/ });
      cases.push({ pane: pane("forward-side"), edge: "inboard", out: [-outboard, 0], frame: /lining-pillar/ });
      cases.push({ pane: pane("forward-side"), edge: "outboard", out: [outboard, 0], frame: /lining-mid-post/ });
    }
    let framed = 0;
    const missing: string[] = [];
    for (const c of cases) {
      const points = edgePoints(panel(c.pane), "skin", c.edge, 3);
      // an edge's first and last grid segment end in a corner, where the NEXT edge's frame is the neighbour
      for (const p of points.slice(3, -4)) {
        const { az, el } = azel(p);
        const outside = [az + c.out[0] * 0.3, el + c.out[1] * 0.3] as const;
        if (p.x <= EYE.forward + 0.1 || !inFrame(outside[0], outside[1]) || !inFrame(az, el)) continue;
        const part = firstPart(outside[0], outside[1]);
        // under the lip line the lip and the board are the frame too
        const underLip = outside[1] < lipElevation(outside[0]);
        framed += 1;
        // the window trim (S3) rolls every edge into the glass: frame too, whichever pane's it is
        if (part === null || (!underLip && !c.frame.test(part) && !/-bizjet-(trim|seal)-/.test(part))) missing.push(`${c.pane} ${c.edge} at (${az.toFixed(1)}, ${el.toFixed(1)}): ${part ?? "nothing"}`);
      }
    }
    expect(missing.slice(0, 8), `${missing.length} edge samples unframed`).toEqual([]);
    // NON-VACUITY: a floor well under what any eye in the K0 grids gives (98 from the seated eye on part 2's nose)
    expect(framed, "samples of the edges in the frame").toBeGreaterThan(60);
  });

  it("has a hole in the picture only where there is glass, and covers glass only at a pane's own edges, by the frame's own depth", () => {
    // THE FRAME'S DEPTH IS NOT AN OVERLAP. The lining is a 2 cm slab on the skin, and from 0.4 to 0.6 m a side pane is
    // seen at a slant, so a sightline to the glass just inside an edge can meet the slab's rim or inner face first: the
    // reveal of a real frame. What must never happen is the lining's own FOOTPRINT on the skin reaching over a pane's
    // hole, and a ray tells the two apart: over the footprint it crosses the strip's skin-level grid, in the reveal it
    // does not. Under the lip's line the lip rule decides (below).
    const skinShowing: string[] = [];
    const glassCovered: string[] = [];
    let reveal = 0;
    let trimmed = 0;
    let open = 0;
    let solid = 0;
    const kind = new Map<string, string>();
    const exit = (az: number, el: number) => {
      const key = `${az.toFixed(2)},${el.toFixed(2)}`;
      let k = kind.get(key);
      if (!k) {
        k = exitsThrough(az, el).what;
        kind.set(key, k);
      }
      return k;
    };
    // an edge: within half a degree of another kind of exit (the lining's rim reads up to that across at a slant)
    const nearEdge = (az: number, el: number, what: string) => [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].some(([da, de]) => exit(az + da!, el + de!) !== what);
    for (let az = -37.5 + 0.37; az <= 37.5; az += 1) {
      for (let el = -24 + 0.37; el <= 24; el += 1) {
        if (!inFrame(az, el)) continue;
        const what = exit(az, el);
        const hit = kitHit(az, el);
        if (hit) solid += 1;
        else open += 1;
        if (!hit && what !== "glass" && !nearEdge(az, el, what)) skinShowing.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) ${what}`);
        if (!hit || what !== "glass" || nearEdge(az, el, what) || el < lipElevation(az) + 0.1) continue;
        const part = partOf(hit.mesh, hit.faceId);
        if (/bizjet-lining-/.test(part) && crossings(EYE_POINT, direction(az, el), faceTriangles(panel(part), "skin")).length === 0) reveal += 1;
        // THE WINDOW TRIM (S3) stands over the glass by design, but only at a pane's edge: 11.2 mm into it along a straight
        // edge, and across a corner's arc and pocket never further than the corner's radius
        else if (/-bizjet-(trim|seal)-/.test(part) && distanceToPaneEdge(EYE_POINT.add(direction(az, el).scale(hit.distance))) <= BIZJET_WINDOW_TRIM.corner) trimmed += 1;
        else glassCovered.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) by ${part}`);
      }
    }
    console.info(`the Global's frame from the eye: ${open} rays open, ${solid} on the kit, ${reveal} of them the frame's reveal over glass, ${trimmed} its trim at a pane's edge`);
    // CONTROL for the footprint test: a ray at the middle of the pillar's own footprint on the skin crosses it
    const pillar = panel("port-bizjet-lining-pillar");
    const middle = liningSkinVertex(pillar, Math.floor(pillar.rows / 2), 0).add(liningSkinVertex(pillar, Math.floor(pillar.rows / 2), 1)).scale(0.5);
    expect(crossings(EYE_POINT, middle.subtract(EYE_POINT).normalize(), faceTriangles(pillar, "skin")).length, "the footprint test can see a footprint").toBe(1);
    expect(skinShowing.slice(0, 8), `${skinShowing.length} rays of hidden skin showing as sky`).toEqual([]);
    expect(glassCovered.slice(0, 8), `${glassCovered.length} rays of kit over the middle of a pane`).toEqual([]);
    expect(open).toBeGreaterThan(100);
    expect(solid).toBeGreaterThan(600);
  });

  it("runs the crowns from the glass's top edge past the frame's, and the sills from its bottom edge down to the lip, inside the skin", () => {
    for (const az of [-10, 0, 10]) {
      const run = windshieldRun(az);
      if (!run || !inFrame(az, run.to)) continue;
      const frameTop = Math.atan(FRAME_V * Math.cos(az / DEG)) * DEG;
      for (let e = run.to + 0.5; e <= frameTop; e += 0.5) {
        const hit = kitHit(az, e);
        expect(hit, `the crown at azimuth ${az}, elevation ${e.toFixed(2)}`).not.toBeNull();
        // the crown, or its window trim rolling into the glass (S3)
        expect(partOf(hit!.mesh, hit!.faceId), `azimuth ${az}, elevation ${e.toFixed(2)}`).toMatch(/crown|-bizjet-(trim|seal)-windshield/);
      }
      for (let e = run.from - 0.5; e > lipElevation(az) + 0.05; e -= 0.25) {
        const hit = kitHit(az, e);
        expect(hit, `the sill at azimuth ${az}, elevation ${e.toFixed(2)}`).not.toBeNull();
        expect(partOf(hit!.mesh, hit!.faceId), `azimuth ${az}, elevation ${e.toFixed(2)}`).toMatch(/sill|-bizjet-(trim|seal)-windshield/);
      }
    }
  });

  it("lines the skin from inside: where the pilot sees the lining's face it lies on the skin, shaded toward the cabin", () => {
    let face = 0;
    let rim = 0;
    let tightestFace = Number.POSITIVE_INFINITY;
    let shadedAway = 0;
    for (let az = -37 + 0.61; az <= 37; az += 1) {
      for (let el = -23 + 0.61; el <= 23; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = kitHit(az, el);
        const part = hit ? partOf(hit.mesh, hit.faceId) : "";
        if (!/lining/.test(part)) continue;
        const d = direction(az, el);
        const onFace = crossings(EYE_POINT, d, faceTriangles(panel(part), 1)).some((t) => Math.abs(t - hit!.distance) < 1e-4);
        if (!onFace) {
          rim += 1;
          continue;
        }
        face += 1;
        tightestFace = Math.min(tightestFace, insideSkin(d, hit!.distance));
        const normals = hit!.mesh.getVerticesData(VertexBuffer.NormalKind)!;
        const indices = hit!.mesh.getIndices()!;
        for (let k = 0; k < 3; k += 1) if (Vector3.Dot(Vector3.FromArray(normals, indices[hit!.faceId * 3 + k]! * 3), d) >= 0) shadedAway += 1;
      }
    }
    console.info(`the Global's lining: ${face} rays on its inner face, the tightest ${tightestFace.toFixed(4)} m inside the skin (negative: outside it, in a crease); ${rim} on its rims`);
    expect(face).toBeGreaterThan(300);
    expect(rim, "the rims are a small part of what shows").toBeLessThan(face / 5);
    // ON the skin: the inner face stands BIZJET_LINING.depth in, less a chord's sag where the skin is convex; where it
    // is concave the chord can carry it out, but never out of the skin (S3: nothing of the lining stands proud of it)
    expect(BIZJET_LINING.proud).toBe(0);
    expect(tightestFace).toBeGreaterThan(0);
    expect(shadedAway, "lining vertices shaded away from the eye").toBe(0);
  });

  it("caps the side panes' sills: under each side pane's bottom edge the eye meets the cap's top face, lit toward the cabin", () => {
    // The wall under the forward side pane is about 11 degrees of flat lining from the seat (K2); the cap is a ledge along
    // the pane's bottom edge, level with it and BIZJET_SILL_CAP.width inboard. Its row 0 IS its sill's top row on the
    // lining's inner face (the no-T-junction test holds the seam), and from the eye above, its inboard edge reads lower
    // than the pane's edge, so it covers no glass. (S5: the caps are merged with the consoles, on their instance.)
    const interior = named("bizjet-side-consoles");
    const normals = interior.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = interior.getIndices()!;
    let seen = 0;
    let hidden = 0;
    let byItem = 0;
    for (const side of [-1, 1] as const) {
      for (const sill of BIZJET_SILL_CAP.sills) {
        const cap = panel(bizjetSillCapMeshName(sill, side));
        const under = panel(`${side > 0 ? "starboard" : "port"}-bizjet-lining-${sill}`);
        expect([cap.rows, cap.columns], `${cap.name}: two rows on its sill's columns`).toEqual([2, under.columns]);
        for (let c = 0; c < cap.columns; c += 1) {
          // the seam, to the last bit, and the ledge's width and level
          expect(gridVertex(cap, 1, 0, c).equals(gridVertex(under, 1, under.rows - 1, c)), `${cap.name} column ${c} on its sill's top row`).toBe(true);
          expect(gridVertex(cap, 1, 1, c).y).toBeCloseTo(gridVertex(cap, 1, 0, c).y, 6);
          expect(Vector3.Distance(gridVertex(cap, 1, 0, c), gridVertex(cap, 1, 1, c))).toBeCloseTo(BIZJET_SILL_CAP.width, 5);
          // no glass under it from the eye: the ledge's inboard edge reads lower than the pane's edge
          expect(azel(gridVertex(cap, 1, 1, c)).el, `${cap.name} column ${c} reads under the pane's edge`).toBeLessThan(azel(gridVertex(cap, 1, 0, c)).el);
        }
        // where it is in the frame (the port forward side pane's, from the left seat), the eye meets its top face; UNDER
        // THE LIP'S LINE, within the lip's span, the board is nearer and the lip rule decides (a V nose puts the side
        // pane's forward foot there)
        const lipHalfWidth = deckHalfWidth();
        for (let c = 0; c + 1 < cap.columns; c += 1) {
          const middle = Vector3.Lerp(Vector3.Lerp(gridVertex(cap, 1, 0, c), gridVertex(cap, 1, 0, c + 1), 0.5), Vector3.Lerp(gridVertex(cap, 1, 1, c), gridVertex(cap, 1, 1, c + 1), 0.5), 0.5);
          const { az, el } = azel(middle);
          if (!inFrame(az, el)) continue;
          const atFace = EYE.right + (bizjetPanelFaceX() - EYE.forward) * Math.tan(az / DEG);
          if (Math.abs(atFace) <= lipHalfWidth && el < lipElevation(az)) {
            const deck = firstHitAlong(middle.subtract(EYE_POINT).normalize())!;
            expect(partOf(deck.mesh, deck.faceId), `${cap.name} at (${az.toFixed(1)}, ${el.toFixed(1)}), under the deck`).toMatch(/^bizjet-(instrument-panel|glareshield|screen-.*)$/);
            hidden += 1;
            continue;
          }
          const d = middle.subtract(EYE_POINT).normalize();
          const hit = firstHitAlong(d);
          // the port console's tiller or panel block (S5) can stand in front of the cap from the seat
          if (hit && /^bizjet-console-(block|rocker|tiller)-/.test(partOf(hit.mesh, hit.faceId))) {
            byItem += 1;
            continue;
          }
          expect(hit?.mesh, `${cap.name} at (${az.toFixed(1)}, ${el.toFixed(1)})`).toBe(interior);
          expect(partOf(hit!.mesh, hit!.faceId), `${cap.name} at (${az.toFixed(1)}, ${el.toFixed(1)})`).toBe(cap.name);
          // on its TOP face, not its rim: one of the top face's own triangles is crossed where the ray met the mesh
          expect(crossings(EYE_POINT, d, faceTriangles(cap, 1)).some((t) => Math.abs(t - hit!.distance) < 1e-4), `${cap.name}: on its top face`).toBe(true);
          for (let k = 0; k < 3; k += 1) expect(Vector3.Dot(Vector3.FromArray(normals, indices[hit!.faceId * 3 + k]! * 3), d), `${cap.name}: lit toward the cabin`).toBeLessThan(0);
          seen += 1;
        }
      }
    }
    console.info(`the Global's sill caps: ${seen} cells of the port forward side pane's cap in the frame, each met on its top face; ${hidden} under the deck; ${byItem} behind the console's tiller or block`);
    expect(seen, "the forward side pane's cap is in the frame from the seat").toBeGreaterThanOrEqual(1);
    expect(seen + byItem, "and its cells in the frame, met or behind the console's things").toBeGreaterThan(1);
  });

  it("reads THIN: the windshield/side pillar is nearly all face from the seat, its side faces a sliver (the 2 cm frame)", () => {
    // K3's lesson on the 747: the frame's depth shows as a second, lit face down the side of every pillar, and at the
    // glass's own 0.10 m it was half the pillar. Measured across the port pillar in 0.01 degree steps, each ray's first
    // drawn triangle classed by where `skinPanel` wrote it: two outer and two inner triangles a grid cell, then the rims.
    const interior = named("bizjet-cockpit-interior");
    const strip = "port-bizjet-lining-pillar";
    let start = 0;
    for (const source of merges.get(interior.name)!) {
      if (source.name === strip) break;
      start += source.triangles;
    }
    const p = panel(strip);
    const cells = (p.rows - 1) * (p.columns - 1);
    const readings: string[] = [];
    // across its own height from the eye (the pillar's foot moves with the nose): a quarter, half and three quarters up
    const middleEl = (row: number) => azel(Vector3.Lerp(gridVertex(p, 1, row, 0), gridVertex(p, 1, row, p.columns - 1), 0.5)).el;
    const [low, high] = [middleEl(0), middleEl(p.rows - 1)];
    for (const el of [0.25, 0.5, 0.75].map((f) => Math.round((low + (high - low) * f) * 10) / 10)) {
      let face = 0;
      let side = 0;
      for (let az = -40; az <= 0; az += 0.01) {
        const hit = kitHit(az, el);
        if (!hit || hit.mesh !== interior || partOf(interior, hit.faceId) !== strip) continue;
        if (hit.faceId - start >= cells * 4) side += 0.01;
        else face += 0.01;
      }
      readings.push(`el ${el}: ${(face + side).toFixed(2)} = face ${face.toFixed(2)} + side ${side.toFixed(2)}`);
      console.info(`  pillar at el ${el}: ${(face + side).toFixed(2)} = face ${face.toFixed(2)} + side ${side.toFixed(2)}`);
      expect(face, `the pillar at el ${el}`).toBeGreaterThan(3);
      expect(side, `its side faces at el ${el}`).toBeLessThan(PILLAR_SIDE_DEGREES);
    }
    console.info(`the Global's windshield/side pillar from the eye: ${readings.join("; ")}`);
  });

  it("puts nothing in the frame that the design did not account for: the kit, or the world through the glass", () => {
    const allowed = new Set(cockpitOnly.map((part) => part.name));
    const stray: string[] = [];
    for (let az = -37; az <= 37; az += 2) {
      for (let el = -23; el <= 23; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = kitHit(az, el);
        if (hit && !allowed.has(hit.mesh.name)) stray.push(`${hit.mesh.name} at (${az}, ${el})`);
      }
    }
    expect(stray.slice(0, 8)).toEqual([]);
  });
});

describe("the window trim (S3): every edge of the glass rolled into it, and sealed", () => {
  it("is one section, tangent from the inner face to the glass: the round, then the bead, down to the skin", () => {
    const { round, bead, centres } = bizjetTrimSection();
    const t = BIZJET_WINDOW_TRIM;
    // the round leaves the inner face's edge level with it, on its own radius, and turns `roundDegrees`
    expect(round[0]).toEqual({ a: 0, h: BIZJET_LINING.depth, degrees: 0 });
    for (const p of round) expect(Math.hypot(p.a - centres.round.a, p.h - centres.round.h)).toBeCloseTo(t.round, 12);
    expect(round.at(-1)!.degrees).toBeCloseTo(t.roundDegrees, 12);
    // the bead starts where the round ends, with its turn: internally tangent, its centre on the round's radius there
    expect(bead[0]).toEqual(round.at(-1));
    expect(Math.hypot(centres.bead.a - centres.round.a, centres.bead.h - centres.round.h)).toBeCloseTo(t.round - t.bead, 12);
    for (const p of bead.slice(0, -1)) expect(Math.hypot(p.a - centres.bead.a, p.h - centres.bead.h)).toBeCloseTo(t.bead, 12);
    // and runs on to the skin, turned past square to it, standing 11.2 mm into the pane at the most
    expect(bead.at(-1)!.h).toBe(0);
    expect(bead.at(-1)!.degrees).toBeCloseTo(136.8, 1);
    expect(Math.max(...bead.map((p) => p.a))).toBeCloseTo(0.0112, 4);
    // every step turns the normal the same way, no more than the step
    const turns = [...round, ...bead.slice(1)].map((p) => p.degrees);
    for (let k = 1; k < turns.length; k += 1) {
      expect(turns[k]! - turns[k - 1]!).toBeGreaterThan(0);
      expect(turns[k]! - turns[k - 1]!).toBeLessThanOrEqual(t.stepDegrees + 1e-9);
    }
    // the cove: from the ledge to the glass, concave, on its radius
    const cove = bizjetCoveSection();
    expect([cove[0]!.a, cove[0]!.h, cove[0]!.degrees]).toEqual([0, t.cove, 90]);
    expect([cove.at(-1)!.a, cove.at(-1)!.h, cove.at(-1)!.degrees]).toEqual([t.cove, 0, 0]);
    for (const p of cove) expect(Math.hypot(p.a - t.cove, p.h - t.cove)).toBeCloseTo(t.cove, 12);
  });

  it("seals every edge of the glass in the frame: the last surface the eye meets before the glass is a seal, and no crease on the way", () => {
    // Across each edge of each pane in the frame, from 1 degree outside it into the glass in steps of 0.04 degrees (under
    // a 1080p pixel): the first ray that leaves through the glass meeting nothing, and the surface the ray before it met.
    // THROUGH S4 that was the lining's rim, square to its face (P0: 4,890 px against the glass, 1,823 px of 90 degree
    // creases at 1600 x 900). The lip is the edge under its own line (the lip rule's). Corners are crossed on their
    // diagonal. Along the walk, where two neighbouring rays meet one surface (hit points within 5 mm) and one of them is
    // the trim's, a seal's, a pillar's or its foot's, the shading normal turns less than the crease survey's 45 degrees.
    //
    // A FAR edge, whose section faces the eye (the trim's normal is square to the sightline past 90 degrees of its turn),
    // shows its seal before the glass. A NEAR edge rolls away from the eye, which meets its section square at 40 to 65
    // degrees of turn: there the seal, from 35, is under a pixel wide, and the eye sees the trim's round meet the glass
    // with the seal behind it, as on a real frame. Neither ever shows the lining.
    type Case = { pane: string; at: Vector3; out: [number, number]; far: boolean };
    const cases: Case[] = [];
    for (const side of ["port", "starboard"] as const) {
      const outboard = side === "port" ? -1 : 1;
      for (const name of ["windshield", "forward-side", "aft-side"]) {
        const pane = panel(`${side}-bizjet-flight-deck-window-${name}`);
        const out = { bottom: [0, -1], top: [0, 1], inboard: [-outboard, 0], outboard: [outboard, 0] } as const;
        // FAR: at an edge point, a sightline going out through the skin moves away from the pane, square to the edge in
        // the skin (the trim's `into`, which its section is laid along)
        const middle = skinVertex(pane, Math.floor(pane.rows / 2), Math.floor(pane.columns / 2));
        const far = (at: Vector3, along: Vector3) => {
          // the skin's normal there: the nearest grid point's, from the pane's outer face to its inner
          let nearest = [0, 0];
          for (let r = 0; r < pane.rows; r += 1) {
            for (let k = 0; k < pane.columns; k += 1) {
              if (Vector3.Distance(skinVertex(pane, r, k), at) < Vector3.Distance(skinVertex(pane, nearest[0]!, nearest[1]!), at)) nearest = [r, k];
            }
          }
          const normal = gridVertex(pane, 0, nearest[0]!, nearest[1]!).subtract(gridVertex(pane, 1, nearest[0]!, nearest[1]!)).normalize();
          let into = Vector3.Cross(normal, along).normalize();
          if (Vector3.Dot(into, middle.subtract(at)) < 0) into = into.negate();
          return Vector3.Dot(at.subtract(EYE_POINT), into) < 0;
        };
        for (const edge of ["bottom", "top", "inboard", "outboard"] as const) {
          const points = edgePoints(pane, "skin", edge, 3);
          for (let k = 1; k + 1 < points.length; k += 1) {
            cases.push({ pane: `${side} ${name} ${edge}`, at: points[k]!, out: [...out[edge]], far: far(points[k]!, points[k + 1]!.subtract(points[k - 1]!)) });
          }
        }
        // a corner is crossed on its diagonal, over the trim's arc: its seal or its round (the arc turns the section
        // through every direction between the two edges')
        const corner = (row: number, column: number, a: readonly number[], b: readonly number[]) => {
          const n = Math.hypot(a[0]! + b[0]!, a[1]! + b[1]!);
          cases.push({ pane: `${side} ${name} corner ${row},${column}`, at: skinVertex(pane, row, column), out: [(a[0]! + b[0]!) / n, (a[1]! + b[1]!) / n], far: false });
        };
        corner(0, 0, out.bottom, out.inboard);
        corner(0, pane.columns - 1, out.bottom, out.outboard);
        corner(pane.rows - 1, pane.columns - 1, out.top, out.outboard);
        corner(pane.rows - 1, 0, out.top, out.inboard);
      }
    }
    let walks = 0;
    let corners = 0;
    let sealed = 0;
    let rolled = 0;
    let worstTurn = 0;
    let worstAt = "";
    const bare: string[] = [];
    for (const c of cases) {
      const { az, el } = azel(c.at);
      if (c.at.x <= EYE.forward + 0.1 || !inFrame(az, el)) continue;
      let before: { part: string; point: Vector3; normal: Vector3 } | null = null;
      for (let t = 1; t >= -1; t -= 0.04) {
        const a = az + c.out[0] * t;
        const e = el + c.out[1] * t;
        if (!inFrame(a, e)) {
          before = null;
          continue;
        }
        const hit = kitHit(a, e);
        if (!hit) {
          if (before !== null && exitsThrough(a, e).what === "glass") {
            walks += 1;
            if (/corner/.test(c.pane)) corners += 1;
            const lip = /^bizjet-(glareshield|instrument-panel|cove-fillet|screen)/.test(before.part);
            if (/-bizjet-seal-/.test(before.part)) sealed += 1;
            else if (!c.far && /-bizjet-trim-/.test(before.part)) rolled += 1;
            else if (!lip) bare.push(`${c.pane} (${c.far ? "far" : "near"}) at (${a.toFixed(2)}, ${e.toFixed(2)}): ${before.part}`);
            break;
          }
          before = null;
          continue;
        }
        // THE PICKER IS NOT WATERTIGHT where two meshes share an edge (the trim's round and its seal share their
        // tangent line): a lone ray slips through it and meets the seal's back, just behind, which the GPU, rasterizing
        // the shared edge watertight, never shows. So each sample reads the majority of three rays 0.003 degrees apart
        // across the walk (1/17 of a pixel); a slip is one ray.
        const across = [-c.out[1] * 0.003, c.out[0] * 0.003];
        const three = [0, 1, -1].map((k) => shadedAt(a + across[0]! * k, e + across[1]! * k)).filter((x) => x !== null);
        const agree = (x: { normal: Vector3 }, y: { normal: Vector3 }) => Vector3.Dot(x.normal, y.normal) > Math.cos(10 / DEG);
        const shaded = three.find((x) => three.filter((y) => y !== x && agree(x, y)).length >= 1) ?? three[0]!;
        const here = { part: partOf(hit.mesh, hit.faceId), point: shaded.point, normal: shaded.normal };
        // S3's surfaces, and the pillar they flare it onto the ledge at its foot (the cap's own box edges are S4's ledge)
        const ours = (part: string) => /-bizjet-(trim|seal|pillar-foot)|lining-pillar/.test(part);
        if (before && (ours(before.part) || ours(here.part)) && Vector3.Distance(before.point, here.point) < 0.005) {
          const turn = Math.acos(Math.min(1, Vector3.Dot(before.normal, here.normal))) * DEG;
          if (turn > worstTurn) {
            worstTurn = turn;
            worstAt = `${c.pane} at (${a.toFixed(2)}, ${e.toFixed(2)}), ${before.part} to ${here.part}`;
          }
        }
        before = here;
      }
    }
    console.info(`the Global's window trim: ${walks} walks across the glass's edges in the frame (${corners} at corners): ${sealed} end on a seal, ${rolled} on a near edge's round; the shading turns ${worstTurn.toFixed(1)} degrees a step at the most (${worstAt})`);
    expect(bare.slice(0, 8), `${bare.length} edge crossings where the eye meets something other than a seal just before the glass`).toEqual([]);
    expect(worstTurn, worstAt).toBeLessThan(45);
    // NON-VACUITY: the frame holds the port windshield's four edges, the post, the port side pane's forward edges
    expect(walks).toBeGreaterThan(60);
    expect(corners).toBeGreaterThan(2);
    expect(sealed, "the far edges' seals").toBeGreaterThan(30);
  });

  it("ends its runs at the ledges out of sight: no cap of a seal's run is ever what the eye meets", () => {
    // the seals' runs round the side panes end, capped, at their bottom corners, where the ledge and its cove meet the
    // members; over a 3 degree box round every side pane's bottom corner in the frame, at 0.1 degrees, no ray meets a
    // cap first (the rounded corners' pockets are held by the walk above, which crosses every corner on its diagonal)
    let rays = 0;
    const caps: string[] = [];
    for (const side of ["port", "starboard"] as const) {
      for (const name of ["forward-side", "aft-side"]) {
        const pane = panel(`${side}-bizjet-flight-deck-window-${name}`);
        for (const column of [0, pane.columns - 1]) {
          const { az, el } = azel(skinVertex(pane, 0, column));
          for (let a = az - 1.5; a <= az + 1.5; a += 0.1) {
            for (let e = el - 1.5; e <= el + 1.5; e += 0.1) {
              if (!inFrame(a, e)) continue;
              const hit = kitHit(a, e);
              rays += 1;
              if (hit && /-(start|end)$/.test(partOf(hit.mesh, hit.faceId))) caps.push(`${name} ${column} at (${a.toFixed(1)}, ${e.toFixed(1)})`);
            }
          }
        }
      }
    }
    expect(caps.slice(0, 8)).toEqual([]);
    expect(rays, "the port forward side pane's inboard foot is in the frame").toBeGreaterThan(100);
  });
});

describe("the lip rule: the highest straight lip that covers no glass", () => {
  it("solves a level edge to the edge's own elevation, and ignores glass outside the frame or past the lip's end", () => {
    // A LEVEL edge (a line along z at one height and station) reads, at every azimuth, as a line along z does, so the
    // highest lip under it reads exactly its elevation straight ahead, wherever the lip's face stands.
    const eye = { x: 11.9, y: 0.78, z: -0.52 };
    const edge = Array.from({ length: 41 }, (_, k) => ({ x: 13.0, y: 0.7, z: -1 + k * 0.05 }));
    const level = Math.atan2(0.7 - 0.78, 13.0 - 11.9) * DEG;
    for (const faceX of [12.4, 12.55, 12.9]) {
      const lip = highestClearLip(eye, faceX, edge, 0.8);
      expect(lip.elevationDegrees).toBeCloseTo(level, 9);
      expect(lip.y).toBeCloseTo(eye.y + ((0.7 - 0.78) / 1.1) * (faceX - eye.x), 12);
    }
    // two decoys, each far lower: one outside the frame (az 60), one inside it but beyond the lip's end
    const outside = { x: 12.5, y: 0.2, z: eye.z + 0.6 * Math.tan(60 / DEG) };
    const beyond = { x: 13.0, y: 0.2, z: eye.z - 1.1 * Math.tan(30 / DEG) };
    expect(highestClearLip(eye, 12.55, [...edge, outside, beyond], 0.8).elevationDegrees).toBeCloseTo(level, 9);
    // CONTROL: the second decoy DOES hold the lip down once the lip is long enough to reach it
    expect(highestClearLip(eye, 12.55, [...edge, beyond], 2).elevationDegrees).toBeLessThan(level - 5);
  });

  it("is K0's rule on the built glass: the closed form agrees with a search over lip heights by elevation, from the eye", () => {
    // K0 solved the rule by bisection on ELEVATIONS: a lip reads atan((y - eye.y) cos(az) / d) at each azimuth, and
    // it may not stand above the windshield's bottom edge (its hole in the skin) anywhere in the frame. The closed form
    // solves the same thing by slopes. The two must agree on whatever glass this nose has, read at test time.
    const port = panel("port-bizjet-flight-deck-window-windshield");
    const bottom = edgePoints(port, "skin", "bottom", 10);
    const faceX = bizjetPanelFaceX();
    const d = faceX - EYE.forward;
    const seen = bottom.map((p) => azel(p)).filter(({ az }) => Math.abs(Math.tan(az / DEG)) <= FRAME_U);
    expect(seen.length, "the windshield's bottom edge in the frame").toBeGreaterThan(40);
    const covers = (y: number) => seen.some(({ az, el }) => Math.atan(((y - EYE.up) * Math.cos(az / DEG)) / d) * DEG > el + 1e-9);
    let low = EYE.up - 1;
    let high = EYE.up + 1;
    expect(covers(high) && !covers(low), "the search brackets the rule").toBe(true);
    for (let i = 0; i < 80; i += 1) {
      const mid = (low + high) / 2;
      if (covers(mid)) high = mid;
      else low = mid;
    }
    const lip = highestClearLip({ x: EYE.forward, y: EYE.up, z: EYE.right }, faceX, bottom, 10);
    console.info(`the Global's lip rule on the windshield's skin-level bottom from the eye: ${(-lip.elevationDegrees).toFixed(3)} by slopes, ${(-Math.atan((low - EYE.up) / d) * DEG).toFixed(3)} by elevations`);
    expect(lip.y).toBeCloseTo(low, 9);
  });

  it("stands the lip at the catalogue's deck line, hiding no more glass than the pinned profile (the BUILT sills)", () => {
    const lipVertices = worldVertices(named("bizjet-glareshield"));
    // the lip's ROW holds over its straight span; past it the end rounds (S4) fall away from the row to nothing in 20 mm,
    // so glass beyond the straight lip is not under the row (the forward side pane's inboard foot, from the seat, reads
    // at the end round's very tip)
    const halfWidth = deckHalfWidth();
    const recorded = aircraftSpec("bizjet").cockpitDeckLineDegrees;
    // the lip as built is the catalogue's line: the glareshield's silhouette is its steepest-up vertex from the eye (a
    // line along z reads one row, its slope along x), and that is the round's tangent, on the line to the bit
    const rowSlope = (v: { x: number; y: number }) => (v.y - EYE.up) / (v.x - EYE.forward);
    expect(Math.max(...lipVertices.map(rowSlope)), "the silhouette on the catalogue's line").toBeCloseTo(-Math.tan(recorded / DEG), 12);
    expect(rowSlope(bizjetGlareshieldSection().tangent)).toBeCloseTo(-Math.tan(recorded / DEG), 12);
    // its aft face at the deck's own plane, to the joint's cut: the 4 mm round into the cove takes the corner's last 0.1 mm
    expect(Math.min(...lipVertices.map((v) => v.x)), "its aft face at the deck's own plane").toBeCloseTo(bizjetPanelFaceX(), 3);
    expect(Math.atan2(bizjetLipY() - EYE.up, bizjetPanelFaceX() - EYE.forward) * DEG).toBeCloseTo(-recorded, 9);
    // THE GLASS IT HIDES: every rim point in the frame and over the lip's span that reads under the lip's row, by how
    // far (a line along z is one row, the row of its slope along x; a rim point's row is its own slope's)
    const slope = (p: Vector3) => (p.y - EYE.up) / (p.x - EYE.forward);
    const lipRow = Math.atan(-Math.tan(recorded / DEG)) * DEG;
    const d = bizjetPanelFaceX() - EYE.forward;
    let ahead = 0;
    let anywhere = 0;
    let where = "";
    let rimsAhead = 0;
    let lowestAhead = Number.POSITIVE_INFINITY;
    for (const p of sillRims()) {
      const across = (p.z - EYE.right) / (p.x - EYE.forward);
      if (Math.abs(across) > FRAME_U || Math.abs(EYE.right + d * across) > halfWidth) continue;
      const { az, el } = azel(p);
      const hidden = Math.max(0, lipRow - Math.atan(slope(p)) * DEG);
      if (Math.abs(az) <= 0.5) {
        rimsAhead += 1;
        ahead = Math.max(ahead, hidden);
        lowestAhead = Math.min(lowestAhead, el);
      }
      if (hidden > anywhere) {
        anywhere = hidden;
        where = `(${az.toFixed(1)}, ${el.toFixed(2)})`;
      }
    }
    const rule = highestClearLip({ x: EYE.forward, y: EYE.up, z: EYE.right }, bizjetPanelFaceX(), sillRims(), halfWidth);
    // THE DOWN-VISION straight ahead: the glass down to its rim, or to the lip if the lip is higher
    const downVision = Math.max(lowestAhead, -recorded);
    console.info(`the Global's lip at ${recorded}: hides ${ahead.toFixed(2)} degrees of glass straight ahead, ${anywhere.toFixed(2)} at most (at ${where}); the pilot sees down to ${downVision.toFixed(2)} straight ahead (the rim ${lowestAhead.toFixed(2)}); the highest lip hiding none would read ${(-rule.elevationDegrees).toFixed(3)}`);
    expect(rimsAhead, "rim points straight ahead").toBeGreaterThan(2);
    expect(ahead, "glass hidden straight ahead").toBeLessThanOrEqual(TARGETS.hiddenAhead);
    expect(anywhere, "glass hidden anywhere along the lip").toBeLessThanOrEqual(TARGETS.hiddenAnywhere);
    expect(downVision, "the down-vision straight ahead").toBeLessThanOrEqual(TARGETS.downVision);
  });

  it("ends the lip at the windshield's pillars, or 5 cm inside the shell where that is nearer: a glareshield spans post to post", () => {
    // Out to the shell, a lower lip is also a wider one, and on part 3's nose it reached under the forward side panes'
    // low corners, whose glass then held it down (11.49 against 3.96). Past the pillars the side sills are lining. On
    // part 6's V the shell narrows fast forward of the face, and 5 cm inside it ends the lip a little inboard of the
    // pillars' feet; the pillar's lining covers the rest (the whole-frame test finds no hidden skin showing).
    // the straight lip spans the posts; its end rounds (S4) close outboard of that, under the posts' feet
    const halfWidth = deckHalfWidth();
    expect(Math.max(...worldVertices(named("bizjet-glareshield")).map((v) => Math.abs(v.z))) - halfWidth, "the end rounds").toBeCloseTo(BIZJET_GLARESHIELD.endRound, 5);
    const port = panel("port-bizjet-flight-deck-window-windshield");
    const pillarFoot = Math.abs(skinVertex(port, 0, port.columns - 1).z);
    // the built shell where the deck's full width stands: the round and the cove, at the round's top and the cove's foot
    const section = bizjetGlareshieldSection();
    const shellAt = (x: number, y: number) => crossings(new Vector3(x, y, 0), new Vector3(0, 0, -1), worldTriangles(fuselage)).at(-1)!;
    const aftEnd = Math.max(section.faceTop.x, section.round[0]!.x);
    const shell = Math.min(...[bizjetPanelFaceX(), aftEnd].flatMap((x) => [section.tangent.y, section.faceTop.y].map((y) => shellAt(x, y))));
    const binds = shell - BIZJET_PANEL.shellMargin < pillarFoot ? "the shell" : "the pillars";
    console.info(`the Global's lip: half-width ${halfWidth.toFixed(4)} m; the windshield's pillar foot ${pillarFoot.toFixed(4)} m out; the shell there ${shell.toFixed(4)} m; ${binds} binds`);
    expect(halfWidth, "no wider than the pillars' feet").toBeLessThanOrEqual(pillarFoot + 0.002);
    expect(shell - halfWidth, "5 cm inside the built shell, less its facets").toBeGreaterThanOrEqual(BIZJET_PANEL.shellMargin - 0.003);
    // and it is one of the two that binds: not narrower than both allow
    expect(Math.min(pillarFoot, shell - BIZJET_PANEL.shellMargin) - halfWidth, "as wide as it may be").toBeLessThan(0.006);
    expect(BIZJET_PANEL.shellMargin, "the PM's span margin").toBeGreaterThanOrEqual(0.05);
  });

  it("tapers the hood in plan to the shell: the round, the aft face and the cove keep the deck's width, every vertex 5 cm inside", () => {
    // On part 6's V the shell at the hood's forward end is narrower than the deck; the hood cannot be seen from the seat
    const all = worldVertices(named("bizjet-glareshield"));
    const deckWidth = deckHalfWidth();
    // the straight part (the end rounds, S4, stand outboard of the deck's width, and are held below)
    const lip = all.filter((v) => Math.abs(v.z) <= deckWidth + 1e-6);
    const section = bizjetGlareshieldSection();
    const aftEnd = Math.max(section.faceTop.x, section.round[0]!.x);
    const aft = lip.filter((v) => v.x <= aftEnd + 1e-6);
    const forward = lip.filter((v) => v.x >= bizjetPanelFaceX() + BIZJET_GLARESHIELD.hoodDepth - 1e-6);
    const deck = Math.max(...aft.map((v) => Math.abs(v.z)));
    const end = Math.max(...forward.map((v) => Math.abs(v.z)));
    for (const v of aft) expect(Math.abs(v.z), "the aft part at the deck's full width").toBeCloseTo(deck, 5);
    console.info(`the Global's hood: ${deck.toFixed(4)} m wide at the round and the cove, ${end.toFixed(4)} m at its forward end`);
    expect(end, "the forward end drawn in").toBeLessThan(deck - 0.01);
    // every vertex of it, the tapered hood's included, stands the margin inside the shell as built, at its own station
    for (const v of lip) {
      const wall = crossings(new Vector3(v.x, v.y, 0), new Vector3(0, 0, v.z < 0 ? -1 : 1), worldTriangles(fuselage)).at(-1)!;
      expect(wall - Math.abs(v.z), `(${v.x.toFixed(3)}, ${v.y.toFixed(3)})`).toBeGreaterThanOrEqual(BIZJET_PANEL.shellMargin - 0.003);
    }
    // the end rounds: inside the shell by the margin less their own reach
    for (const v of all.filter((w) => Math.abs(w.z) > deckWidth + 1e-6)) {
      const wall = crossings(new Vector3(v.x, v.y, 0), new Vector3(0, 0, v.z < 0 ? -1 : 1), worldTriangles(fuselage)).at(-1)!;
      expect(wall - Math.abs(v.z), `end round (${v.x.toFixed(3)}, ${v.y.toFixed(3)})`).toBeGreaterThanOrEqual(BIZJET_PANEL.shellMargin - BIZJET_GLARESHIELD.endRound - 0.003);
    }
  });

  it("rounds the glareshield's aft edge ON the deck line's sight line, and falls its hood away faster than that line", () => {
    const g = BIZJET_GLARESHIELD;
    for (const deckLine of [5, 10.88, 11.5]) {
      const section = bizjetGlareshieldSection(deckLine);
      const { centre, tangent } = section;
      // the round: its centre `radius` in from the aft face, the sight line over the deck `radius` above it
      expect(centre.x - bizjetPanelFaceX()).toBeCloseTo(g.radius, 12);
      const sight = deckLine / DEG;
      const offLine = Math.sin(sight) * (centre.x - EYE.forward) + Math.cos(sight) * (centre.y - EYE.up);
      expect(offLine, `the round's centre under the ${deckLine} degree sight line`).toBeCloseTo(-g.radius, 12);
      // the tangent is ON the line and a vertex of the outline; every vertex of the round is on its circle
      expect(Math.atan2(tangent.y - EYE.up, tangent.x - EYE.forward) * DEG).toBeCloseTo(-deckLine, 9);
      expect(section.outline.some((v) => v.x === tangent.x && v.y === tangent.y), "the tangent is a vertex").toBe(true);
      const { round } = section;
      expect(round.length).toBe(g.roundSegments + 2);
      // the round, then the joint's round into the cove, close the outline
      const joint = section.joint.points;
      expect(section.outline.slice(-(round.length + joint.length - 1)), "the round and the joint close the outline").toEqual([...round, ...joint.slice(1)]);
      expect(joint[0], "the joint leaves the round at the round's own last vertex").toEqual(round.at(-1));
      for (const v of round) expect(Math.hypot(v.x - centre.x, v.y - centre.y)).toBeCloseTo(g.radius, 12);
      // the hood: its top from the round's forward tangent and its underside from the cove's foot, both falling at the
      // hood's angle, faster than the sight line, so past the round nothing of it rises to the line
      const endX = bizjetPanelFaceX() + g.hoodDepth;
      const ends = section.outline.filter((v) => v.x === endX);
      expect(ends, "the hood's forward end: two corners").toHaveLength(2);
      const hoodStart = round[0]!;
      const top = Math.max(...ends.map((v) => v.y));
      const foot = Math.min(...ends.map((v) => v.y));
      expect(Math.atan2(hoodStart.y - top, endX - hoodStart.x) * DEG, "the hood's top falls").toBeCloseTo(g.hoodFallDegrees, 9);
      expect(Math.atan2(section.faceTop.y - foot, endX - section.faceTop.x) * DEG, "its underside falls with it").toBeCloseTo(g.hoodFallDegrees, 9);
      expect(top - foot, "a plate, not a sliver").toBeGreaterThan(0.001);
      for (const v of section.outline) {
        expect((v.y - EYE.up) / (v.x - EYE.forward), "no vertex over the sight line").toBeLessThanOrEqual(-Math.tan(sight) + 1e-12);
      }
    }
    // a deck line as steep as the hood would show the hood's top over the round: refused, not built
    expect(() => bizjetGlareshieldSection(g.hoodFallDegrees)).toThrow(RangeError);
  });

  it("is built inside the PM's numbers (P1a), written out here and not read from the builder's constants", () => {
    const section = bizjetGlareshieldSection();
    const radius = Math.hypot(section.tangent.x - section.centre.x, section.tangent.y - section.centre.y);
    // 20 mm, smooth-shaded (the "feel real" wave's S1; 12.5 before, on flat chords). With the round at 20 the drop and
    // the cove are not taste: the 2.5 degree deck-edge ceiling and the screens' placement from the face's top decide
    // them. The old 5 mm drop and 10 mm cove under a 20 mm round read 3.09 degrees and took the face, and the screens
    // placed from it, 9.1 mm down; no drop and a 5 mm cove read 2.36 with the face's top 0.9 mm higher.
    expect(radius, "the round's radius, 0.020").toBeCloseTo(0.02, 12);
    expect(BIZJET_GLARESHIELD.drop, "no aft face under the round").toBe(0);
    expect(BIZJET_GLARESHIELD.cove, "the cove, 5 mm").toBe(0.005);
    expect(section.centre.y - section.coveTop.y, "the aft face's drop under the round, at most 0.010").toBeLessThanOrEqual(0.01 + 1e-12);
    expect(section.coveTop.x - section.faceTop.x, "the cove at 45 degrees").toBeCloseTo(section.faceTop.y - section.coveTop.y, 12);
    expect(Math.max(...section.outline.map((v) => v.x)) - bizjetPanelFaceX(), "the hood's depth").toBeCloseTo(0.18, 12);
    expect(BIZJET_GLARESHIELD.hoodFallDegrees, "the hood's fall").toBeGreaterThanOrEqual(12);
    expect(BIZJET_PANEL.leanDegrees, "the panel's lean").toBe(15);
    // the frames (S2): 10 mm at the sides and the foot, 6 mm over the top (the gap and the chamfer, no flat band), their
    // tops 1.2 mm of board under the cove's fillet (the headroom from the frame's top border, not from the screens)
    expect(BIZJET_SCREENS.bezel, "the frame's sides and foot").toBe(0.01);
    expect(BIZJET_SCREENS.topBorder, "the frame's top border").toBe(0.006);
    expect(BIZJET_SCREENS.topBorder, "no flat band over the top").toBeCloseTo(BIZJET_SCREENS.gap + BIZJET_SCREENS.chamfer, 12);
    expect(BIZJET_SCREENS.boardUnderFillet, "board between the fillet and the frames' top").toBe(0.0012);
    // THE DECK'S EDGE as the pilot reads it straight ahead, from the round's tangent to the cove's foot: at most 2.5 degrees
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    const edge = el(section.tangent) - el(section.faceTop);
    console.info(`the Global's deck edge: ${edge.toFixed(3)} degrees tall straight ahead (the round ${(el(section.tangent) - el({ x: bizjetPanelFaceX(), y: section.centre.y })).toFixed(2)}, the drop ${(el({ x: bizjetPanelFaceX(), y: section.centre.y }) - el(section.coveTop)).toFixed(2)}, the cove ${(el(section.coveTop) - el(section.faceTop)).toFixed(2)})`);
    expect(edge).toBeLessThanOrEqual(TARGETS.deckEdge);
  });

  it("turns a cove under the round: the aft face drops, the cove faces down and aft at 45 degrees, and the pilot sees it", () => {
    const g = BIZJET_GLARESHIELD;
    const section = bizjetGlareshieldSection();
    const lip = named("bizjet-glareshield");
    const vertices = worldVertices(lip);
    const normals = lip.getVerticesData(VertexBuffer.NormalKind)!;
    // three vertices a triangle: the flat faces by their built normals, a triangle whose three corners all carry the
    // cove's normal (the joint's round meets the cove with that normal too, at one or two corners of its last chord)
    const cove: Vector3[] = [];
    const aft: Vector3[] = [];
    let coveNormal: Vector3 | null = null;
    const isCove = (i: number) => Math.abs(normals[i * 3]! + Math.SQRT1_2) < 1e-6 && Math.abs(normals[i * 3 + 1]! + Math.SQRT1_2) < 1e-6;
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      if (isCove(i) && isCove(i + 1) && isCove(i + 2)) {
        cove.push(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
        coveNormal = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      }
      for (const k of [i, i + 1, i + 2]) if (normals[k * 3]! < -0.999999) aft.push(vertices[k]!);
    }
    expect(cove.length, "the cove's vertices: a quad, two triangles").toBe(6);
    // (vertex data is float32: a micrometre at these stations) the flat cove runs from the joint's round down to the
    // face's top, on the cove's 45 degree line through the corner the round met it at
    const jointEnd = section.joint.points.at(-1)!;
    for (const v of cove) expect((v.x - section.coveTop.x) + (v.y - section.coveTop.y), "on the cove's line").toBeCloseTo(0, 5);
    expect(Math.min(...cove.map((v) => v.x)), "from the joint's end").toBeCloseTo(jointEnd.x, 5);
    expect(Math.max(...cove.map((v) => v.x)), "to the face's top").toBeCloseTo(section.faceTop.x, 5);
    expect(section.faceTop.x - section.coveTop.x, "the cove's run, corner to foot").toBeCloseTo(g.cove, 12);
    expect(section.coveTop.y - section.faceTop.y, "the cove's fall, corner to foot").toBeCloseTo(g.cove, 12);
    // the pilot SEES it: its normal has a component toward the eye at every one of its corners (a flat underside's did not)
    for (const v of cove) expect(Vector3.Dot(coveNormal!, EYE_POINT.subtract(v)), "the cove faces the eye").toBeGreaterThan(0);
    // the aft face: vertical under the round's aft tangent, `drop` tall; at 0 there is none, and the corner the cove's
    // line meets the round at (`coveTop`) is the round's aft tangent, which the joint's round then cuts
    expect(section.coveTop.x, "the corner on the aft face's plane").toBeCloseTo(bizjetPanelFaceX(), 12);
    expect(section.centre.y - section.coveTop.y, "the drop under the round").toBeCloseTo(g.drop, 12);
    for (const v of aft) expect(v.x).toBeCloseTo(bizjetPanelFaceX(), 5);
    // the panel's face begins at the cove's foot: the board's top edge, no gap
    const board = worldVertices(named("bizjet-cockpit-interior")).slice(0, 24);
    expect(Math.max(...board.map((v) => v.y)), "the board's top at the cove's foot").toBeCloseTo(section.faceTop.y, 5);
    const top = board.filter((v) => Math.abs(v.y - section.faceTop.y) < 1e-5);
    expect(Math.min(...top.map((v) => v.x)) - bizjetPanelFaceX(), "the cove's run to the face").toBeCloseTo(g.cove, 5);
    // and by ray: straight ahead, just under the deck's edge the eye meets the cove, just under that the board
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    // (the middle of the FLAT cove: between the joint's round above and the cove's fillet below)
    const filletTop = bizjetCoveFillet().points[0]!;
    const coveMiddle = el({ x: (jointEnd.x + filletTop.x) / 2, y: (jointEnd.y + filletTop.y) / 2 });
    const hit = kitHit(0, coveMiddle);
    expect(hit?.mesh.name, "straight ahead, the cove's middle").toBe("bizjet-glareshield");
    const at = EYE_POINT.add(direction(0, coveMiddle).scale(hit!.distance));
    expect(at.x - bizjetPanelFaceX(), "and the hit is on the cove").toBeGreaterThan(0.0005);
    // (under the fillet's foot: 3.6 mm down the face, about 0.3 degrees)
    expect(firstPart(0, el(section.faceTop) - 0.45), "under the cove's foot and its fillet").toBe("bizjet-instrument-panel");
  });

  it("shades the round as the circle: every chord's corners take the round's radial normal", () => {
    const section = bizjetGlareshieldSection();
    const lip = named("bizjet-glareshield");
    const positions = lip.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = lip.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = lip.getIndices()!;
    const onRound = (i: number) => section.round.some((p) => Math.abs(p.x - positions[i * 3]!) < 1e-6 && Math.abs(p.y - positions[i * 3 + 1]!) < 1e-6);
    let chords = 0;
    let radial = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      if (Math.abs(normals[corners[0]! * 3 + 2]!) > 0.5 || !corners.every(onRound)) continue; // a cap, or not a chord
      chords += 1;
      for (const i of corners) {
        const r = new Vector3(positions[i * 3]! - section.centre.x, positions[i * 3 + 1]! - section.centre.y, 0).normalize();
        if (Vector3.Dot(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), r) > 1 - 1e-6) radial += 1; // float32 normals
      }
    }
    // each of the round's chords is a wall of two triangles, and every one of their corners carries the radial
    expect(chords, "the round's chord triangles").toBe((section.round.length - 1) * 2);
    expect(radial, "their corners carrying the radial normal").toBe(chords * 3);
  });

  it("rounds the round's turn into the cove: a 4 mm convex round tangent to both, shaded as its own circle, the deck's edge unmoved", () => {
    const section = bizjetGlareshieldSection();
    const g = BIZJET_GLARESHIELD;
    const { points, centre, radius } = section.joint;
    expect(radius, "the joint's round, 4 mm").toBe(0.004);
    for (const p of points) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(radius, 12);
    // tangent to the round (inside it, R - rho from its centre) and to the cove's line (rho from it, on the solid's side)
    expect(Math.hypot(centre.x - section.centre.x, centre.y - section.centre.y)).toBeCloseTo(g.radius - radius, 12);
    const fromCove = ((centre.x - section.coveTop.x) + (centre.y - section.coveTop.y)) * Math.SQRT1_2;
    expect(fromCove, "rho above the cove's line").toBeCloseTo(radius, 12);
    // the deck's edge is the round's tangent above and the cove's foot below: neither moves
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    expect(el(section.tangent) - el(section.faceTop), "the deck's edge").toBeLessThanOrEqual(TARGETS.deckEdge);
    // shaded as its circle: every chord's corners carry its radial
    const lip = named("bizjet-glareshield");
    const positions = lip.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = lip.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = lip.getIndices()!;
    const onJoint = (i: number) => points.some((p) => Math.abs(p.x - positions[i * 3]!) < 1e-6 && Math.abs(p.y - positions[i * 3 + 1]!) < 1e-6);
    let chords = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      if (Math.abs(normals[corners[0]! * 3 + 2]!) > 0.5 || !corners.every(onJoint)) continue;
      chords += 1;
      for (const i of corners) {
        const r = new Vector3(positions[i * 3]! - centre.x, positions[i * 3 + 1]! - centre.y, 0).normalize();
        expect(Vector3.Dot(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), r), "a joint corner's normal").toBeGreaterThan(1 - 1e-6);
      }
    }
    expect(chords, "the joint's chord triangles").toBe(g.jointSegments * 2);
  });

  it("leaves no crease where the round turns into the cove: down the round's lower half, through the joint into the flat cove", () => {
    const section = bizjetGlareshieldSection();
    const steps: number[] = [];
    for (const az of [-20, 0, 21, 30]) {
      let previous: Vector3 | null = null;
      const start = lineElevation(section.round[section.round.length - 3]!, az);
      for (let e = start; e > lineElevation(section.faceTop, az) + 0.05; e -= PIXEL_1080P) {
        const seen = shadedAt(az, e);
        if (!seen || seen.mesh !== "bizjet-glareshield") break;
        if (previous) steps.push(Math.acos(Math.min(1, Vector3.Dot(previous, seen.normal))) * DEG);
        previous = seen.normal;
      }
    }
    console.info(`round -> joint -> cove, row to row: ${steps.length} steps, largest ${Math.max(...steps).toFixed(2)} degrees`);
    expect(steps.length).toBeGreaterThan(20);
    expect(Math.max(...steps), "no crease where the round turns into the cove").toBeLessThan(45);
  });

  it("turns the round into one gradient as the pilot sees it: a pixel apart, the shading turns 8 degrees at most", () => {
    const section = bizjetGlareshieldSection();
    const radius = BIZJET_GLARESHIELD.radius;
    // the round ends where the joint's round leaves it (its own test holds the joint)
    const jointStart = Math.atan2(section.joint.points[0]!.y - section.centre.y, section.joint.points[0]!.x - section.centre.x) * DEG;
    const steps: number[] = [];
    for (const az of [-20, -8, 0, 12, 30]) {
      // from a pixel under the silhouette down the round, one 1080p pixel at a time, while the hit is on the circle
      let previous: Vector3 | null = null;
      const tangent = lineElevation(section.tangent, az);
      for (let el = tangent - PIXEL_1080P; el > tangent - 3; el -= PIXEL_1080P) {
        const seen = shadedAt(az, el);
        if (!seen || seen.mesh !== "bizjet-glareshield") break;
        // on the circle and within the round's own span (from the hood's tangent round to the aft one, 90 to 180 degrees
        // from +x about the centre): past the aft tangent is the cove, a designed 45 degree turn
        const off = Math.hypot(seen.point.x - section.centre.x, seen.point.y - section.centre.y) - radius;
        const polar = Math.atan2(seen.point.y - section.centre.y, seen.point.x - section.centre.x) * DEG;
        if (Math.abs(off) > 0.0005 || polar < 0 || polar > jointStart) break;
        if (previous) steps.push(Math.acos(Math.min(1, Vector3.Dot(previous, seen.normal))) * DEG);
        previous = seen.normal;
      }
    }
    console.info(`the round, row to row: ${steps.length} steps, largest ${Math.max(...steps).toFixed(2)} degrees, mean ${(steps.reduce((a, b) => a + b, 0) / steps.length).toFixed(2)}`);
    expect(steps.length, "rows sampled across the round").toBeGreaterThan(40);
    expect(Math.max(...steps)).toBeLessThanOrEqual(8);
  });

  it("fillets the cove's foot into the panel's face: a 5 mm round tangent to both, shaded as the circle", () => {
    const fillet = bizjetCoveFillet();
    const face = bizjetPanelFace();
    const section = bizjetGlareshieldSection();
    const r = BIZJET_COVE_FILLET.radius;
    expect(r, "the fillet's radius: 7.5 mm, the smallest (to half a millimetre) that reads under 8 degrees a 1080p pixel from the seat").toBe(0.0075);
    for (const p of fillet.points) expect(Math.hypot(p.x - fillet.centre.x, p.y - fillet.centre.y)).toBeCloseTo(r, 12);
    // the centre stands on the pilot's side of both surfaces, `r` from each
    const coveOff = ((fillet.centre.x - section.faceTop.x) * -Math.SQRT1_2 + (fillet.centre.y - section.faceTop.y) * -Math.SQRT1_2);
    const faceOff = (fillet.centre.x - face.top.x) * face.normal.x + (fillet.centre.y - face.top.y) * face.normal.y;
    expect(coveOff, "the centre r out from the cove's plane").toBeCloseTo(r, 12);
    expect(faceOff, "the centre r out from the face's plane").toBeCloseTo(r, 12);
    // tangent: its first row on the cove with the cove's normal, its last on the face with the face's
    const first = fillet.points[0]!;
    const last = fillet.points.at(-1)!;
    expect((first.x - section.faceTop.x) + (first.y - section.faceTop.y), "the first row on the cove's line").toBeCloseTo(0, 12);
    expect((last.x - face.top.x) * face.normal.x + (last.y - face.top.y) * face.normal.y, "the last row on the face's plane").toBeCloseTo(0, 12);
    expect(fillet.normals[0]!.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(fillet.normals[0]!.y).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(fillet.normals.at(-1)!.x).toBeCloseTo(face.normal.x, 12);
    expect(fillet.normals.at(-1)!.y).toBeCloseTo(face.normal.y, 12);
    // the mesh: on the glareshield's material, as wide as the deck, and smooth (its faces share their vertices)
    const mesh = named("bizjet-cove-fillet");
    expect(mesh.material).toBe(named("bizjet-glareshield").material);
    const halfWidth = Math.max(...worldVertices(named("bizjet-cockpit-interior")).slice(0, 24).map((v) => Math.abs(v.z)));
    expect(Math.max(...worldVertices(mesh).map((v) => Math.abs(v.z))), "across the deck").toBeCloseTo(halfWidth, 9);
    expect(mesh.getTotalVertices(), "smooth faces share vertices: fewer than three a triangle").toBeLessThan(mesh.getTotalIndices());
    // an open sheet (no rim along the tangent lines to trade pixels with the cove and the face), shaded with the circle's
    // normal at every row: its first row's IS the cove's and its last row's the face's, as built
    expect(mesh.getTotalVertices(), "a grid of rows by two columns, no rim").toBe(BIZJET_COVE_FILLET.rows * 2);
    const built = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const rowNormal = (row: number) => new Vector3(built[row * 6]!, built[row * 6 + 1]!, built[row * 6 + 2]!);
    expect(Vector3.Dot(rowNormal(0), new Vector3(-Math.SQRT1_2, -Math.SQRT1_2, 0)), "the first row shaded as the cove").toBeGreaterThan(1 - 1e-6);
    expect(Vector3.Dot(rowNormal(BIZJET_COVE_FILLET.rows - 1), new Vector3(face.normal.x, face.normal.y, 0)), "the last row shaded as the face").toBeGreaterThan(1 - 1e-6);
  });

  it("leaves no crease at the cove's foot: sighting down through cove, fillet and face, the shading turns 8 degrees a pixel at most", () => {
    // The cove met the face at 60 degrees: 60 in one pixel. A 5 mm fillet turned up to 11.9 a 1080p pixel from the seat
    // (its cove end is seen obliquely, so the arc crowds there), 6.2 mm 9.8, 7 mm 8.1; 7.5 mm keeps it under 8.
    const section = bizjetGlareshieldSection();
    const steps: number[] = [];
    let crossed = 0;
    // over the bare board, outboard of the pilot's pair and between it and the first officer's (over the screens their
    // bezels meet the foot, which is the bezels' clearance, held apart): either side of the standby (S5), which stands
    // over the board at azimuth 23.8 to 34.9
    for (const az of [-22, -21, 21, 22.5, 35.5, 36.5]) {
      let previous: { mesh: string; normal: Vector3 } | null = null;
      for (let e = lineElevation(section.joint.points.at(-1)!, az) - PIXEL_1080P / 2; e > lineElevation(section.faceTop, az) - 0.6; e -= PIXEL_1080P) {
        const seen = shadedAt(az, e);
        if (!seen) break;
        if (previous) {
          steps.push(Math.acos(Math.min(1, Vector3.Dot(previous.normal, seen.normal))) * DEG);
          if (previous.mesh === "bizjet-cove-fillet" && seen.mesh !== previous.mesh) crossed += 1;
        }
        previous = seen;
      }
    }
    console.info(`the cove's foot, row to row: ${steps.length} steps, largest ${Math.max(...steps).toFixed(2)} degrees; ${crossed} sightlines left the fillet for the face`);
    expect(crossed, "every sightline crossed the fillet into the face").toBe(6);
    expect(Math.max(...steps)).toBeLessThanOrEqual(8);
  });

  it("closes the deck's ends in a quarter-round: the tip at the cove's foot, the deck's end the full section, outboard of the deck", () => {
    const g = BIZJET_GLARESHIELD;
    const section = bizjetGlareshieldSection();
    const deck = deckHalfWidth();
    const lip = worldVertices(named("bizjet-glareshield"));
    for (const side of [-1, 1] as const) {
      const tip = lip.filter((v) => Math.abs(v.z - side * (deck + g.endRound)) < 1e-5);
      expect(tip.length, "the tip's vertices").toBeGreaterThan(0);
      // the section scaled to nothing about the cove's foot: every vertex at the tip IS that corner
      for (const v of tip) {
        expect(v.x, "the tip at the cove's foot").toBeCloseTo(section.faceTop.x, 5);
        expect(v.y).toBeCloseTo(section.faceTop.y, 5);
      }
      // nothing of it further out, nothing of it higher than the straight lip's round
      expect(Math.max(...lip.map((v) => side * v.z)), "the round's reach").toBeCloseTo(deck + g.endRound, 5);
    }
    expect(Math.max(...lip.map((v) => v.y)), "no higher than the round's top").toBeLessThanOrEqual(Math.max(...section.round.map((p) => p.y)) + 1e-6);
  });

  it("shades the end rounds smoothly: outboard along a row through the port end's round, 8 degrees a pixel at most", () => {
    // Rows across the round's lit upper half, walked outboard a 1080p pixel at a time from the straight lip into its end
    // round and off it: every step on the lip turns the shading 8 degrees at most (the round's stations are 15 apart,
    // so a flat-shaded end would step 15 at each).
    const section = bizjetGlareshieldSection();
    const steps: number[] = [];
    for (const el of [lineElevation(section.tangent, -22) - 0.15, lineElevation(section.tangent, -22) - 0.4, lineElevation(section.tangent, -22) - 0.7]) {
      let previous: Vector3 | null = null;
      for (let az = -21.5; az > -24.5; az -= PIXEL_1080P) {
        const seen = shadedAt(az, el);
        if (!seen || seen.mesh !== "bizjet-glareshield") {
          if (previous) break;
          continue;
        }
        if (previous) steps.push(Math.acos(Math.min(1, Vector3.Dot(previous, seen.normal))) * DEG);
        previous = seen.normal;
      }
    }
    console.info(`the port end round, outboard: ${steps.length} steps, largest ${Math.max(...steps).toFixed(2)} degrees`);
    expect(steps.length).toBeGreaterThan(30);
    expect(Math.max(...steps)).toBeLessThanOrEqual(8);
  });

  it("falls the lit round away at the port end in a curve, not a cut: no straight run down the end's silhouette", () => {
    // The end's silhouette row by row (1080p pitch), from the straight lip's top down to the cove's foot: the outermost
    // azimuth at which the eye meets the lip on that row. A square end is one azimuth down its whole height (54 rows);
    // a round steps out row by row.
    const section = bizjetGlareshieldSection();
    const top = lineElevation(section.tangent, -22);
    const foot = lineElevation(section.faceTop, -22);
    const outermost = (el: number) => {
      let inside = -18;
      let outside = -30;
      if (firstPart(inside, el) !== "bizjet-glareshield") return Number.NaN;
      for (let k = 0; k < 30; k += 1) {
        const mid = (inside + outside) / 2;
        if (firstPart(mid, el) === "bizjet-glareshield") inside = mid;
        else outside = mid;
      }
      return inside;
    };
    const profile: number[] = [];
    for (let el = top - PIXEL_1080P; el > foot + PIXEL_1080P; el -= PIXEL_1080P) profile.push(outermost(el));
    // the silhouette down the end, from the lip's top to where it reaches the tip (under that the cove and its fillet)
    const finite = profile.filter(Number.isFinite);
    const rows = finite.slice(0, finite.indexOf(Math.min(...finite)) + 1);
    // a square end holds one azimuth row after row; the round leans out a little every row, and only its tip, where the
    // quarter-round closes to a point, stands straight for a few rows
    let straight = 1;
    let run = 1;
    for (let k = 1; k < rows.length; k += 1) {
      run = Math.abs(rows[k]! - rows[k - 1]!) < PIXEL_1080P / 10 ? run + 1 : 1;
      straight = Math.max(straight, run);
    }
    const extent = (rows[0]! - Math.min(...rows)) / PIXEL_1080P;
    console.info(`the port end's silhouette: ${rows.length} rows, outermost azimuth ${rows[0]!.toFixed(2)} at the top to ${Math.min(...rows).toFixed(2)} (${extent.toFixed(1)} px out); longest straight run ${straight} rows`);
    expect(rows.length, "rows down the end").toBeGreaterThan(30);
    expect(extent, "the end leans out, 1080p pixels").toBeGreaterThanOrEqual(15);
    expect(straight, "the longest run of rows on one column (a tenth of a pixel)").toBeLessThanOrEqual(5);
  });

  it("shows nothing of the glareshield or the board over the lip: the lip is the edge the pilot reads", () => {
    let rays = 0;
    const halfWidth = deckHalfWidth();
    for (let az = -35.63; az <= 35; az += 1.5) {
      // only where the straight lip is (its end rounds fall away outboard of it, S4)
      const z = EYE.right + (bizjetPanelFaceX() - EYE.forward) * Math.tan(az / DEG);
      if (Math.abs(z) > halfWidth - 0.01) continue;
      const part = firstPart(az, lipElevation(az) + 0.05);
      rays += 1;
      expect(["bizjet-glareshield", "bizjet-instrument-panel"], `the lip's own body at azimuth ${az.toFixed(2)}`).not.toContain(part);
      // CONTROL: just under the lip the ray meets the lip
      expect(firstPart(az, lipElevation(az) - 0.05), `under the lip at azimuth ${az.toFixed(2)}`).toBe("bizjet-glareshield");
    }
    expect(rays).toBeGreaterThan(15);
  });

  it("puts the deck line at the catalogue's value by the HUD's own instrument and by ray", () => {
    const recorded = aircraftSpec("bizjet").cockpitDeckLineDegrees;
    const view = cockpitView("bizjet", 1600, 900);
    let row = Number.NaN;
    try {
      row = measureDeckLineDegrees(view);
    } finally {
      view.dispose();
    }
    let ahead = Number.NaN;
    for (let e = 5; e >= -30; e -= 0.005) {
      if (firstPart(0, e) === "bizjet-glareshield") {
        ahead = e;
        break;
      }
    }
    console.info(`the Global's deck line: the deck's highest row ${row.toFixed(4)} (the HUD's instrument), the lip straight ahead ${(-ahead).toFixed(3)} by ray; catalogue ${recorded}`);
    expect(Math.abs(row - recorded), "the instrument and the catalogue").toBeLessThanOrEqual(0.02);
    expect(Math.abs(-ahead - recorded), "the ray and the catalogue").toBeLessThanOrEqual(0.02);
  });
});

describe("the Global's screens", () => {
  /** A screen box's own 24 vertices in the merged screens mesh, in placement order. */
  const screenBlock = (k: number) => worldVertices(named("bizjet-screens")).slice(k * 24, k * 24 + 24);
  /** Up the leaned face, and out of it toward the pilot. */
  const faceUp = () => new Vector3(bizjetPanelFace().up.x, bizjetPanelFace().up.y, 0);
  const faceOut = () => new Vector3(bizjetPanelFace().normal.x, bizjetPanelFace().normal.y, 0);
  /**
   * A box's pilot-facing face: its four corners, bottom pair then top pair, each in z order. The vertex data is float32
   * (a micrometre at these stations), so "on the face" and "the same corner" are to 2 micrometres: at 1e-9 the finder
   * found all four corners at one lean and two at another, by the rounding alone.
   */
  const frontCorners = (block: Vector3[]): [Vector3, Vector3, Vector3, Vector3] => {
    const out = Math.max(...block.map((v) => Vector3.Dot(v, faceOut())));
    const corners: Vector3[] = [];
    for (const v of block) {
      if (Math.abs(Vector3.Dot(v, faceOut()) - out) > 2e-6) continue;
      if (!corners.some((c) => Vector3.Distance(c, v) < 2e-6)) corners.push(v);
    }
    expect(corners, "a box face's four corners").toHaveLength(4);
    corners.sort((a, b) => Vector3.Dot(a, faceUp()) - Vector3.Dot(b, faceUp()) || a.z - b.z);
    return corners as [Vector3, Vector3, Vector3, Vector3];
  };

  it("hang four screens 0.22 by 0.15 in front of the panel, the pilot's pair centred on the eye's own z", () => {
    // The sizes are the PM's numbers, written out here and not read from the builder's constants.
    const WIDTH = 0.22;
    const HEIGHT = 0.15;
    const BEZEL = 0.01;
    const TOP_BORDER = 0.006;
    // the pairs' own (the standby and the consoles' blocks share these meshes since S5)
    const screens = sourceVertices("bizjet-screens", /^bizjet-screen-(port|starboard)-/);
    const bezels = sourceVertices("bizjet-screen-bezels", /^bizjet-screen-bezel-(port|starboard)-/);
    const clustersOf = (vertices: Vector3[], pair: (v: Vector3) => boolean) => {
      const inPair = vertices.filter(pair);
      const levels = [...new Set(inPair.map((v) => v.z.toFixed(5)))].map(Number).sort((a, b) => a - b);
      expect(levels.length, "distinct z levels in a pair").toBe(4);
      const boundary = (levels[1]! + levels[2]!) / 2;
      return { first: inPair.filter((v) => v.z < boundary), second: inPair.filter((v) => v.z >= boundary), gap: levels[2]! - levels[1]! };
    };
    for (const [label, sign, vertices, width, height] of [
      ["screens", -1, screens, WIDTH, HEIGHT],
      ["screens", 1, screens, WIDTH, HEIGHT],
    ] as const) {
      const { first, second, gap } = clustersOf(vertices, (v) => v.z * sign > 0);
      for (const cluster of [first, second]) {
        expect(cluster.length, `${label} ${sign} vertices`).toBe(24);
        expect(Math.max(...cluster.map((v) => v.z)) - Math.min(...cluster.map((v) => v.z)), `${label} width`).toBeCloseTo(width, 4);
        // the height is measured UP THE FACE: the face leans back, and a y extent would be the height times its cos
        const up = cluster.map((v) => Vector3.Dot(v, faceUp()));
        expect(Math.max(...up) - Math.min(...up), `${label} height`).toBeCloseTo(height, 4);
      }
      const all = [...first, ...second];
      const centre = (Math.max(...all.map((v) => v.z)) + Math.min(...all.map((v) => v.z))) / 2;
      expect(centre, `${label} pair centre`).toBeCloseTo(sign < 0 ? EYE.right : -EYE.right, 4);
      expect(gap, `${label} gap between the two`).toBeGreaterThan(0.005);
      expect(gap, `${label} gap between the two`).toBeLessThan(0.06);
    }
    // THE BEZELS: frames round the screens, their rims round the frames, BEZEL beyond the screen at the sides and the foot
    // and TOP_BORDER over it (S2); the opening round the screen is the design's gap wider than it
    const GAP = 0.002;
    const rims = worldVertices(named("bizjet-screen-bezel-rims"));
    for (const [k, { faceCentre }] of bizjetScreenPlacements().entries()) {
      const bezel = [...bezels.slice(k * 72, k * 72 + 72), ...rims.slice(k * 96, k * 96 + 96)];
      const across = bezel.map((v) => v.z - faceCentre.z);
      const up = bezel.map((v) => Vector3.Dot(v.subtract(faceCentre), faceUp()));
      expect(Math.max(...across) - Math.min(...across), `bezel ${k}'s width`).toBeCloseTo(WIDTH + 2 * BEZEL, 5);
      expect(Math.max(...up) - Math.min(...up), `bezel ${k}'s height, up the face`).toBeCloseTo(HEIGHT + BEZEL + TOP_BORDER, 5);
      expect(Math.max(...up), `bezel ${k}'s top border`).toBeCloseTo(HEIGHT / 2 + TOP_BORDER, 5);
      const opening = across.filter((z) => Math.abs(z) < WIDTH / 2 + GAP + 1e-4);
      expect(Math.max(...opening.map(Math.abs)), `bezel ${k}'s opening, the screen and its gap`).toBeCloseTo(WIDTH / 2 + GAP, 5);
    }
  });

  it("stand the frames' tops clear of the cove: a strip of board under the fillet's foot, at least 4 mm under the cove's foot", () => {
    // THE RULE ON THE FRAME'S TOP (S2): the frame's top 1.2 mm of board under the cove fillet's foot, along the face; the
    // screen's top the frame's 6 mm top border under that. (It was on the screen's top, 0.8 degrees under the cove's foot,
    // which put the frames' tops 0.5 mm INTO the cove.)
    const face = bizjetPanelFace();
    const upFace = (v: { x: number; y: number }) => (v.x - face.top.x) * face.up.x + (v.y - face.top.y) * face.up.y;
    const filletFoot = upFace(bizjetCoveFillet().points.at(-1)!);
    for (const [k, { faceCentre }] of bizjetScreenPlacements().entries()) {
      const frameTop = upFace(faceCentre) + 0.075 + 0.006;
      expect(frameTop, `frame ${k}'s top, under the fillet's foot`).toBeCloseTo(filletFoot - 0.0012, 9);
      expect(-frameTop, `frame ${k}'s top under the cove's foot`).toBeGreaterThanOrEqual(0.004);
      const [, , top] = frontCorners(screenBlock(k));
      expect(upFace(top), `screen ${k}'s top edge, the top border under the frame's`).toBeCloseTo(frameTop - 0.006, 5);
    }
    // by ray at the 1080p pixel pitch, over each screen: down from the cove, the fillet, then board (2 pixels or more),
    // then the frame's rim; never the frame straight under the fillet
    const section = bizjetGlareshieldSection();
    for (const az of [-15, -5, 5, 15]) {
      const seen: string[] = [];
      for (let e = lineElevation(section.faceTop, az) + 0.1; e > lineElevation(section.faceTop, az) - 1; e -= PIXEL_1080P) {
        const hit = shadedAt(az, e);
        if (!hit) continue;
        const part = hit.mesh === "bizjet-cockpit-interior" ? "board" : hit.mesh;
        if (seen.at(-1) !== part) seen.push(part);
        if (part === "bizjet-screen-bezel-rims") break;
      }
      expect(seen.slice(-3), `from the fillet to the frame at azimuth ${az}`).toEqual(["bizjet-cove-fillet", "board", "bizjet-screen-bezel-rims"]);
      let board = 0;
      for (let e = lineElevation(section.faceTop, az); e > lineElevation(section.faceTop, az) - 1; e -= PIXEL_1080P / 4) {
        if (shadedAt(az, e)?.mesh === "bizjet-cockpit-interior") board += 1;
        else if (board > 0) break;
      }
      expect(board / 4, `board between the fillet and the frame at azimuth ${az}, 1080p pixels`).toBeGreaterThanOrEqual(2);
    }
  });

  it("ride the leaned face: each screen, frame, rim and well square to it, the frame 1 mm into the board, the screen 3 mm BEHIND the frame's front", () => {
    const face = bizjetPanelFace();
    const plane = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y; // out of the face
    const levels = (vs: number[]) => [...new Set(vs.map((d) => d.toFixed(5)))].map(Number).sort((a, b) => a - b);
    const frames = worldVertices(named("bizjet-screen-bezels"));
    const rims = worldVertices(named("bizjet-screen-bezel-rims"));
    const wells = worldVertices(named("bizjet-screen-wells"));
    for (const k of [0, 1, 2, 3]) {
      // (float32: the planes to a hundredth of a millimetre)
      const screen = levels(screenBlock(k).map(plane));
      const frame = levels(frames.slice(k * 72, k * 72 + 72).map(plane));
      const rim = levels(rims.slice(k * 96, k * 96 + 96).map(plane));
      const well = levels(wells.slice(k * 24, k * 24 + 24).map(plane));
      // the frame: its back 1 mm inside the board, its front 6 mm out; the rim the same, and the chamfer's foot 4 mm under
      expect(frame, `frame ${k}'s planes: back, front`).toEqual([-0.001, 0.006]);
      expect(rim, `rim ${k}'s planes: back, the chamfer's foot, front`).toEqual([-0.001, 0.002, 0.006]);
      // the screen: a 0.5 mm plate whose face is 3 mm behind the frame's front
      expect(screen, `screen ${k}'s planes`).toEqual([0.0025, 0.003]);
      // the well: straddling the board's face, behind the screen
      expect(well, `well ${k}'s planes`).toEqual([-0.0005, 0.0005]);
    }
  });

  it("bevel each bezel: a 4 mm chamfer at 45 degrees round its outer edge, facing out of the face, by the built normals", () => {
    const face = bizjetPanelFace();
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const up = new Vector3(face.up.x, face.up.y, 0);
    const rims = named("bizjet-screen-bezel-rims");
    const normals = rims.getVerticesData(VertexBuffer.NormalKind)!;
    const vertices = worldVertices(rims);
    const seen = new Set<string>();
    let chamfer = 0;
    // the screens' rims, the pairs' and the standby's (the consoles' rockers share the mesh since S5)
    for (const i of sourceIndices("bizjet-screen-bezel-rims", /^bizjet-screen-bezel-rim-/)) {
      const n = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      // the rim's only faces toward the pilot are the chamfer's (its walls face sideways or into the board)
      if (Vector3.Dot(n, out) <= 1e-6) continue;
      chamfer += 1;
      // 45 degrees off the face's normal, and the rest of it along one of the face's own sides
      expect(Vector3.Dot(n, out), "45 degrees to the face").toBeCloseTo(Math.SQRT1_2, 5);
      const side = n.subtract(out.scale(Math.SQRT1_2));
      const along = [up, up.scale(-1), new Vector3(0, 0, 1), new Vector3(0, 0, -1)].findIndex((d) => Vector3.Dot(side, d) > Math.SQRT1_2 - 1e-5);
      expect(along, "outward along a side").toBeGreaterThanOrEqual(0);
      seen.add(`${along}`);
    }
    expect(seen.size, "all four sides").toBe(4);
    expect(chamfer, "four chamfer quads a bezel, two triangles each, five bezels").toBe(5 * 4 * 2 * 3);
    // its width across the face and its fall toward it: 4 mm each (the planes are pinned by the stack test)
    for (const [k, { faceCentre }] of bizjetScreenPlacements().entries()) {
      const rim = vertices.slice(k * 96, k * 96 + 96).map((v) => Math.abs(v.z - faceCentre.z));
      const edges = [...new Set(rim.map((z) => z.toFixed(5)))].map(Number).sort((a, b) => a - b).slice(-2);
      expect(edges[1]! - edges[0]!, `rim ${k}: 4 mm across the face`).toBeCloseTo(0.004, 5);
    }
  });

  it("recess each screen 3 mm behind its bezel in a 2 mm dark well: by ray, the screen's face, the gap, the frame", () => {
    const face = bizjetPanelFace();
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const up = new Vector3(face.up.x, face.up.y, 0);
    const offOf = (p: Vector3) => (p.x - face.top.x) * face.normal.x + (p.y - face.top.y) * face.normal.y;
    const screens = named("bizjet-screens");
    for (const { name, faceCentre } of bizjetScreenPlacements().slice(0, 2)) {
      // a ray at the screen's middle meets the screen, 3 mm behind the frame's front
      const middle = faceCentre.add(out.scale(0.003));
      const hit = firstHitAlong(middle.subtract(EYE_POINT));
      expect(hit?.mesh, `${name}: the screen at its middle`).toBe(screens);
      const at = EYE_POINT.add(middle.subtract(EYE_POINT).normalize().scale(hit!.distance));
      expect(0.006 - offOf(at), `${name}: the recess, by ray`).toBeCloseTo(0.003, 4);
      // a ray into the gap, a millimetre off the screen's edge, meets the WELL, dark: on the side toward the eye, and over
      // the screen's top (the eye looks down into it). Seen 10 to 20 degrees off the face, the screen's own edge hides the
      // far side's gap, as a recessed screen's does.
      const towardEye = Math.sign(EYE.right - faceCentre.z);
      const side = faceCentre.add(new Vector3(0, 0, towardEye * (0.11 + 0.001))).add(out.scale(0.0005));
      expect(firstHitAlong(side.subtract(EYE_POINT))?.mesh.name, `${name}: the gap on the side toward the eye`).toBe("bizjet-screen-wells");
      const top = faceCentre.add(up.scale(0.075 + 0.001)).add(out.scale(0.0005));
      expect(firstHitAlong(top.subtract(EYE_POINT))?.mesh.name, `${name}: the gap over the screen`).toBe("bizjet-screen-wells");
      // and a ray at the frame's flat face meets the frame, on its front
      const flat = faceCentre.add(new Vector3(0, 0, 0.11 + 0.002 + 0.002)).add(out.scale(0.006));
      const onFrame = firstHitAlong(flat.subtract(EYE_POINT));
      expect(onFrame?.mesh.name, `${name}: the frame's face`).toBe("bizjet-screen-bezels");
    }
  });

  it("show at least the target share of each of the pilot's two screens in the 16:9 frame, each at its own azimuth", () => {
    // Over a 21 x 21 grid of each screen's pilot-facing face: inside the frame's own rectangle, and the first thing the
    // cockpit camera draws along the ray is that screen, where the face is.
    const screens = named("bizjet-screens");
    const names = (screens.metadata as { mergedFrom: string[] }).mergedFrom;
    const fractions: Record<string, number> = {};
    for (const [k, name] of names.entries()) {
      const [b0, b1, t0, t1] = frontCorners(screenBlock(k));
      let seen = 0;
      for (let i = 0; i <= 20; i += 1) {
        for (let j = 0; j <= 20; j += 1) {
          const p = Vector3.Lerp(Vector3.Lerp(b0, b1, (j + 0.5) / 21), Vector3.Lerp(t0, t1, (j + 0.5) / 21), (i + 0.5) / 21);
          const q = p.subtract(EYE_POINT);
          if (Math.abs(q.z / q.x) > FRAME_U || Math.abs(q.y / q.x) > FRAME_V) continue;
          const hit = firstHitAlong(q);
          if (hit?.mesh === screens && Math.abs(hit.distance - q.length()) < 1e-3) seen += 1;
        }
      }
      fractions[name.replace("bizjet-screen-", "")] = seen / 441;
    }
    console.info(`the Global's screens in the frame: ${Object.entries(fractions).map(([n, f]) => `${n} ${(f * 100).toFixed(1)}%`).join(", ")}`);
    for (const name of ["port-outboard", "port-inboard"]) expect(fractions[name], `${name} in the frame`).toBeGreaterThanOrEqual(TARGETS.displays);
    // NON-VACUITY: the instrument can read a screen as out of the frame; the other seat's pair is beyond its right edge
    expect(fractions["starboard-outboard"]).toBe(0);
  });
});

describe("the Global's cockpit against the shell it stands in", () => {
  /** The shell's half-width at (x, y) on one side, by a ray from the centreline; the body is one loft, so the only crossing. */
  function halfWidth(x: number, y: number, side: 1 | -1): number {
    return crossings(new Vector3(x, y, 0), new Vector3(0, 0, side), shell).at(-1) ?? Number.NaN;
  }

  it("keeps the board, the lip, the screens and the bezels inside the skin with clearance", () => {
    const lines: string[] = [];
    const parts: [string, Vector3[]][] = [
      ["panel board", worldVertices(named("bizjet-cockpit-interior")).slice(0, 24)],
      ["glareshield lip", worldVertices(named("bizjet-glareshield"))],
      ["screens", worldVertices(named("bizjet-screens"))],
      ["bezels", worldVertices(named("bizjet-screen-bezels"))],
    ];
    for (const [label, vertices] of parts) {
      let tightest = Number.POSITIVE_INFINITY;
      let measured = 0;
      for (const v of vertices) {
        if (Math.abs(v.z) < 1e-4) continue;
        const wall = halfWidth(v.x, v.y, v.z < 0 ? -1 : 1);
        if (!Number.isFinite(wall)) continue;
        measured += 1;
        tightest = Math.min(tightest, wall - Math.abs(v.z));
      }
      expect(measured, `${label}: vertices measured`).toBeGreaterThan(vertices.length / 2);
      lines.push(`${label}: tightest clearance ${tightest.toFixed(4)} m over ${measured} vertices`);
      expect(tightest, `${label} against the skin`).toBeGreaterThanOrEqual(0.005);
    }
    console.info(`the Global's cockpit clearance from the skin:\n  ${lines.join("\n  ")}`);
  });

  it("stands the glareshield's aft face the design's distance ahead of the eye, the board's face under the cove and down past the frame", () => {
    expect(bizjetPanelFaceX() - EYE.forward).toBeCloseTo(BIZJET_PANEL.faceAheadOfEye, 9);
    // (to the joint's cut: the 4 mm round into the cove takes the corner's last 0.1 mm)
    expect(Math.min(...worldVertices(named("bizjet-glareshield")).map((v) => v.x))).toBeCloseTo(bizjetPanelFaceX(), 3);
    const face = bizjetPanelFace();
    const board = worldVertices(named("bizjet-cockpit-interior")).slice(0, 24);
    // the face's top edge is the cove's foot, and the face runs down past where the frame's bottom crosses it
    expect(face.top.x - bizjetPanelFaceX()).toBeCloseTo(BIZJET_GLARESHIELD.cove, 12);
    expect(face.top.y).toBeCloseTo(bizjetGlareshieldSection().faceTop.y, 12);
    // the face's foot: the lowest of the board's corners IN the face's plane (the back's foot is lower, the box leaning)
    const inFace = board.filter((v) => Math.abs((v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y) < 2e-6);
    const lowestFace = inFace.reduce((a, b) => (a.y < b.y ? a : b));
    expect(lowestFace.y).toBeCloseTo(face.bottomY, 5);
    expect((lowestFace.y - EYE.up) / (lowestFace.x - EYE.forward), "the face's foot under the frame's bottom").toBeLessThan(-FRAME_V);
    // and the lining runs past the lip's line: the rows under the glass the lip does not reach are sill all the way
    expect(BIZJET_LINING.bottom).toBeLessThan(-30);
  });
});

describe("the Global's panel face", () => {
  it("leans back by the design's angle about its top edge at the cove's foot: the box's face, square to the leaned normal", () => {
    const lean = BIZJET_PANEL.leanDegrees / DEG;
    const face = bizjetPanelFace();
    expect(face.normal.x).toBeCloseTo(-Math.cos(lean), 12);
    expect(face.normal.y).toBeCloseTo(Math.sin(lean), 12);
    // the built board's pilot-facing face: its four corners lie in the leaned plane through the cove's foot
    const board = worldVertices(named("bizjet-cockpit-interior")).slice(0, 24);
    const out = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y;
    const front = Math.max(...board.map(out));
    const back = Math.min(...board.map(out));
    for (const v of board) expect(Math.min(Math.abs(out(v) - front), Math.abs(out(v) - back)), "every corner on the face or the back").toBeLessThan(2e-6);
    expect(front, "the face through the cove's foot").toBeCloseTo(0, 5);
    expect(front - back, "the board's thickness, square to its face").toBeCloseTo(BIZJET_PANEL.thickness, 5);
  });

  it("aims its normal at the eye from the centre of the pilot's pair of screens (a screen off the eye's z reads its azimuth more)", () => {
    const face = bizjetPanelFace();
    const normal = new Vector3(face.normal.x, face.normal.y, 0);
    const [outboard, inboard] = bizjetScreenPlacements();
    const pair = Vector3.Lerp(outboard!.centre, inboard!.centre, 0.5);
    expect(pair.z).toBeCloseTo(EYE.right, 12);
    const off = (at: Vector3) => Math.acos(Vector3.Dot(normal, EYE_POINT.subtract(at).normalize())) * DEG;
    console.info(`the Global's panel: leaned ${BIZJET_PANEL.leanDegrees} degrees; its normal ${off(pair).toFixed(2)} degrees off the eye at the pair's centre (el ${azel(pair).el.toFixed(2)}), ${off(outboard!.centre).toFixed(2)} at each screen's own`);
    expect(off(pair), "the normal against the eye").toBeLessThanOrEqual(TARGETS.aim);
    // CONTROL: the instrument can fail; the upright board P0 measured reads about 20 degrees off here
    const upright = new Vector3(-1, 0, 0);
    expect(Math.acos(Vector3.Dot(upright, EYE_POINT.subtract(pair).normalize())) * DEG).toBeGreaterThan(15);
  });
});

describe("the Global's side consoles", () => {
  /** The frame's rows, as elevation straight ahead in the picture's column `px`, the kit's first hit down each. */
  const column = (px: number) => {
    const u = (((px + 0.5) / 1600) * 2 - 1) * FRAME_U;
    const rows: { el: number; part: string | null }[] = [];
    for (let py = 440; py < 900; py += 1) {
      const v = -(((py + 0.5) / 900) * 2 - 1) * FRAME_V;
      const hit = firstHitAlong(new Vector3(1, v, u));
      rows.push({ el: Math.atan(v) * DEG, part: hit ? partOf(hit.mesh, hit.faceId) : null });
    }
    return rows;
  };
  /** Degrees of the column where the first thing met is the wall's own lining under the side panes. */
  const bareWall = (rows: { el: number; part: string | null }[]) => {
    let degrees = 0;
    for (let k = 0; k + 1 < rows.length; k += 1) if (/-bizjet-lining-sill-(forward|aft)-side$/.test(rows[k]!.part ?? "")) degrees += rows[k]!.el - rows[k + 1]!.el;
    return degrees;
  };

  it("fill the wall under the side panes' caps: at most 5 degrees of bare wall down each column of the frame's lower left", () => {
    // On part 5's nose the wall there was about 21 degrees; 6b's side pane reaches lower, and the glass comes down to -16
    // to -18 degrees in these columns, the pane's sill and its cap under it, then wall to the frame's bottom. The console
    // stands under the cap: with it, no wall shows under the cap, only the sill's band between the glass and the cap.
    const consoles = named("bizjet-side-consoles");
    const report: string[] = [];
    const underCap = (rows: { el: number; part: string | null }[]) => {
      // the cap, or the console's tiller or block where it stands in front of the cap (S5)
      const cap = rows.findIndex((r) => /-bizjet-lining-cap-forward-side$|^bizjet-console-(block|rocker|tiller)-/.test(r.part ?? ""));
      return cap < 0 ? Number.NaN : bareWall(rows.slice(rows.findIndex((r, k) => k > cap && !/-cap-|^bizjet-console-/.test(r.part ?? ""))));
    };
    for (const px of [40, 120, 200, 280, 340]) {
      const rows = column(px);
      const bare = bareWall(rows);
      // CONTROL: without the console (and the caps, merged with it since S5) the same column shows wall down to the
      // frame's bottom
      consoles.isVisible = false;
      let without = Number.NaN;
      try {
        without = bareWall(column(px));
      } finally {
        consoles.isVisible = true;
      }
      const withIt = underCap(rows);
      report.push(`px ${px}: ${bare.toFixed(2)} in all (under the cap ${withIt.toFixed(2)}; without the console and caps ${without.toFixed(2)})`);
      expect(without, `px ${px}: wall for the console to cover`).toBeGreaterThan(0.5);
      expect(withIt, `px ${px}: wall under the cap, with the console`).toBeLessThanOrEqual(0.05);
      expect(bare, `px ${px}: bare wall`).toBeLessThanOrEqual(TARGETS.bareWall);
    }
    console.info(`the Global's bare wall in the frame's lower left, degrees: ${report.join("; ")}`);
  });

  it("stand on the sill caps' inboard edges, vertex for vertex, level with the side panes' bottom edges (no T-junction)", () => {
    const consoles = worldVertices(named("bizjet-side-consoles"));
    for (const side of ["port", "starboard"] as const) {
      const rows = BIZJET_SILL_CAP.sills.map((sill) => panel(bizjetSillCapMeshName(sill, side === "port" ? -1 : 1)));
      // the caps' inboard edges on their top faces, forward side then aft side, shared corners once
      const edge = [...rows[0]!.columns > 0 ? Array.from({ length: rows[0]!.columns }, (_, c) => gridVertex(rows[0]!, 1, 1, c)) : [],
        ...Array.from({ length: rows[1]!.columns - 1 }, (_, c) => gridVertex(rows[1]!, 1, 1, c + 1))];
      const mine = consoles.filter((v) => (side === "port" ? v.z < 0 : v.z > 0));
      const onEdge = edge.filter((p) => mine.some((v) => Vector3.Distance(v, p) < 2e-6));
      expect(onEdge.length, `${side}: the console on the caps' columns`).toBeGreaterThan(8);
      // every console vertex near a cap chord is one of the chord's own ends: no T-junction along the seam
      for (let k = 0; k + 1 < edge.length; k += 1) {
        const [a, b] = [edge[k]!, edge[k + 1]!];
        for (const v of mine) {
          const ab = b.subtract(a);
          const t = Vector3.Dot(v.subtract(a), ab) / ab.lengthSquared();
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          expect(Vector3.Distance(v, a.add(ab.scale(t))), `${side}: a console vertex inside a cap chord`).toBeGreaterThan(0.001);
        }
      }
      // level with the edge: every console vertex at the top is at a cap column's height
      const heights = new Set(onEdge.map((p) => p.y.toFixed(5)));
      for (const v of mine.filter((q) => q.y > 0.2)) {
        const near = onEdge.some((p) => Math.abs(p.x - v.x) < 2e-6);
        if (near && v.y > Math.min(...onEdge.map((p) => p.y)) - 0.05) expect([...heights].some((h) => Math.abs(Number(h) - v.y) <= 0.04 + 1e-5), `${side}: a top vertex off its column's height`).toBe(true);
      }
    }
  });

  it("roll the top's inboard edge on a 10 mm round into the inboard face, a step outboard of the board's end (S5)", () => {
    // THROUGH S4 a 20 mm lip stood over a 45 degree cove, 90 and 46 degree creases the console's length (469 px at 1600),
    // and the lip stood flush against the board's face at its end (a 90 degree corner). Now: the top, a quarter round on
    // `round`, and the face, tangent and shaded as they turn; the face `gap` outboard of the board's end, which stands in
    // front of it with a step.
    const c = BIZJET_SIDE_CONSOLE;
    const deck = deckHalfWidth();
    const cap = [0, 1, 2, 3].map((k) => ({ x: 12.6 - 0.1 * k, y: 0.35 - 0.02 * k, z: -0.95 }));
    const built = bizjetSideConsole(cap, deck, -1, () => 2);
    const { points, normals } = built.surface;
    expect(points).toHaveLength(cap.length);
    for (const [i, row] of points.entries()) {
      const y = cap[i]!.y;
      expect(row[0]!.equals(new Vector3(cap[i]!.x, y, cap[i]!.z)), "from the cap's edge, vertex for vertex").toBe(true);
      // the round: on its circle, from level with the top to square to the face
      const round = row.slice(1, -1);
      const centre = { z: -(deck + c.gap + c.round), y: y - c.round };
      for (const p of round) expect(Math.hypot(p.z - centre.z, p.y - centre.y)).toBeCloseTo(c.round, 12);
      expect(round[0]!.y).toBeCloseTo(y, 12);
      expect(round.at(-1)!.z).toBeCloseTo(-(deck + c.gap), 12);
      // and the face, straight down to the floor, at the gap outboard of the board's end
      expect(row.at(-1)!.z).toBeCloseTo(-(deck + c.gap), 12);
      // shaded as it turns: up on the top, inboard on the face, every step of the round under 16 degrees
      expect(normals[i]![0]!.y).toBeGreaterThan(0.9);
      expect(normals[i]!.at(-1)!.z).toBeGreaterThan(0.999);
      for (let k = 1; k < row.length - 1; k += 1) {
        expect(Math.acos(Math.min(1, Vector3.Dot(normals[i]![k]!, normals[i]![k + 1]!))) * DEG).toBeLessThanOrEqual(16);
      }
    }
    // the built consoles: the port face's plane, the gap outboard of the board's end, and no face at the board's end
    const port = sourceVertices("bizjet-side-consoles", /^bizjet-side-console-port$/);
    const mesh = named("bizjet-side-consoles");
    expect(port.length).toBeGreaterThan(0);
    expect(Math.min(...port.map((v) => -v.z)), "the port face").toBeCloseTo(deck + c.gap, 9);
    void mesh;
  });

  it("follow the shell down from the cap: on a shell narrower below, the outboard bottom edge stays the margin inside it", () => {
    // On this nose the shell at the board's foot is wide enough that the cap's line is already inside it, so the rule is
    // pinned on a shell given to it: a cap line at 0.90 over a shell 0.85 wide at the foot
    const cap = [0, 1, 2, 3].map((k) => ({ x: 12.6 - 0.1 * k, y: 0.35, z: -0.9 }));
    const { facets } = bizjetSideConsole(cap, 0.7, -1, (_x, y) => (y < 0.3 ? 0.85 : 0.95));
    const low = facets.flatMap((f) => [...f.corners]).filter((v) => v.y < 0.3);
    expect(low.length).toBeGreaterThan(0);
    expect(Math.max(...low.map((v) => -v.z)), "the bottom's outboard edge").toBeCloseTo(0.85 - BIZJET_PANEL.shellMargin, 9);
    // and where the shell is wide the bottom keeps the cap's own line
    const wide = bizjetSideConsole(cap, 0.7, -1, () => 2).facets.flatMap((f) => [...f.corners]).filter((v) => v.y < 0.3);
    expect(Math.max(...wide.map((v) => -v.z))).toBeCloseTo(0.9, 9);
  });

  it("cover no glass, stand inside the skin, and leave the seats clear", () => {
    const consoles = named("bizjet-side-consoles");
    let met = 0;
    for (let az = -37; az <= -15; az += 1) {
      for (let el = -23; el <= 5; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = kitHit(az, el);
        // the console, or the things standing on it (S5)
        if (!hit || (hit.mesh !== consoles && !/^bizjet-console-/.test(partOf(hit.mesh, hit.faceId)))) continue;
        met += 1;
        expect(exitsThrough(az, el).what, `(${az}, ${el}): the console over glass`).not.toBe("glass");
      }
    }
    expect(met, "rays meeting the console").toBeGreaterThan(50);
    // inside the skin: at least the cap's width less the lining's depth from it (the console stands against the wall, its
    // outboard side following the shell down from the cap)
    let tightest = Number.POSITIVE_INFINITY;
    const own = sourceVertices("bizjet-side-consoles", /^bizjet-side-console-/);
    for (const v of own) {
      const wall = crossings(new Vector3(v.x, v.y, 0), new Vector3(0, 0, v.z < 0 ? -1 : 1), shell).at(-1);
      if (wall === undefined) continue;
      tightest = Math.min(tightest, wall - Math.abs(v.z));
    }
    console.info(`the Global's side consoles: ${met} rays meet them; the tightest clearance from the skin ${tightest.toFixed(4)} m`);
    expect(tightest).toBeGreaterThanOrEqual(0.04);
    // the seat's base stands inboard of the console's face, and its back aft of the console's end
    const seat = globalSeatPlacement();
    const faceZ = Math.min(...own.filter((v) => v.z < 0).map((v) => -v.z).filter((z) => z > 0));
    expect(faceZ - (seat.z + seat.base.width / 2), "the seat's base inboard of the console").toBeGreaterThan(0.01);
    expect(Math.min(...own.map((v) => v.x)), "the console's aft end").toBeGreaterThanOrEqual(BIZJET_SIDE_CONSOLE.aftX);
  });
});

describe("S5: the console's rolled edge and its two things, and the standby on the centre board", () => {
  it("rolls the console's top into its face with no crease: down the top, the round and the face, under 15 degrees a pixel", () => {
    // S4's console: a 90 degree edge into a 20 mm lip and a 45 degree cove twice under it, 469 px of creases at 1600. The
    // 10 mm round turns its 90 degrees over about 8 pixels from the seat: 11.8 a pixel at the most, measured
    let steps = 0;
    let worst = 0;
    for (let az = -35; az <= -25; az += 2) {
      let previous: { point: Vector3; normal: Vector3 } | null = null;
      for (let el = -17; el >= -23; el -= PIXEL_1080P) {
        if (!inFrame(az, el)) break;
        const hit = kitHit(az, el);
        const seen = shadedAt(az, el);
        if (!hit || !seen || partOf(hit.mesh, hit.faceId) !== "bizjet-side-console-port") {
          previous = null;
          continue;
        }
        if (previous && Vector3.Distance(previous.point, seen.point) < 0.005) {
          steps += 1;
          worst = Math.max(worst, Math.acos(Math.min(1, Vector3.Dot(previous.normal, seen.normal))) * DEG);
        }
        previous = { point: seen.point, normal: seen.normal };
      }
    }
    console.info(`the Global's port console, top to face: ${steps} pixel steps, the shading turns ${worst.toFixed(1)} degrees a step at the most`);
    expect(steps).toBeGreaterThan(100);
    expect(worst).toBeLessThan(15);
  });

  it("stands the board's end in front of the console's face with a step, not against it in a corner", () => {
    // across the board's outboard end at the height of the console's face: the last ray on the board and the first on the
    // console meet surfaces at least 4 mm apart (the gap), where S4's lip met the board's face in a 90 degree corner
    const deck = deckHalfWidth();
    let crossings = 0;
    for (const el of [-20.5, -21.5, -22.5]) {
      let last: { part: string; point: Vector3 } | null = null;
      for (let az = -21.5; az >= -25; az -= 0.02) {
        const hit = kitHit(az, el);
        if (!hit) continue;
        const here = { part: partOf(hit.mesh, hit.faceId), point: EYE_POINT.add(direction(az, el).scale(hit.distance)) };
        if (last?.part === "bizjet-instrument-panel" && here.part === "bizjet-side-console-port") {
          crossings += 1;
          expect(Vector3.Distance(last.point, here.point), `at el ${el}`).toBeGreaterThan(0.004);
          expect(Math.abs(here.point.z), `at el ${el}: the console's face`).toBeCloseTo(deck + BIZJET_SIDE_CONSOLE.gap, 3);
        }
        last = here;
      }
    }
    expect(crossings, "the board's end seen against the console at each height").toBe(3);
  });

  it("puts two things and no more on the port console's top, in the frame, standing on it, every edge rounded 3 mm or more", () => {
    const items = BIZJET_CONSOLE_ITEMS;
    expect(items.edge).toBeGreaterThanOrEqual(0.003);
    expect(items.knob.edge).toBeGreaterThanOrEqual(0.003);
    const parts: Record<string, [string, RegExp]> = {
      block: ["bizjet-screen-bezels", /^bizjet-console-block-port$/],
      rockers: ["bizjet-screen-bezel-rims", /^bizjet-console-rocker-port-/],
      tiller: ["bizjet-window-seals", /^bizjet-console-tiller-port$/],
    };
    const seen = new Map<string, number>();
    for (let az = -37; az <= -20; az += 0.25) {
      for (let el = -23; el <= -14; el += 0.25) {
        if (!inFrame(az, el)) continue;
        const hit = kitHit(az, el);
        if (!hit) continue;
        const part = partOf(hit.mesh, hit.faceId);
        for (const [what, [, pattern]] of Object.entries(parts)) if (pattern.test(part)) seen.set(what, (seen.get(what) ?? 0) + 1);
      }
    }
    console.info(`the port console's top from the seat, rays at 0.25 degrees: ${[...seen].map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const what of Object.keys(parts)) expect(seen.get(what) ?? 0, `${what} in the frame`).toBeGreaterThan(3);
    // standing on the top: straight down from 5 mm over the block's and the tiller's lowest points, the console's top
    // within 7 mm (its foot sits on the top, or a millimetre into it)
    const consoles = named("bizjet-side-consoles");
    for (const [what, [mesh, pattern]] of Object.entries(parts)) {
      if (what === "rockers") continue;
      const foot = sourceVertices(mesh, pattern).reduce((low, v) => (v.y < low.y ? v : low));
      const down = scene.multiPickWithRay(new Ray(foot.add(new Vector3(0, 0.005, 0)), new Vector3(0, -1, 0), 0.05), (m) => m === consoles) ?? [];
      const nearest = Math.min(...down.filter((h) => h.hit).map((h) => h.distance));
      expect(nearest, `${what} on the console's top`).toBeLessThan(0.007);
    }
    // nothing else on the consoles' tops: the items are these five (and the starboard console's mirror)
    const names = [...merges.values()].flat().map((m) => m.name).filter((n) => /^bizjet-console-/.test(n));
    expect(names.sort()).toEqual(["bizjet-console-block-port", "bizjet-console-block-starboard", "bizjet-console-rocker-port-0", "bizjet-console-rocker-port-1", "bizjet-console-rocker-starboard-0", "bizjet-console-rocker-starboard-1", "bizjet-console-tiller-port", "bizjet-console-tiller-starboard"]);
  });

  it("builds the block, its rockers and the tiller closed: from outside a ray meets a face the GPU draws, from inside only culled ones", () => {
    // `roundedBox` and `roundedCylinder` are single sheets closed on themselves; the drawn-faces test caught a box whose
    // ring of longitude did not close (one side face missing), so it is held here directly, per part
    const directions = [-1, 0, 1].flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => new Vector3(x, y, z)))).filter((d) => d.length() > 0).map((d) => d.normalize());
    for (const [mesh, pattern] of [
      ["bizjet-screen-bezels", /^bizjet-console-block-port$/],
      ["bizjet-screen-bezel-rims", /^bizjet-console-rocker-port-0$/],
      ["bizjet-window-seals", /^bizjet-console-tiller-port$/],
    ] as const) {
      const vertices = sourceVertices(mesh, pattern);
      const centre = vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);
      const target = named(mesh);
      const nearestIsDrawn = (origin: Vector3, d: Vector3) => {
        const all = (scene.multiPickWithRay(new Ray(origin, d, 1), (m) => m === target) ?? []).filter((h) => h.hit).sort((a, b) => a.distance - b.distance);
        const drawn = (scene.multiPickWithRay(new Ray(origin, d, 1), (m) => m === target, frontFacing(cullSign)) ?? []).filter((h) => h.hit);
        return { hit: all.length > 0, drawn: drawn.some((h) => Math.abs(h.distance - all[0]!.distance) < 1e-7) };
      };
      for (const d of directions) {
        const inside = nearestIsDrawn(centre, d);
        expect(inside.hit, `${pattern}: from its middle along ${d.toString()}`).toBe(true);
        expect(inside.drawn, `${pattern}: from its middle, a culled face first`).toBe(false);
        const outside = nearestIsDrawn(centre.subtract(d.scale(0.2)), d);
        expect(outside.drawn, `${pattern}: from outside along ${d.toString()}, a drawn face first`).toBe(true);
      }
    }
  });

  it("hangs the standby on the centre board at two thirds a pair screen, its frame's top on the pair's line, and bares no more than 2.08% of the frame there", () => {
    const face = bizjetPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    const standby = sourceVertices("bizjet-screens", /^bizjet-screen-standby$/);
    const pair = sourceVertices("bizjet-screens", /^bizjet-screen-port-inboard$/);
    const extent = (vs: Vector3[]) => ({
      across: Math.max(...vs.map((v) => v.z)) - Math.min(...vs.map((v) => v.z)),
      up: Math.max(...vs.map((v) => Vector3.Dot(v, up))) - Math.min(...vs.map((v) => Vector3.Dot(v, up))),
      top: Math.max(...vs.map((v) => Vector3.Dot(v, up))),
    });
    const [a, b] = [extent(standby), extent(pair)];
    expect(a.across / b.across, "two thirds as wide").toBeCloseTo(2 / 3, 3);
    expect(a.up / b.up, "two thirds as tall").toBeCloseTo(2 / 3, 2);
    expect(a.top, "its top on the pair's line").toBeCloseTo(b.top, 6);
    // its frame's top as the pair's: the same top border under the cove's fillet
    const frames = (which: RegExp) => Math.max(...sourceVertices("bizjet-screen-bezel-rims", which).map((v) => Vector3.Dot(v, up)));
    expect(frames(/^bizjet-screen-bezel-rim-standby$/)).toBeCloseTo(frames(/^bizjet-screen-bezel-rim-port-inboard$/), 6);
    // THE BARE CENTRE BOARD: of a 1920 x 1080 frame at every 4th pixel, the rays meeting the board at azimuth +20 or more
    // (P0: 5.8% of the frame; S4: 5.49%)
    const W = 1920;
    const H = 1080;
    const focal = W / 2 / FRAME_U;
    let board = 0;
    for (let y = 540; y < H; y += 4) {
      for (let x = 960; x < W; x += 4) {
        const d = new Vector3(focal, H / 2 - (y + 0.5), x + 0.5 - W / 2);
        if (Math.atan2(d.z, d.x) * DEG < 20) continue;
        const hit = firstHitAlong(d.normalize());
        if (hit && partOf(hit.mesh, hit.faceId) === "bizjet-instrument-panel") board += 16;
      }
    }
    const share = board / (W * H);
    console.info(`the Global's bare centre board: ${(share * 100).toFixed(2)}% of the frame`);
    expect(share).toBeLessThanOrEqual(0.0208);
    expect(share, "non-vacuity: some board is left either side of the standby").toBeGreaterThan(0.005);
  });
});

describe("the Global's cockpit-only parts outside cockpit view", () => {
  it("are invisible at rest and after exit, visible only inside, and never shadow casters", () => {
    const local = new NullEngine();
    const localScene = new Scene(local);
    localScene.useRightHandedSystem = true;
    const localCamera = new UniversalCamera("exterior-camera", Vector3.Zero(), localScene);
    localScene.activeCamera = localCamera;
    const visual = createWebGpuAircraft(localScene, "bizjet");
    const parts = visual.cockpitOnlyParts ?? [];
    expect(parts.length).toBe(9);
    const exteriorMask = localCamera.layerMask;
    for (const part of parts) {
      expect(part.isVisible, `${part.name} at rest`).toBe(false);
      expect(part.metadata?.castsShadow, `${part.name} caster flag`).toBe(false);
    }
    const casters = new Set(visual.meshes.filter((mesh) => mesh.metadata?.castsShadow !== false));
    for (const part of parts) expect(casters.has(part), `${part.name} is a caster`).toBe(false);
    visual.setCockpitView(true);
    for (const part of parts) expect(part.isVisible, `${part.name} in cockpit view`).toBe(true);
    visual.setCockpitView(false);
    for (const part of parts) expect(part.isVisible, `${part.name} after exit`).toBe(false);
    expect(localCamera.layerMask).toBe(exteriorMask);
    visual.dispose();
    localScene.dispose();
    local.dispose();
  });
});
