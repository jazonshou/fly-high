import type { QualityLevel } from "@/src/game/types";
import type { HybridRenderCapabilities } from "./RenderCapabilities";

export type HybridRenderingMode = "balanced" | "hybrid" | "ray-traced";
export type HybridTargetFormat = "rgba8" | "rgba16f";

export interface RenderProfileRequest {
  renderingMode: HybridRenderingMode;
  quality: QualityLevel;
  /** Output framebuffer size in physical pixels. */
  outputWidth: number;
  /** Output framebuffer size in physical pixels. */
  outputHeight: number;
}

export interface PlanarReflectionBudget {
  enabled: boolean;
  width: number;
  height: number;
  cadenceMs: number;
  strength: number;
}

export interface ScreenSpaceBudget {
  enabled: boolean;
  aoTaps: number;
  aoRadius: number;
  aoStrength: number;
  ssrSteps: number;
  ssrMaxDistance: number;
  ssrThickness: number;
  ssrStrength: number;
  temporalHistoryWeight: number;
  /** Lower history retention for animated water than for static AO. */
  waterTemporalHistoryWeight: number;
  /** Scales allocation-free full-resolution ripple and Fresnel detail. */
  waterDetailStrength: number;
  /** Scales the conservative screen-space shallow/shore transition. */
  shorelineStrength: number;
}

export interface RenderMemoryBudget {
  capBytes: number;
  estimatedBytes: number;
}

export interface ResolvedRenderProfile {
  readonly requestedMode: HybridRenderingMode;
  /** Effective renderer family. The legacy `ray-traced` request still runs on the hybrid backend. */
  readonly activeMode: HybridRenderingMode;
  /** Accurate technique label for diagnostics; never claims hardware RT. */
  readonly technique: "forward" | "planar-screen-space" | "ray-marched-screen-space";
  readonly quality: QualityLevel;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly beautyWidth: number;
  readonly beautyHeight: number;
  readonly effectsWidth: number;
  readonly effectsHeight: number;
  readonly colorFormat: HybridTargetFormat;
  readonly bypass: boolean;
  readonly planar: PlanarReflectionBudget;
  readonly screenSpace: ScreenSpaceBudget;
  readonly memory: RenderMemoryBudget;
  readonly downgradeReasons: readonly string[];
}

interface TierBudget {
  maxBeautyPixels: number;
  memoryCapMiB: number;
  planarScale: number;
  planarMaxWidth: number;
  planarMaxHeight: number;
  planarCadenceMs: number;
  aoTaps: number;
  aoRadius: number;
  ssrSteps: number;
  ssrDistance: number;
}

const HYBRID_TIERS: Record<QualityLevel, TierBudget> = {
  low: {
    maxBeautyPixels: 1_350_000,
    memoryCapMiB: 42,
    planarScale: 0.35,
    planarMaxWidth: 768,
    planarMaxHeight: 432,
    planarCadenceMs: 100,
    aoTaps: 6,
    aoRadius: 8,
    ssrSteps: 6,
    ssrDistance: 85,
  },
  medium: {
    maxBeautyPixels: 2_300_000,
    memoryCapMiB: 68,
    planarScale: 0.5,
    planarMaxWidth: 1_024,
    planarMaxHeight: 576,
    planarCadenceMs: 1_000 / 15,
    aoTaps: 8,
    aoRadius: 11,
    ssrSteps: 10,
    ssrDistance: 130,
  },
  high: {
    maxBeautyPixels: 4_000_000,
    memoryCapMiB: 108,
    planarScale: 0.5,
    planarMaxWidth: 1_600,
    planarMaxHeight: 900,
    planarCadenceMs: 1_000 / 30,
    aoTaps: 12,
    aoRadius: 15,
    ssrSteps: 16,
    ssrDistance: 190,
  },
};

const RAY_MARCHED_TIERS: Record<QualityLevel, TierBudget> = {
  low: {
    ...HYBRID_TIERS.low,
    memoryCapMiB: 48,
    planarScale: 0.4,
    planarMaxWidth: 960,
    planarMaxHeight: 540,
    planarCadenceMs: 1_000 / 15,
    aoTaps: 8,
    ssrSteps: 12,
    ssrDistance: 130,
  },
  medium: {
    ...HYBRID_TIERS.medium,
    memoryCapMiB: 76,
    planarScale: 0.55,
    planarMaxWidth: 1_280,
    planarMaxHeight: 720,
    planarCadenceMs: 1_000 / 30,
    aoTaps: 12,
    aoRadius: 14,
    ssrSteps: 20,
    ssrDistance: 210,
  },
  high: {
    ...HYBRID_TIERS.high,
    memoryCapMiB: 124,
    planarScale: 0.67,
    planarMaxWidth: 1_920,
    planarMaxHeight: 1_080,
    planarCadenceMs: 1_000 / 60,
    aoTaps: 16,
    aoRadius: 18,
    ssrSteps: 28,
    ssrDistance: 280,
  },
};

function finiteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function fitDimensions(
  width: number,
  height: number,
  maximumWidth: number,
  maximumHeight: number,
  maximumPixels: number,
): { width: number; height: number; scaled: boolean } {
  const sourceWidth = finiteDimension(width);
  const sourceHeight = finiteDimension(height);
  const dimensionScale = Math.min(
    1,
    maximumWidth / sourceWidth,
    maximumHeight / sourceHeight,
  );
  const dimensionPixels = sourceWidth * sourceHeight * dimensionScale * dimensionScale;
  const pixelScale = dimensionPixels > maximumPixels
    ? Math.sqrt(maximumPixels / dimensionPixels)
    : 1;
  const scale = Math.min(dimensionScale, pixelScale);
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    scaled: scale < 0.9999,
  };
}

function scaledPlanarDimensions(
  beautyWidth: number,
  beautyHeight: number,
  tier: TierBudget,
  maximumTextureDimension: number,
): { width: number; height: number } {
  const width = beautyWidth * tier.planarScale;
  const height = beautyHeight * tier.planarScale;
  return fitDimensions(
    width,
    height,
    Math.min(tier.planarMaxWidth, maximumTextureDimension),
    Math.min(tier.planarMaxHeight, maximumTextureDimension),
    tier.planarMaxWidth * tier.planarMaxHeight,
  );
}

function estimateTargetBytes(
  format: HybridTargetFormat,
  beautyWidth: number,
  beautyHeight: number,
  effectsWidth: number,
  effectsHeight: number,
  planarWidth: number,
  planarHeight: number,
): number {
  const colorBytes = format === "rgba16f" ? 8 : 4;
  const depthBytes = 4;
  const beauty = beautyWidth * beautyHeight * (colorBytes + depthBytes);
  // Current effects plus history read/write ping-pong.
  const effects = effectsWidth * effectsHeight * colorBytes * 3;
  // One nearest-filtered RGBA8 previous-surface snapshot supplies 24-bit depth
  // plus a material tag for temporal disocclusion rejection.
  const surfaceHistory = effectsWidth * effectsHeight * 4;
  const planar = planarWidth * planarHeight * (colorBytes + depthBytes);
  return beauty + effects + surfaceHistory + planar;
}

/** Resolve every allocation and shader loop bound before the frame graph runs. */
export function resolveRenderProfile(
  request: RenderProfileRequest,
  capabilities: HybridRenderCapabilities,
): ResolvedRenderProfile {
  const outputWidth = finiteDimension(request.outputWidth);
  const outputHeight = finiteDimension(request.outputHeight);
  if (request.renderingMode === "balanced") {
    return {
      requestedMode: "balanced",
      activeMode: "balanced",
      technique: "forward",
      quality: request.quality,
      outputWidth,
      outputHeight,
      beautyWidth: outputWidth,
      beautyHeight: outputHeight,
      effectsWidth: 0,
      effectsHeight: 0,
      colorFormat: "rgba8",
      bypass: true,
      planar: { enabled: false, width: 0, height: 0, cadenceMs: 0, strength: 0 },
      screenSpace: {
        enabled: false,
        aoTaps: 0,
        aoRadius: 0,
        aoStrength: 0,
        ssrSteps: 0,
        ssrMaxDistance: 0,
        ssrThickness: 0,
        ssrStrength: 0,
        temporalHistoryWeight: 0,
        waterTemporalHistoryWeight: 0,
        waterDetailStrength: 0,
        shorelineStrength: 0,
      },
      memory: { capBytes: 0, estimatedBytes: 0 },
      downgradeReasons: [],
    };
  }

  const reasons: string[] = [];
  if (request.renderingMode === "ray-traced") {
    reasons.push(
      "No WebGPU ray-query backend is active; using half-resolution screen-space ray marching.",
    );
  }
  const tier = request.renderingMode === "ray-traced"
    ? RAY_MARCHED_TIERS[request.quality]
    : HYBRID_TIERS[request.quality];
  const maximumTextureDimension = Math.max(
    1,
    Math.min(capabilities.maxTextureSize, capabilities.maxRenderbufferSize),
  );
  let colorFormat: HybridTargetFormat =
    capabilities.colorBufferFloat && capabilities.floatLinearFiltering ? "rgba16f" : "rgba8";
  if (colorFormat === "rgba8") {
    reasons.push("Filtered half-float render targets unavailable; using RGBA8 effects.");
  }

  let beauty = fitDimensions(
    outputWidth,
    outputHeight,
    maximumTextureDimension,
    maximumTextureDimension,
    tier.maxBeautyPixels,
  );
  if (beauty.scaled) {
    reasons.push("Internal beauty resolution capped by the selected browser budget.");
  }
  let effectsWidth = Math.max(1, Math.ceil(beauty.width * 0.5));
  let effectsHeight = Math.max(1, Math.ceil(beauty.height * 0.5));
  let planar = scaledPlanarDimensions(
    beauty.width,
    beauty.height,
    tier,
    maximumTextureDimension,
  );
  const capBytes = tier.memoryCapMiB * 1_024 * 1_024;
  let estimatedBytes = estimateTargetBytes(
    colorFormat,
    beauty.width,
    beauty.height,
    effectsWidth,
    effectsHeight,
    planar.width,
    planar.height,
  );

  // Prefer an 8-bit linear effects path to silently exceeding a strict GPU
  // allocation cap. The analytic water glint still carries highlights.
  if (estimatedBytes > capBytes && colorFormat === "rgba16f") {
    colorFormat = "rgba8";
    reasons.push("Half-float effects exceeded the memory cap; using RGBA8 targets.");
    estimatedBytes = estimateTargetBytes(
      colorFormat,
      beauty.width,
      beauty.height,
      effectsWidth,
      effectsHeight,
      planar.width,
      planar.height,
    );
  }

  if (estimatedBytes > capBytes) {
    const scale = Math.max(0.25, Math.min(1, Math.sqrt(capBytes / estimatedBytes) * 0.985));
    beauty = fitDimensions(
      beauty.width * scale,
      beauty.height * scale,
      maximumTextureDimension,
      maximumTextureDimension,
      tier.maxBeautyPixels,
    );
    effectsWidth = Math.max(1, Math.ceil(beauty.width * 0.5));
    effectsHeight = Math.max(1, Math.ceil(beauty.height * 0.5));
    planar = scaledPlanarDimensions(
      beauty.width,
      beauty.height,
      tier,
      maximumTextureDimension,
    );
    estimatedBytes = estimateTargetBytes(
      colorFormat,
      beauty.width,
      beauty.height,
      effectsWidth,
      effectsHeight,
      planar.width,
      planar.height,
    );
    reasons.push("Internal targets reduced to remain within the GPU memory cap.");
  }

  return {
    requestedMode: request.renderingMode,
    activeMode: request.renderingMode === "ray-traced" ? "hybrid" : request.renderingMode,
    technique:
      request.renderingMode === "ray-traced"
        ? "ray-marched-screen-space"
        : "planar-screen-space",
    quality: request.quality,
    outputWidth,
    outputHeight,
    beautyWidth: beauty.width,
    beautyHeight: beauty.height,
    effectsWidth,
    effectsHeight,
    colorFormat,
    bypass: false,
    planar: {
      enabled: true,
      width: planar.width,
      height: planar.height,
      cadenceMs: tier.planarCadenceMs,
      // The target is radiance input, not the final reflectance. The water
      // shader applies Fresnel and roughness again, so keeping this below one
      // prevents a cached capture from reading as a literal mirror.
      strength: request.renderingMode === "ray-traced" ? 0.74 : 0.66,
    },
    screenSpace: {
      enabled: true,
      aoTaps: tier.aoTaps,
      aoRadius: tier.aoRadius,
      aoStrength: request.renderingMode === "ray-traced" ? 0.82 : 0.68,
      ssrSteps: tier.ssrSteps,
      ssrMaxDistance: tier.ssrDistance,
      ssrThickness: request.renderingMode === "ray-traced" ? 2.8 : 3.8,
      ssrStrength: request.renderingMode === "ray-traced" ? 0.22 : 0.09,
      temporalHistoryWeight: request.renderingMode === "ray-traced" ? 0.9 : 0.84,
      // Frame-rotated SSR jitter needs a short accumulation window to resolve
      // into a continuous reflection. Exact material/depth rejection now makes
      // this safe at shorelines and disocclusions; it is still far below the
      // static AO history so animated waves do not leave long trails.
      waterTemporalHistoryWeight: request.renderingMode === "ray-traced" ? 0.55 : 0.42,
      waterDetailStrength: {
        low: request.renderingMode === "ray-traced" ? 0.68 : 0.54,
        medium: request.renderingMode === "ray-traced" ? 0.86 : 0.72,
        high: request.renderingMode === "ray-traced" ? 1 : 0.9,
      }[request.quality],
      shorelineStrength: {
        low: request.renderingMode === "ray-traced" ? 0.54 : 0.42,
        medium: request.renderingMode === "ray-traced" ? 0.72 : 0.6,
        high: request.renderingMode === "ray-traced" ? 0.88 : 0.76,
      }[request.quality],
    },
    memory: { capBytes, estimatedBytes },
    downgradeReasons: reasons,
  };
}
