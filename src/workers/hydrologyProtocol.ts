import type {
  HydrologyGenerationConfig,
  HydrologyGenerationResult,
} from "@/src/render/webgpu/water/HydrologyGeneration";
import type { WorldSeed } from "@/src/world";
import {
  isPackedHydrologyRegionGeometry,
  type PackedHydrologyRegionGeometry,
} from "@/src/render/webgpu/water/hydrologyMeshArrays";

export type HydrologyWorkerGenerationOptions = Partial<HydrologyGenerationConfig>;

export type HydrologyWorkerCommand =
  | { readonly type: "initialize"; readonly worldSeed: WorldSeed }
  | {
      readonly type: "generate";
      readonly requestId: number;
      readonly generation: number;
      readonly key: string;
      readonly options: HydrologyWorkerGenerationOptions;
      /**
       * P2b: also build the region's river and lake vertex arrays and
       * transfer them, so the main thread only uploads meshes.
       */
      readonly buildGeometry?: boolean;
    };

export type HydrologyWorkerEvent =
  | {
      readonly type: "region";
      readonly requestId: number;
      readonly generation: number;
      readonly key: string;
      readonly elapsedMilliseconds: number;
      readonly hydrology: HydrologyGenerationResult;
      /** Present when the command asked for it (P2b). */
      readonly geometry?: PackedHydrologyRegionGeometry;
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
    && Boolean(candidate.hydrology && typeof candidate.hydrology === "object")
    && (candidate.geometry === undefined || isPackedHydrologyRegionGeometry(candidate.geometry));
}

