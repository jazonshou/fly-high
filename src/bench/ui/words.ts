import { benchTier, describeDuration, isBenchTierIndex } from "../plan";

/**
 * The words and number formats the bench's pages share. Everything a person
 * reads on the intro, the run chip, the cards and the report is written for
 * someone who has never seen a frame time: plain words, short sentences.
 */

/** `readBenchFromUrl` takes at most this many tiers; the intro's Advanced field keeps to it. */
export const BENCH_TIER_LIST_MAX = 8;

/** "Medium"; "Tier 7" for a number the tier table does not have. */
export function tierName(tierIndex: number): string {
  return isBenchTierIndex(tierIndex) ? benchTier(tierIndex).name : `Tier ${tierIndex}`;
}

/** "Medium, Low, High, Medium". */
export function tierListText(tiers: readonly number[]): string {
  return tiers.map(tierName).join(", ");
}

/**
 * The Advanced field's tier list, read by `readBenchFromUrl`'s rule: 1 to 8
 * entries, each 0 to 3, separated by commas. Null when it breaks the rule, so
 * the intro never starts a run the URL reader would replace with the default.
 */
export function parseTierList(text: string): number[] | null {
  const names = text.split(",").map((name) => name.trim());
  if (names.length > BENCH_TIER_LIST_MAX || !names.every((name) => /^[0-3]$/.test(name))) return null;
  return names.map(Number);
}

/** "0:34", "1:15". */
export function clockText(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** "58 fps", or a dash when there is no number. */
export function fpsText(fps: number | null | undefined): string {
  return fps === null || fps === undefined || !Number.isFinite(fps) ? "–" : `${Math.round(fps)} fps`;
}

/** "0.4", or a dash: slow frames per 240 and the like. */
export function decimalText(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits);
}

/** "about 4 minutes left", "under a minute left". */
export function remainingText(seconds: number): string {
  return `${describeDuration(seconds)} left`;
}

/**
 * The intro's promise: "about 7 minutes (up to 9 minutes on a slow
 * computer)", from `estimateBenchDuration`'s typical and worst cases.
 */
export function durationText(typicalS: number, worstS: number): string {
  const typical = describeDuration(typicalS);
  const worstMinutes = Math.round(worstS / 60);
  return worstMinutes > 1 && worstMinutes > Math.round(typicalS / 60)
    ? `${typical} (up to ${worstMinutes} minutes on a slow computer)`
    : typical;
}

/** "flies itself once", "flies itself 4 times". */
export function flightCountText(count: number): string {
  return count === 1 ? "flies itself once" : `flies itself ${count} times`;
}
