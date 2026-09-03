import { describe, expect, it } from "vitest";
import {
  LAMP_HUE_NEUTRAL_BELOW,
  classifyHue,
  hueAngle,
  hueHistogram,
  saturation,
} from "../scripts/lampHue.mts";
import { AIRFIELD_LAMP_RGB } from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * Validation for the hue classifier — and the validation IS the deliverable.
 *
 * The question this component exists to answer is not "does it classify
 * colours", which is arithmetic, but **"does it fail where the saturation
 * metric passes?"** A third of the round-2 lamp glow measured violet — a hue in
 * no fixture — and the saturation floor passed it, because chroma magnitude
 * cannot distinguish amber from magenta.
 *
 * So the central test below is a NEGATIVE CONTROL: synthetic amber against
 * synthetic violet **at matched saturation**, where the magnitude metric is
 * provably blind by construction, and the classifier must separate them. If it
 * cannot, it adds nothing over the metric it is meant to supplement.
 */

/** Amber and violet built to the SAME saturation, so magnitude cannot tell them apart. */
const MATCHED_AMBER: readonly [number, number, number] = [1.0, 0.6, 0.2];
// CHOSEN CAREFULLY, and the first attempt was wrong in an instructive way.
// [0.8, 0.2, 1.0] computes to hue EXACTLY 285.0 degrees — the violet/magenta
// boundary — and classified as magenta, failing a test that was right about
// the mechanism and wrong about the sample. See the boundary test below: a
// colour sitting on a sector edge is not a valid probe for that sector.
const MATCHED_VIOLET: readonly [number, number, number] = [0.6, 0.2, 1.0];

describe("the classifier fails where the magnitude metric cannot", () => {
  it("is blind by construction if you only measure saturation", () => {
    // NOT a property of the classifier — a property of the PROBLEM, asserted so
    // the next reader sees why hue classification was needed at all.
    const amber = saturation(...MATCHED_AMBER);
    const violet = saturation(...MATCHED_VIOLET);
    expect(amber).toBeCloseTo(violet, 10);
    expect(amber).toBeGreaterThan(0.15); // both clear any plausible floor
  });

  it("separates them, which is the whole point", () => {
    expect(classifyHue(...MATCHED_AMBER)).toBe("amber");
    expect(classifyHue(...MATCHED_VIOLET)).toBe("violet");
  });

  it("classifies every shipped fixture colour as itself", () => {
    // Non-vacuity against the real constants rather than synthetic ones: a
    // classifier that returned "violet" for everything would pass the test
    // above and fail here.
    expect(classifyHue(...AIRFIELD_LAMP_RGB.amber)).toBe("amber");
    expect(classifyHue(...AIRFIELD_LAMP_RGB.green)).toBe("green");
    expect(classifyHue(...AIRFIELD_LAMP_RGB.red)).toBe("red");
    // The warm white is deliberately NOT neutral — it is a warm source, and it
    // lands in amber's sector. That is correct and worth pinning: it means a
    // hue gate must treat "white" fixtures as warm, not as achromatic.
    expect(classifyHue(...AIRFIELD_LAMP_RGB.white)).toBe("amber");
  });

  it("reports genuinely achromatic pixels as neutral, not as a colour", () => {
    // The ACES-desaturated lamp CORES are near-grey. Without this they would
    // each be assigned a hue from rounding noise and the histogram would fill
    // with whatever the noise favoured — a false-pass instrument of exactly the
    // kind this component was written to replace.
    expect(classifyHue(245, 245, 245)).toBe("neutral");
    expect(classifyHue(247, 245, 238)).toBe("neutral"); // a measured round-2 core
    expect(classifyHue(0, 0, 0)).toBe("neutral");
    // And the threshold is a real edge, not a formality.
    const justBelow = 1 - LAMP_HUE_NEUTRAL_BELOW * 0.5;
    expect(classifyHue(1, justBelow, justBelow)).toBe("neutral");
  });

  it("detects the actual defect: a warm lamp inverted by the tint", () => {
    // The measured mechanism, reproduced from constants rather than asserted:
    // SCOTOPIC_TINT [0.72, 0.94, 1.55] applied to the warm white inverts the
    // dominant channel, and the classifier must call that violet-family rather
    // than reporting a healthy saturation.
    const TINT: readonly [number, number, number] = [0.72, 0.94, 1.55];
    const lamp = AIRFIELD_LAMP_RGB.white;
    const out: [number, number, number] = [
      lamp[0] * TINT[0], lamp[1] * TINT[1], lamp[2] * TINT[2],
    ];
    expect(out[2]).toBeGreaterThan(out[0]); // the inversion itself
    // The classifier names it as a hue no fixture emits, which is the check.
    expect(
      ["violet", "blue", "magenta", "cyan"],
      "the classifier must not report a tint-inverted lamp as a lamp colour",
    ).toContain(classifyHue(...out));
    // HONEST SCOPE: this naive product's own saturation is only 0.107, so it
    // is NOT an example of "high saturation, wrong hue" — the measured frames
    // reach 0.24 in the shoulder because retention and the scene interact in
    // ways this two-line model does not capture. The inversion is what
    // reproduces here; the magnitude does not, and claiming otherwise would be
    // exactly the overreach this component exists to correct.
    expect(saturation(...out)).toBeLessThan(0.15);
  });

  it("is unstable on a sector boundary, which is why two classifiers disagree", () => {
    // FOUND BY THIS FILE'S OWN FIRST DRAFT. [0.8, 0.2, 1.0] is hue 285.0 — the
    // exact violet/magenta edge — so which bucket it lands in is decided by a
    // `<` versus `<=`, not by the colour.
    //
    // THE CONSEQUENCE IS THE POINT: a percentage from this classifier is
    // comparable only against another percentage from THIS classifier. Two
    // implementations with different boundaries will report different splits
    // for the same frame, and neither is wrong. So a hue gate must pin the
    // classifier alongside the threshold, or the number silently means
    // something else the day the buckets move.
    expect(hueAngle(0.8, 0.2, 1.0)).toBeCloseTo(285, 9);
    const onEdge = classifyHue(0.8, 0.2, 1.0);
    const justInside = classifyHue(0.62, 0.2, 1.0);
    expect(onEdge).toBe("magenta");
    expect(justInside).toBe("violet");
    // Both are "not a lamp colour", which is the assertion a gate should
    // actually make — a family, never a single bucket.
    for (const hue of [onEdge, justInside]) {
      expect(["violet", "magenta", "blue"]).toContain(hue);
    }
  });

  it("histograms a mixture without collapsing it to a mean", () => {
    // The population point: a mean RGB over amber and violet reads as some
    // muddy middle and hides that there are two populations. The histogram is
    // what showed 34.1% violet against 14.7% amber rather than one average hue.
    const pixels = [
      ...Array.from({ length: 30 }, () => MATCHED_VIOLET),
      ...Array.from({ length: 10 }, () => MATCHED_AMBER),
      ...Array.from({ length: 60 }, () => [245, 245, 245] as const),
    ];
    const histogram = hueHistogram(pixels);
    expect(histogram.violet).toBe(30);
    expect(histogram.amber).toBe(10);
    expect(histogram.neutral).toBe(60);
  });
});
