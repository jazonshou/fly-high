import { describe, expect, it } from "vitest";
import { RigidBody, type RigidBodyInertia } from "../src/sim/rigidBody";
import type { Quaternion, Vec3 } from "../src/sim/types";

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function axisAngle(axis: Vec3, angle: number): Quaternion {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

function expectVec(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/** Dense Gaussian elimination with partial pivoting, the independent reference. */
function solveDense(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    }
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row]![column]! / a[column]![column]!;
      for (let k = column; k <= n; k += 1) a[row]![k]! -= factor * a[column]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row]![n]!;
    for (let k = row + 1; k < n; k += 1) sum -= a[row]![k]! * x[k]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

function inertiaRows(inertia: RigidBodyInertia): number[][] {
  const xy = inertia.xy ?? 0;
  const xz = inertia.xz ?? 0;
  const yz = inertia.yz ?? 0;
  return [
    [inertia.xx, xy, xz],
    [xy, inertia.yy, yz],
    [xz, yz, inertia.zz],
  ];
}

function worldAngularMomentum(body: RigidBody, inertia: RigidBodyInertia): Vec3 {
  const rows = inertiaRows(inertia);
  const w = body.angularVelocity;
  const h = vec(
    rows[0]![0]! * w.x + rows[0]![1]! * w.y + rows[0]![2]! * w.z,
    rows[1]![0]! * w.x + rows[1]![1]! * w.y + rows[1]![2]! * w.z,
    rows[2]![0]! * w.x + rows[2]![1]! * w.y + rows[2]![2]! * w.z,
  );
  return body.bodyToWorldVector(h, vec(0, 0, 0));
}

// Roughly a 6 m speedboat: 1.2 t, long and low.
const BOAT_INERTIA: RigidBodyInertia = { xx: 900, yy: 3_600, zz: 3_200, xy: -120 };

describe("rigid body without added mass", () => {
  it("integrates a force through the centre of mass with semi-implicit Euler", () => {
    const body = new RigidBody({ mass: 1_200, inertia: BOAT_INERTIA, position: vec(1, 2, 3), velocity: vec(4, 0, 0) });
    const dt = 1 / 240;
    let expectedVelocityY = 0;
    let expectedPositionY = 2;
    for (let i = 0; i < 240; i += 1) {
      body.addForce(vec(0, -1_200 * 9.80665, 0));
      body.step(dt);
      expectedVelocityY += -9.80665 * dt;
      expectedPositionY += expectedVelocityY * dt;
    }
    expect(body.velocity.y).toBe(expectedVelocityY);
    expect(body.position.y).toBeCloseTo(expectedPositionY, 12);
    expect(body.position.x).toBeCloseTo(1 + 4, 12);
    expectVec(body.linearAcceleration, vec(0, -9.80665, 0), 12);
    // No torque, no spin.
    expectVec(body.angularVelocity, vec(0, 0, 0), 15);
    expect(body.orientation.w).toBe(1);
  });

  it("turns a force at a point into r × F", () => {
    const inertia: RigidBodyInertia = { xx: 900, yy: 3_600, zz: 3_200 };
    const body = new RigidBody({ mass: 1_200, inertia, position: vec(10, 0, 10) });
    // Lift at the bow, 2 m ahead of the CG: pitch nose up (+Z) and heave up.
    body.addForceAtWorldPoint(vec(0, 1_000, 0), vec(12, 0, 10));
    body.step(0.01);
    expectVec(body.linearAcceleration, vec(0, 1_000 / 1_200, 0), 12);
    expectVec(body.angularAcceleration, vec(0, 0, 2_000 / 3_200), 12);
    // A body-frame thrust below the CG on a yawed body pitches the bow up too.
    const yawed = new RigidBody({ mass: 1_200, inertia, orientation: axisAngle(vec(0, 1, 0), Math.PI / 2) });
    yawed.addForceAtBodyPoint(vec(500, 0, 0), vec(-2, -0.5, 0));
    yawed.step(0.01);
    // Body +X is world -Z under a +90 degree yaw.
    expectVec(yawed.linearAcceleration, vec(0, 0, -500 / 1_200), 12);
    expectVec(yawed.angularAcceleration, vec(0, 0, (0.5 * 500) / 3_200), 12);
  });

  it("solves the full inertia tensor, products included", () => {
    const inertia: RigidBodyInertia = { xx: 900, yy: 3_600, zz: 3_200, xy: -120, xz: 40, yz: -15 };
    const body = new RigidBody({ mass: 1_200, inertia });
    const torque = vec(300, -200, 150);
    body.addTorqueBody(torque);
    body.step(1 / 240);
    const expected = solveDense(inertiaRows(inertia), [torque.x, torque.y, torque.z]);
    expectVec(body.angularAcceleration, vec(expected[0]!, expected[1]!, expected[2]!), 12);
    // A world torque is rotated into the body frame first.
    const rolled = new RigidBody({ mass: 1_200, inertia, orientation: axisAngle(vec(1, 0, 0), 0.3) });
    const torqueWorld = vec(0, 250, 0);
    rolled.addTorque(torqueWorld);
    rolled.step(1 / 240);
    // The step has moved the orientation, so rotate with the starting one.
    const reference = new RigidBody({ mass: 1_200, inertia, orientation: axisAngle(vec(1, 0, 0), 0.3) });
    const expectedBody = reference.worldToBodyVector(torqueWorld, vec(0, 0, 0));
    const solved = solveDense(inertiaRows(inertia), [expectedBody.x, expectedBody.y, expectedBody.z]);
    expectVec(rolled.angularAcceleration, vec(solved[0]!, solved[1]!, solved[2]!), 12);
  });

  it("keeps a torque-free spin about a principal axis exactly", () => {
    const body = new RigidBody({ mass: 1_200, inertia: { xx: 900, yy: 3_600, zz: 3_200 }, angularVelocity: vec(0, 0.8, 0) });
    const dt = 1 / 240;
    for (let i = 0; i < 480; i += 1) body.step(dt);
    expectVec(body.angularVelocity, vec(0, 0.8, 0), 15);
    // Two seconds at 0.8 rad/s is a 1.6 rad yaw.
    const expected = axisAngle(vec(0, 1, 0), 1.6);
    expect(Math.abs(body.orientation.x * expected.x + body.orientation.y * expected.y + body.orientation.z * expected.z + body.orientation.w * expected.w)).toBeCloseTo(1, 9);
  });

  it("conserves energy and world angular momentum in a torque-free tumble", () => {
    const inertia = BOAT_INERTIA;
    const body = new RigidBody({ mass: 1_200, inertia, angularVelocity: vec(0.6, 0.3, -0.4) });
    const energy0 = body.kineticEnergy();
    const momentum0 = worldAngularMomentum(body, inertia);
    const dt = 1 / 240;
    for (let i = 0; i < 2_400; i += 1) body.step(dt);
    const energy = body.kineticEnergy();
    const momentum = worldAngularMomentum(body, inertia);
    // Explicit gyroscopic terms drift slowly; ten seconds stays well under 1%.
    expect(Math.abs(energy / energy0 - 1)).toBeLessThan(0.01);
    const size0 = Math.hypot(momentum0.x, momentum0.y, momentum0.z);
    expect(Math.hypot(momentum.x - momentum0.x, momentum.y - momentum0.y, momentum.z - momentum0.z) / size0).toBeLessThan(0.01);
  });

  it("flips about the intermediate axis and holds about the major one", () => {
    // Principal moments 900 < 3 200 < 3 600: Z is the intermediate axis.
    const inertia: RigidBodyInertia = { xx: 900, yy: 3_600, zz: 3_200 };
    const intermediate = new RigidBody({ mass: 1_200, inertia, angularVelocity: vec(0.001, 0.001, 2) });
    const major = new RigidBody({ mass: 1_200, inertia, angularVelocity: vec(0.001, 2, 0.001) });
    const dt = 1 / 240;
    let largestWobble = 0;
    let majorWobble = 0;
    for (let i = 0; i < 4_800; i += 1) {
      intermediate.step(dt);
      major.step(dt);
      largestWobble = Math.max(largestWobble, Math.abs(intermediate.angularVelocity.x));
      majorWobble = Math.max(majorWobble, Math.abs(major.angularVelocity.x), Math.abs(major.angularVelocity.z));
    }
    expect(largestWobble).toBeGreaterThan(0.5);
    expect(majorWobble).toBeLessThan(0.01);
  });

  it("clears its loads after each step and ignores a bad dt", () => {
    const body = new RigidBody({ mass: 1_000, inertia: { xx: 1, yy: 1, zz: 1 } });
    body.addForce(vec(1_000, 0, 0));
    body.step(0.5);
    expect(body.velocity.x).toBe(0.5);
    body.step(0.5);
    expect(body.velocity.x).toBe(0.5);
    body.addForce(vec(1_000, 0, 0));
    body.step(Number.NaN);
    body.step(0);
    body.step(0.5);
    expect(body.velocity.x).toBe(0.5);
  });

  it("reports point velocities and frame transforms", () => {
    const body = new RigidBody({
      mass: 1_200,
      inertia: BOAT_INERTIA,
      position: vec(100, 1, -50),
      orientation: axisAngle(vec(0, 1, 0), Math.PI / 2),
      velocity: vec(0, 0, -8),
      angularVelocity: vec(0, 0.5, 0),
    });
    // The transom, 3 m behind the CG, sits at world +Z of the CG.
    const transom = body.bodyToWorldPoint(vec(-3, 0, 0), vec(0, 0, 0));
    expectVec(transom, vec(100, 1, -47), 12);
    expectVec(body.worldToBodyPoint(transom, vec(0, 0, 0)), vec(-3, 0, 0), 12);
    expectVec(body.bodyToWorldVector(vec(1, 0, 0), vec(0, 0, 0)), vec(0, 0, -1), 12);
    expectVec(body.worldToBodyVector(vec(0, 0, -1), vec(0, 0, 0)), vec(1, 0, 0), 12);
    // Yawing at +0.5 rad/s (bow to port) swings the transom, 3 m to world +Z
    // of the CG, east: ω × r = (0.5 · 3, 0, 0).
    expectVec(body.angularVelocityWorld(vec(0, 0, 0)), vec(0, 0.5, 0), 12);
    expectVec(body.pointVelocity(transom, vec(0, 0, 0)), vec(1.5, 0, -8), 12);
  });

  it("rejects bad mass properties", () => {
    expect(() => new RigidBody({ mass: 0, inertia: { xx: 1, yy: 1, zz: 1 } })).toThrow(RangeError);
    expect(() => new RigidBody({ mass: 1, inertia: { xx: 1, yy: 1, zz: -1 } })).toThrow(RangeError);
    // Products too large for the moments: not positive definite.
    expect(() => new RigidBody({ mass: 1, inertia: { xx: 1, yy: 1, zz: 1, xy: 2 } })).toThrow(RangeError);
  });
});

describe("rigid body with added mass", () => {
  function diagonalAddedMass(values: number[]): number[] {
    const a = new Array<number>(36).fill(0);
    values.forEach((value, i) => {
      a[i * 6 + i] = value;
    });
    return a;
  }

  it("divides a surge force by mass plus surge added mass", () => {
    const body = new RigidBody({ mass: 1_200, inertia: BOAT_INERTIA, orientation: axisAngle(vec(0, 1, 0), 0.4) });
    body.setAddedMass(diagonalAddedMass([60, 900, 700, 40, 1_500, 1_800]));
    const thrustBody = vec(3_000, 0, 0);
    body.addForce(body.bodyToWorldVector(thrustBody, vec(0, 0, 0)));
    body.step(1 / 240);
    const expected = body.bodyToWorldVector(vec(3_000 / 1_260, 0, 0), vec(0, 0, 0));
    // Orientation is unchanged by a pure force from rest.
    expectVec(body.linearAcceleration, expected, 12);
    expectVec(body.angularAcceleration, vec(0, 0, 0), 15);
  });

  it("matches a dense solve of (M + A) a = F with coupled terms", () => {
    const inertia = BOAT_INERTIA;
    const body = new RigidBody({ mass: 1_200, inertia });
    const a = diagonalAddedMass([60, 900, 700, 40, 1_500, 1_800]);
    // Sway-yaw and heave-pitch coupling, written only in the lower triangle.
    a[4 * 6 + 2] = 250;
    a[5 * 6 + 1] = -300;
    body.setAddedMass(a);
    const force = vec(500, -800, 1_200);
    const torque = vec(100, 400, -250);
    body.addForce(force);
    body.addTorqueBody(torque);
    body.step(1 / 240);
    const rows = inertiaRows(inertia);
    const m: number[][] = [];
    for (let i = 0; i < 6; i += 1) {
      m.push(new Array<number>(6).fill(0));
      m[i]![i] = a[i * 6 + i]!;
    }
    for (let i = 0; i < 3; i += 1) {
      m[i]![i]! += 1_200;
      for (let j = 0; j < 3; j += 1) m[i + 3]![j + 3]! += rows[i]![j]!;
    }
    m[4]![2] = m[2]![4] = 250;
    m[5]![1] = m[1]![5] = -300;
    const expected = solveDense(m, [force.x, force.y, force.z, torque.x, torque.y, torque.z]);
    expectVec(body.linearAcceleration, vec(expected[0]!, expected[1]!, expected[2]!), 12);
    expectVec(body.angularAcceleration, vec(expected[3]!, expected[4]!, expected[5]!), 12);
  });

  it("turns a drifting hull broadside with the Munk moment", () => {
    const body = new RigidBody({ mass: 1_200, inertia: BOAT_INERTIA, velocity: vec(6, 0, 0.6) });
    // Sway added mass far larger than surge, as for any slender hull.
    body.setAddedMass(diagonalAddedMass([60, 900, 700, 40, 1_500, 1_800]));
    body.step(1 / 240);
    // Moving ahead and to starboard, the bow swings to port: +Y yaw.
    expect(body.angularAcceleration.y).toBeGreaterThan(0);
    // The analytic moment is vz·vx·(A_sway − A_surge) about +Y.
    const yawMoment = 0.6 * 6 * (700 - 60);
    const withoutCoriolis = new RigidBody({ mass: 1_200, inertia: BOAT_INERTIA, velocity: vec(6, 0, 0.6) });
    withoutCoriolis.setAddedMass(diagonalAddedMass([60, 900, 700, 40, 1_500, 1_800]), { coriolis: false });
    withoutCoriolis.addTorqueBody(vec(0, yawMoment, 0));
    withoutCoriolis.step(1 / 240);
    expect(body.angularAcceleration.y).toBeCloseTo(withoutCoriolis.angularAcceleration.y, 12);
  });

  it("conserves the total kinetic energy of body and fluid", () => {
    const drift = (rate: number) => {
      const body = new RigidBody({
        mass: 1_200,
        inertia: BOAT_INERTIA,
        velocity: vec(5, 0.3, -0.8),
        angularVelocity: vec(0.2, -0.1, 0.15),
      });
      const a = diagonalAddedMass([60, 900, 700, 40, 1_500, 1_800]);
      a[4 * 6 + 2] = 250;
      body.setAddedMass(a);
      const energy0 = body.kineticEnergy();
      for (let i = 0; i < rate * 10; i += 1) body.step(1 / rate);
      return body.kineticEnergy() / energy0 - 1;
    };
    // Ten undamped seconds drift under 2% at 240 Hz, and halving the step
    // halves the drift: what is left is Euler's step error, not a wrong term,
    // which would leave a drift no step size removes.
    const coarse = drift(240);
    const fine = drift(480);
    expect(Math.abs(coarse)).toBeLessThan(0.02);
    expect(coarse / fine).toBeGreaterThan(1.8);
    expect(coarse / fine).toBeLessThan(2.2);
  });

  it("validates the matrix and can be cleared", () => {
    const body = new RigidBody({ mass: 1_200, inertia: BOAT_INERTIA });
    expect(() => body.setAddedMass([1, 2, 3])).toThrow(RangeError);
    const negative = diagonalAddedMass([-5_000, 0, 0, 0, 0, 0]);
    expect(() => body.setAddedMass(negative)).toThrow(RangeError);
    body.setAddedMass(diagonalAddedMass([800, 0, 0, 0, 0, 0]));
    body.setAddedMass(null);
    body.addForce(vec(1_200, 0, 0));
    body.step(1);
    expect(body.velocity.x).toBe(1);
  });
});
