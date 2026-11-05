/**
 * The car's driveline as a small constrained system: five speeds (the
 * engine and the four wheels, `DRIVELINE_DOF`) with everything between them
 * written as constraint rows, solved by projected Gauss-Seidel each 480 Hz
 * substep (Catto, "Iterative Dynamics with Temporal Coherence", 2005; the
 * soft rows as in his "Soft Step", GDC 2011).
 *
 * Everything that turns at a fixed ratio to the wheels (propeller shafts,
 * the transmission output and, in gear, the turbine or clutch disc) is not a
 * state of its own: its inertia is folded into the wheels' mass matrix,
 * which is why that matrix couples the two wheels of each axle. What can
 * slip or lock becomes a row:
 *
 * - a friction row with an impulse bound: the dry clutch or the converter's
 *   lockup clutch (engine against the transmission input), the four service
 *   brakes, the parking pawl and the transmission-drum handbrake on the rear
 *   propeller shaft;
 * - a bilateral row: a locked differential joining its two wheels;
 * - a soft row: the windup spring between the front and rear propeller
 *   shafts when 4H or 4L locks them together with no centre differential.
 *
 * Smooth torques (combustion, the torque converter's fluid coupling, the
 * tyres) are external torques the caller adds. The order of rows and the
 * iteration count are fixed, so the solve is deterministic, and nothing
 * here allocates after construction.
 *
 * The caller writes numbers into the solver's fields and arrays rather than
 * passing them: V8 boxes a number passed to a call it does not inline, and
 * the car's step allocates nothing.
 */

/** Engine, then the wheels in `CAR_WHEELS` order: front left, front right, rear left, rear right. */
export const DRIVELINE_DOF = 5;
export const ENGINE = 0;
export const MAX_DRIVELINE_ROWS = 12;
const ITERATIONS = 16;

export class DrivelineSolver {
  /** Angular velocities, rad/s, in DOF order. */
  readonly omega = new Float64Array(DRIVELINE_DOF);
  /** Each row's impulse from the last solve, N m s (divide by the substep for a torque). */
  readonly impulse = new Float64Array(MAX_DRIVELINE_ROWS);
  rowCount = 0;
  /** The substep `solve` advances by, s. */
  dt = 0;

  /**
   * The mass matrix (`updateInertia` after changing it): the engine's
   * inertia, each wheel's own spin inertia, and per axle the inertia shared
   * by its two wheels (what turns with the mean of their speeds, reflected
   * to a wheel: I (ratio / 2)^2), kg m^2.
   */
  engineInertia = 1;
  wheelInertia = 1;
  frontShared = 0;
  rearShared = 0;

  /**
   * The rows, `openRow` to add one: J omega = target, the row's five
   * Jacobian entries at `row * DRIVELINE_DOF`. `lower`/`upper` bound the
   * impulse (a friction row's torque capacity times the substep);
   * `softness` is Catto's gamma, and `bias` the target with any position
   * bias in it.
   */
  readonly jacobian = new Float64Array(MAX_DRIVELINE_ROWS * DRIVELINE_DOF);
  readonly lower = new Float64Array(MAX_DRIVELINE_ROWS);
  readonly upper = new Float64Array(MAX_DRIVELINE_ROWS);
  readonly bias = new Float64Array(MAX_DRIVELINE_ROWS);
  readonly softness = new Float64Array(MAX_DRIVELINE_ROWS);

  // Each axle's 2 x 2 block [[a, c], [c, a]] inverted: a', c', a' per axle.
  private readonly blockInverse = new Float64Array(6);
  private readonly minvJ = new Float64Array(MAX_DRIVELINE_ROWS * DRIVELINE_DOF);
  private readonly effectiveMass = new Float64Array(MAX_DRIVELINE_ROWS);
  private readonly work = new Float64Array(DRIVELINE_DOF);

  updateInertia(): void {
    const b = this.blockInverse;
    for (let axle = 0; axle < 2; axle += 1) {
      const c = axle === 0 ? this.frontShared : this.rearShared;
      const a = this.wheelInertia + c;
      const determinant = a * a - c * c;
      b[axle * 3] = a / determinant;
      b[axle * 3 + 1] = -c / determinant;
      b[axle * 3 + 2] = a / determinant;
    }
  }

  beginRows(): void {
    this.rowCount = 0;
  }

  /** A new row, zeroed and unbounded with no target; -1 when the rows are full. */
  openRow(): number {
    const row = this.rowCount;
    if (row >= MAX_DRIVELINE_ROWS) return -1;
    this.jacobian.fill(0, row * DRIVELINE_DOF, (row + 1) * DRIVELINE_DOF);
    this.lower[row] = -Infinity;
    this.upper[row] = Infinity;
    this.bias[row] = 0;
    this.softness[row] = 0;
    this.rowCount = row + 1;
    return row;
  }

  /** Apply M^-1 to a DOF vector, in place. */
  private applyInverse(v: Float64Array, offset: number): void {
    const b = this.blockInverse;
    v[offset] = v[offset]! / this.engineInertia;
    const fl = v[offset + 1]!;
    const fr = v[offset + 2]!;
    v[offset + 1] = b[0]! * fl + b[1]! * fr;
    v[offset + 2] = b[1]! * fl + b[2]! * fr;
    const rl = v[offset + 3]!;
    const rr = v[offset + 4]!;
    v[offset + 3] = b[3]! * rl + b[4]! * rr;
    v[offset + 4] = b[4]! * rl + b[5]! * rr;
  }

  /**
   * One substep of `dt`: integrate the external torques (N m, DOF order),
   * then project the rows. Speeds are updated in place.
   */
  solve(torque: Float64Array): void {
    const dt = this.dt;
    const w = this.work;
    for (let i = 0; i < DRIVELINE_DOF; i += 1) w[i] = torque[i]! * dt;
    this.applyInverse(w, 0);
    const omega = this.omega;
    for (let i = 0; i < DRIVELINE_DOF; i += 1) omega[i] = omega[i]! + w[i]!;

    const rows = this.rowCount;
    const j = this.jacobian;
    const minvJ = this.minvJ;
    for (let row = 0; row < rows; row += 1) {
      const offset = row * DRIVELINE_DOF;
      for (let i = 0; i < DRIVELINE_DOF; i += 1) minvJ[offset + i] = j[offset + i]!;
      this.applyInverse(minvJ, offset);
      let k = this.softness[row]!;
      for (let i = 0; i < DRIVELINE_DOF; i += 1) k += j[offset + i]! * minvJ[offset + i]!;
      this.effectiveMass[row] = k > 1e-12 ? 1 / k : 0;
      this.impulse[row] = 0;
    }
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      for (let row = 0; row < rows; row += 1) {
        const offset = row * DRIVELINE_DOF;
        let velocity = 0;
        for (let i = 0; i < DRIVELINE_DOF; i += 1) velocity += j[offset + i]! * omega[i]!;
        const accumulated = this.impulse[row]!;
        const delta = -(velocity - this.bias[row]! + this.softness[row]! * accumulated) * this.effectiveMass[row]!;
        let next = accumulated + delta;
        if (next < this.lower[row]!) next = this.lower[row]!;
        else if (next > this.upper[row]!) next = this.upper[row]!;
        const applied = next - accumulated;
        if (applied === 0) continue;
        this.impulse[row] = next;
        for (let i = 0; i < DRIVELINE_DOF; i += 1) omega[i] = omega[i]! + minvJ[offset + i]! * applied;
      }
    }
  }
}
