import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { benchFlow, recordStepResult, startRun, type StartRunInput } from "../src/bench/flow";
import { exitUrl, introUrl, reportUrl } from "../src/bench/plan";
import type { BenchHost } from "../src/bench/session";
import { BENCH_STORE_KEY, openBenchStore, parseBenchStore, serializeBenchStore } from "../src/bench/store";
import type { BenchStepRecord } from "../src/bench/types";
import type { BenchView } from "../src/bench/ui/BenchApp";
import { readBenchFromUrl, type FrameRateSetting } from "../src/settings";
import { benchStepResult } from "./support/benchReportFixture";

/**
 * A bench page's session against a hand-made browser: a window and document
 * that are plain event targets, rAF on fake timers, and a React root that
 * only keeps the views it is handed. Enough of a page to hide and show the
 * tab and read what the session saved and showed.
 */

const views = vi.hoisted(() => [] as BenchView[]);
vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (element: { readonly props: { readonly view: BenchView } }) => {
      views.push(element.props.view);
    },
    unmount: () => undefined,
  }),
}));

const PAGE = "https://jazonshou.github.io/fly-high/";
const NOW = "2026-10-26T09:14:03.511Z";

function memoryStorage() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  } as unknown as Storage;
  return { storage, items };
}

function startInput(frameRate: FrameRateSetting = "60"): StartRunInput {
  return {
    runId: "k3x9q2m7wp",
    options: { tiers: [1, 0], mode: "shipped", hud: false, quick: true, frameRate },
    device: null,
    introRefresh: null,
    userLabel: null,
    firstLoad: null,
    ignoredParams: [],
    settingsKey: "absent",
    now: NOW,
  };
}

/** The browser globals a step page reaches, with the tab's visibility to switch. */
function fakeBrowser(visibilityState: "visible" | "hidden") {
  const view = Object.assign(new EventTarget(), { innerWidth: 1_280, innerHeight: 720, devicePixelRatio: 1 });
  const page = Object.assign(new EventTarget(), {
    visibilityState: visibilityState as string,
    readyState: "complete",
    documentElement: { dataset: {} as Record<string, string> },
    body: { append: () => undefined },
    createElement: () => ({ className: "" }),
    querySelector: () => null,
    hasFocus: () => true,
  });
  vi.stubGlobal("window", view);
  vi.stubGlobal("document", page);
  vi.stubGlobal("location", new URL(PAGE));
  vi.stubGlobal("requestAnimationFrame", (callback: (timestamp: number) => void) =>
    setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  return {
    page,
    show(state: "visible" | "hidden") {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

/**
 * Step 0 of a fresh two-step run, or step 1 once step 0 has flown, opened in
 * a fresh module: one page load.
 */
async function openStep(visibility: "visible" | "hidden", stepIndex: 0 | 1 = 0, frameRate: FrameRateSetting = "60") {
  const browser = fakeBrowser(visibility);
  const { storage, items } = memoryStorage();
  const fresh = startRun(startInput(frameRate), `${PAGE}?bench=1&quick=1&tiers=1,0`);
  const start = stepIndex === 0
    ? fresh
    : recordStepResult(fresh.store, 0, "ok", benchStepResult({ tierIndex: 1, quick: true }), "absent", fresh.href);
  items.set(BENCH_STORE_KEY, serializeBenchStore(start.store));
  const go = vi.fn<(href: string) => void>();
  const host: BenchHost = { href: start.href, storage, navigationType: "navigate", isoNow: () => NOW, go };
  vi.resetModules();
  const { openBenchSession } = await import("../src/bench/session");
  const opening = openBenchSession(readBenchFromUrl(start.href)!, host);
  // The step's idle refresh probe runs to its deadline on fake timers.
  await vi.advanceTimersByTimeAsync(2_500);
  const session = await opening;
  const step = (): BenchStepRecord => parseBenchStore(items.get(BENCH_STORE_KEY) ?? null)!.current!.steps[stepIndex]!;
  const lastView = () => {
    const shown = views[views.length - 1];
    if (shown?.kind !== "step") throw new Error(`not a step view: ${shown?.kind}`);
    return shown;
  };
  return { browser, storage, start, go, session, step, lastView };
}

describe("a step page whose tab is hidden", () => {
  beforeAll(async () => {
    // The first import transforms the renderer and Babylon; later fresh imports reuse that.
    await import("../src/bench/session");
  }, 60_000);

  beforeEach(() => {
    views.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves nothing while hidden, then voids the attempt and reloads the step once the person is back", async () => {
    const page = await openStep("visible");
    expect(page.session.boot).not.toBeNull();
    expect(page.step()).toMatchObject({ status: "running", attempts: 1, attemptLog: [] });

    page.browser.show("hidden");
    // Still claimed: a reload hides the page on its way out too.
    expect(page.step()).toMatchObject({ status: "running", attempts: 1, attemptLog: [] });
    expect(page.lastView().cards).toMatchObject([{ kind: "hidden", reportNext: false }]);
    expect(page.lastView().chip.phase).toBe("paused");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.go).not.toHaveBeenCalled();

    page.browser.show("visible");
    expect(page.step()).toMatchObject({ status: "pending", attempts: 1 });
    expect(page.step().attemptLog).toEqual([{ attempt: 1, outcome: "void-hidden", navigationType: null, at: NOW }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.go).toHaveBeenCalledTimes(1);
    expect(page.go).toHaveBeenCalledWith(page.start.href);
  });

  it("leaves a reload that hid the page claimed, so the next load records it as interrupted", async () => {
    const page = await openStep("visible");
    page.browser.show("hidden");
    // The page is gone; the reload reads the store.
    const request = readBenchFromUrl(page.start.href)!;
    const next = benchFlow({ request, read: openBenchStore(page.storage), navigationType: "reload", href: page.start.href, now: NOW });
    expect(next.page.kind).toBe("step");
    if (next.page.kind !== "step") return;
    expect(next.page.attempt).toBe(2);
    expect(next.page.previous).toEqual({ attempt: 1, outcome: "interrupted", navigationType: "reload", at: NOW });
  });

  it("boots the flight with the run's frame rate", async () => {
    const page = await openStep("visible", 0, "30");
    expect(page.start.href).toContain("&fps=30");
    expect(page.session.boot?.settings).toMatchObject({ quality: "medium", frameRate: "30" });
  });

  it("says the report comes next on the plan's last flight", async () => {
    const page = await openStep("visible", 1);
    expect(page.step()).toMatchObject({ status: "running", tierIndex: 0 });
    page.browser.show("hidden");
    expect(page.lastView().cards).toMatchObject([{ kind: "hidden", reportNext: true }]);
  });

  it("voids an attempt whose page loaded hidden, boots nothing, and waits for the person", async () => {
    const page = await openStep("hidden");
    expect(page.session.boot).toBeNull();
    expect(page.lastView().cards.map((card) => card.kind)).toEqual(["hidden"]);
    expect(page.step()).toMatchObject({ status: "running", attempts: 1 });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(page.go).not.toHaveBeenCalled();

    page.browser.show("visible");
    expect(page.step()).toMatchObject({ status: "pending", attempts: 1 });
    expect(page.step().attemptLog.map((note) => note.outcome)).toEqual(["void-hidden"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.go).toHaveBeenCalledWith(page.start.href);
  });
});

describe("a bench page that cannot set itself up", () => {
  beforeEach(() => {
    views.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The report page of a two-step run whose first step saved `result`. */
  async function openReport(result: unknown) {
    fakeBrowser("visible");
    const { storage, items } = memoryStorage();
    const start = startRun(startInput(), `${PAGE}?bench=1&quick=1&tiers=1,0`);
    const flown = recordStepResult(start.store, 0, "ok", result as never, "absent", start.href);
    items.set(BENCH_STORE_KEY, serializeBenchStore(flown.store));
    const href = reportUrl(start.href, start.store.current!.runId, { tiers: [1, 0], mode: "shipped", hud: false, quick: true, frameRate: "60" });
    const go = vi.fn<(href: string) => void>();
    const host: BenchHost = { href, storage, navigationType: "navigate", isoNow: () => NOW, go };
    vi.resetModules();
    const { openBenchSession } = await import("../src/bench/session");
    const session = await openBenchSession(readBenchFromUrl(href)!, host);
    return { session, go, items, href, shown: views[views.length - 1] };
  }

  it("shows the report of a run it can read (the control)", async () => {
    const page = await openReport(benchStepResult({ tierIndex: 1, quick: true }));
    expect(page.shown?.kind).toBe("report");
  });

  it("shows a way out, not a blank page, for a saved result it cannot read", async () => {
    // A result in another build's shape: the store takes it, the report cannot.
    const page = await openReport({});
    expect(page.session.boot).toBeNull();
    const shown = page.shown;
    if (shown?.kind !== "failed") throw new Error(`not a failure: ${shown?.kind}`);
    expect(shown.failure.message).toMatch(/undefined/u);
    expect(shown.failure.onDownload).not.toBeNull();
    expect(page.go).not.toHaveBeenCalled();

    shown.failure.onStartOver();
    expect(page.go).toHaveBeenLastCalledWith(introUrl(page.href, { tiers: [1, 0], mode: "shipped", hud: false, quick: true, frameRate: "60" }));
    expect(page.items.has(BENCH_STORE_KEY)).toBe(false);
    shown.failure.onExit();
    expect(page.go).toHaveBeenLastCalledWith(exitUrl(page.href));
  });
});
