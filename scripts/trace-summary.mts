/**
 * Where a throttled frame's time goes, per THREAD, from a Chrome trace written
 * by throttle-probe.mts (TRACE_S>0).
 *
 * Busy time is the union of top-level task intervals on each thread, so nested
 * tasks are not double counted. It answers "main thread vs physics worker vs
 * GPU process": a main thread near 100% busy is CPU-bound however fast the GPU
 * is; a main thread with idle gaps while frames still run long is waiting on
 * the GPU or the compositor.
 *
 * Worker threads are named by script URL where the trace's
 * TracingSessionIdForWorker event says which thread runs which script.
 *
 * Usage: tsx scripts/trace-summary.mts <file.trace.json> [topN]
 */
import { readFileSync } from "node:fs";

interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, unknown>;
}

const [file, topArg] = process.argv.slice(2);
if (!file) throw new Error("usage: <file.trace.json> [topN]");
const top = Number(topArg ?? 12);
const parsed = JSON.parse(readFileSync(file, "utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
const events = Array.isArray(parsed) ? parsed : parsed.traceEvents ?? [];

const processNames = new Map<number, string>();
const threadNames = new Map<string, string>();
const workerUrls = new Map<string, string>();
for (const e of events) {
  if (e.ph === "M" && e.name === "process_name") processNames.set(e.pid, String(e.args?.name ?? ""));
  if (e.ph === "M" && e.name === "thread_name") threadNames.set(`${e.pid}:${e.tid}`, String(e.args?.name ?? ""));
  if (e.name === "TracingSessionIdForWorker") {
    const data = (e.args?.data ?? {}) as { workerThreadId?: number; url?: string };
    if (data.workerThreadId !== undefined && data.url) {
      workerUrls.set(`${e.pid}:${data.workerThreadId}`, data.url.replace(/\?.*$/, "").replace(/^.*\//, ""));
    }
  }
}

const timed = events.filter((e) => e.ph === "X" && typeof e.dur === "number");
if (timed.length === 0) throw new Error("no complete events in trace");
const t0 = Math.min(...timed.map((e) => e.ts));
const t1 = Math.max(...timed.map((e) => e.ts + (e.dur ?? 0)));
const spanUs = t1 - t0;

const TOP_LEVEL = new Set([
  "ThreadControllerImpl::RunTask", "RunTask", "ThreadPool_RunTask",
  "SequenceManager::DoIdleWork", "TaskQueueManager::ProcessTaskFromWorkQueue",
]);
const intervalsByThread = new Map<string, [number, number][]>();
const namesByThread = new Map<string, Map<string, number>>();
for (const e of timed) {
  const key = `${e.pid}:${e.tid}`;
  if (TOP_LEVEL.has(e.name)) {
    const list = intervalsByThread.get(key) ?? [];
    list.push([e.ts, e.ts + e.dur!]);
    intervalsByThread.set(key, list);
  }
  const names = namesByThread.get(key) ?? new Map<string, number>();
  names.set(e.name, (names.get(e.name) ?? 0) + e.dur!);
  namesByThread.set(key, names);
}

function unionUs(list: [number, number][]): number {
  const sorted = list.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = -Infinity;
  let end = -Infinity;
  for (const [s, e] of sorted) {
    if (s > end) {
      if (end > start) total += end - start;
      start = s;
      end = e;
    } else if (e > end) {
      end = e;
    }
  }
  if (end > start) total += end - start;
  return total;
}

function label(key: string): string {
  const [pid] = key.split(":").map(Number);
  const process = processNames.get(pid!) ?? `pid ${pid}`;
  const thread = threadNames.get(key) ?? key;
  const worker = workerUrls.get(key);
  return `${process} / ${thread}${worker ? ` [${worker}]` : ""}`;
}

console.log(`trace span ${(spanUs / 1e3).toFixed(0)} ms`);
console.log("\n== busy share per thread (union of top-level tasks) ==");
const rows = [...intervalsByThread.entries()]
  .map(([key, list]) => ({ key, busy: unionUs(list) }))
  .sort((a, b) => b.busy - a.busy)
  .slice(0, top);
for (const row of rows) {
  console.log(`${(100 * row.busy / spanUs).toFixed(1).padStart(5)}%  ${(row.busy / 1e3).toFixed(0).padStart(6)} ms  ${label(row.key)}`);
}

const main = [...threadNames.entries()].find(([, name]) => name === "CrRendererMain")?.[0];
if (main) {
  console.log(`\n== ${label(main)}: event totals (nested, so they overlap) ==`);
  const names = [...(namesByThread.get(main) ?? new Map()).entries()]
    .filter(([name]) => !TOP_LEVEL.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  for (const [name, us] of names) {
    console.log(`${(100 * us / spanUs).toFixed(1).padStart(5)}%  ${(us / 1e3).toFixed(0).padStart(6)} ms  ${name}`);
  }
}
