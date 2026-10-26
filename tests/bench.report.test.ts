import { describe, expect, it } from "vitest";
import {
  BENCH_ISSUE_REPO,
  COMPACT_REPORT_MAX,
  ISSUE_URL_MAX,
  REPORT_TABLE_COLUMNS,
  buildReport,
  collectWarnings,
  compactReportJson,
  computeRepeatability,
  computeVerdict,
  describeBrowser,
  describeGpu,
  describeOs,
  issueTitle,
  issueUrl,
  reportFileName,
  reportTableRows,
  reportToJson,
  smoothnessText,
  stepSmoothness,
  summaryMarkdown,
  toBenchJson,
  verdictText,
  windowSmoothness,
} from "../src/bench/report";
import { BENCH_SCHEMA } from "../src/bench/plan";
import type {
  BenchBuildInfo,
  BenchDeviceReport,
  BenchReport,
  BenchRunRecord,
  BenchStepRecord,
  BenchWindowMetrics,
} from "../src/bench/types";
import { benchDevice, benchRunRecord, benchStepRecord, defaultRun } from "./support/benchReportFixture";

const BUILD: BenchBuildInfo = {
  commit: "8813adf4c2e19b07a6d5f3e2b1c0d9e8f7a6b5c4",
  entryScript: "assets/index-4f8c2a1b.js",
  base: "/fly-high/",
  origin: "https://jazonshou.github.io",
};
const CREATED_AT = "2026-10-26T09:21:14.381Z";

function report(run: BenchRunRecord, earlier?: readonly BenchRunRecord[]): BenchReport {
  return buildReport({ run, build: BUILD, createdAt: CREATED_AT, ...(earlier ? { earlier } : {}) });
}

/** A copy of `step` whose air window reads `fps` (and whose canvas is `cssWidth` wide). */
function withAir(step: BenchStepRecord, fps: number | null, cssWidth?: number): BenchStepRecord {
  const result = step.result!;
  return {
    ...step,
    result: {
      ...result,
      windows: { ...result.windows, air: result.windows.air && { ...result.windows.air, fps } },
      canvas: cssWidth === undefined ? result.canvas : { ...result.canvas, cssWidth },
    },
  };
}

function withSteps(run: BenchRunRecord, steps: readonly BenchStepRecord[]): BenchRunRecord {
  return { ...run, steps };
}

/** Every path in `value` whose value is undefined, NaN or an infinity. */
function badValues(value: unknown, path = "$"): string[] {
  if (value === undefined) return [path];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (value === null || typeof value !== "object") return [];
  if (ArrayBuffer.isView(value)) return [`${path} (typed array)`];
  return Object.entries(value).flatMap(([key, item]) => badValues(item, `${path}.${key}`));
}

const run = defaultRun();
const full = report(run);

describe("the fly-high.bench/1 report", () => {
  it("has the schema's top-level, run and step keys", () => {
    expect(Object.keys(full)).toEqual([
      "schema", "benchVersion", "createdAt", "build", "run", "device", "display", "profiles", "steps",
      "earlierRuns", "definitions",
    ]);
    expect(full.schema).toBe(BENCH_SCHEMA);
    expect(Object.keys(full.run).sort()).toEqual([
      "finishedAt", "firstLoad", "id", "ignoredParams", "nonStandard", "plan", "repeatability", "settingsKeyUnchanged",
      "startedAt", "status", "tierLabels", "userLabel", "verdict", "voidReasons", "warnings", "workload",
    ]);
    expect(Object.keys(full.steps[0]!)).toEqual([
      "index", "tierIndex", "quality", "renderingMode", "mode", "outcome", "message", "attempts", "attemptLog", "label",
      "result",
    ]);
    expect(Object.keys(full.steps[0]!.result!).sort()).toEqual([
      "benchOverheadMs", "canvas", "compiles", "detailWorker", "end", "environment", "firstRendererInTab", "flight",
      "governor", "heap", "histogram", "longAnimationFrames", "longTasks", "mode", "path", "perSecond", "quality",
      "raf", "refresh", "renderingMode", "segments", "settle", "startup", "tierIndex", "timer", "windows", "worst",
    ]);
    expect(Object.keys(full.profiles)).toEqual(["0", "1", "2"]);
    expect(full.profiles["1"]).toMatchObject({ quality: "medium", renderingMode: "balanced", hitchThresholdMs: 27.4 });
    expect(full.run.workload).toEqual({
      hud: "bench-portal", simWorker: "attract", audio: "none", spawnedAirports: false, pilotInput: false, frameCap: null,
    });
  });

  it("defines the windows by the run's own times, which quick mode shortens", () => {
    expect(full.definitions.windows).toBe(
      "ground: on the runway, from 3 s into the roll to lift-off at 15 s. "
      + "air: the terrain-following cruise, from 30 s to 75 s. The headline is air.",
    );
    const quick = report(defaultRun({ quick: true }));
    expect(quick.run.plan.windows.ground).toMatchObject({ startS: 1, endS: 5 });
    expect(quick.definitions.windows).toMatch(/^ground: on the runway, from 1 s into the roll to lift-off at 5 s\. air: [^.]*from 10 s to 20 s\./u);
    expect(Object.keys(quick.definitions)).toEqual(Object.keys(full.definitions));
  });

  it("holds no undefined, NaN or infinite value, before or after JSON", () => {
    expect(badValues(full)).toEqual([]);
    const parsed = JSON.parse(reportToJson(full)) as unknown;
    expect(badValues(parsed)).toEqual([]);
  });

  it("downloads a four-step run in at most 120 KB, with no per-frame array", () => {
    // The plan's 60 KB came before the ground window, the compile split, the
    // long-animation-frame scripts and the detail snapshots. This fixture
    // measures about 111 KB: 25 KB a step, of which the governor decisions
    // are 5.6 KB and the per-second table 3.9 KB, and 11 KB of profiles and
    // device. The download has no paste limit (S4); the bound is there to
    // catch a per-frame array, which would add about 27 KB a step.
    const text = reportToJson(full);
    expect(text.length).toBeLessThanOrEqual(120_000);
    for (const step of full.steps) expect(reportToJson(step).length).toBeLessThanOrEqual(30_000);
    // A realistic run, not an empty one: about fifty governor decisions a step.
    expect(full.steps[0]!.result!.governor.decisions.length).toBeGreaterThanOrEqual(40);
    expect(full.steps[0]!.result!.perSecond.rows).toHaveLength(75);
  });

  it("writes numbers by the report's rules", () => {
    expect(reportToJson({ a: Number.NaN, b: undefined, c: Number.POSITIVE_INFINITY, d: -Infinity, e: 1 / 3, f: 12 }))
      .toBe('{"a":null,"b":null,"c":"Infinity","d":"-Infinity","e":0.333,"f":12}');
    expect(reportToJson([undefined, 2.0005])).toBe("[null,2.001]");
    expect(toBenchJson({ x: [1.23456] })).toEqual({ x: [1.235] });
  });

  it("copies a compact report under the issue body's limit, naming what it left out", () => {
    const text = compactReportJson(full);
    expect(text.length).toBeLessThanOrEqual(COMPACT_REPORT_MAX);
    const parsed = JSON.parse(text) as { schema: string; compacted: string[]; steps: unknown[] };
    expect(parsed.schema).toBe(BENCH_SCHEMA);
    expect(parsed.steps).toHaveLength(4);
    expect(Array.isArray(parsed.compacted)).toBe(true);

    const tight = JSON.parse(compactReportJson(full, 20_000)) as {
      compacted: string[];
      steps: { result: Record<string, unknown> }[];
    };
    expect(tight.compacted[0]).toBe("perSecond, histogram, decisions");
    expect(tight.steps[0]!.result.perSecond).toBeUndefined();
    expect(tight.steps[0]!.result.windows).toBeDefined();
  });
});

describe("the issue link", () => {
  function decoded(href: string): { title: string; body: string } {
    const url = new URL(href);
    return { title: url.searchParams.get("title")!, body: url.searchParams.get("body")! };
  }

  it(`stays within ${ISSUE_URL_MAX} characters, decodes back and holds the empty JSON block`, () => {
    const href = issueUrl(full);
    expect(href.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(href.startsWith(`https://github.com/${BENCH_ISSUE_REPO}/issues/new?`)).toBe(true);
    expect(href).toContain("jazonshou/fly-high");
    const { title, body } = decoded(href);
    expect(title).toBe(issueTitle(full));
    expect(title).toBe("Benchmark: Jason's laptop (RTX 3060) · Windows 11 · Chrome 130 · valid");
    expect(body).toContain("```json\n\n```");
    expect(body).toContain("| Quality |");
    expect(body).toContain("| Medium |");
    expect(body).toContain("spread");
    expect(body).toContain("build 8813adf4c2e1");
    expect(body).toContain("run k3x9q2m7wp");
  });

  it("drops columns, then rows, to fit, and keeps the JSON block", () => {
    const long = benchRunRecord({
      steps: [1, 0, 2, 3, 0, 2, 3, 1].map((tierIndex) => ({ tierIndex, fps: 45, decisions: 4 })),
      userLabel: "x".repeat(80),
    });
    const built = report(long);
    for (const max of [ISSUE_URL_MAX, 2_000, 1_200]) {
      const href = issueUrl(built, max);
      expect(href.length).toBeLessThanOrEqual(max);
      expect(decoded(href).body).toContain("```json");
    }
    const narrow = decoded(issueUrl(built, 2_000)).body;
    expect(narrow).not.toContain("Governor at end");
    expect(decoded(issueUrl(built)).body).toContain("Result");
  });
});

describe("a device-only report", () => {
  const device: BenchDeviceReport = {
    ...benchDevice(),
    webgpu: {
      ...benchDevice().webgpu,
      status: "missing",
      reason: "navigator.gpu is undefined",
      adapter: null,
      features: [],
      limits: {},
      timestampQuery: false,
      rendererLabel: null,
    },
  };
  const deviceOnly = report(benchRunRecord({
    steps: [{ tierIndex: 1, status: "skipped" }, { tierIndex: 0, status: "skipped" }],
    status: "no-webgpu",
    device,
    userLabel: null,
  }));

  it("builds, reads incomplete, and every view of it works", () => {
    expect(deviceOnly.run.verdict).toBe("incomplete");
    expect(deviceOnly.steps.every((step) => step.result === null && step.label === "did-not-run")).toBe(true);
    expect(badValues(deviceOnly)).toEqual([]);
    expect(describeGpu(deviceOnly.device)).toBe("unknown GPU");
    expect(reportFileName(deviceOnly)).toBe("fly-high-bench-unknown-2026-10-26T09-21-14Z.json");
    expect(issueUrl(deviceOnly).length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(summaryMarkdown(deviceOnly)).toContain("| Medium | – | – | – | – | Did not run (Skipped) |");
    expect(reportTableRows(deviceOnly.steps)[0]!.cells[9]).toBe("Did not run (Skipped)");
    expect(compactReportJson(deviceOnly).length).toBeLessThan(20_000);
  });
});

describe("the device line", () => {
  it("reads adapter fields that live as getters on a prototype, as GPUAdapterInfo's do", () => {
    class AdapterInfoLike {
      get vendor(): string { return "apple"; }
      get architecture(): string { return "metal-3"; }
      get device(): string { return ""; }
      get description(): string { return ""; }
      get isFallbackAdapter(): boolean { return false; }
      get subgroupMinSize(): number { return 4; }
      get subgroupMaxSize(): number { return 64; }
    }
    const info = new AdapterInfoLike();
    // A spread or JSON copy loses every field: the device block must copy them one by one.
    expect(JSON.stringify(info)).toBe("{}");
    expect({ ...info }).toEqual({});
    const device = { ...benchDevice(), webgpu: { ...benchDevice().webgpu, adapter: info } };
    expect(describeGpu(device)).toBe("apple metal-3");
  });

  it("names browsers and systems from client hints, or from the user agent without them", () => {
    const chrome = benchDevice();
    expect(describeBrowser(chrome)).toBe("Chrome 130");
    expect(describeOs(chrome)).toBe("Windows 11");
    expect(describeGpu(chrome)).toBe("nvidia ampere");
    const firefox: BenchDeviceReport = {
      ...chrome,
      uaData: null,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    };
    expect(describeBrowser(firefox)).toBe("Firefox 132");
    expect(describeOs(firefox)).toBe("Linux");
    const safari: BenchDeviceReport = {
      ...chrome,
      uaData: null,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    };
    expect(describeBrowser(safari)).toBe("Safari 18.1");
    expect(describeOs(safari)).toBe("macOS 10.15");
    const edge: BenchDeviceReport = {
      ...chrome,
      uaData: { ...chrome.uaData!, fullVersionList: ["Chromium 130.0.1.2", "Microsoft Edge 130.0.2849.56"] },
    };
    expect(describeBrowser(edge)).toBe("Edge 130");
  });
});

describe("the verdict", () => {
  const steps = run.steps;
  const first = steps[0]!;
  const last = steps[3]!;

  function verdictOf(record: BenchRunRecord) {
    return computeVerdict(record, computeRepeatability(record.steps));
  }

  it("is valid when the first and last Medium flights agree within 10%", () => {
    expect(full.run.verdict).toBe("valid");
    expect(full.run.repeatability).toMatchObject({ metric: "meanFps", window: "air", tierIndex: 1, threshold: 0.1, passed: true });
    expect(full.run.repeatability!.spread).toBeGreaterThan(0);
    expect(full.run.repeatability!.spread).toBeLessThan(0.1);
    expect(verdictText(full.run)).toBe(
      "Valid: the first and last Medium flights, flown to check the run, agree within 10%, "
      + "so its numbers are steady enough to compare.",
    );
  });

  it("passes at 10.0% and voids at 10.1%", () => {
    const atLimit = withSteps(run, [withAir(first, 66), steps[1]!, steps[2]!, withAir(last, 60)]);
    expect(computeRepeatability(atLimit.steps)!.spread).toBe(0.1);
    expect(verdictOf(atLimit).verdict).toBe("valid");
    const over = withSteps(run, [withAir(first, 66.06), steps[1]!, steps[2]!, withAir(last, 60)]);
    const verdict = verdictOf(over);
    expect(verdict.verdict).toBe("void");
    expect(verdict.voidReasons).toEqual(["the first and last Medium flights differ by 10.1% (limit 10%)"]);
    expect(computeRepeatability(over.steps)!.passed).toBe(false);
  });

  it("voids when the window changed size by more than 2% between the check flights", () => {
    const resized = withSteps(run, [first, steps[1]!, steps[2]!, withAir(last, last.result!.windows.air!.fps, 1_820)]);
    const verdict = verdictOf(resized);
    expect(verdict.verdict).toBe("void");
    expect(verdict.voidReasons[0]).toMatch(/^the window changed size by 5\.\d% between them$/);
    const nudged = withSteps(run, [first, steps[1]!, steps[2]!, withAir(last, last.result!.windows.air!.fps, 1_900)]);
    expect(verdictOf(nudged).verdict).toBe("valid");
  });

  it("is incomplete when stopped, or when a check flight did not finish", () => {
    const stopped = report({ ...run, status: "stopped" });
    expect(stopped.run.verdict).toBe("incomplete");
    expect(verdictText(stopped.run)).toBe("Incomplete: the run was stopped before it could check itself.");
    const failed: BenchStepRecord = { ...last, status: "failed", message: "the WebGPU device was lost", result: null };
    expect(verdictOf(withSteps(run, [first, steps[1]!, steps[2]!, failed])).verdict).toBe("incomplete");
    expect(verdictText(report(withSteps(run, [first, steps[1]!, steps[2]!, failed])).run))
      .toBe("Incomplete: one of the first and last Medium flights, which check the run, did not finish.");
    const voided: BenchStepRecord = { ...last, status: "void-hidden", attempts: 2, result: null };
    expect(verdictOf(withSteps(run, [first, steps[1]!, steps[2]!, voided])).verdict).toBe("incomplete");
  });

  it("compares an early stop with the other check flight over the same stretch, not the air window", () => {
    const stopped = benchStepRecord(3, { tierIndex: 1, status: "early-stop" });
    const early = withSteps(run, [first, steps[1]!, steps[2]!, stopped]);
    const repeatability = computeRepeatability(early.steps)!;
    expect(repeatability).toMatchObject({ window: "early-check", last: 4.2 });
    expect(repeatability.first).toBe(first.result!.flight.earlyCheckFps);
    expect(verdictOf(early).verdict).toBe("void");
    expect(verdictOf(early).voidReasons[0]).toMatch(/, measured before the cruise because one stopped early$/u);

    // A first flight at 5.4 fps in the air and 5.0 over the early check's
    // stretch agrees with a last flight that stopped early at 4.9 fps.
    const slowFirst: BenchStepRecord = {
      ...withAir(first, 5.4),
      result: { ...withAir(first, 5.4).result!, flight: { ...first.result!.flight, earlyCheckFps: 5 } },
    };
    const slowLast: BenchStepRecord = {
      ...stopped,
      result: { ...stopped.result!, flight: { ...stopped.result!.flight, earlyStopFps: 4.9, earlyCheckFps: 4.9 } },
    };
    const slow = computeRepeatability([slowFirst, steps[1]!, steps[2]!, slowLast])!;
    expect(slow).toMatchObject({ window: "early-check", first: 5, last: 4.9, passed: true });
    expect(verdictOf(withSteps(run, [slowFirst, steps[1]!, steps[2]!, slowLast])).verdict).toBe("valid");
  });

  it("is unchecked when the plan does not start and end on the same tier", () => {
    const uneven = withSteps(run, [steps[1]!, steps[2]!]);
    expect(computeRepeatability(uneven.steps)).toBeNull();
    expect(verdictOf(uneven).verdict).toBe("unchecked");
    expect(verdictText(report(uneven).run))
      .toBe("Unchecked: this run does not start and end on the same quality, so it cannot check itself.");
    expect(verdictOf(withSteps(run, [first])).verdict).toBe("unchecked");
  });
});

describe("plain-language labels", () => {
  const air = full.steps[0]!.result!.windows.air!;

  function window(p99: number, per240: number, thresholdMs = 27.4): BenchWindowMetrics {
    return {
      ...air,
      intervalMs: { ...air.intervalMs!, p99 },
      over: { ...air.over, hitch: { count: per240, per240, perMinute: per240 * 15, thresholdMs } },
    };
  }

  it("reads smooth, mostly smooth and choppy against the tier's own threshold", () => {
    expect(windowSmoothness(window(17, 0.5))).toBe("smooth");
    expect(windowSmoothness(window(30, 0.5))).toBe("mostly-smooth");
    expect(windowSmoothness(window(30, 6))).toBe("mostly-smooth");
    expect(windowSmoothness(window(40, 6.5))).toBe("choppy");
    // Ultra targets 30 fps: a 34 ms p99 is under its 60 ms threshold.
    expect(windowSmoothness(window(34, 1, 60))).toBe("smooth");
    expect(windowSmoothness(null)).toBe("did-not-run");
  });

  it("labels a browser- or display-capped step limited, not choppy", () => {
    const step = full.steps[0]!;
    const capped = { status: "ok" as const, result: { ...step.result!, raf: { ...step.result!.raf, idleHz: 30, limited: true } } };
    expect(stepSmoothness(capped)).toBe("limited");
    expect(smoothnessText("limited", 30)).toBe("Limited by browser or display at 30 fps");
    expect(smoothnessText("limited", null)).toBe("Limited by browser or display");
    expect(stepSmoothness({ status: "early-stop", result: step.result })).toBe("choppy");
    expect(stepSmoothness({ status: "failed", result: step.result })).toBe("did-not-run");
  });

  it("gives each tier the worse label of its steps that were not limited", () => {
    expect(full.run.tierLabels.map((entry) => entry.tierIndex)).toEqual([0, 1, 2]);
    for (const entry of full.run.tierLabels) {
      expect(["smooth", "mostly-smooth", "choppy"]).toContain(entry.label);
    }
    expect(full.run.tierLabels.find((entry) => entry.tierIndex === 2)!.label).toBe("choppy");
  });

  it("labels a quality that only ran browser-limited as limited, whichever of its flights came first", () => {
    const flown = run.steps[3]!;
    const limited: BenchStepRecord = {
      ...flown,
      result: { ...flown.result!, raf: { ...flown.result!.raf, idleHz: 30, limited: true } },
    };
    const failed: BenchStepRecord = { ...run.steps[0]!, status: "failed", message: "the WebGPU device was lost", result: null };
    const medium = (steps: readonly BenchStepRecord[]) =>
      report(withSteps(run, steps)).run.tierLabels.find((entry) => entry.tierIndex === 1)!.label;
    expect(medium([failed, run.steps[1]!, run.steps[2]!, limited])).toBe("limited");
    expect(medium([{ ...limited, index: 0 }, run.steps[1]!, run.steps[2]!, { ...failed, index: 3 }])).toBe("limited");
    // A flight that measured the game still outranks both.
    expect(medium([failed, run.steps[1]!, run.steps[2]!, run.steps[3]!])).not.toBe("limited");
  });
});

describe("the report page's table and summary", () => {
  it("gives one row per step with a cell per column", () => {
    const rows = reportTableRows(full.steps);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.tierName)).toEqual(["Medium", "Low", "High", "Medium"]);
    for (const row of rows) expect(row.cells).toHaveLength(REPORT_TABLE_COLUMNS.length);
    expect(rows[0]!.firstRendererInTab).toBe(true);
    expect(rows[1]!.firstRendererInTab).toBe(false);
    expect(rows[0]!.fps).toBeCloseTo(full.steps[0]!.result!.windows.air!.fps!, 9);
    expect(rows[0]!.cells[1]).toBe(rows[0]!.fps!.toFixed(1));
    expect(rows[0]!.cells[7]).toMatch(/^[a-z-]+, scale \d\.\d\d, CPU \d, GPU \d$/);
  });

  it("names the outcome next to the label when a step did not finish", () => {
    const failed: BenchStepRecord = {
      ...run.steps[2]!, status: "failed", message: "the WebGPU device was lost", result: null,
    };
    const rows = reportTableRows(report(withSteps(run, [run.steps[0]!, run.steps[1]!, failed, run.steps[3]!])).steps);
    const failedReport = report(withSteps(run, [run.steps[0]!, run.steps[1]!, failed, run.steps[3]!]));
    expect(rows[2]!.cells[9]).toBe("Did not run (Failed: the WebGPU device was lost)");
    expect(rows[2]!.cells[1]).toBe("–");
    // The page's own Result leaves the message to the warnings, where it can be any length.
    expect(rows[2]!.resultText).toBe("Did not run (Failed)");
    expect(rows[0]!.resultText).toBe(rows[0]!.cells[9]);
    expect(failedReport.run.warnings).toContainEqual({
      code: "step-failed", stepIndex: 2, message: "Flight 3 (High) failed: the WebGPU device was lost.",
    });
  });

  it("reads the scale floor's share as a dash for a flight that never reached the air window", () => {
    const floor = REPORT_TABLE_COLUMNS.indexOf("At scale floor");
    const stopped = benchStepRecord(3, { tierIndex: 1, status: "early-stop" });
    const rows = reportTableRows(report(withSteps(run, [run.steps[0]!, run.steps[1]!, run.steps[2]!, stopped])).steps);
    expect(rows.map((row) => row.cells[floor])).toEqual([
      expect.stringMatching(/^\d+%$/),
      // Low has no resolution lever.
      "n/a",
      expect.stringMatching(/^\d+%$/),
      // Every other air cell of the row is a dash too.
      "–",
    ]);
    expect(rows[3]!.cells[1]).toBe("–");
    expect(stopped.result!.governor.windows.air.share.atScaleFloor).toBeNull();
    expect(stopped.result!.heap).toBeNull();
  });

  it("summarises in a few lines for chat", () => {
    const text = summaryMarkdown(full);
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      '**fly high benchmark** (shipped): "Jason\'s laptop (RTX 3060)" · nvidia ampere · Windows 11 · Chrome 130 · 60 Hz',
    );
    expect(lines[1]).toBe("| Quality | Avg fps | 1% low | Slow frames (over 27.4 ms) per 240 | Stutters (over 50 ms) per 240 | Result |");
    expect(lines).toHaveLength(9);
    expect(lines[7]).toMatch(/^Verdict: valid · spread \d+\.\d% \(limit 10%\)$/);
    expect(lines[8]).toBe("build 8813adf4c2e1 · run k3x9q2m7wp");
  });

  it("names the download after the GPU vendor and the time", () => {
    expect(reportFileName(full)).toBe("fly-high-bench-nvidia-2026-10-26T09-21-14Z.json");
  });
});

describe("warnings and earlier runs", () => {
  it("warns without voiding", () => {
    const step = run.steps[1]!;
    const odd: BenchStepRecord = {
      ...step,
      result: {
        ...step.result!,
        raf: { ...step.result!.raf, idleHz: 30, limited: true },
        timer: { granularityMs: 1, coarse: true },
        environment: { ...step.result!.environment, wakeLock: "denied", ignoredRendererCalls: 2 },
      },
    };
    const warned = {
      ...withSteps(run, [run.steps[0]!, odd, run.steps[2]!, run.steps[3]!]),
      settingsKeyAtEnd: "1a2b3c4d",
      reportRefresh: { ...run.reportRefresh!, rafHz: 48 },
    };
    const codes = collectWarnings(warned).map((entry) => `${entry.code}@${entry.stepIndex}`);
    expect(codes).toEqual([
      "refresh-changed@null",
      "settings-key-changed@null",
      "wake-lock-denied@1",
      "ignored-renderer-calls@1",
      "raf-limited@1",
      "timer-coarse@1",
    ]);
    // In the page's words: a flight and its quality, never a step or a tier.
    expect(collectWarnings(warned).find((entry) => entry.code === "raf-limited")!.message).toBe(
      "Flight 2 (Low): the browser or display ran at 30 Hz (power saving?). Left out of How it felt.",
    );
    const built = report(warned);
    expect(built.run.verdict).toBe("valid");
    expect(built.run.settingsKeyUnchanged).toBe(false);
  });

  it("carries a shipped run under the pinned pass that followed it (N6)", () => {
    const pinned = benchRunRecord({
      runId: "p1n2e3d4x5",
      mode: "pinned",
      steps: [{ tierIndex: 1, fps: 52 }, { tierIndex: 3, fps: 31 }, { tierIndex: 1, fps: 51 }],
    });
    const built = report(pinned, [run]);
    expect(built.run.plan.mode).toBe("pinned");
    expect(built.steps[1]!.result!.canvas.gpuTiming).toBe("on");
    expect(built.earlierRuns).toHaveLength(1);
    expect(built.earlierRuns[0]!.run.id).toBe("k3x9q2m7wp");
    expect(built.earlierRuns[0]!.run.plan.mode).toBe("shipped");
    expect(built.earlierRuns[0]!.steps).toHaveLength(4);
    expect(Object.keys(built.profiles)).toEqual(["0", "1", "2", "3"]);
    expect(built.profiles["3"]!.hitchThresholdMs).toBe(60);
    expect(badValues(built)).toEqual([]);
    expect(compactReportJson(built).length).toBeLessThanOrEqual(COMPACT_REPORT_MAX);
    expect(issueUrl(built).length).toBeLessThanOrEqual(ISSUE_URL_MAX);
  });
});
