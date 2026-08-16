import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.pure";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.pure";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.pure";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.pure";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";

export interface AircraftMaterialOptions {
  readonly roughness?: number;
  readonly metallic?: number;
  readonly alpha?: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}

export interface PlanformPoint {
  readonly x: number;
  readonly z: number;
}

export interface VerticalProfilePoint {
  readonly x: number;
  readonly y: number;
}

export class AircraftBuildContext {
  readonly meshes: AbstractMesh[] = [];
  readonly materials: Material[] = [];

  constructor(readonly scene: Scene) {}

  material(
    name: string,
    color: number,
    options: AircraftMaterialOptions = {},
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = color3(color);
    material.metallic = options.metallic ?? 0.08;
    material.roughness = options.roughness ?? 0.48;
    if (options.emissive !== undefined) {
      material.emissiveColor = color3(options.emissive);
      material.emissiveIntensity = options.emissiveIntensity ?? 1;
    }
    if (options.alpha !== undefined && options.alpha < 1) {
      material.alpha = options.alpha;
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      // The WebGPU frame graph supplies an explicit reactive/material mask;
      // glass alpha is no longer overloaded as a post-process classifier.
      material.needDepthPrePass = true;
      material.backFaceCulling = false;
    }
    this.materials.push(material);
    return material;
  }

  box(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateBox(name, { width, height, depth }, this.scene),
      material,
      parent,
    );
  }

  cylinder(
    name: string,
    height: number,
    diameterTop: number,
    diameterBottom: number,
    tessellation: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateCylinder(
        name,
        { height, diameterTop, diameterBottom, tessellation },
        this.scene,
      ),
      material,
      parent,
    );
  }

  sphere(
    name: string,
    diameter: number,
    segments: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    return this.finishMesh(
      CreateSphere(name, { diameter, segments }, this.scene),
      material,
      parent,
    );
  }

  torus(
    name: string,
    diameter: number,
    thickness: number,
    tessellation: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const result = this.finishMesh(
      CreateTorus(name, { diameter, thickness, tessellation }, this.scene),
      material,
      parent,
    );
    // Babylon's torus is centred around the Y axis. Aircraft wheels rotate
    // around body +Z, so put the ring in the local X/Y plane.
    result.rotation.x = Math.PI / 2;
    return result;
  }

  planform(
    name: string,
    outline: readonly PlanformPoint[],
    thickness: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (outline.length < 3) throw new RangeError("A planform needs at least three points");
    const halfThickness = thickness * 0.5;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const y of [halfThickness, -halfThickness]) {
      for (const point of outline) positions.push(point.x, y, point.z);
    }
    appendExtrudedIndices(indices, outline.length);
    return this.vertexMesh(name, positions, indices, material, parent);
  }

  verticalProfile(
    name: string,
    outline: readonly VerticalProfilePoint[],
    thickness: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    if (outline.length < 3) throw new RangeError("A vertical profile needs at least three points");
    const halfThickness = thickness * 0.5;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const z of [halfThickness, -halfThickness]) {
      for (const point of outline) positions.push(point.x, point.y, z);
    }
    appendExtrudedIndices(indices, outline.length);
    return this.vertexMesh(name, positions, indices, material, parent);
  }

  strutBetween(
    name: string,
    from: Vector3,
    to: Vector3,
    radius: number,
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const direction = to.subtract(from);
    const length = direction.length();
    if (!Number.isFinite(length) || length < 1e-6) {
      throw new RangeError("Aircraft strut endpoints must be distinct and finite");
    }
    const strut = this.cylinder(
      name,
      length,
      radius * 2,
      radius * 2.16,
      8,
      material,
      parent,
    );
    strut.position.copyFrom(from.add(to).scale(0.5));
    strut.rotationQuaternion = Quaternion.FromUnitVectorsToRef(
      Vector3.UpReadOnly,
      direction.scale(1 / length),
      new Quaternion(),
    );
    return strut;
  }

  disposeMaterials(): void {
    for (const material of this.materials) material.dispose(false, false);
    this.materials.length = 0;
  }

  private vertexMesh(
    name: string,
    positions: number[],
    indices: number[],
    material: Material,
    parent: TransformNode,
  ): Mesh {
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    const mesh = new Mesh(name, this.scene);
    vertexData.applyToMesh(mesh, false);
    mesh.refreshBoundingInfo();
    return this.finishMesh(mesh, material, parent);
  }

  private finishMesh(mesh: Mesh, material: Material, parent: TransformNode): Mesh {
    mesh.material = material;
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.metadata = {
      ...(mesh.metadata as Record<string, unknown> | null),
      aircraftVisual: true,
      castsShadow: true,
    };
    this.meshes.push(mesh);
    return mesh;
  }
}

function color3(color: number): Color3 {
  return Color3.FromInts(
    (color >>> 16) & 0xff,
    (color >>> 8) & 0xff,
    color & 0xff,
  );
}

function appendExtrudedIndices(indices: number[], count: number): void {
  for (let index = 1; index < count - 1; index += 1) {
    indices.push(0, index, index + 1);
    indices.push(count, count + index + 1, count + index);
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, count + next, index, count + next, count + index);
  }
}

