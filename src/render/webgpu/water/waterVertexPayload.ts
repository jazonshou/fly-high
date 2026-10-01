/**
 * The per-vertex water payload (`waterData.w`): the sentinel and the river
 * grade and lake fetch encodings, as numbers and pure functions.
 *
 * Moved out of WaterShaders.ts (P2b, 2026-09-29) because the hydrology worker
 * now builds region vertex arrays, and WaterShaders.ts pulls in Babylon and
 * the atmosphere system. WaterShaders imports these back for its WGSL and
 * re-exports them, so they stay the ONE set of numbers both languages read.
 *
 * Class P: no Babylon, no DOM.
 */

/** Graph-mode vertices carry `BASE + payload`; analytic vertices carry 0. */
export const WATER_CHANNEL_SENTINEL_BASE = 1;

/**
 * Channel grade (rise/run) at which the river payload saturates.
 *
 * 6% is a genuinely steep reach: lowland trunk channels run 1e-4 to 1e-3,
 * upland streams 1e-2, and the boulder-garden reaches that actually stand
 * waves up sit at 2e-2 to 6e-2. Above that the exported channel is a
 * waterfall and the standing-wave model (a free-surface gravity wave riding a
 * steady current) has stopped applying anyway.
 */
export const WATER_CHANNEL_GRADE_REFERENCE = 0.06;

/**
 * Fetch at which the lake payload saturates, metres.
 *
 * 20 km of fetch at 6 m/s of wind is a 0.43 m significant height — real chop,
 * and about where fetch-limited growth stops being the binding constraint
 * (beyond it a lake breeze is duration-limited long before it is
 * fetch-limited). Larger lakes clamp here rather than growing ocean swell on
 * an inland surface.
 */
export const WATER_LAKE_FETCH_REFERENCE_METERS = 20_000;

/**
 * Effective fetch from the nearest-shore distance a lake vertex already
 * carries.
 *
 * True fetch is directional — the upwind distance to land — and computing it
 * per vertex means a second O(ring) ray cast against the shoreline on a cold
 * path that D-5 already measured at its budget. The Shore Protection Manual's
 * effective-fetch construction averages the fetch over ±45° about the wind,
 * where the short rays dominate the average, so a multiple of the
 * omnidirectional nearest-shore distance is the standard cheap surrogate for
 * exactly that average. The floor keeps the shoreline itself from reading as
 * a glassy rim: a lee shore has the whole lake upwind of it.
 */
export const WATER_LAKE_EFFECTIVE_FETCH_FACTOR = 4;
export const WATER_LAKE_FETCH_FLOOR_METERS = 60;

/**
 * The river payload written into `waterData.w` by the graph-mode builder.
 * Analytic builders keep pushing a literal 0 and MUST NOT call this.
 */
export function waterChannelGradePayload(grade: number): number {
  const normalized = Number.isFinite(grade)
    ? Math.min(Math.max(grade / WATER_CHANNEL_GRADE_REFERENCE, 0), 1)
    : 0;
  return WATER_CHANNEL_SENTINEL_BASE + normalized;
}

/**
 * The effective fetch at a lake vertex, from the nearest-shore distance the
 * builder has already memoised and the lake's own span.
 */
export function waterLakeEffectiveFetchMeters(
  shoreDistanceMeters: number,
  lakeSpanMeters: number,
): number {
  const shore = Number.isFinite(shoreDistanceMeters) ? Math.max(shoreDistanceMeters, 0) : 0;
  const span = Number.isFinite(lakeSpanMeters) ? Math.max(lakeSpanMeters, 0) : 0;
  return Math.min(
    Math.max(span, WATER_LAKE_FETCH_FLOOR_METERS),
    WATER_LAKE_EFFECTIVE_FETCH_FACTOR * shore + WATER_LAKE_FETCH_FLOOR_METERS,
  );
}

/**
 * The lake payload written into `waterData.w`. Stored as `sqrt(F/Fref)` so
 * the interpolated quantity is the significant height (linear in it by the
 * growth law), not the fetch.
 */
export function waterLakeFetchPayload(fetchMeters: number): number {
  const normalized = Number.isFinite(fetchMeters)
    ? Math.min(Math.max(fetchMeters / WATER_LAKE_FETCH_REFERENCE_METERS, 0), 1)
    : 0;
  return WATER_CHANNEL_SENTINEL_BASE + Math.sqrt(normalized);
}
