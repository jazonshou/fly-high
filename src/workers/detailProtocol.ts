import type { GeneratedDetailCell } from "@/src/render/webgpu/detail/types";
import type { TerrainAuxPagePublication } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import type { WorldDefinition, WorldSeed } from "@/src/world";
import type { TerrainMacroGrid, TerrainPagePublication } from "./terrainAuthority";

/** Commands into the detail generation worker (1B-10). */
export type DetailWorkerCommand =
  | {
      type: "initialize";
      worldSeed: WorldSeed;
      /** The live renderer supplies this so explicit analytic mode and authored airports survive. */
      world?: WorldDefinition;
      cellSizeMeters: number;
      seaLevelMeters: number;
    }
  | {
      type: "terrainMacro";
      macro: TerrainMacroGrid;
    }
  | {
      type: "terrainPage";
      page: TerrainPagePublication;
    }
  | {
      type: "terrainAux";
      page: TerrainAuxPagePublication;
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

/** Transfer ownership of retained terrain copies into the detail worker. */
export function detailWorkerCommandTransferables(
  command: DetailWorkerCommand,
): Transferable[] {
  if (command.type === "terrainMacro") {
    return command.macro.heights.buffer instanceof ArrayBuffer
      ? [command.macro.heights.buffer]
      : [];
  }
  if (command.type === "terrainPage") {
    return command.page.heights.buffer instanceof ArrayBuffer
      ? [command.page.heights.buffer]
      : [];
  }
  if (command.type === "terrainAux") {
    return command.page.shoreDistanceR16Sint.buffer instanceof ArrayBuffer
      ? [command.page.shoreDistanceR16Sint.buffer]
      : [];
  }
  return [];
}

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
