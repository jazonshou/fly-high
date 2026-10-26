/**
 * Savitsky's steady-planing equations (D. Savitsky, "Hydrodynamic design of
 * planing hulls", Marine Technology 1(1), 1964), the oracle the strip model
 * is checked against: a prismatic hull of chine beam b and deadrise beta,
 * towed through its CG at speed V, in its trimmed equilibrium.
 *
 *   C_Lbeta = Delta / (1/2 rho V^2 b^2) = C_L0 - 0.0065 beta C_L0^0.6
 *   C_L0 = tau^1.1 (0.012 lambda^0.5 + 0.0055 lambda^2.5 / C_V^2)        (tau, beta in degrees)
 *   l_p / (lambda b) = 0.75 - 1 / (5.21 C_V^2 / lambda^2 + 2.39)
 *   N (LCG - l_p) + D_f (VCG - b tan(beta) / 4) = 0
 *
 * with C_V = V / sqrt(g b), lambda the mean wetted length in beams, D_f the
 * ITTC-57 friction (plus roughness) on lambda b^2 / cos(beta) at the mean
 * bottom velocity. Valid for 0.6 <= C_V <= 13, 2 <= tau <= 15 deg, lambda <= 4.
 */
export interface SavitskyHull {
  /** Chine beam, m. */
  beam: number;
  deadriseDegrees: number;
  /** CG forward of the transom and above the keel, m. */
  lcg: number;
  vcg: number;
  /** Displacement weight, N. */
  weight: number;
}

export interface SavitskyPoint {
  trimDegrees: number;
  /** Mean wetted length over beam. */
  lambda: number;
  speedCoefficient: number;
  /** Horizontal tow force through the CG, N, and its friction share. */
  drag: number;
  frictionDrag: number;
  /** Bottom wetted area, m^2. */
  wettedArea: number;
  /**
   * Wetted keel and chine lengths, m: L_k - L_c = b tan(beta) / (pi tan(tau)).
   * A chine length at or below zero means dry chines, outside the equations.
   */
  keelLength: number;
  chineLength: number;
}

const DEG = Math.PI / 180;

export function savitskyPlaning(
  hull: Readonly<SavitskyHull>,
  speed: number,
  { rho = 1025, viscosity = 1.19e-6, roughness = 0.0004, gravity = 9.80665 } = {},
): SavitskyPoint {
  const b = hull.beam;
  const beta = hull.deadriseDegrees;
  const cv = speed / Math.sqrt(gravity * b);
  const clBeta = hull.weight / (0.5 * rho * speed * speed * b * b);
  // C_L0 from C_Lbeta (monotonic over the planing range).
  const cl0 = bisect((c) => c - 0.0065 * beta * Math.pow(c, 0.6) - clBeta, clBeta, 1);
  const a = hull.vcg - (b / 4) * Math.tan(beta * DEG);

  const evaluate = (tauDeg: number) => {
    const tau11 = Math.pow(tauDeg, 1.1);
    const lambda = bisect((l) => tau11 * (0.012 * Math.sqrt(l) + (0.0055 * Math.pow(l, 2.5)) / (cv * cv)) - cl0, 0.002, 12);
    const lp = lambda * b * (0.75 - 1 / ((5.21 * cv * cv) / (lambda * lambda) + 2.39));
    // Mean bottom velocity: the bottom pressure takes some of the stream's head.
    const tau = tauDeg * DEG;
    const relief = (0.012 * Math.sqrt(lambda) * tau11 - 0.0065 * beta * Math.pow(0.012 * Math.sqrt(lambda) * tau11, 0.6)) / (lambda * Math.cos(tau));
    const v1 = speed * Math.sqrt(Math.max(0.5, 1 - relief));
    const area = (lambda * b * b) / Math.cos(beta * DEG);
    const reynolds = (v1 * lambda * b) / viscosity;
    const logRe = Math.log10(reynolds) - 2;
    const cf = 0.075 / (logRe * logRe) + roughness;
    const df = 0.5 * rho * v1 * v1 * area * cf;
    // Tow horizontal through the CG: vertical N cos(tau) - D_f sin(tau) = Delta.
    const normal = (hull.weight + df * Math.sin(tau)) / Math.cos(tau);
    return {
      lambda,
      moment: normal * (hull.lcg - lp) + df * a,
      drag: normal * Math.sin(tau) + df * Math.cos(tau),
      df,
      area,
    };
  };
  // Too little trim: the lift centre runs aft of where the moment wants it.
  const trimDegrees = bisect((t) => evaluate(t).moment, 0.5, 15);
  const point = evaluate(trimDegrees);
  const spray = (b * Math.tan(beta * DEG)) / (Math.PI * Math.tan(trimDegrees * DEG));
  return {
    trimDegrees,
    lambda: point.lambda,
    speedCoefficient: cv,
    drag: point.drag,
    frictionDrag: point.df,
    wettedArea: point.area,
    keelLength: point.lambda * b + 0.5 * spray,
    chineLength: point.lambda * b - 0.5 * spray,
  };
}

/** Root of a function that changes sign once on [lo, hi]. */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let flo = f(lo);
  for (let k = 0; k < 60; k += 1) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm === 0) return mid;
    if (fm < 0 === flo < 0) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Savitsky's (1964) porpoising limit, from Day and Haag's (1952) tank tests
 * of prismatic planing surfaces: the running trim, degrees, above which a
 * hull of this deadrise porpoises at this load, as a function of
 * sqrt(C_Lbeta / 2) = sqrt(Delta / (rho V^2 b^2)). Cubic fits to the chart's
 * 0, 10 and 20 degree curves (E. L. Castro-Feliciano's openplaning, MIT),
 * joined by a quadratic in deadrise. The chart spans 0.13-0.3 and 0-20 deg;
 * outside it the fits extrapolate.
 */
export function porpoisingTrimLimit(sqrtHalfLift: number, deadriseDegrees: number): number {
  const x = sqrtHalfLift;
  const at0 = -376.37 * x ** 3 + 329.74 * x ** 2 - 38.485 * x + 1.3415;
  const at10 = -356.05 * x ** 3 + 314.36 * x ** 2 - 41.674 * x + 3.5786;
  const at20 = -254.51 * x ** 3 + 239.65 * x ** 2 - 23.936 * x + 3.0195;
  const curvature = (at20 - 2 * at10 + at0) / 200;
  const slope = (at10 - at0) / 10 - curvature * 10;
  return at0 + slope * deadriseDegrees + curvature * deadriseDegrees * deadriseDegrees;
}

export interface SeawayHull {
  /** Chine beam, m, and deadrise, degrees. */
  beam: number;
  deadriseDegrees: number;
  /** Waterline length, m. */
  length: number;
  /** Displacement weight, N. */
  weight: number;
}

/**
 * Savitsky and Brown's (1976) impact acceleration at the CG of a planing
 * hull in irregular head seas, the average of the highest tenth, in g:
 *
 *   n_1/10 = 0.0104 (H_1/3 / b + 0.084) (tau / 4) (5/3 - beta / 30) (V_k^2 / L_ft) (L / b) / C_Delta
 *
 * with tau the calm-water running trim in degrees, V_k the speed in knots,
 * L_ft the waterline length in feet and C_Delta = Delta / (rho g b^3). From
 * Fridsma's prismatic-model tests; the paper gives it for 3-6 deg of trim,
 * 10-30 deg of deadrise and V_k / sqrt(L_ft) up to 6, about +/-30%.
 */
export function savitskyBrownImpact(
  hull: Readonly<SeawayHull>,
  significantHeight: number,
  trimDegrees: number,
  speed: number,
  { rho = 1025, gravity = 9.80665 } = {},
): number {
  const knots = speed / 0.514444;
  const lengthFeet = hull.length / 0.3048;
  const loading = hull.weight / (rho * gravity * hull.beam ** 3);
  return (
    (0.0104 *
      (significantHeight / hull.beam + 0.084) *
      (trimDegrees / 4) *
      (5 / 3 - hull.deadriseDegrees / 30) *
      ((knots * knots) / lengthFeet) *
      (hull.length / hull.beam)) /
    loading
  );
}
