import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AircraftPicker } from "../src/ui/AircraftPicker";

function renderPicker(value: "trainer" | "jet"): string {
  return renderToStaticMarkup(createElement(AircraftPicker, {
    value,
    onChange: () => undefined,
  }));
}

describe("aircraft picker", () => {
  it("exposes exactly the trainer and jet as a native labelled radio group", () => {
    const markup = renderPicker("trainer");
    const values = [...markup.matchAll(/<input[^>]*\bvalue="([^"]+)"[^>]*>/g)]
      .map((match) => match[1]);
    const labels = [...markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map((match) => match[1]);

    expect(markup).toContain('<fieldset class="aircraft-picker">');
    expect(markup).toContain("<legend>Aircraft</legend>");
    expect(labels).toHaveLength(2);
    expect(labels.every((label) => /<input[^>]*type="radio"/.test(label ?? ""))).toBe(true);
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup.match(/name="aircraft"/g)).toHaveLength(2);
    expect(values).toEqual(["trainer", "jet"]);
    expect(markup).toContain("Aster T-20");
    expect(markup).toContain("Vesper J-45");
    expect(markup).toContain("Trainer");
    expect(markup).toContain("Fast jet");
  });

  it("reflects the controlled selection without producing a second checked radio", () => {
    const markup = renderPicker("jet");
    const inputs = [...markup.matchAll(/<input[^>]*>/g)].map((match) => match[0]);

    expect(inputs.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(inputs.find((input) => input.includes('value="trainer"'))).not.toContain('checked=""');
    expect(inputs.find((input) => input.includes('value="jet"'))).toContain('checked=""');
  });

  it("stays integrated with the minimal menu's start, seed, and settings controls", () => {
    const source = readFileSync(
      new URL("../src/game/FlightGame.tsx", import.meta.url),
      "utf8",
    );
    const menu = source.match(/phase === "menu" && ready[\s\S]*?phase === "paused"/)?.[0];

    expect(menu).toBeDefined();
    expect(menu).toContain("<AircraftPicker");
    expect(menu).toContain('className="primary-action start-screen__start"');
    expect(menu).toContain('className="seed-action"');
    expect(menu).toContain('className="settings-action"');
    expect(menu).toContain("<span>Start</span>");
    expect(menu).toContain("<small>Seed</small>");
    expect(menu).toContain("Generate a new world. Current seed");
    expect(menu).toContain('aria-controls="settings-dialog"');
    expect(menu?.match(/<AircraftPicker/g)).toHaveLength(1);
  });
});
