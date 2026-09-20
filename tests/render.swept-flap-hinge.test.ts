import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { createWebGpuAircraft, type AircraftVisual } from "../src/render/webgpu/aircraft";

/**
 * A swept control surface has to hinge about its own hinge LINE.
 *
 * `applyCommonPose` deflects every surface by writing `rotation.z`, which is a
 * rotation about the WING's z axis. For an unswept hinge those are the same
 * axis. The Global's trailing edge is swept 23 degrees and they are not, and
 * the difference is not subtle: the inner flap's outboard end sits about 2 m
 * aft of the wing's z axis, so a 30 degree rotation about it drops that end by
 * 2 sin(30) = 1 m more than the root.
 *
 * Measured on the built mesh before this was fixed, paired vertex by vertex:
 * at full flap the inner flap dropped 0.634 m at its root and 1.471 m at the
 * break, and its outboard end moved 64 mm FORWARD while its root moved 163 mm
 * aft. A rigid panel appearing to twist most of a metre as it deployed. From
 * the chase camera the trailing edge tore open far enough to see terrain
 * through the span.
 *
 * Nothing caught it. `render.webgpu-control-surface-sides` measures WHICH WAY
 * a surface goes and is satisfied by any rotation of the right sign;
 * everything else reads declarations, and every declaration agreed with the
 * one next to it.
 *
 * So this measures the axis itself. The deflection's rotation axis is
 * recovered from the node's own world matrices — the skew-symmetric part of
 * R(rest)^-1 R(deployed) — and compared with the hinge line read off the
 * panel's leading edge at its two extreme span stations. Those are two
 * independent routes to the same direction, neither of which consults a
 * declaration, and the failure mode is legible: a surface deflecting about
 * the wrong axis reports an angle equal to its own sweep.
 *
 * SCOPED TO THE GLOBAL deliberately. The F-16's flaperon and ailerons and the
 * 747-8's flaps are built the same way and are expected to FAIL this, which
 * is why it is worth having before that fix rather than after. Widen it over
 * `AIRCRAFT_KINDS` when the cause is fixed in the shared hinge construction.
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

function build(): Fixture {
  const engine = new NullEngine({
    renderWidth: 64,
    renderHeight: 64,
    textureSize: 64,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const visual = createWebGpuAircraft(scene, "bizjet");
  const fixture: Fixture = { engine, scene, visual };
  fixtures.push(fixture);
  return fixture;
}

function setFlaps(visual: AircraftVisual, flaps: number): void {
  const state: FlightVisualState = {
    ...INITIAL_VISUAL_STATE,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: 60,
    altitudeAgl: 400,
    altitude: 400,
    gear: 1,
    flaps,
  };
  visual.update(state, 1 / 60);
}

/**
 * The panel's leading edge, one point per span station, in world space.
 *
 * Stations are keyed by the vertex's LOCAL z — the frame the panel was built
 * in, which does not move with the deflection — so the same points are picked
 * at every flap setting and the travel below is a true per-vertex pairing
 * rather than a comparison of extremes that may be different points.
 */
function leadingEdgeByStation(scene: Scene, meshName: string): Map<string, Vector3> {
  const mesh = scene.getMeshByName(meshName);
  if (!mesh) throw new Error(`Missing mesh ${meshName}`);
  const positions = mesh.getVerticesData("position");
  if (!positions) throw new Error(`${meshName} has no positions`);
  const world = mesh.computeWorldMatrix(true);

  // +X is the nose, so a panel's leading edge is the forwardmost point of its
  // station.
  const forwardmost = new Map<string, number>();
  for (let index = 0; index < positions.length; index += 3) {
    const station = positions[index + 2]!.toFixed(3);
    if (positions[index]! > (forwardmost.get(station) ?? Number.NEGATIVE_INFINITY)) {
      forwardmost.set(station, positions[index]!);
    }
  }
  const byStation = new Map<string, Vector3>();
  for (let index = 0; index < positions.length; index += 3) {
    const station = positions[index + 2]!.toFixed(3);
    if (positions[index]! < forwardmost.get(station)! - 1e-6) continue;
    byStation.set(station, Vector3.TransformCoordinates(
      new Vector3(positions[index]!, positions[index + 1]!, positions[index + 2]!),
      world,
    ));
  }
  return byStation;
}

/** A node's world rotation, with the translation discarded. */
function worldRotation(scene: Scene, nodeName: string): Matrix {
  const node = scene.getTransformNodeByName(nodeName);
  if (!node) throw new Error(`Missing node ${nodeName}`);
  node.computeWorldMatrix(true);
  const rotation = node.getWorldMatrix().clone();
  rotation.setTranslation(Vector3.Zero());
  return rotation;
}

const PANELS = [
  { mesh: "starboard-bizjet-inner-flap-surface", node: "starboard-bizjet-inner-flap" },
  { mesh: "starboard-bizjet-outer-flap-surface", node: "starboard-bizjet-outer-flap" },
  { mesh: "port-bizjet-inner-flap-surface", node: "port-bizjet-inner-flap" },
  { mesh: "port-bizjet-outer-flap-surface", node: "port-bizjet-outer-flap" },
] as const;

describe("the Global's swept flaps hinge about their own hinge line", () => {
  for (const panel of PANELS) {
    it(`deflects ${panel.mesh} about its hinge line, not the wing's z axis`, () => {
      const { scene, visual } = build();
      setFlaps(visual, 0);
      const rest = leadingEdgeByStation(scene, panel.mesh);
      const restRotation = worldRotation(scene, panel.node);
      setFlaps(visual, 1);
      const deployed = leadingEdgeByStation(scene, panel.mesh);
      const deployedRotation = worldRotation(scene, panel.node);

      // Four stations: three span segments, so four rings of vertices.
      expect(rest.size).toBeGreaterThanOrEqual(4);

      // The hinge line, off the metal: leading edge at the two extreme
      // stations. Sorted by |z| so this reads root-to-tip on both wings.
      const stations = [...rest.keys()].sort(
        (a, b) => Math.abs(Number(a)) - Math.abs(Number(b)),
      );
      const hingeLine = rest.get(stations[stations.length - 1]!)!
        .subtract(rest.get(stations[0]!)!).normalize();

      // The axis actually used, off the node: the skew-symmetric part of the
      // relative rotation. Sign is not meaningful — a line has two directions
      // and the two wings recover opposite ones — so the comparison is on the
      // absolute dot product.
      const relative = restRotation.clone().invert().multiply(deployedRotation);
      const m = relative.m;
      const axis = new Vector3(
        m[6]! - m[9]!,
        m[8]! - m[2]!,
        m[1]! - m[4]!,
      ).normalize();

      const degrees = (Math.acos(
        Math.min(1, Math.abs(Vector3.Dot(axis, hingeLine))),
      ) * 180) / Math.PI;
      // Measured at 0.23 to 0.40 degrees once the axis is right; deflecting
      // about the wing's z axis instead reports this panel's own sweep, which
      // is 23 degrees inboard of the kink and 26 outboard.
      expect(
        degrees,
        `${panel.mesh} deflects about an axis ${degrees.toFixed(1)} deg off its own hinge line `
        + `(hinge ${hingeLine.x.toFixed(3)}, ${hingeLine.y.toFixed(3)}, ${hingeLine.z.toFixed(3)}; `
        + `axis ${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})`,
      ).toBeLessThan(2);

      // And the consequence, stated independently: points on the hinge line
      // may only TRANSLATE. The leading edge does not sit exactly on the axis
      // — the section tapers, so its offset from the chord plane varies about
      // 17 mm across a panel — hence 50 mm rather than nothing. The defect
      // this guards against was 840 mm.
      const travel = stations.map((station) => ({
        station,
        move: deployed.get(station)!.subtract(rest.get(station)!),
      }));
      const reference = travel[0]!.move;
      for (const { station, move } of travel) {
        expect(
          move.subtract(reference).length(),
          `${panel.mesh} station ${station} travelled ${move.length().toFixed(3)} m `
          + `against ${reference.length().toFixed(3)} m at the root — a leading-edge `
          + "point is on the hinge line and may only translate",
        ).toBeLessThan(0.05);
      }
    });
  }

  it("deploys both wings as mirror images of one another", () => {
    const { scene, visual } = build();
    for (const piece of ["inner", "outer"] as const) {
      setFlaps(visual, 0);
      const starboardRest = leadingEdgeByStation(scene, `starboard-bizjet-${piece}-flap-surface`);
      const portRest = leadingEdgeByStation(scene, `port-bizjet-${piece}-flap-surface`);
      setFlaps(visual, 1);
      const starboard = leadingEdgeByStation(scene, `starboard-bizjet-${piece}-flap-surface`);
      const port = leadingEdgeByStation(scene, `port-bizjet-${piece}-flap-surface`);

      for (const [station, before] of starboardRest) {
        const starboardMove = starboard.get(station)!.subtract(before);
        // The port panel is built with negated z, so pair the stations by
        // magnitude rather than by key.
        const mirrored = [...portRest.keys()].find(
          (key) => Math.abs(Math.abs(Number(key)) - Math.abs(Number(station))) < 1e-3,
        );
        expect(mirrored, `no port station mirroring ${station}`).toBeDefined();
        const portMove = port.get(mirrored!)!.subtract(portRest.get(mirrored!)!);
        // Flaps are a symmetric deflection: the panels go down together, so
        // their travel mirrors in z and matches in x and y. This is the check
        // that the outboard-positive hinge axis has not been flipped on one
        // wing, which would deflect that wing's flaps the wrong way.
        expect(portMove.x, `${piece} flap x travel`).toBeCloseTo(starboardMove.x, 3);
        expect(portMove.y, `${piece} flap y travel`).toBeCloseTo(starboardMove.y, 3);
        expect(portMove.z, `${piece} flap z travel`).toBeCloseTo(-starboardMove.z, 3);
      }
    }
  });
});
