import type { WorldPageKey } from "./pageKey";

export const WORLD_PAGE_SCHEMA_VERSION = 1 as const;
export const WORLD_PAGE_MATERIAL_CHANNELS = 4 as const;

/** Fixed packing used by the terrain surface texture. */
export const WORLD_PAGE_SURFACE_CHANNELS = [
  "moisture",
  "roughness",
  "wetness",
  "snow",
] as const;

export interface WorldPageLayout {
  /** World-space edge length of the page represented by this payload. */
  readonly extentMeters: number;
  /** Core height vertices per edge, including both page boundaries (normally 2^n + 1). */
  readonly heightResolution: number;
  /** Core material/surface/hydrology texels per edge (normally 2^n). */
  readonly surfaceResolution: number;
  /** Samples stored outside every edge to make filtering and derivatives seam-safe. */
  readonly gutter: number;
}

export interface QuantizedHeightPage {
  readonly format: "r16uint-linear";
  /** Row-major samples including the complete gutter. */
  readonly samples: Uint16Array;
  /** decodedHeight = offsetMeters + sample * metersPerUnit. */
  readonly offsetMeters: number;
  readonly metersPerUnit: number;
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
}

export interface QuantizedMaterialPage {
  readonly format: "rgba8unorm-weights";
  /** Four material identifiers corresponding to the RGBA weight channels. */
  readonly materialIds: Uint16Array;
  /** Row-major RGBA weights including the complete gutter. */
  readonly weights: Uint8Array;
}

export interface QuantizedSurfacePage {
  readonly format: "rgba8unorm-surface-v1";
  /** RGBA is moisture, roughness, wetness, and snow respectively. */
  readonly values: Uint8Array;
  /** One biome/ecoregion identifier for every surface texel. */
  readonly biomes: Uint8Array;
}

export interface QuantizedHydrologyPage {
  readonly format: "rg16snorm-flow+r16uint-depth+r16sint-shore+r16uint-discharge";
  /** Interleaved world-X/world-Z unit flow direction, encoded as signed normalized 16-bit. */
  readonly flowXZ: Int16Array;
  /** Zero represents dry land; non-zero values decode with depthMetersPerUnit. */
  readonly waterDepth: Uint16Array;
  /** Signed distance to shoreline. Negative values are under water. */
  readonly shoreDistance: Int16Array;
  /** Logarithmically encoded upstream discharge/flow accumulation. */
  readonly discharge: Uint16Array;
  readonly depthMetersPerUnit: number;
  readonly shoreDistanceMetersPerUnit: number;
  /** decodedDischarge = max(0, 2^(bias + sample * perUnit) - 1). */
  readonly dischargeLog2Bias: number;
  readonly dischargeLog2PerUnit: number;
}

/**
 * Immutable CPU-side page exchanged between generation workers, persistent
 * caches, and the WebGPU uploader. All large fields are directly transferable.
 */
export interface WorldPagePayload {
  readonly schemaVersion: typeof WORLD_PAGE_SCHEMA_VERSION;
  readonly key: WorldPageKey;
  /** Changes whenever deterministic content changes while the address stays stable. */
  readonly contentRevision: string;
  readonly layout: WorldPageLayout;
  readonly height: QuantizedHeightPage;
  readonly material: QuantizedMaterialPage;
  readonly surface: QuantizedSurfacePage;
  readonly hydrology: QuantizedHydrologyPage;
}

export interface WorldPageStoredDimensions {
  readonly heightEdge: number;
  readonly heightSampleCount: number;
  readonly surfaceEdge: number;
  readonly surfaceTexelCount: number;
}

export function getWorldPageStoredDimensions(
  layout: WorldPageLayout,
): WorldPageStoredDimensions {
  const heightEdge = layout.heightResolution + layout.gutter * 2;
  const surfaceEdge = layout.surfaceResolution + layout.gutter * 2;
  return {
    heightEdge,
    heightSampleCount: heightEdge * heightEdge,
    surfaceEdge,
    surfaceTexelCount: surfaceEdge * surfaceEdge,
  };
}

export function decodeWorldPageHeight(height: QuantizedHeightPage, sample: number): number {
  if (!Number.isInteger(sample) || sample < 0 || sample > 65_535) {
    throw new RangeError("Quantized height sample must be an unsigned 16-bit integer");
  }
  return height.offsetMeters + sample * height.metersPerUnit;
}

export function decodeWorldPageFlowComponent(sample: number): number {
  if (!Number.isInteger(sample) || sample < -32_768 || sample > 32_767) {
    throw new RangeError("Quantized flow sample must be a signed 16-bit integer");
  }
  return Math.max(-1, sample / 32_767);
}

export function decodeWorldPageDischarge(
  hydrology: QuantizedHydrologyPage,
  sample: number,
): number {
  if (!Number.isInteger(sample) || sample < 0 || sample > 65_535) {
    throw new RangeError("Quantized discharge sample must be an unsigned 16-bit integer");
  }
  return Math.max(
    0,
    2 ** (hydrology.dischargeLog2Bias + sample * hydrology.dischargeLog2PerUnit) - 1,
  );
}

export function estimateWorldPagePayloadBytes(payload: WorldPagePayload): number {
  return (
    payload.height.samples.byteLength +
    payload.material.materialIds.byteLength +
    payload.material.weights.byteLength +
    payload.surface.values.byteLength +
    payload.surface.biomes.byteLength +
    payload.hydrology.flowXZ.byteLength +
    payload.hydrology.waterDepth.byteLength +
    payload.hydrology.shoreDistance.byteLength +
    payload.hydrology.discharge.byteLength
  );
}

/** Unique, non-detached buffers suitable for postMessage's transfer list. */
export function getWorldPageTransferables(payload: WorldPagePayload): ArrayBuffer[] {
  const views: ArrayBufferView[] = [
    payload.height.samples,
    payload.material.materialIds,
    payload.material.weights,
    payload.surface.values,
    payload.surface.biomes,
    payload.hydrology.flowXZ,
    payload.hydrology.waterDepth,
    payload.hydrology.shoreDistance,
    payload.hydrology.discharge,
  ];
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer && view.buffer.byteLength > 0) buffers.add(view.buffer);
  }
  return [...buffers];
}
