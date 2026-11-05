import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";
import type { CarSurface } from "./surface";
import type { ResolvedCurve } from "./tyre";

/**
 * Bekker-Wong terramechanics for one tyre on soft ground (land plan, "Soft
 * soil"; Wong, Theory of Ground Vehicles, ch. 2 and 5):
 *
 * - Sinkage: Bekker's p = (k_c / b + k_phi) z^n under the tyre's flat, the
 *   deflected footprint of length 2 sqrt(D delta) acting as a plate of
 *   width b. A softer tyre has a longer flat and a lower ground pressure, so
 *   it sinks less: why airing down gets a car through sand.
 * - Compaction resistance: the work of pressing the rut, per metre,
 *   b k z^(n+1) / (n+1), against the tyre's travel. Ahead of a rolling tyre
 *   the virgin soil is pressed to the static sinkage of the tyre's present
 *   load and pressure, plus what its slip digs; a tyre sitting deeper (one
 *   aired down in the hole it made at road pressure) does not press that
 *   soil again, and rises out of it as it rolls.
 * - Thrust: Janosi-Hanamoto, tau = (c + p tan phi)(1 - e^(-j/K)), integrated
 *   over the patch at slip i: F = (A c + W tan phi)(1 - K/(i l)(1 - e^(-i l / K))),
 *   handed to TMeasy as its curve (`soilCurve`), so combined slip and the
 *   deflection dynamics work on soil as they do on asphalt.
 * - Slip sinkage: a tyre slipping past `DIG_SLIP` digs its rut deeper, by
 *   `DIG_GAIN` of its static sinkage for each patch length of tread that
 *   slips, and rolling onto fresh soil fills the rut back in over a patch
 *   length. Rolling, the rut stays a fraction of the static sinkage; spinning
 *   in place a tyre digs down towards the firm ground under the soft layer,
 *   faster where it sinks more, which is how a car bogs.
 *
 * Inputs and outputs travel in a `SoilContact`: no number crosses a call.
 */

const TYRE = LANDCRUISER_76.tyre;
const DIAMETER = 2 * TYRE.freeRadius;
const PLATE_WIDTH = TYRE.treadWidth;
/** The flat never shrinks below this deflection, metres: a tyre always has a footprint. */
const MIN_DEFLECTION = 0.005;
/** Slip past which a tyre digs, and how much: the rut's growth per patch length of slipping tread, of the static sinkage. */
export const DIG_SLIP = 0.2;
export const DIG_GAIN = 0.05;
/** Lateral shear holds this share of the longitudinal: no tread lugs bite sideways. */
const LATERAL_SHEAR_SHARE = 0.85;

export interface SoilContact {
  /** Inputs: the tyre's load (N), its radial deflection (m), its static sinkage now and its rut (slip sinkage) under it (m). */
  load: number;
  deflection: number;
  sinkage: number;
  rut: number;
  /** Outputs of `soilPatch`. */
  /** The flat's mean ground pressure, Pa. */
  pressure: number;
  /** The static sinkage that pressure presses, m. */
  targetSinkage: number;
  /** The patch length the soil shears over (the flat and the sunk arc), m. */
  patchLength: number;
  /** The most the soil can shear, A c + W tan phi, N. */
  shearCapacity: number;
  /** Compaction resistance: the target sinkage (or less) and the rut, N. */
  compaction: number;
}

export function createSoilContact(): SoilContact {
  return { load: 0, deflection: 0, sinkage: 0, rut: 0, pressure: 0, targetSinkage: 0, patchLength: 0, shearCapacity: 0, compaction: 0 };
}

/** Bekker's modulus k_c / b + k_phi for the tyre's plate width. */
function modulus(surface: Readonly<CarSurface>): number {
  return surface.kc / PLATE_WIDTH + surface.kPhi;
}

/** Sinkage, pressure, patch, shear capacity and compaction for `contact`'s load, deflection, sinkage and rut on `surface`. */
export function soilPatch(surface: Readonly<CarSurface>, contact: SoilContact): void {
  const load = Math.max(0, contact.load);
  const flat = 2 * Math.sqrt(DIAMETER * Math.max(MIN_DEFLECTION, contact.deflection));
  const pressure = load / (PLATE_WIDTH * flat);
  const k = modulus(surface);
  const n = surface.n;
  const target = Math.min(surface.maxSinkage, Math.pow(pressure / k, 1 / n));
  contact.pressure = pressure;
  contact.targetSinkage = target;
  const standing = Math.max(0, contact.sinkage);
  const rut = Math.max(0, contact.rut);
  const sunk = Math.min(surface.maxSinkage, standing + rut);
  const patch = 2 * Math.sqrt(DIAMETER * (Math.max(MIN_DEFLECTION, contact.deflection) + sunk));
  contact.patchLength = patch;
  contact.shearCapacity = PLATE_WIDTH * patch * surface.cohesion + load * surface.tanFriction;
  const pressed = Math.min(surface.maxSinkage, Math.min(standing, target) + rut);
  contact.compaction = (PLATE_WIDTH * k * Math.pow(pressed, n + 1)) / (n + 1);
}

/**
 * Janosi-Hanamoto's thrust curve as TMeasy's three points, for the patch
 * `soilPatch` last described: the initial slope F l / (2K), the "peak" where
 * i l / K = 6 (83% of the capacity) and the sliding level at full slip.
 * `lateral` takes the side-shear share.
 */
export function soilCurve(surface: Readonly<CarSurface>, contact: Readonly<SoilContact>, lateral: boolean, out: ResolvedCurve): void {
  const capacity = contact.shearCapacity * (lateral ? LATERAL_SHEAR_SHARE : 1);
  const patch = Math.max(contact.patchLength, 0.05);
  const k = surface.shearModulus;
  out.initialSlope = (capacity * patch) / (2 * k);
  const peakSlip = Math.min(0.6, Math.max(0.04, (6 * k) / patch));
  out.peakSlip = peakSlip;
  out.peakForce = capacity * (1 - (1 - Math.exp(-6)) / 6);
  out.slidingSlip = Math.max(peakSlip + 0.05, 1);
  const full = patch / k;
  out.slidingForce = capacity * (1 - (1 - Math.exp(-full)) / full);
}
