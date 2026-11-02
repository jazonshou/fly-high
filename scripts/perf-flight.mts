/**
 * `npm run perf:flight` — does the head stutter more than the base in flight?
 *
 * `npm run perf:ab` times a frame of a settled shot, which is the steady cost.
 * A player's frames also carry the work of flying into terrain nobody has seen
 * yet: pages and detail cells streaming in, their results landing on the main
 * thread, pipelines compiled the first time a material meets a new state, and
 * the garbage all of that leaves for the collector. None of it shows in a
 * settled shot, and all of it shows as a hitch.
 *
 * So both arms (production builds of the same agent page as the A/B, a
 * browser each) start from the same settled shot and fly the same scripted
 * path, terrain following at a fixed speed, in legs that alternate between
 * the arms (ABBA), and every frame records:
 *  - `render()`'s main-thread time, and the time the main thread spends on
 *    everything queued behind it before the next frame (worker results,
 *    buffer maps, timers);
 *  - the JS heap grown in each, so allocation per frame and collections
 *    (falls) can be counted (`--enable-precise-memory-info`);
 *  - pipelines and shader modules created, and the WGSL characters compiled.
 * Main-thread tasks over 50 ms are listed from the Long Tasks API.
 *
 * By default the frame's own draws are dropped (`gpuDrawGate.ts`), so on a
 * software adapter a frame costs its CPU work and its compute, not seconds of
 * rasterisation; every pipeline is still created, every bake still runs.
 * `--draws` keeps them.
 *
 * The CPU numbers are relative: they come from a host whose GPU is a CPU, so
 * read them as base against head on one machine, never as a player's
 * milliseconds. Counts (pipelines, shader characters, heap bytes) do not
 * depend on the host.
 *
 *   npm run perf:flight -- --base origin/main
 *   npm run perf:flight -- --base 264b760 --head main --legs 8 --leg-frames 240
 *   npm run perf:flight -- --profile        # also a V8 CPU profile per arm per leg
 *
 * Every report also says what the vegetation worker's watchdog did in each
 * arm, in the stream to rest and in every leg (`perfFlightVerdict.mts`), and
 * `--fail-on-worker-fallback` fails the run when the commit under test
 * tripped it. It ends with what the two bakes the renderer spreads over
 * frames cost, frame by frame (`perfFlightBakes.mts`): the sky probe's
 * sliced re-light in a climb, and the ground-cover tile bake low down.
 *
 * Both arms' renderers are made with the game's two terrain samplers, the
 * full sample and the height-only one (`AgentConfig.gameTerrainHeight`), so
 * the ground-cover tile bakes in steps as in the game; a build without
 * `FlightRendererOptions.terrainHeight` (before 69746b7, "Read height-only
 * terrain where a consumer needs only the height") ignores the second and
 * bakes whole rows, as its game did. perf:flight runs from before it asked
 * for the pair flew the full sample alone, so their low legs do not compare
 * with later runs'. perf:ab still makes the capture's renderer.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import {
  buildAgent,
  chromiumArgs,
  chromiumExecutable,
  ensureDirectory,
  git,
  prepareArmCheckout,
  removeArmCheckout,
  serveDirectory,
  type GpuBackend,
  type StaticServer,
} from "./perfAbHarness.mts";
import { bakeSection, describeLegBakes } from "./perfFlightBakes.mts";
import {
  ARMS,
  faultOutcome,
  flightVerdict,
  parseFrameRange,
  parseHitch,
  parseLegFrame,
  percentiles,
  renderVerdictMarkdown,
  trippedBeyondFault,
  workerFallbackExitCode,
  workerTripped,
  type ArmName,
  type LegFrame,
  type Percentiles,
  type SettleTrial,
} from "./perfFlightVerdict.mts";
import type {
  AgentCatalog,
  DetailWatchdogReport,
  DetailWorkerFault,
  DetailWorkerState,
  FlightFrame,
  FlightReport,
  FlightRequest,
  PerfAgent,
} from "../tests/perf/ab/protocol.ts";
import type { WeatherPreset } from "../src/game/types.ts";

/** The game's weathers, to turn a typo away before both arms are built (each agent checks its own). */
const WEATHERS: Readonly<Record<WeatherPreset, true>> = { clear: true, breezy: true, cloudy: true };

const USAGE = `usage: npm run perf:flight -- [options]

  --base <ref>            base commit (default: merge-base of HEAD and origin/main)
  --head <ref>            head commit (default: the working tree)
  --shot <name>           the canonical shot to start from (default approach-500ft)
  --legs <n>              legs per arm (default 6)
  --leg-frames <n>        frames per leg (default 240, 4 s of flight)
  --speed <m/s>           ground speed (default 120)
  --burst-legs            alternate the legs between 250 and 60 m/s instead (ABBA keeps each leg's speed equal)
  --park-legs             hold still (0 m/s) on odd legs and fly on even ones: a stop on the runway, then the roll
  --clearance <m>         height kept above the terrain (default 150)
  --bank <deg>            constant bank; 0 flies straight (default 0)
  --pitch-down <deg>      legs 2, 4, ... push the nose that far below the horizon (at 30 deg/s) and
                          legs 1, 3, ... bring it back level; the path still follows the terrain, so the
                          camera looks at the ground from the clearance (default 0: every leg level)
  --camera chase|cockpit  (default chase)
  --weather clear|breezy|cloudy
                          (default clear, as the capture; the game's default is breezy)
  --quality, --mode, --aircraft   renderer settings (default medium, balanced, trainer)
  --draws                 keep the frame's own draws (slow on a software adapter)
  --fence-every <n>       fence to GPU idle every n frames (default 4)
  --start <x,z[,yaw]>     begin the flight here (world metres, yaw in degrees) instead of at the shot's pose
  --base-world <json>, --head-world <json>
                          options merged into that arm's createWorld (e.g. a landform under test)
  --kill-detail-worker <leg>:<frame>
                          fail the vegetation worker in both arms before that frame of that leg
                          (legs from 1, frames from 0): an error event, as a crashed worker script
  --hang-detail-worker <leg>:<frame>
                          as --kill-detail-worker, but terminate it with no event: a silent worker
  --settle-trials <k>     after the legs, k independent fresh-region settles: in each, both arms at once
                          build a new renderer and hold still over the next land start (a spiral out
                          from the home airport that skips the sea), as in the stream to rest
  --trial-frames <n>      frames per settle trial (default 600)
  --emulate-hitch <ms>@<leg>:<frame>
                          that frame stands for a main thread blocked <ms> while the simulation flew on:
                          path and simulation time advance by <ms>, render()'s delta is FlightGame's
                          clamp of it (0.1 s at most); every other frame stays 1/60 s
  --frame-dump <from>-<to>
                          read those frames of the hitch's leg back as each renders (no extra render)
                          and write them as PNGs under <out>/frames (needs --emulate-hitch, --draws)
  --gpu swiftshader|hardware
  --chromium <path>
  --profile               write a V8 CPU profile per arm per leg (perturbs the timings)
  --heap-profile          write a V8 sampling heap profile per arm per leg: where the garbage comes from
  --no-minify             build the arms unminified, so profiles name functions (timings move)
  --fail-on-worker-fallback
                          exit 1 when the arm built from the commit under test tripped the
                          vegetation worker's watchdog (timed out, restarted or fell back)
  --under-test <ref>      the commit --fail-on-worker-fallback asks about (default the head;
                          name it when the arms are swapped)
  --out <dir>             (default tests/perf/artifacts/flight/<timestamp>)

The report ends with what the sky re-light and the ground-cover tile bake cost frame by frame,
and says "not exercised" when the legs never reached one:
  a sky re-light comes every 500 m of climb and the agent climbs at most 25 m/s, so one needs
    about 1200 frames of climb: e.g. --clearance 1500 --speed 250 --legs 2 --leg-frames 720
  the ground cover bakes only below its fade height (40 to 110 m above the ground, by tier) and
    the agent descends at most 10 m/s from the shot's altitude; --start begins the legs at
    --clearance above the ground: e.g. --clearance 30 --speed 70 --start <x,z>
`;

const started = performance.now();
function log(line: string): void {
  console.log(`[perf-flight ${((performance.now() - started) / 1000).toFixed(0).padStart(5)} s] ${line}`);
}

const ACCEPT_FALLBACK_ADAPTER = `(() => {
  const proto = globalThis.GPUAdapterInfo && globalThis.GPUAdapterInfo.prototype;
  if (proto) Object.defineProperty(proto, "isFallbackAdapter", { get() { return false; }, configurable: true });
})();`;

/** One arm: a browser, a page and a CDP session for profiling. */
class FlightArm {
  readonly name: ArmName;
  readonly page: Page;
  readonly cdp: CDPSession;
  private readonly browser: Browser;

  private constructor(name: ArmName, browser: Browser, page: Page, cdp: CDPSession) {
    this.name = name;
    this.browser = browser;
    this.page = page;
    this.cdp = cdp;
  }

  static async open(name: ArmName, origin: string, backend: GpuBackend, executable: string | undefined): Promise<FlightArm> {
    const executablePath = chromiumExecutable(executable);
    const browser = await chromium.launch({
      headless: true,
      channel: "chromium",
      ...(executablePath ? { executablePath } : {}),
      // Exact heap sizes: without it `usedJSHeapSize` is bucketed and
      // updated on a timer, so per-frame allocation would read as zero.
      args: [...chromiumArgs(backend), "--enable-precise-memory-info"],
    });
    const context = await browser.newContext({ viewport: { width: 1_280, height: 720 }, deviceScaleFactor: 1 });
    if (backend === "swiftshader") await context.addInitScript(ACCEPT_FALLBACK_ADAPTER);
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") log(`[${name}] error: ${message.text()}`);
    });
    page.on("pageerror", (error) => log(`[${name}] page error: ${error.message}`));
    await page.goto(`${origin}/agent.html`);
    await page.waitForFunction(() => window.__perfAgent !== undefined, undefined, { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    return new FlightArm(name, browser, page, cdp);
  }

  call<Method extends Exclude<keyof PerfAgent, "protocol">>(
    method: Method,
    ...args: Parameters<PerfAgent[Method]>
  ): Promise<Awaited<ReturnType<PerfAgent[Method]>>> {
    return this.page.evaluate(
      ({ method: name, args: values }) => {
        const agent = window.__perfAgent as unknown as Record<string, (...input: unknown[]) => unknown>;
        return agent[name]!(...values);
      },
      { method: method as string, args: args as unknown[] },
    ) as Promise<Awaited<ReturnType<PerfAgent[Method]>>>;
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}

interface ArmSummary {
  readonly frames: number;
  readonly renderMs: Percentiles;
  readonly betweenMs: Percentiles;
  readonly frameCpuMs: Percentiles;
  /** Frames whose render + between time exceeds 2x and 4x the arm's median. */
  readonly spikesOver2x: number;
  readonly spikesOver4x: number;
  /** Mean JS heap growth per frame, counting only growth (falls are collections). */
  readonly allocatedKiBPerFrame: number;
  /** Heap falls over 1 MiB: major or large minor collections that landed in a measured span. */
  readonly collections: number;
  readonly pipelinesCreated: number;
  readonly shaderModulesCreated: number;
  readonly shaderCodeKiB: number;
  readonly framesCreatingPipelines: number;
  readonly longTasks: number;
  readonly longTaskMs: number;
  readonly worstLongTaskMs: number;
  /** Over the frames past 4x the median: each frame-graph pass's summed ms, and how often it was the largest. */
  readonly spikePasses: Readonly<Record<string, { readonly ms: number; readonly largest: number }>>;
  /** Each effect compiled during the measured frames (`FlightFrame.effectsCompiled`). */
  readonly effectsCompiled: readonly string[];
}

function summarize(legs: readonly FlightReport[], skipLegs: number): ArmSummary {
  const measured = legs.slice(skipLegs);
  const frames: FlightFrame[] = measured.flatMap((leg) => leg.frames);
  const frameCpu = frames.map((frame) => frame.renderMs + frame.betweenMs);
  const median = percentiles(frameCpu).p50;
  let growth = 0;
  let collections = 0;
  for (const frame of frames) {
    for (const delta of [frame.heapRenderBytes, frame.heapBetweenBytes]) {
      if (delta > 0) growth += delta;
      else if (delta < -1_048_576) collections += 1;
    }
  }
  const longTasks = measured.flatMap((leg) => leg.longTasks);
  const spikePasses: Record<string, { ms: number; largest: number }> = {};
  for (const frame of frames) {
    if (frame.renderMs + frame.betweenMs <= 4 * median) continue;
    const entries = Object.entries(frame.passMs ?? {});
    const between = ["(between frames)", frame.betweenMs] as const;
    let largest: readonly [string, number] = between;
    for (const entry of [...entries, between]) {
      const row = (spikePasses[entry[0]] ??= { ms: 0, largest: 0 });
      row.ms += entry[1];
      if (entry[1] > largest[1]) largest = entry;
    }
    spikePasses[largest[0]]!.largest += 1;
  }
  return {
    frames: frames.length,
    renderMs: percentiles(frames.map((frame) => frame.renderMs)),
    betweenMs: percentiles(frames.map((frame) => frame.betweenMs)),
    frameCpuMs: percentiles(frameCpu),
    spikesOver2x: frameCpu.filter((value) => value > 2 * median).length,
    spikesOver4x: frameCpu.filter((value) => value > 4 * median).length,
    allocatedKiBPerFrame: growth / Math.max(1, frames.length) / 1024,
    collections,
    pipelinesCreated: frames.reduce((sum, frame) => sum + frame.pipelinesCreated, 0),
    shaderModulesCreated: frames.reduce((sum, frame) => sum + frame.shaderModulesCreated, 0),
    shaderCodeKiB: frames.reduce((sum, frame) => sum + frame.shaderCodeChars, 0) / 1024,
    framesCreatingPipelines: frames.filter((frame) => frame.pipelinesCreated > 0).length,
    longTasks: longTasks.length,
    longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
    worstLongTaskMs: longTasks.reduce((worst, task) => Math.max(worst, task.duration), 0),
    spikePasses,
    effectsCompiled: frames.flatMap((frame) => frame.effectsCompiled ?? []),
  };
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/**
 * One log line's worth of a stream's or a leg's vegetation worker; `fault`
 * is a failure the harness caused in this leg or an earlier one, which is
 * not a trip (as in the verdict).
 */
function describeDetailWorker(
  state: DetailWorkerState | null | undefined,
  watchdog: DetailWatchdogReport | null | undefined,
  fault: DetailWorkerFault | null = null,
): string {
  const parts: string[] = [];
  if (state && fault) {
    parts.push(`${fault.kind === "kill" ? "killed" : "hung"} worker: ${faultOutcome(fault, state)}`);
  }
  if (state && (fault ? trippedBeyondFault(fault, state) : workerTripped(state))) {
    parts.push(`DETAIL WORKER TRIPPED (${JSON.stringify(state)})`);
  }
  if (watchdog) {
    const wouldTrip = watchdog.presentation.wouldTripAt120Hz + watchdog.generation.wouldTripAt120Hz;
    parts.push(`watchdog charged max ${fmt(watchdog.presentation.maxChargedMs, 0)} / ${fmt(watchdog.generation.maxChargedMs, 0)} ms`
      + (wouldTrip > 0 ? `, ${wouldTrip} WOULD TRIP at 120 Hz` : ""));
  }
  return parts.length === 0 ? "" : `, ${parts.join(", ")}`;
}

/** A frame's whole cost on this host: render(), the tasks behind it, and its fence wait when it fenced. */
function frameWallMs(frame: FlightFrame): number {
  return frame.renderMs + frame.betweenMs + (frame.fenceMs ?? 0);
}

/**
 * Each frame of a leg that created render pipelines: its index, attitude,
 * cost and what asked for each pipeline (`FlightFrame.pipelineSources`).
 */
function describeLegPipelines(report: FlightReport): string[] {
  const lines: string[] = [];
  for (const [index, frame] of report.frames.entries()) {
    if (frame.pipelinesCreated === 0) continue;
    const sources = frame.pipelineSources ?? [];
    lines.push(`frame ${index} (pitch ${fmt(frame.pitchDownDegrees ?? 0, 0)} deg): ${frame.pipelinesCreated} pipelines, `
      + `render ${fmt(frame.renderMs, 1)} + between ${fmt(frame.betweenMs, 1)}`
      + (frame.fenceMs === undefined ? "" : ` + fence ${fmt(frame.fenceMs, 1)}`) + " ms"
      + (frame.deferredDraws ? `, ${frame.deferredDraws} draws deferred` : "")
      + (sources.length > 0 ? `: ${sources.join("; ")}` : ""));
  }
  return lines;
}

function renderPipelineMarkdown(reports: Record<ArmName, readonly FlightReport[]>): string {
  const lines = ["## Pipelines created mid-flight", ""];
  let any = false;
  for (const arm of ARMS) {
    for (const [leg, report] of reports[arm].entries()) {
      const legLines = describeLegPipelines(report);
      if (legLines.length === 0) continue;
      any = true;
      const fenced = report.frames.filter((frame) => frame.fenceMs !== undefined);
      const worst = report.frames.reduce((top, frame) => (frameWallMs(frame) > frameWallMs(top) ? frame : top));
      const deferred = report.frames.reduce((sum, frame) => sum + (frame.deferredDraws ?? 0), 0);
      lines.push(`- ${arm} leg ${leg + 1}`
        + (fenced.length > 0 ? ` (fence ms p50 ${fmt(percentiles(fenced.map((frame) => frame.fenceMs!)).p50, 1)})` : "")
        + `, worst frame ${fmt(frameWallMs(worst), 1)} ms`
        + (deferred > 0 ? `, ${deferred} draws waited for an off-frame compile` : "") + ":");
      for (const line of legLines) lines.push(`  - ${line}`);
    }
  }
  if (!any) lines.push("None: every pipeline the flight drew existed before its first leg.");
  lines.push("");
  return lines.join("\n");
}

function renderMarkdown(
  identity: Record<ArmName, string>,
  settings: Record<string, unknown>,
  summaries: Record<ArmName, ArmSummary>,
  firstLeg: Record<ArmName, ArmSummary>,
): string {
  const rows: [string, (summary: ArmSummary) => string][] = [
    ["frames measured", (s) => String(s.frames)],
    ["render() ms p50 / p95 / p99 / max", (s) => `${fmt(s.renderMs.p50)} / ${fmt(s.renderMs.p95)} / ${fmt(s.renderMs.p99)} / ${fmt(s.renderMs.max)}`],
    ["between frames ms p50 / p95 / p99 / max", (s) => `${fmt(s.betweenMs.p50)} / ${fmt(s.betweenMs.p95)} / ${fmt(s.betweenMs.p99)} / ${fmt(s.betweenMs.max)}`],
    ["frame CPU ms mean / p95 / max", (s) => `${fmt(s.frameCpuMs.mean)} / ${fmt(s.frameCpuMs.p95)} / ${fmt(s.frameCpuMs.max)}`],
    ["frames over 2x / 4x the median", (s) => `${s.spikesOver2x} / ${s.spikesOver4x}`],
    ["JS heap allocated per frame, KiB", (s) => fmt(s.allocatedKiBPerFrame, 1)],
    ["heap falls over 1 MiB (collections)", (s) => String(s.collections)],
    ["pipelines / shader modules created", (s) => `${s.pipelinesCreated} / ${s.shaderModulesCreated}`],
    ["WGSL compiled, KiB", (s) => fmt(s.shaderCodeKiB, 1)],
    ["frames creating pipelines", (s) => String(s.framesCreatingPipelines)],
    ["long tasks (>50 ms): count / total ms / worst ms", (s) => `${s.longTasks} / ${fmt(s.longTaskMs, 0)} / ${fmt(s.worstLongTaskMs, 0)}`],
  ];
  const spikeRows = (data: Record<ArmName, ArmSummary>) => {
    const passes = [...new Set([...Object.keys(data.base.spikePasses), ...Object.keys(data.head.spikePasses)])].sort();
    const cell = (summary: ArmSummary, pass: string) => {
      const row = summary.spikePasses[pass];
      return row ? `${fmt(row.ms, 0)} ms, largest in ${row.largest}` : "-";
    };
    return passes.length === 0 ? [] : [
      "Frames past 4x the median, by frame-graph pass (summed main-thread ms; frames where it was the largest part):",
      "",
      "| pass | base | head |",
      "| --- | --- | --- |",
      ...passes.map((pass) => `| ${pass} | ${cell(data.base, pass)} | ${cell(data.head, pass)} |`),
      "",
    ];
  };
  const effectRows = (data: Record<ArmName, ArmSummary>) => {
    const lines = ARMS.flatMap((arm) => data[arm].effectsCompiled.map((effect) => `- ${arm}: ${effect}`));
    return lines.length === 0 ? [] : ["Effects compiled mid-flight (each a pipeline compile, a hitch on first use):", "", ...lines, ""];
  };
  const table = (title: string, data: Record<ArmName, ArmSummary>) => [
    `### ${title}`,
    "",
    "| | base | head |",
    "| --- | --- | --- |",
    ...rows.map(([label, read]) => `| ${label} | ${read(data.base)} | ${read(data.head)} |`),
    "",
    ...spikeRows(data),
    ...effectRows(data),
  ];
  return [
    "# Flight A/B",
    "",
    `Base ${identity.base}, head ${identity.head}.`,
    "",
    `Settings: ${Object.entries(settings).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ")}.`,
    "",
    "CPU times come from this host and are only comparable between the arms; counts are exact.",
    "",
    ...table("The flight after its first leg", summaries),
    ...table("The first leg (leaving the settled shot)", firstLeg),
  ].join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      shot: { type: "string", default: "approach-500ft" },
      legs: { type: "string", default: "6" },
      "leg-frames": { type: "string", default: "240" },
      speed: { type: "string", default: "120" },
      "burst-legs": { type: "boolean", default: false },
      "park-legs": { type: "boolean", default: false },
      clearance: { type: "string", default: "150" },
      bank: { type: "string", default: "0" },
      "pitch-down": { type: "string", default: "0" },
      camera: { type: "string", default: "chase" },
      weather: { type: "string", default: "clear" },
      quality: { type: "string", default: "medium" },
      mode: { type: "string", default: "balanced" },
      aircraft: { type: "string", default: "trainer" },
      draws: { type: "boolean", default: false },
      "fence-every": { type: "string", default: "4" },
      start: { type: "string" },
      "base-world": { type: "string" },
      "head-world": { type: "string" },
      "kill-detail-worker": { type: "string" },
      "hang-detail-worker": { type: "string" },
      "settle-trials": { type: "string", default: "0" },
      "trial-frames": { type: "string", default: "600" },
      "emulate-hitch": { type: "string" },
      "frame-dump": { type: "string" },
      gpu: { type: "string" },
      chromium: { type: "string" },
      profile: { type: "boolean", default: false },
      "heap-profile": { type: "boolean", default: false },
      "no-minify": { type: "boolean", default: false },
      "fail-on-worker-fallback": { type: "boolean", default: false },
      "under-test": { type: "string" },
      out: { type: "string" },
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
  const legs = Number(values.legs);
  const legFrames = Number(values["leg-frames"]);
  const camera = values.camera as FlightRequest["cameraMode"];
  if (!(legs >= 2 && Number.isInteger(legs)) || !(legFrames >= 10 && Number.isInteger(legFrames))) {
    console.error(USAGE);
    return 2;
  }
  const pitchDown = Number(values["pitch-down"]);
  if (!(Number.isFinite(pitchDown) && pitchDown >= 0 && pitchDown <= 89)) {
    console.error(`perf-flight: --pitch-down takes degrees from 0 to 89 (got ${values["pitch-down"]})`);
    return 2;
  }
  const settleTrials = Number(values["settle-trials"]);
  const trialFrames = Number(values["trial-frames"]);
  if (!(settleTrials >= 0 && Number.isInteger(settleTrials)) || !(trialFrames >= 10 && Number.isInteger(trialFrames))) {
    console.error(USAGE);
    return 2;
  }
  if (!Object.hasOwn(WEATHERS, values.weather)) {
    console.error(`perf-flight: --weather takes ${Object.keys(WEATHERS).join(", ")} (got ${values.weather})`);
    return 2;
  }
  const startValues = values.start?.split(",").map(Number) ?? null;
  if (startValues && !(startValues.length >= 2 && startValues.length <= 3 && startValues.every(Number.isFinite))) {
    console.error(`perf-flight: --start takes x,z or x,z,yaw (got ${values.start})`);
    return 2;
  }
  const start = startValues
    ? { x: startValues[0]!, z: startValues[1]!, yawDegrees: startValues[2] ?? 0 }
    : null;
  let faults: { readonly kill: LegFrame | null; readonly hang: LegFrame | null };
  let hitch: (LegFrame & { readonly milliseconds: number }) | null;
  let frameDump: { readonly from: number; readonly to: number } | null;
  try {
    const parse = (option: "kill-detail-worker" | "hang-detail-worker") => {
      const text = values[option];
      return text === undefined ? null : parseLegFrame(`--${option}`, text, legs, legFrames);
    };
    faults = { kill: parse("kill-detail-worker"), hang: parse("hang-detail-worker") };
    // The verdict excuses one failure per arm; a second would read as a trip.
    if (faults.kill && faults.hang) throw new Error("perf-flight: --kill-detail-worker and --hang-detail-worker are separate runs");
    hitch = values["emulate-hitch"] === undefined ? null : parseHitch("--emulate-hitch", values["emulate-hitch"], legs, legFrames);
    frameDump = values["frame-dump"] === undefined ? null : parseFrameRange("--frame-dump", values["frame-dump"], legFrames);
    if (frameDump && !hitch) throw new Error("perf-flight: --frame-dump reads the --emulate-hitch leg; give one");
    // With its draws dropped (gpuDrawGate.ts) a frame's own image is never drawn.
    if (frameDump && !values.draws) throw new Error("perf-flight: --frame-dump needs --draws");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const worldOptions: Record<ArmName, Record<string, unknown> | null> = { base: null, head: null };
  for (const arm of ARMS) {
    const raw = values[`${arm}-world`];
    if (raw === undefined) continue;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`perf-flight: --${arm}-world takes a JSON object (got ${raw})`);
      return 2;
    }
    worldOptions[arm] = parsed as Record<string, unknown>;
  }
  const headSha = values.head ? git(root, "rev-parse", "--verify", `${values.head}^{commit}`) : git(root, "rev-parse", "HEAD");
  const dirty = !values.head && git(root, "status", "--porcelain", "--untracked-files=no").length > 0;
  const baseRef = values.base ?? git(root, "merge-base", "HEAD", "origin/main");
  const baseSha = git(root, "rev-parse", "--verify", `${baseRef}^{commit}`);
  const identity: Record<ArmName, string> = {
    base: `${baseRef} (${baseSha.slice(0, 10)})`,
    head: `${values.head ?? "working tree"} (${headSha.slice(0, 10)}${dirty ? " + uncommitted" : ""})`,
  };
  const shas: Record<ArmName, string> = { base: baseSha, head: headSha };
  let underTestSha = headSha;
  if (values["under-test"]) {
    try {
      underTestSha = git(root, "rev-parse", "--verify", `${values["under-test"]}^{commit}`);
    } catch {
      console.error(`perf-flight: --under-test ${values["under-test"]} is not a commit`);
      return 2;
    }
  }
  if (underTestSha !== baseSha && underTestSha !== headSha) {
    console.error(`perf-flight: --under-test ${values["under-test"]} is neither arm's commit`);
    return 2;
  }
  const outDir = resolve(values.out ?? join(root, "tests/perf/artifacts/flight", new Date().toISOString().replace(/[:.]/gu, "-")));
  ensureDirectory(outDir);
  log(`base ${identity.base} vs head ${identity.head}; ${backend}; output ${outDir}`);

  const builds: Record<ArmName, string> = { base: join(outDir, "build", "base"), head: join(outDir, "build", "head") };
  const worktrees: string[] = [];
  const buildOptions = { minify: !values["no-minify"] };
  try {
    for (const arm of ARMS) {
      const ref = arm === "base" ? baseSha : values.head ? headSha : null;
      if (ref === null) {
        await buildAgent(root, builds[arm], join(outDir, "build", `vite-cache-${arm}`), buildOptions);
      } else {
        const directory = join(tmpdir(), `fly-high-perf-flight-${arm}-${ref.slice(0, 12)}-${process.pid}`);
        worktrees.push(directory);
        await buildAgent(
          prepareArmCheckout(root, ref, directory),
          builds[arm],
          join(outDir, "build", `vite-cache-${arm}`),
          buildOptions,
        );
      }
      log(`built the ${arm} arm`);
    }
  } finally {
    for (const directory of worktrees) removeArmCheckout(root, directory);
  }

  const servers: StaticServer[] = [];
  const opened: FlightArm[] = [];
  try {
    const arms = {} as Record<ArmName, FlightArm>;
    for (const arm of ARMS) {
      const server = await serveDirectory(builds[arm]);
      servers.push(server);
      arms[arm] = await FlightArm.open(arm, server.origin, backend, values.chromium);
      opened.push(arms[arm]);
      await arms[arm].call("configure", {
        quality: values.quality,
        renderingMode: values.mode,
        aircraft: values.aircraft,
        profileOverride: null,
        worldOptions: worldOptions[arm],
        weather: values.weather,
        // Fly the game's terrain samplers: its ground-cover tile bakes in
        // steps on the height-only one (perf:ab keeps the capture's).
        gameTerrainHeight: true,
      });
    }
    const catalog: AgentCatalog = await arms.head.call("catalog");
    const canonicalShotIndex = catalog.shots.findIndex((shot) => shot.name === values.shot);
    if (canonicalShotIndex < 0) throw new Error(`perf-flight: no canonical shot ${values.shot}`);
    const shot = catalog.shots[canonicalShotIndex]!;
    await Promise.all(ARMS.map((arm) => arms[arm].call("prepareShot", {
      shot, canonicalShotIndex, renderScale: null, openFrames: 2,
    })));
    log(`${shot.name}: streaming to rest`);
    const streams = await Promise.all(ARMS.map((arm) => arms[arm].call("stream", {
      minFrames: 240, maxFrames: 6_000, checkEvery: 30,
    })));
    log(`streamed ${streams[0]!.frames} / ${streams[1]!.frames} frames (base / head)`);
    const settle = { base: streams[0]!, head: streams[1]! };
    for (const arm of ARMS) {
      const detail = describeDetailWorker(settle[arm].detailWorker, settle[arm].detailWatchdog);
      if (detail) log(`settle ${arm}${detail}`);
    }

    const request: Omit<FlightRequest, "restart"> = {
      frames: legFrames,
      speedMetersPerSecond: Number(values.speed),
      clearanceMeters: Number(values.clearance),
      bankDegrees: Number(values.bank),
      cameraMode: camera,
      suppressDraws: !values.draws,
      fenceEvery: Number(values["fence-every"]),
      start,
    };
    const reports: Record<ArmName, FlightReport[]> = { base: [], head: [] };
    const injected: Record<ArmName, DetailWorkerFault | null> = { base: null, head: null };
    for (let leg = 0; leg < legs; leg += 1) {
      // ABBA, so a drifting host weighs on both arms alike.
      const order: readonly ArmName[] = leg % 2 === 0 ? ["base", "head"] : ["head", "base"];
      for (const arm of order) {
        if (values.profile) {
          await arms[arm].cdp.send("Profiler.enable");
          await arms[arm].cdp.send("Profiler.setSamplingInterval", { interval: 200 });
          await arms[arm].cdp.send("Profiler.start");
        }
        if (values["heap-profile"]) {
          await arms[arm].cdp.send("HeapProfiler.enable");
          // Every allocation the sampler keeps, including those already
          // collected by the leg's end: garbage is what this looks for.
          await arms[arm].cdp.send("HeapProfiler.startSampling", {
            samplingInterval: 16_384,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hitchLeg = hitch?.leg === leg + 1;
        const { dumpedFrames, ...report } = await arms[arm].call("flight", {
          ...request,
          restart: leg === 0,
          ...(values["burst-legs"] ? { speedMetersPerSecond: leg % 2 === 0 ? 250 : 60 } : {}),
          ...(values["park-legs"] && leg % 2 === 0 ? { speedMetersPerSecond: 0 } : {}),
          ...(pitchDown > 0 ? { pitchDownDegrees: leg % 2 === 1 ? pitchDown : 0 } : {}),
          killDetailWorkerAtFrame: faults.kill?.leg === leg + 1 ? faults.kill.frame : null,
          hangDetailWorkerAtFrame: faults.hang?.leg === leg + 1 ? faults.hang.frame : null,
          hitch: hitch && hitchLeg ? { frame: hitch.frame, milliseconds: hitch.milliseconds } : null,
          dumpFrames: hitchLeg ? frameDump : null,
        });
        if (dumpedFrames && dumpedFrames.length > 0) {
          const directory = join(outDir, "frames");
          mkdirSync(directory, { recursive: true });
          for (const dumped of dumpedFrames) {
            writeFileSync(join(directory, `${arm}-leg${leg + 1}-frame${dumped.frame}.png`), Buffer.from(dumped.pngBase64, "base64"));
          }
          log(`leg ${leg + 1} ${arm}: wrote ${dumpedFrames.length} frames to ${directory}`);
        }
        if (values.profile) {
          const { profile } = await arms[arm].cdp.send("Profiler.stop");
          writeFileSync(join(outDir, `${arm}-leg${leg + 1}.cpuprofile`), JSON.stringify(profile));
        }
        if (values["heap-profile"]) {
          const { profile } = await arms[arm].cdp.send("HeapProfiler.stopSampling");
          writeFileSync(join(outDir, `${arm}-leg${leg + 1}.heapprofile`), JSON.stringify(profile));
        }
        reports[arm].push(report);
        injected[arm] = report.detailWorkerFault ?? injected[arm];
        const summary = summarize([report], 0);
        log(`leg ${leg + 1} ${arm}: ${(report.elapsedMs / 1000).toFixed(0)} s, render p50 ${fmt(summary.renderMs.p50)} max ${fmt(summary.renderMs.max)} ms, `
          + `between p50 ${fmt(summary.betweenMs.p50)} max ${fmt(summary.betweenMs.max)} ms, `
          + `${summary.pipelinesCreated} pipelines, ${fmt(summary.allocatedKiBPerFrame, 0)} KiB/frame, `
          + `pending pages ${report.pendingTerrainPages}, detail ${report.pendingDetailWork}`
          + (report.detailWorkerFault
            ? `, detail worker ${report.detailWorkerFault.kind === "kill" ? "killed" : "hung"} at frame `
              + `${report.detailWorkerFault.frame}${report.detailWorkerFault.delivered ? "" : " (no worker to fail)"}`
            : "")
          + describeDetailWorker(report.detailWorker, report.detailWatchdog, injected[arm])
          + describeLegBakes(report));
        for (const line of describeLegPipelines(report)) log(`leg ${leg + 1} ${arm}: ${line}`);
      }
      writeFileSync(join(outDir, "progress.json"), JSON.stringify(reports));
    }

    // Each trial is a new renderer in each arm, so a worker lost in one
    // trial cannot leave the next with nothing to trip; both arms settle at
    // once, the contention of the stream to rest.
    const trials: SettleTrial[] = [];
    if (settleTrials > 0) {
      const starts = await arms.head.call("landStarts", settleTrials);
      log(`settle trials at ${starts.map((point) => `(${fmt(point.x, 0)}, ${fmt(point.z, 0)})`).join(", ")}`);
      for (const [index, point] of starts.entries()) {
        await Promise.all(ARMS.map((arm) => arms[arm].call("prepareShot", {
          shot, canonicalShotIndex, renderScale: null, openFrames: 2, freshRenderer: true,
        })));
        const [base, head] = await Promise.all(ARMS.map((arm) => arms[arm].call("flight", {
          ...request,
          frames: trialFrames,
          restart: true,
          // Held still and level: a bank would turn it on the spot.
          speedMetersPerSecond: 0,
          bankDegrees: 0,
          start: { x: point.x, z: point.z, yawDegrees: point.yawDegrees },
        })));
        trials.push({ start: point, base: base!, head: head! });
        for (const [arm, report] of [["base", base!], ["head", head!]] as const) {
          log(`trial ${index + 1} ${arm}: ${(report.elapsedMs / 1000).toFixed(0)} s, `
            + `render p50 ${fmt(summarize([report], 0).renderMs.p50)} ms, detail ${report.pendingDetailWork}`
            + describeDetailWorker(report.detailWorker, report.detailWatchdog)
            + describeLegBakes(report));
        }
        writeFileSync(join(outDir, "progress-trials.json"), JSON.stringify(trials));
      }
    }

    const summaries = { base: summarize(reports.base, 1), head: summarize(reports.head, 1) };
    const firstLeg = { base: summarize(reports.base.slice(0, 1), 0), head: summarize(reports.head.slice(0, 1), 0) };
    const settings = {
      shot: shot.name, legs, legFrames, speed: request.speedMetersPerSecond, clearance: request.clearanceMeters,
      bank: request.bankDegrees, camera, weather: values.weather, quality: values.quality, mode: values.mode,
      aircraft: values.aircraft,
      draws: !request.suppressDraws, backend,
      gameTerrainHeight: "requested; a build without FlightRendererOptions.terrainHeight ignores it",
      ...(start ? { start } : {}),
      ...(faults.kill ? { killDetailWorker: faults.kill } : {}),
      ...(faults.hang ? { hangDetailWorker: faults.hang } : {}),
      ...(settleTrials > 0 ? { settleTrials, trialFrames } : {}),
      ...(values["burst-legs"] ? { burstLegs: "250 and 60 m/s, alternating" } : {}),
      ...(values["park-legs"] ? { parkLegs: "0 m/s on odd legs" } : {}),
      ...(pitchDown > 0 ? { pitchDown: `${pitchDown} deg on legs 2, 4, ...; level on legs 1, 3, ...` } : {}),
      ...(hitch ? { emulateHitch: hitch } : {}),
      ...(frameDump ? { frameDump } : {}),
      ...(worldOptions.base ? { baseWorld: worldOptions.base } : {}),
      ...(worldOptions.head ? { headWorld: worldOptions.head } : {}),
    };
    const verdict = flightVerdict({ identity, shas, settle, reports, settleTrials: trials });
    const { bakes, markdown: bakeMarkdown } = bakeSection({ shas, reports, settleTrials: trials });
    const markdown = `${renderMarkdown(identity, settings, summaries, firstLeg)}\n${renderPipelineMarkdown(reports)}`
      + `\n${renderVerdictMarkdown(verdict)}\n${bakeMarkdown}`;
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({ identity, shas, settings, summaries, firstLeg, settle, reports, settleTrials: trials, verdict, bakes }, null, 1),
    );
    writeFileSync(join(outDir, "report.md"), markdown);
    console.log(`\n${markdown}`);
    log(`report: ${join(outDir, "report.md")}`);
    if (values["fail-on-worker-fallback"] && workerFallbackExitCode(verdict, underTestSha) !== 0) {
      log(`FAIL: the vegetation worker's watchdog tripped in the arm built from ${underTestSha.slice(0, 10)}`);
      return 1;
    }
    return 0;
  } finally {
    for (const arm of opened) await arm.close().catch(() => undefined);
    for (const server of servers) await server.close().catch(() => undefined);
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
