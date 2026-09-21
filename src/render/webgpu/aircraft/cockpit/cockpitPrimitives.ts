import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AircraftBuildContext } from "../builders";

/**
 * What every cockpit builder needs and none of them should carry its own copy
 * of: the glareshield's material, the two box-shaped pieces (a thin panel
 * through four corners, and a horizontal strip along a line), and the attitude
 * ball.
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

// ---- the attitude ball ---------------------------------------------------------

/**
 * What one attitude ball is made of. The Global's PFD and the Cessna's attitude
 * dial are the same picture at two sizes, so they share one builder: only the
 * numbers and the names differ.
 */
export interface AttitudeBallSpec {
  /** Names: `${prefix}-sky`, `${prefix}-ground`, `${prefix}-pitch-bar`; the materials `${prefix}-sky`, `-ground`, `-bar`. */
  readonly prefix: string;
  readonly pivotName: string;
  readonly radius: number;
  /** The sky and ground halves' thickness, and the bar's. */
  readonly thickness: number;
  /** The bar stands this far in front of the halves' pilot-side face. */
  readonly barOffset: number;
  readonly barLength: number;
  readonly barHeight: number;
  readonly segments: number;
}

/** What `buildAttitudeBall` makes: the pivot the step turns, and the three pieces under it. */
export interface AttitudeBall {
  readonly pivot: TransformNode;
  readonly sky: Mesh;
  readonly ground: Mesh;
  readonly bar: Mesh;
  /** Sky, ground, bar: the order the pieces were made in. */
  readonly parts: readonly Mesh[];
}

/**
 * A half disc's outline, counter-clockwise with x across and y up. The upper
 * half runs from (r, 0) over the top to (-r, 0); the lower half from (-r, 0)
 * under the bottom to (r, 0). Both close along the diameter on y = 0.
 */
function halfDisc(radius: number, upper: boolean, segments: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (upper ? 0 : Math.PI) + (i / segments) * Math.PI;
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return points;
}

/**
 * THE ATTITUDE BALL: a SKY half, a GROUND half and a thin white PITCH BAR, all
 * children of ONE pivot node at `position` in `parent`'s frame. The step turns
 * the pivot about its own X by the horizon's clockwise-as-seen angle and slides
 * the bar along the pivot's own Y for pitch (`instrumentMappings.ts`).
 *
 * THE PIVOT'S FRAME. Local X points AWAY from the pilot, Y is up the face and Z is
 * the pilot's right; the halves stand in the Y-Z plane and the bar is in front of
 * them, on the pilot's side (local -X). A positive rotation about an axis pointing
 * away from the viewer is CLOCKWISE to him. `parent` must give the pivot that
 * frame: the Global's is the aircraft's own (X is the nose, the pilot looks along
 * it); a dial that faces the pilot at an angle gives it a frame node.
 *
 * IT IS ROUND on purpose. A rotating rectangle would poke out of a dial at every
 * bank angle but zero, and there is no clipping window here; a disc turned about
 * its own centre stays exactly where it was.
 */
export function buildAttitudeBall(
  build: AircraftBuildContext,
  parent: TransformNode,
  position: Vector3,
  spec: AttitudeBallSpec,
): AttitudeBall {
  const sky = build.material(`${spec.prefix}-sky`, 0x6f93ad, {
    roughness: 0.6, metallic: 0, emissive: 0x6f93ad, emissiveIntensity: 0.35,
  });
  const ground = build.material(`${spec.prefix}-ground`, 0x7d5a3a, {
    roughness: 0.6, metallic: 0, emissive: 0x7d5a3a, emissiveIntensity: 0.3,
  });
  const white = build.material(`${spec.prefix}-bar`, 0xf4f7f8, {
    roughness: 0.5, metallic: 0, emissive: 0xffffff, emissiveIntensity: 0.6,
  });
  const pivot = new TransformNode(spec.pivotName, build.scene);
  pivot.parent = parent;
  pivot.position.copyFrom(position);
  // `verticalProfile` extrudes an x-y outline along z; turned a quarter about y
  // the outline's x runs across the dial and its thickness runs fore and aft.
  const halves: Mesh[] = [];
  for (const [name, material, upper] of [
    [`${spec.prefix}-sky`, sky, true],
    [`${spec.prefix}-ground`, ground, false],
  ] as const) {
    const half = build.verticalProfile(name, halfDisc(spec.radius, upper, spec.segments), spec.thickness, material, pivot);
    half.rotation.y = Math.PI / 2;
    halves.push(half);
  }
  const bar = build.box(`${spec.prefix}-pitch-bar`, spec.thickness, spec.barHeight, spec.barLength, white, pivot);
  bar.position.set(-(spec.thickness / 2 + spec.barOffset + spec.thickness / 2), 0, 0);
  return { pivot, sky: halves[0]!, ground: halves[1]!, bar, parts: [halves[0]!, halves[1]!, bar] };
}
