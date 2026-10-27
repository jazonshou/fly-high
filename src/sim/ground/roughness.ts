/**
 * Ground rougher than the terrain lattice's 2 m (land plan, "Tyre contact"):
 * a deterministic road profile keyed by world position, so a bump is always
 * in the same place and both tyres of an axle meet different ones.
 *
 * ISO 8608 gives road profiles a displacement spectrum G(n) proportional to
 * n^-2 (n cycles per metre). The profile here is a sum of sinusoids in fixed
 * directions at log-spaced wavelengths from 0.5 m to 4 m, the band under
 * what the lattice resolves; with log spacing each component's share of the
 * spectrum is proportional to its wavelength, so its amplitude goes as the
 * wavelength's square root. The sum has unit RMS; the surface's `roughness`
 * scales it to a few millimetres on gravel and a few centimetres on rock.
 */

const COMPONENTS = 8;
const SHORTEST_METERS = 0.5;
const LONGEST_METERS = 4;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const DIR_X = new Float64Array(COMPONENTS);
const DIR_Z = new Float64Array(COMPONENTS);
const WAVENUMBER = new Float64Array(COMPONENTS);
const PHASE = new Float64Array(COMPONENTS);
const AMPLITUDE = new Float64Array(COMPONENTS);

{
  let power = 0;
  // A fixed LCG for the phases: the profile is part of the world, the same every run.
  let seed = 0x2545f491;
  for (let i = 0; i < COMPONENTS; i += 1) {
    const wavelength = SHORTEST_METERS * Math.pow(LONGEST_METERS / SHORTEST_METERS, i / (COMPONENTS - 1));
    const angle = i * GOLDEN_ANGLE;
    DIR_X[i] = Math.cos(angle);
    DIR_Z[i] = Math.sin(angle);
    WAVENUMBER[i] = (2 * Math.PI) / wavelength;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    PHASE[i] = (seed / 2 ** 32) * 2 * Math.PI;
    AMPLITUDE[i] = Math.sqrt(wavelength);
    power += (AMPLITUDE[i]! * AMPLITUDE[i]!) / 2;
  }
  const scale = 1 / Math.sqrt(power);
  for (let i = 0; i < COMPONENTS; i += 1) AMPLITUDE[i] = AMPLITUDE[i]! * scale;
}

/** A point on the profile: where, and the unit-RMS height there. */
export interface RoughnessPoint {
  x: number;
  z: number;
  height: number;
}

/** The unit-RMS profile height at (`at.x`, `at.z`), into `at.height`. */
export function roughnessProfile(at: RoughnessPoint): void {
  const x = at.x;
  const z = at.z;
  let height = 0;
  for (let i = 0; i < COMPONENTS; i += 1) {
    height += AMPLITUDE[i]! * Math.sin(WAVENUMBER[i]! * (DIR_X[i]! * x + DIR_Z[i]! * z) + PHASE[i]!);
  }
  at.height = height;
}
