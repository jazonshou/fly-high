import { SETTINGS_STORAGE_KEY } from "@/src/settings";
import { fnv1aHex } from "./hash";

/**
 * The player's saved settings, hashed at the intro and again after every
 * step, so the report can show the bench never wrote them. Read-only: this
 * is the only file in src/bench that names `localStorage`, and it only ever
 * calls `getItem` on it.
 */

/** No settings saved: a player who never opened the settings panel. */
export const SETTINGS_KEY_ABSENT = "absent";
/** The storage threw: blocked site data. */
export const SETTINGS_KEY_UNREADABLE = "unreadable";

/** The read half of `Storage`, which is all the guard is given. */
export type SettingsReader = Pick<Storage, "getItem">;

/** The page's `localStorage` for reading, or null where the accessor throws or there is no window. */
export function settingsReader(): SettingsReader | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The settings key's FNV-1a hash, "absent" or "unreadable". */
export function hashSettingsKey(reader: SettingsReader | null = settingsReader()): string {
  if (reader === null) return SETTINGS_KEY_UNREADABLE;
  try {
    const text = reader.getItem(SETTINGS_STORAGE_KEY);
    return text === null ? SETTINGS_KEY_ABSENT : fnv1aHex(text);
  } catch {
    return SETTINGS_KEY_UNREADABLE;
  }
}
