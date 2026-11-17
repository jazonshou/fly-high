/**
 * Deterministic 3-D gradient noise (Perlin's improved noise, 2002) and a
 * band-limited fractal sum for the texture bake.
 */
const PERMUTATION = (() => {
  // A fixed shuffle (a linear congruential generator, seeded), so every bake paints the same.
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 0x5eed1234;
  for (let i = 255; i > 0; i -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return Uint8Array.from([...p, ...p]);
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (hash: number, x: number, y: number, z: number) => {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
};

/** Gradient noise in about [-1, 1], unit feature size. */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const p = PERMUTATION;
  const A = p[X]! + Y;
  const AA = p[A]! + Z;
  const AB = p[A + 1]! + Z;
  const B = p[X + 1]! + Y;
  const BA = p[B]! + Z;
  const BB = p[B + 1]! + Z;
  const lerp = (t: number, a: number, b: number) => a + t * (b - a);
  return lerp(
    w,
    lerp(v, lerp(u, grad(p[AA]!, x, y, z), grad(p[BA]!, x - 1, y, z)), lerp(u, grad(p[AB]!, x, y - 1, z), grad(p[BB]!, x - 1, y - 1, z))),
    lerp(v, lerp(u, grad(p[AA + 1]!, x, y, z - 1), grad(p[BA + 1]!, x - 1, y, z - 1)), lerp(u, grad(p[AB + 1]!, x, y - 1, z - 1), grad(p[BB + 1]!, x - 1, y - 1, z - 1))),
  );
}

/**
 * Fractal noise from `size` (metres) down, octaves finer than `texel` x 2
 * left out (they would alias), the last one faded.
 */
export function fbm(x: number, y: number, z: number, size: number, octaves: number, texel: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / size;
  for (let o = 0; o < octaves; o += 1) {
    const feature = 1 / f;
    const keep = Math.min(1, Math.max(0, (feature - 2 * texel) / (2 * texel)));
    if (keep <= 0) break;
    sum += noise3(x * f + o * 17.3, y * f + o * 31.7, z * f + o * 5.9) * amp * keep;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Cellular (Worley) distance to the nearest feature point, in cells; for leather grain and pores. */
export function cellular(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz += 1)
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const cx = xi + dx;
        const cy = yi + dy;
        const cz = zi + dz;
        const h = PERMUTATION[(PERMUTATION[(PERMUTATION[cx & 255]! + (cy & 255)) & 511]! + (cz & 255)) & 511]!;
        const fx = cx + ((h * 37) % 256) / 256;
        const fy = cy + ((h * 91) % 256) / 256;
        const fz = cz + ((h * 53) % 256) / 256;
        const d = (fx - x) * (fx - x) + (fy - y) * (fy - y) + (fz - z) * (fz - z);
        if (d < best) best = d;
      }
  return Math.sqrt(best);
}
