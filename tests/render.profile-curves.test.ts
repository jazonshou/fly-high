import { describe, expect, it } from "vitest";
import { fitShapedCurve, shapePreservingSpline, type ProfilePoint } from "../src/render/webgpu/aircraft/profileCurves";

/**
 * The curves the 747's re-lofted nose is drawn from (`airlinerNoseProfile`).
 *
 * The property that matters is the one a cubic spline lacks: through a crown
 * that climbs, runs level and falls away, it must not invent a hump or a dip.
 * So every shape claim here carries a control -- a Catmull-Rom cubic through
 * the same points, which DOES overshoot -- or the claim would pass on data
 * that never tempted the curve to misbehave.
 */

/** A crown, traced: level, then falling faster and faster. Monotone and concave. */
const CROWN: ProfilePoint[] = [
  { x: 26, y: 4.4 }, { x: 27, y: 4.4 }, { x: 28, y: 4.38 }, { x: 29, y: 4.3 },
  { x: 30, y: 4.12 }, { x: 31, y: 3.8 }, { x: 32, y: 3.2 }, { x: 33, y: 2.3 }, { x: 34, y: 1.1 },
];

function catmullRom(points: readonly ProfilePoint[], x: number): number {
  let i = 0;
  while (i < points.length - 2 && x > points[i + 1]!.x) i += 1;
  const p0 = points[Math.max(0, i - 1)]!; const p1 = points[i]!; const p2 = points[i + 1]!; const p3 = points[Math.min(points.length - 1, i + 2)]!;
  const t = (x - p1.x) / (p2.x - p1.x);
  const m1 = ((p2.y - p0.y) / (p2.x - p0.x)) * (p2.x - p1.x);
  const m2 = ((p3.y - p1.y) / (p3.x - p1.x)) * (p2.x - p1.x);
  const t2 = t * t; const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * m2;
}

/** Samples every millimetre over the data's span. */
function sample(from: number, to: number, f: (x: number) => number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let x = from; x <= to + 1e-9; x += 0.001) out.push({ x, y: f(x) });
  return out;
}

describe("the shape-preserving spline", () => {
  it("passes through every point and is tangent-continuous everywhere, its own inserted knots included", () => {
    const spline = shapePreservingSpline(CROWN);
    for (const point of CROWN) expect(spline.value(point.x)).toBeCloseTo(point.y, 12);
    // C1: the slope just either side of any x agrees; the curve's value is continuous too.
    for (let x = 26.0005; x < 34; x += 0.0137) {
      expect(Math.abs(spline.slope(x + 1e-9) - spline.slope(x - 1e-9))).toBeLessThan(1e-6);
      expect(Math.abs(spline.value(x + 1e-9) - spline.value(x - 1e-9))).toBeLessThan(1e-8);
    }
  });

  it("keeps a level-then-falling crown monotone and concave, where a cubic through the same points humps", () => {
    const spline = shapePreservingSpline(CROWN, { startSlope: 0 });
    const curve = sample(26, 34, (x) => spline.value(x));
    // Never above the level run, never rising, never bending up.
    expect(Math.max(...curve.map((p) => p.y))).toBeLessThanOrEqual(4.4 + 1e-12);
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!.y).toBeLessThanOrEqual(curve[i - 1]!.y + 1e-12);
    const slopes = curve.map((p) => spline.slope(p.x));
    for (let i = 1; i < slopes.length; i += 1) expect(slopes[i]!).toBeLessThanOrEqual(slopes[i - 1]! + 1e-9);
    // CONTROL: Catmull-Rom through the same points rises above the level run (a hump) and bends up somewhere.
    const cubic = sample(26, 34, (x) => catmullRom(CROWN, x));
    expect(Math.max(...cubic.map((p) => p.y))).toBeGreaterThan(4.4 + 1e-4);
    const cubicSecants = cubic.slice(1).map((p, i) => (p.y - cubic[i]!.y) / 0.001);
    expect(cubicSecants.some((s, i) => i > 0 && s > cubicSecants[i - 1]! + 1e-6)).toBe(true);
  });

  it("leaves along a given tangent, and refuses unordered points", () => {
    const spline = shapePreservingSpline(CROWN, { startSlope: 0, endSlope: -1.4 });
    expect(spline.slope(26)).toBe(0);
    expect(spline.slope(34)).toBe(-1.4);
    expect(() => shapePreservingSpline([{ x: 1, y: 0 }, { x: 1, y: 1 }])).toThrow(RangeError);
  });
});

describe("the shaped fit", () => {
  /** The crown above with a 2 cm wobble: 15 of its 31 bends go the wrong way. */
  const noisy = Array.from({ length: 33 }, (_, i) => {
    const x = 26 + i * 0.25;
    return { x, y: 4.4 - 0.022 * Math.max(0, x - 26) ** 2.4 + 0.02 * Math.sin(37 * x) };
  });
  const spec = { origin: { x: 26, y: 4.4 }, originSlope: 0, to: 34, knotSpacing: 0.5 } as const;

  it("recovers a concave quadratic exactly: a linear slope IS a quadratic curve", () => {
    const quadratic = (x: number) => 4.4 - 0.05 * (x - 26) ** 2;
    const points = Array.from({ length: 40 }, (_, i) => ({ x: 26.2 + i * 0.2, y: quadratic(26.2 + i * 0.2) }));
    const fit = fitShapedCurve(points, { ...spec, shape: { curvature: "concave" } });
    for (let x = 26; x <= 34; x += 0.1) expect(fit.value(x)).toBeCloseTo(quadratic(x), 6);
  });

  it("fits a noisy crown with a curve that is concave everywhere, leaves its origin level, and stays near the data", () => {
    const fit = fitShapedCurve(noisy, { ...spec, shape: { curvature: "concave" } });
    // Concave EXACTLY: the slope knots never rise, so neither does the slope anywhere between them.
    const knots = fit.slopeKnots.map((knot) => knot.y);
    for (let i = 1; i < knots.length; i += 1) expect(knots[i]!).toBeLessThanOrEqual(knots[i - 1]! + 1e-12);
    expect(fit.value(26)).toBe(4.4);
    expect(fit.slope(26)).toBe(0);
    const errors = noisy.map((point) => Math.abs(fit.value(point.x) - point.y));
    expect(Math.max(...errors)).toBeLessThan(0.04);
    expect(errors.reduce((a, b) => a + b, 0) / errors.length).toBeLessThan(0.02);
  });

  it("CONTROL: the same fit without the shape bends the crown back up on the noise", () => {
    const free = fitShapedCurve(noisy, { ...spec, knotSpacing: 0.25, shape: {} });
    const knots = free.slopeKnots.map((knot) => knot.y);
    expect(knots.some((slope, i) => i > 0 && slope > knots[i - 1]! + 1e-6)).toBe(true);
    const shaped = fitShapedCurve(noisy, { ...spec, knotSpacing: 0.25, shape: { curvature: "concave" } });
    const shapedKnots = shaped.slopeKnots.map((knot) => knot.y);
    expect(shapedKnots.some((slope, i) => i > 0 && slope > shapedKnots[i - 1]! + 1e-12)).toBe(false);
  });

  it("keeps a rising, convex keel rising and convex, even where the noise dips it", () => {
    const keel = Array.from({ length: 33 }, (_, i) => {
      const x = 26 + i * 0.25;
      return { x, y: -3.25 + 0.01 * Math.max(0, x - 26) ** 2.5 + 0.03 * Math.sin(41 * x) };
    });
    const fit = fitShapedCurve(keel, { ...spec, origin: { x: 26, y: -3.25 }, shape: { monotone: "increasing", curvature: "convex" } });
    const knots = fit.slopeKnots.map((knot) => knot.y);
    for (let i = 0; i < knots.length; i += 1) {
      expect(knots[i]!).toBeGreaterThanOrEqual(-1e-12);
      if (i > 0) expect(knots[i]!).toBeGreaterThanOrEqual(knots[i - 1]! - 1e-12);
    }
  });
});
