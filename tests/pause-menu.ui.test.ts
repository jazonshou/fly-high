import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/game/FlightGame.tsx", import.meta.url), "utf8");
const pauseMenu = source.match(
  /\{phase === "paused" \? \([\s\S]*?\) : null\}\n\n      \{settingsOpen \?/u,
)?.[0] ?? "";

describe("pause menu contract", () => {
  it("retains exactly three flight actions and exposes settings separately", () => {
    expect(pauseMenu).not.toBe("");
    const flightActions = pauseMenu.match(
      /<div className="pause-panel__actions">[\s\S]*?<\/div>/u,
    )?.[0] ?? "";
    expect(flightActions.match(/<button\b/gu)).toHaveLength(3);
    expect(pauseMenu.match(/<button\b/gu)).toHaveLength(4);
    expect(pauseMenu).toContain("Resume flight");
    expect(pauseMenu).toContain("Restart flight");
    expect(pauseMenu).toContain("End flight");
    expect(pauseMenu).toContain('className="pause-panel__settings"');
    expect(pauseMenu).toContain('aria-haspopup="dialog"');
    expect(pauseMenu).toContain('aria-controls="settings-dialog"');
    expect(pauseMenu).not.toContain("Change camera");
    expect(pauseMenu).not.toContain("new world");
    expect(pauseMenu).not.toContain(">Restart airborne<");
    expect(pauseMenu).not.toContain(">Restart on runway<");
  });

  it("uses local airborne recovery only for a crash and otherwise preserves the original start", () => {
    const restart = source.match(
      /const restartFlight[\s\S]*?\n  \}, \[[^\]]+\]\);/u,
    )?.[0] ?? "";
    const end = source.match(/const endFlight[\s\S]*?\n  \}, \[[^\]]+\]\);/u)?.[0] ?? "";
    expect(restart).toContain("latestStateRef.current.crashed");
    expect(restart).toContain("startNewFlight(spawnRef.current)");
    expect(restart).toContain("restartAfterCrash(settingsRef.current.airborneStartAgl)");
    expect(restart).not.toContain('spawnRef.current = "airborne"');
    expect(end).toContain("returnToAttract");
    expect(end).toContain('updatePhase("menu")');
    expect(end).not.toContain("setSeed");
    expect(end).not.toContain("createRandomSeed");
    expect(end).not.toContain("chooseNewWorld");
  });

  it("routes the R shortcut through the same crash-aware restart", () => {
    const actions = source.match(/const handleActions[\s\S]*?\n  \);/u)?.[0] ?? "";
    expect(actions).toContain('action === "reset"');
    expect(actions).toContain("void restartFlight()");
    expect(actions).not.toContain("simulationRef.current?.reset(spawn");
    expect(actions).toContain("settingsOpenRef.current");
  });

  it("does not turn a paused replacement worker back into an attract flight", () => {
    expect(source).toContain('const initialAttractMode = initialPhase === "menu"');
    expect(source).toContain(
      'const initialSpawn = initialAttractMode ? "airborne" : spawnRef.current',
    );
    expect(source).toContain("input.resetForSpawn(\n        initialSpawn");
    expect(source).toContain("airborneGearForAircraft(activeSettings.aircraft)");
    expect(source).toContain("phaseRef.current !== \"paused\"");
    expect(source).not.toContain(
      'activeSettings.flightMode,\n        "airborne",\n        activeSettings.weather',
    );
  });
});
