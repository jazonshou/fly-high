/**
 * The contract between the cloud A/B agent page (`tests/perf/ab/agent.ts`) and
 * its orchestrator (`scripts/perf-ab.mts`). Types only, plus the version: the
 * orchestrator refuses a page whose `protocol` differs, so a base built from an
 * older harness fails loudly instead of answering a question it was not asked.
 */

import type { PerfCaptureShotDefinition } from "../../../scripts/perf-capture.mts";
import type { GpuWorkCounters } from "../gpuWorkCounters";

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
  readonly residentTerrainPages: number;
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
