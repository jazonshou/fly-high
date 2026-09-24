import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { COCKPIT_GLOW_NIGHT_MULTIPLE } from "../../lighting/AircraftLighting";
import type { AircraftBuildContext } from "../builders";

/**
 * What every cockpit builder needs and none of them should carry its own copy
 * of: the glareshield's material, the two box-shaped pieces (a thin panel
 * through four corners, and a horizontal strip along a line), and the attitude
 * ball.
 */

/**
 * How much of the sky's image-based light a glareshield takes: all of it, as every other
 * surface does. What it must not take is the sky's REFLECTION, and `metallicF0Factor` 0
 * already removes that (F0 and F90 both zero), so this only lets the sky LIGHT it.
 */
export const GLARESHIELD_IMAGE_LIGHT = 1;

/**
 * A glareshield's material: matte near-black that reflects nothing. Its top face
 * is the one interior surface lying at a grazing angle to the eye under an open
 * sky, so on the ordinary interior material (rough dielectric, lit by the sky's
 * image-based light) it read as a pale grey-blue shelf, the brightest thing in
 * the frame. That shelf was the sky REFLECTED at a grazing angle: roughness 1, no
 * clearcoat and F0 and F90 both zero (`metallicF0Factor` 0) take it away.
 *
 * It keeps the sky's diffuse light (`GLARESHIELD_IMAGE_LIGHT`). With none, only the
 * sun and the lamps lit it, and every face the sun missed rendered (0, 0, 0): the
 * F-16's coaming face and HUD frame read as a black slab with a black doorway on it,
 * and the 747's pillar read as a void before it moved to the interior material.
 * Measured live at one frozen pose per deck (docs/findings/COCKPIT_VIEW_2026_09_20.md),
 * the shaded faces go from 0-17 to 15-28 (of 255, luma) and the sunlit tops rise 10%.
 * A "small" term was tried first and is too small: at a fifth of the sky's light the
 * F-16's coaming face read 4.6, at half 10. At this albedo (about 0.06 a channel,
 * darker than the interior's 0.1 to 0.16) it is still a near-black.
 */
export function glareshieldMaterial(build: AircraftBuildContext, name: string): PBRMaterial {
  const material = build.material(name, 0x0e1012, { roughness: 1, metallic: 0 });
  material.environmentIntensity = GLARESHIELD_IMAGE_LIGHT;
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
  return solidified(build.verticalProfile(name, clockwise(outline), thickness, material, parent));
}

/**
 * The winding-by-geometry half of `solidPlate`, for a CONVEX closed mesh some other builder made:
 * every triangle rewound so its cross product points into the solid, three vertices of its own,
 * a flat normal pointing out, and each corner's UV carried over, so positions and texturing are
 * exactly what the builder made and only the faces' orientation and shading change. Rewrites the
 * mesh in place and returns it.
 *
 * `build.planform` has the same defect as `verticalProfile` (its thin edge walls wound against its
 * caps), and a planform's walls are therefore see-through from outside: the Cessna's cabin roof
 * showed whatever was inside its slab at grazing angles. It goes through here.
 */
export function solidified(mesh: Mesh): Mesh {
  const name = mesh.name;
  const kinds = [...mesh.getVerticesDataKinds()].sort();
  if (kinds.join(",") !== [VertexBuffer.NormalKind, VertexBuffer.PositionKind, VertexBuffer.UVKind].sort().join(",")) {
    throw new Error(`solidified "${name}": expected position, normal and uv, found ${kinds.join(", ")}`);
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

/**
 * Move every vertex of a `solidPlate` and keep it a solid the GPU draws.
 *
 * `verticalProfile` extrudes ONE outline at ONE thickness, so a plate is a prism: the same
 * section from end to end. A coaming is not. The F-16's is a wedge whose plan narrows from
 * the panel to its far edge, so it is built as a plate at its widest and then SCULPTED: each
 * vertex moved by `move` (in the mesh's own local space), every triangle's flat normal
 * rewritten from its new corners, and the winding re-checked by the same rule `solidPlate`
 * used (a drawn face's cross product points INTO the solid). A move that turned a triangle
 * inside out throws rather than shipping a face the GPU culls, which is what a silent
 * re-wind would hide: the drawn-faces test would then be the first to know, and this is
 * earlier.
 *
 * Only for a mesh `solidPlate` made: three vertices of its own to a triangle, indices in
 * order, so a per-triangle normal has nothing to share. Convexity is the caller's: the
 * centroid rule that decides "into the solid" needs the centroid inside.
 */
export function sculptSolid(mesh: Mesh, move: (point: Vector3) => Vector3): void {
  const source = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvSource = mesh.getVerticesData(VertexBuffer.UVKind);
  const indices = mesh.getIndices();
  if (!source || !uvSource || !indices) throw new Error(`sculptSolid "${mesh.name}": expected position, uv and indices`);
  for (let i = 0; i < indices.length; i += 1) {
    if (indices[i] !== i) throw new Error(`sculptSolid "${mesh.name}": expected a solidPlate mesh (three vertices of its own to a triangle)`);
  }
  const moved: Vector3[] = [];
  for (let i = 0; i < source.length / 3; i += 1) {
    moved.push(move(new Vector3(source[i * 3]!, source[i * 3 + 1]!, source[i * 3 + 2]!)));
  }
  const centroid = new Vector3();
  for (const point of moved) centroid.addInPlace(point);
  centroid.scaleInPlace(1 / moved.length);
  const positions: number[] = [];
  const normals: number[] = [];
  for (let t = 0; t + 2 < moved.length; t += 3) {
    const a = moved[t]!;
    const b = moved[t + 1]!;
    const c = moved[t + 2]!;
    const cross = Vector3.Cross(b.subtract(a), c.subtract(a));
    const centre = a.add(b).add(c).scale(1 / 3);
    if (Vector3.Dot(cross, centroid.subtract(centre)) < 0) {
      throw new Error(`sculptSolid "${mesh.name}": the move turned triangle ${t / 3} inside out`);
    }
    // the same convention as solidPlate: the cross product points INTO the solid, the shading normal OUT of it
    const normal = cross.normalize().scale(-1);
    for (const corner of [a, b, c]) {
      positions.push(corner.x, corner.y, corner.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = [...uvSource];
  data.indices = [...indices];
  data.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
}

/**
 * A ROUNDED DECK's design: a glareshield whose aft edge is a round on the deck line's sight line, a drop and a 45
 * degree cove under it to the panel's face, and a hood over the board falling forward (P1a, the Global's first, then
 * the 747's). Lengths in metres, angles in degrees.
 */
export interface RoundedDeckDesign {
  readonly radius: number;
  readonly drop: number;
  /** The cove's run forward, and its fall: 45 degrees. */
  readonly cove: number;
  readonly hoodFallDegrees: number;
  readonly hoodDepth: number;
  /** Chords round the aft edge, besides the one vertex put on the deck line's tangent. */
  readonly roundSegments: number;
}

/** A rounded deck's section in body x and y, and the points the rest of the deck is placed from. */
export interface RoundedDeckSection {
  /** The prism's outline, convex, in order round it (`solidPlate` winds it). */
  readonly outline: readonly { readonly x: number; readonly y: number }[];
  /** The round's vertices, from the hood's tangent round to the aft face's, the deck line's tangent among them. */
  readonly round: readonly { readonly x: number; readonly y: number }[];
  /** The round's centre. */
  readonly centre: { readonly x: number; readonly y: number };
  /** Where the deck line's sight line touches the round: the silhouette. */
  readonly tangent: { readonly x: number; readonly y: number };
  /** The aft face's foot, where the cove turns under. */
  readonly coveTop: { readonly x: number; readonly y: number };
  /** The cove's foot: the panel's face's top edge, and the lowest edge of the deck the pilot sees. */
  readonly faceTop: { readonly x: number; readonly y: number };
}

/**
 * A rounded deck's section from an eye (`forward`, `up`), the aft face's station `aftX` and the deck line (degrees
 * under the eye). THE ROUND is tangent to the aft face and to the hood's top, and the deck line's sight line is tangent
 * to it AT A VERTEX, so the silhouette is the deck line exactly: one row of the picture. The cove runs `cove` forward
 * and `cove` down from the aft face's foot; the hood's top and underside both fall at `hoodFallDegrees`, a plate of
 * one thickness, so the solid stays convex. `who` names the airframe in what it throws.
 */
export function roundedDeckSection(
  eye: { readonly forward: number; readonly up: number },
  aftX: number,
  deckLine: number,
  g: RoundedDeckDesign,
  who: string,
): RoundedDeckSection {
  const e = eye;
  const DEGREE = Math.PI / 180;
  const fall = g.hoodFallDegrees * DEGREE;
  const sight = deckLine * DEGREE;
  if (!(deckLine < g.hoodFallDegrees)) {
    throw new RangeError(`${who}'s hood falls ${g.hoodFallDegrees} degrees, no steeper than the ${deckLine} degree sight line over the deck: its top would show over the round`);
  }
  // THE ROUND: its centre `radius` forward of the aft face and `radius` under the sight line (the line through the eye
  // falling at the deck line, whose upward normal is (sin, cos) of it).
  const cx = aftX + g.radius;
  const cy = e.up - (g.radius + Math.sin(sight) * (cx - e.forward)) / Math.cos(sight);
  const at = (angle: number) => ({ x: cx + g.radius * Math.sin(angle), y: cy + g.radius * Math.cos(angle) });
  // angles from straight up, forward positive: -90 is the aft face's tangent, +fall the hood's
  const angles = Array.from({ length: g.roundSegments + 1 }, (_, k) => fall - ((fall + Math.PI / 2) * k) / g.roundSegments);
  if (sight > -Math.PI / 2 && sight < fall) angles.push(sight);
  angles.sort((a, b) => b - a);
  const round = angles.map(at);
  const coveTop = { x: aftX, y: cy - g.drop };
  const faceTop = { x: aftX + g.cove, y: coveTop.y - g.cove };
  // the hood: its top from the round's forward tangent, its underside from the cove's foot, both falling at `fall`
  const endX = aftX + g.hoodDepth;
  const hoodTop = round[0]!;
  const endTop = { x: endX, y: hoodTop.y - (endX - hoodTop.x) * Math.tan(fall) };
  const endFoot = { x: endX, y: faceTop.y - (endX - faceTop.x) * Math.tan(fall) };
  if (!(endTop.y - endFoot.y >= 0.001)) {
    throw new RangeError(`${who}'s hood is ${((endTop.y - endFoot.y) * 1000).toFixed(2)} mm thick: its top meets its underside`);
  }
  return {
    outline: [...(g.drop > 0 ? [coveTop] : []), faceTop, endFoot, endTop, ...round],
    round,
    centre: { x: cx, y: cy },
    tangent: at(sight),
    coveTop,
    faceTop,
  };
}

/**
 * THE BEZELS' CHAMFERED RIMS' material, one for every framed screen (the Global's and the 747's), so the two cannot
 * drift apart: a quiet mid-grey bevel by day, and the panel's night glow.
 *
 * DIMMED BY DAY (Jason, "dimmer"). The rim is a 45 degree chamfer, and its top side faces the sky: at 0x2b3237,
 * roughness 0.5 and a day emissive of 0.175 it read 116 (the Global) and 104 (the 747) against frames of 41 and 36,
 * 2.8 and 2.9 times, a bright outline round every screen. Swept live (one paused level frame per airframe, every
 * pixel ray-confirmed), the day emissive alone could not bring it to the asked 1.5 to 2 times the frame (at 0 the rim
 * still read 2.3 and 2.4 times: the top chamfer catches the sky, emissive or not), nor the emissive and the frame's
 * roughness together on the 747 (2.14 at 0). With the albedo at 0.6 of it as well, 0.05 of day emissive reads 68 and
 * 67, 1.72 and 1.90 times: a visible edge that no longer glares. The top chamfer is still the brightest side (2.4 to
 * 2.5 times; the sides 1.1 to 1.6), because it faces the sky.
 *
 * ITS OWN GLOW LAW (`bezelRimEmissive`), not `applyGlow`'s authored-times-multiple: by day the rim's emissive is
 * `dayEmissiveIntensity`, at night `nightEmissiveIntensity`, and between them it follows the cockpit glow
 * (`cockpitInstrumentGlow`, 1 by day to `COCKPIT_GLOW_NIGHT_MULTIPLE` at night) linearly. A day value that is the
 * night's over the multiple is `applyGlow`'s law exactly; any other day value moves the day read and leaves the night
 * where it was, which is what dimming the rim by day asked (Jason, "dimmer"; the night glow untouched).
 */
export const BEZEL_RIM = Object.freeze({
  /** 0x2b3237 at 0.6, to the nearest integer a channel (the sweep's scale, within 0.8%). */
  albedo: 0x1a1e21,
  /** The frames' finish, where the chamfer's 0.5 sheened the sky. */
  roughness: 0.82,
  metallic: 0,
  emissive: 0x4ba8c6,
  dayEmissiveIntensity: 0.05,
  /** The rim's night glow as it was under `applyGlow` before it was dimmed: 0.175 times the night multiple. */
  nightEmissiveIntensity: 0.175 * COCKPIT_GLOW_NIGHT_MULTIPLE,
});

/** The rim's material, authored at its day emissive. Its visual drives the emissive by `bezelRimEmissive`. */
export function bezelRimMaterial(build: AircraftBuildContext, name: string): PBRMaterial {
  const r = BEZEL_RIM;
  return build.material(name, r.albedo, { roughness: r.roughness, metallic: r.metallic, emissive: r.emissive, emissiveIntensity: r.dayEmissiveIntensity });
}

/**
 * The rim's emissive intensity for a cockpit glow multiple (`AircraftLightState.cockpitGlow`): the day value at 1, the
 * night value at `COCKPIT_GLOW_NIGHT_MULTIPLE`, linear between, and on past the night value if a glow ever exceeds the
 * multiple. A non-finite glow reads as day, as `applyGlow`'s does.
 */
export function bezelRimEmissive(cockpitGlow: number): number {
  const g = Number.isFinite(cockpitGlow) ? Math.max(0, cockpitGlow) : 1;
  const r = BEZEL_RIM;
  return Math.max(0, r.dayEmissiveIntensity + ((r.nightEmissiveIntensity - r.dayEmissiveIntensity) * (g - 1)) / (COCKPIT_GLOW_NIGHT_MULTIPLE - 1));
}

/**
 * A FRAMED SCREEN's design (P1b, the Global's first, then the 747's): the screen, its bezel's rim beyond it (the gap,
 * the frame's flat face, the chamfer), and the depths of the stack square to the panel's face. Metres.
 */
export interface FramedScreenDesign {
  readonly width: number;
  readonly height: number;
  /** The bezel's rim beyond the screen: the dark gap, then the frame's flat face, then its chamfer. */
  readonly bezel: number;
  /** The frame's front stands this far out of the board's face; its back is 1 mm inside it. */
  readonly bezelThickness: number;
  /** The chamfer round the frame's outer edge: this wide across the face and this deep, at 45 degrees. */
  readonly chamfer: number;
  /** Between the frame's inner edge and the screen: a dark well. */
  readonly gap: number;
  /** The screen's face stands this far BEHIND the frame's front. */
  readonly recess: number;
  readonly screenThickness: number;
}

/** How far out of the board's face each plane of a framed screen's stack stands, square to the face (the face is 0). */
export function framedScreenStack(s: FramedScreenDesign): { bezelBack: number; bezelFront: number; chamferFoot: number; screenFront: number; screenBack: number } {
  const bezelBack = -0.001;
  const bezelFront = bezelBack + s.bezelThickness;
  const screenFront = bezelFront - s.recess;
  return { bezelBack, bezelFront, chamferFoot: bezelFront - s.chamfer, screenFront, screenBack: screenFront - s.screenThickness };
}

/**
 * A screen's bezel as flat quads about `faceCentre` on a (leaned) panel face whose unit vectors up the face and out of it
 * toward the pilot are `face.up` and `face.normal` (x and y; the face runs along z), in two CLOSED solids that meet
 * along the chamfer's shoulder: `frame`, a ring from the opening (the screen and its gap) out to the shoulder, its flat
 * front toward the pilot; and `rim`, the band from the shoulder out to the bezel's edge, whose front is the 45 degree
 * chamfer. Each is closed on its own, so wherever a ray meets either first it meets a face the GPU draws (the faces where
 * they meet face each other inside the bezel and are never seen); the rim is apart so the night glow can be on it alone.
 */
export function framedScreenFacets(
  faceCentre: Vector3,
  face: { readonly up: { readonly x: number; readonly y: number }; readonly normal: { readonly x: number; readonly y: number } },
  s: FramedScreenDesign,
): { frame: FacetQuad[]; rim: FacetQuad[] } {
  const stack = framedScreenStack(s);
  const across = new Vector3(0, 0, 1);
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  const at = (u: number, v: number, o: number) => faceCentre.add(across.scale(u)).add(up.scale(v)).add(out.scale(o));
  // a rectangle's corners, bottom-left round to top-left, and each side's outward direction in the face
  const rect = (x: number, y: number, o: number) => [at(-x, -y, o), at(x, -y, o), at(x, y, o), at(-x, y, o)];
  const sides = [up.scale(-1), across, up, across.scale(-1)];
  const ring = (a: Vector3[], b: Vector3[], normal: (k: number) => Vector3): FacetQuad[] =>
    [0, 1, 2, 3].map((k) => ({ corners: [a[k]!, a[(k + 1) % 4]!, b[(k + 1) % 4]!, b[k]!] as const, normal: normal(k) }));
  const opening = (o: number) => rect(s.width / 2 + s.gap, s.height / 2 + s.gap, o);
  const shoulder = (o: number) => rect(s.width / 2 + s.bezel - s.chamfer, s.height / 2 + s.bezel - s.chamfer, o);
  const edge = (o: number) => rect(s.width / 2 + s.bezel, s.height / 2 + s.bezel, o);
  const { bezelFront: front, bezelBack: back, chamferFoot: foot } = stack;
  return {
    frame: [
      ...ring(opening(front), shoulder(front), () => out),
      ...ring(shoulder(front), shoulder(back), (k) => sides[k]!),
      ...ring(opening(back), shoulder(back), () => out.scale(-1)),
      ...ring(opening(back), opening(front), (k) => sides[k]!.scale(-1)),
    ],
    rim: [
      // the chamfer runs as far across the face as it falls toward it: its normal is halfway between the side's and the face's
      ...ring(shoulder(front), edge(foot), (k) => sides[k]!.add(out).normalize()),
      ...ring(edge(foot), edge(back), (k) => sides[k]!),
      ...ring(shoulder(back), edge(back), () => out.scale(-1)),
      ...ring(shoulder(back), shoulder(front), (k) => sides[k]!.scale(-1)),
    ],
  };
}

/** A flat quad of a `facetMesh`: four corners in order round it, and the way its drawn side faces. */
export interface FacetQuad {
  readonly corners: readonly [Vector3, Vector3, Vector3, Vector3];
  /** Unit, pointing OUT of the solid: the side the GPU draws, and the shading normal. */
  readonly normal: Vector3;
}

/**
 * A mesh of flat quads whose drawn side is GIVEN, not inferred: for a solid no prism or centroid can describe, a
 * frame round a hole, whose centroid is in the hole. Each quad becomes two triangles wound by `solidPlate`'s rule (a
 * drawn face's cross product points INTO the solid, against the quad's `normal`), three vertices of their own and
 * the quad's normal, so it shades flat. A quad with no area is left out. UVs are all zero: nothing here is textured.
 *
 * The mesh is made as a `solidPlate` (so the builder owns, parents and registers it as it does every part) and its
 * vertex data rewritten, as `solidified` rewrites a builder's.
 */
export function facetMesh(
  build: AircraftBuildContext,
  name: string,
  quads: readonly FacetQuad[],
  material: PBRMaterial,
  parent: TransformNode,
): Mesh {
  const mesh = solidPlate(build, name, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], 1, material, parent);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const { corners, normal } of quads) {
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]] as const) {
      let triangle: [Vector3, Vector3, Vector3] = [corners[i], corners[j], corners[k]];
      const cross = Vector3.Cross(triangle[1].subtract(triangle[0]), triangle[2].subtract(triangle[0]));
      if (cross.length() < 1e-12) continue;
      if (Vector3.Dot(cross, normal) > 0) triangle = [triangle[0], triangle[2], triangle[1]];
      for (const corner of triangle) {
        positions.push(corner.x, corner.y, corner.z);
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(0, 0);
        indices.push(indices.length);
      }
    }
  }
  if (indices.length === 0) throw new RangeError(`facetMesh "${name}": no quad has any area`);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
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
