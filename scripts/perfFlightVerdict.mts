/**
 * perf:flight's verdict on the detail (vegetation) worker, with the frame
 * numbers that go with it, from a run's `report.json`. Pure; no I/O.
 *
 * For each arm and phase (the concurrent stream to rest, then each leg):
 *  - TRIPPED: by the end of the phase the runtime had timed its worker out,
 *    restarted it or fallen back to generating cells on the main thread, or
 *    had no worker at all. The counters are the renderer's, so a trip stays
 *    on every later phase of that arm; the first phase it shows on is marked.
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
  DetailWorkerState,
  FlightFrame,
  FlightReport,
  StreamReport,
} from "../tests/perf/ab/protocol.ts";

export type ArmName = "base" | "head";
export const ARMS: readonly ArmName[] = ["base", "head"];

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
}

/** The trips a worker state counts: timeouts, restarts and fallbacks. */
export function workerTrips(state: DetailWorkerState): number {
  return state.buildTimeouts + state.generationTimeouts + (state.respawns ?? 0) + state.fallbacks;
}

export function workerTripped(state: DetailWorkerState): boolean {
  return workerTrips(state) > 0 || !state.active;
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

export interface FlightVerdict {
  readonly rows: readonly VerdictRow[];
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

function settleRow(arm: ArmName, sha: string, stream: StreamReport): Omit<VerdictRow, "tripped" | "firstTripped"> {
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

function legRow(arm: ArmName, sha: string, index: number, leg: FlightReport): Omit<VerdictRow, "tripped" | "firstTripped"> {
  const render = percentiles(leg.frames.map((frame) => frame.renderMs));
  return {
    phase: `leg ${index + 1}`,
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
    const phases = [
      ...(report.settle?.[arm] ? [settleRow(arm, sha, report.settle[arm])] : []),
      ...report.reports[arm].map((leg, index) => legRow(arm, sha, index, leg)),
    ];
    let trippedBefore = false;
    for (const phase of phases) {
      const tripped = phase.worker ? workerTripped(phase.worker) : null;
      rows.push({ ...phase, tripped, firstTripped: tripped === true && !trippedBefore });
      trippedBefore ||= tripped === true;
    }
    trippedBySha[sha] = (trippedBySha[sha] ?? false) || trippedBefore;
  }
  const legs = (arm: ArmName, from: number, to?: number) =>
    report.reports[arm].slice(from, to).flatMap((leg) => leg.frames);
  const ratios = [
    ...(report.reports.base.length > 1 && report.reports.head.length > 1
      ? [ratio("after the first leg", legs("base", 1), legs("head", 1))]
      : []),
    ratio("the first leg", legs("base", 0, 1), legs("head", 0, 1)),
  ];
  return { rows, ratios, trippedBySha };
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
  if (!row.tripped) return "ok";
  const { worker } = row;
  const counts = [
    `build timeouts ${worker.buildTimeouts}`,
    `generation timeouts ${worker.generationTimeouts}`,
    ...(worker.respawns !== undefined ? [`respawns ${worker.respawns}`] : []),
    `fallbacks ${worker.fallbacks}`,
    ...(worker.active ? [] : ["inactive"]),
  ].join(", ");
  return row.firstTripped ? `**TRIPPED** (${counts})` : "tripped earlier";
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
      + "(presentation / generation). Build latency: accepted worker builds, wall ms.",
    "",
    "| phase | arm | commit | worker | would-trip | charged ms max | build latency ms p50 / p95 (n) "
      + "| render() ms p50 / p95 | KiB/frame | long tasks | frames/s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    "| head / base | render() p50 | render() p95 | KiB/frame |",
    "| --- | --- | --- | --- |",
    ...verdict.ratios.map((entry) =>
      `| ${entry.phase} | ${fmt(entry.renderP50, 3)} | ${fmt(entry.renderP95, 3)} | ${fmt(entry.heapKiBPerFrame, 3)} |`),
    "",
  ].join("\n");
}
