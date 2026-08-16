import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { SettingsDialog, SettingsPanel } from "../src/ui/SettingsPanel";

describe("settings panel rendering preference", () => {
  it("presents the WebGPU compute-quality profiles", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      settings: DEFAULT_SETTINGS,
      onChange: () => undefined,
    }));

    expect(markup).toContain("Rendering");
    expect(markup).toContain("WebGPU Performance");
    expect(markup).toContain("WebGPU Balanced (recommended)");
    expect(markup).toContain("WebGPU Ultra");
    expect(markup).toContain("compute simulation resolution");
    expect(markup).toContain("volumetric sampling");
    expect(markup).not.toContain("WebGL");
    expect(markup).toContain('option value="balanced" selected=""');
  });

  it("wraps settings in a labelled modal with an explicit close control", () => {
    const markup = renderToStaticMarkup(createElement(SettingsDialog, {
      settings: DEFAULT_SETTINGS,
      onChange: () => undefined,
      onClose: () => undefined,
    }));

    expect(markup).toContain('id="settings-dialog"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="settings-title"');
    expect(markup).toContain('aria-describedby="settings-description"');
    expect(markup).toContain('aria-label="Close settings"');
    expect(markup).toContain("Minimum clearance");
    expect(markup).toContain("safe recovery above a crash location");
  });

  it("traps focus, restores the invoking control, and isolates flight shortcuts", () => {
    const source = readFileSync(
      new URL("../src/ui/SettingsPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("closeRef.current?.focus()");
    expect(source).toContain("previouslyFocused.focus()");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("event.stopPropagation()");
    expect(source).toContain("last.focus()");
    expect(source).toContain("first.focus()");
  });
});
