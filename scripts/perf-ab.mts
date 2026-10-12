/**
 * `npm run perf:ab` — is the head slower than the base?
 *
 * Answered on any machine that runs Chromium. On Linux, including every hosted
 * runner and every cloud session, WebGPU runs on SwiftShader (a CPU
 * implementation of Vulkan), so no GPU and no Mac are needed. The method and
 * its limits are in docs/PERFORMANCE.md, "Cloud A/B".
 *
 *   npm run perf:ab                                    # working tree vs its merge-base with origin/main
 *   npm run perf:ab -- --base main --shots cruise-horizon,approach-500ft
 *   npm run perf:ab -- --aa                            # A/A: this host's noise floor
 *   npm run perf:ab -- --aa --head-profile-override '{"msaaSamples":4}'   # a known cost: the positive control
 *
 * Per shot, both arms (base and head, each a production build of
 * `tests/perf/ab/agent.html` in a browser of its own):
 *  1. stream the shot to rest with the frame's own draws gated off, then
 *     align their frame indices so every cadence-driven pass runs in step;
 *  2. settle, counting the GPU work of the last frames EXACTLY;
 *  3. take turns rendering frames (ABBA, BAAB, ...), each fenced to GPU idle,
 *     timing every GPU pass and the frame's JavaScript;
 *  4. photograph the same final frame.
 * Then: a paired, distribution-free comparison of the timings per shot, an
 * exact diff of the work counts and renderer diagnostics, the draw-call and
 * memory ceilings, and a pixel diff of the two photographs.
 *
 * Exit status: 0 no regression (an inconclusive result warns), 1 regression
 * or failure (`--no-fail` reports instead), 2 usage.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  AgentArm,
  buildAgent,
  ensureDirectory,
  git,
  installBaseDependencies,
  lockfilesDiffer,
  prepareArmCheckout,
  removeArmCheckout,
  serveDirectory,
  type GpuBackend,
  type StaticServer,
} from "./perfAbHarness.mts";
import {
  chooseMetrics,
  oneLine,
  passTimingChanges,
  renderMarkdown,
  roundTotals,
  summarize,
  type ArmIdentity,
  type ArmName,
  type CountChange,
  type MeasuredSample,
  type MetricResult,
  type PerfAbReport,
  type ShotResult,
  type TimingMetric,
} from "./perfAbReport.mts";
import {
  comparePaired,
  geometricMean,
  holmAdjust,
  roundOrder,
  verdict,
  type PairedComparison,
} from "./perfAbStats.mts";
import type {
  AgentCatalog,
  AgentConfig,
  AgentErrors,
  ImageComparison,
  SettleReport,
  ShotDiagnostics,
} from "../tests/perf/ab/protocol.ts";
import type { GpuWorkCounters } from "../tests/perf/gpuWorkCounters.ts";
import type { PerfCaptureShotDefinition } from "./perf-capture.mts";

/**
 * The default set: one shot per major system, each from the canonical list.
 * Terrain, sky and clouds to the horizon; the forest canopy and its
 * impostors; standing in the ground cover; the aircraft and airport on
 * approach; the ocean up close.
 */
export const DEFAULT_SHOTS: readonly string[] = [
  "cruise-horizon",
  "forest-500ft-sunbehind",
  "ground-2m-lowsun",
  "approach-500ft",
  "water-25ft",
];

const ARMS: readonly ArmName[] = ["base", "head"];

/**
 * Per backend, because a frame costs seconds on SwiftShader and milliseconds on
 * a GPU, and the two are not equally noisy. Three A/A runs on SwiftShader (4
 * CPUs, 2026-10-12, 32 rounds): one round's head/base log ratio scattered by
 * 3.7-4.1% in GPU time and by 11-26% in CPU time, from frame-to-frame
 * variation that neither a thread CPU clock, an idle GPU nor a forced GC
 * removed. Sixteen rounds hold a no-change run's GPU interval to about ±2%, so
 * 5% reads SAME: in 99.7% of 2,000 sixteen-round A/A runs resampled from those
 * rounds. CPU time at 15% read SAME in only 57% of them, so on SwiftShader it
 * is a guard (`MetricResult.guard`): a slowdown it resolves fails the run, an
 * interval too wide to clear one does not hold the run inconclusive.
 *
 * The macOS runner (a virtual M1 with 3 CPUs, 2026-10-12) offers no timestamp
 * queries, so the whole frame's wall time is gated there, and it scatters far
 * more: one round's ratio by 13-23% at four frames a turn, and by 16-26% at
 * one frame a turn in a sixth of the time. Neighbouring frames move together,
 * so short turns buy about three times the precision per second of runner
 * time; 320 of them read SAME at 5% on nine of ten A/A shots over two runs,
 * with intervals of ±1.4-3.0%, in about 13 minutes a run. CPU time is a guard
 * at 15% there too, for another reason: in one of those runs a shot's CPU
 * time read the head 8.7% faster (-12.5% to -4.7%), in the other +1.2%, with
 * both arms the same renderer, an offset between the two browsers that no
 * number of rounds averages away. The runs are in docs/PERFORMANCE.md,
 * "Cloud A/B".
 */
const BACKEND_DEFAULTS: Readonly<Record<GpuBackend, {
  readonly rounds: number;
  readonly framesPerTurn: number;
  readonly cpuThreshold: number;
  readonly cpuGate: CpuGate;
}>> = {
  swiftshader: { rounds: 16, framesPerTurn: 1, cpuThreshold: 0.15, cpuGate: "guard" },
  hardware: { rounds: 320, framesPerTurn: 1, cpuThreshold: 0.15, cpuGate: "guard" },
};

/** `full`: CPU time can fail the run or hold it inconclusive. `guard`: only fail it. */
type CpuGate = "full" | "guard";

const USAGE = `usage: npm run perf:ab -- [options]

  --base <ref>              base commit (default: merge-base of HEAD and origin/main)
  --head <ref>              head commit (default: the working tree, uncommitted changes included)
  --aa                      A/A: both arms are the head; measures this host's noise floor
  --shots <a,b,...>|all     canonical shot names (default: ${DEFAULT_SHOTS.join(",")})
  --rounds <n>              ABBA rounds per shot (default 16 on SwiftShader, 320 on a GPU; 0 = no
                            timing: work counts, draw calls, ceilings and pixels only). Fewer than
                            log2(gated comparisons / alpha) + 1 is refused: no slowdown could be
                            called (8 for the default five shots)
  --frames-per-turn <n>     consecutive frames per arm per turn (default 1)
  --threshold <fraction>    smallest change worth calling in GPU time, or in the frame's wall time
                            where passes cannot be timed (default 0.05 = 5%)
  --cpu-threshold <fraction>  smallest CPU-time change worth calling (default 0.15: a frame's
                            JavaScript time is the noisier measurement)
  --cpu-gate full|guard     full: CPU time can fail the run or leave it inconclusive; guard: it can
                            only fail it (default guard: too noisy on SwiftShader to clear a change,
                            and on a GPU the two browsers' CPU times can sit apart)
  --alpha <p>               family-wise significance (default 0.05)
  --render-scale <x>        override every shot's render scale (a quicker, smaller run)
  --gpu swiftshader|hardware  (default: hardware on macOS, swiftshader elsewhere)
  --chromium <path>         Chromium executable (default: Playwright's, else the container's)
  --out <dir>               output directory (default tests/perf/artifacts/ab/<timestamp>)
  --head-profile-override <json>, --base-profile-override <json>
                            force quality-profile fields in one arm (positive controls)
  --quality, --mode, --aircraft   renderer settings (default medium, balanced, trainer). These and
                            --render-scale are the capture's own settings by default; off them,
                            ceilings are shown but not gated, and no baseline is compared
  --open-frames, --settle-frames, --count-frames, --min-stream-frames, --max-stream-frames
  --base-install auto|link|ci   base dependencies (default auto: npm ci only if the lockfile differs)
  --no-fail                 always exit 0 after a completed run
  --fail-on-inconclusive    exit 1 when the result is inconclusive
  --keep-worktrees          leave the arms' git worktrees for inspection
  --verbose                 forward the pages' console
`;

function parseNumber(name: string, raw: string | undefined, fallback: number, check: (value: number) => boolean): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) throw new UsageError(`--${name} ${raw} is not valid`);
  return value;
}

function parseOverride(name: string, raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`--${name} is not JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new UsageError(`--${name} must be a non-empty JSON object of profile fields`);
  }
  return parsed as Record<string, unknown>;
}

class UsageError extends Error {}

/** `parseArgs`, whose own errors (an unknown option, a missing value, a stray argument) are usage errors. */
function parseCommandLine<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The renderer's settings, as `src/game/types.ts` types them. */
const QUALITY_LEVELS: readonly string[] = ["low", "medium", "high"];
const RENDERING_MODES: readonly string[] = ["performance", "balanced", "ultra"];

const started = performance.now();
function log(line: string): void {
  console.log(`[perf-ab ${((performance.now() - started) / 1000).toFixed(0).padStart(5)} s] ${line}`);
}

function resolveCommit(root: string, ref: string): string {
  try {
    return git(root, "rev-parse", "--verify", `${ref}^{commit}`);
  } catch {
    throw new UsageError(`cannot resolve ${ref}; fetch it first (git fetch origin) or pass another --base/--head`);
  }
}

function defaultBase(root: string): string {
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git(root, "merge-base", "HEAD", candidate);
    } catch {
      // try the next
    }
  }
  throw new UsageError("no origin/main or main to take a merge-base with; pass --base");
}

function perFrameCounts(counters: GpuWorkCounters): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    if (key === "frames" || key === "passes" || typeof value !== "number") continue;
    result[key] = value / counters.frames;
  }
  return result;
}

function countChanges(base: Readonly<Record<string, number>>, head: Readonly<Record<string, number>>, tolerance = 0): CountChange[] {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  return keys
    .map((key) => ({ key, base: base[key] ?? 0, head: head[key] ?? 0 }))
    .filter((change) => Math.abs(change.head - change.base) > tolerance);
}

const PASS_FIELDS = [
  "passes", "draws", "indirectDraws", "vertices", "instances", "dispatches",
  "indirectDispatches", "workgroups", "attachmentPixels", "pipelineSwitches", "bindGroupSets",
] as const;

function passChanges(base: GpuWorkCounters, head: GpuWorkCounters): CountChange[] {
  const changes: CountChange[] = [];
  const keys = [...new Set([...Object.keys(base.passes), ...Object.keys(head.passes)])].sort();
  for (const key of keys) {
    const a = base.passes[key];
    const b = head.passes[key];
    for (const field of PASS_FIELDS) {
      const before = (a?.[field] ?? 0) / base.frames;
      const after = (b?.[field] ?? 0) / head.frames;
      if (before !== after) changes.push({ key: `${key} › ${field}`, base: before, head: after });
    }
  }
  return changes;
}

function diagnosticsChanges(base: ShotDiagnostics, head: ShotDiagnostics): CountChange[] {
  // -1 is a build that does not report its wanted pages, not a count.
  const wanted = base.wantedTerrainPages >= 0 && head.wantedTerrainPages >= 0;
  const exact = countChanges(
    { ...base, inventoriedGpuMemoryMiB: 0, estimatedGpuMemoryMiB: 0, wantedTerrainPages: wanted ? base.wantedTerrainPages : 0 },
    { ...head, inventoriedGpuMemoryMiB: 0, estimatedGpuMemoryMiB: 0, wantedTerrainPages: wanted ? head.wantedTerrainPages : 0 },
  );
  const memory = countChanges(
    { inventoriedGpuMemoryMiB: base.inventoriedGpuMemoryMiB, estimatedGpuMemoryMiB: base.estimatedGpuMemoryMiB },
    { inventoriedGpuMemoryMiB: head.inventoriedGpuMemoryMiB, estimatedGpuMemoryMiB: head.estimatedGpuMemoryMiB },
    0.05,
  );
  return [...exact, ...memory];
}

function read(sample: MeasuredSample, metric: TimingMetric): number {
  switch (metric) {
    case "gpu":
      return sample.gpuMs;
    case "cpu":
      return sample.renderMs;
    case "wall":
      return sample.wallMs;
  }
}

interface PendingMetric {
  readonly shot: number;
  readonly metric: TimingMetric;
  readonly comparison: PairedComparison;
}

async function main(): Promise<number> {
  const { values } = parseCommandLine({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      aa: { type: "boolean", default: false },
      shots: { type: "string" },
      rounds: { type: "string" },
      "frames-per-turn": { type: "string" },
      threshold: { type: "string" },
      "cpu-threshold": { type: "string" },
      "cpu-gate": { type: "string" },
      alpha: { type: "string" },
      "render-scale": { type: "string" },
      gpu: { type: "string" },
      chromium: { type: "string" },
      out: { type: "string" },
      "head-profile-override": { type: "string" },
      "base-profile-override": { type: "string" },
      quality: { type: "string", default: "medium" },
      mode: { type: "string", default: "balanced" },
      aircraft: { type: "string", default: "trainer" },
      "open-frames": { type: "string" },
      "settle-frames": { type: "string" },
      "count-frames": { type: "string" },
      "min-stream-frames": { type: "string" },
      "max-stream-frames": { type: "string" },
      "base-install": { type: "string", default: "auto" },
      "no-fail": { type: "boolean", default: false },
      "fail-on-inconclusive": { type: "boolean", default: false },
      "keep-worktrees": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const backend = (values.gpu ?? (process.platform === "darwin" ? "hardware" : "swiftshader")) as GpuBackend;
  if (backend !== "swiftshader" && backend !== "hardware") throw new UsageError(`--gpu ${values.gpu} is not swiftshader or hardware`);
  const defaults = BACKEND_DEFAULTS[backend];
  const rounds = parseNumber(
    "rounds", values.rounds, defaults.rounds, (value) => Number.isInteger(value) && (value === 0 || value >= 2),
  );
  const framesPerTurn = parseNumber(
    "frames-per-turn", values["frames-per-turn"], defaults.framesPerTurn, (value) => Number.isInteger(value) && value >= 1,
  );
  const threshold = parseNumber("threshold", values.threshold, 0.05, (value) => value > 0 && value < 1);
  const cpuThreshold = parseNumber("cpu-threshold", values["cpu-threshold"], defaults.cpuThreshold, (value) => value > 0 && value < 1);
  const cpuGate = (values["cpu-gate"] ?? defaults.cpuGate) as CpuGate;
  if (cpuGate !== "full" && cpuGate !== "guard") throw new UsageError(`--cpu-gate ${values["cpu-gate"]} is not full or guard`);
  // The frame's wall time stands in for GPU time where passes cannot be timed.
  const thresholds: Record<TimingMetric, number> = { gpu: threshold, wall: threshold, cpu: cpuThreshold };
  const alpha = parseNumber("alpha", values.alpha, 0.05, (value) => value > 0 && value < 0.5);
  // The renderer's own bounds on a pinned capture scale.
  const renderScale = values["render-scale"] === undefined
    ? null
    : parseNumber("render-scale", values["render-scale"], 1, (value) => value >= 0.1 && value <= 2);
  if (!QUALITY_LEVELS.includes(values.quality)) throw new UsageError(`--quality ${values.quality} is not ${QUALITY_LEVELS.join(", ")}`);
  if (!RENDERING_MODES.includes(values.mode)) throw new UsageError(`--mode ${values.mode} is not ${RENDERING_MODES.join(", ")}`);
  // Every ceiling and baseline image is pinned for the capture's own settings:
  // the trainer, medium quality, balanced mode and each shot's own render
  // scale. Any other setting draws a different world (the capture's sweeps do
  // not gate the ceilings either), so off them the A/B shows the ceilings
  // without gating on them and does not compare with the baselines.
  const offCanonical = [
    values.aircraft === "trainer" ? null : `--aircraft ${values.aircraft}`,
    values.quality === "medium" ? null : `--quality ${values.quality}`,
    values.mode === "balanced" ? null : `--mode ${values.mode}`,
    renderScale === null ? null : `--render-scale ${renderScale}`,
  ].filter((option): option is string => option !== null);
  const requestedShots = values.shots === undefined || values.shots === "all"
    ? null
    : values.shots.split(",").map((name) => name.trim()).filter(Boolean);
  if (requestedShots !== null && requestedShots.length === 0) throw new UsageError(`--shots "${values.shots}" names no shot`);
  const openFrames = parseNumber("open-frames", values["open-frames"], 2, (value) => Number.isInteger(value) && value >= 2);
  const settleFrames = parseNumber("settle-frames", values["settle-frames"], 12, (value) => Number.isInteger(value) && value >= 2);
  const countFrames = parseNumber("count-frames", values["count-frames"], 8, (value) => Number.isInteger(value) && value >= 1 && value <= settleFrames);
  const minStreamFrames = parseNumber("min-stream-frames", values["min-stream-frames"], 240, (value) => Number.isInteger(value) && value >= 0);
  const maxStreamFrames = parseNumber("max-stream-frames", values["max-stream-frames"], 6_000, (value) => Number.isInteger(value) && value > minStreamFrames);
  const baseInstall = values["base-install"];
  if (baseInstall !== "auto" && baseInstall !== "link" && baseInstall !== "ci") {
    throw new UsageError(`--base-install ${baseInstall} is not auto, link or ci`);
  }
  const overrides: Record<ArmName, Record<string, unknown> | null> = {
    base: parseOverride("base-profile-override", values["base-profile-override"]),
    head: parseOverride("head-profile-override", values["head-profile-override"]),
  };
  const aa = values.aa;

  const headSha = values.head ? resolveCommit(root, values.head) : git(root, "rev-parse", "HEAD");
  const dirty = !values.head && git(root, "status", "--porcelain", "--untracked-files=no").length > 0;
  const head: ArmIdentity = { ref: values.head ?? "working tree", sha: headSha, dirty, profileOverride: overrides.head };
  const baseSha = aa ? headSha : resolveCommit(root, values.base ?? defaultBase(root));
  const base: ArmIdentity = aa
    ? { ...head, profileOverride: overrides.base }
    : { ref: values.base ?? "merge-base with origin/main", sha: baseSha, dirty: false, profileOverride: overrides.base };
  if (!aa && baseSha === headSha && !dirty) {
    log("base and head are the same commit with no uncommitted changes: this run is an A/A in effect");
  }

  const startedAt = new Date();
  const outDir = resolve(values.out ?? join(root, "tests/perf/artifacts/ab", startedAt.toISOString().replace(/[:.]/gu, "-")));
  ensureDirectory(outDir);
  log(`${aa ? "A/A on" : `base ${base.sha.slice(0, 10)} vs`} head ${head.sha.slice(0, 10)}${dirty ? " + uncommitted" : ""}; ${backend}; output ${outDir}`);

  // Build. The instrument (HARNESS_PATHS) always comes from THIS checkout.
  const worktrees: string[] = [];
  const builds: Record<ArmName, string> = { base: join(outDir, "build", "base"), head: join(outDir, "build", "head") };
  let building: ArmName = "head";
  try {
    // Each arm's own dependencies when its lockfile is not this checkout's.
    const install = (arm: ArmName, checkout: string) => {
      if (lockfilesDiffer(root, checkout)) {
        if (baseInstall === "link") {
          log(`WARNING: package-lock.json differs between this checkout and the ${arm}; the ${arm} is built with this checkout's dependencies (--base-install link)`);
        } else {
          log(`package-lock.json differs between this checkout and the ${arm}: installing the ${arm}'s own dependencies`);
          installBaseDependencies(checkout);
        }
      } else if (baseInstall === "ci") {
        installBaseDependencies(checkout);
      }
    };
    if (values.head) {
      const directory = join(tmpdir(), `fly-high-perf-ab-head-${headSha.slice(0, 12)}-${process.pid}`);
      worktrees.push(directory);
      const checkout = prepareArmCheckout(root, headSha, directory);
      install("head", checkout);
      await buildAgent(checkout, builds.head, join(outDir, "build", "vite-cache-head"));
    } else {
      await buildAgent(root, builds.head, join(outDir, "build", "vite-cache-head"));
    }
    log("built the head arm");
    building = "base";
    if (aa) {
      builds.base = builds.head;
    } else {
      const directory = join(tmpdir(), `fly-high-perf-ab-base-${baseSha.slice(0, 12)}-${process.pid}`);
      worktrees.push(directory);
      const checkout = prepareArmCheckout(root, baseSha, directory);
      install("base", checkout);
      await buildAgent(checkout, builds.base, join(outDir, "build", "vite-cache-base"));
      log("built the base arm");
    }
  } catch (error) {
    throw new Error(
      `perf-ab: building the ${building} arm failed: ${error instanceof Error ? error.message : String(error)}`
      + (building === "base" ? "\nA base older than the A/B tooling may not build with it; if so, choose a newer --base." : ""),
    );
  } finally {
    if (!values["keep-worktrees"]) for (const checkout of worktrees) removeArmCheckout(root, checkout);
  }

  const servers: Partial<Record<ArmName, StaticServer>> = {};
  const opened: AgentArm[] = [];
  try {
    servers.base = await serveDirectory(builds.base);
    servers.head = await serveDirectory(builds.head);
    // A browser per arm, so a GPU process per arm (see `AgentArm`).
    const open = async (arm: ArmName): Promise<AgentArm> => {
      const agent = await AgentArm.open(arm, servers[arm]!.origin, backend, values.chromium, log, values.verbose);
      opened.push(agent);
      return agent;
    };
    const arms: Record<ArmName, AgentArm> = { base: await open("base"), head: await open("head") };
    const info = await arms.head.call("info");
    log(`adapter ${info.adapter.vendor}/${info.adapter.architecture} ${info.adapter.description}; timestamp-query ${info.timestampQuery}`);
    const { timed, gated: gatedMetrics } = chooseMetrics(info.timestampQuery);
    const guardMetrics: TimingMetric[] = cpuGate === "guard" && gatedMetrics.includes("cpu") ? ["cpu"] : [];
    log(`timing ${timed.join(", ")}; gating ${gatedMetrics
      .map((metric) => (guardMetrics.includes(metric) ? `${metric} (as a guard)` : metric))
      .join(", ")}`);
    if (offCanonical.length > 0) {
      log(`${offCanonical.join(" ")} is off the capture's settings: ceilings are shown but not gated, and no baseline is compared`);
    }
    for (const arm of ARMS) {
      const config: AgentConfig = {
        quality: values.quality,
        renderingMode: values.mode,
        aircraft: values.aircraft,
        profileOverride: overrides[arm],
      };
      try {
        await arms[arm].call("configure", config);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message.split("\n", 1)[0]! : String(error));
      }
    }
    const catalog: AgentCatalog = await arms.head.call("catalog");
    const wanted = values.shots === "all" ? catalog.shots.map((shot) => shot.name) : requestedShots ?? [...DEFAULT_SHOTS];
    const unknown = wanted.filter((name) => !catalog.shots.some((shot) => shot.name === name));
    if (unknown.length > 0) {
      throw new UsageError(`not in PERF_CAPTURE_SHOTS: ${unknown.join(", ")}`);
    }
    // The smallest one-sided p of n rounds is 2^-n, and Holm multiplies the
    // smallest of m by m: below this many rounds no change can be called
    // SLOWER, so even a large regression would read INCONCLUSIVE.
    const family = wanted.length * gatedMetrics.length;
    const fewestRounds = Math.floor(Math.log2(family / alpha)) + 1;
    if (rounds > 0 && rounds < fewestRounds) {
      throw new UsageError(
        `--rounds ${rounds} cannot call a slowdown across ${family} gated comparisons at alpha ${alpha}; `
        + `use at least ${fewestRounds}, or --rounds 0 for no timing`,
      );
    }
    // Canonical order, as the capture runs them: a shot's streaming history
    // includes every earlier shot's, and both arms must share it.
    const selected = catalog.shots
      .map((shot, index) => ({ shot, index }))
      .filter(({ shot }) => wanted.includes(shot.name));

    const shots: ShotResult[] = [];
    const pending: PendingMetric[] = [];
    for (const { shot, index } of selected) {
      const result = await runShot(arms, shot, index, catalog, {
        rounds, framesPerTurn, timed, gated: gatedMetrics, renderScale, openFrames, settleFrames,
        countFrames, minStreamFrames, maxStreamFrames, pinned: offCanonical.length === 0, outDir, root,
      });
      shots.push(result.shot);
      for (const metric of result.metrics) pending.push({ ...metric, shot: shots.length - 1 });
      writeFileSync(join(outDir, "progress.json"), JSON.stringify(shots, null, 1));
    }

    // One Holm family over every gated (shot, metric) of the run.
    const gated = pending.filter((metric) => gatedMetrics.includes(metric.metric));
    const slowerAdjusted = holmAdjust(gated.map((metric) => metric.comparison.pSlower));
    const fasterAdjusted = holmAdjust(gated.map((metric) => metric.comparison.pFaster));
    const finalShots = shots.map((shot, shotIndex) => {
      const metrics: MetricResult[] = pending
        .filter((metric) => metric.shot === shotIndex)
        .map((metric) => {
          const family = gated.indexOf(metric);
          if (family < 0) {
            return {
              metric: metric.metric,
              gated: false,
              guard: false,
              comparison: metric.comparison,
              pSlowerAdjusted: null,
              pFasterAdjusted: null,
              verdict: null,
            };
          }
          const pSlowerAdjusted = slowerAdjusted[family]!;
          const pFasterAdjusted = fasterAdjusted[family]!;
          return {
            metric: metric.metric,
            gated: true,
            guard: guardMetrics.includes(metric.metric),
            comparison: metric.comparison,
            pSlowerAdjusted,
            pFasterAdjusted,
            verdict: verdict({ comparison: metric.comparison, pSlowerAdjusted, pFasterAdjusted }, thresholds[metric.metric], alpha),
          };
        });
      return { ...shot, metrics };
    });

    // A page that crashed cannot list its errors, and that is itself a failure.
    const errorsOf = async (arm: ArmName): Promise<AgentErrors> => {
      try {
        return await arms[arm].call("errors");
      } catch (error) {
        return { console: [], logger: [], gpu: [], page: [`page unavailable: ${error instanceof Error ? error.message : String(error)}`] };
      }
    };
    const errors: Record<ArmName, AgentErrors> = { base: await errorsOf("base"), head: await errorsOf("head") };
    const summary = summarize(finalShots, errors);
    const ratios = (metric: TimingMetric) => {
      const values = finalShots.flatMap((shot) => shot.metrics.filter((candidate) => candidate.metric === metric).map((candidate) => candidate.comparison.ratio));
      return values.length > 0 ? geometricMean(values) : null;
    };
    const report: PerfAbReport = {
      tool: "perf-ab",
      reportVersion: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mode: aa ? "aa" : "ab",
      base,
      head,
      host: {
        platform: `${process.platform}-${process.arch}`,
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        browser: info.userAgent,
        backend: backend === "swiftshader" ? "SwiftShader (CPU WebGPU)" : "hardware GPU",
        adapter: `${info.adapter.vendor} ${info.adapter.architecture} ${info.adapter.description}`.trim(),
      },
      settings: {
        rounds,
        framesPerArmPerRound: 2 * framesPerTurn,
        timedMetrics: timed,
        gatedMetrics,
        guardMetrics,
        thresholds,
        alpha,
        renderScale,
        openFrames,
        settleFrames,
        countFrames,
        minStreamFrames,
        maxStreamFrames,
        quality: values.quality,
        renderingMode: values.mode,
        aircraft: values.aircraft,
        offCanonical,
      },
      shots: finalShots,
      errors,
      summary: {
        verdict: summary.verdict,
        reasons: summary.reasons,
        geometricMeanRatio: {
          gpu: ratios("gpu"),
          cpu: ratios("cpu"),
          wall: ratios("wall"),
        },
      },
    };
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
    const markdown = renderMarkdown(report);
    writeFileSync(join(outDir, "report.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    console.log(`\n${markdown}`);
    log(`report: ${join(outDir, "report.md")}`);
    for (const arm of ARMS) await arms[arm].close();

    if (summary.verdict === "failed" || summary.verdict === "regression") return values["no-fail"] ? 0 : 1;
    if (summary.verdict === "inconclusive") {
      // A workflow command ends at a newline, and `%` is its escape.
      if (process.env.GITHUB_ACTIONS) console.log(`::warning::perf-ab inconclusive: ${oneLine(summary.reasons.join("; ")).replace(/%/gu, "%25")}`);
      return values["fail-on-inconclusive"] && !values["no-fail"] ? 1 : 0;
    }
    return 0;
  } finally {
    for (const agent of opened) await agent.close().catch(() => undefined);
    for (const server of Object.values(servers)) await server?.close();
  }
}

interface ShotSettings {
  readonly rounds: number;
  readonly framesPerTurn: number;
  readonly timed: readonly TimingMetric[];
  readonly gated: readonly TimingMetric[];
  readonly renderScale: number | null;
  readonly openFrames: number;
  readonly settleFrames: number;
  readonly countFrames: number;
  readonly minStreamFrames: number;
  readonly maxStreamFrames: number;
  /** On the capture's own settings, where its ceilings and baselines apply. */
  readonly pinned: boolean;
  readonly outDir: string;
  readonly root: string;
}

async function runShot(
  arms: Record<ArmName, AgentArm>,
  shot: PerfCaptureShotDefinition,
  canonicalShotIndex: number,
  catalog: AgentCatalog,
  settings: ShotSettings,
): Promise<{ shot: ShotResult; metrics: Omit<PendingMetric, "shot">[] }> {
  const shotStarted = performance.now();
  // Both arms finish before either's failure propagates, so a failed shot
  // leaves neither page mid-call when the next shot starts.
  const both = async <T,>(run: (arm: AgentArm) => Promise<T>): Promise<[T, T]> => {
    const [base, head] = await Promise.allSettled([run(arms.base), run(arms.head)]);
    if (base.status === "rejected") throw base.reason;
    if (head.status === "rejected") throw head.reason;
    return [base.value, head.value];
  };
  const failed = (failure: string, status: ShotResult["status"] = "failed"): { shot: ShotResult; metrics: [] } => ({
    shot: {
      name: shot.name, canonicalShotIndex, status, failure,
      elapsedSeconds: (performance.now() - shotStarted) / 1000,
      viewport: null, raster: null, renderScale: null, streaming: null, padded: null, metrics: [], passes: [],
      work: null, diagnostics: null, ceilings: null, pixels: null, baseline: null,
      measuredFrameCreations: null, invalidPasses: null, samples: [],
    },
    metrics: [],
  });
  try {
    const width = shot.viewportWidth ?? 1_280;
    const height = shot.viewportHeight ?? 720;
    await both((arm) => arm.setViewport(width, height));
    log(`${shot.name}: preparing`);
    const [basePrepare, headPrepare] = await both((arm) => arm.call("prepareShot", {
      shot, canonicalShotIndex, renderScale: settings.renderScale, openFrames: settings.openFrames,
    }));
    if (basePrepare.raster.width !== headPrepare.raster.width || basePrepare.raster.height !== headPrepare.raster.height) {
      return failed(`the arms render at different sizes (${basePrepare.raster.width}x${basePrepare.raster.height} vs ${headPrepare.raster.width}x${headPrepare.raster.height})`);
    }
    log(`${shot.name}: streaming at ${headPrepare.raster.width}x${headPrepare.raster.height}`);
    const [baseStream, headStream] = await both((arm) => arm.call("stream", {
      minFrames: settings.minStreamFrames, maxFrames: settings.maxStreamFrames, checkEvery: 30,
    }));
    const streaming = {
      base: { frames: baseStream.frames, settled: baseStream.settled, seconds: baseStream.elapsedMs / 1000, bakedWhileClosed: baseStream.bakedWhileClosed },
      head: { frames: headStream.frames, settled: headStream.settled, seconds: headStream.elapsedMs / 1000, bakedWhileClosed: headStream.bakedWhileClosed },
    };
    log(`${shot.name}: streamed ${baseStream.frames} / ${headStream.frames} frames (base / head)`);
    if (!baseStream.settled || !headStream.settled) {
      const result = failed(
        `streaming did not settle within ${settings.maxStreamFrames} frames (base ${baseStream.settled ? "settled" : "pending"}, head ${headStream.settled ? "settled" : "pending"})`,
        "unsettled",
      );
      return { ...result, shot: { ...result.shot, streaming } };
    }
    // Every cadence in the renderer keys on its frame index, so the arms enter
    // the settle on the same one: the arm that streamed fewer frames renders
    // the difference, still gated.
    let padded: ShotResult["padded"] = null;
    if (baseStream.renderCalls !== headStream.renderCalls) {
      const behind: ArmName = baseStream.renderCalls < headStream.renderCalls ? "base" : "head";
      const frames = Math.abs(baseStream.renderCalls - headStream.renderCalls);
      await arms[behind].call("pad", frames);
      padded = { arm: behind, frames };
    }
    const [baseSettle, headSettle] = await both((arm) => arm.call("settle", {
      settleFrames: settings.settleFrames, countFrames: settings.countFrames,
    }));
    if (baseSettle.renderCalls !== headSettle.renderCalls) {
      return failed(`the arms' frame indices diverged (${baseSettle.renderCalls} vs ${headSettle.renderCalls})`);
    }
    log(settings.rounds > 0 ? `${shot.name}: settled; measuring ${settings.rounds} rounds` : `${shot.name}: settled`);

    const samples: MeasuredSample[] = [];
    const lead = settings.gated[0]!;
    for (let round = 0; round < settings.rounds; round += 1) {
      for (const arm of roundOrder(round)) {
        for (let frame = 0; frame < settings.framesPerTurn; frame += 1) {
          const sample = await arms[arm].call("measureFrame");
          samples.push({ ...sample, round, arm });
        }
      }
      // Every round of a short run; every sixteenth of a long one, which on a
      // GPU is hundreds of rounds in a couple of minutes (report.json has all).
      if (settings.rounds > 64 && (round + 1) % 16 !== 0 && round + 1 !== settings.rounds) continue;
      const total = (arm: ArmName, metric: TimingMetric) => samples
        .filter((sample) => sample.round === round && sample.arm === arm)
        .reduce((sum, sample) => sum + read(sample, metric), 0);
      log(
        `${shot.name}: round ${round + 1}/${settings.rounds}: `
        + settings.timed
          .map((metric) => `${metric} base ${total("base", metric).toFixed(1)} head ${total("head", metric).toFixed(1)}`)
          .join("; ")
        + ` ms (${lead} gates)`,
      );
    }

    const baseCapture = await arms.base.call("capture");
    const headCapture = await arms.head.call("capture");
    const shotDir = ensureDirectory(join(settings.outDir, shot.name));
    writeFileSync(join(shotDir, "base.png"), Buffer.from(baseCapture.pngBase64, "base64"));
    writeFileSync(join(shotDir, "head.png"), Buffer.from(headCapture.pngBase64, "base64"));
    const pixels = await arms.head.call("compareImages", baseCapture.pngBase64, headCapture.pngBase64, width, height);
    const baselinePath = join(settings.root, "tests/perf/baseline", `${shot.name}.png`);
    let baseline: Record<ArmName, ImageComparison | null> | null = null;
    if (settings.pinned && existsSync(baselinePath)) {
      const reference = readFileSync(baselinePath).toString("base64");
      const against = async (capture: string) => {
        try {
          return await arms.head.call("compareImages", reference, capture, width, height);
        } catch {
          return null;
        }
      };
      baseline = { base: await against(baseCapture.pngBase64), head: await against(headCapture.pngBase64) };
    }

    const metrics: Omit<PendingMetric, "shot">[] = settings.rounds === 0 ? [] : settings.timed.map((metric) => ({
      metric,
      comparison: comparePaired(
        roundTotals(samples, "base", settings.rounds, (sample) => read(sample, metric)),
        roundTotals(samples, "head", settings.rounds, (sample) => read(sample, metric)),
      ),
    }));

    const baseWork = perFrameCounts(baseSettle.counters);
    const headWork = perFrameCounts(headSettle.counters);
    const ceiling = shot.drawCallCeiling ?? null;
    const mostDraws = (settle: SettleReport) => Math.max(settle.diagnostics.drawCalls, ...settle.drawCallsPerFrame);
    const fewestDraws = (settle: SettleReport) => Math.min(settle.diagnostics.drawCalls, ...settle.drawCallsPerFrame);
    const newBreaches: string[] = [];
    if (settings.pinned && ceiling !== null && mostDraws(headSettle) > ceiling && mostDraws(baseSettle) <= ceiling) {
      newBreaches.push(`draw calls ${mostDraws(headSettle)} exceed the shot's ceiling of ${ceiling}`);
    }
    if (
      settings.pinned
      && headSettle.diagnostics.inventoriedGpuMemoryMiB > catalog.inventoriedMemoryCeilingMiB
      && baseSettle.diagnostics.inventoriedGpuMemoryMiB <= catalog.inventoriedMemoryCeilingMiB
    ) {
      newBreaches.push(
        `inventoried GPU memory ${headSettle.diagnostics.inventoriedGpuMemoryMiB.toFixed(1)} MiB exceeds the `
        + `${catalog.inventoriedMemoryCeilingMiB} MiB ceiling`,
      );
    }
    const created = (arm: ArmName) => ({
      pipelines: samples.filter((sample) => sample.arm === arm).reduce((sum, sample) => sum + sample.pipelinesCreated, 0),
      shaderModules: samples.filter((sample) => sample.arm === arm).reduce((sum, sample) => sum + sample.shaderModulesCreated, 0),
    });
    const invalid = (arm: ArmName) => samples.filter((sample) => sample.arm === arm).reduce((sum, sample) => sum + sample.invalidPasses, 0);
    return {
      shot: {
        name: shot.name,
        canonicalShotIndex,
        status: "measured",
        failure: null,
        elapsedSeconds: (performance.now() - shotStarted) / 1000,
        viewport: { width, height },
        raster: headPrepare.raster,
        renderScale: headPrepare.renderScale,
        streaming,
        padded,
        metrics: [],
        passes: passTimingChanges(samples, settings.rounds, 2 * settings.framesPerTurn),
        work: {
          base: baseWork,
          head: headWork,
          changes: countChanges(baseWork, headWork),
          passChanges: passChanges(baseSettle.counters, headSettle.counters),
        },
        diagnostics: {
          base: baseSettle.diagnostics,
          head: headSettle.diagnostics,
          changes: diagnosticsChanges(baseSettle.diagnostics, headSettle.diagnostics),
        },
        ceilings: {
          drawCallCeiling: ceiling,
          baseDrawCalls: mostDraws(baseSettle),
          headDrawCalls: mostDraws(headSettle),
          baseDrawCallsMin: fewestDraws(baseSettle),
          headDrawCallsMin: fewestDraws(headSettle),
          memoryCeilingMiB: catalog.inventoriedMemoryCeilingMiB,
          headMemoryMiB: headSettle.diagnostics.inventoriedGpuMemoryMiB,
          newBreaches,
        },
        pixels,
        baseline,
        measuredFrameCreations: { base: created("base"), head: created("head") },
        invalidPasses: { base: invalid("base"), head: invalid("head") },
        samples: samples.map(({ round, arm, gpuMs, renderMs, wallMs }) => ({ round, arm, gpuMs, renderMs, wallMs })),
      },
      metrics,
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`perf-ab: ${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
