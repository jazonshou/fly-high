import {
  NOISE_LATTICE_WRAP_PERIOD_CELLS,
  smoothstep,
} from "@/src/world/noise";
import {
  TERRAIN_PLATE_BOUNDARY_WIDTH_CELLS,
  TERRAIN_PLATE_CELL_METERS,
  TERRAIN_PLATE_CLOSING_SCALE,
  TERRAIN_PLATE_HASH_16BIT_SCALE,
  TERRAIN_PLATE_JITTER_CELLS,
  TERRAIN_PLATE_MOTION_CHANNEL,
  TERRAIN_PLATE_SITE_CHANNEL,
  TERRAIN_PLATE_SITE_PLATEAU_CELLS,
  TERRAIN_PLATE_SITE_REACH_CELLS,
} from "@/src/world/geology";
import {
  TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS,
  TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS,
} from "@/src/world/terrain";
import { mixSeed } from "@/src/world/seed";
import { TERRAIN_KERNEL_WGSL, terrainKernelPageBindingWgsl } from "./TerrainKernel";

/** Injected, never retyped (rule 0-4): a wrong digit here is a silent world. */
function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * The WGSL uplift/geology kernel (`W-1b`, Gate W) — the macro-erosion INPUT
 * samplers.
 *
 * INVARIANT (inherited from TerrainKernel.ts): `src/world/terrain.ts` owns the
 * shape; this file is a TRANSLITERATION of exactly three of its functions —
 * `sampleTerrainUpliftHeight`, `sampleTerrainEvolutionGeology` and (`W-4`)
 * `sampleTerrainFineBandRelief` — plus `geology.ts`'s `sampleTerrainPlates`,
 * which the first of those calls. Never a second implementation. Per PHASE_6 §11 D-3 the parity contract is
 * tolerance-tier against the CPU oracle (frozen measured criteria below) plus
 * GPU-vs-GPU bit determinism; physics never consumes this kernel.
 *
 * PLACEMENT DECISION: a sibling module rather than an extension of
 * TERRAIN_KERNEL_WGSL's lattice table, because the uplift authority's shape is
 * mostly height-kernel-*disjoint* (its own channels 150–159, no
 * blendTowardExpectation, and four lattices in a per-sample ROTATING fabric
 * frame the split-origin machinery cannot hoist). What IS shared — the hash
 * layer, kLerp/kSmoothstep/kFade, the wrap rules and split-origin value noise
 * — is reused by *including* `TERRAIN_KERNEL_WGSL` verbatim ahead of this
 * module's text (Tint prunes the height-kernel-specific functions), so no
 * numeric primitive exists twice and TerrainKernel.ts needed no edits at all.
 *
 * `W-4` added a THIRD numeric class to the two below: the plate
 * tessellation's integer lattice. It has no value-noise row at all — sites,
 * motions and speeds are raw hashes of a 96 km cell index — so it needs no
 * origin/scale row, only two pre-mixed seeds appended to the seed table. It
 * carries its own split origin instead (positions are held relative to the
 * sample's base cell), which is what lets an f32 evaluation of a 96 km lattice
 * agree with the f64 original at wrap radius.
 *
 * Two lattice classes, one page uniform:
 *
 * 1. **Split-origin rows** (world/warped frames): identical machinery to the
 *    height kernel — the CPU computes each lattice's wrapped origin in f64 and
 *    the GPU only ever adds small local offsets (rule 1 of TerrainKernel.ts).
 * 2. **Fabric rows** (rangeRidges, inheritedRidges, and the fine-band
 *    sampler's ridges24/ridges9): their
 *    coordinate frame rotates with `terrainEvolutionFabricDoubleAngle`, a
 *    smooth per-sample field, so no per-page f64 origin exists to hoist. The
 *    GPU reconstructs the ABSOLUTE warped coordinate (page origin is stored
 *    f32 in `originMeta` — parity probes and the production layout use
 *    512 m-lattice origins, which are exact in f32), rotates it, and wraps
 *    in-shader with the verbatim `wrapLatticeCoordinate` reduction. This is
 *    the one deliberately f32-lossy leg: at the production macro layout
 *    (|fabric| ≲ 3.8e5 m, filter width 512 m fades every octave finer than
 *    ~1.4 km) the induced height error is sub-millimetre in the MEAN with
 *    isolated ~1 m maxima at near-zeros of the fabric direction field (the
 *    conditioning mechanism the criteria docblock verifies); at wrap-radius
 *    probes with filter width 0 it is bounded by the measured criteria below,
 *    not by the height kernel's split-origin bounds. NO sin-fract hashes
 *    anywhere — the integer lattice hash chain is the included kernel's.
 */

// ---------------------------------------------------------------------------
// Lattice tables — the enumeration the uniform builder and the WGSL index into
// identically. Channels/divisors/offsets are `sampleTerrainUpliftHeight` and
// `sampleTerrainEvolutionGeology` verbatim.
// ---------------------------------------------------------------------------

export interface TerrainUpliftLattice {
  readonly name: string;
  /** `mixSeed(seedHash, channel)` selects the channel. */
  readonly channel: number;
  /** A second `mixSeed` for fbm/ridged octaves; null for a bare lattice. */
  readonly octaveChannel: number | null;
  readonly divisorX: number;
  readonly divisorZ: number;
  /** Lattice-space offsets applied AFTER the division. */
  readonly offsetX: number;
  readonly offsetZ: number;
  /** Wavelength the band-limit fade keys on. */
  readonly wavelengthMeters: number;
  readonly amplitude: number;
}

function bareLattice(
  name: string,
  channel: number,
  divisor: number,
  offsetX = 0,
  offsetZ = 0,
): TerrainUpliftLattice {
  return {
    name,
    channel,
    octaveChannel: null,
    divisorX: divisor,
    divisorZ: divisor,
    offsetX,
    offsetZ,
    wavelengthMeters: divisor,
    amplitude: 1,
  };
}

function fbmRun(
  name: string,
  channel: number,
  octaves: number,
  baseWavelength: number,
  lacunarity: number,
  persistence: number,
): TerrainUpliftLattice[] {
  const run: TerrainUpliftLattice[] = [];
  let frequency = 1;
  let amplitude = 1;
  let wavelength = baseWavelength;
  for (let octave = 0; octave < octaves; octave += 1) {
    run.push({
      name: `${name}[${octave}]`,
      channel,
      // fbm2D keys octaves on `octave + 1`; ridgedFbm2D on `31 + octave`.
      octaveChannel: octave + 1,
      divisorX: baseWavelength / frequency,
      divisorZ: baseWavelength / frequency,
      offsetX: 0,
      offsetZ: 0,
      wavelengthMeters: wavelength,
      amplitude,
    });
    amplitude *= persistence;
    frequency *= lacunarity;
    wavelength /= lacunarity;
  }
  return run;
}

function ridgedRun(
  name: string,
  channel: number,
  octaves: number,
  baseWavelength: number,
  divisorZMeters = baseWavelength,
): TerrainUpliftLattice[] {
  // ridgedFbm2D fixes lacunarity 2.03 and persistence 0.52.
  const run: TerrainUpliftLattice[] = [];
  let frequency = 1;
  let amplitude = 1;
  let wavelength = baseWavelength;
  for (let octave = 0; octave < octaves; octave += 1) {
    run.push({
      name: `${name}[${octave}]`,
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

/**
 * Split-origin rows. Frames: warp/lithology/detail310/jointing and the
 * geology sampler's fabric-direction reads use the WORLD frame; everything
 * else the uplift sampler reads uses the WARPED frame. The two frames share
 * rows because a warp is a *local* offset — the hoisted origin is the page's
 * world origin either way, and the WGSL below passes the right local
 * coordinate per call site.
 */
export const TERRAIN_UPLIFT_KERNEL_LATTICES: readonly TerrainUpliftLattice[] =
  Object.freeze([
    bareLattice("warpX", 101, 18_000),
    bareLattice("warpZ", 102, 18_000, 19.4, -7.7),
    ...fbmRun("continental", 110, 4, 8_600, 2.01, 0.52),
    bareLattice("fabricDirX", 154, 96_000),
    bareLattice("fabricDirZ", 155, 72_000, 17.3, -9.1),
    // W-4 retired channels 150 (ridged plate boundary) and 151 (relative
    // motion): convergence now comes from the Lloyd plate tessellation below,
    // which is an integer-lattice field with no value-noise row at all.
    ...fbmRun("rolling", 120, 5, 1_650, 2, 0.48),
    ...fbmRun("province", 130, 3, 13_500, 2, 0.55),
    bareLattice("lithology", 156, 28_000),
    ...fbmRun("detail310", 121, 3, 310, 2.04, 0.46),
    bareLattice("jointing", 157, 9_500, 4.7, -12.8),
  ]);

/** Fabric-frame rows, evaluated with absolute rotated coordinates in-shader. */
export const TERRAIN_UPLIFT_FABRIC_LATTICES: readonly TerrainUpliftLattice[] =
  Object.freeze([
    ...ridgedRun("rangeRidges", 152, 5, 6_000, 72_000),
    ...ridgedRun("inheritedRidges", 131, 5, 2_550, 8_900),
    ...ridgedRun("ridges24", 158, 2, 24, 96),
    ...ridgedRun("ridges9", 159, 1, 9, 36),
  ]);

export const TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT = TERRAIN_UPLIFT_KERNEL_LATTICES.length;
export const TERRAIN_UPLIFT_FABRIC_LATTICE_COUNT = TERRAIN_UPLIFT_FABRIC_LATTICES.length;

function splitBase(name: string): number {
  const index = TERRAIN_UPLIFT_KERNEL_LATTICES.findIndex((lattice) =>
    lattice.name.startsWith(name),
  );
  if (index < 0) throw new Error(`Uplift kernel has no split lattice named ${name}`);
  return index;
}

function fabricBase(name: string): number {
  const index = TERRAIN_UPLIFT_FABRIC_LATTICES.findIndex((lattice) =>
    lattice.name.startsWith(name),
  );
  if (index < 0) throw new Error(`Uplift kernel has no fabric lattice named ${name}`);
  return index;
}

// ---------------------------------------------------------------------------
// The page uniform
// ---------------------------------------------------------------------------

const ORIGIN_FLOATS = TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT * 4;
const SCALE_FLOATS = TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT * 4;
const FABRIC_FLOATS = TERRAIN_UPLIFT_FABRIC_LATTICE_COUNT * 4;
const META_FLOATS = 4;
const SEED_OFFSET_FLOATS = ORIGIN_FLOATS + SCALE_FLOATS + FABRIC_FLOATS + META_FLOATS;
/**
 * `W-4`: two extra pre-mixed seeds after the lattice rows — the plate model's
 * site and motion channels. They are hoisted like every other seed (the mix is
 * exact integer arithmetic on both sides) rather than mixed in-shader, because
 * the plate field is evaluated once per texel and the mix is page-constant.
 */
const PLATE_SITE_SEED_INDEX =
  TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT + TERRAIN_UPLIFT_FABRIC_LATTICE_COUNT;
const PLATE_MOTION_SEED_INDEX = PLATE_SITE_SEED_INDEX + 1;
const SEED_COUNT = PLATE_MOTION_SEED_INDEX + 1;
/** Padded to a multiple of four so the struct stays 16-byte sized. */
const SEED_FLOATS = Math.ceil(SEED_COUNT / 4) * 4;
export const TERRAIN_UPLIFT_KERNEL_PAGE_FLOATS = SEED_OFFSET_FLOATS + SEED_FLOATS;
export const TERRAIN_UPLIFT_KERNEL_PAGE_BYTES = TERRAIN_UPLIFT_KERNEL_PAGE_FLOATS * 4;

/**
 * `wrapLatticeCoordinate` from noise.ts in f64 (verbatim: `Math.round(v)` is
 * `floor(v + 0.5)` for the halves JS rounds toward +∞). Private in
 * TerrainKernel.ts, restated here against the same source function.
 */
function wrapOriginCells(value: number): number {
  const periods = Math.floor(value / NOISE_LATTICE_WRAP_PERIOD_CELLS + 0.5);
  return periods === 0 ? value : value - periods * NOISE_LATTICE_WRAP_PERIOD_CELLS;
}

/** `octaveBandWeight` from noise.ts — hoisted, so the fade is a page constant. */
function bandWeight(wavelengthMeters: number, filterWidthMeters: number): number {
  if (filterWidthMeters <= 0) return 1;
  return smoothstep(2 * filterWidthMeters, 3.2 * filterWidthMeters, wavelengthMeters);
}

export interface TerrainUpliftKernelPageInput {
  readonly seedHash: number;
  /** Page origin in world metres, held in f64 here. It ALSO crosses to the
   * GPU as f32 (`originMeta`) for the fabric frame — callers use origins on
   * the 512 m page lattice, which f32 represents exactly. */
  readonly originX: number;
  readonly originZ: number;
  readonly filterWidthMeters: number;
}

/**
 * Build one page's uplift-kernel uniform: split origins and scale rows for
 * the hoistable lattices, per-octave scale rows for the fabric lattices, the
 * f32 absolute origin, and every pre-mixed seed (`mixSeed(octaveSeed, 0)` —
 * the same hoist `buildTerrainKernelPageUniform` performs, exact integer
 * arithmetic on both sides).
 */
export function buildTerrainUpliftKernelPageUniform(
  input: TerrainUpliftKernelPageInput,
): ArrayBuffer {
  const buffer = new ArrayBuffer(TERRAIN_UPLIFT_KERNEL_PAGE_BYTES);
  const floats = new Float32Array(buffer);
  const seeds = new Uint32Array(buffer, SEED_OFFSET_FLOATS * 4, SEED_FLOATS);

  TERRAIN_UPLIFT_KERNEL_LATTICES.forEach((lattice, index) => {
    // Everything above the split is f64; only the split crosses to f32.
    const originU = wrapOriginCells(input.originX / lattice.divisorX + lattice.offsetX);
    const originV = wrapOriginCells(input.originZ / lattice.divisorZ + lattice.offsetZ);
    const cellU = Math.floor(originU);
    const cellV = Math.floor(originV);
    floats[index * 4] = cellU;
    floats[index * 4 + 1] = originU - cellU;
    floats[index * 4 + 2] = cellV;
    floats[index * 4 + 3] = originV - cellV;

    const scaleBase = ORIGIN_FLOATS + index * 4;
    floats[scaleBase] = 1 / lattice.divisorX;
    floats[scaleBase + 1] = 1 / lattice.divisorZ;
    floats[scaleBase + 2] = bandWeight(lattice.wavelengthMeters, input.filterWidthMeters);
    floats[scaleBase + 3] = lattice.amplitude;

    const channelSeed = mixSeed(input.seedHash, lattice.channel);
    const octaveSeed = lattice.octaveChannel === null
      ? channelSeed
      : mixSeed(channelSeed, lattice.octaveChannel);
    seeds[index] = mixSeed(octaveSeed, 0) >>> 0;
  });

  TERRAIN_UPLIFT_FABRIC_LATTICES.forEach((lattice, index) => {
    const rowBase = ORIGIN_FLOATS + SCALE_FLOATS + index * 4;
    floats[rowBase] = 1 / lattice.divisorX;
    floats[rowBase + 1] = 1 / lattice.divisorZ;
    floats[rowBase + 2] = bandWeight(lattice.wavelengthMeters, input.filterWidthMeters);
    floats[rowBase + 3] = lattice.amplitude;

    const channelSeed = mixSeed(input.seedHash, lattice.channel);
    const octaveSeed = lattice.octaveChannel === null
      ? channelSeed
      : mixSeed(channelSeed, lattice.octaveChannel);
    seeds[TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT + index] = mixSeed(octaveSeed, 0) >>> 0;
  });

  // The plate channels are hashed directly (no per-octave mix and no
  // `mixSeed(..., 0)` tail): `sampleTerrainPlates` calls
  // `hashLatticeCoordinates(mixSeed(seedHash, channel), ...)`, so the hoisted
  // value is exactly that first mix.
  seeds[PLATE_SITE_SEED_INDEX] = mixSeed(input.seedHash, TERRAIN_PLATE_SITE_CHANNEL) >>> 0;
  seeds[PLATE_MOTION_SEED_INDEX] =
    mixSeed(input.seedHash, TERRAIN_PLATE_MOTION_CHANNEL) >>> 0;

  const metaBase = ORIGIN_FLOATS + SCALE_FLOATS + FABRIC_FLOATS;
  floats[metaBase] = input.originX;
  floats[metaBase + 1] = input.originZ;
  floats[metaBase + 2] = input.filterWidthMeters;
  floats[metaBase + 3] = 0;
  return buffer;
}

// ---------------------------------------------------------------------------
// The emitted WGSL
// ---------------------------------------------------------------------------

/**
 * The struct and binding a consumer prepends to `TERRAIN_UPLIFT_KERNEL_WGSL`.
 * Composition order (all four, verbatim):
 *
 *   terrainKernelPageBindingWgsl(group, deadBinding)   // required to compile;
 *   TERRAIN_KERNEL_WGSL                                // Tint prunes its
 *                                                      // height-kernel users,
 *                                                      // NEVER map/bind it
 *   terrainUpliftKernelPageBindingWgsl(group, binding)
 *   TERRAIN_UPLIFT_KERNEL_WGSL
 *
 * The dead binding is the inverse of the Tint dead-binding trap: because no
 * reachable code reads `terrainKernelPages`, it vanishes from reflection and
 * MUST NOT appear in bindingsMapping or be set on the shader.
 */
export function terrainUpliftKernelPageBindingWgsl(
  group: number,
  binding: number,
): string {
  return /* wgsl */ `
struct TerrainUpliftKernelPage {
  latticeOrigin: array<vec4f, ${TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT}>,
  latticeScale: array<vec4f, ${TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT}>,
  fabricScale: array<vec4f, ${TERRAIN_UPLIFT_FABRIC_LATTICE_COUNT}>,
  /** x,y: absolute page origin (f32); z: filter width; w: pad. */
  originMeta: vec4f,
  seeds: array<u32, ${SEED_FLOATS}>,
};
@group(${group}) @binding(${binding}) var<storage, read> upliftKernelPages: array<TerrainUpliftKernelPage>;
`;
}

/** Convenience composition of the four include blocks in the required order. */
export function composedTerrainUpliftKernelWgsl(
  group: number,
  upliftPagesBinding: number,
  deadHeightKernelBinding: number,
): string {
  return [
    terrainKernelPageBindingWgsl(group, deadHeightKernelBinding),
    TERRAIN_KERNEL_WGSL,
    terrainUpliftKernelPageBindingWgsl(group, upliftPagesBinding),
    TERRAIN_UPLIFT_KERNEL_WGSL,
  ].join("\n");
}

/**
 * The include. Requires `TERRAIN_KERNEL_WGSL` (for the shared hash layer,
 * kLerp/kSmoothstep/kClamp/kSaturate, kValueNoiseSplit, the wrap rules,
 * K_RIDGED_MEAN, K_WARP_AMPLITUDE, the height clamp constants and the shared
 * kPageIndex/kSelectPage page selector) plus both page bindings — see
 * `composedTerrainUpliftKernelWgsl`.
 */
export const TERRAIN_UPLIFT_KERNEL_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Terrain uplift/geology kernel — TRANSLITERATION of
// src/world/terrain.ts's sampleTerrainUpliftHeight and
// sampleTerrainEvolutionGeology. Generated by
// src/render/webgpu/terrain/TerrainUpliftKernel.ts. Shares every numeric
// primitive with TERRAIN_KERNEL_WGSL (prepended) rather than restating it.
// ---------------------------------------------------------------------------

// --- split-origin rows: the height kernel's rule 1, against the uplift table

fn uOctaveNoise(index: u32, localX: f32, localZ: f32) -> f32 {
  let origin = upliftKernelPages[kPageIndex].latticeOrigin[index];
  let scale = upliftKernelPages[kPageIndex].latticeScale[index];
  return kValueNoiseSplit(
    upliftKernelPages[kPageIndex].seeds[index],
    i32(origin.x),
    origin.y + localX * scale.x,
    i32(origin.z),
    origin.w + localZ * scale.y,
  );
}

fn uFilteredNoise(index: u32, localX: f32, localZ: f32) -> f32 {
  let weight = upliftKernelPages[kPageIndex].latticeScale[index].z;
  if (weight <= 0.0) { return 0.0; }
  return uOctaveNoise(index, localX, localZ) * weight;
}

fn uFbm(first: u32, count: u32, localX: f32, localZ: f32) -> f32 {
  var sum = 0.0;
  var amplitudeSum = 0.0;
  for (var octave = 0u; octave < count; octave = octave + 1u) {
    let row = upliftKernelPages[kPageIndex].latticeScale[first + octave];
    if (row.z > 0.0) {
      sum = sum + uOctaveNoise(first + octave, localX, localZ) * row.w * row.z;
    }
    amplitudeSum = amplitudeSum + row.w;
  }
  if (amplitudeSum > 0.0) { return sum / amplitudeSum; }
  return 0.0;
}

// --- fabric rows: absolute rotated coordinates, wrapped in-shader ----------

const U_WRAP_PERIOD_F: f32 = ${NOISE_LATTICE_WRAP_PERIOD_CELLS}.0;
const U_FABRIC_SEED_BASE: u32 = ${TERRAIN_UPLIFT_SPLIT_LATTICE_COUNT}u;

/** wrapLatticeCoordinate, f32: Math.round is kRound (rule 5). */
fn uWrapCoordinate(value: f32) -> f32 {
  let periods = kRound(value / U_WRAP_PERIOD_F);
  if (periods == 0.0) { return value; }
  return value - periods * U_WRAP_PERIOD_F;
}

fn uFabricNoise(seedIndex: u32, u: f32, v: f32) -> f32 {
  return kValueNoiseSplit(
    upliftKernelPages[kPageIndex].seeds[seedIndex],
    0,
    uWrapCoordinate(u),
    0,
    uWrapCoordinate(v),
  );
}

/** ridgedFbm2D over a fabric-frame channel (fabricScale rows). */
fn uFabricRidged(first: u32, count: u32, fabricX: f32, fabricZ: f32) -> f32 {
  var sum = 0.0;
  var amplitudeSum = 0.0;
  for (var octave = 0u; octave < count; octave = octave + 1u) {
    let row = upliftKernelPages[kPageIndex].fabricScale[first + octave];
    let weight = row.z;
    let amplitude = row.w;
    if (weight >= 1.0) {
      let ridge = 1.0 - abs(uFabricNoise(
        U_FABRIC_SEED_BASE + first + octave, fabricX * row.x, fabricZ * row.y));
      sum = sum + ridge * ridge * amplitude;
    } else if (weight > 0.0) {
      let ridge = 1.0 - abs(uFabricNoise(
        U_FABRIC_SEED_BASE + first + octave, fabricX * row.x, fabricZ * row.y));
      let banded = K_RIDGED_MEAN + (ridge * ridge - K_RIDGED_MEAN) * weight;
      sum = sum + banded * amplitude;
    } else {
      // A fully faded octave rests at its expectation without evaluating the
      // lattice at all — which is also what makes the fully-faded fine fabric
      // octaves EXACT at the production filter width.
      sum = sum + K_RIDGED_MEAN * amplitude;
    }
    amplitudeSum = amplitudeSum + amplitude;
  }
  if (amplitudeSum > 0.0) { return kSaturate(sum / amplitudeSum); }
  return 0.0;
}

// --- sampleTerrainPlates (src/world/geology.ts) ----------------------------
//
// TRANSLITERATION of the Lloyd-relaxed plate tessellation. Every position is
// held RELATIVE to the sample's base cell (the plate lattice's own split
// origin), which is what keeps this f32 and the CPU's f64 in agreement at wrap
// radius: absolute cell coordinates would be ~27 with f32 steps of 2e-6 cells,
// and every difference below would lose those bits to cancellation.
// No sin-fract anywhere — sites, motions and speeds are the shared integer
// lattice hash, read as two exactly-representable 16-bit halves.

const U_PLATE_CELL_METERS: f32 = ${wgslFloat(TERRAIN_PLATE_CELL_METERS)};
const U_PLATE_JITTER_CELLS: f32 = ${wgslFloat(TERRAIN_PLATE_JITTER_CELLS)};
const U_PLATE_SITE_PLATEAU: f32 = ${wgslFloat(TERRAIN_PLATE_SITE_PLATEAU_CELLS)};
const U_PLATE_SITE_REACH: f32 = ${wgslFloat(TERRAIN_PLATE_SITE_REACH_CELLS)};
const U_PLATE_BOUNDARY_WIDTH: f32 = ${wgslFloat(TERRAIN_PLATE_BOUNDARY_WIDTH_CELLS)};
const U_PLATE_CLOSING_SCALE: f32 = ${wgslFloat(TERRAIN_PLATE_CLOSING_SCALE)};
const U_PLATE_HASH_16BIT_SCALE: f32 = ${wgslFloat(TERRAIN_PLATE_HASH_16BIT_SCALE)};
const U_PLATE_SITE_SEED: u32 = ${PLATE_SITE_SEED_INDEX}u;
const U_PLATE_MOTION_SEED: u32 = ${PLATE_MOTION_SEED_INDEX}u;

/** Both 16-bit halves of one lattice hash, each centred on zero. */
fn uPlateHashPair(mixedHash: u32, x: i32, z: i32) -> vec2f {
  let hash = kHashLatticeCoordinates(mixedHash, x, z);
  return vec2f(
    f32((hash >> 16u) & 0xffffu) * U_PLATE_HASH_16BIT_SCALE - 0.5,
    f32(hash & 0xffffu) * U_PLATE_HASH_16BIT_SCALE - 0.5,
  );
}

/** Plate convergence at an ABSOLUTE world position. */
fn terrainPlateConvergence(worldX: f32, worldZ: f32) -> f32 {
  let siteHash = upliftKernelPages[kPageIndex].seeds[U_PLATE_SITE_SEED];
  let motionHash = upliftKernelPages[kPageIndex].seeds[U_PLATE_MOTION_SEED];
  let pointX = worldX / U_PLATE_CELL_METERS;
  let pointZ = worldZ / U_PLATE_CELL_METERS;
  let baseX = i32(floor(pointX));
  let baseZ = i32(floor(pointZ));
  let localX = pointX - floor(pointX);
  let localZ = pointZ - floor(pointZ);

  // 1. Raw jitter over the 5x5 block.
  let jitterScale = 2.0 * U_PLATE_JITTER_CELLS;
  var rawJitter: array<vec2f, 25>;
  for (var row = 0; row < 5; row = row + 1) {
    for (var column = 0; column < 5; column = column + 1) {
      rawJitter[row * 5 + column] =
        uPlateHashPair(siteHash, baseX + column - 2, baseZ + row - 2) * jitterScale;
    }
  }

  // 2. One explicit Lloyd step, in closed form: 0.5 * own + 0.5 * mean4.
  var siteX: array<f32, 9>;
  var siteZ: array<f32, 9>;
  var motionX: array<f32, 9>;
  var motionZ: array<f32, 9>;
  var weight: array<f32, 9>;
  var reached: array<i32, 9>;
  var activeCount = 0;
  for (var row = 0; row < 3; row = row + 1) {
    for (var column = 0; column < 3; column = column + 1) {
      let centre = (row + 1) * 5 + column + 1;
      let slot = row * 3 + column;
      let relaxed = vec2f(f32(column) - 1.0 + 0.5, f32(row) - 1.0 + 0.5)
        + rawJitter[centre] * 0.5
        + (rawJitter[centre - 1] + rawJitter[centre + 1]
          + rawJitter[centre - 5] + rawJitter[centre + 5]) * 0.125;
      siteX[slot] = relaxed.x;
      siteZ[slot] = relaxed.y;
      let reach = 1.0 - kSmoothstep(
        U_PLATE_SITE_PLATEAU,
        U_PLATE_SITE_REACH,
        sqrt((relaxed.x - localX) * (relaxed.x - localX)
          + (relaxed.y - localZ) * (relaxed.y - localZ)),
      );
      weight[slot] = reach;
      if (reach <= 0.0) { continue; }
      let motion = uPlateHashPair(motionHash, baseX + column - 1, baseZ + row - 1) * 2.0;
      let divisor = max(1.0, sqrt(motion.x * motion.x + motion.y * motion.y));
      motionX[slot] = motion.x / divisor;
      motionZ[slot] = motion.y / divisor;
      reached[activeCount] = slot;
      activeCount = activeCount + 1;
    }
  }

  // 3. Every pair of reachable plates contributes its own closing rate.
  var convergence = 0.0;
  for (var first = 0; first < activeCount; first = first + 1) {
    let a = reached[first];
    for (var second = first + 1; second < activeCount; second = second + 1) {
      let b = reached[second];
      let spanX = siteX[b] - siteX[a];
      let spanZ = siteZ[b] - siteZ[a];
      let span = sqrt(spanX * spanX + spanZ * spanZ);
      if (span < 1e-6) { continue; }
      let normalX = spanX / span;
      let normalZ = spanZ / span;
      let closing = (motionX[a] - motionX[b]) * normalX + (motionZ[a] - motionZ[b]) * normalZ;
      if (closing <= 0.0) { continue; }
      let offset = (localX - (siteX[a] + siteX[b]) * 0.5) * normalX
        + (localZ - (siteZ[a] + siteZ[b]) * 0.5) * normalZ;
      let belt = 1.0 - kSmoothstep(0.0, U_PLATE_BOUNDARY_WIDTH, abs(offset));
      if (belt <= 0.0) { continue; }
      let contribution = closing * U_PLATE_CLOSING_SCALE * belt * weight[a] * weight[b];
      if (contribution <= 0.0) { continue; }
      convergence = convergence + contribution;
    }
  }
  return kSaturate(convergence);
}

// --- terrainEvolutionFabricDoubleAngle -------------------------------------

/** Local coordinates arrive in the caller's frame (world OR warped). */
fn uFabricDoubleAngle(localX: f32, localZ: f32) -> f32 {
  let directionX = uFilteredNoise(${splitBase("fabricDirX")}u, localX, localZ);
  let directionZ = uFilteredNoise(${splitBase("fabricDirZ")}u, localX, localZ);
  if (sqrt(directionX * directionX + directionZ * directionZ) < 1e-8) {
    return 0.0;
  }
  return atan2(directionZ, directionX);
}

// --- sampleTerrainUpliftHeight ---------------------------------------------

/**
 * Uplift height at a point given as an offset in metres from the page origin
 * the uniform was built for. Only the fabric frame ever reconstructs the
 * absolute coordinate (originMeta).
 */
fn terrainUpliftHeight(localX: f32, localZ: f32) -> f32 {
  let warpX = uFilteredNoise(${splitBase("warpX")}u, localX, localZ) * K_WARP_AMPLITUDE;
  let warpZ = uFilteredNoise(${splitBase("warpZ")}u, localX, localZ) * K_WARP_AMPLITUDE;
  let wx = localX + warpX;
  let wz = localZ + warpZ;

  let continental = uFbm(${splitBase("continental")}u, 4u, wx, wz) * 0.5 + 0.5;
  let land = kSmoothstep(0.38, 0.57, continental);
  let abyssToShelf = kLerp(-4000.0, -140.0, kSmoothstep(0.08, 0.36, continental));
  let continentalProfile = kLerp(abyssToShelf, 135.0, kSmoothstep(0.34, 0.58, continental));

  let doubleAngle = uFabricDoubleAngle(wx, wz);
  let angle = doubleAngle * 0.5;
  let fabricCos = cos(angle);
  let fabricSin = sin(angle);
  let absoluteWarpedX = upliftKernelPages[kPageIndex].originMeta.x + wx;
  let absoluteWarpedZ = upliftKernelPages[kPageIndex].originMeta.y + wz;
  let fabricX = absoluteWarpedX * fabricCos + absoluteWarpedZ * fabricSin;
  let fabricZ = -absoluteWarpedX * fabricSin + absoluteWarpedZ * fabricCos;

  // W-4: the Lloyd plate model, evaluated at the ABSOLUTE warped position —
  // the plate lattice's own split origin lives inside the function.
  let convergence = terrainPlateConvergence(absoluteWarpedX, absoluteWarpedZ);
  let rangeRidges = uFabricRidged(${fabricBase("rangeRidges")}u, 5u, fabricX, fabricZ);
  let rangeUplift = land * convergence
    * pow(max(0.0, rangeRidges), 1.42)
    * (900.0 + convergence * 2850.0);

  let rolling = uFbm(${splitBase("rolling")}u, 5u, wx, wz);
  let province = uFbm(${splitBase("province")}u, 3u, wx, wz) * 0.5 + 0.5;
  let foothills = kSmoothstep(0.34, 0.7, province);
  let inheritedRidges = uFabricRidged(${fabricBase("inheritedRidges")}u, 5u, fabricX, fabricZ);
  let foothillUplift = land * foothills
    * pow(max(0.0, inheritedRidges), 2.12)
    * 310.0;

  // W-4: fineLithology is gone from the uplift authority. The 24 m/9 m bands
  // are applied post-erosion by terrainFineBandRelief below.
  let detail310 = uFbm(${splitBase("detail310")}u, 3u, localX, localZ) * (5.0 + land * 12.0);

  let hillStrength = land * (30.0 + 92.0 * (1.0 - convergence * 0.45));
  let height = continentalProfile
    + rolling * hillStrength
    + foothillUplift
    + rangeUplift
    + detail310;
  return kClamp(height, K_MIN_TERRAIN_HEIGHT, K_MAX_TERRAIN_HEIGHT);
}

// --- sampleTerrainFineBandRelief -------------------------------------------

const U_FINE_BAND_24M: f32 = ${wgslFloat(TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS)};
const U_FINE_BAND_9M: f32 = ${wgslFloat(TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS)};

/**
 * W-4's post-erosion band relief, in metres, at a page-local offset. The
 * fabric direction is read in the WORLD frame (no warp), exactly as the CPU
 * sampler does and for the same reason terrainEvolutionGeologySample does.
 */
fn terrainFineBandRelief(localX: f32, localZ: f32) -> f32 {
  let angle = uFabricDoubleAngle(localX, localZ) * 0.5;
  let fabricCos = cos(angle);
  let fabricSin = sin(angle);
  let absoluteX = upliftKernelPages[kPageIndex].originMeta.x + localX;
  let absoluteZ = upliftKernelPages[kPageIndex].originMeta.y + localZ;
  let fabricX = absoluteX * fabricCos + absoluteZ * fabricSin;
  let fabricZ = -absoluteX * fabricSin + absoluteZ * fabricCos;
  let ridges24 = uFabricRidged(${fabricBase("ridges24")}u, 2u, fabricX, fabricZ) - K_RIDGED_MEAN;
  let ridges9 = uFabricRidged(${fabricBase("ridges9")}u, 1u, fabricX, fabricZ) - K_RIDGED_MEAN;
  return ridges24 * U_FINE_BAND_24M + ridges9 * U_FINE_BAND_9M;
}

// --- sampleTerrainEvolutionGeology -----------------------------------------

/**
 * (fabricCos2, fabricSin2, erodibility, reposeDegrees). The direction fields
 * are sampled at the WORLD-frame local coordinate, exactly as the CPU sampler
 * passes raw x/z rather than warped coordinates.
 */
fn terrainEvolutionGeologySample(localX: f32, localZ: f32) -> vec4f {
  let doubleAngle = uFabricDoubleAngle(localX, localZ);
  let lithology = uFilteredNoise(${splitBase("lithology")}u, localX, localZ);
  let jointing = uFilteredNoise(${splitBase("jointing")}u, localX, localZ);
  let hardness = kSaturate(0.5 + lithology * 0.38 + jointing * 0.12);
  return vec4f(
    cos(doubleAngle),
    sin(doubleAngle),
    kLerp(1.45, 0.32, hardness),
    kLerp(28.0, 42.0, hardness),
  );
}
`;

// ---------------------------------------------------------------------------
// Frozen measured parity criteria (D-3 doctrine)
// ---------------------------------------------------------------------------

/**
 * Frozen measured-criteria contract for the uplift/geology/fine-band samplers
 * (`TERRAIN_HEIGHT_PARITY_CRITERIA` doctrine: the POINT COUNT is part of the
 * criterion; tolerances are measured on the reference adapter, then pinned
 * with ~2x headroom; the achieved bounds are console.logged by
 * tests/gpu/terrain-uplift-parity.test.ts as recorded measurements).
 *
 * Height tolerances are radius-tiered because the fabric-frame lattices
 * evaluate ABSOLUTE rotated coordinates in f32 (see the module docblock).
 * Two mechanisms, both verified by direct probes (2026-08-30):
 *
 * 1. Plain f32 coordinate rounding in the fabric frame — grows linearly with
 *    |world| and dies with filter width as the fine fabric octaves fade.
 * 2. Conditioning at near-zeros of the fabric DIRECTION field: the rotation
 *    angle is atan2 of two noise fields, so where |direction| ~ 1e-3 an f32
 *    noise delta of ~1e-6 turns into an angle delta of ~1e-3, which the
 *    absolute fabric coordinate multiplies into metres of ridge-phase shift.
 *    The production worst cell (seed 333438, cell 61351) sits at
 *    |direction| = 0.0015 with a 23.8 m/m fabric-frame height gradient. These
 *    points are isolated (codimension-2 zeros), so the max bound is pinned
 *    loose while the MEAN bound pins the landscape's overall agreement — the
 *    downstream truth (lake/channel populations, extraction robustness) is
 *    pinned separately by TERRAIN_UPLIFT_GPU_EXTRACTION_BAND.
 *
 * Erodibility/repose come only from split-origin rows (no fabric frame,
 * no atan2 amplification), so their bounds are radius-flat and tight. So does
 * the `W-4` plate field: its lattice is integer, it carries its own split
 * origin, and it contributed no measurable term to any tier below.
 *
 * RE-MEASURED 2026-08-30 for `W-4` (same adapter — Apple silicon, ANGLE Metal
 * — worst over filter widths {0, 8, 32, 128, 512}; the test log carries the
 * full per-tier table). The pinned tolerances are UNCHANGED; what moved is the
 * achieved side, and it moved the right way, because the Lloyd plate field
 * replaced two value-noise channels that were themselves fabric-conditioned:
 *
 *   tier                      before W-4     after W-4    pinned
 *   near ±1e4 m,  40,960 pts   4.04e-3 m     4.04e-3 m    0.01 m
 *   far  ±1e5 m,  12,960 pts   2.26e-2 m     1.64e-2 m    0.05 m
 *   wrap ±2.6e6 m, 3,840 pts   1.905 m       1.827 m      4.0 m
 *   production max (1024²)     0.956 m       0.456 m      2.0 m
 *   production mean            4.11e-4 m     4.58e-4 m    1e-3 m
 *   |Δerod|                    7.2e-7        7.2e-7       2e-6
 *   |Δrepose|                  7.7e-6°       7.6e-6°      2e-5°
 *   |Δfabric cos2/sin2|        4.9e-6        4.9e-6       2e-5
 *
 * The FINE BAND gets its own tier row rather than borrowing the height's, and
 * the reason is structural, not convenience: it is a pure fabric-frame term
 * with no split-origin content to dilute it, so at wrap radius its f32 phase
 * error is a large fraction of its own ±2 m amplitude while the composed
 * height's is a small fraction of thousands of metres. Measured at filter
 * width 0 (every coarser width fades the 24 m octave to exactly zero, and the
 * table shows exact 0.00e+0 there): 1.69e-3 m near, 6.99e-2 m far, 1.12 m at
 * wrap radius — pinned at 0.005 / 0.15 / 2.5. The band is consumed only by L0
 * and L1 pages inside the ±262 km evolution domain, which is the near and far
 * tiers; the wrap row bounds a probe, not a shipped surface.
 */
export const TERRAIN_UPLIFT_GPU_PARITY_CRITERIA = Object.freeze({
  filterWidthsMeters: Object.freeze([0, 8, 32, 128, 512] as const),
  nearRadiusMeters: 10_000,
  nearMinimumSamples: 40_000,
  nearHeightToleranceMeters: 0.01,
  nearFineBandToleranceMeters: 0.005,
  farRadiusMeters: 100_000,
  farHeightToleranceMeters: 0.05,
  farFineBandToleranceMeters: 0.15,
  wrapRadiusMeters: 2_600_000,
  wrapHeightToleranceMeters: 4,
  wrapFineBandToleranceMeters: 2.5,
  productionHeightToleranceMeters: 2,
  productionMeanHeightToleranceMeters: 1e-3,
  erodibilityTolerance: 2e-6,
  reposeToleranceDegrees: 2e-5,
  fabricDoubleAngleTolerance: 2e-5,
});

/**
 * Extraction-robustness band (W-1b): macro evolution run on GPU-sampled
 * inputs must stay the same landscape as on CPU-sampled inputs. Receiver
 * flips at f32 ties are EXPECTED (D-3); the pinned claims are that channel
 * extraction of the GPU-input evolution succeeds (a lake whose outlet is
 * missing from the traced graph throws at startup) and that lake and
 * channel-seed populations stay within a measured relative band.
 *
 * Measured across the 6 seeds (2026-08-30): worst lake-count delta 5 of
 * ~14,500 (3.4e-4 relative), worst channel-seed delta 10 of ~12,800
 * (7.8e-4 relative); input-surface mean |Δh| 3.6e-4..6.7e-4 m with isolated
 * maxima up to 30.4 m (seed 260817 — one fabric-direction near-zero, see the
 * parity criteria docblock); evolved-surface maxima up to 15.2 m where a
 * flipped receiver rerouted incision, means unchanged (≤ 1.5e-3 m). Pinned at
 * 0.15 relative with an absolute floor of 3 lakes, ~200x the measured drift.
 *
 * RE-MEASURED after `W-4` on the same adapter and the same six seeds, with
 * the pinned band UNCHANGED: worst lake-count delta 8 of ~14,440 (5.5e-4
 * relative, seed 424242), worst channel-seed delta 3 of ~13,970; input-surface
 * mean |Δh| 4.3e-4..6.5e-4 m with an isolated 5.09 m maximum (still seed
 * 260817's fabric near-zero, six times smaller than before); evolved-surface
 * maxima up to 24.5 m where a flipped receiver rerouted incision, means
 * ≤ 2.3e-3 m. The band still has ~180x headroom over the measured drift.
 */
export const TERRAIN_UPLIFT_GPU_EXTRACTION_BAND = Object.freeze({
  seeds: Object.freeze([333438, 777001, 111417, 260817, 424242, 987654] as const),
  lakeCountRelativeBand: 0.15,
  lakeCountAbsoluteFloor: 3,
  channelSeedRelativeBand: 0.15,
});
