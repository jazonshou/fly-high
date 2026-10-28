import { polygonSurface, Surface, type Vec3Tuple } from "../boat/boatMeshData";

/**
 * The shapes the drawn LandCruiser is built from, as `Surface` smoothing
 * groups (the boat's geometry kit: counter-clockwise from the shown side,
 * one smoothing group per surface). The 76 is a box on a ladder frame, so
 * nearly everything is a chamfered prism: a flat outline pushed through a
 * width, its edges broken by a narrow bevel that catches the light the way a
 * pressed steel panel's rolled edge does.
 */

export type Point2 = readonly [number, number];
export type UvFor = (point: Vec3Tuple) => readonly [number, number];

/** Signed area of an outline, positive counter-clockwise in (a, b). */
export function outlineArea(outline: readonly Point2[]): number {
  let area = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const [a0, b0] = outline[index]!;
    const [a1, b1] = outline[(index + 1) % outline.length]!;
    area += a0 * b1 - a1 * b0;
  }
  return area / 2;
}

/**
 * An outline moved `distance` inward along each corner's bisector (a mitre
 * inset), for a counter-clockwise outline. Mitres are capped at three times
 * the distance so a sharp corner cannot spike.
 */
export function insetOutline(outline: readonly Point2[], distance: number): Point2[] {
  const count = outline.length;
  const result: Point2[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = outline[(index + count - 1) % count]!;
    const point = outline[index]!;
    const next = outline[(index + 1) % count]!;
    const e0 = normalize2([point[0] - previous[0], point[1] - previous[1]]);
    const e1 = normalize2([next[0] - point[0], next[1] - point[1]]);
    // Inward normals of a counter-clockwise outline point left of travel.
    const n0: Point2 = [-e0[1], e0[0]];
    const n1: Point2 = [-e1[1], e1[0]];
    const bisector = normalize2([n0[0] + n1[0], n0[1] + n1[1]]);
    const cos = bisector[0] * n1[0] + bisector[1] * n1[1];
    const mitre = Math.min(3, 1 / Math.max(1e-3, cos)) * distance;
    result.push([point[0] + bisector[0] * mitre, point[1] + bisector[1] * mitre]);
  }
  return result;
}

function normalize2(vector: Point2): Point2 {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-12 ? [vector[0] / length, vector[1] / length] : [0, 0];
}

/** Indices where an outline turns by more than `creaseRadians`: the rim's smoothing breaks there. */
function creases(outline: readonly Point2[], creaseRadians: number): boolean[] {
  const count = outline.length;
  const crease: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = outline[(index + count - 1) % count]!;
    const point = outline[index]!;
    const next = outline[(index + 1) % count]!;
    const e0 = normalize2([point[0] - previous[0], point[1] - previous[1]]);
    const e1 = normalize2([next[0] - point[0], next[1] - point[1]]);
    const cos = Math.min(1, Math.max(-1, e0[0] * e1[0] + e0[1] * e1[1]));
    crease.push(Math.acos(cos) > creaseRadians);
  }
  return crease;
}

/**
 * A band of quads between two matching point rings, split into smoothing
 * groups at the outline's creases. Unflipped, quad k is (near k, near k+1,
 * far k+1, far k) counter-clockwise from its shown side; `flip` shows the
 * other side. Each quad takes ONE UV, `uv` at its midpoint, so a rim can
 * change finish along the outline (a wheel arch's dark well beside the
 * paint) without a swatch smearing into the next; quads of one finish still
 * weld and shade smoothly.
 */
function rimBands(
  near: readonly Vec3Tuple[],
  far: readonly Vec3Tuple[],
  crease: readonly boolean[],
  uv: UvFor,
  flip: boolean,
  open?: (midpoint: Vec3Tuple) => boolean,
): Surface[] {
  const count = near.length;
  const surfaces: Surface[] = [];
  let start = crease.findIndex((value) => value);
  if (start < 0) start = 0;
  let current = new Surface();
  for (let step = 0; step < count; step += 1) {
    const index = (start + step) % count;
    const next = (index + 1) % count;
    if (step > 0 && crease[index]) {
      surfaces.push(current);
      current = new Surface();
    }
    const n0 = near[index]!;
    const n1 = near[next]!;
    const f1 = far[next]!;
    const f0 = far[index]!;
    const midpoint: Vec3Tuple = [
      (n0[0] + n1[0] + f1[0] + f0[0]) / 4,
      (n0[1] + n1[1] + f1[1] + f0[1]) / 4,
      (n0[2] + n1[2] + f1[2] + f0[2]) / 4,
    ];
    if (open?.(midpoint)) continue;
    const quadUv = uv(midpoint);
    const a = current.vertexAt(n0, quadUv);
    const b = current.vertexAt(n1, quadUv);
    const c = current.vertexAt(f1, quadUv);
    const d = current.vertexAt(f0, quadUv);
    if (flip) current.quad(a, d, c, b);
    else current.quad(a, b, c, d);
  }
  surfaces.push(current);
  return surfaces.filter((surface) => surface.indices.length > 0).map(weldSurface);
}

/** Merge a surface's coincident vertices that share a UV, so its normals average across them. */
function weldSurface(surface: Surface): Surface {
  const welded = new Surface();
  const map = new Map<string, number>();
  const remap: number[] = [];
  for (let index = 0; index < surface.vertexCount; index += 1) {
    const x = surface.positions[index * 3]!;
    const y = surface.positions[index * 3 + 1]!;
    const z = surface.positions[index * 3 + 2]!;
    const u = surface.uvs[index * 2]!;
    const v = surface.uvs[index * 2 + 1]!;
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)},${u.toFixed(5)},${v.toFixed(5)}`;
    let target = map.get(key);
    if (target === undefined) {
      target = welded.vertex(x, y, z, u, v);
      map.set(key, target);
    }
    remap.push(target);
  }
  for (let index = 0; index < surface.indices.length; index += 1) welded.indices.push(remap[surface.indices[index]!]!);
  return welded;
}

export interface PrismOptions {
  /** The bevel along the outline's edges on both faces, metres. 0 for a sharp prism. */
  readonly chamfer?: number;
  /** Outline turns sharper than this break the rim's smoothing. */
  readonly creaseRadians?: number;
  /** UV for the two flat faces; the rim and bevels use `rimUv`. */
  readonly faceUv: UvFor;
  /** The near face's own UV, when it is another finish (a panel's hidden back). */
  readonly nearFaceUv?: UvFor;
  readonly rimUv?: UvFor;
  /**
   * Leave out the face at `z0` or at `z1` (a part that sits against another).
   * Its bevel stays, so two chamfered parts butted together leave a shut line.
   */
  readonly skipNearFace?: boolean;
  readonly skipFarFace?: boolean;
  /** Rim and bevel quads to leave out, by their midpoints: an opening along the outline. */
  readonly openRim?: (midpoint: Vec3Tuple) => boolean;
}

/**
 * A prism: `outline` in the body's (x, y) side plane, counter-clockwise seen
 * from +Z, pushed through z0..z1 (z0 < z1). Its face at z1 shows +Z and its
 * face at z0 shows -Z; the rim shows outward.
 */
export function prismZ(outline: readonly Point2[], z0: number, z1: number, options: PrismOptions): Surface[] {
  const ccw = outlineArea(outline) > 0 ? outline : [...outline].reverse();
  return prism(ccw, z0, z1, options, (a, b, c) => [a, b, c]);
}

/**
 * The same through x: `outline` in the (z, y) plane, counter-clockwise seen
 * from -X (as from ahead, looking back, +Z is to the LEFT, so the outline's
 * a axis is -z), pushed through x0..x1.
 */
export function prismX(outline: readonly Point2[], x0: number, x1: number, options: PrismOptions): Surface[] {
  // In (a, b) = (-z, y), counter-clockwise seen from +X... keep one convention:
  // map a = z, b = y with the view from +X, where +Z is to the left.
  const mapped: Point2[] = outline.map(([z, y]) => [-z, y]);
  const ccw = outlineArea(mapped) > 0 ? mapped : [...mapped].reverse();
  return prism(ccw, x0, x1, options, (a, b, c) => [c, b, -a]);
}

/**
 * The same through y: `outline` in plan, (x, z), counter-clockwise seen from
 * above (+Y; +X forward, +Z to the right... from above looking down with +X
 * up the page, +Z is to the right, so a = z, b = x runs counter-clockwise as
 * drawn), pushed through y0..y1.
 */
export function prismY(outline: readonly Point2[], y0: number, y1: number, options: PrismOptions): Surface[] {
  const mapped: Point2[] = outline.map(([x, z]) => [z, x]);
  const ccw = outlineArea(mapped) > 0 ? mapped : [...mapped].reverse();
  return prism(ccw, y0, y1, options, (a, b, c) => [b, c, a]);
}

/**
 * The common prism: `outline` counter-clockwise in (a, b), `axis(a, b, c)`
 * placing a point, with the right-handed frame (a, b, c): the face at c1
 * shows +c and the face at c0 shows -c.
 */
function prism(
  outline: readonly Point2[],
  c0: number,
  c1: number,
  options: PrismOptions,
  axis: (a: number, b: number, c: number) => Vec3Tuple,
): Surface[] {
  const chamfer = Math.max(0, options.chamfer ?? 0);
  const rimUv = options.rimUv ?? options.faceUv;
  const crease = creases(outline, options.creaseRadians ?? 0.6);
  const inner = chamfer > 0 ? insetOutline(outline, chamfer) : [...outline];
  const surfaces: Surface[] = [];
  // Both faces from the inset outline; the far one as drawn, the near one mirrored.
  if (!options.skipFarFace) surfaces.push(polygonSurface(inner, (a, b) => axis(a, b, c1), options.faceUv));
  if (!options.skipNearFace) {
    surfaces.push(polygonSurface(inner, (a, b) => axis(a, b, c0), options.nearFaceUv ?? options.faceUv).flipped());
  }
  const top = outline.map(([a, b]) => axis(a, b, c1 - chamfer));
  const bottom = outline.map(([a, b]) => axis(a, b, c0 + chamfer));
  // The rim runs counter-clockwise from c1 down to c0: (along) x (down c) points outward.
  surfaces.push(...rimBands(top, bottom, crease, rimUv, true, options.openRim));
  if (chamfer > 0) {
    const innerTop = inner.map(([a, b]) => axis(a, b, c1));
    const innerBottom = inner.map(([a, b]) => axis(a, b, c0));
    surfaces.push(...rimBands(innerTop, top, crease, rimUv, true, options.openRim));
    surfaces.push(...rimBands(bottom, innerBottom, crease, rimUv, true, options.openRim));
  }
  return surfaces;
}

/** An axis-aligned box from `min` to `max`, all six faces showing outward, optionally bevelled. */
export function box(min: Vec3Tuple, max: Vec3Tuple, uv: UvFor, chamfer = 0): Surface[] {
  const c = Math.min(chamfer, (max[0] - min[0]) / 3, (max[1] - min[1]) / 3);
  const outline: Point2[] = [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ];
  return prismZ(outline, min[2], max[2], { chamfer: c, faceUv: uv, creaseRadians: 0.3 });
}

/** A closed polyline's tube: a circle of `radius` swept along `path`, capped at both ends. */
export function tube(path: readonly Vec3Tuple[], radius: number, sides: number, uv: UvFor, capped = true): Surface[] {
  const rings: Vec3Tuple[][] = [];
  let reference: Vec3Tuple = [0, 1, 0];
  for (let index = 0; index < path.length; index += 1) {
    const previous = path[Math.max(0, index - 1)]!;
    const next = path[Math.min(path.length - 1, index + 1)]!;
    const tangent = normalize3([next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]]);
    if (Math.abs(dot3(tangent, reference)) > 0.95) reference = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const side = normalize3(cross3(tangent, reference));
    const up = cross3(side, tangent);
    reference = up;
    const point = path[index]!;
    const ring: Vec3Tuple[] = [];
    for (let k = 0; k <= sides; k += 1) {
      const angle = (k / sides) * Math.PI * 2;
      ring.push([
        point[0] + (side[0] * Math.cos(angle) + up[0] * Math.sin(angle)) * radius,
        point[1] + (side[1] * Math.cos(angle) + up[1] * Math.sin(angle)) * radius,
        point[2] + (side[2] * Math.cos(angle) + up[2] * Math.sin(angle)) * radius,
      ]);
    }
    rings.push(ring);
  }
  const body = new Surface();
  body.grid(rings, (_i, _j, point) => uv(point));
  // (along path) x (around) points... check the shown side against the first ring.
  const surfaces = [orientOutward(body, path)];
  if (capped) {
    for (const [ringIndex, pathIndex, sign] of [[0, 0, -1], [rings.length - 1, path.length - 1, 1]] as const) {
      const cap = new Surface();
      const centre = cap.vertexAt(path[pathIndex]!, uv(path[pathIndex]!));
      const ring = rings[ringIndex]!;
      const ids = ring.slice(0, sides).map((point) => cap.vertexAt(point, uv(point)));
      const tangent = normalize3([
        path[Math.min(path.length - 1, pathIndex + 1)]![0] - path[Math.max(0, pathIndex - 1)]![0],
        path[Math.min(path.length - 1, pathIndex + 1)]![1] - path[Math.max(0, pathIndex - 1)]![1],
        path[Math.min(path.length - 1, pathIndex + 1)]![2] - path[Math.max(0, pathIndex - 1)]![2],
      ]);
      const facing: Vec3Tuple = [tangent[0] * sign, tangent[1] * sign, tangent[2] * sign];
      for (let k = 0; k < sides; k += 1) cap.triFacing(centre, ids[k]!, ids[(k + 1) % sides]!, facing);
      surfaces.push(cap);
    }
  }
  return surfaces;
}

/** Flip a tube's skin if its first quad faces in toward the path. */
function orientOutward(surface: Surface, path: readonly Vec3Tuple[]): Surface {
  const p = surface.positions;
  const [a, b, c] = [surface.indices[0]!, surface.indices[1]!, surface.indices[2]!];
  const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!] as const;
  const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!] as const;
  // Stored winding is clockwise from the shown side: the shown normal is e2 x e1.
  const normal = cross3([e2[0], e2[1], e2[2]], [e1[0], e1[1], e1[2]]);
  const centre = path[0]!;
  const out: Vec3Tuple = [p[a * 3]! - centre[0], p[a * 3 + 1]! - centre[1], p[a * 3 + 2]! - centre[2]];
  return dot3(normal, out) >= 0 ? surface : surface.flipped();
}

/**
 * A solid of revolution about the body's Z axis (an axle's direction):
 * `profile` is (radius, z) pairs from one end to the other, swept round from
 * `fromRadians` to `toRadians` (once round by default; `around` in `uv` runs
 * 0..1 over that arc). A profile running toward +z shows its outside (a
 * tyre's tread), one running out in radius shows -z (a disc's back) and one
 * running in shows +z; `flip` shows the other side.
 */
export function latheZ(
  profile: readonly Point2[],
  segments: number,
  uv: (point: Vec3Tuple, around: number, along: number) => readonly [number, number],
  flip = false,
  centre: Vec3Tuple = [0, 0, 0],
  fromRadians = 0,
  toRadians = Math.PI * 2,
): Surface {
  const rows: Vec3Tuple[][] = [];
  for (let k = 0; k <= segments; k += 1) {
    const angle = fromRadians + (k / segments) * (toRadians - fromRadians);
    const row: Vec3Tuple[] = [];
    for (const [radius, z] of profile) {
      row.push([centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius, centre[2] + z]);
    }
    rows.push(row);
  }
  const surface = new Surface();
  surface.grid(rows, (i, j, point) => uv(point, i / segments, j / Math.max(1, profile.length - 1)));
  return flip ? surface.flipped() : surface;
}

/** A flat quad from four corners, counter-clockwise seen from the side it shows. */
export function quad(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, d: Vec3Tuple, uv: UvFor): Surface {
  const surface = new Surface();
  const ia = surface.vertexAt(a, uv(a));
  const ib = surface.vertexAt(b, uv(b));
  const ic = surface.vertexAt(c, uv(c));
  const id = surface.vertexAt(d, uv(d));
  surface.quad(ia, ib, ic, id);
  return surface;
}

/** A disc in the plane through `centre` with normal `normal`, showing along it. */
export function disc(centre: Vec3Tuple, normal: Vec3Tuple, radius: number, sides: number, uv: UvFor): Surface {
  const n = normalize3(normal);
  const reference: Vec3Tuple = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const side = normalize3(cross3(reference, n));
  const up = cross3(n, side);
  const surface = new Surface();
  const middle = surface.vertexAt(centre, uv(centre));
  const ring: number[] = [];
  for (let k = 0; k < sides; k += 1) {
    const angle = (k / sides) * Math.PI * 2;
    const point: Vec3Tuple = [
      centre[0] + (side[0] * Math.cos(angle) + up[0] * Math.sin(angle)) * radius,
      centre[1] + (side[1] * Math.cos(angle) + up[1] * Math.sin(angle)) * radius,
      centre[2] + (side[2] * Math.cos(angle) + up[2] * Math.sin(angle)) * radius,
    ];
    ring.push(surface.vertexAt(point, uv(point)));
  }
  for (let k = 0; k < sides; k += 1) surface.triFacing(middle, ring[k]!, ring[(k + 1) % sides]!, n);
  return surface;
}

/** An annulus (a ring between two radii) in a plane, showing along `normal`. */
export function ring(centre: Vec3Tuple, normal: Vec3Tuple, inner: number, outer: number, sides: number, uv: UvFor): Surface {
  const n = normalize3(normal);
  const reference: Vec3Tuple = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const side = normalize3(cross3(reference, n));
  const up = cross3(n, side);
  const surface = new Surface();
  const ids: Array<readonly [number, number]> = [];
  for (let k = 0; k < sides; k += 1) {
    const angle = (k / sides) * Math.PI * 2;
    const at = (radius: number): Vec3Tuple => [
      centre[0] + (side[0] * Math.cos(angle) + up[0] * Math.sin(angle)) * radius,
      centre[1] + (side[1] * Math.cos(angle) + up[1] * Math.sin(angle)) * radius,
      centre[2] + (side[2] * Math.cos(angle) + up[2] * Math.sin(angle)) * radius,
    ];
    const pi = at(inner);
    const po = at(outer);
    ids.push([surface.vertexAt(pi, uv(pi)), surface.vertexAt(po, uv(po))]);
  }
  for (let k = 0; k < sides; k += 1) {
    const [i0, o0] = ids[k]!;
    const [i1, o1] = ids[(k + 1) % sides]!;
    surface.triFacing(i0, o0, o1, n);
    surface.triFacing(i0, o1, i1, n);
  }
  return surface;
}

export function normalize3(vector: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 1e-12 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

export function cross3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot3(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Points on a circular arc in the (a, b) plane, from `from` to `to` radians inclusive. */
export function arc(centre: Point2, radius: number, from: number, to: number, steps: number): Point2[] {
  const points: Point2[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const angle = from + ((to - from) * k) / steps;
    points.push([centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius]);
  }
  return points;
}

/**
 * The band round an opening in a panel: `outline` the opening's edge on the
 * panel, counter-clockwise seen from the side the panel shows, and the band
 * running `offset` into the panel from it. It shows toward the opening's
 * middle, so it is seen through the opening from either side: a window's
 * rubber reveal.
 */
export function revealBand(outline: readonly Vec3Tuple[], offset: Vec3Tuple, uv: UvFor): Surface[] {
  const far = outline.map((point): Vec3Tuple => [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]]);
  return rimBands(outline, far, outline.map(() => true), uv, false);
}

/** An ellipsoid about `centre` with semi-axes `radii`, showing outward. */
export function ellipsoid(centre: Vec3Tuple, radii: Vec3Tuple, rings: number, segments: number, uv: UvFor): Surface {
  const rows: Vec3Tuple[][] = [];
  for (let i = 0; i <= rings; i += 1) {
    const polar = (i / rings) * Math.PI;
    const row: Vec3Tuple[] = [];
    for (let j = 0; j <= segments; j += 1) {
      const azimuth = (j / segments) * Math.PI * 2;
      row.push([
        centre[0] + Math.sin(polar) * Math.cos(azimuth) * radii[0],
        centre[1] + Math.cos(polar) * radii[1],
        centre[2] + Math.sin(polar) * Math.sin(azimuth) * radii[2],
      ]);
    }
    rows.push(row);
  }
  const surface = new Surface();
  surface.grid(rows, (_i, _j, point) => uv(point));
  return showingAwayFrom(surface, centre);
}

/** A closed surface turned, if need be, so its largest triangle shows away from `centre`. */
export function showingAwayFrom(surface: Surface, centre: Vec3Tuple): Surface {
  const p = surface.positions;
  let best = 0;
  let facing = 0;
  for (let index = 0; index < surface.indices.length; index += 3) {
    const [a, b, c] = [surface.indices[index]!, surface.indices[index + 1]!, surface.indices[index + 2]!];
    const e1: Vec3Tuple = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2: Vec3Tuple = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    // Stored winding is clockwise from the shown side: the shown normal is e2 x e1.
    const normal = cross3(e2, e1);
    const area = Math.hypot(normal[0], normal[1], normal[2]);
    if (area <= best) continue;
    best = area;
    facing = dot3(normal, [p[a * 3]! - centre[0], p[a * 3 + 1]! - centre[1], p[a * 3 + 2]! - centre[2]]);
  }
  return facing >= 0 ? surface : surface.flipped();
}

/** A straight round bar from `from` to `to`, capped. */
export function bar(from: Vec3Tuple, to: Vec3Tuple, radius: number, sides: number, uv: UvFor): Surface[] {
  return tube([from, to], radius, sides, uv, true);
}

/** The half-plane `a x + b y + c >= 0` in an outline's (a, b) plane. */
export interface HalfPlane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** A convex outline cut to the side of a half-plane it keeps (Sutherland-Hodgman); empty when nothing is left. */
export function clipToHalfPlane(outline: readonly Point2[], plane: HalfPlane): Point2[] {
  const side = (point: Point2) => plane.a * point[0] + plane.b * point[1] + plane.c;
  const result: Point2[] = [];
  for (let index = 0; index < outline.length; index += 1) {
    const point = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    const s0 = side(point);
    const s1 = side(next);
    if (s0 >= 0) result.push(point);
    if ((s0 >= 0) !== (s1 >= 0)) {
      const t = s0 / (s0 - s1);
      result.push([point[0] + (next[0] - point[0]) * t, point[1] + (next[1] - point[1]) * t]);
    }
  }
  return Math.abs(outlineArea(result)) > 1e-9 ? result : [];
}

/**
 * A convex outline split by a convex region (the half-planes it keeps): the
 * part inside, or null, and the parts outside, each convex.
 */
export function splitByRegion(
  outline: readonly Point2[],
  region: readonly HalfPlane[],
): { readonly inside: Point2[] | null; readonly outside: Point2[][] } {
  const outside: Point2[][] = [];
  let rest: Point2[] = [...outline];
  for (const plane of region) {
    if (rest.length === 0) break;
    const beyond = clipToHalfPlane(rest, { a: -plane.a, b: -plane.b, c: -plane.c });
    if (beyond.length > 0) outside.push(beyond);
    rest = clipToHalfPlane(rest, plane);
  }
  return { inside: rest.length > 0 ? rest : null, outside };
}

/**
 * A surface's triangles split in two by where their centroids fall, each half
 * keeping the vertices it uses. Within a planar part the normals do not move.
 */
export function partitionSurface(surface: Surface, takes: (centroid: Vec3Tuple) => boolean): [taken: Surface, left: Surface] {
  const taken = new Surface();
  const left = new Surface();
  const maps = [new Map<number, number>(), new Map<number, number>()] as const;
  const p = surface.positions;
  for (let index = 0; index < surface.indices.length; index += 3) {
    const corners = [surface.indices[index]!, surface.indices[index + 1]!, surface.indices[index + 2]!];
    const centroid: Vec3Tuple = [
      (p[corners[0]! * 3]! + p[corners[1]! * 3]! + p[corners[2]! * 3]!) / 3,
      (p[corners[0]! * 3 + 1]! + p[corners[1]! * 3 + 1]! + p[corners[2]! * 3 + 1]!) / 3,
      (p[corners[0]! * 3 + 2]! + p[corners[1]! * 3 + 2]! + p[corners[2]! * 3 + 2]!) / 3,
    ];
    const side = takes(centroid) ? 0 : 1;
    const target = side === 0 ? taken : left;
    const map = maps[side];
    for (const corner of corners) {
      let mapped = map.get(corner);
      if (mapped === undefined) {
        mapped = target.vertex(p[corner * 3]!, p[corner * 3 + 1]!, p[corner * 3 + 2]!, surface.uvs[corner * 2]!, surface.uvs[corner * 2 + 1]!);
        map.set(corner, mapped);
      }
      // Stored indices are already in the mesh's winding: copy them as they are.
      target.indices.push(mapped);
    }
  }
  return [taken, left];
}
