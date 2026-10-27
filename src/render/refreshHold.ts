/**
 * PR B part 2 (G5): render-target refresh holds for the sun-shadow map (CSM)
 * and the cloud march's scene depth.
 *
 * Babylon's `RenderTargetTexture` already counts frames between renders
 * (`refreshRate`), and the scene skips a target whose count has not come
 * round. A held CSM keeps the cascade matrices it was drawn with, since
 * Babylon computes them only inside a render, so every receiver stays
 * consistent with the map it samples. Nothing here allocates: the same two
 * targets render less often.
 */

/** What Babylon's RenderTargetTexture exposes for its refresh counter. */
export interface RefreshTarget {
  refreshRate: number;
  resetRefreshCounter(): void;
}

/**
 * Sets the interval only when it changes, and returns whether it did.
 * Babylon's setter resets the counter, so a per-frame write would render
 * every frame and the hold would silently do nothing (verify F3).
 */
export function syncRefreshInterval(target: RefreshTarget | null | undefined, frames: number): boolean {
  if (!target) return false;
  const next = Math.max(1, Math.floor(frames));
  if (target.refreshRate === next) return false;
  target.refreshRate = next;
  return true;
}

/** The held map is invalid (origin shift, cut, profile or atmosphere change): the next frame renders. */
export function forceRefresh(target: RefreshTarget | null | undefined): void {
  target?.resetRefreshCounter();
}

/**
 * The profile's interval, in frames at the tier's own target, as frames at
 * the presented cadence, so a slower cadence (the 30 fps setting) keeps the
 * refresh rate in Hz: 2 at 60 fps is 1 at 30. Exact when the cadence is the
 * tier's. A governed rung's extra frames are added AFTER this, never before:
 * rounding a sum would make the rungs vanish at 30 fps.
 */
export function refreshIntervalAtCadence(frames: number, tierTargetMs: number, presentationTargetMs: number): number {
  if (!(presentationTargetMs > tierTargetMs + 1e-9)) return frames;
  return Math.max(1, Math.round((frames * tierTargetMs) / presentationTargetMs));
}
