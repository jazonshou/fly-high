import type { TerrainMacroGrid } from "@/src/workers/terrainAuthority";
import {
  isTerrainMacroEvolutionStagedWorkerEvent,
  type TerrainMacroEvolutionStagedWorkerEvent,
  type TerrainMacroEvolutionWorkerCommand,
} from "@/src/workers/terrainMacroEvolutionProtocol";
import type { WorldDefinition, WorldEvolution } from "@/src/world";
import { ChannelNetwork } from "@/src/render/webgpu/water/ChannelNetwork";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  validateTerrainChannelGraphExport,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "./TerrainEvolutionContract";
import type {
  TerrainMacroErosionGpuRunInputs,
  TerrainMacroErosionGpuRunResult,
  TerrainMacroInputsGpuRequest,
} from "./TerrainMacroErosionGpu";
import {
  TerrainMacroEvolutionClient,
  terrainMacroGridFromEvolution,
  type TerrainMacroEvolutionClientOptions,
  type TerrainMacroEvolutionClientResult,
  type TerrainMacroEvolutionProgress,
} from "./TerrainMacroEvolutionClient";

/**
 * Focused world-evolution coordinator (`5-3`/`5-9`).
 *
 * This module is deliberately below FlightRenderer: it resolves the world
 * content choice, owns the macro worker, and publishes immutable products for
 * later page/simulation/water consumers. It does not know about frame graphs,
 * clipmaps, hydrology systems, quality tiers, or render cadence.
 */

export type TerrainEvolutionRuntimeState =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "disposed";

export interface AnalyticTerrainEvolutionRuntimeResult {
  readonly mode: "analytic";
  readonly evolution: null;
  readonly channelGraph: null;
  readonly macroGrid: null;
}

export interface ErodedTerrainEvolutionRuntimeResult {
  readonly mode: "eroded";
  readonly evolution: TerrainMacroEvolutionExport;
  /**
   * `W-1e`: the channel graph is a PROMISE because the staged producer
   * extracts it in its worker and posts it after the macro export. Resolving
   * the macro product first is the whole point — the consumer builds device
   * resources while ~250 ms of extraction runs off the main thread.
   *
   * This does not change renderer-ready semantics. The consumer still awaits
   * this before it constructs hydrology, and still constructs hydrology
   * before it reports ready; only the position of the await moved, from
   * "immediately, blocking" to "just before the one consumer that needs it".
   * Producers that do not extract (the single-shot CPU reference, any
   * injected extractor port) resolve it already-settled, so nothing waits.
   */
  readonly channelGraph: Promise<TerrainChannelGraphExport>;
  /** Dedicated transfer-owned copy; canonical `evolution.heightMeters` remains retained. */
  readonly macroGrid: TerrainMacroGrid;
  readonly elapsedMilliseconds: number;
  readonly samplingElapsedMilliseconds: number;
}

export type TerrainEvolutionRuntimeResult =
  | AnalyticTerrainEvolutionRuntimeResult
  | ErodedTerrainEvolutionRuntimeResult;

/**
 * What a macro producer hands back. `W-1e` adds the optional `channelGraph`:
 * a producer that extracts the graph itself (the staged worker) supplies a
 * promise for it, and one that does not simply omits the field, which routes
 * the runtime to its own extractor port. The single-shot
 * `TerrainMacroEvolutionClient` satisfies this structurally, unchanged.
 */
export interface TerrainMacroEvolutionRuntimeMacroResult
  extends TerrainMacroEvolutionClientResult {
  readonly channelGraph?: Promise<TerrainChannelGraphExport>;
}

export interface TerrainMacroEvolutionClientPort {
  initialize(
    world: Pick<WorldDefinition, "seed" | "seedHash" | "seaLevel">,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainMacroEvolutionRuntimeMacroResult>;
  dispose(): void;
}

export interface TerrainChannelExtractorPort {
  extract(evolution: TerrainMacroEvolutionExport): TerrainChannelGraphExport;
}

/**
 * The `W-1a` GPU seam: a one-shot producer that turns stage-1 operator inputs
 * into the stream-power+talus-evolved surface. Structural on purpose — the
 * runtime stays free of Babylon value imports, and tests substitute a fake.
 */
export interface TerrainMacroErosionGpuPort {
  /** Provenance label distinguishing the hybrid path (e.g. `gpu-macro-v1/...`). */
  readonly deviceFingerprint: string;
  run(inputs: TerrainMacroErosionGpuRunInputs): Promise<TerrainMacroErosionGpuRunResult>;
}

/** The three macro operator input fields, however they were produced. */
export interface TerrainMacroInputsGpuSample {
  readonly heights: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
}

/**
 * The `W-1b` sampling seam: an on-device twin of the worker's uplift/geology
 * samplers over the same cell-centred macro grid. Structural like the erosion
 * port (no Babylon value imports here); `TerrainMacroInputsGpu` satisfies it,
 * and its richer result type is a structural superset.
 */
export interface TerrainMacroInputsGpuPort {
  sampleMacroInputs(
    request: TerrainMacroInputsGpuRequest,
  ): Promise<TerrainMacroInputsGpuSample>;
}

/**
 * `D-3` landscape families for the hybrid producer. The fingerprint promises
 * same-device reproducibility, never cross-device identity, so it must name
 * every choice that changes the landscape — not only the adapter.
 *
 * `v1` and `v2` are two different landscapes on the SAME device. CPU-sampled
 * and GPU-sampled macro inputs agree only to tolerance (measured at 1024²:
 * mean |Δh| 4.1e-4 m, isolated maxima ~1 m where the fabric-direction field
 * passes through zero), and the drainage solve amplifies that into different
 * receiver choices at f32 ties — different lakes, different channel seeds.
 * Anything keyed on the fingerprint (a cache, a golden comparison, a bug
 * report) must not fold the two together, which a shared `gpu-macro-v1` label
 * would invite.
 *
 * The families live here rather than beside `TerrainMacroErosionGpu`'s
 * adapter label because only the composer knows which one actually ran: GPU
 * sampling fails OPEN back to the CPU sampler.
 */
const CPU_SAMPLED_MACRO_FAMILY = "gpu-macro-v1";
const GPU_SAMPLED_MACRO_FAMILY = "gpu-macro-v2";

/**
 * Re-family an erosion port's label for the GPU-sampled composition. Total by
 * construction: a label from some other producer keeps its own identity
 * behind the family token instead of being silently dropped.
 */
export function gpuSampledMacroFingerprint(erosionFingerprint: string): string {
  if (erosionFingerprint === GPU_SAMPLED_MACRO_FAMILY
    || erosionFingerprint.startsWith(`${GPU_SAMPLED_MACRO_FAMILY}/`)) {
    return erosionFingerprint;
  }
  if (erosionFingerprint === CPU_SAMPLED_MACRO_FAMILY) return GPU_SAMPLED_MACRO_FAMILY;
  if (erosionFingerprint.startsWith(`${CPU_SAMPLED_MACRO_FAMILY}/`)) {
    return `${GPU_SAMPLED_MACRO_FAMILY}/`
      + erosionFingerprint.slice(CPU_SAMPLED_MACRO_FAMILY.length + 1);
  }
  return `${GPU_SAMPLED_MACRO_FAMILY}/${erosionFingerprint}`;
}

/** Like TerrainMacroEvolutionWorkerLike, but staged commands carry transfers. */
export interface TerrainMacroEvolutionStagedWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: TerrainMacroEvolutionWorkerCommand, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface TerrainEvolutionRuntimeOptions {
  readonly deviceFingerprint?: string;
  readonly onProgress?: (progress: TerrainMacroEvolutionProgress) => void;
  readonly macroClientFactory?: (
    options: TerrainMacroEvolutionClientOptions,
  ) => TerrainMacroEvolutionClientPort;
  readonly channelExtractor?: TerrainChannelExtractorPort;
  /**
   * Opt-in hybrid eroded path (`W-1a`): when present, eroded initialization
   * splits into worker stage 1 (sampling + flood + MFD), the GPU stream-
   * power/talus leg, and worker stage 2 (drainage tail). When absent the
   * single-shot CPU worker path runs byte-identically to before. The runtime
   * does not own the port; the caller disposes it after initialization.
   */
  readonly gpuMacroErosion?: TerrainMacroErosionGpuPort;
  /**
   * Opt-in GPU macro INPUT sampling (`W-1b`), only meaningful alongside
   * `gpuMacroErosion`. When present the hybrid path samples uplift/geology on
   * device and the worker's stage 1 shrinks to the sequential flood/MFD head;
   * when absent (or when the sampling leg fails) the worker samples on the
   * CPU exactly as before. The caller owns and disposes the port.
   */
  readonly gpuMacroInputs?: TerrainMacroInputsGpuPort;
  /** Test seam for the staged worker; production uses the real module worker. */
  readonly hybridWorkerFactory?: () => TerrainMacroEvolutionStagedWorkerLike;
}

type EvolutionWorld = Pick<
  WorldDefinition,
  "seed" | "seedHash" | "seaLevel" | "worldEvolution"
>;

function cancellationError(): Error {
  const error = new Error("Terrain evolution initialization was superseded");
  error.name = "AbortError";
  return error;
}

function requireEvolutionMode(value: WorldEvolution): void {
  if (value !== "analytic" && value !== "eroded") {
    throw new RangeError(`Unsupported world evolution mode ${String(value)}`);
  }
}

const defaultStagedWorkerFactory = (): TerrainMacroEvolutionStagedWorkerLike => {
  if (typeof Worker === "undefined") throw new Error("Terrain macro Worker is unavailable");
  return new Worker(
    new URL("../../../workers/terrainMacroEvolution.worker.ts", import.meta.url),
    { type: "module", name: "aerolith-terrain-macro-evolution-hybrid" },
  ) as unknown as TerrainMacroEvolutionStagedWorkerLike;
};

export interface TerrainMacroEvolutionHybridClientOptions {
  readonly gpu: TerrainMacroErosionGpuPort;
  /** `W-1b`: on-device macro input sampling; absent keeps the CPU sampler. */
  readonly inputs?: TerrainMacroInputsGpuPort;
  readonly workerFactory?: () => TerrainMacroEvolutionStagedWorkerLike;
}

/** What the sampling leg hands the stage-1 command, plus its own timing. */
interface PresampledMacroInputs extends TerrainMacroInputsGpuSample {
  readonly elapsedMilliseconds: number;
}

interface PendingStagedRequest {
  readonly requestId: number;
  readonly resolve: (event: StagedWorkerEvent) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined;
}

/** `W-1e`: the post-completion channel-graph slot; see `channelGraphFollows`. */
interface PendingChannelGraph {
  readonly requestId: number;
  readonly resolve: (graph: TerrainChannelGraphExport) => void;
  readonly reject: (error: Error) => void;
}

type StagedWorkerEvent = Extract<
  TerrainMacroEvolutionStagedWorkerEvent,
  { type: "stage1" | "complete" }
>;

/**
 * `W-1a` hybrid macro producer: worker stage 1 (sampling + first flood/MFD)
 * -> main-thread GPU stream power + talus -> worker stage 2 (drainage tail).
 * With a `W-1b` inputs port the sampling moves onto the device too and stage 1
 * shrinks to the flood/MFD head.
 *
 * Implements the same client port the single-shot CPU worker client does, so
 * TerrainEvolutionRuntime's orchestration, state machine and publication
 * contracts are untouched. Like that client, there is no inline fallback for
 * the EROSION leg: a failed GPU run or worker fails explicitly rather than
 * blocking startup on a silent 2 s CPU rerun (the recorded macro-client
 * doctrine). The SAMPLING leg is the deliberate exception — see
 * {@link samplePresampledInputs}.
 */
export class TerrainMacroEvolutionHybridClient implements TerrainMacroEvolutionClientPort {
  private readonly gpu: TerrainMacroErosionGpuPort;
  private readonly inputs: TerrainMacroInputsGpuPort | undefined;
  private readonly workerFactory: () => TerrainMacroEvolutionStagedWorkerLike;
  private worker: TerrainMacroEvolutionStagedWorkerLike | null = null;
  private pending: PendingStagedRequest | null = null;
  private pendingGraph: PendingChannelGraph | null = null;
  private nextRequestId = 1;
  private disposed = false;

  constructor(options: TerrainMacroEvolutionHybridClientOptions) {
    this.gpu = options.gpu;
    this.inputs = options.inputs;
    this.workerFactory = options.workerFactory ?? defaultStagedWorkerFactory;
  }

  async initialize(
    world: Pick<WorldDefinition, "seed" | "seedHash" | "seaLevel">,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainMacroEvolutionRuntimeMacroResult> {
    if (this.disposed) throw new Error("TerrainMacroEvolutionHybridClient is disposed");
    if (!world.seed) throw new RangeError("Terrain macro world seed must not be empty");
    if (!Number.isSafeInteger(world.seedHash)) {
      throw new RangeError("Terrain macro seed hash must be a safe integer");
    }
    if (!Number.isFinite(world.seaLevel)) {
      throw new RangeError("Terrain macro sea level must be finite");
    }
    const startedAt = performance.now();
    let graphFollows = false;
    // The worker is constructed BEFORE the sampling leg so its module load
    // overlaps the on-device sampling instead of queueing behind it.
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = this.handleMessage;
    worker.onerror = (event) => {
      const failure = new Error(event.message || "Terrain macro evolution Worker failed");
      event.preventDefault?.();
      this.failPending(failure);
      this.failPendingGraph(failure);
    };
    worker.onmessageerror = () => {
      const failure = new Error("Terrain macro evolution result could not be deserialized");
      this.failPending(failure);
      this.failPendingGraph(failure);
    };
    try {
      const presampled = await this.samplePresampledInputs(world, onProgress);
      // Provenance names the composition that actually ran, which is only
      // known here because sampling fails open (see D-3 families above).
      const deviceFingerprint = presampled
        ? gpuSampledMacroFingerprint(this.gpu.deviceFingerprint)
        : this.gpu.deviceFingerprint;
      const stage1Event = await this.request(
        presampled
          ? {
            type: "evolve-stage1-presampled",
            requestId: this.nextRequestId++,
            seaLevelMeters: world.seaLevel,
            heights: presampled.heights,
            erodibility: presampled.erodibility,
            reposeDegrees: presampled.reposeDegrees,
          }
          : {
            type: "evolve-stage1",
            requestId: this.nextRequestId++,
            worldSeed: world.seed,
            seedHash: world.seedHash,
            seaLevelMeters: world.seaLevel,
            deviceFingerprint,
          },
        presampled
          ? [
            presampled.heights.buffer as ArrayBuffer,
            presampled.erodibility.buffer as ArrayBuffer,
            presampled.reposeDegrees.buffer as ArrayBuffer,
          ]
          : undefined,
        onProgress,
      );
      if (stage1Event.type !== "stage1") {
        throw new Error("Terrain macro stage 1 returned an unexpected completion");
      }
      this.throwIfDisposed();
      const gpuResult = await this.gpu.run({
        width: EVOLUTION_DOMAIN_TEXELS,
        height: EVOLUTION_DOMAIN_TEXELS,
        texelSizeMeters: EVOLUTION_TEXEL_METERS,
        seaLevel: world.seaLevel,
        heights: stage1Event.stage1.heights,
        receivers: stage1Event.stage1.receivers,
        flowAccumulation: stage1Event.stage1.flowAccumulation,
        erodibility: stage1Event.stage1.erodibility,
        reposeDegrees: stage1Event.stage1.reposeDegrees,
        erosionMask: stage1Event.stage1.erosionMask,
      });
      this.throwIfDisposed();
      const completeEvent = await this.request({
        type: "evolve-stage2",
        requestId: this.nextRequestId++,
        worldSeed: world.seed,
        seaLevelMeters: world.seaLevel,
        deviceFingerprint,
        evolvedHeightMeters: gpuResult.evolvedHeight,
      }, [gpuResult.evolvedHeight.buffer as ArrayBuffer], onProgress);
      if (completeEvent.type !== "complete") {
        throw new Error("Terrain macro stage 2 returned an unexpected completion");
      }
      // W-1e: when the producer says a graph follows, the worker stays
      // attached until it lands and the macro product resolves NOW, so the
      // consumer's device-resource construction overlaps the extraction.
      const channelGraph = completeEvent.channelGraphFollows === true
        ? this.awaitChannelGraph(completeEvent.requestId)
        : undefined;
      graphFollows = channelGraph !== undefined;
      return Object.freeze({
        evolution: completeEvent.evolution,
        macroGrid: terrainMacroGridFromEvolution(completeEvent.evolution),
        elapsedMilliseconds: performance.now() - startedAt,
        // On the presampled path the worker reports zero sampling time; the
        // measurement that means anything is the device leg timed here.
        samplingElapsedMilliseconds: presampled
          ? presampled.elapsedMilliseconds
          : stage1Event.samplingElapsedMilliseconds,
        workerGenerated: true as const,
        ...(channelGraph ? { channelGraph } : {}),
      });
    } finally {
      if (!graphFollows) this.detachWorker();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending(cancellationError());
    this.failPendingGraph(cancellationError());
    this.detachWorker();
  }

  /**
   * The post-completion graph slot. It settles on the `channel-graph` event,
   * on a worker error, or on disposal; the worker is released either way, and
   * a rejection routes the consumer to its own extractor.
   */
  private awaitChannelGraph(requestId: number): Promise<TerrainChannelGraphExport> {
    return new Promise<TerrainChannelGraphExport>((resolve, reject) => {
      if (this.disposed || !this.worker) {
        reject(new Error("Terrain macro hybrid worker is unavailable"));
        return;
      }
      this.pendingGraph = { requestId, resolve, reject };
    }).finally(() => {
      this.pendingGraph = null;
      this.detachWorker();
    });
  }

  /**
   * `W-1b`: sample the three macro operator inputs on device, or return null
   * to leave the sampling to the worker's CPU pass.
   *
   * This leg fails OPEN, unlike the fail-closed stream-power/talus leg above,
   * and the asymmetry is a real difference in kind rather than a softened
   * rule. Stream power and talus have no CPU twin on this path — falling back
   * would mean a silent ~2.0 s rerun of work the plan moved to the GPU
   * precisely because it is the dominant cost, so a failure there is a defect
   * that must surface. Sampling DOES have an exact twin already sitting in
   * the worker on the other side of the same command: `evolve-stage1` samples
   * and floods in one message, so the fallback costs one branch and buys back
   * only the ~1.0 s the GPU pass was saving. Failing closed here would trade
   * a slower load for no load at all.
   *
   * The two products are different landscapes, not two spellings of one (the
   * D-3 families above), so the chosen branch is stamped into provenance.
   */
  private async samplePresampledInputs(
    world: Pick<WorldDefinition, "seedHash">,
    onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined,
  ): Promise<PresampledMacroInputs | null> {
    const port = this.inputs;
    if (!port) return null;
    const request: TerrainMacroInputsGpuRequest = {
      seedHash: world.seedHash,
      width: EVOLUTION_DOMAIN_TEXELS,
      height: EVOLUTION_DOMAIN_TEXELS,
      minWorldX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX,
      minWorldZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
    };
    const startedAt = performance.now();
    let sample: TerrainMacroInputsGpuSample;
    try {
      sample = await port.sampleMacroInputs(request);
    } catch {
      return null;
    }
    // A disposal during sampling is a cancellation, not a sampling failure:
    // it must abort rather than fall through into a CPU sampling pass.
    this.throwIfDisposed();
    const elapsedMilliseconds = performance.now() - startedAt;
    try {
      // The worker will only report `evolving-landscape` from here, so close
      // out the sampling phase the runtime's initial progress opened.
      onProgress?.(Object.freeze({
        phase: "sampling-uplift" as const,
        completed: EVOLUTION_DOMAIN_TEXELS,
        total: EVOLUTION_DOMAIN_TEXELS,
        overallFraction: 0.45,
      }));
    } catch {
      // Observer errors never corrupt a Class-K generation already running.
    }
    return {
      heights: sample.heights,
      erodibility: sample.erodibility,
      reposeDegrees: sample.reposeDegrees,
      elapsedMilliseconds,
    };
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw cancellationError();
  }

  private request(
    command: TerrainMacroEvolutionWorkerCommand,
    transfer: Transferable[] | undefined,
    onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined,
  ): Promise<StagedWorkerEvent> {
    return new Promise<StagedWorkerEvent>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error("Terrain macro hybrid worker is unavailable"));
        return;
      }
      this.pending = { requestId: command.requestId, resolve, reject, onProgress };
      try {
        worker.postMessage(command, transfer);
      } catch (error) {
        this.failPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    const pending = this.pending;
    // W-1e: after the macro product resolves the only outstanding slot is the
    // channel graph, which arrives with the same request id.
    const pendingGraph = this.pendingGraph;
    if (!pending && !pendingGraph) return;
    const expectedRequestId = pending?.requestId ?? pendingGraph!.requestId;
    if (!isTerrainMacroEvolutionStagedWorkerEvent(message.data)) {
      const candidate = message.data as { readonly requestId?: unknown } | null;
      if (candidate?.requestId === expectedRequestId) {
        const failure = new Error("Terrain macro evolution Worker returned an invalid payload");
        if (pending) this.failPending(failure);
        else this.failPendingGraph(failure);
      }
      return;
    }
    const event = message.data;
    if (event.requestId !== expectedRequestId) return;
    if (!pending) {
      if (event.type === "channel-graph") {
        this.pendingGraph = null;
        pendingGraph!.resolve(event.graph);
      } else if (event.type === "error") {
        this.failPendingGraph(new Error(event.message));
      }
      return;
    }
    if (event.type === "channel-graph") return;
    if (event.type === "progress") {
      try {
        pending.onProgress?.(Object.freeze({
          phase: event.phase,
          completed: event.completed,
          total: event.total,
          overallFraction: event.overallFraction,
        }));
      } catch {
        // Observer errors never corrupt a Class-K generation already running.
      }
      return;
    }
    if (event.type === "error") {
      this.failPending(new Error(event.message));
      return;
    }
    this.pending = null;
    pending.resolve(event);
  };

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private failPendingGraph(error: Error): void {
    const pendingGraph = this.pendingGraph;
    this.pendingGraph = null;
    pendingGraph?.reject(error);
  }

  private detachWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    this.worker = null;
  }
}

export class TerrainEvolutionRuntime {
  private readonly deviceFingerprint: string | undefined;
  private readonly onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined;
  private readonly macroClientFactory: (
    options: TerrainMacroEvolutionClientOptions,
  ) => TerrainMacroEvolutionClientPort;
  private readonly channelExtractor: TerrainChannelExtractorPort;
  private readonly gpuMacroErosion: TerrainMacroErosionGpuPort | undefined;
  private readonly gpuMacroInputs: TerrainMacroInputsGpuPort | undefined;
  private readonly hybridWorkerFactory:
    | (() => TerrainMacroEvolutionStagedWorkerLike)
    | undefined;
  private macroClient: TerrainMacroEvolutionClientPort | null = null;
  private generation = 0;
  private currentState: TerrainEvolutionRuntimeState = "idle";
  private currentProgress: TerrainMacroEvolutionProgress | null = null;
  private currentResult: TerrainEvolutionRuntimeResult | null = null;
  private currentError: Error | null = null;
  private macroPublished = false;

  constructor(options: TerrainEvolutionRuntimeOptions = {}) {
    this.deviceFingerprint = options.deviceFingerprint;
    this.onProgress = options.onProgress;
    this.macroClientFactory = options.macroClientFactory
      ?? ((clientOptions) => new TerrainMacroEvolutionClient(clientOptions));
    this.channelExtractor = options.channelExtractor ?? new ChannelNetwork();
    this.gpuMacroErosion = options.gpuMacroErosion;
    this.gpuMacroInputs = options.gpuMacroInputs;
    this.hybridWorkerFactory = options.hybridWorkerFactory;
  }

  get state(): TerrainEvolutionRuntimeState {
    return this.currentState;
  }

  get progress(): TerrainMacroEvolutionProgress | null {
    return this.currentProgress;
  }

  get result(): TerrainEvolutionRuntimeResult | null {
    return this.currentResult;
  }

  get error(): Error | null {
    return this.currentError;
  }

  get hasPublishedMacro(): boolean {
    return this.macroPublished;
  }

  async initialize(
    world: EvolutionWorld,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainEvolutionRuntimeResult> {
    if (this.currentState === "disposed") {
      throw new Error("TerrainEvolutionRuntime is disposed");
    }
    requireEvolutionMode(world.worldEvolution);
    this.generation += 1;
    const generation = this.generation;
    this.macroClient?.dispose();
    this.macroClient = null;
    this.currentProgress = null;
    this.currentResult = null;
    this.currentError = null;
    this.macroPublished = false;

    if (world.worldEvolution === "analytic") {
      const result: AnalyticTerrainEvolutionRuntimeResult = Object.freeze({
        mode: "analytic",
        evolution: null,
        channelGraph: null,
        macroGrid: null,
      });
      this.currentResult = result;
      this.currentState = "ready";
      return result;
    }

    this.currentState = "initializing";
    const initialProgress = Object.freeze({
      phase: "sampling-uplift" as const,
      completed: 0,
      total: EVOLUTION_DOMAIN_TEXELS,
      overallFraction: 0,
    });
    this.currentProgress = initialProgress;
    const clientOptions: TerrainMacroEvolutionClientOptions = {
      ...(this.deviceFingerprint ? { deviceFingerprint: this.deviceFingerprint } : {}),
    };
    let client: TerrainMacroEvolutionClientPort;
    try {
      // The hybrid GPU path is opt-in; without a port the single-shot CPU
      // worker client runs byte-identically to before W-1a.
      client = this.gpuMacroErosion
        ? new TerrainMacroEvolutionHybridClient({
          gpu: this.gpuMacroErosion,
          ...(this.gpuMacroInputs ? { inputs: this.gpuMacroInputs } : {}),
          ...(this.hybridWorkerFactory ? { workerFactory: this.hybridWorkerFactory } : {}),
        })
        : this.macroClientFactory(clientOptions);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.currentProgress = null;
      this.currentError = failure;
      this.currentState = "failed";
      throw failure;
    }
    this.macroClient = client;
    const reportProgress = (progress: TerrainMacroEvolutionProgress): void => {
      if (generation !== this.generation || this.currentState !== "initializing") return;
      this.currentProgress = progress;
      try {
        this.onProgress?.(progress);
      } catch {
        // Monitoring callbacks cannot change deterministic world content.
      }
      try {
        onProgress?.(progress);
      } catch {
        // Same rule for the per-initialization observer.
      }
    };

    try {
      const macro = await client.initialize(world, reportProgress);
      if (generation !== this.generation) {
        throw cancellationError();
      }
      // W-1e: a producer that extracted the graph itself hands back a promise
      // for it; anything else (the single-shot CPU client, an injected test
      // extractor) is extracted here, synchronously, exactly as before — an
      // extractor that throws still fails `initialize`.
      const producerGraph = macro.channelGraph;
      let channelGraph: Promise<TerrainChannelGraphExport>;
      if (producerGraph) {
        channelGraph = producerGraph.then((graph) => {
          const issues = validateTerrainChannelGraphExport(graph);
          if (issues.length > 0) {
            const first = issues[0]!;
            throw new Error(
              `Producer channel graph failed validation at ${first.path}: ${first.message}`,
            );
          }
          return graph;
        }).catch((error: unknown) => {
          // A superseded or disposed generation must not silently re-extract.
          if (generation !== this.generation) throw error;
          return this.channelExtractor.extract(macro.evolution);
        });
        // The producer owns its worker until the graph lands.
        void channelGraph.then(
          () => this.releaseClient(client),
          () => this.releaseClient(client),
        );
        // Consumers await this promise; this handler only stops an unhandled
        // rejection when they have not reached their await yet.
        channelGraph.catch(() => undefined);
      } else {
        channelGraph = Promise.resolve(this.channelExtractor.extract(macro.evolution));
      }
      const result: ErodedTerrainEvolutionRuntimeResult = Object.freeze({
        mode: "eroded",
        evolution: macro.evolution,
        channelGraph,
        macroGrid: macro.macroGrid,
        elapsedMilliseconds: macro.elapsedMilliseconds,
        samplingElapsedMilliseconds: macro.samplingElapsedMilliseconds,
      });
      this.currentProgress = Object.freeze({
        phase: "evolving-landscape",
        completed: 1,
        total: 1,
        overallFraction: 1,
      });
      this.currentResult = result;
      this.currentState = "ready";
      if (!producerGraph) this.releaseClient(client);
      return result;
    } catch (error) {
      this.releaseClient(client);
      const failure = error instanceof Error ? error : new Error(String(error));
      if (generation === this.generation) {
        this.currentProgress = null;
        this.currentError = failure;
        this.currentState = "failed";
      }
      throw failure;
    }
  }

  private releaseClient(client: TerrainMacroEvolutionClientPort): void {
    client.dispose();
    if (this.macroClient === client) this.macroClient = null;
  }

  /**
   * Transfers the retained simulation copy at most once. The parameter is
   * structural on purpose: importing render/types or SimulationClient here
   * would invert the terrain/runtime dependency. Real publishers detach the
   * macro-grid buffer; canonical evolution height remains a separate buffer.
   */
  publishMacroOnce(publisher: {
    publishTerrainMacro(macro: TerrainMacroGrid): void;
  }): boolean {
    const result = this.currentResult;
    if (this.macroPublished || result?.mode !== "eroded") return false;
    publisher.publishTerrainMacro(result.macroGrid);
    this.macroPublished = true;
    return true;
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.generation += 1;
    this.macroClient?.dispose();
    this.macroClient = null;
    this.currentProgress = null;
    this.currentResult = null;
    this.currentError = null;
    this.macroPublished = false;
    this.currentState = "disposed";
  }
}
