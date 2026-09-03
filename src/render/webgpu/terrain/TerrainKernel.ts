import {
  FRACTURE_EXPOSURE_MEAN,
  FRACTURE_RAVINE_MEAN,
  TALUS_RIDGES_MEAN,
} from "@/src/world/geology";
import {
  NOISE_LATTICE_WRAP_PERIOD_CELLS,
  RIDGED_OCTAVE_BAND_LIMIT_MEAN,
  ridgedChannelVarianceKept,
  smoothstep,
} from "@/src/world/noise";
import { mixSeed } from "@/src/world/seed";
import {
  LOCAL_RIDGES_KNOLL_MEAN,
  MAX_TERRAIN_HEIGHT,
  MIN_TERRAIN_HEIGHT,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_POW_158_MEAN,
  RIDGES_POW_212_MEAN,
  RIDGES_SMOOTH_42_82_MEAN,
} from "@/src/world/terrain";

/**
 * The WGSL terrain height kernel (`4-1`) — Class K.
 *
 * INVARIANT THIS FILE OWNS: there is exactly ONE height kernel, written in
 * TypeScript under `src/world/`, and this file is its TRANSLITERATION — never
 * a second implementation. `src/world/{seed,noise,geology,terrain}.ts` has
 * been maintained since Phase 0 as simultaneously the physics authority and
 * the source this file ports; every expectation constant below is IMPORTED
 * from that source and template-substituted, never retyped.
 *
 * Six rules, each from a measured fact rather than a preference:
 *
 * 1. **Split-origin lattice addressing.** The GPU never holds a large
 *    absolute coordinate. Per lattice, the CPU computes the wrapped origin in
 *    f64 and passes `(cellInteger, cellFraction)`; the GPU forms
 *    `cell = cellInteger + floor(cellFraction + local)` and
 *    `t = fract(cellFraction + local)`. Naive f32 diverges by 4.5 mm at
 *    ±10⁴ m, 60 mm at ±10⁵ m and 3.47 m at ±5×10⁶ m over a 40,000-point probe
 *    — and holding the chain in f64 buys only 1.43×, so precision is the
 *    whole story and hoisting is the answer.
 * 2. **`kLerp`, `kSmoothstep`, `kRound` are hand-written.** WGSL `mix` is
 *    specified as `a·(1−t) + b·t` and `lerp` is `a + (b−a)·t` — different
 *    rounding at 102 sites per height sample. `smoothstep` in `noise.ts`
 *    carries a `low === high` guard WGSL's builtin does not.
 *    `Math.round` is round-half-toward-+∞; WGSL `round` is
 *    round-half-to-even. `TERRAIN_KERNEL_FORBIDDEN_BUILTINS` is asserted
 *    against the emitted source.
 * 3. **The eleven expectation constants are injected**, and a test asserts
 *    each value appears in the emitted WGSL. `filterWidth ∈ {128, 512}` are
 *    mandatory parity rows: at `filterWidth = 0` `blendTowardExpectation`
 *    short-circuits and a wrong constant is invisible.
 * 4. **Band-limit weights are page constants.** `octaveBandWeight(wavelength,
 *    filterWidth)` depends only on the octave index and the page's texel
 *    size, so it is computed by the existing TypeScript in f64 and hoisted
 *    into the page uniform — removing a divergence source entirely. Measured:
 *    at L0–L4 every weight in the `ridges` channel is exactly 1.0; the fade
 *    only starts biting at L5.
 * 5. **`wrapLatticeCoordinate` is ported verbatim** as `floor(v/P + 0.5)` —
 *    which is what `Math.round` is, since JS rounds halves toward +∞ and not
 *    away from zero.
 * 6. **`geology.ts`'s `land <= 0.0001` early-out is ported verbatim.** It is
 *    the only genuine f32/f64 cliff in the chain, bounded at ~10 mm because
 *    every returned term is proportional to `land`. Do not smooth it — that
 *    changes shipped terrain.
 *
 * **Cost.** One evaluation is 34 `valueNoise2D` calls = 306 `avalanche()`
 * calls = 612 wrapping u32 multiplies. That is the number `4-3`'s budget row
 * is derived from, and it is ~4× a naive estimate once supersampling applies.
 */

// ---------------------------------------------------------------------------
// The injected constants
// ---------------------------------------------------------------------------

/**
 * Every measured expectation the kernel depends on, imported rather than
 * retyped. A wrong digit here moves coarse-page mean height by METRES and
 * would pass a parity probe run only at `filterWidth = 0`.
 */
export const TERRAIN_KERNEL_CONSTANTS = Object.freeze({
  RIDGED_OCTAVE_BAND_LIMIT_MEAN,
  RIDGES_POW_212_MEAN,
  RIDGES_POW_158_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_SMOOTH_42_82_MEAN,
  LOCAL_RIDGES_KNOLL_MEAN,
  FRACTURE_EXPOSURE_MEAN,
  FRACTURE_RAVINE_MEAN,
  TALUS_RIDGES_MEAN,
  MIN_TERRAIN_HEIGHT,
  MAX_TERRAIN_HEIGHT,
});

/** WGSL builtins whose rounding differs from the TypeScript source (rule 2). */
export const TERRAIN_KERNEL_FORBIDDEN_BUILTINS: readonly string[] = Object.freeze([
  "mix(",
  "smoothstep(",
  "round(",
]);

// ---------------------------------------------------------------------------
// The lattice table — the enumeration the CPU uniform builder and the WGSL
// index into identically.
// ---------------------------------------------------------------------------

/** Which coordinate frame a lattice's local offsets arrive in. */
export type TerrainKernelSpace = "world" | "warped" | "rotated" | "sheared";

export interface TerrainKernelLattice {
  readonly name: string;
  readonly space: TerrainKernelSpace;
  /** `mixSeed(seedHash, channel)` selects the channel. */
  readonly channel: number;
  /** A second `mixSeed` for fbm/ridged octaves; null for a bare lattice. */
  readonly octaveChannel: number | null;
  readonly divisorX: number;
  readonly divisorZ: number;
  /** Lattice-space offsets applied AFTER the division (the warp-Z pair). */
  readonly offsetX: number;
  readonly offsetZ: number;
  /** Wavelength the band-limit fade keys on; the octave's own amplitude. */
  readonly wavelengthMeters: number;
  readonly amplitude: number;
  /**
   * `6-8`: the shear factor of a `"sheared"` lattice.
   *
   * The rain-shadow channel was the only sheared lattice until the vegetation
   * table arrived, so 0.42 was a literal inside the builder. It defaults to
   * 0.42, which keeps every pre-existing lattice's split origin byte-identical.
   */
  readonly shearFactor?: number;
  /**
   * `6-8`: a band-limit half-width this lattice uses INSTEAD of the page's.
   *
   * D12 band-limits per page so canopy cover cannot change when a page changes
   * LOD. A channel read at two levels along one continuous surface needs the
   * stronger property — the same value at every level — which a per-page width
   * cannot give. An appended table declares its own width; the terrain kernel's
   * own lattices declare none and are untouched.
   */
  readonly filterWidthMetersOverride?: number;
}

/** The shear a `"sheared"` lattice uses when it declares none of its own. */
const DEFAULT_LATTICE_SHEAR = 0.42;

export function terrainKernelFbmRun(
  name: string,
  space: TerrainKernelSpace,
  channel: number,
  octaves: number,
  baseWavelength: number,
  lacunarity: number,
  persistence: number,
  divisorZScale = 1,
  shearFactor = DEFAULT_LATTICE_SHEAR,
): TerrainKernelLattice[] {
  const run: TerrainKernelLattice[] = [];
  let frequency = 1;
  let amplitude = 1;
  let wavelength = baseWavelength;
  for (let octave = 0; octave < octaves; octave += 1) {
    run.push({
      name: `${name}[${octave}]`,
      space,
      channel,
      // fbm2D keys its octaves on `octave + 1`; ridgedFbm2D on `31 + octave`.
      octaveChannel: octave + 1,
      divisorX: baseWavelength / frequency,
      divisorZ: (baseWavelength * divisorZScale) / frequency,
      offsetX: 0,
      offsetZ: 0,
      wavelengthMeters: wavelength,
      amplitude,
      shearFactor,
    });
    amplitude *= persistence;
    frequency *= lacunarity;
    wavelength /= lacunarity;
  }
  return run;
}

function ridgedRun(
  name: string,
  space: TerrainKernelSpace,
  channel: number,
  octaves: number,
  baseWavelength: number,
  divisorZMeters = baseWavelength,
): TerrainKernelLattice[] {
  // ridgedFbm2D fixes lacunarity 2.03 and persistence 0.52.
  const run: TerrainKernelLattice[] = [];
  let frequency = 1;
  let amplitude = 1;
  let wavelength = baseWavelength;
  for (let octave = 0; octave < octaves; octave += 1) {
    run.push({
      name: `${name}[${octave}]`,
      space,
      channel,
      octaveChannel: 31 + octave,
      divisorX: baseWavelength / frequency,
      divisorZ: divisorZMeters / frequency,
      offsetX: 0,
      offsetZ: 0,
      wavelengthMeters: wavelength,
      amplitude,
    });
    amplitude *= 0.52;
    frequency *= 2.03;
    wavelength /= 2.03;
  }
  return run;
}

export function terrainKernelBareLattice(
  name: string,
  space: TerrainKernelSpace,
  channel: number,
  divisorX: number,
  divisorZ: number,
  wavelengthMeters: number,
  offsetX = 0,
  offsetZ = 0,
  shearFactor = DEFAULT_LATTICE_SHEAR,
): TerrainKernelLattice {
  return {
    name,
    space,
    channel,
    octaveChannel: null,
    divisorX,
    divisorZ,
    offsetX,
    offsetZ,
    wavelengthMeters,
    amplitude: 1,
    shearFactor,
  };
}

/** Warp amplitude and inverse scale, straight from `sampleNaturalTerrainHeight`. */
const WARP_WAVELENGTH_METERS = 18_000;
const WARP_AMPLITUDE_METERS = 2_400;
/** The geology fabric's rotation, shared by all three rotated channels. */
const FABRIC_COS = 0.819;
const FABRIC_SIN = 0.574;

/**
 * All 43 lattices, in the order the WGSL indexes them. The base offsets below
 * are compiled into the emitted source, so a reordering here cannot silently
 * desynchronise the shader from the uniform builder.
 */
export const TERRAIN_KERNEL_LATTICES: readonly TerrainKernelLattice[] = Object.freeze([
  terrainKernelBareLattice("warpX", "world", 101, WARP_WAVELENGTH_METERS, WARP_WAVELENGTH_METERS,
    WARP_WAVELENGTH_METERS),
  terrainKernelBareLattice("warpZ", "world", 102, WARP_WAVELENGTH_METERS, WARP_WAVELENGTH_METERS,
    WARP_WAVELENGTH_METERS, 19.4, -7.7),
  ...terrainKernelFbmRun("continental", "warped", 110, 4, 8_600, 2.01, 0.52),
  ...terrainKernelFbmRun("rolling", "warped", 120, 5, 1_650, 2, 0.48),
  ...terrainKernelFbmRun("fine", "world", 121, 3, 310, 2.04, 0.46),
  ...terrainKernelFbmRun("mountainField", "warped", 130, 3, 13_500, 2, 0.55),
  ...ridgedRun("ridges", "warped", 131, 5, 2_550),
  ...ridgedRun("localRidges", "warped", 132, 4, 1_050),
  terrainKernelBareLattice("groundNoise", "warped", 141, 105, 105, 105),
  terrainKernelBareLattice("soilUndulation", "warped", 144, 43, 43, 43),
  ...ridgedRun("fractureRidges", "rotated", 142, 3, 390, 980),
  terrainKernelBareLattice("fractureVariation", "rotated", 143, 155, 240, 155),
  ...ridgedRun("talusRidges", "rotated", 145, 2, 120, 280),
  // ——— `4-6`: the climate chain (D5 moved it here from `4-1`) ———
  //
  // Unwarped, like `fine`: moisture and climate are geographic fields, not
  // terrain-following ones. They ride the same lattice table as the height
  // chain so the split-origin machinery is shared rather than duplicated —
  // which is also what lets one page uniform serve both bakes.
  ...terrainKernelFbmRun("moistureBroad", "world", 201, 4, 5_200, 2, 0.52),
  terrainKernelBareLattice("moistureLocal", "world", 202, 850, 850, 850),
  // NOTE: the rain-shadow channel's coordinates are (x + z·0.42, z − x·0.42),
  // a shear rather than the geology fabric's rotation. Its split origin is
  // built for the SHEARED frame by the uniform builder's `shear` field.
  terrainKernelBareLattice("moistureRainShadow", "sheared", 203, 18_000, 9_500, 9_500),
  ...terrainKernelFbmRun("climate", "world", 211, 3, 11_000, 2, 0.5),
]);

/** Base indices the emitted WGSL uses; derived so the two cannot disagree. */
function latticeBase(name: string): number {
  const index = TERRAIN_KERNEL_LATTICES.findIndex((lattice) => lattice.name.startsWith(name));
  if (index < 0) throw new Error(`Terrain kernel has no lattice named ${name}`);
  return index;
}

export const TERRAIN_KERNEL_LATTICE_COUNT = TERRAIN_KERNEL_LATTICES.length;

// ---------------------------------------------------------------------------
// The page uniform
// ---------------------------------------------------------------------------

/**
 * Float32 slots the page buffer holds before the seed table. Laid out so the
 * `vec4f` arrays stay 16-byte aligned in the storage address space.
 */
const KEPT_FLOATS = 4;
/** Padded to a multiple of four so the buffer stays 16-byte sized. */
function seedFloatsFor(latticeCount: number): number {
  return Math.ceil(latticeCount / 4) * 4;
}
function seedOffsetFloatsFor(latticeCount: number): number {
  return latticeCount * 8 + KEPT_FLOATS;
}
const SEED_OFFSET_FLOATS = seedOffsetFloatsFor(TERRAIN_KERNEL_LATTICE_COUNT);
const SEED_FLOATS = seedFloatsFor(TERRAIN_KERNEL_LATTICE_COUNT);
export const TERRAIN_KERNEL_PAGE_FLOATS = SEED_OFFSET_FLOATS + SEED_FLOATS;
export const TERRAIN_KERNEL_PAGE_BYTES = TERRAIN_KERNEL_PAGE_FLOATS * 4;

/**
 * `6-8`: the page-uniform size when a consumer APPENDS lattices of its own.
 *
 * The vegetation density field is a transliteration on the same split-origin
 * machinery, and its docblock always said the caller "appends these to the
 * terrain kernel's own lattice table and passes the base index". This is that
 * mechanism, arriving with its first consumer. Extra lattices land strictly
 * after index `TERRAIN_KERNEL_LATTICE_COUNT`, so every existing consumer's
 * buffer, struct and byte layout are untouched — `extraLatticeCount = 0`
 * returns exactly `TERRAIN_KERNEL_PAGE_BYTES`.
 */
export function terrainKernelPageBytes(extraLatticeCount = 0): number {
  const count = TERRAIN_KERNEL_LATTICE_COUNT + Math.max(0, extraLatticeCount);
  return (seedOffsetFloatsFor(count) + seedFloatsFor(count)) * 4;
}

const HALF_WRAP_PERIOD = NOISE_LATTICE_WRAP_PERIOD_CELLS / 2;

/**
 * `wrapLatticeCoordinate` from `noise.ts`, in f64, applied to a hoisted
 * origin. Ported verbatim: `Math.round(v)` is `floor(v + 0.5)`, because JS
 * rounds halves toward +∞ rather than away from zero.
 */
function wrapOriginCells(value: number): number {
  const periods = Math.floor(value / NOISE_LATTICE_WRAP_PERIOD_CELLS + 0.5);
  return periods === 0 ? value : value - periods * NOISE_LATTICE_WRAP_PERIOD_CELLS;
}

/** `octaveBandWeight` from `noise.ts` — hoisted, so the fade is a page constant. */
function bandWeight(wavelengthMeters: number, filterWidthMeters: number): number {
  if (filterWidthMeters <= 0) return 1;
  return smoothstep(2 * filterWidthMeters, 3.2 * filterWidthMeters, wavelengthMeters);
}

export interface TerrainKernelPageInput {
  readonly seedHash: number;
  /**
   * The seed the APPENDED lattices are keyed on, when it is not the terrain
   * seed. Omission reads `seedHash`, which is byte-identical.
   *
   * **This exists because a world has TWO seeds and they are not the same
   * number.** `createWorld`'s guaranteed-airport search re-seeds the terrain
   * (`world.seedHash = region.seedHash`) while every plant in the world is
   * placed from `hashSeed(String(world.seed))` — `world.sourceSeedHash` —
   * which `FlightRenderer` states explicitly where it builds
   * `GroundCoverSystem`: "the field and the cards must key the SAME
   * realisation or the handoff at the field radius swaps species". A consumer
   * that appends ANOTHER authority's lattices to this uniform is appending
   * that authority's seed with them; keying them on the terrain seed bakes a
   * different world's answer into a terrain channel, which is exactly the
   * defect `6-8`'s canopy-closure channel shipped with.
   */
  readonly extraSeedHash?: number;
  /** Page origin in world metres. Held in f64 here and never sent to the GPU. */
  readonly originX: number;
  readonly originZ: number;
  /** The page's band-limit half-width; 0 at L0, by construction (`4-0`). */
  readonly filterWidthMeters: number;
}

/**
 * Build one page's kernel uniform: one split origin, one
 * scale/weight/amplitude row and one pre-mixed seed per lattice, plus three
 * variance-kept scalars. `6-8` lets a consumer APPEND lattices of its own
 * (the vegetation density field's eleven); passing none is byte-identical.
 *
 * The seeds are pre-mixed on purpose. `valueNoise2D` calls
 * `mixSeed(seedHash, 0)` once per evaluation and hashes four corners with the
 * result; the mix is a PAGE constant, so hoisting it removes one integer
 * hash chain per lattice per texel and cannot change the answer (`mixSeed` is exact
 * integer arithmetic on both sides — criterion 1 tests it directly).
 */
export function buildTerrainKernelPageUniform(
  input: TerrainKernelPageInput,
  extraLattices: readonly TerrainKernelLattice[] = [],
): ArrayBuffer {
  const lattices = extraLattices.length === 0
    ? TERRAIN_KERNEL_LATTICES
    : [...TERRAIN_KERNEL_LATTICES, ...extraLattices];
  const originFloats = lattices.length * 4;
  const seedOffsetFloats = seedOffsetFloatsFor(lattices.length);
  const seedFloats = seedFloatsFor(lattices.length);
  const buffer = new ArrayBuffer((seedOffsetFloats + seedFloats) * 4);
  const floats = new Float32Array(buffer);
  const seeds = new Uint32Array(buffer, seedOffsetFloats * 4, seedFloats);

  const rotatedOriginX = input.originX * FABRIC_COS + input.originZ * FABRIC_SIN;
  const rotatedOriginZ = -input.originX * FABRIC_SIN + input.originZ * FABRIC_COS;

  lattices.forEach((lattice, index) => {
    let sourceX = input.originX;
    let sourceZ = input.originZ;
    if (lattice.space === "rotated") {
      sourceX = rotatedOriginX;
      sourceZ = rotatedOriginZ;
    } else if (lattice.space === "sheared") {
      const shear = lattice.shearFactor ?? DEFAULT_LATTICE_SHEAR;
      sourceX = input.originX + input.originZ * shear;
      sourceZ = input.originZ - input.originX * shear;
    }
    // Everything above this line is f64. Only the SPLIT crosses to f32.
    const originU = wrapOriginCells(sourceX / lattice.divisorX + lattice.offsetX);
    const originV = wrapOriginCells(sourceZ / lattice.divisorZ + lattice.offsetZ);
    const cellU = Math.floor(originU);
    const cellV = Math.floor(originV);
    floats[index * 4] = cellU;
    floats[index * 4 + 1] = originU - cellU;
    floats[index * 4 + 2] = cellV;
    floats[index * 4 + 3] = originV - cellV;

    const scaleBase = originFloats + index * 4;
    floats[scaleBase] = 1 / lattice.divisorX;
    floats[scaleBase + 1] = 1 / lattice.divisorZ;
    floats[scaleBase + 2] = bandWeight(
      lattice.wavelengthMeters,
      lattice.filterWidthMetersOverride ?? input.filterWidthMeters,
    );
    floats[scaleBase + 3] = lattice.amplitude;

    // Appended lattices belong to whichever authority supplied them, so they
    // carry that authority's seed. Absent an override this is `seedHash` for
    // every index and the buffer is byte-identical.
    const latticeSeedHash = index < TERRAIN_KERNEL_LATTICE_COUNT
      ? input.seedHash
      : input.extraSeedHash ?? input.seedHash;
    const channelSeed = mixSeed(latticeSeedHash, lattice.channel);
    const octaveSeed = lattice.octaveChannel === null
      ? channelSeed
      : mixSeed(channelSeed, lattice.octaveChannel);
    seeds[index] = mixSeed(octaveSeed, 0) >>> 0;
  });

  const keptBase = originFloats * 2;
  floats[keptBase] = ridgedChannelVarianceKept(5, 2_550, input.filterWidthMeters);
  floats[keptBase + 1] = ridgedChannelVarianceKept(4, 1_050, input.filterWidthMeters);
  floats[keptBase + 2] = ridgedChannelVarianceKept(3, 390, input.filterWidthMeters);
  floats[keptBase + 3] = input.filterWidthMeters;
  return buffer;
}

// ---------------------------------------------------------------------------
// The emitted WGSL
// ---------------------------------------------------------------------------

const C = TERRAIN_KERNEL_CONSTANTS;

/** Emit a float literal WGSL accepts and a test can find verbatim. */
function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * The include. It declares NO bindings: the consumer declares
 * its page binding through `terrainKernelPageBindingWgsl` and includes this
 * text, the same substitution pattern the PBR plugin performs.
 */
/**
 * `6-9`: the three scalar helpers, hoisted out of the kernel body so a
 * consumer that composes a TRANSLITERATED law without the rest of the kernel
 * gets the same functions rather than a second copy of them.
 *
 * `noise.ts`'s `smoothstep` guards `low == high` and the WGSL builtin does
 * not, which is exactly the kind of difference that produces a shader whose
 * arithmetic is *nearly* the TypeScript's. There must be one text. The
 * ground-cover placement compute (`6-9`) composes this plus
 * `VEGETATION_GROUND_COVER_LAW_WGSL` and nothing else — no page uniform, no
 * lattice table, no hash layer — because the archetype mix is a pure function
 * of five driver scalars.
 */
export const TERRAIN_KERNEL_SCALAR_WGSL = /* wgsl */ `
fn kSaturate(value: f32) -> f32 {
  return min(1.0, max(0.0, value));
}

fn kClamp(value: f32, low: f32, high: f32) -> f32 {
  return min(high, max(low, value));
}

fn kSmoothstep(low: f32, high: f32, value: f32) -> f32 {
  // NOT smoothstep(): noise.ts guards low == high, the builtin does not.
  if (low == high) {
    if (value < low) { return 0.0; }
    return 1.0;
  }
  let t = kSaturate((value - low) / (high - low));
  return t * t * (3.0 - 2.0 * t);
}
`;

export const TERRAIN_KERNEL_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Terrain height kernel — TRANSLITERATION of src/world/{seed,noise,geology,
// terrain}.ts. Generated by src/render/webgpu/terrain/TerrainKernel.ts; every
// expectation constant below is injected from that TypeScript, never retyped.
//
// Requires, at the consumer's chosen group/binding:
//   terrainKernelPageBindingWgsl(group, binding), prepended verbatim.
//
// Pages are addressed as an ARRAY selected by kPageIndex, not as one bound
// page. Babylon records every pass of a frame into ONE command encoder and
// submits once, so a per-dispatch writeBuffer between dispatches lands
// before any of them executes and every dispatch reads the last write —
// the same hazard §4 D11 documents for per-cascade thin-instance buffers.
// Batching the pages into one buffer is what makes a multi-page dispatch
// correct rather than plausible.
// ---------------------------------------------------------------------------

/** Which page of the bound batch the following calls resolve against. */
var<private> kPageIndex: u32 = 0u;

fn kSelectPage(index: u32) {
  kPageIndex = index;
}

const K_WRAP_PERIOD: i32 = ${NOISE_LATTICE_WRAP_PERIOD_CELLS};
const K_HALF_WRAP_PERIOD: i32 = ${HALF_WRAP_PERIOD};
const K_UNIT_24BIT_SCALE: f32 = ${1 / 16_777_216};
const K_RIDGED_MEAN: f32 = ${wgslFloat(C.RIDGED_OCTAVE_BAND_LIMIT_MEAN)};
const K_RIDGES_POW_212_MEAN: f32 = ${wgslFloat(C.RIDGES_POW_212_MEAN)};
const K_RIDGES_POW_158_MEAN: f32 = ${wgslFloat(C.RIDGES_POW_158_MEAN)};
const K_RIDGES_INVERSE_POW_31_MEAN: f32 = ${wgslFloat(C.RIDGES_INVERSE_POW_31_MEAN)};
const K_RIDGES_SMOOTH_42_82_MEAN: f32 = ${wgslFloat(C.RIDGES_SMOOTH_42_82_MEAN)};
const K_LOCAL_RIDGES_KNOLL_MEAN: f32 = ${wgslFloat(C.LOCAL_RIDGES_KNOLL_MEAN)};
const K_FRACTURE_EXPOSURE_MEAN: f32 = ${wgslFloat(C.FRACTURE_EXPOSURE_MEAN)};
const K_FRACTURE_RAVINE_MEAN: f32 = ${wgslFloat(C.FRACTURE_RAVINE_MEAN)};
const K_TALUS_RIDGES_MEAN: f32 = ${wgslFloat(C.TALUS_RIDGES_MEAN)};
const K_MIN_TERRAIN_HEIGHT: f32 = ${wgslFloat(C.MIN_TERRAIN_HEIGHT)};
const K_MAX_TERRAIN_HEIGHT: f32 = ${wgslFloat(C.MAX_TERRAIN_HEIGHT)};
const K_FABRIC_COS: f32 = ${wgslFloat(FABRIC_COS)};
const K_FABRIC_SIN: f32 = ${wgslFloat(FABRIC_SIN)};
const K_WARP_AMPLITUDE: f32 = ${wgslFloat(WARP_AMPLITUDE_METERS)};

// --- rule 2: hand-written, because the builtins round differently ----------

fn kLerp(start: f32, end: f32, amount: f32) -> f32 {
  // NOT mix(): WGSL specifies mix as a*(1-t) + b*t, noise.ts is a + (b-a)*t.
  return start + (end - start) * amount;
}

${TERRAIN_KERNEL_SCALAR_WGSL}
fn kRound(value: f32) -> f32 {
  // NOT round(): Math.round is round-half-toward-+inf, WGSL round is
  // round-half-to-even.
  return floor(value + 0.5);
}

fn kFade(value: f32) -> f32 {
  return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

// --- the hash layer: bit-exact with seed.ts by construction ----------------

fn kAvalanche(value: u32) -> u32 {
  var hash = value;
  hash = hash ^ (hash >> 16u);
  hash = hash * 0x7feb352du;
  hash = hash ^ (hash >> 15u);
  hash = hash * 0x846ca68bu;
  hash = hash ^ (hash >> 16u);
  return hash;
}

fn kMixSeed(seedHash: u32, channel: i32) -> u32 {
  return kAvalanche(seedHash ^ (bitcast<u32>(channel) * 0x9e3779b1u));
}

fn kHashLatticeCoordinates(mixedHash: u32, x: i32, z: i32) -> u32 {
  let hash = kAvalanche(mixedHash ^ (bitcast<u32>(x) * 0x8da6b343u));
  return kAvalanche(hash ^ (bitcast<u32>(z) * 0xd8163841u));
}

fn kUnitFloatFromHash(hash: u32) -> f32 {
  // 24 bits: (hash >>> 8) / 2^24 is exactly representable in f32, which is
  // why seed.ts keeps the quotient at 24 bits (0-4).
  return f32(hash >> 8u) * K_UNIT_24BIT_SCALE;
}

fn kLatticeValue(mixedHash: u32, x: i32, z: i32) -> f32 {
  return kUnitFloatFromHash(kHashLatticeCoordinates(mixedHash, x, z)) * 2.0 - 1.0;
}

// --- rule 5: wrapLatticeCoordinate/wrapLatticeIndex, verbatim --------------

fn kWrapLatticeIndex(index: i32) -> i32 {
  if (index >= K_HALF_WRAP_PERIOD) { return index - K_WRAP_PERIOD; }
  return index;
}

/**
 * The wrap applied to a CELL index rather than a coordinate. wrap(v) subtracts
 * an integer multiple of the period, and the period is an integer, so
 * floor(wrap(v)) == wrapCell(floor(v)) everywhere except the exact seam
 * v == -P/2 — a measure-zero point at |x| ~ 2.8e6 m, far outside the
 * supported world radius.
 */
fn kWrapCell(cell: i32) -> i32 {
  if (cell >= K_HALF_WRAP_PERIOD) { return cell - K_WRAP_PERIOD; }
  if (cell < -K_HALF_WRAP_PERIOD) { return cell + K_WRAP_PERIOD; }
  return cell;
}

// --- rule 1: split-origin value noise --------------------------------------

fn kValueNoiseSplit(mixedHash: u32, cellX: i32, sx: f32, cellZ: i32, sz: f32) -> f32 {
  let fx = floor(sx);
  let fz = floor(sz);
  let tx = kFade(sx - fx);
  let tz = kFade(sz - fz);
  let x0 = kWrapCell(cellX + i32(fx));
  let z0 = kWrapCell(cellZ + i32(fz));
  let x1 = kWrapLatticeIndex(x0 + 1);
  let z1 = kWrapLatticeIndex(z0 + 1);
  let a = kLerp(kLatticeValue(mixedHash, x0, z0), kLatticeValue(mixedHash, x1, z0), tx);
  let b = kLerp(kLatticeValue(mixedHash, x0, z1), kLatticeValue(mixedHash, x1, z1), tx);
  return kLerp(a, b, tz);
}

/** One lattice, addressed by index into the page's hoisted tables. */
fn kOctaveNoise(index: u32, localX: f32, localZ: f32) -> f32 {
  let origin = terrainKernelPages[kPageIndex].latticeOrigin[index];
  let scale = terrainKernelPages[kPageIndex].latticeScale[index];
  return kValueNoiseSplit(
    terrainKernelPages[kPageIndex].seeds[index],
    i32(origin.x),
    origin.y + localX * scale.x,
    i32(origin.z),
    origin.w + localZ * scale.y,
  );
}

/** filteredValueNoise2D: the weight is hoisted, so width 0 multiplies by 1.0. */
fn kFilteredNoise(index: u32, localX: f32, localZ: f32) -> f32 {
  let weight = terrainKernelPages[kPageIndex].latticeScale[index].z;
  if (weight <= 0.0) { return 0.0; }
  return kOctaveNoise(index, localX, localZ) * weight;
}

fn kFbm(first: u32, count: u32, localX: f32, localZ: f32) -> f32 {
  var sum = 0.0;
  var amplitudeSum = 0.0;
  for (var octave = 0u; octave < count; octave = octave + 1u) {
    let row = terrainKernelPages[kPageIndex].latticeScale[first + octave];
    if (row.z > 0.0) {
      sum = sum + kOctaveNoise(first + octave, localX, localZ) * row.w * row.z;
    }
    amplitudeSum = amplitudeSum + row.w;
  }
  if (amplitudeSum > 0.0) { return sum / amplitudeSum; }
  return 0.0;
}

fn kRidgedFbm(first: u32, count: u32, localX: f32, localZ: f32) -> f32 {
  var sum = 0.0;
  var amplitudeSum = 0.0;
  for (var octave = 0u; octave < count; octave = octave + 1u) {
    let row = terrainKernelPages[kPageIndex].latticeScale[first + octave];
    let weight = row.z;
    let amplitude = row.w;
    if (weight >= 1.0) {
      let ridge = 1.0 - abs(kOctaveNoise(first + octave, localX, localZ));
      sum = sum + ridge * ridge * amplitude;
    } else if (weight > 0.0) {
      let ridge = 1.0 - abs(kOctaveNoise(first + octave, localX, localZ));
      let banded = K_RIDGED_MEAN + (ridge * ridge - K_RIDGED_MEAN) * weight;
      sum = sum + banded * amplitude;
    } else {
      sum = sum + K_RIDGED_MEAN * amplitude;
    }
    amplitudeSum = amplitudeSum + amplitude;
  }
  if (amplitudeSum > 0.0) { return kSaturate(sum / amplitudeSum); }
  return 0.0;
}

fn kBlendTowardExpectation(value: f32, expectation: f32, varianceKept: f32) -> f32 {
  if (varianceKept >= 1.0) { return value; }
  if (varianceKept <= 0.0) { return expectation; }
  return expectation + (value - expectation) * varianceKept;
}

// --- sampleGeologicalRelief ------------------------------------------------

fn terrainGeologicalRelief(
  gx: f32,
  gz: f32,
  land: f32,
  foothillRegion: f32,
  mountainRegion: f32,
) -> f32 {
  // Rule 6: the only genuine f32/f64 cliff in the chain, ported verbatim.
  // Bounded at ~10 mm because every returned term is proportional to land.
  if (land <= 0.0001) { return 0.0; }

  let groundNoise = kFilteredNoise(${latticeBase("groundNoise")}u, gx, gz);
  let groundRoughness =
    groundNoise * land * (1.7 + foothillRegion * 7.5 + mountainRegion * 5.5);

  let soilUndulation = kFilteredNoise(${latticeBase("soilUndulation")}u, gx, gz);
  let smallRelief =
    soilUndulation * land * (0.7 + foothillRegion * 1.8 + mountainRegion * 1.2);

  let rotatedX = gx * K_FABRIC_COS + gz * K_FABRIC_SIN;
  let rotatedZ = -gx * K_FABRIC_SIN + gz * K_FABRIC_COS;

  let fractureRidges = kRidgedFbm(${latticeBase("fractureRidges")}u, 3u, rotatedX, rotatedZ);
  let fractureVariation = kFilteredNoise(${latticeBase("fractureVariation")}u, rotatedX, rotatedZ);
  let fractureKept = terrainKernelPages[kPageIndex].kept.z;
  let exposure = kSmoothstep(0.49, 0.84, fractureRidges);
  let upliftMask = foothillRegion * 0.52 + mountainRegion * 0.78;
  let outcropLift = kBlendTowardExpectation(
    land * upliftMask * exposure * (17.0 + mountainRegion * 66.0)
      * (0.82 + fractureVariation * 0.18),
    land * upliftMask * K_FRACTURE_EXPOSURE_MEAN * (17.0 + mountainRegion * 66.0),
    fractureKept,
  );

  let ravineSignal = kBlendTowardExpectation(
    pow(max(0.0, 1.0 - fractureRidges), 3.2),
    K_FRACTURE_RAVINE_MEAN,
    fractureKept,
  );
  let ravineCarve = land * (foothillRegion * 0.32 + mountainRegion * 0.7)
    * ravineSignal * (9.0 + mountainRegion * 48.0);

  let talusRidges = kRidgedFbm(${latticeBase("talusRidges")}u, 2u, rotatedX, rotatedZ);
  let talusMeanRemoved = (talusRidges - K_TALUS_RIDGES_MEAN) * land
    * (foothillRegion * 2.8 + mountainRegion * 7.6);

  return groundRoughness + smallRelief + outcropLift - ravineCarve + talusMeanRemoved;
}

// --- sampleNaturalTerrainHeight --------------------------------------------

/**
 * The natural (pre-airport) terrain height at a point given as an offset in
 * metres from the page origin the uniform was built for. The absolute
 * coordinate never reaches the GPU — that is the whole of rule 1.
 */
fn terrainMoisture(localX: f32, localZ: f32) -> f32 {
  let broad = kFbm(${latticeBase("moistureBroad")}u, 4u, localX, localZ);
  let local = kFilteredNoise(${latticeBase("moistureLocal")}u, localX, localZ);
  let rainShadow = kFilteredNoise(${latticeBase("moistureRainShadow")}u, localX, localZ);
  return kSaturate(0.5 + broad * 0.37 + local * 0.13 + rainShadow * 0.17);
}

fn terrainClimate(localX: f32, localZ: f32) -> f32 {
  return kFbm(${latticeBase("climate")}u, 3u, localX, localZ);
}

/** terrainTemperatureFromClimate: exact per-point cooling above sea level. */
fn terrainTemperatureFromClimate(climate: f32, heightAboveSeaLevel: f32) -> f32 {
  return kSaturate(0.66 + climate * 0.2 - max(0.0, heightAboveSeaLevel) / 2450.0);
}

fn terrainNaturalHeight(localX: f32, localZ: f32) -> f32 {
  let warpX = kFilteredNoise(${latticeBase("warpX")}u, localX, localZ) * K_WARP_AMPLITUDE;
  let warpZ = kFilteredNoise(${latticeBase("warpZ")}u, localX, localZ) * K_WARP_AMPLITUDE;
  let wx = localX + warpX;
  let wz = localZ + warpZ;

  let continental = kFbm(${latticeBase("continental")}u, 4u, wx, wz) * 0.5 + 0.5;
  let land = kSmoothstep(0.38, 0.57, continental);
  let continentalShelf = kLerp(-105.0, 135.0, kSmoothstep(0.2, 0.8, continental));

  let rolling = kFbm(${latticeBase("rolling")}u, 5u, wx, wz);
  let fine = kFbm(${latticeBase("fine")}u, 3u, localX, localZ);

  let mountainField = kFbm(${latticeBase("mountainField")}u, 3u, wx, wz) * 0.5 + 0.5;
  let foothillRegion = kSmoothstep(0.34, 0.7, mountainField);
  let mountainRegion = kSmoothstep(0.47, 0.76, mountainField);
  let ridges = kRidgedFbm(${latticeBase("ridges")}u, 5u, wx, wz);
  let localRidges = kRidgedFbm(${latticeBase("localRidges")}u, 4u, wx, wz);
  let ridgesKept = terrainKernelPages[kPageIndex].kept.x;
  let localRidgesKept = terrainKernelPages[kPageIndex].kept.y;

  let foothillHeight = land * foothillRegion
    * kBlendTowardExpectation(
        pow(max(0.0, ridges), 2.12), K_RIDGES_POW_212_MEAN, ridgesKept)
    * 285.0;
  let mountainHeight = land * mountainRegion
    * kBlendTowardExpectation(
        pow(max(0.0, ridges), 1.58), K_RIDGES_POW_158_MEAN, ridgesKept)
    * 1390.0;

  let rockyKnolls = land * (0.34 + foothillRegion * 0.66)
    * kBlendTowardExpectation(
        pow(max(0.0, kSmoothstep(0.3, 0.86, localRidges)), 2.25),
        K_LOCAL_RIDGES_KNOLL_MEAN,
        localRidgesKept)
    * (72.0 + foothillRegion * 115.0);
  let cragDetail = land * mountainRegion
    * kBlendTowardExpectation(
        kSmoothstep(0.42, 0.82, ridges), K_RIDGES_SMOOTH_42_82_MEAN, ridgesKept)
    * (localRidges - 0.48) * 360.0;
  let valleyCarve = land * foothillRegion
    * kBlendTowardExpectation(
        pow(max(0.0, 1.0 - ridges), 3.1), K_RIDGES_INVERSE_POW_31_MEAN, ridgesKept)
    * (55.0 + mountainRegion * 105.0);

  let geologicalRelief = terrainGeologicalRelief(wx, wz, land, foothillRegion, mountainRegion);

  let hillStrength = land * (34.0 + 96.0 * (1.0 - mountainRegion * 0.55));
  let height = continentalShelf
    + rolling * hillStrength
    + fine * (5.0 + land * 12.0)
    + rockyKnolls
    + foothillHeight
    + mountainHeight
    + cragDetail
    - valleyCarve
    + geologicalRelief;
  return kClamp(height, K_MIN_TERRAIN_HEIGHT, K_MAX_TERRAIN_HEIGHT);
}
`;

/**
 * The struct and binding a consumer prepends to the include. Declared here so
 * the struct layout and `buildTerrainKernelPageUniform`'s byte layout have one
 * definition between them.
 */
export function terrainKernelPageBindingWgsl(
  group: number,
  binding: number,
  extraLatticeCount = 0,
): string {
  const count = TERRAIN_KERNEL_LATTICE_COUNT + Math.max(0, extraLatticeCount);
  return /* wgsl */ `
struct TerrainKernelPage {
  latticeOrigin: array<vec4f, ${count}>,
  latticeScale: array<vec4f, ${count}>,
  kept: vec4f,
  seeds: array<u32, ${seedFloatsFor(count)}>,
};
@group(${group}) @binding(${binding}) var<storage, read> terrainKernelPages: array<TerrainKernelPage>;
`;
}
