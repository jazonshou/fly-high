import { describe, expect, it } from "vitest";
import {
  assertValidWorldPagePayload,
  childWorldPageAddresses,
  compareWorldPageCacheEvictionOrder,
  createWorldPageAddress,
  createWorldPageCacheMetadata,
  createWorldPageKey,
  estimateWorldPagePayloadBytes,
  getWorldPageStoredDimensions,
  getWorldPageTransferables,
  isWorldPageCacheCompatible,
  isWorldPagePayload,
  parentWorldPageAddress,
  parseWorldPageKey,
  setWorldPageCachePinned,
  touchWorldPageCacheMetadata,
  validateWorldPagePayload,
  WorldPageLifecycle,
  WorldPageValidationError,
  WORLD_PAGE_SCHEMA_VERSION,
  type WorldPagePayload,
} from "../src/render/webgpu/world";

function createPayload(): WorldPagePayload {
  const layout = {
    extentMeters: 512,
    heightResolution: 5,
    surfaceResolution: 4,
    gutter: 1,
  } as const;
  const dimensions = getWorldPageStoredDimensions(layout);
  const heightSamples = Uint16Array.from(
    { length: dimensions.heightSampleCount },
    (_, index) => index,
  );
  const materialWeights = new Uint8Array(dimensions.surfaceTexelCount * 4);
  for (let offset = 0; offset < materialWeights.length; offset += 4) {
    materialWeights[offset] = 255;
  }
  return {
    schemaVersion: WORLD_PAGE_SCHEMA_VERSION,
    key: createWorldPageKey(createWorldPageAddress(0, -2, 7)),
    contentRevision: "terrain-generator-v4",
    layout,
    height: {
      format: "r16uint-linear",
      samples: heightSamples,
      offsetMeters: -20,
      metersPerUnit: 0.5,
      minHeightMeters: -20,
      maxHeightMeters: -20 + (heightSamples.length - 1) * 0.5,
    },
    material: {
      format: "rgba8unorm-weights",
      materialIds: new Uint16Array([4, 9, 12, 15]),
      weights: materialWeights,
    },
    surface: {
      format: "rgba8unorm-surface-v1",
      values: new Uint8Array(dimensions.surfaceTexelCount * 4),
      biomes: new Uint8Array(dimensions.surfaceTexelCount),
    },
    hydrology: {
      format: "rg16snorm-flow+r16uint-depth+r16sint-shore+r16uint-discharge",
      flowXZ: new Int16Array(dimensions.surfaceTexelCount * 2),
      waterDepth: new Uint16Array(dimensions.surfaceTexelCount),
      shoreDistance: new Int16Array(dimensions.surfaceTexelCount),
      discharge: new Uint16Array(dimensions.surfaceTexelCount),
      depthMetersPerUnit: 0.01,
      shoreDistanceMetersPerUnit: 0.25,
      dischargeLog2Bias: 0,
      dischargeLog2PerUnit: 0.001,
    },
  };
}

describe("WebGPU world page contract", () => {
  it("uses canonical hierarchical keys across negative coordinates", () => {
    const child = createWorldPageAddress(2, -3, 4);
    const key = createWorldPageKey(child);
    expect(key).toBe("world-page-v1/2/-3/4");
    expect(parseWorldPageKey(key)).toEqual(child);
    expect(parseWorldPageKey("world-page-v1/02/-3/4")).toBeNull();
    expect(parseWorldPageKey("world-page-v1/2/-0/4")).toBeNull();

    const parent = parentWorldPageAddress(child);
    expect(parent).toEqual({ level: 3, x: -2, z: 2 });
    expect(parent && childWorldPageAddresses(parent)).toContainEqual(child);
    expect(childWorldPageAddresses(createWorldPageAddress(0, 0, 0))).toEqual([]);
  });

  it("validates packed payload dimensions, ranges, and normalized weights", () => {
    const payload = createPayload();
    expect(validateWorldPagePayload(payload)).toEqual([]);
    expect(isWorldPagePayload(payload)).toBe(true);
    expect(() => assertValidWorldPagePayload(payload)).not.toThrow();

    const invalid = {
      ...payload,
      material: {
        ...payload.material,
        weights: new Uint8Array(payload.material.weights.length - 4),
      },
    };
    expect(validateWorldPagePayload(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "material.weights", code: "invalid-length" }),
      ]),
    );
    expect(() => assertValidWorldPagePayload(invalid)).toThrow(WorldPageValidationError);
  });

  it("accounts for and deduplicates transferable page buffers", () => {
    const payload = createPayload();
    const byteLength = estimateWorldPagePayloadBytes(payload);
    expect(byteLength).toBeGreaterThan(0);
    const transferables = getWorldPageTransferables(payload);
    expect(new Set(transferables).size).toBe(transferables.length);
    expect(transferables).toContain(payload.height.samples.buffer);
    expect(transferables.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(byteLength);
  });
});

describe("WebGPU world page lifecycle", () => {
  it("moves through CPU loading, GPU upload, residency, and retained eviction", () => {
    let now = 10;
    const lifecycle = new WorldPageLifecycle(createPayload().key, () => now++);
    const load = lifecycle.queue();
    expect(lifecycle.beginLoading(load)).toBe(true);
    expect(lifecycle.markCpuReady(load)).toBe(true);
    const upload = lifecycle.beginUpload();
    expect(lifecycle.markResident(upload)).toBe(true);
    const eviction = lifecycle.beginEviction();
    expect(lifecycle.finishEviction(eviction, true)).toBe(true);
    expect(lifecycle.snapshot).toMatchObject({
      state: "cpu-ready",
      transitionCount: 7,
      failure: null,
    });
    lifecycle.dropCpuPayload();
    expect(lifecycle.state).toBe("unloaded");
  });

  it("rejects stale asynchronous completion without corrupting newer state", () => {
    const lifecycle = new WorldPageLifecycle(createPayload().key);
    const stale = lifecycle.queue();
    expect(lifecycle.beginLoading(stale)).toBe(true);
    expect(lifecycle.cancelOperation(stale)).toBe(true);
    expect(lifecycle.markCpuReady(stale)).toBe(false);

    const current = lifecycle.queue();
    expect(lifecycle.beginLoading(current)).toBe(true);
    expect(lifecycle.markCpuReady(current)).toBe(true);
    expect(() => lifecycle.queue()).toThrow(/expected unloaded or failed/);
    expect(lifecycle.state).toBe("cpu-ready");
  });
});

describe("WebGPU world page cache metadata", () => {
  it("tracks compatibility, recency, visibility, pinning, and eviction order", () => {
    const payload = createPayload();
    const original = createWorldPageCacheMetadata(payload, {
      worldRevision: "seed-8/generator-4",
      nowMs: 100,
      gpuByteLengthEstimate: 4_096,
    });
    const recentlyVisible = touchWorldPageCacheMetadata(original, 300, true);
    const pinned = setWorldPageCachePinned(original, true);

    expect(isWorldPageCacheCompatible(original, {
      worldRevision: "seed-8/generator-4",
      key: payload.key,
    })).toBe(true);
    expect(isWorldPageCacheCompatible(original, {
      worldRevision: "seed-9/generator-4",
    })).toBe(false);
    expect(recentlyVisible).toMatchObject({
      lastAccessedAtMs: 300,
      lastVisibleAtMs: 300,
      accessCount: 1,
    });
    expect(compareWorldPageCacheEvictionOrder(original, recentlyVisible)).toBeLessThan(0);
    expect(compareWorldPageCacheEvictionOrder(original, pinned)).toBeLessThan(0);
  });
});
