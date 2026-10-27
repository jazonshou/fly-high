import { effectiveFrameRate } from "@/src/game/framePacer";
import type { RenderDiagnostics } from "@/src/game/types";
import { governorConfigForProfile } from "@/src/render/webgpu/core/AdaptiveGovernor";
import { hitchThresholdMilliseconds } from "@/src/render/webgpu/core/QualityProfile";
import { DEFAULT_SETTINGS, defaultBenchFrameRate } from "@/src/settings";
import { fnv1aHex } from "./hash";
import { BENCH_SCHEMA, BENCH_VERSION, benchProfile, benchTier, benchTierName, isBenchTierIndex } from "./plan";
import { spread } from "./stats";
import type {
  BenchBuildInfo,
  BenchDeviceReport,
  BenchEarlierRun,
  BenchEndContext,
  BenchJson,
  BenchProfileEntry,
  BenchRepeatability,
  BenchReport,
  BenchReportRun,
  BenchReportStep,
  BenchRunPlan,
  BenchRunRecord,
  BenchSmoothness,
  BenchStepRecord,
  BenchStepResult,
  BenchStepStatus,
  BenchVerdict,
  BenchWarning,
  BenchWindowMetrics,
  BenchWorkload,
} from "./types";

/**
 * The `fly-high.bench/3` report: built from the run store, then written as
 * the downloadable JSON, a compact clipboard copy, a short summary for chat,
 * a prefilled GitHub issue link and the table the report page shows. Pure:
 * the page does the copying, downloading and opening.
 */

export const BENCH_ISSUE_REPO = "jazonshou/fly-high";
/** GitHub sends a signed-out reader through a login redirect that lengthens the URL (S4). */
export const ISSUE_URL_MAX = 4_000;
/** The clipboard copy, which a person pastes into a 65,536-character issue body (S4). */
export const COMPACT_REPORT_MAX = 45_000;
/** The one rule that voids a run: the first and last flights' mean fps differ by more. */
export const REPEATABILITY_THRESHOLD = 0.1;
/** The CSS canvas area may change this much between the check flights. */
export const CANVAS_CHANGE_THRESHOLD = 0.02;
/** The idle refresh at the intro and on the report page may differ this much. */
export const REFRESH_CHANGE_THRESHOLD = 0.05;
/** A step's idle refresh probe and the frame pacer's display rate may differ this much. */
export const PACER_PERIOD_THRESHOLD = 0.05;
/** At most this many slow frames per 240 still reads "mostly smooth"; one or none, "smooth". */
const SMOOTH_PER_240 = 1;
const MOSTLY_SMOOTH_PER_240 = 6;

/** What the report's fields mean, all but the windows, whose times are the run's own. */
const DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  intervalMs: "Time from one frame's requestAnimationFrame timestamp to the next: how long each frame stayed on screen.",
  fps: "1000 / mean interval over the window.",
  renderMs: "Main-thread time inside the renderer's render(), including any render-scale step it applies first.",
  gpuMs: "GPU frame time from timestamp queries; pinned mode only, where the renderer measures it.",
  over27_4: "Frames slower than 27.4 ms (twice the 13.7 ms frame target), per 240 frames and per minute.",
  hitch: "Frames slower than the tier's hitch threshold for the cadence at the flight's first frame: 27.4 ms; 60 ms on "
    + "Ultra and at the 30 fps setting, more where that setting draws below 30 fps (a 75 Hz panel draws 25).",
  missedRefresh: "Intervals longer than the paced cadence plus half a refresh period of the step's idle refresh probe: "
    + "1.5 periods when every refresh is drawn. At 165 Hz paced to every 2nd refresh that is 15.2 ms, so the bench counts "
    + "every missed slot, including ones the governor lets pass.",
  vsyncBuckets: "Intervals in paced slots (divisor refresh periods each), within the tolerance: x1 kept up, x2 to x4plus "
    + "took whole slots, offSlot missed its slot by a whole refresh or more, irregular is neither (a variable-rate panel).",
  frameCap: "The fps= setting the run flew, and what this build does with it: 60 fps draws every Nth refresh, or "
    + "every refresh on a build with 60 fps pacing switched off. Shipped mode defaults to the players' setting, pinned "
    + "mode to Match display; a run that behaves otherwise is non-standard.",
  pacing: "The frame pacer's cadence at the flight's first and last frames (it draws every divisor-th refresh of displayHz; "
    + "confirmed when measured on ticks that drew nothing or on drawn ticks faster than the rate held before, which "
    + "render cost cannot make), and the bench's rAF ticks against the frames rendered.",
  spread: "|a - b| / min(a, b) of the first and last flights' mean fps on the same tier, over the air window, or over the early check's stretch when either stopped early. Over 10% voids the run.",
  rafHz: "The browser's frame rate with nothing to draw, which is not always the panel's refresh rate.",
  heap: "performance.memory, coarse outside a flagged Chromium; null and stale when it never changed.",
  shares: "Fractions of the window's frames, from the pixels the engine actually rendered; null for a window the flight never reached.",
  compiles: "Pipelines and shader modules created, each counted with the frame whose render created it: startup (before the first frame), settle, warmup (flight frames before the air window), window (the air window's frames).",
  decisions: "Governor decisions; t is seconds from the flight's first frame, below zero during the settle.",
});

/** The report's `definitions`, the windows' times read from the run's plan: quick mode's are shorter. */
export function benchDefinitions(windows: BenchRunPlan["windows"]): Readonly<Record<string, string>> {
  const { ground, air } = windows;
  return Object.freeze({
    windows: `ground: on the runway, from ${ground.startS} s into the roll to lift-off at ${ground.endS} s. `
      + `air: the terrain-following cruise, from ${air.startS} s to ${air.endS} s. The headline is air.`,
    ...DEFINITIONS,
  });
}

// --- labels ------------------------------------------------------------------------

const SMOOTHNESS_ORDER: Readonly<Record<BenchSmoothness, number>> = {
  smooth: 0,
  "mostly-smooth": 1,
  choppy: 2,
  limited: 3,
  "did-not-run": 4,
};

/**
 * A friend's reading of one window. Against the tier's own hitch threshold,
 * which is 27.4 ms on tiers 0-2 and 60 ms on Ultra, whose target is 30 fps.
 */
export function windowSmoothness(window: BenchWindowMetrics | null): BenchSmoothness {
  if (window === null || window.intervalMs === null) return "did-not-run";
  const over = window.over.hitch;
  if (window.intervalMs.p99 <= over.thresholdMs && over.per240 <= SMOOTH_PER_240) return "smooth";
  if (over.per240 <= MOSTLY_SMOOTH_PER_240) return "mostly-smooth";
  return "choppy";
}

/**
 * A step's label: the worse of its ground and air windows. A step the
 * browser or display held under 50 Hz is "limited", not choppy (S9), and an
 * early stop is choppy by definition.
 */
export function stepSmoothness(step: Pick<BenchStepRecord, "status" | "result">): BenchSmoothness {
  const result = step.result;
  if (result === null || (step.status !== "ok" && step.status !== "early-stop")) return "did-not-run";
  if (result.raf.limited) return "limited";
  if (step.status === "early-stop") return "choppy";
  const ground = windowSmoothness(result.windows.ground);
  const air = windowSmoothness(result.windows.air);
  if (ground === "did-not-run") return air;
  if (air === "did-not-run") return ground;
  return SMOOTHNESS_ORDER[ground] >= SMOOTHNESS_ORDER[air] ? ground : air;
}

export function smoothnessText(label: BenchSmoothness, limitedHz?: number | null): string {
  switch (label) {
    case "smooth":
      return "Smooth";
    case "mostly-smooth":
      return "Mostly smooth";
    case "choppy":
      return "Choppy";
    case "limited":
      return limitedHz
        ? `Limited by browser or display at ${Math.round(limitedHz)} fps`
        : "Limited by browser or display";
    case "did-not-run":
      return "Did not run";
  }
}

export function outcomeText(outcome: BenchStepStatus, message?: string | null): string {
  switch (outcome) {
    case "ok":
      return "Finished";
    case "early-stop":
      return "Stopped early: under 5 fps";
    case "void-hidden":
      return "Void: the tab was hidden on both attempts";
    case "void-resized":
      return "Void: the window changed size on both attempts";
    case "failed":
      return message ? `Failed: ${message}` : "Failed";
    case "interrupted":
      return "Skipped: the page closed during this flight twice";
    case "skipped":
      return "Skipped";
    case "pending":
    case "running":
      return "Not run";
  }
}

/**
 * The verdict in the report page's words: a quality and its flights, never
 * a tier or a step. The first and last flights of one quality are the run's
 * check on itself, which "Valid" passed: steady numbers, not good ones.
 */
export function verdictText(
  run: Pick<BenchReportRun, "status" | "verdict" | "voidReasons" | "repeatability"> & {
    readonly plan: Pick<BenchReportRun["plan"], "tiers">;
  },
): string {
  const pair = run.repeatability
    ? `the first and last ${benchTierName(run.repeatability.tierIndex)} flights`
    : "the first and last flights";
  switch (run.verdict) {
    case "valid":
      return `Valid: ${pair}, flown to check the run, agree within 10%, so its numbers are steady enough to compare.`;
    case "void":
      return `Void: ${run.voidReasons.join("; ")}. Close other programs, let the computer cool, and run it again.`;
    case "incomplete":
      return run.status === "stopped"
        ? "Incomplete: the run was stopped before it could check itself."
        : `Incomplete: one of ${pair}, which check the run, did not finish.`;
    case "unchecked":
      return run.plan.tiers.length < 2
        ? "Unchecked: one flight cannot check itself; fly the same quality first and last (the default list does)."
        : "Unchecked: this run does not start and end on the same quality, so it cannot check itself.";
  }
}

// --- verdict and warnings -------------------------------------------------------------

/**
 * The check flights' fps from one part of the route: the air window when
 * both reached it, otherwise the early check's stretch (3 s to 20 s), which
 * a flight that stopped early has and one that flew on has too. An early
 * stop's fps is the roll and climb's, not the cruise's, so it is never set
 * against an air window.
 */
function checkFlightFps(
  first: BenchStepRecord,
  last: BenchStepRecord,
): { readonly window: BenchRepeatability["window"]; readonly first: number | null; readonly last: number | null } {
  const firstAir = first.result?.windows.air?.fps ?? null;
  const lastAir = last.result?.windows.air?.fps ?? null;
  if (firstAir !== null && lastAir !== null) return { window: "air", first: firstAir, last: lastAir };
  return {
    window: "early-check",
    first: first.result?.flight.earlyCheckFps ?? null,
    last: last.result?.flight.earlyCheckFps ?? null,
  };
}

/**
 * The first and last flights, when the plan flies the same tier first and
 * last (the default does: Medium). Null when it does not.
 */
export function computeRepeatability(steps: readonly BenchStepRecord[]): BenchRepeatability | null {
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first || !last || steps.length < 2 || first.tierIndex !== last.tierIndex) return null;
  const fps = checkFlightFps(first, last);
  const value = spread(fps.first, fps.last);
  const firstCanvas = first.result?.canvas;
  const lastCanvas = last.result?.canvas;
  const canvasChange = firstCanvas && lastCanvas
    ? spread(firstCanvas.cssWidth * firstCanvas.cssHeight, lastCanvas.cssWidth * lastCanvas.cssHeight)
    : null;
  const firstAir = first.result?.windows.air ?? null;
  const lastAir = last.result?.windows.air ?? null;
  const firstRefresh = first.result?.refresh?.rafHz ?? null;
  const lastRefresh = last.result?.refresh?.rafHz ?? null;
  return {
    metric: "meanFps",
    window: fps.window,
    tierIndex: first.tierIndex,
    first: fps.first,
    last: fps.last,
    spread: value,
    threshold: REPEATABILITY_THRESHOLD,
    passed: value !== null && value <= REPEATABILITY_THRESHOLD
      && (canvasChange === null || canvasChange <= CANVAS_CHANGE_THRESHOLD),
    canvasChange,
    secondary: {
      renderP50Spread: spread(firstAir?.renderMs?.p50 ?? null, lastAir?.renderMs?.p50 ?? null),
      intervalP95Spread: spread(firstAir?.intervalMs?.p95 ?? null, lastAir?.intervalMs?.p95 ?? null),
      over27Per240Delta: firstAir && lastAir ? lastAir.over["27.4"].per240 - firstAir.over["27.4"].per240 : null,
      refreshHzDelta: firstRefresh !== null && lastRefresh !== null ? lastRefresh - firstRefresh : null,
    },
  };
}

const FINISHED: ReadonlySet<BenchStepStatus> = new Set<BenchStepStatus>(["ok", "early-stop"]);

/**
 * Valid, void, incomplete or unchecked. Only the check flights' spread over
 * 10%, or the window changing size between them, voids a run; data is kept
 * whatever the verdict.
 */
export function computeVerdict(
  run: Pick<BenchRunRecord, "status" | "steps">,
  repeatability: BenchRepeatability | null,
): { readonly verdict: BenchVerdict; readonly voidReasons: readonly string[] } {
  const steps = run.steps;
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (run.status !== "finished" && run.status !== "running") return { verdict: "incomplete", voidReasons: [] };
  if (repeatability === null) {
    if (!first || !last || steps.length < 2 || first.tierIndex !== last.tierIndex) {
      return { verdict: "unchecked", voidReasons: [] };
    }
    return { verdict: "incomplete", voidReasons: [] };
  }
  if (!first || !last || !FINISHED.has(first.status) || !FINISHED.has(last.status)) {
    return { verdict: "incomplete", voidReasons: [] };
  }
  const reasons: string[] = [];
  if (repeatability.spread === null) return { verdict: "incomplete", voidReasons: [] };
  if (repeatability.spread > REPEATABILITY_THRESHOLD) {
    reasons.push(
      `the first and last ${benchTierName(repeatability.tierIndex)} flights differ by `
      + `${(repeatability.spread * 100).toFixed(1)}% (limit 10%)`
      + (repeatability.window === "early-check" ? ", measured before the cruise because one stopped early" : ""),
    );
  }
  if (repeatability.canvasChange !== null && repeatability.canvasChange > CANVAS_CHANGE_THRESHOLD) {
    reasons.push(`the window changed size by ${(repeatability.canvasChange * 100).toFixed(1)}% between them`);
  }
  return reasons.length > 0 ? { verdict: "void", voidReasons: reasons } : { verdict: "valid", voidReasons: [] };
}

function warning(code: BenchWarning["code"], stepIndex: number | null, message: string): BenchWarning {
  return { code, stepIndex, message };
}

/** Everything worth knowing that does not void the run. */
export function collectWarnings(run: BenchRunRecord): BenchWarning[] {
  const warnings: BenchWarning[] = [];
  const intro = run.introRefresh?.rafHz ?? null;
  const report = run.reportRefresh?.rafHz ?? null;
  if (intro !== null && report !== null && Math.abs(report - intro) / Math.min(report, intro) > REFRESH_CHANGE_THRESHOLD) {
    warnings.push(warning("refresh-changed", null,
      `The browser's frame rate changed from ${intro.toFixed(1)} to ${report.toFixed(1)} Hz during the run.`));
  }
  if (run.settingsKeyAtStart !== null && run.settingsKeyAtEnd !== null && run.settingsKeyAtStart !== run.settingsKeyAtEnd) {
    warnings.push(warning("settings-key-changed", null,
      "The game's saved settings changed during the run. The bench never writes them: this is a bug."));
  }
  if (run.device?.battery && !run.device.battery.charging) {
    warnings.push(warning("battery-discharging", null, "The computer was on battery when the run started."));
  }
  for (const step of run.steps) {
    const result = step.result;
    const at = step.index;
    const name = `Flight ${at + 1} (${benchTierName(step.tierIndex)})`;
    if (step.status === "failed" && step.message) {
      warnings.push(warning("step-failed", at, `${name} failed: ${step.message}.`));
    }
    if (!result) continue;
    if (!result.settle.reachedRest) {
      warnings.push(warning("settle-not-at-rest", at, `${name}: the world was still loading when the flight began.`));
    }
    for (const window of [result.windows.ground, result.windows.air]) {
      if (window && window.lowSample && FINISHED.has(step.status) && step.status !== "early-stop") {
        const where = window.name === "ground" ? "on the runway" : "in the air";
        warnings.push(warning("low-sample", at, `${name}: only ${window.frames} frames ${where}.`));
      }
    }
    if (!result.path.matchesExpected) {
      warnings.push(warning("path-fingerprint", at,
        `${name}: the route's fingerprint ${result.path.fingerprint} differs from this build's.`));
    }
    if (result.environment.wakeLock === "denied") {
      warnings.push(warning("wake-lock-denied", at, `${name}: the screen could have dimmed or slept.`));
    }
    if (result.environment.battery && !result.environment.battery.charging) {
      warnings.push(warning("battery-discharging", at, `${name}: on battery.`));
    }
    if (result.environment.ignoredRendererCalls > 0) {
      warnings.push(warning("ignored-renderer-calls", at,
        `${name}: ${result.environment.ignoredRendererCalls} renderer setting changes were blocked mid-flight.`));
    }
    if (result.environment.focusLostMs > 0) {
      warnings.push(warning("focus-lost", at,
        `${name}: the window lost focus for ${(result.environment.focusLostMs / 1_000).toFixed(1)} s.`));
    }
    if (result.environment.overflowed) {
      warnings.push(warning("frame-log-overflow", at, `${name}: more frames than the log holds; the last were not recorded.`));
    }
    if (result.raf.disagrees) {
      warnings.push(warning("raf-disagrees", at,
        `${name}: frames came at ${result.raf.flight?.hz.toFixed(1)} Hz in flight against `
        + `${result.raf.idleHz?.toFixed(1)} Hz idle (variable or switching refresh rate?).`));
    }
    if (result.raf.limited) {
      warnings.push(warning("raf-limited", at,
        `${name}: the browser or display ran at ${result.raf.idleHz?.toFixed(0)} Hz (power saving?). `
        + "Left out of How it felt."));
    }
    const pacerHz = result.pacing.cadenceAtFlightStart?.displayHz ?? null;
    const idleHz = result.refresh?.rafHz ?? null;
    if (pacerHz !== null && idleHz !== null && Math.abs(pacerHz - idleHz) / Math.min(pacerHz, idleHz) > PACER_PERIOD_THRESHOLD) {
      warnings.push(warning("pacer-period-disagrees", at,
        `${name}: the frame pacer read the display as ${pacerHz.toFixed(1)} Hz against `
        + `${idleHz.toFixed(1)} Hz idle (slow frames before the pacer confirmed the rate, or a rate switch?).`));
    }
    if (result.timer.coarse) {
      warnings.push(warning("timer-coarse", at,
        `${name}: the browser's clock steps ${result.timer.granularityMs} ms; render times are coarse.`));
    }
  }
  return warnings;
}

// --- building the report --------------------------------------------------------------

/** Each tier's resolved profile, whole, with what the bench derives from it. */
export function benchProfiles(tiers: readonly number[]): Record<string, BenchProfileEntry> {
  const profiles: Record<string, BenchProfileEntry> = {};
  for (const tierIndex of [...new Set(tiers)].sort((a, b) => a - b)) {
    if (!isBenchTierIndex(tierIndex)) continue;
    const tier = benchTier(tierIndex);
    const profile = benchProfile(tierIndex);
    const json = toBenchJson(profile);
    profiles[String(tierIndex)] = {
      quality: tier.quality,
      renderingMode: tier.renderingMode,
      fingerprint: fnv1aHex(JSON.stringify(json)),
      hitchThresholdMs: hitchThresholdMilliseconds(profile),
      governorConfig: governorConfigForProfile(profile),
      profile: json,
    };
  }
  return profiles;
}

function workloadFor(run: BenchRunRecord): BenchWorkload {
  return {
    hud: run.plan.hud ? "bench-portal" : "off",
    simWorker: "attract",
    audio: "none",
    spawnedAirports: false,
    pilotInput: false,
    frameCap: run.plan.frameRate,
    frameCapEffective: effectiveFrameRate(run.plan.frameRate),
    shippedFrameRate: DEFAULT_SETTINGS.frameRate,
    shippedFrameRateEffective: effectiveFrameRate(DEFAULT_SETTINGS.frameRate),
  };
}

/**
 * A quick run, or one whose frame rate behaves unlike its mode's default:
 * `fps=30` in shipped mode is, and so is `fps=60` in pinned mode, because
 * 60 fps paces. A setting that this build draws the same way as the default
 * is not.
 */
export function isNonStandardRun(plan: Pick<BenchRunPlan, "quick" | "mode" | "frameRate">): boolean {
  return plan.quick || effectiveFrameRate(plan.frameRate) !== effectiveFrameRate(defaultBenchFrameRate(plan.mode));
}

function reportSteps(run: BenchRunRecord): BenchReportStep[] {
  return run.steps.map((step) => {
    const tier = isBenchTierIndex(step.tierIndex) ? benchTier(step.tierIndex) : benchTier(1);
    return {
      index: step.index,
      tierIndex: step.tierIndex,
      quality: tier.quality,
      renderingMode: tier.renderingMode,
      mode: run.plan.mode,
      outcome: step.status,
      message: step.message,
      attempts: step.attempts,
      attemptLog: step.attemptLog,
      label: stepSmoothness(step),
      result: step.result,
    };
  });
}

/**
 * Each quality's label: the worst of its flights that measured the game.
 * Without one, a flight the browser held under 50 Hz says more than one that
 * did not run, whichever came first.
 */
function tierLabels(steps: readonly BenchReportStep[]): BenchReportRun["tierLabels"] {
  const labels = new Map<number, BenchSmoothness>();
  for (const step of steps) {
    const current = labels.get(step.tierIndex);
    if (step.label === "limited" || step.label === "did-not-run") {
      if (current === undefined || (current === "did-not-run" && step.label === "limited")) {
        labels.set(step.tierIndex, step.label);
      }
      continue;
    }
    if (current === undefined || current === "limited" || current === "did-not-run"
      || SMOOTHNESS_ORDER[step.label] > SMOOTHNESS_ORDER[current]) {
      labels.set(step.tierIndex, step.label);
    }
  }
  return [...labels].sort(([a], [b]) => a - b).map(([tierIndex, label]) => ({ tierIndex, label }));
}

function reportRun(run: BenchRunRecord, steps: readonly BenchReportStep[]): BenchReportRun {
  const repeatability = computeRepeatability(run.steps);
  const { verdict, voidReasons } = computeVerdict(run, repeatability);
  return {
    id: run.runId,
    plan: run.plan,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    verdict,
    voidReasons,
    warnings: collectWarnings(run),
    repeatability,
    userLabel: run.userLabel,
    ignoredParams: run.ignoredParams,
    workload: workloadFor(run),
    settingsKeyUnchanged: run.settingsKeyAtStart !== null && run.settingsKeyAtEnd !== null
      ? run.settingsKeyAtStart === run.settingsKeyAtEnd
      : null,
    nonStandard: isNonStandardRun(run.plan),
    firstLoad: run.firstLoad,
    tierLabels: tierLabels(steps),
  };
}

export interface BuildReportInput {
  readonly run: BenchRunRecord;
  /** Earlier runs of the tab, e.g. the shipped run under a pinned pass (N6). */
  readonly earlier?: readonly BenchRunRecord[];
  readonly build: BenchBuildInfo;
  readonly createdAt: string;
}

export function buildReport(input: BuildReportInput): BenchReport {
  const steps = reportSteps(input.run);
  const earlier = input.earlier ?? [];
  const tiers = [...input.run.plan.tiers, ...earlier.flatMap((run) => run.plan.tiers)];
  return {
    schema: BENCH_SCHEMA,
    benchVersion: BENCH_VERSION,
    createdAt: input.createdAt,
    build: input.build,
    run: reportRun(input.run, steps),
    device: input.run.device,
    display: { intro: input.run.introRefresh, report: input.run.reportRefresh },
    profiles: benchProfiles(tiers),
    steps,
    earlierRuns: earlier.map((run): BenchEarlierRun => {
      const earlierSteps = reportSteps(run);
      return {
        run: reportRun(run, earlierSteps),
        display: { intro: run.introRefresh, report: run.reportRefresh },
        steps: earlierSteps,
      };
    }),
    definitions: benchDefinitions(input.run.plan.windows),
  };
}

/** The end-of-flight context from one `getDiagnostics()`. */
export function endContextFromDiagnostics(diagnostics: RenderDiagnostics): BenchEndContext {
  return {
    adapterLabel: diagnostics.adapter,
    drawCalls: diagnostics.drawCalls,
    triangles: diagnostics.triangles,
    visibleInstances: diagnostics.visibleInstances,
    residentTerrainPages: diagnostics.residentTerrainPages,
    pendingTerrainPages: diagnostics.pendingTerrainPages,
    pendingDetailWork: diagnostics.pendingDetailWork,
    estimatedGpuMemoryMiB: diagnostics.estimatedGpuMemoryMiB,
    inventoriedGpuMemoryMiB: diagnostics.inventoriedGpuMemoryMiB,
    hitchCount: diagnostics.hitchCount,
    p999FrameMs: diagnostics.p999FrameMs,
    presentWaitP95Ms: diagnostics.presentWaitP95Ms,
    topPassesByCpuMs: diagnostics.topPassesByCpuMs.map((pass) => ({ name: pass.name, p95Ms: pass.p95Ms })),
    gpuPassMs: { ...diagnostics.gpuPassMs },
  };
}

// --- JSON ---------------------------------------------------------------------------------

/**
 * JSON with the report's number rules: NaN and undefined become null,
 * infinities become the strings "Infinity" and "-Infinity" (a lever's
 * "unbounded" must not read as a profile default's null), and fractions keep
 * three decimals, which is finer than any timer a player's browser has.
 */
export function reportToJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return null;
    if (typeof item !== "number") return item;
    if (Number.isNaN(item)) return null;
    if (item === Number.POSITIVE_INFINITY) return "Infinity";
    if (item === Number.NEGATIVE_INFINITY) return "-Infinity";
    return Number.isInteger(item) ? item : Math.round(item * 1_000) / 1_000;
  }, space);
}

/** A plain JSON copy of anything, by the report's number rules. */
export function toBenchJson(value: unknown): BenchJson {
  return JSON.parse(reportToJson(value)) as BenchJson;
}

type Mutable = Record<string, unknown>;

function eachStep(report: Mutable, edit: (step: Mutable) => void): void {
  const runs = [report, ...((report.earlierRuns as Mutable[] | undefined) ?? [])];
  for (const run of runs) {
    for (const step of (run.steps as Mutable[] | undefined) ?? []) {
      const result = step.result as Mutable | null | undefined;
      if (result) edit(result);
    }
  }
}

/**
 * What the compact copy drops, in order, until it fits: first the bulk the
 * download keeps (S4), then detail a reader of the table can live without.
 */
const COMPACT_STAGES: readonly { readonly name: string; readonly apply: (report: Mutable) => void }[] = [
  {
    name: "perSecond, histogram, decisions",
    apply: (report) => eachStep(report, (result) => {
      delete result.perSecond;
      delete result.histogram;
      const governor = result.governor as Mutable | undefined;
      if (governor) delete governor.decisions;
    }),
  },
  {
    name: "detail presentation, long-animation-frame scripts, compile events",
    apply: (report) => eachStep(report, (result) => {
      const detail = result.detailWorker as Mutable | undefined;
      if (detail) {
        delete detail.presentationAtSettleEnd;
        delete detail.presentationAtEnd;
      }
      const frames = result.longAnimationFrames as Mutable | undefined;
      if (frames) delete frames.top;
      const compiles = result.compiles as Mutable | undefined;
      if (compiles) delete compiles.firstEvents;
    }),
  },
  {
    name: "worst frames, segments, startup stages",
    apply: (report) => eachStep(report, (result) => {
      delete result.worst;
      delete result.segments;
      const startup = result.startup as Mutable | undefined;
      if (startup) delete startup.rendererStages;
    }),
  },
  {
    name: "profiles",
    apply: (report) => {
      for (const entry of Object.values((report.profiles as Record<string, Mutable> | undefined) ?? {})) {
        delete entry.profile;
      }
    },
  },
  {
    name: "earlier runs' steps",
    apply: (report) => {
      for (const run of (report.earlierRuns as Mutable[] | undefined) ?? []) delete run.steps;
    },
  },
  {
    name: "governor windows, end context",
    apply: (report) => eachStep(report, (result) => {
      const governor = result.governor as Mutable | undefined;
      if (governor) {
        delete governor.windows;
        delete governor.flight;
      }
      delete result.end;
    }),
  },
];

/**
 * The clipboard copy: compact JSON under `maxChars`, with a `compacted` list
 * naming what it left out. The download keeps everything.
 */
export function compactReportJson(report: BenchReport, maxChars = COMPACT_REPORT_MAX): string {
  const copy = toBenchJson(report) as Mutable;
  const compacted: string[] = [];
  let text = reportToJson({ ...copy, compacted });
  for (const stage of COMPACT_STAGES) {
    if (text.length <= maxChars) break;
    stage.apply(copy);
    compacted.push(stage.name);
    text = reportToJson({ ...copy, compacted });
  }
  return text;
}

// --- words, tables and links -------------------------------------------------------------

function firstVersion(brands: readonly string[], names: readonly string[]): string | null {
  for (const name of names) {
    const brand = brands.find((entry) => entry.startsWith(`${name} `) || entry === name);
    if (brand) return brand;
  }
  return null;
}

/** "Chrome 130", "Edge 130", "Firefox 132", "Safari 18.1". */
export function describeBrowser(device: BenchDeviceReport | null): string {
  if (!device) return "unknown browser";
  const listed = device.uaData?.fullVersionList ?? [];
  const brands = listed.length > 0 ? listed : device.uaData?.brands ?? [];
  const brand = firstVersion(brands, ["Microsoft Edge", "Opera", "Brave", "Google Chrome", "Chromium"]);
  if (brand) {
    const [name, version] = [brand.slice(0, brand.lastIndexOf(" ")), brand.slice(brand.lastIndexOf(" ") + 1)];
    const short = name.replace(/^Google /, "").replace(/^Microsoft /, "");
    return `${short} ${version.split(".")[0]}`;
  }
  const ua = device.userAgent;
  const match = /Edg\/(\d+)/.exec(ua) ?? null;
  if (match) return `Edge ${match[1]}`;
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (firefox) return `Firefox ${firefox[1]}`;
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (chrome) return `Chrome ${chrome[1]}`;
  const safari = /Version\/([\d.]+).*Safari\//.exec(ua);
  if (safari) return `Safari ${safari[1]}`;
  return "unknown browser";
}

/** "Windows 11", "macOS 14.5", "Linux", "Android 14". */
export function describeOs(device: BenchDeviceReport | null): string {
  if (!device) return "unknown OS";
  const data = device.uaData;
  if (data && data.platform) {
    const version = data.platformVersion ?? "";
    if (data.platform === "Windows") {
      const major = Number.parseInt(version.split(".")[0] ?? "", 10);
      if (Number.isFinite(major) && major > 0) return major >= 13 ? "Windows 11" : "Windows 10";
      return "Windows";
    }
    if (data.platform === "macOS") return version ? `macOS ${version.split(".").slice(0, 2).join(".")}` : "macOS";
    return version ? `${data.platform} ${version.split(".")[0]}` : data.platform;
  }
  const ua = device.userAgent;
  if (/Windows NT/.test(ua)) return "Windows";
  const mac = /Mac OS X (\d+)[_.](\d+)/.exec(ua);
  if (mac) return `macOS ${mac[1]}.${mac[2]}`;
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "unknown OS";
}

/** The GPU as WebGPU names it: vendor and architecture, plus device and description when given. */
export function describeGpu(device: BenchDeviceReport | null): string {
  const adapter = device?.webgpu.adapter;
  const parts = adapter
    ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter((part) => part.trim() !== "")
    : [];
  if (parts.length > 0) return [...new Set(parts)].join(" ");
  return device?.webgpu.rendererLabel?.trim() || "unknown GPU";
}

/** One line: the reporter's label (if any), the GPU, the OS, the browser, the refresh rate. */
export function deviceLine(report: BenchReport): string {
  const parts = [
    report.run.userLabel ? `"${report.run.userLabel}"` : null,
    describeGpu(report.device),
    describeOs(report.device),
    describeBrowser(report.device),
    report.display.intro ? `${report.display.intro.rafHz.toFixed(0)} Hz` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** "0.4", or a dash when there is no number: the report's cells and the page's. */
export function decimalText(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits);
}

/**
 * The air window's share of frames at the scale floor: a dash, as the other
 * air cells, for a flight that never reached the window, and "n/a" where the
 * resolution lever cannot move (a floor at the ceiling, the 0.4 Mpx
 * minimum, pinned).
 */
function floorShareText(result: BenchStepResult | null): string {
  const window = result?.governor.windows.air;
  if (!result?.windows.air || !window || window.frames === 0) return "–";
  const share = window.share.atScaleFloor;
  return share === null ? "n/a" : `${Math.round(share * 100)}%`;
}

export const REPORT_TABLE_COLUMNS = Object.freeze([
  "Quality",
  "Avg fps",
  "1% low",
  "Slow frames (over 27.4 ms) per 240",
  "Stutters (over 50 ms) per 240",
  "Render p95",
  "At scale floor",
  "Governor at end",
  "On the runway",
  "Result",
] as const);

/** One row of the report page's table; `cells` follow `REPORT_TABLE_COLUMNS`. */
export interface BenchTableRow {
  readonly stepIndex: number;
  readonly tierIndex: number;
  readonly tierName: string;
  readonly outcome: BenchStepStatus;
  readonly label: BenchSmoothness;
  /** The air window's fps, or null. */
  readonly fps: number | null;
  readonly groundFps: number | null;
  readonly firstRendererInTab: boolean;
  /**
   * The report page's Result: the label and, for a flight that did not
   * finish, how it ended. A failure's message is left to the warnings, so
   * one long error cannot push every row's numbers out of view.
   */
  readonly resultText: string;
  /** The summary's and the issue's columns, a failure's message included. */
  readonly cells: readonly string[];
}

/** The table rows for a report's own run (or one of its earlier runs). */
export function reportTableRows(steps: readonly BenchReportStep[]): BenchTableRow[] {
  return steps.map((step) => {
    const result = step.result;
    const air = result?.windows.air ?? null;
    const ground = result?.windows.ground ?? null;
    const governor = result?.governor.atEnd ?? null;
    const label = smoothnessText(step.label, result?.raf.idleHz);
    const ended = step.outcome === "ok" ? null : outcomeText(step.outcome);
    const outcome = step.outcome === "ok" ? null : outcomeText(step.outcome, step.message);
    return {
      stepIndex: step.index,
      tierIndex: step.tierIndex,
      tierName: benchTierName(step.tierIndex),
      outcome: step.outcome,
      label: step.label,
      fps: air?.fps ?? null,
      groundFps: ground?.fps ?? null,
      firstRendererInTab: result?.firstRendererInTab ?? false,
      resultText: ended ? `${label} (${ended})` : label,
      cells: [
        benchTierName(step.tierIndex),
        decimalText(air?.fps),
        decimalText(air?.onePercentLowFps),
        decimalText(air?.over["27.4"].per240),
        decimalText(air?.over["50"].per240),
        air?.renderMs ? `${air.renderMs.p95.toFixed(1)} ms` : "–",
        floorShareText(result),
        governor
          ? `${governor.mode}, scale ${governor.appliedScale.toFixed(2)}, CPU ${governor.cpuLevel}, GPU ${governor.gpuLevel}`
          : "–",
        ground ? `${decimalText(ground.fps)} fps, ${decimalText(ground.over["27.4"].per240)} slow` : "–",
        outcome ? `${label} (${outcome})` : label,
      ],
    };
  });
}

function markdownTable(columns: readonly number[], rows: readonly BenchTableRow[]): string {
  const header = columns.map((column) => REPORT_TABLE_COLUMNS[column]!);
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${columns.map((column) => row.cells[column]!.replace(/\|/g, "/")).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function spreadLine(report: BenchReport): string {
  const repeatability = report.run.repeatability;
  if (!repeatability || repeatability.spread === null) return `Verdict: ${report.run.verdict}`;
  return `Verdict: ${report.run.verdict} · spread ${(repeatability.spread * 100).toFixed(1)}% (limit 10%)`;
}

function buildLine(report: BenchReport): string {
  const build = report.build.commit
    ? `build ${report.build.commit.slice(0, 12)}`
    : report.build.entryScript
      ? `entry ${report.build.entryScript}`
      : "build unknown";
  const plan = report.run.plan;
  const nonStandard = report.run.nonStandard ? ` · ${plan.quick ? "quick " : ""}(non-standard)` : "";
  return `${build} · run ${report.run.id} · fps=${plan.frameRate}${nonStandard}`;
}

/** "Copy short summary": a few lines for a chat message. */
export function summaryMarkdown(report: BenchReport): string {
  const rows = reportTableRows(report.steps);
  return [
    `**fly high benchmark** (${report.run.plan.mode}): ${deviceLine(report)}`,
    markdownTable([0, 1, 2, 3, 4, 9], rows),
    spreadLine(report),
    buildLine(report),
  ].join("\n");
}

export function issueTitle(report: BenchReport): string {
  const who = report.run.userLabel ?? describeGpu(report.device);
  const title = `Benchmark: ${who} · ${describeOs(report.device)} · ${describeBrowser(report.device)} · ${report.run.verdict}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

const ISSUE_PASTE_LINE = "Paste the report (it's on your clipboard) into the block below, or attach the downloaded .json.";

function issueBody(report: BenchReport, columns: readonly number[], rowCount: number): string {
  const rows = reportTableRows(report.steps).slice(0, rowCount);
  const parts = [
    deviceLine(report),
    "",
    ...(columns.length > 0 && rows.length > 0 ? [markdownTable(columns, rows), ""] : []),
    spreadLine(report),
    buildLine(report),
    "",
    ISSUE_PASTE_LINE,
    "",
    "```json",
    "",
    "```",
  ];
  return parts.join("\n");
}

function issueHref(title: string, body: string): string {
  return `https://github.com/${BENCH_ISSUE_REPO}/issues/new?title=${encodeURIComponent(title)}`
    + `&body=${encodeURIComponent(body)}`;
}

/**
 * A new-issue link with the title, the device line, the table, the spread,
 * the build and an empty JSON block for the paste. Over `maxChars` encoded,
 * it drops columns, then rows, then the table.
 */
export function issueUrl(report: BenchReport, maxChars = ISSUE_URL_MAX): string {
  const title = issueTitle(report);
  // Columns in the order they go: least needed first. Tier, fps and result stay longest.
  let columns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const dropOrder = [7, 8, 6, 5, 2, 4, 3];
  let rowCount = report.steps.length;
  let href = issueHref(title, issueBody(report, columns, rowCount));
  for (const column of dropOrder) {
    if (href.length <= maxChars) return href;
    columns = columns.filter((kept) => kept !== column);
    href = issueHref(title, issueBody(report, columns, rowCount));
  }
  while (href.length > maxChars && rowCount > 0) {
    rowCount -= 1;
    href = issueHref(title, issueBody(report, columns, rowCount));
  }
  if (href.length <= maxChars) return href;
  // Only a tiny cap gets here: cut the link, never inside a percent escape.
  return issueHref(title.slice(0, 60), issueBody(report, [], 0)).slice(0, maxChars).replace(/%[0-9A-F]?$/i, "");
}

/** `fly-high-bench-<vendor>-<ISO time>.json`, safe on every file system. */
export function reportFileName(report: BenchReport): string {
  const vendor = (report.device?.webgpu.adapter?.vendor ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
  const time = report.createdAt.replace(/\.\d+/, "").replace(/:/g, "-").replace(/[^0-9A-Za-z-]/g, "");
  return `fly-high-bench-${vendor}-${time}.json`;
}
