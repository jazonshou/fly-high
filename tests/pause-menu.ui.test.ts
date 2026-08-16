import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/game/FlightGame.tsx", import.meta.url), "utf8");
const pauseMenu = source.match(/phase === "paused"[\s\S]*?\{error \?/u)?.[0] ?? "";

describe("pause menu contract", () => {
  it("contains exactly resume, same-session restart, and end-flight actions", () => {
    expect(pauseMenu).not.toBe("");
    expect(pauseMenu.match(/<button\b/gu)).toHaveLength(3);
    expect(pauseMenu).toContain("Resume flight");
    expect(pauseMenu).toContain("Restart flight");
    expect(pauseMenu).toContain("End flight");
    expect(pauseMenu).not.toContain("Change camera");
    expect(pauseMenu).not.toContain("Settings & controls");
    expect(pauseMenu).not.toContain("new world");
    expect(pauseMenu).not.toContain("Restart airborne");
    expect(pauseMenu).not.toContain("Restart on runway");
  });

  it("restarts from the original spawn ref and ends without replacing the seed", () => {
    const restart = source.match(/const restartFlight[\s\S]*?\}, \[startNewFlight\]\);/u)?.[0] ?? "";
    const end = source.match(/const endFlight[\s\S]*?\}, \[updatePhase\]\);/u)?.[0] ?? "";
    expect(restart).toContain("startNewFlight(spawnRef.current)");
    expect(end).toContain("returnToAttract");
    expect(end).toContain('updatePhase("menu")');
    expect(end).not.toContain("setSeed");
    expect(end).not.toContain("createRandomSeed");
    expect(end).not.toContain("chooseNewWorld");
  });
});
