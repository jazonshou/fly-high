import { roadSuperelevation, type RoadClassSpec } from "./roadClasses";

/**
 * From a grid route to a road: the horizontal alignment (the grid's
 * stair-steps relaxed out, simplified, then tangent lines and circular curves
 * with the class's radius limits), the vertical profile (the ground smoothed,
 * then held to the class's grade between pinned heights and inside the band
 * its fill and cut limits leave), superelevation, and the straight pieces the
 * infrastructure stage takes.
 *
 * Every step is plain arithmetic over the route and the ground samples it is
 * handed, so an alignment is exactly as deterministic as its route.
 */

/**
 * Take the grid's stair-steps out of a route: resample it every `spacing`
 * metres, then average each point towards its neighbours `iterations` times,
 * never letting a point move more than `maxShift` from where it was
 * resampled. The ends stay put.
 */
export function relaxRoadPolyline(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  spacing: number,
  iterations: number,
  maxShift: number,
): { x: number[]; z: number[] } {
  const n = x.length;
  if (n <= 2) return { x: Array.from(x), z: Array.from(z) };
  const rx: number[] = [x[0]!];
  const rz: number[] = [z[0]!];
  let carry = 0;
  for (let k = 0; k + 1 < n; k += 1) {
    const ax = x[k]!;
    const az = z[k]!;
    const length = Math.hypot(x[k + 1]! - ax, z[k + 1]! - az);
    let at = spacing - carry;
    while (at < length) {
      const t = at / length;
      rx.push(ax + (x[k + 1]! - ax) * t);
      rz.push(az + (z[k + 1]! - az) * t);
      at += spacing;
    }
    carry = length - (at - spacing);
  }
  // The end exactly, replacing a resampled point too close to it.
  if (Math.hypot(rx[rx.length - 1]! - x[n - 1]!, rz[rz.length - 1]! - z[n - 1]!) < 0.5 * spacing && rx.length > 1) {
    rx.pop();
    rz.pop();
  }
  rx.push(x[n - 1]!);
  rz.push(z[n - 1]!);
  const m = rx.length;
  const ox = rx.slice();
  const oz = rz.slice();
  const nx = new Float64Array(m);
  const nz = new Float64Array(m);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    nx[0] = rx[0]!;
    nz[0] = rz[0]!;
    nx[m - 1] = rx[m - 1]!;
    nz[m - 1] = rz[m - 1]!;
    for (let k = 1; k + 1 < m; k += 1) {
      let px = 0.5 * rx[k]! + 0.25 * (rx[k - 1]! + rx[k + 1]!);
      let pz = 0.5 * rz[k]! + 0.25 * (rz[k - 1]! + rz[k + 1]!);
      const dx = px - ox[k]!;
      const dz = pz - oz[k]!;
      const shift = Math.hypot(dx, dz);
      if (shift > maxShift) {
        px = ox[k]! + (dx * maxShift) / shift;
        pz = oz[k]! + (dz * maxShift) / shift;
      }
      nx[k] = px;
      nz[k] = pz;
    }
    for (let k = 0; k < m; k += 1) {
      rx[k] = nx[k]!;
      rz[k] = nz[k]!;
    }
  }
  return { x: rx, z: rz };
}

/** Douglas-Peucker: the vertices that keep the polyline within `tolerance`; the ends always stay. */
export function simplifyRoadPolyline(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  tolerance: number,
): { x: number[]; z: number[] } {
  const n = x.length;
  if (n <= 2) return { x: Array.from(x), z: Array.from(z) };
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const ax = x[first]!;
    const az = z[first]!;
    const dx = x[last]! - ax;
    const dz = z[last]! - az;
    const length = Math.hypot(dx, dz);
    let worst = -1;
    let worstDistance = tolerance;
    for (let k = first + 1; k < last; k += 1) {
      const distance = length > 0
        ? Math.abs((x[k]! - ax) * dz - (z[k]! - az) * dx) / length
        : Math.hypot(x[k]! - ax, z[k]! - az);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const outX: number[] = [];
  const outZ: number[] = [];
  for (let k = 0; k < n; k += 1) {
    if (keep[k]) {
      outX.push(x[k]!);
      outZ.push(z[k]!);
    }
  }
  return { x: outX, z: outZ };
}

/** One circular curve at a polygon vertex. */
interface Fillet {
  /** Deflection, radians (0..pi). */
  delta: number;
  /** +1 turning left (counter-clockwise seen from above, +x east, +z north), -1 right. */
  turn: number;
  radius: number;
}

/** Curves this sharp may use the hairpin radius where the class's minimum will not fit. */
const HAIRPIN_DEFLECTION = (95 * Math.PI) / 180;
/** Vertices bending less than this are straightened out. */
const COLLINEAR_DEFLECTION = (0.5 * Math.PI) / 180;
/**
 * Where the legs leave no room for the class's minimum radius, a curve may
 * tighten to this times it (a hill road's tight bend) before the fit moves
 * the line off its route by merging or dropping vertices.
 */
const TIGHT_RADIUS_FACTOR = 0.5;
/** The tightest curve any road of the class takes, metres. */
export function roadTightestRadius(spec: RoadClassSpec): number {
  return Math.min(spec.hairpinRadius, spec.minRadius * TIGHT_RADIUS_FACTOR);
}

/** The radius a curve is given where there is room: this times the class minimum. */
const PREFERRED_RADIUS_FACTOR = 2.5;

function legLength(x: readonly number[], z: readonly number[], k: number): number {
  return Math.hypot(x[k + 1]! - x[k]!, z[k + 1]! - z[k]!);
}

function deflection(x: readonly number[], z: readonly number[], k: number): { delta: number; turn: number } {
  const ix = x[k]! - x[k - 1]!;
  const iz = z[k]! - z[k - 1]!;
  const ox = x[k + 1]! - x[k]!;
  const oz = z[k + 1]! - z[k]!;
  const cross = ix * oz - iz * ox;
  const dot = ix * ox + iz * oz;
  return { delta: Math.abs(Math.atan2(cross, dot)), turn: cross >= 0 ? 1 : -1 };
}

/** Where two lines (p + t d, q + s e) meet, or null for parallel lines. */
function lineIntersection(
  px: number, pz: number, dx: number, dz: number,
  qx: number, qz: number, ex: number, ez: number,
): { t: number; s: number } | null {
  const denominator = dx * ez - dz * ex;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((qx - px) * ez - (qz - pz) * ex) / denominator;
  const s = ((qx - px) * dz - (qz - pz) * dx) / denominator;
  return { t, s };
}

export interface RoadCurveFit {
  /** Polygon vertices after the fit (ends included). */
  readonly x: readonly number[];
  readonly z: readonly number[];
  /** Per interior vertex (index k - 1 for vertex k): its curve. */
  readonly fillets: readonly Fillet[];
}

/**
 * Fit tangent-and-curve geometry to a polygon: every interior vertex becomes
 * a circular curve as large as the legs allow up to a preferred radius, and
 * no tighter than `TIGHT_RADIUS_FACTOR` of the class's minimum (or, for a
 * sharp switchback, its hairpin radius). Where the legs are too short for that, the worst vertex
 * is merged with its neighbour (two curves the same way become one) or
 * dropped, and the fit runs again. `startStraight` and `endStraight` keep a
 * run of the first and last legs straight (the airport road's lead-out).
 */
export function fitRoadCurves(
  inputX: readonly number[],
  inputZ: readonly number[],
  spec: RoadClassSpec,
  startStraight = 0,
  endStraight = 0,
): RoadCurveFit {
  const floorRadius = spec.minRadius * TIGHT_RADIUS_FACTOR;
  const x = inputX.slice();
  const z = inputZ.slice();
  for (let iteration = 0; iteration < 4 * x.length + 8; iteration += 1) {
    // Straighten collinear vertices first.
    let removed = false;
    for (let k = 1; k + 1 < x.length; k += 1) {
      if (deflection(x, z, k).delta < COLLINEAR_DEFLECTION || legLength(x, z, k - 1) < 1e-6) {
        x.splice(k, 1);
        z.splice(k, 1);
        removed = true;
        break;
      }
    }
    if (removed) continue;
    const m = x.length;
    if (m <= 2) return { x, z, fillets: [] };
    const fillets: Fillet[] = [];
    const tangent: number[] = [];
    for (let k = 1; k + 1 < m; k += 1) {
      const { delta, turn } = deflection(x, z, k);
      const radius = spec.minRadius * PREFERRED_RADIUS_FACTOR;
      fillets.push({ delta, turn, radius });
      tangent.push(radius * Math.tan(delta / 2));
    }
    // Share each leg between the curves at its two ends.
    const factor = fillets.map(() => 1);
    for (let leg = 0; leg + 1 < m; leg += 1) {
      let available = legLength(x, z, leg);
      if (leg === 0) available -= startStraight;
      if (leg === m - 2) available -= endStraight;
      const left = leg - 1; // the curve at the leg's start vertex (leg), as a fillet index
      const right = leg; // the curve at the leg's end vertex (leg + 1)
      const need = (left >= 0 ? tangent[left]! : 0) + (right < fillets.length ? tangent[right]! : 0);
      if (need <= 0) continue;
      const f = Math.max(0, available) / need;
      if (f < 1) {
        if (left >= 0) factor[left] = Math.min(factor[left]!, f);
        if (right < fillets.length) factor[right] = Math.min(factor[right]!, f);
      }
    }
    let worst = -1;
    let worstRatio = 1;
    for (let k = 0; k < fillets.length; k += 1) {
      const fillet = fillets[k]!;
      fillet.radius *= factor[k]!;
      const limit = fillet.delta >= HAIRPIN_DEFLECTION ? Math.min(spec.hairpinRadius, floorRadius) : floorRadius;
      const ratio = fillet.radius / limit;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worst = k;
      }
    }
    if (worst < 0) return { x, z, fillets };
    // Fix the worst vertex: merge it with the neighbour across its shorter
    // leg when both turn the same way, else drop it.
    const v = worst + 1;
    const before = legLength(x, z, v - 1);
    const after = legLength(x, z, v);
    const w = before <= after ? v - 1 : v + 1;
    let merged = false;
    if (w >= 1 && w <= m - 2 && fillets[w - 1]!.turn === fillets[v - 1]!.turn) {
      const firstV = Math.min(v, w);
      const secondV = Math.max(v, w);
      const hit = lineIntersection(
        x[firstV - 1]!, z[firstV - 1]!, x[firstV]! - x[firstV - 1]!, z[firstV]! - z[firstV - 1]!,
        x[secondV + 1]!, z[secondV + 1]!, x[secondV]! - x[secondV + 1]!, z[secondV]! - z[secondV + 1]!,
      );
      if (hit && hit.t > 0 && hit.s > 0 && hit.t < 4 && hit.s < 4) {
        const px = x[firstV - 1]! + (x[firstV]! - x[firstV - 1]!) * hit.t;
        const pz = z[firstV - 1]! + (z[firstV]! - z[firstV - 1]!) * hit.t;
        x.splice(firstV, 2, px);
        z.splice(firstV, 2, pz);
        merged = true;
      }
    }
    if (!merged) {
      x.splice(v, 1);
      z.splice(v, 1);
    }
  }
  // Did not converge (never seen): a straight line between the ends.
  return { x: [x[0]!, x[x.length - 1]!], z: [z[0]!, z[z.length - 1]!], fillets: [] };
}

/** The alignment sampled densely: positions, stations and signed curvature (+ left). */
export interface RoadSamples {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly station: Float64Array;
  readonly curvature: Float64Array;
  readonly length: number;
}

/** Chord of a curve whose sagitta is `sagitta`: 2 sqrt(2 R s - s^2). */
function chordForSagitta(radius: number, sagitta: number): number {
  return 2 * Math.sqrt(Math.max(0, 2 * radius * sagitta - sagitta * sagitta));
}

/** Arc sampling keeps the chord within this of the curve, metres. */
const ARC_SAGITTA = 0.04;

/**
 * Sample a fitted alignment at most `step` metres apart (closer on curves,
 * so each chord stays within `ARC_SAGITTA` of the arc).
 */
export function sampleRoadAlignment(fit: RoadCurveFit, step: number): RoadSamples {
  const xs: number[] = [];
  const zs: number[] = [];
  const ks: number[] = [];
  const m = fit.x.length;
  const push = (px: number, pz: number, curvature: number) => {
    const n = xs.length;
    if (n > 0 && Math.hypot(px - xs[n - 1]!, pz - zs[n - 1]!) < 1e-6) {
      // A shared tangent point: keep the curve's curvature there.
      if (curvature !== 0) ks[n - 1] = curvature;
      return;
    }
    xs.push(px);
    zs.push(pz);
    ks.push(curvature);
  };
  const line = (ax: number, az: number, bx: number, bz: number) => {
    const length = Math.hypot(bx - ax, bz - az);
    const count = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k <= count; k += 1) {
      const t = k / count;
      push(ax + (bx - ax) * t, az + (bz - az) * t, 0);
    }
  };
  let cursorX = fit.x[0]!;
  let cursorZ = fit.z[0]!;
  for (let v = 1; v + 1 < m; v += 1) {
    const fillet = fit.fillets[v - 1]!;
    const vx = fit.x[v]!;
    const vz = fit.z[v]!;
    const inLength = Math.hypot(vx - fit.x[v - 1]!, vz - fit.z[v - 1]!);
    const outLength = Math.hypot(fit.x[v + 1]! - vx, fit.z[v + 1]! - vz);
    const ix = (vx - fit.x[v - 1]!) / inLength;
    const iz = (vz - fit.z[v - 1]!) / inLength;
    const ox = (fit.x[v + 1]! - vx) / outLength;
    const oz = (fit.z[v + 1]! - vz) / outLength;
    const tangent = fillet.radius * Math.tan(fillet.delta / 2);
    const startX = vx - ix * tangent;
    const startZ = vz - iz * tangent;
    line(cursorX, cursorZ, startX, startZ);
    // Centre: the left normal of the incoming direction (-iz, ix), on the turn's side.
    const cx = startX + -iz * fillet.radius * fillet.turn;
    const cz = startZ + ix * fillet.radius * fillet.turn;
    const arcLength = fillet.radius * fillet.delta;
    const chord = Math.max(0.5, Math.min(step, chordForSagitta(fillet.radius, ARC_SAGITTA)));
    const count = Math.max(1, Math.ceil(arcLength / chord));
    const rx = startX - cx;
    const rz = startZ - cz;
    const curvature = fillet.turn / fillet.radius;
    for (let k = 0; k <= count; k += 1) {
      // Counter-clockwise (+turn) rotation by turn * delta * t.
      const angle = fillet.turn * fillet.delta * (k / count);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      push(cx + rx * c - rz * s, cz + rx * s + rz * c, curvature);
    }
    cursorX = vx + ox * tangent;
    cursorZ = vz + oz * tangent;
  }
  line(cursorX, cursorZ, fit.x[m - 1]!, fit.z[m - 1]!);
  const n = xs.length;
  const station = new Float64Array(n);
  for (let k = 1; k < n; k += 1) station[k] = station[k - 1]! + Math.hypot(xs[k]! - xs[k - 1]!, zs[k]! - zs[k - 1]!);
  return {
    x: Float64Array.from(xs),
    z: Float64Array.from(zs),
    station,
    curvature: Float64Array.from(ks),
    length: station[n - 1]!,
  };
}

/** Moving average of `values` over a window of `window` metres of station, trapezoidal. */
export function smoothAlongStation(values: ArrayLike<number>, station: ArrayLike<number>, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (!(window > 0) || n === 1) {
    for (let k = 0; k < n; k += 1) out[k] = values[k]!;
    return out;
  }
  // Prefix integral of the piecewise-linear signal.
  const integral = new Float64Array(n);
  for (let k = 1; k < n; k += 1) {
    integral[k] = integral[k - 1]! + 0.5 * (values[k]! + values[k - 1]!) * (station[k]! - station[k - 1]!);
  }
  const at = (s: number): number => {
    // Integral from station[0] to s, s clamped to the samples.
    if (s <= station[0]!) return 0;
    if (s >= station[n - 1]!) return integral[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (station[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const span = station[hi]! - station[lo]!;
    const t = span > 0 ? (s - station[lo]!) / span : 0;
    const value = values[lo]! + (values[hi]! - values[lo]!) * t;
    return integral[lo]! + 0.5 * (values[lo]! + value) * (s - station[lo]!);
  };
  const first = station[0]!;
  const last = station[n - 1]!;
  for (let k = 0; k < n; k += 1) {
    const half = Math.min(window * 0.5, station[k]! - first, last - station[k]!);
    if (half <= 1e-9) {
      out[k] = values[k]!;
      continue;
    }
    out[k] = (at(station[k]! + half) - at(station[k]! - half)) / (2 * half);
  }
  return out;
}

export interface RoadPin {
  readonly station: number;
  readonly height: number;
}

export interface RoadProfileRequest {
  /** Ground before every earthwork at each sample, world Y. */
  readonly ground: ArrayLike<number>;
  readonly station: ArrayLike<number>;
  /** Heights the profile must pass through: both ends, and every road it crosses that outranks it. */
  readonly pins: readonly RoadPin[];
  /** Grade limit between samples k and k + 1, rise over run. */
  readonly grades: ArrayLike<number>;
  /** Steepest a step may be raised to where the cut and fill limits leave no gentler line. */
  readonly pitchGrade: number;
  /** Ground smoothing window, metres. */
  readonly smoothingMeters: number;
  /** Deepest fill (design above ground) and cut (ground above design) allowed, metres. */
  readonly maxFill: number;
  readonly maxCut: number;
}

export interface RoadProfileResult {
  readonly height: Float64Array;
  /** Deepest fill (design above ground) and cut (ground above design), metres. */
  readonly maxFill: number;
  readonly maxCut: number;
  /** Steepest step of the profile, rise over run. */
  readonly maxGrade: number;
  /** True when some step's grade limit had to be raised (pins too far apart, or the band too steep). */
  readonly gradeRelaxed: boolean;
  /** False when no profile at `pitchGrade` keeps within the fill and cut limits. */
  readonly feasible: boolean;
  /** Samples where it fails (empty when feasible): where a retry should route elsewhere. */
  readonly infeasible: readonly number[];
}

/** Window either side of a failing sample whose grade limit a relaxation round raises, metres. */
const PITCH_WINDOW_METERS = 250;
const PITCH_STEP = 1.25;
const PITCH_ROUNDS = 12;

/**
 * The tightest heights between `lo` and `hi` that steps of at most
 * `grade[k] * (station[k + 1] - station[k])` allow: `upper` (no higher than
 * any hi_j plus the climb from j) and `lower`. Both are exact after one
 * forward and one backward pass.
 */
function bandEnvelopes(
  lo: Float64Array,
  hi: Float64Array,
  station: ArrayLike<number>,
  grade: Float64Array,
  upper: Float64Array,
  lower: Float64Array,
): void {
  const n = lo.length;
  upper.set(hi);
  lower.set(lo);
  for (let k = 0; k + 1 < n; k += 1) {
    const step = grade[k]! * (station[k + 1]! - station[k]!);
    upper[k + 1] = Math.min(upper[k + 1]!, upper[k]! + step);
    lower[k + 1] = Math.max(lower[k + 1]!, lower[k]! - step);
  }
  for (let k = n - 1; k > 0; k -= 1) {
    const step = grade[k - 1]! * (station[k]! - station[k - 1]!);
    upper[k - 1] = Math.min(upper[k - 1]!, upper[k]! + step);
    lower[k - 1] = Math.max(lower[k - 1]!, lower[k]! - step);
  }
}

/** Tolerance on the band's feasibility, metres. */
const BAND_EPSILON = 1e-6;

/**
 * The vertical profile: the ground smoothed over the class's window, held
 * inside the band the fill and cut limits leave round the ground, through
 * the pins (both ends, and any crossing), with no step steeper than its grade.
 *
 * The band and the grades make two envelopes, the highest and lowest heights
 * any admissible profile can take at each sample; the profile is the smoothed
 * ground clamped between them, then passed forward and back so no step
 * exceeds its grade (which keeps it between the envelopes, both being
 * admissible themselves). Where the envelopes cross no admissible profile
 * exists: the grade limit is raised by `PITCH_STEP` within
 * `PITCH_WINDOW_METERS` of each crossing, up to `pitchGrade`, and tried
 * again. Pins too far apart in height for the grade between them raise that
 * span's grade first. A profile that still cannot fit is reported, with the
 * failing samples, for the router to try another line.
 */
export function roadVerticalProfile(request: RoadProfileRequest): RoadProfileResult {
  const { ground, station, pins, pitchGrade, maxFill, maxCut } = request;
  const n = ground.length;
  const smooth = smoothAlongStation(ground, station, request.smoothingMeters);
  const grade = Float64Array.from(request.grades);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    lo[k] = ground[k]! - maxCut;
    hi[k] = ground[k]! + maxFill;
  }
  const sorted = [...pins].sort((left, right) => left.station - right.station);
  // Pin each to its nearest sample; a later pin on the same sample wins.
  const pinIndex: number[] = [];
  const pinHeight: number[] = [];
  for (const pin of sorted) {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k += 1) {
      const distance = Math.abs(station[k]! - pin.station);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    if (pinIndex.length > 0 && pinIndex[pinIndex.length - 1] === best) {
      pinHeight[pinHeight.length - 1] = pin.height;
      continue;
    }
    pinIndex.push(best);
    pinHeight.push(pin.height);
  }
  for (let p = 0; p < pinIndex.length; p += 1) {
    lo[pinIndex[p]!] = pinHeight[p]!;
    hi[pinIndex[p]!] = pinHeight[p]!;
  }
  let gradeRelaxed = false;
  for (let p = 0; p + 1 < pinIndex.length; p += 1) {
    const i0 = pinIndex[p]!;
    const i1 = pinIndex[p + 1]!;
    // Feasible? The span's total allowed rise against the pins' difference.
    let allowed = 0;
    for (let k = i0; k < i1; k += 1) allowed += grade[k]! * (station[k + 1]! - station[k]!);
    const needed = Math.abs(pinHeight[p + 1]! - pinHeight[p]!);
    if (needed > allowed && allowed > 0) {
      const scale = (needed / allowed) * 1.000_001;
      for (let k = i0; k < i1; k += 1) grade[k] = grade[k]! * scale;
      gradeRelaxed = true;
    }
  }
  const upper = new Float64Array(n);
  const lower = new Float64Array(n);
  let infeasible: number[] = [];
  for (let round = 0; ; round += 1) {
    bandEnvelopes(lo, hi, station, grade, upper, lower);
    infeasible = [];
    for (let k = 0; k < n; k += 1) {
      if (lower[k]! > upper[k]! + BAND_EPSILON) infeasible.push(k);
    }
    if (infeasible.length === 0 || round === PITCH_ROUNDS) break;
    // Raise the grade limit round each failing sample.
    let raised = false;
    let cursor = 0;
    for (const k of infeasible) {
      const from = station[k]! - PITCH_WINDOW_METERS;
      const to = station[k]! + PITCH_WINDOW_METERS;
      while (cursor > 0 && station[cursor]! > from) cursor -= 1;
      while (cursor + 1 < n && station[cursor + 1]! <= from) cursor += 1;
      for (let m = cursor; m + 1 < n && station[m]! < to; m += 1) {
        const next = Math.min(pitchGrade, grade[m]! * PITCH_STEP);
        if (next > grade[m]!) {
          grade[m] = next;
          raised = true;
        }
      }
    }
    if (!raised) break;
    gradeRelaxed = true;
  }
  const feasible = infeasible.length === 0;
  const height = new Float64Array(n);
  for (let k = 0; k < n; k += 1) height[k] = Math.min(upper[k]!, Math.max(lower[k]!, smooth[k]!));
  for (let k = 0; k + 1 < n; k += 1) {
    const step = grade[k]! * (station[k + 1]! - station[k]!);
    height[k + 1] = Math.min(height[k]! + step, Math.max(height[k]! - step, height[k + 1]!));
  }
  for (let k = n - 1; k > 0; k -= 1) {
    const step = grade[k - 1]! * (station[k]! - station[k - 1]!);
    height[k - 1] = Math.min(height[k]! + step, Math.max(height[k]! - step, height[k - 1]!));
  }
  // Pins are exact (they are their own band; this only drops rounding).
  for (let p = 0; p < pinIndex.length; p += 1) height[pinIndex[p]!] = pinHeight[p]!;
  let deepestFill = 0;
  let deepestCut = 0;
  let steepest = 0;
  for (let k = 0; k < n; k += 1) {
    const fill = height[k]! - ground[k]!;
    deepestFill = Math.max(deepestFill, fill);
    deepestCut = Math.max(deepestCut, -fill);
    if (k + 1 < n) {
      const run = station[k + 1]! - station[k]!;
      if (run > 0) steepest = Math.max(steepest, Math.abs(height[k + 1]! - height[k]!) / run);
    }
  }
  return {
    height,
    maxFill: deepestFill,
    maxCut: deepestCut,
    maxGrade: steepest,
    gradeRelaxed,
    feasible,
    infeasible,
  };
}

/**
 * Superelevation along the alignment, signed as the stage's cross slope
 * (rise per metre to the right of the direction of travel): a left curve
 * banks up on the right. Run in and out over `runoff` metres.
 */
export function roadSuperelevationAlong(
  spec: RoadClassSpec,
  curvature: ArrayLike<number>,
  station: ArrayLike<number>,
  runoff: number,
): Float64Array {
  const n = curvature.length;
  const raw = new Float64Array(n);
  if (spec.superelevationMax <= 0) return raw;
  for (let k = 0; k < n; k += 1) {
    const kappa = curvature[k]!;
    if (kappa === 0) continue;
    raw[k] = Math.sign(kappa) * roadSuperelevation(spec, 1 / Math.abs(kappa));
  }
  return smoothAlongStation(raw, station, runoff);
}

/** One straight piece of a road, as the stage takes it. */
export interface RoadPieceGeometry {
  readonly first: number;
  readonly last: number;
}

/** How far a straight piece may stray from the samples it replaces. */
export interface RoadPieceTolerance {
  /** Off the chord in plan, metres. */
  readonly horizontal: number;
  /** Off the linear height between its ends, metres. */
  readonly vertical: number;
  /** Off the linear cross slope, rise per metre. */
  readonly cross: number;
}

/**
 * Split the samples into straight pieces: each as long as it can be (at most
 * `maxLength`) while every sample it spans stays within `tolerance` of the
 * chord in plan, of the linear height between its ends and of the linear
 * cross slope.
 */
export function roadPieces(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  station: ArrayLike<number>,
  height: ArrayLike<number>,
  cross: ArrayLike<number>,
  maxLength: number,
  tolerance: RoadPieceTolerance,
): RoadPieceGeometry[] {
  const n = x.length;
  const pieces: RoadPieceGeometry[] = [];
  const fits = (a: number, b: number): boolean => {
    const ax = x[a]!;
    const az = z[a]!;
    const dx = x[b]! - ax;
    const dz = z[b]! - az;
    const length = Math.hypot(dx, dz);
    const span = station[b]! - station[a]!;
    for (let c = a + 1; c < b; c += 1) {
      const off = length > 0 ? Math.abs((x[c]! - ax) * dz - (z[c]! - az) * dx) / length : 0;
      if (off > tolerance.horizontal) return false;
      const t = span > 0 ? (station[c]! - station[a]!) / span : 0;
      if (Math.abs(height[c]! - (height[a]! + (height[b]! - height[a]!) * t)) > tolerance.vertical) return false;
      if (Math.abs(cross[c]! - (cross[a]! + (cross[b]! - cross[a]!) * t)) > tolerance.cross) return false;
    }
    return true;
  };
  let first = 0;
  while (first < n - 1) {
    let last = first + 1;
    while (last + 1 < n && station[last + 1]! - station[first]! <= maxLength && fits(first, last + 1)) last += 1;
    pieces.push({ first, last });
    first = last;
  }
  return pieces;
}
