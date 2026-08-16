import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { SettingsPanel } from "../src/ui/SettingsPanel";

describe("settings panel rendering preference", () => {
  it("presents all rendering modes and the browser fallback disclosure", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      settings: DEFAULT_SETTINGS,
      onChange: () => undefined,
    }));

    expect(markup).toContain("Rendering");
    expect(markup).toContain("Balanced");
    expect(markup).toContain("Hybrid (recommended)");
    expect(markup).toContain("Screen-space ray marching (experimental)");
    expect(markup).toContain("half-resolution screen-space ray marching");
    expect(markup).toContain("Browser WebGPU has no ray-query path");
    expect(markup).toContain("not hardware ray tracing");
    expect(markup).not.toContain(">Ray tracing (experimental)<");
    expect(markup).toContain('option value="hybrid" selected=""');
  });
});
