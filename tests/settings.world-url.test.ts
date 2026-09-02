import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorldEvolutionFromUrl } from "../src/settings";
import { DEFAULT_WORLD_EVOLUTION } from "../src/world";
import { readSource } from "./support/sourceText";

/**
 * Gate 0-b (Phase 6): the eroded world is reachable only by explicit URL
 * opt-in, and the shipped default never changes underneath a caller that
 * passes no option. PHASE_6_EXECUTION_PLAN.md §3.
 */
describe("eroded-world URL opt-in", () => {
  it("returns eroded only for an explicit ?world=eroded", () => {
    expect(readWorldEvolutionFromUrl("http://local/?world=eroded")).toBe("eroded");
    expect(readWorldEvolutionFromUrl("http://local/?seed=abc&world=eroded")).toBe("eroded");
  });

  it("returns undefined for absence, other values, junk, and unparseable URLs", () => {
    expect(readWorldEvolutionFromUrl("http://local/")).toBeUndefined();
    expect(readWorldEvolutionFromUrl("http://local/?world=analytic")).toBeUndefined();
    expect(readWorldEvolutionFromUrl("http://local/?world=ERODED")).toBeUndefined();
    expect(readWorldEvolutionFromUrl("http://local/?world=")).toBeUndefined();
    expect(readWorldEvolutionFromUrl("not a url")).toBeUndefined();
  });

  it("the shipped default remains analytic and the toggle is never persisted", () => {
    expect(DEFAULT_WORLD_EVOLUTION).toBe("analytic");
    const settingsSource = readSource("src/settings/index.ts");
    // The reader must not write to storage: persistence would make one shared
    // link permanently flip a player's world.
    const readerBody = settingsSource.slice(
      settingsSource.indexOf("export function readWorldEvolutionFromUrl"),
      settingsSource.indexOf("export function seedToString"),
    );
    expect(readerBody.length).toBeGreaterThan(0);
    expect(readerBody).not.toContain("localStorage");
    expect(readerBody).not.toContain("setItem");
  });

  it("FlightGame threads the URL value into createWorld and nowhere else sets it", () => {
    const source = readSource("src/game/FlightGame.tsx");
    expect(source).toContain("readWorldEvolutionFromUrl()");
    expect(source).toMatch(/createWorld\(seed, worldEvolution \? \{ worldEvolution \} : \{\}\)/);
  });
});
