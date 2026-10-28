import {
  RUN_ARM_KEYS,
  RUN_CADENCE_AT_FULL,
  RUN_CADENCE_AT_SWITCH,
  RUN_FAMILY_FOOT_OFF,
  RUN_FAMILY_SPEEDS,
  RUN_KEYS,
  WALK_ARM_KEYS,
  WALK_GROUP_CADENCE,
  WALK_GROUP_FOOT_OFF,
  WALK_GROUP_SPEED,
  WALK_GROUP_STEP,
  WALK_SAMPLES,
  WALK_TABLE,
  type ArmChannel,
  type GaitKeys,
  type RunChannel,
  type WalkChannel,
} from "./gaitData";
import { LEG_LENGTH } from "./figureProportions";
import { PERSON } from "@/src/vehicles/person";

/**
 * The gait as functions of speed and phase: the published curves in
 * `gaitData.ts` stored as short Fourier series per joint (`HARMONICS`
 * harmonics, within 0.6 degree of every walking sample), the walking groups
 * blended by dimensionless speed, the running families by speed, and the
 * cadence and stride that set how fast the phase turns.
 *
 * PHASE. 0..1 through one stride of a leg from its heel strike. The left leg
 * leads (`phase`), the right is half a stride behind.
 */
export const HARMONICS = 8;
const COEFFICIENTS = 2 * HARMONICS + 1;
const GRAVITY = 9.80665;
const TAU = 2 * Math.PI;

/** Fourier coefficients of `samples` (equally spaced over one period): a0, then a1, b1, a2, b2 ... */
export function fourierCoefficients(samples: ArrayLike<number>, harmonics = HARMONICS): Float64Array {
  const n = samples.length;
  const out = new Float64Array(2 * harmonics + 1);
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += samples[i]!;
  out[0] = mean / n;
  for (let k = 1; k <= harmonics; k += 1) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (TAU * k * i) / n;
      a += samples[i]! * Math.cos(angle);
      b += samples[i]! * Math.sin(angle);
    }
    out[2 * k - 1] = (2 * a) / n;
    out[2 * k] = (2 * b) / n;
  }
  return out;
}

/** cos(k 2 pi phase), sin(k 2 pi phase) for k = 1..HARMONICS, into `basis` (the dot product's other half). */
export function harmonicBasis(phase: number, basis: Float64Array): Float64Array {
  const c1 = Math.cos(TAU * phase);
  const s1 = Math.sin(TAU * phase);
  let c = 1;
  let s = 0;
  basis[0] = 1;
  for (let k = 1; k <= HARMONICS; k += 1) {
    // Turn by one more harmonic: (c, s) * (c1, s1).
    const next = c * c1 - s * s1;
    s = s * c1 + c * s1;
    c = next;
    basis[2 * k - 1] = c;
    basis[2 * k] = s;
  }
  return basis;
}

export function createHarmonicBasis(): Float64Array {
  return new Float64Array(COEFFICIENTS);
}

/** A series' value at a basis: the coefficients' dot product with it. */
export function evaluateSeries(coefficients: Float64Array, basis: Float64Array, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < COEFFICIENTS; i += 1) sum += coefficients[offset + i]! * basis[i]!;
  return sum;
}

/** A periodic Catmull-Rom curve through `keys`, sampled `count` times over the stride. */
export function sampleKeys(keys: GaitKeys, count = WALK_SAMPLES): Float64Array {
  const out = new Float64Array(count);
  const n = keys.length;
  for (let i = 0; i < count; i += 1) {
    const phase = i / count;
    let index = n - 1;
    for (let k = 0; k < n; k += 1) {
      if (keys[k]![0]! <= phase) index = k;
    }
    const k0 = keys[(index - 1 + n) % n]!;
    const k1 = keys[index]!;
    const k2 = keys[(index + 1) % n]!;
    const k3 = keys[(index + 2) % n]!;
    // Unwrap the keys' phases around this segment.
    const t1 = k1[0] > phase ? k1[0] - 1 : k1[0];
    let t2 = k2[0];
    while (t2 <= t1) t2 += 1;
    let t0 = k0[0];
    while (t0 >= t1) t0 -= 1;
    let t3 = k3[0];
    while (t3 <= t2) t3 += 1;
    const span = t2 - t1;
    const u = (phase < t1 ? phase + 1 - t1 : phase - t1) / span;
    // Tangents scaled to the segment (non-uniform Catmull-Rom).
    const m1 = ((k2[1] - k0[1]) / (t2 - t0)) * span;
    const m2 = ((k3[1] - k1[1]) / (t3 - t1)) * span;
    const u2 = u * u;
    const u3 = u2 * u;
    out[i] = (2 * u3 - 3 * u2 + 1) * k1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[1] + (u3 - u2) * m2;
  }
  return out;
}

const WALK_CHANNELS = Object.keys(WALK_TABLE) as WalkChannel[];
const RUN_CHANNELS = Object.keys(RUN_KEYS) as RunChannel[];
const ARM_CHANNELS = Object.keys(WALK_ARM_KEYS) as ArmChannel[];

interface GaitSeries {
  /** Per walk channel: groups x COEFFICIENTS. */
  readonly walk: Readonly<Record<WalkChannel, Float64Array>>;
  /** Per run channel: families x COEFFICIENTS. */
  readonly run: Readonly<Record<RunChannel, Float64Array>>;
  readonly walkArms: Readonly<Record<ArmChannel, Float64Array>>;
  readonly runArms: Readonly<Record<ArmChannel, Float64Array>>;
}

let series: GaitSeries | null = null;

/** The fitted series, built once on first use. */
export function gaitSeries(): GaitSeries {
  if (series) return series;
  const walk = {} as Record<WalkChannel, Float64Array>;
  for (const channel of WALK_CHANNELS) {
    const groups = WALK_TABLE[channel];
    const packed = new Float64Array(groups.length * COEFFICIENTS);
    groups.forEach((samples, group) => packed.set(fourierCoefficients(samples), group * COEFFICIENTS));
    walk[channel] = packed;
  }
  const run = {} as Record<RunChannel, Float64Array>;
  for (const channel of RUN_CHANNELS) {
    const families = RUN_KEYS[channel];
    const packed = new Float64Array(families.length * COEFFICIENTS);
    families.forEach((keys, family) => packed.set(fourierCoefficients(sampleKeys(keys)), family * COEFFICIENTS));
    run[channel] = packed;
  }
  const walkArms = {} as Record<ArmChannel, Float64Array>;
  const runArms = {} as Record<ArmChannel, Float64Array>;
  for (const channel of ARM_CHANNELS) {
    walkArms[channel] = fourierCoefficients(sampleKeys(WALK_ARM_KEYS[channel]));
    runArms[channel] = fourierCoefficients(sampleKeys(RUN_ARM_KEYS[channel]));
  }
  series = { walk, run, walkArms, runArms };
  return series;
}

/** Speed over sqrt(g L) for the walker's leg. */
export function dimensionlessSpeed(speed: number): number {
  return speed / Math.sqrt(GRAVITY * LEG_LENGTH);
}

/** Where a dimensionless speed falls among the walking groups: the lower group and the share toward the next. */
export interface GroupBlend {
  lower: number;
  share: number;
}

export function walkGroupBlend(speedHat: number, out: GroupBlend = { lower: 0, share: 0 }): GroupBlend {
  const last = WALK_GROUP_SPEED.length - 1;
  if (speedHat <= WALK_GROUP_SPEED[0]!) {
    out.lower = 0;
    out.share = 0;
    return out;
  }
  for (let group = 0; group < last; group += 1) {
    if (speedHat <= WALK_GROUP_SPEED[group + 1]!) {
      out.lower = group;
      out.share = (speedHat - WALK_GROUP_SPEED[group]!) / (WALK_GROUP_SPEED[group + 1]! - WALK_GROUP_SPEED[group]!);
      return out;
    }
  }
  out.lower = last - 1;
  out.share = 1;
  return out;
}

/** A walking channel at a group blend and a basis (the phase's). */
export function walkChannel(channel: WalkChannel, blend: Readonly<GroupBlend>, basis: Float64Array): number {
  const packed = gaitSeries().walk[channel];
  const a = evaluateSeries(packed, basis, blend.lower * COEFFICIENTS);
  if (blend.share <= 0) return a;
  const b = evaluateSeries(packed, basis, (blend.lower + 1) * COEFFICIENTS);
  return a + (b - a) * blend.share;
}

/** A walking channel's stride mean at a group blend (for the tilts, which are used as swings about it). */
export function walkChannelMean(channel: WalkChannel, blend: Readonly<GroupBlend>): number {
  const packed = gaitSeries().walk[channel];
  const a = packed[blend.lower * COEFFICIENTS]!;
  if (blend.share <= 0) return a;
  return a + (packed[(blend.lower + 1) * COEFFICIENTS]! - a) * blend.share;
}

/** The running families' share for a speed: 0 the jog, 1 the run. */
export function runFamilyShare(speed: number): number {
  const jog = RUN_FAMILY_SPEEDS[0]!;
  const run = RUN_FAMILY_SPEEDS[1]!;
  return Math.min(1, Math.max(0, (speed - jog) / (run - jog)));
}

export function runChannel(channel: RunChannel, share: number, basis: Float64Array): number {
  const packed = gaitSeries().run[channel];
  const a = evaluateSeries(packed, basis, 0);
  if (share <= 0) return a;
  return a + (evaluateSeries(packed, basis, COEFFICIENTS) - a) * share;
}

/** The arms' walking channel scaled about its mean for speed, or the running one. */
export function armChannel(channel: ArmChannel, running: boolean, swingScale: number, basis: Float64Array): number {
  const fitted = running ? gaitSeries().runArms[channel] : gaitSeries().walkArms[channel];
  const mean = fitted[0]!;
  return mean + (evaluateSeries(fitted, basis) - mean) * swingScale;
}

/** How the arms' walking swing grows with dimensionless speed: 1 at the "free" group. */
export function armSwingScale(speedHat: number): number {
  return Math.min(1.5, Math.max(0.25, speedHat / WALK_GROUP_SPEED[2]!));
}

/**
 * Walking cadence, steps per second, at a speed (m/s): the dataset's
 * dimensionless cadence against dimensionless speed, made dimensional with
 * the walker's leg, extended below and above its span as `gaitData.ts` says.
 */
export function walkCadence(speed: number): number {
  const speedHat = Math.max(1e-3, dimensionlessSpeed(speed));
  const scale = Math.sqrt(GRAVITY / LEG_LENGTH);
  const last = WALK_GROUP_SPEED.length - 1;
  if (speedHat <= WALK_GROUP_SPEED[0]!) {
    // The step shortens with the square root of the speed: cadence = v / step.
    const step = WALK_GROUP_STEP[0]! * Math.sqrt(speedHat / WALK_GROUP_SPEED[0]!);
    return (speedHat / step) * scale;
  }
  if (speedHat >= WALK_GROUP_SPEED[last]!) {
    const slope = (WALK_GROUP_CADENCE[last]! - WALK_GROUP_CADENCE[last - 1]!) / (WALK_GROUP_SPEED[last]! - WALK_GROUP_SPEED[last - 1]!);
    return (WALK_GROUP_CADENCE[last]! + slope * (speedHat - WALK_GROUP_SPEED[last]!)) * scale;
  }
  for (let group = 0; group < last; group += 1) {
    if (speedHat <= WALK_GROUP_SPEED[group + 1]!) {
      const share = (speedHat - WALK_GROUP_SPEED[group]!) / (WALK_GROUP_SPEED[group + 1]! - WALK_GROUP_SPEED[group]!);
      return (WALK_GROUP_CADENCE[group]! + (WALK_GROUP_CADENCE[group + 1]! - WALK_GROUP_CADENCE[group]!) * share) * scale;
    }
  }
  return WALK_GROUP_CADENCE[last]! * scale;
}

/** Running cadence, steps per second (ESTIMATE, see `gaitData.ts`). */
export function runCadence(speed: number): number {
  const share = Math.min(1.2, Math.max(0, (speed - PERSON.walkRunSpeed) / (PERSON.runSpeed - PERSON.walkRunSpeed)));
  return (RUN_CADENCE_AT_SWITCH + (RUN_CADENCE_AT_FULL - RUN_CADENCE_AT_SWITCH) * share) / 60;
}

/** Stride length, metres (two steps), walking or running. */
export function strideLength(speed: number, running: boolean): number {
  const cadence = running ? runCadence(speed) : walkCadence(speed);
  return (2 * Math.max(speed, 1e-3)) / cadence;
}

/** The stance share of a stride (heel strike to foot off) at a walking group blend or a running share. */
export function walkFootOff(blend: Readonly<GroupBlend>): number {
  const a = WALK_GROUP_FOOT_OFF[blend.lower]!;
  const b = WALK_GROUP_FOOT_OFF[Math.min(WALK_GROUP_FOOT_OFF.length - 1, blend.lower + 1)]!;
  return a + (b - a) * blend.share;
}

export function runFootOff(share: number): number {
  return RUN_FAMILY_FOOT_OFF[0]! + (RUN_FAMILY_FOOT_OFF[1]! - RUN_FAMILY_FOOT_OFF[0]!) * share;
}
