import { FRAME_RATE_SETTINGS, type FrameRateSetting } from "@/src/settings";
import type {
  BenchNoticeCode,
  BenchRunRecord,
  BenchRunStatus,
  BenchStepRecord,
  BenchStepStatus,
  BenchStore,
} from "./types";

/**
 * The run store: one tab-scoped `sessionStorage` key that carries a run
 * across the page loads between steps. Touched only under `?bench=1` and
 * cleared by Exit; the player's settings key is never written (settingsGuard
 * checks that at run time).
 *
 * This is the only file in src/bench that names `sessionStorage`. Every
 * access is behind an injected `Storage` and inside try/catch, because the
 * accessor itself throws when site data is blocked, and `setItem` throws
 * when the quota is full.
 */

export const BENCH_STORE_KEY = "flyhigh.bench.v1";

export const EMPTY_BENCH_STORE: BenchStore = Object.freeze({ v: 1, current: null, earlier: [], notice: null });

export type BenchStoreRead =
  | { readonly kind: "ok"; readonly store: BenchStore }
  /** Something is stored under the key that is not a run store: a newer build's, or a damaged one. */
  | { readonly kind: "corrupt" }
  /** The tab's storage cannot be read or written. */
  | { readonly kind: "unavailable"; readonly reason: string };

/** The tab's `sessionStorage`, or null where reading the accessor throws or there is no window. */
export function benchSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const STEP_STATUSES: ReadonlySet<BenchStepStatus> = new Set<BenchStepStatus>([
  "pending", "running", "ok", "early-stop", "void-hidden", "void-resized", "failed", "interrupted", "skipped",
]);
const RUN_STATUSES: ReadonlySet<BenchRunStatus> = new Set<BenchRunStatus>([
  "running", "finished", "stopped", "no-webgpu", "storage-unavailable",
]);
const NOTICES: ReadonlySet<BenchNoticeCode> = new Set<BenchNoticeCode>([
  "run-mismatch", "store-corrupt", "step-out-of-order", "crash-skipped", "storage-failed",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The fields the page flow reads, checked; the measurements inside a step's
 * result are the controller's and are taken as they were written.
 */
function isStepRecord(value: unknown, index: number): value is BenchStepRecord {
  return isObject(value)
    && value.index === index
    && isCount(value.tierIndex)
    && STEP_STATUSES.has(value.status as BenchStepStatus)
    && isCount(value.attempts)
    && Array.isArray(value.attemptLog)
    && isStringOrNull(value.message)
    && (value.result === null || isObject(value.result));
}

function isRunRecord(value: unknown): value is BenchRunRecord {
  if (!isObject(value) || value.v !== 1 || typeof value.runId !== "string") return false;
  const plan = value.plan;
  if (!isObject(plan)) return false;
  const tiers = plan.tiers;
  if (!Array.isArray(tiers) || !tiers.every(isCount)) return false;
  if (plan.mode !== "shipped" && plan.mode !== "pinned") return false;
  if (typeof plan.hud !== "boolean" || typeof plan.quick !== "boolean") return false;
  // A run saved before the bench recorded its frame rate is not resumed.
  if (!FRAME_RATE_SETTINGS.includes(plan.frameRate as FrameRateSetting)) return false;
  if (!RUN_STATUSES.has(value.status as BenchRunStatus)) return false;
  if (typeof value.startedAt !== "string" || !isStringOrNull(value.finishedAt)) return false;
  if (!isStringOrNull(value.userLabel) || !Array.isArray(value.ignoredParams)) return false;
  if (!isStringOrNull(value.settingsKeyAtStart) || !isStringOrNull(value.settingsKeyAtEnd)) return false;
  const steps = value.steps;
  return Array.isArray(steps)
    && steps.length === tiers.length
    && steps.every((step, index) => isStepRecord(step, index) && step.tierIndex === tiers[index]);
}

/** The stored text as a run store; null when it is not one. No text is an empty store. */
export function parseBenchStore(text: string | null): BenchStore | null {
  if (text === null) return EMPTY_BENCH_STORE;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.v !== 1) return null;
  if (value.current !== null && !isRunRecord(value.current)) return null;
  if (!Array.isArray(value.earlier) || !value.earlier.every(isRunRecord)) return null;
  if (value.notice !== null && !NOTICES.has(value.notice as BenchNoticeCode)) return null;
  return value as unknown as BenchStore;
}

export function serializeBenchStore(store: BenchStore): string {
  return JSON.stringify(store);
}

export function readBenchStore(storage: Storage | null): BenchStoreRead {
  if (storage === null) return { kind: "unavailable", reason: "no session storage" };
  let text: string | null;
  try {
    text = storage.getItem(BENCH_STORE_KEY);
  } catch (error) {
    return { kind: "unavailable", reason: reasonOf(error) };
  }
  const store = parseBenchStore(text);
  return store === null ? { kind: "corrupt" } : { kind: "ok", store };
}

/**
 * Writes the key back as it is (or writes and removes an empty store), so a
 * storage that reads but cannot write is found on the intro, before a run
 * depends on it.
 */
export function probeBenchStore(storage: Storage | null): boolean {
  if (storage === null) return false;
  try {
    const text = storage.getItem(BENCH_STORE_KEY);
    storage.setItem(BENCH_STORE_KEY, text ?? serializeBenchStore(EMPTY_BENCH_STORE));
    if (text === null) storage.removeItem(BENCH_STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** A page load's read: the store, a corrupt key, or no usable storage. */
export function openBenchStore(storage: Storage | null): BenchStoreRead {
  const read = readBenchStore(storage);
  if (read.kind === "unavailable" || probeBenchStore(storage)) return read;
  return { kind: "unavailable", reason: "session storage cannot be written" };
}

/** False when the write threw (quota, blocked storage): the caller goes on without it. */
export function writeBenchStore(storage: Storage | null, store: BenchStore): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(BENCH_STORE_KEY, serializeBenchStore(store));
    return true;
  } catch {
    return false;
  }
}

/** Exit: removes the key, and with it every trace of the bench in this tab. */
export function clearBenchStore(storage: Storage | null): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(BENCH_STORE_KEY);
    return true;
  } catch {
    return false;
  }
}
