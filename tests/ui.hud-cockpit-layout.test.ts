import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSpec } from "../src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "../src/render/cameraPresentation";
import {
  COCKPIT_HUD_DECK_MARGIN_PX,
  COCKPIT_HUD_DIAGNOSTICS_TOP_PX,
  COCKPIT_HUD_HINTS_TOP_PX,
  COCKPIT_HUD_TOP_BAND_PX,
  cockpitDeckK,
  cockpitDeckKStyleValue,
} from "../src/ui/cockpitHudLayout";
import { DECKS, DECK_CATEGORIES, cockpitView, type CockpitView, type Deck } from "./support/cockpitFootprints";
import { cockpitHudLayout, flightCssRules, readTopLevelRules } from "./support/cockpitHudModel";
import { EXTERIOR_CAMERAS, hudMarkupCases, renderHudCase } from "./support/hudMarkupCases";

/**
 * The 2D HUD in cockpit view (docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md).
 *
 * THE RULE: nothing of the HUD draws below the deck line, the row where the
 * airframe's glareshield, panel, screens and bezels begin, less 12 px. The cockpit
 * lens is horizontal-fixed, so that row is H/2 + (W/2) * k on any window shape,
 * k = tan(cockpitDeckLineDegrees) / tan(lens / 2).
 *
 * What is held here:
 *  - every other camera's HUD is byte for byte the markup captured before the
 *    cockpit layout existed (de91cef), and the cockpit's differs from it by the
 *    class and `--deck-k` alone;
 *  - the stylesheet's cockpit rules are scoped to the cockpit class and carry the
 *    layout module's numbers;
 *  - on FIVE window shapes, every deck's rows are where the rule says: Babylon's own
 *    horizontal-fixed camera, sized to each window, finds the deck's first row
 *    within 2 px of H/2 + (W/2) * k;
 *  - on those five shapes, every deck, and the full, minimal and alert HUDs, no HUD
 *    element lies over a screen, bezel, glareshield or panel pixel, and none crosses
 *    the deck line. The element boxes are read from the stylesheet
 *    (tests/support/cockpitHudModel.ts), so a deleted layout rule sends its element
 *    back onto the screens, and this fails.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHAPES = [[1280, 720], [1600, 900], [1920, 1080], [1600, 1200], [2560, 1080]] as const;
const kOf = (deck: Deck) => cockpitDeckK(aircraftSpec(deck).cockpitDeckLineDegrees);

describe("the HUD's markup", () => {
  it("is byte for byte what it was for every camera but the cockpit", () => {
    const golden = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/hud-exterior-markup.json"), "utf8")) as {
      capturedOn: string; cases: Record<string, string>;
    };
    expect(golden.capturedOn).toBe("de91cef");
    const cases = hudMarkupCases(EXTERIOR_CAMERAS);
    expect(cases.length).toBe(Object.keys(golden.cases).length);
    for (const c of cases) expect(renderHudCase(c), c.name).toBe(golden.cases[c.name]);
  });

  it("in the cockpit differs from the chase view's by the class and --deck-k alone", () => {
    const cockpitCases = hudMarkupCases(["cockpit"]);
    expect(cockpitCases.length).toBeGreaterThan(0);
    for (const c of cockpitCases) {
      const cockpit = renderHudCase(c);
      const k = cockpitDeckKStyleValue(aircraftSpec(c.aircraft).cockpitDeckLineDegrees);
      expect(Number(k)).toBeGreaterThan(0.1);
      expect(cockpit, c.name).toContain(`class="flight-hud flight-hud--${c.mode} flight-hud--cockpit" style="--deck-k:${k}"`);
      const chase = renderHudCase({ ...c, cameraMode: "chase" });
      const stripped = cockpit
        .replace(" flight-hud--cockpit", "")
        .replace(` style="--deck-k:${k}"`, "")
        .replace("<span>COCKPIT</span>", "<span>CHASE CAM</span>");
      expect(stripped, c.name).toBe(chase);
    }
  });

  it("writes k from the catalogue deck line and the lens the renderer uses", () => {
    for (const deck of DECKS) {
      const degrees = aircraftSpec(deck).cockpitDeckLineDegrees;
      const expected = Math.tan((degrees * Math.PI) / 180) / Math.tan((COCKPIT_HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
      expect(cockpitDeckK(degrees)).toBeCloseTo(expected, 12);
    }
    // The rule is exact only for a horizontal-fixed lens: hold the renderer to it.
    expect(readFileSync(join(ROOT, "src/render/FlightRenderer.ts"), "utf8")).toContain("camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;");
  });
});

describe("the stylesheet's cockpit rules", () => {
  const css = readFileSync(join(ROOT, "src/game/flight.css"), "utf8");
  const rules = readTopLevelRules(css);

  it("are all scoped to the cockpit class, so no other camera's HUD can see them", () => {
    const cockpitSelectors = [...rules.keys()].filter((s) => s.includes("flight-hud--cockpit"));
    expect(cockpitSelectors.length).toBeGreaterThanOrEqual(7);
    for (const selector of cockpitSelectors) expect(selector.startsWith(".flight-hud--cockpit"), selector).toBe(true);
    // And nothing outside them reads the deck line.
    for (const [selector, declarations] of rules) {
      if (selector.startsWith(".flight-hud--cockpit")) continue;
      expect(JSON.stringify(declarations), selector).not.toMatch(/--deck-k|--hud-deck-line/);
    }
  });

  it("carry the layout module's numbers", () => {
    const at = (selector: string) => rules.get(`.flight-hud--cockpit${selector}`) ?? {};
    expect(at("")["--hud-deck-line"]).toBe(`calc(50% + 50vw * var(--deck-k) - ${COCKPIT_HUD_DECK_MARGIN_PX}px)`);
    expect(at(" .flight-hud__bottom")).toMatchObject({ top: `${COCKPIT_HUD_TOP_BAND_PX}px`, bottom: "auto", "align-items": "flex-start" });
    expect(at(" .hud-help")).toMatchObject({ top: `${COCKPIT_HUD_HINTS_TOP_PX}px`, bottom: "auto" });
    expect(at(" .diagnostics").top).toBe(`${COCKPIT_HUD_DIAGNOSTICS_TOP_PX}px`);
    // The attitude clip is the attitude box's half-height plus the margin, less the deck's drop.
    expect(at(" .attitude")["clip-path"]).toBe(`inset(0 0 max(0px, calc(115px + ${COCKPIT_HUD_DECK_MARGIN_PX}px - 50vw * var(--deck-k))) 0)`);
    expect(rules.get(".attitude")?.height).toBe("230px");
    expect(rules.get(".metric-tape")?.height).toBe("170px");
  });
});

for (const [width, height] of SHAPES) {
  describe(`a ${width} x ${height} window`, () => {
    const views = new Map<Deck, CockpitView>();
    beforeAll(() => {
      for (const deck of DECKS) views.set(deck, cockpitView(deck, width, height));
    });
    afterAll(() => {
      for (const view of views.values()) view.dispose();
    });
    const isDeck = (view: CockpitView, x: number, y: number) => {
      const hit = view.pick(x, y);
      return hit !== null && DECK_CATEGORIES.has(hit.category);
    };

    it("puts every deck's first row within 2 px of H/2 + (W/2) * k", () => {
      for (const deck of DECKS) {
        const view = views.get(deck)!;
        const predicted = height / 2 + (width / 2) * kOf(deck);
        const clearRow = Math.floor(predicted - 2.5); // pixel centre at least 2 px above
        const deckRow = Math.ceil(predicted + 1.5); // pixel centre at least 2 px below
        const clear: number[] = [];
        for (let x = 0; x < width; x += 2) if (isDeck(view, x, clearRow)) clear.push(x);
        expect(clear, `${deck}: deck at row ${clearRow}, 2 px above the predicted ${predicted.toFixed(1)}`).toEqual([]);
        let found = false;
        for (let x = 0; x < width && !found; x += 2) found = isDeck(view, x, deckRow);
        expect(found, `${deck}: no deck at row ${deckRow}, 2 px below the predicted ${predicted.toFixed(1)}`).toBe(true);
        // And nothing of the deck anywhere higher, on a 16 px lattice.
        for (let y = 8; y < clearRow; y += 16) {
          for (let x = 8; x < width; x += 16) expect(isDeck(view, x, y), `${deck}: deck at (${x}, ${y})`).toBe(false);
        }
      }
    });

    it("keeps every HUD element off every screen, bezel and deck surface, and above the deck line", () => {
      const rules = flightCssRules(ROOT);
      for (const deck of DECKS) {
        const view = views.get(deck)!;
        const checked = new Set<string>();
        for (const [mode, alerts] of [["full", false], ["minimal", false], ["full", true]] as const) {
          const layout = cockpitHudLayout(rules, { width, height, k: kOf(deck), aircraft: deck, mode, alerts });
          for (const box of layout.boxes) {
            expect(box.y1, `${deck}/${mode}${alerts ? "/alerts" : ""}: ${box.name} crosses the deck line`).toBeLessThanOrEqual(layout.deckLine + 0.5);
            const step = box.y1 - box.y0 < 24 ? 3 : 8;
            for (let y = box.y0 + step / 2; y < box.y1; y += step) {
              for (let x = box.x0 + step / 2; x < box.x1; x += step) {
                const key = `${Math.floor(x)},${Math.floor(y)}`;
                if (checked.has(key) || x < 0 || x >= width || y < 0 || y >= height) continue;
                checked.add(key);
                const hit = view.pick(Math.floor(x), Math.floor(y));
                if (hit && DECK_CATEGORIES.has(hit.category)) {
                  throw new Error(`${deck}/${mode}${alerts ? "/alerts" : ""}: ${box.name} lies over ${hit.part} at (${Math.floor(x)}, ${Math.floor(y)})`);
                }
              }
            }
          }
        }
        expect(checked.size, `${deck}: sampled points`).toBeGreaterThan(1_000);
      }
    });
  });
}
