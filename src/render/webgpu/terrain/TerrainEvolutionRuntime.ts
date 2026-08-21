import type { TerrainMacroGrid } from "@/src/workers/terrainAuthority";
import type { WorldDefinition, WorldEvolution } from "@/src/world";
import { ChannelNetwork } from "@/src/render/webgpu/water/ChannelNetwork";
import {
  EVOLUTION_DOMAIN_TEXELS,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "./TerrainEvolutionContract";
import {
  TerrainMacroEvolutionClient,
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
  readonly channelGraph: TerrainChannelGraphExport;
  /** Dedicated transfer-owned copy; canonical `evolution.heightMeters` remains retained. */
  readonly macroGrid: TerrainMacroGrid;
  readonly elapsedMilliseconds: number;
  readonly samplingElapsedMilliseconds: number;
}

export type TerrainEvolutionRuntimeResult =
  | AnalyticTerrainEvolutionRuntimeResult
  | ErodedTerrainEvolutionRuntimeResult;

export interface TerrainMacroEvolutionClientPort {
  initialize(
    world: Pick<WorldDefinition, "seed" | "seedHash" | "seaLevel">,
    onProgress?: (progress: TerrainMacroEvolutionProgress) => void,
  ): Promise<TerrainMacroEvolutionClientResult>;
  dispose(): void;
}

export interface TerrainChannelExtractorPort {
  extract(evolution: TerrainMacroEvolutionExport): TerrainChannelGraphExport;
}

export interface TerrainEvolutionRuntimeOptions {
  readonly deviceFingerprint?: string;
  readonly onProgress?: (progress: TerrainMacroEvolutionProgress) => void;
  readonly macroClientFactory?: (
    options: TerrainMacroEvolutionClientOptions,
  ) => TerrainMacroEvolutionClientPort;
  readonly channelExtractor?: TerrainChannelExtractorPort;
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

export class TerrainEvolutionRuntime {
  private readonly deviceFingerprint: string | undefined;
  private readonly onProgress: ((progress: TerrainMacroEvolutionProgress) => void) | undefined;
  private readonly macroClientFactory: (
    options: TerrainMacroEvolutionClientOptions,
  ) => TerrainMacroEvolutionClientPort;
  private readonly channelExtractor: TerrainChannelExtractorPort;
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
      client = this.macroClientFactory(clientOptions);
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
      const channelGraph = this.channelExtractor.extract(macro.evolution);
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
      client.dispose();
      if (this.macroClient === client) this.macroClient = null;
      return result;
    } catch (error) {
      client.dispose();
      if (this.macroClient === client) this.macroClient = null;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (generation === this.generation) {
        this.currentProgress = null;
        this.currentError = failure;
        this.currentState = "failed";
      }
      throw failure;
    }
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
