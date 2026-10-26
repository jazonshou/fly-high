import { describe, expect, it } from "vitest";
import {
  COLLIDER_BIN_SIZE_METERS,
  ColliderWorld,
  createColliderContact,
  type ColliderAabb,
} from "../src/sim/colliders";
import type { Quaternion, Vec3 } from "../src/sim/types";

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 };

function yaw(radians: number): Quaternion {
  return { x: 0, y: Math.sin(radians / 2), z: 0, w: Math.cos(radians / 2) };
}

function roll(radians: number): Quaternion {
  return { x: Math.sin(radians / 2), y: 0, z: 0, w: Math.cos(radians / 2) };
}

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): ColliderAabb {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function expectVec(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe("collider contacts", () => {
  it("reports a sphere-sphere overlap along the line of centres", () => {
    const world = new ColliderWorld();
    const handle = world.addStatic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 }, { material: 7, position: vec(10, 2, -4) });
    const contact = createColliderContact();
    expect(world.contactSphere(handle, vec(10, 2, -2.8), 0.5, contact)).toBe(true);
    expect(contact.handle).toBe(handle);
    expect(contact.material).toBe(7);
    expect(contact.penetration).toBeCloseTo(0.3, 12);
    expectVec(contact.normal, vec(0, 0, 1));
    expectVec(contact.point, vec(10, 2, -3));
    expectVec(contact.pointVelocity, vec(0, 0, 0));
    // Just apart: no contact, and the target is left as it was.
    contact.penetration = 123;
    expect(world.contactSphere(handle, vec(10, 2, -2.49), 0.5, contact)).toBe(false);
    expect(contact.penetration).toBe(123);
  });

  it("clamps a capsule contact to the segment and its end caps", () => {
    const world = new ColliderWorld();
    // A vertical pile from the bed to above the water.
    const pile = world.addStatic({ kind: "capsule", a: vec(0, -3, 0), b: vec(0, 2, 0), radius: 0.2 });
    const contact = createColliderContact();
    expect(world.contactSphere(pile, vec(0.3, 0.5, 0), 0.15, contact)).toBe(true);
    expect(contact.penetration).toBeCloseTo(0.05, 12);
    expectVec(contact.normal, vec(1, 0, 0));
    expectVec(contact.point, vec(0.2, 0.5, 0));
    // Above the top: the end cap answers along +Y.
    expect(world.contactSphere(pile, vec(0, 2.3, 0), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 1, 0));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
    // On the core itself the push is straight up.
    expect(world.contactSphere(pile, vec(0, 0, 0), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 1, 0));
    expect(contact.penetration).toBeCloseTo(0.35, 12);
  });

  it("places capsule ends through a rotated local frame", () => {
    const world = new ColliderWorld();
    // Local +X becomes world -Z under a +90 degree yaw.
    const rail = world.addStatic(
      { kind: "capsule", a: vec(0, 0, 0), b: vec(10, 0, 0), radius: 0.1 },
      { position: vec(5, 1, 5), orientation: yaw(Math.PI / 2) },
    );
    const bounds = world.bounds(rail, aabb(0, 0, 0, 0, 0, 0));
    expect(bounds.minX).toBeCloseTo(4.9, 9);
    expect(bounds.maxX).toBeCloseTo(5.1, 9);
    expect(bounds.minZ).toBeCloseTo(-5.1, 9);
    expect(bounds.maxZ).toBeCloseTo(5.1, 9);
    const contact = createColliderContact();
    expect(world.contactSphere(rail, vec(5.2, 1, 0), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(1, 0, 0));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
  });

  it("uses the nearest segment of a polyline", () => {
    const world = new ColliderWorld();
    const guardrail = world.addStatic({
      kind: "polyline",
      points: [vec(0, 0.6, 0), vec(10, 0.6, 0), vec(20, 0.6, 5)],
      radius: 0.15,
    });
    const contact = createColliderContact();
    expect(world.contactSphere(guardrail, vec(5, 0.6, 0.25), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 0, 1));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
    // Past the bend the second segment is the closer one.
    const along = vec(2 / Math.sqrt(5), 0, 1 / Math.sqrt(5));
    const outward = vec(along.z, 0, -along.x);
    const probe = vec(15 + outward.x * 0.25, 0.6, 2.5 + outward.z * 0.25);
    expect(world.contactSphere(guardrail, probe, 0.15, contact)).toBe(true);
    expectVec(contact.normal, outward);
    expect(contact.penetration).toBeCloseTo(0.05, 12);
  });

  it("touches an axis-aligned box on faces, edges and corners", () => {
    const world = new ColliderWorld();
    const deck = world.addStatic({ kind: "box", center: vec(0, 1, 0), halfExtents: vec(4, 0.25, 1.5) });
    const contact = createColliderContact();
    // Face: a hull point resting on the deck.
    expect(world.contactSphere(deck, vec(1, 1.35, 0.5), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 1, 0));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
    expectVec(contact.point, vec(1, 1.25, 0.5));
    // Edge: the long top edge along X.
    const d = 0.1 / Math.SQRT2;
    expect(world.contactSphere(deck, vec(0, 1.25 + d, 1.5 + d), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, Math.SQRT1_2, Math.SQRT1_2));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
    expectVec(contact.point, vec(0, 1.25, 1.5));
    // Corner.
    const c = 0.1 / Math.sqrt(3);
    expect(world.contactSphere(deck, vec(4 + c, 1.25 + c, -1.5 - c), 0.15, contact)).toBe(true);
    const n = 1 / Math.sqrt(3);
    expectVec(contact.normal, vec(n, n, -n));
    expect(contact.penetration).toBeCloseTo(0.05, 12);
  });

  it("pushes a probe centre inside a box out through the nearest face", () => {
    const world = new ColliderWorld();
    const wall = world.addStatic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(10, 2, 1) });
    const contact = createColliderContact();
    // 0.2 m inside the -Z face, far from the others.
    expect(world.contactSphere(wall, vec(3, 0, -0.8), 0.15, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 0, -1));
    expect(contact.penetration).toBeCloseTo(0.35, 12);
    expectVec(contact.point, vec(3, 0, -1));
    // A tie between faces prefers up.
    const cube = world.addStatic({ kind: "box", center: vec(50, 0, 0), halfExtents: vec(1, 1, 1) });
    expect(world.contactSphere(cube, vec(50, 0, 0), 0.1, contact)).toBe(true);
    expectVec(contact.normal, vec(0, 1, 0));
    expect(contact.penetration).toBeCloseTo(1.1, 12);
  });

  it("composes the pose with the box's own orientation", () => {
    const world = new ColliderWorld();
    // A quay wall turned 30 degrees in its local frame, the frame turned another
    // 15: the face normal is local +X turned 45 degrees about +Y.
    const quay = world.addStatic(
      { kind: "box", center: vec(0, 0, 0), halfExtents: vec(1, 3, 20), orientation: yaw(Math.PI / 6) },
      { position: vec(100, 0, 200), orientation: yaw(Math.PI / 12) },
    );
    const face = vec(Math.SQRT1_2, 0, -Math.SQRT1_2);
    const probe = vec(100 + face.x * 1.1, 0.5, 200 + face.z * 1.1);
    const contact = createColliderContact();
    expect(world.contactSphere(quay, probe, 0.15, contact)).toBe(true);
    expectVec(contact.normal, face);
    expect(contact.penetration).toBeCloseTo(0.05, 9);
    expectVec(contact.point, vec(100 + face.x, 0.5, 200 + face.z));
    // The bound of the turned box covers its corners exactly.
    const bounds = world.bounds(quay, aabb(0, 0, 0, 0, 0, 0));
    const extentX = Math.SQRT1_2 * 1 + Math.SQRT1_2 * 20;
    expect(bounds.maxX - 100).toBeCloseTo(extentX, 9);
    expect(bounds.maxY).toBeCloseTo(3, 9);
  });

  it("follows a rolled box (a pontoon heeled by a wave)", () => {
    const world = new ColliderWorld();
    const pontoon = world.addStatic(
      { kind: "box", center: vec(0, 0, 0), halfExtents: vec(5, 0.5, 2) },
      { orientation: roll(0.2) },
    );
    // The deck normal is local +Y rolled about +X.
    const up = vec(0, Math.cos(0.2), Math.sin(0.2));
    const contact = createColliderContact();
    expect(world.contactSphere(pontoon, vec(up.x * 0.6, up.y * 0.6, up.z * 0.6), 0.15, contact)).toBe(true);
    expectVec(contact.normal, up);
    expect(contact.penetration).toBeCloseTo(0.05, 9);
  });

  it("rejects malformed shapes", () => {
    const world = new ColliderWorld();
    expect(() => world.addStatic({ kind: "sphere", center: vec(0, 0, 0), radius: 0 })).toThrow(RangeError);
    expect(() => world.addStatic({ kind: "capsule", a: vec(Number.NaN, 0, 0), b: vec(0, 0, 0), radius: 1 })).toThrow(RangeError);
    expect(() => world.addStatic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(1, 0, 1) })).toThrow(RangeError);
    expect(() => world.addStatic({ kind: "polyline", points: [vec(0, 0, 0)], radius: 1 })).toThrow(RangeError);
    expect(world.size).toBe(0);
  });
});

describe("kinematic colliders", () => {
  it("moves with its pose and reports the surface velocity at the contact", () => {
    const world = new ColliderWorld();
    const pontoon = world.addKinematic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(6, 0.4, 2) }, { material: 3 });
    const omega = vec(0, 0.5, 0);
    world.setKinematicPose(pontoon, vec(20, 0.1, -30), yaw(Math.PI / 2), vec(1, 0.2, 0), omega);
    const contact = createColliderContact();
    // The old place is empty now.
    expect(world.deepestSphereContact(vec(0, 0.5, 0), 0.15, contact)).toBe(false);
    // On the deck, 4 m along the pontoon's local +X, which the yaw turns to -Z.
    const probe = vec(20, 0.1 + 0.4 + 0.1, -34);
    expect(world.deepestSphereContact(probe, 0.15, contact)).toBe(true);
    expect(contact.handle).toBe(pontoon);
    expect(contact.material).toBe(3);
    expectVec(contact.normal, vec(0, 1, 0));
    expect(contact.penetration).toBeCloseTo(0.05, 9);
    // v + w x r with r = (0, 0.4, -4): w x r = (0.5 * -4, 0, 0) = (-2, 0, 0).
    expectVec(contact.pointVelocity, vec(-1, 0.2, 0));
    const velocity = world.pointVelocity(pontoon, vec(20, 0.1, -34), vec(0, 0, 0));
    expectVec(velocity, vec(-1, 0.2, 0));
  });

  it("maps local points through the current pose", () => {
    const world = new ColliderWorld();
    const pontoon = world.addKinematic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 });
    const cleat = vec(3, 0.5, 1);
    world.setKinematicPose(pontoon, vec(10, 0, 10), yaw(Math.PI));
    expectVec(world.localToWorld(pontoon, cleat, vec(0, 0, 0)), vec(7, 0.5, 9));
    // A non-unit quaternion is normalised rather than scaling the frame.
    world.setKinematicPose(pontoon, vec(0, 0, 0), { x: 0, y: 0, z: 0, w: 2 });
    expectVec(world.localToWorld(pontoon, cleat, vec(0, 0, 0)), cleat);
  });

  it("refuses to move a static collider", () => {
    const world = new ColliderWorld();
    const pile = world.addStatic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 });
    expect(() => world.setKinematicPose(pile, vec(1, 0, 0), IDENTITY)).toThrow(TypeError);
  });
});

describe("collider queries", () => {
  it("returns each overlapping collider once, across bins, with kinematic ones", () => {
    const world = new ColliderWorld();
    // Spans four bins around the origin.
    const big = world.addStatic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(40, 1, 40) });
    const near = world.addStatic({ kind: "sphere", center: vec(5, 0, 5), radius: 1 });
    const far = world.addStatic({ kind: "sphere", center: vec(500, 0, 500), radius: 1 });
    const high = world.addStatic({ kind: "sphere", center: vec(5, 50, 5), radius: 1 });
    const floating = world.addKinematic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 });
    world.setKinematicPose(floating, vec(-10, 0, 3), IDENTITY);
    const out: number[] = [];
    const count = world.query(aabb(-35, -2, -35, 35, 2, 35), out);
    expect(count).toBe(3);
    expect(out.slice().sort((a, b) => a - b)).toEqual([big, near, floating].sort((a, b) => a - b));
    expect(out).not.toContain(far);
    expect(out).not.toContain(high);
    // A reused array is truncated to the new count.
    expect(world.query(aabb(499, -2, 499, 501, 2, 501), out)).toBe(1);
    expect(out).toEqual([far]);
    expect(world.query(aabb(1000, 0, 1000, 1001, 1, 1001), out)).toBe(0);
    expect(out).toEqual([]);
  });

  it("finds colliders on bin edges and at negative coordinates", () => {
    const world = new ColliderWorld();
    const edge = COLLIDER_BIN_SIZE_METERS;
    const onEdge = world.addStatic({ kind: "capsule", a: vec(edge, 0, -edge), b: vec(edge, 3, -edge), radius: 0.2 });
    const out: number[] = [];
    expect(world.query(aabb(edge + 0.1, 0, -edge - 0.1, edge + 0.15, 1, -edge), out)).toBe(1);
    expect(out[0]).toBe(onEdge);
    expect(world.query(aabb(edge - 0.15, 0, -edge + 0.1, edge - 0.1, 1, -edge + 0.15), out)).toBe(1);
  });

  it("keeps the deepest of several touching colliders", () => {
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(5, 1, 5) }, { material: 1 });
    const pile = world.addStatic({ kind: "capsule", a: vec(1, -2, 0), b: vec(1, 3, 0), radius: 0.3 }, { material: 2 });
    const contact = createColliderContact();
    // 0.05 into the deck top, 0.25 into the pile.
    expect(world.deepestSphereContact(vec(1.2, 1.1, 0), 0.15, contact)).toBe(true);
    expect(contact.handle).toBe(pile);
    expect(contact.material).toBe(2);
    expect(contact.penetration).toBeCloseTo(0.25, 9);
    expect(world.deepestSphereContact(vec(100, 0, 0), 0.15, contact)).toBe(false);
  });
});

describe("collider handles", () => {
  it("removes single colliders and whole groups, and stale handles stay dead", () => {
    const world = new ColliderWorld();
    const dockA = world.addStatic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 }, { group: 4 });
    const dockB = world.addKinematic({ kind: "sphere", center: vec(3, 0, 0), radius: 1 }, { group: 4 });
    const other = world.addStatic({ kind: "sphere", center: vec(6, 0, 0), radius: 1 }, { group: 5 });
    expect(world.size).toBe(3);
    expect(world.removeGroup(4)).toBe(2);
    expect(world.size).toBe(1);
    expect(world.has(dockA)).toBe(false);
    expect(world.has(dockB)).toBe(false);
    expect(world.has(other)).toBe(true);
    const out: number[] = [];
    expect(world.query(aabb(-10, -10, -10, 10, 10, 10), out)).toBe(1);
    expect(out).toEqual([other]);
    // A new collider reuses the slot under a new generation.
    const reused = world.addStatic({ kind: "sphere", center: vec(0, 0, 0), radius: 1 });
    expect(reused).not.toBe(dockA);
    expect(reused).not.toBe(dockB);
    expect(world.has(dockA)).toBe(false);
    expect(world.contactSphere(dockA, vec(0, 0, 0), 1, createColliderContact())).toBe(false);
    expect(() => world.material(dockA)).toThrow(RangeError);
    expect(world.remove(dockA)).toBe(false);
    expect(world.remove(reused)).toBe(true);
    expect(world.remove(reused)).toBe(false);
    expect(world.size).toBe(1);
  });

  it("does not grow anything on the per-step path", () => {
    const world = new ColliderWorld();
    for (let i = 0; i < 64; i += 1) {
      world.addStatic({ kind: "capsule", a: vec(i * 3, -2, 0), b: vec(i * 3, 2, 0), radius: 0.2 });
    }
    const pontoon = world.addKinematic({ kind: "box", center: vec(0, 0, 0), halfExtents: vec(6, 0.4, 2) });
    const out: number[] = [];
    const contact = createColliderContact();
    const probe = vec(0, 0, 0);
    const position = vec(0, 0, 0);
    const orientation = { x: 0, y: 0, z: 0, w: 1 };
    const linear = vec(0, 0, 0);
    const angular = vec(0, 0.1, 0);
    let touches = 0;
    for (let step = 0; step < 2000; step += 1) {
      position.x = (step % 200) * 1;
      orientation.y = Math.sin(step * 0.001);
      orientation.w = Math.cos(step * 0.001);
      world.setKinematicPose(pontoon, position, orientation, linear, angular);
      world.query(aabb(position.x - 8, -3, -3, position.x + 8, 3, 3), out);
      probe.x = position.x + 0.1;
      probe.y = 0.5;
      if (world.deepestSphereContact(probe, 0.15, contact)) touches += 1;
    }
    expect(touches).toBe(2000);
    expect(out.length).toBeGreaterThan(0);
    expect(world.size).toBe(65);
  });
});
