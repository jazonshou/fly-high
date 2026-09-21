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
} from "../src/render/webgpu/aircraft/cockpit/trainerCockpit";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { TRAINER_FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/trainerShell";

/**
 * The Cessna's cockpit, held to the angles it was built to and to the shell it
 * stands in for.
 *
 * The targets are the D3 list from the PM's design, as angles from the pilot's
 * left-seat eye at the 75 degree lens: glareshield top -8 to -11 degrees,
 * instrument row centred at -15 (+-1.5) with each dial at least 4.5 degrees
 * across and a second row at -21, the left windscreen post between azimuth -37
 * and -28, the cowl reading about -4.7 above the glareshield. Each has a
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
  it("are eight or fewer new meshes beyond the ten dial meshes, and keep the dial names", () => {
    const dialNames = ["airspeed", "attitude", "altimeter", "engine", "vertical-speed"]
      .flatMap((dial) => [`trainer-${dial}-gauge`, `trainer-${dial}-needle`]);
    for (const name of dialNames) expect(cockpitOnly.map((part) => part.name)).toContain(name);
    const others = cockpitOnly.filter((part) => !dialNames.includes(part.name)).map((part) => part.name).sort();
    expect(others).toEqual([
      "trainer-cowl-standin",
      "trainer-door-port",
      "trainer-door-starboard",
      "trainer-instrument-panel",
      "trainer-windscreen-post-port",
      "trainer-windscreen-post-starboard",
    ]);
    expect(others.length).toBeLessThanOrEqual(8);
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
      expect(hit?.pickedMesh?.name, `${dial} is hidden behind something`).toMatch(new RegExp(`trainer-${dial}-(gauge|needle)`));
    }
  });

  it("read the glareshield's top edge between -8 and -11 degrees straight ahead", () => {
    const panel = named("trainer-instrument-panel");
    const ahead = worldVertices(panel).filter((v) => v.x - EYE.forward > NEAR_PLANE);
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
    expect(el).toBeGreaterThan(-11);
    expect(el).toBeLessThan(-8);
    // ...and it is what the eye actually meets there: the panel, not the cowl behind it.
    const seen = topLine("trainer-instrument-panel", 0);
    expect(seen).not.toBeNull();
    expect(seen!).toBeGreaterThan(-11);
    expect(seen!).toBeLessThan(-8);
  });

  it("let the cowl rise above the glareshield to about -4.7 degrees", () => {
    const cowl = topLine("trainer-cowl-standin", 0);
    expect(cowl).not.toBeNull();
    expect(cowl!).toBeGreaterThan(-5.2);
    expect(cowl!).toBeLessThan(-4.2);
    const panel = topLine("trainer-instrument-panel", 0)!;
    expect(cowl!).toBeGreaterThan(panel);
  });

  it("stand the left windscreen post between azimuth -37 and -28, and the right one nowhere near the view", () => {
    const azimuths = worldVertices(named("trainer-windscreen-post-port"))
      .filter((v) => v.x - EYE.forward > NEAR_PLANE).map((v) => azel(v).az);
    expect(Math.min(...azimuths)).toBeGreaterThan(-37);
    expect(Math.max(...azimuths)).toBeLessThan(-28);
    expect(TRAINER_LEFT_POST_AZIMUTH_DEGREES).toBeGreaterThan(-37);
    expect(TRAINER_LEFT_POST_AZIMUTH_DEGREES).toBeLessThan(-28);
    const starboard = worldVertices(named("trainer-windscreen-post-starboard")).map((v) => azel(v).az);
    expect(Math.min(...starboard)).toBeGreaterThan(37.5);
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
