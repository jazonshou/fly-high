import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchFlow,
  benchUserLabel,
  deviceOnlyRun,
  failStep,
  nextStepIndex,
  noticeText,
  recordReportExtras,
  recordStepResult,
  startDeviceOnlyRun,
  startPinnedPass,
  startRun,
  stopRun,
  voidAttempt,
  type BenchFlowDecision,
  type StartRunInput,
} from "../src/bench/flow";
import { exitUrl } from "../src/bench/plan";
import { buildReport } from "../src/bench/report";
import { SETTINGS_KEY_ABSENT, SETTINGS_KEY_UNREADABLE, hashSettingsKey, settingsReader } from "../src/bench/settingsGuard";
import {
  BENCH_STORE_KEY,
  EMPTY_BENCH_STORE,
  benchSessionStorage,
  clearBenchStore,
  openBenchStore,
  parseBenchStore,
  readBenchStore,
  serializeBenchStore,
  writeBenchStore,
} from "../src/bench/store";
import type { BenchStore } from "../src/bench/types";
import { SETTINGS_STORAGE_KEY, readBenchFromUrl } from "../src/settings";
import { benchDevice, benchRefresh, benchStepResult } from "./support/benchReportFixture";
import { stripComments } from "./support/sourceText";

const PAGE = "https://jazonshou.github.io/fly-high/";
const INTRO = `${PAGE}?bench=1`;
const NOW = "2026-10-26T09:14:03.511Z";

/** A tab's session storage, with switches for the ways a real one fails. */
function memoryStorage() {
  const items = new Map<string, string>();
  const control = { failReads: false, failWrites: false };
  const storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem(key: string): string | null {
      if (control.failReads) throw new DOMException("The operation is insecure.", "SecurityError");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (control.failWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      items.set(key, String(value));
    },
    removeItem(key: string): void {
      if (control.failWrites) throw new DOMException("The operation is insecure.", "SecurityError");
      items.delete(key);
    },
  } as unknown as Storage;
  return { storage, items, control };
}

/** One page load, as session.ts runs it: read, decide, save. */
function load(storage: Storage, href: string, navigationType = "navigate", now = NOW): BenchFlowDecision {
  const request = readBenchFromUrl(href);
  if (!request) throw new Error(`not a bench URL: ${href}`);
  const decision = benchFlow({ request, read: openBenchStore(storage), navigationType, href, now });
  if (decision.save) writeBenchStore(storage, decision.save);
  return decision;
}

function stored(storage: Storage): BenchStore {
  const read = readBenchStore(storage);
  if (read.kind !== "ok") throw new Error(`store is ${read.kind}`);
  return read.store;
}

function startInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    runId: "k3x9q2m7wp",
    options: { tiers: [1, 0, 2, 1], mode: "shipped", hud: true, quick: false },
    device: benchDevice(),
    introRefresh: benchRefresh(60),
    userLabel: "  Jason's   laptop ",
    firstLoad: { navigationType: "navigate", httpCache: null },
    ignoredParams: ["world=ab12"],
    settingsKey: SETTINGS_KEY_ABSENT,
    now: NOW,
    ...overrides,
  };
}

/** Start, then claim step 0 on its own page load. */
function started(storage: Storage): { readonly href: string; readonly decision: BenchFlowDecision } {
  const start = startRun(startInput(), INTRO);
  writeBenchStore(storage, start.store);
  return { href: start.href, decision: load(storage, start.href) };
}

describe("the run store", () => {
  it("reads nothing as an empty store, and round-trips what it writes", () => {
    const { storage, items } = memoryStorage();
    expect(readBenchStore(storage)).toEqual({ kind: "ok", store: EMPTY_BENCH_STORE });
    const store = startRun(startInput(), INTRO).store;
    expect(writeBenchStore(storage, store)).toBe(true);
    expect([...items.keys()]).toEqual([BENCH_STORE_KEY]);
    expect(stored(storage)).toEqual(store);
    expect(clearBenchStore(storage)).toBe(true);
    expect(items.size).toBe(0);
  });

  it("reads a key that is not a run store as corrupt", () => {
    const store = startRun(startInput(), INTRO).store;
    const text = serializeBenchStore(store);
    expect(parseBenchStore(text)).toEqual(store);
    expect(parseBenchStore("{not json")).toBeNull();
    expect(parseBenchStore(JSON.stringify({ ...store, v: 2 }))).toBeNull();
    expect(parseBenchStore(JSON.stringify({ ...store, notice: "nope" }))).toBeNull();
    const run = store.current!;
    expect(parseBenchStore(JSON.stringify({ ...store, current: { ...run, steps: run.steps.slice(1) } }))).toBeNull();
    expect(parseBenchStore(JSON.stringify({
      ...store,
      current: { ...run, steps: run.steps.map((step) => ({ ...step, status: "done" })) },
    }))).toBeNull();
    const { storage } = memoryStorage();
    storage.setItem(BENCH_STORE_KEY, "{not json");
    expect(readBenchStore(storage)).toEqual({ kind: "corrupt" });
  });

  it("reports storage that cannot be read or written as unavailable, and never throws", () => {
    const blocked = memoryStorage();
    blocked.control.failReads = true;
    expect(readBenchStore(blocked.storage)).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("SecurityError") });
    const full = memoryStorage();
    full.control.failWrites = true;
    expect(readBenchStore(full.storage).kind).toBe("ok");
    expect(openBenchStore(full.storage)).toEqual({ kind: "unavailable", reason: "session storage cannot be written" });
    expect(writeBenchStore(full.storage, EMPTY_BENCH_STORE)).toBe(false);
    expect(clearBenchStore(full.storage)).toBe(false);
    // Node has no window: the accessor gives null, and every call copes.
    expect(benchSessionStorage()).toBeNull();
    expect(readBenchStore(null).kind).toBe("unavailable");
    expect(writeBenchStore(null, EMPTY_BENCH_STORE)).toBe(false);
  });

  it("probes a writable store without leaving a key behind", () => {
    const { storage, items } = memoryStorage();
    expect(openBenchStore(storage).kind).toBe("ok");
    expect(items.size).toBe(0);
  });
});

describe("the page flow", () => {
  it("goes intro → steps → report", () => {
    const { storage } = memoryStorage();
    const intro = load(storage, INTRO);
    expect(intro.page).toEqual({ kind: "intro", storage: "ok", resumable: null, notice: null });
    expect(intro.save).toBeNull();

    const start = startRun(startInput(), INTRO);
    expect(start.href).toBe(`${PAGE}?bench=1&run=k3x9q2m7wp&step=0&seed=00762m&tiers=1,0,2,1&mode=shipped`);
    expect(start.store.current!.userLabel).toBe("Jason's laptop");
    expect(start.store.current!.settingsKeyAtStart).toBe("absent");
    writeBenchStore(storage, start.store);

    let href = start.href;
    for (let index = 0; index < 4; index += 1) {
      const decision = load(storage, href);
      expect(decision.page).toMatchObject({ kind: "step", stepIndex: index, attempt: 1, previous: null });
      expect(decision.onSaveFailed).toBe(`${PAGE}?bench=1&run=k3x9q2m7wp&step=report&tiers=1,0,2,1&mode=shipped`);
      // The claim is saved before the renderer exists.
      expect(stored(storage).current!.steps[index]).toMatchObject({ status: "running", attempts: 1 });
      const tierIndex = stored(storage).current!.steps[index]!.tierIndex;
      const next = recordStepResult(
        stored(storage), index, "ok", benchStepResult({ tierIndex, fps: index === 3 ? 57 : 58, decisions: 4 }), "absent", href,
      );
      writeBenchStore(storage, next.store);
      href = next.href;
    }
    expect(href).toBe(`${PAGE}?bench=1&run=k3x9q2m7wp&step=report&tiers=1,0,2,1&mode=shipped`);

    const report = load(storage, href);
    expect(report.page.kind).toBe("report");
    const run = stored(storage).current!;
    expect(run.status).toBe("finished");
    expect(run.finishedAt).toBe(NOW);
    expect(run.steps.map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(run.settingsKeyAtEnd).toBe("absent");
    // A reload of the report changes nothing.
    expect(load(storage, href).save).toBeNull();
    const built = buildReport({ run, build: { commit: null, entryScript: null, base: "/fly-high/", origin: PAGE }, createdAt: NOW });
    expect(built.run.verdict).toBe("valid");
    expect(built.run.settingsKeyUnchanged).toBe(true);
  });

  it("marks a step found running on reload interrupted, retries it once, then skips it", () => {
    const { storage } = memoryStorage();
    const { href } = started(storage);
    const retried = load(storage, href, "reload");
    expect(retried.page).toMatchObject({
      kind: "step",
      stepIndex: 0,
      attempt: 2,
      previous: { attempt: 1, outcome: "interrupted", navigationType: "reload", at: NOW },
    });
    expect(stored(storage).current!.steps[0]).toMatchObject({ status: "running", attempts: 2 });

    const skipped = load(storage, href, "reload");
    expect(skipped.page).toEqual({
      kind: "redirect",
      href: `${PAGE}?bench=1&run=k3x9q2m7wp&step=1&seed=00762m&tiers=1,0,2,1&mode=shipped`,
    });
    const store = stored(storage);
    expect(store.current!.steps[0]!.status).toBe("interrupted");
    expect(store.current!.steps[0]!.attemptLog.map((note) => note.outcome)).toEqual(["interrupted", "interrupted"]);
    expect(store.notice).toBe("crash-skipped");

    expect(noticeText("crash-skipped")).toBe("The last flight closed the page twice; skipping it.");
    const next = load(storage, (skipped.page as { href: string }).href);
    expect(next.page).toMatchObject({ kind: "step", stepIndex: 1, attempt: 1, notice: "crash-skipped" });
    expect(stored(storage).notice).toBeNull();
  });

  it("gives void-hidden after the tab is hidden on both attempts", () => {
    const { storage } = memoryStorage();
    const { href } = started(storage);
    const first = voidAttempt(stored(storage), 0, "void-hidden", NOW, href);
    expect(first.href).toBe(href);
    expect(first.store.current!.steps[0]!.status).toBe("pending");
    writeBenchStore(storage, first.store);
    const again = load(storage, href, "navigate");
    expect(again.page).toMatchObject({ kind: "step", attempt: 2, previous: { outcome: "void-hidden", attempt: 1 } });
    const second = voidAttempt(stored(storage), 0, "void-hidden", NOW, href);
    expect(second.href).toContain("&step=1&");
    expect(second.store.current!.steps[0]).toMatchObject({ status: "void-hidden", attempts: 2 });
    expect(second.store.current!.steps[0]!.attemptLog).toHaveLength(2);
    // A resize is the same rule with its own outcome.
    const resized = voidAttempt(second.store, 0, "void-resized", NOW, href);
    expect(resized.store.current!.steps[0]!.status).toBe("void-resized");
  });

  it("goes on to the next step after a failure, without a retry", () => {
    const { storage } = memoryStorage();
    const { href } = started(storage);
    const failed = failStep(stored(storage), 0, "the WebGPU device was lost", null, href);
    expect(failed.href).toContain("&step=1&");
    expect(failed.store.current!.steps[0]).toMatchObject({
      status: "failed", attempts: 1, message: "the WebGPU device was lost", result: null,
    });
  });

  it("skips the step in flight and the rest on Stop", () => {
    const { storage } = memoryStorage();
    const { href } = started(storage);
    const first = recordStepResult(stored(storage), 0, "ok", benchStepResult({ tierIndex: 1, decisions: 4 }), "absent", href);
    writeBenchStore(storage, first.store);
    load(storage, first.href);
    const stop = stopRun(stored(storage), NOW, first.href);
    expect(stop.href).toContain("&step=report&");
    expect(stop.store.current!.status).toBe("stopped");
    expect(stop.store.current!.steps.map((step) => step.status)).toEqual(["ok", "skipped", "skipped", "skipped"]);
    writeBenchStore(storage, stop.store);
    const report = load(storage, stop.href);
    expect(report.page).toMatchObject({ kind: "report", run: { status: "stopped" } });
    expect(report.save).toBeNull();
  });

  it("closes a run that reaches the report with steps left: claimed interrupted, the rest skipped", () => {
    const { storage } = memoryStorage();
    const { decision } = started(storage);
    // The claim saved, then the step page could not save again and went to the report.
    const report = load(storage, decision.onSaveFailed!);
    expect(report.page).toMatchObject({ kind: "report", run: { status: "stopped" } });
    expect(stored(storage).current!.steps.map((step) => step.status))
      .toEqual(["interrupted", "skipped", "skipped", "skipped"]);
  });

  it("sends a load for another run, a stale step or a corrupt store back to the intro with a notice", () => {
    const { storage } = memoryStorage();
    const { href } = started(storage);
    const other = load(storage, href.replace("run=k3x9q2m7wp", "run=zzzzzz9999"));
    expect(other.page).toEqual({ kind: "redirect", href: `${PAGE}?bench=1&tiers=1,0,2,1&mode=shipped` });
    expect(stored(storage).notice).toBe("run-mismatch");
    const intro = load(storage, INTRO);
    expect(intro.page).toMatchObject({ kind: "intro", notice: "run-mismatch", resumable: { runId: "k3x9q2m7wp" } });
    expect(stored(storage).notice).toBeNull();

    // A different plan in the URL is another run too.
    expect(load(storage, href.replace("mode=shipped", "mode=pinned")).page.kind).toBe("redirect");
    expect(stored(storage).notice).toBe("run-mismatch");

    // Step 2 before step 1 has run.
    const ahead = load(storage, href.replace("step=0", "step=2"));
    expect(ahead.page.kind).toBe("redirect");
    expect(stored(storage).notice).toBe("step-out-of-order");
    expect(nextStepIndex(stored(storage).current!)).toBe(0);

    storage.setItem(BENCH_STORE_KEY, '{"v":1,"current":{"bad":true}}');
    const corrupt = load(storage, href);
    expect(corrupt.page.kind).toBe("redirect");
    expect(stored(storage)).toEqual({ ...EMPTY_BENCH_STORE, notice: "store-corrupt" });
    storage.setItem(BENCH_STORE_KEY, "{not json");
    const fresh = load(storage, INTRO);
    expect(fresh.page).toMatchObject({ kind: "intro", notice: "store-corrupt" });
    expect(stored(storage)).toEqual(EMPTY_BENCH_STORE);
  });

  it("shows the storage-unavailable intro when the storage throws", () => {
    const blocked = memoryStorage();
    blocked.control.failReads = true;
    expect(load(blocked.storage, INTRO).page).toEqual({ kind: "intro", storage: "unavailable", resumable: null, notice: null });
    const full = memoryStorage();
    full.control.failWrites = true;
    expect(load(full.storage, INTRO).page).toMatchObject({ kind: "intro", storage: "unavailable" });
    const step = load(full.storage, `${PAGE}?bench=1&run=k3x9q2m7wp&step=0&tiers=1,0,2,1&mode=shipped`);
    expect(step).toEqual({ page: { kind: "redirect", href: `${PAGE}?bench=1&tiers=1,0,2,1&mode=shipped` }, save: null, onSaveFailed: null });
    // The intro's device-only report is built in memory.
    const run = deviceOnlyRun(startInput(), "storage-unavailable");
    expect(run.status).toBe("storage-unavailable");
    expect(run.steps.every((entry) => entry.status === "skipped")).toBe(true);
  });

  it("makes a device-only report when WebGPU is missing", () => {
    const { storage } = memoryStorage();
    const start = startDeviceOnlyRun(startInput(), INTRO);
    expect(start.href).toBe(`${PAGE}?bench=1&run=k3x9q2m7wp&step=report&tiers=1,0,2,1&mode=shipped`);
    writeBenchStore(storage, start.store);
    const report = load(storage, start.href);
    expect(report.page).toMatchObject({ kind: "report", run: { status: "no-webgpu" } });
    expect(report.save).toBeNull();
  });

  it("offers Resume for an unfinished run", () => {
    const { storage } = memoryStorage();
    started(storage);
    const intro = load(storage, `${INTRO}&tiers=0`);
    expect(intro.page).toMatchObject({ kind: "intro", resumable: { runId: "k3x9q2m7wp", status: "running" } });
  });

  it("keeps the shipped run under a pinned pass (N6), at most two earlier runs", () => {
    const { storage } = memoryStorage();
    const done = stopRun(startRun(startInput(), INTRO).store, NOW, INTRO).store;
    const extras = recordReportExtras(done, { reportRefresh: benchRefresh(59.9), settingsKeyAtEnd: "absent" });
    expect(recordReportExtras(extras, { reportRefresh: benchRefresh(30), settingsKeyAtEnd: null }).current!.reportRefresh!.hz)
      .toBe(59.9);
    const pinned = startPinnedPass(extras, "p1n2e3d4x5", "absent", NOW, INTRO);
    expect(pinned.href).toBe(`${PAGE}?bench=1&run=p1n2e3d4x5&step=0&seed=00762m&tiers=1,0,2,1&mode=pinned`);
    expect(pinned.store.current).toMatchObject({
      runId: "p1n2e3d4x5", status: "running", userLabel: "Jason's laptop", firstLoad: null, plan: { mode: "pinned" },
    });
    expect(pinned.store.current!.introRefresh!.hz).toBe(59.9);
    expect(pinned.store.earlier.map((run) => run.runId)).toEqual(["k3x9q2m7wp"]);
    writeBenchStore(storage, stopRun(pinned.store, NOW, INTRO).store);
    const report = load(storage, `${PAGE}?bench=1&run=p1n2e3d4x5&step=report&tiers=1,0,2,1&mode=pinned`);
    expect(report.page).toMatchObject({ kind: "report", earlier: [{ runId: "k3x9q2m7wp" }] });

    const third = startPinnedPass(startPinnedPass(pinned.store, "third00000", null, NOW, INTRO).store, "fourth0000", null, NOW, INTRO);
    expect(third.store.earlier.map((run) => run.runId)).toEqual(["p1n2e3d4x5", "third00000"]);
  });

  it("leaves the bare page on Exit", () => {
    expect(exitUrl(`${PAGE}?bench=1&run=k3x9q2m7wp&step=report&tiers=1,0,2,1&mode=shipped`)).toBe(PAGE);
  });

  it("trims the user label to 80 characters", () => {
    expect(benchUserLabel("   ")).toBeNull();
    expect(benchUserLabel(null)).toBeNull();
    expect(benchUserLabel(" RTX\n3060 ")).toBe("RTX 3060");
    expect(benchUserLabel("x".repeat(200))).toHaveLength(80);
  });
});

describe("the settings guard", () => {
  it("hashes the settings key, and only reads that key", () => {
    const read: string[] = [];
    const reader = (text: string | null) => ({
      getItem(key: string) {
        read.push(key);
        return text;
      },
    });
    expect(hashSettingsKey(reader(null))).toBe(SETTINGS_KEY_ABSENT);
    const hash = hashSettingsKey(reader('{"quality":"medium"}'));
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hashSettingsKey(reader('{"quality":"medium"}'))).toBe(hash);
    expect(hashSettingsKey(reader('{"quality":"high"}'))).not.toBe(hash);
    expect(new Set(read)).toEqual(new Set([SETTINGS_STORAGE_KEY]));
    expect(hashSettingsKey({ getItem: () => { throw new DOMException("blocked", "SecurityError"); } }))
      .toBe(SETTINGS_KEY_UNREADABLE);
    // Node has no window.
    expect(settingsReader()).toBeNull();
    expect(hashSettingsKey()).toBe(SETTINGS_KEY_UNREADABLE);
  });
});

describe("storage in src/bench", () => {
  const root = join(__dirname, "..", "src", "bench");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => /\.(ts|tsx)$/.test(path))
    .map((path) => ({ path: relative(root, join(root, path)).replace(/\\/g, "/"), code: stripComments(readFileSync(join(root, path), "utf8")) }));

  it("names sessionStorage only in store.ts", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((file) => file.code.includes("sessionStorage")).map((file) => file.path)).toEqual(["store.ts"]);
  });

  it("names localStorage only in settingsGuard.ts, which only reads it", () => {
    expect(files.filter((file) => file.code.includes("localStorage")).map((file) => file.path)).toEqual(["settingsGuard.ts"]);
    const guard = files.find((file) => file.path === "settingsGuard.ts")!.code;
    expect(guard).not.toMatch(/\b(setItem|removeItem|clear)\b/);
    expect(guard).not.toMatch(/localStorage\s*\.\s*(?!getItem\b)\w+/);
    expect(guard).not.toMatch(/\bsaveSettings\b/);
  });

  it("writes storage only from store.ts", () => {
    expect(files.filter((file) => /\.(setItem|removeItem)\s*\(/.test(file.code)).map((file) => file.path)).toEqual(["store.ts"]);
  });
});
