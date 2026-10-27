/// <reference types="vite/client" />
/**
 * The cloud A/B agent: one FlightRenderer in one page, stepped by
 * `scripts/perf-ab.mts` over Playwright (docs/PERFORMANCE.md, "Cloud A/B").
 *
 * The orchestrator builds this page twice — from the base commit and from the
 * head — with the harness files (this directory, `tests/perf/gpu*.ts`,
 * `tests/perf/shotPlacement.ts`) copied into both from the checkout that runs
 * it, so the two arms differ only in the code under test. Each arm loads into
 * a browser of its own (`AgentArm` in `scripts/perfAbHarness.mts` says why) and
 * the orchestrator alternates frames between them; a page never renders while
 * the other is being measured.
 *
 * A shot is rendered the way `tests/perf/perf-capture.test.ts` renders it: the
 * same seed, renderer options, viewport, render scale, clock, placement, pose,
 * camera, time pin and ocean/wildlife pins. Three things differ, each because
 * the cloud adapter is a CPU, where one frame of a shot costs seconds:
 *  1. streaming runs with the frame's own draws dropped (`gpuDrawGate.ts`),
 *     after a few ordinary frames so the shot's bakes happen with draws;
 *  2. the settle is a dozen frames, not 150: it is there to rebuild temporal
 *     history for the pixels, and what a frame costs does not depend on that
 *     history;
 *  3. every frame is stepped by the orchestrator and fenced to GPU idle, not
 *     paced by rAF, so no frame's work can overlap another's — or the other
 *     arm's.
 *
 * Everything the renderer exposes only for captures is reached through
 * `capability()`, so a base that predates one fails with its name rather than
 * with `undefined is not a function` halfway through a shot.
 */

import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Logger } from "@babylonjs/core/Misc/logger";
import { FlightRenderer } from "../../../src/render/FlightRenderer";
import { PERF_COCKPIT_RIG } from "../../../src/render/cameraPresentation";
import { WebGpuFrameGraph, type FrameGraphPass } from "../../../src/render/webgpu/core/FrameGraph";
import * as qualityProfile from "../../../src/render/webgpu/core/QualityProfile";
import { WEATHER_PROFILES, sunDirectionForClock } from "../../../src/render/webgpu/nature/EnvironmentDirector";
import {
  INITIAL_VISUAL_STATE,
  type FlightVisualState,
  type QualityLevel,
  type WeatherPreset,
} from "../../../src/game/types";
import type { RenderingMode } from "../../../src/settings";
import { AIRCRAFT_KINDS } from "../../../src/sim";
import { createWorld, sampleTerrain, sampleTerrainHeight } from "../../../src/world";
import type { WorldDefinition } from "../../../src/world/types";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
  luminanceFromRgba,
  meanRgbSsim,
  meanSsim,
  orientationFromYawPitchBank,
  worstTileRgbSsim,
  yawForSunBearing,
  type PerfCaptureShotDefinition,
} from "../../../scripts/perf-capture.mts";
import {
  gpuDrawGateStats,
  installGpuDrawGate,
  markGpuDrawGateFrame,
  resetGpuDrawGateStats,
  setGpuDrawsSuppressed,
} from "../gpuDrawGate";
import { setGpuPassLabelDecorator } from "../gpuPassLabels";
import { armGpuPassTiming, collectGpuPassTiming, installGpuPassTiming } from "../gpuPassTiming";
import { beginGpuWorkWindow, endGpuWorkWindow, installGpuWorkCounters } from "../gpuWorkCounters";
import { resolveShotPlacement } from "../shotPlacement";
import { FlightBakeProbe, readBakeStats } from "./bakeProbe";
import { DetailWatchdogProbe, type DetailWatchdogSample } from "./detailWatchdog";
import { renderAfterHitch } from "./flightHitch";
import { agentTerrainSamplers } from "./terrainSamplers";
import {
  PERF_AB_PROTOCOL,
  type AgentCatalog,
  type AgentConfig,
  type AgentErrors,
  type AgentInfo,
  type CaptureResult,
  type DetailWatchdogReport,
  type DetailWorkerFault,
  type DetailWorkerState,
  type FlightFrame,
  type FlightReport,
  type FlightRequest,
  type FrameSample,
  type LandStart,
  type ImageComparison,
  type PerfAgent,
  type PrepareReport,
  type PrepareRequest,
  type SettleReport,
  type SettleRequest,
  type ShotDiagnostics,
  type StreamReport,
  type StreamRequest,
} from "./protocol";

type WorldEvolution = "analytic" | "eroded";

interface ShotContext {
  readonly shot: PerfCaptureShotDefinition;
  readonly canonicalShotIndex: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly state: FlightVisualState;
  readonly yawDegrees: number;
  readonly altitude: number;
  motionYawDegrees: number;
  motionX: number;
  motionZ: number;
  lastFrameState: FlightVisualState;
}

const errors = { console: [] as string[], logger: [] as string[], gpu: [] as string[], page: [] as string[] };
const creations = { pipelines: 0, shaderModules: 0, shaderCodeChars: 0 };
/**
 * What asked for each render pipeline, in creation order
 * (`describePipelineSource`): a measured frame reads its own slice.
 */
const pipelineSources: string[] = [];
/** The frame-graph pass executing now, and the mesh Babylon is drawing (`installRenderingMeshNames`). */
let graphPass: string | null = null;
let renderingMesh: string | null = null;

let config: AgentConfig | null = null;
let world: WorldDefinition | null = null;
let activeWorldEvolution: WorldEvolution | null = null;
/** The forced climate province and landforms of the current world, as JSON; null is the natural world. */
let activeForcedKey: string | null = null;
let canvas: HTMLCanvasElement | null = null;
let renderer: FlightRenderer | null = null;
let removeGpuErrorListener: (() => void) | null = null;
/** `render()` calls on the current renderer: its frame index, which keys every cadence. */
let renderCalls = 0;
let simulationTime = 0;
let context: ShotContext | null = null;

function nextAnimationFrame(): Promise<void> {
  // A frame is seconds of GPU work here, and rAF stalls when the page is not
  // being composited; never wait on it for more than a second.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function yieldToTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function requireRenderer(): FlightRenderer {
  if (!renderer) throw new Error("perf-ab agent: no renderer; prepareShot() first");
  return renderer;
}

function requireContext(): ShotContext {
  if (!context) throw new Error("perf-ab agent: no shot; prepareShot() first");
  return context;
}

/** A capture-only renderer method, by name, or a refusal that names it. */
function capability<Name extends keyof FlightRenderer>(name: Name): FlightRenderer[Name] {
  const target = requireRenderer();
  const value = target[name];
  if (typeof value !== "function") {
    throw new Error(
      `perf-ab agent: this build's FlightRenderer has no ${String(name)}(). The base predates `
      + "the capture API the A/B needs; choose a newer base.",
    );
  }
  return (value as (...args: unknown[]) => unknown).bind(target) as FlightRenderer[Name];
}

/**
 * Keys every GPU pass by what drew it: the frame-graph pass executing when the
 * pass began, then Babylon's render-target label or the dispatching compute
 * shader's name (Babylon labels no compute pass). Without this the main
 * scene's passes are all `PostProcessRTT-bloom-bright`, which is the texture
 * they draw into, and every compute pass is unlabelled.
 */
function installRendererPassNames(): void {
  let computeShader: string | null = null;
  const graph = WebGpuFrameGraph.prototype as unknown as {
    register?: (this: WebGpuFrameGraph, pass: FrameGraphPass) => () => void;
  };
  const register = graph.register;
  if (typeof register === "function") {
    graph.register = function (this: WebGpuFrameGraph, pass: FrameGraphPass) {
      const named = new Proxy(pass, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "execute" && typeof value === "function") {
            return (frame: unknown) => {
              const outer = graphPass;
              graphPass = target.name;
              try {
                return (value as (frame: unknown) => unknown).call(target, frame);
              } finally {
                graphPass = outer;
              }
            };
          }
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
      return register.call(this, named);
    };
  }
  const shader = ComputeShader.prototype as unknown as Record<string, unknown>;
  for (const method of ["dispatch", "dispatchIndirect"]) {
    const original = shader[method];
    if (typeof original !== "function") continue;
    shader[method] = function (this: ComputeShader, ...args: unknown[]) {
      const outer = computeShader;
      computeShader = this.name;
      try {
        return (original as (...args: unknown[]) => unknown).apply(this, args);
      } finally {
        computeShader = outer;
      }
    };
  }
  setGpuPassLabelDecorator((label, kind) => {
    const scope = graphPass ?? "(outside frame graph)";
    return `${scope} › ${kind === "compute" ? (computeShader ?? label) : label}`;
  });
}

/**
 * Names the mesh (and its material) whose draw is being encoded, for every
 * pass that draws meshes: the scene's own render, shadow maps and render
 * targets all go through `Mesh._processRendering`. A pipeline created inside
 * one is that mesh's pipeline in that pass.
 */
function installRenderingMeshNames(): void {
  const prototype = Mesh.prototype as unknown as Record<string, unknown>;
  const original = prototype["_processRendering"];
  if (typeof original !== "function") return;
  prototype["_processRendering"] = function (this: Mesh, ...args: unknown[]) {
    const outer = renderingMesh;
    const subMesh = args[1] as { getMaterial?: () => { name?: string } | null } | undefined;
    const material = (args[7] as { name?: string } | undefined) ?? subMesh?.getMaterial?.() ?? null;
    renderingMesh = material?.name ? `${this.name} (${material.name})` : this.name;
    try {
      return (original as (...input: unknown[]) => unknown).apply(this, args);
    } finally {
      renderingMesh = outer;
    }
  };
}

/** The Babylon render pass (main, a shadow generator's, a render target's) the engine is encoding. */
function currentRenderPassName(): string {
  const engine = renderer
    ? ((renderer as unknown as { scene?: { getEngine(): unknown } }).scene?.getEngine() as
      | { currentRenderPassId?: number; _renderPassNames?: readonly (string | undefined)[] }
      | undefined)
    : undefined;
  const id = engine?.currentRenderPassId;
  if (id === undefined) return "?";
  return engine?._renderPassNames?.[id] ?? `pass ${id}`;
}

/**
 * One render pipeline's origin: the frame-graph pass, Babylon's render pass,
 * the mesh and material, and the pipeline's formats (Babylon's label).
 */
function describePipelineSource(method: string, descriptor: { readonly label?: string } | undefined): string {
  return [
    method.endsWith("Async") ? "async" : null,
    graphPass ?? "(outside frame graph)",
    currentRenderPassName(),
    renderingMesh ?? "(no mesh)",
    descriptor?.label ? `[${descriptor.label}]` : null,
  ].filter((part) => part !== null).join(" › ");
}

/** Counts pipeline and shader-module creation all the time: a measured frame should create none. */
function installCreationCounts(): void {
  const device = (globalThis as unknown as { GPUDevice?: { prototype: Record<string, unknown> } }).GPUDevice;
  if (!device) return;
  const count = (name: string, field: keyof typeof creations) => {
    const original = device.prototype[name];
    if (typeof original !== "function") return;
    device.prototype[name] = function (this: unknown, ...args: unknown[]) {
      creations[field] += 1;
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    };
  };
  count("createRenderPipeline", "pipelines");
  count("createRenderPipelineAsync", "pipelines");
  count("createComputePipeline", "pipelines");
  count("createComputePipelineAsync", "pipelines");
  count("createShaderModule", "shaderModules");
  for (const name of ["createRenderPipeline", "createRenderPipelineAsync"]) {
    const original = device.prototype[name];
    if (typeof original !== "function") continue;
    device.prototype[name] = function (this: unknown, descriptor: { label?: string } | undefined) {
      if (pipelineSources.length < 10_000) pipelineSources.push(describePipelineSource(name, descriptor));
      return (original as (descriptor: unknown) => unknown).call(this, descriptor);
    };
  }
  const createShaderModule = device.prototype.createShaderModule;
  if (typeof createShaderModule === "function") {
    device.prototype.createShaderModule = function (this: unknown, descriptor: { code?: string }) {
      creations.shaderCodeChars += descriptor?.code?.length ?? 0;
      return (createShaderModule as (descriptor: unknown) => unknown).call(this, descriptor);
    };
  }
}

/** Main-thread tasks over 50 ms, from installation on: a flight leg reads its own window. */
const longTasks: { start: number; duration: number }[] = [];

function installLongTaskObserver(): void {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (longTasks.length < 10_000) longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: false });
  } catch {
    // No Long Tasks API: the leg reports none.
  }
}

/** The JS heap in bytes; exact only with `--enable-precise-memory-info`. */
function heapUsedBytes(): number {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory?.usedJSHeapSize ?? Number.NaN;
}

/** The frame graph's per-pass main-thread times for the last frame; private, so read loosely. */
function graphPassTimings(target: FlightRenderer): readonly { name: string; cpuMilliseconds: number; ran: boolean }[] {
  const graph = (target as unknown as { graph?: { passTimings?: unknown } }).graph;
  const timings = graph?.passTimings;
  return Array.isArray(timings) ? timings : [];
}

/**
 * Draws skipped so far for a pipeline compiling off the frame; undefined from
 * a build without `getPipelineCompileStatsForCapture` (read loosely: the arm's
 * own build is read with this branch's agent).
 */
function deferredDrawCount(target: FlightRenderer): number | undefined {
  const read = (target as unknown as { getPipelineCompileStatsForCapture?: () => unknown }).getPipelineCompileStatsForCapture;
  const deferred = (read?.call(target) as { deferredDraws?: unknown } | null | undefined)?.deferredDraws;
  return typeof deferred === "number" ? deferred : undefined;
}

/**
 * Effects (material x defines) the engine compiles, each named by its shader
 * and by the defines that set it apart from the nearest effect of that shader
 * compiled before it: what a mid-flight pipeline compile is FOR.
 */
const effectsCompiled: string[] = [];
const knownEffectDefines = new Map<string, Set<string>[]>();

function effectDefineLines(defines: string): Set<string> {
  return new Set(defines.split("\n").map((line) => line.trim()).filter((line) => line.length > 0));
}

function effectShaderName(baseName: unknown): string {
  const named = baseName as Record<string, unknown> | null | undefined;
  const raw = typeof baseName === "string"
    ? baseName
    : String(named?.["vertexToken"] ?? named?.["vertex"] ?? named?.["vertexSource"] ?? "?");
  return raw.length > 48 ? `${raw.slice(0, 48).replace(/\s+/g, " ")}...` : raw;
}

function rememberEffect(shader: string, lines: Set<string>): void {
  const known = knownEffectDefines.get(shader) ?? [];
  known.push(lines);
  knownEffectDefines.set(shader, known);
}

function describeNewEffect(shader: string, defines: string): string {
  const lines = effectDefineLines(defines);
  const known = knownEffectDefines.get(shader) ?? [];
  let best: { added: string[]; removed: string[] } | null = null;
  for (const other of known) {
    const added = [...lines].filter((line) => !other.has(line));
    const removed = [...other].filter((line) => !lines.has(line));
    if (!best || added.length + removed.length < best.added.length + best.removed.length) best = { added, removed };
  }
  rememberEffect(shader, lines);
  if (!best) return `${shader} (its first effect)`;
  const list = (prefix: string, entries: string[]) => entries.slice(0, 6).map((line) => `${prefix}${line}`)
    .concat(entries.length > 6 ? [`${prefix}${entries.length - 6} more`] : []);
  return `${shader}: ${[...list("+", best.added), ...list("-", best.removed)].join(" ")}`;
}

function installEffectRecorder(target: FlightRenderer): void {
  const engine = (target as unknown as { scene?: { getEngine(): unknown } }).scene?.getEngine() as
    | {
      createEffect: (...args: unknown[]) => unknown;
      __effectRecorder?: boolean;
      _compiledEffects?: Record<string, { name?: unknown; defines?: unknown }>;
    }
    | undefined;
  if (!engine || engine.__effectRecorder) return;
  engine.__effectRecorder = true;
  const original = engine.createEffect;
  const seen = new WeakSet<object>();
  // The effects the renderer compiled while it loaded. The engine hands an
  // existing effect back for the same shader and defines, so without these a
  // load-time effect a mesh first asks for in flight would read as a compile,
  // and a real new variant would be told apart from the wrong neighbour.
  for (const effect of Object.values(engine._compiledEffects ?? {})) {
    seen.add(effect);
    rememberEffect(effectShaderName(effect.name), effectDefineLines(String(effect.defines ?? "")));
  }
  engine.createEffect = function (this: unknown, ...args: unknown[]) {
    const effect = original.apply(this, args) as object;
    if (effect && !seen.has(effect)) {
      seen.add(effect);
      const [baseName, options, , , defines] = args as [
        unknown,
        { defines?: unknown } | undefined,
        unknown,
        unknown,
        unknown,
      ];
      effectsCompiled.push(describeNewEffect(effectShaderName(baseName), String(defines ?? options?.defines ?? "")));
    }
    return effect;
  };
}

/**
 * The vegetation runtime's private state, read loosely: this agent runs in
 * both arms, and a base predates the fields a head adds (each optional here).
 */
interface DetailRuntimeInternals {
  readonly client?: object | null;
  readonly updateSequence?: number;
  readonly presentationNowMilliseconds?: () => number;
  readonly lastUpdateMilliseconds?: number | null;
  readonly workerPresentationProgressUpdate?: number | null;
  readonly workerPresentationProgressMilliseconds?: number | null;
  readonly workerGenerationProgressUpdate?: number | null;
  readonly workerGenerationProgressMilliseconds?: number | null;
  readonly workerGenerationAnswered?: boolean;
  readonly presentationWorkerHeartbeats?: number;
  readonly pendingPresentationBuild?: { readonly source?: string; readonly buildId?: number } | null;
  readonly presentationWorkerBuildTimeouts?: number;
  readonly presentationBuildCancellations?: number;
  readonly workerHealth?: { readonly active: boolean };
  readonly presentationRebuildDiagnostics?: {
    readonly workerFallbacks: number;
    readonly workerGenerationTimeouts: number;
    readonly workerBuildTimeouts: number;
    readonly workerBuildRejections: number;
    readonly workerRespawns?: number;
    readonly workerPresentationHeartbeats?: number;
    readonly workerMaxSilenceMilliseconds?: number;
    readonly workerBuildMaxLatencyMilliseconds?: number;
    readonly workerConvergenceStalls?: number;
  };
}

function detailRuntime(target: FlightRenderer): DetailRuntimeInternals | null {
  return (target as unknown as { readonly detail?: DetailRuntimeInternals }).detail ?? null;
}

/**
 * Whether vegetation cells are generated on the detail worker or, after a
 * fallback, inline on the main thread, and what its watchdogs have counted.
 * Walks the runtime's cells (`presentationRebuildDiagnostics`): once per
 * stream or leg, never per frame.
 */
function detailWorkerState(target: FlightRenderer): DetailWorkerState | null {
  const detail = detailRuntime(target);
  const diagnostics = detail?.presentationRebuildDiagnostics;
  if (!detail || !diagnostics) return null;
  const {
    workerRespawns: respawns,
    workerPresentationHeartbeats: heartbeats,
    workerMaxSilenceMilliseconds: maxSilenceMs,
    workerBuildMaxLatencyMilliseconds: buildMaxLatencyMs,
    workerConvergenceStalls: convergenceStalls,
  } = diagnostics;
  // A runtime that restarts a failed worker has no client from the failure
  // until its next update builds the replacement; its own `workerHealth`
  // counts that worker as active, with the restart pending.
  const health = detail.workerHealth;
  return {
    active: health?.active ?? detail.client !== null,
    fallbacks: diagnostics.workerFallbacks,
    generationTimeouts: diagnostics.workerGenerationTimeouts,
    buildTimeouts: diagnostics.workerBuildTimeouts,
    buildRejections: diagnostics.workerBuildRejections,
    ...(respawns !== undefined ? { respawns } : {}),
    ...(health ? { respawnPending: health.active && detail.client === null } : {}),
    ...(heartbeats !== undefined ? { heartbeats } : {}),
    ...(maxSilenceMs !== undefined ? { maxSilenceMs } : {}),
    ...(buildMaxLatencyMs !== undefined ? { buildMaxLatencyMs } : {}),
    ...(convergenceStalls !== undefined ? { convergenceStalls } : {}),
  };
}

/**
 * The runtime's watchdog clocks after a frame: a few field reads, cheap
 * enough for every frame (`detailWatchdog.ts` says what is made of them).
 */
function detailWatchdogSample(detail: DetailRuntimeInternals): DetailWatchdogSample {
  const build = detail.pendingPresentationBuild;
  return {
    wallMs: performance.now(),
    nowMs: detail.presentationNowMilliseconds?.() ?? performance.now(),
    lastUpdateMs: detail.lastUpdateMilliseconds ?? null,
    updateSequence: detail.updateSequence ?? 0,
    presentationUpdate: detail.workerPresentationProgressUpdate ?? null,
    presentationMs: detail.workerPresentationProgressMilliseconds ?? null,
    generationUpdate: detail.workerGenerationProgressUpdate ?? null,
    generationMs: detail.workerGenerationProgressMilliseconds ?? null,
    generationAnswered: detail.workerGenerationAnswered ?? false,
    heartbeats: detail.presentationWorkerHeartbeats ?? null,
    workerBuildId: build?.source === "worker" ? build.buildId ?? null : null,
    client: detail.client ?? null,
    buildTimeouts: detail.presentationWorkerBuildTimeouts ?? 0,
    cancellations: detail.presentationBuildCancellations ?? 0,
  };
}

/** The probe of the current renderer's runtime; a new renderer gets a new one. */
let watchdogProbe: { readonly detail: DetailRuntimeInternals; readonly probe: DetailWatchdogProbe } | null = null;

/**
 * Starts a watchdog window (a stream or a leg) on `target`; the returned
 * function samples one frame. Null for a build with no detail runtime.
 */
function beginDetailWatchdogWindow(target: FlightRenderer): (() => void) | null {
  const detail = detailRuntime(target);
  if (!detail) return null;
  if (watchdogProbe?.detail !== detail) watchdogProbe = { detail, probe: new DetailWatchdogProbe() };
  const { probe } = watchdogProbe;
  probe.beginWindow(performance.now());
  return () => probe.observe(detailWatchdogSample(detail));
}

function detailWatchdogReport(target: FlightRenderer): DetailWatchdogReport | null {
  return watchdogProbe && watchdogProbe.detail === detailRuntime(target) ? watchdogProbe.probe.report() : null;
}

/**
 * Fails the detail worker on purpose, in either arm: "kill" fires an error
 * event at the generation client's private Worker (the path a crashed worker
 * script takes), "hang" terminates it without one (a worker gone silent).
 */
function failDetailWorker(target: FlightRenderer, kind: DetailWorkerFault["kind"], frame: number): DetailWorkerFault {
  const before = detailWorkerState(target);
  const client = detailRuntime(target)?.client as { readonly worker?: Worker | null } | null | undefined;
  const worker = client?.worker ?? null;
  if (worker && kind === "kill") {
    worker.dispatchEvent(new ErrorEvent("error", { message: "perf-flight: the detail worker was killed" }));
  } else if (worker) {
    worker.terminate();
  }
  return { kind, frame, delivered: worker !== null, before };
}

/** Where the scripted flight is; legs continue from it. */
interface FlightPath {
  x: number;
  z: number;
  yawDegrees: number;
  altitude: number;
  /** The nose's attitude below the horizon, moving toward each leg's `pitchDownDegrees`. */
  pitchDownDegrees: number;
}

/** How fast the scripted nose moves toward a leg's pitch: a firm push on the stick. */
const FLIGHT_PITCH_RATE_DEGREES_PER_SECOND = 30;

let flightPath: FlightPath | null = null;

function installErrorChannels(): void {
  // As the capture does (Z-1): a renderer error is a failed run, not a log
  // line. Babylon's Logger holds its own console reference from module load.
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.console.push(args.map((value) => String(value)).join(" "));
    originalConsoleError.apply(console, args as []);
  };
  const originalLoggerError = Logger.Error;
  Logger.Error = ((message: string | unknown[], limit?: number) => {
    errors.logger.push(Array.isArray(message) ? message.join(" ") : String(message));
    originalLoggerError.call(Logger, message as string, limit);
  }) as typeof Logger.Error;
  window.addEventListener("error", (event) => errors.page.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) => errors.page.push(String(event.reason)));
}

function createCanvas(): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = PERF_CAPTURE_WIDTH;
  element.height = PERF_CAPTURE_HEIGHT;
  element.style.width = `${PERF_CAPTURE_WIDTH}px`;
  element.style.height = `${PERF_CAPTURE_HEIGHT}px`;
  document.body.appendChild(element);
  return element;
}

async function ensureRenderer(
  worldEvolution: WorldEvolution,
  climateProvince: PerfCaptureShotDefinition["climateProvince"],
  landforms: PerfCaptureShotDefinition["landforms"],
  fresh = false,
): Promise<void> {
  if (!config) throw new Error("perf-ab agent: configure() first");
  const forcedKey = climateProvince === undefined && landforms === undefined
    ? null
    : JSON.stringify({ climateProvince: climateProvince ?? null, landforms: landforms ?? null });
  if (!fresh && renderer && activeWorldEvolution === worldEvolution && activeForcedKey === forcedKey) return;
  // As the capture's W-7 swap: dispose fully BEFORE creating, so two worlds
  // are never resident at once.
  removeGpuErrorListener?.();
  removeGpuErrorListener = null;
  renderer?.dispose();
  renderer = null;
  // The probe holds the old runtime, and through it the old world.
  watchdogProbe = null;
  canvas?.remove();
  world = createWorld(PERF_CAPTURE_SEED, {
    ...(config.worldOptions ?? {}),
    worldEvolution,
    ...(climateProvince === undefined ? {} : { climateProvince }),
    ...(landforms === undefined ? {} : { landforms }),
  } as Parameters<typeof createWorld>[1]);
  // A base that predates climate provinces ignores the option and would
  // render the temperate world: fail the shot rather than compare the wrong
  // worlds. The option reads back as the forced offsets when honoured.
  if (climateProvince !== undefined && !world.climateProvince) {
    throw new Error("perf-ab agent: this build's createWorld ignores climateProvince; the arm predates climate provinces");
  }
  canvas = createCanvas();
  const activeWorld = world;
  const profile = qualityProfile.resolveWebGpuQualityProfile(
    config.quality as QualityLevel,
    config.renderingMode as RenderingMode,
  );
  renderer = await FlightRenderer.create({
    canvas,
    aircraft: config.aircraft as (typeof AIRCRAFT_KINDS)[number],
    // The full sample; with it, for perf:flight alone, the height-only
    // sampler FlightGame passes (`terrainSamplers.ts`).
    ...agentTerrainSamplers(activeWorld, config.gameTerrainHeight, sampleTerrain, sampleTerrainHeight),
    world: activeWorld,
    seed: activeWorld.sourceSeedHash,
    quality: config.quality as QualityLevel,
    renderingMode: config.renderingMode as RenderingMode,
    reducedMotion: false,
    pinnedRenderScale: profile.renderScale,
    // The capture's rig, for the same reason: the cockpit shots were placed
    // for it (tests/render.cockpit-rig.test.ts lists the callers).
    cockpitRigOverride: PERF_COCKPIT_RIG,
    ...(activeWorld.airport ? { runway: activeWorld.airport } : {}),
  });
  activeWorldEvolution = worldEvolution;
  activeForcedKey = forcedKey;
  installEffectRecorder(renderer);
  renderCalls = 0;
  removeGpuErrorListener = capability("addGpuUncapturedErrorListenerForCapture")((event) => {
    errors.gpu.push(JSON.stringify({ type: event.error.constructor?.name || "GPUError", message: event.error.message }));
  });
}

/**
 * One frame: the gate's frame boundary, then the renderer. After an emulated
 * hitch of `hitchMilliseconds` (flight legs only), with the delta FlightGame
 * would hand it (`flightHitch.ts`).
 */
function renderFrame(state: FlightVisualState, hitchMilliseconds: number | null = null): void {
  markGpuDrawGateFrame();
  if (hitchMilliseconds === null) requireRenderer().render(state, 1 / 60);
  else renderAfterHitch(requireRenderer(), state, hitchMilliseconds);
  renderCalls += 1;
}

/** As the capture's `advanceFrameState`: static shots hold the pose, motion shots fly the banked turn. */
function advanceFrameState(shot: ShotContext): FlightVisualState {
  simulationTime += 1 / 60;
  let frameState: FlightVisualState = { ...shot.state, simulationTime };
  if (shot.shot.kind === "motion") {
    const bankDegrees = shot.shot.bankDegrees ?? 0;
    const turnRateRadPerSecond = (9.81 * Math.tan((bankDegrees * Math.PI) / 180))
      / Math.max(20, shot.shot.airspeedMetersPerSecond);
    shot.motionYawDegrees += (turnRateRadPerSecond * (180 / Math.PI)) / 60;
    const motionHeading = headingVectorFromYaw(shot.motionYawDegrees);
    shot.motionX += (shot.shot.airspeedMetersPerSecond * motionHeading.x) / 60;
    shot.motionZ += (shot.shot.airspeedMetersPerSecond * motionHeading.z) / 60;
    frameState = {
      ...frameState,
      position: { x: shot.motionX, y: shot.altitude, z: shot.motionZ },
      velocity: {
        x: shot.shot.airspeedMetersPerSecond * motionHeading.x,
        y: 0,
        z: shot.shot.airspeedMetersPerSecond * motionHeading.z,
      },
      orientation: orientationFromYawPitchBank(
        shot.motionYawDegrees,
        shot.shot.pitchDownDegrees,
        bankDegrees,
      ),
    };
  }
  shot.lastFrameState = frameState;
  return frameState;
}

function shotDiagnostics(): ShotDiagnostics {
  const diagnostics = requireRenderer().getDiagnostics();
  // The reasons partition the wanted set, one reason a page. An older base
  // build reports none.
  const reasons: { drawn: number; parent: number; collision: number; seed: number } | undefined =
    diagnostics.residencyReasons;
  return {
    drawCalls: diagnostics.drawCalls,
    triangles: diagnostics.triangles,
    visibleInstances: diagnostics.visibleInstances,
    vegetationBatches: diagnostics.vegetationBatches,
    residentTerrainPages: diagnostics.residentTerrainPages,
    wantedTerrainPages: reasons ? reasons.drawn + reasons.parent + reasons.collision + reasons.seed : -1,
    renderPixels: diagnostics.renderPixels,
    inventoriedGpuMemoryMiB: diagnostics.inventoriedGpuMemoryMiB,
    estimatedGpuMemoryMiB: diagnostics.estimatedGpuMemoryMiB,
  };
}

async function decodePng(base64: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("perf-ab agent: a PNG did not decode"));
    image.src = `data:image/png;base64,${base64}`;
  });
  if (image.naturalWidth !== width || image.naturalHeight !== height) {
    throw new Error(
      `perf-ab agent: a ${image.naturalWidth}x${image.naturalHeight} image cannot be compared at ${width}x${height}`,
    );
  }
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const context2d = surface.getContext("2d", { willReadFrequently: true })!;
  context2d.drawImage(image, 0, 0);
  return context2d.getImageData(0, 0, width, height).data;
}

const agent: PerfAgent = {
  protocol: PERF_AB_PROTOCOL,

  async info(): Promise<AgentInfo> {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    return {
      protocol: PERF_AB_PROTOCOL,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      adapter: {
        vendor: adapter?.info.vendor ?? "",
        architecture: adapter?.info.architecture ?? "",
        device: adapter?.info.device ?? "",
        description: adapter?.info.description ?? "",
      },
      timestampQuery: adapter?.features.has("timestamp-query") ?? false,
    };
  },

  catalog(): AgentCatalog {
    return {
      shots: PERF_CAPTURE_SHOTS,
      inventoriedMemoryCeilingMiB: PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB,
    };
  },

  configure(next: AgentConfig): void {
    if (config) throw new Error("perf-ab agent: configure() runs once per page");
    if (!(AIRCRAFT_KINDS as readonly string[]).includes(next.aircraft)) {
      throw new Error(`perf-ab agent: "${next.aircraft}" is not one of ${AIRCRAFT_KINDS.join(", ")}`);
    }
    if (next.weather != null && !Object.hasOwn(WEATHER_PROFILES, next.weather)) {
      throw new Error(`perf-ab agent: "${next.weather}" is not one of ${Object.keys(WEATHER_PROFILES).join(", ")}`);
    }
    config = next;
    installErrorChannels();
    // Order matters: the gate wraps the counters, so a dropped draw is never
    // counted, and the timing must patch requestDevice before the renderer
    // asks for its device.
    installGpuWorkCounters();
    installGpuPassTiming();
    installGpuDrawGate();
    installRendererPassNames();
    installRenderingMeshNames();
    installCreationCounts();
    installLongTaskObserver();
    if (next.profileOverride) {
      // The capture's VITE_PERF_PROFILE_OVERRIDE: set before the renderer
      // exists, so every profile resolution sees it.
      const setOverride = (qualityProfile as Record<string, unknown>)
        .__setProfileOverrideForCaptureExperimentsOnly;
      if (typeof setOverride !== "function") {
        throw new Error("perf-ab agent: this build has no profile override; a positive control cannot run");
      }
      (setOverride as (override: Record<string, unknown>) => void)({ ...next.profileOverride });
    }
  },

  async prepareShot(request: PrepareRequest): Promise<PrepareReport> {
    const started = performance.now();
    const { shot } = request;
    await ensureRenderer(shot.worldEvolution ?? "analytic", shot.climateProvince, shot.landforms, request.freshRenderer);
    const active = requireRenderer();
    const activeWorld = world!;
    const viewportWidth = shot.viewportWidth ?? PERF_CAPTURE_WIDTH;
    const viewportHeight = shot.viewportHeight ?? PERF_CAPTURE_HEIGHT;
    if (canvas!.style.width !== `${viewportWidth}px` || canvas!.style.height !== `${viewportHeight}px`) {
      // CSS only, as the capture: Babylon owns the backing store once hardware
      // scaling is active, and the renderer's ResizeObserver resizes every
      // attachment coherently.
      canvas!.style.width = `${viewportWidth}px`;
      canvas!.style.height = `${viewportHeight}px`;
      await nextAnimationFrame();
      await nextAnimationFrame();
    }
    if (canvas!.clientWidth !== viewportWidth || canvas!.clientHeight !== viewportHeight) {
      throw new Error(
        `perf-ab agent: the canvas is ${canvas!.clientWidth}x${canvas!.clientHeight}, not `
        + `${viewportWidth}x${viewportHeight}; the page viewport must be at least the shot's`,
      );
    }
    const profile = qualityProfile.resolveWebGpuQualityProfile(
      config!.quality as QualityLevel,
      config!.renderingMode as RenderingMode,
    );
    const renderScale = request.renderScale ?? shot.captureRenderScale ?? profile.renderScale;
    capability("setPinnedRenderScaleForCapture")(renderScale);

    const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
    active.setAtmosphere(clock, (config!.weather ?? "clear") as WeatherPreset);
    const placement = resolveShotPlacement(activeWorld, shot);
    const airportX = activeWorld.airport?.centerX ?? 0;
    const airportZ = activeWorld.airport?.centerZ ?? 0;
    const positionX = airportX + placement.offsetXMeters;
    const positionZ = airportZ + placement.offsetZMeters;
    const groundHeight = sampleTerrainHeight(activeWorld, positionX, positionZ);
    const altitude = shot.altitudeAglMeters !== null
      ? groundHeight + shot.altitudeAglMeters
      : shot.altitudeMslMeters!;
    const yawDegrees = shot.relativeSunBearingDegrees !== undefined
      ? yawForSunBearing(
          sunDirectionForClock(clock, activeWorld.latitudeDegrees),
          shot.relativeSunBearingDegrees,
        )
      : 0;
    const heading = headingVectorFromYaw(yawDegrees);
    const state: FlightVisualState = {
      ...INITIAL_VISUAL_STATE,
      position: { x: positionX, y: altitude, z: positionZ },
      velocity: {
        x: shot.airspeedMetersPerSecond * heading.x,
        y: 0,
        z: shot.airspeedMetersPerSecond * heading.z,
      },
      orientation: orientationFromYawPitchBank(yawDegrees, shot.pitchDownDegrees, 0),
      airspeed: shot.airspeedMetersPerSecond,
      altitude,
      altitudeAgl: altitude - groundHeight,
      simulationTime,
    };
    active.setCameraMode(shot.cameraMode);
    context = {
      shot,
      canonicalShotIndex: request.canonicalShotIndex,
      viewportWidth,
      viewportHeight,
      state,
      yawDegrees,
      altitude,
      motionYawDegrees: yawDegrees,
      motionX: positionX,
      motionZ: positionZ,
      lastFrameState: state,
    };

    // Ordinary frames first: the new environment and pose re-render the sky
    // probe and the cloud ambient LUT on the next frame, and the draw gate
    // learns which targets are drawn every frame from these.
    setGpuDrawsSuppressed(false);
    for (let frame = 0; frame < request.openFrames; frame += 1) {
      simulationTime += 1 / 60;
      renderFrame({ ...state, simulationTime });
      await capability("waitForGpuIdleForCapture")();
    }
    setGpuDrawsSuppressed(true);
    resetGpuDrawGateStats();
    const raster = capability("getCaptureRenderSize")();
    return {
      renderCalls,
      viewport: { width: viewportWidth, height: viewportHeight },
      raster: { width: raster.width, height: raster.height },
      renderScale,
      position: { x: positionX, y: altitude, z: positionZ },
      yawDegrees,
      elapsedMs: performance.now() - started,
    };
  },

  async stream(request: StreamRequest): Promise<StreamReport> {
    const started = performance.now();
    const shot = requireContext();
    const active = requireRenderer();
    const fence = capability("waitForGpuIdleForCapture");
    // The capture's stability rule: past the warm-up, three checks in a row
    // with no pending terrain or detail work and an unchanged instance count.
    let stableChecks = 0;
    let lastVisibleInstances = -1;
    let frames = request.maxFrames;
    let settled = false;
    const sampleWatchdog = beginDetailWatchdogWindow(active);
    for (let frame = 0; frame < request.maxFrames; frame += 1) {
      simulationTime += 1 / 60;
      renderFrame({ ...shot.state, simulationTime });
      sampleWatchdog?.();
      // Let worker results and buffer maps land, and keep the queue from
      // running unboundedly ahead of the CPU adapter.
      await yieldToTasks();
      if (frame % 4 === 3) await fence();
      if (frame % 60 === 59) {
        const progress = active.getDiagnostics();
        console.info(
          `perf-ab stream: frame ${frame + 1}, pending pages ${progress.pendingTerrainPages}, `
          + `detail ${progress.pendingDetailWork}, instances ${progress.visibleInstances}`,
        );
      }
      if (frame >= request.minFrames && frame % request.checkEvery === request.checkEvery - 1) {
        const diagnostics = active.getDiagnostics();
        if (
          diagnostics.pendingTerrainPages === 0
          && diagnostics.pendingDetailWork === 0
          && diagnostics.visibleInstances === lastVisibleInstances
        ) {
          stableChecks += 1;
          if (stableChecks >= 3) {
            frames = frame + 1;
            settled = true;
            break;
          }
        } else {
          stableChecks = 0;
        }
        lastVisibleInstances = diagnostics.visibleInstances;
      }
    }
    await fence();
    const diagnostics = active.getDiagnostics();
    const gate = gpuDrawGateStats();
    return {
      frames,
      settled,
      renderCalls,
      elapsedMs: performance.now() - started,
      pendingTerrainPages: diagnostics.pendingTerrainPages,
      pendingDetailWork: diagnostics.pendingDetailWork,
      droppedDraws: gate.droppedDraws,
      suppressedPasses: gate.suppressedPasses,
      bakedWhileClosed: gate.bakedWhileClosed,
      detailWorker: detailWorkerState(active),
      detailWatchdog: detailWatchdogReport(active),
    };
  },

  async pad(frames: number): Promise<{ readonly renderCalls: number }> {
    const shot = requireContext();
    for (let frame = 0; frame < frames; frame += 1) {
      simulationTime += 1 / 60;
      renderFrame({ ...shot.state, simulationTime });
      await yieldToTasks();
    }
    await capability("waitForGpuIdleForCapture")();
    return { renderCalls };
  },

  async settle(request: SettleRequest): Promise<SettleReport> {
    const started = performance.now();
    const shot = requireContext();
    const renderer = requireRenderer();
    const fence = capability("waitForGpuIdleForCapture");
    setGpuDrawsSuppressed(false);
    await fence();
    // The capture's time pin and the two pins that go with it, in its order:
    // keyed on the CANONICAL index, then the ocean's cascade cadence and the
    // wildlife restarted at that instant, then the settle.
    const canonicalShotIndex = shot.canonicalShotIndex;
    simulationTime = 500 + canonicalShotIndex * 120
      + (shot.shot.simulationTimeOffsetSeconds ?? 0);
    renderer.pinOceanCascadePhaseForCapture();
    renderer.pinWildlifeForCapture();
    const countFrom = request.settleFrames - request.countFrames;
    const drawCallsPerFrame: number[] = [];
    let counting = false;
    try {
      for (let settle = 0; settle < request.settleFrames; settle += 1) {
        if (settle === countFrom) {
          beginGpuWorkWindow();
          counting = true;
        }
        simulationTime += 1 / 60;
        renderFrame({ ...shot.state, simulationTime });
        if (settle >= countFrom) drawCallsPerFrame.push(renderer.getDiagnostics().drawCalls);
        await fence();
      }
    } catch (error) {
      // A window left open would fail every later shot's settle on it,
      // hiding this error behind that one.
      if (counting) endGpuWorkWindow(0);
      throw error;
    }
    const counters = endGpuWorkWindow(request.countFrames);
    shot.motionYawDegrees = shot.yawDegrees;
    shot.motionX = shot.state.position.x;
    shot.motionZ = shot.state.position.z;
    shot.lastFrameState = { ...shot.state, simulationTime };
    return {
      renderCalls,
      elapsedMs: performance.now() - started,
      counters,
      diagnostics: shotDiagnostics(),
      drawCallsPerFrame,
    };
  },

  async measureFrame(): Promise<FrameSample> {
    const shot = requireContext();
    const fence = capability("waitForGpuIdleForCapture");
    const frameState = advanceFrameState(shot);
    const pipelinesBefore = creations.pipelines;
    const shaderModulesBefore = creations.shaderModules;
    armGpuPassTiming();
    const started = performance.now();
    try {
      renderFrame(frameState);
    } catch (error) {
      // Disarm and drain, or every later frame fails on "already armed".
      await collectGpuPassTiming().catch(() => undefined);
      throw error;
    }
    const rendered = performance.now();
    const timing = await collectGpuPassTiming();
    await fence();
    const idle = performance.now();
    const passes: Record<string, number> = {};
    for (const pass of timing.passes) {
      const key = `${pass.kind}:${pass.label}`;
      passes[key] = (passes[key] ?? 0) + pass.nanoseconds / 1e6;
    }
    const sample: FrameSample = {
      renderMs: rendered - started,
      gpuMs: timing.totalNanoseconds / 1e6,
      wallMs: idle - started,
      passes,
      invalidPasses: timing.invalidPasses,
      pipelinesCreated: creations.pipelines - pipelinesBefore,
      shaderModulesCreated: creations.shaderModules - shaderModulesBefore,
    };
    // Let the compositor take this frame's canvas now, outside every timed
    // window, rather than during the next measured frame.
    await nextAnimationFrame();
    await nextAnimationFrame();
    return sample;
  },

  async flight(request: FlightRequest): Promise<FlightReport> {
    const started = performance.now();
    const shot = requireContext();
    const active = requireRenderer();
    const activeWorld = world!;
    const fence = capability("waitForGpuIdleForCapture");
    if (flightPath === null || request.restart) {
      const start = request.start ?? null;
      flightPath = start
        ? {
          x: start.x,
          z: start.z,
          yawDegrees: start.yawDegrees,
          altitude: sampleTerrainHeight(activeWorld, start.x, start.z) + request.clearanceMeters,
          pitchDownDegrees: 0,
        }
        : {
          x: shot.state.position.x,
          z: shot.state.position.z,
          yawDegrees: shot.yawDegrees,
          altitude: shot.altitude,
          pitchDownDegrees: 0,
        };
      active.setCameraMode(request.cameraMode);
    }
    const path = flightPath;
    const speed = request.speedMetersPerSecond;
    const bankRadians = (request.bankDegrees * Math.PI) / 180;
    const turnRateDegrees = ((9.81 * Math.tan(bankRadians)) / Math.max(20, speed)) * (180 / Math.PI);
    const pitchTargetDegrees = request.pitchDownDegrees ?? 0;
    setGpuDrawsSuppressed(request.suppressDraws);
    const longTaskStart = longTasks.length;
    const frames: FlightFrame[] = [];
    const sampleWatchdog = beginDetailWatchdogWindow(active);
    // Null from a build whose renderer does not report its bakes.
    const bakeStart = readBakeStats(active);
    const bakeProbe = bakeStart ? new FlightBakeProbe(bakeStart) : null;
    let fault: DetailWorkerFault | null = null;
    const dumped: { readonly frame: number; readonly copy: HTMLCanvasElement }[] = [];
    let heapMark = heapUsedBytes();
    for (let frame = 0; frame < request.frames; frame += 1) {
      if (frame === request.killDetailWorkerAtFrame) fault = failDetailWorker(active, "kill", frame);
      if (frame === request.hangDetailWorkerAtFrame) fault = failDetailWorker(active, "hang", frame);
      // An emulated hitch's frame flies as many sixtieths of a second as the
      // hitch lasted; on every other frame `steps` is exactly 1, so those
      // frames are what they were before hitches existed, bit for bit.
      const hitchMilliseconds = request.hitch?.frame === frame ? request.hitch.milliseconds : null;
      const steps = hitchMilliseconds === null ? 1 : (hitchMilliseconds / 1_000) * 60;
      simulationTime += hitchMilliseconds === null ? 1 / 60 : hitchMilliseconds / 1_000;
      path.yawDegrees += (turnRateDegrees / 60) * steps;
      const heading = headingVectorFromYaw(path.yawDegrees);
      path.x += ((speed * heading.x) / 60) * steps;
      path.z += ((speed * heading.z) / 60) * steps;
      // Terrain following, as a pilot would: never closer than the clearance
      // to the ground under the aircraft or 3 s ahead, climbing at up to
      // 25 m/s and descending at up to 10 m/s toward it.
      const groundHere = sampleTerrainHeight(activeWorld, path.x, path.z);
      const groundAhead = sampleTerrainHeight(
        activeWorld,
        path.x + heading.x * speed * 3,
        path.z + heading.z * speed * 3,
      );
      const target = Math.max(groundHere, groundAhead) + request.clearanceMeters;
      path.altitude += Math.max((-10 / 60) * steps, Math.min((25 / 60) * steps, target - path.altitude));
      path.altitude = Math.max(path.altitude, groundHere + 30);
      // The nose only: the path still follows the terrain, so a pitched leg
      // looks at the ground from the clearance without flying into it.
      const pitchStep = (FLIGHT_PITCH_RATE_DEGREES_PER_SECOND / 60) * steps;
      path.pitchDownDegrees += Math.max(-pitchStep, Math.min(pitchStep, pitchTargetDegrees - path.pitchDownDegrees));
      const state: FlightVisualState = {
        ...shot.state,
        simulationTime,
        position: { x: path.x, y: path.altitude, z: path.z },
        velocity: { x: speed * heading.x, y: 0, z: speed * heading.z },
        orientation: orientationFromYawPitchBank(path.yawDegrees, path.pitchDownDegrees, request.bankDegrees),
        airspeed: speed,
        altitude: path.altitude,
        altitudeAgl: path.altitude - groundHere,
      };
      shot.lastFrameState = state;
      const pipelinesBefore = creations.pipelines;
      const shaderModulesBefore = creations.shaderModules;
      const shaderCodeBefore = creations.shaderCodeChars;
      const effectsBefore = effectsCompiled.length;
      const pipelineSourcesBefore = pipelineSources.length;
      const deferredBefore = deferredDrawCount(active);
      const heapBefore = heapUsedBytes();
      const heapBetweenBytes = heapBefore - heapMark;
      const renderStarted = performance.now();
      renderFrame(state, hitchMilliseconds);
      const renderMs = performance.now() - renderStarted;
      const heapAfter = heapUsedBytes();
      // Outside both timed windows and both heap windows, as is the dump.
      sampleWatchdog?.();
      const bake = bakeProbe ? bakeProbe.observe(readBakeStats(active)!) : undefined;
      if (request.dumpFrames && frame >= request.dumpFrames.from && frame <= request.dumpFrames.to) {
        // As capture() reads a frame back, but this frame's own render, not
        // a second one: in the same task, before the compositor takes it.
        const raster = capability("getCaptureRenderSize")();
        const copy = document.createElement("canvas");
        copy.width = shot.viewportWidth;
        copy.height = shot.viewportHeight;
        copy.getContext("2d")!.drawImage(
          canvas!, 0, 0, raster.width, raster.height, 0, 0, shot.viewportWidth, shot.viewportHeight,
        );
        dumped.push({ frame, copy });
      }
      // The tasks queued behind the frame (worker results, buffer maps,
      // timers) run here; a zero-delay timer is the last of them.
      const betweenStarted = performance.now();
      await yieldToTasks();
      const betweenMs = performance.now() - betweenStarted;
      heapMark = heapUsedBytes();
      const passMs: Record<string, number> = {};
      for (const timing of graphPassTimings(active)) {
        if (timing.ran) passMs[timing.name] = timing.cpuMilliseconds;
      }
      frames.push({
        renderMs,
        betweenMs,
        passMs,
        heapRenderBytes: heapAfter - heapBefore,
        heapBetweenBytes,
        pipelinesCreated: creations.pipelines - pipelinesBefore,
        shaderModulesCreated: creations.shaderModules - shaderModulesBefore,
        shaderCodeChars: creations.shaderCodeChars - shaderCodeBefore,
        effectsCompiled: effectsCompiled.slice(effectsBefore),
        pipelineSources: pipelineSources.slice(pipelineSourcesBefore),
        pitchDownDegrees: path.pitchDownDegrees,
        ...(deferredBefore === undefined ? {} : { deferredDraws: deferredDrawCount(active)! - deferredBefore }),
        bake,
      });
      if (frame % request.fenceEvery === request.fenceEvery - 1) {
        // The wait for the GPU to drain this frame and those since the last
        // fence: where a pipeline compiled in the GPU process shows.
        const fenceStarted = performance.now();
        await fence();
        (frames[frames.length - 1] as { fenceMs?: number }).fenceMs = performance.now() - fenceStarted;
        heapMark = heapUsedBytes();
      }
    }
    await fence();
    const diagnostics = active.getDiagnostics();
    return {
      frames,
      renderCalls,
      elapsedMs: performance.now() - started,
      longTasks: longTasks.slice(longTaskStart),
      position: { x: path.x, y: path.altitude, z: path.z },
      pendingTerrainPages: diagnostics.pendingTerrainPages,
      pendingDetailWork: diagnostics.pendingDetailWork,
      visibleInstances: diagnostics.visibleInstances,
      residentTerrainPages: diagnostics.residentTerrainPages,
      detailWorker: detailWorkerState(active),
      detailWatchdog: detailWatchdogReport(active),
      detailWorkerFault: fault,
      ...(request.dumpFrames
        ? {
          dumpedFrames: dumped.map(({ frame, copy }) => ({
            frame,
            pngBase64: copy.toDataURL("image/png").split(",", 2)[1]!,
          })),
        }
        : {}),
    };
  },

  landStarts(count: number): readonly LandStart[] {
    // A Fermat spiral out from the home airport (golden-angle turns, radius
    // 25 km x sqrt(i + 1), so evenly over the disc), keeping the points over
    // dry land where a 5 x 5 grid over 3 km has at most 3 samples of water
    // and at least 13 of forest or grassland: fresh ground with vegetation to
    // generate, never open sea with nothing to wait on. For the perf seed the
    // first 20 lie 25-166 km out, from the first 44 points.
    if (!world) throw new Error("perf-ab agent: no world; prepareShot() first");
    const activeWorld = world;
    const homeX = activeWorld.airport?.centerX ?? 0;
    const homeZ = activeWorld.airport?.centerZ ?? 0;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const starts: LandStart[] = [];
    for (let index = 0; starts.length < count && index < 32 * count; index += 1) {
      const distanceMeters = 25_000 * Math.sqrt(index + 1);
      const x = homeX + distanceMeters * Math.sin(index * goldenAngle);
      const z = homeZ + distanceMeters * Math.cos(index * goldenAngle);
      let vegetated = 0;
      let wet = 0;
      let centreWet = false;
      for (let sampleIndex = 0; sampleIndex < 25; sampleIndex += 1) {
        const sample = sampleTerrain(activeWorld, x + ((sampleIndex % 5) - 2) * 750, z + (Math.floor(sampleIndex / 5) - 2) * 750);
        const sampleWet = sample.height <= activeWorld.seaLevel || sample.biomeName === "water";
        if (sampleWet) wet += 1;
        if (sampleWet && sampleIndex === 12) centreWet = true;
        if (sample.biomeName === "forest" || sample.biomeName === "grassland") vegetated += 1;
      }
      if (!centreWet && wet <= 3 && vegetated >= 13) {
        starts.push({ x, z, yawDegrees: 0, distanceMeters, vegetatedShare: vegetated / 25 });
      }
    }
    if (starts.length < count) {
      throw new Error(`perf-ab agent: ${starts.length} vegetated land starts within ${32 * count} tries, not ${count}`);
    }
    return starts;
  },

  async capture(): Promise<CaptureResult> {
    const shot = requireContext();
    const active = requireRenderer();
    const raster = capability("getCaptureRenderSize")();
    const copy = document.createElement("canvas");
    copy.width = shot.viewportWidth;
    copy.height = shot.viewportHeight;
    const copyContext = copy.getContext("2d", { willReadFrequently: true })!;
    copyContext.imageSmoothingEnabled = true;
    copyContext.imageSmoothingQuality = "high";
    // As the capture: re-render the last measured state and read it back in
    // the same task, before the compositor consumes the presented buffer.
    markGpuDrawGateFrame();
    active.render(shot.lastFrameState, 1 / 60);
    renderCalls += 1;
    copyContext.drawImage(
      canvas!,
      0,
      0,
      raster.width,
      raster.height,
      0,
      0,
      shot.viewportWidth,
      shot.viewportHeight,
    );
    const pngBase64 = copy.toDataURL("image/png").split(",", 2)[1]!;
    await capability("waitForGpuIdleForCapture")();
    return { pngBase64, width: shot.viewportWidth, height: shot.viewportHeight };
  },

  async compareImages(a: string, b: string, width: number, height: number): Promise<ImageComparison> {
    const [first, second] = await Promise.all([decodePng(a, width, height), decodePng(b, width, height)]);
    let differingPixels = 0;
    let maxChannelDelta = 0;
    let totalDelta = 0;
    for (let index = 0; index < first.length; index += 4) {
      let differs = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(first[index + channel]! - second[index + channel]!);
        if (delta > 0) differs = true;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
        totalDelta += delta;
      }
      if (differs) differingPixels += 1;
    }
    return {
      width,
      height,
      ssim: meanSsim(
        luminanceFromRgba(first, width, height),
        luminanceFromRgba(second, width, height),
        width,
        height,
      ),
      rgbSsim: meanRgbSsim(first, second, width, height),
      worstTileRgbSsim: worstTileRgbSsim(first, second, width, height),
      differingPixels,
      maxChannelDelta,
      meanAbsoluteChannelDelta: totalDelta / ((first.length / 4) * 3),
    };
  },

  errors(): AgentErrors {
    return {
      console: [...errors.console],
      logger: [...errors.logger],
      gpu: [...errors.gpu],
      page: [...errors.page],
    };
  },

  dispose(): void {
    removeGpuErrorListener?.();
    removeGpuErrorListener = null;
    renderer?.dispose();
    renderer = null;
    canvas?.remove();
    canvas = null;
    context = null;
  },
};

window.__perfAgent = agent;
