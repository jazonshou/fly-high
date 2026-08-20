/**
 * The limits Phase 4 DECLARES it needs, and the assertion that they hold.
 *
 * `inspectWebGpuCapabilities` copies ADAPTER limits, and the adapter on the
 * reference machine is generous: `maxTextureDimension2D` 16384,
 * `float32-filterable` present. The DEVICE is not. `FlightRenderer` passes
 * `setMaximumLimits: false` with a `deviceDescriptor` carrying only
 * `requiredFeatures`, and Babylon populates `requiredLimits` only when
 * `setMaximumLimits` is truthy — so the device runs at WebGPU SPEC DEFAULTS:
 * `maxTextureDimension2D` 8192, not 16384.
 *
 * Every atlas dimension, sampled-texture count and vertex-attribute count
 * Phase 4 adds was therefore being checked against a limit the renderer never
 * declared. These are the spec-default floors the renderer relies on; the
 * 4224² Ultra height atlas fits inside 8192 with room, and a future atlas
 * growth now fails loudly at startup instead of on a user's machine.
 *
 * `float32-filterable` is deliberately absent: see
 * `TERRAIN_REQUESTS_FLOAT32_FILTERABLE` in the terrain spine contract.
 */
export const REQUIRED_WEBGPU_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  // The largest atlas edge Phase 4 allocates is 4224 (Ultra height atlas).
  maxTextureDimension2D: 8_192,
  // 14 sampled textures in the terrain fragment stage (spine contract §5.6).
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  // Height atlas (read) + one channel atlas (write) per bake dispatch, plus
  // slack for the min/max reduction's two targets.
  maxStorageTexturesPerShaderStage: 4,
  maxStorageBuffersPerShaderStage: 8,
  // position, normal, colour + world0..3 + terrainNodeA/B = 10 of 16.
  maxVertexBuffers: 8,
  maxVertexAttributes: 16,
  maxComputeWorkgroupSizeX: 64,
  maxComputeWorkgroupSizeY: 64,
  maxComputeInvocationsPerWorkgroup: 64,
});

export interface WebGpuLimitShortfall {
  readonly limit: string;
  readonly required: number;
  readonly reported: number;
}

/**
 * Limits the reported set fails to meet. Empty means the device can run every
 * Phase 4 allocation. A limit the report does not carry is NOT a shortfall —
 * `inspectWebGpuCapabilities` returns `{}` in a headless Node context, and the
 * renderer must not refuse to start because it could not probe.
 */
export function findWebGpuLimitShortfalls(
  reported: Readonly<Record<string, number>>,
  required: Readonly<Record<string, number>> = REQUIRED_WEBGPU_LIMITS,
): readonly WebGpuLimitShortfall[] {
  const shortfalls: WebGpuLimitShortfall[] = [];
  for (const [limit, value] of Object.entries(required)) {
    const actual = reported[limit];
    if (typeof actual !== "number") continue;
    if (actual < value) shortfalls.push({ limit, required: value, reported: actual });
  }
  return shortfalls;
}

/** Throws, naming every shortfall, when a device cannot host Phase 4's atlases. */
export function assertWebGpuLimits(
  reported: Readonly<Record<string, number>>,
  required: Readonly<Record<string, number>> = REQUIRED_WEBGPU_LIMITS,
): void {
  const shortfalls = findWebGpuLimitShortfalls(reported, required);
  if (shortfalls.length === 0) return;
  throw new Error(
    "This GPU does not meet the limits the renderer declares: "
    + shortfalls
      .map((entry) => `${entry.limit} ${entry.reported} < ${entry.required}`)
      .join(", "),
  );
}

export interface WebGpuCapabilityReport {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
}

/** Read-only adapter probe used before constructing the Babylon WebGPU engine. */
export async function inspectWebGpuCapabilities(): Promise<WebGpuCapabilityReport> {
  if (typeof navigator === "undefined") {
    return { supported: false, reason: "WebGPU requires a browser environment.", features: new Set(), limits: {} };
  }
  const gpu = navigator.gpu;
  if (!gpu) {
    return {
      supported: false,
      reason: "This browser does not expose WebGPU. Use a current hardware-accelerated browser.",
      features: new Set(),
      limits: {},
    };
  }
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter || adapter.info.isFallbackAdapter) {
    return {
      supported: false,
      reason: adapter
        ? "Only a software WebGPU adapter is available; hardware acceleration is required."
        : "No compatible WebGPU adapter is available.",
      features: new Set(),
      limits: {},
    };
  }
  const limits: Record<string, number> = {};
  const source = adapter.limits as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") limits[key] = value;
  }
  return {
    supported: true,
    reason: null,
    features: new Set([...adapter.features]),
    limits,
  };
}
