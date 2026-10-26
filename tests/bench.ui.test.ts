import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noticeText } from "../src/bench/flow";
import { benchTimings, describeDuration, estimateBenchDuration } from "../src/bench/plan";
import type { BenchDeviceReport } from "../src/bench/types";
import { BenchCard, BenchCards, cardWords, type BenchCardProps } from "../src/bench/ui/BenchCards";
import { BenchChip, chipAnnouncement, chipPhaseText, chipProgress, type BenchChipProps } from "../src/bench/ui/BenchChip";
import { BenchIntro, type BenchIntroProps } from "../src/bench/ui/BenchIntro";
import { clockText, parseTierList, tierListText } from "../src/bench/ui/words";
import { benchDevice, benchRefresh, benchRunRecord } from "./support/benchReportFixture";

/**
 * The bench's pages as markup (Node, no DOM): the roles, labels and buttons
 * of each variant. CSS is never imported here; bench.css is read as text.
 */

const noop = () => undefined;

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
