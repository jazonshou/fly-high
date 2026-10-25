/**
 * perf:flight's verdict on the detail (vegetation) worker, with the frame
 * numbers that go with it, from a run's `report.json`. Pure; no I/O.
 *
 * For each arm and phase (the concurrent stream to rest, each leg, and each
 * settle trial, which starts from a new renderer and so stands alone):
 *  - TRIPPED: by the end of the phase the runtime had timed its worker out,
 *    restarted it or fallen back to generating cells on the main thread, or
 *    had no worker at all. The counters are the renderer's, so a trip stays
 *    on every later phase of that arm; the first phase it shows on is marked.
 *    A worker failed on purpose (`--kill-detail-worker`, `--hang-detail-worker`)
 *    is not a trip: its leg and those after it say whether the runtime
 *    RECOVERED (restarted the worker) or FELL BACK, and only trips beyond the
 *    one that failure accounts for count.
 *  - WOULD-TRIP: spans the runtime charged its worker 2,000 ms or more
 *    (`tests/perf/ab/detailWatchdog.ts`), which trip its 240-update deadline
 *    at 120 Hz although this harness runs far slower;
 *  - the longest charged span, and accepted worker builds' latency;
 *  - `render()` ms p50 and p95, heap allocated per frame, and the head/base
 *    ratios of those.
 *
 * Arms are keyed by commit as well as by name: runs swap the arms, and
 * `--fail-on-worker-fallback` asks about a commit, not about a side.
 *
 * Plain Node, as `perfAbHarness.mts`: only type imports from the protocol.
 */

import type {
  DetailWatchdogReport,
  DetailWorkerFault,
  DetailWorkerState,
  FlightFrame,
  FlightReport,
  LandStart,
  StreamReport,
} from "../tests/perf/ab/protocol.ts";

export type ArmName = "base" | "head";
export const ARMS: readonly ArmName[] = ["base", "head"];

/** A frame of a leg on the command line: legs count from 1 (as the log does), frames within a leg from 0. */
export interface LegFrame {
  readonly leg: number;
  readonly frame: number;
}

function integerIn(text: string, low: number, high: number): number | null {
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(value) && value >= low && value <= high ? value : null;
}

/** `<leg>:<frame>`, as `--kill-detail-worker` takes it; throws a usage message. */
export function parseLegFrame(option: string, text: string, legs: number, legFrames: number): LegFrame {
  const [legText = "", frameText = "", ...rest] = text.split(":");
  const leg = integerIn(legText, 1, legs);
  const frame = integerIn(frameText, 0, legFrames - 1);
  if (rest.length > 0 || leg === null || frame === null) {
    throw new Error(`perf-flight: ${option} takes <leg>:<frame>, leg 1-${legs} and frame 0-${legFrames - 1} (got ${text})`);
  }
  return { leg, frame };
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles; NaN for no values. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? Number.NaN, mean };
}

/** Mean JS heap growth per frame in KiB, counting only growth (falls are collections). */
export function heapKiBPerFrame(frames: readonly FlightFrame[]): number {
  let growth = 0;
  for (const frame of frames) {
    for (const delta of [frame.heapRenderBytes, frame.heapBetweenBytes]) {
      if (delta > 0) growth += delta;
    }
  }
  return growth / Math.max(1, frames.length) / 1024;
}

/** What the verdict reads of `report.json`; a report from before the probe lacks the optional parts. */
export interface FlightRunReport {
  readonly identity: Readonly<Record<ArmName, string>>;
  /** Full commit SHAs; an older report has only `identity`. */
  readonly shas?: Readonly<Record<ArmName, string>>;
  /** The concurrent stream to rest that every run starts with. */
  readonly settle?: Readonly<Record<ArmName, StreamReport>> | null;
  readonly reports: Readonly<Record<ArmName, readonly FlightReport[]>>;
  readonly settleTrials?: readonly SettleTrial[];
}

/** One `--settle-trials` round: both arms, each on a new renderer, held still over `start`. */
export interface SettleTrial {
  readonly start: LandStart;
  readonly base: FlightReport;
  readonly head: FlightReport;
}

/** The trips a worker state counts: timeouts, restarts and fallbacks. */
export function workerTrips(state: DetailWorkerState): number {
  return state.buildTimeouts + state.generationTimeouts + (state.respawns ?? 0) + state.fallbacks;
}

export function workerTripped(state: DetailWorkerState): boolean {
  return workerTrips(state) > 0 || !state.active;
}

/**
 * What became of a worker failed on purpose, as of `after`: restarted
 * (RECOVERED), replaced by main-thread generation (FELL BACK), not yet
 * noticed (UNDETECTED: a silent worker before the watchdog fires), or never
 * failed because there was no worker (NOT DELIVERED).
 */
export type FaultOutcome = "RECOVERED" | "FELL BACK" | "UNDETECTED" | "NOT DELIVERED";

export function faultOutcome(fault: DetailWorkerFault, after: DetailWorkerState): FaultOutcome {
  if (!fault.delivered || !fault.before) return "NOT DELIVERED";
  if (!after.active || after.fallbacks > fault.before.fallbacks) return "FELL BACK";
  return (after.respawns ?? 0) > (fault.before.respawns ?? 0) ? "RECOVERED" : "UNDETECTED";
}

/**
 * Whether `after` shows a trip the failure does not account for. The failure
 * accounts for one restart and one fallback, and for a silent worker one
 * timeout; the worker being gone only when it FELL BACK.
 */
export function trippedBeyondFault(fault: DetailWorkerFault, after: DetailWorkerState): boolean {
  const before = fault.delivered ? fault.before : null;
  if (!before) return workerTripped(after);
  const timeouts = after.buildTimeouts + after.generationTimeouts - before.buildTimeouts - before.generationTimeouts;
  const beyond = workerTrips(before)
    + Math.max(0, timeouts - (fault.kind === "hang" ? 1 : 0))
    + Math.max(0, (after.respawns ?? 0) - (before.respawns ?? 0) - 1)
    + Math.max(0, after.fallbacks - before.fallbacks - 1);
  return beyond > 0 || (!after.active && faultOutcome(fault, after) !== "FELL BACK");
}

export interface VerdictRow {
  /** "settle", "leg 1", ... */
  readonly phase: string;
  readonly arm: ArmName;
  readonly sha: string;
  /** Null when the phase reported no worker state (a build without a detail runtime). */
  readonly tripped: boolean | null;
  /** This is the first of the arm's phases to show the trip. */
  readonly firstTripped: boolean;
  readonly worker: DetailWorkerState | null;
  /** A worker failed on purpose in this phase or an earlier one of the arm, and what became of it by this one's end. */
  readonly fault: { readonly kind: DetailWorkerFault["kind"]; readonly phase: string; readonly outcome: FaultOutcome } | null;
  /** Spans in the phase that would trip at 120 Hz, presentation and generation together; null without a probe. */
  readonly wouldTrip: number | null;
  readonly maxChargedMs: { readonly presentation: number; readonly generation: number } | null;
  readonly buildLatencyMs: { readonly p50: number; readonly p95: number; readonly count: number } | null;
  /** Null for the stream to rest, which times no frame. */
  readonly renderMs: { readonly p50: number; readonly p95: number } | null;
  readonly heapKiBPerFrame: number | null;
  readonly longTasks: number | null;
  /** Frames per wall second: the rate the runtime's clocks saw. */
  readonly framesPerSecond: number | null;
}

export interface HeadBaseRatio {
  readonly phase: string;
  readonly renderP50: number;
  readonly renderP95: number;
  readonly heapKiBPerFrame: number;
}

/** An arm over all its settle trials. */
export interface TrialSummary {
  readonly arm: ArmName;
  readonly sha: string;
  readonly trials: number;
  readonly tripped: number;
  /** Trials with at least one span that would trip at 120 Hz, and those spans. */
  readonly wouldTripTrials: number;
  readonly wouldTripSpans: number;
  /** The longest charged presentation span of any trial. */
  readonly maxChargedMs: number | null;
  /** Accepted build latency over every trial. */
  readonly buildLatencyMs: { readonly p50: number; readonly p95: number; readonly count: number };
}

export interface FlightVerdict {
  readonly rows: readonly VerdictRow[];
  readonly trials: readonly TrialSummary[];
  /** Head over base, over the legs after the first and over the first leg. */
  readonly ratios: readonly HeadBaseRatio[];
  /** For each commit an arm was built from: whether that arm tripped anywhere. */
  readonly trippedBySha: Readonly<Record<string, boolean>>;
}

/** The arm's commit: its full SHA, or from an older report the short one in its identity. */
function armSha(report: FlightRunReport, arm: ArmName): string {
  return report.shas?.[arm] ?? /\(([0-9a-f]{7,40})\b/.exec(report.identity[arm])?.[1] ?? report.identity[arm];
}

function watchdogColumns(watchdog: DetailWatchdogReport | null | undefined): Pick<
  VerdictRow,
  "wouldTrip" | "maxChargedMs" | "buildLatencyMs"
> {
  if (!watchdog) return { wouldTrip: null, maxChargedMs: null, buildLatencyMs: null };
  const latency = percentiles(watchdog.buildLatencyMs);
  return {
    wouldTrip: watchdog.presentation.wouldTripAt120Hz + watchdog.generation.wouldTripAt120Hz,
    maxChargedMs: { presentation: watchdog.presentation.maxChargedMs, generation: watchdog.generation.maxChargedMs },
    buildLatencyMs: { p50: latency.p50, p95: latency.p95, count: watchdog.buildLatencyMs.length },
  };
}

function framesPerSecond(frames: number, watchdog: DetailWatchdogReport | null | undefined, elapsedMs: number): number {
  return watchdog && watchdog.wallMs > 0 ? (watchdog.frames / watchdog.wallMs) * 1_000 : (frames / elapsedMs) * 1_000;
}

type PhaseRow = Omit<VerdictRow, "tripped" | "firstTripped" | "fault">;

function settleRow(arm: ArmName, sha: string, stream: StreamReport): PhaseRow {
  return {
    phase: "settle",
    arm,
    sha,
    worker: stream.detailWorker ?? null,
    ...watchdogColumns(stream.detailWatchdog),
    renderMs: null,
    heapKiBPerFrame: null,
    longTasks: null,
    framesPerSecond: framesPerSecond(stream.frames, stream.detailWatchdog, stream.elapsedMs),
  };
}

function legRow(arm: ArmName, sha: string, phase: string, leg: FlightReport): PhaseRow {
  const render = percentiles(leg.frames.map((frame) => frame.renderMs));
  return {
    phase,
    arm,
    sha,
    worker: leg.detailWorker,
    ...watchdogColumns(leg.detailWatchdog),
    renderMs: { p50: render.p50, p95: render.p95 },
    heapKiBPerFrame: heapKiBPerFrame(leg.frames),
    longTasks: leg.longTasks.length,
    framesPerSecond: framesPerSecond(leg.frames.length, leg.detailWatchdog, leg.elapsedMs),
  };
}

function ratio(phase: string, base: readonly FlightFrame[], head: readonly FlightFrame[]): HeadBaseRatio {
  const baseRender = percentiles(base.map((frame) => frame.renderMs));
  const headRender = percentiles(head.map((frame) => frame.renderMs));
  return {
    phase,
    renderP50: headRender.p50 / baseRender.p50,
    renderP95: headRender.p95 / baseRender.p95,
    heapKiBPerFrame: heapKiBPerFrame(head) / heapKiBPerFrame(base),
  };
}

export function flightVerdict(report: FlightRunReport): FlightVerdict {
  const rows: VerdictRow[] = [];
  const trippedBySha: Record<string, boolean> = {};
  for (const arm of ARMS) {
    const sha = armSha(report, arm);
    const phases: { readonly phase: PhaseRow; readonly injected: DetailWorkerFault | null }[] = [
      ...(report.settle?.[arm] ? [{ phase: settleRow(arm, sha, report.settle[arm]), injected: null }] : []),
      ...report.reports[arm].map((leg, index) => ({
        phase: legRow(arm, sha, `leg ${index + 1}`, leg),
        injected: leg.detailWorkerFault ?? null,
      })),
    ];
    let trippedBefore = false;
    let fault: { readonly injected: DetailWorkerFault; readonly phase: string } | null = null;
    for (const { phase, injected } of phases) {
      if (injected) fault = { injected, phase: phase.phase };
      const tripped = !phase.worker
        ? null
        : fault
          ? trippedBeyondFault(fault.injected, phase.worker)
          : workerTripped(phase.worker);
      rows.push({
        ...phase,
        tripped,
        firstTripped: tripped === true && !trippedBefore,
        fault: fault && phase.worker
          ? { kind: fault.injected.kind, phase: fault.phase, outcome: faultOutcome(fault.injected, phase.worker) }
          : null,
      });
      trippedBefore ||= tripped === true;
    }
    trippedBySha[sha] = (trippedBySha[sha] ?? false) || trippedBefore;
  }
  const trials: TrialSummary[] = [];
  for (const arm of ARMS) {
    const sha = armSha(report, arm);
    const trialRows = (report.settleTrials ?? []).map((trial, index): VerdictRow => {
      const row = legRow(arm, sha, `trial ${index + 1}`, trial[arm]);
      const tripped = row.worker ? workerTripped(row.worker) : null;
      return { ...row, tripped, firstTripped: tripped === true, fault: null };
    });
    if (trialRows.length === 0) continue;
    rows.push(...trialRows);
    const tripped = trialRows.filter((row) => row.tripped === true).length;
    trippedBySha[sha] = (trippedBySha[sha] ?? false) || tripped > 0;
    const latency = (report.settleTrials ?? []).flatMap((trial) => trial[arm].detailWatchdog?.buildLatencyMs ?? []);
    const latencyPercentiles = percentiles(latency);
    const charged = trialRows.flatMap((row) => (row.maxChargedMs ? [row.maxChargedMs.presentation] : []));
    trials.push({
      arm,
      sha,
      trials: trialRows.length,
      tripped,
      wouldTripTrials: trialRows.filter((row) => (row.wouldTrip ?? 0) > 0).length,
      wouldTripSpans: trialRows.reduce((sum, row) => sum + (row.wouldTrip ?? 0), 0),
      maxChargedMs: charged.length > 0 ? Math.max(...charged) : null,
      buildLatencyMs: { p50: latencyPercentiles.p50, p95: latencyPercentiles.p95, count: latency.length },
    });
  }
  const legs = (arm: ArmName, from: number, to?: number) =>
    report.reports[arm].slice(from, to).flatMap((leg) => leg.frames);
  const ratios = [
    ...(report.reports.base.length > 1 && report.reports.head.length > 1
      ? [ratio("after the first leg", legs("base", 1), legs("head", 1))]
      : []),
    ratio("the first leg", legs("base", 0, 1), legs("head", 0, 1)),
    ...(report.settleTrials && report.settleTrials.length > 0
      ? [ratio(
        "the settle trials",
        report.settleTrials.flatMap((trial) => trial.base.frames),
        report.settleTrials.flatMap((trial) => trial.head.frames),
      )]
      : []),
  ];
  return { rows, trials, ratios, trippedBySha };
}

/**
 * `--fail-on-worker-fallback`: 1 when an arm built from `sha` tripped, else 0.
 * Throws for a commit neither arm was built from, which would pass vacuously.
 */
export function workerFallbackExitCode(verdict: FlightVerdict, sha: string): 0 | 1 {
  const tripped = verdict.trippedBySha[sha];
  if (tripped === undefined) {
    throw new Error(`perf-flight: no arm was built from ${sha} (arms: ${Object.keys(verdict.trippedBySha).join(", ")})`);
  }
  return tripped ? 1 : 0;
}

function fmt(value: number | null | undefined, digits = 0): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function workerCell(row: VerdictRow): string {
  if (row.tripped === null || !row.worker) return "n/a";
  const { worker } = row;
  const counts = [
    `build timeouts ${worker.buildTimeouts}`,
    `generation timeouts ${worker.generationTimeouts}`,
    ...(worker.respawns !== undefined ? [`respawns ${worker.respawns}`] : []),
    `fallbacks ${worker.fallbacks}`,
    ...(worker.active ? [] : ["inactive"]),
  ].join(", ");
  const cells = [
    ...(row.fault ? [`${row.fault.kind} in ${row.fault.phase}: ${row.fault.outcome}`] : []),
    ...(!row.tripped ? [] : row.firstTripped ? [`**TRIPPED** (${counts})`] : ["tripped earlier"]),
  ];
  return cells.length > 0 ? cells.join("; ") : "ok";
}

export function renderVerdictMarkdown(verdict: FlightVerdict): string {
  const rows = verdict.rows.map((row) => [
    row.phase,
    row.arm,
    row.sha.slice(0, 10),
    workerCell(row),
    row.wouldTrip === null ? "n/a" : row.wouldTrip > 0 ? `**${row.wouldTrip}**` : "0",
    row.maxChargedMs ? `${fmt(row.maxChargedMs.presentation)} / ${fmt(row.maxChargedMs.generation)}` : "n/a",
    row.buildLatencyMs
      ? `${fmt(row.buildLatencyMs.p50)} / ${fmt(row.buildLatencyMs.p95)} (${row.buildLatencyMs.count})`
      : "n/a",
    row.renderMs ? `${fmt(row.renderMs.p50, 2)} / ${fmt(row.renderMs.p95, 2)}` : "-",
    fmt(row.heapKiBPerFrame),
    row.longTasks === null ? "-" : String(row.longTasks),
    fmt(row.framesPerSecond, 1),
  ]);
  const shas = Object.entries(verdict.trippedBySha)
    .map(([sha, tripped]) => `${sha.slice(0, 10)} ${tripped ? "TRIPPED" : "did not trip"}`)
    .join("; ");
  return [
    "### Detail worker",
    "",
    `By commit: ${shas}.`,
    "",
    "TRIPPED: by the end of the phase the vegetation runtime had timed its worker out, restarted it or fallen "
      + "back to generating cells on the main thread. Would-trip: spans it charged its worker 2,000 ms or more, "
      + "which trip the 240-update deadline at 120 Hz. Charged ms: the longest span, on the runtime's own clock "
      + "(presentation / generation). Build latency: accepted worker builds, wall ms. A worker failed on purpose "
      + "says whether the runtime RECOVERED (restarted it) or FELL BACK; only trips beyond that one count.",
    "",
    "| phase | arm | commit | worker | would-trip | charged ms max | build latency ms p50 / p95 (n) "
      + "| render() ms p50 / p95 | KiB/frame | long tasks | frames/s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    ...(verdict.trials.length === 0 ? [] : [
      "Settle trials (each a new renderer in each arm, held still over fresh land, both arms at once):",
      "",
      "| arm | commit | trials | TRIPPED | trials with a would-trip (spans) | charged ms max | build latency ms p50 / p95 (n) |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...verdict.trials.map((entry) => `| ${entry.arm} | ${entry.sha.slice(0, 10)} | ${entry.trials} | `
        + `${entry.tripped > 0 ? `**${entry.tripped}**` : "0"} | ${entry.wouldTripTrials} (${entry.wouldTripSpans}) | `
        + `${fmt(entry.maxChargedMs)} | ${fmt(entry.buildLatencyMs.p50)} / ${fmt(entry.buildLatencyMs.p95)} `
        + `(${entry.buildLatencyMs.count}) |`),
      "",
    ]),
    "| head / base | render() p50 | render() p95 | KiB/frame |",
    "| --- | --- | --- | --- |",
    ...verdict.ratios.map((entry) =>
      `| ${entry.phase} | ${fmt(entry.renderP50, 3)} | ${fmt(entry.renderP95, 3)} | ${fmt(entry.heapKiBPerFrame, 3)} |`),
    "",
  ].join("\n");
}
