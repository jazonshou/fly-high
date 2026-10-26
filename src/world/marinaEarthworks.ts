import type { InfrastructureLayout, InfrastructureSegment } from "./infrastructure";
import { INFRASTRUCTURE_PROFILE } from "./infrastructureProfiles";
import { homeMarina } from "./marina";
import { MARINA_LAYOUT, marinaToWorld, worldToMarina, type MarinaLayout } from "./marinaLayout";
import type { WorldDefinition } from "./types";

/**
 * The home marina's earthworks, as an infrastructure source
 * (`INFRASTRUCTURE_SOURCES`): every segment is laid out from
 * `homeMarina(world)`, the same records the colliders and the renderer use,
 * so the quay the boat sees is the ground the car drives onto.
 *
 * In composition order:
 *   10 dredgedBasin  the berths, fairway and mouth, and a channel out to open
 *                    water, cut to `MARINA_LAYOUT.basinDepth` (water only)
 *   15 breakwater    the rubble mound, filled on the dredged bed
 *   20 quay apron    level at the quay deck, its front a near-vertical quay
 *                    cut hidden in the quay wall (`quayCut`)
 *   21 accessApron   the car park, graded up inland to the road anchor
 *   22 shed pad      the boat shed's floor
 *   30 slipway       1:8 from the apron to its toe, over everything before it
 *
 * The anchor `marinaCarPark` (the back of the car park, heading inland) is
 * where a road or a car joins the marina.
 */

/** Composition priorities: the infrastructure stage applies lower first. */
export const MARINA_EARTHWORK_PRIORITY = Object.freeze({
  dredge: 10,
  breakwater: 15,
  quay: 20,
  carPark: 21,
  shed: 22,
  slipway: 30,
});

export const MARINA_EARTHWORKS = Object.freeze({
  /** Dredge batter, run per metre of rise, and the shore band it fades out over (metres above sea). */
  dredgeRun: 4,
  dredgeShoreFrom: 1,
  dredgeShoreTo: 2,
  /** Channel from the basin out to the lane's end: half width, metres, and its shore band, which cuts through low bars and spits. */
  channelHalfWidth: 12,
  channelShoreFrom: 2,
  channelShoreTo: 3,
  /** The quay apron's front edge sits inside the quay wall, this far behind the waterline. */
  quayFrontOut: -0.75,
  /** Quay face batter: run per metre of rise (a 4.5 m face in 0.7 m). */
  quayFaceRun: 0.15,
  /** Land batters off the pads, run per metre of rise. */
  padRun: 2,
  slipwaySideRun: 1.5,
  /** Reach beyond each core, metres. */
  padReach: 30,
  slipwayReach: 12,
  shedMargin: 2,
  /** Plants keep this far beyond a pad's reach... */
  padPlantClearance: 2,
});

const LAYOUTS = new WeakMap<MarinaLayout, InfrastructureLayout>();

/** The infrastructure source: the home marina's segments and its car-park anchor. */
export function marinaInfrastructure(world: WorldDefinition): InfrastructureLayout {
  const layout = homeMarina(world);
  let built = LAYOUTS.get(layout);
  if (!built) {
    built = buildMarinaEarthworks(layout);
    LAYOUTS.set(layout, built);
  }
  return built;
}

/** A box segment from marina-local corners, laid along +right (so +across is seaward). */
function alongRight(
  layout: MarinaLayout,
  rightMin: number,
  rightMax: number,
  outMin: number,
  outMax: number,
  segment: Omit<InfrastructureSegment, "ax" | "az" | "bx" | "bz" | "halfWidth">,
): InfrastructureSegment {
  const outMid = (outMin + outMax) * 0.5;
  const a = marinaToWorld(layout.frame, rightMin, outMid);
  const b = marinaToWorld(layout.frame, rightMax, outMid);
  return Object.freeze({ ...segment, ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidth: (outMax - outMin) * 0.5 });
}

/** A box segment laid along +out at one `right`, from `outA` to `outB`. */
function alongOut(
  layout: MarinaLayout,
  right: number,
  outA: number,
  outB: number,
  segment: Omit<InfrastructureSegment, "ax" | "az" | "bx" | "bz">,
): InfrastructureSegment {
  const a = marinaToWorld(layout.frame, right, outA);
  const b = marinaToWorld(layout.frame, right, outB);
  return Object.freeze({ ...segment, ax: a.x, az: a.z, bx: b.x, bz: b.z });
}

export function buildMarinaEarthworks(layout: MarinaLayout): InfrastructureLayout {
  const L = MARINA_LAYOUT;
  const E = MARINA_EARTHWORKS;
  const P = MARINA_EARTHWORK_PRIORITY;
  const sea = layout.seaLevel;
  const segments: InfrastructureSegment[] = [];
  const dredgeParams = Object.freeze([L.basinDepth, E.dredgeRun, E.dredgeShoreFrom, E.dredgeShoreTo]);
  // The batter climbs from the dredged bed; past this it has met any bed the basin cuts.
  const dredgeReach = (L.basinDepth + E.dredgeShoreTo) * E.dredgeRun;

  // Dredged basin over the berths, the fairway and the mouth.
  const { basin } = layout;
  segments.push(alongRight(layout, basin.rightMin, basin.rightMax, basin.outMin, basin.outMax, {
    profile: INFRASTRUCTURE_PROFILE.marinaDredge,
    mode: "cut",
    priority: P.dredge,
    reach: dredgeReach,
    params: dredgeParams,
  }));
  // The channel: from inside the basin along the lane's last leg to its end.
  const laneEndPoint = layout.lane[layout.lane.length - 1]!;
  const laneEnd = worldToMarina(layout.frame, laneEndPoint.x, laneEndPoint.z);
  const channelStart = basin.outMax - E.channelHalfWidth;
  if (laneEnd.out > channelStart) {
    segments.push(alongOut(layout, laneEnd.right, channelStart, laneEnd.out, {
      profile: INFRASTRUCTURE_PROFILE.marinaDredge,
      mode: "cut",
      priority: P.dredge,
      halfWidth: E.channelHalfWidth,
      reach: (L.basinDepth + E.channelShoreTo) * E.dredgeRun,
      params: Object.freeze([L.basinDepth, E.dredgeRun, E.channelShoreFrom, E.channelShoreTo]),
    }));
  }

  // Breakwater: a mound on the dredged bed, its waterline width painted.
  const { breakwater } = layout;
  if (breakwater) {
    const crestHeight = breakwater.crestY - sea;
    const waterlineHalfWidth = breakwater.crestHalfWidth + crestHeight * breakwater.sideSlope;
    const a = marinaToWorld(layout.frame, breakwater.rightA, breakwater.out);
    const b = marinaToWorld(layout.frame, breakwater.rightB, breakwater.out);
    segments.push(Object.freeze({
      profile: INFRASTRUCTURE_PROFILE.marinaBreakwater,
      mode: "fill",
      priority: P.breakwater,
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
      halfWidth: waterlineHalfWidth,
      // Down to a bed 12 m deep before it fades.
      reach: 12 * breakwater.sideSlope,
      params: Object.freeze([crestHeight, breakwater.crestHalfWidth, breakwater.sideSlope]),
      surface: "gravel",
    }));
  }

  // Quay apron, level with the deck; its front is the quay cut.
  const { apron, carPark, slipway } = layout;
  segments.push(alongRight(layout, apron.rightMin, apron.rightMax, apron.outMin, E.quayFrontOut, {
    profile: INFRASTRUCTURE_PROFILE.marinaPad,
    mode: "set",
    priority: P.quay,
    reach: E.padReach,
    params: Object.freeze([L.quayDeckHeight, L.quayDeckHeight, E.padRun, E.quayFaceRun]),
    surface: "concrete",
    plantClearance: E.padPlantClearance,
  }));
  // Access apron: the car park, rising inland from the quay to the road.
  segments.push(alongRight(layout, carPark.rightMin, carPark.rightMax, carPark.outMin, carPark.outMax, {
    profile: INFRASTRUCTURE_PROFILE.marinaPad,
    mode: "set",
    priority: P.carPark,
    reach: E.padReach,
    params: Object.freeze([carPark.frontY - sea, carPark.backY - sea, E.padRun, E.padRun]),
    surface: "asphalt",
    plantClearance: E.padPlantClearance,
  }));
  // The boat shed's floor, where it stands off the car park.
  const shed = layout.boxes.find((box) => box.kind === "shed");
  if (shed) {
    const floor = shed.y - shed.halfHeight - sea;
    const margin = E.shedMargin;
    segments.push(alongRight(
      layout,
      shed.right - shed.halfRight - margin,
      shed.right + shed.halfRight + margin,
      shed.out - shed.halfOut - margin,
      shed.out + shed.halfOut + margin,
      {
        profile: INFRASTRUCTURE_PROFILE.marinaPad,
        mode: "set",
        priority: P.shed,
        reach: E.padReach,
        params: Object.freeze([floor, floor, E.padRun, E.padRun]),
        surface: "concrete",
        plantClearance: E.padPlantClearance,
      },
    ));
  }
  // Slipway: from its top on the apron down through the waterline to its toe.
  segments.push(alongOut(layout, slipway.right, slipway.outTop, slipway.outToe, {
    profile: INFRASTRUCTURE_PROFILE.marinaSlipway,
    mode: "set",
    priority: P.slipway,
    halfWidth: slipway.halfWidth,
    reach: E.slipwayReach,
    params: Object.freeze([slipway.topY - sea, slipway.toeY - sea, E.slipwaySideRun]),
    surface: "concrete",
    plantClearance: E.padPlantClearance,
  }));

  const anchor = layout.carParkAnchor;
  return Object.freeze({
    segments: Object.freeze(segments),
    anchors: Object.freeze([
      Object.freeze({ name: anchor.name, x: anchor.x, z: anchor.z, headingRadians: anchor.headingRadians }),
    ]),
  });
}
