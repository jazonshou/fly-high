import { describe, expect, it } from "vitest";
import { PERF_CAPTURE_SHOTS, ssimBaselineFailureMessage } from "../scripts/perf-capture.mts";

/**
 * A pre-authorised rebaseline is a note written for someone who does not exist
 * yet: the person who runs the capture AFTER a sanctioned change lands, meets a
 * red SSIM, and has to decide in that moment whether they broke something.
 *
 * **So the note is worthless unless it reaches them.** A field nothing reads is
 * the failure this project has spent the day cataloguing — a check whose result
 * reaches nobody. This asserts the delivery path, not the intent.
 */
describe("pre-authorised rebaselines reach the person who meets the failure", () => {
  it("declares non-trivial text wherever the field is used", () => {
    const declared = PERF_CAPTURE_SHOTS.filter((shot) => shot.sanctionedRebaseline !== undefined);
    for (const shot of declared) {
      const text = shot.sanctionedRebaseline!;
      // A bare "expected to change" tells the reader nothing they did not
      // already know from the red. It must say WHY and WHAT to do.
      expect(text.length, `${shot.name}: sanctionedRebaseline is too short to help`)
        .toBeGreaterThan(80);
      expect(
        /re-?shoot|re-?baseline|regenerate|candidate/iu.test(text),
        `${shot.name}: sanctionedRebaseline does not tell the reader what action to take`,
      ).toBe(true);
    }
  });

  it("is composed into the SSIM failure message the reader receives", () => {
    // A BEHAVIOUR test, not a source scan. The first version of this asserted
    // the driver source mentioned `sanctionedRebaseline` near the gate — and it
    // PASSED when the composition was disabled with the identifier left in
    // place. A guard that checks for a token while the behaviour is broken is
    // the failure it was written to prevent.
    const withNote = ssimBaselineFailureMessage("some-shot", "RE-SHOOT: the fix changes this frame");
    expect(withNote).toContain("some-shot");
    expect(withNote, "the pre-authorisation does not reach the failure text")
      .toContain("RE-SHOOT: the fix changes this frame");
    expect(withNote).toContain("PRE-AUTHORISED");

    const without = ssimBaselineFailureMessage("some-shot");
    expect(without, "an undeclared shot must not gain a phantom authorisation")
      .not.toContain("PRE-AUTHORISED");

    // Every shot that carries one today must reach the reader end to end.
    // Assert the DURABLE properties, not the defect's label. This expectation
    // first read `toContain("A-1")` and went red the moment the mechanism was
    // re-identified — the guard correctly caught its own staleness, but a test
    // pinned to a name re-breaks every time the diagnosis is refined. It was
    // then pinned to `coast-10km-lowsun` specifically, which went stale the
    // same way when that pre-authorisation was CONSUMED by the 2026-09-03
    // re-shoot: a pre-authorisation is a promise about a change that has not
    // landed, so the set of shots carrying one is legitimately empty between
    // sanctioned churn points, and this test must not force one to exist.
    for (const shot of PERF_CAPTURE_SHOTS) {
      if (shot.sanctionedRebaseline === undefined) continue;
      const composed = ssimBaselineFailureMessage(shot.name, shot.sanctionedRebaseline);
      expect(composed).toContain(shot.name);
      expect(composed).toContain("PRE-AUTHORISED");
      expect(
        /re-?shoot|re-?baseline|regenerate|candidate/iu.test(composed),
        `${shot.name}: the composed message does not tell the reader what to do`,
      ).toBe(true);
      expect(
        /not a regression|is the fix/iu.test(composed),
        `${shot.name}: the composed message does not tell the reader the red is EXPECTED`,
      ).toBe(true);
    }
  });
});
