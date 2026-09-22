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
    // albedo ~0.06 a channel (0.04-0.08), roughness 1, no clearcoat, F0/F90 zero, no image-based light
    for (const channel of [hood.albedoColor.r, hood.albedoColor.g, hood.albedoColor.b]) {
      expect(channel).toBeGreaterThan(0.03);
      expect(channel).toBeLessThan(0.08);
    }
    expect(hood.roughness).toBeGreaterThanOrEqual(0.99);
    expect(hood.clearCoat.isEnabled).toBe(false);
    expect(hood.environmentIntensity).toBe(0);
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
 * THE WINDSCREEN CENTRE FRAME'S TIP, and why it is a cone.
 *
 * `windscreen-center-frame` (trainerVisual.ts) is the one piece of exterior structure the pilot sees as the
 * framing of his windscreen, and its top end stops in OPEN AIR: the cabin roof panel reaches only x 1.62,
 * 0.38 m aft of the top at x 2, and the glass crown there (y 0.190) is below the top (y 0.210). A cylinder's
 * flat end disc therefore read as a lit octagon against the sky: 48% of the rays over its own angular window
 * on the player rig, 51% on the perf rig. A cockpit-only header to hide it was built and REJECTED (15% of
 * frame to hide 1.4%); the fix is that the last 0.05 m is a cone to a true apex, so there is no disc at all.
 *
 * Both rigs are checked because the PERF rig (56 degrees, eye pinned to the centreline) is what the twelve
 * compared trainer cockpit baselines are shot with.
 */
describe("the Cessna's windscreen centre frame", () => {
  /**
   * The member runs up the windscreen, turns at a ball joint, and runs aft over the glass crown into
   * the roof. Its history is why these tests look the way they do: its top first ended in a flat disc
   * in open air (a lit octagon against the sky), then in a cone tapered to a point (a spike ending in
   * the sky), and now it ends in STRUCTURE. So what is held is: the old foot, axis and radius up to the
   * corner; the corner filled; the aft end inside the roof slab as BUILT; and no end disc of any of its
   * pieces the nearest surface along any ray, from the pilot's seat or from outside.
   */
  const FOOT = new Vector3(2.26, -0.02, 0);
  /** How far the mesh runs on past the design foot, down into the fuselage. */
  const BURY = 0.09;
  const CORNER = new Vector3(2, 0.21, 0);
  const INTO_ROOF = new Vector3(1.6, 0.205, 0);
  const RADIUS = 0.024;
  const strutAxis = CORNER.subtract(FOOT).normalize();
  const strutLength = Vector3.Distance(CORNER, FOOT);
  const crownAxis = INTO_ROOF.subtract(CORNER).normalize();
  const radialFrom = (origin: Vector3, axis: Vector3) => (p: Vector3) => {
    const d = p.subtract(origin);
    return d.subtract(axis.scale(Vector3.Dot(d, axis))).length();
  };
  type Tri = { a: Vector3; b: Vector3; c: Vector3 };
  const key = (t: Tri) => `${t.a.x},${t.a.y},${t.a.z}|${t.b.x},${t.b.y},${t.b.z}|${t.c.x},${t.c.y},${t.c.z}`;

  /** The roof slab as BUILT: its world bounds, not the constants it was built from. */
  function roofSlab() {
    const roof = worldVertices(named("trainer-cabin-roof"));
    return {
      minY: Math.min(...roof.map((v) => v.y)),
      maxY: Math.max(...roof.map((v) => v.y)),
      frontX: Math.max(...roof.map((v) => v.x)),
      triangles: tipWorldTriangles(named("trainer-cabin-roof")),
    };
  }

  /**
   * Every END DISC of the member's pieces: a triangle lying wholly in the plane that ends a bar (at the
   * foot, at the corner on either bar, at the aft end), within the bar's radius of that end's centre,
   * AND facing along the bar's axis. The last condition is not decoration: the ball's pole sits in the
   * crown bar's end plane, and a thin triangle of the pole's fan lies almost in that plane too, so a
   * plane-and-radius test alone read a piece of the ball as a disc (from behind, at the ball's top).
   */
  function endDiscs(frame: AbstractMesh): Tri[] {
    const ends = [
      { centre: FOOT.subtract(strutAxis.scale(BURY)), axis: strutAxis, radius: RADIUS * 1.08 },
      { centre: CORNER, axis: strutAxis, radius: RADIUS },
      { centre: CORNER, axis: crownAxis, radius: RADIUS },
      { centre: INTO_ROOF, axis: crownAxis, radius: RADIUS },
    ];
    return tipWorldTriangles(frame).filter((t) => {
      const normal = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
      if (normal.length() < 1e-12) return false;
      normal.normalize();
      return ends.some((end) =>
        Math.abs(Vector3.Dot(normal, end.axis)) > 0.99 &&
        [t.a, t.b, t.c].every((p) =>
          Math.abs(Vector3.Dot(p.subtract(end.centre), end.axis)) < 2e-3 && Vector3.Distance(p, end.centre) <= end.radius + 1e-3));
    });
  }

  it("runs up the windscreen at its old foot, axis and radius, and turns at a ball 5% over the bars' radius", () => {
    const frame = named("windscreen-center-frame");
    expect(frame.metadata?.mergedFrom).toEqual(["windscreen-center-frame-bar", "windscreen-center-frame-crown", "windscreen-center-frame-joint"]);
    const vertices = worldVertices(frame);
    const strutRadial = radialFrom(FOOT, strutAxis);
    const alongStrut = (p: Vector3) => Vector3.Dot(p.subtract(FOOT), strutAxis);
    // the axis is the old one, through the design foot: every vertex of the bar is within its radius of it
    const bar = vertices.filter((p) => alongStrut(p) > -BURY - 1e-3 && alongStrut(p) < strutLength + 1e-3 && strutRadial(p) < 0.03);
    expect(Math.max(...bar.map(strutRadial)), "the bar's widest point, at its buried bottom").toBeCloseTo(RADIUS * 1.08, 3);
    // the mesh runs on BURY past the design foot, and no further
    expect(Math.min(...bar.map(alongStrut)), "the bottom ring").toBeCloseTo(-BURY, 3);
    // the bar reaches the corner at full radius: the taper is gone
    // (within 2% of the bar's radius: the ball's equator lies in the same plane at 1.05 radii)
    const atCorner = vertices.filter((p) => Math.abs(alongStrut(p) - strutLength) < 1e-3 && strutRadial(p) < RADIUS * 1.02);
    expect(atCorner.length, "the strut's top ring").toBeGreaterThan(0);
    expect(Math.max(...atCorner.map(strutRadial))).toBeCloseTo(RADIUS, 3);
    // the ball: vertices 1.05 radii from the corner, including straight up and forward
    const BALL = RADIUS * 1.05;
    const onBall = vertices.filter((p) => Math.abs(Vector3.Distance(p, CORNER) - BALL) < 1e-3);
    expect(Math.max(...onBall.map((p) => p.y)), "the ball's top").toBeCloseTo(CORNER.y + BALL, 3);
    expect(Math.max(...onBall.map((p) => p.x)), "the ball's front").toBeCloseTo(CORNER.x + BALL, 3);
    expect((frame.material as PBRMaterial).name).toBe("trainer-dark");
    // it is EXTERIOR, not cockpit-only: that is the whole point of fixing it here rather than hiding it
    expect(cockpitOnly.map((part) => part.name)).not.toContain("windscreen-center-frame");
  });

  it("is a knuckle at the corner, not a notch: both bars' end rings lie INSIDE the ball's faceted surface", () => {
    // Read off the built merged mesh, pieces by their `mergedFrom` order: the bar, the crown bar, then
    // the ball. At the bars' own radius the ball's facets dipped inside the bars' octagonal end rings
    // and 60 of those 80 vertices poked out -- a notch at the elbow in a 4x crop, though no end disc was
    // exposed and every other test passed. Containment in the ball's CONVEX faceted surface is the test.
    const frame = named("windscreen-center-frame");
    const all = worldVertices(frame);
    const ballVertices = all.filter((p) => Math.abs(Vector3.Distance(p, CORNER) - RADIUS * 1.05) < 1e-3);
    expect(ballVertices.length, "the ball's vertices").toBeGreaterThan(40);
    const ballTriangles = tipWorldTriangles(frame).filter((t) =>
      [t.a, t.b, t.c].every((p) => Math.abs(Vector3.Distance(p, CORNER) - RADIUS * 1.05) < 1e-3));
    expect(ballTriangles.length, "the ball's triangles").toBeGreaterThan(100);
    // the bars' vertices within a bar radius of the corner: their end rings
    const rings = all.filter((p) => Vector3.Distance(p, CORNER) <= RADIUS * 1.001 && Vector3.Distance(p, CORNER) > RADIUS * 0.5);
    expect(rings.length, "the bars' corner rings").toBeGreaterThanOrEqual(16);
    let worst = Number.NEGATIVE_INFINITY;
    for (const p of rings) {
      for (const t of ballTriangles) {
        const n = Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a));
        if (n.length() < 1e-14) continue;
        n.normalize();
        if (Vector3.Dot(n, t.a.subtract(CORNER)) < 0) n.scaleInPlace(-1);
        worst = Math.max(worst, Vector3.Dot(n, p.subtract(t.a)));
      }
    }
    // inside every face plane, by at least half a millimetre
    expect(worst, "the furthest a corner-ring vertex stands outside a ball facet, metres").toBeLessThan(-0.0005);
  });

  it("starts under the cowl deck: every point of its bottom ring is below the surface above it", () => {
    // The design foot stood 8 to 49 mm ABOVE the deck, so the ring floated and its end disc showed to
    // anyone ahead of the aeroplane. Cast down from high above each point of the bottom ring: the first
    // surface met must be the fuselage, and ABOVE the point, by at least 5 mm.
    const frame = named("windscreen-center-frame");
    const strutRadial = radialFrom(FOOT, strutAxis);
    const alongStrut = (p: Vector3) => Vector3.Dot(p.subtract(FOOT), strutAxis);
    const ring = worldVertices(frame).filter((p) => Math.abs(alongStrut(p) + BURY) < 1e-3 && strutRadial(p) < 0.03);
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
        // the fuselage's BOTTOM as the first surface (it did: -0.54 m). A tenth of a millimetre is no
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

  it("ends INSIDE the roof slab as built: everything of it aft of the roof's front edge is within the slab", () => {
    // Read off the member AS BUILT, not along its design axis. A first version found the aft ring by the
    // design axis and a 3 cm radial cut; with the aft end raised 2 cm, poking out of the roof's top, the
    // cut excluded exactly the vertices that poked out and the test passed. The requirement is simpler
    // than a ring: whatever part of this member is under the roof must be inside the roof.
    const slab = roofSlab();
    expect(slab.frontX, "the roof has not moved and left the bar in the air").toBeCloseTo(1.62, 3);
    const vertices = worldVertices(named("windscreen-center-frame"));
    const underRoof = vertices.filter((p) => p.x < slab.frontX);
    // NON-VACUITY: the member does reach under the roof (its whole aft end ring, and the bar's last 2 cm)
    expect(underRoof.length, "vertices of the member aft of the roof's front edge").toBeGreaterThanOrEqual(8);
    expect(Math.min(...vertices.map((p) => p.x)), "it runs 2 cm past the front edge").toBeLessThanOrEqual(slab.frontX - 0.015);
    for (const p of underRoof) {
      expect(p.y, "above the slab's underside").toBeGreaterThan(slab.minY);
      expect(p.y, "below the slab's top").toBeLessThan(slab.maxY);
    }
  });

  it("shows no end disc of any of its pieces, from the pilot's seat or from outside, and the survey can see one when nothing hides it", () => {
    const frame = named("windscreen-center-frame");
    const discs = endDiscs(frame);
    // NON-VACUITY: there ARE discs to find -- a cylinder with two nonzero diameters caps both ends,
    // so the bar and the crown piece carry four between them (foot, both sides of the corner, aft end)
    expect(discs.length, "end-disc triangles found").toBeGreaterThanOrEqual(4 * 6);
    const discKeys = new Set(discs.map(key));
    const glass = new Set(["trainer-canopy"]);
    const drawn = scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.getTotalVertices() > 0 && !glass.has(mesh.name));
    const allTriangles = drawn.flatMap((mesh) => tipWorldTriangles(mesh).map((t) => ({ t, mesh: mesh.name })));
    const frameOnly = tipWorldTriangles(frame).map((t) => ({ t, mesh: frame.name }));
    const nearestKey = (list: { t: Tri; mesh: string }[], eye: Vector3, target: Vector3) => {
      const d = target.subtract(eye).normalize();
      let best = Number.POSITIVE_INFINITY;
      let found = "";
      for (const { t } of list) {
        const hit = tipHitTriangle(eye, d, t);
        // the drawn-face rule measured on a build.box: a face is drawn when its cross points along the ray
        const drawnFace = Vector3.Dot(Vector3.Cross(t.b.subtract(t.a), t.c.subtract(t.a)), d) > 0;
        if (Number.isFinite(hit) && hit > NEAR_PLANE && hit < best && drawnFace) {
          best = hit;
          found = key(t);
        }
      }
      return found;
    };
    // the viewpoints: the pilot, and a ring of exterior cameras 4 m out round the junction
    const eyes: [string, Vector3][] = [["pilot", new Vector3(EYE.forward, EYE.up, EYE.right)]];
    for (const [az, el] of [[0, 20], [60, 25], [120, 30], [180, 25], [240, 30], [300, 25], [90, 60], [270, 60], [0, 75]] as const) {
      const a = (az * Math.PI) / 180;
      const e = (el * Math.PI) / 180;
      eyes.push([`outside az ${az} el ${el}`, CORNER.add(new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).scale(4))]);
    }
    // aim at every disc triangle's own centroid, and a little either side of it
    const targets = discs.flatMap((t) => {
      const c = t.a.add(t.b).add(t.c).scale(1 / 3);
      return [c, c.add(t.a.subtract(c).scale(0.5)), c.add(t.b.subtract(c).scale(0.5)), c.add(t.c.subtract(c).scale(0.5))];
    });
    let seenWithEverything = 0;
    let seenWithFrameAlone = 0;
    const where: string[] = [];
    for (const [label, eye] of eyes) {
      for (const target of targets) {
        if (discKeys.has(nearestKey(allTriangles, eye, target))) {
          seenWithEverything += 1;
          if (where.length < 4) where.push(`${label} -> (${target.x.toFixed(3)}, ${target.y.toFixed(3)}, ${target.z.toFixed(3)})`);
        }
        if (discKeys.has(nearestKey(frameOnly, eye, target))) seenWithFrameAlone += 1;
      }
    }
    // THE POSITIVE CONTROL: with the ball's and the roof's cover taken away -- the member's own bars
    // alone, so the ball is still there but nothing else -- some disc IS the nearest drawn surface
    // from some viewpoint (the aft end's disc faces the pilot). A survey that could not see a disc
    // would read zero below for the wrong reason.
    expect(seenWithFrameAlone, "discs visible when only the member itself is in the scene").toBeGreaterThan(0);
    expect(seenWithEverything, `discs seen in the real scene: ${where.join("; ")}`).toBe(0);
  });
});
