import type { TmeasyCurve, TmeasyDirection } from "@/src/vehicles/landcruiser76";

/**
 * TMeasy, the semi-physical tyre model of G. Rill (Road Vehicle Dynamics:
 * Fundamentals and Modeling, CRC Press 2011, ch. 3), with its first-order
 * force dynamics (section 3.10).
 *
 * Steady state: each direction is three points of a force-against-slip curve
 * (an initial slope, a peak and a sliding level), interpolated in wheel load
 * between the nominal load and twice it, so a wheel carrying three times
 * another's load still has a sensible curve. Combined slip uses TMeasy's
 * generalised slip: the two slips normalised by `sHatX`/`sHatY`, one curve
 * along the direction of their resultant, so braking in a turn trades grip
 * the way a real tyre does.
 *
 * Dynamics: the contact patch has a longitudinal and a lateral deflection
 * (`deflectionX`/`deflectionY`), springs of the carcass with damping. Their
 * rate is chosen so the deflection force tends to the steady-state force:
 *
 *   dx/dt = -(vT cx x + fx (vx - rD w)) / (vT dx + fx),   Fx = cx x + dx dx/dt
 *
 * with fx the steady force per unit slip and vT the transport velocity
 * `rD |w| + V_N`. At speed that is a lag with relaxation length dF0/c (about
 * half a metre); at a standstill it is the carcass spring and damper, so a
 * braked car stands still on a slope instead of jittering, and a spinning
 * wheel stays smooth at 480 Hz.
 *
 * Inputs travel in a `TyreInput` and results in the out objects, so no
 * number crosses a call: V8 boxes one that crosses a call it does not
 * inline, and the car's step allocates nothing.
 */

/** A small transport velocity that keeps slips finite at a standstill, m/s (Rill's v_N). */
export const TYRE_V_N = 0.005;

/** What one tyre evaluation reads: its load and the surface, and the two slips. */
export interface TyreInput {
  /** The load the curves are given at (TMeasy's F_N^N), N. */
  nominalLoad: number;
  /** The tyre's load now, N. */
  load: number;
  /** The surface's friction multiplier on the reference (dry asphalt) curves. */
  friction: number;
  /** Longitudinal and lateral slip, (v - r w) / v_T and v_y / v_T, signed as forces. */
  slipX: number;
  slipY: number;
}

export function createTyreInput(nominalLoad: number): TyreInput {
  return { nominalLoad, load: 0, friction: 1, slipX: 0, slipY: 0 };
}

/** One direction's curve at one load, already scaled by the surface's friction. */
export interface ResolvedCurve {
  initialSlope: number;
  peakSlip: number;
  peakForce: number;
  slidingSlip: number;
  slidingForce: number;
}

export function createResolvedCurve(): ResolvedCurve {
  return { initialSlope: 0, peakSlip: 0.1, peakForce: 0, slidingSlip: 0.5, slidingForce: 0 };
}

/**
 * Rill's load interpolation at `input.load`: forces and slopes on the
 * parabola through zero, the nominal and twice the nominal load; slips
 * linear in load. Then the surface: `input.friction` scales the forces, and
 * the initial slope with it down to a fifth.
 */
export function resolveCurve(direction: TmeasyDirection, input: Readonly<TyreInput>, out: ResolvedCurve): ResolvedCurve {
  // Past three times the nominal load the parabola turns over; hold it there.
  const ratio = Math.min(3, Math.max(0, input.load / input.nominalLoad));
  const n = direction.nominal;
  const d = direction.double;
  // F(r) = r (2 F1 - F2/2 - (F1 - F2/2) r), with F1 at the nominal and F2 at twice it, never below zero.
  out.initialSlope = Math.max(0, ratio * (2 * n.initialSlope - 0.5 * d.initialSlope - (n.initialSlope - 0.5 * d.initialSlope) * ratio));
  out.peakForce = Math.max(0, ratio * (2 * n.peakForce - 0.5 * d.peakForce - (n.peakForce - 0.5 * d.peakForce) * ratio));
  out.slidingForce = Math.max(0, ratio * (2 * n.slidingForce - 0.5 * d.slidingForce - (n.slidingForce - 0.5 * d.slidingForce) * ratio));
  out.peakSlip = Math.max(0.02, n.peakSlip + (d.peakSlip - n.peakSlip) * (ratio - 1));
  out.slidingSlip = Math.max(out.peakSlip + 0.05, n.slidingSlip + (d.slidingSlip - n.slidingSlip) * (ratio - 1));
  const friction = input.friction;
  out.initialSlope *= Math.max(0.2, Math.min(1, friction * 1.1));
  out.peakForce *= friction;
  out.slidingForce *= friction;
  return out;
}

/** What the combined-slip evaluation returns: steady forces and their per-unit-slip derivatives. */
export interface CombinedSlipResult {
  /** Steady-state forces along the wheel and across it, N. */
  forceX: number;
  forceY: number;
  /** F / s along each slip: the global derivatives the deflection dynamics use. */
  perSlipX: number;
  perSlipY: number;
  /** Generalised slip magnitude, normalised so that 1 is about the peak. */
  slip: number;
  /** The sliding force along the resultant: the most the patch can hold once it slides. */
  slidingForce: number;
}

export function createCombinedSlipResult(): CombinedSlipResult {
  return { forceX: 0, forceY: 0, perSlipX: 0, perSlipY: 0, slip: 0, slidingForce: 0 };
}

/**
 * TMeasy's generalised combined slip (Rill 2011, section 3.7.6) at
 * `input.slipX`/`input.slipY`, on the generalised curve: a rational rise to
 * the peak, a smooth step down to the sliding level, then flat.
 */
export function combinedSlip(
  x: Readonly<ResolvedCurve>,
  y: Readonly<ResolvedCurve>,
  input: Readonly<TyreInput>,
  out: CombinedSlipResult,
): CombinedSlipResult {
  const slipX = input.slipX;
  const slipY = input.slipY;
  const peakSum = x.peakSlip + y.peakSlip;
  const ratioX = x.initialSlope > 0 ? x.peakForce / x.initialSlope : 0;
  const ratioY = y.initialSlope > 0 ? y.peakForce / y.initialSlope : 0;
  const ratioSum = ratioX + ratioY;
  const sHatX = x.peakSlip / peakSum + (ratioSum > 0 ? ratioX / ratioSum : 0.5);
  const sHatY = y.peakSlip / peakSum + (ratioSum > 0 ? ratioY / ratioSum : 0.5);
  const nx = slipX / sHatX;
  const ny = slipY / sHatY;
  const s = Math.sqrt(nx * nx + ny * ny);
  let cosine = 1;
  let sine = 0;
  if (s > 1e-9) {
    cosine = nx / s;
    sine = ny / s;
  } else if (Math.abs(slipY) > Math.abs(slipX)) {
    cosine = 0;
    sine = 1;
  }
  const c2 = cosine * cosine;
  const s2 = sine * sine;
  const initialSlope = Math.sqrt(
    (x.initialSlope * sHatX) ** 2 * c2 + (y.initialSlope * sHatY) ** 2 * s2,
  );
  const peakSlip = Math.sqrt((x.peakSlip / sHatX) ** 2 * c2 + (y.peakSlip / sHatY) ** 2 * s2);
  const peakForce = Math.sqrt(x.peakForce ** 2 * c2 + y.peakForce ** 2 * s2);
  const slidingSlip = Math.max(
    Math.sqrt((x.slidingSlip / sHatX) ** 2 * c2 + (y.slidingSlip / sHatY) ** 2 * s2),
    peakSlip * 1.01,
  );
  const slidingForce = Math.sqrt(x.slidingForce ** 2 * c2 + y.slidingForce ** 2 * s2);
  let force = slidingForce;
  if (!(peakForce > 0)) force = 0;
  else if (s <= peakSlip) {
    const sigma = s / peakSlip;
    force = (peakSlip * initialSlope * sigma) / (1 + sigma * (sigma + (initialSlope * peakSlip) / peakForce - 2));
  } else if (s < slidingSlip) {
    const sigma = (s - peakSlip) / (slidingSlip - peakSlip);
    force = peakForce - (peakForce - slidingForce) * sigma * sigma * (3 - 2 * sigma);
  }
  // F / s, with its limit dF0 at zero slip.
  const perSlip = s > 1e-9 ? force / s : initialSlope;
  out.forceX = perSlip * nx;
  out.forceY = perSlip * ny;
  out.perSlipX = perSlip / sHatX;
  out.perSlipY = perSlip / sHatY;
  out.slip = peakSlip > 0 ? s / peakSlip : 0;
  out.slidingForce = slidingForce;
  return out;
}

/** The TMeasy curves as the car record gives them, for a test's direct use. */
export type { TmeasyCurve, TmeasyDirection };
