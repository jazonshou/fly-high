import { createColliderContact, type ColliderAabb, type ColliderWorld } from "../colliders";
import { rotateVectorInto } from "../math";
import type { Vec3 } from "../types";
import { MARINA_LAYOUT } from "@/src/world/marinaLayout";
import { MARINA_COLLIDER_MATERIAL } from "./colliders";
import type { MooringLoadContext } from "./mooring";

/**
 * A hull against the marina's structures: piles, the quay wall, the pier
 * deck and the floating pontoons. Probe spheres round the hull's sides are
 * pushed out of every collider they overlap by a spring-damper with
 * friction, the "fend off" of a rubbing strake on a fender; an approach
 * faster than the struck material's crash speed is a crash instead.
 *
 * It is one more external load on the boat (the physics thread's
 * `BoatExternalLoad`), applied every substep. The crash is reported, not
 * acted on: the boat simulator reads `crashed` after the step and enters its
 * own crash state, as it does for a hard grounding.
 */

export interface MarinaContactMaterial {
  /** Contact stiffness N/m and damping N s/m per probe. */
  readonly stiffness: number;
  readonly damping: number;
  readonly friction: number;
  /** An approach faster than this, m/s along the contact normal, crashes. */
  readonly crashSpeed: number;
}

/**
 * Fendered pontoons give; timber and steel piles and the concrete quay do
 * not. A 1,800 kg runabout arriving at 2.5 m/s carries 5.6 kJ, about what a
 * gelcoat hull survives against a bare pile; a fendered pontoon takes more.
 */
export const MARINA_CONTACT_MATERIALS: Readonly<Record<number, MarinaContactMaterial>> = Object.freeze({
  [MARINA_COLLIDER_MATERIAL.pontoon]: Object.freeze({ stiffness: 60_000, damping: 9_000, friction: 0.3, crashSpeed: 4 }),
  [MARINA_COLLIDER_MATERIAL.timber]: Object.freeze({ stiffness: 300_000, damping: 20_000, friction: 0.45, crashSpeed: 2.5 }),
  [MARINA_COLLIDER_MATERIAL.steel]: Object.freeze({ stiffness: 400_000, damping: 24_000, friction: 0.35, crashSpeed: 2.5 }),
  [MARINA_COLLIDER_MATERIAL.concrete]: Object.freeze({ stiffness: 600_000, damping: 30_000, friction: 0.5, crashSpeed: 2 }),
});

const FALLBACK_MATERIAL = MARINA_CONTACT_MATERIALS[MARINA_COLLIDER_MATERIAL.timber]!;

/** Probe sphere radius, metres. */
export const HULL_PROBE_RADIUS = 0.25;

/** Sliding speed, m/s, below which friction fades to zero instead of chattering. */
const FRICTION_SLIP = 0.05;

/** Probe stations along each side; close enough that a 0.17 m pile cannot slip between two probes by more than 0.1 m. */
const PROBE_STATIONS = 13;

/**
 * Probe sphere centres, body frame: two rows (near the waterline and at the
 * sheer) down each side of the design boat's outline, transom to stem, and
 * across the transom. The outline is the berth's design boat
 * (MARINA_LAYOUT), narrowing to the bow.
 */
export function hullProbePoints(): readonly Readonly<Vec3>[] {
  const L = MARINA_LAYOUT;
  const transom = -L.boatCgFromTransom;
  const stem = L.boatLength - L.boatCgFromTransom - HULL_PROBE_RADIUS;
  const halfBeam = L.boatBeam * 0.5 - HULL_PROBE_RADIUS;
  const points: Vec3[] = [];
  for (const y of [0, 0.6]) {
    for (let index = 0; index < PROBE_STATIONS; index += 1) {
      const x = transom + ((stem - transom) * index) / (PROBE_STATIONS - 1);
      // Full beam aft, closing to the stem over the forward 40%.
      const forward = (x - transom) / (stem - transom);
      const half = forward < 0.6 ? halfBeam : halfBeam * Math.max(0, (1 - forward) / 0.4);
      points.push({ x, y, z: -half }, { x, y, z: half });
    }
    for (const z of [-halfBeam / 2, 0, halfBeam / 2]) points.push({ x: transom, y, z });
  }
  return Object.freeze(points.map((point) => Object.freeze(point)));
}

/** Every probe lies within this of the centre of gravity, sphere included. */
const PROBE_REACH = Math.hypot(
  Math.max(MARINA_LAYOUT.boatCgFromTransom, MARINA_LAYOUT.boatLength - MARINA_LAYOUT.boatCgFromTransom),
  MARINA_LAYOUT.boatBeam * 0.5,
  0.6,
) + HULL_PROBE_RADIUS;

const scratchCentre: Vec3 = { x: 0, y: 0, z: 0 };
const scratchVelocity: Vec3 = { x: 0, y: 0, z: 0 };
const scratchForce: Vec3 = { x: 0, y: 0, z: 0 };
const contact = createColliderContact();
const candidate = createColliderContact();

export class MarinaContactLoad {
  /** Set once a probe meets a structure faster than its crash speed. */
  crashed = false;
  /** The fastest normal approach seen since the last reset, m/s. */
  peakApproachSpeed = 0;
  /** Probes touching a structure in the last substep. */
  touching = 0;
  private readonly probes = hullProbePoints();
  private readonly nearby: number[] = [];
  private readonly bounds: ColliderAabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  constructor(private readonly colliders: ColliderWorld) {}

  reset(): void {
    this.crashed = false;
    this.peakApproachSpeed = 0;
    this.touching = 0;
  }

  apply(context: MooringLoadContext): void {
    this.touching = 0;
    // One broad query for the whole hull; out on open water it finds nothing.
    const p = context.position;
    const b = this.bounds;
    b.minX = p.x - PROBE_REACH;
    b.minY = p.y - PROBE_REACH;
    b.minZ = p.z - PROBE_REACH;
    b.maxX = p.x + PROBE_REACH;
    b.maxY = p.y + PROBE_REACH;
    b.maxZ = p.z + PROBE_REACH;
    const count = this.colliders.query(b, this.nearby);
    if (count === 0) return;
    for (const probe of this.probes) {
      rotateVectorInto(scratchCentre, context.orientation, probe);
      scratchCentre.x += p.x;
      scratchCentre.y += p.y;
      scratchCentre.z += p.z;
      if (!this.deepest(scratchCentre, count)) continue;
      this.touching += 1;
      const material = MARINA_CONTACT_MATERIALS[contact.material] ?? FALLBACK_MATERIAL;
      context.pointVelocity(contact.point, scratchVelocity);
      // Relative velocity of the hull against the struck surface.
      const rx = scratchVelocity.x - contact.pointVelocity.x;
      const ry = scratchVelocity.y - contact.pointVelocity.y;
      const rz = scratchVelocity.z - contact.pointVelocity.z;
      const normalSpeed = rx * contact.normal.x + ry * contact.normal.y + rz * contact.normal.z;
      const approach = -normalSpeed;
      if (approach > this.peakApproachSpeed) this.peakApproachSpeed = approach;
      if (approach > material.crashSpeed) this.crashed = true;
      const push = Math.max(0, material.stiffness * contact.penetration - material.damping * normalSpeed);
      // Coulomb friction against the sliding velocity.
      const tx = rx - normalSpeed * contact.normal.x;
      const ty = ry - normalSpeed * contact.normal.y;
      const tz = rz - normalSpeed * contact.normal.z;
      const slide = Math.hypot(tx, ty, tz);
      const friction = slide > 1e-6 ? (material.friction * push * Math.min(1, slide / FRICTION_SLIP)) / slide : 0;
      scratchForce.x = contact.normal.x * push - tx * friction;
      scratchForce.y = contact.normal.y * push - ty * friction;
      scratchForce.z = contact.normal.z * push - tz * friction;
      context.addForceAtWorldPoint(scratchForce, contact.point);
    }
  }

  /** The deepest touching contact of a probe among the nearby colliders, into `contact`. */
  private deepest(centre: Vec3, count: number): boolean {
    let found = false;
    for (let index = 0; index < count; index += 1) {
      if (!this.colliders.contactSphere(this.nearby[index]!, centre, HULL_PROBE_RADIUS, candidate)) continue;
      if (candidate.penetration <= 0 || (found && candidate.penetration <= contact.penetration)) continue;
      contact.handle = candidate.handle;
      contact.penetration = candidate.penetration;
      contact.material = candidate.material;
      copy(contact.normal, candidate.normal);
      copy(contact.point, candidate.point);
      copy(contact.pointVelocity, candidate.pointVelocity);
      found = true;
    }
    return found;
  }
}

function copy(out: Vec3, value: Readonly<Vec3>): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}
