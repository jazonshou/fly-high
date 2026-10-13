/**
 * The statistics of the cloud A/B (`scripts/perf-ab.mts`). Pure functions, no
 * I/O, unit-tested in `tests/perf-ab-stats.test.ts`.
 *
 * THE DESIGN, AND WHY.
 *
 * - **Paired, interleaved, same machine.** Both arms run on one host, in a
 *   browser each, and take turns frame by frame (ABBA, then BAAB), so a host
 *   that slows down slows both arms, and a linear drift within a round
 *   cancels. A hosted runner's absolute speed varies by tens of per cent
 *   between machines; the ratio between two arms measured side by side does
 *   not.
 * - **The round is the unit, not the frame.** Consecutive frames of one arm
 *   share caches, clocks and whatever else the host is doing, so they are not
 *   independent samples, and treating 40 of them as 40 would make the test
 *   wildly overconfident. One round (two frames of each arm) gives ONE paired
 *   observation: the log of the ratio of the arms' totals.
 * - **Distribution-free.** Frame times are skewed and occasionally spiked (a
 *   GC, a page fault, a neighbour). The Wilcoxon signed-rank test and its
 *   Hodges–Lehmann estimate need no normality, are robust to those spikes,
 *   and are exact for the handful of rounds a CI budget allows: the null
 *   distribution is enumerated, not approximated, ties included.
 * - **A verdict needs both significance and size.** A 0.4% slowdown measured
 *   very precisely is not a regression anyone should be paged for, and a 30%
 *   one measured from three noisy rounds is not proof. So: SLOWER only when the
 *   Holm-adjusted p is below alpha AND the estimate is at least the
 *   practical threshold; SAME only when the whole confidence interval sits
 *   inside the threshold; INCONCLUSIVE otherwise, which says "run more
 *   rounds", not "pass".
 */

export type Verdict = "slower" | "faster" | "same" | "inconclusive";

export interface SignedRankResult {
  /** Rounds with a nonzero difference (zeros are dropped, as Wilcoxon's own test). */
  readonly n: number;
  /** Sum of the ranks of the positive differences. */
  readonly wPlus: number;
  /** Exact P(W+ >= observed) under the null: evidence the difference is positive. */
  readonly pGreater: number;
  /** Exact P(W+ <= observed) under the null: evidence the difference is negative. */
  readonly pLess: number;
}

/** Ranks of `values` (1-based), ties sharing their average rank. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let position = start; position <= end; position += 1) ranks[order[position]!.index] = rank;
    start = end + 1;
  }
  return ranks;
}

/**
 * Exact one-sided Wilcoxon signed-rank test of `differences` against zero.
 *
 * The null distribution is enumerated over the ACTUAL ranks (each rank's sign
 * is a fair coin), so it is exact with ties too: average ranks are multiples
 * of one half, and doubling them makes the sums integers a table can hold.
 */
export function wilcoxonSignedRank(differences: readonly number[]): SignedRankResult {
  const nonzero = differences.filter((value) => value !== 0 && Number.isFinite(value));
  const n = nonzero.length;
  if (n === 0) return { n, wPlus: 0, pGreater: 1, pLess: 1 };
  const ranks = averageRanks(nonzero.map(Math.abs));
  const doubled = ranks.map((rank) => Math.round(rank * 2));
  const total = doubled.reduce((sum, rank) => sum + rank, 0);
  // probability[s] = P(sum of doubled positive ranks = s) under the null.
  let probability = new Float64Array(total + 1);
  probability[0] = 1;
  let reach = 0;
  for (const rank of doubled) {
    const next = new Float64Array(total + 1);
    for (let sum = 0; sum <= reach; sum += 1) {
      const p = probability[sum]!;
      if (p === 0) continue;
      next[sum] = next[sum]! + p / 2;
      next[sum + rank] = next[sum + rank]! + p / 2;
    }
    probability = next;
    reach += rank;
  }
  const observed = nonzero.reduce((sum, value, index) => (value > 0 ? sum + doubled[index]! : sum), 0);
  let atLeast = 0;
  let atMost = 0;
  for (let sum = 0; sum <= total; sum += 1) {
    if (sum >= observed) atLeast += probability[sum]!;
    if (sum <= observed) atMost += probability[sum]!;
  }
  return { n, wPlus: observed / 2, pGreater: Math.min(1, atLeast), pLess: Math.min(1, atMost) };
}

/** Walsh averages (x_i + x_j) / 2 for i <= j, sorted ascending. */
export function walshAverages(values: readonly number[]): number[] {
  const averages: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i; j < values.length; j += 1) averages.push((values[i]! + values[j]!) / 2);
  }
  return averages.sort((a, b) => a - b);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The Hodges–Lehmann location estimate: the median of the Walsh averages. */
export function hodgesLehmann(values: readonly number[]): number {
  return median(walshAverages(values));
}

/** P(W+ <= w) for the no-ties signed-rank distribution of n, for w = 0..n(n+1)/2. */
export function signedRankCdf(n: number): Float64Array {
  const total = (n * (n + 1)) / 2;
  let probability = new Float64Array(total + 1);
  probability[0] = 1;
  for (let rank = 1; rank <= n; rank += 1) {
    const next = new Float64Array(total + 1);
    for (let sum = 0; sum <= total - rank; sum += 1) {
      const p = probability[sum]!;
      if (p === 0) continue;
      next[sum] = next[sum]! + p / 2;
      next[sum + rank] = next[sum + rank]! + p / 2;
    }
    probability = next;
  }
  const cdf = new Float64Array(total + 1);
  let running = 0;
  for (let sum = 0; sum <= total; sum += 1) {
    running += probability[sum]!;
    cdf[sum] = running;
  }
  return cdf;
}

/**
 * The distribution-free confidence interval for the Hodges–Lehmann estimate:
 * the k-th smallest and k-th largest Walsh averages, k the largest count whose
 * lower tail stays within (1 - confidence) / 2. Null when n is too small to
 * reach the confidence at all (n < 6 for 95%).
 */
export function hodgesLehmannInterval(
  values: readonly number[],
  confidence = 0.95,
): { readonly low: number; readonly high: number; readonly achieved: number } | null {
  const n = values.length;
  if (n === 0) return null;
  const tail = (1 - confidence) / 2;
  const cdf = signedRankCdf(n);
  // P(W+ <= k - 1) <= tail, k as large as possible: the interval drops k - 1
  // averages from each end.
  let k = 0;
  while (k < cdf.length && cdf[k]! <= tail) k += 1;
  if (k === 0) return null;
  const averages = walshAverages(values);
  const achieved = 1 - 2 * cdf[k - 1]!;
  return { low: averages[k - 1]!, high: averages[averages.length - k]!, achieved };
}

/** Holm's step-down adjustment; returns adjusted p-values in the input order. */
export function holmAdjust(pValues: readonly number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length).fill(1);
  let running = 0;
  order.forEach(({ p, index }, position) => {
    running = Math.max(running, Math.min(1, (pValues.length - position) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

export interface PairedComparison {
  readonly rounds: number;
  /** exp(Hodges–Lehmann of the per-round log ratios): head / base. */
  readonly ratio: number;
  /** The interval on the ratio; null when there are too few rounds for it. */
  readonly ratioLow: number | null;
  readonly ratioHigh: number | null;
  readonly intervalConfidence: number | null;
  /** Unadjusted one-sided p-values. */
  readonly pSlower: number;
  readonly pFaster: number;
  /** Median of each arm's per-round values, for the report. */
  readonly baseMedian: number;
  readonly headMedian: number;
}

/**
 * Compares per-round totals of the two arms: `base[r]` and `head[r]` must come
 * from the same round. Values must be positive (times).
 */
export function comparePaired(base: readonly number[], head: readonly number[], confidence = 0.95): PairedComparison {
  if (base.length !== head.length) throw new RangeError("perf-ab: the arms have different round counts");
  const logRatios = base.map((value, round) => {
    const other = head[round]!;
    if (!(value > 0) || !(other > 0)) throw new RangeError("perf-ab: a round total is not a positive time");
    return Math.log(other / value);
  });
  const test = wilcoxonSignedRank(logRatios);
  const interval = hodgesLehmannInterval(logRatios, confidence);
  return {
    rounds: logRatios.length,
    ratio: Math.exp(hodgesLehmann(logRatios)),
    ratioLow: interval ? Math.exp(interval.low) : null,
    ratioHigh: interval ? Math.exp(interval.high) : null,
    intervalConfidence: interval?.achieved ?? null,
    pSlower: test.pGreater,
    pFaster: test.pLess,
    baseMedian: median(base),
    headMedian: median(head),
  };
}

export interface VerdictInput {
  readonly comparison: PairedComparison;
  /** Holm-adjusted across every gated (shot, metric) of the run. */
  readonly pSlowerAdjusted: number;
  readonly pFasterAdjusted: number;
}

/**
 * The three-way verdict. `threshold` is the smallest change worth calling (a
 * fraction: 0.05 = 5%); it must sit above the A/A noise floor of the host, or
 * SAME becomes unreachable and every run reads INCONCLUSIVE.
 */
export function verdict(input: VerdictInput, threshold: number, alpha = 0.05): Verdict {
  const { comparison } = input;
  if (input.pSlowerAdjusted < alpha && comparison.ratio >= 1 + threshold) return "slower";
  if (input.pFasterAdjusted < alpha && comparison.ratio <= 1 - threshold) return "faster";
  if (
    comparison.ratioLow !== null
    && comparison.ratioHigh !== null
    && comparison.ratioLow > 1 - threshold
    && comparison.ratioHigh < 1 + threshold
  ) {
    return "same";
  }
  return "inconclusive";
}

/**
 * About how many rounds a run with no real change needs for its interval to
 * clear ±threshold, judged from an interval already measured on the same
 * host. The interval narrows with the square root of the rounds, and a
 * no-change estimate wanders about as far from 1 as the interval reaches, so
 * its half-width has to come down to half the threshold (on the tighter,
 * upper side). On rounds resampled from the macOS runner's first A/A, runs
 * of this length read SAME 93-98% of the time. Null without an interval.
 */
export function roundsToClear(comparison: PairedComparison, threshold: number): number | null {
  if (comparison.ratioLow === null || comparison.ratioHigh === null) return null;
  const halfWidth = (Math.log(comparison.ratioHigh) - Math.log(comparison.ratioLow)) / 2;
  const target = Math.log(1 + threshold) / 2;
  return Math.ceil(comparison.rounds * (halfWidth / target) ** 2);
}

/**
 * The run order of one round's four frames. ABBA then BAAB, alternating: each
 * arm's mean position in time is the round's midpoint either way, so a drift
 * that is linear across a round cancels, and alternating the lead stops either
 * arm always following the other (one arm's frame can leave caches, the queue
 * or the clock in a state the next frame inherits).
 */
export function roundOrder(round: number): readonly ("base" | "head")[] {
  return round % 2 === 0 ? ["base", "head", "head", "base"] : ["head", "base", "base", "head"];
}

/** Geometric mean of ratios: the run-level "how much slower on average". */
export function geometricMean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

/**
 * One of `count` parts of a run, for as many parallel jobs: every count-th
 * item from the `index`-th (1-based), so the parts are disjoint, cover every
 * item, and differ in size by at most one. Each part decides its own verdicts,
 * so a part tests at `alpha / count` (`partAlpha`): by Bonferroni across the
 * parts, Holm within each, the parts together still call a false slowdown at
 * most alpha of the time, under any dependence between them.
 */
export function partOf<T>(items: readonly T[], index: number, count: number): T[] {
  if (!(Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count)) {
    throw new RangeError(`perf-ab: part ${index} of ${count} does not exist`);
  }
  return items.filter((_, position) => position % count === index - 1);
}

/** The alpha one of `count` parts tests at; see `partOf`. */
export function partAlpha(alpha: number, count: number): number {
  return alpha / count;
}
