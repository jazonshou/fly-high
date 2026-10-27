import type { BoatContactMaterial } from "../boat/boatSimulator";
import type { ColliderWorld } from "../colliders";
import type { Quaternion, Vec3 } from "../types";
import { createWaterSurfaceSample, type WaterSurfaceAuthority, type WaterSurfaceSample } from "../water/types";
import {
  FLOATING_BOX_KINDS,
  marinaBoxOrientation,
  marinaMooredBoatBox,
  marinaToWorld,
  type MarinaBox,
  type MarinaLayout,
  type MarinaPostKind,
} from "@/src/world/marinaLayout";

/**
 * The home marina's colliders in the sim's `ColliderWorld`: piles, posts and
 * beacon towers are capsules, the pier deck, gangway, quay wall and buildings
 * are static boxes, and every pontoon module and finger is a kinematic box
 * that rides the (calmed) sea, posed every step from the water authority.
 * The moored runabouts are static boxes too, so the boat cannot pass
 * through the ones on screen.
 *
 * Every collider is built from `homeMarina(world)`'s records, the same ones
 * the renderer draws, so a pile a hull hits is the pile on screen.
 */

/**
 * Material ids handed back with every contact, so the hull's contact law can
 * tell a fendered pontoon from a timber pile. Kept clear of the low ids roads
 * and buildings use.
 */
export const MARINA_COLLIDER_MATERIAL = Object.freeze({
  timber: 101,
  concrete: 102,
  pontoon: 103,
  steel: 104,
  hull: 105,
});

/**
 * How a hull meets each marina material, for the boat's contact law
 * (`BoatEnvironment.contactMaterials`). Fendered pontoons give: a 1,800 kg
 * runabout's 3.5 m/s knock (11 kJ) is what a pontoon's rubbing strake is
 * built to take. Bare timber and steel piles take the boat's own default, and
 * the concrete quay wall is the hardest face in the marina. A moored boat's
 * topsides flex between the two: a 3 m/s knock on one is a crash.
 */
export const MARINA_CONTACT_MATERIALS: ReadonlyMap<number, Readonly<BoatContactMaterial>> = new Map<number, Readonly<BoatContactMaterial>>([
  [MARINA_COLLIDER_MATERIAL.pontoon, Object.freeze({ crashSpeed: 4, stiffness: 1.5e5, damping: 9e3, friction: 0.15 })],
  [MARINA_COLLIDER_MATERIAL.timber, Object.freeze({ crashSpeed: 2.5, stiffness: 4e5, damping: 1.2e4, friction: 0.3 })],
  [MARINA_COLLIDER_MATERIAL.steel, Object.freeze({ crashSpeed: 2.5, stiffness: 4e5, damping: 1.2e4, friction: 0.25 })],
  [MARINA_COLLIDER_MATERIAL.concrete, Object.freeze({ crashSpeed: 2, stiffness: 6e5, damping: 1.5e4, friction: 0.4 })],
  [MARINA_COLLIDER_MATERIAL.hull, Object.freeze({ crashSpeed: 3, stiffness: 2.5e5, damping: 1e4, friction: 0.2 })],
]);

/** Collider group of the home marina, for `ColliderWorld.removeGroup`. */
export const MARINA_COLLIDER_GROUP = 7_001;

const STATIC_POST_KINDS: ReadonlySet<MarinaPostKind> = new Set(["pile", "guidePile", "beaconPost", "lampPost"]);

export interface MarinaPontoonCollider {
  readonly handle: number;
  readonly box: MarinaBox;
  /** World XZ of the pontoon's centre and its rest centre height above still water. */
  readonly x: number;
  readonly z: number;
  readonly restOffset: number;
  readonly yaw: Quaternion;
}

export interface MarinaColliders {
  readonly group: number;
  readonly staticHandles: readonly number[];
  readonly pontoons: readonly MarinaPontoonCollider[];
}

/** Adds every marina collider; returns the handles, pontoons in layout order. */
export function addMarinaColliders(
  colliders: ColliderWorld,
  layout: MarinaLayout,
  group: number = MARINA_COLLIDER_GROUP,
): MarinaColliders {
  const staticHandles: number[] = [];
  const pontoons: MarinaPontoonCollider[] = [];
  for (const post of layout.posts) {
    if (!STATIC_POST_KINDS.has(post.kind)) continue;
    const p = marinaToWorld(layout.frame, post.right, post.out);
    const material = post.kind === "guidePile" || post.kind === "beaconPost"
      ? MARINA_COLLIDER_MATERIAL.steel
      : MARINA_COLLIDER_MATERIAL.timber;
    staticHandles.push(colliders.addStatic(
      {
        kind: "capsule",
        a: { x: p.x, y: post.bottomY, z: p.z },
        b: { x: p.x, y: post.topY, z: p.z },
        radius: post.radius,
      },
      { material, group },
    ));
  }
  for (const box of layout.boxes) {
    if (box.kind === "lifeRingStand" || box.kind === "fuelPump") continue;
    const p = marinaToWorld(layout.frame, box.right, box.out);
    // Box-local x is marina -right, z is marina out (see marinaBoxOrientation).
    const halfExtents = { x: box.halfRight, y: box.halfHeight, z: box.halfOut };
    const orientation = marinaBoxOrientation(layout.frame, box);
    if (FLOATING_BOX_KINDS.has(box.kind)) {
      const handle = colliders.addKinematic(
        { kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents },
        { material: MARINA_COLLIDER_MATERIAL.pontoon, group },
      );
      colliders.setKinematicPose(handle, { x: p.x, y: box.y, z: p.z }, orientation);
      pontoons.push(Object.freeze({ handle, box, x: p.x, z: p.z, restOffset: box.y - layout.seaLevel, yaw: orientation }));
      continue;
    }
    staticHandles.push(colliders.addStatic(
      { kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents },
      {
        material: box.kind === "pierDeck" || box.kind === "gangway" ? MARINA_COLLIDER_MATERIAL.timber : MARINA_COLLIDER_MATERIAL.concrete,
        group,
        position: { x: p.x, y: box.y, z: p.z },
        orientation,
      },
    ));
  }
  for (const berth of layout.berths) {
    if (!berth.occupied) continue;
    const box = marinaMooredBoatBox(layout.frame, berth, layout.seaLevel);
    const p = marinaToWorld(layout.frame, box.right, box.out);
    staticHandles.push(colliders.addStatic(
      { kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: box.halfRight, y: box.halfHeight, z: box.halfOut } },
      {
        material: MARINA_COLLIDER_MATERIAL.hull,
        group,
        position: { x: p.x, y: box.y, z: p.z },
        orientation: marinaBoxOrientation(layout.frame, box),
      },
    ));
  }
  return Object.freeze({ group, staticHandles: Object.freeze(staticHandles), pontoons: Object.freeze(pontoons) });
}

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * How much of the surface's tilt a pontoon takes: a 12 m module bridges the
 * short waves, so it follows the slope at its centre only partly. The drawn
 * pontoons stand at rest for now: the renderer has no sea sample on the main
 * thread yet, and in the calmed basin the difference is the basin's swell.
 */
export const PONTOON_TILT_FOLLOW = 0.5;

export interface MarinaPontoonPose {
  position: Vec3;
  orientation: Quaternion;
  velocity: Vec3;
}

export function createMarinaPontoonPose(): MarinaPontoonPose {
  return { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 } };
}

/**
 * A pontoon's pose on the water: its rest offset above the local surface,
 * tilted part way to the surface normal, rising and falling with the
 * surface's vertical velocity (the guide piles hold it horizontally). The
 * sim's kinematic colliders and the renderer's drawn pontoons both call this,
 * with the same water sample, so they agree.
 */
export function marinaPontoonPose(
  x: number,
  z: number,
  restOffset: number,
  yaw: Quaternion,
  water: Readonly<WaterSurfaceSample>,
  out: MarinaPontoonPose,
): MarinaPontoonPose {
  const surface = water.kind === "none" ? water.stillHeight : water.height;
  out.position.x = x;
  out.position.y = surface + restOffset;
  out.position.z = z;
  out.velocity.x = 0;
  out.velocity.y = water.kind === "none" ? 0 : water.velocity.y;
  out.velocity.z = 0;
  // Tilt: rotate world up toward the normal by PONTOON_TILT_FOLLOW of the angle.
  const nx = water.normal.x;
  const ny = water.normal.y;
  const nz = water.normal.z;
  const sine = Math.hypot(nz, nx);
  if (sine < 1e-9) {
    out.orientation.x = yaw.x;
    out.orientation.y = yaw.y;
    out.orientation.z = yaw.z;
    out.orientation.w = yaw.w;
    return out;
  }
  const angle = Math.atan2(sine, ny) * PONTOON_TILT_FOLLOW;
  // Axis = up x normal = (nz, 0, -nx) / |.|.
  const s = Math.sin(angle * 0.5) / sine;
  const tilt = { x: nz * s, y: 0, z: -nx * s, w: Math.cos(angle * 0.5) };
  const q = multiply(tilt, yaw);
  out.orientation.x = q.x;
  out.orientation.y = q.y;
  out.orientation.z = q.z;
  out.orientation.w = q.w;
  return out;
}

const POSE_SCRATCH = createMarinaPontoonPose();
const WATER_SCRATCH = createWaterSurfaceSample();
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** Poses every pontoon from the water authority; call once per sim step, after `water.setTime`. */
export function poseMarinaPontoons(
  colliders: ColliderWorld,
  marina: MarinaColliders,
  water: WaterSurfaceAuthority,
): void {
  for (const pontoon of marina.pontoons) {
    water.sample(pontoon.x, pontoon.z, WATER_SCRATCH);
    marinaPontoonPose(pontoon.x, pontoon.z, pontoon.restOffset, pontoon.yaw, WATER_SCRATCH, POSE_SCRATCH);
    colliders.setKinematicPose(pontoon.handle, POSE_SCRATCH.position, POSE_SCRATCH.orientation, POSE_SCRATCH.velocity, ZERO);
  }
}
