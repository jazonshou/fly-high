import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  BIZJET_SHELL_SECTIONS,
  bizjetShellHalfWidth,
  bizjetShellTop,
} from "../src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";

/**
 * The Global's cockpit, held to the angles it was built to and to the shell it
 * stands in.
 *
 * The targets are the PM's G1 design, as angles from the pilot's left-seat eye
 * at the 75 degree lens: the hood's top edge -10 degrees (+-1) straight ahead;
 * four flat screens 0.22 by 0.15, the pilot's pair centred on the eye's own z,
 * their top edge 1.5 degrees below the hood's underside; the left windscreen
 * post's axis at azimuth -29 (+-1.5), raked like the glass, its foot inside the
 * shell at the sill; an overhead from the glass's top edge back to 0.3 m behind
 * the eye. The eye itself is the one `scripts/global-eye-solve.mts` found, and
 * it is checked here against the BUILT windscreen, not against the solver.
 *
 * Every measurement is a ray or a vertex of the BUILT meshes, so a transcription
 * error in the builder fails here instead of agreeing with itself.
 */

const DEG = 180 / Math.PI;
const EYE = aircraftSpec("bizjet").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);
const TAN_HALF_H = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
const TAN_HALF_V = TAN_HALF_H / (16 / 9);

let engine: NullEngine;
let scene: Scene;
let camera: UniversalCamera;
let aircraft: AircraftVisual;
let cockpitOnly: readonly AbstractMesh[];

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
/** What the cockpit camera would draw: enabled, visible, on a layer it renders, opaque. */
function drawnByCockpitCamera(mesh: AbstractMesh): boolean {
  const material = mesh.material as PBRMaterial | null;
  return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
    && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
}
/**
 * Babylon's picking ignores back-face culling, and the Global's fuselage is DRAWN
 * again in cockpit view with the eye inside it, so a ray that ignored culling would
 * hit the inside of the skin everywhere and never see the sky. The winding sign is
 * calibrated on a closed box (the overhead): the sign that hits it from outside and
 * misses it from inside is the one for which "front-facing" means what the renderer
 * means.
 */
let cullSign = 0;
function frontFacing(sign: number) {
  return (p0: Vector3, p1: Vector3, p2: Vector3, ray: Ray): boolean => {
    const e1 = p1.subtract(p0);
    const e2 = p2.subtract(p0);
    return sign * Vector3.Dot(Vector3.Cross(e1, e2), ray.direction) < 0;
  };
}
function hitsBox(control: AbstractMesh, origin: Vector3, sign: number): boolean {
  const picks = scene.multiPickWithRay(new Ray(origin, new Vector3(1, 0, 0), 50), (m) => m === control, frontFacing(sign));
  return (picks?.length ?? 0) > 0;
}
function calibrateCulling(): number {
  const control = named("bizjet-overhead");
  const centre = control.getBoundingInfo().boundingBox.centerWorld;
  let found = 0;
  for (const sign of [1, -1]) {
    if (hitsBox(control, centre.add(new Vector3(-2, 0, 0)), sign) && !hitsBox(control, centre, sign)) found = sign;
  }
  return found;
}
function firstHitDirection(direction: Vector3, from: Vector3 = EYE_POINT): { mesh: AbstractMesh; point: Vector3 } | null {
  const ray = new Ray(from, direction.normalize(), 60);
  const cullsBack = (mesh: AbstractMesh) => (mesh.material as PBRMaterial | null)?.backFaceCulling ?? false;
  // Two passes, because the triangle predicate is per pick and only some meshes cull.
  const culled = scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && cullsBack(m) && m.getTotalVertices() > 0, frontFacing(cullSign)) ?? [];
  const open = scene.multiPickWithRay(ray, (m) => drawnByCockpitCamera(m) && !cullsBack(m) && m.getTotalVertices() > 0) ?? [];
  let best: { mesh: AbstractMesh; point: Vector3; distance: number } | null = null;
  for (const hit of [...culled, ...open]) {
    if (hit.hit && hit.pickedMesh && hit.pickedPoint && (best === null || hit.distance < best.distance)) {
      best = { mesh: hit.pickedMesh, point: hit.pickedPoint, distance: hit.distance };
    }
  }
  return best ? { mesh: best.mesh, point: best.point } : null;
}
function firstHit(azimuth: number, elevation: number): { mesh: AbstractMesh; point: Vector3 } | null {
  const az = azimuth / DEG;
  const el = elevation / DEG;
  return firstHitDirection(new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)));
}
/** Elevations, scanning down from +30 in 0.05 degree steps, at which `name` is the first surface. */
function elevationsHit(name: string, azimuth: number): number[] {
  const out: number[] = [];
  for (let el = 30; el >= -45; el -= 0.05) {
    if (firstHit(azimuth, el)?.mesh.name === name) out.push(el);
  }
  return out;
}
/** Cells of a 60 x 34 grid over the real frame whose first surface is `name` (or sky, for null). */
function frameCells(name: string | null, region?: { az: [number, number]; el: [number, number] }): { hits: number; total: number } {
  let hits = 0;
  let total = 0;
  for (let j = 0; j < 34; j += 1) {
    const v = (1 - ((j + 0.5) / 34) * 2) * TAN_HALF_V;
    for (let i = 0; i < 60; i += 1) {
      const u = (((i + 0.5) / 60) * 2 - 1) * TAN_HALF_H;
      const az = Math.atan(u) * DEG;
      const el = Math.atan(v / Math.hypot(1, u)) * DEG;
      if (region && (az < region.az[0] || az > region.az[1] || el < region.el[0] || el > region.el[1])) continue;
      total += 1;
      const hit = firstHitDirection(new Vector3(1, v, u));
      if ((hit?.mesh.name ?? null) === name) hits += 1;
    }
  }
  return { hits, total };
}
/** Distance from the eye to the nearest point of a box mesh: clamp the eye into the box in its own frame. */
function distanceToBox(point: Vector3, mesh: AbstractMesh): number {
  const box = mesh.getBoundingInfo().boundingBox;
  const world = mesh.getWorldMatrix();
  const local = Vector3.TransformCoordinates(point, world.clone().invert());
  const clamped = new Vector3(
    Math.min(Math.max(local.x, box.minimum.x), box.maximum.x),
    Math.min(Math.max(local.y, box.minimum.y), box.maximum.y),
    Math.min(Math.max(local.z, box.minimum.z), box.maximum.z),
  );
  return Vector3.Distance(Vector3.TransformCoordinates(clamped, world), point);
}
function castWall(x: number, y: number, side: 1 | -1): number {
  const fuselage = named("bizjet-fuselage");
  const hit = scene.pickWithRay(new Ray(new Vector3(x, y, 0), new Vector3(0, 0, side), 5), (m) => m === fuselage);
  return hit?.hit ? hit.distance : Number.NaN;
}
function castCrown(x: number, z: number): number {
  const fuselage = named("bizjet-fuselage");
  const hit = scene.pickWithRay(new Ray(new Vector3(x, 3, z), new Vector3(0, -1, 0), 8), (m) => m === fuselage);
  return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : Number.NaN;
}
/**
 * The two ends of a cylinder from its vertices alone: the principal axis (power
 * iteration on the covariance), then the centroid of the vertices at each extreme
 * of the projection onto it, which is a ring perpendicular to the axis. `bottom`
 * is the end with the lower y.
 */
function cylinderEnds(vertices: Vector3[]): { bottom: Vector3; top: Vector3 } {
  const centre = vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);
  let axis = new Vector3(0.3, 1, 0.2).normalize();
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const next = Vector3.Zero();
    for (const v of vertices) {
      const d = v.subtract(centre);
      next.addInPlace(d.scale(Vector3.Dot(d, axis)));
    }
    axis = next.normalize();
  }
  if (axis.y < 0) axis = axis.scale(-1);
  const t = vertices.map((v) => Vector3.Dot(v.subtract(centre), axis));
  const ring = (extreme: number) => {
    // A tapered cylinder's principal axis is a hair off its geometric one, so a
    // ring's vertices differ in projection by about r x sin(that hair): a few
    // tenths of a millimetre. 5 mm takes the whole ring and none of the next.
    const members = vertices.filter((_, i) => Math.abs(t[i]! - extreme) < 0.005);
    return members.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / members.length);
  };
  return { bottom: ring(Math.min(...t)), top: ring(Math.max(...t)) };
}

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "bizjet");
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
  cullSign = calibrateCulling();
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the Global's cockpit parts", () => {
  it("calibrate back-face culling on a closed box before any ray is believed", () => {
    // If neither winding sign hits the overhead from outside and misses it from inside, every reading below is void.
    expect([1, -1]).toContain(cullSign);
    // and the fuselage really is drawn and really culls: from the eye, straight up, its skin is invisible
    const fuselage = named("bizjet-fuselage");
    expect(drawnByCockpitCamera(fuselage)).toBe(true);
    expect((fuselage.material as PBRMaterial).backFaceCulling).toBe(true);
    const up = scene.pickWithRay(new Ray(EYE_POINT, new Vector3(0, 1, 0), 5), (m) => m === fuselage);
    expect(up?.hit, "picking, which ignores culling, does see the skin").toBe(true);
    expect(firstHitDirection(new Vector3(0, 1, 0))?.mesh.name).not.toBe("bizjet-fuselage");
  });

  it("are eight static meshes and nothing else: the attitude ball's three pieces are gone", () => {
    const names = cockpitOnly.map((part) => part.name).sort();
    // The ball's three meshes hung from a pivot, so they could not be merged into anything and were
    // the only cockpit parts that were not static. The PFD page draws attitude now.
    expect(names.filter((name) => name.startsWith("bizjet-pfd-"))).toEqual([]);
    const fixed = names.filter((name) => !name.startsWith("bizjet-pfd-"));
    expect(fixed).toEqual([
      "bizjet-glareshield",
      "bizjet-instrument-panel",
      "bizjet-overhead",
      "bizjet-screen-bezels",
      "bizjet-screens",
      "bizjet-side-walls",
      "bizjet-windscreen-post-port",
      "bizjet-windscreen-post-starboard",
    ]);
    expect(fixed.length).toBe(8);
    expect(names).toEqual(fixed);
    // four screens are one mesh and four bezels are one mesh
    expect(named("bizjet-screens").metadata?.mergedFrom).toHaveLength(4);
    expect(named("bizjet-screen-bezels").metadata?.mergedFrom).toHaveLength(4);
  });

  it("sit the eye where the solver put it, and it holds all four constraints against the BUILT windscreen", () => {
    expect(EYE).toEqual({ forward: 11.9, up: 0.78, right: -0.52 });
    const glass = named("bizjet-windscreen");
    const vertices = worldVertices(glass);
    // In the vertical plane through the eye the pane's cross-section is the same rectangle at every z.
    const elevations = vertices.map((v) => Math.atan2(v.y - EYE.up, v.x - EYE.forward) * DEG);
    const top = Math.max(...elevations);
    const bottom = Math.min(...elevations);
    expect(EYE.up).toBeGreaterThanOrEqual(0.72);
    expect(EYE.up).toBeLessThanOrEqual(0.85);
    expect(top).toBeGreaterThanOrEqual(14);
    expect(top).toBeLessThanOrEqual(18);
    expect(bottom).toBeLessThanOrEqual(-14);
    expect(distanceToBox(EYE_POINT, glass)).toBeGreaterThanOrEqual(0.55);
    const crown = castCrown(EYE.forward, EYE.right);
    expect(crown - EYE.up).toBeGreaterThanOrEqual(0.15);
    // The control: the old eye, above the pane, fails the first two at once.
    const old = new Vector3(11.6, 1.05, -0.52);
    const oldTop = Math.max(...vertices.map((v) => Math.atan2(v.y - old.y, v.x - old.x) * DEG));
    expect(oldTop).toBeLessThan(0);
  });

  it("read the hood's top edge at -10 degrees straight ahead, and it is what the eye meets there", () => {
    const seen = elevationsHit("bizjet-glareshield", 0);
    expect(seen.length).toBeGreaterThan(10);
    expect(Math.max(...seen)).toBeGreaterThan(-11);
    expect(Math.max(...seen)).toBeLessThan(-9);
    // analytically, from the hood's own vertices: its highest, front-most corner in the eye's plane
    const vertices = worldVertices(named("bizjet-glareshield"));
    const topY = Math.max(...vertices.map((v) => v.y));
    const frontX = Math.max(...vertices.filter((v) => v.y > topY - 1e-6).map((v) => v.x));
    const el = Math.atan2(topY - EYE.up, frontX - EYE.forward) * DEG;
    expect(el).toBeGreaterThan(-11);
    expect(el).toBeLessThan(-9);
  });

  it("hang four screens 0.22 by 0.15 in front of the panel, the pilot's pair centred on the eye's own z", () => {
    // The sizes are the PM's numbers, written out here and not read from the
    // builder's constants, so moving a constant cannot move its own expectation.
    const WIDTH = 0.22;
    const HEIGHT = 0.15;
    const BEZEL = 0.01;
    const screens = worldVertices(named("bizjet-screens"));
    const bezels = worldVertices(named("bizjet-screen-bezels"));
    // A box has vertices at only two z levels, so a pair of them shows FOUR distinct z values: the first two
    // belong to the screen on one side, the last two to the other, and the gap between screens is the middle one.
    const clustersOf = (vertices: Vector3[], pair: (v: Vector3) => boolean) => {
      const inPair = vertices.filter(pair);
      const levels = [...new Set(inPair.map((v) => v.z.toFixed(5)))].map(Number).sort((a, b) => a - b);
      expect(levels.length, "distinct z levels in a pair").toBe(4);
      const boundary = (levels[1]! + levels[2]!) / 2;
      return {
        first: inPair.filter((v) => v.z < boundary),
        second: inPair.filter((v) => v.z >= boundary),
        gap: levels[2]! - levels[1]!,
      };
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
      // a pair: its two members side by side with a small gap, centred on the seat
      const all = [...first, ...second];
      const centre = (Math.max(...all.map((v) => v.z)) + Math.min(...all.map((v) => v.z))) / 2;
      expect(centre, `${label} pair centre`).toBeCloseTo(sign < 0 ? EYE.right : -EYE.right, 4);
      expect(gap, `${label} gap between the two`).toBeGreaterThan(0.005);
      expect(gap, `${label} gap between the two`).toBeLessThan(0.06);
    }
    // 0.22 m wide at the panel's distance is about 19 degrees
    const nearest = screens.filter((v) => v.z < 0).reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / screens.filter((v) => v.z < 0).length);
    const across = 2 * Math.atan(WIDTH / 2 / Vector3.Distance(nearest, EYE_POINT)) * DEG;
    expect(across).toBeGreaterThan(15);
    // bezels on the marking material so the night glow reaches them, screens on the face material
    expect(named("bizjet-screen-bezels").material).toBe(scene.getMaterialByName("bizjet-instrument-marking"));
    expect(named("bizjet-screens").material).toBe(scene.getMaterialByName("bizjet-instrument-face"));
  });

  it("put the screens' top edge 1.5 degrees under the hood's underside, and show them below it", () => {
    const panel = worldVertices(named("bizjet-glareshield"));
    const hoodTop = Math.max(...panel.map((v) => v.y));
    // the hood's aft edge: the smallest x among the vertices at the hood's top level
    const aft = Math.min(...panel.filter((v) => v.y > hoodTop - 1e-6).map((v) => v.x));
    const hoodUnder = Math.atan2(hoodTop - 0.02 - EYE.up, aft - EYE.forward) * DEG;
    const screens = worldVertices(named("bizjet-screens"));
    const screenTop = Math.max(...screens.map((v) => v.y));
    const screenFront = Math.min(...screens.map((v) => v.x));
    const screenTopEl = Math.atan2(screenTop - EYE.up, screenFront - EYE.forward) * DEG;
    expect(hoodUnder - screenTopEl).toBeGreaterThan(1.3);
    expect(hoodUnder - screenTopEl).toBeLessThan(1.7);
    // Every pilot's screen is what the eye meets: 0.3 degree under its top edge, and near its bottom. The left
    // screen carries the attitude ball in the middle of its upper two-thirds, so its top edge is probed off to
    // the side of the ball, and both screens are probed below it.
    const pilots = screens.filter((v) => v.z < 0).map((v) => v.z).sort((a, b) => a - b);
    const pilotCentres = [pilots[0]! + 0.11, pilots[pilots.length - 1]! - 0.11];
    for (const z of pilotCentres) {
      const side = new Vector3(screenFront, screenTop - 0.002, z + 0.08);
      const under = azel(side);
      expect(firstHit(under.az, under.el - 0.3)?.mesh.name, `screen top at z ${z}`).toBe("bizjet-screens");
      const low = azel(new Vector3(screenFront, screenTop - 0.125, z));
      expect(firstHit(low.az, low.el)?.mesh.name, `screen bottom at z ${z}`).toBe("bizjet-screens");
    }
  });

  it("stand the left windscreen post's axis at azimuth -34 (+-1.5), 0.02 thick, raked like the glass, and the right one is its mirror", () => {
    const vertices = worldVertices(named("bizjet-windscreen-post-port"));
    const { bottom, top } = cylinderEnds(vertices);
    for (const end of [bottom, top]) {
      expect(azel(end).az).toBeGreaterThan(-34 - 1.5);
      expect(azel(end).az).toBeLessThan(-34 + 1.5);
    }
    // 0.02 thick: a window frame and not a column (it was 0.03 and a sixth of the view). Each end's ring is at the
    // strut's own radius from the axis, up to 8% fatter at the foot; the end is estimated from a ring whose seam vertex
    // is duplicated, which puts the estimate off by up to a tenth of a radius, so the bound is 0.024/0.026 and 0.03
    // (the old radius) cannot pass.
    const ringRadius = (end: Vector3) => Math.max(...vertices.filter((v) => Vector3.Distance(v, end) < 0.05).map((v) => Vector3.Distance(v, end)));
    expect(ringRadius(top)).toBeLessThan(0.024);
    expect(ringRadius(top)).toBeGreaterThan(0.017);
    expect(ringRadius(bottom)).toBeLessThan(0.026);
    // top toward the pilot by the BUILT glass's own rake: dx/dy along its front face
    const pane = worldVertices(named("bizjet-windscreen")).filter((v) => v.z > 0);
    const byHeight = [...pane].sort((a, b) => b.y - a.y);
    const topFront = byHeight.slice(0, 4).reduce((a, b) => (b.x > a.x ? b : a));
    const bottomFront = byHeight.slice(-4).reduce((a, b) => (b.x > a.x ? b : a));
    const glassRake = (topFront.x - bottomFront.x) / (topFront.y - bottomFront.y);
    expect(glassRake).toBeLessThan(-0.6);
    const rake = (top.x - bottom.x) / (top.y - bottom.y);
    expect(rake).toBeCloseTo(glassRake, 2);
    // it is a bar at one azimuth on screen, however it leans: every vertex of one end reads the same column, to a few tenths
    const mirrored = worldVertices(named("bizjet-windscreen-post-starboard"));
    expect(mirrored.length).toBe(vertices.length);
    const key = (v: Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${Math.abs(v.z).toFixed(4)}`;
    expect(new Set(mirrored.map(key))).toEqual(new Set(vertices.map(key)));
    expect(Math.min(...mirrored.map((v) => v.z))).toBeGreaterThan(0);
  });

  it("stand the post's foot inside the shell at the sill, and as far forward as it can go", () => {
    const vertices = worldVertices(named("bizjet-windscreen-post-port"));
    const foot = vertices.filter((v) => v.y < 0.52);
    expect(foot.length).toBeGreaterThan(3);
    const clearances = foot.map((v) => castWall(v.x, v.y, -1) - Math.abs(v.z));
    expect(Math.min(...clearances), "the foot pokes through the wall").toBeGreaterThanOrEqual(-0.001);
    // further forward and it would not fit: the tightest vertex is within 2 cm of the wall
    expect(Math.min(...clearances), "the foot could go further forward").toBeLessThanOrEqual(0.02);
  });

  it("run the overhead from the glass's top edge to 0.3 m behind the eye, its front edge reading the opening's top", () => {
    const overhead = worldVertices(named("bizjet-overhead"));
    const glass = worldVertices(named("bizjet-windscreen"));
    const glassTopY = Math.max(...glass.map((v) => v.y));
    const glassTopX = glass.find((v) => v.y > glassTopY - 1e-6)!.x;
    expect(Math.min(...overhead.map((v) => v.y))).toBeCloseTo(glassTopY, 3);
    expect(Math.max(...overhead.map((v) => v.x))).toBeCloseTo(glassTopX, 3);
    expect(Math.min(...overhead.map((v) => v.x))).toBeLessThanOrEqual(EYE.forward - 0.3 + 1e-6);
    // seen from the eye: the lowest elevation at which the overhead is the first surface is the top of the opening
    const opening = Math.min(...elevationsHit("bizjet-overhead", 0));
    expect(opening).toBeGreaterThan(14);
    expect(opening).toBeLessThan(18);
    // It pokes through the crown where the crown falls away sideways (a flat pane on a curved nose): by how much is
    // measured in scripts/bizjet-cockpit-clearance.mts, and held here to the number the code comment states.
    const front = Math.max(...overhead.map((v) => v.x));
    const top = Math.max(...overhead.map((v) => v.y));
    const protrusion = top - castCrown(front, EYE.right);
    expect(protrusion).toBeGreaterThan(0.1);
    expect(protrusion).toBeLessThan(0.14);
  });

  it("stand the side walls just inside the shell, up to the sill", () => {
    const vertices = worldVertices(named("bizjet-side-walls"));
    // the sill is the side windows' lower edge, which the built boxes put between y 0.50 and 0.60
    const windows = ["port-bizjet-flight-deck-window", "starboard-bizjet-flight-deck-window"].flatMap((name) => worldVertices(named(name)));
    const lowest = Math.min(...windows.map((v) => v.y));
    expect(Math.max(...vertices.map((v) => v.y))).toBeGreaterThan(lowest - 0.001);
    expect(Math.max(...vertices.map((v) => v.y))).toBeLessThan(lowest + 0.1);
    const clearances = vertices.map((v) => castWall(v.x, v.y, v.z < 0 ? -1 : 1) - Math.abs(v.z));
    expect(Math.min(...clearances)).toBeGreaterThanOrEqual(-0.002);
    expect(Math.min(...clearances)).toBeLessThanOrEqual(0.03);
  });

  // THE 3D ATTITUDE BALL THAT STOOD HERE IS GONE, and this is where its placement, its colours and
  // its pivot's containment were held: a disc filling the pilot's left screen's upper two-thirds,
  // 2.5 mm in front of the glass, turning inside the screen at every angle. It was built when these
  // screens were flat rectangles. The PFD page draws its own horizon now, so the ball was a SECOND
  // attitude indicator standing on top of the first and hiding most of it -- the 747's went for the
  // same reason and on the same evidence. What replaces this test is the PFD page's own horizon test
  // plus `render.cockpit-display-state.test.ts`, which holds the page's pitch, bank and heading to
  // the HUD's own numbers for the same flight state. The Cessna keeps its ball AND its row in
  // `render.cockpit-instruments.test.ts`, because that aeroplane's instrument is MECHANICAL.

  it("keep the panel and its hood within a few millimetres of the shell", () => {
    const clearances: number[] = [];
    for (const v of [...worldVertices(named("bizjet-instrument-panel")), ...worldVertices(named("bizjet-glareshield"))]) {
      const crown = castCrown(v.x, v.z);
      const wall = castWall(v.x, v.y, v.z < 0 ? -1 : 1);
      clearances.push(Number.isFinite(crown) && v.y > crown ? -(v.y - crown) : wall - Math.abs(v.z));
    }
    expect(Math.min(...clearances)).toBeGreaterThanOrEqual(-0.006);
  });

  it("give the hood a matte near-black material of its own, and the bezels a dark-grey rim with a faint lit edge", () => {
    const hood = named("bizjet-glareshield").material as PBRMaterial;
    const board = named("bizjet-instrument-panel").material as PBRMaterial;
    expect(hood).not.toBe(board);
    for (const channel of [hood.albedoColor.r, hood.albedoColor.g, hood.albedoColor.b]) {
      expect(channel).toBeGreaterThan(0.03);
      expect(channel).toBeLessThan(0.08);
    }
    expect(hood.roughness).toBeGreaterThanOrEqual(0.99);
    expect(hood.clearCoat.isEnabled).toBe(false);
    expect(hood.environmentIntensity).toBe(0);
    expect(hood.metallicF0Factor).toBe(0);
    const luma = (m: PBRMaterial) => m.albedoColor.r + m.albedoColor.g + m.albedoColor.b;
    expect(luma(hood)).toBeLessThan(luma(board));
    // Bezels: still on the shared marking material (the night glow path), but dark grey with a quarter of the old
    // emissive (0.7 -> 0.175).
    const bezel = named("bizjet-screen-bezels").material as PBRMaterial;
    expect(bezel).toBe(scene.getMaterialByName("bizjet-instrument-marking"));
    expect(bezel.emissiveIntensity).toBeGreaterThan(0.15);
    expect(bezel.emissiveIntensity).toBeLessThan(0.2);
    for (const channel of [bezel.albedoColor.r, bezel.albedoColor.g, bezel.albedoColor.b]) expect(channel).toBeLessThan(0.25);
  });

  it("hold the analytic shell to the built fuselage", () => {
    // The sections in bizjetCockpit.ts are copies; this is what makes them checked copies.
    expect(BIZJET_SHELL_SECTIONS.map((s) => s.x)).toEqual([9.5, 11.6, 13.2]);
    for (const x of [11.6, 11.9, 12.2, 12.5, 12.8, 13.1]) {
      for (const y of [-0.15, 0.2, 0.52, 0.65, 0.9]) {
        const model = bizjetShellHalfWidth(x, y);
        const cast = castWall(x, y, -1);
        if (Number.isFinite(model) && Number.isFinite(cast)) expect(Math.abs(model - cast)).toBeLessThan(0.01);
      }
      for (const z of [0, -0.26, -0.52, -0.7]) {
        const model = bizjetShellTop(x, z);
        const cast = castCrown(x, z);
        if (Number.isFinite(model) && Number.isFinite(cast)) expect(Math.abs(model - cast)).toBeLessThan(0.01);
      }
    }
  });

  it("stand both seat pairs 0.05 m aft of the eye, with the headrests behind them, symmetric", () => {
    const seatX = (name: string) => named(name).getBoundingInfo().boundingBox.centerWorld;
    const port = seatX("bizjet-first-officer-seat");
    const starboard = seatX("bizjet-captain-seat");
    expect(port.z).toBeCloseTo(EYE.right, 6);
    expect(EYE.forward - port.x).toBeGreaterThan(0.04);
    expect(EYE.forward - port.x).toBeLessThan(0.06);
    expect(starboard.x).toBeCloseTo(port.x, 6);
    expect(starboard.z).toBeCloseTo(-port.z, 6);
    const portHeadrest = seatX("bizjet-first-officer-headrest");
    const starboardHeadrest = seatX("bizjet-captain-headrest");
    expect(starboardHeadrest.x).toBeCloseTo(portHeadrest.x, 6);
    expect(portHeadrest.x).toBeCloseTo(port.x - 0.28, 2);
  });
});

describe("the Global's cockpit camera", () => {
  it("draws nothing of the radome: its rear cap faces the pilot and would be a black wall across the windscreen", () => {
    expect(frameCells("bizjet-radome").hits).toBe(0);
    // ...and the windscreen opening is open: sky, straight ahead and to the left of the centre post
    const opening = frameCells(null, { az: [-15, 18], el: [-7, 12] });
    expect(opening.total).toBeGreaterThan(100);
    expect(opening.hits / opening.total).toBeGreaterThan(0.95);
  });

  it("splits what is hidden from what is drawn: the glass and the radome are excluded, the fuselage and the centre post are not", () => {
    const glass = ["bizjet-windscreen", "port-bizjet-flight-deck-window", "starboard-bizjet-flight-deck-window"].map(named);
    const radome = named("bizjet-radome");
    expect(new Set(aircraft.cockpitParts)).toEqual(new Set([...glass, radome]));
    for (const part of aircraft.cockpitParts) expect(part.layerMask & camera.layerMask, part.name).toBe(0);
    for (const name of ["bizjet-fuselage", "bizjet-windscreen-center-post"]) {
      const part = named(name);
      expect(part.isVisible, name).toBe(true);
      expect(part.layerMask & camera.layerMask, name).not.toBe(0);
    }
    for (const part of cockpitOnly) {
      expect(part.isVisible, part.name).toBe(true);
      expect(part.layerMask & camera.layerMask, part.name).not.toBe(0);
      expect(part.metadata?.castsShadow, part.name).toBe(false);
      expect(part.metadata?.cockpitOnly, part.name).toBe(true);
    }
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
    expect(parts.length).toBe(8);
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
