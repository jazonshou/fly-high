import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crossings, distanceToTriangles, hitTriangle, worldTriangles, type Triangle } from "../scripts/rayCrossings.mts";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES, cockpitHorizontalFieldOfViewForAspect } from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  JET_DISPLAY_AIRFRAME,
  JET_GLARESHIELD,
  JET_HUD_FRAME,
  JET_MFD,
  JET_PANEL,
  jetCoamingHalfWidth,
  jetCoamingTopY,
  jetGlareshieldSection,
  jetHudFrameAngles,
  JET_HUD_COMBINER,
  JET_HUD_HOUSING,
  jetHudCombinerPanes,
  jetHudFrameCornerAxis,
  jetHudFrameFootY,
  jetHudHousingTopY,
  jetMfdPlacements,
  jetPanelFace,
  jetPanelFaceX,
  jetPanelSection,
  jetSillInnerAt,
  jetSillSection,
  jetSillStations,
  JET_SILL,
  JET_RAIL_END,
  jetRailEndStations,
} from "../src/render/webgpu/aircraft/cockpit/jetCockpit";
import {
  AIRLINER_DISPLAYS,
  JET_DISPLAYS,
  type DisplayLayout,
  displayAtlasHeight,
  displayAtlasWidth,
  displaySlots,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { drawDisplayAtlas, pageRoundScale } from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import { displayStateFromVisual, type DisplayAirframe } from "../src/render/webgpu/aircraft/cockpit/displays/displayStateFromVisual";
import { AIRLINER_DISPLAY_AIRFRAME } from "../src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { createRecordingContext, transformedPoints, type RecordedCall } from "./support/recordingContext";
import { aircraftCameraLayerMask, type AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { AIRCRAFT_KINDS } from "../src/sim";
import { BEZEL_RIM, GLARESHIELD_IMAGE_LIGHT, bezelRimEmissive } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import { COCKPIT_GLOW_NIGHT_MULTIPLE, aircraftWashLights } from "../src/render/webgpu/lighting/AircraftLighting";
import { cockpitView, measureDeckLineDegrees } from "./support/cockpitFootprints";
import { cockpitDeckK, cockpitDeckKStyleValue, cockpitDeckLineY } from "../src/ui/cockpitHudLayout";

/**
 * The F-16's cockpit, phases F1 (the coaming, the board, the HUD frame) and F2
 * (the two MFDs), held to the angles it was built to and to the airframe it
 * stands in.
 *
 * The EYE is the catalogue's (2.22, 0.94, 0), which this phase does not move.
 * Everything is asserted as angles from it at the 75 degree lens, measured on the
 * BUILT meshes by ray or by vertex, never derived from the builder's constants:
 * the deck line, the coaming's rounded rail, at -10.19 straight ahead, over the nose probe, with a 45 degree
 * cove under it down to the dash at -12.68 (the F-16 pass, step 1: it was a wedge whose flat top showed as a
 * 5.8 degree band down to -16.0); the HUD frame's uprights at az +-6.5 and its bar at +4.5, the box containing
 * (0, 0); the uprights' feet buried in the hood behind the rail; the board, the dash, bare under it;
 * the canopy two-sided from the seat.
 *
 * AND THE GATE: every other mesh of the jet is where f9d2672 had it (world
 * positions to the micrometre, and indices, mesh by mesh). A cockpit branch that
 * nudged a wing by a millimetre would fail here. The other three airframes are
 * pinned whole by `render.loft-crown-seam.test.ts`.
 */

const DEG = 180 / Math.PI;
/**
 * Where the F-16's ND puts own ship on its 400 x 400 page (step 5c): the drawing, from the heading labels' ring (the
 * rose's 178.2, the radius at which the +-60 degree labels' 11 px text keeps 20 px from the page's sides, plus the
 * labels' 0.055 h and half their font) down to own ship's tail (0.02 h), centred between the heading box's bottom
 * (0.095 h) and the page's bottom. Written out here, not read from the page code.
 */
const ND_ROSE_RADIUS = (200 - 20 - 0.6 * 11) / Math.sin(Math.PI / 3) - 0.055 * 400;
const ND_OWN_SHIP_Y = (() => {
  const drawn = ND_ROSE_RADIUS + 0.055 * 400 + 11 / 2 + 0.02 * 400;
  return 0.095 * 400 + (400 - 0.095 * 400 - drawn) / 2 + drawn - 0.02 * 400;
})();
const EYE = aircraftSpec("jet").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);
const TAN_HALF_H = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
/** How far the frame reaches above and below the horizon along an azimuth (the frame is a rectangle: its edge is a tan, not a constant). */
const frameLimit = (azimuth: number) => Math.atan((TAN_HALF_H / (16 / 9)) * Math.cos(azimuth / DEG)) * DEG;

let engine: NullEngine;
let scene: Scene;
let camera: UniversalCamera;
let aircraft: AircraftVisual;
let cockpitOnly: readonly AbstractMesh[];
let canopy: Triangle[];

/**
 * The coaming's own rail, the first part of `jet-glare-shield` (step 5 merged the rail's two swept ends after it): its
 * vertices and its triangles.
 */
const RAIL_VERTICES = 144;
function railVertices(): Vector3[] {
  return worldVertices(named("jet-glare-shield")).slice(0, RAIL_VERTICES);
}
function railTriangles(): Triangle[] {
  return worldTriangles(named("jet-glare-shield")).slice(0, RAIL_VERTICES / 3);
}
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
 * The first OPAQUE surface the cockpit camera draws along a ray from the eye. The eye is inside
 * none of the opaque parts it can see (the tub is under it, the seat behind it, the skin hidden
 * by its layer mask, the canopy alpha-blended), so the nearest surface is the one drawn whatever
 * the culling; the drawn-faces test holds the winding separately.
 */
function firstHitInfo(azimuth: number, elevation: number, from: Vector3 = EYE_POINT) {
  const hit = scene.pickWithRay(new Ray(from, direction(azimuth, elevation), 60), drawnByCockpitCamera);
  return hit?.hit ? hit : null;
}
function firstHit(azimuth: number, elevation: number, from: Vector3 = EYE_POINT): AbstractMesh | null {
  return firstHitInfo(azimuth, elevation, from)?.pickedMesh ?? null;
}
/** The highest elevation along an azimuth, scanning down from `top`, at which the first surface is `name`. */
function silhouette(name: string, azimuth: number, top = 5, step = 0.02): number {
  for (let e = top; e >= -30; e -= step) {
    if (firstHit(azimuth, e)?.name === name) return e;
  }
  return Number.NaN;
}

/**
 * The world-space digest the gate below pins: positions after the world matrix, rounded to the micrometre, then
 * the indices. Order-sensitive. It sees geometry and placement only: NOT normals, UVs, materials or layer masks.
 */
function worldDigest(meshes: readonly AbstractMesh[]): string {
  let hash = 0x811c9dc5;
  const feed = (value: number) => {
    hash ^= Math.round(value * 1e6) & 0xffffffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const mesh of meshes) {
    for (const v of worldVertices(mesh)) {
      feed(v.x);
      feed(v.y);
      feed(v.z);
    }
    for (const index of mesh.getIndices() ?? []) feed(index);
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * `jet-hud-frame` is three untapered rods and two rounded corners merged in one order, vertices in that order: the
 * port upright, the starboard upright, the bar, 38 vertices and 32 triangles each (an 8-sided cylinder with its two
 * caps), then the port and the starboard corner (step 5b), 56 vertices and 96 triangles each (seven rings of eight
 * round a quarter circle, open at both ends). Pinned so a change to a strut fails loudly instead of slicing the wrong
 * vertices.
 */
const FRAME_ORDER = ["port", "starboard", "bar", "port corner", "starboard corner"] as const;
const FRAME_SOURCES = ["jet-hud-frame-upright-port", "jet-hud-frame-upright-starboard", "jet-hud-frame-bar", "jet-hud-frame-corner-port", "jet-hud-frame-corner-starboard"];
const FRAME_VERTICES = 38;
const FRAME_TRIANGLES = 32;
const CORNER_VERTICES = 56;
const CORNER_TRIANGLES = 96;
function frameBlock(which: (typeof FRAME_ORDER)[number]): Vector3[] {
  const mesh = named("jet-hud-frame");
  expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom, "the frame's sources, in merge order").toEqual(FRAME_SOURCES);
  const vertices = worldVertices(mesh);
  expect(vertices.length, "the frame's vertices").toBe(FRAME_VERTICES * 3 + CORNER_VERTICES * 2);
  const k = FRAME_ORDER.indexOf(which);
  const from = k < 3 ? k * FRAME_VERTICES : 3 * FRAME_VERTICES + (k - 3) * CORNER_VERTICES;
  return vertices.slice(from, from + (k < 3 ? FRAME_VERTICES : CORNER_VERTICES));
}
/** The bounding box's centre along an axis: a capped cylinder's axis, where the vertex mean is pulled toward its seam. */
const centre = (vs: readonly Vector3[], axis: "x" | "y" | "z") => (Math.min(...vs.map((v) => v[axis])) + Math.max(...vs.map((v) => v[axis]))) / 2;

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "jet");
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
  canopy = worldTriangles(named("jet-bubble-canopy"));
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the F-16's eye", () => {
  it("is the catalogue's (2.22, 0.94, 0), on the centreline, and this phase did not move it", () => {
    expect([EYE.forward, EYE.up, EYE.right]).toEqual([2.22, 0.94, 0]);
  });

  it("hides the same opaque skin as before and nothing more: the fuselage, the radome and the spine", () => {
    expect([...aircraft.cockpitParts].map((part) => part.name).sort()).toEqual(["jet-dorsal-spine", "jet-fuselage", "radar-nose"]);
    for (const mesh of aircraft.meshes) {
      const hidden = (mesh.layerMask & camera.layerMask) === 0;
      expect(hidden, `${mesh.name} in cockpit view`).toBe(aircraft.cockpitParts.includes(mesh));
    }
  });
});

describe("the canopy from the seat", () => {
  /** The drawn-faces convention, measured on a box: a drawn face's cross product points INTO the solid. */
  function nearestCanopyFaces(offset: number): { rays: number; drawn: number } {
    let rays = 0;
    let drawn = 0;
    for (let az = -37 + offset; az <= 37; az += 1) {
      for (let el = -21 + offset; el <= 21; el += 1) {
        const d = direction(az, el);
        let best = Number.POSITIVE_INFINITY;
        let nearest: Triangle | null = null;
        for (const t of canopy) {
          const h = hitTriangle(EYE_POINT, d, t);
          if (Number.isFinite(h) && h > 0.08 && h < best) {
            best = h;
            nearest = t;
          }
        }
        if (!nearest) continue;
        rays += 1;
        if (Vector3.Dot(Vector3.Cross(nearest.b.subtract(nearest.a), nearest.c.subtract(nearest.a)), d) > 0) drawn += 1;
      }
    }
    return { rays, drawn };
  }

  it("is drawn because the glass is TWO-SIDED, not because a culling flag flips: from inside, every nearest face is a back face", () => {
    const glass = named("jet-bubble-canopy").material as PBRMaterial;
    const mesh = named("jet-bubble-canopy");
    // in cockpit view: the windscreen alpha, the material two-sided, the mesh on a layer the camera draws
    expect(glass.alpha).toBe(0.16);
    expect(glass.backFaceCulling, "the canopy's material culls nothing").toBe(false);
    expect(mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0, "the canopy is drawn by the cockpit camera").toBe(true);
    expect(glass.needAlphaBlendingForMesh(mesh), "and it is alpha-blended").toBe(true);
    // THE POSITIVE CONTROL that the eye is INSIDE the bubble: by the one-sided convention the GPU would draw NONE
    // of the canopy's nearest faces from the seat -- 3,108 rays of the frame grid, 0 drawn, at both offsets.
    // A one-sided material would therefore show no canopy at all from inside; this one shows its inside.
    for (const offset of [0.37, 0.61]) {
      const tally = nearestCanopyFaces(offset);
      expect(tally.rays, `rays of the frame grid that meet the canopy, offset ${offset}`).toBeGreaterThan(3000);
      expect(tally.drawn, `nearest canopy faces a ONE-SIDED material would draw from the seat, offset ${offset}`).toBe(0);
    }
  });

  it("goes back to its exterior look on exit, and the two-sidedness is not what changes with the view", () => {
    const glass = named("jet-bubble-canopy").material as PBRMaterial;
    aircraft.setCockpitView(false);
    try {
      expect(glass.alpha).toBe(0.86);
      expect(glass.backFaceCulling).toBe(false);
    } finally {
      aircraft.setCockpitView(true);
    }
    expect(glass.alpha).toBe(0.16);
  });
});

describe("the coaming", () => {
  it("stands a rounded rail on the deck line: the silhouette straight ahead at the catalogue's -10.19 by ray, the round's tangent a vertex on it", () => {
    const deck = aircraftSpec("jet").cockpitDeckLineDegrees;
    expect(deck).toBe(10.19);
    const edge = silhouette("jet-glare-shield", 0, 5, 0.005);
    expect(Math.abs(edge + deck), `the silhouette by ray, ${edge.toFixed(3)}`).toBeLessThan(0.01);
    const g = JET_GLARESHIELD;
    const section = jetGlareshieldSection();
    const sight = deck / DEG;
    // the round: its centre `radius` forward of the aft face and `radius` under the sight line; the tangent ON the line,
    // a vertex of the outline, and every vertex of the round on its circle
    expect(section.centre.x - g.aftX).toBeCloseTo(g.radius, 12);
    expect(Math.sin(sight) * (section.centre.x - EYE.forward) + Math.cos(sight) * (section.centre.y - EYE.up)).toBeCloseTo(-g.radius, 12);
    expect(Math.atan2(section.tangent.y - EYE.up, section.tangent.x - EYE.forward) * DEG).toBeCloseTo(-deck, 9);
    expect(section.outline.some((v) => v.x === section.tangent.x && v.y === section.tangent.y), "the tangent is a vertex").toBe(true);
    for (const v of section.round) expect(Math.hypot(v.x - section.centre.x, v.y - section.centre.y)).toBeCloseTo(g.radius, 12);
    // the BUILT mesh: its highest row anywhere (a line along z reads one row: dy/dx) is the tangent's (float32 vertices)
    const row = (v: { x: number; y: number }) => (v.y - EYE.up) / (v.x - EYE.forward);
    expect(Math.max(...worldVertices(named("jet-glare-shield")).map(row))).toBeCloseTo(-Math.tan(sight), 5);
  });

  it("hides the nose: the air-data probe, whose tip reads -10.41, is behind the coaming, and so is the radome's crown at -11.23", () => {
    // Everything of the nose the cockpit camera draws. The radome and the fuselage are off its layer mask, the
    // probe is not: at a far edge of -13.0 the probe stood 2.6 degrees clear of the coaming, a needle with nothing
    // under it. An F-16 pilot does not see the nose.
    const highest = (name: string) => Math.max(...worldVertices(named(name)).map((v) => azel(v).el));
    const probeTop = highest("jet-air-data-probe");
    expect(probeTop).toBeGreaterThan(-10.45);
    expect(probeTop).toBeLessThan(-10.4);
    expect(highest("radar-nose")).toBeLessThan(-11.2);
    expect(silhouette("jet-glare-shield", 0) - probeTop, "the coaming's edge over the probe's tip, degrees").toBeGreaterThan(0.15);
    // by ray, over the probe's own width: the first surface at every elevation from the tip down is the deck, the rail
    // and then, under the cove's foot, the dash
    for (let az = -0.3; az <= 0.3; az += 0.05) {
      for (let e = probeTop + 0.02; e >= -20; e -= 0.05) expect(["jet-glare-shield", "jet-instrument-panel"], `azimuth ${az.toFixed(2)}, elevation ${e.toFixed(2)}`).toContain(firstHit(az, e)?.name);
    }
    // THE CONTROL: the instrument can see the probe -- with the coaming and the HUD's housing (behind the rail, in
    // front of the probe) left out, it is the first surface just under its tip straight ahead
    const withoutCoaming = scene.pickWithRay(new Ray(EYE_POINT, direction(0, probeTop - 0.01), 60), (mesh) => drawnByCockpitCamera(mesh) && mesh.name !== "jet-glare-shield" && mesh.name !== "jet-hud-housing");
    expect(withoutCoaming?.pickedMesh?.name).toBe("jet-air-data-probe");
  });

  it("turns a 45 degree cove under the round down to the dash at -12.68: the deck's edge 2.5 degrees, by ray the rail, the cove, then the board", () => {
    const g = JET_GLARESHIELD;
    const section = jetGlareshieldSection();
    const coaming = named("jet-glare-shield");
    const vertices = worldVertices(coaming);
    const normals = coaming.getVerticesData(VertexBuffer.NormalKind)!;
    // the cove by its built normals (flat-shaded, three vertices a triangle): facing down and aft at 45 degrees
    const cove: Vector3[] = [];
    let coveNormal: Vector3 | null = null;
    for (let i = 0; i < vertices.length; i += 1) {
      const n = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      if (Math.abs(n.x + Math.SQRT1_2) < 1e-6 && Math.abs(n.y + Math.SQRT1_2) < 1e-6) {
        cove.push(vertices[i]!);
        coveNormal = n;
      }
    }
    expect(cove.length, "the cove's vertices: a quad, two triangles").toBe(6);
    // (float32: a micrometre at these stations)
    expect(Math.min(...cove.map((v) => v.x))).toBeCloseTo(g.aftX, 5);
    expect(Math.max(...cove.map((v) => v.x)) - g.aftX, "the cove's run").toBeCloseTo(g.cove, 5);
    expect(Math.max(...cove.map((v) => v.y)) - Math.min(...cove.map((v) => v.y)), "the cove's fall").toBeCloseTo(g.cove, 5);
    for (const v of cove) expect(Vector3.Dot(coveNormal!, EYE_POINT.subtract(v)), "the cove faces the eye").toBeGreaterThan(0);
    // the deck's edge the pilot reads, from the rail's tangent to the cove's foot: the least round and cove that read
    const el = (v: { x: number; y: number }) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG;
    const foot = el(section.faceTop);
    console.info(`F-16 deck: the rail at ${el(section.tangent).toFixed(3)}, the cove's foot at ${foot.toFixed(3)}, the edge ${(el(section.tangent) - foot).toFixed(3)} degrees`);
    expect(foot).toBeCloseTo(-12.68, 2);
    expect(el(section.tangent) - foot).toBeLessThan(2.6);
    // by ray, straight ahead: the rail down to the cove's foot (the cove's middle ON the cove), then the board, the dash
    const coveMiddle = (el(section.coveTop) + foot) / 2;
    const hit = firstHitInfo(0, coveMiddle);
    expect(hit?.pickedMesh?.name, "straight ahead, the cove's middle").toBe("jet-glare-shield");
    expect(hit!.pickedPoint!.x - g.aftX, "and the hit is on the cove").toBeGreaterThan(0.0005);
    for (let e = -10.25; e > foot + 0.02; e -= 0.05) expect(firstHit(0, e)?.name, `at elevation ${e.toFixed(2)}`).toBe("jet-glare-shield");
    for (let e = foot - 0.02; e >= -20; e -= 0.1) {
      const board = firstHitInfo(0, e);
      expect(board?.pickedMesh?.name, `at elevation ${e.toFixed(2)}`).toBe("jet-instrument-panel");
      // on the leaned face: the plane through the cove's foot, square to the face's normal
      const face = jetPanelFace();
      const q = board!.pickedPoint!;
      expect((q.x - face.top.x) * face.normal.x + (q.y - face.top.y) * face.normal.y, `the point at elevation ${e.toFixed(2)} is on the board's face`).toBeCloseTo(0, 3);
    }
  });

  it("reads ONE ROW across the rail from az -25 to 25, its own solid ending at az +-26.5, and nothing of it (its ends too) stands over that row anywhere in the frame", () => {
    // A straight rail along z reads one row of the picture: tan(el) / cos(az) is the deck line's wherever it is seen
    // (its elevation is highest at its ends only because the frame is a rectangle). Read off the coaming's OWN
    // triangles: at az +-5.96 to 7.05 the HUD frame's uprights stand in front of it, and its edge is still where it is.
    const coaming = worldTriangles(named("jet-glare-shield"));
    const ownTop = (az: number) => {
      for (let e = 5; e >= -30; e -= 0.005) if (crossings(EYE_POINT, direction(az, e), coaming).length > 0) return e;
      return Number.NaN;
    };
    const want = -Math.tan(aircraftSpec("jet").cockpitDeckLineDegrees / DEG);
    for (let az = -25; az <= 25; az += 2.5) {
      const top = ownTop(az);
      expect(Number.isFinite(top), `the rail at azimuth ${az}`).toBe(true);
      expect(Math.tan(top / DEG) / Math.cos(az / DEG), `the row at azimuth ${az}`).toBeCloseTo(want, 3);
    }
    // the rail's own solid's ends, from its own vertices: the 0.36 half-width, 0.70 ahead of the eye (from az 25 its
    // ends sweep aft and down into the sills, step 5)
    const rail = railVertices().filter((v) => v.x < JET_GLARESHIELD.aftX + JET_GLARESHIELD.radius * 2);
    const ends = Math.max(...rail.map((v) => Math.abs(azel(v).az)));
    expect(ends).toBeGreaterThan(26.5);
    expect(ends).toBeLessThan(27.5);
    // and no vertex of the coaming reads over the row (float32: 2 micrometres in 0.7 m)
    for (const v of worldVertices(named("jet-glare-shield"))) {
      expect((v.y - EYE.up) / (v.x - EYE.forward), `vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`).toBeLessThanOrEqual(want + 1e-5);
    }
  });

  it("is the rounded deck it was designed to be: a solidPlate of the section, 0.36 wide at the rail narrowing to 0.26 at the hood's end, the hood falling 13 degrees, flat-shaded but for the round, inside the bubble by 2 cm", () => {
    const g = JET_GLARESHIELD;
    const section = jetGlareshieldSection();
    const mesh = named("jet-glare-shield");
    expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom?.[0], "the rail first, its ends after it").toBe("jet-glare-shield-rail");
    const vertices = railVertices();
    const n = section.outline.length;
    expect(n, "no drop: the round, the cove's foot, the hood's two forward corners").toBe(g.roundSegments + 2 + 3);
    expect(RAIL_VERTICES / 3, "two fanned caps and a wall of two a side").toBe(2 * (n - 2) + 2 * n);
    expect(vertices.length).toBe(3 * (2 * (n - 2) + 2 * n));
    // every vertex on the section, at the plan's half-width for its station (float32)
    for (const v of vertices) {
      expect(section.outline.some((o) => Math.abs(o.x - v.x) < 1e-5 && Math.abs(o.y - v.y) < 1e-5), `vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) on the section`).toBe(true);
      expect(Math.abs(Math.abs(v.z) - jetCoamingHalfWidth(v.x)), `vertex z ${v.z} at x ${v.x}`).toBeLessThan(1e-5);
    }
    expect(Math.max(...vertices.map((v) => Math.abs(v.z)))).toBeCloseTo(0.36, 5);
    const endX = g.aftX + g.hoodDepth;
    expect(Math.max(...vertices.filter((v) => Math.abs(v.x - endX) < 1e-5).map((v) => Math.abs(v.z)))).toBeCloseTo(0.26, 5);
    // the hood: its top from the round's forward tangent and its underside from the cove's foot, both falling 13
    // degrees, steeper than the 10.19 sight line, so past the round nothing of it rises to the line
    const ends = section.outline.filter((v) => v.x === endX);
    expect(ends, "the hood's forward end: two corners").toHaveLength(2);
    const top = Math.max(...ends.map((v) => v.y));
    const bottom = Math.min(...ends.map((v) => v.y));
    expect(Math.atan2(section.round[0]!.y - top, endX - section.round[0]!.x) * DEG, "the hood's top falls").toBeCloseTo(13, 9);
    expect(Math.atan2(section.faceTop.y - bottom, endX - section.faceTop.x) * DEG, "its underside falls with it").toBeCloseTo(13, 9);
    expect(g.hoodFallDegrees).toBeGreaterThan(aircraftSpec("jet").cockpitDeckLineDegrees);
    // flat normals, one per triangle, pointing OUT, the winding agreeing (a drawn face's cross product points INTO the
    // solid); the sculpted solid is convex (a prism cut by a plan that only narrows), so its centroid is inside. The
    // round's chords (the next test) take the round's own normal at each corner; their mean is the chord's.
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = mesh.getIndices()!.slice(0, RAIL_VERTICES);
    const middle = vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);
    const onRound = (v: Vector3) => section.round.some((r) => Math.abs(r.x - v.x) < 1e-5 && Math.abs(r.y - v.y) < 1e-5);
    let chords = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const nn = [0, 1, 2].map((k) => new Vector3(normals[indices[t + k]! * 3]!, normals[indices[t + k]! * 3 + 1]!, normals[indices[t + k]! * 3 + 2]!));
      const corners = [0, 1, 2].map((k) => vertices[indices[t + k]!]!);
      const chord = Math.abs(nn[0]!.z) < 0.5 && corners.every(onRound);
      if (chord) chords += 1;
      else {
        expect(Vector3.Distance(nn[0]!, nn[1]!)).toBeLessThan(1e-6);
        expect(Vector3.Distance(nn[0]!, nn[2]!)).toBeLessThan(1e-6);
      }
      const mean = nn[0]!.add(nn[1]!).add(nn[2]!).normalize();
      const faceCentre = corners[0]!.add(corners[1]!).add(corners[2]!).scale(1 / 3);
      expect(Vector3.Dot(mean, faceCentre.subtract(middle)), `triangle ${t / 3}: its normal points out`).toBeGreaterThan(0);
      const inward = Vector3.Cross(corners[1]!.subtract(corners[0]!), corners[2]!.subtract(corners[0]!)).normalize();
      expect(Vector3.Dot(mean, inward), `triangle ${t / 3}: its winding agrees with its normal`).toBeLessThan(chord ? -0.99 : -0.999);
    }
    expect(chords, "the round's nine chords, two triangles each").toBe(2 * (section.round.length - 1));
    // INSIDE THE BUBBLE, by 2 cm at the least (the rail's top ends, where the canopy closes in: at 0.38 wide they
    // came within 1.1 mm of the glass): every vertex under the glass, and its distance to the nearest glass triangle
    let nearest = Number.POSITIVE_INFINITY;
    for (const v of vertices) {
      expect(crossings(v, new Vector3(0, 1, 0), canopy).length % 2, `vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) inside the bubble`).toBe(1);
      nearest = Math.min(nearest, distanceToTriangles(v, canopy));
    }
    console.info(`F-16 coaming: nearest glass ${nearest.toFixed(4)} m`);
    expect(nearest).toBeGreaterThanOrEqual(0.02);
  });

  it("shades its round as a curve: at each of the round's points one normal, the round's own, so adjacent chords differ by the angle between them, not flat, and no hard edge along it (the same 144 vertices)", () => {
    // flat-shaded, the eight chords banded at about 20 px each across the rail (step 3)
    const section = jetGlareshieldSection();
    const mesh = named("jet-glare-shield");
    expect(railVertices().length, "no vertex added: the chords' own corners re-pointed").toBe(144);
    // the rail's own part (its swept ends, step 5, are held by their own tests)
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!.slice(0, RAIL_VERTICES * 3);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!.slice(0, RAIL_VERTICES * 3);
    const radial = (r: { x: number; y: number }) => new Vector3(r.x - section.centre.x, r.y - section.centre.y, 0).normalize();
    /** Every wall vertex (not a cap's) at the round's point `r`, its normal. */
    const at = (r: { x: number; y: number }) => {
      const found: Vector3[] = [];
      for (let i = 0; i < positions.length / 3; i += 1) {
        if (Math.abs(positions[i * 3]! - r.x) > 1e-6 || Math.abs(positions[i * 3 + 1]! - r.y) > 1e-6) continue;
        const n = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
        if (Math.abs(n.z) < 0.5) found.push(n);
      }
      return found;
    };
    const last = section.round.length - 1;
    section.round.forEach((r, k) => {
      const found = at(r);
      // two chords meet at an inner point (four vertices a side); the round's ends are where it meets the hood's top and the cove
      expect(found.length, `round point ${k}: its vertices`).toBeGreaterThanOrEqual(4);
      // the round's own normal at every one of them but, at the aft end, the cove's (the crease under the rail, 45 degrees)
      const own = found.filter((n) => Vector3.Dot(n, radial(r)) > 1 - 1e-6);
      expect(own.length, `round point ${k}: the round's normal on its chords (the hood's top too, at the hood's tangent)`).toBe(k === last ? found.length / 2 : found.length);
    });
    for (let k = 0; k < last; k += 1) {
      const a = at(section.round[k]!).find((n) => Vector3.Dot(n, radial(section.round[k]!)) > 1 - 1e-6)!;
      const b = at(section.round[k + 1]!).find((n) => Vector3.Dot(n, radial(section.round[k + 1]!)) > 1 - 1e-6)!;
      const turn = Math.acos(Math.min(1, Vector3.Dot(a, b))) * DEG;
      const chordAngle = Math.acos(Vector3.Dot(radial(section.round[k]!), radial(section.round[k + 1]!))) * DEG;
      expect(turn, `chord ${k}: its ends' normals turn by the chord's angle`).toBeCloseTo(chordAngle, 3);
      expect(turn, `chord ${k}: not flat`).toBeGreaterThan(2);
    }
    // the crease the round keeps: under the rail into the 45 degree cove, a quarter turn and a half from the aft face
    const cove = at(section.round[last]!).filter((n) => Vector3.Dot(n, radial(section.round[last]!)) < 1 - 1e-6);
    for (const n of cove) expect(Math.atan2(n.y, n.x) * DEG).toBeCloseTo(-135, 3);
  });

  it("keeps its exterior job on the MATTE glareshield material: an ordinary part, cockpitInterior, never a caster, visible from outside", () => {
    const mesh = named("jet-glare-shield");
    expect(cockpitOnly.map((part) => part.name)).not.toContain("jet-glare-shield");
    expect((mesh.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBeUndefined();
    expect((mesh.metadata as { cockpitInterior?: boolean }).cockpitInterior).toBe(true);
    expect((mesh.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    // the frame's instance, and matte: no image-based light, no specular F0. On the airframe's dark (the sill's
    // material) the near-flat top caught the sky at grazing angles and read from the seat as a pale shelf.
    const material = mesh.material as PBRMaterial;
    expect(material, "the one glareshield instance the HUD frame wears").toBe(named("jet-hud-frame").material);
    expect(material.name).toBe("jet-glareshield");
    expect(material.environmentIntensity, "the sky's diffuse light: with none, the faces the sun missed rendered (0, 0, 0)").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect(material.metallicF0Factor).toBe(0);
    expect(material.roughness).toBe(1);
    expect(material, "no longer the airframe's dark").not.toBe(named("jet-canopy-sill").material);
    // HOW it is drawn, which no ray can see: one-sided, back faces culled (not front: `cullBackFaces` false would
    // draw the wedge's far walls and show it hollow), opaque, writing depth, in the airframe's rendering group --
    // the HUD frame's feet are buried in it, which only hides them if the two share one depth buffer
    expect(material.backFaceCulling).toBe(true);
    expect(material.cullBackFaces).toBe(true);
    expect(material.disableDepthWrite).toBe(false);
    expect(material.alpha).toBe(1);
    expect(material.needAlphaBlendingForMesh(mesh)).toBe(false);
    const frame = named("jet-hud-frame");
    expect([mesh.renderingGroupId, frame.renderingGroupId], "the coaming and the frame in one rendering group").toEqual([
      named("jet-canopy-sill").renderingGroupId,
      named("jet-canopy-sill").renderingGroupId,
    ]);
    // and DARK, as the other decks' hoods are pinned: a near-black, below the board's interior grey
    const albedo = material.albedoColor;
    const board = (named("jet-instrument-panel").material as PBRMaterial).albedoColor;
    for (const [channel, value] of [["r", albedo.r], ["g", albedo.g], ["b", albedo.b]] as const) {
      expect(value, `albedo ${channel}`).toBeGreaterThan(0.03);
      expect(value, `albedo ${channel}`).toBeLessThan(0.08);
      expect(value, `albedo ${channel}, darker than the board`).toBeLessThan(board[channel]);
    }
    aircraft.setCockpitView(false);
    try {
      expect(mesh.isVisible).toBe(true);
      expect(mesh.isEnabled()).toBe(true);
    } finally {
      aircraft.setCockpitView(true);
    }
  });

  it("fills the bottom of the frame straight ahead with the deck: from -10.19 to the frame's bottom every ray meets the rail or the dash", () => {
    let rays = 0;
    for (let e = -10.25; e >= -frameLimit(0); e -= 0.05) {
      expect(["jet-glare-shield", "jet-instrument-panel"], `at elevation ${e.toFixed(2)}`).toContain(firstHit(0, e)?.name);
      rays += 1;
    }
    expect(rays).toBeGreaterThan(250);
    // THE CONTROL: over the rail, clear of the HUD's housing (az 9), nothing: the deck line is the edge; straight ahead,
    // just over the rail, the housing's hump
    expect(firstHit(9, -9.95)).toBeNull();
    expect(firstHit(0, -10.1)?.name).toBe("jet-hud-housing");
  });
});

describe("the HUD frame", () => {
  it("is one of the seven cockpit-only meshes (with its housing, its combiner, the MFDs' frames and rims, the screens and the sills), three struts and two rounded corners merged on the shared matte glareshield material", () => {
    expect(cockpitOnly.map((part) => part.name)).toEqual(["jet-hud-frame", "jet-hud-housing", "jet-hud-combiner", "jet-mfd-frames", "jet-mfd-rims", "jet-screens", "jet-sills"]);
    const frame = named("jet-hud-frame");
    expect((frame.metadata as { mergedFrom?: string[] }).mergedFrom).toEqual(FRAME_SOURCES);
    expect(frame.getTotalVertices()).toBe(FRAME_VERTICES * 3 + CORNER_VERTICES * 2);
    expect(frame.getIndices()!.length / 3).toBe(FRAME_TRIANGLES * 3 + CORNER_TRIANGLES * 2);
    const material = frame.material as PBRMaterial;
    expect(material.name).toBe("jet-glareshield");
    expect(material.environmentIntensity, "lit by the sky; matte: reflects nothing").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect(material.metallicF0Factor).toBe(0);
    expect(material.metallicF0Factor).toBe(0);
    expect(material.roughness).toBe(1);
    expect(scene.materials.filter((m) => m.name === "jet-glareshield"), "one instance").toHaveLength(1);
    expect((frame.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBe(true);
    expect((frame.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    // the HUD is the frame, its housing and its combiner, and no mesh is glass but the canopy and the combiner (step 2)
    expect(scene.meshes.filter((m) => /hud/i.test(m.name)).map((m) => m.name)).toEqual(["jet-hud-frame", "jet-hud-housing", "jet-hud-combiner"]);
    expect(scene.meshes.filter((m) => m.getTotalVertices() > 0 && (m.material as PBRMaterial | null)?.needAlphaBlendingForMesh(m) && m.isEnabled()).map((m) => m.name)).toEqual(["jet-bubble-canopy", "jet-hud-combiner"]);
  });

  it("stands its uprights at az +-6.5 and its bar at +4.5, in one vertical plane at x 3.05, a box that contains (0, 0)", () => {
    const port = frameBlock("port");
    const starboard = frameBlock("starboard");
    const bar = frameBlock("bar");
    // THE AXIS IS THE BOUNDING BOX'S CENTRE, not the vertex mean: Babylon's capped cylinder repeats its seam
    // vertex in every ring and adds cap centres, which pulls the mean 1.3 mm toward the seam (it read 3.15131
    // when the frame stood at 3.15).
    for (const block of [port, starboard, bar]) expect(centre(block, "x")).toBeCloseTo(3.05, 6);
    const portAz = Math.atan2(centre(port, "z"), centre(port, "x") - EYE.forward) * DEG;
    const starboardAz = Math.atan2(centre(starboard, "z"), centre(starboard, "x") - EYE.forward) * DEG;
    expect(Math.abs(portAz + 6.5)).toBeLessThan(0.1);
    expect(Math.abs(starboardAz - 6.5)).toBeLessThan(0.1);
    const barEl = Math.atan2(centre(bar, "y") - EYE.up, centre(bar, "x") - EYE.forward) * DEG;
    expect(Math.abs(barEl - 4.5)).toBeLessThan(0.1);
    expect(Math.abs(jetHudFrameAngles().uprightAzimuthDegrees - 6.5)).toBeLessThan(0.1);
    expect(Math.abs(jetHudFrameAngles().barElevationDegrees - 4.5)).toBeLessThan(0.1);
    // the box contains (0, 0): the uprights either side of it, the bar above it and the feet below it
    expect(portAz).toBeLessThan(0);
    expect(starboardAz).toBeGreaterThan(0);
    expect(barEl).toBeGreaterThan(0);
    expect(azel(new Vector3(centre(port, "x"), Math.min(...port.map((v) => v.y)), 0)).el, "the feet, from the mesh").toBeLessThan(0);
    // radius 0.005 END TO END: the struts are untapered (`strutBetween` made every `from` end 8% fatter, and the
    // bar was lopsided on screen by 1.5 px). Ring vertices of an upright, and of the bar, stand 0.005 off the axis.
    // (5 mm since the combiner's glass (step 2); 8 before it, and the first 12 read as a black doorway, the uprights
    // about 30 px wide at 1600.)
    for (const [which, upright] of [["port", port], ["starboard", starboard]] as const) {
      const axisZ = centre(upright, "z");
      const uprightRadial = upright.map((v) => Math.hypot(v.x - 3.05, v.z - axisZ)).filter((r) => r > 0.003);
      expect(Math.min(...uprightRadial), `the ${which} upright's thinnest ring`).toBeCloseTo(0.005, 4);
      expect(Math.max(...uprightRadial), `the ${which} upright's fattest ring`).toBeCloseTo(0.005, 4);
    }
    const barRadial = bar.map((v) => Math.hypot(v.x - 3.05, v.y - JET_HUD_FRAME.barY)).filter((r) => r > 0.003);
    expect(Math.min(...barRadial), "the bar's thinnest ring").toBeCloseTo(0.005, 4);
    expect(Math.max(...barRadial), "the bar's fattest ring").toBeCloseTo(0.005, 4);
    // THE CORNERS ARE ROUNDED (step 5b): the uprights run up to, and the bar out to, where a quarter circle of
    // centreline radius 0.025 takes over, tangent to both (square, the bar ran between the uprights' axes and the
    // uprights up to the bar's top)
    const R = JET_HUD_FRAME.cornerRadius;
    expect(R).toBe(0.025);
    expect(Math.max(...bar.map((v) => Math.abs(v.z)))).toBeCloseTo(JET_HUD_FRAME.z - R, 4);
    expect(Math.max(...starboard.map((v) => v.y))).toBeCloseTo(JET_HUD_FRAME.barY - R, 4);
    for (const [which, side] of [["port corner", -1], ["starboard corner", 1]] as const) {
      const corner = frameBlock(which);
      const axis = jetHudFrameCornerAxis(side);
      // its centreline: from the upright's axis at its top, round to the bar's axis at its end
      expect([axis[0]!.y, Math.abs(axis[0]!.z)], `${which} leaves the upright`).toEqual([expect.closeTo(JET_HUD_FRAME.barY - R, 12), expect.closeTo(JET_HUD_FRAME.z, 12)]);
      expect([axis[axis.length - 1]!.y, Math.abs(axis[axis.length - 1]!.z)], `${which} meets the bar`).toEqual([expect.closeTo(JET_HUD_FRAME.barY, 12), expect.closeTo(JET_HUD_FRAME.z - R, 12)]);
      // a tube of the rods' radius round a quarter circle of R about (barY - R, z - R), in the frame's plane
      const centreY = JET_HUD_FRAME.barY - R;
      const centreZ = side * (JET_HUD_FRAME.z - R);
      for (const v of corner) {
        const inPlane = Math.hypot(v.y - centreY, v.z - centreZ);
        expect(Math.hypot(v.x - JET_HUD_FRAME.x, inPlane - R), `${which} vertex off its centreline`).toBeCloseTo(JET_HUD_FRAME.radius, 6);
      }
    }
  });

  it("rises from its housing: seen from the housing's top up to the bar, the housing under it, the rail under that", () => {
    const housing = worldTriangles(named("jet-hud-housing"));
    for (const side of [-1, 1] as const) {
      const az = side * jetHudFrameAngles().uprightAzimuthDegrees;
      let foot = Number.NaN;
      for (let e = -20; e <= 0; e += 0.01) {
        if (firstHit(az, e)?.name === "jet-hud-frame") {
          foot = e;
          break;
        }
      }
      expect(Number.isFinite(foot), `the upright at azimuth ${az.toFixed(1)}`).toBe(true);
      // the housing's own top at this azimuth: the upright is first seen just over it
      let top = Number.NaN;
      for (let e = -8; e >= -11; e -= 0.005) if (crossings(EYE_POINT, direction(az, e), housing).length > 0) { top = e; break; }
      console.info(`F-16 HUD frame: the upright at azimuth ${az.toFixed(1)} first seen at ${foot.toFixed(2)}, over the housing's ${top.toFixed(3)} (it was the rail's -10.12)`);
      expect(Math.abs(foot - top), `the foot ${foot.toFixed(2)} against the housing's ${top.toFixed(2)}`).toBeLessThan(0.05);
      expect(firstHit(az, foot - 0.1)?.name).toBe("jet-hud-housing");
      let upright = 0;
      for (let e = foot + 0.1; e <= 4; e += 0.25) {
        expect(firstHit(az, e)?.name, `at elevation ${e.toFixed(2)}`).toBe("jet-hud-frame");
        upright += 1;
      }
      expect(upright).toBeGreaterThan(45);
    }
    // straight ahead, over the housing, there is nothing opaque but the bar: the symbology's window is open from the
    // housing's top (-8.6) to the bar's underside (+4.15)
    for (let e = -8.5; e <= 3.55; e += 0.25) expect(firstHit(0, e)?.name ?? null, `something at azimuth 0, elevation ${e.toFixed(2)}`).toBeNull();
    expect(firstHit(0, jetHudFrameAngles().barElevationDegrees)?.name).toBe("jet-hud-frame");
  });

  it("stands the uprights' feet in the housing's mount: 1.5 cm under its top, a centimetre clear of the hood, measured against the meshes' own triangles", () => {
    // Measured, not restated: the housing's top over each foot and the hood under it by vertical rays against their
    // own triangles, and every foot vertex INSIDE the closed housing (an odd number of crossings upward). The housing
    // stands 2.6 cm over the hood there, capped by its top falling faster than the eye's sight line (2 cm deep would
    // lift its hump to -8.3).
    // (A ray survey that looked for the foot caps from the eye used to stand here. It could not fail: a cap faces
    // down, so from an eye above it a ray meets the strut's wall first whatever the cap's winding or depth. What
    // hides a cap is that it is culled, held by the test below, and that the foot is buried, held here.)
    const housing = worldTriangles(named("jet-hud-housing"));
    const coaming = railTriangles();
    for (const which of ["port", "starboard"] as const) {
      const block = frameBlock(which);
      const lowest = Math.min(...block.map((v) => v.y));
      const foot = block.filter((v) => Math.abs(v.y - lowest) < 1e-4);
      // the bottom ring of the side wall (9), the cap's ring (9) and its centre (1)
      expect(foot.length, `${which} foot vertices`).toBe(19);
      const axis = new Vector3(centre(foot, "x"), lowest, centre(foot, "z"));
      const up = crossings(axis, new Vector3(0, 1, 0), housing);
      expect(up.length, `${which}: the foot's axis is inside the housing (one crossing up, through its top)`).toBe(1);
      // (to a tenth of a millimetre: the facets chord the round shoulder between the loft's stations)
      expect(up[0]!, `${which}: depth under the housing's top`).toBeCloseTo(0.015, 3);
      const down = crossings(axis, new Vector3(0, -1, 0), coaming);
      expect(down[0]!, `${which}: clear of the hood`).toBeGreaterThanOrEqual(0.01);
      for (const v of foot) {
        expect(crossings(v, new Vector3(0, 1, 0), housing).length % 2, `${which} foot vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) inside the housing`).toBe(1);
        expect(crossings(v, new Vector3(0, 1, 0), coaming).length, "and out of the hood").toBe(0);
      }
    }
  });

  it("turns every strut end AWAY from the only camera that draws the frame: the feet face down, the tops up, the bar's ends outboard", () => {
    // The frame is cockpit-only, so the pilot's eye is the only viewpoint that matters, and from it every end cap
    // is a BACK face by construction: the feet are below the eye and face down, the uprights' tops are above it and
    // face up, the bar's ends are either side of it and face outboard. A ray survey from the eye can never find one,
    // so that is asserted directly -- every cap triangle is culled by the drawn-face rule from the eye -- and the
    // control proves the rule sees drawn faces at all: the struts' side walls facing the eye ARE drawn.
    const frame = named("jet-hud-frame");
    const triangles = worldTriangles(frame);
    const footY = jetHudFrameFootY();
    // the uprights' tops and the bar's ends where the corners' rounds take over (step 5b): inside the corners' tubes
    const topY = JET_HUD_FRAME.barY - JET_HUD_FRAME.cornerRadius;
    const f = JET_HUD_FRAME;
    const barEnd = f.z - f.cornerRadius;
    const flat = (t: Triangle, pick: (v: Vector3) => number, value: number) => [t.a, t.b, t.c].every((v) => Math.abs(pick(v) - value) < 1e-4);
    const caps = {
      feet: triangles.filter((t) => flat(t, (v) => v.y, footY)),
      tops: triangles.filter((t) => flat(t, (v) => v.y, topY) && [t.a, t.b, t.c].every((v) => Math.abs(Math.abs(v.z) - f.z) < f.radius + 1e-4)),
      // each end is flat at ONE z (flat in |z| would also take the bar's own side walls, which run end to end)
      barEnds: triangles.filter((t) => (flat(t, (v) => v.z, barEnd) || flat(t, (v) => v.z, -barEnd)) && [t.a, t.b, t.c].every((v) => Math.abs(v.y - f.barY) < f.radius + 1e-4)),
    };
    const drawnFromEye = (t: Triangle) => {
      const toward = t.a.add(t.b).add(t.c).scale(1 / 3).subtract(EYE_POINT);
      return Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), toward) > 0;
    };
    for (const [which, list] of Object.entries(caps)) {
      // NON-VACUITY: each kind of end is there to judge (an 8-sided cap is 8 triangles; two of each)
      expect(list.length, `${which}: cap triangles found`).toBe(16);
      expect(list.filter(drawnFromEye).length, `${which}: cap triangles the GPU would draw from the eye`).toBe(0);
    }
    // THE CONTROL: the rule does see drawn faces on this mesh -- the side walls facing the eye
    const sides = triangles.filter((t) => !Object.values(caps).some((list) => list.includes(t)));
    expect(sides.filter(drawnFromEye).length, "side-wall triangles drawn from the eye").toBeGreaterThan(20);
  });

  it("clears the BUILT canopy by at least 0.05 m everywhere: 0.086 at the frame's rounded top corners, 0.1 m nearer the eye than the design put it", () => {
    // At the design's x 3.15 the frame cleared the built glass by only 0.021 (at the uprights' tops, by the same
    // nearest-triangle measure as below; the bar's ends by 0.023): the design assumed a crown of
    // 1.10 there, the loft's is 1.088 on the centreline and falls to 1.05 over the ends. At x 3.05 the crown is
    // 1.130 (1.097 over the bar's ends) and the same angles make a frame 0.1 m nearer and smaller. The clearance is
    // the distance from each vertex to the nearest glass TRIANGLE, not a vertical gap: the nearest glass to the
    // bar's corner is up and outboard of it.
    const crown = crossings(new Vector3(JET_HUD_FRAME.x, 0.5, 0), new Vector3(0, 1, 0), canopy);
    expect(crown.length).toBeGreaterThan(0);
    const crownY = 0.5 + crown[crown.length - 1]!;
    expect(crownY).toBeGreaterThan(1.12);
    expect(crownY).toBeLessThan(1.14);
    const frame = worldVertices(named("jet-hud-frame"));
    const upper = frame.filter((v) => v.y > EYE.up);
    expect(upper.length).toBeGreaterThan(30);
    const clearance = Math.min(...upper.map((v) => distanceToTriangles(v, canopy)));
    expect(clearance, "the frame is inside the glass").toBeGreaterThan(0);
    expect(clearance, "the design's clearance, against the built loft").toBeGreaterThanOrEqual(0.05);
    console.info(`F-16 HUD frame: nearest glass ${clearance.toFixed(4)} m`);
    // the record: 0.074 at 8 mm rods, a little more at 5; 0.086 with the corners rounded (step 5b)
    expect(clearance).toBeGreaterThan(0.08);
    expect(clearance).toBeLessThan(0.09);
    // and nothing of the frame pokes through: every vertex is under the crown line at its own station and z
    for (const v of upper) {
      const above = crossings(new Vector3(v.x, v.y, v.z), new Vector3(0, 1, 0), canopy);
      expect(above.length % 2, `vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) is inside the bubble`).toBe(1);
    }
  });

  it("is invisible outside cockpit view and visible in it, on a fresh aircraft", () => {
    const fresh = new NullEngine();
    const freshScene = new Scene(fresh);
    freshScene.useRightHandedSystem = true;
    const visual = createWebGpuAircraft(freshScene, "jet");
    try {
      const parts = visual.cockpitOnlyParts ?? [];
      expect(parts.map((part) => part.name)).toEqual(["jet-hud-frame", "jet-hud-housing", "jet-hud-combiner", "jet-mfd-frames", "jet-mfd-rims", "jet-screens", "jet-sills"]);
      for (const part of parts) expect(part.isVisible, `${part.name} outside cockpit view`).toBe(false);
      visual.setCockpitView(true);
      for (const part of parts) expect(part.isVisible, `${part.name} in cockpit view`).toBe(true);
      visual.setCockpitView(false);
      for (const part of parts) expect(part.isVisible, `${part.name} after cockpit view`).toBe(false);
    } finally {
      visual.dispose();
      freshScene.dispose();
      fresh.dispose();
    }
  });
});

describe("the HUD's housing (the F-16 pass, step 2)", () => {
  const housingOwn = () => worldTriangles(named("jet-hud-housing"));
  /** The housing's own silhouette at an azimuth, by its triangles (NaN where it is not along that line at all). */
  const ownTop = (triangles: readonly Triangle[], az: number) => {
    for (let e = -7; e >= -12; e -= 0.002) if (crossings(EYE_POINT, direction(az, e), triangles).length > 0) return e;
    return Number.NaN;
  };
  const railAt = (az: number) => Math.atan(-Math.tan(aircraftSpec("jet").cockpitDeckLineDegrees / DEG) * Math.cos(az / DEG)) * DEG;

  it("is a rounded box 0.22 wide on the hood behind the rail, between the uprights, about 3 cm proud where the frame stands, on the glareshield's matte", () => {
    const mesh = named("jet-hud-housing");
    const vertices = worldVertices(mesh);
    const zs = vertices.map((v) => v.z);
    expect(Math.min(...zs)).toBeCloseTo(-0.11, 5);
    expect(Math.max(...zs)).toBeCloseTo(0.11, 5);
    // behind the rail, and forward of the eye's side of the uprights: the uprights' feet (x 3.05, 5 mm rods) inside it
    expect(Math.min(...vertices.map((v) => v.x))).toBeCloseTo(JET_HUD_HOUSING.aftX, 5);
    expect(Math.max(...vertices.map((v) => v.x))).toBeCloseTo(JET_HUD_HOUSING.foreX, 5);
    expect(JET_HUD_FRAME.z + JET_HUD_FRAME.radius, "the uprights inside its width").toBeLessThan(0.11 - 0.005);
    // ROUNDED IN PLAN: at its ends its aft face is set in by the plan's 2 cm corner
    const ends = vertices.filter((v) => Math.abs(Math.abs(v.z) - 0.11) < 1e-5);
    expect(Math.min(...ends.map((v) => v.x)) - JET_HUD_HOUSING.aftX).toBeCloseTo(JET_HUD_HOUSING.planRadius, 4);
    // ROUNDED IN SECTION: both top edges turn through 45 degrees on their way from the faces to the top (a flat-topped
    // box has no facet between them), and at z 0 the aft edge's round spans the design's centimetre
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const faces = (target: Vector3) => {
      for (let i = 0; i < normals.length; i += 3) {
        if (Vector3.Dot(new Vector3(normals[i]!, normals[i + 1]!, normals[i + 2]!), target) > Math.cos(12 / DEG)) return true;
      }
      return false;
    };
    expect(faces(new Vector3(-Math.SQRT1_2, Math.SQRT1_2, 0)), "the aft top edge rounded").toBe(true);
    expect(faces(new Vector3(Math.SQRT1_2, Math.SQRT1_2, 0)), "the forward top edge rounded").toBe(true);
    const aftRound = vertices.filter((v) => Math.abs(v.z) < 1e-6 && v.x < JET_HUD_HOUSING.aftX + 0.02 && v.y > jetHudHousingTopY(JET_HUD_HOUSING.aftX, 0) - 0.02);
    const distinct = aftRound.filter((v, i) => aftRound.findIndex((o) => Vector3.Distance(o, v) < 1e-6) === i);
    expect(distinct.length, "the aft round's points at z 0").toBeGreaterThanOrEqual(5);
    expect(Math.max(...distinct.map((v) => v.x)) - Math.min(...distinct.map((v) => v.x)), "its run across x").toBeGreaterThan(0.009);
    // about 3 cm proud of the hood where the frame stands, straight ahead (the housing's top at x 3.05)
    const proud = jetHudHousingTopY(JET_HUD_FRAME.x, 0) - jetCoamingTopY(JET_HUD_FRAME.x);
    console.info(`F-16 HUD housing: ${(proud * 100).toFixed(2)} cm proud of the hood at x 3.05 straight ahead`);
    expect(proud).toBeGreaterThan(0.027);
    expect(proud).toBeLessThan(0.033);
    // opaque, cockpit-only, never a caster, and "structure" to the HUD's layout (its name is not deck's)
    expect((mesh.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBe(true);
    expect((mesh.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    expect((mesh.material as PBRMaterial).needAlphaBlendingForMesh(mesh)).toBe(false);
    expect(mesh.name).not.toMatch(/screens|gauge|needle|bezel|glare-?shield|instrument-panel|hud-frame/);
    // THE GLARESHIELD'S MATTE, the coaming's own instance (step 3c; on the bezel rims' material it glowed whole at
    // night, a white slab, luma 217 against the rail's 14): black at every light state, the HUD's body continuous with
    // the glareshield
    const material = mesh.material as PBRMaterial;
    expect(material.name).toBe("jet-glareshield");
    expect(material, "the coaming's instance").toBe(named("jet-glare-shield").material);
    expect(material).not.toBe(named("jet-mfd-rims").material);
    try {
      for (const g of [1, COCKPIT_GLOW_NIGHT_MULTIPLE]) {
        aircraft.setLightState({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow: g });
        expect([material.emissiveColor.r, material.emissiveColor.g, material.emissiveColor.b], `emissive at glow ${g}`).toEqual([0, 0, 0]);
      }
    } finally {
      aircraft.setLightState({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow: 1 });
    }
    // and inside the bubble, clear of the glass, as the rail is
    const nearest = Math.min(...vertices.map((v) => distanceToTriangles(v, canopy)));
    expect(nearest).toBeGreaterThanOrEqual(0.02);
    for (const v of vertices) expect(crossings(v, new Vector3(0, 1, 0), canopy).length % 2).toBe(1);
  });

  it("reads from the seat as a low hump over the rail: -8.6 straight ahead, falling steadily to its ends, down to the rail's row there with no step", () => {
    const own = housingOwn();
    const peak = ownTop(own, 0);
    console.info(`F-16 HUD housing: its top straight ahead reads ${peak.toFixed(3)}`);
    expect(Math.abs(peak + 8.6)).toBeLessThan(0.05);
    // outward from az 0, every 0.01 degree: never rising, no jump of 0.2 degree between samples, and where it last
    // stands over the rail's row, within 0.2 degree of it (the round shoulder comes down to the row; the rail hides
    // the rest)
    for (const side of [-1, 1] as const) {
      let last = peak;
      let lastOver = Number.NaN;
      let az = 0;
      for (; az <= 9; az += 0.01) {
        const top = ownTop(own, side * az);
        if (!Number.isFinite(top) || top <= railAt(az)) break;
        // (never rising, to 1.5 of the scan's 0.002 degree steps: the chords between the loft's stations read as
        // one step of noise)
        expect(top, `side ${side}, azimuth ${az.toFixed(2)}: never rising`).toBeLessThanOrEqual(last + 0.003);
        expect(last - top, `side ${side}, azimuth ${az.toFixed(2)}: no step`).toBeLessThan(0.2);
        last = top;
        lastOver = top - railAt(az);
      }
      expect(az, `side ${side}: it reaches past the uprights`).toBeGreaterThan(7);
      expect(lastOver, `side ${side}: its last reading over the rail's row`).toBeLessThan(0.2);
    }
    // AND BY ITS OWN VERTICES: at its ends (|z| 0.11) nothing of it stands more than a millimetre over the rail's row
    // there. (The plan's rounded corners bring each end to a point, so an end left 0.5 degree high still reads as a
    // steeper shoulder from the seat, not as a ledge; this holds the end where the design put it.)
    const rowAt = (x: number) => EYE.up - Math.tan(aircraftSpec("jet").cockpitDeckLineDegrees / DEG) * (x - EYE.forward);
    const endVertices = worldVertices(named("jet-hud-housing")).filter((v) => Math.abs(Math.abs(v.z) - JET_HUD_HOUSING.halfWidth) < 1e-5);
    expect(endVertices.length).toBeGreaterThan(20);
    for (const v of endVertices) expect(v.y - rowAt(v.x), `end vertex (${v.x.toFixed(3)}, ${v.y.toFixed(4)}, ${v.z.toFixed(3)}) over the rail's row`).toBeLessThanOrEqual(0.001);
  });

  it("stays out of the symbology: no vertex over -8.4 (4 degrees under the heading box at -4.3), the 2D HUD's deck line still the rail's 10.19", () => {
    for (const v of worldVertices(named("jet-hud-housing"))) {
      const { el } = azel(v);
      expect(el, `vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`).toBeLessThanOrEqual(-8.4);
      expect(-4.3 - el, "under the heading box").toBeGreaterThanOrEqual(4);
    }
    // THE HUD LAYOUT'S OWN INSTRUMENT: the deck's highest row, over deck surfaces only; the housing is structure
    const view = cockpitView("jet", 1600, 900);
    try {
      const row = measureDeckLineDegrees(view);
      expect(Math.abs(row - aircraftSpec("jet").cockpitDeckLineDegrees), `the deck line by the HUD's instrument, ${row.toFixed(3)}`).toBeLessThanOrEqual(0.02);
      // and the instrument sees the housing, as structure, straight ahead just over the rail
      const y = Math.round(450 + (450 * Math.tan(9.5 / DEG)) / (TAN_HALF_H / (16 / 9)));
      const hit = view.pick(800, y);
      expect(hit?.part, "the housing, straight ahead at -9.5").toBe("jet-hud-housing");
      expect(hit?.category).toBe("structure");
    } finally {
      view.dispose();
    }
  });
});

describe("the HUD's housing and glass, together (the F-16 pass, step 2)", () => {
  it("shows the glass first at the hump's arc between the uprights, and no glass outside them: the opaque picture against the panes' own triangles", () => {
    const own = worldTriangles(named("jet-hud-housing"));
    const glass = worldTriangles(named("jet-hud-combiner"));
    const humpAt = (az: number) => {
      for (let e = -7; e >= -12; e -= 0.002) if (crossings(EYE_POINT, direction(az, e), own).length > 0) return e;
      return Number.NaN;
    };
    // the glass is what the pilot sees along a ray where a pane is nearer than any opaque surface
    const glassSeen = (az: number, e: number) => {
      const d = direction(az, e);
      const g = Math.min(Number.POSITIVE_INFINITY, ...glass.map((t) => hitTriangle(EYE_POINT, d, t)).filter(Number.isFinite));
      const o = firstHitInfo(az, e)?.distance ?? Number.POSITIVE_INFINITY;
      return g < o;
    };
    for (let az = -5.8; az <= 5.81; az += 0.8) {
      let first = Number.NaN;
      for (let e = -10.5; e <= -7; e += 0.01) {
        if (glassSeen(az, e)) {
          first = e;
          break;
        }
      }
      const hump = humpAt(az);
      expect(Math.abs(first - hump), `azimuth ${az.toFixed(1)}: the glass first seen at ${first.toFixed(2)}, the hump at ${hump.toFixed(2)}`).toBeLessThan(0.03);
    }
    for (const az of [-9, -7.4, -7, 7, 7.4, 9]) {
      for (let e = -10.5; e <= 5; e += 0.1) expect(glassSeen(az, e), `glass at azimuth ${az}, elevation ${e.toFixed(1)}`).toBe(false);
    }
  });

  it("keeps the symbology's window open across its full width: opaque rays from -8.4 to +3.55 meet nothing between the uprights", () => {
    let rays = 0;
    for (let az = -5.8; az <= 5.81; az += 0.4) {
      for (let e = -8.4; e <= 3.55; e += 0.25) {
        expect(firstHit(az, e)?.name ?? null, `something at azimuth ${az.toFixed(1)}, elevation ${e.toFixed(2)}`).toBeNull();
        rays += 1;
      }
    }
    expect(rays).toBeGreaterThan(1400);
  });

  it("leaves the 2D HUD's layout byte for byte as it was: its deck line from the catalogue's 10.19, and the rows it writes", () => {
    // the 2D HUD's layout reads the deck line and nothing of the meshes; pinned as 55679ba wrote it
    const deck = aircraftSpec("jet").cockpitDeckLineDegrees;
    expect(deck).toBe(10.19);
    expect(cockpitDeckKStyleValue(deck), "--deck-k").toBe("0.2343");
    expect(cockpitDeckLineY(1600, 900, cockpitDeckK(deck))).toBeCloseTo(625.4019545, 6);
    expect(cockpitDeckLineY(2560, 1080, cockpitDeckK(deck))).toBeCloseTo(752.8826265, 6);
  });
});

describe("the HUD's combiner (the F-16 pass, step 2)", () => {
  /** Each pane's triangles: its outline (16 points: the bottom's two, each corner's seven) fanned from its middle. */
  const PANE_TRIANGLES = 16;
  const panes = () => {
    const t = worldTriangles(named("jet-hud-combiner"));
    expect(t, "two panes, 16 triangles each").toHaveLength(2 * PANE_TRIANGLES);
    return [t.slice(0, PANE_TRIANGLES), t.slice(PANE_TRIANGLES)] as const;
  };
  const corners = (tris: readonly Triangle[]) => {
    const out: Vector3[] = [];
    for (const t of tris) for (const v of [t.a, t.b, t.c]) if (!out.some((o) => Vector3.Distance(o, v) < 1e-6)) out.push(v);
    return out;
  };

  it("is two green-gold panes 1 cm apart at x 3.045 and 3.055, one cockpit-only mesh on a glass of its own at alpha 0.08", () => {
    const combiner = named("jet-hud-combiner");
    const glass = combiner.material as PBRMaterial;
    expect(glass.name).toBe("jet-hud-glass");
    expect(glass, "its own instance, not the canopy's").not.toBe(named("jet-bubble-canopy").material);
    expect(glass.getClassName(), "the canopy glass's kind").toBe((named("jet-bubble-canopy").material as PBRMaterial).getClassName());
    expect(glass.needAlphaBlendingForMesh(combiner), "blended, not opaque").toBe(true);
    // THE TINT. By the rule for two layers of glass (each passes 1 - alpha of what is behind it) 0.08 is 15.4%; the
    // glass gives some back as its own reflection, and the design's 5 to 15% is held on the frame's pixel read (at
    // 0.05 the rule said 9.75% and the frame read 5.5%, the band's floor; step 3 raised it)
    expect(glass.alpha).toBe(0.08);
    expect(1 - (1 - glass.alpha) ** 2, "darker through both panes, by the rule").toBeCloseTo(0.1536, 4);
    // NOT A MIRROR (step 5d): the beacon's wash light, on the centreline behind the pilot, mirrors in the upright panes
    // onto the flight-path marker, and at 0.05 its highlight was a flashing red bloom there at night. The geometry that
    // makes it so, from the wash table and the panes' plane:
    const beacon = aircraftWashLights("jet").find((wash) => wash.name === "aircraft-beacon-wash")!;
    const mirrored = new Vector3(2 * JET_HUD_COMBINER.paneX[0] - beacon.offset[0], beacon.offset[1], beacon.offset[2]);
    expect(Math.abs(azel(mirrored).az), "the beacon's image in the panes: straight ahead").toBeLessThan(0.3);
    expect(Math.abs(azel(mirrored).el), "and on the horizon line, the flight-path marker's").toBeLessThan(0.3);
    expect(JET_HUD_COMBINER.paneX[0] - beacon.offset[0], "within the wash's range").toBeLessThan(beacon.rangeMeters);
    // so the glass is rough enough to spread the highlight: 0.35 (GGX's peak falls as roughness to the fourth power)
    expect(glass.roughness).toBe(0.35);
    // green-gold: green over red over blue
    expect(glass.albedoColor.g).toBeGreaterThan(glass.albedoColor.r);
    expect(glass.albedoColor.r).toBeGreaterThan(glass.albedoColor.b);
    // no depth pre-pass and no depth write: the canopy behind them keeps its tint through them
    expect(glass.needDepthPrePass).toBe(false);
    expect(glass.disableDepthWrite).toBe(true);
    // nothing but what every airframe mesh carries: no vertex colour, no second UV set, no tangents
    expect((combiner as Mesh).getVerticesDataKinds().sort()).toEqual([VertexBuffer.NormalKind, VertexBuffer.PositionKind, VertexBuffer.UVKind].sort());
    expect((combiner.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBe(true);
    expect((combiner.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    const [first, second] = panes();
    const xs = [corners(first), corners(second)].map((c) => {
      expect(c, "its outline's 16 points and the fan's middle").toHaveLength(17);
      for (const v of c) expect(v.x).toBeCloseTo(c[0]!.x, 6);
      return c[0]!.x;
    });
    expect(xs[0]).toBeCloseTo(3.045, 5);
    expect(xs[1]).toBeCloseTo(3.055, 5);
  });

  it("fills the frame's outline and no more: into the uprights and the bar, and down into the housing, so no gap shows over it", () => {
    const f = JET_HUD_FRAME;
    const housing = worldTriangles(named("jet-hud-housing"));
    // the frame's centreline: the uprights' axes, the bar's, and the corners' quarter circles (step 5b)
    const R = f.cornerRadius;
    const offAxis = (v: Vector3) => {
      const z = Math.abs(v.z);
      if (v.y <= f.barY - R) return Math.abs(z - f.z);
      if (z <= f.z - R) return Math.abs(v.y - f.barY);
      return Math.abs(Math.hypot(v.y - (f.barY - R), z - (f.z - R)) - R);
    };
    for (const pane of panes()) {
      const middle = pane[0]!.a;
      const c = corners(pane).filter((v) => Vector3.Distance(v, middle) > 1e-6);
      expect(c, "its outline: the bottom's two, each corner's seven").toHaveLength(16);
      // ON THE RODS' AXES all round, the rounded corners too: no glass stands outside the rods
      for (const v of c) expect(offAxis(v), `pane vertex (${v.y.toFixed(4)}, ${v.z.toFixed(4)}) off the frame's centreline`).toBeLessThan(1e-6);
      expect(Math.max(...c.map((v) => Math.abs(v.z)))).toBeCloseTo(f.z, 5);
      expect(Math.max(...c.map((v) => v.y))).toBeCloseTo(f.barY, 5);
      // the bottom edge inside the housing all along it: no gap between the glass and the hump
      const lowest = [...c].sort((a, b) => a.y - b.y);
      const bottom = lowest.slice(0, 2);
      expect(lowest[2]!.y, "two corners at the bottom").toBeGreaterThan(bottom[1]!.y + 0.05);
      const [a, b] = bottom as [Vector3, Vector3];
      for (let t = 0; t <= 1; t += 0.05) {
        const p = Vector3.Lerp(a, b, t);
        expect(crossings(p, new Vector3(0, 1, 0), housing).length % 2, `the pane's bottom edge at z ${p.z.toFixed(3)} inside the housing`).toBe(1);
      }
    }
    expect(jetHudCombinerPanes()).toHaveLength(2);
  });

  it("faces the eye, pane by pane: each pane's triangles are drawn from the seat, their flat normals toward it", () => {
    const combiner = named("jet-hud-combiner");
    const normals = combiner.getVerticesData(VertexBuffer.NormalKind)!;
    for (const [k, pane] of panes().entries()) {
      let drawn = 0;
      for (const t of pane) {
        const centreOfTriangle = t.a.add(t.b).add(t.c).scale(1 / 3);
        if (Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), centreOfTriangle.subtract(EYE_POINT)) > 0) drawn += 1;
      }
      expect(drawn, `pane ${k}: triangles drawn from the eye`).toBe(PANE_TRIANGLES);
    }
    for (let i = 0; i < normals.length; i += 3) expect([normals[i], normals[i + 1], normals[i + 2]], "a flat normal toward the eye").toEqual([-1, 0, 0]);
  });

  it("is what the glass rays meet: both panes at the window's centre and its four corners (the positive control for the opaque window), and no glass outside the frame", () => {
    // the ray tests of the window ask the cockpit camera's OPAQUE picture, which skips the combiner; these rays are
    // asked of the panes' own triangles, so the window being empty is not the instrument never touching the glass
    const glass = worldTriangles(named("jet-hud-combiner"));
    const hits = (az: number, e: number) => glass.map((t) => hitTriangle(EYE_POINT, direction(az, e), t)).filter(Number.isFinite).sort((a, b) => a - b);
    // (the window's top corners at +3.55, the window pin's top: over it the rounded corners take the corners of the box)
    for (const [az, e] of [[0, -2], [-5.8, 3.55], [5.8, 3.55], [-5.8, -8.4], [5.8, -8.4]] as const) {
      expect(firstHit(az, e)?.name ?? null, `opaque at azimuth ${az}, elevation ${e}`).toBeNull();
      const found = hits(az, e);
      expect(found, `both panes at azimuth ${az}, elevation ${e}`).toHaveLength(2);
      expect(found[1]! - found[0]!, "1 cm apart along x").toBeCloseTo(0.01 / direction(az, e).x, 4);
    }
    for (const [az, e] of [[0, 6], [8, 0], [-8, 0]] as const) expect(hits(az, e), `glass at azimuth ${az}, elevation ${e}`).toHaveLength(0);
    // the combiner is off in exterior view, with the rest of the kit
    const combiner = named("jet-hud-combiner");
    aircraft.setCockpitView(false);
    try {
      expect(combiner.isVisible).toBe(false);
    } finally {
      aircraft.setCockpitView(true);
    }
    expect(JET_HUD_COMBINER.paneX).toEqual([3.045, 3.055]);
  });
});

describe("the panel board", () => {
  it("is the dash: one bare plate leaned back from the cove's foot to face the pilot, its plan the hood's less 5 mm a side, its top inside the hood along its whole depth", () => {
    const board = named("jet-instrument-panel");
    const vertices = worldVertices(board);
    expect(vertices.length, "a solidPlate of a quadrilateral: 12 triangles").toBe(36);
    const section = jetGlareshieldSection();
    const face = jetPanelFace();
    // the face through the cove's foot, from it down to the tub: the plane square to the leaned normal
    expect(face.top.x).toBeCloseTo(section.faceTop.x, 12);
    expect(face.top.y).toBeCloseTo(section.faceTop.y, 12);
    const out = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y;
    const onFace = vertices.filter((v) => Math.abs(out(v)) < 2e-6);
    expect(Math.max(...onFace.map((v) => v.y)), "the face's top at the cove's foot: no gap under the deck's edge").toBeCloseTo(section.faceTop.y, 5);
    expect(Math.min(...vertices.map((v) => v.y))).toBeCloseTo(0.3, 5);
    expect(Math.min(...vertices.map((v) => v.y)), "standing on the tub").toBeCloseTo(Math.max(...worldVertices(named("jet-cockpit-tub")).map((v) => v.y)), 5);
    // nothing of the board in front of its face (toward the pilot)
    for (const v of vertices) expect(out(v), "behind the face").toBeLessThanOrEqual(2e-6);
    // THE LEAN, by the measure: at the board's centre (the MFDs' height, between them) its normal is within 8 degrees
    // of the eye's ray there; the upright board was 18.6 off (the control)
    const centre = new Vector3(jetMfdPlacements()[0]!.faceCentre.x, jetMfdPlacements()[0]!.faceCentre.y, 0);
    const normal = new Vector3(face.normal.x, face.normal.y, 0);
    const off = Math.acos(Vector3.Dot(normal, EYE_POINT.subtract(centre).normalize())) * DEG;
    console.info(`F-16 dash: leaned ${JET_PANEL.leanDegrees}; its normal ${off.toFixed(2)} degrees off the eye's ray at the board's centre`);
    expect(off).toBeLessThanOrEqual(8);
    expect(Math.acos(Vector3.Dot(new Vector3(-1, 0, 0), EYE_POINT.subtract(centre).normalize())) * DEG, "upright, the control").toBeGreaterThan(8);
    // the plan: the hood's less 5 mm a side at every station, 0.355 at the face's top
    for (const v of vertices) expect(Math.abs(Math.abs(v.z) - (jetCoamingHalfWidth(v.x) - 0.005)), `vertex z ${v.z} at x ${v.x}`).toBeLessThan(1e-5);
    // ITS TOP INSIDE THE HOOD over its whole depth: the face's top edge and the back's top edge under the hood's top by
    // 2 cm or more (odd crossings straight up), and 3 mm or more from its walls. The top runs back from the cove's foot
    // over the hood's underside: square to a leaned face it would run out under the hood's underside, which falls at 13
    // degrees to the face's 15. Against the rail's own solid: its ends (step 5) stand over the board's outer edge.
    const coaming = railTriangles();
    const tops = jetPanelSection().filter((q) => q.y > 0.5);
    expect(tops).toHaveLength(2);
    const corners = vertices.filter((v) => tops.some((q) => Math.abs(q.x - v.x) < 1e-5 && Math.abs(q.y - v.y) < 1e-5));
    expect(corners.length, "the top edges' corners").toBeGreaterThanOrEqual(4);
    for (const v of corners) {
      const up = crossings(v, new Vector3(0, 1, 0), coaming);
      expect(up.length % 2, `board corner (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) inside the hood`).toBe(1);
      expect(up[0]!, `board corner (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) under the hood's top`).toBeGreaterThanOrEqual(0.02);
      const sideways = crossings(v, new Vector3(0, 0, Math.sign(v.z)), coaming);
      expect(sideways.length, "one wall that way").toBe(1);
      expect(sideways[0]!, `board corner (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) to the hood's wall`).toBeGreaterThan(0.003);
    }
    // THE PANEL MATERIAL the Global's and the 747's boards wear (0x1a2328, 0.82, 0.02), not the tub's blue
    const material = board.material as PBRMaterial;
    expect(material.name).toBe("jet-panel");
    expect([material.albedoColor.r, material.albedoColor.g, material.albedoColor.b].map((c) => Math.round(c * 255))).toEqual([0x1a, 0x23, 0x28]);
    expect([material.roughness, material.metallic]).toEqual([0.82, 0.02]);
    expect(material, "not the tub's").not.toBe(named("jet-cockpit-tub").material);
    expect((board.metadata as { cockpitInterior?: boolean }).cockpitInterior).toBe(true);
    expect((board.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBeUndefined();
    expect((board.metadata as { castsShadow?: boolean }).castsShadow, "it casts, as the old panel did").not.toBe(false);
    expect(board.layerMask & camera.layerMask, "on a layer the cockpit camera draws").not.toBe(0);
  });

  it("has no dials and no needles, anywhere", () => {
    for (const mesh of scene.meshes) {
      expect(mesh.name, "an old gauge or needle mesh").not.toMatch(/-gauge$|-needle$/);
      const from = (mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [];
      expect(from.filter((name) => /-gauge$|-needle$/.test(name)), `${mesh.name} still carries an old gauge`).toEqual([]);
    }
    // the instrument-face material is back for F2, on the MFD screens alone: their flat face where there is
    // no 2D canvas to draw pages on (here). No dial wears it.
    const onFace = scene.meshes.filter((mesh) => mesh.material?.name === "jet-instrument-face").map((mesh) => mesh.name);
    expect(onFace).toEqual(["jet-screens"]);
  });
});

describe("the MFDs", () => {
  /**
   * What the eye reads straight down each MFD's centre line, measured on the built mesh by scanning the
   * first surface from the eye in 0.01 degree steps. Pinned to +-0.2.
   */
  const READS = { bezelTop: -12.61, screenTop: -14.45, screenBottom: -22.28, bezelBottom: -24.08 };
  /**
   * Of the screen's height as the eye reads it, how much is inside the 16:9 frame at the MFDs' azimuth: all of it, on
   * the leaned dash (98.6% upright under the rail's cove; 63% under the wedge's near edge at -16).
   */
  const IN_FRAME = 1;
  const sides = [["port", -1], ["starboard", 1]] as const;
  const screenVertices = (side: number) => worldVertices(named("jet-screens")).filter((v) => Math.sign(v.z) === side);
  const centreAzimuth = (side: number) => {
    const vs = screenVertices(side);
    const c = vs.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vs.length);
    return azel(c).az;
  };
  /** Down one azimuth: the first and last elevation at which each mesh is the first surface. */
  function scan(az: number): Map<string, [number, number]> {
    const seen = new Map<string, [number, number]>();
    for (let e = -12; e >= -32; e -= 0.01) {
      const name = firstHit(az, e)?.name ?? "-";
      const range = seen.get(name);
      if (!range) seen.set(name, [e, e]);
      else range[1] = e;
    }
    return seen;
  }

  it("are framed and recessed on the leaned dash, square to it: the frame 1 mm into the board, the screen 3 mm behind the frame's front, both MFDs' frames one mesh and their rims another", () => {
    const face = jetPanelFace();
    const plane = (v: Vector3) => (v.x - face.top.x) * face.normal.x + (v.y - face.top.y) * face.normal.y; // out of the face
    const levels = (vs: Vector3[]) => [...new Set(vs.map((v) => plane(v).toFixed(5)))].map(Number).sort((a, b) => a - b);
    const frames = worldVertices(named("jet-mfd-frames"));
    const rims = worldVertices(named("jet-mfd-rims"));
    const screens = worldVertices(named("jet-screens"));
    // each MFD's frame (16 quads) and its rim (16 quads), unshared: 96 vertices each, both MFDs' in each mesh
    expect(frames).toHaveLength(2 * 96);
    expect(rims).toHaveLength(2 * 96);
    expect(screens).toHaveLength(48);
    const bezel = (k: number) => [...frames.slice(k * 96, k * 96 + 96), ...rims.slice(k * 96, k * 96 + 96)];
    for (const [k, side] of [[0, -1], [1, 1]] as const) {
      const own = bezel(k);
      expect(own.every((v) => Math.sign(v.z) === side), "in placement order").toBe(true);
      // the frame's back 1 mm inside the board, its front 6 mm out, the chamfer's foot 2 mm out
      expect(levels(own), `bezel ${k}'s planes`).toEqual([-0.001, 0.002, 0.006]);
      // the screen: a 0.5 mm plate whose face is 3 mm behind the frame's front (it stood 1 mm proud)
      expect(levels(screens.filter((v) => Math.sign(v.z) === side)), `screen ${k}'s planes`).toEqual([0.0025, 0.003]);
    }
    const bezels = [...bezel(0), ...bezel(1)];
    // square, centred at z +-0.17: a 0.102 screen, its frame 0.15 overall, the 0.19 between the frames the UFC's
    for (const [name, side] of sides) {
      const zs = (vs: Vector3[]) => [Math.min(...vs.map((v) => v.z)), Math.max(...vs.map((v) => v.z))] as const;
      const [b0, b1] = zs(bezels.filter((v) => Math.sign(v.z) === side));
      const [s0, s1] = zs(screens.filter((v) => Math.sign(v.z) === side));
      expect(b1 - b0, `${name} frame width`).toBeCloseTo(0.15, 5);
      expect(s1 - s0, `${name} screen width`).toBeCloseTo(0.102, 5);
      expect((b0 + b1) / 2, `${name} centre line`).toBeCloseTo(side * 0.17, 5);
      expect((s0 + s1) / 2, `${name} screen centred across`).toBeCloseTo(side * 0.17, 5);
    }
    expect(Math.min(...bezels.filter((v) => v.z > 0).map((v) => v.z)) * 2, "the gap between the frames").toBeCloseTo(0.19, 5);
    // THE GAP: each frame's opening 2 mm clear of its screen all round (the nearest frame vertex to the centre, along
    // the face and across it, is half the screen and 2 mm out; the screen is square)
    const up = new Vector3(face.up.x, face.up.y, 0);
    for (const [k, { faceCentre }] of jetMfdPlacements().entries()) {
      const frame = frames.slice(k * 96, k * 96 + 96);
      const reach = frame.map((v) => Math.max(Math.abs(v.z - faceCentre.z), Math.abs(Vector3.Dot(v.subtract(faceCentre), up))));
      expect(Math.min(...reach), `frame ${k}'s opening`).toBeCloseTo(JET_MFD.width / 2 + 0.002, 5);
    }
    // UNDER THE COVE'S FOOT: every frame and rim vertex reads 0.3 degree or more under it (a line along z reads one row)
    const row = (v: { x: number; y: number }) => (v.y - EYE.up) / (v.x - EYE.forward);
    const footRow = Math.atan(row(jetGlareshieldSection().faceTop)) * DEG;
    const highest = Math.max(...bezels.map((v) => Math.atan(row(v)) * DEG));
    expect(footRow - highest, "the frames' highest point under the cove's foot").toBeGreaterThanOrEqual(0.3 - 1e-3);
    expect(scene.getMeshByName("jet-mfd-bezels"), "the one mesh of step 3 is split").toBeNull();
    expect(scene.materials.filter((m) => m.name === "jet-mfd-bezel"), "the old slab material is gone").toHaveLength(0);
  });

  it("put the frames on their own grey, lighter than the dash by albedo alone and never glowing, and the chamfered rims on the bezel rims' material, which glows at night (steps 3b, 3c)", () => {
    // THE RIMS: the jet's instance of the shared `BEZEL_RIM`, day 0.05, night by `bezelRimEmissive`
    const rim = named("jet-mfd-rims").material as PBRMaterial;
    expect(rim.name).toBe("jet-bezel-rim");
    expect([rim.roughness, rim.metallic]).toEqual([BEZEL_RIM.roughness, BEZEL_RIM.metallic]);
    // THE FRAMES: their own material, the dash's finish, and NO emissive
    const frame = named("jet-mfd-frames").material as PBRMaterial;
    const board = named("jet-instrument-panel").material as PBRMaterial;
    expect(frame.name).toBe("jet-mfd-frame");
    expect(frame).not.toBe(rim);
    expect(frame).not.toBe(board);
    expect([frame.roughness, frame.metallic], "the dash's finish").toEqual([board.roughness, board.metallic]);
    // AT EVERY LIGHT STATE: the frames emit nothing, the rims their own law (0.05 by day, 0.56 at night)
    try {
      for (const g of [1, COCKPIT_GLOW_NIGHT_MULTIPLE]) {
        aircraft.setLightState({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow: g });
        expect([frame.emissiveColor.r, frame.emissiveColor.g, frame.emissiveColor.b], `the frames at glow ${g}`).toEqual([0, 0, 0]);
        expect(rim.emissiveIntensity, `the rims at glow ${g}`).toBeCloseTo(bezelRimEmissive(g), 12);
        expect(rim.emissiveColor.r + rim.emissiveColor.g + rim.emissiveColor.b, "the rims' glow has a colour").toBeGreaterThan(0);
      }
      // the law's two ends, so a law that stopped glowing would fail here too
      expect(bezelRimEmissive(1)).toBe(BEZEL_RIM.dayEmissiveIntensity);
      expect(bezelRimEmissive(COCKPIT_GLOW_NIGHT_MULTIPLE)).toBeCloseTo(BEZEL_RIM.nightEmissiveIntensity, 12);
      expect(BEZEL_RIM.nightEmissiveIntensity).toBeCloseTo(0.56, 12);
    } finally {
      aircraft.setLightState({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow: 1 });
    }
    // LIGHTER THAN THE DASH BY ALBEDO ALONE, by the Global's and the 747's measure (the albedos' linear luminance
    // ratio carried back to sRGB), in the band the LIVE read implies. The design's number is the live read, 1.40 to 1.50
    // by day; the leaned dash and the frames share one normal and one finish, so the sky's specular adds the same to
    // both and compresses the live ratio under the albedo's (3b's 1.41 by albedo read 1.24 live). Fitted from 3b's
    // two patches, a live 1.40 to 1.50 is 1.67 to 1.82 by albedo; the frames slot holds the live read.
    const linear = (m: PBRMaterial) => 0.2126 * m.albedoColor.r ** 2.2 + 0.7152 * m.albedoColor.g ** 2.2 + 0.0722 * m.albedoColor.b ** 2.2;
    const ratio = (linear(frame) / linear(board)) ** (1 / 2.2);
    console.info(`F-16 MFD frames against the dash, by albedo: ${ratio.toFixed(3)} in luma`);
    expect(ratio).toBeGreaterThanOrEqual(1.65);
    expect(ratio).toBeLessThanOrEqual(1.85);
  });

  it("bevel each frame: a 4 mm chamfer at 45 degrees round its outer edge, facing out of the face, by the built normals", () => {
    const face = jetPanelFace();
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const up = new Vector3(face.up.x, face.up.y, 0);
    // the chamfer is the rim's (the frame's front meets it at the chamfer's shoulder)
    const mesh = named("jet-mfd-rims");
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const vertices = worldVertices(mesh);
    const seen = new Set<string>();
    let chamfer = 0;
    for (let i = 0; i < vertices.length; i += 1) {
      const n = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      const along = Vector3.Dot(n, out);
      if (Math.abs(along - Math.SQRT1_2) > 1e-4) continue;
      chamfer += 1;
      const side = n.subtract(out.scale(Math.SQRT1_2));
      const which = [up, up.scale(-1), new Vector3(0, 0, 1), new Vector3(0, 0, -1)].findIndex((d) => Vector3.Dot(side, d) > Math.SQRT1_2 - 1e-4);
      expect(which, "outward along a side").toBeGreaterThanOrEqual(0);
      seen.add(`${which}`);
    }
    expect(seen.size, "all four sides").toBe(4);
    expect(chamfer, "four chamfer quads a frame, two triangles each, two frames").toBe(2 * 4 * 2 * 3);
    for (const [k, { faceCentre }] of jetMfdPlacements().entries()) {
      const rim = vertices.slice(k * 96, k * 96 + 96).map((v) => Math.abs(v.z - faceCentre.z));
      const edges = [...new Set(rim.map((z) => z.toFixed(5)))].map(Number).sort((a, b) => a - b).slice(-2);
      expect(edges[1]! - edges[0]!, `rim ${k}: 4 mm across the face`).toBeCloseTo(0.004, 5);
    }
  });

  it("are the first surface over every screen's face, 3 mm behind the frame's front: nine points each, and with the screen gone the same rays go on to the dash behind it", () => {
    const face = jetPanelFace();
    const up = new Vector3(face.up.x, face.up.y, 0);
    const out = new Vector3(face.normal.x, face.normal.y, 0);
    const across = new Vector3(0, 0, 1);
    for (const { name, faceCentre } of jetMfdPlacements()) {
      const front = faceCentre.add(out.scale(0.003));
      for (const a of [-0.35, 0, 0.35]) {
        for (const b of [-0.35, 0, 0.35]) {
          const target = front.add(up.scale(a * JET_MFD.height)).add(across.scale(b * JET_MFD.width));
          const toward = target.subtract(EYE_POINT);
          const ray = new Ray(EYE_POINT, toward.normalizeToNew(), 60);
          const hit = scene.pickWithRay(ray, drawnByCockpitCamera);
          expect(hit?.pickedMesh?.name, `${name} (${a}, ${b})`).toBe("jet-screens");
          expect(hit!.distance, `${name} (${a}, ${b}): at the face, 3 mm behind the frame's front`).toBeCloseTo(toward.length(), 3);
          // THE CONTROL: the screens gone, the same ray meets the dash, further (the frame is round it, not behind it)
          const screens = named("jet-screens");
          screens.isVisible = false;
          try {
            const behind = scene.pickWithRay(ray, drawnByCockpitCamera);
            expect(behind?.pickedMesh?.name, `${name} (${a}, ${b}) without the screen`).toBe("jet-instrument-panel");
            expect(behind!.distance).toBeGreaterThan(hit!.distance);
          } finally {
            screens.isVisible = true;
          }
        }
      }
      // THE GAP, by ray: 1.5 mm outboard of the screen's edge, on the board's face, the dash shows between screen and
      // frame (outboard, where the ray runs away from the screen as it goes in)
      const side = Math.sign(faceCentre.z);
      const gap = faceCentre.add(across.scale(side * (JET_MFD.width / 2 + 0.0015)));
      expect(scene.pickWithRay(new Ray(EYE_POINT, gap.subtract(EYE_POINT).normalize(), 60), drawnByCockpitCamera)?.pickedMesh?.name, `${name}: the dash in the gap`).toBe("jet-instrument-panel");
      // a ray at the frame's flat face meets the frame, on its front
      const flat = faceCentre.add(across.scale(Math.sign(faceCentre.z) * -1 * (JET_MFD.width / 2 + JET_MFD.gap + 0.002))).add(out.scale(0.006));
      expect(scene.pickWithRay(new Ray(EYE_POINT, flat.subtract(EYE_POINT).normalize(), 60), drawnByCockpitCamera)?.pickedMesh?.name, `${name}: the frame's face`).toBe("jet-mfd-frames");
    }
  });

  it("read, straight down each centre line (az +-14), frame top -12.6, screen top -14.5 and bottom -22.3, frame bottom -24.1: the frame's bottom (-22.7 there) leaves all of the screen in view", () => {
    for (const [name, side] of sides) {
      const az = centreAzimuth(side);
      // about 14: on the leaned dash under the rail's cove
      expect(Math.abs(az), `${name}: centre azimuth`).toBeGreaterThan(13.5);
      expect(Math.abs(az)).toBeLessThan(14.4);
      const seen = scan(az);
      // the bezel as the eye reads it: its frame and its rim together
      const parts = [seen.get("jet-mfd-frames"), seen.get("jet-mfd-rims")].filter((r): r is [number, number] => r !== undefined);
      const bezel: [number, number] | undefined = parts.length ? [Math.max(...parts.map((r) => r[0])), Math.min(...parts.map((r) => r[1]))] : undefined;
      const screen = seen.get("jet-screens");
      expect(bezel && screen, `${name}: both found`).toBeTruthy();
      expect(Math.abs(bezel![0] - READS.bezelTop), `${name}: bezel top ${bezel![0].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(screen![0] - READS.screenTop), `${name}: screen top ${screen![0].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(screen![1] - READS.screenBottom), `${name}: screen bottom ${screen![1].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(bezel![1] - READS.bezelBottom), `${name}: bezel bottom ${bezel![1].toFixed(2)}`).toBeLessThan(0.2);
      // down the line: the rail and its cove, then the dash, then the MFD standing on it, then the dash again
      const rail = seen.get("jet-glare-shield")!;
      const dash = seen.get("jet-instrument-panel")!;
      expect(rail[1], `${name}: the rail ends over the dash`).toBeGreaterThan(dash[0]);
      expect(dash[0], `${name}: the dash between the cove's foot and the bezel`).toBeGreaterThan(bezel![0]);
      expect(dash[1], `${name}: and under the bezel`).toBeLessThan(bezel![1]);
      // THE FRAME: the screen's top is in it and the bezel's bottom is not, at the frame's bottom HERE (a rectangle's
      // bottom edge is -23.35 only straight ahead)
      const bottom = -frameLimit(az);
      expect(bottom).toBeGreaterThan(-22.8);
      expect(bottom).toBeLessThan(-22.6);
      expect(screen![0], `${name}: screen top inside the frame`).toBeGreaterThan(bottom);
      expect(bezel![1], `${name}: bezel bottom below the frame`).toBeLessThan(bottom);
      const inFrame = (screen![0] - Math.max(bottom, screen![1])) / (screen![0] - screen![1]);
      expect(Math.abs(inFrame - IN_FRAME), `${name}: ${(inFrame * 100).toFixed(1)}% of the screen in frame`).toBeLessThan(0.01);
      expect(inFrame, `${name}: nearly all of the page`).toBeGreaterThanOrEqual(0.98);
    }
  });

  it("sample an 800 x 400 atlas, two 400 x 400 slots, the PFD on the pilot's LEFT screen and the map on his right", () => {
    expect([displayAtlasWidth(JET_DISPLAYS), displayAtlasHeight(JET_DISPLAYS)]).toEqual([800, 400]);
    expect(displaySlots(JET_DISPLAYS).map(({ screen, page, x, y, w, h }) => [screen, page, x, y, w, h])).toEqual([
      ["port", "pfd", 0, 0, 400, 400],
      ["starboard", "nd", 400, 0, 400, 400],
    ]);
    expect(JET_DISPLAY_AIRFRAME.engineCount).toBe(1);
    // THE PFD IS ON THE PILOT'S LEFT, from what the built mesh samples: every pilot-facing vertex whose u is in the
    // PFD's slot is at negative z (port), every one in the map's at positive z. (The placements' names alone agree
    // with themselves whichever side "port" is built on.)
    const mesh = named("jet-screens");
    const world = worldVertices(mesh);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const pfd = displaySlots(JET_DISPLAYS).find((slot) => slot.page === "pfd")!;
    // each pilot-facing face as a whole (the two faces share u = 0.5 along their inner edges): its mean u says which
    // slot it samples, its z which side it is on
    const faces: Record<"port" | "starboard", number[]> = { port: [], starboard: [] };
    for (let i = 0; i < world.length; i += 1) {
      if (normals[i * 3]! > -0.9) continue;
      faces[world[i]!.z < 0 ? "port" : "starboard"].push(uvs[i * 2]! * displayAtlasWidth(JET_DISPLAYS));
    }
    expect([faces.port.length, faces.starboard.length], "the two faces' corners").toEqual([4, 4]);
    const meanU = (us: number[]) => us.reduce((sum, u) => sum + u, 0) / us.length;
    expect(meanU(faces.port), "the pilot's LEFT screen samples the PFD's slot").toBeCloseTo(pfd.x + pfd.w / 2, 6);
    expect(Math.abs(meanU(faces.starboard) - (pfd.x + pfd.w / 2)), "and his right screen does not").toBeGreaterThan(pfd.w / 2);
    // (u AND v the right way up and the right way round, per screen, is held with the other decks in
    // render.cockpit-displays.test.ts, measured off the merged mesh)
  });

  /**
   * ROOM ON A SQUARE PAGE. The pages were laid out for 440 x 300; drawn into 400 x 400 with the disc sized from `h`,
   * the PFD's altitude readout overlapped the attitude disc by 8 px and the ND's +-60 degree labels ran past the
   * slot's edges. The PFD's attitude instrument is sized from the slot's shape now (`pageRoundScale`) and the ND's
   * rose keeps its labels' text 20 px in, and this holds the room they have, from the recorded instructions: the
   * disc >= 20 px from every tape and readout box, and every piece of the ND's text wholly inside its slot at a
   * heading that puts labels at both ends of the arc.
   */
  it("gives the PFD's disc 20 px of room beside its tapes and boxes, and keeps all of the ND's text inside its slot, in 400 x 400", () => {
    const context = createRecordingContext();
    // heading 90 puts a labelled tick at each end of the ND's +-60 degree arc (30 and 150)
    const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, airspeed: 180, altitude: 1_500, heading: 90, bank: 0, pitch: 0 }, JET_DISPLAY_AIRFRAME);
    drawDisplayAtlas(context, displayAtlasWidth(JET_DISPLAYS), displayAtlasHeight(JET_DISPLAYS), displaySlots(JET_DISPLAYS), state);
    const calls = context.calls;
    const n = (call: RecordedCall, i: number) => call.args[i] as number;
    // the disc: the clip arc centred at (200, 184) in the port slot
    const discAt = calls.findIndex((call, i) => call.method === "arc" && n(call, 0) === 200 && n(call, 1) === 184 && calls[i + 1]?.method === "clip");
    expect(discAt, "the attitude disc's clip arc").toBeGreaterThan(0);
    const disc = { x: 200, y: 184, r: n(calls[discAt]!, 2) };
    /** From the disc's rim to a rectangle: negative when they overlap. */
    const gap = (x: number, y: number, w: number, h: number) =>
      Math.hypot(Math.max(x - disc.x, 0, disc.x - (x + w)), Math.max(y - disc.y, 0, disc.y - (y + h))) - disc.r;
    // THE CONTROL on the distance itself: a box across the rim reads negative, one 30 px off reads 30
    expect(gap(disc.x + disc.r - 5, disc.y - 5, 20, 10)).toBeLessThan(0);
    expect(gap(disc.x + disc.r + 30, disc.y - 5, 20, 10)).toBeCloseTo(30, 9);
    // the tapes (a rect clipped to at once) and the readout boxes (a filled-and-stroked rect with its digits after it)
    const tapes = calls.flatMap((call, i) => call.method === "rect" && calls[i + 1]?.method === "clip" && n(call, 2) < 400 && n(call, 0) < 400 && i > discAt ? [call] : [])
      .filter((call) => !(n(call, 0) === 0 && n(call, 1) === 0 && n(call, 2) === 400 && n(call, 3) === 400));
    const boxes = calls.flatMap((call, i) => call.method === "strokeRect" && n(call, 0) < 400 && calls.slice(i + 1, i + 6).some((next) => next.method === "fillText") ? [call] : []);
    const beside = [...tapes, ...boxes].filter((call) => {
      const y0 = n(call, 1);
      const y1 = y0 + n(call, 3);
      return y1 > disc.y - disc.r && y0 < disc.y + disc.r; // level with the disc: the tapes and the speed and altitude boxes
    });
    expect(beside.length, "the two tapes and the two readout boxes level with the disc").toBe(4);
    for (const call of beside) {
      expect(gap(n(call, 0), n(call, 1), n(call, 2), n(call, 3)), `${call.method} at x ${n(call, 0).toFixed(1)}: room beside the disc`).toBeGreaterThanOrEqual(20);
    }
    // EVERY PIECE OF TEXT ON BOTH PAGES, attributed to the slot whose bracket DREW it (drawDisplayAtlas clips each page
    // to its slot between a save and its restore), wholly inside that slot on BOTH axes: text measured at a monospace
    // 0.6 em a character, its height from its baseline. Sorting text by where it lands instead passed text anchored off
    // a slot's edge (it simply counted for no slot). And the PFD's tapes inside its slot. And the rose's labels (the
    // heading numbers on the arc, anchored beyond it from own ship at (600, 234.5)) with their TEXT >= 20 px from the
    // slot's sides, anchors too: at +-60 degrees the text ends 20.0 px ("15") and 23.3 px ("3") from the sides, where
    // the 747's 440 x 300 gives 21.8 and 25.4. (Before the rose's radius took the labels' room into account it was
    // 10.7 and 15.5: the anchors were 20 px in, the text was not.)
    const slots = displaySlots(JET_DISPLAYS);
    let depth = 0;
    let awaitingSlot = false;
    let slot: { x: number; y: number; w: number; h: number; page: string } | null = null;
    let font = 10;
    let align: string = "start";
    let baseline: string = "alphabetic";
    const texts: Record<string, number> = { pfd: 0, nd: 0 };
    const roseLabels: string[] = [];
    let tapesInside = 0;
    const points = transformedPoints(calls);
    for (const [i, call] of calls.entries()) {
      if (call.method === "save") {
        if (depth === 0) awaitingSlot = true;
        depth += 1;
      } else if (call.method === "restore") {
        depth -= 1;
        if (depth === 0) slot = null;
      } else if (call.method === "rect" && awaitingSlot) {
        const [x, y, w, h] = call.args as number[];
        slot = { ...slots.find((candidate) => candidate.x === x && candidate.y === y && candidate.w === w && candidate.h === h)! };
        expect(slot.page, `the slot bracket at call ${i}`).toBeDefined();
        awaitingSlot = false;
      } else if (call.method === "rect" && slot?.page === "pfd" && calls[i + 1]?.method === "clip") {
        // a tape or the heading strip's window (each clipped to at once), under no transform: inside the slot
        const [x, y, w, h] = call.args as number[];
        expect(x!, "a clipped window's left").toBeGreaterThanOrEqual(0);
        expect(x! + w!, "a clipped window's right").toBeLessThanOrEqual(slot.w);
        expect(y!, "a clipped window's top").toBeGreaterThanOrEqual(0);
        expect(y! + h!, "a clipped window's bottom").toBeLessThanOrEqual(slot.h + 1e-9);
        tapesInside += 1;
      }
      if (call.method === "set:font") font = Number(/([0-9.]+)px/.exec(String(call.args[0]))?.[1] ?? 10);
      if (call.method === "set:textAlign") align = String(call.args[0]);
      if (call.method === "set:textBaseline") baseline = String(call.args[0]);
      if (call.method !== "fillText") continue;
      expect(slot, `text "${String(call.args[0])}" drawn outside any slot's bracket`).not.toBeNull();
      const point = points.find((p) => p.index === i)!;
      const text = String(call.args[0]);
      const width = 0.6 * font * text.length;
      const left = align === "center" ? point.x - width / 2 : align === "right" || align === "end" ? point.x - width : point.x;
      const top = baseline === "middle" ? point.y - font / 2 : baseline === "top" || baseline === "hanging" ? point.y : baseline === "bottom" ? point.y - font : point.y - 0.8 * font;
      const where = `${slot!.page} "${text}" at (${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;
      expect(left, `${where}: its left end`).toBeGreaterThanOrEqual(slot!.x);
      expect(left + width, `${where}: its right end`).toBeLessThanOrEqual(slot!.x + slot!.w);
      expect(top, `${where}: its top`).toBeGreaterThanOrEqual(slot!.y);
      expect(top + font, `${where}: its bottom`).toBeLessThanOrEqual(slot!.y + slot!.h);
      texts[slot!.page] = (texts[slot!.page] ?? 0) + 1;
      const fromOwnShip = Math.hypot(point.x - 600, point.y - ND_OWN_SHIP_Y);
      if (slot!.page === "nd" && /^[0-9]+$/.test(text) && align === "center" && fromOwnShip > 150) {
        roseLabels.push(text);
        expect(Math.min(point.x - 400, 800 - point.x), `rose label "${text}": its anchor from the slot's sides`).toBeGreaterThanOrEqual(20);
        expect(Math.min(left - 400, 800 - (left + width)), `rose label "${text}": its text from the slot's sides`).toBeGreaterThanOrEqual(20 - 1e-6);
      }
    }
    // at heading 90 the arc carries 3, 6, 9, 12 and 15, all of them ("9", at its top, was left out while own ship stood
    // at 234.5 and the ring ran under the heading box)
    expect(roseLabels.sort(), "the rose's labels, both ends of the arc among them").toEqual(["12", "15", "3", "6", "9"]);
    expect(texts.nd, "the ND's text found").toBeGreaterThan(8);
    expect(texts.pfd, "the PFD's text found").toBeGreaterThan(8);
    expect(tapesInside, "the PFD's two tapes and its heading strip's window found").toBe(3);
  });

  /**
   * WHAT OF THE MAP THE PILOT SEES. The frame at this lens shows only the top of each MFD, so on the square page the
   * ND's own ship and the rose's centre stand at 0.86 of the page's round scale (234.5 of 400), not 0.86 h (344),
   * which was below the frame. The rows in frame are DERIVED here, from the built screen and the frame's bottom at its
   * azimuth: where the ray at the frame's bottom crosses the screen's face, as a fraction of the way down it.
   */
  it("puts the ND's own ship and the rose's centre in the rows of the page the frame shows, and keeps HDG 10 px from the TAS value", () => {
    // the rows in frame, from the built mesh: the starboard screen's pilot-facing face, its top and bottom edges
    const mesh = named("jet-screens");
    const world = worldVertices(mesh);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const face = world.filter((v, i) => normals[i * 3]! < -0.9 && v.z > 0);
    expect(face).toHaveLength(4);
    const byHeight = [...face].sort((a, b) => a.y - b.y);
    const bottomEdge = byHeight[0]!.add(byHeight[1]!).scale(0.5);
    const topEdge = byHeight[2]!.add(byHeight[3]!).scale(0.5);
    const middle = topEdge.add(bottomEdge).scale(0.5);
    const az = azel(middle).az;
    const bottom = -frameLimit(az);
    const panelFace = jetPanelFace();
    const out = new Vector3(panelFace.normal.x, panelFace.normal.y, 0);
    const ray = direction(az, bottom);
    const hit = EYE_POINT.add(ray.scale(Vector3.Dot(middle.subtract(EYE_POINT), out) / Vector3.Dot(ray, out)));
    const down = bottomEdge.subtract(topEdge);
    // (past 1 where the frame's bottom is under the screen's: all of it in frame)
    const fraction = Math.min(1, Vector3.Dot(hit.subtract(topEdge), down) / down.lengthSquared());
    const rowsInFrame = fraction * displaySlots(JET_DISPLAYS)[1]!.h;
    // all of it on the leaned dash (98.6% upright under the rail's cove; 63% under the wedge's near edge, and the ND
    // puts its own ship high on the page for that); it is in frame either way
    expect(fraction, "the share of the screen, top down, in frame").toBeGreaterThanOrEqual(0.98);
    // the ND as drawn: own ship is the triangle drawn about the rose's centre, the rose the largest arc centred there
    const context = createRecordingContext();
    const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, airspeed: 257, altitude: 1_500, heading: 90 }, JET_DISPLAY_AIRFRAME);
    drawDisplayAtlas(context, displayAtlasWidth(JET_DISPLAYS), displayAtlasHeight(JET_DISPLAYS), displaySlots(JET_DISPLAYS), state);
    const points = transformedPoints(context.calls);
    const arcs = points.filter((p) => p.method === "arc" && p.x === 600);
    const centreY = arcs[0]!.y;
    for (const arc of arcs) expect(arc.y, "every rose arc about one centre").toBeCloseTo(centreY, 9);
    // own ship: the FILLED TRIANGLE (beginPath, moveTo, lineTo, lineTo, closePath, fill) whose centre is nearest the
    // rose's; all three of its corners, however far one of them strays (a proximity window around the centre dropped a
    // stray corner, and counted the magenta track line's start as one)
    const calls = context.calls;
    const triangles = calls.flatMap((call, i) => {
      const shape = ["beginPath", "moveTo", "lineTo", "lineTo", "closePath", "fill"];
      if (!shape.every((method, k) => calls[i + k]?.method === method)) return [];
      const corners = [i + 1, i + 2, i + 3].map((index) => points.find((p) => p.index === index)!);
      const cx = corners.reduce((sum, p) => sum + p.x, 0) / 3;
      const cy = corners.reduce((sum, p) => sum + p.y, 0) / 3;
      return cx > 400 ? [{ corners, cx, cy }] : [];
    });
    const nearest = [...triangles].sort((a, b) => Math.hypot(a.cx - 600, a.cy - centreY) - Math.hypot(b.cx - 600, b.cy - centreY));
    expect(nearest.length, "the ND's filled triangles").toBeGreaterThanOrEqual(2);
    expect(Math.hypot(nearest[0]!.cx - 600, nearest[0]!.cy - centreY), "own ship about the rose's centre").toBeLessThan(10);
    expect(Math.hypot(nearest[1]!.cx - 600, nearest[1]!.cy - centreY), "and no other triangle there").toBeGreaterThan(50);
    const ownShipBottom = Math.max(...nearest[0]!.corners.map((p) => p.y));
    expect(centreY, "the rose's centre in frame").toBeLessThan(rowsInFrame);
    expect(ownShipBottom, `own ship's lowest point (${ownShipBottom.toFixed(1)}) in frame (rows to ${rowsInFrame.toFixed(1)})`).toBeLessThan(rowsInFrame);
    // CENTRED (step 5c): own ship at 317.9 (0.795 h; 234.5 while the frame showed the screen's top 63%), the band
    // between the heading box and the labels' ring equal to the band under own ship's tail
    expect(centreY, "the rose's centre in the slot").toBeCloseTo(ND_OWN_SHIP_Y, 6);
    const labelsTop = centreY - ND_ROSE_RADIUS - 0.055 * 400 - Math.round(0.04 * pageRoundScale(400, 400)) / 2;
    const above = labelsTop - (0.025 + 0.07) * 400;
    const below = 400 - (centreY + 0.02 * 400);
    console.info(`F-16 ND: own ship at ${centreY.toFixed(2)}; ${above.toFixed(1)} px under the heading box, ${below.toFixed(1)} under own ship`);
    expect(above).toBeCloseTo(below, 1);
    expect(above).toBeGreaterThan(70);
    // the other decks keep own ship where it was: 0.86 h on 440 x 300 (checked on the 747's page)
    const reference = createRecordingContext();
    drawDisplayAtlas(reference, displayAtlasWidth(AIRLINER_DISPLAYS), displayAtlasHeight(AIRLINER_DISPLAYS), displaySlots(AIRLINER_DISPLAYS),
      displayStateFromVisual({ ...INITIAL_VISUAL_STATE, heading: 90 }, AIRLINER_DISPLAY_AIRFRAME));
    const nd = displaySlots(AIRLINER_DISPLAYS).find((slot) => slot.page === "nd")!;
    const referenceArc = transformedPoints(reference.calls).find((p) => p.method === "arc" && p.x === nd.x + nd.w / 2)!;
    expect(referenceArc.y - nd.y, "the 747's own ship").toBeCloseTo(0.86 * 300, 9);
    // THE HEADER: "HDG" (right-aligned) at least 10 px clear of the TAS value on its left
    let font = 10;
    let align = "start";
    const extents: Record<string, [number, number]> = {};
    let afterTas = false;
    for (const [i, call] of context.calls.entries()) {
      if (call.method === "set:font") font = Number(/([0-9.]+)px/.exec(String(call.args[0]))?.[1] ?? 10);
      if (call.method === "set:textAlign") align = String(call.args[0]);
      if (call.method !== "fillText") continue;
      const p = points.find((q) => q.index === i)!;
      if (p.x < 400) continue;
      const text = String(call.args[0]);
      const width = 0.6 * font * text.length;
      const left = align === "center" ? p.x - width / 2 : align === "right" || align === "end" ? p.x - width : p.x;
      if (text === "HDG") extents.hdg = [left, left + width];
      if (afterTas) {
        extents.tasValue = [left, left + width];
        afterTas = false;
      }
      if (text === "TAS") afterTas = true;
    }
    expect(extents.hdg && extents.tasValue, "HDG and the TAS value found").toBeTruthy();
    expect(extents.hdg![0] - extents.tasValue![1], "HDG clear of the TAS value").toBeGreaterThanOrEqual(10);
  });

  /**
   * THE SQUARE'S ATTITUDE INSTRUMENT IS THE 440 x 300 ONE, SMALLER. The disc, its pitch scale, its rungs, the roll
   * scale and the aircraft symbol are all sized from one `pageRoundScale`, so on the F-16's 400 x 400 page the wing
   * bars sit inside the disc as they do on the other decks, and the disc shows as many degrees of pitch as theirs.
   * (With the disc alone sized from it, the bars overhung the disc by 22 px a side and the disc showed +-8.2.)
   */
  it("keeps the aircraft symbol >= 10 px inside the disc, and shows the same degrees of pitch in the disc as the 747's", () => {
    const drawPfd = (layout: DisplayLayout, airframe: DisplayAirframe, pitch: number) => {
      const context = createRecordingContext();
      const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, airspeed: 180, altitude: 1_500, heading: 90, bank: 0, pitch }, airframe);
      drawDisplayAtlas(context, displayAtlasWidth(layout), displayAtlasHeight(layout), displaySlots(layout), state);
      const calls = context.calls;
      // the first disc: the port PFD's clip arc, then translate to its centre, rotate by the bank, translate by the pitch
      const at = calls.findIndex((call, i) => call.method === "arc" && calls[i + 1]?.method === "clip");
      const arc = calls[at]!;
      expect([calls[at + 2]!.method, calls[at + 3]!.method, calls[at + 4]!.method]).toEqual(["translate", "rotate", "translate"]);
      return { calls, at, cx: arc.args[0] as number, cy: arc.args[1] as number, r: arc.args[2] as number, offset: calls[at + 4]!.args[1] as number };
    };
    // DEGREES OF PITCH THE DISC HOLDS: its radius over the horizon's travel per degree, read off the drawn offset
    const degreesInDisc = (layout: DisplayLayout, airframe: DisplayAirframe) => {
      const level = drawPfd(layout, airframe, 0);
      const up = drawPfd(layout, airframe, 5);
      expect(level.offset).toBe(0);
      return up.r / ((up.offset - level.offset) / 5);
    };
    // THE LADDER READS THE PITCH: at 5 and 10 degrees nose up, the rung for that pitch lies on the aircraft symbol (the
    // disc's centre). The horizon's travel and the rungs' spacing are two numbers; spaced apart, a rung misreads the
    // pitch while the horizon still moves right. Read on the drawn page: the horizontal strokes inside the disc's
    // bracket, centred on the disc and shorter than its diameter (the horizon line is longer), in absolute pixels.
    for (const [layout, airframe, label] of [[JET_DISPLAYS, JET_DISPLAY_AIRFRAME, "F-16"], [AIRLINER_DISPLAYS, AIRLINER_DISPLAY_AIRFRAME, "747"]] as const) {
      for (const pitch of [5, 10]) {
        const { calls: page, at, cx, cy, r } = drawPfd(layout, airframe, pitch);
        const open = page.slice(0, at).map((call) => call.method).lastIndexOf("save");
        let depth = 0;
        let close = open;
        for (; close < page.length; close += 1) {
          if (page[close]!.method === "save") depth += 1;
          if (page[close]!.method === "restore") depth -= 1;
          if (depth === 0) break;
        }
        const pts = transformedPoints(page).filter((point) => point.index > open && point.index < close);
        const rungs: number[] = [];
        for (const [k, a] of pts.entries()) {
          const b = pts[k + 1];
          if (a.method !== "moveTo" || b?.method !== "lineTo" || b.index !== a.index + 1) continue;
          const horizontal = Math.abs(a.y - b.y) < 1e-6;
          const centred = Math.abs((a.x + b.x) / 2 - cx) < 1e-6;
          if (horizontal && centred && Math.abs(b.x - a.x) < 2 * r) rungs.push(a.y);
        }
        expect(rungs.length, `${label} at ${pitch}: rungs drawn`).toBeGreaterThan(1);
        const nearest = Math.min(...rungs.map((y) => Math.abs(y - cy)));
        expect(nearest, `${label} at ${pitch} degrees: the ${pitch} rung on the symbol`).toBeLessThan(0.5);
      }
    }
    const jetDegrees = degreesInDisc(JET_DISPLAYS, JET_DISPLAY_AIRFRAME);
    const referenceDegrees = degreesInDisc(AIRLINER_DISPLAYS, AIRLINER_DISPLAY_AIRFRAME);
    expect(referenceDegrees, "the 747's disc, the reference").toBeCloseTo(12, 6);
    expect(jetDegrees, "the F-16's disc holds what the 747's does").toBeCloseTo(referenceDegrees, 6);
    // THE WING BARS AND THE CENTRE SQUARE: filled-and-stroked rects level with the disc's centre, inside its x span,
    // with no digits after them (which is what tells them from the tapes' readout boxes)
    const { calls, at, cx, cy, r } = drawPfd(JET_DISPLAYS, JET_DISPLAY_AIRFRAME, 0);
    const symbol = calls.flatMap((call, i) => {
      if (call.method !== "strokeRect" || i < at) return [];
      const [x, y, w, h] = call.args as number[];
      const level = Math.abs(y! + h! / 2 - cy) < 1e-6;
      const within = x! > cx - r - 40 && x! + w! < cx + r + 40;
      const readout = calls.slice(i + 1, i + 6).some((next) => next.method === "fillText");
      return level && within && !readout ? [{ x: x!, y: y!, w: w!, h: h! }] : [];
    });
    expect(symbol.length, "two wing bars and the centre square").toBe(3);
    for (const piece of symbol) {
      const corners = [[piece.x, piece.y], [piece.x + piece.w, piece.y], [piece.x, piece.y + piece.h], [piece.x + piece.w, piece.y + piece.h]];
      const furthest = Math.max(...corners.map(([x, y]) => Math.hypot(x! - cx, y! - cy)));
      expect(r - furthest, `the symbol piece at x ${piece.x.toFixed(1)}: inside the disc's rim`).toBeGreaterThanOrEqual(10);
    }
  });

  /**
   * THE DISCS STAY ROUND IN A SQUARE SLOT. The pages were authored for 440 x 300 and draw from the slot's own
   * width and height, so a square could squash them if any of it scaled x and y apart. Checked on the drawing
   * instructions (there is no canvas under Node): the PFD's attitude disc is a clip ARC and the ND's rose is arcs,
   * and an arc is round wherever the transform in force is a similarity. So: every arc of these two pages is
   * drawn under a transform whose two axes are equal in length and square to each other, and the disc and the
   * rose sit inside their own slot. THE CONTROL: the same check on the same page drawn under a 1.2 x 1 stretch
   * fails, so it can see a squash.
   */
  it("keeps the PFD's attitude disc and the ND's rose round in their square slots (the instructions, not pixels)", () => {
    const draw = (stretch: number | null): RecordedCall[] => {
      const context = createRecordingContext();
      if (stretch !== null) context.scale(stretch, 1);
      const state = displayStateFromVisual({ ...INITIAL_VISUAL_STATE, airspeed: 180, altitude: 1_500, heading: 95, bank: 20, pitch: 5 }, JET_DISPLAY_AIRFRAME);
      drawDisplayAtlas(context, displayAtlasWidth(JET_DISPLAYS), displayAtlasHeight(JET_DISPLAYS), displaySlots(JET_DISPLAYS), state);
      return [...context.calls];
    };
    /** The transform in force at each arc, replayed as the recording context replays points. */
    const arcTransforms = (calls: RecordedCall[]) => {
      const out: { index: number; radius: number; a: number; b: number; c: number; d: number }[] = [];
      let m = { a: 1, b: 0, c: 0, d: 1 };
      const stack: (typeof m)[] = [];
      calls.forEach((call, index) => {
        const n = (i: number) => call.args[i] as number;
        if (call.method === "save") stack.push({ ...m });
        else if (call.method === "restore") m = stack.pop() ?? m;
        else if (call.method === "rotate") {
          const cos = Math.cos(n(0));
          const sin = Math.sin(n(0));
          m = { a: m.a * cos + m.c * sin, b: m.b * cos + m.d * sin, c: -m.a * sin + m.c * cos, d: -m.b * sin + m.d * cos };
        } else if (call.method === "scale") m = { a: m.a * n(0), b: m.b * n(0), c: m.c * n(1), d: m.d * n(1) };
        else if (call.method === "arc") out.push({ index, radius: n(2), ...m });
      });
      return out;
    };
    const round = (t: { a: number; b: number; c: number; d: number }) =>
      Math.abs(Math.hypot(t.a, t.b) - Math.hypot(t.c, t.d)) < 1e-9 && Math.abs(t.a * t.c + t.b * t.d) < 1e-9;
    const calls = draw(null);
    const arcs = arcTransforms(calls);
    const centres = transformedPoints(calls).filter((p) => p.method === "arc");
    expect(arcs.length).toBe(centres.length);
    // the scale the two round things are sized from: 272.7 on a 400 x 400 page, 300 on the others' 440 x 300
    const scale = pageRoundScale(400, 400);
    expect(scale).toBeCloseTo((400 * 300) / 440, 9);
    expect(pageRoundScale(440, 300), "the other decks' pages: exactly h").toBe(300);
    // the PFD's disc: radius 0.3 x 272.7 = 81.8 in the port slot, centred at (200, 184), wholly inside x 0..400
    const discRadius = 0.3 * scale;
    const disc = arcs.findIndex((arc) => Math.abs(arc.radius - discRadius) < 1e-9);
    expect(disc, "the attitude disc's clip arc").toBeGreaterThanOrEqual(0);
    expect([centres[disc]!.x, centres[disc]!.y]).toEqual([200, 184]);
    expect(centres[disc]!.x - discRadius).toBeGreaterThanOrEqual(0);
    expect(centres[disc]!.x + discRadius).toBeLessThanOrEqual(400);
    // the ND's rose: the 40 nm arc, the largest centred on own ship, which stands at 317.9 on the square (the drawing
    // centred under the header, step 5c) and 258 = 0.86 h on 440 x 300. Its radius is 178.2 on the square, set by its
    // labels' room (the smallest of 0.68 h = 272, 0.52 w = 208 and the labels' 178.2, with the labels' font from the
    // page scale)
    const ownY = ND_OWN_SHIP_Y;
    const roseRadius = Math.max(...arcs.filter((arc, i) => centres[i]!.x === 600 && Math.abs(centres[i]!.y - ownY) < 1e-6).map((arc) => arc.radius));
    expect(roseRadius).toBeCloseTo(178.2, 1);
    const rose = arcs.findIndex((arc, i) => arc.radius === roseRadius && centres[i]!.x > 400);
    expect(rose, "the ND's 40 nm arc").toBeGreaterThanOrEqual(0);
    expect(centres[rose]!.x).toBe(600);
    expect(centres[rose]!.y).toBeCloseTo(ownY, 9);
    // its +-60 degree span stays inside the slot
    expect(600 - roseRadius * Math.sin(Math.PI / 3)).toBeGreaterThan(400);
    expect(600 + roseRadius * Math.sin(Math.PI / 3)).toBeLessThan(800);
    for (const arc of arcs) expect(round(arc), `arc ${arc.index} (radius ${arc.radius}) drawn under a squashing transform`).toBe(true);
    // THE CONTROL: a stretch the check must catch
    expect(arcTransforms(draw(1.2)).some((arc) => !round(arc)), "the check sees a 1.2 x 1 stretch").toBe(true);
  });
});

describe("what the frame's bottom corners see", () => {
  it("is the sill and the rail's end sweeping into it (steps 4, 5; it was the world through the glass), the canopy's flange sill is never the first surface, and the dash stops at az +-27.7", () => {
    const sill = worldTriangles(named("jet-canopy-sill"));
    let top = Number.NaN;
    for (let e = 0; e >= -80; e -= 0.1) {
      if (crossings(EYE_POINT, direction(90, e), sill).length > 0) {
        top = e;
        break;
      }
    }
    expect(top).toBeGreaterThan(-46);
    expect(top).toBeLessThan(-40);
    expect(top, "well under the frame's bottom at its widest").toBeLessThan(-frameLimit(37.5) - 10);
    // the frame's bottom corners: the sill, where the rail's end sweeps down into it (step 5), inside the glass
    // (before step 4 nothing opaque, the world through it)
    for (const az of [-37.4, 37.4]) {
      const el = -frameLimit(az) + 0.1;
      const hit = firstHitInfo(az, el);
      expect(["jet-sills", "jet-glare-shield"], `the bottom corner (azimuth ${az})`).toContain(hit?.pickedMesh?.name);
      expect(crossings(EYE_POINT, direction(az, el), canopy)[0]!, "the glass beyond it").toBeGreaterThan(hit!.distance);
    }
    // the dash's leaned face stops covering the bottom edge at az +-27.7 by ray (upright, at its near corners' +-26.6;
    // the wedge's near face reached +-28.5, and the rail is narrower, for the canopy): its side edges slant out toward
    // its feet, 13 cm nearer the eye than its top and at az +-31.4, under the frame
    const board = worldVertices(named("jet-instrument-panel"));
    const footX = Math.min(...board.map((v) => v.x));
    const feet = board.filter((v) => v.x < footX + 1e-4);
    expect(feet.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...feet.map((v) => Math.abs(azel(v).az))), "from the mesh's own feet").toBeCloseTo(31.4, 1);
    for (const v of feet) expect(azel(v).el, "under the frame's bottom there").toBeLessThan(-frameLimit(Math.abs(azel(v).az)));
    let reach = Number.NaN;
    for (let az = 0; az <= 37.5; az += 0.1) if (firstHit(az, -frameLimit(az) + 0.1)?.name === "jet-instrument-panel") reach = az;
    // to az 27.0: from there the rail's end (step 5), its inner face 1 to 2 cm inboard of the dash's side where it
    // rises to the rail, stands over the dash's outer edge (27.7 before it)
    expect(reach, "the frame's bottom row on the dash").toBeCloseTo(27.0, 1);
    // The sill IS inside the frame out to about az 22 -- straight ahead its own top reads -14.0, against the frame's
    // -23.35 -- but the dash stands in front of it there, and beyond it drops below the frame's bottom. So it is
    // the first surface nowhere in the frame (and its see-through planform walls are never met from the seat).
    let sillTop = Number.NaN;
    for (let e = 0; e >= -30; e -= 0.05) {
      if (crossings(EYE_POINT, direction(0, e), sill).length > 0) {
        sillTop = e;
        break;
      }
    }
    expect(sillTop, "THE CONTROL: the sill is inside the frame straight ahead").toBeGreaterThan(-frameLimit(0));
    expect(firstHit(0, sillTop - 0.05)?.name, "and the dash is in front of it").toBe("jet-instrument-panel");
    let inFrame = 0;
    for (let az = -37; az <= 37; az += 1) {
      for (let el = -23; el <= -5; el += 1) {
        if (Math.abs(el) > frameLimit(az)) continue;
        inFrame += 1;
        expect(firstHit(az, el)?.name, `the sill at azimuth ${az}, elevation ${el}`).not.toBe("jet-canopy-sill");
      }
    }
    expect(inFrame).toBeGreaterThan(1000);
  });
});

describe("the sills (the F-16 pass, step 4)", () => {
  const sills = () => named("jet-sills");
  /** Each part's vertices, in the merge's order: the port rail, the port console, the starboard rail, the starboard console. */
  function parts() {
    const v = worldVertices(sills());
    return new Map([
      ["port", { side: -1, rail: v.slice(0, 180), consoleVertices: v.slice(180, 216) }],
      ["starboard", { side: 1, rail: v.slice(216, 396), consoleVertices: v.slice(396, 432) }],
    ] as const);
  }
  /** A pixel's ray through a horizontal-fixed lens of `fov` on a W x H frame, looking down the body axis from the eye. */
  function pixelRay(width: number, height: number, fov: number, px: number, py: number): Ray {
    const u = (((px + 0.5) / width) * 2 - 1) * Math.tan((fov * Math.PI) / 360);
    const v = -(((py + 0.5) / height) * 2 - 1) * (Math.tan((fov * Math.PI) / 360) / (width / height));
    return new Ray(EYE_POINT, new Vector3(1, v, u).normalize(), 60);
  }
  const boardSide = (x: number) => jetCoamingHalfWidth(x) - JET_PANEL.sideInset;

  it("are one cockpit-only mesh on the dash's own material, each side a rail swept along the glass and a console: 432 vertices", () => {
    const mesh = sills();
    expect(mesh.getTotalVertices(), "two rails of 180 (8-point section, 4 stations) and two consoles of 36").toBe(432);
    expect(mesh.material, "the dash's instance: no new material").toBe(named("jet-instrument-panel").material);
    expect((mesh.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBe(true);
    expect((mesh.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom).toEqual(["jet-sill-rail-port", "jet-sill-console-port", "jet-sill-rail-starboard", "jet-sill-console-starboard"]);
    for (const [name, { side, rail, consoleVertices }] of parts()) {
      for (const v of [...rail, ...consoleVertices]) expect(Math.sign(v.z), `${name}: its own side`).toBe(side);
      expect([Math.min(...rail.map((v) => v.y)), Math.max(...rail.map((v) => v.y))], `${name} rail: from 1 cm under the console's top to the rail's top`).toEqual([expect.closeTo(0.59, 6), expect.closeTo(0.72, 6)]);
      expect([Math.min(...consoleVertices.map((v) => v.y)), Math.max(...consoleVertices.map((v) => v.y))], `${name} console: from the tub up`).toEqual([expect.closeTo(JET_PANEL.bottomY, 6), expect.closeTo(0.6, 6)]);
    }
  });

  it("run a level rail at 0.72 (eye - 0.22) from x 1.9, behind the eye, to the board's back, 2 cm or more inside the glass at every vertex and following it in within a centimetre", () => {
    const own = worldTriangles(sills());
    for (const [name, { side, rail, consoleVertices }] of parts()) {
      // level: every vertex of its top at 0.72, none over
      expect(Math.max(...rail.map((v) => v.y))).toBeCloseTo(JET_SILL.topY, 6);
      expect(JET_SILL.topY).toBeCloseTo(EYE.up - 0.22, 12);
      expect(Math.min(...rail.map((v) => v.x)), `${name}: its aft end, 0.32 behind the eye`).toBeCloseTo(1.9, 6);
      expect(Math.max(...rail.map((v) => v.x)), `${name}: its forward end at the board's back`).toBeCloseTo(jetPanelFace().x + JET_PANEL.thickness, 6);
      // INSIDE THE GLASS: every vertex, straight out along z, 2 cm or more short of it
      const nearest = Math.min(...[...rail, ...consoleVertices].map((v) => crossings(v, new Vector3(0, 0, side), canopy)[0]!));
      console.info(`F-16 ${name} sill: nearest glass straight out ${nearest.toFixed(4)} m`);
      expect(nearest).toBeGreaterThanOrEqual(0.02);
      // between the stations too, at x 2.3, 2.5, 2.8 and 3.0: the rail's outer face (the last crossing of the sills
      // straight out at y 0.65) against the glass's inner half-width at the top's height
      const margins = [2.3, 2.5, 2.8, 3.0].map((x) => {
        const through = crossings(new Vector3(x, 0.65, 0), new Vector3(0, 0, side), own);
        const glass = crossings(new Vector3(x, JET_SILL.topY, 0), new Vector3(0, 0, side), canopy)[0]!;
        return { x, outer: through[through.length - 1]!, margin: glass - through[through.length - 1]! };
      });
      console.info(`F-16 ${name} sill, the glass less its outer face: ${margins.map((m) => `x ${m.x} ${m.margin.toFixed(4)}`).join(", ")}`);
      for (const m of margins) expect(m.margin, `${name} at x ${m.x}`).toBeGreaterThanOrEqual(0.02);
      // forward of the canopy's widest run it follows the glass in, within a centimetre of the margin
      for (const m of margins.slice(1)) expect(m.margin, `${name} at x ${m.x}: following the glass`).toBeLessThan(0.03);
      expect(margins[1]!.outer).toBeGreaterThan(margins[2]!.outer);
      expect(margins[2]!.outer).toBeGreaterThan(margins[3]!.outer);
    }
  });

  it("round the rail's top edges at 1 cm and shade them as curves: neighbouring chords' normals 45 degrees apart, and each round meeting the top and its face with their normals (no hard edge along it)", () => {
    const section = jetSillSection();
    expect(section.rounds.map((r) => [r.first, r.last])).toEqual([[1, 3], [4, 6]]);
    for (const round of section.rounds) {
      for (let k = round.first; k <= round.last; k += 1) {
        const p = section.points[k]!;
        expect(Math.hypot(p.u - round.centre.u, p.y - round.centre.y), `section point ${k} on its round`).toBeCloseTo(JET_SILL.radius, 12);
      }
    }
    const mesh = sills();
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const vertices = worldVertices(mesh);
    const stationX = jetSillStations().map((station) => station.x);
    const normal = (i: number) => new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
    const byPlace = new Map<string, Vector3[]>();
    let smooth = 0;
    for (let t = 0; t < vertices.length; t += 3) {
      const corners = [t, t + 1, t + 2];
      const ns = corners.map(normal);
      if (Math.abs(ns[0]!.x) > 0.9) continue; // a cap
      const centreX = (vertices[t]!.x + vertices[t + 1]!.x + vertices[t + 2]!.x) / 3;
      const interval = stationX.findIndex((x) => x > centreX);
      if (Math.max(Vector3.Distance(ns[0]!, ns[1]!), Vector3.Distance(ns[0]!, ns[2]!)) > 1e-6) {
        smooth += 1;
        // a chord: its two section points' normals turn by the chord's angle, 45 degrees
        const angles = ([[0, 1], [0, 2], [1, 2]] as const).map(([a, b]) => Math.acos(Math.min(1, Vector3.Dot(ns[a]!, ns[b]!))) * DEG);
        expect(Math.max(...angles), `triangle ${t / 3}: a chord's turn`).toBeCloseTo(45, 0);
      }
      for (const i of corners) {
        const v = vertices[i]!;
        if (v.y < JET_SILL.topY - JET_SILL.radius - 1e-6) continue; // the bottom's hard edges
        const key = `${interval}|${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
        byPlace.set(key, [...(byPlace.get(key) ?? []), normal(i)]);
      }
    }
    expect(smooth, "two rounds of two chords, two triangles each, over three intervals, both sides").toBe(2 * 2 * 2 * 3 * 2);
    // NO HARD EDGE over the top: at every place along the top, within an interval, one normal (the plan bends at the
    // stations, where the walls' own normals turn with it)
    let places = 0;
    for (const [key, ns] of byPlace) {
      places += 1;
      for (const n of ns) expect(Vector3.Distance(n, ns[0]!), `normals at ${key}`).toBeLessThan(1e-5);
    }
    expect(places).toBeGreaterThan(40);
  });

  it("close the rail's inner face from below with a console at 0.60, 15 cm wide, 3 cm in under the rail, from x 1.9 to the dash's leaned face", () => {
    const own = worldTriangles(sills());
    for (const [name, { side, consoleVertices }] of parts()) {
      expect(Math.min(...consoleVertices.map((v) => v.x)), `${name}: from behind the eye`).toBeCloseTo(1.9, 6);
      // its forward end on the dash's leaned face plane, from the tub to its top
      const forward = consoleVertices.filter((v) => v.x > 2.5);
      expect(forward.length).toBeGreaterThan(0);
      for (const v of forward) expect(v.x, `${name}: on the dash's face at y ${v.y.toFixed(3)}`).toBeCloseTo(jetPanelFaceX(v.y), 6);
      // its plan at its aft end: 15 cm inboard of the rail's inner face, 3 cm out under it
      const aft = consoleVertices.filter((v) => v.x < 1.9 + 1e-6).map((v) => Math.abs(v.z));
      expect(Math.min(...aft)).toBeCloseTo(jetSillInnerAt(1.9) - 0.15, 6);
      expect(Math.max(...aft)).toBeCloseTo(jetSillInnerAt(1.9) + 0.03, 6);
      // NO SEAM, between its stations too: straight out at y 0.595 (between the rail's bottom and the console's top)
      // the console's inboard wall, the rail's inner face, the console's outboard wall INSIDE the rail, the rail's outer face
      for (const x of [2.0, 2.3, 2.6, 2.8]) {
        const through = crossings(new Vector3(x, 0.595, 0), new Vector3(0, 0, side), own);
        expect(through, `${name} at x ${x}`).toHaveLength(4);
        expect(through[1]!, `${name} at x ${x}: the rail's inner face`).toBeCloseTo(jetSillInnerAt(x), 4);
        expect(through[2]! - through[1]!, `${name} at x ${x}: the console in under the rail`).toBeGreaterThan(0.005);
      }
    }
  });

  it("fill every column of the frame's lower third at 16:9, the bottom row's aircraft reaching the frame's edge; at 21:9 (the hybrid lens) it reaches az +-38.9", () => {
    const hitsAircraft = (ray: Ray) => scene.pickWithRay(ray, drawnByCockpitCamera)?.hit === true;
    // 16:9, every second column: a hit somewhere in the lower third (bottom row first)
    const [W, H] = [1600, 900];
    const empty: number[] = [];
    let bySills = 0;
    for (let px = 0; px < W; px += 2) {
      const bottom = scene.pickWithRay(pixelRay(W, H, 75, px, H - 1), drawnByCockpitCamera);
      // the sills, and from step 5 the rail's ends sweeping down into them
      if (bottom?.pickedMesh?.name === "jet-sills" || (bottom?.pickedMesh?.name === "jet-glare-shield" && bottom.pickedPoint!.x < JET_GLARESHIELD.aftX - 0.01)) bySills += 1;
      let any = bottom?.hit === true;
      for (let py = H - 3; !any && py >= Math.round((2 * H) / 3); py -= 2) any = hitsAircraft(pixelRay(W, H, 75, px, py));
      if (!any) empty.push(px);
    }
    console.info(`F-16 lower third at 16:9: ${empty.length} empty columns of ${W / 2}; ${bySills} columns' bottom rows on the sills`);
    expect(empty, "columns of the lower third with no aircraft (252 of 800 before the sills)").toEqual([]);
    expect(bySills, "THE CONTROL: the sills (and the rail's ends) are what fill the corners").toBeGreaterThan(240);
    // 21:9 under the hybrid lens: the bottom row's aircraft, from the centre out, reaches az +-38.9
    const [W2, H2] = [2560, 1080];
    const fov = cockpitHorizontalFieldOfViewForAspect(null, W2 / H2);
    const reach = [-1, 1].map((side) => {
      let last = 0;
      for (let px = W2 / 2; px >= 0 && px < W2; px += side * 2) {
        if (!hitsAircraft(pixelRay(W2, H2, fov, px, H2 - 1))) break;
        last = px;
      }
      return Math.atan((((last + 0.5) / W2) * 2 - 1) * Math.tan((fov * Math.PI) / 360)) * DEG;
    });
    console.info(`F-16 at 21:9 (lens ${fov.toFixed(2)}): the bottom row's aircraft reaches az ${reach.map((a) => a.toFixed(2)).join(" / ")}`);
    expect(Math.abs(reach[0]!)).toBeCloseTo(38.9, 0);
    expect(reach[1]!).toBeCloseTo(38.9, 0);
  });

  it("stay under the rail's row everywhere forward of the eye, and put the sill or the console, never the tub, under the frame's corners", () => {
    const railRow = -Math.tan(aircraftSpec("jet").cockpitDeckLineDegrees / DEG);
    const ahead = worldVertices(sills()).filter((v) => v.x > EYE.forward + 0.05);
    const rows = ahead.map((v) => (v.y - EYE.up) / (v.x - EYE.forward));
    const top = ahead[rows.indexOf(Math.max(...rows))]!;
    console.info(`F-16 sills: highest row ${Math.max(...rows).toFixed(4)} (the rail's ${railRow.toFixed(4)}), at (${top.x.toFixed(3)}, ${top.y.toFixed(3)}, ${top.z.toFixed(3)}), el ${azel(top).el.toFixed(2)} az ${azel(top).az.toFixed(1)}`);
    expect(Math.max(...rows)).toBeLessThan(railRow);
    expect(azel(top).el).toBeCloseTo(-13.83, 1);
    // the bottom row at az +-30 and +-36: the sill's rail, or the rail's end sweeping into it (step 5)
    const Vf = TAN_HALF_H / (16 / 9);
    for (const az of [-36, -30, 30, 36]) {
      const hit = scene.pickWithRay(new Ray(EYE_POINT, new Vector3(1, -Vf * (1 - 1 / 900), Math.tan(az / DEG)).normalize(), 60), drawnByCockpitCamera);
      expect(["jet-sills", "jet-glare-shield"], `the bottom row at az ${az}`).toContain(hit?.pickedMesh?.name);
      expect(hit!.pickedPoint!.y, "the rail, not the console").toBeGreaterThan(0.59);
      expect(hit!.pickedPoint!.x, "aft of the coaming's own rail").toBeLessThan(JET_GLARESHIELD.aftX);
    }
    // UNDER THE FRAME (it is below the frame's bottom at 16:9 and 21:9): the console's top, not the tub
    for (const az of [-30, 30]) {
      const hit = firstHitInfo(az, -26);
      expect(hit?.pickedMesh?.name, `az ${az}, el -26`).toBe("jet-sills");
      expect(hit!.pickedPoint!.y, "the console's top").toBeCloseTo(JET_SILL.consoleTopY, 4);
      expect(-26, "under the frame's bottom there").toBeLessThan(-frameLimit(az));
    }
  });

  it("meet the dash with no gap to see through and no overlap: nothing of the rail inside the board, 3.1 mm at most between them, and no world under the rail's top at the junction", () => {
    for (const [name, { rail }] of parts()) {
      // beside the dash (forward of its face plane) every rail vertex is outboard of the board's side
      for (const v of rail.filter((q) => q.x > jetPanelFaceX(q.y) + 1e-6)) {
        expect(Math.abs(v.z), `${name} rail vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}) beside the board`).toBeGreaterThanOrEqual(boardSide(v.x) - 1e-6);
      }
      // from the board's side's bend on, its inner face IS the board's side; at the face plane, 3.1 mm off it
      for (const station of jetSillStations().slice(2)) expect(station.inner).toBeCloseTo(boardSide(station.x), 12);
      const clearance = jetSillInnerAt(jetPanelFaceX(JET_SILL.bottomY)) - boardSide(jetPanelFaceX(JET_SILL.bottomY));
      console.info(`F-16 ${name} sill: ${(clearance * 1000).toFixed(2)} mm from the board's side at the face plane, 0 from x 2.93`);
      expect(clearance).toBeGreaterThanOrEqual(0);
      expect(clearance).toBeLessThanOrEqual(0.0032);
    }
    // THE JUNCTION, by ray: from the coaming's row down to the frame's bottom, az 26 to 32 each side, any ray that
    // reaches the world is over the rail's top where it crosses the rail's plan (ended at the dash's face plane, 85 of
    // 5,241 went under it, out through a notch past its end)
    for (const side of [-1, 1]) {
      let under = 0;
      let rays = 0;
      for (let az = 26; az <= 32; az += 0.2) {
        for (let el = -12; el >= -frameLimit(az); el -= 0.2) {
          rays += 1;
          const d = direction(side * az, el);
          if (scene.pickWithRay(new Ray(EYE_POINT, d, 60), drawnByCockpitCamera)?.hit) continue;
          const t = (side * 0.38) / d.z;
          if (EYE_POINT.y + t * d.y < JET_SILL.topY) under += 1;
        }
      }
      expect(rays).toBeGreaterThan(1000);
      expect(under, `side ${side}: world under the rail's top at the junction`).toBe(0);
    }
  });
});

describe("the rail's ends (the F-16 pass, step 5)", () => {
  /** Each end's vertices, in the merge's order after the rail's own: the port end, then the starboard. */
  function ends() {
    const all = worldVertices(named("jet-glare-shield"));
    const each = (all.length - RAIL_VERTICES) / 2;
    return new Map([
      ["port", { side: -1, vertices: all.slice(RAIL_VERTICES, RAIL_VERTICES + each), from: RAIL_VERTICES }],
      ["starboard", { side: 1, vertices: all.slice(RAIL_VERTICES + each), from: RAIL_VERTICES + each }],
    ] as const);
  }
  /**
   * The first elevation, scanning down from -8.5, at which a ray meets a FRONT face (as the GPU draws them: the cross
   * product of a drawn triangle points away from the eye) of the deck round the corner: to 0.002 degree. Not Babylon's
   * picker, which meets back faces too and takes a triangle's edge with a tolerance: at the end's forward cap (facing
   * away, culled) it read a hair over the cap's top.
   */
  let deck: Triangle[] | null = null;
  function silhouette(az: number): number {
    deck ??= ["jet-glare-shield", "jet-sills", "jet-instrument-panel", "jet-hud-housing"].flatMap((name) => worldTriangles(named(name)));
    const meets = (e: number) => {
      const d = direction(az, e);
      return deck!.some((t) => Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), d) > 0 && Number.isFinite(hitTriangle(EYE_POINT, d, t)));
    };
    let e = -8.5;
    while (e > -30 && !meets(e)) e -= 0.05;
    let [hi, lo] = [e + 0.05, e];
    for (let k = 0; k < 5; k += 1) {
      const mid = (hi + lo) / 2;
      if (meets(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  it("sweep each end of the rail aft and down into its sill: one coaming mesh on the glareshield's matte, the rail and its two ends, beginning at az 25", () => {
    const mesh = named("jet-glare-shield");
    expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom).toEqual(["jet-glare-shield-rail", "jet-glare-shield-end-port", "jet-glare-shield-end-starboard"]);
    expect((mesh.material as PBRMaterial).name).toBe("jet-glareshield");
    const stations = jetRailEndStations();
    expect(stations).toHaveLength(9);
    const t = jetGlareshieldSection().tangent;
    // the top at the rail's silhouette, the az-25 line's z there; the foot level on the sill
    expect(stations[8]!.x).toBeCloseTo(t.x, 12);
    expect(stations[8]!.top).toBeCloseTo(t.y, 12);
    expect(Math.atan2(stations[8]!.inner, t.x - EYE.forward) * DEG, "the end's inner edge at its top: az 25").toBeCloseTo(25, 9);
    expect(stations[0]!.top).toBeCloseTo(JET_SILL.topY, 12);
    expect(stations[0]!.inner, "the foot: the sill's own section").toBeCloseTo(jetSillInnerAt(stations[0]!.x), 12);
    for (const [name, { side, vertices }] of ends()) {
      for (const v of vertices) expect(Math.sign(v.z), `${name}: its own side`).toBe(side);
      // nothing of an end inboard of az 25 above the sill's top (so the rail's row is its own from -25 to 25)
      for (const v of vertices.filter((q) => q.y > JET_SILL.topY + 1e-6 && q.x > EYE.forward)) {
        expect(Math.abs(azel(v).az), `${name} vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`).toBeGreaterThanOrEqual(25 - 1e-6);
      }
      expect(Math.max(...vertices.map((v) => v.y)), `${name}: its top at the rail's silhouette`).toBeCloseTo(t.y, 5);
      expect(Math.min(...vertices.map((v) => v.x)), `${name}: its foot`).toBeCloseTo(stations[0]!.x, 5);
    }
  });

  it("fall along an S of R 0.15, level at the sill's top at its foot (tangent within 0.5 degree) and flush with the sill's section there", () => {
    const stations = jetRailEndStations();
    const R = JET_RAIL_END.sRadius;
    // the S's top at every station: on one of its two arcs, level at both ends
    const footX = stations[0]!.x;
    const topX = stations[8]!.x;
    const mid = (footX + topX) / 2;
    for (const s of stations) {
      const onArc = s.x >= mid
        ? stations[8]!.top - (R - Math.sqrt(R * R - (topX - s.x) ** 2))
        : JET_SILL.topY + (R - Math.sqrt(R * R - (s.x - footX) ** 2));
      expect(s.top, `the S at x ${s.x.toFixed(3)}`).toBeCloseTo(onArc, 9);
    }
    // at the foot the end's top is the sill's, level: the foot's top normals (the flat top between the rounds) within
    // 0.5 degree of straight up
    const mesh = named("jet-glare-shield");
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    for (const [name, { vertices, from }] of ends()) {
      const footTop = vertices.map((v, k) => ({ v, n: new Vector3(normals[(from + k) * 3]!, normals[(from + k) * 3 + 1]!, normals[(from + k) * 3 + 2]!) }))
        .filter(({ v, n }) => Math.abs(v.x - footX) < 1e-5 && Math.abs(v.y - JET_SILL.topY) < 1e-5 && Math.abs(n.x) < 0.9);
      expect(footTop.length, `${name}: the foot's top vertices`).toBeGreaterThan(0);
      for (const { n } of footTop) expect(Math.acos(Math.min(1, n.y)) * DEG, `${name}: level at the foot`).toBeLessThan(0.5);
      // flush: the foot's section is the sill's there (its outer and inner edges)
      const footZ = vertices.filter((v) => Math.abs(v.x - footX) < 1e-5).map((v) => Math.abs(v.z));
      expect(Math.min(...footZ)).toBeCloseTo(jetSillInnerAt(footX), 5);
    }
  });

  it("shade the S as a surface: at every place on an end's walls one normal (no hard-edge duplicates), but at the section's two bottom corners", () => {
    const mesh = named("jet-glare-shield");
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    for (const [name, { vertices, from }] of ends()) {
      const byPlace = new Map<string, Vector3[]>();
      for (let k = 0; k < vertices.length; k += 1) {
        const n = new Vector3(normals[(from + k) * 3]!, normals[(from + k) * 3 + 1]!, normals[(from + k) * 3 + 2]!);
        const v = vertices[k]!;
        if (Math.abs(n.x) > 0.9 || v.y < JET_SILL.bottomY + 1e-6) continue; // the caps, the bottom's hard corners
        const key = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
        byPlace.set(key, [...(byPlace.get(key) ?? []), n]);
      }
      let shared = 0;
      for (const [key, ns] of byPlace) {
        if (ns.length > 1) shared += 1;
        for (const n of ns) expect(Vector3.Distance(n, ns[0]!), `${name}: the normals at ${key}`).toBeLessThan(1e-5);
      }
      expect(shared, `${name}: places shared by more than one triangle`).toBeGreaterThan(40);
    }
  });

  it("stand 2 cm or more inside the glass at every vertex, straight out at its own height", () => {
    for (const [name, { side, vertices }] of ends()) {
      const nearest = Math.min(...vertices.map((v) => crossings(v, new Vector3(0, 0, side), canopy)[0]!));
      console.info(`F-16 ${name} rail end: nearest glass straight out ${nearest.toFixed(4)} m`);
      expect(nearest).toBeGreaterThanOrEqual(0.02);
    }
  });

  it("fall from the rail's row at az 25 to the sill without a step, and leave no world between the end and the sill at 16:9", () => {
    const want = -Math.tan(aircraftSpec("jet").cockpitDeckLineDegrees / DEG);
    for (const side of [-1, 1]) {
      const row: { az: number; el: number }[] = [];
      for (let az = 25; az <= 37.45; az += 0.1) row.push({ az, el: silhouette(side * az) });
      // at az 25 still the rail's row
      const rowOf = (q: { az: number; el: number }) => Math.tan(q.el / DEG) / Math.cos(q.az / DEG);
      expect(rowOf(row[0]!), "the rail's row at az 25").toBeCloseTo(want, 2);
      // MONOTONE DOWN in the picture's rows (a straight rail reads one row, its elevation rising toward its ends only
      // because the frame is a rectangle), and no step over 0.2 degree between 0.1 degree samples
      for (let k = 1; k < row.length; k += 1) {
        expect(rowOf(row[k]!), `side ${side} at az ${row[k]!.az.toFixed(1)}`).toBeLessThanOrEqual(rowOf(row[k - 1]!) + 2e-4);
        expect(Math.abs(row[k - 1]!.el - row[k]!.el), `side ${side}: the step at az ${row[k]!.az.toFixed(1)}`).toBeLessThanOrEqual(0.2);
      }
      console.info(`F-16 rail end (side ${side}): the silhouette at az 25 ${row[0]!.el.toFixed(2)}, 30 ${row[50]!.el.toFixed(2)}, 35 ${row[100]!.el.toFixed(2)}, 37.4 ${row[row.length - 1]!.el.toFixed(2)}`);
      // NO WORLD between the end and the sill: every ray under the silhouette, down to the frame's bottom, meets aircraft
      let world = 0;
      let rays = 0;
      for (const { az, el } of row.filter((_, k) => k % 3 === 0)) {
        for (let e = el - 0.05; e >= -frameLimit(az); e -= 0.1) {
          rays += 1;
          if (firstHit(side * az, e) === null) world += 1;
        }
      }
      expect(rays).toBeGreaterThan(1000);
      expect(world, `side ${side}: world rays under the end's silhouette`).toBe(0);
    }
  });
});

describe("nothing else moved: the gate against f9d2672", () => {
  /**
   * Every jet mesh that phase F1 did NOT set out to touch, with its digest of WORLD positions and indices at
   * f9d2672 (world, so a transform nudged by a millimetre fails here as surely as a vertex would; geometry and
   * placement only -- a changed normal, UV or material passes, see `worldDigest`). The only
   * meshes absent from this list are the three the phase rebuilt or added -- `jet-glare-shield` (reshaped),
   * `jet-instrument-panel` (rebuilt) and `jet-hud-frame` (new) -- and the ten dials and needles that are gone.
   */
  const PINNED: readonly (readonly [string, string])[] = [
    ["anticollision-beacon", "346a2421"],
    ["jet-air-data-probe", "d3af0133"],
    ["jet-bubble-canopy", "a1f57975"],
    ["jet-canopy-aft-bow", "02162ef5"],
    ["jet-canopy-sill", "d3ea0255"],
    ["jet-cockpit-tub", "2eff5db5"],
    ["jet-dorsal-spine", "47d494dd"],
    ["jet-ejection-seat", "4d5d3583"],
    ["jet-exhaust-liner", "6941fbbd"],
    ["jet-fuselage", "dd69242f"],
    ["jet-inlet-lip", "f1e4209d"],
    ["jet-inlet-splitter", "6f4f6535"],
    ["jet-nose-strut", "084b43ed"],
    ["jet-nozzle-petals", "771905b5"],
    ["jet-reheat-core", "31e83c8d"],
    ["jet-reheat-plume", "22be48ed"],
    ["jet-seat-pan", "79c630b5"],
    ["jet-turbine-blades", "553ff6f5"],
    ["jet-turbine-hub", "c56ad905"],
    ["jet-ventral-inlet", "7dfbb127"],
    ["landing-light", "4fbd72b5"],
    ["nose-gear-door", "e0dc8075"],
    ["nose-wheel-hub", "e08692a5"],
    ["nose-wheel-tire", "4c164bfb"],
    ["port-jet-airbrake-shelf", "51935975"],
    ["port-jet-flaperon-surface", "251b12b0"],
    ["port-jet-inlet-cheek", "3d542775"],
    ["port-jet-leading-edge-extension", "92b87769"],
    ["port-jet-outer-trailing-edge", "246b3946"],
    ["port-jet-stabilator", "3f483995"],
    ["port-jet-stabilator-root-fairing", "400637f5"],
    ["port-lower-speed-brake-surface", "0deedfb5"],
    ["port-main-gear-door", "d7b83a75"],
    ["port-main-strut", "cd43f38d"],
    ["port-main-wheel-hub", "9aec29cd"],
    ["port-main-wheel-tire", "f533f617"],
    ["port-navigation-light", "ed2a2cf5"],
    ["port-speed-brake-surface", "eef7e675"],
    ["port-strobe-light", "ab385877"],
    ["port-swept-main-wing", "e486f3ea"],
    ["port-swept-outer-wing", "d6f38dd3"],
    ["port-ventral-strake", "0d2082e6"],
    ["port-wingtip-rail", "63294c3d"],
    ["radar-nose", "10aa4e65"],
    ["rudder-surface", "d45c5fe5"],
    ["starboard-jet-airbrake-shelf", "5d17b675"],
    ["starboard-jet-flaperon-surface", "6d53b670"],
    ["starboard-jet-inlet-cheek", "03d79475"],
    ["starboard-jet-leading-edge-extension", "f106b0e9"],
    ["starboard-jet-outer-trailing-edge", "df754746"],
    ["starboard-jet-stabilator", "8a96330d"],
    ["starboard-jet-stabilator-root-fairing", "82eb75f5"],
    ["starboard-lower-speed-brake-surface", "56122535"],
    ["starboard-main-gear-door", "7cd57df5"],
    ["starboard-main-strut", "a86d2f25"],
    ["starboard-main-wheel-hub", "6e1c28cd"],
    ["starboard-main-wheel-tire", "bb343957"],
    ["starboard-navigation-light", "7601536d"],
    ["starboard-speed-brake-surface", "c447c1f5"],
    ["starboard-strobe-light", "05ee8fb7"],
    ["starboard-swept-main-wing", "3870eeea"],
    ["starboard-swept-outer-wing", "d1318ad3"],
    ["starboard-ventral-strake", "48813df2"],
    ["starboard-wingtip-rail", "dcb6e86d"],
    ["swept-vertical-stabilizer", "c79e7c35"],
    ["tail-navigation-light", "2a758df2"],
  ];
  /**
   * F1 rebuilt or added the first three; F2 added the MFDs' two; the F-16 pass's step 2 the housing and the combiner;
   * step 3b split the MFDs' bezels into their frames and their rims; step 4 added the sills.
   */
  const REBUILT = ["jet-glare-shield", "jet-instrument-panel", "jet-hud-frame", "jet-hud-housing", "jet-hud-combiner", "jet-mfd-frames", "jet-mfd-rims", "jet-screens", "jet-sills"];
  const GONE = ["airspeed", "attitude", "altimeter", "engine", "vertical-speed"].flatMap((dial) => [`jet-${dial}-gauge`, `jet-${dial}-needle`]);
  // (There was a second whole-airframe gate here for the trainer, the Global and the 747, pinned at f9d2672.
  // `render.loft-crown-seam.test.ts` already pins those three whole, so every legitimate change to them had to be
  // re-pinned in two files, and this copy went stale the day the Global's ball came out. The seam test is the gate.)

  function built(kind: (typeof AIRCRAFT_KINDS)[number]): { meshes: AbstractMesh[]; visual: AircraftVisual; dispose: () => void } {
    const e = new NullEngine();
    const s = new Scene(e);
    s.useRightHandedSystem = true;
    const visual = createWebGpuAircraft(s, kind);
    visual.root.computeWorldMatrix(true);
    const meshes = s.meshes.filter((mesh) => mesh.getTotalVertices() > 0).sort((a, b) => a.name.localeCompare(b.name));
    return {
      meshes,
      visual,
      dispose: () => {
        visual.dispose();
        s.dispose();
        e.dispose();
      },
    };
  }

  it("keeps every jet mesh outside the cockpit's nine where f9d2672 had it (world positions to the micrometre, and indices), mesh by mesh, and has exactly those nine besides", () => {
    const jet = built("jet");
    try {
      const byName = new Map(jet.meshes.map((mesh) => [mesh.name, mesh]));
      expect(PINNED.length).toBe(66);
      expect([...byName.keys()].sort()).toEqual([...PINNED.map(([name]) => name), ...REBUILT].sort());
      const moved: string[] = [];
      for (const [name, digest] of PINNED) {
        const mesh = byName.get(name);
        if (!mesh) {
          moved.push(`${name}: gone`);
          continue;
        }
        const now = worldDigest([mesh]);
        if (now !== digest) moved.push(`${name}: ${digest} -> ${now}`);
      }
      expect(moved, "meshes that moved since f9d2672").toEqual([]);
      for (const name of GONE) expect(byName.has(name), name).toBe(false);
      // 78 -> 69 -> 71 -> 73 -> 74 -> 75: twelve gone in F1 (the ten dials and needles, the old glare-shield box and
      // the old panel), three there, F2's two MFD meshes, step 2's HUD housing and its combiner's panes, step 3b's MFD
      // frames and rims apart, and step 4's sills
      expect(jet.meshes).toHaveLength(75);
    } finally {
      jet.dispose();
    }
  });

  it("spends 174 draws outside cockpit view (184 at f9d2672: the ten dials and needles are gone), and in it the cockpit camera trades the skin's three for the kit's seven, one of them the combiner's alpha draw", () => {
    const jet = built("jet");
    try {
      const casts = (mesh: AbstractMesh) => (mesh.metadata as { castsShadow?: boolean } | null)?.castsShadow !== false;
      // One draw in the colour pass and one per sun-shadow cascade for a caster, as the 747's budget counts them.
      // BEFORE: 78 meshes, 76 drawn (the two reheat cones are disabled), 54 casters, 184 draws. The dials and
      // needles were ten drawn non-casting meshes; the frame and the MFDs' two are cockpit-only.
      const exteriorMask = aircraftCameraLayerMask(0x0fff_ffff, false);
      const cockpitMask = aircraftCameraLayerMask(0x0fff_ffff, true);
      const drawnBy = (mask: number) => (mesh: AbstractMesh) =>
        mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0 && (mesh.layerMask & mask) !== 0;
      const outside = jet.meshes.filter(drawnBy(exteriorMask));
      expect(outside).toHaveLength(66);
      expect(outside.filter(casts)).toHaveLength(54);
      expect(outside.length + 2 * outside.filter(casts).length).toBe(174);
      for (const name of ["jet-hud-frame", "jet-hud-housing", "jet-hud-combiner", "jet-mfd-frames", "jet-mfd-rims", "jet-screens", "jet-sills"]) expect(outside.map((mesh) => mesh.name), "a cockpit-only mesh outside").not.toContain(name);
      // IN COCKPIT VIEW, through the visual's own setCockpitView and counted by what the COCKPIT camera draws:
      // the frame appears, and the fuselage, radome and dorsal spine drop out of its layer mask (the canopy stays,
      // at the cockpit alpha). (A first version set the
      // frame visible by hand and ignored the mask, and reported a colour-pass count no camera draws.)
      jet.visual.setCockpitView(true);
      const inside = jet.meshes.filter(drawnBy(cockpitMask));
      for (const name of ["jet-hud-frame", "jet-hud-housing", "jet-hud-combiner", "jet-mfd-frames", "jet-mfd-rims", "jet-screens", "jet-sills"]) expect(inside.map((mesh) => mesh.name)).toContain(name);
      const hiddenByMask = outside.filter((mesh) => (mesh.layerMask & cockpitMask) === 0).map((mesh) => mesh.name).sort();
      expect(hiddenByMask, "what the cockpit camera does not draw").toEqual(jet.visual.cockpitParts.map((mesh) => mesh.name).sort());
      expect(hiddenByMask, "NON-VACUITY: the mask hides something").toHaveLength(3);
      expect(inside).toHaveLength(outside.length - hiddenByMask.length + 7);
      // the one alpha draw the kit adds: the combiner's two panes, one mesh (the canopy's is the airframe's own)
      const blended = (mesh: AbstractMesh) => (mesh.material as PBRMaterial | null)?.needAlphaBlendingForMesh(mesh) ?? false;
      expect(inside.filter(blended).map((mesh) => mesh.name).sort()).toEqual(["jet-bubble-canopy", "jet-hud-combiner"]);
      expect(outside.filter(blended).map((mesh) => mesh.name)).toEqual(["jet-bubble-canopy"]);
      // the shadow passes are the sun's, not the cockpit camera's: the casters do not change with the view
      expect(jet.meshes.filter((mesh) => drawnBy(exteriorMask)(mesh) || drawnBy(cockpitMask)(mesh)).filter(casts)).toHaveLength(54);
      jet.visual.setCockpitView(false);
    } finally {
      jet.dispose();
    }
  });
});
