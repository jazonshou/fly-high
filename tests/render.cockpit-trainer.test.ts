import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  TRAINER_A_PILLAR,
  TRAINER_DIAL_DIAMETER,
  TRAINER_DOOR_FRAME,
  TRAINER_GLARESHIELD,
  trainerDeckSection,
  trainerDialPlacements,
  trainerRailCentre,
} from "../src/render/webgpu/aircraft/cockpit/trainerCockpit";
import { projectPoint, rasteriseClipped, type Pinhole } from "./support/drawnFaceRaster";
import { SkinCaster } from "../src/render/webgpu/aircraft/airlinerGlazing";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { TRAINER_FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/trainerShell";
import { worldTriangles as tipWorldTriangles, hitTriangle as tipHitTriangle } from "../scripts/rayCrossings.mts";
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";

/**
 * The Cessna's cockpit, held to the angles it was built to and to the shell it
 * stands in for.
 *
 * The targets are the D3 list from the PM's design, as angles from the pilot's
 * left-seat eye at the 75 degree lens: glareshield top -8.2 to -11 degrees (it
 * was built at -8.0 and the PM asked for it 5 mm lower, which reads -8.35),
 * instrument row centred at -15 (+-1.5) with each dial at least 4.5 degrees
 * across (the ONLY row: Jason asked for three dials, 2026-09-23, and the second
 * row at -21 went), the left A-pillar at the frame's left edge (in the vertical
 * plane at azimuth -41, the Cessna pass's S3), the cowl reading about -4.7 above
 * the glareshield. Each has a
 * control: `scripts`' mutation runs move the number and watch the test fail.
 *
 * Every measurement is a ray or a vertex of the BUILT meshes, not a re-derivation
 * of the constants in `trainerCockpit.ts`, so a transcription error in the
 * builder fails here instead of agreeing with itself.
 */

const DEG = 180 / Math.PI;
const EYE = aircraftSpec("trainer").cockpitEye;
const EYE_POINT = new Vector3(EYE.forward, EYE.up, EYE.right);
const NEAR_PLANE = 0.08;

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
function azel(point: Vector3): { az: number; el: number } {
  const d = point.subtract(EYE_POINT);
  return { az: Math.atan2(d.z, d.x) * DEG, el: Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEG };
}
/** What the cockpit camera would draw: enabled, visible, on a layer it renders, opaque. */
function drawnByCockpitCamera(mesh: AbstractMesh): boolean {
  const material = mesh.material as PBRMaterial | null;
  return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
    && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
}
/** First opaque surface along a ray from the eye, honouring the cockpit camera's layer mask. */
function firstHit(azimuth: number, elevation: number): { mesh: AbstractMesh; point: Vector3 } | null {
  const az = azimuth / DEG;
  const el = elevation / DEG;
  const direction = new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  const hit = scene.pickWithRay(new Ray(EYE_POINT, direction, 60), drawnByCockpitCamera);
  return hit?.hit && hit.pickedMesh && hit.pickedPoint ? { mesh: hit.pickedMesh, point: hit.pickedPoint } : null;
}
/** Highest elevation, scanning down from +30 in 0.05 degree steps, at which `name` is the first surface. */
function topLine(name: string, azimuth: number): number | null {
  for (let el = 30; el >= -45; el -= 0.05) {
    if (firstHit(azimuth, el)?.mesh.name === name) return el;
  }
  return null;
}
/** Half-width of `meshes` at (x, y): the widest first-hit distance sideways from the centreline. */
function halfWidth(x: number, y: number, side: 1 | -1, meshes: AbstractMesh[]): number {
  let widest = Number.NaN;
  for (const mesh of meshes) {
    const hit = scene.pickWithRay(new Ray(new Vector3(x, y, 0), new Vector3(0, 0, side), 3), (m) => m === mesh);
    if (hit?.hit && !(hit.distance <= widest)) widest = hit.distance;
  }
  return widest;
}
function topSkin(x: number, z: number, mesh: AbstractMesh): number {
  const hit = scene.pickWithRay(new Ray(new Vector3(x, 1, z), new Vector3(0, -1, 0), 3), (m) => m === mesh);
  return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : Number.NaN;
}

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  aircraft = createWebGpuAircraft(scene, "trainer");
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);
  cockpitOnly = aircraft.cockpitOnlyParts ?? [];
});
afterAll(() => {
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the trainer's cockpit parts", () => {
  it("have exactly three dials, airspeed, attitude and altimeter, and nothing else on the panel", () => {
    // Jason: "the trainer should only have 3 dials" (2026-09-23). Read off the BUILT meshes and off the
    // placements the HUD survey projects, so a fourth dial left in either place fails here by name.
    const parts = cockpitOnly.map((part) => part.name);
    expect(parts.filter((name) => /-gauge$/.test(name)).sort()).toEqual(["trainer-airspeed-gauge", "trainer-altimeter-gauge", "trainer-attitude-gauge"]);
    expect(parts.filter((name) => /-needle$/.test(name)).sort()).toEqual(["trainer-airspeed-needle", "trainer-altimeter-needle"]);
    expect(trainerDialPlacements().map((dial) => dial.name)).toEqual(["airspeed", "attitude", "altimeter"]);
    expect(parts).toHaveLength(15);
  });

  it("are eight or fewer new meshes beyond the eight dial meshes, and keep the dial names", () => {
    // three gauge faces, two needles (the attitude dial has a BALL instead: sky, ground, pitch bar)
    const dialNames = [
      ...["airspeed", "attitude", "altimeter"].map((dial) => `trainer-${dial}-gauge`),
      ...["airspeed", "altimeter"].map((dial) => `trainer-${dial}-needle`),
      "trainer-attitude-sky", "trainer-attitude-ground", "trainer-attitude-pitch-bar",
    ];
    for (const name of dialNames) expect(cockpitOnly.map((part) => part.name)).toContain(name);
    const others = cockpitOnly.filter((part) => !dialNames.includes(part.name)).map((part) => part.name).sort();
    expect(others).toEqual([
      "trainer-a-pillar-port",
      "trainer-a-pillar-starboard",
      "trainer-cowl-standin",
      "trainer-door-port",
      "trainer-door-starboard",
      "trainer-glareshield",
      "trainer-instrument-panel",
    ]);
    expect(others.length).toBeLessThanOrEqual(8);
  });

  it("give the hood a matte near-black material of its own that reflects nothing, darker than the interior", () => {
    const hood = named("trainer-glareshield").material as PBRMaterial;
    const board = named("trainer-instrument-panel").material as PBRMaterial;
    expect(hood).not.toBe(board);
    // albedo ~0.06 a channel (0.04-0.08), roughness 1, no clearcoat, F0/F90 zero, the sky's diffuse image light
    for (const channel of [hood.albedoColor.r, hood.albedoColor.g, hood.albedoColor.b]) {
      expect(channel).toBeGreaterThan(0.03);
      expect(channel).toBeLessThan(0.08);
    }
    expect(hood.roughness).toBeGreaterThanOrEqual(0.99);
    expect(hood.clearCoat.isEnabled).toBe(false);
    expect(hood.environmentIntensity, "lit by the sky's image light; F0 zero keeps it from reflecting the sky").toBe(GLARESHIELD_IMAGE_LIGHT);
    expect(hood.metallicF0Factor).toBe(0);
    // ...and darker than the panel board it stands on
    const luma = (m: PBRMaterial) => m.albedoColor.r + m.albedoColor.g + m.albedoColor.b;
    expect(luma(hood)).toBeLessThan(luma(board));
  });

  it("put the instrument row at -15 degrees, each dial at least 4.5 degrees across", () => {
    const row = (dials: string[]) => dials.map((dial) => {
      const centre = named(`trainer-${dial}-gauge`).getBoundingInfo().boundingBox.centerWorld;
      const distance = Vector3.Distance(centre, EYE_POINT);
      return { dial, el: azel(centre).el, across: 2 * Math.atan(TRAINER_DIAL_DIAMETER / 2 / distance) * DEG };
    });
    for (const { dial, el, across } of row(["airspeed", "attitude", "altimeter"])) {
      expect(el, `${dial} elevation`).toBeGreaterThan(-16.5);
      expect(el, `${dial} elevation`).toBeLessThan(-13.5);
      expect(across, `${dial} angular size`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("have every dial in front of the LEFT seat, in the real order, facing the pilot", () => {
    const z = (dial: string) => named(`trainer-${dial}-gauge`).getBoundingInfo().boundingBox.centerWorld.z;
    // Airspeed left of the attitude indicator, altimeter to its right; the old layout mirrored it.
    expect(z("airspeed")).toBeLessThan(z("attitude"));
    expect(z("attitude")).toBeLessThan(z("altimeter"));
    // 4 cm inboard of the eye's line since the deck and the board went wall to wall (Jason and the PM, 2026-09-29): the
    // cabin's inner line at the panel station, at the dials' height, is 0.3957 out, so on the eye's line the airspeed
    // dial's rim (|z| 0.40) stood 4.3 mm outside it; at -0.32 it is 3.6 cm inside. The attitude indicator is 3.3 degrees
    // right of dead ahead.
    expect(z("attitude")).toBeCloseTo(EYE.right + 0.04, 3);
    for (const dial of ["airspeed", "attitude", "altimeter"]) {
      const centre = named(`trainer-${dial}-gauge`).getBoundingInfo().boundingBox.centerWorld;
      // Every dial is where the pilot can see it: the first thing a ray toward it meets is the dial, or its needle.
      const d = centre.subtract(EYE_POINT);
      const hit = scene.pickWithRay(new Ray(EYE_POINT, d.normalize(), 5), drawnByCockpitCamera);
      expect(hit?.pickedMesh?.name, `${dial} is hidden behind something`).toMatch(new RegExp(`trainer-${dial}-(gauge|needle|sky|ground|pitch-bar)`));
    }
  });

  it("read the glareshield's top edge between -8.2 and -11 degrees straight ahead", () => {
    const hood = named("trainer-glareshield");
    const ahead = worldVertices(hood).filter((v) => v.x - EYE.forward > NEAR_PLANE);
    const top = Math.max(...ahead.map((v) => v.y));
    // A box has only corners, so the top edge is the line between its two
    // topmost corners, read where it crosses the eye's own z.
    const corners = ahead.filter((v) => v.y > top - 0.005).sort((a, b) => a.z - b.z);
    const left = corners[0]!;
    const right = corners[corners.length - 1]!;
    const t = (EYE.right - left.z) / (right.z - left.z);
    const el = azel(left.add(right.subtract(left).scale(t))).el;
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
    // The upper bound is -8.2 and not the accepted -8: the first build read
    // -8.0 straight ahead and the PM asked for it 5 mm lower, which reads -8.35.
    expect(el).toBeGreaterThan(-11);
    expect(el).toBeLessThan(-8.2);
    // ...and it is what the eye actually meets there: the panel, not the cowl behind it.
    const seen = topLine("trainer-glareshield", 0);
    expect(seen).not.toBeNull();
    expect(seen!).toBeGreaterThan(-11);
    expect(seen!).toBeLessThan(-8.2);
  });

  it("let the cowl rise above the glareshield to about -4.7 degrees", () => {
    const cowl = topLine("trainer-cowl-standin", 0);
    expect(cowl).not.toBeNull();
    expect(cowl!).toBeGreaterThan(-5.2);
    expect(cowl!).toBeLessThan(-4.2);
    const hood = topLine("trainer-glareshield", 0)!;
    expect(cowl!).toBeGreaterThan(hood);
  });

  it("stand the left A-pillar in the vertical plane at azimuth -41, 20 mm round at its foot and 14 at its top, and keep the right one out of the view", () => {
    // The BUILT tube's rings (`sweptTube` lays `segments` wall vertices a ring, foot to top, before its two caps): each
    // ring's centre and radius, read off its vertices.
    const segments = TRAINER_A_PILLAR.segments;
    const rings = (name: string) => {
      const v = worldVertices(named(name));
      const count = (v.length - 2 * (segments + 1)) / segments;
      expect(Number.isInteger(count), `${name} is a tube of ${segments}-point rings and two caps`).toBe(true);
      return Array.from({ length: count }, (_, i) => {
        const ring = v.slice(i * segments, (i + 1) * segments);
        const centre = ring.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / segments);
        return { centre, radius: ring.reduce((sum, p) => sum + Vector3.Distance(p, centre), 0) / segments };
      });
    };
    const port = rings("trainer-a-pillar-port");
    // the pillar (up the glass in its plane), then the bend, the cant rail and the turn into the roof
    const pillar = port.slice(0, TRAINER_A_PILLAR.glassStations + 1);
    expect(pillar.length).toBeGreaterThanOrEqual(12);
    for (const { centre } of pillar) expect(azel(centre).az, "a ring off the plane at -41").toBeCloseTo(TRAINER_A_PILLAR.azimuthDegrees, 1);
    // the cant rail and the turn into the roof are wholly beyond the frame's edge, at every aspect (horizontal-fixed)
    const beyond = port.slice(TRAINER_A_PILLAR.glassStations + 1 + TRAINER_A_PILLAR.bendStations);
    expect(beyond.length).toBeGreaterThanOrEqual(10);
    for (const { centre, radius } of beyond) expect(azel(centre).az + (Math.asin(Math.min(1, radius / Vector3.Distance(centre, EYE_POINT))) * DEG), "the cant rail in the view").toBeLessThan(-37.5);
    // the radius: 20 mm at the foot to 14 at the top, never growing
    const radii = port.map((ring) => ring.radius);
    expect(radii[0]!).toBeCloseTo(0.02, 4);
    expect(radii[radii.length - 1]!).toBeCloseTo(0.014, 4);
    for (let i = 1; i < radii.length; i += 1) expect(radii[i]!).toBeLessThanOrEqual(radii[i - 1]! + 1e-9);
    // NO FOLD anywhere along the tube: every two faces that share an edge meet at under 30 degrees (its 16 chords meet
    // at 22.5). Its vertices are shared, so a fold is shaded smooth and a split-shading test cannot see it; a centreline
    // station out of line by 2 cm folded it at 46 to 173 degrees.
    {
      const tube = named("trainer-a-pillar-port");
      const v = worldVertices(tube);
      const indices = tube.getIndices()!;
      const faces = new Map<string, Vector3[]>();
      for (let t = 0; t < indices.length; t += 3) {
        const [i, j, k] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        const n = Vector3.Cross(v[j]!.subtract(v[i]!), v[k]!.subtract(v[i]!));
        if (n.length() < 1e-14) continue;
        for (const [a, b] of [[i, j], [j, k], [k, i]] as const) {
          const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
          faces.set(edge, [...(faces.get(edge) ?? []), n.normalize()]);
        }
      }
      let widest = 0;
      for (const pair of faces.values()) if (pair.length === 2) widest = Math.max(widest, Math.acos(Math.min(1, Vector3.Dot(pair[0]!, pair[1]!))) * DEG);
      expect(widest, "a fold in the pillar").toBeLessThan(30);
    }
    // the starboard one is the mirror image, out of the view (the frame's edge is +37.5 at every aspect: the lens is
    // horizontal-fixed)
    expect(Math.min(...worldVertices(named("trainer-a-pillar-starboard")).map((v) => azel(v).az))).toBeGreaterThan(37.5);
  });

  it("draw each needle 3 mm wide with a round 6 mm hub at the dial's centre, all in the needle's own mesh", () => {
    for (const { name, centre, normal } of trainerDialPlacements()) {
      // the attitude dial has a ball, not a needle (`tests/render.cockpit-instruments.test.ts`)
      if (name === "attitude") continue;
      const needle = named(`trainer-${name}-needle`);
      expect(needle.metadata?.mergedFrom, `${name} needle is a merge of a bar and a hub`).toHaveLength(2);
      // In-plane coordinates: the panel-face plane, centred on the dial.
      const across = new Vector3(0, 0, 1);
      const up = Vector3.Cross(normal, across).normalize();
      const plane = worldVertices(needle).map((v) => {
        const d = v.subtract(centre);
        return { s: Vector3.Dot(d, up), t: Vector3.Dot(d, across) };
      });
      const farthest = plane.reduce((a, b) => (Math.hypot(b.s, b.t) > Math.hypot(a.s, a.t) ? b : a));
      // The bar's axis: the mean of the vertices out at the same end as its farthest
      // corner (a corner alone is off the axis by half the bar's width).
      const tipEnd = plane.filter((p) => Math.hypot(p.s, p.t) > 0.0075 && p.s * farthest.s + p.t * farthest.t > 0);
      const mean = { s: tipEnd.reduce((a, p) => a + p.s, 0) / tipEnd.length, t: tipEnd.reduce((a, p) => a + p.t, 0) / tipEnd.length };
      const length = Math.hypot(mean.s, mean.t);
      const dir = { s: mean.s / length, t: mean.t / length };
      const along = (p: { s: number; t: number }) => p.s * dir.s + p.t * dir.t;
      const lateral = (p: { s: number; t: number }) => Math.abs(-p.s * dir.t + p.t * dir.s);
      // Beyond the hub (past 7.5 mm from the pivot) only the bar exists: 3 mm wide.
      const barOnly = plane.filter((p) => Math.abs(along(p)) > 0.0075);
      expect(barOnly.length, `${name} bar vertices`).toBeGreaterThanOrEqual(4);
      expect(Math.max(...barOnly.map(lateral)), `${name} bar half-width`).toBeLessThanOrEqual(0.0015 + 1e-4);
      // The hub: vertices wider than the bar, all at 6 mm from the pivot, spread all round it.
      const hub = plane.filter((p) => lateral(p) > 0.002);
      expect(hub.length, `${name} hub vertices`).toBeGreaterThanOrEqual(12);
      for (const p of hub) expect(Math.hypot(p.s, p.t), `${name} hub radius`).toBeCloseTo(0.006, 3);
      const spread = Math.max(...hub.map((p) => Math.atan2(p.t, p.s))) - Math.min(...hub.map((p) => Math.atan2(p.t, p.s)));
      expect(spread, `${name} hub is round`).toBeGreaterThan(Math.PI);
      // a POINTER 28 mm long on one side of the pivot and a tail no longer than the hub's radius on the other, so the
      // tip is unambiguous through a 300 degree sweep (the bar it replaced was 16 mm each side and symmetric)
      expect(Math.max(...plane.map(along))).toBeGreaterThan(0.0275);
      expect(Math.max(...plane.map(along))).toBeLessThan(0.0285);
      expect(Math.min(...plane.map(along))).toBeGreaterThan(-0.0065);
    }
  });

  it("stand the cowl on the shell it replaces: the same rings, so the same surface", () => {
    const tube = named("trainer-fuselage");
    const standIn = named("trainer-cowl-standin");
    const forward = TRAINER_FUSELAGE_SECTIONS.filter((section) => section.x >= 2.42);
    expect(forward.map((section) => section.x)).toEqual([2.42, 3.7]);
    const shell = worldVertices(tube).filter((v) => v.x >= 2.42 - 1e-6);
    const ring = worldVertices(standIn).filter(
      // The stand-in's rear cap has a centre vertex on the axis that the
      // fuselage, which is continuous through 2.42, does not have. Every other
      // vertex is a point on a ring.
      (v) => !(v.x < 2.42 + 1e-6 && Math.abs(v.z) < 1e-6 && Math.abs(v.y - -0.34) < 1e-6),
    );
    expect(ring.length).toBeGreaterThan(40);
    for (const vertex of ring) {
      const nearest = Math.min(...shell.map((s) => Vector3.Distance(s, vertex)));
      expect(nearest).toBeLessThan(1e-4);
    }
  });

  it("sit the door panels just inside where the tube's wall was", () => {
    // Every vertex below the tube's top skin inside the tube; and the OUTER face (the outermost vertex at each station
    // and height) no more than 3 cm off it. The panel is 2 cm thick at the floor and more at the notch, so its inner
    // face stands further off by design.
    const tube = named("trainer-fuselage");
    for (const door of ["trainer-door-port", "trainer-door-starboard"]) {
      const outer = new Map<string, number>();
      for (const v of worldVertices(named(door))) {
        if (!(v.y <= topSkin(v.x, v.z, tube) + 1e-4)) continue; // above the skin the tube is not there
        const clearance = halfWidth(v.x, v.y, v.z < 0 ? -1 : 1, [tube]) - Math.abs(v.z);
        const key = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)}`;
        outer.set(key, Math.min(outer.get(key) ?? Number.POSITIVE_INFINITY, clearance));
      }
      const clearances = [...outer.values()].filter(Number.isFinite);
      expect(clearances.length).toBeGreaterThan(10);
      expect(Math.min(...clearances), `${door} pokes through the wall`).toBeGreaterThanOrEqual(-0.002);
      expect(Math.max(...clearances), `${door} stands off the wall`).toBeLessThanOrEqual(0.03);
    }
  });

  it("keep the A-pillars 2 cm inside the glass, and end both of them in structure: the top inside the closed roof slab, the foot in the rail", () => {
    const glass = named("trainer-canopy");
    const tube = named("trainer-fuselage");
    const roof = worldVertices(named("trainer-cabin-roof"));
    const roofTriangles = tipWorldTriangles(named("trainer-cabin-roof"));
    const roofCentre = roof.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / roof.length);
    // inside the slab (convex, and wound so a face's cross product points in): on the inner side of every face
    const inRoof = (p: Vector3) => roofTriangles.every((t) => Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), p.subtract(t.a)) > -1e-9);
    expect(inRoof(roofCentre)).toBe(true);
    const r = TRAINER_DOOR_FRAME.railRadius;
    const inRail = (p: Vector3) => {
      const rail = trainerRailCentre(p.x);
      return Math.hypot(Math.abs(p.z) - rail.u, p.y - rail.y) < r;
    };
    const FACET_SAG = 0.006;
    const short: string[] = [];
    for (const name of ["trainer-a-pillar-port", "trainer-a-pillar-starboard"]) {
      const v = worldVertices(named(name));
      const segments = TRAINER_A_PILLAR.segments;
      const walls = v.slice(0, v.length - 2 * (segments + 1));
      const [footCap, topCap] = [v.slice(walls.length, walls.length + segments + 1), v.slice(walls.length + segments + 1)];
      // the top: its cap, and its last ring, wholly inside the roof slab: no end of it in the air
      for (const p of [...topCap, ...walls.slice(walls.length - segments)]) expect(inRoof(p), `${name}'s top at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) is out of the roof`).toBe(true);
      // the foot: its centre in the rail's round, and its cap facing down, away from the eye
      expect(inRail(footCap[0]!), `${name}'s foot is not in the rail`).toBe(true);
      const facing = Vector3.Cross(footCap[2]!.subtract(footCap[0]!), footCap[1]!.subtract(footCap[0]!));
      expect(facing.y, `${name}'s foot cap faces up`).toBeLessThan(0);
      // everything between: in the roof, or the glass's clearance inside the glass over the tube, or inside the tube
      let checked = 0;
      for (const p of walls) {
        if (inRoof(p) || inRail(p)) continue;
        const side = p.z < 0 ? -1 : 1;
        const aboveTube = !(p.y <= topSkin(p.x, p.z, tube));
        const wall = aboveTube ? halfWidth(p.x, p.y, side, [glass]) : halfWidth(p.x, p.y, side, [tube]);
        if (!Number.isFinite(wall)) continue;
        checked += 1;
        const margin = wall - Math.abs(p.z);
        if (margin < (aboveTube ? TRAINER_GLARESHIELD.clearance - FACET_SAG : 0)) {
          short.push(`${name} (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) ${(margin * 1000).toFixed(1)} mm inside the ${aboveTube ? "glass" : "tube"}`);
        }
      }
      expect(checked, `${name}: vertices checked against the glass`).toBeGreaterThan(100);
    }
    expect(short).toEqual([]);
  });
});

/**
 * THE WINDSCREEN CENTRE FRAME, which ends in structure at both ends.
 *
 * `windscreen-center-frame` (trainerVisual.ts) is the exterior strut up the middle of the Cessna's
 * windscreen. Its top used to stop in OPEN AIR, 0.38 m short of the cabin roof: first as a flat end disc
 * that read as a lit octagon against the sky, then as a cone to a point, a spike ending in the sky. Its
 * foot floated 8 to 49 mm above the cowl deck. Now it runs from under the deck up to a corner, turns at a
 * ball joint, and runs aft along the glass crown into the roof slab, which is closed (`solidified`).
 *
 * What is held: the old axis, and full radius right up to the corner (read off the strut's OWN side
 * triangles, so the crown bar's ring cannot stand in for it); both bars' corner rings AT the corner and
 * inside the ball; the bottom ring under the deck; everything aft of the roof's front edge inside the
 * slab, and the slab's walls facing out; the member's faces drawn from the pilot's seat; and no end disc
 * the nearest drawn surface from the seat or from any exterior angle, INCLUDING grazing ones in the roof's
 * own plane, where the roof's once inside-out walls let the buried end show through.
 */
describe("the Cessna's windscreen centre frame", () => {
  const FOOT = new Vector3(2.26, -0.02, 0);
  /** How far the mesh runs on past the design foot, down into the fuselage. */
  const BURY = 0.1;
  const CORNER = new Vector3(2, 0.21, 0);
  const INTO_ROOF = new Vector3(1.6, 0.205, 0);
  const RADIUS = 0.024;
  const BALL = RADIUS * 1.03;
  const strutAxis = CORNER.subtract(FOOT).normalize();
  const strutLength = Vector3.Distance(CORNER, FOOT);
  const crownAxis = INTO_ROOF.subtract(CORNER).normalize();
  const crownLength = Vector3.Distance(INTO_ROOF, CORNER);
  const alongStrut = (p: Vector3) => Vector3.Dot(p.subtract(FOOT), strutAxis);
  const alongCrown = (p: Vector3) => Vector3.Dot(p.subtract(CORNER), crownAxis);
  const radialFrom = (origin: Vector3, axis: Vector3) => (p: Vector3) => {
    const d = p.subtract(origin);
    return d.subtract(axis.scale(Vector3.Dot(d, axis))).length();
  };
  const strutRadial = radialFrom(FOOT, strutAxis);
  type Tri = { a: Vector3; b: Vector3; c: Vector3 };
  const key = (t: Tri) => `${t.a.x},${t.a.y},${t.a.z}|${t.b.x},${t.b.y},${t.b.z}|${t.c.x},${t.c.y},${t.c.z}`;
  const pointKey = (p: Vector3) => `${p.x.toFixed(7)},${p.y.toFixed(7)},${p.z.toFixed(7)}`;
  const distinct = (points: Vector3[]) => [...new Map(points.map((p) => [pointKey(p), p])).values()];

  /**
   * One bar's end ring, found by TOPOLOGY rather than by position: the vertices at `atEnd` of the side
   * triangles that span the bar from end to end. A position filter at the corner also catches the OTHER
   * bar's ring (its vertices sit in this bar's end plane, some exactly a radius off its axis), which is
   * how a first version of the full-radius check could never fail.
   */
  function barRing(along: (p: Vector3) => number, length: number, from: number, atEnd: "start" | "end"): Vector3[] {
    const tolerance = 1e-3;
    const at = (p: Vector3, v: number) => Math.abs(along(p) - v) < tolerance;
    const out: Vector3[] = [];
    for (const t of tipWorldTriangles(named("windscreen-center-frame"))) {
      const corners = [t.a, t.b, t.c];
      const touchesStart = corners.some((p) => at(p, from));
      const touchesEnd = corners.some((p) => at(p, length));
      if (!touchesStart || !touchesEnd) continue;
      out.push(...corners.filter((p) => at(p, atEnd === "start" ? from : length)));
    }
    return distinct(out);
  }
  const strutTopRing = () => barRing(alongStrut, strutLength, -BURY, "end");
  const strutBottomRing = () => barRing(alongStrut, strutLength, -BURY, "start");
  const crownCornerRing = () => barRing(alongCrown, crownLength, 0, "start");

  /** The roof slab as BUILT: its world bounds and its triangles, not the constants it was built from. */
  function roofSlab() {
    const roof = worldVertices(named("trainer-cabin-roof"));
    return {
      minY: Math.min(...roof.map((v) => v.y)),
      maxY: Math.max(...roof.map((v) => v.y)),
      frontX: Math.max(...roof.map((v) => v.x)),
      centroid: roof.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / roof.length),
      triangles: tipWorldTriangles(named("trainer-cabin-roof")),
    };
  }

  /**
   * Every END DISC of the member's two bars: a triangle wholly in the plane that ends a bar (the buried
   * foot, the corner on either bar, the aft end), within the bar's radius of that end's centre, and FACING
   * ALONG the bar's axis -- the last because a thin triangle of the ball's pole fan can lie almost in a
   * bar's end plane, and a plane-and-radius test alone once read a piece of the ball as a disc.
   */
  function endDiscs(): Tri[] {
    const ends = [
      { centre: FOOT.subtract(strutAxis.scale(BURY)), axis: strutAxis, radius: RADIUS * 1.08 },
      { centre: CORNER, axis: strutAxis, radius: RADIUS },
      { centre: CORNER, axis: crownAxis, radius: RADIUS },
      { centre: INTO_ROOF, axis: crownAxis, radius: RADIUS },
    ];
    return tipWorldTriangles(named("windscreen-center-frame")).filter((t) => {
      const normal = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
      if (normal.length() < 1e-12) return false;
      normal.normalize();
      return ends.some((end) =>
        Math.abs(Vector3.Dot(normal, end.axis)) > 0.99 &&
        [t.a, t.b, t.c].every((p) =>
          Math.abs(Vector3.Dot(p.subtract(end.centre), end.axis)) < 2e-3 && Vector3.Distance(p, end.centre) <= end.radius + 1e-3));
    });
  }

  /** The nearest DRAWN triangle along eye -> target (the rule measured on a build.box), or "" for none. */
  function nearestDrawn(list: readonly Tri[], eye: Vector3, target: Vector3): string {
    const d = target.subtract(eye).normalize();
    let best = Number.POSITIVE_INFINITY;
    let found = "";
    for (const t of list) {
      const hit = tipHitTriangle(eye, d, t);
      if (!Number.isFinite(hit) || hit <= NEAR_PLANE || hit >= best) continue;
      if (Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), d) <= 0) continue;
      best = hit;
      found = key(t);
    }
    return found;
  }

  it("runs up the windscreen on its old axis at FULL radius right to the corner, 8% fatter at its buried bottom", () => {
    const frame = named("windscreen-center-frame");
    expect(frame.metadata?.mergedFrom).toEqual(["windscreen-center-frame-bar", "windscreen-center-frame-crown", "windscreen-center-frame-joint"]);
    const top = strutTopRing();
    const bottom = strutBottomRing();
    // NON-VACUITY: an octagonal ring at each end of the strut, found through its own side triangles
    expect(top.length, "the strut's own top ring").toBeGreaterThanOrEqual(8);
    expect(bottom.length, "the strut's own bottom ring").toBeGreaterThanOrEqual(8);
    // every vertex of the strut's top ring is a full radius off the old axis: a taper, a thinner top or a
    // cone to a point inside the ball all fail here
    expect(Math.min(...top.map(strutRadial)), "the strut's top ring, least radius").toBeCloseTo(RADIUS, 3);
    expect(Math.max(...top.map(strutRadial)), "the strut's top ring, greatest radius").toBeCloseTo(RADIUS, 3);
    expect(Math.max(...bottom.map(strutRadial)), "the strut's bottom ring").toBeCloseTo(RADIUS * 1.08, 3);
    for (const p of bottom) expect(alongStrut(p), "the bottom ring is BURY past the design foot").toBeCloseTo(-BURY, 3);
    // the ball: vertices 1.03 radii from the corner, including straight up and forward
    const onBall = worldVertices(frame).filter((p) => Math.abs(Vector3.Distance(p, CORNER) - BALL) < 1e-3);
    expect(Math.max(...onBall.map((p) => p.y)), "the ball's top").toBeCloseTo(CORNER.y + BALL, 3);
    expect(Math.max(...onBall.map((p) => p.x)), "the ball's front").toBeCloseTo(CORNER.x + BALL, 3);
    expect((frame.material as PBRMaterial).name).toBe("trainer-dark");
    // it is EXTERIOR, not cockpit-only: that is the whole point of fixing it here rather than hiding it
    expect(cockpitOnly.map((part) => part.name)).not.toContain("windscreen-center-frame");
  });

  it("is a knuckle at the corner, not a notch: BOTH bars' corner rings are at the corner and inside the ball's facets", () => {
    // At the bars' own radius their octagonal end rings lie on the sphere the faceted ball is inscribed
    // in, so 12 of their 14 distinct positions poked out between its vertices -- a notch at the elbow in a
    // 4x crop, with no end disc exposed and every other test green. Containment in the ball's CONVEX
    // faceted surface is the test, for each ring separately: one ring alone once met a shared vertex
    // count while the other had drifted a centimetre off the corner and out of the ball.
    const frame = named("windscreen-center-frame");
    const ballTriangles = tipWorldTriangles(frame).filter((t) =>
      [t.a, t.b, t.c].every((p) => Math.abs(Vector3.Distance(p, CORNER) - BALL) < 1e-3));
    expect(ballTriangles.length, "the ball's triangles").toBeGreaterThan(500);
    const outside = (p: Vector3) => {
      let worst = Number.NEGATIVE_INFINITY;
      for (const t of ballTriangles) {
        const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
        if (n.length() < 1e-14) continue;
        n.normalize();
        if (Vector3.Dot(n, t.a.subtract(CORNER)) < 0) n.scaleInPlace(-1);
        worst = Math.max(worst, Vector3.Dot(n, p.subtract(t.a)));
      }
      return worst;
    };
    for (const [label, ring] of [["the strut's top ring", strutTopRing()], ["the crown bar's corner ring", crownCornerRing()]] as const) {
      expect(ring.length, label).toBeGreaterThanOrEqual(8);
      const centre = ring.reduce((sum, p) => sum.add(p), Vector3.Zero()).scale(1 / ring.length);
      expect(Vector3.Distance(centre, CORNER), `${label} is centred on the corner`).toBeLessThan(0.0005);
      // inside every face plane of the ball, by at least half a millimetre
      expect(Math.max(...ring.map(outside)), `${label}: furthest outside a ball facet, metres`).toBeLessThan(-0.0005);
    }
  });

  it("starts under the cowl deck: every point of its bottom ring is below the surface above it", () => {
    // The design foot stood 8 to 49 mm ABOVE the deck, so the ring floated and its end disc showed to
    // anyone ahead of the aeroplane. Cast down from high above each point of the bottom ring: the first
    // surface met must be the fuselage, and ABOVE the point, by at least 5 mm.
    const ring = strutBottomRing();
    expect(ring.length, "the bottom ring").toBeGreaterThanOrEqual(8);
    const others = scene.meshes.filter((m) => m.getTotalVertices() > 0 && m.isEnabled() && !["trainer-canopy", "windscreen-center-frame"].includes(m.name));
    const triangles = others.flatMap((m) => tipWorldTriangles(m).map((t) => ({ t, name: m.name })));
    let shallowest = Number.POSITIVE_INFINITY;
    for (const p of ring) {
      let best = Number.POSITIVE_INFINITY;
      let name = "";
      for (const { t, name: n } of triangles) {
        // 0.1 mm off the point in z: two of the ring's vertices sit at exactly z = 0, and a ray straight
        // down the fuselage loft's crown seam can slip between the two triangles that share it and read
        // the fuselage's FLOOR as the first surface (it did: -0.54 m). A tenth of a millimetre is no
        // change to what is being measured.
        const hit = tipHitTriangle(new Vector3(p.x, 2, p.z + 1e-4), new Vector3(0, -1, 0), t);
        if (Number.isFinite(hit) && hit < best) {
          best = hit;
          name = n;
        }
      }
      expect(name, "the surface over the bottom ring").toBe("trainer-fuselage");
      shallowest = Math.min(shallowest, (2 - best) - p.y);
    }
    expect(shallowest, "the least depth of the bottom ring under the deck").toBeGreaterThanOrEqual(0.005);
  });

  it("ends INSIDE a CLOSED roof slab: everything of it aft of the roof's front edge is within the slab, and the slab's faces all face out", () => {
    // Read off the member AS BUILT, not along its design axis: a first version found the aft ring by the
    // design axis and a 3 cm radial cut, and with the aft end raised 2 cm through the roof's top the cut
    // excluded exactly the vertices that poked out.
    const slab = roofSlab();
    expect(slab.frontX, "the roof has not moved and left the bar in the air").toBeCloseTo(1.62, 3);
    const vertices = worldVertices(named("windscreen-center-frame"));
    const underRoof = vertices.filter((p) => p.x < slab.frontX);
    expect(underRoof.length, "vertices of the member aft of the roof's front edge").toBeGreaterThanOrEqual(8);
    expect(Math.min(...vertices.map((p) => p.x)), "it runs 2 cm past the front edge").toBeLessThanOrEqual(slab.frontX - 0.015);
    for (const p of underRoof) {
      expect(p.y, "above the slab's underside").toBeGreaterThan(slab.minY);
      expect(p.y, "below the slab's top").toBeLessThan(slab.maxY);
    }
    // THE SLAB IS CLOSED: every one of its triangles, walls included, is wound so it is drawn from
    // OUTSIDE (its cross product points into the solid). `build.planform` winds its walls against its
    // caps, and with the walls culled from outside the roof's edge was see-through at grazing angles --
    // which is how the end buried here showed as a fleck in the roof's edge.
    expect(slab.triangles.length, "the roof's triangles, walls and caps").toBeGreaterThanOrEqual(12 + 16);
    for (const t of slab.triangles) {
      const cross = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
      const centre = t.a.add(t.b).add(t.c).scale(1 / 3);
      expect(Vector3.Dot(cross, slab.centroid.subtract(centre)), "a roof face drawn from outside").toBeGreaterThan(0);
    }
  });

  it("shows the pilot its drawn faces: every ray from the seat that meets it meets a face the GPU draws", () => {
    // The drawn-faces test walks cockpit-only meshes; this member is exterior, so it is held here. The
    // control is the same member with every triangle's winding flipped, which must read as culled.
    const eye = new Vector3(EYE.forward, EYE.up, EYE.right);
    const own = tipWorldTriangles(named("windscreen-center-frame"));
    const flipped = own.map((t) => ({ a: t.a, b: t.c, c: t.b }));
    // the member's own angular window inside the 75-degree frame, sampled at a quarter of a degree
    const windowOf = (list: Tri[]) => {
      const angles = list.flatMap((t) => [t.a, t.b, t.c]).map((p) => {
        const d = p.subtract(eye);
        return { az: (Math.atan2(d.z, d.x) * 180) / Math.PI, el: (Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI };
      });
      return {
        az0: Math.max(-37.5, Math.min(...angles.map((a) => a.az))), az1: Math.min(37.5, Math.max(...angles.map((a) => a.az))),
        el0: Math.max(-23.3, Math.min(...angles.map((a) => a.el))), el1: Math.min(23.3, Math.max(...angles.map((a) => a.el))),
      };
    };
    const tally = (list: Tri[], w: { az0: number; az1: number; el0: number; el1: number }) => {
      let rays = 0;
      let drawn = 0;
      for (let az = w.az0 + 0.13; az < w.az1; az += 0.25) {
        for (let el = w.el0 + 0.13; el < w.el1; el += 0.25) {
          const a = (az * Math.PI) / 180;
          const e = (el * Math.PI) / 180;
          const d = new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
          let best = Number.POSITIVE_INFINITY;
          let nearest: Tri | null = null;
          for (const t of list) {
            const hit = tipHitTriangle(eye, d, t);
            if (Number.isFinite(hit) && hit > NEAR_PLANE && hit < best) {
              best = hit;
              nearest = t;
            }
          }
          if (!nearest) continue;
          rays += 1;
          if (Vector3.Dot(Vector3.Cross(nearest.b.subtract(nearest.a), nearest.c.subtract(nearest.a)), d) > 0) drawn += 1;
        }
      }
      return { rays, drawn };
    };
    const built = tally(own, windowOf(own));
    expect(built.rays, "rays from the seat that meet the member").toBeGreaterThan(1000);
    expect(built.drawn, "of them, on faces the GPU draws").toBe(built.rays);
    expect(tally(flipped, windowOf(own)).drawn, "the control: the same member wound backwards is culled").toBe(0);
  });

  it("shows no end disc from the pilot's seat or from ANY exterior angle, grazing ones included, and the survey can see one when nothing hides it", () => {
    const discs = endDiscs();
    // NON-VACUITY: a cylinder with two nonzero diameters caps both ends, so the two bars carry four
    // capped ends between them (the buried foot, both sides of the corner, the aft end)
    expect(discs.length, "end-disc triangles found").toBeGreaterThanOrEqual(4 * 6);
    const discKeys = new Set(discs.map(key));
    const targets = discs.map((t) => t.a.add(t.b).add(t.c).scale(1 / 3));
    // Occluders in a box round the whole cabin, roof included, for speed: a mesh left out could only
    // HIDE a disc, so leaving it out makes this stricter, never laxer -- and stricter can mean a false
    // alarm, which is why the box takes in the WHOLE roof. A first box stopped at x 1.2, left out the
    // roof's aft wall at x 0.24, and a ray from dead astern in the roof's plane travelled inside the slab
    // to the buried end. From the seat: what the cockpit camera draws. From outside: what an exterior
    // camera draws -- no cockpit-only part, no glass, no blended propeller.
    const near = (t: Tri) => [t.a, t.b, t.c].some((p) => p.x > -0.6 && p.x < 2.7 && p.y > -0.4 && p.y < 0.6 && Math.abs(p.z) < 0.8);
    const blended = (m: AbstractMesh) => (m.material as PBRMaterial | null)?.needAlphaBlendingForMesh(m) ?? false;
    const fromSeat = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m)).flatMap((m) => tipWorldTriangles(m)).filter(near);
    const fromOutside = scene.meshes
      .filter((m) => m.getTotalVertices() > 0 && m.isEnabled() && !blended(m) && m.name !== "trainer-canopy" && m.metadata?.cockpitOnly !== true)
      .flatMap((m) => tipWorldTriangles(m))
      .filter(near);
    const memberOnly = tipWorldTriangles(named("windscreen-center-frame"));
    // the exterior viewpoints: every 30 degrees round, from 10 degrees below the roof's plane to 75 above,
    // with SIX of the ten elevations within 5 degrees of the plane (where the roof's edge is seen edge-on),
    // at 4 m and at the orbit camera's 25 m
    const exterior: [string, Vector3][] = [];
    for (let az = 0; az < 360; az += 30) {
      for (const el of [-10, -5, -2, 0, 2, 5, 12, 20, 45, 75]) {
        for (const distance of [4, 25]) {
          const a = (az * Math.PI) / 180;
          const e = (el * Math.PI) / 180;
          exterior.push([`outside az ${az} el ${el} at ${distance} m`, CORNER.add(new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).scale(distance))]);
        }
      }
    }
    const pilot = new Vector3(EYE.forward, EYE.up, EYE.right);
    const seen: string[] = [];
    let controlSeen = 0;
    for (const target of targets) {
      if (discKeys.has(nearestDrawn(fromSeat, pilot, target)) && seen.length < 6) seen.push(`pilot -> (${target.x.toFixed(3)}, ${target.y.toFixed(3)}, ${target.z.toFixed(3)})`);
      if (discKeys.has(nearestDrawn(memberOnly, pilot, target))) controlSeen += 1;
      for (const [label, eye] of exterior) {
        if (discKeys.has(nearestDrawn(fromOutside, eye, target)) && seen.length < 6) seen.push(`${label} -> (${target.x.toFixed(3)}, ${target.y.toFixed(3)}, ${target.z.toFixed(3)})`);
        if (discKeys.has(nearestDrawn(memberOnly, eye, target))) controlSeen += 1;
      }
    }
    // THE POSITIVE CONTROL: with nothing but the member itself in the scene (the ball is part of it, the
    // roof and the deck are not), discs ARE the nearest drawn surface from some viewpoints -- the aft end's
    // faces the pilot, the foot's faces the front. A survey that could not see a disc reads zero below for
    // the wrong reason.
    expect(controlSeen, "discs seen when only the member is in the scene").toBeGreaterThan(0);
    expect(seen, "discs seen in the real scene").toEqual([]);
  });
});

/**
 * THE DECK AND THE BOARD (the Cessna pass, S1), THE DOOR FRAMES AND THE A-PILLARS (S3). A rounded glareshield and the
 * panel under it, each swept across the cabin from one door frame to the other (`sweptAcross` in trainerCockpit.ts),
 * where they were a box hood and a box board 0.84 wide; each door a rail, the face under it and a panel, where it was
 * three boxes; each pillar a tapered tube from its rail into the roof, where it was a strut stopping in the air.
 *
 * What is held:
 * - the deck's round shades as a curve, with no chord bands;
 * - no hard edge the pilot can see on the deck, the board, the port door or the port pillar, outside the deck's
 *   designed cove;
 * - no end of the deck or the board in the open: each is buried in its door frame (Jason 2026-09-29, "sweep into
 *   the door frame");
 * - no opening in the cabin's side between the door and the board, under the rail;
 * - the port pillar within 90,000 px, at the frame's edge;
 * - every vertex inside the cabin: 2 cm inside the glass above the tube's top, inside the tube below it;
 * - the airspeed dial unobstructed: the door hides none of it.
 * Read off the BUILT meshes, from the left-seat eye at the 75 degree lens (1920 x 1080).
 */
describe("the Cessna's deck, board, door frames and pillars", () => {
  const W = 1920;
  const H = 1080;
  const pin: Pinhole = {
    eye: EYE_POINT,
    target: EYE_POINT.add(new Vector3(1, 0, 0)),
    up: new Vector3(0, 1, 0),
    fovY: 2 * Math.atan(Math.tan(37.5 / DEG) / (16 / 9)),
    width: W,
    height: H,
  };
  const drawn = () => scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
  const frame = () => rasteriseClipped(pin, drawn(), { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });

  /** Every edge two faces share, keyed by its end points, with the faces' geometric normals and their shading at the ends. */
  function edges(mesh: AbstractMesh) {
    const v = worldVertices(mesh);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const world = mesh.getWorldMatrix();
    const shade = (i: number) => Vector3.TransformNormal(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), world).normalize();
    const indices = mesh.getIndices()!;
    const key = (p: Vector3) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
    const found = new Map<string, { a: Vector3; b: Vector3; faces: { normal: Vector3; toward: boolean; at: Map<string, Vector3> }[] }>();
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const [A, B, C] = corners.map((i) => v[i]!) as [Vector3, Vector3, Vector3];
      const into = Vector3.Cross(B.subtract(A), C.subtract(A));
      if (into.length() < 1e-12) continue;
      const face = { normal: into.normalize().scale(-1), toward: Vector3.Dot(into, A.subtract(EYE_POINT)) > 0, at: new Map(corners.map((i) => [key(v[i]!), shade(i)])) };
      for (const [p, q] of [[A, B], [B, C], [C, A]] as const) {
        const k = [key(p), key(q)].sort().join("|");
        const edge = found.get(k) ?? { a: p, b: q, faces: [] };
        edge.faces.push(face);
        found.set(k, edge);
      }
    }
    return { edges: [...found.values()], key };
  }
  /** The edges the pilot sees that are HARD: two faces at more than 46 degrees, shaded apart, one of them drawn toward him. */
  function visibleHardEdges(mesh: AbstractMesh, raster: ReturnType<typeof frame>, meshIndex: number) {
    const { edges: all, key } = edges(mesh);
    return all.filter((e) => {
      if (e.faces.length !== 2) return false;
      const [f, g] = e.faces as [typeof e.faces[0], typeof e.faces[0]];
      if (Vector3.Dot(f.normal, g.normal) > Math.cos(46 / DEG)) return false;
      const split = [e.a, e.b].some((p) => Vector3.Dot(f.at.get(key(p))!, g.at.get(key(p))!) < Math.cos(1 / DEG));
      if (!split || !(f.toward || g.toward)) return false;
      let seen = 0;
      for (let s = 0; s <= 40; s += 1) {
        const q = projectPoint(pin, Vector3.Lerp(e.a, e.b, s / 40));
        const x = Math.floor(q.x);
        const y = Math.floor(q.y);
        if (!(q.depth > 0.02) || x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (raster.mesh[i] === meshIndex && Math.abs(raster.depth[i]! - q.depth) < 0.0015 + 0.004 * q.depth) seen += 1;
      }
      return seen >= 3;
    });
  }
  it("shades the deck's round as a curve: every chord meets the next with one normal (no chord bands)", () => {
    const deck = named("trainer-glareshield");
    const { edges: all, key } = edges(deck);
    const section = trainerDeckSection();
    // between the lead-in stations, a millimetre in from each buried end
    const straightRun = Math.max(...worldVertices(deck).map((v) => Math.abs(v.z))) - 0.0005;
    // the edges between the round's chords across the straight run: each runs along z at one of the round's points
    const onRound = (p: Vector3) => Math.abs(Math.hypot(p.x - section.centre.x, p.y - section.centre.y) - TRAINER_GLARESHIELD.radius) < 1e-4 && Math.abs(p.z) < straightRun;
    const smooth = all.filter((e) => e.faces.length === 2 && onRound(e.a) && onRound(e.b) && Math.abs(e.a.x - e.b.x) < 1e-6 && Math.abs(e.a.y - e.b.y) < 1e-6);
    expect(smooth.length, "no chord edges found on the deck's round").toBeGreaterThanOrEqual(TRAINER_GLARESHIELD.roundSegments);
    const jumps = smooth.map((e) => Math.max(...[e.a, e.b].map((p) => Math.acos(Math.min(1, Vector3.Dot(e.faces[0]!.at.get(key(p))!, e.faces[1]!.at.get(key(p))!))) * DEG)));
    expect(Math.max(...jumps), "a chord band: two chords shaded apart at their shared edge").toBeLessThan(0.5);
    // CONTROL: the same chords flat-shaded (each face its geometric normal) jump by the chord angle
    const flatJumps = smooth.map((e) => Math.acos(Math.min(1, Vector3.Dot(e.faces[0]!.normal, e.faces[1]!.normal))) * DEG);
    expect(Math.max(...flatJumps)).toBeGreaterThan(5);
  });

  it("shows the pilot no hard edge on the deck, the board, the port door or the port pillar, outside the deck's designed cove", () => {
    const raster = frame();
    const meshes = drawn();
    const section = trainerDeckSection();
    // the cove, by design: round to cove along (coveTop), cove to board along (faceTop), right across the cabin
    const onCove = (p: Vector3) => [section.coveTop, section.faceTop].some((c) => Math.abs(p.x - c.x) < 2e-4 && Math.abs(p.y - c.y) < 2e-4);
    for (const name of ["trainer-glareshield", "trainer-instrument-panel", "trainer-door-port", "trainer-a-pillar-port"]) {
      const mesh = named(name);
      expect(meshes.indexOf(mesh), `${name} is drawn`).toBeGreaterThanOrEqual(0);
      const hard = visibleHardEdges(mesh, raster, meshes.indexOf(mesh)).filter((e) => !(onCove(e.a) && onCove(e.b)));
      expect(hard.map((e) => `(${e.a.x.toFixed(3)}, ${e.a.y.toFixed(3)}, ${e.a.z.toFixed(3)})`), `hard edges on ${name}`).toEqual([]);
    }
    // CONTROL: the instrument sees a box's hard edges -- the attitude ball's pitch bar is one
    const bar = named("trainer-attitude-pitch-bar");
    expect(visibleHardEdges(bar, raster, meshes.indexOf(bar)).length).toBeGreaterThan(3);
  });

  it("keeps every vertex of the deck, the board and the door frames inside the cabin: 2 cm inside the glass above the tube, inside the tube below", () => {
    const glass = named("trainer-canopy");
    const tube = named("trainer-fuselage");
    // Against the BUILT lofts, whose facets sit inside the surface their rings describe: the canopy's 18 chords round
    // its ring stand up to 6 mm inside it, so 2 cm from the ruled surface is at least 1.4 cm from the drawn glass.
    const FACET_SAG = 0.006;
    let checked = 0;
    for (const name of ["trainer-glareshield", "trainer-instrument-panel", "trainer-door-port", "trainer-door-starboard"]) {
      for (const v of worldVertices(named(name))) {
        const side = v.z < 0 ? -1 : 1;
        const tubeTop = topSkin(v.x, v.z, tube);
        const aboveTube = !(v.y <= tubeTop);
        const wall = aboveTube ? halfWidth(v.x, v.y, side, [glass]) : halfWidth(v.x, v.y, side, [tube]);
        if (!Number.isFinite(wall)) continue;
        checked += 1;
        const margin = wall - Math.abs(v.z);
        if (aboveTube) expect(margin, `${name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) against the glass`).toBeGreaterThanOrEqual(TRAINER_GLARESHIELD.clearance - FACET_SAG);
        else expect(margin, `${name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) against the tube`).toBeGreaterThanOrEqual(0);
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("keeps the deck's hood out of sight: its top faces away from the eye and no pixel of it is seen; a level hood would be", () => {
    // The hood stops at x 2.11 and falls 12 degrees forward of the round, STEEPER than the deck line's 8.31: the eye is
    // under the plane of its top, so the GPU culls that face wherever it stands, and it is behind the round besides.
    // The deck's triangles are split in two, the hood's top (the walls between the hood's forward top corner and the
    // round's forward tangent) and the rest, rasterised in place of the deck, so the hood cannot tie with itself.
    const deck = named("trainer-glareshield");
    const section = trainerDeckSection();
    const [endTop, roundFront] = [section.outline[2]!, section.outline[3]!];
    const onHoodTop = (p: Vector3) => [endTop, roundFront].some((c) => Math.abs(p.x - c.x) < 1e-6 && Math.abs(p.y - c.y) < 1e-6);
    const v = worldVertices(deck);
    const indices = deck.getIndices()!;
    const hood: number[] = [];
    const rest: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      (corners.every((i) => onHoodTop(v[i]!)) ? hood : rest).push(...corners);
    }
    expect(hood.length, "the hood's top triangles").toBeGreaterThanOrEqual(3 * 2);
    // its top faces AWAY from the eye: a drawn face's cross product points into the solid, so a face the eye sees has
    // it pointing away from the eye; the hood's points toward it
    for (let t = 0; t < hood.length; t += 3) {
      const [A, B, C] = [v[hood[t]!]!, v[hood[t + 1]!]!, v[hood[t + 2]!]!];
      expect(Vector3.Dot(Vector3.Cross(B.subtract(A), C.subtract(A)), A.subtract(EYE_POINT)), "a hood face drawn toward the eye").toBeLessThan(0);
    }
    const part = (name: string, kept: number[], move: (p: Vector3) => Vector3 = (p) => p) => {
      const mesh = new Mesh(name, scene);
      const data = new VertexData();
      data.positions = v.flatMap((p) => { const q = move(p); return [q.x, q.y, q.z]; });
      data.indices = kept;
      data.applyToMesh(mesh);
      return mesh;
    };
    const seen = (move?: (p: Vector3) => Vector3) => {
      const [top, others] = [part("hood-top", hood, move), part("deck-rest", rest)];
      try {
        // the two parts are in the scene too, and would otherwise come in twice through `drawn()`
        const meshes = [...drawn().filter((m) => m !== deck && m !== top && m !== others), others, top];
        const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
        const index = meshes.indexOf(top);
        let n = 0;
        for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === index) n += 1;
        return n;
      } finally {
        top.dispose();
        others.dispose();
      }
    };
    expect(seen(), "hood pixels").toBe(0);
    // CONTROL: the same top made LEVEL and 1 cm over the round faces the eye, stands over the deck line and is seen
    expect(seen((p) => (onHoodTop(p) ? new Vector3(p.x, roundFront.y + 0.01, p.z) : p))).toBeGreaterThan(500);
  });

  it("buries every end of the deck and the board in its door frame: with the doors none of their edges shows, and without them their ends do", () => {
    // an end's faces face outboard and are culled from the seat whatever stands there; what shows of an end in the open
    // is its EDGE, the hard edge round the end face, against whatever is behind it
    const section = trainerDeckSection();
    const onCove = (p: Vector3) => [section.coveTop, section.faceTop].some((c) => Math.abs(p.x - c.x) < 2e-4 && Math.abs(p.y - c.y) < 2e-4);
    const edgesShown = (meshes: AbstractMesh[]) => {
      const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      return ["trainer-glareshield", "trainer-instrument-panel"].map((name) => {
        const mesh = named(name);
        return visibleHardEdges(mesh, raster, meshes.indexOf(mesh)).filter((e) => !(onCove(e.a) && onCove(e.b))).length;
      });
    };
    expect(edgesShown(drawn()), "an end's edge in the open").toEqual([0, 0]);
    // CONTROL: without the door frames both ends' edges are in plain sight
    for (const count of edgesShown(drawn().filter((m) => !m.name.startsWith("trainer-door")))) expect(count).toBeGreaterThan(2);
  });

  it("closes the cabin's side under the rail: every pixel under the port rail, left of the board, is a cockpit surface", () => {
    // S1's frame showed the white cowl and the sky through a gap there, between the door's square fore end and the
    // board's end. Column by column, from the frame's left edge to the deck's end: from the rail's first pixel down to
    // the frame's bottom, something is drawn.
    const open = (meshes: AbstractMesh[]) => {
      const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      const door = meshes.indexOf(named("trainer-door-port"));
      let columns = 0;
      let holes = 0;
      for (let x = 0; x < W; x += 1) {
        let y = 0;
        while (y < H && raster.mesh[y * W + x] !== door) y += 1;
        if (y === H) continue;
        columns += 1;
        for (; y < H; y += 1) if (raster.mesh[y * W + x]! < 0) holes += 1;
      }
      return { columns, holes };
    };
    const now = open(drawn());
    expect(now.columns, "columns with the rail in them").toBeGreaterThan(600);
    expect(now.holes, "pixels open to the world under the rail").toBe(0);
    // CONTROL: the port door frame moved 4 cm outboard opens the side between it and the board
    const door = named("trainer-door-port");
    const moved = new Vector3(0, 0, -0.04);
    door.position.addInPlace(moved);
    door.computeWorldMatrix(true);
    try {
      expect(open(drawn()).holes).toBeGreaterThan(500);
    } finally {
      door.position.subtractInPlace(moved);
      door.computeWorldMatrix(true);
    }
  });

  it("keeps the port A-pillar within 90,000 px, a band at the frame's left edge, and sees it there", () => {
    const raster = frame();
    const pillar = drawn().indexOf(named("trainer-a-pillar-port"));
    let px = 0;
    let widest = 0;
    let rowsWithIt = 0;
    for (let y = 0; y < H; y += 1) {
      let right = -1;
      for (let x = 0; x < W / 2; x += 1) if (raster.mesh[y * W + x] === pillar) { px += 1; right = x; }
      if (right >= 0) rowsWithIt += 1;
      widest = Math.max(widest, right + 1);
    }
    expect(px, "the port pillar's pixels (the old post covered 172,800)").toBeLessThanOrEqual(90000);
    // a frame the pilot sees: up the left edge from the frame's bottom to within a quarter of its top, where it bends
    // out of the view into the cant rail, never more than 150 px into the view
    expect(px).toBeGreaterThan(30000);
    expect(rowsWithIt).toBeGreaterThan(0.75 * H);
    expect(widest).toBeLessThanOrEqual(150);
  });

  it("sets every dial on the board: no rim past the board's end at its own height", () => {
    // the board's end at a dial point's own height, by a ray sideways through the board from 2 cm inside its face
    const board = named("trainer-instrument-panel");
    const caster = new SkinCaster([{
      positions: worldVertices(board).flatMap((p) => [p.x, p.y, p.z]),
      indices: Array.from(board.getIndices()!),
      normals: Array.from(board.getVerticesData(VertexBuffer.NormalKind)!),
    }]);
    let checked = 0;
    for (const dial of ["airspeed", "attitude", "altimeter"]) {
      for (const p of worldVertices(named(`trainer-${dial}-gauge`))) {
        const side = p.z < 0 ? -1 : 1;
        const end = caster.exit(new Vector3(p.x + 0.02, p.y, 0), new Vector3(0, 0, side), 2);
        expect(end, `${dial}: no board behind the point at y ${p.y.toFixed(3)}`).not.toBeNull();
        expect(Math.abs(p.z), `${dial}: a rim past the board's end at y ${p.y.toFixed(3)}`).toBeLessThanOrEqual(end!.distance);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("leaves the airspeed dial unobstructed: the door hides none of it, and the check can see an obstruction", () => {
    const gauge = named("trainer-airspeed-gauge");
    const count = (meshes: AbstractMesh[]) => {
      const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      const index = meshes.indexOf(gauge);
      let n = 0;
      for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === index) n += 1;
      return n;
    };
    const all = drawn();
    const withDoor = count(all);
    const without = count(all.filter((m) => !m.name.startsWith("trainer-door")));
    expect(withDoor).toBeGreaterThan(10000);
    expect(withDoor, "the door stands in front of the airspeed dial").toBe(without);
    // CONTROL: the port door moved so its rail crosses the dial (15 cm forward, 5 cm inboard, 5 cm down) hides part of
    // it. (A face hung from the rail's inner side, not its underside, stood 2 to 9 mm into the dial's sight line and hid
    // 3.2% of it.)
    const door = named("trainer-door-port");
    const moved = new Vector3(0.15, -0.05, 0.05);
    door.position.addInPlace(moved);
    door.computeWorldMatrix(true);
    try {
      expect(count(all)).toBeLessThan(withDoor - 500);
    } finally {
      door.position.subtractInPlace(moved);
      door.computeWorldMatrix(true);
    }
  });
});
