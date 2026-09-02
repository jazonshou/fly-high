/**
 * The capture observer must actually travel. **Expected to FAIL when written.**
 *
 * **This guard exists because two people are building a capability and nobody
 * was building the proof that it does anything.** The harness is gaining an
 * un-drained mode (so a capture can be taken while pages resolve) and a
 * translation mode (so the observer moves). Both are opt-in capability. **An
 * instrument that gained both and silently behaved exactly as before would look
 * like a success and read as a clean bill of health for the renderer.**
 *
 * The rule it enforces is the one this project keeps re-learning:
 *
 * > **Ask what a PASS looks like if the feature were absent. If a stationary
 * > shot and a moving shot produce the same verdict, the instrument is blind
 * > and green means nothing.**
 *
 * **THE DEFECT IT PINS, stated narrowly because the first statement of it was
 * too broad.** The SETTLE loop spreads a fixed `position` every frame for every
 * shot — only `simulationTime` advances — so **the approach into the pose does
 * not exist for any of the 36.** The camera is teleported to its vantage and
 * then waited for.
 *
 * **What is NOT true, and was claimed before being checked:** that no shot moves
 * at all. `advanceFrameState()` (`:975`) integrates `motionX`/`motionZ` for the
 * three `kind: "motion"` shots across the measure and temporal loops, and they
 * travel 273-422 m. **33 of 36 never move in any phase; the three that do, move
 * only after the settle is over.** Found and then corrected by
 * `flight-simulator-ad`, who read the settle loop and generalised before reading
 * the measure loop's own state function.
 *
 * **So the gap is the JOURNEY, not all motion** — and it is the journey that
 * resolves pages, which is why the drain assertion and this one bite together.
 *
 * Between that and the drain assertion, the suite excludes exactly the state
 * Jason plays in — **which is why he found five defects by flying that
 * thirty-six cameras never caught.**
 *
 * **Landed red on purpose**, in the shape `0c8802e` used for the estimate
 * re-pin trigger: a requirement stated only in prose is a comment, and this one
 * would otherwise be satisfied by two modes that compose into nothing.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readSource } from "./support/sourceText";

const HARNESS = resolve(__dirname, "perf/perf-capture.test.ts");

/**
 * How different a moving capture must be from a stationary one before the
 * instrument counts as sighted. **Derived from measurement, not chosen — and
 * the first measurement was taken on the wrong shot.**
 *
 * **THE CORRECTION, kept because it is the reason the number is trustworthy.**
 * The floor was first measured on `motion-banked-turn` and gave 13 px at delta
 * >= 32. That shot is `kind: "motion"`, and `advanceFrameState()` (`:975`)
 * DOES integrate `motionX`/`motionZ` from airspeed for those three shots across
 * the measure and temporal loops — so it travels ~273 m and is not a stationary
 * reference at all. Measuring a "stationary floor" on a shot that moves would
 * have set the bar against the wrong population.
 *
 * **THE FLOORS, both measured 2026-09-02, two identical captures each:**
 *
 * ```
 * night-moonlit      (kind != motion)      1 px >= 32   0.00011%   max 33
 * motion-banked-turn (kind == motion)     13 px >= 32   0.00141%   max 45
 * ```
 *
 * **The 13x gap between them is itself evidence the three motion shots really
 * do translate** — a frame that moves is measurably less reproducible than one
 * that does not — and it is independent of reading `advanceFrameState`.
 *
 * **So the control must assert on a NON-motion shot**, where nothing moves in
 * any phase today. Its floor is 1 pixel.
 *
 * **THE AMPLITUDE.** The settle loop runs at least `PERF_CAPTURE_WARMUP_FRAMES`
 * (240) at 1/60 s and translates for nobody — that is the phase `TRANSLATE`
 * gives an approach. At a typical shot airspeed an observer that integrates
 * during settle arrives hundreds of metres from where it starts: not a
 * marginally different frame, a different place.
 *
 * **The bar is therefore set where blindness is impossible to miss rather than
 * merely detectable: 10% of pixels at delta >= 32** — roughly 90,000x the
 * stationary floor. A threshold a few multiples above one pixel would be
 * satisfied by a jitter, a reordered draw, or a single popped instance.
 *
 * **If a real moving arm comes in UNDER this, that is a finding about the
 * translation, not a threshold to lower.**
 */
export const OBSERVER_MOTION_MIN_CHANGED_FRACTION = 0.10;

/** The measured same-config floor on a NON-motion shot, so the ratio stays checkable. */
export const OBSERVER_STATIONARY_NOISE_FRACTION = 0.000_001_1;

describe("the capture observer travels", () => {
  const driver = readSource(HARNESS);

  it("still carries the airspeed and render call the journey is built from", () => {
    // NON-VACUITY, and it is the leg that matters most here. If the harness is
    // restructured and these anchors stop matching, the assertion below would
    // pass over a file it never found. Both must be present for the failure to
    // mean what it says.
    expect(driver).toContain("airspeedMetersPerSecond");
    expect(driver).toContain("renderer.render(");
  });

  // WAS INVERTED, NOW A PLAIN ASSERTION — and the flip is the point.
  //
  // This landed as `it.fails` while the settle loop had no journey: green then,
  // designed to go RED the moment translation arrived so nobody could forget to
  // convert it. **It fired.** `flight-simulator-ad`'s translation landed, the
  // body stopped throwing, and this is the conversion it demanded.
  //
  // It caught something on the way through that a plain red would not have. The
  // first detector looked for `position.x +=`; the translation that shipped
  // computes a shrinking `remaining` offset and SUBTRACTS it. So the control sat
  // green with its subject already in the tree — blind to the very thing it was
  // waiting for. **A control keyed on an imagined implementation is not a
  // control**, and only running it against the real one exposed that.
  it("integrates a journey into the pose, so the settle loop is not a teleport", () => {
    // FAILS UNTIL translation lands. The harness must advance `position` by
    // `velocity * dt` across the settle and measure loops rather than spreading
    // a constant. Any of these forms satisfies it; the point is that SOMETHING
    // moves the observer.
    // MATCHES WHAT WAS BUILT, NOT WHAT WAS IMAGINED. The first version of this
    // looked for `position.x +=` and friends — an incrementing observer. The
    // translation that actually landed flies the camera IN, computing a
    // shrinking `remaining` offset and SUBTRACTING it from the nominal pose, so
    // no `+=` appears anywhere. **The control sat green while its own subject
    // was already in the tree**, which is the exact blindness it exists to
    // prevent, one level up.
    //
    // Keyed on the journey's own concept — an approach whose length varies with
    // the frame — rather than on one spelling of arithmetic.
    const integrates = /approachFrames|position\.[xz]\s*\+=|positionX\s*\+=|advanceObserver|integratePosition/u
      .test(driver)
      && /heading\.[xz]\s*\*\s*remaining|remaining\s*\*\s*heading\.[xz]|\+=\s*velocity/u.test(driver);
    expect(
      integrates,
      "THE SETTLE LOOP TRANSLATES FOR NOBODY. Every shot spreads a fixed "
      + "`position` across its warm-up frames — only `simulationTime` advances "
      + "— so no shot has a JOURNEY into its pose: the camera is teleported to "
      + "the vantage and then waited for.\n"
      + "NOT a claim that nothing moves. `advanceFrameState()` "
      + "(perf-capture.test.ts:975) integrates position for the three "
      + "`kind: \"motion\"` shots during measure and temporal, and they travel "
      + "273-422 m. 33 of 36 never move at all; the three that do, move only "
      + "after the settle is over.\n"
      + "Why it matters: pages resolve during the approach, and the drain gate "
      + "then asserts they finished before the shutter opens. Without a journey "
      + "an un-drained capture photographs the initial page-in of a camera "
      + "standing still, and the two modes compose into nothing.",
    ).toBe(true);
  });

  it("PROVES the detector can distinguish the two states", () => {
    // Without this, the assertion above is a regex over text and a pattern that
    // matched nothing would look identical to a harness that genuinely never
    // moves. Both directions are exercised on synthetic input.
    // Both halves of the real pattern, on synthetic input: the journey concept
    // and the offset arithmetic. A detector matching only one would accept a
    // harness that named an approach without flying it.
    const moving = "const remaining = (approachFrames - frame) * speed / 60;"
      + " x: positionX - heading.x * remaining,";
    const still = "renderer.render({ ...state, simulationTime }, 1 / 60);";
    const concept = /approachFrames|position\.[xz]\s*\+=|positionX\s*\+=|advanceObserver|integratePosition/u;
    const offset = /heading\.[xz]\s*\*\s*remaining|remaining\s*\*\s*heading\.[xz]|\+=\s*velocity/u;
    expect(concept.test(moving) && offset.test(moving)).toBe(true);
    expect(concept.test(still) && offset.test(still)).toBe(false);
  });
});
