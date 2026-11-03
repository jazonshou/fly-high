import type { CarVisualState } from "@/src/game/types";
import { Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { finishUv, type CarFinish } from "./carAtlas";
import { bar, box, cross3, disc, dot3, ellipsoid, latheZ, normalize3, tube, type Point2, type UvFor } from "./carShapes";
import {
  BODY,
  h,
  LC76_FRONT_AXLE_X,
  LC76_FRONT_TRACK,
  LC76_REAR_AXLE_X,
  LC76_REAR_TRACK,
  LC76_WHEEL_CENTRE_Y,
} from "./lc76Lines";

/**
 * The LandCruiser 76's running gear, drawn and posed: two solid axles (coil
 * springs and radius arms at the front, leaf springs at the rear), the four
 * 265/70R16 wheels and the spare under the tail, and the links that tie the
 * axles to the frame.
 *
 * The wheels are ONE mesh of five thin instances, and the links and the coil
 * springs one mesh each, posed every frame from `CarVisualState`: each axle
 * heaves and rolls as the payload says, its wheels at its ends, the front
 * wheels steered about their own centres, every wheel turned by its rolling
 * angle. A link's ends are a point on the frame and a point on an axle, so the
 * dampers stretch and the leaves bend as the axle moves. The poses are pure
 * functions of the payload, held in Node by the tests.
 */

const swatch = (finish: CarFinish): UvFor => {
  const uv = finishUv(finish);
  return () => uv;
};

/**
 * The tyre's sidewalls, (radius, z) from the inner bead up to the tread's
 * shoulder; +z is the wheel's outer face. A rim protector rolls out over the
 * bead before the wall bulges. The tread between the shoulders is the
 * grooves' floor, and its blocks stand on it.
 */
const SIDEWALL_PROFILE: readonly Point2[] = [
  [0.212, 0.104],
  [0.221, 0.113],
  [0.229, 0.121],
  [0.237, 0.12],
  [0.245, 0.119],
  [0.29, 0.127],
  [0.335, 0.13],
  [0.355, 0.128],
  [0.367, 0.121],
  [0.372, 0.112],
];
/** The grooves' floor across the tread, shoulder to shoulder. */
const TREAD_FLOOR: readonly Point2[] = [
  [0.372, -0.112],
  [0.3735, -0.06],
  [0.374, 0],
  [0.3735, 0.06],
  [0.372, 0.112],
];

/**
 * The all-terrain tread's blocks: four lanes round the tyre, the shoulders'
 * chunky blocks running over the shoulder and the centre rows staggered
 * half a pitch, each block standing 12 mm proud of the grooves' floor, so
 * the tyre's silhouette is lugged as a real one is.
 */
export const TREAD = Object.freeze({
  blocks: 30,
  /** The blocks' tops: the drawn tyre's radius. */
  top: 0.3855,
  shoulderTop: 0.383,
  lanes: Object.freeze([
    Object.freeze({ from: 0.06, to: 0.118, fill: 0.72, phase: 0.25, shoulder: true }),
    Object.freeze({ from: 0.007, to: 0.054, fill: 0.68, phase: 0.75, shoulder: false }),
    Object.freeze({ from: -0.054, to: -0.007, fill: 0.68, phase: 0.25, shoulder: false }),
    Object.freeze({ from: -0.118, to: -0.06, fill: 0.72, phase: 0.75, shoulder: true }),
  ]),
});

/** The alloy wheel's face: the hub's mounting face, the spokes' dish out to the rim's lip. */
const WHEEL_FACE = Object.freeze({ hub: 0.1, rim: 0.199, spokes: 6, hubZ: 0.058, rimZ: 0.088 });

/** The six-stud pattern: 6 x 139.7 mm. */
export const WHEEL_STUDS = Object.freeze({ count: 6, pitchRadius: 0.1397 / 2 });

const AROUND = 48;

/** A block or lug of the tread: a box turned `angle` about the wheel's axis, its radial span r0..r1, across z0..z1. */
function treadBlock(angle: number, length: number, r0: number, r1: number, z0: number, z1: number, uv: UvFor): Surface[] {
  const block = box([-length / 2, r0, z0], [length / 2, r1, z1], uv);
  const c = Math.cos(angle - Math.PI / 2);
  const s = Math.sin(angle - Math.PI / 2);
  return block.map((surface) => {
    const turned = new Surface();
    for (let index = 0; index < surface.positions.length; index += 3) {
      const x = surface.positions[index]!;
      const y = surface.positions[index + 1]!;
      turned.positions.push(x * c - y * s, x * s + y * c, surface.positions[index + 2]!);
    }
    turned.uvs.push(...surface.uvs);
    turned.indices.push(...surface.indices);
    return turned;
  });
}

/** The spoke's dish: z of the wheel's face at a radius, from the hub's face out to the lip. */
function dishZ(radius: number): number {
  const t = Math.min(1, Math.max(0, (radius - WHEEL_FACE.hub) / (WHEEL_FACE.rim - WHEEL_FACE.hub)));
  return WHEEL_FACE.hubZ + (WHEEL_FACE.rimZ - WHEEL_FACE.hubZ) * Math.sqrt(t);
}

/** Whether a point of the wheel's face at (radius, angle) is in a window between the spokes. */
function inWindow(radius: number, angle: number): boolean {
  if (radius < 0.122 || radius > 0.188) return false;
  const pitch = (Math.PI * 2) / WHEEL_FACE.spokes;
  const local = Math.abs((((angle % pitch) + pitch) % pitch) - pitch / 2);
  // Spokes taper from the hub out: the window widens with the radius.
  const spokeHalf = 0.16 + (0.11 - 0.16) * ((radius - 0.122) / (0.188 - 0.122));
  return local > spokeHalf;
}

/** One wheel, in its own frame: centred on the tread, the axle along z, its outer face toward +z. */
export function wheelSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const sidewall = finishUv("sidewall");
  // The outer wall runs in from the shoulder to the bead (showing +z), the inner one out from its bead (showing -z).
  surfaces.push(latheZ([...SIDEWALL_PROFILE].reverse(), AROUND, () => sidewall));
  surfaces.push(latheZ(SIDEWALL_PROFILE.map(([radius, z]) => [radius, -z] as Point2), AROUND, () => sidewall));
  // Raised lettering round the outer wall in two arcs opposite each other:
  // blocks of a letter's stroke and gaps between words, not text, so it reads
  // as moulded relief from any distance and never mirrored.
  const lettering = swatch("sidewall");
  const strokes = [0.011, 0.005, 0.011, 0.011, 0.016, 0.005, 0.011, 0.011, 0.005, 0.011, 0.016, 0.011];
  for (const start of [0.35, 0.35 + Math.PI]) {
    let along = 0;
    for (const [k, width] of strokes.entries()) {
      surfaces.push(...treadBlock(start + (along + width / 2) / 0.305, width, 0.296, 0.314, 0.122, 0.1315, lettering));
      along += width + (k % 4 === 3 ? 0.014 : 0.004);
    }
  }
  const groove = finishUv("rubber");
  surfaces.push(latheZ(TREAD_FLOOR, AROUND, () => groove));
  const tread = swatch("tread");
  for (const lane of TREAD.lanes) {
    const top = lane.shoulder ? TREAD.shoulderTop : TREAD.top;
    for (let k = 0; k < TREAD.blocks; k += 1) {
      const angle = ((k + lane.phase) / TREAD.blocks) * Math.PI * 2;
      const length = ((Math.PI * 2 * top) / TREAD.blocks) * lane.fill;
      surfaces.push(...treadBlock(angle, length, 0.37, top, lane.from, lane.to, tread));
      // Every other shoulder block runs on down the sidewall as a lug.
      if (lane.shoulder && k % 2 === 0) {
        const z = Math.sign(lane.from) > 0 ? [0.11, 0.1295] : [-0.1295, -0.11];
        surfaces.push(...treadBlock(angle, length * 0.6, 0.35, 0.371, z[0]!, z[1]!, tread));
      }
    }
  }
  // The alloy wheel: its lip, the barrel seen through the windows, the spokes' dish, the hub and its nuts.
  const alloy = finishUv("alloy");
  surfaces.push(latheZ(
    [[0.216, 0.094], [0.212, 0.1], [0.205, 0.101], [0.2, 0.096], [WHEEL_FACE.rim, WHEEL_FACE.rimZ]],
    AROUND, () => alloy,
  ));
  surfaces.push(latheZ([[0.197, WHEEL_FACE.rimZ - 0.004], [0.196, -0.09]], AROUND, () => finishUv("barrel")));
  // The face: a polar grid over the dish, open in the windows, their walls running back 30 mm.
  const face = new Surface();
  const walls = new Surface();
  const rings = [WHEEL_FACE.hub, 0.11, 0.122, 0.135, 0.15, 0.165, 0.178, 0.188, WHEEL_FACE.rim];
  const segments = 72;
  const at = (radius: number, angle: number, back = 0): Vec3Tuple => [Math.cos(angle) * radius, Math.sin(angle) * radius, dishZ(radius) - back];
  for (let j = 0; j < rings.length - 1; j += 1) {
    for (let k = 0; k < segments; k += 1) {
      const a0 = (k / segments) * Math.PI * 2;
      const a1 = ((k + 1) / segments) * Math.PI * 2;
      const r0 = rings[j]!;
      const r1 = rings[j + 1]!;
      const open = inWindow((r0 + r1) / 2, (a0 + a1) / 2);
      if (open) continue;
      const ids = [at(r0, a0), at(r0, a1), at(r1, a1), at(r1, a0)].map((point) => face.vertexAt(point, alloy));
      face.triFacing(ids[0]!, ids[1]!, ids[2]!, [0, 0, 1]);
      face.triFacing(ids[0]!, ids[2]!, ids[3]!, [0, 0, 1]);
      // A wall wherever this cell borders a window.
      const edges: readonly (readonly [number, number, number, number, Vec3Tuple])[] = [
        [r0, a0, r0, a1, [0, 0, 0]],
        [r1, a0, r1, a1, [0, 0, 0]],
        [r0, a0, r1, a0, [0, 0, 0]],
        [r0, a1, r1, a1, [0, 0, 0]],
      ];
      const neighbours: readonly (readonly [number, number])[] = [
        [j > 0 ? (rings[j - 1]! + r0) / 2 : r0 - 0.005, (a0 + a1) / 2],
        [j < rings.length - 2 ? (r1 + rings[j + 2]!) / 2 : r1 + 0.005, (a0 + a1) / 2],
        [(r0 + r1) / 2, a0 - Math.PI / segments],
        [(r0 + r1) / 2, a1 + Math.PI / segments],
      ];
      for (const [index, [er0, ea0, er1, ea1]] of edges.entries()) {
        const [nr, na] = neighbours[index]!;
        if (!inWindow(nr, na)) continue;
        const mid = at((er0 + er1) / 2, (ea0 + ea1) / 2);
        const towards = at(nr, na);
        const facing: Vec3Tuple = [towards[0] - mid[0], towards[1] - mid[1], 0];
        const w = [at(er0, ea0), at(er1, ea1), at(er1, ea1, 0.03), at(er0, ea0, 0.03)].map((point) => walls.vertexAt(point, alloy));
        walls.triFacing(w[0]!, w[1]!, w[2]!, facing);
        walls.triFacing(w[0]!, w[2]!, w[3]!, facing);
      }
    }
  }
  surfaces.push(face, walls);
  // The hub's mounting face is the dish's centre; the centre cap stands on it.
  const hub = finishUv("hub");
  surfaces.push(latheZ([[WHEEL_FACE.hub, WHEEL_FACE.hubZ], [0.046, WHEEL_FACE.hubZ], [0.046, WHEEL_FACE.hubZ + 0.012], [0.04, WHEEL_FACE.hubZ + 0.018], [0, WHEEL_FACE.hubZ + 0.02]], 24, () => alloy));
  void hub;
  for (let stud = 0; stud < WHEEL_STUDS.count; stud += 1) {
    const angle = ((stud + 0.5) / WHEEL_STUDS.count) * Math.PI * 2;
    const x = Math.cos(angle) * WHEEL_STUDS.pitchRadius;
    const y = Math.sin(angle) * WHEEL_STUDS.pitchRadius;
    surfaces.push(...bar([x, y, WHEEL_FACE.hubZ - 0.002], [x, y, WHEEL_FACE.hubZ + 0.016], 0.0105, 6, swatch("lugNut")));
  }
  // The brake disc behind the spokes, and the wheel's back, seen from under the car through the inner bead.
  surfaces.push(disc([0, 0, -0.005], [0, 0, 1], 0.17, 32, swatch("brakeDisc")));
  surfaces.push(disc([0, 0, -0.03], [0, 0, -1], 0.206, 24, swatch("hub")));
  return surfaces;
}

/** The front axle in its own frame (origin midway between the wheel centres): housing, differential, knuckles, tie rod. */
export function frontAxleSurfaces(): Surface[] {
  const axle = swatch("axle");
  return [
    ...bar([0, 0, -0.66], [0, 0, 0.66], 0.05, 10, axle),
    ellipsoid([0, 0.03, 0], [0.14, 0.11, 0.13], 8, 14, axle),
    // The pinion points back to the front propeller shaft.
    ...bar([-0.1, 0.03, 0], [-0.22, 0.04, 0], 0.05, 10, axle),
    ...bar([0, -0.085, -0.66], [0, 0.085, -0.66], 0.07, 10, axle),
    ...bar([0, -0.085, 0.66], [0, 0.085, 0.66], 0.07, 10, axle),
    ...bar([-0.16, -0.02, -0.62], [-0.16, -0.02, 0.62], 0.016, 6, swatch("chassis")),
    ...box([-0.06, 0.04, -0.62], [0.06, 0.065, -0.5], swatch("chassis"), 0.005),
    ...box([-0.06, 0.04, 0.5], [0.06, 0.065, 0.62], swatch("chassis"), 0.005),
  ];
}

/** The rear axle in its own frame: housing, differential, pinion, the leaf springs' seats. */
export function rearAxleSurfaces(): Surface[] {
  const axle = swatch("axle");
  return [
    ...bar([0, 0, -0.64], [0, 0, 0.64], 0.052, 10, axle),
    ellipsoid([0, 0.025, 0], [0.15, 0.105, 0.14], 8, 14, axle),
    ...bar([0.1, 0.03, 0], [0.22, 0.04, 0], 0.05, 10, axle),
    ...box([-0.07, 0.045, -0.54], [0.07, 0.072, -0.46], swatch("chassis"), 0.005),
    ...box([-0.07, 0.045, 0.46], [0.07, 0.072, 0.54], swatch("chassis"), 0.005),
  ];
}

/** A unit link: a round bar of radius 1 from y = 0 to y = 1, posed per instance. */
export function linkSurfaces(): Surface[] {
  return bar([0, 0, 0], [0, 1, 0], 1, 8, swatch("chassis"));
}

/** A front coil spring at its rest length, along y from 0; the instance stretches it. */
export const COIL = Object.freeze({ restLength: 0.37, radius: 0.075, wire: 0.0105, turns: 6.5 });
export function coilSurfaces(): Surface[] {
  const path: Vec3Tuple[] = [];
  const steps = Math.ceil(COIL.turns * 16);
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const angle = t * COIL.turns * Math.PI * 2;
    path.push([Math.cos(angle) * COIL.radius, t * COIL.restLength, Math.sin(angle) * COIL.radius]);
  }
  return tube(path, COIL.wire, 6, swatch("spring"));
}

// ---------------------------------------------------------------------------
// Poses. Babylon's matrices are row-major for row vectors: rows 0-2 are where
// the local x, y and z axes go, row 3 the translation.

export type CarAxle = "front" | "rear";

const AXLE_X: Readonly<Record<CarAxle, number>> = { front: LC76_FRONT_AXLE_X, rear: LC76_REAR_AXLE_X };
const TRACK: Readonly<Record<CarAxle, number>> = { front: LC76_FRONT_TRACK, rear: LC76_REAR_TRACK };

function finite(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** An axle's pose: where its centre is in the body frame, and its roll (positive with the right end higher). */
export interface AxlePose {
  readonly position: Vec3Tuple;
  readonly roll: number;
}

export function axlePose(car: Readonly<CarVisualState> | null, axle: CarAxle): AxlePose {
  const index = axle === "front" ? 0 : 1;
  const heave = finite(car?.axleHeave[index]);
  const roll = finite(car?.axleRoll[index]);
  return { position: [AXLE_X[axle], LC76_WHEEL_CENTRE_Y + heave, 0], roll };
}

function rotX([x, y, z]: Vec3Tuple, angle: number): Vec3Tuple {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x, y * c - z * s, y * s + z * c];
}
function rotY([x, y, z]: Vec3Tuple, angle: number): Vec3Tuple {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}
function rotZ([x, y, z]: Vec3Tuple, angle: number): Vec3Tuple {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c, z];
}

/** A point in an axle's frame, in the body frame. Roll right-end-up is a negative turn about +x. */
export function onAxle(pose: AxlePose, point: Vec3Tuple): Vec3Tuple {
  const turned = rotX(point, -pose.roll);
  return [pose.position[0] + turned[0], pose.position[1] + turned[1], pose.position[2] + turned[2]];
}

function writeMatrix(out: Float32Array, offset: number, x: Vec3Tuple, y: Vec3Tuple, z: Vec3Tuple, at: Vec3Tuple): void {
  out[offset] = x[0];
  out[offset + 1] = x[1];
  out[offset + 2] = x[2];
  out[offset + 3] = 0;
  out[offset + 4] = y[0];
  out[offset + 5] = y[1];
  out[offset + 6] = y[2];
  out[offset + 7] = 0;
  out[offset + 8] = z[0];
  out[offset + 9] = z[1];
  out[offset + 10] = z[2];
  out[offset + 11] = 0;
  out[offset + 12] = at[0];
  out[offset + 13] = at[1];
  out[offset + 14] = at[2];
  out[offset + 15] = 1;
}

/** Wheels in `CAR_WHEELS` order, then the spare. */
export const CAR_WHEEL_INSTANCES = 5;

/** The spare, lying face down under the tail between the rails, where the hull's tank probes are. */
export const SPARE_WHEEL = Object.freeze({ x: LC76_REAR_AXLE_X - 0.6, y: h(0.5825) });

/** The wheels' thin-instance matrices: the four road wheels from the payload, then the spare. */
export function writeWheelMatrices(car: Readonly<CarVisualState> | null, out: Float32Array): void {
  for (let wheel = 0; wheel < 4; wheel += 1) {
    const axle: CarAxle = wheel < 2 ? "front" : "rear";
    const side = wheel % 2 === 0 ? -1 : 1;
    const pose = axlePose(car, axle);
    const steer = finite(car?.wheelSteer[wheel]);
    const spin = finite(car?.wheelSpin[wheel]);
    // Rolling forward turns the wheel's top toward +x. The wheel is built with
    // its face to +z, so the left wheels are first turned round about y, which
    // turns their roll the other way.
    const local = (axis: Vec3Tuple): Vec3Tuple => {
      let v = side > 0 ? rotZ(axis, -spin) : rotY(rotZ(axis, spin), Math.PI);
      // Positive steer turns the wheel's front to the right (+z): a negative turn about +y.
      v = rotY(v, -steer);
      return rotX(v, -pose.roll);
    };
    const centre = onAxle(pose, [0, 0, (side * TRACK[axle]) / 2]);
    writeMatrix(out, wheel * 16, local([1, 0, 0]), local([0, 1, 0]), local([0, 0, 1]), centre);
  }
  // Face down: its +z (the face) turned to -y.
  writeMatrix(out, 4 * 16, [1, 0, 0], [0, 0, 1], [0, -1, 0], [SPARE_WHEEL.x, SPARE_WHEEL.y, 0]);
}

type Anchor = readonly [frame: "body" | CarAxle, x: number, y: number, z: number];

interface LinkSpec {
  readonly name: string;
  readonly from: Anchor;
  readonly to: Anchor;
  /** Radius, or half-width across and half-thickness for a flat leaf. */
  readonly radius: number;
  readonly thickness?: number;
}

const FA = LC76_FRONT_AXLE_X;
const RA = LC76_REAR_AXLE_X;

function sides<T>(build: (side: -1 | 1) => T): T[] {
  return [build(-1), build(1)];
}

/**
 * Every link between the frame and the axles. Front: the dampers behind the
 * axle, the radius arms back to the frame, the Panhard rod across and the
 * front propeller shaft. Rear: each leaf pack as two straight halves from its
 * hanger to the axle's seat and on to its shackle, the staggered dampers and
 * the rear propeller shaft.
 */
export const CAR_LINKS: readonly LinkSpec[] = Object.freeze([
  ...sides((s): LinkSpec => ({ name: `front-damper-${s}`, from: ["front", -0.1, 0, s * 0.5], to: ["body", FA - 0.12, h(0.88), s * 0.5], radius: 0.026 })),
  ...sides((s): LinkSpec => ({ name: `radius-arm-${s}`, from: ["front", 0, -0.04, s * 0.42], to: ["body", FA - 0.95, h(0.47), s * 0.43], radius: 0.03 })),
  { name: "panhard", from: ["front", 0.06, 0.04, -0.56], to: ["body", FA + 0.06, h(0.6), 0.41], radius: 0.02 },
  { name: "front-prop", from: ["body", 0.32, h(0.47), 0.1], to: ["front", -0.22, 0.04, 0], radius: 0.03 },
  ...sides((s): LinkSpec => ({ name: `leaf-front-${s}`, from: ["body", RA + 0.64, h(0.52), s * 0.5], to: ["rear", 0, 0.07, s * 0.5], radius: 0.032, thickness: 0.02 })),
  ...sides((s): LinkSpec => ({ name: `leaf-rear-${s}`, from: ["rear", 0, 0.07, s * 0.5], to: ["body", RA - 0.64, h(0.55), s * 0.5], radius: 0.032, thickness: 0.02 })),
  ...sides((s): LinkSpec => ({ name: `rear-damper-${s}`, from: ["rear", s * -0.12, -0.03, s * 0.52], to: ["body", RA + s * -0.3, h(0.84), s * 0.42], radius: 0.026 })),
  { name: "rear-prop", from: ["body", -0.37, h(0.47), 0], to: ["rear", 0.22, 0.04, 0], radius: 0.035 },
]);

/** The front coil springs: from the axle's perch up to the frame's spring seat. */
export const CAR_COILS: readonly LinkSpec[] = Object.freeze(
  sides((s): LinkSpec => ({ name: `front-coil-${s}`, from: ["front", 0, 0.06, s * 0.56], to: ["body", FA, h(0.8), s * 0.56], radius: 1 })),
);

function anchorPoint(anchor: Anchor, front: AxlePose, rear: AxlePose): Vec3Tuple {
  const [frame, x, y, z] = anchor;
  if (frame === "body") return [x, y, z];
  return onAxle(frame === "front" ? front : rear, [x, y, z]);
}

/** A link's two ends in the body frame, for the payload's axle poses. */
export function linkEnds(link: LinkSpec, car: Readonly<CarVisualState> | null): readonly [Vec3Tuple, Vec3Tuple] {
  const front = axlePose(car, "front");
  const rear = axlePose(car, "rear");
  return [anchorPoint(link.from, front, rear), anchorPoint(link.to, front, rear)];
}

/**
 * Thin-instance matrices for `links`: each unit bar (or coil of `restLength`)
 * stretched from its first end to its second, its width across the car for
 * a flat leaf.
 */
export function writeLinkMatrices(
  links: readonly LinkSpec[],
  car: Readonly<CarVisualState> | null,
  out: Float32Array,
  restLength = 1,
): void {
  for (const [index, link] of links.entries()) {
    const [from, to] = linkEnds(link, car);
    const along: Vec3Tuple = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const axis = normalize3(along);
    // Across: the car's z, square to the link (a leaf lies flat across the car).
    const hint: Vec3Tuple = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const d = dot3(hint, axis);
    const across = normalize3([hint[0] - d * axis[0], hint[1] - d * axis[1], hint[2] - d * axis[2]]);
    const third = cross3(across, axis);
    const width = link.radius;
    const depth = link.thickness ?? link.radius;
    writeMatrix(
      out,
      index * 16,
      [across[0] * width, across[1] * width, across[2] * width],
      [along[0] / restLength, along[1] / restLength, along[2] / restLength],
      [third[0] * depth, third[1] * depth, third[2] * depth],
      from,
    );
  }
}

/** A box that holds every posed wheel and link at any travel and steer: the thin instances' fixed bounds. */
export const RUNNING_GEAR_BOUNDS = Object.freeze({
  min: Object.freeze([BODY.bumperRear - 0.1, h(-0.05), -1.05]) as Vec3Tuple,
  max: Object.freeze([BODY.bumperFront + 0.1, h(1.25), 1.05]) as Vec3Tuple,
});
