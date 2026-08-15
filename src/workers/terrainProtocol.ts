import type { TerrainTileData, TerrainTileOptions, WorldSeed } from "@/src/world";

export type TerrainWorkerCommand =
  | { type: "initialize"; seed: WorldSeed }
  | {
      type: "generate";
      requestId: number;
      generation: number;
      key: string;
      options: TerrainTileOptions;
    };

export type TerrainWorkerEvent =
  | {
      type: "tile";
      requestId: number;
      generation: number;
      key: string;
      tile: TerrainTileData;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      key: string;
      message: string;
    };

/** Runtime guard for messages crossing the worker boundary. */
export function isTerrainWorkerEvent(value: unknown): value is TerrainWorkerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.type !== "tile" && candidate.type !== "error") ||
    !Number.isInteger(candidate.requestId) ||
    !Number.isInteger(candidate.generation) ||
    typeof candidate.key !== "string"
  ) {
    return false;
  }
  if (candidate.type === "error") return typeof candidate.message === "string";
  return Boolean(candidate.tile && typeof candidate.tile === "object");
}
