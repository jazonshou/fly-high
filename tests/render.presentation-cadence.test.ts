import { describe, expect, it } from "vitest";
import {
  cadenceDisplayHz,
  cadenceFloorMs,
  fallbackDivisorFor,
  fallbackDivisorRange,
  PRESENTATION_HEADROOM_MS,
  sameCadence,
  type FrameRateCap,
  type PresentationCadence,
} from "../src/render/webgpu/core/presentationCadence";
import {
  hitchThresholdMilliseconds,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";

/**
 * The presentation cadence is the contract between the frame pacer and the
 * renderer (PR B). Its one rule: a slow machine can never relax its own
 * target. Only the 30 fps setting, or a divisor of 2 or more on a period
 * measured on idle ticks, raises the floor and the hitch threshold.
 */

function cadence(
  frameCapHz: FrameRateCap,
  divisor: number,
  hz: number | null,
  periodConfirmed: boolean,
  fallbackHz?: number,
): PresentationCadence {
  return {
    frameCapHz,
    divisor,
    displayPeriodMs: hz === null ? null : 1_000 / hz,
    periodConfirmed,
    ...(fallbackHz !== undefined ? { fallbackHz } : {}),
  };
}

const medium = resolveWebGpuQualityProfile("medium", "balanced");
const ultra = resolveWebGpuQualityProfile("high", "ultra");

describe("the cadence floor", () => {
  it("is zero without a cadence, so captures and perf:ab keep today's numbers", () => {
    expect(cadenceFloorMs(null)).toBe(0);
  });

  // Every case the design walks through (PR B §6.1, with the red team's amendments).
  const cases: readonly [string, PresentationCadence, number][] = [
    ["60 Hz at the 60 setting", cadence(60, 1, 60, true), 1_000 / 60],
    ["120 Hz paced to 60", cadence(60, 2, 120, true), 1_000 / 60],
    ["120 Hz, a slow machine with no probe", cadence(60, 1, 60, false), 0],
    ["144 Hz paced to 72", cadence(60, 2, 144, true), 2_000 / 144],
    ["165 Hz paced to 82.5", cadence(60, 2, 165, true), 2_000 / 165],
    ["240 Hz paced to 60", cadence(60, 4, 240, true), 1_000 / 60],
    ["144 Hz, Match display", cadence(null, 1, 144, true), 1_000 / 144],
    ["the 30 setting at 60 Hz", cadence(30, 2, 60, true), 1_000 / 30],
    ["the 30 setting at 60 Hz, unconfirmed", cadence(30, 2, 60, false), 1_000 / 30],
    ["the 30 setting at 120 Hz", cadence(30, 4, 120, true), 1_000 / 30],
    ["the 30 setting at 75 Hz", cadence(30, 3, 75, true), 40],
    ["the 30 setting at 165 Hz", cadence(30, 6, 165, true), 6_000 / 165],
    ["the 30 setting on a 50 Hz panel", cadence(30, 2, 50, true), 40],
    ["a confirmed 50 Hz panel", cadence(60, 1, 50, true), 0],
    ["a 50 Hz panel, unconfirmed", cadence(60, 1, 50, false), 0],
    ["a confirmed 30 Hz rAF (low-power throttle)", cadence(60, 1, 30, true), 0],
    ["Match display on a confirmed 50 Hz panel", cadence(null, 1, 50, true), 0],
    ["a slow machine on a 60 Hz panel, 'period' 33.3 ms, unconfirmed", cadence(60, 1, 30, false), 0],
    ["no period measured yet", cadence(60, 1, null, false), 0],
  ];
  for (const [name, input, floor] of cases) {
    it(`${name}: ${floor.toFixed(2)} ms`, () => {
      expect(cadenceFloorMs(input)).toBeCloseTo(floor, 9);
    });
  }

  it("never rises on an unconfirmed period, however slow", () => {
    for (const hz of [24, 30, 40, 50, 57, 60, 120, 240]) {
      for (const divisor of [1, 2, 4]) {
        expect(cadenceFloorMs(cadence(60, divisor, hz, false))).toBe(0);
        expect(cadenceFloorMs(cadence(null, divisor, hz, false))).toBe(0);
      }
    }
  });
});

describe("the hitch threshold", () => {
  // [cadence, Low-High, Ultra] (PR B §1.2, amended: slow confirmed displays read 27.4).
  const table: readonly [string, PresentationCadence | null, number, number][] = [
    ["no cadence (captures, perf:ab)", null, 27.4, 60],
    ["the 60 setting at 60 Hz", cadence(60, 1, 60, true), 27.4, 60],
    ["the 60 setting at 120 Hz", cadence(60, 2, 120, true), 27.4, 60],
    ["the 60 setting at 144 Hz", cadence(60, 2, 144, true), 27.4, 60],
    ["the 60 setting at 165 Hz", cadence(60, 2, 165, true), 27.4, 60],
    ["the 60 setting at 240 Hz", cadence(60, 4, 240, true), 27.4, 60],
    ["Match display at 144 Hz", cadence(null, 1, 144, true), 27.4, 60],
    ["Match display at 60 Hz", cadence(null, 1, 60, false), 27.4, 60],
    ["the 30 setting at 60 Hz", cadence(30, 2, 60, true), 60, 60],
    ["the 30 setting at 120 Hz", cadence(30, 4, 120, true), 60, 60],
    ["the 30 setting at 75 Hz (N 3, 40 ms)", cadence(30, 3, 75, true), 2 * (40 - 10 / 3), 2 * (40 - 10 / 3)],
    ["the 30 setting at 165 Hz (N 6)", cadence(30, 6, 165, true), 2 * (6_000 / 165 - 10 / 3), 2 * (6_000 / 165 - 10 / 3)],
    ["a confirmed 50 Hz panel", cadence(60, 1, 50, true), 27.4, 60],
    ["a 50 Hz panel, unconfirmed", cadence(60, 1, 50, false), 27.4, 60],
    ["a confirmed 30 Hz rAF", cadence(60, 1, 30, true), 27.4, 60],
    ["a slow machine's unconfirmed 33.3 ms", cadence(60, 1, 30, false), 27.4, 60],
  ];
  for (const [name, input, tiered, onUltra] of table) {
    it(`${name}: ${tiered.toFixed(1)} ms, ${onUltra.toFixed(1)} on Ultra`, () => {
      expect(hitchThresholdMilliseconds(medium, input)).toBeCloseTo(tiered, 9);
      expect(hitchThresholdMilliseconds(ultra, input)).toBeCloseTo(onUltra, 9);
    });
  }

  it("keeps today's exact value without a cadence", () => {
    expect(ultra.frameTargetMs).toBe(30);
    expect(hitchThresholdMilliseconds(medium)).toBe(medium.frameTargetMs * 2);
    expect(hitchThresholdMilliseconds(medium, null)).toBe(medium.frameTargetMs * 2);
    expect(hitchThresholdMilliseconds(ultra, null)).toBe(60);
  });

  it("keeps Ultra's own headroom: 1000/30 minus 30", () => {
    expect(PRESENTATION_HEADROOM_MS).toBeCloseTo(1_000 / 30 - 30, 12);
  });
});

describe("the cadence identity", () => {
  it("is the cap, the divisor, the nominal rate and the confirmation", () => {
    const base = cadence(60, 2, 120, true);
    expect(sameCadence(base, { ...base })).toBe(true);
    expect(sameCadence(null, null)).toBe(true);
    expect(sameCadence(base, null)).toBe(false);
    expect(sameCadence(null, base)).toBe(false);
    expect(sameCadence(base, { ...base, frameCapHz: 30 })).toBe(false);
    expect(sameCadence(base, { ...base, divisor: 1 })).toBe(false);
    expect(sameCadence(base, cadence(60, 2, 144, true))).toBe(false);
    expect(sameCadence(base, { ...base, periodConfirmed: false })).toBe(false);
  });

  it("tells the governor's fallback rate from its absence (PR B part 2b, G6)", () => {
    const sixty = cadence(60, 1, 60, true);
    const fallingBack = cadence(60, 2, 60, true, 30);
    expect(sameCadence(fallingBack, cadence(60, 2, 60, true, 30))).toBe(true);
    expect(sameCadence(fallingBack, cadence(60, 2, 60, true))).toBe(false);
    expect(sameCadence(cadence(60, 2, 60, true), fallingBack)).toBe(false);
    expect(sameCadence(fallingBack, cadence(60, 2, 60, true, 25))).toBe(false);
    // A cadence without a fallback omits the field, so part 1's literals still deep-equal.
    expect(Object.keys(sixty)).not.toContain("fallbackHz");
    expect(sixty).toEqual({ frameCapHz: 60, divisor: 1, displayPeriodMs: 1_000 / 60, periodConfirmed: true });
  });

  it("reads the nominal display rate back from the period", () => {
    expect(cadenceDisplayHz(cadence(60, 2, 120, true))).toBeCloseTo(120, 9);
    expect(cadenceDisplayHz(cadence(60, 1, null, false))).toBeNull();
    expect(cadenceDisplayHz(null)).toBeNull();
  });
});

/**
 * PR B part 2b (G6): the even fallback's divisors, design §21.5's table.
 * [refresh Hz, the 60 setting's divisor, range or null, divisor for a host
 * whose mean fits the faster neighbour, divisor for one whose mean does not].
 */
const FALLBACK_TABLE: readonly [number, number, readonly [number, number] | null, number | null, number | null][] = [
  [60, 1, [2, 2], 2, 2],
  [75, 1, [2, 3], 2, 3],
  [90, 1, [3, 3], 3, 3],
  [100, 1, [3, 3], 3, 3],
  [120, 2, [4, 4], 4, 4],
  [144, 2, [4, 5], 4, 5],
  [165, 2, [5, 6], 5, 6],
  [240, 4, [8, 8], 8, 8],
  // The range exists; the governor's gate refuses the untrusted period.
  [50, 1, [2, 2], 2, 2],
  [30, 1, null, null, null],
];

describe("the even fallback's divisor (PR B part 2b, G6)", () => {
  for (const [hz, paced, range, fits, doesNot] of FALLBACK_TABLE) {
    it(`${hz} Hz: ${range === null ? "none" : `[${range[0]}, ${range[1]}]`}`, () => {
      const found = fallbackDivisorRange(hz, 30, paced);
      expect(found).toEqual(range);
      if (found === null) return;
      expect(Object.isFrozen(found)).toBe(true);
      const periodMs = 1_000 / hz;
      // A mean that fits the faster neighbour's interval exactly, and one 1 ms over it.
      const fasterMs = found[0] * periodMs;
      expect(fallbackDivisorFor(found, periodMs, fasterMs)).toBe(fits);
      expect(fallbackDivisorFor(found, periodMs, fasterMs + 1)).toBe(doesNot);
      // Never faster than the range, nor slower: a request of 0 takes the fastest, a huge one the slowest.
      expect(fallbackDivisorFor(found, periodMs, 0)).toBe(found[0]);
      expect(fallbackDivisorFor(found, periodMs, 1_000)).toBe(found[1]);
    });
  }

  it("takes the rates design §21.5 lists", () => {
    const rate = (hz: number, paced: number, meanMs: number): number => {
      const range = fallbackDivisorRange(hz, 30, paced)!;
      return hz / fallbackDivisorFor(range, 1_000 / hz, meanMs);
    };
    expect(rate(60, 1, 25)).toBeCloseTo(30, 9);
    expect(rate(75, 1, 22)).toBeCloseTo(37.5, 9);
    expect(rate(75, 1, 30)).toBeCloseTo(25, 9);
    expect(rate(100, 1, 25)).toBeCloseTo(100 / 3, 9);
    expect(rate(144, 2, 27)).toBeCloseTo(36, 9);
    expect(rate(144, 2, 30)).toBeCloseTo(28.8, 9);
    expect(rate(165, 2, 30)).toBeCloseTo(33, 9);
    expect(rate(165, 2, 32)).toBeCloseTo(27.5, 9);
  });

  it("holds only divisors above the paced one, so the setting's own cadence is never a fallback", () => {
    for (const [hz, paced, range] of FALLBACK_TABLE) {
      if (range !== null) expect(range[0], `${hz} Hz`).toBeGreaterThan(paced);
    }
    // 60 Hz with a divisor already at 2 has nothing left to fall back to.
    expect(fallbackDivisorRange(60, 30, 2)).toBeNull();
  });

  it("absorbs a measured rate a little off its nominal value", () => {
    expect(fallbackDivisorRange(59.94, 30, 1)).toEqual([2, 2]);
    expect(fallbackDivisorRange(119.88, 30, 2)).toEqual([4, 4]);
    expect(fallbackDivisorRange(143.86, 30, 2)).toEqual([4, 5]);
  });
});

describe("the cadence floor under the fallback (PR B part 2b, G6)", () => {
  it("is the interval drawn: the fallback's divisor times the period", () => {
    expect(cadenceFloorMs(cadence(60, 2, 60, true, 30))).toBeCloseTo(1_000 / 30, 9);
    expect(cadenceFloorMs(cadence(60, 2, 75, true, 37.5))).toBeCloseTo(26.667, 3);
    expect(cadenceFloorMs(cadence(60, 3, 75, true, 25))).toBeCloseTo(40, 9);
    expect(cadenceFloorMs(cadence(60, 3, 100, true, 100 / 3))).toBeCloseTo(30, 9);
    expect(cadenceFloorMs(cadence(60, 4, 144, true, 36))).toBeCloseTo(27.778, 3);
    expect(cadenceFloorMs(cadence(60, 5, 144, true, 28.8))).toBeCloseTo(34.722, 3);
    expect(cadenceFloorMs(cadence(60, 8, 240, true, 30))).toBeCloseTo(1_000 / 30, 9);
  });

  it("puts the hitch threshold on that interval: 60 ms at 60 Hz", () => {
    expect(hitchThresholdMilliseconds(medium, cadence(60, 2, 60, true, 30))).toBeCloseTo(60, 9);
    expect(hitchThresholdMilliseconds(medium, cadence(60, 2, 75, true, 37.5))).toBeCloseTo(2 * (2_000 / 75 - 10 / 3), 9);
  });

  it("still relaxes nothing on a period the floor does not trust", () => {
    // The pacer never applies a fallback on one; were it to, the target stays.
    expect(cadenceFloorMs(cadence(60, 2, 60, false, 30))).toBe(0);
    expect(cadenceFloorMs(cadence(60, 2, 50, true, 25))).toBe(0);
    expect(cadenceFloorMs(cadence(60, 2, null, false, 30))).toBe(0);
  });
});
