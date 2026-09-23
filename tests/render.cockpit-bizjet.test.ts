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
  BIZJET_GLARESHIELD,
  BIZJET_LINING,
  BIZJET_PANEL,
  BIZJET_SCREENS,
  BIZJET_SIDE_CONSOLE,
  BIZJET_SILL_CAP,
  bizjetGlareshieldSection,
  bizjetLipY,
  bizjetLiningMeshName,
  bizjetLiningStrips,
  bizjetPanelFace,
  bizjetPanelFaceX,
  bizjetScreenPlacements,
  bizjetSideConsoleFacets,
  bizjetSillCapMeshName,
  highestClearLip,
} from "../src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
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
/** Which authored part of a merged mesh a picked triangle belongs to (an unmerged mesh is its own part). */
function partOf(mesh: AbstractMesh, faceId: number): string {
  const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
  if (!sources) return mesh.name;
  // the board, the screens and the wells are boxes; a bezel's frame and its rim are 16 quads each (`bizjetBezelFacets`); the
  // lining's strips are the captured panels
  const count = (name: string) => {
    if (/^bizjet-side-console-/.test(name)) return named("bizjet-side-consoles").getTotalIndices() / 3 / 2; // the two sides are mirror images
    return /^bizjet-screen-bezel-/.test(name) ? 32 : /^bizjet-(instrument-panel|screen)/.test(name) ? 12 : panel(name).triangles;
  };
  let start = 0;
  for (const name of sources) {
    if (faceId < start + count(name)) return name;
    start += count(name);
  }
  throw new Error(`face ${faceId} is beyond ${mesh.name}`);
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
 * THE SILLS' TOP RIMS over the glass: where the pilot sees the glass begin. A rim runs from the lining's inner face
 * (BIZJET_LINING.depth in) to its outer (.proud out), and the edge the eye reads is whichever is higher; sampled along
 * the chords the strip table marks as glass, on every sill built.
 */
function sillRims(per = 20): Vector3[] {
  const out: Vector3[] = [];
  const slope = (p: Vector3) => (p.y - EYE.up) / (p.x - EYE.forward);
  for (const strip of bizjetLiningStrips().filter((s) => s.name.startsWith("sill-"))) {
    for (const side of strip.centre ? [-1 as const] : [-1 as const, 1 as const]) {
      const p = panel(bizjetLiningMeshName(strip, side));
      const top = p.rows - 1;
      for (const k of strip.glassChords) {
        for (let s = 0; s <= per; s += 1) {
          const outer = Vector3.Lerp(gridVertex(p, 0, top, k), gridVertex(p, 0, top, k + 1), s / per);
          const inner = Vector3.Lerp(gridVertex(p, 1, top, k), gridVertex(p, 1, top, k + 1), s / per);
          out.push(slope(outer) >= slope(inner) ? outer : inner);
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
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "bizjet");
  spy.mockRestore();
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
  it("are seven static meshes: the glareshield, the board and the window frame as one, the screens, their frames, rims and wells, the side consoles", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual(["bizjet-cockpit-interior", "bizjet-glareshield", "bizjet-screen-bezel-rims", "bizjet-screen-bezels", "bizjet-screen-wells", "bizjet-screens", "bizjet-side-consoles"]);
    // the interior is the board, every lining strip the strip table names (a side each or once across the centreline),
    // and the two side sills' caps a side
    expect((named("bizjet-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom).toEqual(["bizjet-instrument-panel", ...frameStripNames()]);
    // the glareshield alone on its mesh, one solidPlate: the aft face's foot, the cove's, the hood's forward end (two
    // corners), and the round's chords with a vertex on the deck line's tangent (two fanned caps, and each side of the
    // outline a wall of two)
    expect((named("bizjet-glareshield").metadata as { mergedFrom?: string[] } | null)?.mergedFrom).toBeUndefined();
    const sides = bizjetGlareshieldSection().outline.length;
    expect(sides).toBe(4 + BIZJET_GLARESHIELD.roundSegments + 2);
    expect(named("bizjet-glareshield").getTotalIndices() / 3).toBe(2 * (sides - 2) + 2 * sides);
    for (const name of ["bizjet-screens", "bizjet-screen-bezels", "bizjet-screen-bezel-rims", "bizjet-screen-wells"]) {
      expect(named(name).metadata?.mergedFrom, name).toHaveLength(4);
    }
    // a bezel's frame and its rim are closed solids of 16 quads each (a front, an outer wall, a back and an inner wall a side)
    expect(named("bizjet-screen-bezels").getTotalIndices() / 3).toBe(4 * 16 * 2);
    expect(named("bizjet-screen-bezel-rims").getTotalIndices() / 3).toBe(4 * 16 * 2);
    // the interior's triangles are its sources', so `partOf` can name any of them
    const interior = named("bizjet-cockpit-interior");
    const sources = (interior.metadata as { mergedFrom: string[] }).mergedFrom;
    expect(sources.reduce((sum, name) => sum + (name === "bizjet-instrument-panel" ? 12 : panel(name).triangles), 0)).toBe(interior.getTotalIndices() / 3);
  });

  it("put the lip on the glareshield's own matte near-black, the frame on the interior, the bezels on their own, the rims on the glowing marking", () => {
    const lip = named("bizjet-glareshield").material as PBRMaterial;
    const interior = named("bizjet-cockpit-interior").material as PBRMaterial;
    expect(lip).not.toBe(interior);
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
    // THE RIMS carry the night glow: the shared marking material, which `applyGlow` drives
    const rim = named("bizjet-screen-bezel-rims").material as PBRMaterial;
    expect(rim).toBe(scene.getMaterialByName("bizjet-instrument-marking"));
    expect(rim.emissiveIntensity).toBeGreaterThan(0.15);
    expect(rim.emissiveIntensity).toBeLessThan(0.2);
    for (const channel of [rim.albedoColor.r, rim.albedoColor.g, rim.albedoColor.b]) expect(channel).toBeLessThan(0.25);
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
        if (part === null || (!underLip && !c.frame.test(part))) missing.push(`${c.pane} ${c.edge} at (${az.toFixed(1)}, ${el.toFixed(1)}): ${part ?? "nothing"}`);
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
        else glassCovered.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) by ${part}`);
      }
    }
    console.info(`the Global's frame from the eye: ${open} rays open, ${solid} on the kit, ${reveal} of them the frame's reveal over glass`);
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
        expect(partOf(hit!.mesh, hit!.faceId), `azimuth ${az}, elevation ${e.toFixed(2)}`).toMatch(/crown/);
      }
      for (let e = run.from - 0.5; e > lipElevation(az) + 0.05; e -= 0.25) {
        const hit = kitHit(az, e);
        expect(hit, `the sill at azimuth ${az}, elevation ${e.toFixed(2)}`).not.toBeNull();
        expect(partOf(hit!.mesh, hit!.faceId), `azimuth ${az}, elevation ${e.toFixed(2)}`).toMatch(/sill/);
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
    // is concave the chord can carry it out, but never beyond the lining's own proud
    expect(tightestFace).toBeGreaterThan(-BIZJET_LINING.proud);
    expect(shadedAway, "lining vertices shaded away from the eye").toBe(0);
  });

  it("caps the side panes' sills: under each side pane's bottom edge the eye meets the cap's top face, lit toward the cabin", () => {
    // The wall under the forward side pane is about 11 degrees of flat lining from the seat (K2); the cap is a ledge along
    // the pane's bottom edge, level with it and BIZJET_SILL_CAP.width inboard. Its row 0 IS its sill's top row on the
    // lining's inner face (the no-T-junction test holds the seam), and from the eye above, its inboard edge reads lower
    // than the pane's edge, so it covers no glass.
    const interior = named("bizjet-cockpit-interior");
    const normals = interior.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = interior.getIndices()!;
    let seen = 0;
    let hidden = 0;
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
        const lipHalfWidth = Math.max(...worldVertices(named("bizjet-glareshield")).map((v) => Math.abs(v.z)));
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
          expect(hit?.mesh, `${cap.name} at (${az.toFixed(1)}, ${el.toFixed(1)})`).toBe(interior);
          expect(partOf(hit!.mesh, hit!.faceId), `${cap.name} at (${az.toFixed(1)}, ${el.toFixed(1)})`).toBe(cap.name);
          // on its TOP face, not its rim: one of the top face's own triangles is crossed where the ray met the mesh
          expect(crossings(EYE_POINT, d, faceTriangles(cap, 1)).some((t) => Math.abs(t - hit!.distance) < 1e-4), `${cap.name}: on its top face`).toBe(true);
          for (let k = 0; k < 3; k += 1) expect(Vector3.Dot(Vector3.FromArray(normals, indices[hit!.faceId * 3 + k]! * 3), d), `${cap.name}: lit toward the cabin`).toBeLessThan(0);
          seen += 1;
        }
      }
    }
    console.info(`the Global's sill caps: ${seen} cells of the port forward side pane's cap in the frame, each met on its top face; ${hidden} under the deck`);
    expect(seen, "the forward side pane's cap is in the frame from the seat").toBeGreaterThan(1);
  });

  it("reads THIN: the windshield/side pillar is nearly all face from the seat, its side faces a sliver (the 2 cm frame)", () => {
    // K3's lesson on the 747: the frame's depth shows as a second, lit face down the side of every pillar, and at the
    // glass's own 0.10 m it was half the pillar. Measured across the port pillar in 0.01 degree steps, each ray's first
    // drawn triangle classed by where `skinPanel` wrote it: two outer and two inner triangles a grid cell, then the rims.
    const interior = named("bizjet-cockpit-interior");
    const sources = (interior.metadata as { mergedFrom: string[] }).mergedFrom;
    const strip = "port-bizjet-lining-pillar";
    let start = 0;
    for (const name of sources) {
      if (name === strip) break;
      start += name === "bizjet-instrument-panel" ? 12 : panel(name).triangles;
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
    const halfWidth = Math.max(...lipVertices.map((v) => Math.abs(v.z)));
    const recorded = aircraftSpec("bizjet").cockpitDeckLineDegrees;
    // the lip as built is the catalogue's line: the glareshield's silhouette is its steepest-up vertex from the eye (a
    // line along z reads one row, its slope along x), and that is the round's tangent, on the line to the bit
    const rowSlope = (v: { x: number; y: number }) => (v.y - EYE.up) / (v.x - EYE.forward);
    expect(Math.max(...lipVertices.map(rowSlope)), "the silhouette on the catalogue's line").toBeCloseTo(-Math.tan(recorded / DEG), 12);
    expect(rowSlope(bizjetGlareshieldSection().tangent)).toBeCloseTo(-Math.tan(recorded / DEG), 12);
    expect(Math.min(...lipVertices.map((v) => v.x)), "its aft face at the deck's own plane").toBeCloseTo(bizjetPanelFaceX(), 6);
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
    const lip = worldVertices(named("bizjet-glareshield"));
    const halfWidth = Math.max(...lip.map((v) => Math.abs(v.z)));
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
    const lip = worldVertices(named("bizjet-glareshield"));
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
      expect(section.outline.slice(-round.length), "the round closes the outline").toEqual(round);
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
    expect(radius, "the round's radius, 0.010 to 0.015").toBeGreaterThanOrEqual(0.01 - 1e-12);
    expect(radius).toBeLessThanOrEqual(0.015 + 1e-12);
    expect(section.centre.y - section.coveTop.y, "the aft face's drop under the round, at most 0.010").toBeLessThanOrEqual(0.01 + 1e-12);
    expect(section.coveTop.x - section.faceTop.x, "the cove at 45 degrees").toBeCloseTo(section.faceTop.y - section.coveTop.y, 12);
    expect(Math.max(...section.outline.map((v) => v.x)) - bizjetPanelFaceX(), "the hood's depth").toBeCloseTo(0.18, 12);
    expect(BIZJET_GLARESHIELD.hoodFallDegrees, "the hood's fall").toBeGreaterThanOrEqual(12);
    expect(BIZJET_PANEL.leanDegrees, "the panel's lean").toBe(15);
    expect(BIZJET_SCREENS.belowDeckEdgeDegrees, "the gap under the deck's edge, 0.8 to 1.0").toBeGreaterThanOrEqual(0.8);
    expect(BIZJET_SCREENS.belowDeckEdgeDegrees).toBeLessThanOrEqual(1.0);
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
    // flat-shaded (three vertices a triangle): the faces by their built normals
    const cove: Vector3[] = [];
    const aft: Vector3[] = [];
    let coveNormal: Vector3 | null = null;
    for (let i = 0; i < vertices.length; i += 1) {
      const n = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      if (Math.abs(n.x + Math.SQRT1_2) < 1e-6 && Math.abs(n.y + Math.SQRT1_2) < 1e-6) {
        cove.push(vertices[i]!);
        coveNormal = n;
      }
      if (n.x < -0.999999) aft.push(vertices[i]!);
    }
    expect(cove.length, "the cove's vertices: a quad, two triangles").toBe(6);
    // (vertex data is float32: a micrometre at these stations)
    expect(Math.min(...cove.map((v) => v.x))).toBeCloseTo(bizjetPanelFaceX(), 5);
    expect(Math.max(...cove.map((v) => v.x)) - bizjetPanelFaceX(), "the cove's run").toBeCloseTo(g.cove, 5);
    expect(Math.max(...cove.map((v) => v.y)) - Math.min(...cove.map((v) => v.y)), "the cove's fall").toBeCloseTo(g.cove, 5);
    // the pilot SEES it: its normal has a component toward the eye at every one of its corners (a flat underside's did not)
    for (const v of cove) expect(Vector3.Dot(coveNormal!, EYE_POINT.subtract(v)), "the cove faces the eye").toBeGreaterThan(0);
    // the aft face: vertical, from the cove's top up to the round's aft tangent, `drop` tall
    for (const v of aft) expect(v.x).toBeCloseTo(bizjetPanelFaceX(), 5);
    expect(Math.max(...aft.map((v) => v.y)) - Math.min(...aft.map((v) => v.y)), "the drop under the round").toBeCloseTo(g.drop, 5);
    // the panel's face begins at the cove's foot: the board's top edge, no gap
    const board = worldVertices(named("bizjet-cockpit-interior")).slice(0, 24);
    expect(Math.max(...board.map((v) => v.y)), "the board's top at the cove's foot").toBeCloseTo(section.faceTop.y, 5);
    const top = board.filter((v) => Math.abs(v.y - section.faceTop.y) < 1e-5);
    expect(Math.min(...top.map((v) => v.x)) - bizjetPanelFaceX(), "the cove's run to the face").toBeCloseTo(g.cove, 5);
    // and by ray: straight ahead, just under the deck's edge the eye meets the cove, just under that the board
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    const coveMiddle = (el(section.coveTop) + el(section.faceTop)) / 2;
    const hit = kitHit(0, coveMiddle);
    expect(hit?.mesh.name, "straight ahead, the cove's middle").toBe("bizjet-glareshield");
    const at = EYE_POINT.add(direction(0, coveMiddle).scale(hit!.distance));
    expect(at.x - bizjetPanelFaceX(), "and the hit is on the cove").toBeGreaterThan(0.0005);
    expect(firstPart(0, el(section.faceTop) - 0.3), "under the cove's foot").toBe("bizjet-instrument-panel");
  });

  it("shows nothing of the glareshield or the board over the lip: the lip is the edge the pilot reads", () => {
    let rays = 0;
    const halfWidth = Math.max(...worldVertices(named("bizjet-glareshield")).map((v) => Math.abs(v.z)));
    for (let az = -35.63; az <= 35; az += 1.5) {
      // only where the lip is: its ends are at the shell's width
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
    const screens = worldVertices(named("bizjet-screens"));
    const bezels = worldVertices(named("bizjet-screen-bezels"));
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
    // THE BEZELS: frames round the screens, their rims round the frames, BEZEL beyond the screen in all; the opening round
    // the screen is the design's gap wider than it
    const GAP = 0.002;
    const rims = worldVertices(named("bizjet-screen-bezel-rims"));
    for (const [k, { faceCentre }] of bizjetScreenPlacements().entries()) {
      const bezel = [...bezels.slice(k * 96, k * 96 + 96), ...rims.slice(k * 96, k * 96 + 96)];
      const across = bezel.map((v) => v.z - faceCentre.z);
      const up = bezel.map((v) => Vector3.Dot(v.subtract(faceCentre), faceUp()));
      expect(Math.max(...across) - Math.min(...across), `bezel ${k}'s width`).toBeCloseTo(WIDTH + 2 * BEZEL, 5);
      expect(Math.max(...up) - Math.min(...up), `bezel ${k}'s height, up the face`).toBeCloseTo(HEIGHT + 2 * BEZEL, 5);
      const opening = across.filter((z) => Math.abs(z) < WIDTH / 2 + GAP + 1e-4);
      expect(Math.max(...opening.map(Math.abs)), `bezel ${k}'s opening, the screen and its gap`).toBeCloseTo(WIDTH / 2 + GAP, 5);
    }
  });

  it("put the screens' top edge the design's gap under the cove's foot, the lowest edge of the deck the pilot sees", () => {
    const foot = bizjetGlareshieldSection().faceTop;
    const edge = Math.atan2(foot.y - EYE.up, foot.x - EYE.forward) * DEG;
    for (const k of [0, 1, 2, 3]) {
      const [, , top] = frontCorners(screenBlock(k));
      // (float32 vertices: a micrometre is 1e-4 degrees here)
      expect(Math.atan2(top.y - EYE.up, top.x - EYE.forward) * DEG, `screen ${k}'s top edge`).toBeCloseTo(edge - BIZJET_SCREENS.belowDeckEdgeDegrees, 3);
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
      const frame = levels(frames.slice(k * 96, k * 96 + 96).map(plane));
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
    for (let i = 0; i < vertices.length; i += 1) {
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
    expect(chamfer, "four chamfer quads a bezel, two triangles each").toBe(4 * 4 * 2 * 3);
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
    expect(Math.min(...worldVertices(named("bizjet-glareshield")).map((v) => v.x))).toBeCloseTo(bizjetPanelFaceX(), 9);
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
      const cap = rows.findIndex((r) => /-bizjet-lining-cap-forward-side$/.test(r.part ?? ""));
      return cap < 0 ? Number.NaN : bareWall(rows.slice(rows.findIndex((r, k) => k > cap && !/-cap-/.test(r.part ?? ""))));
    };
    for (const px of [40, 120, 200, 280, 340]) {
      const rows = column(px);
      const bare = bareWall(rows);
      // CONTROL: without the console the same column shows wall under the cap, down to the frame's bottom
      consoles.isVisible = false;
      let without = Number.NaN;
      try {
        without = underCap(column(px));
      } finally {
        consoles.isVisible = true;
      }
      const withIt = underCap(rows);
      report.push(`px ${px}: ${bare.toFixed(2)} in all (under the cap ${withIt.toFixed(2)}, without the console ${without.toFixed(2)})`);
      expect(without, `px ${px}: wall under the cap for the console to cover`).toBeGreaterThan(0.5);
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

  it("hang a 2 cm lip along the top's inboard edge over a 45 degree cove, the face set back under it, by the built normals", () => {
    const mesh = named("bizjet-side-consoles");
    const vertices = worldVertices(mesh);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const port = (i: number) => vertices[i]!.z < 0;
    const zOf = (i: number, test: (n: Vector3) => boolean) => [...new Set(vertices.map((_, k) => k).filter((k) => port(k) && test(new Vector3(normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!))).map((k) => vertices[k]!.z.toFixed(4)))].map(Number);
    void zOf;
    const facing = (want: Vector3) => vertices.map((_, k) => k).filter((k) => port(k) && Vector3.Dot(new Vector3(normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!), want) > 0.9999);
    const inboard = facing(new Vector3(0, 0, 1));
    const cove = facing(new Vector3(0, -Math.SQRT1_2, Math.SQRT1_2));
    const planes = [...new Set(inboard.map((k) => vertices[k]!.z.toFixed(4)))].map(Number).sort((a, b) => a - b);
    const deck = Math.max(...worldVertices(named("bizjet-glareshield")).map((v) => Math.abs(v.z)));
    expect(planes, "the lip's face flush with the board's end, the face under it 2 cm outboard").toEqual([-(deck + 0.02), -deck].map((z) => Number(z.toFixed(4))));
    expect(cove.length, "the cove's faces").toBeGreaterThan(0);
    for (const k of cove) expect(vertices[k]!.z).toBeGreaterThanOrEqual(-(deck + 0.02) - 1e-4);
    // the lip's face: 2 cm tall, at the board's end
    const lip = inboard.filter((k) => Math.abs(vertices[k]!.z + deck) < 1e-4);
    const lipHeights = new Map<string, number[]>();
    for (const k of lip) {
      const key = vertices[k]!.x.toFixed(4);
      lipHeights.set(key, [...(lipHeights.get(key) ?? []), vertices[k]!.y]);
    }
    for (const [x, ys] of lipHeights) expect(Math.max(...ys) - Math.min(...ys), `the lip at x ${x}`).toBeCloseTo(BIZJET_SIDE_CONSOLE.lip, 5);
  });

  it("follow the shell down from the cap: on a shell narrower below, the outboard bottom edge stays the margin inside it", () => {
    // On this nose the shell at the board's foot is wide enough that the cap's line is already inside it, so the rule is
    // pinned on a shell given to it: a cap line at 0.90 over a shell 0.85 wide at the foot
    const cap = [0, 1, 2, 3].map((k) => ({ x: 12.6 - 0.1 * k, y: 0.35, z: -0.9 }));
    const { facets } = bizjetSideConsoleFacets(cap, 0.7, -1, (_x, y) => (y < 0.3 ? 0.85 : 0.95));
    const low = facets.flatMap((f) => [...f.corners]).filter((v) => v.y < 0.3);
    expect(low.length).toBeGreaterThan(0);
    expect(Math.max(...low.map((v) => -v.z)), "the bottom's outboard edge").toBeCloseTo(0.85 - BIZJET_PANEL.shellMargin, 9);
    // and where the shell is wide the bottom keeps the cap's own line
    const wide = bizjetSideConsoleFacets(cap, 0.7, -1, () => 2).facets.flatMap((f) => [...f.corners]).filter((v) => v.y < 0.3);
    expect(Math.max(...wide.map((v) => -v.z))).toBeCloseTo(0.9, 9);
  });

  it("cover no glass, stand inside the skin, and leave the seats clear", () => {
    const consoles = named("bizjet-side-consoles");
    let met = 0;
    for (let az = -37; az <= -15; az += 1) {
      for (let el = -23; el <= 5; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = kitHit(az, el);
        if (hit?.mesh !== consoles) continue;
        met += 1;
        expect(exitsThrough(az, el).what, `(${az}, ${el}): the console over glass`).not.toBe("glass");
      }
    }
    expect(met, "rays meeting the console").toBeGreaterThan(50);
    // inside the skin: at least the cap's width less the lining's depth from it (the console stands against the wall, its
    // outboard side following the shell down from the cap)
    let tightest = Number.POSITIVE_INFINITY;
    for (const v of worldVertices(consoles)) {
      const wall = crossings(new Vector3(v.x, v.y, 0), new Vector3(0, 0, v.z < 0 ? -1 : 1), shell).at(-1);
      if (wall === undefined) continue;
      tightest = Math.min(tightest, wall - Math.abs(v.z));
    }
    console.info(`the Global's side consoles: ${met} rays meet them; the tightest clearance from the skin ${tightest.toFixed(4)} m`);
    expect(tightest).toBeGreaterThanOrEqual(0.04);
    // the seat's base stands inboard of the console's face, and its back aft of the console's end
    const seat = globalSeatPlacement();
    const faceZ = Math.min(...worldVertices(consoles).filter((v) => v.z < 0).map((v) => -v.z).filter((z) => z > 0));
    expect(faceZ - (seat.z + seat.base.width / 2), "the seat's base inboard of the console").toBeGreaterThan(0.01);
    expect(Math.min(...worldVertices(consoles).map((v) => v.x)), "the console's aft end").toBeGreaterThanOrEqual(BIZJET_SIDE_CONSOLE.aftX);
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
    expect(parts.length).toBe(7);
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
