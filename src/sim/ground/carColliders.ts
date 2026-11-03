import {
  AIRFIELD_GROUND_SAMPLE_STEP_METERS,
  FUEL_TANK_LENGTH_METERS,
  FUEL_TANK_RADIUS_METERS,
  FUEL_TANK_SADDLE_FRACTIONS,
  fuelTankPlacements,
  HANGAR_SITING,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarYawRadians,
  MINIMUM_SKIRT_METERS,
  TOWER_BASE_HEIGHT_METERS,
  TOWER_PLAN_RADIUS_METERS,
  towerPlanPosition,
} from "@/src/render/webgpu/airfield/AirfieldSiting";
import { runwayToWorld } from "@/src/world/airport";
import {
  installedInfrastructureRegions,
  type InfrastructureRail,
  type InfrastructureRegion,
} from "@/src/world/infrastructure";
import type { InfrastructureRegionsUpdate } from "@/src/world/infrastructureSync";
import { homeMarina } from "@/src/world/marina";
import type { AirportDefinition, WorldDefinition } from "@/src/world/types";
import { ColliderWorld, type ColliderShape } from "../colliders";
import { addMarinaColliders } from "../marina/colliders";
import type { Quaternion } from "../types";

/**
 * The colliders a car meets that are not terrain (land plan, "What the car
 * reads from the world"): every airport's hangars, tower and fuel tanks, the
 * home marina's structures, and what each streamed infrastructure region
 * adds (the roads' guardrails). One `ColliderWorld`, which the worker hands
 * the car as `SurfaceVehicleEnvironment.colliders`.
 *
 * Every building comes from the records the renderer draws from
 * (`AirfieldSiting`, `homeMarina`), so a hangar a car hits is the hangar on
 * screen. The hull alone meets them: the tyres roll on the terrain.
 */

/**
 * Material ids handed back with every contact, so the car's hull picks its
 * contact law (`groundVehicle.ts`): a building is rigid, a guardrail gives.
 * The marina's own ids (101 and up, `MARINA_COLLIDER_MATERIAL`) meet the
 * car as buildings.
 */
export const CAR_COLLIDER_MATERIAL = Object.freeze({
  building: 1,
  guardrail: 2,
});

/** Collider group of every airport's buildings; the marina's is `MARINA_COLLIDER_GROUP`. */
export const CAR_AIRPORT_COLLIDER_GROUP = 6_001;
/** Streamed regions take groups from here up, one each. */
const REGION_GROUP_BASE = 1_000_000;

/** Terrain height at a world point, metres; non-finite if the query failed. */
export type CarColliderGroundHeight = (x: number, z: number) => number;

export interface CarRegionCollider {
  readonly shape: ColliderShape;
  readonly material: number;
}

/**
 * A guardrail as the car meets it: one box per pair of points, from well
 * under the ground to well over the beam, its face on the rail's line facing
 * the road (`InfrastructureRail`'s n = (dz, -dx)) and `GUARDRAIL_DEPTH` deep
 * behind it, and at each bend an upright capsule behind the face that meets
 * the line there.
 *
 * Bigger than the 0.7 m beam on purpose. The hull's probes are points, and a
 * box pushes a point out through its nearest face: a beam-high box would
 * throw the bumper over its top once the bumper is 0.2 m in, and the rail is
 * meant to give about 0.5 m. So the top and the bottom are far, the back is
 * a metre behind the deepest the rail gives, and at a bend, where a box's end
 * face would be nearest, the capsule pushes out along the bend's own normal.
 * A real rail stops a car's body going over it all the same.
 */
export const GUARDRAIL_DEPTH = 2;
const GUARDRAIL_TOP = 3;
const GUARDRAIL_BELOW = 1.5;
/** Each box runs this far past its points, closing the seam on a straight run. */
const GUARDRAIL_OVERLAP = 0.3;

/** A rail's colliders, appended to `out`: see `GUARDRAIL_DEPTH`. Points without a finite ground are skipped. */
export function guardrailColliders(
  rail: Readonly<InfrastructureRail>,
  groundHeight: CarColliderGroundHeight,
  out: CarRegionCollider[] = [],
): CarRegionCollider[] {
  const points = rail.points;
  const top = Math.max(rail.heightMeters, GUARDRAIL_TOP);
  const half = GUARDRAIL_DEPTH * 0.5;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i]!;
    const az = points[i + 1]!;
    const bx = points[i + 2]!;
    const bz = points[i + 3]!;
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-6)) continue;
    const ga = groundHeight(ax, az);
    const gb = groundHeight(bx, bz);
    if (!Number.isFinite(ga) || !Number.isFinite(gb)) continue;
    // Box-local +z along the run, +x along n = (dz, -dx) / length: the face.
    const nx = dz / length;
    const nz = -dx / length;
    const rise = gb - ga;
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.atan2(rise, length);
    out.push({
      shape: {
        kind: "box",
        center: {
          x: (ax + bx) * 0.5 - nx * half,
          y: (ga + gb) * 0.5 + (top - GUARDRAIL_BELOW) * 0.5,
          z: (az + bz) * 0.5 - nz * half,
        },
        halfExtents: {
          x: half,
          y: (top + GUARDRAIL_BELOW) * 0.5,
          z: Math.hypot(length, rise) * 0.5 + GUARDRAIL_OVERLAP,
        },
        orientation: yawPitch(yaw, pitch),
      },
      material: CAR_COLLIDER_MATERIAL.guardrail,
    });
  }
  // The bends: the two runs' normals averaged, the capsule's axis half the depth behind the point.
  for (let i = 2; i + 3 < points.length; i += 2) {
    const px = points[i]!;
    const pz = points[i + 1]!;
    const inX = px - points[i - 2]!;
    const inZ = pz - points[i - 1]!;
    const outX = points[i + 2]! - px;
    const outZ = points[i + 3]! - pz;
    const inLength = Math.hypot(inX, inZ);
    const outLength = Math.hypot(outX, outZ);
    if (!(inLength > 1e-6) || !(outLength > 1e-6)) continue;
    let nx = inZ / inLength + outZ / outLength;
    let nz = -inX / inLength - outX / outLength;
    const length = Math.hypot(nx, nz);
    if (!(length > 1e-6)) continue;
    nx /= length;
    nz /= length;
    const g = groundHeight(px, pz);
    if (!Number.isFinite(g)) continue;
    const ax = px - nx * half;
    const az = pz - nz * half;
    out.push({
      shape: {
        kind: "capsule",
        a: { x: ax, y: g - GUARDRAIL_BELOW + half, z: az },
        b: { x: ax, y: g + top - half, z: az },
        radius: half,
      },
      material: CAR_COLLIDER_MATERIAL.guardrail,
    });
  }
  return out;
}

/** A streamed region's colliders for the car: its guardrails. */
export function regionColliders(
  region: Readonly<InfrastructureRegion>,
  groundHeight: CarColliderGroundHeight,
): readonly CarRegionCollider[] {
  const rails = region.rails;
  if (!rails || rails.length === 0) return [];
  const out: CarRegionCollider[] = [];
  for (const rail of rails) guardrailColliders(rail, groundHeight, out);
  return out;
}

/**
 * The car's collider world. Built when the worker installs a car; the
 * airports' buildings are rebuilt when the airport list changes
 * (`setAirports`), and the regions follow the infrastructure updates the
 * worker applies (`applyRegions`).
 */
export class CarColliders {
  readonly colliders = new ColliderWorld();
  private airports: readonly Readonly<AirportDefinition>[] | null = null;
  private readonly regionGroups = new Map<string, number>();
  private nextRegionGroup = REGION_GROUP_BASE;

  constructor(world: WorldDefinition, private readonly groundHeight: CarColliderGroundHeight) {
    addMarinaColliders(this.colliders, homeMarina(world));
    this.setAirports(world);
    for (const region of installedInfrastructureRegions(world)) {
      this.setRegion(region.key, regionColliders(region, groundHeight));
    }
  }

  /** Every airport's hangars, tower and fuel tanks, rebuilt only when the list itself changes. */
  setAirports(world: WorldDefinition): void {
    if (world.airports === this.airports) return;
    this.airports = world.airports;
    this.colliders.removeGroup(CAR_AIRPORT_COLLIDER_GROUP);
    for (const airport of world.airports) {
      addAirportColliders(this.colliders, airport, world.seedHash, this.groundHeight);
    }
  }

  /** The worker's infrastructure update, applied to the regions' colliders. */
  applyRegions(update: Readonly<InfrastructureRegionsUpdate>): void {
    if (update.reset) {
      for (const group of this.regionGroups.values()) this.colliders.removeGroup(group);
      this.regionGroups.clear();
    }
    for (const key of update.remove) this.removeRegion(key);
    for (const region of update.install) this.setRegion(region.key, regionColliders(region, this.groundHeight));
  }

  /** Replace a region's colliders. */
  setRegion(key: string, colliders: readonly CarRegionCollider[]): void {
    this.removeRegion(key);
    if (colliders.length === 0) return;
    const group = this.nextRegionGroup;
    this.nextRegionGroup += 1;
    for (const collider of colliders) {
      this.colliders.addStatic(collider.shape, { material: collider.material, group });
    }
    this.regionGroups.set(key, group);
  }

  removeRegion(key: string): void {
    const group = this.regionGroups.get(key);
    if (group === undefined) return;
    this.colliders.removeGroup(group);
    this.regionGroups.delete(key);
  }

  /** How many regions have colliders (for tests). */
  get regionCount(): number {
    return this.regionGroups.size;
  }
}

/**
 * One airport's buildings: each hangar a box to its eaves (a car meets the
 * walls), the tower's base a vertical capsule of its plan radius, and each
 * fuel tank a horizontal capsule on two upright ones for its saddles.
 */
export function addAirportColliders(
  colliders: ColliderWorld,
  airport: Readonly<AirportDefinition>,
  seedHash: number,
  groundHeight: CarColliderGroundHeight,
  group: number = CAR_AIRPORT_COLLIDER_GROUP,
): void {
  const material = CAR_COLLIDER_MATERIAL.building;
  const ground = (along: number, across: number): number => {
    const at = runwayToWorld(airport, along, across);
    const height = groundHeight(at.x, at.z);
    return Number.isFinite(height) ? height : airport.elevation;
  };

  for (let index = 0; index < HANGAR_SITING.count; index += 1) {
    const footprint = hangarFootprint(airport, index);
    // The renderer's seating (`hangarSite`): the slab on the highest ground
    // under the footprint, the skirt down to the lowest, from the same samples.
    let low = Infinity;
    let high = -Infinity;
    for (const local of hangarFootprintSamples(footprint, AIRFIELD_GROUND_SAMPLE_STEP_METERS)) {
      const at = runwayToWorld(airport, local.along, local.across);
      const height = groundHeight(at.x, at.z);
      if (!Number.isFinite(height)) continue;
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    if (!(high >= low)) {
      low = airport.elevation;
      high = airport.elevation;
    }
    const plan = hangarPlanFrom(seedHash, index, Math.max(high - low, MINIMUM_SKIRT_METERS));
    const bottom = low - 1;
    const top = high + plan.eaveHeightMeters;
    const centre = runwayToWorld(airport, footprint.along, footprint.across);
    colliders.addStatic(
      {
        kind: "box",
        center: { x: 0, y: 0, z: 0 },
        // Box-local x across the runway (the plan's width), z along it (its depth).
        halfExtents: { x: plan.widthMeters / 2, y: (top - bottom) / 2, z: plan.depthMeters / 2 },
      },
      {
        material,
        group,
        position: { x: centre.x, y: (top + bottom) / 2, z: centre.z },
        orientation: yawPitch(airport.headingRadians + hangarYawRadians(seedHash, index), 0),
      },
    );
  }

  const tower = towerPlanPosition(airport);
  const towerAt = runwayToWorld(airport, tower.along, tower.across);
  const towerGround = ground(tower.along, tower.across);
  colliders.addStatic(
    {
      kind: "capsule",
      a: { x: towerAt.x, y: towerGround - TOWER_PLAN_RADIUS_METERS, z: towerAt.z },
      b: { x: towerAt.x, y: towerGround + TOWER_BASE_HEIGHT_METERS, z: towerAt.z },
      radius: TOWER_PLAN_RADIUS_METERS,
    },
    { material, group },
  );

  const radius = FUEL_TANK_RADIUS_METERS;
  for (const tank of fuelTankPlacements()) {
    const base = ground(tank.along, tank.across);
    // On its saddles 0.6 R up, as `buildFuelFarmGeometry` lays it.
    const axle = base + radius * 0.6 + radius;
    const half = FUEL_TANK_LENGTH_METERS / 2 - radius;
    const a = runwayToWorld(airport, tank.along - half, tank.across);
    const b = runwayToWorld(airport, tank.along + half, tank.across);
    colliders.addStatic(
      { kind: "capsule", a: { x: a.x, y: axle, z: a.z }, b: { x: b.x, y: axle, z: b.z }, radius },
      { material, group },
    );
    for (const fraction of FUEL_TANK_SADDLE_FRACTIONS) {
      const at = runwayToWorld(airport, tank.along - FUEL_TANK_LENGTH_METERS / 2 + FUEL_TANK_LENGTH_METERS * fraction, tank.across);
      colliders.addStatic(
        {
          kind: "capsule",
          a: { x: at.x, y: base - radius, z: at.z },
          b: { x: at.x, y: base + radius * 0.6, z: at.z },
          radius: radius * 0.75,
        },
        { material, group },
      );
    }
  }
}

/**
 * A turn about +Y by `yaw` (box-local +z to (sin yaw, 0, cos yaw), the
 * runway frame's along axis at the airport's heading), then a pitch about
 * box-local +X that tips the +z end down by `pitch`.
 */
function yawPitch(yaw: number, pitch: number): Quaternion {
  const sy = Math.sin(yaw * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cp = Math.cos(pitch * 0.5);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}
