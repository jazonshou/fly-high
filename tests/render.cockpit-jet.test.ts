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
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  JET_COAMING,
  JET_DISPLAY_AIRFRAME,
  JET_HUD_FRAME,
  JET_MFD,
  JET_PANEL,
  jetCoamingEdgeElevationDegrees,
  jetCoamingHalfWidth,
  jetCoamingTopY,
  jetHudFrameAngles,
  jetHudFrameFootY,
  jetMfdFrame,
  jetMfdPlacements,
  jetPanelTopY,
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
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";

/**
 * The F-16's cockpit, phases F1 (the coaming, the board, the HUD frame) and F2
 * (the two MFDs), held to the angles it was built to and to the airframe it
 * stands in.
 *
 * The EYE is the catalogue's (2.22, 0.94, 0), which this phase does not move.
 * Everything is asserted as angles from it at the 75 degree lens, measured on the
 * BUILT meshes by ray or by vertex, never derived from the builder's constants:
 * the coaming's far edge -10.2 straight ahead (+-0.1), over the nose probe, and its near edge -16.0;
 * the HUD frame's uprights at az +-6.5 and its bar at +4.5, the box containing
 * (0, 0); the uprights' feet buried in the coaming; the board bare under it;
 * the canopy two-sided from the seat.
 *
 * AND THE GATE: every other mesh of the jet is where f9d2672 had it (world
 * positions to the micrometre, and indices, mesh by mesh). A cockpit branch that
 * nudged a wing by a millimetre would fail here. The other three airframes are
 * pinned whole by `render.loft-crown-seam.test.ts`.
 */

const DEG = 180 / Math.PI;
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
 * `jet-hud-frame` is three untapered rods merged in one order, vertices in that order: the port
 * upright, the starboard upright, the bar, 38 vertices and 32 triangles each (an 8-sided cylinder with
 * its two caps). Pinned so a change to a strut fails loudly instead of slicing the wrong vertices.
 */
const FRAME_ORDER = ["port", "starboard", "bar"] as const;
const FRAME_SOURCES = ["jet-hud-frame-upright-port", "jet-hud-frame-upright-starboard", "jet-hud-frame-bar"];
const FRAME_VERTICES = 38;
const FRAME_TRIANGLES = 32;
function frameBlock(which: (typeof FRAME_ORDER)[number]): Vector3[] {
  const mesh = named("jet-hud-frame");
  expect((mesh.metadata as { mergedFrom?: string[] }).mergedFrom, "the frame's sources, in merge order").toEqual(FRAME_SOURCES);
  const vertices = worldVertices(mesh);
  expect(vertices.length, "the frame's vertices").toBe(FRAME_VERTICES * FRAME_ORDER.length);
  const k = FRAME_ORDER.indexOf(which);
  return vertices.slice(k * FRAME_VERTICES, (k + 1) * FRAME_VERTICES);
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
  it("has its far edge at -10.2 degrees straight ahead: the silhouette", () => {
    const far = silhouette("jet-glare-shield", 0);
    expect(Number.isFinite(far), "found the coaming").toBe(true);
    expect(Math.abs(far + 10.2)).toBeLessThan(0.1);
    // the builder's own arithmetic agrees, and the far edge's vertices are where the ray says
    expect(Math.abs(jetCoamingEdgeElevationDegrees("far") + 10.2)).toBeLessThan(0.1);
    const vertices = worldVertices(named("jet-glare-shield"));
    const farTop = vertices.filter((v) => Math.abs(v.x - JET_COAMING.farX) < 1e-6 && Math.abs(v.y - JET_COAMING.farTopY) < 1e-6);
    expect(farTop.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(Math.atan2(farTop[0]!.y - EYE.up, farTop[0]!.x - EYE.forward) * DEG + 10.2)).toBeLessThan(0.1);
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
    // by ray, over the probe's own width: the first surface at every elevation from the tip down is the coaming
    for (let az = -0.3; az <= 0.3; az += 0.05) {
      for (let e = probeTop + 0.02; e >= -20; e -= 0.05) expect(firstHit(az, e)?.name, `azimuth ${az.toFixed(2)}, elevation ${e.toFixed(2)}`).toBe("jet-glare-shield");
    }
    // THE CONTROL: the instrument can see the probe -- with the coaming left out, it is the first surface just
    // under its tip straight ahead
    const withoutCoaming = scene.pickWithRay(new Ray(EYE_POINT, direction(0, probeTop - 0.01), 60), (mesh) => drawnByCockpitCamera(mesh) && mesh.name !== "jet-glare-shield");
    expect(withoutCoaming?.pickedMesh?.name).toBe("jet-air-data-probe");
  });

  it("has its near edge, the panel face, at -16.0: the top surface shows as a 5.8 degree band and the near face below it", () => {
    const vertices = worldVertices(named("jet-glare-shield"));
    const nearTop = vertices.filter((v) => Math.abs(v.x - JET_COAMING.nearX) < 1e-6 && Math.abs(v.y - JET_COAMING.nearTopY) < 1e-6);
    expect(nearTop.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(Math.atan2(nearTop[0]!.y - EYE.up, nearTop[0]!.x - EYE.forward) * DEG + 16)).toBeLessThan(0.1);
    expect(Math.abs(jetCoamingEdgeElevationDegrees("near") + 16)).toBeLessThan(0.1);
    // by ray: from -10.2 down to -16 the picked point lies ON the sloping top surface, and below -16 on the near face
    let band = 0;
    for (let e = -10.3; e >= -15.9; e -= 0.1) {
      const hit = firstHitInfo(0, e);
      expect(hit?.pickedMesh?.name, `at elevation ${e.toFixed(1)}`).toBe("jet-glare-shield");
      const p = hit!.pickedPoint!;
      expect(Math.abs(p.y - jetCoamingTopY(p.x)), `the point at elevation ${e.toFixed(1)} is on the top surface`).toBeLessThan(1e-3);
      band += 1;
    }
    expect(band).toBeGreaterThan(54);
    for (let e = -16.1; e >= -20; e -= 0.1) {
      const hit = firstHitInfo(0, e);
      expect(hit?.pickedMesh?.name, `at elevation ${e.toFixed(1)}`).toBe("jet-glare-shield");
      expect(Math.abs(hit!.pickedPoint!.x - JET_COAMING.nearX), `the point at elevation ${e.toFixed(1)} is on the near face`).toBeLessThan(1e-3);
    }
    // the edge between them reads -16.0 by ray too: the last elevation on the top surface
    let edge = Number.NaN;
    for (let e = -15; e >= -17; e -= 0.01) {
      const p = firstHitInfo(0, e)?.pickedPoint;
      if (p && p.x < JET_COAMING.nearX + 1e-4) {
        edge = e;
        break;
      }
    }
    expect(Math.abs(edge + 16)).toBeLessThan(0.1);
  });

  it("keeps its silhouette within a quarter degree of -10.2 across the far edge, highest at its far corners (a straight edge reads highest off-centre), and falling away past them", () => {
    // A horizontal straight edge below the eye reads |el| LARGEST straight ahead and smaller toward its ends,
    // so a far edge built to -10.19 at az 0 reads -9.99 at its corners (az +-11.5); past them the silhouette is
    // the top side edge, falling to -10.95 at az 15. Nothing of the coaming reads above -9.99 anywhere in the
    // frame. Read off the coaming's OWN triangles: at az +-5.96 to 7.05 the HUD frame's uprights stand in front of
    // it, and its edge is still where it is.
    const coaming = worldTriangles(named("jet-glare-shield"));
    const ownTop = (az: number) => {
      for (let e = 5; e >= -30; e -= 0.02) if (crossings(EYE_POINT, direction(az, e), coaming).length > 0) return e;
      return Number.NaN;
    };
    let highest = Number.NEGATIVE_INFINITY;
    let at = 0;
    for (let az = -15; az <= 15; az += 0.5) {
      const top = ownTop(az);
      expect(Number.isFinite(top), `the coaming at azimuth ${az}`).toBe(true);
      expect(top, `silhouette at azimuth ${az}`).toBeLessThanOrEqual(-9.97);
      expect(top, `silhouette at azimuth ${az}`).toBeGreaterThanOrEqual(Math.abs(az) <= 11.5 ? -10.25 : -11.0);
      if (top > highest) {
        highest = top;
        at = az;
      }
    }
    expect(highest).toBeGreaterThan(-10.05);
    expect(highest).toBeLessThan(-9.97);
    expect(Math.abs(at)).toBeGreaterThan(10);
    expect(Math.abs(at)).toBeLessThan(13);
    // and no vertex of the coaming reads above the silhouette band anywhere in the frame
    for (const v of worldVertices(named("jet-glare-shield"))) {
      const { az, el } = azel(v);
      if (Math.abs(az) <= 37.5) expect(el, `vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`).toBeLessThanOrEqual(-9.97);
    }
  });

  it("is the wedge it was designed to be: top from (2.92, 0.739) to (3.50, 0.710), underside 0.60, plan half-widths 0.38 to 0.26, vertical sides, flat-shaded", () => {
    const mesh = named("jet-glare-shield");
    const vertices = worldVertices(mesh);
    expect(vertices.length, "a solidPlate of 12 triangles, three vertices each").toBe(36);
    expect(mesh.getIndices()!.length / 3).toBe(12);
    const c = JET_COAMING;
    for (const v of vertices) {
      const atNear = Math.abs(v.x - c.nearX) < 1e-6;
      const atFar = Math.abs(v.x - c.farX) < 1e-6;
      expect(atNear || atFar, `vertex x ${v.x}`).toBe(true);
      // top or underside
      const onTop = Math.abs(v.y - jetCoamingTopY(v.x)) < 1e-6;
      const onUnderside = Math.abs(v.y - c.undersideY) < 1e-6;
      expect(onTop || onUnderside, `vertex y ${v.y} at x ${v.x}`).toBe(true);
      // the sides are vertical planes: every vertex sits at the plan's half-width for its station
      expect(Math.abs(Math.abs(v.z) - jetCoamingHalfWidth(v.x)), `vertex z ${v.z} at x ${v.x}`).toBeLessThan(1e-6);
    }
    expect(Math.max(...vertices.filter((v) => Math.abs(v.x - c.nearX) < 1e-6).map((v) => Math.abs(v.z)))).toBeCloseTo(0.38, 6);
    expect(Math.max(...vertices.filter((v) => Math.abs(v.x - c.farX) < 1e-6).map((v) => Math.abs(v.z)))).toBeCloseTo(0.26, 6);
    expect(Math.min(...vertices.map((v) => v.y))).toBeCloseTo(0.6, 6);
    expect(Math.max(...vertices.map((v) => v.y))).toBeCloseTo(0.739, 6);
    // flat normals, one per triangle, pointing OUT -- ALL TWELVE, the side walls and the far face too, which only
    // the outside sees: each stored normal points away from the wedge's centre, and the winding agrees with it
    // (by the drawn-face rule a face's cross product points INTO the solid, so the outward normal is its negative)
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = mesh.getIndices()!;
    const middle = vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);
    for (let t = 0; t < indices.length; t += 3) {
      const n = [0, 1, 2].map((k) => new Vector3(normals[indices[t + k]! * 3]!, normals[indices[t + k]! * 3 + 1]!, normals[indices[t + k]! * 3 + 2]!));
      expect(Vector3.Distance(n[0]!, n[1]!)).toBeLessThan(1e-6);
      expect(Vector3.Distance(n[0]!, n[2]!)).toBeLessThan(1e-6);
      const corners = [0, 1, 2].map((k) => vertices[indices[t + k]!]!);
      const faceCentre = corners[0]!.add(corners[1]!).add(corners[2]!).scale(1 / 3);
      expect(Vector3.Dot(n[0]!, faceCentre.subtract(middle)), `triangle ${t / 3}: its normal points out of the wedge`).toBeGreaterThan(0);
      const inward = Vector3.Cross(corners[1]!.subtract(corners[0]!), corners[2]!.subtract(corners[0]!)).normalize();
      expect(Vector3.Dot(n[0]!, inward), `triangle ${t / 3}: its winding agrees with its normal`).toBeLessThan(-0.999);
      if (corners.every((v) => Math.abs(v.y - jetCoamingTopY(v.x)) < 1e-6)) expect(n[0]!.y, "a top triangle's normal points up").toBeGreaterThan(0.9);
      if (corners.every((v) => Math.abs(v.y - c.undersideY) < 1e-6)) expect(n[0]!.y, "an underside triangle's normal points down").toBeLessThan(-0.99);
    }
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

  it("fills the bottom of the frame straight ahead and hides the board: from -10.2 to the frame's bottom every ray meets the coaming", () => {
    let rays = 0;
    for (let e = -10.25; e >= -frameLimit(0); e -= 0.05) {
      expect(firstHit(0, e)?.name, `at elevation ${e.toFixed(2)}`).toBe("jet-glare-shield");
      rays += 1;
    }
    expect(rays).toBeGreaterThan(250);
    // the board is the first surface NOWHERE in the frame. The grid is clipped to the 16:9 frame, which is a
    // RECTANGLE: at az 29 its bottom is -20.7, not -23.35, and an unclipped grid found the design's 0.40 board at (-29, -23),
    // a direction no 16:9 window shows.
    let inFrame = 0;
    for (let az = -37; az <= 37; az += 1) {
      for (let el = -23; el <= 23; el += 1) {
        if (Math.abs(el) > frameLimit(az)) continue;
        inFrame += 1;
        expect(firstHit(az, el)?.name, `the board shows at azimuth ${az}, elevation ${el}`).not.toBe("jet-instrument-panel");
      }
    }
    expect(inFrame).toBeGreaterThan(3000);
    // THE CONTROL: the board is there and the instrument can see it -- from a point under the coaming's underside
    // looking straight ahead, it is the first surface
    expect(firstHit(0, 0, new Vector3(EYE.forward, 0.5, 0))?.name).toBe("jet-instrument-panel");
  });
});

describe("the HUD frame", () => {
  it("is one of the three cockpit-only meshes (with the MFDs' bezels and screens), three struts merged on the shared matte glareshield material, and there is no glass plate", () => {
    expect(cockpitOnly.map((part) => part.name)).toEqual(["jet-hud-frame", "jet-mfd-bezels", "jet-screens"]);
    const frame = named("jet-hud-frame");
    expect((frame.metadata as { mergedFrom?: string[] }).mergedFrom).toEqual(FRAME_SOURCES);
    expect(frame.getTotalVertices()).toBe(FRAME_VERTICES * 3);
    expect(frame.getIndices()!.length / 3).toBe(FRAME_TRIANGLES * 3);
    const material = frame.material as PBRMaterial;
    expect(material.name).toBe("jet-glareshield");
    expect(material.environmentIntensity, "lit by the sky; matte: reflects nothing").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect(material.metallicF0Factor).toBe(0);
    expect(material.metallicF0Factor).toBe(0);
    expect(material.roughness).toBe(1);
    expect(scene.materials.filter((m) => m.name === "jet-glareshield"), "one instance").toHaveLength(1);
    expect((frame.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBe(true);
    expect((frame.metadata as { castsShadow?: boolean }).castsShadow).toBe(false);
    // no plate: nothing else of the HUD is a mesh, and no mesh is glass but the canopy
    expect(scene.meshes.filter((m) => /hud/i.test(m.name)).map((m) => m.name)).toEqual(["jet-hud-frame"]);
    expect(scene.meshes.filter((m) => m.getTotalVertices() > 0 && (m.material as PBRMaterial | null)?.needAlphaBlendingForMesh(m) && m.isEnabled()).map((m) => m.name)).toEqual(["jet-bubble-canopy"]);
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
    // radius 0.008 END TO END: the struts are untapered (`strutBetween` made every `from` end 8% fatter, and the
    // bar was lopsided on screen by 1.5 px). Ring vertices of an upright, and of the bar, stand 0.008 off the axis.
    // (8 mm, not the first 12: at 12 the frame read as a black doorway, the uprights about 30 px wide at 1600.)
    for (const [which, upright] of [["port", port], ["starboard", starboard]] as const) {
      const axisZ = centre(upright, "z");
      const uprightRadial = upright.map((v) => Math.hypot(v.x - 3.05, v.z - axisZ)).filter((r) => r > 0.005);
      expect(Math.min(...uprightRadial), `the ${which} upright's thinnest ring`).toBeCloseTo(0.008, 4);
      expect(Math.max(...uprightRadial), `the ${which} upright's fattest ring`).toBeCloseTo(0.008, 4);
    }
    const barRadial = bar.map((v) => Math.hypot(v.x - 3.05, v.y - JET_HUD_FRAME.barY)).filter((r) => r > 0.005);
    expect(Math.min(...barRadial), "the bar's thinnest ring").toBeCloseTo(0.008, 4);
    expect(Math.max(...barRadial), "the bar's fattest ring").toBeCloseTo(0.008, 4);
    // the bar runs between the uprights' AXES, so its ends are inside the uprights (to their outboard faces it
    // stood 1.6 px past them), and the uprights run up to the bar's top: the corners close
    expect(Math.max(...bar.map((v) => Math.abs(v.z)))).toBeCloseTo(JET_HUD_FRAME.z, 4);
    expect(Math.max(...starboard.map((v) => v.y))).toBeCloseTo(JET_HUD_FRAME.barY + JET_HUD_FRAME.radius, 4);
  });

  it("rises out of the coaming's top surface at -13.95 (the surface at x 3.05 is y 0.7325) and is seen from there up to the bar", () => {
    for (const side of [-1, 1] as const) {
      const az = side * jetHudFrameAngles().uprightAzimuthDegrees;
      let foot = Number.NaN;
      for (let e = -20; e <= 0; e += 0.02) {
        if (firstHit(az, e)?.name === "jet-hud-frame") {
          foot = e;
          break;
        }
      }
      expect(Number.isFinite(foot), `the upright at azimuth ${az.toFixed(1)}`).toBe(true);
      // where the upright's axis crosses the coaming's top surface, by arithmetic: (3.05, 0.7325) reads -13.95
      const surface = azel(new Vector3(JET_HUD_FRAME.x, jetCoamingTopY(JET_HUD_FRAME.x), side * JET_HUD_FRAME.z)).el;
      expect(Math.abs(foot - surface)).toBeLessThan(0.15);
      expect(foot).toBeGreaterThan(-14.15);
      expect(foot).toBeLessThan(-13.75);
      // below the visible foot it is the coaming, and above it the upright all the way to the bar
      expect(firstHit(az, foot - 0.1)?.name).toBe("jet-glare-shield");
      let upright = 0;
      for (let e = foot + 0.1; e <= 4; e += 0.25) {
        expect(firstHit(az, e)?.name, `at elevation ${e.toFixed(2)}`).toBe("jet-hud-frame");
        upright += 1;
      }
      expect(upright).toBeGreaterThan(60);
    }
    // straight ahead, above the coaming, there is nothing but the bar in the frame: the symbology's window is open
    // from the coaming's edge (-10.19) to the bar's underside (+3.95)
    for (let e = -10.1; e <= 3.55; e += 0.25) expect(firstHit(0, e)?.name ?? null, `something at azimuth 0, elevation ${e.toFixed(2)}`).toBeNull();
    expect(firstHit(0, jetHudFrameAngles().barElevationDegrees)?.name).toBe("jet-hud-frame");
  });

  it("buries the uprights' feet 0.03 m inside the coaming, measured against the coaming's own triangles", () => {
    // Measured, not restated: the coaming's top surface over each foot is found by a vertical ray against the
    // coaming's triangles, and every foot vertex is INSIDE the closed wedge (an odd number of crossings upward).
    // (A ray survey that looked for the foot caps from the eye used to stand here. It could not fail: a cap faces
    // down, so from an eye above it a ray meets the strut's wall first whatever the cap's winding or depth. What
    // hides a cap is that it is culled, held by the test below, and that the foot is buried, held here.)
    const coaming = worldTriangles(named("jet-glare-shield"));
    for (const which of ["port", "starboard"] as const) {
      const block = frameBlock(which);
      const lowest = Math.min(...block.map((v) => v.y));
      const foot = block.filter((v) => Math.abs(v.y - lowest) < 1e-4);
      // the bottom ring of the side wall (9), the cap's ring (9) and its centre (1)
      expect(foot.length, `${which} foot vertices`).toBe(19);
      const axis = new Vector3(centre(foot, "x"), lowest, centre(foot, "z"));
      const up = crossings(axis, new Vector3(0, 1, 0), coaming);
      expect(up.length, `${which}: the foot's axis is inside the coaming (one crossing up, through the top)`).toBe(1);
      expect(up[0]!, `${which}: depth under the coaming's top surface`).toBeCloseTo(0.03, 4);
      for (const v of foot) {
        expect(crossings(v, new Vector3(0, 1, 0), coaming).length % 2, `${which} foot vertex (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) inside the wedge`).toBe(1);
        expect(crossings(v, new Vector3(0, -1, 0), coaming).length, "and above its underside").toBe(1);
        expect(crossings(v, new Vector3(0, -1, 0), coaming)[0]!, "at least a centimetre above the underside").toBeGreaterThan(0.01);
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
    const topY = JET_HUD_FRAME.barY + JET_HUD_FRAME.radius;
    const f = JET_HUD_FRAME;
    const flat = (t: Triangle, pick: (v: Vector3) => number, value: number) => [t.a, t.b, t.c].every((v) => Math.abs(pick(v) - value) < 1e-4);
    const caps = {
      feet: triangles.filter((t) => flat(t, (v) => v.y, footY)),
      tops: triangles.filter((t) => flat(t, (v) => v.y, topY) && [t.a, t.b, t.c].every((v) => Math.abs(Math.abs(v.z) - f.z) < f.radius + 1e-4)),
      // each end is flat at ONE z (flat in |z| would also take the bar's own side walls, which run end to end)
      barEnds: triangles.filter((t) => (flat(t, (v) => v.z, f.z) || flat(t, (v) => v.z, -f.z)) && [t.a, t.b, t.c].every((v) => Math.abs(v.y - f.barY) < f.radius + 1e-4)),
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

  it("clears the BUILT canopy by at least 0.05 m everywhere: 0.074 at the frame's top corners, 0.1 m nearer the eye than the design put it", () => {
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
    expect(clearance, "the record: 0.074").toBeLessThan(0.08);
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
      expect(parts.map((part) => part.name)).toEqual(["jet-hud-frame", "jet-mfd-bezels", "jet-screens"]);
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

describe("the panel board", () => {
  it("is one bare box under the coaming: face 1 mm ahead of the coaming's near face, from the tub's top to 2 cm inside the coaming, half-width 0.355 so its top is under the coaming along its whole depth", () => {
    const board = named("jet-instrument-panel");
    const vertices = worldVertices(board);
    expect(vertices.length).toBe(24);
    expect(Math.min(...vertices.map((v) => v.x))).toBeCloseTo(JET_PANEL.faceX + JET_PANEL.setBack, 6);
    const coamingVertices = worldVertices(named("jet-glare-shield"));
    expect(Math.min(...vertices.map((v) => v.x)) - Math.min(...coamingVertices.map((v) => v.x)), "1 mm ahead of the coaming's near face: no coincident faces").toBeCloseTo(0.001, 6);
    expect(Math.max(...vertices.map((v) => v.x))).toBeCloseTo(JET_PANEL.faceX + JET_PANEL.setBack + JET_PANEL.thickness, 6);
    expect(Math.max(...vertices.map((v) => Math.abs(v.z)))).toBeCloseTo(0.355, 6);
    const top = Math.max(...vertices.map((v) => v.y));
    const bottom = Math.min(...vertices.map((v) => v.y));
    expect(bottom).toBeCloseTo(0.3, 6);
    expect(bottom, "standing on the tub").toBeCloseTo(Math.max(...worldVertices(named("jet-cockpit-tub")).map((v) => v.y)), 6);
    expect(top).toBeCloseTo(jetPanelTopY(), 6);
    // the top is INSIDE the coaming over the board's whole depth: above the underside, below the top surface
    expect(top).toBeGreaterThan(JET_COAMING.undersideY + 0.01);
    for (const x of [JET_PANEL.faceX + JET_PANEL.setBack, JET_PANEL.faceX + JET_PANEL.setBack + JET_PANEL.thickness]) {
      expect(top, `under the coaming's top surface at x ${x.toFixed(3)}`).toBeLessThan(jetCoamingTopY(x) - 0.05);
    }
    // and INSIDE ITS PLAN, which narrows toward the nose: every top corner of the board, wherever the board's depth
    // puts it, is inside the closed wedge by the coaming's own triangles (odd crossings straight up), clear of its
    // side walls: 4.1 mm at the back corners, where the plan has narrowed to 0.359. A board that outran the
    // narrowing -- 0.40 wide, or 0.3 deep -- showed its top from outside as strips beside the coaming.
    const coaming = worldTriangles(named("jet-glare-shield"));
    const topCorners = vertices.filter((v) => Math.abs(v.y - top) < 1e-6);
    expect(topCorners.length, "the top face's corners").toBeGreaterThanOrEqual(4);
    for (const v of topCorners) {
      expect(crossings(v, new Vector3(0, 1, 0), coaming).length % 2, `board corner (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) inside the coaming`).toBe(1);
      for (const side of [-1, 1]) {
        const sideways = crossings(v, new Vector3(0, 0, side), coaming);
        expect(sideways.length, "one wall that way").toBe(1);
        expect(sideways[0]!, `board corner (${v.x.toFixed(3)}, ${v.z.toFixed(3)}) to the coaming's ${side < 0 ? "port" : "starboard"} wall`).toBeGreaterThan(0.003);
      }
    }
    // an ordinary part on the interior material, as the tub and the seat are
    expect(board.material).toBe(named("jet-cockpit-tub").material);
    expect(board.material!.name).toBe("jet-interior");
    expect((board.metadata as { cockpitInterior?: boolean }).cockpitInterior).toBe(true);
    expect((board.metadata as { cockpitOnly?: boolean }).cockpitOnly).toBeUndefined();
    expect((board.metadata as { castsShadow?: boolean }).castsShadow, "it casts, as the old panel did").toBe(true);
    expect(board.layerMask & camera.layerMask, "on a layer the cockpit camera draws").not.toBe(0);
    expect(board.rotationQuaternion, "no tilt").toBeNull();
    expect(board.rotation.z).toBe(0);
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
  const READS = { bezelTop: -16.23, screenTop: -17.7, screenBottom: -25.62, bezelBottom: -27.88 };
  /**
   * Of the screen's height as the eye reads it, how much is inside the 16:9 frame at the MFDs' azimuth: 63%, the
   * screen lifted 6 mm in its bezel (centred it was 57%, under the 60% the brief set).
   */
  const IN_FRAME = 0.63;
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

  it("stand on the coaming's near face, tilted back 15 degrees about the top, 1 mm off the face and under the 0.735 ceiling", () => {
    const bezels = worldVertices(named("jet-mfd-bezels"));
    const screens = worldVertices(named("jet-screens"));
    expect(bezels).toHaveLength(48);
    expect(screens).toHaveLength(48);
    const all = [...bezels, ...screens];
    // THE CEILING: nothing of the MFDs above 0.735, 4 mm under the coaming's top surface where it starts (its built
    // near top edge, 0.739) -- against the design's number and the built coaming, not the builder's own constant
    const coamingTop = Math.max(...worldVertices(named("jet-glare-shield")).map((v) => v.y));
    expect(coamingTop).toBeCloseTo(0.739, 6);
    expect(Math.max(...all.map((v) => v.y)), "the highest point, the bezels' front top edge").toBeCloseTo(0.735, 6);
    expect(coamingTop - Math.max(...all.map((v) => v.y)), "under the coaming's top surface").toBeGreaterThan(0.0035);
    // 1 mm off the face plane (x 2.92), nothing behind it: no coincident faces with the near face or the board
    expect(Math.max(...bezels.map((v) => v.x)), "the bezels' back top edge").toBeCloseTo(JET_PANEL.faceX - 0.001, 6);
    expect(Math.max(...screens.map((v) => v.x)), "the screens are in front of the bezels").toBeLessThan(JET_PANEL.faceX - 0.001);
    // the bottom stands out toward the pilot: the bezels' back bottom edge is 0.15 sin 15 = 3.9 cm proud
    const lowest = Math.min(...bezels.map((v) => v.y));
    const bottomBack = bezels.filter((v) => Math.abs(v.y - lowest) < 0.006);
    expect(JET_PANEL.faceX - Math.max(...bottomBack.map((v) => v.x)), "the bottom stands proud").toBeCloseTo(0.001 + 0.15 * Math.sin((15 * Math.PI) / 180), 3);
    // THE TILT, from the built faces' own normals: the pilot-facing faces point 15 degrees UP, toward the eye
    const mesh = named("jet-screens");
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const facing: number[] = [];
    for (let i = 0; i < normals.length; i += 3) if (normals[i]! < -0.9) facing.push((Math.atan2(normals[i + 1]!, -normals[i]!) * 180) / Math.PI);
    expect(facing.length, "the two screens' pilot-facing corners").toBe(8);
    for (const angle of facing) expect(angle, "the face's normal above horizontal").toBeCloseTo(15, 3);
    // THE BEZELS' MATERIAL: their own dark grey, the type's, neither the interior grey (on which they read as light
    // slabs, 79/255 against the coaming face's 20.5) nor the glareshield. Albedo 0x10 a channel: the lit face reads
    // 41, twice the coaming's face (measured live, one frozen pose). One instance, worn by the bezels alone.
    const bezelMaterial = named("jet-mfd-bezels").material as PBRMaterial;
    expect(bezelMaterial.name).toBe("jet-mfd-bezel");
    expect(bezelMaterial, "not the interior grey").not.toBe(named("jet-instrument-panel").material);
    expect(bezelMaterial, "not the glareshield").not.toBe(named("jet-glare-shield").material);
    for (const channel of ["r", "g", "b"] as const) expect(bezelMaterial.albedoColor[channel], `albedo ${channel}`).toBeCloseTo(0x10 / 255, 6);
    expect(bezelMaterial.roughness).toBe(0.8);
    expect(scene.meshes.filter((mesh) => mesh.material === bezelMaterial).map((mesh) => mesh.name), "its only wearer").toEqual(["jet-mfd-bezels"]);
    expect(scene.materials.filter((material) => material.name === "jet-mfd-bezel"), "one instance").toHaveLength(1);
    // square, centred at z +-0.17, 0.102 of screen in a 0.15 bezel; the 0.19 between them is the UFC's
    for (const [name, side] of sides) {
      const own = (vs: Vector3[]) => vs.filter((v) => Math.sign(v.z) === side);
      const zs = (vs: Vector3[]): [number, number] => [Math.min(...vs.map((v) => v.z)), Math.max(...vs.map((v) => v.z))];
      const [b0, b1] = zs(own(bezels));
      const [s0, s1] = zs(own(screens));
      expect(b1 - b0, `${name} bezel width`).toBeCloseTo(0.15, 6);
      expect(s1 - s0, `${name} screen width`).toBeCloseTo(0.102, 6);
      expect((b0 + b1) / 2, `${name} centre line`).toBeCloseTo(side * 0.17, 6);
      expect((s0 + s1) / 2, `${name} screen centred across`).toBeCloseTo(side * 0.17, 6);
    }
    expect(Math.min(...bezels.filter((v) => v.z > 0).map((v) => v.z)) * 2, "the gap between the bezels").toBeCloseTo(0.19, 6);
    // the screens' front stands 1 mm proud of the bezels' front, along the face's normal
    const { out } = jetMfdFrame();
    const front = (vs: Vector3[]) => Math.min(...vs.map((v) => Vector3.Dot(v, out.scale(-1))));
    // (against the design's 1 mm, not the builder's constant: a builder set to 0 would agree with itself)
    expect(front(bezels) - front(screens), "screen 1 mm proud of the bezel: no coincident faces").toBeCloseTo(0.001, 6);
  });

  it("are the first surface over every screen's face: nine points each, and with the screen gone the same rays go on to the bezel, and with both gone to the near face or the board", () => {
    const { up, out } = jetMfdFrame();
    const across = new Vector3(0, 0, 1);
    for (const { name, centre } of jetMfdPlacements()) {
      const faceCentre = centre.add(out.scale(JET_MFD.screenThickness / 2));
      for (const a of [-0.35, 0, 0.35]) {
        for (const b of [-0.35, 0, 0.35]) {
          const target = faceCentre.add(up.scale(a * JET_MFD.screen)).add(across.scale(b * JET_MFD.screen));
          const toward = target.subtract(EYE_POINT);
          const distance = toward.length();
          const ray = new Ray(EYE_POINT, toward.normalize(), 60);
          const hit = scene.pickWithRay(ray, drawnByCockpitCamera);
          expect(hit?.pickedMesh?.name, `${name} (${a}, ${b})`).toBe("jet-screens");
          expect(hit!.distance, `${name} (${a}, ${b}): at the face`).toBeCloseTo(distance, 3);
          // THE CONTROL, in two steps: the screens gone, the ray meets the bezel behind; both gone, the coaming's
          // near face or the board, further still. The rays are not passing through empty space by luck.
          const screens = named("jet-screens");
          const bezels = named("jet-mfd-bezels");
          screens.isVisible = false;
          try {
            const behind = scene.pickWithRay(ray, drawnByCockpitCamera);
            expect(behind?.pickedMesh?.name, `${name} (${a}, ${b}) without the screen`).toBe("jet-mfd-bezels");
            expect(behind!.distance).toBeGreaterThan(hit!.distance);
            bezels.isVisible = false;
            const panel = scene.pickWithRay(ray, drawnByCockpitCamera);
            expect(["jet-glare-shield", "jet-instrument-panel"], `${name} (${a}, ${b}) without the MFD`).toContain(panel?.pickedMesh?.name);
            expect(panel!.distance).toBeGreaterThan(behind!.distance);
          } finally {
            screens.isVisible = true;
            bezels.isVisible = true;
          }
        }
      }
    }
  });

  it("read, straight down each centre line (az +-14.4), bezel top -16.2, screen top -17.7 and bottom -25.6, bezel bottom -27.9: the frame's bottom (-22.7 there) cuts the screen, leaving 63% of it in view", () => {
    for (const [name, side] of sides) {
      const az = centreAzimuth(side);
      expect(Math.abs(az), `${name}: centre azimuth`).toBeGreaterThan(14.2);
      expect(Math.abs(az)).toBeLessThan(14.7);
      const seen = scan(az);
      const bezel = seen.get("jet-mfd-bezels");
      const screen = seen.get("jet-screens");
      expect(bezel && screen, `${name}: both found`).toBeTruthy();
      expect(Math.abs(bezel![0] - READS.bezelTop), `${name}: bezel top ${bezel![0].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(screen![0] - READS.screenTop), `${name}: screen top ${screen![0].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(screen![1] - READS.screenBottom), `${name}: screen bottom ${screen![1].toFixed(2)}`).toBeLessThan(0.2);
      expect(Math.abs(bezel![1] - READS.bezelBottom), `${name}: bezel bottom ${bezel![1].toFixed(2)}`).toBeLessThan(0.2);
      // above the MFD, the near face; below it, the board: the order down the line
      expect(seen.get("jet-glare-shield")![1], `${name}: the near face ends where the bezel starts`).toBeGreaterThan(bezel![0]);
      expect(seen.get("jet-instrument-panel")![0], `${name}: the board starts under the bezel`).toBeLessThan(bezel![1]);
      // THE FRAME: the screen's top is in it and the bezel's bottom is not, at the frame's bottom HERE (a rectangle's
      // bottom edge is -23.35 only straight ahead)
      const bottom = -frameLimit(az);
      expect(bottom).toBeGreaterThan(-22.8);
      expect(bottom).toBeLessThan(-22.6);
      expect(screen![0], `${name}: screen top inside the frame`).toBeGreaterThan(bottom);
      expect(bezel![1], `${name}: bezel bottom below the frame`).toBeLessThan(bottom);
      const inFrame = (screen![0] - Math.max(bottom, screen![1])) / (screen![0] - screen![1]);
      expect(Math.abs(inFrame - IN_FRAME), `${name}: ${(inFrame * 100).toFixed(1)}% of the screen in frame`).toBeLessThan(0.01);
      expect(inFrame, `${name}: the brief's bar`).toBeGreaterThanOrEqual(0.6);
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
      const fromOwnShip = Math.hypot(point.x - 600, point.y - 0.86 * pageRoundScale(400, 400));
      if (slot!.page === "nd" && /^[0-9]+$/.test(text) && align === "center" && fromOwnShip > 150) {
        roseLabels.push(text);
        expect(Math.min(point.x - 400, 800 - point.x), `rose label "${text}": its anchor from the slot's sides`).toBeGreaterThanOrEqual(20);
        expect(Math.min(left - 400, 800 - (left + width)), `rose label "${text}": its text from the slot's sides`).toBeGreaterThanOrEqual(20 - 1e-6);
      }
    }
    // at heading 90 the arc carries 3, 6, 9, 12 and 15; "9", at its top, would touch the heading box and is left out
    expect(roseLabels.sort(), "the rose's labels, both ends of the arc among them").toEqual(["12", "15", "3", "6"]);
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
    const { out } = jetMfdFrame();
    const ray = direction(az, bottom);
    const hit = EYE_POINT.add(ray.scale(Vector3.Dot(middle.subtract(EYE_POINT), out) / Vector3.Dot(ray, out)));
    const down = bottomEdge.subtract(topEdge);
    const fraction = Vector3.Dot(hit.subtract(topEdge), down) / down.lengthSquared();
    const rowsInFrame = fraction * displaySlots(JET_DISPLAYS)[1]!.h;
    expect(fraction, "the share of the screen, top down, in frame").toBeGreaterThan(0.6);
    expect(fraction).toBeLessThan(0.65);
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
    // the ND's rose: the 40 nm arc, the largest centred on own ship, which stands at 0.86 of the page's round scale
    // (234.5 on the square, 258 = 0.86 h on 440 x 300). Its radius is 178.2 on the square, set by its labels' room (the
    // smallest of 0.68 h = 272, 0.52 w = 208 and the labels' 178.2, with the labels' font from the page scale)
    const ownY = 0.86 * scale;
    const roseRadius = Math.max(...arcs.filter((arc, i) => centres[i]!.x === 600 && Math.abs(centres[i]!.y - ownY) < 1e-9).map((arc) => arc.radius));
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
  it("is the world through the glass: no opaque part at the frame's bottom corners, the sill is never the first surface, and there are no side walls this pass", () => {
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
    // the frame's bottom corners: no opaque cockpit part, and the canopy IS along the ray, so it is the world through glass
    for (const az of [-37.5, 37.5]) {
      const el = -frameLimit(az) + 0.1;
      expect(firstHit(az, el), `an opaque part at the bottom corner (azimuth ${az})`).toBeNull();
      expect(crossings(EYE_POINT, direction(az, el), canopy).length, `the glass at the bottom corner (azimuth ${az})`).toBeGreaterThan(0);
    }
    // the coaming's near corners are where it stops covering the bottom edge: az +-28.5
    const nearCorners = worldVertices(named("jet-glare-shield")).filter((v) => v.x < JET_COAMING.nearX + 1e-4 && v.y < JET_COAMING.undersideY + 1e-4);
    expect(nearCorners.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...nearCorners.map((v) => Math.abs(azel(v).az))), "from the mesh's own near bottom corners").toBeCloseTo(28.5, 0);
    // The sill IS inside the frame out to about az 22 -- straight ahead its own top reads -14.0, against the frame's
    // -23.35 -- but the coaming stands in front of it there, and beyond it drops below the frame's bottom. So it is
    // the first surface nowhere in the frame (and its see-through planform walls are never met from the seat).
    let sillTop = Number.NaN;
    for (let e = 0; e >= -30; e -= 0.05) {
      if (crossings(EYE_POINT, direction(0, e), sill).length > 0) {
        sillTop = e;
        break;
      }
    }
    expect(sillTop, "THE CONTROL: the sill is inside the frame straight ahead").toBeGreaterThan(-frameLimit(0));
    expect(firstHit(0, sillTop - 0.05)?.name, "and the coaming is in front of it").toBe("jet-glare-shield");
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
  /** F1 rebuilt or added the first three; F2 added the MFDs' two. */
  const REBUILT = ["jet-glare-shield", "jet-instrument-panel", "jet-hud-frame", "jet-mfd-bezels", "jet-screens"];
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

  it("keeps every jet mesh outside the cockpit's five where f9d2672 had it (world positions to the micrometre, and indices), mesh by mesh, and has exactly those five besides", () => {
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
      // 78 -> 69 -> 71: twelve gone in F1 (the ten dials and needles, the old glare-shield box and the old panel),
      // three there, and F2's two MFD meshes
      expect(jet.meshes).toHaveLength(71);
    } finally {
      jet.dispose();
    }
  });

  it("spends 174 draws outside cockpit view (184 at f9d2672: the ten dials and needles are gone), and in it the cockpit camera trades the skin's three for the kit's three", () => {
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
      for (const name of ["jet-hud-frame", "jet-mfd-bezels", "jet-screens"]) expect(outside.map((mesh) => mesh.name), "a cockpit-only mesh outside").not.toContain(name);
      // IN COCKPIT VIEW, through the visual's own setCockpitView and counted by what the COCKPIT camera draws:
      // the frame appears, and the fuselage, radome and dorsal spine drop out of its layer mask (the canopy stays,
      // at the cockpit alpha). (A first version set the
      // frame visible by hand and ignored the mask, and reported a colour-pass count no camera draws.)
      jet.visual.setCockpitView(true);
      const inside = jet.meshes.filter(drawnBy(cockpitMask));
      for (const name of ["jet-hud-frame", "jet-mfd-bezels", "jet-screens"]) expect(inside.map((mesh) => mesh.name)).toContain(name);
      const hiddenByMask = outside.filter((mesh) => (mesh.layerMask & cockpitMask) === 0).map((mesh) => mesh.name).sort();
      expect(hiddenByMask, "what the cockpit camera does not draw").toEqual(jet.visual.cockpitParts.map((mesh) => mesh.name).sort());
      expect(hiddenByMask, "NON-VACUITY: the mask hides something").toHaveLength(3);
      expect(inside).toHaveLength(outside.length - hiddenByMask.length + 3);
      // the shadow passes are the sun's, not the cockpit camera's: the casters do not change with the view
      expect(jet.meshes.filter((mesh) => drawnBy(exteriorMask)(mesh) || drawnBy(cockpitMask)(mesh)).filter(casts)).toHaveLength(54);
      jet.visual.setCockpitView(false);
    } finally {
      jet.dispose();
    }
  });
});
