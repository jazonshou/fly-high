import type { WorldPageKey } from "./pageKey";

export const WORLD_PAGE_SCHEMA_VERSION = 2 as const;
export const WORLD_PAGE_MATERIAL_CHANNELS = 4 as const;

/** Fixed packing used by the terrain surface texture. */
export const WORLD_PAGE_SURFACE_CHANNELS = [
  "moisture",
  "roughness",
  "wetness",
  "snow",
] as const;

/** Phase-5 erosion↔hydrology fields, in their canonical packed order. */
export const WORLD_PAGE_HYDROLOGY_CHANNELS = [
  "flowAccum",
  "lakeDepth",
  "soilDepth",
  "shoreDistance",
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
  readonly format: "r16uint-log-flow+r16uint-lake-depth+r8unorm-soil+r16sint-shore-v2";
  /** Logarithmically encoded upstream contributing area in square metres. */
  readonly flowAccum: Uint16Array;
  /** Zero represents dry land; non-zero values decode with lakeDepthMetersPerUnit. */
  readonly lakeDepth: Uint16Array;
  /** Linear UNORM encoding over [0, soilDepthMaxMeters]. */
  readonly soilDepth: Uint8Array;
  /** Signed distance to shoreline. Negative values are under water. */
  readonly shoreDistance: Int16Array;
  readonly lakeDepthMetersPerUnit: number;
  readonly soilDepthMaxMeters: number;
  readonly shoreDistanceMetersPerUnit: number;
  /** decodedFlowAccum = max(0, 2^(bias + sample * perUnit) - 1). */
  readonly flowAccumLog2Bias: number;
  readonly flowAccumLog2PerUnit: number;
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

export function decodeWorldPageFlowAccum(
  hydrology: QuantizedHydrologyPage,
  sample: number,
): number {
  if (!Number.isInteger(sample) || sample < 0 || sample > 65_535) {
    throw new RangeError("Quantized flow-accumulation sample must be an unsigned 16-bit integer");
  }
  return Math.max(
    0,
    2 ** (hydrology.flowAccumLog2Bias + sample * hydrology.flowAccumLog2PerUnit) - 1,
  );
}

export function encodeWorldPageFlowAccum(
  hydrology: QuantizedHydrologyPage,
  areaM2: number,
): number {
  requireFiniteNonNegative(areaM2, "Flow accumulation area");
  requireFinitePositive(hydrology.flowAccumLog2PerUnit, "flowAccumLog2PerUnit");
  const encoded = Math.round(
    (Math.log2(areaM2 + 1) - hydrology.flowAccumLog2Bias)
      / hydrology.flowAccumLog2PerUnit,
  );
  return requireQuantizedRange(encoded, 0, 65_535, "Flow accumulation area");
}

export function decodeWorldPageLakeDepth(
  hydrology: QuantizedHydrologyPage,
  sample: number,
): number {
  requireQuantizedRange(sample, 0, 65_535, "Lake-depth sample");
  requireFinitePositive(hydrology.lakeDepthMetersPerUnit, "lakeDepthMetersPerUnit");
  return sample * hydrology.lakeDepthMetersPerUnit;
}

export function encodeWorldPageLakeDepth(
  hydrology: QuantizedHydrologyPage,
  depthMeters: number,
): number {
  requireFiniteNonNegative(depthMeters, "Lake depth");
  requireFinitePositive(hydrology.lakeDepthMetersPerUnit, "lakeDepthMetersPerUnit");
  return requireQuantizedRange(
    Math.round(depthMeters / hydrology.lakeDepthMetersPerUnit),
    0,
    65_535,
    "Lake depth",
  );
}

export function decodeWorldPageSoilDepth(
  hydrology: QuantizedHydrologyPage,
  sample: number,
): number {
  requireQuantizedRange(sample, 0, 255, "Soil-depth sample");
  requireFinitePositive(hydrology.soilDepthMaxMeters, "soilDepthMaxMeters");
  return (sample / 255) * hydrology.soilDepthMaxMeters;
}

export function encodeWorldPageSoilDepth(
  hydrology: QuantizedHydrologyPage,
  depthMeters: number,
): number {
  requireFiniteNonNegative(depthMeters, "Soil depth");
  requireFinitePositive(hydrology.soilDepthMaxMeters, "soilDepthMaxMeters");
  return requireQuantizedRange(
    Math.round((depthMeters / hydrology.soilDepthMaxMeters) * 255),
    0,
    255,
    "Soil depth",
  );
}

export function decodeWorldPageShoreDistance(
  hydrology: QuantizedHydrologyPage,
  sample: number,
): number {
  requireQuantizedRange(sample, -32_768, 32_767, "Shore-distance sample");
  requireFinitePositive(
    hydrology.shoreDistanceMetersPerUnit,
    "shoreDistanceMetersPerUnit",
  );
  return sample * hydrology.shoreDistanceMetersPerUnit;
}

export function encodeWorldPageShoreDistance(
  hydrology: QuantizedHydrologyPage,
  distanceMeters: number,
): number {
  if (!Number.isFinite(distanceMeters)) {
    throw new RangeError("Shore distance must be finite");
  }
  requireFinitePositive(
    hydrology.shoreDistanceMetersPerUnit,
    "shoreDistanceMetersPerUnit",
  );
  return requireQuantizedRange(
    Math.round(distanceMeters / hydrology.shoreDistanceMetersPerUnit),
    -32_768,
    32_767,
    "Shore distance",
  );
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
}

function requireQuantizedRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the representable range`);
  }
  return value;
}

export function estimateWorldPagePayloadBytes(payload: WorldPagePayload): number {
  return (
    payload.height.samples.byteLength +
    payload.material.materialIds.byteLength +
    payload.material.weights.byteLength +
    payload.surface.values.byteLength +
    payload.surface.biomes.byteLength +
    payload.hydrology.flowAccum.byteLength +
    payload.hydrology.lakeDepth.byteLength +
    payload.hydrology.soilDepth.byteLength +
    payload.hydrology.shoreDistance.byteLength
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
    payload.hydrology.flowAccum,
    payload.hydrology.lakeDepth,
    payload.hydrology.soilDepth,
    payload.hydrology.shoreDistance,
  ];
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer && view.buffer.byteLength > 0) buffers.add(view.buffer);
  }
  return [...buffers];
}

// ---------------------------------------------------------------------------
// GPU residency encoding (`4-0`).
//
// `payload.ts` stays the SOLE owner of *what channels exist and what they
// mean*. The `Quantized*Page` types above are the **CPU/worker transfer
// encoding**: 16-bit quantised, row-major, transferable, produced by a worker
// and consumed by an uploader. From Phase 4 a page is also generated directly
// on the GPU and never has a CPU payload at all, so the same channel set needs
// a second, GPU-resident description. Both live here, in one file, because the
// channel rule ("every page-channel addition goes through one PR against this
// file") would quietly stop meaning anything if the GPU half lived elsewhere.
// ---------------------------------------------------------------------------

/** Texture formats the page atlases use. Kept to what WebGPU guarantees. */
export type WorldPageGpuFormat =
  | "r32float"
  | "rgba8unorm"
  | "r16float"
  | "r16sint"
  | "r8unorm";

/** Bytes one texel of a GPU page format occupies, per texture. */
export const WORLD_PAGE_GPU_FORMAT_BYTES: Readonly<Record<WorldPageGpuFormat, number>> =
  Object.freeze({
    r32float: 4,
    rgba8unorm: 4,
    r16float: 2,
    r16sint: 2,
    r8unorm: 1,
  });

/**
 * One GPU-resident channel family. `coreResolution` names which of the
 * layout's two cores the family stores at — never a literal, so a family can
 * never introduce a third page geometry (§1.4).
 */
export interface WorldPageChannelDescriptor {
  readonly name: string;
  readonly gpuFormat: WorldPageGpuFormat;
  readonly coreResolution: "height" | "surface";
  /** Textures of `gpuFormat` this family occupies per resident slot. */
  readonly textureCount: number;
  /**
   * True only for families whose content is a function of `dayOfYear`.
   * Exactly one family is: land cover. Height is a function of
   * `(level, x, z, seed)`, erosion runs on geological time, and occlusion and
   * the horizon field are geometry-only.
   */
  readonly seasonKeyed: boolean;
  /** The plan item that first writes this family; absent means it is live. */
  readonly plannedBy?: string;
}

export const WORLD_PAGE_GPU_CHANNELS: readonly WorldPageChannelDescriptor[] = Object.freeze([
  Object.freeze({
    name: "height",
    gpuFormat: "r32float" as const,
    coreResolution: "height" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    // Material ids are season-invariant. `4.5-A2` already selected the low
    // bucket's ids; X5 removes the duplicate high-bucket texture.
    name: "splatId",
    gpuFormat: "rgba8unorm" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    name: "splatWeight",
    gpuFormat: "rgba8unorm" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: true,
  }),
  Object.freeze({
    name: "occlusion",
    gpuFormat: "rgba8unorm" as const,
    coreResolution: "surface" as const,
    // Sky visibility plus the bent normal's xy.
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    name: "horizon",
    gpuFormat: "rgba8unorm" as const,
    coreResolution: "surface" as const,
    // Eight azimuth elevation angles, four per texture.
    textureCount: 2,
    seasonKeyed: false,
  }),
  Object.freeze({
    // R16F stores log2(upstreamAreaM2 + 1); the transferable Uint16 encoding
    // quantises that same logarithmic value over the complete macro domain.
    name: "flowAccum",
    gpuFormat: "r16float" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    name: "lakeDepth",
    gpuFormat: "r16float" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    name: "soilDepth",
    gpuFormat: "r8unorm" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
  Object.freeze({
    name: "shoreDistance",
    gpuFormat: "r16sint" as const,
    coreResolution: "surface" as const,
    textureCount: 1,
    seasonKeyed: false,
  }),
]);

/** Stored edge of one slot of a channel family under a layout, gutter included. */
export function worldPageChannelStoredEdge(
  descriptor: WorldPageChannelDescriptor,
  layout: WorldPageLayout,
): number {
  const core = descriptor.coreResolution === "height"
    ? layout.heightResolution
    : layout.surfaceResolution;
  return core + layout.gutter * 2;
}

/** Bytes one stored texel of a family occupies across all of its textures. */
export function worldPageChannelBytesPerTexel(descriptor: WorldPageChannelDescriptor): number {
  return WORLD_PAGE_GPU_FORMAT_BYTES[descriptor.gpuFormat] * descriptor.textureCount;
}
