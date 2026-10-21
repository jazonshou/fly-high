import type { AerialPerspectiveCoefficients } from "./AerialPerspective";
import {
  MIE_SCALE_HEIGHT_METERS,
  OZONE_CENTER_METERS,
  OZONE_HALF_WIDTH_METERS,
  RAYLEIGH_SCALE_HEIGHT_METERS,
} from "./AtmosphereLuts";

/**
 * Sunlight INSIDE the air — how much of the sun reaches a point at some
 * altitude, and how much multiply-scattered skylight that sunlight feeds.
 *
 * Why this exists (the sunset-colour fix): the haze integral used to light
 * every scattering point with ONE sun transmittance, taken at the camera.
 * At sunset that is the most reddened sunlight anywhere in the sky, so the
 * zenith — lit in reality by sunlight that crossed thin high air — was
 * painted with the same deep orange as the horizon, on top of a palette
 * sun colour that was already reddened once. The sky went brown. Real
 * sunsets are blue overhead and gold at the horizon because each point
 * sees its OWN sun: these functions give the integral that, per species,
 * at the altitude where that species actually scatters.
 *
 * Class P: no Babylon import. AerialPerspective's WGSL mirrors the Chapman
 * and ozone functions (the Chapman column for both species at once, from
 * one exponential), pinned by the agreement tests.
 */

/** Must equal EnvironmentState's planet radius; pinned by test. */
export const AERIAL_PLANET_RADIUS_METERS = 6_360_000;

/**
 * The column a ray carries when the planet blocks it — finite so f32 WGSL
 * and the TS mirror agree (exp of minus anything this large is exactly 0).
 */
export const AERIAL_SHADOWED_COLUMN = 1e9;

/**
 * Optical air mass of an exponential species (in scale heights of
 * sea-level density) from `altitudeMeters` toward `cosZenith`, on the
 * spherical planet: the Chapman function times exp(−h/H).
 *
 * Above the horizon: the erfcx upper-bound form, Ch ≈ 2 / (μ + √(μ² +
 * 8/(πX))), X = (R+h)/H — exact at the zenith and at the horizon
 * (√(πX/2)), within 5% between (worst near μ ≈ 0.05). Below it: twice the
 * horizontal column from the ray's tangent point minus the column the ray
 * would have looking back up, and the shadowed column once the tangent
 * point is underground.
 */
export function chapmanColumn(
  scaleHeightMeters: number,
  altitudeMeters: number,
  cosZenith: number,
): number {
  const h = Math.max(altitudeMeters, 0);
  const radius = AERIAL_PLANET_RADIUS_METERS + h;
  const grazing = 8 / (Math.PI * (radius / scaleHeightMeters));
  const decay = Math.exp(-h / scaleHeightMeters);
  // Both sides share the slant toward |μ|: the WGSL evaluates both on every
  // fragment and selects, so it only pays for one of these square roots.
  const slant = (2 / (Math.abs(cosZenith) + Math.sqrt(cosZenith * cosZenith + grazing))) * decay;
  if (cosZenith >= 0) return slant;
  const tangentRadius = radius * Math.sqrt(Math.max(1 - cosZenith * cosZenith, 0));
  if (tangentRadius < AERIAL_PLANET_RADIUS_METERS) return AERIAL_SHADOWED_COLUMN;
  const tangent = Math.sqrt((Math.PI * tangentRadius) / (2 * scaleHeightMeters))
    * Math.exp(-(tangentRadius - AERIAL_PLANET_RADIUS_METERS) / scaleHeightMeters);
  return 2 * tangent - slant;
}

/** Vertical ozone column above an altitude: the tent's area left overhead. */
function ozoneColumnAbove(altitudeMeters: number): number {
  const lower = OZONE_CENTER_METERS - OZONE_HALF_WIDTH_METERS;
  const upper = OZONE_CENTER_METERS + OZONE_HALF_WIDTH_METERS;
  const h = Math.min(Math.max(altitudeMeters, lower), upper);
  if (h <= OZONE_CENTER_METERS) {
    const x = h - lower;
    return OZONE_HALF_WIDTH_METERS - (x * x) / (2 * OZONE_HALF_WIDTH_METERS);
  }
  const x = upper - h;
  return (x * x) / (2 * OZONE_HALF_WIDTH_METERS);
}

/**
 * Ozone column (metres of unit density) toward `cosZenith`: the overhead
 * column slanted through a thin shell at the layer's centre (or at the
 * point itself once above it). Ozone barely moves the day sky; it is what
 * keeps a low-sun zenith blue rather than grey (Chappuis absorption).
 */
export function ozoneSunColumn(altitudeMeters: number, cosZenith: number): number {
  const h = Math.max(altitudeMeters, 0);
  const shell = AERIAL_PLANET_RADIUS_METERS + Math.max(OZONE_CENTER_METERS, h);
  const ratio = (AERIAL_PLANET_RADIUS_METERS + h) / shell;
  const squaredSine = ratio * ratio * Math.max(1 - cosZenith * cosZenith, 0);
  return ozoneColumnAbove(h) / Math.sqrt(Math.max(1 - squaredSine, 1e-3));
}

/** Spectral optical depth from a point to the sun, through the turbid air. */
export function sunOpticalDepthAt(
  coefficients: AerialPerspectiveCoefficients,
  altitudeMeters: number,
  cosZenith: number,
): [number, number, number] {
  const rayleigh = RAYLEIGH_SCALE_HEIGHT_METERS
    * chapmanColumn(RAYLEIGH_SCALE_HEIGHT_METERS, altitudeMeters, cosZenith);
  const mie = MIE_SCALE_HEIGHT_METERS
    * chapmanColumn(MIE_SCALE_HEIGHT_METERS, altitudeMeters, cosZenith);
  const ozone = ozoneSunColumn(altitudeMeters, cosZenith);
  return [0, 1, 2].map((channel) =>
    coefficients.rayleighScattering[channel]! * rayleigh
    + coefficients.mieExtinction[channel]! * mie
    + coefficients.ozoneAbsorption[channel]! * ozone) as [number, number, number];
}

/** Spectral sun transmittance at a point — the sun THAT point sees. */
export function sunTransmittanceAt(
  coefficients: AerialPerspectiveCoefficients,
  altitudeMeters: number,
  cosZenith: number,
): [number, number, number] {
  const depth = sunOpticalDepthAt(coefficients, altitudeMeters, cosZenith);
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

const MS_SQRT_DIRECTIONS = 6;
const MS_STEPS = 12;
const MS_TOP_METERS = 100_000;
const MS_GROUND_ALBEDO = 0.18;

/**
 * Hillaire's (2020) multiple-scattering transfer Ψ at sea level for a unit
 * sun, per unit scattering coefficient: second-order luminance gathered
 * isotropically over the sphere, folded through the 1/(1 − f_ms) series.
 * The sky integral's isotropic ambient is σ_s·Ψ·(sun radiance): this is
 * what makes a low-sun sky's fill light physically sized and coloured
 * instead of a palette horizon smeared over the whole dome.
 */
function evaluateMultipleScattering(
  coefficients: AerialPerspectiveCoefficients,
  cosSunZenith: number,
): [number, number, number] {
  const r0 = AERIAL_PLANET_RADIUS_METERS + 1;
  const top = AERIAL_PLANET_RADIUS_METERS + MS_TOP_METERS;
  const sun: [number, number, number] = [
    Math.sqrt(Math.max(0, 1 - cosSunZenith * cosSunZenith)),
    cosSunZenith,
    0,
  ];
  const luminance: [number, number, number] = [0, 0, 0];
  const transfer: [number, number, number] = [0, 0, 0];
  const count = MS_SQRT_DIRECTIONS * MS_SQRT_DIRECTIONS;
  for (let a = 0; a < MS_SQRT_DIRECTIONS; a += 1) {
    for (let b = 0; b < MS_SQRT_DIRECTIONS; b += 1) {
      const theta = Math.acos(1 - (2 * (b + 0.5)) / MS_SQRT_DIRECTIONS);
      const phi = (2 * Math.PI * (a + 0.5)) / MS_SQRT_DIRECTIONS;
      const ray: [number, number, number] = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      const mu = ray[1];
      const ground = r0 * r0 * (mu * mu - 1)
        + AERIAL_PLANET_RADIUS_METERS * AERIAL_PLANET_RADIUS_METERS;
      const hitsGround = mu < 0 && ground >= 0 && -r0 * mu - Math.sqrt(ground) > 0;
      const length = hitsGround
        ? -r0 * mu - Math.sqrt(ground)
        : -r0 * mu + Math.sqrt(Math.max(r0 * r0 * (mu * mu - 1) + top * top, 0));
      const step = length / MS_STEPS;
      const view: [number, number, number] = [1, 1, 1];
      for (let s = 0; s < MS_STEPS; s += 1) {
        const t = (s + 0.5) * step;
        const px = ray[0] * t;
        const py = r0 + ray[1] * t;
        const pz = ray[2] * t;
        const radius = Math.hypot(px, py, pz);
        const altitude = radius - AERIAL_PLANET_RADIUS_METERS;
        const densityR = Math.exp(-Math.max(altitude, 0) / RAYLEIGH_SCALE_HEIGHT_METERS);
        const densityM = Math.exp(-Math.max(altitude, 0) / MIE_SCALE_HEIGHT_METERS);
        const densityO = Math.max(
          0,
          1 - Math.abs(altitude - OZONE_CENTER_METERS) / OZONE_HALF_WIDTH_METERS,
        );
        const sunCos = (px * sun[0] + py * sun[1] + pz * sun[2]) / radius;
        const sunT = sunTransmittanceAt(coefficients, altitude, sunCos);
        for (let channel = 0; channel < 3; channel += 1) {
          const scatter = coefficients.rayleighScattering[channel]! * densityR
            + coefficients.mieScattering[channel]! * densityM;
          const extinction = Math.max(
            coefficients.rayleighScattering[channel]! * densityR
              + coefficients.mieExtinction[channel]! * densityM
              + coefficients.ozoneAbsorption[channel]! * densityO,
            1e-12,
          );
          const segment = Math.exp(-extinction * step);
          const absorbed = (view[channel]! * (1 - segment)) / extinction;
          luminance[channel]! += (absorbed * scatter * sunT[channel]!) / (4 * Math.PI);
          transfer[channel]! += absorbed * scatter;
          view[channel] = view[channel]! * segment;
        }
      }
      if (hitsGround) {
        const groundCos = Math.max(
          (ray[0] * length * sun[0] + (r0 + ray[1] * length) * sun[1] + ray[2] * length * sun[2])
            / AERIAL_PLANET_RADIUS_METERS,
          0,
        );
        const sunT = sunTransmittanceAt(coefficients, 0, groundCos);
        for (let channel = 0; channel < 3; channel += 1) {
          luminance[channel]! += (view[channel]! * sunT[channel]! * groundCos * MS_GROUND_ALBEDO)
            / Math.PI;
        }
      }
    }
  }
  return [0, 1, 2].map((channel) =>
    (luminance[channel]! / count)
      / Math.max(1 - transfer[channel]! / count, 0.05)) as [number, number, number];
}

const MS_TABLE_SIZE = 24;
const MS_TABLE_MIN_COS = -0.1;
const MS_TABLE_SPAN = 1.1;
const MS_TABLE_CACHE_LIMIT = 8;
const msTables = new Map<string, Float64Array>();

function tableKey(coefficients: AerialPerspectiveCoefficients): string {
  return [
    ...coefficients.rayleighScattering,
    ...coefficients.mieScattering,
    ...coefficients.mieExtinction,
    ...coefficients.ozoneAbsorption,
  ].join("|");
}

/** Table node i sits at cos = MIN + SPAN·(i/(N−1))²: dense where Ψ bends. */
function tableCos(index: number): number {
  const u = index / (MS_TABLE_SIZE - 1);
  return MS_TABLE_MIN_COS + MS_TABLE_SPAN * u * u;
}

/**
 * Ψ for the sun's zenith cosine, from a per-atmosphere table (24 nodes,
 * baked on first use — ~20 ms — and kept for the few coefficient sets a
 * session sees: humidity moves only with weather and season).
 */
export function skyMultipleScattering(
  coefficients: AerialPerspectiveCoefficients,
  cosSunZenith: number,
): [number, number, number] {
  const key = tableKey(coefficients);
  let table = msTables.get(key);
  if (!table) {
    table = new Float64Array(MS_TABLE_SIZE * 3);
    for (let index = 0; index < MS_TABLE_SIZE; index += 1) {
      table.set(evaluateMultipleScattering(coefficients, tableCos(index)), index * 3);
    }
    if (msTables.size >= MS_TABLE_CACHE_LIMIT) {
      const oldest = msTables.keys().next().value;
      if (oldest !== undefined) msTables.delete(oldest);
    }
    msTables.set(key, table);
  }
  const u = Math.sqrt(
    Math.min(Math.max((cosSunZenith - MS_TABLE_MIN_COS) / MS_TABLE_SPAN, 0), 1),
  ) * (MS_TABLE_SIZE - 1);
  const lower = Math.min(Math.floor(u), MS_TABLE_SIZE - 2);
  const t = u - lower;
  return [0, 1, 2].map((channel) =>
    table[lower * 3 + channel]! * (1 - t)
    + table[(lower + 1) * 3 + channel]! * t) as [number, number, number];
}
