import { isWorldPageKey, type WorldPageKey } from "./pageKey";
import {
  estimateWorldPagePayloadBytes,
  WORLD_PAGE_SCHEMA_VERSION,
  type WorldPagePayload,
} from "./payload";

export const WORLD_PAGE_CACHE_METADATA_VERSION = 1 as const;

export interface WorldPageCacheMetadata {
  readonly metadataVersion: typeof WORLD_PAGE_CACHE_METADATA_VERSION;
  readonly pageSchemaVersion: typeof WORLD_PAGE_SCHEMA_VERSION;
  readonly key: WorldPageKey;
  /** Identifies the seed plus every generator setting that affects page content. */
  readonly worldRevision: string;
  readonly contentRevision: string;
  readonly cpuByteLength: number;
  readonly gpuByteLengthEstimate: number;
  readonly createdAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly lastVisibleAtMs: number | null;
  readonly accessCount: number;
  readonly pinned: boolean;
}

export interface CreateWorldPageCacheMetadataOptions {
  readonly worldRevision: string;
  readonly nowMs: number;
  readonly gpuByteLengthEstimate?: number;
  readonly pinned?: boolean;
}

export interface WorldPageCacheCompatibility {
  readonly worldRevision: string;
  readonly key?: WorldPageKey;
  readonly contentRevision?: string;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new RangeError(`${label} must not be empty`);
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function requireByteLength(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function createWorldPageCacheMetadata(
  payload: WorldPagePayload,
  options: CreateWorldPageCacheMetadataOptions,
): WorldPageCacheMetadata {
  const nowMs = requireTimestamp(options.nowMs, "Cache creation time");
  const cpuByteLength = estimateWorldPagePayloadBytes(payload);
  return {
    metadataVersion: WORLD_PAGE_CACHE_METADATA_VERSION,
    pageSchemaVersion: WORLD_PAGE_SCHEMA_VERSION,
    key: payload.key,
    worldRevision: requireNonEmpty(options.worldRevision, "World revision"),
    contentRevision: requireNonEmpty(payload.contentRevision, "Content revision"),
    cpuByteLength,
    gpuByteLengthEstimate: requireByteLength(
      options.gpuByteLengthEstimate ?? cpuByteLength,
      "GPU byte estimate",
    ),
    createdAtMs: nowMs,
    lastAccessedAtMs: nowMs,
    lastVisibleAtMs: null,
    accessCount: 0,
    pinned: options.pinned ?? false,
  };
}

export function touchWorldPageCacheMetadata(
  metadata: WorldPageCacheMetadata,
  nowMs: number,
  visible = false,
): WorldPageCacheMetadata {
  requireTimestamp(nowMs, "Cache access time");
  if (nowMs < metadata.createdAtMs || nowMs < metadata.lastAccessedAtMs) {
    throw new RangeError("Cache access time must be monotonic");
  }
  return {
    ...metadata,
    lastAccessedAtMs: nowMs,
    lastVisibleAtMs: visible ? nowMs : metadata.lastVisibleAtMs,
    accessCount: metadata.accessCount + 1,
  };
}

export function setWorldPageCachePinned(
  metadata: WorldPageCacheMetadata,
  pinned: boolean,
): WorldPageCacheMetadata {
  return metadata.pinned === pinned ? metadata : { ...metadata, pinned };
}

export function isWorldPageCacheCompatible(
  metadata: WorldPageCacheMetadata,
  expected: WorldPageCacheCompatibility,
): boolean {
  return (
    metadata.metadataVersion === WORLD_PAGE_CACHE_METADATA_VERSION &&
    metadata.pageSchemaVersion === WORLD_PAGE_SCHEMA_VERSION &&
    metadata.worldRevision === expected.worldRevision &&
    (expected.key === undefined || metadata.key === expected.key) &&
    (expected.contentRevision === undefined ||
      metadata.contentRevision === expected.contentRevision)
  );
}

export function isWorldPageCacheMetadata(value: unknown): value is WorldPageCacheMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.metadataVersion === WORLD_PAGE_CACHE_METADATA_VERSION &&
    candidate.pageSchemaVersion === WORLD_PAGE_SCHEMA_VERSION &&
    isWorldPageKey(candidate.key) &&
    typeof candidate.worldRevision === "string" &&
    candidate.worldRevision.length > 0 &&
    typeof candidate.contentRevision === "string" &&
    candidate.contentRevision.length > 0 &&
    typeof candidate.cpuByteLength === "number" &&
    Number.isSafeInteger(candidate.cpuByteLength) &&
    candidate.cpuByteLength >= 0 &&
    typeof candidate.gpuByteLengthEstimate === "number" &&
    Number.isSafeInteger(candidate.gpuByteLengthEstimate) &&
    candidate.gpuByteLengthEstimate >= 0 &&
    typeof candidate.createdAtMs === "number" &&
    Number.isFinite(candidate.createdAtMs) &&
    candidate.createdAtMs >= 0 &&
    typeof candidate.lastAccessedAtMs === "number" &&
    Number.isFinite(candidate.lastAccessedAtMs) &&
    candidate.lastAccessedAtMs >= candidate.createdAtMs &&
    (candidate.lastVisibleAtMs === null ||
      (typeof candidate.lastVisibleAtMs === "number" &&
        Number.isFinite(candidate.lastVisibleAtMs) &&
        candidate.lastVisibleAtMs >= candidate.createdAtMs &&
        candidate.lastVisibleAtMs <= candidate.lastAccessedAtMs)) &&
    typeof candidate.accessCount === "number" &&
    Number.isSafeInteger(candidate.accessCount) &&
    candidate.accessCount >= 0 &&
    typeof candidate.pinned === "boolean"
  );
}

/** Sort comparator: entries most suitable for eviction are ordered first. */
export function compareWorldPageCacheEvictionOrder(
  first: WorldPageCacheMetadata,
  second: WorldPageCacheMetadata,
): number {
  if (first.pinned !== second.pinned) return first.pinned ? 1 : -1;
  const firstVisible = first.lastVisibleAtMs ?? Number.NEGATIVE_INFINITY;
  const secondVisible = second.lastVisibleAtMs ?? Number.NEGATIVE_INFINITY;
  return (
    firstVisible - secondVisible ||
    first.lastAccessedAtMs - second.lastAccessedAtMs ||
    second.gpuByteLengthEstimate - first.gpuByteLengthEstimate ||
    first.key.localeCompare(second.key)
  );
}
