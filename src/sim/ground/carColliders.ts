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
import { STRUCTURE_KIT } from "@/src/world/structures/kit/structureKit";
import type { StructureCollider } from "@/src/world/structures/structureModel";
import type { StructureRecord } from "@/src/world/structures/structureRecord";
import { buildStructureColliders, poseStructureCollider, structureShellColliders } from "../structures/colliders";
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

/**
 * Within this of the car, horizontally to its centre, a building's shell box
 * gives way to every collider the kit lays out (`STRUCTURE_KIT.layout`):
 * porch, steps, fences, a mast's legs. Further off the box stands in, so a
 * streamed region costs one collider a building, not a hundred.
 */
export const CAR_STRUCTURE_DETAIL_METERS = 120;
/** And back to the box once this much further. */
export const CAR_STRUCTURE_DETAIL_HYSTERESIS_METERS = 30;
/** Buildings laid out per `setFocus` (a sim step): the kit's layout is about a millisecond each. */
export const CAR_STRUCTURE_DETAIL_PER_STEP = 1;
/** A car this far from the last sweep looks at the buildings again, metres. */
const FOCUS_RESWEEP_METERS = 5;

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
/** How far under the ground a guardrail's box reaches, m (the walker finds the ground in the box by it). */
export const GUARDRAIL_BELOW = 1.5;
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

/**
 * A streamed region's colliders for the car: its guardrails, and its
 * buildings (`buildStructureColliders`), whose fences give like a guardrail.
 */
export function regionColliders(
  region: Readonly<InfrastructureRegion>,
  groundHeight: CarColliderGroundHeight,
): readonly CarRegionCollider[] {
  const rails = region.rails;
  const structures = region.structures;
  if ((!rails || rails.length === 0) && (!structures || structures.length === 0)) return [];
  const out: CarRegionCollider[] = [];
  if (rails) for (const rail of rails) guardrailColliders(rail, groundHeight, out);
  if (structures) {
    for (const collider of buildStructureColliders(structures)) {
      out.push({ shape: collider.shape, material: carStructureMaterial(collider.material) });
    }
  }
  return out;
}

/** A building's fences give like a guardrail; everything else is rigid. */
function carStructureMaterial(material: string): number {
  return material === "fence" ? CAR_COLLIDER_MATERIAL.guardrail : CAR_COLLIDER_MATERIAL.building;
}

/** One building of a region as the car meets it: its shell box, or the kit's colliders near the car. */
interface CarBuilding {
  readonly record: StructureRecord;
  /** The handles standing for it now: the shell box's, or the kit's colliders'. */
  handles: number[];
  detailed: boolean;
}

interface CarRegion {
  readonly group: number;
  readonly buildings: CarBuilding[];
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
  private readonly regions = new Map<string, CarRegion>();
  private nextRegionGroup = REGION_GROUP_BASE;
  private focusX = Number.NaN;
  private focusZ = Number.NaN;
  /** Where the buildings were last swept from, and whether that sweep left any to lay out. */
  private sweptX = Number.NaN;
  private sweptZ = Number.NaN;
  private sweepPending = true;
  /** Buildings laid out by the kit for the car so far, and put back to their box (for tests and probes). */
  readonly detail = { laidOut: 0, restored: 0 };

  constructor(world: WorldDefinition, private readonly groundHeight: CarColliderGroundHeight) {
    addMarinaColliders(this.colliders, homeMarina(world));
    this.setAirports(world);
    for (const region of installedInfrastructureRegions(world)) this.installRegion(region);
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
      for (const region of this.regions.values()) this.colliders.removeGroup(region.group);
      this.regions.clear();
    }
    for (const key of update.remove) this.removeRegion(key);
    for (const region of update.install) this.installRegion(region);
  }

  /**
   * Where the car is, once a sim step: buildings within
   * `CAR_STRUCTURE_DETAIL_METERS` are laid out by the kit, at most
   * `CAR_STRUCTURE_DETAIL_PER_STEP` a call, nearest first; those past the
   * hysteresis go back to their box.
   */
  setFocus(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    // Nothing changes for a car that has moved less than this since a sweep that left nothing to do.
    if (!this.sweepPending && Math.hypot(x - this.sweptX, z - this.sweptZ) < FOCUS_RESWEEP_METERS) return;
    this.sweptX = x;
    this.sweptZ = z;
    this.sweepPending = false;
    const near = CAR_STRUCTURE_DETAIL_METERS;
    const far = CAR_STRUCTURE_DETAIL_METERS + CAR_STRUCTURE_DETAIL_HYSTERESIS_METERS;
    let budget = CAR_STRUCTURE_DETAIL_PER_STEP;
    // Few buildings stream at once (tens a region): a plain sweep, cheaper than any index.
    while (budget > 0) {
      let best: { region: CarRegion; building: CarBuilding } | null = null;
      let bestDistance = near;
      for (const region of this.regions.values()) {
        for (const building of region.buildings) {
          const distance = Math.hypot(building.record.x - x, building.record.z - z);
          if (building.detailed) {
            if (distance > far) this.restore(region, building);
          } else if (distance <= bestDistance) {
            best = { region, building };
            bestDistance = distance;
          }
        }
      }
      if (!best) return;
      this.layOut(best.region, best.building);
      budget -= 1;
    }
    // The budget ran out: sweep again next step, however little the car moves.
    this.sweepPending = true;
  }

  /** Replace a region's colliders (no buildings of its own: what `regionColliders` gives, as one group). */
  setRegion(key: string, colliders: readonly CarRegionCollider[]): void {
    this.removeRegion(key);
    if (colliders.length === 0) return;
    const group = this.nextRegionGroup;
    this.nextRegionGroup += 1;
    for (const collider of colliders) {
      this.colliders.addStatic(collider.shape, { material: collider.material, group });
    }
    this.regions.set(key, { group, buildings: [] });
  }

  removeRegion(key: string): void {
    const region = this.regions.get(key);
    if (region === undefined) return;
    this.colliders.removeGroup(region.group);
    this.regions.delete(key);
  }

  /** How many regions have colliders (for tests). */
  get regionCount(): number {
    return this.regions.size;
  }

  /** How many buildings stand as the kit's colliders now (for tests and probes). */
  get detailedBuildings(): number {
    let count = 0;
    for (const region of this.regions.values()) for (const building of region.buildings) if (building.detailed) count += 1;
    return count;
  }

  /** A streamed region: its guardrails, and each building as its shell box until the car comes near. */
  private installRegion(region: Readonly<InfrastructureRegion>): void {
    this.removeRegion(region.key);
    const rails = regionColliders({ ...region, structures: [] }, this.groundHeight);
    const records = region.structures ?? [];
    if (rails.length === 0 && records.length === 0) return;
    const group = this.nextRegionGroup;
    this.nextRegionGroup += 1;
    for (const collider of rails) this.colliders.addStatic(collider.shape, { material: collider.material, group });
    const state: CarRegion = { group, buildings: [] };
    for (const record of records) {
      const building: CarBuilding = { record, handles: [], detailed: false };
      this.addColliders(state, building, structureShellColliders(record));
      state.buildings.push(building);
    }
    this.regions.set(region.key, state);
    this.sweepPending = true;
  }

  private layOut(region: CarRegion, building: CarBuilding): void {
    this.removeHandles(building);
    this.addColliders(region, building, STRUCTURE_KIT.layout(building.record).colliders);
    building.detailed = true;
    this.detail.laidOut += 1;
  }

  private restore(region: CarRegion, building: CarBuilding): void {
    this.removeHandles(building);
    this.addColliders(region, building, structureShellColliders(building.record));
    building.detailed = false;
    this.detail.restored += 1;
  }

  private addColliders(region: CarRegion, building: CarBuilding, colliders: readonly StructureCollider[]): void {
    for (const collider of colliders) {
      const posed = poseStructureCollider(building.record, collider);
      building.handles.push(this.colliders.addStatic(posed.shape, { material: carStructureMaterial(posed.material), group: region.group }));
    }
  }

  private removeHandles(building: CarBuilding): void {
    for (const handle of building.handles) this.colliders.remove(handle);
    building.handles = [];
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
