import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noticeText } from "../src/bench/flow";
import { createBenchVisualState } from "../src/bench/path";
import { BENCH_SEED, benchGameSettings, benchTimings, describeDuration, estimateBenchDuration } from "../src/bench/plan";
import { buildReport, compactReportJson, verdictText } from "../src/bench/report";
import type { BenchBuildInfo, BenchDeviceReport, BenchReport, BenchRunRecord } from "../src/bench/types";
import { BenchApp, isInsideBenchUi, type BenchView } from "../src/bench/ui/BenchApp";
import { BenchCard, BenchCards, cardWords, type BenchCardProps } from "../src/bench/ui/BenchCards";
import { BenchChip, chipAnnouncement, chipPhaseText, chipProgress, type BenchChipProps } from "../src/bench/ui/BenchChip";
import { BenchHud, BenchHudContent } from "../src/bench/ui/BenchHud";
import { BenchIntro, type BenchIntroProps } from "../src/bench/ui/BenchIntro";
import { BenchReportDialog, type BenchReportDialogProps } from "../src/bench/ui/BenchReportDialog";
import { clockText, parseTierList, tierListText } from "../src/bench/ui/words";
import { benchDevice, benchRefresh, benchRunRecord, defaultRun } from "./support/benchReportFixture";

/**
 * The bench's pages as markup (Node, no DOM): the roles, labels and buttons
 * of each variant. CSS is never imported here; bench.css is read as text.
 */

const noop = () => undefined;

const BUILD: BenchBuildInfo = {
  commit: "8813adf4c2e19b07a6d5f3e2b1c0d9e8f7a6b5c4",
  entryScript: "assets/index-4f8c2a1b.js",
  base: "/fly-high/",
  origin: "https://jazonshou.github.io",
};

function report(run: BenchRunRecord, earlier?: readonly BenchRunRecord[]): BenchReport {
  return buildReport({ run, build: BUILD, createdAt: "2026-10-26T09:21:14.381Z", ...(earlier ? { earlier } : {}) });
}

function introProps(overrides: Partial<BenchIntroProps> = {}): BenchIntroProps {
  return {
    options: { tiers: [1, 0, 2, 1], mode: "shipped", hud: true, quick: false },
    storage: "ok",
    device: benchDevice(),
    refresh: benchRefresh(60),
    checking: false,
    resumable: null,
    notice: null,
    onStart: noop,
    onResume: noop,
    onDeviceOnly: noop,
    onExit: noop,
    ...overrides,
  };
}

function intro(overrides: Partial<BenchIntroProps> = {}): string {
  return renderToStaticMarkup(createElement(BenchIntro, introProps(overrides)));
}

function withWebGpu(status: BenchDeviceReport["webgpu"]["status"], reason: string | null = null): BenchDeviceReport {
  const device = benchDevice();
  return { ...device, webgpu: { ...device.webgpu, status, reason, adapter: status === "missing" ? null : device.webgpu.adapter } };
}

/** Text as React's static markup escapes it. */
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** The button and link labels in document order. */
function actions(markup: string): string[] {
  return [...markup.matchAll(/<(button|a)\b[^>]*>([^<]*)<\/\1>/g)].map((match) => match[2]!.trim());
}

function reportDialog(value: BenchReport, overrides: Partial<BenchReportDialogProps> = {}): string {
  return renderToStaticMarkup(createElement(BenchReportDialog, {
    report: value,
    notice: null,
    copy: null,
    onDownload: noop,
    onCopy: noop,
    onPinnedPass: noop,
    onRunAgain: noop,
    onExit: noop,
    ...overrides,
  }));
}

function chipProps(overrides: Partial<BenchChipProps> = {}): BenchChipProps {
  return {
    stepIndex: 1,
    stepCount: 4,
    tierIndex: 0,
    attempt: 1,
    phase: "flying",
    flightElapsedS: 34,
    flightS: 75,
    remainingS: 260,
    stopConfirm: false,
    onStop: noop,
    onStopCancel: noop,
    onStopConfirm: noop,
    ...overrides,
  };
}

function chip(overrides: Partial<BenchChipProps> = {}): string {
  return renderToStaticMarkup(createElement(BenchChip, chipProps(overrides)));
}

describe("the intro dialog", () => {
  it("is a labelled modal that says what happens, for how long, and what to do first", () => {
    const markup = intro();
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="bench-intro-title"');
    expect(markup).toContain('aria-describedby="bench-intro-description"');
    expect(markup).toContain('id="bench-intro-title">Test how fly high runs on this computer</h2>');
    expect(markup).toContain("data-bench-ui");
    // The duration comes from plan.ts, not from a sentence written once.
    const typical = describeDuration(estimateBenchDuration(4, benchTimings(false)).typicalS);
    expect(typical).toBe("about 7 minutes");
    expect(markup).toContain(`It takes ${typical} (up to 9 minutes on a slow computer).`);
    expect(markup).toContain("flies itself 4 times");
    expect(markup).toContain("Plug in your laptop.");
    expect(markup).toContain("Keep this tab in front until the report shows.");
    expect(markup).toContain("Nothing is sent unless you send it.");
  });

  it("describes this computer as the browser does", () => {
    const markup = intro();
    expect(markup).toContain("<dt>Graphics</dt><dd>nvidia ampere</dd>");
    expect(markup).toContain("<dt>Browser</dt><dd>Chrome 130</dd>");
    expect(markup).toContain("<dt>System</dt><dd>Windows 11</dd>");
    expect(markup).toContain("<dt>Screen</dt><dd>1920 × 1080</dd>");
    expect(markup).toContain("<dt>Frame rate</dt><dd>60 Hz</dd>");
    expect(markup).toContain("<dt>Memory</dt><dd>8 GB or more</dd>");
  });

  it("has the optional, labelled, 80-character Your computer field", () => {
    const markup = intro();
    expect(markup).toContain('<label for="bench-intro-label">Your computer (GPU model if you know it)</label>');
    expect(markup).toMatch(/<input id="bench-intro-label" type="text" maxLength="80"[^>]*aria-describedby="bench-intro-label-hint"/);
    expect(markup).toContain("Optional.");
  });

  it("keeps the tier list and mode in a closed Advanced disclosure", () => {
    const markup = intro();
    expect(markup).toMatch(/<details class="bench-section bench-advanced"><summary>Advanced<\/summary>/);
    expect(markup).toContain('id="bench-intro-tiers"');
    expect(markup).toContain('value="1,0,2,1"');
    expect(markup).toContain("Medium, Low, High, Medium.");
    expect(markup).toContain("<legend>Mode</legend>");
    expect(markup).toContain('checked="" value="shipped"');
    expect(markup).not.toContain('checked="" value="pinned"');
  });

  it("opens Advanced when the URL asked for something other than the default", () => {
    const markup = intro({ options: { tiers: [1, 3, 1], mode: "pinned", hud: false, quick: true } });
    expect(markup).toMatch(/<details class="bench-section bench-advanced" open="">/);
    expect(markup).toContain('checked="" value="pinned"');
    expect(markup).toContain("Medium, Ultra, Medium.");
    expect(markup).toContain("flies itself 3 times");
    expect(markup).toContain("quick run for testing");
    expect(markup).toContain("The flight instruments are hidden for this run.");
  });

  it("offers Start and Back, and holds Start while the computer is checked", () => {
    expect(actions(intro())).toEqual(["Start benchmark", "Back to the game"]);
    expect(intro()).not.toMatch(/<button[^>]*disabled=""[^>]*>Start benchmark/);
    const checking = intro({ checking: true, device: null, refresh: null });
    expect(checking).toMatch(/<button[^>]*disabled=""[^>]*>Start benchmark/);
    expect(checking).toContain("<dt>Graphics</dt><dd>Checking…</dd>");
    expect(checking).toContain("<dt>Frame rate</dt><dd>Measuring…</dd>");
    expect(intro({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>Back to the game/);
  });

  it("explains a browser without WebGPU and offers a device-only report", () => {
    const markup = intro({ device: withWebGpu("missing", "navigator.gpu is undefined") });
    expect(markup).toContain("This browser has no WebGPU");
    expect(markup).toContain("Try the latest Chrome or Edge.");
    expect(markup).toContain("Details: navigator.gpu is undefined");
    expect(markup).toContain("The benchmark cannot run here.");
    expect(actions(markup)).toEqual(["Make a device-only report", "Back to the game"]);
    expect(markup).not.toContain("Plug in your laptop.");
    expect(markup).not.toContain("<summary>Advanced</summary>");
    // The label still goes in the device report.
    expect(markup).toContain('id="bench-intro-label"');
    for (const status of ["no-adapter", "fallback-only", "limits-short"] as const) {
      expect(actions(intro({ device: withWebGpu(status) }))[0]).toBe("Make a device-only report");
    }
  });

  it("explains a tab without storage and offers a device-only report", () => {
    const markup = intro({ storage: "unavailable" });
    expect(markup).toContain("This tab cannot save the benchmark");
    expect(markup).toContain("A private window, or site data turned off, does this.");
    expect(actions(markup)).toEqual(["Make a device-only report", "Back to the game"]);
  });

  it("offers Resume or Start over for an unfinished run of this tab", () => {
    const resumable = benchRunRecord({
      status: "running",
      steps: [{ tierIndex: 1 }, { tierIndex: 0 }, { tierIndex: 2, status: "pending" }, { tierIndex: 1, status: "pending" }],
    });
    const markup = intro({ resumable });
    expect(markup).toContain("You have an unfinished benchmark in this tab");
    expect(markup).toContain("2 of 4 flights done (Medium, Low, High, Medium).");
    expect(actions(markup)).toEqual(["Resume", "Start over", "Back to the game"]);
  });

  it("shows the flow's notice as a status line", () => {
    const markup = intro({ notice: "run-mismatch" });
    expect(markup).toContain(`<p class="bench-notice" role="status">${html(noticeText("run-mismatch"))}</p>`);
  });

  it("reads the Advanced tier list by the URL reader's rule", () => {
    expect(parseTierList("1,0,2,1")).toEqual([1, 0, 2, 1]);
    expect(parseTierList(" 1 , 3 ")).toEqual([1, 3]);
    expect(parseTierList("2")).toEqual([2]);
    expect(parseTierList("")).toBeNull();
    expect(parseTierList("1,4")).toBeNull();
    expect(parseTierList("1,,2")).toBeNull();
    expect(parseTierList("1,0,2,1,0,2,1,0")).toHaveLength(8);
    expect(parseTierList("1,0,2,1,0,2,1,0,1")).toBeNull();
    expect(tierListText([0, 3, 7])).toBe("Low, Ultra, Tier 7");
  });
});

describe("the run chip", () => {
  it("shows the flight, the quality, the phase, the time left and a progress bar", () => {
    const markup = chip();
    expect(markup).toContain('aria-label="Benchmark"');
    expect(markup).toContain("data-bench-ui");
    expect(markup).toContain("<strong>Benchmark 2/4</strong>");
    expect(markup).toContain("<span>Low</span>");
    expect(markup).toContain("<span>Flying 0:34 / 1:15</span>");
    expect(markup).toContain("<span>about 4 minutes left</span>");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="36"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(actions(markup)).toEqual(["Stop"]);
  });

  it("announces phase changes only, never the ticking clock", () => {
    const markup = chip();
    expect(markup).toContain('role="status" aria-live="polite">Flight 2 of 4, Low: flying.</p>');
    const tick = chipAnnouncement(chipProps({ flightElapsedS: 35 }));
    expect(tick).toBe(chipAnnouncement(chipProps({ flightElapsedS: 34 })));
    expect(tick).not.toMatch(/\d:\d\d/);
    expect(chipAnnouncement(chipProps({ phase: "settling" }))).toBe("Flight 2 of 4, Low: loading the scenery.");
  });

  it("words each phase plainly", () => {
    expect(chipPhaseText(chipProps({ phase: "starting" }))).toBe("Starting");
    expect(chipPhaseText(chipProps({ phase: "starting", attempt: 2 }))).toBe("Starting again (attempt 2)");
    expect(chipPhaseText(chipProps({ phase: "settling" }))).toBe("Loading the scenery");
    expect(chipPhaseText(chipProps({ phase: "done", result: { outcome: "ok", fps: 58.4 }, nextTierIndex: 2 })))
      .toBe("Low done: 58 fps. Loading High…");
    expect(chipPhaseText(chipProps({ phase: "done", result: { outcome: "early-stop", fps: 3.1 }, nextTierIndex: null })))
      .toBe("Low stopped early: under 5 fps. Opening the report…");
    expect(chipPhaseText(chipProps({ phase: "failed" }))).toBe("Low stopped");
    expect(chipPhaseText(chipProps({ phase: "stopping" }))).toBe("Stopping. Opening the report…");
    expect(chip({ phase: "done", result: { outcome: "ok", fps: 58 }, nextTierIndex: 2 })).not.toContain("left</span>");
    expect(clockText(75)).toBe("1:15");
  });

  it("measures progress over the whole run", () => {
    expect(chipProgress(chipProps({ stepIndex: 0, phase: "starting" }))).toBe(0);
    expect(chipProgress(chipProps({ stepIndex: 1, phase: "flying", flightElapsedS: 37.5 }))).toBeCloseTo(1.5 / 4);
    expect(chipProgress(chipProps({ stepIndex: 3, phase: "done" }))).toBe(1);
    expect(chipProgress(chipProps({ phase: "flying", flightElapsedS: 500 }))).toBe(2 / 4);
  });

  it("asks before stopping, inside the chip", () => {
    const markup = chip({ stopConfirm: true });
    expect(markup).toContain('role="group" aria-labelledby="bench-chip-confirm"');
    expect(markup).toContain("Stop the benchmark? Finished flights stay in the report.");
    expect(actions(markup)).toEqual(["Stop now", "Keep going"]);
    expect(actions(chip({ phase: "stopping" }))).toEqual([]);
    const source = readFileSync(new URL("../src/bench/ui/BenchChip.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/window\.confirm\s*\(/);
  });
});

describe("the step page's cards", () => {
  const card = (props: BenchCardProps) => renderToStaticMarkup(createElement(BenchCard, props));

  it("says a hidden tab paused the flight and when it restarts", () => {
    const markup = card({ kind: "hidden", tierIndex: 0, attempt: 1, maxAttempts: 2 });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<strong>Paused because you switched away</strong>");
    expect(markup).toContain("This flight restarts when you are back (attempt 2 of 2).");
    expect(cardWords({ kind: "hidden", tierIndex: 0, attempt: 2, maxAttempts: 2 }).text)
      .toBe("That was the last try at Low, so the benchmark moves on to the next flight.");
  });

  it("says a resize voided the flight", () => {
    const markup = card({ kind: "resized", tierIndex: 2, attempt: 1, maxAttempts: 2 });
    expect(markup).toContain("<strong>The window changed size</strong>");
    expect(markup).toContain("cannot be compared");
    expect(markup).toContain("(attempt 2 of 2)");
  });

  it("says a flight failed and counts down to the next", () => {
    const markup = card({ kind: "failed", tierIndex: 0, message: "the WebGPU device was lost", continueInS: 5, onContinue: noop });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<strong>Low stopped</strong>");
    expect(markup).toContain("<span>The WebGPU device was lost.</span>");
    expect(markup).toContain("Continuing in 5 s.");
    expect(actions(markup)).toEqual(["Continue now"]);
    expect(actions(card({ kind: "failed", tierIndex: 0, message: "startup timeout" }))).toEqual([]);
  });

  it("explains a second try and the flow's notices politely", () => {
    const retry = card({
      kind: "retry",
      tierIndex: 0,
      previous: { attempt: 1, outcome: "interrupted", navigationType: "reload", at: "2026-10-26T09:15:00.000Z" },
      attempt: 2,
      maxAttempts: 2,
    });
    expect(retry).toContain('role="status"');
    expect(retry).toContain("The last try at Low closed the page. Trying again (attempt 2 of 2).");
    expect(card({ kind: "notice", notice: "crash-skipped" })).toContain(html(noticeText("crash-skipped")));
  });

  it("puts notes under the chip and alerts in the middle", () => {
    const markup = renderToStaticMarkup(createElement(BenchCards, {
      cards: [
        { kind: "notice", notice: "crash-skipped" },
        { kind: "failed", tierIndex: 1, message: "startup timeout" },
      ],
    }));
    expect(markup).toMatch(/bench-cards--notes"><div class="bench-card bench-card--note" role="status"/);
    expect(markup).toMatch(/bench-cards--alerts"><div class="bench-card bench-card--alert" role="alert"/);
    expect(renderToStaticMarkup(createElement(BenchCards, { cards: [] }))).toBe("");
  });
});

describe("the report dialog", () => {
  const valid = report(defaultRun());

  it("is a labelled modal with a verdict banner", () => {
    expect(valid.run.verdict).toBe("valid");
    const markup = reportDialog(valid);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="bench-report-title"');
    expect(markup).toContain('aria-describedby="bench-report-description"');
    expect(markup).toContain(`<p class="bench-verdict bench-verdict--valid">${html(verdictText(valid.run))}</p>`);
    expect(markup).toContain("nvidia ampere · Windows 11 · Chrome 130 · 60 Hz");
  });

  it("has one row per flight with the air and runway numbers and the plain label", () => {
    const markup = reportDialog(valid);
    const table = /<table class="bench-table">[\s\S]*?<\/table>/.exec(markup)![0];
    const rows = [...table.matchAll(/<tr><th scope="row">(\d+)<\/th>([\s\S]*?)<\/tr>/g)];
    expect(rows.map((row) => row[1])).toEqual(["1", "2", "3", "4"]);
    expect(table).toContain('<th scope="col">In the air</th>');
    expect(table).toContain('<th scope="col">On the runway</th>');
    for (const [index, row] of rows.entries()) {
      const step = valid.steps[index]!;
      const cells = [...row[2]!.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((cell) => cell[1]);
      expect(cells[1]).toMatch(/^(Smooth|Mostly smooth|Choppy)/);
      expect(cells[2]).toBe(`${Math.round(step.result!.windows.air!.fps!)} fps`);
      expect(cells[3]).toBe(step.result!.windows.air!.over["27.4"].per240.toFixed(1));
      expect(cells[4]).toBe(`${Math.round(step.result!.windows.ground!.fps!)} fps`);
      expect(cells[5]).toBe(step.result!.windows.ground!.over["27.4"].per240.toFixed(1));
    }
    expect(rows[0]![2]).toContain("Medium *");
    expect(markup).toContain("The first flight also prepares the graphics");
    expect(markup).toContain("<summary>All numbers</summary>");
    expect(markup).toContain("How it felt");
  });

  it("lists the buttons in order, the download first and the issue as a new-tab link", () => {
    const markup = reportDialog(valid);
    expect(actions(markup)).toEqual([
      "Download report (.json)",
      "Open GitHub issue",
      "Copy report",
      "Copy short summary",
      "Run the GPU comparison pass",
      "Run again",
      "Exit",
    ]);
    expect(markup).toMatch(/<button type="button" class="bench-action bench-action--primary">Download report \(\.json\)<\/button>/);
    const link = /<a [^>]*>Open GitHub issue<\/a>/.exec(markup)![0];
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener"');
    expect(link).toContain('href="https://github.com/jazonshou/fly-high/issues/new?title=');
    expect(link).toContain('aria-describedby="bench-report-issue-hint"');
    expect(markup).toContain("fly-high-bench-nvidia-2026-10-26T09-21-14Z.json");
    expect(markup).not.toContain("<textarea");
  });

  it("copies the compact report from the issue link's own click", () => {
    const source = readFileSync(new URL("../src/bench/ui/BenchReportDialog.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/onClick=\{\(\) => props\.onCopy\("issue", compactJson\)\}/);
    expect(source).toContain("compactReportJson(report)");
    expect(source).not.toMatch(/\bawait\b|window\.open/);
  });

  it("shows a void run's reasons", () => {
    const run = benchRunRecord({ steps: [{ tierIndex: 1, fps: 58 }, { tierIndex: 0, fps: 60 }, { tierIndex: 1, fps: 45 }] });
    const value = report(run);
    expect(value.run.verdict).toBe("void");
    const markup = reportDialog(value);
    expect(markup).toContain('class="bench-verdict bench-verdict--void"');
    expect(markup).toContain("flights differ by");
    expect(markup).toContain("run it again");
  });

  it("shows a stopped run as incomplete with its skipped flights", () => {
    const run = benchRunRecord({
      status: "stopped",
      steps: [{ tierIndex: 1 }, { tierIndex: 0 }, { tierIndex: 2, status: "skipped" }, { tierIndex: 1, status: "skipped" }],
    });
    const markup = reportDialog(report(run));
    expect(markup).toContain('class="bench-verdict bench-verdict--incomplete"');
    expect(markup).toContain("Did not run (Skipped)");
    expect(actions(markup)).toContain("Run again");
  });

  it("offers no second GPU comparison pass on a pinned run", () => {
    const markup = reportDialog(report(defaultRun({ mode: "pinned" })));
    expect(markup).toContain("GPU comparison run");
    expect(actions(markup)).not.toContain("Run the GPU comparison pass");
    expect(actions(markup)).toContain("Run again");
  });

  it("shows a device-only report without a table or run buttons", () => {
    const device = withWebGpu("missing");
    const run = benchRunRecord({
      status: "no-webgpu",
      device,
      steps: [1, 0, 2, 1].map((tierIndex) => ({ tierIndex, status: "skipped" as const })),
    });
    const markup = reportDialog(report(run));
    expect(markup).toContain('class="bench-verdict bench-verdict--device"');
    expect(markup).toContain("this browser cannot run the game");
    expect(markup).not.toContain("<table");
    expect(actions(markup)).toEqual(["Download report (.json)", "Open GitHub issue", "Copy report", "Copy short summary", "Exit"]);
    const storage = reportDialog(report({ ...run, status: "storage-unavailable" }));
    expect(storage).toContain("this tab cannot keep the benchmark");
  });

  it("falls back to a read-only, labelled textarea when the browser will not copy", () => {
    const text = compactReportJson(valid);
    const markup = reportDialog(valid, { copy: { target: "report", status: "failed", text } });
    expect(markup).toMatch(/<label for="bench-report-fallback">The browser would not let the page copy\./);
    expect(markup).toMatch(/<textarea id="bench-report-fallback" readOnly="" rows="8"/);
    expect(markup).toContain("&quot;schema&quot;:&quot;fly-high.bench/1&quot;");
    const copied = reportDialog(valid, { copy: { target: "issue", status: "copied", text } });
    expect(copied).toContain('role="status">Report copied. Paste it into the empty block in the GitHub issue.</p>');
    expect(copied).not.toContain("<textarea");
  });

  it("shows the notice and the earlier run a GPU comparison pass keeps", () => {
    const earlier = defaultRun({ runId: "a1b2c3d4e5" });
    const markup = reportDialog(report(defaultRun({ mode: "pinned" }), [earlier]), { notice: "storage-failed" });
    expect(markup).toContain(html(noticeText("storage-failed")));
    expect(markup).toContain("<h3>Earlier run in this tab (as players get it)</h3>");
    expect(markup).toContain("Each flight of the earlier run");
  });
});

describe("the bench HUD", () => {
  it("is the game's full HUD for a chase-camera flight, with no buttons or diagnostics", () => {
    const markup = renderToStaticMarkup(createElement(BenchHudContent, {
      state: createBenchVisualState(),
      settings: benchGameSettings(1),
      seed: BENCH_SEED,
    }));
    expect(markup).toContain('class="flight-hud flight-hud--full"');
    expect(markup).toContain("<span>CHASE CAM</span>");
    expect(markup).toContain("<span>WORLD 00762M</span>");
    expect(markup).toContain("metric-tape");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Performance diagnostics");
  });

  it("draws nothing without the shell to portal into", () => {
    expect(renderToStaticMarkup(createElement(BenchHud, {
      container: null,
      state: createBenchVisualState(),
      settings: benchGameSettings(1),
      seed: BENCH_SEED,
    }))).toBe("");
  });
});

describe("the bench app", () => {
  it("shows the page the view names", () => {
    const render = (view: BenchView) => renderToStaticMarkup(createElement(BenchApp, { view }));
    expect(render({ kind: "intro", intro: introProps() })).toContain('id="bench-intro"');
    const step = render({
      kind: "step",
      chip: chipProps(),
      cards: [{ kind: "notice", notice: "crash-skipped" }],
      hud: null,
    });
    expect(step).toContain('class="bench-chip"');
    expect(step).toContain(html(noticeText("crash-skipped")));
    expect(render({
      kind: "report",
      report: { report: report(defaultRun()), notice: null, copy: null, onDownload: noop, onCopy: noop, onPinnedPass: noop, onRunAgain: noop, onExit: noop },
    })).toContain('id="bench-report"');
    expect(render({ kind: "none" })).toBe("");
    expect(isInsideBenchUi(null)).toBe(false);
  });

  it("reads no storage and never reaches the renderer", () => {
    const root = join(__dirname, "..", "src", "bench", "ui");
    for (const name of readdirSync(root)) {
      const source = readFileSync(join(root, name), "utf8");
      expect(source, name).not.toMatch(/sessionStorage|localStorage|getDiagnostics|FlightRenderer/);
      for (const [, from] of source.matchAll(/from "([^"]+)"/g)) {
        expect(from, `${name} imports ${from}`).toMatch(
          /^(react|react-dom|\.\.\/(flow|plan|report|types)|\.\/\w+|@\/src\/(ui\/\w+|settings|game\/types))$/,
        );
      }
    }
  });
});
