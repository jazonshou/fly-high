import { describe, expect, it } from "vitest";
import { ColliderWorld, type ColliderContact } from "@/src/sim/colliders";
import {
  CAR_COLLIDER_MATERIAL,
  CAR_STRUCTURE_DETAIL_HYSTERESIS_METERS,
  CAR_STRUCTURE_DETAIL_METERS,
  CarColliders,
  regionColliders,
} from "@/src/sim/ground/carColliders";
import { rotateVectorInto } from "@/src/sim/math";
import {
  buildStructureColliders,
  poseStructureCollider,
  structureShellColliders,
} from "@/src/sim/structures/colliders";
import { createWorld } from "@/src/world";
import type { InfrastructureRegion } from "@/src/world/infrastructure";
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import type { StructureColliderBox } from "@/src/world/structures/structureModel";
import { structureToWorld, type StructureRecord } from "@/src/world/structures/structureRecord";

/**
 * The generated buildings' colliders: each kit collider posed in the world
 * exactly where its building frame puts it (so what is drawn is what is
 * met), and the car's collider world taking a streamed region's buildings
 * as one group that leaves with the region.
 */

function record(overrides: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id: 1,
    archetype: "house",
    style: "temperate",
    x: 1_200,
    z: -340,
    heading: 0.7,
    width: 11,
    depth: 8,
    storeys: 2,
    floorY: 52.4,
    baseY: 51.6,
    entryY: 51.9,
    foundation: "plinth",
    seed: 7,
    settlement: 3,
    settlementKind: "hamlet",
    basalt: false,
    ...overrides,
  };
}

/** A pitched roof slab: tilted 35 degrees about the frame's x axis, off centre. */
function slab(): StructureColliderBox {
  const pitch = (35 * Math.PI) / 180;
  return {
    kind: "box",
    cx: 1.5,
    cy: 6.2,
    cz: -2,
    ux: 6,
    uy: 0,
    uz: 0,
    vx: 0,
    vy: 0.1 * Math.cos(pitch),
    vz: 0.1 * Math.sin(pitch),
    wx: 0,
    wy: -2.6 * Math.sin(pitch),
    wz: 2.6 * Math.cos(pitch),
    material: "timber",
  };
}

describe("a building's colliders", () => {
  it("stand where the building frame puts them, a tilted roof slab included", () => {
    for (const heading of [0, 0.7, -2.1, Math.PI]) {
      const building = record({ heading });
      const box = slab();
      const posed = poseStructureCollider(building, box);
      expect(posed.material).toBe("timber");
      const shape = posed.shape;
      if (shape.kind !== "box") throw new Error("a box");
      expect(shape.halfExtents.x).toBeCloseTo(6, 9);
      expect(shape.halfExtents.y).toBeCloseTo(0.1, 9);
      expect(shape.halfExtents.z).toBeCloseTo(2.6, 9);
      // Box-local corners, rotated and moved by the collider's pose, land on
      // the building frame's corners of the same box.
      for (const [a, b, c] of [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1], [0.3, -0.2, 0.9]]) {
        const local = { x: a! * shape.halfExtents.x, y: b! * shape.halfExtents.y, z: c! * shape.halfExtents.z };
        const rotated = rotateVectorInto({ x: 0, y: 0, z: 0 }, shape.orientation!, local);
        const frame = structureToWorld(
          building,
          box.cx + a! * box.ux + b! * box.vx + c! * box.wx,
          box.cy + a! * box.uy + b! * box.vy + c! * box.wy,
          box.cz + a! * box.uz + b! * box.vz + c! * box.wz,
          { x: 0, y: 0, z: 0 },
        );
        expect(shape.center.x + rotated.x).toBeCloseTo(frame.x, 9);
        expect(shape.center.y + rotated.y).toBeCloseTo(frame.y, 9);
        expect(shape.center.z + rotated.z).toBeCloseTo(frame.z, 9);
      }
    }
  });

  it("pose a capsule's ends through the frame", () => {
    const building = record();
    const posed = poseStructureCollider(building, {
      kind: "capsule", ax: 5, ay: -0.8, az: 6, bx: 5, by: 1, bz: 6, radius: 0.08, material: "timber",
    });
    if (posed.shape.kind !== "capsule") throw new Error("a capsule");
    expect(posed.shape.a).toEqual(structureToWorld(building, 5, -0.8, 6, { x: 0, y: 0, z: 0 }));
    expect(posed.shape.b).toEqual(structureToWorld(building, 5, 1, 6, { x: 0, y: 0, z: 0 }));
    expect(posed.shape.radius).toBe(0.08);
  });

  it("stand in as the body from the footings to the eaves where the kit's are not laid out", () => {
    const building = record();
    const [shell] = structureShellColliders(building);
    const world = new ColliderWorld();
    for (const collider of buildStructureColliders([building])) world.addStatic(collider.shape);
    const contact: ColliderContact = {
      handle: -1, normal: { x: 0, y: 0, z: 0 }, penetration: 0, point: { x: 0, y: 0, z: 0 }, pointVelocity: { x: 0, y: 0, z: 0 }, material: 0,
    };
    const at = (lx: number, ly: number, lz: number) => structureToWorld(building, lx, ly, lz, { x: 0, y: 0, z: 0 });
    // Inside the walls at the ground floor and under the eaves: solid.
    expect(world.deepestSphereContact(at(0, 1, 0), 0.3, contact)).toBe(true);
    expect(world.deepestSphereContact(at(5.3, 5.5, 3.8), 0.1, contact)).toBe(true);
    // Just outside a side wall, and above the eaves: clear.
    expect(world.deepestSphereContact(at(5.5 + 0.5, 1, 0), 0.3, contact)).toBe(false);
    expect(world.deepestSphereContact(at(0, 2 * 2.9 + 0.5, 0), 0.3, contact)).toBe(false);
    expect(shell!.material).toBe("stone");
    expect(structureShellColliders(record({ foundation: "posts" }))[0]!.material).toBe("timber");
  });
});

describe("the car's colliders", () => {
  it("take a streamed region's buildings as one group, and drop them with it", () => {
    const world = createWorld();
    const colliders = new CarColliders(world, () => 0);
    const region: InfrastructureRegion = { key: "settlements:4:5", segments: [], structures: [record(), record({ id: 2, x: 1_260 })] };
    const before = colliders.colliders.size;
    expect(regionColliders(region, () => 0).every((collider) => collider.material === CAR_COLLIDER_MATERIAL.building)).toBe(true);
    colliders.applyRegions({ version: 1, reset: false, install: [region], remove: [] });
    expect(colliders.regionCount).toBe(1);
    expect(colliders.colliders.size).toBe(before + 2);
    colliders.applyRegions({ version: 2, reset: false, install: [], remove: [region.key] });
    expect(colliders.regionCount).toBe(0);
    expect(colliders.colliders.size).toBe(before);
  });

  it("lay out the kit's colliders for the buildings near the car, one a step, nearest first, and box them again behind it", () => {
    const world = createWorld();
    const colliders = new CarColliders(world, () => 0);
    const near = record();
    const next = record({ id: 2, x: near.x + 60, archetype: "barn", width: 14, depth: 10, storeys: 1 });
    const far = record({ id: 3, x: near.x + 2_000 });
    const region: InfrastructureRegion = { key: "settlements:4:5", segments: [], structures: [next, near, far] };
    const before = colliders.colliders.size;
    colliders.applyRegions({ version: 1, reset: false, install: [region], remove: [] });
    expect(colliders.colliders.size).toBe(before + 3);
    const kit = (building: StructureRecord) => STRUCTURE_KIT.layout(building).colliders.length;
    expect(kit(near)).toBeGreaterThan(20);

    // The car 20 m off the first building: it is laid out on this step, the barn on the next.
    const car = { x: near.x - 20, z: near.z };
    colliders.setFocus(car.x, car.z);
    expect(colliders.detailedBuildings).toBe(1);
    expect(colliders.colliders.size).toBe(before + kit(near) + 2);
    colliders.setFocus(car.x + 0.1, car.z);
    expect(colliders.detailedBuildings).toBe(2);
    expect(colliders.colliders.size).toBe(before + kit(near) + kit(next) + 1);
    // Nothing more to do: the far one stays a box.
    colliders.setFocus(car.x + 0.2, car.z);
    expect(colliders.detail.laidOut).toBe(2);

    // What is laid out is the kit's own, posed by the building frame: every one of its colliders is met where it stands.
    const contact: ColliderContact = {
      handle: -1, normal: { x: 0, y: 0, z: 0 }, penetration: 0, point: { x: 0, y: 0, z: 0 }, pointVelocity: { x: 0, y: 0, z: 0 }, material: 0,
    };
    for (const collider of STRUCTURE_KIT.layout(near).colliders) {
      const posed = poseStructureCollider(near, collider);
      const shape = posed.shape;
      const at = shape.kind === "box" ? shape.center : shape.kind === "capsule" ? shape.a : null;
      if (!at) throw new Error(`a kit collider of kind ${shape.kind}`);
      expect(colliders.colliders.deepestSphereContact(at, 0.01, contact)).toBe(true);
    }

    // Off to the side, both past the radius but inside the hysteresis: still laid out. Past it: boxes again.
    const side = Math.sqrt((CAR_STRUCTURE_DETAIL_METERS + 0.5 * CAR_STRUCTURE_DETAIL_HYSTERESIS_METERS) ** 2 - 30 ** 2);
    colliders.setFocus(near.x + 30, near.z + side);
    expect(colliders.detailedBuildings).toBe(2);
    colliders.setFocus(near.x + 30, near.z + side + CAR_STRUCTURE_DETAIL_HYSTERESIS_METERS);
    expect(colliders.detailedBuildings).toBe(0);
    expect(colliders.colliders.size).toBe(before + 3);

    // A region leaving takes its laid-out buildings with it.
    colliders.setFocus(car.x, car.z);
    expect(colliders.detailedBuildings).toBe(1);
    colliders.applyRegions({ version: 2, reset: false, install: [], remove: [region.key] });
    expect(colliders.colliders.size).toBe(before);
    expect(colliders.detailedBuildings).toBe(0);
  });
});
