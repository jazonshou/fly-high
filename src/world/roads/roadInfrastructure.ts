import type { InfrastructureRegion, InfrastructureSegment } from "../infrastructure";
import { INFRASTRUCTURE_PROFILE } from "../infrastructureProfiles";
import { roadBatterTarget, roadCrossOffset } from "../roadEarthworkProfiles";
import type { WorldDefinition } from "../types";
import { roadClass, roadFormationHalfWidth, ROAD_PRIORITY, type RoadClassSpec } from "./roadClasses";
import {
  ROAD_PAD_APRON_METERS,
  ROAD_PAD_APRON_SLOPE,
  type RoadLayer,
  type RoadNetwork,
  type RoadPad,
  type RoadPiece,
  type RoadRegion,
} from "./roadNetwork";
import { roadRegionRails } from "./roadRails";
import { roadGroundHeight } from "./roadTerrain";

/**
 * The roads as the infrastructure stage takes them: one streamed region per
 * network region, a `carriageway` segment per piece and a `junctionPad` per
 * pad (`roadEarthworkProfiles.ts`), and the region's guardrails
 * (`roadRegionRails`), which the stage carries for the renderer and the car.
 *
 * Every segment's `reach` is sized to where its batters meet the ground,
 * walked out from the formation edge on the ground before the stage, so a
 * road on easy ground clears and grades a few metres either side and only a
 * deep fill or cut reaches far (the class's `reach` caps it). That keeps the
 * plants (cleared to reach + `plantClearance`) on the hillside, and the
 * stage's per-sample work small.
 */

/** A region's key in the stage's registry: a pure function of its content. */
export function roadRegionKey(layer: RoadLayer, rx: number, rz: number): string {
  return `roads:${layer}:${rx}:${rz}`;
}

/** Order keys: a piece's is its edge id x 2^20 + its index along the edge; a pad's, its node id. */
export const ROAD_PIECE_KEY_STRIDE = 2 ** 20;

export function roadPieceKey(piece: RoadPiece): number {
  return (piece.edgeId >>> 0) * ROAD_PIECE_KEY_STRIDE + piece.index;
}

/** The pads' apron (the network grades the roads meeting a pad past it). */
export { ROAD_PAD_APRON_METERS, ROAD_PAD_APRON_SLOPE };

/** The batters' walk: step, and the least reach a segment takes, metres. */
const BATTER_STEP_METERS = 1.5;
const MIN_REACH_METERS = 3;
/** A piece's batters are walked at its ends and at least this often along it, metres. */
const BATTER_STATION_SPACING = 12;
/** A pad's, in this many directions round its edge. */
const PAD_DIRECTIONS = 8;

export function roadRegionInfrastructure(network: RoadNetwork, region: RoadRegion): InfrastructureRegion {
  const world = network.world;
  const segments: InfrastructureSegment[] = [];
  for (const piece of region.pieces) segments.push(pieceSegment(world, piece));
  for (const patch of region.patches) segments.push(patchSegment(world, patch));
  for (const pad of region.pads) segments.push(padSegment(world, pad));
  const rails = roadRegionRails(network, region);
  return Object.freeze({
    key: roadRegionKey(region.layer, region.rx, region.rz),
    segments: Object.freeze(segments),
    ...(rails.length > 0 ? { rails } : {}),
  });
}

function pieceSegment(world: WorldDefinition, piece: RoadPiece): InfrastructureSegment {
  const spec = roadClass(piece.classId);
  const half = roadFormationHalfWidth(spec);
  const dx = piece.bx - piece.ax;
  const dz = piece.bz - piece.az;
  const length = Math.hypot(dx, dz);
  const dirX = length > 0 ? dx / length : 1;
  const dirZ = length > 0 ? dz / length : 0;
  const stations = Math.max(1, Math.ceil(length / BATTER_STATION_SPACING));
  let meets = 0;
  for (let k = 0; k <= stations; k += 1) {
    const t = k / stations;
    const cx = piece.ax + dx * t;
    const cz = piece.az + dz * t;
    const centre = piece.ha + (piece.hb - piece.ha) * t;
    const c = piece.ca + (piece.cb - piece.ca) * t;
    const crossfall = piece.ka + (piece.kb - piece.ka) * t;
    for (const side of [1, -1]) {
      // Right of a->b: (dirZ, -dirX), as the stage's `across`.
      const outX = side * dirZ;
      const outZ = -side * dirX;
      const edge = centre + roadCrossOffset(side * half, c, crossfall);
      meets = Math.max(meets, batterMeets(world, cx + outX * half, cz + outZ * half, outX, outZ, edge, spec));
    }
  }
  return Object.freeze({
    profile: INFRASTRUCTURE_PROFILE.carriageway,
    mode: "set",
    priority: spec.priority,
    ax: piece.ax,
    az: piece.az,
    bx: piece.bx,
    bz: piece.bz,
    halfWidth: half,
    reach: reachFor(meets, spec),
    params: Object.freeze([
      piece.ha - world.seaLevel,
      piece.hb - world.seaLevel,
      piece.ca,
      piece.cb,
      piece.ka,
      spec.ditchDepth,
      spec.ditchWidth,
      piece.kb - piece.ka,
    ]),
    surface: spec.surface,
    plantClearance: spec.plantClearance,
    key: roadPieceKey(piece),
  });
}

/** A patch's batters reach this far, into the ditch it fills beside the road, metres. */
const PATCH_REACH_METERS = 2;

/**
 * A crossing patch (`RoadGeometry.patches`): part of one of the road's own
 * pieces laid again over an outranking road's formation edge and ditch,
 * after every road, with no ditch and no paint of its own (the road's pieces
 * painted it). Its short batters run a shoulder down into the ditch beside
 * the road.
 */
function patchSegment(world: WorldDefinition, patch: RoadPiece): InfrastructureSegment {
  const spec = roadClass(patch.classId);
  return Object.freeze({
    profile: INFRASTRUCTURE_PROFILE.carriageway,
    mode: "set",
    priority: ROAD_PRIORITY.crossing,
    ax: patch.ax,
    az: patch.az,
    bx: patch.bx,
    bz: patch.bz,
    halfWidth: roadFormationHalfWidth(spec),
    reach: PATCH_REACH_METERS,
    params: Object.freeze([
      patch.ha - world.seaLevel,
      patch.hb - world.seaLevel,
      patch.ca,
      patch.cb,
      patch.ka,
      0,
      0,
      patch.kb - patch.ka,
    ]),
    plantClearance: spec.plantClearance,
    key: roadPieceKey(patch),
  });
}

function padSegment(world: WorldDefinition, pad: RoadPad): InfrastructureSegment {
  const spec = roadClass(pad.classId);
  const half = pad.radius + ROAD_PAD_APRON_METERS;
  const allowance = ROAD_PAD_APRON_SLOPE * ROAD_PAD_APRON_METERS;
  let meets = 0;
  for (let k = 0; k < PAD_DIRECTIONS; k += 1) {
    const angle = (2 * Math.PI * k) / PAD_DIRECTIONS;
    const outX = Math.sin(angle);
    const outZ = Math.cos(angle);
    const x = pad.x + outX * half;
    const z = pad.z + outZ * half;
    // The edge stands where the apron's allowance leaves it over the ground there.
    const ground = roadGroundHeight(world, x, z);
    const plane = pad.height + pad.gradientX * (x - pad.x) + pad.gradientZ * (z - pad.z);
    const edge = plane + Math.min(allowance, Math.max(-allowance, ground - plane));
    meets = Math.max(meets, batterMeets(world, x, z, outX, outZ, edge, { ditchDepth: 0, ditchWidth: 0, reach: spec.reach }));
  }
  return Object.freeze({
    profile: INFRASTRUCTURE_PROFILE.junctionPad,
    mode: "set",
    priority: ROAD_PRIORITY.junction,
    ax: pad.x,
    az: pad.z,
    bx: pad.x,
    bz: pad.z,
    halfWidth: half,
    reach: reachFor(meets, spec),
    // A disc's frame: along +x, right -z.
    params: Object.freeze([pad.height - world.seaLevel, pad.radius, ROAD_PAD_APRON_SLOPE, pad.gradientX, -pad.gradientZ]),
    surface: spec.surface,
    plantClearance: spec.plantClearance,
    key: pad.nodeId >>> 0,
  });
}

/**
 * How far out from the formation edge (x, z), heading (outX, outZ), the
 * batter from `edge` first meets the ground, to the step; the class's reach
 * where it never does.
 */
function batterMeets(
  world: WorldDefinition,
  x: number,
  z: number,
  outX: number,
  outZ: number,
  edge: number,
  spec: Pick<RoadClassSpec, "ditchDepth" | "ditchWidth" | "reach">,
): number {
  for (let beyond = BATTER_STEP_METERS; beyond <= spec.reach; beyond += BATTER_STEP_METERS) {
    const ground = roadGroundHeight(world, x + outX * beyond, z + outZ * beyond);
    if (roadBatterTarget(edge, beyond, ground, spec.ditchDepth, spec.ditchWidth) === ground) return beyond;
  }
  return spec.reach;
}

/** Reach for batters that meet the ground `meets` metres out: full weight to there (the fade starts at 70%). */
function reachFor(meets: number, spec: RoadClassSpec): number {
  return Math.min(spec.reach, Math.max(MIN_REACH_METERS, meets / 0.7 + BATTER_STEP_METERS));
}
