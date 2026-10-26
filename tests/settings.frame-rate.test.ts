import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FRAME_RATE_SETTINGS,
  LEGACY_SETTINGS_STORAGE_KEY,
  loadSettings,
  PREVIOUS_SETTINGS_STORAGE_KEY,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  validateSettings,
} from "../src/settings";

/**
 * PR B's "Frame rate" setting. The owner's default is "60 fps (smooth)" at
 * every tier. No storage key changes: a saved blob from before the field
 * existed loads with every preference it had, plus the default.
 */

function storageWith(key: string, value: unknown) {
  return { getItem: (name: string) => (name === key ? JSON.stringify(value) : null) };
}

describe("the frame-rate setting", () => {
  it("defaults to 60 fps", () => {
    expect(DEFAULT_SETTINGS.frameRate).toBe("60");
    expect(validateSettings({}).frameRate).toBe("60");
    expect(loadSettings({ getItem: () => null }).frameRate).toBe("60");
  });

  it("offers exactly three choices", () => {
    expect([...FRAME_RATE_SETTINGS]).toEqual(["60", "display", "30"]);
    for (const value of FRAME_RATE_SETTINGS) expect(validateSettings({ frameRate: value }).frameRate).toBe(value);
  });

  it("falls back to the default for anything else", () => {
    for (const value of ["120", 60, "uncapped", null, "", "Display"]) {
      expect(validateSettings({ frameRate: value }).frameRate).toBe("60");
    }
  });

  it("keeps a player's saved settings when the field is missing", () => {
    // A v3 blob as this build's predecessor saved it: every field but this one.
    const saved: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      quality: "high",
      renderingMode: "ultra",
      aircraft: "jet",
      masterVolume: 0.3,
      showDiagnostics: true,
    };
    delete saved.frameRate;
    const loaded = loadSettings(storageWith(SETTINGS_STORAGE_KEY, saved));
    expect(loaded).toEqual({ ...saved, frameRate: "60" });
  });

  it("gives the v2 and v1 migrations the default too", () => {
    const previous = loadSettings(storageWith(PREVIOUS_SETTINGS_STORAGE_KEY, { quality: "low", weather: "cloudy" }));
    expect(previous).toMatchObject({ quality: "low", weather: "cloudy", frameRate: "60" });
    const legacy = loadSettings(storageWith(LEGACY_SETTINGS_STORAGE_KEY, { quality: "high", flightMode: "scenic" }));
    expect(legacy).toMatchObject({ quality: "high", flightMode: "unassisted", frameRate: "60" });
  });

  it("round-trips each choice through storage", () => {
    for (const frameRate of FRAME_RATE_SETTINGS) {
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      };
      saveSettings({ ...DEFAULT_SETTINGS, frameRate }, storage);
      expect(JSON.parse(values.get(SETTINGS_STORAGE_KEY)!).frameRate).toBe(frameRate);
      expect(loadSettings(storage).frameRate).toBe(frameRate);
    }
  });
});
