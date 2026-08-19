/**
 * Blue-noise tile generation (2-0a).
 *
 * INVARIANT THIS FILE OWNS: the cloud ray-march's jitter texture is a real
 * blue-noise tile — high-frequency energy, no low-frequency clumps — and it
 * is generated deterministically at startup, not shipped as a binary asset
 * (the repository deliberately carries no image files).
 *
 * The method is void-and-cluster (Ulichney): start from a deterministic
 * white-noise seed pattern, then repeatedly move the "tightest cluster"
 * pixel into the "largest void" under a toroidal Gaussian energy field until
 * the swap converges, and rank pixels by removal order to produce a uniform
 * threshold matrix. 64×64 is plenty for a ray-jitter tile and generates in
 * a few milliseconds.
 *
 * Class P: pure functions over numbers, Node-testable.
 */

export const BLUE_NOISE_SIZE = 64;

/** Deterministic 32-bit PCG-ish hash for the seed pattern. */
function hash(value: number): number {
  let state = (value ^ 0x9e3779b9) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0aaad) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 0x735a2d97) >>> 0;
  return ((state ^ (state >>> 15)) >>> 0) / 0x1_0000_0000;
}

/**
 * Toroidal Gaussian energy of the binary pattern at every texel. Sigma 1.9
 * per Ulichney; the kernel is truncated at 3σ.
 */
function buildEnergy(
  pattern: Uint8Array,
  size: number,
): Float64Array {
  const sigma = 1.9;
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    kernel.push(Math.exp(-(offset * offset) / (2 * sigma * sigma)));
  }
  const energy = new Float64Array(size * size);
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === 0) continue;
    const px = index % size;
    const py = (index / size) | 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const wy = kernel[dy + radius]!;
      const y = (py + dy + size) % size;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = (px + dx + size) % size;
        energy[y * size + x] = energy[y * size + x]! + wy * kernel[dx + radius]!;
      }
    }
  }
  return energy;
}

function addEnergy(
  energy: Float64Array,
  size: number,
  px: number,
  py: number,
  sign: number,
): void {
  const sigma = 1.9;
  const radius = Math.ceil(sigma * 3);
  for (let dy = -radius; dy <= radius; dy += 1) {
    const wy = Math.exp(-(dy * dy) / (2 * sigma * sigma));
    const y = (py + dy + size) % size;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const wx = Math.exp(-(dx * dx) / (2 * sigma * sigma));
      const x = (px + dx + size) % size;
      energy[y * size + x] = energy[y * size + x]! + sign * wy * wx;
    }
  }
}

function extreme(
  energy: Float64Array,
  pattern: Uint8Array,
  wantSet: boolean,
  wantMax: boolean,
): number {
  let best = -1;
  let bestValue = wantMax ? -Infinity : Infinity;
  for (let index = 0; index < pattern.length; index += 1) {
    if ((pattern[index] === 1) !== wantSet) continue;
    const value = energy[index]!;
    if (wantMax ? value > bestValue : value < bestValue) {
      bestValue = value;
      best = index;
    }
  }
  return best;
}

/**
 * Generates a `size²` blue-noise threshold tile as bytes 0..255, toroidally
 * tileable. Deterministic for a given seed.
 */
export function generateBlueNoiseTile(size = BLUE_NOISE_SIZE, seed = 1): Uint8Array {
  const texelCount = size * size;
  // Phase 0: deterministic white-noise seed pattern at ~10% density.
  const initialCount = Math.max(1, Math.round(texelCount * 0.1));
  const pattern = new Uint8Array(texelCount);
  const order = Array.from({ length: texelCount }, (_, index) => index)
    .sort((a, b) => hash(a * 2_654_435_761 + seed) - hash(b * 2_654_435_761 + seed));
  for (let index = 0; index < initialCount; index += 1) pattern[order[index]!] = 1;

  // Phase 1: relax — move the tightest cluster into the largest void until
  // the same pixel bounces (converged).
  const energy = buildEnergy(pattern, size);
  for (let iteration = 0; iteration < texelCount * 4; iteration += 1) {
    const cluster = extreme(energy, pattern, true, true);
    if (cluster < 0) break;
    pattern[cluster] = 0;
    addEnergy(energy, size, cluster % size, (cluster / size) | 0, -1);
    const voidIndex = extreme(energy, pattern, false, false);
    if (voidIndex === cluster) {
      pattern[cluster] = 1;
      addEnergy(energy, size, cluster % size, (cluster / size) | 0, 1);
      break;
    }
    pattern[voidIndex] = 1;
    addEnergy(energy, size, voidIndex % size, (voidIndex / size) | 0, 1);
  }

  const rank = new Int32Array(texelCount).fill(-1);
  // Phase 2: rank the initial points by removing the tightest cluster.
  const removal = new Uint8Array(pattern);
  const removalEnergy = buildEnergy(removal, size);
  for (let value = initialCount - 1; value >= 0; value -= 1) {
    const cluster = extreme(removalEnergy, removal, true, true);
    if (cluster < 0) break;
    removal[cluster] = 0;
    addEnergy(removalEnergy, size, cluster % size, (cluster / size) | 0, -1);
    rank[cluster] = value;
  }
  // Phase 3: rank the remaining texels by filling the largest void.
  const fill = new Uint8Array(pattern);
  const fillEnergy = buildEnergy(fill, size);
  for (let value = initialCount; value < texelCount; value += 1) {
    const voidIndex = extreme(fillEnergy, fill, false, false);
    if (voidIndex < 0) break;
    fill[voidIndex] = 1;
    addEnergy(fillEnergy, size, voidIndex % size, (voidIndex / size) | 0, 1);
    rank[voidIndex] = value;
  }

  const bytes = new Uint8Array(texelCount);
  for (let index = 0; index < texelCount; index += 1) {
    bytes[index] = Math.round((rank[index]! * 255) / (texelCount - 1));
  }
  return bytes;
}
