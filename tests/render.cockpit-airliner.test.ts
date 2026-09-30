import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crossings, hitTriangle, worldTriangles, type Triangle } from "../scripts/rayCrossings.mts";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { CENTRE_POST_HALF_AZIMUTH, FLIGHT_DECK_PANES, FLIGHT_DECK_REFERENCE, PANE_DEPTH, PANE_PROUD, SkinCaster } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import {
  AIRLINER_FRAME,
  AIRLINER_BOARD_EDGE,
  AIRLINER_GLARESHIELD,
  AIRLINER_LINING,
  AIRLINER_PANEL,
  AIRLINER_SCREENS,
  AIRLINER_SEAT,
  airlinerFrameProfile,
  airlinerBoardTop,
  airlinerGlareshieldSection,
  airlinerLipY,
  airlinerLiningStrips,
  airlinerPanelFace,
  airlinerPanelFaceX,
  airlinerScreenPlacements,
  airlinerClockPieces,
  airlinerClockPlacement,
  airlinerGlareshieldPanels,
  airlinerDeckPath,
  airlinerWindowFrame,
  AIRLINER_CLOCK,
  AIRLINER_DECK_WRAP,
  AIRLINER_HEADER,
  AIRLINER_OVERHEAD,
  airlinerHeaderStations,
  airlinerOverheadSection,
  type FrameStation,
  type WindowFrame,
} from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import { BEZEL_RIM, GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import { cockpitView, measureDeckLineDegrees } from "./support/cockpitFootprints";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";

/**
 * The 747-8's cockpit, held to the glass it looks through and to the shell it stands in.
 *
 * THE GLASS is the re-lofted nose's: six panes cast by angle from R onto the skin
 * (`airlinerGlazing.ts`, docs/findings/AIRLINER_NOSE_GLAZING.md), and a centre post cast the same
 * way. Every pane number here is read off the BUILT panes, captured as `skinPanel` returns them (the
 * glazing table's own method), and the corner table below is a copy of that table's JSON held to
 * the built mesh to a millimetre, so a re-loft of the nose fails HERE first.
 *
 * THE EYE is (29.85, 2.93, -0.50), chosen on the K0 grid (docs/findings/COCKPIT_VIEW_2026_09_20.md),
 * and everything else is asserted as an angle from it at the 75 degree, 16:9 lens: the lip at
 * -18.57 straight ahead, no more than a degree of sill under No.1 anywhere, the deck line at the
 * catalogue's value, each pane's every edge framed by the kit, every hole in the picture a pane, the
 * top row of screens at least 35% in the frame.
 *
 * Every measurement is a ray or a vertex of the BUILT meshes. `scene.pickWithRay` gives what the
 * cockpit camera draws first (the shell and the glazing excluded by their layer mask, as in the
 * renderer); the triangle counts of the shell are the mesh's own triangles (`scripts/rayCrossings.mts`),
 * because `pickWithRay` returns one hit per mesh, which is the wrong tool for the far side of a shell
 * made of two overlapping closed lofts.
 */

const DEG = 180 / Math.PI;
const EYE = aircraftSpec("airliner").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);
/** The 16:9 frame at the 75 degree horizontal lens, as tangents in the image plane. */
const FRAME_U = Math.tan(37.5 / DEG);
const FRAME_V = FRAME_U / (16 / 9);

/**
 * THE CORNER TABLE, copied from `npx tsx scripts/airliner-glazing-table.mts --json` at 4251e15 (the centre member at
 * +-CENTRE_POST_HALF_AZIMUTH = 1.9; before it, a480804: 
 * re-loft and the crease join): the port panes' outer and inner face corners, body metres. The only
 * source of pane geometry; held to the built panes below.
 */
const PORT_PANE_CORNERS = {
  one: {
    bottomInboard: { outer: [32.596, 2.089, -0.091], inner: [32.518, 2.026, -0.085] },
    bottomOutboard: { outer: [32.073, 2.186, -0.982], inner: [32.014, 2.134, -0.92] },
    topOutboard: { outer: [31.254, 3.274, -0.611], inner: [31.212, 3.192, -0.572] },
    topInboard: { outer: [31.515, 3.303, -0.054], inner: [31.464, 3.217, -0.051] },
  },
  two: {
    bottomInboard: { outer: [31.918, 2.357, -0.998], inner: [31.862, 2.302, -0.936] },
    bottomOutboard: { outer: [31.01, 2.45, -1.539], inner: [30.972, 2.402, -1.46] },
    topOutboard: { outer: [30.643, 3.181, -1.031], inner: [30.617, 3.103, -0.974] },
    topInboard: { outer: [31.28, 3.229, -0.682], inner: [31.238, 3.15, -0.639] },
  },
  three: {
    bottomInboard: { outer: [30.899, 2.577, -1.491], inner: [30.864, 2.523, -1.415] },
    bottomOutboard: { outer: [30.361, 2.583, -1.709], inner: [30.333, 2.528, -1.631] },
    topOutboard: { outer: [30.233, 3.136, -1.232], inner: [30.21, 3.06, -1.171] },
    topInboard: { outer: [30.626, 3.14, -1.084], inner: [30.6, 3.064, -1.025] },
  },
} as const;

interface Panel { name: string; rows: number; columns: number; positions: number[]; triangles: number }

let engine: NullEngine;
let scene: Scene;
let camera: UniversalCamera;
let aircraft: AircraftVisual;
let cockpitOnly: readonly AbstractMesh[];
let shell: Triangle[];
/** The window frame, cast again on the built shell by the kit's own function and held to the built meshes below. */
let frame: WindowFrame;
let skinCaster: SkinCaster;
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
/**
 * A pane's (or the post's) grid point ON THE SKIN: the glass slab stands PANE_PROUD out and PANE_DEPTH in, so the skin
 * is that far between its outer and inner faces. The hole the pane makes in the skin is what the lining frames.
 */
function skinVertex(p: Panel, row: number, column: number): Vector3 {
  return Vector3.Lerp(gridVertex(p, 0, row, column), gridVertex(p, 1, row, column), PANE_PROUD / (PANE_PROUD + PANE_DEPTH));
}
/** One face of a captured skin panel as triangles: what a sightline through it crosses, rims left out. */
function faceTriangles(p: Panel, face: 0 | 1 | "skin"): Triangle[] {
  const out: Triangle[] = [];
  for (let row = 0; row < p.rows - 1; row += 1) {
    for (let column = 0; column < p.columns - 1; column += 1) {
      const v = (r: number, c: number) => (face === "skin" ? skinVertex(p, r, c) : gridVertex(p, face, r, c));
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
    && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
}
/** The first surface the cockpit camera draws along a ray from the eye, with the triangle it met. */
function firstHitAlong(d: Vector3) {
  const hit = scene.pickWithRay(new Ray(EYE_POINT, d, 60), drawnByCockpitCamera);
  return hit?.hit ? hit : null;
}
function firstHit(azimuth: number, elevation: number) {
  return firstHitAlong(direction(azimuth, elevation));
}
/** The board's own share of the interior mesh (it comes first): the mesh less the window frame's. */
function boardTriangles(): number {
  return named("airliner-cockpit-interior").getTotalIndices() / 3 - frame.frame.indices.length / 3;
}
function boardVertices(): number {
  return named("airliner-cockpit-interior").getTotalVertices() - frame.frame.positions.length / 3;
}
/** A triangle's centroid, body metres (the kit's meshes hang from the root at the identity). */
function centroidOf(mesh: AbstractMesh, faceId: number): Vector3 {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = mesh.getIndices()!;
  const corner = (k: number) => {
    const i = indices[faceId * 3 + k]! * 3;
    return new Vector3(positions[i]!, positions[i + 1]!, positions[i + 2]!);
  };
  return corner(0).add(corner(1)).add(corner(2)).scale(1 / 3);
}
/**
 * The frame's REGION a point is in (`airlinerLiningStrips`, by R's angles): the old strip names, a side's prefixed, so
 * "the post", "the sill under No.1" and "No.1 / No.2's pillar" still name what they did when each was a mesh of its own.
 * A return and a seal lie just outside their pane's rectangle, so they are named for the frame they roll out of.
 */
function regionAt(p: Vector3): string {
  const R = FLIGHT_DECK_REFERENCE;
  const [dx, dy, dz] = [p.x - R.x, p.y - R.y, p.z - R.z];
  let az = Math.atan2(Math.abs(dz), dx) * DEG;
  let el = Math.atan2(dy, Math.hypot(dx, dz)) * DEG;
  // a return's or a seal's point stands off the skin along its normal, which R's angles read a little inside the pane: it
  // belongs to the frame across the pane's nearest edge
  const pane = FLIGHT_DECK_PANES.find((q) => az > q.azimuth[0] && az < q.azimuth[1] && el > q.elevation[0] && el < q.elevation[1]);
  if (pane) {
    const [a0, a1] = pane.azimuth;
    const [e0, e1] = pane.elevation;
    const nearest = Math.min(az - a0, a1 - az, el - e0, e1 - el);
    if (nearest > 1) return "airliner-window-frame";
    if (nearest === az - a0) az = a0 - 0.01;
    else if (nearest === a1 - az) az = a1 + 0.01;
    else if (nearest === el - e0) el = e0 - 0.01;
    else el = e1 + 0.01;
  }
  for (const strip of airlinerLiningStrips()) {
    const [a0, a1] = strip.centre ? [0, Math.max(...strip.azimuth.map(Math.abs))] : strip.azimuth;
    if (az < a0 - 0.05 || az > a1 + 0.05 || el < strip.elevation[0] - 0.05 || el > strip.elevation[1] + 0.05) continue;
    return strip.centre ? `airliner-lining-${strip.name}` : `${dz < 0 ? "port" : "starboard"}-airliner-lining-${strip.name}`;
  }
  return "airliner-window-frame";
}
/**
 * Which authored part a picked triangle belongs to (an unmerged mesh is its own part). The kit's merged meshes carry
 * their sources in `mergedFrom`; the boxes' triangle counts are written here, the frame's is its own, and the sum is
 * checked against the mesh. The window frame and its seals are named by REGION (`regionAt`).
 */
function partOf(mesh: AbstractMesh, faceId: number): string {
  if (mesh.name === "airliner-window-seals") return regionAt(centroidOf(mesh, faceId));
  const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
  if (!sources) return mesh.name;
  // the board, the screens and the wells are boxes; a bezel's frame and its rim are 16 quads each (`framedScreenFacets`)
  const clock = airlinerClockPieces();
  const panels = new Map<string, number>(airlinerGlareshieldPanels().flatMap((p) => [[`airliner-glareshield-${p.name}`, p.plate.length * 2], [`airliner-glareshield-${p.name}-windows`, p.windows.reduce((sum, w) => sum + w.quads.length * 2, 0)]] as const));
  const count = (name: string) => (/^airliner-screen-bezel-/.test(name) ? 32 : name === "airliner-instrument-panel" ? boardTriangles() : /^airliner-screen/.test(name) ? 12
    : name === "airliner-window-frame" ? frame.frame.indices.length / 3
      : name === "airliner-clock-bezel" ? clock.frame.indices.length / 3 : name === "airliner-clock-bezel-rim" ? clock.rim.indices.length / 3
        : name === "airliner-clock-well" ? clock.well.indices.length / 3 : panels.get(name) ?? Number.NaN);
  const total = sources.reduce((sum, name) => sum + count(name), 0);
  expect(total, `${mesh.name}: its sources' triangles add up to the mesh's`).toBe(mesh.getTotalIndices() / 3);
  let start = 0;
  for (const name of sources) {
    if (faceId < start + count(name)) return name === "airliner-window-frame" ? regionAt(centroidOf(mesh, faceId)) : name;
    start += count(name);
  }
  throw new Error(`face ${faceId} is beyond ${mesh.name}`);
}
/** What of the window frame a picked triangle is: its FACE, the RETURN rolling into an opening, or the SEAL; null if not the frame. */
function layerOf(mesh: AbstractMesh, faceId: number): "face" | "return" | "seal" | null {
  if (mesh.name === "airliner-window-seals") return "seal";
  if (mesh.name !== "airliner-cockpit-interior") return null;
  // the board's triangles first (`mergedFrom`), then the frame's, its face's first
  const k = faceId - boardTriangles();
  if (k < 0) return null;
  return k < frame.faceTriangles ? "face" : "return";
}
/** The first drawn part along a ray: the mesh, and the authored part of it. */
function firstPart(azimuth: number, elevation: number): string | null {
  const hit = firstHit(azimuth, elevation);
  return hit ? partOf(hit.pickedMesh!, hit.faceId) : null;
}
/**
 * What a sightline from the eye leaves the body through: a pane, the post, or skin, by where it crosses the SKIN:
 * through the hole a pane makes in it (the pane's grid at skin level) or not. The lining is a thin slab laid on the
 * skin round each hole (0.008 out, 0.012 in), so the opening the pilot sees is that hole to within its rim. (It was
 * the glass's own 0.10 m slab until K3, and the opening then was a thick window's: crossing both glass faces.)
 */
let holes: { what: "glass" | "post"; skin: Triangle[] }[] = [];
function exitsThrough(azimuth: number, elevation: number): "glass" | "post" | "skin" {
  if (holes.length === 0) {
    holes = panels
      .filter((p) => /flight-deck-window|windscreen-center-post/.test(p.name))
      .map((p) => ({ what: /post/.test(p.name) ? "post" as const : "glass" as const, skin: faceTriangles(p, "skin") }));
    expect(holes, "six panes and the post").toHaveLength(7);
  }
  const d = direction(azimuth, elevation);
  for (const hole of holes) if (crossings(EYE_POINT, d, hole.skin).length > 0) return hole.what;
  return "skin";
}
/**
 * The bottom of the view over port No.1, as the pilot reads it: the sill's return under No.1, which rolls from the
 * frame's face into the opening and out to the rim. At each station along No.1's bottom edge the edge the eye reads is
 * the highest point of the profile (the return's and the seal's); sampled along the chords between the stations.
 */
function viewBottomOverNoOne(per = 20): { az: number; el: number }[] {
  const loop = frame.loops.find((l) => l.name === "port-one")!;
  const e0 = FLIGHT_DECK_PANES[0]!.elevation[0];
  // the bottom edge's stations, laid square to it (not a corner's mitre), outboard to inboard
  const bottom = loop.stations.filter((s) => s.opening.e === e0 && s.at.e < e0 && s.before === s.after);
  expect(bottom.length, "No.1's bottom edge's stations").toBeGreaterThan(3);
  const profile = airlinerFrameProfile();
  const points = [...profile.ret, ...profile.seal];
  const place = (s: FrameStation, q: { u: number; n: number }) => s.point.add(s.offset.scale(q.u)).add(s.normal.scale(q.n));
  const out: { az: number; el: number }[] = [];
  for (let i = 0; i + 1 < bottom.length; i += 1) {
    for (let k = 0; k <= per; k += 1) {
      let best: { az: number; el: number } | null = null;
      for (const q of points) {
        const seen = azel(Vector3.Lerp(place(bottom[i]!, q), place(bottom[i + 1]!, q), k / per));
        if (!best || seen.el > best.el) best = seen;
      }
      out.push(best!);
    }
  }
  return out;
}
/** The lip's top edge as the pilot reads it along an azimuth: a line along z at the face, so its elevation is exact. */
function lipElevation(azimuth: number): number {
  return Math.atan2((airlinerLipY() - EYE.up) * Math.cos(azimuth / DEG), airlinerPanelFaceX() - EYE.forward) * DEG;
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
  aircraft = createWebGpuAircraft(scene, "airliner");
  spy.mockRestore();
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
  const shellMesh = named("airliner-fuselage-shell");
  expect(shellMesh.getWorldMatrix().isIdentity(), "the shell's vertices are body metres").toBe(true);
  shell = worldTriangles(shellMesh);
  skinCaster = new SkinCaster([{
    positions: shellMesh.getVerticesData(VertexBuffer.PositionKind)!,
    indices: shellMesh.getIndices()!,
    normals: shellMesh.getVerticesData(VertexBuffer.NormalKind)!,
  }]);
  frame = airlinerWindowFrame(skinCaster);
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

/**
 * THE K0 READING of an eye against the built glass, on the panes' and the post's OUTER faces (a sightline through a
 * pillar gap that grazes a rim is not glass): at the horizon, the port No.1 pane's widest run of azimuths, the gap
 * outboard of it (the No.1 / No.2 pillar) and the post's run; No.1's opening through the middle of that run; the
 * glass straight ahead.
 */
function readGlass(eye: Vector3) {
  const sets: [string, Triangle[]][] = [
    ["post", faceTriangles(panel("airliner-windscreen-center-post"), 0)],
    ["port-one", faceTriangles(panel("port-airliner-flight-deck-window-one"), 0)],
    ["port-two", faceTriangles(panel("port-airliner-flight-deck-window-two"), 0)],
    ["starboard-one", faceTriangles(panel("starboard-airliner-flight-deck-window-one"), 0)],
  ];
  const nearest = (d: Vector3, triangles: readonly Triangle[]) => {
    let best = Number.POSITIVE_INFINITY;
    for (const t of triangles) {
      const h = hitTriangle(eye, d, t);
      if (Number.isFinite(h) && h > 1e-4 && h < best) best = h;
    }
    return best;
  };
  const runs: { what: string; from: number; to: number }[] = [];
  for (let az = -45; az <= 45.0001; az += 0.1) {
    const d = direction(az, 0);
    let what = "-";
    let best = Number.POSITIVE_INFINITY;
    for (const [name, triangles] of sets) {
      const h = nearest(d, triangles);
      if (h < best) {
        best = h;
        what = name;
      }
    }
    const last = runs.at(-1);
    if (last && last.what === what) last.to = az;
    else runs.push({ what, from: az, to: az });
  }
  const one = runs.filter((r) => r.what === "port-one").sort((a, b) => (b.to - b.from) - (a.to - a.from))[0]!;
  const pillar = runs[runs.indexOf(one) - 1]!;
  const post = runs.find((r) => r.what === "post")!;
  const middle = (one.from + one.to) / 2;
  let opening = 0;
  let run = 0;
  for (let el = -35; el <= 35; el += 0.1) {
    if (Number.isFinite(nearest(direction(middle, el), sets[1]![1]))) {
      run += 0.1;
      opening = Math.max(opening, run);
    } else run = 0;
  }
  const glassAhead = Math.min(...sets.slice(1).map(([, triangles]) => nearest(direction(0, 0), triangles)));
  const third = (one.to - one.from) / 3;
  return { one, pillar, post, opening, glassAhead, aheadInMiddleThird: one.from + third <= 0 && 0 <= one.to - third };
}

describe("the 747's eye", () => {
  it("is the chosen point, 0.50 m to port", () => {
    expect([EYE.forward, EYE.up, EYE.right]).toEqual([29.85, 2.93, -0.5]);
  });

  it("reads the BUILT glass as the K0 targets asked: straight ahead in No.1's middle third, the post at +10..+16, 28 degrees of opening, 1.4 m of glass", () => {
    const glass = readGlass(EYE_POINT);
    console.info(`747 glass from the eye: No.1 ${glass.one.from.toFixed(1)}..${glass.one.to.toFixed(1)}, pillar ${glass.pillar.from.toFixed(1)}..${glass.pillar.to.toFixed(1)}, post ${glass.post.from.toFixed(1)}..${glass.post.to.toFixed(1)}, opening ${glass.opening.toFixed(1)}, glass ${glassAheadText(glass.glassAhead)}`);
    // K0 (on a480804): No.1 -8.8..+11.6, the pillar -10.7..-8.9, the post +13.1..+14.8, the opening 30.4, the glass 1.90.
    // Since the centre member settled at +-1.9 (4251e15): No.1 -8.8..+12.1, the post +12.2..+15.7, the opening 30.3.
    expect(glass.aheadInMiddleThird, "straight ahead in the middle third of No.1").toBe(true);
    expect(glass.one.from).toBeCloseTo(-8.8, 0);
    // (11.6 against the glass the eye was chosen on; 12.1 since the No.1 panes start at CENTRE_POST_HALF_AZIMUTH)
    expect(glass.one.to).toBeCloseTo(12.1, 0);
    expect(glass.pillar.what, "outboard of No.1 at the horizon is the pillar gap").toBe("-");
    expect(glass.pillar.to).toBeLessThan(glass.one.from);
    expect(glass.post.from).toBeGreaterThanOrEqual(10);
    expect(glass.post.to).toBeLessThanOrEqual(16);
    expect(glass.opening).toBeGreaterThanOrEqual(28);
    expect(glass.glassAhead).toBeGreaterThanOrEqual(1.4);
    // the headroom is whatever the crown gives at this x and z: the first skin crossing straight up
    const headroom = crossings(EYE_POINT, new Vector3(0, 1, 0), shell)[0]!;
    expect(headroom).toBeCloseTo(0.615, 2);
  });

  it("is what the OLD eye was not: from (29.9, 2.93, -0.72) straight ahead is outside No.1's middle third (the control)", () => {
    // From there the pilot looked through the outboard edge of their own No.1, the pillar 1.8 to 3.7 degrees left.
    const old = readGlass(new Vector3(29.9, 2.93, -0.72));
    expect(old.aheadInMiddleThird).toBe(false);
    expect(old.pillar.to).toBeGreaterThan(-4);
    expect(old.pillar.to).toBeLessThan(-1);
  });

  it("has the seats around it: the port seat's centre on the eye's z, 0.05 m aft and its top 0.15 m below, symmetric, headrests with them", () => {
    const interior = named("airliner-flight-deck-interior");
    expect((interior.metadata as { mergedFrom: string[] }).mergedFrom).toEqual([
      "airliner-captain-seat", "airliner-captain-headrest", "airliner-first-officer-seat", "airliner-first-officer-headrest",
    ]);
    const block = (k: number) => worldVertices(interior).slice(k * 24, k * 24 + 24);
    const [captainSeat, captainHead, pilotSeat, pilotHead] = [block(0), block(1), block(2), block(3)];
    const mean = (vs: Vector3[], axis: "x" | "y" | "z") => vs.reduce((s, v) => s + v[axis], 0) / vs.length;
    // the pilot's is the PORT seat, which is the mesh NAMED first-officer
    expect(mean(pilotSeat, "z")).toBeCloseTo(EYE.right, 3);
    expect(mean(captainSeat, "z")).toBeCloseTo(-EYE.right, 3);
    expect(mean(pilotSeat, "x"), "seat centre 0.05 m aft of the eye").toBeCloseTo(EYE.forward - 0.05, 3);
    expect(EYE.up - Math.max(...pilotSeat.map((v) => v.y)), "seat top below the eye").toBeCloseTo(0.15, 3);
    for (const axis of ["x", "y"] as const) {
      expect(mean(captainSeat, axis)).toBeCloseTo(mean(pilotSeat, axis), 6);
      expect(mean(captainHead, axis)).toBeCloseTo(mean(pilotHead, axis), 6);
    }
    expect(mean(pilotSeat, "x") - mean(pilotHead, "x")).toBeCloseTo(AIRLINER_SEAT.headrestBehindSeat, 3);
    expect(mean(pilotHead, "y") - mean(pilotSeat, "y")).toBeCloseTo(AIRLINER_SEAT.headrestAboveSeat, 3);
    // the two seats do not meet on the centreline: 0.42 m between them
    expect(Math.min(...captainSeat.map((v) => v.z)) - Math.max(...pilotSeat.map((v) => v.z))).toBeGreaterThan(0.3);
    for (const b of [pilotSeat, pilotHead]) {
      const inside = EYE.forward >= Math.min(...b.map((v) => v.x)) && EYE.forward <= Math.max(...b.map((v) => v.x))
        && EYE.up >= Math.min(...b.map((v) => v.y)) && EYE.up <= Math.max(...b.map((v) => v.y));
      expect(inside, "the eye is inside a seat").toBe(false);
    }
  });
});

function glassAheadText(metres: number): string {
  return `${metres.toFixed(2)} m`;
}

describe("the glass the kit is built against", () => {
  it("is the corner table's, to a millimetre, so a re-loft of the nose fails HERE", () => {
    for (const [pane, corners] of Object.entries(PORT_PANE_CORNERS)) {
      const p = panel(`port-airliner-flight-deck-window-${pane}`);
      const at = (face: 0 | 1, row: number, column: number) => gridVertex(p, face, row, column);
      const last = { row: p.rows - 1, column: p.columns - 1 };
      const where = {
        bottomInboard: [0, 0], bottomOutboard: [0, last.column], topOutboard: [last.row, last.column], topInboard: [last.row, 0],
      } as const;
      for (const [corner, faces] of Object.entries(corners)) {
        const [row, column] = where[corner as keyof typeof where];
        for (const [face, expected] of [[0, faces.outer], [1, faces.inner]] as const) {
          const built = at(face, row, column);
          expect(Vector3.Distance(built, new Vector3(expected[0], expected[1], expected[2])), `port No.${pane} ${corner} ${face === 0 ? "outer" : "inner"}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it("has the centre post over R's +-CENTRE_POST_HALF_AZIMUTH, the lining's post strip's own lines", () => {
    const post = panel("airliner-windscreen-center-post");
    expect(post.columns, "the post is a strip two grid points wide").toBe(2);
    const R = new Vector3(FLIGHT_DECK_REFERENCE.x, FLIGHT_DECK_REFERENCE.y, FLIGHT_DECK_REFERENCE.z);
    for (let row = 0; row < post.rows; row += 1) {
      for (const column of [0, 1]) {
        // the SKIN point is between the faces, 0.04 of the 0.10 in from the outer one
        const skinPoint = Vector3.Lerp(gridVertex(post, 0, row, column), gridVertex(post, 1, row, column), 0.4);
        const d = skinPoint.subtract(R);
        expect(Math.abs(Math.atan2(d.z, d.x) * DEG)).toBeCloseTo(CENTRE_POST_HALF_AZIMUTH, 1);
      }
    }
  });
});

describe("the 747's cockpit parts", () => {
  const SILLS = ["airliner-lining-sill-centre", "port-airliner-lining-sill-two", "starboard-airliner-lining-sill-two", "port-airliner-lining-sill-three", "starboard-airliner-lining-sill-three"];
  // the board, then the window frame: one welded surface where fifteen lining strips were (S1)
  const INTERIOR = ["airliner-instrument-panel", "airliner-window-frame"];

  it("are the ten named cockpit-only meshes, forty authored parts, and nothing else new", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual([
      "airliner-clock", "airliner-cockpit-interior", "airliner-glareshield", "airliner-header", "airliner-overhead-front", "airliner-screen-bezel-rims",
      "airliner-screen-bezels", "airliner-screen-wells", "airliner-screens", "airliner-window-seals",
    ]);
    // the lip alone; the board and the window frame; the seals; six screens; six frames, six rims and six wells (P1b),
    // and the clock's (S4): its face a mesh of its own, its frame, rim and well with the screens'; and the header and the
    // overhead's forward end, a mesh each (S5)
    expect((named("airliner-glareshield").metadata as { mergedFrom?: string[] }).mergedFrom, "the glareshield is the lip, unmerged").toBeUndefined();
    expect((named("airliner-window-seals").metadata as { mergedFrom?: string[] }).mergedFrom, "the seals, one mesh of their own").toBeUndefined();
    expect((named("airliner-header").metadata as { mergedFrom?: string[] }).mergedFrom, "the header, one mesh of its own").toBeUndefined();
    expect((named("airliner-overhead-front").metadata as { mergedFrom?: string[] }).mergedFrom, "the overhead's front, one mesh of its own").toBeUndefined();
    expect((named("airliner-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom).toEqual(INTERIOR);
    expect((named("airliner-screens").metadata as { mergedFrom: string[] }).mergedFrom, "the screens").toHaveLength(6);
    // the frames and the rims carry the glareshield's three panels' plates and windows too (S3), before the clock's
    for (const [name, clockPart, pieces] of [["airliner-screen-bezels", "airliner-clock-bezel", 10], ["airliner-screen-bezel-rims", "airliner-clock-bezel-rim", 10], ["airliner-screen-wells", "airliner-clock-well", 7]] as const) {
      const from = (named(name).metadata as { mergedFrom: string[] }).mergedFrom;
      expect(from, name).toHaveLength(pieces);
      expect(from.at(-1), `${name}: the clock's last`).toBe(clockPart);
    }
    // a screen bezel's frame and its rim are closed solids of 16 quads each (a front, an outer wall, a back and an inner
    // wall a side); the clock's are four bands of its segments round, a quad a segment
    const round = 4 * AIRLINER_CLOCK.segments * 2;
    // a glareshield panel's plate is a box, and so is each of its windows (the MCP three, each EFIS panel one)
    expect(named("airliner-screen-bezels").getTotalIndices() / 3).toBe(6 * 16 * 2 + 3 * 12 + round);
    // the overhead's front is its section swept straight across (`sweptDeck`, two stations): two triangles a side, two caps
    const overheadSides = airlinerOverheadSection().outline.length;
    expect(named("airliner-overhead-front").getTotalIndices() / 3).toBe(2 * overheadSides + 2 * (overheadSides - 2));
    expect(named("airliner-overhead-front").material, "on the frames' own grey").toBe(named("airliner-screen-bezels").material);
    expect(named("airliner-header").material, "on the glareshield's matte").toBe(named("airliner-glareshield").material);
    expect(named("airliner-screen-bezel-rims").getTotalIndices() / 3).toBe(6 * 16 * 2 + 5 * 12 + round);
    const sources = cockpitOnly.flatMap((part) => (part.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [part.name]);
    expect(sources).toHaveLength(1 + 2 + 1 + 1 + 1 + 1 + 6 + 10 + 10 + 7);
    // the old kit's parts are gone: the hood, the dash, the overhead, the pillar plate and the seam post; and the lining's
    // fifteen strips (S1)
    for (const gone of ["airliner-hood", "airliner-dash", "airliner-overhead", "airliner-windscreen-pillar", "airliner-windscreen-post-port", "airliner-lining-post", "port-airliner-lining-pillar-one-two"]) {
      expect(sources, gone).not.toContain(gone);
    }
    for (const part of cockpitOnly) {
      expect((part.metadata as { cockpitOnly?: boolean }).cockpitOnly, part.name).toBe(true);
      expect((part.metadata as { castsShadow?: boolean }).castsShadow, `${part.name} must never cast`).toBe(false);
    }
  });

  it("put the lip alone on the glareshield's own matte material, the window's seals on the same, and the board and the whole window frame, sills included, on the flight deck's interior one", () => {
    const glare = named("airliner-glareshield");
    const interior = named("airliner-cockpit-interior");
    expect(interior.material, "the two draw states differ").not.toBe(glare.material);
    // THE SILLS ARE FRAME: in the interior mesh, on its material, with the crown and the pillars; the glareshield is the
    // rounded deck alone (P1a: its section the cove's foot, the hood's forward end and the round's chords with a vertex on
    // the deck line's tangent), swept along the deck's plan path (S4): a wall of two triangles a side a span, two caps
    const regions = new Set<string>();
    for (let t = boardTriangles(); t < interior.getTotalIndices() / 3; t += 1) regions.add(partOf(interior, t));
    for (const sill of SILLS) expect([...regions], `${sill} is window frame`).toContain(sill);
    // THE SEALS (S1) are the glareshield's matte, the SAME material: a dark line round the glass, and no new draw state
    expect(named("airliner-window-seals").material, "the seals on the deck's own matte").toBe(glare.material);
    const sides = airlinerGlareshieldSection().outline.length;
    // the soffit's and the hood's forward ends, the nose's chords and the deck line's tangent, the under-round's (S3)
    expect(sides).toBe(2 + (AIRLINER_GLARESHIELD.noseSegments + 2) + (AIRLINER_GLARESHIELD.underSegments + 1));
    const stations = airlinerDeckPath().length;
    expect(glare.getTotalIndices() / 3).toBe(2 * sides * (stations - 1) + 2 * (sides - 2));
    expect(glare.getTotalVertices()).toBe(2 * sides * stations + 2 * sides);
    expect((glare.material as PBRMaterial).metallicF0Factor, "the glareshield reflects nothing").toBe(0);
    expect((glare.material as PBRMaterial).environmentIntensity, "the glareshield is lit by the sky").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect((interior.material as PBRMaterial).environmentIntensity, "the interior's material is lit by the sky").toBeGreaterThan(0);
    expect(interior.material, "the airframe's interior material").toBe(named("airliner-flight-deck-interior").material);
  });

  it("put the bezels' frames on their own dark grey, lighter than the board by albedo alone, and the chamfered rims on the glowing marking", () => {
    const interior = named("airliner-cockpit-interior").material as PBRMaterial;
    // THE RIMS carry the night glow: the shared rim (`BEZEL_RIM`, the Global's too), its day emissive faint and its
    // albedo dark, where the old pale marking at 0.7 made a bright box of every bezel
    // (tests/render.cockpit-bezel-rim.test.ts holds the material, its glow law and its day read)
    const rim = named("airliner-screen-bezel-rims").material as PBRMaterial;
    expect(rim).toBe(scene.getMaterialByName("airliner-instrument-marking"));
    expect(rim.emissiveIntensity).toBe(BEZEL_RIM.dayEmissiveIntensity);
    expect(rim.emissiveIntensity).toBeLessThan(0.1);
    for (const channel of [rim.albedoColor.r, rim.albedoColor.g, rim.albedoColor.b]) expect(channel).toBeLessThan(0.15);
    // THE FRAMES are on the 747's own bezel material, dark neutral grey, and emit NOTHING: the glow is the rim's alone
    const bezel = named("airliner-screen-bezels").material as PBRMaterial;
    expect(bezel).toBe(scene.getMaterialByName("airliner-bezel"));
    expect(bezel).not.toBe(rim);
    expect([bezel.emissiveColor.r, bezel.emissiveColor.g, bezel.emissiveColor.b], "the frame emits nothing").toEqual([0, 0, 0]);
    expect([bezel.roughness, bezel.metallic], "the board's finish").toEqual([interior.roughness, interior.metallic]);
    // LIGHTER THAN THE BOARD BY ALBEDO ALONE, in the design's range: with the board's finish and the board's normal, a face
    // takes the board's light, so its luma against the board's is its albedo's luminance against the board's, in linear
    // light, carried back to the frame's sRGB (the live frame is the measurement; this holds the material to the aim)
    const linear = (m: PBRMaterial) => 0.2126 * m.albedoColor.r ** 2.2 + 0.7152 * m.albedoColor.g ** 2.2 + 0.0722 * m.albedoColor.b ** 2.2;
    const ratio = (linear(bezel) / linear(interior)) ** (1 / 2.2);
    console.info(`the 747's bezels against the board, by albedo: ${ratio.toFixed(3)} in luma`);
    expect(ratio).toBeGreaterThanOrEqual(1.3);
    expect(ratio).toBeLessThanOrEqual(1.6);
    // the screens and the wells behind them: the instrument face, dark (the screens take the display where there is a canvas)
    expect(named("airliner-screens").material).toBe(scene.getMaterialByName("airliner-instrument-face"));
    expect(named("airliner-screen-wells").material).toBe(scene.getMaterialByName("airliner-instrument-face"));
  });

  it("replace the old panel, gauges and needles, which are gone", () => {
    for (const gone of ["airliner-instrument-faces", "airliner-instrument-needles"]) {
      expect(scene.getMeshByName(gone), gone).toBeNull();
    }
    for (const mesh of scene.meshes) {
      const from = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [];
      expect(from.filter((name) => /-gauge$|-needle$/.test(name)), `${mesh.name} still carries an old gauge`).toEqual([]);
    }
  });

  it("are invisible outside cockpit view and visible in it", () => {
    const fresh = new NullEngine();
    const freshScene = new Scene(fresh);
    freshScene.useRightHandedSystem = true;
    const visual = createWebGpuAircraft(freshScene, "airliner");
    try {
      const parts = visual.cockpitOnlyParts ?? [];
      expect(parts).toHaveLength(10);
      for (const part of parts) expect(part.isVisible, `${part.name} outside cockpit view`).toBe(false);
      visual.setCockpitView(true);
      for (const part of parts) expect(part.isVisible, `${part.name} in cockpit view`).toBe(true);
    } finally {
      visual.dispose();
      freshScene.dispose();
      fresh.dispose();
    }
  });

  it("hide the shell, the centre post and the GLAZING from the cockpit camera, and nothing else", () => {
    expect([...aircraft.cockpitParts].map((part) => part.name).sort()).toEqual(["airliner-flight-deck-glazing", "airliner-fuselage-shell", "airliner-windscreen-center-post"]);
    for (const mesh of aircraft.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(aircraft.cockpitParts.includes(mesh));
    }
    const glass = named("airliner-flight-deck-glazing").material as PBRMaterial;
    expect(glass.subSurface.isRefractionEnabled, "the glazing's material refracts").toBe(true);
    // the post is the glass's 0.10 m slab; the kit lines its place at the frame's 0.02
    expect(drawnByCockpitCamera(named("airliner-windscreen-center-post")), "the post").toBe(false);
  });
});

describe("the centre post", () => {
  it("is the KIT's lining from the seat: a ray at the post meets the lining's post strip, on a face the GPU draws, shaded toward the eye", () => {
    // The plane engineer's post is the glass's 0.10 m slab; against the 2 cm lining it stood 4.8 cm into the cabin and
    // its top end showed as a lit block (K3's frames). It is hidden from the cockpit camera, and the lining covers its
    // place at the frame's own depth, cast on the same lines, so from the seat it reads as the pillars do.
    const post = panel("airliner-windscreen-center-post");
    const middle = Math.floor(post.rows / 2);
    const target = Vector3.Lerp(skinVertex(post, middle, 0), skinVertex(post, middle, 1), 0.5);
    const d = target.subtract(EYE_POINT).normalize();
    const hit = firstHitAlong(d);
    expect(hit?.pickedMesh?.name).toBe("airliner-cockpit-interior");
    expect(partOf(hit!.pickedMesh!, hit!.faceId)).toBe("airliner-lining-post");
    // about 2.0 m, just short of the skin there: the lining's inner face stands 0.012 in
    expect(hit!.distance).toBeGreaterThan(1.9);
    expect(hit!.distance).toBeLessThan(Vector3.Distance(target, EYE_POINT));
    // the GPU's rule: a drawn face's cross product points INTO the solid, along the ray
    const mesh = hit!.pickedMesh!;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = mesh.getIndices()!;
    const corner = (k: number) => new Vector3(positions[indices[hit!.faceId * 3 + k]! * 3]!, positions[indices[hit!.faceId * 3 + k]! * 3 + 1]!, positions[indices[hit!.faceId * 3 + k]! * 3 + 2]!);
    const cross = Vector3.Cross(corner(1).subtract(corner(0)), corner(2).subtract(corner(0)));
    expect(Vector3.Dot(cross, d), "the nearest face is drawn").toBeGreaterThan(0);
    for (let k = 0; k < 3; k += 1) {
      const n = indices[hit!.faceId * 3 + k]! * 3;
      expect(normals[n]! * d.x + normals[n + 1]! * d.y + normals[n + 2]! * d.z, "shaded toward the eye").toBeLessThan(0);
    }
    // CONTROL: with the kit's interior hidden, the same ray meets nothing the cockpit camera draws (the post is hidden too)
    mesh.isVisible = false;
    try {
      expect(firstHitAlong(d)).toBeNull();
    } finally {
      mesh.isVisible = true;
    }
  });

  it("reads inside the 3.8 degree target from the seat, as it did square (3.67 +- 0.2): its face, its rolled returns and its seals, recorded", () => {
    // The member's width from the eye is the frame's, face to rim: the returns (S1) are carved INSIDE the old square
    // section, so the opening is where it was and the member reads as wide as it did; what changed is the corner.
    const members: string[] = [];
    for (const el of [-8, 0, 4]) {
      const seen = { face: 0, return: 0, seal: 0 };
      for (let az = 10; az <= 20; az += 0.01) {
        const hit = firstHit(az, el);
        if (!hit || partOf(hit.pickedMesh!, hit.faceId) !== "airliner-lining-post") continue;
        seen[layerOf(hit.pickedMesh!, hit.faceId)!] += 0.01;
      }
      const total = seen.face + seen.return + seen.seal;
      members.push(`el ${el}: ${total.toFixed(2)} = face ${seen.face.toFixed(2)} + returns ${seen.return.toFixed(2)} + seals ${seen.seal.toFixed(2)}`);
      expect(total, `the centre member at el ${el}`).toBeLessThanOrEqual(3.8);
      expect(Math.abs(total - 3.67), `the centre member at el ${el}, against its square 3.67`).toBeLessThanOrEqual(0.2);
      expect(seen.face, "the post's face is there").toBeGreaterThan(2);
      expect(seen.return, "and it rolls into the glass").toBeGreaterThan(0);
    }
    console.info(`747 centre member from the eye: ${members.join("; ")}`);
  });
});

describe("what the pilot sees straight ahead", () => {
  it("has the glareshield's lip at -18.57, and no more than a degree of sill under No.1 anywhere along its straight bottom edge", () => {
    const lip = worldVertices(named("airliner-glareshield"));
    // the silhouette is the round's steepest-up vertex from the eye (a line along z reads one row, its slope along x):
    // the tangent, on the deck line to the bit; nothing of the glareshield rises over it, or stands aft of its aft face
    const rowSlope = (v: { x: number; y: number }) => (v.y - EYE.up) / (v.x - EYE.forward);
    expect(Math.max(...lip.map(rowSlope)), "the silhouette on the deck line").toBeCloseTo(Math.tan(AIRLINER_GLARESHIELD.lipElevationDegrees / DEG), 6);
    expect(rowSlope(airlinerGlareshieldSection().tangent)).toBeCloseTo(Math.tan(AIRLINER_GLARESHIELD.lipElevationDegrees / DEG), 12);
    // across the middle, where it is straight (it turns aft to the sides, S4)
    const across = Math.max(...airlinerDeckPath().filter((st) => st.forward.x === 1).map((st) => Math.abs(st.z)));
    expect(Math.min(...lip.filter((v) => Math.abs(v.z) <= across + 1e-9).map((v) => v.x)), "its aft face, over the board's by the overhang").toBeCloseTo(airlinerGlareshieldSection().aftX, 5);
    expect(Math.atan2(airlinerLipY() - EYE.up, airlinerPanelFaceX() - EYE.forward) * DEG).toBeCloseTo(AIRLINER_GLARESHIELD.lipElevationDegrees, 6);
    // the sill: the bottom of the view over No.1 (the sill's return, to its rim) less the lip, along No.1's straight edge
    const sills = viewBottomOverNoOne().map(({ az, el }) => el - lipElevation(az));
    console.info(`747 sill under No.1: ${Math.min(...sills).toFixed(2)}..${Math.max(...sills).toFixed(2)} degrees`);
    expect(Math.max(...sills), "no more than a degree of sill").toBeLessThanOrEqual(1.0);
    // and it is (nearly) the LOWEST such lip: the sill comes within a tenth of the degree at the straight edge's inboard
    // end. It reached 0.99 when that end was No.1's corner; rounded (S2), the straight edge ends 3 degrees further out,
    // where the lip's line reads a little lower, and the corner's round rises from it into the post (recorded here).
    expect(Math.max(...sills)).toBeGreaterThan(0.9);
    const loop = frame.loops.find((l) => l.name === "port-one")!;
    const profile = airlinerFrameProfile();
    const corner = loop.stations.filter((st) => st.opening.e > FLIGHT_DECK_PANES[0]!.elevation[0] + 1e-9 && st.opening.e < FLIGHT_DECK_PANES[0]!.elevation[0] + AIRLINER_FRAME.cornerRadiusDegrees.one! + 1e-9)
      .map((st) => {
        const seen = [...profile.ret, ...profile.seal].map((q) => azel(st.point.add(st.offset.scale(q.u)).add(st.normal.scale(q.n))));
        const top = seen.reduce((a, b) => (b.el > a.el ? b : a));
        return top.el - lipElevation(top.az);
      });
    console.info(`747 No.1's bottom corners, rounded: the frame rises ${Math.min(...corner).toFixed(2)}..${Math.max(...corner).toFixed(2)} degrees over the lip into the post and the pillar`);
  });

  it("shows nothing of the glareshield or the board behind the lip above it: the lip is the edge the pilot reads", () => {
    let rays = 0;
    for (let az = -35.63; az <= 35; az += 1.5) {
      const hit = firstHit(az, lipElevation(az) + 0.05);
      rays += 1;
      if (!hit) continue;
      const part = partOf(hit.pickedMesh!, hit.faceId);
      expect(["airliner-glareshield", "airliner-instrument-panel"], `the lip's own body at azimuth ${az.toFixed(2)}`).not.toContain(part);
      expect(hit.distance, `what shows over the lip at azimuth ${az.toFixed(2)} is far beyond it`).toBeGreaterThan(1.2);
    }
    expect(rays).toBeGreaterThan(40);
    // CONTROL: just under the lip the ray meets the lip
    expect(firstPart(0, lipElevation(0) - 0.05)).toBe("airliner-glareshield");
  });

  it("puts the deck line at the catalogue's value: the lip, one row across the frame, with the grey sill above it up to No.1", () => {
    const recorded = aircraftSpec("airliner").cockpitDeckLineDegrees;
    // THE HUD LAYOUT'S OWN INSTRUMENT: the deck's highest row anywhere across the frame (glareshield, panel, screens
    // and bezels are deck; the window frame is not)
    const view = cockpitView("airliner", 1600, 900);
    let row = Number.NaN;
    try {
      row = measureDeckLineDegrees(view);
    } finally {
      view.dispose();
    }
    // AND STRAIGHT AHEAD, BY RAY: the highest glareshield
    let ahead = Number.NaN;
    for (let e = 0; e >= -30; e -= 0.005) {
      if (firstHit(0, e)?.pickedMesh?.name === "airliner-glareshield") {
        ahead = e;
        break;
      }
    }
    console.info(`747 deck line: the deck's highest row ${row.toFixed(4)} (the HUD's instrument), the glareshield straight ahead ${(-ahead).toFixed(3)} by ray; catalogue ${recorded}`);
    expect(Math.abs(row - recorded), "the instrument and the catalogue").toBeLessThanOrEqual(0.02);
    expect(Math.abs(-ahead - recorded), "the ray and the catalogue").toBeLessThanOrEqual(0.2);
    // ONE ROW: the lip is a line along z, so the highest row anywhere is the lip's row straight ahead
    expect(Math.abs(row + ahead)).toBeLessThan(0.05);
    expect(ahead).toBeCloseTo(AIRLINER_GLARESHIELD.lipElevationDegrees, 1);
    // ABOVE IT, THE SILL: window frame (the interior mesh, and at the glass its seal), from the lip up to the bottom of
    // the view
    const bottom = viewBottomOverNoOne(40);
    const i = bottom.findIndex((q, k) => k > 0 && Math.sign(q.az) !== Math.sign(bottom[k - 1]!.az));
    const glassAhead = bottom[i - 1]!.el + ((bottom[i]!.el - bottom[i - 1]!.el) * (0 - bottom[i - 1]!.az)) / (bottom[i]!.az - bottom[i - 1]!.az);
    expect(glassAhead - ahead, "the band of sill straight ahead, degrees").toBeGreaterThan(0.5);
    let band = 0;
    for (let e = ahead + 0.05; e < glassAhead - 0.05; e += 0.05) {
      const hit = firstHit(0, e);
      expect(hit?.pickedMesh?.name, `the sill at ${e.toFixed(2)}`).toMatch(/^airliner-(cockpit-interior|window-seals)$/);
      expect(partOf(hit!.pickedMesh!, hit!.faceId)).toBe("airliner-lining-sill-centre");
      band += 1;
    }
    expect(band).toBeGreaterThan(8);
    // and just over No.1's bottom edge, the glass: nothing drawn
    expect(firstHit(0, glassAhead + 0.1)).toBeNull();
  });

  it("frames every edge of the glass the pilot sees with the kit: no hidden skin shows beside any pane or the post", () => {
    // 0.3 degrees outside each pane's hole in the skin (its grid at skin level: the lining is a thin slab round it),
    // the cockpit camera draws the frame.
    const cases: { pane: string; edge: "bottom" | "top" | "inboard" | "outboard"; out: [number, number]; frame: RegExp }[] = [];
    for (const side of ["port", "starboard"] as const) {
      const outboard = side === "port" ? -1 : 1;
      for (const pane of ["one", "two"] as const) {
        const name = `${side}-airliner-flight-deck-window-${pane}`;
        cases.push({ pane: name, edge: "bottom", out: [0, -1], frame: /^airliner-glareshield$|sill/ });
        // over No.1 the header sits down on the glass's top edge as the eye sees it (S5); over No.2, the crown
        cases.push({ pane: name, edge: "top", out: [0, 1], frame: pane === "one" ? /^airliner-header$/ : /crown/ });
        cases.push({ pane: name, edge: "inboard", out: [-outboard, 0], frame: pane === "one" ? /lining-post/ : /pillar-one-two/ });
        cases.push({ pane: name, edge: "outboard", out: [outboard, 0], frame: pane === "one" ? /pillar-one-two/ : /pillar-two-three/ });
      }
    }
    let framed = 0;
    for (const c of cases) {
      const points = edgePoints(panel(c.pane), "skin", c.edge, 3);
      // an edge's first and last grid segment end in a corner, where the frame part of the NEXT edge is the neighbour
      const kept = points.slice(3, -4);
      for (const p of kept) {
        const { az, el } = azel(p);
        const outside = [az + c.out[0] * 0.3, el + c.out[1] * 0.3] as const;
        if (p.x <= EYE.forward + 0.1 || !inFrame(outside[0], outside[1]) || !inFrame(az, el)) continue;
        const part = firstPart(outside[0], outside[1]);
        // under the lip line, the lip and the board are the frame too
        const underLip = outside[1] < lipElevation(outside[0]);
        expect(part, `${c.pane} ${c.edge} edge at (${az.toFixed(1)}, ${el.toFixed(1)}): the frame outside it`).not.toBeNull();
        if (!underLip) expect(part!, `${c.pane} ${c.edge} edge at (${az.toFixed(1)}, ${el.toFixed(1)})`).toMatch(c.frame);
        framed += 1;
      }
    }
    // NON-VACUITY: many samples of every kind of edge were in the frame
    expect(framed).toBeGreaterThan(150);
  });

  it("lines the crown over the glass in three bands at -15, 0 and +25 (S5): the overhead's front to its lip at +20, the crown inside the skin, and over No.1 the header down onto the glass", () => {
    const interior = named("airliner-cockpit-interior");
    const lipRow = Math.tan(AIRLINER_OVERHEAD.lipElevationDegrees / DEG);
    // (+25 is on No.1's straight top: at +20 its rounded inboard corner drops the glass away under the header)
    for (const az of [-15, 0, 25]) {
      const top = Math.atan(FRAME_V * Math.cos(az / DEG)) * DEG;
      // the overhead's lip is straight across, so its underside is one row of the picture: +20 straight ahead
      const lip = Math.atan(lipRow * Math.cos(az / DEG)) * DEG;
      // from the frame's top down, in runs of what the eye meets: the overhead, the crown, the header, the seal, glass
      const runs: { what: string; from: number; to: number }[] = [];
      for (let e = top - 0.01; e >= 5; e -= 0.02) {
        const hit = firstHit(az, e);
        const part = hit ? partOf(hit.pickedMesh!, hit.faceId) : "glass";
        const what = hit?.pickedMesh?.name === "airliner-window-seals" ? "seal" : /crown/.test(part) ? "crown" : part.replace(/^airliner-/, "");
        if (what === "crown") {
          // UNDER the skin, never the shell: the body's outer skin along the same ray is beyond it (the frame's face
          // stands 0.012 in; at the glass its return rolls out to the rim, `proud` out of the skin)
          const skin = crossings(EYE_POINT, direction(az, e), shell).at(-1)!;
          const onFace = layerOf(hit!.pickedMesh!, hit!.faceId) === "face";
          expect(skin - hit!.distance, `the crown stands inside the skin at azimuth ${az}, elevation ${e.toFixed(2)}`).toBeGreaterThan(onFace ? 0.005 : -2 * AIRLINER_LINING.proud);
        }
        if (runs.at(-1)?.what === what) runs.at(-1)!.to = e;
        else runs.push({ what, from: e, to: e });
        if (what === "glass") break;
      }
      console.info(`747 crown at azimuth ${az}: ${runs.map((r) => `${r.what} ${r.from.toFixed(2)}..${r.to.toFixed(2)}`).join(", ")}`);
      // the jamb over the glass (the return's roll and the seal, frame and seal both named for the crown they roll out of
      // here) is the run just above the glass
      const jamb = runs.at(-2)!;
      const order = runs.map((r) => r.what);
      // over No.1 the header sits down on the glass: the jamb is behind it but for its clearance, a hair (S5); over No.2
      // the crown runs down to the glass and its jamb is the crown's own roll
      if (az === -15) {
        expect(order.filter((what) => what !== "seal"), `the bands at azimuth ${az}`).toEqual(["overhead-front", "crown", "glass"]);
      } else {
        const hair = jamb.what === "header" ? 0 : jamb.from - jamb.to + 0.02;
        expect(hair, `the jamb under the header at azimuth ${az}`).toBeLessThan(0.1);
        expect(order.slice(0, 3), `the bands at azimuth ${az}`).toEqual(["overhead-front", "crown", "header"]);
        expect(order.slice(3).every((what) => what === "crown" || what === "seal" || what === "glass"), `under the header at azimuth ${az}: ${order.slice(3).join(", ")}`).toBe(true);
        expect(runs[2]!.from - runs[2]!.to, `the header's height at azimuth ${az}`).toBeGreaterThan(1.5);
      }
      expect(runs[0]!.to, `the overhead's lip at azimuth ${az}`).toBeCloseTo(lip, 1);
      expect(runs[1]!.from - runs[1]!.to, `the crown between them at azimuth ${az}`).toBeGreaterThan(3);
      const opening = runs.at(-1)!.from;
      expect(opening, `the opening's top at azimuth ${az}`).toBeGreaterThan(8);
      expect(opening).toBeLessThan(13);
      expect(exitsThrough(az, opening - 0.5), `glass just under the frame at azimuth ${az}`).toBe("glass");
    }
    // CONTROL: without the interior mesh a ray across the crown meets nothing the cockpit camera draws; the crown is what covers it
    interior.isVisible = false;
    try {
      expect(firstHit(0, 17)).toBeNull();
    } finally {
      interior.isVisible = true;
    }
  });

  it("has a hole in the picture only where there is glass, and covers glass only at the lip, a pane's own edges and its rounded corners", () => {
    const skinShowing: string[] = [];
    const glassCovered: string[] = [];
    let open = 0;
    let solid = 0;
    const kind = new Map<string, "glass" | "post" | "skin">();
    const exit = (az: number, el: number) => {
      const key = `${az.toFixed(2)},${el.toFixed(2)}`;
      let k = kind.get(key);
      if (!k) {
        k = exitsThrough(az, el);
        kind.set(key, k);
      }
      return k;
    };
    // an edge: within half a degree of another kind of exit. The lining's rim runs 0.012 in from the skin and 0.008
    // out of it round each hole, and No.2's top edge is 1.3 m away and seen at a slant, where that rim reads up to
    // half a degree across; the lining's chords and the pane's are also sampled at different points along an edge.
    const nearEdge = (az: number, el: number, what: string) =>
      [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].some(([da, de]) => exit(az + da!, el + de!) !== what);
    // and the frame's rounded corners (S2) cover each pane's corners, inside its rectangle, by design
    const inRoundedCorner = (p: Vector3) => {
      const R = FLIGHT_DECK_REFERENCE;
      const az = Math.atan2(Math.abs(p.z - R.z), p.x - R.x) * DEG;
      const el = Math.atan2(p.y - R.y, Math.hypot(p.x - R.x, p.z - R.z)) * DEG;
      return FLIGHT_DECK_PANES.some(({ name, azimuth: [a0, a1], elevation: [e0, e1] }) => {
        const reach = AIRLINER_FRAME.cornerRadiusDegrees[name]! + 0.2;
        return az > a0 && az < a1 && el > e0 && el < e1 && Math.min(az - a0, a1 - az) < reach && Math.min(el - e0, e1 - el) < reach;
      });
    };
    for (let az = -37.5 + 0.37; az <= 37.5; az += 1) {
      for (let el = -24 + 0.37; el <= 24; el += 1) {
        if (!inFrame(az, el)) continue;
        const what = exit(az, el);
        const hit = firstHit(az, el);
        if (hit) solid += 1;
        else open += 1;
        if (!hit && what !== "glass" && !nearEdge(az, el, what)) skinShowing.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) ${what}`);
        if (hit && what === "glass" && el > lipElevation(az) + 0.1 && !nearEdge(az, el, what) && !inRoundedCorner(hit.pickedPoint!)) glassCovered.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) by ${hit.pickedMesh!.name}`);
      }
    }
    console.info(`747 frame from the eye: ${open} rays open, ${solid} on the kit or the post`);
    expect(skinShowing, "hidden skin showing as sky").toEqual([]);
    expect(glassCovered, "the kit over the middle of a pane").toEqual([]);
    expect(open).toBeGreaterThan(600);
    expect(solid).toBeGreaterThan(600);
  });
});

describe("the 747's screens", () => {
  /** A screen box's own 24 vertices in the merged screens mesh, in slot order. */
  const screenBlock = (k: number) => worldVertices(named("airliner-screens")).slice(k * 24, k * 24 + 24);
  /** A bezel's frame and its chamfered rim, 96 vertices each (16 quads, unshared), in slot order. */
  const bezelBlock = (k: number) => [
    ...worldVertices(named("airliner-screen-bezels")).slice(k * 96, k * 96 + 96),
    ...worldVertices(named("airliner-screen-bezel-rims")).slice(k * 96, k * 96 + 96),
  ];
  const centreOf = (vertices: Vector3[]) => vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);

  it("are the type's layout: each PFD before its pilot, the ND inboard, the upper EICAS on the centreline and the lower under it", () => {
    const names = (named("airliner-screens").metadata as { mergedFrom: string[] }).mergedFrom;
    expect(names).toEqual([
      "airliner-screen-port-pfd", "airliner-screen-port-nd", "airliner-screen-port-eicas",
      "airliner-screen-starboard-eicas", "airliner-screen-starboard-nd", "airliner-screen-starboard-pfd",
    ]);
    const c = names.map((_, k) => centreOf(screenBlock(k)));
    const [pfd, nd, upper, lower, starboardNd, starboardPfd] = c as [Vector3, Vector3, Vector3, Vector3, Vector3, Vector3];
    expect(pfd.z, "the pilot's PFD on the eye's own z").toBeCloseTo(EYE.right, 3);
    expect(azel(pfd).az).toBeCloseTo(0, 1);
    expect(nd.z - pfd.z, "the ND a pitch inboard").toBeCloseTo(AIRLINER_SCREENS.pitch, 3);
    expect(starboardPfd.z).toBeCloseTo(-EYE.right, 3);
    expect(starboardPfd.z - starboardNd.z).toBeCloseTo(AIRLINER_SCREENS.pitch, 3);
    // the centre pair on the centreline, the lower EICAS straight under the upper, a row DOWN THE LEANED FACE
    expect(upper.z).toBeCloseTo(0, 6);
    expect(lower.z).toBeCloseTo(0, 6);
    const face = airlinerPanelFace();
    expect((upper.x - lower.x) * face.up.x + (upper.y - lower.y) * face.up.y).toBeCloseTo(AIRLINER_SCREENS.height + AIRLINER_SCREENS.bezel * 2 + AIRLINER_SCREENS.rowGap, 5);
    // the top row shares one height
    for (const top of [nd, upper, starboardNd, starboardPfd]) expect(top.y).toBeCloseTo(pfd.y, 6);
    // NO TWO BEZELS OVERLAP (each bezel's box in y and z against every other's)
    const boxes = names.map((_, k) => {
      const b = bezelBlock(k);
      return { y0: Math.min(...b.map((v) => v.y)), y1: Math.max(...b.map((v) => v.y)), z0: Math.min(...b.map((v) => v.z)), z1: Math.max(...b.map((v) => v.z)) };
    });
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1;
        expect(overlap, `${names[i]} and ${names[j]} overlap`).toBe(false);
      }
    }
  });

  it("hang the top row 0.65 degree under the cove's foot, and ride the leaned face: screen, frame, rim and well square to it, the screen 3 mm BEHIND the frame's front", () => {
    const face = airlinerPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const offOf = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y;
    // hung from the board's top edge (P1a's cove's foot; the glareshield stands over it since S3)
    const foot = airlinerBoardTop();
    const edge = Math.atan2(foot.y - EYE.up, foot.x - EYE.forward) * DEG;
    for (const k of [0, 1, 2, 4, 5]) {
      const block = screenBlock(k);
      // the front face: the corners furthest out of the leaned face, the top pair the furthest up it (float32: 2 um)
      const front = Math.max(...block.map((v) => Vector3.Dot(v, out)));
      const corners = block.filter((v) => Math.abs(Vector3.Dot(v, out) - front) < 2e-6);
      const top = corners.reduce((a, b) => (Vector3.Dot(b, up) > Vector3.Dot(a, up) ? b : a));
      expect(Math.atan2(top.y - EYE.up, top.x - EYE.forward) * DEG, `screen ${k}'s top edge`).toBeCloseTo(edge - AIRLINER_SCREENS.belowDeckEdgeDegrees, 3);
    }
    // SQUARE TO THE FACE, every screen (the lower EICAS too), to a hundredth of a millimetre (float32)
    const levels = (vs: Vector3[]) => [...new Set(vs.map((v) => offOf(v).toFixed(5)))].map(Number).sort((a, b) => a - b);
    const frames = worldVertices(named("airliner-screen-bezels"));
    const rims = worldVertices(named("airliner-screen-bezel-rims"));
    const wells = worldVertices(named("airliner-screen-wells"));
    for (let k = 0; k < 6; k += 1) {
      // the frame: its back 1 mm inside the board, its front 6 mm out; the rim the same, and the chamfer's foot 4 mm under
      expect(levels(frames.slice(k * 96, k * 96 + 96)), `frame ${k}'s planes: back, front`).toEqual([-0.001, 0.006]);
      expect(levels(rims.slice(k * 96, k * 96 + 96)), `rim ${k}'s planes: back, the chamfer's foot, front`).toEqual([-0.001, 0.002, 0.006]);
      // the screen: a 0.5 mm plate whose face is 3 mm behind the frame's front (it stood 1 mm proud of it until P1b)
      expect(levels(screenBlock(k)), `screen ${k}'s planes`).toEqual([0.0025, 0.003]);
      // the well: straddling the board's face, behind the screen
      expect(levels(wells.slice(k * 24, k * 24 + 24)), `well ${k}'s planes`).toEqual([-0.0005, 0.0005]);
    }
  });

  it("frame each screen: the bezel 10 mm beyond it all round, its opening the screen and a 2 mm gap", () => {
    // The sizes are the design's, written out here and not read from the builder's constants.
    const BEZEL = 0.01;
    const GAP = 0.002;
    const { width, height } = AIRLINER_SCREENS;
    const face = airlinerPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    for (const [k, { faceCentre }] of airlinerScreenPlacements().entries()) {
      const bezel = bezelBlock(k);
      const across = bezel.map((v) => v.z - faceCentre.z);
      const along = bezel.map((v) => Vector3.Dot(v.subtract(faceCentre), up));
      expect(Math.max(...across) - Math.min(...across), `bezel ${k}'s width`).toBeCloseTo(width + 2 * BEZEL, 5);
      expect(Math.max(...along) - Math.min(...along), `bezel ${k}'s height, up the face`).toBeCloseTo(height + 2 * BEZEL, 5);
      const opening = across.filter((z) => Math.abs(z) < width / 2 + GAP + 1e-4);
      expect(Math.max(...opening.map(Math.abs)), `bezel ${k}'s opening, the screen and its gap`).toBeCloseTo(width / 2 + GAP, 5);
      // and the screen on its bezel's centre
      const screen = screenBlock(k);
      expect((Math.max(...screen.map((v) => v.z)) + Math.min(...screen.map((v) => v.z))) / 2, `screen ${k} centred across`).toBeCloseTo(faceCentre.z, 5);
      const screenUp = screen.map((v) => Vector3.Dot(v.subtract(faceCentre), up));
      expect((Math.max(...screenUp) + Math.min(...screenUp)) / 2, `screen ${k} centred up the face`).toBeCloseTo(0, 5);
    }
  });

  it("bevel each bezel: a 4 mm chamfer at 45 degrees round its outer edge, facing out of the face, by the built normals", () => {
    const face = airlinerPanelFace();
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const up = new Vector3(face.up.x, face.up.y, 0);
    const rims = named("airliner-screen-bezel-rims");
    const normals = rims.getVerticesData(VertexBuffer.NormalKind)!;
    const vertices = worldVertices(rims);
    const seen = new Set<string>();
    let chamfer = 0;
    // the six screens' rims (the clock's comes after them, round, on its own face: see "the clock")
    for (let i = 0; i < 6 * 96; i += 1) {
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
    expect(chamfer, "four chamfer quads a bezel, two triangles each").toBe(6 * 4 * 2 * 3);
    // its width across the face: 4 mm (its fall toward the face is pinned by the planes)
    for (const [k, { faceCentre }] of airlinerScreenPlacements().entries()) {
      const rim = vertices.slice(k * 96, k * 96 + 96).map((v) => Math.abs(v.z - faceCentre.z));
      const edges = [...new Set(rim.map((z) => z.toFixed(5)))].map(Number).sort((a, b) => a - b).slice(-2);
      expect(edges[1]! - edges[0]!, `rim ${k}: 4 mm across the face`).toBeCloseTo(0.004, 5);
    }
  });

  it("recess each screen 3 mm behind its bezel in a 2 mm dark well: by ray, the screen's face, the gap, the frame", () => {
    const face = airlinerPanelFace();
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const up = new Vector3(face.up.x, face.up.y, 0);
    const offOf = (p: Vector3) => (p.x - face.top.x) * face.normal.x + (p.y - face.top.y) * face.normal.y;
    const screens = named("airliner-screens");
    const { width, height } = AIRLINER_SCREENS;
    // the pilot's PFD and ND, the two the frame shows most of
    for (const { name, faceCentre } of airlinerScreenPlacements().slice(0, 2)) {
      // a ray at the screen's middle meets the screen, 3 mm behind the frame's front
      const middle = faceCentre.add(out.scale(0.003));
      const hit = firstHitAlong(middle.subtract(EYE_POINT).normalize());
      expect(hit?.pickedMesh, `${name}: the screen at its middle`).toBe(screens);
      const at = EYE_POINT.add(middle.subtract(EYE_POINT).normalize().scale(hit!.distance));
      expect(0.006 - offOf(at), `${name}: the recess, by ray`).toBeCloseTo(0.003, 4);
      // a ray into the gap, a millimetre off the screen's edge, meets the WELL, dark, on the side toward the eye (both
      // sides of the PFD, which is straight ahead); over the screen's top it meets the glareshield, which stands over
      // the screens' tops (S3)
      const toward = Math.sign(EYE.right - faceCentre.z);
      for (const side of toward === 0 ? [-1, 1] : [toward]) {
        const gap = faceCentre.add(new Vector3(0, 0, side * (width / 2 + 0.001))).add(out.scale(0.0005));
        expect(firstHitAlong(gap.subtract(EYE_POINT).normalize())?.pickedMesh?.name, `${name}: the gap at z ${side}`).toBe("airliner-screen-wells");
      }
      const top = faceCentre.add(up.scale(height / 2 + 0.001)).add(out.scale(0.0005));
      const over = firstHitAlong(top.subtract(EYE_POINT).normalize());
      expect(over && partOf(over.pickedMesh!, over.faceId), `${name}: the gap over the screen, under the strip`).toMatch(/^airliner-glareshield/);
      // and a ray at the frame's flat face meets the frame, on its front
      const flat = faceCentre.add(new Vector3(0, 0, width / 2 + 0.002 + 0.002)).add(out.scale(0.006));
      expect(firstHitAlong(flat.subtract(EYE_POINT).normalize())?.pickedMesh?.name, `${name}: the frame's face`).toBe("airliner-screen-bezels");
    }
  });

  it("reach the board's top edge with the bezels' top rims, no further: the gap under it is theirs (at 0.5 degree they stood 0.14 into it)", () => {
    const foot = airlinerBoardTop();
    const edge = Math.atan2(foot.y - EYE.up, foot.x - EYE.forward) * DEG;
    const bezels = [...worldVertices(named("airliner-screen-bezels")), ...worldVertices(named("airliner-screen-bezel-rims"))];
    const highest = Math.max(...bezels.map((v) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG));
    console.info(`747 bezels' top rims: ${(highest - edge).toFixed(3)} degrees against the cove's foot`);
    // the gap was solved for the chamfered frames (P1b): their tops sit 0.005 degree under the foot (K3's square bezels
    // stood 0.008 over it), so the whole cove shows over every screen
    expect(highest, "the bezels under the deck's edge").toBeLessThanOrEqual(edge);
    expect(highest, "and not far under it: the gap is theirs").toBeGreaterThan(edge - 0.1);
  });

  it("show at least 29% of the pilot's PFD, the ND and the upper EICAS in the 16:9 frame, and nothing of the lower one (S3)", () => {
    // Over an 81 (up the face) x 21 grid of each screen's pilot-facing face: in the frame's rectangle, and the first thing
    // the cockpit camera draws along the ray is that screen, where the face is. (21 rows read in steps of 4.8%.)
    const screens = named("airliner-screens");
    const names = (screens.metadata as { mergedFrom: string[] }).mergedFrom;
    const fractions: Record<string, number> = {};
    const face = airlinerPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    for (const [k, name] of names.entries()) {
      // the screen's front face ON THE LEANED FACE: its four corners, bottom pair then top pair (float32: 2 um)
      const block = screenBlock(k);
      const front = Math.max(...block.map((v) => Vector3.Dot(v, out)));
      const corners: Vector3[] = [];
      for (const v of block) if (Math.abs(Vector3.Dot(v, out) - front) < 2e-6 && !corners.some((c) => Vector3.Distance(c, v) < 2e-6)) corners.push(v);
      expect(corners, `${name}: a box face's four corners`).toHaveLength(4);
      corners.sort((a, b) => Vector3.Dot(a, up) - Vector3.Dot(b, up) || a.z - b.z);
      const [b0, b1, t0, t1] = corners as [Vector3, Vector3, Vector3, Vector3];
      let seen = 0;
      let total = 0;
      for (let i = 0; i <= 80; i += 1) {
        for (let j = 0; j <= 20; j += 1) {
          const p = Vector3.Lerp(Vector3.Lerp(b0, b1, (j + 0.5) / 21), Vector3.Lerp(t0, t1, (j + 0.5) / 21), (i + 0.5) / 81);
          total += 1;
          const q = p.subtract(EYE_POINT);
          if (Math.abs(q.z / q.x) > FRAME_U || Math.abs(q.y / q.x) > FRAME_V) continue;
          const hit = firstHitAlong(q.normalizeToNew());
          if (hit?.pickedMesh === screens && Math.abs(hit.distance - q.length()) < 1e-3) seen += 1;
        }
      }
      fractions[name.replace("airliner-screen-", "")] = seen / total;
    }
    console.info(`747 screens in the frame: ${Object.entries(fractions).map(([n, f]) => `${n} ${(f * 100).toFixed(1)}%`).join(", ")}`);
    // the floor is 29% (S3). K3 gave 37.8%, P1a kept it; the glareshield's padded nose, its strip and the round its
    // bottom edge turns under in stand over the screens' tops now, as the type's glareshield overhangs its displays.
    for (const name of ["port-pfd", "port-nd", "port-eicas"]) {
      expect(fractions[name], `${name} in the frame`).toBeGreaterThanOrEqual(0.29);
    }
    expect(fractions["starboard-eicas"], "the lower EICAS is under the frame").toBe(0);
    // the starboard pair is beyond the frame's right edge but for a sliver of the ND
    expect(fractions["starboard-nd"]).toBeLessThan(0.02);
    expect(fractions["starboard-pfd"]).toBe(0);
  });
});

describe("the 747's cockpit against the shell it stands in", () => {
  /** The shell's OUTER half-width at (x, y): the LAST crossing of a ray from the centreline, since the fuselage and radome overlap. */
  function outerHalfWidth(x: number, y: number, side: 1 | -1): number {
    const hits = crossings(new Vector3(x, y, 0), new Vector3(0, 0, side), shell);
    return hits.length > 0 ? hits[hits.length - 1]! : Number.NaN;
  }

  it("keeps the board, the lip, the screens, the bezels and the wells inside the outer skin with clearance to spare", () => {
    const lines: string[] = [];
    const parts: [string, Vector3[]][] = [
      ["panel board", worldVertices(named("airliner-cockpit-interior")).slice(0, boardVertices())],
      ["glareshield lip", worldVertices(named("airliner-glareshield"))],
      ["screens", worldVertices(named("airliner-screens"))],
      ["bezels", [...worldVertices(named("airliner-screen-bezels")), ...worldVertices(named("airliner-screen-bezel-rims"))]],
      ["wells", worldVertices(named("airliner-screen-wells"))],
    ];
    for (const [label, vertices] of parts) {
      let tightest = Number.POSITIVE_INFINITY;
      let measured = 0;
      for (const v of vertices) {
        if (Math.abs(v.z) < 1e-4) continue;
        const wall = outerHalfWidth(v.x, v.y, v.z < 0 ? -1 : 1);
        if (!Number.isFinite(wall)) continue;
        measured += 1;
        tightest = Math.min(tightest, wall - Math.abs(v.z));
      }
      expect(measured, `${label}: vertices measured`).toBeGreaterThan(vertices.length / 2);
      lines.push(`${label}: tightest clearance ${tightest.toFixed(4)} m over ${measured} vertices`);
      expect(tightest, `${label} against the outer skin`).toBeGreaterThanOrEqual(0.01);
    }
    // the board and the lip stand aft of the fuselage loft's forward cap, which is hidden: nothing of them is ahead of x
    // 30.80 (the hood's forward end, 0.1 forward of the aft face, is at it)
    expect(Math.max(...parts[0]![1].map((v) => v.x), ...parts[1]![1].map((v) => v.x))).toBeLessThanOrEqual(30.8 + 1e-9);
    console.info(`747 cockpit clearance from the shell's outer skin:\n  ${lines.join("\n  ")}`);
  });

  it("is the kit's own frame: the window frame and its seals are `airlinerWindowFrame` on the built shell, vertex for vertex", () => {
    // the frame every test here reads (cast again on the shell's own triangles) is the one that was built
    const interior = named("airliner-cockpit-interior");
    const built = Array.from(interior.getVerticesData(VertexBuffer.PositionKind)!).slice(boardVertices() * 3);
    expect(built.length, "the frame's vertices, after the board's").toBe(frame.frame.positions.length);
    expect(Math.max(...built.map((v, i) => Math.abs(v - frame.frame.positions[i]!)))).toBeLessThan(1e-6);
    const seals = Array.from(named("airliner-window-seals").getVerticesData(VertexBuffer.PositionKind)!);
    expect(seals.length).toBe(frame.seals.positions.length);
    expect(Math.max(...seals.map((v, i) => Math.abs(v - frame.seals.positions[i]!)))).toBeLessThan(1e-6);
    // the board is its section's four sides swept along the deck's path, and its two end caps (S4)
    expect(boardTriangles(), "the board's own").toBe(4 * 2 * (airlinerDeckPath().length - 1) + 2 * 2);
  });

  it("is ONE welded surface: every edge between two of its triangles is shared, and it is open only at its outer edges and where each seal meets it (no seam, no T-junction)", () => {
    // Fifteen strips met at doubled rims (19 seams showed from the seat, P0) and at the same cast points, to the bit, or
    // the hidden sky showed through as a hairline (K2). The frame is one surface now: welded by position (a mitre's two
    // shadings share its points), each edge has two triangles, but on the frame's outer edges (R's -30 and 40 degrees,
    // and 78 either side, all outside the view) and the return's last ring, where the seal takes over, point for point.
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1e7)},${Math.round(y * 1e7)},${Math.round(z * 1e7)}`;
    const { positions, indices } = frame.frame;
    const at = (v: number) => key(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    const edges = new Map<string, number>();
    for (let t = 0; t < indices.length / 3; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        const [p, q] = [at(indices[t * 3 + k]!), at(indices[t * 3 + ((k + 1) % 3)]!)].sort();
        edges.set(`${p}|${q}`, (edges.get(`${p}|${q}`) ?? 0) + 1);
      }
    }
    // the seals' first ring: their section's first point, the return's last
    const sealFront = new Set<string>();
    const sp = frame.seals.positions;
    for (let v = 0; v < sp.length / 3; v += 1) sealFront.add(key(sp[v * 3]!, sp[v * 3 + 1]!, sp[v * 3 + 2]!));
    const R = FLIGHT_DECK_REFERENCE;
    const onOuterEdge = (k: string) => {
      const [x, y, z] = k.split(",").map((v) => Number(v) / 1e7) as [number, number, number];
      const [dx, dy, dz] = [x - R.x, y - R.y, z - R.z];
      const az = Math.atan2(Math.abs(dz), dx) * DEG;
      const el = Math.atan2(dy, Math.hypot(dx, dz)) * DEG;
      // a degree: the face stands `depth` in along the skin's normal, which R reads off its cast angle; nothing else of the
      // frame comes within two degrees of its outer edges
      return Math.abs(az - AIRLINER_LINING.outboard) < 1 || Math.abs(el - AIRLINER_LINING.bottom) < 1 || Math.abs(el - AIRLINER_LINING.top) < 1;
    };
    let shared = 0;
    let outer = 0;
    let atSeals = 0;
    const faults: string[] = [];
    for (const [edge, count] of edges) {
      const [p, q] = edge.split("|") as [string, string];
      if (count === 2) shared += 1;
      else if (count === 1 && onOuterEdge(p) && onOuterEdge(q)) outer += 1;
      else if (count === 1 && sealFront.has(p) && sealFront.has(q)) atSeals += 1;
      else faults.push(`${edge}: ${count} triangles`);
    }
    console.info(`747 window frame: ${shared} shared edges, ${outer} on its outer edges, ${atSeals} where the seals meet it, ${faults.length} faults`);
    expect(faults.slice(0, 8), `${faults.length} edges neither shared nor on the frame's rim`).toEqual([]);
    // NON-VACUITY: a surface, its outer edge and every opening's seal junction were all found
    expect(shared).toBeGreaterThan(3000);
    expect(outer).toBeGreaterThan(40);
    expect(atSeals).toBeGreaterThanOrEqual(frame.loops.reduce((sum, loop) => sum + loop.stations.length, 0) - 4 * frame.loops.length);
  });

  it("lines the skin from inside: where the pilot sees the frame's face it stands inside the outer skin, and its rolled rim barely out of it", () => {
    // The frame's FACE stands AIRLINER_LINING.depth (0.012) in from the skin; at a pane's edge it rolls (the return,
    // then the seal) out to the rim, AIRLINER_LINING.proud (0.008) out of it, as the old square rim did.
    let face = 0;
    let rim = 0;
    let tightestFace = Number.POSITIVE_INFINITY;
    let farthestRim = Number.POSITIVE_INFINITY;
    let shadedAway = 0;
    for (let az = -37 + 0.61; az <= 37; az += 1) {
      for (let el = -23 + 0.61; el <= 23; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = firstHit(az, el);
        const layer = hit ? layerOf(hit.pickedMesh!, hit.faceId) : null;
        if (!layer) continue;
        const d = direction(az, el);
        const skin = crossings(EYE_POINT, d, shell).at(-1)!;
        if (layer === "face") {
          face += 1;
          tightestFace = Math.min(tightestFace, skin - hit!.distance);
          // SHADED toward the cabin: the face's normals are the skin's own, turned in, smooth across the whole frame, so the
          // drawn-faces test's flat-normal guard does not see them. Every vertex of the face met must be lit from the pilot's side.
          const normals = hit!.pickedMesh!.getVerticesData(VertexBuffer.NormalKind)!;
          const indices = hit!.pickedMesh!.getIndices()!;
          for (let k = 0; k < 3; k += 1) {
            const n = indices[hit!.faceId * 3 + k]! * 3;
            if (normals[n]! * d.x + normals[n + 1]! * d.y + normals[n + 2]! * d.z >= 0) shadedAway += 1;
          }
        } else {
          rim += 1;
          farthestRim = Math.min(farthestRim, skin - hit!.distance);
        }
      }
    }
    console.info(`747 frame: ${face} rays on its face, the tightest ${tightestFace.toFixed(4)} m inside the skin; ${rim} on its returns and seals, the farthest ${(-farthestRim).toFixed(4)} m outside`);
    expect(face).toBeGreaterThan(300);
    expect(rim, "the returns are the frame's depth at the panes' edges, a small part of what shows").toBeLessThan(face / 5);
    // the face stands AIRLINER_LINING.depth (0.012) in; the chords between its grid points only sag further in
    expect(tightestFace).toBeGreaterThan(0.005);
    expect(shadedAway, "frame face vertices shaded away from the eye").toBe(0);
    // seen along a slanting sightline, a rim AIRLINER_LINING.proud (0.008) out of the skin can read up to about twice that outside it
    expect(farthestRim).toBeGreaterThan(-(AIRLINER_LINING.proud * 2));
  });

  it("reads as it did square (2.3 +- 0.2): the No.1 / No.2 pillar, its face rolling into the glass on both sides (K3, S1)", () => {
    // Jason's "thick, bulky" frames were the lining's depth: as the glass's own 0.10 m slab, its side faces were half
    // the pillar's apparent width, 1.9 of 3.8 degrees, a second lit tone down every pillar. At 0.02 m the pillar read
    // 2.3 degrees with 0.4 of flat side; rolled (S1), the side is the return, curving from the face into the glass, and
    // the width is the same, face to rim. Measured along the horizon across the pillar in 0.01 degree steps.
    const rows = [-8, 0, 4].map((el) => {
      const seen = { face: 0, return: 0, seal: 0 };
      for (let az = -13; az <= -5; az += 0.01) {
        const hit = firstHit(az, el);
        if (!hit || partOf(hit.pickedMesh!, hit.faceId) !== "port-airliner-lining-pillar-one-two") continue;
        seen[layerOf(hit.pickedMesh!, hit.faceId)!] += 0.01;
      }
      const total = seen.face + seen.return + seen.seal;
      console.info(`747 No.1 / No.2 pillar at el ${el}: ${total.toFixed(2)} deg, face ${seen.face.toFixed(2)} + returns ${seen.return.toFixed(2)} + seals ${seen.seal.toFixed(2)}`);
      return { el, total, ...seen };
    });
    for (const { el, total, face, return: rolled } of rows) {
      expect(face, "the pillar is there").toBeGreaterThan(1);
      expect(rolled, "and it rolls").toBeGreaterThan(0);
      expect(Math.abs(total - 2.3), `the pillar at el ${el}, against its square 2.3`).toBeLessThanOrEqual(0.2);
    }
  });

  it("puts nothing in the frame that the design did not account for: the kit and the centre post", () => {
    const allowed = new Set([
      "airliner-cockpit-interior", "airliner-glareshield", "airliner-screens", "airliner-screen-bezels",
      "airliner-screen-bezel-rims", "airliner-screen-wells", "airliner-window-seals", "airliner-clock", "airliner-header",
      "airliner-overhead-front",
    ]);
    for (let az = -37; az <= 37; az += 2) {
      for (let el = -23; el <= 23; el += 1) {
        const hit = firstHit(az, el);
        if (hit) expect(allowed.has(hit.pickedMesh!.name), `${hit.pickedMesh!.name} at azimuth ${az}, elevation ${el}`).toBe(true);
      }
    }
  });
});

/**
 * THE CREASES THE PILOT SEES on `meshes` (welded by position): every edge between two triangles sharper than `min`
 * degrees where BOTH triangles are seen at it, each being, 2 mm in from the edge's middle, the very triangle the eye's
 * ray meets first. An edge where only one side is seen (a window's outline against the sky, the board's top edge under
 * the cove) is an outline, not a crease; and a face buried behind another (a seal's back, inside the frame) is never seen.
 */
function seenCreases(meshes: readonly AbstractMesh[], min: number): { az: number; el: number; dihedral: number; mid: Vector3 }[] {
  const tris: { p: Vector3[]; out: Vector3; mesh: AbstractMesh; faceId: number }[] = [];
  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = mesh.getIndices()!;
    for (let t = 0; t < indices.length / 3; t += 1) {
      const p = [0, 1, 2].map((k) => {
        const i = indices[t * 3 + k]! * 3;
        return new Vector3(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      });
      const cross = Vector3.Cross(p[1]!.subtract(p[0]!), p[2]!.subtract(p[0]!));
      if (cross.length() < 1e-14) continue;
      // the drawn side: a drawn face's cross product points INTO the solid
      tris.push({ p, out: cross.normalize().scale(-1), mesh, faceId: t });
    }
  }
  const key = (v: Vector3) => `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`;
  const edges = new Map<string, { a: Vector3; b: Vector3; tris: number[] }>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k += 1) {
      const [a, b] = [t.p[k]!, t.p[(k + 1) % 3]!];
      const id = [key(a), key(b)].sort().join("|");
      const edge = edges.get(id) ?? { a, b, tris: [] };
      edge.tris.push(i);
      edges.set(id, edge);
    }
  });
  const seenAt = (i: number, mid: Vector3) => {
    const t = tris[i]!;
    const centre = t.p[0]!.add(t.p[1]!).add(t.p[2]!).scale(1 / 3);
    if (Vector3.Dot(t.out, centre.subtract(EYE_POINT)) >= 0) return false;
    const inward = centre.subtract(mid);
    const q = mid.add(inward.normalizeToNew().scale(Math.min(0.002, 0.3 * inward.length())));
    const hit = firstHitAlong(q.subtract(EYE_POINT).normalize());
    return hit?.pickedMesh === t.mesh && hit.faceId === t.faceId;
  };
  const out: { az: number; el: number; dihedral: number; mid: Vector3 }[] = [];
  for (const edge of edges.values()) {
    if (edge.tris.length < 2) continue;
    let sharpest = 0;
    for (let i = 0; i < edge.tris.length; i += 1) {
      for (let j = i + 1; j < edge.tris.length; j += 1) {
        const dot = Math.max(-1, Math.min(1, Vector3.Dot(tris[edge.tris[i]!]!.out, tris[edge.tris[j]!]!.out)));
        sharpest = Math.max(sharpest, Math.acos(dot) * DEG);
      }
    }
    if (sharpest <= min) continue;
    const mid = Vector3.Lerp(edge.a, edge.b, 0.5);
    const seen = edge.tris.filter((i) => seenAt(i, mid));
    if (seen.length < 2) continue;
    let dihedral = 180;
    for (let i = 0; i < seen.length; i += 1) {
      for (let j = i + 1; j < seen.length; j += 1) {
        dihedral = Math.min(dihedral, Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(tris[seen[i]!]!.out, tris[seen[j]!]!.out)))) * DEG);
      }
    }
    if (dihedral > min) out.push({ ...azel(mid), dihedral, mid });
  }
  return out;
}

describe("the window frame's openings, rolled and rounded (S1, S2)", () => {
  it("is the design's profile: a 15 mm quarter round from the face, tangent to it and to the opening's wall, and its last 6 mm to the rim the seal", () => {
    const { ret, seal } = airlinerFrameProfile();
    const r = AIRLINER_FRAME.returnRadius;
    const { depth, proud } = AIRLINER_LINING;
    expect(r).toBe(0.015);
    expect(AIRLINER_FRAME.seal).toBe(0.006);
    // one circle about (r, r - depth): from the face's own point (tangent to it, shaded as it) to the wall
    for (const q of ret) expect(Math.hypot(q.u - r, q.n - (r - depth)), `the return at ${(q.theta * DEG).toFixed(1)} degrees`).toBeCloseTo(r, 12);
    expect(ret[0]).toEqual({ u: r, n: -depth, theta: 0 });
    // the seal's face: the return's last millimetre, then the wall straight out to the rim
    const along = r * (Math.PI / 2 - ret.at(-1)!.theta) + (proud - (r - depth));
    expect(along, "the seal band along the profile").toBeCloseTo(AIRLINER_FRAME.seal, 12);
    expect(seal[0]).toEqual(ret.at(-1));
    expect(seal[2]).toMatchObject({ u: 0, n: proud });
    // every station's face edge is on the skin the return's width from the opening, across it: `offset` per metre of u
    // is the chord to it, a metre per metre along it and near the skin's plane (the skin curves away under 15 mm of it,
    // and across the nose's own facet creases, 33 degrees under the No.1 / No.2 pillar, the chord tilts up to 17)
    for (const loop of frame.loops) {
      for (const st of loop.stations) {
        if (st.before !== st.after) continue;
        const chord = st.offset.scale(r);
        const along = chord.subtract(st.normal.scale(Vector3.Dot(chord, st.normal))).length();
        expect(Math.abs(along - r), `${loop.name}: the face's edge ${(along * 1000).toFixed(2)} mm across`).toBeLessThan(0.1 * r);
        expect(Math.abs(Vector3.Dot(st.offset, st.normal)), `${loop.name}: the chord near the skin's plane`).toBeLessThan(0.35);
      }
    }
  });

  it("rolls every edge and every corner of every opening: no crease over 45 degrees the pilot sees on the frame (S1, S2)", () => {
    // P0: 34 along the openings' edges (their square reveals' inner corners, both faces seen), and S1 left 35 in the
    // square corners' mitres, which S2 rounds
    const creases = seenCreases([named("airliner-cockpit-interior"), named("airliner-window-seals")], 45);
    console.info(`747 creases over 45 degrees seen from the seat: ${creases.length} on the frame`);
    expect(creases.map((c) => `(${c.az.toFixed(2)}, ${c.el.toFixed(2)}) ${c.dihedral.toFixed(1)} deg`), "a crease on the frame").toEqual([]);
    // CONTROL: the same instrument sees the creases the kit has on purpose, the bezels' square frames round the screens
    const bezels = seenCreases([named("airliner-screen-bezels")], 45);
    console.info(`747 bezels' seen creases over 45 degrees (the control): ${bezels.length}`);
    expect(bezels.length).toBeGreaterThan(10);
  });

  it("costs each pane's opening about 1% for its four rounds, a radius a pane (S2)", () => {
    // Each pane's solid angle from R (its rectangle in R's angles, weighted by the cosine of the elevation), lapped at its
    // sides (S1), against the same with its corners rounded. The smallest pane pays most for the same radius: at 3 degrees
    // all round, No.1, No.2 and No.3 lost 1.15, 1.10 and 2.05%. So each has its own, held to about 1%: 2.8, 2.8 and 2.0
    // degrees (exactly 1% is 2.80, 2.87 and 2.09).
    const loss: Record<string, number> = {};
    for (const loop of frame.loops.filter((l) => l.name.startsWith("starboard-"))) {
      const rho = AIRLINER_FRAME.cornerRadiusDegrees[loop.name.replace("starboard-", "")]!;
      const [a0, a1] = [Math.min(...loop.stations.map((st) => st.opening.a)), Math.max(...loop.stations.map((st) => st.opening.a))];
      const [e0, e1] = [Math.min(...loop.stations.map((st) => st.opening.e)), Math.max(...loop.stations.map((st) => st.opening.e))];
      let square = 0;
      let rounded = 0;
      const step = 0.02;
      for (let a = a0 + step / 2; a < a1; a += step) {
        for (let e = e0 + step / 2; e < e1; e += step) {
          const w = Math.cos(e / DEG);
          square += w;
          const dx = Math.max(a0 + rho - a, 0, a - (a1 - rho));
          const dy = Math.max(e0 + rho - e, 0, e - (e1 - rho));
          if (Math.hypot(dx, dy) <= rho) rounded += w;
        }
      }
      loss[loop.name.replace("starboard-", "")] = 100 * (1 - rounded / square);
    }
    console.info(`747 openings' loss to their rounded corners: ${Object.entries(loss).map(([k, v]) => `No.${k} ${v.toFixed(3)}%`).join(", ")}`);
    for (const [pane, lost] of Object.entries(loss)) expect(lost, `No.${pane}`).toBeLessThanOrEqual(1.005);
  });

  it("rounds every opening's four corners by its pane's radius in R's angles, and keeps its straight edges where the panes' are (S2)", () => {
    for (const loop of frame.loops) {
      const [side, name] = loop.name.split("-") as ["port" | "starboard", string];
      // none left square
      const rho = AIRLINER_FRAME.cornerRadiusDegrees[name]!;
      expect(rho, `${loop.name}'s radius`).toBeGreaterThan(0);
      const pane = FLIGHT_DECK_PANES.find((p) => p.name === name)!;
      const [e0, e1] = pane.elevation;
      const signs = side === "port" ? -1 : 1;
      const openings = loop.stations.map((st) => st.opening);
      // the sides are lapped (S1): read them off the stations, the sill's and the crown's are the pane's own
      const a0 = Math.min(...openings.map((o) => o.a));
      const a1 = Math.max(...openings.map((o) => o.a));
      expect(Math.min(...openings.map((o) => o.e)), `${loop.name}'s bottom`).toBeCloseTo(e0, 9);
      expect(Math.max(...openings.map((o) => o.e)), `${loop.name}'s top, where the pane's is`).toBeCloseTo(e1, 9);
      expect(Math.abs(signs * (a1 - a0) - signs * (pane.azimuth[1] - pane.azimuth[0])), `${loop.name}: lapped a tenth of a degree a side at most`).toBeLessThan(0.25);
      let onArcs = 0;
      for (const o of openings) {
        const dx = Math.max(a0 + rho - o.a, 0, o.a - (a1 - rho));
        const dy = Math.max(e0 + rho - o.e, 0, o.e - (e1 - rho));
        // every opening point is on the rounded rectangle: on a straight edge, or on a corner's round
        const onEdge = Math.abs(o.a - a0) < 1e-9 || Math.abs(o.a - a1) < 1e-9 || Math.abs(o.e - e0) < 1e-9 || Math.abs(o.e - e1) < 1e-9;
        if (dx > 1e-9 && dy > 1e-9) {
          onArcs += 1;
          expect(Math.hypot(dx, dy), `${loop.name} at (${o.a.toFixed(3)}, ${o.e.toFixed(3)})`).toBeCloseTo(rho, 9);
        } else expect(onEdge, `${loop.name} at (${o.a.toFixed(3)}, ${o.e.toFixed(3)}): on a straight edge`).toBe(true);
      }
      // each of the four rounds is sampled at least every 90 / cornerSegments degrees
      expect(onArcs, `${loop.name}: points on its four rounds`).toBeGreaterThanOrEqual(4 * (AIRLINER_FRAME.cornerSegments - 1));
    }
  });
});

describe("the deck turned aft and the clock on it (S4)", () => {
  it("shades the glareshield's round round: every vertex on it, across the middle, carries the round's radial normal", () => {
    // P0 counted the round's eight chords flat-shaded; swept (S4), the round's chords take the round's radial normals
    const section = airlinerGlareshieldSection();
    const across = Math.max(...airlinerDeckPath().filter((st) => st.forward.x === 1).map((st) => Math.abs(st.z)));
    const glare = named("airliner-glareshield");
    const positions = glare.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = glare.getVerticesData(VertexBuffer.NormalKind)!;
    let onRound = 0;
    for (let v = 0; v < positions.length / 3; v += 1) {
      const [x, y, z] = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
      if (Math.abs(z) > across + 1e-9) continue;
      const r = Math.hypot(x - section.centre.x, y - section.centre.y);
      if (Math.abs(r - AIRLINER_GLARESHIELD.noseRadius) > 1e-9) continue;
      // the round's two tangent points are the hood's and the cove's too, and carry their flat sides' normals there as well
      if ([section.round[0]!, section.round.at(-1)!].some((t) => Math.hypot(t.x - x, t.y - y) < 1e-9)) continue;
      // a cap's vertex faces along the deck, not round it
      if (Math.abs(normals[v * 3 + 2]!) > 0.5) continue;
      onRound += 1;
      expect(normals[v * 3]!, `the round at (${x.toFixed(4)}, ${y.toFixed(4)})`).toBeCloseTo((x - section.centre.x) / r, 9);
      expect(normals[v * 3 + 1]!).toBeCloseTo((y - section.centre.y) / r, 9);
      expect(normals[v * 3 + 2]!).toBeCloseTo(0, 9);
    }
    expect(onRound, "the round's inner vertices at the two stations across the middle").toBeGreaterThanOrEqual(2 * (AIRLINER_GLARESHIELD.noseSegments - 1));
  });

  it("puts the clock on the turn at az -17 from the seat, its bezel's top level with the screens', and its face in view", () => {
    const place = airlinerClockPlacement();
    const s = AIRLINER_SCREENS;
    const face = airlinerPanelFace();
    // its station on the turn reads az -17 at the face's top edge, and the dial's centre is on the clock's face
    const toCentre = place.centre.add(place.out.scale(0.003)).subtract(EYE_POINT);
    const hit = firstHitAlong(toCentre.normalizeToNew());
    expect(hit?.pickedMesh?.name, "the dial's middle").toBe("airliner-clock");
    console.info(`747 clock: at az ${azel(place.centre).az.toFixed(2)}, el ${azel(place.centre).el.toFixed(2)} from the eye; ${place.turnDegrees.toFixed(1)} degrees round the turn; the turn's depth across it ${(place.sag * 1000).toFixed(2)} mm`);
    // down the face (the face's own up, turned with the deck) its bezel's top is where the screens' bezels' tops are
    const pfd = airlinerScreenPlacements()[0]!.faceCentre;
    const pfdTop = (pfd.x - face.top.x) * face.up.x + (pfd.y - face.top.y) * face.up.y + s.height / 2 + s.bezel;
    const clockTop = place.centre.add(place.up.scale(AIRLINER_CLOCK.diameter / 2 + s.bezel)).y - face.top.y;
    expect(clockTop / face.up.y, "the bezel's top, down the face").toBeCloseTo(pfdTop, 9);
    // in the frame: of rays across the dial's face, those in the 16:9 frame that meet it
    let inFrameOnFace = 0;
    let rays = 0;
    for (let i = -10; i <= 10; i += 1) {
      for (let j = -10; j <= 10; j += 1) {
        if (i * i + j * j > 81) continue;
        const p = place.centre.add(place.across.scale((i / 10) * (AIRLINER_CLOCK.diameter / 2))).add(place.up.scale((j / 10) * (AIRLINER_CLOCK.diameter / 2))).add(place.out.scale(0.003 + place.sag));
        rays += 1;
        const { az, el } = azel(p);
        if (!inFrame(az, el)) continue;
        if (firstHit(az, el)?.pickedMesh?.name === "airliner-clock") inFrameOnFace += 1;
      }
    }
    console.info(`747 clock's face: ${((100 * inFrameOnFace) / rays).toFixed(0)}% of it in the frame`);
    expect(inFrameOnFace / rays, "most of the dial in the frame").toBeGreaterThan(0.5);
  });

  it("bevels the clock's bezel as the screens' (a 45 degree chamfer to its own face) and stands the dial clear of the turned board", () => {
    const place = airlinerClockPlacement();
    const clock = airlinerClockPieces();
    // the rim's first band is the chamfer: its normals 45 degrees off the clock's face, turned out round the dial
    const band = (AIRLINER_CLOCK.segments + 1) * 2;
    for (let v = 0; v < band; v += 1) {
      const n = new Vector3(clock.rim.normals[v * 3]!, clock.rim.normals[v * 3 + 1]!, clock.rim.normals[v * 3 + 2]!);
      expect(Vector3.Dot(n, place.out), "45 degrees to its own face").toBeCloseTo(Math.SQRT1_2, 9);
    }
    // the turn is concave to the pilot: at the dial's sides the board stands `sag` out of its centre's plane. Rays at the
    // bezel's frame all round meet the clock, never the board through it (over its top the glareshield's strip may stand,
    // S3)
    const s = AIRLINER_SCREENS;
    const radius = AIRLINER_CLOCK.diameter / 2;
    let clear = 0;
    // the frame's flat front, and the chamfered rim round it (the rim stands lowest, and is what the board would swallow)
    for (const [r, mesh, what] of [[radius + s.gap + (s.bezel - s.gap - s.chamfer) / 2, "airliner-screen-bezels", "frame"], [radius + s.bezel - s.chamfer / 2, "airliner-screen-bezel-rims", "rim"]] as const) {
      for (let k = 0; k < 24; k += 1) {
        const a = (2 * Math.PI * k) / 24;
        const p = place.centre.add(place.across.scale(r * Math.cos(a))).add(place.up.scale(r * Math.sin(a))).add(place.out.scale(0.004 + place.sag));
        const { az, el } = azel(p);
        if (!inFrame(az, el)) continue;
        const hit = firstHit(az, el);
        if (hit?.pickedMesh?.name === "airliner-glareshield") continue;
        expect(hit?.pickedMesh?.name, `the ${what} at ${((a * 180) / Math.PI).toFixed(0)} degrees round`).toBe(mesh);
        clear += 1;
      }
    }
    expect(clear, "frame and rim rays in view, under the strip").toBeGreaterThanOrEqual(10);
    // its face reads the right way round: +u to the pilot's right (across), world up to the smaller v
    const uv = (k: number) => [clock.face.uvs[k * 2]!, clock.face.uvs[k * 2 + 1]!] as const;
    const at = (k: number) => new Vector3(clock.face.positions[k * 3]!, clock.face.positions[k * 3 + 1]!, clock.face.positions[k * 3 + 2]!);
    const [middle, rightmost, top] = [0, 1, 1 + AIRLINER_CLOCK.segments / 4];
    expect(Vector3.Dot(at(rightmost).subtract(at(middle)), place.across)).toBeGreaterThan(0);
    expect(uv(rightmost)[0]).toBeGreaterThan(uv(middle)[0]);
    expect(Vector3.Dot(at(top).subtract(at(middle)), place.up)).toBeGreaterThan(0);
    expect(uv(top)[1]).toBeLessThan(uv(middle)[1]);
  });

  it("leaves under 2% of the frame blank board outboard of the PFD where there was 4.02% (0.7% of it flat, the rest the turn's face)", () => {
    // P0's measure: of the frame (uniform in the picture, as pixels are), the rays whose first surface is the board,
    // outboard of the pilot's PFD. The deck's turn (S4) and the clock on it take most of it; what is left is 0.71% of
    // flat board by the PFD and the turn's own face, seen as it comes toward the pilot
    const pfdEdge = azel(airlinerScreenPlacements()[0]!.faceCentre.add(new Vector3(0, 0, -(AIRLINER_SCREENS.width / 2 + AIRLINER_SCREENS.bezel)))).az;
    let rays = 0;
    let flat = 0;
    let turned = 0;
    for (let i = 0; i < 240; i += 1) {
      const u = -FRAME_U + (2 * FRAME_U * (i + 0.5)) / 240;
      const az = Math.atan(u) * DEG;
      for (let j = 0; j < 135; j += 1) {
        const v = -FRAME_V + (2 * FRAME_V * (j + 0.5)) / 135;
        rays += 1;
        if (az >= pfdEdge) continue;
        const hit = firstHitAlong(new Vector3(1, v, u).normalize());
        if (!hit || partOf(hit.pickedMesh!, hit.faceId) !== "airliner-instrument-panel") continue;
        if (az < -AIRLINER_DECK_WRAP.startAzimuthDegrees) turned += 1;
        else flat += 1;
      }
    }
    const [flatPct, turnedPct] = [(100 * flat) / rays, (100 * turned) / rays];
    console.info(`747 blank board outboard of the PFD: ${(flatPct + turnedPct).toFixed(2)}% of the frame (flat ${flatPct.toFixed(2)}%, the turn ${turnedPct.toFixed(2)}%)`);
    expect(flatPct, "flat board by the PFD").toBeLessThanOrEqual(1);
    expect(flatPct + turnedPct, "all of it").toBeLessThan(2);
  });
});

describe("the glareshield over the displays (S3)", () => {
  /** The lowest row at an azimuth where the first surface drawn is still the glareshield or one of its panels, scanning down from the lip. */
  function strippedTo(az: number): number {
    let el = lipElevation(az) - 0.01;
    for (; el > -30; el -= 0.01) {
      const hit = firstHit(az, el);
      if (!hit || !/^airliner-glareshield/.test(partOf(hit.pickedMesh!, hit.faceId))) break;
    }
    return el + 0.01;
  }

  it("hides every top-row screen's bezel under the strip: no bezel shows above the glareshield's lowest visible row", () => {
    const s = AIRLINER_SCREENS;
    const face = airlinerPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    const rows: string[] = [];
    for (const { name, faceCentre } of airlinerScreenPlacements().filter((p) => p.name !== "starboard-eicas")) {
      for (const across of [-0.4, 0, 0.4]) {
        const top = faceCentre.add(up.scale(s.height / 2 + s.bezel)).add(new Vector3(0, 0, across * s.width));
        const { az, el } = azel(top);
        if (!inFrame(az, el)) continue;
        const bottom = strippedTo(az);
        rows.push(`${name} ${across}: bezel top ${el.toFixed(2)}, the strip down to ${bottom.toFixed(2)}`);
        expect(el, `${name}'s bezel top at ${across} of its width: over the strip's lowest row, so under it`).toBeGreaterThan(bottom);
        const hit = firstHit(az, el);
        expect(hit && partOf(hit.pickedMesh!, hit.faceId), `${name}: its bezel's top meets the glareshield`).toMatch(/^airliner-glareshield/);
      }
    }
    console.info(`747 bezel tops under the strip: ${rows.join("; ")}`);
    expect(rows.length, "top-row bezel edges in the frame").toBeGreaterThan(6);
  });

  it("never shows the soffit: no ray from the seat meets the glareshield's underside first (the control: one from under it does)", () => {
    const glare = named("airliner-glareshield");
    const positions = glare.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = glare.getIndices()!;
    const facingDown = (faceId: number) => {
      const p = [0, 1, 2].map((k) => new Vector3(positions[indices[faceId * 3 + k]! * 3]!, positions[indices[faceId * 3 + k]! * 3 + 1]!, positions[indices[faceId * 3 + k]! * 3 + 2]!));
      // the drawn side: a drawn face's cross product points INTO the solid, so the outward normal is its negative
      const outward = Vector3.Cross(p[1]!.subtract(p[0]!), p[2]!.subtract(p[0]!)).normalize().scale(-1);
      return outward.y < -0.9;
    };
    let glareHits = 0;
    const seen: string[] = [];
    for (let az = -37 + 0.37; az <= 37; az += 0.5) {
      for (let el = -23 + 0.37; el <= -15; el += 0.1) {
        if (!inFrame(az, el)) continue;
        const hit = firstHit(az, el);
        if (hit?.pickedMesh !== glare) continue;
        glareHits += 1;
        if (facingDown(hit.faceId)) seen.push(`(${az.toFixed(2)}, ${el.toFixed(2)})`);
      }
    }
    expect(seen, "the soffit seen from the seat").toEqual([]);
    expect(glareHits, "rays that met the glareshield").toBeGreaterThan(200);
    // CONTROL: from under the soffit, looking up, the same instrument finds it
    const section = airlinerGlareshieldSection();
    const below = new Vector3(section.aftX + AIRLINER_GLARESHIELD.underRadius + 0.02, section.soffitY - 0.2, -0.3);
    const up = scene.pickWithRay(new Ray(below, new Vector3(0, 1, 0), 1), (m) => m === glare);
    expect(up?.hit && facingDown(up.faceId), "the control: the soffit from under it").toBe(true);
  });

  it("puts the MCP's speed, heading and altitude and the EFIS panel's window in view, each 12 px tall or more at 1080p and 2 px or more inside the strip's edges", () => {
    // the image plane's rows at 1920 x 1080: a point's row from its height over its distance ahead
    const pxRow = (p: Vector3) => 540 * (1 - (p.y - EYE.up) / (p.x - EYE.forward) / FRAME_V);
    const section = airlinerGlareshieldSection();
    const report: string[] = [];
    for (const panel of airlinerGlareshieldPanels()) {
      for (const w of panel.windows) {
        const front = w.quads[0]!.corners;
        const mid = (a: Vector3, b: Vector3) => Vector3.Lerp(a, b, 0.5);
        const bottom = mid(front[0], front[1]);
        const top = mid(front[3], front[2]);
        const centre = mid(bottom, top);
        const { az, el } = azel(centre);
        if (!inFrame(az, el)) continue;
        const tall = pxRow(bottom) - pxRow(top);
        // the strip's own edges at the window's middle, on the glareshield's aft face: the plate reads round the window
        const edge = (y: number) => pxRow(new Vector3(section.aftX, y, centre.z));
        const [above, below] = [pxRow(top) - edge(section.stripTop), edge(section.stripBottom) - pxRow(bottom)];
        report.push(`${panel.name}/${w.name} ${tall.toFixed(1)} px (margins ${above.toFixed(2)} and ${below.toFixed(2)}) at az ${az.toFixed(1)}`);
        expect(tall, `${panel.name}'s ${w.name} window`).toBeGreaterThanOrEqual(12);
        expect(Math.min(above, below), `${panel.name}'s ${w.name} window, inside the strip's edges`).toBeGreaterThanOrEqual(2);
        const hit = firstHit(az, el);
        expect(hit && partOf(hit.pickedMesh!, hit.faceId), `${panel.name}'s ${w.name} window, seen`).toBe(`airliner-glareshield-${panel.name}-windows`);
      }
    }
    console.info(`747 glareshield windows: ${report.join("; ")}`);
    // the MCP's three and the pilot's own EFIS panel's
    expect(report.length).toBe(4);
  });
});

describe("the header and the overhead's forward end (S5)", () => {
  /** The crown's share of the 16:9 frame: a ray through the middle of each cell of a `cols` by `rows` grid of the picture, named by `partOf`. */
  function crownShare(cols: number, rows: number): number {
    let crown = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const u = -1 + (2 * (c + 0.5)) / cols;
        const v = 1 - (2 * (r + 0.5)) / rows;
        const hit = firstHitAlong(new Vector3(1, v * FRAME_V, u * FRAME_U).normalize());
        if (hit && /crown/.test(partOf(hit.pickedMesh!, hit.faceId))) crown += 1;
      }
    }
    return crown / (cols * rows);
  }
  /** Scanning up from +8 at `az`: where the glass ends, and where the header starts (NaN if it never does below +20). */
  function overTheGlass(az: number): { glassTop: number; headerFrom: number } {
    let glassTop = Number.NaN;
    for (let e = 8; e < 20; e += 0.01) {
      const hit = firstHit(az, e);
      if (!hit) continue;
      if (Number.isNaN(glassTop)) glassTop = e - 0.01;
      if (hit.pickedMesh!.name === "airliner-header") return { glassTop, headerFrom: e };
    }
    return { glassTop, headerFrom: Number.NaN };
  }

  it("cuts the crown's one tone from a quarter of the frame to 15% or less", () => {
    const share = crownShare(160, 90);
    console.info(`747 crown's share of the frame: ${(share * 100).toFixed(2)}%`);
    expect(share).toBeLessThanOrEqual(0.15);
    // CONTROL: without the header and the overhead's front, the same rays find the crown the P0 survey found, a quarter
    // of the frame
    const [header, overhead] = [named("airliner-header"), named("airliner-overhead-front")];
    header.isVisible = false;
    overhead.isVisible = false;
    try {
      const bare = crownShare(160, 90);
      console.info(`747 crown's share without the header and the overhead: ${(bare * 100).toFixed(2)}%`);
      expect(bare).toBeGreaterThan(0.24);
    } finally {
      header.isVisible = true;
      overhead.isVisible = true;
    }
  });

  it("sits the header down on the glass's top edge over No.1's straight top, and takes none of the glass the eye sees", () => {
    // No.1's straight tops from the eye: R's azimuths 5.2 to 20.7 each side read about +1 to +11 (port) and +23 to +34
    const header = named("airliner-header");
    for (const az of [1, 4, 7, 10, 24, 27, 30, 33]) {
      const { glassTop, headerFrom } = overTheGlass(az);
      // the jamb over the glass (the return's roll) is behind it but for its clearance, a hair
      expect(headerFrom - glassTop, `the jamb between the glass and the header at azimuth ${az}`).toBeLessThan(0.1);
      header.isVisible = false;
      try {
        // and without it the glass ends where it did: the header covers the jamb, never the glass
        const bare = overTheGlass(az);
        expect(Math.abs(bare.glassTop - glassTop), `the glass's top at azimuth ${az}, with and without the header`).toBeLessThanOrEqual(0.011);
      } finally {
        header.isVisible = true;
      }
    }
    // the stations: solved where No.1's top is straight, held over its rounded corners and the post, and each section's
    // glass-side foot above the opening's top
    const { stations } = airlinerHeaderStations(skinCaster, frame);
    // R's azimuths 6 to 20 each side: No.1's top between its rounds (2.8 degrees in from 1.9 and 24) and half a degree
    expect(stations.filter((st) => st.solved).map((st) => Math.abs(st.azimuth)).sort((a, b) => a - b)).toEqual([6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20]);
    for (const st of stations) expect(st.footElevation, `the foot at R's azimuth ${st.azimuth}`).toBeGreaterThan(FLIGHT_DECK_PANES[0]!.elevation[1]);
    expect(Math.min(...stations.map((st) => st.azimuth))).toBe(-AIRLINER_HEADER.endAzimuthDegrees);
  });

  it("lays the header on the frame's face, smooth: no crease the pilot sees on it, and only its drawn side in view", () => {
    const header = named("airliner-header");
    // the frame's own rule, 45 degrees: its rounds' chords are 22.5 apart, and where the nose turns its corner its
    // sections turn up to 8 degrees a station more (laid "up the face" off the opening they folded 51 to 62)
    const creases = seenCreases([header], 45);
    console.info(`747 header's seen creases over 45 degrees: ${creases.length}`);
    expect(creases.map((c) => `(${c.az.toFixed(2)}, ${c.el.toFixed(2)}) ${c.dihedral.toFixed(1)} deg`), "a crease on the header").toEqual([]);
    // every ray that meets it first meets a face turned to the eye: its flat side, sunk behind the face, is never seen
    const positions = header.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = header.getIndices()!;
    let met = 0;
    for (let az = -7; az <= 37; az += 0.5) {
      for (let el = 9; el <= 18; el += 0.1) {
        const d = direction(az, el);
        const hit = firstHitAlong(d);
        if (hit?.pickedMesh !== header) continue;
        met += 1;
        const corner = (k: number) => {
          const i = indices[hit.faceId * 3 + k]! * 3;
          return new Vector3(positions[i]!, positions[i + 1]!, positions[i + 2]!);
        };
        // the drawn side: a drawn face's cross product points INTO the solid
        const into = Vector3.Cross(corner(1).subtract(corner(0)), corner(2).subtract(corner(0)));
        expect(Vector3.Dot(into, d), `the header's face met at (${az}, ${el.toFixed(1)})`).toBeGreaterThan(0);
      }
    }
    expect(met, "rays that met the header").toBeGreaterThan(500);
  });

  it("sinks the header's flat side behind the face everywhere under it: past the face's farthest fall from its chords, tips included", () => {
    const { stations, sunk } = airlinerHeaderStations(skinCaster, frame);
    const interior = named("airliner-cockpit-interior");
    const reference = new Vector3(FLIGHT_DECK_REFERENCE.x, FLIGHT_DECK_REFERENCE.y, FLIGHT_DECK_REFERENCE.z);
    const half = AIRLINER_HEADER.width / 2;
    /** How far out of a station's chord the frame's face lies under `p` on it: R's ray through p, met on the frame. */
    const fallAt = (p: Vector3, out: Vector3) => {
      const d = p.subtract(reference).normalize();
      const hit = scene.pickWithRay(new Ray(reference, d, 5), (mesh) => mesh === interior);
      expect(hit?.hit, `the face under (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).toBe(true);
      return Vector3.Dot(hit!.pickedPoint!.subtract(p), out);
    };
    let fall = 0;
    for (const st of stations) {
      for (let k = 0; k <= 10; k += 1) fall = Math.max(fall, fallAt(st.middle.add(st.up.scale(-half + (2 * half * k) / 10)), st.out));
    }
    for (const [st, sign] of [[stations[0]!, -1], [stations.at(-1)!, 1]] as const) {
      for (let k = 0; k <= 12; k += 1) {
        const psi = (Math.PI * k) / 12;
        const dir = st.up.scale(Math.cos(psi)).add(st.along.scale(sign * Math.sin(psi)));
        for (const r of [0.5, 1]) fall = Math.max(fall, fallAt(st.middle.add(dir.scale(half * r)), st.out));
      }
    }
    console.info(`747 header: the face falls ${(fall * 1000).toFixed(2)} mm behind its chords at most, its flat side ${(sunk * 1000).toFixed(2)} mm`);
    // NON-VACUITY: the face does fall away from the chords, by more than the margin, so the sinking is what hides it
    expect(fall).toBeGreaterThan(AIRLINER_HEADER.bury);
    expect(sunk).toBeGreaterThanOrEqual(fall + 0.002);
  });

  it("stands the overhead's lip on +20 straight across, and where the eye sees the overhead it is inside the skin, its ends and top never in view", () => {
    const lipRow = Math.tan(AIRLINER_OVERHEAD.lipElevationDegrees / DEG);
    let columns = 0;
    for (let az = -37; az <= 37; az += 1) {
      const top = Math.atan(FRAME_V * Math.cos(az / DEG)) * DEG;
      const first = firstHit(az, top - 0.01);
      if (!first || partOf(first.pickedMesh!, first.faceId) !== "airliner-overhead-front") continue;
      columns += 1;
      // down from the frame's top, the overhead to its lip, which is one row of the picture
      let lip = Number.NaN;
      for (let e = top - 0.01; e > 10; e -= 0.01) {
        const hit = firstHit(az, e);
        const part = hit ? partOf(hit.pickedMesh!, hit.faceId) : null;
        if (part === "airliner-overhead-front") {
          // inside the skin: the body's outer skin along the same ray is beyond it
          const skin = crossings(EYE_POINT, direction(az, e), shell).at(-1)!;
          expect(skin - hit!.distance, `the overhead inside the skin at (${az}, ${e.toFixed(2)})`).toBeGreaterThan(0.005);
          // and never an end: its caps face across the flight deck, and the frame's walls stand in front of them
          const n = hit!.getNormal(true, false)!;
          expect(Math.abs(n.z), `an end of the overhead at (${az}, ${e.toFixed(2)})`).toBeLessThan(0.5);
          continue;
        }
        lip = e + 0.01;
        break;
      }
      // where the frame's wall comes down past the lip's row the wall ends the overhead, not its lip
      const expected = Math.atan(lipRow * Math.cos(az / DEG)) * DEG;
      if (Math.abs(lip - expected) > 0.03) {
        const under = firstHit(az, lip - 0.02);
        expect(under && partOf(under.pickedMesh!, under.faceId), `under the overhead at azimuth ${az}, off its lip's row`).toMatch(/crown/);
        expect(lip, `the overhead's end at azimuth ${az}: the wall above its lip's row`).toBeGreaterThan(expected);
      }
    }
    // straight ahead and to the right of it, its lip across the picture
    for (const az of [0, 10, 20, 30]) {
      const expected = Math.atan(lipRow * Math.cos(az / DEG)) * DEG;
      expect(partOf(firstHit(az, expected + 0.03)!.pickedMesh!, firstHit(az, expected + 0.03)!.faceId), `over the lip at ${az}`).toBe("airliner-overhead-front");
      const under = firstHit(az, expected - 0.03);
      expect(under && partOf(under.pickedMesh!, under.faceId), `under the lip at ${az}`).toMatch(/crown/);
    }
    // NON-VACUITY: the overhead is at the frame's top across most of it
    expect(columns).toBeGreaterThan(55);
  });

  it("keeps the overhead's section smooth: no crease the pilot sees on its lip or face", () => {
    const creases = seenCreases([named("airliner-overhead-front")], 30);
    expect(creases.map((c) => `(${c.az.toFixed(2)}, ${c.el.toFixed(2)}) ${c.dihedral.toFixed(1)} deg`), "a crease on the overhead").toEqual([]);
    // CONTROL: the instrument sees the square frames round the screens, on the same material
    expect(seenCreases([named("airliner-screen-bezels")], 30).length).toBeGreaterThan(10);
  });
});

describe("the fuselage's forward end cap", () => {
  /**
   * Babylon's picking ignores back-face culling, so this works on the shell's own triangles and calibrates which
   * winding the ENGINE calls front-facing on a closed convex prism: the sign for which a ray from outside meets a
   * front face and a ray from inside meets none. The prism is the pilot's PFD screen box, one `build.box`, closed
   * and convex, wound by Babylon, and one the pilot plainly sees.
   */
  function calibrate(): number {
    const screens = named("airliner-screens");
    const all = worldTriangles(screens);
    const indices = screens.getIndices()!;
    const prism = all.filter((_, t) => [0, 1, 2].every((k) => indices[t * 3 + k]! < 24));
    expect(prism, "the PFD screen box's own triangles").toHaveLength(12);
    const box = worldVertices(screens).slice(0, 24);
    const centre = box.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / 24);
    const forward = new Vector3(1, 0, 0);
    const front = (origin: Vector3, sign: number) =>
      prism.some((t) => {
        if (!Number.isFinite(crossings(origin, forward, [t])[0] ?? Number.NaN)) return false;
        const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
        return sign * Vector3.Dot(n, forward) < 0;
      });
    const outside = centre.add(new Vector3(-0.3, 0, 0));
    for (const sign of [1, -1]) if (front(outside, sign) && !front(centre, sign)) return sign;
    return 0;
  }

  it("stands between the eye and the glass at x 30.80, wound outward: it faces the nose, not the pilot", () => {
    const sign = calibrate();
    expect(sign, "the culling calibration found a sign").not.toBe(0);
    // planar x-facing polygons of the shell, grouped by x
    const caps = new Map<string, { x: number; triangles: Triangle[]; area: number }>();
    for (const t of shell) {
      const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
      const area = n.length() / 2;
      if (area < 1e-9 || Math.abs(n.x) / n.length() < 0.999) continue;
      const x = (t.a.x + t.b.x + t.c.x) / 3;
      const key = x.toFixed(3);
      const entry = caps.get(key) ?? { x, triangles: [], area: 0 };
      entry.triangles.push(t);
      entry.area += area;
      caps.set(key, entry);
    }
    const found = [...caps.values()].filter((cap) => cap.area > 0.05).sort((a, b) => a.x - b.x);
    // NON-VACUITY, and the station: the caps of the two lofts, of 28 triangles each; the fuselage's forward one at
    // 30.8 since the crease join. Three since the nose polish (2026-09-23): the radome closes on a pole at x 34, so
    // there is no flat cap there to find.
    expect(found.map((cap) => Number(cap.x.toFixed(1)))).toEqual([-26, 25.5, 30.8]);
    for (const cap of found) expect(cap.triangles).toHaveLength(28);
    const centreOfCap = (cap: (typeof found)[number]) => cap.triangles.flatMap((t) => [t.a, t.b, t.c]).reduce((s, v) => s.add(v), Vector3.Zero()).scale(1 / (cap.triangles.length * 3));
    const facesViewer = (cap: (typeof found)[number], from: Vector3, toward: Vector3) => {
      const d = toward.subtract(from).normalize();
      const t = cap.triangles[0]!;
      return sign * Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), d) < 0;
    };
    const forwardCap = found.find((c) => Math.abs(c.x - 30.8) < 0.01)!;
    // BETWEEN the eye and the glass: a sightline straight ahead crosses it (a ray cast meets a face whichever way it
    // faces, which is how it read as "facing the pilot" at first), and only the winding says whether the GPU draws it
    expect(forwardCap.x).toBeGreaterThan(EYE.forward);
    expect(forwardCap.x).toBeLessThan(Math.min(...Object.values(PORT_PANE_CORNERS.one).map((c) => c.inner[0])));
    expect(crossings(EYE_POINT, direction(0, 5), forwardCap.triangles).length, "straight ahead crosses the cap").toBe(1);
    // wound outward, facing the nose: culled from the seat, as every cap ahead of the eye is
    for (const cap of found.filter((c) => c.x > EYE.forward)) {
      expect(facesViewer(cap, EYE_POINT, centreOfCap(cap)), `the cap at x ${cap.x.toFixed(1)} faces the pilot`).toBe(false);
    }
    // and it is in the shell the cockpit camera does not draw anyway: straight ahead the pilot sees through it
    expect((named("airliner-fuselage-shell").layerMask & camera.layerMask) === 0).toBe(true);
    expect(firstHit(0, 5)).toBeNull();
    // the radome's rear cap is 4.4 m behind the pilot; the predicate can say yes from behind it
    const radomeRear = found.find((c) => Math.abs(c.x - 25.5) < 0.01)!;
    expect(facesViewer(radomeRear, new Vector3(20, radomeRear.triangles[0]!.a.y, 0), centreOfCap(radomeRear))).toBe(true);
    expect(EYE.forward - radomeRear.x).toBeGreaterThan(4);
  });
});

describe("the panel", () => {
  it("stands under a glareshield 0.85 m ahead of the eye, its face at the cove's foot, leaned back, down past the frame", () => {
    // the glareshield's aft face at the top of the type's range, chosen for the rows of screen it buys over 0.75
    expect(airlinerPanelFaceX() - EYE.forward).toBeCloseTo(0.85, 12);
    const face = airlinerPanelFace();
    const section = airlinerGlareshieldSection();
    // the board's top edge is where P1a's cove came down to it; the glareshield's aft face stands `overhang` aft of it (S3)
    expect(face.top).toEqual(airlinerBoardTop());
    expect(face.top.x - airlinerPanelFaceX(), "the old cove's run").toBeCloseTo(AIRLINER_BOARD_EDGE.cove, 12);
    expect(airlinerPanelFaceX() - section.aftX, "the overhang").toBeCloseTo(AIRLINER_GLARESHIELD.overhang, 12);
    // the board where it runs straight across between the pilots (it turns aft to the sides, S4)
    const across = Math.max(...airlinerDeckPath().filter((st) => st.forward.x === 1).map((st) => Math.abs(st.z)));
    const board = worldVertices(named("airliner-cockpit-interior")).slice(0, boardVertices()).filter((v) => Math.abs(v.z) <= across + 1e-9);
    const out = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y;
    const planes = [...new Set(board.map((v) => (out(v) + 0).toFixed(5)))].map((d) => Number(d) + 0).sort((a, b) => a - b);
    expect(planes.length, "the board's face and its back").toBe(2);
    expect(planes[1]!, "the face through the cove's foot").toBeCloseTo(0, 5);
    expect(planes[1]! - planes[0]!, "the back square to it").toBeCloseTo(AIRLINER_PANEL.thickness, 5);
    expect(Math.max(...board.map((v) => v.y)), "the board's top at the old cove's foot").toBeCloseTo(face.top.y, 5);
    // its face's foot is below the frame's bottom (the frame's bottom row, v = -FRAME_V)
    const inFace = board.filter((v) => Math.abs(out(v)) < 2e-6);
    const foot = inFace.reduce((a, b) => (a.y < b.y ? a : b));
    expect((foot.y - EYE.up) / (foot.x - EYE.forward)).toBeLessThan(-FRAME_V);
  });

  it("leans back 17 degrees and faces the pilot: its normal within 8 degrees of the eye from the PFD's centre", () => {
    expect(AIRLINER_PANEL.leanDegrees).toBe(17);
    const face = airlinerPanelFace();
    const normal = new Vector3(face.normal.x, face.normal.y, 0);
    const pfd = airlinerScreenPlacements()[0]!.centre;
    const off = Math.acos(Vector3.Dot(normal, EYE_POINT.subtract(pfd).normalize())) * DEG;
    console.info(`747 panel: leaned ${AIRLINER_PANEL.leanDegrees}; its normal ${off.toFixed(2)} degrees off the eye at the PFD's centre`);
    expect(off).toBeLessThanOrEqual(8);
    // CONTROL: the upright board K3 had reads far off
    expect(Math.acos(Vector3.Dot(new Vector3(-1, 0, 0), EYE_POINT.subtract(pfd).normalize())) * DEG).toBeGreaterThan(20);
  });

  it("pads the glareshield's nose on the deck line, its strip and its under-round the design's, and a hood that clears the shell untapered (S3)", () => {
    const g = AIRLINER_GLARESHIELD;
    expect([g.noseRadius, g.stripDegrees, g.underRadius, g.overhang]).toEqual([0.01, 0.7, 0.008, 0.025]);
    expect(g.hoodFallDegrees, "the hood falls faster than the sight line").toBeGreaterThan(-g.lipElevationDegrees);
    const section = airlinerGlareshieldSection();
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    // the strip is `stripDegrees` from the eye, from the nose's tangent to the under-round's
    expect(el({ x: section.aftX, y: section.stripTop }) - el({ x: section.aftX, y: section.stripBottom })).toBeCloseTo(g.stripDegrees, 9);
    console.info(`747 glareshield straight ahead: the nose ${(el(section.tangent) - el({ x: section.aftX, y: section.stripTop })).toFixed(3)} degrees, the strip ${g.stripDegrees}`);
    // every vertex of the glareshield, the hood's forward end included, 5 cm inside the built shell at its own station
    for (const v of worldVertices(named("airliner-glareshield"))) {
      const wall = crossings(new Vector3(v.x, v.y, 0), new Vector3(0, 0, v.z < 0 ? -1 : 1), shell).at(-1)!;
      expect(wall - Math.abs(v.z), `(${v.x.toFixed(3)}, ${v.y.toFixed(3)})`).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("fills the frame under the deck line with the deck where it runs across, and beside its turn with the side's frame or its glass (S4)", () => {
    // P1c's rule was the deck edge to edge: the board ran past both edges of the frame. It turns aft now (S4), from az -15
    // from the seat, and a turned deck comes toward the pilot and reads lower: outboard of the turn's start the frame's
    // sill (the side wall under No.2) shows between the lowered deck and the lip's row, and at the frame's edge No.2's
    // lower corner, the glass the flat board hid. So: inboard of the turn, every ray from the frame's bottom row up to a
    // tenth of a degree under the lip's row meets the deck (the board, the glareshield, a screen, its bezel); outboard of
    // it, the deck, the frame or, where nothing is drawn, the glass (never hidden skin).
    const DECK = new Set(["airliner-instrument-panel", "airliner-glareshield"]);
    const lipRow = Math.tan(AIRLINER_GLARESHIELD.lipElevationDegrees / DEG);
    const turnAt = -AIRLINER_DECK_WRAP.startAzimuthDegrees;
    let rays = 0;
    let beside = 0;
    let glass = 0;
    for (let i = 0; i <= 40; i += 1) {
      const u = -FRAME_U + (2 * FRAME_U * i) / 40;
      const az = Math.atan(u) * DEG;
      for (let j = 0; j <= 12; j += 1) {
        const v = -FRAME_V + ((lipRow - 0.002 + FRAME_V) * j) / 12;
        const d = new Vector3(1, v, u).normalize();
        const hit = firstHitAlong(d);
        rays += 1;
        if (!hit) {
          const el = Math.atan2(v, Math.hypot(1, u)) * DEG;
          expect(az, `column ${i}, row ${j}: open inboard of the turn`).toBeLessThan(turnAt);
          expect(exitsThrough(az, el), `column ${i} (az ${az.toFixed(1)}), row ${j}: open onto`).toBe("glass");
          glass += 1;
          continue;
        }
        const part = partOf(hit.pickedMesh!, hit.faceId);
        const deck = DECK.has(part) || /^airliner-(screen|clock|glareshield-)/.test(part);
        if (az > turnAt + 0.5) expect(deck, `column ${i} (az ${az.toFixed(1)}), row ${j}: ${part} under the deck line`).toBe(true);
        else {
          expect(deck || /lining|seal/.test(part), `column ${i} (az ${az.toFixed(1)}), row ${j}: ${part}`).toBe(true);
          if (!deck) beside += 1;
        }
      }
    }
    expect(rays).toBe(41 * 13);
    console.info(`747 beside the deck's turn, under the lip's row: ${beside} of the rays meet the side's frame and ${glass} No.2's glass`);
    expect(beside, "the frame shows beside the turned deck").toBeGreaterThan(0);
    // the turn starts at az -15 from the seat, read at the cove's foot, and the run aft ends out of every lens
    const path = airlinerDeckPath();
    const foot = airlinerBoardTop();
    const seen = (st: { x: number; z: number }) => Math.atan2(st.z - EYE.right, st.x - EYE.forward) * DEG;
    const start = path.find((st) => st.forward.x === 1 && st.z < 0)!;
    expect(start.x).toBeCloseTo(foot.x, 12);
    expect(seen(start)).toBeCloseTo(turnAt, 9);
    expect(seen(path[0]!), "the port run's aft end, past the 21:9 lens's 45.6").toBeLessThan(-60);
  });
});
