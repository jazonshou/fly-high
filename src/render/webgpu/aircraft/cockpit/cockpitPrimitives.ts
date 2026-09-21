import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AircraftBuildContext } from "../builders";

/**
 * What every cockpit builder needs and none of them should carry its own copy
 * of: the glareshield's material, and the two box-shaped pieces (a thin panel
 * through four corners, and a horizontal strip along a line).
 */

/**
 * A glareshield's material: matte near-black that reflects nothing. Its top face
 * is the one interior surface lying at a grazing angle to the eye under an open
 * sky, so on the ordinary interior material (rough dielectric, lit by the sky's
 * image-based light) it read as a pale grey-blue shelf, the brightest thing in
 * the frame. Roughness 1, no clearcoat, F0 and F90 both zero
 * (`metallicF0Factor` 0) and no image-based light (`environmentIntensity` 0):
 * only the sun and the lamps light it, and at this albedo (about 0.06 a channel,
 * darker than the interior's 0.1 to 0.16) that is a near-black.
 */
export function glareshieldMaterial(build: AircraftBuildContext, name: string): PBRMaterial {
  const material = build.material(name, 0x0e1012, { roughness: 1, metallic: 0 });
  material.environmentIntensity = 0;
  material.metallicF0Factor = 0;
  return material;
}

/** The rotation that takes local X, Y, Z onto the given orthonormal, right-handed basis. */
export function basisQuaternion(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): Quaternion {
  const matrix = Matrix.FromValues(
    xAxis.x, xAxis.y, xAxis.z, 0,
    yAxis.x, yAxis.y, yAxis.z, 0,
    zAxis.x, zAxis.y, zAxis.z, 0,
    0, 0, 0, 1,
  );
  return Quaternion.FromRotationMatrix(matrix);
}

/** Orient a box so its local X, Y, Z axes point along the given orthonormal basis. */
export function orient(mesh: AbstractMesh, xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): void {
  mesh.rotationQuaternion = basisQuaternion(xAxis, yAxis, zAxis);
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
