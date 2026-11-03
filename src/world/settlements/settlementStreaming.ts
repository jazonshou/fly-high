import { ROAD_CLASS, roadClass } from "../roads/roadClasses";

/**
 * The settlements' stream layer (the structures plan's seam 1): one region
 * per road region, keyed `settlements:<rx>:<rz>`, streamed by the roads
 * worker beside the roads it is laid out against. Kept apart from the
 * layout itself, so the main thread's stream controller names a region
 * without loading it.
 */

export function settlementRegionKey(rx: number, rz: number): string {
  return `settlements:${rx}:${rz}`;
}

/** Whether a stage key names a settlements region. */
export function isSettlementRegionKey(key: string): boolean {
  return key.startsWith("settlements:");
}

/**
 * How far past its own square a settlement region reads the roads, metres:
 * its neighbours' sites (two of the widest sites' radii) and their roads
 * (a cabin's road clearance and a little).
 */
export const SETTLEMENT_ROADS_REACH = 1_050;

/**
 * The settlements' window, metres: the tracks' less the roads a region
 * reads past its square, so the roads a settlements region near the
 * observer is laid out against are the ones the worker streams anyway.
 * (Toward a region's far corners a few lie in track regions the window does
 * not hold yet: measured at the home road head, eight such regions within
 * this window built one road more between them, 85 ms in all. A region at
 * the tracks' own window edge, with nothing past it built, routes for a
 * second or two.)
 */
export const SETTLEMENT_STREAM_WINDOW = roadClass(ROAD_CLASS.track).windowMeters - SETTLEMENT_ROADS_REACH - 50;
