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
import { crossings, worldTriangles, type Triangle } from "../scripts/rayCrossings.mts";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { PANE_GRID } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { GLOBAL_CENTRE_POST, GLOBAL_FLIGHT_DECK_OUTLINES, GLOBAL_PANE_DEPTH, GLOBAL_PANE_PROUD } from "../src/render/webgpu/aircraft/bizjetGlazing";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import {
  BIZJET_GLARESHIELD,
  bizjetLipThickness,
  BIZJET_LINING,
  BIZJET_PANEL,
  BIZJET_SCREENS,
  bizjetLipY,
  bizjetLiningMeshName,
  bizjetLiningStrips,
  bizjetPanelFaceX,
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
 *  - the whole centre post is in the frame from the seat (its azimuth is wherever the glass puts it);
 *  - `lipTolerance`: the catalogue's deck line is the lip rule's answer, the HIGHEST straight lip over no glass,
 *    to this;
 *  - `displays`: at least this share of each of the pilot's two screens is in the frame.
 */
const TARGETS = {
  opening: 24,
  topEdge: 10,
  lipTolerance: 0.01,
  displays: 0.35,
} as const;

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
function kitHit(azimuth: number, elevation: number): Hit | null {
  const d = direction(azimuth, elevation);
  const hit = firstHitAlong(d);
  return hit && hit.distance < skinExit(d) - 1e-4 ? hit : null;
}
/** Which authored part of a merged mesh a picked triangle belongs to (an unmerged mesh is its own part). */
function partOf(mesh: AbstractMesh, faceId: number): string {
  const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
  if (!sources) return mesh.name;
  // the board, the screens and the bezels are boxes; the lining's strips are the captured panels
  const count = (name: string) => (/^bizjet-(instrument-panel|screen)/.test(name) ? 12 : panel(name).triangles);
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
    // THE POST fills the gap between the windshields: its two columns are the windshields' inboard edges on the skin
    const post = panel("bizjet-windscreen-center-post");
    expect(post.columns).toBe(2);
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
  it("are four static meshes: the lip, the board and the whole window frame as one, the screens and their bezels", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual(["bizjet-cockpit-interior", "bizjet-glareshield", "bizjet-screen-bezels", "bizjet-screens"]);
    // the interior is the board and every lining strip the strip table names, a side each or once across the centreline
    const lining = bizjetLiningStrips().flatMap((strip) => (strip.centre ? [bizjetLiningMeshName(strip, -1)] : [bizjetLiningMeshName(strip, -1), bizjetLiningMeshName(strip, 1)]));
    expect((named("bizjet-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom).toEqual(["bizjet-instrument-panel", ...lining]);
    // the lip alone on the glareshield mesh, a three-sided solidPlate (two caps and three walls of two triangles)
    expect((named("bizjet-glareshield").metadata as { mergedFrom?: string[] } | null)?.mergedFrom).toBeUndefined();
    expect(named("bizjet-glareshield").getTotalIndices() / 3).toBe(8);
    expect(named("bizjet-screens").metadata?.mergedFrom).toHaveLength(4);
    expect(named("bizjet-screen-bezels").metadata?.mergedFrom).toHaveLength(4);
    // the interior's triangles are its sources', so `partOf` can name any of them
    const interior = named("bizjet-cockpit-interior");
    const sources = (interior.metadata as { mergedFrom: string[] }).mergedFrom;
    expect(sources.reduce((sum, name) => sum + (name === "bizjet-instrument-panel" ? 12 : panel(name).triangles), 0)).toBe(interior.getTotalIndices() / 3);
  });

  it("put the lip on the glareshield's own matte near-black, the frame on the interior, the bezels on the glowing marking material", () => {
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
    const bezel = named("bizjet-screen-bezels").material as PBRMaterial;
    expect(bezel).toBe(scene.getMaterialByName("bizjet-instrument-marking"));
    expect(bezel.emissiveIntensity).toBeGreaterThan(0.15);
    expect(bezel.emissiveIntensity).toBeLessThan(0.2);
    for (const channel of [bezel.albedoColor.r, bezel.albedoColor.g, bezel.albedoColor.b]) expect(channel).toBeLessThan(0.25);
    expect(named("bizjet-screens").material).toBe(scene.getMaterialByName("bizjet-instrument-face"));
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
    expect(frame.map((p) => p.name).sort()).toEqual(
      bizjetLiningStrips().flatMap((strip) => (strip.centre ? [bizjetLiningMeshName(strip, -1)] : [bizjetLiningMeshName(strip, -1), bizjetLiningMeshName(strip, 1)])).sort(),
    );
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
      cases.push({ pane: pane("forward-side"), edge: "bottom", out: [0, -1], frame: /sill-forward-side/ });
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

  it("lines the skin from inside: where the pilot sees the lining's face it stands inside the skin, shaded toward the cabin", () => {
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
        tightestFace = Math.min(tightestFace, skinExit(d) - hit!.distance);
        const normals = hit!.mesh.getVerticesData(VertexBuffer.NormalKind)!;
        const indices = hit!.mesh.getIndices()!;
        for (let k = 0; k < 3; k += 1) if (Vector3.Dot(Vector3.FromArray(normals, indices[hit!.faceId * 3 + k]! * 3), d) >= 0) shadedAway += 1;
      }
    }
    console.info(`the Global's lining: ${face} rays on its inner face, the tightest ${tightestFace.toFixed(4)} m inside the skin; ${rim} on its rims`);
    expect(face).toBeGreaterThan(300);
    expect(rim, "the rims are a small part of what shows").toBeLessThan(face / 5);
    expect(tightestFace).toBeGreaterThan(0.005);
    expect(shadedAway, "lining vertices shaded away from the eye").toBe(0);
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

  it("stands the lip at the catalogue's deck line, and that is the rule's answer against the BUILT sills", () => {
    const lipVertices = worldVertices(named("bizjet-glareshield"));
    const halfWidth = Math.max(...lipVertices.map((v) => Math.abs(v.z)));
    const rule = highestClearLip({ x: EYE.forward, y: EYE.up, z: EYE.right }, bizjetPanelFaceX(), sillRims(), halfWidth);
    const recorded = aircraftSpec("bizjet").cockpitDeckLineDegrees;
    const held = azel(new Vector3(rule.held.x, rule.held.y, rule.held.z));
    console.info(`the Global's lip rule: deck line ${(-rule.elevationDegrees).toFixed(3)}, held by the glass at (${held.az.toFixed(1)}, ${held.el.toFixed(2)}); catalogue ${recorded}`);
    // the lip as built is the catalogue's line
    expect(Math.max(...lipVertices.map((v) => v.y))).toBeCloseTo(bizjetLipY(), 6);
    expect(Math.min(...lipVertices.map((v) => v.x)), "flush with the face").toBeCloseTo(bizjetPanelFaceX(), 6);
    expect(Math.atan2(bizjetLipY() - EYE.up, bizjetPanelFaceX() - EYE.forward) * DEG).toBeCloseTo(-recorded, 9);
    // and the catalogue's line is the rule's
    expect(Math.abs(-rule.elevationDegrees - recorded), "the catalogue's deck line against the rule").toBeLessThanOrEqual(TARGETS.lipTolerance);
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
      ["bezels", -1, bezels, WIDTH + 2 * BEZEL, HEIGHT + 2 * BEZEL],
      ["bezels", 1, bezels, WIDTH + 2 * BEZEL, HEIGHT + 2 * BEZEL],
    ] as const) {
      const { first, second, gap } = clustersOf(vertices, (v) => v.z * sign > 0);
      for (const cluster of [first, second]) {
        expect(cluster.length, `${label} ${sign} vertices`).toBe(24);
        expect(Math.max(...cluster.map((v) => v.z)) - Math.min(...cluster.map((v) => v.z)), `${label} width`).toBeCloseTo(width, 4);
        expect(Math.max(...cluster.map((v) => v.y)) - Math.min(...cluster.map((v) => v.y)), `${label} height`).toBeCloseTo(height, 4);
      }
      const all = [...first, ...second];
      const centre = (Math.max(...all.map((v) => v.z)) + Math.min(...all.map((v) => v.z))) / 2;
      expect(centre, `${label} pair centre`).toBeCloseTo(sign < 0 ? EYE.right : -EYE.right, 4);
      expect(gap, `${label} gap between the two`).toBeGreaterThan(0.005);
      expect(gap, `${label} gap between the two`).toBeLessThan(0.06);
    }
  });

  it("put the screens' top edge 1.5 degrees under the lip's underside at the face", () => {
    const top = Math.max(...screenBlock(0).map((v) => v.y));
    const front = Math.min(...screenBlock(0).map((v) => v.x));
    const underside = Math.atan2(bizjetLipY() - bizjetLipThickness() - EYE.up, bizjetPanelFaceX() - EYE.forward) * DEG;
    expect(Math.atan2(top - EYE.up, front - EYE.forward) * DEG).toBeCloseTo(underside - BIZJET_SCREENS.belowLipDegrees, 4);
  });

  it("show at least the target share of each of the pilot's two screens in the 16:9 frame, each at its own azimuth", () => {
    // Over a 21 x 21 grid of each screen's pilot-facing face: inside the frame's own rectangle, and the first thing the
    // cockpit camera draws along the ray is that screen, where the face is.
    const screens = named("bizjet-screens");
    const names = (screens.metadata as { mergedFrom: string[] }).mergedFrom;
    const fractions: Record<string, number> = {};
    for (const [k, name] of names.entries()) {
      const block = screenBlock(k);
      const x = Math.min(...block.map((v) => v.x));
      const [y0, y1] = [Math.min(...block.map((v) => v.y)), Math.max(...block.map((v) => v.y))];
      const [z0, z1] = [Math.min(...block.map((v) => v.z)), Math.max(...block.map((v) => v.z))];
      let seen = 0;
      for (let i = 0; i <= 20; i += 1) {
        for (let j = 0; j <= 20; j += 1) {
          const p = new Vector3(x, y0 + ((y1 - y0) * (i + 0.5)) / 21, z0 + ((z1 - z0) * (j + 0.5)) / 21);
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

  it("stands the panel's face the design's distance ahead of the eye, the lip flush on it, the board down past the frame", () => {
    expect(bizjetPanelFaceX() - EYE.forward).toBeCloseTo(BIZJET_PANEL.faceAheadOfEye, 9);
    const board = worldVertices(named("bizjet-cockpit-interior")).slice(0, 24);
    expect(Math.min(...board.map((v) => v.x))).toBeCloseTo(bizjetPanelFaceX(), 6);
    expect(Math.max(...board.map((v) => v.y))).toBeCloseTo(bizjetLipY() - bizjetLipThickness(), 6);
    // THE WEDGE falls away from the eye: its top slopes down forward more steeply than the sight line over the lip,
    // so its forward corner (and the board's top behind it) stays under that line at any deck line
    const lip = worldVertices(named("bizjet-glareshield"));
    const tall = Math.max(...lip.map((v) => v.y)) - Math.min(...lip.map((v) => v.y));
    const deep = Math.max(...lip.map((v) => v.x)) - Math.min(...lip.map((v) => v.x));
    expect(deep).toBeCloseTo(BIZJET_GLARESHIELD.depth, 6);
    expect(Math.atan2(tall, deep) * DEG, "the wedge's top against the sight line over the lip")
      .toBeGreaterThan(aircraftSpec("bizjet").cockpitDeckLineDegrees + BIZJET_GLARESHIELD.fallBeyondSightDegrees - 1e-3);
    // the frame's bottom crosses the face's plane FRAME_V under the eye per metre ahead; the board runs below it
    expect(Math.min(...board.map((v) => v.y))).toBeLessThan(EYE.up - FRAME_V * BIZJET_PANEL.faceAheadOfEye);
    // and the lining runs past the lip's line: the rows under the glass the lip does not reach are sill all the way
    expect(BIZJET_LINING.bottom).toBeLessThan(-30);
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
    expect(parts.length).toBe(4);
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
