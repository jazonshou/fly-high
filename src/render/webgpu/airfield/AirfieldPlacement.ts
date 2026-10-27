import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { runwayToWorld, type AirportDefinition } from "@/src/world";
import { runwayPlatformHeight } from "../terrain/RunwayEarthworks";
import {
  fuelTankPlacements,
  perimeterFenceStations,
  signPlacements,
  WINDSOCK_LATERAL_OFFSET_METERS,
  windsockAxisDirectionToRef,
  windsockBoreScale,
  windsockDroopRadians,
  windsockInflation,
} from "../detail/AirfieldFurniture";
import type { TowerAttachments, TowerGeometry, TowerPartName } from "../detail/towerGeometry";
import { towerPlanPosition } from "./AirfieldSiting";
import {
  HANGAR_SITING,
  MINIMUM_SKIRT_METERS,
  hangarAttachments,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarSeatingFrom,
  hangarYawRadians,
  type HangarAttachments,
  type HangarPlan,
} from "./AirfieldStructures";

/**
 * Where an airfield's structures stand, as pure functions of the airport, the
 * siting seed and the ground — shared by the home field's `AirportSystem` and
 * by every airport spawned mid-flight, so a spawned field cannot drift from the
 * home field's layout through a second copy of the arithmetic.
 *
 * Every placement is in the airport ROOT's frame — runway-local, `[across, y,
 * along]` with `y` measured from the airport datum (`airport.elevation`) —
 * because that is the frame the root node supplies heading and elevation to.
 */

/**
 * Ground-sample spacing under a hangar footprint.
 *
 * 2 m over 46 x 34 m is 408 samples per hangar. That is the resolution the
 * relief figures behind `7-10`'s seating rule were measured at, so the rule and
 * the bridge agree about what "the ground under it" means.
 */
export const AIRFIELD_GROUND_SAMPLE_STEP_METERS = 2;

/** World-space ground query: terrain height at (x, z), or non-finite on failure. */
export type AirfieldGroundHeight = (x: number, z: number) => number;

/** One hangar, seated on the ground under its footprint. */
export interface HangarSite {
  readonly index: number;
  readonly plan: HangarPlan;
  readonly attachments: HangarAttachments;
  /** The hangar node's position in the root frame: `[across, y, along]`. */
  readonly position: readonly [number, number, number];
  readonly yawRadians: number;
}

/**
 * Seat hangar `index` on the ground under its WHOLE footprint.
 *
 * THE FOOTPRINT, NOT A CENTRE SAMPLE. A 46 x 34 m box on the earthworks batter
 * sits over 2.86-5.52 m of relief; seating on one point buried a corner by up
 * to 2.70 m and floated another by up to 2.85 m.
 */
export function hangarSite(
  definition: Readonly<AirportDefinition>,
  index: number,
  seedHash: number,
  groundHeight: AirfieldGroundHeight,
): HangarSite {
  const footprint = hangarFootprint(definition, index);
  const ground: number[] = [];
  for (const local of hangarFootprintSamples(footprint, AIRFIELD_GROUND_SAMPLE_STEP_METERS)) {
    const world = runwayToWorld(definition, local.along, local.across);
    const height = groundHeight(world.x, world.z);
    // Non-finite means the terrain query failed for that sample. Dropping it
    // is deliberate: `hangarSeatingFrom` THROWS on a non-finite input, which is
    // right for a pure function and wrong here, where it would stop the flight
    // from starting over one bad sample.
    if (Number.isFinite(height)) ground.push(height);
  }
  // If EVERY sample failed there is no ground to stand on, so fall back to the
  // datum — the pre-7-10 behaviour. Recorded rather than silent, because a
  // hangar at the datum on fallen ground looks like a modelling bug rather than
  // a failed query.
  const seating = ground.length > 0
    ? hangarSeatingFrom(ground)
    : { baseAltitudeMeters: definition.elevation, skirtHeightMeters: MINIMUM_SKIRT_METERS, reliefMeters: 0 };
  const plan = hangarPlanFrom(seedHash, index, seating.skirtHeightMeters);
  const attachments = hangarAttachments(definition, index, plan, seating.baseAltitudeMeters);
  return {
    index,
    plan,
    attachments,
    // `root` sits at the datum, so a child's local y is measured from it.
    position: [
      footprint.across,
      seating.baseAltitudeMeters - definition.elevation,
      footprint.along,
    ],
    // Set out by eye, not by instancing: a node rotation, so it costs nothing
    // in the draw budget or the vertex count.
    yawRadians: hangarYawRadians(seedHash, index),
  };
}

/** The tower node's placement and its attachment points, both in the root frame. */
export interface TowerSite {
  readonly position: readonly [number, number, number];
  /**
   * Attachment points with the tower's placement folded in — still
   * runway-local; `root` supplies heading and elevation.
   */
  readonly attachments: TowerAttachments;
}

/**
 * The tower stands on the hangar side, nearer the runway than the hangars
 * (+95 m against their +118) and offset along it, so on final approach it
 * reads as a separate structure at a different range rather than a fourth
 * hangar.
 */
export function towerSite(
  definition: Readonly<AirportDefinition>,
  tower: TowerGeometry,
  groundHeight: AirfieldGroundHeight,
): TowerSite {
  const { along: towerAlong, across: towerAcross } = towerPlanPosition(definition);
  const towerWorld = runwayToWorld(definition, towerAlong, towerAcross);
  const towerGround = groundHeight(towerWorld.x, towerWorld.z);
  // Same rule as the hangars: the root sits at the datum, so the tower's local
  // y is however far the ground has fallen from it. The earthworks batter is
  // 118 m across the centreline and the tower stands inside that, so this is
  // not a formality.
  const towerSit = Number.isFinite(towerGround) ? towerGround - definition.elevation : 0;
  const offset = (p: readonly [number, number, number]): readonly [number, number, number] =>
    [p[0] + towerAcross, p[1] + towerSit, p[2] + towerAlong];
  return {
    position: [towerAcross, towerSit, towerAlong],
    attachments: Object.freeze({
      beaconMount: offset(tower.attachments.beaconMount),
      mastTip: offset(tower.attachments.mastTip),
      cabRoofRing: Object.freeze(tower.attachments.cabRoofRing.map(offset)),
      heightMeters: tower.attachments.heightMeters,
    }),
  };
}

/**
 * `7-11` third pass: ALL SEVEN TOWER PARTS ARE ON THE SHARED SET, by surface.
 * Concrete is textured; steel and glass are not corrugated.
 */
export const TOWER_PART_SURFACES: Readonly<Record<TowerPartName, "concrete" | "steel" | "glass">> =
  Object.freeze({
    base: "concrete",
    shaft: "concrete",
    gallery: "concrete",
    railing: "steel",
    cab: "glass",
    cabRoof: "steel",
    mast: "steel",
  });

/** The windsock node's position in the root frame: on the platform, not the batter. */
export function windsockNodePosition(
  definition: Readonly<AirportDefinition>,
): readonly [number, number, number] {
  return [
    WINDSOCK_LATERAL_OFFSET_METERS,
    runwayPlatformHeight(definition, WINDSOCK_LATERAL_OFFSET_METERS) - definition.elevation,
    0,
  ];
}

/**
 * Every WORLD point an airfield's structures read the ground at, in the order
 * the builders read them: hangar footprints, the tower, fence stations, fuel
 * tanks, signs. Interleaved `[x0, z0, x1, z1, ...]`, computed with the same
 * `runwayToWorld` calls the builders make, so a cache filled from this list
 * answers their queries bit for bit.
 */
export function airfieldGroundPoints(definition: Readonly<AirportDefinition>): Float64Array {
  const points: number[] = [];
  const push = (along: number, across: number): void => {
    const world = runwayToWorld(definition, along, across);
    points.push(world.x, world.z);
  };
  for (let index = 0; index < HANGAR_SITING.count; index += 1) {
    const footprint = hangarFootprint(definition, index);
    for (const local of hangarFootprintSamples(footprint, AIRFIELD_GROUND_SAMPLE_STEP_METERS)) {
      push(local.along, local.across);
    }
  }
  const tower = towerPlanPosition(definition);
  push(tower.along, tower.across);
  for (const station of perimeterFenceStations(definition)) push(station.along, station.across);
  for (const tank of fuelTankPlacements()) push(tank.along, tank.across);
  for (const sign of signPlacements(definition)) push(sign.along, sign.across);
  return new Float64Array(points);
}

/**
 * The sock's scale along its length, a hair over 1 so the sock is never
 * uniformly scaled at any bore. Babylon keys `NONUNIFORMSCALING` on a mesh's
 * scaling, so a sock reaching full bore, or a spawned field's sock at another
 * bore than the home field's, would otherwise draw with a second shader
 * variant, compiled mid-flight. 0.4 mm on the 3.6 m sock. Builders give a new
 * sock this scale before its first pose.
 */
export const WINDSOCK_LENGTH_SCALE = 1.0001;

/**
 * Point and inflate a windsock's sock mesh.
 *
 * `windHeadingRadians` is world-referenced. Children of an airport root are
 * runway-local, and the root carries `rotation.y = headingRadians`, so the
 * local direction is the axis at the DIFFERENCE of the two headings — no
 * inverse rotation, and no chance of applying one the wrong way round.
 *
 * Droop and inflation are BOTH functions of speed, so the caller passes speed
 * and this derives them: separate arguments would let a caller pass a droop
 * that disagreed with its inflation. `scratch` is written and never kept, so a
 * per-frame caller allocates nothing.
 */
export function poseWindsock(
  sock: Mesh,
  runwayHeadingRadians: number,
  windHeadingRadians: number,
  windSpeedMetersPerSecond: number,
  scratch: Vector3,
): void {
  const droopRadians = windsockDroopRadians(windSpeedMetersPerSecond);
  const inflation = windsockInflation(windSpeedMetersPerSecond);
  windsockAxisDirectionToRef(windHeadingRadians - runwayHeadingRadians, droopRadians, scratch);
  // The mesh is built along +y, so the rotation is +y onto the axis.
  Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, scratch, sock.rotationQuaternion!);
  const bore = windsockBoreScale(inflation);
  sock.scaling.set(bore, WINDSOCK_LENGTH_SCALE, bore);
}
