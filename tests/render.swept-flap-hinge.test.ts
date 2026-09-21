import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

/**
 * Every control surface turns about the line it is hinged on.
 *
 * `applyCommonPose` deflects a surface by writing `rotation.z` (or `rotation.y`
 * for a rudder), which is a rotation about the AIRFRAME's axis. For an unswept
 * hinge that is the same axis as the surface's own. For a swept one it is not,
 * and since a hinge node is sited at its panel's inboard end, the panel's
 * outboard end is then metres away from the axis it is being turned about.
 *
 * Measured on the Global before `hingeAlong` existed: at full flap the inner
 * flap dropped 0.634 m at the root and 1.471 m at the break, and its outboard
 * end moved 64 mm FORWARD while its root moved 163 mm aft. A rigid panel wrung
 * out along its span. From the chase camera the trailing edge tore open far
 * enough to see terrain through the wing. The same construction was on the
 * F-16's flaperon and ailerons and on all four of the 747-8's flaps and all
 * four of its ailerons.
 *
 * Nothing caught it. `render.webgpu-control-surface-sides` measures WHICH WAY
 * a surface goes and is satisfied by any rotation of the right sign;
 * everything else reads declarations, and every declaration agreed with the
 * one next to it.
 *
 * So this compares two independent routes to the same direction, neither of
 * which consults a declaration:
 *
 *   - the axis the surface ACTUALLY turns about, recovered from the node's own
 *     world matrices as the skew-symmetric part of `R(rest)^-1 R(deflected)`;
 *   - the hinge line the PANEL is built on, read off its leading edge at its
 *     two extreme stations.
 *
 * Surfaces are DISCOVERED, not listed: anything with a `-surface` mesh under a
 * transform node is tested if it moves when the controls do. A renamed or
 * newly added surface is therefore covered automatically, and the per-kind
 * counts below are asserted so that a rename cannot quietly shrink the sweep
 * into a vacuous pass.
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

/** Everything deflected at once, so one pass exercises every surface. */
function deflect(visual: AircraftVisual, amount: number): void {
  const state: FlightVisualState = {
    ...INITIAL_VISUAL_STATE,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: 60,
    altitudeAgl: 400,
    altitude: 400,
    gear: 1,
    flaps: amount,
    aileron: amount,
    elevator: amount,
    rudder: amount,
    // The speed brake too. Leaving it out is how ten 747 spoilers, eight
    // Global ones and the F-16's petals sat outside this sweep: a surface the
    // pose never drives turns less than half a degree and is skipped as "not
    // driven by this pose", so the gate reported a confident pass over an
    // airframe whose spoilers it had never looked at.
    brake: amount,
    // ON THE GROUND, and for the same reason. The 747's inboard spoilers are
    // GROUND spoilers: they are stowed in the air by design, so an airborne
    // pose cannot drive them and this sweep silently dropped from fifteen
    // surfaces to thirteen the moment that behaviour was implemented. Every
    // other surface here deflects on the ground too, so the pose costs
    // nothing and covers two more hinges.
    onGround: true,
  };
  visual.update(state, 1 / 60);
}

/**
 * The panel's leading edge, one point per station, in world space.
 *
 * Stations are keyed off the panel's LOCAL coordinates — the frame it was
 * built in, which does not move when it deflects — so the same points are
 * compared at both poses.
 *
 * Two details that each produced a wrong answer before they were handled. A
 * fin spans in Y and a wing panel in Z, so the station axis is whichever the
 * panel actually runs along; keyed on Z, a rudder's "hinge line" is noise and
 * reports 90 degrees off whatever it is compared with. And where several
 * vertices tie for forwardmost — which is every box, one per face — their
 * CENTROID is taken, because picking whichever the loop saw first draws the
 * panel's diagonal instead of its leading edge, and reported the 747's rudder
 * as 4.86 degrees out when it was not.
 */
function leadingEdgeByStation(scene: Scene, meshName: string): Map<string, Vector3> {
  const mesh = scene.getMeshByName(meshName);
  if (!mesh) throw new Error(`Missing mesh ${meshName}`);
  const positions = mesh.getVerticesData("position");
  if (!positions) throw new Error(`${meshName} has no positions`);
  const world = mesh.computeWorldMatrix(true);

  let spanY = 0;
  let spanZ = 0;
  let lowY = Infinity;
  let highY = -Infinity;
  let lowZ = Infinity;
  let highZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    lowY = Math.min(lowY, positions[index + 1]!);
    highY = Math.max(highY, positions[index + 1]!);
    lowZ = Math.min(lowZ, positions[index + 2]!);
    highZ = Math.max(highZ, positions[index + 2]!);
  }
  spanY = highY - lowY;
  spanZ = highZ - lowZ;
  const stationAxis = spanY > spanZ ? 1 : 2;

  // +X is the nose, so a panel's leading edge is the forwardmost point of its
  // station.
  const forwardmost = new Map<string, number>();
  for (let index = 0; index < positions.length; index += 3) {
    const station = positions[index + stationAxis]!.toFixed(3);
    if (positions[index]! > (forwardmost.get(station) ?? Number.NEGATIVE_INFINITY)) {
      forwardmost.set(station, positions[index]!);
    }
  }
  const sums = new Map<string, { total: Vector3; count: number }>();
  for (let index = 0; index < positions.length; index += 3) {
    const station = positions[index + stationAxis]!.toFixed(3);
    if (positions[index]! < forwardmost.get(station)! - 1e-6) continue;
    const point = Vector3.TransformCoordinates(
      new Vector3(positions[index]!, positions[index + 1]!, positions[index + 2]!),
      world,
    );
    const accumulated = sums.get(station);
    if (accumulated) {
      accumulated.total.addInPlace(point);
      accumulated.count += 1;
    } else {
      sums.set(station, { total: point, count: 1 });
    }
  }
  const byStation = new Map<string, Vector3>();
  for (const [station, accumulated] of sums) {
    byStation.set(station, accumulated.total.scale(1 / accumulated.count));
  }
  return byStation;
}

/** A node's world rotation, with the translation discarded. */
function worldRotation(node: { computeWorldMatrix: (force: boolean) => Matrix }): Matrix {
  const rotation = node.computeWorldMatrix(true).clone();
  rotation.setTranslation(Vector3.Zero());
  return rotation;
}

/**
 * Surfaces whose hinge is KNOWN to be off its panel's line, each with why.
 *
 * EMPTY, and it was not. Both box rudders lived here: panels tilted about
 * their own centres to fake a swept surface against a vertical hinge, which
 * swung them forward past the hinge so the line ran THROUGH the panel — 2.26 m
 * from the leading edge on the 747 — and tilted their chords by 25.9 degrees
 * into the bargain. The entries were asserted to STILL FAIL, which is what
 * stopped the list rotting and what told this file the day they were fixed.
 *
 * Both are now sheared aerofoils whose leading edge IS the hinge line, turning
 * 0.000002 and 0.0000009 degrees off it. Leave this list empty rather than
 * deleting it: the next surface that cannot be raked wants its reason written
 * down here, and asserted to still fail.
 */
const DECLARED_UNRAKED: readonly (readonly [AircraftKind, string])[] = [];

/**
 * Surfaces whose axis is CORRECT while differing from their panel's leading
 * edge, which is a different claim from the list above.
 *
 * The F-16's tailplane is an all-moving stabilator, not a fixed surface with
 * an elevator hinged to it. An all-moving surface pivots on an actuator whose
 * axis runs across the fuselage, unswept, rather than along the panel's swept
 * leading edge -- so the 40.5 degrees between them is the aeroplane, not a
 * defect. It is named here rather than silently skipped, because the reason it
 * is exempt is the sort of thing that stops being true when someone rebuilds
 * a tail.
 */
const ALL_MOVING: readonly (readonly [AircraftKind, string])[] = [
  ["jet", "elevator"],
];

/**
 * How many surfaces must deflect, so a rename cannot shrink the sweep.
 *
 * These counts went from 6/4/9/11 to 6/8/17/15 when the pose above learned to
 * pull the speed brake and this file stopped filtering `brake` out by name —
 * sixteen more hinged surfaces, all of which hold their lines. What the sweep
 * does NOT cover it says so about: see `DECLARED_UNRAKED` and `ALL_MOVING`.
 */
const EXPECTED_DEFLECTING: Readonly<Record<AircraftKind, number>> = {
  trainer: 6,
  // Eight: two flaperons, two stabilators, the rudder... and the F-16's four
  // airbrake petals, which this gate could not see at all until `brake` came
  // out of `SPINNING`. The aeroplane's trailing edge is ONE flaperon a side,
  // which is both its flap and its aileron, so there are two wing surfaces
  // rather than four.
  jet: 8,
  // Nine plus the Global's eight spoilers, four a side.
  bizjet: 17,
  // Eleven plus the 747's four spoiler GROUPS: six panels a side, but the two
  // inboard share one hinge line and the four outboard share another, so they
  // are four hinged nodes rather than twelve.
  airliner: 15,
};

/**
 * Parts that turn without being hinged: a spinning wheel has no hinge line.
 *
 * `brake` USED TO BE IN THIS LIST, and it was reading as "wheel brake" while
 * matching `starboard-speed-brake` — so the F-16's four airbrake petals, which
 * are hinged panels and exactly what this gate is for, were filtered out by a
 * word meant for something else. The wheel parts are caught by `wheel` and
 * `axle` already.
 */
const SPINNING = /wheel|propeller|spinner|fan|spool|gear|door|strut|axle/i;

interface Measured {
  name: string;
  degreesOffHingeLine: number;
}

function measure(kind: AircraftKind): Measured[] {
  const { scene, visual } = build(kind);
  // Discovery is by PARENT CHAIN, not by name. Matching a mesh to its node by
  // shared prefix looked equivalent and silently dropped every elevator —
  // whose node is `elevator` while its panels are `port-elevator-surface` —
  // and the Cessna's flaps, whose node is `starboard-flap-hinge` and whose
  // panel is `starboard-wing-flap`. Four airframes' worth of tailplane went
  // untested and the sweep still reported a confident pass.
  const owns = (owner: TransformNode, mesh: AbstractMesh): boolean => {
    for (let walk = mesh.parent; walk; walk = walk.parent) if (walk === owner) return true;
    return false;
  };
  const candidates = scene.transformNodes
    .filter((candidate) => !candidate.name.endsWith("-frame")
      && !candidate.name.endsWith("-mount")
      && !SPINNING.test(candidate.name))
    .map((candidate) => ({
      node: candidate,
      surface: scene.meshes.find((mesh) => mesh.getTotalVertices() > 0
        && owns(candidate, mesh)),
    }))
    .filter((candidate) => candidate.surface !== undefined);

  const measured: Measured[] = [];
  for (const candidate of candidates) {
    deflect(visual, 0);
    const rest = leadingEdgeByStation(scene, candidate.surface!.name);
    const restRotation = worldRotation(candidate.node);
    deflect(visual, 1);
    const moved = leadingEdgeByStation(scene, candidate.surface!.name);
    const movedRotation = worldRotation(candidate.node);

    const relative = restRotation.clone().invert().multiply(movedRotation);
    const m = relative.m;
    const turned = Math.acos(
      Math.min(1, Math.max(-1, (m[0]! + m[5]! + m[10]! - 1) / 2)),
    );
    // A surface this pose does not drive says nothing about its axis.
    if ((turned * 180) / Math.PI < 0.5) continue;

    const stations = [...rest.keys()].sort(
      (a, b) => Math.abs(Number(a)) - Math.abs(Number(b)),
    );
    const hingeLine = rest.get(stations[stations.length - 1]!)!
      .subtract(rest.get(stations[0]!)!).normalize();
    // Sign is not meaningful: a line has two directions, and the two wings
    // recover opposite ones.
    const axis = new Vector3(m[6]! - m[9]!, m[8]! - m[2]!, m[1]! - m[4]!).normalize();
    measured.push({
      name: candidate.node.name,
      degreesOffHingeLine: (Math.acos(
        Math.min(1, Math.abs(Vector3.Dot(axis, hingeLine))),
      ) * 180) / Math.PI,
      // `moved` is read so the pose is genuinely applied to the mesh, not only
      // to the node.
      ...(moved.size > 0 ? {} : {}),
    });
  }
  return measured;
}

describe("every control surface turns about its own hinge line", () => {
  for (const kind of AIRCRAFT_KINDS) {
    it(`holds every deflecting surface on the ${kind} to its hinge line`, () => {
      const measured = measure(kind);
      const declared = new Set(
        DECLARED_UNRAKED.filter(([only]) => only === kind).map(([, name]) => name),
      );
      const allMoving = new Set(
        ALL_MOVING.filter(([only]) => only === kind).map(([, name]) => name),
      );

      // The exposure column: a pass means nothing unless surfaces were found
      // and were seen to move.
      expect(
        measured.map((entry) => entry.name).sort(),
        `${kind}: ${measured.length} surfaces deflected, expected `
        + `${EXPECTED_DEFLECTING[kind]} — a renamed surface silently shrinks `
        + "this sweep, so the count is pinned rather than the names",
      ).toHaveLength(EXPECTED_DEFLECTING[kind]);

      for (const entry of measured) {
        if (allMoving.has(entry.name)) continue;
        if (declared.has(entry.name)) {
          // A declared exception must STILL be broken, or the list is stale.
          expect(
            entry.degreesOffHingeLine,
            `${kind} ${entry.name} is listed in DECLARED_UNRAKED but now turns `
            + `only ${entry.degreesOffHingeLine.toFixed(2)} deg off its hinge `
            + "line — remove the entry rather than leaving it to rot",
          ).toBeGreaterThan(2);
          continue;
        }
        expect(
          entry.degreesOffHingeLine,
          `${kind} ${entry.name} turns about an axis `
          + `${entry.degreesOffHingeLine.toFixed(2)} deg off its own hinge line`,
        ).toBeLessThan(2);
      }
    });
  }

  it("keeps a hinge on Euler angles, which is what makes the axis work", () => {
    // `hingeAlong` orients the node so that `applyCommonPose` writing
    // `rotation.z` is already a rotation about the hinge line. Babylon ignores
    // `rotation` entirely once `rotationQuaternion` is set, so a quaternion on
    // one of these nodes does not merely change the axis — it stops the
    // surface deflecting at all, silently.
    for (const kind of AIRCRAFT_KINDS) {
      const { scene, visual } = build(kind);
      deflect(visual, 1);
      const hinged = scene.transformNodes.filter((candidate) =>
        !candidate.name.endsWith("-mount")
        && !candidate.name.endsWith("-frame")
        && scene.meshes.some((mesh) => mesh.name.startsWith(candidate.name)
          && mesh.name.endsWith("-surface")));
      expect(hinged.length, `${kind} has no hinged surfaces to check`).toBeGreaterThan(0);
      for (const candidate of hinged) {
        expect(
          candidate.rotationQuaternion,
          `${kind} ${candidate.name} carries a rotationQuaternion, so Babylon `
          + "ignores the rotation applyCommonPose writes and it will not deflect",
        ).toBeNull();
      }
    }
  });
});
