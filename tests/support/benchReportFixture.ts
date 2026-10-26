import { GovernorTrace, pixelsAtScale, type ScaleContext } from "@/src/bench/governorTrace";
import { benchProfile, benchRunPlan, benchTier, benchTimings, expectedPathFingerprint } from "@/src/bench/plan";
import {
  createFrameLog,
  estimateRefresh,
  flightCadence,
  flightSegments,
  perSecondRows,
  perSecondTable,
  rafReport,
  recordFrame,
  recordOverhead,
  overheadSummary,
  summarizeHeap,
  summarizeLongAnimationFrames,
  summarizeLongTasks,
  summarizeWindow,
  timerReport,
  windowFrames,
  windowHistogram,
  worstFrames,
  type FrameWindowContext,
} from "@/src/bench/stats";
import type {
  BenchCompileCounts,
  BenchDeviceReport,
  BenchHeapSample,
  BenchJson,
  BenchLongAnimationFrameEntry,
  BenchLongTaskEntry,
  BenchMode,
  BenchRefresh,
  BenchRunRecord,
  BenchSecondSample,
  BenchStepRecord,
  BenchStepResult,
  BenchStepStatus,
} from "@/src/bench/types";
import {
  createGovernorState,
  governorConfigForProfile,
  type GovernorSignals,
  type GovernorState,
} from "@/src/render/webgpu/core/AdaptiveGovernor";
import { hitchThresholdMilliseconds } from "@/src/render/webgpu/core/QualityProfile";

/**
 * Realistic bench records for the report tests: each step's result is built
 * by the real statistics over a synthetic 75 s frame log, a real governor
 * trace with about fifty decisions, and instrument entries of the size a
 * Chromium run produces, so the report's size is measured, not guessed.
 */

/** A small deterministic generator, so a fixture is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export interface StepFixtureOptions {
  readonly tierIndex: number;
  readonly status?: BenchStepStatus;
  /** The air window's mean fps, roughly. */
  readonly fps?: number;
  readonly refreshHz?: number;
  /** One long frame every this many frames. */
  readonly hitchEvery?: number;
  readonly cssWidth?: number;
  readonly cssHeight?: number;
  readonly devicePixelRatio?: number;
  readonly decisions?: number;
  readonly mode?: BenchMode;
  readonly quick?: boolean;
  readonly firstRendererInTab?: boolean;
  readonly granularityMs?: number;
  readonly seed?: number;
}

export function benchRefresh(rafHz = 60): BenchRefresh {
  const periodMs = 1_000 / rafHz;
  return { rafHz, periodMs, medianMs: periodMs, p10Ms: periodMs - 0.1, p90Ms: periodMs + 0.1, samples: 59, outliers: 1 };
}

const ZERO: BenchCompileCounts = { render: 0, renderAsync: 0, compute: 0, computeAsync: 0, shaderModules: 0, wgslKiB: 0 };

function compiles(render: number, compute: number, shaderModules: number): BenchCompileCounts {
  return { ...ZERO, render, compute, shaderModules, wgslKiB: shaderModules * 9.3 };
}

/** The vegetation worker's presentation diagnostics: about forty counters. */
function presentation(next: () => number): BenchJson {
  const out: Record<string, BenchJson> = {
    activeChunkKey: "detail:12,-7:lod1",
    activeBuildSource: "worker",
    workerActive: true,
  };
  for (const name of [
    "workUnitsLastUpdate", "millisecondsLastUpdate", "stagedRecords", "pooledCpuBatchStorage", "cancellations",
    "publications", "backloggedChunks", "suppressedChunks", "validityEnvelopeMeters", "pendingObserverDriftMeters",
    "maximumLiveObserverDriftMeters", "lastPublicationObserverDriftMeters", "buildStarts", "buildSlices",
    "completedSlices", "timeBudgetStops", "workBudgetStops", "workUnitsTotal", "publishedRecords",
    "observerQuantumChanges", "observerSensitiveBuildStarts", "residentCellsInSensitiveBuilds", "workerRetainedCells",
    "workerBuildStarts", "workerResultsQueued", "workerBuildPublications", "workerBuildRejections",
    "workerBuildTimeouts", "workerGenerationTimeouts", "workerFallbacks", "workerRespawns",
  ]) {
    out[name] = Math.round(next() * 40_000) / 7;
  }
  return out;
}

export function benchStepResult(options: StepFixtureOptions): BenchStepResult {
  const next = random(options.seed ?? 0x5eed + options.tierIndex * 7);
  const tier = benchTier(options.tierIndex);
  const profile = benchProfile(options.tierIndex);
  const config = governorConfigForProfile(profile);
  const timings = benchTimings(options.quick ?? false);
  const mode = options.mode ?? "shipped";
  const status = options.status ?? "ok";
  const refreshHz = options.refreshHz ?? 60;
  const refreshMs = 1_000 / refreshHz;
  const targetMs = 1_000 / (options.fps ?? 58);
  const hitchEvery = options.hitchEvery ?? 400;
  const cssWidth = options.cssWidth ?? 1_920;
  const cssHeight = options.cssHeight ?? 1_009;
  const devicePixelRatio = options.devicePixelRatio ?? 1;
  const granularityMs = options.granularityMs ?? 0.1;
  const flightS = status === "early-stop" ? timings.earlyStopAtS : timings.flightS;
  const flightStartMs = 8_000;
  const scale: ScaleContext = {
    cssWidth,
    cssHeight,
    devicePixelRatio,
    maxDevicePixelRatio: profile.maxDevicePixelRatio,
    maxRenderPixels: profile.maxRenderPixels,
  };

  // Frames: whole refresh periods with a little jitter, a share of doubled
  // ones that brings the mean to the target, and a long frame now and then.
  const doubled = Math.min(1, Math.max(0, (targetMs - refreshMs) / refreshMs));
  const multiple = Math.max(1, Math.round(targetMs / refreshMs / (1 + doubled)));
  const log = createFrameLog();
  const settleFrames = 2 * refreshHz;
  let time = flightStartMs - settleFrames * refreshMs;
  let frame = 0;
  const totalDecisions = options.decisions ?? 50;
  const decisionEvery = Math.max(1, Math.floor((flightS * 1_000) / targetMs / Math.max(1, totalDecisions)));
  const trace = new GovernorTrace({ windows: { ground: timings.ground, air: timings.air }, flightS, scale, maxDecisions: 128 });
  let state: GovernorState = createGovernorState(config);
  let signals: GovernorSignals = { gpuP95Ms: null, cpuP95Ms: 6, intervalP95Ms: refreshMs };
  const samples: BenchSecondSample[] = [];
  const longTasks: BenchLongTaskEntry[] = [];
  const longFrames: BenchLongAnimationFrameEntry[] = [];
  const heap: BenchHeapSample[] = [];
  while (time <= flightStartMs + flightS * 1_000 + refreshMs) {
    const tS = (time - flightStartMs) / 1_000;
    let interval = refreshMs * multiple * (next() < doubled ? 2 : 1) + (next() - 0.5) * 0.4;
    if (frame > 0 && frame % hitchEvery === 0) interval = 30 + next() * 90;
    const compileCount = tS < 2 && next() < 0.2 ? 1 + Math.floor(next() * 3) : next() < 0.002 ? 1 : 0;
    const pixels = pixelsAtScale(state.renderScale, scale);
    const width = Math.round(Math.sqrt(pixels * (cssWidth / cssHeight)));
    const height = Math.round(pixels / width);
    const decide = frame > 0 && frame % decisionEvery === 0;
    if (decide) {
      const down = next() < 0.5;
      const floor = config.scaleFloor;
      const ceiling = config.scaleCeiling;
      const renderScale = Math.min(ceiling, Math.max(floor, state.renderScale + (down ? -0.025 : 0.025)));
      state = Object.freeze({
        ...state,
        mode: down ? "gpu-resolution" : "balanced",
        renderScale,
        cpuWorkLevel: next() < 0.2 ? 1 : 0,
        lastLever: next() < 0.3 ? "terrain-page-requests" : state.lastLever,
      });
      signals = { gpuP95Ms: mode === "pinned" ? 10 + next() * 8 : null, cpuP95Ms: 4 + next() * 6, intervalP95Ms: refreshMs + next() * 10 };
    }
    const renderMs = 2.5 + next() * 5 + compileCount * 6;
    recordFrame(log, time, time + 0.3, renderMs, compileCount, decide, mode === "pinned" ? interval * 0.7 : null);
    recordOverhead(log, 0.02 + next() * 0.05);
    trace.observe(tS, {
      governorState: state,
      governorSignals: signals,
      governorConfig: config,
      appliedRenderScale: state.renderScale,
      renderWidth: width,
      renderHeight: height,
      pinned: mode === "pinned",
    });
    if (tS >= 0 && samples.length <= Math.floor(tS)) {
      samples.push({ appliedScale: state.renderScale, renderPixels: width * height, cpuLevel: state.cpuWorkLevel, gpuLevel: state.gpuWorkLevel, heapBytes: 180_000_000 + tS * 90_000 });
      heap.push({ tMs: time, usedBytes: 180_000_000 + Math.floor(tS / 5) * 450_000 });
    }
    if (interval > 50) {
      longTasks.push({ startMs: time + 1, durationMs: interval - 16 });
      longFrames.push({
        startMs: time,
        durationMs: interval,
        blockingMs: interval - 50,
        scripts: [
          { source: "https://jazonshou.github.io/fly-high/assets/index-4f8c2a1b.js", invoker: "FrameRequestCallback", ms: interval * 0.6 },
          { source: "https://jazonshou.github.io/fly-high/assets/FlightRenderer-9d3e0c77.js", invoker: "Worker.onmessage", ms: interval * 0.2 },
          { source: "https://jazonshou.github.io/fly-high/assets/detailWorker-1a2b3c4d.js", invoker: "MessagePort.onmessage", ms: interval * 0.1 },
        ],
      });
    }
    time += interval;
    frame += 1;
  }

  const context: FrameWindowContext = {
    flightStartMs,
    refreshMs,
    granularityMs,
    tierThresholdMs: hitchThresholdMilliseconds(profile),
  };
  const air = status === "early-stop" ? null : summarizeWindow(log, timings.air, context);
  const ground = summarizeWindow(log, timings.ground, context);
  const flightFrames = windowFrames(log, context, 0, flightS);
  const intervals = flightFrames.map((index) => log.frameTimeMs[index + 1]! - log.frameTimeMs[index]!);
  const refresh = benchRefresh(refreshHz);
  const flightEndMs = flightStartMs + flightS * 1_000;
  const pixels = pixelsAtScale(config.scaleCeiling, scale);
  const renderWidth = Math.round(Math.sqrt(pixels * (cssWidth / cssHeight)));
  const renderHeight = Math.round(pixels / renderWidth);
  const stages = [
    "createDevice", "configureCanvas", "createTerrainSystem", "createSky", "createOcean", "createAtmosphere",
    "createShadowCascades", "createAircraftMeshes", "createAirfieldLighting", "createDetailRuntime",
    "compileTerrainPipelines", "compileOceanPipelines", "compileSkyPipelines", "compileAircraftPipelines",
    "firstTerrainPages", "firstDetailCells", "firstFrame",
  ];

  return {
    tierIndex: options.tierIndex,
    quality: tier.quality,
    renderingMode: tier.renderingMode,
    mode,
    firstRendererInTab: options.firstRendererInTab ?? false,
    refresh,
    raf: rafReport(estimateRefresh(Array.from({ length: 60 }, () => refreshMs)), flightCadence(intervals)),
    timer: timerReport(granularityMs),
    startup: {
      navigationType: "navigate",
      httpCache: { scripts: 9, fromCache: 9, revalidated: 0, network: 0, transferKiB: 0 },
      rendererStages: stages.map((label, index) => ({ label, kind: index % 3 === 0 ? "async" : "sync", ms: 3 + next() * 120 })),
      navToAttachMs: 412.6,
      navToFirstFrameMs: 1_830.2,
      navToSettleEndMs: 7_980.4,
      pathPrecomputeMs: 4.1,
      compiles: compiles(41, 23, 37),
    },
    settle: {
      reachedRest: true,
      ms: 6_140,
      frames: 360,
      checks: 7,
      pendingTerrainPages: 0,
      pendingDetailWork: 0,
      visibleInstances: 18_204,
      compiles: compiles(6, 2, 4),
      longTasks: { count: 4, totalMs: 388 },
      governorDecisions: 3,
    },
    canvas: {
      cssWidth,
      cssHeight,
      devicePixelRatio,
      aspectRatio: cssWidth / cssHeight,
      renderWidth,
      renderHeight,
      renderPixels: renderWidth * renderHeight,
      pixelCapBinds: false,
      pinnedRenderScale: mode === "pinned" ? 0.75 : null,
      gpuTiming: mode === "pinned" ? "on" : "off",
    },
    environment: {
      hiddenEvents: 0,
      focusLostMs: 0,
      resizes: 0,
      dprChanges: 0,
      wakeLock: "held",
      keysBlocked: 0,
      ignoredRendererCalls: 0,
      gameErrors: [],
      overflowed: log.overflowed,
      battery: { charging: true, level: 1 },
    },
    flight: {
      seconds: flightS,
      earlyStopFps: status === "early-stop" ? 4.2 : null,
    },
    windows: { ground, air },
    histogram: air === null ? null : windowHistogram(log, timings.air, context),
    segments: flightSegments(log, context, flightS),
    worst: air === null ? [] : worstFrames(log, timings.air, context, longTasks),
    perSecond: perSecondTable(perSecondRows(log, context, flightS, samples)),
    compiles: {
      warmup: compiles(3, 1, 2),
      window: { ...compiles(1, 0, 1), framesWithCompiles: air?.framesWithCompiles ?? 0 },
      firstEvents: Array.from({ length: 20 }, (_, index) => ({
        t: Math.round(next() * 2_000) / 1_000 + index * 0.05,
        kind: (["render", "compute", "shader-module", "render-async"] as const)[index % 4]!,
      })),
    },
    longTasks: summarizeLongTasks(longTasks, flightStartMs, flightEndMs),
    longAnimationFrames: summarizeLongAnimationFrames(longFrames, flightStartMs, flightEndMs, flightStartMs),
    heap: summarizeHeap(heap, flightStartMs, flightEndMs),
    governor: trace.summary(),
    detailWorker: {
      atSettleEnd: { active: true, fallbacks: 0, respawns: 0, buildTimeouts: 0, generationTimeouts: 0, convergenceStalls: 0 },
      atEnd: { active: true, fallbacks: 0, respawns: 0, buildTimeouts: 0, generationTimeouts: 0, convergenceStalls: 0 },
      presentationAtSettleEnd: presentation(next),
      presentationAtEnd: presentation(next),
    },
    end: {
      adapterLabel: "WebGPU · nvidia ampere",
      drawCalls: 1_412,
      triangles: 3_904_118,
      visibleInstances: 21_337,
      residentTerrainPages: 412,
      pendingTerrainPages: 3,
      pendingDetailWork: 1,
      estimatedGpuMemoryMiB: 1_288.4,
      inventoriedGpuMemoryMiB: 1_102.9,
      hitchCount: 11,
      p999FrameMs: 61.3,
      presentWaitP95Ms: 2.4,
      topPassesByCpuMs: [
        { name: "terrain", p95Ms: 1.84 },
        { name: "detail", p95Ms: 1.12 },
        { name: "shadows", p95Ms: 0.73 },
        { name: "ocean", p95Ms: 0.41 },
        { name: "aircraft", p95Ms: 0.22 },
      ],
      gpuPassMs: { mainPass: null, shadows: null, terrainCompute: null, total: null },
    },
    path: {
      route: "runway",
      startX: -4_211.53,
      startZ: 1_870.04,
      headingDeg: 117.2,
      rollEndS: timings.rollEndS,
      climbEndS: timings.climbEndS,
      rollSpeed: 60,
      cruiseSpeed: 120,
      clearance: 150,
      distanceM: 7_650,
      fingerprint: expectedPathFingerprint(options.quick ?? false),
      matchesExpected: true,
    },
    benchOverheadMs: overheadSummary(log, context, 0, flightS),
  };
}

export function benchStepRecord(index: number, options: StepFixtureOptions): BenchStepRecord {
  const status = options.status ?? "ok";
  const ran = status === "ok" || status === "early-stop";
  return {
    index,
    tierIndex: options.tierIndex,
    status,
    attempts: ran || status === "failed" ? 1 : status === "skipped" || status === "pending" ? 0 : 2,
    attemptLog: [],
    message: status === "failed" ? "the WebGPU device was lost" : null,
    result: ran ? benchStepResult({ ...options, firstRendererInTab: options.firstRendererInTab ?? index === 0 }) : null,
  };
}

/**
 * A Windows laptop on Chrome. `GPUAdapterInfo`'s fields are getters on its
 * prototype, so the device block is read field by field, never spread; this
 * fixture is what that read produces.
 */
export function benchDevice(): BenchDeviceReport {
  const limits: Record<string, number> = {};
  for (const [name, value] of Object.entries({
    maxTextureDimension1D: 16_384, maxTextureDimension2D: 16_384, maxTextureDimension3D: 2_048,
    maxTextureArrayLayers: 2_048, maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1_000, maxDynamicUniformBuffersPerPipelineLayout: 10,
    maxDynamicStorageBuffersPerPipelineLayout: 8, maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 10, maxStorageTexturesPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65_536, maxStorageBufferBindingSize: 2_147_483_644,
    minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256, maxVertexBuffers: 8,
    maxBufferSize: 4_294_967_296, maxVertexAttributes: 30, maxVertexBufferArrayStride: 2_048,
    maxInterStageShaderVariables: 28, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 128,
    maxComputeWorkgroupStorageSize: 32_768, maxComputeInvocationsPerWorkgroup: 1_024,
    maxComputeWorkgroupSizeX: 1_024, maxComputeWorkgroupSizeY: 1_024, maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65_535,
  })) {
    limits[name] = value;
  }
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    uaData: {
      brands: ["Chromium 130", "Google Chrome 130", "Not?A_Brand 99"],
      mobile: false,
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture: "x86",
      bitness: "64",
      model: "",
      wow64: false,
      fullVersionList: ["Chromium 130.0.6723.70", "Google Chrome 130.0.6723.70", "Not?A_Brand 99.0.0.0"],
    },
    hardwareConcurrency: 16,
    deviceMemoryGiB: 8,
    screen: { width: 1_920, height: 1_080, availWidth: 1_920, availHeight: 1_032, colorDepth: 24, devicePixelRatio: 1 },
    window: { innerWidth: 1_920, innerHeight: 1_009 },
    battery: { charging: true, level: 1 },
    webgpu: {
      status: "ok",
      reason: null,
      adapter: {
        vendor: "nvidia",
        architecture: "ampere",
        device: "",
        description: "",
        isFallbackAdapter: false,
        subgroupMinSize: 32,
        subgroupMaxSize: 32,
      },
      features: [
        "depth-clip-control", "depth32float-stencil8", "texture-compression-bc", "texture-compression-bc-sliced-3d",
        "timestamp-query", "indirect-first-instance", "shader-f16", "rg11b10ufloat-renderable", "bgra8unorm-storage",
        "float32-filterable", "float32-blendable", "clip-distances", "dual-source-blending", "subgroups",
      ],
      limits,
      limitShortfalls: [],
      preferredCanvasFormat: "bgra8unorm",
      timestampQuery: true,
      rendererLabel: "WebGPU · nvidia ampere",
    },
  };
}

export interface RunFixtureOptions {
  readonly steps: readonly StepFixtureOptions[];
  readonly status?: BenchRunRecord["status"];
  readonly mode?: BenchMode;
  readonly quick?: boolean;
  readonly runId?: string;
  readonly userLabel?: string | null;
  readonly device?: BenchDeviceReport | null;
}

export function benchRunRecord(options: RunFixtureOptions): BenchRunRecord {
  const mode = options.mode ?? "shipped";
  const quick = options.quick ?? false;
  return {
    v: 1,
    runId: options.runId ?? "k3x9q2m7wp",
    plan: benchRunPlan({ tiers: options.steps.map((step) => step.tierIndex), mode, hud: true, quick }),
    status: options.status ?? "finished",
    startedAt: "2026-10-26T09:14:03.511Z",
    finishedAt: options.status === "running" ? null : "2026-10-26T09:21:12.042Z",
    userLabel: options.userLabel === undefined ? "Jason's laptop (RTX 3060)" : options.userLabel,
    device: options.device === undefined ? benchDevice() : options.device,
    introRefresh: benchRefresh(60),
    reportRefresh: benchRefresh(60),
    firstLoad: { navigationType: "navigate", httpCache: { scripts: 9, fromCache: 0, revalidated: 0, network: 9, transferKiB: 2_811.4 } },
    ignoredParams: [],
    settingsKeyAtStart: "absent",
    settingsKeyAtEnd: "absent",
    steps: options.steps.map((step, index) => benchStepRecord(index, { mode, quick, ...step })),
  };
}

/** The default plan: Medium, Low, High, Medium, all finished, the check flights 3% apart. */
export function defaultRun(overrides: Partial<RunFixtureOptions> = {}): BenchRunRecord {
  return benchRunRecord({
    steps: [
      { tierIndex: 1, fps: 58 },
      { tierIndex: 0, fps: 60 },
      { tierIndex: 2, fps: 41, hitchEvery: 120 },
      { tierIndex: 1, fps: 56.5 },
    ],
    ...overrides,
  });
}
