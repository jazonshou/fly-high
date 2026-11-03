import type { Vec3 } from "../types";
import { createGroundPoint, type GroundField, type GroundPoint } from "./terrainPatch";

/**
 * A tyre's contact with the ground, found once per 120 Hz step (land plan,
 * "Tyre contact"): the tyre is a disc, sampled at five points round its
 * lower arc in the wheel plane and two across the tread.
 *
 * Each sample's ground point and gradient give a local tangent plane, and
 * the disc's penetration of that plane is R_eff - (C - G).n, with
 * R_eff = R sqrt(1 - (a.n)^2) the disc's reach towards a plane tilted across
 * it. A plane is only trusted near where it was sampled: a sample counts if
 * the disc's deepest point against its plane falls in that sample's own
 * stretch of the arc. The deepest trusted plane wins, and one more sample at
 * its contact point refines it, which is exact on the smooth Catmull-Rom
 * ground. Where the ground has an edge (a test ramp's toe, a step) the
 * buried sample point itself is the contact, pushing the wheel up and back,
 * so a tyre climbs a ledge.
 *
 * The substeps then read the step's plane: penetration from the wheel
 * centre's distance to it, so the terrain is not sampled per substep.
 */

/** Arc sample angles from straight down, forward positive. */
const ARC_ANGLES = [-50, -25, 0, 25, 50].map((degrees) => (degrees * Math.PI) / 180);
const ARC_SIN = ARC_ANGLES.map(Math.sin);
const ARC_COS = ARC_ANGLES.map(Math.cos);
/** The Voronoi bounds of the arc samples along the wheel's forward direction, in units of R. */
const ARC_BOUNDS = ARC_SIN.map((s, i) => [
  i === 0 ? -Infinity : (s + ARC_SIN[i - 1]!) / 2,
  i === ARC_SIN.length - 1 ? Infinity : (s + ARC_SIN[i + 1]!) / 2,
]);

/** A refinement this much shallower than its plane means a kink between them, metres. */
const REFINE_KINK = 0.01;

export interface WheelContact {
  /** Ground plane under the tyre this step: a point on it and its unit normal. */
  readonly point: Vec3;
  readonly normal: Vec3;
  /** Penetration at the step's start, metres (negative: clear of the ground by that much). */
  penetration: number;
  /** The ground height and gradient at the contact, for the surface and soil lookups. */
  readonly ground: GroundPoint;
}

export function createWheelContact(): WheelContact {
  return {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    penetration: -1,
    ground: createGroundPoint(),
  };
}

const sample: GroundPoint = createGroundPoint();
const best: GroundPoint = createGroundPoint();
const bestPoint: Vec3 = { x: 0, y: 0, z: 0 };
const normal: Vec3 = { x: 0, y: 1, z: 0 };
const forward: Vec3 = { x: 1, y: 0, z: 0 };
const up: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * Find the contact of the disc with centre `centre`, spin axis `axle`
 * (unit, pointing to the car's right) and radius `radius` against `ground`.
 * `halfTread` places the two samples across the tread.
 *
 * Numbers stay in locals and objects: no number crosses a call here, as
 * V8 boxes one that crosses a call it does not inline (the step allocates
 * nothing).
 */
export function findWheelContact(
  ground: GroundField,
  centre: Readonly<Vec3>,
  axle: Readonly<Vec3>,
  radius: number,
  halfTread: number,
  out: WheelContact,
): WheelContact {
  // The wheel plane's forward (level, across the axle) and up directions.
  let fx = axle.z;
  let fz = -axle.x;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-9) {
    fx /= fl;
    fz /= fl;
  } else {
    fx = 1;
    fz = 0;
  }
  forward.x = fx;
  forward.y = 0;
  forward.z = fz;
  // up = axle x forward
  up.x = axle.y * forward.z - axle.z * forward.y;
  up.y = axle.z * forward.x - axle.x * forward.z;
  up.z = axle.x * forward.y - axle.y * forward.x;

  let bestPenetration = -Infinity;
  let bestKind = 0; // 0 none, 1 plane, 2 edge point
  for (let k = 0; k < 7; k += 1) {
    let px: number;
    let py: number;
    let pz: number;
    let lower = -Infinity;
    let upper = Infinity;
    if (k < 5) {
      px = centre.x + radius * (ARC_SIN[k]! * forward.x - ARC_COS[k]! * up.x);
      py = centre.y + radius * (ARC_SIN[k]! * forward.y - ARC_COS[k]! * up.y);
      pz = centre.z + radius * (ARC_SIN[k]! * forward.z - ARC_COS[k]! * up.z);
      lower = ARC_BOUNDS[k]![0]! * radius;
      upper = ARC_BOUNDS[k]![1]! * radius;
    } else {
      // A sign times the argument: a choice between -halfTread and the argument itself would be boxed.
      const side = (k === 5 ? -1 : 1) * halfTread;
      px = centre.x - radius * up.x + side * axle.x;
      py = centre.y - radius * up.y + side * axle.y;
      pz = centre.z - radius * up.z + side * axle.z;
      lower = ARC_BOUNDS[2]![0]! * radius;
      upper = ARC_BOUNDS[2]![1]! * radius;
    }
    sample.x = px;
    sample.z = pz;
    ground.evaluate(sample);
    groundNormal(sample, normal);
    // The disc's penetration of this sample's tangent plane, and where along the wheel it meets it.
    const na = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
    const reach = Math.sqrt(Math.max(0, 1 - na * na));
    const penetration = radius * reach
      - ((centre.x - px) * normal.x + (centre.y - sample.height) * normal.y + (centre.z - pz) * normal.z);
    const along = reach > 1e-9
      ? (-radius * ((normal.x - na * axle.x) * forward.x
        + (normal.y - na * axle.y) * forward.y
        + (normal.z - na * axle.z) * forward.z)) / reach
      : 0;
    if (along >= lower && along <= upper && penetration > bestPenetration) {
      bestPenetration = penetration;
      bestKind = 1;
      copyGround(best, sample);
      bestPoint.x = px;
      bestPoint.y = sample.height;
      bestPoint.z = pz;
    }
    // A buried rim point is a contact of its own: the edge case of a step.
    if (k < 5 && sample.height > py) {
      const dx = centre.x - px;
      const dy = centre.y - sample.height;
      const dz = centre.z - pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const edge = radius - distance;
      if (edge > bestPenetration && distance > 1e-6) {
        bestPenetration = edge;
        bestKind = 2;
        copyGround(best, sample);
        bestPoint.x = px;
        bestPoint.y = sample.height;
        bestPoint.z = pz;
        out.normal.x = dx / distance;
        out.normal.y = dy / distance;
        out.normal.z = dz / distance;
      }
    }
  }

  if (bestKind === 2) {
    out.point.x = bestPoint.x;
    out.point.y = bestPoint.y;
    out.point.z = bestPoint.z;
    out.penetration = bestPenetration;
    copyGround(out.ground, best);
    return out;
  }
  if (bestKind === 0) {
    // No plane is trusted (a very rough patch): take the one under the centre.
    best.x = centre.x - radius * up.x;
    best.z = centre.z - radius * up.z;
    ground.evaluate(best);
    bestPoint.x = best.x;
    bestPoint.y = best.height;
    bestPoint.z = best.z;
  }
  // Refine: sample again where the disc meets the chosen plane.
  groundNormal(best, normal);
  const na = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
  const reach = Math.sqrt(Math.max(0, 1 - na * na));
  let qx = centre.x;
  let qz = centre.z;
  if (reach > 1e-9) {
    qx -= (radius * (normal.x - na * axle.x)) / reach;
    qz -= (radius * (normal.z - na * axle.z)) / reach;
  }
  sample.x = qx;
  sample.z = qz;
  ground.evaluate(sample);
  groundNormal(sample, out.normal);
  const n = out.normal;
  const refinedAn = n.x * axle.x + n.y * axle.y + n.z * axle.z;
  const refined = radius * Math.sqrt(Math.max(0, 1 - refinedAn * refinedAn))
    - ((centre.x - qx) * n.x + (centre.y - sample.height) * n.y + (centre.z - qz) * n.z);
  if (bestKind === 1 && refined < bestPenetration - REFINE_KINK) {
    // The refined point fell across a kink in the ground: keep the sampled plane.
    out.normal.x = normal.x;
    out.normal.y = normal.y;
    out.normal.z = normal.z;
    out.point.x = bestPoint.x;
    out.point.y = bestPoint.y;
    out.point.z = bestPoint.z;
    out.penetration = bestPenetration;
    copyGround(out.ground, best);
    return out;
  }
  out.point.x = qx;
  out.point.y = sample.height;
  out.point.z = qz;
  out.penetration = refined;
  copyGround(out.ground, sample);
  return out;
}

/** sqrt(1 - (a.n)^2): how far a unit disc reaches towards a plane of normal n. */
export function discReach(axle: Readonly<Vec3>, n: Readonly<Vec3>): number {
  const an = axle.x * n.x + axle.y * n.y + axle.z * n.z;
  return Math.sqrt(Math.max(0, 1 - an * an));
}

export function groundNormal(point: GroundPoint, out: Vec3): Vec3 {
  const inverse = 1 / Math.sqrt(point.dhdx * point.dhdx + 1 + point.dhdz * point.dhdz);
  out.x = -point.dhdx * inverse;
  out.y = inverse;
  out.z = -point.dhdz * inverse;
  return out;
}

function copyGround(out: GroundPoint, from: GroundPoint): void {
  out.x = from.x;
  out.z = from.z;
  out.height = from.height;
  out.dhdx = from.dhdx;
  out.dhdz = from.dhdz;
}
