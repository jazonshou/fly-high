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
 * The 747's joined with its rebuilt kit (eye (29.85, 2.93, -0.50), the glareshield a
 * lip flush with the panel, the sill above it window frame): its deck is the lip, a
 * line along z, so one row across the whole frame. tests/render.cockpit-airliner.test.ts
 * also holds it straight ahead by ray.
 */
const TOLERANCE_DEGREES = 0.02;

describe("the deck line each cockpit's HUD keeps above", () => {
  const views = new Map<string, CockpitView>();
  beforeAll(() => {
    for (const kind of ["trainer", "jet", "bizjet", "airliner"] as const) views.set(kind, cockpitView(kind, 1600, 900));
  });
  afterAll(() => {
    for (const view of views.values()) view.dispose();
  });

  for (const [kind, why] of [
    ["trainer", "the glareshield's crown, right of centre"],
    ["jet", "the coaming's far edge straight ahead, which render.cockpit-jet.test.ts holds at -10.2"],
    ["bizjet", "the glareshield's top edge"],
    ["airliner", "the glareshield's lip, one row across the frame"],
  ] as const) {
    it(`is the ${kind}'s built deck, ${why}`, () => {
      const measured = measureDeckLineDegrees(views.get(kind)!);
      expect(measured, `${kind}: measured ${measured.toFixed(4)}`).toBeCloseTo(aircraftSpec(kind).cockpitDeckLineDegrees, 1);
      expect(Math.abs(measured - aircraftSpec(kind).cockpitDeckLineDegrees)).toBeLessThanOrEqual(TOLERANCE_DEGREES);
    });
  }
});
