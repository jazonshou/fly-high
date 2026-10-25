/**
 * The contract between the cloud A/B agent page (`tests/perf/ab/agent.ts`) and
 * its orchestrator (`scripts/perf-ab.mts`). Types only, plus the version: the
 * orchestrator refuses a page whose `protocol` differs, so a base built from an
 * older harness fails loudly instead of answering a question it was not asked.
 */

import type { PerfCaptureShotDefinition } from "../../../scripts/perf-capture.mts";
import type { GpuWorkCounters } from "../gpuWorkCounters";
import type { DetailWatchdogReport } from "./detailWatchdog";

export type { DetailWatchdogReport } from "./detailWatchdog";

export const PERF_AB_PROTOCOL = 1;

/** Fixed for the life of a page: everything the renderer is created with. */
export interface AgentConfig {
  readonly quality: string;
  readonly renderingMode: string;
  readonly aircraft: string;
  /**
   * Profile fields forced through the capture-experiment override, for a
   * positive control (an arm with a known extra cost). Null in a normal run.
   */
  readonly profileOverride: Readonly<Record<string, unknown>> | null;
  /**
   * Options merged into the page's `createWorld` (a landform or climate
   * under test, one arm with it and one without). Absent or null in a
   * normal run; `worldEvolution` stays the shot's.
   */
  readonly worldOptions?: Readonly<Record<string, unknown>> | null;
  /**
   * The weather every shot is rendered in. Absent or null is "clear", what
   * the capture renders; a flight can fly the game's default, "breezy".
   */
  readonly weather?: string | null;
}

export interface AgentInfo {
  readonly protocol: number;
  readonly userAgent: string;
  readonly hardwareConcurrency: number;
  readonly adapter: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  };
  readonly timestampQuery: boolean;
}

export interface AgentCatalog {
  readonly shots: readonly PerfCaptureShotDefinition[];
  /** Gate 0-c: the inventoried GPU memory ceiling every shot is held to. */
  readonly inventoriedMemoryCeilingMiB: number;
}

export interface PrepareRequest {
  /** The HEAD's definition, sent to both arms so they render the same shot. */
  readonly shot: PerfCaptureShotDefinition;
  /** The shot's index in the head's canonical list: it keys the time pin. */
  readonly canonicalShotIndex: number;
  /** Overrides the shot's own capture render scale (a quick, smaller run). */
  readonly renderScale: number | null;
  /** Ordinary frames before the draw gate closes (bakes, per-frame targets). */
  readonly openFrames: number;
  /**
   * Dispose the renderer and build a new one (a new world, detail worker and
   * caches) even when the current one would do: an independent trial.
   */
  readonly freshRenderer?: boolean;
}

export interface PrepareReport {
  readonly renderCalls: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly raster: { readonly width: number; readonly height: number };
  readonly renderScale: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly yawDegrees: number;
  readonly elapsedMs: number;
}

export interface StreamRequest {
  /** No stability check before this many frames (the capture's warm-up). */
  readonly minFrames: number;
  readonly maxFrames: number;
  /** Frames between stability checks; streaming is settled after three in a row. */
  readonly checkEvery: number;
}

export interface StreamReport {
  readonly frames: number;
  /** False when `maxFrames` ran out with work still pending. */
  readonly settled: boolean;
  readonly renderCalls: number;
  readonly elapsedMs: number;
  readonly pendingTerrainPages: number;
  readonly pendingDetailWork: number;
  readonly droppedDraws: number;
  readonly suppressedPasses: number;
  readonly bakedWhileClosed: Readonly<Record<string, number>>;
  /** As `FlightReport`'s, over the stream (absent from an older agent). */
  readonly detailWorker?: DetailWorkerState | null;
  readonly detailWatchdog?: DetailWatchdogReport | null;
}

export interface SettleRequest {
  readonly settleFrames: number;
  /** The last this-many settle frames are counted (`GpuWorkCounters`). */
  readonly countFrames: number;
}

/** Deterministic renderer state after the settle: compared exactly between arms. */
export interface ShotDiagnostics {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly visibleInstances: number;
  readonly vegetationBatches: number;
  /**
   * Every page in the height atlas. A page stays there until its slot is
   * needed, so this also counts pages the arm's stream wanted earlier and no
   * longer does, and two arms of one build can rest on different counts.
   */
  readonly residentTerrainPages: number;
  /**
   * The pages the terrain wants on the settle's last frame (drawn, their
   * morph parents, the collision ring, erosion seeds): what the pose asks
   * for, without that history. -1 from a build before the renderer reported
   * it (2026-09-02).
   */
  readonly wantedTerrainPages: number;
  readonly renderPixels: number;
  readonly inventoriedGpuMemoryMiB: number;
  readonly estimatedGpuMemoryMiB: number;
}

export interface SettleReport {
  readonly renderCalls: number;
  readonly elapsedMs: number;
  readonly counters: GpuWorkCounters;
  /** As of the settle's last frame. */
  readonly diagnostics: ShotDiagnostics;
  /**
   * The renderer's draw calls on each counted frame. The capture gates its
   * ceiling on ONE frame's count, so a shot whose passes run on a cadence
   * can read differently on another frame; a range here says so.
   */
  readonly drawCallsPerFrame: readonly number[];
}

export interface FrameSample {
  /** `renderer.render()` on the main thread: the frame's JavaScript cost. */
  readonly renderMs: number;
  /** Sum of every timed GPU pass. */
  readonly gpuMs: number;
  /** From `render()` until the queue is idle. */
  readonly wallMs: number;
  /** Per pass key, milliseconds summed over the frame's passes with that key. */
  readonly passes: Readonly<Record<string, number>>;
  readonly invalidPasses: number;
  /** Pipelines and shader modules created during the frame: hitch causes. */
  readonly pipelinesCreated: number;
  readonly shaderModulesCreated: number;
}

/**
 * One leg of a scripted flight (`scripts/perf-flight.mts`): the aircraft flies
 * on from where the arm's previous leg ended, over terrain it has not seen,
 * so streaming, bakes and pipeline creation happen the way they do in play.
 */
export interface FlightRequest {
  readonly frames: number;
  /** Start again from the prepared shot's pose instead of continuing. */
  readonly restart: boolean;
  readonly speedMetersPerSecond: number;
  /** Height kept above the highest ground under and 3 s ahead of the aircraft. */
  readonly clearanceMeters: number;
  /** Constant bank; 0 flies straight. */
  readonly bankDegrees: number;
  readonly cameraMode: "chase" | "cockpit";
  /** Drop the frame's own draws (`gpuDrawGate.ts`): CPU and compute only. */
  readonly suppressDraws: boolean;
  /** Fence to GPU idle every this many frames, so the queue cannot run ahead. */
  readonly fenceEvery: number;
  /**
   * Where a restarted flight begins instead of the prepared shot's pose, at
   * the clearance over the ground there. Null starts at the shot.
   */
  readonly start?: { readonly x: number; readonly z: number; readonly yawDegrees: number } | null;
  /**
   * Fail the detail worker before rendering this frame of the leg, as a
   * crashed worker script does: an error event on the generation client's
   * Worker. Absent or null leaves it alone.
   */
  readonly killDetailWorkerAtFrame?: number | null;
  /** Terminate the detail worker before this frame with no event: a silent worker, which only the watchdog can catch. */
  readonly hangDetailWorkerAtFrame?: number | null;
  /**
   * This frame of the leg stands for a main thread blocked `milliseconds`
   * while the simulation flew on: the path and simulation time advance by
   * that much, and render()'s delta is FlightGame's clamp of it (0.1 s at
   * most). Every other frame is 1/60 s, as without it.
   */
  readonly hitch?: { readonly frame: number; readonly milliseconds: number } | null;
  /**
   * Read these frames of the leg (indices, inclusive) back from the canvas
   * right after rendering them, in the same task and with no extra render;
   * they are encoded only after the leg. Needs the frame's draws.
   */
  readonly dumpFrames?: { readonly from: number; readonly to: number } | null;
}

export interface FlightFrame {
  /** `renderer.render()` on the main thread. */
  readonly renderMs: number;
  /** Everything else the main thread ran before the next frame (worker results, timers). */
  readonly betweenMs: number;
  /** JS heap grown during render() and between frames; a fall is a collection. */
  readonly heapRenderBytes: number;
  readonly heapBetweenBytes: number;
  readonly pipelinesCreated: number;
  readonly shaderModulesCreated: number;
  /** WGSL characters compiled in this frame's new shader modules. */
  readonly shaderCodeChars: number;
  /**
   * Effects first compiled in this frame: the shader, and the defines that
   * differ from the nearest effect of that shader compiled before it.
   */
  readonly effectsCompiled?: readonly string[];
  /** Main-thread milliseconds per frame-graph pass (an older build may report none). */
  readonly passMs: Readonly<Record<string, number>>;
}

export interface FlightReport {
  readonly frames: readonly FlightFrame[];
  readonly renderCalls: number;
  readonly elapsedMs: number;
  /** Tasks over 50 ms on the main thread during the leg (Long Tasks API). */
  readonly longTasks: readonly { readonly start: number; readonly duration: number }[];
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly pendingTerrainPages: number;
  readonly pendingDetailWork: number;
  readonly visibleInstances: number;
  readonly residentTerrainPages: number;
  /**
   * The vegetation generator: on its worker (`active`), or fallen back to
   * generating cells inline on the main thread. Null from a build without one.
   */
  readonly detailWorker: DetailWorkerState | null;
  /** The detail worker's watchdog clocks and build latencies over the leg (absent from an older agent). */
  readonly detailWatchdog?: DetailWatchdogReport | null;
  /** The worker failed on purpose in this leg (`killDetailWorkerAtFrame`, `hangDetailWorkerAtFrame`). */
  readonly detailWorkerFault?: DetailWorkerFault | null;
  /** `dumpFrames`, as PNGs at the viewport's size. */
  readonly dumpedFrames?: readonly { readonly frame: number; readonly pngBase64: string }[];
}

export interface DetailWorkerFault {
  readonly kind: "kill" | "hang";
  readonly frame: number;
  /** False when there was no worker to fail: it had already gone, or the build has none. */
  readonly delivered: boolean;
  /** The worker's state just before. */
  readonly before: DetailWorkerState | null;
}

/**
 * The detail worker's state at the end of a stream or a leg; the counters are
 * the renderer's, so they run on across legs. The optional ones come only from
 * a build whose runtime restarts a failed worker and reports its silences.
 */
export interface DetailWorkerState {
  readonly active: boolean;
  readonly fallbacks: number;
  readonly generationTimeouts: number;
  readonly buildTimeouts: number;
  readonly buildRejections: number;
  readonly respawns?: number;
  readonly heartbeats?: number;
  readonly maxSilenceMs?: number;
  readonly buildMaxLatencyMs?: number;
  readonly convergenceStalls?: number;
}

/**
 * Where a settle trial holds still (`PerfAgent.landStarts`): land above the
 * sea with vegetation to generate, away from the home airport.
 */
export interface LandStart {
  readonly x: number;
  readonly z: number;
  readonly yawDegrees: number;
  /** From the home airport. */
  readonly distanceMeters: number;
  /** The share of the samples around it that are forest or grassland. */
  readonly vegetatedShare: number;
}

export interface CaptureResult {
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageComparison {
  readonly width: number;
  readonly height: number;
  readonly ssim: number;
  readonly rgbSsim: number;
  readonly worstTileRgbSsim: number;
  /** Pixels where any channel differs at all. */
  readonly differingPixels: number;
  readonly maxChannelDelta: number;
  readonly meanAbsoluteChannelDelta: number;
}

export interface AgentErrors {
  readonly console: readonly string[];
  readonly logger: readonly string[];
  readonly gpu: readonly string[];
  readonly page: readonly string[];
}

export interface PerfAgent {
  readonly protocol: number;
  info(): Promise<AgentInfo>;
  /** This arm's canonical shot list and limits (the orchestrator reads the head's). */
  catalog(): AgentCatalog;
  configure(config: AgentConfig): void;
  prepareShot(request: PrepareRequest): Promise<PrepareReport>;
  stream(request: StreamRequest): Promise<StreamReport>;
  /** Renders `frames` more gated frames, so both arms enter the settle on the same frame index. */
  pad(frames: number): Promise<{ readonly renderCalls: number }>;
  settle(request: SettleRequest): Promise<SettleReport>;
  measureFrame(): Promise<FrameSample>;
  flight(request: FlightRequest): Promise<FlightReport>;
  /** `count` settle-trial starts in the current shot's world, the same in every build of that world. */
  landStarts(count: number): readonly LandStart[];
  capture(): Promise<CaptureResult>;
  compareImages(a: string, b: string, width: number, height: number): Promise<ImageComparison>;
  errors(): AgentErrors;
  dispose(): void;
}

declare global {
  interface Window {
    __perfAgent?: PerfAgent;
  }
}
