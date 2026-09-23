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
import { FLIGHT_DECK_REFERENCE, PANE_PROUD } from "../src/render/webgpu/aircraft/airlinerGlazing";
import { AircraftBuildContext } from "../src/render/webgpu/aircraft/builders";
import {
  AIRLINER_GLARESHIELD,
  AIRLINER_PANEL,
  AIRLINER_POST_HALF_AZIMUTH,
  AIRLINER_SCREENS,
  AIRLINER_SEAT,
  airlinerLipY,
  airlinerPanelFaceX,
} from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
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
 * -18.04 straight ahead, no more than a degree of sill under No.1 anywhere, the deck line at the
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
 * THE CORNER TABLE, copied from `npx tsx scripts/airliner-glazing-table.mts --json` at a480804 (the
 * re-loft and the crease join): the port panes' outer and inner face corners, body metres. The only
 * source of pane geometry; held to the built panes below.
 */
const PORT_PANE_CORNERS = {
  one: {
    bottomInboard: { outer: [32.591, 2.09, -0.119], inner: [32.514, 2.027, -0.111] },
    bottomOutboard: { outer: [32.073, 2.186, -0.982], inner: [32.014, 2.134, -0.92] },
    topOutboard: { outer: [31.254, 3.274, -0.611], inner: [31.212, 3.192, -0.572] },
    topInboard: { outer: [31.512, 3.303, -0.071], inner: [31.461, 3.217, -0.067] },
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
/** One face of a captured skin panel as triangles: what a sightline through it crosses, rims left out. */
function faceTriangles(p: Panel, face: 0 | 1): Triangle[] {
  const out: Triangle[] = [];
  for (let row = 0; row < p.rows - 1; row += 1) {
    for (let column = 0; column < p.columns - 1; column += 1) {
      const v = (r: number, c: number) => gridVertex(p, face, r, c);
      out.push({ a: v(row, column), b: v(row, column + 1), c: v(row + 1, column) });
      out.push({ a: v(row, column + 1), b: v(row + 1, column + 1), c: v(row + 1, column) });
    }
  }
  return out;
}
/** Points along one edge of a captured panel's face, the chords between grid points sampled `per` times. */
function edgePoints(p: Panel, face: 0 | 1, edge: "bottom" | "top" | "inboard" | "outboard", per = 8): Vector3[] {
  const grid: Vector3[] = [];
  if (edge === "bottom" || edge === "top") {
    const row = edge === "bottom" ? 0 : p.rows - 1;
    for (let column = 0; column < p.columns; column += 1) grid.push(gridVertex(p, face, row, column));
  } else {
    const column = edge === "inboard" ? 0 : p.columns - 1;
    for (let row = 0; row < p.rows; row += 1) grid.push(gridVertex(p, face, row, column));
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
/**
 * Which authored part of a merged mesh a picked triangle belongs to (an unmerged mesh is its own part). The kit's
 * merged meshes carry their sources in `mergedFrom`; the lining's triangle counts are the captured panels' own, the
 * boxes' are written here, and the sum is checked against the mesh.
 */
function partOf(mesh: AbstractMesh, faceId: number): string {
  const sources = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom;
  if (!sources) return mesh.name;
  // the lip is a three-sided `solidPlate` (two caps and three walls of two); the board, the screens and the bezels are boxes
  const count = (name: string) => (/^airliner-(instrument-panel|screen)/.test(name) ? 12 : panel(name).triangles);
  const total = sources.reduce((sum, name) => sum + count(name), 0);
  expect(total, `${mesh.name}: its sources' triangles add up to the mesh's`).toBe(mesh.getTotalIndices() / 3);
  let start = 0;
  for (const name of sources) {
    if (faceId < start + count(name)) return name;
    start += count(name);
  }
  throw new Error(`face ${faceId} is beyond ${mesh.name}`);
}
/** The first drawn part along a ray: the mesh, and the authored part of it. */
function firstPart(azimuth: number, elevation: number): string | null {
  const hit = firstHit(azimuth, elevation);
  return hit ? partOf(hit.pickedMesh!, hit.faceId) : null;
}
/**
 * What a sightline from the eye leaves the body through: a pane, the post, or skin. A pane is 0.10 m thick (0.04
 * out of the skin, 0.06 in), so a sightline is THROUGH it when it crosses both its faces, inner and outer; one that
 * meets a face and leaves by the rim is looking at the pane's edge, which is frame. That is the aperture of a thick
 * window seen obliquely, and the lining, the same slab laid round it, frames exactly that.
 */
let slabs: { what: "glass" | "post"; outer: Triangle[]; inner: Triangle[] }[] = [];
function exitsThrough(azimuth: number, elevation: number): "glass" | "post" | "skin" {
  if (slabs.length === 0) {
    slabs = panels
      .filter((p) => /flight-deck-window|windscreen-center-post/.test(p.name))
      .map((p) => ({ what: /post/.test(p.name) ? "post" as const : "glass" as const, outer: faceTriangles(p, 0), inner: faceTriangles(p, 1) }));
    expect(slabs, "six panes and the post").toHaveLength(7);
  }
  const d = direction(azimuth, elevation);
  for (const slab of slabs) {
    if (crossings(EYE_POINT, d, slab.inner).length > 0 && crossings(EYE_POINT, d, slab.outer).length > 0) return slab.what;
  }
  return "skin";
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
    // K0: No.1 -8.8..+11.6, the pillar -10.7..-8.9, the post +13.1..+14.8, the opening 30.4, the glass 1.90
    expect(glass.aheadInMiddleThird, "straight ahead in the middle third of No.1").toBe(true);
    expect(glass.one.from).toBeCloseTo(-8.8, 0);
    expect(glass.one.to).toBeCloseTo(11.6, 0);
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

  it("has the centre post over R's +-AIRLINER_POST_HALF_AZIMUTH, which the kit's gap lining meets", () => {
    const post = panel("airliner-windscreen-center-post");
    expect(post.columns, "the post is a strip two grid points wide").toBe(2);
    const R = new Vector3(FLIGHT_DECK_REFERENCE.x, FLIGHT_DECK_REFERENCE.y, FLIGHT_DECK_REFERENCE.z);
    for (let row = 0; row < post.rows; row += 1) {
      for (const column of [0, 1]) {
        // the SKIN point is between the faces, 0.04 of the 0.10 in from the outer one
        const skinPoint = Vector3.Lerp(gridVertex(post, 0, row, column), gridVertex(post, 1, row, column), 0.4);
        const d = skinPoint.subtract(R);
        expect(Math.abs(Math.atan2(d.z, d.x) * DEG)).toBeCloseTo(AIRLINER_POST_HALF_AZIMUTH, 1);
      }
    }
  });
});

describe("the 747's cockpit parts", () => {
  const SILLS = ["airliner-lining-sill-centre", "port-airliner-lining-sill-two", "starboard-airliner-lining-sill-two", "port-airliner-lining-sill-three", "starboard-airliner-lining-sill-three"];
  // the board, then the lining in the order it is cast: the sill and the crown across the centreline, then a side each
  const INTERIOR = [
    "airliner-instrument-panel",
    "airliner-lining-sill-centre", "airliner-lining-crown-centre",
    "port-airliner-lining-post-gap", "starboard-airliner-lining-post-gap",
    "port-airliner-lining-pillar-one-two", "starboard-airliner-lining-pillar-one-two",
    "port-airliner-lining-sill-two", "starboard-airliner-lining-sill-two",
    "port-airliner-lining-crown-two", "starboard-airliner-lining-crown-two",
    "port-airliner-lining-pillar-two-three", "starboard-airliner-lining-pillar-two-three",
    "port-airliner-lining-sill-three", "starboard-airliner-lining-sill-three",
    "port-airliner-lining-crown-three", "starboard-airliner-lining-crown-three",
  ];

  it("are the four named cockpit-only meshes, thirty authored parts, and nothing else new", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual([
      "airliner-cockpit-interior", "airliner-glareshield", "airliner-screen-bezels", "airliner-screens",
    ]);
    // the lip alone; the board and the sixteen lining strips; six screens; six bezels
    expect((named("airliner-glareshield").metadata as { mergedFrom?: string[] }).mergedFrom, "the glareshield is the lip, unmerged").toBeUndefined();
    expect((named("airliner-cockpit-interior").metadata as { mergedFrom: string[] }).mergedFrom).toEqual(INTERIOR);
    const sources = cockpitOnly.flatMap((part) => (part.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [part.name]);
    expect(sources).toHaveLength(6 + 12 + 6 + 6);
    // the old kit's parts are gone: the hood, the dash, the overhead, the pillar plate and the seam post
    for (const gone of ["airliner-hood", "airliner-dash", "airliner-overhead", "airliner-windscreen-pillar", "airliner-windscreen-post-port"]) {
      expect(sources, gone).not.toContain(gone);
    }
    for (const part of cockpitOnly) {
      expect((part.metadata as { cockpitOnly?: boolean }).cockpitOnly, part.name).toBe(true);
      expect((part.metadata as { castsShadow?: boolean }).castsShadow, `${part.name} must never cast`).toBe(false);
    }
  });

  it("put the lip alone on the glareshield's own matte material, and the board and the whole window frame, sills included, on the flight deck's interior one", () => {
    const glare = named("airliner-glareshield");
    const interior = named("airliner-cockpit-interior");
    expect(interior.material, "the two draw states differ").not.toBe(glare.material);
    // THE SILLS ARE FRAME: in the interior mesh, on its material, with the crown and the pillars; the glareshield is the
    // lip's wedge alone (8 triangles, 24 vertices), the deck line's one straight row
    const frame = (interior.metadata as { mergedFrom: string[] }).mergedFrom;
    for (const sill of SILLS) expect(frame, `${sill} is window frame`).toContain(sill);
    expect(glare.getTotalIndices() / 3).toBe(8);
    expect(glare.getTotalVertices()).toBe(24);
    expect((glare.material as PBRMaterial).metallicF0Factor, "the glareshield reflects nothing").toBe(0);
    expect((glare.material as PBRMaterial).environmentIntensity, "the glareshield is lit by the sky").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect((interior.material as PBRMaterial).environmentIntensity, "the interior's material is lit by the sky").toBeGreaterThan(0);
    expect(interior.material, "the airframe's interior material").toBe(named("airliner-flight-deck-interior").material);
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
      expect(parts).toHaveLength(4);
      for (const part of parts) expect(part.isVisible, `${part.name} outside cockpit view`).toBe(false);
      visual.setCockpitView(true);
      for (const part of parts) expect(part.isVisible, `${part.name} in cockpit view`).toBe(true);
    } finally {
      visual.dispose();
      freshScene.dispose();
      fresh.dispose();
    }
  });

  it("hide the shell and the GLAZING from the cockpit camera, and nothing else: the centre post is drawn", () => {
    expect([...aircraft.cockpitParts].map((part) => part.name).sort()).toEqual(["airliner-flight-deck-glazing", "airliner-fuselage-shell"]);
    for (const mesh of aircraft.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(aircraft.cockpitParts.includes(mesh));
    }
    const glass = named("airliner-flight-deck-glazing").material as PBRMaterial;
    expect(glass.subSurface.isRefractionEnabled, "the glazing's material refracts").toBe(true);
    expect(drawnByCockpitCamera(named("airliner-windscreen-center-post")), "the post").toBe(true);
  });
});

describe("the centre post", () => {
  it("is drawn from the seat: a ray at the middle of its inner face meets it 2.0 m away, on a face the GPU draws, shaded toward the eye", () => {
    const post = panel("airliner-windscreen-center-post");
    const middle = Math.floor(post.rows / 2);
    const target = Vector3.Lerp(gridVertex(post, 1, middle, 0), gridVertex(post, 1, middle, 1), 0.5);
    const d = target.subtract(EYE_POINT).normalize();
    const hit = firstHitAlong(d);
    expect(hit?.pickedMesh?.name).toBe("airliner-windscreen-center-post");
    expect(hit!.distance).toBeCloseTo(Vector3.Distance(target, EYE_POINT), 2);
    // 2.02 m: the post is a strip across the nose's crown, further than the glass straight ahead (1.90)
    expect(hit!.distance).toBeGreaterThan(1.9);
    expect(hit!.distance).toBeLessThan(2.1);
    // the GPU's rule: a drawn face's cross product points INTO the solid, along the ray
    const mesh = named("airliner-windscreen-center-post");
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
    // CONTROL: with the post hidden, the same ray passes to the opening: nothing the cockpit camera draws is behind it
    mesh.isVisible = false;
    try {
      expect(firstHitAlong(d)).toBeNull();
    } finally {
      mesh.isVisible = true;
    }
  });
});

describe("what the pilot sees straight ahead", () => {
  it("has the glareshield's lip at -18.04, and no more than a degree of sill under No.1 anywhere along its bottom edge", () => {
    const lip = worldVertices(named("airliner-glareshield")).slice(0, 24);
    const aftTop = lip.filter((v) => Math.abs(v.x - airlinerPanelFaceX()) < 1e-6 && Math.abs(v.y - airlinerLipY()) < 1e-6);
    expect(aftTop.length, "the lip's aft top edge").toBeGreaterThanOrEqual(2);
    expect(Math.max(...lip.map((v) => v.y)), "nothing of the lip is higher than its aft top edge").toBeCloseTo(airlinerLipY(), 6);
    expect(Math.min(...lip.map((v) => v.x)), "and nothing of it is aft of the face: flush").toBeCloseTo(airlinerPanelFaceX(), 6);
    expect(Math.atan2(airlinerLipY() - EYE.up, airlinerPanelFaceX() - EYE.forward) * DEG).toBeCloseTo(AIRLINER_GLARESHIELD.lipElevationDegrees, 6);
    // the sill: No.1's OUTER bottom edge (the aperture's bottom, seen from inside) less the lip, along the edge
    const sills = edgePoints(panel("port-airliner-flight-deck-window-one"), 0, "bottom").map((p) => {
      const { az, el } = azel(p);
      return el - lipElevation(az);
    });
    console.info(`747 sill under No.1: ${Math.min(...sills).toFixed(2)}..${Math.max(...sills).toFixed(2)} degrees`);
    expect(Math.max(...sills), "no more than a degree of sill").toBeLessThanOrEqual(1.0);
    // and it is the LOWEST such lip: the sill reaches the degree somewhere (the inboard end)
    expect(Math.max(...sills)).toBeGreaterThan(0.95);
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
    // ABOVE IT, THE SILL: window frame, the interior mesh, from the lip up to No.1's outer bottom edge (-17.32)
    const bottom = edgePoints(panel("port-airliner-flight-deck-window-one"), 0, "bottom", 40).map((p) => azel(p));
    const i = bottom.findIndex((q, k) => k > 0 && Math.sign(q.az) !== Math.sign(bottom[k - 1]!.az));
    const glassAhead = bottom[i - 1]!.el + ((bottom[i]!.el - bottom[i - 1]!.el) * (0 - bottom[i - 1]!.az)) / (bottom[i]!.az - bottom[i - 1]!.az);
    expect(glassAhead - ahead, "the band of sill straight ahead, degrees").toBeGreaterThan(0.5);
    let band = 0;
    for (let e = ahead + 0.05; e < glassAhead - 0.05; e += 0.05) {
      const hit = firstHit(0, e);
      expect(hit?.pickedMesh?.name, `the sill at ${e.toFixed(2)}`).toBe("airliner-cockpit-interior");
      expect(partOf(hit!.pickedMesh!, hit!.faceId)).toBe("airliner-lining-sill-centre");
      band += 1;
    }
    expect(band).toBeGreaterThan(8);
    // and just over No.1's bottom edge, the glass: nothing drawn
    expect(firstHit(0, glassAhead + 0.1)).toBeNull();
  });

  it("frames every edge of the glass the pilot sees with the kit: no hidden skin shows beside any pane or the post", () => {
    // 0.3 degrees outside each edge, from the face the aperture is bounded by on that side (the outer face at the
    // bottom and the sides, the inner face at the top), the cockpit camera draws the frame; 0.3 inside, it draws nothing.
    const cases: { pane: string; edge: "bottom" | "top" | "inboard" | "outboard"; face: 0 | 1; out: [number, number]; frame: RegExp }[] = [];
    for (const side of ["port", "starboard"] as const) {
      const outboard = side === "port" ? -1 : 1;
      for (const pane of ["one", "two"] as const) {
        const name = `${side}-airliner-flight-deck-window-${pane}`;
        cases.push({ pane: name, edge: "bottom", face: 0, out: [0, -1], frame: /^airliner-glareshield$|sill/ });
        cases.push({ pane: name, edge: "top", face: 1, out: [0, 1], frame: /crown/ });
        cases.push({ pane: name, edge: "inboard", face: 0, out: [-outboard, 0], frame: pane === "one" ? /post-gap/ : /pillar-one-two/ });
        cases.push({ pane: name, edge: "outboard", face: 0, out: [outboard, 0], frame: pane === "one" ? /pillar-one-two/ : /pillar-two-three/ });
      }
    }
    const post = panel("airliner-windscreen-center-post");
    let framed = 0;
    for (const c of cases) {
      const points = edgePoints(panel(c.pane), c.face, c.edge, 3);
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
    // and each edge of the post meets the gap lining, 0.3 degrees beyond the post as the pilot sees it: the strip is
    // seen from 14 degrees off, so one of its rims shows, and its edge is whichever face's reads further out
    for (let row = 1; row < post.rows - 1; row += 1) {
      const azimuths = [0, 1].flatMap((column) => ([0, 1] as const).map((face) => azel(gridVertex(post, face, row, column))));
      const el = azimuths.reduce((sum, a) => sum + a.el, 0) / 4;
      for (const az of [Math.min(...azimuths.map((a) => a.az)) - 0.3, Math.max(...azimuths.map((a) => a.az)) + 0.3]) {
        if (el < lipElevation(az)) continue;
        expect(firstPart(az, el), `beside the post at (${az.toFixed(1)}, ${el.toFixed(1)})`).toMatch(/post-gap/);
        framed += 1;
      }
    }
    // NON-VACUITY: many samples of every kind of edge were in the frame
    expect(framed).toBeGreaterThan(150);
  });

  it("puts the crown lining over the glass at -20, 0 and +20: from the opening's top to the frame's, the first drawn surface is the crown, inside the skin", () => {
    const interior = named("airliner-cockpit-interior");
    for (const az of [-20, 0, 20]) {
      const top = Math.atan(FRAME_V * Math.cos(az / DEG)) * DEG;
      // the opening's top edge: scanning down, the first elevation the crown does not cover
      let opening = Number.NaN;
      for (let e = top; e >= -10; e -= 0.02) {
        if (!/crown/.test(firstPart(az, e) ?? "")) {
          opening = e;
          break;
        }
      }
      expect(opening, `the opening's top at azimuth ${az}`).toBeGreaterThan(8);
      expect(opening).toBeLessThan(13);
      expect(exitsThrough(az, opening - 0.5), `glass just under the crown at azimuth ${az}`).toBe("glass");
      for (let e = opening + 0.05; e <= top; e += 0.25) {
        const hit = firstHit(az, e);
        expect(hit?.pickedMesh, `the crown at azimuth ${az}, elevation ${e.toFixed(2)}`).toBe(interior);
        expect(partOf(hit!.pickedMesh!, hit!.faceId)).toMatch(/crown/);
        // UNDER the skin, never the shell: the body's outer skin along the same ray is beyond it
        const d = direction(az, e);
        const skin = crossings(EYE_POINT, d, shell).at(-1)!;
        expect(skin - hit!.distance, `the crown stands inside the skin at azimuth ${az}, elevation ${e.toFixed(2)}`).toBeGreaterThan(0.02);
      }
    }
    // CONTROL: without the interior mesh those rays meet nothing the cockpit camera draws; the crown is what covers them
    interior.isVisible = false;
    try {
      expect(firstHit(0, 18)).toBeNull();
    } finally {
      interior.isVisible = true;
    }
  });

  it("has a hole in the picture only where there is glass, and covers glass only at the lip and a pane's own edges", () => {
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
    // an edge: within a third of a degree of another kind of exit (the chords of the lining and of the pane beside it
    // are sampled at different points along their shared edge, which is where they differ)
    const nearEdge = (az: number, el: number, what: string) =>
      [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].some(([da, de]) => exit(az + da!, el + de!) !== what);
    for (let az = -37.5 + 0.37; az <= 37.5; az += 1) {
      for (let el = -24 + 0.37; el <= 24; el += 1) {
        if (!inFrame(az, el)) continue;
        const what = exit(az, el);
        const hit = firstHit(az, el);
        if (hit) solid += 1;
        else open += 1;
        if (!hit && what !== "glass" && !nearEdge(az, el, what)) skinShowing.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) ${what}`);
        if (hit && what === "glass" && el > lipElevation(az) + 0.1 && !nearEdge(az, el, what)) glassCovered.push(`(${az.toFixed(2)}, ${el.toFixed(2)}) by ${hit.pickedMesh!.name}`);
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
  const bezelBlock = (k: number) => worldVertices(named("airliner-screen-bezels")).slice(k * 24, k * 24 + 24);
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
    // the centre pair on the centreline, the lower EICAS straight under the upper
    expect(upper.z).toBeCloseTo(0, 6);
    expect(lower.z).toBeCloseTo(0, 6);
    expect(upper.y - lower.y).toBeCloseTo(AIRLINER_SCREENS.height + AIRLINER_SCREENS.bezel * 2 + AIRLINER_SCREENS.rowGap, 6);
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

  it("hang the top row 0.25 degrees under the glareshield's underside at the face", () => {
    const top = Math.max(...screenBlock(0).map((v) => v.y));
    const front = Math.min(...screenBlock(0).map((v) => v.x));
    const underside = Math.atan2(airlinerLipY() - AIRLINER_GLARESHIELD.thickness - EYE.up, airlinerPanelFaceX() - EYE.forward) * DEG;
    expect(Math.atan2(top - EYE.up, front - EYE.forward) * DEG).toBeCloseTo(underside - AIRLINER_SCREENS.belowGlareshieldDegrees, 4);
  });

  it("show at least 35% of the pilot's PFD, the ND and the upper EICAS in the 16:9 frame, and nothing of the lower one", () => {
    // Over a 21 x 21 grid of each screen's pilot-facing face: in the frame's rectangle, and the first thing the
    // cockpit camera draws along the ray is that screen, where the face is.
    const screens = named("airliner-screens");
    const names = (screens.metadata as { mergedFrom: string[] }).mergedFrom;
    const fractions: Record<string, number> = {};
    for (const [k, name] of names.entries()) {
      const block = screenBlock(k);
      const x = Math.min(...block.map((v) => v.x));
      const [y0, y1] = [Math.min(...block.map((v) => v.y)), Math.max(...block.map((v) => v.y))];
      const [z0, z1] = [Math.min(...block.map((v) => v.z)), Math.max(...block.map((v) => v.z))];
      let seen = 0;
      let total = 0;
      for (let i = 0; i <= 20; i += 1) {
        for (let j = 0; j <= 20; j += 1) {
          const p = new Vector3(x, y0 + ((y1 - y0) * (i + 0.5)) / 21, z0 + ((z1 - z0) * (j + 0.5)) / 21);
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
    // the floor is 35%; the build gives 43.5% exactly (42.9% on this grid), and a panel back at 0.75 m would give 36.8%
    for (const name of ["port-pfd", "port-nd", "port-eicas"]) {
      expect(fractions[name], `${name} in the frame`).toBeGreaterThanOrEqual(0.35);
      expect(fractions[name], `${name} as built`).toBeGreaterThan(0.42);
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

  it("keeps the board, the lip, the screens and the bezels inside the outer skin with clearance to spare", () => {
    const lines: string[] = [];
    const parts: [string, Vector3[]][] = [
      ["panel board", worldVertices(named("airliner-cockpit-interior")).slice(0, 24)],
      ["glareshield lip", worldVertices(named("airliner-glareshield")).slice(0, 24)],
      ["screens", worldVertices(named("airliner-screens"))],
      ["bezels", worldVertices(named("airliner-screen-bezels"))],
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
    // the board and the lip stand aft of the fuselage loft's forward cap, which is hidden: nothing of them is ahead of x 30.80
    expect(Math.max(...parts[0]![1].map((v) => v.x), ...parts[1]![1].map((v) => v.x))).toBeLessThan(30.8);
    console.info(`747 cockpit clearance from the shell's outer skin:\n  ${lines.join("\n  ")}`);
  });

  it("is watertight: wherever two pieces of the frame meet, they meet at the same points (no T-junction)", () => {
    // Two strips that meet on the curved skin at DIFFERENT points each span the seam with their own chords, which part
    // by a fraction of a millimetre, and the hidden sky shows through as a bright hairline: K2's first live frame had
    // them along the crown's seams. So along every seam between two frame pieces (the lining's strips and the post),
    // each inner-face boundary vertex of one that lies within a centimetre of the other's boundary is one of the
    // other's boundary vertices, to the last bit. (A T-junction vertex lies about half a millimetre off the chord.)
    const frame = panels.filter((p) => /lining|windscreen-center-post/.test(p.name));
    expect(frame.length, "sixteen lining strips and the post").toBe(17);
    const boundary = (p: Panel) => {
      const loop: Vector3[] = [];
      for (let c = 0; c < p.columns; c += 1) loop.push(gridVertex(p, 1, 0, c));
      for (let r = 1; r < p.rows; r += 1) loop.push(gridVertex(p, 1, r, p.columns - 1));
      for (let c = p.columns - 2; c >= 0; c -= 1) loop.push(gridVertex(p, 1, p.rows - 1, c));
      for (let r = p.rows - 2; r >= 1; r -= 1) loop.push(gridVertex(p, 1, r, 0));
      return loop;
    };
    const loops = frame.map((p) => ({ name: p.name, loop: boundary(p) }));
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
        for (const v of one.loop) {
          let near = Number.POSITIVE_INFINITY;
          for (let k = 0; k < other.loop.length; k += 1) near = Math.min(near, toSegment(v, other.loop[k]!, other.loop[(k + 1) % other.loop.length]!));
          if (near > 0.01) continue;
          seamVertices += 1;
          if (!other.loop.some((w) => Vector3.Distance(v, w) < 1e-9)) {
            junctions.push(`${one.name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) on ${other.name}'s edge, ${(near * 1000).toFixed(2)} mm off it`);
          }
        }
      }
    }
    expect(junctions.slice(0, 8), `${junctions.length} T-junctions`).toEqual([]);
    // NON-VACUITY: the seams were found (every strip meets at least one other along an edge)
    expect(seamVertices).toBeGreaterThan(150);
  });

  it("lines the skin from inside: where the pilot sees the lining's face it stands inside the outer skin, and its rim no further out than the glass", () => {
    // The lining is the panes' own slab, 0.04 out of the skin and 0.06 in. Its INNER face is what lines the deck;
    // where a sightline meets its rim instead, at a pane's edge, the rim stands out of the skin as the pane's does.
    let face = 0;
    let rim = 0;
    let tightestFace = Number.POSITIVE_INFINITY;
    let farthestRim = Number.POSITIVE_INFINITY;
    let shadedAway = 0;
    for (let az = -37 + 0.61; az <= 37; az += 1) {
      for (let el = -23 + 0.61; el <= 23; el += 1) {
        if (!inFrame(az, el)) continue;
        const hit = firstHit(az, el);
        const part = hit ? partOf(hit.pickedMesh!, hit.faceId) : "";
        if (!/lining/.test(part)) continue;
        const d = direction(az, el);
        const skin = crossings(EYE_POINT, d, shell).at(-1)!;
        const onFace = crossings(EYE_POINT, d, faceTriangles(panel(part), 1)).some((t) => Math.abs(t - hit!.distance) < 1e-4);
        if (onFace) {
          face += 1;
          tightestFace = Math.min(tightestFace, skin - hit!.distance);
          // SHADED toward the cabin: a skin panel's faces share vertices, so their normals are smooth and the drawn-faces
          // test's flat-normal guard does not see them. Every vertex of the face met must be lit from the pilot's side.
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
    console.info(`747 lining: ${face} rays on its inner face, the tightest ${tightestFace.toFixed(4)} m inside the skin; ${rim} on its rims, the farthest ${(-farthestRim).toFixed(4)} m outside`);
    expect(face).toBeGreaterThan(300);
    expect(rim, "the rims are the frame's depth at the panes' edges, a small part of what shows").toBeLessThan(face / 5);
    expect(tightestFace).toBeGreaterThan(0.02);
    expect(shadedAway, "lining vertices shaded away from the eye").toBe(0);
    // seen along a slanting sightline, a rim 0.04 proud of the skin can read up to about 0.07 outside it
    expect(farthestRim).toBeGreaterThan(-(PANE_PROUD * 2));
  });

  it("puts nothing in the frame that the design did not account for: the kit and the centre post", () => {
    const allowed = new Set([
      "airliner-cockpit-interior", "airliner-glareshield", "airliner-screens", "airliner-screen-bezels", "airliner-windscreen-center-post",
    ]);
    for (let az = -37; az <= 37; az += 2) {
      for (let el = -23; el <= 23; el += 1) {
        const hit = firstHit(az, el);
        if (hit) expect(allowed.has(hit.pickedMesh!.name), `${hit.pickedMesh!.name} at azimuth ${az}, elevation ${el}`).toBe(true);
      }
    }
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
    // NON-VACUITY, and the station: the four caps of the two lofts, of 28 triangles each; the fuselage's forward one
    // at 30.8 since the crease join
    expect(found.map((cap) => Number(cap.x.toFixed(1)))).toEqual([-26, 25.5, 30.8, 34]);
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
  it("stands 0.85 m ahead of the eye, flush with the lip, below the frame", () => {
    const board = worldVertices(named("airliner-cockpit-interior")).slice(0, 24);
    // the top of the type's range, chosen for the rows of screen it buys over 0.75
    expect(Math.min(...board.map((v) => v.x)) - EYE.forward).toBeCloseTo(0.85, 6);
    expect(Math.max(...board.map((v) => v.y))).toBeCloseTo(airlinerLipY() - AIRLINER_GLARESHIELD.thickness, 6);
    // its bottom is below the frame's bottom in its plane
    const frameBottom = EYE.up - FRAME_V * AIRLINER_PANEL.faceAheadOfEye;
    expect(Math.min(...board.map((v) => v.y))).toBeLessThan(frameBottom - 0.1);
  });
});
