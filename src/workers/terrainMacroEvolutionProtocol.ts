import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainChannelGraphExport,
  type TerrainMacroEvolutionExport,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";

export type TerrainMacroEvolutionPhase = "sampling-uplift" | "evolving-landscape";

/** Single-shot CPU reference command; the fallback path and the bit oracle. */
export interface TerrainMacroEvolutionInitializeCommand {
  readonly type: "initialize";
  readonly requestId: number;
  readonly worldSeed: string;
  readonly seedHash: number;
  readonly seaLevelMeters: number;
  readonly deviceFingerprint: string;
}

/**
 * Hybrid stage 1 (`W-1a`): sample uplift/geology, run the first priority
 * flood and MFD pass, and transfer the erosion-operator inputs to the main
 * thread so the GPU can run stream power + talus.
 */
export interface TerrainMacroEvolutionStage1Command {
  readonly type: "evolve-stage1";
  readonly requestId: number;
  readonly worldSeed: string;
  readonly seedHash: number;
  readonly seaLevelMeters: number;
  readonly deviceFingerprint: string;
}

/**
 * Hybrid stage 1 with GPU-sampled inputs (`W-1b` wiring): the main thread has
 * already produced the three macro input fields on-device, so the worker only
 * runs the sequential head it cannot parallelise — first priority flood,
 * first MFD pass, submarine mask.
 *
 * A SEPARATE command rather than optional fields on `evolve-stage1`: every
 * field here is required and every field there is unused (the presampled path
 * never touches `seedHash`, and stage 1 never stamps provenance), so a union
 * member keeps both shapes total and keeps the worker's dispatch a plain
 * discriminant test instead of a validity matrix.
 *
 * The three arrays are TRANSFERRED in and transferred straight back out on
 * the `stage1` event — the same round trip `evolve-stage1` performs, so the
 * GPU erosion leg receives the identical buffers either way.
 */
export interface TerrainMacroEvolutionStage1PresampledCommand {
  readonly type: "evolve-stage1-presampled";
  readonly requestId: number;
  readonly seaLevelMeters: number;
  /**
   * Macro input fields sampled on-device at the same cell centres and filter
   * width the CPU sampler uses. Already f32 by construction, which is exactly
   * what the CPU sampler's `Math.fround` stamps guarantee, so the flood/MFD
   * head below consumes them verbatim.
   */
  readonly heights: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
}

/**
 * Hybrid stage 2 (`W-1a`): accept the GPU-evolved surface and finish the
 * drainage tail (re-flood, re-MFD, lakes, base levels, channel seeds) with
 * the same reference operators the single-shot path uses.
 */
export interface TerrainMacroEvolutionStage2Command {
  readonly type: "evolve-stage2";
  readonly requestId: number;
  readonly worldSeed: string;
  readonly seaLevelMeters: number;
  readonly deviceFingerprint: string;
  /** GPU-evolved macro surface, transferred back into the worker. */
  readonly evolvedHeightMeters: Float32Array;
}

export type TerrainMacroEvolutionWorkerCommand =
  | TerrainMacroEvolutionInitializeCommand
  | TerrainMacroEvolutionStage1Command
  | TerrainMacroEvolutionStage1PresampledCommand
  | TerrainMacroEvolutionStage2Command;

/** The transferable stage-1 product: exactly the GPU operator inputs. */
export interface TerrainMacroEvolutionStage1Fields {
  /** f32-stamped uplift heights at macro cell centres. */
  readonly heights: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
  /** Primary MFD receivers over the first filled surface. */
  readonly receivers: Int32Array;
  /** MFD contributing area in source texels over the first filled surface. */
  readonly flowAccumulation: Float32Array;
  /** 1 where the tectonic bathymetry is protected (height <= sea level). */
  readonly erosionMask: Uint8Array;
}

/**
 * The single-shot event union is UNCHANGED by the hybrid split: the
 * untouched TerrainMacroEvolutionClient narrows over exactly these three
 * members. The stage-1 event lives in the staged superset below, which only
 * the hybrid client consumes.
 */
export type TerrainMacroEvolutionWorkerEvent =
  | {
      readonly type: "progress";
      readonly requestId: number;
      readonly phase: TerrainMacroEvolutionPhase;
      readonly completed: number;
      readonly total: number;
      readonly overallFraction: number;
    }
  | {
      readonly type: "complete";
      readonly requestId: number;
      readonly elapsedMilliseconds: number;
      readonly samplingElapsedMilliseconds: number;
      readonly evolution: TerrainMacroEvolutionExport;
      /**
       * `W-1e`: true when the producer will follow this event with a
       * `channel-graph` event, so the consumer should hold the worker open and
       * wait for the graph instead of extracting it on the main thread. Absent
       * on the single-shot CPU reference path and on any producer that does
       * not extract, which keeps the main-thread extractor the fallback.
       */
      readonly channelGraphFollows?: boolean;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly message: string;
    };

export interface TerrainMacroEvolutionStage1Event {
  readonly type: "stage1";
  readonly requestId: number;
  readonly elapsedMilliseconds: number;
  readonly samplingElapsedMilliseconds: number;
  readonly stage1: TerrainMacroEvolutionStage1Fields;
}

/**
 * `W-1e`: the channel graph, extracted inside the worker from the export it
 * just completed and posted AFTER the `complete` event. Splitting it out is
 * the whole point — the consumer gets the macro product immediately and can
 * build its device resources while the extractor runs off the main thread.
 *
 * The graph is the ordinary `TerrainChannelGraphExport`, so the consumer
 * re-runs `validateTerrainChannelGraphExport` on arrival exactly as the
 * in-process extractor does before it returns one.
 */
export interface TerrainMacroEvolutionChannelGraphEvent {
  readonly type: "channel-graph";
  readonly requestId: number;
  readonly elapsedMilliseconds: number;
  readonly graph: TerrainChannelGraphExport;
}

export type TerrainMacroEvolutionStagedWorkerEvent =
  | TerrainMacroEvolutionWorkerEvent
  | TerrainMacroEvolutionStage1Event
  | TerrainMacroEvolutionChannelGraphEvent;

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDomainArray(
  value: unknown,
  constructor: new (length: number) => { readonly length: number },
): boolean {
  return value instanceof constructor && value.length === EVOLUTION_DOMAIN_SAMPLE_COUNT;
}

export function isTerrainMacroEvolutionWorkerEvent(
  value: unknown,
): value is TerrainMacroEvolutionWorkerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!isRequestId(candidate.requestId)) return false;
  if (candidate.type === "error") return typeof candidate.message === "string";
  if (candidate.type === "progress") {
    return (
      (candidate.phase === "sampling-uplift" || candidate.phase === "evolving-landscape")
      && Number.isSafeInteger(candidate.completed)
      && (candidate.completed as number) >= 0
      && Number.isSafeInteger(candidate.total)
      && (candidate.total as number) > 0
      && (candidate.completed as number) <= (candidate.total as number)
      && Number.isFinite(candidate.overallFraction)
      && (candidate.overallFraction as number) >= 0
      && (candidate.overallFraction as number) <= 1
    );
  }
  if (candidate.type !== "complete") return false;
  if (!Number.isFinite(candidate.elapsedMilliseconds)
    || (candidate.elapsedMilliseconds as number) < 0
    || !Number.isFinite(candidate.samplingElapsedMilliseconds)
    || (candidate.samplingElapsedMilliseconds as number) < 0) return false;
  const evolution = candidate.evolution as Partial<TerrainMacroEvolutionExport> | undefined;
  return Boolean(
    evolution
    && evolution.contractVersion === TERRAIN_EVOLUTION_CONTRACT_VERSION
    && isDomainArray(evolution.heightMeters, Float32Array)
    && isDomainArray(evolution.flowAccumulationAreaM2, Float32Array)
    && isDomainArray(evolution.lakeMask, Uint8Array)
    && evolution.channelSeedTexelIndices instanceof Uint32Array,
  );
}

/**
 * Structural gate for a posted channel graph. Deliberately shape-only: the
 * consumer runs the full `validateTerrainChannelGraphExport` contract check
 * on the payload, which is the real trust boundary.
 */
function isChannelGraphShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const graph = value as Partial<TerrainChannelGraphExport>;
  return graph.contractVersion === TERRAIN_EVOLUTION_CONTRACT_VERSION
    && typeof graph.provenance === "object"
    && graph.provenance !== null
    && Array.isArray(graph.nodes)
    && Array.isArray(graph.edges)
    && Array.isArray(graph.lakePolygons)
    && Array.isArray(graph.lakes);
}

/** Validator for the staged (hybrid) event superset: adds `stage1`/`channel-graph`. */
export function isTerrainMacroEvolutionStagedWorkerEvent(
  value: unknown,
): value is TerrainMacroEvolutionStagedWorkerEvent {
  if (isTerrainMacroEvolutionWorkerEvent(value)) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "channel-graph") {
    return isRequestId(candidate.requestId)
      && Number.isFinite(candidate.elapsedMilliseconds)
      && (candidate.elapsedMilliseconds as number) >= 0
      && isChannelGraphShape(candidate.graph);
  }
  if (candidate.type !== "stage1" || !isRequestId(candidate.requestId)) return false;
  if (!Number.isFinite(candidate.elapsedMilliseconds)
    || (candidate.elapsedMilliseconds as number) < 0
    || !Number.isFinite(candidate.samplingElapsedMilliseconds)
    || (candidate.samplingElapsedMilliseconds as number) < 0) return false;
  const stage1 = candidate.stage1 as Partial<TerrainMacroEvolutionStage1Fields> | undefined;
  return Boolean(
    stage1
    && isDomainArray(stage1.heights, Float32Array)
    && isDomainArray(stage1.erodibility, Float32Array)
    && isDomainArray(stage1.reposeDegrees, Float32Array)
    && isDomainArray(stage1.receivers, Int32Array)
    && isDomainArray(stage1.flowAccumulation, Float32Array)
    && isDomainArray(stage1.erosionMask, Uint8Array),
  );
}
