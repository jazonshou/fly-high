import { loftSectionPoint, type LoftSection } from "./builders";
import {
  fitShapedCurve,
  shapePreservingSpline,
  slopeKnotCurve,
  type ProfilePoint,
  type ProfileShape,
  type ShapePreservingSpline,
} from "./profileCurves";

/**
 * THE 747'S NOSE AS CURVES, NOT RINGS.
 *
 * The shipped nose is eight hand-placed rings over 8.5 m with straight strips
 * between them. Every ring is a corner in the outline, and the numbers chosen
 * one ring at a time add up to a crown that falls 24 degrees behind the flight
 * deck, bends back up 15.7 into a shelf over the pilots and breaks 37.6 at the
 * brow -- the S that reads as "wonky" (Jason, 2026-09-23;
 * docs/findings/AIRLINER_NOSE_GLAZING.md).
 *
 * Here the nose is five profile curves -- the crown, the keel, the height of
 * the widest point, the half-width there, and optionally the half-width at the
 * crown -- each a shape-preserving C1 spline (`profileCurves`), sampled into
 * rings every `pitch` metres. The radii close on an ellipse over the last
 * `tip.length`, so the radome ends in a rounded tip rather than a flat disc.
 * The rings are what the loft builder already lofts; nothing here draws.
 */

/**
 * A profile line: INTERPOLATED through points (strictly shaped ones -- see
 * `shapePreservingSpline`), or as FITTED, a curve through an origin whose
 * slope is piecewise linear on knots (`slopeKnotCurve`).
 */
export type ProfileCurveSpec =
  | {
    readonly points: readonly ProfilePoint[];
    /** The tangent to leave the first point along, e.g. level off a join. */
    readonly startSlope?: number;
    readonly endSlope?: number;
  }
  | { readonly origin: ProfilePoint; readonly slopeKnots: readonly ProfilePoint[] };

export interface NoseProfile {
  /** Top of the section, body y. */
  readonly crown: ProfileCurveSpec;
  /** Bottom of the section, body y. */
  readonly keel: ProfileCurveSpec;
  /** Height of the widest point, body y: the line the flank's highlight follows. */
  readonly waterline: ProfileCurveSpec;
  /** Half-width at the widest point. */
  readonly halfWidth: ProfileCurveSpec;
  /** Half-width at the crown, for an egg section (`LoftSection.crownZRadius`); an ellipse when absent. */
  readonly crownHalfWidth?: ProfileCurveSpec;
  /**
   * The rounded tip: every radius is scaled by sqrt(1 - s^2) over the last
   * `length` metres before `x`, s running 0..1. The scale has zero slope where
   * it starts, so the closure is tangent-continuous with the curves behind it,
   * and a vertical tangent at the tip, so the nose closes round, not on a point.
   */
  readonly tip: { readonly x: number; readonly length: number };
}

export interface NoseRingOptions {
  /** The first ring's station. */
  readonly from: number;
  /** Ring spacing ahead of the tip closure, metres. */
  readonly pitch: number;
  /** Rings in the tip closure, spaced evenly in its angle, so they crowd where the radius falls fastest. */
  readonly tipRings: number;
  /**
   * The closure's scale at the LAST ring. The loft caps its last ring with a
   * flat fan; ending at 3 % of the radius leaves a cap of a few centimetres.
   */
  readonly lastRingScale?: number;
}

interface NoseCurves {
  readonly crown: ShapePreservingSpline;
  readonly keel: ShapePreservingSpline;
  readonly waterline: ShapePreservingSpline;
  readonly halfWidth: ShapePreservingSpline;
  readonly crownHalfWidth?: ShapePreservingSpline;
}

function curve(spec: ProfileCurveSpec): ShapePreservingSpline {
  return "points" in spec
    ? shapePreservingSpline(spec.points, { startSlope: spec.startSlope, endSlope: spec.endSlope })
    : slopeKnotCurve(spec.origin, spec.slopeKnots);
}

function curvesOf(profile: NoseProfile): NoseCurves {
  return {
    crown: curve(profile.crown),
    keel: curve(profile.keel),
    waterline: curve(profile.waterline),
    halfWidth: curve(profile.halfWidth),
    ...(profile.crownHalfWidth ? { crownHalfWidth: curve(profile.crownHalfWidth) } : {}),
  };
}

/** The tip closure's radius scale at `x`: 1 behind the closure, falling on an ellipse to 0 at the tip. */
export function tipClosureScale(profile: NoseProfile, x: number): number {
  const start = profile.tip.x - profile.tip.length;
  if (x <= start) return 1;
  const s = Math.min(1, (x - start) / profile.tip.length);
  return Math.sqrt(1 - s * s);
}

/** The section at one station, closure applied. */
export function noseSectionAt(profile: NoseProfile, x: number, curves: NoseCurves = curvesOf(profile)): LoftSection {
  const scale = tipClosureScale(profile, x);
  const waterline = curves.waterline.value(x);
  const crown = curves.crown.value(x);
  const keel = curves.keel.value(x);
  const halfWidth = curves.halfWidth.value(x);
  if (!(crown > waterline && waterline > keel && halfWidth > 0)) {
    throw new RangeError(
      `The nose profile is not a section at x ${x.toFixed(3)}: crown ${crown.toFixed(3)}, `
      + `widest point ${waterline.toFixed(3)}, keel ${keel.toFixed(3)}, half-width ${halfWidth.toFixed(3)}`,
    );
  }
  const crownHalfWidth = curves.crownHalfWidth?.value(x);
  if (crownHalfWidth !== undefined && !(crownHalfWidth > 0)) {
    throw new RangeError(`The nose profile's crown half-width is not positive at x ${x.toFixed(3)}`);
  }
  return {
    x,
    yOffset: waterline,
    yRadius: (crown - waterline) * scale,
    lowerYRadius: (waterline - keel) * scale,
    zRadius: halfWidth * scale,
    ...(crownHalfWidth !== undefined ? { crownZRadius: crownHalfWidth * scale } : {}),
  };
}

/** The nose's rings, from `options.from` to the tip. */
export function noseSections(profile: NoseProfile, options: NoseRingOptions): LoftSection[] {
  const closureStart = profile.tip.x - profile.tip.length;
  if (!(profile.tip.length > 0) || !(closureStart > options.from)) {
    throw new RangeError("The nose's tip closure must be positive and start ahead of the first ring");
  }
  if (!(options.pitch > 0) || !(Number.isInteger(options.tipRings) && options.tipRings >= 2)) {
    throw new RangeError("The nose needs a positive pitch and at least two tip rings");
  }
  const lastScale = options.lastRingScale ?? 0.03;
  if (!(lastScale > 0 && lastScale < 1)) throw new RangeError("The last ring's scale must be between 0 and 1");
  const curves = curvesOf(profile);
  const stations: number[] = [];
  const body = Math.max(1, Math.ceil((closureStart - options.from) / options.pitch));
  for (let i = 0; i <= body; i += 1) stations.push(options.from + ((closureStart - options.from) * i) / body);
  const lastAngle = Math.acos(lastScale);
  for (let i = 1; i <= options.tipRings; i += 1) {
    stations.push(closureStart + profile.tip.length * Math.sin((lastAngle * i) / options.tipRings));
  }
  return stations.map((x) => noseSectionAt(profile, x, curves));
}

export interface OutlineStation {
  readonly x: number;
  readonly crown: number;
  readonly keel: number;
  /** Height of the widest point. */
  readonly waterline: number;
  readonly halfWidth: number;
}

/** A section's outline numbers, read through the loft's own point function. */
export function sectionOutline(section: LoftSection): OutlineStation {
  return {
    x: section.x,
    crown: loftSectionPoint(section, 0).y,
    keel: loftSectionPoint(section, Math.PI).y,
    waterline: section.yOffset ?? 0,
    halfWidth: Math.abs(loftSectionPoint(section, Math.PI / 2).z - (section.zOffset ?? 0)),
  };
}

/**
 * The OUTER skin's outline where two lofts overlap, as the eye sees the
 * union: the higher crown, the lower keel, the wider half-width (and the
 * widest point of whichever loft is wider), at every station of either,
 * reading each loft as the ruled surface it is between its rings.
 */
export function unionOutline(...lofts: ReadonlyArray<readonly LoftSection[]>): OutlineStation[] {
  const stations = [...new Set(lofts.flatMap((loft) => loft.map((section) => section.x)))].sort((a, b) => a - b);
  const outlines = lofts.map((loft) => loft.map(sectionOutline));
  const at = (outline: readonly OutlineStation[], x: number): OutlineStation | undefined => {
    for (let i = 0; i < outline.length - 1; i += 1) {
      const a = outline[i]!;
      const b = outline[i + 1]!;
      if (x < a.x || x > b.x) continue;
      const t = (x - a.x) / (b.x - a.x);
      const mix = (p: number, q: number) => p + (q - p) * t;
      return { x, crown: mix(a.crown, b.crown), keel: mix(a.keel, b.keel), waterline: mix(a.waterline, b.waterline), halfWidth: mix(a.halfWidth, b.halfWidth) };
    }
    return undefined;
  };
  return stations.map((x) => {
    const here = outlines.map((outline) => at(outline, x)).filter((station): station is OutlineStation => station !== undefined);
    const widest = here.reduce((best, station) => (station.halfWidth > best.halfWidth ? station : best));
    return {
      x,
      crown: Math.max(...here.map((station) => station.crown)),
      keel: Math.min(...here.map((station) => station.keel)),
      waterline: widest.waterline,
      halfWidth: widest.halfWidth,
    };
  });
}

export interface OutlineBreak {
  readonly x: number;
  /** Signed change of the line's angle across the station, degrees: positive bends it up (or out). */
  readonly degrees: number;
}

/**
 * The corner the outline turns at each interior station, per line: the crown
 * and the keel in the side view, the half-width in the plan view. A ruled loft
 * turns ONLY at its rings, so these are its corners exactly.
 */
export function outlineBreaks(outline: readonly OutlineStation[]): {
  crown: OutlineBreak[];
  keel: OutlineBreak[];
  plan: OutlineBreak[];
  waterline: OutlineBreak[];
} {
  const breaks = (value: (station: OutlineStation) => number): OutlineBreak[] => {
    const out: OutlineBreak[] = [];
    for (let i = 1; i < outline.length - 1; i += 1) {
      const a = outline[i - 1]!;
      const b = outline[i]!;
      const c = outline[i + 1]!;
      const before = Math.atan2(value(b) - value(a), b.x - a.x);
      const after = Math.atan2(value(c) - value(b), c.x - b.x);
      out.push({ x: b.x, degrees: ((after - before) * 180) / Math.PI });
    }
    return out;
  };
  return {
    crown: breaks((station) => station.crown),
    keel: breaks((station) => station.keel),
    plan: breaks((station) => station.halfWidth),
    waterline: breaks((station) => station.waterline),
  };
}

/**
 * Model minus reference at each reference point, the model read as the ruled
 * surface between its stations; `undefined` where the point lies outside them.
 */
export function outlineResiduals(
  outline: readonly OutlineStation[],
  reference: readonly ProfilePoint[],
  line: "crown" | "keel" | "halfWidth" | "waterline",
): Array<{ x: number; residual: number | undefined }> {
  return reference.map((point) => {
    for (let i = 0; i < outline.length - 1; i += 1) {
      const a = outline[i]!;
      const b = outline[i + 1]!;
      if (point.x < a.x || point.x > b.x) continue;
      const t = (point.x - a.x) / (b.x - a.x);
      return { x: point.x, residual: a[line] + (b[line] - a[line]) * t - point.y };
    }
    return { x: point.x, residual: undefined };
  });
}

/** What a traced reference gives the fit: outline points in body metres, any subset of the lines. */
export interface NoseReference {
  readonly crown: readonly ProfilePoint[];
  readonly keel: readonly ProfilePoint[];
  readonly halfWidth: readonly ProfilePoint[];
  /** From a front or quarter view only; a side view cannot see it. A level line through the join when absent. */
  readonly waterline?: readonly ProfilePoint[];
}

/** The fuselage ring the nose must leave from, and leave level. */
export interface NoseJoin {
  readonly x: number;
  readonly crown: number;
  readonly keel: number;
  readonly waterline: number;
  readonly halfWidth: number;
}

export interface NoseFitOptions {
  readonly join: NoseJoin;
  readonly tip: NoseProfile["tip"];
  /** The finest bend the fit can make, metres. */
  readonly knotSpacing?: number;
  /**
   * Reference points inside the tip closure are divided back out of it before
   * the fit; below this scale they say more about the tracing than the
   * section, and are left out.
   */
  readonly minimumClosureScale?: number;
}

/**
 * THE FIT, which is all B waits on: each of the reference's lines fitted by
 * least squares among the curves with the shape the aeroplane's line has --
 * the crown CONCAVE (it only ever falls faster toward the nose), the keel
 * rising and CONVEX (the chin sweeps up faster toward the tip), the
 * half-width falling and CONCAVE (a blunt plan view, never a waist) -- each
 * leaving the fuselage's ring exactly and level (`fitShapedCurve`).
 *
 * Inside the tip closure the reference's radii are divided by the closure's
 * scale first, so the fitted curves are the ones the closure then rounds; the
 * fit and the rings therefore describe the same surface.
 */
export function fitNoseProfile(reference: NoseReference, options: NoseFitOptions): NoseProfile {
  const { join, tip } = options;
  const spacing = options.knotSpacing ?? 0.4;
  const minimumScale = options.minimumClosureScale ?? 0.3;
  const probe: NoseProfile = {
    crown: { points: [] }, keel: { points: [] }, waterline: { points: [] }, halfWidth: { points: [] }, tip,
  };
  const scaleAt = (x: number) => tipClosureScale(probe, x);
  const usable = (points: readonly ProfilePoint[]) =>
    points.filter((point) => point.x > join.x && point.x < tip.x && scaleAt(point.x) >= minimumScale);
  const fitLine = (y: number, points: readonly ProfilePoint[], shape: ProfileShape): ProfileCurveSpec => {
    const fitted = fitShapedCurve(points, {
      origin: { x: join.x, y }, originSlope: 0, to: tip.x, knotSpacing: spacing, shape,
    });
    return { origin: fitted.origin, slopeKnots: fitted.slopeKnots };
  };

  const traced = reference.waterline && usable(reference.waterline).length > 0;
  const waterline: ProfileCurveSpec = traced
    ? fitLine(join.waterline, usable(reference.waterline!), {})
    : { points: [{ x: join.x, y: join.waterline }, { x: tip.x, y: join.waterline }], startSlope: 0, endSlope: 0 };
  const waterlineCurve = curve(waterline);
  // Radii out of the closure: about the fitted widest point for the side view, about the centreline for the plan.
  const unclose = (points: readonly ProfilePoint[], about: (x: number) => number) =>
    usable(points).map((point) => {
      const centre = about(point.x);
      return { x: point.x, y: centre + (point.y - centre) / scaleAt(point.x) };
    });

  return {
    crown: fitLine(join.crown, unclose(reference.crown, (x) => waterlineCurve.value(x)), { curvature: "concave" }),
    keel: fitLine(join.keel, unclose(reference.keel, (x) => waterlineCurve.value(x)), { monotone: "increasing", curvature: "convex" }),
    waterline,
    halfWidth: fitLine(join.halfWidth, unclose(reference.halfWidth, () => 0), { monotone: "decreasing", curvature: "concave" }),
    tip,
  };
}
