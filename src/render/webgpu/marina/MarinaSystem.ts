import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { MarinaLayout } from "@/src/world/marinaLayout";
import { prepareMaterialForClusteredLighting } from "../lighting/ClusteredLighting";
import type { LightPointFixture } from "../lighting/LightPoints";
import {
  buildMarinaSilhouette,
  buildMooredRunaboutGeometry,
  marinaBoatInstances,
  marinaBoxInstances,
  marinaLampColours,
  marinaLamps,
  marinaLevelOfDetail,
  marinaPostInstances,
  marinaUnitBox,
  marinaUnitCylinder,
  type MarinaColouredGeometry,
  type MarinaInstances,
  type MarinaLamps,
  type MarinaLevelOfDetail,
} from "./marinaVisual";

/** What the marina takes from the quality profile: data, never a tier branch. */
export interface MarinaSystemOptions {
  /** Whether the near meshes (boxes, posts, boats) cast sun shadows. */
  readonly castsShadows: boolean;
}

export interface MarinaSystemStatistics {
  readonly level: MarinaLevelOfDetail | null;
  readonly boxes: number;
  readonly posts: number;
  readonly boats: number;
  readonly lamps: number;
  /** Meshes enabled now: what the marina adds to a frame's beauty draws. */
  readonly enabledMeshes: number;
}

/**
 * The home marina on the GPU (`marinaVisual.ts` has the parts): three
 * thin-instanced meshes near, one merged silhouette beyond 1.5 km, nothing
 * beyond 4 km, and lamps that ride the airfield's light draw.
 *
 * DRAWS. Near, at most 3 beauty draws plus 3 casters per cascade where the
 * tier casts (9 at two cascades); between the switches, 1; culled, 0. The
 * lamps add none: `lampFixtures` are appended to the airfield's
 * `LightPointSystem` at startup, and `update` says when their colours (the
 * beacons' flashes, the cull) need writing back with `setColorRange`.
 *
 * NOTHING COMPILES IN FLIGHT. Every mesh exists, enabled, when the renderer
 * awaits scene readiness, and the first frame draws all four (pinned active)
 * so their pipelines are made then; the level of detail applies from the
 * second frame on.
 */
export class MarinaSystem {
  readonly root: TransformNode;
  /** Every mesh, for the haze and cloud-shadow registries. */
  readonly meshes: readonly Mesh[];
  /** The near meshes, when the tier casts; empty otherwise. */
  readonly shadowCasters: readonly Mesh[];
  /** Absolute-position fixtures for the airfield's light draw: lamps, then beacons. */
  readonly lampFixtures: readonly LightPointFixture[];
  private readonly lamps: MarinaLamps;
  private readonly colours: (readonly [number, number, number])[] = [];
  private readonly near: readonly Mesh[];
  private readonly silhouette: Mesh;
  private readonly structureMaterial: PBRMaterial;
  private readonly boatMaterial: PBRMaterial;
  private level: MarinaLevelOfDetail | null = null;
  private warmed = false;
  private readonly counts: { boxes: number; posts: number; boats: number };

  constructor(scene: Scene, private readonly layout: MarinaLayout, options: MarinaSystemOptions) {
    this.root = new TransformNode("marina", scene);
    this.structureMaterial = marinaMaterial(scene, "marina-structure", 0.86);
    this.boatMaterial = marinaMaterial(scene, "marina-boat", 0.38);

    const boxes = marinaBoxInstances(layout);
    const posts = marinaPostInstances(layout);
    const boats = marinaBoatInstances(layout);
    this.counts = { boxes: boxes.count, posts: posts.count, boats: boats.count };
    // A batch with no instances gets no mesh: a thin-instanced mesh with none
    // would draw its unit shape once at the root instead of nothing.
    const near: Mesh[] = [];
    const batch = (name: string, shape: () => VertexData, instances: MarinaInstances, material: PBRMaterial) => {
      if (instances.count > 0) near.push(instancedMesh(scene, name, shape(), instances, material, this.root, options.castsShadows));
    };
    batch("marina-boxes", marinaUnitBox, boxes, this.structureMaterial);
    batch("marina-posts", marinaUnitCylinder, posts, this.structureMaterial);
    batch("marina-boats", () => colouredVertexData(buildMooredRunaboutGeometry()), boats, this.boatMaterial);
    this.near = Object.freeze(near);
    this.silhouette = new Mesh("marina-silhouette", scene);
    colouredVertexData(buildMarinaSilhouette(layout)).applyToMesh(this.silhouette, false);
    finishMesh(this.silhouette, this.structureMaterial, this.root, false);

    this.meshes = Object.freeze([...this.near, this.silhouette]);
    this.shadowCasters = options.castsShadows ? this.near : Object.freeze([]);

    this.lamps = marinaLamps(layout);
    this.lampFixtures = this.lamps.fixtures;
    marinaLampColours(layout, this.lamps, 0, true, this.colours);
    this.setFloatingOrigin(0, 0);
  }

  /** The marina's fixtures' colours now, one per `lampFixtures` entry. */
  get lampColours(): readonly (readonly [number, number, number])[] {
    return this.colours;
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.root.position.set(this.layout.site.x - originX, 0, this.layout.site.z - originZ);
  }

  /**
   * Once per frame with the camera's WORLD position and the simulation
   * clock: picks the level of detail and steps the beacons. Returns true when
   * the lamp colours changed and the light draw needs them.
   */
  update(cameraX: number, cameraY: number, cameraZ: number, simulationTimeSeconds: number): boolean {
    const distance = Math.hypot(cameraX - this.layout.site.x, cameraY - this.layout.seaLevel, cameraZ - this.layout.site.z);
    const level = marinaLevelOfDetail(distance, this.level);
    if (!this.warmed) {
      // The first frame draws everything, pinned active, so every pipeline is
      // made behind the load screen rather than on the first approach.
      this.warmed = true;
      for (const mesh of this.meshes) {
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.setEnabled(true);
      }
    } else if (level !== this.level) {
      this.level = level;
      for (const mesh of this.near) {
        mesh.alwaysSelectAsActiveMesh = false;
        mesh.setEnabled(level === "detail");
      }
      this.silhouette.alwaysSelectAsActiveMesh = false;
      this.silhouette.setEnabled(level === "silhouette");
    }
    return marinaLampColours(this.layout, this.lamps, simulationTimeSeconds, level !== "culled", this.colours);
  }

  get statistics(): MarinaSystemStatistics {
    return {
      level: this.level,
      ...this.counts,
      lamps: this.lampFixtures.length,
      enabledMeshes: this.meshes.filter((mesh) => mesh.isEnabled(false)).length,
    };
  }

  dispose(): void {
    this.root.dispose(false, false);
    this.structureMaterial.dispose();
    this.boatMaterial.dispose();
  }
}

/** A dielectric PBR material whose albedo is the vertex or instance colour. */
function marinaMaterial(scene: Scene, name: string, roughness: number): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = Color3.White();
  material.metallic = 0;
  material.roughness = roughness;
  material.metadata = { marinaMaterial: true };
  prepareMaterialForClusteredLighting(material);
  return material;
}

function colouredVertexData(geometry: MarinaColouredGeometry): VertexData {
  const data = new VertexData();
  data.positions = geometry.positions;
  data.normals = geometry.normals;
  data.colors = geometry.colors;
  data.indices = geometry.indices;
  return data;
}

function finishMesh(mesh: Mesh, material: PBRMaterial, parent: TransformNode, castsShadow: boolean): void {
  mesh.material = material;
  mesh.parent = parent;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.metadata = { marina: true, castsShadow };
}

function instancedMesh(
  scene: Scene,
  name: string,
  shape: VertexData,
  instances: MarinaInstances,
  material: PBRMaterial,
  parent: TransformNode,
  castsShadow: boolean,
): Mesh {
  const mesh = new Mesh(name, scene);
  shape.applyToMesh(mesh, false);
  finishMesh(mesh, material, parent, castsShadow);
  mesh.thinInstanceSetBuffer("matrix", instances.matrices, 16, true);
  mesh.thinInstanceSetBuffer("color", instances.colors, 4, true);
  mesh.thinInstanceRefreshBoundingInfo(false);
  return mesh;
}
