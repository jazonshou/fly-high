import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type BoatVisualState } from "../src/game/types";
import type { UnitSystem } from "../src/settings";
import { BOAT_SHALLOW_WARNING_METERS, BOAT_SOUNDER_RANGE_METERS, formatBoatReading } from "../src/ui/BoatHud";
import { Hud } from "../src/ui/Hud";

/** The boat's panel (src/ui/BoatHud.tsx), rendered through the HUD a boat session mounts. */

const BOAT: BoatVisualState = {
  kind: "boat",
  speedThroughWater: 18,
  gear: "forward",
  lever: 0.9,
  steerAngle: 0,
  trim: 0.42,
  trimAngle: 0.1,
  tabPort: 0,
  tabStarboard: 0,
  depthUnderKeel: 12,
  propellerImmersion: 1,
  moored: false,
  ventilating: false,
  capsized: false,
  planing: 1,
  wettedLength: 3,
  transomImmersion: 0,
  sprayRoots: [],
  sprayRootCount: 0,
};

function renderBoatHud(boat: Partial<BoatVisualState> = {}, units: UnitSystem = "aviation", crashed = false): string {
  return renderToStaticMarkup(createElement(Hud, {
    state: { ...INITIAL_VISUAL_STATE, heading: 271, engineRpm: 5_180, crashed, vehicle: { ...BOAT, ...boat } },
    aircraft: "trainer",
    mode: "full",
    flightMode: "scenic",
    units,
    diagnostics: null,
    showDiagnostics: false,
    cameraMode: "chase",
    cameraLabel: "CHASE CAM",
    seedLabel: "AUD1T0",
    mouseFlight: false,
  }));
}

describe("the boat's panel", () => {
  it("reads speed through the water in knots for aviation units and km/h for metric", () => {
    expect(renderBoatHud()).toContain('aria-label="SPD: 35 KN"');
    expect(renderBoatHud({}, "metric")).toContain('aria-label="SPD: 65 KM/H"');
  });

  it("keeps a decimal while it matters, alongside and over a shoal", () => {
    expect(formatBoatReading(2.345)).toBe("2.3");
    expect(formatBoatReading(9.96)).toBe("9.9");
    expect(formatBoatReading(10.4)).toBe("10");
    expect(formatBoatReading(Number.NaN)).toBe("0.0");
    expect(formatBoatReading(-1)).toBe("0.0");
  });

  it("sounds the depth under the keel in feet or metres, and DEEP past the sounder's range", () => {
    expect(renderBoatHud({ depthUnderKeel: 3 })).toContain('aria-label="DEPTH: 9.8 FT"');
    expect(renderBoatHud({ depthUnderKeel: 3 }, "metric")).toContain('aria-label="DEPTH: 3.0 M"');
    expect(renderBoatHud({ depthUnderKeel: BOAT_SOUNDER_RANGE_METERS + 1 })).toContain('aria-label="DEPTH: DEEP "');
    expect(renderBoatHud({ depthUnderKeel: Number.POSITIVE_INFINITY })).toContain("DEEP");
  });

  it("shows the engine, gear, trim and tabs", () => {
    const markup = renderBoatHud({ gear: "reverse", tabPort: 0.5, tabStarboard: 0.5 });
    expect(markup).toContain(">5200<");
    expect(markup).toContain('aria-label="Gear reverse"');
    expect(markup).toContain(">R<");
    expect(markup).toContain(">42%<");
    expect(markup).toContain('aria-label="Tabs 50 percent"');
    expect(markup).toContain(">271<");
  });

  it("warns SHALLOW under 1.5 m, except made fast at the dock", () => {
    expect(renderBoatHud({ depthUnderKeel: BOAT_SHALLOW_WARNING_METERS - 0.1 })).toContain("SHALLOW");
    expect(renderBoatHud({ depthUnderKeel: BOAT_SHALLOW_WARNING_METERS + 0.1 })).not.toContain("SHALLOW");
    const moored = renderBoatHud({ depthUnderKeel: 1, moored: true, speedThroughWater: 0 });
    expect(moored).not.toContain("SHALLOW");
    expect(moored).toContain("MOORED");
  });

  it("says VENTILATING while the propeller draws air", () => {
    expect(renderBoatHud({ ventilating: true })).toContain("VENTILATING");
    expect(renderBoatHud()).not.toContain("VENTILATING");
  });

  it("shows CAPSIZED or damage alone: the other states describe a boat under way", () => {
    const capsized = renderBoatHud({ capsized: true, ventilating: true, depthUnderKeel: 1 });
    expect(capsized).toContain("CAPSIZED");
    expect(capsized).not.toContain("VENTILATING");
    expect(capsized).not.toContain("SHALLOW");
    const damaged = renderBoatHud({ ventilating: true }, "aviation", true);
    expect(damaged).toContain("BOAT DAMAGED");
    expect(damaged).not.toContain("CAPSIZED");
    expect(damaged).not.toContain("VENTILATING");
  });
});
