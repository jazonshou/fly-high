/**
 * B1: the hardware scaling level the renderer applies, and when applying it
 * resizes the canvas.
 *
 * `engine.resize(true)` re-sizes the canvas and rebuilds the main attachments
 * even when nothing changed, and one issued after `endFrame()` throws away the
 * frame that was just drawn. The governor decides at the END of `render()`,
 * and on a Retina panel at medium the pixel cap usually absorbs its step, so
 * a step that changed nothing still cost a drawn frame. The ResizeObserver
 * also fires after rAF has drawn. Both now defer to the next frame's start,
 * and only a level change or a forced request resizes at all.
 */

export interface HardwareScalingInputs {
  /** The tier's device-pixel-ratio ceiling. */
  readonly maxDevicePixelRatio: number;
  /** `window.devicePixelRatio`; 0 reads as 1. */
  readonly devicePixelRatio: number;
  readonly renderScale: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** The tier's absolute budget of rendered pixels. */
  readonly maxRenderPixels: number;
}

/** A level within this of the applied one is the same level. */
export const HARDWARE_SCALING_LEVEL_EPSILON = 1e-4;

/** Babylon's hardware scaling level for the capped scale product. */
export function resolveHardwareScalingLevel(inputs: HardwareScalingInputs): number {
  // 1A-6a: the device pixel ratio is a per-tier ceiling, not a multiplier the
  // display gets to raise for free, and the total scale product is clamped by
  // an absolute pixel budget. The previous code multiplied DPR into the scale
  // uncapped, so a Retina panel rendered 5.94 Mpx at tier 2 before any work.
  const pixelRatio = Math.min(
    inputs.maxDevicePixelRatio,
    inputs.devicePixelRatio || 1,
  );
  const requestedScale = Math.max(0.1, pixelRatio * inputs.renderScale);
  const cssPixels = Math.max(1, inputs.cssWidth * inputs.cssHeight);
  // Rendered pixels = cssPixels × totalScale², so the absolute cap on pixels
  // is a cap of sqrt(maxRenderPixels / cssPixels) on the total scale product.
  const pixelCapScale = Math.sqrt(inputs.maxRenderPixels / cssPixels);
  return 1 / Math.min(requestedScale, pixelCapScale);
}

/** PR B part 2 (G4): the unpinned governor never shrinks the frame below this many pixels. */
export const GOVERNED_MIN_RENDER_PIXELS = 400_000;
/**
 * PR B part 2 (G4): a governed frame within this share of the minimum lands
 * on it, and a minimum within it of the capped frame leaves no lever at all.
 * A step onto the minimum from under 4% above it would cost a resize, a
 * target reallocation and a history reset for a change no step test can
 * see; as "unchanged" it is absorbed by the anti-ratchet latch instead (red
 * team). From further above, a step onto the minimum is a real one and moves
 * the pixels by 1 - 1/1.04 (3.85%) or more: the snap is measured from the
 * minimum, so it does not promise the 8% of a full step.
 */
export const GOVERNED_MIN_SNAP_PIXEL_RATIO = 1.04;

export interface GovernedScalingInputs extends HardwareScalingInputs {
  /** The governor's ceiling, the profile's render scale: the pixel cap is judged there. */
  readonly ceilingScale: number;
  readonly minRenderPixels: number;
}

/**
 * PR B part 2 (G4, unpinned only): the governor's scale as a factor on the
 * CAPPED frame, renderScale / ceilingScale, never below minRenderPixels and
 * snapped onto it within 4%. At the ceiling it is
 * `resolveHardwareScalingLevel`'s own expression, bit for bit. The floor on
 * the factor is the governor's (`scaleFloor`), not this function's.
 */
export function resolveGovernedHardwareScalingLevel(inputs: GovernedScalingInputs): number {
  const pixelRatio = Math.min(inputs.maxDevicePixelRatio, inputs.devicePixelRatio || 1);
  const requestedScale = Math.max(0.1, pixelRatio * inputs.ceilingScale);
  const cssPixels = Math.max(1, inputs.cssWidth * inputs.cssHeight);
  const pixelCapScale = Math.sqrt(inputs.maxRenderPixels / cssPixels);
  const capped = Math.min(requestedScale, pixelCapScale);
  const factor = inputs.renderScale / inputs.ceilingScale;
  if (!(factor < 1)) return 1 / capped;
  // The minimum as a share of the capped frame's pixels. A capped frame
  // under the minimum, or within 4% of it, never shrinks.
  const minShare = inputs.minRenderPixels / (cssPixels * capped * capped);
  if (minShare * GOVERNED_MIN_SNAP_PIXEL_RATIO >= 1) return 1 / capped;
  const minFactor = Math.sqrt(minShare);
  const snapped = factor * factor < minShare * GOVERNED_MIN_SNAP_PIXEL_RATIO ? minFactor : factor;
  return 1 / (capped * Math.max(minFactor, snapped));
}

export function scalingLevelChanged(level: number, current: number): boolean {
  return Math.abs(level - current) > HARDWARE_SCALING_LEVEL_EPSILON;
}

/** The engine calls applying a level takes; `WebGPUEngine` satisfies it. */
export interface HardwareScalingEngine {
  getHardwareScalingLevel(): number;
  setHardwareScalingLevel(level: number): void;
  resize(forceSetSize?: boolean): void;
}

/**
 * Sets `level` when it differs from the engine's, then resizes only when it
 * changed or `force` asks. Babylon 9's `setHardwareScalingLevel` already
 * resizes unforced, and an unforced resize returns early when the canvas size
 * is unchanged, so the unforced call after it costs nothing. Returns whether
 * the level changed.
 */
export function applyHardwareScalingLevel(
  engine: HardwareScalingEngine,
  level: number,
  force: boolean,
): boolean {
  const changed = scalingLevelChanged(level, engine.getHardwareScalingLevel());
  if (changed) engine.setHardwareScalingLevel(level);
  if (changed || force) engine.resize(force);
  return changed;
}

export interface RenderScaleRequest {
  /** Resize even at an unchanged level: the CSS size moved. */
  readonly force: boolean;
  /** Clear the timing window too, as a display resize always has. */
  readonly resetTimingWindow: boolean;
  /** The frame-graph history invalidation reason. */
  readonly reason: string;
}

export interface RenderScaleApplication extends RenderScaleRequest {
  readonly changed: boolean;
}

export const DISPLAY_RESIZE_REQUEST: RenderScaleRequest = Object.freeze({
  force: true,
  resetTimingWindow: true,
  reason: "display resize",
});

export const GOVERNED_SCALE_REQUEST: RenderScaleRequest = Object.freeze({
  force: false,
  resetTimingWindow: false,
  reason: "dynamic resolution changed",
});

/** Two requests waiting for the same frame start: the forced one's reason wins. */
export function mergeRenderScaleRequests(
  pending: RenderScaleRequest | null,
  next: RenderScaleRequest,
): RenderScaleRequest {
  if (pending === null) return next;
  return {
    force: pending.force || next.force,
    resetTimingWindow: pending.resetTimingWindow || next.resetTimingWindow,
    reason: next.force && !pending.force ? next.reason : pending.reason,
  };
}

/**
 * The renderer's one owner of the hardware scaling level. Construction, a
 * profile change and a capture pin apply forced and immediately, as they
 * always have; a governor step and an unpinned display resize wait for the
 * next frame's start, before anything is drawn. The level itself is resolved
 * when it is applied, from the scale and CSS size current then.
 */
export class RenderScaleQueue {
  private pending: RenderScaleRequest | null = null;

  constructor(
    private readonly engine: HardwareScalingEngine,
    private readonly resolveLevel: () => number,
  ) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Forced and immediate. Returns whether the level changed. */
  applyNow(): boolean {
    return applyHardwareScalingLevel(this.engine, this.resolveLevel(), true);
  }

  /**
   * Whether applying the current scale would change the level. The governor
   * needs this when it decides (`observeRenderScaleApplication`), a frame
   * before the level is applied.
   */
  levelWouldChange(): boolean {
    return scalingLevelChanged(this.resolveLevel(), this.engine.getHardwareScalingLevel());
  }

  /** Waits for the next `applyPending`; survives any number of skipped frames. */
  defer(request: RenderScaleRequest): void {
    this.pending = mergeRenderScaleRequests(this.pending, request);
  }

  /** At a frame's start, before `beginFrame`. Null when nothing waited. */
  applyPending(): RenderScaleApplication | null {
    const request = this.pending;
    if (request === null) return null;
    this.pending = null;
    const changed = applyHardwareScalingLevel(this.engine, this.resolveLevel(), request.force);
    return { ...request, changed };
  }
}
