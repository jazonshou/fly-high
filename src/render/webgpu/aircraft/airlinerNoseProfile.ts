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
  readonly tip: {
    readonly x: number;
    readonly length: number;
    /**
     * The closure's length for the HALF-WIDTH, where it differs from the
     * vertical radii's: a tip's radius of curvature is (radius)^2 / length on
     * each axis, so one length cannot give a side view and a plan the same
     * tip radius unless the section there is round. `length` where absent.
     */
    readonly planLength?: number;
  };
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

/**
 * The tip closure's radius scale at `x`: 1 behind the closure, falling on an
 * ellipse to 0 at the tip. `plan` reads the half-width's own closure length.
 */
export function tipClosureScale(profile: NoseProfile, x: number, axis: "vertical" | "plan" = "vertical"): number {
  const length = axis === "plan" ? profile.tip.planLength ?? profile.tip.length : profile.tip.length;
  const start = profile.tip.x - length;
  if (x <= start) return 1;
  const s = Math.min(1, (x - start) / length);
  return Math.sqrt(1 - s * s);
}

/** The longer of the two closures: where the rings start crowding toward the tip. */
function closureLength(profile: NoseProfile): number {
  return Math.max(profile.tip.length, profile.tip.planLength ?? profile.tip.length);
}

/** The section at one station, closure applied. */
export function noseSectionAt(profile: NoseProfile, x: number, curves: NoseCurves = curvesOf(profile)): LoftSection {
  const scale = tipClosureScale(profile, x);
  const planScale = tipClosureScale(profile, x, "plan");
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
    zRadius: halfWidth * planScale,
    ...(crownHalfWidth !== undefined ? { crownZRadius: crownHalfWidth * planScale } : {}),
  };
}

/** The nose's rings, from `options.from` to the tip. */
export function noseSections(profile: NoseProfile, options: NoseRingOptions): LoftSection[] {
  const length = closureLength(profile);
  const closureStart = profile.tip.x - length;
  if (!(profile.tip.length > 0) || !(length > 0) || !(closureStart > options.from)) {
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
    stations.push(closureStart + length * Math.sin((lastAngle * i) / options.tipRings));
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

/** The fuselage ring the nose must leave from, and the slopes it must leave along (level where absent). */
export interface NoseJoin {
  readonly x: number;
  readonly crown: number;
  readonly keel: number;
  readonly waterline: number;
  readonly halfWidth: number;
  /**
   * The fuselage's own slope at the join, per line, so the nose leaves it
   * tangent-continuous: a ruled loft's slope there is the chord from its
   * previous ring. 0 (level) where absent.
   */
  readonly slopes?: {
    readonly crown?: number;
    readonly keel?: number;
    readonly halfWidth?: number;
    readonly waterline?: number;
  };
}

export interface NoseFitOptions {
  readonly join: NoseJoin;
  readonly tip: NoseProfile["tip"];
  /** The finest bend the fit can make, metres. */
  readonly knotSpacing?: number;
  /**
   * The crown's shape. Concave by default, a crown that only falls faster
   * toward the nose; the 747's is NOT (Boeing's steepens again at the
   * windscreen, a steeper face between the radome and the hump), so it is
   * given as unconstrained there and the knot spacing does the smoothing.
   */
  readonly crownShape?: ProfileShape;
  /** The crown's curvature penalty (`fitShapedCurve`'s roughness); 0 where absent. */
  readonly crownRoughness?: number;
  /**
   * The widest point's height, given rather than fitted: a side view and a
   * plan cannot see it. Used as it is, and as the centre the side view's radii
   * are divided out of the tip closure about.
   */
  readonly waterline?: ProfileCurveSpec;
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
  const scaleAt = (x: number, axis: "vertical" | "plan" = "vertical") => tipClosureScale(probe, x, axis);
  const usable = (points: readonly ProfilePoint[], axis: "vertical" | "plan" = "vertical") =>
    points.filter((point) => point.x > join.x && point.x < tip.x && scaleAt(point.x, axis) >= minimumScale);
  const fitLine = (y: number, slope: number, points: readonly ProfilePoint[], shape: ProfileShape, roughness = 0): ProfileCurveSpec => {
    const fitted = fitShapedCurve(points, {
      origin: { x: join.x, y }, originSlope: slope, to: tip.x, knotSpacing: spacing, shape, roughness,
    });
    return { origin: fitted.origin, slopeKnots: fitted.slopeKnots };
  };
  const slopes = join.slopes ?? {};

  const traced = reference.waterline && usable(reference.waterline).length > 0;
  const waterline: ProfileCurveSpec = options.waterline ?? (traced
    ? fitLine(join.waterline, slopes.waterline ?? 0, usable(reference.waterline!), {})
    : { points: [{ x: join.x, y: join.waterline }, { x: tip.x, y: join.waterline }], startSlope: 0, endSlope: 0 });
  const waterlineCurve = curve(waterline);
  // Radii out of the closure: about the fitted widest point for the side view, about the centreline for the plan.
  const unclose = (points: readonly ProfilePoint[], about: (x: number) => number, axis: "vertical" | "plan" = "vertical") =>
    usable(points, axis).map((point) => {
      const centre = about(point.x);
      return { x: point.x, y: centre + (point.y - centre) / scaleAt(point.x, axis) };
    });

  return {
    crown: fitLine(join.crown, slopes.crown ?? 0, unclose(reference.crown, (x) => waterlineCurve.value(x)), options.crownShape ?? { curvature: "concave" }, options.crownRoughness ?? 0),
    keel: fitLine(join.keel, slopes.keel ?? 0, unclose(reference.keel, (x) => waterlineCurve.value(x)), { monotone: "increasing", curvature: "convex" }),
    waterline,
    halfWidth: fitLine(join.halfWidth, slopes.halfWidth ?? 0, unclose(reference.halfWidth, () => 0, "plan"), { monotone: "decreasing", curvature: "concave" }),
    tip,
  };
}

/**
 * A plain ring's outline and its crown half-width as a fraction of its
 * half-width: what `blendRings` and `closeOnPole` work on. Rings with a
 * squareness or a filleted crown are not plain, and are refused.
 */
function plainRing(section: LoftSection): { crown: number; keel: number; waterline: number; halfWidth: number; crownRatio: number } {
  if (section.squareness !== undefined || section.crownSquareness !== undefined || section.zOffset !== undefined) {
    throw new RangeError("Only plain elliptical rings can be blended");
  }
  const waterline = section.yOffset ?? 0;
  return {
    crown: waterline + section.yRadius,
    keel: waterline - (section.lowerYRadius ?? section.yRadius),
    waterline,
    halfWidth: section.zRadius,
    crownRatio: (section.crownZRadius ?? section.zRadius) / section.zRadius,
  };
}

type PlainRing = ReturnType<typeof plainRing>;
const RING_LINES = ["crown", "keel", "waterline", "halfWidth", "crownRatio"] as const;

/** Station `x` rounded to the micrometre, so 26 + 0.2 * 1 is 26.2 and two tables agree on it exactly. */
const station = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Rings every `pitch` metres strictly between `from` and `to`, on a C1 cubic
 * (Hermite) in each outline line -- crown, keel, height of the widest point,
 * half-width, and the crown half-width as a fraction of it -- with each end's
 * slope that of the straight strip on its far side (`before` to `from`, `to`
 * to `after`). The strips either side are untouched, so the outline turns at
 * `from` and `to` only by what those rings already turned, and between them by
 * a small angle at each of many rings instead of a large one at a few.
 */
export function blendRings(before: LoftSection, from: LoftSection, to: LoftSection, after: LoftSection, pitch: number): LoftSection[] {
  if (!(before.x < from.x && from.x < to.x && to.x < after.x)) throw new RangeError("Blend rings must be in order along +X");
  if (!(pitch > 0)) throw new RangeError("The blend needs a positive pitch");
  const [b, f, t, a] = [before, from, to, after].map(plainRing) as [PlainRing, PlainRing, PlainRing, PlainRing];
  const span = to.x - from.x;
  const count = Math.max(1, Math.round(span / pitch));
  const lower = from.lowerYRadius !== undefined || to.lowerYRadius !== undefined;
  const crowned = from.crownZRadius !== undefined || to.crownZRadius !== undefined;
  const rings: LoftSection[] = [];
  for (let i = 1; i < count; i += 1) {
    const s = i / count;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
    const h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2;
    const h11 = s ** 3 - s ** 2;
    const line = {} as Record<(typeof RING_LINES)[number], number>;
    for (const key of RING_LINES) {
      const startSlope = ((f[key] - b[key]) / (from.x - before.x)) * span;
      const endSlope = ((a[key] - t[key]) / (after.x - to.x)) * span;
      line[key] = h00 * f[key] + h10 * startSlope + h01 * t[key] + h11 * endSlope;
    }
    rings.push({
      x: station(from.x + span * s),
      yRadius: lower ? line.crown - line.waterline : (line.crown - line.keel) / 2,
      ...(lower ? { lowerYRadius: line.waterline - line.keel } : {}),
      zRadius: line.halfWidth,
      yOffset: lower ? line.waterline : (line.crown + line.keel) / 2,
      ...(crowned ? { crownZRadius: line.crownRatio * line.halfWidth } : {}),
    });
  }
  return rings;
}

/**
 * Rings from `last` to a POLE at `poleX`, rounding the nose off instead of
 * ending it on a flat disc. Each radius -- crown and keel about the pole's
 * height (`last`'s widest point), and the half-width -- closes as
 * r0 * sqrt(1 - u) * (1 + beta * u) over u = 0..1, which ends vertical (a
 * round tip) and starts on the slope of the strip from `before`, so there is
 * no corner at `last`. beta outside (-1/4, 1/2] would bend the closure the
 * wrong way somewhere, so a pole too near or too far for the incoming slopes
 * is refused. The widest point eases level onto the pole's height. Rings are
 * spaced so each is an equal step in radius. Loft them with `endPoleX`.
 */
export function closeOnPole(before: LoftSection, last: LoftSection, poleX: number, rings: number): LoftSection[] {
  if (!(before.x < last.x && last.x < poleX)) throw new RangeError("The pole must lie ahead of the last ring");
  if (!(Number.isInteger(rings) && rings >= 2)) throw new RangeError("A closure needs at least two rings");
  const b = plainRing(before);
  const l = plainRing(last);
  const length = poleX - last.x;
  const run = last.x - before.x;
  const pole = l.waterline;
  const closure = (radius: number, slope: number) => {
    const beta = 0.5 + (slope * length) / radius;
    if (!(radius > 0) || !(beta > -0.25 && beta <= 0.5)) {
      throw new RangeError(`A closure from radius ${radius} on slope ${slope} over ${length} m bends the wrong way (beta ${beta})`);
    }
    return (u: number) => radius * Math.sqrt(1 - u) * (1 + beta * u);
  };
  const crown = closure(l.crown - pole, (l.crown - b.crown) / run);
  const keel = closure(pole - l.keel, -(l.keel - b.keel) / run);
  const halfWidth = closure(l.halfWidth, (l.halfWidth - b.halfWidth) / run);
  const waterlineSlope = ((l.waterline - b.waterline) / run) * length;
  const out: LoftSection[] = [];
  for (let i = 1; i <= rings; i += 1) {
    const u = 1 - ((rings + 1 - i) / (rings + 1)) ** 2;
    const waterline = pole + waterlineSlope * u * (1 - u) ** 2;
    const width = halfWidth(u);
    out.push({
      x: station(last.x + length * u),
      yRadius: pole + crown(u) - waterline,
      lowerYRadius: waterline - (pole - keel(u)),
      zRadius: width,
      yOffset: waterline,
      ...(last.crownZRadius !== undefined ? { crownZRadius: l.crownRatio * width } : {}),
    });
  }
  return out;
}

/** `section` scaled by `factor` about its own widest point: the same shape, inside it (factor < 1). */
export function scaledRing(section: LoftSection, factor: number): LoftSection {
  return {
    ...section,
    yRadius: section.yRadius * factor,
    zRadius: section.zRadius * factor,
    ...(section.lowerYRadius !== undefined ? { lowerYRadius: section.lowerYRadius * factor } : {}),
    ...(section.crownZRadius !== undefined ? { crownZRadius: section.crownZRadius * factor } : {}),
  };
}
