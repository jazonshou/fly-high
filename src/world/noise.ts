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

/** Continuous deterministic 2D value noise in approximately [-1, 1]. */
export function valueNoise2D(seedHash: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const tz = fade(z - z0);

  const a = lerp(latticeValue(seedHash, x0, z0), latticeValue(seedHash, x0 + 1, z0), tx);
  const b = lerp(
    latticeValue(seedHash, x0, z0 + 1),
    latticeValue(seedHash, x0 + 1, z0 + 1),
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
