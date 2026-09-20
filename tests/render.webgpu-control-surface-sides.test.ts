import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

/**
 * Which way do the control surfaces actually move?
 *
 * Pinned in WORLD SPACE against the pilot-facing contract, deliberately
 * reading no declaration — the same discipline as
 * `tests/sim.body-axis-contract.test.ts`, and for the same reason. The
 * ailerons shipped on the wrong wings for both airframes precisely because
 * every layer agreed with the layer next to it: `applyCommonPose` drives
 * `ailerons[0]` with `pose.starboardAileron`, `resolveAircraftAnimationPose`
 * gives that the correct sign, and the node named `starboard-aileron` was
 * simply built at z = -2.4 — the port wing. Nothing that consults a name can
 * catch that. Measuring where the metal goes can.
 *
 * The contract, from `sim.body-axis-contract`: body +X is the nose, +Y is up,
 * +Z is starboard, a positive pilot roll is right-wing-down and a positive
 * pilot yaw is nose-right. What an aeroplane does with those:
 *
 *   roll right  -> starboard aileron UP,   port aileron DOWN
 *   pitch up    -> elevator UP
 *   yaw right   -> rudder trailing edge to STARBOARD
 *
 * The aircraft is left at the identity orientation, so body axes and world
 * axes coincide and "up" in the assertions below is genuinely up.
 */

interface Fixture {
  engine: NullEngine;
  scene: Scene;
  visual: AircraftVisual;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.visual.dispose();
    fixture.scene.dispose();
    fixture.engine.dispose();
  }
});

function build(kind: AircraftKind): Fixture {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, kind);
  const fixture: Fixture = { engine, scene, visual };
  fixtures.push(fixture);
  return fixture;
}

function fly(visual: AircraftVisual, controls: Partial<FlightVisualState>): void {
  const state: FlightVisualState = {
    ...INITIAL_VISUAL_STATE,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: 60,
    engineRpm: 2_000,
    altitudeAgl: 400,
    altitude: 400,
    gear: 1,
    ...controls,
  };
  visual.update(state, 1 / 60);
}

/**
 * The world position of the aftmost point of a surface: its trailing edge.
 *
 * Read off the mesh's own vertices rather than a node origin, because a
 * control surface rotates ABOUT its hinge — the node does not move at all, and
 * only the metal behind the hinge tells you which way the surface went.
 */
function extremeVertex(
  scene: Scene,
  meshName: string,
  axis: "x" | "y" | "z",
  direction: 1 | -1,
): Vector3 {
  const mesh = scene.getMeshByName(meshName);
  if (!mesh) throw new Error(`Missing mesh ${meshName}`);
  const positions = mesh.getVerticesData("position");
  if (!positions) throw new Error(`${meshName} has no positions`);
  const world = mesh.computeWorldMatrix(true);
  const local = new Vector3();
  let best: Vector3 | null = null;
  for (let index = 0; index < positions.length; index += 3) {
    local.set(positions[index]!, positions[index + 1]!, positions[index + 2]!);
    const point = Vector3.TransformCoordinates(local, world);
    if (!best || point[axis] * direction > best[axis] * direction) best = point;
  }
  return best!;
}

/**
 * Which way a wheel is pointing, as the heading of its rolling direction in
 * degrees: 0 straight ahead, positive to starboard.
 *
 * Taken from the principal axis of the tyre's vertices projected on the ground
 * plane. A tyre is a disc: in that plane its points spread across the whole
 * diameter along the rolling direction and only across the tread width along
 * the axle, so the long axis IS the rolling direction. Reading an extreme
 * vertex instead does not work — every point on the rim shares the extreme,
 * and which one is returned is arbitrary.
 */
function wheelHeadingDegrees(scene: Scene, meshName: string): number {
  const mesh = scene.getMeshByName(meshName);
  if (!mesh) throw new Error(`Missing mesh ${meshName}`);
  const positions = mesh.getVerticesData("position");
  if (!positions) throw new Error(`${meshName} has no positions`);
  const world = mesh.computeWorldMatrix(true);
  const local = new Vector3();
  const points: { x: number; z: number }[] = [];
  let sumX = 0;
  let sumZ = 0;
  for (let index = 0; index < positions.length; index += 3) {
    local.set(positions[index]!, positions[index + 1]!, positions[index + 2]!);
    const point = Vector3.TransformCoordinates(local, world);
    points.push({ x: point.x, z: point.z });
    sumX += point.x;
    sumZ += point.z;
  }
  const centreX = sumX / points.length;
  const centreZ = sumZ / points.length;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const point of points) {
    const dx = point.x - centreX;
    const dz = point.z - centreZ;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  // Principal axis of the 2x2 covariance, resolved onto the forward half so
  // the answer is a heading rather than an undirected line.
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  return (angle * 180) / Math.PI;
}

/** Aftmost point of a surface: most-negative body X, because +X is the nose. */
function trailingEdge(scene: Scene, meshName: string): Vector3 {
  return extremeVertex(scene, meshName, "x", -1);
}

/** The surface built on the given side, found by where it IS, not by its name. */
function surfaceOnSide(
  scene: Scene,
  candidates: readonly string[],
  side: "port" | "starboard",
): string {
  const placed = candidates.map((name) => ({ name, z: trailingEdge(scene, name).z }));
  const wanted = side === "starboard"
    ? placed.reduce((best, item) => (item.z > best.z ? item : best))
    : placed.reduce((best, item) => (item.z < best.z ? item : best));
  return wanted.name;
}

const KINDS: readonly AircraftKind[] = AIRCRAFT_KINDS;

/** The jet's tail surfaces carry their own prefix. */
function elevatorSurfaces(kind: AircraftKind): readonly string[] {
  if (kind === "jet") return ["starboard-jet-elevator-surface", "port-jet-elevator-surface"];
  if (kind === "bizjet") {
    return ["starboard-bizjet-elevator-surface", "port-bizjet-elevator-surface"];
  }
  return ["starboard-elevator-surface", "port-elevator-surface"];
}

describe("control surfaces move the way the pilot's controls promise", () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it("raises the starboard aileron and drops the port one in a roll to the right", () => {
        const { scene, visual } = build(kind);
        const names = ["starboard-aileron-surface", "port-aileron-surface"];
        const starboard = surfaceOnSide(scene, names, "starboard");
        const port = surfaceOnSide(scene, names, "port");

        fly(visual, { aileron: 0 });
        const starboardNeutral = trailingEdge(scene, starboard).y;
        const portNeutral = trailingEdge(scene, port).y;

        fly(visual, { aileron: 1 });
        const starboardRolled = trailingEdge(scene, starboard).y;
        const portRolled = trailingEdge(scene, port).y;

        // Right roll: lift comes off the right wing and goes on to the left.
        expect(starboardRolled).toBeGreaterThan(starboardNeutral + 0.01);
        expect(portRolled).toBeLessThan(portNeutral - 0.01);
      });

      it("mirrors that exactly in a roll to the left", () => {
        const { scene, visual } = build(kind);
        const names = ["starboard-aileron-surface", "port-aileron-surface"];
        const starboard = surfaceOnSide(scene, names, "starboard");
        const port = surfaceOnSide(scene, names, "port");

        fly(visual, { aileron: 0 });
        const starboardNeutral = trailingEdge(scene, starboard).y;
        const portNeutral = trailingEdge(scene, port).y;
        fly(visual, { aileron: -1 });
        const starboardRolled = trailingEdge(scene, starboard).y;
        const portRolled = trailingEdge(scene, port).y;

        expect(starboardRolled).toBeLessThan(starboardNeutral - 0.01);
        expect(portRolled).toBeGreaterThan(portNeutral + 0.01);
      });

      it("raises the elevator to pitch up", () => {
        const { scene, visual } = build(kind);
        const names = elevatorSurfaces(kind);
        fly(visual, { elevator: 0 });
        const neutral = names.map((name) => trailingEdge(scene, name).y);
        fly(visual, { elevator: 1 });
        const pitched = names.map((name) => trailingEdge(scene, name).y);
        for (const [index, height] of pitched.entries()) {
          expect(height).toBeGreaterThan(neutral[index]! + 0.01);
        }
      });

      it("swings the rudder to starboard to yaw right", () => {
        const { scene, visual } = build(kind);
        fly(visual, { rudder: 0 });
        const neutral = trailingEdge(scene, "rudder-surface").z;
        fly(visual, { rudder: 1 });
        const yawed = trailingEdge(scene, "rudder-surface").z;
        expect(yawed).toBeGreaterThan(neutral + 0.01);
      });

      it("keeps both elevator halves together and both ailerons opposed", () => {
        // A stabilator that split, or ailerons that moved as one, would be a
        // different defect from a swapped side and would pass the tests above
        // on one surface alone.
        const { scene, visual } = build(kind);
        fly(visual, { elevator: 1, aileron: 1 });
        const elevators = elevatorSurfaces(kind).map((name) => trailingEdge(scene, name).y);
        expect(elevators[0]).toBeCloseTo(elevators[1]!, 6);

        const names = ["starboard-aileron-surface", "port-aileron-surface"];
        const starboard = trailingEdge(scene, surfaceOnSide(scene, names, "starboard")).y;
        const port = trailingEdge(scene, surfaceOnSide(scene, names, "port")).y;
        expect(Math.sign(starboard - port)).toBe(1);
      });
    });
  }

  for (const kind of KINDS) {
    it(`steers the ${kind}'s nosewheel toward the rudder the pilot is pressing`, () => {
      // Right rudder on the ground turns the aeroplane right, so the
      // nosewheel points right. Note this is the OPPOSITE node rotation to the
      // rudder surface and correctly so: the rudder's trailing edge swings to
      // starboard while the wheel's tread turns to starboard.
      const { scene, visual } = build(kind);
      const ground = { onGround: true, altitudeAgl: 0, airspeed: 5 };
      fly(visual, { ...ground, rudder: 0 });
      const neutral = wheelHeadingDegrees(scene, "nose-wheel-tire");
      fly(visual, { ...ground, rudder: 1 });
      const right = wheelHeadingDegrees(scene, "nose-wheel-tire");
      fly(visual, { ...ground, rudder: -1 });
      const left = wheelHeadingDegrees(scene, "nose-wheel-tire");
      expect(neutral).toBeCloseTo(0, 4);
      expect(right).toBeGreaterThan(2);
      expect(left).toBeLessThan(-2);
    });
  }

  for (const kind of KINDS) {
    it(`leaves the ${kind}'s nosewheel straight once airborne`, () => {
      const { scene, visual } = build(kind);
      fly(visual, { rudder: 1, onGround: false, altitudeAgl: 400 });
      expect(wheelHeadingDegrees(scene, "nose-wheel-tire")).toBeCloseTo(0, 4);
    });
  }
});
