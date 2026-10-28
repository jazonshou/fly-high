import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type CarVisualState, type FlightVisualState } from "../src/game/types";
import { dialNeedleAngle } from "../src/render/webgpu/ground/carAtlas";
import { CAR_LAMP_TEXELS, carBodySurfaces } from "../src/render/webgpu/ground/carBody";
import { CAR_DIALS, writeNeedleMatrices } from "../src/render/webgpu/ground/carCockpit";
import { CAR_HEADLAMP_POOLS, CAR_LAMPS_OFF, carLampState, carPoolIntensity } from "../src/render/webgpu/ground/carLights";
import {
  CAR_COILS,
  CAR_LINKS,
  COIL,
  linkEnds,
  writeLinkMatrices,
  writeWheelMatrices,
} from "../src/render/webgpu/ground/carRunningGear";
import { carLampTexels, createWebGpuCar, type CarVisual } from "../src/render/webgpu/ground/createCar";
import {
  ARCH,
  BODY,
  DRIVER_EYE,
  FRONT_DOOR_HINGE,
  GROUND_Y,
  LC76_FRONT_AXLE_X,
  LC76_FRONT_TRACK,
  LC76_REAR_AXLE_X,
  LC76_REAR_TRACK,
  STEERING_WHEEL,
} from "../src/render/webgpu/ground/lc76Lines";
import { AIRCRAFT_CAST_POOLS } from "../src/render/webgpu/lighting/AircraftLighting";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";
import { LANDCRUISER_76, LC76_GEOMETRY } from "../src/vehicles/landcruiser76";

/**
 * The LandCruiser 76 as BUILT (src/render/webgpu/ground/createCar.ts): the
 * drawn car stands where the physics record puts the simulated one, the draw
 * budget holds, the axles, wheels and links move as the payload says, and the
 * lamps follow the switches.
 */

let engine: NullEngine;
let scene: Scene;
let car: CarVisual;

const carState = (overrides: Partial<CarVisualState> = {}): CarVisualState => ({
  kind: "car",
  speed: 0,
  gearbox: "automatic",
  selector: "P",
  gear: 0,
  range: "2H",
  locks: "off",
  downhillAssist: false,
  downhillAssistActive: false,
  tractionControlActive: false,
  absActive: false,
  clutch: 1,
  engineRunning: true,
  stalled: false,
  flooded: false,
  rolled: false,
  boost: 0,
  headlights: "off",
  brakeLights: false,
  reversing: false,
  tyrePressure: "road",
  tyrePressureBar: 2.4,
  wadingDepth: 0,
  wadingSea: 0,
  settling: false,
  wheelSteer: [0, 0, 0, 0],
  wheelSpin: [0, 0, 0, 0],
  wheelSpinRate: [0, 0, 0, 0],
  wheelLoad: [5_500, 5_500, 5_000, 5_000],
  wheelSlip: [0, 0, 0, 0],
  wheelSinkage: [0, 0, 0, 0],
  wheelSurface: [8, 8, 8, 8],
  wheelWetness: [0, 0, 0, 0],
  axleHeave: [0, 0],
  axleRoll: [0, 0],
  steeringWheel: 0,
  bumpStop: 0,
  scrape: 0,
  splash: 0,
  ...overrides,
});

const visualState = (vehicle: CarVisualState | null, engineRpm = 750): FlightVisualState => ({ ...INITIAL_VISUAL_STATE, engineRpm, vehicle });

const meshNamed = (suffix: string): Mesh => car.meshes.find((mesh) => mesh.name === `landcruiser-${suffix}`) as Mesh;

function positions(mesh: Mesh): Float32Array | number[] {
  return mesh.getVerticesData(VertexBuffer.PositionKind)!;
}

/** Thin instance `index`'s matrix applied to a local point. */
function placed(matrices: Float32Array, index: number, point: readonly [number, number, number]): [number, number, number] {
  const m = matrices.subarray(index * 16, index * 16 + 16);
  const [x, y, z] = point;
  return [
    x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
    x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
    x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
  ];
}

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  car = createWebGpuCar(scene, "landcruiser");
});

afterAll(() => {
  car.dispose();
  scene.dispose();
  engine.dispose();
});

describe("the built car", () => {
  it("draws nine meshes outside and seven in the cockpit, four casting shadows (and each open door)", () => {
    car.setCockpitView(false);
    car.update(visualState(carState()), 1 / 60);
    const outside = car.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible);
    expect(outside.length).toBe(9);
    expect(outside.length).toBeLessThanOrEqual(14);
    const casters = car.meshes.filter((mesh) => mesh.metadata?.castsShadow !== false);
    expect(casters.map((mesh) => mesh.name).sort()).toEqual([
      "landcruiser-body",
      "landcruiser-door-left",
      "landcruiser-door-right",
      "landcruiser-front-axle",
      "landcruiser-rear-axle",
      "landcruiser-wheels",
    ]);
    // The doors draw in the body while shut.
    expect(casters.filter((mesh) => mesh.isEnabled()).length).toBe(4);
    car.setCockpitView(true);
    const inside = car.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible);
    expect(inside.length).toBe(7);
    // The cockpit adds only the needles: well inside the brief's eight extra draws.
    expect(inside.filter((mesh) => !outside.includes(mesh)).map((mesh) => mesh.name)).toEqual(["landcruiser-needles"]);
    expect(inside.some((mesh) => mesh.name === "landcruiser-glass")).toBe(false);
    car.setCockpitView(false);
    expect(car.meshes.every((mesh) => mesh.metadata?.surfaceVehicleVisual === true)).toBe(true);
  });

  it("has finite geometry, and stands on the published envelope: 4,910 mm long, 1,870 mm over the flares, 1,935 mm to the roof", () => {
    for (const mesh of car.meshes as Mesh[]) {
      expect(positions(mesh).every(Number.isFinite), mesh.name).toBe(true);
      expect(mesh.getVerticesData(VertexBuffer.NormalKind)!.every(Number.isFinite), mesh.name).toBe(true);
    }
    const body = positions(meshNamed("body"));
    let minX = Infinity;
    let maxX = -Infinity;
    let flare = 0;
    let roof = -Infinity;
    for (let at = 0; at < body.length; at += 3) {
      const [x, y, z] = [body[at]!, body[at + 1]!, body[at + 2]!];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      // Below the bonnet, where the mirrors and the snorkel are not.
      if (y < GROUND_Y + 1) flare = Math.max(flare, Math.abs(z));
      // Over the cabin, clear of the snorkel's head.
      if (Math.abs(z) < 0.75) roof = Math.max(roof, y);
    }
    expect(maxX - minX).toBeCloseTo(LANDCRUISER_76.body.length, 2);
    expect(maxX - LC76_FRONT_AXLE_X).toBeCloseTo(LANDCRUISER_76.body.frontOverhang, 2);
    expect(2 * flare).toBeCloseTo(LANDCRUISER_76.body.width, 2);
    expect(roof - GROUND_Y).toBeCloseTo(BODY.roof, 3);
  });

  it("draws the tyre between its loaded and free radii, and keeps the differentials 0.29 m off flat ground", () => {
    const wheel = positions(meshNamed("wheels"));
    let radius = 0;
    for (let at = 0; at < wheel.length; at += 3) radius = Math.max(radius, Math.hypot(wheel[at]!, wheel[at + 1]!));
    expect(radius).toBeGreaterThanOrEqual(LC76_GEOMETRY.loadedTyreRadius);
    expect(radius).toBeLessThanOrEqual(LC76_GEOMETRY.freeTyreRadius);
    car.update(visualState(carState()), 1 / 60);
    for (const axle of ["front", "rear"] as const) {
      const mesh = meshNamed(`${axle}-axle`);
      mesh.computeWorldMatrix(true);
      const local = positions(mesh);
      let lowest = Infinity;
      let differential = Infinity;
      for (let at = 0; at < local.length; at += 3) {
        const world = Vector3.TransformCoordinates(new Vector3(local[at]!, local[at + 1]!, local[at + 2]!), mesh.getWorldMatrix());
        lowest = Math.min(lowest, world.y);
        if (Math.abs(world.z) < 0.3) differential = Math.min(differential, world.y);
      }
      expect(differential - GROUND_Y, axle).toBeCloseTo(LANDCRUISER_76.body.groundClearance, 2);
      // Only the knuckles, inside the wheels, hang lower.
      expect(lowest - GROUND_Y, axle).toBeGreaterThan(0.28);
    }
  });

  it("uses the catalogue's driver's eye, and from it the gauges and the wheel's rim sit inside the level 75 degree lens", () => {
    const eye = surfaceVehicleSpec("landcruiser").cockpitEye;
    expect(eye.forward).toBeCloseTo(DRIVER_EYE.x, 6);
    expect(eye.up).toBeCloseTo(DRIVER_EYE.height + GROUND_Y, 6);
    expect(eye.right).toBeCloseTo(DRIVER_EYE.z, 6);
    // 75 degrees across at 16:9 is 46.6 degrees from top to bottom.
    const halfVertical = Math.atan(Math.tan((37.5 * Math.PI) / 180) * (9 / 16));
    const below = (x: number, y: number): number => Math.atan2(DRIVER_EYE.height + GROUND_Y - y, x - DRIVER_EYE.x);
    for (const dial of CAR_DIALS) {
      expect(below(dial.centre[0], dial.centre[1]), dial.dial).toBeLessThan(halfVertical - 0.03);
    }
    const tilt = STEERING_WHEEL.tiltRadians;
    const rimTop = [STEERING_WHEEL.x + Math.sin(tilt) * STEERING_WHEEL.radius, GROUND_Y + STEERING_WHEEL.height + Math.cos(tilt) * STEERING_WHEEL.radius] as const;
    expect(below(rimTop[0], rimTop[1])).toBeLessThan(halfVertical);
    expect(below(rimTop[0], rimTop[1])).toBeGreaterThan(0);
  });
});

describe("the front doors", () => {
  const indexTotal = (mesh: Mesh): number => mesh.subMeshes.reduce((sum, sub) => sum + sub.indexCount, 0);
  const worldPoints = (mesh: Mesh): Vector3[] => {
    mesh.computeWorldMatrix(true);
    (mesh.parent as TransformNode).computeWorldMatrix(true);
    const data = positions(mesh);
    const matrix = mesh.computeWorldMatrix(true);
    const points: Vector3[] = [];
    for (let at = 0; at < data.length; at += 3) {
      points.push(Vector3.TransformCoordinates(new Vector3(data[at]!, data[at + 1]!, data[at + 2]!), matrix));
    }
    return points;
  };

  it("lie shut exactly where the body draws them, and the body draws in one run", () => {
    car.setDoors?.(0, 0);
    const body = meshNamed("body");
    expect(body.subMeshes.length).toBe(1);
    expect(indexTotal(body)).toBe(body.getTotalIndices());
    expect(meshNamed("door-right").isEnabled()).toBe(false);
    // The door's vertices, put back on its hinge shut, are the body's own last ones.
    const door = meshNamed("door-right");
    const local = positions(door);
    const all = positions(body);
    const doorVertices = local.length / 3;
    // The right door's run sits before the left's at the body's end.
    const offset = all.length / 3 - 2 * doorVertices;
    for (let index = 0; index < doorVertices; index += 1) {
      expect(local[index * 3]! + FRONT_DOOR_HINGE.x).toBeCloseTo(all[(offset + index) * 3]!, 6);
      expect(local[index * 3 + 1]!).toBeCloseTo(all[(offset + index) * 3 + 1]!, 6);
      expect(local[index * 3 + 2]! + FRONT_DOOR_HINGE.z).toBeCloseTo(all[(offset + index) * 3 + 2]!, 6);
    }
  });

  it("swing their trailing edges out about the hinge, and the body leaves an open door out", () => {
    const body = meshNamed("body");
    const glass = meshNamed("glass");
    const shut = indexTotal(body);
    const shutGlass = indexTotal(glass);
    car.setDoors?.(1, 0);
    const right = meshNamed("door-right");
    expect(right.isEnabled()).toBe(true);
    expect(meshNamed("door-right-glass").isEnabled()).toBe(true);
    expect(meshNamed("door-left").isEnabled()).toBe(false);
    expect(shut - indexTotal(body)).toBe(right.getTotalIndices());
    expect(shutGlass - indexTotal(glass)).toBe(meshNamed("door-right-glass").getTotalIndices());
    // Open: the trailing edge stands out from the side, ahead of where it was.
    const points = worldPoints(right);
    const outmost = Math.max(...points.map((point) => point.z));
    expect(outmost).toBeGreaterThan(BODY.halfWidth + 0.8);
    expect(Math.max(...points.map((point) => point.x))).toBeLessThan(FRONT_DOOR_HINGE.x + 0.15);
    // The left swings out to the left.
    car.setDoors?.(0, 1);
    expect(right.isEnabled()).toBe(false);
    const left = worldPoints(meshNamed("door-left"));
    expect(Math.min(...left.map((point) => point.z))).toBeLessThan(-(BODY.halfWidth + 0.8));
    expect(shut - indexTotal(body)).toBe(meshNamed("door-left").getTotalIndices());
    car.setDoors?.(0, 0);
    expect(indexTotal(body)).toBe(shut);
    expect(body.subMeshes.length).toBe(1);
  });

  it("are cut clear of the front flare, and tile the flank with the slab", () => {
    const surfaces = carBodySurfaces();
    const flareA = ARCH.halfWidth + ARCH.flareWidth;
    const flareB = ARCH.height + ARCH.flareWidth;
    for (const surface of surfaces.door.body) {
      for (let at = 0; at < surface.positions.length; at += 3) {
        const x = surface.positions[at]!;
        const height = surface.positions[at + 1]! - GROUND_Y;
        // Inside the flare's superellipse, by a margin, nothing of the door.
        const dx = Math.abs(x - LC76_FRONT_AXLE_X) / flareA;
        const dy = Math.max(0, height - LC76_GEOMETRY.loadedTyreRadius) / flareB;
        expect(dx ** ARCH.exponent + dy ** ARCH.exponent).toBeGreaterThan(1);
      }
    }
    // The door's outer face and the slab's tile the side: every point of the
    // flank between the arches is under exactly one of their triangles.
    const triangles: [number, number, number, number, number, number][] = [];
    for (const surface of [...surfaces.symmetric, ...surfaces.door.body]) {
      const p = surface.positions;
      for (let at = 0; at < surface.indices.length; at += 3) {
        const corners = [surface.indices[at]!, surface.indices[at + 1]!, surface.indices[at + 2]!];
        if (!corners.every((v) => Math.abs(p[v * 3 + 2]! - BODY.halfWidth) < 1e-9)) continue;
        triangles.push([
          p[corners[0]! * 3]!, p[corners[0]! * 3 + 1]!,
          p[corners[1]! * 3]!, p[corners[1]! * 3 + 1]!,
          p[corners[2]! * 3]!, p[corners[2]! * 3 + 1]!,
        ]);
      }
    }
    const covering = (x: number, y: number): number => triangles.filter(([ax, ay, bx, by, cx, cy]) => {
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
    }).length;
    for (let x = -0.6137; x < 0.66; x += 0.0571) {
      for (let height = 0.5613; height < 1.28; height += 0.0433) {
        expect(covering(x, GROUND_Y + height), `x ${x.toFixed(3)} height ${height.toFixed(3)}`).toBe(1);
      }
    }
  });
});

describe("the running gear follows the payload", () => {
  it("heaves and rolls each axle, its wheels at its ends", () => {
    const state = carState({ axleHeave: [0.08, -0.1], axleRoll: [0.15, -0.12] });
    car.update(visualState(state), 1 / 60);
    for (const [index, axle] of (["front", "rear"] as const).entries()) {
      expect(car.axles[axle].position.y).toBeCloseTo(LC76_GEOMETRY.wheelCentreY + state.axleHeave[index]!, 6);
      expect(car.axles[axle].rotation.x).toBeCloseTo(-state.axleRoll[index]!, 6);
    }
    const matrices = new Float32Array(5 * 16);
    writeWheelMatrices(state, matrices);
    const x = [LC76_FRONT_AXLE_X, LC76_FRONT_AXLE_X, LC76_REAR_AXLE_X, LC76_REAR_AXLE_X];
    const track = [LC76_FRONT_TRACK, LC76_FRONT_TRACK, LC76_REAR_TRACK, LC76_REAR_TRACK];
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const side = wheel % 2 === 0 ? -1 : 1;
      const axle = wheel < 2 ? 0 : 1;
      const [cx, cy, cz] = placed(matrices, wheel, [0, 0, 0]);
      expect(cx).toBeCloseTo(x[wheel]!, 6);
      // The payload's own formula for a wheel centre.
      expect(cy).toBeCloseTo(-0.43 + state.axleHeave[axle]! + side * (track[wheel]! / 2) * Math.sin(state.axleRoll[axle]!), 6);
      expect(Math.sign(cz)).toBe(side);
      // Each wheel's face looks out from the car.
      const face = placed(matrices, wheel, [0, 0, 1]);
      expect(Math.sign(face[2] - cz)).toBe(side);
    }
  });

  it("rolls every wheel's top forward as its angle grows, and turns the front wheels' fronts right for positive steer", () => {
    const before = new Float32Array(5 * 16);
    const after = new Float32Array(5 * 16);
    writeWheelMatrices(carState({ wheelSpin: [1, 1, 1, 1] }), before);
    writeWheelMatrices(carState({ wheelSpin: [1.05, 1.05, 1.05, 1.05] }), after);
    for (let wheel = 0; wheel < 4; wheel += 1) {
      // The point at the top of the tread now: where it goes as the wheel turns on.
      const top = [0, 0, 0] as [number, number, number];
      const m = before.subarray(wheel * 16, wheel * 16 + 16);
      // Local point whose posed position is straight above the centre: solve with the transpose (rotation).
      for (let k = 0; k < 3; k += 1) top[k] = m[k * 4 + 1]! * 0.38;
      const moved = placed(after, wheel, top);
      const was = placed(before, wheel, top);
      expect(moved[0] - was[0], `wheel ${wheel}`).toBeGreaterThan(0);
    }
    const steered = new Float32Array(5 * 16);
    writeWheelMatrices(carState({ wheelSteer: [0.3, 0.25, 0, 0] }), steered);
    for (const wheel of [0, 1]) {
      const centre = placed(steered, wheel, [0, 0, 0]);
      const face = placed(steered, wheel, [0, 0, 1]);
      const side = wheel === 0 ? -1 : 1;
      // The face's normal turns forward on the left wheel and back on the right one: the fronts swing right.
      expect((face[0] - centre[0]) * side, `wheel ${wheel}`).toBeLessThan(0);
    }
  });

  it("stretches every link between its frame point and its axle point", () => {
    const state = carState({ axleHeave: [0.1, -0.12], axleRoll: [-0.1, 0.13] });
    for (const [links, rest] of [[CAR_LINKS, 1], [CAR_COILS, COIL.restLength]] as const) {
      const matrices = new Float32Array(links.length * 16);
      writeLinkMatrices(links, state, matrices, rest);
      for (const [index, link] of links.entries()) {
        const [from, to] = linkEnds(link, state);
        const start = placed(matrices, index, [0, 0, 0]);
        const end = placed(matrices, index, [0, rest, 0]);
        for (let k = 0; k < 3; k += 1) {
          expect(start[k], link.name).toBeCloseTo(from[k]!, 5);
          expect(end[k], link.name).toBeCloseTo(to[k]!, 5);
        }
      }
    }
    // A front damper's lower end rides the axle up into bump.
    const damper = CAR_LINKS.find((link) => link.name === "front-damper-1")!;
    const rest = linkEnds(damper, carState())[0][1];
    const bumped = linkEnds(damper, carState({ axleHeave: [0.1, 0] }))[0][1];
    expect(bumped - rest).toBeCloseTo(0.1, 6);
  });

  it("turns the steering wheel by the payload's angle, and the needles to their readings", () => {
    car.update(visualState(carState({ steeringWheel: 2.5 })), 1 / 60);
    expect(car.steeringWheel.rotation.x).toBeCloseTo(2.5, 6);
    const matrices = new Float32Array(CAR_DIALS.length * 16);
    writeNeedleMatrices({ engineRpm: 2_000, speedKmh: 90, fuel: 0.5, temperature: 0.5 }, matrices);
    for (const [index, dial] of CAR_DIALS.entries()) {
      const reading = { tachometer: 2_000, speedometer: 90, fuel: 0.5, temperature: 0.5 }[dial.dial];
      const angle = dialNeedleAngle(dial.dial, reading);
      const tip = placed(matrices, index, [0, 1, 0]);
      const hub = placed(matrices, index, [0, 0, 0]);
      const d = [tip[0] - hub[0], tip[1] - hub[1], tip[2] - hub[2]];
      const up = d[0]! * dial.up[0] + d[1]! * dial.up[1] + d[2]! * dial.up[2];
      const right = d[0]! * dial.right[0] + d[1]! * dial.right[1] + d[2]! * dial.right[2];
      // Clockwise from straight up, as the driver sees the face.
      expect(Math.atan2(right, up), dial.dial).toBeCloseTo(angle, 5);
    }
  });
});

describe("the lamps", () => {
  it("follow the switches: day-running rings with the engine, tails with the headlamps, main over dipped", () => {
    expect(carLampState(null)).toEqual(CAR_LAMPS_OFF);
    expect(carLampState(carState())).toEqual({ dayRunning: 1, dipped: 0, main: 0, tail: 0, brake: 0, reverse: 0 });
    expect(carLampState(carState({ engineRunning: false }))).toEqual(CAR_LAMPS_OFF);
    expect(carLampState(carState({ flooded: true })).dayRunning).toBe(0);
    expect(carLampState(carState({ headlights: "dipped" }))).toMatchObject({ dipped: 1, main: 0, tail: 1 });
    expect(carLampState(carState({ headlights: "main" }))).toMatchObject({ dipped: 1, main: 1, tail: 1 });
    expect(carLampState(carState({ brakeLights: true, reversing: true }))).toMatchObject({ brake: 1, reverse: 1 });
  });

  it("light the lenses' texels: the stop lamp outshines the tail, main beam the dipped", () => {
    const texel = (lamps: ReturnType<typeof carLampState>, index: number): number => carLampTexels(lamps)[index * 4]!;
    expect(texel(CAR_LAMPS_OFF, CAR_LAMP_TEXELS.headlamp)).toBe(0);
    const dipped = carLampState(carState({ headlights: "dipped" }));
    const main = carLampState(carState({ headlights: "main" }));
    expect(texel(main, CAR_LAMP_TEXELS.headlamp)).toBeGreaterThan(texel(dipped, CAR_LAMP_TEXELS.headlamp));
    expect(texel(dipped, CAR_LAMP_TEXELS.headlamp)).toBeGreaterThan(0);
    const braking = carLampState(carState({ headlights: "dipped", brakeLights: true }));
    expect(texel(braking, CAR_LAMP_TEXELS.tail)).toBeGreaterThan(2 * texel(dipped, CAR_LAMP_TEXELS.tail));
    expect(texel(braking, CAR_LAMP_TEXELS.highStop)).toBeGreaterThan(0);
    expect(texel(dipped, CAR_LAMP_TEXELS.highStop)).toBe(0);
  });

  it("are drawn as the payload's switches say", () => {
    car.update(visualState(carState({ headlights: "main", brakeLights: true })), 1 / 60);
    expect(car.lampState()).toEqual(carLampState(carState({ headlights: "main", brakeLights: true })));
    car.update(visualState(null), 1 / 60);
    expect(car.lampState()).toEqual(CAR_LAMPS_OFF);
  });

  it("throw their pools on the aircraft's two cast-pool slots, dark by day and with the beams off", () => {
    const slots = AIRCRAFT_CAST_POOLS.map((pool) => pool.name);
    for (const pool of CAR_HEADLAMP_POOLS) {
      expect(slots).toContain(pool.slot);
      // Ahead of the bumper, over the road.
      expect(pool.offset[0]).toBeGreaterThan(BODY.bumperFront);
      expect(pool.offset[1]).toBeGreaterThan(GROUND_Y);
    }
    const [dippedPool, mainPool] = CAR_HEADLAMP_POOLS;
    const main = carLampState(carState({ headlights: "main" }));
    const dipped = carLampState(carState({ headlights: "dipped" }));
    expect(carPoolIntensity(dippedPool!, main, 0)).toBe(0);
    expect(carPoolIntensity(dippedPool!, CAR_LAMPS_OFF, 1)).toBe(0);
    expect(carPoolIntensity(dippedPool!, dipped, 1)).toBeGreaterThan(0);
    expect(carPoolIntensity(mainPool!, dipped, 1)).toBe(0);
    expect(carPoolIntensity(mainPool!, main, 1)).toBeGreaterThan(carPoolIntensity(dippedPool!, main, 1));
  });
});

describe("disposal", () => {
  it("leaves nothing of the car in the scene", () => {
    const local = new Scene(engine);
    const meshes = local.meshes.length;
    const materials = local.materials.length;
    const owned = (): number => local.textures.filter((texture) => !texture.name.includes("EnvironmentBRDF")).length;
    const textures = owned();
    const transforms = local.transformNodes.length;
    const visual = createWebGpuCar(local, "landcruiser");
    expect(local.meshes.length).toBeGreaterThan(meshes);
    visual.dispose();
    expect(local.meshes.length).toBe(meshes);
    expect(local.materials.length).toBe(materials);
    expect(owned()).toBe(textures);
    expect(local.transformNodes.length).toBe(transforms);
    local.dispose();
  });
});
