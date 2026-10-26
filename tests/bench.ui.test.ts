import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noticeText } from "../src/bench/flow";
import { benchTimings, describeDuration, estimateBenchDuration } from "../src/bench/plan";
import type { BenchDeviceReport } from "../src/bench/types";
import { BenchIntro, type BenchIntroProps } from "../src/bench/ui/BenchIntro";
import { parseTierList, tierListText } from "../src/bench/ui/words";
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
