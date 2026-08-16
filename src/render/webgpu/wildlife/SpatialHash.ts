import type { WildlifeVector3 } from "./types";

export interface SpatialHashQuery {
  readonly indices: readonly number[];
  readonly visitedCells: number;
  readonly candidateChecks: number;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function cellKey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

/**
 * Uniform 3D spatial hash for bounded flock lookups. Query cost depends on the
 * occupied local buckets and the explicit result cap, never on total flock size.
 */
export class SpatialHash3D {
  private readonly buckets = new Map<string, number[]>();
  private readonly positions: WildlifeVector3[] = [];

  constructor(readonly cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError("Spatial-hash cell size must be finite and greater than zero");
    }
  }

  get size(): number {
    return this.positions.length;
  }

  get occupiedCellCount(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
    this.positions.length = 0;
  }

  rebuild(points: readonly WildlifeVector3[]): void {
    this.clear();
    for (let index = 0; index < points.length; index += 1) {
      this.insert(index, points[index]!);
    }
  }

  insert(index: number, point: WildlifeVector3): void {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError("Spatial-hash index must be a non-negative safe integer");
    }
    requireFinite(point.x, "Spatial-hash point x");
    requireFinite(point.y, "Spatial-hash point y");
    requireFinite(point.z, "Spatial-hash point z");
    const x = Math.floor(point.x / this.cellSize);
    const y = Math.floor(point.y / this.cellSize);
    const z = Math.floor(point.z / this.cellSize);
    const key = cellKey(x, y, z);
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(index);
    else this.buckets.set(key, [index]);
    this.positions[index] = point;
  }

  query(
    point: WildlifeVector3,
    radius: number,
    maxResults = 24,
    excludeIndex = -1,
    maxCandidateChecks = Math.max(32, maxResults * 4),
  ): SpatialHashQuery {
    requireFinite(point.x, "Spatial-hash query x");
    requireFinite(point.y, "Spatial-hash query y");
    requireFinite(point.z, "Spatial-hash query z");
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError("Spatial-hash query radius must be finite and non-negative");
    }
    if (!Number.isSafeInteger(maxResults) || maxResults < 0) {
      throw new RangeError("Spatial-hash result cap must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxCandidateChecks) || maxCandidateChecks < maxResults) {
      throw new RangeError("Spatial-hash candidate cap must be an integer at least as large as the result cap");
    }
    if (maxResults === 0) return { indices: [], visitedCells: 0, candidateChecks: 0 };

    const minimumX = Math.floor((point.x - radius) / this.cellSize);
    const maximumX = Math.floor((point.x + radius) / this.cellSize);
    const minimumY = Math.floor((point.y - radius) / this.cellSize);
    const maximumY = Math.floor((point.y + radius) / this.cellSize);
    const minimumZ = Math.floor((point.z - radius) / this.cellSize);
    const maximumZ = Math.floor((point.z + radius) / this.cellSize);
    const radiusSquared = radius * radius;
    const indices: number[] = [];
    let visitedCells = 0;
    let candidateChecks = 0;

    outer: for (let z = minimumZ; z <= maximumZ; z += 1) {
      for (let y = minimumY; y <= maximumY; y += 1) {
        for (let x = minimumX; x <= maximumX; x += 1) {
          visitedCells += 1;
          const bucket = this.buckets.get(cellKey(x, y, z));
          if (!bucket) continue;
          for (const index of bucket) {
            if (index === excludeIndex) continue;
            const candidate = this.positions[index];
            if (!candidate) continue;
            candidateChecks += 1;
            const dx = candidate.x - point.x;
            const dy = candidate.y - point.y;
            const dz = candidate.z - point.z;
            if (dx * dx + dy * dy + dz * dz <= radiusSquared) indices.push(index);
            if (
              indices.length >= maxResults ||
              candidateChecks >= maxCandidateChecks
            ) break outer;
          }
        }
      }
    }
    return { indices, visitedCells, candidateChecks };
  }
}
