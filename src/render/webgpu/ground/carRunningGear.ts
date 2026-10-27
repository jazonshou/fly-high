import type { CarVisualState } from "@/src/game/types";
import { Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { finishUv, TREAD_REPEATS, treadUv, type CarFinish } from "./carAtlas";
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

/** The tyre's section, (radius, z) from the inner bead over the tread to the outer bead; +z is the wheel's outer face. */
const TYRE_PROFILE: readonly Point2[] = [
  [0.212, -0.104],
  [0.245, -0.118],
  [0.29, -0.127],
  [0.335, -0.13],
  [0.362, -0.126],
  [0.377, -0.116],
  [0.383, -0.1],
  [0.385, -0.05],
  [0.3855, 0],
  [0.385, 0.05],
  [0.383, 0.1],
  [0.377, 0.116],
  [0.362, 0.126],
  [0.335, 0.13],
  [0.29, 0.127],
  [0.245, 0.118],
  [0.212, 0.104],
];
const TREAD_FROM = 5;
const TREAD_TO = 11;

/** The steel wheel's face, (radius, z) from the flange in to the centre cap. */
const RIM_PROFILE: readonly Point2[] = [
  [0.216, 0.1],
  [0.207, 0.104],
  [0.2, 0.096],
  [0.198, 0.07],
  [0.185, 0.056],
  [0.165, 0.046],
  [0.12, 0.043],
  [0.09, 0.046],
];
const HUB_PROFILE: readonly Point2[] = [
  [0.09, 0.046],
  [0.085, 0.06],
  [0.062, 0.066],
  [0.05, 0.073],
  [0, 0.075],
];

/** The six-stud pattern: 6 x 139.7 mm. */
export const WHEEL_STUDS = Object.freeze({ count: 6, pitchRadius: 0.1397 / 2 });

const AROUND = 48;

/** One wheel, in its own frame: centred on the tread, the axle along z, its outer face toward +z. */
export function wheelSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const sidewall = finishUv("sidewall");
  surfaces.push(latheZ(TYRE_PROFILE.slice(0, TREAD_FROM + 1), AROUND, () => sidewall));
  surfaces.push(latheZ(TYRE_PROFILE.slice(TREAD_TO), AROUND, () => sidewall));
  // The tread: one lathe arc per repeat of the map, so the pattern wraps without a seam smear.
  const tread = TYRE_PROFILE.slice(TREAD_FROM, TREAD_TO + 1);
  const perRepeat = AROUND / TREAD_REPEATS;
  for (let repeat = 0; repeat < TREAD_REPEATS; repeat += 1) {
    const from = (repeat / TREAD_REPEATS) * Math.PI * 2;
    const to = ((repeat + 1) / TREAD_REPEATS) * Math.PI * 2;
    surfaces.push(latheZ(tread, perRepeat, (_point, around, along) => treadUv(around, along), false, [0, 0, 0], from, to));
  }
  const steel = finishUv("steelWheel");
  surfaces.push(latheZ(RIM_PROFILE, AROUND, () => steel));
  const hub = finishUv("hub");
  surfaces.push(latheZ(HUB_PROFILE, 24, () => hub));
  for (let stud = 0; stud < WHEEL_STUDS.count; stud += 1) {
    const angle = (stud / WHEEL_STUDS.count) * Math.PI * 2;
    const x = Math.cos(angle) * WHEEL_STUDS.pitchRadius;
    const y = Math.sin(angle) * WHEEL_STUDS.pitchRadius;
    surfaces.push(...bar([x, y, 0.044], [x, y, 0.062], 0.0105, 6, swatch("lugNut")));
  }
  // The wheel's back, seen from under the car through the inner bead.
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
