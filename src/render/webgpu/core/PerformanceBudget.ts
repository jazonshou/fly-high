import type { WebGpuQualityProfile } from "./QualityProfile";

/**
 * The performance budget contract (1A-2).
 *
 * INVARIANT THIS FILE OWNS: every steady-state GPU allocation and every
 * per-frame GPU cost the renderer plans to spend is written down here, per
 * tier, and `npm test` fails when a profile's estimated spend exceeds its
 * ceiling. Overspend becomes a failing test instead of a discovery the user
 * makes. Budgets are data; subsystems must not carry their own copies.
 *
 * Class P: pure functions over the quality profile and a viewport. No Babylon
 * import. Runs in Node.
 */

/**
 * Budget tier. Matches `WebGpuQualityProfile.tier`; tier 3 (Ultra, 30 fps)
 * exists in the budget tables from the start so the 1A-6b four-tier profile
 * lands against an already-published ceiling.
 */
export type PerformanceTier = 0 | 1 | 2 | 3;

export interface RenderViewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
}

/**
 * Per-subsystem GPU frame budget rows (RENDERING_PLAN.md §5.4). Compute rows
 * are amortised hard caps enforced by their schedulers, not averages.
 */
export interface SubsystemBudgetMs {
  readonly terrainRaster: number;
  readonly terrainCompute: number;
  readonly erosionCompute: number;
  readonly splatCompute: number;
  readonly shadows: number;
  readonly water: number;
  readonly clouds: number;
  readonly vegetation: number;
  readonly atmosphere: number;
  readonly post: number;
}

/**
 * Controllable frame time: 16.67 ms − compositor/present − pacing headroom at
 * the 60 fps tiers; Ultra targets 30 fps.
 */
export const FRAME_TARGET_MS: Readonly<Record<PerformanceTier, number>> = Object.freeze({
  0: 13.7,
  1: 13.7,
  2: 13.7,
  3: 30.0,
});

/**
 * §5.4 publishes the Balanced and Ultra rows; Low scales the per-pixel rows
 * to its 1.0 Mpx cap, and High trades nearly all of Balanced's headroom for
 * its 2.4 Mpx cap (its compute caps come from §5.3). Rows must sum below the
 * tier's frame target — asserted in the budget test, not trusted.
 */
export const FRAME_BUDGET_MS: Readonly<Record<PerformanceTier, SubsystemBudgetMs>> =
  Object.freeze({
    0: Object.freeze({
      terrainRaster: 1.8,
      terrainCompute: 0.4,
      erosionCompute: 0.2,
      splatCompute: 0.15,
      shadows: 0.7,
      water: 1.1,
      clouds: 1.5,
      vegetation: 1.2,
      atmosphere: 0.3,
      post: 0.6,
    }),
    1: Object.freeze({
      terrainRaster: 2.6,
      terrainCompute: 0.7,
      erosionCompute: 0.4,
      splatCompute: 0.25,
      shadows: 1.1,
      water: 1.6,
      clouds: 2.2,
      vegetation: 1.8,
      atmosphere: 0.4,
      post: 0.9,
    }),
    2: Object.freeze({
      terrainRaster: 2.9,
      terrainCompute: 1.0,
      erosionCompute: 0.7,
      splatCompute: 0.3,
      shadows: 1.2,
      water: 1.8,
      clouds: 2.3,
      vegetation: 1.9,
      atmosphere: 0.5,
      post: 1.0,
    }),
    3: Object.freeze({
      terrainRaster: 6.0,
      terrainCompute: 1.6,
      erosionCompute: 1.2,
      splatCompute: 0.5,
      shadows: 2.6,
      water: 4.0,
      clouds: 5.5,
      vegetation: 3.6,
      atmosphere: 0.9,
      post: 1.9,
    }),
  });

/** GPU-resident memory ceilings (RENDERING_PLAN.md §5.2), MiB per tier. */
export const MEMORY_CEILING_MIB: Readonly<Record<PerformanceTier, number>> = Object.freeze({
  0: 260,
  1: 480,
  2: 700,
  3: 1_000,
});

export function frameBudgetTotalMs(tier: PerformanceTier): number {
  const rows = FRAME_BUDGET_MS[tier];
  return Object.values(rows).reduce((sum, value) => sum + value, 0);
}

const MIB = 1_048_576;

/** HDR half-float beauty target. */
const HDR_COLOR_BYTES = 8;
/** LDR post-chain target and the presented swapchain. */
const LDR_COLOR_BYTES = 4;
/** Main depth: depth32float under reversed-Z. */
const DEPTH_BYTES = 4;
/**
 * CSM depth attachment. Colour is gone since 1A-5's depth-only RTT, and the
 * remaining attachment is plain `depth32float` — 4 B/texel, no stencil plane.
 *
 * Corrected at `3-0` from 5 (the provisional "DEPTH32FLOAT_STENCIL8" reading)
 * after the material arrays pushed tiers 2 and 3 past their ceilings and the
 * row had to be checked rather than cut. Verified in 9.21.2, not assumed:
 * `AtmosphereSystem.DepthOnlyCascadedShadowGenerator._createTargetRenderTexture`
 * calls `createDepthStencilTexture(comparison, true)` and stops there, so
 * `renderTargetTexture.pure.js:517`'s defaults apply — `generateStencil =
 * false`, `format = 14` (`TEXTUREFORMAT_DEPTH32_FLOAT`) — and
 * `webgpuTextureManager.js:279` maps 14 to the WebGPU `depth32float` format.
 * The stencil branch is `engine.renderTarget.pure.js:54`'s `13`, which this
 * renderer never selects. 64 MiB of phantom allocation at tier 2.
 */
const SHADOW_DEPTH_BYTES = 4;
/**
 * Ocean FFT bytes per texel per cascade: h0 spectrum (rgba32float, 16 B) +
 * wave data (16 B) + two ping-pong pairs (4 × rgba16float since 1B-13) +
 * displacement (rgba16float, 8 B) + two slope/foam targets and one
 * second-moment target (2-8: each rgba16float with a full mip chain, ×4/3).
 */
const OCEAN_FFT_PING_PONG_BYTES = 8;
const OCEAN_MIP_CHAIN_FACTOR = 4 / 3;
const OCEAN_BYTES_PER_TEXEL =
  16 + 16 + 4 * OCEAN_FFT_PING_PONG_BYTES + 8 + 3 * 8 * OCEAN_MIP_CHAIN_FACTOR;
/** Integration + two temporal history targets, rgba16float. */
const CLOUD_TARGET_COUNT = 3;
/** Vertex layout of a CPU terrain tile: position + normal (f32x3) + colour (f32x4). */
const TERRAIN_VERTEX_BYTES = (3 + 3 + 4) * 4;

/**
 * Z-4: the movable allocations (PRE_PHASE_4_REALIGNMENT.md §3, R-22). The
 * old flat `DETAIL_ALLOWANCE_MIB` made assertion 47 and the `2-18`
 * bucket-count arbitration vacuous — vegetation memory was a hand-written
 * constant that no Phase-2 allocation could move. These inputs are the
 * declared sources of truth: the item that changes an allocation changes the
 * input here, and the budget rows follow. The `Z-4` "row moves when the
 * input moves" test pins that property.
 */
export interface DynamicAllocationInputs {
  /** Bytes per rendered detail instance (2-11a's packed record). */
  readonly detailInstanceBytes: number;
  /** Ceiling on simultaneously resident detail instances, per tier. */
  readonly detailInstanceBudget: Readonly<Record<PerformanceTier, number>>;
  /** Foliage card atlas (`2-11`); 0 until it exists. */
  readonly foliageAtlasMiB: number;
  /** Octahedral impostor atlas (`2-17`); 0 until it exists. */
  readonly impostorAtlasMiB: number;
  /** Cloud noise/weather volumes (`2-1`); 0 until the bake exists. */
  readonly cloudVolumesMiB: number;
  /**
   * Terrain material arrays (`3-1`). Declared as the SHAPE, not a MiB scalar,
   * because the allocation is a function of the tier's `materialArrayEdge` —
   * a scalar row could not move when that knob moves, which is exactly the
   * vacuous-row failure Z-4 exists to prevent (assertion 56).
   */
  readonly materialArrayCount: number;
  readonly materialArrayLayers: number;
  readonly materialArrayBytesPerTexel: number;
}

export const DYNAMIC_ALLOCATIONS: DynamicAllocationInputs = Object.freeze({
  // 2-11a: the 32-byte packed record replaced 96-byte matrix instancing.
  detailInstanceBytes: 32,
  detailInstanceBudget: Object.freeze({
    0: 60_000,
    1: 120_000,
    2: 200_000,
    3: 240_000,
  }),
  // 2-12: the atlas's first sampler went live — measured bytes across all
  // 16 layers and their coverage-preserving mip chains.
  foliageAtlasMiB: 5.33,
  // 2-17: 7 species × 2 season buckets × 2 arrays (albedo, normal+depth) of
  // 256² rgba8 with full mip chains — measured from the CPU bake. 64² tiles
  // are the recorded decision (the plan's 128² sketch did not close against
  // the §5.2 headroom, and a far-band tree subtends ≤ ~20 px).
  impostorAtlasMiB: 9.33,
  // 2-1: 128³ rgba8 base + 32³ rgba8 detail + 512² rgba8 weather ≈ 9.1 MiB.
  cloudVolumesMiB: (128 ** 3 * 4 + 32 ** 3 * 4 + 512 ** 2 * 4) / 1_048_576,
  // 3-0/3-1: two RGBA8 arrays (albedo+height, normal+material) of
  // SURFACE_MATERIAL_COUNT layers each, sized by profile.materialArrayEdge
  // and carrying a full mip chain. The layer count is pinned against
  // SURFACE_MATERIALS by test rather than imported, so core/ keeps its
  // no-subsystem-imports shape.
  materialArrayCount: 2,
  materialArrayLayers: 10,
  materialArrayBytesPerTexel: 4,
});

/**
 * Exact bytes multiplier for a complete square mip chain down to 1×1:
 * `sum(4^-k)` for k in [0, log2(edge)]. Approaches 4/3 and is within 3e-7 of
 * it at 512² — computed rather than assumed because the arrays are the
 * largest single allocation Phase 3 adds.
 */
export function mipChainByteFactor(edge: number): number {
  if (!Number.isInteger(edge) || edge < 1 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Material array edge must be a power of two, got ${edge}`);
  }
  let factor = 0;
  for (let levelEdge = edge; levelEdge >= 1; levelEdge >>= 1) {
    factor += (levelEdge * levelEdge) / (edge * edge);
  }
  return factor;
}

/**
 * Hydrology tiles and wildlife thin instances. 2-10 retired the
 * planar-reflection mirror this allowance also covered — each tier gives
 * back the mirror's ~0.2-1 MiB.
 */
const OTHER_DETAIL_ALLOWANCE_MIB: Readonly<Record<PerformanceTier, number>> = Object.freeze({
  0: 8,
  1: 9,
  2: 11,
  3: 13,
});

/** Pipelines, shader cache, aircraft/airport meshes, sky dome, small LUTs. */
const MISC_ALLOWANCE_MIB = 40;

/**
 * Estimate-vs-reality slack. Provisional calibration 2026-08-17 (Apple
 * M-series reference machine): pure allocation arithmetic, cross-checked
 * against the renderer's texture/buffer inventory only coarsely; the 1A-1
 * numeric report carries `estimatedGpuMemoryMiB` so the drift is visible in
 * every capture. Re-pin when |estimate − actual| exceeds 15%.
 */
const ESTIMATE_FUDGE_FACTOR = 1.15;

export interface GpuMemoryEstimateMiB {
  readonly renderPixels: number;
  readonly framebuffersMiB: number;
  readonly shadowsMiB: number;
  readonly oceanMiB: number;
  /** Includes the `2-1` cloud volumes once their input is non-zero. */
  readonly cloudsMiB: number;
  readonly terrainGeometryMiB: number;
  /** Z-4: the split vegetation rows (replacing the flat detail allowance). */
  readonly detailInstancesMiB: number;
  readonly foliageAtlasMiB: number;
  readonly impostorAtlasMiB: number;
  readonly otherDetailMiB: number;
  readonly materialArraysMiB: number;
  readonly miscMiB: number;
  readonly totalMiB: number;
}

function requireViewport(viewport: RenderViewport): void {
  if (
    !Number.isFinite(viewport.cssWidth)
    || !Number.isFinite(viewport.cssHeight)
    || !Number.isFinite(viewport.devicePixelRatio)
    || viewport.cssWidth <= 0
    || viewport.cssHeight <= 0
    || viewport.devicePixelRatio <= 0
  ) {
    throw new RangeError("Viewport dimensions and device pixel ratio must be finite and positive");
  }
}

/** Rendered pixels after the 1A-6a DPR ceiling, render scale, and pixel cap. */
export function estimateRenderPixels(
  profile: WebGpuQualityProfile,
  viewport: RenderViewport,
): number {
  requireViewport(viewport);
  const pixelRatio = Math.min(profile.maxDevicePixelRatio, viewport.devicePixelRatio);
  const scale = Math.max(0.1, pixelRatio * profile.renderScale);
  const requested = viewport.cssWidth * viewport.cssHeight * scale * scale;
  return Math.min(profile.maxRenderPixels, requested);
}

/**
 * Mirrors the CPU tile path: level 0 keeps a full 5×5 ring, coarser levels
 * lose the four pages fully hidden beneath finer coverage (measured 25 + 21
 * per level; 172 pages at 8 rings).
 */
function terrainPagesAtLevel(level: number): number {
  return level === 0 ? 25 : 21;
}

function terrainPageBytes(resolution: number): number {
  const skirtVertices = 4 * (resolution - 1);
  const vertexCount = resolution * resolution + skirtVertices;
  const indexCount = (resolution - 1) * (resolution - 1) * 6 + skirtVertices * 6;
  const indexBytes = vertexCount > 65_535 ? 4 : 2;
  return vertexCount * TERRAIN_VERTEX_BYTES + indexCount * indexBytes;
}

/**
 * Sums every steady-state GPU allocation from first principles: shadow maps
 * from map size and cascade count, the ocean FFT working set from resolution
 * and cascades, cloud history from the integration scale and the pixel cap,
 * framebuffers from the capped pixel count, terrain geometry from the ring
 * configuration.
 */
export function estimateGpuMemoryBreakdown(
  profile: WebGpuQualityProfile,
  viewport: RenderViewport,
  inputs: DynamicAllocationInputs = DYNAMIC_ALLOCATIONS,
): GpuMemoryEstimateMiB {
  const renderPixels = estimateRenderPixels(profile, viewport);

  const msaaSamples = profile.msaaSamples;
  const framebufferBytes = renderPixels * (
    HDR_COLOR_BYTES
    + LDR_COLOR_BYTES
    + DEPTH_BYTES
    + 2 * LDR_COLOR_BYTES
    + (msaaSamples > 1 ? (HDR_COLOR_BYTES + DEPTH_BYTES) * msaaSamples : 0)
  );

  const shadowBytes =
    profile.shadowMapSize * profile.shadowMapSize * profile.shadowCascades * SHADOW_DEPTH_BYTES;

  const oceanBytes =
    profile.oceanResolution * profile.oceanResolution
    * profile.oceanCascades
    * OCEAN_BYTES_PER_TEXEL;

  const cloudPixels =
    renderPixels * profile.cloudResolutionScale * profile.cloudResolutionScale;
  const cloudShadowEdge = profile.tier === 0 ? 128 : 256;
  const cloudBytes =
    cloudPixels * CLOUD_TARGET_COUNT * HDR_COLOR_BYTES
    + cloudShadowEdge * cloudShadowEdge * HDR_COLOR_BYTES;

  let terrainBytes = 0;
  for (let level = 0; level < profile.terrainRings; level += 1) {
    terrainBytes +=
      terrainPagesAtLevel(level) * terrainPageBytes(profile.terrainTileResolution);
  }

  const tier = profile.tier as PerformanceTier;
  const framebuffersMiB = framebufferBytes / MIB;
  const shadowsMiB = shadowBytes / MIB;
  const oceanMiB = oceanBytes / MIB;
  const cloudsMiB = cloudBytes / MIB + inputs.cloudVolumesMiB;
  const terrainGeometryMiB = terrainBytes / MIB;
  const detailInstancesMiB =
    (inputs.detailInstanceBudget[tier] * inputs.detailInstanceBytes) / MIB;
  const foliageAtlasMiB = inputs.foliageAtlasMiB;
  const impostorAtlasMiB = inputs.impostorAtlasMiB;
  const otherDetailMiB = OTHER_DETAIL_ALLOWANCE_MIB[tier];
  const materialArraysMiB =
    (inputs.materialArrayCount
      * inputs.materialArrayLayers
      * profile.materialArrayEdge * profile.materialArrayEdge
      * inputs.materialArrayBytesPerTexel
      * mipChainByteFactor(profile.materialArrayEdge))
    / MIB;
  const miscMiB = MISC_ALLOWANCE_MIB;
  const totalMiB =
    (framebuffersMiB + shadowsMiB + oceanMiB + cloudsMiB + terrainGeometryMiB
      + detailInstancesMiB + foliageAtlasMiB + impostorAtlasMiB + otherDetailMiB
      + materialArraysMiB + miscMiB)
    * ESTIMATE_FUDGE_FACTOR;

  return Object.freeze({
    renderPixels,
    framebuffersMiB,
    shadowsMiB,
    oceanMiB,
    cloudsMiB,
    terrainGeometryMiB,
    detailInstancesMiB,
    foliageAtlasMiB,
    impostorAtlasMiB,
    otherDetailMiB,
    materialArraysMiB,
    miscMiB,
    totalMiB,
  });
}

export function estimateGpuMemoryMiB(
  profile: WebGpuQualityProfile,
  viewport: RenderViewport,
  inputs: DynamicAllocationInputs = DYNAMIC_ALLOCATIONS,
): number {
  return estimateGpuMemoryBreakdown(profile, viewport, inputs).totalMiB;
}

/** Fails loudly (with the full breakdown) when a profile overspends its tier ceiling. */
export function assertWithinBudget(
  profile: WebGpuQualityProfile,
  viewport: RenderViewport,
  inputs: DynamicAllocationInputs = DYNAMIC_ALLOCATIONS,
): void {
  const breakdown = estimateGpuMemoryBreakdown(profile, viewport, inputs);
  const ceiling = MEMORY_CEILING_MIB[profile.tier as PerformanceTier];
  if (breakdown.totalMiB <= ceiling) return;
  const rows = [
    `framebuffers ${breakdown.framebuffersMiB.toFixed(1)}`,
    `shadows ${breakdown.shadowsMiB.toFixed(1)}`,
    `ocean ${breakdown.oceanMiB.toFixed(1)}`,
    `clouds ${breakdown.cloudsMiB.toFixed(1)}`,
    `terrain ${breakdown.terrainGeometryMiB.toFixed(1)}`,
    `detail-instances ${breakdown.detailInstancesMiB.toFixed(1)}`,
    `foliage-atlas ${breakdown.foliageAtlasMiB.toFixed(1)}`,
    `impostor-atlas ${breakdown.impostorAtlasMiB.toFixed(1)}`,
    `other-detail ${breakdown.otherDetailMiB.toFixed(1)}`,
    `material-arrays ${breakdown.materialArraysMiB.toFixed(1)}`,
    `misc ${breakdown.miscMiB.toFixed(1)}`,
  ].join(", ");
  throw new Error(
    `GPU memory budget overspend at tier ${profile.tier}: estimated `
    + `${breakdown.totalMiB.toFixed(1)} MiB exceeds the ${ceiling} MiB ceiling (${rows}; `
    + `${Math.round(breakdown.renderPixels / 1_000) / 1_000} Mpx)`,
  );
}
