import {
  EPSILON,
  inverseRotateVectorInto,
  multiplyQuaternionInto,
  normalizeQuaternionInto,
  rotateVectorInto,
} from "./math";
import type { Quaternion, Vec3 } from "./types";

/**
 * World colliders for surface vehicles: the things a hull or a tyre can hit
 * that are not terrain (dock piles, pier decks, quay walls, pontoons, airport
 * buildings, later road barriers).
 *
 * Every shape is written in its collider's LOCAL frame and placed by the
 * collider's pose. A static collider's pose is fixed when it is added, and it
 * is binned once into 32 m world cells; a kinematic collider (a pontoon riding
 * the waves) gets a new pose, linear velocity and angular velocity every sim
 * step and is kept in a short list scanned by bounding box instead.
 *
 * Queries and contacts never allocate: candidates are written into a caller's
 * array, results into a caller's `ColliderContact`. Adding and removing
 * colliders may allocate, and is not meant for the per-step path.
 *
 * Contacts are geometric only. A contact reports where and how deep a probe
 * sphere overlaps a collider, how fast the collider's surface is moving there,
 * and the collider's material id; the force law (stiffness, damping, friction,
 * a W-beam rail's give) belongs to the vehicle that reads the material id.
 */

/** Edge length of a static-collider bin, in metres. */
export const COLLIDER_BIN_SIZE_METERS = 32;

export interface ColliderSphere {
  readonly kind: "sphere";
  readonly center: Vec3;
  readonly radius: number;
}

/** A segment swept by a radius: piles, posts, rails. */
export interface ColliderCapsule {
  readonly kind: "capsule";
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
}

/** An oriented box: decks, quay walls, pontoons, buildings. */
export interface ColliderBox {
  readonly kind: "box";
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  /** Rotates box-local vectors into the collider's frame. Identity when omitted. */
  readonly orientation?: Quaternion;
}

/** A chain of capsules through the points, e.g. a guardrail. */
export interface ColliderPolyline {
  readonly kind: "polyline";
  readonly points: readonly Vec3[];
  readonly radius: number;
}

export type ColliderShape = ColliderSphere | ColliderCapsule | ColliderBox | ColliderPolyline;

export interface ColliderOptions {
  /** Material id handed back with every contact. Defaults to 0. */
  material?: number;
  /** Group id, so a set of colliders can be removed together. Defaults to 0. */
  group?: number;
  /** Pose of a static collider's local frame. Identity when omitted. */
  position?: Vec3;
  orientation?: Quaternion;
}

export interface ColliderAabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface ColliderContact {
  handle: number;
  /** World unit normal pointing from the collider towards the probe centre. */
  normal: Vec3;
  /**
   * Overlap depth in metres: the probe radius minus the signed distance from
   * the collider surface to the probe centre. Positive means touching; a probe
   * centre inside a box gives a depth larger than the radius.
   */
  penetration: number;
  /** World point on the collider surface nearest the probe centre. */
  point: Vec3;
  /** World velocity of the collider surface at `point`; zero when static. */
  pointVelocity: Vec3;
  material: number;
}

export function createColliderContact(): ColliderContact {
  return {
    handle: -1,
    normal: { x: 0, y: 1, z: 0 },
    penetration: 0,
    point: { x: 0, y: 0, z: 0 },
    pointVelocity: { x: 0, y: 0, z: 0 },
    material: 0,
  };
}

/** The first touch along a swept segment (`sweepSphere`, `raycast`). */
export interface ColliderSweepHit {
  handle: number;
  /**
   * Share of the segment travelled before the first touch: the swept
   * sphere's centre (the ray's point) touches at `from + fraction (to -
   * from)`. 0 when it already overlapped a collider and moved deeper in.
   */
  fraction: number;
  /** World unit normal of the surface at the touch, from the collider towards the swept centre. */
  normal: Vec3;
  /** World point on the collider surface where it is touched. */
  point: Vec3;
  /** World velocity of the collider surface at `point`; zero when static. */
  pointVelocity: Vec3;
  material: number;
}

export function createColliderSweepHit(): ColliderSweepHit {
  return {
    handle: -1,
    fraction: 1,
    normal: { x: 0, y: 1, z: 0 },
    point: { x: 0, y: 0, z: 0 },
    pointVelocity: { x: 0, y: 0, z: 0 },
    material: 0,
  };
}

const SLOT_BITS = 20;
const SLOT_COUNT = 1 << SLOT_BITS;
const SLOT_MASK = SLOT_COUNT - 1;
const MAX_GENERATION = 2047;
// Packs a signed bin coordinate pair into one small integer, 15 bits each:
// a Smi in every V8 build (31-bit with pointer compression), so a bin lookup
// passes no heap number to the map. Bins 2^15 apart (1,049 km) share a key,
// which only adds far candidates that every query's bounds test drops.
const BIN_KEY_BITS = 15;
const BIN_KEY_MASK = (1 << BIN_KEY_BITS) - 1;

const IDENTITY: Quaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

interface ColliderRecord {
  handle: number;
  kinematic: boolean;
  material: number;
  group: number;
  shape: ColliderShape;
  // Pose of the local frame in the world.
  position: Vec3;
  orientation: Quaternion;
  linearVelocity: Vec3;
  /** World-frame angular velocity of the local frame. */
  angularVelocity: Vec3;
  // World-space geometry, recomputed whenever the pose changes. Spheres use
  // the first point, capsules the first two, polylines all of them, boxes the
  // first as the centre with `boxOrientation`.
  worldPoints: Float64Array;
  boxOrientation: Quaternion;
  aabb: ColliderAabb;
  bins: number[];
  queryStamp: number;
  // The shape's numbers again, for the sweeps. Read through `shape`, whose
  // hidden class differs by kind, V8 merges another kind's missing field
  // (undefined) into the load and boxes the number on every read.
  /** A sphere's, capsule's or polyline's radius; 0 for a box. */
  radius: number;
  pointCount: number;
  /** A box's half extents (a copy); zero for the other kinds. */
  halfExtents: Vec3;
}

function binIndex(coordinate: number): number {
  return Math.floor(coordinate / COLLIDER_BIN_SIZE_METERS);
}

function binKey(ix: number, iz: number): number {
  return ((ix & BIN_KEY_MASK) << BIN_KEY_BITS) | (iz & BIN_KEY_MASK);
}

function shapePointCount(shape: ColliderShape): number {
  switch (shape.kind) {
    case "sphere":
    case "box":
      return 1;
    case "capsule":
      return 2;
    case "polyline":
      return shape.points.length;
  }
}

function validateShape(shape: ColliderShape): void {
  const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  switch (shape.kind) {
    case "sphere":
      if (!finite(shape.center) || !(shape.radius > 0)) throw new RangeError("Collider sphere needs a finite centre and a positive radius");
      return;
    case "capsule":
      if (!finite(shape.a) || !finite(shape.b) || !(shape.radius > 0)) throw new RangeError("Collider capsule needs finite ends and a positive radius");
      return;
    case "box":
      if (
        !finite(shape.center) ||
        !(shape.halfExtents.x > 0 && shape.halfExtents.y > 0 && shape.halfExtents.z > 0)
      ) {
        throw new RangeError("Collider box needs a finite centre and positive half extents");
      }
      return;
    case "polyline":
      if (shape.points.length < 2 || !shape.points.every(finite) || !(shape.radius > 0)) {
        throw new RangeError("Collider polyline needs two or more finite points and a positive radius");
      }
      return;
  }
}

const scratchLocal: Vec3 = { x: 0, y: 0, z: 0 };
const scratchWorld: Vec3 = { x: 0, y: 0, z: 0 };
const scratchOffset: Vec3 = { x: 0, y: 0, z: 0 };
const scratchContact: ColliderContact = createColliderContact();

export class ColliderWorld {
  private readonly slots: (ColliderRecord | null)[] = [];
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private readonly bins = new Map<number, ColliderRecord[]>();
  private readonly kinematic: ColliderRecord[] = [];
  private stamp = 0;
  private liveCount = 0;

  /** Number of colliders currently held, static and kinematic. */
  get size(): number {
    return this.liveCount;
  }

  /** Add a static collider. Its pose cannot change; remove and re-add to move it. */
  addStatic(shape: ColliderShape, options: ColliderOptions = {}): number {
    const record = this.createRecord(shape, options, false);
    this.refreshWorldGeometry(record);
    this.insertIntoBins(record);
    return record.handle;
  }

  /**
   * Add a kinematic collider. It starts at the identity pose (or `options`'
   * pose) at rest; call `setKinematicPose` once per sim step.
   */
  addKinematic(shape: ColliderShape, options: ColliderOptions = {}): number {
    const record = this.createRecord(shape, options, true);
    this.refreshWorldGeometry(record);
    this.kinematic.push(record);
    return record.handle;
  }

  /**
   * Move a kinematic collider. `angularVelocity` is in the WORLD frame, so the
   * surface velocity at a world point p is `linearVelocity + angularVelocity ×
   * (p − position)`.
   */
  setKinematicPose(
    handle: number,
    position: Vec3,
    orientation: Quaternion,
    linearVelocity: Vec3 = ZERO,
    angularVelocity: Vec3 = ZERO,
  ): void {
    const record = this.requireRecord(handle);
    if (!record.kinematic) throw new TypeError("Only a kinematic collider can be moved");
    copyVec(record.position, position);
    normalizeQuaternionInto(record.orientation, orientation);
    copyVec(record.linearVelocity, linearVelocity);
    copyVec(record.angularVelocity, angularVelocity);
    this.refreshWorldGeometry(record);
  }

  remove(handle: number): boolean {
    const record = this.lookup(handle);
    if (!record) return false;
    this.detach(record);
    return true;
  }

  /** Remove every collider in a group; returns how many went. */
  removeGroup(group: number): number {
    let removed = 0;
    for (const record of this.slots) {
      if (record && record.group === group) {
        this.detach(record);
        removed += 1;
      }
    }
    return removed;
  }

  has(handle: number): boolean {
    return this.lookup(handle) !== null;
  }

  material(handle: number): number {
    return this.requireRecord(handle).material;
  }

  /** World bounding box of a collider, copied into `out`. */
  bounds(handle: number, out: ColliderAabb): ColliderAabb {
    const aabb = this.requireRecord(handle).aabb;
    out.minX = aabb.minX;
    out.minY = aabb.minY;
    out.minZ = aabb.minZ;
    out.maxX = aabb.maxX;
    out.maxY = aabb.maxY;
    out.maxZ = aabb.maxZ;
    return out;
  }

  /** A point in the collider's local frame, in world space (mooring cleats). */
  localToWorld(handle: number, localPoint: Vec3, out: Vec3): Vec3 {
    const record = this.requireRecord(handle);
    rotateVectorInto(out, record.orientation, localPoint);
    out.x += record.position.x;
    out.y += record.position.y;
    out.z += record.position.z;
    return out;
  }

  /** World velocity of the collider's frame at a world point. */
  pointVelocity(handle: number, worldPoint: Vec3, out: Vec3): Vec3 {
    return recordPointVelocity(this.requireRecord(handle), worldPoint, out);
  }

  /**
   * Handles of every collider whose bounds overlap `aabb`, written into `out`
   * from index 0; returns the count. `out` is truncated to the count, so a
   * reused array stops allocating once it has grown to the largest result.
   */
  query(aabb: ColliderAabb, out: number[]): number {
    const stamp = this.nextStamp();
    let count = 0;
    const ix0 = binIndex(aabb.minX);
    const ix1 = binIndex(aabb.maxX);
    const iz0 = binIndex(aabb.minZ);
    const iz1 = binIndex(aabb.maxZ);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bin = this.bins.get(binKey(ix, iz));
        if (!bin) continue;
        for (let i = 0; i < bin.length; i += 1) {
          const record = bin[i]!;
          if (record.queryStamp === stamp || !aabbOverlap(record.aabb, aabb)) continue;
          record.queryStamp = stamp;
          out[count] = record.handle;
          count += 1;
        }
      }
    }
    for (let i = 0; i < this.kinematic.length; i += 1) {
      const record = this.kinematic[i]!;
      if (!aabbOverlap(record.aabb, aabb)) continue;
      out[count] = record.handle;
      count += 1;
    }
    out.length = count;
    return count;
  }

  /**
   * Contact between one collider and a probe sphere. Returns false, leaving
   * `out` untouched, when they do not overlap.
   */
  contactSphere(handle: number, center: Vec3, radius: number, out: ColliderContact): boolean {
    const record = this.lookup(handle);
    if (!record) return false;
    return sphereContact(record, center, radius, out);
  }

  /**
   * The deepest contact between a probe sphere (a hull point, a tyre sample)
   * and every collider near it. Returns false when nothing touches.
   */
  deepestSphereContact(center: Vec3, radius: number, out: ColliderContact): boolean {
    const stamp = this.nextStamp();
    let found = false;
    const ix0 = binIndex(center.x - radius);
    const ix1 = binIndex(center.x + radius);
    const iz0 = binIndex(center.z - radius);
    const iz1 = binIndex(center.z + radius);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bin = this.bins.get(binKey(ix, iz));
        if (!bin) continue;
        for (let i = 0; i < bin.length; i += 1) {
          const record = bin[i]!;
          if (record.queryStamp === stamp) continue;
          record.queryStamp = stamp;
          found = this.keepDeeper(record, center, radius, out, found);
        }
      }
    }
    for (let i = 0; i < this.kinematic.length; i += 1) {
      found = this.keepDeeper(this.kinematic[i]!, center, radius, out, found);
    }
    return found;
  }

  /**
   * The first collider a sphere of `radius` touches as its centre moves in a
   * straight line from `from` to `to`, exactly (each shape's swept volume is
   * solved in closed form: the Minkowski sum of the shape and the sphere
   * against the centre's segment). Returns false, leaving `out` untouched,
   * when nothing is touched on the way.
   *
   * A sphere that already overlaps a collider at `from` hits it at fraction
   * 0 only when the move goes deeper in (against that overlap's normal);
   * moving along or out of it, it is ignored, so a probe resting on a deck
   * or against a wall can slide off it. Kinematic colliders are swept at
   * their current pose. Allocates nothing: the walker's step and the
   * camera's frame call it.
   */
  sweepSphere(from: Vec3, to: Vec3, radius: number, out: ColliderSweepHit): boolean {
    sweepState.radius = radius > 0 ? radius : 0;
    return this.sweep(from, to, out);
  }

  /**
   * The first collider the segment from `from` to `to` meets: `sweepSphere`
   * with no radius. A segment starting inside a collider hits it at
   * fraction 0 only when it heads deeper in, as `sweepSphere`.
   */
  raycast(from: Vec3, to: Vec3, out: ColliderSweepHit): boolean {
    sweepState.radius = 0;
    return this.sweep(from, to, out);
  }

  /** The sweep with its radius already in `sweepState.radius`. */
  private sweep(from: Vec3, to: Vec3, out: ColliderSweepHit): boolean {
    const radius = sweepState.radius;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > EPSILON)) return false;
    sweepState.dx = dx;
    sweepState.dy = dy;
    sweepState.dz = dz;
    sweepState.length = length;
    sweepState.best = Infinity;
    sweepBox.minX = Math.min(from.x, to.x) - radius;
    sweepBox.minY = Math.min(from.y, to.y) - radius;
    sweepBox.minZ = Math.min(from.z, to.z) - radius;
    sweepBox.maxX = Math.max(from.x, to.x) + radius;
    sweepBox.maxY = Math.max(from.y, to.y) + radius;
    sweepBox.maxZ = Math.max(from.z, to.z) + radius;
    const stamp = this.nextStamp();
    let found = false;
    const ix0 = binIndex(sweepBox.minX);
    const ix1 = binIndex(sweepBox.maxX);
    const iz0 = binIndex(sweepBox.minZ);
    const iz1 = binIndex(sweepBox.maxZ);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bin = this.bins.get(binKey(ix, iz));
        if (!bin) continue;
        for (let i = 0; i < bin.length; i += 1) {
          const record = bin[i]!;
          if (record.queryStamp === stamp) continue;
          record.queryStamp = stamp;
          if (!aabbOverlap(record.aabb, sweepBox)) continue;
          if (sweepRecord(record, from, out)) found = true;
        }
      }
    }
    for (let i = 0; i < this.kinematic.length; i += 1) {
      const record = this.kinematic[i]!;
      if (!aabbOverlap(record.aabb, sweepBox)) continue;
      if (sweepRecord(record, from, out)) found = true;
    }
    return found;
  }

  private keepDeeper(
    record: ColliderRecord,
    center: Vec3,
    radius: number,
    out: ColliderContact,
    found: boolean,
  ): boolean {
    if (!sphereNearAabb(record.aabb, center, radius)) return found;
    if (!sphereContact(record, center, radius, scratchContact)) return found;
    if (found && scratchContact.penetration <= out.penetration) return found;
    copyContact(out, scratchContact);
    return true;
  }

  private nextStamp(): number {
    this.stamp = this.stamp >= 0x7fffffff ? 1 : this.stamp + 1;
    if (this.stamp === 1) {
      for (const record of this.slots) if (record) record.queryStamp = 0;
    }
    return this.stamp;
  }

  private createRecord(shape: ColliderShape, options: ColliderOptions, kinematic: boolean): ColliderRecord {
    validateShape(shape);
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      slot = this.slots.length;
      if (slot >= SLOT_COUNT) throw new RangeError("Too many colliders");
      this.slots.push(null);
      this.generations.push(0);
    }
    const handle = this.generations[slot]! * SLOT_COUNT + slot;
    const record: ColliderRecord = {
      handle,
      kinematic,
      material: options.material ?? 0,
      group: options.group ?? 0,
      shape,
      position: { ...(options.position ?? ZERO) },
      orientation: normalizeQuaternionInto({ x: 0, y: 0, z: 0, w: 1 }, options.orientation ?? IDENTITY),
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      worldPoints: new Float64Array(shapePointCount(shape) * 3),
      boxOrientation: { x: 0, y: 0, z: 0, w: 1 },
      aabb: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      bins: [],
      queryStamp: 0,
      radius: shape.kind === "box" ? 0 : shape.radius,
      pointCount: shapePointCount(shape),
      halfExtents:
        shape.kind === "box"
          ? { x: shape.halfExtents.x, y: shape.halfExtents.y, z: shape.halfExtents.z }
          : { x: 0, y: 0, z: 0 },
    };
    this.slots[slot] = record;
    this.liveCount += 1;
    return record;
  }

  private lookup(handle: number): ColliderRecord | null {
    if (!Number.isInteger(handle) || handle < 0) return null;
    const slot = handle & SLOT_MASK;
    const record = this.slots[slot];
    return record && record.handle === handle ? record : null;
  }

  private requireRecord(handle: number): ColliderRecord {
    const record = this.lookup(handle);
    if (!record) throw new RangeError(`Unknown collider handle ${handle}`);
    return record;
  }

  private detach(record: ColliderRecord): void {
    if (record.kinematic) {
      const index = this.kinematic.indexOf(record);
      if (index >= 0) this.kinematic.splice(index, 1);
    } else {
      for (const key of record.bins) {
        const bin = this.bins.get(key);
        if (!bin) continue;
        const index = bin.indexOf(record);
        if (index >= 0) bin.splice(index, 1);
        if (bin.length === 0) this.bins.delete(key);
      }
    }
    const slot = record.handle & SLOT_MASK;
    this.slots[slot] = null;
    const generation = this.generations[slot]!;
    this.generations[slot] = generation >= MAX_GENERATION ? 0 : generation + 1;
    this.freeSlots.push(slot);
    this.liveCount -= 1;
  }

  private insertIntoBins(record: ColliderRecord): void {
    const { aabb } = record;
    for (let ix = binIndex(aabb.minX); ix <= binIndex(aabb.maxX); ix += 1) {
      for (let iz = binIndex(aabb.minZ); iz <= binIndex(aabb.maxZ); iz += 1) {
        const key = binKey(ix, iz);
        let bin = this.bins.get(key);
        if (!bin) {
          bin = [];
          this.bins.set(key, bin);
        }
        bin.push(record);
        record.bins.push(key);
      }
    }
  }

  private refreshWorldGeometry(record: ColliderRecord): void {
    const { shape, worldPoints, aabb } = record;
    const placePoint = (index: number, local: Vec3) => {
      rotateVectorInto(scratchWorld, record.orientation, local);
      worldPoints[index * 3] = scratchWorld.x + record.position.x;
      worldPoints[index * 3 + 1] = scratchWorld.y + record.position.y;
      worldPoints[index * 3 + 2] = scratchWorld.z + record.position.z;
    };
    switch (shape.kind) {
      case "sphere":
        placePoint(0, shape.center);
        boundPoints(aabb, worldPoints, 1, shape.radius);
        return;
      case "capsule":
        placePoint(0, shape.a);
        placePoint(1, shape.b);
        boundPoints(aabb, worldPoints, 2, shape.radius);
        return;
      case "polyline":
        for (let i = 0; i < shape.points.length; i += 1) placePoint(i, shape.points[i]!);
        boundPoints(aabb, worldPoints, shape.points.length, shape.radius);
        return;
      case "box": {
        placePoint(0, shape.center);
        multiplyQuaternionInto(record.boxOrientation, record.orientation, shape.orientation ?? IDENTITY);
        normalizeQuaternionInto(record.boxOrientation, record.boxOrientation);
        boundBox(aabb, worldPoints, record.boxOrientation, shape.halfExtents);
        return;
      }
    }
  }
}

function copyVec(out: Vec3, value: Vec3): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

function copyContact(out: ColliderContact, value: ColliderContact): void {
  out.handle = value.handle;
  copyVec(out.normal, value.normal);
  out.penetration = value.penetration;
  copyVec(out.point, value.point);
  copyVec(out.pointVelocity, value.pointVelocity);
  out.material = value.material;
}

function boundPoints(aabb: ColliderAabb, points: Float64Array, count: number, radius: number): void {
  aabb.minX = aabb.minY = aabb.minZ = Infinity;
  aabb.maxX = aabb.maxY = aabb.maxZ = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = points[i * 3]!;
    const y = points[i * 3 + 1]!;
    const z = points[i * 3 + 2]!;
    if (x < aabb.minX) aabb.minX = x;
    if (y < aabb.minY) aabb.minY = y;
    if (z < aabb.minZ) aabb.minZ = z;
    if (x > aabb.maxX) aabb.maxX = x;
    if (y > aabb.maxY) aabb.maxY = y;
    if (z > aabb.maxZ) aabb.maxZ = z;
  }
  aabb.minX -= radius;
  aabb.minY -= radius;
  aabb.minZ -= radius;
  aabb.maxX += radius;
  aabb.maxY += radius;
  aabb.maxZ += radius;
}

function boundBox(aabb: ColliderAabb, points: Float64Array, orientation: Quaternion, half: Vec3): void {
  // Extent along each world axis = sum of |rotated axis component| × half extent.
  const { x: qx, y: qy, z: qz, w: qw } = orientation;
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  const ex = Math.abs(r00) * half.x + Math.abs(r01) * half.y + Math.abs(r02) * half.z;
  const ey = Math.abs(r10) * half.x + Math.abs(r11) * half.y + Math.abs(r12) * half.z;
  const ez = Math.abs(r20) * half.x + Math.abs(r21) * half.y + Math.abs(r22) * half.z;
  aabb.minX = points[0]! - ex;
  aabb.maxX = points[0]! + ex;
  aabb.minY = points[1]! - ey;
  aabb.maxY = points[1]! + ey;
  aabb.minZ = points[2]! - ez;
  aabb.maxZ = points[2]! + ez;
}

function aabbOverlap(a: ColliderAabb, b: ColliderAabb): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY &&
    a.minZ <= b.maxZ &&
    a.maxZ >= b.minZ
  );
}

function sphereNearAabb(aabb: ColliderAabb, center: Vec3, radius: number): boolean {
  return (
    center.x + radius >= aabb.minX &&
    center.x - radius <= aabb.maxX &&
    center.y + radius >= aabb.minY &&
    center.y - radius <= aabb.maxY &&
    center.z + radius >= aabb.minZ &&
    center.z - radius <= aabb.maxZ
  );
}

function recordPointVelocity(record: ColliderRecord, worldPoint: Vec3, out: Vec3): Vec3 {
  const rx = worldPoint.x - record.position.x;
  const ry = worldPoint.y - record.position.y;
  const rz = worldPoint.z - record.position.z;
  const w = record.angularVelocity;
  const v = record.linearVelocity;
  out.x = v.x + (w.y * rz - w.z * ry);
  out.y = v.y + (w.z * rx - w.x * rz);
  out.z = v.z + (w.x * ry - w.y * rx);
  return out;
}

/**
 * Nearest point on the segment from point index i to i + 1 of `points`;
 * writes it into scratchWorld and returns the squared distance to `p`.
 */
function closestOnSegment(points: Float64Array, i: number, p: Vec3): number {
  const ax = points[i * 3]!;
  const ay = points[i * 3 + 1]!;
  const az = points[i * 3 + 2]!;
  const abx = points[i * 3 + 3]! - ax;
  const aby = points[i * 3 + 4]! - ay;
  const abz = points[i * 3 + 5]! - az;
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  let t = lengthSquared > EPSILON
    ? ((p.x - ax) * abx + (p.y - ay) * aby + (p.z - az) * abz) / lengthSquared
    : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  scratchWorld.x = ax + abx * t;
  scratchWorld.y = ay + aby * t;
  scratchWorld.z = az + abz * t;
  const dx = p.x - scratchWorld.x;
  const dy = p.y - scratchWorld.y;
  const dz = p.z - scratchWorld.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Contact of a probe sphere with a rounded shape whose core is the point
 * (spheres) or segment chain (capsules, polylines) nearest `center`, already
 * in `coreX/Y/Z`, at distance `distance` from it.
 */
function roundedContact(
  record: ColliderRecord,
  coreX: number,
  coreY: number,
  coreZ: number,
  shapeRadius: number,
  center: Vec3,
  radius: number,
  out: ColliderContact,
): boolean {
  const dx = center.x - coreX;
  const dy = center.y - coreY;
  const dz = center.z - coreZ;
  const distance = Math.hypot(dx, dy, dz);
  const penetration = radius + shapeRadius - distance;
  if (penetration <= 0) return false;
  out.handle = record.handle;
  if (distance > EPSILON) {
    out.normal.x = dx / distance;
    out.normal.y = dy / distance;
    out.normal.z = dz / distance;
  } else {
    // The probe centre sits on the core: push straight up, the least
    // surprising direction for something resting on a pile or a rail.
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
  }
  out.penetration = penetration;
  out.point.x = coreX + out.normal.x * shapeRadius;
  out.point.y = coreY + out.normal.y * shapeRadius;
  out.point.z = coreZ + out.normal.z * shapeRadius;
  recordPointVelocity(record, out.point, out.pointVelocity);
  out.material = record.material;
  return true;
}

function sphereContact(record: ColliderRecord, center: Vec3, radius: number, out: ColliderContact): boolean {
  const { shape, worldPoints } = record;
  switch (shape.kind) {
    case "sphere":
      return roundedContact(record, worldPoints[0]!, worldPoints[1]!, worldPoints[2]!, shape.radius, center, radius, out);
    case "capsule":
      closestOnSegment(worldPoints, 0, center);
      return roundedContact(record, scratchWorld.x, scratchWorld.y, scratchWorld.z, shape.radius, center, radius, out);
    case "polyline": {
      let best = Infinity;
      let bestX = 0;
      let bestY = 0;
      let bestZ = 0;
      for (let i = 0; i < shape.points.length - 1; i += 1) {
        const distanceSquared = closestOnSegment(worldPoints, i, center);
        if (distanceSquared < best) {
          best = distanceSquared;
          bestX = scratchWorld.x;
          bestY = scratchWorld.y;
          bestZ = scratchWorld.z;
        }
      }
      return roundedContact(record, bestX, bestY, bestZ, shape.radius, center, radius, out);
    }
    case "box":
      return boxContact(record, shape.halfExtents, center, radius, out);
  }
}

function boxContact(
  record: ColliderRecord,
  half: Vec3,
  center: Vec3,
  radius: number,
  out: ColliderContact,
): boolean {
  const points = record.worldPoints;
  scratchOffset.x = center.x - points[0]!;
  scratchOffset.y = center.y - points[1]!;
  scratchOffset.z = center.z - points[2]!;
  inverseRotateVectorInto(scratchLocal, record.boxOrientation, scratchOffset);
  const lx = scratchLocal.x;
  const ly = scratchLocal.y;
  const lz = scratchLocal.z;
  const inside = Math.abs(lx) <= half.x && Math.abs(ly) <= half.y && Math.abs(lz) <= half.z;
  let penetration: number;
  if (inside) {
    // Push out through the nearest face.
    const gapX = half.x - Math.abs(lx);
    const gapY = half.y - Math.abs(ly);
    const gapZ = half.z - Math.abs(lz);
    scratchLocal.x = 0;
    scratchLocal.y = 0;
    scratchLocal.z = 0;
    let gap: number;
    if (gapY <= gapX && gapY <= gapZ) {
      gap = gapY;
      scratchLocal.y = ly >= 0 ? 1 : -1;
    } else if (gapX <= gapZ) {
      gap = gapX;
      scratchLocal.x = lx >= 0 ? 1 : -1;
    } else {
      gap = gapZ;
      scratchLocal.z = lz >= 0 ? 1 : -1;
    }
    penetration = radius + gap;
    rotateVectorInto(out.normal, record.boxOrientation, scratchLocal);
    // Surface point: the probe centre carried out to the nearest face.
    out.point.x = center.x + out.normal.x * gap;
    out.point.y = center.y + out.normal.y * gap;
    out.point.z = center.z + out.normal.z * gap;
  } else {
    const cx = Math.max(-half.x, Math.min(half.x, lx));
    const cy = Math.max(-half.y, Math.min(half.y, ly));
    const cz = Math.max(-half.z, Math.min(half.z, lz));
    const dx = lx - cx;
    const dy = ly - cy;
    const dz = lz - cz;
    const distance = Math.hypot(dx, dy, dz);
    penetration = radius - distance;
    if (penetration <= 0) return false;
    scratchLocal.x = dx / distance;
    scratchLocal.y = dy / distance;
    scratchLocal.z = dz / distance;
    rotateVectorInto(out.normal, record.boxOrientation, scratchLocal);
    scratchLocal.x = cx;
    scratchLocal.y = cy;
    scratchLocal.z = cz;
    rotateVectorInto(out.point, record.boxOrientation, scratchLocal);
    out.point.x += points[0]!;
    out.point.y += points[1]!;
    out.point.z += points[2]!;
  }
  out.handle = record.handle;
  out.penetration = penetration;
  recordPointVelocity(record, out.point, out.pointVelocity);
  out.material = record.material;
  return true;
}

/**
 * The sweep in progress (`ColliderWorld.sweep`): its segment, radius and the
 * nearest touch so far, and the shape solvers' inputs and answers. Numbers
 * travel in these fields, never through a call, so V8 boxes none of them
 * however it inlines; each starts as a double (-0), so no field changes
 * representation on its first fractional write.
 */
const sweepState = {
  // The segment's direction (to - from, not normalised), its length, the swept radius.
  dx: -0,
  dy: -0,
  dz: -0,
  length: -0,
  radius: -0,
  /** Nearest touch so far, as a fraction of the segment. */
  best: Infinity,
  // The segment's start in the frame a solver works in (world, or a box's own).
  ox: -0,
  oy: -0,
  oz: -0,
  // Its direction in that frame.
  ux: -0,
  uy: -0,
  uz: -0,
  // A rounded core: a sphere's centre (a) or a capsule's axis (a to b), and the Minkowski radius.
  ax: -0,
  ay: -0,
  az: -0,
  bx: -0,
  by: -0,
  bz: -0,
  r: -0,
  /** A solver's answer: the entry fraction. */
  t: -0,
  /** A box face entered by the slab test: its local axis (0, 1, 2) and side (+-1); -1 for none. */
  faceAxis: -1,
  faceSign: 1,
  // A box's half extents, and a local point near its edges.
  hx: -0,
  hy: -0,
  hz: -0,
  px: -0,
  py: -0,
  pz: -0,
  // A query point, and the nearest point of a core to it with the squared distance.
  qx: -0,
  qy: -0,
  qz: -0,
  cx: -0,
  cy: -0,
  cz: -0,
  d2: -0,
  // An overlap at the start: its depth, normal and surface point.
  penetration: -0,
  nx: -0,
  ny: -0,
  nz: -0,
  sx: -0,
  sy: -0,
  sz: -0,
};
const sweepBox: ColliderAabb = { minX: -0, minY: -0, minZ: -0, maxX: -0, maxY: -0, maxZ: -0 };
const sweepCenter: Vec3 = { x: -0, y: -0, z: -0 };
const sweepLocal: Vec3 = { x: -0, y: -0, z: -0 };
const sweepOffset: Vec3 = { x: -0, y: -0, z: -0 };
const sweepLocalDirection: Vec3 = { x: -0, y: -0, z: -0 };
const sweepWorldDirection: Vec3 = { x: -0, y: -0, z: -0 };
const slabOrigin = new Float64Array(3);
const slabDirection = new Float64Array(3);
const slabExtent = new Float64Array(3);
/** Moving into an overlap: the move's share against its normal past this is "deeper in". */
const SWEEP_INTO_TOLERANCE = 1e-6;

/** One collider against the sweep in `sweepState`: true when it is now the nearest touch. */
function sweepRecord(record: ColliderRecord, from: Vec3, out: ColliderSweepHit): boolean {
  const s = sweepState;
  s.qx = from.x;
  s.qy = from.y;
  s.qz = from.z;
  if (overlapAtQuery(record)) {
    // Already overlapping: a touch at 0 only when heading deeper in.
    if ((s.dx * s.nx + s.dy * s.ny + s.dz * s.nz) / s.length >= -SWEEP_INTO_TOLERANCE) return false;
    if (!(s.best > 0)) return false;
    s.best = 0;
    out.handle = record.handle;
    out.fraction = 0;
    out.normal.x = s.nx;
    out.normal.y = s.ny;
    out.normal.z = s.nz;
    out.point.x = s.sx;
    out.point.y = s.sy;
    out.point.z = s.sz;
    recordPointVelocity(record, out.point, out.pointVelocity);
    out.material = record.material;
    return true;
  }
  if (!shapeEntry(record, from)) return false;
  const t = s.t;
  if (!(t < s.best)) return false;
  s.best = t;
  sweepCenter.x = from.x + s.dx * t;
  sweepCenter.y = from.y + s.dy * t;
  sweepCenter.z = from.z + s.dz * t;
  touchAt(record, out);
  out.handle = record.handle;
  out.fraction = t;
  recordPointVelocity(record, out.point, out.pointVelocity);
  out.material = record.material;
  return true;
}

/**
 * Whether the sweep's sphere centred on the query point overlaps `record`
 * (a positive depth), with the depth, the outward normal and the surface
 * point in `sweepState`: `sphereContact`'s geometry, with square roots in
 * place of `Math.hypot` (which boxes its arguments).
 */
function overlapAtQuery(record: ColliderRecord): boolean {
  const s = sweepState;
  const { shape, worldPoints } = record;
  // Starts as a double: a switch V8 cannot see is exhaustive would otherwise merge an
  // undefined into it and box every double it holds.
  let shapeRadius = -0;
  switch (shape.kind) {
    case "sphere":
      s.cx = worldPoints[0]!;
      s.cy = worldPoints[1]!;
      s.cz = worldPoints[2]!;
      shapeRadius = record.radius;
      break;
    case "capsule":
      closestOnCore(worldPoints, 0);
      shapeRadius = record.radius;
      break;
    case "polyline": {
      let best = Infinity;
      let bestX = 0.5;
      let bestY = 0.5;
      let bestZ = 0.5;
      for (let i = 0; i < record.pointCount - 1; i += 1) {
        closestOnCore(worldPoints, i);
        if (s.d2 < best) {
          best = s.d2;
          bestX = s.cx;
          bestY = s.cy;
          bestZ = s.cz;
        }
      }
      s.cx = bestX;
      s.cy = bestY;
      s.cz = bestZ;
      shapeRadius = record.radius;
      break;
    }
    case "box":
      return boxOverlapAtQuery(record, record.halfExtents);
  }
  const dx = s.qx - s.cx;
  const dy = s.qy - s.cy;
  const dz = s.qz - s.cz;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const penetration = s.radius + shapeRadius - distance;
  if (!(penetration > 0)) return false;
  if (distance > EPSILON) {
    s.nx = dx / distance;
    s.ny = dy / distance;
    s.nz = dz / distance;
  } else {
    s.nx = 0;
    s.ny = 1;
    s.nz = 0;
  }
  s.penetration = penetration;
  s.sx = s.cx + s.nx * shapeRadius;
  s.sy = s.cy + s.ny * shapeRadius;
  s.sz = s.cz + s.nz * shapeRadius;
  return true;
}

function boxOverlapAtQuery(record: ColliderRecord, half: Vec3): boolean {
  const s = sweepState;
  const points = record.worldPoints;
  sweepOffset.x = s.qx - points[0]!;
  sweepOffset.y = s.qy - points[1]!;
  sweepOffset.z = s.qz - points[2]!;
  inverseRotateVectorInto(sweepLocal, record.boxOrientation, sweepOffset);
  const lx = sweepLocal.x;
  const ly = sweepLocal.y;
  const lz = sweepLocal.z;
  if (Math.abs(lx) <= half.x && Math.abs(ly) <= half.y && Math.abs(lz) <= half.z) {
    // Inside: out through the nearest face, as `boxContact`.
    const gapX = half.x - Math.abs(lx);
    const gapY = half.y - Math.abs(ly);
    const gapZ = half.z - Math.abs(lz);
    sweepLocal.x = 0;
    sweepLocal.y = 0;
    sweepLocal.z = 0;
    let gap: number;
    if (gapY <= gapX && gapY <= gapZ) {
      gap = gapY;
      sweepLocal.y = ly >= 0 ? 1 : -1;
    } else if (gapX <= gapZ) {
      gap = gapX;
      sweepLocal.x = lx >= 0 ? 1 : -1;
    } else {
      gap = gapZ;
      sweepLocal.z = lz >= 0 ? 1 : -1;
    }
    const penetration = s.radius + gap;
    if (!(penetration > 0)) return false;
    rotateVectorInto(sweepWorldDirection, record.boxOrientation, sweepLocal);
    s.nx = sweepWorldDirection.x;
    s.ny = sweepWorldDirection.y;
    s.nz = sweepWorldDirection.z;
    s.penetration = penetration;
    s.sx = s.qx + s.nx * gap;
    s.sy = s.qy + s.ny * gap;
    s.sz = s.qz + s.nz * gap;
    return true;
  }
  const qx = Math.max(-half.x, Math.min(half.x, lx));
  const qy = Math.max(-half.y, Math.min(half.y, ly));
  const qz = Math.max(-half.z, Math.min(half.z, lz));
  const dx = lx - qx;
  const dy = ly - qy;
  const dz = lz - qz;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const penetration = s.radius - distance;
  if (!(penetration > 0)) return false;
  sweepLocal.x = dx / distance;
  sweepLocal.y = dy / distance;
  sweepLocal.z = dz / distance;
  rotateVectorInto(sweepWorldDirection, record.boxOrientation, sweepLocal);
  s.nx = sweepWorldDirection.x;
  s.ny = sweepWorldDirection.y;
  s.nz = sweepWorldDirection.z;
  sweepLocal.x = qx;
  sweepLocal.y = qy;
  sweepLocal.z = qz;
  rotateVectorInto(sweepWorldDirection, record.boxOrientation, sweepLocal);
  s.penetration = penetration;
  s.sx = sweepWorldDirection.x + points[0]!;
  s.sy = sweepWorldDirection.y + points[1]!;
  s.sz = sweepWorldDirection.z + points[2]!;
  return true;
}

/** The nearest point to the query point on the segment from point i to i + 1, and its squared distance, into `sweepState`. */
function closestOnCore(points: Float64Array, i: number): void {
  const s = sweepState;
  const ax = points[i * 3]!;
  const ay = points[i * 3 + 1]!;
  const az = points[i * 3 + 2]!;
  const abx = points[i * 3 + 3]! - ax;
  const aby = points[i * 3 + 4]! - ay;
  const abz = points[i * 3 + 5]! - az;
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  let t = lengthSquared > EPSILON
    ? ((s.qx - ax) * abx + (s.qy - ay) * aby + (s.qz - az) * abz) / lengthSquared
    : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  s.cx = ax + abx * t;
  s.cy = ay + aby * t;
  s.cz = az + abz * t;
  const dx = s.qx - s.cx;
  const dy = s.qy - s.cy;
  const dz = s.qz - s.cz;
  s.d2 = dx * dx + dy * dy + dz * dz;
}

/** The fraction at which the swept centre first enters `record`'s Minkowski sum with the sweep's sphere, into `sweepState.t`. */
function shapeEntry(record: ColliderRecord, from: Vec3): boolean {
  const s = sweepState;
  const { shape, worldPoints } = record;
  s.ox = from.x;
  s.oy = from.y;
  s.oz = from.z;
  s.ux = s.dx;
  s.uy = s.dy;
  s.uz = s.dz;
  switch (shape.kind) {
    case "sphere":
      s.ax = worldPoints[0]!;
      s.ay = worldPoints[1]!;
      s.az = worldPoints[2]!;
      s.r = record.radius + s.radius;
      return raySphereEntry();
    case "capsule":
      loadSegment(worldPoints, 0);
      s.r = record.radius + s.radius;
      return rayCapsuleEntry();
    case "polyline": {
      s.r = record.radius + s.radius;
      let best = Infinity;
      for (let i = 0; i < record.pointCount - 1; i += 1) {
        loadSegment(worldPoints, i);
        if (rayCapsuleEntry() && s.t < best) best = s.t;
      }
      s.t = best;
      return best <= 1;
    }
    case "box":
      return rayRoundedBoxEntry(record, record.halfExtents);
  }
}

function loadSegment(points: Float64Array, i: number): void {
  const s = sweepState;
  s.ax = points[i * 3]!;
  s.ay = points[i * 3 + 1]!;
  s.az = points[i * 3 + 2]!;
  s.bx = points[i * 3 + 3]!;
  s.by = points[i * 3 + 4]!;
  s.bz = points[i * 3 + 5]!;
}

/**
 * Ray o + t u (t in 0..1) against the sphere at a of radius r: the entry t,
 * from outside or touching. A ray heading away answers false.
 */
function raySphereEntry(): boolean {
  const s = sweepState;
  const mx = s.ox - s.ax;
  const my = s.oy - s.ay;
  const mz = s.oz - s.az;
  const b = mx * s.ux + my * s.uy + mz * s.uz;
  const c = mx * mx + my * my + mz * mz - s.r * s.r;
  if (c > 0 && b >= 0) return false;
  const a = s.ux * s.ux + s.uy * s.uy + s.uz * s.uz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return false;
  const t = (-b - Math.sqrt(discriminant)) / a;
  if (t > 1) return false;
  if (t < 0) {
    // Touching or inside: an entry only if the ray heads inward.
    if (b >= 0) return false;
    s.t = 0;
    return true;
  }
  s.t = t;
  return true;
}

/**
 * Ray o + t u (t in 0..1) against the capsule a..b of radius r: the side of
 * its cylinder where the axis parameter is inside the segment, then the two
 * end spheres; the nearest entry (Ericson, Real-Time Collision Detection,
 * 5.3.7, with sphere caps). The infinite cylinder holds both caps, so a ray
 * that misses it misses the capsule.
 */
function rayCapsuleEntry(): boolean {
  const s = sweepState;
  const ax = s.ax;
  const ay = s.ay;
  const az = s.az;
  const bx = s.bx;
  const by = s.by;
  const bz = s.bz;
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const mx = s.ox - ax;
  const my = s.oy - ay;
  const mz = s.oz - az;
  const md = mx * ex + my * ey + mz * ez;
  const nd = s.ux * ex + s.uy * ey + s.uz * ez;
  const dd = ex * ex + ey * ey + ez * ez;
  const nn = s.ux * s.ux + s.uy * s.uy + s.uz * s.uz;
  const mn = mx * s.ux + my * s.uy + mz * s.uz;
  const k = mx * mx + my * my + mz * mz - s.r * s.r;
  let best = Infinity;
  if (dd > EPSILON) {
    const a = dd * nn - nd * nd;
    const c = dd * k - md * md;
    if (a > EPSILON * dd * nn) {
      const b = dd * mn - nd * md;
      const discriminant = b * b - a * c;
      if (discriminant < 0) return false;
      // The side, entered from outside the infinite cylinder.
      if (c > 0) {
        const t = (-b - Math.sqrt(discriminant)) / a;
        const along = md + t * nd;
        if (t >= 0 && t <= 1 && along >= 0 && along <= dd) best = t;
      }
    }
  }
  if (best > 0) {
    // The caps: sphere a, then sphere b (the solver reads s.a*).
    if (raySphereEntry() && s.t < best) best = s.t;
    s.ax = bx;
    s.ay = by;
    s.az = bz;
    if (raySphereEntry() && s.t < best) best = s.t;
    s.ax = ax;
    s.ay = ay;
    s.az = az;
  }
  s.t = best;
  return best <= 1;
}

/**
 * Ray against a box rounded by the sweep's radius (Ericson 5.5.7): the slab
 * test against the box grown by the radius finds where the ray enters it;
 * if that point is off the true box along one axis it is on a face, along
 * two on an edge's quarter cylinder and along three at a corner, where the
 * edge capsules (their caps the corner spheres) decide. The edges are in this
 * body, not a function of their own: they are met rarely, and a function
 * that has not been optimised boxes every double it computes.
 */
function rayRoundedBoxEntry(record: ColliderRecord, half: Vec3): boolean {
  const s = sweepState;
  const points = record.worldPoints;
  sweepOffset.x = s.ox - points[0]!;
  sweepOffset.y = s.oy - points[1]!;
  sweepOffset.z = s.oz - points[2]!;
  inverseRotateVectorInto(sweepLocal, record.boxOrientation, sweepOffset);
  sweepWorldDirection.x = s.dx;
  sweepWorldDirection.y = s.dy;
  sweepWorldDirection.z = s.dz;
  inverseRotateVectorInto(sweepLocalDirection, record.boxOrientation, sweepWorldDirection);
  const ox = sweepLocal.x;
  const oy = sweepLocal.y;
  const oz = sweepLocal.z;
  const ux = sweepLocalDirection.x;
  const uy = sweepLocalDirection.y;
  const uz = sweepLocalDirection.z;
  const r = s.radius;
  s.hx = half.x;
  s.hy = half.y;
  s.hz = half.z;
  // Slab test against the grown box along the whole line, then t in 0..1.
  // The axes' numbers go through typed arrays: a ternary picking between
  // doubles would box them.
  slabOrigin[0] = ox;
  slabOrigin[1] = oy;
  slabOrigin[2] = oz;
  slabDirection[0] = ux;
  slabDirection[1] = uy;
  slabDirection[2] = uz;
  slabExtent[0] = s.hx + r;
  slabExtent[1] = s.hy + r;
  slabExtent[2] = s.hz + r;
  let enter = -Infinity;
  let exit = Infinity;
  let axis = -1;
  let sign = 1;
  for (let k = 0; k < 3; k += 1) {
    const o = slabOrigin[k]!;
    const u = slabDirection[k]!;
    const e = slabExtent[k]!;
    if (Math.abs(u) < EPSILON) {
      if (o < -e || o > e) return false;
      continue;
    }
    const inverse = 1 / u;
    let near = (-e - o) * inverse;
    let far = (e - o) * inverse;
    let nearSign = -1;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
      nearSign = 1;
    }
    if (near > enter) {
      enter = near;
      axis = k;
      sign = nearSign;
    }
    if (far < exit) exit = far;
    if (enter > exit) return false;
  }
  if (enter > 1 || exit < 0) return false;
  s.ox = ox;
  s.oy = oy;
  s.oz = oz;
  s.ux = ux;
  s.uy = uy;
  s.uz = uz;
  if (enter < 0) {
    // The start is inside the grown box. The overlap test found no overlap
    // with the rounded box, so it is in a corner or edge pocket: only the
    // rounded edges can be entered from there.
    if (!(r > 0)) return false;
    s.px = ox;
    s.py = oy;
    s.pz = oz;
  } else {
    const px = ox + ux * enter;
    const py = oy + uy * enter;
    const pz = oz + uz * enter;
    const tolerance = 1e-9;
    let off = 0;
    if (px < -s.hx - tolerance || px > s.hx + tolerance) off += 1;
    if (py < -s.hy - tolerance || py > s.hy + tolerance) off += 1;
    if (pz < -s.hz - tolerance || pz > s.hz + tolerance) off += 1;
    if (off <= 1 || !(r > 0)) {
      s.t = enter;
      s.faceAxis = axis;
      s.faceSign = sign;
      return true;
    }
    s.px = px;
    s.py = py;
    s.pz = pz;
  }
  // The rounded edges near the local point p: the capsule along each axis p
  // is inside, at the corner signs of the other two.
  const hx = s.hx;
  const hy = s.hy;
  const hz = s.hz;
  const px = s.px;
  const py = s.py;
  const pz = s.pz;
  const cornerX = px >= 0 ? hx : -hx;
  const cornerY = py >= 0 ? hy : -hy;
  const cornerZ = pz >= 0 ? hz : -hz;
  const outX = px < -hx || px > hx;
  const outY = py < -hy || py > hy;
  const outZ = pz < -hz || pz > hz;
  s.r = s.radius;
  let best = Infinity;
  // An edge along x where p is off the box along y and z, and so on.
  if (outY && outZ) {
    s.ax = -hx;
    s.ay = cornerY;
    s.az = cornerZ;
    s.bx = hx;
    s.by = cornerY;
    s.bz = cornerZ;
    if (rayCapsuleEntry() && s.t < best) best = s.t;
  }
  if (outX && outZ) {
    s.ax = cornerX;
    s.ay = -hy;
    s.az = cornerZ;
    s.bx = cornerX;
    s.by = hy;
    s.bz = cornerZ;
    if (rayCapsuleEntry() && s.t < best) best = s.t;
  }
  if (outX && outY) {
    s.ax = cornerX;
    s.ay = cornerY;
    s.az = -hz;
    s.bx = cornerX;
    s.by = cornerY;
    s.bz = hz;
    if (rayCapsuleEntry() && s.t < best) best = s.t;
  }
  s.t = best;
  s.faceAxis = -1;
  return best <= 1;
}

/** Normal and surface point where the swept centre `sweepCenter` touches `record`, into `out`. */
function touchAt(record: ColliderRecord, out: ColliderSweepHit): void {
  const s = sweepState;
  const { shape, worldPoints } = record;
  const c = sweepCenter;
  s.qx = c.x;
  s.qy = c.y;
  s.qz = c.z;
  // Starts as a double: a switch V8 cannot see is exhaustive would otherwise merge an
  // undefined into it and box every double it holds.
  let shapeRadius = -0;
  switch (shape.kind) {
    case "sphere":
      s.cx = worldPoints[0]!;
      s.cy = worldPoints[1]!;
      s.cz = worldPoints[2]!;
      shapeRadius = record.radius;
      break;
    case "capsule":
      closestOnCore(worldPoints, 0);
      shapeRadius = record.radius;
      break;
    case "polyline": {
      let best = Infinity;
      let bestX = 0.5;
      let bestY = 0.5;
      let bestZ = 0.5;
      for (let i = 0; i < record.pointCount - 1; i += 1) {
        closestOnCore(worldPoints, i);
        if (s.d2 < best) {
          best = s.d2;
          bestX = s.cx;
          bestY = s.cy;
          bestZ = s.cz;
        }
      }
      s.cx = bestX;
      s.cy = bestY;
      s.cz = bestZ;
      shapeRadius = record.radius;
      break;
    }
    case "box":
      boxTouch(record, record.halfExtents, out);
      return;
  }
  const dx = c.x - s.cx;
  const dy = c.y - s.cy;
  const dz = c.z - s.cz;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance > EPSILON) {
    out.normal.x = dx / distance;
    out.normal.y = dy / distance;
    out.normal.z = dz / distance;
  } else {
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
  }
  out.point.x = s.cx + out.normal.x * shapeRadius;
  out.point.y = s.cy + out.normal.y * shapeRadius;
  out.point.z = s.cz + out.normal.z * shapeRadius;
}

function boxTouch(record: ColliderRecord, half: Vec3, out: ColliderSweepHit): void {
  const points = record.worldPoints;
  sweepOffset.x = sweepCenter.x - points[0]!;
  sweepOffset.y = sweepCenter.y - points[1]!;
  sweepOffset.z = sweepCenter.z - points[2]!;
  inverseRotateVectorInto(sweepLocal, record.boxOrientation, sweepOffset);
  const lx = sweepLocal.x;
  const ly = sweepLocal.y;
  const lz = sweepLocal.z;
  const qx = Math.max(-half.x, Math.min(half.x, lx));
  const qy = Math.max(-half.y, Math.min(half.y, ly));
  const qz = Math.max(-half.z, Math.min(half.z, lz));
  const dx = lx - qx;
  const dy = ly - qy;
  const dz = lz - qz;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance > 1e-7) {
    sweepLocal.x = dx / distance;
    sweepLocal.y = dy / distance;
    sweepLocal.z = dz / distance;
  } else {
    // A ray on the face: the face the slab test entered.
    const axis = sweepState.faceAxis;
    sweepLocal.x = axis === 0 ? sweepState.faceSign : 0;
    sweepLocal.y = axis === 1 ? sweepState.faceSign : axis < 0 ? 1 : 0;
    sweepLocal.z = axis === 2 ? sweepState.faceSign : 0;
  }
  rotateVectorInto(out.normal, record.boxOrientation, sweepLocal);
  sweepLocal.x = qx;
  sweepLocal.y = qy;
  sweepLocal.z = qz;
  rotateVectorInto(out.point, record.boxOrientation, sweepLocal);
  out.point.x += points[0]!;
  out.point.y += points[1]!;
  out.point.z += points[2]!;
}
