import { polygonSurface, type Surface, type Vec3Tuple } from "../boat/boatMeshData";
import { dialNeedleAngle, dialUv, finishUv, type CarDial, type CarFinish } from "./carAtlas";
import { bar, box, cross3, disc, ellipsoid, latheZ, normalize3, prismZ, tube, type Point2, type UvFor } from "./carShapes";
import { BODY, DRIVER_EYE, h, STEERING_WHEEL } from "./lc76Lines";

/**
 * The LandCruiser 76's cabin, drawn: the dash and its binnacle with the four
 * dials, the steering column and wheel, the console with the gear and
 * transfer levers, and the seats. Right-hand drive: the driver sits on the
 * right (+Z).
 *
 * The dials' faces are on the body's atlas (their markings glow by night
 * through its emissive map); their needles are thin instances of one needle,
 * each turned by `dialNeedleAngle` to the reading, and the steering wheel is
 * its own node, turned by `CarVisualState.steeringWheel`.
 */

const swatch = (finish: CarFinish): UvFor => {
  const uv = finishUv(finish);
  return () => uv;
};

function elevation(points: readonly Point2[]): Point2[] {
  return points.map(([x, height]) => [x, h(height)]);
}

/** The binnacle's face, where the dials are: (x, height) at its foot and head. */
const FACE_FOOT: Point2 = [0.385, 1.215];
const FACE_HEAD: Point2 = [0.43, 1.375];
const BINNACLE = Object.freeze({ z: DRIVER_EYE.z, halfWidth: 0.215 });

/** The face's frame: `up` along it, `right` across (+Z), `normal` back toward the driver. */
const FACE_UP = normalize3([FACE_HEAD[0] - FACE_FOOT[0], FACE_HEAD[1] - FACE_FOOT[1], 0]);
const FACE_RIGHT: Vec3Tuple = [0, 0, 1];
const FACE_NORMAL = cross3(FACE_RIGHT, FACE_UP);

export interface DialPlacement {
  readonly dial: CarDial;
  readonly centre: Vec3Tuple;
  readonly radius: number;
  readonly right: Vec3Tuple;
  readonly up: Vec3Tuple;
  readonly normal: Vec3Tuple;
}

function facePoint(height: number, z: number): Vec3Tuple {
  const t = (height - FACE_FOOT[1]) / (FACE_HEAD[1] - FACE_FOOT[1]);
  const x = FACE_FOOT[0] + (FACE_HEAD[0] - FACE_FOOT[0]) * t;
  return [x + FACE_NORMAL[0] * 0.002, h(height) + FACE_NORMAL[1] * 0.002, z];
}

/** The dials, left to right as the driver sees them: fuel, tachometer, speedometer, temperature. */
export const CAR_DIALS: readonly DialPlacement[] = Object.freeze(
  ([
    ["fuel", 1.29, -0.165, 0.03],
    ["tachometer", 1.3, -0.072, 0.056],
    ["speedometer", 1.3, 0.072, 0.056],
    ["temperature", 1.29, 0.165, 0.03],
  ] as const).map(([dial, height, offset, radius]) => Object.freeze({
    dial,
    centre: facePoint(height, BINNACLE.z + offset),
    radius,
    right: FACE_RIGHT,
    up: FACE_UP,
    normal: FACE_NORMAL,
  })),
);

/** What the needles read, from the payload. */
export interface DialReadings {
  readonly engineRpm: number;
  readonly speedKmh: number;
  readonly fuel: number;
  readonly temperature: number;
}

export function dialReading(dial: CarDial, readings: DialReadings): number {
  switch (dial) {
    case "tachometer":
      return readings.engineRpm;
    case "speedometer":
      return readings.speedKmh;
    case "fuel":
      return readings.fuel;
    case "temperature":
      return readings.temperature;
  }
}

/** The needles' thin-instance matrices: each needle turned clockwise (as the driver sees it) by its dial's law. */
export function writeNeedleMatrices(readings: DialReadings, out: Float32Array): void {
  for (const [index, placement] of CAR_DIALS.entries()) {
    const angle = dialNeedleAngle(placement.dial, dialReading(placement.dial, readings));
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const { up, right, normal, radius, centre } = placement;
    const needleUp: Vec3Tuple = [up[0] * c + right[0] * s, up[1] * c + right[1] * s, up[2] * c + right[2] * s];
    const needleRight: Vec3Tuple = [right[0] * c - up[0] * s, right[1] * c - up[1] * s, right[2] * c - up[2] * s];
    const o = index * 16;
    out.set([
      needleRight[0] * radius, needleRight[1] * radius, needleRight[2] * radius, 0,
      needleUp[0] * radius, needleUp[1] * radius, needleUp[2] * radius, 0,
      normal[0] * radius, normal[1] * radius, normal[2] * radius, 0,
      centre[0] + normal[0] * 0.003, centre[1] + normal[1] * 0.003, centre[2] + normal[2] * 0.003, 1,
    ], o);
  }
}

/** One needle in units of its dial's radius: pointing up its face (+y), showing +z. */
export function needleSurfaces(): Surface[] {
  const glow = swatch("needle");
  return [
    polygonSurface([[-0.045, -0.14], [0.045, -0.14], [0.012, 0.86], [-0.012, 0.86]], (a, b) => [a, b, 0], glow),
    disc([0, 0, 0.004], [0, 0, 1], 0.13, 12, swatch("dash")),
  ];
}

/** The dials' faces on the binnacle. */
function dialFaceSurfaces(): Surface[] {
  return CAR_DIALS.map((placement) => {
    const outline: Point2[] = [];
    for (let k = 0; k < 36; k += 1) {
      const angle = (k / 36) * Math.PI * 2;
      outline.push([Math.cos(angle), Math.sin(angle)]);
    }
    const { centre, right, up, radius } = placement;
    return polygonSurface(
      outline,
      (s, t) => [
        centre[0] + (right[0] * s + up[0] * t) * radius,
        centre[1] + (right[1] * s + up[1] * t) * radius,
        centre[2] + (right[2] * s + up[2] * t) * radius,
      ],
      (point) => {
        const d: Vec3Tuple = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
        const s = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / radius;
        const t = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / radius;
        return dialUv(placement.dial, s, t);
      },
    );
  });
}

/** The steering column's axis, from the wheel's hub toward the dash. */
const COLUMN: Vec3Tuple = [Math.cos(STEERING_WHEEL.tiltRadians), -Math.sin(STEERING_WHEEL.tiltRadians), 0];

/** The wheel's hub in the body frame. */
export const STEERING_WHEEL_CENTRE: Vec3Tuple = Object.freeze([STEERING_WHEEL.x, h(STEERING_WHEEL.height), STEERING_WHEEL.z]) as Vec3Tuple;

function seat(z: number, halfWidth: number, cushion: readonly Point2[], back: readonly Point2[], finish: CarFinish): Surface[] {
  const uv = swatch(finish);
  return [
    ...prismZ(elevation(cushion), z - halfWidth, z + halfWidth, { chamfer: 0.03, creaseRadians: 0.5, faceUv: uv }),
    ...prismZ(elevation(back), z - halfWidth - 0.01, z + halfWidth + 0.01, { chamfer: 0.035, creaseRadians: 0.5, faceUv: uv }),
  ];
}

/** Every static part of the cabin in front of and around the occupants, body frame. */
export function cabinSurfaces(): Surface[] {
  const dash = swatch("dash");
  const trim = swatch("trim");
  const wall = BODY.halfWidth - 0.05;
  const surfaces: Surface[] = [
    // The dash, its top rising to the windscreen's foot so nothing outside shows between them.
    ...prismZ(elevation([[0.45, 0.92], [0.7, 0.74], [0.785, 1.315], [0.5, 1.265], [0.46, 1.17]]), -wall, wall, {
      chamfer: 0.012,
      creaseRadians: 0.5,
      faceUv: dash,
    }),
    // The binnacle: a block on the dash in front of the driver, its rear face the dials' panel, under a hood.
    ...prismZ(elevation([FACE_FOOT, [0.58, FACE_FOOT[1]], [0.58, FACE_HEAD[1]], FACE_HEAD]), BINNACLE.z - BINNACLE.halfWidth, BINNACLE.z + BINNACLE.halfWidth, {
      chamfer: 0.006,
      faceUv: dash,
      rimUv: (point) => (point[0] < 0.43 && point[1] < h(FACE_HEAD[1]) - 0.003 ? finishUv("grilleBlack") : finishUv("dash")),
    }),
    ...prismZ(elevation([[FACE_HEAD[0] - 0.05, FACE_HEAD[1]], [0.6, FACE_HEAD[1]], [0.6, FACE_HEAD[1] + 0.026], [FACE_HEAD[0] - 0.054, FACE_HEAD[1] + 0.022]]), BINNACLE.z - BINNACLE.halfWidth - 0.008, BINNACLE.z + BINNACLE.halfWidth + 0.008, {
      chamfer: 0.008,
      faceUv: dash,
    }),
    ...dialFaceSurfaces(),
    // The head unit and climate panel in the dash's middle.
    ...box([0.452, h(1.0), -0.12], [0.47, h(1.14), 0.12], trim, 0.006),
    // The steering column's shroud.
    ...tube(
      [
        [STEERING_WHEEL_CENTRE[0] + COLUMN[0] * 0.07, STEERING_WHEEL_CENTRE[1] + COLUMN[1] * 0.07, STEERING_WHEEL.z],
        [STEERING_WHEEL_CENTRE[0] + COLUMN[0] * 0.34, STEERING_WHEEL_CENTRE[1] + COLUMN[1] * 0.34, STEERING_WHEEL.z],
      ],
      0.042,
      10,
      dash,
    ),
    // The console between the front seats, the gear selector and the transfer lever.
    ...box([-0.45, h(0.68), -0.1], [0.43, h(0.9), 0.1], dash, 0.02),
    ...bar([0.24, h(0.9), 0.02], [0.2, h(1.13), 0.03], 0.011, 6, dash),
    ellipsoid([0.2, h(1.15), 0.03], [0.026, 0.032, 0.026], 5, 8, dash),
    ...bar([0.12, h(0.9), -0.05], [0.09, h(1.07), -0.06], 0.009, 6, dash),
    ellipsoid([0.09, h(1.085), -0.06], [0.02, 0.022, 0.02], 5, 8, dash),
  ];
  const frontCushion: Point2[] = [[-0.58, 0.93], [-0.08, 0.95], [-0.06, 1.03], [-0.12, 1.06], [-0.58, 1.03]];
  const frontBack: Point2[] = [[-0.66, 1.0], [-0.52, 1.0], [-0.62, 1.6], [-0.74, 1.6]];
  for (const z of [-DRIVER_EYE.z, DRIVER_EYE.z]) {
    surfaces.push(...seat(z, 0.24, frontCushion, frontBack, "seat"));
    surfaces.push(...box([-0.79, h(1.63), z - 0.13], [-0.67, h(1.81), z + 0.13], swatch("seat"), 0.03));
    surfaces.push(...box([-0.55, h(0.68), z - 0.2], [-0.12, h(0.93), z + 0.2], trim, 0.01));
  }
  surfaces.push(...seat(0, 0.7, [[-1.45, 1.0], [-0.98, 1.0], [-0.96, 1.07], [-1.0, 1.1], [-1.45, 1.08]], [[-1.53, 1.05], [-1.41, 1.05], [-1.49, 1.62], [-1.61, 1.62]], "seat"));
  surfaces.push(...box([-1.42, h(0.68), -0.68], [-1.0, h(1.0), 0.68], trim, 0.01));
  return surfaces;
}

/**
 * The steering wheel in its own frame: the rim in the y-z plane round the
 * hub, facing the driver along -x. Its node stands at the hub, tilted back by
 * the column's rake, and turns about its x axis.
 */
export function steeringWheelSurfaces(): Surface[] {
  const radius = STEERING_WHEEL.radius;
  const grip = 0.016;
  const profile: Point2[] = [];
  for (let k = 0; k <= 10; k += 1) {
    const angle = (k / 10) * Math.PI * 2;
    profile.push([radius + Math.cos(angle) * grip, Math.sin(angle) * grip]);
  }
  // A torus about z, turned so its axis is -x: (x, y, z) -> (-z, y, x), a proper rotation.
  const torus = latheZ(profile, 40, () => finishUv("wheelGrip"));
  for (let index = 0; index < torus.positions.length; index += 3) {
    const x = torus.positions[index]!;
    const z = torus.positions[index + 2]!;
    torus.positions[index] = -z;
    torus.positions[index + 2] = x;
  }
  const spoke = swatch("dash");
  return [
    torus,
    ...bar([0.035, 0, -0.05], [0, 0, -radius + 0.008], 0.013, 6, spoke),
    ...bar([0.035, 0, 0.05], [0, 0, radius - 0.008], 0.013, 6, spoke),
    ...bar([0.035, -0.05, 0], [0, -radius + 0.008, 0], 0.013, 6, spoke),
    ellipsoid([0.03, -0.005, 0], [0.03, 0.06, 0.07], 6, 12, spoke),
    disc([-0.001, 0.005, 0], [-1, 0, 0], 0.022, 16, swatch("badge")),
  ];
}
