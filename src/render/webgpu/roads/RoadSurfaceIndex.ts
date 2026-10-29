import type { InfrastructureRail } from "@/src/world/infrastructure";
import { ROAD_CLASS } from "@/src/world/roads/roadClasses";
import type { RoadPad, RoadPiece } from "@/src/world/roads/roadNetwork";
import {
  ROAD_RIBBON_CHUNK_METERS,
  RoadSurfaceArrayBuilder,
  appendRoadPad,
  appendRoadRail,
  appendRoadRibbonSpan,
  RoadRibbonCut,
  roadRibbonChunkKey,
  roadRibbonChunkOf,
  roadRibbonEdgeKey,
  type RoadRibbonSpan,
  type RoadSurfaceArrays,
} from "./roadSurfaceGeometry";

/**
 * The installed roads as 128 m chunks of drawable arrays, pure so Node
 * asserts it; `RoadSurfaceSystem` draws the chunks within reach from its two
 * layers' slots (`RoadSurfaceSlots`).
 *
 * A region brings its pieces, pads and rails. A road's pieces are chained by
 * edge across every region that holds some of them (`RoadRibbonCut`), so an
 * install or a removal re-cuts the runs of the edges it touches, and only the
 * chunks those runs pass through, or that hold its pads and rails, are built
 * again, and only once one is asked for. A long edge is cut over as many
 * steps as it takes, its old spans drawn until the cut is done. A track's pad
 * is not drawn: a track draws its ruts and nothing else
 * (`RoadSurfaceMaterialPlugin`).
 */

/** What a region brings to the drawing. */
export interface RoadSurfaceRegion {
  /** The stage key (`InfrastructureRegion.key`). */
  readonly key: string;
  readonly pieces: readonly RoadPiece[];
  readonly pads: readonly RoadPad[];
  readonly rails: readonly InfrastructureRail[];
}

export type RoadSurfaceLayer = "ribbon" | "rail";

/** A chunk's arrays by layer, each built on first ask; positions relative to its corner (cx·128, cz·128). */
interface ChunkArrays {
  ribbon?: RoadSurfaceArrays | null;
  rail?: RoadSurfaceArrays | null;
}

/** The chunk a rail is drawn with: the one holding its middle point. */
function railChunk(rail: InfrastructureRail): string {
  const middle = Math.floor(rail.points.length / 4) * 2;
  const { cx, cz } = roadRibbonChunkOf(rail.points[middle]!, rail.points[middle + 1]!);
  return roadRibbonChunkKey(cx, cz);
}

function addTo<T>(map: Map<string, Map<string, T[]>>, chunk: string, owner: string, value: T): void {
  let owners = map.get(chunk);
  if (!owners) {
    owners = new Map();
    map.set(chunk, owners);
  }
  const list = owners.get(owner);
  if (list) list.push(value);
  else owners.set(owner, [value]);
}

function removeOwner<T>(map: Map<string, Map<string, T[]>>, chunk: string, owner: string): void {
  const owners = map.get(chunk);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) map.delete(chunk);
}

export class RoadSurfaceIndex {
  private readonly regions = new Map<string, RoadSurfaceRegion>();
  /** Edge key -> its installed pieces by index. */
  private readonly edgePieces = new Map<string, Map<number, RoadPiece>>();
  /** Edge key -> the chunks its spans lie in. */
  private readonly edgeChunks = new Map<string, Set<string>>();
  /** Chunk -> spans by edge key. */
  private readonly spans = new Map<string, Map<string, RoadRibbonSpan[]>>();
  /** Chunk -> pads and rails by region key. */
  private readonly pads = new Map<string, Map<string, RoadPad[]>>();
  private readonly rails = new Map<string, Map<string, InfrastructureRail[]>>();
  private readonly built = new Map<string, ChunkArrays>();
  /** Every build's scratch, copied out by `build`. */
  private readonly builder = new RoadSurfaceArrayBuilder();
  /** Chunk -> the change that last touched it, while it holds anything. */
  private readonly stamps = new Map<string, number>();
  /** Removals (stage keys) and installs waiting for `settle`, oldest first. */
  private readonly queued: (RoadSurfaceRegion | string)[] = [];
  /** Edges whose pieces changed, their runs not cut again yet. */
  private readonly pendingEdges = new Set<string>();
  /** The edge being cut again, its old spans still filed. */
  private cutting: RoadRibbonCut | null = null;
  /** Chunks touched by steps since the last change. */
  private readonly dirty = new Set<string>();
  private changes = 0;
  private chunkBuilds = 0;

  /** Bumped by every install or removal that changed a chunk. */
  get version(): number {
    return this.changes;
  }

  /**
   * The change that last touched a chunk (0: none since it was empty): a
   * chunk written at its current stamp is drawn as it stands, whatever
   * changed elsewhere.
   */
  chunkStamp(key: string): number {
    return this.stamps.get(key) ?? 0;
  }

  /** Chunk arrays built so far (observation only). */
  get builds(): number {
    return this.chunkBuilds;
  }

  get regionCount(): number {
    return this.regions.size;
  }

  /** Install regions and remove others in one change; a repeated key replaces its region. */
  apply(install: readonly RoadSurfaceRegion[], remove: readonly string[]): void {
    this.enqueue(install, remove);
    this.settle(Number.POSITIVE_INFINITY);
  }

  /**
   * The same, for `settle` to apply a step at a time: removals first, then
   * installs, in order. Until then the chunks are drawn as they were.
   */
  enqueue(install: readonly RoadSurfaceRegion[], remove: readonly string[]): void {
    for (const key of remove) this.queued.push(key);
    for (const region of install) this.queued.push(region);
  }

  /** Queued regions, the edge being cut and edges still to cut: steps `settle` has yet to take (at least). */
  get pendingSteps(): number {
    return this.queued.length + (this.cutting ? 1 : 0) + this.pendingEdges.size;
  }

  /**
   * Take steps until `deadline` (a `performance.now()` reading), the first
   * even past it when `first` says so: each queued region's own bookkeeping,
   * oldest first, then each edge they touched cut again into runs, a few
   * pieces a step, its spans swapped in once it is cut. What the steps
   * touched is one change (`version`, `chunkStamp`). Returns the steps taken.
   */
  settle(deadline: number, first = true): number {
    let steps = 0;
    while (this.queued.length > 0 || this.cutting || this.pendingEdges.size > 0) {
      if ((steps > 0 || !first) && performance.now() >= deadline) break;
      steps += 1;
      const change = this.queued.shift();
      if (typeof change === "string") {
        this.drop(change, this.pendingEdges, this.dirty);
        continue;
      }
      if (change !== undefined) {
        this.install(change);
        continue;
      }
      let cut = this.cutting;
      if (!cut) {
        const edge: string = this.pendingEdges.values().next().value!;
        this.pendingEdges.delete(edge);
        const pieces = this.edgePieces.get(edge);
        cut = new RoadRibbonCut(edge, pieces ? [...pieces.values()] : []);
        this.cutting = cut;
      }
      cut.advance(deadline);
      if (cut.done) {
        this.cutting = null;
        this.fileSpans(cut);
      }
    }
    this.publish();
    return steps;
  }

  private install(region: RoadSurfaceRegion): void {
    const dirty = this.dirty;
    this.drop(region.key, this.pendingEdges, dirty);
    this.regions.set(region.key, region);
    for (const piece of region.pieces) {
      const edge = roadRibbonEdgeKey(piece);
      let pieces = this.edgePieces.get(edge);
      if (!pieces) {
        pieces = new Map();
        this.edgePieces.set(edge, pieces);
      }
      pieces.set(piece.index, piece);
      this.pendingEdges.add(edge);
    }
    for (const pad of region.pads) {
      if (pad.classId === ROAD_CLASS.track) continue;
      const { cx, cz } = roadRibbonChunkOf(pad.x, pad.z);
      const chunk = roadRibbonChunkKey(cx, cz);
      addTo(this.pads, chunk, region.key, pad);
      dirty.add(chunk);
    }
    for (const rail of region.rails) {
      if (rail.points.length < 4) continue;
      const chunk = railChunk(rail);
      addTo(this.rails, chunk, region.key, rail);
      dirty.add(chunk);
    }
  }

  /** The chunks touched since the last change, as one change. */
  private publish(): void {
    if (this.dirty.size === 0) return;
    this.changes += 1;
    for (const chunk of this.dirty) {
      this.built.delete(chunk);
      if (this.spans.has(chunk) || this.pads.has(chunk) || this.rails.has(chunk)) this.stamps.set(chunk, this.changes);
      else this.stamps.delete(chunk);
    }
    this.dirty.clear();
  }

  /**
   * Chunk keys whose square lies within `range` of the square of the chunk
   * (cameraCx, cameraCz): everything any point of that chunk has in reach, so
   * the set changes only as the camera crosses a chunk edge. Nearest first
   * (by chunk offset; ties in raster order), so whatever is built over frames
   * fills in from under the camera.
   */
  chunksWithin(cameraCx: number, cameraCz: number, range: number, layer: RoadSurfaceLayer): string[] {
    if (!(range > 0)) return [];
    const source = layer === "ribbon" ? this.spansAndPads() : this.rails;
    const reach = Math.ceil(range / ROAD_RIBBON_CHUNK_METERS);
    const found: { key: string; distance: number }[] = [];
    for (let dz = -reach; dz <= reach; dz += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        // Gap between the two squares along each axis, in chunks.
        const gx = Math.max(0, Math.abs(dx) - 1);
        const gz = Math.max(0, Math.abs(dz) - 1);
        if (Math.hypot(gx, gz) * ROAD_RIBBON_CHUNK_METERS > range) continue;
        const key = roadRibbonChunkKey(cameraCx + dx, cameraCz + dz);
        if (source.has(key)) found.push({ key, distance: dx * dx + dz * dz });
      }
    }
    // Stable: equal offsets keep their raster order.
    return found.sort((first, second) => first.distance - second.distance).map((entry) => entry.key);
  }

  /** A chunk's arrays for one layer, built on first ask (that layer's only); null when it has none. */
  chunkArrays(key: string, layer: RoadSurfaceLayer): RoadSurfaceArrays | null {
    let cached = this.built.get(key);
    if (!cached) {
      cached = {};
      this.built.set(key, cached);
    }
    let arrays = cached[layer];
    if (arrays === undefined) {
      arrays = layer === "ribbon" ? this.buildRibbon(key) : this.buildRail(key);
      cached[layer] = arrays;
    }
    return arrays;
  }

  private spansAndPads(): { has(key: string): boolean } {
    return { has: (key: string) => this.spans.has(key) || this.pads.has(key) };
  }

  private drop(key: string, edges: Set<string>, dirty: Set<string>): void {
    const region = this.regions.get(key);
    if (!region) return;
    this.regions.delete(key);
    for (const piece of region.pieces) {
      const edge = roadRibbonEdgeKey(piece);
      const pieces = this.edgePieces.get(edge);
      if (pieces?.get(piece.index) === piece) pieces.delete(piece.index);
      if (pieces && pieces.size === 0) this.edgePieces.delete(edge);
      edges.add(edge);
    }
    for (const pad of region.pads) {
      if (pad.classId === ROAD_CLASS.track) continue;
      const { cx, cz } = roadRibbonChunkOf(pad.x, pad.z);
      const chunk = roadRibbonChunkKey(cx, cz);
      removeOwner(this.pads, chunk, key);
      dirty.add(chunk);
    }
    for (const rail of region.rails) {
      if (rail.points.length < 4) continue;
      const chunk = railChunk(rail);
      removeOwner(this.rails, chunk, key);
      dirty.add(chunk);
    }
  }

  /** A finished cut's spans filed by chunk in place of its edge's old ones. */
  private fileSpans(cut: RoadRibbonCut): void {
    const edge = cut.edgeKey;
    const dirty = this.dirty;
    for (const chunk of this.edgeChunks.get(edge) ?? []) {
      removeOwner(this.spans, chunk, edge);
      dirty.add(chunk);
    }
    this.edgeChunks.delete(edge);
    if (cut.spans.size === 0) return;
    const chunks = new Set<string>();
    for (const [chunk, list] of cut.spans) {
      for (const span of list) addTo(this.spans, chunk, edge, span);
      chunks.add(chunk);
      dirty.add(chunk);
    }
    this.edgeChunks.set(edge, chunks);
  }

  private buildRibbon(key: string): RoadSurfaceArrays | null {
    this.chunkBuilds += 1;
    const [anchorX, anchorZ] = chunkCorner(key);
    const spans = this.spans.get(key);
    const pads = this.pads.get(key);
    if (!spans && !pads) return null;
    const builder = this.builder;
    builder.reset();
    // Sorted, so a chunk's arrays never depend on the order regions came in.
    for (const edge of [...(spans?.keys() ?? [])].sort()) {
      for (const span of spans!.get(edge)!) appendRoadRibbonSpan(builder, span, anchorX, anchorZ);
    }
    for (const region of [...(pads?.keys() ?? [])].sort()) {
      for (const pad of pads!.get(region)!) appendRoadPad(builder, pad, anchorX, anchorZ);
    }
    return builder.vertexCount > 0 ? builder.build() : null;
  }

  private buildRail(key: string): RoadSurfaceArrays | null {
    this.chunkBuilds += 1;
    const [anchorX, anchorZ] = chunkCorner(key);
    const rails = this.rails.get(key);
    if (!rails) return null;
    const builder = this.builder;
    builder.reset();
    for (const region of [...rails.keys()].sort()) {
      for (const entry of rails.get(region)!) appendRoadRail(builder, entry, anchorX, anchorZ);
    }
    return builder.vertexCount > 0 ? builder.build() : null;
  }
}

function chunkCorner(key: string): [number, number] {
  const [cx, cz] = key.split(":").map(Number) as [number, number];
  return [cx * ROAD_RIBBON_CHUNK_METERS, cz * ROAD_RIBBON_CHUNK_METERS];
}
