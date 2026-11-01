import { describe, expect, it } from "vitest";
import { DEFAULT_BENCH_TIERS, DEFAULT_SETTINGS, defaultBenchFrameRate, readBenchFromUrl } from "../src/settings";
import { readSource } from "./support/sourceText";

/**
 * `?bench=1` opens the in-game benchmark for one tab. Like `?world=` it is
 * read from the URL only: absence, or any other value, is the normal game,
 * and nothing about it is ever written to the settings.
 */
describe("benchmark URL request", () => {
  it("returns undefined unless bench is exactly 1", () => {
    expect(readBenchFromUrl("http://local/")).toBeUndefined();
    expect(readBenchFromUrl("http://local/?bench=0")).toBeUndefined();
    expect(readBenchFromUrl("http://local/?bench=")).toBeUndefined();
    expect(readBenchFromUrl("http://local/?bench=true")).toBeUndefined();
    expect(readBenchFromUrl("http://local/?bench=1x")).toBeUndefined();
    expect(readBenchFromUrl("http://local/?seed=abc&tiers=1")).toBeUndefined();
    expect(readBenchFromUrl("not a url")).toBeUndefined();
  });

  it("defaults to Medium, Low, High, Medium in shipped mode with the HUD on: the intro", () => {
    expect(readBenchFromUrl("http://local/?bench=1")).toEqual({
      tiers: [1, 0, 2, 1],
      mode: "shipped",
      hud: true,
      quick: false,
      frameRate: DEFAULT_SETTINGS.frameRate,
      run: null,
      step: null,
    });
    expect(DEFAULT_BENCH_TIERS).toEqual([1, 0, 2, 1]);
  });

  it("reads fps, defaulting to what players get in shipped mode and to every refresh in pinned mode", () => {
    expect(defaultBenchFrameRate("shipped")).toBe(DEFAULT_SETTINGS.frameRate);
    expect(defaultBenchFrameRate("pinned")).toBe("display");
    for (const value of ["60", "display", "30"] as const) {
      expect(readBenchFromUrl(`http://local/?bench=1&fps=${value}`)?.frameRate).toBe(value);
      expect(readBenchFromUrl(`http://local/?bench=1&mode=pinned&fps=${value}`)?.frameRate).toBe(value);
    }
    expect(readBenchFromUrl("http://local/?bench=1&mode=pinned")?.frameRate).toBe("display");
    for (const bad of ["", "120", "Display", "60fps", "match"]) {
      expect(readBenchFromUrl(`http://local/?bench=1&fps=${bad}`)?.frameRate, bad).toBe(DEFAULT_SETTINGS.frameRate);
      expect(readBenchFromUrl(`http://local/?bench=1&mode=pinned&fps=${bad}`)?.frameRate, bad).toBe("display");
    }
  });

  it("reads 1 to 8 tiers of 0-3 and falls back to the default for anything else", () => {
    expect(readBenchFromUrl("http://local/?bench=1&tiers=3")?.tiers).toEqual([3]);
    expect(readBenchFromUrl("http://local/?bench=1&tiers=0,1,2,3,3,2,1,0")?.tiers)
      .toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    expect(readBenchFromUrl("http://local/?bench=1&tiers=1,%200")?.tiers).toEqual([1, 0]);
    for (const bad of ["", "4", "-1", "1,,2", "1.5", "a", "0,1,2,3,3,2,1,0,1", "01"]) {
      expect(readBenchFromUrl(`http://local/?bench=1&tiers=${bad}`)?.tiers, bad).toEqual([1, 0, 2, 1]);
    }
  });

  it("validates mode, hud and quick", () => {
    expect(readBenchFromUrl("http://local/?bench=1&mode=pinned")?.mode).toBe("pinned");
    expect(readBenchFromUrl("http://local/?bench=1&mode=PINNED")?.mode).toBe("shipped");
    expect(readBenchFromUrl("http://local/?bench=1&mode=floor")?.mode).toBe("shipped");
    expect(readBenchFromUrl("http://local/?bench=1&hud=0")?.hud).toBe(false);
    expect(readBenchFromUrl("http://local/?bench=1&hud=off")?.hud).toBe(true);
    expect(readBenchFromUrl("http://local/?bench=1&quick=1")?.quick).toBe(true);
    expect(readBenchFromUrl("http://local/?bench=1&quick=yes")?.quick).toBe(false);
  });

  it("reads a run id and a step, and treats bad ones as the intro", () => {
    const step = readBenchFromUrl("http://local/?bench=1&run=abc123def&step=2&seed=00762m");
    expect(step?.run).toBe("abc123def");
    expect(step?.step).toBe(2);
    expect(readBenchFromUrl("http://local/?bench=1&run=abc123&step=report")?.step).toBe("report");
    expect(readBenchFromUrl("http://local/?bench=1&run=abc123&step=0")?.step).toBe(0);
    for (const bad of ["ABC123", "abc", "abc-123", "a".repeat(17), ""]) {
      expect(readBenchFromUrl(`http://local/?bench=1&run=${bad}&step=0`)?.run, bad).toBeNull();
    }
    for (const bad of ["-1", "1.5", "x", "", "100", "Report"]) {
      expect(readBenchFromUrl(`http://local/?bench=1&run=abc123&step=${bad}`)?.step, bad).toBeNull();
    }
  });

  it("is never persisted: the reader sits in the URL readers' no-storage slice", () => {
    const settingsSource = readSource("src/settings/index.ts");
    const start = settingsSource.indexOf("export function readLandformsFromUrl");
    const reader = settingsSource.indexOf("export function readBenchFromUrl");
    const end = settingsSource.indexOf("export function seedToString");
    expect(start).toBeGreaterThan(0);
    expect(reader).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(reader);
    const slice = settingsSource.slice(start, end);
    expect(slice).not.toContain("localStorage");
    expect(slice).not.toContain("sessionStorage");
    expect(slice).not.toContain("setItem");
  });
});
