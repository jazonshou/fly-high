import type { TerrainErodedPage } from "@/src/render/webgpu/terrain/TerrainPageErosion";
import type { TerrainMacroEvolutionExport } from "@/src/render/webgpu/terrain/TerrainEvolutionContract";
import type { WorldPageAddress } from "@/src/render/webgpu/world/pageKey";
import type { WorldDefinition } from "@/src/world";
import { terrainPageHydrologyTransferables } from "@/src/render/webgpu/terrain/TerrainPageHydrology";

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
    };

export type TerrainErosionWorkerEvent =
  | {
      readonly type: "page";
      readonly requestId: number;
      readonly page: TerrainErodedPage;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly message: string;
    };

export function terrainErosionWorkerTransferables(
  event: TerrainErosionWorkerEvent,
): Transferable[] {
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
  const event = value as Partial<TerrainErosionWorkerEvent>;
  if (!Number.isSafeInteger(event.requestId)) return false;
  if (event.type === "error") return typeof event.message === "string";
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
