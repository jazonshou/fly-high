import type { BenchUrlRequest } from "@/src/settings";
import { benchRunPlan, benchTimings, introUrl, reportUrl, stepUrl, type BenchUrlOptions } from "./plan";
import type { BenchStoreRead } from "./store";
import type {
  BenchAttemptNote,
  BenchDeviceReport,
  BenchFirstLoad,
  BenchNoticeCode,
  BenchRefresh,
  BenchRunPlan,
  BenchRunRecord,
  BenchRunStatus,
  BenchStepRecord,
  BenchStepResult,
  BenchStepStatus,
  BenchStore,
} from "./types";

/**
 * The bench's page flow, as pure functions: which page a load shows, what it
 * saves first and where it sends the tab next. session.ts runs it with the
 * real URL, store and navigation type; tests run it with plain values.
 *
 * A run is a chain of page loads, intro → step 0 … step n-1 → report, each
 * a `location.replace`. The store is the only state that crosses them; the
 * URL carries the run id and step so a load can check it belongs to the
 * store's run.
 */

/** What a page load shows. */
export type BenchPage =
  | {
    readonly kind: "intro";
    /** "unavailable": the bench needs this tab's site storage; only a device-only report is possible. */
    readonly storage: "ok" | "unavailable";
    /** An unfinished run of this tab, to offer Resume or Start over. */
    readonly resumable: BenchRunRecord | null;
    readonly notice: BenchNoticeCode | null;
  }
  | {
    readonly kind: "step";
    readonly run: BenchRunRecord;
    readonly stepIndex: number;
    /** 1 or 2: the attempt this load is. */
    readonly attempt: number;
    /** Why the previous attempt at this step ended without a result, if it did. */
    readonly previous: BenchAttemptNote | null;
    readonly notice: BenchNoticeCode | null;
  }
  | {
    readonly kind: "report";
    readonly run: BenchRunRecord;
    /** Earlier runs of this tab, oldest first: the shipped run under a pinned pass (N6). */
    readonly earlier: readonly BenchRunRecord[];
    readonly notice: BenchNoticeCode | null;
  }
  | { readonly kind: "redirect"; readonly href: string };

export interface BenchFlowInput {
  readonly request: BenchUrlRequest;
  readonly read: BenchStoreRead;
  /** The navigation entry's `type`: "navigate", "reload", "back_forward", "prerender", or "unknown". */
  readonly navigationType: string;
  readonly href: string;
  /** This load's ISO time, for the attempt log. */
  readonly now: string;
}

export interface BenchFlowDecision {
  readonly page: BenchPage;
  /** Save this before anything else happens, or null to leave the store as it is. */
  readonly save: BenchStore | null;
  /** Where to go when that save fails: the report, for a step that could not claim itself. */
  readonly onSaveFailed: string | null;
}

/** A store change and the page to go to next, for the actions below. */
export interface BenchTransition {
  readonly store: BenchStore;
  readonly href: string;
}

const FINAL: ReadonlySet<BenchStepStatus> = new Set<BenchStepStatus>([
  "ok", "early-stop", "void-hidden", "void-resized", "failed", "interrupted", "skipped",
]);

const EMPTY_STORE: BenchStore = Object.freeze({ v: 1, current: null, earlier: [], notice: null });

/** Under a pinned pass of a pinned pass, only the most recent earlier runs are kept. */
export const MAX_EARLIER_RUNS = 2;
/** The intro's "Your computer" field. */
export const USER_LABEL_MAX = 80;

export function isFinalStep(status: BenchStepStatus): boolean {
  return FINAL.has(status);
}

export function urlOptions(plan: Pick<BenchRunPlan, "tiers" | "mode" | "hud" | "quick">): BenchUrlOptions {
  return { tiers: plan.tiers, mode: plan.mode, hud: plan.hud, quick: plan.quick };
}

/** The step the run goes to next: the first that has not ended, or null when all have. */
export function nextStepIndex(run: BenchRunRecord): number | null {
  const index = run.steps.findIndex((step) => !isFinalStep(step.status));
  return index < 0 ? null : index;
}

/** Where the run goes next: its next step, or the report. Also the intro's Resume. */
export function nextHref(run: BenchRunRecord, href: string): string {
  const next = nextStepIndex(run);
  const options = urlOptions(run.plan);
  return next === null ? reportUrl(href, run.runId, options) : stepUrl(href, run.runId, next, options);
}

/** A notice in the words the next page shows it in. */
export function noticeText(notice: BenchNoticeCode): string {
  switch (notice) {
    case "run-mismatch":
      return "That page belonged to another benchmark run, so you are back at the start.";
    case "store-corrupt":
      return "The saved benchmark run could not be read, so it was cleared.";
    case "step-out-of-order":
      return "That flight had already run. Resume the benchmark, or start it again.";
    case "crash-skipped":
      return "The last flight closed the page twice; skipping it.";
    case "storage-failed":
      return "The browser stopped saving the benchmark's progress, so this report shows what it had.";
  }
}

/** "Your computer": trimmed, at most 80 characters, null when empty. */
export function benchUserLabel(text: string | null | undefined): string | null {
  const label = (text ?? "").replace(/\s+/g, " ").trim().slice(0, USER_LABEL_MAX).trim();
  return label === "" ? null : label;
}

function samePlan(plan: BenchRunPlan, request: BenchUrlRequest): boolean {
  return plan.mode === request.mode
    && plan.hud === request.hud
    && plan.quick === request.quick
    && plan.tiers.length === request.tiers.length
    && plan.tiers.every((tierIndex, index) => tierIndex === request.tiers[index]);
}

function withStep(run: BenchRunRecord, index: number, change: Partial<BenchStepRecord>): BenchRunRecord {
  return { ...run, steps: run.steps.map((step) => (step.index === index ? { ...step, ...change } : step)) };
}

function withRun(store: BenchStore, run: BenchRunRecord, notice: BenchNoticeCode | null = null): BenchStore {
  return { ...store, current: run, notice };
}

function redirectTo(href: string, save: BenchStore | null): BenchFlowDecision {
  return { page: { kind: "redirect", href }, save, onSaveFailed: null };
}

/** Back to the intro with a notice, keeping the store's run for Resume. */
function toIntro(input: BenchFlowInput, store: BenchStore, notice: BenchNoticeCode): BenchFlowDecision {
  return redirectTo(introUrl(input.href, input.request), { ...store, notice });
}

/** The page this load shows, and what it saves first. */
export function benchFlow(input: BenchFlowInput): BenchFlowDecision {
  const { request, read } = input;
  if (request.step === null) return introPage(read);
  // A step or report needs the store; the intro explains when there is none.
  if (read.kind === "unavailable") return redirectTo(introUrl(input.href, request), null);
  if (read.kind === "corrupt") return toIntro(input, EMPTY_STORE, "store-corrupt");
  const store = read.store;
  const run = store.current;
  if (run === null || run.runId !== request.run || !samePlan(run.plan, request)) {
    return toIntro(input, store, "run-mismatch");
  }
  return request.step === "report" ? reportPage(input, store, run) : stepPage(input, store, run, request.step);
}

function introPage(read: BenchStoreRead): BenchFlowDecision {
  if (read.kind === "unavailable") {
    return { page: { kind: "intro", storage: "unavailable", resumable: null, notice: null }, save: null, onSaveFailed: null };
  }
  if (read.kind === "corrupt") {
    return {
      page: { kind: "intro", storage: "ok", resumable: null, notice: "store-corrupt" },
      save: EMPTY_STORE,
      onSaveFailed: null,
    };
  }
  const store = read.store;
  const current = store.current;
  return {
    page: {
      kind: "intro",
      storage: "ok",
      resumable: current !== null && current.status === "running" ? current : null,
      notice: store.notice,
    },
    save: store.notice === null ? null : { ...store, notice: null },
    onSaveFailed: null,
  };
}

function stepPage(input: BenchFlowInput, store: BenchStore, run: BenchRunRecord, index: number): BenchFlowDecision {
  const step = run.steps[index];
  if (run.status !== "running" || !step || nextStepIndex(run) !== index) {
    return toIntro(input, store, "step-out-of-order");
  }
  const maxAttempts = benchTimings(run.plan.quick).maxAttempts;
  let attemptLog = step.attemptLog;
  if (step.status === "running") {
    // The last load claimed this step and never finished it: a crash, an
    // out-of-memory kill, a reload or a discarded tab.
    const note: BenchAttemptNote = {
      attempt: step.attempts,
      outcome: "interrupted",
      navigationType: input.navigationType,
      at: input.now,
    };
    attemptLog = [...attemptLog, note];
    if (step.attempts >= maxAttempts) {
      const ended = withStep(run, index, { status: "interrupted", attemptLog });
      return redirectTo(nextHref(ended, input.href), withRun(store, ended, "crash-skipped"));
    }
  }
  // Claim the step before the renderer exists: if this load dies, the next
  // one finds it running.
  const claimed = withStep(run, index, { status: "running", attempts: step.attempts + 1, attemptLog });
  return {
    page: {
      kind: "step",
      run: claimed,
      stepIndex: index,
      attempt: step.attempts + 1,
      previous: attemptLog[attemptLog.length - 1] ?? null,
      notice: store.notice,
    },
    save: withRun(store, claimed),
    onSaveFailed: reportUrl(input.href, run.runId, urlOptions(run.plan)),
  };
}

function reportPage(input: BenchFlowInput, store: BenchStore, run: BenchRunRecord): BenchFlowDecision {
  const finished = run.status === "running" ? finishRun(run, input.now) : run;
  const changed = finished !== run || store.notice !== null;
  return {
    page: { kind: "report", run: finished, earlier: store.earlier, notice: store.notice },
    save: changed ? withRun(store, finished) : null,
    onSaveFailed: null,
  };
}

// --- actions -----------------------------------------------------------------------------

export interface StartRunInput {
  readonly runId: string;
  readonly options: BenchUrlOptions;
  readonly device: BenchDeviceReport | null;
  readonly introRefresh: BenchRefresh | null;
  readonly userLabel: string | null;
  readonly firstLoad: BenchFirstLoad | null;
  readonly ignoredParams: readonly string[];
  /** `hashSettingsKey()` at the intro. */
  readonly settingsKey: string | null;
  readonly now: string;
}

function newRun(input: StartRunInput, status: BenchRunStatus, stepStatus: BenchStepStatus): BenchRunRecord {
  const plan = benchRunPlan(input.options);
  return {
    v: 1,
    runId: input.runId,
    plan,
    status,
    startedAt: input.now,
    finishedAt: status === "running" ? null : input.now,
    userLabel: benchUserLabel(input.userLabel),
    device: input.device,
    introRefresh: input.introRefresh,
    reportRefresh: null,
    firstLoad: input.firstLoad,
    ignoredParams: [...input.ignoredParams],
    settingsKeyAtStart: input.settingsKey,
    settingsKeyAtEnd: null,
    steps: plan.tiers.map((tierIndex, index) => ({
      index,
      tierIndex,
      status: stepStatus,
      attempts: 0,
      attemptLog: [],
      message: null,
      result: null,
    })),
  };
}

/** Start: a new run replaces whatever the tab held, earlier runs included. */
export function startRun(input: StartRunInput, href: string): BenchTransition {
  const run = newRun(input, "running", "pending");
  return { store: { v: 1, current: run, earlier: [], notice: null }, href: nextHref(run, href) };
}

/**
 * A run that flies nothing: every step skipped, for a browser without usable
 * WebGPU ("no-webgpu") or a tab without storage ("storage-unavailable", which
 * the intro shows in place, since it cannot be saved for a report page).
 */
export function deviceOnlyRun(
  input: StartRunInput,
  status: Extract<BenchRunStatus, "no-webgpu" | "storage-unavailable"> = "no-webgpu",
): BenchRunRecord {
  return newRun(input, status, "skipped");
}

export function startDeviceOnlyRun(input: StartRunInput, href: string): BenchTransition {
  const run = deviceOnlyRun(input, "no-webgpu");
  return { store: { v: 1, current: run, earlier: [], notice: null }, href: nextHref(run, href) };
}

function currentStep(store: BenchStore, index: number): { readonly run: BenchRunRecord; readonly step: BenchStepRecord } {
  const run = store.current;
  const step = run?.steps[index];
  if (!run || !step) throw new RangeError(`The bench store has no step ${index}`);
  return { run, step };
}

/** A flight that ran to its end, or stopped early under 5 fps. */
export function recordStepResult(
  store: BenchStore,
  index: number,
  outcome: "ok" | "early-stop",
  result: BenchStepResult,
  settingsKey: string | null,
  href: string,
): BenchTransition {
  const { run } = currentStep(store, index);
  const next = { ...withStep(run, index, { status: outcome, result, message: null }), settingsKeyAtEnd: settingsKey };
  return { store: withRun(store, next, store.notice), href: nextHref(next, href) };
}

/**
 * The tab was hidden, or the window changed size: the attempt says nothing.
 * Within the attempt limit the same step loads again; after it the step
 * ends with that outcome and the run goes on.
 */
export function voidAttempt(
  store: BenchStore,
  index: number,
  outcome: "void-hidden" | "void-resized",
  now: string,
  href: string,
): BenchTransition {
  const { run, step } = currentStep(store, index);
  const note: BenchAttemptNote = { attempt: step.attempts, outcome, navigationType: null, at: now };
  const attemptLog = [...step.attemptLog, note];
  const retry = step.attempts < benchTimings(run.plan.quick).maxAttempts;
  const next = withStep(run, index, { status: retry ? "pending" : outcome, attemptLog });
  return {
    store: withRun(store, next, store.notice),
    href: retry ? stepUrl(href, run.runId, index, urlOptions(run.plan)) : nextHref(next, href),
  };
}

/** The renderer failed, or never drew a frame: no retry, on to the next step. */
export function failStep(
  store: BenchStore,
  index: number,
  message: string,
  result: BenchStepResult | null,
  href: string,
): BenchTransition {
  const { run } = currentStep(store, index);
  const next = withStep(run, index, { status: "failed", message, result });
  return { store: withRun(store, next, store.notice), href: nextHref(next, href) };
}

/** The report page's close of a run: anything not flown is skipped, a claimed step interrupted. */
export function finishRun(run: BenchRunRecord, now: string): BenchRunRecord {
  if (run.status !== "running") return run;
  let cut = false;
  const steps = run.steps.map((step): BenchStepRecord => {
    if (isFinalStep(step.status)) return step;
    cut = true;
    return { ...step, status: step.status === "running" ? "interrupted" : "skipped" };
  });
  return { ...run, steps, status: cut ? "stopped" : "finished", finishedAt: now };
}

/**
 * Esc, or Stop then confirm: the step in flight and every one after it are
 * skipped, and the report shows what there is.
 */
export function stopRun(store: BenchStore, now: string, href: string): BenchTransition {
  const run = store.current;
  if (!run) throw new RangeError("The bench store has no run to stop");
  const steps = run.steps.map((step): BenchStepRecord => (isFinalStep(step.status) ? step : { ...step, status: "skipped" }));
  const stopped: BenchRunRecord = run.status === "running" ? { ...run, steps, status: "stopped", finishedAt: now } : run;
  return { store: withRun(store, stopped, store.notice), href: reportUrl(href, run.runId, urlOptions(run.plan)) };
}

/** What the report page measures for itself: the refresh rate and the settings key, once. */
export function recordReportExtras(
  store: BenchStore,
  extras: { readonly reportRefresh: BenchRefresh | null; readonly settingsKeyAtEnd: string | null },
): BenchStore {
  const run = store.current;
  if (!run) return store;
  return {
    ...store,
    current: {
      ...run,
      reportRefresh: run.reportRefresh ?? extras.reportRefresh,
      settingsKeyAtEnd: extras.settingsKeyAtEnd ?? run.settingsKeyAtEnd,
    },
  };
}

/**
 * "Run the GPU comparison pass": the same tiers in pinned mode. The run just
 * shown moves to `earlier`, so one report carries both (N6).
 */
export function startPinnedPass(
  store: BenchStore,
  runId: string,
  settingsKey: string | null,
  now: string,
  href: string,
): BenchTransition {
  const previous = store.current;
  if (!previous) throw new RangeError("The bench store has no run to compare against");
  const run = newRun({
    runId,
    options: { ...urlOptions(previous.plan), mode: "pinned" },
    device: previous.device,
    introRefresh: previous.reportRefresh ?? previous.introRefresh,
    userLabel: previous.userLabel,
    // Not a first load: the scripts are cached by now.
    firstLoad: null,
    ignoredParams: previous.ignoredParams,
    settingsKey,
    now,
  }, "running", "pending");
  const earlier = [...store.earlier, previous].slice(-MAX_EARLIER_RUNS);
  return { store: { v: 1, current: run, earlier, notice: null }, href: nextHref(run, href) };
}
