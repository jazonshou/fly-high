/**
 * Z-2's hitch count over the diagnostics' rolling window of frame intervals
 * (PR B part 2b). Each interval is judged once, against the hitch threshold
 * in force when it was drawn, and keeps that verdict until it leaves the
 * window. The threshold follows the presentation cadence, and the governor's
 * even fallback now moves it by itself (27.4 ms at 60 fps, 60 ms at the
 * fallback's 30 on a 60 Hz display). Judging the whole window again against
 * the threshold of the moment showed every frame in it as a hitch when a 60
 * fps trial began, and hid the real hitches drawn at 60 when the fallback
 * engaged. The verdicts sit in a typed ring, so a drawn frame allocates
 * nothing.
 */
export class HitchWindow {
  private readonly verdicts: Uint8Array;
  /** Index of the oldest verdict in the ring. */
  private oldest = 0;
  private size = 0;
  private hitches = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`A hitch window holds at least one interval, not ${capacity}`);
    }
    this.verdicts = new Uint8Array(capacity);
  }

  /** The hitches among the intervals in the window. */
  get count(): number {
    return this.hitches;
  }

  /** Judge one interval against `thresholdMs`. When the window is full, the oldest verdict leaves. */
  push(intervalMs: number, thresholdMs: number): void {
    const verdict = intervalMs > thresholdMs ? 1 : 0;
    if (this.size === this.capacity) {
      this.hitches -= this.verdicts[this.oldest] ?? 0;
      this.verdicts[this.oldest] = verdict;
      this.oldest = (this.oldest + 1) % this.capacity;
    } else {
      this.verdicts[(this.oldest + this.size) % this.capacity] = verdict;
      this.size += 1;
    }
    this.hitches += verdict;
  }

  clear(): void {
    this.oldest = 0;
    this.size = 0;
    this.hitches = 0;
  }
}
