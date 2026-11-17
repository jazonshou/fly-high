import type { WeatherPreset } from "@/src/game/types";
import { resolveSeaSpectrumConfig, type SeaWorld } from "./seaState";
import { packSeaShelterEllipses, seaShelterField } from "./shelter";
import {
  createOceanWave,
  OCEAN_CHOP_SIGN,
  OCEAN_TIME_SIGN,
  oceanCascadeFrequencyReach,
  oceanInitialWave,
  oceanSpectrumParameters,
  oceanTransformNormalizationScale,
} from "./spectrum";
import type { SpectralOceanConfig } from "./spectrumConfig";
import type {
  HullWaterSampler,
  SeaShelterEllipse,
  WaterSurfaceSample,
  WaveFieldFocus,
} from "./types";

/**
 * The sea twin: the rendered ocean's waves, summed on the CPU, so the surface a
 * hull floats on is the surface the renderer draws (docs/architecture/
 * ARCHITECTURE.md §3, the water authority).
 *
 * It holds cascades 1-4 of the canonical config (256 points, every cascade),
 * whatever tier the renderer runs: after the phase hash keys on the wave, those
 * cascades are the same waves at every tier (`tests/world.ocean-spectrum.test.ts`).
 * Cascade 0, the sub-8 m chop, is left out; it is centimetres, and a hull
 * averages it away. In each cascade it keeps the strongest waves that carry
 * 99% of the cascade's variance (and none under 0.1 mm), so the dropped 1% is a
 * residual of about a tenth of the cascade's RMS height, spread over many
 * small waves.
 *
 * A wave is a grid frequency `(fx, fy)` of its cascade's patch `L`:
 * `k = 2 pi (fx, fy) / L`. The drawn sea at label point `x0` (the vertex before
 * displacement) is
 *
 *   h(x0, t) = sum Re(A e^{i psi}),  D(x0, t) = sum Re(c i lambda k^ A e^{i psi}),
 *   psi = k.x0 + s w t,
 *
 * with `A = 2 S^2 h0` (`S` the transform's per-axis scale), `s` and `c` the
 * GPU's time and chop signs (`OCEAN_TIME_SIGN`, -1: each wave travels along
 * its `k`, downwind; `OCEAN_CHOP_SIGN`, +1: the surface gathers toward the
 * crests), `w` the GPU's own f32 angular frequency and `lambda` the
 * choppiness. The surface point is `x0 + D(x0)` at height `h(x0)`;
 * the twin inverts that with two fixed-point iterations to answer at a world
 * point.
 *
 * Because every wave sits on its cascade's frequency lattice, `e^{i k.x}` for
 * all of a cascade's waves is a product of two powers of `e^{2 pi i x / L}` and
 * `e^{2 pi i z / L}`, read from tables built with two sines per cascade: no
 * wave ever needs its own trigonometry for a position. Time advances each
 * wave's phasor by one complex multiply a step (`OceanPhaseClock`).
 *
 * Fast path:
 * - Cascades 2-4 (32-2048 m): per cascade, a second-order expansion about the
 *   focus in 36 sums (height, displacement and velocity, each with gradient
 *   and curvature). Velocity is the time derivative of height and
 *   displacement, so each expansion carries itself forward in time; it is
 *   rebuilt once its fastest wave has turned 0.05 rad or the focus has moved
 *   a tenth of its shortest wave's 1/k (cascade 2: every fifth step, or half a
 *   metre; cascade 4: every eighteenth, or 8 m). Each step the cascades'
 *   expansions are carried to now and re-centred on the focus, which is exact
 *   for a quadratic.
 * - Cascade 1 (8-32 m): exact values on a 6 x 4 grid laid over the hull
 *   footprint (height and vertical velocity with their slopes and twist for
 *   bicubic Hermite patches, displacement and horizontal velocity for
 *   bilinear), leading the hull along its track, rebuilt every eighth step and
 *   carried between rebuilds by the time derivatives it holds alongside.
 * - Depth: the bed is read on a 4 x 3 grid over the footprint, again only
 *   once the hull has moved half a metre, and interpolated.
 * A point off the hull footprint is answered exactly, by summing every wave.
 *
 * Measured against that exact sum on the shipping world's sea, on a hull
 * 6.8 m by 2.8 m (171 points a step, 0-20 m/s): height within 1.8 mm rms in
 * Clear and 6.5 mm in Cloudy (about 3 m waves), 47 mm at the worst Cloudy
 * crest, run through at 20 m/s; about 0.1 ms a step
 * (`tests/world.sea-twin.test.ts`).
 */

/** The cascades the twin holds; the first is the hull-grid band. */
export const SEA_TWIN_CASCADES: readonly number[] = Object.freeze([1, 2, 3, 4]);

/** Share of each cascade's height variance the twin keeps. */
export const SEA_TWIN_KEPT_VARIANCE = 0.99;

/** A wave smaller than this (amplitude, metres) is never kept. */
export const SEA_TWIN_AMPLITUDE_FLOOR_METERS = 1e-4;

/** Hull-grid nodes along and across the hull. */
export const SEA_TWIN_GRID_ALONG = 6;
export const SEA_TWIN_GRID_ACROSS = 4;

/** How far the hull grid reaches past the hull's half length and half beam, metres. */
const GRID_MARGIN_METERS = 0.5;

/**
 * The hull grid is rebuilt once its age reaches this: every eighth 120 Hz step.
 * Between rebuilds each node is carried by a second-order Taylor step in time;
 * at 8 m (w about 2.8 rad/s) and 71 ms the dropped third-order term is about a
 * thousandth of the wave's amplitude.
 */
const GRID_MAX_AGE_SECONDS = 8.5 / 120;

/** The farthest the hull grid is stretched ahead along the hull's track, metres. */
const GRID_LEAD_LIMIT_METERS = 2;

/** How far past the hull's half length and half beam the fast path answers, metres. */
const COVER_MARGIN_METERS = 0.25;

/**
 * Past the cover box, the reach of the disk round the focus over which the
 * shelter is classified once per step, metres: it has to hold the label
 * points the fixed point visits, which sit a wave's horizontal displacement
 * from the hull.
 */
const SHELTER_DISK_MARGIN_METERS = 10;

/** Bed samples along and across the hull footprint; each hull sample's depth interpolates them. */
const BED_GRID_ALONG = 4;
const BED_GRID_ACROSS = 3;

/** The bed grid is resampled once the hull has moved this far (metres) or turned this far (radians). */
const BED_REFRESH_METERS = 0.5;
const BED_REFRESH_RADIANS = 0.05;

/** A cascade's expansion is rebuilt once its fastest wave has turned this far since (radians)... */
const BLOCK_PHASE_LIMIT_RADIANS = 0.05;

/** ...or once the focus has moved this many 1/k of its shortest wave from where it was built. */
const BLOCK_REACH_LIMIT = 0.1;

/**
 * `surfacePointAt` takes another Newton step while its last one moved the
 * label further than this, metres (the error left after a step is about the
 * square of the step times a short wave's wavenumber)...
 */
const POINT_STEP_LIMIT_METERS = 0.1;

/** ...up to this many steps (a point that jumped). */
const POINT_NEWTON_LIMIT = 4;

/** Exact resync covers every phasor once per this many seconds. */
const PHASE_RESYNC_SECONDS = 1;

const TAU = Math.PI * 2;

/** The sea's surface over one point (`SeaTwin.surfacePointAt`); callers keep one and reuse it. */
export interface SeaSurfacePoint {
  /** World Y of the surface. */
  height: number;
  /** The surface's slope over the point, dY/dx and dY/dz. */
  slopeX: number;
  slopeZ: number;
  /** How fast the surface over the (still) point rises, m/s. */
  rate: number;
}

export function createSeaSurfacePoint(): SeaSurfacePoint {
  return { height: 0, slopeX: 0, slopeZ: 0, rate: 0 };
}

export interface SeaTwinOptions {
  /** World Y of the still sea. */
  readonly seaLevel: number;
  /** The bed under a point (the worker's terrain authority); unset is open ocean. */
  readonly bedHeight?: (x: number, z: number) => number;
  /** Override for tests: share of variance kept per cascade. */
  readonly keptVariance?: number;
  /** Override for tests: amplitude floor, metres. */
  readonly amplitudeFloorMeters?: number;
}

/** The waves of one or more cascades, as parallel arrays. */
interface WaveSet {
  readonly count: number;
  /** Waves are grouped by cascade: cascade `c` holds `start[c]` to `start[c + 1]`. */
  readonly start: Int32Array;
  readonly cascade: Uint8Array;
  readonly fx: Int32Array;
  readonly fy: Int32Array;
  /** Indices into the cascade's `LatticePowers` tables: `reach + fx`, `reach + fy`. */
  readonly ix: Int32Array;
  readonly iz: Int32Array;
  readonly kx: Float64Array;
  readonly kz: Float64Array;
  /** Signed: `OCEAN_TIME_SIGN * w`. */
  readonly omega: Float64Array;
  readonly amplitudeRe: Float64Array;
  readonly amplitudeIm: Float64Array;
  /**
   * `-c lambda k^`, `c` the chop sign: the sums take each wave's displacement
   * as `Re(-i chop A e^{i psi})`, which is the drawn `Re(c i lambda k^ A e^{i psi})`.
   */
  readonly chopX: Float64Array;
  readonly chopZ: Float64Array;
  /** Products the sums weight by: `w^2`, `w chop`, `w^2 chop`. */
  readonly omega2: Float64Array;
  readonly omegaChopX: Float64Array;
  readonly omegaChopZ: Float64Array;
  readonly omega2ChopX: Float64Array;
  readonly omega2ChopZ: Float64Array;
  readonly clock: OceanPhaseClock;
}

/**
 * Each wave's temporal phasor `A e^{i w t}`, advanced by one complex multiply a
 * step and recomputed exactly, round-robin, so every phasor is exact at least
 * once per `PHASE_RESYNC_SECONDS` of simulation. Exported for its own test:
 * phases stay within 1e-6 rad of exact over an hour.
 */
export class OceanPhaseClock {
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly stepRe: Float64Array;
  private readonly stepIm: Float64Array;
  private stepSeconds = Number.NaN;
  private time = Number.NaN;
  private cursor = 0;
  private sinceResync = 0;

  constructor(
    private readonly omega: Float64Array,
    private readonly amplitudeRe: Float64Array,
    private readonly amplitudeIm: Float64Array,
  ) {
    const count = omega.length;
    this.re = new Float64Array(count);
    this.im = new Float64Array(count);
    this.stepRe = new Float64Array(count);
    this.stepIm = new Float64Array(count);
  }

  get seconds(): number {
    return this.time;
  }

  setTime(time: number): void {
    if (time === this.time) return;
    const delta = time - this.time;
    if (!(delta > 0 && delta < 0.25)) {
      this.resync(0, this.omega.length, time);
      this.time = time;
      this.cursor = 0;
      this.sinceResync = 0;
      return;
    }
    // (Written so the first step, with no step prepared yet, prepares one.)
    if (!(Math.abs(delta - this.stepSeconds) <= 1e-9)) this.prepareStep(delta);
    const { re, im, stepRe, stepIm } = this;
    for (let index = 0; index < re.length; index += 1) {
      const a = re[index]!;
      const b = im[index]!;
      const c = stepRe[index]!;
      const d = stepIm[index]!;
      re[index] = a * c - b * d;
      im[index] = a * d + b * c;
    }
    this.time = time;
    // Spread the exact recompute so every phasor is refreshed within a second.
    this.sinceResync += delta;
    const due = Math.min(
      re.length - this.cursor,
      Math.ceil((re.length * this.sinceResync) / PHASE_RESYNC_SECONDS),
    );
    if (due > 0) {
      this.resync(this.cursor, this.cursor + due, time);
      this.cursor += due;
      this.sinceResync = 0;
      if (this.cursor >= re.length) this.cursor = 0;
    }
  }

  private prepareStep(delta: number): void {
    for (let index = 0; index < this.omega.length; index += 1) {
      const phase = this.omega[index]! * delta;
      this.stepRe[index] = Math.cos(phase);
      this.stepIm[index] = Math.sin(phase);
    }
    this.stepSeconds = delta;
  }

  private resync(from: number, to: number, time: number): void {
    for (let index = from; index < to; index += 1) {
      const phase = this.omega[index]! * time;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const a = this.amplitudeRe[index]!;
      const b = this.amplitudeIm[index]!;
      this.re[index] = a * c - b * s;
      this.im[index] = a * s + b * c;
    }
  }
}

/**
 * `e^{i k.v}` for every wave of one cascade at one vector `v`: powers of
 * `e^{2 pi i vx / L}` and `e^{2 pi i vz / L}` over the cascade's frequency
 * reach. The phase is formed from `frac(v / L)`, so a point 100 km out is as
 * exact as one at the origin.
 */
class LatticePowers {
  readonly xRe: Float64Array;
  readonly xIm: Float64Array;
  readonly zRe: Float64Array;
  readonly zIm: Float64Array;

  constructor(readonly reach: number, private readonly patchLength: number) {
    const size = 2 * reach + 1;
    this.xRe = new Float64Array(size);
    this.xIm = new Float64Array(size);
    this.zRe = new Float64Array(size);
    this.zIm = new Float64Array(size);
  }

  /** Powers for an absolute position (periodic in the patch). */
  setPosition(x: number, z: number): void {
    const fractionX = x / this.patchLength - Math.floor(x / this.patchLength);
    const fractionZ = z / this.patchLength - Math.floor(z / this.patchLength);
    fill(this.xRe, this.xIm, this.reach, TAU * fractionX);
    fill(this.zRe, this.zIm, this.reach, TAU * fractionZ);
  }

  /** Powers for a short offset. */
  setOffset(x: number, z: number): void {
    fill(this.xRe, this.xIm, this.reach, (TAU * x) / this.patchLength);
    fill(this.zRe, this.zIm, this.reach, (TAU * z) / this.patchLength);
  }
}

function fill(re: Float64Array, im: Float64Array, reach: number, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  re[reach] = 1;
  im[reach] = 0;
  let a = 1;
  let b = 0;
  for (let power = 1; power <= reach; power += 1) {
    // Re-anchor every 16 powers so rounding never compounds past a few ulps.
    if ((power & 15) === 0) {
      a = Math.cos(angle * power);
      b = Math.sin(angle * power);
    } else {
      const nextA = a * c - b * s;
      b = a * s + b * c;
      a = nextA;
    }
    re[reach + power] = a;
    im[reach + power] = b;
    re[reach - power] = a;
    im[reach - power] = -b;
  }
}

function buildWaveSet(
  config: SpectralOceanConfig,
  cascades: readonly number[],
  keptVariance: number,
  amplitudeFloor: number,
): WaveSet {
  interface Candidate {
    cascade: number;
    fx: number;
    fy: number;
    kx: number;
    kz: number;
    omega: number;
    re: number;
    im: number;
    variance: number;
  }
  const kept: Candidate[] = [];
  const reaches = config.cascades.map((_, cascade) => oceanCascadeFrequencyReach(config, cascade));
  const wave = createOceanWave();
  for (const cascade of cascades) {
    const params = oceanSpectrumParameters(config, cascade);
    const scale = oceanTransformNormalizationScale(config.cascades[cascade]!.patchLengthMeters);
    const amplitudeScale = 2 * scale * scale;
    const reach = reaches[cascade]!;
    const candidates: Candidate[] = [];
    let total = 0;
    for (let fy = -reach; fy <= reach; fy += 1) {
      for (let fx = -reach; fx <= reach; fx += 1) {
        oceanInitialWave(config, params, cascade, fx, fy, wave);
        if (wave.spectrum <= 0) continue;
        const re = wave.h0Re * amplitudeScale;
        const im = wave.h0Im * amplitudeScale;
        const variance = 0.5 * (re * re + im * im);
        total += variance;
        candidates.push({
          cascade,
          fx,
          fy,
          kx: wave.kx,
          kz: wave.kz,
          // The GPU stores w in an f32 texel and multiplies it by time.
          omega: OCEAN_TIME_SIGN * Math.fround(wave.omega),
          re,
          im,
          variance,
        });
      }
    }
    candidates.sort((first, second) => second.variance - first.variance);
    const floorVariance = 0.5 * amplitudeFloor * amplitudeFloor;
    let carried = 0;
    for (const candidate of candidates) {
      if (carried >= keptVariance * total || candidate.variance < floorVariance) break;
      kept.push(candidate);
      carried += candidate.variance;
    }
  }
  const count = kept.length;
  const set = {
    count,
    start: new Int32Array(config.cascades.length + 1),
    cascade: new Uint8Array(count),
    fx: new Int32Array(count),
    fy: new Int32Array(count),
    ix: new Int32Array(count),
    iz: new Int32Array(count),
    kx: new Float64Array(count),
    kz: new Float64Array(count),
    omega: new Float64Array(count),
    amplitudeRe: new Float64Array(count),
    amplitudeIm: new Float64Array(count),
    chopX: new Float64Array(count),
    chopZ: new Float64Array(count),
    omega2: new Float64Array(count),
    omegaChopX: new Float64Array(count),
    omegaChopZ: new Float64Array(count),
    omega2ChopX: new Float64Array(count),
    omega2ChopZ: new Float64Array(count),
  };
  kept.forEach((candidate, index) => {
    set.cascade[index] = candidate.cascade;
    set.fx[index] = candidate.fx;
    set.fy[index] = candidate.fy;
    set.ix[index] = reaches[candidate.cascade]! + candidate.fx;
    set.iz[index] = reaches[candidate.cascade]! + candidate.fy;
    set.kx[index] = candidate.kx;
    set.kz[index] = candidate.kz;
    set.omega[index] = candidate.omega;
    set.amplitudeRe[index] = candidate.re;
    set.amplitudeIm[index] = candidate.im;
    const wavenumber = Math.hypot(candidate.kx, candidate.kz);
    const chop = (-OCEAN_CHOP_SIGN * config.choppiness) / wavenumber;
    const chopX = chop * candidate.kx;
    const chopZ = chop * candidate.kz;
    const omega = candidate.omega;
    set.chopX[index] = chopX;
    set.chopZ[index] = chopZ;
    set.omega2[index] = omega * omega;
    set.omegaChopX[index] = omega * chopX;
    set.omegaChopZ[index] = omega * chopZ;
    set.omega2ChopX[index] = omega * omega * chopX;
    set.omega2ChopZ[index] = omega * omega * chopZ;
  });
  for (let cascade = 0; cascade <= config.cascades.length; cascade += 1) {
    let first = 0;
    while (first < count && set.cascade[first]! < cascade) first += 1;
    set.start[cascade] = first;
  }
  return {
    ...set,
    clock: new OceanPhaseClock(set.omega, set.amplitudeRe, set.amplitudeIm),
  };
}

/**
 * The drawn sea's fields at one label point, before shelter: height `h`, its
 * gradient, displacement `D` with its Jacobian terms, and the surface
 * particle's velocity `(ux, w, uz)`.
 */
interface SeaFields {
  h: number;
  hx: number;
  hz: number;
  dx: number;
  dz: number;
  dxx: number;
  dxz: number;
  dzx: number;
  dzz: number;
  w: number;
  ux: number;
  uz: number;
}

function createSeaFields(): SeaFields {
  return { h: 0, hx: 0, hz: 0, dx: 0, dz: 0, dxx: 0, dxz: 0, dzx: 0, dzz: 0, w: 0, ux: 0, uz: 0 };
}

function clearSeaFields(fields: SeaFields): void {
  fields.h = 0;
  fields.hx = 0;
  fields.hz = 0;
  fields.dx = 0;
  fields.dz = 0;
  fields.dxx = 0;
  fields.dxz = 0;
  fields.dzx = 0;
  fields.dzz = 0;
  fields.w = 0;
  fields.ux = 0;
  fields.uz = 0;
}

// Expansion slots: six terms (value, d/dx, d/dz, xx/2, xz, zz/2) per field.
const H = 0;
const DX = 6;
const DZ = 12;
const W = 18;
const UX = 24;
const UZ = 30;
const EXPANSION_SIZE = 36;

// A cascade's expansion block: the 36 terms at its centre and build time, then
// the time derivatives of the vertical and horizontal velocity there, which
// carry the values to second order in time.
const BLOCK_W_RATE = EXPANSION_SIZE;
const BLOCK_UX_RATE = EXPANSION_SIZE + 1;
const BLOCK_UZ_RATE = EXPANSION_SIZE + 2;
const BLOCK_SIZE = EXPANSION_SIZE + 3;
const POSITION_FIELDS = [H, DX, DZ] as const;
const VELOCITY_FIELDS = [W, UX, UZ] as const;
const RATE_SLOTS = [BLOCK_W_RATE, BLOCK_UX_RATE, BLOCK_UZ_RATE] as const;

/**
 * Adds an expansion block into `out`, carried `age` seconds on from when it
 * was built and re-centred `(driftX, driftZ)` from where; returns its height at
 * the new centre. Height and displacement terms carry by their velocity terms
 * (values to second order, by the velocity's rate); velocity values carry by
 * their rate, and their gradient and curvature hold. Re-centring a quadratic
 * is exact.
 */
function addCarriedBlock(
  block: Float64Array,
  age: number,
  driftX: number,
  driftZ: number,
  out: Float64Array,
): number {
  const half = 0.5 * age * age;
  let height = 0;
  for (let pair = 0; pair < 3; pair += 1) {
    const position = POSITION_FIELDS[pair]!;
    const velocity = VELOCITY_FIELDS[pair]!;
    const rate = block[RATE_SLOTS[pair]!]!;
    const value = addRecentred(
      out,
      position,
      block[position]! + age * block[velocity]! + half * rate,
      block[position + 1]! + age * block[velocity + 1]!,
      block[position + 2]! + age * block[velocity + 2]!,
      block[position + 3]! + age * block[velocity + 3]!,
      block[position + 4]! + age * block[velocity + 4]!,
      block[position + 5]! + age * block[velocity + 5]!,
      driftX,
      driftZ,
    );
    if (position === H) height = value;
    addRecentred(
      out,
      velocity,
      block[velocity]! + age * rate,
      block[velocity + 1]!,
      block[velocity + 2]!,
      block[velocity + 3]!,
      block[velocity + 4]!,
      block[velocity + 5]!,
      driftX,
      driftZ,
    );
  }
  return height;
}

/** Adds `c0 + c1 x + c2 z + c3 x^2 + c4 x z + c5 z^2`, moved to centre `(dx, dz)`, into `out[base..]`. */
function addRecentred(
  out: Float64Array,
  base: number,
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  c4: number,
  c5: number,
  dx: number,
  dz: number,
): number {
  const value = c0 + c1 * dx + c2 * dz + c3 * dx * dx + c4 * dx * dz + c5 * dz * dz;
  out[base] = out[base]! + value;
  out[base + 1] = out[base + 1]! + c1 + 2 * c3 * dx + c4 * dz;
  out[base + 2] = out[base + 2]! + c2 + c4 * dx + 2 * c5 * dz;
  out[base + 3] = out[base + 3]! + c3;
  out[base + 4] = out[base + 4]! + c4;
  out[base + 5] = out[base + 5]! + c5;
  return value;
}

// Hull-grid node slots: height with its along/across slopes and twist for a
// bicubic Hermite patch; the vertical velocity; displacement and horizontal
// velocity (bilinear); and the time derivatives that carry them between
// rebuilds. The height slopes' and twist's rates are also the vertical
// velocity's, so vertical velocity gets the same bicubic patch. (A bicubic
// patch for displacement too cut its error at the label point from 14 to 2 mm
// in a Cloudy sea but left the error at a world point where it was, 1.6 mm
// rms, which the long bands set; it cost 40% more per rebuild.)
const NODE_H = 0;
const NODE_HA = 1;
const NODE_HC = 2;
const NODE_HAC = 3;
const NODE_W = 4;
const NODE_W_RATE = 5;
const NODE_HA_RATE = 6;
const NODE_HC_RATE = 7;
const NODE_DX = 8;
const NODE_DZ = 9;
const NODE_UX = 10;
const NODE_UZ = 11;
const NODE_UX_RATE = 12;
const NODE_UZ_RATE = 13;
const NODE_HAC_RATE = 14;
const NODE_SIZE = 15;
const NODE_COUNT = SEA_TWIN_GRID_ALONG * SEA_TWIN_GRID_ACROSS;
if (SEA_TWIN_GRID_ACROSS % 2 !== 0) throw new Error("The hull grid builds its across nodes in pairs");

// Cubic Hermite basis at a point in a grid cell, along (s) and across (t):
// the two value weights and two slope weights (in metres), and their
// derivatives per metre.
const F0S = 0;
const DF0S = 4;
const F0T = 8;
const DF0T = 12;
const BASIS_SIZE = 16;

/**
 * A field's bicubic Hermite patch on one cell, from its corners' value, along
 * slope, across slope and twist in `nodes`. Returns the value and writes its
 * along and across derivatives to `slopes[0..1]` when given.
 */
function hermitePatch(
  nodes: Float64Array,
  i00: number,
  i10: number,
  value: number,
  slopeA: number,
  slopeC: number,
  twist: number,
  basis: Float64Array,
  slopes: Float64Array | null,
): number {
  const i01 = i00 + NODE_SIZE;
  const i11 = i10 + NODE_SIZE;
  const v00 = nodes[i00 + value]!;
  const v01 = nodes[i01 + value]!;
  const v10 = nodes[i10 + value]!;
  const v11 = nodes[i11 + value]!;
  const a00 = nodes[i00 + slopeA]!;
  const a01 = nodes[i01 + slopeA]!;
  const a10 = nodes[i10 + slopeA]!;
  const a11 = nodes[i11 + slopeA]!;
  const c00 = nodes[i00 + slopeC]!;
  const c01 = nodes[i01 + slopeC]!;
  const c10 = nodes[i10 + slopeC]!;
  const c11 = nodes[i11 + slopeC]!;
  const x00 = nodes[i00 + twist]!;
  const x01 = nodes[i01 + twist]!;
  const x10 = nodes[i10 + twist]!;
  const x11 = nodes[i11 + twist]!;
  const ft0 = basis[F0T]!;
  const ft1 = basis[F0T + 1]!;
  const gt0 = basis[F0T + 2]!;
  const gt1 = basis[F0T + 3]!;
  const row0 = ft0 * v00 + ft1 * v01 + gt0 * c00 + gt1 * c01;
  const row1 = ft0 * v10 + ft1 * v11 + gt0 * c10 + gt1 * c11;
  const slope0 = ft0 * a00 + ft1 * a01 + gt0 * x00 + gt1 * x01;
  const slope1 = ft0 * a10 + ft1 * a11 + gt0 * x10 + gt1 * x11;
  const fs0 = basis[F0S]!;
  const fs1 = basis[F0S + 1]!;
  const gs0 = basis[F0S + 2]!;
  const gs1 = basis[F0S + 3]!;
  if (slopes !== null) {
    const dft0 = basis[DF0T]!;
    const dft1 = basis[DF0T + 1]!;
    const dgt0 = basis[DF0T + 2]!;
    const dgt1 = basis[DF0T + 3]!;
    const rowRate0 = dft0 * v00 + dft1 * v01 + dgt0 * c00 + dgt1 * c01;
    const rowRate1 = dft0 * v10 + dft1 * v11 + dgt0 * c10 + dgt1 * c11;
    const slopeRate0 = dft0 * a00 + dft1 * a01 + dgt0 * x00 + dgt1 * x01;
    const slopeRate1 = dft0 * a10 + dft1 * a11 + dgt0 * x10 + dgt1 * x11;
    slopes[0] = basis[DF0S]! * row0 + basis[DF0S + 1]! * row1 + basis[DF0S + 2]! * slope0 + basis[DF0S + 3]! * slope1;
    slopes[1] = fs0 * rowRate0 + fs1 * rowRate1 + gs0 * slopeRate0 + gs1 * slopeRate1;
  }
  return fs0 * row0 + fs1 * row1 + gs0 * slope0 + gs1 * slope1;
}

function writeNode(
  nodes: Float64Array,
  slot: number,
  h: number, ha: number, hc: number, hac: number,
  w: number, wRate: number, haRate: number, hcRate: number,
  dx: number, dz: number, ux: number, uz: number, uxRate: number, uzRate: number,
  hacRate: number,
): void {
  nodes[slot + NODE_H] = h;
  nodes[slot + NODE_HA] = ha;
  nodes[slot + NODE_HC] = hc;
  nodes[slot + NODE_HAC] = hac;
  nodes[slot + NODE_W] = w;
  nodes[slot + NODE_W_RATE] = wRate;
  nodes[slot + NODE_HA_RATE] = haRate;
  nodes[slot + NODE_HC_RATE] = hcRate;
  nodes[slot + NODE_DX] = dx;
  nodes[slot + NODE_DZ] = dz;
  nodes[slot + NODE_UX] = ux;
  nodes[slot + NODE_UZ] = uz;
  nodes[slot + NODE_UX_RATE] = uxRate;
  nodes[slot + NODE_UZ_RATE] = uzRate;
  nodes[slot + NODE_HAC_RATE] = hacRate;
}

const DEFAULT_FOCUS: WaveFieldFocus = Object.freeze({
  x: 0,
  z: 0,
  heading: 0,
  halfLength: 3.5,
  halfBeam: 1.5,
});

export class SeaTwin implements HullWaterSampler {
  private config: SpectralOceanConfig;
  private grid!: WaveSet;
  private long!: WaveSet;
  private readonly seaLevel: number;
  private readonly bedHeight: ((x: number, z: number) => number) | null;
  private readonly keptVariance: number;
  private readonly amplitudeFloor: number;
  private time = 0;
  private readonly focus: WaveFieldFocus = { ...DEFAULT_FOCUS };
  private focusAlongX = Math.sin(DEFAULT_FOCUS.heading);
  private focusAlongZ = Math.cos(DEFAULT_FOCUS.heading);
  private focusTime = Number.NaN;
  private focusVelocityX = 0;
  private focusVelocityZ = 0;

  // Cascades 2-4: one carried expansion block per cascade, summed about the focus.
  private readonly expansion = new Float64Array(EXPANSION_SIZE);
  private cascadeHeights = new Float64Array(0);
  private expansionValid = false;
  private expansionX = 0;
  private expansionZ = 0;
  private longPowers: LatticePowers[] = [];
  private blocks: Float64Array[] = [];
  private blockBuilt = new Uint8Array(0);
  private blockTime = new Float64Array(0);
  private blockX = new Float64Array(0);
  private blockZ = new Float64Array(0);
  private blockMaxAge = new Float64Array(0);
  private blockMaxDrift = new Float64Array(0);

  // Cascade 1 on the hull grid.
  private readonly nodes = new Float64Array(NODE_COUNT * NODE_SIZE);
  /** The nodes carried to `carriedTime`: what samples interpolate. */
  private readonly carried = new Float64Array(NODE_COUNT * NODE_SIZE);
  private carriedTime = Number.NaN;
  private readonly basis = new Float64Array(BASIS_SIZE);
  private readonly slopes = new Float64Array(2);
  private gridValid = false;
  private gridTime = 0;
  private gridCenterX = 0;
  private gridCenterZ = 0;
  private gridAlongX = 0;
  private gridAlongZ = 1;
  private gridHalfAlong = 0;
  private gridHalfAcross = 0;
  private gridStepAlong = 1;
  private gridStepAcross = 1;
  private gridPowers!: LatticePowers;
  private gridStepAlongPowers!: LatticePowers;
  private gridStepAcrossPowers!: LatticePowers;
  // Per-wave scratch for a grid rebuild, sized to the grid band in rebuild().
  private gridRowRe = new Float64Array(0);
  private gridRowIm = new Float64Array(0);
  private gridCurrentRe = new Float64Array(0);
  private gridCurrentIm = new Float64Array(0);
  private gridAcrossRe = new Float64Array(0);
  private gridAcrossIm = new Float64Array(0);
  private gridAlongRe = new Float64Array(0);
  private gridAlongIm = new Float64Array(0);
  private gridKa = new Float64Array(0);
  private gridKc = new Float64Array(0);
  private gridKac = new Float64Array(0);
  private gridOmegaKa = new Float64Array(0);
  private gridOmegaKc = new Float64Array(0);
  private gridOmegaKac = new Float64Array(0);

  // Exact path.
  private exactPowers: LatticePowers[] = [];

  // The bed under the hull footprint, sampled once per footprint.
  private readonly bedGrid = new Float64Array(BED_GRID_ALONG * BED_GRID_ACROSS);
  private bedValid = false;
  private bedCenterX = 0;
  private bedCenterZ = 0;
  private bedHeading = 0;
  private bedAlongX = 0;
  private bedAlongZ = 1;
  private bedHalfAlong = 0;
  private bedHalfAcross = 0;
  private bedHalfLength = 0;
  private bedHalfBeam = 0;

  private shelter: Float64Array | null = null;
  private readonly shelterScratch = new Float64Array(3);
  // The shelter over a disk round the focus: a constant (each basin wholly
  // around the disk or wholly clear of it, so the gradient is 0), or NaN
  // where an edge crosses the disk and points need the full field.
  private shelterClassified = false;
  private shelterConstant = 1;
  private shelterDiskX = 0;
  private shelterDiskZ = 0;
  private shelterDiskRadiusSquared = 0;
  private readonly fields = createSeaFields();
  private readonly partial = createSeaFields();
  // `surfacePointAt`: the label's offset from the point the last call found,
  // which starts the next call's Newton steps.
  private readonly pointFields = createSeaFields();
  private pointOffsetX = 0;
  private pointOffsetZ = 0;

  constructor(config: SpectralOceanConfig, options: SeaTwinOptions) {
    this.config = config;
    this.seaLevel = options.seaLevel;
    this.bedHeight = options.bedHeight ?? null;
    this.keptVariance = options.keptVariance ?? SEA_TWIN_KEPT_VARIANCE;
    this.amplitudeFloor = options.amplitudeFloorMeters ?? SEA_TWIN_AMPLITUDE_FLOOR_METERS;
    this.rebuild();
  }

  /** The config the twin's waves are drawn from. */
  get spectrumConfig(): SpectralOceanConfig {
    return this.config;
  }

  /** How many waves the twin sums, in the hull-grid band and in the expanded bands. */
  get waveCounts(): { readonly grid: number; readonly long: number } {
    return { grid: this.grid.count, long: this.long.count };
  }

  /**
   * A new sea state (D2: a weather preset change). The new waves start at the
   * current simulation time, as the GPU's rebuilt spectra do.
   */
  setConfig(config: SpectralOceanConfig): void {
    this.config = config;
    this.rebuild();
  }

  setTime(time: number): void {
    if (time === this.time) return;
    this.time = time;
    this.grid.clock.setTime(time);
    this.long.clock.setTime(time);
    this.expansionValid = false;
  }

  setFocus(focus: Readonly<WaveFieldFocus>): void {
    const moved = focus.x !== this.focus.x || focus.z !== this.focus.z;
    // The hull's track over the last step, which the hull grid leads along.
    const elapsed = this.time - this.focusTime;
    if (elapsed > 0 && elapsed < 0.25) {
      this.focusVelocityX = (focus.x - this.focus.x) / elapsed;
      this.focusVelocityZ = (focus.z - this.focus.z) / elapsed;
    } else if (elapsed !== 0) {
      this.focusVelocityX = 0;
      this.focusVelocityZ = 0;
    }
    this.focusTime = this.time;
    if (focus.heading !== this.focus.heading) {
      this.focusAlongX = Math.sin(focus.heading);
      this.focusAlongZ = Math.cos(focus.heading);
    }
    this.focus.x = focus.x;
    this.focus.z = focus.z;
    this.focus.heading = focus.heading;
    this.focus.halfLength = focus.halfLength;
    this.focus.halfBeam = focus.halfBeam;
    if (moved) this.expansionValid = false;
    this.shelterClassified = false;
  }

  /** Marina basins (at most 4); the open sea is exactly 1. */
  setShelter(ellipses: readonly SeaShelterEllipse[]): void {
    this.shelter = ellipses.length === 0 ? null : packSeaShelterEllipses(ellipses);
    this.shelterClassified = false;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    if (!this.covers(x, z)) return this.sampleExact(x, z, out);
    this.ensureExpansion();
    this.ensureGrid();
    this.ensureCarried();
    let labelX = x;
    let labelZ = z;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      this.displacementAt(labelX, labelZ, this.fields);
      labelX = x - this.fields.dx;
      labelZ = z - this.fields.dz;
    }
    this.fastFieldsAt(labelX, labelZ, this.fields);
    return this.finish(x, z, labelX, labelZ, this.fields, this.footprintBed(x, z), out);
  }

  /** The same answer by summing every kept wave, anywhere. Slow; tests and far points. */
  sampleExact(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    let labelX = x;
    let labelZ = z;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      this.exactFieldsAt(labelX, labelZ, this.fields);
      const shelter = this.shelterAt(labelX, labelZ)[0]!;
      labelX = x - shelter * this.fields.dx;
      labelZ = z - shelter * this.fields.dz;
    }
    this.exactFieldsAt(labelX, labelZ, this.fields);
    const bed = this.bedHeight ? this.bedHeight(x, z) : Number.NEGATIVE_INFINITY;
    return this.finish(x, z, labelX, labelZ, this.fields, bed, out);
  }

  /**
   * The sea's surface over one point within a few metres of the focus, for
   * a caller that follows a single point a frame (the renderer's camera):
   * the long cascades from the focus's expansion, and the hull-grid band
   * summed directly at the label point, which Newton steps find from the
   * label the last call found (one step a call while the point moves
   * smoothly). No hull grid is built, so a call costs one pass over the
   * 8-32 m band's waves, not the grid's rebuild that `sample` spreads over a
   * hull's many points. Sheltered (the shelter's gradient left out, felt
   * only on a basin's rim); no bed. Agrees with `sampleExact` to a few
   * millimetres.
   */
  surfacePointAt(x: number, z: number, out: SeaSurfacePoint): SeaSurfacePoint {
    this.ensureExpansion();
    const fields = this.pointFields;
    let labelX = x - this.pointOffsetX;
    let labelZ = z - this.pointOffsetZ;
    for (let iteration = 0; iteration < POINT_NEWTON_LIMIT; iteration += 1) {
      this.pointFieldsAt(labelX, labelZ, fields);
      const s = this.shelterFactorAt(labelX, labelZ);
      // F(label) = label + s D(label) - point, and its Jacobian.
      const rx = labelX + s * fields.dx - x;
      const rz = labelZ + s * fields.dz - z;
      const jxx = 1 + s * fields.dxx;
      const jxz = s * fields.dxz;
      const jzx = s * fields.dzx;
      const jzz = 1 + s * fields.dzz;
      const determinant = jxx * jzz - jxz * jzx;
      const safe = Math.abs(determinant) > 0.05 ? determinant : (determinant < 0 ? -0.05 : 0.05);
      const stepX = (jzz * rx - jxz * rz) / safe;
      const stepZ = (jxx * rz - jzx * rx) / safe;
      labelX -= stepX;
      labelZ -= stepZ;
      // Height carried to the new label along its gradient; the slope over
      // the point is that gradient through the inverse Jacobian.
      const hx = s * fields.hx;
      const hz = s * fields.hz;
      const slopeX = (hx * jzz - hz * jzx) / safe;
      const slopeZ = (hz * jxx - hx * jxz) / safe;
      out.height = this.seaLevel + s * fields.h - hx * stepX - hz * stepZ;
      out.slopeX = slopeX;
      out.slopeZ = slopeZ;
      // The surface over a still point rises as its particle does, less the
      // slope it carries past: w - grad(eta) . u.
      out.rate = s * (fields.w - slopeX * fields.ux - slopeZ * fields.uz);
      if (stepX * stepX + stepZ * stepZ <= POINT_STEP_LIMIT_METERS * POINT_STEP_LIMIT_METERS) break;
    }
    this.pointOffsetX = x - labelX;
    this.pointOffsetZ = z - labelZ;
    return out;
  }

  /**
   * The undisplaced (Eulerian) fields at a label point by summing every kept
   * wave, before shelter. Tests compare it with an FFT of the same spectrum.
   */
  exactLabelHeight(labelX: number, labelZ: number): { h: number; dx: number; dz: number } {
    this.exactFieldsAt(labelX, labelZ, this.partial);
    return { h: this.partial.h, dx: this.partial.dx, dz: this.partial.dz };
  }

  /**
   * The heave at the focus of the cascades a renderer tier does not draw:
   * cascades `drawnCascades` and up (every tier draws at least three). The
   * presentation offsets the drawn hull by it so a boat on a low tier still
   * rides the long swell the physics feels.
   */
  undrawnHeave(drawnCascades: number): number {
    this.ensureExpansion();
    let heave = 0;
    for (let cascade = Math.max(drawnCascades, 2); cascade < this.cascadeHeights.length; cascade += 1) {
      heave += this.cascadeHeights[cascade]!;
    }
    const shelter = this.shelterAt(this.focus.x, this.focus.z);
    return heave * shelter[0]!;
  }

  private rebuild(): void {
    const [gridCascade, ...longCascades] = SEA_TWIN_CASCADES;
    this.grid = buildWaveSet(this.config, [gridCascade!], this.keptVariance, this.amplitudeFloor);
    this.long = buildWaveSet(this.config, longCascades, this.keptVariance, this.amplitudeFloor);
    const powersFor = (cascade: number) => new LatticePowers(
      oceanCascadeFrequencyReach(this.config, cascade),
      this.config.cascades[cascade]!.patchLengthMeters,
    );
    this.longPowers = this.config.cascades.map((_, cascade) => powersFor(cascade));
    this.exactPowers = this.config.cascades.map((_, cascade) => powersFor(cascade));
    this.gridPowers = powersFor(gridCascade!);
    this.gridStepAlongPowers = powersFor(gridCascade!);
    this.gridStepAcrossPowers = powersFor(gridCascade!);
    const gridCount = this.grid.count;
    this.gridRowRe = new Float64Array(gridCount);
    this.gridRowIm = new Float64Array(gridCount);
    this.gridCurrentRe = new Float64Array(gridCount);
    this.gridCurrentIm = new Float64Array(gridCount);
    this.gridAcrossRe = new Float64Array(gridCount);
    this.gridAcrossIm = new Float64Array(gridCount);
    this.gridAlongRe = new Float64Array(gridCount);
    this.gridAlongIm = new Float64Array(gridCount);
    this.gridKa = new Float64Array(gridCount);
    this.gridKc = new Float64Array(gridCount);
    this.gridKac = new Float64Array(gridCount);
    this.gridOmegaKa = new Float64Array(gridCount);
    this.gridOmegaKc = new Float64Array(gridCount);
    this.gridOmegaKac = new Float64Array(gridCount);
    const cascadeCount = this.config.cascades.length;
    this.cascadeHeights = new Float64Array(cascadeCount);
    this.blocks = this.config.cascades.map(() => new Float64Array(BLOCK_SIZE));
    this.blockBuilt = new Uint8Array(cascadeCount);
    this.blockTime = new Float64Array(cascadeCount);
    this.blockX = new Float64Array(cascadeCount);
    this.blockZ = new Float64Array(cascadeCount);
    this.blockMaxAge = new Float64Array(cascadeCount);
    this.blockMaxDrift = new Float64Array(cascadeCount);
    const { long } = this;
    for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
      let fastest = 0;
      let shortest = 0;
      for (let index = long.start[cascade]!; index < long.start[cascade + 1]!; index += 1) {
        fastest = Math.max(fastest, Math.abs(long.omega[index]!));
        shortest = Math.max(shortest, Math.hypot(long.kx[index]!, long.kz[index]!));
      }
      this.blockMaxAge[cascade] = fastest > 0 ? BLOCK_PHASE_LIMIT_RADIANS / fastest : Number.POSITIVE_INFINITY;
      this.blockMaxDrift[cascade] = shortest > 0 ? BLOCK_REACH_LIMIT / shortest : Number.POSITIVE_INFINITY;
    }
    const time = this.time;
    this.grid.clock.setTime(time);
    this.long.clock.setTime(time);
    this.expansionValid = false;
    this.gridValid = false;
  }

  /** Whether a point lies on the hull footprint the fast path is built for. */
  private covers(x: number, z: number): boolean {
    const { focus } = this;
    const alongX = this.focusAlongX;
    const alongZ = this.focusAlongZ;
    const offsetX = x - focus.x;
    const offsetZ = z - focus.z;
    const along = offsetX * alongX + offsetZ * alongZ;
    const across = offsetX * alongZ - offsetZ * alongX;
    return Math.abs(along) <= focus.halfLength + COVER_MARGIN_METERS
      && Math.abs(across) <= focus.halfBeam + COVER_MARGIN_METERS;
  }

  private shelterAt(x: number, z: number): Float64Array {
    const out = this.shelterScratch;
    if (this.shelter === null || this.shelterHolds(x, z)) {
      out[0] = this.shelter === null ? 1 : this.shelterConstant;
      out[1] = 0;
      out[2] = 0;
      return out;
    }
    return seaShelterField(this.shelter, x, z, out);
  }

  /** The shelter factor alone: what the fixed-point iterations scale displacement by. */
  private shelterFactorAt(x: number, z: number): number {
    if (this.shelter === null) return 1;
    if (this.shelterHolds(x, z)) return this.shelterConstant;
    return seaShelterField(this.shelter, x, z, this.shelterScratch)[0]!;
  }

  /** Whether the focus disk's constant is the field at this point, exactly. */
  private shelterHolds(x: number, z: number): boolean {
    if (!this.shelterClassified) this.classifyShelter();
    if (Number.isNaN(this.shelterConstant)) return false;
    const dx = x - this.shelterDiskX;
    const dz = z - this.shelterDiskZ;
    return dx * dx + dz * dz <= this.shelterDiskRadiusSquared;
  }

  /**
   * Classifies each basin against a disk round the focus, by bounds over the
   * square that holds the disk in the basin's own frame (`u` along, `v`
   * across), where `f = q - 1`, `q = u^2/a^2 + v^2/b^2` and
   * `|grad f| = 2 sqrt(u^2/a^4 + v^2/b^4)`. If `q` stays at or under 1 the disk
   * is inside the ellipse and the field's slot is exactly `1 - depth`. If the
   * least `f` over the greatest `|grad f|` is a feather or more, the disk is
   * past the feather and the slot is exactly 1. Either way the gradient is 0.
   * The products are taken in seaShelterField's order, so the constant is
   * bit-identical to the field it stands for.
   */
  private classifyShelter(): void {
    const packed = this.shelter!;
    const { focus } = this;
    const radius = Math.hypot(focus.halfLength + COVER_MARGIN_METERS, focus.halfBeam + COVER_MARGIN_METERS)
      + SHELTER_DISK_MARGIN_METERS;
    let constant = 1;
    for (let base = 0; base < packed.length; base += 8) {
      const depth = packed[base + 6]!;
      if (depth === 0) continue;
      const sine = packed[base + 2]!;
      const cosine = packed[base + 3]!;
      const inverseA2 = packed[base + 4]!;
      const inverseB2 = packed[base + 5]!;
      const dx = focus.x - packed[base]!;
      const dz = focus.z - packed[base + 1]!;
      const along = Math.abs(dx * sine + dz * cosine);
      const across = Math.abs(dx * cosine - dz * sine);
      const farAlong = (along + radius) ** 2;
      const farAcross = (across + radius) ** 2;
      // A part in a million keeps rounding off the boundaries.
      if ((farAlong * inverseA2 + farAcross * inverseB2) * (1 + 1e-6) <= 1) {
        constant *= 1 - depth;
        continue;
      }
      const nearAlong = along > radius ? (along - radius) ** 2 : 0;
      const nearAcross = across > radius ? (across - radius) ** 2 : 0;
      const leastF = nearAlong * inverseA2 + nearAcross * inverseB2 - 1;
      const greatestGradient = 2 * Math.sqrt(farAlong * inverseA2 * inverseA2 + farAcross * inverseB2 * inverseB2);
      if (leastF > 0 && (leastF / greatestGradient) * packed[base + 7]! * (1 - 1e-6) >= 1) continue;
      constant = Number.NaN;
      break;
    }
    this.shelterConstant = constant;
    this.shelterDiskX = focus.x;
    this.shelterDiskZ = focus.z;
    this.shelterDiskRadiusSquared = radius * radius;
    this.shelterClassified = true;
  }

  private ensureExpansion(): void {
    if (this.expansionValid) return;
    const { long, expansion, cascadeHeights, focus, time } = this;
    expansion.fill(0);
    cascadeHeights.fill(0);
    for (let cascade = 0; cascade < cascadeHeights.length; cascade += 1) {
      if (long.start[cascade] === long.start[cascade + 1]) continue;
      let age = time - this.blockTime[cascade]!;
      let driftX = focus.x - this.blockX[cascade]!;
      let driftZ = focus.z - this.blockZ[cascade]!;
      const maxDrift = this.blockMaxDrift[cascade]!;
      if (this.blockBuilt[cascade] === 0 || !(age >= 0 && age < this.blockMaxAge[cascade]!)
        || driftX * driftX + driftZ * driftZ > maxDrift * maxDrift) {
        this.buildBlock(cascade);
        age = 0;
        driftX = 0;
        driftZ = 0;
      }
      cascadeHeights[cascade] = addCarriedBlock(this.blocks[cascade]!, age, driftX, driftZ, expansion);
    }
    this.expansionX = focus.x;
    this.expansionZ = focus.z;
    this.expansionValid = true;
  }

  /** One cascade's expansion about the focus, now. */
  private buildBlock(cascade: number): void {
    const { long, focus } = this;
    const block = this.blocks[cascade]!;
    const clockRe = long.clock.re;
    const clockIm = long.clock.im;
    const { kx: kxs, kz: kzs, chopX, chopZ, omega: omegas, ix: ixs, iz: izs } = long;
    const { omegaChopX, omegaChopZ, omega2, omega2ChopX, omega2ChopZ } = long;
    const powers = this.longPowers[cascade]!;
    powers.setPosition(focus.x, focus.z);
    const { xRe, xIm, zRe, zIm } = powers;
    let h0 = 0; let h1 = 0; let h2 = 0; let h3 = 0; let h4 = 0; let h5 = 0;
    let x0 = 0; let x1 = 0; let x2 = 0; let x3 = 0; let x4 = 0; let x5 = 0;
    let z0 = 0; let z1 = 0; let z2 = 0; let z3 = 0; let z4 = 0; let z5 = 0;
    let w0 = 0; let w1 = 0; let w2 = 0; let w3 = 0; let w4 = 0; let w5 = 0;
    let u0 = 0; let u1 = 0; let u2 = 0; let u3 = 0; let u4 = 0; let u5 = 0;
    let v0 = 0; let v1 = 0; let v2 = 0; let v3 = 0; let v4 = 0; let v5 = 0;
    let wRate = 0; let uxRate = 0; let uzRate = 0;
    const last = long.start[cascade + 1]!;
    for (let index = long.start[cascade]!; index < last; index += 1) {
      const ix = ixs[index]!;
      const iz = izs[index]!;
      // e^{i k.p} = (e^{2 pi i x/L})^fx (e^{2 pi i z/L})^fy
      const pxRe = xRe[ix]!;
      const pxIm = xIm[ix]!;
      const pzRe = zRe[iz]!;
      const pzIm = zIm[iz]!;
      const spaceRe = pxRe * pzRe - pxIm * pzIm;
      const spaceIm = pxRe * pzIm + pxIm * pzRe;
      const tRe = clockRe[index]!;
      const tIm = clockIm[index]!;
      const a = tRe * spaceRe - tIm * spaceIm;
      const b = tRe * spaceIm + tIm * spaceRe;
      const kx = kxs[index]!;
      const kz = kzs[index]!;
      // Terms of q e^{i k.r} to second order: q, i kx q, i kz q,
      // -kx^2 q / 2, -kx kz q, -kz^2 q / 2; real parts r*, imaginary i*.
      const r1 = -kx * b;
      const i1 = kx * a;
      const r2 = -kz * b;
      const i2 = kz * a;
      const cxx = -0.5 * kx * kx;
      const cxz = -kx * kz;
      const czz = -0.5 * kz * kz;
      const r3 = cxx * a;
      const i3 = cxx * b;
      const r4 = cxz * a;
      const i4 = cxz * b;
      const r5 = czz * a;
      const i5 = czz * b;
      h0 += a; h1 += r1; h2 += r2; h3 += r3; h4 += r4; h5 += r5;
      // D = Re(-i chop q) = chop Im(q)
      const cx = chopX[index]!;
      const cz = chopZ[index]!;
      x0 += cx * b; x1 += cx * i1; x2 += cx * i2; x3 += cx * i3; x4 += cx * i4; x5 += cx * i5;
      z0 += cz * b; z1 += cz * i1; z2 += cz * i2; z3 += cz * i3; z4 += cz * i4; z5 += cz * i5;
      // w = dh/dt = Re(i s w q) = -s w Im(q); u = dD/dt = s w chop Re(q)
      const omega = omegas[index]!;
      w0 -= omega * b; w1 -= omega * i1; w2 -= omega * i2; w3 -= omega * i3; w4 -= omega * i4; w5 -= omega * i5;
      const ox = omegaChopX[index]!;
      const oz = omegaChopZ[index]!;
      u0 += ox * a; u1 += ox * r1; u2 += ox * r2; u3 += ox * r3; u4 += ox * r4; u5 += ox * r5;
      v0 += oz * a; v1 += oz * r1; v2 += oz * r2; v3 += oz * r3; v4 += oz * r4; v5 += oz * r5;
      // dw/dt = -w^2 Re(q); du/dt = -w^2 chop Im(q)
      wRate -= omega2[index]! * a;
      uxRate -= omega2ChopX[index]! * b;
      uzRate -= omega2ChopZ[index]! * b;
    }
    block[H] = h0; block[H + 1] = h1; block[H + 2] = h2;
    block[H + 3] = h3; block[H + 4] = h4; block[H + 5] = h5;
    block[DX] = x0; block[DX + 1] = x1; block[DX + 2] = x2;
    block[DX + 3] = x3; block[DX + 4] = x4; block[DX + 5] = x5;
    block[DZ] = z0; block[DZ + 1] = z1; block[DZ + 2] = z2;
    block[DZ + 3] = z3; block[DZ + 4] = z4; block[DZ + 5] = z5;
    block[W] = w0; block[W + 1] = w1; block[W + 2] = w2;
    block[W + 3] = w3; block[W + 4] = w4; block[W + 5] = w5;
    block[UX] = u0; block[UX + 1] = u1; block[UX + 2] = u2;
    block[UX + 3] = u3; block[UX + 4] = u4; block[UX + 5] = u5;
    block[UZ] = v0; block[UZ + 1] = v1; block[UZ + 2] = v2;
    block[UZ + 3] = v3; block[UZ + 4] = v4; block[UZ + 5] = v5;
    block[BLOCK_W_RATE] = wRate;
    block[BLOCK_UX_RATE] = uxRate;
    block[BLOCK_UZ_RATE] = uzRate;
    this.blockTime[cascade] = this.time;
    this.blockX[cascade] = focus.x;
    this.blockZ[cascade] = focus.z;
    this.blockBuilt[cascade] = 1;
  }

  private ensureGrid(): void {
    const { focus } = this;
    const age = this.time - this.gridTime;
    if (this.gridValid && age >= 0 && age < GRID_MAX_AGE_SECONDS && this.gridHolds(focus)) return;
    const alongX = this.focusAlongX;
    const alongZ = this.focusAlongZ;
    // Across is along turned a quarter: (cos, -sin).
    const acrossX = alongZ;
    const acrossZ = -alongX;
    // Stretch the grid over where the hull will be by the next rebuild, so a
    // boat under way does not outrun it.
    let leadX = this.focusVelocityX * GRID_MAX_AGE_SECONDS;
    let leadZ = this.focusVelocityZ * GRID_MAX_AGE_SECONDS;
    const lead = Math.hypot(leadX, leadZ);
    if (lead > GRID_LEAD_LIMIT_METERS) {
      leadX *= GRID_LEAD_LIMIT_METERS / lead;
      leadZ *= GRID_LEAD_LIMIT_METERS / lead;
    }
    const halfAlong = focus.halfLength + GRID_MARGIN_METERS + 0.5 * Math.abs(leadX * alongX + leadZ * alongZ);
    const halfAcross = focus.halfBeam + GRID_MARGIN_METERS + 0.5 * Math.abs(leadX * acrossX + leadZ * acrossZ);
    const centerX = focus.x + 0.5 * leadX;
    const centerZ = focus.z + 0.5 * leadZ;
    const stepAlong = (2 * halfAlong) / (SEA_TWIN_GRID_ALONG - 1);
    const stepAcross = (2 * halfAcross) / (SEA_TWIN_GRID_ACROSS - 1);
    const corner = this.gridPowers;
    const stepA = this.gridStepAlongPowers;
    const stepC = this.gridStepAcrossPowers;
    corner.setPosition(centerX - halfAlong * alongX - halfAcross * acrossX, centerZ - halfAlong * alongZ - halfAcross * acrossZ);
    stepA.setOffset(stepAlong * alongX, stepAlong * alongZ);
    stepC.setOffset(stepAcross * acrossX, stepAcross * acrossZ);
    const { grid, nodes } = this;
    const count = grid.count;
    const clockRe = grid.clock.re;
    const clockIm = grid.clock.im;
    const rowRe = this.gridRowRe;
    const rowIm = this.gridRowIm;
    const currentRe = this.gridCurrentRe;
    const currentIm = this.gridCurrentIm;
    const acrossRe = this.gridAcrossRe;
    const acrossIm = this.gridAcrossIm;
    const alongRe = this.gridAlongRe;
    const alongIm = this.gridAlongIm;
    const kas = this.gridKa;
    const kcs = this.gridKc;
    const kacs = this.gridKac;
    const omegaKas = this.gridOmegaKa;
    const omegaKcs = this.gridOmegaKc;
    const omegaKacs = this.gridOmegaKac;
    const { kx: kxs, kz: kzs, chopX, chopZ, omega: omegas, omega2, ix: ixs, iz: izs } = grid;
    const { omegaChopX, omegaChopZ, omega2ChopX, omega2ChopZ } = grid;
    // Each wave's phasor at the first node, its steps along and across, and
    // its wavenumber in the hull frame.
    for (let index = 0; index < count; index += 1) {
      const ix = ixs[index]!;
      const iz = izs[index]!;
      let re = corner.xRe[ix]! * corner.zRe[iz]! - corner.xIm[ix]! * corner.zIm[iz]!;
      let im = corner.xRe[ix]! * corner.zIm[iz]! + corner.xIm[ix]! * corner.zRe[iz]!;
      const tRe = clockRe[index]!;
      const tIm = clockIm[index]!;
      rowRe[index] = tRe * re - tIm * im;
      rowIm[index] = tRe * im + tIm * re;
      re = stepA.xRe[ix]! * stepA.zRe[iz]! - stepA.xIm[ix]! * stepA.zIm[iz]!;
      im = stepA.xRe[ix]! * stepA.zIm[iz]! + stepA.xIm[ix]! * stepA.zRe[iz]!;
      alongRe[index] = re;
      alongIm[index] = im;
      acrossRe[index] = stepC.xRe[ix]! * stepC.zRe[iz]! - stepC.xIm[ix]! * stepC.zIm[iz]!;
      acrossIm[index] = stepC.xRe[ix]! * stepC.zIm[iz]! + stepC.xIm[ix]! * stepC.zRe[iz]!;
      const ka = kxs[index]! * alongX + kzs[index]! * alongZ;
      const kc = kxs[index]! * acrossX + kzs[index]! * acrossZ;
      const omega = omegas[index]!;
      kas[index] = ka;
      kcs[index] = kc;
      kacs[index] = ka * kc;
      omegaKas[index] = omega * ka;
      omegaKcs[index] = omega * kc;
      omegaKacs[index] = omega * ka * kc;
    }
    // Two across-neighbours per pass: q at the first, q times the across step
    // at the second.
    let slot = 0;
    for (let m = 0; m < SEA_TWIN_GRID_ALONG; m += 1) {
      currentRe.set(rowRe);
      currentIm.set(rowIm);
      for (let l = 0; l < SEA_TWIN_GRID_ACROSS; l += 2) {
        let h = 0; let ha = 0; let hc = 0; let hac = 0;
        let w = 0; let wRate = 0; let haRate = 0; let hcRate = 0;
        let dx = 0; let dz = 0; let ux = 0; let uz = 0; let uxRate = 0; let uzRate = 0; let hacRate = 0;
        let nh = 0; let nha = 0; let nhc = 0; let nhac = 0;
        let nw = 0; let nwRate = 0; let nhaRate = 0; let nhcRate = 0;
        let ndx = 0; let ndz = 0; let nux = 0; let nuz = 0; let nuxRate = 0; let nuzRate = 0; let nhacRate = 0;
        for (let index = 0; index < count; index += 1) {
          const a = currentRe[index]!;
          const b = currentIm[index]!;
          const c = acrossRe[index]!;
          const d = acrossIm[index]!;
          const na = a * c - b * d;
          const nb = a * d + b * c;
          currentRe[index] = na * c - nb * d;
          currentIm[index] = na * d + nb * c;
          const ka = kas[index]!;
          const kc = kcs[index]!;
          const kac = kacs[index]!;
          const omega = omegas[index]!;
          const omegaSquared = omega2[index]!;
          const omegaKa = omegaKas[index]!;
          const omegaKc = omegaKcs[index]!;
          const omegaKac = omegaKacs[index]!;
          const cx = chopX[index]!;
          const cz = chopZ[index]!;
          const ocx = omegaChopX[index]!;
          const ocz = omegaChopZ[index]!;
          const o2cx = omega2ChopX[index]!;
          const o2cz = omega2ChopZ[index]!;
          // h = Re q; d/da = Re(i ka q); d2/da dc = Re(-ka kc q);
          // d/dt = Re(i s w q), so w = -s w b and dw/dt = -w^2 a.
          h += a; ha -= ka * b; hc -= kc * b; hac -= kac * a;
          w -= omega * b; wRate -= omegaSquared * a; haRate -= omegaKa * a; hcRate -= omegaKc * a; hacRate += omegaKac * b;
          // D = Re(-i chop q) = chop b; dD/dt = s w chop a.
          dx += cx * b; dz += cz * b; ux += ocx * a; uz += ocz * a; uxRate -= o2cx * b; uzRate -= o2cz * b;
          nh += na; nha -= ka * nb; nhc -= kc * nb; nhac -= kac * na;
          nw -= omega * nb; nwRate -= omegaSquared * na; nhaRate -= omegaKa * na; nhcRate -= omegaKc * na; nhacRate += omegaKac * nb;
          ndx += cx * nb; ndz += cz * nb; nux += ocx * na; nuz += ocz * na; nuxRate -= o2cx * nb; nuzRate -= o2cz * nb;
        }
        writeNode(nodes, slot, h, ha, hc, hac, w, wRate, haRate, hcRate, dx, dz, ux, uz, uxRate, uzRate, hacRate);
        writeNode(
          nodes, slot + NODE_SIZE, nh, nha, nhc, nhac, nw, nwRate, nhaRate, nhcRate,
          ndx, ndz, nux, nuz, nuxRate, nuzRate, nhacRate,
        );
        slot += 2 * NODE_SIZE;
      }
      if (m + 1 < SEA_TWIN_GRID_ALONG) {
        for (let index = 0; index < count; index += 1) {
          const a = rowRe[index]!;
          const b = rowIm[index]!;
          const c = alongRe[index]!;
          const d = alongIm[index]!;
          rowRe[index] = a * c - b * d;
          rowIm[index] = a * d + b * c;
        }
      }
    }
    this.gridCenterX = centerX;
    this.gridCenterZ = centerZ;
    this.gridAlongX = alongX;
    this.gridAlongZ = alongZ;
    this.gridHalfAlong = halfAlong;
    this.gridHalfAcross = halfAcross;
    this.gridStepAlong = stepAlong;
    this.gridStepAcross = stepAcross;
    this.gridTime = this.time;
    this.gridValid = true;
    this.carriedTime = Number.NaN;
  }

  /** Whether the standing grid still covers the hull footprint at `focus`. */
  private gridHolds(focus: WaveFieldFocus): boolean {
    const alongX = this.focusAlongX;
    const alongZ = this.focusAlongZ;
    const reachAlong = focus.halfLength + COVER_MARGIN_METERS;
    const reachAcross = focus.halfBeam + COVER_MARGIN_METERS;
    for (let corner = 0; corner < 4; corner += 1) {
      const sideA = corner & 1 ? 1 : -1;
      const sideC = corner & 2 ? 1 : -1;
      const x = focus.x + sideA * reachAlong * alongX + sideC * reachAcross * alongZ;
      const z = focus.z + sideA * reachAlong * alongZ - sideC * reachAcross * alongX;
      const offsetX = x - this.gridCenterX;
      const offsetZ = z - this.gridCenterZ;
      const along = offsetX * this.gridAlongX + offsetZ * this.gridAlongZ;
      const across = offsetX * this.gridAlongZ - offsetZ * this.gridAlongX;
      if (Math.abs(along) > this.gridHalfAlong || Math.abs(across) > this.gridHalfAcross) {
        return false;
      }
    }
    return true;
  }

  /** The nodes carried to now: done once a step, so samples only interpolate. */
  private ensureCarried(): void {
    if (this.carriedTime === this.time) return;
    const age = this.time - this.gridTime;
    const half = 0.5 * age * age;
    const n = this.nodes;
    const c = this.carried;
    c.set(n);
    for (let slot = 0; slot < c.length; slot += NODE_SIZE) {
      c[slot + NODE_H] = n[slot + NODE_H]! + age * n[slot + NODE_W]! + half * n[slot + NODE_W_RATE]!;
      c[slot + NODE_HA] = n[slot + NODE_HA]! + age * n[slot + NODE_HA_RATE]!;
      c[slot + NODE_HC] = n[slot + NODE_HC]! + age * n[slot + NODE_HC_RATE]!;
      c[slot + NODE_HAC] = n[slot + NODE_HAC]! + age * n[slot + NODE_HAC_RATE]!;
      c[slot + NODE_W] = n[slot + NODE_W]! + age * n[slot + NODE_W_RATE]!;
      c[slot + NODE_DX] = n[slot + NODE_DX]! + age * n[slot + NODE_UX]! + half * n[slot + NODE_UX_RATE]!;
      c[slot + NODE_DZ] = n[slot + NODE_DZ]! + age * n[slot + NODE_UZ]! + half * n[slot + NODE_UZ_RATE]!;
      c[slot + NODE_UX] = n[slot + NODE_UX]! + age * n[slot + NODE_UX_RATE]!;
      c[slot + NODE_UZ] = n[slot + NODE_UZ]! + age * n[slot + NODE_UZ_RATE]!;
    }
    this.carriedTime = this.time;
  }

  private cellS = 0;
  private cellT = 0;

  /**
   * The grid cell holding a label point: returns its first node's slot and
   * sets `cellS`/`cellT`; `withPatch` also sets the Hermite basis, values and
   * derivatives.
   */
  private gridCell(labelX: number, labelZ: number, withPatch: boolean): number {
    const offsetX = labelX - this.gridCenterX;
    const offsetZ = labelZ - this.gridCenterZ;
    const along = offsetX * this.gridAlongX + offsetZ * this.gridAlongZ + this.gridHalfAlong;
    const across = offsetX * this.gridAlongZ - offsetZ * this.gridAlongX + this.gridHalfAcross;
    const u = Math.min(Math.max(along / this.gridStepAlong, 0), SEA_TWIN_GRID_ALONG - 1);
    const v = Math.min(Math.max(across / this.gridStepAcross, 0), SEA_TWIN_GRID_ACROSS - 1);
    const m = Math.min(Math.floor(u), SEA_TWIN_GRID_ALONG - 2);
    const l = Math.min(Math.floor(v), SEA_TWIN_GRID_ACROSS - 2);
    const s = u - m;
    const t = v - l;
    this.cellS = s;
    this.cellT = t;
    const cell = (m * SEA_TWIN_GRID_ACROSS + l) * NODE_SIZE;
    if (!withPatch) return cell;
    const basis = this.basis;
    const stepA = this.gridStepAlong;
    const stepC = this.gridStepAcross;
    const s2 = s * s;
    const s3 = s2 * s;
    const t2 = t * t;
    const t3 = t2 * t;
    basis[F0S] = 2 * s3 - 3 * s2 + 1;
    basis[F0S + 1] = 3 * s2 - 2 * s3;
    basis[F0S + 2] = (s3 - 2 * s2 + s) * stepA;
    basis[F0S + 3] = (s3 - s2) * stepA;
    basis[F0T] = 2 * t3 - 3 * t2 + 1;
    basis[F0T + 1] = 3 * t2 - 2 * t3;
    basis[F0T + 2] = (t3 - 2 * t2 + t) * stepC;
    basis[F0T + 3] = (t3 - t2) * stepC;
    basis[DF0S] = (6 * s2 - 6 * s) / stepA;
    basis[DF0S + 1] = -basis[DF0S]!;
    basis[DF0S + 2] = 3 * s2 - 4 * s + 1;
    basis[DF0S + 3] = 3 * s2 - 2 * s;
    basis[DF0T] = (6 * t2 - 6 * t) / stepC;
    basis[DF0T + 1] = -basis[DF0T]!;
    basis[DF0T + 2] = 3 * t2 - 4 * t + 1;
    basis[DF0T + 3] = 3 * t2 - 2 * t;
    return cell;
  }

  /** Displacement only, sheltered: all the fixed-point iterations need. */
  private displacementAt(labelX: number, labelZ: number, out: SeaFields): void {
    const e = this.expansion;
    const rx = labelX - this.expansionX;
    const rz = labelZ - this.expansionZ;
    const rxx = rx * rx;
    const rxz = rx * rz;
    const rzz = rz * rz;
    let dx = e[DX]! + e[DX + 1]! * rx + e[DX + 2]! * rz + e[DX + 3]! * rxx + e[DX + 4]! * rxz + e[DX + 5]! * rzz;
    let dz = e[DZ]! + e[DZ + 1]! * rx + e[DZ + 2]! * rz + e[DZ + 3]! * rxx + e[DZ + 4]! * rxz + e[DZ + 5]! * rzz;
    // Cascade 1, bilinear on the grid.
    const i00 = this.gridCell(labelX, labelZ, false);
    const i01 = i00 + NODE_SIZE;
    const i10 = i00 + SEA_TWIN_GRID_ACROSS * NODE_SIZE;
    const i11 = i10 + NODE_SIZE;
    const n = this.carried;
    const s = this.cellS;
    const t = this.cellT;
    const w00 = (1 - s) * (1 - t);
    const w01 = (1 - s) * t;
    const w10 = s * (1 - t);
    const w11 = s * t;
    dx += w00 * n[i00 + NODE_DX]! + w01 * n[i01 + NODE_DX]! + w10 * n[i10 + NODE_DX]! + w11 * n[i11 + NODE_DX]!;
    dz += w00 * n[i00 + NODE_DZ]! + w01 * n[i01 + NODE_DZ]! + w10 * n[i10 + NODE_DZ]! + w11 * n[i11 + NODE_DZ]!;
    if (this.shelter !== null) {
      const shelter = this.shelterFactorAt(labelX, labelZ);
      dx *= shelter;
      dz *= shelter;
    }
    out.dx = dx;
    out.dz = dz;
  }

  /** Every field on the fast path, before shelter. */
  private fastFieldsAt(labelX: number, labelZ: number, out: SeaFields): void {
    const e = this.expansion;
    const rx = labelX - this.expansionX;
    const rz = labelZ - this.expansionZ;
    const rxx = rx * rx;
    const rxz = rx * rz;
    const rzz = rz * rz;
    const rx2 = 2 * rx;
    const rz2 = 2 * rz;
    out.h = e[H]! + e[H + 1]! * rx + e[H + 2]! * rz + e[H + 3]! * rxx + e[H + 4]! * rxz + e[H + 5]! * rzz;
    out.hx = e[H + 1]! + e[H + 3]! * rx2 + e[H + 4]! * rz;
    out.hz = e[H + 2]! + e[H + 4]! * rx + e[H + 5]! * rz2;
    out.dx = e[DX]! + e[DX + 1]! * rx + e[DX + 2]! * rz + e[DX + 3]! * rxx + e[DX + 4]! * rxz + e[DX + 5]! * rzz;
    out.dxx = e[DX + 1]! + e[DX + 3]! * rx2 + e[DX + 4]! * rz;
    out.dxz = e[DX + 2]! + e[DX + 4]! * rx + e[DX + 5]! * rz2;
    out.dz = e[DZ]! + e[DZ + 1]! * rx + e[DZ + 2]! * rz + e[DZ + 3]! * rxx + e[DZ + 4]! * rxz + e[DZ + 5]! * rzz;
    out.dzx = e[DZ + 1]! + e[DZ + 3]! * rx2 + e[DZ + 4]! * rz;
    out.dzz = e[DZ + 2]! + e[DZ + 4]! * rx + e[DZ + 5]! * rz2;
    out.w = e[W]! + e[W + 1]! * rx + e[W + 2]! * rz + e[W + 3]! * rxx + e[W + 4]! * rxz + e[W + 5]! * rzz;
    out.ux = e[UX]! + e[UX + 1]! * rx + e[UX + 2]! * rz + e[UX + 3]! * rxx + e[UX + 4]! * rxz + e[UX + 5]! * rzz;
    out.uz = e[UZ]! + e[UZ + 1]! * rx + e[UZ + 2]! * rz + e[UZ + 3]! * rxx + e[UZ + 4]! * rxz + e[UZ + 5]! * rzz;

    // Cascade 1 from the grid: bicubic patches for height (with its slopes)
    // and vertical velocity, bilinear for displacement and horizontal velocity.
    const i00 = this.gridCell(labelX, labelZ, true);
    const i01 = i00 + NODE_SIZE;
    const i10 = i00 + SEA_TWIN_GRID_ACROSS * NODE_SIZE;
    const i11 = i10 + NODE_SIZE;
    const { carried: n, basis, slopes } = this;
    const alongX = this.gridAlongX;
    const alongZ = this.gridAlongZ;
    out.h += hermitePatch(n, i00, i10, NODE_H, NODE_HA, NODE_HC, NODE_HAC, basis, slopes);
    // Hull frame to world: along = (sin, cos), across = (cos, -sin).
    out.hx += slopes[0]! * alongX + slopes[1]! * alongZ;
    out.hz += slopes[0]! * alongZ - slopes[1]! * alongX;
    out.w += hermitePatch(n, i00, i10, NODE_W, NODE_HA_RATE, NODE_HC_RATE, NODE_HAC_RATE, basis, null);
    const s = this.cellS;
    const t = this.cellT;
    const w00 = (1 - s) * (1 - t);
    const w01 = (1 - s) * t;
    const w10 = s * (1 - t);
    const w11 = s * t;
    const dx00 = n[i00 + NODE_DX]!;
    const dx01 = n[i01 + NODE_DX]!;
    const dx10 = n[i10 + NODE_DX]!;
    const dx11 = n[i11 + NODE_DX]!;
    const dz00 = n[i00 + NODE_DZ]!;
    const dz01 = n[i01 + NODE_DZ]!;
    const dz10 = n[i10 + NODE_DZ]!;
    const dz11 = n[i11 + NODE_DZ]!;
    out.dx += w00 * dx00 + w01 * dx01 + w10 * dx10 + w11 * dx11;
    out.dz += w00 * dz00 + w01 * dz01 + w10 * dz10 + w11 * dz11;
    out.ux += w00 * n[i00 + NODE_UX]! + w01 * n[i01 + NODE_UX]! + w10 * n[i10 + NODE_UX]! + w11 * n[i11 + NODE_UX]!;
    out.uz += w00 * n[i00 + NODE_UZ]! + w01 * n[i01 + NODE_UZ]! + w10 * n[i10 + NODE_UZ]! + w11 * n[i11 + NODE_UZ]!;
    // Jacobian terms of cascade 1's displacement, from the bilinear patch.
    const stepA = this.gridStepAlong;
    const stepC = this.gridStepAcross;
    const dxa = ((1 - t) * (dx10 - dx00) + t * (dx11 - dx01)) / stepA;
    const dxc = ((1 - s) * (dx01 - dx00) + s * (dx11 - dx10)) / stepC;
    const dza = ((1 - t) * (dz10 - dz00) + t * (dz11 - dz01)) / stepA;
    const dzc = ((1 - s) * (dz01 - dz00) + s * (dz11 - dz10)) / stepC;
    out.dxx += dxa * alongX + dxc * alongZ;
    out.dxz += dxa * alongZ - dxc * alongX;
    out.dzx += dza * alongX + dzc * alongZ;
    out.dzz += dza * alongZ - dzc * alongX;
  }

  /**
   * The bed under a footprint point, interpolated from a few samples taken
   * once per footprint: a hull's many water samples cost no bed reads.
   */
  private footprintBed(x: number, z: number): number {
    if (this.bedHeight === null) return Number.NEGATIVE_INFINITY;
    const { focus } = this;
    const driftX = focus.x - this.bedCenterX;
    const driftZ = focus.z - this.bedCenterZ;
    if (!this.bedValid
      || driftX * driftX + driftZ * driftZ > BED_REFRESH_METERS * BED_REFRESH_METERS
      || Math.abs(focus.heading - this.bedHeading) > BED_REFRESH_RADIANS
      || focus.halfLength !== this.bedHalfLength || focus.halfBeam !== this.bedHalfBeam) {
      this.sampleBedGrid();
    }
    const offsetX = x - this.bedCenterX;
    const offsetZ = z - this.bedCenterZ;
    const along = offsetX * this.bedAlongX + offsetZ * this.bedAlongZ + this.bedHalfAlong;
    const across = offsetX * this.bedAlongZ - offsetZ * this.bedAlongX + this.bedHalfAcross;
    const u = Math.min(Math.max((along / (2 * this.bedHalfAlong)) * (BED_GRID_ALONG - 1), 0), BED_GRID_ALONG - 1);
    const v = Math.min(Math.max((across / (2 * this.bedHalfAcross)) * (BED_GRID_ACROSS - 1), 0), BED_GRID_ACROSS - 1);
    const m = Math.min(Math.floor(u), BED_GRID_ALONG - 2);
    const l = Math.min(Math.floor(v), BED_GRID_ACROSS - 2);
    const s = u - m;
    const t = v - l;
    const g = this.bedGrid;
    const i = m * BED_GRID_ACROSS + l;
    const j = i + BED_GRID_ACROSS;
    return (1 - s) * ((1 - t) * g[i]! + t * g[i + 1]!) + s * ((1 - t) * g[j]! + t * g[j + 1]!);
  }

  private sampleBedGrid(): void {
    const { focus } = this;
    const bedHeight = this.bedHeight!;
    const alongX = this.focusAlongX;
    const alongZ = this.focusAlongZ;
    // Reach past the footprint by the refresh distance, so the grid still
    // covers the hull until it is resampled.
    const halfAlong = focus.halfLength + COVER_MARGIN_METERS + BED_REFRESH_METERS;
    const halfAcross = focus.halfBeam + COVER_MARGIN_METERS + BED_REFRESH_METERS;
    for (let m = 0; m < BED_GRID_ALONG; m += 1) {
      const along = -halfAlong + (2 * halfAlong * m) / (BED_GRID_ALONG - 1);
      for (let l = 0; l < BED_GRID_ACROSS; l += 1) {
        const across = -halfAcross + (2 * halfAcross * l) / (BED_GRID_ACROSS - 1);
        this.bedGrid[m * BED_GRID_ACROSS + l] = bedHeight(
          focus.x + along * alongX + across * alongZ,
          focus.z + along * alongZ - across * alongX,
        );
      }
    }
    this.bedCenterX = focus.x;
    this.bedCenterZ = focus.z;
    this.bedHeading = focus.heading;
    this.bedAlongX = alongX;
    this.bedAlongZ = alongZ;
    this.bedHalfAlong = halfAlong;
    this.bedHalfAcross = halfAcross;
    this.bedHalfLength = focus.halfLength;
    this.bedHalfBeam = focus.halfBeam;
    this.bedValid = true;
  }

  /**
   * Height, displacement, their gradients and the particle's velocity at a
   * label point, before shelter: the long cascades from the expansion about the focus, the
   * hull-grid band by summing its waves.
   */
  private pointFieldsAt(labelX: number, labelZ: number, out: SeaFields): void {
    const e = this.expansion;
    const rx = labelX - this.expansionX;
    const rz = labelZ - this.expansionZ;
    const rxx = rx * rx;
    const rxz = rx * rz;
    const rzz = rz * rz;
    const rx2 = 2 * rx;
    const rz2 = 2 * rz;
    let h = e[H]! + e[H + 1]! * rx + e[H + 2]! * rz + e[H + 3]! * rxx + e[H + 4]! * rxz + e[H + 5]! * rzz;
    let hx = e[H + 1]! + e[H + 3]! * rx2 + e[H + 4]! * rz;
    let hz = e[H + 2]! + e[H + 4]! * rx + e[H + 5]! * rz2;
    let dx = e[DX]! + e[DX + 1]! * rx + e[DX + 2]! * rz + e[DX + 3]! * rxx + e[DX + 4]! * rxz + e[DX + 5]! * rzz;
    let dxx = e[DX + 1]! + e[DX + 3]! * rx2 + e[DX + 4]! * rz;
    let dxz = e[DX + 2]! + e[DX + 4]! * rx + e[DX + 5]! * rz2;
    let dz = e[DZ]! + e[DZ + 1]! * rx + e[DZ + 2]! * rz + e[DZ + 3]! * rxx + e[DZ + 4]! * rxz + e[DZ + 5]! * rzz;
    let dzx = e[DZ + 1]! + e[DZ + 3]! * rx2 + e[DZ + 4]! * rz;
    let dzz = e[DZ + 2]! + e[DZ + 4]! * rx + e[DZ + 5]! * rz2;
    let w = e[W]! + e[W + 1]! * rx + e[W + 2]! * rz + e[W + 3]! * rxx + e[W + 4]! * rxz + e[W + 5]! * rzz;
    let ux = e[UX]! + e[UX + 1]! * rx + e[UX + 2]! * rz + e[UX + 3]! * rxx + e[UX + 4]! * rxz + e[UX + 5]! * rzz;
    let uz = e[UZ]! + e[UZ + 1]! * rx + e[UZ + 2]! * rz + e[UZ + 3]! * rxx + e[UZ + 4]! * rxz + e[UZ + 5]! * rzz;
    const set = this.grid;
    const clockRe = set.clock.re;
    const clockIm = set.clock.im;
    const { kx: kxs, kz: kzs, chopX, chopZ, omega: omegas, omegaChopX, omegaChopZ, ix: ixs, iz: izs } = set;
    for (let cascade = 0; cascade < this.exactPowers.length; cascade += 1) {
      const first = set.start[cascade]!;
      const last = set.start[cascade + 1]!;
      if (first === last) continue;
      const powers = this.exactPowers[cascade]!;
      powers.setPosition(labelX, labelZ);
      const { xRe, xIm, zRe, zIm } = powers;
      for (let index = first; index < last; index += 1) {
        const ix = ixs[index]!;
        const iz = izs[index]!;
        const pRe = xRe[ix]! * zRe[iz]! - xIm[ix]! * zIm[iz]!;
        const pIm = xRe[ix]! * zIm[iz]! + xIm[ix]! * zRe[iz]!;
        const tRe = clockRe[index]!;
        const tIm = clockIm[index]!;
        const a = tRe * pRe - tIm * pIm;
        const b = tRe * pIm + tIm * pRe;
        const kx = kxs[index]!;
        const kz = kzs[index]!;
        const cx = chopX[index]!;
        const cz = chopZ[index]!;
        h += a;
        hx -= kx * b;
        hz -= kz * b;
        dx += cx * b;
        dz += cz * b;
        dxx += cx * kx * a;
        dxz += cx * kz * a;
        dzx += cz * kx * a;
        dzz += cz * kz * a;
        w -= omegas[index]! * b;
        ux += omegaChopX[index]! * a;
        uz += omegaChopZ[index]! * a;
      }
    }
    out.h = h;
    out.hx = hx;
    out.hz = hz;
    out.dx = dx;
    out.dz = dz;
    out.dxx = dxx;
    out.dxz = dxz;
    out.dzx = dzx;
    out.dzz = dzz;
    out.w = w;
    out.ux = ux;
    out.uz = uz;
  }

  /** Every field by summing every kept wave, before shelter. */
  private exactFieldsAt(labelX: number, labelZ: number, out: SeaFields): void {
    clearSeaFields(out);
    for (const set of [this.grid, this.long]) {
      const clockRe = set.clock.re;
      const clockIm = set.clock.im;
      const { kx: kxs, kz: kzs, chopX, chopZ, omega: omegas, ix: ixs, iz: izs } = set;
      for (let cascade = 0; cascade < this.exactPowers.length; cascade += 1) {
        const first = set.start[cascade]!;
        const last = set.start[cascade + 1]!;
        if (first === last) continue;
        const powers = this.exactPowers[cascade]!;
        powers.setPosition(labelX, labelZ);
        const { xRe, xIm, zRe, zIm } = powers;
        for (let index = first; index < last; index += 1) {
          const ix = ixs[index]!;
          const iz = izs[index]!;
          const pRe = xRe[ix]! * zRe[iz]! - xIm[ix]! * zIm[iz]!;
          const pIm = xRe[ix]! * zIm[iz]! + xIm[ix]! * zRe[iz]!;
          const tRe = clockRe[index]!;
          const tIm = clockIm[index]!;
          const a = tRe * pRe - tIm * pIm;
          const b = tRe * pIm + tIm * pRe;
          const kx = kxs[index]!;
          const kz = kzs[index]!;
          const cx = chopX[index]!;
          const cz = chopZ[index]!;
          const omega = omegas[index]!;
          out.h += a;
          out.hx -= kx * b;
          out.hz -= kz * b;
          out.dx += cx * b;
          out.dz += cz * b;
          out.dxx += cx * kx * a;
          out.dxz += cx * kz * a;
          out.dzx += cz * kx * a;
          out.dzz += cz * kz * a;
          out.w -= omega * b;
          out.ux += omega * cx * a;
          out.uz += omega * cz * a;
        }
      }
    }
  }

  /**
   * Shelter, height, normal and velocity at the label point the fixed point
   * found, from that point's raw (unsheltered) fields.
   */
  private finish(
    x: number,
    z: number,
    labelX: number,
    labelZ: number,
    fields: SeaFields,
    bed: number,
    out: WaterSurfaceSample,
  ): WaterSurfaceSample {
    const field = this.shelterAt(labelX, labelZ);
    const s = field[0]!;
    const sx = field[1]!;
    const sz = field[2]!;
    const rawDx = fields.dx;
    const rawDz = fields.dz;
    const h = s * fields.h;
    const hx = s * fields.hx + sx * fields.h;
    const hz = s * fields.hz + sz * fields.h;
    // J = I + d(sD)/dx0, then grad_x eta = grad_x0 eta J^-1.
    const jxx = 1 + s * fields.dxx + sx * rawDx;
    const jxz = s * fields.dxz + sz * rawDx;
    const jzx = s * fields.dzx + sx * rawDz;
    const jzz = 1 + s * fields.dzz + sz * rawDz;
    const determinant = jxx * jzz - jxz * jzx;
    const safe = Math.abs(determinant) > 0.05 ? determinant : (determinant < 0 ? -0.05 : 0.05);
    const slopeX = (hx * jzz - hz * jzx) / safe;
    const slopeZ = (hz * jxx - hx * jxz) / safe;
    const inverseLength = 1 / Math.sqrt(slopeX * slopeX + 1 + slopeZ * slopeZ);
    out.kind = "sea";
    out.stillHeight = this.seaLevel;
    out.height = this.seaLevel + h;
    out.normal.x = -slopeX * inverseLength;
    out.normal.y = inverseLength;
    out.normal.z = -slopeZ * inverseLength;
    out.velocity.x = s * fields.ux;
    out.velocity.y = s * fields.w;
    out.velocity.z = s * fields.uz;
    const depth = this.seaLevel - bed;
    if (Number.isFinite(depth) && depth <= 0) {
      out.kind = "none";
      out.height = bed;
      out.depth = 0;
      out.velocity.x = 0;
      out.velocity.y = 0;
      out.velocity.z = 0;
      out.normal.x = 0;
      out.normal.y = 1;
      out.normal.z = 0;
    } else {
      out.depth = Number.isFinite(depth) ? depth : this.config.representativeDepthMeters;
    }
    return out;
  }
}

/**
 * The twin for a session: the world's sea under the session's weather, the
 * same inputs the renderer's ocean is built from. The lead's worker hook calls
 * `setTime(state.simulationTime)` and `setFocus` once per step, and
 * `setConfig(resolveSeaSpectrumConfig(world, weather))` on a preset change.
 */
export function createSeaTwin(
  world: SeaWorld & { readonly seaLevel: number },
  weather: WeatherPreset,
  bedHeight?: (x: number, z: number) => number,
): SeaTwin {
  return new SeaTwin(resolveSeaSpectrumConfig(world, weather), {
    seaLevel: world.seaLevel,
    ...(bedHeight ? { bedHeight } : {}),
  });
}
