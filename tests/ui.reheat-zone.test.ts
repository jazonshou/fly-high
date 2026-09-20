import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aircraftDefinition, AIRCRAFT_KINDS } from "../src/sim";

/**
 * The HUD's reheat marking must agree with the engine.
 *
 * A throttle bar that marks the afterburner in the wrong place is worse than
 * one that does not mark it at all: the pilot learns a gate that is not where
 * the thrust changes. The bar therefore reads `engageThrottle` off the flight
 * model rather than carrying its own copy, and this pins that.
 */
describe("afterburner HUD marking", () => {
  const source = readFileSync(new URL("../src/ui/Hud.tsx", import.meta.url), "utf8");

  it("takes the gate from the flight model, not from a second copy of the number", () => {
    expect(source).toContain('aircraftDefinition(aircraft).afterburner?.engageThrottle');
    // No hand-written 0.85 anywhere near the bar.
    expect(source).not.toMatch(/reheatGate\s*=\s*0?\.\d/);
  });

  it("draws the zone only for an airframe that has an afterburner", () => {
    expect(source).toContain("reheatGate === null ? null :");
  });

  it("agrees with exactly one airframe having reheat, and it is the fighter", () => {
    const withBurner = AIRCRAFT_KINDS.filter(
      (kind) => aircraftDefinition(kind).afterburner !== null,
    );
    expect(withBurner).toEqual(["jet"]);
    const burner = aircraftDefinition("jet").afterburner;
    expect(burner?.engageThrottle).toBe(0.85);
    // The zone is a usable fraction of the travel: too narrow to aim at would
    // make the marking decorative.
    expect(1 - (burner?.engageThrottle ?? 1)).toBeGreaterThanOrEqual(0.1);
  });

  it("styles the gate and the lit fill", () => {
    const css = readFileSync(new URL("../src/game/flight.css", import.meta.url), "utf8");
    expect(css).toContain(".control-status__reheat");
    expect(css).toContain("b.is-reheat");
    // The strip is positioned, so its parent must establish a containing block.
    expect(css).toContain(".control-status__meter > i { position: relative; }");
  });
});
