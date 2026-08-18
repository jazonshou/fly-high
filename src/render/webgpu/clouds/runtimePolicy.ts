import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";

export interface CloudRenderSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface CloudShadowSchedule {
  readonly resolution: number;
  readonly steps: number;
  readonly updateEveryNFrames: number;
  readonly historyWeight: number;
}

const CLOUD_RENDER_ALIGNMENT = 8;

function assertDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function alignScaledDimension(fullResolution: number, scale: number): number {
  if (scale === 1 || fullResolution < CLOUD_RENDER_ALIGNMENT) return fullResolution;
  const target = Math.max(1, Math.round(fullResolution * scale));
  const aligned = Math.max(
    CLOUD_RENDER_ALIGNMENT,
    Math.round(target / CLOUD_RENDER_ALIGNMENT) * CLOUD_RENDER_ALIGNMENT,
  );
  return Math.min(fullResolution, aligned);
}

/** Resolves a stable, workgroup-friendly cloud target from the live back-buffer size. */
export function resolveCloudRenderSize(
  fullWidth: number,
  fullHeight: number,
  scale: number,
  maxCloudPixels: number = Number.POSITIVE_INFINITY,
): CloudRenderSize {
  assertDimension(fullWidth, "fullWidth");
  assertDimension(fullHeight, "fullHeight");
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new RangeError("cloudResolutionScale must be finite and in (0, 1]");
  }
  if (!(maxCloudPixels > 0)) {
    throw new RangeError("maxCloudPixels must be positive");
  }
  // 2-6: a multiply is not a cap (the 1A-6a argument). The scale inherits
  // whatever the main resolution is, so an ABSOLUTE per-tier pixel ceiling
  // clamps the effective scale before alignment.
  let effectiveScale = scale;
  const requestedPixels = fullWidth * fullHeight * scale * scale;
  if (requestedPixels > maxCloudPixels) {
    effectiveScale = Math.sqrt(maxCloudPixels / (fullWidth * fullHeight));
  }
  return Object.freeze({
    width: alignScaledDimension(fullWidth, effectiveScale),
    height: alignScaledDimension(fullHeight, effectiveScale),
    scale: effectiveScale,
  });
}

/**
 * Keeps projected cloud shadows bounded independently from the view-ray budget.
 * The medium and high tiers share a 256px map; high spends its budget on cadence
 * and optical-depth samples, where the visual return is larger.
 */
export function resolveCloudShadowSchedule(
  profile: Pick<WebGpuQualityProfile, "cloudResolutionScale">,
): CloudShadowSchedule {
  const scale = profile.cloudResolutionScale;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new RangeError("cloudResolutionScale must be finite and in (0, 1]");
  }
  if (scale <= 0.3) {
    return Object.freeze({
      resolution: 256,
      steps: 8,
      updateEveryNFrames: 4,
      historyWeight: 0.78,
    });
  }
  if (scale <= 0.55) {
    return Object.freeze({
      resolution: 512,
      steps: 10,
      updateEveryNFrames: 3,
      historyWeight: 0.86,
    });
  }
  return Object.freeze({
    resolution: 512,
    steps: 14,
    updateEveryNFrames: 2,
    historyWeight: 0.9,
  });
}

export function shouldRenderCloudShadow(
  frameIndex: number,
  lastRenderedFrame: number,
  updateEveryNFrames: number,
  dirty: boolean,
): boolean {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("frameIndex must be a non-negative integer");
  }
  if (!Number.isSafeInteger(lastRenderedFrame) || lastRenderedFrame < -1) {
    throw new RangeError("lastRenderedFrame must be -1 or a non-negative integer");
  }
  if (!Number.isSafeInteger(updateEveryNFrames) || updateEveryNFrames < 1) {
    throw new RangeError("updateEveryNFrames must be a positive integer");
  }
  return dirty || lastRenderedFrame < 0 || frameIndex - lastRenderedFrame >= updateEveryNFrames;
}
