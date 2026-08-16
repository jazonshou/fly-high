import * as THREE from "three";
import type { QualityLevel } from "@/src/game/types";

export type TreeSpecies = "oak" | "aspen" | "pine" | "spruce";

export interface TreeSpeciesInput {
  readonly height: number;
  readonly slope: number;
  readonly moisture: number;
  readonly temperature: number;
  readonly selector: number;
}

export interface TreeRenderBudget {
  readonly nearInstances: number;
  readonly farInstances: number;
  readonly rockInstances: number;
  readonly nearRadius: number;
}

export interface TreeSpeciesProfile {
  readonly crownCenterHeight: number;
  readonly widthScale: number;
  readonly heightScale: number;
}

export interface ForestPassTriangleInput {
  readonly nearInstances: number;
  readonly farInstances: number;
  readonly nearTrianglesPerInstance: number;
  readonly farTrianglesPerInstance: number;
  /** Near forest casts into every configured CSM cascade. Far LOD never does. */
  readonly shadowCascades: number;
  /** Zero disables the planar submission; otherwise this is its update interval. */
  readonly planarCadenceMs: number;
  readonly targetFramesPerSecond?: number;
}

export interface ForestPassTriangleEstimate {
  readonly beautyTriangles: number;
  readonly planarUpdateTriangles: number;
  readonly shadowTriangles: number;
  readonly peakTriangles: number;
  readonly averageTrianglesPerFrame: number;
  readonly planarFrameFraction: number;
}

export interface ForestLodPriorityCandidate {
  readonly deltaX: number;
  readonly deltaZ: number;
  readonly distanceSquared: number;
  readonly tieBreaker: number;
  readonly stableX: number;
  readonly stableZ: number;
}

/**
 * Forest instance sets are rebuilt much less often than the camera moves. A
 * small world-space snap keeps matrices stable between rebuilds without tying
 * the LOD centre to the much larger 1.6 km terrain-tile grid.
 */
export const FOREST_LOD_CENTER_STEP = 320;

/**
 * The streamed far-height grid is three 12.8 km tiles wide. Even with the
 * aircraft and snapped forest centre at opposite ends of their cells, 12 km is
 * covered on every side; the former 18 km radius was not.
 */
export const FAR_FOREST_RADIUS = 12_000;

/** Twelve sectors are fine enough to prevent a missing quadrant without noise. */
export const FOREST_LOD_ANGULAR_SECTORS = 12;

/** Two 380 m far-tree cells per band preserve distance priority at the cap. */
export const FAR_FOREST_RADIAL_BAND_SIZE = 760;

export function snapForestLodCenter(coordinate: number): number {
  const finiteCoordinate = Number.isFinite(coordinate) ? coordinate : 0;
  return Math.round(finiteCoordinate / FOREST_LOD_CENTER_STEP) * FOREST_LOD_CENTER_STEP;
}

export function forestLodAngularSector(
  deltaX: number,
  deltaZ: number,
  sectorCount = FOREST_LOD_ANGULAR_SECTORS,
): number {
  const count = Math.max(1, Math.floor(Number.isFinite(sectorCount) ? sectorCount : 1));
  const x = Number.isFinite(deltaX) ? deltaX : 0;
  const z = Number.isFinite(deltaZ) ? deltaZ : 0;
  const normalizedAngle = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
  return Math.min(count - 1, Math.floor(normalizedAngle * count));
}

/**
 * Orders a bounded LOD population without inheriting terrain-chunk scan order.
 * Nearer radial bands win first, while round-robin sectors prevent a cap from
 * filling one side of the aircraft and leaving the opposite horizon empty.
 */
export function orderForestLodCandidates<
  Candidate extends ForestLodPriorityCandidate,
>(
  candidates: readonly Candidate[],
  radialBandSize = FAR_FOREST_RADIAL_BAND_SIZE,
  sectorCount = FOREST_LOD_ANGULAR_SECTORS,
): Candidate[] {
  const bandSize = Math.max(
    1,
    Number.isFinite(radialBandSize) ? radialBandSize : FAR_FOREST_RADIAL_BAND_SIZE,
  );
  const count = Math.max(
    1,
    Math.floor(Number.isFinite(sectorCount) ? sectorCount : FOREST_LOD_ANGULAR_SECTORS),
  );
  const bands = new Map<number, Candidate[][]>();
  for (const candidate of candidates) {
    const safeDistanceSquared = Number.isFinite(candidate.distanceSquared)
      ? Math.max(0, candidate.distanceSquared)
      : Number.MAX_SAFE_INTEGER;
    const band = Math.floor(Math.sqrt(safeDistanceSquared) / bandSize);
    let sectors = bands.get(band);
    if (!sectors) {
      sectors = Array.from({ length: count }, () => []);
      bands.set(band, sectors);
    }
    sectors[forestLodAngularSector(candidate.deltaX, candidate.deltaZ, count)]!.push(candidate);
  }

  const compare = (first: Candidate, second: Candidate) =>
    first.distanceSquared - second.distanceSquared ||
    first.tieBreaker - second.tieBreaker ||
    first.stableZ - second.stableZ ||
    first.stableX - second.stableX;
  const ordered: Candidate[] = [];
  const sortedBands = [...bands.entries()].sort((first, second) => first[0] - second[0]);
  for (const [band, sectors] of sortedBands) {
    for (const sector of sectors) sector.sort(compare);
    const startSector = band % count;
    for (let depth = 0; ; depth += 1) {
      let appended = false;
      for (let offset = 0; offset < count; offset += 1) {
        const sector = sectors[(startSector + offset) % count]!;
        const candidate = sector[depth];
        if (!candidate) continue;
        ordered.push(candidate);
        appended = true;
      }
      if (!appended) break;
    }
  }
  return ordered;
}

/**
 * Randomizing the outer near-LOD radius per world cell turns one conspicuous
 * circular swap into a stable transition band. Every near tree is retained in
 * the inner 82% and the selector only affects the overlapping outer band.
 */
export function includesNearTreeLod(
  distanceSquared: number,
  nearRadius: number,
  selector: number,
): boolean {
  const radius = Math.max(0, Number.isFinite(nearRadius) ? nearRadius : 0);
  const threshold = THREE.MathUtils.lerp(radius * 0.82, radius, clamp01(selector));
  return Number.isFinite(distanceSquared) && distanceSquared <= threshold * threshold;
}

/**
 * Far silhouettes begin inside the guaranteed near band. This deliberate
 * overlap hides changes in either independently generated instance field while
 * retaining a fixed draw-call and instance budget.
 */
export function includesFarTreeLod(
  distanceSquared: number,
  nearRadius: number,
  selector: number,
): boolean {
  const radius = Math.max(0, Number.isFinite(nearRadius) ? nearRadius : 0);
  const threshold = THREE.MathUtils.lerp(radius * 0.64, radius * 0.78, clamp01(selector));
  return Number.isFinite(distanceSquared) && distanceSquared >= threshold * threshold;
}

const TREE_RENDER_BUDGETS: Readonly<Record<QualityLevel, TreeRenderBudget>> = {
  low: Object.freeze({
    nearInstances: 820,
    farInstances: 1_350,
    rockInstances: 180,
    nearRadius: 3_000,
  }),
  medium: Object.freeze({
    nearInstances: 1_500,
    farInstances: 2_650,
    rockInstances: 620,
    nearRadius: 4_200,
  }),
  high: Object.freeze({
    nearInstances: 2_200,
    farInstances: 4_200,
    rockInstances: 900,
    nearRadius: 5_100,
  }),
};

export const TREE_SPECIES_PROFILES: Readonly<Record<TreeSpecies, TreeSpeciesProfile>> = {
  oak: Object.freeze({ crownCenterHeight: 15.2, widthScale: 1, heightScale: 1 }),
  aspen: Object.freeze({ crownCenterHeight: 15.8, widthScale: 0.68, heightScale: 1.18 }),
  pine: Object.freeze({ crownCenterHeight: 7.7, widthScale: 0.9, heightScale: 1.08 }),
  spruce: Object.freeze({ crownCenterHeight: 8.2, widthScale: 0.96, heightScale: 1.15 }),
};

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

/**
 * Deterministic weighted habitat selection. Continuous weights avoid visible
 * elevation rings while still making warm lowlands, cool wet slopes, and the
 * treeline read as ecologically different forests.
 */
export function selectTreeSpecies(input: TreeSpeciesInput): TreeSpecies {
  const height = Math.max(0, Number.isFinite(input.height) ? input.height : 0);
  const slope = clamp01(input.slope);
  const moisture = clamp01(input.moisture);
  const temperature = clamp01(input.temperature);
  const selector = clamp01(input.selector);
  const altitude = THREE.MathUtils.smoothstep(height, 260, 1_230);
  const lowland = 1 - THREE.MathUtils.smoothstep(height, 380, 980);
  const cold = 1 - temperature;
  const deciduousSlope = 1 - THREE.MathUtils.smoothstep(slope, 0.08, 0.25);

  const weights: Readonly<Record<TreeSpecies, number>> = {
    oak:
      0.04 +
      lowland * temperature * (0.32 + moisture * 0.88) * (0.3 + deciduousSlope * 0.7),
    aspen:
      0.06 +
      (0.34 + moisture * 0.74) *
        (1 - Math.min(1, Math.abs(temperature - 0.5) * 1.55)) *
        (0.45 + (1 - altitude) * 0.55) *
        (0.46 + deciduousSlope * 0.54),
    pine:
      0.22 +
      altitude * 0.58 +
      (1 - moisture) * 0.46 +
      slope * 0.34 +
      cold * 0.18,
    spruce:
      0.05 +
      moisture * (0.2 + cold * 0.72 + altitude * 0.7) +
      altitude * cold * 0.34,
  };
  const total = weights.oak + weights.aspen + weights.pine + weights.spruce;
  let cursor = selector * total;
  for (const species of ["oak", "aspen", "pine", "spruce"] as const) {
    cursor -= weights[species];
    if (cursor <= 0) return species;
  }
  return "spruce";
}

export function treeRenderBudget(quality: QualityLevel): TreeRenderBudget {
  return TREE_RENDER_BUDGETS[quality];
}

/**
 * Conservative full-frame forest work. Instancing bounds draw calls and memory,
 * but each reflection/shadow submission still processes the instance geometry.
 */
export function estimateForestPassTriangles(
  input: ForestPassTriangleInput,
): ForestPassTriangleEstimate {
  const boundedCount = (value: number) =>
    Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const nearInstances = boundedCount(input.nearInstances);
  const farInstances = boundedCount(input.farInstances);
  const nearTrianglesPerInstance = boundedCount(input.nearTrianglesPerInstance);
  const farTrianglesPerInstance = boundedCount(input.farTrianglesPerInstance);
  const shadowCascades = boundedCount(input.shadowCascades);
  const targetFramesPerSecond = Math.max(
    1,
    Number.isFinite(input.targetFramesPerSecond)
      ? input.targetFramesPerSecond ?? 60
      : 60,
  );
  const beautyTriangles =
    nearInstances * nearTrianglesPerInstance + farInstances * farTrianglesPerInstance;
  const planarEnabled = Number.isFinite(input.planarCadenceMs) && input.planarCadenceMs > 0;
  const planarUpdateTriangles = planarEnabled ? beautyTriangles : 0;
  const rawPlanarFrameFraction = planarEnabled
    ? 1_000 / input.planarCadenceMs / targetFramesPerSecond
    : 0;
  const planarFrameFraction = rawPlanarFrameFraction >= 1 - 1e-9
    ? 1
    : Math.max(0, rawPlanarFrameFraction);
  const shadowTriangles = nearInstances * nearTrianglesPerInstance * shadowCascades;
  return Object.freeze({
    beautyTriangles,
    planarUpdateTriangles,
    shadowTriangles,
    peakTriangles: beautyTriangles + planarUpdateTriangles + shadowTriangles,
    averageTrianglesPerFrame:
      beautyTriangles + shadowTriangles + planarUpdateTriangles * planarFrameFraction,
    planarFrameFraction,
  });
}

function mergeForestGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const unpacked = parts.map((part) => (part.index ? part.toNonIndexed() : part.clone()));
  const vertexCount = unpacked.reduce(
    (sum, geometry) => sum + geometry.getAttribute("position").count,
    0,
  );
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const geometry of unpacked) {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    positions.set(position.array as Float32Array, offset * 3);
    normals.set(normal.array as Float32Array, offset * 3);
    offset += position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  for (const geometry of unpacked) geometry.dispose();
  for (const geometry of parts) geometry.dispose();
  return merged;
}

function branchGeometry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  bottomRadius: number,
  topRadius: number,
): THREE.BufferGeometry {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(
    topRadius,
    bottomRadius,
    length,
    4,
    1,
    true,
  );
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    ),
  );
  geometry.translate(
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
  );
  return geometry;
}

/** One instanced trunk draw includes a taper and three visible primary limbs. */
export function createDetailedTreeTrunkGeometry(): THREE.BufferGeometry {
  const core = new THREE.CylinderGeometry(0.43, 0.84, 11, 7, 1, false);
  const branches = [
    branchGeometry(
      new THREE.Vector3(0, 1.6, 0),
      new THREE.Vector3(2.15, 4.4, 0.55),
      0.24,
      0.08,
    ),
    branchGeometry(
      new THREE.Vector3(0, 2.15, 0),
      new THREE.Vector3(-1.55, 4.85, 1.55),
      0.22,
      0.075,
    ),
    branchGeometry(
      new THREE.Vector3(0, 2.75, 0),
      new THREE.Vector3(-0.45, 5.15, -1.8),
      0.2,
      0.07,
    ),
  ];
  return mergeForestGeometry([core, ...branches]);
}

export function createOakCanopyGeometry(): THREE.BufferGeometry {
  const lobes: Array<readonly [number, number, number, number, number, number]> = [
    [0, 0.3, 0, 5.3, 5.7, 5.1],
    [-3.2, -0.1, 0.7, 3.7, 4.1, 3.5],
    [3.1, 0.25, -0.6, 3.9, 4.3, 3.6],
    [-0.7, 1.9, -2.7, 3.8, 3.9, 3.5],
    [1.1, 1.25, 2.8, 3.6, 4.2, 3.7],
  ];
  return mergeForestGeometry(lobes.map(([x, y, z, sx, sy, sz], index) => {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    geometry.scale(sx, sy, sz);
    geometry.rotateY(index * 1.17);
    geometry.translate(x, y, z);
    return geometry;
  }));
}

/** Tall separated leaf clusters give aspen a recognizably narrow silhouette. */
export function createAspenCanopyGeometry(): THREE.BufferGeometry {
  const clusters: Array<readonly [number, number, number, number, number, number]> = [
    [0, -2.8, 0, 3.3, 4.5, 3.1],
    [-0.65, 0.4, 0.35, 3.15, 4.8, 2.9],
    [0.55, 3.8, -0.3, 2.7, 4.2, 2.65],
    [-0.2, 6.6, 0.1, 2.05, 3.2, 2.1],
  ];
  return mergeForestGeometry(clusters.map(([x, y, z, sx, sy, sz], index) => {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    geometry.scale(sx, sy, sz);
    geometry.rotateY(index * 0.91);
    geometry.translate(x, y, z);
    return geometry;
  }));
}

/** Open-spaced three-whorl pine, distinct from the denser drooping spruce. */
export function createPineCanopyGeometry(): THREE.BufferGeometry {
  const lower = new THREE.ConeGeometry(5.9, 10.5, 8, 1, false);
  lower.translate(0, -2.3, 0);
  const middle = new THREE.ConeGeometry(4.7, 10, 8, 1, false);
  middle.translate(0, 2.4, 0);
  const crown = new THREE.ConeGeometry(3.4, 9.2, 8, 1, false);
  crown.translate(0, 6.4, 0);
  return mergeForestGeometry([lower, middle, crown]);
}

/** Five overlapping skirts create a dense, blue-green spruce silhouette. */
export function createSpruceCanopyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let layer = 0; layer < 5; layer += 1) {
    const amount = layer / 4;
    const geometry = new THREE.ConeGeometry(
      THREE.MathUtils.lerp(6.4, 2.15, amount),
      THREE.MathUtils.lerp(8.1, 5.4, amount),
      7,
      1,
      false,
    );
    geometry.rotateY(layer * 0.37);
    geometry.translate(0, -3.8 + layer * 3.25, 0);
    parts.push(geometry);
  }
  return mergeForestGeometry(parts);
}

export function createFarConiferGeometry(): THREE.BufferGeometry {
  const lower = new THREE.ConeGeometry(1, 0.62, 6, 1, false);
  lower.translate(0, 0.32, 0);
  const middle = new THREE.ConeGeometry(0.76, 0.58, 6, 1, false);
  middle.translate(0, 0.6, 0);
  const crown = new THREE.ConeGeometry(0.5, 0.54, 6, 1, false);
  crown.translate(0, 0.86, 0);
  return mergeForestGeometry([lower, middle, crown]);
}

export function createFarBroadleafGeometry(): THREE.BufferGeometry {
  const crown = new THREE.DodecahedronGeometry(1, 0);
  crown.scale(1, 0.5, 0.86);
  crown.translate(0, 0.51, 0);
  return mergeForestGeometry([crown]);
}

export function forestGeometryTriangles(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute("position").count / 3;
}
