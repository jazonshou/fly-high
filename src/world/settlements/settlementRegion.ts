import type { InfrastructureRegion } from "../infrastructure";
import { expandRoadBox } from "../roads/roadGraph";
import { roadRegionBox, type RoadNetwork } from "../roads/roadNetwork";
import type { StructureRecord } from "../structures/structureRecord";
import { layoutSettlement, type SettlementLayout } from "./settlementLayout";
import { SettlementRoads } from "./settlementRoads";
import { SETTLEMENT_SITE_RADIUS_MAX, settlementCandidates, settlementSitesKept } from "./settlementSites";

/**
 * The settlements as the infrastructure stage takes them: one streamed
 * region per road region (`ROAD_REGION_METERS` squares), keyed
 * `settlements:<rx>:<rz>`, holding every settlement whose anchor lies in
 * the square. Its segments are the buildings' pads and clearings, the yards
 * and the driveways (composed after every road, `SETTLEMENT_PAD_PRIORITY`);
 * its `structures` are the buildings themselves.
 *
 * A pure function of (world, rx, rz): the sites a region keeps are decided
 * against every candidate near it, from either side of its edges alike, and
 * each layout reads only the roads round it and the ground before
 * earthworks. So installing a region twice, or in any order with its
 * neighbours, gives the same stage.
 */

export function settlementRegionKey(rx: number, rz: number): string {
  return `settlements:${rx}:${rz}`;
}

/** Past a region, how far its neighbours' sites are looked for: two of the widest sites, metres. */
const CANDIDATE_MARGIN = 2 * SETTLEMENT_SITE_RADIUS_MAX;
/** Past that, how far the roads are read: a cabin's road clearance and a little, metres. */
const ROADS_MARGIN = 360;

export interface SettlementRegion {
  readonly rx: number;
  readonly rz: number;
  readonly layouts: readonly SettlementLayout[];
  /** The stage's streamed region: pads, clearings, yards and driveways, with the buildings as `structures`. */
  readonly infrastructure: InfrastructureRegion;
}

export function settlementRegion(network: RoadNetwork, rx: number, rz: number): SettlementRegion {
  const world = network.world;
  const box = roadRegionBox(rx, rz);
  const candidateBox = expandRoadBox(box, CANDIDATE_MARGIN);
  const roads = new SettlementRoads(network, expandRoadBox(candidateBox, ROADS_MARGIN));
  const candidates = settlementCandidates(world, roads, candidateBox);
  const own = candidates.filter((site) => site.x >= box.minX && site.x < box.maxX && site.z >= box.minZ && site.z < box.maxZ);
  const layouts = settlementSitesKept(own, candidates)
    .map((site) => layoutSettlement(world, roads, site))
    .filter((layout) => layout.buildings.length > 0);
  const structures: StructureRecord[] = [];
  for (const layout of layouts) {
    for (const building of layout.buildings) structures.push(building.record);
  }
  return Object.freeze({
    rx,
    rz,
    layouts: Object.freeze(layouts),
    infrastructure: Object.freeze({
      key: settlementRegionKey(rx, rz),
      segments: Object.freeze(layouts.flatMap((layout) => layout.segments)),
      structures: Object.freeze(structures),
    }),
  });
}
