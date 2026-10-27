import { benchTierName, describeDuration } from "../plan";

/** "0.4", or a dash when there is no number. */
export { decimalText } from "../report";

/**
 * The words and number formats the bench's pages share. Everything a person
 * reads on the intro, the run chip, the cards and the report is written for
 * someone who has never seen a frame time: plain words, short sentences.
 */

/** "Medium"; "Tier 7" for a number the tier table does not have. */
export const tierName = benchTierName;

/** "Medium, Low, High, Medium". */
export function tierListText(tiers: readonly number[]): string {
  return tiers.map(tierName).join(", ");
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
