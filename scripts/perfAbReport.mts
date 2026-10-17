/**
 * The cloud A/B's report: its shape (`report.json`) and its Markdown summary
 * (`report.md`, also appended to a GitHub job summary). Pure; no I/O.
 */

import type {
  AgentErrors,
  FrameSample,
  ImageComparison,
  ShotDiagnostics,
} from "../tests/perf/ab/protocol.ts";
import { comparePaired, median, roundsToClear, type PairedComparison, type Verdict } from "./perfAbStats.mts";

export type ArmName = "base" | "head";

export interface ArmIdentity {
  readonly ref: string;
  readonly sha: string;
  /** The head arm was built from a working tree with uncommitted changes. */
  readonly dirty: boolean;
  readonly profileOverride: Readonly<Record<string, unknown>> | null;
}

/**
 * `gpu`: the frame's GPU passes, timed by timestamp queries. `cpu`:
 * `renderer.render()` on the main thread. `wall`: the frame from `render()` to
 * GPU idle.
 */
export type TimingMetric = "gpu" | "cpu" | "wall";

/**
 * What to time and what to gate. GPU time comes from timestamp queries when
 * the adapter has them; where it has not, the fenced frame's wall time is
 * gated in its place.
 */
export function chooseMetrics(timestampQuery: boolean): { timed: TimingMetric[]; gated: TimingMetric[] } {
  return timestampQuery
    ? { timed: ["gpu", "cpu", "wall"], gated: ["gpu", "cpu"] }
    : { timed: ["cpu", "wall"], gated: ["wall", "cpu"] };
}

export interface MetricResult {
  readonly metric: TimingMetric;
  /** Gated metrics share one Holm family and decide the run's verdict. */
  readonly gated: boolean;
  /**
   * A gated metric that can fail the run but cannot hold it inconclusive: a
   * slowdown it resolves is a regression, an interval too wide to clear a
   * change is not. For a metric too noisy on this host to clear one at the
   * run's round count; see `perf-ab.mts`'s backend defaults.
   */
  readonly guard: boolean;
  readonly comparison: PairedComparison;
  readonly pSlowerAdjusted: number | null;
  readonly pFasterAdjusted: number | null;
  readonly verdict: Verdict | null;
}

export interface PassTimingChange {
  readonly key: string;
  /** Per frame, milliseconds: the median, or the mean for a pass on a cadence. */
  readonly baseMs: number;
  readonly headMs: number;
  readonly ratio: number;
  readonly ratioLow: number | null;
  readonly ratioHigh: number | null;
  /**
   * The pass skipped some rounds, as one on a cadence does (the cloud shadow,
   * every few frames). Its ratio and interval are then per run, over the
   * rounds in which both arms ran it.
   */
  readonly cadenced: boolean;
  /** Rounds behind the ratio: every round, or those in which both arms ran a cadenced pass. */
  readonly rounds: number;
}

/** One measured frame of one arm. */
export interface MeasuredSample extends FrameSample {
  readonly round: number;
  readonly arm: ArmName;
}

/** Each round's total for one arm: the round, not the frame, is the paired unit. */
export function roundTotals(
  samples: readonly MeasuredSample[],
  arm: ArmName,
  rounds: number,
  read: (sample: MeasuredSample) => number,
): number[] {
  const totals = new Array<number>(rounds).fill(0);
  for (const sample of samples) if (sample.arm === arm) totals[sample.round] = totals[sample.round]! + read(sample);
  return totals;
}

/**
 * Where the GPU time moved, pass by pass, largest change first. Passes below
 * half a per cent of the frame are dropped as noise at this resolution.
 */
export function passTimingChanges(
  samples: readonly MeasuredSample[],
  rounds: number,
  framesPerArmPerRound: number,
): PassTimingChange[] {
  const keys = new Set<string>();
  for (const sample of samples) for (const key of Object.keys(sample.passes)) keys.add(key);
  if (keys.size === 0) return [];
  const frameGpu = median(roundTotals(samples, "base", rounds, (sample) => sample.gpuMs)) / framesPerArmPerRound;
  const changes: PassTimingChange[] = [];
  for (const key of keys) {
    const base = roundTotals(samples, "base", rounds, (sample) => sample.passes[key] ?? 0);
    const head = roundTotals(samples, "head", rounds, (sample) => sample.passes[key] ?? 0);
    const cadenced = !base.every((value) => value > 0) || !head.every((value) => value > 0);
    const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
    // A median of round totals would read a cadence's own rhythm, so a pass
    // that skips rounds is shown as its mean per frame instead.
    const baseMs = cadenced ? sum(base) / (rounds * framesPerArmPerRound) : median(base) / framesPerArmPerRound;
    const headMs = cadenced ? sum(head) / (rounds * framesPerArmPerRound) : median(head) / framesPerArmPerRound;
    if (Math.max(baseMs, headMs) < frameGpu * 0.005) continue;
    let comparison: PairedComparison | null = null;
    let paired = rounds;
    if (!cadenced) {
      comparison = comparePaired(base, head);
    } else {
      // Per run, over the rounds both arms ran it. Every cadence keys on the
      // frame index, which the arms share, so those are usually the same rounds.
      const ran = (arm: ArmName) => roundTotals(samples, arm, rounds, (sample) => (key in sample.passes ? 1 : 0));
      const baseRuns = ran("base");
      const headRuns = ran("head");
      const both = base
        .map((_, round) => round)
        .filter((round) => base[round]! > 0 && head[round]! > 0);
      paired = both.length;
      if (both.length >= 2) {
        comparison = comparePaired(
          both.map((round) => base[round]! / baseRuns[round]!),
          both.map((round) => head[round]! / headRuns[round]!),
        );
      }
    }
    changes.push({
      key,
      baseMs,
      headMs,
      ratio: comparison?.ratio ?? (baseMs > 0 ? headMs / baseMs : Number.POSITIVE_INFINITY),
      ratioLow: comparison?.ratioLow ?? null,
      ratioHigh: comparison?.ratioHigh ?? null,
      cadenced,
      rounds: paired,
    });
  }
  return changes.sort((a, b) => Math.abs(b.headMs - b.baseMs) - Math.abs(a.headMs - a.baseMs));
}

export interface CountChange {
  readonly key: string;
  readonly base: number;
  readonly head: number;
}

export interface ShotResult {
  readonly name: string;
  readonly canonicalShotIndex: number;
  readonly status: "measured" | "unsettled" | "failed";
  readonly failure: string | null;
  readonly elapsedSeconds: number;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly raster: { readonly width: number; readonly height: number } | null;
  readonly renderScale: number | null;
  readonly streaming: Readonly<Record<ArmName, {
    readonly frames: number;
    readonly settled: boolean;
    readonly seconds: number;
    readonly bakedWhileClosed: Readonly<Record<string, number>>;
  }>> | null;
  readonly padded: { readonly arm: ArmName; readonly frames: number } | null;
  readonly metrics: readonly MetricResult[];
  readonly passes: readonly PassTimingChange[];
  /** Per-frame averages of the settle's counted frames. */
  readonly work: {
    readonly base: Readonly<Record<string, number>>;
    readonly head: Readonly<Record<string, number>>;
    readonly changes: readonly CountChange[];
    /** `pass key › field` for every per-pass count that differs. */
    readonly passChanges: readonly CountChange[];
  } | null;
  readonly diagnostics: {
    readonly base: ShotDiagnostics;
    readonly head: ShotDiagnostics;
    readonly changes: readonly CountChange[];
  } | null;
  readonly ceilings: {
    readonly drawCallCeiling: number | null;
    /** The most draw calls on any counted frame: what a ceiling must hold. */
    readonly baseDrawCalls: number;
    readonly headDrawCalls: number;
    /** The fewest, which differs from the most only when a pass runs on a cadence. */
    readonly baseDrawCallsMin: number;
    readonly headDrawCallsMin: number;
    readonly memoryCeilingMiB: number;
    readonly headMemoryMiB: number;
    /** Only a breach the base did not already have counts against the head. */
    readonly newBreaches: readonly string[];
  } | null;
  /** Head against base, same frame. */
  readonly pixels: ImageComparison | null;
  /** Each arm against the committed (reference-Mac) baseline, when one exists. */
  readonly baseline: Readonly<Record<ArmName, ImageComparison | null>> | null;
  /** Pipelines and shader modules created during measured frames: hitch causes. */
  readonly measuredFrameCreations: Readonly<Record<ArmName, { readonly pipelines: number; readonly shaderModules: number }>> | null;
  readonly invalidPasses: Readonly<Record<ArmName, number>> | null;
  /** Every measured frame, in milliseconds. */
  readonly samples: readonly {
    readonly round: number;
    readonly arm: ArmName;
    readonly gpuMs: number;
    readonly renderMs: number;
    readonly wallMs: number;
  }[];
}

export type RunVerdict = "regression" | "no-regression" | "inconclusive" | "failed";

export interface PerfAbReport {
  readonly tool: "perf-ab";
  readonly reportVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: "ab" | "aa";
  readonly base: ArmIdentity;
  readonly head: ArmIdentity;
  readonly host: {
    readonly platform: string;
    readonly cpus: number;
    readonly cpuModel: string;
    readonly memoryGiB: number;
    readonly node: string;
    readonly browser: string;
    readonly backend: string;
    readonly adapter: string;
  };
  readonly settings: {
    readonly rounds: number;
    /** Frames each arm renders per round (two turns of ABBA). Round totals sum them. */
    readonly framesPerArmPerRound: number;
    /** Every metric the run timed, in report order. */
    readonly timedMetrics: readonly TimingMetric[];
    /** The subset that can fail the run; see `perf-ab.mts`'s choice of them. */
    readonly gatedMetrics: readonly TimingMetric[];
    /** The gated metrics that are guards (`MetricResult.guard`). */
    readonly guardMetrics: readonly TimingMetric[];
    /** The smallest change each metric's verdict calls; see `perf-ab.mts`'s defaults. */
    readonly thresholds: Readonly<Record<TimingMetric, number>>;
    readonly alpha: number;
    /**
     * A part of a run split across parallel jobs (`--part`): every
     * `count`-th shot from the `index`-th, tested at `alpha` above, the run's
     * alpha divided by `count`. Null for a whole run.
     */
    readonly part: { readonly index: number; readonly count: number; readonly runAlpha: number } | null;
    readonly renderScale: number | null;
    readonly openFrames: number;
    readonly settleFrames: number;
    readonly countFrames: number;
    readonly minStreamFrames: number;
    readonly maxStreamFrames: number;
    readonly quality: string;
    readonly renderingMode: string;
    readonly aircraft: string;
    /**
     * The options that take the run off the capture's own settings (the
     * trainer, medium, balanced, each shot's render scale), for which every
     * ceiling and baseline is pinned. When any, ceilings are not gated and no
     * baseline is compared.
     */
    readonly offCanonical: readonly string[];
  };
  readonly shots: readonly ShotResult[];
  readonly errors: Readonly<Record<ArmName, AgentErrors>>;
  readonly summary: {
    readonly verdict: RunVerdict;
    readonly reasons: readonly string[];
    readonly geometricMeanRatio: Readonly<Record<TimingMetric, number | null>>;
  };
}

/** The run's verdict from its shots: the most serious outcome wins. */
export function summarize(
  shots: readonly ShotResult[],
  errors: Readonly<Record<ArmName, AgentErrors>>,
): { verdict: RunVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const headErrors = Object.values(errors.head).reduce((sum, list) => sum + list.length, 0);
  if (headErrors > 0) reasons.push(`the head logged ${headErrors} renderer error(s)`);
  for (const shot of shots) {
    if (shot.status !== "measured") reasons.push(`${shot.name}: ${shot.failure ?? shot.status}`);
  }
  if (reasons.length > 0) return { verdict: "failed", reasons };
  for (const shot of shots) {
    for (const metric of shot.metrics) {
      if (metric.gated && metric.verdict === "slower") {
        reasons.push(`${shot.name}: ${metricName(metric.metric)} ${formatRatio(metric.comparison.ratio)} slower`);
      }
    }
    for (const breach of shot.ceilings?.newBreaches ?? []) reasons.push(`${shot.name}: ${breach}`);
  }
  if (reasons.length > 0) return { verdict: "regression", reasons };
  for (const shot of shots) {
    for (const metric of shot.metrics) {
      if (metric.gated && !metric.guard && metric.verdict === "inconclusive") {
        reasons.push(`${shot.name}: ${metricName(metric.metric)} inconclusive (${formatInterval(metric.comparison)})`);
      }
    }
  }
  if (reasons.length > 0) return { verdict: "inconclusive", reasons };
  return { verdict: "no-regression", reasons };
}

/** Collapses text to one line: page errors carry stack traces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Text safe inside a Markdown table cell or list item. */
function markdownText(text: string): string {
  return oneLine(text).replace(/\|/gu, "\\|");
}

export function metricName(metric: TimingMetric): string {
  switch (metric) {
    case "gpu":
      return "GPU time";
    case "cpu":
      return "CPU time";
    case "wall":
      return "Frame wall time";
  }
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(3)}x`;
}

function formatInterval(comparison: PairedComparison): string {
  if (comparison.ratioLow === null || comparison.ratioHigh === null) return "too few rounds for an interval";
  return `${formatPercent(comparison.ratioLow - 1)} to ${formatPercent(comparison.ratioHigh - 1)}`;
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function drawCallRange(min: number, max: number): string {
  return min === max ? String(max) : `${min}–${max} (varies by frame)`;
}

function metricCell(metric: MetricResult | undefined): string {
  if (!metric) return "n/a";
  const label = metric.verdict ?? "";
  return `${label} ${formatPercent(metric.comparison.ratio - 1)} (${formatInterval(metric.comparison)})`.trim();
}

function pixelCell(pixels: ImageComparison | null): string {
  if (!pixels) return "n/a";
  if (pixels.differingPixels === 0) return "identical";
  const share = (100 * pixels.differingPixels) / (pixels.width * pixels.height);
  return `${share.toFixed(2)}% differ, SSIM ${pixels.ssim.toFixed(4)}`;
}

const VERDICT_HEADLINE: Readonly<Record<RunVerdict, string>> = {
  "no-regression": "no regression: every gated timing is within the threshold, and no ceiling is newly breached",
  regression: "REGRESSION",
  inconclusive: "inconclusive: run more rounds before trusting a pass",
  failed: "FAILED: the comparison could not be completed",
};

/**
 * Rounds that would clear every inconclusive gated timing if nothing changed,
 * to the next ten; null when none needs more than the run had, which leaves
 * an estimate near its threshold rather than an interval too wide.
 */
function roundsToClearRun(report: PerfAbReport): number | null {
  const needed = report.shots.flatMap((shot) => shot.metrics
    .filter((metric) => metric.gated && !metric.guard && metric.verdict === "inconclusive")
    .map((metric) => roundsToClear(metric.comparison, report.settings.thresholds[metric.metric]) ?? 0))
    .filter((rounds) => rounds > report.settings.rounds);
  return needed.length > 0 ? Math.ceil(Math.max(...needed) / 10) * 10 : null;
}

/** Guards whose verdict did not resolve, as `shot: metric (interval)`. */
function unresolvedGuards(report: PerfAbReport): string[] {
  return report.shots.flatMap((shot) => shot.metrics
    .filter((metric) => metric.guard && metric.verdict === "inconclusive")
    .map((metric) => `${shot.name}: ${metricName(metric.metric)} (${formatInterval(metric.comparison)})`));
}

/** The human summary. Every number in it is also in report.json. */
export function renderMarkdown(report: PerfAbReport): string {
  const lines: string[] = [];
  const short = (sha: string) => sha.slice(0, 10);
  const unresolved = unresolvedGuards(report);
  lines.push(
    `## Cloud perf A/B: ${report.summary.verdict === "no-regression" && unresolved.length > 0
      ? "no regression found: nothing gated is slower and no ceiling is newly breached, but a guard did not resolve"
      : VERDICT_HEADLINE[report.summary.verdict]}`,
  );
  lines.push("");
  const head = `${report.head.ref} \`${short(report.head.sha)}\`${report.head.dirty ? " + uncommitted changes" : ""}`;
  lines.push(
    report.mode === "aa"
      ? `A/A run (both arms are ${head}): this measures the host's noise floor, not a change.`
      : `Base ${report.base.ref} \`${short(report.base.sha)}\` against head ${head}.`,
  );
  for (const [arm, identity] of [["base", report.base], ["head", report.head]] as const) {
    if (identity.profileOverride) {
      lines.push(`The ${arm} arm ran with a profile override (a positive control): \`${JSON.stringify(identity.profileOverride)}\`.`);
    }
  }
  lines.push(
    `${report.host.backend} on ${report.host.cpus} CPUs (${report.host.cpuModel}); `
    + (report.settings.rounds === 0
      ? "no timing (`--rounds 0`): work counts, draw calls, ceilings and pixels only."
      : `${report.settings.rounds} rounds of ABBA-interleaved frames per shot; a change is called at `
        + report.settings.gatedMetrics
          .map((metric) => `${Number((report.settings.thresholds[metric] * 100).toFixed(1))}% in ${metricName(metric)}`)
          .join(" and ")
        + `, with Holm-adjusted alpha ${report.settings.alpha}`
        + (report.settings.part
          ? `: this is part ${report.settings.part.index} of ${report.settings.part.count} of the run, `
            + `whose alpha of ${report.settings.part.runAlpha} is split between its parts.`
          : ".")
        + report.settings.guardMetrics
          .map((metric) => ` ${metricName(metric)} is a guard: a slowdown it resolves fails the run, but an `
            + "interval too wide to clear a change does not hold the run inconclusive.")
          .join("")),
  );
  if (report.settings.offCanonical.length > 0) {
    lines.push(
      `Run with ${report.settings.offCanonical.map((option) => `\`${option}\``).join(", ")}, off the capture's own settings `
      + "(the trainer, medium quality, balanced mode, each shot's render scale) for which every ceiling and "
      + "baseline is pinned: the ceilings are shown but not gated, and no shot is compared with its baseline.",
    );
  }
  if (report.summary.reasons.length > 0) {
    lines.push("");
    for (const reason of report.summary.reasons) lines.push(`- ${markdownText(reason)}`);
    const toClear = report.summary.verdict === "inconclusive" ? roundsToClearRun(report) : null;
    if (toClear !== null) {
      lines.push("");
      lines.push(
        `If nothing changed, about ${toClear} rounds would clear these (\`--rounds ${toClear}\`): `
        + "an interval narrows with the square root of the rounds.",
      );
    }
  }
  if (report.summary.verdict !== "failed" && unresolved.length > 0) {
    lines.push("");
    lines.push("Not cleared (a guard found no slowdown, but its interval does not rule one out):");
    for (const guard of unresolved) lines.push(`- ${guard}`);
  }
  lines.push("");
  // A column per timed metric, gated ones first; the frame's wall time only
  // when it is gated (where no pass can be timed), as it is otherwise the sum
  // of the others plus the fence.
  const columns = [
    ...report.settings.gatedMetrics,
    ...report.settings.timedMetrics.filter((metric) => metric !== "wall" && !report.settings.gatedMetrics.includes(metric)),
  ];
  const header = columns.map((metric) => `${metricName(metric)}${
    !report.settings.gatedMetrics.includes(metric) ? " (not gated)" : report.settings.guardMetrics.includes(metric) ? " (guard)" : ""
  }`);
  lines.push(`| Shot | ${[...header, "Draw calls", "GPU work", "Pixels"].join(" | ")} |`);
  lines.push(`| ${new Array(columns.length + 4).fill("---").join(" | ")} |`);
  for (const shot of report.shots) {
    if (shot.status !== "measured") {
      lines.push(`| ${shot.name} | ${shot.status}: ${markdownText(shot.failure ?? "")} |${" |".repeat(columns.length + 2)}`);
      continue;
    }
    const cells = columns.map((name) => metricCell(shot.metrics.find((metric) => metric.metric === name)));
    const draws = shot.ceilings
      ? `${drawCallRange(shot.ceilings.baseDrawCallsMin, shot.ceilings.baseDrawCalls)} → `
        + `${drawCallRange(shot.ceilings.headDrawCallsMin, shot.ceilings.headDrawCalls)}`
      : "n/a";
    const workChanges = shot.work ? shot.work.changes.length : 0;
    lines.push(
      `| ${shot.name} | ${cells.join(" | ")} | ${draws} | `
      + `${workChanges === 0 ? "identical" : `${workChanges} counts differ`} | ${pixelCell(shot.pixels)} |`,
    );
  }
  lines.push("");
  const timed = report.settings.timedMetrics;
  lines.push(
    (timed.includes("gpu")
      ? "GPU time is the sum of every render and compute pass's timestamps. "
      : "This adapter cannot time passes, so the frame is timed from `render()` to GPU idle. ")
    + (report.host.backend.startsWith("SwiftShader")
      ? "SwiftShader is a CPU executing the GPU's work: it ranks shader, fill and dispatch cost the way a "
        + "GPU does but over-weights some (MSAA, texture filtering, transcendentals) and cannot see "
        + "bandwidth or tile memory. "
      : "")
    + "CPU time is `renderer.render()` on the main thread. Ratios are head / base; the interval is the "
    + "distribution-free 95% interval of the Hodges–Lehmann estimate over rounds.",
  );
  for (const shot of report.shots) {
    if (shot.status !== "measured") continue;
    lines.push("");
    lines.push(`### ${shot.name}`);
    lines.push("");
    if (shot.streaming) {
      lines.push(
        `Streamed ${shot.streaming.base.frames} base / ${shot.streaming.head.frames} head frames `
        + `(${shot.streaming.base.seconds.toFixed(0)} s / ${shot.streaming.head.seconds.toFixed(0)} s) at `
        + `${shot.raster?.width}x${shot.raster?.height} (scale ${shot.renderScale}); the shot took `
        + `${shot.elapsedSeconds.toFixed(0)} s.`,
      );
    }
    const perFrame = (found: MetricResult, arm: "baseMedian" | "headMedian") => {
      const value = found.comparison[arm] / report.settings.framesPerArmPerRound;
      return value.toFixed(value < 100 ? 1 : 0);
    };
    if (shot.metrics.length > 0) {
      lines.push(
        `Median per frame, base → head: ${shot.metrics
          .map((found) => `${metricName(found.metric)} ${perFrame(found, "baseMedian")} → ${perFrame(found, "headMedian")} ms`)
          .join(", ")}.`,
      );
    }
    const movers = [...shot.passes]
      .sort((a, b) => Math.abs(b.headMs - b.baseMs) - Math.abs(a.headMs - a.baseMs))
      .slice(0, 8);
    if (movers.length > 0) {
      lines.push("");
      lines.push("Largest per-pass GPU time changes (ms per frame, base → head):");
      for (const pass of movers) {
        const interval = pass.ratioLow !== null && pass.ratioHigh !== null
          ? `, ${formatPercent(pass.ratioLow - 1)} to ${formatPercent(pass.ratioHigh - 1)}`
          : "";
        // A cadenced pass is compared over fewer rounds, sometimes too few to
        // bound; say how many, so a lone ratio is not read as a change.
        const cadence = pass.cadenced
          ? `, over the ${pass.rounds} rounds both arms ran it${interval === "" ? ", too few for an interval" : ""}`
          : "";
        lines.push(
          `- \`${pass.key}\`: ${pass.baseMs.toFixed(1)} → ${pass.headMs.toFixed(1)} `
          + `(${pass.cadenced ? "on a cadence; per run " : ""}${formatPercent(pass.ratio - 1)}${interval}${cadence})`,
        );
      }
    }
    if (shot.work && shot.work.changes.length > 0) {
      lines.push("");
      lines.push("GPU work per frame that differs (exact counts, base → head):");
      for (const change of shot.work.changes) {
        lines.push(`- ${change.key}: ${formatCount(change.base)} → ${formatCount(change.head)}`);
      }
      for (const change of shot.work.passChanges.slice(0, 20)) {
        lines.push(`  - \`${change.key}\`: ${formatCount(change.base)} → ${formatCount(change.head)}`);
      }
      if (shot.work.passChanges.length > 20) lines.push(`  - …and ${shot.work.passChanges.length - 20} more in report.json`);
    }
    if (shot.diagnostics && shot.diagnostics.changes.length > 0) {
      const { base, head } = shot.diagnostics;
      // The same pages wanted: the extra resident ones are each arm's history.
      const wanted = base.wantedTerrainPages >= 0 && base.wantedTerrainPages === head.wantedTerrainPages
        ? base.wantedTerrainPages
        : null;
      lines.push("");
      lines.push("Renderer diagnostics that differ:");
      for (const change of shot.diagnostics.changes) {
        const note = change.key === "residentTerrainPages" && wanted !== null
          ? ` (both arms want ${formatCount(wanted)}: the rest were wanted earlier in each arm's stream, `
            + "and stay until their slots are needed)"
          : "";
        lines.push(`- ${change.key}: ${formatCount(change.base)} → ${formatCount(change.head)}${note}`);
      }
    }
    if (shot.ceilings) {
      const ceiling = shot.ceilings.drawCallCeiling;
      lines.push("");
      lines.push(
        `Ceilings${report.settings.offCanonical.length > 0 ? " (not gated off the capture's settings)" : ""}: `
        + `draw calls ${drawCallRange(shot.ceilings.headDrawCallsMin, shot.ceilings.headDrawCalls)}`
        + `${ceiling !== null ? ` / ${ceiling}` : " (no ceiling)"}, `
        + `inventoried GPU memory ${shot.ceilings.headMemoryMiB.toFixed(1)} / ${shot.ceilings.memoryCeilingMiB} MiB.`
        + (shot.ceilings.newBreaches.length > 0 ? ` NEW BREACH: ${shot.ceilings.newBreaches.join("; ")}.` : ""),
      );
    }
    if (shot.pixels) {
      lines.push("");
      lines.push(
        shot.pixels.differingPixels === 0
          ? "Pixels: the arms rendered identical frames."
          : `Pixels: ${pixelCell(shot.pixels)}, max channel delta ${shot.pixels.maxChannelDelta}, worst 64 px tile RGB SSIM ${shot.pixels.worstTileRgbSsim.toFixed(4)} (base.png / head.png in the artifact).`,
      );
    }
    if (shot.baseline && (shot.baseline.head || shot.baseline.base)) {
      const describe = (comparison: ImageComparison | null) =>
        comparison ? `SSIM ${comparison.ssim.toFixed(4)}, RGB ${comparison.rgbSsim.toFixed(4)}, worst tile ${comparison.worstTileRgbSsim.toFixed(4)}` : "n/a";
      // The instant first: on the macOS runner's GPU these frames score about
      // as they do on SwiftShader (water-25ft 0.706 on both), so the instant
      // is most of what separates them from the baseline.
      const unlike = report.host.backend.startsWith("SwiftShader")
        ? "another instant than the capture's, on another rasteriser"
        : "another instant than the capture's";
      lines.push(
        `Against the committed Mac baseline (${unlike}, so not a gate): base ${describe(shot.baseline.base)}; head ${describe(shot.baseline.head)}.`,
      );
    }
    const created = shot.measuredFrameCreations;
    if (created && (created.head.pipelines > 0 || created.head.shaderModules > 0)) {
      lines.push(
        `Head created ${created.head.pipelines} pipeline(s) and ${created.head.shaderModules} shader module(s) during measured frames (base: ${created.base.pipelines} / ${created.base.shaderModules}) — a steady frame should create none.`,
      );
    }
  }
  const errorLines = (["base", "head"] as const).flatMap((arm) =>
    (["console", "logger", "gpu", "page"] as const).flatMap((channel) =>
      report.errors[arm][channel].slice(0, 5).map((message) => `- ${arm} ${channel}: ${markdownText(message).slice(0, 300)}`)));
  if (errorLines.length > 0) {
    lines.push("");
    lines.push("### Renderer errors");
    lines.push("");
    lines.push(...errorLines);
  }
  lines.push("");
  return lines.join("\n");
}
