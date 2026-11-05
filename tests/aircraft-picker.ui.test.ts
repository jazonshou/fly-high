import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIRCRAFT_CATALOGUE } from "../src/aircraft/catalogue";
import { AircraftPicker } from "../src/ui/AircraftPicker";
import { AIRCRAFT_KINDS } from "../src/sim";
import { SURFACE_VEHICLE_CATALOGUE } from "../src/vehicles/catalogue";
import { SURFACE_VEHICLE_KINDS, VEHICLE_KINDS, type VehicleKind } from "../src/vehicles/kinds";

function renderPicker(value: VehicleKind): string {
  return renderToStaticMarkup(createElement(AircraftPicker, {
    value,
    onChange: () => undefined,
  }));
}

describe("aircraft picker", () => {
  it("offers every airframe and boat in the catalogues as one native labelled radio group", () => {
    // Driven off the catalogues rather than a hand-written list, so adding an
    // aeroplane cannot leave the picker showing the old two while the rest of
    // the game flies three.
    const markup = renderPicker("trainer");
    const values = [...markup.matchAll(/<input[^>]*\bvalue="([^"]+)"[^>]*>/g)]
      .map((match) => match[1]);
    const labels = [...markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map((match) => match[1]);
    const count = VEHICLE_KINDS.length;

    expect(markup).toContain('<fieldset class="aircraft-picker">');
    expect(markup).toContain("<legend>Vehicle</legend>");
    expect(labels).toHaveLength(count);
    expect(labels.every((label) => /<input[^>]*type="radio"/.test(label ?? ""))).toBe(true);
    expect(markup.match(/type="radio"/g)).toHaveLength(count);
    expect(markup.match(/name="vehicle"/g)).toHaveLength(count);
    // The aeroplanes first, in catalogue order, then the boats.
    expect(values).toEqual([...AIRCRAFT_KINDS, ...SURFACE_VEHICLE_KINDS]);
    expect(markup.match(/class="aircraft-picker__surface"/g)).toHaveLength(SURFACE_VEHICLE_KINDS.length);
    for (const spec of [...AIRCRAFT_CATALOGUE, ...SURFACE_VEHICLE_CATALOGUE]) {
      expect(markup).toContain(spec.name);
      // The role is a TOOLTIP now, not rendered text — Jason asked for names
      // only on the face of the picker. This assertion passed unchanged when
      // the <small> became a title attribute, which is exactly the sort of
      // silent pass worth spelling out rather than leaving to look like proof
      // that the label is still on screen.
      expect(markup).toContain(`title="${spec.description}"`);
    }
    expect(markup).not.toMatch(/<small>/);
  });

  it("names the four aeroplanes and the boat the game actually ships", () => {
    // The one place the literal names are asserted: a catalogue-driven test
    // would happily pass on an empty catalogue or a renamed aeroplane.
    const markup = renderPicker("trainer");
    expect(markup).toContain("Cessna 150");
    expect(markup).toContain("F-16C Fighting Falcon");
    expect(markup).toContain("Bombardier Global 8000");
    expect(markup).toContain("Boeing 747-8");
    expect(markup).toContain("Runabout 21");
    // The fictional sport jet this replaced is gone, not hidden.
    expect(markup).not.toContain("Vesper");
  });

  it("reflects the controlled selection without producing a second checked radio", () => {
    const markup = renderPicker("jet");
    const inputs = [...markup.matchAll(/<input[^>]*>/g)].map((match) => match[0]);

    expect(inputs.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(inputs.find((input) => input.includes('value="trainer"'))).not.toContain('checked=""');
    expect(inputs.find((input) => input.includes('value="jet"'))).toContain('checked=""');

    const boat = renderPicker("speedboat");
    const boatInputs = [...boat.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
    expect(boatInputs.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(boatInputs.find((input) => input.includes('value="speedboat"'))).toContain('checked=""');
  });

  it("stays integrated with the minimal menu's start, runway, seed and settings controls", () => {
    const source = readFileSync(
      new URL("../src/game/FlightGame.tsx", import.meta.url),
      "utf8",
    );
    const menu = source.match(/phase === "menu" && ready[\s\S]*?phase === "paused"/)?.[0];

    expect(menu).toBeDefined();
    expect(menu).toContain("<AircraftPicker");
    expect(menu).toContain('className="primary-action start-screen__start"');
    expect(menu).toContain('className="seed-action"');
    // Icon-only now, with the word replaced by an accessible name and a
    // tooltip, so the class carries the modifier and the text does not exist.
    expect(menu).toContain('className="settings-action settings-action--icon"');
    expect(menu).toContain('aria-label="Settings"');
    expect(menu).toContain('title="Settings"');
    expect(menu).toContain("<span>Start</span>");
    // The second door, between Start and the seed as Jason placed it.
    expect(menu).toContain('className="primary-action start-screen__runway"');
    expect(menu).toContain("<span>Runway start</span>");
    expect(menu?.indexOf("start-screen__runway")).toBeGreaterThan(
      menu?.indexOf("start-screen__start") ?? 0,
    );
    expect(menu?.indexOf("start-screen__runway")).toBeLessThan(
      menu?.indexOf('className="seed-action"') ?? 0,
    );
    // The Land Cruiser's second door, in the same place: on foot beside it.
    expect(menu).toContain("onClick={() => void startSurfaceVehicle(true)}");
    expect(menu).toContain("<span>On foot</span>");
    // Two groups, so the row wraps as pairs: the seed and settings drop to a
    // second row TOGETHER and settings is never left on a row of its own.
    const actions = menu?.indexOf('className="start-screen__actions"') ?? -1;
    const starts = menu?.indexOf('className="start-screen__starts"') ?? -1;
    const utility = menu?.indexOf('className="start-screen__utility"') ?? -1;
    expect(actions).toBeGreaterThan(-1);
    expect(starts).toBeGreaterThan(actions);
    expect(utility).toBeGreaterThan(starts);
    expect(menu?.indexOf('className="primary-action start-screen__start"')).toBeGreaterThan(starts);
    expect(menu?.indexOf('className="primary-action start-screen__runway"')).toBeLessThan(utility);
    expect(menu?.indexOf('className="seed-action"')).toBeGreaterThan(utility);
    expect(menu?.indexOf('className="settings-action settings-action--icon"')).toBeGreaterThan(utility);
    expect(menu?.indexOf('className="settings-action settings-action--icon"')).toBeLessThan(
      menu?.indexOf('className="seed-action viewer-action"') ?? 0,
    );
    expect(menu).toContain("<small>Seed</small>");
    expect(menu).toContain("Generate a new world. Current seed");
    expect(menu).toContain('aria-controls="settings-dialog"');
    expect(menu?.match(/<AircraftPicker/g)).toHaveLength(1);
  });
});
