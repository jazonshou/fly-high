import { describe, expect, it } from "vitest";
import {
  chooseMetrics,
  passTimingChanges,
  renderMarkdown,
  summarize,
  type MeasuredSample,
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

describe("perf-ab per-pass changes", () => {
  /**
   * Eight rounds of two frames an arm. `scene` runs every frame at 100 ms in
   * the base and 100 * `sceneRatio` in the head, with a little noise; `shadow`
   * runs every third frame of each arm's own count at 10 ms, the same in both.
   */
  const samples = (sceneRatio: number): MeasuredSample[] => {
    const list: MeasuredSample[] = [];
    for (const arm of ["base", "head"] as const) {
      for (let round = 0; round < 8; round += 1) {
        for (let turn = 0; turn < 2; turn += 1) {
          const frame = round * 2 + turn;
          const noise = 1 + 0.002 * ((frame * 7 + (arm === "head" ? 3 : 0)) % 5);
          const scene = 100 * (arm === "head" ? sceneRatio : 1) * noise;
          const passes: Record<string, number> = { scene };
          if (frame % 3 === 0) passes.shadow = 10 * noise;
          list.push({
            round, arm, renderMs: 10, gpuMs: scene + (passes.shadow ?? 0), wallMs: scene + 1,
            passes, invalidPasses: 0, pipelinesCreated: 0, shaderModulesCreated: 0,
          });
        }
      }
    }
    return list;
  };

  it("pairs an every-frame pass by round and gives it an interval", () => {
    const scene = passTimingChanges(samples(1.1), 8, 2).find((change) => change.key === "scene")!;
    expect(scene.cadenced).toBe(false);
    expect(scene.ratio).toBeCloseTo(1.1, 2);
    expect(scene.ratioLow).not.toBeNull();
    expect(scene.ratioHigh).not.toBeNull();
  });

  it("compares a pass on a cadence per run, not by the rhythm of its round totals", () => {
    const shadow = passTimingChanges(samples(1.1), 8, 2).find((change) => change.key === "shadow")!;
    expect(shadow.cadenced).toBe(true);
    // Six of sixteen frames run it: 10 ms a run is 3.75 ms a frame.
    expect(shadow.baseMs).toBeCloseTo(3.75, 1);
    expect(shadow.ratio).toBeCloseTo(1, 2);
    expect(shadow.ratioLow).not.toBeNull();
    // Rounds 0, 1, 3, 4, 6 and 7 hold one of each arm's runs.
    expect(shadow.rounds).toBe(6);
  });

  it("drops a pass below half a per cent of the frame", () => {
    const tiny = samples(1).map((sample) => ({ ...sample, passes: { ...sample.passes, tiny: 0.1 } }));
    expect(passTimingChanges(tiny, 8, 2).map((change) => change.key)).not.toContain("tiny");
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
      offCanonical: [],
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
    const fractional = renderMarkdown(report(
      { timedMetrics: ["cpu", "wall"], gatedMetrics: ["wall", "cpu"], thresholds: { gpu: 0.05, cpu: 0.15, wall: 0.075 } },
      [shot({ metrics: [metric("cpu", "same"), metric("wall", "same")] })],
    ));
    expect(fractional).toContain("a change is called at 7.5% in Frame wall time and 15% in CPU time");
  });

  it("says the baseline is another instant on any host, and another rasteriser only on SwiftShader", () => {
    const comparison = {
      width: 1_100, height: 619, ssim: 0.7061, rgbSsim: 0.7115, worstTileRgbSsim: -0.0048,
      differingPixels: 600_000, maxChannelDelta: 200, meanAbsoluteChannelDelta: 9,
    };
    const shots = [shot({ baseline: { base: comparison, head: comparison } })];
    expect(renderMarkdown(report({}, shots))).toContain(
      "Against the committed Mac baseline (another instant than the capture's, on another rasteriser, so not a gate): "
      + "base SSIM 0.7061, RGB 0.7115, worst tile -0.0048;",
    );
    const metal = { ...report({}, shots), host: { ...report().host, backend: "hardware GPU" } };
    expect(renderMarkdown(metal)).toContain("Against the committed Mac baseline (another instant than the capture's, so not a gate): ");
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

  it("says how many rounds would clear an inconclusive run if nothing changed, unless its estimate is the problem", () => {
    const inconclusive = (rounds: number, ratioLow: number, ratioHigh: number): PerfAbReport => {
      const wall = metric("wall", "inconclusive");
      const shots = [shot({ metrics: [metric("cpu", "same"), { ...wall, comparison: { ...wall.comparison, rounds, ratioLow, ratioHigh } }] })];
      return {
        ...report({ rounds, timedMetrics: ["cpu", "wall"], gatedMetrics: ["wall", "cpu"] }, shots),
        summary: { verdict: "inconclusive", reasons: ["cruise-horizon: Frame wall time inconclusive"], geometricMeanRatio: { gpu: 1, cpu: 1, wall: 1 } },
      };
    };
    // Half-width (ln 1.081 - ln 0.889) / 2 = 0.0978 against ln(1.05) / 2:
    // 20 * 4.008^2 = 321.3 rounds, to the next ten.
    expect(renderMarkdown(inconclusive(20, 0.889, 1.081))).toContain(
      "If nothing changed, about 330 rounds would clear these (`--rounds 330`): an interval narrows with the square root of the rounds.",
    );
    // Narrow already, but straddling +5%: more rounds will not make it SAME.
    expect(renderMarkdown(inconclusive(200, 1.02, 1.06))).not.toContain("If nothing changed");
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

  it("says a run off the capture's settings does not gate its ceilings", () => {
    const pinned = renderMarkdown(report());
    expect(pinned).toContain("Ceilings: draw calls 200 / 200");
    expect(pinned).not.toContain("off the capture's own settings");
    const airliner = renderMarkdown(report({ aircraft: "airliner", offCanonical: ["--aircraft airliner"] }, [
      shot({ ceilings: { ...shot().ceilings!, baseDrawCalls: 321, headDrawCalls: 321, baseDrawCallsMin: 321, headDrawCallsMin: 321 } }),
    ]));
    expect(airliner).toContain("Run with `--aircraft airliner`, off the capture's own settings");
    expect(airliner).toContain("the ceilings are shown but not gated, and no shot is compared with its baseline.");
    expect(airliner).toContain("Ceilings (not gated off the capture's settings): draw calls 321 / 200");
  });

  it("says when a pass's change is per run because it runs on a cadence", () => {
    const passes = [
      { key: "render:scene", baseMs: 100, headMs: 101, ratio: 1.01, ratioLow: 0.99, ratioHigh: 1.03, cadenced: false, rounds: 8 },
      { key: "compute:shadow", baseMs: 3.75, headMs: 3.8, ratio: 1.012, ratioLow: 0.98, ratioHigh: 1.04, cadenced: true, rounds: 6 },
      { key: "compute:rare", baseMs: 2.5, headMs: 2.2, ratio: 0.86, ratioLow: null, ratioHigh: null, cadenced: true, rounds: 3 },
    ];
    const markdown = renderMarkdown(report({}, [shot({ passes })]));
    expect(markdown).toContain("- `render:scene`: 100.0 → 101.0 (+1.0%, -1.0% to +3.0%)");
    expect(markdown).toContain(
      "- `compute:shadow`: 3.8 → 3.8 (on a cadence; per run +1.2%, -2.0% to +4.0%, over the 6 rounds both arms ran it)",
    );
    expect(markdown).toContain(
      "- `compute:rare`: 2.5 → 2.2 (on a cadence; per run -14.0%, over the 3 rounds both arms ran it, too few for an interval)",
    );
  });

  it("says when arms that differ in resident terrain pages want the same ones", () => {
    const diagnostics = (resident: number, wanted: number) => ({
      drawCalls: 247, triangles: 1_800_000, visibleInstances: 82_000, vegetationBatches: 21,
      residentTerrainPages: resident, wantedTerrainPages: wanted, renderPixels: 680_900,
      inventoriedGpuMemoryMiB: 265.9, estimatedGpuMemoryMiB: 380,
    });
    const history = renderMarkdown(report({}, [shot({
      diagnostics: {
        base: diagnostics(35, 33),
        head: diagnostics(36, 33),
        changes: [{ key: "residentTerrainPages", base: 35, head: 36 }],
      },
    })]));
    expect(history).toContain(
      "- residentTerrainPages: 35 → 36 (both arms want 33: the rest were wanted earlier in each arm's stream, "
      + "and stay until their slots are needed)",
    );
    const asked = renderMarkdown(report({}, [shot({
      diagnostics: {
        base: diagnostics(35, 33),
        head: diagnostics(37, 35),
        changes: [{ key: "residentTerrainPages", base: 35, head: 37 }, { key: "wantedTerrainPages", base: 33, head: 35 }],
      },
    })]));
    expect(asked).toContain("- residentTerrainPages: 35 → 37\n- wantedTerrainPages: 33 → 35\n");
    // A base too old to report its wanted pages says -1, which explains nothing.
    const old = renderMarkdown(report({}, [shot({
      diagnostics: {
        base: diagnostics(35, -1),
        head: diagnostics(36, -1),
        changes: [{ key: "residentTerrainPages", base: 35, head: 36 }],
      },
    })]));
    expect(old).toContain("- residentTerrainPages: 35 → 36\n");
  });
});
