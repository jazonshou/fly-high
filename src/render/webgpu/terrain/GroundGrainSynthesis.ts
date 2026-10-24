import { hashSeed, normalizeSeed } from "@/src/world/seed";
import type { WorldSeed } from "@/src/world/types";
import { synthesizeSurfaceMaterial } from "./MaterialArraySynthesis";
import {
  SURFACE_MATERIAL_BASE_COUNT,
  SURFACE_MATERIALS,
  type SurfaceMaterialId,
} from "./surfaceMaterials";

/**
 * The ground grain: one extra layer at the END of both terrain material arrays
 * (owner: terrain-material).
 *
 * WHY IT EXISTS. From flying height the ground had nothing near pixel scale.
 * The material tiles (2-9 m periods) are high-passed to their mean and fade to
 * it once their texels go sub-pixel; every procedural band above them (meso,
 * patchwork, sward relief, macro wash) is band-limited by a footprint fade,
 * because procedural noise has no mip chain, and each fade has to start well
 * before one period per pixel or the octave shimmers. So at 1,600 ft the
 * frame held smooth 50-150 m blotches and nothing finer: the "blurry" ground.
 *
 * A TEXTURE fixes that where another procedural octave cannot: its mip chain
 * band-limits it in hardware, exactly at the pixel, with the anisotropic
 * filter's help along the grazing axis. The fragment samples this one layer at
 * three rotated world scales (see `GROUND_GRAIN_SCALES` in the plugin), so
 * every footprint from a few centimetres to tens of metres per pixel has
 * octaves sitting right at the pixel and none above it.
 *
 * WHAT IT HOLDS. Every channel is a periodic field centred on 0.5 (the box
 * mip chain then converges each to 0.5, which the shader reads as "no
 * change", so the grain can never shift the scene's mean colour at range):
 *
 *   array A  R tone      domain-warped gradient fBm, steepened into patches
 *            G moisture  a broader fBm: lush/cool vs dry/straw hue swing
 *            B clumps    scattered soft discs, mean-removed: tufts, bushes
 *                        and stones depending on the scale it is read at
 *            A height    fBm plus the clumps, for the normal below
 *   array B  RG normal   from A's height, by the same central difference the
 *                        material layers use; Toksvig-reduced in the mips
 *            B 0.5       neutral roughness (unread; Toksvig writes into it)
 *            A 1.0       no cavity (unread)
 *
 * Cost: one layer per array, ~8% on top of the materials' memory, built
 * once in the synthesis worker. Built only where `terrainGroundPatchwork` is
 * on, so tier 0 pays neither the memory nor the fetches.
 */

/** Array layer index of the grain: directly after every material. */
export const GROUND_GRAIN_LAYER = SURFACE_MATERIALS.length;

/**
 * The layer ids the arrays hold, in layer order. A material id is its own
 * index; the grain, when present, is `GROUND_GRAIN_LAYER`.
 *
 * The volcanic layers are left off where the tier has no volcanic ground
 * (`WebGpuQualityProfile.volcanicMaterials`), and kept wherever the grain is
 * built whatever that flag says: the grain's index sits after them, and a
 * layer index is a layer index.
 */
export function surfaceArrayLayerIds(groundGrain: boolean, volcanicMaterials: boolean): number[] {
  const ids = SURFACE_MATERIALS
    .filter((spec) => volcanicMaterials || groundGrain || spec.id < SURFACE_MATERIAL_BASE_COUNT)
    .map((spec) => spec.id as number);
  if (groundGrain) ids.push(GROUND_GRAIN_LAYER);
  return ids;
}

/** One array layer by id: a material, or the grain. */
export function synthesizeSurfaceArrayLayer(
  id: number,
  seed: WorldSeed,
  edge: number,
): { albedoHeight: Uint8Array; normalMaterial: Uint8Array } {
  if (id === GROUND_GRAIN_LAYER) return synthesizeGroundGrainLayer(seed, edge);
  return synthesizeSurfaceMaterial(id as SurfaceMaterialId, seed, edge);
}

/** Target standard deviation of each stored channel around 0.5. */
export const GROUND_GRAIN_CHANNEL_STD = Object.freeze({
  tone: 0.17,
  moisture: 0.15,
  clumps: 0.12,
  height: 0.16,
});

/** RMS slope the normal is scaled to, in height units per texel-scale step. */
const GROUND_GRAIN_RMS_SLOPE = 0.45;

function hash2(x: number, y: number, seed: number): number {
  let hash = (Math.imul(x, 0x27d4_eb2d) ^ Math.imul(y, 0x1656_67b1) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1);
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61);
  return ((hash ^ (hash >>> 14)) >>> 0) / 4_294_967_296;
}

function wrap(index: number, period: number): number {
  const wrapped = index % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/**
 * One octave of periodic gradient noise added into `out`, `frequency` lattice
 * cells across the texture. Gradients are tabled once per octave, so a texel
 * costs four dot products and a quintic blend rather than four hashes: the
 * whole layer builds in tens of milliseconds at 512², not a second.
 */
function addGradientOctave(
  out: Float32Array,
  edge: number,
  frequency: number,
  amplitude: number,
  seed: number,
): void {
  const cells = frequency * frequency;
  const gradientX = new Float32Array(cells);
  const gradientY = new Float32Array(cells);
  for (let index = 0; index < cells; index += 1) {
    const angle = hash2(index % frequency, Math.floor(index / frequency), seed) * Math.PI * 2;
    gradientX[index] = Math.cos(angle);
    gradientY[index] = Math.sin(angle);
  }
  const step = frequency / edge;
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) * step;
    const cellY = Math.floor(v);
    const fy = v - cellY;
    const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const rowA = wrap(cellY, frequency) * frequency;
    const rowB = wrap(cellY + 1, frequency) * frequency;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) * step;
      const cellX = Math.floor(u);
      const fx = u - cellX;
      const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const colA = wrap(cellX, frequency);
      const colB = wrap(cellX + 1, frequency);
      const n00 = gradientX[rowA + colA]! * fx + gradientY[rowA + colA]! * fy;
      const n10 = gradientX[rowA + colB]! * (fx - 1) + gradientY[rowA + colB]! * fy;
      const n01 = gradientX[rowB + colA]! * fx + gradientY[rowB + colA]! * (fy - 1);
      const n11 = gradientX[rowB + colB]! * (fx - 1) + gradientY[rowB + colB]! * (fy - 1);
      const top = n00 + (n10 - n00) * sx;
      const bottom = n01 + (n11 - n01) * sx;
      const texel = y * edge + x;
      out[texel] = out[texel]! + amplitude * (top + (bottom - top) * sy);
    }
  }
}

/** Periodic gradient fBm. Octave frequencies double, so every one tiles. */
function gradientFbm(
  edge: number,
  baseFrequency: number,
  octaves: number,
  gain: number,
  seed: number,
): Float32Array {
  const out = new Float32Array(edge * edge);
  let amplitude = 1;
  let frequency = baseFrequency;
  for (let octave = 0; octave < octaves && frequency <= edge / 2; octave += 1) {
    addGradientOctave(out, edge, frequency, amplitude, (seed + octave * 0x9e37_79b9) >>> 0);
    amplitude *= gain;
    frequency *= 2;
  }
  return out;
}

/** Bilinear read of a periodic field at fractional texel coordinates. */
function sampleWrapped(field: Float32Array, edge: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = wrap(x0, edge);
  const xb = wrap(x0 + 1, edge);
  const ya = wrap(y0, edge) * edge;
  const yb = wrap(y0 + 1, edge) * edge;
  const top = field[ya + xa]! + (field[ya + xb]! - field[ya + xa]!) * fx;
  const bottom = field[yb + xa]! + (field[yb + xb]! - field[yb + xa]!) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Domain warp by two periodic displacement fields. Organic patch outlines
 * rather than the round blobs of raw fBm, and still exactly periodic: the
 * displacement is itself periodic and the read wraps.
 */
function warpField(
  field: Float32Array,
  edge: number,
  warpTexels: number,
  seed: number,
): Float32Array {
  const displaceX = gradientFbm(edge, 2, 3, 0.5, seed ^ 0x51ed_270b);
  const displaceY = gradientFbm(edge, 2, 3, 0.5, seed ^ 0x2545_f491);
  const out = new Float32Array(edge * edge);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      out[texel] = sampleWrapped(
        field, edge,
        x + displaceX[texel]! * warpTexels,
        y + displaceY[texel]! * warpTexels,
      );
    }
  }
  return out;
}

function meanAndStd(field: Float32Array): readonly [number, number] {
  let sum = 0;
  for (const value of field) sum += value;
  const mean = sum / field.length;
  let squares = 0;
  for (const value of field) squares += (value - mean) * (value - mean);
  return [mean, Math.sqrt(squares / field.length)];
}

/** Rescale in place to zero mean and unit standard deviation. */
function standardize(field: Float32Array): void {
  const [mean, std] = meanAndStd(field);
  const inverse = std > 1e-9 ? 1 / std : 0;
  for (let index = 0; index < field.length; index += 1) {
    field[index] = (field[index]! - mean) * inverse;
  }
}

/**
 * Scattered soft discs: one candidate per lattice cell, kept with probability
 * `keep`, jittered inside its cell and stamped with a smooth falloff. Every
 * stamp wraps, so the field tiles.
 */
function addClumps(
  out: Float32Array,
  edge: number,
  frequency: number,
  keep: number,
  radiusTexels: readonly [number, number],
  density: Float32Array,
  seed: number,
): void {
  const cell = edge / frequency;
  for (let cy = 0; cy < frequency; cy += 1) {
    for (let cx = 0; cx < frequency; cx += 1) {
      const centreX = (cx + hash2(cx, cy, seed ^ 0x68e3_1da4)) * cell;
      const centreY = (cy + hash2(cx, cy, seed ^ 0xb529_7a4d)) * cell;
      // Clustered, not uniform: real cover bunches where conditions suit it,
      // so the keep probability follows a smooth density field.
      const local = density[wrap(Math.floor(centreY), edge) * edge + wrap(Math.floor(centreX), edge)]!;
      if (hash2(cx, cy, seed) > keep * local) continue;
      const radius = radiusTexels[0]
        + (radiusTexels[1] - radiusTexels[0]) * hash2(cx, cy, seed ^ 0x1b56_c4e9);
      const weight = 0.6 + 0.4 * hash2(cx, cy, seed ^ 0x7f4a_7c15);
      const reach = Math.ceil(radius);
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) {
          const px = Math.floor(centreX) + dx;
          const py = Math.floor(centreY) + dy;
          const distance = Math.hypot(px + 0.5 - centreX, py + 0.5 - centreY) / radius;
          if (distance >= 1) continue;
          const falloff = 1 - distance * distance;
          const texel = wrap(py, edge) * edge + wrap(px, edge);
          out[texel] = Math.max(out[texel]!, weight * falloff * falloff);
        }
      }
    }
  }
}

/**
 * Quantise a standardized field to bytes around 128, then re-centre so the
 * stored mean is 0.5 to within a byte: the mip chain's 1x1 tail is that mean,
 * and the shader reads 0.5 as "no change".
 */
function storeCentred(field: Float32Array, std: number, out: Uint8Array, channel: number): void {
  const bytes = new Float32Array(field.length);
  let sum = 0;
  for (let index = 0; index < field.length; index += 1) {
    const value = Math.min(1, Math.max(0, 0.5 + field[index]! * std)) * 255;
    bytes[index] = value;
    sum += value;
  }
  const correction = 127.5 - sum / field.length;
  for (let index = 0; index < field.length; index += 1) {
    out[index * 4 + channel] = Math.min(255, Math.max(0, Math.round(bytes[index]! + correction)));
  }
}

/** The grain layer for both arrays: a pure function of (seed, edge). */
export function synthesizeGroundGrainLayer(
  seed: WorldSeed,
  edge: number,
): { albedoHeight: Uint8Array; normalMaterial: Uint8Array } {
  if (!Number.isInteger(edge) || edge < 8 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Material array edge must be a power of two >= 8, got ${edge}`);
  }
  const base = hashSeed(`surface-material/${normalizeSeed(seed)}/ground-grain`);
  const texels = edge * edge;

  // Tone: warped fBm, its spectrum flatter than 1/f (gain 0.62) so the fine
  // octaves carry real energy at whatever scale the layer is read, steepened
  // a little by tanh so it reads as patches with edges rather than as fog.
  const tone = warpField(gradientFbm(edge, 4, 8, 0.62, base), edge, edge * 0.06, base ^ 0x3c6e_f372);
  standardize(tone);
  for (let index = 0; index < texels; index += 1) tone[index] = Math.tanh(1.0 * tone[index]!);
  standardize(tone);

  // Moisture: broader, so a hue swing reads as drainage and exposure rather
  // than as speckle.
  const moisture = warpField(gradientFbm(edge, 2, 6, 0.5, base ^ 0xa54f_f53a), edge, edge * 0.08, base ^ 0x510e_527f);
  standardize(moisture);

  // Clumps at two densities. Which they READ as depends on the scale the
  // shader samples this layer at: tufts on the finest, bushes and stones on
  // the middle, copses and outcrops on the broadest.
  // Their density follows its own smooth field, and leans towards the darker,
  // lusher tone patches.
  const density = gradientFbm(edge, 4, 3, 0.5, base ^ 0x6a09_e667);
  standardize(density);
  for (let index = 0; index < texels; index += 1) {
    const lean = density[index]! - 0.5 * tone[index]!;
    density[index] = Math.min(1, Math.max(0, 0.5 + 0.45 * lean));
  }
  const clumps = new Float32Array(texels);
  // Sparse on purpose: at the middle scale a small clump is a 1-2 m shrub,
  // and the first frames showed half the cells filled reading as pepper.
  addClumps(clumps, edge, Math.max(2, edge / 8), 0.4, [1.4, 3.2], density, base ^ 0x9b05_688c);
  addClumps(clumps, edge, Math.max(2, edge / 24), 0.7, [2.8, 6.5], density, base ^ 0x1f83_d9ab);
  const clumpField = Float32Array.from(clumps);
  standardize(clumpField);

  // Height: its own fBm, raised under the clumps and a little under the
  // patches, so the normal agrees with what the albedo draws.
  const height = gradientFbm(edge, 8, 7, 0.5, base ^ 0x5be0_cd19);
  standardize(height);
  for (let index = 0; index < texels; index += 1) {
    height[index] = height[index]! + 0.9 * clumpField[index]! + 0.35 * tone[index]!;
  }
  standardize(height);

  const albedoHeight = new Uint8Array(texels * 4);
  storeCentred(tone, GROUND_GRAIN_CHANNEL_STD.tone, albedoHeight, 0);
  storeCentred(moisture, GROUND_GRAIN_CHANNEL_STD.moisture, albedoHeight, 1);
  storeCentred(clumpField, GROUND_GRAIN_CHANNEL_STD.clumps, albedoHeight, 2);
  storeCentred(height, GROUND_GRAIN_CHANNEL_STD.height, albedoHeight, 3);

  // Normal from the height, by the material layers' one-texel central
  // difference, scaled to a fixed RMS slope so the shader's gains are in
  // known units.
  const gradientX = new Float32Array(texels);
  const gradientY = new Float32Array(texels);
  let sumSquares = 0;
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      const dx = (height[y * edge + wrap(x + 1, edge)]! - height[y * edge + wrap(x - 1, edge)]!) * 0.5;
      const dy = (height[wrap(y + 1, edge) * edge + x]! - height[wrap(y - 1, edge) * edge + x]!) * 0.5;
      gradientX[texel] = dx;
      gradientY[texel] = dy;
      sumSquares += dx * dx + dy * dy;
    }
  }
  const rms = Math.sqrt(sumSquares / texels);
  const slopeScale = rms > 1e-9 ? GROUND_GRAIN_RMS_SLOPE / rms : 0;
  const normalMaterial = new Uint8Array(texels * 4);
  for (let texel = 0; texel < texels; texel += 1) {
    const slopeX = Math.max(-3, Math.min(3, gradientX[texel]! * slopeScale));
    const slopeY = Math.max(-3, Math.min(3, gradientY[texel]! * slopeScale));
    const inverse = 1 / Math.hypot(slopeX, slopeY, 1);
    const out = texel * 4;
    normalMaterial[out] = Math.round((0.5 - slopeX * inverse * 0.5) * 255);
    normalMaterial[out + 1] = Math.round((0.5 - slopeY * inverse * 0.5) * 255);
    normalMaterial[out + 2] = 128;
    normalMaterial[out + 3] = 255;
  }
  return { albedoHeight, normalMaterial };
}
