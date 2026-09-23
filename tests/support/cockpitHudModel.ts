import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HudMode } from "@/src/settings";
import type { AircraftKind } from "@/src/sim";

/**
 * Where the 2D HUD's elements land in cockpit view, read from THE STYLESHEET.
 *
 * Node cannot lay out CSS, so this reads src/game/flight.css's top-level rules and
 * places each element by the declarations actually there. Every placement falls
 * back to the base rule when its `.flight-hud--cockpit` rule is missing, so a
 * layout rule that is deleted moves its element back where the chase view puts it
 * — onto the screens — and the footprint test sees it. A cockpit rule written
 * differently from what this knows how to read throws: change the model with it.
 *
 * Element SIZES are fixed pixels in flight.css, measured in Chromium with the real
 * Hud markup and stylesheet (docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md). They
 * do not depend on the window above the stylesheet's 820 px width and 650 px height
 * breakpoints, which every window tested here clears.
 */
export type Rules = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** flight.css's top-level rules, selector -> declarations (later rules win), skipping @-blocks. */
export function readTopLevelRules(css: string): Rules {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, Record<string, string>>();
  let i = 0;
  let selectorStart = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const selector = text.slice(selectorStart, open).trim();
    // Find the matching close brace.
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    if (!selector.startsWith("@")) {
      const body = text.slice(open + 1, j - 1);
      const declarations: Record<string, string> = {};
      for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/\s+/g, " ");
      }
      for (const one of selector.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
        rules.set(one, { ...(rules.get(one) ?? {}), ...declarations });
      }
    }
    i = j;
    selectorStart = j;
  }
  return rules;
}

export function flightCssRules(root: string): Rules {
  return readTopLevelRules(readFileSync(join(root, "src/game/flight.css"), "utf8"));
}

/** Fixed-pixel sizes, measured in Chromium (see the header). */
export const HUD_SIZES = {
  sessionText: { left: 28, top: 22, width: 303, height: 12 },
  tape: { inset: 28, width: 118, height: 170 },
  attitude: { width: 340, height: 230 },
  stallAlert: { width: 156, height: 30 },
  brakeAlert: { width: 106, height: 30, below: 42 },
  instrumentStrip: { inset: 28, height: 67 },
  controlStatus: { inset: 28, width: 290, height: 91 },
  hints: { height: 9 },
} as const;
/** Width of the instrument strip and of the hint text, by airframe: the trainer has no gear readout and a shorter brake hint. */
const STRIP_WIDTH: Record<AircraftKind, number> = { trainer: 334, jet: 416, bizjet: 416, airliner: 416 };
const HINTS_WIDTH: Record<AircraftKind, number> = { trainer: 718, jet: 805, bizjet: 805, airliner: 805 };

export interface HudBox {
  readonly name: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface CockpitLayout {
  /** The row nothing may cross: `--hud-deck-line`, margin included. */
  readonly deckLine: number;
  readonly boxes: readonly HudBox[];
}

function px(value: string | undefined, what: string): number | null {
  if (value === undefined) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (!match) throw new Error(`${what} is "${value}", which this model cannot place; update tests/support/cockpitHudModel.ts with it`);
  return Number(match[1]);
}

/** The cockpit HUD's boxes for a W x H window, deck slope `k`, airframe and HUD mode, from `rules`. */
export function cockpitHudLayout(
  rules: Rules,
  options: { width: number; height: number; k: number; aircraft: AircraftKind; mode: Exclude<HudMode, "off">; alerts: boolean },
): CockpitLayout {
  const { width: W, height: H, k, aircraft, mode, alerts } = options;
  const cockpit = (selector: string) => rules.get(`.flight-hud--cockpit${selector ? ` ${selector}` : ""}`);
  const base = (selector: string) => rules.get(selector) ?? {};

  const deckRule = cockpit("")?.["--hud-deck-line"];
  const deckMatch = deckRule === undefined ? null : /^calc\(50% \+ 50vw \* var\(--deck-k\) - (\d+)px\)$/.exec(deckRule);
  if (!deckMatch) throw new Error(`.flight-hud--cockpit --hud-deck-line is "${deckRule}", not the rule this model reads`);
  const deckLine = H / 2 + (W / 2) * k - Number(deckMatch[1]);

  const boxes: HudBox[] = [];
  const box = (name: string, x0: number, y0: number, w: number, h: number) =>
    boxes.push({ name, x0, y0, x1: x0 + w, y1: y0 + h });

  const s = HUD_SIZES;
  box("session line", s.sessionText.left, s.sessionText.top, s.sessionText.width, s.sessionText.height);

  if (mode === "full") {
    const tapeTop = cockpit(".metric-tape")?.top;
    let centre = H / 2;
    if (tapeTop === "min(50%, calc(var(--hud-deck-line) - 85px))") centre = Math.min(H / 2, deckLine - s.tape.height / 2);
    else if (tapeTop !== undefined) throw new Error(`.flight-hud--cockpit .metric-tape top "${tapeTop}" is not read by this model`);
    box("IAS tape", s.tape.inset, centre - s.tape.height / 2, s.tape.width, s.tape.height);
    box("AGL tape", W - s.tape.inset - s.tape.width, centre - s.tape.height / 2, s.tape.width, s.tape.height);
  }

  // The attitude box, less whatever the clip cuts off its bottom.
  const clip = cockpit(".attitude")?.["clip-path"];
  let cut = 0;
  if (clip === "inset(0 0 max(0px, calc(115px + 12px - 50vw * var(--deck-k))) 0)") cut = Math.max(0, 127 - (W / 2) * k);
  else if (clip !== undefined) throw new Error(`.flight-hud--cockpit .attitude clip-path "${clip}" is not read by this model`);
  box("attitude", W / 2 - s.attitude.width / 2, H / 2 - s.attitude.height / 2, s.attitude.width, s.attitude.height - cut);

  if (alerts) {
    box("STALL alert", W / 2 - s.stallAlert.width / 2, 0.22 * H, s.stallAlert.width, s.stallAlert.height);
    box("BRAKE alert", W / 2 - s.brakeAlert.width / 2, 0.22 * H + s.brakeAlert.below, s.brakeAlert.width, s.brakeAlert.height);
  }

  // The bottom group: the band's top edge in cockpit view, else the chase view's bottom edge.
  const bottomRule = cockpit(".flight-hud__bottom");
  const bandTop = bottomRule?.bottom === "auto" ? px(bottomRule.top, ".flight-hud--cockpit .flight-hud__bottom top") : null;
  const topAligned = bottomRule?.["align-items"] === "flex-start";
  const baseBottom = px(base(".flight-hud__bottom").bottom, ".flight-hud__bottom bottom")!;
  const tallest = mode === "full" ? Math.max(s.instrumentStrip.height, s.controlStatus.height) : s.controlStatus.height;
  const place = (height: number) => bandTop !== null
    ? bandTop + (topAligned ? 0 : tallest - height)
    : H - baseBottom - height;
  const statusRight = mode === "full" || cockpit(".control-status")?.["margin-left"] === "auto";
  if (mode === "full") {
    box("instrument strip", s.instrumentStrip.inset, place(s.instrumentStrip.height), STRIP_WIDTH[aircraft], s.instrumentStrip.height);
  }
  box(
    "ACTUAL panel",
    statusRight ? W - s.controlStatus.inset - s.controlStatus.width : s.controlStatus.inset,
    place(s.controlStatus.height), s.controlStatus.width, s.controlStatus.height,
  );

  // Key hints: under the session line in cockpit view, else the chase view's bottom line.
  const hintsRule = cockpit(".hud-help");
  const hintsTop = hintsRule?.bottom === "auto" ? px(hintsRule.top, ".flight-hud--cockpit .hud-help top") : null;
  const hintsY = hintsTop ?? H - px(base(".hud-help").bottom, ".hud-help bottom")! - s.hints.height;
  box("key hints", W / 2 - HINTS_WIDTH[aircraft] / 2, hintsY, HINTS_WIDTH[aircraft], s.hints.height);

  return { deckLine, boxes };
}
