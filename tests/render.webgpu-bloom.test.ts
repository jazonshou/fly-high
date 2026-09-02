import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readSource } from "./support/sourceText";
import {
  BLOOM_BLUR_RATIO,
  BLOOM_BLUR_SIGMA,
  BLOOM_BLUR_TAPS,
  BLOOM_BLUR_WGSL,
  BLOOM_INTENSITY,
  BLOOM_KNEE,
  BLOOM_THRESHOLD,
  bloomBlurOffsets,
  bloomBlurWeights,
  bloomBrightPassWeight,
} from "../src/render/webgpu/lighting/BloomPass";

/**
 * `7-5` — bloom, the properties that are not visible in a frame.
 *
 * A bloom is easy to eyeball and hard to verify by eyeballing: it looks
 * plausible while conserving no energy, popping at its threshold, or inverting
 * the ordering the stage before it exists to protect. Those three are what this
 * file pins, and none of them is a screenshot.
 */

describe("bloom blur conserves energy", () => {
  it("has weights summing to one", () => {
    const weights = bloomBlurWeights();
    const total = weights.reduce((sum, value) => sum + value, 0);
    // Not cosmetic. A blur whose taps do not sum to one changes total image
    // energy, which turns bloom from a REDISTRIBUTION of highlight energy into
    // a brightness change -- the same error class as reading `C6-8`'s
    // redistribution as a level shift.
    expect(Math.abs(total - 1)).toBeLessThan(1e-12);
    expect(weights).toHaveLength(BLOOM_BLUR_TAPS);
    expect(weights.every((w) => w > 0), "a non-positive tap").toBe(true);
  });

  it("is symmetric, so the blur does not translate the image", () => {
    const weights = bloomBlurWeights();
    for (let index = 0; index < weights.length; index += 1) {
      const mirrored = weights[weights.length - 1 - index]!;
      expect(Math.abs(weights[index]! - mirrored)).toBeLessThan(1e-15);
    }
    expect(bloomBlurOffsets()).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  });

  it("rejects an even or non-positive tap count rather than silently re-centring", () => {
    expect(() => bloomBlurWeights(8, 2)).toThrow(/odd/);
    expect(() => bloomBlurWeights(9, 0)).toThrow(/sigma/);
  });
});

describe("bloom bright pass cannot pop or invert", () => {
  const SWEEP_MAX = 10;
  const STEPS = 20_000;
  const STEP = SWEEP_MAX / STEPS;

  it("contributes nothing below the knee", () => {
    // The pass must be a genuine no-op on a scene with no sources in it, or
    // every lit surface gains a halo and the effect reads as a haze bug.
    for (let value = 0; value <= BLOOM_THRESHOLD - BLOOM_KNEE; value += 0.01) {
      expect(bloomBrightPassWeight(value)).toBe(0);
    }
    expect(bloomBrightPassWeight(BLOOM_THRESHOLD - BLOOM_KNEE)).toBe(0);
  });

  it("is monotonic non-decreasing across the whole range", () => {
    // THE ORDERING PIN. `7-4a`'s scotopic highlight term exists to keep decades
    // of source brightness ordered after the rod response saturates. A bloom
    // that inverted anywhere would undo that one stage later, and the frame
    // would look fine.
    let previous = bloomBrightPassWeight(0);
    let worstDrop = 0;
    for (let step = 1; step <= STEPS; step += 1) {
      const current = bloomBrightPassWeight(step * STEP);
      worstDrop = Math.min(worstDrop, current - previous);
      previous = current;
    }
    expect(worstDrop, "the bright pass decreases somewhere").toBe(0);
  });

  it("is continuous, including at both ends of the knee", () => {
    // A hard threshold POPS: a light brightening through it gains its entire
    // halo in one frame. Same defect class as the light-point near-to-far
    // transition, and the same fix -- continuity, not a smaller threshold.
    let worstJump = 0;
    let previous = bloomBrightPassWeight(0);
    for (let step = 1; step <= STEPS; step += 1) {
      const current = bloomBrightPassWeight(step * STEP);
      worstJump = Math.max(worstJump, Math.abs(current - previous));
      previous = current;
    }
    // The curve's slope tops out at 1 (above the knee it is exactly
    // luminance - threshold), so a continuous function cannot jump by more
    // than one step.
    //
    // WHAT THIS DOES AND DOES NOT CATCH, checked by mutation rather than
    // assumed: a step onset (`L > threshold ? L : 0`) fails here, by the full
    // threshold height. A hard RAMP (`L > threshold ? L - threshold : 0`) does
    // NOT -- it is continuous, just not smooth, and it is caught one test down
    // by the knee's midpoint being zero. Two different defects, two different
    // assertions; neither test covers for the other.
    expect(worstJump).toBeLessThan(STEP * 1.01);
  });

  it("is non-vacuous: it actually blooms above the knee", () => {
    // Without this every assertion above is satisfied by a function that
    // returns zero everywhere.
    expect(bloomBrightPassWeight(BLOOM_THRESHOLD + BLOOM_KNEE)).toBeGreaterThan(0);
    expect(bloomBrightPassWeight(4)).toBeGreaterThan(bloomBrightPassWeight(2));
    // And the knee is genuinely soft: strictly between the two hard curves at
    // its midpoint, or it is a hard threshold wearing a knee's name.
    const mid = bloomBrightPassWeight(BLOOM_THRESHOLD);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(BLOOM_KNEE);
  });
});

describe("the shipped shader carries the tested numbers", () => {
  it("emits every generated blur weight into the WGSL", () => {
    // A hand-written weight table beside a function that computes the same
    // thing is a decorative list, and three of those have already been found
    // drifting here. Generated means this test asserts what ships.
    const weights = bloomBlurWeights();
    for (const weight of weights) {
      expect(
        BLOOM_BLUR_WGSL.includes(weight.toFixed(9)),
        `blur weight ${weight.toFixed(9)} is not in the shader source`,
      ).toBe(true);
    }
    expect(BLOOM_BLUR_WGSL).not.toContain("array<");
    expect(BLOOM_BLUR_SIGMA).toBeGreaterThan(0);
  });

  it("keeps the bright pass at full resolution", () => {
    // HAZARD 2, and the reason this test exists rather than a comment. The
    // FIRST post-process's ratio sets the size of the target THE SCENE renders
    // into. Bloom's bright pass becomes first whenever the scotopic pass
    // detaches for daylight, so the textbook half-resolution bright pass would
    // have silently halved scene resolution for most of the day -- intermittent,
    // time-of-day dependent, and invisible to every other test here.
    const source = readSource("src/render/webgpu/lighting/BloomPass.ts");
    const bright = /this\.bright = new PostProcess\(([\s\S]*?)\);/.exec(source)?.[1];
    expect(bright, "could not find the bright pass constructor").toBeTruthy();
    expect(
      /,\s*1,\s*camera,/.test(bright!),
      "the bright pass is not ratio 1.0 — it can be the first post-process, "
      + "and the first pass's ratio sets the SCENE's render resolution",
    ).toBe(true);
    // The blur is where the downsample belongs: it can never be first.
    expect(BLOOM_BLUR_RATIO).toBeLessThan(1);
  });
});

describe("first-pass MSAA ownership is derived in one place", () => {
  const source = readSource("src/render/FlightRenderer.ts");

  it("has exactly one assignment per chain member", () => {
    // Ownership used to be two hand-written branches in two methods that had
    // to agree; bloom made it a third holder, which would have been six. The
    // count IS the invariant: a second assignment site means someone re-derived
    // the rule locally, which is how the two-holder version stayed correct only
    // by luck.
    const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
    expect(count(/this\.toneMap\.samples\s*=/g), "toneMap.samples assigned outside the owner")
      .toBe(1);
    expect(count(/this\.scotopic\.setSamples\(/g), "scotopic samples set outside the owner")
      .toBe(1);
    expect(count(/this\.bloom\.setSamples\(/g), "bloom samples set outside the owner")
      .toBe(1);
    expect(source).toContain("private applyFirstPassOwnership(): void {");
  });

  it("re-gates bloom before deriving ownership, not after", () => {
    // `applyFirstPassOwnership` reads `bloom.enabled`, so a profile change that
    // derived first, then attached, would give MSAA to the wrong pass for one
    // frame and leave the sample count wrong until the next toggle.
    const gate = source.indexOf("this.bloom.setEnabled(this.camera, this.profile.bloomEnabled");
    const derive = source.indexOf("this.applyFirstPassOwnership();", gate);
    expect(gate, "profile change does not re-gate bloom").toBeGreaterThan(-1);
    expect(derive, "no ownership derivation after the bloom gate").toBeGreaterThan(gate);
  });

  it("constructs bloom between rod vision and the tone map", () => {
    // Chain order is attachment order, and attachment happens in the
    // PostProcess constructor, so construction order IS the render order.
    const scotopic = source.indexOf("new ScotopicVisionPass(");
    const bloom = source.indexOf("new BloomPass(");
    const tone = source.indexOf('"aces-tone-map"');
    expect(scotopic).toBeGreaterThan(-1);
    expect(bloom, "bloom is not constructed after rod vision").toBeGreaterThan(scotopic);
    expect(tone, "bloom is not constructed before the tone map").toBeGreaterThan(bloom);
  });
});

/**
 * The composed pipeline, in one dimension.
 *
 * `7-4a` pinned the scotopic highlight term because decades of source
 * brightness have to stay ORDERED after the rod response saturates. Bloom runs
 * one stage later and adds energy, so "does bloom blow the HDR range or break
 * the ordering" was the open question the pass was going to need a frame to
 * answer.
 *
 * Most of it does not need a frame. The bright pass is monotone and the blur is
 * a positive linear operator, so their composition is monotone, and that is
 * checkable exactly. Simulating the chain on a 1-D signal turns the vague
 * question into two concrete ones, leaving the frame to check only what a frame
 * uniquely can: how the result lands through ACES.
 *
 * The reference below is exact for a luminance channel rather than approximate:
 * the shader multiplies the colour by `contribution / luminance`, which for a
 * scalar luminance is `contribution` — `bloomBrightPassWeight` itself.
 */
function bloomReference1D(signal: readonly number[], intensity: number): number[] {
  const weights = bloomBlurWeights();
  const offsets = bloomBlurOffsets();
  const bright = signal.map((value) => bloomBrightPassWeight(value));
  const blurred = signal.map((_, index) => {
    let sum = 0;
    for (let tap = 0; tap < weights.length; tap += 1) {
      // Clamp-to-edge, matching the sampler's addressing mode.
      const source = Math.min(signal.length - 1, Math.max(0, index + offsets[tap]!));
      sum += bright[source]! * weights[tap]!;
    }
    return sum;
  });
  return signal.map((value, index) => value + blurred[index]! * intensity);
}

describe("the composed chain cannot break 7-4a's ordering or blow HDR range", () => {
  // A source sitting on a dim background — the configuration the pin is about.
  const SCENE = [0.02, 0.05, 0.1, 0.3, 0.8, 6.0, 0.8, 0.3, 0.1, 0.05, 0.02];

  it("is monotonic in source intensity at every pixel", () => {
    // Brighten the whole scene and NO pixel may darken. This is the ordering
    // property `7-4a` protects, checked through the stage that comes after it.
    let previous = bloomReference1D(SCENE.map((v) => v * 0.5), BLOOM_INTENSITY);
    for (let scale = 0.55; scale <= 8; scale += 0.05) {
      const current = bloomReference1D(SCENE.map((v) => v * scale), BLOOM_INTENSITY);
      for (let index = 0; index < current.length; index += 1) {
        expect(
          current[index]! - previous[index]!,
          `pixel ${index} darkened as the scene brightened, at scale ${scale.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(-1e-12);
      }
      previous = current;
    }
  });

  it("cannot raise the scene's maximum by more than the bloom intensity", () => {
    // THE HDR RANGE BOUND, and the reason this is provable rather than
    // observed: the bright pass never returns more than the luminance it was
    // given, and the blur is a convex combination, so the blurred image is
    // bounded by the scene's own maximum. The most bloom can add anywhere is
    // therefore `intensity x max(scene)` — 8% — and it cannot run away no
    // matter how bright a source gets.
    for (const peak of [2, 10, 100, 10_000]) {
      const scene = [...SCENE.slice(0, 5), peak, ...SCENE.slice(6)];
      const output = bloomReference1D(scene, BLOOM_INTENSITY);
      const sceneMax = Math.max(...scene);
      expect(Math.max(...output)).toBeLessThanOrEqual(sceneMax * (1 + BLOOM_INTENSITY) + 1e-9);
    }

    // A WIDE source, not a single pixel, and the reason is that the bound is
    // otherwise untestable. Found by mutation: doubling the bright pass's
    // output does NOT violate the bound on an isolated pixel, because the blur
    // spreads a lone source across nine taps and the centre keeps only ~0.2 of
    // it. The bound holds with so much slack there that it proves nothing.
    //
    // On a saturated field every tap is bright, the blur returns what it was
    // given, and the realised ratio approaches the bound exactly — so the
    // assertion has teeth, and the two legs below say the bound is both
    // respected and nearly attained. A bound that cannot be approached is not
    // a bound anyone has checked.
    for (const level of [10, 100, 10_000]) {
      const field = new Array<number>(11).fill(level);
      const output = bloomReference1D(field, BLOOM_INTENSITY);
      const ratio = Math.max(...output) / level;
      expect(ratio).toBeLessThanOrEqual(1 + BLOOM_INTENSITY + 1e-9);
      // The realised ratio on a saturated field has a closed form: the bright
      // pass collects `level - threshold`, the blur returns it unchanged, so
      // the gain is `1 + intensity x (level - threshold) / level`, rising to
      // the bound as the field brightens. Asserting the closed form rather
      // than a fraction of the bound — a first attempt used "within 98% of the
      // bound", which is arbitrary and simply false at level 10 (1.072), where
      // the threshold is still a tenth of the signal.
      expect(ratio).toBeCloseTo(1 + (BLOOM_INTENSITY * (level - BLOOM_THRESHOLD)) / level, 9);
    }
  });

  it("adds exactly the bright-pass energy it collected, no more", () => {
    // Energy accounting end to end. If the blur did not conserve, this drifts
    // — and it is the assertion that would catch a normalisation lost during
    // a future retune, which the sum-to-one test alone would not, because that
    // one checks the function and this one checks the pipeline.
    const output = bloomReference1D(SCENE, BLOOM_INTENSITY);
    const added = output.reduce((sum, v, i) => sum + v - SCENE[i]!, 0);
    const collected = SCENE.reduce((sum, v) => sum + bloomBrightPassWeight(v), 0);
    expect(Math.abs(added - collected * BLOOM_INTENSITY)).toBeLessThan(1e-9);
  });

  it("is a no-op on a scene with nothing above the knee", () => {
    const dim = [0.02, 0.1, 0.3, 0.49, 0.3, 0.1, 0.02];
    expect(bloomReference1D(dim, BLOOM_INTENSITY)).toEqual(dim);
  });
});
