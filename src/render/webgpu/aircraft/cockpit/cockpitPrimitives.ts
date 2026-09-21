import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AircraftBuildContext } from "../builders";

/**
 * The two box-shaped pieces every cockpit builder needs and none of them should
 * carry its own copy of: a thin panel through four corners, and a horizontal
 * strip along a line.
 */

/** Orient a box so its local X, Y, Z axes point along the given orthonormal basis. */
export function orient(mesh: AbstractMesh, xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): void {
  const matrix = Matrix.FromValues(
    xAxis.x, xAxis.y, xAxis.z, 0,
    yAxis.x, yAxis.y, yAxis.z, 0,
    zAxis.x, zAxis.y, zAxis.z, 0,
    0, 0, 0, 1,
  );
  mesh.rotationQuaternion = Quaternion.FromRotationMatrix(matrix);
}

/**
 * A thin panel through four corners: the bottom edge `a0 -> a1` and the top
 * edge `b0 -> b1`, which must run the same way. The mid-plane passes through
 * the corners; thickness is symmetric about it.
 */
export function slab(
  build: AircraftBuildContext,
  name: string,
  material: PBRMaterial,
  root: TransformNode,
  a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3,
  thickness: number,
): Mesh {
  const xAxis = a1.subtract(a0);
  const length = xAxis.length();
  xAxis.normalize();
  const rise = b0.subtract(a0);
  const yAxis = rise.subtract(xAxis.scale(Vector3.Dot(rise, xAxis)));
  const height = yAxis.length();
  yAxis.normalize();
  const zAxis = Vector3.Cross(xAxis, yAxis);
  const mesh = build.box(name, length, height, thickness, material, root);
  mesh.position.copyFrom(a0.add(a1).add(b0).add(b1).scale(0.25));
  orient(mesh, xAxis, yAxis, zAxis);
  return mesh;
}

/** A horizontal strip along `from -> to`, `width` across (horizontal) and `thickness` deep (vertical). */
export function strip(
  build: AircraftBuildContext,
  name: string,
  material: PBRMaterial,
  root: TransformNode,
  from: Vector3, to: Vector3,
  width: number, thickness: number,
): Mesh {
  const xAxis = to.subtract(from);
  const length = xAxis.length();
  xAxis.normalize();
  const yAxis = Vector3.Up();
  const zAxis = Vector3.Cross(xAxis, yAxis);
  zAxis.normalize();
  const mesh = build.box(name, length, thickness, width, material, root);
  mesh.position.copyFrom(from.add(to).scale(0.5));
  orient(mesh, xAxis, Vector3.Cross(zAxis, xAxis), zAxis);
  return mesh;
}
