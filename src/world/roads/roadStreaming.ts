import { roadLayerWindow, roadRegionBox, roadRegionOf, ROAD_LAYERS, ROAD_REGION_METERS, type RoadLayer } from "./roadNetwork";

/**
 * Which road regions the observer needs, and in what order: the pure half of
 * `RoadStreamController` (src/game), so it can be tested without a worker.
 *
 * A layer's region is WANTED when its square comes within the layer's window
 * of the observer, or of where the observer will be `ROAD_STREAM_LEAD_SECONDS`
 * on at its present velocity (a jet at 250 m/s asks for its regions 5 km
 * before they enter the window). It is KEPT while within the window plus one
 * region of either point, so an observer pacing a boundary does not install
 * and drop the same row over and over. Urgency is the distance to the nearer
 * of the two points: the ground under the observer first, then ahead.
 */

/** How far ahead along the velocity the window is also held, seconds. */
export const ROAD_STREAM_LEAD_SECONDS = 20;

export interface RoadStreamObserver {
  readonly x: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityZ: number;
}

export interface RoadStreamRegion {
  readonly layer: RoadLayer;
  readonly rx: number;
  readonly rz: number;
  /** Metres from the nearer of the observer and its lead point to the region's square. */
  readonly distance: number;
}

/** Distance from (x, z) to the region's square, 0 inside. */
export function roadRegionDistance(rx: number, rz: number, x: number, z: number): number {
  const box = roadRegionBox(rx, rz);
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dz = Math.max(box.minZ - z, 0, z - box.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Every region within `margin` metres past each layer's window of the
 * observer or its lead point, most urgent first (ties by layer, then
 * position, so the order is a pure function of the observer).
 */
export function roadStreamRegions(observer: RoadStreamObserver, margin = 0): RoadStreamRegion[] {
  const leadX = observer.x + observer.velocityX * ROAD_STREAM_LEAD_SECONDS;
  const leadZ = observer.z + observer.velocityZ * ROAD_STREAM_LEAD_SECONDS;
  const found: RoadStreamRegion[] = [];
  for (const layer of ROAD_LAYERS) {
    const reach = roadLayerWindow(layer) + margin;
    const minX = roadRegionOf(Math.min(observer.x, leadX) - reach);
    const maxX = roadRegionOf(Math.max(observer.x, leadX) + reach);
    const minZ = roadRegionOf(Math.min(observer.z, leadZ) - reach);
    const maxZ = roadRegionOf(Math.max(observer.z, leadZ) + reach);
    for (let rz = minZ; rz <= maxZ; rz += 1) {
      for (let rx = minX; rx <= maxX; rx += 1) {
        const distance = Math.min(
          roadRegionDistance(rx, rz, observer.x, observer.z),
          roadRegionDistance(rx, rz, leadX, leadZ),
        );
        if (distance <= reach) found.push({ layer, rx, rz, distance });
      }
    }
  }
  found.sort((left, right) => left.distance - right.distance
    || (left.layer < right.layer ? -1 : left.layer > right.layer ? 1 : 0)
    || left.rz - right.rz
    || left.rx - right.rx);
  return found;
}

/** The margin `RoadStreamController` keeps regions within past the window: one region. */
export const ROAD_STREAM_KEEP_MARGIN = ROAD_REGION_METERS;
