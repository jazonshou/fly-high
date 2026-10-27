import type { InfrastructureRail } from "@/src/world/infrastructure";
import { ROAD_CLASS } from "@/src/world/roads/roadClasses";
import type { RoadPad, RoadPiece } from "@/src/world/roads/roadNetwork";
import {
  ROAD_RIBBON_CHUNK_METERS,
  RoadSurfaceArrayBuilder,
  appendRoadPad,
  appendRoadRail,
  appendRoadRibbonSpan,
  roadRibbonChunkKey,
  roadRibbonChunkOf,
  roadRibbonEdgeKey,
  roadRibbonRuns,
  roadRibbonSpansByChunk,
  type RoadRibbonSpan,
  type RoadSurfaceArrays,
} from "./roadSurfaceGeometry";

/**
 * The installed roads as 128 m chunks of drawable arrays, pure so Node
 * asserts it; `RoadSurfaceSystem` merges the chunks within reach into its two
 * meshes.
 *
 * A region brings its pieces, pads and rails. A road's pieces are chained by
 * edge across every region that holds some of them (`roadRibbonRuns`), so an
 * install or a removal re-cuts the runs of the edges it touches, and only the
 * chunks those runs pass through, or that hold its pads and rails, are built
 * again, and only once one is asked for. A track's pad is not drawn: a track
 * draws its ruts and nothing else (`RoadSurfaceMaterialPlugin`).
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

/** A chunk's arrays, positions relative to its corner (cx·128, cz·128). */
interface ChunkArrays {
  ribbon: RoadSurfaceArrays | null;
  rail: RoadSurfaceArrays | null;
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
  private changes = 0;
  private chunkBuilds = 0;

  /** Bumped by every install or removal that changed a chunk. */
  get version(): number {
    return this.changes;
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
    const edges = new Set<string>();
    const dirty = new Set<string>();
    for (const key of remove) this.drop(key, edges, dirty);
    for (const region of install) {
      this.drop(region.key, edges, dirty);
      this.regions.set(region.key, region);
      for (const piece of region.pieces) {
        const edge = roadRibbonEdgeKey(piece);
        let pieces = this.edgePieces.get(edge);
        if (!pieces) {
          pieces = new Map();
          this.edgePieces.set(edge, pieces);
        }
        pieces.set(piece.index, piece);
        edges.add(edge);
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
    for (const edge of edges) this.recut(edge, dirty);
    for (const chunk of dirty) this.built.delete(chunk);
    if (dirty.size > 0) this.changes += 1;
  }

  /**
   * Chunk keys whose square lies within `range` of the square of the chunk
   * (cameraCx, cameraCz): everything any point of that chunk has in reach, so
   * the set changes only as the camera crosses a chunk edge.
   */
  chunksWithin(cameraCx: number, cameraCz: number, range: number, layer: RoadSurfaceLayer): string[] {
    if (!(range > 0)) return [];
    const source = layer === "ribbon" ? this.spansAndPads() : this.rails;
    const reach = Math.ceil(range / ROAD_RIBBON_CHUNK_METERS);
    const keys: string[] = [];
    for (let dz = -reach; dz <= reach; dz += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        // Gap between the two squares along each axis, in chunks.
        const gx = Math.max(0, Math.abs(dx) - 1);
        const gz = Math.max(0, Math.abs(dz) - 1);
        if (Math.hypot(gx, gz) * ROAD_RIBBON_CHUNK_METERS > range) continue;
        const key = roadRibbonChunkKey(cameraCx + dx, cameraCz + dz);
        if (source.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  /** A chunk's arrays for one layer, built on first ask; null when it has none. */
  chunkArrays(key: string, layer: RoadSurfaceLayer): RoadSurfaceArrays | null {
    let cached = this.built.get(key);
    if (!cached) {
      cached = this.build(key);
      this.built.set(key, cached);
    }
    return layer === "ribbon" ? cached.ribbon : cached.rail;
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

  /** Cut an edge's runs again and file their spans by chunk. */
  private recut(edge: string, dirty: Set<string>): void {
    for (const chunk of this.edgeChunks.get(edge) ?? []) {
      removeOwner(this.spans, chunk, edge);
      dirty.add(chunk);
    }
    this.edgeChunks.delete(edge);
    const pieces = this.edgePieces.get(edge);
    if (!pieces || pieces.size === 0) return;
    const byChunk = roadRibbonSpansByChunk(roadRibbonRuns(edge, [...pieces.values()]));
    const chunks = new Set<string>();
    for (const [chunk, list] of byChunk) {
      for (const span of list) addTo(this.spans, chunk, edge, span);
      chunks.add(chunk);
      dirty.add(chunk);
    }
    this.edgeChunks.set(edge, chunks);
  }

  private build(key: string): ChunkArrays {
    this.chunkBuilds += 1;
    const [cx, cz] = key.split(":").map(Number) as [number, number];
    const anchorX = cx * ROAD_RIBBON_CHUNK_METERS;
    const anchorZ = cz * ROAD_RIBBON_CHUNK_METERS;
    let ribbon: RoadSurfaceArrays | null = null;
    const spans = this.spans.get(key);
    const pads = this.pads.get(key);
    if (spans || pads) {
      const builder = new RoadSurfaceArrayBuilder();
      // Sorted, so a chunk's arrays never depend on the order regions came in.
      for (const edge of [...(spans?.keys() ?? [])].sort()) {
        for (const span of spans!.get(edge)!) appendRoadRibbonSpan(builder, span, anchorX, anchorZ);
      }
      for (const region of [...(pads?.keys() ?? [])].sort()) {
        for (const pad of pads!.get(region)!) appendRoadPad(builder, pad, anchorX, anchorZ);
      }
      if (builder.vertexCount > 0) ribbon = builder.build();
    }
    let rail: RoadSurfaceArrays | null = null;
    const rails = this.rails.get(key);
    if (rails) {
      const builder = new RoadSurfaceArrayBuilder();
      for (const region of [...rails.keys()].sort()) {
        for (const entry of rails.get(region)!) appendRoadRail(builder, entry, anchorX, anchorZ);
      }
      if (builder.vertexCount > 0) rail = builder.build();
    }
    return { ribbon, rail };
  }
}

/** Several chunks' arrays as one, positions relative to (anchorX, anchorZ). */
export interface RoadSurfaceMerged extends RoadSurfaceArrays {
  /** Bounds of the design positions (a rail's y is its height above the ground). */
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export function mergeRoadSurfaceChunks(
  chunks: readonly { readonly key: string; readonly arrays: RoadSurfaceArrays }[],
  anchorX: number,
  anchorZ: number,
): RoadSurfaceMerged | null {
  let vertices = 0;
  let indices = 0;
  for (const { arrays } of chunks) {
    vertices += arrays.vertexCount;
    indices += arrays.indices.length;
  }
  if (vertices === 0) return null;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const surface = new Float32Array(vertices * 4);
  const merged = new Uint32Array(indices);
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let vertexBase = 0;
  let indexBase = 0;
  for (const { key, arrays } of chunks) {
    const [cx, cz] = key.split(":").map(Number) as [number, number];
    const offsetX = cx * ROAD_RIBBON_CHUNK_METERS - anchorX;
    const offsetZ = cz * ROAD_RIBBON_CHUNK_METERS - anchorZ;
    const source = arrays.positions;
    for (let index = 0; index < arrays.vertexCount; index += 1) {
      const from = index * 3;
      const to = (vertexBase + index) * 3;
      const x = source[from]! + offsetX;
      const y = source[from + 1]!;
      const z = source[from + 2]! + offsetZ;
      positions[to] = x;
      positions[to + 1] = y;
      positions[to + 2] = z;
      if (x < minimum[0]) minimum[0] = x;
      if (y < minimum[1]) minimum[1] = y;
      if (z < minimum[2]) minimum[2] = z;
      if (x > maximum[0]) maximum[0] = x;
      if (y > maximum[1]) maximum[1] = y;
      if (z > maximum[2]) maximum[2] = z;
    }
    normals.set(arrays.normals, vertexBase * 3);
    surface.set(arrays.surface, vertexBase * 4);
    for (let index = 0; index < arrays.indices.length; index += 1) {
      merged[indexBase + index] = arrays.indices[index]! + vertexBase;
    }
    vertexBase += arrays.vertexCount;
    indexBase += arrays.indices.length;
  }
  return { positions, normals, surface, indices: merged, vertexCount: vertices, minimum, maximum };
}
