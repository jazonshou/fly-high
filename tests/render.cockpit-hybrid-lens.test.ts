import { describe, expect, it } from "vitest";
import {
  COCKPIT_HORIZONTAL_FOV_DEGREES,
  COCKPIT_LENS_HELD_ASPECT,
  PERF_COCKPIT_HORIZONTAL_FOV_DEGREES,
  PERF_COCKPIT_RIG,
  cockpitFieldOfViewDegrees,
  cockpitHorizontalFieldOfViewForAspect,
} from "../src/render/cameraPresentation";
import { DECKS, DECK_CATEGORIES, cockpitView } from "./support/cockpitFootprints";
import { areaShareInFrame, cockpitParts, projectPart, rowShareInFrame } from "./support/cockpitDisplayRects";

/**
 * The cockpit's hybrid lens (`cockpitHorizontalFieldOfViewForAspect`).
 *
 * Up to 16:9 it is the 75 degree horizontal-fixed lens every deck was built and
 * measured against, the SAME number, so nothing a 16:9 player sees can move. Wider,
 * it holds the vertical field it has at 16:9, 46.69 degrees, and grows sideways.
 * Horizontal-fixed alone cropped a wide window from below: at 21:9 the frame's
 * bottom sat 18.2 degrees under the eye and none of the F-16's MFDs or the 747's
 * glass was in view (docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md). The perf
 * rig's lens is an override and does not move at any aspect.
 *
 * The HUD half (the deck line's `min(50vw, 88.889vh)`) is held on geometry by
 * tests/ui.hud-cockpit-layout.test.ts, through this lens, at three 21:9 windows.
 */
const DEG = 180 / Math.PI;
const verticalDegrees = (horizontal: number, aspect: number) => 2 * Math.atan(Math.tan(horizontal / DEG / 2) / aspect) * DEG;
const HELD_VERTICAL = verticalDegrees(COCKPIT_HORIZONTAL_FOV_DEGREES, 16 / 9);
const SIXTEEN_NINE = [[1280, 720], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]] as const;
const TWENTY_ONE_NINE = [[1680, 720], [2560, 1080], [3440, 1440]] as const;

describe("the cockpit lens on a window's aspect", () => {
  it("is exactly the 75 degree lens on every 16:9 window, so a 16:9 frame cannot move", () => {
    expect(COCKPIT_LENS_HELD_ASPECT).toBe(16 / 9);
    for (const [w, h] of SIXTEEN_NINE) {
      expect(cockpitHorizontalFieldOfViewForAspect(null, w / h), `${w} x ${h}`).toBe(COCKPIT_HORIZONTAL_FOV_DEGREES);
    }
  });

  it("is exactly the 75 degree lens on every narrower window, up to the breakpoint and not past it", () => {
    for (const aspect of [1, 5 / 4, 4 / 3, 3 / 2, 16 / 10, 1.75, 1.777]) {
      expect(cockpitHorizontalFieldOfViewForAspect(null, aspect), `${aspect}`).toBe(COCKPIT_HORIZONTAL_FOV_DEGREES);
    }
    // Just past 16:9 it has already turned: a breakpoint moved to either side fails here or above.
    for (const aspect of [1.78, 1.8, 1.85]) {
      const lens = cockpitHorizontalFieldOfViewForAspect(null, aspect);
      expect(lens, `${aspect}`).toBeGreaterThan(COCKPIT_HORIZONTAL_FOV_DEGREES);
      expect(verticalDegrees(lens, aspect), `${aspect}`).toBeCloseTo(HELD_VERTICAL, 9);
    }
  });

  it("holds the 16:9 vertical field on wider windows, and is continuous at the breakpoint", () => {
    expect(HELD_VERTICAL).toBeCloseTo(46.69, 2);
    for (const aspect of [2, 21 / 9, 2560 / 1080, 3440 / 1440, 32 / 9]) {
      const lens = cockpitHorizontalFieldOfViewForAspect(null, aspect);
      expect(verticalDegrees(lens, aspect), `${aspect}`).toBeCloseTo(HELD_VERTICAL, 9);
    }
    expect(cockpitHorizontalFieldOfViewForAspect(null, 21 / 9)).toBeCloseTo(90.4, 1);
    expect(cockpitHorizontalFieldOfViewForAspect(null, 2560 / 1080)).toBeCloseTo(91.3, 1);
    expect(cockpitHorizontalFieldOfViewForAspect(null, (16 / 9) * (1 + 1e-12))).toBeCloseTo(COCKPIT_HORIZONTAL_FOV_DEGREES, 9);
    for (const aspect of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(cockpitHorizontalFieldOfViewForAspect(null, aspect), `${aspect}`).toBe(COCKPIT_HORIZONTAL_FOV_DEGREES);
    }
  });

  it("leaves the perf rig's lens untouched at every aspect", () => {
    for (const aspect of [1, 16 / 9, 1.8, 21 / 9, 32 / 9]) {
      expect(cockpitHorizontalFieldOfViewForAspect(PERF_COCKPIT_RIG, aspect), `${aspect}`).toBe(PERF_COCKPIT_HORIZONTAL_FOV_DEGREES);
      // Any override: its own lens, exactly, the one `cockpitFieldOfViewDegrees` gives.
      const wide = { ...PERF_COCKPIT_RIG, horizontalFovDegrees: 90 };
      expect(cockpitHorizontalFieldOfViewForAspect(wide, aspect)).toBe(cockpitFieldOfViewDegrees(wide));
    }
  });
});

describe("what the lens shows of each deck, from the kits' own constants", () => {
  it("places every in-frame display where the ray grid draws it, on a 16:9 and a 21:9 window", () => {
    // The positive control for the projection below: each screen's (or dial's) top edge,
    // against the first row the grid draws it on in its centre column, within 2 px.
    let checked = 0;
    for (const [w, h] of [[1600, 900], [2560, 1080]] as const) {
      const lens = cockpitHorizontalFieldOfViewForAspect(null, w / h);
      for (const deck of DECKS) {
        const view = cockpitView(deck, w, h);
        try {
          for (const part of cockpitParts(deck).filter((p) => p.kind !== "bezel")) {
            const rect = projectPart(deck, part, w, h, lens);
            const column = Math.round((rect.x0 + rect.x1) / 2);
            if (column < 0 || column >= w || rect.y0 < 0 || rect.y0 >= h) continue;
            let drawn = -1;
            for (let y = Math.floor(rect.y0) - 20; y < Math.min(h, rect.y1); y += 1) {
              const hit = view.pick(column, y);
              if (hit?.category === "display") { drawn = y; break; }
            }
            expect(Math.abs(drawn - rect.y0), `${deck} ${part.name} at ${w} x ${h}: kit top ${rect.y0.toFixed(1)}, drawn from ${drawn}`).toBeLessThanOrEqual(2);
            // And the grid calls nothing of the deck the display's own at 2 px above it.
            const above = view.pick(column, Math.floor(rect.y0) - 2);
            expect(above?.category === "display", `${deck} ${part.name}: display above its kit top`).toBe(false);
            checked += 1;
          }
        } finally {
          view.dispose();
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(DECK_CATEGORIES.has("display")).toBe(true);
  });

  it("shows every display at 21:9 at least as fully as at 16:9, and the same rows of it", () => {
    for (const deck of DECKS) {
      for (const part of cockpitParts(deck)) {
        const at = (w: number, h: number) => projectPart(deck, part, w, h, cockpitHorizontalFieldOfViewForAspect(null, w / h));
        const wide16 = at(1600, 900);
        for (const [w, h] of TWENTY_ONE_NINE) {
          const wide = at(w, h);
          const label = `${deck} ${part.name} at ${w} x ${h}`;
          expect(areaShareInFrame(wide, w, h), label).toBeGreaterThanOrEqual(areaShareInFrame(wide16, 1600, 900) - 1e-9);
          expect(rowShareInFrame(wide, h), label).toBeCloseTo(rowShareInFrame(wide16, 900), 9);
        }
      }
    }
  });

  it("CONTROL: the plain 75 degree lens loses them at 21:9, so the comparison above can see it", () => {
    // Top-row display rows in frame at 2560 x 1080 with horizontal-fixed 75 degrees: none of the 747's top
    // row, 29.5 % of the Global's, 37.1 % of the F-16's MFDs. (The survey's 0 / 0 / 13 was on the Global's flat
    // board; its P1 panel stands the screens higher, 72.5 % of their rows in a 16:9 frame. A plain 75 degree ray
    // grid reads the Global's two at 29.6 % and 72.6 %. The F-16's read none at 21:9 and 62 % at 16:9 under the
    // wedge's near edge at -16; under the rail's cove at -12.7 they stood 3.5 cm higher, 31.4 % and 98.6 %; on the
    // dash leaned 15 degrees (step 3) its lower part comes nearer the eye, 37.1 % and all of it.)
    const share = (deck: (typeof DECKS)[number], name: string, w: number, h: number, lens: number) =>
      rowShareInFrame(projectPart(deck, cockpitParts(deck).find((p) => p.name === name)!, w, h, lens), h);
    expect(share("jet", "port MFD", 2560, 1080, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBeCloseTo(0.371, 2);
    expect(share("airliner", "port-pfd", 2560, 1080, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBe(0);
    expect(share("bizjet", "port-outboard", 2560, 1080, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBeCloseTo(0.295, 2);
    // The same parts at 16:9: 100 %, 36.5 % and 72.5 % of their rows. (The 747's was 38 % on K3's upright board; on
    // its P1 panel, leaned 17 degrees, the screen's lower part is nearer the eye and spans more rows, so the frame's
    // bottom cuts a larger share of its ROWS while the share of its face is the same 38.1 % the kit's test reads.)
    expect(share("jet", "port MFD", 1600, 900, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBe(1);
    expect(share("airliner", "port-pfd", 1600, 900, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBeCloseTo(0.365, 2);
    expect(share("bizjet", "port-outboard", 1600, 900, COCKPIT_HORIZONTAL_FOV_DEGREES)).toBeCloseTo(0.725, 2);
    // The loss itself: at 21:9 the plain lens shows the Global's screen, and the F-16's, at less than half the rows
    // 16:9 shows.
    for (const [deck, name] of [["bizjet", "port-outboard"], ["jet", "port MFD"]] as const) {
      expect(share(deck, name, 2560, 1080, COCKPIT_HORIZONTAL_FOV_DEGREES), deck)
        .toBeLessThan(0.5 * share(deck, name, 1600, 900, COCKPIT_HORIZONTAL_FOV_DEGREES));
    }
  });
});
