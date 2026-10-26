/**
 * Wall-clock budgets that follow the machine. Shared CI runners are slower
 * than the cloud sessions the sim's step budgets were tuned on (about 1.8x
 * for the sea twin), so a budget in that box's milliseconds is scaled by how
 * much slower this process runs a fixed piece of the same kind of work:
 * phasor rotations over Float64Arrays with a square root each. Time the
 * kernel around the measured runs, in the same process, so a busy runner
 * slows both.
 */

/** The kernel's best time on the tuning box (a cloud session's 2.1 GHz Xeon). */
export const REFERENCE_KERNEL_MILLISECONDS = 0.12;

/** One timing of the reference kernel, best of five. */
export function referenceKernelMilliseconds(): number {
  const count = 8192;
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  const weight = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    re[index] = Math.cos(index * 0.37);
    im[index] = Math.sin(index * 0.37);
    weight[index] = 1 + (index % 7) * 0.125;
  }
  let best = Number.POSITIVE_INFINITY;
  let sink = 0;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    for (let pass = 0; pass < 8; pass += 1) {
      const cosine = Math.cos(0.01 * (pass + 1));
      const sine = Math.sin(0.01 * (pass + 1));
      for (let index = 0; index < count; index += 1) {
        const a = re[index]!;
        const b = im[index]!;
        re[index] = a * cosine - b * sine;
        im[index] = a * sine + b * cosine;
        sink += Math.sqrt(a * a + b * b) * weight[index]!;
      }
    }
    best = Math.min(best, performance.now() - started);
  }
  if (!Number.isFinite(sink)) throw new Error("reference kernel diverged");
  return best;
}

/** Optimises the kernel before it is trusted as a yardstick. */
export function warmReferenceKernel(): void {
  for (let warm = 0; warm < 4; warm += 1) referenceKernelMilliseconds();
}

/**
 * How much slower than the tuning box this process ran the kernel: the
 * median of `timings` against the tuning box's time, never below 1, so a
 * faster machine keeps the tuning box's budget.
 */
export function referenceSlowdown(timings: readonly number[]): number {
  const sorted = [...timings].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(middle)]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.max(1, median / REFERENCE_KERNEL_MILLISECONDS);
}
