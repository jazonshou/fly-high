import { describe, expect, it } from "vitest";
import {
  averageRanks,
  comparePaired,
  geometricMean,
  hodgesLehmann,
  hodgesLehmannInterval,
  holmAdjust,
  roundOrder,
  roundsToClear,
  signedRankCdf,
  verdict,
  walshAverages,
  wilcoxonSignedRank,
} from "../scripts/perfAbStats.mts";

/** A small deterministic generator, so the power checks below never flake. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Normal deviates by Box-Muller from the generator above. */
function normal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

describe("perf-ab statistics", () => {
  it("shares a tied group's average rank", () => {
    expect(averageRanks([3, 1, 3, 2])).toEqual([3.5, 1, 3.5, 2]);
  });

  it("matches the exact signed-rank tail for small n", () => {
    // Every difference positive: only one of 2^5 sign patterns is as extreme.
    expect(wilcoxonSignedRank([1, 2, 3, 4, 5]).pGreater).toBeCloseTo(1 / 32, 12);
    // Rank 1 negative: W+ = 14, reached by {all} and {all but 1}.
    expect(wilcoxonSignedRank([-1, 2, 3, 4, 5]).pGreater).toBeCloseTo(2 / 32, 12);
    expect(wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8]).pGreater).toBeCloseTo(1 / 256, 12);
    expect(wilcoxonSignedRank([-1, -2, -3, -4, -5, -6, -7, -8]).pLess).toBeCloseTo(1 / 256, 12);
  });

  it("stays exact with tied magnitudes", () => {
    // Three equal magnitudes share rank 2; W+ = 4 from the two positives.
    // Sign patterns give W+ in {0, 2, 4, 6} with weights 1, 3, 3, 1.
    const result = wilcoxonSignedRank([1, 1, -1]);
    expect(result.wPlus).toBe(4);
    expect(result.pGreater).toBeCloseTo(4 / 8, 12);
    expect(result.pLess).toBeCloseTo(7 / 8, 12);
  });

  it("drops exact zeros and reports no evidence from nothing", () => {
    expect(wilcoxonSignedRank([0, 0, 0])).toEqual({ n: 0, wPlus: 0, pGreater: 1, pLess: 1 });
    expect(wilcoxonSignedRank([0, 1, 2, 3, 4, 5]).n).toBe(5);
  });

  it("estimates location as the median Walsh average", () => {
    expect(walshAverages([1, 2, 3])).toEqual([1, 1.5, 2, 2, 2.5, 3]);
    expect(hodgesLehmann([1, 2, 3])).toBe(2);
    // One wild round barely moves it (the 23rd of 45 Walsh averages, counted
    // by brute force); the mean is 12.1.
    expect(hodgesLehmann([1, 1.1, 0.9, 1, 1.05, 0.95, 1, 1.02, 101])).toBeCloseTo(1.01, 12);
  });

  it("builds the exact no-ties signed-rank CDF", () => {
    const cdf = signedRankCdf(6);
    expect(cdf[0]).toBeCloseTo(1 / 64, 12);
    expect(cdf[1]).toBeCloseTo(2 / 64, 12);
    expect(cdf[21]).toBeCloseTo(1, 12);
  });

  it("gives the distribution-free interval its exact coverage, or none when n cannot reach it", () => {
    expect(hodgesLehmannInterval([1, 2, 3, 4, 5])).toBeNull();
    // n = 6: k = 1, so the interval is the whole Walsh range at 1 - 2/64.
    const six = hodgesLehmannInterval([1, 2, 3, 4, 5, 6])!;
    expect(six.low).toBe(1);
    expect(six.high).toBe(6);
    expect(six.achieved).toBeCloseTo(1 - 2 / 64, 12);
    // n = 8: P(W+ <= 3) = 5/256 <= 0.025 < P(W+ <= 4) = 7/256, so k = 4.
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const eight = hodgesLehmannInterval(values)!;
    const averages = walshAverages(values);
    expect(eight.low).toBe(averages[3]);
    expect(eight.high).toBe(averages[averages.length - 4]);
    expect(eight.achieved).toBeCloseTo(1 - 10 / 256, 12);
  });

  it("adjusts by Holm's step-down rule, monotone, in input order", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmAdjust([0.5, 0.9])).toEqual([1, 1]);
  });

  it("compares per-round totals as a ratio", () => {
    const exact = comparePaired(new Array(8).fill(100), new Array(8).fill(110));
    expect(exact.ratio).toBeCloseTo(1.1, 12);
    expect(exact.ratioLow).toBeCloseTo(1.1, 12);
    expect(exact.ratioHigh).toBeCloseTo(1.1, 12);
    expect(exact.pSlower).toBeCloseTo(1 / 256, 12);
    expect(() => comparePaired([1, 2], [1])).toThrow(/round counts/u);
    expect(() => comparePaired([1, 0], [1, 1])).toThrow(/positive/u);
  });

  it("calls a change only when it is both significant and large enough", () => {
    const base = { rounds: 8, ratioLow: 1.08, ratioHigh: 1.12, intervalConfidence: 0.96, pSlower: 0.004, pFaster: 1, baseMedian: 1, headMedian: 1.1 };
    expect(verdict({ comparison: { ...base, ratio: 1.1 }, pSlowerAdjusted: 0.01, pFasterAdjusted: 1 }, 0.05)).toBe("slower");
    // Significant but small: not a regression worth calling, and not provably same.
    expect(verdict({ comparison: { ...base, ratio: 1.03, ratioLow: 1.01, ratioHigh: 1.06 }, pSlowerAdjusted: 0.01, pFasterAdjusted: 1 }, 0.05)).toBe("inconclusive");
    // The whole interval inside +-5%: provably the same.
    expect(verdict({ comparison: { ...base, ratio: 1.01, ratioLow: 0.98, ratioHigh: 1.04 }, pSlowerAdjusted: 0.3, pFasterAdjusted: 0.7 }, 0.05)).toBe("same");
    // Large but not significant after adjustment: run more rounds.
    expect(verdict({ comparison: { ...base, ratio: 1.2, ratioLow: 0.9, ratioHigh: 1.5 }, pSlowerAdjusted: 0.2, pFasterAdjusted: 1 }, 0.05)).toBe("inconclusive");
    expect(verdict({ comparison: { ...base, ratio: 0.9, ratioLow: 0.88, ratioHigh: 0.92 }, pSlowerAdjusted: 1, pFasterAdjusted: 0.01 }, 0.05)).toBe("faster");
  });

  it("alternates which arm leads each round, and balances each arm's time", () => {
    expect(roundOrder(0)).toEqual(["base", "head", "head", "base"]);
    expect(roundOrder(1)).toEqual(["head", "base", "base", "head"]);
    for (const round of [0, 1]) {
      const order = roundOrder(round);
      const position = (arm: string) => order.reduce((sum, name, index) => (name === arm ? sum + index : sum), 0);
      expect(position("base")).toBe(position("head"));
    }
  });

  it("detects a 10% slowdown through 3% round noise in 10 rounds, and holds A/A to its alpha", () => {
    // Power and false-positive rate of the gate as configured by default
    // (threshold 5%, alpha 0.05), on simulated rounds: lognormal noise with a
    // 3% sigma per arm, the scale an A/A on a busy runner shows.
    const random = lcg(20_261_012);
    const trial = (effect: number) => {
      const base: number[] = [];
      const head: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const host = Math.exp(0.1 * normal(random)); // shared by both arms
        base.push(1_000 * host * Math.exp(0.03 * normal(random)));
        head.push(1_000 * effect * host * Math.exp(0.03 * normal(random)));
      }
      const comparison = comparePaired(base, head);
      return verdict({ comparison, pSlowerAdjusted: comparison.pSlower, pFasterAdjusted: comparison.pFaster }, 0.05);
    };
    let detected = 0;
    let falseAlarms = 0;
    const trials = 400;
    for (let index = 0; index < trials; index += 1) {
      if (trial(1.1) === "slower") detected += 1;
      if (trial(1) === "slower") falseAlarms += 1;
    }
    expect(detected / trials).toBeGreaterThan(0.8);
    expect(falseAlarms / trials).toBeLessThan(0.05);
  });

  it("sizes a no-change run from a measured interval, and that many rounds then read SAME", () => {
    const measured = { ...comparePaired([1, 1], [1, 1]), rounds: 20, ratioLow: Math.exp(-0.1), ratioHigh: Math.exp(0.1) };
    // Half-width 0.1 against half of ln(1.05): 20 * (0.1 / 0.024395)^2 = 336.04.
    expect(roundsToClear(measured, 0.05)).toBe(337);
    expect(roundsToClear({ ...measured, ratioLow: null, ratioHigh: null }, 0.05)).toBeNull();

    // A 16-round pilot with no real change, round ratios scattered by 8%:
    // the median of its estimates, then no-change runs of that length.
    const random = lcg(20_261_013);
    const run = (rounds: number) => {
      const base: number[] = [];
      const head: number[] = [];
      for (let round = 0; round < rounds; round += 1) {
        base.push(1_000);
        head.push(1_000 * Math.exp(0.08 * normal(random)));
      }
      return comparePaired(base, head);
    };
    const estimates = Array.from({ length: 41 }, () => roundsToClear(run(16), 0.05)!).sort((a, b) => a - b);
    const rounds = estimates[20]!;
    expect(rounds).toBeGreaterThan(30);
    expect(rounds).toBeLessThan(70);
    let same = 0;
    const trials = 200;
    for (let trial = 0; trial < trials; trial += 1) {
      const comparison = run(rounds);
      if (verdict({ comparison, pSlowerAdjusted: comparison.pSlower, pFasterAdjusted: comparison.pFaster }, 0.05) === "same") same += 1;
    }
    expect(same / trials).toBeGreaterThan(0.85);
  });

  it("averages ratios geometrically", () => {
    expect(geometricMean([2, 0.5])).toBeCloseTo(1, 12);
    expect(geometricMean([1.1, 1.1, 1.1])).toBeCloseTo(1.1, 12);
  });
});
