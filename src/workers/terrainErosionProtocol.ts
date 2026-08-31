import type {
  TerrainErodedPage,
  TerrainErosionSeedMode,
} from "@/src/render/webgpu/terrain/TerrainPageErosion";
import type { TerrainMacroEvolutionExport } from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import type { WorldDefinition } from "@/src/world";
import { terrainPageHydrologyTransferables } from "@/src/render/webgpu/terrain/TerrainPageHydrology";

/**
 * Commands. `erode` is the unchanged whole-page CPU reference pass (the no-GPU
 * fallback and the ensureHydrology recovery path). The three `erode-stage-*`
 * commands are the `W-1d` staged halves the multi-frame GPU DAG round-trips
 * through: stage-seed-inputs is stateless; stage-mfd RETAINS its fields
 * worker-side under the requestId until the matching stage-finish (or
 * erode-cancel) arrives.
 */
export type TerrainErosionWorkerCommand =
  | {
      readonly type: "initialize";
      readonly world: WorldDefinition;
    }
  | {
      readonly type: "set-macro-evolution";
      readonly macro: TerrainMacroEvolutionExport | null;
    }
  | {
      readonly type: "erode";
      readonly requestId: number;
      readonly address: WorldPageAddress;
    }
  | {
      readonly type: "erode-stage-seed-inputs";
      readonly requestId: number;
      readonly address: WorldPageAddress;
      readonly seedMode: TerrainErosionSeedMode;
    }
  | {
      readonly type: "erode-stage-mfd";
      readonly requestId: number;
      readonly address: WorldPageAddress;
      readonly sourceHeight: Float32Array;
      readonly breachedHeightBits: Uint32Array;
      readonly breachReceivers: Int32Array;
      readonly flowAccumulation: Float32Array;
      readonly erosionMask: Uint8Array;
    }
  | {
      readonly type: "erode-stage-finish";
      readonly requestId: number;
      readonly evolvedHeight: Float32Array;
    }
  | {
      readonly type: "erode-cancel";
      readonly requestId: number;
    };

export type TerrainErosionWorkerEvent =
  | {
      readonly type: "page";
      readonly requestId: number;
      readonly page: TerrainErodedPage;
    }
  | {
      readonly type: "stage-seed-inputs";
      readonly requestId: number;
      readonly erosionMask: Uint8Array;
      readonly macroHeight: Float32Array | null;
      readonly macroFlow: Float32Array | null;
    }
  | {
      readonly type: "stage-mfd";
      readonly requestId: number;
      readonly receivers: Int32Array;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly message: string;
    };

/** Transferables for a staged command's large payloads (caller relinquishes). */
export function terrainErosionCommandTransferables(
  command: TerrainErosionWorkerCommand,
): Transferable[] {
  if (command.type === "erode-stage-mfd") {
    return [...new Set<Transferable>([
      command.sourceHeight.buffer as ArrayBuffer,
      command.breachedHeightBits.buffer as ArrayBuffer,
      command.breachReceivers.buffer as ArrayBuffer,
      command.flowAccumulation.buffer as ArrayBuffer,
      command.erosionMask.buffer as ArrayBuffer,
    ])];
  }
  if (command.type === "erode-stage-finish") {
    return [command.evolvedHeight.buffer as ArrayBuffer];
  }
  return [];
}

export function terrainErosionWorkerTransferables(
  event: TerrainErosionWorkerEvent,
): Transferable[] {
  if (event.type === "stage-seed-inputs") {
    return [...new Set<Transferable>([
      event.erosionMask.buffer as ArrayBuffer,
      ...(event.macroHeight ? [event.macroHeight.buffer as ArrayBuffer] : []),
      ...(event.macroFlow ? [event.macroFlow.buffer as ArrayBuffer] : []),
    ])];
  }
  if (event.type === "stage-mfd") {
    return [event.receivers.buffer as ArrayBuffer];
  }
  if (event.type !== "page") return [];
  const buffers = new Set<Transferable>([
    event.page.storedHeight.buffer as ArrayBuffer,
    ...(event.page.hydrology ? terrainPageHydrologyTransferables(event.page.hydrology) : []),
  ]);
  return [...buffers];
}

export function isTerrainErosionWorkerEvent(
  value: unknown,
): value is TerrainErosionWorkerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<TerrainErosionWorkerEvent> & {
    erosionMask?: unknown;
    macroHeight?: unknown;
    macroFlow?: unknown;
    receivers?: unknown;
  };
  if (!Number.isSafeInteger(event.requestId)) return false;
  if (event.type === "error") return typeof event.message === "string";
  if (event.type === "stage-seed-inputs") {
    if (!(event.erosionMask instanceof Uint8Array)) return false;
    const fields = [event.macroHeight, event.macroFlow];
    return fields.every((field) => field === null)
      || fields.every((field) =>
        field instanceof Float32Array && field.length === event.erosionMask!.length);
  }
  if (event.type === "stage-mfd") {
    return event.receivers instanceof Int32Array;
  }
  if (event.type !== "page" || !event.page) return false;
  const page = event.page;
  const hydrology = page.hydrology;
  const hydrologyValid = hydrology !== undefined && (hydrology === null || (
    hydrology.hydrology.flowAccum instanceof Uint16Array
    && hydrology.hydrology.lakeDepth instanceof Uint16Array
    && hydrology.hydrology.soilDepth instanceof Uint8Array
    && hydrology.hydrology.shoreDistance instanceof Int16Array
    && hydrology.upload.flowAccumR16Float instanceof Uint16Array
    && hydrology.upload.lakeDepthR16Float instanceof Uint16Array
    && hydrology.upload.soilDepthR8Unorm instanceof Uint8Array
    && hydrology.upload.shoreDistanceR16Sint instanceof Int16Array
    && hydrology.storedEdge * hydrology.storedEdge === hydrology.hydrology.flowAccum.length
  ));
  return page.storedHeight instanceof Float32Array
    && Number.isSafeInteger(page.coreSize)
    && Number.isSafeInteger(page.haloTexels)
    && Number.isSafeInteger(page.scratchEdge)
    && Number.isSafeInteger(page.storedEdge)
    && typeof page.stats === "object"
    && hydrologyValid;
}
