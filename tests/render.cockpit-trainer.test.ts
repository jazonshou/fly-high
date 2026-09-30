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
  TRAINER_BEZEL,
  TRAINER_COWL_LIP,
  TRAINER_DIAL_DIAMETER,
  TRAINER_DOOR_FRAME,
  TRAINER_GLARESHIELD,
  TRAINER_OVERHEAD,
  TRAINER_RADIO,
  TRAINER_ENGINE_CLUSTER,
  TRAINER_SWITCHES,
  TRAINER_TACH,
  TRAINER_YOKE,
  trainerCompassCentre,
  trainerYokeHub,
  trainerDeckSection,
  trainerDialFrames,
  trainerDialPlacements,
  trainerRadioFrames,
  trainerRailCentre,
  trainerEngineClusterFrame,
  trainerSwitchFrames,
  trainerTachFrame,
} from "../src/render/webgpu/aircraft/cockpit/trainerCockpit";
import {
  TRAINER_ASI_MARKINGS,
  TRAINER_DIAL_FACE_FRACTION,
  TRAINER_RADIO_WINDOW_ASPECT,
  drawTrainerAltimeter,
  drawTrainerAsi,
  drawTrainerAttitudeRing,
  drawTrainerCom,
  drawTrainerCompassCard,
  drawTrainerEngine,
  drawTrainerNav,
  TRAINER_RADIO_TEXT,
  drawTrainerTach,
  TRAINER_ENGINE_CLUSTER_MM,
  TRAINER_ENGINE_GAUGES,
  TRAINER_TACH_MARKINGS,
  trainerEngineBand,
  type DrawPage,
} from "../src/render/webgpu/aircraft/cockpit/displays/displayPages";
import { TRAINER_DISPLAYS, displayAtlasHeight, displayAtlasWidth, displaySlots } from "../src/render/webgpu/aircraft/cockpit/displays/displayAtlas";
import { DISPLAY_STATE_LEVEL } from "../src/render/webgpu/aircraft/cockpit/displays/displayState";
import { BEZEL_RIM, bezelRimEmissive } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import { KNOTS_PER_METRE_PER_SECOND, FEET_PER_METRE } from "../src/render/webgpu/aircraft/cockpit/instrumentMappings";
import { createRecordingContext, transformedPoints } from "./support/recordingContext";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import { projectPoint, rasteriseClipped, type Pinhole } from "./support/drawnFaceRaster";
import { SkinCaster } from "../src/render/webgpu/aircraft/airlinerGlazing";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import { TRAINER_CANOPY_SECTIONS, TRAINER_FUSELAGE_SECTIONS } from "../src/render/webgpu/aircraft/trainerShell";
import { worldTriangles as tipWorldTriangles, hitTriangle as tipHitTriangle } from "../scripts/rayCrossings.mts";
import { GLARESHIELD_IMAGE_LIGHT } from "../src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import type { PBRMaterial as PanelMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";

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
  it("have exactly three main dials, airspeed, attitude and altimeter, and the engine's two gauges as the board's detail", () => {
    // Jason: "the trainer should only have 3 dials" (2026-09-23). Read off the BUILT meshes and off the
    // placements the HUD survey projects, so a fourth MAIN dial left in either place fails here by name. The
    // tachometer and the engine cluster (S2b, the PM's call) are the type's engine gauges, smaller and off the row.
    const parts = cockpitOnly.map((part) => part.name);
    // the faces are one mesh (the display atlas's screens): the three dials', the two radios' windows (S2), the
    // tachometer's and the engine cluster's (S2b)
    expect(named("trainer-dial-faces").metadata?.mergedFrom).toEqual([
      "trainer-airspeed-face", "trainer-attitude-face", "trainer-altimeter-face", "trainer-com-window", "trainer-nav-window",
      "trainer-tach-face", "trainer-engine-face",
    ]);
    expect(parts.filter((name) => /-needle$/.test(name)).sort()).toEqual(["trainer-airspeed-needle", "trainer-altimeter-needle", "trainer-tach-needle"]);
    expect(trainerDialPlacements().map((dial) => dial.name)).toEqual(["airspeed", "attitude", "altimeter"]);
    // 15 when the Cessna pass began, the headliner (S4), the yokes (S6), the tachometer's needle (S2b), the compass's
    // card and its rim (S7) since: the PM's budget is 8 more draws over the pass
    expect(parts).toHaveLength(20);
  });

  it("are within the pass's budget of eight more meshes than its first 15, and keep the dial names", () => {
    // the faces and the bezels (one mesh each for all three dials, S2), two needles (the attitude dial has a BALL
    // instead: sky, ground, pitch bar)
    const dialNames = [
      "trainer-dial-faces", "trainer-dial-bezels",
      ...["airspeed", "altimeter", "tach"].map((dial) => `trainer-${dial}-needle`),
      "trainer-attitude-sky", "trainer-attitude-ground", "trainer-attitude-pitch-bar",
    ];
    for (const name of dialNames) expect(cockpitOnly.map((part) => part.name)).toContain(name);
    const others = cockpitOnly.filter((part) => !dialNames.includes(part.name)).map((part) => part.name).sort();
    expect(others).toEqual([
      "trainer-a-pillar-port",
      "trainer-a-pillar-starboard",
      "trainer-compass-card",
      "trainer-compass-rim",
      "trainer-cowl-standin",
      "trainer-door-port",
      "trainer-door-starboard",
      "trainer-glareshield",
      "trainer-headliner",
      "trainer-instrument-panel",
      "trainer-panel-fittings",
      "trainer-yokes",
    ]);
    expect(cockpitOnly.length, "the pass's budget: 15 when it began, 8 more at most").toBeLessThanOrEqual(15 + 8);
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
      const centre = trainerDialPlacements().find((p) => p.name === dial)!.centre;
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
    const z = (dial: string) => trainerDialPlacements().find((p) => p.name === dial)!.centre.z;
    // Airspeed left of the attitude indicator, altimeter to its right; the old layout mirrored it.
    expect(z("airspeed")).toBeLessThan(z("attitude"));
    expect(z("attitude")).toBeLessThan(z("altimeter"));
    // 4 cm inboard of the eye's line since the deck and the board went wall to wall (Jason and the PM, 2026-09-29): the
    // cabin's inner line at the panel station, at the dials' height, is 0.3957 out, so on the eye's line the airspeed
    // dial's rim (|z| 0.40) stood 4.3 mm outside it; at -0.32 it is 3.6 cm inside. The attitude indicator is 3.3 degrees
    // right of dead ahead.
    expect(z("attitude")).toBeCloseTo(EYE.right + 0.04, 3);
    for (const dial of ["airspeed", "attitude", "altimeter"]) {
      const centre = trainerDialPlacements().find((p) => p.name === dial)!.centre;
      // Every dial is where the pilot can see it: the first thing a ray toward it meets is its face, its needle or its ball.
      const d = centre.subtract(EYE_POINT);
      const hit = scene.pickWithRay(new Ray(EYE_POINT, d.normalize(), 5), drawnByCockpitCamera);
      expect(hit?.pickedMesh?.name, `${dial} is hidden behind something`).toMatch(new RegExp(`trainer-(dial-faces|${dial}-needle|${dial}-(sky|ground|pitch-bar))`));
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

  it("stand the cowl on the shell it replaces: the same rings, so the same surface, and a 15 mm round lip past its nose", () => {
    const tube = named("trainer-fuselage");
    const standIn = named("trainer-cowl-standin");
    const forward = TRAINER_FUSELAGE_SECTIONS.filter((section) => section.x >= 2.42);
    expect(forward.map((section) => section.x)).toEqual([2.42, 3.7]);
    const shell = worldVertices(tube).filter((v) => v.x >= 2.42 - 1e-6);
    const vertices = worldVertices(standIn);
    const ring = vertices.filter(
      // The stand-in's rear cap has a centre vertex on the axis that the
      // fuselage, which is continuous through 2.42, does not have; the lip (S5)
      // runs on past the shell's nose. Every other vertex is a point on a ring.
      (v) => !(v.x < 2.42 + 1e-6 && Math.abs(v.z) < 1e-6 && Math.abs(v.y - -0.34) < 1e-6) && v.x <= 3.7 + 1e-6,
    );
    expect(ring.length).toBeGreaterThan(40);
    for (const vertex of ring) {
      const nearest = Math.min(...shell.map((s) => Vector3.Distance(s, vertex)));
      expect(nearest).toBeLessThan(1e-4);
    }
    // THE LIP: the nose's rim was a flat cap's 90-degree crease the pilot saw across the cowl (six edges, 175 px). Its
    // rings run 15 mm on and in, a quarter-round, and stop short of the spinner's back face at 3.74.
    const lip = vertices.filter((v) => v.x > 3.7 + 1e-6);
    expect(lip.length, "the lip's vertices").toBeGreaterThan(4 * 24);
    expect(Math.max(...lip.map((v) => v.x)), "the lip's front").toBeCloseTo(3.7 + TRAINER_COWL_LIP.radius, 5);
    const noseTop = Math.max(...ring.filter((v) => v.x > 3.7 - 1e-6).map((v) => v.y));
    const frontTop = Math.max(...lip.filter((v) => v.x > 3.7 + TRAINER_COWL_LIP.radius - 1e-6).map((v) => v.y));
    expect(noseTop - frontTop, "the lip turns down its radius at the top").toBeCloseTo(TRAINER_COWL_LIP.radius, 4);
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
 * THE WINDSCREEN CENTRE FRAME: one strip, ending in structure at both ends (the Cessna pass, S5).
 *
 * `windscreen-center-frame` (trainerVisual.ts) is the exterior strip up the middle of the Cessna's windscreen. Its top
 * used to stop in OPEN AIR, 0.38 m short of the cabin roof: first as a flat end disc that read as a lit octagon against
 * the sky, then as a cone to a point. Its foot floated 8 to 49 mm above the cowl deck. The first fix ran it from under
 * the deck up to a corner, turned it at a ball joint, and ran it aft along the glass crown into the roof slab, which is
 * closed (`solidified`): two round 48 mm bars and a knuckle, which the pilot saw as 62,278 px with 6 hard edges and a
 * facet silhouette. S5 keeps the axis and both ends and makes it ONE strip, flattened through the glass and tapering
 * toward the roof, round a 6 cm fillet where the ball was.
 *
 * What is held: every vertex of the built strip on the design ellipse about the design centreline (the old axis, the
 * fillet, the taper), so a ball, a round bar, a sharp corner or no taper all fail; its faces meeting their neighbours at
 * under 30 degrees round it and 10 along it (no facet line, no knuckle); at most 45,000 px from the seat; the bottom ring
 * under the cowl deck; everything aft of the roof's front edge inside the slab, and the slab's walls facing out; the
 * member's faces drawn from the pilot's seat; and no end disc the nearest drawn surface from the seat or from any
 * exterior angle, INCLUDING grazing ones in the roof's own plane, where the roof's once inside-out walls let the buried
 * end show through.
 */
describe("the Cessna's windscreen centre frame", () => {
  const FOOT = new Vector3(2.26, -0.02, 0);
  /** How far the mesh runs on past the design foot, down into the fuselage. */
  const BURY = 0.1;
  const CORNER = new Vector3(2, 0.21, 0);
  const INTO_ROOF = new Vector3(1.6, 0.205, 0);
  const BEND = 0.06;
  /** Across the glass and through it, at the buried foot and at the end in the roof. */
  const WIDTH = { foot: 0.034, end: 0.024 };
  const DEPTH = { foot: 0.022, end: 0.016 };
  const up = CORNER.subtract(FOOT).normalize();
  const aft = INTO_ROOF.subtract(CORNER).normalize();
  const START = FOOT.subtract(up.scale(BURY));
  // the fillet, tangent to both runs: its tangent points `BEND * tan(turn / 2)` from the corner, its centre BEND inside
  const turn = Math.acos(Vector3.Dot(up, aft));
  const reach = BEND * Math.tan(turn / 2);
  const IN_TO = CORNER.subtract(up.scale(reach));
  const OUT_OF = CORNER.add(aft.scale(reach));
  const inward = aft.subtract(up.scale(Vector3.Dot(aft, up))).normalize();
  const BEND_CENTRE = IN_TO.add(inward.scale(BEND));
  const upLength = Vector3.Distance(START, IN_TO);
  const arcLength = BEND * turn;
  const aftLength = Vector3.Distance(OUT_OF, INTO_ROOF);
  const LENGTH = upLength + arcLength + aftLength;
  /**
   * A point's place against the DESIGN centreline (in the x-y plane): how far along it from the buried start (`s`), how
   * far off it in that plane (`through`) and across it (`across`, its z). Nearest of the up run, the fillet and the aft run.
   */
  function onCentreline(p: Vector3): { s: number; through: number; across: number } {
    const q = new Vector3(p.x, p.y, 0);
    const candidates: { s: number; through: number }[] = [];
    const tUp = Math.max(0, Math.min(upLength, Vector3.Dot(q.subtract(START), up)));
    candidates.push({ s: tUp, through: Vector3.Distance(q, START.add(up.scale(tUp))) });
    const tAft = Math.max(0, Math.min(aftLength, Vector3.Dot(q.subtract(OUT_OF), aft)));
    candidates.push({ s: upLength + arcLength + tAft, through: Vector3.Distance(q, OUT_OF.add(aft.scale(tAft))) });
    const from = IN_TO.subtract(BEND_CENTRE).normalize();
    const radial = q.subtract(BEND_CENTRE);
    const angle = Math.atan2(Vector3.Dot(Vector3.Cross(from, radial), new Vector3(0, 0, 1)), Vector3.Dot(from, radial));
    const sweep = Math.abs(angle);
    const sense = Math.sign(Vector3.Dot(Vector3.Cross(from, OUT_OF.subtract(BEND_CENTRE)), new Vector3(0, 0, 1)));
    if (Math.sign(angle) === sense && sweep <= turn) candidates.push({ s: upLength + BEND * sweep, through: Math.abs(radial.length() - BEND) });
    const best = candidates.reduce((a, b) => (b.through < a.through ? b : a));
    return { ...best, across: Math.abs(p.z) };
  }
  const halfWidthAt = (s: number) => (WIDTH.foot + ((WIDTH.end - WIDTH.foot) * s) / LENGTH) / 2;
  const halfDepthAt = (s: number) => (DEPTH.foot + ((DEPTH.end - DEPTH.foot) * s) / LENGTH) / 2;
  type Tri = { a: Vector3; b: Vector3; c: Vector3 };
  const key = (t: Tri) => `${t.a.x},${t.a.y},${t.a.z}|${t.b.x},${t.b.y},${t.b.z}|${t.c.x},${t.c.y},${t.c.z}`;
  const pointKey = (p: Vector3) => `${p.x.toFixed(7)},${p.y.toFixed(7)},${p.z.toFixed(7)}`;
  const distinct = (points: Vector3[]) => [...new Map(points.map((p) => [pointKey(p), p])).values()];
  /** The built strip's bottom ring: its vertices at the buried start, off the centreline (the cap's centre is on it). */
  const bottomRing = () => distinct(worldVertices(named("windscreen-center-frame")).filter((p) => {
    const at = onCentreline(p);
    return at.s < 1e-4 && at.through + at.across > 1e-4;
  }));

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
   * Every END DISC of the strip: a triangle wholly in the plane that ends it (the buried foot, the end in the roof),
   * within its half-width of that end's centre, and FACING ALONG the centreline there.
   */
  function endDiscs(): Tri[] {
    const ends = [
      { centre: START, axis: up, radius: WIDTH.foot / 2 },
      { centre: INTO_ROOF, axis: aft, radius: WIDTH.end / 2 },
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

  it("is ONE strip on the old axis, round a 6 cm fillet at the corner: every vertex on an ellipse 34 to 24 mm across and 22 to 16 through", () => {
    const frame = named("windscreen-center-frame");
    expect(frame.metadata?.mergedFrom, "one strip, not bars merged with a joint").toBeUndefined();
    expect((frame.material as PBRMaterial).name).toBe("trainer-dark");
    // it is EXTERIOR, not cockpit-only: that is the whole point of fixing it here rather than hiding it
    expect(cockpitOnly.map((part) => part.name)).not.toContain("windscreen-center-frame");
    const places = worldVertices(frame).map(onCentreline).filter((at) => at.through + at.across > 1e-4);
    // every vertex on its station's ellipse: a ball at the corner, a round bar, a sharp corner or an untapered strip
    // puts vertices off it by far more than this
    const worst = Math.max(...places.map((at) => Math.abs(Math.hypot(at.across / halfWidthAt(at.s), at.through / halfDepthAt(at.s)) - 1)));
    expect(worst, "furthest off the design ellipse, as a fraction of it").toBeLessThan(0.02);
    // NON-VACUITY: it runs the whole centreline, from the buried start to the end in the roof, and round the fillet
    expect(Math.min(...places.map((at) => at.s))).toBeLessThan(1e-4);
    expect(Math.max(...places.map((at) => at.s))).toBeGreaterThan(LENGTH - 1e-3);
    const onFillet = new Set(places.filter((at) => at.s > upLength + 1e-3 && at.s < upLength + arcLength - 1e-3).map((at) => at.s.toFixed(4)));
    expect(onFillet.size, "rings round the fillet").toBeGreaterThanOrEqual(5);
    // the section's two axes, where it is widest: at the foot 34 mm across and 22 through
    const foot = places.filter((at) => at.s < 1e-4);
    expect(2 * Math.max(...foot.map((at) => at.across)), "34 mm across at the foot").toBeCloseTo(WIDTH.foot, 4);
    expect(2 * Math.max(...foot.map((at) => at.through)), "22 mm through at the foot").toBeCloseTo(DEPTH.foot, 4);
  });

  it("has no facet line and no knuckle: its faces meet their neighbours at under 30 degrees round it and 10 along it", () => {
    // The two bars were octagons, which the pilot saw as a facet silhouette at 45 degrees, and met the ball at 90. Every
    // edge two of its faces share, but the rim of each end's cap (the end-disc pin below holds those out of sight).
    const frame = named("windscreen-center-frame");
    const v = worldVertices(frame);
    const indices = frame.getIndices()!;
    const k = (p: Vector3) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`;
    const shared = new Map<string, { a: Vector3; b: Vector3; normals: Vector3[] }>();
    for (let t = 0; t < indices.length; t += 3) {
      const [A, B, C] = [v[indices[t]!]!, v[indices[t + 1]!]!, v[indices[t + 2]!]!];
      const n = Vector3.Cross(B.subtract(A), C.subtract(A));
      if (n.length() < 1e-14) continue;
      n.normalize();
      for (const [p, q] of [[A, B], [B, C], [C, A]] as const) {
        const edgeKey = [k(p), k(q)].sort().join("|");
        const edge = shared.get(edgeKey) ?? { a: p, b: q, normals: [] };
        edge.normals.push(n);
        shared.set(edgeKey, edge);
      }
    }
    let round = 0;
    let along = 0;
    let rounds = 0;
    let rings = 0;
    for (const edge of shared.values()) {
      expect(edge.normals.length, "every edge is shared by two faces: the strip is closed").toBe(2);
      const angle = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(edge.normals[0]!, edge.normals[1]!)))) * DEG;
      const [a, b] = [onCentreline(edge.a), onCentreline(edge.b)];
      const onRing = Math.abs(a.s - b.s) < 1e-4;
      if (onRing && (a.s < 1e-4 || a.s > LENGTH - 1e-3)) continue;
      if (onRing) {
        along = Math.max(along, angle);
        rings += 1;
      } else {
        round = Math.max(round, angle);
        rounds += 1;
      }
    }
    expect(rings, "edges round its inner rings").toBeGreaterThan(10 * 8);
    expect(rounds, "edges along it").toBeGreaterThan(10 * 8);
    expect(round, "the sharpest turn between two faces round the strip, degrees").toBeLessThan(30);
    expect(along, "the sharpest turn between two faces along the strip, degrees").toBeLessThan(10);
  });

  it("keeps within 45,000 px of the pilot's 1080p frame, and is seen there (the bars and knuckle were 62,278)", () => {
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
    const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
    const index = meshes.indexOf(named("windscreen-center-frame"));
    expect(index, "the strip is drawn from the seat").toBeGreaterThanOrEqual(0);
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    let px = 0;
    for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === index) px += 1;
    expect(px).toBeLessThan(45_000);
    expect(px).toBeGreaterThan(15_000);
  });

  it("starts under the cowl deck: every point of its bottom ring is below the surface above it", () => {
    // The design foot stood 8 to 49 mm ABOVE the deck, so the ring floated and its end disc showed to
    // anyone ahead of the aeroplane. Cast down from high above each point of the bottom ring: the first
    // surface met must be the fuselage, and ABOVE the point, by at least 5 mm.
    const ring = bottomRing();
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
    // NON-VACUITY: the strip caps both its ends, the buried foot and the end in the roof, each a fan (of 24)
    expect(discs.length, "end-disc triangles found").toBeGreaterThanOrEqual(2 * 8);
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
    // THE POSITIVE CONTROL: with nothing but the member itself in the scene (the roof and the deck are
    // not), discs ARE the nearest drawn surface from some viewpoints -- the aft end's faces the pilot, the
    // foot's faces the front. A survey that could not see a disc reads zero below for the wrong reason.
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
  /**
   * The edges the pilot sees that are HARD: two faces at more than 46 degrees, shaded apart, one of them drawn toward the
   * eye. An edge is seen where its own mesh is drawn at its depth within a pixel of it: a SILHOUETTE crease (the cowl's
   * flat-capped nose, S5, whose cap faces away and is culled) has the mesh on one side of it only, and the pixel under
   * the line itself is as often what lies beyond.
   */
  function visibleHardEdges(mesh: AbstractMesh, raster: ReturnType<typeof frame>, meshIndex: number, shading: "split" | "any" = "split") {
    const { edges: all, key } = edges(mesh);
    return all.filter((e) => {
      if (e.faces.length !== 2) return false;
      const [f, g] = e.faces as [typeof e.faces[0], typeof e.faces[0]];
      if (Vector3.Dot(f.normal, g.normal) > Math.cos(46 / DEG)) return false;
      const split = [e.a, e.b].some((p) => Vector3.Dot(f.at.get(key(p))!, g.at.get(key(p))!) < Math.cos(1 / DEG));
      if ((shading === "split" && !split) || !(f.toward || g.toward)) return false;
      let seen = 0;
      for (let s = 0; s <= 40; s += 1) {
        const q = projectPoint(pin, Vector3.Lerp(e.a, e.b, s / 40));
        const x = Math.floor(q.x);
        const y = Math.floor(q.y);
        if (!(q.depth > 0.02)) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy += 1) {
          for (let dx = -1; dx <= 1 && !near; dx += 1) {
            const [xx, yy] = [x + dx, y + dy];
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const i = yy * W + xx;
            near = raster.mesh[i] === meshIndex && Math.abs(raster.depth[i]! - q.depth) < 0.0015 + 0.004 * q.depth;
          }
        }
        if (near) seen += 1;
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

  it("shows the pilot no hard edge on the deck, the board, the port door, the port pillar, the panel's face, the headliner, the centre strip or the cowl's nose, outside the deck's designed cove", () => {
    const raster = frame();
    const meshes = drawn();
    const section = trainerDeckSection();
    // the cove, by design: round to cove along (coveTop), cove to board along (faceTop), right across the cabin
    const onCove = (p: Vector3) => [section.coveTop, section.faceTop].some((c) => Math.abs(p.x - c.x) < 2e-4 && Math.abs(p.y - c.y) < 2e-4);
    for (const name of [
      "trainer-glareshield", "trainer-instrument-panel", "trainer-door-port", "trainer-a-pillar-port",
      // the panel's face (S2): the dials' faces and the radios' windows, the bezels, the radios' bodies and knobs and the switches
      "trainer-dial-faces", "trainer-dial-bezels", "trainer-panel-fittings",
      // the overhead (S4): the headliner and its header, the visors
      "trainer-headliner",
      // the windscreen's centre strip and the cowl's nose (S5): a knuckle and a flat cap's rim before
      "windscreen-center-frame", "trainer-cowl-standin",
      // the yokes (S6): the horn tops the pilot sees, and the collar where the column enters the board
      "trainer-yokes",
      // the compass's window ring and lubber line (S7)
      "trainer-compass-rim",
    ]) {
      const mesh = named(name);
      expect(meshes.indexOf(mesh), `${name} is drawn`).toBeGreaterThanOrEqual(0);
      const hard = visibleHardEdges(mesh, raster, meshes.indexOf(mesh)).filter((e) => !(onCove(e.a) && onCove(e.b)));
      expect(hard.map((e) => `(${e.a.x.toFixed(3)}, ${e.a.y.toFixed(3)}, ${e.a.z.toFixed(3)})`), `hard edges on ${name}`).toEqual([]);
    }
    // CONTROL: the instrument sees a box's hard edges -- the attitude ball's pitch bar is one
    const bar = named("trainer-attitude-pitch-bar");
    expect(visibleHardEdges(bar, raster, meshes.indexOf(bar)).length).toBeGreaterThan(3);
  });

  it("shows the pilot no crease at all on the centre strip or the cowl's nose, smooth-shaded ones included; a flat nose cap is one", () => {
    // The pin above asks for SPLIT shading. The cowl's nose was a flat cap sharing its rim's vertices with the cowl, so
    // one averaged normal there, and a 92-degree crease the pilot saw across the cowl's top all the same: on these two
    // S5 parts, a crease of any shading counts.
    const raster = frame();
    const meshes = drawn();
    // and the yokes (S6), whose horns end in domes rather than flat caps
    for (const name of ["windscreen-center-frame", "trainer-cowl-standin", "trainer-yokes"]) {
      const mesh = named(name);
      const creases = visibleHardEdges(mesh, raster, meshes.indexOf(mesh), "any");
      expect(creases.map((e) => `(${e.a.x.toFixed(3)}, ${e.a.y.toFixed(3)}, ${e.a.z.toFixed(3)})`), `creases on ${name}`).toEqual([]);
    }
    // CONTROL: the stand-in with its lip cut off and its nose ring closed on a flat fan, smooth-shaded, in its place
    const standIn = named("trainer-cowl-standin");
    const v = worldVertices(standIn);
    const indices = standIn.getIndices()!;
    const kept: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      if (corners.every((i) => v[i]!.x <= 3.7 + 1e-6)) kept.push(...corners);
    }
    const nose = [...new Set(v.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p.x - 3.7) < 1e-6).map(([, i]) => i))]
      .sort((i, j) => Math.atan2(v[i]!.z, v[i]!.y + 0.17) - Math.atan2(v[j]!.z, v[j]!.y + 0.17));
    const centre = v.length;
    for (let k = 0; k < nose.length; k += 1) {
      const [a, b] = [nose[k]!, nose[(k + 1) % nose.length]!];
      // drawn from ahead: the cross product points into the solid, aft
      const cross = Vector3.Cross(v[b]!.subtract(v[a]!), new Vector3(3.7, -0.17, 0).subtract(v[a]!));
      kept.push(...(cross.x < 0 ? [a, b, centre] : [b, a, centre]));
    }
    const positions = [...v, new Vector3(3.7, -0.17, 0)].flatMap((p) => [p.x, p.y, p.z]);
    // one normal a vertex, averaged over its faces, as the loft shades its rim (neither check reads its sign)
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, kept, normals);
    const data = new VertexData();
    data.positions = positions;
    data.indices = kept;
    data.normals = normals;
    const capped = new Mesh("cowl-flat-nose-control", scene);
    data.applyToMesh(capped);
    try {
      const withCap = [...meshes.filter((m) => m !== standIn && m !== capped), capped];
      const controlRaster = rasteriseClipped(pin, withCap, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      expect(nose.length, "the nose ring").toBeGreaterThanOrEqual(24);
      expect(visibleHardEdges(capped, controlRaster, withCap.indexOf(capped), "any").length, "the flat nose's creases seen").toBeGreaterThan(3);
      expect(visibleHardEdges(capped, controlRaster, withCap.indexOf(capped), "split").length, "...none of them split-shaded").toBe(0);
    } finally {
      capped.dispose();
    }
  });

  it("keeps every vertex of the deck, the board, the door frames and the headliner inside the cabin: 2 cm inside the glass above the tube, inside the tube below", () => {
    const glass = named("trainer-canopy");
    const tube = named("trainer-fuselage");
    // Against the BUILT lofts, whose facets sit inside the surface their rings describe: the canopy's 18 chords round
    // its ring stand up to 6 mm inside it, so 2 cm from the ruled surface is at least 1.4 cm from the drawn glass.
    const FACET_SAG = 0.006;
    let checked = 0;
    // the headliner's top reaches up into the roof slab (y 0.18 to 0.23), where there is no glass to keep inside of
    const inRoofSlab = (v: Vector3) => v.y > 0.18 - 1e-6 && Math.abs(v.z) <= 0.31 && v.x <= 1.62 - Math.max(0, Math.abs(v.z) - 0.15) * (0.18 / 0.16) + 1e-6;
    for (const name of ["trainer-glareshield", "trainer-instrument-panel", "trainer-door-port", "trainer-door-starboard", "trainer-headliner"]) {
      for (const v of worldVertices(named(name))) {
        if (name === "trainer-headliner" && inRoofSlab(v)) continue;
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
    // CONTROL: without the door frames both ends' edges are in plain sight -- without the yokes too, whose outboard horn
    // (S6) stands in front of the board's port end and hides one of its edges
    for (const count of edgesShown(drawn().filter((m) => !m.name.startsWith("trainer-door") && m.name !== "trainer-yokes"))) expect(count).toBeGreaterThan(2);
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
    const bezels = worldVertices(named("trainer-dial-bezels"));
    for (const dial of ["airspeed", "attitude", "altimeter"]) {
      const centre = trainerDialPlacements().find((p) => p.name === dial)!.centre;
      // the dial's bezel, its outermost edge the case's: every vertex of it within 5 cm of the dial's centre
      for (const p of bezels.filter((v) => Vector3.Distance(v, centre) < 0.05)) {
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
    // the airspeed face's pixels: the faces mesh's, inside the circle the dial's face projects to
    const faces = named("trainer-dial-faces");
    const placement = trainerDialPlacements().find((p) => p.name === "airspeed")!;
    const across = new Vector3(0, 0, 1);
    const upFace = Vector3.Cross(placement.normal, across).normalize();
    const rim = Array.from({ length: 36 }, (_, k) => placement.centre.add(across.scale(0.034 * Math.cos((k * Math.PI) / 18))).add(upFace.scale(0.034 * Math.sin((k * Math.PI) / 18))));
    const ring = rim.map((p) => projectPoint(pin, p));
    const middle = projectPoint(pin, placement.centre);
    const inside = (x: number, y: number) => {
      // inside the projected ring (an ellipse, near enough convex): no ring point's direction is passed
      const a = Math.atan2(y - middle.y, x - middle.x);
      const reach = ring.reduce((best, q) => {
        const qa = Math.atan2(q.y - middle.y, q.x - middle.x);
        const gap = Math.abs(Math.atan2(Math.sin(qa - a), Math.cos(qa - a)));
        return gap < best.gap ? { gap, r: Math.hypot(q.x - middle.x, q.y - middle.y) } : best;
      }, { gap: Infinity, r: 0 }).r;
      return Math.hypot(x - middle.x, y - middle.y) < reach;
    };
    const count = (meshes: AbstractMesh[]) => {
      const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      const index = meshes.indexOf(faces);
      let n = 0;
      for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === index && inside(i % W, Math.floor(i / W))) n += 1;
      return n;
    };
    const all = drawn();
    const withDoor = count(all);
    const without = count(all.filter((m) => !m.name.startsWith("trainer-door")));
    expect(withDoor).toBeGreaterThan(8000);
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

/**
 * THE PANEL'S FACE (the Cessna pass, S2): the dials' bezels and faces, the radio stack, the switches.
 *
 * What is held, off the BUILT meshes and the pages as drawn (a recording context under Node, where there is no canvas):
 * - each dial's bezel: a ring 6 mm wide, 3 mm proud, with a 2 mm 45 degree outer chamfer, round a face 2 mm below its
 *   front, on the shared rim material and glowing by its law;
 * - the faces are the display atlas's screens, each face's front carrying its own slot the right way round;
 * - each dial's page draws at least 12 marks, all resolvable at 1080p (3 px apart, at least 1.2 px wide), at the angles
 *   its needle turns to: a needle points at the number it reads;
 * - the radio stack's two 160 x 40 mm units, each a window and two knobs, and the four switches, in the frame;
 * - the bare board, which the panel's face is there to cover.
 */
describe("the Cessna's panel face", () => {
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
  const slots = new Map(displaySlots(TRAINER_DISPLAYS).map((slot) => [slot.screen, slot]));
  const faceMap = TRAINER_BEZEL.faceRadius / TRAINER_DIAL_FACE_FRACTION;
  const faceFront = TRAINER_BEZEL.proud - TRAINER_BEZEL.faceRecess;
  /** A round face's plane: the three dials' and the tachometer's (S2b). */
  const frameOf = (dial: string) => (dial === "tach" ? trainerTachFrame() : trainerDialFrames().find((f) => f.name === dial)!.frame);
  /** A round face's disc, which its slot spans: the tachometer's is smaller. */
  const faceMapOf = (dial: string) => (dial === "tach" ? TRAINER_TACH.faceRadius / TRAINER_DIAL_FACE_FRACTION : faceMap);

  /** A page's point (its slot's pixels) where it lands on the dial's face: the face disc spans the whole slot. */
  function onFace(dial: string, x: number, y: number, size: number): Vector3 {
    const f = frameOf(dial);
    const m = faceMapOf(dial);
    return f.origin.add(f.across.scale((x / size - 0.5) * 2 * m)).add(f.up.scale((0.5 - y / size) * 2 * m)).add(f.out.scale(faceFront));
  }

  /** A page's marks: each stroked segment in the scale's colour, its ends and its width, in the slot's pixels. */
  function marks(page: DrawPage, size: number) {
    const ctx = createRecordingContext();
    page(ctx, size, size, DISPLAY_STATE_LEVEL);
    const calls = ctx.calls;
    const points = transformedPoints(calls);
    const found: { from: { x: number; y: number }; to: { x: number; y: number }; width: number }[] = [];
    for (const p of points) {
      if (p.method !== "moveTo" || p.strokeStyle !== "#f2f2ee") continue;
      if (calls[p.index + 1]?.method !== "lineTo" || calls[p.index + 2]?.method !== "stroke") continue;
      const to = points.find((q) => q.index === p.index + 1)!;
      let width = 1;
      for (let i = p.index; i >= 0; i -= 1) if (calls[i]!.method === "set:lineWidth") { width = calls[i]!.args[0] as number; break; }
      found.push({ from: { x: p.x, y: p.y }, to: { x: to.x, y: to.y }, width });
    }
    return { found, texts: points.filter((p) => p.method === "fillText").map((p) => p.text) };
  }

  it("rings each dial with a bezel 6 mm wide and 3 mm proud, a 2 mm 45 degree chamfer outside, round a face 2 mm below its front", () => {
    const bezels = worldVertices(named("trainer-dial-bezels"));
    const faces = worldVertices(named("trainer-dial-faces"));
    for (const { name, frame } of trainerDialFrames()) {
      const local = (v: Vector3) => {
        const d = v.subtract(frame.origin);
        return { r: Math.hypot(Vector3.Dot(d, frame.across), Vector3.Dot(d, frame.up)), a: Vector3.Dot(d, frame.out) };
      };
      const ring = bezels.map(local).filter((p) => p.r < 0.05);
      expect(Math.min(...ring.map((p) => p.r)), `${name}: the ring's opening`).toBeCloseTo(0.034, 5);
      expect(Math.max(...ring.map((p) => p.r)), `${name}: the ring's outside`).toBeCloseTo(0.04, 5);
      expect(Math.max(...ring.map((p) => p.a)), `${name}: 3 mm proud`).toBeCloseTo(0.003, 5);
      // the chamfer: its shoulder 2 mm in from the edge on the front, its foot at the edge 2 mm down
      expect(ring.some((p) => Math.abs(p.r - 0.038) < 1e-6 && Math.abs(p.a - 0.003) < 1e-6), `${name}: the chamfer's shoulder`).toBe(true);
      expect(ring.some((p) => Math.abs(p.r - 0.04) < 1e-6 && Math.abs(p.a - 0.001) < 1e-6), `${name}: the chamfer's foot`).toBe(true);
      // the face's front 2 mm under the ring's, and its edge under the ring (buried)
      const face = faces.map(local).filter((p) => p.r < 0.05);
      expect(Math.max(...face.map((p) => p.a)), `${name}: the face's front`).toBeCloseTo(0.001, 5);
      expect(Math.max(...face.map((p) => p.r)), `${name}: the face's edge under the ring`).toBeGreaterThan(0.034);
      expect(Math.max(...face.map((p) => p.r)), `${name}: the face's edge under the ring`).toBeLessThan(0.034 + 0.006 - 0.002);
    }
  });

  it("puts the bezels on the shared rim, glowing by its law: the day value by day, the night glow at night", () => {
    const material = named("trainer-dial-bezels").material as PanelMaterial;
    expect(material.albedoColor.toHexString().toLowerCase()).toBe(`#${BEZEL_RIM.albedo.toString(16).padStart(6, "0")}`);
    expect(material.roughness).toBe(BEZEL_RIM.roughness);
    const lights = (cockpitGlow: number) => ({ portNav: 1, starboardNav: 1, tailNav: 1, beacon: 0, strobe: 0, landing: 0, cockpitGlow });
    for (const glow of [1, 2.5, 4]) {
      aircraft.setLightState?.(lights(glow));
      expect(material.emissiveIntensity, `glow ${glow}`).toBeCloseTo(bezelRimEmissive(glow), 6);
    }
    aircraft.setLightState?.(lights(1));
  });

  it("makes the faces and the radios' windows the display atlas's screens, and keeps them flat where there is no canvas", () => {
    const faces = named(TRAINER_DISPLAYS.screensMesh);
    expect(faces.name).toBe("trainer-dial-faces");
    // headless: no atlas, the faces keep the flat instrument face
    expect(aircraft.displaysLive).toBe(false);
    expect((faces.material as PanelMaterial).name).toBe("trainer-instrument-face");
    // each dial's face carries its own slot: its centre on the slot's centre, u with the pilot's right, v against up
    const atlas = { w: displayAtlasWidth(TRAINER_DISPLAYS), h: displayAtlasHeight(TRAINER_DISPLAYS) };
    const positions = worldVertices(faces);
    const uvs = faces.getVerticesData(VertexBuffer.UVKind)!;
    const normals = faces.getVerticesData(VertexBuffer.NormalKind)!;
    for (const { name, frame } of trainerDialFrames()) {
      const slot = slots.get(name)!;
      const front = positions.map((p, i) => ({ p, i })).filter(({ p, i }) =>
        Vector3.Distance(p, frame.origin) < 0.05 && Vector3.Dot(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), frame.out) > 0.999);
      expect(front.length, `${name}: its face's front`).toBeGreaterThan(40);
      for (const { p, i } of front) {
        const d = p.subtract(frame.origin);
        const u = uvs[i * 2]! * atlas.w;
        const v = uvs[i * 2 + 1]! * atlas.h;
        expect(u, `${name}: u`).toBeCloseTo(slot.x + (Vector3.Dot(d, frame.across) / (2 * faceMap) + 0.5) * slot.w, 3);
        expect(v, `${name}: v`).toBeCloseTo(slot.y + (0.5 - Vector3.Dot(d, frame.up) / (2 * faceMap)) * slot.h, 3);
        // within its slot, to a thousandth of a texel (UVs are stored single precision)
        expect(u).toBeGreaterThanOrEqual(slot.x - 1e-3);
        expect(u).toBeLessThanOrEqual(slot.x + slot.w + 1e-3);
      }
    }
  });

  it("draws at least 12 marks on each dial, inside the face the pilot sees, each resolvable at 1080p: 3 px apart and at least 1.2 px wide", () => {
    const size = slots.get("airspeed")!.w;
    for (const [dial, page, least] of [["airspeed", drawTrainerAsi, 25], ["attitude", drawTrainerAttitudeRing, 12], ["altimeter", drawTrainerAltimeter, 50], ["tach", drawTrainerTach, 36]] as const) {
      const { found } = marks(page, size);
      expect(found.length, `${dial}: its marks`).toBeGreaterThanOrEqual(least);
      const visible = (size / 2) * TRAINER_DIAL_FACE_FRACTION;
      const outer = found.map((m) => {
        expect(Math.hypot(m.to.x - size / 2, m.to.y - size / 2), `${dial}: a mark outside the face`).toBeLessThanOrEqual(visible + 1e-6);
        return projectPoint(pin, onFace(dial, m.to.x, m.to.y, size));
      });
      // on the screen: each mark's outer end at least 3 px from the next round the dial
      const centre = projectPoint(pin, onFace(dial, size / 2, size / 2, size));
      const order = outer.map((q, k) => ({ q, k, a: Math.atan2(q.y - centre.y, q.x - centre.x) })).sort((x, y) => x.a - y.a);
      const gaps = order.slice(1).map((o, k) => Math.hypot(o.q.x - order[k]!.q.x, o.q.y - order[k]!.q.y));
      expect(Math.min(...gaps), `${dial}: marks closer than 3 px on the screen`).toBeGreaterThanOrEqual(3);
      // each mark's width on the screen: its stroke's width in the page, in metres on the face, in pixels at its distance
      for (const m of found) {
        const metres = (m.width / size) * 2 * faceMapOf(dial);
        const at = projectPoint(pin, onFace(dial, m.to.x, m.to.y, size));
        const px = (metres * (H / 2)) / Math.tan(pin.fovY / 2) / at.depth;
        expect(px, `${dial}: a mark too thin to see`).toBeGreaterThanOrEqual(1.2);
      }
    }
  });

  it("numbers the airspeed dial every 20 knots from 40 and the altimeter 0 to 9, and draws the 150's arcs", () => {
    const size = slots.get("airspeed")!.w;
    expect(marks(drawTrainerAsi, size).texts).toEqual(expect.arrayContaining(["40", "60", "80", "100", "120", "140", "160", "KNOTS"]));
    expect(marks(drawTrainerAltimeter, size).texts).toEqual(expect.arrayContaining(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "ALT"]));
    const ctx = createRecordingContext();
    drawTrainerAsi(ctx, size, size, DISPLAY_STATE_LEVEL);
    const colours = ctx.calls.filter((c) => c.method === "set:strokeStyle").map((c) => c.args[0]);
    for (const colour of ["#1fa83a", "#e4c21c", "#e6e6e0", "#d22a2a"]) expect(colours, `the arc ${colour}`).toContain(colour);
    expect(TRAINER_ASI_MARKINGS.fullScale, "the page's scale is the needle's").toBe(160);
  });

  it("points each needle at the number it reads: 100 knots at the 100 mark, 500 feet at the 5, 2,500 RPM at the 25", () => {
    const size = slots.get("airspeed")!.w;
    const cases = [
      { dial: "airspeed", state: { airspeed: 100 / KNOTS_PER_METRE_PER_SECOND }, label: "100", page: drawTrainerAsi },
      { dial: "altimeter", state: { altitude: 500 / FEET_PER_METRE }, label: "5", page: drawTrainerAltimeter },
      { dial: "tach", state: { engineRpm: 2_500 }, label: "25", page: drawTrainerTach },
    ] as const;
    try {
      for (const c of cases) {
        aircraft.update({ ...INITIAL_VISUAL_STATE, ...c.state }, 1 / 60);
        const needle = named(`trainer-${c.dial}-needle`);
        needle.computeWorldMatrix(true);
        const hub = needle.getAbsolutePosition();
        // the pointer's end: past 0.02 m on the dials' needles, past 0.017 on the tachometer's, scaled with its face
        const far = worldVertices(needle).filter((v) => Vector3.Distance(v, hub) > (c.dial === "tach" ? 0.017 : 0.02));
        const tip = far.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / far.length);
        const ctx = createRecordingContext();
        c.page(ctx, size, size, DISPLAY_STATE_LEVEL);
        const numeral = transformedPoints(ctx.calls).find((p) => p.method === "fillText" && p.text === c.label)!;
        const onScreen = (p: Vector3) => projectPoint(pin, p);
        const [h, t, n] = [onScreen(hub), onScreen(tip), onScreen(onFace(c.dial, numeral.x, numeral.y, size))];
        const angle = (q: { x: number; y: number }) => Math.atan2(q.y - h.y, q.x - h.x);
        const miss = Math.abs(Math.atan2(Math.sin(angle(t) - angle(n)), Math.cos(angle(t) - angle(n)))) * DEG;
        expect(miss, `${c.dial}: the needle against its numeral ${c.label}, degrees on the screen`).toBeLessThan(2);
      }
    } finally {
      aircraft.update(INITIAL_VISUAL_STATE, 1 / 60);
    }
  });

  it("draws each radio's frequencies in the band its window samples, the label, the active and the standby apart", () => {
    const size = slots.get("com")!.w;
    const band = size / TRAINER_RADIO_WINDOW_ASPECT;
    for (const [page, expected] of [[drawTrainerCom, ["COM", "122.80", "121.50"]], [drawTrainerNav, ["NAV", "110.50", "113.90"]]] as const) {
      const ctx = createRecordingContext();
      page(ctx, size, size, DISPLAY_STATE_LEVEL);
      const texts = transformedPoints(ctx.calls).filter((p) => p.method === "fillText");
      expect(texts.map((p) => p.text)).toEqual(expected);
      for (const p of texts) expect(Math.abs(p.y - size / 2), `"${p.text}" in the window's band`).toBeLessThan(band / 2);
      // each text's extent across the slot at the monospace advance, from its own font and alignment as set before it:
      // the first live frame showed the active frequency run into the standby, which a check of the text alone passed
      const extents = texts.map((p) => {
        let px = 0;
        let align = "left";
        for (let i = p.index; i >= 0; i -= 1) {
          const call = ctx.calls[i]!;
          if (px === 0 && call.method === "set:font") px = Number(/(\d+)px/.exec(String(call.args[0]))![1]);
          if (align === "left" && call.method === "set:textAlign") align = String(call.args[0]);
        }
        const width = p.text!.length * TRAINER_RADIO_TEXT.monospaceAdvance * px;
        return align === "right" ? { from: p.x - width, to: p.x } : { from: p.x, to: p.x + width };
      });
      expect(extents[0]!.from, "the label inside the window").toBeGreaterThanOrEqual(0);
      expect(extents[1]!.from - extents[0]!.to, `${expected[0]}: the label clear of the active frequency, px`).toBeGreaterThanOrEqual(2);
      expect(extents[2]!.from - extents[1]!.to, `${expected[0]}: the active frequency clear of the standby, px`).toBeGreaterThanOrEqual(8);
      expect(extents[2]!.to, "the standby inside the window").toBeLessThanOrEqual(size);
    }
  });

  it("builds the radio stack: two units 160 x 40 mm, each with a window and two knobs, right of the dials, in the frame", () => {
    const fittings = named("trainer-panel-fittings");
    const merged = fittings.metadata?.mergedFrom as string[];
    for (const unit of TRAINER_RADIO.units) {
      expect(merged).toContain(`trainer-${unit}-body`);
      expect(merged).toEqual(expect.arrayContaining([`trainer-${unit}-knob-0`, `trainer-${unit}-knob-1`]));
    }
    const v = worldVertices(fittings);
    for (const { unit, frame } of trainerRadioFrames()) {
      const local = v.map((p) => p.subtract(frame.origin)).map((d) => ({ x: Vector3.Dot(d, frame.across), y: Vector3.Dot(d, frame.up), a: Vector3.Dot(d, frame.out) }));
      const body = local.filter((p) => Math.abs(p.x) <= 0.08 + 1e-6 && Math.abs(p.y) <= 0.02 + 1e-6 && p.a <= TRAINER_RADIO.proud + 1e-6 && p.a > 0);
      expect(Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)), `${unit}: 160 mm across`).toBeCloseTo(0.16, 4);
      expect(Math.max(...body.map((p) => p.y)) - Math.min(...body.map((p) => p.y)), `${unit}: 40 mm high`).toBeCloseTo(0.04, 4);
      const centre = projectPoint(pin, frame.origin);
      expect(centre.x, `${unit}: right of the dials`).toBeGreaterThan(projectPoint(pin, frameOf("altimeter").origin).x);
      for (const q of [centre, projectPoint(pin, frame.origin.add(frame.across.scale(0.08)))]) {
        expect(q.x).toBeLessThan(W);
        expect(q.y).toBeLessThan(H);
      }
    }
  });

  it("puts a row of four rocker switches under the dials, in the frame", () => {
    const merged = named("trainer-panel-fittings").metadata?.mergedFrom as string[];
    for (let k = 0; k < 4; k += 1) expect(merged).toEqual(expect.arrayContaining([`trainer-switch-${k}-base`, `trainer-switch-${k}-paddle`]));
    const frames = trainerSwitchFrames();
    expect(frames).toHaveLength(TRAINER_SWITCHES.across.length);
    const dialBottom = projectPoint(pin, frameOf("airspeed").origin.subtract(frameOf("airspeed").up.scale(0.04))).y;
    for (const frame of frames) {
      const q = projectPoint(pin, frame.origin.subtract(frame.up.scale(TRAINER_SWITCHES.base.halfHeight)));
      expect(q.y, "below the dials").toBeGreaterThan(dialBottom);
      expect(q.y, "in the frame").toBeLessThan(H);
    }
  });

  // ---- the tachometer and the engine cluster (S2b) ----
  /** A point's place in a frame's plane: across it, up it, and out of it toward the pilot. */
  const inFrame = (frame: ReturnType<typeof trainerTachFrame>) => (v: Vector3) => {
    const d = v.subtract(frame.origin);
    return { x: Vector3.Dot(d, frame.across), y: Vector3.Dot(d, frame.up), a: Vector3.Dot(d, frame.out) };
  };
  const clusterHalf = { x: TRAINER_ENGINE_CLUSTER_MM.width / 2_000, y: TRAINER_ENGINE_CLUSTER_MM.height / 2_000, bury: TRAINER_ENGINE_CLUSTER_MM.bury / 1_000 };

  it("rings the tachometer and the engine cluster on the dials' section, both smaller than the dials: 27 mm to their 34, and 125 x 30 mm", () => {
    expect(TRAINER_TACH.faceRadius).toBeLessThan(TRAINER_BEZEL.faceRadius);
    expect(2 * clusterHalf.y, "the cluster's height against a dial's diameter").toBeLessThan(2 * TRAINER_BEZEL.faceRadius);
    const bezels = worldVertices(named("trainer-dial-bezels"));
    const faces = worldVertices(named("trainer-dial-faces"));
    // the tachometer, round like the three
    const round = (v: Vector3) => {
      const p = inFrame(trainerTachFrame())(v);
      return { r: Math.hypot(p.x, p.y), a: p.a };
    };
    const ring = bezels.map(round).filter((p) => p.r < 0.04);
    expect(Math.min(...ring.map((p) => p.r)), "the tachometer's opening").toBeCloseTo(0.027, 5);
    expect(Math.max(...ring.map((p) => p.r)), "the tachometer's outside").toBeCloseTo(0.033, 5);
    expect(Math.max(...ring.map((p) => p.a)), "3 mm proud").toBeCloseTo(0.003, 5);
    const disc = faces.map(round).filter((p) => p.r < 0.04);
    expect(Math.max(...disc.map((p) => p.a)), "its face's front").toBeCloseTo(0.001, 5);
    expect(Math.max(...disc.map((p) => p.r)), "its face's edge under the ring").toBeGreaterThan(0.027);
    expect(Math.max(...disc.map((p) => p.r)), "its face's edge under the ring").toBeLessThan(0.027 + 0.006 - 0.002);
    // the cluster, a rounded rectangle in a ring of the same section
    const near = (p: { x: number; y: number; a: number }) => Math.abs(p.x) < clusterHalf.x + 0.012 && Math.abs(p.y) < clusterHalf.y + 0.015 && p.a > -0.01;
    const box = bezels.map(inFrame(trainerEngineClusterFrame())).filter(near);
    expect(Math.max(...box.map((p) => Math.abs(p.x))), "the ring's outside, across").toBeCloseTo(clusterHalf.x + 0.006, 5);
    expect(Math.max(...box.map((p) => Math.abs(p.y))), "the ring's outside, up").toBeCloseTo(clusterHalf.y + 0.006, 5);
    // the loop's straight runs have vertices only at its corners' ends: the opening's top is where the corners start
    expect(Math.min(...box.filter((p) => Math.abs(p.x) <= clusterHalf.x - TRAINER_ENGINE_CLUSTER.corner + 1e-6).map((p) => Math.abs(p.y))), "the ring's opening, up").toBeCloseTo(clusterHalf.y, 5);
    expect(Math.max(...box.map((p) => p.a)), "3 mm proud").toBeCloseTo(0.003, 5);
    const plate = faces.map(inFrame(trainerEngineClusterFrame())).filter(near);
    expect(Math.max(...plate.map((p) => p.a)), "the cluster's face's front").toBeCloseTo(0.001, 5);
    expect(Math.max(...plate.map((p) => Math.abs(p.x))), "its face's edge under the ring, across").toBeCloseTo(clusterHalf.x + clusterHalf.bury, 5);
    expect(Math.max(...plate.map((p) => Math.abs(p.y))), "its face's edge under the ring, up").toBeCloseTo(clusterHalf.y + clusterHalf.bury, 5);
  });

  it("keeps both apart from the main row, in the frame and in full view: the tachometer right of the radios and lower, the cluster under the stack", () => {
    const row = projectPoint(pin, frameOf("attitude").origin);
    const [com, nav] = trainerRadioFrames().map((unit) => unit.frame);
    const tach = trainerTachFrame();
    const cluster = trainerEngineClusterFrame();
    const tachLeft = projectPoint(pin, tach.origin.subtract(tach.across.scale(TRAINER_TACH.faceRadius + TRAINER_BEZEL.ringWidth)));
    expect(tachLeft.x, "the tachometer right of the radio stack").toBeGreaterThan(projectPoint(pin, com!.origin.add(com!.across.scale(TRAINER_RADIO.width / 2))).x);
    expect(projectPoint(pin, tach.origin).y, "the tachometer under the row's centre").toBeGreaterThan(row.y);
    const clusterTop = projectPoint(pin, cluster.origin.add(cluster.up.scale(clusterHalf.y + TRAINER_BEZEL.ringWidth)));
    expect(clusterTop.y, "the cluster under the radio stack").toBeGreaterThan(projectPoint(pin, nav!.origin.subtract(nav!.up.scale(TRAINER_RADIO.height / 2))).y);
    // in full view: over a grid on each face, the first surface the eye meets is the faces mesh (on the tachometer, or
    // its needle); the pilot's right horn stands in front of the board just left of the cluster
    const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const faces = meshes.indexOf(named("trainer-dial-faces"));
    const needle = meshes.indexOf(named("trainer-tach-needle"));
    const share = (frame: typeof tach, inside: (x: number, y: number) => boolean, allowed: number[]) => {
      let total = 0;
      let seen = 0;
      // a grid over the whole face: every sample the predicate keeps
      for (let x = -0.1; x <= 0.1; x += 0.002) {
        for (let y = -0.04; y <= 0.04; y += 0.002) {
          if (!inside(x, y)) continue;
          const q = projectPoint(pin, frame.origin.add(frame.across.scale(x)).add(frame.up.scale(y)).add(frame.out.scale(faceFront)));
          expect(q.x >= 0 && q.x < W && q.y >= 0 && q.y < H, "in the frame").toBe(true);
          total += 1;
          if (allowed.includes(raster.mesh[Math.floor(q.y) * W + Math.floor(q.x)]!)) seen += 1;
        }
      }
      expect(total).toBeGreaterThan(100);
      return seen / total;
    };
    expect(share(tach, (x, y) => Math.hypot(x, y) < TRAINER_TACH.faceRadius - 0.002, [faces, needle]), "the tachometer's face seen").toBeGreaterThan(0.99);
    expect(share(cluster, (x, y) => Math.abs(x) < clusterHalf.x - 0.002 && Math.abs(y) < clusterHalf.y - 0.002, [faces]), "the cluster's face seen").toBeGreaterThan(0.99);
  });

  it("maps the tachometer's face and the engine cluster's onto their own slots, the cluster onto its band", () => {
    const faces = named(TRAINER_DISPLAYS.screensMesh);
    const atlas = { w: displayAtlasWidth(TRAINER_DISPLAYS), h: displayAtlasHeight(TRAINER_DISPLAYS) };
    const positions = worldVertices(faces);
    const uvs = faces.getVerticesData(VertexBuffer.UVKind)!;
    const normals = faces.getVerticesData(VertexBuffer.NormalKind)!;
    const front = (frame: ReturnType<typeof trainerTachFrame>, near: (p: { x: number; y: number }) => boolean) =>
      positions.map((p, i) => ({ p: inFrame(frame)(p), i })).filter(({ p, i }) =>
        near(p) && Math.abs(p.a - faceFront) < 1e-5 && Vector3.Dot(new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!), frame.out) > 0.999);
    const tachSlot = slots.get("tach")!;
    const m = faceMapOf("tach");
    const tachFront = front(trainerTachFrame(), (p) => Math.hypot(p.x, p.y) < 0.03);
    expect(tachFront.length, "the tachometer's face's front").toBeGreaterThan(40);
    for (const { p, i } of tachFront) {
      expect(uvs[i * 2]! * atlas.w, "tachometer: u").toBeCloseTo(tachSlot.x + (p.x / (2 * m) + 0.5) * tachSlot.w, 3);
      expect(uvs[i * 2 + 1]! * atlas.h, "tachometer: v").toBeCloseTo(tachSlot.y + (0.5 - p.y / (2 * m)) * tachSlot.h, 3);
    }
    const slot = slots.get("engine")!;
    const half = { x: clusterHalf.x + clusterHalf.bury, y: clusterHalf.y + clusterHalf.bury };
    const { band } = trainerEngineBand(slot.w, slot.h);
    expect(band.h, "the band has the buried face's shape").toBeCloseTo((slot.w * half.y) / half.x, 6);
    const clusterFront = front(trainerEngineClusterFrame(), (p) => Math.abs(p.x) < half.x + 0.001 && Math.abs(p.y) < half.y + 0.001);
    expect(clusterFront.length, "the cluster's face's front").toBeGreaterThan(20);
    for (const { p, i } of clusterFront) {
      expect(uvs[i * 2]! * atlas.w, "cluster: u").toBeCloseTo(slot.x + (p.x / (2 * half.x) + 0.5) * slot.w, 3);
      expect(uvs[i * 2 + 1]! * atlas.h, "cluster: v").toBeCloseTo(slot.y + band.y + (0.5 - p.y / (2 * half.y)) * band.h, 3);
    }
  });

  it("numbers the tachometer in hundreds, 0 to 35, with the 150's green arc and a red line at the catalogue's maximum", () => {
    const size = slots.get("tach")!.w;
    expect(marks(drawTrainerTach, size).texts).toEqual(expect.arrayContaining(["0", "5", "10", "15", "20", "25", "30", "35", "RPM"]));
    const ctx = createRecordingContext();
    drawTrainerTach(ctx, size, size, DISPLAY_STATE_LEVEL);
    const colours = ctx.calls.filter((c) => c.method === "set:strokeStyle").map((c) => c.args[0]);
    for (const colour of ["#1fa83a", "#d22a2a"]) expect(colours, `the arc ${colour}`).toContain(colour);
    expect(TRAINER_TACH_MARKINGS.redLine, "the red line is the engine's maximum").toBe(aircraftSpec("trainer").engineReadout.maximum);
  });

  it("draws the engine cluster's four gauges, fuel L and R and oil T and P, inside the face the pilot sees", () => {
    const size = slots.get("engine")!.w;
    const { face } = trainerEngineBand(size, size);
    const ctx = createRecordingContext();
    drawTrainerEngine(ctx, size, size, DISPLAY_STATE_LEVEL);
    const points = transformedPoints(ctx.calls);
    expect(points.filter((p) => p.method === "fillText").map((p) => p.text)).toEqual(expect.arrayContaining(["FUEL", "OIL", "L", "R", "T", "P"]));
    const drawn = points.filter((p) => p.method === "moveTo" || p.method === "lineTo" || p.method === "fillText");
    expect(drawn.length).toBeGreaterThan(4 * 3);
    for (const p of drawn) {
      expect(p.x, `${p.method} inside the face, across`).toBeGreaterThanOrEqual(face.x - 0.5);
      expect(p.x).toBeLessThanOrEqual(face.x + face.w + 0.5);
      expect(p.y, `${p.method} inside the face, up`).toBeGreaterThanOrEqual(face.y - 0.5);
      expect(p.y).toBeLessThanOrEqual(face.y + face.h + 0.5);
    }
    expect(TRAINER_ENGINE_GAUGES.map((g) => g.letter)).toEqual(["L", "R", "T", "P"]);
  });

  it("leaves no more than 200,000 px of bare board at 1080p (it was 323,995; the PM's accept line)", () => {
    const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const board = meshes.indexOf(named("trainer-instrument-panel"));
    let px = 0;
    for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === board) px += 1;
    expect(px).toBeLessThanOrEqual(200_000);
    expect(px).toBeGreaterThan(150_000);
  });
});

/**
 * THE OVERHEAD (the Cessna pass, S4): the headliner and its header, the visors, the compass. Off the BUILT meshes, from
 * the left-seat eye at the 75 degree lens (1920 x 1080).
 */
describe("the Cessna's overhead", () => {
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
  const slots = new Map(displaySlots(TRAINER_DISPLAYS).map((slot) => [slot.screen, slot]));
  const pixelsOf = (meshes: AbstractMesh[], mesh: AbstractMesh) => {
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const index = meshes.indexOf(mesh);
    let n = 0;
    for (let i = 0; i < raster.mesh.length; i += 1) if (raster.mesh[i] === index) n += 1;
    return n;
  };

  it("shades every face of the pass's new parts toward its drawn side: no vertex normal points into its own solid", () => {
    // A normal turned inward (a concave fillet's taken as convex) shades that band as if lit from inside: a dark stripe
    // no hard-edge test sees, since the geometry is smooth. Every vertex against its triangle's drawn side (whose cross
    // product points INTO the solid): a round's normal is off its chord by half a chord's angle at most, never across it.
    for (const name of [
      "trainer-headliner", "trainer-panel-fittings", "trainer-dial-bezels", "trainer-dial-faces",
      "trainer-door-port", "trainer-a-pillar-port", "trainer-glareshield", "trainer-instrument-panel",
      "trainer-yokes", "trainer-compass-card", "trainer-compass-rim",
    ]) {
      const mesh = named(name);
      const v = worldVertices(mesh);
      // the normals in the world as the positions are: the compass's card (S7) turns with the heading
      const local = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const world = mesh.getWorldMatrix();
      const normals = Array.from({ length: local.length / 3 }, (_, i) => Vector3.TransformNormal(new Vector3(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!), world).normalize())
        .flatMap((n) => [n.x, n.y, n.z]);
      const indices = mesh.getIndices()!;
      let worst = 1;
      for (let t = 0; t < indices.length; t += 3) {
        const [i, j, k] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        const cross = Vector3.Cross(v[j]!.subtract(v[i]!), v[k]!.subtract(v[i]!));
        if (cross.length() < 1e-14) continue;
        const outward = cross.normalize().scale(-1);
        for (const vertex of [i, j, k]) {
          worst = Math.min(worst, Vector3.Dot(new Vector3(normals[vertex * 3]!, normals[vertex * 3 + 1]!, normals[vertex * 3 + 2]!), outward));
        }
      }
      expect(worst, `${name}: a vertex shaded into its own solid`).toBeGreaterThan(0);
    }
  });

  it("hides the roof slab from the pilot behind the headliner, and the check sees the slab without it", () => {
    const roof = named("trainer-cabin-roof");
    expect(pixelsOf(drawn(), roof), "roof slab pixels (its hard edges were three)").toBe(0);
    expect(pixelsOf(drawn().filter((m) => m.name !== "trainer-headliner"), roof)).toBeGreaterThan(50_000);
  });

  it("keeps the windscreen's top at +13.25 degrees straight ahead: the header's round stands 12 mm under the ceiling, not a bar hung under it", () => {
    // straight ahead, the first elevation up from the horizon at which the headliner is the nearest surface
    let top: number | null = null;
    for (let el = 0; el <= 25; el += 0.05) {
      if (firstHit(0, el)?.mesh.name === "trainer-headliner") { top = el; break; }
    }
    expect(top, "the headliner straight ahead").not.toBeNull();
    // it was +14.0, the roof slab's bare edge; a 5 cm bar hung under that edge would read about +8
    expect(top!).toBeGreaterThan(12.8);
    expect(top!).toBeLessThan(13.6);
  });

  it("draws the header's lower outline as a fair curve at 1080p: within 1 px of a local quadratic wherever it meets the glass", () => {
    // The PM's caution from the 747: a bar laid on an uneven surface inherits its lumps. The outline is the header's
    // lowest row in each column that starts in the headliner and meets open glass under it (nothing drawn), so the
    // centre strip, the compass and the pillar, which meet it elsewhere, do not count. The visors are merged into the
    // headliner's mesh, and at the port corner the port visor's straight front edge (x 1.565) is lower on the screen
    // than the header curving aft over it: the header's own outline is where that lowest point is forward of the
    // visors, read off the raster's depth (along +x on this level lens).
    const meshes = drawn();
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const lining = meshes.indexOf(named("trainer-headliner"));
    const outline: { x: number; y: number }[] = [];
    for (let x = 0; x < W; x += 1) {
      if (raster.mesh[x] !== lining) continue;
      let y = 0;
      while (y + 1 < H && raster.mesh[(y + 1) * W + x] === lining) y += 1;
      if (y + 1 >= H || raster.mesh[(y + 1) * W + x] !== -1) continue;
      if (EYE.forward + raster.depth[y * W + x]! < TRAINER_OVERHEAD.visor.frontX + 0.01) continue;
      outline.push({ x, y: y + 0.5 });
    }
    expect(outline.length, "columns where the header meets the glass").toBeGreaterThan(600);
    /** Each point's distance from the least-squares quadratic through the points within 40 columns of it; the worst. */
    const unfairness = (points: readonly { x: number; y: number }[]) => {
      let worst = 0;
      for (const p of points) {
        const near = points.filter((q) => Math.abs(q.x - p.x) <= 40);
        if (near.length < 40) continue;
        // the normal equations of y = a + b t + c t^2, t = x - p.x, solved by Cramer's rule; a is the fit at p
        const S = [0, 1, 2, 3, 4].map((k) => near.reduce((sum, q) => sum + (q.x - p.x) ** k, 0));
        const Y = [0, 1, 2].map((k) => near.reduce((sum, q) => sum + q.y * (q.x - p.x) ** k, 0));
        const det3 = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!)
          - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!)
          + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
        const M = [[S[0]!, S[1]!, S[2]!], [S[1]!, S[2]!, S[3]!], [S[2]!, S[3]!, S[4]!]];
        const a = det3([[Y[0]!, S[1]!, S[2]!], [Y[1]!, S[2]!, S[3]!], [Y[2]!, S[3]!, S[4]!]]) / det3(M);
        worst = Math.max(worst, Math.abs(p.y - a));
      }
      return worst;
    };
    expect(unfairness(outline), "the header's outline off a local quadratic, px").toBeLessThanOrEqual(1);
    // CONTROL: the same outline with a lump 3 px deep and 12 columns wide in its middle is caught
    const middle = outline[outline.length >> 1]!.x;
    expect(unfairness(outline.map((p) => ({ x: p.x, y: p.y + (Math.abs(p.x - middle) < 6 ? 3 : 0) })))).toBeGreaterThan(1);
  });

  it("stows two visors 300 x 120 x 8 mm under the ceiling behind the header, their fronts at about +14 degrees straight ahead", () => {
    const merged = named("trainer-headliner").metadata?.mergedFrom as string[];
    expect(merged).toEqual(["trainer-headliner-lining", "trainer-visor-port", "trainer-visor-starboard"]);
    // the port visor, rebuilt alone from its constants' mesh name, measured off the merged mesh by region
    const v = worldVertices(named("trainer-headliner"));
    const o = TRAINER_OVERHEAD.visor;
    // its inner part, clear of the headliner's side rim (its fillet starts 5 cm in from the side), which its outer end
    // runs under, and of the rim's corner, which begins at z -0.205 and whose concave fillet can reach in over the
    // visor's front (it did at 24 chords a corner: a vertex at z -0.234, 1 mm over the visor's top)
    const port = v.filter((p) => p.z < -o.gap / 2 && p.z > -0.2 && p.x <= o.frontX + 1e-6 && p.x >= o.frontX - o.depth - 1e-6 && p.y < 0.178);
    expect(Math.max(...port.map((p) => p.x)) - Math.min(...port.map((p) => p.x)), "120 mm deep").toBeCloseTo(o.depth, 4);
    expect(Math.max(...port.map((p) => p.y)) - Math.min(...port.map((p) => p.y)), "8 mm thick").toBeCloseTo(o.thickness, 4);
    // its front edge straight ahead of the eye (z at the eye's)
    const front = new Vector3(o.frontX, Math.min(...port.map((p) => p.y)), EYE.right);
    expect(azel(front).el).toBeGreaterThan(13.5);
    expect(azel(front).el).toBeLessThan(15.5);
    expect(firstHit(0, azel(front).el + 0.5)?.mesh.name, "the visor's underside is what the eye meets just over its front").toBe("trainer-headliner");
  });

  it("hangs the compass, a 60 x 46 x 70 mm box, just under the glass on a stalk up into the centre strip, in the frame over the windscreen", () => {
    const merged = named("trainer-panel-fittings").metadata?.mergedFrom as string[];
    expect(merged).toEqual(expect.arrayContaining(["trainer-compass", "trainer-compass-stalk"]));
    const c = TRAINER_OVERHEAD.compass;
    const centre = trainerCompassCentre();
    const box = worldVertices(named("trainer-panel-fittings")).filter((p) => Math.abs(p.x - centre.x) <= c.depth / 2 + 1e-6 && Math.abs(p.y - centre.y) <= c.height / 2 + 1e-6 && Math.abs(p.z) <= c.width / 2 + 1e-6);
    expect(Math.max(...box.map((p) => p.z)) - Math.min(...box.map((p) => p.z)), "60 mm across").toBeCloseTo(c.width, 4);
    expect(Math.max(...box.map((p) => p.y)) - Math.min(...box.map((p) => p.y)), "46 mm high (60 before S7)").toBeCloseTo(c.height, 4);
    expect(Math.max(...box.map((p) => p.x)) - Math.min(...box.map((p) => p.x)), "70 mm deep").toBeCloseTo(c.depth, 4);
    // in the frame, over the windscreen, right of dead ahead
    const q = projectPoint(pin, centre);
    expect(q.x).toBeGreaterThan(W / 2);
    expect(q.x).toBeLessThan(W);
    // its centre's elevation: +2.85 under the S4 crown member, +3.24 hung by the glass (S5), and higher since the box is
    // 46 mm high (S7), its top where it was; the survey placed it at +3.9 as a screen row
    expect(azel(centre).el, "its centre's elevation").toBeGreaterThan(3.5);
    // UNDER THE GLASS: its top 5 mm under the glass's crown over its front face. The strip it hangs from stands 7 mm
    // outside the glass there; hung from the strip's underside, the box would be 3 mm through it.
    const glassTop = (x: number) => {
      const i = TRAINER_CANOPY_SECTIONS.findIndex((section) => section.x >= x);
      const [low, high] = [TRAINER_CANOPY_SECTIONS[i - 1]!, TRAINER_CANOPY_SECTIONS[i]!];
      const top = (section: typeof low) => (section.yOffset ?? 0) + section.yRadius;
      return top(low) + ((top(high) - top(low)) * (x - low.x)) / (high.x - low.x);
    };
    const boxTop = Math.max(...box.map((p) => p.y));
    expect(glassTop(centre.x + c.depth / 2) - boxTop, "the box's top under the glass, metres").toBeGreaterThan(0.004);
    // the stalk's top, off the BUILT fittings (its vertices over the box, on its axis), is INSIDE the built centre frame:
    // the frame's top is over it and its underside under it
    const stalk = worldVertices(named("trainer-panel-fittings")).filter((p) => Math.abs(p.x - c.x) <= c.stalkRadius + 1e-6 && Math.abs(p.z) <= c.stalkRadius + 1e-6 && p.y > centre.y + c.height / 2);
    expect(stalk.length, "the stalk's vertices").toBeGreaterThan(8);
    const stalkTop = new Vector3(c.x, Math.max(...stalk.map((p) => p.y)), 0);
    const frame = named("windscreen-center-frame");
    const down = scene.pickWithRay(new Ray(stalkTop.add(new Vector3(0, 0.1, 0)), new Vector3(0, -1, 0), 0.2), (m) => m === frame);
    const up = scene.pickWithRay(new Ray(stalkTop.subtract(new Vector3(0, 0.1, 0)), new Vector3(0, 1, 0), 0.2), (m) => m === frame);
    expect(down?.pickedPoint?.y, "the frame's top over the stalk's top").toBeGreaterThan(stalkTop.y);
    expect(up?.pickedPoint?.y, "the frame's underside under the stalk's top").toBeLessThan(stalkTop.y);
  });

  // ---- the compass's face (S7) ----
  const compass = () => {
    const c = TRAINER_OVERHEAD.compass;
    const centre = trainerCompassCentre();
    return { c, centre, aft: centre.add(new Vector3(-c.depth / 2, 0, 0)) };
  };

  it("gives the compass a window in its aft face, ringed in the dials' section 8 mm inside the face, and a lubber line down it", () => {
    const { c, centre, aft } = compass();
    const w = c.window;
    // a mesh of its own on the bezels' rim, not in the dials' bezels: the HUD's footprint takes a bezels mesh as the deck
    const rimMesh = named("trainer-compass-rim");
    expect(rimMesh.metadata?.mergedFrom).toEqual(["trainer-compass-ring", "trainer-compass-lubber"]);
    expect(rimMesh.material, "on the dials' rim material").toBe(named("trainer-dial-bezels").material);
    expect(named("trainer-dial-bezels").metadata?.mergedFrom, "nothing of the compass in the dials' bezels").not.toEqual(expect.arrayContaining(["trainer-compass-ring"]));
    expect(w.corner, "the window's corners, round").toBeGreaterThanOrEqual(0.003);
    // the ring, off the built bezels mesh: its vertices on the box's aft face and forward of it, round the window
    const ring = worldVertices(rimMesh).filter((p) => Math.abs(p.x - aft.x - 0.006) < 0.0101 && Math.abs(p.z) < c.width / 2 && Math.abs(p.y - centre.y) < c.height / 2);
    expect(ring.length, "the ring's vertices").toBeGreaterThan(50);
    const outer = { z: Math.max(...ring.map((p) => Math.abs(p.z))), y: Math.max(...ring.map((p) => Math.abs(p.y - centre.y))) };
    expect(c.width / 2 - outer.z, "the ring inside the aft face, across, metres").toBeGreaterThanOrEqual(0.003);
    expect(c.height / 2 - outer.y, "the ring inside the aft face, up, metres").toBeGreaterThanOrEqual(0.003);
    // the proud front of the ring round an opening 32 x 18 mm: its front vertices (3 mm out of the face) run from the
    // opening's edge, inside by the inner chamfer
    // (its straight runs have vertices only at their ends, where the corners start)
    const front = ring.filter((p) => Math.abs(p.x - (aft.x - TRAINER_BEZEL.proud)) < 1e-5);
    const sides = front.filter((p) => Math.abs(p.y - centre.y) <= w.halfHeight - w.corner + 1e-6);
    expect(sides.length, "the front's vertices along the opening's sides").toBeGreaterThanOrEqual(4);
    expect(Math.min(...sides.map((p) => Math.abs(p.z))), "the opening's half-width at the front").toBeCloseTo(w.halfWidth + TRAINER_BEZEL.innerChamfer, 5);
    // the lubber line: a rod down the window's middle, in front of the card's face and behind the box's
    const lubber = worldVertices(rimMesh).filter((p) => Math.abs(p.z) < c.lubber.width && Math.abs(p.y - centre.y) < w.halfHeight && p.x > aft.x + 0.003 && p.x < aft.x + c.drum.recess);
    // (its middle ring of 8; its ends are buried in the ring, above and below the window)
    expect(lubber.length, "the lubber line's vertices in the window").toBeGreaterThanOrEqual(8);
  });

  it("turns the card with the heading: N under the lubber line at 0, and 3, E, S, W and 33 at 30, 90, 180, 270 and 330", () => {
    const card = named("trainer-compass-card");
    expect(card.material, "the card is on the faces' material").toBe(named(TRAINER_DISPLAYS.screensMesh).material);
    const slot = slots.get("compass")!;
    const atlas = { w: displayAtlasWidth(TRAINER_DISPLAYS), h: displayAtlasHeight(TRAINER_DISPLAYS) };
    // the page's numerals, each with its row (0 the slot's top half, 1 its bottom) and x in the slot
    const ctx = createRecordingContext();
    drawTrainerCompassCard(ctx, slot.w, slot.h, DISPLAY_STATE_LEVEL);
    const labels = transformedPoints(ctx.calls).filter((p) => p.method === "fillText").map((p) => ({ text: p.text!, row: p.y < slot.h / 2 ? 0 : 1, x: p.x }));
    expect(labels.length).toBeGreaterThanOrEqual(12);
    const positions = card.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = card.getVerticesData(VertexBuffer.NormalKind)!;
    const uvs = card.getVerticesData(VertexBuffer.UVKind)!;
    try {
      for (const [heading, expected] of [[0, "N"], [30, "3"], [90, "E"], [180, "S"], [270, "W"], [330, "33"]] as const) {
        aircraft.update({ ...INITIAL_VISUAL_STATE, heading }, 1 / 60);
        card.computeWorldMatrix(true);
        const world = card.getWorldMatrix();
        // the card's side under the lubber line: its most-aft wall vertex (the lubber line is on the drum's aft line)
        let best = -1;
        let aftMost = Number.POSITIVE_INFINITY;
        for (let i = 0; i < positions.length / 3; i += 1) {
          // the wall's top rim: its v is its row's top, clear of the boundary between the rows its bottom rim sits on
          if (Math.abs(normals[i * 3 + 1]!) > 0.5 || positions[i * 3 + 1]! < 0) continue;
          const p = Vector3.TransformCoordinates(new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!), world);
          if (p.x < aftMost - 1e-9) { aftMost = p.x; best = i; }
        }
        const u = uvs[best * 2]! * atlas.w - slot.x;
        const row = uvs[best * 2 + 1]! * atlas.h - slot.y < slot.h / 2 ? 0 : 1;
        const nearest = labels.filter((l) => l.row === row).reduce((a, b) => (Math.abs(b.x - u) < Math.abs(a.x - u) ? b : a));
        expect(nearest.text, `heading ${heading}: under the lubber line`).toBe(expected);
        expect(Math.abs(nearest.x - u), `heading ${heading}: the numeral's offset from the lubber line, px of the slot`).toBeLessThan(2);
      }
    } finally {
      aircraft.update(INITIAL_VISUAL_STATE, 1 / 60);
    }
  });

  it("keeps the card inside the compass: every vertex within its walls, and from the seat seen only through the window", () => {
    const { c, centre, aft } = compass();
    const card = named("trainer-compass-card");
    for (const heading of [0, 45]) {
      aircraft.update({ ...INITIAL_VISUAL_STATE, heading }, 1 / 60);
      for (const p of worldVertices(card)) {
        expect(Math.abs(p.z - centre.z), "inside the box, across").toBeLessThan(c.width / 2 - 0.002);
        expect(Math.abs(p.y - centre.y), "inside the box, up").toBeLessThan(c.height / 2 - 0.002);
        expect(p.x, "behind the box's aft face").toBeGreaterThan(aft.x + 0.002);
        expect(p.x, "ahead of its front").toBeLessThan(aft.x + c.depth - 0.002);
      }
    }
    aircraft.update(INITIAL_VISUAL_STATE, 1 / 60);
    const meshes = drawn();
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const index = meshes.indexOf(card);
    const corners = [-1, 1].flatMap((sz) => [-1, 1].map((sy) => projectPoint(pin, aft.add(new Vector3(0, sy * c.window.halfHeight, sz * c.window.halfWidth)))));
    const box = { x0: Math.min(...corners.map((q) => q.x)) - 2, x1: Math.max(...corners.map((q) => q.x)) + 2, y0: Math.min(...corners.map((q) => q.y)) - 2, y1: Math.max(...corners.map((q) => q.y)) + 2 };
    let seen = 0;
    let outside = 0;
    for (let i = 0; i < raster.mesh.length; i += 1) {
      if (raster.mesh[i] !== index) continue;
      seen += 1;
      const [x, y] = [i % W, Math.floor(i / W)];
      if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) outside += 1;
    }
    expect(seen, "the card's pixels through the window").toBeGreaterThan(500);
    expect(outside, "card pixels outside the window's opening").toBe(0);
  });
});

/**
 * THE YOKES (the Cessna pass, S6): a ram's-horn wheel on a column for each seat, one mesh (`trainer-yokes`).
 *
 * The cockpit camera is fixed and level, and on type the pilot's horn tops stand at -24.7 degrees, 35 px under the
 * frame's bottom at 16:9: no yoke is seen. The PM's call: build on type, then raise 4 cm so the horn tops show.
 * What is held: each hub under its seat's eye, 0.32 m aft of the board, raised 4 cm from its height on type; the
 * pilot's two horn tops seen at least 15 px above the frame's bottom, and not without the raise; the horns 1.5 cm or
 * more off the door; the column into the board under the switch row, clear of it, and buried.
 */
describe("the Cessna's yokes", () => {
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
  const yokes = () => worldVertices(named("trainer-yokes"));
  /** The board's face at height y, straight ahead of the pilot's seat, off the BUILT board. */
  const boardFaceAt = (y: number) => {
    const board = named("trainer-instrument-panel");
    const hit = scene.pickWithRay(new Ray(new Vector3(1.5, y, EYE.right), new Vector3(1, 0, 0), 1), (m) => m === board);
    expect(hit?.pickedPoint, `the board ahead at y ${y}`).toBeTruthy();
    return hit!.pickedPoint!.x;
  };
  /** Each yoke's two horn tops: the highest vertex either side of its hub. */
  const hornTops = (side: -1 | 1) => {
    const own = yokes().filter((p) => Math.sign(p.z) === side);
    const hubZ = side * TRAINER_YOKE.hubZ;
    const top = (list: Vector3[]) => list.reduce((a, b) => (b.y > a.y ? b : a));
    return [top(own.filter((p) => p.z < hubZ)), top(own.filter((p) => p.z > hubZ))] as const;
  };

  it("builds a yoke for each seat, one mesh on a matte of its own: each hub under its eye, 0.32 m aft of the board, raised 4 cm", () => {
    const mesh = named("trainer-yokes");
    // matte (S7): on the fittings' glossy dark the horns carried a specular hot spot
    const material = mesh.material as PBRMaterial;
    expect(material.name).toBe("trainer-yoke");
    expect(material.roughness, "matte").toBeGreaterThanOrEqual(0.9);
    expect(material.metallic, "not metal").toBe(0);
    expect(mesh.metadata?.mergedFrom).toEqual([
      ...["port", "starboard"].flatMap((side) => ["wheel", "boss", "column", "collar"].map((part) => `trainer-yoke-${side}-${part}`)),
    ]);
    for (const side of [-1, 1] as const) {
      const [outboardOrInboard, other] = hornTops(side);
      // the hub is midway between its horns, under the seat's eye
      expect((outboardOrInboard.z + other.z) / 2, "the hub under the eye").toBeCloseTo(side * -EYE.right, 3);
      // the horn tops: the hub's height on type, the raise, and the horns' rise over the hub
      for (const top of [outboardOrInboard, other]) {
        expect(top.y, "a horn's top").toBeCloseTo(TRAINER_YOKE.hubY + TRAINER_YOKE.raise + TRAINER_YOKE.gripTop, 3);
      }
      expect(TRAINER_YOKE.raise, "the raise the PM asked for, stated in the finding").toBe(0.04);
      // 0.32 m aft of the board's face at the hub's height, read off the built board
      expect(boardFaceAt(TRAINER_YOKE.hubY + TRAINER_YOKE.raise) - outboardOrInboard.x, "aft of the board").toBeCloseTo(0.32, 3);
    }
  });

  it("shows the pilot both horn tops at least 15 px above the frame's bottom at 16:9, and neither without the 4 cm raise", () => {
    const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
    const index = meshes.indexOf(named("trainer-yokes"));
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const tops = hornTops(-1);
    for (const [label, top] of [["the outboard horn", tops[0]], ["the inboard horn", tops[1]]] as const) {
      // the highest row the yokes are SEEN at, within 40 px of the horn's top's column
      const column = Math.round(projectPoint(pin, top).x);
      let highest = H;
      for (let x = Math.max(0, column - 40); x <= Math.min(W - 1, column + 40); x += 1) {
        for (let y = 0; y < H; y += 1) {
          if (raster.mesh[y * W + x] === index) {
            highest = Math.min(highest, y);
            break;
          }
        }
      }
      expect(H - highest, `${label}'s top, px above the frame's bottom`).toBeGreaterThanOrEqual(15);
      // CONTROL: on type, 4 cm lower, the same top projects under the frame's bottom
      expect(projectPoint(pin, top.subtract(new Vector3(0, TRAINER_YOKE.raise, 0))).y, `${label} on type, row`).toBeGreaterThan(H);
    }
  });

  it("shapes each horn as a grip 22 mm across the view and 30 fore and aft, capped low, and no wider than 85 px at 1080p", () => {
    // S7, the PM: round 30 mm grips with hemispherical tops read as two domed bollards, about 105 px wide
    const y = TRAINER_YOKE;
    const hub = trainerYokeHub(-1);
    for (const gz of [hub.z - y.grip, hub.z + y.grip]) {
      const horn = yokes().filter((p) => Math.abs(p.z - gz) < 0.03 && p.y > hub.y + 0.02);
      const grip = horn.filter((p) => p.y < hub.y + 0.06);
      expect(Math.max(...grip.map((p) => Math.abs(p.z - gz))), "across the view").toBeCloseTo(y.gripHalfWidth, 5);
      expect(Math.max(...grip.map((p) => Math.abs(p.x - hub.x))), "fore and aft").toBeCloseTo(y.gripHalfDepth, 5);
      // the cap: from the highest vertex of the full section to the top, at most 0.4 of the half-width
      const top = Math.max(...horn.map((p) => p.y));
      const full = Math.max(...horn.filter((p) => Math.abs(p.z - gz) >= y.gripHalfWidth - 1e-5).map((p) => p.y));
      expect((top - full) / y.gripHalfWidth, "the cap's height over the half-width").toBeLessThanOrEqual(0.4);
      // (the cap's last ring is at 87 degrees, 5 microns under the ellipse's top)
      expect(top - hub.y, "the horn's top where it was").toBeCloseTo(y.gripTop, 4);
    }
    // on the screen: each horn's widest run of yoke pixels, over its rows in the frame
    const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0 && drawnByCockpitCamera(m));
    const raster = rasteriseClipped(pin, meshes, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const index = meshes.indexOf(named("trainer-yokes"));
    for (const top of hornTops(-1)) {
      const column = Math.round(projectPoint(pin, top).x);
      let widest = 0;
      for (let row = Math.ceil(projectPoint(pin, top).y); row < H; row += 1) {
        let run = 0;
        for (let x = Math.max(0, column - 80); x <= Math.min(W - 1, column + 80); x += 1) {
          run = raster.mesh[row * W + x] === index ? run + 1 : 0;
          widest = Math.max(widest, run);
        }
      }
      expect(widest, "a horn's width on the screen, px").toBeGreaterThan(40);
      expect(widest, "a horn's width on the screen, px").toBeLessThanOrEqual(85);
    }
  });

  it("keeps the pilot's horns 1.3 cm or more off the door's inner face", () => {
    // 1.64 cm with S6's hemispherical tops; 1.40 since the flatter caps (S7) keep the grip's full width to 4 mm under its
    // top, where the door's rail comes a centimetre inboard
    const door = named("trainer-door-port");
    let least = Number.POSITIVE_INFINITY;
    const outboard = yokes().filter((p) => p.z < -TRAINER_YOKE.hubZ - TRAINER_YOKE.grip + 0.02);
    expect(outboard.length, "the outboard horn's vertices").toBeGreaterThan(50);
    for (const p of outboard) {
      const hit = scene.pickWithRay(new Ray(new Vector3(p.x, p.y, EYE.right), new Vector3(0, 0, -1), 1), (m) => m === door);
      if (hit?.pickedPoint) least = Math.min(least, p.z - hit.pickedPoint.z);
    }
    expect(least, "least gap to the door, metres").toBeGreaterThan(0.013);
  });

  it("brings each column into the board under the switch row, clear of it and of the dials, and buries it there", () => {
    // Level at the raised hub's height a column would pass between the airspeed's and the attitude's bezels; level at
    // the height on type, through the switches. So it falls forward to enter under them.
    const switchesBottom = Math.min(...trainerSwitchFrames().map((frame) => frame.origin.y)) - TRAINER_SWITCHES.base.halfHeight;
    const face = boardFaceAt(TRAINER_YOKE.column.entryY);
    const nearBoard = yokes().filter((p) => p.x > face - 0.03);
    expect(nearBoard.length, "the collars' and columns' vertices by the board").toBeGreaterThan(50);
    // (the collars' rounded aft rims are the highest, 9.9 mm under the switches' bases)
    expect(Math.max(...nearBoard.map((p) => p.y)), "the highest of them, under the switch row by 5 mm").toBeLessThan(switchesBottom - 0.005);
    // BURIED: each column's end and its collar's, one plane square to the column, is behind the board's face at every
    // vertex's own height and place -- 6 mm or more, past the census's depth tolerance there
    const board = named("trainer-instrument-panel");
    for (const side of [-1, 1] as const) {
      const hub = trainerYokeHub(side);
      const along = new Vector3(boardFaceAt(TRAINER_YOKE.column.entryY), TRAINER_YOKE.column.entryY, hub.z).subtract(hub).normalize();
      const own = yokes().filter((p) => Math.sign(p.z) === side);
      const reach = Math.max(...own.map((p) => Vector3.Dot(p.subtract(hub), along)));
      const end = own.filter((p) => Vector3.Dot(p.subtract(hub), along) > reach - 1e-4);
      expect(end.length, "the end ring's vertices").toBeGreaterThanOrEqual(20);
      let shallowest = Number.POSITIVE_INFINITY;
      for (const p of end) {
        const hit = scene.pickWithRay(new Ray(new Vector3(p.x - 0.2, p.y, p.z), new Vector3(1, 0, 0), 0.4), (m) => m === board);
        expect(hit?.pickedPoint, "the board over the end").toBeTruthy();
        shallowest = Math.min(shallowest, p.x - hit!.pickedPoint!.x);
      }
      expect(shallowest, "the end's least depth behind the board's face, metres").toBeGreaterThan(0.006);
    }
  });
});
