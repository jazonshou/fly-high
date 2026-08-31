import type {
  DetailPresentationBuildCatalog,
  DetailPresentationChunkStatistics,
} from "@/src/render/webgpu/detail/presentationBuild";
import type { RenderedDensityLaw } from "@/src/render/webgpu/detail/renderedDensity";
import type {
  DetailFloatingOrigin,
  DetailLod,
  GeneratedDetailCell,
} from "@/src/render/webgpu/detail/types";
import type { TerrainAuxPagePublication } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import type { WorldDefinition, WorldSeed } from "@/src/world";
import type { TerrainMacroGrid, TerrainPagePublication } from "./terrainAuthority";

/** Lightweight main-thread handle for one full cell retained by the worker. */
export interface DetailRetainedCellDescriptor {
  /** Unique for the worker lifetime; released tokens are never reused. */
  readonly token: number;
  readonly key: string;
  readonly cellX: number;
  readonly cellZ: number;
  readonly cellSizeMeters: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly counts: {
    readonly trees: number;
    readonly shrubs: number;
    readonly rocks: number;
    readonly clutter: number;
    readonly groundCover: number;
  };
}

/** Per-build view of a retained cell; large placement arrays stay in the worker. */
export interface DetailWorkerPresentationResident {
  readonly token: number;
  readonly lod: DetailLod;
  readonly distance: number;
}

export interface DetailWorkerPresentationBuildInput {
  readonly residents: readonly DetailWorkerPresentationResident[];
  readonly floatingOrigin: DetailFloatingOrigin;
  readonly densityLaw: RenderedDensityLaw;
  readonly treeVariantCap: number;
  readonly treePrototypeMode: "families" | "species";
  readonly grassRadiusMeters: number;
  /** Wave G: the compute blade system replaces grass-archetype patches. */
  readonly groundCoverBladesActive?: boolean;
  /**
   * `6-9`: metres inside which the GPU field carries EVERY ground-cover
   * archetype, so the card path skips them there and keeps them outside.
   * 0 (or absent) means the field is inactive and the cards own all of it —
   * which is the CPU-only path CI's hosted runner always takes.
   */
  readonly groundCoverFieldRadiusMeters?: number;
  readonly observerX: number;
  readonly observerZ: number;
}

export interface DetailWorkerPresentationBatch {
  readonly prototypeKey: string;
  readonly count: number;
  /** Exact 32-byte packed record range; its backing buffer transfers to main. */
  readonly bytes: Uint8Array;
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export interface DetailWorkerPresentationResult {
  readonly buildId: number;
  readonly batches: readonly DetailWorkerPresentationBatch[];
  readonly statistics: DetailPresentationChunkStatistics;
}

/** Commands into the detail generation/presentation worker. */
export type DetailWorkerCommand =
  | {
      type: "initialize";
      worldSeed: WorldSeed;
      /** The live renderer supplies this so explicit analytic mode and authored airports survive. */
      world?: WorldDefinition;
      cellSizeMeters: number;
      seaLevelMeters: number;
      /** Cloneable Babylon-free prototype metadata used by worker presentation packing. */
      presentationCatalog?: DetailPresentationBuildCatalog;
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
      /** Compatibility false returns the legacy full cell; true retains it by token. */
      retain?: boolean;
    }
  | {
      type: "releaseCell";
      token: number;
    }
  | {
      type: "buildPresentation";
      buildId: number;
      input: DetailWorkerPresentationBuildInput;
    }
  | {
      type: "cancelPresentation";
      buildId: number;
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
      type: "retainedCell";
      requestId: number;
      generation: number;
      key: string;
      cell: DetailRetainedCellDescriptor;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      key: string;
      message: string;
    }
  | ({ type: "presentation" } & DetailWorkerPresentationResult)
  | {
      type: "presentationError";
      buildId: number;
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
    // 6-6: both ecology channels transfer, never copy. They are distinct
    // buffers from the producer, so listing both is safe — a shared buffer
    // would be transferred twice and throw, which the aux-publication shape
    // (one typed array per channel) rules out.
    const buffers: Transferable[] = [];
    for (const field of [
      command.page.shoreDistanceR16Sint,
      command.page.soilDepthR8Unorm,
    ]) {
      if (field.buffer instanceof ArrayBuffer && !buffers.includes(field.buffer)) {
        buffers.push(field.buffer);
      }
    }
    return buffers;
  }
  return [];
}

/** Transfer every completed packed batch without copying it through structured clone. */
export function detailWorkerEventTransferables(event: DetailWorkerEvent): Transferable[] {
  if (event.type !== "presentation") return [];
  const transfers = new Set<ArrayBuffer>();
  for (const batch of event.batches) {
    if (batch.bytes.buffer instanceof ArrayBuffer) transfers.add(batch.bytes.buffer);
  }
  return [...transfers];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteTriple(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every(isFiniteNumber);
}

function isOrderedBounds(minimum: unknown, maximum: unknown): boolean {
  return isFiniteTriple(minimum)
    && isFiniteTriple(maximum)
    && minimum.every((value, axis) => value <= maximum[axis]!);
}

function isRetainedCellDescriptor(value: unknown): value is DetailRetainedCellDescriptor {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  return Number.isSafeInteger(value.token)
    && (value.token as number) > 0
    && typeof value.key === "string"
    && value.key.length > 0
    && Number.isSafeInteger(value.cellX)
    && Number.isSafeInteger(value.cellZ)
    && isFiniteNumber(value.cellSizeMeters)
    && (value.cellSizeMeters as number) > 0
    && isFiniteNumber(value.minX)
    && isFiniteNumber(value.minZ)
    && isFiniteNumber(value.maxX)
    && isFiniteNumber(value.maxZ)
    && value.minX <= value.maxX
    && value.minZ <= value.maxZ
    && isSafeNonNegativeInteger(value.counts.trees)
    && isSafeNonNegativeInteger(value.counts.shrubs)
    && isSafeNonNegativeInteger(value.counts.rocks)
    && isSafeNonNegativeInteger(value.counts.clutter)
    && isSafeNonNegativeInteger(value.counts.groundCover);
}

function isPresentationStatistics(value: unknown): value is DetailPresentationChunkStatistics {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.nearCells)
    && isSafeNonNegativeInteger(value.midCells)
    && isSafeNonNegativeInteger(value.treeInstances)
    && isSafeNonNegativeInteger(value.shrubInstances)
    && isSafeNonNegativeInteger(value.rockInstances)
    && isSafeNonNegativeInteger(value.clutterInstances)
    && isSafeNonNegativeInteger(value.groundCoverInstances);
}

function isPresentationBatch(value: unknown): value is DetailWorkerPresentationBatch {
  if (!isRecord(value)) return false;
  return typeof value.prototypeKey === "string"
    && value.prototypeKey.length > 0
    && isSafeNonNegativeInteger(value.count)
    && value.count > 0
    && value.bytes instanceof Uint8Array
    && value.bytes.byteLength === value.count * 32
    && isOrderedBounds(value.minimum, value.maximum);
}

/** Runtime guard for messages crossing the worker boundary. */
export function isDetailWorkerEvent(value: unknown): value is DetailWorkerEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "presentationError") {
    return isSafeNonNegativeInteger(value.buildId) && typeof value.message === "string";
  }
  if (value.type === "presentation") {
    return isSafeNonNegativeInteger(value.buildId)
      && Array.isArray(value.batches)
      && value.batches.every(isPresentationBatch)
      && isPresentationStatistics(value.statistics);
  }
  if (
    (value.type !== "cell" && value.type !== "retainedCell" && value.type !== "error")
    || !isSafeNonNegativeInteger(value.requestId)
    || !isSafeNonNegativeInteger(value.generation)
    || typeof value.key !== "string"
  ) {
    return false;
  }
  if (value.type === "error") return typeof value.message === "string";
  if (value.type === "retainedCell") {
    return isRetainedCellDescriptor(value.cell) && value.cell.key === value.key;
  }
  // Full-cell delivery is a compatibility seam until the runtime switches to
  // retained descriptors. Deep placement validation would repeat the worker's
  // generation schema and make every legacy result O(instance count).
  return Boolean(value.cell && typeof value.cell === "object");
}
