import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import type { AircraftVisual } from "../src/render/webgpu/aircraft/types";
import type { AircraftKind } from "../src/sim";
import { Hud } from "../src/ui/Hud";
import {
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  clockAngleDegrees,
  createCockpitTestEngine,
  pointCockpitCamera,
  project,
  turnedClockwise,
} from "./support/cockpitProjection";
import { flyAt } from "./support/visualStateFromSimulator";

/**
 * THE INSTRUMENTS MOVE, and every one moves the right way ROUND, held to what the
 * pilot sees.
 *
 * A needle's sign is a statement about the picture, and a test that measures an
 * angle in a frame of its own passes while every needle runs backwards: a dial's
 * normal points TOWARD the pilot, so a positive right-handed rotation about it is
 * ANTI-clockwise to him. So the direction is asserted in SCREEN space: each needle
 * (its hub and its tip) is projected through the cockpit camera the renderer uses
 * (`tests/support/cockpitProjection.ts`, built from the renderer's own rig
 * function), at two readings, and the tip must have moved CLOCKWISE (see
 * `turnedClockwise` for the y-down convention). The attitude ball is held to the
 * WORLD horizon projected through the same camera.
 *
 * The angle-in/angle-out arithmetic is tested too, in the dial's own plane, with
 * the expected angles written here as literals (the PM's mappings), not read from
 * the module under test. Each reading is also held to the number the 2D HUD
 * renders for the same state, which is the number the player already trusts.
 *
 * Every state the visual and the HUD see is ONE object, so the comparison is of
 * the same frame; live the two differ by up to about 75 ms plus the presentation
 * delay, which is why this is a unit test.
 */

const KNOTS = 1.94384;
const FEET = 3.28084;
const FPM = 196.85;

function stateWith(overrides: Partial<FlightVisualState>): FlightVisualState {
  return { ...INITIAL_VISUAL_STATE, ...overrides };
}
function worldVertices(mesh: AbstractMesh): Vector3[] {
  mesh.computeWorldMatrix(true);
  const data = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}
/** Difference of two angles in degrees, on the circle. */
function angleDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
function renderHud(state: FlightVisualState, aircraft: AircraftKind): string {
  return renderToStaticMarkup(createElement(Hud, {
    state,
    aircraft,
    mode: "full",
    flightMode: "unassisted",
    // The dials are in fixed aviation units whatever the setting; the reference is the HUD in aviation units.
    units: "aviation",
    diagnostics: null,
    showDiagnostics: false,
    cameraMode: "cockpit",
    cameraLabel: "COCKPIT",
    seedLabel: "INSTR1",
    mouseFlight: false,
  }));
}

interface Fixture {
  engine: NullEngine;
  scene: Scene;
  camera: UniversalCamera;
  aircraft: AircraftVisual;
  mesh(name: string): AbstractMesh;
}
function buildFixture(kind: AircraftKind, cockpitView = true): Fixture {
  const engine = createCockpitTestEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("cockpit-test-camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const aircraft = createWebGpuAircraft(scene, kind);
  aircraft.root.rotationQuaternion = aircraft.root.rotationQuaternion ?? Quaternion.Identity();
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(cockpitView);
  pointCockpitCamera(camera, kind, Vector3.Zero(), Quaternion.Identity());
  return {
    engine,
    scene,
    camera,
    aircraft,
    mesh(name) {
      const found = scene.getMeshByName(name);
      if (!found) throw new Error(`missing mesh ${name}`);
      return found;
    },
  };
}
function disposeFixture(fixture: Fixture): void {
  fixture.aircraft.dispose();
  fixture.scene.dispose();
  fixture.engine.dispose();
}

// ---- the tools these tests stand on: they get their own checks first ---------------------

describe("the projection and the clockwise test these tests stand on", () => {
  let fixture: Fixture;
  beforeAll(() => { fixture = buildFixture("trainer"); });
  afterAll(() => disposeFixture(fixture));

  it("draws starboard on the right, up toward the top, and y grows DOWNWARD", () => {
    const eye = fixture.camera.position;
    const ahead = project(fixture.camera, eye.add(new Vector3(10, 0, 0)));
    const starboard = project(fixture.camera, eye.add(new Vector3(10, 0, 2)));
    const above = project(fixture.camera, eye.add(new Vector3(10, 2, 0)));
    expect(ahead.x).toBeCloseTo(SCREEN_WIDTH / 2, 0);
    expect(ahead.y).toBeCloseTo(SCREEN_HEIGHT / 2, 0);
    expect(starboard.x).toBeGreaterThan(ahead.x + 50);
    expect(above.y).toBeLessThan(ahead.y - 50);
    expect(ahead.depth).toBeCloseTo(10, 6);
  });

  it("calls 12 o'clock to 3 o'clock clockwise (y down: a POSITIVE cross product), and the reverse not", () => {
    const twelve = { x: 0, y: -1 };
    const three = { x: 1, y: 0 };
    const six = { x: 0, y: 1 };
    const nine = { x: -1, y: 0 };
    expect(turnedClockwise(twelve, three)).toBe(true);
    expect(turnedClockwise(three, six)).toBe(true);
    expect(turnedClockwise(six, nine)).toBe(true);
    expect(turnedClockwise(nine, twelve)).toBe(true);
    expect(turnedClockwise(three, twelve)).toBe(false);
    expect(clockAngleDegrees(twelve)).toBeCloseTo(0, 9);
    expect(clockAngleDegrees(three)).toBeCloseTo(90, 9);
    expect(Math.abs(clockAngleDegrees(six))).toBeCloseTo(180, 9);
    expect(clockAngleDegrees(nine)).toBeCloseTo(-90, 9);
  });
});

// ---- the Cessna's needles ------------------------------------------------------------------

describe("the Cessna's needles", () => {
  let fixture: Fixture;

  /** The dial's own plane, from the BUILT panel: the normal toward the pilot, up the face, and the pilot's right. */
  function dialPlane(): { normal: Vector3; up: Vector3; right: Vector3 } {
    const panel = fixture.mesh("trainer-instrument-panel");
    panel.computeWorldMatrix(true);
    const normal = Vector3.TransformNormal(new Vector3(-1, 0, 0), panel.getWorldMatrix()).normalize();
    const up = Vector3.TransformNormal(new Vector3(0, 1, 0), panel.getWorldMatrix()).normalize();
    // The pilot looks along -normal; right = forward x up in this codebase's right-handed frame.
    const right = Vector3.Cross(normal.scale(-1), up).normalize();
    return { normal, up, right };
  }
  function needle(dial: string): { mesh: AbstractMesh; hub: Vector3; tip: Vector3 } {
    const mesh = fixture.mesh(`trainer-${dial}-needle`);
    mesh.computeWorldMatrix(true);
    const hub = mesh.getAbsolutePosition().clone();
    // The TIP is the centre of the pointer's end face, not its farthest corner (a corner is 1.5 mm to one side of the
    // needle's axis, which is 3 degrees at this length): the mean of the vertices out at the far end.
    const far = worldVertices(mesh).filter((v) => Vector3.Distance(v, hub) > 0.02);
    expect(far.length, `${dial} needle's pointer end`).toBeGreaterThanOrEqual(4);
    const tip = far.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / far.length);
    return { mesh, hub, tip };
  }
  /** Clockwise degrees from 12 o'clock as the pilot sees the dial, measured IN the dial's plane (no perspective). */
  function planeAngle(dial: string): number {
    const { hub, tip } = needle(dial);
    const { up, right } = dialPlane();
    const v = tip.subtract(hub);
    return (Math.atan2(Vector3.Dot(v, right), Vector3.Dot(v, up)) * 180) / Math.PI;
  }
  /** The hub-to-tip vector on the SCREEN, pixels, y down. */
  function screenVector(dial: string): { x: number; y: number } {
    const { hub, tip } = needle(dial);
    const a = project(fixture.camera, hub);
    const b = project(fixture.camera, tip);
    expect(a.depth, `${dial} hub is in front of the eye`).toBeGreaterThan(0.1);
    return { x: b.x - a.x, y: b.y - a.y };
  }
  function show(state: Partial<FlightVisualState>): void {
    fixture.aircraft.update(stateWith(state), 1 / 60);
    for (const mesh of fixture.scene.meshes) mesh.computeWorldMatrix(true);
  }

  beforeAll(() => { fixture = buildFixture("trainer"); });
  afterAll(() => disposeFixture(fixture));

  it("has each needle's origin on its gauge's centre, with local X the dial's normal, before and after it turns", () => {
    const { normal } = dialPlane();
    for (const dial of ["airspeed", "altimeter", "vertical-speed", "engine"]) {
      const gauge = fixture.mesh(`trainer-${dial}-gauge`).getBoundingInfo().boundingBox.centerWorld;
      for (const readings of [{}, { airspeed: 70, altitude: 900, verticalSpeed: -3, engineRpm: 2300 }]) {
        show(readings);
        const { mesh, hub } = needle(dial);
        // 1 mm: the origin is the gauge's centre, where a needle turns about
        expect(Vector3.Distance(hub, gauge), `${dial}: needle origin against its gauge's centre`).toBeLessThan(1e-3);
        const localX = Vector3.TransformNormal(new Vector3(1, 0, 0), mesh.getWorldMatrix()).normalize();
        expect(Vector3.Dot(localX, normal), `${dial}: needle local X against the dial's normal`).toBeGreaterThan(0.99999);
      }
    }
  });

  it("points every needle at 12 o'clock before anything turns it (a fresh aircraft, no update yet)", () => {
    const fresh = buildFixture("trainer");
    try {
      const panel = fresh.mesh("trainer-instrument-panel");
      const up = Vector3.TransformNormal(new Vector3(0, 1, 0), panel.getWorldMatrix()).normalize();
      const normal = Vector3.TransformNormal(new Vector3(-1, 0, 0), panel.getWorldMatrix()).normalize();
      for (const dial of ["airspeed", "altimeter", "vertical-speed", "engine"]) {
        const mesh = fresh.mesh(`trainer-${dial}-needle`);
        const hub = mesh.getAbsolutePosition();
        const far = worldVertices(mesh).filter((v) => Vector3.Distance(v, hub) > 0.02);
        const tip = far.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / far.length);
        const v = tip.subtract(hub);
        // in the dial's plane the pointer is straight up the face; out of it, it stands 4.5 mm in front of the origin
        expect(Vector3.Dot(v, up), `${dial}: pointer length up the face`).toBeCloseTo(0.028, 4);
        expect(Vector3.Dot(v, normal), `${dial}: stands in front of its origin, toward the pilot`).toBeCloseTo(0.0045, 4);
        const across = v.subtract(up.scale(Vector3.Dot(v, up))).subtract(normal.scale(Vector3.Dot(v, normal)));
        expect(across.length(), `${dial}: no sideways component`).toBeLessThan(1e-6);
      }
    } finally {
      disposeFixture(fresh);
    }
  });

  it("turns each needle CLOCKWISE ON THE SCREEN as its reading rises (airspeed, altimeter, engine)", () => {
    const cases = [
      { dial: "airspeed", low: { airspeed: 60 / KNOTS }, high: { airspeed: 100 / KNOTS } },
      { dial: "altimeter", low: { altitude: 1_100 / FEET }, high: { altitude: 1_350 / FEET } },
      { dial: "engine", low: { engineRpm: 1_000 }, high: { engineRpm: 2_000 } },
    ] as const;
    for (const { dial, low, high } of cases) {
      show(low);
      const before = screenVector(dial);
      show(high);
      const after = screenVector(dial);
      expect(turnedClockwise(before, after), `${dial} needle: from ${JSON.stringify(low)} to ${JSON.stringify(high)} on the screen`).toBe(true);
      // ...and the reading going DOWN turns it the other way, so the test can tell
      expect(turnedClockwise(after, before), `${dial} needle running back`).toBe(false);
    }
  });

  it("sweeps each needle round without ever reversing: the screen angle rises steadily across the whole dial", () => {
    const sweeps = [
      { dial: "airspeed", make: (v: number) => ({ airspeed: v / KNOTS }), values: [0, 20, 40, 60, 80, 100, 120, 140, 160] },
      { dial: "altimeter", make: (v: number) => ({ altitude: v / FEET }), values: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 990] },
      { dial: "engine", make: (v: number) => ({ engineRpm: v }), values: [0, 500, 1_000, 1_500, 2_000, 2_500, 2_750] },
      { dial: "vertical-speed", make: (v: number) => ({ verticalSpeed: v / FPM }), values: [-2_000, -1_000, 0, 1_000, 2_000] },
    ];
    for (const { dial, make, values } of sweeps) {
      const angles = values.map((value) => {
        show(make(value));
        return clockAngleDegrees(screenVector(dial));
      });
      for (let i = 1; i < angles.length; i += 1) {
        // the perspective bends the angle a little, but the direction of travel cannot flip
        const step = ((angles[i]! - angles[i - 1]! + 540) % 360) - 180;
        expect(step, `${dial} from ${values[i - 1]} to ${values[i]}: screen angle ${angles[i - 1]!.toFixed(1)} -> ${angles[i]!.toFixed(1)}`).toBeGreaterThan(0);
      }
    }
  });

  it("moves the vertical speed needle UP the screen for a climb and DOWN for a descent, clockwise through 12 o'clock", () => {
    const tipHeight = (fpm: number) => {
      show({ verticalSpeed: fpm / FPM });
      const { hub, tip } = needle("vertical-speed");
      return { tip: project(fixture.camera, tip).y, hub: project(fixture.camera, hub).y };
    };
    const descending = tipHeight(-1_000);
    const level = tipHeight(0);
    const climbing = tipHeight(1_000);
    // pixel y grows downward, so UP is a smaller y
    expect(climbing.tip, "climb: tip above the level reading").toBeLessThan(level.tip - 3);
    expect(level.tip, "descent: tip below the level reading").toBeLessThan(descending.tip - 3);
    show({ verticalSpeed: 0 });
    const zero = screenVector("vertical-speed");
    show({ verticalSpeed: 1_000 / FPM });
    const up = screenVector("vertical-speed");
    expect(turnedClockwise(zero, up)).toBe(true);
  });

  it("puts every needle at the literal angle the mapping calls for, measured in the dial's plane", () => {
    const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
    const cases: readonly (readonly [string, (v: number) => Partial<FlightVisualState>, readonly (readonly [number, number])[]])[] = [
      // knots -> degrees: -150 at 0, +150 at 160, clamped
      ["airspeed", (v) => ({ airspeed: v / KNOTS }), [[0, -150], [40, -75], [80, 0], [120, 75], [160, 150], [220, 150]]],
      // feet of altitude ABOVE SEA LEVEL -> degrees: 360 per 1,000, wrapping
      ["altimeter", (v) => ({ altitude: v / FEET }), [[0, 0], [250, 90], [500, 180], [750, 270], [1_250, 90], [5_249.3, 89.748]]],
      // feet per minute -> degrees: -90 at 0, 0 at +2,000, -180 at -2,000, clamped
      ["vertical-speed", (v) => ({ verticalSpeed: v / FPM }), [[0, -90], [1_000, -45], [2_000, 0], [3_000, 0], [-1_000, -135], [-2_000, -180], [-3_000, -180]]],
      // RPM -> degrees: -135 at 0, +135 at 2,750, clamped
      ["engine", (v) => ({ engineRpm: v }), [[0, -135], [700, -135 + (270 * 700) / 2_750], [1_375, 0], [2_750, 135], [3_500, 135]]],
    ];
    for (const [dial, make, points] of cases) {
      for (const [reading, expected] of points) {
        show(make(reading));
        expect(Math.abs(wrap(planeAngle(dial) - expected)), `${dial} at ${reading}: ${planeAngle(dial).toFixed(3)} against ${expected}`).toBeLessThan(0.05);
      }
    }
  });

  it("reads the altimeter off ALTITUDE (metres above sea level), not off the height above the ground", () => {
    // An airfield 100 m above the sea: altitude 1,600, height above ground 1,500. At sea level the two differ by a gear
    // offset, and a dial wired to the wrong one would pass a test flown there.
    show({ altitude: 1_600, altitudeAgl: 1_500 });
    const measured = planeAngle("altimeter");
    const msl = ((1_600 * FEET) % 1_000) / 1_000 * 360;
    const agl = ((1_500 * FEET) % 1_000) / 1_000 * 360;
    expect(msl).toBeCloseTo(89.75, 1);
    expect(agl).toBeCloseTo(331.6, 0);
    expect(angleDifference(measured, msl), `altimeter at ${measured.toFixed(2)}, MSL says ${msl.toFixed(2)}`).toBeLessThan(0.1);
    expect(angleDifference(measured, agl), "the altimeter is not reading the height above the ground").toBeGreaterThan(90);
  });

  it("agrees with the number the HUD renders for the same state: IAS, V/S and RPM", () => {
    const states = [
      { label: "cruise", airspeed: 44.4, verticalSpeed: 2.54, engineRpm: 2_210 },
      { label: "descent at idle", airspeed: 41, verticalSpeed: -4.06, engineRpm: 700 },
      { label: "climb", airspeed: 36, verticalSpeed: 5, engineRpm: 2_750 },
      { label: "slow", airspeed: 22.5, verticalSpeed: 0.3, engineRpm: 1_500 },
    ];
    for (const { label, ...values } of states) {
      const state = stateWith(values);
      const markup = renderHud(state, "trainer");
      const hud = {
        knots: Number(/aria-label="IAS: (-?\d+) KT"/.exec(markup)?.[1]),
        fpm: Number(/<small>V\/S<\/small><strong>(?:<!-- -->)?\+?(-?\d+)/.exec(markup)?.[1]),
        rpm: Number(/<small>RPM<\/small><strong>(\d+)/.exec(markup)?.[1]),
      };
      expect(Number.isFinite(hud.knots) && Number.isFinite(hud.fpm) && Number.isFinite(hud.rpm), `${label}: parsed the HUD (${markup.slice(0, 0)}${JSON.stringify(hud)})`).toBe(true);
      show(values);
      // the needle's angle, back to a reading with the literal inverse of the mapping
      const knots = ((planeAngle("airspeed") + 150) / 300) * 160;
      const fpm = ((planeAngle("vertical-speed") + 90) / 90) * 2_000;
      const rpm = ((planeAngle("engine") + 135) / 270) * 2_750;
      // the HUD rounds (to 1 kt, 1 ft/min, 10 rpm), the needle does not
      expect(Math.abs(knots - hud.knots), `${label}: needle says ${knots.toFixed(2)} kt, HUD ${hud.knots}`).toBeLessThanOrEqual(0.5 + 1e-3);
      expect(Math.abs(fpm - hud.fpm), `${label}: needle says ${fpm.toFixed(2)} ft/min, HUD ${hud.fpm}`).toBeLessThanOrEqual(0.5 + 1e-3);
      expect(Math.abs(rpm - hud.rpm), `${label}: needle says ${rpm.toFixed(1)} rpm, HUD ${hud.rpm}`).toBeLessThanOrEqual(5 + 1e-3);
    }
  });

  it("holds a needle where it was when the reading is not a number, instead of poisoning its transform", () => {
    show({ airspeed: 50 / KNOTS, altitude: 800, verticalSpeed: 1, engineRpm: 1_800 });
    show({ airspeed: Number.NaN, altitude: Number.NaN, verticalSpeed: Number.POSITIVE_INFINITY, engineRpm: Number.NaN });
    for (const dial of ["airspeed", "altimeter", "vertical-speed", "engine"]) {
      const { mesh } = needle(dial);
      const q = mesh.rotationQuaternion!;
      expect(Number.isFinite(q.x + q.y + q.z + q.w), `${dial} rotation`).toBe(true);
      expect(Number.isFinite(planeAngle(dial)), `${dial} angle`).toBe(true);
    }
  });
});

describe("the Cessna's needles turn only while cockpit view is on", () => {
  it("leaves them where they are outside cockpit view, and turns them the frame it is entered", () => {
    const fixture = buildFixture("trainer", false);
    try {
      const rotation = (dial: string) => fixture.mesh(`trainer-${dial}-needle`).rotationQuaternion!.clone();
      const before = rotation("airspeed");
      fixture.aircraft.update(stateWith({ airspeed: 60, engineRpm: 2_000 }), 1 / 60);
      expect(rotation("airspeed").equalsWithEpsilon(before, 1e-9), "an update outside cockpit view turned a needle").toBe(true);
      fixture.aircraft.setCockpitView(true);
      fixture.aircraft.update(stateWith({ airspeed: 60, engineRpm: 2_000 }), 1 / 60);
      expect(rotation("airspeed").equalsWithEpsilon(before, 1e-3), "an update inside cockpit view did not turn it").toBe(false);
      const inside = rotation("airspeed");
      fixture.aircraft.setCockpitView(false);
      fixture.aircraft.update(stateWith({ airspeed: 20, engineRpm: 900 }), 1 / 60);
      expect(rotation("airspeed").equalsWithEpsilon(inside, 1e-9), "an update after leaving cockpit view turned a needle").toBe(true);
    } finally {
      disposeFixture(fixture);
    }
  });
});

// ---- the attitude balls -----------------------------------------------------------------------

/**
 * The Global's PFD ball and the Cessna's attitude dial are ONE builder at two sizes
 * (`buildAttitudeBall`), and both are held to the same picture: the ball's horizon on
 * the SCREEN parallel to the world's, its sky on the sky's side, its bar on the
 * pitch's side. The Cessna's dial normal points TOWARD the pilot and the Global's
 * pivot points away, so the sign is not taken from one on trust for the other: every
 * assertion here is about what the camera draws.
 */
interface BallCase {
  readonly kind: "bizjet" | "trainer";
  readonly label: string;
  readonly prefix: string;
  readonly pivotName: string;
  /** The bar's slide per degree of nose-up, metres: 1 mm on the Global's 0.048 m ball, 0.75 mm on the Cessna's 0.036 m one. */
  readonly metresPerDegree: number;
  readonly radius: number;
}
const BALLS: readonly BallCase[] = [
  { kind: "bizjet", label: "Global", prefix: "bizjet-pfd", pivotName: "bizjet-pfd-attitude-pivot", metresPerDegree: 0.001, radius: 0.048 },
  { kind: "trainer", label: "Cessna", prefix: "trainer-attitude", pivotName: "trainer-attitude-pivot", metresPerDegree: 0.00075, radius: 0.036 },
];

describe.each(BALLS.map((b) => [b.label, b] as const))("the %s's attitude ball", (_label, ball) => {
  let fixture: Fixture;
  /** The sky half's diameter ends, by vertex index (found at rest): the pilot's-right end and the left end. */
  let ends: [number, number];
  /** The dial's plane in BODY coordinates, at rest: up the face and the pilot's right. */
  let plane: { up: Vector3; right: Vector3 };

  const pivot = () => fixture.scene.getTransformNodeByName(ball.pivotName)!;
  const piece = (name: "sky" | "ground" | "pitch-bar") => fixture.mesh(`${ball.prefix}-${name}`);

  /** Fly a real simulator to the attitude, put the aircraft and the cockpit camera there, and let the visual and the HUD see the SAME state. */
  function fly(headingDegrees: number, pitchDegrees: number, bankDegrees: number): FlightVisualState {
    const { state } = flyAt(headingDegrees, pitchDegrees, bankDegrees, { altitude: 1_500 });
    const q = new Quaternion(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
    fixture.aircraft.root.rotationQuaternion = q;
    fixture.aircraft.root.position.set(0, 0, 0);
    fixture.aircraft.update(state, 1 / 60);
    fixture.aircraft.root.computeWorldMatrix(true);
    pivot().computeWorldMatrix(true);
    for (const mesh of fixture.scene.meshes) mesh.computeWorldMatrix(true);
    pointCockpitCamera(fixture.camera, ball.kind, Vector3.Zero(), q);
    return state;
  }
  const side = (a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }) =>
    Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  const byX = (a: { x: number; y: number }, b: { x: number; y: number }): [typeof a, typeof b] => (a.x <= b.x ? [a, b] : [b, a]);
  const lineAngle = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const [left, right] = byX(a, b);
    return (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
  };
  const centroid = (mesh: AbstractMesh) => {
    const vertices = worldVertices(mesh);
    return vertices.reduce((sum, v) => sum.add(v), Vector3.Zero()).scale(1 / vertices.length);
  };

  beforeAll(() => {
    fixture = buildFixture(ball.kind);
    if (ball.kind === "bizjet") {
      plane = { up: new Vector3(0, 1, 0), right: new Vector3(0, 0, 1) };
    } else {
      // from the BUILT panel: the pilot looks along the dial's normal reversed, and his right is forward x up
      const panel = fixture.mesh("trainer-instrument-panel");
      panel.computeWorldMatrix(true);
      const normal = Vector3.TransformNormal(new Vector3(-1, 0, 0), panel.getWorldMatrix()).normalize();
      const up = Vector3.TransformNormal(new Vector3(0, 1, 0), panel.getWorldMatrix()).normalize();
      plane = { up, right: Vector3.Cross(normal.scale(-1), up).normalize() };
    }
    // the diameter's two ends, found at rest in the PIVOT's own frame (the dial may lean): the sky half's vertices on y = 0
    pivot().computeWorldMatrix(true);
    const inverse = Matrix.Invert(pivot().getWorldMatrix());
    const local = worldVertices(piece("sky")).map((v) => Vector3.TransformCoordinates(v, inverse));
    // (a micrometre: the next vertex round the rim is millimetres away, and a leaning frame's matrices leave ~1e-8 of float noise)
    const onEdge = local.map((v, i) => ({ v, i })).filter(({ v }) => Math.abs(v.y) < 1e-6);
    ends = [
      onEdge.reduce((a, b) => (b.v.z > a.v.z ? b : a)).i,
      onEdge.reduce((a, b) => (b.v.z < a.v.z ? b : a)).i,
    ];
  });
  afterAll(() => disposeFixture(fixture));

  const SCENARIOS = [
    { label: "a steady 20 degree RIGHT bank in a 5 degree climb", heading: 30, pitch: 5, bank: 20 },
    { label: "a 20 degree LEFT bank in a 5 degree climb", heading: 30, pitch: 5, bank: -20 },
    { label: "a 20 degree LEFT bank in a 3 degree descent", heading: 250, pitch: -3, bank: -20 },
    { label: "wings level in a 5 degree climb", heading: 0, pitch: 5, bank: 0 },
  ] as const;

  it.each(SCENARIOS)("in $label: the ball's horizon is parallel, on the screen, to the WORLD horizon, with the sky on the sky's side", ({ heading, pitch, bank }) => {
    const state = fly(heading, pitch, bank);
    const eye = fixture.camera.position;
    const forward = Vector3.TransformNormal(Vector3.Right(), Matrix.FromQuaternionToRef(fixture.aircraft.root.rotationQuaternion!, new Matrix()));
    const level = new Vector3(forward.x, 0, forward.z).normalize();
    const horizonPoint = (yawDegrees: number, elevationDegrees = 0) => {
      const yaw = Vector3.TransformNormal(level, Matrix.RotationY((yawDegrees * Math.PI) / 180));
      const e = (elevationDegrees * Math.PI) / 180;
      return eye.add(yaw.scale(Math.cos(e) * 100_000)).add(new Vector3(0, Math.sin(e) * 100_000, 0));
    };
    // the WORLD horizon, at infinity, at the eye's height: two points either side of the view direction
    const worldA = project(fixture.camera, horizonPoint(-12));
    const worldB = project(fixture.camera, horizonPoint(12));
    const realSky = project(fixture.camera, horizonPoint(0, 10));
    const realGround = project(fixture.camera, horizonPoint(0, -10));
    for (const p of [worldA, worldB, realSky, realGround]) expect(p.depth).toBeGreaterThan(0);
    // the BALL's horizon: its diameter, wherever the pivot has turned it
    const sky = worldVertices(piece("sky"));
    const ballA = project(fixture.camera, sky[ends[0]]!);
    const ballB = project(fixture.camera, sky[ends[1]]!);
    const skyAt = project(fixture.camera, centroid(piece("sky")));
    const groundAt = project(fixture.camera, centroid(piece("ground")));
    // PARALLEL within a degree. (A small disc facing the pilot is parallel to the image plane, so the picture is a pure
    // scaling of the instrument and its angles are exact; the Cessna's dial leans a few degrees off that plane and sits
    // below the centre of the frame, which bends the angle a little more; the world horizon under pitch and roll differs
    // from the roll by about a tenth of a degree. A flipped sign is out by twice the bank.)
    const world = lineAngle(worldA, worldB);
    const ballAngle = lineAngle(ballA, ballB);
    expect(Math.abs(world - ballAngle), `world horizon ${world.toFixed(2)} deg on the screen, the ball's ${ballAngle.toFixed(2)}`).toBeLessThan(1);
    // and the sense is what a right bank looks like: the right end of the horizon UP (smaller y), so a negative slope
    if (bank !== 0) expect(Math.sign(world), "the world horizon tilts as a bank of this sense does").toBe(-Math.sign(bank));
    // the SKY half is on the same side of the horizon as the real sky, and the ground half on the ground's side
    const [worldLeft, worldRight] = byX(worldA, worldB);
    const [ballLeft, ballRight] = byX(ballA, ballB);
    expect(side(worldLeft, worldRight, realSky)).toBe(-side(worldLeft, worldRight, realGround));
    expect(side(ballLeft, ballRight, skyAt), "the ball's sky half is not on the sky's side").toBe(side(worldLeft, worldRight, realSky));
    expect(side(ballLeft, ballRight, groundAt), "the ball's ground half is not on the ground's side").toBe(side(worldLeft, worldRight, realGround));
    // the PITCH BAR: for nose-up it slides DOWN, onto the ground side of the ball's horizon; for nose-down, up onto the sky side
    const bar = piece("pitch-bar");
    const barAt = project(fixture.camera, bar.getBoundingInfo().boundingBox.centerWorld);
    if (pitch > 0) expect(side(ballLeft, ballRight, barAt), "nose up: the bar is not below the ball's horizon").toBe(side(ballLeft, ballRight, groundAt));
    if (pitch < 0) expect(side(ballLeft, ballRight, barAt), "nose down: the bar is not above the ball's horizon").toBe(side(ballLeft, ballRight, skyAt));
    // a millimetre a degree on the Global's ball, in proportion to the radius on another, along the pivot's own up
    expect(bar.position.y).toBeCloseTo(-pitch * ball.metresPerDegree, 9);
    expect(state.pitch).toBeCloseTo(pitch, 5);
  });

  it.each(SCENARIOS)("in $label: the ball reads what the HUD renders, and turns the way the HUD's own horizon does", ({ heading, pitch, bank }) => {
    const state = fly(heading, pitch, bank);
    const markup = renderHud(state, ball.kind);
    const hudPitch = Number(/Pitch (-?\d+) degrees/.exec(markup)?.[1]);
    const hudBank = Number(/bank (-?\d+) degrees/.exec(markup)?.[1]);
    // the HUD's horizon is a CSS transform: rotate(-bank deg), and CSS rotates CLOCKWISE for positive angles
    const hudRotate = Number(/rotate\((-?[\d.]+)deg\)/.exec(markup)?.[1]);
    const hudSlideDown = Number(/calc\(-50% \+ (-?[\d.]+)px\)/.exec(markup)?.[1]);
    expect(Number.isFinite(hudPitch + hudBank + hudRotate + hudSlideDown), `parsed the HUD's attitude from ${markup.slice(markup.indexOf("attitude"), markup.indexOf("attitude") + 200)}`).toBe(true);
    // the ball, measured in the BODY frame along the dial's own axes: the diameter's direction (right end minus left end) and the bar's slide
    const bodyOf = (p: Vector3) => Vector3.TransformCoordinates(p, Matrix.Invert(fixture.aircraft.root.getWorldMatrix()));
    const sky = worldVertices(piece("sky"));
    const v = bodyOf(sky[ends[0]]!).subtract(bodyOf(sky[ends[1]]!));
    // clockwise as the pilot sees it: the right end goes DOWN, so atan2(-up, right)
    const ballClockwise = (Math.atan2(-Vector3.Dot(v, plane.up), Vector3.Dot(v, plane.right)) * 180) / Math.PI;
    expect(Math.round(-ballClockwise), "ball's bank against the HUD's").toBe(hudBank);
    expect(ballClockwise, "the ball turns by the same clockwise angle as the HUD's horizon").toBeCloseTo(hudRotate, 3);
    const slideDownMetres = -piece("pitch-bar").position.y;
    expect(Math.round(slideDownMetres / ball.metresPerDegree), "ball's pitch against the HUD's").toBe(hudPitch);
    // the HUD's ladder slides DOWN for nose-up (positive px); so does the ball's bar
    expect(Math.sign(slideDownMetres)).toBe(Math.sign(hudSlideDown));
  });

  it("clamps the pitch bar at 25 degrees each way", () => {
    const slide = (pitch: number) => {
      fixture.aircraft.update(stateWith({ pitch }), 1 / 60);
      return piece("pitch-bar").position.y;
    };
    expect(slide(40)).toBeCloseTo(-25 * ball.metresPerDegree, 9);
    expect(slide(-40)).toBeCloseTo(25 * ball.metresPerDegree, 9);
    expect(slide(0)).toBeCloseTo(0, 9);
  });

  it("makes the sky the UPPER half in the sky's colour, the ground the lower in the earth's, and the bar white", () => {
    fixture.aircraft.update(stateWith({ bank: 0, pitch: 0 }), 1 / 60);
    pivot().computeWorldMatrix(true);
    const inverse = Matrix.Invert(pivot().getWorldMatrix());
    // in the pivot's own frame, y is up the dial
    const localOf = (mesh: AbstractMesh) => worldVertices(mesh).map((v) => Vector3.TransformCoordinates(v, inverse));
    expect(Math.min(...localOf(piece("sky")).map((v) => v.y)), "the sky half reaches below the horizon").toBeGreaterThan(-1e-6);
    expect(Math.max(...localOf(piece("sky")).map((v) => v.y)), "the sky half is the whole upper half").toBeCloseTo(ball.radius, 4);
    expect(Math.max(...localOf(piece("ground")).map((v) => v.y)), "the ground half reaches above the horizon").toBeLessThan(1e-6);
    expect(Math.min(...localOf(piece("ground")).map((v) => v.y)), "the ground half is the whole lower half").toBeCloseTo(-ball.radius, 4);
    const albedo = (mesh: AbstractMesh) => (mesh.material as PBRMaterial).albedoColor;
    expect(albedo(piece("sky")).b, "sky: blue over red").toBeGreaterThan(albedo(piece("sky")).r);
    expect(albedo(piece("ground")).r, "ground: red over blue").toBeGreaterThan(albedo(piece("ground")).b);
    for (const channel of [albedo(piece("pitch-bar")).r, albedo(piece("pitch-bar")).g, albedo(piece("pitch-bar")).b]) expect(channel, "the bar is white").toBeGreaterThan(0.85);
  });

  it("keeps the pitch bar INSIDE the ball's disc at the clamp, at every bank", () => {
    for (const pitch of [-90, -25, -10, 0, 10, 25, 90]) {
      for (const bank of [0, 60, 150]) {
        fixture.aircraft.update(stateWith({ pitch, bank }), 1 / 60);
        pivot().computeWorldMatrix(true);
        const inverse = Matrix.Invert(pivot().getWorldMatrix());
        for (const v of worldVertices(piece("pitch-bar"))) {
          const local = Vector3.TransformCoordinates(v, inverse);
          // in the ball's own plane: y up the dial, z across it; 2 mm to spare so it never touches the rim
          expect(Math.hypot(local.y, local.z), `pitch ${pitch} bank ${bank}: bar corner ${local.y.toFixed(4)}, ${local.z.toFixed(4)}`).toBeLessThan(ball.radius - 0.002);
        }
      }
    }
  });
});

describe("the Cessna's attitude dial", () => {
  let fixture: Fixture;
  beforeAll(() => { fixture = buildFixture("trainer"); });
  afterAll(() => disposeFixture(fixture));

  /** The dial's plane, from the BUILT panel: the normal toward the pilot, up the face, the pilot's right. */
  function plane(): { normal: Vector3; up: Vector3; right: Vector3 } {
    const panel = fixture.mesh("trainer-instrument-panel");
    panel.computeWorldMatrix(true);
    const normal = Vector3.TransformNormal(new Vector3(-1, 0, 0), panel.getWorldMatrix()).normalize();
    const up = Vector3.TransformNormal(new Vector3(0, 1, 0), panel.getWorldMatrix()).normalize();
    return { normal, up, right: Vector3.Cross(normal.scale(-1), up).normalize() };
  }

  it("has a BALL and no needle: the other four dials keep theirs", () => {
    expect(fixture.scene.getMeshByName("trainer-attitude-needle")).toBeNull();
    for (const dial of ["airspeed", "altimeter", "vertical-speed", "engine"]) {
      expect(fixture.scene.getMeshByName(`trainer-${dial}-needle`), `${dial} needle`).not.toBeNull();
    }
    for (const name of ["sky", "ground", "pitch-bar"]) {
      expect(fixture.mesh(`trainer-attitude-${name}`).metadata?.cockpitOnly, `${name} is a cockpit-only part`).toBe(true);
    }
  });

  it("stands on its dial: radius 0.036 on the 0.08 dial, centred on it, sky and ground 1.5 mm in front of the face, the bar in front of them", () => {
    const { normal, up, right } = plane();
    const gauge = fixture.mesh("trainer-attitude-gauge");
    const gaugeCentre = gauge.getBoundingInfo().boundingBox.centerWorld;
    const along = (v: Vector3) => Vector3.Dot(v.subtract(gaugeCentre), normal);
    const inPlane = (v: Vector3) => ({ u: Vector3.Dot(v.subtract(gaugeCentre), up), r: Vector3.Dot(v.subtract(gaugeCentre), right) });
    const halves = [...worldVertices(fixture.mesh("trainer-attitude-sky")), ...worldVertices(fixture.mesh("trainer-attitude-ground"))];
    // the face is 0.04 in radius; the ball 0.036, so 4 mm of face shows round it
    expect(Math.max(...worldVertices(gauge).map((v) => Math.hypot(inPlane(v).u, inPlane(v).r)))).toBeCloseTo(0.04, 4);
    expect(Math.max(...halves.map((v) => Math.hypot(inPlane(v).u, inPlane(v).r)))).toBeCloseTo(0.036, 4);
    // centred on the dial within a millimetre (the bounding box of a disc is centred on it)
    const us = halves.map((v) => inPlane(v).u);
    const rs = halves.map((v) => inPlane(v).r);
    expect(Math.abs((Math.max(...us) + Math.min(...us)) / 2), "centred up the face").toBeLessThan(1e-3);
    expect(Math.abs((Math.max(...rs) + Math.min(...rs)) / 2), "centred across the face").toBeLessThan(1e-3);
    // the face's front, then the halves' back 1.5 mm in front of it, toward the pilot
    const faceFront = Math.max(...worldVertices(gauge).map(along));
    expect(Math.min(...halves.map(along)) - faceFront, "sky and ground stand 1.5 mm proud of the face").toBeCloseTo(0.0015, 5);
    const bar = worldVertices(fixture.mesh("trainer-attitude-pitch-bar"));
    expect(Math.min(...bar.map(along)), "the bar is in front of the sky and ground").toBeGreaterThan(Math.max(...halves.map(along)));
  });

  it("hangs its pivot in the frame the builder's turn assumes: X away from the pilot, Y up the dial, Z his right", () => {
    const { normal, up, right } = plane();
    const pivot = fixture.scene.getTransformNodeByName("trainer-attitude-pivot")!;
    pivot.computeWorldMatrix(true);
    const axis = (x: number, y: number, z: number) => Vector3.TransformNormal(new Vector3(x, y, z), pivot.getWorldMatrix()).normalize();
    expect(Vector3.Dot(axis(1, 0, 0), normal.scale(-1))).toBeGreaterThan(0.99999);
    expect(Vector3.Dot(axis(0, 1, 0), up)).toBeGreaterThan(0.99999);
    expect(Vector3.Dot(axis(0, 0, 1), right)).toBeGreaterThan(0.99999);
  });
});

describe.each(BALLS.map((b) => [b.label, b] as const))("the %s's ball turns only while cockpit view is on", (_label, ball) => {
  it("leaves the pivot where it is outside cockpit view", () => {
    const fixture = buildFixture(ball.kind, false);
    try {
      const pivot = fixture.scene.getTransformNodeByName(ball.pivotName)!;
      fixture.aircraft.update(stateWith({ bank: 30, pitch: 10 }), 1 / 60);
      expect(pivot.rotation.x).toBe(0);
      fixture.aircraft.setCockpitView(true);
      fixture.aircraft.update(stateWith({ bank: 30, pitch: 10 }), 1 / 60);
      expect(Math.abs(pivot.rotation.x)).toBeGreaterThan(0.4);
      fixture.aircraft.setCockpitView(false);
      pivot.rotation.x = 0.123;
      fixture.aircraft.update(stateWith({ bank: -30, pitch: 0 }), 1 / 60);
      expect(pivot.rotation.x).toBe(0.123);
    } finally {
      disposeFixture(fixture);
    }
  });
});
