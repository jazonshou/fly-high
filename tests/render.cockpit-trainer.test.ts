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
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import {
  TRAINER_DIAL_DIAMETER,
  TRAINER_LEFT_POST_AZIMUTH_DEGREES,
  TRAINER_POST_RADIUS,
  trainerDialPlacements,
} from "../src/render/webgpu/aircraft/cockpit/trainerCockpit";
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
 * across and a second row at -21, the left windscreen post's axis between
 * azimuth -37 and -31 (at -35), the cowl reading about -4.7 above the
 * glareshield. Each has a
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
  it("are eight or fewer new meshes beyond the twelve dial meshes, and keep the dial names", () => {
    // five gauge faces, four needles (the attitude dial has a BALL instead: sky, ground, pitch bar)
    const dialNames = [
      ...["airspeed", "attitude", "altimeter", "engine", "vertical-speed"].map((dial) => `trainer-${dial}-gauge`),
      ...["airspeed", "altimeter", "engine", "vertical-speed"].map((dial) => `trainer-${dial}-needle`),
      "trainer-attitude-sky", "trainer-attitude-ground", "trainer-attitude-pitch-bar",
    ];
    for (const name of dialNames) expect(cockpitOnly.map((part) => part.name)).toContain(name);
    const others = cockpitOnly.filter((part) => !dialNames.includes(part.name)).map((part) => part.name).sort();
    expect(others).toEqual([
      "trainer-cowl-standin",
      "trainer-door-port",
      "trainer-door-starboard",
      "trainer-glareshield",
      "trainer-instrument-panel",
      "trainer-windscreen-post-port",
      "trainer-windscreen-post-starboard",
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

  it("put the main instrument row at -15 degrees and the second at -21, each dial at least 4.5 degrees across", () => {
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
    for (const { dial, el, across } of row(["vertical-speed", "engine"])) {
      expect(el, `${dial} elevation`).toBeGreaterThan(-22.5);
      expect(el, `${dial} elevation`).toBeLessThan(-19.5);
      expect(across, `${dial} angular size`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("have every dial in front of the LEFT seat, in the real order, facing the pilot", () => {
    const z = (dial: string) => named(`trainer-${dial}-gauge`).getBoundingInfo().boundingBox.centerWorld.z;
    // Airspeed left of the attitude indicator, altimeter to its right; the old layout mirrored it.
    expect(z("airspeed")).toBeLessThan(z("attitude"));
    expect(z("attitude")).toBeLessThan(z("altimeter"));
    expect(z("attitude")).toBeCloseTo(EYE.right, 2);
    for (const dial of ["airspeed", "attitude", "altimeter", "engine", "vertical-speed"]) {
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

  it("hug the left edge of the frame with the left windscreen post's axis at azimuth -35, and keep the right one out of the view", () => {
    const port = worldVertices(named("trainer-windscreen-post-port")).filter((v) => v.x - EYE.forward > NEAR_PLANE);
    // The post's AXIS is the D3 target (-37 to -31): the mean azimuth of its
    // top and its bottom, each an average over the ring of vertices there.
    const highest = Math.max(...port.map((v) => v.y));
    const lowest = Math.min(...port.map((v) => v.y));
    const axisAt = (y: number) => {
      const ring = port.filter((v) => Math.abs(v.y - y) < 1e-6).map((v) => azel(v).az);
      return ring.reduce((sum, az) => sum + az, 0) / ring.length;
    };
    for (const az of [axisAt(highest), axisAt(lowest)]) {
      expect(az).toBeGreaterThan(-37);
      expect(az).toBeLessThan(-31);
      expect(az).toBeCloseTo(TRAINER_LEFT_POST_AZIMUTH_DEGREES, 0);
    }
    // Its thickness spreads it about 2.7 degrees either side, so its outer edge
    // reaches the frame's edge (-37.5 at 16:9) and no further than -38, and its
    // inner edge stays out of the view, beyond -31.
    const azimuths = port.map((v) => azel(v).az);
    expect(Math.min(...azimuths)).toBeGreaterThan(-38);
    expect(Math.max(...azimuths)).toBeLessThan(-31);
    expect(TRAINER_POST_RADIUS).toBeLessThanOrEqual(0.012);
    const starboard = worldVertices(named("trainer-windscreen-post-starboard")).map((v) => azel(v).az);
    expect(Math.min(...starboard)).toBeGreaterThan(37.5);
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
    const tube = named("trainer-fuselage");
    for (const door of ["trainer-door-port", "trainer-door-starboard"]) {
      const clearances: number[] = [];
      for (const v of worldVertices(named(door))) {
        if (!(v.y <= topSkin(v.x, v.z, tube) + 1e-4)) continue; // above the skin the tube is not there
        clearances.push(halfWidth(v.x, v.y, v.z < 0 ? -1 : 1, [tube]) - Math.abs(v.z));
      }
      expect(clearances.length).toBeGreaterThan(10);
      expect(Math.min(...clearances), `${door} pokes through the wall`).toBeGreaterThanOrEqual(-0.002);
      expect(Math.max(...clearances), `${door} stands off the wall`).toBeLessThanOrEqual(0.03);
    }
  });

  it("keep the windscreen posts inside the glass's base", () => {
    const glass = named("trainer-canopy");
    for (const post of ["trainer-windscreen-post-port", "trainer-windscreen-post-starboard"]) {
      const clearances: number[] = [];
      for (const v of worldVertices(named(post))) {
        const crown = topSkin(v.x, v.z, glass);
        if (!Number.isFinite(crown) || v.y > crown + 1e-4) continue; // a post's top ends in free air above the glass
        clearances.push(halfWidth(v.x, v.y, v.z < 0 ? -1 : 1, [glass]) - Math.abs(v.z));
      }
      expect(clearances.length).toBeGreaterThan(5);
      expect(Math.min(...clearances)).toBeGreaterThanOrEqual(-0.002);
    }
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
