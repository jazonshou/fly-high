import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { benchFlow, startRun, type StartRunInput } from "../src/bench/flow";
import type { BenchHost } from "../src/bench/session";
import { BENCH_STORE_KEY, openBenchStore, parseBenchStore, serializeBenchStore } from "../src/bench/store";
import type { BenchStepRecord } from "../src/bench/types";
import type { BenchView } from "../src/bench/ui/BenchApp";
import { readBenchFromUrl } from "../src/settings";

/**
 * A step page's session against a hand-made browser: a window and document
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

function startInput(): StartRunInput {
  return {
    runId: "k3x9q2m7wp",
    options: { tiers: [1, 0], mode: "shipped", hud: false, quick: true },
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

/** Step 0 of a fresh two-step run, opened in a fresh module: one page load. */
async function openStep(visibility: "visible" | "hidden") {
  const browser = fakeBrowser(visibility);
  const { storage, items } = memoryStorage();
  const start = startRun(startInput(), `${PAGE}?bench=1&quick=1&tiers=1,0`);
  items.set(BENCH_STORE_KEY, serializeBenchStore(start.store));
  const go = vi.fn<(href: string) => void>();
  const host: BenchHost = { href: start.href, storage, navigationType: "navigate", isoNow: () => NOW, go };
  vi.resetModules();
  const { openBenchSession } = await import("../src/bench/session");
  const opening = openBenchSession(readBenchFromUrl(start.href)!, host);
  // The step's idle refresh probe runs to its deadline on fake timers.
  await vi.advanceTimersByTimeAsync(2_500);
  const session = await opening;
  const step = (): BenchStepRecord => parseBenchStore(items.get(BENCH_STORE_KEY) ?? null)!.current!.steps[0]!;
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
    expect(page.lastView().cards.map((card) => card.kind)).toEqual(["hidden"]);
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
