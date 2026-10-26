import { EPSILON, inverseRotateVectorInto, rotateVectorInto } from "./math";
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

const SLOT_BITS = 20;
const SLOT_COUNT = 1 << SLOT_BITS;
const SLOT_MASK = SLOT_COUNT - 1;
const MAX_GENERATION = 2047;
// Packs a signed bin coordinate pair into one exact double; ±2^20 bins of
// 32 m reach far past any world the game streams.
const BIN_OFFSET = 1 << 20;
const BIN_STRIDE = 1 << 21;

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
}

function binIndex(coordinate: number): number {
  return Math.floor(coordinate / COLLIDER_BIN_SIZE_METERS);
}

function binKey(ix: number, iz: number): number {
  return (ix + BIN_OFFSET) * BIN_STRIDE + (iz + BIN_OFFSET);
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
    copyQuat(record.orientation, orientation);
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
      orientation: { ...(options.orientation ?? IDENTITY) },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      worldPoints: new Float64Array(shapePointCount(shape) * 3),
      boxOrientation: { x: 0, y: 0, z: 0, w: 1 },
      aabb: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      bins: [],
      queryStamp: 0,
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
        multiplyQuaternion(record.boxOrientation, record.orientation, shape.orientation ?? IDENTITY);
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

function copyQuat(out: Quaternion, value: Quaternion): void {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length < EPSILON) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return;
  }
  out.x = value.x / length;
  out.y = value.y / length;
  out.z = value.z / length;
  out.w = value.w / length;
}

function multiplyQuaternion(out: Quaternion, a: Quaternion, b: Quaternion): void {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const length = Math.hypot(x, y, z, w) || 1;
  out.x = x / length;
  out.y = y / length;
  out.z = z / length;
  out.w = w / length;
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
