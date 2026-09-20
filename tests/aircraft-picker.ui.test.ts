import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIRCRAFT_CATALOGUE } from "../src/aircraft/catalogue";
import { AircraftPicker } from "../src/ui/AircraftPicker";
import { AIRCRAFT_KINDS, type AircraftKind } from "../src/sim";

function renderPicker(value: AircraftKind): string {
  return renderToStaticMarkup(createElement(AircraftPicker, {
    value,
    onChange: () => undefined,
  }));
}

describe("aircraft picker", () => {
  it("offers every airframe in the catalogue as a native labelled radio group", () => {
    // Driven off the catalogue rather than a hand-written list, so adding an
    // aeroplane cannot leave the picker showing the old two while the rest of
    // the game flies three.
    const markup = renderPicker("trainer");
    const values = [...markup.matchAll(/<input[^>]*\bvalue="([^"]+)"[^>]*>/g)]
      .map((match) => match[1]);
    const labels = [...markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map((match) => match[1]);
    const count = AIRCRAFT_KINDS.length;

    expect(markup).toContain('<fieldset class="aircraft-picker">');
    expect(markup).toContain("<legend>Aircraft</legend>");
    expect(labels).toHaveLength(count);
    expect(labels.every((label) => /<input[^>]*type="radio"/.test(label ?? ""))).toBe(true);
    expect(markup.match(/type="radio"/g)).toHaveLength(count);
    expect(markup.match(/name="aircraft"/g)).toHaveLength(count);
    expect(values).toEqual([...AIRCRAFT_KINDS]);
    for (const spec of AIRCRAFT_CATALOGUE) {
      expect(markup).toContain(spec.name);
      expect(markup).toContain(spec.description);
    }
  });

  it("names the aeroplanes the game actually ships", () => {
    // The one place the literal names are asserted: a catalogue-driven test
    // would happily pass on an empty catalogue or a renamed aeroplane.
    const markup = renderPicker("trainer");
    expect(markup).toContain("Cessna 150");
    expect(markup).toContain("Vesper J-45");
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
