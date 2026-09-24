import { COCKPIT_HORIZONTAL_FOV_DEGREES, COCKPIT_LENS_HELD_ASPECT } from "@/src/render/cameraPresentation";

/**
 * The 2D HUD's layout in cockpit view. `Hud` sets the class and `--deck-k`;
 * src/game/flight.css (`.flight-hud--cockpit`) does the placing, with these same
 * numbers, which tests/ui.hud-cockpit-layout.test.ts holds the stylesheet to.
 *
 * THE RULE: in cockpit view nothing of the HUD draws below the DECK LINE, the row
 * where the airframe's glareshield, panel, screens and bezels begin, less a margin.
 * The cockpit lens is horizontal-fixed up to 16:9 and holds its 16:9 vertical field
 * on wider windows (`cockpitHorizontalFieldOfViewForAspect`), so on a window W x H
 * that row is
 *
 *   H / 2 + min(W / 2, H * 8 / 9) * k,   k = tan(cockpitDeckLineDegrees) / tan(lens / 2)
 *
 * on every window shape — in CSS, `calc(50% + min(50vw, 88.889vh) * k)` — which is
 * why the rule needs no script to follow a resize. Measured, and the layout chosen,
 * in docs/findings/COCKPIT_HUD_LAYOUT_2026_09_23.md.
 */
export const COCKPIT_HUD_DECK_MARGIN_PX = 12;
/** The chase view's bottom group (instrument strip, ACTUAL panel) sits here in cockpit view. */
export const COCKPIT_HUD_TOP_BAND_PX = 60;
/** The key-hint line, always shown in cockpit view, under the session line. */
export const COCKPIT_HUD_HINTS_TOP_PX = 42;
/** The diagnostics overlay, below the ACTUAL panel in the top band. */
export const COCKPIT_HUD_DIAGNOSTICS_TOP_PX = 163;

/** The deck line's slope against the window's half-width, for this airframe's deck. */
export function cockpitDeckK(
  deckLineDegrees: number,
  lensDegrees: number = COCKPIT_HORIZONTAL_FOV_DEGREES,
): number {
  return Math.tan((deckLineDegrees * Math.PI) / 180) / Math.tan((lensDegrees * Math.PI) / 360);
}

/**
 * The stylesheet's cap on the half-width term, in vh: the half-width of a window
 * of the lens's held aspect and this height, 50vh * 16 / 9, to three decimals.
 */
export const COCKPIT_HUD_HELD_HALF_WIDTH_VH = Number((50 * COCKPIT_LENS_HELD_ASPECT).toFixed(3));

/** The row the stylesheet's `--hud-deck-line` computes for a W x H window, margin included. */
export function cockpitDeckLineY(width: number, height: number, k: number): number {
  const halfWidth = Math.min(width / 2, (height * COCKPIT_HUD_HELD_HALF_WIDTH_VH) / 100);
  return height / 2 + halfWidth * k - COCKPIT_HUD_DECK_MARGIN_PX;
}

/** `--deck-k` as `Hud` writes it: four decimals, so the markup is stable. */
export function cockpitDeckKStyleValue(deckLineDegrees: number): string {
  return cockpitDeckK(deckLineDegrees).toFixed(4);
}
