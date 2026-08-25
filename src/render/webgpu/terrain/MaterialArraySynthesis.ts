import type { MippedTextureArrayPlan } from "@/src/render/webgpu/core/TextureArrayMips";
import { hashSeed, normalizeSeed } from "@/src/world/seed";
import type { WorldSeed } from "@/src/world/types";
import {
  SURFACE_MATERIALS,
  SurfaceMaterial,
  type SurfaceMaterialId,
  type SurfaceMaterialSpec,
} from "./surfaceMaterials";

/**
 * 3-1 — the ten synthesised land-cover materials (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: every texel of both terrain material
 * `Texture2DArray`s is a pure function of (seed, edge), and every noise
 * primitive it uses is PERIODIC on the texture's own cell grid. A material
 * that does not tile is worse than no material — the seam is a hard line
 * repeating every few metres across the whole world — so the wrap is built
 * into the primitives here rather than remembered at each call site.
 *
 * **Class P, with NO Babylon value import at all** (`4.5-C2b`). The GPU
 * boundary — planning the mip chain, uploading, configuring the samplers —
 * moved to `MaterialArrayUpload.ts` so this module can be imported by a
 * WORKER. It is the same shape `FoliageAtlas` (`2-11`) and `ImpostorAtlas`
 * (`2-17`) already ship, and the reason for it is that assertions 53, 54 and
 * 55 are then ordinary Node tests over the plan rather than GPU readbacks.
 *
 * DEVIATION from PHASE_3_EXECUTION_PLAN.md §7 `3-1`, which specifies "GPU
 * compute for mip 0, following the SpectralOceanSystem pattern; CPU reduction
 * for the mip chain (C2)". Synthesis is on the CPU here, for the same reason
 * C2 gave for the reduction and one more:
 *
 *   - Cost. Synthesis is a one-time startup cost on seed change that appears
 *     on no frame budget. C2's own words: "spending days on a GPU
 *     optimisation for that is the definition of the quick fix that costs
 *     more than it saves."
 *   - The split does not survive contact with C2. `updateMipLevel` uploads
 *     CPU bytes, so a GPU mip 0 must be read BACK to the CPU before the
 *     Toksvig reduction can run — a full 2×10×edge² readback that costs more
 *     than the synthesis it was meant to accelerate.
 *   - Falsifiability. The recipes are the phase's largest unfalsifiable
 *     surface (§11 R-3A). On the CPU, assertions 53/54/55 and the contact
 *     sheet are plain Node tests; in WGSL every one of them needs an adapter.
 *
 * The `2-11` module this reuses says so from its own side: its header already
 * names "3-1's Toksvig terrain-material reducer" as a consumer.
 */

const RGBA_CHANNELS = 4;

/**
 * Toksvig roughness gain `k` in `rough' = sqrt(rough² + k·(1 − |avgN|))`.
 *
 * 0.5 is the shipped value. The term is a heuristic in perceptual-roughness
 * squared rather than in α², so `k` sets how hard a flattened normal map is
 * traded for gloss loss: at `k = 1` a mip whose normals have averaged to
 * |avgN| = 0.9 takes rough 0.5 → 0.59, which visibly over-mattes mid-range
 * rock; at 0.5 the same tap gives 0.55, which removes the false highlight
 * without flattening the material. Recorded in the decision log.
 */
export const TOKSVIG_ROUGHNESS_GAIN = 0.5;

/** Both arrays, one mipped plan each. */
export interface SurfaceMaterialArrayPlans {
  readonly edge: number;
  /** RGB linear albedo, A surface height. */
  readonly albedoHeight: MippedTextureArrayPlan;
  /** RG tangent-space normal xy, B roughness, A cavity AO. */
  readonly normalMaterial: MippedTextureArrayPlan;
  readonly totalBytes: number;
}

// ---------------------------------------------------------------------------
// Periodic primitives. Every one of these wraps its lattice indices modulo the
// cell count, so the field is exactly periodic on [0, 1)² — which is the
// texture. `frequency` is always an integer number of cells across the whole
// texture, and octaves double it, so the wrap stays exact at every octave.
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let hash = (Math.imul(x, 0x27d4_eb2d) ^ Math.imul(y, 0x1656_67b1) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1);
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61);
  return ((hash ^ (hash >>> 14)) >>> 0) / 4_294_967_296;
}

function wrapCell(index: number, period: number): number {
  const wrapped = index % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/** Smooth value noise in [0, 1), exactly periodic with `frequency` cells. */
function periodicValue(u: number, v: number, frequency: number, seed: number): number {
  const x = u * frequency;
  const y = v * frequency;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const xa = wrapCell(x0, frequency);
  const xb = wrapCell(x0 + 1, frequency);
  const ya = wrapCell(y0, frequency);
  const yb = wrapCell(y0 + 1, frequency);
  const topLeft = hash2(xa, ya, seed);
  const topRight = hash2(xb, ya, seed);
  const bottomLeft = hash2(xa, yb, seed);
  const bottomRight = hash2(xb, yb, seed);
  const top = topLeft + (topRight - topLeft) * sx;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * sx;
  return top + (bottom - top) * sy;
}

/** Fractal sum of periodic value noise, normalised to [0, 1). */
function periodicFbm(
  u: number,
  v: number,
  baseFrequency: number,
  octaves: number,
  gain: number,
  seed: number,
): number {
  let amplitude = 1;
  let total = 0;
  let sum = 0;
  let frequency = baseFrequency;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += periodicValue(u, v, frequency, seed + octave * 7919) * amplitude;
    sum += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return sum > 0 ? total / sum : 0;
}

/** Ridged variant: `1 − |2n − 1|`, which puts creases where the noise crosses ½. */
function periodicRidged(
  u: number,
  v: number,
  baseFrequency: number,
  octaves: number,
  gain: number,
  seed: number,
): number {
  let amplitude = 1;
  let total = 0;
  let sum = 0;
  let frequency = baseFrequency;
  for (let octave = 0; octave < octaves; octave += 1) {
    const value = periodicValue(u, v, frequency, seed + octave * 6151);
    total += (1 - Math.abs(2 * value - 1)) * amplitude;
    sum += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return sum > 0 ? total / sum : 0;
}

export interface WorleySample {
  /** Distance to the nearest feature point, in cell units. */
  readonly f1: number;
  /** Distance to the second nearest — `f2 − f1` is the cell-boundary crease. */
  readonly f2: number;
  /** Deterministic hash of the owning cell, for per-pebble/per-block draws. */
  readonly cellHash: number;
}

/**
 * Periodic Worley/cellular noise. Pebbles, block fabric and moss cushions all
 * ride this; the cell hash is what gives each feature its own colour, gloss
 * and phase without a per-feature table.
 */
function periodicWorley(u: number, v: number, frequency: number, seed: number): WorleySample {
  const x = u * frequency;
  const y = v * frequency;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let cellHash = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const wx = wrapCell(cx + dx, frequency);
      const wy = wrapCell(cy + dy, frequency);
      const jitterX = hash2(wx, wy, seed);
      const jitterY = hash2(wx, wy, seed ^ 0x9e37_79b9);
      const pointX = cx + dx + jitterX;
      const pointY = cy + dy + jitterY;
      const distance = Math.hypot(pointX - x, pointY - y);
      if (distance < f1) {
        f2 = f1;
        f1 = distance;
        cellHash = hash2(wx, wy, seed ^ 0x85eb_ca6b);
      } else if (distance < f2) {
        f2 = distance;
      }
    }
  }
  return { f1, f2, cellHash };
}

/**
 * A directional band field, exactly periodic because the direction is an
 * INTEGER lattice vector: `fract(a·u + b·v + phase)` repeats on [0,1)² for any
 * integers a, b. This is what lets rock carry real bedding and jointing at a
 * chosen dip without the pattern tearing at the tile seam.
 */
function periodicBands(u: number, v: number, a: number, b: number, phase: number): number {
  const t = a * u + b * v + phase;
  return t - Math.floor(t);
}

/**
 * A band family whose lines CURVE, by warping the phase with a mid-frequency
 * periodic field.
 *
 * The straight form above is a perfect lattice, and a perfect sub-metre
 * lattice is the worst possible thing to put in a mipped texture that will be
 * viewed at a grazing angle: it moirés into a large regular quilt across the
 * whole ground plane. That is not a hypothetical — the first capture of
 * `approach-500ft` after `3-2` landed showed exactly that quilt over every
 * flat surface in the frame. Real jointing, real bedding and real wind ripples
 * all wander; making them wander is what removes the artefact AND what makes
 * them read as geology.
 */
function periodicCurvedBands(
  u: number,
  v: number,
  a: number,
  b: number,
  phase: number,
  wanderFrequency: number,
  wanderAmount: number,
  seed: number,
): number {
  const wander = periodicFbm(u, v, wanderFrequency, 3, 0.55, seed) - 0.5;
  return periodicBands(u, v, a, b, phase + wander * wanderAmount);
}

// ---------------------------------------------------------------------------
// The canvas every recipe writes, and the wrapped stamping helpers discrete
// features use.
// ---------------------------------------------------------------------------

interface MaterialCanvas {
  readonly edge: number;
  /** Linear RGB, three floats per texel. */
  readonly albedo: Float32Array;
  /** Surface height in [0, 1]; finalisation re-centres it on 0.5. */
  readonly height: Float32Array;
  /** Perceptual roughness in [0, 1]; finalisation maps it into the spec range. */
  readonly roughness: Float32Array;
  /** Cavity openness in [0, 1]; 1 is fully open sky, lower is a crevice. */
  readonly cavity: Float32Array;
}

function createCanvas(edge: number): MaterialCanvas {
  const texels = edge * edge;
  return {
    edge,
    albedo: new Float32Array(texels * 3),
    height: new Float32Array(texels),
    roughness: new Float32Array(texels),
    cavity: new Float32Array(texels).fill(1),
  };
}

type Rgb = readonly [number, number, number];

function writeAlbedo(canvas: MaterialCanvas, texel: number, colour: Rgb, weight: number): void {
  const at = texel * 3;
  canvas.albedo[at] = (canvas.albedo[at] ?? 0) * (1 - weight) + colour[0] * weight;
  canvas.albedo[at + 1] = (canvas.albedo[at + 1] ?? 0) * (1 - weight) + colour[1] * weight;
  canvas.albedo[at + 2] = (canvas.albedo[at + 2] ?? 0) * (1 - weight) + colour[2] * weight;
}

/**
 * Visit every texel inside a rotated ellipse, wrapping at the texture border
 * so a feature straddling the seam appears on both sides. `falloff` is 1 at
 * the centre and 0 at the rim.
 */
function stampEllipse(
  canvas: MaterialCanvas,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  angle: number,
  visit: (texel: number, falloff: number, localX: number, localY: number) => void,
): void {
  const edge = canvas.edge;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.ceil(Math.max(radiusX, radiusY)) + 1;
  const inverseX = 1 / Math.max(1e-4, radiusX);
  const inverseY = 1 / Math.max(1e-4, radiusY);
  for (let dy = -reach; dy <= reach; dy += 1) {
    const y = Math.round(centerY) + dy;
    const offsetY = y - centerY;
    const row = wrapCell(y, edge) * edge;
    for (let dx = -reach; dx <= reach; dx += 1) {
      const x = Math.round(centerX) + dx;
      const offsetX = x - centerX;
      const localX = (offsetX * cos + offsetY * sin) * inverseX;
      const localY = (-offsetX * sin + offsetY * cos) * inverseY;
      const radial = localX * localX + localY * localY;
      if (radial >= 1) continue;
      const falloff = 1 - radial;
      visit(row + wrapCell(x, edge), falloff * falloff, localX, localY);
    }
  }
}

/** A tapered stroke, drawn as a chain of stamped ellipses. Wraps like `stampEllipse`. */
function stampStroke(
  canvas: MaterialCanvas,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  width: number,
  visit: (texel: number, falloff: number, along: number) => void,
): void {
  const length = Math.hypot(endX - startX, endY - startY);
  const steps = Math.max(2, Math.ceil(length));
  const angle = Math.atan2(endY - startY, endX - startX);
  for (let step = 0; step <= steps; step += 1) {
    const along = step / steps;
    // Taper both ends: a stroke of constant width reads as a rectangle.
    const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, along * 0.85 + 0.15)));
    const radius = Math.max(0.5, width * 0.5 * taper);
    stampEllipse(
      canvas,
      startX + (endX - startX) * along,
      startY + (endY - startY) * along,
      radius,
      radius,
      angle,
      (texel, falloff) => visit(texel, falloff, along),
    );
  }
}

/** Deterministic per-material stream, so a recipe edit cannot disturb its neighbours. */
function createStream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

/**
 * Cell counts above this many per texture edge put a feature under one texel,
 * where it is not a feature but noise — and periodic noise at the Nyquist
 * limit is exactly what mips cannot resolve. Asphalt asked for 664 cells over
 * a 512 edge and concrete 445, so both aggregate fields were sub-texel at
 * every shipping array size.
 */
const MINIMUM_TEXELS_PER_CELL = 2.5;

function cellsForFeature(edge: number, tilingPeriodMeters: number, featureMeters: number): number {
  const desired = Math.round(tilingPeriodMeters / Math.max(1e-4, featureMeters));
  return Math.max(4, Math.min(desired, Math.floor(edge / MINIMUM_TEXELS_PER_CELL)));
}

function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = saturate((value - low) / Math.max(1e-6, high - low));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Recipes. Appearance constants live here and nowhere else; the physical
// constants (roughness range, F0, tiling period) come from the 3-0 contract
// and a recipe may not contradict them — finalisation maps roughness into the
// spec's band and albedo onto the spec's reference, by construction.
//
// Feature sizes below are written in METRES and converted through
// `texelsPerMeter`, so a recipe reads the same at 256², 512² and 1024² and
// the Ultra tier genuinely resolves finer structure instead of the same
// structure larger.
// ---------------------------------------------------------------------------

interface RecipeContext {
  readonly canvas: MaterialCanvas;
  readonly spec: SurfaceMaterialSpec;
  readonly seed: number;
  readonly random: () => number;
  readonly texelsPerMeter: number;
}

type Recipe = (context: RecipeContext) => void;

/**
 * Reference photographs the recipes were tuned against (§10 "what cannot be
 * asserted"). Committed as citations rather than files: the repo holds zero
 * image assets by design (`TERRAIN_AUDIT.md` §2.1) and Phase 3 keeps it that
 * way. A later tuning session should re-open these before moving a constant.
 */
export const MATERIAL_REFERENCE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  Grass: "Temperate meadow at 1 m, midsummer — blade clusters 4–12 cm, soil visible in the "
    + "gaps, no specular sheen. Target: the eye can count tufts at 2 m and reads a mat at 20 m.",
  DryGrass: "Late-summer pasture — standing dead stems over ochre thatch, ~25% bare soil.",
  ForestFloor: "Mixed conifer/broadleaf duff — needle and leaf litter 2–6 cm, twig fragments "
    + "along the fall line, moss cushions in the hollows reading distinctly MATTE against the "
    + "litter's slight sheen, roots breaking through at ~5%.",
  Shrub: "Heath understory — small leathery leaves over twig litter and mineral soil.",
  Sand: "Wind-rippled dune, ripple wavelength 7–10 cm, crest lines meandering over metres.",
  Gravel: "Rounded river gravel 2–6 cm in a fine grit matrix; each stone its own colour and gloss.",
  Rock: "Bedded sandstone/granite face — two joint families at ±23°, bedding planes at ~0.4 m, "
    + "and ADJACENT BLOCKS WITH VISIBLY DIFFERENT GLOSS, which is most of the difference "
    + "between rock and plastic.",
  Snow: "Wind-packed snowfield — broad drifts, sastrugi ridges, sparkle from ice grains.",
  Asphalt: "Worn airfield asphalt — exposed aggregate in the wheel paths, thermal cracking, "
    + "bitumen sheen surviving only between the tracks.",
  Concrete: "Float-finished apron concrete — fine aggregate, float sweeps, hairline shrinkage "
    + "cracks, air voids.",
});

/**
 * Target RMS surface slope of each material's normal map — `tan` of the
 * typical micro-facet tilt.
 *
 * Deliberately a slope target rather than a relief-in-metres, and the
 * difference matters. A physical `relief / metresPerTexel` derivation makes
 * the normal map's strength a function of how much texel-scale energy the
 * recipe's noise happened to have, which is (a) not a controlled quantity and
 * (b) different at 256² and 512². Both showed up immediately: measured
 * against the first draft, `1 − |avgN|` came out around 0.003, so the Toksvig
 * term was worth ~1% of a roughness byte and the anti-plastic measure the
 * plan calls "the single most important" one was doing nothing. Normalising
 * the gradient to a declared RMS slope makes the strength a recipe decision,
 * makes it resolution-independent, and gives the reducer something to reduce.
 */
const NORMAL_RMS_SLOPE: Readonly<Record<SurfaceMaterialId, number>> = Object.freeze({
  // Blades stand up: the sward's normal field is the steepest in the table
  // after gravel.
  [SurfaceMaterial.Grass]: 0.55,
  [SurfaceMaterial.DryGrass]: 0.5,
  [SurfaceMaterial.ForestFloor]: 0.45,
  [SurfaceMaterial.Shrub]: 0.45,
  // Wind-graded sand is nearly a plane at texel scale; its structure is the
  // ripple, which lives in the height channel.
  [SurfaceMaterial.Sand]: 0.22,
  // Rounded stones: every texel is on the flank of something.
  [SurfaceMaterial.Gravel]: 0.6,
  [SurfaceMaterial.Rock]: 0.5,
  [SurfaceMaterial.Snow]: 0.18,
  [SurfaceMaterial.Asphalt]: 0.3,
  [SurfaceMaterial.Concrete]: 0.16,
});

function fillBase(
  context: RecipeContext,
  colour: (u: number, v: number, texel: number) => Rgb,
  height: (u: number, v: number, texel: number) => number,
  roughness: (u: number, v: number, texel: number) => number,
): void {
  const { canvas } = context;
  const edge = canvas.edge;
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const rgb = colour(u, v, texel);
      const at = texel * 3;
      canvas.albedo[at] = rgb[0];
      canvas.albedo[at + 1] = rgb[1];
      canvas.albedo[at + 2] = rgb[2];
      canvas.height[texel] = height(u, v, texel);
      canvas.roughness[texel] = roughness(u, v, texel);
    }
  }
}

// --- Grass -----------------------------------------------------------------

const GRASS_SOIL: Rgb = [0.062, 0.052, 0.038];
const GRASS_BLADE_DARK: Rgb = [0.052, 0.098, 0.03];
const GRASS_BLADE_MID: Rgb = [0.088, 0.152, 0.044];
const GRASS_BLADE_LIGHT: Rgb = [0.145, 0.215, 0.07];
const GRASS_STRAW_DARK: Rgb = [0.135, 0.115, 0.05];
const GRASS_STRAW_LIGHT: Rgb = [0.255, 0.225, 0.098];

function synthesizeSward(context: RecipeContext, strawShare: number, bareShare: number): void {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;
  // The base is the sward's own colour, not soil. An earlier draft used a
  // metre-scale clump field to open big windows of bare ground, and the
  // contact sheet showed exactly what that is: camouflage blotches. A real
  // sward's colour variation is mostly at BLADE scale, with only a gentle
  // patchiness above it — so the clump field lost most of its contrast and
  // the blade layer gained the density it should have had.
  fillBase(
    context,
    (u, v) => {
      const clump = periodicFbm(u, v, 3, 4, 0.5, seed + 11);
      const bare = saturate(smoothstep(0.44, 0.2, clump) * (0.18 + bareShare * 0.5));
      const sward = mixRgb(
        mixRgb(GRASS_BLADE_DARK, GRASS_BLADE_MID, clump),
        mixRgb(GRASS_STRAW_DARK, GRASS_STRAW_LIGHT, clump),
        strawShare * 0.85,
      );
      return mixRgb(sward, GRASS_SOIL, bare);
    },
    (u, v) => 0.35 + periodicFbm(u, v, 3, 4, 0.5, seed + 11) * 0.3,
    (u, v) => 0.72 + periodicValue(u, v, 24, seed + 12) * 0.2,
  );

  // Blades: 4–12 cm, 2–4 mm wide, leaning along a slowly varying lie field so
  // the sward has a grain instead of reading as isotropic fuzz. Density is
  // what makes this read as grass at 2 m and as a mat at 20 m, so it is high.
  const bladeCount = Math.round((edge * edge) / 22);
  for (let blade = 0; blade < bladeCount; blade += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const u = x / edge;
    const v = y / edge;
    const clump = periodicFbm(u, v, 3, 4, 0.5, seed + 11);
    if (random() > 0.55 + clump * 0.6) continue;
    const lie = periodicValue(u, v, 3, seed + 13) * Math.PI * 2;
    const angle = lie + (random() - 0.5) * 1.5;
    const lengthMeters = mix(0.04, 0.12, random() * random());
    const length = lengthMeters * texelsPerMeter;
    const width = Math.max(0.8, mix(0.002, 0.004, random()) * texelsPerMeter);
    const isStraw = random() < strawShare;
    const shade = random();
    const colour = isStraw
      ? mixRgb(GRASS_STRAW_DARK, GRASS_STRAW_LIGHT, shade)
      : mixRgb(
        mixRgb(GRASS_BLADE_DARK, GRASS_BLADE_MID, shade),
        GRASS_BLADE_LIGHT,
        shade * shade,
      );
    const rise = mix(0.1, 0.3, random());
    const gloss = isStraw ? 0.06 : -0.05 + shade * 0.06;
    stampStroke(
      canvas,
      x,
      y,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
      width,
      (texel, falloff, along) => {
        const weight = saturate(falloff * (0.65 + along * 0.5));
        writeAlbedo(canvas, texel, colour, weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) + rise * weight * along;
        canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.92 + gloss, weight);
        // A blade lying over the sward shades what is under it.
        canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.28 * weight);
      },
    );
  }
}

const synthesizeGrass: Recipe = (context) => synthesizeSward(context, 0.12, 0.2);
const synthesizeDryGrass: Recipe = (context) => synthesizeSward(context, 0.8, 0.34);

// --- Forest floor ----------------------------------------------------------

/**
 * Five hues, deliberately spread across brown / ochre / grey rather than
 * clustered: each flake draws one, so the spread IS the layer's texture. The
 * first pass clustered them inside a 2:1 luminance band and the contact sheet
 * showed a uniform brown sheet with the flakes invisible.
 */
const LITTER_HUES: readonly Rgb[] = Object.freeze([
  [0.105, 0.062, 0.028], // wet brown leaf
  [0.215, 0.135, 0.05], // ochre needle
  [0.055, 0.04, 0.028], // dark duff
  [0.185, 0.168, 0.13], // grey weathered flake
  [0.29, 0.2, 0.082], // fresh fall
]);
const MOSS_DARK: Rgb = [0.035, 0.072, 0.03];
const MOSS_LIGHT: Rgb = [0.075, 0.125, 0.05];
const ROOT_COLOUR: Rgb = [0.072, 0.052, 0.036];

/**
 * The most-seen material in the world after grass — it sits under every tree —
 * and the cheapest place in the programme to answer "moss, twigs, mess",
 * because it costs one of ten already-budgeted layers and nothing at runtime.
 * Four superposed strata, in the order they physically settle.
 */
const synthesizeForestFloor: Recipe = (context) => {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;

  fillBase(
    context,
    (u, v) => mixRgb(
      LITTER_HUES[2]!,
      LITTER_HUES[0]!,
      periodicFbm(u, v, 4, 4, 0.55, seed + 21),
    ),
    (u, v) => 0.3 + periodicFbm(u, v, 4, 4, 0.55, seed + 21) * 0.34,
    () => 0.62,
  );

  // (a) Litter: 2–6 cm elongated needle and leaf flakes at high coverage, each
  // with ITS OWN hue draw rather than one tinted noise field. That per-flake
  // draw is what makes the layer read as debris instead of mottling.
  const flakeCount = Math.round((edge * edge) / 26);
  for (let flake = 0; flake < flakeCount; flake += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const lengthMeters = mix(0.02, 0.06, random() * random());
    const radiusX = Math.max(0.9, lengthMeters * 0.5 * texelsPerMeter);
    const radiusY = Math.max(0.6, radiusX * mix(0.16, 0.5, random()));
    const angle = random() * Math.PI;
    const hue = LITTER_HUES[Math.min(LITTER_HUES.length - 1, Math.floor(random() * LITTER_HUES.length))]!;
    const shade = mix(0.6, 1.5, random());
    const colour: Rgb = [hue[0] * shade, hue[1] * shade, hue[2] * shade];
    const rise = mix(0.04, 0.14, random());
    const gloss = mix(-0.06, 0.06, random());
    stampEllipse(canvas, x, y, radiusX, radiusY, angle, (texel, falloff) => {
      // Near-opaque: a flake is an object lying on the duff, not a tint of it.
      const weight = saturate(falloff * 2.6);
      writeAlbedo(canvas, texel, colour, weight);
      canvas.height[texel] = (canvas.height[texel] ?? 0) + rise * weight;
      canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.6 + gloss, weight);
    });
  }

  // (b) Twig fragments at ~8% coverage, laid ALONG a weak flow field so the
  // debris is anisotropic rather than isotropic salt.
  const twigCount = Math.round((edge * edge) / 950);
  for (let twig = 0; twig < twigCount; twig += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const flow = periodicValue(x / edge, y / edge, 3, seed + 22) * Math.PI * 2;
    const angle = flow + (random() - 0.5) * 0.9;
    const length = mix(0.05, 0.22, random()) * texelsPerMeter;
    const width = Math.max(1.1, mix(0.004, 0.011, random()) * texelsPerMeter);
    const shade = mix(0.5, 0.95, random());
    const colour: Rgb = [0.052 * shade, 0.036 * shade, 0.024 * shade];
    stampStroke(canvas, x, y, x + Math.cos(angle) * length, y + Math.sin(angle) * length, width,
      (texel, falloff) => {
        const weight = saturate(falloff * 1.8);
        writeAlbedo(canvas, texel, colour, weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.22 * weight;
        canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.68, weight);
        canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.3 * weight);
      });
  }

  // (c) Moss: irregular cushions at 10–25% coverage carrying THEIR OWN
  // roughness (0.85–0.95, distinctly matte against litter's ~0.6) and a small
  // positive height offset, biased into the CONCAVE regions of the height
  // channel so it settles in hollows the way real moss does.
  const smoothed = boxBlur(canvas.height, edge, Math.max(1, Math.round(0.02 * texelsPerMeter)));
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const cushion = periodicWorley(u, v, 9, seed + 23);
      const patch = periodicFbm(u, v, 6, 4, 0.5, seed + 24);
      // Concavity: below the local mean is a hollow.
      const concavity = saturate(((smoothed[texel] ?? 0) - (canvas.height[texel] ?? 0)) * 5 + 0.35);
      const cover = saturate(
        smoothstep(0.62, 0.16, cushion.f1) * smoothstep(0.34, 0.66, patch) * (0.35 + concavity),
      );
      if (cover <= 0.01) continue;
      const tone = cushion.cellHash;
      const colour = mixRgb(MOSS_DARK, MOSS_LIGHT, tone * 0.75 + patch * 0.25);
      writeAlbedo(canvas, texel, colour, cover);
      canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.16 * cover;
      canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, mix(0.85, 0.95, tone), cover);
      canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.18 * cover);
    }
  }

  // (d) Exposed root and duff breaking through at ~5%.
  const rootCount = Math.max(2, Math.round((edge * edge) / 26_000));
  for (let root = 0; root < rootCount; root += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const angle = random() * Math.PI * 2;
    const length = mix(0.35, 1.1, random()) * texelsPerMeter;
    const width = mix(0.02, 0.055, random()) * texelsPerMeter;
    stampStroke(canvas, x, y, x + Math.cos(angle) * length, y + Math.sin(angle) * length, width,
      (texel, falloff, along) => {
        const weight = saturate(falloff * 1.3);
        writeAlbedo(canvas, texel, ROOT_COLOUR, weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.34 * weight
          * (0.6 + 0.4 * Math.sin(along * Math.PI * 3));
        canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.55, weight);
      });
  }
};

// --- Shrub understory ------------------------------------------------------

const synthesizeShrub: Recipe = (context) => {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;
  fillBase(
    context,
    (u, v) => mixRgb(
      [0.062, 0.05, 0.036],
      [0.09, 0.086, 0.056],
      periodicFbm(u, v, 6, 4, 0.5, seed + 31),
    ),
    (u, v) => 0.33 + periodicFbm(u, v, 6, 4, 0.5, seed + 31) * 0.3,
    // Bare mineral soil between the leaves is matte and DRIER in the exposed
    // patches — a constant here left the whole layer one roughness byte, which
    // `fitRoughnessToSpec`'s degenerate guard caught the moment that guard was
    // made reachable.
    (u, v) => 0.7 + periodicFbm(u, v, 9, 3, 0.5, seed + 32) * 0.22
      + periodicValue(u, v, Math.max(12, Math.round(edge / 5)), seed + 33) * 0.1,
  );
  // Small leathery leaves plus woody twig litter — the understory answer to
  // the forest floor's needle mat.
  const leafCount = Math.round((edge * edge) / 34);
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const lengthMeters = mix(0.015, 0.045, random());
    const radiusX = Math.max(0.9, lengthMeters * 0.5 * texelsPerMeter);
    const radiusY = Math.max(0.7, radiusX * mix(0.35, 0.72, random()));
    const shade = random();
    const colour = mixRgb([0.032, 0.062, 0.022], [0.155, 0.205, 0.078], shade * shade);
    stampEllipse(canvas, x, y, radiusX, radiusY, random() * Math.PI, (texel, falloff) => {
      const weight = saturate(falloff * 2.4);
      writeAlbedo(canvas, texel, colour, weight);
      canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.12 * weight;
      // Waxy cuticle: the understory's leaves are the glossiest vegetation in
      // the table, which is the 3-0 F0 row showing up in the recipe. Each leaf
      // draws its own gloss, so adjacent leaves read differently — the same
      // per-feature-variance rule rock's blocks and gravel's stones follow.
      canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.84 - shade * 0.3, weight);
      canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.22 * weight);
    });
  }
  const stemCount = Math.round((edge * edge) / 2_600);
  for (let stem = 0; stem < stemCount; stem += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const angle = random() * Math.PI * 2;
    const length = mix(0.08, 0.3, random()) * texelsPerMeter;
    const width = Math.max(1.1, mix(0.005, 0.014, random()) * texelsPerMeter);
    stampStroke(canvas, x, y, x + Math.cos(angle) * length, y + Math.sin(angle) * length, width,
      (texel, falloff) => {
        const weight = saturate(falloff * 1.7);
        writeAlbedo(canvas, texel, [0.056, 0.042, 0.03], weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.2 * weight;
        canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.82, weight);
      });
  }
};

// --- Sand ------------------------------------------------------------------

const synthesizeSand: Recipe = (context) => {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;
  // Ripple wavelength ~8.5 cm. The band direction is an INTEGER lattice
  // vector, so the ripple field is exactly periodic on the texture; a
  // real-valued direction would tear at the seam.
  const rippleBands = Math.max(4, Math.round(context.spec.tilingPeriodMeters / 0.085));
  const alongX = rippleBands;
  const alongY = Math.max(1, Math.round(rippleBands * 0.24));
  fillBase(
    context,
    (u, v) => {
      const damp = periodicFbm(u, v, 3, 3, 0.55, seed + 41);
      const grain = periodicValue(u, v, Math.max(8, Math.round(edge / 3)), seed + 42);
      // The ripple is not only relief: crests are dry and bleached, troughs
      // hold moisture and stay dark. Leaving it out of the albedo made sand
      // read as one flat tan chip on the contact sheet.
      const phase = periodicCurvedBands(u, v, alongX, alongY, 0, 9, 1.1, seed + 43);
      const ripple = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      const tone = saturate(0.16 + damp * 0.34 + ripple * 0.42 + (grain - 0.5) * 0.3);
      return mixRgb([0.29, 0.242, 0.163], [0.53, 0.468, 0.335], tone);
    },
    (u, v) => {
      // Crest lines wander at two scales: metres of meander plus a
      // decimetre-scale wander that stops the ripple being a straight lattice.
      const phase = periodicCurvedBands(u, v, alongX, alongY, 0, 9, 1.1, seed + 43);
      const ripple = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      const dune = periodicFbm(u, v, 3, 3, 0.55, seed + 41);
      return 0.3 + ripple * 0.26 + dune * 0.34;
    },
    (u, v) => 0.6 + periodicValue(u, v, Math.max(8, Math.round(edge / 4)), seed + 44) * 0.28,
  );
  // A scatter of small pebbles and shell fragments keeps the surface from
  // reading as a pure signal at range.
  const pebbleCount = Math.round((edge * edge) / 3_400);
  for (let pebble = 0; pebble < pebbleCount; pebble += 1) {
    const x = random() * edge;
    const y = random() * edge;
    const radius = Math.max(0.8, mix(0.004, 0.014, random()) * texelsPerMeter);
    const shade = mix(0.6, 1.3, random());
    stampEllipse(canvas, x, y, radius, radius * mix(0.7, 1, random()), random() * Math.PI,
      (texel, falloff) => {
        const weight = saturate(falloff * 1.6);
        writeAlbedo(canvas, texel, [0.24 * shade, 0.22 * shade, 0.19 * shade], weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) + 0.16 * weight;
        canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.52, weight);
      });
  }
};

// --- Gravel ----------------------------------------------------------------

const synthesizeGravel: Recipe = (context) => {
  const { canvas, seed } = context;
  const edge = canvas.edge;
  // One Worley cell per stone: 2–6 cm rounded gravel over the tiling period.
  const stoneCells = cellsForFeature(edge, context.spec.tilingPeriodMeters, 0.042);
  const gritCells = Math.min(stoneCells * 3, Math.floor(edge / MINIMUM_TEXELS_PER_CELL));
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const stone = periodicWorley(u, v, stoneCells, seed + 51);
      const grit = periodicWorley(u, v, gritCells, seed + 52);
      // Each stone gets its own size, so the packing is not a lattice.
      const stoneRadius = mix(0.3, 0.52, stone.cellHash);
      const body = smoothstep(stoneRadius, stoneRadius * 0.35, stone.f1);
      const gritBody = smoothstep(0.4, 0.14, grit.f1);
      const tint = stone.cellHash;
      const stoneColour = mixRgb([0.13, 0.125, 0.12], [0.34, 0.32, 0.29], tint);
      const matrixColour = mixRgb([0.1, 0.093, 0.083], [0.19, 0.178, 0.16], grit.cellHash);
      const colour = mixRgb(matrixColour, stoneColour, body);
      const at = texel * 3;
      canvas.albedo[at] = colour[0];
      canvas.albedo[at + 1] = colour[1];
      canvas.albedo[at + 2] = colour[2];
      // Dome each stone; the matrix sits low and takes the grit's micro-relief.
      canvas.height[texel] = 0.18 + body * 0.62 * Math.sqrt(Math.max(0, 1 - (stone.f1 / Math.max(1e-4, stoneRadius)) ** 2))
        + gritBody * 0.1 * (1 - body);
      // Per-stone gloss: adjacent stones reading differently is the whole
      // point of a gravel bed, and it is the same rule as rock's per-block
      // variance one scale down.
      canvas.roughness[texel] = mix(0.86, 0.58, body * mix(0.2, 1, tint));
      // Interstices are occluded; the cell-boundary crease is where they are.
      canvas.cavity[texel] = saturate(0.35 + smoothstep(0.0, 0.22, stone.f2 - stone.f1) * 0.65
        * (0.4 + 0.6 * body));
    }
  }
};

// --- Rock ------------------------------------------------------------------

/**
 * §3.2's two named recipe details, both here: two directional fracture
 * families as half-plane bands at ±dip with per-block random phase, and
 * roughness 0.45–0.72 with ±0.08 variance PER BLOCK. Adjacent blocks having
 * visibly different gloss is by itself most of the difference between rock
 * and plastic, so the block field is the load-bearing part of this recipe,
 * not the mottle.
 */
const synthesizeRock: Recipe = (context) => {
  const { canvas, seed } = context;
  const edge = canvas.edge;
  const blockCells = 6;
  // Dip ±23.2°: integer lattice directions (14, ±6) over the tiling period
  // put joints ~0.39 m apart on a 5.9 m tile, and stay exactly periodic.
  const dipA: readonly [number, number] = [14, 6];
  const dipB: readonly [number, number] = [14, -6];
  // Bedding runs across the joints at a shallower angle.
  const bedding: readonly [number, number] = [3, 11];
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const block = periodicWorley(u, v, blockCells, seed + 61);
      // Per-block random phase: without it every block fractures in step and
      // the face reads as one printed pattern.
      const phaseA = block.cellHash;
      const phaseB = hash2(Math.floor(block.cellHash * 4096), 17, seed + 62);
      // One fracture family per irregular block. Even curved and independently
      // masked ±dip families still overlap wherever both masks are non-zero;
      // their crossings survive the mip chain as the reported woven/screen-door
      // lattice. Real joint sets change orientation across blocks. Choosing the
      // family from the block identity preserves both populations across the
      // tile while making their supports mutually exclusive at every texel.
      const useFamilyA = hash2(Math.floor(block.cellHash * 4096), 31, seed + 70) < 0.5;
      const fractureCrust = useFamilyA
        ? periodicCurvedBands(u, v, dipA[0], dipA[1], phaseA, 5, 1.4, seed + 601)
        : periodicCurvedBands(u, v, dipB[0], dipB[1], phaseB, 6, 1.6, seed + 602);
      // Half-plane bands: a joint is an edge, not a sine. The B family remains
      // slightly weaker, but is never added to A inside the same block.
      const jointBand = useFamilyA
        ? smoothstep(0.0, 0.055, fractureCrust) * smoothstep(0.16, 0.105, fractureCrust)
        : smoothstep(0.0, 0.05, fractureCrust)
          * smoothstep(0.14, 0.095, fractureCrust) * 0.8;
      const develop = useFamilyA
        ? smoothstep(0.3, 0.62, periodicFbm(u, v, 3, 3, 0.55, seed + 68))
        : smoothstep(0.34, 0.66, periodicFbm(u, v, 3, 3, 0.55, seed + 69));
      const joint = jointBand * develop;
      const bed = periodicCurvedBands(
        u, v, bedding[0], bedding[1], hash2(3, 5, seed + 63), 4, 1.2, seed + 603);
      const bedStep = smoothstep(0.44, 0.5, bed) * smoothstep(0.62, 0.52, bed);
      const mineral = periodicFbm(u, v, 7, 5, 0.52, seed + 64);
      const crust = periodicRidged(u, v, Math.max(12, Math.round(edge / 8)), 4, 0.55, seed + 65);
      const grain = periodicValue(u, v, Math.max(16, Math.round(edge / 3)), seed + 66);

      const base = mixRgb([0.098, 0.096, 0.093], [0.265, 0.252, 0.226], mineral);
      const veined = mixRgb(base, [0.31, 0.288, 0.252], saturate(bedStep * 0.7));
      const colour = mixRgb(veined, [0.062, 0.058, 0.055], joint * 0.62);
      const shaded = 0.86 + grain * 0.28;
      const at = texel * 3;
      canvas.albedo[at] = colour[0] * shaded;
      canvas.albedo[at + 1] = colour[1] * shaded;
      canvas.albedo[at + 2] = colour[2] * shaded;

      canvas.height[texel] = 0.52 + (mineral - 0.5) * 0.32 + crust * 0.22 - joint * 0.3
        - bedStep * 0.08;
      // The ±0.08 per-block variance the plan names, on top of the crust term.
      const blockGloss = (hash2(Math.floor(block.cellHash * 8192), 29, seed + 67) - 0.5) * 0.16;
      canvas.roughness[texel] = saturate(0.58 + blockGloss + (crust - 0.5) * 0.2 + joint * 0.14);
      canvas.cavity[texel] = saturate(1 - joint * 0.75 - bedStep * 0.18 - (1 - crust) * 0.12);
    }
  }
};

// --- Snow ------------------------------------------------------------------

const synthesizeSnow: Recipe = (context) => {
  const { canvas, seed } = context;
  const edge = canvas.edge;
  const sastrugiBands = Math.max(3, Math.round(context.spec.tilingPeriodMeters / 0.55));
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const drift = periodicFbm(u, v, 3, 4, 0.55, seed + 71);
      const ridge = periodicCurvedBands(
        u, v, sastrugiBands, Math.max(1, Math.round(sastrugiBands * 0.3)), 0, 4, 1.2, seed + 72);
      const sastrugi = smoothstep(0.3, 0.5, ridge) * smoothstep(0.78, 0.56, ridge);
      // Ice grains: a high-frequency sparkle carried in ROUGHNESS, not in
      // albedo. Snow is not a speckled white surface; it is a smooth white
      // surface with facets that catch the sun.
      const grain = periodicValue(u, v, Math.max(24, Math.round(edge / 2)), seed + 73);
      const crust = periodicRidged(u, v, Math.max(10, Math.round(edge / 12)), 3, 0.5, seed + 74);
      const brightness = 0.93 + drift * 0.09 + sastrugi * 0.05;
      const at = texel * 3;
      canvas.albedo[at] = 0.76 * brightness;
      canvas.albedo[at + 1] = 0.79 * brightness;
      canvas.albedo[at + 2] = 0.85 * brightness;
      canvas.height[texel] = 0.34 + drift * 0.34 + sastrugi * 0.3 + crust * 0.06;
      canvas.roughness[texel] = saturate(0.42 - grain * 0.34 + (1 - drift) * 0.14
        - sastrugi * 0.12);
      canvas.cavity[texel] = saturate(0.72 + drift * 0.28);
    }
  }
};

// --- Asphalt ---------------------------------------------------------------

const synthesizeAsphalt: Recipe = (context) => {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;
  const aggregateCells = cellsForFeature(edge, context.spec.tilingPeriodMeters, 0.011);
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const stone = periodicWorley(u, v, aggregateCells, seed + 81);
      const wear = periodicFbm(u, v, 4, 4, 0.55, seed + 82);
      // Worn asphalt loses its bitumen film and the aggregate shows through.
      const aggregateExposed = saturate(smoothstep(0.4, 0.75, wear));
      const stoneBody = smoothstep(0.46, 0.2, stone.f1) * aggregateExposed;
      const bitumen = mixRgb([0.026, 0.027, 0.029], [0.055, 0.056, 0.06], wear);
      const aggregate = mixRgb([0.09, 0.088, 0.084], [0.2, 0.194, 0.182], stone.cellHash);
      const colour = mixRgb(bitumen, aggregate, stoneBody);
      const at = texel * 3;
      canvas.albedo[at] = colour[0];
      canvas.albedo[at + 1] = colour[1];
      canvas.albedo[at + 2] = colour[2];
      canvas.height[texel] = 0.46 + stoneBody * 0.34 - (1 - aggregateExposed) * 0.06
        + (periodicValue(u, v, aggregateCells * 2, seed + 83) - 0.5) * 0.1;
      // Fresh bitumen keeps a sheen; the wheel paths are matte.
      canvas.roughness[texel] = saturate(0.5 + aggregateExposed * 0.34
        + (stone.cellHash - 0.5) * 0.12 * stoneBody);
      canvas.cavity[texel] = saturate(1 - smoothstep(0.24, 0.02, stone.f2 - stone.f1) * 0.45);
    }
  }
  // Thermal cracking: long, thin, dark, slightly recessed.
  const crackCount = Math.max(3, Math.round((edge * edge) / 18_000));
  for (let crack = 0; crack < crackCount; crack += 1) {
    let x = random() * edge;
    let y = random() * edge;
    let angle = random() * Math.PI * 2;
    const segments = 5 + Math.floor(random() * 7);
    for (let segment = 0; segment < segments; segment += 1) {
      const length = mix(0.15, 0.6, random()) * texelsPerMeter;
      const nextX = x + Math.cos(angle) * length;
      const nextY = y + Math.sin(angle) * length;
      stampStroke(canvas, x, y, nextX, nextY, Math.max(1, 0.012 * texelsPerMeter),
        (texel, falloff) => {
          const weight = saturate(falloff * 2);
          writeAlbedo(canvas, texel, [0.014, 0.014, 0.015], weight);
          canvas.height[texel] = (canvas.height[texel] ?? 0) - 0.3 * weight;
          canvas.roughness[texel] = mix(canvas.roughness[texel] ?? 0, 0.86, weight);
          canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.55 * weight);
        });
      x = nextX;
      y = nextY;
      angle += (random() - 0.5) * 1.1;
    }
  }
};

// --- Concrete --------------------------------------------------------------

const synthesizeConcrete: Recipe = (context) => {
  const { canvas, seed, random, texelsPerMeter } = context;
  const edge = canvas.edge;
  const aggregateCells = cellsForFeature(edge, context.spec.tilingPeriodMeters, 0.02);
  // Float sweeps: broad, low-contrast arcs left by the finishing tool.
  const sweepBands = 5;
  for (let y = 0; y < edge; y += 1) {
    const v = (y + 0.5) / edge;
    for (let x = 0; x < edge; x += 1) {
      const u = (x + 0.5) / edge;
      const texel = y * edge + x;
      const stone = periodicWorley(u, v, aggregateCells, seed + 91);
      const stain = periodicFbm(u, v, 3, 4, 0.55, seed + 92);
      const sweep = periodicCurvedBands(
        u, v, sweepBands, Math.max(1, Math.round(sweepBands * 0.6)), 0, 3, 1.3, seed + 93);
      const sweepShade = 0.5 - 0.5 * Math.cos(sweep * Math.PI * 2);
      const grain = periodicValue(u, v, Math.max(16, Math.round(edge / 2)), seed + 94);
      const aggregateBody = smoothstep(0.4, 0.22, stone.f1);
      const base = mixRgb([0.2, 0.2, 0.195], [0.34, 0.338, 0.325], stain);
      const colour = mixRgb(base, [0.26, 0.256, 0.245], aggregateBody * 0.6);
      const shade = 0.94 + sweepShade * 0.08 + (grain - 0.5) * 0.07;
      const at = texel * 3;
      canvas.albedo[at] = colour[0] * shade;
      canvas.albedo[at + 1] = colour[1] * shade;
      canvas.albedo[at + 2] = colour[2] * shade;
      canvas.height[texel] = 0.5 + aggregateBody * 0.12 + sweepShade * 0.14
        + (grain - 0.5) * 0.08;
      canvas.roughness[texel] = saturate(0.72 + (1 - stain) * 0.12 + (grain - 0.5) * 0.1);
      canvas.cavity[texel] = 1;
    }
  }
  // Air voids: small dark pits, the tell that says "cast", not "printed".
  const voidCount = Math.round((edge * edge) / 900);
  for (let air = 0; air < voidCount; air += 1) {
    const radius = Math.max(0.7, mix(0.0015, 0.006, random() * random()) * texelsPerMeter);
    stampEllipse(canvas, random() * edge, random() * edge, radius, radius, 0,
      (texel, falloff) => {
        const weight = saturate(falloff * 2);
        writeAlbedo(canvas, texel, [0.12, 0.12, 0.118], weight);
        canvas.height[texel] = (canvas.height[texel] ?? 0) - 0.22 * weight;
        canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.5 * weight);
      });
  }
  // Hairline shrinkage cracks.
  const crackCount = Math.max(2, Math.round((edge * edge) / 30_000));
  for (let crack = 0; crack < crackCount; crack += 1) {
    let x = random() * edge;
    let y = random() * edge;
    let angle = random() * Math.PI * 2;
    for (let segment = 0; segment < 6; segment += 1) {
      const length = mix(0.2, 0.7, random()) * texelsPerMeter;
      const nextX = x + Math.cos(angle) * length;
      const nextY = y + Math.sin(angle) * length;
      stampStroke(canvas, x, y, nextX, nextY, Math.max(0.9, 0.006 * texelsPerMeter),
        (texel, falloff) => {
          const weight = saturate(falloff * 2.2);
          writeAlbedo(canvas, texel, [0.13, 0.13, 0.127], weight);
          canvas.height[texel] = (canvas.height[texel] ?? 0) - 0.24 * weight;
          canvas.cavity[texel] = (canvas.cavity[texel] ?? 1) * (1 - 0.4 * weight);
        });
      x = nextX;
      y = nextY;
      angle += (random() - 0.5) * 0.8;
    }
  }
};

const RECIPES: Readonly<Record<SurfaceMaterialId, Recipe>> = Object.freeze({
  [SurfaceMaterial.Grass]: synthesizeGrass,
  [SurfaceMaterial.DryGrass]: synthesizeDryGrass,
  [SurfaceMaterial.ForestFloor]: synthesizeForestFloor,
  [SurfaceMaterial.Shrub]: synthesizeShrub,
  [SurfaceMaterial.Sand]: synthesizeSand,
  [SurfaceMaterial.Gravel]: synthesizeGravel,
  [SurfaceMaterial.Rock]: synthesizeRock,
  [SurfaceMaterial.Snow]: synthesizeSnow,
  [SurfaceMaterial.Asphalt]: synthesizeAsphalt,
  [SurfaceMaterial.Concrete]: synthesizeConcrete,
});

// ---------------------------------------------------------------------------
// Finalisation. Every recipe writes RELATIVE structure; this is where the
// 3-0 contract is imposed, by construction rather than by review.
// ---------------------------------------------------------------------------

/**
 * Separable wrapped box blur — the local mean a concavity term is measured
 * against. Sliding running sum, so the cost is O(texels) rather than
 * O(texels × radius): at 1024² with an edge/64 radius the naive form is the
 * single most expensive step in the whole synthesis.
 */
function boxBlur(field: Float32Array, edge: number, radius: number): Float32Array {
  const width = radius * 2 + 1;
  const inverseWidth = 1 / width;
  const horizontal = new Float32Array(field.length);
  for (let y = 0; y < edge; y += 1) {
    const row = y * edge;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += field[row + wrapCell(offset, edge)]!;
    }
    for (let x = 0; x < edge; x += 1) {
      horizontal[row + x] = sum * inverseWidth;
      sum += field[row + wrapCell(x + radius + 1, edge)]! - field[row + wrapCell(x - radius, edge)]!;
    }
  }
  const output = new Float32Array(field.length);
  for (let x = 0; x < edge; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += horizontal[wrapCell(offset, edge) * edge + x]!;
    }
    for (let y = 0; y < edge; y += 1) {
      output[y * edge + x] = sum * inverseWidth;
      sum += horizontal[wrapCell(y + radius + 1, edge) * edge + x]!
        - horizontal[wrapCell(y - radius, edge) * edge + x]!;
    }
  }
  return output;
}

/**
 * Robust low/high bounds, ignoring the outer `tailFraction` of the histogram.
 * A 1024-bucket histogram rather than a sort: the field is already quantised
 * to a byte downstream, so bucket resolution is four times finer than the
 * output can express, and the cost is linear instead of n log n.
 */
function robustRange(field: Float32Array, tailFraction: number): readonly [number, number] {
  const buckets = 1_024;
  const histogram = new Int32Array(buckets);
  let below = 0;
  let above = 0;
  for (let index = 0; index < field.length; index += 1) {
    const value = field[index]!;
    if (value < 0) {
      below += 1;
    } else if (value > 1) {
      above += 1;
    } else {
      histogram[Math.min(buckets - 1, Math.floor(value * buckets))]! += 1;
    }
  }
  const tail = Math.floor(field.length * tailFraction);
  let running = below;
  let low = 0;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    running += histogram[bucket]!;
    if (running > tail) {
      low = bucket / buckets;
      break;
    }
  }
  running = above;
  let high = 1;
  for (let bucket = buckets - 1; bucket >= 0; bucket -= 1) {
    running += histogram[bucket]!;
    if (running > tail) {
      high = (bucket + 1) / buckets;
      break;
    }
  }
  return [low, Math.max(low + 1 / buckets, high)];
}

/**
 * High-pass a channel against its own local mean, keeping `keepFraction` of
 * the low-frequency part.
 *
 * This is what stops the layer TILING VISIBLY. A material's mip tail is its
 * low-frequency content, and a layer that still carries metre-scale structure
 * at mip 6 shows its whole tiling period as a regular quilt the moment the
 * footprint approaches the period — measured at ~1 km on the `approach-500ft`
 * capture, where a 4.3 m sand tile repeated every four screen pixels. The
 * de-tiling warp cannot help there: its finest scale is 28 m, so within any
 * few-pixel neighbourhood it is constant.
 *
 * Removing the energy is the fix, and it is also the correct division of
 * labour. Metre-scale structure belongs to the material; hundred-metre
 * structure belongs to the splat and to `3-4`'s macro de-tiling term, which
 * modulates albedo in the shader at 2 km and 176 m. A quarter of the layer's
 * own low frequency survives so it does not go dead flat under the aircraft.
 */
function flattenLowFrequency(
  field: Float32Array,
  edge: number,
  stride: number,
  channel: number,
  radius: number,
  keepFraction: number,
): void {
  const texels = edge * edge;
  const extracted = new Float32Array(texels);
  for (let texel = 0; texel < texels; texel += 1) {
    extracted[texel] = field[texel * stride + channel]!;
  }
  const blurred = boxBlur(extracted, edge, radius);
  let sum = 0;
  for (let texel = 0; texel < texels; texel += 1) sum += extracted[texel]!;
  const mean = sum / texels;
  for (let texel = 0; texel < texels; texel += 1) {
    const low = blurred[texel]!;
    const high = extracted[texel]! - low;
    field[texel * stride + channel] = mean + (low - mean) * keepFraction + high;
  }
}

/** Radius of the local mean the high-pass measures against, as a fraction of the edge. */
const LOW_FREQUENCY_RADIUS_FRACTION = 6;
/** How much of each layer's own low frequency survives. */
const LOW_FREQUENCY_KEEP = 0.28;

/**
 * Assertion 53's producer: re-centre the height channel on 0.5 without
 * clipping. Scaling ABOUT 0.5 preserves the mean exactly, so the shift and
 * the fit cannot fight each other — and without this `3-6`'s height blend has
 * one layer permanently winning every comparison.
 */
function normalizeHeightToHalf(height: Float32Array): void {
  let sum = 0;
  for (let index = 0; index < height.length; index += 1) sum += height[index]!;
  const mean = sum / height.length;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < height.length; index += 1) {
    const shifted = (height[index] ?? 0) - mean + 0.5;
    height[index] = shifted;
    if (shifted < low) low = shifted;
    if (shifted > high) high = shifted;
  }
  const reach = Math.max(high - 0.5, 0.5 - low, 1e-6);
  const scale = reach > 0.5 ? 0.5 / reach : 1;
  if (scale === 1) return;
  for (let index = 0; index < height.length; index += 1) {
    height[index] = 0.5 + ((height[index] ?? 0.5) - 0.5) * scale;
  }
}

/**
 * Impose the spec's roughness band on the recipe's relative gloss. Recipes
 * write structure; the physical band is 3-0's. Mapping (rather than clamping)
 * is what makes assertion 61 structural: a recipe that wrote a constant
 * roughness produces a degenerate range and is caught, and a recipe that
 * overshot its band cannot quietly widen it.
 */
function fitRoughnessToSpec(roughness: Float32Array, spec: SurfaceMaterialSpec): void {
  const [low, high] = robustRange(roughness, 0.02);
  const span = high - low;
  const [specLow, specHigh] = spec.roughness;
  // robustRange never returns a span below one histogram bucket, so a 1e-4
  // guard could not fire: a recipe that wrote a near-constant roughness would
  // have had its quantisation noise stretched across the whole spec band.
  if (span < 0.02) {
    const middle = (specLow + specHigh) * 0.5;
    roughness.fill(middle);
    return;
  }
  const scale = (specHigh - specLow) / span;
  for (let index = 0; index < roughness.length; index += 1) {
    roughness[index] = saturate(
      Math.min(specHigh, Math.max(specLow, specLow + ((roughness[index] ?? 0) - low) * scale)),
    );
  }
}

/**
 * Scale each albedo channel so the layer INTEGRATES to the spec's reference
 * albedo. That is what lets `R-26` derive the light rig's ground bounce from
 * the contract instead of from whatever the recipes happened to produce, and
 * it keeps a recipe tweak from silently relighting the world.
 */
function fitAlbedoToReference(albedo: Float32Array, spec: SurfaceMaterialSpec): void {
  const texels = albedo.length / 3;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let texel = 0; texel < texels; texel += 1) sum += albedo[texel * 3 + channel]!;
      const mean = sum / texels;
      const target = spec.referenceAlbedo[channel]!;
      if (mean <= 1e-6) continue;
      const scale = target / mean;
      for (let texel = 0; texel < texels; texel += 1) {
        const at = texel * 3 + channel;
        albedo[at] = saturate((albedo[at] ?? 0) * scale);
      }
    }
  }
}

/** Pack the finished canvas into the two RGBA layers 3-0's layout declares. */
function packLayers(
  canvas: MaterialCanvas,
  spec: SurfaceMaterialSpec,
  targetRmsSlope: number,
): { albedoHeight: Uint8Array; normalMaterial: Uint8Array } {
  const edge = canvas.edge;
  const texels = edge * edge;
  const albedoHeight = new Uint8Array(texels * RGBA_CHANNELS);
  const normalMaterial = new Uint8Array(texels * RGBA_CHANNELS);

  // Central differences at one texel — the largest gradient the stored
  // resolution can honestly report. (`3-3`'s "the 0.38 world-metre forward
  // difference is not measuring a gradient at all" failure, answered on the
  // producing side rather than in the shader.)
  const gradientX = new Float32Array(texels);
  const gradientY = new Float32Array(texels);
  let sumSquares = 0;
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const texel = y * edge + x;
      const left = canvas.height[y * edge + wrapCell(x - 1, edge)]!;
      const right = canvas.height[y * edge + wrapCell(x + 1, edge)]!;
      const up = canvas.height[wrapCell(y - 1, edge) * edge + x]!;
      const down = canvas.height[wrapCell(y + 1, edge) * edge + x]!;
      const dx = (right - left) * 0.5;
      const dy = (down - up) * 0.5;
      gradientX[texel] = dx;
      gradientY[texel] = dy;
      sumSquares += dx * dx + dy * dy;
    }
  }
  const measuredRms = Math.sqrt(sumSquares / texels);
  const slopeScale = measuredRms > 1e-6 ? targetRmsSlope / measuredRms : 0;

  // A local-mean openness term, folded into whatever cavity the recipe wrote.
  const openness = boxBlur(canvas.height, edge, Math.max(1, Math.round(edge / 64)));

  for (let texel = 0; texel < texels; texel += 1) {
    // Clamp the tail: a crack or a joint is a discontinuity in the height
    // field, and an unclamped normal there points sideways.
    const slopeX = Math.max(-4, Math.min(4, gradientX[texel]! * slopeScale));
    const slopeY = Math.max(-4, Math.min(4, gradientY[texel]! * slopeScale));
    const inverse = 1 / Math.hypot(slopeX, slopeY, 1);
    const normalX = -slopeX * inverse;
    const normalY = -slopeY * inverse;

    const cavity = saturate(
      (canvas.cavity[texel] ?? 1)
      * mix(1, saturate(0.55 + ((canvas.height[texel] ?? 0.5) - (openness[texel] ?? 0.5)) * 4), 0.7),
    );

    const albedoAt = texel * 3;
    const out = texel * RGBA_CHANNELS;
    // Gamma-2.0 encoding (store sqrt, square on read). Linear RGBA8 gives
    // forest floor a mean albedo byte of 15 and asphalt 11 — a dozen usable
    // levels for the two materials that cover most of the world — and the
    // banding is visible on approach. One multiply in the shader buys 4x the
    // precision where it is scarcest. The shader's decode is the pair of this
    // line; `SURFACE_ARRAY_A_CHANNELS` names the encoding.
    albedoHeight[out] = Math.round(Math.sqrt(saturate(canvas.albedo[albedoAt] ?? 0)) * 255);
    albedoHeight[out + 1] = Math.round(Math.sqrt(saturate(canvas.albedo[albedoAt + 1] ?? 0)) * 255);
    albedoHeight[out + 2] = Math.round(Math.sqrt(saturate(canvas.albedo[albedoAt + 2] ?? 0)) * 255);
    albedoHeight[out + 3] = Math.round(saturate(canvas.height[texel] ?? 0.5) * 255);
    normalMaterial[out] = Math.round(saturate(normalX * 0.5 + 0.5) * 255);
    normalMaterial[out + 1] = Math.round(saturate(normalY * 0.5 + 0.5) * 255);
    normalMaterial[out + 2] = Math.round(saturate(canvas.roughness[texel] ?? 0.5) * 255);
    normalMaterial[out + 3] = Math.round(cavity * 255);
  }
  // `spec` stays in the signature: the roughness band and the reference albedo
  // it carries are imposed before this point, and the assertion that they
  // survive quantization reads this function's output.
  void spec;
  return { albedoHeight, normalMaterial };
}

/** One material's two RGBA layers — a pure function of (id, seed, edge). */
export function synthesizeSurfaceMaterial(
  id: SurfaceMaterialId,
  seed: WorldSeed,
  edge: number,
): { albedoHeight: Uint8Array; normalMaterial: Uint8Array } {
  if (!Number.isInteger(edge) || edge < 8 || (edge & (edge - 1)) !== 0) {
    throw new RangeError(`Material array edge must be a power of two >= 8, got ${edge}`);
  }
  const spec = SURFACE_MATERIALS[id];
  if (!spec) throw new RangeError(`Unknown surface material id ${id}`);
  const layerSeed = hashSeed(`surface-material/${normalizeSeed(seed)}/${spec.name}`);
  const canvas = createCanvas(edge);
  const context: RecipeContext = {
    canvas,
    spec,
    seed: layerSeed,
    random: createStream(layerSeed ^ 0x5f37_59df),
    texelsPerMeter: edge / spec.tilingPeriodMeters,
  };
  RECIPES[id](context);
  // High-pass before the contract is imposed, so the mean albedo and the mean
  // height the contract fixes are the ones the shader actually reads.
  const radius = Math.max(1, Math.round(edge / LOW_FREQUENCY_RADIUS_FRACTION));
  for (let channel = 0; channel < 3; channel += 1) {
    flattenLowFrequency(canvas.albedo, edge, 3, channel, radius, LOW_FREQUENCY_KEEP);
  }
  flattenLowFrequency(canvas.height, edge, 1, 0, radius, LOW_FREQUENCY_KEEP);
  flattenLowFrequency(canvas.roughness, edge, 1, 0, radius, LOW_FREQUENCY_KEEP);
  normalizeHeightToHalf(canvas.height);
  fitRoughnessToSpec(canvas.roughness, spec);
  fitAlbedoToReference(canvas.albedo, spec);
  return packLayers(canvas, spec, NORMAL_RMS_SLOPE[id]);
}

/** All ten materials, in `SurfaceMaterial` index order. Pure. */
export function synthesizeSurfaceMaterialLayers(
  seed: WorldSeed,
  edge: number,
): { albedoHeight: Uint8Array[]; normalMaterial: Uint8Array[] } {
  const albedoHeight: Uint8Array[] = [];
  const normalMaterial: Uint8Array[] = [];
  for (const spec of SURFACE_MATERIALS) {
    const layers = synthesizeSurfaceMaterial(spec.id, seed, edge);
    albedoHeight.push(layers.albedoHeight);
    normalMaterial.push(layers.normalMaterial);
  }
  return { albedoHeight, normalMaterial };
}

// ---------------------------------------------------------------------------
// The debug viewer (§7 `3-1`: "built on day one, not last").
//
// It is a contact sheet rather than an in-game overlay on purpose: the thing
// a tuning session actually needs is ten materials side by side, every
// channel visible, at several footprints, against the reference notes above —
// and that is a pure function of the plan, so it can be diffed, committed and
// asserted. `scripts/material-preview.mts` writes it to a PNG.
// ---------------------------------------------------------------------------

/** One row of the sheet: which channel of which array, and how to show it. */
export const CONTACT_SHEET_VIEWS = [
  "albedo",
  "normal",
  "roughness",
  "height",
  "cavity",
] as const;

export type ContactSheetView = (typeof CONTACT_SHEET_VIEWS)[number];

export interface ContactSheet {
  readonly width: number;
  readonly height: number;
  readonly cellEdge: number;
  /** Row-major RGBA8. */
  readonly rgba: Uint8Array;
  /** Row labels, top to bottom — `${view} @ mip${level}`. */
  readonly rows: readonly string[];
  /** Column labels, left to right — the material names. */
  readonly columns: readonly string[];
}

function sampleCell(
  level: Uint8Array,
  levelEdge: number,
  layer: number,
  x: number,
  y: number,
  cellEdge: number,
): readonly [number, number, number, number] {
  const sourceX = Math.min(levelEdge - 1, Math.floor((x * levelEdge) / cellEdge));
  const sourceY = Math.min(levelEdge - 1, Math.floor((y * levelEdge) / cellEdge));
  const at = (layer * levelEdge * levelEdge + sourceY * levelEdge + sourceX) * RGBA_CHANNELS;
  return [level[at] ?? 0, level[at + 1] ?? 0, level[at + 2] ?? 0, level[at + 3] ?? 0];
}

/**
 * Compose the sheet: one column per material, one row per (view, footprint).
 * The three footprints are what makes the Toksvig term visible by eye — a
 * material whose normals average to nothing without gaining roughness reads
 * as a flat plastic chip in the mip4 row.
 */
export function composeSurfaceMaterialContactSheet(
  plans: SurfaceMaterialArrayPlans,
  cellEdge = 128,
  mipLevels: readonly number[] = [0, 2, 4],
): ContactSheet {
  const columns = SURFACE_MATERIALS.map((spec) => spec.name);
  const rows: string[] = [];
  for (const level of mipLevels) {
    for (const view of CONTACT_SHEET_VIEWS) rows.push(`${view} @ mip${level}`);
  }
  const width = columns.length * cellEdge;
  const height = rows.length * cellEdge;
  const rgba = new Uint8Array(width * height * RGBA_CHANNELS);

  let row = 0;
  for (const level of mipLevels) {
    const levelEdge = Math.max(1, plans.edge >> level);
    const albedoLevel = plans.albedoHeight.packedLevels[level];
    const normalLevel = plans.normalMaterial.packedLevels[level];
    if (!albedoLevel || !normalLevel) {
      throw new RangeError(`Contact sheet requested mip ${level}, which the plan does not carry`);
    }
    for (const view of CONTACT_SHEET_VIEWS) {
      for (let layer = 0; layer < columns.length; layer += 1) {
        for (let y = 0; y < cellEdge; y += 1) {
          for (let x = 0; x < cellEdge; x += 1) {
            const source = view === "albedo" || view === "height" ? albedoLevel : normalLevel;
            const texel = sampleCell(source, levelEdge, layer, x, y, cellEdge);
            let r = 0;
            let g = 0;
            let b = 0;
            if (view === "albedo") {
              // The stored bytes are already sqrt(linear) — a gamma-2.0
              // encoding — which is close enough to display gamma to show
              // straight through. Anything else would misrepresent what the
              // shader reads.
              r = texel[0];
              g = texel[1];
              b = texel[2];
            } else if (view === "normal") {
              const nx = (texel[0] / 255) * 2 - 1;
              const ny = (texel[1] / 255) * 2 - 1;
              const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
              r = texel[0];
              g = texel[1];
              b = Math.round(saturate(nz) * 255);
            } else if (view === "roughness") {
              r = texel[2];
              g = texel[2];
              b = texel[2];
            } else if (view === "height") {
              r = texel[3];
              g = texel[3];
              b = texel[3];
            } else {
              r = texel[3];
              g = texel[3];
              b = texel[3];
            }
            const out = ((row * cellEdge + y) * width + layer * cellEdge + x) * RGBA_CHANNELS;
            rgba[out] = r;
            rgba[out + 1] = g;
            rgba[out + 2] = b;
            rgba[out + 3] = 255;
          }
        }
      }
      row += 1;
    }
  }
  return { width, height, cellEdge, rgba, rows, columns };
}
