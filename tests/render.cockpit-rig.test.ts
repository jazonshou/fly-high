import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import {
  COCKPIT_AIM_DISTANCE_METERS,
  COCKPIT_HORIZONTAL_FOV_DEGREES,
  PERF_COCKPIT_HORIZONTAL_FOV_DEGREES,
  PERF_COCKPIT_RIG,
  cockpitEyeRightMeters,
  cockpitFieldOfViewDegrees,
  cockpitRigPositionsToRef,
} from "../src/render/cameraPresentation";
import { createWebGpuAircraft } from "../src/render/webgpu/aircraft";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

/**
 * The cockpit rig: which lens a player gets, where the pilot's eye is, and
 * that nothing but the perf harness can change either.
 *
 * Each test here has a control — the value it replaced, put back, makes it
 * fail — because a rig test that passes on the old rig is a test of nothing.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "artifacts") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) found.push(path);
  }
  return found;
}

const rel = (path: string) => relative(ROOT, path).split("\\").join("/");
const read = (path: string) => readFileSync(path, "utf8");
const THIS_FILE = rel(fileURLToPath(import.meta.url));

describe("cockpit lens", () => {
  it("is 75 degrees horizontal for a player and 56 for the perf harness, as two constants", () => {
    expect(COCKPIT_HORIZONTAL_FOV_DEGREES).toBe(75);
    expect(PERF_COCKPIT_HORIZONTAL_FOV_DEGREES).toBe(56);
    expect(COCKPIT_HORIZONTAL_FOV_DEGREES).not.toBe(PERF_COCKPIT_HORIZONTAL_FOV_DEGREES);
  });

  it("is what the renderer resolves: gameplay by default, perf only through the override", () => {
    expect(cockpitFieldOfViewDegrees(null)).toBe(COCKPIT_HORIZONTAL_FOV_DEGREES);
    expect(cockpitFieldOfViewDegrees(PERF_COCKPIT_RIG)).toBe(PERF_COCKPIT_HORIZONTAL_FOV_DEGREES);
    expect(PERF_COCKPIT_RIG.horizontalFovDegrees).toBe(PERF_COCKPIT_HORIZONTAL_FOV_DEGREES);
  });

  it("frames azimuth +-37.5 and elevation +-23.35 at 16:9, the angles the cockpit geometry is built to", () => {
    const tanHalfHorizontal = Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
    const halfElevation = (Math.atan(tanHalfHorizontal * (9 / 16)) * 180) / Math.PI;
    expect(COCKPIT_HORIZONTAL_FOV_DEGREES / 2).toBe(37.5);
    expect(halfElevation).toBeCloseTo(23.35, 1);
    // The lens this replaced put the bottom of the frame at 16.7 degrees, above
    // every instrument (17 to 25 degrees below the eye).
    const oldHalfElevation = (Math.atan(Math.tan((56 * Math.PI) / 360) * (9 / 16)) * 180) / Math.PI;
    expect(oldHalfElevation).toBeCloseTo(16.7, 1);
    expect(halfElevation).toBeGreaterThan(oldHalfElevation + 6);
  });
});

describe("only the perf harness may override the cockpit rig", () => {
  it("is named nowhere under src/ but the renderer and the presentation module", () => {
    const allowed = new Set(["src/render/FlightRenderer.ts", "src/render/cameraPresentation.ts"]);
    const offenders = sourceFiles(join(ROOT, "src"))
      .map(rel)
      .filter((path) => !allowed.has(path))
      .filter((path) => /cockpitRigOverride|PERF_COCKPIT_RIG|PERF_COCKPIT_HORIZONTAL_FOV_DEGREES/.test(read(join(ROOT, path))));
    // A player on the perf lens would render without anything failing.
    expect(offenders).toEqual([]);
  });

  it("takes the override as an OPTION and never imports the perf constants into the renderer", () => {
    const renderer = read(join(ROOT, "src/render/FlightRenderer.ts"));
    expect(renderer).toMatch(/cockpitRigOverride\?: CockpitRigOverride/);
    expect(renderer).not.toMatch(/PERF_COCKPIT/);
    // The literal it replaced must not come back.
    expect(renderer).not.toMatch(/fieldOfView\s*=\s*56\b/);
  });

  it("has exactly one caller outside src/: the perf harness, passing the perf rig", () => {
    const callers = [...sourceFiles(join(ROOT, "tests")), ...sourceFiles(join(ROOT, "scripts"))]
      .map(rel)
      .filter((path) => path !== THIS_FILE)
      .filter((path) => /cockpitRigOverride/.test(read(join(ROOT, path))));
    expect(callers).toEqual(["tests/perf/perf-capture.test.ts"]);
    expect(read(join(ROOT, "tests/perf/perf-capture.test.ts"))).toMatch(
      /cockpitRigOverride:\s*PERF_COCKPIT_RIG/,
    );
  });
});

// --- the rig's arithmetic ---------------------------------------------------

interface Quat { x: number; y: number; z: number; w: number }
type Triple = readonly [number, number, number];

function axisAngle(axis: Triple, radians: number): Quat {
  const s = Math.sin(radians / 2);
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(radians / 2) };
}
function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
/** v' = v + 2w(q.xyz x v) + 2(q.xyz x (q.xyz x v)) */
function rotate(q: Quat, v: Triple): Triple {
  const cx = q.y * v[2] - q.z * v[1];
  const cy = q.z * v[0] - q.x * v[2];
  const cz = q.x * v[1] - q.y * v[0];
  const dx = q.y * cz - q.z * cy;
  const dy = q.z * cx - q.x * cz;
  const dz = q.x * cy - q.y * cx;
  return [
    v[0] + 2 * (q.w * cx + dx),
    v[1] + 2 * (q.w * cy + dy),
    v[2] + 2 * (q.w * cz + dz),
  ];
}
/** Yaw about +Y, pitch about +Z, bank about the body's own +X: the order an aeroplane applies them. */
function orientation(yawDegrees: number, pitchDegrees: number, bankDegrees: number): Quat {
  const d = Math.PI / 180;
  return multiply(
    multiply(axisAngle([0, 1, 0], yawDegrees * d), axisAngle([0, 0, 1], pitchDegrees * d)),
    axisAngle([1, 0, 0], bankDegrees * d),
  );
}

const ATTITUDES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [90, 0, 0], [37, 12, 0], [200, -25, 0], [15, 5, 30], [-70, 40, -60], [123, -8, 90], [300, 18, 170],
];
const ORIGIN: Triple = [1_234.5, 872.25, -4_321.75];

function build(q: Quat, eye: { forward: number; up: number }, eyeRight: number) {
  const forward = rotate(q, [1, 0, 0]);
  const up = rotate(q, [0, 1, 0]);
  const camera = { x: 0, y: 0, z: 0 };
  const target = { x: 0, y: 0, z: 0 };
  cockpitRigPositionsToRef(
    { x: ORIGIN[0], y: ORIGIN[1], z: ORIGIN[2] },
    { x: forward[0], y: forward[1], z: forward[2] },
    { x: up[0], y: up[1], z: up[2] },
    eye,
    eyeRight,
    COCKPIT_AIM_DISTANCE_METERS,
    camera,
    target,
  );
  return { forward, up, camera, target };
}

describe("cockpit rig arithmetic", () => {
  it("reproduces the camera it had before there was a lateral eye, to the last bit, when the offset is zero", () => {
    // This is what lets the fourteen perf shots stay comparable: the pinned rig
    // must not move the camera by so much as a rounding error.
    const eye = aircraftSpec("trainer").cockpitEye;
    for (const [yaw, pitch, bank] of ATTITUDES) {
      const { forward, up, camera, target } = build(orientation(yaw, pitch, bank), eye, 0);
      const f = new Vector3(...forward);
      const u = new Vector3(...up);
      // The renderer's cockpit branch, verbatim, before the lateral term.
      const legacyCamera = new Vector3(...ORIGIN)
        .addInPlace(f.scale(eye.forward))
        .addInPlace(u.scale(eye.up));
      const legacyTarget = legacyCamera.clone().addInPlace(f.scale(400));
      expect(COCKPIT_AIM_DISTANCE_METERS).toBe(400);
      expect(camera.x).toBe(legacyCamera.x);
      expect(camera.y).toBe(legacyCamera.y);
      expect(camera.z).toBe(legacyCamera.z);
      expect(target.x).toBe(legacyTarget.x);
      expect(target.y).toBe(legacyTarget.y);
      expect(target.z).toBe(legacyTarget.z);
    }
  });

  it("places the eye at forward, up and right IN THE BODY FRAME at any attitude", () => {
    // An independent formulation: rotate the body-frame eye vector by the
    // orientation, rather than building it from forward x up. It fails if the
    // lateral axis is starboard's mirror image, or if it does not roll with
    // the airframe.
    for (const kind of AIRCRAFT_KINDS) {
      const eye = aircraftSpec(kind).cockpitEye;
      for (const [yaw, pitch, bank] of ATTITUDES) {
        const q = orientation(yaw, pitch, bank);
        const { camera } = build(q, eye, eye.right);
        const expected = rotate(q, [eye.forward, eye.up, eye.right]);
        expect(camera.x).toBeCloseTo(ORIGIN[0] + expected[0], 9);
        expect(camera.y).toBeCloseTo(ORIGIN[1] + expected[1], 9);
        expect(camera.z).toBeCloseTo(ORIGIN[2] + expected[2], 9);
      }
    }
  });

  it("aims parallel to the body axis from wherever the eye is", () => {
    // The aim point carries the eye's lateral offset. Aiming at a point on the
    // centreline instead would toe the view in and the HUD's centre mark would
    // stop meaning "where the nose points".
    for (const kind of AIRCRAFT_KINDS) {
      const eye = aircraftSpec(kind).cockpitEye;
      for (const [yaw, pitch, bank] of ATTITUDES) {
        const { forward, camera, target } = build(orientation(yaw, pitch, bank), eye, eye.right);
        const view = [target.x - camera.x, target.y - camera.y, target.z - camera.z] as const;
        const length = Math.hypot(...view);
        expect(length).toBeCloseTo(COCKPIT_AIM_DISTANCE_METERS, 9);
        expect(view[0] / length).toBeCloseTo(forward[0], 12);
        expect(view[1] / length).toBeCloseTo(forward[1], 12);
        expect(view[2] / length).toBeCloseTo(forward[2], 12);
      }
    }
  });

  it("moves a left-seat eye to PORT: negative body Z is to the left of the nose", () => {
    const eye = aircraftSpec("bizjet").cockpitEye;
    const level = build(orientation(0, 0, 0), eye, eye.right);
    // Heading +X, wings level: starboard is +Z, so port is smaller Z.
    expect(level.camera.z - ORIGIN[2]).toBeCloseTo(-0.52, 12);
    const centred = build(orientation(0, 0, 0), eye, 0);
    expect(level.camera.z).toBeLessThan(centred.camera.z);
  });

  it("drops the lateral offset only for the perf rig", () => {
    for (const kind of AIRCRAFT_KINDS) {
      const eye = aircraftSpec(kind).cockpitEye;
      expect(cockpitEyeRightMeters(eye, null)).toBe(eye.right);
      expect(cockpitEyeRightMeters(eye, PERF_COCKPIT_RIG)).toBe(0);
    }
  });
});

// --- the eye against the seat ------------------------------------------------

function worldVertices(mesh: AbstractMesh): Vector3[] {
  const data = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!data) return [];
  const world = mesh.getWorldMatrix();
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(data[i]!, data[i + 1]!, data[i + 2]!), world));
  }
  return out;
}

function portSeat(kind: AircraftKind): { name: string; z: number; note: string | null } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  try {
    createWebGpuAircraft(scene, kind);
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    // By GEOMETRY: the seat furthest to port. The Global's and 747's seat
    // NAMES are swapped — the mesh called captain-seat sits at +Z, starboard,
    // and a captain sits on the left — so a name would pick the wrong one.
    const seats = scene.meshes
      .filter((mesh) => /seat/.test(mesh.name) && !/headrest/.test(mesh.name))
      .map((mesh) => ({ name: mesh.name, z: mesh.getBoundingInfo().boundingBox.centerWorld.z }))
      .sort((a, b) => a.z - b.z);
    const seat = seats[0];
    if (seat) {
      const captain = seats.find((candidate) => /captain/.test(candidate.name));
      return {
        ...seat,
        note: captain
          ? `${kind}: the mesh named "${captain.name}" sits at z ${captain.z.toFixed(2)} (${captain.z > 0 ? "STARBOARD" : "port"}); a captain sits on the left`
          : null,
      };
    }

    // No mesh is named for a seat: the 747's static parts were folded into one
    // mesh per material (House-Keeping 3d56234), so both seats live inside
    // `airliner-flight-deck-interior` and only their NAMES survive, in
    // `metadata.mergedFrom`. The port seat is then measured from that mesh's
    // vertices: everything within 0.7 m of the eye's station is seating (the
    // panel board, the only other part in the mesh, is 1.15 m ahead of it),
    // and the port half of that is the port seat.
    const merged = scene.meshes.find((mesh) =>
      ((mesh.metadata as { mergedFrom?: string[] } | null)?.mergedFrom ?? [])
        .some((part) => /seat/.test(part) && !/headrest/.test(part)));
    if (!merged) throw new Error(`${kind}: no seat mesh, and no merged mesh that lists one in mergedFrom`);
    const stationLimit = aircraftSpec(kind).cockpitEye.forward + 0.7;
    const port = worldVertices(merged).filter((v) => v.x < stationLimit && v.z < 0);
    const zs = port.map((v) => v.z);
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    if (port.length === 0 || zMax - zMin < 0.4 || zMax - zMin > 0.8) {
      throw new Error(`${kind}: the port cluster in "${merged.name}" is ${port.length} vertices spanning z ${zMin}..${zMax}; that is not a seat`);
    }
    return {
      name: `${merged.name} (port seat measured from vertices)`,
      z: (zMin + zMax) / 2,
      note: `${kind}: seats are folded into "${merged.name}"; the seat names in mergedFrom are ${JSON.stringify((merged.metadata as { mergedFrom: string[] }).mergedFrom.filter((part) => /seat/.test(part) && !/headrest/.test(part)))}, in build order (captain built first, at +Z, starboard)`,
    };
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

describe("cockpit eye against the pilot's seat", () => {
  it.each(AIRCRAFT_KINDS)("%s: the eye is over the port seat, or on the centreline of a single seat", (kind) => {
    const seat = portSeat(kind);
    if (seat.note) console.info(seat.note);
    const right = aircraftSpec(kind).cockpitEye.right;
    if (kind === "jet") {
      // One seat, on the centreline.
      expect(Math.abs(seat.z)).toBeLessThanOrEqual(0.02);
      expect(right).toBe(0);
    } else {
      // Two seats: the pilot's is the PORT one (negative Z).
      expect(seat.z).toBeLessThan(-0.1);
      expect(Math.abs(right - seat.z)).toBeLessThanOrEqual(0.02);
      // The control: the eye where it used to be — on the centreline, between
      // the two seats — is well outside the tolerance, so this can fail.
      expect(Math.abs(0 - seat.z)).toBeGreaterThan(0.02);
    }
  });
});

// --- the perf oracle's default lens is the constant, not a copy of its value ---

describe("the perf placement oracle reads the perf lens", () => {
  afterEach(() => {
    vi.doUnmock("../src/render/cameraPresentation");
    vi.resetModules();
  });

  // A wall of terrain to starboard: a ray hits it once it has travelled more
  // than 60 m sideways before reaching the sea, which a wider lens does more
  // often. So the lens is visible in the answer.
  const scene = {
    aircraftPosition: [0, 100, 0] as const,
    yawDegrees: 0,
    pitchDownDegrees: 30,
    seaLevelMeters: 0,
    terrainHeightAt: (_x: number, z: number) => (z > 60 ? 1_000 : -100),
    viewportWidth: 1_280,
    viewportHeight: 720,
  };

  it("defaults to the perf lens and the lens matters in this scene", async () => {
    const { cockpitTerrainCoverage } = await import("../scripts/perf-capture.mts");
    const implicit = cockpitTerrainCoverage(scene);
    const perf = cockpitTerrainCoverage({ ...scene, horizontalFovDegrees: PERF_COCKPIT_HORIZONTAL_FOV_DEGREES });
    const gameplay = cockpitTerrainCoverage({ ...scene, horizontalFovDegrees: COCKPIT_HORIZONTAL_FOV_DEGREES });
    expect(implicit).toEqual(perf);
    // The control: the same scene at the gameplay lens gives a different answer.
    expect(gameplay.terrainHitFraction).toBeGreaterThan(perf.terrainHitFraction);
  });

  it("follows the constant rather than a copy of its value", async () => {
    // Change the constant the module imports and the default must follow. A
    // literal 56 left behind agrees with the real constant and fails only here.
    vi.resetModules();
    vi.doMock("../src/render/cameraPresentation", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/render/cameraPresentation")>()),
      PERF_COCKPIT_HORIZONTAL_FOV_DEGREES: 90,
    }));
    const shifted = await import("../scripts/perf-capture.mts");
    const implicit = shifted.cockpitTerrainCoverage(scene);
    const explicit90 = shifted.cockpitTerrainCoverage({ ...scene, horizontalFovDegrees: 90 });
    const explicit56 = shifted.cockpitTerrainCoverage({ ...scene, horizontalFovDegrees: 56 });
    expect(implicit).toEqual(explicit90);
    expect(implicit).not.toEqual(explicit56);
  });
});
