/**
 * Profile curves for lofting from a reference: a C1 interpolant that cannot
 * invent a bump the data does not have, and a least-squares fit that makes a
 * noisy traced outline keep the shape the aeroplane has.
 *
 * WHY NOT A CUBIC SPLINE. A crown traced off a drawing climbs, runs level and
 * falls away; a natural or Catmull-Rom cubic through those points overshoots
 * at both ends of the level run, and an overshoot on a crown is a hump and a
 * dip -- exactly the S the 747's hand-ringed nose has
 * (docs/findings/AIRLINER_NOSE_GLAZING.md). The interpolant here is
 * Schumaker's shape-preserving quadratic spline: tangent-continuous, and
 * monotone and convex (or concave) wherever the data are.
 *
 * WHY A FIT AS WELL. A traced outline is noisy at the pixel, and noise is not
 * convex: interpolating it faithfully reproduces every wobble. `fitShapedCurve`
 * is the least-squares curve through the points among those that are C1 and
 * monotone and/or convex BY CONSTRUCTION -- the integral of a slope that is
 * piecewise linear on knots and itself monotone -- which is what the traced
 * edge would be without its noise.
 *
 * WHY NOT FIT POINTS AND INTERPOLATE THEM. The least-squares projection of the
 * points on to concave ones is a polyline with corners at data points, and no
 * C1 curve through a corner between two straight runs stays concave: fed one,
 * the spline above bent a fitted crown back up by 0.1 degree at two rings.
 */

export interface ProfilePoint {
  readonly x: number;
  readonly y: number;
}

export interface ShapePreservingSpline {
  /** The data's own abscissae, strictly increasing. */
  readonly knots: readonly number[];
  value(x: number): number;
  slope(x: number): number;
}

interface Piece {
  readonly x0: number;
  readonly y0: number;
  readonly s0: number;
  /** Half the second derivative on the piece. */
  readonly c: number;
}

/**
 * Schumaker's shape-preserving quadratic spline through `points` (strictly
 * increasing x), after K. Judd's statement of it (Numerical Methods in
 * Economics, 6.11).
 *
 * Slopes at the data are the length-weighted mean of the two secants where
 * they agree in sign and zero where they do not, so every slope lies between
 * its neighbouring secants -- the condition under which the quadratic pieces
 * keep the data's monotonicity and convexity. Each interval is one quadratic,
 * or two with a knot between, chosen so the slopes at both ends are met.
 * Beyond the ends the curve continues along its end tangents.
 *
 * `startSlope` and `endSlope` override the end estimates, for a curve that
 * must leave a join level or arrive at one along a known tangent.
 *
 * STRICTLY shaped data only: where three points are collinear beside a bend,
 * no C1 quadratic both interpolates and keeps the shape, and this keeps the
 * interpolation. Fit noisy or piecewise-straight data with `fitShapedCurve`.
 */
export function shapePreservingSpline(
  points: readonly ProfilePoint[],
  ends: { readonly startSlope?: number | undefined; readonly endSlope?: number | undefined } = {},
): ShapePreservingSpline {
  if (points.length < 2) throw new RangeError("A profile curve needs at least two points");
  for (let i = 1; i < points.length; i += 1) {
    if (!(points[i]!.x > points[i - 1]!.x)) throw new RangeError("Profile points must be strictly increasing in x");
  }
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError("Profile points must be finite");
  }
  const n = points.length;
  const secant: number[] = [];
  const chord: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    secant.push(dy / dx);
    chord.push(Math.hypot(dx, dy));
  }
  const slopes = new Array<number>(n);
  for (let i = 1; i < n - 1; i += 1) {
    const before = secant[i - 1]!;
    const after = secant[i]!;
    slopes[i] = before * after > 0
      ? (chord[i - 1]! * before + chord[i]! * after) / (chord[i - 1]! + chord[i]!)
      : 0;
  }
  if (n === 2) {
    slopes[0] = ends.startSlope ?? secant[0]!;
    slopes[1] = ends.endSlope ?? secant[0]!;
  } else {
    slopes[0] = ends.startSlope ?? (3 * secant[0]! - slopes[1]!) / 2;
    slopes[n - 1] = ends.endSlope ?? (3 * secant[n - 2]! - slopes[n - 2]!) / 2;
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const { x: x0, y: y0 } = points[i]!;
    const { x: x1, y: y1 } = points[i + 1]!;
    const s0 = slopes[i]!;
    const s1 = slopes[i + 1]!;
    const h = x1 - x0;
    const delta = secant[i]!;
    if (Math.abs((s0 + s1) / 2 - delta) <= 1e-12 * Math.max(1, Math.abs(delta))) {
      pieces.push({ x0, y0, s0, c: (s1 - s0) / (2 * h) });
      continue;
    }
    let knot: number;
    if ((s0 - delta) * (s1 - delta) >= 0) knot = (x0 + x1) / 2;
    else if (Math.abs(s1 - delta) < Math.abs(s0 - delta)) knot = x0 + (h * (s1 - delta)) / (s1 - s0);
    else knot = x1 + (h * (s0 - delta)) / (s1 - s0);
    const alpha = knot - x0;
    const beta = x1 - knot;
    const middle = (2 * (y1 - y0) - (alpha * s0 + beta * s1)) / h;
    pieces.push({ x0, y0, s0, c: (middle - s0) / (2 * alpha) });
    pieces.push({
      x0: knot,
      y0: y0 + s0 * alpha + ((middle - s0) * alpha) / 2,
      s0: middle,
      c: (s1 - middle) / (2 * beta),
    });
  }

  const pieceAt = (x: number): Piece => {
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (pieces[mid]!.x0 <= x) low = mid;
      else high = mid - 1;
    }
    return pieces[low]!;
  };
  const first = points[0]!;
  const last = points[n - 1]!;
  return {
    knots: points.map((point) => point.x),
    value(x: number): number {
      if (x <= first.x) return first.y + slopes[0]! * (x - first.x);
      if (x >= last.x) return last.y + slopes[n - 1]! * (x - last.x);
      const piece = pieceAt(x);
      const t = x - piece.x0;
      return piece.y0 + piece.s0 * t + piece.c * t * t;
    },
    slope(x: number): number {
      if (x <= first.x) return slopes[0]!;
      if (x >= last.x) return slopes[n - 1]!;
      const piece = pieceAt(x);
      return piece.s0 + 2 * piece.c * (x - piece.x0);
    },
  };
}

export interface ProfileShape {
  /** The curve rises (or falls) with x. */
  readonly monotone?: "increasing" | "decreasing";
  /** Convex: the slope never decreases with x (a keel sweeping up). Concave: never increases (a crown). */
  readonly curvature?: "convex" | "concave";
}

export interface SlopeKnotCurve extends ShapePreservingSpline {
  readonly origin: ProfilePoint;
  /** The slope at each knot; linear between them, constant beyond the last. */
  readonly slopeKnots: readonly ProfilePoint[];
}

/**
 * The curve through `origin` whose SLOPE is piecewise linear on `slopeKnots`
 * (the first knot at the origin): a C1 chain of quadratics. Its shape is its
 * slope's: monotone knots make it convex or concave everywhere, exactly, and
 * knots of one sign make it monotone.
 */
export function slopeKnotCurve(origin: ProfilePoint, slopeKnots: readonly ProfilePoint[]): SlopeKnotCurve {
  if (slopeKnots.length < 1 || slopeKnots[0]!.x !== origin.x) {
    throw new RangeError("A slope-knot curve's first knot must be at its origin");
  }
  for (let i = 1; i < slopeKnots.length; i += 1) {
    if (!(slopeKnots[i]!.x > slopeKnots[i - 1]!.x)) throw new RangeError("Slope knots must be strictly increasing in x");
  }
  // The height at each knot, integrated once.
  const heights = [origin.y];
  for (let i = 1; i < slopeKnots.length; i += 1) {
    const a = slopeKnots[i - 1]!; const b = slopeKnots[i]!;
    heights.push(heights[i - 1]! + ((b.x - a.x) * (a.y + b.y)) / 2);
  }
  const last = slopeKnots.length - 1;
  const locate = (x: number) => {
    let low = 0; let high = last;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (slopeKnots[mid]!.x <= x) low = mid; else high = mid - 1;
    }
    return low;
  };
  return {
    origin,
    slopeKnots,
    knots: slopeKnots.map((knot) => knot.x),
    value(x: number): number {
      if (x <= origin.x) return origin.y + slopeKnots[0]!.y * (x - origin.x);
      const i = locate(x);
      const a = slopeKnots[i]!; const d = x - a.x;
      if (i === last) return heights[i]! + a.y * d;
      const b = slopeKnots[i + 1]!;
      return heights[i]! + a.y * d + ((b.y - a.y) * d * d) / (2 * (b.x - a.x));
    },
    slope(x: number): number {
      if (x <= origin.x) return slopeKnots[0]!.y;
      const i = locate(x);
      if (i === last) return slopeKnots[i]!.y;
      const a = slopeKnots[i]!; const b = slopeKnots[i + 1]!;
      return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
    },
  };
}

/** Pool-adjacent-violators: the Euclidean projection of `values` on to the non-decreasing sequences. */
function isotonic(values: readonly number[]): number[] {
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const top = blocks[blocks.length - 1]!; const below = blocks[blocks.length - 2]!;
      if (below.sum / below.count <= top.sum / top.count) break;
      below.sum += top.sum; below.count += top.count; blocks.pop();
    }
  }
  return blocks.flatMap((block) => Array<number>(block.count).fill(block.sum / block.count));
}

export interface ShapedCurveSpec {
  /** The point the curve must leave from, exactly. */
  readonly origin: ProfilePoint;
  /** The slope it must leave along, exactly (e.g. 0 off a level join); free when absent. */
  readonly originSlope?: number;
  /** The last slope knot; the curve runs straight beyond it. */
  readonly to: number;
  /** Knot spacing, metres: the finest bend the fit can make. */
  readonly knotSpacing: number;
  readonly shape: ProfileShape;
}

/**
 * The least-squares `slopeKnotCurve` through `points` with the requested
 * shape, leaving `origin` exactly.
 *
 * The heights are linear in the slope knots and every shape constraint is a
 * bound or an order on them, so this is a small convex problem: accelerated
 * projected gradient (FISTA), projecting by pool-adjacent-violators and then
 * clipping to the bounds -- the exact projection on to an ordered set with
 * bounds of the same order. It converges to the optimum; nothing here is
 * tuned to the data.
 */
export function fitShapedCurve(points: readonly ProfilePoint[], spec: ShapedCurveSpec): SlopeKnotCurve {
  const { origin } = spec;
  if (!(spec.knotSpacing > 0) || !(spec.to > origin.x)) throw new RangeError("A shaped fit needs a positive span and knot spacing");
  const count = Math.max(1, Math.round((spec.to - origin.x) / spec.knotSpacing));
  const knots = Array.from({ length: count + 1 }, (_, i) => origin.x + ((spec.to - origin.x) * i) / count);
  const used = points.filter((point) => point.x > origin.x);
  if (used.length === 0) throw new RangeError("A shaped fit needs points ahead of its origin");
  // Design: the height above the origin at each point, per unit of each knot's slope.
  const design = used.map((point) => knots.map((_, k) => {
    const unit = knots.map((__, j) => ({ x: knots[j]!, y: j === k ? 1 : 0 }));
    return slopeKnotCurve({ x: origin.x, y: 0 }, unit).value(point.x);
  }));
  const target = used.map((point) => point.y - origin.y);
  const pinned = spec.originSlope !== undefined;
  const slopes = knots.map(() => spec.originSlope ?? 0);
  // Bounds and order from the shape; the pinned first slope bounds the rest in the order's direction.
  const increasingOrder = spec.shape.curvature === "convex";
  const decreasingOrder = spec.shape.curvature === "concave";
  const project = (values: number[]): number[] => {
    let out = values.slice();
    if (increasingOrder) out = isotonic(out);
    if (decreasingOrder) out = isotonic(out.map((v) => -v)).map((v) => -v);
    let lower = spec.shape.monotone === "increasing" ? 0 : -Infinity;
    let upper = spec.shape.monotone === "decreasing" ? 0 : Infinity;
    if (pinned && increasingOrder) lower = Math.max(lower, spec.originSlope!);
    if (pinned && decreasingOrder) upper = Math.min(upper, spec.originSlope!);
    out = out.map((v) => Math.min(upper, Math.max(lower, v)));
    if (pinned) out[0] = spec.originSlope!;
    return out;
  };
  const residual = (sigma: readonly number[]) => design.map((row, j) => row.reduce((sum, b, k) => sum + b * sigma[k]!, 0) - target[j]!);
  const gradient = (sigma: readonly number[]) => {
    const r = residual(sigma);
    return knots.map((_, k) => design.reduce((sum, row, j) => sum + row[k]! * r[j]!, 0));
  };
  // The step: 1 / the largest eigenvalue of the normal matrix, by power iteration.
  let vector = knots.map(() => 1);
  let lipschitz = 1;
  for (let i = 0; i < 200; i += 1) {
    const next = knots.map((_, k) => design.reduce((sum, row) => sum + row[k]! * row.reduce((s, b, m) => s + b * vector[m]!, 0), 0));
    lipschitz = Math.hypot(...next) / Math.hypot(...vector);
    vector = next.map((v) => v / Math.hypot(...next));
  }
  let current = project(slopes);
  let momentum = current.slice();
  let t = 1;
  for (let iteration = 0; iteration < 50_000; iteration += 1) {
    const g = gradient(momentum);
    const next = project(momentum.map((v, k) => v - g[k]! / lipschitz));
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const moved = Math.max(...next.map((v, k) => Math.abs(v - current[k]!)));
    momentum = next.map((v, k) => v + ((t - 1) / tNext) * (v - current[k]!));
    current = next;
    t = tNext;
    if (moved < 1e-13) break;
  }
  return slopeKnotCurve(origin, knots.map((x, k) => ({ x, y: current[k]! })));
}
