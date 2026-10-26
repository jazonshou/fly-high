import { MAX_BOAT_SPRAY_ROOTS } from "@/src/game/types";
import type { BoatCalibration } from "./definition";
import { STRAKES_PER_STRIP, type HullStrips } from "./hullMesh";

/**
 * Planing loads from nonlinear strip theory (2D+t), after Zarnick (1978) with
 * Wagner's splash-up and Garme's (2005) near-transom pressure release.
 *
 * An earth-fixed transverse plane sees the hull's sections pass through it
 * aft at the speed U along the keel: each section is a wedge driven into the
 * water at the earth-plane penetration speed
 *
 *   V = -(v_point - u_water) . y_body + U k'          (k' the keel's rocker slope)
 *
 * and the water it accelerates pushes back with the rate of change of its
 * momentum, plus a cross-flow drag on the wetted beam:
 *
 *   f = D(m_a V)/Dt + 1/2 C_dc rho c V|V|,   D/Dt = d/dt - U d/dxi,
 *   m_a = k rho (pi/2) c^2,   c = lambda d / tan(beta)  (Wagner, lambda = pi/2).
 *
 * m_a DV/Dt is split: the part proportional to the hull's acceleration goes
 * to the left-hand side as a 6x6 added-mass matrix (the caller solves
 * (M + A) a = F), which keeps the stiff slamming terms stable at a fixed step;
 * the convective part (U omega_z - U^2 k'') and V Dm/Dt stay explicit. Like
 * Zarnick, the momentum term is dropped while a section leaves the water.
 *
 * Each section is two half-wedges, port and starboard. A heel relative to the
 * local water lowers one panel's effective deadrise and widens its wetted
 * beam (the planing roll stiffness), and sideslip drives the leading panel
 * deeper (+/- tan(beta) times the sway speed): the outer panel lifts and a
 * deep-V heels INTO its turns. Sway is a second slender-body strip, with the
 * mirrored-plate added mass k rho (pi/2) d^2 of the section's draft and a
 * cross-flow drag on it. Strakes trip the spray root: once the Wagner jet
 * would cross a strake, the wetted beam stops at the strake's edge.
 */

export interface StripInputs {
  /** Per strip: depth of the keel point below the local water plane, along the plane's normal (m). */
  readonly depth: Float64Array;
  /** Per strip: the local water normal in the BODY frame, x y z interleaved. */
  readonly normal: Float64Array;
  /** Per strip: the keel point's velocity relative to the water, BODY frame, x y z interleaved. */
  readonly relativeVelocity: Float64Array;
  /** Body angular velocity. */
  omegaX: number;
  omegaY: number;
  omegaZ: number;
  /** Speed through the water at the CG along body x, for the Froude blends. */
  speed: number;
  /** Transom-dry weight, 0 with a wet transom .. 1 dry; scales the transom release. */
  transomDry: number;
  /** Length Froude number, for the Wagner splash-up blend. */
  froude: number;
}

export interface StripOutputs {
  /** Body-frame force and moment about the CG, N and N m. */
  readonly force: { x: number; y: number; z: number };
  readonly moment: { x: number; y: number; z: number };
  /** Body-frame 6x6 added mass about the CG (surge, heave, sway, roll, yaw, pitch), row-major. */
  readonly addedMass: Float64Array;
  /** Vertical (body y) dynamic lift, N: what holds a planing hull up. */
  dynamicLift: number;
  /** Keel wetted length, m, and the deepest keel immersion at the transom strip. */
  wettedLength: number;
  /** Per strip and side (index 2i + (starboard ? 1 : 0)): wetted half-beam, m. */
  readonly wettedHalfBeam: Float64Array;
  /** Spray roots: body x y z and jet speed, flattened, `sprayCount` live. */
  readonly spray: Float64Array;
  sprayCount: number;
  /** Peak sectional slam pressure proxy this pass, N/m: for sound and tests. */
  peakSectionLoad: number;
}

export function createStripOutputs(strips: HullStrips): StripOutputs {
  return {
    force: { x: 0, y: 0, z: 0 },
    moment: { x: 0, y: 0, z: 0 },
    addedMass: new Float64Array(36),
    dynamicLift: 0,
    wettedLength: 0,
    wettedHalfBeam: new Float64Array(strips.count * 2),
    spray: new Float64Array(MAX_BOAT_SPRAY_ROOTS * 4),
    sprayCount: 0,
    peakSectionLoad: 0,
  };
}

export function createStripInputs(strips: HullStrips): StripInputs {
  return {
    depth: new Float64Array(strips.count),
    normal: new Float64Array(strips.count * 3),
    relativeVelocity: new Float64Array(strips.count * 3),
    omegaX: 0,
    omegaY: 0,
    omegaZ: 0,
    speed: 0,
    transomDry: 0,
    froude: 0,
  };
}

const WAGNER = Math.PI / 2;
/** Centre of the Wagner pressure across a half-beam: 2/pi of the way out. */
const PRESSURE_CENTRE = 2 / Math.PI;
/** Lateral centre of pressure, as a share of the section draft above the keel. */
const LATERAL_CENTRE = 0.4;
/** Below this water-normal component along body y, the hull is on its beam ends and the strips stand down. */
const MIN_NORMAL_Y = 0.25;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Spray-root candidates, kept by jet speed. */
const sprayCandidates = new Float64Array(64 * 4);

/**
 * Evaluate every strip. `rho` is the water density, `beam` the chine beam at
 * the transom for the release length. Allocation-free.
 */
export function evaluateStrips(
  strips: HullStrips,
  input: StripInputs,
  calibration: BoatCalibration,
  rho: number,
  beam: number,
  out: StripOutputs,
): StripOutputs {
  const force = out.force;
  const moment = out.moment;
  force.x = 0;
  force.y = 0;
  force.z = 0;
  moment.x = 0;
  moment.y = 0;
  moment.z = 0;
  const added = out.addedMass;
  added.fill(0);
  out.dynamicLift = 0;
  out.wettedLength = 0;
  out.peakSectionLoad = 0;
  out.wettedHalfBeam.fill(0);
  let candidates = 0;

  const span = strips.length;
  const releaseLength = Math.max(1e-3, calibration.transomReleaseBeams * beam);
  const speedSplash = smoothstep(0.35, 0.9, input.froude);
  const ka = calibration.addedMassFactor;
  const kl = calibration.lateralAddedMass;
  const omegaX = input.omegaX;
  const omegaY = input.omegaY;
  const omegaZ = input.omegaZ;

  for (let i = 0; i < strips.count; i += 1) {
    const nbx = input.normal[i * 3]!;
    const nby = input.normal[i * 3 + 1]!;
    const nbz = input.normal[i * 3 + 2]!;
    const depthPerp = input.depth[i]!;
    if (depthPerp <= 0 || nby < MIN_NORMAL_Y) continue;
    const x = strips.x[i]!;
    const keelY = strips.keelY[i]!;
    const tanBeta = strips.tanDeadrise[i]!;
    const chine = strips.chineHalfBeam[i]!;
    const kSlope = strips.keelSlope[i]!;
    const kCurve = strips.keelCurvature[i]!;
    const release = 1 - input.transomDry * (1 - Math.tanh(strips.transomDistance[i]! / releaseLength));
    const vx = input.relativeVelocity[i * 3]!;
    const vy = input.relativeVelocity[i * 3 + 1]!;
    const vz = input.relativeVelocity[i * 3 + 2]!;
    const along = vx;
    // Earth-plane penetration speed of the keel, positive into the water.
    const penetration = -vy + along * kSlope;
    // Section draft along body y, for sway.
    const draft = Math.min(depthPerp / nby, strips.sheerRise[i]!);
    const transomDistance = strips.transomDistance[i]!;
    out.wettedLength = Math.max(out.wettedLength, transomDistance + 0.5 * span);

    // Keel-normal direction (rocker tilts it aft), unit.
    const nNorm = 1 / Math.sqrt(1 + kSlope * kSlope);
    const nx = -kSlope * nNorm;
    const ny = nNorm;

    // Depth at the strip's fore and aft edges, from the keel's slope against the water plane.
    const depthSlope = nbx + nby * kSlope;
    const depthForward = depthPerp - 0.5 * span * depthSlope;
    const depthAft = depthPerp + 0.5 * span * depthSlope;
    const secant = Math.abs(depthAft - depthForward) > 1e-5;

    for (let side = -1; side <= 1; side += 2) {
      const slope = nby * tanBeta + side * nbz;
      // The panel's own penetration speed: the keel's, plus the sideslip
      // driving the leading panel deeper, plus the roll rate at the panel's
      // pressure centre (the descending side presses harder: roll damping).
      const reach = slope > 0.02 ? Math.min(chine, (depthPerp / slope) * (1 + (WAGNER - 1) * speedSplash)) : chine;
      const sideSpeed =
        penetration + calibration.sideslipLift * side * tanBeta * vz + side * omegaX * PRESSURE_CENTRE * reach;
      const index = i * 2 + (side > 0 ? 1 : 0);
      if (slope <= 0.02) {
        // Heeled past the panel's own deadrise: the bottom is flat or face-up to the water, the chine is wet.
        const massPerLength = ka * rho * (Math.PI / 4) * chine * chine * release;
        accumulateSide(out, x, keelY, tanBeta, side, chine, nx, ny, massPerLength, 0, sideSpeed, along, omegaZ, kCurve, calibration, rho, release, span);
        out.wettedHalfBeam[index] = chine;
        continue;
      }
      const geometric = depthPerp / slope;
      const impactSplash = smoothstep(0.5, 3, (sideSpeed * sideSpeed) / (9.81 * Math.max(0.05, geometric)));
      const lambda = 1 + (WAGNER - 1) * Math.max(speedSplash, impactSplash);
      const wetted = wettedHalfBeam(strips, i, depthPerp / slope, lambda, chine);
      const trapped = wettedTrapped;
      // dm/dd across the strip, from the mass at its two edges: the jet
      // stalling at a strake or the chine and starting again outboard is
      // then integrated exactly along the hull instead of switching whole
      // strips on and off. A level strip uses the local derivative.
      let massSlope: number;
      if (secant) {
        const forward = wettedHalfBeam(strips, i, Math.max(0, depthForward) / slope, lambda, chine);
        const aft = wettedHalfBeam(strips, i, Math.max(0, depthAft) / slope, lambda, chine);
        massSlope = (ka * rho * (Math.PI / 4) * (aft * aft - forward * forward)) / (depthAft - depthForward);
      } else {
        massSlope = trapped ? 0 : (ka * rho * (Math.PI / 2) * wetted * lambda) / slope;
      }
      const massPerLength = ka * rho * (Math.PI / 4) * wetted * wetted * release;
      const massRate = Math.max(0, massSlope) * nby * sideSpeed * release;
      accumulateSide(out, x, keelY, tanBeta, side, wetted, nx, ny, massPerLength, massRate, sideSpeed, along, omegaZ, kCurve, calibration, rho, release, span);
      out.wettedHalfBeam[index] = wetted;
      if (!trapped) {
        recordSpray(x, keelY, tanBeta, side, wetted, Math.hypot(along, (2 * lambda * nby * sideSpeed) / slope));
      } else if (sideSpeed > 0.2 && Math.abs(along) > 2) {
        // A wet chine or a tripped strake throws its sheet from the edge.
        recordSpray(x, keelY, tanBeta, side, wetted, Math.hypot(along, sideSpeed));
      }
    }

    // Sway strip.
    const lateralMass = kl * rho * (Math.PI / 2) * draft * draft * release;
    const lateralMassRate = penetration > 0 && draft < strips.sheerRise[i]! ? kl * rho * Math.PI * draft * penetration * release : 0;
    const ly = keelY + LATERAL_CENTRE * draft;
    // Sway velocity at the lateral centre (the strip's keel-point value plus roll rate times the rise).
    const sway = vz + omegaX * (ly - keelY);
    const lateral =
      -(lateralMass * along * omegaY + sway * lateralMassRate + 0.5 * calibration.lateralCrossFlowDrag * rho * draft * sway * Math.abs(sway)) * span;
    // Force along +z at (x, ly, 0): moment r x F = (ly F, -x F, 0).
    force.z += lateral;
    moment.x += ly * lateral;
    moment.y -= x * lateral;
    addOuter(added, 0, 0, 1, ly, -x, 0, lateralMass * span);
  }

  // Keep the strongest jets as spray roots.
  out.sprayCount = 0;
  const limit = Math.min(MAX_BOAT_SPRAY_ROOTS, candidates);
  for (let n = 0; n < limit; n += 1) {
    let best = -1;
    let bestSpeed = 0;
    for (let c = 0; c < candidates; c += 1) {
      const speed = sprayCandidates[c * 4 + 3]!;
      if (speed > bestSpeed) {
        bestSpeed = speed;
        best = c;
      }
    }
    if (best < 0) break;
    for (let k = 0; k < 4; k += 1) out.spray[n * 4 + k] = sprayCandidates[best * 4 + k]!;
    sprayCandidates[best * 4 + 3] = -1;
    out.sprayCount = n + 1;
  }
  return out;

  function recordSpray(x: number, keelY: number, tanBeta: number, side: number, wetted: number, speed: number): void {
    if (candidates >= 64 || !(speed > 1)) return;
    sprayCandidates[candidates * 4] = x;
    sprayCandidates[candidates * 4 + 1] = keelY + wetted * tanBeta;
    sprayCandidates[candidates * 4 + 2] = side * wetted;
    sprayCandidates[candidates * 4 + 3] = speed;
    candidates += 1;
  }
}

let wettedTrapped = false;

/**
 * Wetted half-beam of one half-wedge whose still-water line is `geometric`
 * out from the keel, with pile-up `lambda`. A strake the still-water line has
 * passed sheds the jet and the panel outboard of it piles up afresh from its
 * outer edge; the next strake out, or the chine, traps the root at its edge
 * until the line reaches it. Sets `wettedTrapped`.
 */
function wettedHalfBeam(strips: HullStrips, i: number, geometric: number, lambda: number, chine: number): number {
  let base = 0;
  for (let k = 0; k < STRAKES_PER_STRIP; k += 1) {
    const inner = strips.strakeInner[i * STRAKES_PER_STRIP + k]!;
    const outer = inner + strips.strakeWidth[i * STRAKES_PER_STRIP + k]!;
    if (inner > 0 && geometric >= outer && outer > base) base = outer;
  }
  let wetted = base + lambda * (geometric - base);
  wettedTrapped = false;
  for (let k = 0; k < STRAKES_PER_STRIP; k += 1) {
    const inner = strips.strakeInner[i * STRAKES_PER_STRIP + k]!;
    const outer = inner + strips.strakeWidth[i * STRAKES_PER_STRIP + k]!;
    if (inner > 0 && outer > base && wetted > inner) {
      wetted = outer;
      wettedTrapped = true;
      break;
    }
  }
  if (wetted >= chine) {
    wetted = chine;
    wettedTrapped = true;
  }
  return wetted;
}

/** One half-wedge's force along the keel normal, at its centre of pressure, and its added mass. */
function accumulateSide(
  out: StripOutputs,
  x: number,
  keelY: number,
  tanBeta: number,
  side: number,
  wetted: number,
  nx: number,
  ny: number,
  massPerLength: number,
  massRate: number,
  sideSpeed: number,
  along: number,
  omegaZ: number,
  keelCurvature: number,
  calibration: BoatCalibration,
  rho: number,
  release: number,
  span: number,
): void {
  if (!(wetted > 0)) return;
  const entering = sideSpeed > 0;
  const momentum = entering ? sideSpeed * massRate : 0;
  const convective = massPerLength * (along * omegaZ - along * along * keelCurvature);
  // Zarnick's cross-flow coefficient: the flat plate's, times Bobyleff's cos(beta) for the V.
  const crossFlow = entering
    ? 0.5 * calibration.crossFlowDrag * Math.cos(Math.atan(tanBeta)) * rho * wetted * sideSpeed * sideSpeed * release
    : 0;
  // Water does not pull: where the explicit load would be suction (a section
  // leaving, or the convex rocker forward decelerating the flow), the flow
  // separates from the panel and ventilates down the side, so it carries
  // nothing. The added mass stays on the left-hand side either way.
  const sectional = Math.max(0, momentum + convective + crossFlow);
  const load = sectional * span;
  const zc = side * PRESSURE_CENTRE * wetted;
  const yc = keelY + PRESSURE_CENTRE * wetted * tanBeta;
  const fx = nx * load;
  const fy = ny * load;
  out.force.x += fx;
  out.force.y += fy;
  // r x F with F = (fx, fy, 0).
  out.moment.x += -zc * fy;
  out.moment.y += zc * fx;
  out.moment.z += x * fy - yc * fx;
  out.dynamicLift += fy;
  if (sectional > out.peakSectionLoad) out.peakSectionLoad = sectional;
  // J = [n; r x n], n = (nx, ny, 0).
  const jx = -zc * ny;
  const jy = zc * nx;
  const jz = x * ny - yc * nx;
  addOuter(out.addedMass, nx, ny, 0, jx, jy, jz, massPerLength * span);
}

const jacobian = new Float64Array(6);

/** added += m J J^T for J = (a, b, c, d, e, f), both triangles. */
function addOuter(
  added: Float64Array,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  mass: number,
): void {
  if (!(mass > 0)) return;
  jacobian[0] = a;
  jacobian[1] = b;
  jacobian[2] = c;
  jacobian[3] = d;
  jacobian[4] = e;
  jacobian[5] = f;
  for (let row = 0; row < 6; row += 1) {
    const jr = jacobian[row]! * mass;
    if (jr === 0) continue;
    for (let column = 0; column < 6; column += 1) added[row * 6 + column] = added[row * 6 + column]! + jr * jacobian[column]!;
  }
}
