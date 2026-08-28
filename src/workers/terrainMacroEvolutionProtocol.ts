import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  type TerrainMacroEvolutionExport,
} from "@/src/render/webgpu/terrain/TerrainEvolutionContract";

export type TerrainMacroEvolutionPhase = "sampling-uplift" | "evolving-landscape";

export interface TerrainMacroEvolutionWorkerCommand {
  readonly type: "initialize";
  readonly requestId: number;
  readonly worldSeed: string;
  readonly seedHash: number;
  readonly seaLevelMeters: number;
  readonly deviceFingerprint: string;
}

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
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly message: string;
    };

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
    && evolution.heightMeters instanceof Float32Array
    && evolution.heightMeters.length === EVOLUTION_DOMAIN_SAMPLE_COUNT
    && evolution.flowAccumulationAreaM2 instanceof Float32Array
    && evolution.flowAccumulationAreaM2.length === EVOLUTION_DOMAIN_SAMPLE_COUNT
    && evolution.lakeMask instanceof Uint8Array
    && evolution.lakeMask.length === EVOLUTION_DOMAIN_SAMPLE_COUNT
    && evolution.channelSeedTexelIndices instanceof Uint32Array,
  );
}
