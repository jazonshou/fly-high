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
 * The wetted beam grows with the section's own sinking across the local
 * water line, dd/dt = n_y V - v_z n_z: heeled, the section's sway along the
 * tilted water line carries it along the surface rather than into it.
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
 * deep-V heels INTO its turns. Heeled past its deadrise a panel enters chine
 * first, wetting inboard from the chine before the keel touches, so a boat
 * landing heeled off a crest takes the slam on its low side instead of
 * finding that side's water already there. Sway is a second slender-body strip, with the
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
/** Height of a mirrored vertical plate's elliptic sway load above its lower edge, as a share of its depth: 1 - 4/(3 pi). */
const PLATE_CENTRE = 1 - 4 / (3 * Math.PI);
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
    if (nby < MIN_NORMAL_Y) continue;
    const tanBeta = strips.tanDeadrise[i]!;
    const chine = strips.chineHalfBeam[i]!;
    // Heeled, the low chine can be under while the keel is still dry.
    if (depthPerp <= 0 && depthPerp - (nby * tanBeta - Math.abs(nbz)) * chine <= 0) continue;
    const x = strips.x[i]!;
    const keelY = strips.keelY[i]!;
    const kSlope = strips.keelSlope[i]!;
    const kCurve = strips.keelCurvature[i]!;
    const release = 1 - input.transomDry * (1 - Math.tanh(strips.transomDistance[i]! / releaseLength));
    const vx = input.relativeVelocity[i * 3]!;
    const vy = input.relativeVelocity[i * 3 + 1]!;
    const vz = input.relativeVelocity[i * 3 + 2]!;
    const along = vx;
    // Earth-plane penetration speed of the keel along body y, positive into the water.
    const penetration = -vy + along * kSlope;
    // How fast the section sinks across the local water line, as depth: the
    // penetration less the sway along a heeled water line. A heeled hull
    // sliding along the water is not sinking into it.
    const sink = nby * penetration - vz * nbz;
    // Section draft along body y, for sway.
    const draft = Math.min(Math.max(0, depthPerp) / nby, strips.sheerRise[i]!);
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
      // A point s out along the panel sinks across the water line at
      // sink + omegaX s (side n_y - tan(beta) n_z): the descending side's
      // wetted beam widens (roll damping).
      const rollSink = omegaX * (side * nby - tanBeta * nbz);
      const index = i * 2 + (side > 0 ? 1 : 0);
      if (slope <= 0.02) {
        // Heeled past the panel's own deadrise: the bottom is flat or face-up
        // to the water and the chine is its lowest edge. It enters chine
        // first, a band wetting inboard from the chine as the chine sinks.
        // Its inner edge is where the water crosses the panel, and moves
        // inboard at that point's sinking speed over the panel's descent
        // (so a hull rolling about its wet chine does not widen it). The
        // band's growing mass is the slam on that side; once the keel is
        // under the whole panel is wet and its mass stops growing. Its
        // pressure centre sits 2/pi of the band out from the inner edge,
        // which meets the wet panel's 2/pi of the chine as the keel goes under.
        const chineDepth = depthPerp - slope * chine;
        if (chineDepth <= 0) continue;
        const descent = Math.max(0.02, -slope);
        const wet = depthPerp >= 0 ? chine : Math.min(chine, chineDepth / descent);
        const centre = chine - (1 - PRESSURE_CENTRE) * wet;
        const entrySpeed = penetration + side * omegaX * centre + calibration.sideslipLift * side * tanBeta * vz;
        const edgeSink = sink + rollSink * (chine - wet);
        const massPerLength = ka * rho * (Math.PI / 4) * wet * wet * release;
        const massRate = wet < chine && edgeSink > 0 ? (ka * rho * (Math.PI / 2) * wet * edgeSink * release) / descent : 0;
        accumulateSide(out, x, keelY, tanBeta, side, wet, centre, nx, ny, massPerLength, massRate, entrySpeed, along, omegaY, omegaZ, kCurve, calibration, rho, release, span);
        out.wettedHalfBeam[index] = wet;
        continue;
      }
      if (depthPerp <= 0) continue;
      // The panel's speed into the water along its normal, at its pressure
      // centre: the keel's penetration, the roll rate there (the descending
      // side presses harder) and the sideslip driving the leading panel
      // deeper. The sideslip presses on the water the panel already has, but
      // does not widen it: the wetted beam grows at the centre's sinking.
      const centre = PRESSURE_CENTRE * Math.min(chine, (depthPerp / slope) * (1 + (WAGNER - 1) * speedSplash));
      const sideSpeed = penetration + side * omegaX * centre + calibration.sideslipLift * side * tanBeta * vz;
      const growth = sink + rollSink * centre;
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
      const massRate = Math.max(0, massSlope) * Math.max(0, growth) * release;
      accumulateSide(out, x, keelY, tanBeta, side, wetted, PRESSURE_CENTRE * wetted, nx, ny, massPerLength, massRate, sideSpeed, along, omegaY, omegaZ, kCurve, calibration, rho, release, span);
      out.wettedHalfBeam[index] = wetted;
      if (!trapped) {
        recordSpray(x, keelY, tanBeta, side, wetted, Math.hypot(along, (2 * lambda * nby * sideSpeed) / slope));
      } else if (sideSpeed > 0.2 && Math.abs(along) > 2) {
        // A wet chine or a tripped strake throws its sheet from the edge.
        recordSpray(x, keelY, tanBeta, side, wetted, Math.hypot(along, sideSpeed));
      }
    }

    // Sway strip. The V-bottom's sway is in its panels above; what is left
    // is the topsides once the chine is under (a vertical plate from the
    // chine down, mirrored in the surface: added mass k rho (pi/2) d^2, its
    // elliptic load centred 4/(3 pi) of the plate below the surface), and the
    // separated cross-flow drag on the section's whole draft.
    const chineRise = strips.chineRise[i]!;
    const plate = Math.max(0, draft - chineRise);
    const lateralMass = kl * rho * (Math.PI / 2) * plate * plate * release;
    const plateSink = sink / nby;
    const lateralMassRate = plateSink > 0 && draft < strips.sheerRise[i]! ? kl * rho * Math.PI * plate * plateSink * release : 0;
    const plateY = keelY + chineRise + PLATE_CENTRE * plate;
    const plateSway = vz + omegaX * (plateY - keelY);
    const inertial = -(lateralMass * along * omegaY + plateSway * lateralMassRate) * span;
    // Cross-flow: at rest the whole section sheds a wake with suction behind
    // it; on the plane the bottom's trailing side ventilates from the keel
    // and its leading panel's pressure is already its load, so only the
    // topsides stay in cross-flow.
    const dragDepth = plate + (draft - plate) * (1 - speedSplash);
    const dragY = keelY + draft - 0.5 * dragDepth;
    const dragSway = vz + omegaX * (dragY - keelY);
    const drag = -0.5 * calibration.lateralCrossFlowDrag * rho * dragDepth * dragSway * Math.abs(dragSway) * span;
    // Forces along +z at (x, y, 0): moment r x F = (y F, -x F, 0).
    force.z += inertial + drag;
    moment.x += plateY * inertial + dragY * drag;
    moment.y -= x * (inertial + drag);
    addOuter(added, 0, 0, 1, plateY, -x, 0, lateralMass * span);
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

/** One half-wedge's force along the keel normal, at its centre of pressure `centre` out from the keel, and its added mass. */
function accumulateSide(
  out: StripOutputs,
  x: number,
  keelY: number,
  tanBeta: number,
  side: number,
  wetted: number,
  centre: number,
  nx: number,
  ny: number,
  massPerLength: number,
  massRate: number,
  sideSpeed: number,
  along: number,
  omegaY: number,
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
  // The earth plane sees the next section aft: its pitch rate, rocker and
  // yaw rate (the last through the panel's tan(beta) of sway) change the
  // speed it meets the water at.
  const convective = massPerLength * (along * omegaZ - along * along * keelCurvature + side * tanBeta * along * omegaY);
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
  const zc = side * centre;
  const yc = keelY + centre * tanBeta;
  const fx = nx * load;
  const fy = ny * load;
  // The panel's pressure acts square to the panel, along (nx, ny, nz) with
  // nz = -side tan(beta) at this scaling: each half-wedge also pushes
  // inboard by tan(beta) of its lift. The two cancel running straight; in a
  // slide the loaded leading panel holds the hull (the V's bite), and its
  // line of action passes outboard of the CG, so it heels the hull inward.
  const nz = -side * tanBeta;
  const fz = nz * load;
  out.force.x += fx;
  out.force.y += fy;
  out.force.z += fz;
  // r x F with F = (fx, fy, fz).
  out.moment.x += yc * fz - zc * fy;
  out.moment.y += zc * fx - x * fz;
  out.moment.z += x * fy - yc * fx;
  out.dynamicLift += fy;
  if (sectional > out.peakSectionLoad) out.peakSectionLoad = sectional;
  // J = [n; r x n]: the panel's added mass acts along its normal, so it carries the bottom's sway inertia too.
  const jx = yc * nz - zc * ny;
  const jy = zc * nx - x * nz;
  const jz = x * ny - yc * nx;
  addOuter(out.addedMass, nx, ny, nz, jx, jy, jz, massPerLength * span);
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
