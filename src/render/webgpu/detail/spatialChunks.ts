/**
 * Fixed-size world-detail presentation chunks. Generation remains owned by the
 * smaller deterministic detail cells; chunks only bound GPU submission and do
 * not change placement IDs or paging ownership.
 */
export const DETAIL_PRESENTATION_CHUNK_CELL_SPAN = 8;

export interface DetailPresentationChunkCoordinates {
  readonly x: number;
  readonly z: number;
  readonly key: string;
  readonly minCellX: number;
  readonly minCellZ: number;
  readonly maxCellX: number;
  readonly maxCellZ: number;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return value;
}

/** Maps signed cell coordinates to one stable spatial presentation chunk. */
export function detailPresentationChunkCoordinates(
  cellX: number,
  cellZ: number,
  cellSpan = DETAIL_PRESENTATION_CHUNK_CELL_SPAN,
): DetailPresentationChunkCoordinates {
  requireSafeInteger(cellX, "Detail cell x");
  requireSafeInteger(cellZ, "Detail cell z");
  requireSafeInteger(cellSpan, "Detail presentation chunk span");
  if (cellSpan <= 0) throw new RangeError("Detail presentation chunk span must be positive");

  const x = Math.floor(cellX / cellSpan);
  const z = Math.floor(cellZ / cellSpan);
  const minCellX = x * cellSpan;
  const minCellZ = z * cellSpan;
  return {
    x,
    z,
    key: `${x}:${z}`,
    minCellX,
    minCellZ,
    maxCellX: minCellX + cellSpan,
    maxCellZ: minCellZ + cellSpan,
  };
}
