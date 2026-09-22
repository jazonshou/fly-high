import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crossings, distanceToTriangles, hitTriangle, worldTriangles, type Triangle } from "../scripts/rayCrossings.mts";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  AIRLINER_GLAZING,
  AIRLINER_PANEL,
  AIRLINER_POST,
  AIRLINER_SEAT,
  airlinerHoodTopY,
  airlinerOverheadPlan,
  airlinerOverheadUndersideY,
  airlinerPanelFaceX,
  airlinerSeamPostEndpoints,
} from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";

/**
 * The 747-8's cockpit, held to the angles it was built to and to the shell it
 * stands in.
 *
 * The EYE is the one `scripts/airliner-eye-solve.mts` found, and it is checked
 * here against the BUILT glazing, not against the solver: (29.90, 2.93, -0.72),
 * the port seat's line, where the port No.1 pane, the only glass straight ahead,
 * reads +9.64 above and -9.39 below the horizon (T 9.39), 0.558 m away, with 0.474
 * m of skin overhead. Everything else is built AROUND it, and asserted as angles
 * from it: the hood's far edge -10 (+-0.1), the pilot's PFD straight ahead, the
 * three left screens at azimuth 0 / +18 / +33, the overhead's underside at the
 * lowest pane top, a pillar in the crown gap, a post in the No.1 / No.2 seam.
 *
 * Every measurement is a ray or a vertex of the BUILT meshes, and the rays that
 * count crossings are the mesh's own triangles (`scripts/rayCrossings.mts`):
 * `scene.pickWithRay` returns one hit per mesh, which is the wrong tool for the
 * far side of a shell made of two overlapping closed lofts.
 *
 * THE OPENING IS ABOUT 19 DEGREES TALL where the type's is nearer 35. That is not
 * a cockpit defect and this file does not try to hold it up: the panes lie 45 to
 * 53 degrees up on the nose crown, far forward, and the crown is the ceiling of
 * every one of them. It is on the plane engineer's register as a nose re-loft.
 */

const DEG = 180 / Math.PI;
const EYE = aircraftSpec("airliner").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);

let engine: NullEngine;
let scene: Scene;
let camera: UniversalCamera;
let aircraft: AircraftVisual;
let cockpitOnly: readonly AbstractMesh[];
let shell: Triangle[];
let glazing: Triangle[];

function named(name: string): AbstractMesh {
  const found = scene.getMeshByName(name);
  if (!found) throw new Error(`missing mesh ${name}`);
  return found;
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
/** What the cockpit camera would draw: enabled, visible, on a layer it renders, opaque. */
function drawnByCockpitCamera(mesh: AbstractMesh): boolean {
  const material = mesh.material as PBRMaterial | null;
  return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
    && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
}
/**
 * The first surface the cockpit camera draws along a ray from the eye. The kit is
 * closed prisms seen from OUTSIDE (the eye is inside none of them), so the nearest
 * surface is the one drawn whatever the culling; the shell and the glazing are
 * excluded by their layer mask, as in the renderer.
 */
function firstHit(azimuth: number, elevation: number): AbstractMesh | null {
  return firstHitInfo(azimuth, elevation)?.pickedMesh ?? null;
}
/** The same, with the triangle it met (`faceId`), for the meshes that are several parts merged. */
function firstHitInfo(azimuth: number, elevation: number) {
  const hit = scene.pickWithRay(new Ray(EYE_POINT, direction(azimuth, elevation), 60), drawnByCockpitCamera);
  return hit?.hit ? hit : null;
}
/** Elevation extremes of the built glazing along one azimuth, by scanning the triangles in 0.05 degree steps. */
function glassExtent(azimuth: number): { top: number; bottom: number } | null {
  let top = Number.NaN;
  let bottom = Number.NaN;
  for (let e = 40; e >= -40; e -= 0.05) {
    if (crossings(EYE_POINT, direction(azimuth, e), glazing).length > 0) {
      if (!Number.isFinite(top)) top = e;
      bottom = e;
    }
  }
  return Number.isFinite(top) ? { top, bottom } : null;
}
/** The shell's OUTER half-width at (x, y): the LAST crossing of a ray from the centreline, since the fuselage and radome overlap. */
function outerHalfWidth(x: number, y: number, side: 1 | -1): number {
  const hits = crossings(new Vector3(x, y, 0), new Vector3(0, 0, side), shell);
  return hits.length > 0 ? hits[hits.length - 1]! : Number.NaN;
}
function crownAbove(x: number, z: number): number {
  const hits = crossings(new Vector3(x, 2.4, z), new Vector3(0, 1, 0), shell);
  return hits.length > 0 ? 2.4 + hits[hits.length - 1]! : Number.NaN;
}
/** The 24 vertices of the k-th box of a mesh merged from boxes, in merge order. */
function boxBlock(mesh: AbstractMesh, k: number): Vector3[] {
  return worldVertices(mesh).slice(k * 24, k * 24 + 24);
}
const centreOf = (vertices: Vector3[]) => vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);

/**
 * `airliner-cockpit-interior` is four parts merged in one order, vertices in that order: the board (a box, 24
 * vertices, 12 triangles), the overhead (a `solidPlate` of 20 triangles: 60 vertices), the pillar (a `solidPlate`
 * of 12: 36) and the seam post (a tapered 8-sided cylinder: 38 vertices, 32 triangles). The pillar and the post used
 * to be a mesh of their own, on the hood's matte material; they hang from the ceiling, so they are on the interior's.
 * The counts are pinned here so a change to any part fails loudly instead of slicing the wrong vertices.
 */
const INTERIOR_ORDER = ["board", "overhead", "pillar", "post"] as const;
const INTERIOR_VERTICES = { board: 24, overhead: 60, pillar: 36, post: 38 } as const;
const INTERIOR_TRIANGLES = { board: 12, overhead: 20, pillar: 12, post: 32 } as const;
const INTERIOR_SOURCES = ["airliner-instrument-panel", "airliner-overhead", "airliner-windscreen-pillar", "airliner-windscreen-post-port"];
function interiorBlock(which: (typeof INTERIOR_ORDER)[number]): Vector3[] {
  const mesh = named("airliner-cockpit-interior");
  expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom, "the interior mesh's sources, in merge order").toEqual(INTERIOR_SOURCES);
  const vertices = worldVertices(mesh);
  expect(vertices.length, "the interior mesh's vertices").toBe(INTERIOR_ORDER.reduce((sum, key) => sum + INTERIOR_VERTICES[key], 0));
  let start = 0;
  for (const key of INTERIOR_ORDER) {
    if (key === which) return vertices.slice(start, start + INTERIOR_VERTICES[key]);
    start += INTERIOR_VERTICES[key];
  }
  throw new Error(`no interior block ${which}`);
}
/** Which of the interior mesh's parts a picked triangle belongs to. */
function interiorPartOf(faceId: number): (typeof INTERIOR_ORDER)[number] {
  let start = 0;
  for (const key of INTERIOR_ORDER) {
    if (faceId < start + INTERIOR_TRIANGLES[key]) return key;
    start += INTERIOR_TRIANGLES[key];
  }
  throw new Error(`face ${faceId} is beyond the interior mesh`);
}

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "airliner");
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
  shell = worldTriangles(named("airliner-fuselage-shell"));
  glazing = worldTriangles(named("airliner-flight-deck-glazing"));
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the 747's eye", () => {
  it("is the solved point, in the port seat's line", () => {
    expect([EYE.forward, EYE.up, EYE.right]).toEqual([29.9, 2.93, -0.72]);
  });

  it("reads the BUILT glazing's edges straight ahead at T >= 9, with 0.55 m of glass and 0.15 m of skin", () => {
    const glassY = worldVertices(named("airliner-flight-deck-glazing")).map((v) => v.y);
    const extent = glassExtent(0)!;
    // the solved eye's numbers, from the built mesh: +9.64 / -9.39
    expect(extent.top).toBeGreaterThan(9.3);
    expect(extent.top).toBeLessThan(10.0);
    expect(extent.bottom).toBeLessThan(-9.1);
    expect(extent.bottom).toBeGreaterThan(-9.7);
    expect(Math.min(extent.top, -extent.bottom), "T").toBeGreaterThanOrEqual(9);
    // the eye stands inside the glass's vertical span
    expect(EYE.up).toBeGreaterThan(Math.min(...glassY));
    expect(EYE.up).toBeLessThan(Math.max(...glassY));
    // at least 0.55 m from the nearest glass, by the exact point-to-triangle distance
    expect(distanceToTriangles(EYE_POINT, glazing)).toBeGreaterThanOrEqual(0.55);
    // and at least 0.15 m of skin above it: the first surface overhead
    const skin = crossings(EYE_POINT, new Vector3(0, 1, 0), shell)[0]!;
    expect(skin).toBeGreaterThanOrEqual(0.15);
  });

  it("is what a pilot at the OLD seats could not have: the old eye's x reads T under 1 (the control)", () => {
    // The seats stood 2 m behind the glass. From the old station, at the same seat line, the same pane reads +0.9 / -9.2.
    const old = new Vector3(28.8, 3.1, -0.72);
    let top = Number.NaN;
    for (let e = 40; e >= -40; e -= 0.05) {
      if (crossings(old, direction(0, e), glazing).length > 0) {
        top = e;
        break;
      }
    }
    expect(top).toBeLessThan(2);
    expect(top).toBeGreaterThan(0);
  });

  it("has the seats around it: the port seat's centre 0.05 m aft and its top 0.15 m below, symmetric, headrests with them", () => {
    const interior = named("airliner-flight-deck-interior");
    expect((interior.metadata as { mergedFrom: string[] }).mergedFrom).toEqual([
      "airliner-captain-seat", "airliner-captain-headrest", "airliner-first-officer-seat", "airliner-first-officer-headrest",
    ]);
    const captainSeat = boxBlock(interior, 0);
    const captainHead = boxBlock(interior, 1);
    const pilotSeat = boxBlock(interior, 2);
    const pilotHead = boxBlock(interior, 3);
    const mean = (vs: Vector3[], axis: "x" | "y" | "z") => vs.reduce((s, v) => s + v[axis], 0) / vs.length;
    // the pilot's is the PORT seat, which is the mesh NAMED first-officer
    expect(mean(pilotSeat, "z")).toBeCloseTo(-0.72, 3);
    expect(mean(captainSeat, "z")).toBeCloseTo(0.72, 3);
    expect(mean(pilotSeat, "x"), "seat centre 0.05 m aft of the eye").toBeCloseTo(EYE.forward - 0.05, 3);
    // the seat leans (-0.07 rad), so its highest corner is its rear-top one: 0.15 m under the eye
    expect(EYE.up - Math.max(...pilotSeat.map((v) => v.y)), "seat top below the eye").toBeCloseTo(0.15, 3);
    // symmetric about the centreline, seats and headrests alike
    for (const axis of ["x", "y"] as const) {
      expect(mean(captainSeat, axis)).toBeCloseTo(mean(pilotSeat, axis), 6);
      expect(mean(captainHead, axis)).toBeCloseTo(mean(pilotHead, axis), 6);
    }
    // the headrest kept its old place relative to the seat: 0.42 aft, 0.48 up
    expect(mean(pilotSeat, "x") - mean(pilotHead, "x")).toBeCloseTo(AIRLINER_SEAT.headrestBehindSeat, 3);
    expect(mean(pilotHead, "y") - mean(pilotSeat, "y")).toBeCloseTo(AIRLINER_SEAT.headrestAboveSeat, 3);
    // and the pilot's head is not in the way: the eye is outside every seat and headrest box
    for (const block of [pilotSeat, pilotHead]) {
      const inside = EYE.forward >= Math.min(...block.map((v) => v.x)) && EYE.forward <= Math.max(...block.map((v) => v.x))
        && EYE.up >= Math.min(...block.map((v) => v.y)) && EYE.up <= Math.max(...block.map((v) => v.y));
      expect(inside, "the eye is inside a seat").toBe(false);
    }
  });
});

describe("the constants copied from the built glazing", () => {
  it("are the built panes' corners, to a millimetre, so a re-loft of the nose fails HERE", () => {
    const glass = named("airliner-flight-deck-glazing");
    const names = (glass.metadata as { mergedFrom: string[] }).mergedFrom;
    const vertices = worldVertices(glass);
    const normals = glass.getVerticesData(VertexBuffer.NormalKind)!;
    /** The pane's two big faces: the inner one (toward the centreline) and the outer one, each as four corners. */
    const faces = (name: string) => {
      const k = names.indexOf(name);
      const side = Math.sign(vertices[k * 24]!.z);
      const quads: { area: number; z: number; corners: Vector3[] }[] = [];
      for (let f = 0; f < 6; f += 1) {
        const corners = vertices.slice(k * 24 + f * 4, k * 24 + f * 4 + 4);
        const area = Vector3.Cross(corners[1]!.subtract(corners[0]!), corners[3]!.subtract(corners[0]!)).length();
        quads.push({ area, z: normals[(k * 24 + f * 4) * 3 + 2]! * side, corners });
      }
      quads.sort((a, b) => b.area - a.area);
      const big = quads.filter((q) => Math.abs(q.area - quads[0]!.area) < 1e-6);
      return { outer: big.find((q) => q.z > 0)!.corners, inner: big.find((q) => q.z < 0)!.corners };
    };
    const has = (corners: Vector3[], p: readonly [number, number, number]) =>
      corners.some((c) => Vector3.Distance(c, new Vector3(p[0], p[1], p[2])) < 1e-3);
    const one = faces("port-airliner-flight-deck-window-one");
    const two = faces("port-airliner-flight-deck-window-two");
    for (const p of Object.values(AIRLINER_GLAZING.portOneInner)) expect(has(one.inner, p), `port No.1 inner ${p}`).toBe(true);
    for (const p of Object.values(AIRLINER_GLAZING.portOneOuterTop)) expect(has(one.outer, p), `port No.1 outer ${p}`).toBe(true);
    for (const p of Object.values(AIRLINER_GLAZING.portTwoForwardInner)) expect(has(two.inner, p), `port No.2 inner ${p}`).toBe(true);
    // the lowest top and lowest bottom of ANY pane
    const tops = names.map((_, k) => Math.max(...vertices.slice(k * 24, k * 24 + 24).map((v) => v.y)));
    expect(Math.min(...tops)).toBeCloseTo(AIRLINER_GLAZING.lowestTopY, 3);
    expect(Math.min(...vertices.map((v) => v.y))).toBeCloseTo(AIRLINER_GLAZING.lowestBottomY, 3);
  });
});

describe("the 747's cockpit parts", () => {
  it("are the four named cockpit-only meshes, eighteen authored parts, and nothing else new", () => {
    expect(cockpitOnly.map((part) => part.name).sort()).toEqual([
      "airliner-cockpit-interior",
      "airliner-glareshield",
      "airliner-screen-bezels",
      "airliner-screens",
    ]);
    const sources = cockpitOnly.flatMap((part) => (part.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [part.name]);
    // board + overhead + pillar + post, hood + dash, six screens, six bezels. There were three more
    // -- a 3D attitude ball, a millimetre in front of the PFD's glass -- from before the screens
    // could draw anything. The PFD page draws its own attitude now and agrees with the HUD to a
    // tenth of a degree, so the ball was a second horizon standing ON the first and hiding most of
    // it. The Cessna keeps its ball: that aeroplane has a MECHANICAL one.
    expect(sources).toHaveLength(4 + 2 + 6 + 6);
    // the pillar and the post are part of the interior mesh: there is no mesh of their own
    expect(scene.getMeshByName("airliner-windscreen-frame")).toBeNull();
    for (const part of cockpitOnly) {
      expect((part.metadata as { cockpitOnly?: boolean }).cockpitOnly, part.name).toBe(true);
      expect((part.metadata as { castsShadow?: boolean }).castsShadow, `${part.name} must never cast`).toBe(false);
    }
  });

  it("put the hood and the dash on the glareshield's own matte material and the board, the overhead, the pillar and the post on the interior one, one instance each", () => {
    const glare = named("airliner-glareshield");
    const interior = named("airliner-cockpit-interior");
    expect((glare.metadata as { mergedFrom?: string[] }).mergedFrom, "the glareshield is the hood and the dash and nothing else").toEqual(["airliner-hood", "airliner-dash"]);
    expect((interior.metadata as { mergedFrom?: string[] }).mergedFrom, "the interior is the board, the overhead, the pillar and the post").toEqual(INTERIOR_SOURCES);
    expect(glare.material, "the hood has a material").not.toBeNull();
    expect(interior.material, "the interior has a material").not.toBeNull();
    // the merge itself refuses parts on different materials, so each mesh is one instance, not an equal copy: a second material is a second draw state
    expect(interior.material, "the two draw states differ").not.toBe(glare.material);
    // and the glareshield's is the matte one that reflects nothing (F0 zero) but is LIT by the sky's image light,
    // as the interior is. (It had none once, and a face the sun missed read (0, 0, 0): the pillar and the post
    // moved to the interior material for that, and later the glareshield itself took the sky's light.)
    expect((glare.material as PBRMaterial).metallicF0Factor, "the glareshield reflects nothing").toBe(0);
    expect((glare.material as PBRMaterial).environmentIntensity, "the glareshield is lit by the sky").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect((interior.material as PBRMaterial).environmentIntensity, "the interior's material is lit by the sky").toBeGreaterThan(0);
    // the same instance the seats stand on: the flight deck's own interior material, so no draw state of its own
    expect(interior.material, "the airframe's interior material").toBe(named("airliner-flight-deck-interior").material);
  });

  it("builds the seam post at radius 0.025 (0.027 at its foot: the cylinder is 8% fatter there) and the pillar as wide as the crown gap", () => {
    const seam = airlinerSeamPostEndpoints();
    const axis = seam.top.subtract(seam.bottom).normalize();
    const post = interiorBlock("post");
    const distances = post.map((v) => {
      const d = v.subtract(seam.bottom);
      return d.subtract(axis.scale(Vector3.Dot(d, axis))).length();
    }).filter((d) => d > 0.01);
    expect(distances.length, "the post's ring vertices").toBeGreaterThan(8);
    expect(Math.max(...distances)).toBeCloseTo(0.027, 3);
    expect(Math.min(...distances)).toBeCloseTo(0.025, 3);
    // the pillar: as wide at the bottom as the No.1 panes' inboard corners (z +-0.618), and 0.175 either side at the overhead
    const pillar = interiorBlock("pillar");
    expect(Math.max(...pillar.map((v) => Math.abs(v.z)))).toBeCloseTo(0.618, 2);
    expect(Math.max(...pillar.filter((v) => v.y > 3.1).map((v) => Math.abs(v.z)))).toBeCloseTo(0.175, 1);
    expect(Math.min(...pillar.map((v) => v.y))).toBeLessThan(AIRLINER_GLAZING.lowestBottomY);
    expect(Math.max(...pillar.map((v) => v.y))).toBeGreaterThan(airlinerOverheadUndersideY() - 0.01);
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

  it("hide the shell, the centre post and the GLAZING from the cockpit camera, and nothing else", () => {
    expect([...aircraft.cockpitParts].map((part) => part.name).sort()).toEqual([
      "airliner-flight-deck-glazing", "airliner-fuselage-shell", "airliner-windscreen-center-post",
    ]);
    for (const mesh of aircraft.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(aircraft.cockpitParts.includes(mesh));
    }
    // the glazing is the reason: it is a refractive PBR, which draws as an opaque slab from inside
    const glass = named("airliner-flight-deck-glazing").material as PBRMaterial;
    expect(glass.subSurface.isRefractionEnabled, "the glazing's material refracts").toBe(true);
  });
});

describe("what the pilot sees straight ahead", () => {
  it("has the hood's far top edge at -10 degrees", () => {
    const glare = worldVertices(named("airliner-glareshield"));
    const farX = airlinerPanelFaceX() + AIRLINER_PANEL.thickness;
    const edge = glare.filter((v) => Math.abs(v.x - farX) < 1e-6 && Math.abs(v.y - airlinerHoodTopY()) < 1e-6);
    expect(edge.length).toBeGreaterThanOrEqual(2);
    // the edge is a line along z; where it crosses the eye's own z is what reads straight ahead
    const elevation = Math.atan2(edge[0]!.y - EYE.up, edge[0]!.x - EYE.forward) * DEG;
    expect(Math.abs(elevation + 10)).toBeLessThan(0.1);
  });

  it("carries the hood on with a dash that covers the glass's bottom edge, so no band of hidden nose shows between them", () => {
    const glass = glassExtent(0)!;
    // scan down at az 0 for the shelf's top: the highest elevation whose first surface is the hood or the dash
    let shelfTop = Number.NaN;
    for (let e = 5; e >= -25; e -= 0.02) {
      if (firstHit(0, e)?.name === "airliner-glareshield") {
        shelfTop = e;
        break;
      }
    }
    expect(Number.isFinite(shelfTop), "found the shelf").toBe(true);
    // the shelf's top edge reads about -9.1 (the dash's edge where the nose narrows), which is ABOVE the glass's bottom (-9.4)
    expect(shelfTop).toBeGreaterThan(glass.bottom);
    expect(shelfTop).toBeGreaterThan(-9.6);
    expect(shelfTop).toBeLessThan(-8.5);
    // the control: without the dash the hood's far edge (-10.0) sits BELOW the glass's bottom edge, so a band would show
    expect(-10 + 1e-9).toBeLessThan(glass.bottom);
  });

  /** The elevation of the opening's top edge along an azimuth: the first elevation, scanning down, whose first surface is not the overhead. */
  function openingTop(azimuth: number): number {
    for (let e = 30; e >= -30; e -= 0.02) {
      if (firstHit(azimuth, e)?.name !== "airliner-cockpit-interior") return e;
    }
    return Number.NaN;
  }
  /** How far the frame reaches above and below the horizon along an azimuth (the frame is a rectangle: its edge is a tan, not a constant). */
  const frameLimit = (azimuth: number) => Math.atan(Math.tan((23.3 / DEG)) * Math.cos(azimuth / DEG)) * DEG;

  it("puts the glass under a raked overhead: the opening's top edge never rises above the glass, and follows it across the No.1 pane", () => {
    // (azimuths clear of the seam post, whose top stands under the overhead at about -14)
    for (const az of [-30, -20, -8, -4, 0, 4]) {
      const glass = glassExtent(az);
      expect(glass, `glass at azimuth ${az}`).not.toBeNull();
      const top = openingTop(az);
      // never above the glass's top edge: that would show the hidden crown as sky over the window
      expect(top, `opening top at azimuth ${az} against the glass's ${glass!.top.toFixed(2)}`).toBeLessThanOrEqual(glass!.top + 0.05);
      // over the port No.1 pane (the pane the pilot looks through) the edge follows the glass to within 1.6 degrees
      if (az >= -8) expect(top, `opening top at azimuth ${az}`).toBeGreaterThan(glass!.top - 1.6);
    }
    // the literal at az 0 for the record: the opening's top edge reads about +8.8 (the glass's is +9.6)
    expect(openingTop(0)).toBeGreaterThan(8.3);
    expect(openingTop(0)).toBeLessThan(9.4);
  });

  it("leaves no skin showing as sky directly under or over any pane's own edge", () => {
    const glass = named("airliner-flight-deck-glazing");
    const names = (glass.metadata as { mergedFrom: string[] }).mergedFrom;
    const vertices = worldVertices(glass);
    let bottoms = 0;
    let tops = 0;
    names.forEach((_, k) => {
      const block = vertices.slice(k * 24, k * 24 + 24);
      const unique = [...new Map(block.map((v) => [`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`, v])).values()];
      const byY = [...unique].sort((a, b) => a.y - b.y);
      // the box's lowest edge is its inner face's bottom edge, its highest the outer face's top edge
      const edges: [Vector3, Vector3, "bottom" | "top"][] = [[byY[0]!, byY[1]!, "bottom"], [byY[6]!, byY[7]!, "top"]];
      for (const [a, b, which] of edges) {
        for (let i = 0; i <= 20; i += 1) {
          const p = Vector3.Lerp(a, b, i / 20);
          if (p.x <= EYE.forward + 0.1) continue;
          const { az, el } = azel(p);
          if (Math.abs(az) > 37 || Math.abs(el) > frameLimit(az) - 0.5) continue;
          const nudged = which === "bottom" ? el - 0.3 : el + 0.3;
          if (Math.abs(nudged) > frameLimit(az)) continue;
          expect(firstHit(az, nudged), `sky ${which === "bottom" ? "under" : "over"} pane ${names[k]} at azimuth ${az.toFixed(1)}, elevation ${el.toFixed(2)}`).not.toBeNull();
          if (which === "bottom") bottoms += 1;
          else tops += 1;
        }
      }
    });
    // NON-VACUITY: many samples of both edges were in the frame
    expect(bottoms).toBeGreaterThan(20);
    expect(tops).toBeGreaterThan(20);
  });

  it("is solid below the shelf and above the overhead's edge, everywhere in the frame", () => {
    let columns = 0;
    for (let az = -37; az <= 37; az += 1) {
      const limit = frameLimit(az);
      // below: from the shelf's top edge to the bottom of the frame, every ray meets a cockpit part
      let shelf = Number.NaN;
      for (let e = 5; e >= -limit; e -= 0.05) {
        // the shelf is the hood and dash only: the post's foot and the pillar stand on it, and the wedge of hidden
        // skin between two panes (beside the post) is open on purpose, like the glass
        if (firstHit(az, e)?.name === "airliner-glareshield") {
          shelf = e;
          break;
        }
      }
      if (Number.isFinite(shelf)) {
        columns += 1;
        for (let e = shelf - 0.05; e >= -limit; e -= 0.25) expect(firstHit(az, e), `a hole below the shelf at azimuth ${az}, elevation ${e.toFixed(2)}`).not.toBeNull();
      }
      // above: from the opening's top edge to the top of the frame, every ray meets the overhead
      const top = openingTop(az);
      if (Number.isFinite(top)) for (let e = top + 0.05; e <= limit; e += 0.25) expect(firstHit(az, e)?.name, `a hole above the opening at azimuth ${az}, elevation ${e.toFixed(2)}`).toBe("airliner-cockpit-interior");
    }
    expect(columns).toBeGreaterThan(50);
  });

  it("fills the crown gap between the two No.1 panes with a pillar", () => {
    // between the port No.1's inboard edge (az +17 at the top, +3 at the bottom) and the starboard's (az +33 / +35)
    let cells = 0;
    let pillar = 0;
    for (let az = 18; az <= 32; az += 1) {
      for (let el = -8; el <= 3; el += 0.5) {
        cells += 1;
        const hit = firstHitInfo(az, el);
        expect(hit, `sky in the crown gap at azimuth ${az}, elevation ${el}`).not.toBeNull();
        // the pillar is a part of the interior mesh: told apart by the triangle the ray met
        if (hit?.pickedMesh?.name === "airliner-cockpit-interior" && interiorPartOf(hit.faceId) === "pillar") pillar += 1;
      }
    }
    expect(pillar / cells, "most of the gap is the pillar").toBeGreaterThan(0.7);
  });

  it("stands a post in the No.1 / No.2 seam, leaning as the seam does, and runs the mesh on past the ceiling", () => {
    // the DESIGN post: its foot, and the point where it meets the overhead's underside. Every angle below reads these.
    const seam = airlinerSeamPostEndpoints();
    const post = interiorBlock("post");
    expect(post.length, "the post's vertices").toBeGreaterThan(8);
    const foot = post.reduce((a, b) => (b.y < a.y ? b : a));
    // (the post's lowest vertex reads -28.00 at radius 0.025; the range is the seam's foot, not that number)
    expect(azel(foot).az).toBeGreaterThan(-30);
    expect(azel(foot).az).toBeLessThan(-22);
    // its design top runs on up to the overhead along the seam's line, so it reads further left than the pane corner
    expect(azel(seam.top).az).toBeGreaterThan(-16);
    expect(azel(seam.top).az).toBeLessThan(-12);
    // it reaches the overhead's underside
    expect(seam.top.y).toBeCloseTo(airlinerOverheadUndersideY(), 3);
  });

  it("buries the post's top end in the overhead: its cut end is above the underside, under the plate, and never shown to the pilot", () => {
    // A rod that ends exactly on the ceiling's underside shows its end cap as a small lit wedge (it read at about
    // (555, 190) in the first live frame). The MESH runs `buryMetres` past the design top along its own axis.
    const seam = airlinerSeamPostEndpoints();
    const axis = seam.top.subtract(seam.bottom).normalize();
    const designLength = Vector3.Distance(seam.top, seam.bottom);
    const post = interiorBlock("post");
    const along = (v: Vector3) => Vector3.Dot(v.subtract(seam.bottom), axis);
    const end = post.filter((v) => along(v) > designLength + AIRLINER_POST.buryMetres - 1e-3);
    expect(end.length, "the top end cap's vertices (the ring and its centre)").toBeGreaterThanOrEqual(9);
    expect(Math.max(...post.map(along)), "the mesh ends buryMetres past the design top, no more").toBeCloseTo(designLength + AIRLINER_POST.buryMetres, 3);
    for (const v of end) {
      expect(v.y, `the top end cap's vertex at (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) is above the overhead's underside`).toBeGreaterThan(airlinerOverheadUndersideY() + 0.01);
    }
    // and it is UNDER the plate, not beside it: every cap vertex is inside the overhead's plan (x, z)
    const plan = airlinerOverheadPlan();
    const inside = (x: number, z: number) => {
      let crossings = 0;
      for (let i = 0; i < plan.length; i += 1) {
        const a = plan[i]!;
        const b = plan[(i + 1) % plan.length]!;
        if ((a.z > z) !== (b.z > z) && x < a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x)) crossings += 1;
      }
      return crossings % 2 === 1;
    };
    for (const v of end) expect(inside(v.x, v.z), `the cap's vertex (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) is under the overhead's plan`).toBe(true);
    // CONTROL: the design top is where the cap used to be, and its cap sat on the underside, below the +0.01 the buried one clears
    expect(seam.top.y - airlinerOverheadUndersideY(), "the design top stands on the underside").toBeCloseTo(0, 3);
  });
});

describe("the seam post's foot", () => {
  it("stands behind the shelf: no ray meets the post's lowest 5 cm, and the post is met higher up (the control)", () => {
    // The foot's cut end is not buried (the top's is): the shelf hides it. Held here so a change to the shelf, the hood or
    // the post's foot cannot show it. Measured over the whole post on a 0.06 degree grid: the lowest point of it that any ray
    // meets is 0.111 m above the foot (y 2.741, the foot is 2.652).
    const seam = airlinerSeamPostEndpoints();
    const axis = seam.top.subtract(seam.bottom).normalize();
    const postStart = INTERIOR_TRIANGLES.board + INTERIOR_TRIANGLES.overhead + INTERIOR_TRIANGLES.pillar;
    const solids = [
      ...worldTriangles(named("airliner-cockpit-interior")).map((triangle, index) => ({ triangle, post: index >= postStart && index < postStart + INTERIOR_TRIANGLES.post })),
      ...worldTriangles(named("airliner-glareshield")).map((triangle) => ({ triangle, post: false })),
    ];
    const nearest = (d: Vector3) => {
      let best = Number.POSITIVE_INFINITY;
      let post = false;
      for (const solid of solids) {
        const h = hitTriangle(EYE_POINT, d, solid.triangle);
        if (Number.isFinite(h) && h > 0.08 && h < best) {
          best = h;
          post = solid.post;
        }
      }
      return { distance: best, post };
    };
    const axial = (d: Vector3, distance: number) => Vector3.Dot(EYE_POINT.add(d.scale(distance)).subtract(seam.bottom), axis);
    // the window round the foot (az -28, el -12.9), 2,400 rays: where along the post does any ray meet it?
    let lowest = Number.POSITIVE_INFINITY;
    for (let az = -30.6; az <= -25.6; az += 0.1) {
      for (let el = -13.6; el <= -9; el += 0.1) {
        const d = direction(az, el);
        const hit = nearest(d);
        if (hit.post) lowest = Math.min(lowest, axial(d, hit.distance));
      }
    }
    expect(lowest, "the lowest point of the post any ray meets, metres above its foot").toBeGreaterThan(0.05);
    // CONTROL: aimed at the post's axis higher up, the nearest thing IS the post, so the instrument sees it where it shows
    for (const t of [0.3, 0.4, 0.5, 0.6]) {
      const d = seam.bottom.add(axis.scale(t)).subtract(EYE_POINT).normalize();
      expect(nearest(d).post, `a ray at ${t} m up the post meets the post`).toBe(true);
    }
    // and aimed at the foot itself it does not: the shelf is in front
    const atFoot = seam.bottom.subtract(EYE_POINT).normalize();
    expect(nearest(atFoot).post, "a ray at the foot meets the shelf, not the post").toBe(false);
  });
});

describe("the 747's screens", () => {
  it("are six across, laid out about the SEATS: the pilot's PFD straight ahead, the next two at +18 and +33", () => {
    const screens = named("airliner-screens");
    const names = (screens.metadata as { mergedFrom: string[] }).mergedFrom;
    expect(names).toEqual([
      "airliner-screen-port-pfd", "airliner-screen-port-nd", "airliner-screen-port-eicas",
      "airliner-screen-starboard-eicas", "airliner-screen-starboard-nd", "airliner-screen-starboard-pfd",
    ]);
    const centres = names.map((_, k) => centreOf(boxBlock(screens, k)));
    expect(centres.map((c) => c.z)).toEqual([-0.72, -0.475, -0.23, 0.23, 0.475, 0.72].map((z) => expect.closeTo(z, 3)));
    // the pilot's PFD is on the eye's own z
    expect(centres[0]!.z).toBeCloseTo(EYE.right, 3);
    expect(azel(centres[0]!).az).toBeCloseTo(0, 1);
    expect(azel(centres[1]!).az).toBeGreaterThan(17.5);
    expect(azel(centres[1]!).az).toBeLessThan(19);
    expect(azel(centres[2]!).az).toBeGreaterThan(32.5);
    expect(azel(centres[2]!).az).toBeLessThan(34.5);
    // three of the six are in the 75 degree frame (az +-37.5), the others are not
    expect(centres.filter((c) => Math.abs(azel(c).az) < 37.5)).toHaveLength(3);
    // their top edge reads 1.5 degrees below the hood's underside
    const top = Math.max(...boxBlock(screens, 0).map((v) => v.y));
    const front = Math.min(...boxBlock(screens, 0).map((v) => v.x));
    const hoodUnder = Math.atan2(airlinerHoodTopY() - AIRLINER_PANEL.hoodThickness - EYE.up, airlinerPanelFaceX() - AIRLINER_PANEL.hoodOverhang - EYE.forward) * DEG;
    expect(Math.atan2(top - EYE.up, front - EYE.forward) * DEG).toBeCloseTo(hoodUnder - 1.5, 1);
  });

  // THE 3D ATTITUDE BALL THAT STOOD HERE IS GONE, and this is where its placement was held: a pivot
  // on the PFD's upper two-thirds carrying a sky half, a ground half and a pitch bar, a millimetre in
  // front of the glass. It was built when the screens were dark rectangles. Now the PFD page draws an
  // attitude that `render.cockpit-display-state.test.ts` holds to the HUD's own numbers, so the ball
  // was a SECOND horizon standing on top of the first and hiding most of it. What replaces this test
  // is that one plus the PFD page's own horizon test, which measure the thing the pilot now sees.
});

describe("the 747's cockpit against the shell it stands in", () => {
  /** Every vertex of these stands inside the shell's outer skin by at least this much, metres; the tightest is printed. */
  const INSIDE = [
    ["airliner-cockpit-interior", "panel board"],
    ["airliner-glareshield", "hood and dash"],
    ["airliner-screens", "screens"],
    ["airliner-screen-bezels", "bezels"],
  ] as const;

  it("keeps the panel, the hood, the dash, the screens and the bezels inside the outer skin with clearance to spare", () => {
    const lines: string[] = [];
    for (const [meshName, label] of INSIDE) {
      const isBoard = meshName === "airliner-cockpit-interior";
      // the interior mesh is the board, the overhead, the pillar and the post: measure only the board here (the overhead
      // pokes through on purpose, and the pillar and the post have a test of their own)
      const vertices = isBoard ? interiorBlock("board") : worldVertices(named(meshName));
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
      // 1 cm: the panel and hood are built to the wall less 2 cm, and the numbers below are what was measured
      expect(tightest, `${label} against the outer skin`).toBeGreaterThanOrEqual(0.01);
    }
    console.info(`747 cockpit clearance from the shell's outer skin:\n  ${lines.join("\n  ")}`);
  });

  it("lets the pillar and the post stand proud of the skin only as far as the panes' own corners do (they are placed against them)", () => {
    // The pillar and the post lie in the plane of the panes' built inner corners, and the panes stand half proud of the nose
    // (each is a 0.12 slab laid on the crown), so the frame pokes through the outer skin by up to 0.137 m, at the post's foot.
    // Its own bound is set by the glazing's: no corner of the port No.1 pane is more than 0.19 m outside the same skin.
    const outside = (x: number, y: number, z: number) => Math.abs(z) - outerHalfWidth(x, y, z < 0 ? -1 : 1);
    const paneWorst = Math.max(...Object.values(AIRLINER_GLAZING.portOneInner).map((c) => outside(c[0], c[1], c[2])));
    const frame = [...interiorBlock("pillar"), ...interiorBlock("post")];
    const frameWorst = Math.max(...frame.filter((v) => Math.abs(v.z) > 1e-4).map((v) => outside(v.x, v.y, v.z)).filter(Number.isFinite));
    console.info(`747 pillar and post: worst distance outside the outer skin ${frameWorst.toFixed(3)} m; the port No.1 pane's own corners ${paneWorst.toFixed(3)} m`);
    expect(paneWorst, "the panes' own corners stand proud of the skin").toBeGreaterThan(0.05);
    expect(frameWorst, "the frame stands proud of the skin by no more than the panes' corners do").toBeLessThanOrEqual(paneWorst + 0.005);
    expect(frameWorst).toBeLessThan(0.15);
  });

  it("keeps everything behind the glazing's bottom line (the pillar's plate is 0.04 thick, so it stands 1.4 cm past it)", () => {
    const line = AIRLINER_GLAZING.portOneInner.bottomInboard[0];
    for (const part of cockpitOnly) {
      const maxX = Math.max(...worldVertices(part).map((v) => v.x));
      expect(maxX, `${part.name} reaches ${maxX.toFixed(3)}, the glazing's bottom line is ${line}`).toBeLessThanOrEqual(line + 0.02);
    }
  });

  it("lets the overhead poke through the crown by a printed, bounded amount, as the Global's does", () => {
    const overhead = interiorBlock("overhead");
    expect(overhead.length).toBeGreaterThanOrEqual(12);
    let worst = 0;
    let at = "";
    for (const v of overhead) {
      const crown = crownAbove(v.x, v.z);
      if (!Number.isFinite(crown)) continue;
      const over = v.y - crown;
      if (over > worst) {
        worst = over;
        at = `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
      }
    }
    // and the same corner's distance OUTSIDE the outer skin sideways, where the roof is narrower than the frame needs
    const sideways = Math.max(...overhead.map((v) => {
      const wall = outerHalfWidth(v.x, Math.min(v.y, 3.0), v.z < 0 ? -1 : 1);
      return Number.isFinite(wall) ? Math.abs(v.z) - wall : 0;
    }));
    console.info(`747 overhead's greatest protrusion above the crown: ${worst.toFixed(3)} m at ${at}; sideways past the skin: ${sideways.toFixed(3)} m`);
    // it does protrude (the crown falls forward and away while the overhead stays level and wide enough for the frame's
    // top corners), and nothing sees it; the Global's does the same by 0.85 m. Bounded here at 0.65.
    expect(worst).toBeGreaterThan(0.1);
    expect(worst).toBeLessThan(0.65);
    // the underside stands at the glazing's lowest pane top
    expect(Math.min(...overhead.map((v) => v.y))).toBeCloseTo(airlinerOverheadUndersideY(), 3);
  });

  it("puts nothing in the frame that the design did not account for: below the hood is board, above the overhead's edge is overhead", () => {
    const allowed = new Set([
      "airliner-cockpit-interior", "airliner-glareshield", "airliner-screens", "airliner-screen-bezels",
    ]);
    for (let az = -37; az <= 37; az += 2) {
      for (let el = -23; el <= 23; el += 1) {
        const hit = firstHit(az, el);
        if (hit) expect(allowed.has(hit.name), `${hit.name} at azimuth ${az}, elevation ${el}`).toBe(true);
      }
    }
  });
});

describe("no loft end cap faces the pilot", () => {
  /**
   * Babylon's picking ignores back-face culling, so this works on the shell's own
   * triangles and calibrates which winding the ENGINE calls front-facing on a closed
   * convex prism: the sign for which a ray from outside meets a front face and a ray
   * from inside meets none. The prism used to be the attitude ball's pitch bar; it is
   * the pilot's PFD screen box now, which is the same kind of thing -- one `build.box`,
   * closed and convex, wound by Babylon, and one the pilot plainly sees.
   */
  function calibrate(): number {
    const screens = named("airliner-screens");
    // the first of the six merged boxes: its 24 vertices are the first 24, so its triangles are
    // the ones whose three indices all fall in that block
    const all = worldTriangles(screens);
    const indices = screens.getIndices()!;
    const prism = all.filter((_, t) => [0, 1, 2].every((k) => indices[t * 3 + k]! < 24));
    expect(prism, "the PFD screen box's own triangles").toHaveLength(12);
    const centre = centreOf(boxBlock(screens, 0));
    const forward = new Vector3(1, 0, 0);
    const front = (origin: Vector3, sign: number) =>
      prism.some((t) => {
        if (!Number.isFinite(crossings(origin, forward, [t])[0] ?? Number.NaN)) return false;
        const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
        return sign * Vector3.Dot(n, forward) < 0;
      });
    // from OUTSIDE (0.3 m in front, looking at it) a front face is met; from INSIDE (its own centre, looking out) none is
    const outside = centre.add(new Vector3(-0.3, 0, 0));
    for (const sign of [1, -1]) if (front(outside, sign) && !front(centre, sign)) return sign;
    return 0;
  }

  it("holds: the only caps ahead of the eye are wound outward, and the radome's rear cap is 4 m behind it", () => {
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
    // NON-VACUITY: the four caps of the two lofts are found, of 28 triangles each
    expect(found.map((cap) => Number(cap.x.toFixed(1)))).toEqual([-26, 25.5, 30.6, 34]);
    for (const cap of found) expect(cap.triangles).toHaveLength(28);
    const facesViewer = (cap: (typeof found)[number], from: Vector3, toward: Vector3) => {
      const d = toward.subtract(from).normalize();
      const t = cap.triangles[0]!;
      return sign * Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), d) < 0;
    };
    const centreOfCap = (cap: (typeof found)[number]) => centreOf(cap.triangles.flatMap((t) => [t.a, t.b, t.c]));
    // the caps AHEAD of the eye do not face it
    for (const cap of found.filter((c) => c.x > EYE.forward)) {
      expect(facesViewer(cap, EYE_POINT, centreOfCap(cap)), `the cap at x ${cap.x.toFixed(1)} faces the pilot`).toBe(false);
    }
    // the control: the radome's rear cap DOES face a viewer behind it looking forward, so the predicate can say yes ...
    const radomeRear = found.find((c) => Math.abs(c.x - 25.5) < 0.01)!;
    const behind = new Vector3(20, radomeRear.triangles[0]!.a.y, 0);
    expect(facesViewer(radomeRear, behind, centreOfCap(radomeRear)), "the predicate cannot fail").toBe(true);
    // ... and it is 4.4 m behind the pilot, where it cannot be seen
    expect(EYE.forward - radomeRear.x).toBeGreaterThan(4);
  });
});
