import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
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
import {
  RoadSurfaceIndex,
  mergeRoadSurfaceChunks,
  type RoadSurfaceLayer,
  type RoadSurfaceRegion,
} from "./RoadSurfaceIndex";
import { ROAD_RIBBON_CHUNK_METERS, roadRibbonChunkOf } from "./roadSurfaceGeometry";

/**
 * The roads' ribbons and guardrails near the camera: TWO draws at most (one
 * mesh each) and none while nothing is in reach.
 *
 * WHAT IS DRAWN. Every 128 m chunk (`RoadSurfaceIndex`) whose square lies
 * within the tier's `roadRibbonRangeMeters` (ribbons) or
 * `barrierDrawRangeMeters` (rails) of the camera's chunk, merged into one
 * mesh per layer. The set is decided per chunk, so it changes only as the
 * camera crosses a chunk edge or the roads change, and a merge copies arrays
 * each chunk built once.
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
  readonly ribbonChunks: number;
  readonly railChunks: number;
  readonly ribbonVertices: number;
  readonly railVertices: number;
  /** Meshes drawn this frame (0-2). */
  readonly draws: number;
  /** Layers drawing their pipeline warm-up this frame (0-2), and layers whose pipelines are proven built. */
  readonly warmUps: number;
  readonly warmLayers: number;
  readonly merges: number;
  readonly chunkBuilds: number;
  /** Main-thread time of the last update, and of the last merge, milliseconds. */
  readonly updateMilliseconds: number;
  readonly mergeMilliseconds: number;
}

interface Layer {
  readonly role: RoadSurfaceRole;
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  readonly plugin: RoadSurfaceMaterialPlugin;
  chunks: string;
  vertices: number;
  anchorX: number;
  anchorZ: number;
  /** The mesh holds the warm-up's degenerate triangle, not chunks. */
  placeholder: boolean;
  /** Its pipelines are built (or the warm-up was declined: capture mode). */
  pipelinesWarm: boolean;
}

export class RoadSurfaceSystem {
  readonly index = new RoadSurfaceIndex();
  private readonly ribbon: Layer;
  private readonly rail: Layer;
  private ranges: RoadSurfaceRanges;
  private originX = 0;
  private originZ = 0;
  private cameraChunk = "";
  private indexVersion = -1;
  private merges = 0;
  private updateMilliseconds = 0;
  private mergeMilliseconds = 0;
  private draws = 0;
  private warmUps = 0;
  private ribbonChunks = 0;
  private railChunks = 0;

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

  get statistics(): RoadSurfaceStatistics {
    return {
      regions: this.index.regionCount,
      ribbonChunks: this.ribbonChunks,
      railChunks: this.railChunks,
      ribbonVertices: this.ribbon.vertices,
      railVertices: this.rail.vertices,
      draws: this.draws,
      warmUps: this.warmUps,
      warmLayers: (this.ribbon.pipelinesWarm ? 1 : 0) + (this.rail.pipelinesWarm ? 1 : 0),
      merges: this.merges,
      chunkBuilds: this.index.builds,
      updateMilliseconds: this.updateMilliseconds,
      mergeMilliseconds: this.mergeMilliseconds,
    };
  }

  /** A change to the streamed roads (`RoadStreamRuntime`'s consumers). */
  apply(install: readonly RoadSurfaceRegion[], remove: readonly string[]): void {
    this.index.apply(install, remove);
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
   * camera at absolute (x, z), and the drawn ground under them.
   */
  update(cameraX: number, cameraZ: number): void {
    const started = performance.now();
    const { cx, cz } = roadRibbonChunkOf(cameraX, cameraZ);
    const chunk = `${cx}:${cz}`;
    if (chunk !== this.cameraChunk || this.index.version !== this.indexVersion) {
      this.cameraChunk = chunk;
      this.indexVersion = this.index.version;
      const mergeStarted = performance.now();
      const ribbon = this.index.chunksWithin(cx, cz, this.ranges.roadRibbonRangeMeters, "ribbon");
      const rail = this.index.chunksWithin(cx, cz, this.ranges.barrierDrawRangeMeters, "rail");
      this.ribbonChunks = ribbon.length;
      this.railChunks = rail.length;
      const ribbonMerged = this.rebuild(this.ribbon, ribbon, cx, cz, "ribbon");
      const railMerged = this.rebuild(this.rail, rail, cx, cz, "rail");
      if (ribbonMerged || railMerged) this.mergeMilliseconds = performance.now() - mergeStarted;
    }
    this.draws = 0;
    const arrays = this.terrain.surfaceMaterialArrays;
    const atlas = this.terrain.drawnHeightAtlas;
    const reach = Math.max(
      this.ribbon.vertices > 0 ? this.ranges.roadRibbonRangeMeters : 0,
      this.rail.vertices > 0 ? this.ranges.barrierDrawRangeMeters : 0,
    );
    if (reach > 0 && atlas.texture) {
      const radius = reach + ROAD_SURFACE_REACH_SLACK_METERS;
      const lookup = this.terrain.drawnHeight(radius);
      this.terrain.refreshDrawnHeight(cameraX, cameraZ, radius);
      for (const layer of [this.ribbon, this.rail]) {
        if (layer.vertices === 0) {
          layer.mesh.setEnabled(false);
          continue;
        }
        layer.plugin.setBinding({
          lookup,
          atlas: atlas.texture,
          atlasShape: atlas.shape,
          anchorX: layer.anchorX,
          anchorZ: layer.anchorZ,
        });
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
    this.updateMilliseconds = performance.now() - started;
  }

  dispose(): void {
    for (const layer of [this.ribbon, this.rail]) {
      layer.mesh.dispose(false, false);
      layer.material.dispose();
    }
  }

  /**
   * Once roads are installed: each layer whose range is on and whose
   * pipelines are not proven built is drawn for `pipelineWarmUp`, its chunks
   * if it has any in reach, else one degenerate triangle, until the warm-up
   * reports it warm (or declines it: capture mode, where every pipeline
   * compiles in its frame as the baselines did).
   */
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
      if (layer.vertices === 0) {
        if (!layer.placeholder) {
          applyPlaceholder(layer.mesh);
          layer.placeholder = true;
        }
        layer.plugin.setBinding({
          lookup: this.terrain.drawnHeight(range + ROAD_SURFACE_REACH_SLACK_METERS),
          atlas: atlas.texture,
          atlasShape: atlas.shape,
          anchorX: layer.anchorX,
          anchorZ: layer.anchorZ,
        });
        if (layer.role === "ribbon") layer.plugin.setArrays(arrays);
      }
      if (!layer.plugin.ready) continue;
      const status = warmUp.warmUp(layer.mesh, false);
      if (status === "warm" || status === "declined") {
        layer.pipelinesWarm = true;
        if (layer.vertices === 0) layer.mesh.setEnabled(false);
        continue;
      }
      layer.mesh.setEnabled(true);
      this.warmUps += 1;
    }
  }

  /** Merge a layer's chunks into its mesh if the set or any of them changed; whether it did. */
  private rebuild(layer: Layer, keys: readonly string[], cx: number, cz: number, kind: RoadSurfaceLayer): boolean {
    const chunks: { key: string; arrays: NonNullable<ReturnType<RoadSurfaceIndex["chunkArrays"]>> }[] = [];
    for (const key of [...keys].sort()) {
      const arrays = this.index.chunkArrays(key, kind);
      if (arrays) chunks.push({ key, arrays });
    }
    // The same chunks, built from the same version, are the same arrays.
    const signature = `${this.index.version}|${chunks.map((chunk) => chunk.key).join(",")}`;
    if (signature === layer.chunks) return false;
    layer.chunks = signature;
    this.merges += 1;
    const anchorX = cx * ROAD_RIBBON_CHUNK_METERS;
    const anchorZ = cz * ROAD_RIBBON_CHUNK_METERS;
    const merged = mergeRoadSurfaceChunks(chunks, anchorX, anchorZ);
    layer.anchorX = anchorX;
    layer.anchorZ = anchorZ;
    if (!merged) {
      layer.vertices = 0;
      layer.mesh.setEnabled(false);
      return true;
    }
    const data = new VertexData();
    data.positions = merged.positions;
    data.normals = merged.normals;
    data.indices = merged.indices;
    data.applyToMesh(layer.mesh, true);
    layer.mesh.setVerticesData("roadSurface", merged.surface, true, 4);
    layer.vertices = merged.vertexCount;
    layer.placeholder = false;
    if (layer.role === "ribbon") {
      // Design heights are within centimetres of the drawn ground.
      layer.mesh.setBoundingInfo(new BoundingInfo(
        new Vector3(merged.minimum[0], merged.minimum[1] - 2, merged.minimum[2]),
        new Vector3(merged.maximum[0], merged.maximum[1] + 2, merged.maximum[2]),
      ));
    }
    this.placeLayer(layer);
    return true;
  }

  private placeLayer(layer: Layer): void {
    layer.mesh.position.set(layer.anchorX - this.originX, 0, layer.anchorZ - this.originZ);
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
    return {
      role, mesh, material, plugin, chunks: "", vertices: 0, anchorX: 0, anchorZ: 0, placeholder: false, pipelinesWarm: false,
    };
  }
}

/** One triangle of no area at the anchor, in a chunk's vertex layout: draws no fragment, builds every pipeline. */
function applyPlaceholder(mesh: Mesh): void {
  const data = new VertexData();
  data.positions = new Float32Array(9);
  data.normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  data.indices = new Uint32Array([0, 1, 2]);
  data.applyToMesh(mesh, true);
  mesh.setVerticesData("roadSurface", new Float32Array(12), true, 4);
}
