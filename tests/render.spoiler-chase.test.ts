import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import {
  boundingRect,
  planeAngleDegrees,
  planeNormal,
  rasterise,
  worldVertices,
  type Pinhole,
} from "./support/drawnFaceRaster";

/**
 * The spoilers AS THE CHASE CAMERA SEES THEM (Jason, 2026-09-23: "the spoilers
 * don't activate when the brake is applied for the 747").
 *
 * They did activate; the pose and the panels were right. What was wrong was
 * what reached the screen from the 747's chase camera, 112 m back and 34 m up:
 * a raised panel showed the same white wing beneath it that it had lain on, so
 * the whole deployment was a few pixels of changed shading. So this measures
 * with a camera, not with a vertex buffer: a double-precision z-buffer over
 * the faces the GPU draws (`support/drawnFaceRaster`), at the renderer's own
 * chase pose.
 *
 * - THE PANEL'S ANGLE BY RAY: the plane through the points the camera's rays
 *   actually meet on a raised panel, against the plane of the same panel
 *   stowed. It must be the deployment the pose asked for.
 * - THE BAY: deployed, the camera sees the dark bay under the panels; STOWED
 *   it sees none of it, from the chase and from a grazing sweep -- the null.
 * - THE GLOBAL: its inboard ground spoiler stays stowed in the air while the
 *   multi-function panels stand up as the speed brake, and all go on the ground.
 * - CONTROLS: the rasteriser draws a box from outside and nothing from inside
 *   it, and the plane fit returns a known tilt.
 */

/**
 * TWICE a 1600 x 1000 frame's density, at the same pose: the speed brake at 25
 * degrees is within 8 degrees of edge-on to the 747's chase sightline, and at
 * 1600 x 1000 a plate that thin is 18 broad-face pixels. The fit is already
 * right there (24.9) and converges by this density (25.0, and the same at five
 * times it); this is headroom, not a different camera.
 */
const WIDTH = 3200;
const HEIGHT = 2000;

const fixtures: Array<{ engine: NullEngine; scene: Scene; visual?: AircraftVisual }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.visual?.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

function scene(): Scene {
  const engine = new NullEngine();
  const created = new Scene(engine);
  created.useRightHandedSystem = true;
  fixtures.push({ engine, scene: created });
  return created;
}

function airframe(kind: "airliner" | "bizjet") {
  const built = scene();
  const visual = createWebGpuAircraft(built, kind);
  fixtures[fixtures.length - 1]!.visual = visual;
  visual.setCockpitView(false);
  const drawn = () => built.meshes.filter((mesh) =>
    mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0);
  const mesh = (name: string) => {
    const found = built.getMeshByName(name);
    if (!found) throw new Error(`no mesh ${name}`);
    return found;
  };
  return { scene: built, visual, drawn, mesh };
}

/** The renderer's chase pose, wings level, in the body frame (`chaseRigOffsetsToRef` at zero trail). */
function chase(kind: "airliner" | "bizjet", airspeed: number): Pinhole {
  const profile = chaseCameraProfile(kind, airspeed);
  return {
    eye: new Vector3(-profile.distance, profile.height, 0),
    target: new Vector3(profile.aimAhead, 1.25, 0),
    up: new Vector3(0, 1, 0),
    fovY: (profile.fieldOfView * Math.PI) / 180,
    width: WIDTH,
    height: HEIGHT,
  };
}

function state(overrides: Partial<FlightVisualState>): FlightVisualState {
  const onGround = overrides.onGround ?? false;
  return {
    ...INITIAL_VISUAL_STATE,
    altitudeAgl: onGround ? 0 : 900,
    altitude: onGround ? 5 : 900,
    airspeed: onGround ? 60 : 120,
    gear: onGround ? 1 : 0,
    ...overrides,
  };
}

/** The panel's plane from the camera's hits on it, against its stowed plane from its own vertices. */
function seenDeployment(
  camera: Pinhole,
  drawn: AbstractMesh[],
  panel: AbstractMesh,
  stowedNormal: Vector3,
): { degrees: number; pixels: number } {
  const shot = rasterise(camera, drawn, boundingRect(camera, worldVertices(panel), 4));
  const pixels = shot.pixelsOf(panel, true);
  if (pixels.length < 12) return { degrees: Number.NaN, pixels: pixels.length };
  return { degrees: planeAngleDegrees(planeNormal(pixels.map((i) => shot.point(i))), stowedNormal), pixels: pixels.length };
}

const DEGREES = 180 / Math.PI;

/**
 * The deployments DECIDED, as literals rather than read back from
 * `SPOILER_TRAVEL`: a test comparing the panels with the table they are posed
 * from passes whatever the table says. The 747's 60 degrees full and 25 degree
 * flight speed brake are the type's figures in round numbers (PM, 2026-09-23);
 * the Global keeps the 0.68 rad its panels always had, on the ground only, and
 * takes the same 25 degree speed brake in the air.
 */
const DECIDED = {
  airliner: { full: 60, speedBrake: 25 },
  bizjet: { full: 0.68 * DEGREES, speedBrake: 25 },
} as const;

describe("the rasteriser and the plane fit", () => {
  it("draw a box from outside and nothing from inside it", () => {
    const box = CreateBox("control-box", { size: 1 }, scene());
    box.position.set(10, -5, 0);
    const outside: Pinhole = { eye: Vector3.Zero(), target: new Vector3(10, -5, 0), up: Vector3.Up(), fovY: 0.5, width: 400, height: 400 };
    const inside: Pinhole = { ...outside, eye: new Vector3(10, -5, 0.01), target: new Vector3(20, -5, 0) };
    const rect = { x0: 0, y0: 0, x1: 399, y1: 399 };
    expect(rasterise(outside, [box], rect).pixelsOf(box).length).toBeGreaterThan(1000);
    expect(rasterise(inside, [box], rect).pixelsOf(box).length).toBe(0);
  });

  it("returns a known tilt from the points the rays meet", () => {
    const box = CreateBox("tilted-plate", { width: 3, height: 0.05, depth: 2 }, scene());
    box.position.set(0, 0, 0);
    box.rotation.z = 0.7;
    const camera: Pinhole = { eye: new Vector3(-8, 6, 1), target: Vector3.Zero(), up: Vector3.Up(), fovY: 0.6, width: 800, height: 800 };
    const angle = seenDeployment(camera, [box], box, new Vector3(0, 1, 0));
    expect(angle.pixels).toBeGreaterThan(1000);
    expect(Math.abs(angle.degrees - 0.7 * DEGREES)).toBeLessThan(0.05);
  });
});

describe("the 747's spoilers at the chase pose", () => {
  const travel = DECIDED.airliner;

  it("stand at the deployment the pose asks for, read off the camera's own rays", () => {
    const { visual, drawn, mesh } = airframe("airliner");
    const ground = mesh("starboard-airliner-ground-spoilers-surface");
    const flight = mesh("starboard-airliner-flight-spoilers-surface");
    visual.update(state({ onGround: true }), 1 / 60);
    const stowed = { ground: planeNormal(worldVertices(ground)), flight: planeNormal(worldVertices(flight)) };

    // On the runway with the ground spoilers out: every panel at full.
    visual.update(state({ onGround: true, brake: 1, groundSpoilers: 1 }), 1 / 60);
    const onRunway = chase("airliner", 60);
    const groundSeen = seenDeployment(onRunway, drawn(), ground, stowed.ground);
    const flightSeen = seenDeployment(onRunway, drawn(), flight, stowed.flight);
    expect(Math.abs(groundSeen.degrees - travel.full), `ground, ${groundSeen.pixels} px`).toBeLessThan(1);
    expect(Math.abs(flightSeen.degrees - travel.full), `flight, ${flightSeen.pixels} px`).toBeLessThan(1);

    // Airborne with the brake: the flight panels as the speed brake, the ground panels stowed.
    visual.update(state({ brake: 1 }), 1 / 60);
    const inFlight = chase("airliner", 120);
    const speedBrake = seenDeployment(inFlight, drawn(), flight, stowed.flight);
    expect(Math.abs(speedBrake.degrees - travel.speedBrake), `speed brake, ${speedBrake.pixels} px`).toBeLessThan(1);
    expect(planeAngleDegrees(planeNormal(worldVertices(ground)), stowed.ground)).toBeLessThan(1e-6);
  });

  it("uncovers the dark bay when deployed, and shows NONE of it stowed, from the chase or a grazing sweep", () => {
    const { visual, drawn, mesh } = airframe("airliner");
    const bays = mesh("airliner-spoiler-bays");
    const everyPanel = ["starboard", "port"].flatMap((side) =>
      ["ground", "flight"].map((group) => mesh(`${side}-airliner-${group}-spoilers-surface`)));
    const panelPoints = () => everyPanel.flatMap((panel) => worldVertices(panel));
    const baysSeen = (camera: Pinhole) =>
      rasterise(camera, drawn(), boundingRect(camera, [...panelPoints(), ...worldVertices(bays)], 4)).pixelsOf(bays).length;

    visual.update(state({ onGround: true, brake: 1, groundSpoilers: 1 }), 1 / 60);
    // 2958 px of a 3200 x 2000 frame when this was written.
    expect(baysSeen(chase("airliner", 60)), "the bays under the raised panels").toBeGreaterThan(1500);

    // THE NULL: stowed, the panels cover their bays from every direction. A grazing sweep round the
    // starboard wing at 2 degrees over the skin as well as the chase, because a bay showing at its rim
    // would show there first.
    visual.update(state({ onGround: true }), 1 / 60);
    expect(baysSeen(chase("airliner", 60))).toBe(0);
    const wing = new Vector3(-8, 3.2, 14);
    for (const azimuth of [0, 60, 120, 180, 240, 300]) {
      for (const elevation of [2, 20, 70]) {
        const a = (azimuth * Math.PI) / 180; const e = (elevation * Math.PI) / 180;
        const eye = wing.add(new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).scale(30));
        const camera: Pinhole = { eye, target: wing, up: Vector3.Up(), fovY: 1, width: 800, height: 600 };
        expect(baysSeen(camera), `azimuth ${azimuth}, elevation ${elevation}`).toBe(0);
      }
    }
  });
});

describe("the Global's spoilers at the chase pose", () => {
  const travel = DECIDED.bizjet;

  it("keep the inboard ground spoiler stowed in the air while the multi-function panels are the speed brake, and raise all four on the ground", () => {
    const { visual, drawn, mesh } = airframe("bizjet");
    const ground = mesh("starboard-bizjet-ground-spoiler-surface");
    const multi = ["one", "two", "three"].map((n) => mesh(`starboard-bizjet-${n}-spoiler-surface`));
    visual.update(state({ onGround: true }), 1 / 60);
    const stowedNormal = (panel: AbstractMesh) => planeNormal(worldVertices(panel));
    const stowed = new Map([ground, ...multi].map((panel) => [panel, stowedNormal(panel)]));

    visual.update(state({ brake: 1 }), 1 / 60);
    const inFlight = chase("bizjet", 120);
    expect(ground.isEnabled(), "the ground spoiler is switched off in the air").toBe(false);
    for (const panel of multi) {
      const seen = seenDeployment(inFlight, drawn(), panel, stowed.get(panel)!);
      expect(Math.abs(seen.degrees - travel.speedBrake), `${panel.name}, ${seen.pixels} px`).toBeLessThan(1);
    }

    visual.update(state({ onGround: true, brake: 1, groundSpoilers: 1 }), 1 / 60);
    const onRunway = chase("bizjet", 60);
    for (const panel of [ground, ...multi]) {
      const seen = seenDeployment(onRunway, drawn(), panel, stowed.get(panel)!);
      expect(Math.abs(seen.degrees - travel.full), `${panel.name}, ${seen.pixels} px`).toBeLessThan(1);
    }
  });
});
