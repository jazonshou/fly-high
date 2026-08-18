import type { WorldSeed } from "./types";

const UNIT_24BIT_SCALE = 1 / 16_777_216;

function avalanche(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb_352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846c_a68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function normalizeSeed(seed: WorldSeed): string {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new RangeError("World seed numbers must be finite");
    }
    return Object.is(seed, -0) ? "-0" : String(seed);
  }
  return seed;
}

/** Stable UTF-16 FNV-1a hash with a final avalanche. */
export function hashSeed(seed: WorldSeed): number {
  const text = normalizeSeed(seed);
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return avalanche(hash);
}

/** Derive an independent deterministic channel from a seed/hash. */
export function mixSeed(seedHash: number, channel: number): number {
  return avalanche((seedHash >>> 0) ^ Math.imul(channel | 0, 0x9e37_79b1));
}

/** Deterministically hash a signed integer lattice coordinate pair. */
export function hashCoordinates(
  seedHash: number,
  x: number,
  z: number,
  channel = 0,
): number {
  return hashLatticeCoordinates(mixSeed(seedHash, channel), x, z);
}

/**
 * The coordinate half of hashCoordinates, taking an already channel-mixed
 * hash. valueNoise2D mixes once and hashes four corners — this is the
 * hottest arithmetic in the codebase.
 */
export function hashLatticeCoordinates(mixedHash: number, x: number, z: number): number {
  // Avalanche each axis independently so swapped or jointly-negated coordinate
  // pairs cannot collapse through XOR symmetry.
  const hash = avalanche(mixedHash ^ Math.imul(x | 0, 0x8da6_b343));
  return avalanche(hash ^ Math.imul(z | 0, 0xd816_3841));
}

/**
 * Convert a uint32 hash to a reproducible value in the half-open range [0, 1).
 *
 * The quotient keeps 24 bits (0-4): `(hash >>> 8) / 2^24` is exactly
 * representable in f32, so the WGSL port (4-1) reproduces it bit-for-bit,
 * where the previous 32-bit quotient could never be matched above 2^24.
 * 24 bits is 16× more entropy than a noise lattice consumes.
 */
export function unitFloatFromHash(hash: number): number {
  return (hash >>> 8) * UNIT_24BIT_SCALE;
}
