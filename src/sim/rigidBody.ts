import { inverseRotateVectorInto, normalizeQuaternionInto, rotateVectorInto } from "./math";
import type { Quaternion, Vec3 } from "./types";

/**
 * A free 6-DOF rigid body for surface vehicles (boats, the Land Cruiser's
 * chassis). The aircraft keep their own integrator in `simulation.ts`.
 *
 * Conventions match the flight sim: the world is Y-up (+X east, +Z north),
 * the body frame is +X nose, +Y up, +Z starboard, `orientation` rotates body
 * vectors into the world, `velocity` is the centre of mass's WORLD velocity
 * and `angularVelocity` is in the BODY frame. The body's reference point is
 * its centre of mass; every body-frame point is relative to it.
 *
 * Callers accumulate forces and torques during a step (gravity included,
 * since buoyancy and added mass make "weight" a caller's business), then call
 * `step(dt)`, which integrates with semi-implicit Euler (velocities, then
 * pose) and clears the accumulators. Nothing on that path allocates, and any
 * dt works, so a vehicle can substep as finely as it likes.
 *
 * An optional added-mass matrix A (the fluid a hull drags along) turns the
 * step into the ideal-fluid Kirchhoff equations about the centre of mass:
 *
 *   (M_RB + A) dν/dt = τ − C(ν)ν,   ν = [v_body; ω],
 *
 * where C(ν)ν carries the rigid-body and (by default) the added-mass
 * Coriolis and centripetal terms, including the Munk moment that turns a hull
 * broadside to its velocity. M_RB + A is factored once per `setAddedMass`
 * with an LDLᵀ decomposition held in preallocated storage.
 */

/**
 * Body-frame inertia tensor about the centre of mass, kg·m². The products are
 * the off-diagonal ENTRIES of the matrix, i.e. −∫xy dm, and default to 0.
 */
export interface RigidBodyInertia {
  readonly xx: number;
  readonly yy: number;
  readonly zz: number;
  readonly xy?: number;
  readonly xz?: number;
  readonly yz?: number;
}

export interface RigidBodyOptions {
  mass: number;
  inertia: RigidBodyInertia;
  position?: Vec3;
  orientation?: Quaternion;
  /** World velocity of the centre of mass. */
  velocity?: Vec3;
  /** Body-frame angular velocity. */
  angularVelocity?: Vec3;
}

export interface AddedMassOptions {
  /**
   * Include A's Coriolis and centripetal terms (Munk moment and kin). On by
   * default; turn it off only if the caller already puts them in its forces.
   */
  coriolis?: boolean;
}

/**
 * Index order of the 6×6 added-mass matrix: body linear then angular, along
 * +X (surge), +Y (heave), +Z (sway), then about +X (roll), +Y (yaw), +Z
 * (pitch). Row-major, 36 entries; only the lower triangle is read and the
 * matrix is taken as symmetric.
 */
export const ADDED_MASS_SIZE = 6;

const scratchA: Vec3 = { x: 0, y: 0, z: 0 };
const scratchB: Vec3 = { x: 0, y: 0, z: 0 };

export class RigidBody {
  readonly position: Vec3;
  readonly orientation: Quaternion;
  readonly velocity: Vec3;
  readonly angularVelocity: Vec3;
  /** World linear acceleration of the centre of mass over the last step. */
  readonly linearAcceleration: Vec3 = { x: 0, y: 0, z: 0 };
  /** Body-frame angular acceleration over the last step. */
  readonly angularAcceleration: Vec3 = { x: 0, y: 0, z: 0 };

  private massValue = 1;
  // Row-major 3×3 inertia and its LDLᵀ factors.
  private readonly inertiaMatrix = new Float64Array(9);
  private readonly inertiaLower = new Float64Array(9);
  private readonly inertiaDiagonal = new Float64Array(3);

  private hasAddedMass = false;
  private addedMassCoriolis = true;
  private readonly addedMass = new Float64Array(36);
  private readonly systemMatrix = new Float64Array(36);
  private readonly systemLower = new Float64Array(36);
  private readonly systemDiagonal = new Float64Array(6);
  private readonly nu = new Float64Array(6);
  private readonly rhs = new Float64Array(6);
  private readonly nuDot = new Float64Array(6);
  private readonly momentum = new Float64Array(6);

  private readonly forceWorld: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly torqueWorld: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly torqueBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly velocityBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly forceBody: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly torqueTotal: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(options: RigidBodyOptions) {
    this.position = { ...(options.position ?? { x: 0, y: 0, z: 0 }) };
    this.orientation = normalizeQuaternionInto({ x: 0, y: 0, z: 0, w: 1 }, options.orientation ?? { x: 0, y: 0, z: 0, w: 1 });
    this.velocity = { ...(options.velocity ?? { x: 0, y: 0, z: 0 }) };
    this.angularVelocity = { ...(options.angularVelocity ?? { x: 0, y: 0, z: 0 }) };
    this.setMassProperties(options.mass, options.inertia);
  }

  get mass(): number {
    return this.massValue;
  }

  /** Change mass and inertia (fuel burn, passengers); refactors added mass. */
  setMassProperties(mass: number, inertia: RigidBodyInertia): void {
    if (!(mass > 0) || !Number.isFinite(mass)) throw new RangeError("Rigid body mass must be positive and finite");
    const m = this.inertiaMatrix;
    const xy = inertia.xy ?? 0;
    const xz = inertia.xz ?? 0;
    const yz = inertia.yz ?? 0;
    m[0] = inertia.xx;
    m[1] = xy;
    m[2] = xz;
    m[3] = xy;
    m[4] = inertia.yy;
    m[5] = yz;
    m[6] = xz;
    m[7] = yz;
    m[8] = inertia.zz;
    if (!factorLdlt(m, 3, this.inertiaLower, this.inertiaDiagonal)) {
      throw new RangeError("Rigid body inertia must be symmetric positive definite");
    }
    this.massValue = mass;
    if (this.hasAddedMass) this.factorSystem();
  }

  /**
   * Set (or clear, with null) the body-frame added-mass matrix about the
   * centre of mass; see `ADDED_MASS_SIZE` for the layout. Cheap enough to call
   * every step as a hull's immersion changes. Throws if M_RB + A is not
   * positive definite, which a physical added mass never causes.
   */
  setAddedMass(matrix: ArrayLike<number> | null, options: AddedMassOptions = {}): void {
    if (matrix === null) {
      this.hasAddedMass = false;
      return;
    }
    if (matrix.length !== 36) throw new RangeError("Added mass needs a 6×6 matrix (36 entries)");
    const a = this.addedMass;
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column <= row; column += 1) {
        const value = matrix[row * 6 + column]!;
        if (!Number.isFinite(value)) throw new RangeError("Added mass entries must be finite");
        a[row * 6 + column] = value;
        a[column * 6 + row] = value;
      }
    }
    this.addedMassCoriolis = options.coriolis ?? true;
    this.hasAddedMass = true;
    this.factorSystem();
  }

  /** A world force through the centre of mass (gravity). */
  addForce(forceWorld: Vec3): void {
    this.forceWorld.x += forceWorld.x;
    this.forceWorld.y += forceWorld.y;
    this.forceWorld.z += forceWorld.z;
  }

  /** A world force applied at a world point. */
  addForceAtWorldPoint(forceWorld: Vec3, pointWorld: Vec3): void {
    this.addForce(forceWorld);
    const rx = pointWorld.x - this.position.x;
    const ry = pointWorld.y - this.position.y;
    const rz = pointWorld.z - this.position.z;
    this.torqueWorld.x += ry * forceWorld.z - rz * forceWorld.y;
    this.torqueWorld.y += rz * forceWorld.x - rx * forceWorld.z;
    this.torqueWorld.z += rx * forceWorld.y - ry * forceWorld.x;
  }

  /** A body-frame force applied at a body-frame point (thrust at the prop). */
  addForceAtBodyPoint(forceBody: Vec3, pointBody: Vec3): void {
    rotateVectorInto(scratchA, this.orientation, forceBody);
    this.addForce(scratchA);
    this.torqueBody.x += pointBody.y * forceBody.z - pointBody.z * forceBody.y;
    this.torqueBody.y += pointBody.z * forceBody.x - pointBody.x * forceBody.z;
    this.torqueBody.z += pointBody.x * forceBody.y - pointBody.y * forceBody.x;
  }

  addTorque(torqueWorld: Vec3): void {
    this.torqueWorld.x += torqueWorld.x;
    this.torqueWorld.y += torqueWorld.y;
    this.torqueWorld.z += torqueWorld.z;
  }

  addTorqueBody(torqueBody: Vec3): void {
    this.torqueBody.x += torqueBody.x;
    this.torqueBody.y += torqueBody.y;
    this.torqueBody.z += torqueBody.z;
  }

  clearForces(): void {
    this.forceWorld.x = 0;
    this.forceWorld.y = 0;
    this.forceWorld.z = 0;
    this.torqueWorld.x = 0;
    this.torqueWorld.y = 0;
    this.torqueWorld.z = 0;
    this.torqueBody.x = 0;
    this.torqueBody.y = 0;
    this.torqueBody.z = 0;
  }

  /**
   * Advance by `dt` seconds under the accumulated loads, then clear them. A
   * non-finite or non-positive dt only clears the loads.
   */
  step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) {
      this.clearForces();
      return;
    }
    const q = this.orientation;
    const omega = this.angularVelocity;
    const tau = inverseRotateVectorInto(this.torqueTotal, q, this.torqueWorld);
    tau.x += this.torqueBody.x;
    tau.y += this.torqueBody.y;
    tau.z += this.torqueBody.z;

    if (this.hasAddedMass) {
      this.solveWithAddedMass(tau);
    } else {
      // Without added mass the linear part is exactly F/m in the world frame.
      const inverseMass = 1 / this.massValue;
      this.linearAcceleration.x = this.forceWorld.x * inverseMass;
      this.linearAcceleration.y = this.forceWorld.y * inverseMass;
      this.linearAcceleration.z = this.forceWorld.z * inverseMass;
      // Euler's equation with the full tensor: I dω/dt = τ − ω × Iω.
      const m = this.inertiaMatrix;
      const hx = m[0]! * omega.x + m[1]! * omega.y + m[2]! * omega.z;
      const hy = m[3]! * omega.x + m[4]! * omega.y + m[5]! * omega.z;
      const hz = m[6]! * omega.x + m[7]! * omega.y + m[8]! * omega.z;
      const rhs = this.rhs;
      rhs[0] = tau.x - (omega.y * hz - omega.z * hy);
      rhs[1] = tau.y - (omega.z * hx - omega.x * hz);
      rhs[2] = tau.z - (omega.x * hy - omega.y * hx);
      solveLdlt(this.inertiaLower, this.inertiaDiagonal, 3, rhs, this.nuDot);
      this.angularAcceleration.x = this.nuDot[0]!;
      this.angularAcceleration.y = this.nuDot[1]!;
      this.angularAcceleration.z = this.nuDot[2]!;
    }

    this.velocity.x += this.linearAcceleration.x * dt;
    this.velocity.y += this.linearAcceleration.y * dt;
    this.velocity.z += this.linearAcceleration.z * dt;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
    omega.x += this.angularAcceleration.x * dt;
    omega.y += this.angularAcceleration.y * dt;
    omega.z += this.angularAcceleration.z * dt;

    // q_dot = 1/2 * q * omega_body, as in the flight integrator.
    const halfDt = 0.5 * dt;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    q.x += halfDt * (qw * omega.x + qy * omega.z - qz * omega.y);
    q.y += halfDt * (qw * omega.y - qx * omega.z + qz * omega.x);
    q.z += halfDt * (qw * omega.z + qx * omega.y - qy * omega.x);
    q.w += halfDt * (-qx * omega.x - qy * omega.y - qz * omega.z);
    normalizeQuaternionInto(q, q);
    this.clearForces();
  }

  /** World velocity of a world point fixed to the body. */
  pointVelocity(pointWorld: Vec3, out: Vec3): Vec3 {
    rotateVectorInto(scratchB, this.orientation, this.angularVelocity);
    const rx = pointWorld.x - this.position.x;
    const ry = pointWorld.y - this.position.y;
    const rz = pointWorld.z - this.position.z;
    out.x = this.velocity.x + (scratchB.y * rz - scratchB.z * ry);
    out.y = this.velocity.y + (scratchB.z * rx - scratchB.x * rz);
    out.z = this.velocity.z + (scratchB.x * ry - scratchB.y * rx);
    return out;
  }

  bodyToWorldPoint(pointBody: Vec3, out: Vec3): Vec3 {
    rotateVectorInto(out, this.orientation, pointBody);
    out.x += this.position.x;
    out.y += this.position.y;
    out.z += this.position.z;
    return out;
  }

  worldToBodyPoint(pointWorld: Vec3, out: Vec3): Vec3 {
    out.x = pointWorld.x - this.position.x;
    out.y = pointWorld.y - this.position.y;
    out.z = pointWorld.z - this.position.z;
    return inverseRotateVectorInto(out, this.orientation, out);
  }

  bodyToWorldVector(vectorBody: Vec3, out: Vec3): Vec3 {
    return rotateVectorInto(out, this.orientation, vectorBody);
  }

  worldToBodyVector(vectorWorld: Vec3, out: Vec3): Vec3 {
    return inverseRotateVectorInto(out, this.orientation, vectorWorld);
  }

  /** Angular velocity in the world frame. */
  angularVelocityWorld(out: Vec3): Vec3 {
    return rotateVectorInto(out, this.orientation, this.angularVelocity);
  }

  /** Kinetic energy, J, including the fluid's share when added mass is set. */
  kineticEnergy(): number {
    this.loadNu();
    this.multiplyMomentum(this.hasAddedMass);
    let energy = 0;
    for (let i = 0; i < 6; i += 1) energy += this.nu[i]! * this.momentum[i]!;
    return 0.5 * energy;
  }

  private factorSystem(): void {
    const s = this.systemMatrix;
    const a = this.addedMass;
    const inertia = this.inertiaMatrix;
    for (let i = 0; i < 36; i += 1) s[i] = a[i]!;
    s[0] = s[0]! + this.massValue;
    s[7] = s[7]! + this.massValue;
    s[14] = s[14]! + this.massValue;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const index = (row + 3) * 6 + column + 3;
        s[index] = s[index]! + inertia[row * 3 + column]!;
      }
    }
    if (!factorLdlt(s, 6, this.systemLower, this.systemDiagonal)) {
      this.hasAddedMass = false;
      throw new RangeError("Rigid body mass plus added mass must be positive definite");
    }
  }

  private loadNu(): void {
    inverseRotateVectorInto(this.velocityBody, this.orientation, this.velocity);
    const nu = this.nu;
    nu[0] = this.velocityBody.x;
    nu[1] = this.velocityBody.y;
    nu[2] = this.velocityBody.z;
    nu[3] = this.angularVelocity.x;
    nu[4] = this.angularVelocity.y;
    nu[5] = this.angularVelocity.z;
  }

  /** momentum = M_RB ν, plus A ν when `withAddedMass`. */
  private multiplyMomentum(withAddedMass: boolean): void {
    const nu = this.nu;
    const p = this.momentum;
    const inertia = this.inertiaMatrix;
    p[0] = this.massValue * nu[0]!;
    p[1] = this.massValue * nu[1]!;
    p[2] = this.massValue * nu[2]!;
    for (let row = 0; row < 3; row += 1) {
      p[row + 3] =
        inertia[row * 3]! * nu[3]! + inertia[row * 3 + 1]! * nu[4]! + inertia[row * 3 + 2]! * nu[5]!;
    }
    if (!withAddedMass) return;
    const a = this.addedMass;
    for (let row = 0; row < 6; row += 1) {
      let sum = 0;
      for (let column = 0; column < 6; column += 1) sum += a[row * 6 + column]! * nu[column]!;
      p[row] = p[row]! + sum;
    }
  }

  /**
   * Kirchhoff's equations in the body frame: with [p; h] = M ν,
   *   dp/dt + ω × p = F,   dh/dt + ω × h + v × p = τ.
   */
  private solveWithAddedMass(tau: Vec3): void {
    this.loadNu();
    this.multiplyMomentum(this.addedMassCoriolis);
    const v = this.velocityBody;
    const omega = this.angularVelocity;
    const p = this.momentum;
    const f = inverseRotateVectorInto(this.forceBody, this.orientation, this.forceWorld);
    const px = p[0]!;
    const py = p[1]!;
    const pz = p[2]!;
    const hx = p[3]!;
    const hy = p[4]!;
    const hz = p[5]!;
    const rhs = this.rhs;
    rhs[0] = f.x - (omega.y * pz - omega.z * py);
    rhs[1] = f.y - (omega.z * px - omega.x * pz);
    rhs[2] = f.z - (omega.x * py - omega.y * px);
    rhs[3] = tau.x - (omega.y * hz - omega.z * hy) - (v.y * pz - v.z * py);
    rhs[4] = tau.y - (omega.z * hx - omega.x * hz) - (v.z * px - v.x * pz);
    rhs[5] = tau.z - (omega.x * hy - omega.y * hx) - (v.x * py - v.y * px);
    const nuDot = this.nuDot;
    solveLdlt(this.systemLower, this.systemDiagonal, 6, rhs, nuDot);
    // The world acceleration is the body-frame derivative plus ω × v.
    scratchA.x = nuDot[0]! + (omega.y * v.z - omega.z * v.y);
    scratchA.y = nuDot[1]! + (omega.z * v.x - omega.x * v.z);
    scratchA.z = nuDot[2]! + (omega.x * v.y - omega.y * v.x);
    rotateVectorInto(this.linearAcceleration, this.orientation, scratchA);
    this.angularAcceleration.x = nuDot[3]!;
    this.angularAcceleration.y = nuDot[4]!;
    this.angularAcceleration.z = nuDot[5]!;
  }
}

/**
 * LDLᵀ factors of the symmetric n×n row-major `matrix` (lower triangle read).
 * Returns false unless it is positive definite.
 */
function factorLdlt(matrix: Float64Array, n: number, lower: Float64Array, diagonal: Float64Array): boolean {
  for (let j = 0; j < n; j += 1) {
    let d = matrix[j * n + j]!;
    for (let k = 0; k < j; k += 1) {
      const l = lower[j * n + k]!;
      d -= l * l * diagonal[k]!;
    }
    if (!(d > 0) || !Number.isFinite(d)) return false;
    diagonal[j] = d;
    lower[j * n + j] = 1;
    for (let i = j + 1; i < n; i += 1) {
      let sum = matrix[i * n + j]!;
      for (let k = 0; k < j; k += 1) sum -= lower[i * n + k]! * lower[j * n + k]! * diagonal[k]!;
      lower[i * n + j] = sum / d;
    }
  }
  return true;
}

/** Solve L D Lᵀ x = b; `out` may not alias `b`. */
function solveLdlt(lower: Float64Array, diagonal: Float64Array, n: number, b: Float64Array, out: Float64Array): void {
  for (let i = 0; i < n; i += 1) {
    let sum = b[i]!;
    for (let k = 0; k < i; k += 1) sum -= lower[i * n + k]! * out[k]!;
    out[i] = sum;
  }
  for (let i = 0; i < n; i += 1) out[i] = out[i]! / diagonal[i]!;
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = out[i]!;
    for (let k = i + 1; k < n; k += 1) sum -= lower[k * n + i]! * out[k]!;
    out[i] = sum;
  }
}
