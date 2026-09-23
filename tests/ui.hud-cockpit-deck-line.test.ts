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
 * NOT THE 747. Its eye moves and its glareshield is rebuilt in the cockpit kit's K1,
 * so its value (8.99, measured on the kit before K1) and its assertion belong to
 * that MR; until then tests/ui.hud-cockpit-layout.test.ts still holds the 747's
 * deck line to its rows, on every window shape.
 */
const TOLERANCE_DEGREES = 0.02;

describe("the deck line each cockpit's HUD keeps above", () => {
  const views = new Map<string, CockpitView>();
  beforeAll(() => {
    for (const kind of ["trainer", "jet", "bizjet"] as const) views.set(kind, cockpitView(kind, 1600, 900));
  });
  afterAll(() => {
    for (const view of views.values()) view.dispose();
  });

  for (const [kind, why] of [
    ["trainer", "the glareshield's crown, right of centre"],
    ["jet", "the coaming's far edge straight ahead, which render.cockpit-jet.test.ts holds at -10.2"],
    ["bizjet", "the glareshield's top edge"],
  ] as const) {
    it(`is the ${kind}'s built deck, ${why}`, () => {
      const measured = measureDeckLineDegrees(views.get(kind)!);
      expect(measured, `${kind}: measured ${measured.toFixed(4)}`).toBeCloseTo(aircraftSpec(kind).cockpitDeckLineDegrees, 1);
      expect(Math.abs(measured - aircraftSpec(kind).cockpitDeckLineDegrees)).toBeLessThanOrEqual(TOLERANCE_DEGREES);
    });
  }
});
