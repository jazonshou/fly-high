import type { GeneratedDetailCell } from "@/src/render/webgpu/detail/types";
import type { WorldSeed } from "@/src/world";

/** Commands into the detail generation worker (1B-10). */
export type DetailWorkerCommand =
  | {
      type: "initialize";
      worldSeed: WorldSeed;
      cellSizeMeters: number;
      seaLevelMeters: number;
    }
  | {
      type: "generate";
      requestId: number;
      generation: number;
      key: string;
      cellX: number;
      cellZ: number;
      densityMultiplier: number;
      dayOfYear: number;
    };

export type DetailWorkerEvent =
  | {
      type: "cell";
      requestId: number;
      generation: number;
      key: string;
      cell: GeneratedDetailCell;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      key: string;
      message: string;
    };

/** Runtime guard for messages crossing the worker boundary. */
export function isDetailWorkerEvent(value: unknown): value is DetailWorkerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.type !== "cell" && candidate.type !== "error")
    || !Number.isInteger(candidate.requestId)
    || !Number.isInteger(candidate.generation)
    || typeof candidate.key !== "string"
  ) {
    return false;
  }
  if (candidate.type === "error") return typeof candidate.message === "string";
  return Boolean(candidate.cell && typeof candidate.cell === "object");
}
