import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { PipelineWarmUp } from "../core/AsyncPipelineCompiles";
import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import type { TerrainDrawnAtlasShape, TerrainDrawnHeight } from "../terrain/TerrainDrawnHeight";
import {
  ROAD_RAIL_FINISH,
  RoadSurfaceMaterialPlugin,
  type RoadSurfaceArrays as RoadMaterialArrays,
  type RoadSurfaceRole,
} from "./RoadSurfaceMaterialPlugin";
import { RoadSurfaceIndex, type RoadSurfaceRegion } from "./RoadSurfaceIndex";
import { ROAD_RIBBON_CHUNK_METERS, type RoadSurfaceArrays } from "./roadSurfaceGeometry";
import { ROAD_SURFACE_SLOT_FLOATS, RoadSurfaceSlots } from "./roadSurfaceSlots";

/**
 * The roads' ribbons and guardrails near the camera: TWO draws at most (one
 * mesh each) and none while nothing is in reach.
 *
 * WHAT IS DRAWN. Every 128 m chunk (`RoadSurfaceIndex`) whose square lies
 * within the tier's `roadRibbonRangeMeters` (ribbons) or
 * `barrierDrawRangeMeters` (rails) of the camera's chunk, each in a slot of
 * its layer's buffers (`RoadSurfaceSlots`). The set is decided per chunk, so
 * it changes only as the camera crosses a chunk edge or the roads change.
 *
 * A FRAME'S SHARE. Every step of the work shares the frame's
 * `ROAD_SURFACE_FRAME_BUDGET_MS`, and one is always taken: first the
 * streamed changes (`apply` only queues them; the index installs or drops a
 * region a step, then cuts each edge they touched into runs again, a step an
 * edge), then the chunks. A chunk leaving reach is dropped at once (its
 * indices zeroed); the chunks entering it, or changed since they were
 * written, are built and written nearest first, and only their ranges are
 * uploaded. A crossing brings a row of chunks in at the range's edge, where
 * a few frames' delay does not show, and a jump fills in from under the
 * camera outwards over as many frames as it takes. A changed chunk is drawn
 * as it was until its new arrays replace it, in the same upload.
 *
 * ON THE GROUND. Both lie on the terrain as drawn (`TerrainDrawnHeight`):
 * the lookup is refreshed, after the terrain wrote this frame's node records,
 * only while something is drawn, round the camera, as far as the farthest
 * chunk drawn can reach. Nothing here changes what the terrain draws.
 *
 * NO COMPILE IN A FRAME. Both materials are deferred
 * (`AsyncPipelineCompiles.defer`, by the renderer), and once the first roads
 * are installed, before any is in reach, each layer draws ONE degenerate
 * triangle wherever the camera is until `pipelineWarmUp` reports its
 * pipelines built: the compile starts as the roads stream in, off the frame,
 * not when the first chunk comes into reach. The lookup is not refreshed
 * for it (a triangle of no area reads nothing that shows).
 */

/** How far past a layer's range a drawn chunk can reach from the camera: two chunk diagonals. */
export const ROAD_SURFACE_REACH_SLACK_METERS = 2 * Math.SQRT2 * ROAD_RIBBON_CHUNK_METERS;

/**
 * Main-thread time a frame spends building and writing chunks, milliseconds:
 * no more is started past it (one always is, so a jump fills in).
 */
export const ROAD_SURFACE_FRAME_BUDGET_MS = 0.6;

/** What the system asks of the terrain (`TerrainClipmapSystem`). */
export interface RoadSurfaceTerrain {
  drawnHeight(reachMeters: number): TerrainDrawnHeight;
  refreshDrawnHeight(x: number, z: number, radiusMeters: number): void;
  readonly drawnHeightAtlas: { readonly texture: BaseTexture | null; readonly shape: TerrainDrawnAtlasShape };
  readonly surfaceMaterialArrays: RoadMaterialArrays | null;
}

export interface RoadSurfaceRanges {
  readonly roadRibbonRangeMeters: number;
  readonly barrierDrawRangeMeters: number;
}

export interface RoadSurfaceStatistics {
  readonly regions: number;
  /** Chunks in reach; steps of streamed changes and chunk writes still to take. */
  readonly ribbonChunks: number;
  readonly railChunks: number;
  readonly pendingWork: number;
  /** Vertices of the chunks drawn. */
  readonly ribbonVertices: number;
  readonly railVertices: number;
  /** Meshes drawn this frame (0-2). */
  readonly draws: number;
  /**
   * Layers with chunks in reach that the last frame did not draw: hidden
   * (their material or binding not ready) or selected and skipped (their
   * material not ready for the draw). Part of `pendingWork`.
   */
  readonly undrawnLayers: number;
  /** Layers drawing their pipeline warm-up this frame (0-2), and layers whose pipelines are proven built. */
  readonly warmUps: number;
  readonly warmLayers: number;
  /** Chunks written into slots and dropped from them, chunk arrays built, and buffer sets made (first and on growth). */
  readonly writes: number;
  readonly releases: number;
  readonly chunkBuilds: number;
  readonly bufferBuilds: number;
  /** Ranges uploaded in the last update. */
  readonly uploadRanges: number;
  /** Draw caches reset for a new index range (each re-records the layer's draw). */
  readonly drawResets: number;
  /** Times a layer was bound to the lookup, the atlas or an anchor it was not bound to already. */
  readonly bindings: number;
  /** Main-thread time of the last update, milliseconds. */
  readonly updateMilliseconds: number;
}

/** The warm-up's triangle, a slot of its own while a layer has no chunk to draw. */
const PLACEHOLDER = "warm-up";
const PLACEHOLDER_ARRAYS: RoadSurfaceArrays = {
  positions: new Float32Array(9),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  surface: new Float32Array(12),
  indices: new Uint32Array([0, 1, 2]),
  vertexCount: 3,
};

const VERTEX_ARRAYS = [
  { kind: VertexBuffer.PositionKind, array: "positions", floats: ROAD_SURFACE_SLOT_FLOATS.position },
  { kind: VertexBuffer.NormalKind, array: "normals", floats: ROAD_SURFACE_SLOT_FLOATS.normal },
  { kind: "roadSurface", array: "surface", floats: ROAD_SURFACE_SLOT_FLOATS.surface },
  { kind: "roadChunk", array: "chunk", floats: ROAD_SURFACE_SLOT_FLOATS.chunk },
] as const;

interface Layer {
  readonly role: RoadSurfaceRole;
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  readonly plugin: RoadSurfaceMaterialPlugin;
  readonly slots: RoadSurfaceSlots;
  /** The chunks in reach, nearest first. */
  wanted: readonly string[];
  /** How many of them are not written as the index stands, after the last update's share. */
  pending: number;
  /** The mesh has its buffers (made on the first write, again as the slots grow). */
  buffers: boolean;
  boundsDirty: boolean;
  /** The chunk whose corner is the mesh's origin: the camera's, as of the last crossing. */
  anchorCx: number;
  anchorCz: number;
  /** The mesh holds the warm-up's degenerate triangle. */
  placeholder: boolean;
  /** Its pipelines are built (or the warm-up was declined: capture mode). */
  pipelinesWarm: boolean;
  /** The scene render that last selected the mesh, and the last that drew it (`Mesh.render` to its end). */
  selectedAt: number;
  drawnAt: number;
}

export class RoadSurfaceSystem {
  readonly index = new RoadSurfaceIndex();
  private readonly ribbon: Layer;
  private readonly rail: Layer;
  private ranges: RoadSurfaceRanges;
  private originX = 0;
  private originZ = 0;
  private cameraCx = Number.NaN;
  private cameraCz = Number.NaN;
  private indexVersion = -1;
  private bindings = 0;
  private writes = 0;
  private releases = 0;
  private bufferBuilds = 0;
  private uploadRanges = 0;
  private drawResets = 0;
  /** Steps taken in this update (index steps, chunks built or written), and whether its budget is spent. */
  private frameWork = 0;
  private overBudget = false;
  private updateMilliseconds = 0;
  private draws = 0;
  private warmUps = 0;

  constructor(
    private readonly scene: Scene,
    private readonly terrain: RoadSurfaceTerrain,
    ranges: RoadSurfaceRanges,
    private readonly pipelineWarmUp: PipelineWarmUp | null = null,
  ) {
    this.ranges = ranges;
    this.ribbon = this.createLayer("ribbon");
    this.rail = this.createLayer("rail");
  }

  /** The two meshes, for the receivers (aerial perspective, cloud shadows). */
  get meshes(): readonly Mesh[] {
    return [this.ribbon.mesh, this.rail.mesh];
  }

  get materials(): readonly PBRMaterial[] {
    return [this.ribbon.material, this.rail.material];
  }

  /**
   * Streamed changes not yet in the index, chunks in reach not yet written as
   * it stands, and layers the last frame should have drawn and did not: a
   * capture waits for none.
   */
  get pendingWork(): number {
    return this.index.pendingSteps + this.ribbon.pending + this.rail.pending + this.undrawnLayers;
  }

  private get undrawnLayers(): number {
    return (this.undrawn(this.ribbon) ? 1 : 0) + (this.undrawn(this.rail) ? 1 : 0);
  }

  get statistics(): RoadSurfaceStatistics {
    return {
      regions: this.index.regionCount,
      ribbonChunks: this.ribbon.wanted.length,
      railChunks: this.rail.wanted.length,
      pendingWork: this.pendingWork,
      ribbonVertices: chunkVertices(this.ribbon),
      railVertices: chunkVertices(this.rail),
      draws: this.draws,
      undrawnLayers: this.undrawnLayers,
      warmUps: this.warmUps,
      warmLayers: (this.ribbon.pipelinesWarm ? 1 : 0) + (this.rail.pipelinesWarm ? 1 : 0),
      writes: this.writes,
      releases: this.releases,
      chunkBuilds: this.index.builds,
      bufferBuilds: this.bufferBuilds,
      uploadRanges: this.uploadRanges,
      drawResets: this.drawResets,
      bindings: this.bindings,
      updateMilliseconds: this.updateMilliseconds,
    };
  }

  /** A change to the streamed roads (`RoadStreamRuntime`'s consumers): queued, for the next updates' shares. */
  apply(install: readonly RoadSurfaceRegion[], remove: readonly string[]): void {
    this.index.enqueue(install, remove);
  }

  setRanges(ranges: RoadSurfaceRanges): void {
    if (ranges.roadRibbonRangeMeters === this.ranges.roadRibbonRangeMeters
      && ranges.barrierDrawRangeMeters === this.ranges.barrierDrawRangeMeters) return;
    this.ranges = ranges;
    this.indexVersion = -1;
  }

  setFloatingOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
    for (const layer of [this.ribbon, this.rail]) this.placeLayer(layer);
  }

  /**
   * Once a frame, after the terrain's update: the chunks in reach of the
   * camera at absolute (x, z), this frame's share of writing them, and the
   * drawn ground under them.
   */
  update(cameraX: number, cameraZ: number): void {
    const started = performance.now();
    const deadline = started + ROAD_SURFACE_FRAME_BUDGET_MS;
    this.overBudget = false;
    this.frameWork = this.index.settle(deadline);
    const cx = Math.floor(cameraX / ROAD_RIBBON_CHUNK_METERS);
    const cz = Math.floor(cameraZ / ROAD_RIBBON_CHUNK_METERS);
    if (cx !== this.cameraCx || cz !== this.cameraCz || this.index.version !== this.indexVersion) {
      const crossed = cx !== this.cameraCx || cz !== this.cameraCz;
      this.cameraCx = cx;
      this.cameraCz = cz;
      this.indexVersion = this.index.version;
      this.reach(this.ribbon, cx, cz, this.ranges.roadRibbonRangeMeters, crossed);
      this.reach(this.rail, cx, cz, this.ranges.barrierDrawRangeMeters, crossed);
    }
    this.writeChunks(this.ribbon, deadline);
    this.writeChunks(this.rail, deadline);
    this.draws = 0;
    const arrays = this.terrain.surfaceMaterialArrays;
    const atlas = this.terrain.drawnHeightAtlas;
    const reach = Math.max(
      chunkVertices(this.ribbon) > 0 ? this.ranges.roadRibbonRangeMeters : 0,
      chunkVertices(this.rail) > 0 ? this.ranges.barrierDrawRangeMeters : 0,
    );
    if (reach > 0 && atlas.texture) {
      const radius = reach + ROAD_SURFACE_REACH_SLACK_METERS;
      const lookup = this.terrain.drawnHeight(radius);
      this.terrain.refreshDrawnHeight(cameraX, cameraZ, radius);
      for (const layer of [this.ribbon, this.rail]) {
        if (chunkVertices(layer) === 0) {
          layer.mesh.setEnabled(false);
          continue;
        }
        this.bind(layer, lookup, atlas.texture, atlas.shape);
        if (layer.role === "ribbon") layer.plugin.setArrays(arrays);
        const ready = layer.plugin.ready;
        layer.mesh.setEnabled(ready);
        if (ready) this.draws += 1;
      }
    } else {
      this.ribbon.mesh.setEnabled(false);
      this.rail.mesh.setEnabled(false);
    }
    this.warmUpPipelines(atlas, arrays);
    this.uploadRanges = 0;
    for (const layer of [this.ribbon, this.rail]) this.upload(layer);
    this.updateMilliseconds = performance.now() - started;
  }

  dispose(): void {
    for (const layer of [this.ribbon, this.rail]) {
      layer.mesh.dispose(false, false);
      layer.material.dispose();
    }
  }

  /**
   * The chunks a layer has in reach of the camera's chunk (cx, cz), nearest
   * first; those it no longer has are dropped at once. A crossing moves the
   * mesh's origin to the camera's chunk: a uniform and a position, as each
   * vertex knows its own chunk.
   */
  private reach(layer: Layer, cx: number, cz: number, range: number, crossed: boolean): void {
    layer.wanted = this.index.chunksWithin(cx, cz, range, layer.role);
    layer.pending = layer.wanted.length;
    if (crossed) {
      layer.anchorCx = cx;
      layer.anchorCz = cz;
      layer.boundsDirty = true;
      this.placeLayer(layer);
    }
    const wanted = new Set(layer.wanted);
    for (const key of [...layer.slots.keys()]) {
      if (key === PLACEHOLDER || wanted.has(key)) continue;
      layer.slots.release(key);
      layer.boundsDirty = true;
      this.releases += 1;
    }
  }

  /** This update's share of a layer's chunks not written as the index stands, nearest first. */
  private writeChunks(layer: Layer, deadline: number): void {
    if (layer.pending === 0) return;
    let pending = 0;
    for (const key of layer.wanted) {
      const stamp = this.index.chunkStamp(key);
      const slot = layer.slots.slot(key);
      if (slot && slot.stamp === stamp) continue;
      if (!this.overBudget && this.frameWork > 0 && performance.now() >= deadline) this.overBudget = true;
      if (this.overBudget) {
        pending += 1;
        continue;
      }
      this.frameWork += 1;
      const arrays = this.index.chunkArrays(key, layer.role);
      layer.boundsDirty = true;
      if (!arrays) {
        if (slot) {
          layer.slots.release(key);
          this.releases += 1;
        }
        continue;
      }
      if (layer.placeholder) {
        layer.slots.release(PLACEHOLDER);
        layer.placeholder = false;
      }
      const [kx, kz] = key.split(":").map(Number) as [number, number];
      layer.slots.write(key, stamp, kx, kz, arrays);
      this.writes += 1;
    }
    layer.pending = pending;
  }

  /**
   * Once roads are installed: each layer whose range is on and whose
   * pipelines are not proven built is drawn for `pipelineWarmUp`, its chunks
   * if it has any in reach, else one degenerate triangle, until the warm-up
   * reports it warm (or declines it: capture mode, where every pipeline
   * compiles in its frame as the baselines did).
   */
  /** A layer bound to the lookup, the atlas and its anchor, unless it is already. */
  private bind(layer: Layer, lookup: TerrainDrawnHeight, atlas: BaseTexture, shape: TerrainDrawnAtlasShape): void {
    const bound = layer.plugin.binding;
    if (bound && bound.lookup === lookup && bound.atlas === atlas
      && bound.anchorCx === layer.anchorCx && bound.anchorCz === layer.anchorCz
      && bound.atlasShape.atlasEdge === shape.atlasEdge && bound.atlasShape.slotEdge === shape.slotEdge
      && bound.atlasShape.gutter === shape.gutter && bound.atlasShape.gridEdge === shape.gridEdge) return;
    this.bindings += 1;
    layer.plugin.setBinding({
      lookup,
      atlas,
      atlasShape: shape,
      anchorX: layer.anchorCx * ROAD_RIBBON_CHUNK_METERS,
      anchorZ: layer.anchorCz * ROAD_RIBBON_CHUNK_METERS,
      anchorCx: layer.anchorCx,
      anchorCz: layer.anchorCz,
    });
  }

  private warmUpPipelines(
    atlas: RoadSurfaceTerrain["drawnHeightAtlas"],
    arrays: RoadMaterialArrays | null,
  ): void {
    this.warmUps = 0;
    const warmUp = this.pipelineWarmUp;
    if (!warmUp || !atlas.texture || this.index.regionCount === 0) return;
    for (const layer of [this.ribbon, this.rail]) {
      if (layer.pipelinesWarm) continue;
      const range = layer.role === "ribbon" ? this.ranges.roadRibbonRangeMeters : this.ranges.barrierDrawRangeMeters;
      if (!(range > 0)) continue;
      const chunks = chunkVertices(layer) > 0;
      if (!chunks) {
        if (!layer.placeholder) {
          layer.slots.write(PLACEHOLDER, 0, layer.anchorCx, layer.anchorCz, PLACEHOLDER_ARRAYS);
          layer.placeholder = true;
        }
        this.bind(layer, this.terrain.drawnHeight(range + ROAD_SURFACE_REACH_SLACK_METERS), atlas.texture, atlas.shape);
        if (layer.role === "ribbon") layer.plugin.setArrays(arrays);
      }
      if (!layer.plugin.ready) continue;
      const status = warmUp.warmUp(layer.mesh, false);
      if (status === "warm" || status === "declined") {
        layer.pipelinesWarm = true;
        if (layer.placeholder) {
          layer.slots.release(PLACEHOLDER);
          layer.placeholder = false;
        }
        if (!chunks) layer.mesh.setEnabled(false);
        continue;
      }
      layer.mesh.setEnabled(true);
      this.warmUps += 1;
    }
  }

  /**
   * The ranges this update wrote, into the layer's buffers (all of them on
   * the first write and as the slots grow); the draw covers the slots' end,
   * and the ribbon's bounds are the union of its chunks'.
   */
  private upload(layer: Layer): void {
    const slots = layer.slots;
    const writes = slots.takeWrites();
    const mesh = layer.mesh;
    if (!layer.buffers || writes.grew) {
      if (slots.size === 0) return;
      for (const { kind, array, floats } of VERTEX_ARRAYS) mesh.setVerticesData(kind, slots[array], true, floats);
      mesh.setIndices(slots.indices, slots.vertexCapacity, true);
      layer.buffers = true;
      layer.boundsDirty = true;
      this.bufferBuilds += 1;
    } else {
      for (const range of writes.vertices) {
        for (const { kind, array, floats } of VERTEX_ARRAYS) {
          const start = range.start * floats;
          mesh.getVertexBuffer(kind)!.updateDirectly(slots[array].subarray(start, start + range.count * floats), start);
        }
      }
      const indexBuffer = writes.indices.length > 0 ? mesh.geometry?.getIndexBuffer() : null;
      if (indexBuffer) {
        // Offsets in bytes: the WebGPU engine's `updateDynamicIndexBuffer`.
        const engine = this.scene.getEngine() as WebGPUEngine;
        for (const range of writes.indices) {
          engine.updateDynamicIndexBuffer(
            indexBuffer,
            slots.indices.subarray(range.start, range.start + range.count),
            range.start * Uint32Array.BYTES_PER_ELEMENT,
          );
        }
      }
      this.uploadRanges += writes.vertices.length + writes.indices.length;
    }
    const subMesh = mesh.subMeshes?.[0];
    if (subMesh) {
      // Past the end the indices are all zero: nothing to draw there.
      subMesh.verticesCount = slots.vertexEnd;
      if (subMesh.indexCount !== slots.indexEnd) {
        subMesh.indexCount = slots.indexEnd;
        // Off compatibility mode the engine replays a draw from the bundle it
        // recorded, index count and all, until its draw cache is reset:
        // without this a new range draws the old one (the first in reach).
        mesh.resetDrawCache();
        this.drawResets += 1;
      }
    }
    if (layer.boundsDirty && layer.role === "ribbon") this.bound(layer);
    layer.boundsDirty = false;
  }

  /** The ribbon's bounds round its chunks, relative to its anchor; design heights are within centimetres of the drawn ground. */
  private bound(layer: Layer): void {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const slot of layer.slots.values()) {
      if (slot.key === PLACEHOLDER) continue;
      const offsetX = (slot.cx - layer.anchorCx) * ROAD_RIBBON_CHUNK_METERS;
      const offsetZ = (slot.cz - layer.anchorCz) * ROAD_RIBBON_CHUNK_METERS;
      minimum[0] = Math.min(minimum[0]!, slot.minimum[0] + offsetX);
      minimum[1] = Math.min(minimum[1]!, slot.minimum[1]);
      minimum[2] = Math.min(minimum[2]!, slot.minimum[2] + offsetZ);
      maximum[0] = Math.max(maximum[0]!, slot.maximum[0] + offsetX);
      maximum[1] = Math.max(maximum[1]!, slot.maximum[1]);
      maximum[2] = Math.max(maximum[2]!, slot.maximum[2] + offsetZ);
    }
    if (!(minimum[0]! <= maximum[0]!)) return;
    const info = new BoundingInfo(
      new Vector3(minimum[0], minimum[1]! - 2, minimum[2]),
      new Vector3(maximum[0], maximum[1]! + 2, maximum[2]),
    );
    // A new info's world box is its local one until the world matrix next
    // changes (Babylon only swaps it in), and culling reads the world box.
    info.update(layer.mesh.computeWorldMatrix(true));
    layer.mesh.setBoundingInfo(info);
  }

  /**
   * A layer with chunks in reach that is hidden, or that the last render
   * selected and did not draw (its material not ready for the draw).
   */
  private undrawn(layer: Layer): boolean {
    if (chunkVertices(layer) === 0) return false;
    if (!layer.mesh.isEnabled()) return true;
    return layer.selectedAt === this.scene.getRenderId() && layer.drawnAt !== layer.selectedAt;
  }

  private placeLayer(layer: Layer): void {
    layer.mesh.position.set(
      layer.anchorCx * ROAD_RIBBON_CHUNK_METERS - this.originX,
      0,
      layer.anchorCz * ROAD_RIBBON_CHUNK_METERS - this.originZ,
    );
  }

  private createLayer(role: RoadSurfaceRole): Layer {
    const material = new PBRMaterial(`road-${role}`, this.scene);
    material.metallic = role === "rail" ? ROAD_RAIL_FINISH.metallic : 0;
    material.roughness = role === "rail" ? ROAD_RAIL_FINISH.roughness : 0.86;
    material.albedoColor = role === "rail"
      ? new Color3(...ROAD_RAIL_FINISH.albedo)
      : Color3.White();
    material.metadata = { roadSurface: role };
    if (role === "ribbon") {
      // Depth bias, not lift: the drawn facets under a ribbon never cut it.
      material.zOffset = -1;
      material.zOffsetUnits = -4;
    }
    prepareMaterialForClusteredLighting(material);
    const plugin = new RoadSurfaceMaterialPlugin(material, role);
    const mesh = new Mesh(`road-${role}s`, this.scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    // A rail's baked y is its height above the ground, so its bounds say
    // nothing of where it is drawn; it is one draw within a kilometre.
    if (role === "rail") mesh.alwaysSelectAsActiveMesh = true;
    mesh.metadata = { roadSurface: role, castsShadow: false };
    mesh.setEnabled(false);
    const layer: Layer = {
      role,
      mesh,
      material,
      plugin,
      slots: new RoadSurfaceSlots(slotVertexCapacity(
        role === "ribbon" ? this.ranges.roadRibbonRangeMeters : this.ranges.barrierDrawRangeMeters,
      )),
      wanted: [],
      pending: 0,
      buffers: false,
      boundsDirty: false,
      anchorCx: 0,
      anchorCz: 0,
      placeholder: false,
      pipelinesWarm: false,
      selectedAt: -1,
      drawnAt: -1,
    };
    mesh.onBeforeRenderObservable.add(() => {
      layer.selectedAt = this.scene.getRenderId();
    });
    mesh.onAfterRenderObservable.add(() => {
      layer.drawnAt = this.scene.getRenderId();
    });
    return layer;
  }
}

/**
 * Vertices a layer's slots start with, for its range: 128 a chunk in reach
 * (the busiest perf flight averaged under 80), so they seldom grow, and
 * growing (a whole upload) is the rare frame it costs.
 */
function slotVertexCapacity(range: number): number {
  const chunks = Math.PI * (Math.max(0, range) / ROAD_RIBBON_CHUNK_METERS + 1.5) ** 2;
  return 2 ** Math.ceil(Math.log2(Math.max(1_024, 128 * chunks)));
}

/** Vertices of a layer's chunks, the warm-up's triangle aside. */
function chunkVertices(layer: Layer): number {
  return layer.slots.vertexCount - (layer.placeholder ? PLACEHOLDER_ARRAYS.vertexCount : 0);
}
