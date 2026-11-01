import { describe, expect, it } from "vitest";
import {
  cadenceDisplayHz,
  cadenceFloorMs,
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
): PresentationCadence {
  return { frameCapHz, divisor, displayPeriodMs: hz === null ? null : 1_000 / hz, periodConfirmed };
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

  it("reads the nominal display rate back from the period", () => {
    expect(cadenceDisplayHz(cadence(60, 2, 120, true))).toBeCloseTo(120, 9);
    expect(cadenceDisplayHz(cadence(60, 1, null, false))).toBeNull();
    expect(cadenceDisplayHz(null)).toBeNull();
  });
});
