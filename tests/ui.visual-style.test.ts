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
      ".primary-action",
      ".metric-tape",
      ".instrument-strip",
      ".control-status",
      ".diagnostics",
      ".pause-panel",
      ".setting-field select",
    ]) {
      expect(rule(selector)).toMatch(/border-radius:\s*(?:var\(--radius-|1[4-9]px|2\dpx)/);
    }

    expect(rule(".pause-panel")).toContain("backdrop-filter: blur(28px)");
    expect(rule(".aircraft-picker")).toContain("backdrop-filter: blur(22px)");
    expect(rule(".aircraft-picker")).toMatch(/background:\s*rgba\([^)]*,\s*0\.22\)/);
    expect(rule(".instrument-strip")).toContain("backdrop-filter: blur(16px)");
    expect(rule(".setting-field select")).not.toMatch(/background:\s*(?:#|rgb\([^)]*\)|rgba\([^)]*,\s*(?:0\.9|1)\))/);
  });

  it("retains visible keyboard focus and non-blur/high-contrast fallbacks", () => {
    expect(flightStyles).toContain(".aircraft-picker label:focus-within");
    expect(flightStyles).toContain(".primary-action:focus-visible");
    expect(flightStyles).toContain(".setting-field select:focus-visible");
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
  });
});
