import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const flightStyles = readFileSync(
  new URL("../src/game/flight.css", import.meta.url),
  "utf8",
);
const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = flightStyles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("flight interface visual system", () => {
  it("uses local aviation-oriented type stacks without downloading fonts", () => {
    expect(globalStyles).toContain('"DIN Alternate"');
    expect(globalStyles).toContain('"Bahnschrift SemiCondensed"');
    expect(globalStyles).toContain('"Cascadia Mono"');
    expect(globalStyles).not.toMatch(/@import\s+url|fonts\.(?:googleapis|gstatic)\.com/i);
  });

  it("rounds and translucently layers primary cockpit surfaces", () => {
    for (const selector of [
      ".aircraft-picker",
      ".seed-action",
      ".settings-action",
      ".primary-action",
      ".metric-tape",
      ".instrument-strip",
      ".control-status",
      ".diagnostics",
      ".pause-panel",
      ".settings-panel",
      ".setting-select__trigger",
    ]) {
      expect(rule(selector)).toMatch(/border-radius:\s*(?:var\(--radius-|1[4-9]px|2\dpx)/);
    }

    expect(rule(".pause-panel")).toContain("backdrop-filter: blur(28px)");
    expect(rule(".settings-panel")).toContain("backdrop-filter: blur(30px)");
    expect(rule(".aircraft-picker")).toContain("backdrop-filter: blur(22px)");
    expect(rule(".aircraft-picker")).toMatch(/background:\s*rgba\([^)]*,\s*0\.22\)/);
    expect(rule(".instrument-strip")).toContain("backdrop-filter: blur(16px)");
    expect(rule(".setting-select__trigger")).not.toMatch(/background:\s*(?:#|rgb\([^)]*\)|rgba\([^)]*,\s*(?:0\.9|1)\))/);
  });

  it("retains visible keyboard focus and non-blur/high-contrast fallbacks", () => {
    expect(flightStyles).toContain(".aircraft-picker label:focus-within");
    expect(flightStyles).toContain(".primary-action:focus-visible");
    expect(flightStyles).toContain(".settings-panel button:focus-visible");
    expect(flightStyles).toContain("@supports not");
    expect(flightStyles).toContain("@media (prefers-contrast: more)");
  });

  it("keeps the rounded translucent picker usable on narrow screens", () => {
    expect(flightStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.aircraft-picker\s*\{[^}]*border-radius:\s*20px;[^}]*background:\s*rgba\([^)]*,\s*0\.28\);/,
    );
    expect(flightStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.aircraft-picker label\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*border-radius:\s*16px;/,
    );
    expect(flightStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.settings-panel\s*\{[^}]*max-height:\s*calc\(100svh - 20px\);[^}]*border-radius:\s*25px;/,
    );
  });

  // Jason, on the start row: the two starts shrink until they cannot, THEN the
  // seed and settings drop below together with the seed stretching to the
  // settings square, and the square does not get smaller when it moves. The
  // state he photographed was settings alone on a second row with a shrunken
  // gear. Measured in a browser sweep from 1300 to 300px when this was written
  // (rows, equal start widths, 46px square, 23.8px gear, 10px seed-to-settings
  // gap, no slack right of settings); these pins guard the rules that make it
  // so, because a stylesheet test cannot lay anything out.
  it("wraps the start row by content, as two pairs, with a settings square that never shrinks", () => {
    const stripped = flightStyles.replace(/\/\*[\s\S]*?\*\//g, "");

    // A wrapping flex row of two groups: flex wraps one ITEM at a time, so
    // seed + settings must be a single item or settings can be orphaned.
    expect(rule(".start-screen__actions")).toMatch(/display:\s*flex;[\s\S]*flex-wrap:\s*wrap;/);
    expect(rule(".start-screen__utility")).toMatch(/display:\s*flex;/);
    // The pair's floor is two of the WIDER label (max-content of a 1fr 1fr
    // grid), which is what "until they can't any more" means; min-content
    // measured 167 + 179 and left Start narrower than Runway start.
    expect(rule(".start-screen__starts")).toMatch(/grid-template-columns:\s*1fr 1fr;/);
    expect(rule(".start-screen__starts")).toMatch(/min-width:\s*max-content;/);
    // Grow factors must sum to at least 1 on a line of one, or the wrapped
    // utility pair stops short of the right edge (0.68 left a third empty).
    const growOf = (selector: string) =>
      Number(rule(selector).match(/flex:\s*([\d.]+)\s/)?.[1] ?? Number.NaN);
    expect(growOf(".start-screen__starts")).toBeGreaterThanOrEqual(1);
    expect(growOf(".start-screen__utility")).toBeGreaterThanOrEqual(1);
    expect(rule(".start-screen__utility > .seed-action")).toMatch(/flex:\s*1 1 0;/);

    // One square, one size, everywhere.
    expect(rule(".start-screen__minimal")).toMatch(/--start-square:\s*46px;/);
    expect(rule(".settings-action--icon")).toMatch(/width:\s*var\(--start-square, 46px\);/);
    expect(rule(".settings-action--icon")).toMatch(/height:\s*var\(--start-square, 46px\);/);
    expect(rule(".settings-action--icon")).toMatch(/flex:\s*0 0 var\(--start-square, 46px\);/);

    // Nothing inside a media query may re-template the row, re-size the square
    // or pad it: each of those produced part of the photographed state. The
    // padding is the subtle one — a later `.settings-action { padding-inline }`
    // at equal specificity beat the icon's `padding: 0` and shrank the gear,
    // which is sized as a percentage of the content box, from 23.8 to 13px.
    const mediaBlocks = stripped.match(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? [];
    expect(mediaBlocks.length).toBeGreaterThan(3);
    for (const block of mediaBlocks) {
      expect(block).not.toMatch(/\.start-screen__minimal\s*\{[^}]*grid-template-columns/);
      expect(block).not.toMatch(/\.settings-action--icon\s*\{/);
      expect(block).not.toMatch(/\.settings-action\s*\{[^}]*padding/);
    }
  });

  // Jason: when the window shrinks horizontally the plane selection boxes
  // should not increase in height. They did, from 35 to 54px at 820px, because
  // of a `min-height` left over from when each label had a second line; the
  // Start buttons grew 48 -> 50px the same way. Measured flat across 501 widths
  // (1300 to 300px) when this was written; pinned here as "no media block may
  // give either a min-height", since that is the only way it can come back.
  it("never makes the picker's boxes or the start buttons taller as the window narrows", () => {
    const stripped = flightStyles.replace(/\/\*[\s\S]*?\*\//g, "");
    const mediaBlocks = stripped.match(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? [];
    expect(mediaBlocks.length).toBeGreaterThan(3);
    for (const block of mediaBlocks) {
      expect(block).not.toMatch(/\.aircraft-picker label\s*\{[^}]*min-height/);
      expect(block).not.toMatch(/\.aircraft-picker label\s*\{[^}]*padding-(?:block|top|bottom)/);
    }
    // The 820px block raises every `.primary-action` to 50px for the pause
    // menu; the start row opts out with a two-class rule that outranks it.
    expect(rule(".start-screen__starts > .primary-action")).toMatch(/min-height:\s*46px;/);
    // And the narrow rule must not pad the labels taller than the wide one.
    const wide = rule(".aircraft-picker label").match(/padding:\s*(\d+)px/)?.[1];
    const narrow = stripped
      .match(/@media \(max-width: 820px\)[\s\S]*?\.aircraft-picker label\s*\{([^}]*)\}/)?.[1]
      ?.match(/padding:\s*(\d+)px/)?.[1];
    expect(wide).toBeDefined();
    expect(Number(narrow)).toBeLessThanOrEqual(Number(wide));
  });
});
