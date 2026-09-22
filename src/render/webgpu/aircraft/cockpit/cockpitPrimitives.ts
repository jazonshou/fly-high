import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
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

/**
 * An outline wound CLOCKWISE in its own x/y, whichever way it was handed in, for
 * `AircraftBuildContext.verticalProfile`.
 *
 * THE TRAP. `verticalProfile` extrudes an outline and does NOT reverse its triangles,
 * and Babylon's right-handed normal is the inverse of the mathematical one, so an outline
 * wound COUNTER-clockwise is built INSIDE OUT: the GPU culls the faces the pilot faces and
 * draws the far faces from inside, lit by normals pointing into the solid (the same trap
 * `trainerVisual.ts`'s fin and `bizjetVisual.ts`'s pylons fell into). A ray cast cannot see
 * it: it hits a triangle whichever way it faces. `tests/render.cockpit-drawn-faces.test.ts`
 * asks the question the GPU asks, and this is what every outline here goes through.
 */
export function clockwise<T extends { readonly x: number; readonly y: number }>(outline: readonly T[]): T[] {
  let twiceArea = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  // a positive signed area is counter-clockwise
  return twiceArea > 0 ? [...outline].reverse() : [...outline];
}

/**
 * A thin plate the GPU draws from every side it should be drawn from, and shades flat.
 *
 * `clockwise` fixes a plate's CAPS, and `AircraftBuildContext.verticalProfile` still winds its
 * thin EDGE WALLS the opposite way to its caps (a shared-builder defect on the plane engineer's
 * register, not fixed here): with the caps right, the walls a pilot standing beside a plate can
 * see are culled, and the plate reads as a shell with one side missing. So this makes the
 * winding right BY GEOMETRY and does not rely on the builder's index order, so the winding step
 * swaps nothing on a triangle the builder has wound correctly.
 *
 * THE RULE, measured on a `build.box` face that visibly renders: a drawn face's cross product
 * `(b - a) x (c - a)` points INTO the solid. For each triangle, if it points out (its dot with
 * the vector to the solid's centroid is negative), swap two vertices. The centroid of the
 * vertices is inside a CONVEX solid, which is all `verticalProfile` can extrude anyway (its
 * fan triangulation needs a convex outline), and nothing here is a concave plate.
 *
 * FLAT NORMALS, while it is here: each triangle gets three vertices of its own, with the
 * normal pointing OUT of the solid. The builder shares each outline vertex between a cap and
 * two walls, so its computed normals average faces at right angles (and, before the winding
 * was right, faces wound opposite ways); on a plate that fills a fifth of the frame that shades
 * like a pillow. A box is flat-shaded, and a plate should be too. Three vertices a triangle
 * is only worth it because a plate has a dozen of them.
 *
 * Use it for every plate AND the attitude ball's halves. The halves once went through `clockwise`
 * alone on the argument that their 2 mm rim is never the nearest face; a grid of rays offset by
 * a fraction of a degree found it was, for one to three rays of the two dozen that touch a half,
 * on all three aircraft. The rim wall is the builder's mis-wound kind, and this is what fixes it.
 */
export function solidPlate(
  build: AircraftBuildContext,
  name: string,
  outline: readonly { readonly x: number; readonly y: number }[],
  thickness: number,
  material: PBRMaterial,
  parent: TransformNode,
): Mesh {
  const mesh = build.verticalProfile(name, clockwise(outline), thickness, material, parent);
  const kinds = [...mesh.getVerticesDataKinds()].sort();
  if (kinds.join(",") !== [VertexBuffer.NormalKind, VertexBuffer.PositionKind, VertexBuffer.UVKind].sort().join(",")) {
    throw new Error(`solidPlate "${name}": expected position, normal and uv, found ${kinds.join(", ")}`);
  }
  const source = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const uvSource = mesh.getVerticesData(VertexBuffer.UVKind)!;
  const indices = mesh.getIndices()!;
  const point = (index: number) => new Vector3(source[index * 3]!, source[index * 3 + 1]!, source[index * 3 + 2]!);
  // in the mesh's LOCAL space, before any orient() or rotation; a proper rotation changes none of it
  const centroid = new Vector3();
  for (let i = 0; i < source.length / 3; i += 1) centroid.addInPlace(point(i));
  centroid.scaleInPlace(3 / source.length);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const out: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const a = point(corners[0]!);
    const b = point(corners[1]!);
    const c = point(corners[2]!);
    let cross = Vector3.Cross(b.subtract(a), c.subtract(a));
    const centre = a.add(b).add(c).scale(1 / 3);
    if (Vector3.Dot(cross, centroid.subtract(centre)) < 0) {
      corners.push(corners.splice(1, 1)[0]!); // swap the last two: [a, b, c] -> [a, c, b]
      cross = cross.scale(-1);
    }
    // after the swap the cross product points INTO the solid, and a shading normal points OUT of it
    const normal = cross.normalize().scale(-1);
    for (const corner of corners) {
      positions.push(source[corner * 3]!, source[corner * 3 + 1]!, source[corner * 3 + 2]!);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(uvSource[corner * 2]!, uvSource[corner * 2 + 1]!);
      out.push(out.length);
    }
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = out;
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
  return mesh;
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
 * What one attitude ball is made of. It was one builder for three aeroplanes (the
 * Global's and the 747's PFDs, and the Cessna's attitude dial, the same picture at
 * different sizes); the two glass decks' PFD pages draw attitude now, and only the
 * Cessna's MECHANICAL ball still uses it.
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
 * frame: a dial that faces straight aft could use the aircraft's own (X is the nose,
 * the pilot looks along it), as the glass decks' balls did; the Cessna's faces the
 * pilot at an angle and gives it a frame node.
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
    // A `solidPlate`, run here in the half's LOCAL space, BEFORE the quarter-turn about y below (a proper
    // rotation changes none of what it computes, but the order is the rule, as for `orient`). The halves
    // were built inside out until then, and with only `clockwise` their 2 mm arc rim was still culled: on a
    // 0.1 degree grid the rim is the nearest face for up to 4 percent of the rays that touch a half (75 of
    // 1,949 on the 747's ground half).
    const half = solidPlate(build, name, halfDisc(spec.radius, upper, spec.segments), spec.thickness, material, pivot);
    half.rotation.y = Math.PI / 2;
    halves.push(half);
  }
  const bar = build.box(`${spec.prefix}-pitch-bar`, spec.thickness, spec.barHeight, spec.barLength, white, pivot);
  bar.position.set(-(spec.thickness / 2 + spec.barOffset + spec.thickness / 2), 0, 0);
  return { pivot, sky: halves[0]!, ground: halves[1]!, bar, parts: [halves[0]!, halves[1]!, bar] };
}
