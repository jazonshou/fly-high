/**
 * PR B part 2 (G5): render-target refresh holds for the sun-shadow map (CSM)
 * and the cloud march's scene depth.
 *
 * Babylon's `RenderTargetTexture` already counts frames between renders
 * (`refreshRate`), and the scene skips a target whose count has not come
 * round. A held CSM keeps the cascade matrices it was drawn with, since
 * Babylon computes them only inside a render, so a receiver that reads them
 * at bind stays consistent with the map it samples. (The detail system's far
 * band copies them in an earlier pass, so on a redraw frame it reads the
 * previous draw's; at interval 1 it always did.) Nothing here allocates: the
 * same two targets render less often.
 */

/** What Babylon's RenderTargetTexture exposes for its refresh counter. */
export interface RefreshTarget {
  refreshRate: number;
  /** Frames counted since the last render, from 1; -1 when the next frame renders regardless. */
  readonly currentRefreshId: number;
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
 * Moves two holds on the same interval off each other's frames, and returns
 * whether it did. Both setters and every history invalidation reset the two
 * counters together, so without this they would draw on the same frames:
 * at tier 0 every other frame would carry both passes and the next neither,
 * and the saving would show in the mean frame but not in render()'s p95, the
 * late share or the frame-to-frame pacing. Called once a frame before the
 * scene renders; when both counters stand at the same count short of the
 * interval (neither draws this frame), the `follower` draws now, on a frame
 * that would otherwise carry neither, and from then on the two alternate.
 * That costs one extra follower pass each time they fall into step, which is
 * once per invalidation or interval change. Unequal intervals (a rung on one
 * hold only) are left alone: they meet only on common multiples.
 */
export function staggerRefresh(
  leader: RefreshTarget | null | undefined,
  follower: RefreshTarget | null | undefined,
): boolean {
  if (!leader || !follower) return false;
  const interval = follower.refreshRate;
  if (interval < 2 || leader.refreshRate !== interval) return false;
  const count = follower.currentRefreshId;
  if (count < 1 || count >= interval || leader.currentRefreshId !== count) return false;
  follower.resetRefreshCounter();
  return true;
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
