import { oceanTransformNormalizationScale } from "@/src/sim/water/spectrum";
import {
  assertSpectralOceanConfig,
  type OceanCascadeConfig,
  type SpectralOceanConfig,
} from "@/src/sim/water/spectrumConfig";
import {
  assertFiniteNumber,
  assertPositive,
  assertRange,
  isPowerOfTwo,
} from "./validation";

// The config and the transform normalisation moved to src/sim/water/ so the
// sim's sea twin reads the same definitions the GPU cascades are built from.
export {
  DEFAULT_SPECTRAL_OCEAN_CONFIG,
  assertSpectralOceanConfig,
  resolveSpectralOceanConfig,
  type OceanCascadeConfig,
  type SpectralOceanConfig,
  type SpectralOceanConfigInput,
} from "@/src/sim/water/spectrumConfig";
export { oceanTransformNormalizationScale };

export interface OceanFftDispatch {
  readonly axis: "horizontal" | "vertical";
  readonly stage: number;
  readonly dispatch: readonly [number, number, number];
  readonly normalize: boolean;
  readonly sourceSlot: "ping" | "pong";
  readonly destinationSlot: "ping" | "pong";
}

/**
 * 6-4: how much surface curvature one cascade's stored horizontal-displacement
 * Jacobian represents, in 1/m per unit of `J - 1`.
 *
 * The choppy displacement of a narrow band at wavenumber k is the Hilbert
 * transform of its height scaled by the choppiness — `D = (lambda/k) grad(eta)`
 * exactly, for a single wave — so the stored Jacobian's first-order part is
 * `J - 1 = tr(dD/dx) = (lambda/k) lap(eta)`, i.e.
 * `lap(eta) = (k/lambda) (J - 1)`. That Laplacian is the only property of the
 * surface that focuses the refracted sun beam, which is why the caustic term
 * can ride the channel the foam term already uses instead of inventing a
 * pattern of its own.
 *
 * k is taken at the GEOMETRIC MEAN of the cascade's band-pass limits, where a
 * JONSWAP slope spectrum truncated to that band is centred. The consequence
 * for the default cascades is physical and severe: the 0.5-8 m cascade
 * converts at 2.73 while the 512-2048 m cascade converts at 0.0053, so kilometre
 * swell contributes no caustic at all and the short band carries the whole
 * term — which is exactly right, since caustic focal length scales as 1/k.
 *
 * The choppiness floor bounds the amplification: as choppiness falls the
 * surface stops displacing horizontally and `J - 1` collapses to fp16 noise
 * around zero, so without a floor a near-zero choppiness would amplify that
 * noise instead of correctly reporting no signal.
 */
export const OCEAN_CAUSTIC_CHOPPINESS_FLOOR = 0.25;

export function oceanCausticCurvatureScale(
  cascade: OceanCascadeConfig,
  choppiness: number,
): number {
  assertPositive(cascade.minimumWavelengthMeters, "ocean.cascade.minimumWavelengthMeters");
  assertPositive(cascade.maximumWavelengthMeters, "ocean.cascade.maximumWavelengthMeters");
  assertFiniteNumber(choppiness, "ocean.choppiness");
  const representativeWavelength = Math.sqrt(
    cascade.minimumWavelengthMeters * cascade.maximumWavelengthMeters,
  );
  return (2 * Math.PI) / representativeWavelength
    / Math.max(choppiness, OCEAN_CAUSTIC_CHOPPINESS_FLOOR);
}

/** Dispatch sequence for the two-texture, two-complex-fields Stockham kernel. */
export function buildOceanFftDispatches(resolution: number): readonly OceanFftDispatch[] {
  if (!isPowerOfTwo(resolution) || resolution < 2) {
    throw new RangeError("FFT resolution must be a power of two");
  }
  const stages = Math.log2(resolution);
  const passes: OceanFftDispatch[] = [];
  let sourceSlot: "ping" | "pong" = "ping";
  for (const axis of ["horizontal", "vertical"] as const) {
    for (let stage = 0; stage < stages; stage += 1) {
      const destinationSlot: "ping" | "pong" = sourceSlot === "ping" ? "pong" : "ping";
      const dispatch: readonly [number, number, number] = axis === "horizontal"
        ? [Math.ceil((resolution / 2) / 8), Math.ceil(resolution / 8), 1]
        : [Math.ceil(resolution / 8), Math.ceil((resolution / 2) / 8), 1];
      passes.push(Object.freeze({
        axis,
        stage,
        dispatch,
        // 1B-13: fold 1/N into the LAST STAGE OF EACH AXIS. Folding the
        // full 1/N² anywhere earlier drops fp16 intermediates to
        // 1.5e-6…1.5e-4 — straddling the smallest fp16 normal (6.1e-5) —
        // and the small waves silently vanish into banding on cascade 0.
        normalize: stage === stages - 1,
        sourceSlot,
        destinationSlot,
      }));
      sourceSlot = destinationSlot;
    }
  }
  return Object.freeze(passes);
}

/**
 * Deterministic phase for one ocean cascade's fixed update cadence.
 *
 * The first two cascades update every frame. Slower power-of-two cadences are
 * placed into the light half of the faster schedule instead of all landing on
 * frame zero. This preserves each cascade's exact update frequency while
 * preventing the 1/1/2/4 tier-1 schedule from launching all four FFTs in one
 * frame (and likewise prevents the tier-2 /8 cascade joining that burst).
 */
export function oceanCascadeUpdatePhase(updateEveryNFrames: number): number {
  if (!Number.isSafeInteger(updateEveryNFrames) || updateEveryNFrames < 1) {
    throw new RangeError("Ocean update cadence must be a positive integer");
  }
  if (updateEveryNFrames === 1) return 0;
  return Math.max(0, Math.floor(updateEveryNFrames / 2) - 1);
}

/** True when a cascade is due on this absolute ocean frame. */
export function shouldUpdateOceanCascade(
  frameIndex: number,
  updateEveryNFrames: number,
): boolean {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("Ocean frame index must be a non-negative integer");
  }
  return frameIndex % updateEveryNFrames
    === oceanCascadeUpdatePhase(updateEveryNFrames);
}

/**
 * The ocean's absolute frame counter, which decides which cascades dispatch on
 * which frame (`shouldUpdateOceanCascade`).
 *
 * It is a class rather than a bare field so the perf harness can PIN it, and so
 * the thing tests exercise is the thing the ocean runs.
 *
 * Why it needs pinning. The counter is only ever incremented, and one renderer
 * serves every shot of a capture run, so at a shot's capture it holds the
 * render count of the whole run so far. The streaming loop before each shot is
 * paced by wall-clock time, so that count varies between runs of identical
 * code, and its residue mod 4 decides whether the every-4th-frame cascade
 * (128-512 m waves on tier 1) was last evolved at the capture frame or two
 * frames earlier (streaming counts are multiples of 30, so histories differ by
 * even counts). Measured 2026-09-22: two cascade-phase classes per static
 * shot, 0.12-0.40/255 mean apart over 13-51 % of the near sea depending on the
 * shot — enough to make a water baseline "move" on any run, full or filtered,
 * with no code change. It is what the alpine-turf A/B read as glints
 * "seeing the land through the reflection probe" (the probe renders only sky).
 *
 * `pinForCapture` resets the counter at the harness's time pin, so every shot's
 * capture lands on the same cadence phase whatever streamed before it. It does
 * not touch foam, which carries a few seconds of pre-pin history of its own: a
 * named floor on near water between captures whose OWN streaming counts
 * differ, growing with that difference and still rising at 240 frames (mean
 * /255 over water-25ft's sea: 0.007 at 60 frames, 0.012 at 150). Where the
 * shot's own count matches, pinned captures of the same list agree over the
 * sea to within a few dozen 1-LSB pixels — the previous shot's foam, about 4 %
 * of it, still reaching the capture.
 */
export class OceanCascadeClock {
  private frameIndex = 0;

  /** Advances one rendered ocean frame. */
  tick(): void {
    this.frameIndex += 1;
  }

  /** True when a cascade with this cadence dispatches on the current frame. */
  dispatches(updateEveryNFrames: number): boolean {
    return shouldUpdateOceanCascade(this.frameIndex, updateEveryNFrames);
  }

  /**
   * CAPTURE ONLY: restarts the cadence at the harness's per-shot time pin. The
   * game never calls this, and nothing but the perf harness may (a source-scan
   * test holds that line). Mid-flight it would make every slow cascade
   * dispatch out of turn.
   */
  pinForCapture(): void {
    this.frameIndex = 0;
  }
}

function uniformBuffer(byteLength: number): { buffer: ArrayBuffer; view: DataView } {
  const buffer = new ArrayBuffer(byteLength);
  return { buffer, view: new DataView(buffer) };
}

/** Binary layout matching `OceanSpectrumInitParams` in OceanShaders.ts. */
export function packOceanInitializationUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const { buffer, view } = uniformBuffer(64);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, config.seed, true);
  view.setUint32(8, cascadeIndex, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, cascade.patchLengthMeters, true);
  view.setFloat32(20, config.gravityMetersPerSecondSquared, true);
  view.setFloat32(24, config.windSpeedMetersPerSecond, true);
  view.setFloat32(28, config.fetchLengthMeters, true);
  view.setFloat32(32, config.windDirection[0], true);
  view.setFloat32(36, config.windDirection[1], true);
  view.setFloat32(40, cascade.spectrumScale, true);
  view.setFloat32(44, config.directionalSpread, true);
  view.setFloat32(48, config.representativeDepthMeters, true);
  view.setFloat32(52, config.surfaceTensionOverDensity, true);
  view.setFloat32(56, cascade.minimumWavelengthMeters, true);
  view.setFloat32(60, cascade.maximumWavelengthMeters, true);
  return buffer;
}

/** Binary layout matching `OceanEvolutionParams` in OceanShaders.ts. */
export function packOceanEvolutionUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
  timeSeconds: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  assertFiniteNumber(timeSeconds, "timeSeconds");
  if (config.cascades[cascadeIndex] === undefined) {
    throw new RangeError("Invalid ocean cascade index");
  }
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, cascadeIndex, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, timeSeconds, true);
  view.setFloat32(20, config.gravityMetersPerSecondSquared, true);
  view.setFloat32(24, config.representativeDepthMeters, true);
  view.setFloat32(28, config.choppiness, true);
  return buffer;
}

/**
 * Binary layout matching `OceanFftParams` in OceanShaders.ts.
 *
 * wave R turned the trailing u32 flag into a f32 scale in its own std140 slot
 * (offset 16): the normalisation is no longer `1/N` but a per-cascade
 * physical constant, so the pass has to carry the number rather than a
 * boolean. Non-normalising passes pass 1.
 */
export function packOceanFftUniforms(
  resolution: number,
  stage: number,
  axis: "horizontal" | "vertical",
  normalizationScale: number,
): ArrayBuffer {
  const stages = Math.log2(resolution);
  if (!isPowerOfTwo(resolution) || !Number.isSafeInteger(stage) || stage < 0 || stage >= stages) {
    throw new RangeError("Invalid FFT resolution or stage");
  }
  assertPositive(normalizationScale, "ocean.fftNormalizationScale");
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, resolution, true);
  view.setUint32(4, stage, true);
  view.setUint32(8, axis === "horizontal" ? 0 : 1, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, normalizationScale, true);
  return buffer;
}

/** Binary layout matching `OceanDeriveParams` in OceanShaders.ts. */
export function packOceanDerivationUniforms(
  config: SpectralOceanConfig,
  cascadeIndex: number,
  deltaSeconds: number,
): ArrayBuffer {
  assertSpectralOceanConfig(config);
  assertRange(deltaSeconds, 0, 1, "deltaSeconds");
  const cascade = config.cascades[cascadeIndex];
  if (cascade === undefined) throw new RangeError("Invalid ocean cascade index");
  const { buffer, view } = uniformBuffer(32);
  view.setUint32(0, config.resolution, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, cascade.patchLengthMeters / config.resolution, true);
  view.setFloat32(20, config.foamThreshold, true);
  view.setFloat32(24, config.foamGain, true);
  view.setFloat32(28, Math.exp(-Math.LN2 * deltaSeconds / config.foamHalfLifeSeconds), true);
  return buffer;
}
