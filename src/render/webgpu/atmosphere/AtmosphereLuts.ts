import type { AtmosphereState } from "@/src/render/webgpu/nature/EnvironmentState";

/**
 * Atmosphere transmittance and multiple-scattering LUTs (1C-3), Bruneton/
 * Hillaire-style, with the TypeScript evaluation as the source of truth.
 *
 * INVARIANT THIS FILE OWNS: the CPU path IS the LUT. Both textures are baked
 * here, once, from the same functions exposure, the IBL spherical-harmonics
 * bake, and the CI agreement tests consume — so the GPU samples and the CPU
 * mirror cannot disagree (they are the same numbers). Deviation from the
 * plan's WGSL compute bake, recorded: the atmosphere coefficients are
 * constants in Phase 1 (turbidity rides the weather uniforms, not the
 * profile), so a startup CPU bake (~20 ms once) replaces compute plumbing
 * and makes the 1% agreement bound exact by construction.
 *
 * Class P: no Babylon import. The renderer uploads `data` as an rgba16float
 * texture; WGSL reproduces `transmittanceLutUv` verbatim.
 */

export const TRANSMITTANCE_LUT_WIDTH = 256;
export const TRANSMITTANCE_LUT_HEIGHT = 64;
export const MULTIPLE_SCATTERING_LUT_SIZE = 32;

/** Rayleigh and Mie exponential scale heights, metres (standard atmosphere). */
export const RAYLEIGH_SCALE_HEIGHT_METERS = 8_000;
export const MIE_SCALE_HEIGHT_METERS = 1_200;
/** The ozone tent: centred at 25 km, zero at ±15 km. */
export const OZONE_CENTER_METERS = 25_000;
export const OZONE_HALF_WIDTH_METERS = 15_000;

const TRANSMITTANCE_STEPS = 40;

export interface BakedLut {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA float quadruples (alpha 1), ready for rgba16float upload. */
  readonly data: Float32Array;
}

export function rayleighDensity(altitudeMeters: number): number {
  return Math.exp(-Math.max(altitudeMeters, 0) / RAYLEIGH_SCALE_HEIGHT_METERS);
}

export function mieDensity(altitudeMeters: number): number {
  return Math.exp(-Math.max(altitudeMeters, 0) / MIE_SCALE_HEIGHT_METERS);
}

export function ozoneDensity(altitudeMeters: number): number {
  return Math.max(
    0,
    1 - Math.abs(altitudeMeters - OZONE_CENTER_METERS) / OZONE_HALF_WIDTH_METERS,
  );
}

/**
 * Distance along a ray from altitude `h` with direction cosine `mu` to the
 * top of the atmosphere, on the spherical planet.
 */
export function distanceToAtmosphereTop(
  atmosphere: AtmosphereState,
  altitudeMeters: number,
  cosZenith: number,
): number {
  const r = atmosphere.planetRadiusMeters + Math.max(altitudeMeters, 0);
  const top = atmosphere.atmosphereRadiusMeters;
  const discriminant = r * r * (cosZenith * cosZenith - 1) + top * top;
  return Math.max(0, -r * cosZenith + Math.sqrt(Math.max(discriminant, 0)));
}

/**
 * Spectral transmittance from altitude toward the sky along direction cosine
 * `cosZenith`, marched over the spherical atmosphere. `steps` defaults to
 * the LUT bake's 40; the agreement test raises it for the reference.
 */
export function evaluateTransmittance(
  atmosphere: AtmosphereState,
  altitudeMeters: number,
  cosZenith: number,
  steps = TRANSMITTANCE_STEPS,
): [number, number, number] {
  const pathLength = distanceToAtmosphereTop(atmosphere, altitudeMeters, cosZenith);
  if (pathLength <= 0) return [1, 1, 1];
  const stepLength = pathLength / steps;
  const r0 = atmosphere.planetRadiusMeters + Math.max(altitudeMeters, 0);
  let opticalRayleigh = 0;
  let opticalMie = 0;
  let opticalOzone = 0;
  for (let step = 0; step < steps; step += 1) {
    const t = (step + 0.5) * stepLength;
    const radius = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * cosZenith);
    const altitude = radius - atmosphere.planetRadiusMeters;
    opticalRayleigh += rayleighDensity(altitude) * stepLength;
    opticalMie += mieDensity(altitude) * stepLength;
    opticalOzone += ozoneDensity(altitude) * stepLength;
  }
  const transmittance: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const tau =
      atmosphere.rayleighScatteringPerMeter[channel]! * opticalRayleigh
      + atmosphere.mieExtinctionPerMeter[channel]! * opticalMie
      + atmosphere.absorptionExtinctionPerMeter[channel]! * opticalOzone;
    transmittance[channel] = Math.exp(-tau);
  }
  return transmittance;
}

/**
 * The LUT parameterisation, reproduced verbatim in WGSL: u maps the zenith
 * cosine over [-0.2, 1] (a little below the horizon so low-sun lookups do
 * not clamp), v maps sqrt-altitude over the atmosphere shell for near-ground
 * resolution.
 */
export function transmittanceLutUv(
  atmosphere: AtmosphereState,
  altitudeMeters: number,
  cosZenith: number,
): { u: number; v: number } {
  const shell = atmosphere.atmosphereRadiusMeters - atmosphere.planetRadiusMeters;
  const clampedAltitude = Math.min(Math.max(altitudeMeters, 0), shell);
  return {
    u: Math.min(1, Math.max(0, (cosZenith + 0.2) / 1.2)),
    v: Math.sqrt(clampedAltitude / shell),
  };
}

export function bakeTransmittanceLut(atmosphere: AtmosphereState): BakedLut {
  const width = TRANSMITTANCE_LUT_WIDTH;
  const height = TRANSMITTANCE_LUT_HEIGHT;
  const shell = atmosphere.atmosphereRadiusMeters - atmosphere.planetRadiusMeters;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const altitude = v * v * shell;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const cosZenith = u * 1.2 - 0.2;
      const transmittance = evaluateTransmittance(atmosphere, altitude, cosZenith);
      const offset = (y * width + x) * 4;
      data[offset] = transmittance[0];
      data[offset + 1] = transmittance[1];
      data[offset + 2] = transmittance[2];
      data[offset + 3] = 1;
    }
  }
  return { width, height, data };
}

/** Bilinear CPU sample of a baked LUT — the mirror consumers use. */
export function sampleLut(
  lut: BakedLut,
  u: number,
  v: number,
): [number, number, number] {
  const x = Math.min(Math.max(u * lut.width - 0.5, 0), lut.width - 1);
  const y = Math.min(Math.max(v * lut.height - 0.5, 0), lut.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, lut.width - 1);
  const y1 = Math.min(y0 + 1, lut.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number, channel: number) =>
    lut.data[(py * lut.width + px) * 4 + channel]!;
  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const top = at(x0, y0, channel) * (1 - fx) + at(x1, y0, channel) * fx;
    const bottom = at(x0, y1, channel) * (1 - fx) + at(x1, y1, channel) * fx;
    result[channel] = top * (1 - fy) + bottom * fy;
  }
  return result;
}

const ISOTROPIC_PHASE = 1 / (4 * Math.PI);
const MS_DIRECTIONS = 16;
const MS_STEPS = 12;

/**
 * Hillaire-style multiple-scattering factor Ψ(altitude, cosSunZenith): the
 * isotropic radiance a point receives from all higher scattering orders per
 * unit sun illuminance, with the infinite series folded through the
 * transfer-factor geometric sum. Modest sampling — this feeds an ambient
 * term, not an edge.
 */
export function evaluateMultipleScattering(
  atmosphere: AtmosphereState,
  transmittanceLut: BakedLut,
  altitudeMeters: number,
  cosSunZenith: number,
): [number, number, number] {
  const shell = atmosphere.atmosphereRadiusMeters - atmosphere.planetRadiusMeters;
  const luminance: [number, number, number] = [0, 0, 0];
  let transferFactor = 0;
  for (let index = 0; index < MS_DIRECTIONS; index += 1) {
    // Fibonacci sphere directions.
    const cosTheta = 1 - (2 * (index + 0.5)) / MS_DIRECTIONS;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = index * 2.399963229728653;
    const directionY = cosTheta;
    const directionSun = sinTheta * Math.cos(phi);

    const pathLength = distanceToAtmosphereTop(atmosphere, altitudeMeters, directionY);
    const stepLength = pathLength / MS_STEPS;
    let tauR = 0;
    let tauM = 0;
    let tauO = 0;
    for (let step = 0; step < MS_STEPS; step += 1) {
      const t = (step + 0.5) * stepLength;
      const r0 = atmosphere.planetRadiusMeters + Math.max(altitudeMeters, 0);
      const radius = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * directionY);
      const altitude = Math.min(Math.max(radius - atmosphere.planetRadiusMeters, 0), shell);
      const densityR = rayleighDensity(altitude);
      const densityM = mieDensity(altitude);
      const densityO = ozoneDensity(altitude);
      // Transmittance camera→sample per channel (accumulated optical depth).
      const sampleSunCos = Math.min(
        1,
        Math.max(-0.2, cosSunZenith + (directionSun * t) / 1e7),
      );
      const { u, v } = transmittanceLutUv(atmosphere, altitude, sampleSunCos);
      const sunTransmittance = sampleLut(transmittanceLut, u, v);
      for (let channel = 0; channel < 3; channel += 1) {
        const sigmaScatter =
          atmosphere.rayleighScatteringPerMeter[channel]! * densityR
          + atmosphere.mieScatteringPerMeter[channel]! * densityM;
        const pathTau =
          atmosphere.rayleighScatteringPerMeter[channel]! * tauR
          + atmosphere.mieExtinctionPerMeter[channel]! * tauM
          + atmosphere.absorptionExtinctionPerMeter[channel]! * tauO;
        luminance[channel]! +=
          Math.exp(-pathTau)
          * sigmaScatter
          * sunTransmittance[channel]!
          * ISOTROPIC_PHASE
          * stepLength
          / MS_DIRECTIONS;
      }
      // Transfer factor: how much scattered light re-scatters (green proxy).
      const sigmaGreen =
        atmosphere.rayleighScatteringPerMeter[1]! * densityR
        + atmosphere.mieScatteringPerMeter[1]! * densityM;
      const pathTauGreen =
        atmosphere.rayleighScatteringPerMeter[1]! * tauR
        + atmosphere.mieExtinctionPerMeter[1]! * tauM
        + atmosphere.absorptionExtinctionPerMeter[1]! * tauO;
      transferFactor +=
        Math.exp(-pathTauGreen) * sigmaGreen * stepLength / MS_DIRECTIONS;
      tauR += densityR * stepLength;
      tauM += densityM * stepLength;
      tauO += densityO * stepLength;
    }
  }
  const series = 1 / Math.max(1 - Math.min(transferFactor, 0.95), 0.05);
  return [
    luminance[0]! * series,
    luminance[1]! * series,
    luminance[2]! * series,
  ];
}

export function bakeMultipleScatteringLut(
  atmosphere: AtmosphereState,
  transmittanceLut: BakedLut,
): BakedLut {
  const size = MULTIPLE_SCATTERING_LUT_SIZE;
  const shell = atmosphere.atmosphereRadiusMeters - atmosphere.planetRadiusMeters;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const altitude = ((y + 0.5) / size) ** 2 * shell;
    for (let x = 0; x < size; x += 1) {
      const cosSunZenith = ((x + 0.5) / size) * 1.2 - 0.2;
      const psi = evaluateMultipleScattering(
        atmosphere,
        transmittanceLut,
        altitude,
        cosSunZenith,
      );
      const offset = (y * size + x) * 4;
      data[offset] = psi[0];
      data[offset + 1] = psi[1];
      data[offset + 2] = psi[2];
      data[offset + 3] = 1;
    }
  }
  return { width: size, height: size, data };
}
