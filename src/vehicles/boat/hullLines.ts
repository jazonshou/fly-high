/**
 * The Runabout 21's lines: the one definition of its hull shape.
 *
 * Two consumers loft from these numbers, so the hull that floats is the hull
 * on screen: the renderer's drawn hull (src/render/webgpu/boat/) and the
 * sim's coarse closed mesh and keel strips (src/sim/boat/hullMesh.ts). Both
 * read the stations through `sampleHullLines`, which interpolates every field
 * with the same monotone cubic, and both build sections with
 * `hullHalfSection`, so neither can drift through a second copy of the curves.
 *
 * The hull is a generic 21 ft deep-V sport runabout with a single 200 hp
 * outboard (decision D3, 2026-10-26): 6.55 m from the transom's bottom edge to
 * the stem head, 2.59 m beam at the sheer, 19 degrees of deadrise at the
 * transom warping to about 50 at the forefoot, three lifting strakes and a
 * reverse chine a side, and a transom raked 12 degrees for the outboard
 * bracket. The proportions follow the class (Sea Ray SPX 210, Four Winns
 * H210, Chaparral 21 SSi: 6.4-6.6 m, 2.5-2.6 m beam, 19-21 degree transom
 * deadrise); no maker's lines are copied.
 *
 * HULL FRAME (the frame these numbers are authored in):
 *   +x forward from the transom's bottom edge on the centreline,
 *   +y up from the keel baseline (the keel at the transom),
 *   +z to starboard; the hull is symmetric, so half-breadths are given once.
 * BODY FRAME (the sim's and the drawn boat's, `src/sim/types.ts`): the same
 * axes with the origin at the centre of gravity, `RUNABOUT_21_CG`. Convert
 * with `hullToBody`.
 */

import type { Vec3 } from "@/src/sim/types";

const DEG = Math.PI / 180;

/** One transverse station. Every length is metres in the hull frame. */
export interface HullStation {
  /** Forward of the transom's bottom edge. */
  readonly x: number;
  /** Keel height above the baseline: 0 along the aft run, rising to the stem. */
  readonly keel: number;
  /** Bottom deadrise, degrees above the horizontal, keel to chine. */
  readonly deadrise: number;
  /** Half-breadth of the chine (the bottom panel's outboard edge). */
  readonly chineHalfBeam: number;
  /** Half-breadth and height of the sheer (the gunwale's outer edge). */
  readonly sheerHalfBeam: number;
  readonly sheerHeight: number;
}

/**
 * Transom (x = 0) to stem head. The bottom panels are straight from keel to
 * chine, so the chine height is `keel + chineHalfBeam * tan(deadrise)`
 * (`chineHeight`). Forward of 6.40 m the chine has run into the stem and the
 * section is keel to sheer only; the keel there IS the stem profile.
 */
export const HULL_STATIONS: readonly HullStation[] = Object.freeze([
  { x: 0.0, keel: 0.0, deadrise: 19.0, chineHalfBeam: 1.02, sheerHalfBeam: 1.23, sheerHeight: 1.02 },
  { x: 0.5, keel: 0.0, deadrise: 19.0, chineHalfBeam: 1.035, sheerHalfBeam: 1.255, sheerHeight: 1.03 },
  { x: 1.0, keel: 0.0, deadrise: 19.2, chineHalfBeam: 1.045, sheerHalfBeam: 1.275, sheerHeight: 1.042 },
  { x: 1.5, keel: 0.0, deadrise: 19.6, chineHalfBeam: 1.05, sheerHalfBeam: 1.288, sheerHeight: 1.055 },
  { x: 2.0, keel: 0.0, deadrise: 20.3, chineHalfBeam: 1.048, sheerHalfBeam: 1.295, sheerHeight: 1.068 },
  { x: 2.5, keel: 0.004, deadrise: 21.3, chineHalfBeam: 1.04, sheerHalfBeam: 1.295, sheerHeight: 1.082 },
  { x: 3.0, keel: 0.012, deadrise: 22.8, chineHalfBeam: 1.02, sheerHalfBeam: 1.288, sheerHeight: 1.098 },
  { x: 3.5, keel: 0.028, deadrise: 24.8, chineHalfBeam: 0.985, sheerHalfBeam: 1.268, sheerHeight: 1.116 },
  { x: 4.0, keel: 0.055, deadrise: 27.5, chineHalfBeam: 0.925, sheerHalfBeam: 1.232, sheerHeight: 1.138 },
  { x: 4.5, keel: 0.098, deadrise: 31.0, chineHalfBeam: 0.835, sheerHalfBeam: 1.172, sheerHeight: 1.164 },
  { x: 5.0, keel: 0.165, deadrise: 35.0, chineHalfBeam: 0.705, sheerHalfBeam: 1.08, sheerHeight: 1.193 },
  { x: 5.5, keel: 0.275, deadrise: 40.0, chineHalfBeam: 0.525, sheerHalfBeam: 0.935, sheerHeight: 1.225 },
  { x: 5.9, keel: 0.42, deadrise: 44.5, chineHalfBeam: 0.33, sheerHalfBeam: 0.745, sheerHeight: 1.255 },
  { x: 6.2, keel: 0.6, deadrise: 48.0, chineHalfBeam: 0.15, sheerHalfBeam: 0.52, sheerHeight: 1.282 },
  { x: 6.4, keel: 0.95, deadrise: 52.0, chineHalfBeam: 0.0, sheerHalfBeam: 0.3, sheerHeight: 1.302 },
  { x: 6.55, keel: 1.32, deadrise: 55.0, chineHalfBeam: 0.0, sheerHalfBeam: 0.0, sheerHeight: 1.32 },
] satisfies HullStation[]);

/** Length from the transom's bottom edge to the stem head, and beam at the sheer. */
export const HULL_LENGTH = 6.55;
export const HULL_BEAM = 2.59;

/**
 * The transom: a plane through the bottom edge at x = 0, raked 12 degrees
 * from the vertical with its top FORWARD (x = y * tan(rake)), the angle an
 * outboard bracket is built for. Its bottom edge carries the 19 degree
 * transom deadrise of station 0.
 */
export const HULL_TRANSOM = Object.freeze({
  rakeDegrees: 12,
  deadriseDegrees: 19,
});

/** The transom plane's x at a height above the baseline. */
export function transomX(y: number): number {
  return Math.max(0, y) * Math.tan(HULL_TRANSOM.rakeDegrees * DEG);
}

/**
 * The stem profile, forefoot to stem head, as (x, y) pairs: the keel line of
 * the forward stations, listed separately for the renderer's stem bar.
 */
export const HULL_STEM_PROFILE: readonly { readonly x: number; readonly y: number }[] = Object.freeze(
  HULL_STATIONS.filter((station) => station.x >= 4.5).map((station) => Object.freeze({ x: station.x, y: station.keel })),
);

/**
 * A lifting strake: a small triangular rail on the bottom panel whose flat
 * face turns the spray root down and out. `fraction` places its INNER edge
 * along the panel, 0 at the keel to 1 at the chine (as a share of the chine
 * half-breadth); the flat runs `width` metres outboard from there, `downAngle`
 * degrees below the horizontal, and its outer edge steps back up to the panel.
 * It runs from `fromX` to `toX`, fading to nothing over `taper` metres at the
 * forward end, as a moulded strake does.
 */
export interface HullStrake {
  readonly fraction: number;
  readonly width: number;
  readonly downAngle: number;
  readonly fromX: number;
  readonly toX: number;
  readonly taper: number;
}

/** Inner to outer. The inner strake runs to the transom; the outer two stop short of it. */
export const HULL_STRAKES: readonly HullStrake[] = Object.freeze([
  { fraction: 0.26, width: 0.04, downAngle: 0, fromX: 0.0, toX: 6.0, taper: 0.6 },
  { fraction: 0.5, width: 0.045, downAngle: 0, fromX: 0.6, toX: 5.9, taper: 0.6 },
  { fraction: 0.74, width: 0.05, downAngle: 0, fromX: 1.6, toX: 5.7, taper: 0.6 },
] satisfies HullStrake[]);

/**
 * The reverse chine: a flat running outboard from the chine and angled DOWN
 * (`downAngle` degrees below the horizontal), so the spray leaving the bottom
 * is turned down for lift instead of up the topsides. Its outer edge is the
 * hard edge the flow separates from once the chine is wet; the physics takes
 * the chine beam there (`wettedChineHalfBeam`).
 */
export const HULL_REVERSE_CHINE = Object.freeze({
  width: 0.075,
  downAngle: 10,
  fromX: 0.0,
  toX: 6.2,
  taper: 0.5,
});

/**
 * Centre of gravity as driven (hull, a 250 kg V6 outboard on the transom,
 * fuel and two people at the helm), hull frame. 1,800 kg.
 */
export const RUNABOUT_21_CG: Readonly<Vec3> = Object.freeze({ x: 1.95, y: 0.56, z: 0 });

/**
 * Where the boat floats at rest in still sea water, 1,025 kg/m^3, as the sim's
 * hydrostatics solves it (`tests/sim.boat-hydrostatics.test.ts` holds these
 * to the solved equilibrium): the still-water height above the keel at the
 * transom and at the CG's station, and the keel's trim, positive bow up. For
 * the boot stripe and the render-against-physics draft test.
 */
export const RUNABOUT_21_REST_WATERLINE = Object.freeze({
  draftAtTransom: 0.418,
  draftAtCg: 0.398,
  trimDegrees: 0.6,
});

/**
 * The outboard's hanging points at zero trim, hull frame. Zero trim puts the
 * propeller shaft parallel to the keel; trim tilts everything below the
 * bracket about `tiltPivot` (about the hull's z axis: trimming OUT swings the
 * lower unit aft and up and points the thrust forward and down, which lifts
 * the bow), and steering then turns the leg about `steerAxis` (which tilts
 * with it). The bracket clamps to the transom at the 25 in (0.635 m) mount
 * height; the anti-ventilation plate sits level with the keel.
 */
export const RUNABOUT_21_OUTBOARD = Object.freeze({
  /** Top of the transom bracket, on the transom plane. */
  transomBracket: Object.freeze({ x: transomX(0.635), y: 0.635, z: 0 }),
  /** The power-trim tilt pivot. */
  tiltPivot: Object.freeze({ x: 0.02, y: 0.6, z: 0 }),
  /** A point on the steering (swivel) axis and its direction at zero trim. */
  steerAxisPoint: Object.freeze({ x: -0.18, y: 0.6, z: 0 }),
  steerAxisDirection: Object.freeze({ x: 0, y: 1, z: 0 }),
  /** Propeller hub centre and the propeller's diameter, 14.5 in. */
  propellerHub: Object.freeze({ x: -0.52, y: -0.2, z: 0 }),
  propellerDiameter: 0.368,
  /** Anti-ventilation plate: its height, and its fore and aft edges. */
  antiVentilationPlate: Object.freeze({ y: 0.0, forwardX: -0.33, aftX: -0.64 }),
  /** Centroid of the gearcase and skeg below the plate, which act as the steering fin. */
  gearcaseCentroid: Object.freeze({ x: -0.45, y: -0.2, z: 0 }),
  /** The skeg's lowest point. */
  skegBottom: Object.freeze({ x: -0.47, y: -0.43, z: 0 }),
  /** Centre of the powerhead (the cowling), for the drawn engine and its mass. */
  powerhead: Object.freeze({ x: -0.32, y: 1.05, z: 0 }),
  /** Engine tilt range, degrees: in (bow down) to out (bow up). */
  trimMinDegrees: -4,
  trimMaxDegrees: 16,
  /** Steering lock either way, degrees. */
  steerLockDegrees: 30,
});

/**
 * Mooring cleats, hull frame, on the deck edge. A line made fast at one of
 * these pulls the hull there; the marina's lines attach by index.
 */
export const RUNABOUT_21_CLEATS: readonly Readonly<Vec3>[] = Object.freeze([
  Object.freeze({ x: 6.1, y: 1.3, z: 0 }), // bow
  Object.freeze({ x: 3.3, y: 1.11, z: -1.24 }), // port spring
  Object.freeze({ x: 3.3, y: 1.11, z: 1.24 }), // starboard spring
  Object.freeze({ x: 0.35, y: 1.04, z: -1.1 }), // port stern
  Object.freeze({ x: 0.35, y: 1.04, z: 1.1 }), // starboard stern
]);

/** Hull frame to body frame (origin at the CG): same axes, shifted. */
export function hullToBody(point: Readonly<Vec3>, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = point.x - RUNABOUT_21_CG.x;
  out.y = point.y - RUNABOUT_21_CG.y;
  out.z = point.z - RUNABOUT_21_CG.z;
  return out;
}

/** The lines at one x, every field interpolated from `HULL_STATIONS`. */
export interface HullLinesSample {
  x: number;
  keel: number;
  /** Degrees. */
  deadrise: number;
  chineHalfBeam: number;
  chineHeight: number;
  sheerHalfBeam: number;
  sheerHeight: number;
}

export function createHullLinesSample(): HullLinesSample {
  return { x: 0, keel: 0, deadrise: 0, chineHalfBeam: 0, chineHeight: 0, sheerHalfBeam: 0, sheerHeight: 0 };
}

type StationField = "keel" | "deadrise" | "chineHalfBeam" | "sheerHalfBeam" | "sheerHeight";
const STATION_FIELDS: readonly StationField[] = ["keel", "deadrise", "chineHalfBeam", "sheerHalfBeam", "sheerHeight"];

/**
 * Fritsch-Carlson slopes per field: a monotone cubic Hermite, so the curves
 * are smooth (C1) but never overshoot between stations; a chine half-breadth
 * that falls to zero stays at zero rather than going negative.
 */
const STATION_SLOPES: Readonly<Record<StationField, Float64Array>> = (() => {
  const count = HULL_STATIONS.length;
  const slopes = {} as Record<StationField, Float64Array>;
  for (const field of STATION_FIELDS) {
    const secant = new Float64Array(count - 1);
    for (let i = 0; i < count - 1; i += 1) {
      const a = HULL_STATIONS[i]!;
      const b = HULL_STATIONS[i + 1]!;
      secant[i] = (b[field] - a[field]) / (b.x - a.x);
    }
    const tangent = new Float64Array(count);
    tangent[0] = secant[0]!;
    tangent[count - 1] = secant[count - 2]!;
    for (let i = 1; i < count - 1; i += 1) {
      const left = secant[i - 1]!;
      const right = secant[i]!;
      if (left * right <= 0) {
        tangent[i] = 0;
      } else {
        const hLeft = HULL_STATIONS[i]!.x - HULL_STATIONS[i - 1]!.x;
        const hRight = HULL_STATIONS[i + 1]!.x - HULL_STATIONS[i]!.x;
        const wLeft = 2 * hRight + hLeft;
        const wRight = hRight + 2 * hLeft;
        tangent[i] = (wLeft + wRight) / (wLeft / left + wRight / right);
      }
    }
    slopes[field] = tangent;
  }
  return slopes;
})();

function stationIndex(x: number): number {
  let low = 0;
  let high = HULL_STATIONS.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (HULL_STATIONS[middle]!.x <= x) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The lines at `x` (clamped to the hull), allocation-free with `out`.
 * Between stations every field is the monotone cubic through them.
 */
export function sampleHullLines(x: number, out: HullLinesSample = createHullLinesSample()): HullLinesSample {
  const clamped = Math.min(HULL_LENGTH, Math.max(0, Number.isFinite(x) ? x : 0));
  const index = stationIndex(clamped);
  const a = HULL_STATIONS[index]!;
  const b = HULL_STATIONS[index + 1]!;
  const h = b.x - a.x;
  const t = (clamped - a.x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out.x = clamped;
  for (const field of STATION_FIELDS) {
    const slopes = STATION_SLOPES[field];
    out[field] = h00 * a[field] + h10 * h * slopes[index]! + h01 * b[field] + h11 * h * slopes[index + 1]!;
  }
  out.chineHalfBeam = Math.max(0, out.chineHalfBeam);
  out.sheerHalfBeam = Math.max(0, out.sheerHalfBeam);
  out.chineHeight = chineHeight(out.keel, out.deadrise, out.chineHalfBeam);
  return out;
}

/** Height of the chine above the baseline: the straight bottom panel from the keel. */
export function chineHeight(keel: number, deadriseDegrees: number, chineHalfBeam: number): number {
  return keel + chineHalfBeam * Math.tan(deadriseDegrees * DEG);
}

/** How much of a feature (strake, reverse chine) is present at `x`: 0..1, tapering at its forward end. */
export function featureExtent(
  feature: { readonly fromX: number; readonly toX: number; readonly taper: number },
  x: number,
): number {
  if (x < feature.fromX || x > feature.toX) return 0;
  if (feature.taper <= 0) return 1;
  return Math.min(1, (feature.toX - x) / feature.taper);
}

/**
 * Half-breadth of the hard edge the bottom's flow leaves once the chine is
 * wet: the reverse chine's outer edge where it runs, the chine elsewhere.
 */
export function wettedChineHalfBeam(lines: Readonly<HullLinesSample>): number {
  const reverse = featureExtent(HULL_REVERSE_CHINE, lines.x);
  return lines.chineHalfBeam + (lines.chineHalfBeam > 0 ? reverse * HULL_REVERSE_CHINE.width : 0);
}

/** What a half-section point is, so each consumer can pick the ones it needs. */
export type HullSectionPointKind =
  | "keel"
  | "strakeInner"
  | "strakeOuter"
  | "strakeStep"
  | "chine"
  | "reverseChineOuter"
  | "sheer";

export interface HullSectionPoint {
  /** Half-breadth, metres (always >= 0; mirror it for port). */
  z: number;
  /** Height above the baseline, metres. */
  y: number;
  kind: HullSectionPointKind;
}

/**
 * One half-section at `x`, keel to sheer, appended to `out` (cleared first)
 * as (z, y) points with z >= 0: keel; for each strake present its inner
 * corner, its flat's outer corner and the step back up to the panel; the
 * chine; the reverse chine's outer edge; the sheer. Straight lines between
 * consecutive points ARE the section: the bottom panel is straight, the
 * strakes and reverse chine are flats, and the topsides run straight from the
 * reverse chine to the sheer. Points are reused from `pool` when given, so a
 * caller lofting every frame allocates nothing.
 */
export function hullHalfSection(
  x: number,
  out: HullSectionPoint[],
  pool: HullSectionPoint[] = [],
  lines: HullLinesSample = createHullLinesSample(),
): HullSectionPoint[] {
  sampleHullLines(x, lines);
  out.length = 0;
  let used = 0;
  const push = (z: number, y: number, kind: HullSectionPointKind): void => {
    let point = pool[used];
    if (!point) {
      point = { z: 0, y: 0, kind: "keel" };
      pool[used] = point;
    }
    used += 1;
    point.z = z;
    point.y = y;
    point.kind = kind;
    out.push(point);
  };
  const tanDeadrise = Math.tan(lines.deadrise * DEG);
  push(0, lines.keel, "keel");
  const chine = lines.chineHalfBeam;
  if (chine > 0) {
    for (const strake of HULL_STRAKES) {
      const extent = featureExtent(strake, lines.x);
      if (extent <= 0) continue;
      const width = strake.width * extent;
      const zInner = strake.fraction * chine;
      if (zInner + width >= chine) continue;
      const yInner = lines.keel + zInner * tanDeadrise;
      const zOuter = zInner + width;
      push(zInner, yInner, "strakeInner");
      push(zOuter, yInner - width * Math.tan(strake.downAngle * DEG), "strakeOuter");
      push(zOuter, lines.keel + zOuter * tanDeadrise, "strakeStep");
    }
    push(chine, lines.chineHeight, "chine");
    const reverse = featureExtent(HULL_REVERSE_CHINE, lines.x);
    if (reverse > 0) {
      const width = HULL_REVERSE_CHINE.width * reverse;
      push(chine + width, lines.chineHeight - width * Math.tan(HULL_REVERSE_CHINE.downAngle * DEG), "reverseChineOuter");
    }
  }
  push(lines.sheerHalfBeam, lines.sheerHeight, "sheer");
  return out;
}
