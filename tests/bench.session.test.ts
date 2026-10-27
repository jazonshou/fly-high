import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchHost } from "../src/bench/session";
import { startRun, type StartRunInput } from "../src/bench/flow";
import { BENCH_STORE_KEY, serializeBenchStore } from "../src/bench/store";
import type { FlightRenderer } from "../src/render/FlightRenderer";
import { readBenchFromUrl } from "../src/settings";

/**
 * The session is opened once per page load: FlightGame's bootstrap effect
 * may run twice (StrictMode in development), and both runs must get the same
 * session, with the store read and written once. These pages only redirect,
 * so nothing here needs a DOM.
 */

const PAGE = "https://jazonshou.github.io/fly-high/";
const NOW = "2026-10-26T09:14:03.511Z";

/** A tab's session storage; `full` refuses any write that would change what is stored. */
function memoryStorage(full = false) {
  const items = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => {
    if (full && items.get(key) !== value) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    items.set(key, value);
  });
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem,
    removeItem: (key: string) => items.delete(key),
  } as unknown as Storage;
  return { storage, items, setItem };
}

function host(href: string, storage: Storage) {
  const go = vi.fn<(href: string) => void>();
  const page: BenchHost = { href, storage, navigationType: "navigate", isoNow: () => NOW, go };
  return { ...page, go };
}

function startInput(): StartRunInput {
  return {
    runId: "k3x9q2m7wp",
    options: { tiers: [1, 0], mode: "shipped", hud: true, quick: true },
    device: null,
    introRefresh: null,
    userLabel: null,
    firstLoad: null,
    ignoredParams: [],
    settingsKey: "absent",
    now: NOW,
  };
}

/** A fresh module: the memo lives for one page load, which is one module instance. */
async function freshSession() {
  vi.resetModules();
  return await import("../src/bench/session");
}

describe("the bench session", () => {
  // The first import transforms the renderer and Babylon; later fresh imports reuse that.
  beforeAll(async () => {
    await import("../src/bench/session");
  }, 60_000);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is opened once per page load, however often FlightGame asks", async () => {
    const { openBenchSession } = await freshSession();
    const { storage, setItem } = memoryStorage();
    const page = host(`${PAGE}?bench=1&tiers=1,0&mode=shipped&quick=1&run=zzzzzz9999&step=0`, storage);
    const request = readBenchFromUrl(page.href)!;

    const first = openBenchSession(request, page);
    const second = openBenchSession(request, page);
    expect(second).toBe(first);
    const session = await first;
    expect(await second).toBe(session);

    // No run in this tab: back to the intro, with the notice saved once.
    expect(page.go).toHaveBeenCalledTimes(1);
    expect(page.go).toHaveBeenCalledWith(`${PAGE}?bench=1&tiers=1,0&mode=shipped&quick=1`);
    expect(setItem.mock.calls.filter(([key]) => key === BENCH_STORE_KEY)).toHaveLength(2);
    expect(session.boot).toBeNull();
  });

  it("boots nothing on a page that creates no renderer", async () => {
    const { openBenchSession } = await freshSession();
    const { storage } = memoryStorage();
    const page = host(`${PAGE}?bench=1&run=zzzzzz9999&step=report`, storage);
    const session = await openBenchSession(readBenchFromUrl(page.href)!, page);
    const renderer = { name: "renderer" } as unknown as FlightRenderer;
    expect(session.boot).toBeNull();
    expect(session.rendererOptions({} as HTMLCanvasElement)).toEqual({});
    expect(session.attach(renderer, {} as never)).toBe(renderer);
  });

  it("goes to the report when a step cannot claim itself", async () => {
    const { openBenchSession } = await freshSession();
    const { storage, items } = memoryStorage(true);
    const start = startRun(startInput(), `${PAGE}?bench=1`);
    items.set(BENCH_STORE_KEY, serializeBenchStore(start.store));
    const page = host(start.href, storage);
    const session = await openBenchSession(readBenchFromUrl(page.href)!, page);
    expect(session.boot).toBeNull();
    expect(page.go).toHaveBeenCalledTimes(1);
    expect(page.go.mock.calls[0]![0]).toContain("&run=k3x9q2m7wp&step=report");
  });
});
