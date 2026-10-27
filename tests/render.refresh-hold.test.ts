import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { FlightRenderer } from "../src/render/FlightRenderer";
import { resolveGovernedWork, type GovernedWork } from "../src/render/governedWork";
import {
  forceRefresh,
  refreshIntervalAtCadence,
  syncRefreshInterval,
  type RefreshTarget,
} from "../src/render/refreshHold";
import { governorConfigForProfile, workLeverSettingsFor } from "../src/render/webgpu/core/AdaptiveGovernor";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";

/**
 * PR B part 2 (G5, R1): the CSM and cloud-depth refresh holds.
 *
 *  - Babylon's counter, on a real RenderTargetTexture: an interval of 2
 *    renders every other frame, and the sync writes it once. Its setter resets
 *    the counter, so a write every frame renders every frame (verify F3); the
 *    instrument shows the detector sees that.
 *  - A forced refresh (every history invalidation) draws the next frame.
 *  - The profile's interval is a rate, converted to the presented cadence; a
 *    rung's frames are a cost, added after. Driven through the renderer's own
 *    `syncRefreshHolds` on a stand-in carrying the fields it reads, every rung
 *    adds exactly one frame at every cadence, the 30 fps setting and part
 *    2b's fallback rates included. Summing first and rounding the sum (the
 *    instrument) loses the rung at 30 fps.
 *  - At level (0, 0) on the capture's profile the holds write nothing, which
 *    is what keeps the reference pictures' shadow and depth passes as they were.
 */

const MS_60 = 1_000 / 60;
const MS_30 = 1_000 / 30;
/** Part 1's 30 fps setting and part 2b's even fallback rates: 37.5 fps (75 Hz), 30, 28.8 (144 Hz), 25. */
const PRESENTED_TARGETS = [MS_60, 1_000 / 37.5, MS_30, 1_000 / 28.8, 1_000 / 25] as const;

function renderTarget(): RenderTargetTexture {
  const scene = new Scene(new NullEngine());
  return new RenderTargetTexture("refresh-hold", 4, scene);
}

/** `_shouldRender()` as the scene calls it, once per frame. */
function frames(target: RenderTargetTexture, count: number, beforeEach?: () => void): boolean[] {
  const rendered: boolean[] = [];
  for (let frame = 0; frame < count; frame += 1) {
    beforeEach?.();
    rendered.push(target._shouldRender());
  }
  return rendered;
}

describe("syncRefreshInterval on Babylon's counter", () => {
  it("renders every other frame at an interval of 2", () => {
    const target = renderTarget();
    expect(target.refreshRate).toBe(1);
    expect(syncRefreshInterval(target, 2)).toBe(true);
    expect(frames(target, 4)).toEqual([true, false, true, false]);
  });

  it("F3: synced every frame, it writes once and the sequence holds", () => {
    const target = renderTarget();
    const writes: boolean[] = [];
    expect(frames(target, 6, () => writes.push(syncRefreshInterval(target, 2))))
      .toEqual([true, false, true, false, true, false]);
    expect(writes).toEqual([true, false, false, false, false, false]);
  });

  it("INSTRUMENT: a naive write every frame renders every frame, so the hold would do nothing", () => {
    const target = renderTarget();
    expect(frames(target, 4, () => { target.refreshRate = 2; })).toEqual([true, true, true, true]);
  });

  it("writes nothing for a missing target, and clamps to a whole frame of at least 1", () => {
    expect(syncRefreshInterval(null, 2)).toBe(false);
    expect(syncRefreshInterval(undefined, 2)).toBe(false);
    const target = renderTarget();
    expect(syncRefreshInterval(target, 0)).toBe(false);
    expect(syncRefreshInterval(target, 2.9)).toBe(true);
    expect(target.refreshRate).toBe(2);
  });

  it("a forced refresh on a held frame draws the next one, then the hold resumes", () => {
    const target = renderTarget();
    syncRefreshInterval(target, 3);
    expect(frames(target, 2)).toEqual([true, false]);
    forceRefresh(target);
    expect(frames(target, 4)).toEqual([true, false, false, true]);
    expect(() => forceRefresh(null)).not.toThrow();
  });
});

describe("refreshIntervalAtCadence", () => {
  it.each([
    [1, MS_60, MS_60, 1],
    [2, MS_60, MS_60, 2],
    [2, MS_60, MS_30, 1],
    [3, MS_60, MS_30, 2],
    [2, MS_30, MS_30, 2],
    [2, MS_60, 40, 1],
    [2, MS_60, 34.72, 1],
  ])("%d frames at %f ms, presented every %f ms, is %d", (frames, tier, shown, expected) => {
    expect(refreshIntervalAtCadence(frames, tier, shown)).toBe(expected);
  });

  it("is the profile's own value at the tier's cadence or a faster one", () => {
    for (const frames of [1, 2, 3, 2.5]) {
      expect(Object.is(refreshIntervalAtCadence(frames, MS_60, MS_60), frames)).toBe(true);
      expect(Object.is(refreshIntervalAtCadence(frames, MS_60, 1_000 / 144), frames)).toBe(true);
    }
  });
});

/** The renderer's fields `syncRefreshHolds` reads, with targets that count the interval writes. */
interface HoldReceiver {
  governedWork: GovernedWork;
  governorConfig: { tierPresentationTargetMs: number; presentationTargetMs: number };
  atmosphere: { shadows: { getShadowMap: () => RefreshTarget } };
  atmosphereResources: { sceneDepth: RefreshTarget };
}

interface CountingTarget extends RefreshTarget {
  readonly writes: number[];
}

function countingTarget(): CountingTarget {
  let rate = 1;
  const writes: number[] = [];
  return {
    get refreshRate() { return rate; },
    set refreshRate(value: number) { rate = value; writes.push(value); },
    resetRefreshCounter: () => undefined,
    writes,
  };
}

const medium = resolveWebGpuQualityProfile("medium", "balanced");

function holdReceiver(profileFrames: number, extraFrames: number, presentationTargetMs: number) {
  const shadowMap = countingTarget();
  const sceneDepth = countingTarget();
  const profile = { ...medium, shadowRefreshFrames: profileFrames, cloudDepthRefreshFrames: profileFrames };
  const levers = {
    ...workLeverSettingsFor(0, 0),
    shadowRefreshExtraFrames: extraFrames,
    cloudDepthRefreshExtraFrames: extraFrames,
  };
  const receiver: HoldReceiver = {
    governedWork: resolveGovernedWork(profile, levers),
    governorConfig: { tierPresentationTargetMs: MS_60, presentationTargetMs },
    atmosphere: { shadows: { getShadowMap: () => shadowMap } },
    atmosphereResources: { sceneDepth },
  };
  return { receiver, shadowMap, sceneDepth };
}

function syncRefreshHolds(receiver: HoldReceiver): void {
  (Reflect.get(FlightRenderer.prototype, "syncRefreshHolds") as (this: HoldReceiver) => void).call(receiver);
}

/** The renderer's CSM and cloud-depth intervals for one profile value, rung and cadence. */
function intervals(profileFrames: number, extraFrames: number, presentationTargetMs: number): [number, number] {
  const { receiver, shadowMap, sceneDepth } = holdReceiver(profileFrames, extraFrames, presentationTargetMs);
  syncRefreshHolds(receiver);
  return [shadowMap.refreshRate, sceneDepth.refreshRate];
}

/** INSTRUMENT: the first version's formula, the rung's frames summed into the profile's before rounding. */
function sumThenRound(profileFrames: number, extraFrames: number, presentationTargetMs: number): number {
  return refreshIntervalAtCadence(profileFrames + extraFrames, MS_60, presentationTargetMs);
}

describe("the renderer's refresh holds", () => {
  it("every rung adds exactly one presented frame, at every cadence", () => {
    let rows = 0;
    for (const shown of PRESENTED_TARGETS) {
      for (const profileFrames of [1, 2]) {
        const base = refreshIntervalAtCadence(profileFrames, MS_60, shown);
        for (const extraFrames of [0, 1, 2]) {
          expect(intervals(profileFrames, extraFrames, shown), `${profileFrames} + ${extraFrames} at ${shown} ms`)
            .toEqual([base + extraFrames, base + extraFrames]);
          rows += 1;
        }
      }
    }
    expect(rows).toBe(30);
    // The 30 fps setting (§2.6): tier 0's 2 becomes 1, and with the rung 2;
    // tiers 1-2's 1 stays 1, and with the rung 2.
    expect(intervals(2, 0, MS_30)).toEqual([1, 1]);
    expect(intervals(2, 1, MS_30)).toEqual([2, 2]);
    expect(intervals(1, 0, MS_30)).toEqual([1, 1]);
    expect(intervals(1, 1, MS_30)).toEqual([2, 2]);
  });

  it("INSTRUMENT: summing before rounding loses the rung at the 30 fps setting", () => {
    expect(sumThenRound(1, 1, MS_30)).toBe(sumThenRound(1, 0, MS_30));
    expect(intervals(1, 1, MS_30)[0]).toBeGreaterThan(intervals(1, 0, MS_30)[0]);
  });

  it("writes an interval once, not every frame", () => {
    const { receiver, shadowMap, sceneDepth } = holdReceiver(2, 1, MS_60);
    for (let frame = 0; frame < 5; frame += 1) syncRefreshHolds(receiver);
    expect(shadowMap.writes).toEqual([3]);
    expect(sceneDepth.writes).toEqual([3]);
  });

  it("at level (0, 0) on the capture's profile, with no cadence, writes nothing", () => {
    const { receiver, shadowMap, sceneDepth } = holdReceiver(medium.shadowRefreshFrames, 0, MS_60);
    const config = governorConfigForProfile(medium);
    receiver.governedWork = resolveGovernedWork(medium, workLeverSettingsFor(0, 0));
    receiver.governorConfig = config;
    for (let frame = 0; frame < 5; frame += 1) syncRefreshHolds(receiver);
    expect(config.presentationTargetMs).toBe(config.tierPresentationTargetMs);
    expect(shadowMap.writes).toEqual([]);
    expect(sceneDepth.writes).toEqual([]);
  });
});
