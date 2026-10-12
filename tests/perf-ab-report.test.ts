import { describe, expect, it } from "vitest";
import {
  chooseMetrics,
  renderMarkdown,
  summarize,
  type MetricResult,
  type PerfAbReport,
  type ShotResult,
} from "../scripts/perfAbReport.mts";
import { comparePaired, type Verdict } from "../scripts/perfAbStats.mts";
import type { AgentErrors } from "./perf/ab/protocol";

/**
 * The cloud A/B's run verdict decides its exit status, so its ordering is
 * pinned here: a failure outranks a regression, a regression (slower timing
 * or a NEW ceiling breach) outranks an inconclusive timing, and only a run
 * with none of those passes.
 */

const NO_ERRORS: AgentErrors = { console: [], logger: [], gpu: [], page: [] };

function metric(name: MetricResult["metric"], verdict: Verdict | null, gated = true, guard = false): MetricResult {
  const base = [100, 101, 99, 100, 102, 98, 100, 101];
  const ratio = verdict === "slower" ? 1.2 : verdict === "faster" ? 0.8 : 1;
  return {
    metric: name,
    gated,
    guard,
    comparison: comparePaired(base, base.map((value, index) => value * ratio * (1 + 0.001 * index))),
    pSlowerAdjusted: gated ? 0.5 : null,
    pFasterAdjusted: gated ? 0.5 : null,
    verdict: gated ? verdict : null,
  };
}

function shot(overrides: Partial<ShotResult> = {}): ShotResult {
  return {
    name: "cruise-horizon",
    canonicalShotIndex: 4,
    status: "measured",
    failure: null,
    elapsedSeconds: 600,
    viewport: { width: 1_280, height: 720 },
    raster: { width: 1_100, height: 619 },
    renderScale: 0.86,
    streaming: null,
    padded: null,
    metrics: [metric("gpu", "same"), metric("cpu", "same"), metric("wall", null, false)],
    passes: [],
    work: null,
    diagnostics: null,
    ceilings: {
      drawCallCeiling: 200,
      baseDrawCalls: 200,
      headDrawCalls: 200,
      baseDrawCallsMin: 200,
      headDrawCallsMin: 200,
      memoryCeilingMiB: 495,
      headMemoryMiB: 277.9,
      newBreaches: [],
    },
    pixels: null,
    baseline: null,
    measuredFrameCreations: null,
    invalidPasses: null,
    samples: [],
    ...overrides,
  };
}

describe("perf-ab run verdict", () => {
  it("passes a run whose gated timings are all SAME and that breaches nothing", () => {
    expect(summarize([shot()], { base: NO_ERRORS, head: NO_ERRORS })).toEqual({
      verdict: "no-regression",
      reasons: [],
    });
  });

  it("ignores an ungated metric's verdict", () => {
    const quiet = shot({ metrics: [metric("gpu", "same"), metric("cpu", "same"), metric("wall", "slower", false)] });
    expect(summarize([quiet], { base: NO_ERRORS, head: NO_ERRORS }).verdict).toBe("no-regression");
  });

  it("calls a slower gated timing a regression, and so a new ceiling breach on its own", () => {
    const slower = shot({ metrics: [metric("gpu", "slower"), metric("cpu", "same")] });
    expect(summarize([slower], { base: NO_ERRORS, head: NO_ERRORS }).verdict).toBe("regression");
    const breach = shot({
      ceilings: { ...shot().ceilings!, headDrawCalls: 201, newBreaches: ["draw calls 201 exceed the shot's ceiling of 200"] },
    });
    const result = summarize([breach], { base: NO_ERRORS, head: NO_ERRORS });
    expect(result.verdict).toBe("regression");
    expect(result.reasons).toEqual(["cruise-horizon: draw calls 201 exceed the shot's ceiling of 200"]);
  });

  it("reads an inconclusive gated timing as inconclusive, not as a pass", () => {
    const unsure = shot({ metrics: [metric("gpu", "inconclusive"), metric("cpu", "same")] });
    expect(summarize([unsure], { base: NO_ERRORS, head: NO_ERRORS }).verdict).toBe("inconclusive");
  });

  it("lets a guard fail the run but not hold it inconclusive", () => {
    const unresolved = shot({ metrics: [metric("gpu", "same"), metric("cpu", "inconclusive", true, true)] });
    expect(summarize([unresolved], { base: NO_ERRORS, head: NO_ERRORS })).toEqual({
      verdict: "no-regression",
      reasons: [],
    });
    const slower = shot({ metrics: [metric("gpu", "same"), metric("cpu", "slower", true, true)] });
    expect(summarize([slower], { base: NO_ERRORS, head: NO_ERRORS }).verdict).toBe("regression");
  });

  it("ranks a failure above everything, including the head's renderer errors", () => {
    const slower = shot({ metrics: [metric("gpu", "slower")] });
    const unsettled = shot({ name: "water-25ft", status: "unsettled", failure: "streaming did not settle" });
    expect(summarize([slower, unsettled], { base: NO_ERRORS, head: NO_ERRORS }).verdict).toBe("failed");
    const errors: AgentErrors = { ...NO_ERRORS, gpu: ["GPUValidationError: bad bind group"] };
    expect(summarize([shot()], { base: NO_ERRORS, head: errors })).toEqual({
      verdict: "failed",
      reasons: ["the head logged 1 renderer error(s)"],
    });
  });
});

describe("perf-ab metric choice", () => {
  it("gates GPU time where passes can be timed, else the fenced frame", () => {
    expect(chooseMetrics(true)).toEqual({ timed: ["gpu", "cpu", "wall"], gated: ["gpu", "cpu"] });
    expect(chooseMetrics(false)).toEqual({ timed: ["cpu", "wall"], gated: ["wall", "cpu"] });
  });
});

describe("perf-ab Markdown report", () => {
  const report = (overrides: Partial<PerfAbReport["settings"]> = {}, shots = [shot()]): PerfAbReport => ({
    tool: "perf-ab",
    reportVersion: 1,
    startedAt: "2026-10-12T08:00:00.000Z",
    finishedAt: "2026-10-12T08:12:00.000Z",
    mode: "ab",
    base: { ref: "origin/main", sha: "a".repeat(40), dirty: false, profileOverride: null },
    head: { ref: "working tree", sha: "b".repeat(40), dirty: true, profileOverride: null },
    host: {
      platform: "linux-x64",
      cpus: 4,
      cpuModel: "test CPU",
      memoryGiB: 16,
      node: "v24.0.0",
      browser: "Chrome/141",
      backend: "SwiftShader (CPU WebGPU)",
      adapter: "google swiftshader",
    },
    settings: {
      rounds: 8,
      framesPerArmPerRound: 2,
      timedMetrics: ["gpu", "cpu", "wall"],
      gatedMetrics: ["gpu", "cpu"],
      guardMetrics: [],
      thresholds: { gpu: 0.05, cpu: 0.15, wall: 0.05 },
      alpha: 0.05,
      renderScale: null,
      openFrames: 2,
      settleFrames: 12,
      countFrames: 8,
      minStreamFrames: 240,
      maxStreamFrames: 6_000,
      quality: "medium",
      renderingMode: "balanced",
      aircraft: "trainer",
      ...overrides,
    },
    shots,
    errors: { base: NO_ERRORS, head: NO_ERRORS },
    summary: {
      verdict: "no-regression",
      reasons: [],
      geometricMeanRatio: { gpu: 1, cpu: 1, wall: 1 },
    },
  });

  it("gives each gated metric a column, then each other timed metric but the frame's wall time", () => {
    expect(renderMarkdown(report())).toContain("| Shot | GPU time | CPU time | Draw calls | GPU work | Pixels |");
    const cpuReported = renderMarkdown(report(
      { timedMetrics: ["gpu", "cpu", "wall"], gatedMetrics: ["gpu"] },
      [shot({ metrics: [metric("gpu", "same"), metric("cpu", null, false), metric("wall", null, false)] })],
    ));
    expect(cpuReported).toContain("| Shot | GPU time | CPU time (not gated) | Draw calls | GPU work | Pixels |");
    expect(cpuReported).toMatch(/\| cruise-horizon \| same \+0\.\d% \([^)]*\) \| \+0\.\d% \(/u);
    const untimed = renderMarkdown(report({ timedMetrics: ["cpu", "wall"], gatedMetrics: ["wall", "cpu"] }, [
      shot({ metrics: [metric("cpu", "same"), metric("wall", "same")] }),
    ]));
    expect(untimed).toContain("| Shot | Frame wall time | CPU time | Draw calls |");
    expect(untimed).toContain("cannot time passes");
    expect(untimed).not.toMatch(/\| cruise-horizon \| n\/a \|/u);
  });

  it("states each gated metric's own threshold", () => {
    expect(renderMarkdown(report())).toContain(
      "a change is called at 5% in GPU time and 15% in CPU time, with Holm-adjusted alpha 0.05.",
    );
  });

  it("names a guard, and lists where it did not clear a change without calling the run clean", () => {
    const guarded = renderMarkdown(report({ guardMetrics: ["cpu"] }, [
      shot({ metrics: [metric("gpu", "same"), metric("cpu", "inconclusive", true, true), metric("wall", null, false)] }),
    ]));
    expect(guarded).toContain("| Shot | GPU time | CPU time (guard) | Draw calls | GPU work | Pixels |");
    expect(guarded).toContain("CPU time is a guard: a slowdown it resolves fails the run");
    expect(guarded).toContain("but a guard did not resolve");
    expect(guarded).not.toContain("every gated timing is within the threshold");
    expect(guarded).toMatch(/^- cruise-horizon: CPU time \([+-]\d+\.\d% to [+-]\d+\.\d%\)$/mu);
    const cleared = renderMarkdown(report({ guardMetrics: ["cpu"] }, [
      shot({ metrics: [metric("gpu", "same"), metric("cpu", "same", true, true), metric("wall", null, false)] }),
    ]));
    expect(cleared).toContain("every gated timing is within the threshold");
    expect(cleared).not.toContain("Not cleared");
  });

  it("says a counts-only run measured no timing, and shows a cadence's draw-call range", () => {
    const counts = renderMarkdown(report({ rounds: 0 }, [
      shot({
        metrics: [],
        ceilings: { ...shot().ceilings!, headDrawCallsMin: 198 },
      }),
    ]));
    expect(counts).toContain("no timing (`--rounds 0`)");
    expect(counts).toContain("200 → 198–200 (varies by frame)");
  });
});
