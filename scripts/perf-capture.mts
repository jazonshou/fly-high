/**
 * Fixed-seed screenshot and numeric capture (1A-1c) — the pure half.
 *
 * INVARIANT THIS FILE OWNS: the perf capture's shot list, image statistics
 * (tile-wise mean/variance) and the SSIM comparison are deterministic pure
 * functions, so a baseline diff can only come from the renderer.
 *
 * The driver that boots the renderer lives in tests/perf/perf-capture.test.ts
 * and runs under vitest.perf.config.ts (`npm run perf:capture`); it imports
 * everything below. Class P: no Babylon, no DOM, no Node APIs.
 */

export const PERF_CAPTURE_SEED = "phase1-perf-baseline";
export const PERF_CAPTURE_WIDTH = 1_280;
export const PERF_CAPTURE_HEIGHT = 720;
/** Frames rendered before the capture so streaming and temporal state settle. */
export const PERF_CAPTURE_WARMUP_FRAMES = 240;
export const PERF_CAPTURE_TILE = 32;
/** SSIM below this against the committed baseline fails the capture. */
export const PERF_CAPTURE_SSIM_THRESHOLD = 0.985;

export interface PerfCaptureShotDefinition {
  readonly name: string;
  readonly description: string;
  readonly cameraMode: "chase" | "cockpit";
  /** Metres above the local terrain (AGL shots) — resolved by the driver. */
  readonly altitudeAglMeters: number | null;
  /** Metres above sea level when not AGL-anchored. */
  readonly altitudeMslMeters: number | null;
  /** Horizontal offset from the airport centre, metres. */
  readonly offsetXMeters: number;
  readonly offsetZMeters: number;
  /** Pitch-down angle of the aircraft body, degrees. */
  readonly pitchDownDegrees: number;
  readonly airspeedMetersPerSecond: number;
}

/**
 * The three shots from the plan: 500 ft AGL on approach, a 10 km slant view,
 * and 10,000 ft looking down. Positions are relative to the world's airport
 * so the same definitions survive seed changes at sanctioned rebaselines.
 */
export const PERF_CAPTURE_SHOTS: readonly PerfCaptureShotDefinition[] = Object.freeze([
  {
    name: "approach-500ft",
    description: "500 ft AGL, 2.5 km out on approach to the airport",
    cameraMode: "chase",
    altitudeAglMeters: 152,
    altitudeMslMeters: null,
    offsetXMeters: -2_500,
    offsetZMeters: 0,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 62,
  },
  {
    name: "slant-10km",
    description: "Mid-altitude view with ~10 km of terrain in slant range",
    cameraMode: "chase",
    altitudeAglMeters: null,
    altitudeMslMeters: 1_200,
    offsetXMeters: -8_000,
    offsetZMeters: 4_000,
    pitchDownDegrees: 0,
    airspeedMetersPerSecond: 84,
  },
  {
    name: "high-10000ft-down",
    description: "10,000 ft MSL, cockpit view pitched 45° down",
    cameraMode: "cockpit",
    altitudeAglMeters: null,
    altitudeMslMeters: 3_048,
    offsetXMeters: 2_000,
    offsetZMeters: -6_000,
    pitchDownDegrees: 45,
    airspeedMetersPerSecond: 92,
  },
]);

export interface TileStatistics {
  readonly tileEdge: number;
  readonly columns: number;
  readonly rows: number;
  /** Mean of per-tile mean luminance, 0..1. */
  readonly meanLuminance: number;
  /** Mean of per-tile luminance variance. */
  readonly meanVariance: number;
  /** Per-tile means, row-major, rounded for a stable JSON diff. */
  readonly tileMeans: readonly number[];
}

export interface PerfCaptureShotReport {
  readonly name: string;
  readonly description: string;
  readonly ssimAgainstBaseline: number | null;
  readonly tiles: TileStatistics;
  readonly fps: number;
  readonly cpuFrameMsP95: number;
  readonly gpuFrameMsP95: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly residentTerrainPages: number;
  readonly pendingTerrainPages: number;
  readonly renderPixels: number;
  readonly estimatedGpuMemoryMiB: number;
}

export interface PerfCaptureReport {
  readonly seed: string;
  readonly width: number;
  readonly height: number;
  readonly warmupFrames: number;
  /** Mean milliseconds to generate one 512 m tile at resolution 65. */
  readonly pageGenerationMs: number;
  readonly shots: readonly PerfCaptureShotReport[];
}

/** Rec. 709 luma from an RGBA byte buffer. */
export function luminanceFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  if (rgba.length < width * height * 4) {
    throw new RangeError("RGBA buffer is smaller than width × height × 4");
  }
  const out = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    out[index] =
      (0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!) / 255;
  }
  return out;
}

export function tileStatistics(
  luminance: Float32Array,
  width: number,
  height: number,
  tileEdge = PERF_CAPTURE_TILE,
): TileStatistics {
  if (luminance.length !== width * height) {
    throw new RangeError("Luminance buffer does not match width × height");
  }
  const columns = Math.floor(width / tileEdge);
  const rows = Math.floor(height / tileEdge);
  const tileMeans: number[] = [];
  let varianceSum = 0;
  for (let tileRow = 0; tileRow < rows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < columns; tileColumn += 1) {
      let sum = 0;
      let sumSquares = 0;
      for (let y = 0; y < tileEdge; y += 1) {
        const rowOffset = (tileRow * tileEdge + y) * width + tileColumn * tileEdge;
        for (let x = 0; x < tileEdge; x += 1) {
          const value = luminance[rowOffset + x]!;
          sum += value;
          sumSquares += value * value;
        }
      }
      const count = tileEdge * tileEdge;
      const mean = sum / count;
      tileMeans.push(Math.round(mean * 10_000) / 10_000);
      varianceSum += Math.max(0, sumSquares / count - mean * mean);
    }
  }
  const tileCount = Math.max(1, tileMeans.length);
  return {
    tileEdge,
    columns,
    rows,
    meanLuminance:
      Math.round((tileMeans.reduce((a, b) => a + b, 0) / tileCount) * 10_000) / 10_000,
    meanVariance: Math.round((varianceSum / tileCount) * 1_000_000) / 1_000_000,
    tileMeans,
  };
}

/**
 * Mean SSIM over non-overlapping 8×8 windows of two equal-size luminance
 * images (constants for L = 1). Small and dependency-free; plenty to catch a
 * real regression while tolerating temporal-noise-level differences.
 */
export function meanSsim(
  first: Float32Array,
  second: Float32Array,
  width: number,
  height: number,
  window = 8,
): number {
  if (first.length !== second.length || first.length !== width * height) {
    throw new RangeError("SSIM inputs must be equal-size luminance buffers");
  }
  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;
  let total = 0;
  let windows = 0;
  for (let top = 0; top + window <= height; top += window) {
    for (let left = 0; left + window <= width; left += window) {
      let sumA = 0;
      let sumB = 0;
      let sumAa = 0;
      let sumBb = 0;
      let sumAb = 0;
      for (let y = 0; y < window; y += 1) {
        const row = (top + y) * width + left;
        for (let x = 0; x < window; x += 1) {
          const a = first[row + x]!;
          const b = second[row + x]!;
          sumA += a;
          sumB += b;
          sumAa += a * a;
          sumBb += b * b;
          sumAb += a * b;
        }
      }
      const n = window * window;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = Math.max(0, sumAa / n - meanA * meanA);
      const varB = Math.max(0, sumBb / n - meanB * meanB);
      const covariance = sumAb / n - meanA * meanB;
      total +=
        ((2 * meanA * meanB + c1) * (2 * covariance + c2))
        / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 1;
}
