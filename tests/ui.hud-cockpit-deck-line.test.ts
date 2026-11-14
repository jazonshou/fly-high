import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { cockpitView, measureDeckLineDegrees, type CockpitView } from "./support/cockpitFootprints";

/**
 * `cockpitDeckLineDegrees` is MEASURED, not chosen: the deck's top below the eye,
 * found by ray on the built kit (tests/support/cockpitFootprints.ts: the first
 * surface the GPU draws, back faces culled, each column walked down and bisected).
 * The 2D HUD's cockpit layout keeps out from under it, so a kit that moves its deck
 * must move this with it, and this is what tells it to.
 *
 * Only the trainer is measured here. The jet, the bizjet and the airliner are held
 * to their catalogue values by this same instrument, on the same 1600 x 900 view and
 * within the same 0.02 degrees, in their own kit tests, beside a straight-ahead ray:
 * tests/render.cockpit-jet.test.ts, tests/render.cockpit-bizjet.test.ts and
 * tests/render.cockpit-airliner.test.ts. Until 2026-11-14 this file measured all four
 * again, about 30 s of CI for checks those tests already make.
 */
const TOLERANCE_DEGREES = 0.02;

describe("the deck line each cockpit's HUD keeps above", () => {
  let view: CockpitView;
  beforeAll(() => {
    view = cockpitView("trainer", 1600, 900);
  });
  afterAll(() => {
    view.dispose();
  });

  it("is the trainer's built deck, the glareshield's crown, right of centre", () => {
    const measured = measureDeckLineDegrees(view);
    expect(measured, `trainer: measured ${measured.toFixed(4)}`).toBeCloseTo(aircraftSpec("trainer").cockpitDeckLineDegrees, 1);
    expect(Math.abs(measured - aircraftSpec("trainer").cockpitDeckLineDegrees)).toBeLessThanOrEqual(TOLERANCE_DEGREES);
  });
});
