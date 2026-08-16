import type {
  HydrologyGenerationConfig,
  HydrologyGenerationResult,
} from "@/src/render/webgpu/water/HydrologyGeneration";
import type { WorldSeed } from "@/src/world";

export type HydrologyWorkerGenerationOptions = Partial<HydrologyGenerationConfig>;

export type HydrologyWorkerCommand =
  | { readonly type: "initialize"; readonly worldSeed: WorldSeed }
  | {
      readonly type: "generate";
      readonly requestId: number;
      readonly generation: number;
      readonly key: string;
      readonly options: HydrologyWorkerGenerationOptions;
    };

export type HydrologyWorkerEvent =
  | {
      readonly type: "region";
      readonly requestId: number;
      readonly generation: number;
      readonly key: string;
      readonly elapsedMilliseconds: number;
      readonly hydrology: HydrologyGenerationResult;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly generation: number;
      readonly key: string;
      readonly message: string;
    };

export function isHydrologyWorkerEvent(value: unknown): value is HydrologyWorkerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.type !== "region" && candidate.type !== "error")
    || !Number.isSafeInteger(candidate.requestId)
    || !Number.isSafeInteger(candidate.generation)
    || typeof candidate.key !== "string"
  ) return false;
  if (candidate.type === "error") return typeof candidate.message === "string";
  return Number.isFinite(candidate.elapsedMilliseconds)
    && Boolean(candidate.hydrology && typeof candidate.hydrology === "object");
}

