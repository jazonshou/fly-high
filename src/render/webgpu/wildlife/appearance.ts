import type { WildlifeSpecies } from "./types";

interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Point2 {
  readonly x: number;
  readonly z: number;
}

interface GeometryAccumulator {
  readonly positions: number[];
  readonly indices: number[];
}

export const WILDLIFE_PROTOTYPE_KEYS = [
  "bird-gull-body",
  "bird-gull-wing",
  "bird-hawk-body",
  "bird-hawk-wing",
  "deer-coat",
  "deer-leg",
  "deer-antler",
  "boar-hide",
  "boar-leg",
  "boar-tusk",
] as const;

export type WildlifePrototypeKey = typeof WILDLIFE_PROTOTYPE_KEYS[number];

export interface WildlifeSilhouetteContract {
  readonly features: readonly string[];
  readonly prototypeKeys: readonly WildlifePrototypeKey[];
}

function silhouetteContract(
  features: readonly string[],
  prototypeKeys: readonly WildlifePrototypeKey[],
): WildlifeSilhouetteContract {
  return Object.freeze({
    features: Object.freeze([...features]),
    prototypeKeys: Object.freeze([...prototypeKeys]),
  });
}

/**
 * A-5's recognition contract. Each species gets multiple anatomical cues, so
 * colour is never the only way to distinguish it from another animal.
 */
export const WILDLIFE_SILHOUETTE_CONTRACT: Readonly<
  Record<WildlifeSpecies, WildlifeSilhouetteContract>
> = Object.freeze({
  gull: silhouetteContract(
    ["straight-beak", "forked-tail", "high-aspect-wing"],
    ["bird-gull-body", "bird-gull-wing"],
  ),
  hawk: silhouetteContract(
    ["hooked-beak", "fan-tail", "fingered-broad-wing"],
    ["bird-hawk-body", "bird-hawk-wing"],
  ),
  deer: silhouetteContract(
    ["long-neck", "large-ears", "branched-antlers", "slender-cloven-leg"],
    ["deer-coat", "deer-leg", "deer-antler"],
  ),
  boar: silhouetteContract(
    ["shoulder-hump", "wedge-snout", "bristle-mane", "upturned-tusks", "short-cloven-leg"],
    ["boar-hide", "boar-leg", "boar-tusk"],
  ),
});

export interface WildlifePrototypeGeometry {
  readonly key: WildlifePrototypeKey;
  readonly species: WildlifeSpecies;
  readonly silhouetteFeatures: readonly string[];
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  /** Vertex/index bytes before driver alignment; normals are generated at upload. */
  readonly sourceByteLength: number;
}

function point(x: number, y: number, z: number): Point3 {
  return { x, y, z };
}

function pushVertex(accumulator: GeometryAccumulator, vertex: Point3): number {
  const index = accumulator.positions.length / 3;
  accumulator.positions.push(vertex.x, vertex.y, vertex.z);
  return index;
}

function subtract(a: Point3, b: Point3): Point3 {
  return point(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cross(a: Point3, b: Point3): Point3 {
  return point(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

function normalized(vector: Point3): Point3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 1e-8) throw new RangeError("Wildlife prototype contains a zero-length vector");
  return point(vector.x / length, vector.y / length, vector.z / length);
}

function appendEllipsoid(
  accumulator: GeometryAccumulator,
  center: Point3,
  radii: Point3,
  latitudeSegments = 6,
  radialSegments = 10,
): void {
  const firstTriangleIndex = accumulator.indices.length;
  const top = pushVertex(accumulator, point(center.x, center.y + radii.y, center.z));
  const firstRing = accumulator.positions.length / 3;
  for (let latitude = 1; latitude < latitudeSegments; latitude += 1) {
    const latitudeAngle = Math.PI * latitude / latitudeSegments;
    const radial = Math.sin(latitudeAngle);
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = Math.PI * 2 * segment / radialSegments;
      pushVertex(accumulator, point(
        center.x + Math.cos(angle) * radii.x * radial,
        center.y + Math.cos(latitudeAngle) * radii.y,
        center.z + Math.sin(angle) * radii.z * radial,
      ));
    }
  }
  const bottom = pushVertex(accumulator, point(center.x, center.y - radii.y, center.z));
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    accumulator.indices.push(top, firstRing + next, firstRing + segment);
  }
  for (let latitude = 0; latitude < latitudeSegments - 2; latitude += 1) {
    const ring = firstRing + latitude * radialSegments;
    const nextRing = ring + radialSegments;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      accumulator.indices.push(
        ring + segment,
        ring + next,
        nextRing + next,
        ring + segment,
        nextRing + next,
        nextRing + segment,
      );
    }
  }
  const lastRing = firstRing + (latitudeSegments - 2) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    accumulator.indices.push(bottom, lastRing + segment, lastRing + next);
  }
  // Babylon's right-handed meshes use clockwise front faces, and
  // ComputeNormals' default sign follows that convention. The analytic sphere
  // loops above are written in mathematical counter-clockwise order, so flip
  // this closed component once at the construction boundary.
  reverseTriangleRange(accumulator.indices, firstTriangleIndex);
}

function appendTube(
  accumulator: GeometryAccumulator,
  path: readonly Point3[],
  radii: readonly number[],
  radialSegments = 7,
): void {
  if (path.length < 2 || path.length !== radii.length) {
    throw new RangeError("A wildlife tube needs matching paths and radii");
  }
  const firstRing = accumulator.positions.length / 3;
  for (let index = 0; index < path.length; index += 1) {
    const previous = path[Math.max(0, index - 1)]!;
    const next = path[Math.min(path.length - 1, index + 1)]!;
    const tangent = normalized(subtract(next, previous));
    const reference = Math.abs(tangent.y) < 0.88 ? point(0, 1, 0) : point(1, 0, 0);
    const tangentAxis = normalized(cross(reference, tangent));
    const bitangentAxis = normalized(cross(tangent, tangentAxis));
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = Math.PI * 2 * segment / radialSegments;
      const cosine = Math.cos(angle) * radii[index]!;
      const sine = Math.sin(angle) * radii[index]!;
      pushVertex(accumulator, point(
        path[index]!.x + tangentAxis.x * cosine + bitangentAxis.x * sine,
        path[index]!.y + tangentAxis.y * cosine + bitangentAxis.y * sine,
        path[index]!.z + tangentAxis.z * cosine + bitangentAxis.z * sine,
      ));
    }
  }
  for (let ringIndex = 0; ringIndex < path.length - 1; ringIndex += 1) {
    const ring = firstRing + ringIndex * radialSegments;
    const nextRing = ring + radialSegments;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      accumulator.indices.push(
        ring + segment,
        nextRing + segment,
        ring + next,
        ring + next,
        nextRing + segment,
        nextRing + next,
      );
    }
  }
  const startCenter = pushVertex(accumulator, path[0]!);
  const endCenter = pushVertex(accumulator, path[path.length - 1]!);
  const endRing = firstRing + (path.length - 1) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    accumulator.indices.push(startCenter, firstRing + next, firstRing + segment);
    accumulator.indices.push(endCenter, endRing + segment, endRing + next);
  }
}

/** Closed star-shaped planform with a real edge thickness, not a unit box. */
function appendPlanform(
  accumulator: GeometryAccumulator,
  outline: readonly Point2[],
  centerY: number,
  thickness: number,
): void {
  const firstTriangleIndex = accumulator.indices.length;
  if (outline.length < 3) throw new RangeError("A wildlife planform needs three points");
  const centerX = outline.reduce((sum, vertex) => sum + vertex.x, 0) / outline.length;
  const centerZ = outline.reduce((sum, vertex) => sum + vertex.z, 0) / outline.length;
  const topY = centerY + thickness * 0.5;
  const bottomY = centerY - thickness * 0.5;
  const topCenter = pushVertex(accumulator, point(centerX, topY, centerZ));
  const topStart = accumulator.positions.length / 3;
  for (const vertex of outline) pushVertex(accumulator, point(vertex.x, topY, vertex.z));
  const bottomCenter = pushVertex(accumulator, point(centerX, bottomY, centerZ));
  const bottomStart = accumulator.positions.length / 3;
  for (const vertex of outline) pushVertex(accumulator, point(vertex.x, bottomY, vertex.z));
  let signedArea = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const current = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    signedArea += current.x * next.z - next.x * current.z;
  }
  for (let index = 0; index < outline.length; index += 1) {
    const next = (index + 1) % outline.length;
    if (signedArea >= 0) {
      accumulator.indices.push(topCenter, topStart + next, topStart + index);
      accumulator.indices.push(bottomCenter, bottomStart + index, bottomStart + next);
      accumulator.indices.push(
        topStart + index,
        topStart + next,
        bottomStart + next,
        topStart + index,
        bottomStart + next,
        bottomStart + index,
      );
    } else {
      accumulator.indices.push(topCenter, topStart + index, topStart + next);
      accumulator.indices.push(bottomCenter, bottomStart + next, bottomStart + index);
      accumulator.indices.push(
        topStart + next,
        topStart + index,
        bottomStart + index,
        topStart + next,
        bottomStart + index,
        bottomStart + next,
      );
    }
  }
  reverseTriangleRange(accumulator.indices, firstTriangleIndex);
}

function reverseTriangleRange(indices: number[], firstIndex: number): void {
  for (let index = firstIndex; index < indices.length; index += 3) {
    const second = indices[index + 1]!;
    indices[index + 1] = indices[index + 2]!;
    indices[index + 2] = second;
  }
}

/** Triangular ear/mane slab extruded along Z. */
function appendProfileSlab(
  accumulator: GeometryAccumulator,
  outline: readonly Readonly<{ x: number; y: number }>[],
  centerZ: number,
  thickness: number,
): void {
  const front = accumulator.positions.length / 3;
  for (const vertex of outline) {
    pushVertex(accumulator, point(vertex.x, vertex.y, centerZ + thickness * 0.5));
  }
  const back = accumulator.positions.length / 3;
  for (const vertex of outline) {
    pushVertex(accumulator, point(vertex.x, vertex.y, centerZ - thickness * 0.5));
  }
  for (let index = 1; index < outline.length - 1; index += 1) {
    accumulator.indices.push(front, front + index, front + index + 1);
    accumulator.indices.push(back, back + index + 1, back + index);
  }
  for (let index = 0; index < outline.length; index += 1) {
    const next = (index + 1) % outline.length;
    accumulator.indices.push(
      front + index,
      back + index,
      back + next,
      front + index,
      back + next,
      front + next,
    );
  }
}

function buildGullBody(accumulator: GeometryAccumulator): void {
  appendEllipsoid(accumulator, point(0, 0, 0), point(0.2, 0.16, 0.48));
  appendEllipsoid(accumulator, point(0, 0.045, 0.43), point(0.155, 0.145, 0.19), 5, 9);
  appendTube(accumulator, [point(0, 0.025, 0.55), point(0, 0.01, 0.9)], [0.085, 0.01], 6);
  appendPlanform(accumulator, [
    { x: -0.04, z: -0.34 }, { x: -0.24, z: -0.76 }, { x: -0.03, z: -0.62 }, { x: 0, z: -0.4 },
  ], -0.005, 0.035);
  appendPlanform(accumulator, [
    { x: 0.04, z: -0.34 }, { x: 0, z: -0.4 }, { x: 0.03, z: -0.62 }, { x: 0.24, z: -0.76 },
  ], -0.005, 0.035);
}

function buildHawkBody(accumulator: GeometryAccumulator): void {
  appendEllipsoid(accumulator, point(0, -0.015, 0), point(0.255, 0.225, 0.43));
  appendEllipsoid(accumulator, point(0, 0.055, 0.39), point(0.185, 0.19, 0.2), 5, 9);
  appendTube(
    accumulator,
    [point(0, 0.02, 0.52), point(0, 0.0, 0.68), point(0, -0.09, 0.73)],
    [0.105, 0.065, 0.012],
    6,
  );
  appendPlanform(accumulator, [
    { x: -0.22, z: -0.3 }, { x: -0.3, z: -0.72 }, { x: 0, z: -0.84 },
    { x: 0.3, z: -0.72 }, { x: 0.22, z: -0.3 },
  ], -0.02, 0.055);
}

function buildGullWing(accumulator: GeometryAccumulator): void {
  appendPlanform(accumulator, [
    { x: 0, z: 0.22 }, { x: 0.5, z: 0.2 }, { x: 1.2, z: 0.06 },
    { x: 1.28, z: -0.02 }, { x: 0.95, z: -0.09 }, { x: 0.45, z: -0.17 },
    { x: 0, z: -0.28 },
  ], 0, 0.025);
}

function buildHawkWing(accumulator: GeometryAccumulator): void {
  appendPlanform(accumulator, [
    { x: 0, z: 0.32 }, { x: 0.4, z: 0.32 }, { x: 0.78, z: 0.26 },
    { x: 1.02, z: 0.2 }, { x: 0.82, z: 0.11 }, { x: 1.08, z: 0.06 },
    { x: 0.8, z: -0.02 }, { x: 1.02, z: -0.1 }, { x: 0.72, z: -0.13 },
    { x: 0.88, z: -0.25 }, { x: 0.4, z: -0.32 }, { x: 0, z: -0.4 },
  ], 0, 0.035);
}

function buildDeerCoat(accumulator: GeometryAccumulator): void {
  appendEllipsoid(accumulator, point(0, 1.15, -0.05), point(0.48, 0.45, 0.82), 7, 11);
  appendTube(
    accumulator,
    [point(0, 1.35, 0.48), point(0, 1.68, 0.7), point(0, 1.92, 0.86)],
    [0.29, 0.235, 0.18],
    9,
  );
  appendEllipsoid(accumulator, point(0, 2.02, 1.05), point(0.235, 0.225, 0.38), 6, 9);
  appendEllipsoid(accumulator, point(0, 1.94, 1.37), point(0.18, 0.14, 0.25), 5, 8);
  appendProfileSlab(accumulator, [
    { x: -0.22, y: 2.11 }, { x: -0.48, y: 2.48 }, { x: -0.13, y: 2.3 },
  ], 1.03, 0.09);
  appendProfileSlab(accumulator, [
    { x: 0.22, y: 2.11 }, { x: 0.13, y: 2.3 }, { x: 0.48, y: 2.48 },
  ], 1.03, 0.09);
  appendTube(
    accumulator,
    [point(0, 1.33, -0.72), point(0, 1.48, -0.98), point(0, 1.54, -1.12)],
    [0.11, 0.07, 0.018],
    6,
  );
}

function buildDeerLeg(accumulator: GeometryAccumulator): void {
  appendTube(
    accumulator,
    [point(0, 0.5, 0), point(0.025, 0.08, 0), point(-0.02, -0.31, 0.025), point(0, -0.5, 0.095)],
    [0.095, 0.075, 0.052, 0.068],
    6,
  );
  appendEllipsoid(accumulator, point(0, -0.5, 0.12), point(0.075, 0.055, 0.13), 4, 6);
}

function buildDeerAntlers(accumulator: GeometryAccumulator): void {
  for (const side of [-1, 1]) {
    const main = [
      point(side * 0.12, 0, 0),
      point(side * 0.17, 0.26, 0),
      point(side * 0.28, 0.51, -0.02),
      point(side * 0.36, 0.74, -0.06),
    ];
    appendTube(accumulator, main, [0.047, 0.04, 0.028, 0.01], 6);
    appendTube(
      accumulator,
      [main[1]!, point(side * 0.41, 0.42, 0.08)],
      [0.033, 0.009],
      5,
    );
    appendTube(
      accumulator,
      [main[2]!, point(side * 0.51, 0.65, 0.05)],
      [0.026, 0.008],
      5,
    );
  }
}

function buildBoarHide(accumulator: GeometryAccumulator): void {
  appendEllipsoid(accumulator, point(0, 0.72, -0.08), point(0.58, 0.48, 0.84), 7, 11);
  appendEllipsoid(accumulator, point(0, 0.83, 0.35), point(0.57, 0.57, 0.5), 7, 10);
  appendEllipsoid(accumulator, point(0, 0.69, 0.82), point(0.45, 0.38, 0.52), 6, 9);
  appendEllipsoid(accumulator, point(0, 0.58, 1.27), point(0.3, 0.22, 0.31), 5, 8);
  appendProfileSlab(accumulator, [
    { x: -0.25, y: 0.97 }, { x: -0.34, y: 1.24 }, { x: -0.08, y: 1.08 },
  ], 0.77, 0.11);
  appendProfileSlab(accumulator, [
    { x: 0.25, y: 0.97 }, { x: 0.08, y: 1.08 }, { x: 0.34, y: 1.24 },
  ], 0.77, 0.11);
  for (let index = 0; index < 7; index += 1) {
    const z = -0.55 + index * 0.19;
    const baseY = 1.14 + Math.sin(index / 6 * Math.PI) * 0.18;
    appendTube(
      accumulator,
      [point(0, baseY, z), point(0, baseY + 0.23, z - 0.035)],
      [0.025, 0.004],
      5,
    );
  }
  appendTube(
    accumulator,
    [point(0, 0.92, -0.85), point(0.12, 1.0, -1.05), point(0.18, 1.12, -0.98)],
    [0.055, 0.037, 0.012],
    6,
  );
}

function buildBoarLeg(accumulator: GeometryAccumulator): void {
  appendTube(
    accumulator,
    [point(0, 0.5, 0), point(0.02, 0.03, 0.015), point(0, -0.5, 0.07)],
    [0.15, 0.12, 0.105],
    7,
  );
  appendEllipsoid(accumulator, point(0, -0.5, 0.1), point(0.13, 0.075, 0.17), 4, 7);
}

function buildBoarTusks(accumulator: GeometryAccumulator): void {
  for (const side of [-1, 1]) {
    appendTube(
      accumulator,
      [
        point(side * 0.15, 0, -0.04),
        point(side * 0.27, -0.03, 0.08),
        point(side * 0.31, 0.09, 0.2),
        point(side * 0.26, 0.21, 0.23),
      ],
      [0.065, 0.052, 0.032, 0.006],
      7,
    );
  }
}

function prototypeSpecies(key: WildlifePrototypeKey): WildlifeSpecies {
  if (key.startsWith("bird-gull")) return "gull";
  if (key.startsWith("bird-hawk")) return "hawk";
  if (key.startsWith("deer")) return "deer";
  return "boar";
}

export function createWildlifePrototypeGeometry(
  key: WildlifePrototypeKey,
): WildlifePrototypeGeometry {
  const accumulator: GeometryAccumulator = { positions: [], indices: [] };
  switch (key) {
    case "bird-gull-body": buildGullBody(accumulator); break;
    case "bird-gull-wing": buildGullWing(accumulator); break;
    case "bird-hawk-body": buildHawkBody(accumulator); break;
    case "bird-hawk-wing": buildHawkWing(accumulator); break;
    case "deer-coat": buildDeerCoat(accumulator); break;
    case "deer-leg": buildDeerLeg(accumulator); break;
    case "deer-antler": buildDeerAntlers(accumulator); break;
    case "boar-hide": buildBoarHide(accumulator); break;
    case "boar-leg": buildBoarLeg(accumulator); break;
    case "boar-tusk": buildBoarTusks(accumulator); break;
  }
  if (accumulator.positions.length / 3 > 65_535) {
    throw new RangeError(`Wildlife prototype ${key} exceeds Uint16 indexing`);
  }
  const species = prototypeSpecies(key);
  return Object.freeze({
    key,
    species,
    silhouetteFeatures: WILDLIFE_SILHOUETTE_CONTRACT[species].features,
    positions: Object.freeze(accumulator.positions),
    indices: Object.freeze(accumulator.indices),
    sourceByteLength: accumulator.positions.length * 4 + accumulator.indices.length * 2,
  });
}
