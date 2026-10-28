import { describe, expect, it } from "vitest";
import {
  ColliderWorld,
  createColliderContact,
  createColliderSweepHit,
  type ColliderAabb,
  type ColliderShape,
} from "../src/sim/colliders";
import { quaternionFromAxisAngle } from "../src/sim/math";
import type { Quaternion, Vec3 } from "../src/sim/types";
import {
  ColliderWorld as ReferenceColliderWorld,
  createColliderContact as createReferenceContact,
} from "./support/collidersReference";

/**
 * The walker's additions to the shared collider world (the walking plan,
 * "Obstacles"): `sweepSphere`, the first touch of a sphere moved along a
 * segment, and `raycast`, its radius-free case. Every existing query stays
 * bit-identical to the file before them, held against a frozen copy.
 */

/** Deterministic numbers in 0..1 (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Placed {
  shape: ColliderShape;
  material: number;
  group: number;
  position?: Vec3;
  orientation?: Quaternion;
  kinematic?: { position: Vec3; orientation: Quaternion; velocity: Vec3; angular: Vec3 };
}

function randomQuaternion(random: () => number): Quaternion {
  const axis = { x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 };
  const length = Math.hypot(axis.x, axis.y, axis.z) || 1;
  return quaternionFromAxisAngle({ x: axis.x / length, y: axis.y / length, z: axis.z / length }, random() * Math.PI * 2);
}

/** A scatter of every shape kind over a 60 m square: tilted boxes, chains, a few kinematic ones. */
function randomScene(seed: number, count = 40): Placed[] {
  const random = rng(seed);
  const point = (spread: number): Vec3 => ({ x: (random() - 0.5) * spread, y: (random() - 0.5) * 4, z: (random() - 0.5) * spread });
  const placed: Placed[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = Math.floor(random() * 4);
    let shape: ColliderShape;
    if (kind === 0) shape = { kind: "sphere", center: point(1), radius: 0.2 + random() * 1.5 };
    else if (kind === 1) {
      const a = point(1);
      shape = { kind: "capsule", a, b: { x: a.x + (random() - 0.5) * 6, y: a.y + (random() - 0.5) * 6, z: a.z + (random() - 0.5) * 6 }, radius: 0.1 + random() };
    } else if (kind === 2) {
      shape = {
        kind: "box",
        center: point(1),
        halfExtents: { x: 0.1 + random() * 3, y: 0.1 + random() * 2, z: 0.1 + random() * 3 },
        ...(random() < 0.7 ? { orientation: randomQuaternion(random) } : {}),
      };
    } else {
      const points: Vec3[] = [point(1)];
      for (let k = 0; k < 3; k += 1) {
        const last = points[points.length - 1]!;
        points.push({ x: last.x + (random() - 0.5) * 5, y: last.y + (random() - 0.5) * 2, z: last.z + (random() - 0.5) * 5 });
      }
      shape = { kind: "polyline", points, radius: 0.1 + random() * 0.6 };
    }
    const where = { x: (random() - 0.5) * 60, y: (random() - 0.5) * 6, z: (random() - 0.5) * 60 };
    const entry: Placed = { shape, material: i % 7, group: i % 3, position: where, orientation: randomQuaternion(random) };
    if (random() < 0.2) {
      entry.kinematic = {
        position: where,
        orientation: randomQuaternion(random),
        velocity: { x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 },
        angular: { x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 },
      };
    }
    placed.push(entry);
  }
  return placed;
}

function build<W extends ColliderWorld | ReferenceColliderWorld>(world: W, scene: readonly Placed[]): number[] {
  return scene.map((entry) => {
    if (entry.kinematic) {
      const handle = world.addKinematic(entry.shape, { material: entry.material, group: entry.group });
      const k = entry.kinematic;
      world.setKinematicPose(handle, k.position, k.orientation, k.velocity, k.angular);
      return handle;
    }
    return world.addStatic(entry.shape, {
      material: entry.material,
      group: entry.group,
      ...(entry.position ? { position: entry.position } : {}),
      ...(entry.orientation ? { orientation: entry.orientation } : {}),
    });
  });
}

describe("existing collider queries", () => {
  it("answer bit for bit as before the sweeps, with sweeps run between them", () => {
    for (const seed of [1, 2, 3]) {
      const scene = randomScene(seed);
      const live = new ColliderWorld();
      const reference = new ReferenceColliderWorld();
      const handles = build(live, scene);
      const referenceHandles = build(reference, scene);
      expect(handles).toEqual(referenceHandles);
      const random = rng(seed * 101);
      const contact = createColliderContact();
      const referenceContact = createReferenceContact();
      const hit = createColliderSweepHit();
      const out: number[] = [];
      const referenceOut: number[] = [];
      const box: ColliderAabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
      const values: number[] = [];
      const referenceValues: number[] = [];
      const record = (into: number[], c: typeof contact, found: boolean) => {
        into.push(found ? 1 : 0, c.handle, c.normal.x, c.normal.y, c.normal.z, c.penetration, c.point.x, c.point.y, c.point.z,
          c.pointVelocity.x, c.pointVelocity.y, c.pointVelocity.z, c.material);
      };
      for (let i = 0; i < 4_000; i += 1) {
        const center = { x: (random() - 0.5) * 70, y: (random() - 0.5) * 8, z: (random() - 0.5) * 70 };
        const radius = random() * 2;
        // A sweep on the live world only, between the queries both worlds answer.
        live.sweepSphere(center, { x: center.x + random() - 0.5, y: center.y - random(), z: center.z }, radius, hit);
        live.raycast(center, { x: center.x, y: center.y - 3, z: center.z }, hit);
        record(values, contact, live.deepestSphereContact(center, radius, contact));
        record(referenceValues, referenceContact, reference.deepestSphereContact(center, radius, referenceContact));
        const handle = handles[i % handles.length]!;
        record(values, contact, live.contactSphere(handle, center, radius, contact));
        record(referenceValues, referenceContact, reference.contactSphere(handle, center, radius, referenceContact));
        box.minX = center.x - radius * 4;
        box.maxX = center.x + radius * 4;
        box.minY = center.y - radius;
        box.maxY = center.y + radius;
        box.minZ = center.z - radius * 3;
        box.maxZ = center.z + radius * 3;
        values.push(live.query(box, out), ...out);
        referenceValues.push(reference.query(box, referenceOut), ...referenceOut);
        const velocity = live.pointVelocity(handle, center, { x: 0, y: 0, z: 0 });
        const referenceVelocity = reference.pointVelocity(handle, center, { x: 0, y: 0, z: 0 });
        values.push(velocity.x, velocity.y, velocity.z);
        referenceValues.push(referenceVelocity.x, referenceVelocity.y, referenceVelocity.z);
        const world = live.localToWorld(handle, center, { x: 0, y: 0, z: 0 });
        const referenceWorld = reference.localToWorld(handle, center, { x: 0, y: 0, z: 0 });
        values.push(world.x, world.y, world.z);
        referenceValues.push(referenceWorld.x, referenceWorld.y, referenceWorld.z);
      }
      for (const handle of handles) {
        const a = live.bounds(handle, { ...box });
        const b = reference.bounds(handle, { ...box });
        values.push(a.minX, a.minY, a.minZ, a.maxX, a.maxY, a.maxZ, live.material(handle));
        referenceValues.push(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, reference.material(handle));
      }
      expect(live.removeGroup(1)).toBe(reference.removeGroup(1));
      expect(live.size).toBe(reference.size);
      expect(values.length).toBe(referenceValues.length);
      let differing = 0;
      for (let k = 0; k < values.length; k += 1) if (!Object.is(values[k], referenceValues[k])) differing += 1;
      expect(differing, `seed ${seed}`).toBe(0);
    }
  });
});

/** The first fraction at which a sphere marched along the segment overlaps anything, to 1 / steps. */
function marchedEntry(world: ColliderWorld, from: Vec3, to: Vec3, radius: number, steps: number): number {
  const contact = createColliderContact();
  const p = { x: 0, y: 0, z: 0 };
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    p.x = from.x + (to.x - from.x) * t;
    p.y = from.y + (to.y - from.y) * t;
    p.z = from.z + (to.z - from.z) * t;
    if (world.deepestSphereContact(p, radius, contact) && contact.penetration > 1e-12) return t;
  }
  return Infinity;
}

describe("sweepSphere and raycast", () => {
  it("find the first touch of every shape kind, as a fine march does", () => {
    const steps = 4_000;
    let hits = 0;
    let misses = 0;
    for (const seed of [11, 12, 13, 14]) {
      const world = new ColliderWorld();
      build(world, randomScene(seed, 80));
      const random = rng(seed * 7);
      const hit = createColliderSweepHit();
      const contact = createColliderContact();
      for (let i = 0; i < 400; i += 1) {
        const from = { x: (random() - 0.5) * 50, y: (random() - 0.5) * 8, z: (random() - 0.5) * 50 };
        const to = { x: from.x + (random() - 0.5) * 30, y: from.y + (random() - 0.5) * 8, z: from.z + (random() - 0.5) * 30 };
        const radius = i % 4 === 0 ? 0 : random() * 1.2;
        // Only starts clear of everything: an overlapping start has its own rule.
        if (world.deepestSphereContact(from, Math.max(radius, 1e-9), contact) && contact.penetration > 0) continue;
        const found = radius === 0 ? world.raycast(from, to, hit) : world.sweepSphere(from, to, radius, hit);
        const marched = marchedEntry(world, from, to, radius, steps);
        if (!found) {
          // A grazing touch can overlap by less than the march resolves; a clear miss never overlaps.
          expect(marched, `seed ${seed} sweep ${i} missed`).toBe(Infinity);
          misses += 1;
          continue;
        }
        hits += 1;
        expect(hit.fraction).toBeGreaterThanOrEqual(0);
        expect(hit.fraction).toBeLessThanOrEqual(1);
        expect(marched, `seed ${seed} sweep ${i}`).toBeGreaterThanOrEqual(hit.fraction - 1e-9);
        expect(marched - hit.fraction, `seed ${seed} sweep ${i}`).toBeLessThanOrEqual(2 / steps + 1e-9);
        // The touch: the centre is one radius from the surface point, along the normal.
        const centre = {
          x: from.x + (to.x - from.x) * hit.fraction,
          y: from.y + (to.y - from.y) * hit.fraction,
          z: from.z + (to.z - from.z) * hit.fraction,
        };
        expect(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z)).toBeCloseTo(1, 9);
        expect(centre.x - hit.point.x).toBeCloseTo(hit.normal.x * radius, 6);
        expect(centre.y - hit.point.y).toBeCloseTo(hit.normal.y * radius, 6);
        expect(centre.z - hit.point.z).toBeCloseTo(hit.normal.z * radius, 6);
        // The surface point is on the hit collider: a probe there just touches it.
        expect(world.contactSphere(hit.handle, hit.point, 1e-4, contact)).toBe(true);
        expect(contact.penetration).toBeLessThan(2e-4);
        // Its material and surface velocity are the collider's.
        expect(hit.material).toBe(world.material(hit.handle));
        const velocity = world.pointVelocity(hit.handle, hit.point, { x: 0, y: 0, z: 0 });
        expect(hit.pointVelocity.x).toBeCloseTo(velocity.x, 12);
        expect(hit.pointVelocity.y).toBeCloseTo(velocity.y, 12);
        expect(hit.pointVelocity.z).toBeCloseTo(velocity.z, 12);
      }
    }
    expect(hits).toBeGreaterThan(300);
    expect(misses).toBeGreaterThan(100);
  });

  it("meets a box's face, its rounded edges and its corners where they are", () => {
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 0.5, z: 2 } }, { material: 9 });
    const hit = createColliderSweepHit();
    // Face: straight down onto the top.
    expect(world.sweepSphere({ x: 0.3, y: 3, z: 0.4 }, { x: 0.3, y: -3, z: 0.4 }, 0.25, hit)).toBe(true);
    expect(hit.fraction * 6).toBeCloseTo(3 - 0.75, 12);
    expect(hit.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit.point.y).toBeCloseTo(0.5, 12);
    expect(hit.material).toBe(9);
    // Edge: along x past the top edge at z = 2, 0.25 m over and 0.25 m out, inside the grown box
    // but 0.354 m from the edge, then 0.1 m over and out, 0.141 m from it.
    expect(world.sweepSphere({ x: -5, y: 0.75, z: 2.25 }, { x: 5, y: 0.75, z: 2.25 }, 0.3, hit)).toBe(false);
    expect(world.sweepSphere({ x: -5, y: 0.6, z: 2.1 }, { x: 5, y: 0.6, z: 2.1 }, 0.3, hit)).toBe(true);
    expect(10 * hit.fraction - 5).toBeCloseTo(-1 - Math.sqrt(0.09 - 0.02), 9);
    expect(world.sweepSphere({ x: 0, y: 0.6, z: 5 }, { x: 0, y: 0.6, z: 1 }, 0.3, hit)).toBe(true);
    // The touch where (z - 2)^2 + 0.1^2 = 0.09.
    expect(5 - 4 * hit.fraction).toBeCloseTo(2 + Math.sqrt(0.08), 9);
    expect(hit.point.y).toBeCloseTo(0.5, 9);
    expect(hit.point.z).toBeCloseTo(2, 9);
    // Corner: diagonally at the (1, 0.5, 2) corner.
    const d = 1 / Math.sqrt(3);
    expect(world.sweepSphere({ x: 1 + 3 * d, y: 0.5 + 3 * d, z: 2 + 3 * d }, { x: 1 - d, y: 0.5 - d, z: 2 - d }, 0.5, hit)).toBe(true);
    expect(hit.fraction * 4).toBeCloseTo(2.5, 9);
    expect(hit.point.x).toBeCloseTo(1, 9);
    expect(hit.point.y).toBeCloseTo(0.5, 9);
    expect(hit.point.z).toBeCloseTo(2, 9);
    // A ray onto the face reports the face's normal.
    expect(world.raycast({ x: 3, y: 0, z: 0 }, { x: -3, y: 0, z: 0 }, hit)).toBe(true);
    expect(hit.fraction).toBeCloseTo(2 / 6, 12);
    expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("ignores an overlap it moves along or out of, and stops at once moving deeper in", () => {
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: { x: 0, y: -0.5, z: 0 }, halfExtents: { x: 5, y: 0.5, z: 5 } });
    const hit = createColliderSweepHit();
    // A sphere sunk 1 cm into the deck: sliding across it, or lifting off it, is free.
    const resting = { x: 0, y: 0.29, z: 0 };
    expect(world.sweepSphere(resting, { x: 2, y: 0.29, z: 0 }, 0.3, hit)).toBe(false);
    expect(world.sweepSphere(resting, { x: 0, y: 2, z: 0 }, 0.3, hit)).toBe(false);
    expect(world.sweepSphere(resting, { x: 0, y: -1, z: 0 }, 0.3, hit)).toBe(true);
    expect(hit.fraction).toBe(0);
    expect(hit.normal.y).toBeCloseTo(1, 12);
    // A wall beside a falling probe that touches its face: the fall passes it.
    const walls = new ColliderWorld();
    walls.addStatic({ kind: "box", center: { x: 1, y: 0, z: 0 }, halfExtents: { x: 0.5, y: 5, z: 5 } });
    expect(walls.sweepSphere({ x: 0.2, y: 3, z: 0 }, { x: 0.2, y: -3, z: 0 }, 0.3, hit)).toBe(false);
    expect(walls.sweepSphere({ x: 0.2, y: 3, z: 0 }, { x: 0.3, y: -3, z: 0 }, 0.3, hit)).toBe(true);
    expect(hit.fraction).toBe(0);
    // A ray from inside a solid out of it is free; one heading in stops at once.
    expect(walls.raycast({ x: 1.2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, hit)).toBe(false);
    expect(walls.raycast({ x: 1.2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, hit)).toBe(true);
    expect(hit.fraction).toBe(0);
  });

  it("reports a kinematic collider's surface velocity where it is touched", () => {
    const world = new ColliderWorld();
    const handle = world.addKinematic({ kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 3, y: 0.3, z: 1 } }, { material: 103 });
    world.setKinematicPose(handle, { x: 10, y: 0.2, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0.4, z: 0 }, { x: 0.1, y: 0, z: 0 });
    const hit = createColliderSweepHit();
    expect(world.sweepSphere({ x: 11, y: 2, z: 0.5 }, { x: 11, y: -1, z: 0.5 }, 0.3, hit)).toBe(true);
    expect(hit.handle).toBe(handle);
    expect(hit.point.y).toBeCloseTo(0.5, 12);
    // v + w x r at (11, 0.5, 0.5) from (10, 0.2, 0): (0, 0.4, 0) + (0.1, 0, 0) x (1, 0.3, 0.5).
    expect(hit.pointVelocity.x).toBeCloseTo(0, 12);
    expect(hit.pointVelocity.y).toBeCloseTo(0.4 - 0.1 * 0.5, 12);
    expect(hit.pointVelocity.z).toBeCloseTo(0.1 * 0.3, 12);
  });

  it("does nothing for a segment of no length", () => {
    const world = new ColliderWorld();
    world.addStatic({ kind: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1 });
    const hit = createColliderSweepHit();
    expect(world.sweepSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0.5, hit)).toBe(false);
    expect(hit.handle).toBe(-1);
  });
});
