import { readFileSync } from "node:fs";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec, type TopFrontViewSpec } from "../src/aircraft/catalogue";
import { INITIAL_VISUAL_STATE } from "../src/game/types";
import {
  CHASE_AIM_HEIGHT_METERS,
  FRONT_VIEW_ELEVATION_DEGREES,
  FRONT_VIEW_FIELD_OF_VIEW_DEGREES,
  TOP_VIEW_FIELD_OF_VIEW_DEGREES,
  cameraBankFollow,
  cameraPresentationResponse,
  cameraRigLiftToRef,
  cameraTrailMeters,
  chaseRigOffsetsToRef,
  frontViewRigOffsetsToRef,
  orthogonalizeCameraUpToRef,
  topViewCameraUpToRef,
  topViewRigOffsetsToRef,
  type MutablePresentationVector,
} from "../src/render/cameraPresentation";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { createWebGpuBoat } from "../src/render/webgpu/boat/createBoat";
import { createWebGpuCar } from "../src/render/webgpu/ground/createCar";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";

/**
 * The top and front views (Jason, 2026-10-25: "a top view and front view, i.e.
 * user sees front of plane"): where their rigs put the camera, and that the
 * catalogue's distances frame each BUILT airframe the way its comment says.
 */

type Vec = MutablePresentationVector;
const v = (x = 0, y = 0, z = 0): Vec => ({ x, y, z });
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec, b: Vec) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const length = (a: Vec) => Math.hypot(a.x, a.y, a.z);

/** Body axes at a heading, pitch and bank (radians), nose along +X at heading 0 (D-6). */
function attitude(heading: number, pitch: number, bank: number): { forward: Vec; up: Vec } {
  const forward = v(Math.cos(pitch) * Math.cos(heading), Math.sin(pitch), Math.cos(pitch) * Math.sin(heading));
  const up0 = v(-Math.sin(pitch) * Math.cos(heading), Math.cos(pitch), -Math.sin(pitch) * Math.sin(heading));
  // Starboard is forward x up0; rolling right lowers the starboard wing.
  const starboard = v(
    forward.y * up0.z - forward.z * up0.y,
    forward.z * up0.x - forward.x * up0.z,
    forward.x * up0.y - forward.y * up0.x,
  );
  const up = v(
    up0.x * Math.cos(bank) - starboard.x * Math.sin(bank),
    up0.y * Math.cos(bank) - starboard.y * Math.sin(bank),
    up0.z * Math.cos(bank) - starboard.z * Math.sin(bank),
  );
  return { forward, up };
}

/** The rig exactly as updateCamera builds it, for one attitude. */
function rig(view: "top" | "front", forward: Vec, up: Vec, framing: TopFrontViewSpec, reducedMotion = false) {
  const lift = v();
  cameraRigLiftToRef(forward, up, cameraBankFollow(view, reducedMotion), lift);
  const camera = v();
  const target = v();
  (view === "top" ? topViewRigOffsetsToRef : frontViewRigOffsetsToRef)(forward, up, lift, framing, camera, target);
  return { camera, target, lift };
}

const ATTITUDES: ReadonlyArray<readonly [number, number, number]> = (() => {
  const out: Array<readonly [number, number, number]> = [];
  for (const heading of [0, 0.7, 2.2, -2.9]) {
    for (const pitch of [-1.5707963, -1.2, -0.6, -0.3, -0.1, 0, 0.12, 0.4, 1.0, 1.5707963]) {
      for (const bank of [0, 0.3, -0.8, 1.5707963, 2.6, Math.PI]) out.push([heading, pitch, bank]);
    }
  }
  return out;
})();

describe("the top and front rigs", () => {
  const framing = aircraftSpec("airliner").topFront;

  it("follow the bank the way the chase view does, and trail nothing", () => {
    for (const view of ["top", "front"] as const) {
      expect(cameraBankFollow(view, false)).toBe(cameraBankFollow("chase", false));
      expect(cameraBankFollow(view, true)).toBe(0);
      expect(cameraTrailMeters(view, false, 140)).toBe(0);
      expect(cameraPresentationResponse(view, false, 1 / 60, false))
        .toBe(cameraPresentationResponse("chase", false, 1 / 60, false));
      expect(cameraPresentationResponse(view, true, 1 / 60, false)).toBe(1);
    }
  });

  it("aim at the airframe's centre, a point on the aeroplane carried by its own axes", () => {
    for (const [heading, pitch, bank] of ATTITUDES) {
      const { forward, up } = attitude(heading, pitch, bank);
      for (const view of ["top", "front"] as const) {
        const { target } = rig(view, forward, up, framing);
        expect(target.x).toBeCloseTo(forward.x * framing.centreForward + up.x * framing.centreUp, 12);
        expect(target.y).toBeCloseTo(forward.y * framing.centreForward + up.y * framing.centreUp, 12);
        expect(target.z).toBeCloseTo(forward.z * framing.centreForward + up.z * framing.centreUp, 12);
      }
    }
  });

  it("put the top camera straight above the centre in level flight, square to the plan in a climb", () => {
    const level = rig("top", ...Object.values(attitude(0.7, 0, 0)) as [Vec, Vec], framing);
    const rise = sub(level.camera, level.target);
    expect(rise.x).toBeCloseTo(0, 12);
    expect(rise.y).toBeCloseTo(framing.topDistanceMeters, 9);
    expect(rise.z).toBeCloseTo(0, 12);
    const { forward, up } = attitude(0.7, 0.4, 0);
    const climb = rig("top", forward, up, framing);
    const offset = sub(climb.camera, climb.target);
    expect(length(offset)).toBeCloseTo(framing.topDistanceMeters, 9);
    expect(dot(offset, forward)).toBeCloseTo(0, 9);
  });

  it("never put the top camera below the airframe, so it needs no terrain sample", () => {
    for (const reducedMotion of [false, true]) {
      for (const [heading, pitch, bank] of ATTITUDES) {
        const { forward, up } = attitude(heading, pitch, bank);
        const { camera, target } = rig("top", forward, up, framing, reducedMotion);
        // Within a hundredth of a millimetre: at a nose 3e-8 rad off vertical
        // the rig's vertical is the aircraft's up, level to that much.
        expect(camera.y - target.y, `${heading} ${pitch} ${bank}`).toBeGreaterThanOrEqual(-1e-5);
        expect(length(sub(camera, target))).toBeCloseTo(framing.topDistanceMeters, 6);
      }
    }
  });

  it("point the top view's screen up along the nose", () => {
    const { forward, up } = attitude(2.2, 0, 0);
    const { camera, target } = rig("top", forward, up, framing);
    const asked = v();
    topViewCameraUpToRef(forward, asked);
    const screenUp = v();
    orthogonalizeCameraUpToRef(asked, sub(target, camera), up, screenUp);
    expect(dot(screenUp, forward)).toBeCloseTo(1, 12);
  });

  it("put the front camera out along the nose, raised the elevation toward the rig's vertical", () => {
    const { forward, up } = attitude(-2.9, 0, 0);
    const { camera, target } = rig("front", forward, up, framing);
    const offset = sub(camera, target);
    const elevation = (FRONT_VIEW_ELEVATION_DEGREES * Math.PI) / 180;
    expect(length(offset)).toBeCloseTo(framing.frontDistanceMeters, 9);
    expect(dot(offset, forward)).toBeCloseTo(framing.frontDistanceMeters * Math.cos(elevation), 9);
    expect(offset.y).toBeCloseTo(framing.frontDistanceMeters * Math.sin(elevation), 9);
    // A climb is followed: the camera stays on the nose, and so does a shallow dive.
    for (const pitch of [0.4, -0.1]) {
      const pitched = attitude(-2.9, pitch, 0);
      const r = rig("front", pitched.forward, pitched.up, framing);
      expect(dot(sub(r.camera, r.target), pitched.forward))
        .toBeCloseTo(framing.frontDistanceMeters * Math.cos(elevation), 9);
    }
  });

  it("hold the front camera level with the centre in a dive, at the same distance, never below it", () => {
    for (const reducedMotion of [false, true]) {
      for (const [heading, pitch, bank] of ATTITUDES) {
        const { forward, up } = attitude(heading, pitch, bank);
        const { camera, target } = rig("front", forward, up, framing, reducedMotion);
        const label = `${heading} ${pitch} ${bank}`;
        expect(camera.y - target.y, label).toBeGreaterThanOrEqual(-1e-9);
        expect(length(sub(camera, target)), label).toBeCloseTo(framing.frontDistanceMeters, 6);
      }
    }
    // A 30 degree dive: level with the centre, out along the nose's heading.
    const { forward, up } = attitude(0.7, -Math.PI / 6, 0);
    const { camera, target } = rig("front", forward, up, framing);
    expect(camera.y).toBeCloseTo(target.y, 12);
    expect(camera.x - target.x).toBeCloseTo(Math.cos(0.7) * framing.frontDistanceMeters, 9);
    expect(camera.z - target.z).toBeCloseTo(Math.sin(0.7) * framing.frontDistanceMeters, 9);
  });

  it("move the front camera continuously through the dive where it starts holding the horizon", () => {
    const elevation = (FRONT_VIEW_ELEVATION_DEGREES * Math.PI) / 180;
    let previous: Vec | null = null;
    for (let step = -200; step <= 200; step += 1) {
      const pitch = -elevation + step * 1e-4;
      const { forward, up } = attitude(0.7, pitch, 0);
      const { camera } = rig("front", forward, up, framing);
      if (previous) expect(length(sub(camera, previous))).toBeLessThan(framing.frontDistanceMeters * 2e-4);
      previous = camera;
    }
  });

  it("stay finite on input no attitude produces", () => {
    const camera = v();
    const target = v();
    for (const view of [topViewRigOffsetsToRef, frontViewRigOffsetsToRef]) {
      view(v(0, -1, 0), v(0, 0, 0), v(0, -1, 0), framing, camera, target);
      expect([camera.x, camera.y, camera.z, target.x, target.y, target.z].every(Number.isFinite)).toBe(true);
      view(v(0, 0, 0), v(0, 0, 0), v(0, 0, 0), framing, camera, target);
      expect([camera.x, camera.y, camera.z, target.x, target.y, target.z].every(Number.isFinite)).toBe(true);
    }
  });
});

describe("the renderer's top and front branches", () => {
  const source = readFileSync(new URL("../src/render/FlightRenderer.ts", import.meta.url), "utf8");
  const branchStart = source.indexOf('} else if (this.cameraMode === "top" || this.cameraMode === "front") {');
  const branch = source.slice(branchStart, source.indexOf("\n    } else {\n", branchStart));
  // The second `if` on the top view: the first is inside the branch above.
  const upStart = source.indexOf('if (this.cameraMode === "top") {', branchStart + branch.length);
  const upBranch = source.slice(upStart, source.indexOf("} else {", upStart));

  it("exist, once each", () => {
    expect(branchStart).toBeGreaterThan(0);
    expect(source.indexOf('} else if (this.cameraMode === "top" || this.cameraMode === "front") {', branchStart + 1)).toBe(-1);
    expect(upStart).toBeGreaterThan(0);
    expect(branch).toContain("topViewRigOffsetsToRef(");
    expect(branch).toContain("frontViewRigOffsetsToRef(");
    // `rigForward` IS `this.forward` for an aircraft; a boat's level follow
    // hands its heading instead.
    expect(upBranch).toContain("topViewCameraUpToRef(rigForward, this.desiredCameraUp)");
  });

  it("allocate nothing and sample no terrain, every frame either view is on", () => {
    // Babylon's allocating vector methods (`scale`, `add`, `subtract`, `clone`,
    // `normalizeToNew`), any constructor, and the camera's terrain sampler,
    // which builds a TerrainSample per call. The chase branch makes two of
    // those a frame; these must make none.
    for (const text of [branch, upBranch]) {
      expect(text).not.toMatch(/\.(scale|add|subtract|clone|normalizeToNew|multiply|cross)\(/);
      expect(text).not.toMatch(/\bnew\s/);
      expect(text).not.toContain("cameraTerrainSample");
      expect(text).not.toMatch(/\{\s*x:|\[\s*[\w.]+\s*,/);
    }
    // Control: the orbit branch beside them does allocate, and is caught.
    const orbit = source.slice(source.indexOf('} else if (this.cameraMode === "cinematic") {'), branchStart);
    expect(orbit).toMatch(/\.(scale|add|subtract|clone)\(/);
  });
});

/**
 * Every drawn vertex of the built airframe, gear up or down, flaps up, under
 * NullEngine as the cockpit tests build it (root at the origin, body +X nose,
 * +Y up, +Z starboard, exterior view).
 */
function framingScene() {
  const engine = new NullEngine({
    renderWidth: WIDTH, renderHeight: HEIGHT, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new UniversalCamera("top-front-view-camera", new Vector3(0, 0, -50), scene);
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  camera.minZ = 0.08;
  camera.maxZ = 20_000;
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

function drawnPoints(meshes: readonly AbstractMesh[], camera: UniversalCamera): Vector3[] {
  const points: Vector3[] = [];
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    if (!mesh.isEnabled() || !mesh.isVisible || (mesh.layerMask & camera.layerMask) === 0) continue;
    const local = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!local) continue;
    const world = mesh.getWorldMatrix();
    for (let i = 0; i + 2 < local.length; i += 3) {
      points.push(Vector3.TransformCoordinates(new Vector3(local[i]!, local[i + 1]!, local[i + 2]!), world));
    }
  }
  return points;
}

function builtAirframe(kind: AircraftKind, gear: number) {
  const { engine, scene, camera } = framingScene();
  const aircraft = createWebGpuAircraft(scene, kind);
  // Twice, with a long step, so the legs and panels have finished moving.
  aircraft.update({ ...INITIAL_VISUAL_STATE, gear, flaps: 0 }, 10);
  aircraft.update({ ...INITIAL_VISUAL_STATE, gear, flaps: 0 }, 10);
  aircraft.setCockpitView(false);
  aircraft.root.computeWorldMatrix(true);
  const points = drawnPoints(aircraft.meshes, camera);
  const dispose = () => {
    aircraft.dispose();
    scene.dispose();
    engine.dispose();
  };
  return { camera, points, dispose };
}

/** Every drawn vertex, each thin instance's copy placed by its own matrix. */
function drawnInstancedPoints(meshes: readonly AbstractMesh[], camera: UniversalCamera): Vector3[] {
  const points: Vector3[] = [];
  for (const mesh of meshes) {
    const instances = (mesh as Mesh).thinInstanceCount ?? 0;
    if (instances === 0) {
      points.push(...drawnPoints([mesh], camera));
      continue;
    }
    mesh.computeWorldMatrix(true);
    if (!mesh.isEnabled() || !mesh.isVisible) continue;
    const local = mesh.getVerticesData(VertexBuffer.PositionKind);
    const matrices = (mesh as Mesh).thinInstanceGetWorldMatrices();
    if (!local) continue;
    for (const instance of matrices) {
      const world = instance.multiply(mesh.getWorldMatrix());
      for (let i = 0; i + 2 < local.length; i += 3) {
        points.push(Vector3.TransformCoordinates(new Vector3(local[i]!, local[i + 1]!, local[i + 2]!), world));
      }
    }
  }
  return points;
}

/** The LandCruiser 76 as built, at kerb ride, wheels straight. */
function builtCar() {
  const { engine, scene, camera } = framingScene();
  const car = createWebGpuCar(scene, "landcruiser");
  car.update({ ...INITIAL_VISUAL_STATE }, 1 / 60);
  car.setCockpitView(false);
  car.root.computeWorldMatrix(true);
  const points = drawnInstancedPoints(car.meshes, camera);
  const dispose = () => {
    car.dispose();
    scene.dispose();
    engine.dispose();
  };
  return { camera, points, dispose };
}

/** The Runabout 21 as built, at rest with the outboard trimmed in. */
function builtBoat() {
  const { engine, scene, camera } = framingScene();
  const boat = createWebGpuBoat(scene, "speedboat");
  boat.root.computeWorldMatrix(true);
  const points = drawnPoints(boat.meshes, camera);
  const dispose = () => {
    boat.dispose();
    scene.dispose();
    engine.dispose();
  };
  return { camera, points, dispose };
}

const WIDTH = 1600;
const HEIGHT = 900;

interface Framed {
  /** The projected box, as fractions of the frame (y down). */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Fraction of the frame the airframe fills along each axis. */
  readonly width: number;
  readonly height: number;
  /** Every vertex is in front of the camera. */
  readonly inFront: boolean;
  /** Screen y of the nose's tip and of the airframe's aftmost point. */
  readonly noseY: number;
  readonly tailY: number;
  /** View depth of the nose's tip and of the aftmost point. */
  readonly noseDepth: number;
  readonly tailDepth: number;
}

/** Projects the built airframe through the view's rig in level flight, nose along +X. */
function frame(
  built: ReturnType<typeof builtAirframe>,
  view: "top" | "front",
  framing: TopFrontViewSpec,
): Framed {
  const forward = v(1, 0, 0);
  const up = v(0, 1, 0);
  const { camera: eye, target } = rig(view, forward, up, framing);
  const { camera, points } = built;
  camera.fov = ((view === "top" ? TOP_VIEW_FIELD_OF_VIEW_DEGREES : FRONT_VIEW_FIELD_OF_VIEW_DEGREES) * Math.PI) / 180;
  camera.position.set(eye.x, eye.y, eye.z);
  const asked = v(0, 1, 0);
  if (view === "top") topViewCameraUpToRef(forward, asked);
  const screenUp = v();
  orthogonalizeCameraUpToRef(asked, sub(target, eye), up, screenUp);
  camera.upVector.set(screenUp.x, screenUp.y, screenUp.z);
  camera.setTarget(new Vector3(target.x, target.y, target.z));
  const view_ = camera.getViewMatrix(true);
  const transform = view_.multiply(camera.getProjectionMatrix(true));
  const viewport = camera.viewport.toGlobal(WIDTH, HEIGHT);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let inFront = true;
  let nose = points[0]!;
  let tail = points[0]!;
  for (const p of points) {
    if (p.x > nose.x) nose = p;
    if (p.x < tail.x) tail = p;
    const s = Vector3.Project(p, Matrix.Identity(), transform, viewport);
    if (!(Vector3.TransformCoordinates(p, view_).z < 0)) inFront = false;
    left = Math.min(left, s.x / WIDTH);
    right = Math.max(right, s.x / WIDTH);
    top = Math.min(top, s.y / HEIGHT);
    bottom = Math.max(bottom, s.y / HEIGHT);
  }
  const project = (p: Vector3) => Vector3.Project(p, Matrix.Identity(), transform, viewport).y / HEIGHT;
  const depth = (p: Vector3) => -Vector3.TransformCoordinates(p, view_).z;
  return {
    left, right, top, bottom, width: right - left, height: bottom - top, inFront,
    noseY: project(nose), tailY: project(tail), noseDepth: depth(nose), tailDepth: depth(tail),
  };
}

describe("the catalogue's top and front framing, on the built airframes at 16:9", () => {
  const built = new Map<string, ReturnType<typeof builtAirframe>>();
  // Eight airframes take about 4 s on a quiet machine and over the 10 s
  // default hook timeout on a loaded one.
  beforeAll(() => {
    for (const kind of AIRCRAFT_KINDS) {
      for (const gear of [0, 1]) built.set(`${kind}/${gear}`, builtAirframe(kind, gear));
    }
  }, 120_000);
  afterAll(() => {
    for (const b of built.values()) b.dispose();
  });

  for (const kind of AIRCRAFT_KINDS) {
    const framing = aircraftSpec(kind).topFront;

    it(`fills 60% of the frame with the ${kind} along the axis it fills first, gear up`, () => {
      for (const view of ["top", "front"] as const) {
        const f = frame(built.get(`${kind}/0`)!, view, framing);
        const fill = Math.max(f.width, f.height);
        expect(fill, `${kind} ${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeGreaterThan(0.58);
        expect(fill, `${kind} ${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeLessThan(0.62);
      }
    });

    it(`keeps the whole ${kind} in front of the camera and inside the frame, gear up or down`, () => {
      for (const gear of [0, 1]) {
        for (const view of ["top", "front"] as const) {
          const f = frame(built.get(`${kind}/${gear}`)!, view, framing);
          const label = `${kind} ${view} gear ${gear}`;
          expect(f.inFront, label).toBe(true);
          expect(f.left, label).toBeGreaterThan(0.1);
          expect(f.right, label).toBeLessThan(0.9);
          expect(f.top, label).toBeGreaterThan(0.1);
          expect(f.bottom, label).toBeLessThan(0.9);
        }
      }
    });

    it(`centres the ${kind}: across exactly, and within 2% (top) or 4% (front) up and down`, () => {
      const top = frame(built.get(`${kind}/0`)!, "top", framing);
      const front = frame(built.get(`${kind}/0`)!, "front", framing);
      expect(Math.abs((top.left + top.right) / 2 - 0.5)).toBeLessThan(1e-3);
      expect(Math.abs((front.left + front.right) / 2 - 0.5)).toBeLessThan(1e-3);
      expect(Math.abs((top.top + top.bottom) / 2 - 0.5)).toBeLessThan(0.02);
      expect(Math.abs((front.top + front.bottom) / 2 - 0.5)).toBeLessThan(0.04);
    });

    it(`points the ${kind}'s nose up the top view's screen, and at the front view's camera`, () => {
      const top = frame(built.get(`${kind}/0`)!, "top", framing);
      expect(top.noseY).toBeLessThan(top.tailY);
      const front = frame(built.get(`${kind}/0`)!, "front", framing);
      expect(front.noseDepth).toBeLessThan(front.tailDepth);
    });
  }

  it("needs the centre: aimed at the 747's centre of gravity instead, the front view sits off by more than the tolerance", () => {
    const framing = aircraftSpec("airliner").topFront;
    const atOrigin = { ...framing, centreForward: 0, centreUp: 0 };
    const f = frame(built.get("airliner/0")!, "front", atOrigin);
    expect(Math.abs((f.top + f.bottom) / 2 - 0.5)).toBeGreaterThan(0.04);
  });

  it("needs the long lens: at the orbit's 58 degrees the F-16 sinks more than the tolerance below centre", () => {
    const framing = aircraftSpec("jet").topFront;
    const b = built.get("jet/0")!;
    // The distance that fills 60% at 58 degrees (measured: 16.76 m).
    const wide = { ...framing, frontDistanceMeters: 16.76 };
    const forward = v(1, 0, 0);
    const up = v(0, 1, 0);
    const { camera: eye, target } = rig("front", forward, up, wide);
    b.camera.fov = (58 * Math.PI) / 180;
    b.camera.position.set(eye.x, eye.y, eye.z);
    b.camera.upVector.set(0, 1, 0);
    b.camera.setTarget(new Vector3(target.x, target.y, target.z));
    const transform = b.camera.getViewMatrix(true).multiply(b.camera.getProjectionMatrix(true));
    const viewport = b.camera.viewport.toGlobal(WIDTH, HEIGHT);
    let top = Infinity;
    let bottom = -Infinity;
    for (const p of b.points) {
      const y = Vector3.Project(p, Matrix.Identity(), transform, viewport).y / HEIGHT;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    expect((top + bottom) / 2 - 0.5).toBeGreaterThan(0.04);
  });
});

describe("the speedboat's top and front framing, on the built boat at 16:9", () => {
  let built: ReturnType<typeof builtBoat>;
  beforeAll(() => {
    built = builtBoat();
  }, 60_000);
  afterAll(() => built.dispose());
  const framing = surfaceVehicleSpec("speedboat").topFront;

  it("fills 60% of the frame with the boat along the axis it fills first", () => {
    for (const view of ["top", "front"] as const) {
      const f = frame(built, view, framing);
      const fill = Math.max(f.width, f.height);
      expect(fill, `${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeGreaterThan(0.58);
      expect(fill, `${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeLessThan(0.62);
    }
  });

  it("keeps the whole boat in front of the camera and inside the frame", () => {
    for (const view of ["top", "front"] as const) {
      const f = frame(built, view, framing);
      expect(f.inFront, view).toBe(true);
      expect(f.left, view).toBeGreaterThan(0.1);
      expect(f.right, view).toBeLessThan(0.9);
      expect(f.top, view).toBeGreaterThan(0.1);
      expect(f.bottom, view).toBeLessThan(0.9);
    }
  });

  it("centres the boat: across exactly, and within 2% (top) or 4% (front) up and down", () => {
    const top = frame(built, "top", framing);
    const front = frame(built, "front", framing);
    expect(Math.abs((top.left + top.right) / 2 - 0.5)).toBeLessThan(1e-3);
    expect(Math.abs((front.left + front.right) / 2 - 0.5)).toBeLessThan(1e-3);
    expect(Math.abs((top.top + top.bottom) / 2 - 0.5)).toBeLessThan(0.02);
    expect(Math.abs((front.top + front.bottom) / 2 - 0.5)).toBeLessThan(0.04);
  });

  it("points the bow up the top view's screen, and at the front view's camera", () => {
    const top = frame(built, "top", framing);
    expect(top.noseY).toBeLessThan(top.tailY);
    const front = frame(built, "front", framing);
    expect(front.noseDepth).toBeLessThan(front.tailDepth);
  });
});

describe("the LandCruiser's top and front framing, on the built car at 16:9", () => {
  let built: ReturnType<typeof builtCar>;
  beforeAll(() => {
    built = builtCar();
  }, 60_000);
  afterAll(() => built.dispose());
  const framing = surfaceVehicleSpec("landcruiser").topFront;

  it("fills 60% of the frame with the car along the axis it fills first", () => {
    for (const view of ["top", "front"] as const) {
      const f = frame(built, view, framing);
      const fill = Math.max(f.width, f.height);
      expect(fill, `${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeGreaterThan(0.58);
      expect(fill, `${view}: ${f.width.toFixed(3)} x ${f.height.toFixed(3)}`).toBeLessThan(0.62);
    }
  });

  it("keeps the whole car in front of the camera and inside the frame", () => {
    for (const view of ["top", "front"] as const) {
      const f = frame(built, view, framing);
      expect(f.inFront, view).toBe(true);
      expect(f.left, view).toBeGreaterThan(0.1);
      expect(f.right, view).toBeLessThan(0.9);
      expect(f.top, view).toBeGreaterThan(0.1);
      expect(f.bottom, view).toBeLessThan(0.9);
    }
  });

  it("centres the car: across within 1% (the snorkel and the right mirror are on one side), and within 2% (top) or 4% (front) up and down", () => {
    const top = frame(built, "top", framing);
    const front = frame(built, "front", framing);
    expect(Math.abs((top.left + top.right) / 2 - 0.5)).toBeLessThan(0.01);
    expect(Math.abs((front.left + front.right) / 2 - 0.5)).toBeLessThan(0.01);
    expect(Math.abs((top.top + top.bottom) / 2 - 0.5)).toBeLessThan(0.02);
    expect(Math.abs((front.top + front.bottom) / 2 - 0.5)).toBeLessThan(0.04);
  });

  it("points the bonnet up the top view's screen, and at the front view's camera", () => {
    const top = frame(built, "top", framing);
    expect(top.noseY).toBeLessThan(top.tailY);
    const front = frame(built, "front", framing);
    expect(front.noseDepth).toBeLessThan(front.tailDepth);
  });
});

/**
 * The car's chase rig at rest, as `updateCamera` composes it level on flat
 * ground: `chaseRigOffsetsToRef` with the catalogue profile at 0 m/s, the
 * shared aim height and no trail, through the profile's horizontal lens.
 */
function chaseFrame(built: ReturnType<typeof builtCar>): Framed {
  const profile = chaseCameraProfile("landcruiser", 0);
  const forward = v(1, 0, 0);
  const up = v(0, 1, 0);
  const lift = v();
  cameraRigLiftToRef(forward, up, cameraBankFollow("chase", false), lift);
  const eye = v();
  const target = v();
  chaseRigOffsetsToRef(forward, lift, profile.distance, profile.height, profile.aimAhead, CHASE_AIM_HEIGHT_METERS, 0, eye, target);
  const { camera, points } = built;
  camera.fov = (profile.fieldOfView * Math.PI) / 180;
  camera.position.set(eye.x, eye.y, eye.z);
  camera.upVector.set(0, 1, 0);
  camera.setTarget(new Vector3(target.x, target.y, target.z));
  const transform = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
  const viewport = camera.viewport.toGlobal(WIDTH, HEIGHT);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let inFront = true;
  const view = camera.getViewMatrix(true);
  for (const point of points) {
    const screen = Vector3.Project(point, Matrix.Identity(), transform, viewport);
    left = Math.min(left, screen.x / WIDTH);
    right = Math.max(right, screen.x / WIDTH);
    top = Math.min(top, screen.y / HEIGHT);
    bottom = Math.max(bottom, screen.y / HEIGHT);
    if (!(Vector3.TransformCoordinates(point, view).z < 0)) inFront = false;
  }
  return {
    width: right - left, height: bottom - top, left, right, top, bottom, inFront,
    noseY: 0, tailY: 0, noseDepth: 0, tailDepth: 0,
  };
}

describe("the LandCruiser's chase framing, on the built car at 16:9", () => {
  let built: ReturnType<typeof builtCar>;
  beforeAll(() => {
    built = builtCar();
  }, 60_000);
  afterAll(() => built.dispose());

  // Measured: width 0.207, roof at 0.515, tyres' feet at 0.916 of the frame.
  it("stands the camera 7.5 m behind the rear bumper and 2.6 m up, so the car fills about a fifth of the width", () => {
    const f = chaseFrame(built);
    expect(f.inFront).toBe(true);
    expect(f.width, f.width.toFixed(3)).toBeGreaterThan(0.19);
    expect(f.width, f.width.toFixed(3)).toBeLessThan(0.23);
  });

  it("keeps the whole car in frame, its roof at the frame's middle and its tyres clear of the bottom edge", () => {
    const f = chaseFrame(built);
    expect(Math.abs((f.left + f.right) / 2 - 0.5)).toBeLessThan(0.01);
    expect(f.top, f.top.toFixed(3)).toBeGreaterThan(0.47);
    expect(f.top, f.top.toFixed(3)).toBeLessThan(0.56);
    expect(f.bottom, f.bottom.toFixed(3)).toBeLessThan(0.93);
  });
});
