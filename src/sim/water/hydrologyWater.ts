import type { WaterSurfaceAuthority, WaterSurfaceSample } from "./types";

/**
 * The lakes and rivers the renderer draws, as water the sim can stand in
 * (land plan, "What the car reads from the world"; boats plan, one water
 * authority with the sea twin one of its sources).
 *
 * The renderer's `HydrologySystem` posts each region's rivers and lakes as
 * they land (`packHydrologyWater`), and this source answers for a point what
 * is drawn there:
 *
 * - a river is its ribbon: each station's row lies flat across the river at
 *   the station's surface height, so the surface is the stations' heights
 *   along the centreline, out to the interpolated half width, with the
 *   river's current along it and a normal from its fall. Its two ends are
 *   cut square at the end stations, as the ribbon is; its bends join round;
 * - a lake is still water at its level, inside its boundary;
 * - either is water only where the bed (the worker's terrain, the ground
 *   the hull and the tyres touch) lies below that surface, which is where
 *   the renderer's shore trim and contained lake plate draw it.
 *
 * Where no posted region covers a point the answer is `"none"`: the sim does
 * not guess at water it has not been sent. Where two posted regions overlap
 * (paging keeps the old region until the new one has faded in, and they
 * share their lakes) the higher surface answers.
 *
 * Every lookup is O(1): each region bins its river segments and lakes on a
 * grid of `HYDROLOGY_BIN_METERS` cells (coarser for a region so large the
 * grid would pass `MAX_BINS_PER_REGION`), and a point reads one cell.
 */

/** One river station, as `HydrologyRiverPoint` (renderer) carries it. */
export interface HydrologyWaterRiverPoint {
  readonly x: number;
  /** World Y of the water surface at the station. */
  readonly y: number;
  readonly z: number;
  readonly widthMeters: number;
  readonly flowSpeedMetersPerSecond: number;
}

/** A river: its stations from the source down. Structurally `HydrologyRiver`. */
export interface HydrologyWaterRiver {
  readonly points: readonly HydrologyWaterRiverPoint[];
}

/** A lake: its level and its boundary ring. Structurally `HydrologyLake`. */
export interface HydrologyWaterLake {
  readonly surfaceHeight: number;
  readonly boundary: readonly { readonly x: number; readonly z: number }[];
}

/**
 * One region's rivers and lakes as flat arrays, for the post to the
 * simulation worker (every buffer is transferable).
 */
export interface HydrologyWaterRegion {
  /** Per river station: x, y, z, width (m), flow speed (m/s). */
  readonly riverPoints: Float64Array;
  /** Each river's first station in `riverPoints`, then the station count. */
  readonly riverStarts: Uint32Array;
  /** Per lake: its still surface height. */
  readonly lakeLevels: Float64Array;
  /** Per lake boundary point: x, z. */
  readonly lakeBoundary: Float64Array;
  /** Each lake's first boundary point in `lakeBoundary`, then the point count. */
  readonly lakeStarts: Uint32Array;
}

const RIVER_POINT_STRIDE = 5;

/** A region's rivers and lakes, packed for the worker. Rivers under two stations and lakes under three points are dropped. */
export function packHydrologyWater(
  rivers: readonly HydrologyWaterRiver[],
  lakes: readonly HydrologyWaterLake[],
): HydrologyWaterRegion {
  const keptRivers = rivers.filter((river) => river.points.length >= 2);
  const keptLakes = lakes.filter((lake) => lake.boundary.length >= 3 && Number.isFinite(lake.surfaceHeight));
  const riverStarts = new Uint32Array(keptRivers.length + 1);
  let stations = 0;
  keptRivers.forEach((river, index) => {
    riverStarts[index] = stations;
    stations += river.points.length;
  });
  riverStarts[keptRivers.length] = stations;
  const riverPoints = new Float64Array(stations * RIVER_POINT_STRIDE);
  let o = 0;
  for (const river of keptRivers) {
    for (const point of river.points) {
      riverPoints[o] = point.x;
      riverPoints[o + 1] = point.y;
      riverPoints[o + 2] = point.z;
      riverPoints[o + 3] = point.widthMeters;
      riverPoints[o + 4] = point.flowSpeedMetersPerSecond;
      o += RIVER_POINT_STRIDE;
    }
  }
  const lakeStarts = new Uint32Array(keptLakes.length + 1);
  const lakeLevels = new Float64Array(keptLakes.length);
  let ring = 0;
  keptLakes.forEach((lake, index) => {
    lakeStarts[index] = ring;
    lakeLevels[index] = lake.surfaceHeight;
    ring += lake.boundary.length;
  });
  lakeStarts[keptLakes.length] = ring;
  const lakeBoundary = new Float64Array(ring * 2);
  o = 0;
  for (const lake of keptLakes) {
    for (const point of lake.boundary) {
      lakeBoundary[o] = point.x;
      lakeBoundary[o + 1] = point.z;
      o += 2;
    }
  }
  return { riverPoints, riverStarts, lakeLevels, lakeBoundary, lakeStarts };
}

/** Terrain height at a world point, metres; non-finite if the query failed, which reads as dry. */
export type HydrologyBedHeight = (x: number, z: number) => number;

/** Bin side, metres: a cell holds every segment and lake whose box reaches it. */
export const HYDROLOGY_BIN_METERS = 64;
/** Past this many cells a region's bins grow instead (a whole eroded world posted as one region). */
const MAX_BINS_PER_REGION = 1 << 20;
/**
 * A region asked to go is kept while the vehicle is this close to its
 * box, metres, and goes once the vehicle is farther (boats lead's rule).
 */
export const HYDROLOGY_EVICTION_KEEP_METERS = 1_000;

/**
 * Per river segment: start x, z, surface y; the run dx, dz, dy; 1 / (dx² + dz²);
 * the half widths and flow speeds at its two ends; the unit run ux, uz in plan;
 * the grade (dy over the plan length); whether its start and end are the
 * river's square-cut ends (1) or bends (0).
 */
const SEG_AX = 0;
const SEG_AZ = 1;
const SEG_AY = 2;
const SEG_DX = 3;
const SEG_DZ = 4;
const SEG_DY = 5;
const SEG_INV_LENGTH2 = 6;
const SEG_HALF_A = 7;
const SEG_HALF_B = 8;
const SEG_SPEED_A = 9;
const SEG_SPEED_B = 10;
const SEG_UX = 11;
const SEG_UZ = 12;
const SEG_GRADE = 13;
const SEG_CUT_START = 14;
const SEG_CUT_END = 15;
const SEG_STRIDE = 16;

/** Which water answered: none, a river segment, or a lake. */
const HIT_NONE = 0;
const HIT_RIVER = 1;
const HIT_LAKE = 2;

/** One posted region, binned. Items below `segmentCount` are segments; the rest are lakes. */
class HydrologyRegionBins {
  readonly segments: Float64Array;
  readonly segmentCount: number;
  readonly lakeLevels: Float64Array;
  readonly lakeBoundary: Float64Array;
  readonly lakeStarts: Uint32Array;
  /** Per lake: min x, min z, max x, max z. */
  readonly lakeBoxes: Float64Array;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly invBin: number;
  readonly binsX: number;
  readonly binsZ: number;
  readonly binStarts: Uint32Array;
  readonly binItems: Uint32Array;

  constructor(region: Readonly<HydrologyWaterRegion>) {
    const points = region.riverPoints;
    const starts = region.riverStarts;
    const riverCount = Math.max(0, starts.length - 1);
    let segmentCount = 0;
    for (let r = 0; r < riverCount; r += 1) segmentCount += Math.max(0, starts[r + 1]! - starts[r]! - 1);
    const segments = new Float64Array(segmentCount * SEG_STRIDE);
    let s = 0;
    for (let r = 0; r < riverCount; r += 1) {
      const first = starts[r]!;
      const last = starts[r + 1]! - 1;
      for (let p = first; p < last; p += 1) {
        const a = p * RIVER_POINT_STRIDE;
        const b = a + RIVER_POINT_STRIDE;
        const dx = points[b]! - points[a]!;
        const dz = points[b + 2]! - points[a + 2]!;
        const dy = points[b + 1]! - points[a + 1]!;
        const length2 = dx * dx + dz * dz;
        const length = Math.sqrt(length2);
        const o = s * SEG_STRIDE;
        segments[o + SEG_AX] = points[a]!;
        segments[o + SEG_AZ] = points[a + 2]!;
        segments[o + SEG_AY] = points[a + 1]!;
        segments[o + SEG_DX] = dx;
        segments[o + SEG_DZ] = dz;
        segments[o + SEG_DY] = dy;
        segments[o + SEG_INV_LENGTH2] = length2 > 1e-12 ? 1 / length2 : 0;
        segments[o + SEG_HALF_A] = points[a + 3]! * 0.5;
        segments[o + SEG_HALF_B] = points[b + 3]! * 0.5;
        segments[o + SEG_SPEED_A] = points[a + 4]!;
        segments[o + SEG_SPEED_B] = points[b + 4]!;
        segments[o + SEG_UX] = length > 1e-6 ? dx / length : 0;
        segments[o + SEG_UZ] = length > 1e-6 ? dz / length : 0;
        segments[o + SEG_GRADE] = length > 1e-6 ? dy / length : 0;
        segments[o + SEG_CUT_START] = p === first ? 1 : 0;
        segments[o + SEG_CUT_END] = p === last - 1 ? 1 : 0;
        s += 1;
      }
    }
    this.segments = segments;
    this.segmentCount = segmentCount;
    this.lakeLevels = region.lakeLevels;
    this.lakeBoundary = region.lakeBoundary;
    this.lakeStarts = region.lakeStarts;
    const lakeCount = region.lakeLevels.length;
    const lakeBoxes = new Float64Array(lakeCount * 4);
    for (let l = 0; l < lakeCount; l += 1) {
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let p = region.lakeStarts[l]!; p < region.lakeStarts[l + 1]!; p += 1) {
        const x = region.lakeBoundary[p * 2]!;
        const z = region.lakeBoundary[p * 2 + 1]!;
        minX = Math.min(minX, x);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxZ = Math.max(maxZ, z);
      }
      lakeBoxes[l * 4] = minX;
      lakeBoxes[l * 4 + 1] = minZ;
      lakeBoxes[l * 4 + 2] = maxX;
      lakeBoxes[l * 4 + 3] = maxZ;
    }
    this.lakeBoxes = lakeBoxes;

    // Every item's box, then the region's.
    const itemCount = segmentCount + lakeCount;
    const boxes = new Float64Array(itemCount * 4);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < itemCount; i += 1) {
      let x0: number;
      let z0: number;
      let x1: number;
      let z1: number;
      if (i < segmentCount) {
        const o = i * SEG_STRIDE;
        const half = Math.max(segments[o + SEG_HALF_A]!, segments[o + SEG_HALF_B]!);
        const ax = segments[o + SEG_AX]!;
        const az = segments[o + SEG_AZ]!;
        const bx = ax + segments[o + SEG_DX]!;
        const bz = az + segments[o + SEG_DZ]!;
        x0 = Math.min(ax, bx) - half;
        z0 = Math.min(az, bz) - half;
        x1 = Math.max(ax, bx) + half;
        z1 = Math.max(az, bz) + half;
      } else {
        const l = (i - segmentCount) * 4;
        x0 = lakeBoxes[l]!;
        z0 = lakeBoxes[l + 1]!;
        x1 = lakeBoxes[l + 2]!;
        z1 = lakeBoxes[l + 3]!;
      }
      boxes[i * 4] = x0;
      boxes[i * 4 + 1] = z0;
      boxes[i * 4 + 2] = x1;
      boxes[i * 4 + 3] = z1;
      minX = Math.min(minX, x0);
      minZ = Math.min(minZ, z0);
      maxX = Math.max(maxX, x1);
      maxZ = Math.max(maxZ, z1);
    }
    if (itemCount === 0) {
      minX = 0;
      minZ = 0;
      maxX = 0;
      maxZ = 0;
    }
    let bin = HYDROLOGY_BIN_METERS;
    const spanX = Math.max(maxX - minX, 1);
    const spanZ = Math.max(maxZ - minZ, 1);
    while (Math.ceil(spanX / bin) * Math.ceil(spanZ / bin) > MAX_BINS_PER_REGION) bin *= 2;
    this.minX = minX;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxZ = maxZ;
    this.invBin = 1 / bin;
    this.binsX = itemCount === 0 ? 0 : Math.ceil(spanX / bin);
    this.binsZ = itemCount === 0 ? 0 : Math.ceil(spanZ / bin);

    // Count, offset, fill: one flat list of item ids per cell.
    const cells = this.binsX * this.binsZ;
    const binStarts = new Uint32Array(cells + 1);
    const cellRange = (i: number, visit: (cell: number) => void): void => {
      const ix0 = this.cellX(boxes[i * 4]!);
      const iz0 = this.cellZ(boxes[i * 4 + 1]!);
      const ix1 = this.cellX(boxes[i * 4 + 2]!);
      const iz1 = this.cellZ(boxes[i * 4 + 3]!);
      for (let ix = ix0; ix <= ix1; ix += 1) {
        for (let iz = iz0; iz <= iz1; iz += 1) visit(ix * this.binsZ + iz);
      }
    };
    for (let i = 0; i < itemCount; i += 1) cellRange(i, (cell) => { binStarts[cell + 1]! += 1; });
    for (let cell = 0; cell < cells; cell += 1) binStarts[cell + 1]! += binStarts[cell]!;
    const binItems = new Uint32Array(binStarts[cells] ?? 0);
    const fill = binStarts.slice(0, cells);
    for (let i = 0; i < itemCount; i += 1) {
      cellRange(i, (cell) => {
        binItems[fill[cell]!] = i;
        fill[cell]! += 1;
      });
    }
    this.binStarts = binStarts;
    this.binItems = binItems;
  }

  private cellX(x: number): number {
    return Math.min(this.binsX - 1, Math.max(0, Math.floor((x - this.minX) * this.invBin)));
  }

  private cellZ(z: number): number {
    return Math.min(this.binsZ - 1, Math.max(0, Math.floor((z - this.minZ) * this.invBin)));
  }

  /** Metres from (x, z) to this region's box; 0 inside it. */
  distanceTo(x: number, z: number): number {
    const dx = Math.max(this.minX - x, 0, x - this.maxX);
    const dz = Math.max(this.minZ - z, 0, z - this.maxZ);
    return Math.sqrt(dx * dx + dz * dz);
  }
}

/**
 * The lakes and rivers source. `sampleWet` is the composite's entry: it
 * fills `out` and returns true only where there is water.
 */
export class HydrologyWaterSource implements WaterSurfaceAuthority {
  private readonly regions = new Map<string, HydrologyRegionBins>();
  /** The same regions as a list, for the per-sample walk. */
  private resident: HydrologyRegionBins[] = [];
  private readonly pendingEvictions = new Set<string>();
  private vehicleX = Number.NaN;
  private vehicleZ = Number.NaN;
  // The point being looked up and the best water found for it so far, in
  // fields so no double crosses a call V8 might not inline (it would box).
  private queryX = 0;
  private queryZ = 0;
  private hitKind = HIT_NONE;
  private hitHeight = 0;
  /** Whether the hit is a segment's round cap at a bend rather than the run the point projects onto. */
  private hitCapped = false;
  private hitRegion: HydrologyRegionBins | null = null;
  private hitItem = 0;
  private hitT = 0;

  constructor(private readonly bedHeight: HydrologyBedHeight) {}

  setTime(): void {}

  /** Install a region, or replace the one under `key`: re-posting is idempotent. */
  setRegion(key: string, region: Readonly<HydrologyWaterRegion>): void {
    this.pendingEvictions.delete(key);
    this.regions.set(key, new HydrologyRegionBins(region));
    this.resident = [...this.regions.values()];
  }

  /**
   * The renderer is done with `key`. It goes now if the vehicle is more than
   * `HYDROLOGY_EVICTION_KEEP_METERS` from it (or no vehicle has been placed),
   * otherwise once the vehicle has moved that far away.
   */
  evictRegion(key: string): void {
    if (!this.regions.has(key)) return;
    this.pendingEvictions.add(key);
    this.evictFarRegions();
  }

  /** Where the active vehicle is; a region waiting to go goes once it is far enough. */
  setVehiclePosition(x: number, z: number): void {
    this.vehicleX = x;
    this.vehicleZ = z;
    if (this.pendingEvictions.size > 0) this.evictFarRegions();
  }

  /** Every region dropped (a new world). */
  clear(): void {
    this.regions.clear();
    this.pendingEvictions.clear();
    this.resident = [];
  }

  /** How many regions answer (for tests and the worker's statistics). */
  get regionCount(): number {
    return this.regions.size;
  }

  hasRegion(key: string): boolean {
    return this.regions.has(key);
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    if (this.sampleWet(x, z, out)) return out;
    const bed = this.bedHeight(x, z);
    out.kind = "none";
    out.height = bed;
    out.stillHeight = bed;
    out.depth = 0;
    out.velocity.x = 0;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    return out;
  }

  /** The lake or river water at (x, z) into `out`, true; false (and `out` untouched) where there is none. */
  sampleWet(x: number, z: number, out: WaterSurfaceSample): boolean {
    const regions = this.resident;
    if (regions.length === 0) return false;
    this.queryX = x;
    this.queryZ = z;
    this.hitKind = HIT_NONE;
    this.hitHeight = -Infinity;
    this.hitCapped = true;
    for (let r = 0; r < regions.length; r += 1) this.lookUp(regions[r]!);
    if (this.hitKind === HIT_NONE) return false;
    const bed = this.bedHeight(x, z);
    const still = this.hitHeight;
    // Over ground as high as the surface, the shore trim draws no water.
    if (!(still > bed)) return false;
    out.kind = this.hitKind === HIT_RIVER ? "river" : "lake";
    out.height = still;
    out.stillHeight = still;
    out.depth = still - bed;
    if (this.hitKind === HIT_LAKE) {
      out.velocity.x = 0;
      out.velocity.y = 0;
      out.velocity.z = 0;
      out.normal.x = 0;
      out.normal.y = 1;
      out.normal.z = 0;
      return true;
    }
    const seg = this.hitRegion!.segments;
    const o = this.hitItem * SEG_STRIDE;
    const t = this.hitT;
    const speed = seg[o + SEG_SPEED_A]! + (seg[o + SEG_SPEED_B]! - seg[o + SEG_SPEED_A]!) * t;
    const ux = seg[o + SEG_UX]!;
    const uz = seg[o + SEG_UZ]!;
    const grade = seg[o + SEG_GRADE]!;
    // Along the river, down its fall.
    const along = speed / Math.sqrt(1 + grade * grade);
    out.velocity.x = along * ux;
    out.velocity.y = along * grade;
    out.velocity.z = along * uz;
    const n = 1 / Math.sqrt(1 + grade * grade);
    out.normal.x = -grade * ux * n;
    out.normal.y = n;
    out.normal.z = -grade * uz * n;
    return true;
  }

  /** Raise the hit to region `bins`' highest surface over the query point, if higher. */
  private lookUp(bins: HydrologyRegionBins): void {
    const x = this.queryX;
    const z = this.queryZ;
    const ix = Math.floor((x - bins.minX) * bins.invBin);
    const iz = Math.floor((z - bins.minZ) * bins.invBin);
    if (ix < 0 || iz < 0 || ix >= bins.binsX || iz >= bins.binsZ) return;
    const cell = ix * bins.binsZ + iz;
    const items = bins.binItems;
    const end = bins.binStarts[cell + 1]!;
    const seg = bins.segments;
    for (let k = bins.binStarts[cell]!; k < end; k += 1) {
      const item = items[k]!;
      if (item < bins.segmentCount) {
        const o = item * SEG_STRIDE;
        const px = x - seg[o + SEG_AX]!;
        const pz = z - seg[o + SEG_AZ]!;
        const dx = seg[o + SEG_DX]!;
        const dz = seg[o + SEG_DZ]!;
        let t = (px * dx + pz * dz) * seg[o + SEG_INV_LENGTH2]!;
        // The ribbon's two ends are cut square; between segments it bends
        // round. A cap answers only where no run does: downstream of a
        // station the upstream segment's cap would be higher than the run
        // the point is on.
        let capped = false;
        if (t < 0) {
          if (seg[o + SEG_CUT_START] === 1) continue;
          t = 0;
          capped = true;
        } else if (t > 1) {
          if (seg[o + SEG_CUT_END] === 1) continue;
          t = 1;
          capped = true;
        }
        if (capped && !this.hitCapped) continue;
        const ox = px - dx * t;
        const oz = pz - dz * t;
        const half = seg[o + SEG_HALF_A]! + (seg[o + SEG_HALF_B]! - seg[o + SEG_HALF_A]!) * t;
        if (ox * ox + oz * oz > half * half) continue;
        const height = seg[o + SEG_AY]! + seg[o + SEG_DY]! * t;
        if (capped === this.hitCapped && height <= this.hitHeight) continue;
        this.hitKind = HIT_RIVER;
        this.hitHeight = height;
        this.hitCapped = capped;
        this.hitRegion = bins;
        this.hitItem = item;
        this.hitT = t;
      } else {
        const lake = item - bins.segmentCount;
        const level = bins.lakeLevels[lake]!;
        if ((!this.hitCapped && level <= this.hitHeight) || !this.insideLake(bins, lake)) continue;
        this.hitKind = HIT_LAKE;
        this.hitHeight = level;
        this.hitCapped = false;
        this.hitRegion = bins;
        this.hitItem = lake;
      }
    }
  }

  /** Whether the query point is inside lake `lake`'s boundary ring (even-odd). */
  private insideLake(bins: HydrologyRegionBins, lake: number): boolean {
    const x = this.queryX;
    const z = this.queryZ;
    const box = lake * 4;
    const boxes = bins.lakeBoxes;
    if (x < boxes[box]! || z < boxes[box + 1]! || x > boxes[box + 2]! || z > boxes[box + 3]!) return false;
    const ring = bins.lakeBoundary;
    const first = bins.lakeStarts[lake]!;
    const end = bins.lakeStarts[lake + 1]!;
    let inside = false;
    let jx = ring[(end - 1) * 2]!;
    let jz = ring[(end - 1) * 2 + 1]!;
    for (let p = first; p < end; p += 1) {
      const ix = ring[p * 2]!;
      const iz = ring[p * 2 + 1]!;
      if ((iz > z) !== (jz > z) && x < ((jx - ix) * (z - iz)) / (jz - iz) + ix) inside = !inside;
      jx = ix;
      jz = iz;
    }
    return inside;
  }

  private evictFarRegions(): void {
    const placed = Number.isFinite(this.vehicleX) && Number.isFinite(this.vehicleZ);
    let changed = false;
    for (const key of this.pendingEvictions) {
      const region = this.regions.get(key);
      if (region && placed && region.distanceTo(this.vehicleX, this.vehicleZ) <= HYDROLOGY_EVICTION_KEEP_METERS) continue;
      this.pendingEvictions.delete(key);
      this.regions.delete(key);
      changed = true;
    }
    if (changed) this.resident = [...this.regions.values()];
  }
}
