import { hashCoordinates, mixSeed, unitFloatFromHash } from "./seed";

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function saturate(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

export function smoothstep(low: number, high: number, value: number): number {
  if (low === high) return value < low ? 0 : 1;
  const t = saturate((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function latticeValue(seedHash: number, x: number, z: number): number {
  return unitFloatFromHash(hashCoordinates(seedHash, x, z)) * 2 - 1;
}

/**
 * Per-octave domain-wrap period, in lattice cells (0-4).
 *
 * Every noise lattice is periodic with this period: coordinates are reduced by
 * an integer multiple of it, in f64, before any floor. The reduction is an
 * exact no-op for |coordinate| < 65,536 cells, and outputs are bit-identical
 * to the unwrapped kernel below 65,535 cells — 2.8×10⁶ m at the finest 43 m
 * octave, farther for every coarser one — so near-origin worlds are
 * unchanged. (In the final cell before the seam, the upper lattice neighbour
 * is rehashed as -period/2 for seam continuity.) Beyond that, f32 loses the lattice-cell fraction (~1.6×10⁻²
 * of a cell at 5×10⁶ m / 43 m), so a WGSL port could never agree with the CPU
 * about which cell a boundary point falls in. Wrapping bounds every
 * coordinate the GPU sees: 4-1 hoists the f64 multiple into the page-origin
 * uniform, and both wrapped lattice indices (|i| ≤ 2^16) and residuals are
 * exactly representable on both sides.
 */
export const NOISE_LATTICE_WRAP_PERIOD_CELLS = 131_072;
const HALF_WRAP_PERIOD = NOISE_LATTICE_WRAP_PERIOD_CELLS / 2;

/** Centered reduction into [-period/2, period/2), computed in f64. */
function wrapLatticeCoordinate(value: number): number {
  const periods = Math.round(value / NOISE_LATTICE_WRAP_PERIOD_CELLS);
  return periods === 0 ? value : value - periods * NOISE_LATTICE_WRAP_PERIOD_CELLS;
}

/**
 * The upper lattice neighbour of the last wrapped cell is the first cell of
 * the next period; hashing it as -period/2 is what makes the seam continuous.
 */
function wrapLatticeIndex(index: number): number {
  return index >= HALF_WRAP_PERIOD ? index - NOISE_LATTICE_WRAP_PERIOD_CELLS : index;
}

/** Continuous deterministic 2D value noise in approximately [-1, 1]. */
export function valueNoise2D(seedHash: number, x: number, z: number): number {
  const wrappedX = wrapLatticeCoordinate(x);
  const wrappedZ = wrapLatticeCoordinate(z);
  const x0 = Math.floor(wrappedX);
  const z0 = Math.floor(wrappedZ);
  const tx = fade(wrappedX - x0);
  const tz = fade(wrappedZ - z0);
  const x1 = wrapLatticeIndex(x0 + 1);
  const z1 = wrapLatticeIndex(z0 + 1);

  const a = lerp(latticeValue(seedHash, x0, z0), latticeValue(seedHash, x1, z0), tx);
  const b = lerp(
    latticeValue(seedHash, x0, z1),
    latticeValue(seedHash, x1, z1),
    tx,
  );
  return lerp(a, b, tz);
}

/** Normalized fractal Brownian motion in approximately [-1, 1]. */
export function fbm2D(
  seedHash: number,
  x: number,
  z: number,
  octaves: number,
  lacunarity = 2,
  persistence = 0.5,
): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let amplitudeSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = mixSeed(seedHash, octave + 1);
    sum += valueNoise2D(octaveSeed, x * frequency, z * frequency) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return amplitudeSum > 0 ? sum / amplitudeSum : 0;
}

/** Ridged multifractal noise in [0, 1], useful for mountain ranges. */
export function ridgedFbm2D(
  seedHash: number,
  x: number,
  z: number,
  octaves: number,
): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let amplitudeSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = mixSeed(seedHash, 31 + octave);
    const ridge = 1 - Math.abs(valueNoise2D(octaveSeed, x * frequency, z * frequency));
    sum += ridge * ridge * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.52;
    frequency *= 2.03;
  }

  return amplitudeSum > 0 ? saturate(sum / amplitudeSum) : 0;
}
