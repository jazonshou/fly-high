import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { dialNeedleAngle, finishUv, type BoatFinish } from "./boatAtlas";
import { BINNACLE, DASH_DIALS, dashFrame, WHEEL } from "./boatDeck";
import { BoatMeshData, Surface, type Vec3Tuple } from "./boatMeshData";

/**
 * The helm's moving parts as ONE mesh posed on the CPU: the wheel, the
 * throttle-and-shift lever, three needles and the depth sounder's digits.
 * They are a few hundred vertices, so rotating them on the CPU and uploading
 * the positions when something moved is cheaper than the draw each would cost
 * as a node of its own, and keeps the boat inside its draw budget.
 *
 * Every part is a rigid set of vertices turning about its own pivot and axis;
 * a digit segment that is not lit collapses to its centre, rasterising
 * nothing.
 */

/** Wheel turns per radian of outboard steer: three turns lock to lock over the 60 degrees. */
export const WHEEL_TURNS_LOCK_TO_LOCK = 3;
export const WHEEL_RATIO = (WHEEL_TURNS_LOCK_TO_LOCK * 2 * Math.PI) / ((60 * Math.PI) / 180);

const DIGITS = 3;
/** Seven segments a b c d e f g, then the decimal point. */
const SEGMENTS_PER_DIGIT = 7;
const DIGIT_SEGMENTS: Readonly<Record<string, string>> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd",
  "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcfgd", "-": "g", " ": "",
};

interface RigidPart {
  readonly first: number;
  readonly count: number;
  readonly pivot: Vec3Tuple;
  readonly axis: Vec3Tuple;
}

export interface HelmPose {
  /** Outboard steer, radians, positive bow to starboard. */
  readonly steerAngle: number;
  /** -1 full astern .. +1 full ahead. */
  readonly lever: number;
  readonly engineRpm: number;
  /** Speed through the water, m/s. */
  readonly speedMetersPerSecond: number;
  /** 0..1 of the trim range. */
  readonly trim: number;
  /** Water under the keel, metres; not finite shows dashes. */
  readonly depthMeters: number;
}

export const NEUTRAL_HELM_POSE: HelmPose = Object.freeze({
  steerAngle: 0,
  lever: 0,
  engineRpm: 0,
  speedMetersPerSecond: 0,
  trim: 0,
  depthMeters: Number.NaN,
});

const MPH_PER_METER_PER_SECOND = 2.236_936;
const FEET_PER_METER = 3.280_84;

/** What the depth sounder shows for a depth, three characters with the point before the last. */
export function depthSounderText(depthMeters: number): string {
  if (!Number.isFinite(depthMeters) || depthMeters < 0) return "---";
  const tenths = Math.min(999, Math.round(depthMeters * FEET_PER_METER * 10));
  const text = String(tenths).padStart(2, "0");
  return text.length < 3 ? ` ${text}` : text;
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function add(a: Vec3Tuple, b: Vec3Tuple, scale = 1): Vec3Tuple {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

/** A tube swept round a circle of `radius` about `axis` at `centre`, shown outward. */
function torus(centre: Vec3Tuple, axis: Vec3Tuple, radius: number, tube: number, finish: BoatFinish): Surface {
  const surface = new Surface();
  const helper: Vec3Tuple = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalise(cross(axis, helper));
  const e2 = cross(axis, e1);
  const major = 36;
  const minor = 8;
  const uv = finishUv(finish);
  const rows: Vec3Tuple[][] = [];
  for (let i = 0; i <= major; i += 1) {
    const a = (i / major) * Math.PI * 2;
    const radial = add(scaleVec(e1, Math.cos(a)), e2, Math.sin(a));
    const ringCentre = add(centre, radial, radius);
    const ring: Vec3Tuple[] = [];
    for (let j = 0; j <= minor; j += 1) {
      const b = (j / minor) * Math.PI * 2;
      ring.push(add(add(ringCentre, radial, Math.cos(b) * tube), axis, Math.sin(b) * tube));
    }
    rows.push(ring);
  }
  surface.grid(rows, () => uv);
  // Stations run round the axis (e1 to e2, so along axis x radial) and the girth
  // goes radial -> axis: shown = tangent x girth, which is outward. Checked:
  // at b = 0 the girth is +axis, tangent x axis = radial.
  return surface;
}

function scaleVec(a: Vec3Tuple, s: number): Vec3Tuple {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function normalise(a: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** A box between two points along `along`, `width` across `side` and `depth` along the third axis. */
function bar(from: Vec3Tuple, to: Vec3Tuple, side: Vec3Tuple, width: number, depth: number, finish: BoatFinish): Surface {
  const surface = new Surface();
  const along = normalise([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  const s = normalise(side);
  const t = normalise(cross(along, s));
  const uv = finishUv(finish);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const ring = (end: Vec3Tuple) => corners.map(([a, b]) => surface.vertexAt(add(add(end, s, a * width / 2), t, b * depth / 2), uv));
  const r0 = ring(from);
  const r1 = ring(to);
  for (let k = 0; k < 4; k += 1) {
    const [a, b] = corners[k]!;
    const [c, d] = corners[(k + 1) % 4]!;
    const outward = add(scaleVec(s, a + c), t, b + d);
    surface.triFacing(r0[k]!, r0[(k + 1) % 4]!, r1[(k + 1) % 4]!, outward);
    surface.triFacing(r0[k]!, r1[(k + 1) % 4]!, r1[k]!, outward);
  }
  surface.triFacing(r1[0]!, r1[1]!, r1[2]!, along);
  surface.triFacing(r1[0]!, r1[2]!, r1[3]!, along);
  return surface;
}

/** A small sphere, shown outward. */
function ball(centre: Vec3Tuple, radius: number, finish: BoatFinish): Surface {
  const surface = new Surface();
  const uv = finishUv(finish);
  const rows: Vec3Tuple[][] = [];
  for (let i = 0; i <= 8; i += 1) {
    const polar = (i / 8) * Math.PI;
    const ring: Vec3Tuple[] = [];
    for (let j = 0; j <= 12; j += 1) {
      const azimuth = (j / 12) * Math.PI * 2;
      ring.push([
        centre[0] + Math.sin(polar) * Math.cos(azimuth) * radius,
        centre[1] + Math.cos(polar) * radius,
        centre[2] - Math.sin(polar) * Math.sin(azimuth) * radius,
      ]);
    }
    rows.push(ring);
  }
  // Stations top to bottom (-y), girth round towards -z at +x: (-y) x (-z) = +x, outward.
  surface.grid(rows, () => uv);
  return surface;
}

/** A thin quad lying on a plane of normal `normal`, from `a` to `b` with widths `wa`, `wb`, shown along `normal`. */
function flatStrip(a: Vec3Tuple, b: Vec3Tuple, wa: number, wb: number, normal: Vec3Tuple, finish: BoatFinish): Surface {
  const surface = new Surface();
  const along = normalise([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const across = normalise(cross(normal, along));
  const uv = finishUv(finish);
  const v0 = surface.vertexAt(add(a, across, -wa / 2), uv);
  const v1 = surface.vertexAt(add(a, across, wa / 2), uv);
  const v2 = surface.vertexAt(add(b, across, wb / 2), uv);
  const v3 = surface.vertexAt(add(b, across, -wb / 2), uv);
  surface.triFacing(v0, v1, v2, normal);
  surface.triFacing(v0, v2, v3, normal);
  return surface;
}

/** The posable helm, built once, in the body frame (`origin` is the hull-frame CG). */
export class BoatHelmRig {
  readonly restPositions: Float32Array;
  readonly restNormals: Float32Array;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  private readonly wheel: RigidPart;
  private readonly lever: RigidPart;
  private readonly needles: readonly RigidPart[];
  private readonly segments: readonly { readonly first: number; readonly count: number; readonly centre: Vec3Tuple }[];
  private readonly lastPose: number[] = [];

  constructor(origin: Vec3Tuple) {
    const data = new BoatMeshData();
    const record = (surfaces: readonly Surface[], pivot: Vec3Tuple, axis: Vec3Tuple): RigidPart => {
      const first = data.vertexCount;
      for (const surface of surfaces) data.add(surface, origin);
      return { first, count: data.vertexCount - first, pivot: add(pivot, origin, -1), axis: normalise(axis) };
    };

    // The wheel: rim, three spokes and a hub, about the steering shaft.
    const shaftBase = dashFrame(WHEEL.dashS, WHEEL.z);
    const axis = shaftBase.normal;
    const centre = add(shaftBase.point, axis, WHEEL.shaftLength);
    const helper: Vec3Tuple = [0, 0, 1];
    const e1 = normalise(cross(axis, helper));
    const e2 = cross(axis, e1);
    const wheelParts: Surface[] = [torus(centre, axis, WHEEL.radius, 0.014, "rubber")];
    for (let spoke = 0; spoke < 3; spoke += 1) {
      // Spokes at 10, 2 and 6 o'clock as the driver sees the wheel centred.
      const angle = Math.PI / 2 + Math.PI / 3 + (spoke * 2 * Math.PI) / 3;
      const direction = add(scaleVec(e2, Math.sin(angle)), e1, Math.cos(angle));
      wheelParts.push(bar(add(centre, direction, 0.03), add(centre, direction, WHEEL.radius - 0.008), axis, 0.018, 0.008, "stainless"));
    }
    wheelParts.push(torus(add(centre, axis, -0.01), axis, 0.026, 0.016, "stainless"));
    this.wheel = record(wheelParts, centre, axis);

    // The lever on the binnacle's inboard face: a bar up from the pivot and a knob.
    const pivot: Vec3Tuple = [BINNACLE.x, BINNACLE.y, BINNACLE.z - 0.062];
    const tip: Vec3Tuple = [pivot[0], pivot[1] + BINNACLE.leverLength, pivot[2]];
    this.lever = record([
      bar(pivot, tip, [1, 0, 0], 0.016, 0.012, "stainless"),
      ball(tip, 0.024, "dash"),
    ], pivot, [0, 0, 1]);

    // Needles on the three round dials, built pointing straight up the face.
    const needles: RigidPart[] = [];
    for (const dial of DASH_DIALS) {
      if (dial.dial === "depth") continue;
      const frame = dashFrame(dial.s, dial.z);
      const face = add(frame.point, frame.normal, 0.008);
      needles.push(record([
        flatStrip(add(face, frame.up, -dial.radius * 0.2), add(face, frame.up, dial.radius * 0.82), 0.005, 0.0015, frame.normal, "needle"),
        flatStrip(add(add(face, frame.normal, 0.001), frame.up, -0.006), add(add(face, frame.normal, 0.001), frame.up, 0.006), 0.012, 0.012, frame.normal, "dash"),
      ], face, frame.normal));
    }
    this.needles = needles;

    // The depth sounder's digits: segments a-g per digit, and a point.
    const depth = DASH_DIALS.find((dial) => dial.dial === "depth")!;
    const frame = dashFrame(depth.s, depth.z);
    const face = add(frame.point, frame.normal, 0.006);
    const height = depth.radius * 0.62;
    const width = height * 0.52;
    const thickness = height * 0.12;
    const segments: { first: number; count: number; centre: Vec3Tuple }[] = [];
    for (let digit = 0; digit < DIGITS; digit += 1) {
      const cx = (digit - 1) * width * 1.45;
      const at = (sx: number, sy: number): Vec3Tuple => add(add(face, frame.right, cx + sx * width / 2), frame.up, height * 0.12 + sy * height / 2);
      const lines: [Vec3Tuple, Vec3Tuple][] = [
        [at(-0.8, 1), at(0.8, 1)], // a
        [at(1, 0.9), at(1, 0.1)], // b
        [at(1, -0.1), at(1, -0.9)], // c
        [at(-0.8, -1), at(0.8, -1)], // d
        [at(-1, -0.1), at(-1, -0.9)], // e
        [at(-1, 0.9), at(-1, 0.1)], // f
        [at(-0.8, 0), at(0.8, 0)], // g
      ];
      for (const [a, b] of lines) {
        const first = data.vertexCount;
        data.add(flatStrip(a, b, thickness, thickness, frame.normal, "segment"), origin);
        segments.push({ first, count: data.vertexCount - first, centre: add(scaleVec(add(a, b), 0.5), origin, -1) });
      }
    }
    const pointAt = add(add(face, frame.right, width * 1.45 * 0.5), frame.up, height * 0.12 - height / 2);
    const pointFirst = data.vertexCount;
    data.add(flatStrip(add(pointAt, frame.up, -thickness / 2), add(pointAt, frame.up, thickness / 2), thickness, thickness, frame.normal, "segment"), origin);
    segments.push({ first: pointFirst, count: data.vertexCount - pointFirst, centre: add(pointAt, origin, -1) });
    this.segments = segments;

    this.restPositions = Float32Array.from(data.positions);
    this.restNormals = Float32Array.from(data.normals);
    this.positions = Float32Array.from(data.positions);
    this.normals = Float32Array.from(data.normals);
    this.uvs = Float32Array.from(data.uvs);
    this.indices = Uint32Array.from(data.indices);
  }

  toVertexData(): VertexData {
    const vertexData = new VertexData();
    vertexData.positions = this.positions;
    vertexData.normals = this.normals;
    vertexData.uvs = this.uvs;
    vertexData.indices = this.indices;
    return vertexData;
  }

  /**
   * Pose every part for `pose`. Returns false when nothing moved since the
   * last call, so the caller can skip the upload.
   */
  pose(pose: HelmPose): boolean {
    const wheelAngle = -(Number.isFinite(pose.steerAngle) ? pose.steerAngle : 0) * WHEEL_RATIO;
    const leverAngle = -Math.max(-1, Math.min(1, Number.isFinite(pose.lever) ? pose.lever : 0)) * ((BINNACLE.leverTravelDegrees * Math.PI) / 180);
    // The dials read clockwise as the driver sees them: about +normal that is negative.
    const tach = -dialNeedleAngle("tachometer", pose.engineRpm);
    const speed = -dialNeedleAngle("speedometer", pose.speedMetersPerSecond * MPH_PER_METER_PER_SECOND);
    const trim = -dialNeedleAngle("trim", pose.trim);
    const depth = depthSounderText(pose.depthMeters);
    const key = [wheelAngle, leverAngle, tach, speed, trim, depth.charCodeAt(0), depth.charCodeAt(1), depth.charCodeAt(2)];
    if (key.every((value, index) => Math.abs(value - (this.lastPose[index] ?? Number.NaN)) < 1e-5)) return false;
    this.lastPose.length = 0;
    this.lastPose.push(...key);
    this.rotate(this.wheel, wheelAngle);
    this.rotate(this.lever, leverAngle);
    const angles = [tach, speed, trim];
    for (const [index, needle] of this.needles.entries()) this.rotate(needle, angles[index]!);
    for (let digit = 0; digit < DIGITS; digit += 1) {
      const lit = DIGIT_SEGMENTS[depth[digit] ?? " "] ?? "";
      for (let segment = 0; segment < SEGMENTS_PER_DIGIT; segment += 1) {
        this.showSegment(digit * SEGMENTS_PER_DIGIT + segment, lit.includes("abcdefg"[segment]!));
      }
    }
    this.showSegment(DIGITS * SEGMENTS_PER_DIGIT, depth !== "---");
    return true;
  }

  private rotate(part: RigidPart, angle: number): void {
    // Rodrigues: v' = v cos + (k x v) sin + k (k . v)(1 - cos), about the pivot.
    const [kx, ky, kz] = part.axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const [px, py, pz] = part.pivot;
    for (let vertex = part.first; vertex < part.first + part.count; vertex += 1) {
      const at = vertex * 3;
      for (const [source, target, offset] of [
        [this.restPositions, this.positions, true],
        [this.restNormals, this.normals, false],
      ] as const) {
        const vx = source[at]! - (offset ? px : 0);
        const vy = source[at + 1]! - (offset ? py : 0);
        const vz = source[at + 2]! - (offset ? pz : 0);
        const dot = kx * vx + ky * vy + kz * vz;
        target[at] = vx * c + (ky * vz - kz * vy) * s + kx * dot * (1 - c) + (offset ? px : 0);
        target[at + 1] = vy * c + (kz * vx - kx * vz) * s + ky * dot * (1 - c) + (offset ? py : 0);
        target[at + 2] = vz * c + (kx * vy - ky * vx) * s + kz * dot * (1 - c) + (offset ? pz : 0);
      }
    }
  }

  private showSegment(index: number, lit: boolean): void {
    const segment = this.segments[index]!;
    for (let vertex = segment.first; vertex < segment.first + segment.count; vertex += 1) {
      const at = vertex * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        this.positions[at + axis] = lit ? this.restPositions[at + axis]! : segment.centre[axis]!;
      }
    }
  }
}
