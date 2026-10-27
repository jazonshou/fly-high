import {
  createHullLinesSample,
  featureExtent,
  HULL_LENGTH,
  HULL_REVERSE_CHINE,
  HULL_STRAKES,
  hullToBody,
  RUNABOUT_21_CG,
  sampleHullLines,
  transomX,
  wettedChineHalfBeam,
} from "@/src/vehicles/boat/hullLines";

/**
 * The physics hull, built once from the shared hull lines: a coarse closed
 * triangle mesh for the hydrostatics, friction and grounding, and the keel
 * strips the planing model integrates along. Both are in the BODY frame
 * (origin at the CG), so the per-step passes never touch the hull frame.
 *
 * The mesh keeps four points a side per ring (mid-bottom, chine,
 * reverse-chine edge, sheer) and the keel on 16 rings from the transom to the
 * stem head, closed by the deck and a transom fan: 254 triangles once the
 * stem's collapsed ones are dropped, watertight, enough that the
 * clipped waterplane follows a heeled or pitched hull to a few per cent of
 * its volume (tests/sim.boat-hydrostatics.test.ts holds it to the lines'
 * exact section integral). The strakes are too small to matter to the
 * volume; they act through the strips, where they trip the spray root.
 */

/** What a triangle is, for the passes that treat surfaces differently. */
export const HULL_TAG_BOTTOM = 0;
export const HULL_TAG_CHINE = 1;
export const HULL_TAG_TOPSIDE = 2;
export const HULL_TAG_DECK = 3;
export const HULL_TAG_TRANSOM = 4;

/** Ring stations, hull-frame x. */
export const HULL_MESH_RINGS: readonly number[] = Object.freeze([
  0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 5.9, 6.2, 6.4, HULL_LENGTH,
]);

/** Points per ring: keel, then starboard mid, chine, reverse chine, sheer, then the same to port. */
export const HULL_RING_POINTS = 9;
const RING_KEEL = 0;
const RING_STARBOARD = 1;
const RING_PORT = 5;
const SIDE_MID = 0;
const SIDE_CHINE = 1;
const SIDE_REVERSE = 2;
const SIDE_SHEER = 3;

export interface HullMesh {
  /** Body-frame vertex positions, x y z interleaved. */
  readonly vertices: Float64Array;
  readonly vertexCount: number;
  /** Three vertex indices per triangle, wound so the right-hand normal points out of the hull. */
  readonly triangles: Uint16Array;
  readonly triangleCount: number;
  readonly tags: Uint8Array;
  /** Body-frame x of each triangle's centroid, and its distance forward of the transom. */
  readonly triangleTransomDistance: Float64Array;
  /**
   * Vertices that can touch the sea bed or a dock: the keel, bottom and chine
   * points of every ring, and the sheer for docks. Indices into `vertices`.
   */
  readonly bottomVertices: Uint16Array;
  readonly sheerVertices: Uint16Array;
}

/** Number of keel strips, transom to just short of the stem. */
export const HULL_STRIP_COUNT = 20;
const STRIP_SPAN = 6.3;

/**
 * The keel strips of the 2D+t planing model, transom (index 0) to bow, each
 * `length` long. Body frame. Per strip: the keel point, the keel's slope and
 * curvature along x (rocker), the deadrise, the wetted chine half-breadth
 * (where the flow leaves once the chine is wet), the chine and sheer heights,
 * and the strakes present there.
 */
export interface HullStrips {
  readonly count: number;
  readonly length: number;
  readonly x: Float64Array;
  /** Distance forward of the transom, metres. */
  readonly transomDistance: Float64Array;
  readonly keelY: Float64Array;
  readonly keelSlope: Float64Array;
  readonly keelCurvature: Float64Array;
  readonly tanDeadrise: Float64Array;
  readonly chineHalfBeam: Float64Array;
  /** Height of the chine and of the sheer above the keel point, metres. */
  readonly chineRise: Float64Array;
  readonly sheerRise: Float64Array;
  /** Up to three strakes per strip: inner-edge half-breadth (0 = absent) and flat width. */
  readonly strakeInner: Float64Array;
  readonly strakeWidth: Float64Array;
}

export const STRAKES_PER_STRIP = 3;

/** Chine half-breadth at the transom, the beam the planing coefficients use. */
export const HULL_TRANSOM_CHINE_BEAM = (() => {
  const lines = sampleHullLines(0);
  return 2 * wettedChineHalfBeam(lines);
})();

const UP = Object.freeze({ x: 0, y: 1, z: 0 });
const AFT = Object.freeze({ x: -1, y: 0, z: 0 });

export function buildHullMesh(): HullMesh {
  const rings = HULL_MESH_RINGS.length;
  const vertexCount = rings * HULL_RING_POINTS + 1;
  const vertices = new Float64Array(vertexCount * 3);
  const lines = createHullLinesSample();
  const body = { x: 0, y: 0, z: 0 };
  const hull = { x: 0, y: 0, z: 0 };
  const put = (index: number, x: number, y: number, z: number): void => {
    hull.x = x;
    hull.y = y;
    hull.z = z;
    hullToBody(hull, body);
    vertices[index * 3] = body.x;
    vertices[index * 3 + 1] = body.y;
    vertices[index * 3 + 2] = body.z;
  };
  for (let ring = 0; ring < rings; ring += 1) {
    const x = HULL_MESH_RINGS[ring]!;
    sampleHullLines(x, lines);
    const chine = lines.chineHalfBeam;
    const tanDeadrise = Math.tan((lines.deadrise * Math.PI) / 180);
    const reverse = wettedChineHalfBeam(lines);
    const reverseDrop = (reverse - chine) * Math.tan((HULL_REVERSE_CHINE.downAngle * Math.PI) / 180);
    const midZ = 0.5 * chine;
    const midY = lines.keel + midZ * tanDeadrise;
    // The aft ring lies on the raked transom plane.
    const ringX = (y: number): number => (ring === 0 ? transomX(y) : x);
    const base = ring * HULL_RING_POINTS;
    put(base + RING_KEEL, ringX(lines.keel), lines.keel, 0);
    for (const [offset, sign] of [
      [RING_STARBOARD, 1],
      [RING_PORT, -1],
    ] as const) {
      put(base + offset + SIDE_MID, ringX(midY), midY, sign * midZ);
      put(base + offset + SIDE_CHINE, ringX(lines.chineHeight), lines.chineHeight, sign * chine);
      put(
        base + offset + SIDE_REVERSE,
        ringX(lines.chineHeight - reverseDrop),
        lines.chineHeight - reverseDrop,
        sign * reverse,
      );
      put(base + offset + SIDE_SHEER, ringX(lines.sheerHeight), lines.sheerHeight, sign * lines.sheerHalfBeam);
    }
  }
  // The transom fan's centre.
  const transomCentre = rings * HULL_RING_POINTS;
  sampleHullLines(0, lines);
  const centreY = 0.5 * (lines.chineHeight + lines.sheerHeight);
  put(transomCentre, transomX(centreY), centreY, 0);

  const triangles: number[] = [];
  const tags: number[] = [];
  /**
   * Adds a triangle wound so its right-hand normal faces `outward`, or, with
   * no direction given, exactly as listed. Degenerate triangles (the stem
   * rings collapse onto the centreline) are dropped.
   */
  const addTriangle = (a: number, b: number, c: number, tag: number, outward?: { x: number; y: number; z: number }): void => {
    const ax = vertices[a * 3]!;
    const ay = vertices[a * 3 + 1]!;
    const az = vertices[a * 3 + 2]!;
    const e1x = vertices[b * 3]! - ax;
    const e1y = vertices[b * 3 + 1]! - ay;
    const e1z = vertices[b * 3 + 2]! - az;
    const e2x = vertices[c * 3]! - ax;
    const e2y = vertices[c * 3 + 1]! - ay;
    const e2z = vertices[c * 3 + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (Math.hypot(nx, ny, nz) < 1e-9) return;
    const dot = outward ? nx * outward.x + ny * outward.y + nz * outward.z : 1;
    if (dot >= 0) triangles.push(a, b, c);
    else triangles.push(a, c, b);
    tags.push(tag);
  };

  for (let ring = 0; ring < rings - 1; ring += 1) {
    const a = ring * HULL_RING_POINTS;
    const b = (ring + 1) * HULL_RING_POINTS;
    for (const offset of [RING_STARBOARD, RING_PORT]) {
      // keel -> mid -> chine -> reverse chine -> sheer. Walking the section
      // outboard and forward to the next ring, (p0, p1, q1) faces into the
      // hull on the starboard side and out of it to port, whatever the local
      // shape (the reverse chine's flat faces down and inboard, which no
      // centroid test gets right), so the winding is set by the side.
      const chain = [RING_KEEL, offset + SIDE_MID, offset + SIDE_CHINE, offset + SIDE_REVERSE, offset + SIDE_SHEER];
      const chainTags = [HULL_TAG_BOTTOM, HULL_TAG_BOTTOM, HULL_TAG_CHINE, HULL_TAG_TOPSIDE];
      const starboard = offset === RING_STARBOARD;
      for (let k = 0; k < chain.length - 1; k += 1) {
        const p0 = a + chain[k]!;
        const p1 = a + chain[k + 1]!;
        const q0 = b + chain[k]!;
        const q1 = b + chain[k + 1]!;
        if (starboard) {
          addTriangle(p0, q1, p1, chainTags[k]!);
          addTriangle(p0, q0, q1, chainTags[k]!);
        } else {
          addTriangle(p0, p1, q1, chainTags[k]!);
          addTriangle(p0, q1, q0, chainTags[k]!);
        }
      }
    }
    // Deck, sheer to sheer, facing up.
    addTriangle(a + RING_PORT + SIDE_SHEER, a + RING_STARBOARD + SIDE_SHEER, b + RING_STARBOARD + SIDE_SHEER, HULL_TAG_DECK, UP);
    addTriangle(a + RING_PORT + SIDE_SHEER, b + RING_STARBOARD + SIDE_SHEER, b + RING_PORT + SIDE_SHEER, HULL_TAG_DECK, UP);
  }
  // Transom: a fan round the aft ring from its centre, facing aft.
  const loop = [
    RING_KEEL,
    RING_STARBOARD + SIDE_MID,
    RING_STARBOARD + SIDE_CHINE,
    RING_STARBOARD + SIDE_REVERSE,
    RING_STARBOARD + SIDE_SHEER,
    RING_PORT + SIDE_SHEER,
    RING_PORT + SIDE_REVERSE,
    RING_PORT + SIDE_CHINE,
    RING_PORT + SIDE_MID,
  ];
  for (let k = 0; k < loop.length; k += 1) {
    addTriangle(transomCentre, loop[k]!, loop[(k + 1) % loop.length]!, HULL_TAG_TRANSOM, AFT);
  }

  const triangleCount = tags.length;
  const triangleTransomDistance = new Float64Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) {
    let x = 0;
    for (let k = 0; k < 3; k += 1) x += vertices[triangles[t * 3 + k]! * 3]!;
    triangleTransomDistance[t] = Math.max(0, x / 3 + RUNABOUT_21_CG.x);
  }

  const bottomVertices: number[] = [];
  const sheerVertices: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const base = ring * HULL_RING_POINTS;
    bottomVertices.push(base + RING_KEEL);
    for (const offset of [RING_STARBOARD, RING_PORT]) {
      bottomVertices.push(base + offset + SIDE_MID, base + offset + SIDE_CHINE, base + offset + SIDE_REVERSE);
      sheerVertices.push(base + offset + SIDE_SHEER);
    }
  }

  return {
    vertices,
    vertexCount,
    triangles: Uint16Array.from(triangles),
    triangleCount,
    tags: Uint8Array.from(tags),
    triangleTransomDistance,
    bottomVertices: Uint16Array.from(bottomVertices),
    sheerVertices: Uint16Array.from(sheerVertices),
  };
}

export function buildHullStrips(): HullStrips {
  const count = HULL_STRIP_COUNT;
  const length = STRIP_SPAN / count;
  const strips = {
    count,
    length,
    x: new Float64Array(count),
    transomDistance: new Float64Array(count),
    keelY: new Float64Array(count),
    keelSlope: new Float64Array(count),
    keelCurvature: new Float64Array(count),
    tanDeadrise: new Float64Array(count),
    chineHalfBeam: new Float64Array(count),
    chineRise: new Float64Array(count),
    sheerRise: new Float64Array(count),
    strakeInner: new Float64Array(count * STRAKES_PER_STRIP),
    strakeWidth: new Float64Array(count * STRAKES_PER_STRIP),
  };
  const lines = createHullLinesSample();
  const ahead = createHullLinesSample();
  const behind = createHullLinesSample();
  const step = 0.05;
  for (let i = 0; i < count; i += 1) {
    const x = (i + 0.5) * length;
    sampleHullLines(x, lines);
    sampleHullLines(x + step, ahead);
    sampleHullLines(Math.max(0, x - step), behind);
    const span = x + step - Math.max(0, x - step);
    strips.x[i] = x - RUNABOUT_21_CG.x;
    strips.transomDistance[i] = x;
    strips.keelY[i] = lines.keel - RUNABOUT_21_CG.y;
    strips.keelSlope[i] = (ahead.keel - behind.keel) / span;
    strips.keelCurvature[i] = (ahead.keel - 2 * lines.keel + behind.keel) / (step * step);
    strips.tanDeadrise[i] = Math.tan((lines.deadrise * Math.PI) / 180);
    strips.chineHalfBeam[i] = wettedChineHalfBeam(lines);
    strips.chineRise[i] = lines.chineHeight - lines.keel;
    strips.sheerRise[i] = lines.sheerHeight - lines.keel;
    for (let k = 0; k < STRAKES_PER_STRIP; k += 1) {
      const strake = HULL_STRAKES[k];
      const extent = strake ? featureExtent(strake, x) : 0;
      strips.strakeInner[i * STRAKES_PER_STRIP + k] = strake && extent > 0.5 ? strake.fraction * lines.chineHalfBeam : 0;
      strips.strakeWidth[i * STRAKES_PER_STRIP + k] = strake ? strake.width * extent : 0;
    }
  }
  return strips;
}
