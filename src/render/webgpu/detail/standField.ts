/**
 * 2-11b — the continuous stand field.
 *
 * INVARIANT THIS FILE OWNS: stand identity — dominant species mix, stand
 * age, and the tint centre `2-12` correlates per-instance colour with — is a
 * low-frequency field evaluated at THE STEM'S OWN WORLD POSITION. There is
 * no block lattice: the old generator drew one `{standAge, dominantChoice}`
 * per 32 m scatter block, putting species identity, stand age and tree
 * height on a hard 32 m grid — invisible while every tree was a cone,
 * glaring once `2-12` gives species distinct silhouettes. As
 * `RENDERING_PLAN.md` §3.5 puts it for density: "Clumping expressed as a
 * field has no centre and no radius, therefore nothing circular to see."
 *
 * The field is two octaves of smooth value noise at stand-scale
 * wavelengths (137 m and 61 m, the second octave rotated 0.37 rad so no
 * lattice line survives axis-aligned). Stand-scale spectral content is
 * INTENDED — stands exist ecologically; what the appearance-spectrum test
 * forbids is structure below the stand band (the 32 m lattice and its
 * harmonics). Class P: deterministic, Node-tested, worker-identical.
 */

import { clamp, smoothstep } from "@/src/world/noise";
import { hashLatticeCoordinates, mixSeed, unitFloatFromHash } from "@/src/world/seed";

export interface StandSample {
  /** 0..1 continuous stand age (old stands: taller, darker, sparser). */
  readonly standAge: number;
  /** 0..1 continuous dominant-species selector for the mix cascade. */
  readonly dominantChoice: number;
  /** 0..1 tint centre — `2-12`'s stand-correlated colour mean. */
  readonly tintCentre: number;
}

/** Shortest intended stand wavelength; the spectrum test's band edge. */
export const STAND_FIELD_MINIMUM_WAVELENGTH_METERS = 61;

const PRIMARY_WAVELENGTH_METERS = 137;
const SECONDARY_WAVELENGTH_METERS = STAND_FIELD_MINIMUM_WAVELENGTH_METERS;
const SECONDARY_ROTATION_RADIANS = 0.37;
const SECONDARY_WEIGHT = 0.35;

function smoothValueNoise(seedHash: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smoothstep(0, 1, x - x0);
  const fz = smoothstep(0, 1, z - z0);
  const corner = (cx: number, cz: number): number =>
    unitFloatFromHash(hashLatticeCoordinates(seedHash, cx, cz));
  const top = corner(x0, z0) * (1 - fx) + corner(x0 + 1, z0) * fx;
  const bottom = corner(x0, z0 + 1) * (1 - fx) + corner(x0 + 1, z0 + 1) * fx;
  return top * (1 - fz) + bottom * fz;
}

function standChannel(seedHash: number, channel: number, x: number, z: number): number {
  const primarySeed = mixSeed(seedHash, 0x51a7d + channel * 3);
  const secondarySeed = mixSeed(seedHash, 0x9c2b1 + channel * 7);
  const primary = smoothValueNoise(
    primarySeed,
    x / PRIMARY_WAVELENGTH_METERS,
    z / PRIMARY_WAVELENGTH_METERS,
  );
  const cosine = Math.cos(SECONDARY_ROTATION_RADIANS);
  const sine = Math.sin(SECONDARY_ROTATION_RADIANS);
  const secondary = smoothValueNoise(
    secondarySeed,
    (x * cosine - z * sine) / SECONDARY_WAVELENGTH_METERS,
    (x * sine + z * cosine) / SECONDARY_WAVELENGTH_METERS,
  );
  // Two-octave blend re-expanded to fill 0..1: the sum of two uniforms
  // concentrates toward the middle, which would compress the species mix.
  const blended = primary * (1 - SECONDARY_WEIGHT) + secondary * SECONDARY_WEIGHT;
  return clamp((blended - 0.5) * 1.7 + 0.5, 0, 1);
}

/** Evaluates the stand field at a stem's world position. */
export function sampleStandField(seedHash: number, x: number, z: number): StandSample {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new RangeError("Stand field position must be finite");
  }
  return {
    standAge: standChannel(seedHash, 0, x, z),
    dominantChoice: standChannel(seedHash, 1, x, z),
    tintCentre: standChannel(seedHash, 2, x, z),
  };
}
