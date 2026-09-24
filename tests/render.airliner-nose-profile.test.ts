import { describe, expect, it } from "vitest";
import {
  blendRings,
  closeOnPole,
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
import { AIRLINER_NOSE_POLE_X, FUSELAGE_SECTIONS, NOSE_SECTIONS } from "../src/render/webgpu/aircraft/airlinerVisual";
import { loftSectionPoint, type LoftSection } from "../src/render/webgpu/aircraft/builders";

/**
 * THE HAND-RINGED NOSE UNTIL 2026-09-23, frozen here as the instrument's
 * positive control: the fuselage's forward rings (21 and on) and the nose,
 * exactly as they were at ae8ca49, before the polish blended the fuselage
 * into the flight deck's roof and rounded the tip. The S the diagnosis found
 * is in these numbers.
 */
const HAND_RINGED_FUSELAGE: readonly LoftSection[] = [
  { x: 21, yRadius: 3.82, zRadius: 3.25, yOffset: 0.57, crownZRadius: 2.61 },
  { x: 26, yRadius: 3.825, zRadius: 3.25, yOffset: 0.575, crownZRadius: 2.6 },
  { x: 27.2, yRadius: 3.675, zRadius: 3.1, yOffset: 0.635, crownZRadius: 2.51 },
  { x: 28, yRadius: 3.65, zRadius: 3, yOffset: 0.6, crownZRadius: 2.45 },
  { x: 29.2, yRadius: 3.2931, zRadius: 2.7108, yOffset: 0.42 },
  { x: 29.6, yRadius: 3.2076, zRadius: 2.5634, yOffset: 0.4467 },
  { x: 30, yRadius: 3.1225, zRadius: 2.4168, yOffset: 0.4733 },
  { x: 30.4, yRadius: 3.0378, zRadius: 2.2709, yOffset: 0.5 },
  { x: 30.8, yRadius: 2.7565, zRadius: 1.9493, yOffset: 0.518 },
];
const HAND_RINGED_NOSE: readonly LoftSection[] = [
  { x: 25.5, yRadius: 3, zRadius: 3, yOffset: -0.02 },
  { x: 28, yRadius: 3.5405, zRadius: 2.91, yOffset: 0.6, crownZRadius: 2.3765 },
  { x: 29.2, yRadius: 3.28, zRadius: 2.7, yOffset: 0.42 },
  { x: 30.4, yRadius: 3.05, zRadius: 2.28, yOffset: 0.5 },
  { x: 31.4, yRadius: 2.835, zRadius: 1.82, yOffset: 0.545 },
  { x: 32.4, yRadius: 2, zRadius: 1.36, yOffset: 0.3 },
  { x: 33.4, yRadius: 1.2, zRadius: 0.92, yOffset: -0.25 },
  { x: 34, yRadius: 0.31, zRadius: 0.34, yOffset: -0.1 },
];

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
  it("finds the S in the hand-ringed 747 crown, where the diagnosis put it -- and the polish takes out all of it but the brow", () => {
    const hand = outlineBreaks(unionOutline(HAND_RINGED_FUSELAGE, HAND_RINGED_NOSE));
    const at = (breaks: readonly { x: number; degrees: number }[], x: number) => breaks.find((corner) => Math.abs(corner.x - x) < 1e-9)!.degrees;
    expect(at(hand.crown, 28)).toBeCloseTo(-19.8, 1);
    expect(at(hand.crown, 29.2), "the crown bends back UP over the pilots").toBeCloseTo(15.7, 1);
    expect(at(hand.crown, 31.4), "the brow").toBeCloseTo(-37.6, 1);
    // And the keel reverses its sweep at 32.4.
    expect(at(hand.keel, 32.4)).toBeCloseTo(-16.5, 1);

    // THE SHIPPED NOSE, polished (2026-09-23). Behind the flight deck the crown turns by 3.2 degrees at most a ring
    // (at 26.2), and by +1.2 at 29.2 where the hand rings bent it up 15.7: the roof the glass sits on is the same, but
    // the blend now eases onto it. The brow at 31.4 stays, because the No.1 panes are cast onto the strips either side
    // of it; the root is a flight-deck eye 0.5-0.7 m low for a Boeing-shaped nose (AIRLINER_NOSE_POLISH_2026_09_23.md).
    const shipped = outlineBreaks(unionOutline(FUSELAGE_SECTIONS.filter((section) => section.x >= 21), NOSE_SECTIONS));
    const behindDeck = shipped.crown.filter((corner) => corner.x >= 26 && corner.x <= 30.8);
    expect(Math.max(...behindDeck.map((corner) => Math.abs(corner.degrees)))).toBeLessThan(3.5);
    expect(at(shipped.crown, 29.2)).toBeCloseTo(1.17, 1);
    expect(at(shipped.crown, 31.4), "the brow, kept").toBeCloseTo(-37.6, 1);
    // The keel sweeps up without turning back down anywhere, from the cabin to the tip.
    expect(Math.min(...shipped.keel.filter((corner) => corner.x >= 26).map((corner) => corner.degrees))).toBeGreaterThan(-1);
    expect(at(shipped.keel, 32.4)).toBeCloseTo(0, 6);
    // Monotone, too: every station from 29.2 to the tip is higher underneath than the one behind it.
    const shippedOutline = unionOutline(FUSELAGE_SECTIONS.filter((section) => section.x >= 21), NOSE_SECTIONS);
    const keel = shippedOutline.filter((station) => station.x >= 29.2).map((station) => station.keel);
    expect(keel.every((y, i) => i === 0 || y > keel[i - 1]!)).toBe(true);
    // And the tip closes on a pole: the last ring is 0.28 x 0.24 m where the hand rings ended on a 0.68 x 0.62 disc.
    const last = sectionOutline(NOSE_SECTIONS[NOSE_SECTIONS.length - 1]!);
    expect(2 * last.halfWidth).toBeLessThan(0.3);
    expect(last.crown - last.keel).toBeLessThan(0.25);
    // The closure, the fan onto the pole included, turns less at any ring than the ring's own step round (360/28 =
    // 12.86 degrees), so its rings are no coarser along the nose than they are round it: 9.0 at most (the keel, at
    // the last ring).
    const pole: OutlineStation = { x: AIRLINER_NOSE_POLE_X, crown: last.waterline, keel: last.waterline, waterline: last.waterline, halfWidth: 0 };
    const closure = outlineBreaks([...shippedOutline, pole]);
    for (const line of ["crown", "keel", "plan"] as const) {
      const worst = Math.max(...closure[line].filter((corner) => corner.x >= 33.4).map((corner) => Math.abs(corner.degrees)));
      expect(worst, line).toBeLessThan(360 / 28);
      expect(worst, line).toBeGreaterThan(8);
    }
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

describe("the ring repairs the nose polish is built with", () => {
  it("blendRings puts a straight run's rings exactly on it, and the shipped blend on one smooth curve", () => {
    // CONTROL: four rings on one straight line in every quantity; a C1 cubic through them is that line.
    const straight = (x: number): LoftSection => ({ x, yRadius: 3 - 0.1 * (x - 20), zRadius: 2.5 - 0.05 * (x - 20), yOffset: 0.2 + 0.01 * (x - 20) });
    const rings = blendRings(straight(20), straight(21), straight(23), straight(24), 0.5);
    expect(rings.map((ring) => ring.x)).toEqual([21.5, 22, 22.5]);
    for (const ring of rings) {
      const want = straight(ring.x);
      expect(ring.yRadius).toBeCloseTo(want.yRadius, 12);
      expect(ring.zRadius).toBeCloseTo(want.zRadius, 12);
      expect(ring.yOffset).toBeCloseTo(want.yOffset!, 12);
      expect(ring.lowerYRadius).toBeUndefined();
    }
    // The shipped blend: the fuselage's rings from 26.2 to 29.0, every 0.2 m, and the livery's table has the same.
    const blend = FUSELAGE_SECTIONS.filter((section) => section.x > 26 && section.x < 29.2);
    expect(blend.map((ring) => ring.x)).toEqual(Array.from({ length: 15 }, (_, i) => Math.round((26.2 + 0.2 * i) * 10) / 10));
  });

  it("closeOnPole starts on the incoming strip's slope, closes every radius on the pole, and refuses a pole too far", () => {
    const before: LoftSection = { x: 32.4, yRadius: 2, zRadius: 1.36, yOffset: 0.3 };
    const last: LoftSection = { x: 33.4, yRadius: 1.2, lowerYRadius: 0.86, zRadius: 0.92, yOffset: -0.25 };
    const rings = closeOnPole(before, last, 34, 7);
    expect(rings).toHaveLength(7);
    const outline = [before, last, ...rings].map(sectionOutline);
    const pole = -0.25;
    for (let i = 2; i < outline.length; i += 1) {
      const [a, b] = [outline[i - 1]!, outline[i]!];
      expect(b.x).toBeGreaterThan(a.x);
      expect(b.crown - pole).toBeLessThan(a.crown - pole);
      expect(pole - b.keel).toBeLessThan(pole - a.keel);
      expect(b.halfWidth).toBeLessThan(a.halfWidth);
    }
    // Round: the last ring is within an eighth of 33.4's radii of the pole, and 1 cm behind it.
    const end = outline[outline.length - 1]!;
    expect(end.crown - pole).toBeLessThan((1.2 + 0.1) / 8);
    expect(end.halfWidth).toBeLessThan(0.92 / 6);
    expect(34 - end.x).toBeLessThan(0.01);
    // C1 at 33.4: the outline turns there by no more than the closure's own curvature over its first strip.
    const turns = outlineBreaks(outline);
    for (const line of ["crown", "keel", "plan"] as const) {
      expect(Math.abs(turns[line].find((corner) => corner.x === 33.4)!.degrees), line).toBeLessThan(5);
    }
    // The crown arrives at 53 degrees; from 0.8 m out it would have to bulge before it could close, and is refused.
    expect(() => closeOnPole(before, last, 34.2, 7)).toThrow(RangeError);
  });
});
