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
  // `6-12`: the terrain fragment stage binds TEN sampled textures — read it off
  // `TERRAIN_SAMPLED_BINDINGS.fragment`, which `6-11.4` made a DERIVED list
  // (`tests/gpu/terrain-sampler-budget.test.ts` compiles the shipping
  // permutations and asserts it). `TERRAIN_HYDROLOGY_ADDS_SAMPLED_BINDINGS` is
  // 0, so ten is also the widest permutation. Do not re-hand-maintain a number
  // here; cite the constant.
  //
  // This comment previously said "14 ... (spine contract §5.6)" — a surviving
  // copy of the pre-`6-11.4` hand-maintained figure, which was wrong in BOTH
  // directions: it counted six PBR samplers this material never declares and
  // omitted `environmentBrdfSampler` and the CSM `shadowTexture`. A total can
  // look plausible while being assembled from entirely the wrong set, so check
  // the membership, not the sum. It nearly cost real scope: Phase 7 priced
  // clustered lighting against "14/16, one slot free" and was preparing to cut
  // photometric textures and material arrays to fit. True headroom is 10/16.
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  // `7-0-d` (C4): the limit that guards Phase 7's binding constraint, and the
  // one nobody probed. Clustered lighting adds a `vViewDepth` inter-stage
  // varying to EVERY PBR material whenever the container exists — the define
  // is gated on `CLUSTLIGHT_BATCH > 0`, not on whether a given material has a
  // clustered light. The detail material sits at 12 today, so 13 with it; and
  // a shadow-casting light under CSM declares NINE more of its own
  // (`vPositionFromLight{X}_0..3`, `vDepthMetric{X}_0..3`,
  // `vPositionFromCamera{X}`), which is why impostor shadow receiving was
  // disabled once already to get under this ceiling. Spec default; `7-0-d`'s
  // P4 measures the real per-material counts on the adapter.
  maxInterStageShaderVariables: 16,
  // `7-0-d` (C4): `GetSupportedSimultaneousLights` clamps the light count to
  // `maxUniformBuffersPerShaderStage - 4`, and returns the requested count
  // UNTOUCHED when the cap reads null — so on an engine that does not report
  // it the clamp silently does not happen. 12 is the spec default and yields
  // 8 supported lights; the clustered container is itself a Light and takes
  // one of those slots.
  maxUniformBuffersPerShaderStage: 12,
  // Height atlas (read) + one channel atlas (write) per bake dispatch, plus
  // slack for the min/max reduction's two targets.
  maxStorageTexturesPerShaderStage: 4,
  maxStorageBuffersPerShaderStage: 8,
  maxVertexBuffers: 8,
  // `6-12`: the comment that used to sit above `maxVertexBuffers` read
  // "position, normal, colour + world0..3 + terrainNodeA/B = 10 of 16" and was
  // wrong three ways at once. It is recorded rather than silently deleted
  // because each way is a different species of error:
  //   1. **Arithmetic.** Its own enumeration lists NINE attributes (3 + 4 + 2),
  //      not ten.
  //   2. **Attached to the wrong constant.** "of 16" is the vertex-ATTRIBUTE
  //      limit below, not `maxVertexBuffers: 8` above it. Read as buffers it
  //      asserted 10 against a limit of 8 — i.e. it would have described a
  //      configuration that cannot be created.
  //   3. **No such pipeline exists.** `world0..3` are thin-instance attributes
  //      on detail/foliage (`DetailInstanceMaterialPlugin`); `terrainNodeA/B`
  //      are terrain-only (`TerrainSurfacePlugin`). Terrain is not
  //      thin-instanced and detail declares no terrain-node attributes, so no
  //      single mesh ever carries this set. The count was assembled from two
  //      different pipelines.
  // Both limits are spec-default floors with real headroom; neither is tight.
  // If a future attribute makes one tight, derive the count from the plugin
  // that declares it, the way `TERRAIN_SAMPLED_BINDINGS` now is.
  maxVertexAttributes: 16,
  maxComputeWorkgroupSizeX: 64,
  maxComputeWorkgroupSizeY: 64,
  maxComputeInvocationsPerWorkgroup: 64,
});

/**
 * Limits the renderer needs but which the SPEC MARKS OPTIONAL, so an adapter
 * may legitimately not report them.
 *
 * These are kept separate from `REQUIRED_WEBGPU_LIMITS` on purpose.
 * `tests/gpu/webgpu-limits.test.ts` asserts that every REQUIRED key comes back
 * as a number — a non-vacuity guard added after a probe printed `undefined`
 * for all ten limits and nobody noticed. Declaring an optional limit in that
 * map would make the guard fail on any adapter that omits it, which would
 * either red the suite or force the guard to be weakened. Both are worse than
 * saying which limits are optional.
 *
 * Shortfalls are still checked for these: `findWebGpuLimitShortfalls` skips a
 * limit the report does not carry, so an adapter that DOES report one is held
 * to it and one that does not is not punished for it.
 */
export const OPTIONAL_WEBGPU_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  // `7-0-d` (C4): the clustered container gives every receiving material one
  // fragment-stage read-only storage buffer (`tileMaskBuffer{X}`) — the
  // project's first. One container is the design, so one buffer is the whole
  // requirement; declaring the spec default of 8 would fail compatibility-mode
  // adapters that report a lower but entirely sufficient number. `@webgpu/types`
  // declares this one `?: number` where the neighbouring per-stage limit is
  // required, which is why it lives here.
  maxStorageBuffersInFragmentStage: 1,
});

/** Every limit the renderer declares, required and optional together. */
export const ALL_DECLARED_WEBGPU_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  ...REQUIRED_WEBGPU_LIMITS,
  ...OPTIONAL_WEBGPU_LIMITS,
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
  required: Readonly<Record<string, number>> = ALL_DECLARED_WEBGPU_LIMITS,
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
  required: Readonly<Record<string, number>> = ALL_DECLARED_WEBGPU_LIMITS,
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

/**
 * Copy a `GPUSupportedLimits` into a plain record.
 *
 * **`Object.entries` returns nothing here**, which is why this needs a
 * function. `GPUSupportedLimits` exposes every limit as a GETTER ON ITS
 * PROTOTYPE, not as an own enumerable property, so the obvious
 * `Object.entries(adapter.limits)` loop produced an empty map — and had done
 * since Phase 0, silently, because nothing read the result until `4-0`'s
 * startup assertion. Found by the P2 probe printing `undefined` for every
 * limit it asked about.
 */
export function readWebGpuLimits(source: object): Record<string, number> {
  const limits: Record<string, number> = {};
  for (
    let level: object | null = source;
    level !== null;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (key === "constructor" || key in limits) continue;
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "number") limits[key] = value;
    }
  }
  return limits;
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
  const limits = readWebGpuLimits(adapter.limits);
  return {
    supported: true,
    reason: null,
    features: new Set([...adapter.features]),
    limits,
  };
}
