import { describe, expect, it } from "vitest";
import {
  fitNoseProfile,
  noseSectionAt,
  noseSections,
  outlineBreaks,
  outlineResiduals,
  sectionOutline,
  unionOutline,
  type NoseJoin,
  type NoseProfile,
  type NoseReference,
  type OutlineStation,
} from "../src/render/webgpu/aircraft/airlinerNoseProfile";
import { FUSELAGE_SECTIONS, NOSE_SECTIONS } from "../src/render/webgpu/aircraft/airlinerVisual";
import { loftSectionPoint } from "../src/render/webgpu/aircraft/builders";

/**
 * The machinery for re-lofting the 747's nose from a reference (phase B,
 * docs/findings/AIRLINER_NOSE_GLAZING.md), ahead of the reference itself: the
 * FIT is the only step left waiting on it.
 *
 * - The INSTRUMENT finds today's defect: the S in the crown of the shipped,
 *   hand-ringed nose, at the stations and to the tenth of a degree the
 *   diagnosis reported. That is its positive control.
 * - The GENERATOR's rings are smooth where the shipped ones are cornered, meet
 *   every number they are given, close in a round tip and leave the fuselage
 *   level.
 * - The FIT recovers a known nose from a noisy trace of it, without the noise
 *   putting the S back; interpolating the same trace directly does put it
 *   back, and is the control.
 */

/** A synthetic nose with the shape a 747's has: a crown falling ever faster, a keel sweeping up, a blunt plan. */
const JOIN: NoseJoin = { x: 26, crown: 4.4, keel: -3.25, waterline: 0.575, halfWidth: 3.25 };
const TIP = { x: 34.3, length: 1.2 };
const truthCrown = (x: number) => 4.4 - 2.2 * Math.max(0, (x - 26) / 8.3) ** 2.2;
const truthKeel = (x: number) => -3.25 + 2.5 * Math.max(0, (x - 26) / 8.3) ** 2.5;
const truthHalfWidth = (x: number) => 3.25 - 2.4 * Math.max(0, (x - 26) / 8.3) ** 1.8;
const knots = (f: (x: number) => number) => Array.from({ length: 34 }, (_, i) => ({ x: 26 + i * 0.25, y: f(26 + i * 0.25) }));
const TRUTH: NoseProfile = {
  crown: { points: knots(truthCrown), startSlope: 0 },
  keel: { points: knots(truthKeel), startSlope: 0 },
  waterline: { points: [{ x: 26, y: 0.575 }, { x: 34.5, y: 0.575 }], startSlope: 0, endSlope: 0 },
  halfWidth: { points: knots(truthHalfWidth), startSlope: 0 },
  tip: TIP,
};
const RINGS = { from: 26, pitch: 0.2, tipRings: 12 };

describe("the nose outline instrument", () => {
  it("finds the S in today's hand-ringed 747 crown, where the diagnosis put it", () => {
    const forward = FUSELAGE_SECTIONS.filter((section) => section.x >= 21);
    const today = outlineBreaks(unionOutline(forward, NOSE_SECTIONS));
    const at = (x: number) => today.crown.find((corner) => Math.abs(corner.x - x) < 1e-9)!.degrees;
    expect(at(28)).toBeCloseTo(-19.8, 1);
    expect(at(29.2), "the crown bends back UP over the pilots").toBeCloseTo(15.7, 1);
    expect(at(31.4), "the brow").toBeCloseTo(-37.6, 1);
    // And the keel reverses its sweep at 32.4.
    expect(today.keel.find((corner) => Math.abs(corner.x - 32.4) < 1e-9)!.degrees).toBeCloseTo(-16.5, 1);
  });
});

describe("the nose generator", () => {
  it("lays rings with no corner ahead of the tip, and a crown that only ever bends down", () => {
    const sections = noseSections(TRUTH, RINGS);
    const outline = sections.map(sectionOutline);
    const corners = outlineBreaks(outline);
    const closure = TIP.x - TIP.length;
    // What a smooth curve turns in one 0.2 m ring at its own curvature, and no more: the keel's tightest
    // bend, near x 33, is 1.08 degrees a ring. The shipped rings turn up to 37.6 at one.
    for (const line of ["crown", "keel", "plan"] as const) {
      const body = corners[line].filter((corner) => corner.x < closure - 1e-9);
      expect(Math.max(...body.map((corner) => Math.abs(corner.degrees))), `${line} corners behind the tip`).toBeLessThan(1.5);
    }
    // The S cannot exist: no upward bend anywhere on the crown, tip included.
    expect(Math.max(...corners.crown.map((corner) => corner.degrees))).toBeLessThanOrEqual(1e-9);
  });

  it("gives each ring exactly the crown, keel, widest-point height and half-width it asked for", () => {
    for (const x of [26, 27.3, 29.85, 31.4, 32.9]) {
      const section = noseSectionAt(TRUTH, x);
      const outline = sectionOutline(section);
      expect(outline.crown).toBeCloseTo(truthCrown(x), 3);
      expect(outline.keel).toBeCloseTo(truthKeel(x), 3);
      expect(outline.waterline).toBe(0.575);
      expect(outline.halfWidth).toBeCloseTo(truthHalfWidth(x), 3);
      // The two halves meet at the widest point, both vertical there: the section is C1 at its waterline.
      const above = loftSectionPoint(section, Math.PI / 2 - 1e-6);
      const below = loftSectionPoint(section, Math.PI / 2 + 1e-6);
      expect(Math.abs(above.z - below.z)).toBeLessThan(1e-9);
    }
  });

  it("closes in a ROUND tip, not a flat disc, and leaves the fuselage's ring level", () => {
    const sections = noseSections(TRUTH, RINGS);
    const last = sections[sections.length - 1]!;
    // The last ring is 3 % of the radius: the loft's flat cap is about 5 cm across, where today's is 0.68 x 0.62 m.
    expect(2 * last.zRadius).toBeLessThan(0.06);
    expect(last.x).toBeGreaterThan(TIP.x - 0.001);
    // Round: the outline arrives at the tip square to the axis (its last corner turns toward vertical).
    const outline = sections.map(sectionOutline);
    const [a, b] = outline.slice(-2) as [OutlineStation, OutlineStation];
    expect(Math.abs(Math.atan2(b.halfWidth - a.halfWidth, b.x - a.x)) * (180 / Math.PI)).toBeGreaterThan(75);
    // The join: the first ring is the fuselage's, and the crown leaves it level.
    const first = sectionOutline(sections[0]!);
    expect(first.crown).toBeCloseTo(JOIN.crown, 9);
    expect(first.keel).toBeCloseTo(JOIN.keel, 9);
    expect(first.halfWidth).toBeCloseTo(JOIN.halfWidth, 9);
    const second = sectionOutline(sections[1]!);
    expect(Math.abs(second.crown - first.crown) / (second.x - first.x)).toBeLessThan(0.01);
  });
});

describe("the nose fit", () => {
  /**
   * What a trace of TRUTH would give: its silhouette every 0.1 m, with a wobble a tracing hand leaves -- 1 cm at
   * a 0.17 m period, and 1 cm at about 0.75 m. The long one matters: it is on the scale of the fit's own knots,
   * so a fit free to follow it WOULD bend the crown back up; the short one any fit averages away.
   */
  function trace(wobble: number): NoseReference {
    const stations = Array.from({ length: 82 }, (_, i) => 26.05 + i * 0.1).filter((x) => x < TIP.x - 0.05);
    const truth = stations.map((x) => sectionOutline(noseSectionAt(TRUTH, x)));
    const noise = (x: number, k: number) => (wobble / 2) * (Math.sin(k * x) + Math.sin((k / 4.5) * x + 1));
    return {
      crown: truth.map((s) => ({ x: s.x, y: s.crown + noise(s.x, 37) })),
      keel: truth.map((s) => ({ x: s.x, y: s.keel + noise(s.x, 41) })),
      halfWidth: truth.map((s) => ({ x: s.x, y: s.halfWidth + noise(s.x, 43) })),
    };
  }

  it("recovers the traced nose to within the tracing's noise, and keeps its shape", () => {
    const reference = trace(0.02);
    const fitted = noseSections(fitNoseProfile(reference, { join: JOIN, tip: TIP }), RINGS).map(sectionOutline);
    const truthOutline = noseSections(TRUTH, RINGS).map(sectionOutline);
    // Against the NOISELESS truth, behind the last 0.4 m (where the closure's radii are too small to trace).
    const clean = trace(0);
    for (const line of ["crown", "keel", "halfWidth"] as const) {
      const residuals = outlineResiduals(fitted, clean[line].filter((p) => p.x < TIP.x - 0.4), line)
        .map((r) => Math.abs(r.residual ?? Infinity));
      expect(Math.max(...residuals), `${line} worst`).toBeLessThan(0.02);
    }
    // And the shape survives the noise: no upward bend on the crown, no downward one on the keel.
    const corners = outlineBreaks(fitted);
    expect(Math.max(...corners.crown.map((corner) => corner.degrees))).toBeLessThanOrEqual(1e-9);
    expect(Math.min(...corners.keel.filter((corner) => corner.x < TIP.x - TIP.length).map((corner) => corner.degrees)))
      .toBeGreaterThanOrEqual(-1e-9);
    expect(truthOutline.length).toBe(fitted.length);
  });

  it("CONTROL: interpolating the same trace directly puts wobbles back in the crown", () => {
    const reference = trace(0.02);
    const direct: NoseProfile = {
      ...TRUTH,
      crown: { points: [{ x: JOIN.x, y: JOIN.crown }, ...reference.crown.filter((p) => p.x < TIP.x - TIP.length)], startSlope: 0 },
    };
    const corners = outlineBreaks(noseSections(direct, RINGS).map(sectionOutline));
    expect(Math.max(...corners.crown.map((corner) => corner.degrees))).toBeGreaterThan(1);
  });
});
