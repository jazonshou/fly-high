import { describe, expect, it } from "vitest";
import {
  BENCH_PATH_ID,
  BENCH_SEED,
  SETTLE_START,
  TIER_TABLE,
  benchGameSettings,
  benchRendererOptions,
  benchRunPlan,
  benchTier,
  benchTimings,
  describeDuration,
  estimateBenchDuration,
  estimateRemainingSeconds,
  exitUrl,
  expectedPathFingerprint,
  ignoredBenchParams,
  introUrl,
  newRunId,
  pinnedRenderScaleFor,
  recordSettleCheck,
  reportUrl,
  settleCheckDue,
  settleOutcome,
  stepUrl,
  type SettleProgress,
} from "../src/bench/plan";
import { resolveHardwareScalingLevel } from "../src/render/renderScaleLevel";
import { gpuTimingEnabledAtStartup } from "../src/render/webgpu/core/GpuTimingPolicy";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { DEFAULT_SETTINGS, readBenchFromUrl, readSeedFromUrl, seedToString } from "../src/settings";

const PAGE = "https://jazonshou.github.io/fly-high/?bench=1&world=eroded#x";

describe("bench tiers and settings", () => {
  it("each tier index resolves to that tier through the renderer's own table", () => {
    expect(TIER_TABLE.map((tier) => tier.tierIndex)).toEqual([0, 1, 2, 3]);
    for (const tier of TIER_TABLE) {
      // `.tier` is fine in tests/; src/ outside core may not name it.
      expect(resolveWebGpuQualityProfile(tier.quality, tier.renderingMode).tier).toBe(tier.tierIndex);
      expect(benchTier(tier.tierIndex)).toBe(tier);
    }
    expect(TIER_TABLE.map((tier) => tier.name)).toEqual(["Low", "Medium", "High", "Ultra"]);
    expect(() => benchTier(4)).toThrow(RangeError);
    expect(() => benchTier(1.5)).toThrow(RangeError);
  });

  it("a step's settings are the defaults with only quality and mode changed", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    for (const tier of TIER_TABLE) {
      const settings = benchGameSettings(tier.tierIndex);
      expect(settings).toEqual({
        ...DEFAULT_SETTINGS,
        quality: tier.quality,
        renderingMode: tier.renderingMode,
      });
      expect(settings).not.toBe(DEFAULT_SETTINGS);
      // The diagnostics poll and its getDiagnostics() stay off (R5).
      expect(settings.showDiagnostics).toBe(false);
    }
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });

  it("the bench seed is FlightGame's placeholder, 00762m in the URL", () => {
    expect(seedToString(BENCH_SEED).toLowerCase()).toBe("00762m");
    expect(readSeedFromUrl("http://local/?seed=00762m")).toBe(BENCH_SEED);
  });
});

describe("bench timings", () => {
  it("cuts the ground window from the roll and the air window from the cruise", () => {
    for (const quick of [false, true]) {
      const timings = benchTimings(quick);
      expect(timings.quick).toBe(quick);
      expect(timings.ground.name).toBe("ground");
      expect(timings.air.name).toBe("air");
      expect(timings.ground.startS).toBeGreaterThan(0);
      expect(timings.ground.endS).toBeLessThanOrEqual(timings.rollEndS);
      expect(timings.air.startS).toBeGreaterThanOrEqual(timings.climbEndS);
      expect(timings.air.endS).toBeLessThanOrEqual(timings.flightS);
      expect(timings.earlyStopAtS).toBeLessThan(timings.air.startS);
      expect(timings.settleMinS).toBeLessThan(timings.settleCapS);
    }
    const standard = benchTimings(false);
    expect([standard.rollEndS, standard.climbEndS, standard.flightS]).toEqual([15, 30, 75]);
    expect(standard.ground).toEqual({ name: "ground", startS: 3, endS: 15 });
    expect(standard.air).toEqual({ name: "air", startS: 30, endS: 75 });
    expect([standard.earlyStopAtS, standard.earlyStopFromS, standard.earlyStopMinFps]).toEqual([20, 3, 5]);
    const quick = benchTimings(true);
    expect([quick.rollEndS, quick.climbEndS, quick.flightS]).toEqual([5, 10, 20]);
    expect(quick.ground).toEqual({ name: "ground", startS: 1, endS: 5 });
    expect(quick.air).toEqual({ name: "air", startS: 10, endS: 20 });
  });

  it("a run plan pins the seed, the route and the expected fingerprint", () => {
    const plan = benchRunPlan({ tiers: [1, 0, 2, 1], mode: "shipped", hud: true, quick: false });
    expect(plan).toEqual({
      tiers: [1, 0, 2, 1],
      mode: "shipped",
      hud: true,
      quick: false,
      seed: "00762m",
      pathId: BENCH_PATH_ID,
      pathFingerprint: expectedPathFingerprint(false),
      flightSeconds: 75,
      windows: { ground: benchTimings(false).ground, air: benchTimings(false).air },
      settleCapSeconds: 20,
    });
    expect(benchRunPlan({ tiers: [0], mode: "pinned", hud: false, quick: true }).pathFingerprint)
      .toBe(expectedPathFingerprint(true));
  });

  it("the intro promises about 7 minutes for the default four steps", () => {
    const { typicalS, worstS } = estimateBenchDuration(4, benchTimings(false));
    expect(describeDuration(typicalS)).toBe("about 7 minutes");
    expect(worstS).toBeGreaterThan(typicalS);
    expect(worstS / 60).toBeLessThan(10);
    expect(describeDuration(estimateBenchDuration(1, benchTimings(true)).typicalS)).toBe("about a minute");
    expect(describeDuration(30)).toBe("under a minute");
    expect(describeDuration(70)).toBe("about a minute");
    expect(describeDuration(Number.NaN)).toBe("under a minute");
    const remaining = estimateRemainingSeconds(benchTimings(false), 2, 30);
    expect(remaining).toBeGreaterThan(2 * 75);
    expect(estimateRemainingSeconds(benchTimings(false), 0, 1e6)).toBeGreaterThan(0);
  });

  it("counts the time left in flight by the flight clock, however slowly the step started", () => {
    const standard = benchTimings(false);
    // The last step of a slow machine: 30 s to start and the 20 s settle cap, then 10 s of flight.
    const flying = estimateRemainingSeconds(standard, 0, 60, 10);
    expect(flying).toBeGreaterThanOrEqual(65);
    expect(describeDuration(flying)).toBe("about a minute");
    expect(estimateRemainingSeconds(standard, 0, 80, 30)).toBeGreaterThanOrEqual(45);
    // Before the flight its whole length is still ahead; after it, only the pause and the report.
    expect(estimateRemainingSeconds(standard, 0, 120)).toBeGreaterThanOrEqual(75);
    expect(estimateRemainingSeconds(standard, 0, 130, standard.flightS)).toBeLessThan(10);
    const typicalStep = estimateBenchDuration(1, standard).typicalS - estimateBenchDuration(0, standard).typicalS;
    expect(estimateRemainingSeconds(standard, 1, 0, standard.flightS))
      .toBeCloseTo(estimateRemainingSeconds(standard, 0, 0, standard.flightS) + typicalStep, 9);
  });
});

describe("bench URLs", () => {
  const options = { tiers: [1, 0, 2, 1], mode: "pinned", hud: false, quick: true } as const;

  it("round-trip through readBenchFromUrl and drop everything else", () => {
    const intro = introUrl(PAGE, options);
    expect(intro).toBe("https://jazonshou.github.io/fly-high/?bench=1&tiers=1,0,2,1&mode=pinned&hud=0&quick=1");
    expect(readBenchFromUrl(intro)).toEqual({ ...options, tiers: [1, 0, 2, 1], run: null, step: null });

    const step = stepUrl(PAGE, "abc123def0", 2, options);
    expect(readBenchFromUrl(step)).toEqual({ ...options, tiers: [1, 0, 2, 1], run: "abc123def0", step: 2 });
    expect(readSeedFromUrl(step)).toBe(BENCH_SEED);

    const report = reportUrl(PAGE, "abc123def0", options);
    expect(readBenchFromUrl(report)?.step).toBe("report");
    expect(readBenchFromUrl(report)?.run).toBe("abc123def0");

    for (const url of [intro, step, report]) {
      const params = new URL(url).searchParams;
      for (const dropped of ["world", "landforms", "farSward"]) expect(params.has(dropped)).toBe(false);
      expect(new URL(url).hash).toBe("");
      expect(new URL(url).pathname).toBe("/fly-high/");
    }
    expect(exitUrl(PAGE)).toBe("https://jazonshou.github.io/fly-high/");
  });

  it("shipped mode with the HUD on writes no hud or quick flags", () => {
    const url = introUrl("http://local/", { tiers: [3], mode: "shipped", hud: true, quick: false });
    expect(url).toBe("http://local/?bench=1&tiers=3&mode=shipped");
  });

  it("lists parameters the bench ignores, but not its own or its seed", () => {
    expect(ignoredBenchParams(
      "http://local/?bench=1&world=eroded&landforms=dunes&farSward=off&seed=00762m&tiers=1&quick=1",
    )).toEqual(["farSward=off", "landforms=dunes", "world=eroded"]);
    expect(ignoredBenchParams("http://local/?bench=1&seed=abc")).toEqual(["seed=abc"]);
    expect(ignoredBenchParams("not a url")).toEqual([]);
  });

  it("run ids are ten base-36 characters that the reader accepts", () => {
    let calls = 0;
    const id = newRunId(() => ((calls += 1) * 0.0937) % 1);
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    expect(readBenchFromUrl(stepUrl("http://local/", id, 0, options))?.run).toBe(id);
    expect(newRunId(() => 0.999999)).toBe("zzzzzzzzzz");
    expect(newRunId()).toMatch(/^[a-z0-9]{10}$/);
  });
});

describe("pinned mode renders the tier's whole pixel budget", () => {
  const sizes = [[1280, 720], [1366, 657], [1920, 1080], [2560, 1329]] as const;
  const ratios = [0.8, 1, 1.25, 1.5, 2, 3];

  it("the pixel cap binds, within 1%, except where the scale clamp at 2 bites", () => {
    for (const tier of TIER_TABLE) {
      const profile = resolveWebGpuQualityProfile(tier.quality, tier.renderingMode);
      for (const [width, height] of sizes) {
        for (const ratio of ratios) {
          const pinned = pinnedRenderScaleFor(profile, width, height, ratio);
          const label = `tier ${tier.tierIndex} ${width}x${height} @${ratio}`;
          expect(pinned.scale, label).toBeGreaterThanOrEqual(0.1);
          expect(pinned.scale, label).toBeLessThanOrEqual(2);
          const level = resolveHardwareScalingLevel({
            maxDevicePixelRatio: profile.maxDevicePixelRatio,
            devicePixelRatio: ratio,
            renderScale: pinned.scale,
            cssWidth: width,
            cssHeight: height,
            maxRenderPixels: profile.maxRenderPixels,
          });
          expect(pinned.renderPixels, label).toBeCloseTo((width * height) / level ** 2, 6);
          expect(pinned.aspectRatio, label).toBeCloseTo(width / height, 9);
          if (pinned.pixelCapBinds) {
            expect(Math.abs(pinned.renderPixels / profile.maxRenderPixels - 1), label).toBeLessThan(0.01);
          } else {
            // Only a small canvas on the 4 Mpx tier needs a scale past 2.
            expect(pinned.scale, label).toBe(2);
            expect(pinned.renderPixels, label).toBeLessThan(profile.maxRenderPixels);
          }
        }
      }
    }
  });

  it("the cap binds for every tier at 1920x1080", () => {
    for (const tier of TIER_TABLE) {
      const profile = resolveWebGpuQualityProfile(tier.quality, tier.renderingMode);
      expect(pinnedRenderScaleFor(profile, 1920, 1080, 1).pixelCapBinds).toBe(true);
    }
  });

  it("shipped mode adds no renderer options; pinned mode passes the GPU timing policy", () => {
    expect(benchRendererOptions("shipped", 1, 1920, 1080, 1)).toEqual({});
    for (const tier of TIER_TABLE) {
      const pinned = benchRendererOptions("pinned", tier.tierIndex, 1920, 1080, 2);
      expect(pinned.captureGpuTiming).toBe(true);
      expect(pinned.pinnedRenderScale).toBeGreaterThan(0);
      for (const captureGpuTiming of [true, false]) {
        for (const timestampQuerySupported of [true, false]) {
          expect(() => gpuTimingEnabledAtStartup({
            timestampQuerySupported,
            captureGpuTiming,
            pinnedCapture: pinned.pinnedRenderScale !== undefined,
          })).not.toThrow();
        }
      }
      expect(benchRendererOptions("pinned", tier.tierIndex, 1920, 1080, 2, false).captureGpuTiming).toBe(false);
    }
  });
});

describe("settle rest checks", () => {
  const timings = benchTimings(false);
  const calm = { pendingTerrainPages: 0, pendingDetailWork: 0, visibleInstances: 1_000 };

  function check(progress: SettleProgress, seconds: number, frames: number, sample = calm): SettleProgress {
    return recordSettleCheck(timings, progress, seconds * 1_000, frames, sample);
  }

  it("waits for the minimum, a second, and 120 frames between checks unless counters are cheap", () => {
    expect(settleCheckDue(timings, SETTLE_START, 3_999, 1_000, false)).toBe(false);
    expect(settleCheckDue(timings, SETTLE_START, 4_000, 10, false)).toBe(true);
    const once = check(SETTLE_START, 4, 10);
    expect(settleCheckDue(timings, once, 4_999, 500, false)).toBe(false);
    expect(settleCheckDue(timings, once, 5_000, 129, false)).toBe(false);
    expect(settleCheckDue(timings, once, 5_000, 129, true)).toBe(true);
    expect(settleCheckDue(timings, once, 5_000, 130, false)).toBe(true);
  });

  it("rests after three calm checks in a row, the first never calm", () => {
    let progress = SETTLE_START;
    for (let index = 0; index < 3; index += 1) {
      progress = check(progress, 4 + index, 200 * index);
      expect(settleOutcome(timings, progress, (4 + index) * 1_000)).toBeNull();
    }
    progress = check(progress, 7, 600, { ...calm, visibleInstances: 1_009 });
    expect(progress.calm).toBe(3);
    expect(progress.checks).toBe(4);
    expect(settleOutcome(timings, progress, 7_000)).toBe("rest");
  });

  it("a pending page or an instance jump over 1% resets the run; the cap is not a failure", () => {
    let progress = check(check(SETTLE_START, 4, 0), 5, 200);
    expect(progress.calm).toBe(1);
    progress = check(progress, 6, 400, { ...calm, pendingTerrainPages: 1 });
    expect(progress.calm).toBe(0);
    progress = check(progress, 7, 600, { ...calm, visibleInstances: 1_011 });
    expect(progress.calm).toBe(0);
    expect(settleOutcome(timings, progress, 19_999)).toBeNull();
    expect(settleOutcome(timings, progress, 20_000)).toBe("cap");
  });
});
